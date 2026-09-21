/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Relic Analyzer
 *
 * Reads relic data from Treasury -> Inventory and classifies supported combat
 * relics into custom OFF/DEF tiers. Relic inventory is read from the structured
 * data passed to RelicSystem.Inventory.init(...), matching Twactics Relic Planner.
 *
 * This script:
 * - Reads relic data from Treasury -> Inventory
 * - Uses the game's structured relic JSON rather than scraping visible relic cards
 * - Separates OFF and DEF relic families
 * - Keeps the fixed main stat separate from the two rolled substats
 * - Detects rare/perfect substats from the game's `perfect` flag
 * - Classifies relics into custom tiers
 * - Keeps offense+defense, attack and defense as separate benefit buckets
 * - Does not perform any game action; analysis starts after a manual script run
 *
 * v1.1.0:
 * - Inventory loading now uses the same RelicSystem.Inventory.init JSON method as
 *   Twactics Relic Planner.
 * - Rare detection now uses subStat.perfect === true.
 * - Added structured sub-stat ID mapping and same-origin inventory fetching.
 * - Upgrade/reroll recommendations are intentionally reserved for a later version.
 *
 * This script does NOT:
 * - Send attacks, support, or troops
 * - Auto-click game actions
 * - Equip, remove, upgrade, trade, destroy, or reroll relics
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
  'use strict';

  if (window.__TW_RELIC_ANALYZER_V1__) {
    try { window.__TW_RELIC_ANALYZER_V1__.destroy(); } catch (e) {}
  }

  const VERSION = '1.1.0';
  const STAT_CAP = 20;

  // ------------------------------------------------------------
  // CONFIG
  // ------------------------------------------------------------

  const CONFIG = {
    debug: false,

    // Set false if you do not want these to count as useful utility stats.
    utility: {
      nobleRefund: true,
      barracksRecruitSpeed: true,
      stableRecruitSpeed: true,
      workshopRecruitSpeed: true,
      academyRecruitSpeed: true,
      clayProduction: true,
      woodProduction: true,
      ironProduction: true,
      constructionSpeed: true,
      merchantTravelSpeed: true,
      merchantCapacity: true,
      haulCapacity: true,
      barracksRecruitCost: true,
      stableRecruitCost: true,
      workshopRecruitCost: true,
      scoutStealth: false,
      scoutPerception: false
    },

    // The scanner first tries these likely relic-card wrappers.
    // If none work, it falls back to scanning generic visible containers.
    selectors: [
      '[data-relic-id]',
      '[data-item-id]',
      '.relic',
      '.relic-item',
      '.relic-card',
      '.inventory-item',
      '.item-card',
      '.item'
    ],

    // Rare substats are normally purple. We try both classes and computed color.
    rareClassHints: [
      'rare',
      'purple',
      'rarity-rare',
      'stat-rare',
      'attribute-rare',
      'modifier-rare'
    ],

    // Purple-ish color detection thresholds.
    rareColor: {
      minBlue: 90,
      minRed: 80,
      blueMinusGreen: 25,
      redMinusGreen: 15
    }
  };

  const DEF_RELICS = new Set([
    'halberd',
    'longsword',
    'banner',
    'longbow'
  ]);

  const OFF_RELICS = new Set([
    'greataxe',
    'great axe',
    'shortspear',
    'short spear',
    'bonfire',
    'morningstar',
    'morning star',
    'shortbow',
    'short bow'
  ]);

  const RARITY_ORDER = {
    shoddy: 1,
    sturdy: 2,
    enhanced: 3,
    superior: 4,
    renowned: 5
  };

  const TIER_ORDER = {
    MONEY: 0,
    FUCK: 1,
    LEGENDARY: 2,
    S: 3,
    A: 4,
    B: 5,
    C: 6,
    D: 7,
    E: 8,
    F: 9,
    UNKNOWN: 99
  };

  const TIER_LABELS = {
    MONEY: 'Quadruple Oil Money',
    FUCK: 'Fuck Me In The Ass',
    LEGENDARY: 'Legendary',
    S: 'S',
    A: 'A',
    B: 'B',
    C: 'C',
    D: 'D',
    E: 'E',
    F: 'F',
    UNKNOWN: 'Unknown'
  };

  // ------------------------------------------------------------
  // NORMALIZATION HELPERS
  // ------------------------------------------------------------

  function norm(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[−–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function lower(s) {
    return norm(s).toLowerCase();
  }

  function titleCase(s) {
    return lower(s).replace(/\b\w/g, c => c.toUpperCase());
  }

  function familyCanonical(name) {
    const n = lower(name)
      .replace(/\bgreat axe\b/g, 'greataxe')
      .replace(/\bshort spear\b/g, 'shortspear')
      .replace(/\bmorning star\b/g, 'morningstar')
      .replace(/\bshort bow\b/g, 'shortbow');

    const all = [
      'halberd', 'longsword', 'banner', 'longbow',
      'greataxe', 'shortspear', 'bonfire', 'morningstar', 'shortbow'
    ];

    return all.find(x => n.includes(x)) || null;
  }

  function prettyFamily(family) {
    const map = {
      halberd: 'Halberd',
      longsword: 'Longsword',
      banner: 'Banner',
      longbow: 'Longbow',
      greataxe: 'Greataxe',
      shortspear: 'Shortspear',
      bonfire: 'Bonfire',
      morningstar: 'Morningstar',
      shortbow: 'Shortbow'
    };
    return map[family] || titleCase(family || 'Unknown');
  }

  function getSide(family) {
    if (!family) return null;
    if (DEF_RELICS.has(family)) return 'DEF';
    if (OFF_RELICS.has(family)) return 'OFF';
    return null;
  }

  function parseRarity(text) {
    const t = lower(text);
    return Object.keys(RARITY_ORDER).find(r => t.includes(r)) || null;
  }

  function parseName(text) {
    const rarity = parseRarity(text);
    const family = familyCanonical(text);
    if (!family) return null;
    return `${rarity ? titleCase(rarity) + ' ' : ''}${prettyFamily(family)}`;
  }

  function parsePercent(text) {
    const m = norm(text).match(/([+-]?\d+(?:[.,]\d+)?)\s*%/);
    if (!m) return null;
    return Number(m[1].replace(',', '.'));
  }

  // ------------------------------------------------------------
  // STAT PARSING
  // ------------------------------------------------------------

  const UNIT_PATTERNS = [
    ['mounted_archer', /mounted archer/i],
    ['light_cavalry', /light cavalry/i],
    ['heavy_cavalry', /heavy cavalry/i],
    ['spear', /spear fighter|spearman/i],
    ['sword', /swordsman|sword fighter/i],
    ['axe', /axeman|axe fighter/i],
    ['archer', /\barcher\b/i],
    ['catapult', /catapult/i],
    ['ram', /\bram\b/i],
    ['scout', /scout/i]
  ];

  function detectUnit(text) {
    const t = norm(text);
    const hit = UNIT_PATTERNS.find(([, re]) => re.test(t));
    return hit ? hit[0] : null;
  }

  function utilityKey(text) {
    const t = lower(text);

    if (/refund on nobleman production/.test(t)) return 'nobleRefund';
    if (/barracks recruit speed/.test(t)) return 'barracksRecruitSpeed';
    if (/stable recruit speed/.test(t)) return 'stableRecruitSpeed';
    if (/workshop recruit speed/.test(t)) return 'workshopRecruitSpeed';
    if (/academy recruit speed/.test(t)) return 'academyRecruitSpeed';
    if (/clay production/.test(t)) return 'clayProduction';
    if (/wood production/.test(t)) return 'woodProduction';
    if (/iron production/.test(t)) return 'ironProduction';
    if (/construction speed/.test(t)) return 'constructionSpeed';
    if (/merchant travel speed/.test(t)) return 'merchantTravelSpeed';
    if (/merchant capacity/.test(t)) return 'merchantCapacity';
    if (/haul capacity/.test(t)) return 'haulCapacity';
    if (/barracks recruit costs?/.test(t)) return 'barracksRecruitCost';
    if (/stable recruit costs?/.test(t)) return 'stableRecruitCost';
    if (/workshop recruit costs?/.test(t)) return 'workshopRecruitCost';
    if (/scout.*stealth/.test(t)) return 'scoutStealth';
    if (/scout.*perception/.test(t)) return 'scoutPerception';

    return null;
  }

  function parseStatText(text, side) {
    const raw = norm(text);
    const t = lower(raw);
    const value = parsePercent(raw);
    const unit = detectUnit(raw);

    let bucket = null;
    let semantic = 'IRRELEVANT';

    if (/offense and defense power/.test(t)) {
      bucket = 'both';
      semantic = 'BOTH';
    } else if (/damage against buildings/.test(t)) {
      bucket = 'building_damage';
      semantic = side === 'OFF' ? 'PRIMARY' : 'IRRELEVANT';
    } else if (/attack power/.test(t)) {
      bucket = 'attack';
      semantic = side === 'OFF' ? 'PRIMARY' : 'IRRELEVANT';
    } else if (/defense power/.test(t)) {
      bucket = 'defense';
      semantic = side === 'DEF' ? 'PRIMARY' : 'IRRELEVANT';
    } else {
      const uKey = utilityKey(raw);
      if (uKey && CONFIG.utility[uKey]) {
        semantic = 'UTILITY';
        bucket = 'utility';
      }
    }

    return {
      text: raw,
      value,
      unit,
      bucket,
      semantic,
      utilityKey: utilityKey(raw),
      rare: false,
      sourceElement: null
    };
  }

  // ------------------------------------------------------------
  // STRUCTURED INVENTORY LOADING
  // ------------------------------------------------------------

  const SUB_STAT_KEYS_BY_ID = {
    1: 'spear_offdef', 2: 'sword_offdef', 3: 'axe_offdef', 4: 'archer_offdef',
    5: 'light_offdef', 6: 'marcher_offdef', 7: 'heavy_offdef',
    8: 'catapult_damage', 9: 'ram_damage',
    10: 'barracks_speed', 11: 'stable_speed', 12: 'workshop_speed',
    13: 'haul_capacity', 14: 'clay_production', 15: 'wood_production',
    16: 'iron_production', 19: 'barracks_cost', 20: 'stable_cost',
    21: 'workshop_cost', 22: 'spear_attack', 23: 'sword_attack',
    24: 'axe_attack', 25: 'archer_attack', 26: 'marcher_attack',
    27: 'light_attack', 28: 'heavy_attack', 29: 'catapult_attack',
    30: 'ram_attack', 31: 'spear_defense', 32: 'sword_defense',
    33: 'axe_defense', 34: 'archer_defense', 35: 'light_defense',
    36: 'marcher_defense', 37: 'heavy_defense', 38: 'catapult_defense',
    39: 'ram_defense', 40: 'construction_speed', 41: 'merchant_travel_speed',
    42: 'merchant_capacity', 43: 'academy_speed', 44: 'noble_refund'
  };

  const MAIN_STAT_KEYS = {
    halberd: 'spear_offdef',
    longsword: 'sword_offdef',
    greataxe: 'axe_offdef',
    shortspear: 'light_offdef',
    longbow: 'archer_offdef',
    shortbow: 'marcher_offdef',
    banner: 'heavy_offdef',
    morningstar: 'ram_damage',
    bonfire: 'catapult_damage'
  };

  const INTERNAL_LABELS = {
    spear_offdef: 'Spear fighter offense and defense power',
    sword_offdef: 'Swordsman offense and defense power',
    axe_offdef: 'Axeman offense and defense power',
    archer_offdef: 'Archer offense and defense power',
    light_offdef: 'Light cavalry offense and defense power',
    marcher_offdef: 'Mounted archer offense and defense power',
    heavy_offdef: 'Heavy cavalry offense and defense power',
    catapult_damage: 'Catapult damage against buildings',
    ram_damage: 'Ram damage against buildings',
    barracks_speed: 'Barracks Recruit Speed',
    stable_speed: 'Stable Recruit Speed',
    workshop_speed: 'Workshop Recruit Speed',
    haul_capacity: 'haul capacity', clay_production: 'clay production',
    wood_production: 'wood production', iron_production: 'iron production',
    barracks_cost: 'Barracks Recruit Costs', stable_cost: 'Stable Recruit Costs',
    workshop_cost: 'Workshop Recruit Costs',
    spear_attack: 'Spear fighter attack power', sword_attack: 'Swordsman attack power',
    axe_attack: 'Axeman attack power', archer_attack: 'Archer attack power',
    marcher_attack: 'Mounted archer attack power', light_attack: 'Light cavalry attack power',
    heavy_attack: 'Heavy cavalry attack power', catapult_attack: 'Catapult attack power',
    ram_attack: 'Ram attack power',
    spear_defense: 'Spear fighter defense power', sword_defense: 'Swordsman defense power',
    axe_defense: 'Axeman defense power', archer_defense: 'Archer defense power',
    light_defense: 'Light cavalry defense power', marcher_defense: 'Mounted archer defense power',
    heavy_defense: 'Heavy cavalry defense power', catapult_defense: 'Catapult defense power',
    ram_defense: 'Ram defense power', construction_speed: 'Construction speed',
    merchant_travel_speed: 'merchant travel speed', merchant_capacity: 'merchant capacity',
    academy_speed: 'Academy Recruit Speed', noble_refund: 'refund on Nobleman production'
  };

  const UTILITY_CONFIG_KEY_BY_INTERNAL = {
    noble_refund: 'nobleRefund', barracks_speed: 'barracksRecruitSpeed',
    stable_speed: 'stableRecruitSpeed', workshop_speed: 'workshopRecruitSpeed',
    academy_speed: 'academyRecruitSpeed', clay_production: 'clayProduction',
    wood_production: 'woodProduction', iron_production: 'ironProduction',
    construction_speed: 'constructionSpeed', merchant_travel_speed: 'merchantTravelSpeed',
    merchant_capacity: 'merchantCapacity', haul_capacity: 'haulCapacity',
    barracks_cost: 'barracksRecruitCost', stable_cost: 'stableRecruitCost',
    workshop_cost: 'workshopRecruitCost'
  };

  function getParam(name, url) {
    try {
      return new URL(url || window.location.href, window.location.origin).searchParams.get(name);
    } catch (err) {
      return null;
    }
  }

  function getCurrentVillageId() {
    if (typeof game_data !== 'undefined' && game_data.village && game_data.village.id) {
      return String(game_data.village.id);
    }
    return getParam('village') || '';
  }

  function buildGameUrl(params) {
    const url = new URL('/game.php', window.location.origin);
    const villageId = getCurrentVillageId();

    if (typeof game_data !== 'undefined' && game_data.player && parseInt(game_data.player.sitter || 0, 10) > 0) {
      url.searchParams.set('t', String(game_data.player.id));
    }
    if (villageId) url.searchParams.set('village', villageId);
    Object.keys(params || {}).forEach(key => {
      if (params[key] !== undefined && params[key] !== null) url.searchParams.set(key, String(params[key]));
    });
    return url.pathname + url.search;
  }

  async function fetchHtml(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'text/html, */*; q=0.01' }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' while loading ' + url);
    return response.text();
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function extractBalancedValue(source, startIndex) {
    const opening = source[startIndex];
    const closing = opening === '{' ? '}' : opening === '[' ? ']' : null;
    if (!closing) throw new Error('Expected balanced JSON value.');
    let depth = 0, insideString = false, escaped = false;
    for (let i = startIndex; i < source.length; i++) {
      const char = source[i];
      if (insideString) {
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') insideString = false;
        continue;
      }
      if (char === '"') { insideString = true; continue; }
      if (char === opening) depth++;
      else if (char === closing && --depth === 0) return source.slice(startIndex, i + 1);
    }
    throw new Error('Could not find end of JSON value.');
  }

  function rawStatText(stat) {
    return norm((stat && stat.name) || (stat && stat.benefit && stat.benefit.description) || '');
  }

  function internalStatParts(key) {
    const unitMap = { spear:'spear', sword:'sword', axe:'axe', archer:'archer', light:'light_cavalry', marcher:'mounted_archer', heavy:'heavy_cavalry', ram:'ram', catapult:'catapult' };
    for (const prefix of Object.keys(unitMap)) {
      if (key === prefix + '_offdef') return { unit: unitMap[prefix], bucket:'both' };
      if (key === prefix + '_attack') return { unit: unitMap[prefix], bucket:'attack' };
      if (key === prefix + '_defense') return { unit: unitMap[prefix], bucket:'defense' };
      if (key === prefix + '_damage') return { unit: unitMap[prefix], bucket:'building_damage' };
    }
    return { unit:null, bucket:'utility' };
  }

  function normalizeStructuredStat(rawStat, relicFamily, side, source) {
    if (!rawStat) return null;
    const rawText = rawStatText(rawStat);
    const value = parsePercent(rawText);
    let key = '';
    if (source === 'sub' && rawStat.id !== undefined && SUB_STAT_KEYS_BY_ID[String(rawStat.id)]) {
      key = SUB_STAT_KEYS_BY_ID[String(rawStat.id)];
    } else if (source === 'main') {
      key = MAIN_STAT_KEYS[relicFamily] || '';
    }

    // Text fallback keeps the analyzer usable if InnoGames introduces a new ID.
    if (!key) {
      const fallback = parseStatText(rawText, side);
      if (!fallback) return null;
      fallback.rare = source === 'sub' && rawStat.perfect === true;
      fallback.perfect = fallback.rare;
      fallback.internalKey = '';
      return fallback;
    }

    const parts = internalStatParts(key);
    let semantic = 'IRRELEVANT';
    if (parts.bucket === 'both') semantic = 'BOTH';
    else if (side === 'OFF' && (parts.bucket === 'attack' || parts.bucket === 'building_damage')) semantic = 'PRIMARY';
    else if (side === 'DEF' && parts.bucket === 'defense') semantic = 'PRIMARY';
    else if (parts.bucket === 'utility') {
      const cfgKey = UTILITY_CONFIG_KEY_BY_INTERNAL[key];
      if (cfgKey && CONFIG.utility[cfgKey]) semantic = 'UTILITY';
    }

    return {
      text: rawText || ((INTERNAL_LABELS[key] || key) + (value != null ? ' +' + Math.abs(value) + '%' : '')),
      value: value == null ? 0 : Math.abs(value),
      unit: parts.unit,
      bucket: parts.bucket,
      semantic: semantic,
      utilityKey: UTILITY_CONFIG_KEY_BY_INTERNAL[key] || null,
      internalKey: key,
      rare: source === 'sub' && rawStat.perfect === true,
      perfect: source === 'sub' && rawStat.perfect === true,
      sourceElement: null
    };
  }

  function normalizeInventoryRelic(raw, index) {
    if (!raw || raw.id === undefined || raw.id === null) return null;
    const family = familyCanonical(raw.type || raw.name || '');
    const side = getSide(family);
    if (!family || !side) return null;

    const rarity = parseRarity(String(raw.quality || '') + ' ' + String(raw.name || ''));
    const mainStat = raw.main_stat ? normalizeStructuredStat(raw.main_stat, family, side, 'main') : null;
    const substats = (raw.sub_stats || []).filter(Boolean).map(stat => normalizeStructuredStat(stat, family, side, 'sub')).filter(Boolean).slice(0, 2);

    const relic = {
      id: String(raw.id), index: index, family: family, familyName: prettyFamily(family),
      rarity: rarity, rarityName: rarity ? titleCase(rarity) : (norm(raw.quality) || 'Unknown'),
      name: norm(raw.name) || ((rarity ? titleCase(rarity) + ' ' : '') + prettyFamily(family)),
      side: side, mainStat: mainStat, substats: substats,
      allStats: [mainStat].concat(substats).filter(Boolean), tier:'UNKNOWN',
      tierLabel:TIER_LABELS.UNKNOWN, rawRelevantValue:0, raw:raw,
      rawText: JSON.stringify(raw),
      future: {
        canUpgrade: rarity ? ['shoddy','sturdy','enhanced','superior'].includes(rarity) : null,
        canReroll: rarity ? ['shoddy','sturdy','enhanced','superior','renowned'].includes(rarity) : null,
        upgradeMaterialPreference: family,
        ppSingleMaterialEligible: rarity ? ['shoddy','sturdy'].includes(rarity) : null
      }
    };
    relic.tier = calculateTier(relic);
    relic.tierLabel = TIER_LABELS[relic.tier] || relic.tier;
    relic.rawRelevantValue = calculateRawRelevantValue(relic);
    return relic;
  }

  function extractInventoryRelicsFromHtml(html) {
    const doc = parseHtml(html);
    const scripts = Array.from(doc.querySelectorAll('script'));
    const rawRelics = [];
    scripts.forEach(script => {
      const source = script.textContent || '';
      const marker = 'RelicSystem.Inventory.init';
      if (!source.includes(marker)) return;
      const markerIndex = source.indexOf(marker);
      const callStart = source.indexOf('(', markerIndex);
      const arrayStart = source.indexOf('[', callStart);
      if (arrayStart === -1) return;
      try {
        const parsed = JSON.parse(extractBalancedValue(source, arrayStart));
        if (Array.isArray(parsed)) parsed.forEach(item => rawRelics.push(item));
      } catch (err) {
        console.warn('Twactics Relic Analyzer could not parse inventory relic JSON:', err);
      }
    });

    const map = new Map();
    rawRelics.forEach((raw, index) => {
      const relic = normalizeInventoryRelic(raw, index);
      if (relic) map.set(relic.id, relic);
    });
    return Array.from(map.values());
  }

  async function scanRelics() {
    const inventoryUrl = buildGameUrl({ screen:'relic_system', mode:'inventory' });
    const html = await fetchHtml(inventoryUrl);
    const relics = extractInventoryRelicsFromHtml(html);
    console.log('Twactics Relic Analyzer inventory relics:', relics);
    return relics;
  }

  // ------------------------------------------------------------
  // TIER ENGINE
  // ------------------------------------------------------------

  function calculateTier(relic) {
    const stats = relic.substats || [];

    const primary = stats.filter(x => x.semantic === 'PRIMARY');
    const both = stats.filter(x => x.semantic === 'BOTH');
    const utility = stats.filter(x => x.semantic === 'UTILITY');

    const rarePrimary = primary.filter(x => x.rare);
    const rareBoth = both.filter(x => x.rare);

    // Quadruple Oil Money:
    // 2x rare primary OR rare primary + rare both
    if (
      rarePrimary.length >= 2 ||
      (rarePrimary.length >= 1 && rareBoth.length >= 1)
    ) return 'MONEY';

    // Fuck Me In The Ass:
    // rare primary + normal both OR 2x rare both
    // (rare both paired with rare primary already caught above)
    const normalBoth = both.filter(x => !x.rare);
    if (
      (rarePrimary.length >= 1 && normalBoth.length >= 1) ||
      rareBoth.length >= 2
    ) return 'FUCK';

    // Legendary:
    // 1x rare primary alone OR rare both + normal both
    if (
      rarePrimary.length >= 1 ||
      (rareBoth.length >= 1 && normalBoth.length >= 1)
    ) return 'LEGENDARY';

    // S:
    // 2x primary OR primary + both OR 1x rare both
    if (
      primary.length >= 2 ||
      (primary.length >= 1 && both.length >= 1) ||
      rareBoth.length >= 1
    ) return 'S';

    // A:
    // 1x primary
    if (primary.length >= 1) return 'A';

    // B:
    // 2x both
    if (both.length >= 2) return 'B';

    // C:
    // 1x both + useful non-def/off utility stat
    if (both.length >= 1 && utility.length >= 1) return 'C';

    // D:
    // 1x both and no other useful substat
    if (both.length >= 1) return 'D';

    // E:
    // no combat-relevant substats but at least one useful utility
    if (utility.length >= 1) return 'E';

    return 'F';
  }

  function calculateRawRelevantValue(relic) {
    return (relic.substats || []).reduce((sum, s) => {
      if (s.semantic === 'PRIMARY' || s.semantic === 'BOTH') {
        return sum + Math.abs(s.value || 0);
      }
      return sum;
    }, 0);
  }

  // ------------------------------------------------------------
  // CAP-AWARE STAT MODEL
  // ------------------------------------------------------------

  function statKey(stat) {
    if (!stat || !stat.unit) return null;
    if (stat.bucket === 'both') return `${stat.unit}.both`;
    if (stat.bucket === 'attack') return `${stat.unit}.attack`;
    if (stat.bucket === 'defense') return `${stat.unit}.defense`;
    if (stat.bucket === 'building_damage') return `${stat.unit}.building_damage`;
    return null;
  }

  function applyStat(stats, stat) {
    const key = statKey(stat);
    if (!key || stat.value == null) return { added: 0, wasted: 0 };

    const current = Number(stats[key] || 0);
    const raw = Math.max(0, Number(stat.value || 0));
    const next = Math.min(STAT_CAP, current + raw);
    const added = next - current;
    const wasted = raw - added;
    stats[key] = next;

    return { added, wasted, key };
  }

  function evaluateAgainstCurrentStats(relic, currentStats) {
    const clone = { ...(currentStats || {}) };
    let added = 0;
    let wasted = 0;

    const relevantStats = [];
    if (relic.mainStat) relevantStats.push(relic.mainStat);
    relevantStats.push(...(relic.substats || []).filter(s =>
      s.semantic === 'PRIMARY' || s.semantic === 'BOTH'
    ));

    for (const stat of relevantStats) {
      const r = applyStat(clone, stat);
      added += r.added || 0;
      wasted += r.wasted || 0;
    }

    return { added, wasted, resultingStats: clone };
  }

  function effectiveUnitAttack(stats, unit) {
    return Math.min(STAT_CAP, stats[`${unit}.both`] || 0) +
           Math.min(STAT_CAP, stats[`${unit}.attack`] || 0);
  }

  function effectiveUnitDefense(stats, unit) {
    return Math.min(STAT_CAP, stats[`${unit}.both`] || 0) +
           Math.min(STAT_CAP, stats[`${unit}.defense`] || 0);
  }

  // ------------------------------------------------------------
  // UI
  // ------------------------------------------------------------

  const UI_ID = 'tw-relic-analyzer-v1';

  function cssEscape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function shortStat(stat) {
    if (!stat) return '—';
    return `${stat.rare ? '★ ' : ''}${cssEscape(stat.text)}`;
  }

  function tierClass(tier) {
    return `twra-tier-${String(tier).toLowerCase()}`;
  }

  function render(relics) {
    document.getElementById(UI_ID)?.remove();

    const root = document.createElement('div');
    root.id = UI_ID;
    root.innerHTML = `
      <style>
        #${UI_ID} {
          position: fixed;
          top: 18px;
          right: 18px;
          width: min(920px, calc(100vw - 36px));
          max-height: calc(100vh - 36px);
          z-index: 2147483647;
          background: #f4e4bc;
          border: 2px solid #7d510f;
          box-shadow: 0 8px 28px rgba(0,0,0,.45);
          color: #2c1908;
          font: 12px Arial, Helvetica, sans-serif;
          overflow: hidden;
        }
        #${UI_ID} * { box-sizing: border-box; }
        #${UI_ID} .twra-head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 9px 10px;
          background: linear-gradient(#d9bd83,#c99f5b);
          border-bottom: 1px solid #7d510f;
          cursor: move;
          user-select: none;
        }
        #${UI_ID} .twra-title { font-weight: bold; font-size: 14px; flex: 1; }
        #${UI_ID} button, #${UI_ID} select {
          font: inherit;
          border: 1px solid #7d510f;
          background: #f7edd4;
          color: #2c1908;
          padding: 4px 7px;
          cursor: pointer;
        }
        #${UI_ID} button:hover { background: #fff6df; }
        #${UI_ID} .twra-toolbar {
          padding: 8px 10px;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 7px;
          border-bottom: 1px solid #b68c4b;
          background: #ead4a8;
        }
        #${UI_ID} .twra-toolbar label { font-weight: bold; }
        #${UI_ID} .twra-body {
          overflow: auto;
          max-height: calc(100vh - 135px);
          background: #f7edda;
        }
        #${UI_ID} table { width: 100%; border-collapse: collapse; }
        #${UI_ID} th, #${UI_ID} td {
          border-bottom: 1px solid #d5bc8d;
          padding: 6px 7px;
          text-align: left;
          vertical-align: top;
        }
        #${UI_ID} th {
          position: sticky;
          top: 0;
          z-index: 2;
          background: #d8bd84;
          border-bottom: 1px solid #8b651f;
        }
        #${UI_ID} tr:hover td { background: #fff5df; }
        #${UI_ID} .twra-tier {
          display: inline-block;
          min-width: 68px;
          text-align: center;
          padding: 2px 5px;
          border: 1px solid rgba(0,0,0,.28);
          border-radius: 2px;
          font-weight: bold;
          background: #eee;
        }
        #${UI_ID} .twra-tier-money { background: #ffe467; }
        #${UI_ID} .twra-tier-fuck { background: #f0a0ff; }
        #${UI_ID} .twra-tier-legendary { background: #ffb36c; }
        #${UI_ID} .twra-tier-s { background: #ffcd7a; }
        #${UI_ID} .twra-tier-a { background: #d8ef99; }
        #${UI_ID} .twra-tier-b { background: #bee5a4; }
        #${UI_ID} .twra-tier-c { background: #cfe3ea; }
        #${UI_ID} .twra-tier-d { background: #dde0e3; }
        #${UI_ID} .twra-tier-e { background: #e9e0d5; }
        #${UI_ID} .twra-tier-f { background: #d7c4c4; }
        #${UI_ID} .twra-rare { color: #762da8; font-weight: bold; }
        #${UI_ID} .twra-muted { opacity: .68; }
        #${UI_ID} .twra-empty { padding: 16px; line-height: 1.55; }
        #${UI_ID} .twra-side { font-weight: bold; }
        #${UI_ID} .twra-stat { white-space: normal; }
        #${UI_ID} .twra-foot {
          border-top: 1px solid #b68c4b;
          background: #ead4a8;
          padding: 6px 10px;
          font-size: 11px;
        }
      </style>
      <div class="twra-head">
        <div class="twra-title">Twactics Relic Analyzer v${VERSION}</div>
        <button type="button" data-action="rescan">Rescan</button>
        <button type="button" data-action="close">×</button>
      </div>
      <div class="twra-toolbar">
        <label>Side</label>
        <select data-filter="side">
          <option value="ALL">ALL</option>
          <option value="DEF">DEF</option>
          <option value="OFF">OFF</option>
        </select>
        <label>Sort</label>
        <select data-filter="sort">
          <option value="tier">Tier</option>
          <option value="rarity">Rarity</option>
          <option value="family">Family</option>
          <option value="raw">Raw relevant value</option>
        </select>
        <span class="twra-muted" data-role="count"></span>
      </div>
      <div class="twra-body" data-role="body"></div>
      <div class="twra-foot">
        ★ = rare/perfect substat from game data. Tiering uses the 2 rolled substats, not the fixed main stat. Read-only analyzer; no game actions are performed.
      </div>
    `;

    document.body.appendChild(root);
    makeDraggable(root, root.querySelector('.twra-head'));

    const state = { relics };

    function redraw() {
      const side = root.querySelector('[data-filter="side"]').value;
      const sort = root.querySelector('[data-filter="sort"]').value;
      let rows = state.relics.slice();

      if (side !== 'ALL') rows = rows.filter(r => r.side === side);

      rows.sort((a, b) => {
        if (sort === 'tier') {
          return (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) ||
                 ((RARITY_ORDER[b.rarity] || 0) - (RARITY_ORDER[a.rarity] || 0)) ||
                 a.name.localeCompare(b.name);
        }
        if (sort === 'rarity') {
          return ((RARITY_ORDER[b.rarity] || 0) - (RARITY_ORDER[a.rarity] || 0)) ||
                 (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
        }
        if (sort === 'family') return a.familyName.localeCompare(b.familyName);
        if (sort === 'raw') return b.rawRelevantValue - a.rawRelevantValue;
        return 0;
      });

      root.querySelector('[data-role="count"]').textContent = `${rows.length} relic${rows.length === 1 ? '' : 's'}`;
      const body = root.querySelector('[data-role="body"]');

      if (!rows.length) {
        body.innerHTML = `
          <div class="twra-empty">
            <b>No supported relics found.</b><br><br>
            The Treasury inventory was loaded, but no supported combat relics were found.<br>
            Supported families: Halberd, Longsword, Banner, Longbow, Greataxe, Shortspear, Bonfire, Morningstar and Shortbow.
          </div>`;
        return;
      }

      body.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Side</th>
              <th>Relic</th>
              <th>Main stat</th>
              <th>Substat 1</th>
              <th>Substat 2</th>
              <th>Relevant</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, idx) => `
              <tr data-row="${idx}">
                <td><span class="twra-tier ${tierClass(r.tier)}">${cssEscape(r.tierLabel)}</span></td>
                <td class="twra-side">${r.side}</td>
                <td>
                  <b>${cssEscape(r.name)}</b><br>
                  <span class="twra-muted">${cssEscape(r.id)}</span>
                </td>
                <td class="twra-stat">${formatStat(r.mainStat)}</td>
                <td class="twra-stat">${formatStat(r.substats[0])}</td>
                <td class="twra-stat">${formatStat(r.substats[1])}</td>
                <td>${r.rawRelevantValue}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    }

    function formatStat(s) {
      if (!s) return '<span class="twra-muted">—</span>';
      const cls = s.rare ? 'twra-rare' : '';
      const tag = s.semantic !== 'IRRELEVANT' ? ` <span class="twra-muted">[${cssEscape(s.semantic)}]</span>` : '';
      return `<span class="${cls}">${s.rare ? '★ ' : ''}${cssEscape(s.text)}</span>${tag}`;
    }

    root.addEventListener('change', e => {
      if (e.target.matches('[data-filter]')) redraw();
    });

    root.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;

      if (btn.dataset.action === 'close') root.remove();
      if (btn.dataset.action === 'rescan') {
        btn.disabled = true;
        try {
          state.relics = await scanRelics();
          window.__TW_RELIC_ANALYZER_V1__.relics = state.relics;
          redraw();
        } catch (err) {
          console.error('Twactics Relic Analyzer rescan failed:', err);
          alert('Twactics Relic Analyzer: ' + (err.message || String(err)));
        } finally {
          btn.disabled = false;
        }
      }
    });

    redraw();
    return root;
  }

  function makeDraggable(root, handle) {
    let dragging = false;
    let sx = 0, sy = 0, sl = 0, st = 0;

    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button,select,input')) return;
      dragging = true;
      const r = root.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      sl = r.left;
      st = r.top;
      root.style.right = 'auto';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      root.style.left = `${Math.max(0, sl + e.clientX - sx)}px`;
      root.style.top = `${Math.max(0, st + e.clientY - sy)}px`;
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ------------------------------------------------------------
  // START
  // ------------------------------------------------------------

  async function start() {
    try {
      const relics = await scanRelics();
      const ui = render(relics);

      window.__TW_RELIC_ANALYZER_V1__ = {
        version: VERSION, relics, config: CONFIG, scan: scanRelics, calculateTier,
        evaluateAgainstCurrentStats, effectiveUnitAttack, effectiveUnitDefense,
        inventoryMethod: 'RelicSystem.Inventory.init JSON',
        destroy() {
          document.getElementById(UI_ID)?.remove();
          delete window.__TW_RELIC_ANALYZER_V1__;
        },
        debug() {
          console.table(this.relics.map(r => ({
            id:r.id, name:r.name, side:r.side, rarity:r.rarityName, tier:r.tierLabel,
            main:r.mainStat?.text || '', sub1:r.substats[0]?.text || '',
            sub1Rare:!!r.substats[0]?.rare, sub2:r.substats[1]?.text || '',
            sub2Rare:!!r.substats[1]?.rare
          })));
          return this.relics;
        }
      };

      if (CONFIG.debug) window.__TW_RELIC_ANALYZER_V1__.debug();
    } catch (err) {
      console.error('Twactics Relic Analyzer failed:', err);
      alert('Twactics Relic Analyzer could not load Treasury inventory: ' + (err.message || String(err)));
    }
  }

  start();
})();
