/*
 * Tribal Wars Relic Analyzer v1.0.0
 * ------------------------------------------------------------
 * Purpose:
 * - Scan relics visible in the current Tribal Wars relic/inventory UI
 * - Separate OFF and DEF relic families
 * - Detect main stat + substats where possible
 * - Detect rare (purple) substats where possible
 * - Classify relics into custom tiers
 * - Keep offense+defense / attack / defense as separate 20% buckets
 * - Show a sortable analyzer overlay
 *
 * IMPORTANT:
 * This is v1. The exact Tribal Wars relic DOM can differ between worlds/UI
 * versions. The scanner is intentionally defensive and text-driven.
 * If the game's DOM uses different wrappers, adjust SELECTORS below.
 *
 * Future v2 groundwork already included:
 * - rarity parsing (Shoddy / Sturdy / Enhanced / Superior / Renowned)
 * - normalized relic family
 * - relic object model suitable for upgrade / reroll recommendations
 *
 * OFF relic families:
 * - Greataxe
 * - Shortspear
 * - Bonfire
 * - Morningstar
 * - Shortbow
 *
 * DEF relic families:
 * - Halberd
 * - Longsword
 * - Banner
 * - Longbow
 *
 * Stat cap model:
 * - unit.both     max 20
 * - unit.attack   max 20
 * - unit.defense  max 20
 * Therefore a unit can theoretically have +40% effective attack from
 * +20% offense&defense and +20% attack.
 *
 * Usage:
 * 1. Open the relic inventory / relic screen.
 * 2. Make sure the relics you want analyzed are loaded/visible.
 * 3. Paste/run this script in DevTools console OR wrap as a userscript.
 * 4. The analyzer window appears in the top-right.
 */

(function () {
  'use strict';

  if (window.__TW_RELIC_ANALYZER_V1__) {
    try { window.__TW_RELIC_ANALYZER_V1__.destroy(); } catch (e) {}
  }

  const VERSION = '1.0.0';
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
  // RARE DETECTION
  // ------------------------------------------------------------

  function rgbFromCssColor(css) {
    if (!css) return null;

    let m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };

    m = css.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    return null;
  }

  function looksPurple(el) {
    if (!el || !(el instanceof Element)) return false;

    const classes = lower(el.className || '');
    if (CONFIG.rareClassHints.some(h => classes.includes(h))) return true;

    let cur = el;
    for (let i = 0; i < 3 && cur; i++, cur = cur.parentElement) {
      try {
        const rgb = rgbFromCssColor(getComputedStyle(cur).color);
        if (!rgb) continue;

        const cfg = CONFIG.rareColor;
        if (
          rgb.b >= cfg.minBlue &&
          rgb.r >= cfg.minRed &&
          rgb.b - rgb.g >= cfg.blueMinusGreen &&
          rgb.r - rgb.g >= cfg.redMinusGreen
        ) return true;
      } catch (e) {}
    }

    return false;
  }

  // ------------------------------------------------------------
  // DOM SCANNING
  // ------------------------------------------------------------

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function candidateContainers() {
    const found = [];
    const seen = new Set();

    for (const sel of CONFIG.selectors) {
      document.querySelectorAll(sel).forEach(el => {
        if (!seen.has(el) && isVisible(el)) {
          seen.add(el);
          found.push(el);
        }
      });
    }

    if (found.length) return found;

    // Fallback: find text nodes mentioning known relic families, then climb.
    const familyTerms = [
      'Halberd', 'Longsword', 'Banner', 'Longbow',
      'Greataxe', 'Great Axe', 'Shortspear', 'Short Spear',
      'Bonfire', 'Morningstar', 'Morning Star', 'Shortbow', 'Short Bow'
    ];

    document.querySelectorAll('div, li, tr, td').forEach(el => {
      if (!isVisible(el)) return;
      const text = norm(el.innerText || '');
      if (!text || text.length > 1800) return;
      if (!familyTerms.some(term => text.includes(term))) return;

      const family = familyCanonical(text);
      if (!family) return;

      // Prefer a reasonably compact container with multiple percentages.
      const pctCount = (text.match(/%/g) || []).length;
      if (pctCount < 1) return;

      if (!seen.has(el)) {
        seen.add(el);
        found.push(el);
      }
    });

    return reduceNestedCandidates(found);
  }

  function reduceNestedCandidates(nodes) {
    // Keep the smallest useful container when nested candidates represent same relic.
    const arr = nodes.filter(Boolean);
    return arr.filter(el => {
      return !arr.some(other => {
        if (other === el) return false;
        if (!el.contains(other)) return false;
        const a = norm(el.innerText || '');
        const b = norm(other.innerText || '');
        return familyCanonical(a) === familyCanonical(b) && b.length >= 20;
      });
    });
  }

  function lineElements(container) {
    const all = Array.from(container.querySelectorAll('*'));
    const result = [];

    for (const el of all) {
      if (!isVisible(el)) continue;
      const text = norm(el.textContent || '');
      if (!text || !text.includes('%')) continue;
      if (text.length > 220) continue;

      // Avoid taking parent wrappers if a child already contains essentially same text.
      const childSame = Array.from(el.children).some(c => {
        const ct = norm(c.textContent || '');
        return ct && ct.includes('%') && ct === text;
      });
      if (childSame) continue;

      result.push(el);
    }

    // Deduplicate exact texts but preserve multiple identical stat lines if they are distinct.
    return result;
  }

  function splitTextIntoStatLines(text) {
    return norm(text)
      .split(/\n|\r|•|\u2022/)
      .map(norm)
      .filter(x => x.includes('%'));
  }

  function extractStats(container, side) {
    const stats = [];
    const elems = lineElements(container);

    if (elems.length) {
      for (const el of elems) {
        const text = norm(el.textContent || '');
        if (!text.includes('%')) continue;

        // Sometimes one element contains multiple stats.
        const lines = splitTextIntoStatLines(text);
        const useLines = lines.length > 1 ? lines : [text];

        for (const line of useLines) {
          const stat = parseStatText(line, side);
          if (stat.value == null) continue;
          stat.rare = looksPurple(el);
          stat.sourceElement = el;
          stats.push(stat);
        }
      }
    }

    // Fallback if DOM line extraction fails.
    if (!stats.length) {
      splitTextIntoStatLines(container.innerText || '').forEach(line => {
        const stat = parseStatText(line, side);
        if (stat.value != null) stats.push(stat);
      });
    }

    return dedupeStats(stats);
  }

  function dedupeStats(stats) {
    const out = [];
    const counts = new Map();

    for (const s of stats) {
      const key = `${lower(s.text)}|${s.rare ? 1 : 0}`;
      const count = counts.get(key) || 0;
      // Permit at most 2 identical occurrences; enough for real duplicate rolls without DOM spam.
      if (count >= 2) continue;
      counts.set(key, count + 1);
      out.push(s);
    }

    return out;
  }

  function inferMainAndSubs(stats, rarity, family) {
    if (!stats.length) return { mainStat: null, substats: [] };

    // Best effort strategy:
    // 1) Rare cannot be main stat, so purple lines are substats.
    // 2) If 3+ stats are visible, pick one likely main stat based on relic family/unit theme
    //    and rarity percentage shape; remaining two strongest candidates become substats.
    // 3) If only 2 stats are visible, treat both as substats because some UIs hide main stat.

    if (stats.length <= 2) {
      return { mainStat: null, substats: stats.slice(0, 2) };
    }

    const expectedMainUnits = {
      halberd: ['spear'],
      longsword: ['sword'],
      banner: ['heavy_cavalry'],
      longbow: ['archer'],
      greataxe: ['axe'],
      shortspear: ['spear'],
      bonfire: [],
      morningstar: ['light_cavalry', 'heavy_cavalry'],
      shortbow: ['archer', 'mounted_archer']
    };

    const expected = expectedMainUnits[family] || [];
    const nonRare = stats.filter(s => !s.rare);

    let main = nonRare.find(s =>
      s.semantic === 'BOTH' && s.unit && expected.includes(s.unit)
    );

    // If not found, choose the largest non-rare BOTH stat as the likely fixed main stat.
    if (!main) {
      main = nonRare
        .filter(s => s.semantic === 'BOTH')
        .slice()
        .sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0))[0] || null;
    }

    if (!main) {
      // Last fallback: first non-rare stat.
      main = nonRare[0] || stats[0];
    }

    const remaining = stats.filter(s => s !== main);

    // Prefer rare and combat-relevant lines as substats, then utility.
    remaining.sort((a, b) => {
      const score = s =>
        (s.rare ? 1000 : 0) +
        (s.semantic === 'PRIMARY' ? 300 : 0) +
        (s.semantic === 'BOTH' ? 250 : 0) +
        (s.semantic === 'UTILITY' ? 100 : 0) +
        Math.abs(s.value || 0);
      return score(b) - score(a);
    });

    return {
      mainStat: main,
      substats: remaining.slice(0, 2)
    };
  }

  function extractRelic(container, index) {
    const text = norm(container.innerText || container.textContent || '');
    const family = familyCanonical(text);
    if (!family) return null;

    const side = getSide(family);
    if (!side) return null;

    const rarity = parseRarity(text);
    const stats = extractStats(container, side);
    const separated = inferMainAndSubs(stats, rarity, family);

    const id =
      container.getAttribute('data-relic-id') ||
      container.getAttribute('data-item-id') ||
      container.id ||
      `scan-${index + 1}`;

    const relic = {
      id,
      index,
      family,
      familyName: prettyFamily(family),
      rarity,
      rarityName: rarity ? titleCase(rarity) : 'Unknown',
      name: parseName(text) || prettyFamily(family),
      side,
      mainStat: separated.mainStat,
      substats: separated.substats,
      allStats: stats,
      tier: 'UNKNOWN',
      tierLabel: TIER_LABELS.UNKNOWN,
      rawRelevantValue: 0,
      sourceElement: container,
      rawText: text,
      future: {
        canUpgrade: rarity ? ['shoddy', 'sturdy', 'enhanced', 'superior'].includes(rarity) : null,
        canReroll: rarity ? ['shoddy', 'sturdy', 'enhanced', 'superior', 'renowned'].includes(rarity) : null,
        upgradeMaterialPreference: family,
        ppSingleMaterialEligible: rarity ? ['shoddy', 'sturdy'].includes(rarity) : null
      }
    };

    relic.tier = calculateTier(relic);
    relic.tierLabel = TIER_LABELS[relic.tier] || relic.tier;
    relic.rawRelevantValue = calculateRawRelevantValue(relic);

    return relic;
  }

  function scanRelics() {
    const containers = candidateContainers();
    const relics = containers
      .map((el, i) => extractRelic(el, i))
      .filter(Boolean);

    // Final dedupe by source ID + normalized raw text.
    const seen = new Set();
    return relics.filter(r => {
      const key = `${r.id}|${lower(r.rawText)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
        <div class="twra-title">Tribal Wars Relic Analyzer v${VERSION}</div>
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
        ★ = detected rare/purple substat. Tiering uses the 2 inferred substats, not the fixed main stat.
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
            Open the relic inventory and make sure the relic cards are loaded.<br>
            If relics are visible but not detected, the game's current DOM needs one selector adjustment in CONFIG.selectors.
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

    root.addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;

      if (btn.dataset.action === 'close') root.remove();
      if (btn.dataset.action === 'rescan') {
        state.relics = scanRelics();
        window.__TW_RELIC_ANALYZER_V1__.relics = state.relics;
        redraw();
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

  const relics = scanRelics();
  const ui = render(relics);

  window.__TW_RELIC_ANALYZER_V1__ = {
    version: VERSION,
    relics,
    config: CONFIG,
    scan: scanRelics,
    calculateTier,
    evaluateAgainstCurrentStats,
    effectiveUnitAttack,
    effectiveUnitDefense,
    destroy() {
      document.getElementById(UI_ID)?.remove();
      delete window.__TW_RELIC_ANALYZER_V1__;
    },
    debug() {
      console.table(this.relics.map(r => ({
        id: r.id,
        name: r.name,
        side: r.side,
        rarity: r.rarityName,
        tier: r.tierLabel,
        main: r.mainStat?.text || '',
        sub1: r.substats[0]?.text || '',
        sub1Rare: !!r.substats[0]?.rare,
        sub2: r.substats[1]?.text || '',
        sub2Rare: !!r.substats[1]?.rare
      })));
      return this.relics;
    }
  };

  if (CONFIG.debug) {
    console.log('[TW Relic Analyzer]', window.__TW_RELIC_ANALYZER_V1__);
    window.__TW_RELIC_ANALYZER_V1__.debug();
  }
})();
