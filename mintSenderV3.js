/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Smart Resource Sender
 *
 * Creates a manual resource transfer plan from the villages in the currently
 * selected Tribal Wars village group toward one specific final target village.
 *
 * This script:
 * - Reads production overview data for the currently selected village group
 * - Reads wood, clay, iron, warehouse capacity and available merchants
 * - Resolves one user-entered final target coordinate
 * - Sends villages inside the configured direct radius straight to that target
 * - Uses P1-P10 routing logic for villages outside the direct radius
 * - Requires every relay village to be closer to the final target than its origin
 * - Uses the configured field radius as the maximum relay-hop distance
 * - Determines warehouse fullness from the fullest individual resource, not an average
 * - Uses the 28,000 / 30,000 / 25,000 wood/clay/iron proportional ratio for direct sends
 * - Simulates planned relay incoming resources before choosing later relay destinations
 * - Uses one shared network limiter for all script-started GET/POST traffic
 * - Requires a separate manual action for every resource transfer
 * - Skips any planned transfer below 900 total resources so every send uses at least one meaningful merchant load
 * - Supports TribalWars.scriptData settings input when enabled in the Script Library
 *
 * Routing overview:
 * - <= direct radius: always DIRECT to final target
 * - Side rule: outside direct radius, if a hypothetical direct send leaves <50% WH, DIRECT
 * - P1: >70% WH, <=18 fields, hypothetical direct leaves <70% -> DIRECT
 * - P2: >70% WH, <=18 fields, hypothetical direct leaves >=70% -> P5/P6 relay, else DIRECT
 * - P3: >70% WH, 18-24 fields, hypothetical direct leaves 50-70% -> P5/P6 relay, else DIRECT
 * - P4: >70% WH, 18-24 fields, hypothetical direct leaves >=70% -> P5/P6 relay, else DIRECT
 * - Other outside-radius origins use P5-P10
 * - P5: receiver <70% WH + merchants at home
 * - P6: receiver <70% WH
 * - P7: resource-imbalanced receiver + merchants at home
 * - P8: resource-imbalanced receiver
 * - P9: receiver with safe warehouse room + merchants at home
 * - P10: receiver with safe warehouse room
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
 * - Automatically send every planned transfer
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
 *     "safeCeilingPct": 90
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

    if (window.twacticsSmartResourceSenderLoaded) {
        console.log('Twactics Smart Resource Sender already loaded');
        return;
    }

    window.twacticsSmartResourceSenderLoaded = true;

    const SCRIPT_NAME = 'Twactics Smart Resource Sender';
    const SCRIPT_VERSION = '1.0.1';
    const SCRIPT_ID = 'twactics-smart-resource-sender';
    const STYLE_ID = 'twactics-smart-resource-sender-style';
    const DATA_VERSION = 1;
    const SETTINGS_STORAGE_KEY = 'twacticsSmartResourceSenderSettings';
    const LEGACY_STORAGE_KEY = 'smartTargetResourceRouter.settings.v2';
    const RESOURCE_KEYS = ['wood', 'stone', 'iron'];
    const MERCHANT_CAPACITY = 1000;
    const MIN_TRANSFER_TOTAL = 900;

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
        safeCeilingPct: 90
    };

    let villages = [];
    let plan = [];
    let resolvedTarget = null;
    let sendLocked = false;
    let enterKeyHeld = false;
    let settings = loadSettings();

    function getWorldKey(name) {
        const world = typeof game_data !== 'undefined' && game_data.world ? game_data.world : 'world';
        return world + ':' + name;
    }

    function getScriptDataObject() {
        if (typeof TribalWars === 'undefined' || TribalWars.scriptData === undefined || TribalWars.scriptData === null) {
            return null;
        }

        if (typeof TribalWars.scriptData === 'string') {
            try {
                return JSON.parse(TribalWars.scriptData);
            } catch (error) {
                console.warn(SCRIPT_NAME + ' could not parse TribalWars.scriptData:', error);
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
            console.warn(SCRIPT_NAME + ' could not read saved settings:', error);
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

        return sanitizeSettings(Object.assign({}, DEFAULTS, localSettings || {}, scriptSettings || {}));
    }

    function saveSettings(value) {
        const normalized = sanitizeSettings(value || DEFAULTS);
        const data = { version: DATA_VERSION, settings: normalized };

        try {
            localStorage.setItem(getWorldKey(SETTINGS_STORAGE_KEY), JSON.stringify(data));
        } catch (error) {
            console.warn(SCRIPT_NAME + ' could not save local settings:', error);
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

    function postMarketAction(sourceId, payload) {
        return runRateLimitedNetworkRequest(function () {
            return new Promise((resolve, reject) => {
                try {
                    TribalWars.post(
                        'market',
                        { ajaxaction: 'map_send', village: sourceId },
                        payload,
                        response => {
                            if (response && (response.error || response.errors || response.warning || response.warnings)) {
                                reject(response);
                                return;
                            }
                            resolve(response);
                        },
                        error => reject(error)
                    );
                } catch (error) {
                    reject(error);
                }
            });
        }, 'POST market map_send');
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

    function buildOverviewUrl() {
        const sitter = Number(game_data?.player?.sitter || 0) > 0;
        const sitterPart = sitter ? `t=${encodeURIComponent(game_data.player.id)}&` : '';
        const currentParams = new URLSearchParams(location.search);
        const group = currentParams.get('group') || game_data?.group_id || '';
        const groupPart = group !== '' && group !== null ? `&group=${encodeURIComponent(group)}` : '';
        return `game.php?${sitterPart}screen=overview_villages&mode=prod&page=-1${groupPart}`;
    }

    async function loadVillageData() {
        const html = await fetchText(buildOverviewUrl(), 'Production overview');
        const doc = new DOMParser().parseFromString(html, 'text/html');

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
                totalMerchants: parseNumber(merchantMatch[2])
            });
        }

        if (!parsed.length) throw new Error('Village rows were found, but resource/warehouse/merchant data could not be parsed.');
        return parsed;
    }

    function sanitizeSettings(raw) {
        const target = parseCoord(raw.targetCoord);
        return {
            targetCoord: target?.coord || String(raw.targetCoord || '').trim(),
            directRadius: clamp(Number(raw.directRadius) || DEFAULTS.directRadius, 1, 100),
            keepWhPct: clamp(Number(raw.keepWhPct) || 0, 0, 99),
            triggerPct: clamp(Number(raw.triggerPct) || DEFAULTS.triggerPct, 1, 99),
            imbalanceGapPct: clamp(Number(raw.imbalanceGapPct) || DEFAULTS.imbalanceGapPct, 1, 99),
            safeCeilingPct: clamp(Number(raw.safeCeilingPct) || DEFAULTS.safeCeilingPct, 1, 99)
        };
    }

    function getSettingsFromUi() {
        return sanitizeSettings({
            targetCoord: document.querySelector('#strr-target')?.value,
            directRadius: document.querySelector('#strr-radius')?.value,
            keepWhPct: document.querySelector('#strr-keep')?.value,
            triggerPct: document.querySelector('#strr-trigger')?.value,
            imbalanceGapPct: document.querySelector('#strr-imbalance')?.value,
            safeCeilingPct: document.querySelector('#strr-safe')?.value
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

    async function resolveTarget(coord) {
        const parsed = parseCoord(coord);
        if (!parsed) throw new Error('Enter a valid target coordinate, for example 454|598.');

        const local = villages.find(v => v.coord === parsed.coord);
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

        // Fill the receiver's lowest resource first. If equal, use the resource
        // with the largest absolute deficit first.
        const order = [...RESOURCE_KEYS].sort((a, b) => {
            const ar = projectedValue(target, a) / target.warehouse;
            const br = projectedValue(target, b) / target.warehouse;
            if (Math.abs(ar - br) > 0.000001) return ar - br;
            return need[b] - need[a];
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

            // Side rule overrides the routing priorities.
            if (afterDirectFill < SIDE_DIRECT_FLOOR) {
                addDirectTransfer(transfers, source, finalTarget, 'DIRECT', 'Side rule: hypothetical direct leaves <50%', cfg);
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
            #${SCRIPT_ID} .twsr-input {
                width: 100%;
                padding: 6px;
                border: 1px solid #b99351;
                border-radius: 5px;
                background: #fffdf7;
                color: #2f1b00;
                outline: none;
            }
            #${SCRIPT_ID} .twsr-input:focus {
                border-color: #7d510f;
                box-shadow: 0 0 0 2px rgba(125,81,15,0.16);
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
            <div>
                <div class="twsr-label-row">
                    <label class="twsr-label" for="${id}">${escapeHtml(label)}</label>
                    <button type="button" class="twsr-info-button" data-twsr-info="${escapeHtml(infoKey)}">?</button>
                </div>
                <input class="twsr-input" id="${id}" type="${type}" value="${escapeHtml(value)}" ${attrs}>
                <div class="twsr-hint">${escapeHtml(hint)}</div>
            </div>
        `;
    }

    function renderShell() {
        document.getElementById(SCRIPT_ID)?.remove();
        document.getElementById(STYLE_ID)?.remove();

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = getStyles();
        document.head.appendChild(style);

        const box = document.createElement('div');
        box.id = SCRIPT_ID;

        const infoText = {
            target: 'The final village all resources are ultimately moving toward. Villages inside the direct radius send straight here. Relay candidates are always required to be closer to this final target than their origin.',
            radius: 'Two uses: (1) every origin at or inside this distance from the final target sends directly; (2) a relay candidate must be within this many fields of the origin. P1-P4 still use the fixed 18 and 24 field bands.',
            keep: 'Percentage of each resource warehouse capacity that direct and relay sends protect in the origin. 0% reproduces the original sender behavior of using all sendable resources allowed by merchants and ratio.',
            trigger: 'WH fullness is based on the fullest individual resource. At 70%, a 400,000 warehouse becomes 70% full as soon as wood, clay OR iron reaches 280,000.',
            imbalance: 'P7/P8 consider a village imbalanced when the difference between its fullest and emptiest resource reaches this many percentage points of warehouse capacity.',
            safe: 'P9/P10 may use a receiver only while its projected fullest resource stays below this ceiling. Planned incoming relay resources count toward this safety calculation.'
        };

        box.innerHTML = `
            <div class="twsr-header">
                <div class="twsr-title">
                    <span>${escapeHtml(SCRIPT_NAME + ' ' + SCRIPT_VERSION)}</span>
                    <span class="twsr-subtitle">Target-first resource routing with direct sends and closer relays</span>
                </div>
                <button type="button" class="twsr-close">x</button>
            </div>
            <div class="twsr-body">
                <div class="twsr-quick-help">
                    <span class="twsr-pill">One final target</span>
                    <span class="twsr-pill">WH% = fullest resource</span>
                    <span class="twsr-pill">Closer-to-target relays only</span>
                    <span class="twsr-pill">Direct ratio 28 / 30 / 25</span>
                    <span class="twsr-pill">Minimum 900 resources / send</span>
                    <span class="twsr-pill">Manual send per row</span>
                </div>

                <div class="twsr-panel">
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
        box.querySelectorAll('[data-twsr-info]').forEach(button => {
            button.addEventListener('click', () => {
                const key = button.dataset.twsrInfo;
                const label = button.parentElement?.querySelector('.twsr-label')?.textContent || 'Information';
                showInfoDialog(label, infoText[key] || '');
            });
        });
        box.addEventListener('click', async event => {
            const button = event.target.closest('[data-strr-send]');
            if (!button) return;
            await executeTransfer(Number(button.dataset.strrSend), button);
        });

        makeDraggable(box, box.querySelector('.twsr-header'));
        installEnterHandler();

        window.twacticsSmartResourceSender = {
            close: closeDialog,
            refresh: () => refreshData(true),
            createPlan: generateFromUi,
            getPlan: () => plan.slice(),
            getVillages: () => villages.slice()
        };
    }

    async function generateFromUi() {
        const output = document.querySelector('#strr-output');
        const buildButton = document.querySelector('#strr-build');

        try {
            if (buildButton) buildButton.disabled = true;
            settings = getSettingsFromUi();
            saveSettings(settings);
            setStatus('Resolving target village and creating routing plan...', 'warn');
            resolvedTarget = await resolveTarget(settings.targetCoord);
            plan = buildPlan(villages, resolvedTarget, settings);
            renderPlan();
            setStatus(
                'Plan ready: ' + plan.length + ' transfer(s) from ' + new Set(plan.map(item => item.sourceId)).size + ' origin village(s).',
                'success'
            );
        } catch (error) {
            console.error('[' + SCRIPT_NAME + ']', error);
            setStatus(error && error.message ? error.message : String(error), 'error');
            if (output) output.innerHTML = '';
        } finally {
            if (buildButton) buildButton.disabled = false;
        }
    }

    function renderPlan() {
        const output = document.querySelector('#strr-output');
        if (!output || !resolvedTarget) return;

        const direct = plan.filter(item => item.kind === 'direct');
        const relay = plan.filter(item => item.kind === 'relay');
        const total = plan.reduce((sum, item) => sum + item.total, 0);
        const directTotal = direct.reduce((sum, item) => sum + item.total, 0);
        const relayTotal = relay.reduce((sum, item) => sum + item.total, 0);
        const uniqueSources = new Set(plan.map(item => item.sourceId)).size;

        let html = `
            <div class="twsr-summary-panel">
                <div><strong>Final target:</strong> ${escapeHtml(resolvedTarget.name)} (${escapeHtml(resolvedTarget.coord)})</div>
                <div class="twsr-small" style="margin-top:5px;">
                    ${villages.length} villages loaded &middot;
                    ${uniqueSources} origins used &middot;
                    ${relay.length} relay send(s) / ${fmt(relayTotal)} resources &middot;
                    ${direct.length} direct send(s) / ${fmt(directTotal)} resources &middot;
                    ${fmt(total)} total planned resources
                </div>
                <div class="twsr-small" style="margin-top:6px;">
                    Relay rows are listed first. Planned relay incoming reserves warehouse space immediately, but does not become outgoing stock until it actually arrives. For multi-hop movement, complete the relay rows and rerun the script after arrival.
                </div>
            </div>
        `;

        if (!plan.length) {
            output.innerHTML = html + '<div class="twsr-empty">No sendable resources were found with the current settings and merchant availability.</div>';
            return;
        }

        html += `
            <div class="twsr-section-title">Transfer plan</div>
            <div class="twsr-table-wrap">
                <table class="twsr-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Rule</th>
                            <th>Type</th>
                            <th>Origin</th>
                            <th>Origin -> final</th>
                            <th>Send to</th>
                            <th>Receiver -> final</th>
                            <th>Leg</th>
                            <th class="twsr-resource-head"><img src="/graphic/holz.png" alt="Wood">Wood</th>
                            <th class="twsr-resource-head"><img src="/graphic/lehm.png" alt="Clay">Clay</th>
                            <th class="twsr-resource-head"><img src="/graphic/eisen.png" alt="Iron">Iron</th>
                            <th>Total</th>
                            <th>Merch.</th>
                            <th>Origin WH max</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        plan.forEach((transfer, index) => {
            const rule = transfer.kind === 'relay' && transfer.receiverPriority
                ? transfer.rule + ' / P' + transfer.receiverPriority
                : transfer.rule;
            const receiverInfo = transfer.kind === 'relay'
                ? '<div class="twsr-small">' + escapeHtml(transfer.receiverLabel) + '</div>'
                : '<div class="twsr-small">Final target</div>';

            html += `
                <tr id="strr-row-${index}" class="${transfer.kind === 'relay' ? 'twsr-relay' : ''}">
                    <td>${index + 1}</td>
                    <td class="twsr-rule">${escapeHtml(rule)}<div class="twsr-small">${escapeHtml(transfer.note)}</div></td>
                    <td><strong>${transfer.kind === 'relay' ? 'RELAY' : 'DIRECT'}</strong></td>
                    <td class="twsr-left"><strong>${escapeHtml(transfer.sourceCoord)}</strong><div class="twsr-small">${escapeHtml(transfer.sourceName)}</div></td>
                    <td>${transfer.sourceToTarget.toFixed(1)}</td>
                    <td class="twsr-left"><strong>${escapeHtml(transfer.targetCoord)}</strong>${receiverInfo}</td>
                    <td>${transfer.targetToFinal.toFixed(1)}</td>
                    <td>${transfer.legDistance.toFixed(1)}</td>
                    <td>${fmt(transfer.wood)}</td>
                    <td>${fmt(transfer.stone)}</td>
                    <td>${fmt(transfer.iron)}</td>
                    <td><strong>${fmt(transfer.total)}</strong></td>
                    <td>${transfer.merchants}</td>
                    <td>${pct(transfer.sourceBeforePct)} -> ${pct(transfer.sourceAfterPct)}</td>
                    <td><button class="btn btn-confirm-yes twsr-send-button" data-strr-send="${index}">Send resources</button></td>
                </tr>
            `;
        });

        html += '</tbody></table></div>';
        output.innerHTML = html;

        const firstButton = output.querySelector('.twsr-send-button:not(:disabled)');
        if (firstButton) firstButton.focus();
    }

    async function executeTransfer(index, button) {
        const transfer = plan[index];
        if (!transfer || transfer.sent || sendLocked) return;

        sendLocked = true;
        document.querySelectorAll('.twsr-send-button').forEach(node => { node.disabled = true; });
        const oldText = button.textContent;
        button.textContent = 'Sending...';
        setStatus('Sending one manual transfer from ' + transfer.sourceCoord + ' to ' + transfer.targetCoord + '...', 'warn');

        try {
            const payload = {
                target_id: transfer.targetId,
                wood: transfer.wood,
                stone: transfer.stone,
                iron: transfer.iron
            };

            const response = await postMarketAction(transfer.sourceId, payload);
            transfer.sent = true;

            const row = document.querySelector('#strr-row-' + index);
            if (row) row.remove();

            const message = response && (response.success || response.message)
                ? (response.success || response.message)
                : 'Resources sent.';
            setStatus(message, 'success');
            if (window.UI?.SuccessMessage) UI.SuccessMessage(message);
        } catch (error) {
            console.error('[' + SCRIPT_NAME + ']', error);
            button.textContent = oldText;
            setStatus('Send failed. Refresh village data and create the plan again before retrying.', 'error');
            if (window.UI?.ErrorMessage) UI.ErrorMessage('Send failed. Refresh village data and regenerate the plan.');
        } finally {
            sendLocked = false;
            document.querySelectorAll('.twsr-send-button').forEach(node => { node.disabled = false; });
            const next = document.querySelector('.twsr-send-button:not(:disabled)');
            if (next) next.focus();
            else if (transfer.sent) setStatus('All visible planned transfers have been completed.', 'success');
        }
    }

    async function refreshData(showMessage = false) {
        const build = document.querySelector('#strr-build');
        const refresh = document.querySelector('#strr-refresh');
        if (build) build.disabled = true;
        if (refresh) refresh.disabled = true;

        try {
            setStatus('Loading production data for the currently selected village group...', 'warn');
            villages = await loadVillageData();
            setStatus('Loaded ' + villages.length + ' village(s). Enter the final target and create a plan.', 'success');
            if (showMessage && window.UI?.SuccessMessage) UI.SuccessMessage('Loaded ' + villages.length + ' villages.');

            if (settings.targetCoord && showMessage) {
                await generateFromUi();
            }
        } catch (error) {
            console.error('[' + SCRIPT_NAME + ']', error);
            setStatus(error && error.message ? error.message : String(error), 'error');
            const output = document.querySelector('#strr-output');
            if (output) output.innerHTML = '';
        } finally {
            if (build) build.disabled = false;
            if (refresh) refresh.disabled = false;
        }
    }

    document.getElementById(SCRIPT_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    renderShell();
    await refreshData(false);
    console.log(SCRIPT_NAME + ' ' + SCRIPT_VERSION + ' loaded');
})();
