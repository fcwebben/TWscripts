/*
 * Twactics Advanced Mass Scavenging
 * Version: 0.1.0
 *
 * First test version. Clean-room mass scavenging helper with per-village allocation.
 *
 * Features:
 * - Runs on Rally point -> Scavenging -> Mass scavenging.
 * - Calculates a preview before sending.
 * - Sends only when the player manually clicks a group button.
 * - Modes: optimize_rph, balanced, high_first.
 * - RPH mode maximizes estimated resources/hour under max duration per scavenging level.
 * - Groups squad requests in batches of max 50.
 * - Supports localStorage and optional TribalWars.scriptData settings.
 *
 * TribalWars.scriptData optional format:
 * {
 *   "settings": {
 *     "mode": "optimize_rph",
 *     "maxHours": 6,
 *     "enabledLevels": [true, true, true, true],
 *     "usePremium": false,
 *     "selectedUnits": { "spear": true, "sword": true, "axe": true, "archer": true, "light": true, "marcher": true, "heavy": true },
 *     "keepHome": { "spear": 0, "sword": 0, "axe": 0, "archer": 0, "light": 0, "marcher": 0, "heavy": 0 },
 *     "requestDelayMs": 250,
 *     "debugConsole": false
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

(function () {
  "use strict";

  const NAME = "Twactics Advanced Mass Scavenging";
  const VERSION = "0.1.0";
  const ROOT = "twactics-advanced-mass-scavenging";
  const PREVIEW = ROOT + "-preview";
  const STYLE = ROOT + "-style";
  const STORAGE = "twacticsAdvancedMassScavengingSettings";
  const SQUAD_LIMIT = 50;
  const CARRY_STEP = 5;
  const PREMIUM_FACTOR = 1.2;
  const FALLBACK_LOOT = [0.1, 0.25, 0.5, 0.75];

  const UNIT_CARRY = {
    spear: 25,
    sword: 15,
    axe: 10,
    archer: 10,
    light: 80,
    marcher: 50,
    heavy: 50,
    knight: 100
  };

  const UNIT_ORDER = ["light", "axe", "marcher", "heavy", "spear", "sword", "archer"];

  const DEFAULT_SETTINGS = {
    mode: "optimize_rph",
    maxHours: 6,
    enabledLevels: [true, true, true, true],
    usePremium: false,
    selectedUnits: {
      spear: true,
      sword: true,
      axe: true,
      archer: true,
      light: true,
      marcher: true,
      heavy: true
    },
    keepHome: {
      spear: 0,
      sword: 0,
      axe: 0,
      archer: 0,
      light: 0,
      marcher: 0,
      heavy: 0
    },
    requestDelayMs: 250,
    debugConsole: false
  };

  const state = {
    settings: null,
    constants: null,
    villages: [],
    requests: [],
    groups: [],
    preview: [],
    summary: null,
    debug: { fetch: [], calculation: [] }
  };

  window.TwacticsAdvancedMassScavenging = {
    version: VERSION,
    state: state,
    recalculate: calculate,
    copyDebug: function () {
      const text = JSON.stringify(state, null, 2);
      if (typeof copy === "function") copy(text);
      console.log(text);
      return text;
    }
  };

  if (!isMassScavengePage()) {
    window.location.assign(massUrl());
    return;
  }

  init();

  function init() {
    state.settings = loadSettings();
    injectCss();
    renderMain();
    status("Ready.", "info");
  }

  function isMassScavengePage() {
    return location.href.indexOf("screen=place") >= 0 && location.href.indexOf("mode=scavenge_mass") >= 0;
  }

  function massUrl(page) {
    let url = game_data && game_data.link_base_pure ? game_data.link_base_pure + "place&mode=scavenge_mass" : "/game.php?screen=place&mode=scavenge_mass";
    if (game_data && game_data.player && game_data.player.sitter > 0) {
      url = "/game.php?t=" + encodeURIComponent(game_data.player.id) + "&screen=place&mode=scavenge_mass";
    }
    if (page !== undefined) url += "&page=" + encodeURIComponent(page);
    return url;
  }

  function loadSettings() {
    let settings = merge(clone(DEFAULT_SETTINGS), readJsonLocal(STORAGE) || {});
    try {
      if (typeof TribalWars !== "undefined" && TribalWars.scriptData) {
        const data = typeof TribalWars.scriptData === "string" ? JSON.parse(TribalWars.scriptData) : TribalWars.scriptData;
        if (data && data.settings) settings = merge(settings, data.settings);
      }
    } catch (e) {}
    return settings;
  }

  function saveSettings(settings) {
    localStorage.setItem(STORAGE, JSON.stringify(settings));
    try {
      if (typeof TribalWars !== "undefined" && TribalWars.scriptData && typeof TribalWars.scriptData === "object") {
        TribalWars.scriptData.settings = clone(settings);
      }
    } catch (e) {}
  }

  function readJsonLocal(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function merge(target, source) {
    if (!source || typeof source !== "object") return target;
    Object.keys(source).forEach(key => {
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
        target[key] = merge(target[key] || {}, source[key]);
      } else {
        target[key] = source[key];
      }
    });
    return target;
  }

  function injectCss() {
    const old = document.getElementById(STYLE);
    if (old) old.remove();
    const style = document.createElement("style");
    style.id = STYLE;
    style.textContent = "#" + ROOT + ",#" + PREVIEW + "{margin:8px 0;padding:8px;border:1px solid #7d510f;background:#f4e4bc;color:#2d1b0f;font-size:12px}"
      + "#" + ROOT + " h3,#" + PREVIEW + " h3{margin:4px 0 8px;color:#803000}"
      + "#" + ROOT + " .twams-grid{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:8px;margin-bottom:8px}"
      + "#" + ROOT + " .twams-card,#" + PREVIEW + " .twams-card{border:1px solid #c1a264;background:#fff5da;padding:6px}"
      + "#" + ROOT + " label{display:block;margin:3px 0;white-space:nowrap}"
      + "#" + ROOT + " input[type=number]{width:80px}"
      + "#" + ROOT + " .twams-units{display:grid;grid-template-columns:repeat(7,minmax(75px,1fr));gap:4px}"
      + "#" + ROOT + " .twams-unit{border:1px solid #d1b783;background:#f9edcf;text-align:center;padding:4px}"
      + "#" + ROOT + " .twams-unit img{display:block;margin:0 auto 3px}"
      + "#" + ROOT + " .twams-actions,#" + PREVIEW + " .twams-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}"
      + "#" + ROOT + " .twams-note,#" + PREVIEW + " .twams-note{font-size:11px;color:#5c4630;margin:6px 0}"
      + "#" + ROOT + " .twams-status{border:1px solid #d1b783;background:#fffaf0;padding:5px;margin-top:6px}"
      + "#" + ROOT + " .error{color:#7a0000;border-color:#b33}#" + ROOT + " .success{color:#235c12;border-color:#4c8b2f}#" + ROOT + " .warn{color:#7a4d00;border-color:#c28b00}"
      + "#" + PREVIEW + " .twams-summary{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:6px;margin-bottom:8px}"
      + "#" + PREVIEW + " .twams-summary div{border:1px solid #c1a264;background:#fff5da;padding:6px;text-align:center}"
      + "#" + PREVIEW + " table{width:100%;border-collapse:collapse}#" + PREVIEW + " th,#" + PREVIEW + " td{border:1px solid #c1a264;padding:4px;text-align:center}"
      + "#" + PREVIEW + " th{background:#c6a768;color:#803000}#" + PREVIEW + " .left{text-align:left}";
    document.head.appendChild(style);
  }

  function renderMain() {
    remove(ROOT);
    const root = document.createElement("div");
    root.id = ROOT;
    root.innerHTML = '<h3>' + NAME + ' <span style="font-size:11px">v' + VERSION + '</span></h3>'
      + '<div class="twams-grid">'
      + '<div class="twams-card"><b>Mode</b>'
      + radio("mode", "optimize_rph", "Optimize RPH")
      + radio("mode", "balanced", "Balanced finish time")
      + radio("mode", "high_first", "High levels first") + '</div>'
      + '<div class="twams-card"><b>Max duration</b><label>Hours <input id="twams-max-hours" type="number" min="0.25" step="0.25"></label><div class="twams-note">RPH mode caps each level at this duration.</div></div>'
      + '<div class="twams-card"><b>Levels</b>'
      + check("level-1", "Level 1") + check("level-2", "Level 2") + check("level-3", "Level 3") + check("level-4", "Level 4") + '</div>'
      + '<div class="twams-card"><b>Options</b>'
      + check("premium", "Use premium scavenging") + check("debug", "Debug console")
      + '<label>Delay ms <input id="twams-delay" type="number" min="0" step="50"></label></div>'
      + '</div><div class="twams-card"><b>Units and keep-home</b><div id="twams-units" class="twams-units"></div></div>'
      + '<div class="twams-note">User data: supports TribalWars.scriptData. Expected JSON format and options are documented in the script header.</div>'
      + '<div class="twams-actions"><input type="button" class="btn" id="twams-calc" value="Calculate plan"><input type="button" class="btn" id="twams-copy" value="Copy debug"><input type="button" class="btn" id="twams-close" value="Close"></div>'
      + '<div id="twams-status" class="twams-status">Ready.</div>';
    mount().prepend(root);
    fillForm();
    document.getElementById("twams-calc").addEventListener("click", calculate);
    document.getElementById("twams-copy").addEventListener("click", window.TwacticsAdvancedMassScavenging.copyDebug);
    document.getElementById("twams-close").addEventListener("click", () => { remove(ROOT); remove(PREVIEW); });
  }

  function radio(name, value, label) { return '<label><input type="radio" name="twams-' + name + '" value="' + esc(value) + '"> ' + esc(label) + '</label>'; }
  function check(id, label) { return '<label><input type="checkbox" id="twams-' + id + '"> ' + esc(label) + '</label>'; }
  function mount() { return document.querySelector(".maincell") || document.getElementById("content_value") || document.body; }
  function remove(id) { const el = document.getElementById(id); if (el) el.remove(); }

  function fillForm() {
    const s = state.settings;
    const mode = document.querySelector('#' + ROOT + ' input[name="twams-mode"][value="' + s.mode + '"]');
    if (mode) mode.checked = true;
    val("twams-max-hours", s.maxHours);
    val("twams-delay", s.requestDelayMs);
    checked("twams-premium", s.usePremium);
    checked("twams-debug", s.debugConsole);
    for (let i = 0; i < 4; i++) checked("twams-level-" + (i + 1), s.enabledLevels[i] !== false);
    renderUnits();
  }

  function renderUnits() {
    const box = document.getElementById("twams-units");
    box.innerHTML = "";
    gameUnits().forEach(unit => {
      const wrap = document.createElement("div");
      wrap.className = "twams-unit";
      wrap.innerHTML = '<img src="' + unitIcon(unit) + '" title="' + esc(unit) + '"><label><input type="checkbox" class="twams-unit-enabled" data-unit="' + esc(unit) + '"> ' + esc(unit) + '</label><label>Keep <input type="number" min="0" class="twams-keep" data-unit="' + esc(unit) + '"></label>';
      box.appendChild(wrap);
      wrap.querySelector(".twams-unit-enabled").checked = state.settings.selectedUnits[unit] !== false;
      wrap.querySelector(".twams-keep").value = intVal(state.settings.keepHome[unit], 0);
    });
  }

  function unitIcon(unit) {
    const version = game_data && game_data.version ? String(game_data.version).split(" ")[0] : "";
    return version ? "https://dsen.innogamescdn.com/asset/" + encodeURIComponent(version) + "/graphic/unit/unit_" + unit + ".png" : "/graphic/unit/unit_" + unit + ".png";
  }

  function gameUnits() {
    const units = game_data && Array.isArray(game_data.units) ? game_data.units : UNIT_ORDER;
    return UNIT_ORDER.filter(u => units.indexOf(u) >= 0);
  }

  function collectSettings() {
    const s = clone(state.settings);
    const mode = document.querySelector('#' + ROOT + ' input[name="twams-mode"]:checked');
    s.mode = mode ? mode.value : "optimize_rph";
    s.maxHours = floatVal(get("twams-max-hours"), 6);
    s.requestDelayMs = intVal(get("twams-delay"), 250);
    s.usePremium = isChecked("twams-premium");
    s.debugConsole = isChecked("twams-debug");
    s.enabledLevels = [1, 2, 3, 4].map(i => isChecked("twams-level-" + i));
    s.selectedUnits = {};
    s.keepHome = {};
    document.querySelectorAll(".twams-unit-enabled").forEach(el => { s.selectedUnits[el.dataset.unit] = el.checked; });
    document.querySelectorAll(".twams-keep").forEach(el => { s.keepHome[el.dataset.unit] = intVal(el.value, 0); });
    return s;
  }

  async function calculate() {
    try {
      state.settings = collectSettings();
      validate(state.settings);
      saveSettings(state.settings);
      state.requests = [];
      state.groups = [];
      state.preview = [];
      state.debug = { fetch: [], calculation: [] };
      status("Loading mass scavenging data...", "warn");
      const loaded = await loadData();
      state.constants = loaded.constants;
      state.villages = loaded.villages;
      status("Calculating plan...", "warn");
      const plan = buildPlan(loaded.villages, loaded.constants, state.settings);
      state.requests = plan.requests;
      state.preview = plan.preview;
      state.summary = plan.summary;
      state.debug.calculation = plan.debug;
      state.groups = group(plan.requests, SQUAD_LIMIT);
      renderPreview();
      status("Plan ready: " + fmt(plan.requests.length) + " requests.", "success");
      if (state.settings.debugConsole) console.log(NAME, state);
    } catch (err) {
      console.error(err);
      status(err.message || String(err), "error");
    }
  }

  function validate(s) {
    if (!s.enabledLevels.some(Boolean)) throw new Error("Select at least one level.");
    if (!Object.keys(s.selectedUnits).some(u => s.selectedUnits[u])) throw new Error("Select at least one unit.");
    if (!(s.maxHours > 0)) throw new Error("Max hours must be above 0.");
  }

  async function loadData() {
    const firstUrl = massUrl();
    const first = await fetchText(firstUrl, 0);
    const pageCount = pageCountFromHtml(first);
    const constants = parseConstants(first);
    const villages = [];
    for (let p = 0; p <= pageCount; p++) {
      status("Loading page " + (p + 1) + " / " + (pageCount + 1) + "...", "warn");
      const html = p === 0 ? first : await fetchText(massUrl(p), state.settings.requestDelayMs);
      const pageVillages = parseVillages(html);
      state.debug.fetch.push({ page: p, url: massUrl(p), villages: pageVillages.length });
      pageVillages.forEach(v => villages.push(v));
    }
    return { constants: constants, villages: villages };
  }

  function fetchText(url, delay) {
    return new Promise((resolve, reject) => {
      setTimeout(() => { $.get(url).done(resolve).fail(reject); }, Math.max(0, delay || 0));
    });
  }

  function pageCountFromHtml(html) {
    const $html = $(html);
    let max = 0;
    $html.find(".paged-nav-item").each((i, el) => {
      const href = String(el.href || $(el).attr("href") || "");
      const m = href.match(/[?&]page=(\d+)/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
      const n = parseInt(String($(el).text()).replace(/\D/g, ""), 10);
      if (Number.isFinite(n)) max = Math.max(max, n - 1);
    });
    return max;
  }

  function blocks(html) {
    const arr = [];
    $(html).find("script").each((i, s) => {
      const text = s.textContent || "";
      if (text.indexOf("ScavengeMassScreen") < 0 && text.indexOf("loot_factor") < 0) return;
      const m = text.match(/\{.*\:\{.*\:.*\}\}/g);
      if (m) m.forEach(x => arr.push(x));
    });
    return arr;
  }

  function parseConstants(html) {
    const parsed = blocks(html).map(json).filter(Boolean);
    let src = null;
    parsed.forEach(o => { if (!src && o && o[1] && o[1].duration_exponent !== undefined) src = o; });
    if (!src) throw new Error("Could not read scavenging constants.");
    return [1, 2, 3, 4].map((level, idx) => {
      const o = src[level] || src[String(level)] || {};
      return {
        level: level,
        lootFactor: floatVal(o.loot_factor, FALLBACK_LOOT[idx]),
        durationExponent: floatVal(o.duration_exponent, floatVal(src[1] && src[1].duration_exponent, 0.45)),
        durationInitialSeconds: floatVal(o.duration_initial_seconds, floatVal(src[1] && src[1].duration_initial_seconds, 1800)),
        durationFactor: floatVal(o.duration_factor, floatVal(src[1] && src[1].duration_factor, 1)),
        premiumFactor: floatVal(o.premium_loot_factor, PREMIUM_FACTOR)
      };
    });
  }

  function parseVillages(html) {
    const parsed = blocks(html).map(json).filter(Boolean);
    for (let i = 0; i < parsed.length; i++) {
      const out = normalizeVillages(parsed[i]);
      if (out.length) return out;
    }
    return [];
  }

  function normalizeVillages(obj) {
    if (!obj) return [];
    if (Array.isArray(obj)) return obj.filter(isVillage);
    if (isVillage(obj)) return [obj];
    if (typeof obj === "object") return Object.keys(obj).map(k => obj[k]).filter(isVillage);
    return [];
  }

  function isVillage(x) {
    return !!(x && typeof x === "object" && x.village_id !== undefined && x.options && x.unit_counts_home);
  }

  function json(text) { try { return JSON.parse(text); } catch (e) { return null; } }

  function buildPlan(villages, constants, settings) {
    const requests = [];
    const preview = [];
    const debug = [];
    let loot = 0, rph = 0, usedVillages = 0, skippedUnits = 0, skippedLevels = 0, skippedRally = 0;
    villages.forEach(village => {
      if (village.has_rally_point !== true) { skippedRally++; return; }
      const lvls = availableLevels(village, settings);
      if (!lvls.length) { skippedLevels++; return; }
      const units = availableUnits(village, settings);
      const totalCarry = unitCarrySum(units, village);
      if (totalCarry <= 0) { skippedUnits++; return; }
      const allocation = allocate(totalCarry, lvls, constants, settings);
      const split = splitUnits(units, allocation, village);
      const rows = [];
      lvls.forEach(level => {
        const unitCounts = split[level] || {};
        const carry = unitCarrySum(unitCounts, village);
        if (carry <= 0) return;
        const c = constants[level - 1];
        const duration = durationSeconds(carry, c);
        const rowLoot = lootAmount(carry, c, settings.usePremium);
        const rowRph = resourcesPerHour(carry, c, settings.usePremium);
        requests.push({ village_id: village.village_id, option_id: level, use_premium: !!settings.usePremium, candidate_squad: { unit_counts: unitCounts, carry_max: 9999999999 } });
        rows.push({ level: level, carry: carry, duration: duration, loot: rowLoot, rph: rowRph, units: unitCounts });
        loot += rowLoot;
        rph += rowRph;
      });
      if (rows.length) {
        usedVillages++;
        preview.push({ id: village.village_id, name: village.village_name || village.name || "Village " + village.village_id, rows: rows });
      }
      debug.push({ village_id: village.village_id, levels: lvls, totalCarry: totalCarry, allocation: allocation, rows: rows });
    });
    return {
      requests: requests,
      preview: preview,
      debug: debug,
      summary: { villagesScanned: villages.length, villagesUsed: usedVillages, requests: requests.length, estimatedLoot: Math.round(loot), estimatedRph: Math.round(rph), skippedNoRally: skippedRally, skippedNoUnits: skippedUnits, skippedNoLevels: skippedLevels, mode: settings.mode, maxHours: settings.maxHours }
    };
  }

  function availableLevels(v, s) {
    const out = [];
    for (let level = 1; level <= 4; level++) {
      if (s.enabledLevels[level - 1] === false) continue;
      const opt = v.options && (v.options[level] || v.options[String(level)]);
      if (!opt || opt.is_locked === true || opt.scavenging_squad != null) continue;
      out.push(level);
    }
    return out;
  }

  function availableUnits(v, s) {
    const out = {};
    gameUnits().forEach(unit => {
      if (s.selectedUnits[unit] === false) return;
      const usable = Math.max(0, intVal(v.unit_counts_home && v.unit_counts_home[unit], 0) - intVal(s.keepHome[unit], 0));
      if (usable > 0) out[unit] = usable;
    });
    return out;
  }

  function allocate(totalCarry, lvls, constants, settings) {
    if (settings.mode === "balanced") return allocateBalanced(totalCarry, lvls, constants, settings.maxHours);
    if (settings.mode === "high_first") return allocateHighFirst(totalCarry, lvls, constants, settings.maxHours);
    return allocateRph(totalCarry, lvls, constants, settings.maxHours, settings.usePremium);
  }

  function blank(lvls) { const o = {}; lvls.forEach(l => { o[l] = 0; }); return o; }

  function allocateRph(totalCarry, lvls, constants, maxHours, premium) {
    const a = blank(lvls);
    let remaining = Math.floor(totalCarry / CARRY_STEP) * CARRY_STEP;
    const maxSec = maxHours * 3600;
    let guard = 0;
    while (remaining > 0 && guard++ < 200000) {
      let best = null;
      const step = Math.min(CARRY_STEP, remaining);
      lvls.forEach(level => {
        const c = constants[level - 1];
        const before = a[level] || 0;
        const after = before + step;
        if (durationSeconds(after, c) > maxSec) return;
        const gain = resourcesPerHour(after, c, premium) - resourcesPerHour(before, c, premium);
        if (!best || gain > best.gain) best = { level: level, gain: gain };
      });
      if (!best) break;
      a[best.level] += step;
      remaining -= step;
    }
    return a;
  }

  function allocateBalanced(totalCarry, lvls, constants, maxHours) {
    const a = blank(lvls);
    const maxSec = maxHours * 3600;
    const maxCarry = {};
    let totalAtMax = 0;
    lvls.forEach(level => { maxCarry[level] = carryForDuration(maxSec, constants[level - 1]); totalAtMax += maxCarry[level]; });
    if (totalAtMax <= 0) return a;
    if (totalCarry >= totalAtMax) {
      lvls.forEach(level => { a[level] = Math.floor(maxCarry[level] / CARRY_STEP) * CARRY_STEP; });
      return a;
    }
    let low = 0, high = maxSec;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      let carry = 0;
      lvls.forEach(level => { carry += carryForDuration(mid, constants[level - 1]); });
      if (carry < totalCarry) low = mid; else high = mid;
    }
    lvls.forEach(level => { a[level] = Math.floor(carryForDuration(low, constants[level - 1]) / CARRY_STEP) * CARRY_STEP; });
    return a;
  }

  function allocateHighFirst(totalCarry, lvls, constants, maxHours) {
    const a = blank(lvls);
    let remaining = Math.floor(totalCarry / CARRY_STEP) * CARRY_STEP;
    const maxSec = maxHours * 3600;
    lvls.slice().sort((x, y) => y - x).forEach(level => {
      const cap = Math.floor(carryForDuration(maxSec, constants[level - 1]) / CARRY_STEP) * CARRY_STEP;
      const used = Math.min(cap, remaining);
      a[level] = used;
      remaining -= used;
    });
    return a;
  }

  function carryForDuration(seconds, c) {
    const usable = seconds / c.durationFactor - c.durationInitialSeconds;
    if (!(usable > 0)) return 0;
    return Math.sqrt(Math.pow(usable, 1 / c.durationExponent) / (100 * c.lootFactor * c.lootFactor));
  }

  function durationSeconds(carry, c) {
    carry = Math.max(0, Number(carry) || 0);
    if (!carry) return 0;
    return Math.round((Math.pow(100 * carry * carry * c.lootFactor * c.lootFactor, c.durationExponent) + c.durationInitialSeconds) * c.durationFactor);
  }

  function lootAmount(carry, c, premium) {
    return Math.round(Math.max(0, carry) * c.lootFactor * (premium ? (c.premiumFactor || PREMIUM_FACTOR) : 1));
  }

  function resourcesPerHour(carry, c, premium) {
    const d = durationSeconds(carry, c);
    return d > 0 ? 3600 * lootAmount(carry, c, premium) / d : 0;
  }

  function splitUnits(units, allocation, village) {
    const levels = Object.keys(allocation).filter(level => allocation[level] > 0);
    const split = {};
    const actual = {};
    const totalTarget = levels.reduce((sum, level) => sum + allocation[level], 0);
    levels.forEach(level => { split[level] = {}; actual[level] = 0; });
    if (totalTarget <= 0) return split;
    Object.keys(units).forEach(unit => {
      const count = intVal(units[unit], 0);
      const carry = carryPerUnit(unit, village);
      let assigned = 0;
      levels.forEach(level => {
        const n = Math.floor(count * allocation[level] / totalTarget);
        if (n > 0) { split[level][unit] = n; actual[level] += n * carry; assigned += n; }
      });
      let left = count - assigned;
      while (left-- > 0) {
        const level = mostUnderfilled(levels, allocation, actual);
        split[level][unit] = (split[level][unit] || 0) + 1;
        actual[level] += carry;
      }
    });
    return split;
  }

  function mostUnderfilled(levels, target, actual) {
    let best = levels[0], bestDiff = -Infinity;
    levels.forEach(level => {
      const diff = (target[level] || 0) - (actual[level] || 0);
      if (diff > bestDiff) { best = level; bestDiff = diff; }
    });
    return best;
  }

  function carryPerUnit(unit, village) { return (UNIT_CARRY[unit] || 0) * floatVal(village.unit_carry_factor, 1); }
  function unitCarrySum(units, village) { return Object.keys(units || {}).reduce((sum, u) => sum + intVal(units[u], 0) * carryPerUnit(u, village), 0); }
  function group(requests, limit) { const out = []; for (let i = 0; i < requests.length; i += limit) out.push(requests.slice(i, i + limit)); return out; }

  function renderPreview() {
    remove(PREVIEW);
    const s = state.summary || {};
    const rows = state.preview.slice(0, 30);
    const div = document.createElement("div");
    div.id = PREVIEW;
    div.innerHTML = '<h3>Scavenging plan preview</h3><div class="twams-summary">'
      + summaryBox("Villages scanned", s.villagesScanned)
      + summaryBox("Villages used", s.villagesUsed)
      + summaryBox("Requests", s.requests)
      + summaryBox("Est. loot", s.estimatedLoot)
      + summaryBox("Est. RPH", s.estimatedRph) + '</div>'
      + '<div class="twams-note">Showing first ' + rows.length + ' planned villages. Use Copy debug for full details.</div>'
      + previewTable(rows) + '<div id="twams-groups" class="twams-actions"></div>';
    mount().prepend(div);
    renderGroupButtons();
  }

  function summaryBox(label, value) { return '<div><b>' + esc(label) + '</b><br>' + fmt(value || 0) + '</div>'; }

  function previewTable(rows) {
    if (!rows.length) return '<div class="twams-note">No valid requests found.</div>';
    return '<table><thead><tr><th>Village ID</th><th>Village</th><th>Levels</th><th>Loot</th><th>RPH</th><th>Units</th></tr></thead><tbody>'
      + rows.map(v => {
        const details = v.rows.map(r => 'L' + r.level + ': ' + dur(r.duration) + ' / ' + fmt(Math.round(r.rph)) + ' RPH').join('<br>');
        const units = v.rows.map(r => 'L' + r.level + ': ' + unitText(r.units)).join('<br>');
        const loot = v.rows.reduce((sum, r) => sum + r.loot, 0);
        const rph = v.rows.reduce((sum, r) => sum + r.rph, 0);
        return '<tr><td>' + esc(v.id) + '</td><td class="left">' + esc(v.name) + '</td><td class="left">' + details + '</td><td>' + fmt(loot) + '</td><td>' + fmt(rph) + '</td><td class="left">' + units + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderGroupButtons() {
    const box = document.getElementById("twams-groups");
    if (!box) return;
    state.groups.forEach((g, i) => {
      const b = document.createElement("input");
      b.type = "button";
      b.className = "btn";
      b.value = "Send group " + (i + 1) + " (" + g.length + ")";
      b.addEventListener("click", () => sendGroup(i));
      box.appendChild(b);
    });
  }

  function sendGroup(i) {
    const g = state.groups[i];
    if (!g || !g.length) return;
    if (state.settings.usePremium && !confirm("Premium scavenging is enabled. This may use Premium Points. Continue?")) return;
    status("Sending group " + (i + 1) + "...", "warn");
    TribalWars.post("scavenge_api", { ajaxaction: "send_squads" }, { squad_requests: g }, function () {
      status("Group " + (i + 1) + " sent.", "success");
      const btn = document.querySelectorAll("#twams-groups input")[i];
      if (btn) btn.disabled = true;
    }, function (err) {
      console.error(err);
      status("Failed to send group " + (i + 1) + ". See console.", "error");
    });
  }

  function status(text, type) { const el = document.getElementById("twams-status"); if (el) { el.textContent = text; el.className = "twams-status " + (type || "info"); } }
  function get(id) { const el = document.getElementById(id); return el ? el.value : ""; }
  function val(id, x) { const el = document.getElementById(id); if (el) el.value = x; }
  function isChecked(id) { const el = document.getElementById(id); return !!(el && el.checked); }
  function checked(id, x) { const el = document.getElementById(id); if (el) el.checked = !!x; }
  function intVal(x, fallback) { const n = parseInt(x, 10); return Number.isFinite(n) && n >= 0 ? n : fallback; }
  function floatVal(x, fallback) { const n = parseFloat(String(x).replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : fallback; }
  function fmt(x) { return Math.round(Number(x) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
  function dur(sec) { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }
  function unitText(units) { return Object.keys(units || {}).filter(u => units[u] > 0).map(u => esc(u) + " " + fmt(units[u])).join(", ") || "-"; }
  function esc(x) { return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
})();
