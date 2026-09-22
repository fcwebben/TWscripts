/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Tribe Incoming Analyzer
 * Script created by Twactics (zidrox)
 *
 * Runs from a Tribal Wars Tribe Info page (screen=info_ally).
 * Scans tribe members, their villages with incoming attacks, and resolves
 * the Origin player for each incoming command.
 *
 * This script:
 * - Reads tribe members from the current Tribe Info page
 * - Loads each member's Player Info page and uses ajax=fetch_villages for members with more than 100 villages
 * - Scans only villages visibly marked as having incoming attacks
 * - Counts attacks per target tribe member
 * - Resolves Origin -> Player from command details when needed
 * - Aggregates attacks by Origin player across the whole tribe
 * - Builds Origin player -> target member breakdowns
 * - Uses a faster adaptive global request-start limiter (~14 req/s base)
 * - Uses retry/backoff and a shared per-tab command-origin cache
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

    const SCRIPT_NAME = "Twactics Tribe Incoming Analyzer";
    const SCRIPT_VERSION = "v1.3.0";
    const BOX_ID = "twactics-tribe-incoming-analyzer";

    // Read-only page requests use an adaptive turbo limiter. Start at ~40
    // request starts/second and, if the server stays healthy, ramp toward ~55.6/s.
    // Any throttling/transient overload response immediately slows the global rate.
    // The limiter is shared by profile, village and command-detail requests.
    const INITIAL_REQUEST_START_INTERVAL_MS = 25; // 40.0 request starts / second
    const MIN_REQUEST_START_INTERVAL_MS = 18;     // ~55.6/s after clean recovery/ramp
    const MAX_REQUEST_START_INTERVAL_MS = 400;    // 2.5/s under sustained backoff
    const RATE_RECOVERY_SUCCESS_COUNT = 35;
    const RATE_RAMP_SUCCESS_COUNT = 80;
    const PROFILE_CONCURRENCY = 24;
    const VILLAGE_CONCURRENCY = 24;
    const COMMAND_CONCURRENCY = 24;
    const FETCH_TIMEOUT_MS = 15000;
    const MAX_FETCH_RETRIES = 3;
    const UI_REFRESH_MS = 150;

    // Reuse the same cache namespace as Twactics Incoming Analyzer v1.2.0 so
    // command Origins resolved by one analyzer are immediately useful to the other.
    const CACHE_PREFIX = "twacticsIncomingAnalyzerOriginCache";
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    const MAX_CACHE_ENTRIES = 6000;

    const state = {
        stopped: false,
        tribeName: "Unknown tribe",
        members: [],
        memberMap: new Map(),
        attackedVillages: [],
        attackedVillageKeys: new Set(),
        seenCommandIds: new Set(),
        pendingCommands: [],
        attackers: new Map(),
        totals: emptyCounts(),
        profilesDone: 0,
        profileFailures: 0,
        villagesDone: 0,
        villageFailures: 0,
        commandsDone: 0,
        failedCommands: 0,
        unresolvedCommands: 0,
        directOriginHits: 0,
        cacheHits: 0,
        networkCommandRequests: 0,
        cacheDirty: false,
        totalExpectedVillages: 0,
        totalDiscoveredVillages: 0,
        currentRequestIntervalMs: INITIAL_REQUEST_START_INTERVAL_MS,
        consecutiveRequestSuccesses: 0,
        rateBackoffs: 0
    };

    if (window.twacticsTribeIncomingAnalyzer && typeof window.twacticsTribeIncomingAnalyzer.close === "function") {
        window.twacticsTribeIncomingAnalyzer.close();
    }

    window.twacticsTribeIncomingAnalyzer = {
        state: state,
        close: closeWidget
    };

    function emptyCounts() {
        return {
            attacks: 0,
            noble: 0,
            small: 0,
            medium: 0,
            large: 0,
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

    function setParam(url, name, value) {
        const parsed = new URL(url, window.location.origin);
        parsed.searchParams.set(name, String(value));
        return parsed.pathname + parsed.search;
    }

    function normalizeGameUrl(url) {
        const parsed = new URL(url, window.location.origin);
        return parsed.pathname + parsed.search;
    }

    function isTribeInfoPage() {
        if (typeof game_data !== "undefined" && game_data.screen) {
            return game_data.screen === "info_ally";
        }
        return getParam("screen") === "info_ally";
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

    function getTribeName() {
        const heading = document.querySelector("#content_value h2, #contentContainer h2");
        let value = cleanText(heading ? heading.textContent : "");
        value = value.replace(/^Tribe\s*:?\s*/i, "").trim();
        return value || "Unknown tribe";
    }

    function findMemberTable() {
        const tables = Array.from(document.querySelectorAll("#content_value table.vis, #contentContainer table.vis, table.vis"));

        for (const table of tables) {
            const headerRow = table.querySelector("tr");
            if (!headerRow) continue;
            const headers = Array.from(headerRow.querySelectorAll("th")).map(th => cleanText(th.textContent).toLowerCase());
            const joined = headers.join("|");
            if (
                joined.includes("name") &&
                joined.includes("rank") &&
                joined.includes("points") &&
                joined.includes("villages") &&
                table.querySelector('a[href*="screen=info_player"][href*="id="]')
            ) {
                return table;
            }
        }

        return null;
    }

    function parseMembers() {
        const table = findMemberTable();
        if (!table) return [];

        const result = [];
        const seen = new Set();
        const rows = Array.from(table.querySelectorAll("tr"));

        rows.forEach(row => {
            const link = row.querySelector('a[href*="screen=info_player"][href*="id="]');
            if (!link) return;

            const id = getParam("id", link.href || link.getAttribute("href") || "") || "";
            if (!id || seen.has(id)) return;
            seen.add(id);

            const cells = Array.from(row.querySelectorAll("td"));
            const rank = cells[1] ? parseInt(cleanText(cells[1].textContent).replace(/[^\d]/g, ""), 10) || 0 : 0;
            const expectedVillages = cells[4] ? parseInt(cleanText(cells[4].textContent).replace(/[^\d]/g, ""), 10) || 0 : 0;

            const member = {
                id: String(id),
                name: cleanText(link.textContent),
                rank: rank,
                expectedVillages: expectedVillages,
                url: normalizeGameUrl(link.href || link.getAttribute("href") || ""),
                discoveredVillageIds: new Set(),
                attackedVillageIds: new Set(),
                counts: emptyCounts(),
                profileComplete: false,
                profileWarning: ""
            };

            result.push(member);
        });

        result.sort((a, b) => {
            if (a.rank && b.rank && a.rank !== b.rank) return a.rank - b.rank;
            if (a.rank && !b.rank) return -1;
            if (!a.rank && b.rank) return 1;
            return a.name.localeCompare(b.name);
        });

        return result;
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

    function rowHasIncomingAttack(row) {
        if (row.querySelector("span.command-attack-ally, span.command-attack")) return true;

        return Array.from(row.querySelectorAll("img")).some(img => {
            const src = String(img.getAttribute("src") || "");
            return /\/command\/attack(?:_|\.|\/)/i.test(src);
        });
    }

    function getVillageMetaFromRow(row, member) {
        const link = row.querySelector('a[href*="screen=info_village"][href*="id="]');
        if (!link) return null;

        const href = link.href || link.getAttribute("href") || "";
        const id = getParam("id", href) || "";
        if (!id) return null;

        const text = cleanText(row.textContent);
        const coordMatch = text.match(/\b\d{1,3}\|\d{1,3}\b/);

        return {
            id: String(id),
            name: cleanText(link.textContent),
            coord: coordMatch ? coordMatch[0] : "",
            url: normalizeGameUrl(href),
            targetId: member.id,
            targetName: member.name,
            targetRank: member.rank
        };
    }

    function parsePlayerProfile(html, member) {
        const doc = parseHtml(html);
        const table = doc.querySelector("#villages_list");
        const villages = [];
        const attacked = [];
        const pagination = [];

        if (table) {
            Array.from(table.querySelectorAll("tr")).forEach(row => {
                const village = getVillageMetaFromRow(row, member);
                if (!village) return;
                villages.push(village);
                if (rowHasIncomingAttack(row)) attacked.push(village);
            });

            Array.from(table.querySelectorAll('a[href*="screen=info_player"][href*="page="]')).forEach(link => {
                const href = link.href || link.getAttribute("href") || "";
                if (href) pagination.push(normalizeGameUrl(href));
            });
        }

        // Some layouts keep pagination outside #villages_list.
        Array.from(doc.querySelectorAll('a.paged-nav-item[href*="screen=info_player"], .paged-nav-item a[href*="screen=info_player"]')).forEach(link => {
            const href = link.href || link.getAttribute("href") || "";
            if (href) pagination.push(normalizeGameUrl(href));
        });

        // Players with more than 100 villages are truncated on the normal Player Info page.
        // Tribal Wars exposes the remaining villages through Player.getAllVillages(...), e.g.
        // /game.php?...&screen=info_player&ajax=fetch_villages&player_id=123456
        const leftoverUrls = [];
        Array.from(doc.querySelectorAll('a[onclick*="getAllVillages"], a[onclick*="fetch_villages"]')).forEach(link => {
            const onclick = String(link.getAttribute("onclick") || "");
            let url = "";

            const playerMatch = onclick.match(/Player\.getAllVillages\s*\(\s*this\s*,\s*["']([^"']+)["']/i);
            if (playerMatch) {
                url = playerMatch[1];
            } else {
                const ajaxMatch = onclick.match(/["']([^"']*ajax=fetch_villages[^"']*)["']/i);
                if (ajaxMatch) url = ajaxMatch[1];
            }

            if (url) {
                url = url.replace(/&amp;/gi, "&");
                try {
                    leftoverUrls.push(normalizeGameUrl(url));
                } catch (err) {
                    // Ignore malformed inline URLs and let the normal fallbacks continue.
                }
            }
        });

        return {
            villages: villages,
            attacked: attacked,
            pagination: Array.from(new Set(pagination)),
            leftoverUrls: Array.from(new Set(leftoverUrls))
        };
    }

    function extractAjaxVillageMarkup(raw) {
        let source = String(raw || "").trim();
        if (!source) return "";

        // Tribal Wars AJAX endpoints may return either HTML directly or JSON containing
        // an HTML fragment. Recursively collect likely village-row HTML strings if JSON.
        if (source[0] === "{" || source[0] === "[") {
            try {
                const parsed = JSON.parse(source);
                const fragments = [];

                (function visit(value) {
                    if (typeof value === "string") {
                        if (/screen=info_village|village_anchor|<tr\b|<table\b/i.test(value)) {
                            fragments.push(value);
                        }
                        return;
                    }
                    if (Array.isArray(value)) {
                        value.forEach(visit);
                        return;
                    }
                    if (value && typeof value === "object") {
                        Object.keys(value).forEach(key => visit(value[key]));
                    }
                })(parsed);

                if (fragments.length) source = fragments.join("\n");
            } catch (err) {
                // Not JSON; parse it as HTML below.
            }
        }

        return source;
    }

    function parseLeftoverVillagesResponse(raw, member) {
        const source = extractAjaxVillageMarkup(raw);
        if (!source) return { villages: [], attacked: [], pagination: [], leftoverUrls: [] };

        let doc;
        if (/<html\b|<body\b|id\s*=\s*["']villages_list["']/i.test(source)) {
            doc = parseHtml(source);
        } else {
            // A raw sequence of <tr> elements needs a table context so DOMParser keeps them.
            doc = parseHtml('<!doctype html><html><body><table id="villages_list"><tbody>' + source + '</tbody></table></body></html>');
        }

        const scope = doc.querySelector("#villages_list") || doc;
        const villages = [];
        const attacked = [];

        Array.from(scope.querySelectorAll("tr")).forEach(row => {
            const village = getVillageMetaFromRow(row, member);
            if (!village) return;
            villages.push(village);
            if (rowHasIncomingAttack(row)) attacked.push(village);
        });

        return { villages: villages, attacked: attacked, pagination: [], leftoverUrls: [] };
    }

    function registerProfilePage(member, parsed) {
        let newVillages = 0;

        parsed.villages.forEach(village => {
            if (!member.discoveredVillageIds.has(village.id)) {
                member.discoveredVillageIds.add(village.id);
                newVillages += 1;
            }
        });

        parsed.attacked.forEach(village => {
            if (!member.attackedVillageIds.has(village.id)) {
                member.attackedVillageIds.add(village.id);
            }

            const key = member.id + ":" + village.id;
            if (!state.attackedVillageKeys.has(key)) {
                state.attackedVillageKeys.add(key);
                state.attackedVillages.push(village);
            }
        });

        return newVillages;
    }

    // ---------- Global request scheduler ----------

    let requestGate = Promise.resolve();
    let lastRequestStart = 0;

    function getCurrentRequestRate() {
        return 1000 / Math.max(1, state.currentRequestIntervalMs);
    }

    function applyRateBackoff(status) {
        // 429 is treated as a clear throttle signal and backs off harder.
        // 5xx overload responses also slow the scan, but less aggressively.
        const multiplier = status === 429 ? 2.5 : 1.7;
        const floorAfterBackoff = status === 429 ? 80 : 45;
        state.currentRequestIntervalMs = Math.min(
            MAX_REQUEST_START_INTERVAL_MS,
            Math.max(floorAfterBackoff, Math.ceil(state.currentRequestIntervalMs * multiplier))
        );
        state.consecutiveRequestSuccesses = 0;
        state.rateBackoffs += 1;
    }

    function registerRequestSuccess() {
        state.consecutiveRequestSuccesses += 1;

        // If we are recovering from a backoff, return toward the normal turbo rate
        // in controlled steps instead of snapping back immediately.
        if (
            state.currentRequestIntervalMs > INITIAL_REQUEST_START_INTERVAL_MS &&
            state.consecutiveRequestSuccesses >= RATE_RECOVERY_SUCCESS_COUNT
        ) {
            state.currentRequestIntervalMs = Math.max(
                INITIAL_REQUEST_START_INTERVAL_MS,
                Math.floor(state.currentRequestIntervalMs * 0.72)
            );
            state.consecutiveRequestSuccesses = 0;
            return;
        }

        // If the server has been consistently healthy, probe a little faster.
        if (
            state.currentRequestIntervalMs <= INITIAL_REQUEST_START_INTERVAL_MS &&
            state.currentRequestIntervalMs > MIN_REQUEST_START_INTERVAL_MS &&
            state.consecutiveRequestSuccesses >= RATE_RAMP_SUCCESS_COUNT
        ) {
            state.currentRequestIntervalMs = Math.max(
                MIN_REQUEST_START_INTERVAL_MS,
                state.currentRequestIntervalMs - 2
            );
            state.consecutiveRequestSuccesses = 0;
        }
    }

    function waitForRequestSlot() {
        const ticket = requestGate.then(async () => {
            if (state.stopped) throw new Error("Stopped");
            const elapsed = Date.now() - lastRequestStart;
            const waitMs = Math.max(0, state.currentRequestIntervalMs - elapsed);
            if (waitMs > 0) await sleep(waitMs);
            lastRequestStart = Date.now();
        });

        requestGate = ticket.catch(() => {});
        return ticket;
    }

    async function fetchHtml(url, attempt) {
        attempt = attempt || 0;
        await waitForRequestSlot();

        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timeout = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;

        try {
            const response = await fetch(url, {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Accept": "text/html, */*; q=0.01" },
                signal: controller ? controller.signal : undefined
            });

            if (!response.ok) {
                const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
                if (retryable) applyRateBackoff(response.status);
                if (retryable && attempt < MAX_FETCH_RETRIES) {
                    const retryAfter = parseFloat(response.headers.get("Retry-After"));
                    const waitMs = Number.isFinite(retryAfter)
                        ? Math.max(500, retryAfter * 1000)
                        : 500 * Math.pow(2, attempt);
                    await sleep(waitMs);
                    return fetchHtml(url, attempt + 1);
                }
                throw new Error("HTTP " + response.status + " for " + url);
            }

            registerRequestSuccess();
            return await response.text();
        } catch (err) {
            if (attempt < MAX_FETCH_RETRIES && err && err.name === "AbortError") {
                await sleep(700 * Math.pow(2, attempt));
                return fetchHtml(url, attempt + 1);
            }
            throw err;
        } finally {
            if (timeout) clearTimeout(timeout);
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

    // ---------- Command Origin cache ----------

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
            // Cache failure must never stop the scan.
        }
    }

    // ---------- Player profile scanning ----------

    async function scanMemberProfile(member) {
        if (member.expectedVillages <= 0) {
            member.profileComplete = true;
            return;
        }

        const tried = new Set();
        const queuedPagination = [];
        const queuedLeftovers = [];

        function queueParsedLinks(parsed) {
            (parsed.pagination || []).forEach(pageUrl => {
                if (!tried.has(pageUrl) && !queuedPagination.includes(pageUrl)) queuedPagination.push(pageUrl);
            });
            (parsed.leftoverUrls || []).forEach(leftoverUrl => {
                if (!tried.has(leftoverUrl) && !queuedLeftovers.includes(leftoverUrl)) queuedLeftovers.push(leftoverUrl);
            });
        }

        async function load(url) {
            const normalized = normalizeGameUrl(url);
            if (tried.has(normalized)) return null;
            tried.add(normalized);

            const html = await fetchHtml(normalized);
            const parsed = parsePlayerProfile(html, member);
            registerProfilePage(member, parsed);
            queueParsedLinks(parsed);
            return parsed;
        }

        async function loadLeftover(url) {
            const normalized = normalizeGameUrl(url);
            if (tried.has(normalized)) return null;
            tried.add(normalized);

            const raw = await fetchHtml(normalized);
            const parsed = parseLeftoverVillagesResponse(raw, member);
            registerProfilePage(member, parsed);
            return parsed;
        }

        async function drainLeftovers() {
            while (
                !state.stopped &&
                queuedLeftovers.length &&
                member.discoveredVillageIds.size < member.expectedVillages
            ) {
                const next = queuedLeftovers.shift();
                try {
                    await loadLeftover(next);
                } catch (err) {
                    console.warn("[" + SCRIPT_NAME + "] leftover villages request failed for", member.name, next, err);
                }
            }
        }

        // Fast path: ask for the broadest profile view first. On accounts above the
        // normal 100-village display cap, immediately follow the native
        // ajax=fetch_villages link to retrieve every leftover village in one request.
        let allPageWorked = false;
        try {
            const parsed = await load(setParam(member.url, "page", "-1"));
            allPageWorked = !!parsed;
            await drainLeftovers();
        } catch (err) {
            console.warn("[" + SCRIPT_NAME + "] page=-1 failed for", member.name, err);
        }

        if (member.discoveredVillageIds.size >= member.expectedVillages) {
            member.profileComplete = true;
            return;
        }

        // Fallback to the normal profile page. This is also where Tribal Wars most
        // commonly exposes the Display all leftover X villages AJAX link.
        try {
            await load(member.url);
            await drainLeftovers();
        } catch (err) {
            if (!allPageWorked) throw err;
        }

        while (
            !state.stopped &&
            queuedPagination.length &&
            member.discoveredVillageIds.size < member.expectedVillages
        ) {
            const next = queuedPagination.shift();
            try {
                await load(next);
                await drainLeftovers();
            } catch (err) {
                console.warn("[" + SCRIPT_NAME + "] pagination request failed for", member.name, next, err);
            }
        }

        // Last-resort numeric paging. We tolerate one duplicate page because some
        // worlds number the first page as 0 while others expose 1 first. With the current
        // 100-village profile cap, only estimate the small number of pages actually needed.
        if (member.discoveredVillageIds.size < member.expectedVillages) {
            const estimatedPages = Math.min(20, Math.max(3, Math.ceil(member.expectedVillages / 100) + 2));
            let noNewStreak = 0;

            for (let page = 0; page < estimatedPages; page++) {
                if (state.stopped || member.discoveredVillageIds.size >= member.expectedVillages) break;

                const before = member.discoveredVillageIds.size;
                try {
                    await load(setParam(member.url, "page", page));
                } catch (err) {
                    console.warn("[" + SCRIPT_NAME + "] numeric page failed for", member.name, page, err);
                }

                if (member.discoveredVillageIds.size === before) {
                    noNewStreak += 1;
                } else {
                    noNewStreak = 0;
                }

                if (noNewStreak >= 3) break;
            }
        }

        member.profileComplete = member.discoveredVillageIds.size >= member.expectedVillages;
        if (!member.profileComplete) {
            member.profileWarning = "Found " + member.discoveredVillageIds.size + "/" + member.expectedVillages + " villages";
        }
    }

    // ---------- Village / incoming command parsing ----------

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
        return { id: String(id || ""), name: name };
    }

    function getOriginPlayerFromCommandRow(row, targetId) {
        const candidates = [];
        const seen = new Set();

        Array.from(row.querySelectorAll('a[href*="screen=info_player"]')).forEach(link => {
            const player = getPlayerFromLink(link);
            if (!player || !player.name) return;
            if (targetId && player.id === String(targetId)) return;

            const key = player.id ? "id:" + player.id : "name:" + player.name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push(player);
        });

        return candidates.length === 1 ? candidates[0] : null;
    }

    function getCommandDetails(row) {
        const links = Array.from(row.querySelectorAll('a[href*="screen=info_command"]'));
        const link = links.find(item => getParam("id", item.href || item.getAttribute("href") || "")) || links[0] || null;

        if (link) {
            const href = link.href || link.getAttribute("href") || "";
            const id = getParam("id", href) || "";
            if (id) return { id: String(id), url: normalizeGameUrl(href) };
        }

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

        return { id: String(id), url: url.pathname + url.search };
    }

    function parseOriginPlayer(html) {
        const doc = parseHtml(html);
        const rows = Array.from(doc.querySelectorAll("tr"));

        for (const row of rows) {
            const firstCell = row.querySelector(":scope > td[rowspan], :scope > th[rowspan]");
            const playerLink = row.querySelector('a[href*="screen=info_player"]');
            if (firstCell && playerLink) {
                const label = cleanText(firstCell.textContent).toLowerCase();
                if (label && !label.includes("origin")) continue;
                const player = getPlayerFromLink(playerLink);
                if (player) return player;
            }
        }

        // Structural fallback: in command details the first player link is Origin.
        const firstPlayerLink = doc.querySelector('a[href*="screen=info_player"]');
        return getPlayerFromLink(firstPlayerLink);
    }

    function addCount(counts, kind, noble) {
        counts.attacks += 1;
        counts[kind] += 1;
        if (noble) counts.noble += 1;
    }

    function parseVillageCommands(html, village) {
        const doc = parseHtml(html);
        let rows = Array.from(doc.querySelectorAll("#commands_outgoings tr.command-row"));
        if (!rows.length) rows = Array.from(doc.querySelectorAll("tr.command-row"));

        const target = state.memberMap.get(String(village.targetId));
        const pending = [];

        rows.forEach(row => {
            const kind = getAttackKind(row);
            if (!kind) return;

            const noble = rowHasNoble(row);
            const command = getCommandDetails(row);

            if (command && state.seenCommandIds.has(command.id)) return;
            if (command) state.seenCommandIds.add(command.id);

            addCount(state.totals, kind, noble);
            if (target) addCount(target.counts, kind, noble);

            const attack = {
                kind: kind,
                noble: noble,
                commandId: command ? command.id : "",
                commandUrl: command ? command.url : "",
                village: village,
                targetId: String(village.targetId),
                targetName: village.targetName
            };

            const direct = getOriginPlayerFromCommandRow(row, attack.targetId);
            if (direct) {
                state.directOriginHits += 1;
                addAttackToAttacker(direct, attack);
                if (attack.commandId) cacheAttacker(attack.commandId, direct);
                return;
            }

            const cached = getCachedAttacker(attack.commandId);
            if (cached) {
                state.cacheHits += 1;
                addAttackToAttacker(cached, attack);
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

    function ensureAttacker(attacker) {
        const key = attacker.id ? "id:" + attacker.id : "name:" + attacker.name.toLowerCase();

        if (!state.attackers.has(key)) {
            state.attackers.set(key, {
                id: String(attacker.id || ""),
                name: attacker.name,
                counts: emptyCounts(),
                byTarget: new Map(),
                targetVillages: new Set()
            });
        }

        return state.attackers.get(key);
    }

    function addAttackToAttacker(attacker, attack) {
        if (!attacker) {
            state.unresolvedCommands += 1;
            return;
        }

        const entry = ensureAttacker(attacker);
        addCount(entry.counts, attack.kind, attack.noble);
        entry.targetVillages.add(attack.village.id || attack.village.coord || attack.village.name);

        if (!entry.byTarget.has(attack.targetId)) {
            entry.byTarget.set(attack.targetId, {
                id: attack.targetId,
                name: attack.targetName,
                counts: emptyCounts()
            });
        }

        addCount(entry.byTarget.get(attack.targetId).counts, attack.kind, attack.noble);
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

    // ---------- Reporting ----------

    function getSortedAttackers() {
        return Array.from(state.attackers.values()).sort((a, b) => {
            if (b.counts.attacks !== a.counts.attacks) return b.counts.attacks - a.counts.attacks;
            return a.name.localeCompare(b.name);
        });
    }

    function formatBreakdown(counts, includeGeneric) {
        const parts = [];
        if (counts.small) parts.push("Small: " + formatNumber(counts.small));
        if (counts.medium) parts.push("Medium: " + formatNumber(counts.medium));
        if (counts.large) parts.push("Large: " + formatNumber(counts.large));
        if (includeGeneric && counts.generic) parts.push("Other: " + formatNumber(counts.generic));
        if (!parts.length) {
            parts.push("Small: 0", "Medium: 0", "Large: 0");
        }
        return parts.join(" | ");
    }

    function attackText(counts) {
        return formatNumber(counts.attacks) + " attack" + (counts.attacks === 1 ? "" : "s") +
            " (" + formatBreakdown(counts, true) + ")";
    }

    function tribeAttackText(counts) {
        return formatNumber(counts.attacks) + " attack" + (counts.attacks === 1 ? "" : "s") +
            " (Small: " + formatNumber(counts.small) +
            " | Medium: " + formatNumber(counts.medium) +
            " | Large: " + formatNumber(counts.large) + ")";
    }

    function buildMemberRows() {
        if (!state.members.length) {
            return '<tr><td colspan="6" class="ttia-empty">No tribe members found.</td></tr>';
        }

        return state.members.map(member => {
            const warning = member.profileWarning
                ? '<span class="ttia-warn" title="' + escapeHtml(member.profileWarning) + '">!</span>'
                : "";

            return [
                "<tr>",
                '<td class="ttia-rank">' + (member.rank || "") + "</td>",
                '<td class="ttia-player">' + warning + makePlayerLink(member.id, member.name) + "</td>",
                '<td class="ttia-num"><strong>' + formatNumber(member.counts.attacks) + "</strong></td>",
                '<td class="ttia-num">' + formatNumber(member.counts.small) + "</td>",
                '<td class="ttia-num">' + formatNumber(member.counts.medium) + "</td>",
                '<td class="ttia-num">' + formatNumber(member.counts.large) + "</td>",
                "</tr>"
            ].join("");
        }).join("");
    }

    function makePlayerLink(id, name) {
        if (!id) return '<span class="ttia-player-name">' + escapeHtml(name) + "</span>";
        return '<a class="ttia-player-name" href="/game.php?screen=info_player&id=' + encodeURIComponent(id) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(name) + "</a>";
    }

    function buildAttackerRows() {
        const attackers = getSortedAttackers();
        if (!attackers.length) {
            return '<tr><td colspan="7" class="ttia-empty">No Origin players resolved yet.</td></tr>';
        }

        return attackers.map((attacker, index) => {
            return [
                "<tr>",
                '<td class="ttia-rank">' + (index + 1) + "</td>",
                '<td class="ttia-player">' + makePlayerLink(attacker.id, attacker.name) + "</td>",
                '<td class="ttia-num"><strong>' + formatNumber(attacker.counts.attacks) + "</strong></td>",
                '<td class="ttia-num">' + formatNumber(attacker.counts.small) + "</td>",
                '<td class="ttia-num">' + formatNumber(attacker.counts.medium) + "</td>",
                '<td class="ttia-num">' + formatNumber(attacker.counts.large) + "</td>",
                '<td class="ttia-num">' + formatNumber(attacker.byTarget.size) + "</td>",
                "</tr>"
            ].join("");
        }).join("");
    }

    function buildMatrixHtml() {
        const attackers = getSortedAttackers();
        if (!attackers.length) {
            return '<div class="ttia-empty-block">Origin → target breakdown will appear as commands are resolved.</div>';
        }

        return attackers.map(attacker => {
            const targets = Array.from(attacker.byTarget.values()).sort((a, b) => {
                if (b.counts.attacks !== a.counts.attacks) return b.counts.attacks - a.counts.attacks;
                return a.name.localeCompare(b.name);
            });

            const rows = targets.map(target => {
                return [
                    "<tr>",
                    '<td class="ttia-player">' + makePlayerLink(target.id, target.name) + "</td>",
                    '<td class="ttia-num"><strong>' + formatNumber(target.counts.attacks) + "</strong></td>",
                    '<td class="ttia-num">' + formatNumber(target.counts.small) + "</td>",
                    '<td class="ttia-num">' + formatNumber(target.counts.medium) + "</td>",
                    '<td class="ttia-num">' + formatNumber(target.counts.large) + "</td>",
                    "</tr>"
                ].join("");
            }).join("");

            return [
                '<details class="ttia-details">',
                '<summary><strong>' + escapeHtml(attacker.name) + '</strong> — ' + formatNumber(attacker.counts.attacks) + ' attacks to ' + formatNumber(attacker.byTarget.size) + ' tribe member' + (attacker.byTarget.size === 1 ? "" : "s") + "</summary>",
                '<div class="ttia-details-table-wrap"><table class="ttia-table ttia-small-table">',
                '<thead><tr><th>Target player</th><th class="ttia-num">Attacks</th><th class="ttia-num">Small</th><th class="ttia-num">Medium</th><th class="ttia-num">Large</th></tr></thead>',
                "<tbody>" + rows + "</tbody>",
                "</table></div>",
                "</details>"
            ].join("");
        }).join("");
    }

    function buildSummaryHtml() {
        const unresolved = state.unresolvedCommands + state.failedCommands;
        return [
            '<div class="ttia-target">Tribe: <strong>' + escapeHtml(state.tribeName) + '</strong> - <strong>' + escapeHtml(tribeAttackText(state.totals)) + "</strong></div>",
            '<div class="ttia-summary-grid">',
            summaryItem("Members", formatNumber(state.members.length)),
            summaryItem("Expected villages", formatNumber(state.totalExpectedVillages)),
            summaryItem("Villages found", formatNumber(state.totalDiscoveredVillages)),
            summaryItem("Villages with incomings", formatNumber(state.attackedVillages.length)),
            summaryItem("Total attacks", formatNumber(state.totals.attacks), true),
            summaryItem("Origin players", formatNumber(state.attackers.size)),
            summaryItem("Small", formatNumber(state.totals.small)),
            summaryItem("Medium", formatNumber(state.totals.medium)),
            summaryItem("Large", formatNumber(state.totals.large)),
            summaryItem("Unresolved origins", formatNumber(unresolved)),
            "</div>"
        ].join("");
    }

    function summaryItem(label, value, emphasis) {
        return '<div class="ttia-summary-item' + (emphasis ? " ttia-emphasis" : "") + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + "</strong></div>";
    }

    function buildCopyText() {
        const lines = [];
        lines.push("Tribe: " + state.tribeName + " - " + tribeAttackText(state.totals));

        state.members.forEach(member => {
            lines.push(member.name + ": " + attackText(member.counts));
        });

        lines.push("");
        lines.push("Attacking players:");
        getSortedAttackers().forEach(attacker => {
            lines.push(attacker.name + ": " + attackText(attacker.counts));
        });

        lines.push("");
        lines.push("Origin -> target:");
        getSortedAttackers().forEach(attacker => {
            lines.push(attacker.name + ":");
            Array.from(attacker.byTarget.values())
                .sort((a, b) => b.counts.attacks - a.counts.attacks || a.name.localeCompare(b.name))
                .forEach(target => {
                    lines.push("  " + target.name + ": " + attackText(target.counts));
                });
        });

        return lines.join("\n");
    }

    // ---------- UI ----------

    let uiRefreshTimer = null;

    function closeWidget() {
        state.stopped = true;
        saveCommandCache();
        if (uiRefreshTimer) clearTimeout(uiRefreshTimer);
        uiRefreshTimer = null;
        const box = document.getElementById(BOX_ID);
        if (box) box.remove();
        if (window.twacticsTribeIncomingAnalyzer) window.twacticsTribeIncomingAnalyzer = null;
    }

    function makeDraggable(box, handle) {
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener("mousedown", event => {
            if (event.target.closest("button, a, input, summary")) return;
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

    function createWidget() {
        const old = document.getElementById(BOX_ID);
        if (old) old.remove();

        const box = document.createElement("div");
        box.id = BOX_ID;
        box.innerHTML = `
            <div class="ttia-header" id="ttia-drag-handle">
                <div>
                    <div class="ttia-title">${escapeHtml(SCRIPT_NAME)}</div>
                    <div class="ttia-version">${escapeHtml(SCRIPT_VERSION)}</div>
                </div>
                <button type="button" class="ttia-close" title="Close">×</button>
            </div>
            <div class="ttia-body">
                <div id="ttia-summary">${buildSummaryHtml()}</div>

                <div class="ttia-progress-wrap">
                    <div class="ttia-progress-top">
                        <span id="ttia-status">Preparing scan...</span>
                        <strong id="ttia-progress-text">0/0</strong>
                    </div>
                    <div class="ttia-progress-track"><div id="ttia-progress-bar"></div></div>
                </div>

                <div class="ttia-section-head">
                    <div>
                        <div class="ttia-section-title">Tribe members</div>
                        <div class="ttia-section-subtitle">Incoming attacks per target player</div>
                    </div>
                    <button type="button" class="ttia-button" id="ttia-copy" disabled>Copy full report</button>
                </div>
                <div class="ttia-table-wrap ttia-member-wrap">
                    <table class="ttia-table">
                        <thead><tr><th>#</th><th>Player</th><th class="ttia-num">Attacks</th><th class="ttia-num">Small</th><th class="ttia-num">Medium</th><th class="ttia-num">Large</th></tr></thead>
                        <tbody id="ttia-member-rows">${buildMemberRows()}</tbody>
                    </table>
                </div>

                <div class="ttia-section-head ttia-section-gap">
                    <div>
                        <div class="ttia-section-title">Attacking players</div>
                        <div class="ttia-section-subtitle">All resolved Origin players across the tribe</div>
                    </div>
                </div>
                <div class="ttia-table-wrap ttia-attacker-wrap">
                    <table class="ttia-table">
                        <thead><tr><th>#</th><th>Origin player</th><th class="ttia-num">Attacks</th><th class="ttia-num">Small</th><th class="ttia-num">Medium</th><th class="ttia-num">Large</th><th class="ttia-num">Targets</th></tr></thead>
                        <tbody id="ttia-attacker-rows">${buildAttackerRows()}</tbody>
                    </table>
                </div>

                <div class="ttia-section-head ttia-section-gap">
                    <div>
                        <div class="ttia-section-title">Origin → target breakdown</div>
                        <div class="ttia-section-subtitle">Open an Origin player to see attacks against each tribe member</div>
                    </div>
                </div>
                <div id="ttia-matrix" class="ttia-matrix">${buildMatrixHtml()}</div>

                <div class="ttia-note" id="ttia-note">
                    Read-only requests start at ~${(1000 / INITIAL_REQUEST_START_INTERVAL_MS).toFixed(1)}/s, can ramp to ~${(1000 / MIN_REQUEST_START_INTERVAL_MS).toFixed(1)}/s, and automatically back off if Tribal Wars throttles the scan. No game actions are performed.
                </div>

                <div class="ttia-footer"><span>MIT</span><span>Created by Twactics (zidrox)</span></div>
            </div>
        `;

        const style = document.createElement("style");
        style.textContent = `
            #${BOX_ID} {
                position: fixed; top: 50px; right: 26px; width: 780px;
                max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
                z-index: 999999; overflow: hidden; background: #f4e4bc;
                border: 2px solid #7d510f; border-radius: 7px;
                box-shadow: 0 10px 30px rgba(0,0,0,.38); color: #2f1b00;
                font: 12px Verdana, Arial, sans-serif; box-sizing: border-box;
            }
            #${BOX_ID} * { box-sizing: border-box; }
            #${BOX_ID} .ttia-header {
                min-height: 49px; padding: 9px 11px; display: flex; align-items: center;
                justify-content: space-between; gap: 12px; cursor: move; user-select: none;
                background-color: #c1a264; background-image: url(/graphic/screen/tableheader_bg3.png);
                background-repeat: repeat-x; border-bottom: 1px solid #7d510f;
            }
            #${BOX_ID} .ttia-title { font-size: 16px; font-weight: 700; line-height: 1.1; }
            #${BOX_ID} .ttia-version { margin-top: 3px; font-size: 10px; opacity: .72; }
            #${BOX_ID} .ttia-close {
                width: 28px; height: 28px; border: 1px solid #7d510f; border-radius: 4px;
                background: #e6d3a5; color: #2f1b00; font-size: 20px; line-height: 22px;
                font-weight: 700; cursor: pointer;
            }
            #${BOX_ID} .ttia-body { padding: 12px; overflow: auto; max-height: calc(100vh - 73px); }
            #${BOX_ID} .ttia-target { margin-bottom: 9px; padding: 8px 9px; border: 1px solid #bd9c5a; background: #fff5da; }
            #${BOX_ID} .ttia-summary-grid {
                display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px;
                margin-bottom: 12px; border: 1px solid #bd9c5a; background: #bd9c5a;
            }
            #${BOX_ID} .ttia-summary-item { padding: 7px 8px; background: #fff5da; min-width: 0; }
            #${BOX_ID} .ttia-summary-item span { display: block; font-size: 10px; opacity: .76; margin-bottom: 3px; }
            #${BOX_ID} .ttia-summary-item strong { font-size: 13px; }
            #${BOX_ID} .ttia-summary-item.ttia-emphasis strong { font-size: 16px; }
            #${BOX_ID} .ttia-progress-wrap { margin-bottom: 13px; padding: 8px; border: 1px solid #bd9c5a; background: #fff5da; }
            #${BOX_ID} .ttia-progress-top { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
            #${BOX_ID} .ttia-progress-track { width: 100%; height: 10px; overflow: hidden; border: 1px solid #8f6a2b; background: #e7d6ac; }
            #${BOX_ID} #ttia-progress-bar { width: 0%; height: 100%; background: #8ea85a; transition: width .12s ease; }
            #${BOX_ID} .ttia-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 2px 0 7px; }
            #${BOX_ID} .ttia-section-gap { margin-top: 14px; }
            #${BOX_ID} .ttia-section-title { font-weight: 700; font-size: 13px; }
            #${BOX_ID} .ttia-section-subtitle { margin-top: 2px; font-size: 10px; opacity: .72; }
            #${BOX_ID} .ttia-button { padding: 5px 9px; border: 1px solid #7d510f; border-radius: 3px; background: #cfa95e; color: #2f1b00; font: inherit; font-weight: 700; cursor: pointer; }
            #${BOX_ID} .ttia-button:disabled { opacity: .5; cursor: default; }
            #${BOX_ID} .ttia-table-wrap { overflow: auto; border: 1px solid #bd9c5a; background: #fff5da; }
            #${BOX_ID} .ttia-member-wrap { max-height: 255px; }
            #${BOX_ID} .ttia-attacker-wrap { max-height: 255px; }
            #${BOX_ID} .ttia-table { width: 100%; border-collapse: collapse; }
            #${BOX_ID} .ttia-table th, #${BOX_ID} .ttia-table td { padding: 6px 7px; border-bottom: 1px solid #d5bd87; text-align: left; vertical-align: middle; }
            #${BOX_ID} .ttia-table th { position: sticky; top: 0; z-index: 2; background: #cfa95e; border-bottom: 1px solid #7d510f; font-weight: 700; white-space: nowrap; }
            #${BOX_ID} .ttia-table tbody tr:nth-child(even) td { background: #f0e2be; }
            #${BOX_ID} .ttia-table tbody tr:nth-child(odd) td { background: #fff5da; }
            #${BOX_ID} .ttia-table tbody tr:hover td { background: #ead49f; }
            #${BOX_ID} .ttia-num { text-align: right !important; white-space: nowrap; }
            #${BOX_ID} .ttia-rank { width: 28px; text-align: center; opacity: .75; }
            #${BOX_ID} .ttia-player { max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #${BOX_ID} .ttia-player-name { color: #603000; font-weight: 700; text-decoration: none; }
            #${BOX_ID} a.ttia-player-name:hover { text-decoration: underline; }
            #${BOX_ID} .ttia-warn { display: inline-block; margin-right: 5px; color: #9a4d00; font-weight: 700; }
            #${BOX_ID} .ttia-empty { padding: 14px !important; text-align: center !important; opacity: .72; }
            #${BOX_ID} .ttia-empty-block { padding: 12px; border: 1px solid #d5bd87; background: #fff8e7; opacity: .75; text-align: center; }
            #${BOX_ID} .ttia-matrix { max-height: 330px; overflow: auto; }
            #${BOX_ID} .ttia-details { margin-bottom: 6px; border: 1px solid #bd9c5a; background: #fff5da; }
            #${BOX_ID} .ttia-details summary { padding: 7px 9px; cursor: pointer; background: #ead49f; }
            #${BOX_ID} .ttia-details-table-wrap { overflow: auto; max-height: 230px; }
            #${BOX_ID} .ttia-small-table th { top: 0; }
            #${BOX_ID} .ttia-note { margin-top: 10px; padding: 7px 8px; border: 1px solid #d5bd87; background: #fff8e7; font-size: 10px; line-height: 1.4; }
            #${BOX_ID} .ttia-note.ttia-warning { border-color: #a56c2a; background: #f4dfb8; }
            #${BOX_ID} .ttia-footer { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; padding-top: 8px; border-top: 1px solid #bd9c5a; font-size: 10px; opacity: .72; }
            @media (max-width: 800px) {
                #${BOX_ID} { left: 8px !important; right: 8px !important; top: 8px !important; width: auto; max-width: none; }
                #${BOX_ID} .ttia-summary-grid { grid-template-columns: repeat(2, 1fr); }
            }
        `;

        box.appendChild(style);
        document.body.appendChild(box);

        box.querySelector(".ttia-close").addEventListener("click", closeWidget);
        box.querySelector("#ttia-copy").addEventListener("click", copyFullReport);
        makeDraggable(box, box.querySelector("#ttia-drag-handle"));
    }

    function updateProgress(current, total, status) {
        const text = document.getElementById("ttia-progress-text");
        const bar = document.getElementById("ttia-progress-bar");
        const statusEl = document.getElementById("ttia-status");

        if (text) text.textContent = current + "/" + total;
        if (bar) bar.style.width = (total > 0 ? (current / total) * 100 : 0) + "%";
        if (statusEl && status) statusEl.textContent = status;
    }

    function recalcDiscoveredVillages() {
        state.totalDiscoveredVillages = state.members.reduce((sum, member) => sum + member.discoveredVillageIds.size, 0);
    }

    function updateResults(done) {
        recalcDiscoveredVillages();

        const summary = document.getElementById("ttia-summary");
        const memberRows = document.getElementById("ttia-member-rows");
        const attackerRows = document.getElementById("ttia-attacker-rows");
        const matrix = document.getElementById("ttia-matrix");
        const copyBtn = document.getElementById("ttia-copy");
        const note = document.getElementById("ttia-note");

        if (summary) summary.innerHTML = buildSummaryHtml();
        if (memberRows) memberRows.innerHTML = buildMemberRows();
        if (attackerRows) attackerRows.innerHTML = buildAttackerRows();
        if (matrix) matrix.innerHTML = buildMatrixHtml();
        if (copyBtn) copyBtn.disabled = state.members.length === 0;

        if (done && note) {
            const unresolved = state.unresolvedCommands + state.failedCommands;
            const warnings = [];
            if (state.profileFailures) warnings.push(state.profileFailures + " failed member profile request" + (state.profileFailures === 1 ? "" : "s"));
            if (state.villageFailures) warnings.push(state.villageFailures + " failed village request" + (state.villageFailures === 1 ? "" : "s"));
            if (unresolved) warnings.push(unresolved + " unresolved Origin" + (unresolved === 1 ? "" : "s"));
            const incompleteMembers = state.members.filter(member => !member.profileComplete && member.expectedVillages > 0).length;
            if (incompleteMembers) warnings.push(incompleteMembers + " member profile" + (incompleteMembers === 1 ? "" : "s") + " with incomplete village discovery");

            if (warnings.length) {
                note.classList.add("ttia-warning");
                note.textContent = "Scan completed with warnings: " + warnings.join("; ") + ". Target attack totals may be partial where village discovery or village requests failed.";
            } else {
                note.classList.remove("ttia-warning");
                note.textContent = "Scan complete. Every recognized incoming attack was matched to an Origin player. " +
                    state.networkCommandRequests + " command-detail request" + (state.networkCommandRequests === 1 ? "" : "s") +
                    " were needed; " + (state.directOriginHits + state.cacheHits) + " attack" + ((state.directOriginHits + state.cacheHits) === 1 ? "" : "s") +
                    " were resolved without an extra command-detail request. Final request rate: ~" + getCurrentRequestRate().toFixed(1) +
                    "/s" + (state.rateBackoffs ? " after " + state.rateBackoffs + " automatic backoff" + (state.rateBackoffs === 1 ? "" : "s") : " (no backoff needed)") + ".";
            }
        }
    }

    function scheduleResultsUpdate() {
        if (uiRefreshTimer || state.stopped) return;
        uiRefreshTimer = setTimeout(() => {
            uiRefreshTimer = null;
            if (!state.stopped) updateResults(false);
        }, UI_REFRESH_MS);
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

    async function copyFullReport() {
        try {
            await copyText(buildCopyText());
            notify("success", "Full tribe incoming report copied.");
        } catch (err) {
            notify("error", "Could not copy the report.");
        }
    }

    // ---------- Main ----------

    async function run() {
        if (!isTribeInfoPage()) {
            notify("error", SCRIPT_NAME + " must be run from a Tribe Info page (screen=info_ally).");
            return;
        }

        state.tribeName = getTribeName();
        state.members = parseMembers();
        state.members.forEach(member => state.memberMap.set(member.id, member));
        state.totalExpectedVillages = state.members.reduce((sum, member) => sum + member.expectedVillages, 0);

        createWidget();
        updateResults(false);

        if (!state.members.length) {
            updateProgress(0, 0, "Could not find tribe members.");
            notify("error", "Could not find the tribe member table on this page.");
            return;
        }

        notify("success", "Scanning " + state.members.length + " tribe members...");

        // Step 1: discover every member's villages and which villages show incomings.
        updateProgress(0, state.members.length, "Step 1/3: Reading member village lists...");

        await runPool(
            state.members,
            PROFILE_CONCURRENCY,
            async member => {
                if (state.stopped) return;
                try {
                    await scanMemberProfile(member);
                } catch (err) {
                    state.profileFailures += 1;
                    member.profileWarning = "Profile scan failed";
                    console.error("[" + SCRIPT_NAME + "] Failed profile scan", member, err);
                }
            },
            completed => {
                state.profilesDone = completed;
                updateProgress(completed, state.members.length, "Step 1/3: Reading member village lists...");
                scheduleResultsUpdate();
            }
        );

        if (state.stopped) return;

        // Step 2: fetch only villages that the profiles mark as having incomings.
        updateProgress(0, state.attackedVillages.length, "Step 2/3: Scanning incoming commands...");

        await runPool(
            state.attackedVillages,
            VILLAGE_CONCURRENCY,
            async village => {
                if (state.stopped) return;
                try {
                    const html = await fetchHtml(village.url);
                    state.pendingCommands.push(...parseVillageCommands(html, village));
                } catch (err) {
                    state.villageFailures += 1;
                    console.error("[" + SCRIPT_NAME + "] Failed village scan", village, err);
                }
            },
            completed => {
                state.villagesDone = completed;
                updateProgress(completed, state.attackedVillages.length, "Step 2/3: Scanning incoming commands...");
                scheduleResultsUpdate();
            }
        );

        if (state.stopped) return;

        // Step 3: resolve correct Origin player for commands that could not be
        // identified directly or from the shared command cache.
        updateProgress(0, state.pendingCommands.length, "Step 3/3: Resolving Origin players...");

        await runPool(
            state.pendingCommands,
            COMMAND_CONCURRENCY,
            async attack => {
                if (state.stopped) return;
                try {
                    const attacker = await resolveCommandAttacker(attack);
                    if (attacker) {
                        addAttackToAttacker(attacker, attack);
                    } else {
                        state.unresolvedCommands += 1;
                        console.warn("[" + SCRIPT_NAME + "] Could not resolve Origin for command", attack.commandId);
                    }
                } catch (err) {
                    state.failedCommands += 1;
                    console.error("[" + SCRIPT_NAME + "] Failed command detail", attack.commandId, err);
                }
            },
            completed => {
                state.commandsDone = completed;
                updateProgress(completed, state.pendingCommands.length, "Step 3/3: Resolving Origin players...");
                scheduleResultsUpdate();
            }
        );

        if (state.stopped) return;

        if (uiRefreshTimer) {
            clearTimeout(uiRefreshTimer);
            uiRefreshTimer = null;
        }

        saveCommandCache();
        updateResults(true);

        const unresolved = state.unresolvedCommands + state.failedCommands;
        const warning = state.profileFailures || state.villageFailures || unresolved || state.members.some(member => !member.profileComplete && member.expectedVillages > 0);
        const finalTotal = state.pendingCommands.length || state.attackedVillages.length || state.members.length;
        updateProgress(finalTotal, finalTotal, warning ? "Completed with warnings" : "Scan complete");

        notify(
            warning ? "info" : "success",
            "Tribe scan complete: " + formatNumber(state.totals.attacks) + " attacks against " +
            formatNumber(state.members.filter(member => member.counts.attacks > 0).length) + " tribe members, from " +
            formatNumber(state.attackers.size) + " resolved Origin players."
        );
    }

    run().catch(err => {
        console.error("[" + SCRIPT_NAME + "]", err);
        notify("error", SCRIPT_NAME + " failed. Check the browser console for details.");
        const status = document.getElementById("ttia-status");
        if (status) status.textContent = "Scan failed";
    });
})();
