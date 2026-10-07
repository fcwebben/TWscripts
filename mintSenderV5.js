/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Smart Mint Resource Sender
 *
 * Creates manual resource transfer plans toward one final target village, or
 * toward multiple saved mint villages mapped to separate Tribal Wars village groups.
 *
 * This script:
 * - Reads production overview data for the current group in single-target mode
 * - Supports a saved multi-mint mode where each configured village group routes to its own mint village
 * - Reads wood, clay, iron, warehouse capacity and available merchants
 * - Resolves one user-entered final target coordinate
 * - Sends villages inside the configured direct radius straight to that target
 * - Uses distance, warehouse fullness, merchant availability and receiver balance to choose direct sends or relays
 * - Requires every relay village to be closer to the final target than its origin
 * - Uses the configured field radius as the maximum relay-hop distance
 * - Determines warehouse fullness from the fullest individual resource, not an average
 * - Uses the 28,000 / 30,000 / 25,000 wood/clay/iron proportional ratio for direct sends
 * - Simulates planned relay incoming resources before choosing later relay destinations
 * - Uses one shared network limiter for all script-started GET/POST traffic
 * - Groups planned transfers by destination and uses one manual market request per target village
 * - Skips any planned transfer below 900 total resources so every send uses at least one meaningful merchant load
 * - Supports TribalWars.scriptData settings input when enabled in the Script Library
 *
 * Routing overview:
 * - Villages inside the direct radius send straight to the configured mint village
 * - Villages farther away first try to move resources through a useful village closer to the mint
 * - High/full origins favor relay receivers with warehouse room, with available merchants preferred
 * - Resource-imbalanced receivers can be used when they have useful room for the origin's fullest resources
 * - A relay receiver must stay below the configured safe warehouse ceiling
 * - If no useful relay is available, the remaining resources may be requested directly to the mint village
 *
 * Important warehouse rule:
 *   WH% = max(wood, clay, iron) / warehouse capacity.
 *   Example: 30k wood, 20k clay, 350k iron in a 400k warehouse = 87.5% WH.
 *
 * Direct-send ratio:
 *   Wood  = 28,000 / 83,000
 *   Clay  = 30,000 / 83,000
 *   Iron  = 25,000 / 83,000
 *   If one resource cannot support its share, all three are scaled down together
 *   so the direct shipment keeps the same ratio.
 *
 * This script does NOT:
 * - Send attacks, support, or troops
 * - Automatically request every planned target
 * - Auto-click game actions
 * - Use external servers or external files
 * - Treat planned relay incoming resources as instantly available for another outgoing hop
 *
 * Expected TribalWars.scriptData format:
 * {
 *   "settings": {
 *     "targetCoord": "454|598",
 *     "directRadius": 10,
 *     "keepWhPct": 0,
 *     "triggerPct": 70,
 *     "imbalanceGapPct": 15,
 *     "safeCeilingPct": 90,
 *     "multiMintEnabled": false,
 *     "multiMintCount": 2,
 *     "multiMintMappings": [
 *       { "groupId": "123", "groupName": "North", "targetCoord": "454|598" },
 *       { "groupId": "456", "groupName": "South", "targetCoord": "460|620" }
 *     ]
 *   }
 * }
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

(async function twacticsSmartResourceSender() {
    'use strict';

    const SCRIPT_NAME = 'Twactics Smart Mint Resource Sender';
    const SCRIPT_VERSION = '1.3.0';
    const SCRIPT_ID = 'twactics-smart-resource-sender';
    const STYLE_ID = 'twactics-smart-resource-sender-style';
    const DATA_VERSION = 2;
    const SETTINGS_STORAGE_KEY = 'twacticsSmartResourceSenderSettings';
    const LEGACY_STORAGE_KEY = 'smartTargetResourceRouter.settings.v2';
    const RESOURCE_KEYS = ['wood', 'stone', 'iron'];
    const MERCHANT_CAPACITY = 1000;
    const MIN_TRANSFER_TOTAL = 900;
    const MERCHANT_MINUTES_PER_FIELD = 10;
    const WORLD_CONFIG_CACHE_MS = 60 * 60 * 1000;
    const WORLD_CONFIG_STORAGE_KEY = 'twacticsSmartMintResourceSenderWorldConfig';

    // Script Library review requirement: keep script-started traffic below 5 requests/second.
    const NETWORK_MIN_INTERVAL_MS = 210;
    let networkRequestChain = Promise.resolve();
    let lastNetworkRequestStartedAt = 0;

    // Same direct-send ratio and proportional scaling logic as the referenced sender.
    const DIRECT_RATIO = {
        wood: 28000 / 83000,
        stone: 30000 / 83000,
        iron: 25000 / 83000
    };

    const MID_BAND_MAX = 18;
    const FAR_BAND_MAX = 24;
    const SIDE_DIRECT_FLOOR = 0.50;

    const DEFAULTS = {
        targetCoord: '',
        directRadius: 10,
        keepWhPct: 0,
        triggerPct: 70,
        imbalanceGapPct: 15,
        safeCeilingPct: 90,
        multiMintEnabled: false,
        multiMintCount: 2,
        multiMintMappings: []
    };

    let villages = [];
    let plan = [];
    let resolvedTarget = null;
    let multiMintTargets = [];
    let multiMintVillageSets = new Map();
    let villageGroups = [];
    let multiMintOverlapSkips = [];
    let sendLocked = false;
    let enterKeyHeld = false;
    let worldSpeed = 1;
    let planCreatedAtServerMs = 0;
    let settings;

    try {
        settings = loadSettings();
    } catch (error) {
        settings = { ...DEFAULTS };
    }

    function getWorldKey(name) {
        const world = typeof game_data !== 'undefined' && game_data.world ? game_data.world : 'world';
        return world + ':' + name;
    }

    function getCurrentVillageCoord() {
        if (typeof game_data === 'undefined' || !game_data.village) return '';

        const direct = parseCoord(game_data.village.coord || '');
        if (direct) return direct.coord;

        const x = Number(game_data.village.x);
        const y = Number(game_data.village.y);
        if (Number.isFinite(x) && Number.isFinite(y)) return x + '|' + y;

        return '';
    }

    function getScriptDataObject() {
        if (typeof TribalWars === 'undefined' || TribalWars.scriptData === undefined || TribalWars.scriptData === null) {
            return null;
        }

        if (typeof TribalWars.scriptData === 'string') {
            try {
                return JSON.parse(TribalWars.scriptData);
            } catch (error) {
                return null;
            }
        }

        return typeof TribalWars.scriptData === 'object' ? TribalWars.scriptData : null;
    }

    function loadSettings() {
        let localSettings = null;

        try {
            const raw = localStorage.getItem(getWorldKey(SETTINGS_STORAGE_KEY));
            if (raw) {
                const parsed = JSON.parse(raw);
                localSettings = parsed && parsed.settings ? parsed.settings : parsed;
            }
        } catch (error) {
        }

        // Preserve settings from the earlier prototype if the new key has not been used yet.
        if (!localSettings) {
            try {
                const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
                if (legacyRaw) localSettings = JSON.parse(legacyRaw);
            } catch (_) {}
        }

        const scriptData = getScriptDataObject();
        const scriptSettings = scriptData && scriptData.settings ? scriptData.settings : null;

        const merged = sanitizeSettings(Object.assign({}, DEFAULTS, localSettings || {}, scriptSettings || {}));
        const currentVillageCoord = getCurrentVillageCoord();

        // Normal single-target mode always starts from the village currently open.
        // Multi-mint mappings are persistent and must not be replaced by the current village.
        if (!merged.multiMintEnabled && currentVillageCoord) merged.targetCoord = currentVillageCoord;

        return merged;
    }

    function saveSettings(value) {
        const normalized = sanitizeSettings(value || DEFAULTS);
        const data = { version: DATA_VERSION, settings: normalized };

        try {
            localStorage.setItem(getWorldKey(SETTINGS_STORAGE_KEY), JSON.stringify(data));
        } catch (error) {
        }

        if (typeof TribalWars !== 'undefined') {
            const existing = getScriptDataObject() || {};
            TribalWars.scriptData = Object.assign({}, existing, data);
        }

        return normalized;
    }

    function wait(ms) {
        return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms || 0)));
    }

    function getServerNowMs() {
        if (typeof Timing !== 'undefined' && typeof Timing.getCurrentServerTime === 'function') {
            const value = Number(Timing.getCurrentServerTime());
            if (Number.isFinite(value) && value > 0) return value;
        }
        return Date.now();
    }

    function getVisibleServerClockSeconds() {
        const text = String(document.querySelector('#serverTime')?.textContent || '').trim();
        const match = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
        if (match) {
            return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        }

        const now = new Date();
        return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    }

    function formatServerClock(targetMs) {
        const nowMs = getServerNowMs();
        const serverSecondsNow = getVisibleServerClockSeconds();
        let seconds = serverSecondsNow + (Number(targetMs) - nowMs) / 1000;
        let dayOffset = Math.floor(seconds / 86400);

        seconds %= 86400;
        if (seconds < 0) {
            seconds += 86400;
            dayOffset -= 1;
        }

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const time = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');

        return dayOffset > 0 ? '+' + dayOffset + 'd ' + time : time;
    }

    async function ensureWorldSpeed() {
        const cacheKey = getWorldKey(WORLD_CONFIG_STORAGE_KEY);

        try {
            const raw = localStorage.getItem(cacheKey);
            if (raw) {
                const cached = JSON.parse(raw);
                const cachedSpeed = Number(cached?.speed);
                const cachedAt = Number(cached?.cachedAt);

                if (
                    Number.isFinite(cachedSpeed) &&
                    cachedSpeed > 0 &&
                    Number.isFinite(cachedAt) &&
                    Date.now() - cachedAt < WORLD_CONFIG_CACHE_MS
                ) {
                    worldSpeed = cachedSpeed;
                    return worldSpeed;
                }
            }
        } catch (_) {}

        try {
            const xmlText = await fetchText('/interface.php?func=get_config', 'World config');
            const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
            const parsed = Number(doc.querySelector('config > speed, speed')?.textContent);

            if (Number.isFinite(parsed) && parsed > 0) {
                worldSpeed = parsed;
                try {
                    localStorage.setItem(cacheKey, JSON.stringify({
                        speed: parsed,
                        cachedAt: Date.now()
                    }));
                } catch (_) {}
                return worldSpeed;
            }
        } catch (_) {}

        worldSpeed = 1;
        return worldSpeed;
    }

    function estimateRelayTravelMs(transfer) {
        const fields = Math.max(0, Number(transfer?.legDistance) || 0);
        const speed = Math.max(0.01, Number(worldSpeed) || 1);
        return fields * MERCHANT_MINUTES_PER_FIELD * 60 * 1000 / speed;
    }

    function runRateLimitedNetworkRequest(task, label) {
        const execute = async function () {
            const elapsed = Date.now() - lastNetworkRequestStartedAt;
            const remaining = Math.max(0, NETWORK_MIN_INTERVAL_MS - elapsed);
            if (remaining > 0) await wait(remaining);

            lastNetworkRequestStartedAt = Date.now();
            return task();
        };

        const scheduled = networkRequestChain.then(execute, execute);
        networkRequestChain = scheduled.catch(function () {});
        return scheduled;
    }

    async function fetchText(url, label) {
        const response = await runRateLimitedNetworkRequest(function () {
            return fetch(url, {
                method: 'GET',
                credentials: 'same-origin',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'text/html, application/json, */*; q=0.01'
                }
            });
        }, label || ('GET ' + url));

        if (!response.ok) {
            throw new Error('HTTP ' + response.status + ' while loading ' + url);
        }

        return response.text();
    }

    function getCsrfToken() {
        if (typeof window.csrf_token !== 'undefined' && window.csrf_token) return window.csrf_token;
        if (typeof game_data !== 'undefined' && game_data.csrf) return game_data.csrf;

        const input = document.querySelector('input[name="h"]');
        return input ? input.value : '';
    }

    function responseHasError(response) {
        if (!response) return false;
        return Boolean(response.error || response.errors || response.warning || response.warnings);
    }

    function getResponseMessage(response, fallback) {
        if (!response) return fallback;
        return response.success || response.message || response.error || response.warning || fallback;
    }

    function postMarketRequest(targetId, payload) {
        const options = {
            village: targetId,
            ajaxaction: 'call'
        };

        const csrf = getCsrfToken();
        if (csrf) options.h = csrf;

        return runRateLimitedNetworkRequest(function () {
            return new Promise((resolve, reject) => {
                let settled = false;

                const finishResolve = value => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeoutId);
                    resolve(value);
                };

                const finishReject = error => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeoutId);
                    reject(error);
                };

                // Never leave the UI permanently locked if Tribal Wars fails to
                // invoke either callback. The user can safely refresh the plan
                // before retrying after a timeout.
                const timeoutId = window.setTimeout(() => {
                    finishReject(new Error('Market request timed out after 15 seconds.'));
                }, 15000);

                try {
                    TribalWars.post(
                        'market',
                        options,
                        payload,
                        response => {
                            if (responseHasError(response)) {
                                finishReject(response);
                                return;
                            }
                            finishResolve(response);
                        },
                        error => finishReject(error)
                    );
                } catch (error) {
                    finishReject(error);
                }
            });
        }, 'POST market call');
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function parseNumber(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
        const digits = String(value ?? '').replace(/[^0-9]/g, '');
        return digits ? Number(digits) : 0;
    }

    function fmt(value) {
        return Math.floor(Number(value) || 0).toLocaleString('en-US');
    }

    function pct(value) {
        return `${(Number(value) * 100).toFixed(1)}%`;
    }

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
    }

    function parseCoord(coord) {
        const match = String(coord || '').match(/(\d+)\|(\d+)/);
        if (!match) return null;
        return { coord: `${match[1]}|${match[2]}`, x: Number(match[1]), y: Number(match[2]) };
    }

    function distance(a, b) {
        return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
    }

    function maxFill(village) {
        const wh = Math.max(1, Number(village.warehouse) || 1);
        return Math.max(village.wood / wh, village.stone / wh, village.iron / wh);
    }

    function projectedValue(village, key) {
        return Number(village[`projected_${key}`] ?? village[key] ?? 0);
    }

    function maxProjectedFill(village) {
        const wh = Math.max(1, Number(village.warehouse) || 1);
        return Math.max(...RESOURCE_KEYS.map(key => projectedValue(village, key) / wh));
    }

    function projectedImbalance(village) {
        const wh = Math.max(1, Number(village.warehouse) || 1);
        const ratios = RESOURCE_KEYS.map(key => projectedValue(village, key) / wh);
        return Math.max(...ratios) - Math.min(...ratios);
    }

    function totalResources(amount) {
        return RESOURCE_KEYS.reduce((sum, key) => sum + Math.max(0, Number(amount[key]) || 0), 0);
    }

    function getCurrentGroupId() {
        const currentParams = new URLSearchParams(location.search);
        const group = currentParams.get('group');
        if (group !== null && group !== '') return String(group);
        if (game_data?.group_id !== undefined && game_data?.group_id !== null && game_data.group_id !== '') {
            return String(game_data.group_id);
        }
        return '';
    }

    function buildOverviewUrl(groupId) {
        const sitter = Number(game_data?.player?.sitter || 0) > 0;
        const sitterPart = sitter ? `t=${encodeURIComponent(game_data.player.id)}&` : '';
        const selectedGroup = groupId === undefined || groupId === null ? getCurrentGroupId() : String(groupId);
        const groupPart = selectedGroup !== '' ? `&group=${encodeURIComponent(selectedGroup)}` : '';
        return `game.php?${sitterPart}screen=overview_villages&mode=prod&page=-1${groupPart}`;
    }

    function mergeVillageGroupsFromDocument(doc) {
        const found = new Map(villageGroups.map(group => [String(group.id), group]));

        function addGroup(id, name) {
            if (id === undefined || id === null || String(id) === '') return;
            const key = String(id);
            const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
            if (!found.has(key) || (cleanName && /^Group\s+\d+$/i.test(found.get(key).name || ''))) {
                found.set(key, {
                    id: key,
                    name: cleanName || (key === '0' ? 'All villages' : 'Group ' + key)
                });
            }
        }

        const currentGroupId = getCurrentGroupId();
        if (currentGroupId) addGroup(currentGroupId, 'Current group');

        const scope = doc || document;

        scope.querySelectorAll('select').forEach(select => {
            const marker = ((select.name || '') + ' ' + (select.id || '') + ' ' + (select.className || '')).toLowerCase();
            if (!marker.includes('group')) return;

            select.querySelectorAll('option').forEach(option => {
                const value = option.value;
                if (/^\d+$/.test(String(value || ''))) addGroup(value, option.textContent);
            });
        });

        scope.querySelectorAll('a[href*="group="]').forEach(link => {
            try {
                const url = new URL(link.getAttribute('href'), location.origin);
                const id = url.searchParams.get('group');
                if (id !== null && /^\d+$/.test(id)) addGroup(id, link.textContent);
            } catch (_) {}
        });

        if (!found.has('0')) found.set('0', { id: '0', name: 'All villages' });

        villageGroups = Array.from(found.values()).sort((a, b) => {
            if (a.id === '0') return 1;
            if (b.id === '0') return -1;
            return (a.name || '').localeCompare(b.name || '') || Number(a.id) - Number(b.id);
        });

        return villageGroups;
    }

    async function loadVillageData(groupId) {
        const selectedGroupId = groupId === undefined || groupId === null ? getCurrentGroupId() : String(groupId);
        const html = await fetchText(buildOverviewUrl(selectedGroupId), 'Production overview' + (selectedGroupId ? ' group ' + selectedGroupId : ''));
        const doc = new DOMParser().parseFromString(html, 'text/html');
        mergeVillageGroupsFromDocument(doc);

        if (doc.querySelector('.mheader.ressources')) {
            throw new Error('This version is built for desktop view. Switch to desktop view and run it again.');
        }

        const villageNodes = [...doc.querySelectorAll('.quickedit-vn')];
        if (!villageNodes.length) throw new Error('No villages found in the production overview/group.');

        const parsed = [];

        for (const vn of villageNodes) {
            const row = vn.closest('tr');
            if (!row) continue;

            const coordMatch = vn.textContent.match(/\d+\|\d+/);
            if (!coordMatch) continue;

            const woodEl = row.querySelector('.res.wood, .warn_90.wood, .warn.wood');
            const stoneEl = row.querySelector('.res.stone, .warn_90.stone, .warn.stone');
            const ironEl = row.querySelector('.res.iron, .warn_90.iron, .warn.iron');
            if (!woodEl || !stoneEl || !ironEl) continue;

            const resourceCell = ironEl.closest('td');
            const warehouseCell = resourceCell?.nextElementSibling || null;
            let merchantCell = warehouseCell?.nextElementSibling || null;
            let merchantMatch = merchantCell?.textContent.match(/(\d[\d.,]*)\s*\/\s*(\d[\d.,]*)/);

            if (!merchantMatch) {
                const marketLink = row.querySelector('a[href*="screen=market"], a[href*="market"]');
                merchantCell = marketLink?.closest('td') || merchantCell;
                merchantMatch = merchantCell?.textContent.match(/(\d[\d.,]*)\s*\/\s*(\d[\d.,]*)/);
            }

            const xy = parseCoord(coordMatch[0]);
            const warehouse = parseNumber(warehouseCell?.textContent);
            if (!xy || !warehouse || !merchantMatch) continue;

            parsed.push({
                id: String(vn.dataset.id || ''),
                name: vn.textContent.trim(),
                coord: xy.coord,
                x: xy.x,
                y: xy.y,
                url: vn.querySelector('a')?.href || '#',
                wood: parseNumber(woodEl.textContent),
                stone: parseNumber(stoneEl.textContent),
                iron: parseNumber(ironEl.textContent),
                warehouse,
                availableMerchants: parseNumber(merchantMatch[1]),
                totalMerchants: parseNumber(merchantMatch[2]),
                sourceGroupId: selectedGroupId
            });
        }

        if (!parsed.length) throw new Error('Village rows were found, but resource/warehouse/merchant data could not be parsed.');
        return parsed;
    }

    function sanitizeSettings(raw) {
        raw = raw || {};
        const target = parseCoord(raw.targetCoord);
        const rawMappings = Array.isArray(raw.multiMintMappings) ? raw.multiMintMappings : [];
        const multiMintCount = clamp(
            Number(raw.multiMintCount) || rawMappings.length || DEFAULTS.multiMintCount,
            1,
            10
        );

        const multiMintMappings = [];
        for (let index = 0; index < multiMintCount; index++) {
            const mapping = rawMappings[index] || {};
            const parsedTarget = parseCoord(mapping.targetCoord);
            multiMintMappings.push({
                groupId: mapping.groupId !== undefined && mapping.groupId !== null ? String(mapping.groupId) : '',
                groupName: String(mapping.groupName || '').trim(),
                targetCoord: parsedTarget?.coord || String(mapping.targetCoord || '').trim()
            });
        }

        return {
            targetCoord: target?.coord || String(raw.targetCoord || '').trim(),
            directRadius: clamp(Number(raw.directRadius) || DEFAULTS.directRadius, 1, 100),
            keepWhPct: clamp(Number(raw.keepWhPct) || 0, 0, 99),
            triggerPct: clamp(Number(raw.triggerPct) || DEFAULTS.triggerPct, 1, 99),
            imbalanceGapPct: clamp(Number(raw.imbalanceGapPct) || DEFAULTS.imbalanceGapPct, 1, 99),
            safeCeilingPct: clamp(Number(raw.safeCeilingPct) || DEFAULTS.safeCeilingPct, 1, 99),
            multiMintEnabled: raw.multiMintEnabled === true,
            multiMintCount,
            multiMintMappings
        };
    }

    function getMultiMintMappingsFromUi() {
        const rows = Array.from(document.querySelectorAll('.twsr-multi-row'));
        return rows.map(row => {
            const groupSelect = row.querySelector('[data-twsr-multi-group]');
            const targetInput = row.querySelector('[data-twsr-multi-target]');
            const selectedOption = groupSelect?.selectedOptions?.[0];
            return {
                groupId: String(groupSelect?.value || ''),
                groupName: String(selectedOption?.dataset?.groupName || selectedOption?.textContent || '').trim(),
                targetCoord: String(targetInput?.value || '').trim()
            };
        });
    }

    function getSettingsFromUi() {
        return sanitizeSettings({
            targetCoord: document.querySelector('#strr-target')?.value,
            directRadius: document.querySelector('#strr-radius')?.value,
            keepWhPct: document.querySelector('#strr-keep')?.value,
            triggerPct: document.querySelector('#strr-trigger')?.value,
            imbalanceGapPct: document.querySelector('#strr-imbalance')?.value,
            safeCeilingPct: document.querySelector('#strr-safe')?.value,
            multiMintEnabled: Boolean(document.querySelector('#strr-multi-enabled')?.checked),
            multiMintCount: document.querySelector('#strr-multi-count')?.value,
            multiMintMappings: getMultiMintMappingsFromUi()
        });
    }

    function cloneVillage(v) {
        return {
            ...v,
            wood: Number(v.wood),
            stone: Number(v.stone),
            iron: Number(v.iron),
            projected_wood: Number(v.wood),
            projected_stone: Number(v.stone),
            projected_iron: Number(v.iron),
            warehouse: Number(v.warehouse),
            availableMerchants: Number(v.availableMerchants)
        };
    }

    async function resolveTarget(coord, sourceVillages = villages) {
        const parsed = parseCoord(coord);
        if (!parsed) throw new Error('Enter a valid target coordinate, for example 454|598.');

        const local = sourceVillages.find(v => v.coord === parsed.coord);
        if (local) {
            return {
                id: String(local.id),
                name: local.name,
                coord: local.coord,
                x: local.x,
                y: local.y
            };
        }

        const sitter = Number(game_data?.player?.sitter || 0) > 0;
        const sitterPart = sitter ? `t=${encodeURIComponent(game_data.player.id)}&` : '';
        const url = `game.php?${sitterPart}screen=api&ajax=target_selection&input=${encodeURIComponent(parsed.coord)}&type=coord`;
        const text = await fetchText(url, 'Target village lookup');
        let data;
        try {
            data = JSON.parse(text);
        } catch (_) {
            throw new Error('Target lookup returned an unexpected response.');
        }

        const village = data?.villages?.[0];
        if (!village) throw new Error(`No village found at ${parsed.coord}.`);

        return {
            id: String(village.id),
            name: village.name || parsed.coord,
            coord: parsed.coord,
            x: Number(village.x ?? parsed.x),
            y: Number(village.y ?? parsed.y)
        };
    }

    // Exact direct-send logic: merchant capacity is first split according to
    // 28/30/25, then all three amounts are proportionally reduced whenever one
    // resource cannot support its share. This preserves the ratio on direct sends.
    function calculateDirectShipment(source, cfg) {
        const merchantCarry = Math.max(0, source.availableMerchants) * MERCHANT_CAPACITY;
        const leaveBehind = Math.floor(source.warehouse / 100 * cfg.keepWhPct);

        const local = {
            wood: Math.max(0, source.wood - leaveBehind),
            stone: Math.max(0, source.stone - leaveBehind),
            iron: Math.max(0, source.iron - leaveBehind)
        };

        let wood = merchantCarry * DIRECT_RATIO.wood;
        let stone = merchantCarry * DIRECT_RATIO.stone;
        let iron = merchantCarry * DIRECT_RATIO.iron;
        let scale = 1;

        if (wood > local.wood) {
            scale = wood > 0 ? local.wood / wood : 0;
            wood *= scale;
            stone *= scale;
            iron *= scale;
        }
        if (stone > local.stone) {
            scale = stone > 0 ? local.stone / stone : 0;
            wood *= scale;
            stone *= scale;
            iron *= scale;
        }
        if (iron > local.iron) {
            scale = iron > 0 ? local.iron / iron : 0;
            wood *= scale;
            stone *= scale;
            iron *= scale;
        }

        return {
            wood: Math.floor(Math.max(0, wood)),
            stone: Math.floor(Math.max(0, stone)),
            iron: Math.floor(Math.max(0, iron))
        };
    }

    function fillAfter(source, amount) {
        const projected = {
            ...source,
            wood: Math.max(0, source.wood - (amount.wood || 0)),
            stone: Math.max(0, source.stone - (amount.stone || 0)),
            iron: Math.max(0, source.iron - (amount.iron || 0))
        };
        return maxFill(projected);
    }

    function classifyReceiver(village, cfg) {
        const threshold = cfg.triggerPct / 100;
        const safeCeiling = cfg.safeCeilingPct / 100;
        const gap = cfg.imbalanceGapPct / 100;
        const fill = maxProjectedFill(village);
        const hasMerchants = village.availableMerchants > 0;
        const isImbalanced = projectedImbalance(village) >= gap;

        if (fill < threshold && hasMerchants) return 5;
        if (fill < threshold) return 6;
        if (isImbalanced && hasMerchants) return 7;
        if (isImbalanced) return 8;
        if (fill < safeCeiling && hasMerchants) return 9;
        if (fill < safeCeiling) return 10;
        return 99;
    }

    function receiverPriorityLabel(priority) {
        const labels = {
            5: '<70% + merchants',
            6: '<70%',
            7: 'Imbalanced + merchants',
            8: 'Imbalanced',
            9: 'Safe room + merchants',
            10: 'Safe room'
        };
        return labels[priority] || 'Unavailable';
    }

    function receiverNeed(village, priority, cfg) {
        const threshold = cfg.triggerPct / 100;
        const safeCeiling = cfg.safeCeilingPct / 100;
        const wh = village.warehouse;
        const fill = maxProjectedFill(village);
        let ceiling;

        if (priority === 5 || priority === 6) {
            ceiling = threshold;
        } else if (priority === 7 || priority === 8) {
            ceiling = Math.min(safeCeiling, Math.max(threshold, fill));
        } else {
            ceiling = safeCeiling;
        }

        return {
            wood: Math.max(0, Math.floor(wh * ceiling - projectedValue(village, 'wood'))),
            stone: Math.max(0, Math.floor(wh * ceiling - projectedValue(village, 'stone'))),
            iron: Math.max(0, Math.floor(wh * ceiling - projectedValue(village, 'iron')))
        };
    }

    function relayAvailable(source, cfg) {
        const keep = Math.floor(source.warehouse / 100 * cfg.keepWhPct);
        return {
            wood: Math.max(0, source.wood - keep),
            stone: Math.max(0, source.stone - keep),
            iron: Math.max(0, source.iron - keep)
        };
    }

    function usefulRelayAmount(source, target, priority, cfg) {
        const available = relayAvailable(source, cfg);
        const need = receiverNeed(target, priority, cfg);
        const carry = source.availableMerchants * MERCHANT_CAPACITY;
        if (carry <= 0) return 0;

        let useful = 0;
        for (const key of RESOURCE_KEYS) useful += Math.min(available[key], need[key]);
        return Math.min(carry, useful);
    }

    function allocateRelayShipment(source, target, priority, cfg) {
        let carry = source.availableMerchants * MERCHANT_CAPACITY;
        const available = relayAvailable(source, cfg);
        const need = receiverNeed(target, priority, cfg);
        const amount = { wood: 0, stone: 0, iron: 0 };

        // Prioritize the source's fullest/most urgent resource first.
        // Receiver need still acts as a hard ceiling, so we relieve overflow risk
        // without overfilling the relay village.
        const order = [...RESOURCE_KEYS].sort((a, b) => {
            const sourceWh = Math.max(1, source.warehouse);
            const ar = Math.max(0, source[a]) / sourceWh;
            const br = Math.max(0, source[b]) / sourceWh;

            if (Math.abs(ar - br) > 0.000001) return br - ar;

            // If source fullness is equal, prefer the resource for which the
            // receiver has the largest safe deficit.
            if (need[a] !== need[b]) return need[b] - need[a];

            return RESOURCE_KEYS.indexOf(a) - RESOURCE_KEYS.indexOf(b);
        });

        for (const key of order) {
            if (carry <= 0) break;
            const send = Math.floor(Math.min(carry, available[key], need[key]));
            if (send <= 0) continue;
            amount[key] = send;
            carry -= send;
        }

        return amount;
    }

    function applyOutgoing(source, amount) {
        const total = totalResources(amount);
        for (const key of RESOURCE_KEYS) {
            const sent = amount[key] || 0;
            source[key] -= sent;
            source[`projected_${key}`] = projectedValue(source, key) - sent;
        }
        const merchants = Math.ceil(total / MERCHANT_CAPACITY);
        source.availableMerchants = Math.max(0, source.availableMerchants - merchants);
        return merchants;
    }

    function applyIncoming(target, amount) {
        for (const key of RESOURCE_KEYS) {
            target[`projected_${key}`] = projectedValue(target, key) + (amount[key] || 0);
        }
    }

    function findRelayCandidate(source, state, finalTarget, allowedPriorities, cfg) {
        const sourceToTarget = distance(source, finalTarget);
        const hopRadius = cfg.directRadius;

        const candidates = state
            .filter(candidate => candidate.id !== source.id && candidate.id !== finalTarget.id)
            .map(candidate => {
                const hopDistance = distance(source, candidate);
                const candidateToTarget = distance(candidate, finalTarget);
                const priority = classifyReceiver(candidate, cfg);
                const useful = allowedPriorities.includes(priority)
                    ? usefulRelayAmount(source, candidate, priority, cfg)
                    : 0;
                return { candidate, hopDistance, candidateToTarget, priority, useful };
            })
            .filter(item =>
                allowedPriorities.includes(item.priority) &&
                item.hopDistance <= hopRadius + 1e-9 &&
                item.candidateToTarget + 1e-9 < sourceToTarget &&
                item.useful >= MIN_TRANSFER_TOTAL
            )
            .sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                // "Closer to target at all times": among the same receiver tier,
                // first maximize progress toward the final target.
                if (Math.abs(a.candidateToTarget - b.candidateToTarget) > 0.000001) {
                    return a.candidateToTarget - b.candidateToTarget;
                }
                if (Math.abs(a.hopDistance - b.hopDistance) > 0.000001) {
                    return a.hopDistance - b.hopDistance;
                }
                return b.useful - a.useful;
            });

        return candidates[0] || null;
    }

    function addDirectTransfer(transfers, source, finalTarget, rule, note, cfg) {
        const amount = calculateDirectShipment(source, cfg);
        const total = totalResources(amount);
        if (total < MIN_TRANSFER_TOTAL) return false;

        const sourceBefore = maxFill(source);
        const merchants = applyOutgoing(source, amount);
        const sourceAfter = maxFill(source);

        transfers.push({
            kind: 'direct',
            rule,
            note,
            receiverPriority: null,
            receiverLabel: 'Final target',
            sourceId: source.id,
            sourceName: source.name,
            sourceCoord: source.coord,
            sourceToTarget: distance(source, finalTarget),
            targetId: finalTarget.id,
            targetName: finalTarget.name,
            targetCoord: finalTarget.coord,
            targetToFinal: 0,
            legDistance: distance(source, finalTarget),
            wood: amount.wood,
            stone: amount.stone,
            iron: amount.iron,
            total,
            merchants,
            sourceBeforePct: sourceBefore,
            sourceAfterPct: sourceAfter,
            sent: false
        });
        return true;
    }

    function routeThroughRelays(transfers, source, state, finalTarget, rule, allowedPriorities, cfg) {
        let relayedSomething = false;
        let safety = 0;

        while (source.availableMerchants > 0 && totalResources(relayAvailable(source, cfg)) >= MIN_TRANSFER_TOTAL && safety++ < 100) {
            const choice = findRelayCandidate(source, state, finalTarget, allowedPriorities, cfg);
            if (!choice) break;

            const sourceBefore = maxFill(source);
            const receiverBefore = maxProjectedFill(choice.candidate);
            const amount = allocateRelayShipment(source, choice.candidate, choice.priority, cfg);
            const total = totalResources(amount);
            if (total < MIN_TRANSFER_TOTAL) break;

            const merchants = applyOutgoing(source, amount);
            applyIncoming(choice.candidate, amount);

            transfers.push({
                kind: 'relay',
                rule,
                note: receiverPriorityLabel(choice.priority),
                receiverPriority: choice.priority,
                receiverLabel: receiverPriorityLabel(choice.priority),
                sourceId: source.id,
                sourceName: source.name,
                sourceCoord: source.coord,
                sourceToTarget: distance(source, finalTarget),
                targetId: choice.candidate.id,
                targetName: choice.candidate.name,
                targetCoord: choice.candidate.coord,
                targetToFinal: distance(choice.candidate, finalTarget),
                legDistance: choice.hopDistance,
                wood: amount.wood,
                stone: amount.stone,
                iron: amount.iron,
                total,
                merchants,
                sourceBeforePct: sourceBefore,
                sourceAfterPct: maxFill(source),
                receiverBeforePct: receiverBefore,
                receiverAfterPct: maxProjectedFill(choice.candidate),
                sent: false
            });

            relayedSomething = true;
        }

        return relayedSomething;
    }

    function buildPlan(sourceVillages, finalTarget, cfg) {
        const state = sourceVillages.map(cloneVillage);
        const transfers = [];
        const threshold = cfg.triggerPct / 100;

        // Work from farthest to nearest so relay destinations closer to the target
        // are evaluated before their own outgoing send is planned.
        const sources = [...state]
            .filter(v => String(v.id) !== String(finalTarget.id) && v.availableMerchants > 0)
            .sort((a, b) => distance(b, finalTarget) - distance(a, finalTarget));

        for (const source of sources) {
            if (source.availableMerchants <= 0) continue;

            const distToTarget = distance(source, finalTarget);
            const beforeFill = maxFill(source);
            const hypotheticalDirect = calculateDirectShipment(source, cfg);
            const hypotheticalTotal = totalResources(hypotheticalDirect);
            if (hypotheticalTotal <= 0 && totalResources(relayAvailable(source, cfg)) <= 0) continue;

            const afterDirectFill = fillAfter(source, hypotheticalDirect);

            // Inside chosen field radius: always directly to final target.
            if (distToTarget <= cfg.directRadius + 1e-9) {
                addDirectTransfer(transfers, source, finalTarget, 'DIRECT', `Within ${cfg.directRadius} fields`, cfg);
                continue;
            }

            // Outside the direct radius, prefer a useful closer relay first.
            // The <50% side rule is now a DIRECT fallback rather than an override,
            // so distant villages do not bypass an available short relay route.
            if (afterDirectFill < SIDE_DIRECT_FLOOR) {
                const relayed = routeThroughRelays(
                    transfers,
                    source,
                    state,
                    finalTarget,
                    'SIDE',
                    [5, 6, 7, 8, 9, 10],
                    cfg
                );

                if (!relayed || source.availableMerchants > 0) {
                    addDirectTransfer(
                        transfers,
                        source,
                        finalTarget,
                        relayed ? 'SIDE' : 'DIRECT',
                        relayed
                            ? 'No more useful closer relay room -> direct remainder'
                            : 'Side rule fallback: no useful closer relay -> direct',
                        cfg
                    );
                }
                continue;
            }

            // P1/P2: outside direct radius, up to 18 fields, source currently > threshold.
            if (beforeFill > threshold && distToTarget <= MID_BAND_MAX + 1e-9) {
                if (afterDirectFill < threshold) {
                    addDirectTransfer(transfers, source, finalTarget, 'P1', `After direct: ${pct(afterDirectFill)} (<${cfg.triggerPct}%)`, cfg);
                } else {
                    const relayed = routeThroughRelays(transfers, source, state, finalTarget, 'P2', [5, 6], cfg);
                    if (!relayed || source.availableMerchants > 0) {
                        addDirectTransfer(transfers, source, finalTarget, 'P2', relayed ? 'No more P5/P6 room -> direct remainder' : 'No P5/P6 relay -> direct', cfg);
                    }
                }
                continue;
            }

            // P3/P4: 18-24 field band, source currently > threshold.
            if (beforeFill > threshold && distToTarget > MID_BAND_MAX && distToTarget <= FAR_BAND_MAX + 1e-9) {
                if (afterDirectFill >= SIDE_DIRECT_FLOOR && afterDirectFill < threshold) {
                    const relayed = routeThroughRelays(transfers, source, state, finalTarget, 'P3', [5, 6], cfg);
                    if (!relayed || source.availableMerchants > 0) {
                        addDirectTransfer(transfers, source, finalTarget, 'P3', relayed ? 'No more P5/P6 room -> direct remainder' : 'No P5/P6 relay -> direct', cfg);
                    }
                } else if (afterDirectFill >= threshold) {
                    const relayed = routeThroughRelays(transfers, source, state, finalTarget, 'P4', [5, 6], cfg);
                    if (!relayed || source.availableMerchants > 0) {
                        addDirectTransfer(transfers, source, finalTarget, 'P4', relayed ? 'No more P5/P6 room -> direct remainder' : 'No P5/P6 relay -> direct', cfg);
                    }
                } else {
                    addDirectTransfer(transfers, source, finalTarget, 'DIRECT', 'Side rule fallback', cfg);
                }
                continue;
            }

            // All other outside-radius origins use the full receiver ladder P5-P10.
            const relayed = routeThroughRelays(transfers, source, state, finalTarget, 'ROUTE', [5, 6, 7, 8, 9, 10], cfg);
            if (!relayed || source.availableMerchants > 0) {
                addDirectTransfer(transfers, source, finalTarget, relayed ? 'ROUTE' : 'DIRECT', relayed ? 'No more closer receiver room -> direct remainder' : 'No useful closer receiver -> direct', cfg);
            }
        }

        // Display relays first so the user can move far resources inward before
        // using/refreshing closer villages. Within each type, farthest sources first.
        transfers.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'relay' ? -1 : 1;
            if (Math.abs(a.sourceToTarget - b.sourceToTarget) > 0.000001) return b.sourceToTarget - a.sourceToTarget;
            return a.legDistance - b.legDistance;
        });

        return transfers;
    }

    function getStyles() {
        return `
            #${SCRIPT_ID} {
                position: fixed;
                top: 72px;
                right: 28px;
                width: 1040px;
                max-width: 96vw;
                max-height: 88vh;
                z-index: 999999;
                border: 1px solid #8f6a2f;
                border-radius: 10px;
                background: #f7ead0;
                box-shadow: 0 16px 40px rgba(0,0,0,0.38);
                color: #2e2112;
                font-family: Verdana, Arial, sans-serif;
                font-size: 12px;
                overflow: hidden;
            }
            #${SCRIPT_ID} * { box-sizing: border-box; }
            #${SCRIPT_ID} .twsr-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 11px 13px;
                background: linear-gradient(180deg, #d8b776, #bd8f43);
                border-bottom: 1px solid #8f6a2f;
                cursor: move;
            }
            #${SCRIPT_ID} .twsr-title {
                display: flex;
                flex-direction: column;
                gap: 2px;
                font-weight: bold;
                font-size: 15px;
            }
            #${SCRIPT_ID} .twsr-subtitle {
                font-size: 11px;
                font-weight: normal;
                opacity: 0.82;
            }
            #${SCRIPT_ID} .twsr-close {
                width: 24px;
                height: 24px;
                border: 1px solid #7d510f;
                background: #fff4d5;
                color: #2f1b00;
                border-radius: 5px;
                cursor: pointer;
                font-weight: bold;
            }
            #${SCRIPT_ID} .twsr-body {
                padding: 12px;
                max-height: calc(88vh - 48px);
                overflow-y: auto;
            }
            #${SCRIPT_ID} .twsr-quick-help {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-bottom: 10px;
            }
            #${SCRIPT_ID} .twsr-pill {
                padding: 5px 8px;
                background: #fff7e5;
                border: 1px solid #d0ad6a;
                border-radius: 999px;
                color: #4b3318;
                white-space: nowrap;
            }
            #${SCRIPT_ID} .twsr-panel,
            #${SCRIPT_ID} .twsr-summary-panel {
                background: #fff7e5;
                border: 1px solid #d0ad6a;
                border-radius: 8px;
                padding: 10px;
                margin-bottom: 10px;
            }
            #${SCRIPT_ID} .twsr-resource-cards {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 8px;
                margin-top: 8px;
            }
            #${SCRIPT_ID} .twsr-resource-card {
                padding: 9px;
                border: 1px solid #c8a765;
                border-radius: 8px;
                background: #fffaf0;
                box-shadow: 0 1px 0 rgba(0,0,0,0.08);
                min-width: 0;
            }
            #${SCRIPT_ID} .twsr-resource-card-head {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 7px;
            }
            #${SCRIPT_ID} .twsr-resource-card-head img {
                width: 20px;
                height: 20px;
                flex: 0 0 auto;
            }
            #${SCRIPT_ID} .twsr-resource-card-name {
                font-size: 12px;
                font-weight: bold;
            }
            #${SCRIPT_ID} .twsr-resource-card-total {
                font-size: 18px;
                font-weight: bold;
                line-height: 1.1;
                margin-bottom: 7px;
            }
            #${SCRIPT_ID} .twsr-resource-card-split {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
            }
            #${SCRIPT_ID} .twsr-resource-card-metric {
                padding: 5px 6px;
                border: 1px solid #ead8b3;
                border-radius: 6px;
                background: rgba(255,255,255,0.55);
                min-width: 0;
            }
            #${SCRIPT_ID} .twsr-resource-card-label {
                font-size: 9px;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                opacity: 0.68;
                margin-bottom: 2px;
            }
            #${SCRIPT_ID} .twsr-resource-card-value {
                font-weight: bold;
                font-size: 12px;
                overflow-wrap: anywhere;
            }
            #${SCRIPT_ID} .twsr-rerun-card {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-top: 8px;
                padding: 8px 9px;
                border: 1px solid #c8a765;
                border-radius: 8px;
                background: #fffaf0;
            }
            #${SCRIPT_ID} .twsr-rerun-label {
                font-weight: bold;
                white-space: nowrap;
            }
            #${SCRIPT_ID} .twsr-rerun-checkpoints {
                display: flex;
                flex-wrap: wrap;
                justify-content: flex-end;
                gap: 5px;
            }
            #${SCRIPT_ID} .twsr-rerun-pill {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 4px 7px;
                border: 1px solid #d4bf8f;
                border-radius: 999px;
                background: #fff7e5;
                font-size: 11px;
                white-space: nowrap;
            }
            #${SCRIPT_ID} .twsr-rerun-pill strong {
                font-size: 10px;
            }
            #${SCRIPT_ID} .twsr-finished {
                padding: 10px;
                border: 1px solid #9bc18e;
                border-radius: 8px;
                background: #dff0d8;
                margin-bottom: 10px;
            }
            #${SCRIPT_ID} .twsr-finished-title {
                font-size: 14px;
                font-weight: bold;
            }
            #${SCRIPT_ID} .twsr-grid {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 8px;
                align-items: end;
            }
            #${SCRIPT_ID} .twsr-label-row {
                display: flex;
                align-items: center;
                gap: 5px;
                margin-bottom: 4px;
            }
            #${SCRIPT_ID} .twsr-label {
                display: block;
                font-weight: bold;
                color: #3b2a18;
                white-space: nowrap;
            }
            #${SCRIPT_ID} .twsr-hint {
                font-size: 10px;
                opacity: 0.72;
                margin-top: 3px;
                min-height: 13px;
            }
            #${SCRIPT_ID} .twsr-info-button {
                width: 16px;
                height: 16px;
                border: 1px solid #b99351;
                border-radius: 50%;
                background: #fffdf7;
                color: #6d4b18;
                cursor: pointer;
                font-size: 10px;
                line-height: 14px;
                padding: 0;
                font-weight: bold;
            }
            #${SCRIPT_ID} .twsr-input,
            #${SCRIPT_ID} .twsr-select {
                width: 100%;
                padding: 6px;
                border: 1px solid #b99351;
                border-radius: 5px;
                background: #fffdf7;
                color: #2f1b00;
                outline: none;
            }
            #${SCRIPT_ID} .twsr-input:focus,
            #${SCRIPT_ID} .twsr-select:focus {
                border-color: #7d510f;
                box-shadow: 0 0 0 2px rgba(125,81,15,0.16);
            }
            #${SCRIPT_ID} .twsr-mode-panel {
                margin-bottom: 10px;
                padding: 9px;
                border: 1px solid #d0ad6a;
                border-radius: 7px;
                background: #fffaf0;
            }
            #${SCRIPT_ID} .twsr-mode-row {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            }
            #${SCRIPT_ID} .twsr-multi-config {
                margin-top: 9px;
                padding-top: 9px;
                border-top: 1px solid #ead8b3;
            }
            #${SCRIPT_ID} .twsr-multi-toolbar {
                display: grid;
                grid-template-columns: minmax(160px, 220px) 1fr;
                gap: 8px;
                align-items: end;
                margin-bottom: 8px;
            }
            #${SCRIPT_ID} .twsr-multi-row {
                display: grid;
                grid-template-columns: 52px minmax(180px, 1fr) minmax(150px, 190px);
                gap: 8px;
                align-items: end;
                padding: 7px 0;
                border-top: 1px solid #ead8b3;
            }
            #${SCRIPT_ID} .twsr-multi-row:first-child { border-top: 0; }
            #${SCRIPT_ID} .twsr-multi-index {
                font-weight: bold;
                padding-bottom: 7px;
            }
            #${SCRIPT_ID} .twsr-buttons {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 10px;
            }
            #${SCRIPT_ID} .twsr-buttons .btn,
            #${SCRIPT_ID} .twsr-table .btn {
                cursor: pointer;
                border-radius: 5px;
            }
            #${SCRIPT_ID} .twsr-primary { font-weight: bold; }
            #${SCRIPT_ID} .twsr-scriptdata-note {
                margin-top: 8px;
                padding: 7px 8px;
                border: 1px solid #d0ad6a;
                border-radius: 6px;
                background: #fffaf0;
                font-size: 10px;
                line-height: 1.35;
                color: #4b3318;
            }
            #${SCRIPT_ID} .twsr-scriptdata-note code {
                font-family: monospace;
                font-size: 10px;
                background: rgba(255,255,255,0.75);
                border: 1px solid #ead8b3;
                border-radius: 3px;
                padding: 1px 3px;
            }
            #${SCRIPT_ID} .twsr-status {
                padding: 8px;
                margin: 9px 0;
                border: 1px solid #d0ad6a;
                background: #fff7e5;
                border-radius: 7px;
                line-height: 1.35;
            }
            #${SCRIPT_ID} .twsr-status-success { background: #dff0d8; border-color: #9bc18e; }
            #${SCRIPT_ID} .twsr-status-warn { background: #fff4d5; }
            #${SCRIPT_ID} .twsr-status-error { background: #f2dede; border-color: #c99a9a; }
            #${SCRIPT_ID} .twsr-section-title {
                margin-top: 12px;
                margin-bottom: 6px;
                font-weight: bold;
                font-size: 13px;
            }
            #${SCRIPT_ID} .twsr-table-wrap {
                max-height: 440px;
                overflow: auto;
                border: 1px solid #d0ad6a;
                border-radius: 8px;
                background: #fff7e5;
            }
            #${SCRIPT_ID} .twsr-table {
                border-collapse: separate;
                border-spacing: 0;
                width: 100%;
            }
            #${SCRIPT_ID} .twsr-table th {
                background: #d4ad69;
                border-bottom: 1px solid #b99351;
                border-right: 1px solid #b99351;
                padding: 7px 6px;
                text-align: center;
                position: sticky;
                top: 0;
                z-index: 1;
                white-space: nowrap;
            }
            #${SCRIPT_ID} .twsr-table td {
                border-bottom: 1px solid #e1c999;
                border-right: 1px solid #ead8b3;
                padding: 7px 6px;
                text-align: center;
                background: #fffaf0;
                vertical-align: middle;
            }
            #${SCRIPT_ID} .twsr-table tr:nth-child(even) td { background: #f4e8cf; }
            #${SCRIPT_ID} .twsr-table tr.twsr-relay td { background: #fff3d8; }
            #${SCRIPT_ID} .twsr-left { text-align: left !important; }
            #${SCRIPT_ID} .twsr-rule { font-weight: bold; white-space: nowrap; }
            #${SCRIPT_ID} .twsr-small { font-size: 10px; opacity: 0.76; line-height: 1.3; }
            #${SCRIPT_ID} .twsr-resource-head img {
                width: 16px;
                height: 16px;
                vertical-align: middle;
                margin-right: 3px;
            }
            #${SCRIPT_ID} .twsr-empty {
                padding: 12px;
                background: #fff4d5;
                border: 1px solid #d0ad6a;
                border-radius: 8px;
                line-height: 1.45;
            }
            #${SCRIPT_ID} .twsr-footer {
                display: flex;
                justify-content: flex-end;
                align-items: center;
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px solid #d0ad6a;
                font-size: 11px;
                opacity: 0.78;
            }
            .twsr-info-overlay {
                position: fixed;
                inset: 0;
                z-index: 1000000;
                background: rgba(0,0,0,0.22);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                font-family: Verdana, Arial, sans-serif;
                font-size: 12px;
            }
            .twsr-info-dialog {
                width: min(480px, 94vw);
                background: #fff7e5;
                border: 1px solid #8f6a2f;
                border-radius: 8px;
                box-shadow: 0 12px 35px rgba(0,0,0,0.35);
                color: #2e2112;
                overflow: hidden;
            }
            .twsr-info-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 9px 10px;
                background: linear-gradient(180deg, #d8b776, #bd8f43);
                border-bottom: 1px solid #8f6a2f;
                font-weight: bold;
            }
            .twsr-info-content { padding: 11px; line-height: 1.45; white-space: pre-line; }
            .twsr-info-close {
                width: 24px;
                height: 24px;
                border: 1px solid #7d510f;
                background: #fff4d5;
                color: #2f1b00;
                border-radius: 5px;
                cursor: pointer;
                font-weight: bold;
            }
            @media (max-width: 980px) {
                #${SCRIPT_ID} { top: 50px; left: 5px; right: 5px; width: auto; }
                #${SCRIPT_ID} .twsr-grid { grid-template-columns: 1fr 1fr; }
            }
            @media (max-width: 560px) {
                #${SCRIPT_ID} .twsr-grid { grid-template-columns: 1fr; }
                #${SCRIPT_ID} .twsr-resource-cards { grid-template-columns: 1fr; }
                #${SCRIPT_ID} .twsr-rerun-card { align-items: flex-start; flex-direction: column; }
                #${SCRIPT_ID} .twsr-rerun-checkpoints { justify-content: flex-start; }
            }
        `;
    }

    function setStatus(message, type) {
        const status = document.querySelector('#twsr-status');
        if (!status) return;
        status.textContent = message || '';
        status.className = 'twsr-status';
        if (type) status.classList.add('twsr-status-' + type);
    }

    function makeDraggable(box, handle) {
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener('mousedown', function (event) {
            if (event.target.closest('.twsr-close')) return;
            dragging = true;
            const rect = box.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            box.style.left = rect.left + 'px';
            box.style.top = rect.top + 'px';
            box.style.right = 'auto';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', function (event) {
            if (!dragging) return;
            box.style.left = (event.clientX - offsetX) + 'px';
            box.style.top = (event.clientY - offsetY) + 'px';
        });

        document.addEventListener('mouseup', function () {
            dragging = false;
            document.body.style.userSelect = '';
        });
    }

    function showInfoDialog(title, body) {
        document.querySelector('.twsr-info-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'twsr-info-overlay';
        overlay.innerHTML = `
            <div class="twsr-info-dialog">
                <div class="twsr-info-head">
                    <div>${escapeHtml(title)}</div>
                    <button type="button" class="twsr-info-close">x</button>
                </div>
                <div class="twsr-info-content">${escapeHtml(body)}</div>
            </div>
        `;

        overlay.querySelector('.twsr-info-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', event => {
            if (event.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    function closeDialog() {
        document.getElementById(SCRIPT_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();
        document.querySelector('.twsr-info-overlay')?.remove();
        window.removeEventListener('keydown', handleEnterKeyDown, true);
        window.removeEventListener('keyup', handleEnterKeyUp, true);
        window.removeEventListener('blur', handleWindowBlur);
        window.twacticsSmartResourceSenderLoaded = false;
        delete window.twacticsSmartResourceSender;
    }

    function handleEnterKeyDown(event) {
        const isEnter = event.key === 'Enter' || event.which === 13;
        if (!isEnter) return;

        if (event.repeat || enterKeyHeld) {
            event.preventDefault();
            return;
        }

        const active = document.activeElement;
        if (!active || !active.classList || !active.classList.contains('twsr-send-button')) return;
        if (active.disabled || sendLocked) return;

        enterKeyHeld = true;
        event.preventDefault();
        active.click();
    }

    function handleEnterKeyUp(event) {
        if (event.key === 'Enter' || event.which === 13) enterKeyHeld = false;
    }

    function handleWindowBlur() {
        enterKeyHeld = false;
    }

    function installEnterHandler() {
        window.removeEventListener('keydown', handleEnterKeyDown, true);
        window.removeEventListener('keyup', handleEnterKeyUp, true);
        window.removeEventListener('blur', handleWindowBlur);
        window.addEventListener('keydown', handleEnterKeyDown, true);
        window.addEventListener('keyup', handleEnterKeyUp, true);
        window.addEventListener('blur', handleWindowBlur);
    }

    function fieldHtml(id, label, value, hint, infoKey, type = 'number', attrs = '') {
        return `
            <div data-twsr-field="${escapeHtml(id)}">
                <div class="twsr-label-row">
                    <label class="twsr-label" for="${id}">${escapeHtml(label)}</label>
                    <button type="button" class="twsr-info-button" data-twsr-info="${escapeHtml(infoKey)}">?</button>
                </div>
                <input class="twsr-input" id="${id}" type="${type}" value="${escapeHtml(value)}" ${attrs}>
                <div class="twsr-hint">${escapeHtml(hint)}</div>
            </div>
        `;
    }

    function getGroupName(groupId) {
        const group = villageGroups.find(item => String(item.id) === String(groupId));
        return group?.name || (String(groupId) === '0' ? 'All villages' : 'Group ' + groupId);
    }

    function groupOptionsHtml(selectedId, selectedName) {
        const selectedKey = String(selectedId || '');
        const options = villageGroups.slice();

        if (selectedKey && !options.some(group => String(group.id) === selectedKey)) {
            options.push({
                id: selectedKey,
                name: selectedName || ('Group ' + selectedKey)
            });
        }

        let html = '<option value="">Select village group...</option>';
        options.forEach(group => {
            const id = String(group.id);
            const name = group.name || ('Group ' + id);
            html += '<option value="' + escapeHtml(id) + '" data-group-name="' + escapeHtml(name) + '"' +
                (id === selectedKey ? ' selected' : '') + '>' +
                escapeHtml(name) + ' (#' + escapeHtml(id) + ')</option>';
        });
        return html;
    }

    function renderMultiMintRows(mappings, count) {
        const container = document.querySelector('#strr-multi-rows');
        if (!container) return;

        const normalizedCount = clamp(Number(count) || DEFAULTS.multiMintCount, 1, 10);
        const currentMappings = Array.isArray(mappings) ? mappings : getMultiMintMappingsFromUi();
        let html = '';

        for (let index = 0; index < normalizedCount; index++) {
            const mapping = currentMappings[index] || {};
            html += `
                <div class="twsr-multi-row" data-multi-index="${index}">
                    <div class="twsr-multi-index">#${index + 1}</div>
                    <div>
                        <label class="twsr-label">Source group</label>
                        <select class="twsr-select" data-twsr-multi-group>
                            ${groupOptionsHtml(mapping.groupId, mapping.groupName)}
                        </select>
                        <div class="twsr-hint">Villages in this group send toward the mint village on the right</div>
                    </div>
                    <div>
                        <label class="twsr-label">Mint village</label>
                        <input class="twsr-input" data-twsr-multi-target type="text"
                            value="${escapeHtml(mapping.targetCoord || '')}" placeholder="454|598">
                        <div class="twsr-hint">Final mint destination for this group</div>
                    </div>
                </div>
            `;
        }

        container.innerHTML = html;
    }

    function updateMultiMintUi() {
        const enabled = Boolean(document.querySelector('#strr-multi-enabled')?.checked);
        const config = document.querySelector('#strr-multi-config');
        const singleTarget = document.querySelector('[data-twsr-field="strr-target"]');
        if (config) config.style.display = enabled ? 'block' : 'none';
        if (singleTarget) singleTarget.style.display = enabled ? 'none' : '';
    }

    function refreshMultiMintGroupOptions() {
        const rows = Array.from(document.querySelectorAll('.twsr-multi-row'));
        rows.forEach(row => {
            const select = row.querySelector('[data-twsr-multi-group]');
            if (!select) return;
            const current = String(select.value || '');
            const currentText = select.selectedOptions?.[0]?.dataset?.groupName || select.selectedOptions?.[0]?.textContent || '';
            select.innerHTML = groupOptionsHtml(current, currentText);
            select.value = current;
        });
    }

    function persistUiSettings() {
        try {
            settings = getSettingsFromUi();
            saveSettings(settings);
        } catch (error) {
        }
    }

    function renderShell() {
        mergeVillageGroupsFromDocument(document);
        document.getElementById(SCRIPT_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = getStyles();
        document.head.appendChild(style);

        const box = document.createElement('div');
        box.id = SCRIPT_ID;

        const infoText = {
            target: 'The mint village you ultimately want the resources to reach. Villages close enough will request resources directly into this village. Villages farther away can first move resources into relay villages that are closer to the mint. In normal single-target mode this field automatically starts as the village you are currently viewing.',
            radius: 'Sets both the direct range and the maximum relay-step distance. A village inside this distance from the mint requests directly to the mint. A village farther away may use a relay, but that relay must also be within this many fields of the origin and must move the resources closer to the mint.',
            keep: 'Protects this percentage of warehouse capacity for EACH resource in every origin. Example: with a 400,000 warehouse and Keep WH% = 10, the script keeps at least 40,000 wood, 40,000 clay and 40,000 iron in the origin before planning requests.',
            trigger: 'Controls when a village is treated as highly filled. WH% is based on the single fullest resource, not the average of all three. Example: with a 400,000 warehouse and threshold 70%, a village reaches the threshold as soon as wood, clay OR iron reaches 280,000.',
            imbalance: 'Controls when a potential relay village is considered resource-imbalanced. The script compares its fullest and emptiest resource as percentages of warehouse capacity. Example: 80% wood and 60% iron is a 20 percentage-point gap.',
            safe: 'Maximum projected fill allowed for any single resource in a relay receiver. The script counts both resources already in the village and relay resources planned to arrive. Example: with a 400,000 warehouse and a 90% ceiling, no resource should be planned above 360,000.'
        };

        box.innerHTML = `
            <div class="twsr-header">
                <div class="twsr-title">
                    <span>${escapeHtml(SCRIPT_NAME + ' ' + SCRIPT_VERSION)}</span>
                    <span class="twsr-subtitle">Smart direct and relay routing for mint resources</span>
                </div>
                <button type="button" class="twsr-close">x</button>
            </div>
            <div class="twsr-body">
                <div class="twsr-quick-help">
                    <span class="twsr-pill">Single or multiple mint targets</span>
                    <span class="twsr-pill">WH% = fullest resource</span>
                    <span class="twsr-pill">Relays always move resources closer</span>
                    <span class="twsr-pill">Direct ratio 28 / 30 / 25</span>
                    <span class="twsr-pill">Minimum 900 resources / send</span>
                    <span class="twsr-pill">One manual request per target</span>
                </div>

                <div class="twsr-panel">
                    <div class="twsr-mode-panel">
                        <div class="twsr-mode-row">
                            <label>
                                <input id="strr-multi-enabled" type="checkbox" ${settings.multiMintEnabled ? 'checked' : ''}>
                                <strong>Multiple mint villages</strong>
                            </label>
                            <span class="twsr-small">Assign one Tribal Wars village group to each mint village. The setup is saved automatically per world.</span>
                        </div>
                        <div id="strr-multi-config" class="twsr-multi-config">
                            <div class="twsr-multi-toolbar">
                                <div>
                                    <label class="twsr-label" for="strr-multi-count">Number of mint villages</label>
                                    <input id="strr-multi-count" class="twsr-input" type="number" min="1" max="10" step="1"
                                        value="${escapeHtml(settings.multiMintCount)}">
                                    <div class="twsr-hint">1-10 mappings</div>
                                </div>
                                <div class="twsr-small">
                                    If selected groups overlap, a village is only used by the first mapping that contains it. This prevents the same village from being planned twice.
                                </div>
                            </div>
                            <div id="strr-multi-rows"></div>
                        </div>
                    </div>

                    <div class="twsr-grid">
                        ${fieldHtml('strr-target', 'Target village', settings.targetCoord, 'XXX|YYY', 'target', 'text', 'placeholder="454|598"')}
                        ${fieldHtml('strr-radius', 'Direct / relay radius', settings.directRadius, 'fields', 'radius', 'number', 'min="1" max="100" step="1"')}
                        ${fieldHtml('strr-keep', 'Keep WH% behind', settings.keepWhPct, '% per resource', 'keep', 'number', 'min="0" max="99" step="1"')}
                        ${fieldHtml('strr-trigger', 'WH threshold', settings.triggerPct, '% fullest resource', 'trigger', 'number', 'min="1" max="99" step="1"')}
                        ${fieldHtml('strr-imbalance', 'Imbalance gap', settings.imbalanceGapPct, 'percentage points', 'imbalance', 'number', 'min="1" max="99" step="1"')}
                        ${fieldHtml('strr-safe', 'Safe receiver ceiling', settings.safeCeilingPct, '% fullest resource', 'safe', 'number', 'min="1" max="99" step="1"')}
                    </div>

                    <div class="twsr-buttons">
                        <button id="strr-build" type="button" class="btn twsr-primary">Create plan</button>
                        <button id="strr-refresh" type="button" class="btn">Refresh village data</button>
                    </div>

                    <div class="twsr-scriptdata-note">
                        <strong>User data:</strong> Supports <code>TribalWars.scriptData</code>. Settings are also saved locally per world. The expected JSON format is documented at the top of the script.
                    </div>
                </div>

                <div id="twsr-status" class="twsr-status">Loading village data...</div>
                <div id="strr-output"></div>
                <div class="twsr-footer">Created by Twactics (zidrox)</div>
            </div>
        `;

        document.body.appendChild(box);
        box.querySelector('.twsr-close').addEventListener('click', closeDialog);
        box.querySelector('#strr-build').addEventListener('click', generateFromUi);
        box.querySelector('#strr-refresh').addEventListener('click', () => refreshData(true));

        renderMultiMintRows(settings.multiMintMappings, settings.multiMintCount);
        updateMultiMintUi();

        box.querySelector('#strr-multi-enabled').addEventListener('change', () => {
            updateMultiMintUi();
            persistUiSettings();
        });

        box.querySelector('#strr-multi-count').addEventListener('change', event => {
            const existing = getMultiMintMappingsFromUi();
            const count = clamp(Number(event.target.value) || DEFAULTS.multiMintCount, 1, 10);
            event.target.value = String(count);
            renderMultiMintRows(existing, count);
            persistUiSettings();
        });

        box.querySelector('#strr-multi-rows').addEventListener('change', persistUiSettings);
        box.querySelector('#strr-multi-rows').addEventListener('input', persistUiSettings);
        box.querySelectorAll('[data-twsr-info]').forEach(button => {
            button.addEventListener('click', () => {
                const key = button.dataset.twsrInfo;
                const label = button.parentElement?.querySelector('.twsr-label')?.textContent || 'Information';
                showInfoDialog(label, infoText[key] || '');
            });
        });
        box.addEventListener('click', async event => {
            const button = event.target.closest('[data-strr-request-target]');
            if (!button) return;
            await executeTargetRequest(button.dataset.strrRequestTarget, button);
        });

        ['#strr-target', '#strr-radius', '#strr-keep', '#strr-trigger', '#strr-imbalance', '#strr-safe'].forEach(selector => {
            const input = box.querySelector(selector);
            if (!input) return;
            input.addEventListener('change', persistUiSettings);
        });

        makeDraggable(box, box.querySelector('.twsr-header'));
        installEnterHandler();

        window.twacticsSmartResourceSender = {
            close: closeDialog,
            refresh: () => refreshData(true),
            createPlan: generateFromUi,
            getPlan: () => plan.slice(),
            getRequestGroups: () => groupTransfersByTarget(plan),
            getVillages: () => villages.slice(),
            getVillageGroups: () => villageGroups.slice(),
            getMultiMintTargets: () => multiMintTargets.slice()
        };
    }

    function validateMultiMintMappings(cfg) {
        const mappings = (cfg.multiMintMappings || []).slice(0, cfg.multiMintCount);
        if (!mappings.length) throw new Error('Add at least one multi-mint mapping.');

        const seenGroups = new Set();

        mappings.forEach((mapping, index) => {
            if (!mapping.groupId) {
                throw new Error('Select a source group for mint #' + (index + 1) + '.');
            }
            if (!parseCoord(mapping.targetCoord)) {
                throw new Error('Enter a valid mint coordinate for mint #' + (index + 1) + '.');
            }
            if (seenGroups.has(String(mapping.groupId))) {
                throw new Error('The same source group is selected more than once. Each group can only map to one mint village.');
            }
            seenGroups.add(String(mapping.groupId));
        });

        return mappings;
    }

    async function loadMultiMintVillageSets(cfg, showProgress = true) {
        const mappings = validateMultiMintMappings(cfg);
        const sets = new Map();
        const allVillages = [];
        const seenVillageIds = new Set();
        const overlapSkips = [];

        for (let index = 0; index < mappings.length; index++) {
            const mapping = mappings[index];
            if (showProgress) {
                setStatus(
                    'Loading group ' + (index + 1) + '/' + mappings.length + ': ' +
                    (mapping.groupName || getGroupName(mapping.groupId)) + '...',
                    'warn'
                );
            }

            const loaded = await loadVillageData(mapping.groupId);
            const assigned = [];

            loaded.forEach(village => {
                const key = String(village.id || village.coord);
                if (seenVillageIds.has(key)) {
                    overlapSkips.push({
                        villageId: village.id,
                        coord: village.coord,
                        skippedGroupId: mapping.groupId,
                        skippedGroupName: mapping.groupName || getGroupName(mapping.groupId),
                        reason: 'Village already assigned to an earlier multi-mint mapping'
                    });
                    return;
                }

                seenVillageIds.add(key);
                village.sourceGroupId = String(mapping.groupId);
                village.sourceGroupName = mapping.groupName || getGroupName(mapping.groupId);
                assigned.push(village);
                allVillages.push(village);
            });

            sets.set(String(mapping.groupId), assigned);
        }

        multiMintVillageSets = sets;
        multiMintOverlapSkips = overlapSkips;
        villages = allVillages;
        refreshMultiMintGroupOptions();

        return sets;
    }

    async function generateMultiMintPlan(cfg) {
        const mappings = validateMultiMintMappings(cfg);
        const sets = await loadMultiMintVillageSets(cfg, true);
        const combinedPlan = [];
        const targets = [];

        for (let index = 0; index < mappings.length; index++) {
            const mapping = mappings[index];
            const groupVillages = sets.get(String(mapping.groupId)) || [];

            if (!groupVillages.length) {
                continue;
            }

            setStatus(
                'Planning mint ' + (index + 1) + '/' + mappings.length + ': ' +
                (mapping.groupName || getGroupName(mapping.groupId)) + ' -> ' + mapping.targetCoord + '...',
                'warn'
            );

            const target = await resolveTarget(mapping.targetCoord, groupVillages);
            const groupPlan = buildPlan(groupVillages, target, cfg);

            groupPlan.forEach(transfer => {
                transfer.multiMintIndex = index;
                transfer.sourceGroupId = String(mapping.groupId);
                transfer.sourceGroupName = mapping.groupName || getGroupName(mapping.groupId);
                transfer.finalTargetId = target.id;
                transfer.finalTargetCoord = target.coord;
                transfer.finalTargetName = target.name;
            });

            targets.push({
                index,
                groupId: String(mapping.groupId),
                groupName: mapping.groupName || getGroupName(mapping.groupId),
                target,
                villageCount: groupVillages.length,
                transferCount: groupPlan.length
            });

            combinedPlan.push(...groupPlan);
        }

        combinedPlan.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'relay' ? -1 : 1;
            if ((a.multiMintIndex || 0) !== (b.multiMintIndex || 0)) return (a.multiMintIndex || 0) - (b.multiMintIndex || 0);
            if (Math.abs(a.sourceToTarget - b.sourceToTarget) > 0.000001) return b.sourceToTarget - a.sourceToTarget;
            return a.legDistance - b.legDistance;
        });

        resolvedTarget = null;
        multiMintTargets = targets;
        plan = combinedPlan;
    }

    async function generateFromUi() {
        const output = document.querySelector('#strr-output');
        const buildButton = document.querySelector('#strr-build');

        try {
            if (buildButton) buildButton.disabled = true;
            settings = getSettingsFromUi();
            settings = saveSettings(settings);

            if (settings.multiMintEnabled) {
                setStatus('Loading configured groups and creating multi-mint routing plan...', 'warn');
                await generateMultiMintPlan(settings);
            } else {
                multiMintTargets = [];
                multiMintVillageSets = new Map();
                multiMintOverlapSkips = [];
                setStatus('Resolving target village and creating routing plan...', 'warn');
                resolvedTarget = await resolveTarget(settings.targetCoord, villages);
                plan = buildPlan(villages, resolvedTarget, settings);
            }

            planCreatedAtServerMs = getServerNowMs();
            if (plan.some(item => item.kind === 'relay')) {
                await ensureWorldSpeed();
            }

            renderPlan();

            const targetCount = settings.multiMintEnabled ? multiMintTargets.length : 1;
            setStatus(
                'Plan ready: ' + plan.length + ' transfer(s) from ' +
                new Set(plan.map(item => item.sourceId)).size + ' origin village(s) toward ' +
                targetCount + ' mint target(s).',
                'success'
            );
        } catch (error) {
            setStatus(error && error.message ? error.message : String(error), 'error');
            if (output) output.innerHTML = '';
        } finally {
            if (buildButton) buildButton.disabled = false;
        }
    }

    function emptyResourceSummary() {
        return { wood: 0, stone: 0, iron: 0 };
    }

    function addTransferToResourceSummary(summary, transfer) {
        summary.wood += Math.max(0, Number(transfer.wood) || 0);
        summary.stone += Math.max(0, Number(transfer.stone) || 0);
        summary.iron += Math.max(0, Number(transfer.iron) || 0);
        return summary;
    }

    function buildResourceSplit(sentOnly = false) {
        const direct = emptyResourceSummary();
        const relay = emptyResourceSummary();

        plan.forEach(transfer => {
            if (sentOnly && !transfer.sent) return;
            addTransferToResourceSummary(transfer.kind === 'relay' ? relay : direct, transfer);
        });

        return { direct, relay };
    }

    function resourceMetricCardHtml(key, label, image, split) {
        const direct = Math.max(0, Number(split.direct[key]) || 0);
        const relay = Math.max(0, Number(split.relay[key]) || 0);
        const total = direct + relay;

        return `
            <div class="twsr-resource-card">
                <div class="twsr-resource-card-head">
                    <img src="${image}" alt="${escapeHtml(label)}">
                    <span class="twsr-resource-card-name">${escapeHtml(label)}</span>
                </div>
                <div class="twsr-resource-card-total">${fmt(total)}</div>
                <div class="twsr-resource-card-split">
                    <div class="twsr-resource-card-metric">
                        <div class="twsr-resource-card-label">Direct</div>
                        <div class="twsr-resource-card-value">${fmt(direct)}</div>
                    </div>
                    <div class="twsr-resource-card-metric">
                        <div class="twsr-resource-card-label">Relay</div>
                        <div class="twsr-resource-card-value">${fmt(relay)}</div>
                    </div>
                </div>
            </div>
        `;
    }

    function resourceCardsHtml(sentOnly = false) {
        const split = buildResourceSplit(sentOnly);
        return '<div class="twsr-resource-cards">' +
            resourceMetricCardHtml('wood', 'Wood', '/graphic/holz.png', split) +
            resourceMetricCardHtml('stone', 'Clay', '/graphic/lehm.png', split) +
            resourceMetricCardHtml('iron', 'Iron', '/graphic/eisen.png', split) +
        '</div>';
    }

    function getRelayArrivalCheckpoints(sentOnly = false) {
        const relays = plan.filter(transfer =>
            transfer.kind === 'relay' &&
            (!sentOnly || transfer.sent)
        );

        if (!relays.length) return [];

        const fallbackBase = planCreatedAtServerMs || getServerNowMs();
        const arrivals = relays.map(transfer => {
            const base = Number(transfer.sentAtServerMs) || fallbackBase;
            return Number(transfer.estimatedArrivalAtServerMs) || (base + estimateRelayTravelMs(transfer));
        }).sort((a, b) => a - b);

        return [
            { pct: 33, index: Math.max(0, Math.ceil(arrivals.length * 0.33) - 1) },
            { pct: 66, index: Math.max(0, Math.ceil(arrivals.length * 0.66) - 1) },
            { pct: 100, index: arrivals.length - 1 }
        ].map(item => ({
            pct: item.pct,
            arrival: arrivals[item.index]
        }));
    }

    function rerunScheduleHtml(sentOnly = false) {
        const checkpoints = getRelayArrivalCheckpoints(sentOnly);

        if (!checkpoints.length) {
            return `
                <div class="twsr-rerun-card">
                    <div class="twsr-rerun-label">Run again</div>
                    <div class="twsr-small">No relay step needed</div>
                </div>
            `;
        }

        return `
            <div class="twsr-rerun-card">
                <div class="twsr-rerun-label">Run again</div>
                <div class="twsr-rerun-checkpoints">
                    ${checkpoints.map(item =>
                        '<span class="twsr-rerun-pill" title="Estimated relay arrival based on world speed">' +
                            '<strong>' + item.pct + '%</strong>' +
                            '<span>~' + escapeHtml(formatServerClock(item.arrival)) + '</span>' +
                        '</span>'
                    ).join('')}
                </div>
            </div>
        `;
    }

    function renderFinishedSummary() {
        const output = document.querySelector('#strr-output');
        if (!output) return;

        output.innerHTML = `
            <div class="twsr-finished">
                <div class="twsr-finished-title">Finished sending</div>
            </div>
            <div class="twsr-summary-panel">
                ${resourceCardsHtml(true)}
                ${rerunScheduleHtml(true)}
            </div>
        `;

        setStatus('Finished sending. All requests in this plan are complete.', 'success');
        if (window.UI?.SuccessMessage) {
            UI.SuccessMessage('Finished sending.');
        }
    }

    function groupTransfersByTarget(transfers) {
        const groups = new Map();

        (transfers || []).forEach((transfer, transferIndex) => {
            if (!transfer || transfer.sent) return;

            const key = String(transfer.targetId);
            if (!groups.has(key)) {
                groups.set(key, {
                    targetId: transfer.targetId,
                    targetCoord: transfer.targetCoord,
                    targetName: transfer.targetName,
                    transfers: [],
                    wood: 0,
                    stone: 0,
                    iron: 0,
                    total: 0,
                    merchants: 0,
                    maxLegDistance: 0,
                    kinds: new Set(),
                    rules: new Set()
                });
            }

            const group = groups.get(key);
            group.transfers.push({ transfer, transferIndex });
            group.wood += transfer.wood || 0;
            group.stone += transfer.stone || 0;
            group.iron += transfer.iron || 0;
            group.total += transfer.total || 0;
            group.merchants += transfer.merchants || 0;
            group.maxLegDistance = Math.max(group.maxLegDistance, transfer.legDistance || 0);
            group.kinds.add(transfer.kind || 'direct');
            group.rules.add(transfer.rule || '');
        });

        return Array.from(groups.values()).map((group, index) => ({
            ...group,
            index,
            kinds: Array.from(group.kinds),
            rules: Array.from(group.rules).filter(Boolean)
        }));
    }

    function buildCallDataForRequestGroup(group) {
        const data = {};

        group.transfers.forEach(entry => {
            const transfer = entry.transfer;
            const sourceId = transfer.sourceId;

            const woodKey = 'resource[' + sourceId + '][wood]';
            const stoneKey = 'resource[' + sourceId + '][stone]';
            const ironKey = 'resource[' + sourceId + '][iron]';

            data[woodKey] = (data[woodKey] || 0) + Math.max(0, Math.round(transfer.wood || 0));
            data[stoneKey] = (data[stoneKey] || 0) + Math.max(0, Math.round(transfer.stone || 0));
            data[ironKey] = (data[ironKey] || 0) + Math.max(0, Math.round(transfer.iron || 0));
        });

        return data;
    }

    function getRequestGroupTypeLabel(group) {
        if (!group || !group.kinds || !group.kinds.length) return '';
        if (group.kinds.length === 1) {
            return group.kinds[0] === 'relay' ? 'Relay' : 'Direct to mint';
        }
        return 'Direct + relay';
    }

    function renderPlan() {
        const output = document.querySelector('#strr-output');
        if (!output) return;
        if (!resolvedTarget && !multiMintTargets.length) return;

        const direct = plan.filter(item => item.kind === 'direct');
        const relay = plan.filter(item => item.kind === 'relay');
        const uniqueSources = new Set(plan.map(item => item.sourceId)).size;
        const requestGroups = groupTransfersByTarget(plan);

        const targetSummaryHtml = settings.multiMintEnabled
            ? '<strong>' + multiMintTargets.length + ' mint villages</strong>'
            : '<strong>' + escapeHtml(resolvedTarget.coord) + '</strong> ' + escapeHtml(resolvedTarget.name);

        let html = `
            <div class="twsr-summary-panel">
                <div>
                    ${targetSummaryHtml}
                    <span class="twsr-small"> &middot; ${uniqueSources} origins &middot; ${requestGroups.length} requests</span>
                </div>
                ${resourceCardsHtml(false)}
                ${rerunScheduleHtml(false)}
            </div>
        `;

        if (!plan.length) {
            output.innerHTML = html + '<div class="twsr-empty">No requestable resources were found with the current settings and merchant availability.</div>';
            return;
        }

        html += `
            <div class="twsr-section-title">Requests to complete</div>
            <div class="twsr-table-wrap">
                <table class="twsr-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Route</th>
                            <th>Destination</th>
                            <th>Origins</th>
                            <th>Distance</th>
                            <th class="twsr-resource-head"><img src="/graphic/holz.png" alt="Wood">Wood</th>
                            <th class="twsr-resource-head"><img src="/graphic/lehm.png" alt="Clay">Clay</th>
                            <th class="twsr-resource-head"><img src="/graphic/eisen.png" alt="Iron">Iron</th>
                            <th>Total</th>
                            <th>Merch.</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        requestGroups.forEach((group, groupIndex) => {
            const originDetails = group.transfers.map(entry => {
                const transfer = entry.transfer;
                const routeLabel = transfer.kind === 'relay'
                    ? 'Relay toward mint'
                    : 'Direct to mint';

                return '<div class="twsr-origin-line">' +
                    '<strong>' + escapeHtml(transfer.sourceCoord) + '</strong> ' +
                    '<span class="twsr-small">' + escapeHtml(transfer.sourceName) +
                    (transfer.sourceGroupName ? ' · ' + escapeHtml(transfer.sourceGroupName) : '') +
                    '</span><br>' +
                    '<span class="twsr-small">' +
                    escapeHtml(routeLabel) + ' &middot; ' +
                    fmt(transfer.wood) + '/' + fmt(transfer.stone) + '/' + fmt(transfer.iron) +
                    ' &middot; ' + transfer.legDistance.toFixed(1) + ' fields' +
                    '</span></div>';
            }).join('');

            html += `
                <tr id="strr-group-row-${escapeHtml(String(group.targetId))}" class="${group.kinds.includes('relay') ? 'twsr-relay' : ''}">
                    <td>${groupIndex + 1}</td>
                    <td><strong>${escapeHtml(getRequestGroupTypeLabel(group))}</strong></td>
                    <td class="twsr-left">
                        <strong>${escapeHtml(group.targetCoord)}</strong>
                        <div class="twsr-small">${escapeHtml(group.targetName || (resolvedTarget && group.targetCoord === resolvedTarget.coord ? 'Final target' : 'Relay target'))}</div>
                    </td>
                    <td class="twsr-left">
                        <details>
                            <summary>${group.transfers.length} origin(s)</summary>
                            <div class="twsr-origin-list">${originDetails}</div>
                        </details>
                    </td>
                    <td>${group.maxLegDistance.toFixed(1)}</td>
                    <td>${fmt(group.wood)}</td>
                    <td>${fmt(group.stone)}</td>
                    <td>${fmt(group.iron)}</td>
                    <td><strong>${fmt(group.total)}</strong></td>
                    <td>${group.merchants}</td>
                    <td><button class="btn btn-confirm-yes twsr-send-button" data-strr-request-target="${escapeHtml(String(group.targetId))}">Request</button></td>
                </tr>
            `;
        });

        html += '</tbody></table></div>';
        output.innerHTML = html;

        const firstButton = output.querySelector('.twsr-send-button:not(:disabled)');
        if (firstButton) firstButton.focus();
    }

    async function executeTargetRequest(targetId, button) {
        const requestGroups = groupTransfersByTarget(plan);
        const group = requestGroups.find(item => String(item.targetId) === String(targetId));

        if (!group || !group.transfers.length) {
            renderPlan();
            return;
        }

        if (sendLocked) {
            return;
        }

        sendLocked = true;
        document.querySelectorAll('.twsr-send-button').forEach(node => { node.disabled = true; });
        const oldText = button.textContent;
        button.textContent = 'Requesting...';

        setStatus(
            'Requesting ' + group.transfers.length + ' origin(s) into ' + group.targetCoord + '...',
            'warn'
        );

        const payload = buildCallDataForRequestGroup(group);


        try {
            const response = await postMarketRequest(group.targetId, payload);

            const sentAtServerMs = getServerNowMs();
            group.transfers.forEach(entry => {
                entry.transfer.sent = true;
                entry.transfer.sentAtServerMs = sentAtServerMs;
                if (entry.transfer.kind === 'relay') {
                    entry.transfer.estimatedArrivalAtServerMs =
                        sentAtServerMs + estimateRelayTravelMs(entry.transfer);
                }
            });

            const row = document.getElementById('strr-group-row-' + String(group.targetId));
            if (row) row.remove();

            const message = getResponseMessage(
                response,
                'Resources requested from ' + group.transfers.length + ' origin(s).'
            );


            setStatus(message, 'success');
            if (window.UI?.SuccessMessage) UI.SuccessMessage(message);
        } catch (error) {

            button.textContent = oldText;
            setStatus(
                'Request failed for ' + group.targetCoord + '. Refresh village data and create the plan again before retrying.',
                'error'
            );

            if (window.UI?.ErrorMessage) {
                UI.ErrorMessage(getResponseMessage(error, 'Could not request resources.'));
            }
        } finally {
            sendLocked = false;
            document.querySelectorAll('.twsr-send-button').forEach(node => { node.disabled = false; });
            const next = document.querySelector('.twsr-send-button:not(:disabled)');
            if (next) next.focus();
            else renderFinishedSummary();
        }
    }

    async function refreshData(showMessage = false) {
        // Refresh is also a recovery path for any stale UI lock.
        sendLocked = false;
        document.querySelectorAll('.twsr-send-button').forEach(node => { node.disabled = false; });

        const build = document.querySelector('#strr-build');
        const refresh = document.querySelector('#strr-refresh');
        if (build) build.disabled = true;
        if (refresh) refresh.disabled = true;

        try {
            settings = getSettingsFromUi();
            settings = saveSettings(settings);

            if (settings.multiMintEnabled) {
                setStatus('Refreshing all configured multi-mint source groups...', 'warn');
                await loadMultiMintVillageSets(settings, true);
                setStatus(
                    'Loaded ' + villages.length + ' unique village(s) across ' +
                    settings.multiMintCount + ' configured mint group(s).',
                    'success'
                );
            } else {
                setStatus('Loading production data for the currently selected village group...', 'warn');
                villages = await loadVillageData();
                refreshMultiMintGroupOptions();
                setStatus('Loaded ' + villages.length + ' village(s). Enter the final target and create a plan.', 'success');
            }

            if (showMessage && window.UI?.SuccessMessage) {
                UI.SuccessMessage('Loaded ' + villages.length + ' villages.');
            }

            if (showMessage) {
                if (settings.multiMintEnabled || settings.targetCoord) {
                    await generateFromUi();
                }
            }
        } catch (error) {
            setStatus(error && error.message ? error.message : String(error), 'error');
            const output = document.querySelector('#strr-output');
            if (output) output.innerHTML = '';
        } finally {
            if (build) build.disabled = false;
            if (refresh) refresh.disabled = false;
        }
    }

    try {
        document.getElementById(SCRIPT_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();
        document.querySelector('.twsr-info-overlay')?.remove();

        window.twacticsSmartResourceSenderLoaded = false;

        renderShell();

        window.twacticsSmartResourceSenderLoaded = true;

        await refreshData(false);

        const createPlanButton = document.querySelector('#strr-build');
        if (createPlanButton && !createPlanButton.disabled) createPlanButton.focus();

    } catch (error) {
        window.twacticsSmartResourceSenderLoaded = false;


        const message =
            SCRIPT_NAME +
            ' failed to start: ' +
            (error?.message || String(error));

        if (window.UI?.ErrorMessage) {
            UI.ErrorMessage(message);
        } else {
            alert(message);
        }
    }
})();
