/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Relic Analyzer
 *
 * Reads relic data from Treasury -> Inventory and classifies supported combat,
 * recruitment and resource relics using category-aware custom tiers. Relic inventory is read from the structured
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
 * - Suggests what to keep, upgrade, reroll, use as material, or discard
 * - Does not perform any game action; analysis starts after a manual script run
 *
 * v1.4.0:
 * - Always opens Treasury -> Relic Inventory before running the analyzer.
 * - Adds in-inventory focus mode for upgrade targets and their material relics.
 * - Focus matching uses relic ID when available, then quality + family + substats as fallback.
 * - Adds all relic categories to the Category filter.
 * - Adds a visible tier legend and an in-script Help dialog.
 *
 * v1.3.0:
 * - Rebuilt classification around relic category + exact substat desirability.
 * - Rare no longer makes an irrelevant/mismatched combat stat Legendary.
 * - Adds Recruitment Speed, Recruitment Cost and Resources relic families.
 * - Distinguishes BEST/BRA/OK/DALIG/SAMST substats and category fit.
 * - Cross-category OFF/DEF stats are only preserved according to the explicit rules.
 * - General utility stats only help Recruitment/Resource relics, not OFF/DEF relics.
 *
 * v1.2.0:
 * - Adds read-only Keep / Upgrade / Reroll / Material / Trash recommendations.
 * - Upgrade planning groups relics by family + quality and never sacrifices a
 *   better relic to upgrade a worse one.
 * - Supports optional PP-assisted Shoddy/Sturdy upgrades using one material relic.
 * - Renowned relics are treated as reroll-only because they cannot be upgraded.
 * - Upgrade advice is conservative: only clearly weak duplicates are selected as
 *   materials, while useful rolls are preserved.
 *
 * v1.1.0:
 * - Inventory loading uses RelicSystem.Inventory.init JSON, matching Relic Planner.
 * - Rare detection uses subStat.perfect === true.
 * - Added structured sub-stat ID mapping and same-origin inventory fetching.
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

  const VERSION = '1.4.0';
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

    recommendations: {
      // Shoddy/Sturdy can upgrade with one same-family/same-quality material
      // when the player is willing to spend Premium Points.
      allowPPUpgrades: false,

      // C-tier and better are preserved by default. D/E/F can become material.
      // B-tier and better are considered strong enough to invest upgrade mats in.
      keepThroughTier: 'C',
      upgradeThroughTier: 'B',
      materialFromTier: 'D'
    },

    // Legacy DOM hints retained only as text-fallback helpers. Inventory loading
    // itself uses RelicSystem.Inventory.init JSON.
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

  const RELIC_PROFILES = {
    // DEF (category = BEST)
    halberd:    { category:'DEF', familyGrade:'BEST' },
    longsword:  { category:'DEF', familyGrade:'BEST' },
    longbow:    { category:'DEF', familyGrade:'BEST' },
    banner:     { category:'DEF', familyGrade:'BEST' },

    // OFF (category = BEST)
    greataxe:    { category:'OFF', familyGrade:'BEST' },
    shortspear:  { category:'OFF', familyGrade:'BEST' },
    shortbow:    { category:'OFF', familyGrade:'GOOD' },
    morningstar: { category:'OFF', familyGrade:'GOOD' },
    bonfire:     { category:'OFF', familyGrade:'OK', defFallbackGrade:'WORST' },

    // RECRUITMENT SPEED (category = BEST)
    dummy:      { category:'RECRUITMENT_SPEED', familyGrade:'BEST' },
    horseshoe:  { category:'RECRUITMENT_SPEED', familyGrade:'BEST' },
    wheel:      { category:'RECRUITMENT_SPEED', familyGrade:'OK' },

    // RECRUITMENT COST (category = BAD)
    handsaw:    { category:'RECRUITMENT_COST', familyGrade:'WORST' },
    saddle:     { category:'RECRUITMENT_COST', familyGrade:'BAD' },
    backpack:   { category:'RECRUITMENT_COST', familyGrade:'BAD' },

    // RESOURCES (category = BAD/OK; useful mainly early game)
    chisel:     { category:'RESOURCES', familyGrade:'BEST' },
    axe:        { category:'RESOURCES', familyGrade:'BEST' },
    pickaxe:    { category:'RESOURCES', familyGrade:'BEST' }
  };

  const CATEGORY_LABELS = {
    DEF: 'DEF',
    OFF: 'OFF',
    RECRUITMENT_SPEED: 'Recruitment Speed',
    RECRUITMENT_COST: 'Recruitment Cost',
    RESOURCES: 'Resources'
  };

  const FAMILY_GRADE_MULTIPLIER = {
    BEST: 1.00,
    GOOD: 0.94,
    OK: 0.88,
    BAD: 0.80,
    WORST: 0.72
  };

  const RARITY_ORDER = {
    shoddy: 1,
    sturdy: 2,
    enhanced: 3,
    superior: 4,
    renowned: 5
  };

  const QUALITY_NEXT = {
    shoddy: 'sturdy',
    sturdy: 'enhanced',
    enhanced: 'superior',
    superior: 'renowned',
    renowned: null
  };

  const ACTION_ORDER = {
    UPGRADE: 0,
    KEEP: 1,
    REROLL: 2,
    MATERIAL: 3,
    TRASH: 4,
    REVIEW: 5
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
      .replace(/\bshort bow\b/g, 'shortbow')
      .replace(/\bhand saw\b/g, 'handsaw');

    // Longest/specific names first so resource Axe does not collide with Greataxe.
    const all = [
      'morningstar', 'shortspear', 'greataxe', 'shortbow',
      'halberd', 'longsword', 'longbow', 'banner', 'bonfire',
      'horseshoe', 'handsaw', 'backpack', 'pickaxe', 'dummy',
      'saddle', 'wheel', 'chisel', 'axe'
    ];

    return all.find(x => new RegExp('(?:^|\\s)' + x + '(?:$|\\s)').test(n)) ||
      all.find(x => n.includes(x)) || null;
  }

  function prettyFamily(family) {
    const map = {
      halberd:'Halberd', longsword:'Longsword', longbow:'Longbow', banner:'Banner',
      greataxe:'Greataxe', shortspear:'Shortspear', shortbow:'Shortbow', morningstar:'Morningstar', bonfire:'Bonfire',
      dummy:'Dummy', horseshoe:'Horseshoe', wheel:'Wheel',
      handsaw:'Handsaw', saddle:'Saddle', backpack:'Backpack',
      chisel:'Chisel', axe:'Axe', pickaxe:'Pickaxe'
    };
    return map[family] || titleCase(family || 'Unknown');
  }

  function getRelicProfile(family) {
    return RELIC_PROFILES[family] || null;
  }

  function getSide(family) {
    const profile = getRelicProfile(family);
    if (!profile) return null;
    return profile.category === 'OFF' || profile.category === 'DEF' ? profile.category : null;
  }

  function getCategory(family) {
    return getRelicProfile(family)?.category || null;
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
    bonfire: 'catapult_damage',
    dummy: 'barracks_speed',
    horseshoe: 'stable_speed',
    wheel: 'workshop_speed',
    handsaw: 'barracks_cost',
    saddle: 'stable_cost',
    backpack: 'workshop_cost',
    chisel: 'clay_production',
    axe: 'wood_production',
    pickaxe: 'iron_production'
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

  function normalizeStructuredStat(rawStat, relicFamily, category, source) {
    if (!rawStat) return null;
    const rawText = rawStatText(rawStat);
    const value = parsePercent(rawText);
    let key = '';
    if (source === 'sub' && rawStat.id !== undefined && SUB_STAT_KEYS_BY_ID[String(rawStat.id)]) {
      key = SUB_STAT_KEYS_BY_ID[String(rawStat.id)];
    } else if (source === 'main') {
      key = MAIN_STAT_KEYS[relicFamily] || '';
    }

    if (!key) {
      const fallback = parseStatText(rawText, category === 'OFF' || category === 'DEF' ? category : null);
      if (!fallback) return null;
      fallback.rare = source === 'sub' && rawStat.perfect === true;
      fallback.perfect = fallback.rare;
      fallback.internalKey = '';
      return fallback;
    }

    const parts = internalStatParts(key);
    return {
      text: rawText || ((INTERNAL_LABELS[key] || key) + (value != null ? ' +' + Math.abs(value) + '%' : '')),
      value: value == null ? 0 : Math.abs(value),
      unit: parts.unit,
      bucket: parts.bucket,
      semantic: 'UNRATED',
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
    const profile = getRelicProfile(family);
    if (!family || !profile) return null;

    const category = profile.category;
    const side = getSide(family);
    const rarity = parseRarity(String(raw.quality || '') + ' ' + String(raw.name || ''));
    const mainStat = raw.main_stat ? normalizeStructuredStat(raw.main_stat, family, category, 'main') : null;
    const substats = (raw.sub_stats || []).filter(Boolean).map(stat => normalizeStructuredStat(stat, family, category, 'sub')).filter(Boolean).slice(0, 2);

    const relic = {
      id: String(raw.id), index: index, family: family, familyName: prettyFamily(family),
      profile: profile, category: category, categoryLabel: CATEGORY_LABELS[category] || category,
      familyGrade: profile.familyGrade,
      rarity: rarity, rarityName: rarity ? titleCase(rarity) : (norm(raw.quality) || 'Unknown'),
      name: norm(raw.name) || ((rarity ? titleCase(rarity) + ' ' : '') + prettyFamily(family)),
      side: side, mainStat: mainStat, substats: substats,
      allStats: [mainStat].concat(substats).filter(Boolean), tier:'UNKNOWN',
      tierLabel:TIER_LABELS.UNKNOWN, rawRelevantValue:0, fitScore:0, raw:raw,
      rawText: JSON.stringify(raw),
      future: {
        canUpgrade: rarity ? ['shoddy','sturdy','enhanced','superior'].includes(rarity) : null,
        canReroll: rarity ? ['shoddy','sturdy','enhanced','superior','renowned'].includes(rarity) : null,
        upgradeMaterialPreference: family,
        ppSingleMaterialEligible: rarity ? ['shoddy','sturdy'].includes(rarity) : null
      }
    };

    relic.substats.forEach(stat => {
      const rating = rateSubstatForRelic(relic, stat);
      stat.domain = rating.domain;
      stat.grade = rating.grade;
      stat.fit = rating.fit;
      stat.semantic = rating.semantic;
      stat.score = rating.score;
      stat.reason = rating.reason;
    });

    relic.tier = calculateTier(relic);
    relic.tierLabel = TIER_LABELS[relic.tier] || relic.tier;
    relic.rawRelevantValue = calculateRawRelevantValue(relic);
    relic.fitScore = calculateFitScore(relic);
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
    const relics = Array.from(map.values());
    buildInventoryRecommendations(relics);
    return relics;
  }

  async function scanRelics() {
    const inventoryUrl = buildGameUrl({ screen:'relic_system', mode:'inventory' });
    const html = await fetchHtml(inventoryUrl);
    const relics = extractInventoryRelicsFromHtml(html);
    console.log('Twactics Relic Analyzer inventory relics:', relics);
    return relics;
  }

  // ------------------------------------------------------------
  // TIER ENGINE v1.3 - exact stat desirability + relic/category fit
  // ------------------------------------------------------------

  const SUBSTAT_RULES = {
    // DEF - BEST
    spear_defense:  { domain:'DEF', grade:'BEST' },
    sword_defense:  { domain:'DEF', grade:'BEST' },
    heavy_defense:  { domain:'DEF', grade:'BEST' },
    archer_defense: { domain:'DEF', grade:'BEST' },
    // DEF - GOOD
    spear_offdef:   { domain:'DEF', grade:'GOOD' },
    sword_offdef:   { domain:'DEF', grade:'GOOD' },
    heavy_offdef:   { domain:'DEF', grade:'GOOD' },
    archer_offdef:  { domain:'DEF', grade:'GOOD' },

    // OFF - BEST
    axe_attack:      { domain:'OFF', grade:'BEST' },
    light_offdef:    { domain:'OFF', grade:'BEST' },
    marcher_attack:  { domain:'OFF', grade:'BEST' },
    // OFF - GOOD
    axe_offdef:      { domain:'OFF', grade:'GOOD' },
    marcher_offdef:  { domain:'OFF', grade:'GOOD' },
    ram_damage:      { domain:'OFF', grade:'GOOD' },
    ram_attack:      { domain:'OFF', grade:'GOOD' },
    // OFF - OK
    catapult_damage: { domain:'OFF', grade:'OK' },
    catapult_attack: { domain:'OFF', grade:'OK' },

    // RECRUITMENT
    barracks_speed:  { domain:'RECRUITMENT', grade:'BEST' },
    stable_speed:    { domain:'RECRUITMENT', grade:'BEST' },
    barracks_cost:   { domain:'RECRUITMENT', grade:'GOOD' },
    stable_cost:     { domain:'RECRUITMENT', grade:'GOOD' },
    workshop_speed:  { domain:'RECRUITMENT', grade:'OK' },
    workshop_cost:   { domain:'RECRUITMENT', grade:'OK' },
    academy_speed:   { domain:'RECRUITMENT', grade:'BAD_OK' },
    noble_refund:    { domain:'RECRUITMENT', grade:'BAD_OK' },

    // RESOURCES
    clay_production: { domain:'RESOURCES', grade:'BEST' },
    wood_production: { domain:'RESOURCES', grade:'BEST' },
    iron_production: { domain:'RESOURCES', grade:'BEST' },

    // GENERAL USEFUL
    construction_speed:     { domain:'GENERAL', grade:'GOOD' },
    merchant_travel_speed:  { domain:'GENERAL', grade:'OK' },
    merchant_capacity:      { domain:'GENERAL', grade:'OK' },

    // GENERAL USELESS / BAD COMBAT STATS
    spear_attack:       { domain:'USELESS', grade:'WORST' },
    sword_attack:       { domain:'USELESS', grade:'WORST' },
    heavy_attack:       { domain:'USELESS', grade:'BAD_OK' },
    axe_defense:        { domain:'USELESS', grade:'WORST' },
    light_defense:      { domain:'USELESS', grade:'BAD_OK' },
    catapult_defense:   { domain:'USELESS', grade:'BAD_OK' },
    ram_defense:        { domain:'USELESS', grade:'WORST' },
    archer_attack:      { domain:'USELESS', grade:'WORST' },
    marcher_defense:    { domain:'USELESS', grade:'BAD' },
    haul_capacity:      { domain:'USELESS', grade:'BAD' },
    light_attack:       { domain:'USELESS', grade:'WORST' }
  };

  const BASE_GRADE_SCORE = { BEST:6, GOOD:5, OK:4, BAD_OK:2.5, BAD:2, WORST:0 };

  function inferRuleFromStat(stat) {
    if (stat.internalKey && SUBSTAT_RULES[stat.internalKey]) return SUBSTAT_RULES[stat.internalKey];
    const key = stat.internalKey || '';
    if (SUBSTAT_RULES[key]) return SUBSTAT_RULES[key];
    return { domain:'UNKNOWN', grade:'WORST' };
  }

  function isCombatDomain(domain) {
    return domain === 'OFF' || domain === 'DEF';
  }

  function rateSubstatForRelic(relic, stat) {
    const rule = inferRuleFromStat(stat);
    const category = relic.category;
    const domain = rule.domain;
    const grade = rule.grade;
    const base = BASE_GRADE_SCORE[grade] || 0;
    const rare = !!stat.rare;
    let score = 0;
    let fit = 'IRRELEVANT';
    let semantic = 'IRRELEVANT';
    let reason = '';

    if (domain === category ||
        (domain === 'RECRUITMENT' && (category === 'RECRUITMENT_SPEED' || category === 'RECRUITMENT_COST'))) {
      // Best case: relic and rolled substat serve the same job.
      score = base;
      fit = 'MATCH';
      semantic = grade === 'BEST' ? 'PRIMARY' : 'RELEVANT';
      reason = 'Substat matches the relic category.';
    } else if ((category === 'OFF' || category === 'DEF') && isCombatDomain(domain)) {
      // OFF with DEF or DEF with OFF is normally bad. Only a rare opposing combat
      // roll is worth preserving, but it must never be promoted as a top-tier match.
      if (domain !== category && rare) {
        score = grade === 'BEST' ? 3.0 : grade === 'GOOD' ? 2.5 : 1.5;
        fit = 'RARE_CROSS_COMBAT';
        semantic = 'RARE CROSS';
        reason = 'Rare opposing OFF/DEF stat: worth preserving, but mismatched to this combat relic.';
      } else {
        score = 0;
        fit = 'MISMATCH';
        semantic = 'IRRELEVANT';
        reason = 'OFF/DEF mismatch for this combat relic.';
      }
    } else if ((category === 'RECRUITMENT_SPEED' || category === 'RECRUITMENT_COST' || category === 'RESOURCES') && isCombatDomain(domain)) {
      // Recruitment/resource relics can still be useful with strong combat rolls,
      // but are intentionally valued below a true OFF/DEF relic with the same rolls.
      if (grade === 'BEST' || (rare && (grade === 'BEST' || grade === 'GOOD'))) {
        score = grade === 'BEST' ? 3.5 : 2.75;
        fit = rare ? 'RARE_CROSS_COMBAT' : 'CROSS_COMBAT';
        semantic = 'CROSS USEFUL';
        reason = 'Strong combat substat on a non-combat relic; useful, but weaker than the same roll on a matching combat relic.';
      } else {
        score = 0.75;
        fit = 'WEAK_CROSS';
        semantic = 'LOW VALUE';
        reason = 'Combat substat is not strong enough to carry this non-combat relic.';
      }
    } else if (domain === 'GENERAL') {
      if (category === 'RECRUITMENT_SPEED' || category === 'RECRUITMENT_COST' || category === 'RESOURCES') {
        score = grade === 'GOOD' ? 2.0 : 1.5;
        fit = 'UTILITY';
        semantic = 'UTILITY';
        reason = 'General utility is acceptable on recruitment/resource relics.';
      } else {
        score = 0;
        fit = 'MISMATCH';
        semantic = 'IRRELEVANT';
        reason = 'General utility does not improve OFF/DEF relic quality.';
      }
    } else if (domain === 'RECRUITMENT' && category === 'RESOURCES') {
      score = Math.min(2.25, base * 0.45);
      fit = 'UTILITY';
      semantic = 'UTILITY';
      reason = 'Useful utility, but not the resource relic primary job.';
    } else if (domain === 'RESOURCES' && (category === 'RECRUITMENT_SPEED' || category === 'RECRUITMENT_COST')) {
      score = Math.min(2.25, base * 0.45);
      fit = 'UTILITY';
      semantic = 'UTILITY';
      reason = 'Useful utility, but not the recruitment relic primary job.';
    } else {
      score = 0;
      fit = domain === 'USELESS' ? 'USELESS' : 'IRRELEVANT';
      semantic = 'IRRELEVANT';
      reason = domain === 'USELESS' ? 'Explicitly low-value/useless substat.' : 'Does not meaningfully fit this relic.';
    }

    // Rare is a modifier, never a replacement for fit. Matching rare stats get a
    // strong bonus; useful cross-category rares get a smaller bonus. Irrelevant
    // or useless stats get no automatic tier promotion just because they are rare.
    if (rare) {
      if (fit === 'MATCH') score += 4.0;
      else if (fit === 'CROSS_COMBAT') score += 1.5;
      else if (fit === 'UTILITY') score += 0.75;
    }

    // Family quality only nudges useful scores. It cannot rescue a bad substat.
    if (score > 0) {
      score *= FAMILY_GRADE_MULTIPLIER[relic.familyGrade] || 1;
    }

    return { domain, grade, fit, semantic, score, reason };
  }

  function calculateFitScore(relic) {
    return (relic.substats || []).reduce((sum, s) => sum + Number(s.score || 0), 0);
  }

  function calculateTier(relic) {
    const stats = relic.substats || [];
    const score = calculateFitScore(relic);
    const matching = stats.filter(s => s.fit === 'MATCH');
    const rareMatching = matching.filter(s => s.rare);
    const useful = stats.filter(s => Number(s.score || 0) > 0);

    // Named top tiers require genuinely matching rolls. This prevents a rare
    // Spear attack (or any other mismatched stat) from making Greataxe Legendary.
    if (rareMatching.length >= 2 && matching.length >= 2 && score >= 18) return 'MONEY';
    if (rareMatching.length >= 1 && matching.length >= 2 && score >= 15) return 'FUCK';
    if (rareMatching.length >= 1 && score >= 10) return 'LEGENDARY';

    if (matching.length >= 2 && score >= 10) return 'S';
    if (score >= 8) return 'A';
    if (score >= 6) return 'B';
    if (score >= 4) return 'C';
    if (score >= 2.5) return 'D';
    if (useful.length >= 1 && score > 0) return 'E';
    return 'F';
  }

  function calculateRawRelevantValue(relic) {
    return (relic.substats || []).reduce((sum, s) => {
      if (Number(s.score || 0) > 0) return sum + Math.abs(s.value || 0);
      return sum;
    }, 0);
  }

  // ------------------------------------------------------------
  // UPGRADE / REROLL RECOMMENDATION ENGINE (READ-ONLY)
  // ------------------------------------------------------------

  function tierRank(tier) {
    return TIER_ORDER[tier] !== undefined ? TIER_ORDER[tier] : 999;
  }

  function tierAtLeastAsGood(tier, threshold) {
    return tierRank(tier) <= tierRank(threshold);
  }

  function tierAtLeastAsBad(tier, threshold) {
    return tierRank(tier) >= tierRank(threshold);
  }

  function compareRelicQualityForDecision(a, b) {
    return (tierRank(a.tier) - tierRank(b.tier)) ||
      ((b.rawRelevantValue || 0) - (a.rawRelevantValue || 0)) ||
      ((b.substats || []).filter(s => s.rare).length - (a.substats || []).filter(s => s.rare).length) ||
      String(a.id).localeCompare(String(b.id));
  }

  function compareWorstFirst(a, b) {
    return (tierRank(b.tier) - tierRank(a.tier)) ||
      ((a.rawRelevantValue || 0) - (b.rawRelevantValue || 0)) ||
      ((a.substats || []).filter(s => s.rare).length - (b.substats || []).filter(s => s.rare).length) ||
      String(a.id).localeCompare(String(b.id));
  }

  function getUpgradeMaterialCount(rarity) {
    if ((rarity === 'shoddy' || rarity === 'sturdy') && CONFIG.recommendations.allowPPUpgrades) {
      return 1;
    }
    return 2;
  }

  function hasProtectedCrossRoll(relic) {
    return (relic.substats || []).some(s =>
      s.fit === 'RARE_CROSS_COMBAT' ||
      s.fit === 'CROSS_COMBAT'
    );
  }

  function baseRecommendation(relic) {
    const rarity = relic.rarity;
    const nextQuality = QUALITY_NEXT[rarity] || null;

    if (!rarity) {
      return { action:'REVIEW', reason:'Unknown quality; review manually.', nextQuality:null, materialIds:[] };
    }

    // Explicit preservation rules:
    // - OFF/DEF relic + rare opposing combat stat: keep as-is.
    // - Recruitment/resource relic + BEST combat stat, or rare BEST/GOOD combat stat: keep.
    // These rolls may have a modest tier because the category is mismatched, but they
    // are still too useful to reroll or feed as material automatically.
    if (hasProtectedCrossRoll(relic)) {
      return {
        action:'KEEP',
        reason:'Protected cross-category combat roll. Keep it even though the relic/category match is not ideal.',
        nextQuality:nextQuality,
        materialIds:[]
      };
    }

    if (rarity === 'renowned') {
      if (tierAtLeastAsGood(relic.tier, CONFIG.recommendations.keepThroughTier)) {
        return {
          action:'KEEP',
          reason:'Renowned cannot be upgraded and this roll is useful enough to keep.',
          nextQuality:null,
          materialIds:[]
        };
      }
      return {
        action:'REROLL',
        reason:'Renowned cannot be upgraded; weak roll, so reroll is the improvement path.',
        nextQuality:null,
        materialIds:[]
      };
    }

    if (tierAtLeastAsGood(relic.tier, CONFIG.recommendations.keepThroughTier)) {
      return {
        action:'KEEP',
        reason:'Useful roll. Preserve it as a potential upgrade target.',
        nextQuality:nextQuality,
        materialIds:[]
      };
    }

    if (relic.tier === 'F') {
      return {
        action:'TRASH',
        reason:'No useful rolled substats. Prefer material use when a valid upgrade target exists.',
        nextQuality:nextQuality,
        materialIds:[]
      };
    }

    return {
      action:'REROLL',
      reason:'Weak roll and not currently needed as upgrade material.',
      nextQuality:nextQuality,
      materialIds:[]
    };
  }

  function buildInventoryRecommendations(relics) {
    (relics || []).forEach(relic => {
      relic.recommendation = baseRecommendation(relic);
    });

    const groups = new Map();
    (relics || []).forEach(relic => {
      if (!relic.rarity || relic.rarity === 'renowned') return;
      const key = relic.family + '::' + relic.rarity;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(relic);
    });

    groups.forEach(group => {
      if (group.length < 2) return;

      const sortedBest = group.slice().sort(compareRelicQualityForDecision);
      const targets = sortedBest.filter(r => tierAtLeastAsGood(r.tier, CONFIG.recommendations.upgradeThroughTier));
      if (!targets.length) return;

      // One upgrade target per family+quality bucket for now. This prevents a
      // recommendation chain from trying to consume the same material twice.
      const target = targets[0];
      const needed = getUpgradeMaterialCount(target.rarity);

      const candidateMaterials = group
        .filter(r => r.id !== target.id)
        .filter(r => tierAtLeastAsBad(r.tier, CONFIG.recommendations.materialFromTier))
        .sort(compareWorstFirst);

      if (candidateMaterials.length < needed) return;

      const chosen = candidateMaterials.slice(0, needed);
      const nextQuality = QUALITY_NEXT[target.rarity];
      target.recommendation = {
        action:'UPGRADE',
        reason:'Strong roll with enough clearly weaker same-family/same-quality relics available as material.',
        nextQuality:nextQuality,
        materialIds:chosen.map(r => r.id),
        materialNames:chosen.map(r => r.name),
        ppAssisted:(target.rarity === 'shoddy' || target.rarity === 'sturdy') && CONFIG.recommendations.allowPPUpgrades,
        requiredMaterials:needed
      };

      chosen.forEach(material => {
        material.recommendation = {
          action:'MATERIAL',
          reason:'Selected as a weaker material relic for #' + target.id + ' (' + target.name + ').',
          targetId:target.id,
          targetName:target.name,
          nextQuality:null,
          materialIds:[]
        };
      });
    });

    return relics;
  }

  function recommendationText(relic) {
    const rec = relic && relic.recommendation;
    if (!rec) return 'Review';
    if (rec.action === 'UPGRADE') {
      const mats = (rec.materialIds || []).map(id => '#' + id).join(', ');
      return 'Upgrade to ' + titleCase(rec.nextQuality || '') +
        (mats ? ' using ' + mats : '') +
        (rec.ppAssisted ? ' + PP' : '');
    }
    if (rec.action === 'MATERIAL') return 'Material for #' + (rec.targetId || '?');
    if (rec.action === 'REROLL') return 'Reroll';
    if (rec.action === 'KEEP') return 'Keep';
    if (rec.action === 'TRASH') return 'Trash / spare material';
    return 'Review';
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
      s.domain === 'OFF' || s.domain === 'DEF'
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
  // INVENTORY PAGE / VISUAL FOCUS HELPERS
  // ------------------------------------------------------------

  const FOCUS_STYLE_ID = 'twra-inventory-focus-style';
  const FOCUS_BAR_ID = 'twra-inventory-focus-bar';

  function isRelicInventoryPage() {
    return getParam('screen') === 'relic_system' && getParam('mode') === 'inventory';
  }

  function ensureRelicInventoryPage() {
    if (isRelicInventoryPage()) return true;
    window.location.href = buildGameUrl({ screen:'relic_system', mode:'inventory' });
    return false;
  }

  function normalizeMatchText(s) {
    return lower(s).replace(/[^a-z0-9%+.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function statMatchTokens(stat) {
    if (!stat) return [];
    const tokens = [];
    const label = normalizeMatchText(stat.text || INTERNAL_LABELS[stat.internalKey] || stat.internalKey || '');
    if (label) tokens.push(label.replace(/[+-]?\d+(?:[.,]\d+)?\s*%/g, '').trim());
    if (stat.internalKey && INTERNAL_LABELS[stat.internalKey]) tokens.push(normalizeMatchText(INTERNAL_LABELS[stat.internalKey]));
    return Array.from(new Set(tokens.filter(Boolean)));
  }

  function inventoryCardCandidates() {
    const selector = [
      '[data-relic-id]', '[data-item-id]', '[data-id]',
      '.relic', '.relic-item', '.relic-card', '.inventory-item', '.item-card',
      '.relic_inventory_item', '.relic-item-wrapper', '.item'
    ].join(',');
    const all = Array.from(document.querySelectorAll(selector))
      .filter(el => !el.closest('#' + UI_ID) && !el.closest('#' + FOCUS_BAR_ID));

    // Prefer leaf-ish wrappers to avoid hiding large inventory containers.
    return all.filter(el => {
      const txt = norm(el.textContent || '');
      if (!txt || txt.length > 1800) return false;
      return !all.some(other => other !== el && el.contains(other) && norm(other.textContent || '').length >= 8);
    });
  }

  function scoreInventoryElementForRelic(el, relic) {
    if (!el || !relic) return -1;
    const html = lower(el.outerHTML || '');
    const text = normalizeMatchText(el.textContent || '');
    let score = 0;

    const id = String(relic.id || '');
    if (id && (
      String(el.dataset?.relicId || '') === id ||
      String(el.dataset?.itemId || '') === id ||
      String(el.dataset?.id || '') === id ||
      html.includes('"' + id + '"') || html.includes("'" + id + "'") ||
      html.includes('relic_id=' + id) || html.includes('relicid=' + id)
    )) score += 100;

    const family = normalizeMatchText(relic.familyName || relic.family || '');
    const rarity = normalizeMatchText(relic.rarityName || relic.rarity || '');
    if (family && text.includes(family)) score += 20;
    if (rarity && text.includes(rarity)) score += 14;

    (relic.substats || []).forEach(stat => {
      const tokens = statMatchTokens(stat);
      if (tokens.some(t => t && text.includes(t))) score += 18;
      if (stat.value != null && text.includes(String(Math.abs(stat.value)))) score += 2;
    });

    return score;
  }

  function findInventoryElementForRelic(relic, candidates) {
    const pool = candidates || inventoryCardCandidates();
    let best = null;
    let bestScore = -1;
    pool.forEach(el => {
      const score = scoreInventoryElementForRelic(el, relic);
      if (score > bestScore) { best = el; bestScore = score; }
    });
    // ID match is decisive. Fallback requires quality/family plus at least one useful text match.
    return bestScore >= 48 ? best : null;
  }

  function findOptionValue(select, needles) {
    const wanted = (needles || []).map(normalizeMatchText).filter(Boolean);
    if (!wanted.length) return null;
    const options = Array.from(select.options || []);
    let best = null;
    let bestScore = 0;
    options.forEach(opt => {
      const text = normalizeMatchText(opt.textContent || opt.label || opt.value || '');
      let score = 0;
      wanted.forEach(n => {
        if (text === n) score = Math.max(score, 100);
        else if (text.includes(n) || n.includes(text)) score = Math.max(score, 65);
      });
      if (score > bestScore) { best = opt; bestScore = score; }
    });
    return bestScore >= 65 && best ? best.value : null;
  }

  function applyNativeInventoryFilters(relic) {
    // Best-effort integration with the game's own inventory filters. We do not
    // assume fixed field names: controls are detected from their option text.
    const selects = Array.from(document.querySelectorAll('select'))
      .filter(sel => !sel.closest('#' + UI_ID) && !sel.closest('#' + FOCUS_BAR_ID));
    const used = new Set();
    const applied = [];

    function setFirstMatching(needles, label) {
      for (const sel of selects) {
        if (used.has(sel)) continue;
        const value = findOptionValue(sel, needles);
        if (value == null) continue;
        sel.value = value;
        used.add(sel);
        applied.push(label);
        return sel;
      }
      return null;
    }

    const changed = [];
    const quality = setFirstMatching([relic.rarityName, relic.rarity], 'quality');
    if (quality) changed.push(quality);
    const type = setFirstMatching([relic.familyName, relic.family], 'type');
    if (type) changed.push(type);

    (relic.substats || []).forEach((stat, idx) => {
      const labels = statMatchTokens(stat);
      const sel = setFirstMatching(labels, 'substat ' + (idx + 1));
      if (sel) changed.push(sel);
    });

    // Dispatch after all values are set so client-side filters can recalculate once.
    changed.forEach(sel => {
      sel.dispatchEvent(new Event('input', { bubbles:true }));
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    });

    return { applied, count:applied.length };
  }

  function waitForInventoryRefresh(ms) {
    return new Promise(resolve => setTimeout(resolve, ms || 450));
  }

  function clearInventoryFocus() {
    document.getElementById(FOCUS_STYLE_ID)?.remove();
    document.getElementById(FOCUS_BAR_ID)?.remove();
    document.querySelectorAll('[data-twra-hidden="1"]').forEach(el => {
      el.style.removeProperty('display');
      delete el.dataset.twraHidden;
    });
    document.querySelectorAll('[data-twra-focus]').forEach(el => {
      delete el.dataset.twraFocus;
      el.classList.remove('twra-inv-target', 'twra-inv-material');
    });
  }

  function installInventoryFocusStyle() {
    if (document.getElementById(FOCUS_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = FOCUS_STYLE_ID;
    style.textContent = `
      .twra-inv-target {
        outline: 5px solid #38a34a !important;
        outline-offset: -2px !important;
        box-shadow: 0 0 0 4px rgba(56,163,74,.28), 0 0 22px rgba(56,163,74,.75) !important;
        position: relative !important;
        z-index: 8 !important;
      }
      .twra-inv-material {
        outline: 5px solid #d18a00 !important;
        outline-offset: -2px !important;
        box-shadow: 0 0 0 4px rgba(209,138,0,.24), 0 0 22px rgba(209,138,0,.65) !important;
        position: relative !important;
        z-index: 7 !important;
      }
    `;
    document.head.appendChild(style);
  }

  function createFocusBar(target, materials, foundTarget, foundMaterials, nativeFilters) {
    document.getElementById(FOCUS_BAR_ID)?.remove();
    const bar = document.createElement('div');
    bar.id = FOCUS_BAR_ID;
    bar.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;background:#f4e4bc;border:2px solid #7d510f;box-shadow:0 6px 22px rgba(0,0,0,.45);padding:9px 12px;font:12px Arial;color:#2c1908;max-width:min(900px,calc(100vw - 30px));';
    const materialText = materials.length ? materials.map(x => x.name).join(', ') : 'none';
    bar.innerHTML = `
      <b>Upgrade focus:</b> <span style="color:#237532;font-weight:bold">TARGET: ${cssEscape(target.name)}</span>
      &nbsp; | &nbsp;<span style="color:#9a6500;font-weight:bold">MATERIAL: ${cssEscape(materialText)}</span>
      &nbsp; | &nbsp;Found ${foundTarget ? 'target' : 'no target'} + ${foundMaterials}/${materials.length} material
      &nbsp; | &nbsp;Native filters: ${cssEscape((nativeFilters?.applied || []).join(', ') || 'not detected')}
      &nbsp;<button type="button" data-twra-clear-focus style="font:inherit;border:1px solid #7d510f;background:#f7edd4;padding:3px 7px;cursor:pointer">Show all relics</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('[data-twra-clear-focus]').addEventListener('click', clearInventoryFocus);
  }

  function focusUpgradeSet(target, allRelics, nativeFilters) {
    clearInventoryFocus();
    if (!target) return { targetFound:false, materialFound:0 };

    const materialIds = new Set((target.recommendation?.materialIds || []).map(String));
    const materials = (allRelics || []).filter(r => materialIds.has(String(r.id)));
    const wanted = [target].concat(materials);
    const candidates = inventoryCardCandidates();
    const matched = new Map();

    wanted.forEach(relic => {
      const el = findInventoryElementForRelic(relic, candidates.filter(x => !Array.from(matched.values()).includes(x)));
      if (el) matched.set(String(relic.id), el);
    });

    installInventoryFocusStyle();

    // Hide unrelated relic cards. This is deliberately DOM-only: no game action is performed.
    candidates.forEach(el => {
      if (!Array.from(matched.values()).includes(el)) {
        el.dataset.twraHidden = '1';
        el.style.setProperty('display', 'none', 'important');
      }
    });

    const targetEl = matched.get(String(target.id));
    if (targetEl) {
      targetEl.dataset.twraFocus = 'target';
      targetEl.classList.add('twra-inv-target');
      targetEl.scrollIntoView({ behavior:'smooth', block:'center' });
    }
    materials.forEach(m => {
      const el = matched.get(String(m.id));
      if (el) {
        el.dataset.twraFocus = 'material';
        el.classList.add('twra-inv-material');
      }
    });

    const foundMaterials = materials.filter(m => matched.has(String(m.id))).length;
    createFocusBar(target, materials, !!targetEl, foundMaterials, nativeFilters);
    return { targetFound:!!targetEl, materialFound:foundMaterials, materialTotal:materials.length };
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
          width: min(1180px, calc(100vw - 36px));
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
        #${UI_ID} .twra-action { display:inline-block; padding:2px 5px; border:1px solid rgba(0,0,0,.25); border-radius:2px; font-weight:bold; white-space:nowrap; }
        #${UI_ID} .twra-action-upgrade { background:#bfe6a8; }
        #${UI_ID} .twra-action-keep { background:#d8ef99; }
        #${UI_ID} .twra-action-reroll { background:#ffe2a8; }
        #${UI_ID} .twra-action-material { background:#d5dce6; }
        #${UI_ID} .twra-action-trash { background:#e1c4c4; }
        #${UI_ID} .twra-action-review { background:#eee; }
        #${UI_ID} .twra-reason { max-width:260px; line-height:1.35; }
        #${UI_ID} .twra-rare { color: #762da8; font-weight: bold; }
        #${UI_ID} .twra-muted { opacity: .68; }
        #${UI_ID} .twra-empty { padding: 16px; line-height: 1.55; }
        #${UI_ID} .twra-side { font-weight: bold; }
        #${UI_ID} .twra-stat { white-space: normal; }
        #${UI_ID} .twra-legend { padding:7px 10px; border-bottom:1px solid #b68c4b; background:#f1dfba; display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
        #${UI_ID} .twra-legend-label { font-weight:bold; margin-right:3px; }
        #${UI_ID} .twra-help-overlay { position:absolute; inset:0; z-index:20; background:rgba(0,0,0,.45); display:flex; align-items:flex-start; justify-content:center; padding:34px 20px; overflow:auto; }
        #${UI_ID} .twra-help-dialog { width:min(900px,100%); background:#f7edda; border:2px solid #7d510f; box-shadow:0 8px 30px rgba(0,0,0,.5); }
        #${UI_ID} .twra-help-head { display:flex; gap:8px; align-items:center; padding:9px 11px; background:#d9bd83; border-bottom:1px solid #7d510f; }
        #${UI_ID} .twra-help-title { font-weight:bold; font-size:14px; flex:1; }
        #${UI_ID} .twra-help-body { padding:12px 14px; max-height:70vh; overflow:auto; line-height:1.5; }
        #${UI_ID} .twra-help-body h3 { margin:12px 0 5px; }
        #${UI_ID} .twra-help-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px 18px; }
        #${UI_ID} .twra-locate { margin-top:4px; white-space:nowrap; }
        #${UI_ID} .twra-foot {
          border-top: 1px solid #b68c4b;
          background: #ead4a8;
          padding: 6px 10px;
          font-size: 11px;
        }
      </style>
      <div class="twra-head">
        <div class="twra-title">Twactics Relic Analyzer v${VERSION}</div>
        <button type="button" data-action="help">Help</button>
        <button type="button" data-action="rescan">Rescan</button>
        <button type="button" data-action="close">×</button>
      </div>
      <div class="twra-toolbar">
        <label>Category</label>
        <select data-filter="side">
          <option value="ALL">ALL</option>
          <option value="DEF">DEF</option>
          <option value="OFF">OFF</option>
          <option value="RECRUITMENT_SPEED">Recruitment Speed</option>
          <option value="RECRUITMENT_COST">Recruitment Cost</option>
          <option value="RESOURCES">Resources</option>
        </select>
        <label>Sort</label>
        <select data-filter="sort">
          <option value="tier">Tier</option>
          <option value="rarity">Rarity</option>
          <option value="family">Family</option>
          <option value="raw">Raw relevant value</option>
          <option value="action">Recommendation</option>
        </select>
        <label title="For Shoddy/Sturdy: allow one same-family/same-quality material relic plus Premium Points instead of two materials.">
          <input type="checkbox" data-filter="pp" ${CONFIG.recommendations.allowPPUpgrades ? 'checked' : ''}> PP upgrade Shoddy/Sturdy
        </label>
        <span class="twra-muted" data-role="count"></span>
      </div>
      <div class="twra-legend">
        <span class="twra-legend-label">Tiers:</span>
        ${['MONEY','FUCK','LEGENDARY','S','A','B','C','D','E','F'].map(t => `<span class="twra-tier ${tierClass(t)}">${cssEscape(TIER_LABELS[t])}</span>`).join(' ')}
      </div>
      <div class="twra-body" data-role="body"></div>
      <div class="twra-foot">
        ★ = rare/perfect substat from game data. Recommendations are advisory only. Materials are only selected from clearly weaker same-family + same-quality relics. No upgrade, reroll, destroy, or other game action is performed.
      </div>
    `;

    document.body.appendChild(root);
    makeDraggable(root, root.querySelector('.twra-head'));

    const state = { relics };

    function redraw() {
      const side = root.querySelector('[data-filter="side"]').value;
      const sort = root.querySelector('[data-filter="sort"]').value;
      const ppBox = root.querySelector('[data-filter="pp"]');
      CONFIG.recommendations.allowPPUpgrades = !!(ppBox && ppBox.checked);
      buildInventoryRecommendations(state.relics);
      let rows = state.relics.slice();

      if (side !== 'ALL') rows = rows.filter(r => r.category === side);

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
        if (sort === 'action') return (ACTION_ORDER[a.recommendation?.action] ?? 99) - (ACTION_ORDER[b.recommendation?.action] ?? 99) || (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
        return 0;
      });

      root.querySelector('[data-role="count"]').textContent = `${rows.length} relic${rows.length === 1 ? '' : 's'}`;
      const body = root.querySelector('[data-role="body"]');

      if (!rows.length) {
        body.innerHTML = `
          <div class="twra-empty">
            <b>No supported relics found.</b><br><br>
            The Treasury inventory was loaded, but no supported combat relics were found.<br>
            Supported families: DEF/OFF combat relics plus Dummy, Horseshoe, Wheel, Handsaw, Saddle, Backpack, Chisel, Axe and Pickaxe.
          </div>`;
        return;
      }

      body.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Category</th>
              <th>Relic</th>
              <th>Main stat</th>
              <th>Substat 1</th>
              <th>Substat 2</th>
              <th>Fit score</th>
              <th>Recommendation</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, idx) => `
              <tr data-row="${idx}">
                <td><span class="twra-tier ${tierClass(r.tier)}">${cssEscape(r.tierLabel)}</span></td>
                <td class="twra-side">${cssEscape(r.categoryLabel)}</td>
                <td>
                  <b>${cssEscape(r.name)}</b><br>
                  <span class="twra-muted">${cssEscape(r.id)}</span>
                </td>
                <td class="twra-stat">${formatStat(r.mainStat)}</td>
                <td class="twra-stat">${formatStat(r.substats[0])}</td>
                <td class="twra-stat">${formatStat(r.substats[1])}</td>
                <td>${r.fitScore.toFixed(1)}<br><span class="twra-muted">${r.rawRelevantValue}% rolled</span></td>
                <td>
                  <span class="twra-action twra-action-${String(r.recommendation?.action || 'review').toLowerCase()}">${cssEscape(recommendationText(r))}</span>
                  ${(r.recommendation?.action === 'UPGRADE' || r.recommendation?.action === 'MATERIAL') ? `<br><button type="button" class="twra-locate" data-action="focus-set" data-relic-id="${cssEscape(r.recommendation?.action === 'MATERIAL' ? r.recommendation.targetId : r.id)}">Show in inventory</button>` : ''}
                </td>
                <td class="twra-reason">${cssEscape(r.recommendation?.reason || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    }

    function formatStat(s) {
      if (!s) return '<span class="twra-muted">—</span>';
      const cls = s.rare ? 'twra-rare' : '';
      const tags = [];
      if (s.grade) tags.push(s.grade.replace('_', '/'));
      if (s.semantic && s.semantic !== 'IRRELEVANT') tags.push(s.semantic);
      const tag = tags.length ? ` <span class="twra-muted">[${cssEscape(tags.join(' · '))}]</span>` : '';
      return `<span class="${cls}">${s.rare ? '★ ' : ''}${cssEscape(s.text)}</span>${tag}`;
    }

    function showHelp() {
      root.querySelector('.twra-help-overlay')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'twra-help-overlay';
      overlay.innerHTML = `
        <div class="twra-help-dialog">
          <div class="twra-help-head">
            <div class="twra-help-title">How Twactics Relic Analyzer ranks relics</div>
            <button type="button" data-action="close-help">×</button>
          </div>
          <div class="twra-help-body">
            <b>Core rule:</b> a rare stat is only valuable when the stat itself fits the relic. Rare does not turn a bad or mismatched stat into a top-tier relic.

            <h3>Relic categories</h3>
            <div class="twra-help-grid">
              <div><b>DEF — best category</b><br>Halberd, Longsword, Longbow, Banner = BEST.</div>
              <div><b>OFF — best category</b><br>Greataxe & Shortspear = BEST; Shortbow & Morningstar = GOOD; Bonfire = OK.</div>
              <div><b>Recruitment Speed — best category</b><br>Dummy & Horseshoe = BEST; Wheel = OK.</div>
              <div><b>Recruitment Cost — weak category</b><br>Handsaw = WORST; Saddle & Backpack = BAD.</div>
              <div><b>Resources — bad/OK overall</b><br>Chisel, Axe and Pickaxe are the best relics inside this category; mainly useful early game.</div>
            </div>

            <h3>Best matching substats</h3>
            <b>DEF BEST:</b> Spear defense, Sword defense, Heavy cavalry defense, Archer defense.<br>
            <b>DEF GOOD:</b> the corresponding offense+defense stats.<br><br>
            <b>OFF BEST:</b> Axeman attack, Light cavalry offense+defense, Mounted archer attack.<br>
            <b>OFF GOOD:</b> Axeman offense+defense, Mounted archer offense+defense, Ram building damage, Ram attack.<br>
            <b>OFF OK:</b> Catapult building damage and Catapult attack.<br><br>
            <b>Recruitment BEST:</b> Barracks and Stable recruit speed. <b>GOOD:</b> Barracks/Stable recruit costs. <b>OK:</b> Workshop speed/cost. Academy speed and noble recruit cost are low value.<br>
            <b>Resources BEST:</b> Clay, wood and iron production.

            <h3>Cross-category rules</h3>
            OFF relic + DEF substat, or DEF relic + OFF substat, is normally a mismatch. It is only specially preserved when the cross-combat stat is rare. Recruitment/Resource relics may still be worth keeping when they roll a BEST combat stat, or a rare BEST/GOOD combat stat. General utility only helps Recruitment/Resource relics, not OFF/DEF relics.

            <h3>Tiers</h3>
            <b>Quadruple Oil Money / Fuck Me In The Ass / Legendary</b> require genuinely strong matching rolls; rare alone is not enough. S through F then descend by total fit score and number/quality of useful matching substats. Family quality nudges useful scores but cannot rescue a bad stat.

            <h3>Upgrade focus</h3>
            For an UPGRADE recommendation, click <b>Show in inventory</b>. The target is highlighted in green, material relics in amber, and unrelated visible relic cards are hidden. Twactics first tries to set the game's own quality, type and substat dropdown filters when those controls can be detected from their option text. Matching then uses the game's relic ID if exposed in HTML and otherwise falls back to quality + type + substats. Use <b>Show all relics</b> to restore the inventory.
          </div>
        </div>`;
      root.appendChild(overlay);
      overlay.addEventListener('click', e => {
        if (e.target.matches('[data-action="close-help"]') || e.target === overlay) overlay.remove();
      });
    }

    root.addEventListener('change', e => {
      if (e.target.matches('[data-filter]')) redraw();
    });

    root.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;

      if (btn.dataset.action === 'help') { showHelp(); return; }
      if (btn.dataset.action === 'focus-set') {
        const targetId = String(btn.dataset.relicId || '');
        const target = state.relics.find(r => String(r.id) === targetId);
        if (target) {
          const nativeFilters = applyNativeInventoryFilters(target);
          await waitForInventoryRefresh(550);
          const result = focusUpgradeSet(target, state.relics, nativeFilters);
          if (!result.targetFound) {
            alert('Twactics could not identify the target relic card after applying any detectable game filters. Matching uses ID first and quality/type/substats second. If the game uses a different custom filter UI on your world, send me the inventory HTML/Inspect snippet and I can wire that exact control in.');
          }
        }
        return;
      }
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
      if (!ensureRelicInventoryPage()) return;
      const relics = await scanRelics();
      const ui = render(relics);

      window.__TW_RELIC_ANALYZER_V1__ = {
        version: VERSION, relics, config: CONFIG, scan: scanRelics, calculateTier,
        buildInventoryRecommendations, recommendationText, focusUpgradeSet, clearInventoryFocus,
        evaluateAgainstCurrentStats, effectiveUnitAttack, effectiveUnitDefense,
        inventoryMethod: 'RelicSystem.Inventory.init JSON',
        destroy() {
          document.getElementById(UI_ID)?.remove();
          delete window.__TW_RELIC_ANALYZER_V1__;
        },
        debug() {
          console.table(this.relics.map(r => ({
            id:r.id, name:r.name, category:r.categoryLabel, familyGrade:r.familyGrade, rarity:r.rarityName, tier:r.tierLabel, score:r.fitScore,
            main:r.mainStat?.text || '', sub1:r.substats[0]?.text || '',
            sub1Rare:!!r.substats[0]?.rare, sub2:r.substats[1]?.text || '',
            sub2Rare:!!r.substats[1]?.rare, recommendation:recommendationText(r)
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
