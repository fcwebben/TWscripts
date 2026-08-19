/*
 * Twactics Advanced Mass Scavenging
 * Version: 0.3.0
 *
 * Clean-room mass scavenging helper with per-village allocation and preview-first sending.
 *
 * Features:
 * - Runs on Rally point -> Scavenging -> Mass scavenging.
 * - Calculates a preview before sending; send buttons are locked until the player confirms review.
 * - Modes: optimize_rph, balanced, high_first.
 * - RPH mode maximizes estimated resources/hour under max duration per scavenging level.
 * - Separate Off/Def duration settings.
 * - Duration can be set as hours from now or as a specific finish time.
 * - Select mass-scavenging village group and save it.
 * - Unit selection, keep-home, and unit priority order via drag/drop and arrow buttons.
 * - Groups squad requests in batches of max 50.
 * - Supports localStorage and optional TribalWars.scriptData settings.
 *
 * TribalWars.scriptData optional format:
 * {
 *   "settings": {
 *     "mode": "optimize_rph",
 *     "timeMode": "hours",
 *     "maxHoursOff": 6,
 *     "maxHoursDef": 6,
 *     "finishOffDate": "2026-08-19",
 *     "finishOffTime": "18:00",
 *     "finishDefDate": "2026-08-19",
 *     "finishDefTime": "18:00",
 *     "groupId": "0",
 *     "enabledLevels": [true, true, true, true],
 *     "usePremium": false,
 *     "unitOrder": ["light", "axe", "marcher", "heavy", "spear", "sword", "archer"],
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
  const VERSION = "0.3.0";
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

  const DEFAULT_UNIT_ORDER = ["light", "axe", "marcher", "heavy", "spear", "sword", "archer"];
  const OFF_UNITS = { axe: true, light: true, marcher: true };
  const DEF_UNITS = { spear: true, sword: true, archer: true, heavy: true };

  const DEFAULT_SETTINGS = {
    mode: "optimize_rph",
    timeMode: "hours",
    maxHoursOff: 6,
    maxHoursDef: 6,
    finishOffDate: "",
    finishOffTime: "",
    finishDefDate: "",
    finishDefTime: "",
    groupId: "0",
    groupName: "All villages",
    enabledLevels: [true, true, true, true],
    usePremium: false,
    unitOrder: DEFAULT_UNIT_ORDER.slice(),
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
    skippedPreview: [],
    summary: null,
    groupsMenu: [],
    debug: { fetch: [], calculation: [], parsing: [] },
    sendUnlocked: false
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
    state.settings = normalizeSettings(loadSettings());
    applyDefaultFinishTimes(state.settings);
    injectCss();
    renderMain();
    loadGroupsIntoSelect();
    status("Ready. Calculate first to preview the plan before sending.", "info");
  }

  function isMassScavengePage() {
    return location.href.indexOf("screen=place") >= 0 && location.href.indexOf("mode=scavenge_mass") >= 0;
  }

  function massUrl(page, groupId) {
    let url = game_data && game_data.link_base_pure ? game_data.link_base_pure + "place&mode=scavenge_mass" : "/game.php?screen=place&mode=scavenge_mass";

    if (game_data && game_data.player && game_data.player.sitter > 0) {
      url = "/game.php?t=" + encodeURIComponent(game_data.player.id) + "&screen=place&mode=scavenge_mass";
    }

    const params = [];
    const selectedGroup = groupId !== undefined ? groupId : state.settings && state.settings.groupId;

    if (selectedGroup !== undefined && selectedGroup !== null && String(selectedGroup) !== "" && String(selectedGroup) !== "0") {
      params.push("group=" + encodeURIComponent(String(selectedGroup)));
    }

    if (page !== undefined) {
      params.push("page=" + encodeURIComponent(String(page)));
    }

    if (params.length) url += (url.indexOf("?") >= 0 ? "&" : "?") + params.join("&");
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

  function normalizeSettings(settings) {
    const s = merge(clone(DEFAULT_SETTINGS), settings || {});

    if (s.maxHours !== undefined && settings && settings.maxHoursOff === undefined && settings.maxHoursDef === undefined) {
      s.maxHoursOff = floatVal(s.maxHours, DEFAULT_SETTINGS.maxHoursOff);
      s.maxHoursDef = floatVal(s.maxHours, DEFAULT_SETTINGS.maxHoursDef);
    }

    s.groupId = String(s.groupId === undefined || s.groupId === null ? "0" : s.groupId);
    s.unitOrder = normalizeUnitOrder(s.unitOrder);

    gameUnits().forEach(unit => {
      if (s.selectedUnits[unit] === undefined) s.selectedUnits[unit] = true;
      if (s.keepHome[unit] === undefined) s.keepHome[unit] = 0;
    });

    return s;
  }

  function normalizeUnitOrder(order) {
    const available = gameUnits();
    const seen = {};
    const out = [];
    (Array.isArray(order) ? order : DEFAULT_UNIT_ORDER).forEach(unit => {
      if (available.indexOf(unit) >= 0 && !seen[unit]) {
        seen[unit] = true;
        out.push(unit);
      }
    });
    available.forEach(unit => {
      if (!seen[unit]) out.push(unit);
    });
    return out;
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
    remove(STYLE);
    const style = document.createElement("style");
    style.id = STYLE;
    style.textContent = "#" + ROOT + ",#" + PREVIEW + "{margin:10px 0 14px;padding:0;border:1px solid #b89454;background:#f4e4bc;color:#2d1b0f;font-size:12px;box-shadow:0 1px 2px rgba(0,0,0,.15);max-width:1120px}"
      + "#" + ROOT + " *,#" + PREVIEW + " *{box-sizing:border-box}"
      + "#" + ROOT + " .twams-head,#" + PREVIEW + " .twams-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;background:#c6a768;border-bottom:1px solid #9f7d3c;color:#3b220c}"
      + "#" + ROOT + " .twams-title,#" + PREVIEW + " .twams-title{font-size:15px;font-weight:bold;color:#4b2600}"
      + "#" + ROOT + " .twams-subtitle,#" + PREVIEW + " .twams-subtitle{font-size:11px;color:#5c4630;margin-top:2px}"
      + "#" + ROOT + " .twams-body,#" + PREVIEW + " .twams-body{padding:10px 12px;background:#f4e4bc}"
      + "#" + ROOT + " .twams-section,#" + PREVIEW + " .twams-section{background:#fff5da;border:1px solid #cfb47a;margin-bottom:10px;padding:10px}"
      + "#" + ROOT + " .twams-section-title,#" + PREVIEW + " .twams-section-title{font-weight:bold;color:#803000;margin-bottom:8px;display:flex;align-items:center;gap:6px}"
      + "#" + ROOT + " .twams-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}"
      + "#" + ROOT + " .twams-row-3{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:10px}"
      + "#" + ROOT + " .twams-field{display:block;margin:0 0 8px;color:#2d1b0f;font-size:12px}"
      + "#" + ROOT + " .twams-field span{display:block;font-size:11px;color:#694b27;margin-bottom:3px}"
      + "#" + ROOT + " input[type=text],#" + ROOT + " input[type=number],#" + ROOT + " input[type=date],#" + ROOT + " input[type=time],#" + ROOT + " select{width:100%;height:26px;border:1px solid #b89454;background:#fffaf0;color:#2d1b0f;padding:2px 5px}"
      + "#" + ROOT + " .twams-choice-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}"
      + "#" + ROOT + " .twams-choice-row.twams-two{grid-template-columns:repeat(2,minmax(0,1fr))}"
      + "#" + ROOT + " .twams-choice{display:block;position:relative;border:1px solid #cfb47a;background:#f9edcf;padding:8px 8px 8px 27px;min-height:54px;cursor:pointer}"
      + "#" + ROOT + " .twams-choice input{position:absolute;left:8px;top:10px}"
      + "#" + ROOT + " .twams-choice b{display:block;color:#4b2600;margin-bottom:2px}"
      + "#" + ROOT + " .twams-choice small{display:block;color:#6b5434;line-height:1.25}"
      + "#" + ROOT + " .twams-levels{display:flex;gap:6px;flex-wrap:wrap}"
      + "#" + ROOT + " .twams-level{display:inline-flex;align-items:center;gap:4px;border:1px solid #cfb47a;background:#f9edcf;padding:5px 8px}"
      + "#" + ROOT + " .twams-units{display:flex;flex-direction:column;gap:5px}"
      + "#" + ROOT + " .twams-unit{display:grid;grid-template-columns:34px 96px 78px 70px 1fr;gap:8px;align-items:center;border:1px solid #cfb47a;background:#fffaf0;padding:6px;cursor:grab}"
      + "#" + ROOT + " .twams-unit.dragging{opacity:.45}"
      + "#" + ROOT + " .twams-unit img{width:24px;height:24px;display:block;margin:auto}"
      + "#" + ROOT + " .twams-unit-name{font-weight:bold;color:#4b2600;text-transform:capitalize}"
      + "#" + ROOT + " .twams-unit-buttons{display:flex;gap:3px}"
      + "#" + ROOT + " .twams-unit-buttons input{height:24px;padding:0 7px}"
      + "#" + ROOT + " .twams-unit .twams-keep{max-width:64px}"
      + "#" + ROOT + " .twams-actions,#" + PREVIEW + " .twams-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}"
      + "#" + ROOT + " .twams-note,#" + PREVIEW + " .twams-note{font-size:11px;color:#5c4630;line-height:1.35;margin:5px 0}"
      + "#" + ROOT + " .twams-status{border-top:1px solid #cfb47a;background:#fffaf0;padding:8px 12px;color:#4b2600}"
      + "#" + ROOT + " .error{color:#7a0000}#" + ROOT + " .success{color:#235c12}#" + ROOT + " .warn{color:#7a4d00}"
      + "#" + PREVIEW + " .twams-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin-bottom:10px}"
      + "#" + PREVIEW + " .twams-summary div{border:1px solid #cfb47a;background:#fffaf0;padding:8px;text-align:center;min-height:48px}"
      + "#" + PREVIEW + " .twams-summary b{color:#803000}"
      + "#" + PREVIEW + " table{width:100%;border-collapse:collapse;background:#fffaf0}#" + PREVIEW + " th,#" + PREVIEW + " td{border:1px solid #cfb47a;padding:5px;text-align:center;vertical-align:top}"
      + "#" + PREVIEW + " th{background:#c6a768;color:#4b2600}#" + PREVIEW + " .left{text-align:left}"
      + "#" + PREVIEW + " .twams-empty{border:1px solid #c28b00;background:#fff8df;padding:10px;margin-bottom:10px;color:#5c3b00}"
      + "#" + PREVIEW + " .twams-locked{opacity:.55}"
      + "#" + PREVIEW + " .twams-review{border:1px solid #cfb47a;background:#fffaf0;padding:8px;margin-top:10px}"
      + "@media(max-width:900px){#" + ROOT + " .twams-row,#" + ROOT + " .twams-row-3,#" + PREVIEW + " .twams-summary{grid-template-columns:1fr 1fr}#" + ROOT + " .twams-choice-row{grid-template-columns:1fr}#" + ROOT + " .twams-unit{grid-template-columns:30px 1fr 72px 62px}}";
    document.head.appendChild(style);
  }

  function renderMain() {
    remove(ROOT);
    const root = document.createElement("div");
    root.id = ROOT;
    root.innerHTML = '<div class="twams-head"><div><div class="twams-title">' + NAME + ' <span style="font-size:11px">v' + VERSION + '</span></div><div class="twams-subtitle">Preview-first mass scavenging with per-village RPH optimization.</div></div><input type="button" class="btn" id="twams-close" value="Close"></div>'
      + '<div class="twams-body">'
      + '<div class="twams-section"><div class="twams-section-title">1. Run setup</div><div class="twams-row-3">'
      + '<div><label class="twams-field"><span>Village group</span><select id="twams-group"><option value="0">All villages</option></select></label><div class="twams-note">Saved after Calculate. Uses the mass-scavenging group filter.</div></div>'
      + '<div><div class="twams-note" style="margin-top:0">Optimization mode</div><div class="twams-choice-row">'
      + choiceRadio("mode", "optimize_rph", "Optimize RPH", "Best resources/hour under the selected max duration.")
      + choiceRadio("mode", "balanced", "Balanced", "Attempts similar finish time across selected levels.")
      + choiceRadio("mode", "high_first", "High first", "Fills higher levels before lower levels.")
      + '</div></div>'
      + '<div><div class="twams-note" style="margin-top:0">Time mode</div><div class="twams-choice-row twams-two">'
      + choiceRadio("time-mode", "hours", "Duration", "Use max hours from now.")
      + choiceRadio("time-mode", "finish_at", "Finish at", "Use a saved finish date/time.")
      + '</div></div></div></div>'
      + '<div class="twams-section"><div class="twams-section-title">2. Time targets</div><div class="twams-row">'
      + '<div><b>Off villages</b><label class="twams-field"><span>Max duration hours</span><input id="twams-max-hours-off" type="number" min="0.25" step="0.25"></label></div>'
      + '<div><b>Def villages</b><label class="twams-field"><span>Max duration hours</span><input id="twams-max-hours-def" type="number" min="0.25" step="0.25"></label></div>'
      + '<div><b>Off finish time</b><label class="twams-field"><span>Date</span><input id="twams-finish-off-date" type="date"></label><label class="twams-field"><span>Time</span><input id="twams-finish-off-time" type="time"></label></div>'
      + '<div><b>Def finish time</b><label class="twams-field"><span>Date</span><input id="twams-finish-def-date" type="date"></label><label class="twams-field"><span>Time</span><input id="twams-finish-def-time" type="time"></label></div>'
      + '</div><div class="twams-note">In Finish-at mode the script calculates remaining hours from server time. The chosen finish time is saved for next run.</div></div>'
      + '<div class="twams-section"><div class="twams-section-title">3. Levels and options</div><div class="twams-row">'
      + '<div><b>Scavenging levels</b><div class="twams-levels">' + levelCheck(1) + levelCheck(2) + levelCheck(3) + levelCheck(4) + '</div></div>'
      + '<div><b>Premium</b>' + check("premium", "Use premium scavenging") + '<div class="twams-note">Send still requires confirmation when premium is enabled.</div></div>'
      + '<div><b>Advanced</b>' + check("debug", "Debug console") + '<label class="twams-field"><span>Request delay ms</span><input id="twams-delay" type="number" min="0" step="50"></label></div>'
      + '<div><b>Safety</b><div class="twams-note">Calculate only creates a preview. Send buttons are locked until you explicitly confirm review.</div></div>'
      + '</div></div>'
      + '<div class="twams-section"><div class="twams-section-title">4. Units, keep-home and priority order</div><div class="twams-note">Drag rows or use arrows. Top unit is consumed first when building squads.</div><div id="twams-units" class="twams-units"></div></div>'
      + '<div class="twams-actions"><input type="button" class="btn" id="twams-calc" value="Calculate preview"><input type="button" class="btn" id="twams-copy" value="Copy debug"></div>'
      + '</div><div id="twams-status" class="twams-status">Ready.</div>';

    mount().prepend(root);
    fillForm();
    document.getElementById("twams-calc").addEventListener("click", calculate);
    document.getElementById("twams-copy").addEventListener("click", window.TwacticsAdvancedMassScavenging.copyDebug);
    document.getElementById("twams-close").addEventListener("click", () => { remove(ROOT); remove(PREVIEW); });
  }

  function choiceRadio(name, value, title, description) {
    return '<label class="twams-choice"><input type="radio" name="twams-' + name + '" value="' + esc(value) + '"><b>' + esc(title) + '</b><small>' + esc(description) + '</small></label>';
  }

  function levelCheck(level) { return '<label class="twams-level"><input type="checkbox" id="twams-level-' + level + '"> Level ' + level + '</label>'; }

  function radio(name, value, label) { return '<label><input type="radio" name="twams-' + name + '" value="' + esc(value) + '"> ' + esc(label) + '</label>'; }
  function check(id, label) { return '<label><input type="checkbox" id="twams-' + id + '"> ' + esc(label) + '</label>'; }
  function mount() { return document.querySelector(".maincell") || document.getElementById("content_value") || document.body; }
  function remove(id) { const el = document.getElementById(id); if (el) el.remove(); }

  function fillForm() {
    const s = state.settings;
    const mode = document.querySelector('#' + ROOT + ' input[name="twams-mode"][value="' + s.mode + '"]');
    if (mode) mode.checked = true;
    const timeMode = document.querySelector('#' + ROOT + ' input[name="twams-time-mode"][value="' + s.timeMode + '"]');
    if (timeMode) timeMode.checked = true;

    val("twams-max-hours-off", s.maxHoursOff);
    val("twams-max-hours-def", s.maxHoursDef);
    val("twams-finish-off-date", s.finishOffDate);
    val("twams-finish-off-time", s.finishOffTime);
    val("twams-finish-def-date", s.finishDefDate);
    val("twams-finish-def-time", s.finishDefTime);
    val("twams-delay", s.requestDelayMs);
    checked("twams-premium", s.usePremium);
    checked("twams-debug", s.debugConsole);

    for (let i = 0; i < 4; i++) checked("twams-level-" + (i + 1), s.enabledLevels[i] !== false);
    renderUnits();
  }

  function loadGroupsIntoSelect() {
    const select = document.getElementById("twams-group");
    if (!select) return;

    $.get(TribalWars.buildURL("GET", "groups", { ajax: "load_group_menu" }))
      .done(groups => {
        const result = groups && groups.result ? groups.result : [];
        state.groupsMenu = result;
        select.innerHTML = '<option value="0">All villages</option>';

        result.forEach(item => {
          if (!item || item.type === "separator") return;
          const opt = document.createElement("option");
          opt.value = String(item.group_id);
          opt.textContent = item.name;
          select.appendChild(opt);
        });

        select.value = String(state.settings.groupId || "0");
        if (select.value !== String(state.settings.groupId || "0")) select.value = "0";
      })
      .fail(() => {
        const opt = document.createElement("option");
        opt.value = String(state.settings.groupId || "0");
        opt.textContent = state.settings.groupName || "Saved group";
        select.appendChild(opt);
        select.value = String(state.settings.groupId || "0");
      });
  }

  function renderUnits() {
    const box = document.getElementById("twams-units");
    if (!box) return;
    box.innerHTML = "";
    state.settings.unitOrder = normalizeUnitOrder(state.settings.unitOrder);

    state.settings.unitOrder.forEach(unit => {
      const wrap = document.createElement("div");
      wrap.className = "twams-unit";
      wrap.setAttribute("draggable", "true");
      wrap.dataset.unit = unit;
      wrap.innerHTML = '<img src="' + unitIcon(unit) + '" title="' + esc(unit) + '">'
        + '<div class="twams-unit-name">' + esc(unit) + '</div>'
        + '<div class="twams-unit-buttons"><input type="button" class="btn twams-up" value="↑"><input type="button" class="btn twams-down" value="↓"></div>'
        + '<label><input type="checkbox" class="twams-unit-enabled" data-unit="' + esc(unit) + '"> use</label>'
        + '<label>Keep <input type="number" min="0" class="twams-keep" data-unit="' + esc(unit) + '"></label>';
      box.appendChild(wrap);
      wrap.querySelector(".twams-unit-enabled").checked = state.settings.selectedUnits[unit] !== false;
      wrap.querySelector(".twams-keep").value = intVal(state.settings.keepHome[unit], 0);

      wrap.querySelector(".twams-up").addEventListener("click", () => moveUnit(unit, -1));
      wrap.querySelector(".twams-down").addEventListener("click", () => moveUnit(unit, 1));
      wrap.addEventListener("dragstart", onUnitDragStart);
      wrap.addEventListener("dragend", onUnitDragEnd);
      wrap.addEventListener("dragover", onUnitDragOver);
      wrap.addEventListener("drop", onUnitDrop);
    });
  }

  function preserveUnitInputs() {
    document.querySelectorAll(".twams-unit-enabled").forEach(el => { state.settings.selectedUnits[el.dataset.unit] = el.checked; });
    document.querySelectorAll(".twams-keep").forEach(el => { state.settings.keepHome[el.dataset.unit] = intVal(el.value, 0); });
  }

  function moveUnit(unit, delta) {
    preserveUnitInputs();
    const order = state.settings.unitOrder.slice();
    const idx = order.indexOf(unit);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= order.length) return;
    order.splice(idx, 1);
    order.splice(next, 0, unit);
    state.settings.unitOrder = order;
    renderUnits();
  }

  function onUnitDragStart(event) {
    preserveUnitInputs();
    event.currentTarget.classList.add("dragging");
    event.dataTransfer.setData("text/plain", event.currentTarget.dataset.unit);
  }

  function onUnitDragEnd(event) {
    event.currentTarget.classList.remove("dragging");
  }

  function onUnitDragOver(event) {
    event.preventDefault();
  }

  function onUnitDrop(event) {
    event.preventDefault();
    const from = event.dataTransfer.getData("text/plain");
    const to = event.currentTarget.dataset.unit;
    if (!from || !to || from === to) return;
    preserveUnitInputs();
    const order = state.settings.unitOrder.slice();
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, from);
    state.settings.unitOrder = order;
    renderUnits();
  }

  function unitIcon(unit) {
    const version = game_data && game_data.version ? String(game_data.version).split(" ")[0] : "";
    return version ? "https://dsen.innogamescdn.com/asset/" + encodeURIComponent(version) + "/graphic/unit/unit_" + unit + ".png" : "/graphic/unit/unit_" + unit + ".png";
  }

  function gameUnits() {
    const units = game_data && Array.isArray(game_data.units) ? game_data.units : DEFAULT_UNIT_ORDER;
    return DEFAULT_UNIT_ORDER.filter(u => units.indexOf(u) >= 0);
  }

  function collectSettings() {
    const s = clone(state.settings);
    const mode = document.querySelector('#' + ROOT + ' input[name="twams-mode"]:checked');
    const timeMode = document.querySelector('#' + ROOT + ' input[name="twams-time-mode"]:checked');
    const groupSelect = document.getElementById("twams-group");

    s.mode = mode ? mode.value : "optimize_rph";
    s.timeMode = timeMode ? timeMode.value : "hours";
    s.groupId = groupSelect ? String(groupSelect.value || "0") : "0";
    s.groupName = groupSelect && groupSelect.selectedOptions && groupSelect.selectedOptions[0] ? groupSelect.selectedOptions[0].textContent : "All villages";
    s.maxHoursOff = floatVal(get("twams-max-hours-off"), 6);
    s.maxHoursDef = floatVal(get("twams-max-hours-def"), 6);
    s.finishOffDate = get("twams-finish-off-date");
    s.finishOffTime = get("twams-finish-off-time");
    s.finishDefDate = get("twams-finish-def-date");
    s.finishDefTime = get("twams-finish-def-time");
    s.requestDelayMs = intVal(get("twams-delay"), 250);
    s.usePremium = isChecked("twams-premium");
    s.debugConsole = isChecked("twams-debug");
    s.enabledLevels = [1, 2, 3, 4].map(i => isChecked("twams-level-" + i));
    s.unitOrder = Array.from(document.querySelectorAll("#twams-units .twams-unit")).map(el => el.dataset.unit).filter(Boolean);
    s.selectedUnits = {};
    s.keepHome = {};
    document.querySelectorAll(".twams-unit-enabled").forEach(el => { s.selectedUnits[el.dataset.unit] = el.checked; });
    document.querySelectorAll(".twams-keep").forEach(el => { s.keepHome[el.dataset.unit] = intVal(el.value, 0); });
    s.unitOrder = normalizeUnitOrder(s.unitOrder);
    return s;
  }

  async function calculate() {
    try {
      state.settings = normalizeSettings(collectSettings());
      validate(state.settings);
      saveSettings(state.settings);
      state.requests = [];
      state.groups = [];
      state.preview = [];
      state.skippedPreview = [];
      state.villages = [];
      state.sendUnlocked = false;
      state.debug = { fetch: [], calculation: [], parsing: [] };
      remove(PREVIEW);
      status("Loading mass scavenging data...", "warn");
      const loaded = await loadData();
      state.constants = loaded.constants;
      state.villages = loaded.villages;
      status("Calculating preview...", "warn");
      const plan = buildPlan(loaded.villages, loaded.constants, state.settings);
      state.requests = plan.requests;
      state.preview = plan.preview;
      state.skippedPreview = plan.skippedPreview || [];
      state.summary = plan.summary;
      state.debug.calculation = plan.debug;
      state.groups = group(plan.requests, SQUAD_LIMIT);
      renderPreview();
      if (plan.requests.length) {
        status("Preview ready: " + fmt(plan.requests.length) + " requests. Review before sending.", "success");
      } else {
        status("No sendable requests found. Check the preview reasons before changing settings.", "warn");
      }
      if (state.settings.debugConsole) console.log(NAME, state);
    } catch (err) {
      console.error(err);
      status(err.message || String(err), "error");
    }
  }

  function validate(s) {
    if (!s.enabledLevels.some(Boolean)) throw new Error("Select at least one level.");
    if (!Object.keys(s.selectedUnits).some(u => s.selectedUnits[u])) throw new Error("Select at least one unit.");
    if (!(s.maxHoursOff > 0)) throw new Error("Off max hours must be above 0.");
    if (!(s.maxHoursDef > 0)) throw new Error("Def max hours must be above 0.");

    if (s.timeMode === "finish_at") {
      const off = finishHours("off", s);
      const def = finishHours("def", s);
      if (!(off > 0)) throw new Error("Off finish time must be in the future.");
      if (!(def > 0)) throw new Error("Def finish time must be in the future.");
    }
  }

  async function loadData() {
    const firstUrl = massUrl(undefined, state.settings.groupId);
    const first = await fetchText(firstUrl, 0);
    const pageCount = pageCountFromHtml(first);
    const constants = parseConstants(first);
    const villages = [];

    for (let p = 0; p <= pageCount; p++) {
      const url = massUrl(p, state.settings.groupId);
      status("Loading page " + (p + 1) + " / " + (pageCount + 1) + "...", "warn");
      const html = p === 0 ? first : await fetchText(url, state.settings.requestDelayMs);
      const pageVillages = parseVillages(html, p, url);
      state.debug.fetch.push({ page: p, url: url, villages: pageVillages.length });
      pageVillages.forEach(v => villages.push(v));
    }

    if (!villages.length) {
      throw new Error("No villages were parsed from the mass scavenging page. Use Copy debug and send the parsing section if this continues.");
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

  function scavengeScripts(html) {
    const scripts = [];
    $(html).find("script").each((i, s) => {
      // Use raw script HTML first. On some worlds, textContent can normalize the
      // ScavengeMassScreen payload in a way that makes the village data block
      // fail JSON.parse even though the raw innerHTML is parseable.
      const text = $(s).html() || s.innerHTML || s.textContent || "";
      if (text.indexOf("ScavengeMassScreen") >= 0 || text.indexOf("loot_factor") >= 0 || text.indexOf("unit_counts_home") >= 0) {
        scripts.push(text);
      }
    });
    return scripts;
  }

  function jsonBlocks(html) {
    const arr = [];
    scavengeScripts(html).forEach(text => {
      const matches = text.match(/\{.*\:\{.*\:.*\}\}/g);
      if (matches) matches.forEach(x => arr.push(x));
    });
    return arr;
  }

  function parseConstants(html) {
    const parsed = jsonBlocks(html).map(json).filter(Boolean);
    let src = null;
    parsed.forEach(o => { if (!src && o && hasScavengeConstants(o)) src = o; });
    if (!src) throw new Error("Could not read scavenging constants.");

    return [1, 2, 3, 4].map((level, idx) => {
      const o = src[level] || src[String(level)] || {};
      return {
        level: level,
        lootFactor: floatVal(o.loot_factor, FALLBACK_LOOT[idx]),
        durationExponent: floatVal(o.duration_exponent, fallbackConstant(src, "duration_exponent", 0.45)),
        durationInitialSeconds: floatVal(o.duration_initial_seconds, fallbackConstant(src, "duration_initial_seconds", 1800)),
        durationFactor: floatVal(o.duration_factor, fallbackConstant(src, "duration_factor", 1)),
        premiumFactor: extractPremiumFactor(o)
      };
    });
  }

  function hasScavengeConstants(o) {
    return !!(o && (o[1] || o["1"]) && (o[1] || o["1"]).duration_exponent !== undefined);
  }

  function fallbackConstant(src, key, fallback) {
    for (let i = 1; i <= 4; i++) {
      const o = src[i] || src[String(i)];
      if (o && o[key] !== undefined) return o[key];
    }
    return fallback;
  }

  function extractPremiumFactor(option) {
    if (!option) return PREMIUM_FACTOR;
    if (option.premium_loot_factor !== undefined) return floatVal(option.premium_loot_factor, PREMIUM_FACTOR);
    if (option.premium && option.premium.loot_factor !== undefined) return floatVal(option.premium.loot_factor, PREMIUM_FACTOR);
    if (option.bonus && option.bonus.loot_factor !== undefined) return floatVal(option.bonus.loot_factor, PREMIUM_FACTOR);
    return PREMIUM_FACTOR;
  }

  function parseVillages(html, page, url) {
    const blocks = jsonBlocks(html);
    const parsedEntries = blocks.map((block, idx) => ({ blockIndex: idx, value: json(block), raw: block }));
    const parsed = parsedEntries.filter(entry => entry.value !== null && entry.value !== undefined);
    const villages = [];
    const parseDebug = {
      page: page,
      url: url,
      scriptCount: scavengeScripts(html).length,
      blockCount: blocks.length,
      parsedBlockCount: parsed.length,
      failedBlockCount: blocks.length - parsed.length,
      failedBlocks: parsedEntries
        .filter(entry => entry.value === null || entry.value === undefined)
        .map(entry => ({
          blockIndex: entry.blockIndex,
          length: entry.raw ? entry.raw.length : 0,
          sampleStart: entry.raw ? entry.raw.slice(0, 160) : "",
          sampleEnd: entry.raw ? entry.raw.slice(-160) : ""
        })),
      candidateCounts: [],
      sampleKeys: []
    };

    parsed.forEach(entry => {
      const obj = entry.value;
      const found = [];
      collectVillagesDeep(obj, found, 0);
      parseDebug.candidateCounts.push({ blockIndex: entry.blockIndex, villages: found.length });
      if (obj && typeof obj === "object" && !Array.isArray(obj)) parseDebug.sampleKeys.push(Object.keys(obj).slice(0, 8));
      if (Array.isArray(obj) && obj.length) parseDebug.sampleKeys.push(["array", "length=" + obj.length]);
      found.forEach(v => villages.push(v));
    });

    state.debug.parsing.push(parseDebug);
    return dedupeVillages(villages);
  }

  function collectVillagesDeep(obj, out, depth) {
    if (!obj || depth > 8) return;
    if (isVillage(obj)) {
      out.push(obj);
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach(item => collectVillagesDeep(item, out, depth + 1));
      return;
    }
    if (typeof obj === "object") {
      Object.keys(obj).forEach(key => collectVillagesDeep(obj[key], out, depth + 1));
    }
  }

  function dedupeVillages(villages) {
    const seen = {};
    const out = [];
    villages.forEach(v => {
      const id = String(v.village_id || "");
      if (!id || seen[id]) return;
      seen[id] = true;
      out.push(v);
    });
    return out;
  }

  function isVillage(x) {
    return !!(x && typeof x === "object" && x.village_id !== undefined && x.options && x.unit_counts_home);
  }

  function decodeHtml(text) {
    if (!text || typeof document === "undefined") return text;
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  function json(text) {
    if (!text) return null;

    const variants = [];
    const trimmed = String(text).trim();
    variants.push(trimmed);

    const decoded = decodeHtml(trimmed);
    if (decoded !== trimmed) variants.push(decoded.trim());

    for (let i = 0; i < variants.length; i++) {
      try {
        return JSON.parse(variants[i]);
      } catch (e) {}
    }

    for (let i = 0; i < variants.length; i++) {
      try {
        const parsed = JSON.parse("[" + variants[i] + "]");
        return parsed && parsed[0] !== undefined ? parsed[0] : null;
      } catch (e) {}
    }

    // Last-resort parser for ScavengeMassScreen object literals. This data comes
    // from the current Tribal Wars page response, not an external source. It is
    // used only to read the existing game-state object when strict JSON parsing
    // fails on some worlds/locales.
    for (let i = 0; i < variants.length; i++) {
      try {
        return Function('"use strict"; return (' + variants[i] + ');')();
      } catch (e) {}
    }

    return null;
  }

  function buildPlan(villages, constants, settings) {
    const requests = [];
    const preview = [];
    const skippedPreview = [];
    const debug = [];
    let loot = 0;
    let rph = 0;
    let usedVillages = 0;
    let skippedUnits = 0;
    let skippedLevels = 0;
    let skippedRally = 0;
    let skippedDuration = 0;

    function pushSkipped(village, reason, details) {
      if (skippedPreview.length < 60) {
        skippedPreview.push({
          id: village && village.village_id,
          name: village && (village.village_name || village.name || ("Village " + village.village_id)),
          reason: reason,
          details: details || ""
        });
      }
      debug.push({ village_id: village && village.village_id, skipped: true, reason: reason, details: details || "" });
    }

    villages.forEach(village => {
      if (village.has_rally_point !== true) {
        skippedRally++;
        pushSkipped(village, "No rally point", "Village has no rally point.");
        return;
      }
      const lvls = availableLevels(village, settings);
      if (!lvls.length) {
        skippedLevels++;
        pushSkipped(village, "No free selected levels", levelStateSummary(village, settings));
        return;
      }
      const units = availableUnits(village, settings);
      const totalCarry = unitCarrySum(units, village);
      if (totalCarry <= 0) {
        skippedUnits++;
        pushSkipped(village, "No usable selected units", "Selected units at home after keep-home: " + unitText(units));
        return;
      }
      const type = villageType(units);
      const maxHours = maxHoursForType(type, settings);
      const allocation = allocate(totalCarry, lvls, constants, settings, maxHours);
      const split = splitUnitsByPriority(units, allocation, village, settings.unitOrder);
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
        preview.push({ id: village.village_id, name: village.village_name || village.name || "Village " + village.village_id, type: type, maxHours: maxHours, rows: rows });
      } else {
        skippedDuration++;
        pushSkipped(village, "Duration cap too strict", "Available levels: " + lvls.map(l => "L" + l).join(", ") + ". Max " + formatHours(maxHours) + " produced no valid squad with selected units.");
      }

      debug.push({ village_id: village.village_id, type: type, maxHours: maxHours, levels: lvls, totalCarry: totalCarry, allocation: allocation, rows: rows });
    });

    return {
      requests: requests,
      preview: preview,
      skippedPreview: skippedPreview,
      debug: debug,
      summary: {
        villagesScanned: villages.length,
        villagesUsed: usedVillages,
        requests: requests.length,
        groups: group(requests, SQUAD_LIMIT).length,
        estimatedLoot: Math.round(loot),
        estimatedRph: Math.round(rph),
        skippedNoRally: skippedRally,
        skippedNoUnits: skippedUnits,
        skippedNoLevels: skippedLevels,
        skippedDuration: skippedDuration,
        mode: settings.mode,
        timeMode: settings.timeMode,
        maxHoursOff: maxHoursForType("off", settings),
        maxHoursDef: maxHoursForType("def", settings),
        groupId: settings.groupId,
        groupName: settings.groupName
      }
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

  function levelStateSummary(v, s) {
    const parts = [];
    for (let level = 1; level <= 4; level++) {
      if (s.enabledLevels[level - 1] === false) {
        parts.push("L" + level + " disabled in settings");
        continue;
      }
      const opt = v.options && (v.options[level] || v.options[String(level)]);
      if (!opt) {
        parts.push("L" + level + " missing");
      } else if (opt.is_locked === true) {
        parts.push("L" + level + " locked");
      } else if (opt.scavenging_squad != null) {
        parts.push("L" + level + " active" + returnTimeText(opt.scavenging_squad));
      } else {
        parts.push("L" + level + " free");
      }
    }
    return parts.join("; ");
  }

  function returnTimeText(squad) {
    if (!squad || !squad.return_time) return "";
    try {
      return " until " + new Date(intVal(squad.return_time, 0) * 1000).toLocaleString();
    } catch (e) {
      return "";
    }
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

  function villageType(units) {
    let off = 0;
    let def = 0;
    Object.keys(units || {}).forEach(unit => {
      if (OFF_UNITS[unit]) off += intVal(units[unit], 0);
      if (DEF_UNITS[unit]) def += intVal(units[unit], 0);
    });
    return off > def ? "off" : "def";
  }

  function maxHoursForType(type, settings) {
    if (settings.timeMode === "finish_at") return finishHours(type, settings);
    return type === "off" ? floatVal(settings.maxHoursOff, 6) : floatVal(settings.maxHoursDef, 6);
  }

  function finishHours(type, settings) {
    const date = type === "off" ? settings.finishOffDate : settings.finishDefDate;
    const time = type === "off" ? settings.finishOffTime : settings.finishDefTime;
    const target = parseLocalDateTime(date, time);
    const now = serverNowMs();
    return (target - now) / 3600000;
  }

  function allocate(totalCarry, lvls, constants, settings, maxHours) {
    if (settings.mode === "balanced") return allocateBalanced(totalCarry, lvls, constants, maxHours);
    if (settings.mode === "high_first") return allocateHighFirst(totalCarry, lvls, constants, maxHours);
    return allocateRph(totalCarry, lvls, constants, maxHours, settings.usePremium);
  }

  function blank(lvls) { const o = {}; lvls.forEach(l => { o[l] = 0; }); return o; }

  function allocateRph(totalCarry, lvls, constants, maxHours, premium) {
    const a = blank(lvls);
    let remaining = Math.floor(totalCarry / CARRY_STEP) * CARRY_STEP;
    const maxSec = maxHours * 3600;
    let guard = 0;

    while (remaining > 0 && guard++ < 300000) {
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

    let low = 0;
    let high = maxSec;
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

  function splitUnitsByPriority(units, allocation, village, unitOrder) {
    const levels = Object.keys(allocation).filter(level => allocation[level] > 0).map(level => parseInt(level, 10)).sort((a, b) => b - a);
    const split = {};
    const remaining = clone(units || {});
    const order = normalizeUnitOrder(unitOrder);

    levels.forEach(level => { split[level] = {}; });

    levels.forEach(level => {
      let targetCarry = allocation[level] || 0;
      let currentCarry = 0;

      order.forEach(unit => {
        const carry = carryPerUnit(unit, village);
        if (!(carry > 0) || !(remaining[unit] > 0)) return;
        const need = Math.max(0, targetCarry - currentCarry);
        if (need <= 0) return;
        let take = Math.floor(need / carry);
        if (take <= 0 && currentCarry === 0) take = 1;
        take = Math.min(take, remaining[unit]);
        if (take <= 0) return;
        split[level][unit] = (split[level][unit] || 0) + take;
        remaining[unit] -= take;
        currentCarry += take * carry;
      });
    });

    Object.keys(split).forEach(level => {
      Object.keys(split[level]).forEach(unit => {
        if (!(split[level][unit] > 0)) delete split[level][unit];
      });
    });

    return split;
  }

  function carryPerUnit(unit, village) { return (UNIT_CARRY[unit] || 0) * floatVal(village.unit_carry_factor, 1); }
  function unitCarrySum(units, village) { return Object.keys(units || {}).reduce((sum, u) => sum + intVal(units[u], 0) * carryPerUnit(u, village), 0); }
  function group(requests, limit) { const out = []; for (let i = 0; i < requests.length; i += limit) out.push(requests.slice(i, i + limit)); return out; }

  function renderPreview() {
    remove(PREVIEW);
    const s = state.summary || {};
    const rows = state.preview.slice(0, 50);
    const skippedRows = (state.skippedPreview || []).slice(0, 40);
    const div = document.createElement("div");
    div.id = PREVIEW;
    div.innerHTML = '<div class="twams-head"><div><div class="twams-title">Scavenging plan preview</div><div class="twams-subtitle">Review the generated plan before unlocking send buttons.</div></div><input type="button" class="btn" id="twams-preview-close" value="Close preview"></div><div class="twams-body">'
      + '<div class="twams-summary">'
      + summaryBox("Group", s.groupName || "All")
      + summaryBox("Villages scanned", s.villagesScanned)
      + summaryBox("Villages used", s.villagesUsed)
      + summaryBox("Requests", s.requests)
      + summaryBox("Groups", s.groups)
      + summaryBox("Est. loot", s.estimatedLoot)
      + summaryBox("Est. RPH", s.estimatedRph)
      + summaryBox("Off max", formatHours(s.maxHoursOff))
      + summaryBox("Def max", formatHours(s.maxHoursDef))
      + summaryBox("No units", s.skippedNoUnits)
      + summaryBox("No free levels", s.skippedNoLevels)
      + summaryBox("No rally", s.skippedNoRally) + '</div>'
      + emptyPlanMessage(s)
      + '<div class="twams-section"><div class="twams-section-title">Planned villages</div><div class="twams-note">Showing first ' + rows.length + ' planned villages. Use Copy debug for the full object.</div>' + previewTable(rows) + '</div>'
      + '<div class="twams-section"><div class="twams-section-title">Skipped villages</div><div class="twams-note">Showing first ' + skippedRows.length + ' skipped villages with reason.</div>' + skippedTable(skippedRows) + '</div>'
      + '<div class="twams-review"><label><input type="checkbox" id="twams-review-confirm"> I have reviewed this preview and want to unlock send buttons.</label><div id="twams-groups" class="twams-actions twams-locked"></div></div></div>';
    mount().prepend(div);
    const close = document.getElementById("twams-preview-close");
    if (close) close.addEventListener("click", () => remove(PREVIEW));
    renderGroupButtons();
    const confirmBox = document.getElementById("twams-review-confirm");
    if (confirmBox) confirmBox.addEventListener("change", () => {
      state.sendUnlocked = confirmBox.checked;
      renderGroupButtons();
    });
  }

  function emptyPlanMessage(s) {
    if (s && s.requests > 0) return "";
    let reason = "No sendable scavenging requests were created.";
    if (s && s.skippedNoLevels && s.skippedNoLevels >= s.villagesScanned) {
      reason = "All scanned villages were skipped because no selected scavenging level was free. This usually means every selected level already has an active scavenging run.";
    } else if (s && s.skippedNoUnits && s.skippedNoUnits >= s.villagesScanned) {
      reason = "All scanned villages were skipped because no selected units were available after keep-home.";
    }
    return '<div class="twams-empty"><b>No groups to send.</b><br>' + esc(reason) + '</div>';
  }

  function summaryBox(label, value) { return '<div><b>' + esc(label) + '</b><br>' + esc(value === undefined || value === null ? 0 : value) + '</div>'; }

  function previewTable(rows) {
    if (!rows.length) return '<div class="twams-note">No planned villages.</div>';
    return '<table><thead><tr><th>Village ID</th><th>Village</th><th>Type</th><th>Max</th><th>Levels</th><th>Loot</th><th>RPH</th><th>Units</th></tr></thead><tbody>'
      + rows.map(v => {
        const details = v.rows.map(r => 'L' + r.level + ': ' + dur(r.duration) + ' / ' + fmt(Math.round(r.rph)) + ' RPH').join('<br>');
        const units = v.rows.map(r => 'L' + r.level + ': ' + unitText(r.units)).join('<br>');
        const loot = v.rows.reduce((sum, r) => sum + r.loot, 0);
        const rph = v.rows.reduce((sum, r) => sum + r.rph, 0);
        return '<tr><td>' + esc(v.id) + '</td><td class="left">' + esc(v.name) + '</td><td>' + esc(v.type) + '</td><td>' + esc(formatHours(v.maxHours)) + '</td><td class="left">' + details + '</td><td>' + fmt(loot) + '</td><td>' + fmt(rph) + '</td><td class="left">' + units + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function skippedTable(rows) {
    if (!rows.length) return '<div class="twams-note">No skipped villages recorded.</div>';
    return '<table><thead><tr><th>Village ID</th><th>Village</th><th>Reason</th><th>Details</th></tr></thead><tbody>'
      + rows.map(v => '<tr><td>' + esc(v.id || '') + '</td><td class="left">' + esc(v.name || '') + '</td><td>' + esc(v.reason || '') + '</td><td class="left">' + esc(v.details || '') + '</td></tr>').join('')
      + '</tbody></table>';
  }

  function renderGroupButtons() {
    const box = document.getElementById("twams-groups");
    if (!box) return;
    box.innerHTML = "";
    box.className = "twams-actions" + (state.sendUnlocked ? "" : " twams-locked");
    state.groups.forEach((g, i) => {
      const b = document.createElement("input");
      b.type = "button";
      b.className = "btn";
      b.disabled = !state.sendUnlocked;
      b.value = "Send group " + (i + 1) + " (" + g.length + ")";
      b.addEventListener("click", () => sendGroup(i));
      box.appendChild(b);
    });
    if (!state.groups.length) {
      box.innerHTML = '<div class="twams-note">No groups to send.</div>';
    }
  }

  function sendGroup(i) {
    const g = state.groups[i];
    if (!state.sendUnlocked) return;
    if (!g || !g.length) return;
    if (state.settings.usePremium && !confirm("Premium scavenging is enabled. This may use Premium Points. Continue?")) return;
    status("Sending group " + (i + 1) + "...", "warn");
    TribalWars.post("scavenge_api", { ajaxaction: "send_squads" }, { squad_requests: g }, function () {
      status("Group " + (i + 1) + " sent.", "success");
      const btn = document.querySelectorAll("#twams-groups input[type=button]")[i];
      if (btn) btn.disabled = true;
    }, function (err) {
      console.error(err);
      status("Failed to send group " + (i + 1) + ". See console.", "error");
    });
  }

  function applyDefaultFinishTimes(settings) {
    const now = new Date(serverNowMs() + 6 * 3600000);
    const date = formatDate(now);
    const time = formatTime(now);
    if (!settings.finishOffDate) settings.finishOffDate = date;
    if (!settings.finishOffTime) settings.finishOffTime = time;
    if (!settings.finishDefDate) settings.finishDefDate = date;
    if (!settings.finishDefTime) settings.finishDefTime = time;
  }

  function serverNowMs() {
    try {
      const date = String($("#serverDate").text() || "").trim();
      const time = String($("#serverTime").text() || "").trim();
      const parts = (date + " " + time).match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (parts) {
        return new Date(parseInt(parts[3], 10), parseInt(parts[2], 10) - 1, parseInt(parts[1], 10), parseInt(parts[4], 10), parseInt(parts[5], 10), parseInt(parts[6] || "0", 10)).getTime();
      }
    } catch (e) {}
    return Date.now();
  }

  function parseLocalDateTime(date, time) {
    if (!date || !time) return 0;
    const parts = String(date + " " + time).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!parts) return 0;
    return new Date(parseInt(parts[1], 10), parseInt(parts[2], 10) - 1, parseInt(parts[3], 10), parseInt(parts[4], 10), parseInt(parts[5], 10), 0).getTime();
  }

  function formatDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function formatTime(d) {
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function formatHours(h) { return (Math.round((Number(h) || 0) * 100) / 100) + "h"; }

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
