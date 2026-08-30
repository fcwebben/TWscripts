/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Farm Local
 * Version 1.0.0
 *
 * Clean-room implementation for Tribal Wars Loot/Farm Assistant.
 * This script is implemented independently and uses only Tribal Wars page data,
 * public game interfaces and the user's functional settings. It does not reuse
 * third-party script names, selectors, layout, source structure or code.
 *
 * Variant: local
 *
 * Expected TribalWars.scriptData format:
 * {
 *   "settings": {
 *     "sourceMode": "current",
 *     "maxDistance": 25,
 *     "minArrivalGapMinutes": 20,
 *     "templateMode": "auto",
 *     "maxLootUsesB": true,
 *     "reportFilter": "safe",
 *     "includeNewBarbarians": false,
 *     "manualTemplateASpeed": 0,
 *     "manualTemplateBSpeed": 0,
 *     "requestDelayMs": 350,
 *     "sendDelayMs": 250,
 *     "commandsCacheSeconds": 60,
 *     "targetBatchSize": 0,
 *     "originBatchSize": 0,
 *     "prefetchRemaining": 0,
 *     "debugConsole": false
 *   }
 * }
 *
 * Option notes:
 * - sourceMode: current | group | all. Local variant always uses current.
 * - maxDistance: maximum fields from an origin; 0 disables distance filtering.
 * - minArrivalGapMinutes: minimum absolute gap to any known/planned arrival on the target.
 * - templateMode: auto | a | b. Auto prefers A unless max-loot -> B is enabled.
 * - manualTemplateASpeed/manualTemplateBSpeed: minutes per field. 0 = auto-detect.
 * - targetBatchSize/originBatchSize/prefetchRemaining are used by Efficient variant.
 *
 * Server-load design:
 * - Outgoing attack arrivals are loaded once and indexed by target coordinate.
 * - Loot Assistant pages are requested in distance order and paged sequentially.
 * - With a max distance, paging stops as soon as the sorted page is beyond the range.
 * - Efficient variant only loads more origin pages when its visible queue needs replenishing.
 * - Static unit/world information and barbar map data are cached.
 *
 * This script does NOT:
 * - Automatically send attacks on load.
 * - Automatically click through the attack queue.
 * - Use external servers or external script files.
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

  const BUILD = Object.freeze({
    variant: "local",
    name: "Twactics Farm Local",
    version: "1.0.0",
    defaultSourceMode: "current",
    targetBatchSize: 0,
    originBatchSize: 0,
    prefetchRemaining: 0
  });

  const INSTANCE_KEY = "twacticsFarm_" + BUILD.variant;
  if (window[INSTANCE_KEY] && window[INSTANCE_KEY].loaded) {
    console.log(BUILD.name + " already loaded.");
    return;
  }

  const BOX_ID = "twf-" + BUILD.variant + "-box";
  const STYLE_ID = "twf-clean-room-style";
  const STORAGE_KEY = "twacticsFarmSettings:" + BUILD.variant;
  const UNIT_CACHE_KEY = "twacticsFarmUnitInfo:v1";
  const CONFIG_CACHE_KEY = "twacticsFarmWorldConfig:v1";
  const BARB_CACHE_KEY = "twacticsFarmBarbarians:v1";
  const UNIT_KEYS = ["spear", "sword", "axe", "archer", "spy", "light", "marcher", "heavy", "ram", "catapult", "knight", "snob"];

  const DEFAULTS = Object.freeze({
    sourceMode: BUILD.defaultSourceMode,
    maxDistance: 25,
    minArrivalGapMinutes: 20,
    templateMode: "auto",
    maxLootUsesB: true,
    reportFilter: "safe",
    includeNewBarbarians: false,
    manualTemplateASpeed: 0,
    manualTemplateBSpeed: 0,
    requestDelayMs: 350,
    sendDelayMs: 250,
    commandsCacheSeconds: 60,
    targetBatchSize: BUILD.targetBatchSize,
    originBatchSize: BUILD.originBatchSize,
    prefetchRemaining: BUILD.prefetchRemaining,
    maxFarmPagesPerOrigin: BUILD.variant === "efficient" ? 20 : 60,
    debugConsole: false
  });

  const state = {
    origins: [],
    originCursor: 0,
    loadedOrigins: new Set(),
    commandArrivals: new Map(),
    commandLoadedAt: 0,
    plan: [],
    sentCount: 0,
    skippedCount: 0,
    planSerial: 1,
    sendLocked: false,
    loadingMore: false,
    finishedOrigins: false,
    deferredTargets: [],
    plannedArrivals: new Map(),
    templateIds: { a: "", b: "" },
    templateUnits: { a: null, b: null },
    unitSpeeds: null,
    worldUnitSpeed: 1,
    barbarians: null,
    debug: resetDebug(),
    settings: null
  };

  const ui = {};

  window[INSTANCE_KEY] = {
    loaded: true,
    state: state,
    close: closeDialog,
    rebuild: startBuild,
    loadMore: BUILD.variant === "efficient" ? loadMoreEfficient : function () {},
    exportSettings: function () { return JSON.stringify({ settings: getSettings() }, null, 2); },
    copyDebug: copyDebug
  };

  function resetDebug() {
    return {
      script: BUILD.name,
      version: BUILD.version,
      variant: BUILD.variant,
      startedAt: new Date().toISOString(),
      requests: [],
      originPages: [],
      commands: { rows: 0, parsed: 0, samples: [], skipped: [] },
      templates: { ids: {}, units: {}, speeds: {}, discovery: [] },
      rejected: [],
      accepted: [],
      send: []
    };
  }

  function cleanText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function parseNumber(value) {
    const normalized = String(value || "").replace(/\./g, "").replace(/,/g, "").replace(/[^\d-]/g, "");
    const parsed = parseInt(normalized, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function parseFloatSafe(value, fallback) {
    const parsed = parseFloat(String(value === undefined || value === null ? "" : value).replace(",", "."));
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  function clamp(value, min, max, fallback) {
    const parsed = parseFloatSafe(value, fallback);
    return Math.max(min, Math.min(max, parsed));
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatNumber(value) {
    try { return Math.round(value || 0).toLocaleString(); } catch (err) { return String(Math.round(value || 0)); }
  }

  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms || 0)));
  }

  function getParam(name, url) {
    try { return new URL(url || window.location.href, window.location.origin).searchParams.get(name); }
    catch (err) { return null; }
  }

  function getWorldKey(name) {
    const world = typeof game_data !== "undefined" && game_data.world ? game_data.world : window.location.host;
    return world + ":" + name;
  }

  function getCurrentVillageId() {
    if (typeof game_data !== "undefined" && game_data.village && game_data.village.id) return String(game_data.village.id);
    return getParam("village", window.location.href) || "";
  }

  function getCurrentVillage() {
    const id = getCurrentVillageId();
    const rawName = typeof game_data !== "undefined" && game_data.village ? cleanText(game_data.village.name || "Current village") : "Current village";
    const coord = typeof game_data !== "undefined" && game_data.village && game_data.village.coord
      ? String(game_data.village.coord)
      : ((parseCoord(rawName) || {}).coord || "");
    return { id: id, name: rawName, coord: coord };
  }

  function getCurrentGroupId() {
    return getParam("group", window.location.href) || "0";
  }

  function getScriptDataObject() {
    if (typeof TribalWars === "undefined" || TribalWars.scriptData === undefined || TribalWars.scriptData === null) return null;
    if (typeof TribalWars.scriptData === "object") return TribalWars.scriptData;
    if (typeof TribalWars.scriptData === "string") {
      try { return JSON.parse(TribalWars.scriptData); }
      catch (err) { console.warn(BUILD.name + " could not parse TribalWars.scriptData", err); }
    }
    return null;
  }

  function normalizeSettings(input) {
    const s = Object.assign({}, DEFAULTS, input || {});
    const sourceModes = new Set(["current", "group", "all"]);
    const templateModes = new Set(["auto", "a", "b"]);
    const reportFilters = new Set(["safe", "green", "not-red", "all"]);
    const normalized = {
      sourceMode: sourceModes.has(s.sourceMode) ? s.sourceMode : DEFAULTS.sourceMode,
      maxDistance: clamp(s.maxDistance, 0, 500, DEFAULTS.maxDistance),
      minArrivalGapMinutes: clamp(s.minArrivalGapMinutes, 0, 1440, DEFAULTS.minArrivalGapMinutes),
      templateMode: templateModes.has(s.templateMode) ? s.templateMode : DEFAULTS.templateMode,
      maxLootUsesB: s.maxLootUsesB !== false,
      reportFilter: reportFilters.has(s.reportFilter) ? s.reportFilter : DEFAULTS.reportFilter,
      includeNewBarbarians: s.includeNewBarbarians === true,
      manualTemplateASpeed: clamp(s.manualTemplateASpeed, 0, 120, DEFAULTS.manualTemplateASpeed),
      manualTemplateBSpeed: clamp(s.manualTemplateBSpeed, 0, 120, DEFAULTS.manualTemplateBSpeed),
      requestDelayMs: clamp(s.requestDelayMs, 0, 5000, DEFAULTS.requestDelayMs),
      sendDelayMs: clamp(s.sendDelayMs, 0, 5000, DEFAULTS.sendDelayMs),
      commandsCacheSeconds: clamp(s.commandsCacheSeconds, 10, 600, DEFAULTS.commandsCacheSeconds),
      targetBatchSize: Math.max(10, Math.min(500, parseInt(s.targetBatchSize, 10) || DEFAULTS.targetBatchSize || 100)),
      originBatchSize: Math.max(1, Math.min(50, parseInt(s.originBatchSize, 10) || DEFAULTS.originBatchSize || 10)),
      prefetchRemaining: Math.max(0, Math.min(100, parseInt(s.prefetchRemaining, 10) || DEFAULTS.prefetchRemaining || 0)),
      maxFarmPagesPerOrigin: Math.max(1, Math.min(200, parseInt(s.maxFarmPagesPerOrigin, 10) || DEFAULTS.maxFarmPagesPerOrigin)),
      debugConsole: s.debugConsole === true
    };
    if (BUILD.variant === "local") normalized.sourceMode = "current";
    return normalized;
  }

  function loadInitialSettings() {
    let local = null;
    try {
      const raw = localStorage.getItem(getWorldKey(STORAGE_KEY));
      local = raw ? JSON.parse(raw) : null;
    } catch (err) {}
    const sd = getScriptDataObject();
    return normalizeSettings(Object.assign({}, local && local.settings ? local.settings : local || {}, sd && sd.settings ? sd.settings : {}));
  }

  function saveSettings(settings) {
    const normalized = normalizeSettings(settings);
    state.settings = normalized;
    try { localStorage.setItem(getWorldKey(STORAGE_KEY), JSON.stringify({ settings: normalized })); } catch (err) {}
    if (typeof TribalWars !== "undefined") {
      const current = getScriptDataObject() || {};
      TribalWars.scriptData = Object.assign({}, current, { settings: normalized });
    }
  }

  function buildGameUrl(params) {
    const url = new URL("/game.php", window.location.origin);
    const village = params && params.village !== undefined ? params.village : getCurrentVillageId();
    if (village) url.searchParams.set("village", String(village));
    if (typeof game_data !== "undefined" && game_data.player && parseInt(game_data.player.sitter || 0, 10) > 0) {
      url.searchParams.set("t", String(game_data.player.id));
    }
    Object.keys(params || {}).forEach(key => {
      if (key === "village") return;
      const value = params[key];
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    return url.pathname + url.search;
  }

  async function fetchText(url, label) {
    state.debug.requests.push({ at: new Date().toISOString(), label: label || "GET", url: url });
    const response = await fetch(url, { method: "GET", credentials: "same-origin", headers: { Accept: "text/html, */*; q=0.01" } });
    if (!response.ok) throw new Error("HTTP " + response.status + " while loading " + (label || url));
    return response.text();
  }

  function parseHtml(html) { return new DOMParser().parseFromString(html, "text/html"); }

  function parseCoord(text) {
    const match = String(text || "").match(/(\d{1,3})\|(\d{1,3})/);
    if (!match) return null;
    return { x: parseInt(match[1], 10), y: parseInt(match[2], 10), coord: match[1] + "|" + match[2] };
  }

  function getDistance(a, b) {
    const ca = parseCoord(a), cb = parseCoord(b);
    if (!ca || !cb) return 9999;
    return Math.sqrt(Math.pow(ca.x - cb.x, 2) + Math.pow(ca.y - cb.y, 2));
  }

  function getServerNow() {
    const time = cleanText(document.getElementById("serverTime") && document.getElementById("serverTime").textContent);
    const date = cleanText(document.getElementById("serverDate") && document.getElementById("serverDate").textContent);
    if (!time || !date) return new Date();
    const dp = date.split(/[.\/-]/).map(Number);
    const tp = time.split(":").map(Number);
    if (dp.length < 3 || tp.length < 2) return new Date();
    return new Date(dp[2], dp[1] - 1, dp[0], tp[0], tp[1], tp[2] || 0, 0);
  }

  function formatClock(timestamp) {
    if (!timestamp) return "-";
    const d = new Date(timestamp);
    const pad = n => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function getRowVillageInfo(row) {
    const node = row.querySelector(".quickedit-vn, .quickedit-label, a[href*='screen=info_village'], a[href*='village=']");
    const text = cleanText(node ? node.textContent : row.textContent);
    const c = parseCoord(text);
    if (!c) return null;
    const link = row.querySelector("a[href*='village='], a[href*='screen=info_village']");
    const href = link ? link.getAttribute("href") || "" : "";
    const id = (node && node.getAttribute && node.getAttribute("data-id")) || getParam("village", href) || getParam("id", href) || c.coord;
    return { id: String(id), name: text, coord: c.coord };
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .twf-box{margin:10px 0;border:1px solid #7d510f;background:#f4e4bc;color:#3e2504;box-shadow:0 2px 10px rgba(0,0,0,.22);font-size:12px;max-width:1220px}
      .twf-box *{box-sizing:border-box}.twf-head{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:linear-gradient(#785018,#593507);color:#fff1d1;font-weight:bold}
      .twf-head small{font-weight:normal;color:#e7c98d;margin-left:6px}.twf-close,.twf-btn{border:1px solid #7d510f;background:#d5b067;color:#2f1d05;border-radius:2px;padding:4px 9px;cursor:pointer;font-weight:bold}
      .twf-close{background:#2f1d05;color:#fff1d1;border-color:#cba45f}.twf-btn:hover{background:#e7cb91}.twf-btn:disabled{opacity:.5;cursor:not-allowed}.twf-body{padding:10px}
      .twf-grid{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:8px;align-items:end}.twf-field label{display:block;font-weight:bold;margin-bottom:2px}.twf-field input,.twf-field select{width:100%;height:27px;border:1px solid #b58c48;background:#fff9e8;padding:3px 5px;color:#2f1d05}
      .twf-check{display:flex;gap:5px;align-items:center;height:27px;font-weight:bold}.twf-actions{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0}.twf-status{padding:6px 8px;border:1px solid #c5a05d;background:#fff8df;min-height:28px}.twf-status.ok{border-color:#5e913d;background:#edf7e5;color:#245017}.twf-status.warn{border-color:#bd8120;background:#fff0d0;color:#6a3d00}.twf-status.err{border-color:#a84639;background:#f9e5e1;color:#69180f}
      .twf-progress{height:8px;border:1px solid #a67d39;background:#d6ba80;margin:8px 0;display:none}.twf-progress span{display:block;height:100%;background:#7f9d38;width:0}.twf-metrics{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0}.twf-chip{border:1px solid #b18a49;background:#f8e3b3;border-radius:12px;padding:2px 8px;font-size:11px}
      .twf-table-wrap{max-height:560px;overflow:auto;border:1px solid #b58c48;background:#fff9e8;margin-top:8px}.twf-table{width:100%;border-collapse:collapse}.twf-table th{position:sticky;top:0;z-index:1;background:#d0ab62;border-bottom:1px solid #8a6128;padding:5px;text-align:left;white-space:nowrap}.twf-table td{border-top:1px solid #e2c78d;padding:5px;vertical-align:middle;white-space:nowrap}.twf-table tr:nth-child(even){background:#fbefd2}.twf-name{white-space:normal;min-width:155px}.twf-muted{font-size:11px;color:#776440}.twf-pill{display:inline-block;border:1px solid #a98243;border-radius:10px;padding:1px 6px;background:#f7dfaa;font-size:11px}.twf-pill.green{background:#dff1d5;border-color:#6d9b50}.twf-pill.yellow{background:#fff0bb;border-color:#c49a2d}.twf-pill.red{background:#f5d4cf;border-color:#b25248}.twf-pill.blue{background:#d9e8fa;border-color:#6387b0}.twf-send{min-width:58px}.twf-empty{padding:10px;border:1px dashed #b58c48;background:#fff8df;margin-top:8px}
      @media(max-width:850px){.twf-grid{grid-template-columns:repeat(2,minmax(125px,1fr))}.twf-table{font-size:11px}}
    `;
    document.head.appendChild(style);
  }

  function createDialog() {
    closeDialog();
    ensureStyles();
    const sourceField = BUILD.variant === "local" ? "" : `
      <div class="twf-field"><label>Origins</label><select data-ui="sourceMode"><option value="current">Current village</option><option value="group">Current group</option><option value="all">All villages</option></select></div>`;
    const efficientFields = BUILD.variant === "efficient" ? `
      <div class="twf-field"><label>Visible queue</label><input data-ui="targetBatchSize" type="number" min="10" max="500" step="10"></div>
      <div class="twf-field"><label>Origins / fill</label><input data-ui="originBatchSize" type="number" min="1" max="50"></div>
      <div class="twf-field"><label>Prefetch at</label><input data-ui="prefetchRemaining" type="number" min="0" max="100"></div>` : "";

    const box = document.createElement("div");
    box.id = BOX_ID;
    box.className = "twf-box";
    box.innerHTML = `
      <div class="twf-head"><div>${escapeHtml(BUILD.name)} <small>v${escapeHtml(BUILD.version)}</small></div><button class="twf-close" type="button">x</button></div>
      <div class="twf-body">
        <div class="twf-grid">
          ${sourceField}
          <div class="twf-field"><label>Max fields</label><input data-ui="maxDistance" type="number" min="0" step="0.5"></div>
          <div class="twf-field"><label>Arrival gap (min)</label><input data-ui="minArrivalGapMinutes" type="number" min="0" step="1"></div>
          <div class="twf-field"><label>Template</label><select data-ui="templateMode"><option value="auto">Auto A/B</option><option value="a">Always A</option><option value="b">Always B</option></select></div>
          <div class="twf-field"><label>Reports</label><select data-ui="reportFilter"><option value="safe">Safe / unknown</option><option value="green">Green only</option><option value="not-red">Not red</option><option value="all">All</option></select></div>
          <div class="twf-field"><label>A speed fallback</label><input data-ui="manualTemplateASpeed" type="number" min="0" step="0.1" placeholder="0 = auto"></div>
          <div class="twf-field"><label>B speed fallback</label><input data-ui="manualTemplateBSpeed" type="number" min="0" step="0.1" placeholder="0 = auto"></div>
          ${efficientFields}
          <label class="twf-check"><input data-ui="maxLootUsesB" type="checkbox"> Max-loot -> B</label>
          <label class="twf-check"><input data-ui="includeNewBarbarians" type="checkbox"> Include new barbarians</label>
          <label class="twf-check"><input data-ui="debugConsole" type="checkbox"> Debug console</label>
        </div>
        <div class="twf-actions">
          <button class="twf-btn" data-ui="buildButton" type="button">Analyse & build</button>
          <button class="twf-btn" data-ui="sendNextButton" type="button" disabled>Send next</button>
          ${BUILD.variant === "efficient" ? '<button class="twf-btn" data-ui="loadMoreButton" type="button" disabled>Load next batch</button>' : ''}
          <button class="twf-btn" data-ui="copyDebugButton" type="button">Copy debug</button>
        </div>
        <div class="twf-progress" data-ui="progress"><span></span></div>
        <div class="twf-status" data-ui="status">Ready.</div>
        <div class="twf-metrics" data-ui="metrics"></div>
        <div data-ui="results"></div>
      </div>`;

    const anchor = document.querySelector("#content_value") || document.querySelector("#contentContainer") || document.body;
    anchor.insertBefore(box, anchor.firstChild || null);
    ui.box = box;
    ["sourceMode","maxDistance","minArrivalGapMinutes","templateMode","reportFilter","manualTemplateASpeed","manualTemplateBSpeed","targetBatchSize","originBatchSize","prefetchRemaining","maxLootUsesB","includeNewBarbarians","debugConsole","buildButton","sendNextButton","loadMoreButton","copyDebugButton","progress","status","metrics","results"].forEach(key => {
      ui[key] = box.querySelector('[data-ui="' + key + '"]');
    });
    ui.progressBar = ui.progress.querySelector("span");
    box.querySelector(".twf-close").addEventListener("click", closeDialog);
    ui.buildButton.addEventListener("click", startBuild);
    ui.sendNextButton.addEventListener("click", sendNext);
    if (ui.loadMoreButton) ui.loadMoreButton.addEventListener("click", loadMoreEfficient);
    ui.copyDebugButton.addEventListener("click", copyDebug);
    applySettingsToUi(state.settings);
    Array.from(box.querySelectorAll("input,select")).forEach(el => el.addEventListener("change", function () { saveSettings(getSettings()); }));
    document.addEventListener("keydown", onKeyDown, true);
  }

  function closeDialog() {
    const old = document.getElementById(BOX_ID);
    if (old) old.remove();
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function applySettingsToUi(s) {
    if (ui.sourceMode) ui.sourceMode.value = s.sourceMode;
    ui.maxDistance.value = s.maxDistance || "";
    ui.minArrivalGapMinutes.value = s.minArrivalGapMinutes;
    ui.templateMode.value = s.templateMode;
    ui.reportFilter.value = s.reportFilter;
    ui.manualTemplateASpeed.value = s.manualTemplateASpeed || "";
    ui.manualTemplateBSpeed.value = s.manualTemplateBSpeed || "";
    if (ui.targetBatchSize) ui.targetBatchSize.value = s.targetBatchSize;
    if (ui.originBatchSize) ui.originBatchSize.value = s.originBatchSize;
    if (ui.prefetchRemaining) ui.prefetchRemaining.value = s.prefetchRemaining;
    ui.maxLootUsesB.checked = s.maxLootUsesB;
    ui.includeNewBarbarians.checked = s.includeNewBarbarians;
    ui.debugConsole.checked = s.debugConsole;
  }

  function getSettings() {
    return normalizeSettings({
      sourceMode: ui.sourceMode ? ui.sourceMode.value : "current",
      maxDistance: ui.maxDistance.value,
      minArrivalGapMinutes: ui.minArrivalGapMinutes.value,
      templateMode: ui.templateMode.value,
      reportFilter: ui.reportFilter.value,
      manualTemplateASpeed: ui.manualTemplateASpeed.value,
      manualTemplateBSpeed: ui.manualTemplateBSpeed.value,
      targetBatchSize: ui.targetBatchSize ? ui.targetBatchSize.value : DEFAULTS.targetBatchSize,
      originBatchSize: ui.originBatchSize ? ui.originBatchSize.value : DEFAULTS.originBatchSize,
      prefetchRemaining: ui.prefetchRemaining ? ui.prefetchRemaining.value : DEFAULTS.prefetchRemaining,
      maxLootUsesB: ui.maxLootUsesB.checked,
      includeNewBarbarians: ui.includeNewBarbarians.checked,
      debugConsole: ui.debugConsole.checked,
      requestDelayMs: state.settings.requestDelayMs,
      sendDelayMs: state.settings.sendDelayMs,
      commandsCacheSeconds: state.settings.commandsCacheSeconds,
      maxFarmPagesPerOrigin: state.settings.maxFarmPagesPerOrigin
    });
  }

  function setStatus(text, type) {
    if (!ui.status) return;
    ui.status.className = "twf-status" + (type ? " " + type : "");
    ui.status.textContent = text;
  }

  function setProgress(done, total) {
    if (!ui.progress) return;
    if (!total) { ui.progress.style.display = "none"; ui.progressBar.style.width = "0%"; return; }
    ui.progress.style.display = "block";
    ui.progressBar.style.width = Math.max(0, Math.min(100, Math.round((done / total) * 100))) + "%";
  }

  function renderMetrics() {
    if (!ui.metrics) return;
    const remaining = state.plan.filter(x => x.status === "ready").length;
    const speeds = state.debug.templates.speeds || {};
    const chips = [
      "Origins " + state.loadedOrigins.size + "/" + state.origins.length,
      "Ready " + remaining,
      "Sent " + state.sentCount,
      "Skipped " + state.skippedCount,
      "Known attacks " + countArrivalIndex(state.commandArrivals),
      "A speed " + (speeds.a ? speeds.a.toFixed(2) + "m/f" : "?"),
      "B speed " + (speeds.b ? speeds.b.toFixed(2) + "m/f" : "?")
    ];
    ui.metrics.innerHTML = chips.map(x => '<span class="twf-chip">' + escapeHtml(x) + '</span>').join("");
  }

  function countArrivalIndex(map) {
    let n = 0;
    map.forEach(list => { n += list.length; });
    return n;
  }

  async function startBuild() {
    if (state.loadingMore || state.sendLocked) return;
    const settings = getSettings();
    saveSettings(settings);
    state.debug = resetDebug();
    state.origins = [];
    state.originCursor = 0;
    state.loadedOrigins = new Set();
    state.commandArrivals = new Map();
    state.commandLoadedAt = 0;
    state.plan = [];
    state.sentCount = 0;
    state.skippedCount = 0;
    state.planSerial = 1;
    state.plannedArrivals = new Map();
    state.templateIds = { a: "", b: "" };
    state.templateUnits = { a: null, b: null };
    state.finishedOrigins = false;
    state.deferredTargets = [];
    ui.results.innerHTML = "";
    ui.sendNextButton.disabled = true;
    if (ui.loadMoreButton) ui.loadMoreButton.disabled = true;

    try {
      ui.buildButton.disabled = true;
      setStatus("Loading origin list and attack-arrival index...", "warn");
      const results = await Promise.all([loadOrigins(settings), loadCommandArrivals(true, settings), loadWorldSpeedInfo()]);
      state.origins = results[0];
      if (!state.origins.length) throw new Error("No origin villages found.");
      if (settings.includeNewBarbarians) await loadBarbarianMap();

      if (BUILD.variant === "efficient") {
        await fillEfficientQueue(true);
      } else {
        await loadAllSelectedOrigins(settings);
        renderPlan();
      }

      renderMetrics();
      const remaining = state.plan.some(x => x.status === "ready");
      ui.sendNextButton.disabled = !remaining;
      if (ui.loadMoreButton) ui.loadMoreButton.disabled = state.finishedOrigins;
      if (settings.debugConsole) console.log(BUILD.name + " debug", state.debug);
    } catch (err) {
      console.error(BUILD.name + " failed", err);
      setStatus(err && err.message ? err.message : String(err), "err");
    } finally {
      ui.buildButton.disabled = false;
      setProgress(0, 0);
    }
  }

  async function loadOrigins(settings) {
    if (BUILD.variant === "local" || settings.sourceMode === "current") {
      const current = getCurrentVillage();
      return current.id ? [current] : [];
    }
    const group = settings.sourceMode === "all" ? "0" : getCurrentGroupId();
    const url = buildGameUrl({ screen: "overview_villages", mode: "prod", page: "-1", group: group });
    const doc = parseHtml(await fetchText(url, "origin villages"));
    const rows = Array.from(doc.querySelectorAll("#production_table tbody tr, #content_value tr.row_a, #content_value tr.row_b"));
    const seen = new Set(), out = [];
    rows.forEach(row => {
      if (row.querySelector("th")) return;
      const info = getRowVillageInfo(row);
      if (!info || !info.id || seen.has(info.id)) return;
      seen.add(info.id); out.push(info);
    });
    return out;
  }

  async function loadAllSelectedOrigins(settings) {
    const total = state.origins.length;
    for (let i = 0; i < total; i++) {
      const origin = state.origins[i];
      setProgress(i, total);
      setStatus("Analysing origin " + (i + 1) + "/" + total + ": " + (origin.coord || origin.name), "warn");
      await loadAndPlanOrigin(origin, settings);
      state.originCursor = i + 1;
      if (settings.requestDelayMs && i < total - 1) await wait(settings.requestDelayMs);
    }
    state.finishedOrigins = true;
    setStatus("Plan ready: " + state.plan.filter(x => x.status === "ready").length + " attacks.", state.plan.length ? "ok" : "warn");
  }

  async function loadMoreEfficient() {
    if (BUILD.variant !== "efficient" || state.loadingMore || state.finishedOrigins) return;
    await fillEfficientQueue(false);
  }

  async function fillEfficientQueue(initial) {
    if (state.loadingMore) return;
    state.loadingMore = true;
    if (ui.loadMoreButton) ui.loadMoreButton.disabled = true;
    const settings = getSettings();
    try {
      await loadCommandArrivals(false, settings);
      let loadedThisFill = 0;
      let ready = state.plan.filter(x => x.status === "ready").length;
      if (ready < settings.targetBatchSize && state.deferredTargets.length) {
        consumeDeferredTargets(settings, settings.targetBatchSize);
        ready = state.plan.filter(x => x.status === "ready").length;
      }
      while (state.originCursor < state.origins.length && ready < settings.targetBatchSize && loadedThisFill < settings.originBatchSize) {
        const origin = state.origins[state.originCursor++];
        setStatus("Loading compact batch: origin " + state.originCursor + "/" + state.origins.length + "...", "warn");
        await loadAndPlanOrigin(origin, settings, settings.targetBatchSize);
        loadedThisFill++;
        ready = state.plan.filter(x => x.status === "ready").length;
        if (ready < settings.targetBatchSize && state.deferredTargets.length) {
          consumeDeferredTargets(settings, settings.targetBatchSize);
          ready = state.plan.filter(x => x.status === "ready").length;
        }
        if (settings.requestDelayMs && ready < settings.targetBatchSize && state.originCursor < state.origins.length) await wait(settings.requestDelayMs);
      }
      state.finishedOrigins = state.originCursor >= state.origins.length;
      renderPlan(); renderMetrics();
      const remaining = state.plan.some(x => x.status === "ready");
      ui.sendNextButton.disabled = !remaining;
      setStatus((initial ? "Initial" : "Next") + " batch ready: " + ready + " visible attack(s)." + (state.finishedOrigins ? " All origins exhausted." : ""), ready ? "ok" : "warn");
    } catch (err) {
      setStatus(err && err.message ? err.message : String(err), "err");
    } finally {
      state.loadingMore = false;
      if (ui.loadMoreButton) ui.loadMoreButton.disabled = state.finishedOrigins;
    }
  }

  async function loadAndPlanOrigin(origin, settings, maxReady) {
    if (state.loadedOrigins.has(String(origin.id))) return;
    const targets = await loadFarmTargetsPaged(origin, settings);
    state.loadedOrigins.add(String(origin.id));
    const merged = settings.includeNewBarbarians ? mergeNewBarbarians(origin, targets, settings) : targets;
    planOriginTargets(origin, merged, settings, maxReady || 0);
  }

  async function loadFarmTargetsPaged(origin, settings) {
    const all = [];
    let page = 0;
    let maxPageSeen = 0;
    let stop = false;
    while (!stop && page < settings.maxFarmPagesPerOrigin) {
      const url = buildGameUrl({ village: origin.id, screen: "am_farm", order: "distance", dir: "asc", Farm_page: page });
      const doc = parseHtml(await fetchText(url, "Loot Assistant " + origin.coord + " page " + page));
      discoverTemplates(doc);
      const parsed = parseFarmRows(doc, origin, url);
      discoverTemplates(doc);
      const distances = parsed.map(x => x.distance).filter(x => Number.isFinite(x) && x < 9999);
      all.push.apply(all, parsed.filter(x => settings.maxDistance <= 0 || x.distance <= settings.maxDistance));
      maxPageSeen = Math.max(maxPageSeen, getMaxFarmPage(doc));
      state.debug.originPages.push({ origin: origin.coord, page: page, rows: parsed.length, kept: parsed.filter(x => settings.maxDistance <= 0 || x.distance <= settings.maxDistance).length, maxDistanceOnPage: distances.length ? Math.max.apply(null, distances) : null });

      if (settings.maxDistance > 0 && distances.length && Math.min.apply(null, distances) > settings.maxDistance) stop = true;
      else if (settings.maxDistance > 0 && distances.length && Math.max.apply(null, distances) > settings.maxDistance) stop = true;
      else if (page >= maxPageSeen) stop = true;
      else { page++; if (settings.requestDelayMs) await wait(settings.requestDelayMs); }
    }
    return dedupeTargets(all);
  }

  function getMaxFarmPage(doc) {
    let max = 0;
    Array.from(doc.querySelectorAll("a[href*='Farm_page=']")).forEach(a => {
      const p = parseInt(getParam("Farm_page", a.getAttribute("href") || ""), 10);
      if (Number.isFinite(p)) max = Math.max(max, p);
    });
    return max;
  }

  function dedupeTargets(list) {
    const seen = new Set(), out = [];
    list.forEach(x => {
      const key = String(x.origin.id) + ":" + String(x.targetId || x.targetCoord);
      if (seen.has(key)) return;
      seen.add(key); out.push(x);
    });
    return out;
  }

  function parseFarmRows(doc, origin, url) {
    const rows = Array.from(doc.querySelectorAll("#plunder_list tr[id^='village_'], #plunder_list tbody tr.row_a, #plunder_list tbody tr.row_b"));
    const out = [];
    rows.forEach((row, rowIndex) => {
      if (row.querySelector("th")) return;
      const text = cleanText(row.textContent);
      const coord = parseCoord(text);
      if (!coord) return;
      const targetId = (row.id && row.id.match(/village_(\d+)/) || [])[1] || getTargetIdFromLinks(row) || "";
      const actionA = parseFarmAction(row, "a", targetId);
      const actionB = parseFarmAction(row, "b", targetId);
      if (!actionA && !actionB) return;
      if (actionA && actionA.templateId) state.templateIds.a = state.templateIds.a || actionA.templateId;
      if (actionB && actionB.templateId) state.templateIds.b = state.templateIds.b || actionB.templateId;
      const distance = detectDistance(row, origin.coord, coord.coord);
      out.push({
        origin: origin,
        targetId: String(targetId || coord.coord),
        targetCoord: coord.coord,
        targetName: getTargetName(row, coord.coord),
        distance: distance,
        report: detectReport(row),
        fullLoot: detectFullLoot(row),
        actionA: actionA,
        actionB: actionB,
        sourceUrl: url,
        rowIndex: rowIndex,
        rawText: text.slice(0, 220)
      });
    });
    return out;
  }

  function getTargetIdFromLinks(row) {
    const link = row.querySelector("a[href*='screen=info_village'][href*='id='], a[href*='target='], a[href*='target_id=']");
    const href = link ? link.getAttribute("href") || "" : "";
    return getParam("target", href) || getParam("target_id", href) || getParam("id", href) || "";
  }

  function parseFarmAction(row, letter, rowTargetId) {
    const candidates = Array.from(row.querySelectorAll("a,button,input[type='button'],input[type='submit']"));
    const lower = letter.toLowerCase();
    const node = candidates.find(el => {
      const marker = cleanText([el.className, el.id, el.getAttribute && el.getAttribute("title"), el.getAttribute && el.getAttribute("onclick"), el.getAttribute && el.getAttribute("href"), el.textContent, el.value].filter(Boolean).join(" ")).toLowerCase();
      return marker.includes("farm_icon_" + lower) || marker.includes("template_" + lower) || marker.includes("template " + lower);
    });
    if (!node) return null;
    const href = node.getAttribute("href") || "";
    const onclick = node.getAttribute("onclick") || "";
    const html = node.outerHTML || "";
    const marker = href + " " + onclick + " " + html;
    const nums = onclick.match(/\d+/g) || [];
    const targetId = node.getAttribute("data-target") || node.getAttribute("data-target-id") || getParam("target", href) || getParam("target_id", href) || rowTargetId || (nums.length >= 1 ? nums[0] : "");
    let templateId = node.getAttribute("data-template-id") || node.getAttribute("data-template") || getParam("template_id", href) || getParam("template", href) || firstMatch(marker, /template_id["']?\s*[:=]\s*["']?(\d+)/i) || firstMatch(marker, /template["']?\s*[:=]\s*["']?(\d+)/i);
    if (!templateId && nums.length >= 2) templateId = nums[nums.length - 1];
    if (!templateId) templateId = state.templateIds[lower] || "";
    const disabled = Boolean(node.disabled || /disabled|inactive|unavailable/.test(cleanText(node.className).toLowerCase()));
    return { letter: lower, targetId: String(targetId || ""), templateId: String(templateId || ""), disabled: disabled };
  }

  function firstMatch(text, re) { const m = String(text || "").match(re); return m ? m[1] : ""; }

  function getTargetName(row, fallback) {
    const link = row.querySelector("a[href*='screen=info_village']");
    const text = cleanText(link && link.textContent);
    return text || fallback;
  }

  function detectDistance(row, originCoord, targetCoord) {
    const cells = Array.from(row.children || []);
    for (let i = 0; i < cells.length; i++) {
      const text = cleanText(cells[i].textContent || "");
      if (/^\d+(?:[.,]\d+)?$/.test(text)) {
        const v = parseFloatSafe(text, 0);
        if (v > 0 && v < 500) return v;
      }
    }
    return getDistance(originCoord, targetCoord);
  }

  function detectReport(row) {
    const marker = cleanText([row.className, Array.from(row.querySelectorAll("img,span,a")).map(n => [n.className, n.getAttribute && n.getAttribute("src"), n.getAttribute && n.getAttribute("title"), n.getAttribute && n.getAttribute("alt")].filter(Boolean).join(" ")).join(" ")].join(" ")).toLowerCase();
    if (/green|dots\/green/.test(marker)) return "green";
    if (/yellow|dots\/yellow/.test(marker)) return "yellow";
    if (/red_blue|red-yellow|red_yellow/.test(marker)) return "red";
    if (/red|dots\/red/.test(marker)) return "red";
    if (/blue|dots\/blue/.test(marker)) return "blue";
    return "unknown";
  }

  function detectFullLoot(row) {
    const marker = cleanText(Array.from(row.querySelectorAll("img,span,a")).map(n => [n.className, n.getAttribute && n.getAttribute("src"), n.getAttribute && n.getAttribute("title"), n.getAttribute && n.getAttribute("alt")].filter(Boolean).join(" ")).join(" ")).toLowerCase();
    return /max_loot\/1|max loot|full loot|full haul/.test(marker);
  }

  function passesReport(target, settings) {
    if (settings.reportFilter === "all") return true;
    if (settings.reportFilter === "green") return target.report === "green";
    if (settings.reportFilter === "not-red") return target.report !== "red";
    return target.report !== "red";
  }

  function chooseAction(target, settings) {
    if (settings.templateMode === "a") return normalizeAction(target.actionA, "a", target.targetId);
    if (settings.templateMode === "b") return normalizeAction(target.actionB, "b", target.targetId);
    if (settings.maxLootUsesB && target.fullLoot) {
      const b = normalizeAction(target.actionB, "b", target.targetId);
      if (b && !b.disabled) return b;
    }
    const a = normalizeAction(target.actionA, "a", target.targetId);
    if (a && !a.disabled) return a;
    const b = normalizeAction(target.actionB, "b", target.targetId);
    if (b && !b.disabled) return b;
    return a || b;
  }

  function normalizeAction(action, letter, targetId) {
    if (!action && state.templateIds[letter]) return { letter: letter, targetId: String(targetId), templateId: String(state.templateIds[letter]), disabled: false };
    if (!action) return null;
    if (!action.templateId && state.templateIds[letter]) action.templateId = state.templateIds[letter];
    if (!action.targetId) action.targetId = String(targetId);
    return action;
  }

  function planOriginTargets(origin, targets, settings, maxReady) {
    const sorted = targets.slice().sort((a,b) => a.distance - b.distance);
    for (let i = 0; i < sorted.length; i++) {
      if (maxReady > 0 && state.plan.filter(x => x.status === "ready").length >= maxReady) {
        state.deferredTargets.push.apply(state.deferredTargets, sorted.slice(i));
        break;
      }
      tryPlanTarget(sorted[i], settings);
    }
  }

  function consumeDeferredTargets(settings, maxReady) {
    let safety = 0;
    while (state.deferredTargets.length && state.plan.filter(x => x.status === "ready").length < maxReady && safety < 5000) {
      safety++;
      tryPlanTarget(state.deferredTargets.shift(), settings);
    }
  }

  function tryPlanTarget(target, settings) {
    const origin = target.origin;
    if (settings.maxDistance > 0 && target.distance > settings.maxDistance) return reject(target, "distance");
    if (!passesReport(target, settings)) return reject(target, "report");
    const action = chooseAction(target, settings);
    if (!action || action.disabled || !action.targetId || !action.templateId) return reject(target, "no usable template action/id");
    const speed = getTemplateSpeed(action.letter, settings);
    if (!(speed > 0)) return reject(target, "template speed unknown; set fallback speed");
    const travelSeconds = Math.max(1, Math.round(target.distance * speed * 60));
    const arrival = getServerNow().getTime() + travelSeconds * 1000;
    const conflict = findArrivalConflict(target.targetCoord, arrival, settings.minArrivalGapMinutes, true);
    if (conflict) return reject(target, "arrival gap", { candidateArrival: arrival, nearestArrival: conflict.timestamp, gapSeconds: conflict.gapSeconds });
    addArrival(state.plannedArrivals, target.targetCoord, arrival);
    const item = {
      id: state.planSerial++, status: "ready", origin: origin, targetId: String(target.targetId), targetCoord: target.targetCoord, targetName: target.targetName,
      distance: target.distance, report: target.report, fullLoot: target.fullLoot, action: action, templateLetter: action.letter.toUpperCase(),
      speedMinutesPerField: speed, travelSeconds: travelSeconds, plannedArrival: arrival, sourceUrl: target.sourceUrl
    };
    state.plan.push(item);
    state.debug.accepted.push({ origin: origin.coord, target: target.targetCoord, distance: target.distance, template: item.templateLetter, arrival: new Date(arrival).toISOString() });
    return item;
  }

  function reject(target, reason, extra) {
    state.debug.rejected.push(Object.assign({ origin: target.origin && target.origin.coord, target: target.targetCoord, reason: reason }, extra || {}));
  }

  function findArrivalConflict(coord, timestamp, gapMinutes, includePlanned) {
    const gapMs = Math.max(0, gapMinutes || 0) * 60000;
    if (!gapMs) return null;
    const lists = [state.commandArrivals.get(coord) || []];
    if (includePlanned) lists.push(state.plannedArrivals.get(coord) || []);
    let best = null;
    lists.forEach(list => list.forEach(ts => {
      const diff = Math.abs(timestamp - ts);
      if (diff < gapMs && (!best || diff < best.gapSeconds * 1000)) best = { timestamp: ts, gapSeconds: diff / 1000 };
    }));
    return best;
  }

  function addArrival(map, coord, ts) {
    if (!map.has(coord)) map.set(coord, []);
    const list = map.get(coord);
    list.push(ts); list.sort((a,b) => a-b);
  }

  async function loadCommandArrivals(force, settings) {
    const age = Date.now() - state.commandLoadedAt;
    if (!force && state.commandLoadedAt && age < settings.commandsCacheSeconds * 1000) return state.commandArrivals;
    const url = buildGameUrl({ screen: "overview_villages", mode: "commands", type: "attack", group: "0", page: "-1" });
    const doc = parseHtml(await fetchText(url, "outgoing attack arrivals"));
    const parsed = parseCommandRows(doc);
    state.commandArrivals = parsed;
    state.commandLoadedAt = Date.now();
    return parsed;
  }

  function parseCommandRows(doc) {
    const map = new Map();
    const rows = Array.from(doc.querySelectorAll("#commands_table tbody tr, table.vis tbody tr.row_a, table.vis tbody tr.row_b"));
    state.debug.commands.rows = rows.length;
    rows.forEach((row, index) => {
      if (row.querySelector("th")) return;
      const coord = getCommandTargetCoord(row);
      const arrival = getArrivalTimestamp(row);
      if (!coord || !arrival) {
        if (state.debug.commands.skipped.length < 12) state.debug.commands.skipped.push({ index: index, coord: coord, arrival: arrival, text: cleanText(row.textContent).slice(0,180) });
        return;
      }
      addArrival(map, coord, arrival);
      state.debug.commands.parsed++;
      if (state.debug.commands.samples.length < 12) state.debug.commands.samples.push({ coord: coord, arrival: new Date(arrival).toISOString(), text: cleanText(row.textContent).slice(0,180) });
    });
    return map;
  }

  function getCommandTargetCoord(row) {
    const firstCell = row.querySelector("td");
    if (firstCell) {
      const c = parseCoord(firstCell.textContent || "");
      if (c) return c.coord;
    }
    const links = Array.from(row.querySelectorAll("a[href*='screen=info_village'],a[href*='info_village']"));
    for (let i=0;i<links.length;i++) { const c = parseCoord(links[i].textContent || ""); if (c) return c.coord; }
    const all = cleanText(row.textContent).match(/\d{1,3}\|\d{1,3}/g) || [];
    return all.length ? all[0] : "";
  }

  function getArrivalTimestamp(row) {
    const timed = Array.from(row.querySelectorAll("[data-endtime],[data-end-time],[data-arrival],[data-timestamp]"));
    for (let i=0;i<timed.length;i++) {
      const attrs = ["data-endtime","data-end-time","data-arrival","data-timestamp"];
      for (let j=0;j<attrs.length;j++) {
        const raw = timed[i].getAttribute(attrs[j]);
        if (!raw) continue;
        let n = parseFloat(raw);
        if (!Number.isFinite(n)) continue;
        if (n > 1e12) return n;
        if (n > 1e9) return n * 1000;
      }
    }
    return parseArrivalText(cleanText(row.textContent));
  }

  function parseArrivalText(text) {
    const now = getServerNow();
    let m = text.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})[^\d]+(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) {
      let y = parseInt(m[3],10); if (y < 100) y += 2000;
      return new Date(y, parseInt(m[2],10)-1, parseInt(m[1],10), parseInt(m[4],10), parseInt(m[5],10), parseInt(m[6],10)).getTime();
    }
    m = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    const d = new Date(now.getTime());
    d.setHours(parseInt(m[1],10), parseInt(m[2],10), parseInt(m[3],10), 0);
    if (/tomorrow/i.test(text)) d.setDate(d.getDate()+1);
    else if (d.getTime() < now.getTime() - 60000) d.setDate(d.getDate()+1);
    return d.getTime();
  }

  async function loadWorldSpeedInfo() {
    const cachedUnits = readCache(UNIT_CACHE_KEY, 24*3600*1000);
    const cachedConfig = readCache(CONFIG_CACHE_KEY, 24*3600*1000);
    if (cachedUnits) state.unitSpeeds = cachedUnits;
    if (cachedConfig && cachedConfig.unitSpeed) state.worldUnitSpeed = cachedConfig.unitSpeed;
    if (!state.unitSpeeds) {
      try {
        const xml = await fetchText("/interface.php?func=get_unit_info", "unit speed interface");
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const speeds = {};
        UNIT_KEYS.forEach(unit => { const node = doc.querySelector(unit + " > speed"); if (node) speeds[unit] = parseFloatSafe(node.textContent, 0); });
        state.unitSpeeds = speeds; writeCache(UNIT_CACHE_KEY, speeds);
      } catch (err) { state.unitSpeeds = {}; }
    }
    if (!cachedConfig) {
      try {
        const xml = await fetchText("/interface.php?func=get_config", "world config interface");
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const unitSpeed = parseFloatSafe(doc.querySelector("unit_speed") && doc.querySelector("unit_speed").textContent, 1) || 1;
        state.worldUnitSpeed = unitSpeed; writeCache(CONFIG_CACHE_KEY, { unitSpeed: unitSpeed });
      } catch (err) { state.worldUnitSpeed = 1; }
    }
  }

  function readCache(key, ttl) {
    try { const raw = localStorage.getItem(getWorldKey(key)); if (!raw) return null; const obj = JSON.parse(raw); if (Date.now()-obj.at>ttl) return null; return obj.value; } catch(err) { return null; }
  }
  function writeCache(key, value) { try { localStorage.setItem(getWorldKey(key), JSON.stringify({ at: Date.now(), value: value })); } catch(err) {} }

  function discoverTemplates(doc) {
    discoverTemplateUnitsFromDom(doc);
    discoverTemplateUnitsFromOfficialGlobals();
    state.debug.templates.ids = Object.assign({}, state.templateIds);
    state.debug.templates.units = JSON.parse(JSON.stringify(state.templateUnits));
    state.debug.templates.speeds = { a: getTemplateSpeed("a", getSettings()), b: getTemplateSpeed("b", getSettings()) };
  }

  function discoverTemplateUnitsFromDom(doc) {
    ["a","b"].forEach(letter => {
      if (state.templateUnits[letter]) return;
      const containers = Array.from(doc.querySelectorAll("form,table,div,fieldset,tr")).filter(node => {
        const marker = cleanText([node.id,node.className,node.getAttribute && node.getAttribute("data-template"),node.getAttribute && node.getAttribute("data-template-id")].filter(Boolean).join(" ") + " " + (node.querySelector("legend,h3,h4,th") ? node.querySelector("legend,h3,h4,th").textContent : "")).toLowerCase();
        return new RegExp("(?:template|farm)[ _-]*" + letter + "(?:\\b|_)").test(marker) || new RegExp("\\btemplate\\s+" + letter + "\\b").test(marker);
      });
      for (let i=0;i<containers.length;i++) {
        const counts = extractUnitInputs(containers[i]);
        if (Object.keys(counts).length) { state.templateUnits[letter] = counts; state.debug.templates.discovery.push({ method:"dom", letter:letter, counts:counts }); return; }
      }
    });
  }

  function extractUnitInputs(container) {
    const counts = {};
    Array.from(container.querySelectorAll("input,select")).forEach(el => {
      const marker = cleanText([el.name,el.id,el.className,el.getAttribute && el.getAttribute("data-unit")].filter(Boolean).join(" ")).toLowerCase();
      const unit = UNIT_KEYS.find(u => new RegExp("(^|[^a-z])" + u + "([^a-z]|$)").test(marker));
      if (!unit) return;
      const value = parseInt(el.value,10);
      if (Number.isFinite(value) && value > 0) counts[unit] = value;
    });
    return counts;
  }

  function discoverTemplateUnitsFromOfficialGlobals() {
    if (state.templateUnits.a && state.templateUnits.b) return;
    const root = window.Accountmanager;
    if (!root || typeof root !== "object") return;
    const seen = new WeakSet();
    const candidates = [];
    function walk(obj, path, depth) {
      if (!obj || typeof obj !== "object" || depth > 5 || seen.has(obj)) return;
      seen.add(obj);
      const counts = {};
      UNIT_KEYS.forEach(unit => { const v = obj[unit]; if (Number.isFinite(Number(v)) && Number(v)>0) counts[unit]=Number(v); });
      if (Object.keys(counts).length && /farm|template/i.test(path)) candidates.push({ path:path, counts:counts, id:obj.id || obj.template_id || obj.templateId || "", name:obj.name || obj.label || "" });
      Object.keys(obj).slice(0,80).forEach(key => { try { walk(obj[key], path + "." + key, depth+1); } catch(err) {} });
    }
    walk(root, "Accountmanager", 0);
    candidates.forEach(c => {
      const marker = (c.path + " " + c.name).toLowerCase();
      let letter = "";
      if (/(^|[._\-])a($|[._\-])|template\s*a/.test(marker)) letter = "a";
      if (/(^|[._\-])b($|[._\-])|template\s*b/.test(marker)) letter = "b";
      if (!letter && c.id) {
        if (String(c.id) === String(state.templateIds.a)) letter = "a";
        else if (String(c.id) === String(state.templateIds.b)) letter = "b";
      }
      if (letter && !state.templateUnits[letter]) { state.templateUnits[letter] = c.counts; state.debug.templates.discovery.push({ method:"official-global", letter:letter, path:c.path, counts:c.counts }); }
    });
  }

  function getTemplateSpeed(letter, settings) {
    const manual = letter === "a" ? settings.manualTemplateASpeed : settings.manualTemplateBSpeed;
    if (manual > 0) return manual;
    const counts = state.templateUnits[letter];
    if (!counts || !state.unitSpeeds) return 0;
    let slowest = 0;
    Object.keys(counts).forEach(unit => { if (counts[unit] > 0 && state.unitSpeeds[unit] > 0) slowest = Math.max(slowest, state.unitSpeeds[unit]); });
    if (!slowest) return 0;
    return slowest / Math.max(0.01, state.worldUnitSpeed || 1);
  }

  async function loadBarbarianMap() {
    const cached = readCache(BARB_CACHE_KEY, 10*60*1000);
    if (cached) { state.barbarians = cached; return cached; }
    const text = await fetchText("/map/village.txt", "barbarian map");
    const out = [];
    text.split(/\r?\n/).forEach(line => {
      if (!line) return;
      const p = line.split(",");
      if (p.length < 5 || String(p[4]) !== "0") return;
      out.push({ id:String(p[0]), name:p[1] || (p[2]+"|"+p[3]), coord:p[2]+"|"+p[3] });
    });
    state.barbarians = out; writeCache(BARB_CACHE_KEY, out); return out;
  }

  function mergeNewBarbarians(origin, farmTargets, settings) {
    if (!state.barbarians || !state.barbarians.length) return farmTargets;
    const known = new Set(farmTargets.map(x => x.targetCoord));
    const added = [];
    state.barbarians.forEach(v => {
      if (known.has(v.coord)) return;
      const distance = getDistance(origin.coord, v.coord);
      if (settings.maxDistance > 0 && distance > settings.maxDistance) return;
      added.push({ origin:origin,targetId:v.id,targetCoord:v.coord,targetName:v.name,distance:distance,report:"unknown",fullLoot:false,actionA:state.templateIds.a?{letter:"a",targetId:v.id,templateId:state.templateIds.a,disabled:false}:null,actionB:state.templateIds.b?{letter:"b",targetId:v.id,templateId:state.templateIds.b,disabled:false}:null,sourceUrl:"/map/village.txt" });
    });
    return farmTargets.concat(added);
  }

  function renderPlan() {
    ui.results.innerHTML = "";
    const ready = state.plan.filter(x => x.status === "ready");
    if (!ready.length) { ui.results.innerHTML = '<div class="twf-empty"><strong>No valid attacks currently planned.</strong><br>Check report filters, max fields, arrival gap and template-speed detection.</div>'; return; }
    const wrap = document.createElement("div"); wrap.className = "twf-table-wrap";
    const table = document.createElement("table"); table.className = "twf-table";
    table.innerHTML = '<thead><tr><th>#</th><th>Origin</th><th>Target</th><th>Fields</th><th>Template</th><th>Arrival</th><th>Nearest gap</th><th>Report</th><th>Action</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector("tbody");
    ready.slice(0, BUILD.variant === "efficient" ? getSettings().targetBatchSize : ready.length).forEach(item => {
      const nearest = nearestGapMinutes(item.targetCoord, item.plannedArrival);
      const tr = document.createElement("tr"); tr.setAttribute("data-plan-id", item.id);
      tr.innerHTML = '<td>'+item.id+'</td><td class="twf-name"><strong>'+escapeHtml(item.origin.name)+'</strong><div class="twf-muted">'+escapeHtml(item.origin.coord)+'</div></td><td class="twf-name"><strong>'+escapeHtml(item.targetName)+'</strong><div class="twf-muted">'+escapeHtml(item.targetCoord)+(item.fullLoot?' · max-loot':'')+'</div></td><td>'+item.distance.toFixed(1)+'</td><td><span class="twf-pill">'+escapeHtml(item.templateLetter)+'</span></td><td>'+formatClock(item.plannedArrival)+'</td><td>'+(nearest===null?'—':nearest.toFixed(1)+'m')+'</td><td>'+renderReport(item.report)+'</td><td><button class="twf-btn twf-send" type="button" data-send-id="'+item.id+'">Send</button></td>';
      tbody.appendChild(tr);
    });
    wrap.appendChild(table); ui.results.appendChild(wrap);
    Array.from(wrap.querySelectorAll("[data-send-id]")).forEach(btn => btn.addEventListener("click", () => sendItem(parseInt(btn.getAttribute("data-send-id"),10))));
  }

  function renderReport(report) {
    const cls = ["green","yellow","red","blue"].includes(report) ? report : "";
    return '<span class="twf-pill '+cls+'">'+escapeHtml(report || "unknown")+'</span>';
  }

  function nearestGapMinutes(coord, ts) {
    const list = (state.commandArrivals.get(coord) || []).concat((state.plannedArrivals.get(coord) || []).filter(x => x !== ts));
    if (!list.length) return null;
    return Math.min.apply(null, list.map(x => Math.abs(x-ts)/60000));
  }

  async function sendNext() {
    const next = state.plan.find(x => x.status === "ready");
    if (!next) { setStatus("No ready attacks left.", "warn"); ui.sendNextButton.disabled = true; return; }
    await sendItem(next.id);
  }

  async function sendItem(id) {
    const item = state.plan.find(x => x.id === id);
    if (!item || item.status !== "ready" || state.sendLocked) return;
    state.sendLocked = true;
    const button = ui.results.querySelector('[data-send-id="'+id+'"]');
    if (button) { button.disabled = true; button.textContent = "Checking"; }
    try {
      const settings = getSettings();
      await loadCommandArrivals(false, settings);
      const candidateArrival = getServerNow().getTime() + item.travelSeconds * 1000;
      const conflict = findArrivalConflict(item.targetCoord, candidateArrival, settings.minArrivalGapMinutes, false);
      if (conflict) {
        item.status = "skipped"; state.skippedCount++;
        removePlannedArrival(item.targetCoord, item.plannedArrival);
        state.debug.send.push({ id:id, result:"skipped-gap", target:item.targetCoord, candidateArrival:candidateArrival, conflict:conflict });
        setStatus("Skipped " + item.targetCoord + ": arrival gap changed.", "warn");
      } else {
        if (button) button.textContent = "Sending";
        await postFarmAttack(item);
        item.status = "sent"; state.sentCount++;
        removePlannedArrival(item.targetCoord, item.plannedArrival);
        addArrival(state.commandArrivals, item.targetCoord, candidateArrival);
        state.debug.send.push({ id:id, result:"sent", origin:item.origin.coord, target:item.targetCoord, arrival:new Date(candidateArrival).toISOString() });
        setStatus("Sent " + item.templateLetter + " from " + item.origin.coord + " to " + item.targetCoord + ".", "ok");
        if (settings.sendDelayMs) await wait(settings.sendDelayMs);
      }
      const row = ui.results.querySelector('[data-plan-id="'+id+'"]'); if (row) row.remove();
      renderMetrics();
      ui.sendNextButton.disabled = !state.plan.some(x => x.status === "ready");
      if (BUILD.variant === "efficient") maybePrefetchEfficient();
    } catch (err) {
      if (button) { button.disabled = false; button.textContent = "Retry"; }
      state.debug.send.push({ id:id, result:"error", error:err && err.message ? err.message : String(err) });
      setStatus(err && err.message ? err.message : String(err), "err");
    } finally { state.sendLocked = false; }
  }

  function removePlannedArrival(coord, ts) {
    const list = state.plannedArrivals.get(coord); if (!list) return;
    const idx = list.indexOf(ts); if (idx >= 0) list.splice(idx,1);
    if (!list.length) state.plannedArrivals.delete(coord);
  }

  function postFarmAttack(item) {
    return new Promise((resolve,reject) => {
      if (typeof TribalWars === "undefined" || typeof TribalWars.post !== "function") return reject(new Error("TribalWars.post is unavailable."));
      const payload = { target:String(item.targetId), template_id:String(item.action.templateId), source:String(item.origin.id) };
      let done = false;
      const ok = r => { if (!done) { done=true; resolve(r); } };
      const fail = e => { if (!done) { done=true; reject(e instanceof Error ? e : new Error(e && e.error ? e.error : String(e || "Attack failed."))); } };
      try { TribalWars.post("am_farm", { ajaxaction:"farm_icon_clicked" }, payload, ok, fail); } catch(err) { fail(err); }
    });
  }

  function maybePrefetchEfficient() {
    if (BUILD.variant !== "efficient" || state.finishedOrigins || state.loadingMore) return;
    const settings = getSettings();
    const ready = state.plan.filter(x => x.status === "ready").length;
    if (ready <= settings.prefetchRemaining) window.setTimeout(() => fillEfficientQueue(false), 0);
  }

  function onKeyDown(event) {
    if (event.key !== "Enter") return;
    const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
    if (["input","select","textarea","button"].includes(tag) || !ui.box || !document.body.contains(ui.box)) return;
    event.preventDefault(); event.stopPropagation(); sendNext();
  }

  function copyDebug() {
    const text = JSON.stringify({ build:BUILD, settings:getSettings(), state:{ origins:state.origins, originCursor:state.originCursor, loadedOrigins:Array.from(state.loadedOrigins), deferredTargets:state.deferredTargets.length, ready:state.plan.filter(x=>x.status==="ready").length, sent:state.sentCount, skipped:state.skippedCount, templateIds:state.templateIds, templateUnits:state.templateUnits, worldUnitSpeed:state.worldUnitSpeed, unitSpeeds:state.unitSpeeds }, debug:state.debug }, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => setStatus("Debug copied.", "ok"));
    else window.prompt("Copy debug", text);
  }

  function ensureFarmPage() {
    if (getParam("screen", window.location.href) === "am_farm") return true;
    const url = buildGameUrl({ screen:"am_farm" });
    if (confirm(BUILD.name + " works from Loot/Farm Assistant. Open it now?")) { window.location.href = url; return false; }
    return true;
  }

  state.settings = loadInitialSettings();
  if (ensureFarmPage()) createDialog();
})();
