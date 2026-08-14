/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Resource Requester
 * Script created by Twactics (zidrox)
 *
 * Helps players request resources from origin villages to target villages using the Market request/call action.
 * The script reads village/resource data from Overview -> Production, incoming transports from Overview -> Transports,
 * and can use pasted coordinates or selected village groups as origin/target sources.
 *
 * This script:
 * - Reads visible/loaded village resource, merchant and warehouse data from Overview -> Production
 * - Reads incoming resource transports from Overview -> Transports -> Incoming
 * - Reads static village groups from Overview -> Groups
 * - Builds a manual request plan based on the player's exact resource inputs per target
 * - Can optionally cap planned requests with overflow protection using current resources and incoming transports
 * - Uses TribalWars.scriptData as supported user-data input when enabled in the Script Library
 * - Saves in-UI changes locally in the browser as a convenience fallback
 *
 * This script does NOT:
 * - Send attacks, support, or troops
 * - Auto-click game actions
 * - Automatically request resources without a manual user click
 * - Use external servers or external files
 *
 * Important Script Library user-data note:
 * If the "This script supports user data" option is enabled, players can store personal settings
 * as a JSON object for this script. Each time a player runs the script from the quickbar,
 * TribalWars.scriptData is available before the script executes.
 * Please document the expected format and available options in your script description.
 *
 * Expected TribalWars.scriptData format:
 * {
 *   "settings": {
 *     "reserveMerchants": 0,
 *     "reserveWarehousePercent": 5,
 *     "maxDistance": 50,
 *     "overflowProtection": false
 *   },
 *   "tabs": [
 *     {
 *       "name": "Default",
 *       "wood": 120000,
 *       "clay": 150000,
 *       "iron": 150000,
 *       "originCoords": "500|500 501|500",
 *       "originGroupId": "",
 *       "targetCoords": "510|510 511|510",
 *       "targetGroupId": ""
 *     }
 *   ]
 * }
 *
 * Options:
 * - settings.reserveMerchants: number of merchants to keep unused in every origin village
 * - settings.reserveWarehousePercent: percent of each origin village's warehouse to keep as local reserve
 * - settings.maxDistance: maximum allowed field distance between origin and target
 * - settings.overflowProtection: true/false. Default is false. When enabled, planned requests cannot push targets above 95% warehouse capacity.
 * - tabs[].originCoords / tabs[].targetCoords: pasted coordinates. Selecting a group fills these fields automatically.
 * - tabs[].originGroupId / tabs[].targetGroupId: selected group IDs, saved together with the visible coordinates.
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

  const SCRIPT_NAME = "Twactics Resource Requester";
  const SCRIPT_VERSION = "v1.0.5";
  const BOX_ID = "twactics-resource-requester";
  const STYLE_ID = "twactics-resource-requester-style";
  const STORAGE_KEY = "twacticsResourceRequesterData";
  const DATA_VERSION = 1;

  const DEFAULT_SETTINGS = {
    reserveMerchants: 0,
    reserveWarehousePercent: 5,
    maxDistance: 50,
    overflowProtection: false
  };

  const DEFAULT_TAB = {
    name: "Default",
    wood: 120000,
    clay: 150000,
    iron: 150000,
    originCoords: "",
    originGroupId: "",
    targetCoords: "",
    targetGroupId: ""
  };

  const state = {
    settings: normalizeSettings(getInitialData().settings),
    tabs: normalizeTabs(getInitialData().tabs),
    activeTabIndex: 0,
    groups: [],
    production: new Map(),
    incoming: new Map(),
    villageIdsByCoord: new Map(),
    lastPlan: []
  };

  const ui = {};
  let lastRequestEnterAt = 0;

  if (window.twacticsResourceRequester && typeof window.twacticsResourceRequester.close === "function") {
    window.twacticsResourceRequester.close();
  }

  window.twacticsResourceRequester = {
    state: state,
    close: closeWidget,
    reload: loadBaseDataAndRender,
    exportData: exportUserData,
    save: saveUiState
  };

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function parseNumber(value, fallback) {
    const cleaned = String(value === undefined || value === null ? "" : value)
      .replace(/\./g, "")
      .replace(/,/g, "")
      .replace(/[^\d-]/g, "");
    const parsed = parseInt(cleaned, 10);
    return isNaN(parsed) ? (fallback || 0) : parsed;
  }

  function parseFloatNumber(value, fallback) {
    const parsed = parseFloat(String(value === undefined || value === null ? "" : value).replace(",", "."));
    return isNaN(parsed) ? (fallback || 0) : parsed;
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = parseFloatNumber(value, fallback);
    return Math.max(min, Math.min(max, parsed));
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Math.round(Number(value || 0)));
  }

  function parseCoordList(value) {
    const matches = String(value || "").match(/\b\d{1,3}\|\d{1,3}\b/g) || [];
    const seen = new Set();
    const result = [];

    matches.forEach(coord => {
      if (!seen.has(coord)) {
        seen.add(coord);
        result.push(coord);
      }
    });

    return result;
  }

  function getParam(name, url) {
    try {
      return new URL(url || window.location.href, window.location.origin).searchParams.get(name);
    } catch (err) {
      return null;
    }
  }

  function getCurrentVillageId() {
    if (typeof game_data !== "undefined" && game_data.village && game_data.village.id) {
      return String(game_data.village.id);
    }
    return getParam("village") || "";
  }

  function buildGameUrl(params) {
    const url = new URL("/game.php", window.location.origin);
    const villageId = getCurrentVillageId();

    if (
      typeof game_data !== "undefined" &&
      game_data.player &&
      parseInt(game_data.player.sitter || 0, 10) > 0
    ) {
      url.searchParams.set("t", String(game_data.player.id));
    }

    if (villageId) {
      url.searchParams.set("village", villageId);
    }

    Object.keys(params || {}).forEach(key => {
      if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
        url.searchParams.set(key, String(params[key]));
      }
    });

    return url.pathname + url.search;
  }

  function getPureLink(params) {
    if (typeof game_data !== "undefined" && game_data.link_base_pure) {
      const base = game_data.link_base_pure;
      const query = Object.keys(params || {})
        .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])))
        .join("&");
      return base + query;
    }
    return buildGameUrl(params);
  }

  async function fetchHtml(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { "Accept": "text/html, */*; q=0.01" }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status + " while loading " + url);
    }

    return response.text();
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function getScriptDataObject() {
    if (typeof TribalWars === "undefined" || TribalWars.scriptData === undefined || TribalWars.scriptData === null) {
      return null;
    }

    if (typeof TribalWars.scriptData === "string") {
      try {
        return JSON.parse(TribalWars.scriptData);
      } catch (err) {
        console.warn(SCRIPT_NAME + " could not parse TribalWars.scriptData:", err);
        return null;
      }
    }

    if (typeof TribalWars.scriptData === "object") {
      return TribalWars.scriptData;
    }

    return null;
  }

  function getLocalSavedData() {
    try {
      const raw = localStorage.getItem(getStorageKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not parse local saved data:", err);
      return null;
    }
  }

  function getStorageKey() {
    const world = typeof game_data !== "undefined" && game_data.world ? game_data.world : "global";
    return world + ":" + STORAGE_KEY;
  }

  function getInitialData() {
    const defaults = {
      version: DATA_VERSION,
      settings: DEFAULT_SETTINGS,
      tabs: [DEFAULT_TAB]
    };

    const scriptData = getScriptDataObject();
    const localData = getLocalSavedData();

    // TribalWars.scriptData is the official imported configuration. Local storage is a convenience for UI saves.
    const merged = Object.assign({}, defaults, localData || {}, scriptData || {});


    return normalizeUserData(merged);
  }

  function normalizeSettings(input) {
    const source = Object.assign({}, DEFAULT_SETTINGS, input || {});

    return {
      reserveMerchants: Math.max(0, parseNumber(source.reserveMerchants, DEFAULT_SETTINGS.reserveMerchants)),
      reserveWarehousePercent: clampNumber(source.reserveWarehousePercent, 0, 100, DEFAULT_SETTINGS.reserveWarehousePercent),
      maxDistance: clampNumber(source.maxDistance, 0, 1000, DEFAULT_SETTINGS.maxDistance),
      overflowProtection: source.overflowProtection === true
    };
  }

  function getDetectedMerchantCapacity() {
    if (typeof game_data !== "undefined") {
      if (game_data.market && game_data.market.merchant_capacity) {
        return parseNumber(game_data.market.merchant_capacity, 1000);
      }
      if (game_data.world_config && game_data.world_config.merchant_capacity) {
        return parseNumber(game_data.world_config.merchant_capacity, 1000);
      }
    }
    return 1000;
  }

  function getMerchantCapacity() {
    return Math.max(1, getDetectedMerchantCapacity());
  }

  function normalizeTab(input, index) {
    const source = Object.assign({}, DEFAULT_TAB, input || {});

    return {
      name: cleanText(source.name) || ("Tab " + (index + 1)),
      wood: Math.max(0, parseNumber(source.wood, DEFAULT_TAB.wood)),
      clay: Math.max(0, parseNumber(source.clay, DEFAULT_TAB.clay)),
      iron: Math.max(0, parseNumber(source.iron, DEFAULT_TAB.iron)),
      originCoords: cleanText(source.originCoords),
      originGroupId: cleanText(source.originGroupId),
      targetCoords: cleanText(source.targetCoords),
      targetGroupId: cleanText(source.targetGroupId)
    };
  }

  function normalizeTabs(input) {
    const tabs = Array.isArray(input) && input.length ? input : [DEFAULT_TAB];
    return tabs.map(normalizeTab);
  }

  function normalizeUserData(input) {
    return {
      version: DATA_VERSION,
      settings: normalizeSettings(input && input.settings),
      tabs: normalizeTabs(input && input.tabs)
    };
  }

  function getCurrentUserData() {
    return normalizeUserData({
      settings: state.settings,
      tabs: state.tabs
    });
  }

  function persistUserData() {
    const data = getCurrentUserData();

    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(data));
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not save local data:", err);
    }

    if (typeof TribalWars !== "undefined") {
      TribalWars.scriptData = data;
    }

    return data;
  }

  function exportUserData() {
    return JSON.stringify(getCurrentUserData(), null, 2);
  }

  function calcDistance(coord1, coord2) {
    const a = String(coord1 || "").split("|").map(value => parseInt(value, 10));
    const b = String(coord2 || "").split("|").map(value => parseInt(value, 10));
    if (a.length !== 2 || b.length !== 2 || a.some(isNaN) || b.some(isNaN)) return Infinity;
    return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2));
  }

  function findPagedUrls(doc, firstUrl) {
    const urls = new Set();
    urls.add(firstUrl);

    Array.from(doc.querySelectorAll(".paged-nav-item a, .paged-nav-item, select[name='page'] option, .paged-nav select option")).forEach(item => {
      const href = item.getAttribute && (item.getAttribute("href") || item.value);
      if (href) {
        urls.add(new URL(href, window.location.origin).pathname + new URL(href, window.location.origin).search);
      }
    });

    return Array.from(urls);
  }

  async function fetchOverviewDocs(params) {
    const firstUrl = buildGameUrl(params);
    const firstHtml = await fetchHtml(firstUrl);
    const firstDoc = parseHtml(firstHtml);
    const urls = findPagedUrls(firstDoc, firstUrl);

    if (urls.length <= 1 || String(params.page) === "-1") {
      return [firstDoc];
    }

    const docs = [firstDoc];
    for (let i = 1; i < urls.length; i++) {
      const html = await fetchHtml(urls[i]);
      docs.push(parseHtml(html));
      await wait(120);
    }

    return docs;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function loadGroupList() {
    const url = buildGameUrl({ screen: "overview_villages", mode: "groups", type: "static", group: 0 });
    const html = await fetchHtml(url);
    const doc = parseHtml(html);
    const groups = [];
    const seen = new Set();

    Array.from(doc.querySelectorAll(".group-menu-item[data-group-id]")).forEach(item => {
      const id = cleanText(item.getAttribute("data-group-id"));
      const name = cleanText(item.textContent).replace(/[<>\[\]]/g, "");
      if (id && !seen.has(id)) {
        seen.add(id);
        groups.push({ id: id, name: name || ("Group " + id) });
      }
    });

    Array.from(doc.querySelectorAll("select option[value*='group=']")).forEach(option => {
      const id = getParam("group", option.value);
      const name = cleanText(option.textContent).replace(/[<>\[\]]/g, "");
      if (id && !seen.has(id)) {
        seen.add(id);
        groups.push({ id: id, name: name || ("Group " + id) });
      }
    });

    if (!seen.has("0")) {
      groups.unshift({ id: "0", name: "All villages" });
    }

    return groups;
  }

  function getVillageDataFromProductionRow(row) {
    const quickedit = row.querySelector(".quickedit-vn");
    const quickLabel = row.querySelector(".quickedit-label");
    const villageLink = row.querySelector('a[href*="village="]');
    const nameText = cleanText((quickLabel || quickedit || villageLink || row).textContent);
    const coordMatch = nameText.match(/\d{1,3}\|\d{1,3}/);
    const coord = coordMatch ? coordMatch[0] : "";
    const villageId = cleanText(
      quickedit && quickedit.getAttribute("data-id") ||
      getParam("village", villageLink && villageLink.getAttribute("href")) ||
      ""
    );

    if (!coord || !villageId) return null;

    const wood = parseResourceFromRow(row, "wood");
    const clay = parseResourceFromRow(row, "stone") || parseResourceFromRow(row, "clay");
    const iron = parseResourceFromRow(row, "iron");
    const merchants = parseMerchants(row);
    const warehouse = parseWarehouse(row);

    if (warehouse && (wood > warehouse * 2 || clay > warehouse * 2 || iron > warehouse * 2)) {
      console.warn(SCRIPT_NAME + " production parse looks suspicious", {
        coord: coord,
        wood: wood,
        clay: clay,
        iron: iron,
        warehouse: warehouse,
        rowText: cleanText(row.textContent).slice(0, 500)
      });
    }

    return {
      coord: coord,
      id: villageId,
      name: nameText,
      wood: wood,
      clay: clay,
      iron: iron,
      merchants: merchants.available,
      merchantsTotal: merchants.total,
      warehouse: warehouse
    };
  }

  function parseFirstNumber(value, fallback) {
    const match = String(value === undefined || value === null ? "" : value).match(/-?\d[\d.,]*/);
    if (!match) return fallback || 0;
    return parseNumber(match[0], fallback || 0);
  }

  function hasAnyClass(element, classNames) {
    if (!element || !element.classList) return false;
    return classNames.some(className => element.classList.contains(className));
  }

  const RESOURCE_MARKER_CLASSES = ["wood", "stone", "clay", "iron"];

  function getResourceMarkersInCell(cell) {
    if (!cell || !cell.querySelectorAll) return [];
    return Array.from(cell.querySelectorAll(".wood, .stone, .clay, .iron"))
      .filter(element => hasAnyClass(element, RESOURCE_MARKER_CLASSES));
  }

  function getTextBetweenElements(container, startElement, endElement) {
    try {
      const doc = container.ownerDocument || document;
      const range = doc.createRange();
      range.setStartAfter(startElement);

      if (endElement) {
        range.setEndBefore(endElement);
      } else {
        range.setEnd(container, container.childNodes.length);
      }

      return cleanText(range.toString());
    } catch (err) {
      return "";
    }
  }

  function parseResourceFromRow(row, resourceClass) {
    const markers = Array.from(row.querySelectorAll("." + resourceClass));

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const markerText = cleanText(marker.textContent);
      const markerDirectValue = parseFirstNumber(markerText, 0);

      if (markerDirectValue > 0 && markerText.replace(/[\d.,\s-]/g, "") === "") {
        return markerDirectValue;
      }

      const cell = marker.closest("td") || marker.parentElement;
      if (!cell) continue;

      if (cell !== marker) {
        const resourceMarkers = getResourceMarkersInCell(cell);
        const index = resourceMarkers.indexOf(marker);

        if (index >= 0) {
          const nextMarker = resourceMarkers[index + 1] || null;
          const segmentText = getTextBetweenElements(cell, marker, nextMarker);
          const segmentValue = parseFirstNumber(segmentText, 0);

          if (segmentValue > 0) {
            return segmentValue;
          }

          const cellNumbers = cleanText(cell.textContent).match(/-?\d[\d.,]*/g) || [];
          if (cellNumbers[index]) {
            return parseNumber(cellNumbers[index], 0);
          }
        }
      }

      const cellText = cleanText(cell.textContent);
      const cellNumbers = cellText.match(/-?\d[\d.,]*/g) || [];

      if (cellNumbers.length === 1 && !/\d{1,3}\|\d{1,3}/.test(cellText)) {
        return parseNumber(cellNumbers[0], 0);
      }
    }

    return 0;
  }

  function parseMerchants(row) {
    const marketLink = row.querySelector('a[href*="screen=market"], a[href*="market"]');
    const text = cleanText(marketLink ? marketLink.textContent : row.textContent);
    const match = text.match(/(\d[\d.,]*)\s*\/\s*(\d[\d.,]*)/);

    if (!match) {
      return { available: 0, total: 0 };
    }

    return {
      available: parseNumber(match[1], 0),
      total: parseNumber(match[2], 0)
    };
  }

  function parseWarehouse(row) {
    const cells = Array.from(row.children || []);
    const candidates = [];

    cells.forEach(cell => {
      const text = cleanText(cell.textContent);
      if (!text) return;
      if (/\d{1,3}\|\d{1,3}/.test(text)) return;
      if (cell.querySelector(".quickedit-vn, .quickedit-label")) return;
      if (cell.querySelector(".wood, .stone, .clay, .iron")) return;
      if (/\d+\s*\/\s*\d+/.test(text)) return;
      if ((cell.querySelector("a[href*='market']") || "") && /\d/.test(text)) return;

      const numbers = text.match(/\d[\d.,]*/g) || [];
      if (numbers.length !== 1) return;

      const value = parseNumber(numbers[0], 0);
      if (value >= 1000) candidates.push(value);
    });

    if (candidates.length) {
      return Math.max.apply(null, candidates);
    }

    return 0;
  }

  async function loadProductionData() {
    const docs = await fetchOverviewDocs({ screen: "overview_villages", mode: "prod", group: 0, page: -1 });
    const map = new Map();

    docs.forEach(doc => {
      Array.from(doc.querySelectorAll("#production_table tbody tr, #villages tr, table.overview_table tbody tr, .row_a, .row_b")).forEach(row => {
        const village = getVillageDataFromProductionRow(row);
        if (village && !map.has(village.coord)) {
          map.set(village.coord, village);
        }
      });
    });

    return map;
  }

  async function loadIncomingData() {
    const docs = await fetchOverviewDocs({ screen: "overview_villages", mode: "trader", type: "inc", page: -1 });
    const incoming = new Map();

    docs.forEach(doc => {
      Array.from(doc.querySelectorAll(".row_a, .row_b, table.vis tr, table.overview_table tr")).forEach(row => {
        const text = cleanText(row.textContent);
        const coordMatches = text.match(/\d{1,3}\|\d{1,3}/g);
        if (!coordMatches || !coordMatches.length) return;

        // Incoming overview usually has the target village as the last coordinate in the row.
        const coord = coordMatches[coordMatches.length - 1];
        const wood = parseResourceFromRow(row, "wood");
        const clay = parseResourceFromRow(row, "stone") || parseResourceFromRow(row, "clay");
        const iron = parseResourceFromRow(row, "iron");

        if (!wood && !clay && !iron) return;

        const current = incoming.get(coord) || { wood: 0, clay: 0, iron: 0 };
        current.wood += wood;
        current.clay += clay;
        current.iron += iron;
        incoming.set(coord, current);
      });
    });

    return incoming;
  }

  async function getCoordsFromGroup(groupId) {
    if (!groupId) return [];

    const url = buildGameUrl({ screen: "overview_villages", mode: "prod", group: groupId, page: -1 });
    const html = await fetchHtml(url);
    const doc = parseHtml(html);
    const coords = [];
    const seen = new Set();

    Array.from(doc.querySelectorAll(".quickedit-vn, .quickedit-label, #production_table tbody tr, #villages tr, table.overview_table tbody tr")).forEach(el => {
      const text = cleanText(el.textContent);
      const matches = text.match(/\d{1,3}\|\d{1,3}/g) || [];
      matches.forEach(coord => {
        if (!seen.has(coord)) {
          seen.add(coord);
          coords.push(coord);
        }
      });
    });

    return coords;
  }

  async function resolveTabCoords(tab) {
    return {
      origins: parseCoordList(tab.originCoords),
      targets: parseCoordList(tab.targetCoords)
    };
  }

  async function fillCoordsFromSelectedGroup(kind) {
    const tab = getActiveTab();
    if (!tab || !ui.activePanel) return;

    const isOrigin = kind === "origin";
    const select = ui.activePanel.querySelector(isOrigin ? ".twrr-origin-group" : ".twrr-target-group");
    const textarea = ui.activePanel.querySelector(isOrigin ? ".twrr-origin-coords" : ".twrr-target-coords");
    const groupId = cleanText(select && select.value);

    if (isOrigin) {
      tab.originGroupId = groupId;
    } else {
      tab.targetGroupId = groupId;
    }

    if (!groupId) {
      saveUiState({ persist: true });
      return;
    }

    try {
      setStatus("Loading " + (isOrigin ? "origin" : "target") + " group coordinates...", "warn");
      const coords = await getCoordsFromGroup(groupId);
      const coordText = coords.join(" ");
      if (textarea) textarea.value = coordText;

      if (isOrigin) {
        tab.originCoords = coordText;
      } else {
        tab.targetCoords = coordText;
      }

      saveUiState({ persist: true });
      setStatus("Loaded " + coords.length + " coordinate(s) from selected group.", "success");
    } catch (err) {
      console.error(SCRIPT_NAME + " could not load group coordinates:", err);
      setStatus(err.message || String(err), "error");
    }
  }

  function getIncomingForCoord(coord) {
    return state.incoming.get(coord) || { wood: 0, clay: 0, iron: 0 };
  }

  function getDesiredNeedForTarget(tab, targetCoord, plannedByTarget) {
    const base = {
      wood: Math.max(0, parseNumber(tab.wood, 0)),
      clay: Math.max(0, parseNumber(tab.clay, 0)),
      iron: Math.max(0, parseNumber(tab.iron, 0))
    };

    const target = state.production.get(targetCoord);
    const incoming = getIncomingForCoord(targetCoord);
    const alreadyPlanned = plannedByTarget.get(targetCoord) || { wood: 0, clay: 0, iron: 0 };
    const need = Object.assign({}, base);

    if (state.settings.overflowProtection && target && target.warehouse) {
      const limit = Math.floor(target.warehouse * 0.95);
      const maxAllowed = {
        wood: Math.max(0, limit - target.wood - incoming.wood - alreadyPlanned.wood),
        clay: Math.max(0, limit - target.clay - incoming.clay - alreadyPlanned.clay),
        iron: Math.max(0, limit - target.iron - incoming.iron - alreadyPlanned.iron)
      };

      need.wood = Math.min(need.wood, maxAllowed.wood);
      need.clay = Math.min(need.clay, maxAllowed.clay);
      need.iron = Math.min(need.iron, maxAllowed.iron);
    }

    return need;
  }
  function getOriginAvailability(originCoord, originState) {
    const origin = state.production.get(originCoord);
    if (!origin) return null;

    if (!originState.has(originCoord)) {
      const reserveAmount = Math.floor((origin.warehouse || 0) * (state.settings.reserveWarehousePercent / 100));
      const merchantsAvailable = Math.max(0, (origin.merchants || 0) - state.settings.reserveMerchants);

      originState.set(originCoord, {
        coord: origin.coord,
        id: origin.id,
        name: origin.name,
        wood: Math.max(0, origin.wood - reserveAmount),
        clay: Math.max(0, origin.clay - reserveAmount),
        iron: Math.max(0, origin.iron - reserveAmount),
        merchantCapacityLeft: merchantsAvailable * getMerchantCapacity()
      });
    }

    return originState.get(originCoord);
  }

  function scaleAmountsToCapacity(amounts, capacity) {
    const total = amounts.wood + amounts.clay + amounts.iron;
    if (total <= capacity) return amounts;
    if (capacity <= 0 || total <= 0) return { wood: 0, clay: 0, iron: 0 };

    const factor = capacity / total;
    return {
      wood: Math.floor(amounts.wood * factor),
      clay: Math.floor(amounts.clay * factor),
      iron: Math.floor(amounts.iron * factor)
    };
  }

  function subtractAmounts(target, amounts) {
    target.wood = Math.max(0, target.wood - amounts.wood);
    target.clay = Math.max(0, target.clay - amounts.clay);
    target.iron = Math.max(0, target.iron - amounts.iron);
  }

  function addAmounts(target, amounts) {
    target.wood += amounts.wood;
    target.clay += amounts.clay;
    target.iron += amounts.iron;
  }

  function totalAmounts(amounts) {
    return Math.max(0, Math.round((amounts && amounts.wood || 0) + (amounts && amounts.clay || 0) + (amounts && amounts.iron || 0)));
  }

  function buildRequestPlan(tab, coords) {
    const originCoords = coords.origins.filter(coord => state.production.has(coord));
    const targetCoords = coords.targets.filter(coord => state.production.has(coord));
    const targetMissingOwn = coords.targets.filter(coord => !state.production.has(coord));
    const plannedByTarget = new Map();
    const originState = new Map();
    const plan = [];

    targetCoords.forEach(targetCoord => {
      const target = state.production.get(targetCoord);
      const need = getDesiredNeedForTarget(tab, targetCoord, plannedByTarget);
      const originalNeed = Object.assign({}, need);
      const requests = [];

      const origins = originCoords
        .filter(originCoord => originCoord !== targetCoord)
        .map(originCoord => ({
          coord: originCoord,
          distance: calcDistance(originCoord, targetCoord)
        }))
        .filter(item => item.distance <= state.settings.maxDistance)
        .sort((a, b) => a.distance - b.distance);

      origins.forEach(originItem => {
        if (totalAmounts(need) <= 0) return;

        const origin = getOriginAvailability(originItem.coord, originState);
        if (!origin || origin.merchantCapacityLeft <= 0) return;

        let send = {
          wood: Math.min(need.wood, origin.wood),
          clay: Math.min(need.clay, origin.clay),
          iron: Math.min(need.iron, origin.iron)
        };

        send = scaleAmountsToCapacity(send, origin.merchantCapacityLeft);

        if (totalAmounts(send) <= 0) return;

        subtractAmounts(need, send);
        subtractAmounts(origin, send);
        origin.merchantCapacityLeft -= totalAmounts(send);

        requests.push({
          originCoord: origin.coord,
          originId: origin.id,
          originName: origin.name,
          distance: originItem.distance,
          wood: send.wood,
          clay: send.clay,
          iron: send.iron,
          total: totalAmounts(send)
        });
      });

      const planned = requests.reduce((sum, request) => {
        sum.wood += request.wood;
        sum.clay += request.clay;
        sum.iron += request.iron;
        return sum;
      }, { wood: 0, clay: 0, iron: 0 });

      plannedByTarget.set(targetCoord, planned);

      plan.push({
        targetCoord: targetCoord,
        targetId: target.id,
        targetName: target.name,
        requested: originalNeed,
        planned: planned,
        missing: need,
        requests: requests,
        requestCount: requests.length,
        maxDistance: requests.length ? Math.max.apply(null, requests.map(item => item.distance)) : 0,
        total: totalAmounts(planned)
      });
    });

    return {
      rows: plan.filter(row => row.total > 0 || totalAmounts(row.requested) > 0),
      errors: {
        originCoordsNotOwn: coords.origins.filter(coord => !state.production.has(coord)),
        targetCoordsNotOwn: targetMissingOwn
      }
    };
  }

  function buildPostDataForRow(row) {
    const data = {};

    row.requests.forEach(request => {
      data["resource[" + request.originId + "][wood]"] = request.wood;
      data["resource[" + request.originId + "][stone]"] = request.clay;
      data["resource[" + request.originId + "][iron]"] = request.iron;
    });

    return data;
  }

  function removeRequestedRow(button) {
    if (!button) return;
    const rowElement = button.closest("tr");
    if (rowElement) rowElement.remove();
    renumberResultRows();
  }

  function renumberResultRows() {
    if (!ui.results) return;
    Array.from(ui.results.querySelectorAll(".twrr-result-row")).forEach((row, index) => {
      const indexCell = row.querySelector(".twrr-row-index");
      if (indexCell) indexCell.textContent = String(index + 1);
    });
  }

  function postResourceRequest(row, button) {
    if (!row || !row.targetId || !row.requests.length) return;

    const data = buildPostDataForRow(row);

    console.log(SCRIPT_NAME + " request debug", {
      targetCoord: row.targetCoord,
      targetId: row.targetId,
      planned: row.planned,
      missing: row.missing,
      requests: row.requests,
      postData: data
    });

    if (button) {
      button.disabled = true;
      button.value = "requesting...";
      button.classList.add("twrr-requesting");
    }

    TribalWars.post("market", {
      village: row.targetId,
      ajaxaction: "call",
      h: window.csrf_token
    }, data, function (response) {
      const message = response && (response.success || response.message) || "Request sent.";
      if (typeof UI !== "undefined" && UI.SuccessMessage) UI.SuccessMessage(message, 1500);
      console.log(SCRIPT_NAME + " request success", { targetCoord: row.targetCoord, response: response });
      removeRequestedRow(button);
    }, function (error) {
      console.error(SCRIPT_NAME + " request failed:", error);
      if (typeof UI !== "undefined" && UI.ErrorMessage) UI.ErrorMessage("Request failed.", 2000);
      if (button) {
        button.disabled = false;
        button.value = "request";
        button.classList.remove("twrr-requesting");
        button.focus();
      }
    });
  }

  function getActiveTab() {
    if (!state.tabs[state.activeTabIndex]) state.activeTabIndex = 0;
    return state.tabs[state.activeTabIndex];
  }

  function saveUiState(options) {
    const shouldPersist = !options || options.persist !== false;
    readSettingsFromUi();
    readActiveTabFromUi();
    if (shouldPersist) {
      persistUserData();
    }
  }

  function readSettingsFromUi() {
    if (!ui.settingsPanel) return;

    state.settings = normalizeSettings({
      reserveMerchants: ui.reserveMerchantsInput && ui.reserveMerchantsInput.value,
      reserveWarehousePercent: ui.reserveWarehouseInput && ui.reserveWarehouseInput.value,
      maxDistance: ui.maxDistanceInput && ui.maxDistanceInput.value,
      overflowProtection: ui.overflowProtectionInput ? ui.overflowProtectionInput.checked === true : state.settings.overflowProtection
    });
  }

  function readActiveTabFromUi() {
    const tab = getActiveTab();
    if (!ui.activePanel || !tab) return;

    tab.wood = parseNumber(ui.activePanel.querySelector(".twrr-wood").value, tab.wood);
    tab.clay = parseNumber(ui.activePanel.querySelector(".twrr-clay").value, tab.clay);
    tab.iron = parseNumber(ui.activePanel.querySelector(".twrr-iron").value, tab.iron);
    tab.originCoords = cleanText(ui.activePanel.querySelector(".twrr-origin-coords").value);
    tab.originGroupId = cleanText(ui.activePanel.querySelector(".twrr-origin-group").value);
    tab.targetCoords = cleanText(ui.activePanel.querySelector(".twrr-target-coords").value);
    tab.targetGroupId = cleanText(ui.activePanel.querySelector(".twrr-target-group").value);
  }

  function syncSettingsToUi() {
    if (!ui.settingsPanel) return;
    ui.reserveMerchantsInput.value = state.settings.reserveMerchants;
    ui.reserveWarehouseInput.value = state.settings.reserveWarehousePercent;
    ui.maxDistanceInput.value = state.settings.maxDistance;
    ui.overflowProtectionInput.checked = state.settings.overflowProtection === true;
  }

  function getActiveTabDisplayName(index) {
    const tab = state.tabs[index];
    return tab && cleanText(tab.name) || ("Tab " + (index + 1));
  }

  function renameTab(index) {
    if (!state.tabs[index]) return;
    const current = getActiveTabDisplayName(index);
    const value = window.prompt("Rename tab", current);
    if (value === null) return;

    const nextName = cleanText(value);
    if (!nextName) return;

    state.tabs[index].name = nextName;
    persistUserData();
    renderTabs();
  }

  function removeTab(index) {
    if (state.tabs.length <= 1) {
      setStatus("At least one tab is required.", "error");
      return;
    }

    if (!window.confirm("Remove this tab?")) return;

    state.tabs.splice(index, 1);
    state.activeTabIndex = Math.max(0, Math.min(state.activeTabIndex, state.tabs.length - 1));
    persistUserData();
    renderTabs();
    renderActivePanel();
  }

  async function calculateAndSaveActiveTab() {
    saveUiState({ persist: true });
    renderTabs();
    setStatus("Tab saved to runtime user data and local browser fallback. Calculating requests...", "success");
    await calculateActiveTab({ persist: false });
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BOX_ID} {
        position: relative;
        display: block;
        width: 100%;
        box-sizing: border-box;
        margin: 10px 0 15px;
        border: 1px solid #603000;
        background: #f4e4bc;
        color: #2f1b00;
        font-family: Verdana, Arial, sans-serif;
        font-size: 12px;
      }
      #${BOX_ID} * { box-sizing: border-box; }
      .twrr-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px;
        background-color: #c1a264;
        background-image: url(/graphic/screen/tableheader_bg3.png);
        background-repeat: repeat-x;
      }
      .twrr-header h3 { margin: 0; padding: 0; font-size: 14px; line-height: 1; }
      .twrr-header-actions { display: flex; align-items: center; gap: 4px; }
      .twrr-icon-button {
        min-width: 23px;
        height: 23px;
        border: 1px solid #7d510f;
        background: #f4e4bc;
        color: #2f1b00;
        border-radius: 3px;
        cursor: pointer;
        font-weight: bold;
        line-height: 1;
      }
      .twrr-icon-button:hover { background: #fff4d5; }
      .twrr-body { padding: 10px; }
      .twrr-help { margin: 0 0 8px; line-height: 1.35; }
      .twrr-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
      .twrr-tab-wrap {
        display: inline-flex;
        align-items: center;
        border: 1px solid #7d510f;
        background: #fff4d5;
        border-radius: 3px;
        overflow: hidden;
      }
      .twrr-tab-wrap.twrr-active { background: #c1a264; font-weight: bold; }
      .twrr-tab-main,
      .twrr-tab-icon,
      .twrr-tab-add {
        border: 0;
        background: transparent;
        color: #2f1b00;
        cursor: pointer;
        min-height: 28px;
      }
      .twrr-tab-main { padding: 5px 8px; }
      .twrr-tab-icon { width: 25px; border-left: 1px solid #bd9c5a; }
      .twrr-tab-remove { color: #8f342b; }
      .twrr-tab-add {
        padding: 5px 10px;
        border: 1px solid #7d510f;
        background: #fff4d5;
        border-radius: 3px;
        font-weight: bold;
      }
      .twrr-tab-main:hover,
      .twrr-tab-icon:hover,
      .twrr-tab-add:hover { background: #f4e4bc; }
      .twrr-panel, .twrr-settings-panel {
        margin: 8px 0;
        padding: 8px;
        border: 1px solid #bd9c5a;
        background: #fff4d5;
        border-radius: 4px;
      }
      .twrr-settings-panel { display: none; }
      .twrr-settings-panel.twrr-open { display: block; }
      .twrr-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 8px;
        align-items: end;
      }
      .twrr-field label { display: block; font-weight: bold; margin-bottom: 4px; }
      .twrr-field input, .twrr-field textarea, .twrr-field select {
        width: 100%;
        min-height: 32px;
        padding: 6px 7px;
        border: 1px solid #7d510f;
        background: #fffaf0;
        color: #2f1b00;
      }
      .twrr-checkbox-label {
        display: flex !important;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        margin-bottom: 0 !important;
      }
      .twrr-checkbox-label input[type="checkbox"] {
        width: auto;
        min-height: auto;
        padding: 0;
        border: 0;
        background: transparent;
      }
      .twrr-field textarea { min-height: 88px; resize: vertical; font-family: monospace; }
      .twrr-resource-grid { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
      .twrr-coords-grid { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
      .twrr-under-textarea { margin-top: 6px; }
      .twrr-tooltip {
        display: inline-block;
        margin-left: 4px;
        width: 15px;
        height: 15px;
        line-height: 15px;
        text-align: center;
        border-radius: 50%;
        border: 1px solid #7d510f;
        background: #f4e4bc;
        cursor: help;
      }
      .twrr-save-disclaimer { margin-top: 4px; line-height: 1.35; }
      .twrr-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
      .twrr-button {
        padding: 5px 9px;
        border: 1px solid #7d510f;
        background: #c1a264;
        color: #fff;
        cursor: pointer;
        font-weight: bold;
        border-radius: 3px;
      }
      .twrr-button:hover { background: #9e7e3d; }
      .twrr-button:focus,
      .twrr-button:focus-visible {
        outline: 3px solid #ffe066;
        outline-offset: 2px;
        box-shadow: 0 0 0 2px #603000;
        background: #9e7e3d;
      }
      .twrr-row-request:focus,
      .twrr-row-request:focus-visible {
        outline: 3px solid #00b7ff;
        outline-offset: 2px;
        box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #003c5f;
      }
      .twrr-button-secondary { background: #7d510f; }
      .twrr-button-danger { background: #8f342b; }
      .twrr-status {
        padding: 6px;
        margin: 8px 0;
        border: 1px solid #bd9c5a;
        background: #fff4d5;
        border-radius: 4px;
      }
      .twrr-status-success { background: #dff0d8; }
      .twrr-status-warn { background: #fff4d5; }
      .twrr-status-error { background: #f2dede; }
      .twrr-summary {
        padding: 7px;
        margin: 8px 0;
        background: #fff4d5;
        border: 1px solid #bd9c5a;
        border-radius: 4px;
        line-height: 1.45;
      }
      .twrr-muted { opacity: 0.75; }
      .twrr-resource-line { white-space: nowrap; }
      .twrr-resource-icon { display: inline-block; vertical-align: -2px; margin-right: 2px; }
      .twrr-resource-separator { opacity: 0.55; margin: 0 3px; }
      .twrr-missing-line { display: inline-block; margin-top: 3px; color: #8f342b; font-size: 11px; }
      .twrr-table-wrap { max-height: 520px; overflow: auto; border: 1px solid #bd9c5a; }
      .twrr-table { width: 100%; border-collapse: collapse; }
      .twrr-table th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 5px;
        border: 1px solid #bd9c5a;
        background: #cfa95e;
        text-align: center;
      }
      .twrr-table td {
        padding: 5px;
        border: 1px solid #bd9c5a;
        background: #fff5da;
        text-align: center;
        vertical-align: middle;
      }
      .twrr-table tr:nth-child(even) td { background: #f0e2be; }
      .twrr-left { text-align: left !important; }
      .twrr-done { opacity: 0.6; }
      .twrr-export {
        display: none;
        width: 100%;
        min-height: 140px;
        margin-top: 8px;
        font-family: monospace;
      }
      .twrr-export.twrr-open { display: block; }
      .twrr-created-by {
        margin: 8px 0 0;
        padding-top: 6px;
        border-top: 1px solid #bd9c5a;
        font-size: 11px;
        opacity: 0.8;
        text-align: right;
      }
    `;

    document.head.appendChild(style);
  }

  function closeWidget() {
    const box = document.getElementById(BOX_ID);
    if (box) box.remove();

    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();

    document.removeEventListener("keydown", handleRequestEnter, true);

    delete window.twacticsResourceRequester;
  }

  function createGroupOptions(selectedId) {
    const options = ["<option value=''>Select group</option>"];
    state.groups.forEach(group => {
      options.push(
        "<option value='" + escapeHtml(group.id) + "'" + (String(group.id) === String(selectedId) ? " selected" : "") + ">" +
        escapeHtml(group.name) +
        "</option>"
      );
    });
    return options.join("");
  }

  function createSettingsPanel() {
    const panel = document.createElement("div");
    panel.className = "twrr-settings-panel";
    panel.innerHTML =
      "<div class='twrr-grid'>" +
        "<div class='twrr-field'><label>Reserve merchants</label><input class='twrr-reserve-merchants' type='number' min='0' step='1'></div>" +
        "<div class='twrr-field'><label>Reserve warehouse (%)</label><input class='twrr-reserve-warehouse' type='number' min='0' max='100' step='0.25'></div>" +
        "<div class='twrr-field'><label>Max distance</label><input class='twrr-max-distance' type='number' min='0' step='0.1'></div>" +
        "<div class='twrr-field'><label class='twrr-checkbox-label'><input class='twrr-overflow-protection' type='checkbox'> <span>Overflow protection</span> <span class='twrr-tooltip' title='When enabled, the plan will not request resources that would push a target village above 95% warehouse capacity after current resources, incoming transports and planned requests.'>?</span></label></div>" +
      "</div>" +
      "<div class='twrr-actions'>" +
        "<button type='button' class='twrr-button twrr-save-settings'>Save settings</button>" +
        "<button type='button' class='twrr-button twrr-button-secondary twrr-export-json'>Export user data JSON</button>" +
      "</div>" +
      "<div class='twrr-muted'>The script reads TribalWars.scriptData on startup. Save updates TribalWars.scriptData for the current run and stores a local browser fallback. For Script Library persistence, copy the exported JSON into the script user-data field.</div>" +
      "<textarea class='twrr-export' readonly></textarea>";

    ui.reserveMerchantsInput = panel.querySelector(".twrr-reserve-merchants");
    ui.reserveWarehouseInput = panel.querySelector(".twrr-reserve-warehouse");
    ui.maxDistanceInput = panel.querySelector(".twrr-max-distance");
    ui.overflowProtectionInput = panel.querySelector(".twrr-overflow-protection");
    ui.exportTextarea = panel.querySelector(".twrr-export");

    panel.querySelector(".twrr-save-settings").addEventListener("click", function () {
      saveUiState({ persist: true });
      setStatus("Settings saved. Recalculate the active tab when ready.", "success");
    });

    panel.querySelector(".twrr-export-json").addEventListener("click", function () {
      saveUiState({ persist: true });
      ui.exportTextarea.value = exportUserData();
      ui.exportTextarea.classList.toggle("twrr-open");
      ui.exportTextarea.focus();
      ui.exportTextarea.select();
    });

    ui.settingsPanel = panel;
    syncSettingsToUi();
    return panel;
  }

  function renderTabs() {
    ui.tabs.innerHTML = "";

    state.tabs.forEach((tab, index) => {
      const wrap = document.createElement("div");
      wrap.className = "twrr-tab-wrap" + (index === state.activeTabIndex ? " twrr-active" : "");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "twrr-tab-main";
      button.textContent = tab.name || ("Tab " + (index + 1));
      button.addEventListener("click", function () {
        saveUiState({ persist: true });
        state.activeTabIndex = index;
        renderTabs();
        renderActivePanel();
      });

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "twrr-tab-icon";
      renameButton.title = "Rename tab";
      renameButton.textContent = "✎";
      renameButton.addEventListener("click", function (event) {
        event.stopPropagation();
        renameTab(index);
      });

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "twrr-tab-icon twrr-tab-remove";
      removeButton.title = "Remove tab";
      removeButton.textContent = "🗑";
      removeButton.addEventListener("click", function (event) {
        event.stopPropagation();
        removeTab(index);
      });

      wrap.appendChild(button);
      wrap.appendChild(renameButton);
      wrap.appendChild(removeButton);
      ui.tabs.appendChild(wrap);
    });

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "twrr-tab-add";
    addButton.textContent = "+";
    addButton.title = "Add tab";
    addButton.addEventListener("click", function () {
      saveUiState({ persist: true });
      state.tabs.push(normalizeTab(Object.assign({}, DEFAULT_TAB, { name: "Tab " + (state.tabs.length + 1) }), state.tabs.length));
      state.activeTabIndex = state.tabs.length - 1;
      persistUserData();
      renderTabs();
      renderActivePanel();
    });
    ui.tabs.appendChild(addButton);
  }

  function renderActivePanel() {
    const tab = getActiveTab();
    ui.panelWrap.innerHTML = "";

    const panel = document.createElement("div");
    panel.className = "twrr-panel";
    panel.innerHTML =
      "<div class='twrr-grid twrr-resource-grid'>" +
        "<div class='twrr-field'><label><span class='icon header wood'></span> Wood</label><input class='twrr-wood' type='number' min='0' step='100' value='" + escapeHtml(tab.wood) + "'></div>" +
        "<div class='twrr-field'><label><span class='icon header stone'></span> Clay</label><input class='twrr-clay' type='number' min='0' step='100' value='" + escapeHtml(tab.clay) + "'></div>" +
        "<div class='twrr-field'><label><span class='icon header iron'></span> Iron</label><input class='twrr-iron' type='number' min='0' step='100' value='" + escapeHtml(tab.iron) + "'></div>" +
      "</div>" +
      "<div class='twrr-grid twrr-coords-grid'>" +
        "<div class='twrr-field'><label>Origin coords</label><textarea class='twrr-origin-coords'>" + escapeHtml(tab.originCoords) + "</textarea><select class='twrr-origin-group twrr-under-textarea'>" + createGroupOptions(tab.originGroupId) + "</select></div>" +
        "<div class='twrr-field'><label>Target coords</label><textarea class='twrr-target-coords'>" + escapeHtml(tab.targetCoords) + "</textarea><select class='twrr-target-group twrr-under-textarea'>" + createGroupOptions(tab.targetGroupId) + "</select></div>" +
      "</div>" +
      "<div class='twrr-actions'>" +
        "<button type='button' class='twrr-button twrr-save-calculate'>Calculate & Save tab</button>" +
        "<button type='button' class='twrr-button twrr-button-secondary twrr-calculate'>Calculate</button>" +
      "</div>" +
      "<div class='twrr-muted twrr-save-disclaimer'>Calculate & Save tab stores this tab's resources, coordinates and selected groups in the script data object for the current run and in the local browser fallback. To persist through the Script Library user-data feature, export/copy the JSON into the script user-data field.</div>";

    ui.panelWrap.appendChild(panel);
    ui.activePanel = panel;

    panel.querySelector(".twrr-save-calculate").addEventListener("click", calculateAndSaveActiveTab);
    panel.querySelector(".twrr-calculate").addEventListener("click", function () {
      calculateActiveTab({ persist: false });
    });

    panel.querySelector(".twrr-origin-group").addEventListener("change", function () {
      fillCoordsFromSelectedGroup("origin");
    });
    panel.querySelector(".twrr-target-group").addEventListener("change", function () {
      fillCoordsFromSelectedGroup("target");
    });

    panel.querySelectorAll("input, textarea").forEach(input => {
      input.addEventListener("change", function () {
        saveUiState({ persist: false });
      });
      input.addEventListener("input", function () {
        saveUiState({ persist: false });
      });
    });
  }

  function createWidget() {
    addStyles();

    const old = document.getElementById(BOX_ID);
    if (old) old.remove();

    const box = document.createElement("div");
    box.id = BOX_ID;

    const header = document.createElement("div");
    header.className = "twrr-header";
    header.innerHTML = "<h3>" + escapeHtml(SCRIPT_NAME + " " + SCRIPT_VERSION) + "</h3>";

    const actions = document.createElement("div");
    actions.className = "twrr-header-actions";

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "twrr-icon-button";
    settingsButton.title = "Settings";
    settingsButton.textContent = "⚙";
    settingsButton.addEventListener("click", function () {
      if (ui.settingsPanel) ui.settingsPanel.classList.toggle("twrr-open");
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "twrr-icon-button";
    closeButton.title = "Close";
    closeButton.textContent = "x";
    closeButton.addEventListener("click", closeWidget);

    actions.appendChild(settingsButton);
    actions.appendChild(closeButton);
    header.appendChild(actions);

    const body = document.createElement("div");
    body.className = "twrr-body";

    const help = document.createElement("p");
    help.className = "twrr-help";
    help.textContent = "Plan resource requests from origin villages to target villages. Use pasted coords or village groups, then request manually per target.";

    const settingsPanel = createSettingsPanel();

    const tabs = document.createElement("div");
    tabs.className = "twrr-tabs";

    const panelWrap = document.createElement("div");

    const status = document.createElement("div");
    status.className = "twrr-status";
    status.textContent = "Loading groups and village resource data...";

    const results = document.createElement("div");

    const createdBy = document.createElement("div");
    createdBy.className = "twrr-created-by";
    createdBy.textContent = "Script created by Twactics (zidrox)";

    body.appendChild(help);
    body.appendChild(settingsPanel);
    body.appendChild(tabs);
    body.appendChild(panelWrap);
    body.appendChild(status);
    body.appendChild(results);
    body.appendChild(createdBy);

    box.appendChild(header);
    box.appendChild(body);

    const target = document.querySelector("#contentContainer") || document.querySelector("#mobileContent") || document.querySelector("#content_value") || document.body;
    target.prepend(box);

    ui.tabs = tabs;
    ui.panelWrap = panelWrap;
    ui.status = status;
    ui.results = results;

    document.removeEventListener("keydown", handleRequestEnter, true);
    document.addEventListener("keydown", handleRequestEnter, true);

    renderTabs();
    renderActivePanel();
  }

  function setStatus(message, type) {
    if (!ui.status) return;
    ui.status.textContent = message || "";
    ui.status.className = "twrr-status";
    if (type) ui.status.classList.add("twrr-status-" + type);
  }

  async function loadBaseDataAndRender() {
    try {
      setStatus("Loading groups...", "warn");
      state.groups = await loadGroupList();
      renderActivePanel();

      setStatus("Loading village resource data...", "warn");
      state.production = await loadProductionData();
      state.villageIdsByCoord = new Map(Array.from(state.production.values()).map(village => [village.coord, village.id]));

      setStatus("Loading incoming transports...", "warn");
      state.incoming = await loadIncomingData();

      setStatus("Ready. Loaded " + state.production.size + " own villages and " + state.groups.length + " groups.", "success");
    } catch (err) {
      console.error(SCRIPT_NAME + " failed to load base data:", err);
      setStatus(err.message || String(err), "error");
    }
  }

  async function calculateActiveTab(options) {
    try {
      const shouldPersist = !options || options.persist !== false;
      saveUiState({ persist: shouldPersist });
      const tab = getActiveTab();
      setStatus("Resolving origin and target coordinates...", "warn");
      const coords = await resolveTabCoords(tab);

      if (!coords.origins.length) {
        setStatus("No origin coordinates found.", "error");
        return;
      }

      if (!coords.targets.length) {
        setStatus("No target coordinates found.", "error");
        return;
      }

      setStatus("Calculating request plan...", "warn");
      const result = buildRequestPlan(tab, coords);
      state.lastPlan = result.rows;
      renderResults(tab, result, coords);

      setStatus("Calculated " + result.rows.length + " target row(s).", "success");
    } catch (err) {
      console.error(SCRIPT_NAME + " calculation failed:", err);
      setStatus(err.message || String(err), "error");
    }
  }

  function resourceIconHtml(type, title) {
    return "<span class='icon header " + type + " twrr-resource-icon' title='" + escapeHtml(title) + "'></span>";
  }

  function formatAmountsHtml(amounts) {
    const values = amounts || {};
    return "<span class='twrr-resource-line'>" +
      resourceIconHtml("wood", "Wood") + " " + formatNumber(values.wood) +
      " <span class='twrr-resource-separator'>/</span> " +
      resourceIconHtml("stone", "Clay") + " " + formatNumber(values.clay) +
      " <span class='twrr-resource-separator'>/</span> " +
      resourceIconHtml("iron", "Iron") + " " + formatNumber(values.iron) +
    "</span>";
  }

  function formatSendResourcesHtml(row) {
    let html = "<strong>" + formatAmountsHtml(row.planned) + "</strong>" +
      "<br><span class='twrr-muted'>Total " + formatNumber(row.total) + "</span>";

    if (totalAmounts(row.missing) > 0) {
      html += "<br><span class='twrr-missing-line'>Missing: " + formatAmountsHtml(row.missing) + "</span>";
    }

    return html;
  }

  function getEnabledRequestButtons() {
    if (!ui.results) return [];
    return Array.from(ui.results.querySelectorAll(".twrr-row-request:not(:disabled)"));
  }

  function focusFirstRequestButton() {
    window.setTimeout(function () {
      const first = getEnabledRequestButtons()[0];
      if (first) first.focus();
    }, 50);
  }

  function getNextRequestButton(currentButton) {
    if (!ui.results) return null;
    const buttons = Array.from(ui.results.querySelectorAll(".twrr-row-request"));
    if (!buttons.length) return null;

    const index = buttons.indexOf(currentButton);

    for (let i = Math.max(index + 1, 0); i < buttons.length; i++) {
      if (!buttons[i].disabled) return buttons[i];
    }

    for (let i = 0; i < Math.max(index, 0); i++) {
      if (!buttons[i].disabled) return buttons[i];
    }

    return null;
  }

  function focusNextRequestButton(currentButton) {
    const next = getNextRequestButton(currentButton);

    window.setTimeout(function () {
      if (next && document.body.contains(next) && !next.disabled) {
        next.focus();
      } else {
        focusFirstRequestButton();
      }
    }, 50);
  }

  function handleRequestEnter(event) {
    if (!event || event.key !== "Enter") return;

    const target = event.target;
    if (!target || !target.classList || !target.classList.contains("twrr-row-request")) return;

    event.preventDefault();

    const now = Date.now();
    if (now - lastRequestEnterAt < 50) return;
    lastRequestEnterAt = now;

    if (!target.disabled) {
      target.click();
    }
  }

  function renderResults(tab, result, coords) {
    ui.results.innerHTML = "";

    const summary = document.createElement("div");
    summary.className = "twrr-summary";
    summary.innerHTML =
      "<strong>Origins:</strong> " + coords.origins.length + " · " +
      "<strong>Targets:</strong> " + coords.targets.length + " · " +
      "<strong>Max distance:</strong> " + state.settings.maxDistance + " · " +
      "<strong>Overflow protection:</strong> " + (state.settings.overflowProtection ? "on" : "off");
    ui.results.appendChild(summary);

    if (result.errors.originCoordsNotOwn.length || result.errors.targetCoordsNotOwn.length) {
      const warning = document.createElement("div");
      warning.className = "twrr-status twrr-status-warn";
      warning.innerHTML =
        "Skipped non-owned or unknown coords. " +
        "Origins: " + escapeHtml(result.errors.originCoordsNotOwn.join(" ") || "none") + ". " +
        "Targets: " + escapeHtml(result.errors.targetCoordsNotOwn.join(" ") || "none") + ".";
      ui.results.appendChild(warning);
    }

    if (!result.rows.length) {
      const empty = document.createElement("div");
      empty.className = "twrr-status twrr-status-warn";
      empty.textContent = "No requestable resources found with the current inputs and settings.";
      ui.results.appendChild(empty);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "twrr-table-wrap";

    const table = document.createElement("table");
    table.className = "twrr-table";
    table.innerHTML =
      "<thead><tr>" +
        "<th>#</th>" +
        "<th class='twrr-left'>Target</th>" +
        "<th>Send resources</th>" +
        "<th>Origins</th>" +
        "<th>Max distance</th>" +
        "<th>Request</th>" +
      "</tr></thead>";

    const tbody = document.createElement("tbody");

    result.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      tr.className = "twrr-result-row";
      const disabled = row.total <= 0 || !row.requests.length;
      tr.innerHTML =
        "<td class='twrr-row-index'>" + (index + 1) + "</td>" +
        "<td class='twrr-left'><a href='" + escapeHtml(buildGameUrl({ screen: "info_village", id: row.targetId })) + "' target='_blank' rel='noreferrer noopener'>" + escapeHtml(row.targetCoord) + "</a></td>" +
        "<td>" + formatSendResourcesHtml(row) + "</td>" +
        "<td>" + row.requestCount + "</td>" +
        "<td>" + (row.maxDistance ? row.maxDistance.toFixed(1) : "-") + "</td>" +
        "<td><input type='button' class='twrr-button twrr-row-request' value='request'" + (disabled ? " disabled" : "") + "></td>";

      const button = tr.querySelector(".twrr-row-request");
      button.addEventListener("click", function () {
        postResourceRequest(row, button);
        focusNextRequestButton(button);
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    ui.results.appendChild(wrap);
    focusFirstRequestButton();
  }

  createWidget();
  loadBaseDataAndRender();
  console.log(SCRIPT_NAME + " " + SCRIPT_VERSION + " loaded", { supportsScriptData: true });
})();
