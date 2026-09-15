/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Incoming Analyzer
 * Script created by Twactics (zidrox)
 *
 * Scans incoming attacks shown on a player's villages and summarizes both
 * the target player's totals and the number of attacks sent by each attacker.
 *
 * This script:
 * - Runs from a Tribal Wars Player Info page
 * - Reads the player's village list
 * - Fetches only villages that are visibly marked as having incoming attacks
 * - Reads incoming command rows from those village pages
 * - Resolves Origin players from command rows when available, otherwise from same-origin command details
 * - Uses bounded parallel requests, retry/backoff, and a per-tab command-origin cache for speed
 * - Reads the Origin -> Player instead of the editable command name
 * - Counts total / noble / large / medium / small attacks
 * - Aggregates attacks by attacking player
 * - Shows each attacker's share and number of targeted villages
 * - Uses only same-origin Tribal Wars pages
 *
 * This script does NOT:
 * - Send attacks, support, troops, or resources
 * - Auto-click game actions
 * - Modify commands
 * - Use external servers or external files
 */

/*
 * Disclaimer:
 * By uploading a user-generated mod for use with Tribal Wars, the creator grants
 * InnoGames a perpetual, irrevocable, worldwide, royalty-free, non-exclusive
 * license to use, reproduce, distribute, publicly display, modify, and create
 * derivative works of the mod. This license permits InnoGames to incorporate the
 * mod into any aspect of the game and its related services, including promotional
 * and commercial endeavors, without any requirement for compensation or
 * attribution to the uploader. The uploader represents and warrants that they
 * have the legal right to grant this license and that the mod does not infringe
 * upon any third-party rights. German law applies.
 */

(function () {
    "use strict";

    const SCRIPT_NAME = "Twactics Incoming Analyzer";
    const SCRIPT_VERSION = "v1.2.0";
    const BOX_ID = "twactics-incoming-analyzer";

    // Keep a small, bounded number of same-origin requests in flight.
    // This is much faster than sleeping after every request while still
    // avoiding an unbounded Promise.all() burst.
    const VILLAGE_CONCURRENCY = 4;
    const COMMAND_CONCURRENCY = 6;
    const FETCH_TIMEOUT_MS = 12000;
    const MAX_FETCH_RETRIES = 2;
    const UI_REFRESH_MS = 100;

    // Command IDs are stable for the lifetime of a command. Cache resolved
    // Origin players for the current browser tab so re-running the analyzer
    // does not fetch the same command details again.
    const CACHE_PREFIX = "twacticsIncomingAnalyzerOriginCache";
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    const MAX_CACHE_ENTRIES = 2000;

    const state = {
        stopped: false,
        scanned: 0,
        failed: 0,
        failedCommands: 0,
        unresolvedCommands: 0,
        commandCount: 0,
        commandsResolved: 0,
        directOriginHits: 0,
        cacheHits: 0,
        networkCommandRequests: 0,
        totalPlayerVillages: 0,
        villagesWithIncomings: 0,
        totals: emptyCounts(),
        attackers: new Map(),
        cacheDirty: false
    };

    if (window.twacticsIncomingAnalyzer && typeof window.twacticsIncomingAnalyzer.close === "function") {
        window.twacticsIncomingAnalyzer.close();
    }

    window.twacticsIncomingAnalyzer = {
        close: closeWidget,
        state: state
    };

    function emptyCounts() {
        return {
            attacks: 0,
            noble: 0,
            large: 0,
            medium: 0,
            small: 0,
            generic: 0
        };
    }

    function cleanText(value) {
        return String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatNumber(value) {
        return new Intl.NumberFormat().format(Number(value || 0));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getWorldCacheKey() {
        const world = (typeof game_data !== "undefined" && game_data.world) ? game_data.world : window.location.host;
        return CACHE_PREFIX + ":" + world;
    }

    function loadCommandCache() {
        try {
            const raw = sessionStorage.getItem(getWorldCacheKey());
            if (!raw) return new Map();

            const parsed = JSON.parse(raw);
            const now = Date.now();
            const map = new Map();

            Object.keys(parsed || {}).forEach(commandId => {
                const item = parsed[commandId];
                if (!item || !item.player || !item.player.name || !item.savedAt) return;
                if (now - item.savedAt > CACHE_TTL_MS) return;
                map.set(String(commandId), item);
            });

            return map;
        } catch (err) {
            return new Map();
        }
    }

    const commandCache = loadCommandCache();

    function getCachedAttacker(commandId) {
        if (!commandId) return null;
        const item = commandCache.get(String(commandId));
        if (!item) return null;

        if (Date.now() - item.savedAt > CACHE_TTL_MS) {
            commandCache.delete(String(commandId));
            state.cacheDirty = true;
            return null;
        }

        return item.player;
    }

    function cacheAttacker(commandId, attacker) {
        if (!commandId || !attacker || !attacker.name) return;
        commandCache.set(String(commandId), {
            player: { id: String(attacker.id || ""), name: attacker.name },
            savedAt: Date.now()
        });
        state.cacheDirty = true;
    }

    function saveCommandCache() {
        if (!state.cacheDirty) return;

        try {
            const entries = Array.from(commandCache.entries())
                .filter(entry => Date.now() - entry[1].savedAt <= CACHE_TTL_MS)
                .sort((a, b) => b[1].savedAt - a[1].savedAt)
                .slice(0, MAX_CACHE_ENTRIES);

            const compact = {};
            entries.forEach(entry => { compact[entry[0]] = entry[1]; });
            sessionStorage.setItem(getWorldCacheKey(), JSON.stringify(compact));
            state.cacheDirty = false;
        } catch (err) {
            // Cache failure must never break the scan.
        }
    }

    async function runPool(items, concurrency, worker, onProgress) {
        if (!items.length) return;

        let nextIndex = 0;
        let completed = 0;
        const workerCount = Math.min(Math.max(1, concurrency), items.length);

        async function runner() {
            while (!state.stopped) {
                const index = nextIndex++;
                if (index >= items.length) return;

                try {
                    await worker(items[index], index);
                } finally {
                    completed += 1;
                    if (typeof onProgress === "function") {
                        onProgress(completed, items[index], index);
                    }
                }
            }
        }

        await Promise.all(Array.from({ length: workerCount }, runner));
    }

    let uiRefreshTimer = null;
    function scheduleResultsUpdate(playerName) {
        if (uiRefreshTimer || state.stopped) return;
        uiRefreshTimer = setTimeout(() => {
            uiRefreshTimer = null;
            if (!state.stopped) updateResults(playerName, false);
        }, UI_REFRESH_MS);
    }

    function getParam(name, url) {
        try {
            return new URL(url || window.location.href, window.location.origin).searchParams.get(name);
        } catch (err) {
            return null;
        }
    }

    function isPlayerInfoPage() {
        if (typeof game_data !== "undefined" && game_data.screen) {
            return game_data.screen === "info_player";
        }
        return getParam("screen") === "info_player";
    }

    function notify(type, message) {
        try {
            if (typeof UI !== "undefined") {
                if (type === "error" && typeof UI.ErrorMessage === "function") {
                    UI.ErrorMessage(message);
                    return;
                }
                if (type === "info" && typeof UI.InfoMessage === "function") {
                    UI.InfoMessage(message);
                    return;
                }
                if (typeof UI.SuccessMessage === "function") {
                    UI.SuccessMessage(message);
                    return;
                }
            }
        } catch (err) {
            // Fall through to console.
        }
        console.log("[" + SCRIPT_NAME + "] " + message);
    }

    function closeWidget() {
        state.stopped = true;
        saveCommandCache();
        if (uiRefreshTimer) {
            clearTimeout(uiRefreshTimer);
            uiRefreshTimer = null;
        }
        const box = document.getElementById(BOX_ID);
        if (box) box.remove();
        if (window.twacticsIncomingAnalyzer) {
            window.twacticsIncomingAnalyzer = null;
        }
    }

    function getPlayerName() {
        const heading = document.querySelector("#content_value h2, #contentContainer h2");
        return cleanText(heading ? heading.textContent : "Unknown player");
    }

    async function expandVillageListIfNeeded() {
        const table = document.querySelector("#villages_list");
        if (!table) return;

        const rows = table.querySelectorAll("tr");
        if (!rows.length) return;

        const lastRow = rows[rows.length - 1];
        const expandLink = lastRow.querySelector('a[href="#"]');

        if (expandLink) {
            const before = getVillageRows().length;
            expandLink.click();

            for (let i = 0; i < 16; i++) {
                await sleep(125);
                if (getVillageRows().length > before || !document.body.contains(expandLink)) {
                    break;
                }
            }
        }
    }

    function getVillageRows() {
        return Array.from(document.querySelectorAll("#villages_list tr")).filter(row => {
            return !!row.querySelector('a[href*="screen=info_village"]');
        });
    }

    function rowHasIncomingAttack(row) {
        if (row.querySelector("span.command-attack-ally, span.command-attack")) {
            return true;
        }

        return Array.from(row.querySelectorAll("img")).some(img => {
            const src = String(img.getAttribute("src") || "");
            return /\/command\/attack(?:_|\.|\/)/i.test(src);
        });
    }

    function getVillageMeta(row) {
        const link = row.querySelector('a[href*="screen=info_village"]');
        if (!link) return null;

        const href = link.href || link.getAttribute("href") || "";
        const coordMatch = cleanText(row.textContent).match(/\b\d{1,3}\|\d{1,3}\b/);

        return {
            id: getParam("id", href) || "",
            name: cleanText(link.textContent),
            coord: coordMatch ? coordMatch[0] : "",
            url: href
        };
    }

    function collectVillages() {
        const rows = getVillageRows();
        const all = [];
        const withIncomings = [];
        const seen = new Set();

        rows.forEach(row => {
            const meta = getVillageMeta(row);
            if (!meta || !meta.url) return;

            const key = meta.id || meta.url;
            if (seen.has(key)) return;
            seen.add(key);

            all.push(meta);
            if (rowHasIncomingAttack(row)) {
                withIncomings.push(meta);
            }
        });

        return { all, withIncomings };
    }

    async function fetchHtml(url, attempt) {
        attempt = attempt || 0;
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timeout = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

        try {
            const response = await fetch(url, {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
                headers: {
                    "Accept": "text/html, */*; q=0.01"
                },
                signal: controller ? controller.signal : undefined
            });

            if (!response.ok) {
                const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
                if (retryable && attempt < MAX_FETCH_RETRIES) {
                    const retryAfter = parseFloat(response.headers.get("Retry-After"));
                    const waitMs = Number.isFinite(retryAfter)
                        ? Math.max(300, retryAfter * 1000)
                        : 350 * Math.pow(2, attempt);
                    await sleep(waitMs);
                    return fetchHtml(url, attempt + 1);
                }
                throw new Error("HTTP " + response.status);
            }

            return await response.text();
        } catch (err) {
            if (attempt < MAX_FETCH_RETRIES && err && err.name === "AbortError") {
                await sleep(350 * Math.pow(2, attempt));
                return fetchHtml(url, attempt + 1);
            }
            throw err;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    function parseHtml(html) {
        return new DOMParser().parseFromString(html, "text/html");
    }

    function basenameFromImage(img) {
        if (!img) return "";
        const src = String(img.getAttribute("src") || "")
            .split("#")[0]
            .split("?")[0];
        return src.split("/").pop() || "";
    }

    function getAttackKind(row) {
        const names = Array.from(row.querySelectorAll("img")).map(basenameFromImage);
        const attackName = names.find(name => /^attack(?:_(?:small|medium|large))?\.(?:webp|png|gif)$/i.test(name));

        if (!attackName) return null;
        if (/attack_small\./i.test(attackName)) return "small";
        if (/attack_medium\./i.test(attackName)) return "medium";
        if (/attack_large\./i.test(attackName)) return "large";
        return "generic";
    }

    function rowHasNoble(row) {
        return Array.from(row.querySelectorAll("img")).some(img => {
            return /^snob\.(?:webp|png|gif)$/i.test(basenameFromImage(img));
        });
    }

    function getPlayerFromLink(link) {
        if (!link) return null;

        const href = link.href || link.getAttribute("href") || "";
        const id = getParam("id", href) || "";
        const name = cleanText(link.textContent);

        if (!name) return null;
        return { name: name, id: id };
    }

    function getOriginPlayerFromCommandRow(row) {
        // Some Tribal Wars markup variants expose a player link directly in the
        // command row. If so, use it immediately and skip screen=info_command.
        const targetPlayerId = getParam("id") || "";
        const candidates = [];
        const seen = new Set();

        Array.from(row.querySelectorAll('a[href*="screen=info_player"]')).forEach(link => {
            const player = getPlayerFromLink(link);
            if (!player || !player.name) return;
            if (targetPlayerId && player.id === targetPlayerId) return;

            const key = player.id ? "id:" + player.id : "name:" + player.name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push(player);
        });

        return candidates.length === 1 ? candidates[0] : null;
    }

    function getCommandDetails(row) {
        const links = Array.from(row.querySelectorAll('a[href*="screen=info_command"]'));
        const link = links.find(item => getParam("id", item.href || item.getAttribute("href"))) || links[0] || null;

        if (link) {
            const href = link.href || link.getAttribute("href") || "";
            const id = getParam("id", href) || "";
            if (id) {
                return { id: id, url: href };
            }
        }

        // Fallback: command rows normally expose the command id on their quickedit node.
        // Build the same screen=info_command&id=... URL ourselves if no direct link exists.
        const quickEdit = row.querySelector(".quickedit[data-id]");
        let id = quickEdit ? cleanText(quickEdit.getAttribute("data-id")) : "";

        if (!id) {
            const rowId = cleanText(row.getAttribute("data-id") || row.id || "");
            const match = rowId.match(/(\d{5,})/);
            id = match ? match[1] : "";
        }

        if (!id) return null;

        const url = new URL("/game.php", window.location.origin);
        const currentVillageId =
            (typeof game_data !== "undefined" && game_data.village && game_data.village.id)
                ? String(game_data.village.id)
                : (getParam("village") || "");

        if (currentVillageId) url.searchParams.set("village", currentVillageId);

        if (
            typeof game_data !== "undefined" &&
            game_data.player &&
            parseInt(game_data.player.sitter || 0, 10) > 0
        ) {
            url.searchParams.set("t", String(game_data.player.id));
        }

        url.searchParams.set("screen", "info_command");
        url.searchParams.set("id", id);

        return { id: id, url: url.pathname + url.search };
    }

    function parseOriginPlayer(html) {
        const doc = parseHtml(html);

        // On screen=info_command the origin player is the first player row in the
        // command details table. Prefer the structural Origin row (rowspan=2), then
        // fall back to the first info_player link in the command details page.
        const rows = Array.from(doc.querySelectorAll("tr"));
        for (const row of rows) {
            const firstCell = row.querySelector(":scope > td[rowspan], :scope > th[rowspan]");
            const playerLink = row.querySelector('a[href*="screen=info_player"]');
            if (firstCell && playerLink) {
                const player = getPlayerFromLink(playerLink);
                if (player) return player;
            }
        }

        const firstPlayerLink = doc.querySelector('a[href*="screen=info_player"]');
        return getPlayerFromLink(firstPlayerLink);
    }

    function ensureAttacker(attacker) {
        const key = attacker.id ? "id:" + attacker.id : "name:" + attacker.name.toLowerCase();

        if (!state.attackers.has(key)) {
            state.attackers.set(key, {
                id: attacker.id,
                name: attacker.name,
                attacks: 0,
                noble: 0,
                large: 0,
                medium: 0,
                small: 0,
                generic: 0,
                targets: new Set()
            });
        }

        return state.attackers.get(key);
    }

    function countAttack(kind, noble) {
        state.totals.attacks += 1;
        state.totals[kind] += 1;
        if (noble) state.totals.noble += 1;
    }

    function addAttackToAttacker(attacker, attack) {
        if (!attacker) {
            state.unresolvedCommands += 1;
            return;
        }

        const entry = ensureAttacker(attacker);
        entry.attacks += 1;
        entry[attack.kind] += 1;
        if (attack.noble) entry.noble += 1;
        entry.targets.add(attack.village.coord || attack.village.id || attack.village.name || attack.village.url);
    }

    function parseVillageCommands(html, village, seenCommandIds) {
        const doc = parseHtml(html);
        let rows = Array.from(doc.querySelectorAll("#commands_outgoings tr.command-row"));

        // Fallback for markup variants where the command table ID differs.
        if (!rows.length) {
            rows = Array.from(doc.querySelectorAll("tr.command-row"));
        }

        const pending = [];

        rows.forEach(row => {
            const kind = getAttackKind(row);
            if (!kind) return;

            const noble = rowHasNoble(row);
            const command = getCommandDetails(row);

            // Guard against accidental duplicate command rows without losing attacks
            // that do not expose a command ID at all.
            if (command && seenCommandIds.has(command.id)) return;
            if (command) seenCommandIds.add(command.id);

            countAttack(kind, noble);

            const attack = {
                kind: kind,
                noble: noble,
                village: village,
                commandId: command ? command.id : "",
                commandUrl: command ? command.url : ""
            };

            // Fast path 1: use an Origin player already present in the command row.
            const directAttacker = getOriginPlayerFromCommandRow(row);
            if (directAttacker) {
                state.directOriginHits += 1;
                addAttackToAttacker(directAttacker, attack);
                if (attack.commandId) cacheAttacker(attack.commandId, directAttacker);
                return;
            }

            // Fast path 2: reuse a command resolved earlier in this tab/session.
            const cachedAttacker = getCachedAttacker(attack.commandId);
            if (cachedAttacker) {
                state.cacheHits += 1;
                addAttackToAttacker(cachedAttacker, attack);
                return;
            }

            if (attack.commandUrl) {
                pending.push(attack);
            } else {
                state.unresolvedCommands += 1;
            }
        });

        return pending;
    }

    async function resolveCommandAttacker(attack) {
        const cached = getCachedAttacker(attack.commandId);
        if (cached) {
            state.cacheHits += 1;
            return cached;
        }

        state.networkCommandRequests += 1;
        const html = await fetchHtml(attack.commandUrl);
        const attacker = parseOriginPlayer(html);
        if (attacker) cacheAttacker(attack.commandId, attacker);
        return attacker;
    }

    function getSortedAttackers() {
        return Array.from(state.attackers.values()).sort((a, b) => {
            if (b.attacks !== a.attacks) return b.attacks - a.attacks;
            return a.name.localeCompare(b.name);
        });
    }

    function makePlayerLink(attacker) {
        if (!attacker.id) {
            return '<span class="twia-player-name">' + escapeHtml(attacker.name) + "</span>";
        }

        const href = "/game.php?screen=info_player&id=" + encodeURIComponent(attacker.id);
        return '<a class="twia-player-name" href="' + href + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(attacker.name) + "</a>";
    }

    function buildAttackerRows() {
        const attackers = getSortedAttackers();

        if (!attackers.length) {
            return '<tr><td colspan="4" class="twia-empty">No attacking players could be identified.</td></tr>';
        }

        return attackers.map((attacker, index) => {
            const share = state.totals.attacks > 0 ? ((attacker.attacks / state.totals.attacks) * 100).toFixed(1) : "0.0";
            const tooltip = [
                "Small: " + attacker.small,
                "Medium: " + attacker.medium,
                "Large: " + attacker.large,
                "Generic: " + attacker.generic,
                "Noble: " + attacker.noble
            ].join(" | ");

            return [
                '<tr title="' + escapeHtml(tooltip) + '">',
                '<td class="twia-rank">' + (index + 1) + "</td>",
                '<td class="twia-player">' + makePlayerLink(attacker) + "</td>",
                '<td class="twia-number"><strong>' + formatNumber(attacker.attacks) + "</strong></td>",
                '<td class="twia-number">' + share + "%</td>",
                '<td class="twia-number">' + formatNumber(attacker.targets.size) + "</td>",
                "</tr>"
            ].join("");
        }).join("");
    }

    function summaryRow(label, value, emphasis) {
        return '<div class="twia-summary-row' + (emphasis ? " twia-summary-emphasis" : "") + '">' +
            '<span>' + escapeHtml(label) + "</span>" +
            '<strong>' + escapeHtml(value) + "</strong>" +
            "</div>";
    }

    function buildSummaryHtml(playerName) {
        const avgAllVillages = state.totalPlayerVillages > 0
            ? (state.totals.attacks / state.totalPlayerVillages).toFixed(2)
            : "0.00";

        return [
            '<div class="twia-target">Target player: <strong>' + escapeHtml(playerName) + "</strong></div>",
            '<div class="twia-summary-grid">',
            summaryRow("Total villages", formatNumber(state.totalPlayerVillages)),
            summaryRow("Villages with incomings", formatNumber(state.villagesWithIncomings)),
            summaryRow("Total attacks", formatNumber(state.totals.attacks), true),
            summaryRow("Total noble attacks", formatNumber(state.totals.noble)),
            summaryRow("Total large attacks", formatNumber(state.totals.large)),
            summaryRow("Total medium attacks", formatNumber(state.totals.medium)),
            summaryRow("Total small attacks", formatNumber(state.totals.small)),
            summaryRow("Average attacks per village", avgAllVillages),
            "</div>"
        ].join("");
    }

    function createWidget(playerName) {
        const old = document.getElementById(BOX_ID);
        if (old) old.remove();

        const box = document.createElement("div");
        box.id = BOX_ID;
        box.innerHTML = `
            <div class="twia-header" id="twia-drag-handle">
                <div>
                    <div class="twia-title">${escapeHtml(SCRIPT_NAME)}</div>
                    <div class="twia-version">${escapeHtml(SCRIPT_VERSION)}</div>
                </div>
                <button type="button" class="twia-close" title="Close">×</button>
            </div>
            <div class="twia-body">
                <div id="twia-summary">${buildSummaryHtml(playerName)}</div>

                <div class="twia-progress-wrap">
                    <div class="twia-progress-top">
                        <span id="twia-status">Preparing scan...</span>
                        <strong id="twia-progress-text">0/0</strong>
                    </div>
                    <div class="twia-progress-track"><div id="twia-progress-bar"></div></div>
                </div>

                <div class="twia-section-head">
                    <div>
                        <div class="twia-section-title">Attacker breakdown</div>
                        <div class="twia-section-subtitle">Sorted by number of incoming attacks</div>
                    </div>
                    <button type="button" class="twia-button" id="twia-copy" disabled>Copy list</button>
                </div>

                <div class="twia-table-wrap">
                    <table class="twia-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Player</th>
                                <th class="twia-number">Attacks</th>
                                <th class="twia-number">Share</th>
                                <th class="twia-number">Targets</th>
                            </tr>
                        </thead>
                        <tbody id="twia-attacker-rows">
                            <tr><td colspan="5" class="twia-empty">Scanning...</td></tr>
                        </tbody>
                    </table>
                </div>

                <div class="twia-note" id="twia-note">
                    Scans villages marked with incoming attacks on this player page. No game actions are performed.
                </div>

                <div class="twia-footer">
                    <span>MIT</span>
                    <span>Created by Twactics (zidrox)</span>
                </div>
            </div>
        `;

        const style = document.createElement("style");
        style.textContent = `
            #${BOX_ID} {
                position: fixed;
                top: 100px;
                right: 36px;
                width: 520px;
                max-width: calc(100vw - 24px);
                max-height: calc(100vh - 32px);
                z-index: 999999;
                overflow: hidden;
                background: #f4e4bc;
                border: 2px solid #7d510f;
                border-radius: 7px;
                box-shadow: 0 10px 30px rgba(0,0,0,.38);
                color: #2f1b00;
                font: 12px Verdana, Arial, sans-serif;
                box-sizing: border-box;
            }
            #${BOX_ID} * { box-sizing: border-box; }
            #${BOX_ID} .twia-header {
                min-height: 49px;
                padding: 9px 11px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                cursor: move;
                user-select: none;
                background-color: #c1a264;
                background-image: url(/graphic/screen/tableheader_bg3.png);
                background-repeat: repeat-x;
                border-bottom: 1px solid #7d510f;
            }
            #${BOX_ID} .twia-title { font-size: 16px; font-weight: 700; line-height: 1.1; }
            #${BOX_ID} .twia-version { margin-top: 3px; font-size: 10px; opacity: .72; }
            #${BOX_ID} .twia-close {
                width: 28px;
                height: 28px;
                border: 1px solid #7d510f;
                border-radius: 4px;
                background: #e6d3a5;
                color: #2f1b00;
                font-size: 20px;
                line-height: 22px;
                font-weight: 700;
                cursor: pointer;
            }
            #${BOX_ID} .twia-body { padding: 12px; overflow: auto; max-height: calc(100vh - 85px); }
            #${BOX_ID} .twia-target {
                margin-bottom: 9px;
                padding: 8px 9px;
                border: 1px solid #bd9c5a;
                background: #fff5da;
            }
            #${BOX_ID} .twia-summary-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 1px;
                margin-bottom: 12px;
                border: 1px solid #bd9c5a;
                background: #bd9c5a;
            }
            #${BOX_ID} .twia-summary-row {
                display: flex;
                justify-content: space-between;
                gap: 12px;
                padding: 7px 8px;
                background: #fff5da;
            }
            #${BOX_ID} .twia-summary-row:nth-child(4n+2),
            #${BOX_ID} .twia-summary-row:nth-child(4n+3) { background: #f0e2be; }
            #${BOX_ID} .twia-summary-emphasis strong { font-size: 14px; }
            #${BOX_ID} .twia-progress-wrap {
                margin-bottom: 13px;
                padding: 8px;
                border: 1px solid #bd9c5a;
                background: #fff5da;
            }
            #${BOX_ID} .twia-progress-top {
                display: flex;
                justify-content: space-between;
                gap: 10px;
                margin-bottom: 6px;
            }
            #${BOX_ID} .twia-progress-track {
                width: 100%;
                height: 10px;
                overflow: hidden;
                border: 1px solid #8f6a2b;
                background: #e7d6ac;
            }
            #${BOX_ID} #twia-progress-bar {
                width: 0%;
                height: 100%;
                background: #8ea85a;
                transition: width .15s ease;
            }
            #${BOX_ID} .twia-section-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                margin: 2px 0 7px;
            }
            #${BOX_ID} .twia-section-title { font-weight: 700; font-size: 13px; }
            #${BOX_ID} .twia-section-subtitle { margin-top: 2px; font-size: 10px; opacity: .72; }
            #${BOX_ID} .twia-button {
                padding: 5px 9px;
                border: 1px solid #7d510f;
                border-radius: 3px;
                background: #cfa95e;
                color: #2f1b00;
                font: inherit;
                font-weight: 700;
                cursor: pointer;
            }
            #${BOX_ID} .twia-button:disabled { opacity: .5; cursor: default; }
            #${BOX_ID} .twia-table-wrap {
                max-height: 285px;
                overflow: auto;
                border: 1px solid #bd9c5a;
                background: #fff5da;
            }
            #${BOX_ID} .twia-table { width: 100%; border-collapse: collapse; }
            #${BOX_ID} .twia-table th,
            #${BOX_ID} .twia-table td {
                padding: 6px 7px;
                border-bottom: 1px solid #d5bd87;
                text-align: left;
                vertical-align: middle;
            }
            #${BOX_ID} .twia-table th {
                position: sticky;
                top: 0;
                z-index: 2;
                background: #cfa95e;
                border-bottom: 1px solid #7d510f;
                font-weight: 700;
            }
            #${BOX_ID} .twia-table tbody tr:nth-child(even) td { background: #f0e2be; }
            #${BOX_ID} .twia-table tbody tr:nth-child(odd) td { background: #fff5da; }
            #${BOX_ID} .twia-table tbody tr:hover td { background: #ead49f; }
            #${BOX_ID} .twia-number { text-align: right !important; white-space: nowrap; }
            #${BOX_ID} .twia-rank { width: 28px; text-align: center; opacity: .75; }
            #${BOX_ID} .twia-player { max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #${BOX_ID} .twia-player-name { color: #603000; font-weight: 700; text-decoration: none; }
            #${BOX_ID} a.twia-player-name:hover { text-decoration: underline; }
            #${BOX_ID} .twia-empty { padding: 14px !important; text-align: center !important; opacity: .72; }
            #${BOX_ID} .twia-note {
                margin-top: 9px;
                padding: 7px 8px;
                border: 1px solid #d5bd87;
                background: #fff8e7;
                font-size: 10px;
                line-height: 1.4;
            }
            #${BOX_ID} .twia-note.twia-warning { border-color: #a56c2a; background: #f4dfb8; }
            #${BOX_ID} .twia-footer {
                display: flex;
                justify-content: space-between;
                gap: 12px;
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px solid #bd9c5a;
                font-size: 10px;
                opacity: .72;
            }
            @media (max-width: 600px) {
                #${BOX_ID} { left: 8px !important; right: 8px !important; top: 8px !important; width: auto; max-width: none; }
                #${BOX_ID} .twia-summary-grid { grid-template-columns: 1fr; }
            }
        `;

        box.appendChild(style);
        document.body.appendChild(box);

        box.querySelector(".twia-close").addEventListener("click", closeWidget);
        box.querySelector("#twia-copy").addEventListener("click", copyAttackerList);
        makeDraggable(box, box.querySelector("#twia-drag-handle"));

        return box;
    }

    function makeDraggable(box, handle) {
        if (!box || !handle) return;

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener("mousedown", event => {
            if (event.target.closest("button, a, input")) return;
            dragging = true;
            const rect = box.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            document.body.style.userSelect = "none";
        });

        document.addEventListener("mousemove", event => {
            if (!dragging) return;
            box.style.left = Math.max(0, event.clientX - offsetX) + "px";
            box.style.top = Math.max(0, event.clientY - offsetY) + "px";
            box.style.right = "auto";
        });

        document.addEventListener("mouseup", () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = "";
        });
    }

    function updateProgress(current, total, status) {
        const text = document.getElementById("twia-progress-text");
        const bar = document.getElementById("twia-progress-bar");
        const statusEl = document.getElementById("twia-status");

        if (text) text.textContent = current + "/" + total;
        if (bar) bar.style.width = (total > 0 ? (current / total) * 100 : 0) + "%";
        if (statusEl && status) statusEl.textContent = status;
    }

    function updateResults(playerName, done) {
        const summary = document.getElementById("twia-summary");
        const rows = document.getElementById("twia-attacker-rows");
        const copyBtn = document.getElementById("twia-copy");
        const note = document.getElementById("twia-note");

        if (summary) summary.innerHTML = buildSummaryHtml(playerName);
        if (rows) rows.innerHTML = buildAttackerRows();
        if (copyBtn) copyBtn.disabled = state.attackers.size === 0;

        if (done && note) {
            const unresolved = state.unresolvedCommands + state.failedCommands;
            if (state.failed > 0 || unresolved > 0) {
                note.classList.add("twia-warning");
                const parts = [];
                if (state.failed > 0) {
                    parts.push(state.failed + " failed village request" + (state.failed === 1 ? "" : "s"));
                }
                if (unresolved > 0) {
                    parts.push(unresolved + " attack" + (unresolved === 1 ? "" : "s") + " with unresolved origin player");
                }
                note.textContent = "Scan completed with " + parts.join(" and ") + ". Total attack counts remain available, but the attacker breakdown may be partial.";
            } else {
                note.classList.remove("twia-warning");
                note.textContent = "Scan completed. Every recognized incoming attack was matched to its Origin player. " +
                    state.networkCommandRequests + " command-detail request" + (state.networkCommandRequests === 1 ? "" : "s") +
                    " were needed; " + (state.directOriginHits + state.cacheHits) + " attack" + ((state.directOriginHits + state.cacheHits) === 1 ? "" : "s") +
                    " were resolved without an extra command-detail request. No game actions were performed.";
            }
        }
    }

    function copyText(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            return navigator.clipboard.writeText(text);
        }

        return new Promise((resolve, reject) => {
            try {
                const textarea = document.createElement("textarea");
                textarea.value = text;
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand("copy");
                textarea.remove();
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    async function copyAttackerList() {
        const attackers = getSortedAttackers();
        if (!attackers.length) return;

        const text = attackers.map(attacker => {
            return attacker.name + ": " + attacker.attacks + " attack" + (attacker.attacks === 1 ? "" : "s");
        }).join("\n");

        try {
            await copyText(text);
            notify("success", "Attacker list copied.");
        } catch (err) {
            notify("error", "Could not copy attacker list.");
        }
    }

    async function run() {
        if (!isPlayerInfoPage()) {
            notify("error", SCRIPT_NAME + " must be run from a Player Info page.");
            return;
        }

        const playerName = getPlayerName();
        createWidget(playerName);

        updateProgress(0, 0, "Reading player villages...");
        await expandVillageListIfNeeded();

        if (state.stopped) return;

        const villages = collectVillages();
        state.totalPlayerVillages = villages.all.length;
        state.villagesWithIncomings = villages.withIncomings.length;
        updateResults(playerName, false);

        if (!villages.all.length) {
            updateProgress(0, 0, "Could not find player villages.");
            notify("error", "Could not find villages on this Player Info page.");
            return;
        }

        if (!villages.withIncomings.length) {
            updateProgress(0, 0, "No incoming attacks found.");
            const rows = document.getElementById("twia-attacker-rows");
            if (rows) rows.innerHTML = '<tr><td colspan="5" class="twia-empty">No incoming attacks found.</td></tr>';
            notify("info", "No villages with incoming attacks were found.");
            return;
        }

        notify("success", "Scanning incomings for " + villages.withIncomings.length + " village" + (villages.withIncomings.length === 1 ? "" : "s") + "...");
        updateProgress(0, villages.withIncomings.length, "Step 1/2: Scanning incoming commands...");

        const pendingCommands = [];
        const seenCommandIds = new Set();

        await runPool(
            villages.withIncomings,
            VILLAGE_CONCURRENCY,
            async village => {
                if (state.stopped) return;
                try {
                    const html = await fetchHtml(village.url);
                    pendingCommands.push(...parseVillageCommands(html, village, seenCommandIds));
                } catch (err) {
                    state.failed += 1;
                    console.error("[" + SCRIPT_NAME + "] Failed to scan", village, err);
                }
            },
            completed => {
                state.scanned = completed;
                updateProgress(completed, villages.withIncomings.length, "Step 1/2: Scanning incoming commands...");
                scheduleResultsUpdate(playerName);
            }
        );

        if (state.stopped) return;

        state.commandCount = pendingCommands.length;

        if (pendingCommands.length) {
            updateProgress(0, pendingCommands.length, "Step 2/2: Resolving Origin players...");

            await runPool(
                pendingCommands,
                COMMAND_CONCURRENCY,
                async attack => {
                    if (state.stopped) return;
                    try {
                        const attacker = await resolveCommandAttacker(attack);
                        if (attacker) {
                            addAttackToAttacker(attacker, attack);
                        } else {
                            state.unresolvedCommands += 1;
                            console.warn("[" + SCRIPT_NAME + "] Could not identify Origin player for command", attack.commandId);
                        }
                    } catch (err) {
                        state.failedCommands += 1;
                        console.error("[" + SCRIPT_NAME + "] Failed to resolve command", attack.commandId, err);
                    }
                },
                completed => {
                    state.commandsResolved = completed;
                    updateProgress(completed, pendingCommands.length, "Step 2/2: Resolving Origin players...");
                    scheduleResultsUpdate(playerName);
                }
            );
        }

        if (state.stopped) return;

        if (uiRefreshTimer) {
            clearTimeout(uiRefreshTimer);
            uiRefreshTimer = null;
        }
        saveCommandCache();
        updateResults(playerName, true);
        const unresolved = state.unresolvedCommands + state.failedCommands;
        const finalStatus = unresolved || state.failed ? "Completed with warnings" : "Scan complete";
        const finalTotal = pendingCommands.length || villages.withIncomings.length;
        updateProgress(finalTotal, finalTotal, finalStatus);

        const resolvedAttackCount = getSortedAttackers().reduce((sum, attacker) => sum + attacker.attacks, 0);
        notify(
            unresolved || state.failed ? "info" : "success",
            "Incoming scan complete: " + formatNumber(state.totals.attacks) +
            " attacks, " + formatNumber(resolvedAttackCount) +
            " matched to " + formatNumber(state.attackers.size) +
            " origin player" + (state.attackers.size === 1 ? "" : "s") + "."
        );
    }

    run().catch(err => {
        console.error("[" + SCRIPT_NAME + "]", err);
        notify("error", SCRIPT_NAME + " failed. Check the browser console for details.");
        const status = document.getElementById("twia-status");
        if (status) status.textContent = "Scan failed";
    });
})();
