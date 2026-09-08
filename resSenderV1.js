/*
 * Smart Target Resource Router for Tribal Wars
 *
 * Purpose:
 *   Move resources from the villages in the currently loaded production group
 *   toward one specific target village.
 *
 * Routing rules:
 *   - Villages inside the configured direct radius always send directly to target.
 *   - Outside that radius, routing follows P1-P10.
 *   - A relay village is ALWAYS required to be closer to the final target than
 *     the origin village, and must be within the configured hop radius.
 *   - Direct-to-target shipments use the same 28k/30k/25k wood/clay/iron ratio
 *     and proportional scaling logic as the referenced Shinko-to-Kuma sender.
 *   - Relay shipments do NOT force that ratio; they fill what the receiver needs.
 *
 * WH fullness is determined by the fullest individual resource:
 *   max(wood, clay, iron) / warehouse capacity.
 *
 * P1: > threshold, directRadius < target distance <= 18, hypothetical direct
 *     shipment leaves source below threshold -> DIRECT.
 * P2: > threshold, directRadius < target distance <= 18, hypothetical direct
 *     shipment leaves source at/above threshold -> try P5/P6 relays, else DIRECT.
 * P3: > threshold, 18 < target distance <= 24, hypothetical direct shipment
 *     leaves source >=50% and < threshold -> try P5/P6 relays, else DIRECT.
 * P4: > threshold, 18 < target distance <= 24, hypothetical direct shipment
 *     leaves source at/above threshold -> try P5/P6 relays, else DIRECT.
 * Side rule: Any village outside directRadius whose hypothetical direct shipment
 *     would leave it below 50% always sends DIRECT.
 * Other outside-radius origins use P5-P10 receiver priorities.
 *
 * P5: receiver all resources < threshold + merchants at home
 * P6: receiver all resources < threshold
 * P7: resource-imbalanced receiver + merchants at home
 * P8: resource-imbalanced receiver
 * P9: receiver with safe warehouse room + merchants at home
 * P10: receiver with safe warehouse room
 *
 * Notes:
 *   - Relay rows are shown before direct rows. Send relays first. Planned incoming
 *     resources reserve receiver warehouse space, but are NOT treated as immediately
 *     available for another outgoing hop in the same pass. After relays arrive,
 *     rerun the script to continue moving those resources inward.
 *   - Every send still requires a manual click.
 */

(async function smartTargetResourceRouter() {
    'use strict';

    const SCRIPT_ID = 'strr-root';
    const STORAGE_KEY = 'smartTargetResourceRouter.settings.v2';
    const RESOURCE_KEYS = ['wood', 'stone', 'iron'];
    const MERCHANT_CAPACITY = 1000;

    // Same direct-send coin ratio as the referenced sender.
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
    let settings = loadSettings();
    let resolvedTarget = null;

    function loadSettings() {
        try {
            return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
        } catch (_) {
            return { ...DEFAULTS };
        }
    }

    function saveSettings(value) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
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
        const response = await fetch(buildOverviewUrl(), {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });

        if (!response.ok) throw new Error(`Could not load production overview (${response.status}).`);

        const html = await response.text();
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
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (!response.ok) throw new Error(`Could not resolve target village (${response.status}).`);

        const text = await response.text();
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
                item.useful > 0
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
        if (total <= 0) return false;

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

        while (source.availableMerchants > 0 && totalResources(relayAvailable(source, cfg)) > 0 && safety++ < 100) {
            const choice = findRelayCandidate(source, state, finalTarget, allowedPriorities, cfg);
            if (!choice) break;

            const sourceBefore = maxFill(source);
            const receiverBefore = maxProjectedFill(choice.candidate);
            const amount = allocateRelayShipment(source, choice.candidate, choice.priority, cfg);
            const total = totalResources(amount);
            if (total <= 0) break;

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
            #${SCRIPT_ID} { margin:10px 0 20px; font-family:Arial,sans-serif; }
            #${SCRIPT_ID} .strr-card { background:#f4e4bc; border:1px solid #7d510f; padding:10px; margin-bottom:10px; }
            #${SCRIPT_ID} .strr-title { font-size:18px; font-weight:bold; margin:0 0 8px; }
            #${SCRIPT_ID} .strr-grid { display:grid; grid-template-columns:repeat(6,minmax(115px,1fr)); gap:8px; align-items:end; }
            #${SCRIPT_ID} label { display:block; font-size:11px; font-weight:bold; margin-bottom:2px; }
            #${SCRIPT_ID} input { width:96%; box-sizing:border-box; }
            #${SCRIPT_ID} .strr-note { margin-top:8px; font-size:11px; line-height:1.35; color:#5b4525; }
            #${SCRIPT_ID} .strr-summary { font-size:12px; line-height:1.5; }
            #${SCRIPT_ID} table { width:100%; border-collapse:collapse; background:#fff; }
            #${SCRIPT_ID} th, #${SCRIPT_ID} td { border:1px solid #c7b27c; padding:5px; font-size:11px; text-align:center; vertical-align:middle; }
            #${SCRIPT_ID} th { background:#c1a264; }
            #${SCRIPT_ID} td.strr-left { text-align:left; }
            #${SCRIPT_ID} tr.strr-relay td { background:#fff8e6; }
            #${SCRIPT_ID} tr.strr-sent { opacity:.45; text-decoration:line-through; }
            #${SCRIPT_ID} .strr-rule { font-weight:bold; }
            #${SCRIPT_ID} .strr-bad { color:#8a0000; font-weight:bold; }
            #${SCRIPT_ID} .strr-good { color:#1f6d22; font-weight:bold; }
            #${SCRIPT_ID} .strr-empty { text-align:center; padding:14px; }
            @media (max-width:1100px) { #${SCRIPT_ID} .strr-grid { grid-template-columns:repeat(3,minmax(120px,1fr)); } }
        `;
    }

    function renderShell() {
        document.getElementById(SCRIPT_ID)?.remove();
        document.getElementById(`${SCRIPT_ID}-style`)?.remove();

        const style = document.createElement('style');
        style.id = `${SCRIPT_ID}-style`;
        style.textContent = getStyles();
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = SCRIPT_ID;
        root.innerHTML = `
            <div class="strr-card">
                <div class="strr-title">Smart Target Resource Router</div>
                <div class="strr-grid">
                    <div><label>Target village XXX|YYY</label><input id="strr-target" type="text" value="${escapeHtml(settings.targetCoord)}" placeholder="454|598"></div>
                    <div><label>Direct / relay radius (fields)</label><input id="strr-radius" type="number" min="1" max="100" step="1" value="${settings.directRadius}"></div>
                    <div><label>Keep WH% behind</label><input id="strr-keep" type="number" min="0" max="99" step="1" value="${settings.keepWhPct}"></div>
                    <div><label>WH threshold %</label><input id="strr-trigger" type="number" min="1" max="99" step="1" value="${settings.triggerPct}"></div>
                    <div><label>Imbalance gap %</label><input id="strr-imbalance" type="number" min="1" max="99" step="1" value="${settings.imbalanceGapPct}"></div>
                    <div><label>Safe receiver ceiling %</label><input id="strr-safe" type="number" min="1" max="99" step="1" value="${settings.safeCeilingPct}"></div>
                </div>
                <div style="margin-top:9px;">
                    <button id="strr-build" class="btn btn-confirm-yes">Generate plan</button>
                    <button id="strr-refresh" class="btn">Refresh village data</button>
                </div>
                <div class="strr-note">
                    The field setting does two things: villages inside it send directly to the final target, and relay candidates must be within that many fields of the origin. Relay candidates are strictly required to be closer to the final target than the origin. P1-P4 use the fixed 18/24-field bands. WH fullness always means the fullest single resource, not the average of wood/clay/iron.
                </div>
            </div>
            <div id="strr-output"></div>
        `;

        const host = document.querySelector('#contentContainer') || document.body;
        host.prepend(root);

        root.querySelector('#strr-build').addEventListener('click', () => generateFromUi());
        root.querySelector('#strr-refresh').addEventListener('click', () => refreshData(true));
        root.addEventListener('click', async event => {
            const button = event.target.closest('[data-strr-send]');
            if (!button) return;
            await executeTransfer(Number(button.dataset.strrSend), button);
        });
    }

    async function generateFromUi() {
        const output = document.querySelector('#strr-output');
        try {
            settings = getSettingsFromUi();
            saveSettings(settings);
            resolvedTarget = await resolveTarget(settings.targetCoord);
            plan = buildPlan(villages, resolvedTarget, settings);
            renderPlan();
        } catch (error) {
            console.error('[Smart Target Resource Router]', error);
            if (output) output.innerHTML = `<div class="strr-card strr-bad">${escapeHtml(error.message)}</div>`;
        }
    }

    function renderPlan() {
        const output = document.querySelector('#strr-output');
        if (!output || !resolvedTarget) return;

        const direct = plan.filter(t => t.kind === 'direct');
        const relay = plan.filter(t => t.kind === 'relay');
        const total = plan.reduce((sum, t) => sum + t.total, 0);
        const directTotal = direct.reduce((sum, t) => sum + t.total, 0);
        const relayTotal = relay.reduce((sum, t) => sum + t.total, 0);
        const uniqueSources = new Set(plan.map(t => t.sourceId)).size;

        let html = `
            <div class="strr-card">
                <div class="strr-summary">
                    Target: <b>${escapeHtml(resolvedTarget.name)}</b> (${escapeHtml(resolvedTarget.coord)}) ·
                    <b>${villages.length}</b> villages loaded ·
                    <b>${uniqueSources}</b> origins with planned sends ·
                    <b>${relay.length}</b> relay sends (${fmt(relayTotal)} res) ·
                    <b>${direct.length}</b> direct sends (${fmt(directTotal)} res) ·
                    <b>${fmt(total)}</b> resources planned in this pass.
                </div>
                <div class="strr-note">
                    Relay rows are listed first. For multi-hop movement, send relays first; after they arrive, rerun the script so the newly received resources can continue toward ${escapeHtml(resolvedTarget.coord)}.
                </div>
            </div>
        `;

        if (!plan.length) {
            output.innerHTML = html + '<div class="strr-card strr-empty">No sendable resources found with the current settings/merchant availability.</div>';
            return;
        }

        html += `
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Rule</th>
                        <th>Type</th>
                        <th>Source</th>
                        <th>Source→final</th>
                        <th>Send to</th>
                        <th>Receiver→final</th>
                        <th>Leg</th>
                        <th>Wood</th>
                        <th>Clay</th>
                        <th>Iron</th>
                        <th>Total</th>
                        <th>Merch.</th>
                        <th>Source WH max</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

        plan.forEach((transfer, index) => {
            const rule = transfer.kind === 'relay' && transfer.receiverPriority
                ? `${transfer.rule} / P${transfer.receiverPriority}`
                : transfer.rule;
            const receiverInfo = transfer.kind === 'relay'
                ? `<br><span style="font-size:10px">${escapeHtml(transfer.receiverLabel)}</span>`
                : '';

            html += `
                <tr id="strr-row-${index}" class="${transfer.kind === 'relay' ? 'strr-relay' : ''}">
                    <td>${index + 1}</td>
                    <td class="strr-rule">${escapeHtml(rule)}${receiverInfo}<br><span style="font-size:10px;font-weight:normal">${escapeHtml(transfer.note)}</span></td>
                    <td>${transfer.kind === 'relay' ? '<b>RELAY</b>' : 'DIRECT'}</td>
                    <td class="strr-left">${escapeHtml(transfer.sourceName)}</td>
                    <td>${transfer.sourceToTarget.toFixed(1)}</td>
                    <td class="strr-left"><b>${escapeHtml(transfer.targetCoord)}</b><br>${escapeHtml(transfer.targetName)}</td>
                    <td>${transfer.targetToFinal.toFixed(1)}</td>
                    <td>${transfer.legDistance.toFixed(1)}</td>
                    <td>${fmt(transfer.wood)}</td>
                    <td>${fmt(transfer.stone)}</td>
                    <td>${fmt(transfer.iron)}</td>
                    <td><b>${fmt(transfer.total)}</b></td>
                    <td>${transfer.merchants}</td>
                    <td>${pct(transfer.sourceBeforePct)} → ${pct(transfer.sourceAfterPct)}</td>
                    <td><button class="btn btn-confirm-yes" data-strr-send="${index}">Send</button></td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        output.innerHTML = html;
    }

    async function executeTransfer(index, button) {
        const transfer = plan[index];
        if (!transfer || transfer.sent) return;

        button.disabled = true;
        const oldText = button.textContent;
        button.textContent = 'Sending...';

        try {
            await new Promise((resolve, reject) => {
                const payload = {
                    target_id: transfer.targetId,
                    wood: transfer.wood,
                    stone: transfer.stone,
                    iron: transfer.iron
                };

                try {
                    TribalWars.post(
                        'market',
                        { ajaxaction: 'map_send', village: transfer.sourceId },
                        payload,
                        response => resolve(response),
                        false
                    );
                } catch (error) {
                    reject(error);
                }
            });

            transfer.sent = true;
            document.querySelector(`#strr-row-${index}`)?.classList.add('strr-sent');
            button.textContent = 'Sent';
            if (window.UI?.SuccessMessage) UI.SuccessMessage('Resources sent.');
        } catch (error) {
            console.error('[Smart Target Resource Router]', error);
            button.disabled = false;
            button.textContent = oldText;
            if (window.UI?.ErrorMessage) UI.ErrorMessage('Send failed. Refresh village data and regenerate the plan.');
            else alert('Send failed. Refresh village data and regenerate the plan.');
        }
    }

    async function refreshData(showMessage = false) {
        const build = document.querySelector('#strr-build');
        const refresh = document.querySelector('#strr-refresh');
        if (build) build.disabled = true;
        if (refresh) refresh.disabled = true;

        try {
            villages = await loadVillageData();
            if (showMessage && window.UI?.SuccessMessage) UI.SuccessMessage(`Loaded ${villages.length} villages.`);
            if (settings.targetCoord) await generateFromUi();
            else {
                const output = document.querySelector('#strr-output');
                if (output) output.innerHTML = `<div class="strr-card">Loaded <b>${villages.length}</b> villages. Enter the final target coordinate and click <b>Generate plan</b>.</div>`;
            }
        } catch (error) {
            console.error('[Smart Target Resource Router]', error);
            const output = document.querySelector('#strr-output');
            if (output) output.innerHTML = `<div class="strr-card strr-bad">${escapeHtml(error.message)}</div>`;
        } finally {
            if (build) build.disabled = false;
            if (refresh) refresh.disabled = false;
        }
    }

    document.getElementById(SCRIPT_ID)?.remove();
    renderShell();
    await refreshData(false);
})();
