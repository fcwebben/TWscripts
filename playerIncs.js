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
    const SCRIPT_VERSION = "v1.0.0";
    const BOX_ID = "twactics-incoming-analyzer";
    const REQUEST_DELAY_MS = 250;

    const state = {
        stopped: false,
        scanned: 0,
        failed: 0,
        totalPlayerVillages: 0,
        villagesWithIncomings: 0,
        totals: emptyCounts(),
        attackers: new Map()
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

    async function fetchHtml(url) {
        const response = await fetch(url, {
            method: "GET",
            credentials: "same-origin",
            headers: {
                "Accept": "text/html, */*; q=0.01"
            }
        });

        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }

        return response.text();
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

    function getAttacker(row) {
        const quickLabel = cleanText((row.querySelector(".quickedit-label") || {}).textContent);
        let name = quickLabel ? cleanText(quickLabel.split(":")[0]) : "";

        const playerLinks = Array.from(row.querySelectorAll('a[href*="screen=info_player"]'));
        const playerLink = playerLinks.find(link => getParam("id", link.href || link.getAttribute("href"))) || playerLinks[0] || null;
        const id = playerLink ? (getParam("id", playerLink.href || playerLink.getAttribute("href")) || "") : "";

        if (!name && playerLink) {
            name = cleanText(playerLink.textContent);
        }

        if (!name) {
            name = "Unknown attacker";
        }

        return { name, id };
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

    function addAttack(attacker, kind, noble, village) {
        state.totals.attacks += 1;
        state.totals[kind] += 1;
        if (noble) state.totals.noble += 1;

        const entry = ensureAttacker(attacker);
        entry.attacks += 1;
        entry[kind] += 1;
        if (noble) entry.noble += 1;
        entry.targets.add(village.coord || village.id || village.name || village.url);
    }

    function parseVillageCommands(html, village) {
        const doc = parseHtml(html);
        let rows = Array.from(doc.querySelectorAll("#commands_outgoings tr.command-row"));

        // Fallback for markup variants where the command table ID differs.
        if (!rows.length) {
            rows = Array.from(doc.querySelectorAll("tr.command-row"));
        }

        rows.forEach(row => {
            const kind = getAttackKind(row);
            if (!kind) return;

            const attacker = getAttacker(row);
            addAttack(attacker, kind, rowHasNoble(row), village);
        });
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
            if (state.failed > 0) {
                note.classList.add("twia-warning");
                note.textContent = "Scan completed with " + state.failed + " failed village request" + (state.failed === 1 ? "" : "s") + ". Results are partial.";
            } else {
                note.classList.remove("twia-warning");
                note.textContent = "Scan completed. Attacker totals add up to all recognized incoming attacks. No game actions were performed.";
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
        updateProgress(0, villages.withIncomings.length, "Scanning incoming commands...");

        for (let i = 0; i < villages.withIncomings.length; i++) {
            if (state.stopped) return;

            const village = villages.withIncomings[i];

            try {
                const html = await fetchHtml(village.url);
                parseVillageCommands(html, village);
            } catch (err) {
                state.failed += 1;
                console.error("[" + SCRIPT_NAME + "] Failed to scan", village, err);
            }

            state.scanned = i + 1;
            updateProgress(state.scanned, villages.withIncomings.length, "Scanning incoming commands...");
            updateResults(playerName, false);

            if (i < villages.withIncomings.length - 1) {
                await sleep(REQUEST_DELAY_MS);
            }
        }

        if (state.stopped) return;

        updateResults(playerName, true);
        updateProgress(villages.withIncomings.length, villages.withIncomings.length, state.failed ? "Completed with warnings" : "Scan complete");
        notify("success", "Incoming scan complete: " + formatNumber(state.totals.attacks) + " attacks from " + formatNumber(state.attackers.size) + " player" + (state.attackers.size === 1 ? "" : "s") + ".");
    }

    run().catch(err => {
        console.error("[" + SCRIPT_NAME + "]", err);
        notify("error", SCRIPT_NAME + " failed. Check the browser console for details.");
        const status = document.getElementById("twia-status");
        if (status) status.textContent = "Scan failed";
    });
})();
