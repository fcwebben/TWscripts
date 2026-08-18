/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Resource Balancer
 *
 * Helps players create a resource transfer plan based on village resources,
 * merchants, building queues, Account Manager construction templates and incoming transports.
 *
 * This script:
 * - Reads production overview data
 * - Reads building overview data
 * - Reads Account Manager construction template data when AM construction mode is selected
 * - Reads incoming transport data
 * - Counts incoming resources for target need and 90% target warehouse safety calculations
 * - Caps planned target requests so current + incoming + planned resources stay below 90% of target warehouse capacity
 * - Parses warehouse capacity after resource columns and rejects points-column values as capacity
 * - Treats Build coverage as target queue time coverage, not only number of queued buildings
 * - Caps warehouse safety per resource so one overflowing resource does not block other resources
 * - Creates optional conservative relay replenishment requests after direct target requests
 * - Parses incoming trader resources from both icon/class markup and plain resource cells
 * - Stops planning if incoming rows are visible but cannot be parsed, to avoid duplicate overfill requests
 * - Allows relay middlemen without an active queue only when they do not have an active AM construction template
 * - Prioritizes nearest affordable donors in AM construction mode so urgent targets receive resources faster
 * - Adds UI toggle and click help dialogs for Low-point priority and Relay replenishment
 * - Ignores individual origin resource amounts below 500 to avoid tiny request fragments
 * - Adds grouped plan diagnostics in the console for debugging and optimization
 * - Shows visible incoming and warehouse audit data in copied plans and the Audit section
 * - Uses current origin resources only when planning requestable origin availability
 * - Creates either an AM construction plan or a warehouse-percentage balance plan after a manual user click
 * - Allows one grouped manual request action per target row
 * - Tries to balance wood, clay and iron arrival timing within fixed 30-minute windows
 * - Supports TribalWars.scriptData settings input when enabled in the Script Library
 *
 * This script does NOT:
 * - Send attacks, support, or troops
 * - Auto-click game actions
 * - Auto-request all resources
 * - Use external servers or external files
 *
 * Expected TribalWars.scriptData format:
 * {
 *   "settings": {
 *     "useAmTemplates": true,
 *     "constructionHours": 8,
 *     "reserveMerchants": 0,
 *     "reserveWarehousePercent": 8,
 *     "maxDistance": 0,
 *     "prioritizeLowPoints": true,
 *     "enableRelayReplenishment": true,
 *     "relaySafetyBufferMinutes": 30,
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

  if (window.twacticsResourceBalancerLoaded) {
    console.log("Twactics Resource Balancer already loaded");
    return;
  }

  window.twacticsResourceBalancerLoaded = true;

  const SCRIPT_NAME = "Twactics Resource Balancer";
  const SCRIPT_VERSION = "1.0.0";
  const BOX_ID = "twactics-resource-balancer";
  const STYLE_ID = "twactics-resource-balancer-style";
  const DATA_VERSION = 1;
  const SETTINGS_STORAGE_KEY = "twacticsResourceBalancerSettings";

  const DEFAULTS = {
    useAmTemplates: true,
    constructionHours: 8,
    averageFactor: 0,
    reserveMerchants: 0,
    reserveWarehousePercent: 8,
    lowFarmBlockedReservePercent: 1,
    lowFarmFreePercent: 4,
    merchantCapacity: 1000,
    minShipment: 500,
    maxDistance: 0,
    emptyQueueBoost: 80,
    lowPointsBoost: 35,
    prioritizeLowPoints: true,
    sendDelayMs: 50,
    donorPreference: "smart_balanced",
    donorDistancePenalty: 2.25,
    noTemplateDonorBonus: 75,
    farmBlockedDonorBonus: 120,
    idleDonorBonus: 35,
    deadVillageDonorBonus: 150,
    scoreDistanceTieThreshold: 18,
    donorAuditLimit: 20,
    arrivalBalanceWindowMinutes: 30,
    baseMerchantMinutesPerField: 18,
    targetWarehouseLimitPercent: 90,
    minResourcePerOrigin: 500,
    dataRequestDelayMs: 350,
    templateRequestDelayMs: 650,
    fetchRetryDelayMs: 1200,
    fetchMaxRetries: 2,
    targetQueueCoverageBuildings: 4,
    queueSoonRefillBuildingCount: 1,
    enableRelayReplenishment: true,
    relaySafetyBufferMinutes: 30,
    debugConsole: false
  };

  const BUILDING_NAMES = {
    main: "Headquarters",
    barracks: "Barracks",
    stable: "Stable",
    garage: "Workshop",
    smith: "Smithy",
    place: "Rally point",
    market: "Market",
    wood: "Timber camp",
    stone: "Clay pit",
    iron: "Iron mine",
    farm: "Farm",
    storage: "Warehouse",
    hide: "Hiding place",
    wall: "Wall",
    snob: "Academy",
    statue: "Statue"
  };

  const state = {
    villages: [],
    villagesByCoord: new Map(),
    villagesById: new Map(),
    incomingByCoord: new Map(),
    amTemplatesByCoord: new Map(),
    amTemplateDefsByName: new Map(),
    buildingConstants: new Map(),
    plan: [],
    stats: null,
    lastSettings: null,
    sendLocked: false,
    debug: null,
    logs: [],
    savedSettings: normalizeSettings(getInitialUserData().settings)
  };

  const ui = {};

  window.twacticsResourceBalancer = {
    close: closeDialog,
    state: state,
    exportSettings: exportUserData,
    saveSettings: persistSettings
  };

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }


  function getWorldKeyForSettings(name) {
    const world = typeof game_data !== "undefined" && game_data.world ? game_data.world : "world";
    return world + ":" + name;
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

  function getLocalSavedUserData() {
    try {
      const raw = localStorage.getItem(getWorldKeyForSettings(SETTINGS_STORAGE_KEY));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not read local settings:", err);
      return null;
    }
  }

  function normalizeSettings(input) {
    const source = Object.assign({}, DEFAULTS, input || {});

    return {
      useAmTemplates: source.useAmTemplates !== false,
      constructionHours: Math.max(0, Math.min(72, parseFloatSafe(source.constructionHours, DEFAULTS.constructionHours))),
      reserveMerchants: Math.max(0, parseInt(source.reserveMerchants, 10) || DEFAULTS.reserveMerchants),
      reserveWarehousePercent: Math.max(0, Math.min(80, parseFloatSafe(source.reserveWarehousePercent, DEFAULTS.reserveWarehousePercent))),
      maxDistance: Math.max(0, parseFloatSafe(source.maxDistance, DEFAULTS.maxDistance)),
      prioritizeLowPoints: source.prioritizeLowPoints !== false,
      enableRelayReplenishment: source.enableRelayReplenishment !== false,
      relaySafetyBufferMinutes: Math.max(0, Math.min(360, parseFloatSafe(source.relaySafetyBufferMinutes, DEFAULTS.relaySafetyBufferMinutes))),
      debugConsole: source.debugConsole === true
    };
  }

  function getInitialUserData() {
    const defaults = {
      version: DATA_VERSION,
      settings: normalizeSettings(DEFAULTS)
    };

    const localData = getLocalSavedUserData();
    const scriptData = getScriptDataObject();

    return normalizeUserData(Object.assign({}, defaults, localData || {}, scriptData || {}));
  }

  function normalizeUserData(input) {
    return {
      version: DATA_VERSION,
      settings: normalizeSettings(input && input.settings ? input.settings : input)
    };
  }

  function getCurrentUserData() {
    return normalizeUserData({
      settings: getSettings()
    });
  }

  function persistSettings() {
    const data = getCurrentUserData();
    state.savedSettings = data.settings;

    try {
      localStorage.setItem(getWorldKeyForSettings(SETTINGS_STORAGE_KEY), JSON.stringify(data));
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not save local settings:", err);
    }

    if (typeof TribalWars !== "undefined") {
      const existing = getScriptDataObject() || {};
      TribalWars.scriptData = Object.assign({}, existing, data);
    }

    return data;
  }

  function exportUserData() {
    return JSON.stringify(getCurrentUserData(), null, 2);
  }

  function installSettingsAutoSave() {
    [
      ui.planMode,
      ui.constructionHours,
      ui.reserveMerchants,
      ui.reserveWarehousePercent,
      ui.maxDistance,
      ui.prioritizeLowPoints,
      ui.enableRelayReplenishment
    ].forEach(input => {
      if (!input || input.__twacticsSettingsAutoSave) return;
      input.__twacticsSettingsAutoSave = true;
      input.addEventListener("change", persistSettings);
      input.addEventListener("input", persistSettings);
    });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseNumber(value) {
    const normalized = String(value || "")
      .replace(/\./g, "")
      .replace(/,/g, "")
      .replace(/[^\d-]/g, "");

    const parsed = parseInt(normalized, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function parseFloatSafe(value, fallback) {
    const parsed = parseFloat(String(value || "").replace(",", "."));
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  function parseCoord(text) {
    const match = String(text || "").match(/(\d{1,3})\|(\d{1,3})/);

    if (!match) return null;

    return {
      x: parseInt(match[1], 10),
      y: parseInt(match[2], 10),
      coord: match[1] + "|" + match[2]
    };
  }

  function getParam(name, url) {
    try {
      return new URL(url || window.location.href, window.location.origin).searchParams.get(name);
    } catch (err) {
      return null;
    }
  }

  function getCurrentVillageId() {
    if (
      typeof game_data !== "undefined" &&
      game_data.village &&
      game_data.village.id
    ) {
      return String(game_data.village.id);
    }

    return getParam("village") || "";
  }

  function buildGameUrl(params) {
    const url = new URL("/game.php", window.location.origin);
    const villageId = getCurrentVillageId();
    const currentGroup = getParam("group");

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
      if (key.indexOf("__") === 0) return;
      if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
        url.searchParams.set(key, String(params[key]));
      }
    });

    if (
      currentGroup &&
      params &&
      !params.__skipGroup &&
      params.group === undefined &&
      (params.screen === "overview_villages" || params.screen === "am_village")
    ) {
      url.searchParams.set("group", currentGroup);
    }

    return url.pathname + url.search;
  }

  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms || 0)));
  }

  function getHttpStatusFromError(err) {
    const message = err && err.message ? err.message : String(err || "");
    const match = message.match(/HTTP\s+(\d+)/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  async function fetchText(url, options) {
    const opts = Object.assign({
      retries: DEFAULTS.fetchMaxRetries,
      retryDelayMs: DEFAULTS.fetchRetryDelayMs,
      label: ""
    }, options || {});

    let attempt = 0;
    let lastError = null;

    while (attempt <= opts.retries) {
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "same-origin",
          headers: {
            Accept: "text/html, */*; q=0.01"
          }
        });

        if (!response.ok) {
          const error = new Error("HTTP " + response.status + " while loading " + url);
          error.status = response.status;
          throw error;
        }

        return response.text();
      } catch (err) {
        lastError = err;
        const status = err && err.status ? err.status : getHttpStatusFromError(err);
        const retryable = status === 429 || status === 502 || status === 503 || status === 504;

        if (!retryable || attempt >= opts.retries) {
          throw err;
        }

        const delay = Math.round((opts.retryDelayMs || DEFAULTS.fetchRetryDelayMs) * Math.pow(1.7, attempt));
        console.warn(SCRIPT_NAME + " fetch retry " + (attempt + 1) + "/" + opts.retries, {
          label: opts.label || "",
          status: status,
          delayMs: delay,
          url: url
        });
        await wait(delay);
        attempt++;
      }
    }

    throw lastError || new Error("Could not load " + url);
  }

  async function throttleDataRequest(label, delayMs) {
    const delay = Math.max(0, delayMs === undefined ? DEFAULTS.dataRequestDelayMs : delayMs);
    if (!state.debug) state.debug = {};
    if (!state.debug.dataLoad) state.debug.dataLoad = [];

    state.debug.dataLoad.push({
      label: label || "data request",
      delayMs: delay,
      timestamp: new Date().toISOString()
    });

    if (delay > 0) {
      await wait(delay);
    }
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function getServerDateTime() {
    const timeText = cleanText(document.getElementById("serverTime")?.textContent || "");
    const dateText = cleanText(document.getElementById("serverDate")?.textContent || "");

    if (!timeText || !dateText) {
      return new Date();
    }

    const dateParts = dateText.split(/[./-]/).map(part => parseInt(part, 10));
    const timeParts = timeText.split(":").map(part => parseInt(part, 10));

    if (dateParts.length < 3 || timeParts.length < 2) {
      return new Date();
    }

    const day = dateParts[0];
    const month = dateParts[1] - 1;
    const year = dateParts[2];
    const hour = timeParts[0];
    const minute = timeParts[1];
    const second = timeParts[2] || 0;

    return new Date(year, month, day, hour, minute, second);
  }

  function parseQueueEndSeconds(title) {
    const text = cleanText(title || "");

    if (!text) return 0;

    const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);

    if (!timeMatch) return 0;

    const now = getServerDateTime();
    const finish = new Date(now.getTime());
    finish.setHours(
      parseInt(timeMatch[1], 10),
      parseInt(timeMatch[2], 10),
      parseInt(timeMatch[3] || "0", 10),
      0
    );

    const dateMatch = text.match(/(\d{1,2})[./-](\d{1,2})[./-]?(\d{2,4})?/);

    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const month = parseInt(dateMatch[2], 10) - 1;
      const year = dateMatch[3] ? parseInt(dateMatch[3], 10) : now.getFullYear();
      finish.setFullYear(year < 100 ? 2000 + year : year, month, day);
    } else if (/tomorrow/i.test(text)) {
      finish.setDate(finish.getDate() + 1);
    } else if (finish.getTime() < now.getTime() && !/today/i.test(text)) {
      finish.setDate(finish.getDate() + 1);
    }

    return Math.max(0, Math.round((finish.getTime() - now.getTime()) / 1000));
  }

  function getDistance(coordA, coordB) {
    const a = parseCoord(coordA);
    const b = parseCoord(coordB);

    if (!a || !b) return 9999;

    return Math.sqrt(
      Math.pow(a.x - b.x, 2) +
      Math.pow(a.y - b.y, 2)
    );
  }

  function getRowVillageInfo(row) {
    const nameElement =
      row.querySelector(".quickedit-vn") ||
      row.querySelector(".quickedit-label") ||
      row.querySelector(".nowrap") ||
      row.querySelector('a[href*="info_village"]') ||
      row.querySelector('a[href*="village="]');

    const rawName = cleanText(nameElement ? nameElement.textContent : row.textContent);
    const coordData = parseCoord(rawName);

    if (!coordData) return null;

    const link =
      row.querySelector('a[href*="info_village"]') ||
      row.querySelector('a[href*="screen=overview"][href*="village="]') ||
      row.querySelector('a[href*="village="]');

    const id =
      (nameElement && nameElement.getAttribute && nameElement.getAttribute("data-id")) ||
      (link ? getParam("id", link.getAttribute("href")) : "") ||
      (link ? getParam("village", link.getAttribute("href")) : "") ||
      coordData.coord;

    return {
      id: String(id),
      name: rawName,
      coord: coordData.coord,
      x: coordData.x,
      y: coordData.y
    };
  }

  function extractResourcesFromRow(row) {
    function fromClass(className) {
      const node = row.querySelector("." + className);
      return parseNumber(node ? node.textContent : "");
    }

    return {
      wood: fromClass("wood"),
      stone: fromClass("stone"),
      iron: fromClass("iron")
    };
  }

  function getTransportResourceKeyFromNode(node) {
    if (!node || node.nodeType !== 1) return "";

    const element = node;
    let classText = "";
    if (typeof element.className === "string") {
      classText = element.className;
    } else if (element.className && typeof element.className.baseVal === "string") {
      classText = element.className.baseVal;
    }

    const markerText = cleanText([
      classText,
      element.getAttribute && element.getAttribute("src"),
      element.getAttribute && element.getAttribute("alt"),
      element.getAttribute && element.getAttribute("title"),
      element.getAttribute && element.getAttribute("data-title")
    ].filter(Boolean).join(" ")).toLowerCase();

    if (/(^|[\s_-])(wood|res-wood|resource-wood)([\s_-]|$)|timber|lumber|holz|bois|madera|legno|drewno/.test(markerText)) return "wood";
    if (/(^|[\s_-])(stone|clay|res-stone|resource-stone|resource-clay)([\s_-]|$)|loam|lehm|argile|arcilla|argilla|glina/.test(markerText)) return "stone";
    if (/(^|[\s_-])(iron|res-iron|resource-iron)([\s_-]|$)|eisen|fer|hierro|ferro|zelazo|żelazo/.test(markerText)) return "iron";

    return "";
  }

  function hasTransportResourceMarker(node) {
    if (!node || node.nodeType !== 1) return false;
    if (getTransportResourceKeyFromNode(node)) return true;
    return Boolean(node.querySelector && Array.from(node.querySelectorAll("*"))
      .some(child => Boolean(getTransportResourceKeyFromNode(child))));
  }

  function dedupeResourceMarkerKeys(keys) {
    const result = [];
    (keys || []).forEach(key => {
      if (!key) return;
      if (result[result.length - 1] === key) return;
      result.push(key);
    });
    return result;
  }

  function getResourceMarkerKeysFromCell(cell) {
    const keys = [];

    function walk(node) {
      if (!node || node.nodeType !== 1) return;

      const key = getTransportResourceKeyFromNode(node);
      if (key) {
        keys.push(key);
      }

      Array.from(node.childNodes || []).forEach(walk);
    }

    walk(cell);
    return dedupeResourceMarkerKeys(keys);
  }

  function extractNumericTokens(text) {
    return (cleanText(text).match(/\d[\d.,]*/g) || [])
      .map(token => ({ token: token, value: parseNumber(token) }))
      .filter(item => item.value > 0);
  }

  function parseResourceCellByMarkers(cell) {
    const resources = emptyResources();
    const amounts = extractNumericTokens(cell ? cell.textContent : "").map(item => item.value);
    const markerKeys = getResourceMarkerKeysFromCell(cell);

    if (!amounts.length || !markerKeys.length) {
      return resources;
    }

    // Prefer mapping by visual marker order. The previous DOM-walk parser could split
    // thousands-formatted text like "12.153" into smaller fragments on some TW pages.
    // We now parse full visible numeric tokens from the whole resource cell and only use
    // icons/classes to decide which resource each full token belongs to.
    let keysForAmounts = [];

    if (markerKeys.length >= amounts.length) {
      keysForAmounts = markerKeys.slice(0, amounts.length);
    } else if (amounts.length === 3) {
      keysForAmounts = ["wood", "stone", "iron"];
    } else if (markerKeys.length === 1 && amounts.length === 1) {
      keysForAmounts = markerKeys.slice();
    }

    for (let i = 0; i < amounts.length; i++) {
      const key = keysForAmounts[i] || "";
      if (key && resources[key] !== undefined) {
        resources[key] += amounts[i];
      }
    }

    return resources;
  }

  function parsePlainResourceCell(cell) {
    const resources = emptyResources();
    const fallbackOrder = ["wood", "stone", "iron"];
    const tokens = extractNumericTokens(cell ? cell.textContent : "");

    tokens.slice(0, 3).forEach((item, index) => {
      const key = fallbackOrder[index];
      if (key) resources[key] += item.value;
    });

    return resources;
  }

  function getLikelyTransportResourceCell(row) {
    const cells = Array.from(row.children || []).filter(cell => !/^th$/i.test(cell.tagName || ""));
    if (!cells.length) return null;

    // Standard incoming trader table:
    // checkbox, icon, sender, origin, target/village, arrival, arrives in, merchants, resources.
    // The resources cell is normally the last cell. Prefer that cell so the "Arrives in"
    // timer is never interpreted as a resource amount.
    if (cells.length >= 8) {
      return cells[cells.length - 1];
    }

    const markedCells = cells.filter(cell => hasTransportResourceMarker(cell) && extractNumericTokens(cell.textContent || "").length > 0);
    if (markedCells.length) return markedCells[markedCells.length - 1];

    const numericCells = cells.filter(cell => extractNumericTokens(cell.textContent || "").length > 0);
    if (numericCells.length) return numericCells[numericCells.length - 1];

    return cells[cells.length - 1] || null;
  }

  function isIncomingHeaderOrControlRow(row) {
    if (!row) return true;
    if (row.querySelector && row.querySelector("th")) return true;

    const text = cleanText(row.textContent || "");
    if (!text) return true;
    if (/^select all$/i.test(text)) return true;
    if (/sender/i.test(text) && /origin/i.test(text) && /resources/i.test(text)) return true;
    if (/recipient/i.test(text) && /arrival/i.test(text) && /resources/i.test(text)) return true;

    return false;
  }

  function extractTransportResourcesFromRow(row) {
    const resourceCell = getLikelyTransportResourceCell(row);
    const cellText = cleanText(resourceCell ? resourceCell.textContent : "").slice(0, 160);

    if (!resourceCell) {
      return {
        resources: emptyResources(),
        method: "no-resource-cell",
        resourceCellText: ""
      };
    }

    const markerResources = parseResourceCellByMarkers(resourceCell);
    if (totalResources(markerResources) > 0) {
      return {
        resources: markerResources,
        method: "resource-cell-markers",
        resourceCellText: cellText
      };
    }

    const plainResources = parsePlainResourceCell(resourceCell);
    if (totalResources(plainResources) > 0) {
      return {
        resources: plainResources,
        method: "plain-resource-cell-fallback",
        resourceCellText: cellText
      };
    }

    const classResources = extractResourcesFromRow(row);
    if (totalResources(classResources) > 0) {
      return {
        resources: classResources,
        method: "class-resource-columns-fallback",
        resourceCellText: cellText
      };
    }

    return {
      resources: emptyResources(),
      method: "resource-cell-empty",
      resourceCellText: cellText
    };
  }

  function rowTextLooksLikeTransportWithResources(text) {
    const normalized = cleanText(text);
    // Typical trader rows end with merchants and one to three resource amounts, e.g. "35 7.777 27.223".
    return /\b\d+\s+\d[\d.]{2,}(?:\s+\d[\d.]{2,}){0,2}\b/.test(normalized);
  }

  function parseMerchants(row) {
    const marketLink = row.querySelector('a[href*="market"]');
    const text = cleanText(marketLink ? marketLink.textContent : row.textContent);
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);

    if (!match) {
      return {
        available: 0,
        total: 0
      };
    }

    return {
      available: parseInt(match[1], 10),
      total: parseInt(match[2], 10)
    };
  }

  function getSinglePositiveNumberFromCell(cell) {
    const numbers = extractNumericTokens(cell ? cell.textContent : "");
    return numbers.length === 1 ? numbers[0].value : 0;
  }

  function cellLooksLikeVillageNameOrCoord(cell) {
    const text = cleanText(cell ? cell.textContent : "");
    return /\d{1,3}\|\d{1,3}/.test(text);
  }

  function cellLooksLikeFarmUsage(cell) {
    const text = cleanText(cell ? cell.textContent : "");
    return /\d[\d.]*\s*\/\s*\d[\d.]*/.test(text);
  }

  function cellLooksLikeResourceCell(cell) {
    return Boolean(cell && cell.querySelector && cell.querySelector(".wood, .stone, .iron"));
  }

  function cellLooksLikeMerchantCell(cell) {
    return Boolean(cell && cell.querySelector && cell.querySelector('a[href*="market"], a[href*="screen=market"]'));
  }

  function isLikelyWarehouseCapacityCell(cell, value, resources) {
    if (!value || value < 1000 || value > 1000000) return false;
    if (cellLooksLikeVillageNameOrCoord(cell)) return false;
    if (cellLooksLikeFarmUsage(cell)) return false;
    if (cellLooksLikeResourceCell(cell)) return false;
    if (cellLooksLikeMerchantCell(cell)) return false;

    const maxCurrentResource = Math.max(
      resources && resources.wood || 0,
      resources && resources.stone || 0,
      resources && resources.iron || 0
    );

    // A village cannot currently hold more of a resource than its warehouse capacity.
    // If a parsed value is below the current stored resource amount, it is almost always
    // the points column or another metadata column, not warehouse capacity.
    if (maxCurrentResource > 0 && value < maxCurrentResource) return false;

    return true;
  }

  function parseCapacity(row, resources) {
    const cells = Array.from(row.children);
    const resourceIndexes = [];

    cells.forEach((cell, index) => {
      if (cellLooksLikeResourceCell(cell)) {
        resourceIndexes.push(index);
      }
    });

    const lastResourceIndex = resourceIndexes.length ? Math.max.apply(null, resourceIndexes) : -1;

    // First preference: the first sane single-number cell after the resource columns.
    // This avoids accidentally reading the village points column as warehouse capacity.
    if (lastResourceIndex >= 0) {
      for (let i = lastResourceIndex + 1; i < cells.length; i++) {
        const value = getSinglePositiveNumberFromCell(cells[i]);
        if (isLikelyWarehouseCapacityCell(cells[i], value, resources)) {
          return value;
        }
      }
    }

    // Fallback: search the entire row, but still reject values below current resources.
    for (let i = 0; i < cells.length; i++) {
      const value = getSinglePositiveNumberFromCell(cells[i]);
      if (isLikelyWarehouseCapacityCell(cells[i], value, resources)) {
        return value;
      }
    }

    return 0;
  }

  function parsePoints(row) {
    const cells = Array.from(row.children);

    for (let i = 0; i < Math.min(cells.length, 4); i++) {
      const value = parseNumber(cells[i].textContent);

      if (value > 0 && value < 20000) {
        return value;
      }
    }

    return 0;
  }

  function parseFarm(row) {
    const text = cleanText(row.textContent);
    const matches = Array.from(text.matchAll(/(\d[\d.]*)\s*\/\s*(\d[\d.]*)/g));

    if (!matches.length) {
      return {
        used: 0,
        max: 0,
        ratio: 0
      };
    }

    const likelyFarm = matches[matches.length - 1];
    const used = parseNumber(likelyFarm[1]);
    const max = parseNumber(likelyFarm[2]);

    return {
      used: used,
      max: max,
      ratio: max > 0 ? used / max : 0
    };
  }

  async function loadProductionData() {
    const url = buildGameUrl({
      screen: "overview_villages",
      mode: "prod",
      page: "-1"
    });

    const html = await fetchText(url);
    const doc = parseHtml(html);
    const rows = Array.from(doc.querySelectorAll("#production_table tbody tr, #content_value .row_a, #content_value .row_b"));
    const villages = [];
    const seen = new Set();

    rows.forEach(row => {
      if (row.querySelector("th")) return;

      const info = getRowVillageInfo(row);
      if (!info || seen.has(info.coord)) return;
      seen.add(info.coord);

      const resources = extractResourcesFromRow(row);
      const merchants = parseMerchants(row);
      const farm = parseFarm(row);

      villages.push(Object.assign({}, info, {
        wood: resources.wood,
        stone: resources.stone,
        iron: resources.iron,
        merchants: merchants.available,
        merchantsTotal: merchants.total,
        capacity: parseCapacity(row, resources),
        points: parsePoints(row),
        farmUsed: farm.used,
        farmMax: farm.max,
        farmRatio: farm.ratio,
        queueEndSeconds: 0,
        queueCount: 0,
        buildingLevels: {},
        queuedBuildings: [],
        amTemplateName: "",
        amTemplate: null,
        ownNeed: emptyResources(),
        ownNeedDetails: []
      }));
    });

    return villages;
  }

  function buildVillageLookupContext(villages) {
    const byId = new Map();
    const coords = new Set();

    (villages || []).forEach(village => {
      if (village && village.id !== undefined && village.id !== null) {
        byId.set(String(village.id), village.coord);
      }

      if (village && village.coord) {
        coords.add(village.coord);
      }
    });

    return {
      byId: byId,
      coords: coords
    };
  }

  function getIncomingTargetHeaderIndex(doc) {
    const table = doc.querySelector("#trades_table") || doc.querySelector("table.vis") || doc.querySelector("table");

    if (!table) return -1;

    const headerRows = Array.from(table.querySelectorAll("thead tr, tr")).slice(0, 4);
    const targetPatterns = [
      /target/i,
      /destination/i,
      /recipient/i,
      /to village/i,
      /target village/i,
      /mottag/i,
      /mål/i,
      /ziel/i,
      /destin/i,
      /cible/i,
      /destino/i
    ];
    const originPatterns = [/origin/i, /source/i, /from/i, /ursprung/i, /från/i, /von/i, /origen/i];

    for (let r = 0; r < headerRows.length; r++) {
      const cells = Array.from(headerRows[r].querySelectorAll("th, td"));

      for (let i = 0; i < cells.length; i++) {
        const text = cleanText(cells[i].textContent);
        const links = Array.from(cells[i].querySelectorAll("a[href]")).map(link => link.getAttribute("href") || "").join(" ");

        if (/order=target_village_name/i.test(links)) {
          return i;
        }

        if (!text) continue;

        const isOrigin = originPatterns.some(pattern => pattern.test(text)) || /order=start_village_name/i.test(links);
        const isTarget = targetPatterns.some(pattern => pattern.test(text));

        if (isTarget && !isOrigin) {
          return i;
        }

        // English Tribal Wars trader overview labels the target column simply as "Village".
        // The origin column is labeled "Origin", so a plain Village header is safe here.
        if (/^village$/i.test(text) && !isOrigin) {
          return i;
        }
      }
    }

    return -1;
  }

  function getCoordFromText(text) {
    const matches = cleanText(text).match(/\d{1,3}\|\d{1,3}/g) || [];
    return matches.length ? matches[matches.length - 1] : "";
  }

  function getKnownVillageCoordFromLink(link, lookup) {
    if (!link || !lookup) return "";

    const href = link.getAttribute("href") || "";

    // In overview pages, links often include village=<current village id> even when the
    // link points to a player or another screen. Do not use that value for transport rows.
    if (/screen=info_village/i.test(href)) {
      const id = getParam("id", href) || "";
      if (id && lookup.byId.has(String(id))) {
        return lookup.byId.get(String(id));
      }

      const coord = getCoordFromText(link.textContent || "");
      if (coord) return coord;
    }

    if (/screen=overview/i.test(href)) {
      const id = getParam("village", href) || "";
      if (id && lookup.byId.has(String(id))) {
        return lookup.byId.get(String(id));
      }
    }

    return "";
  }

  function detectIncomingTargetCoord(row, headerIndex, lookup) {
    const cells = Array.from(row.children || []);

    if (headerIndex >= 0 && cells[headerIndex]) {
      const headerCellCoord = getCoordFromText(cells[headerIndex].textContent);
      if (headerCellCoord) {
        return {
          coord: headerCellCoord,
          method: "target-header-cell"
        };
      }

      const headerCellKnownLink = Array.from(cells[headerIndex].querySelectorAll("a[href]")).map(link => getKnownVillageCoordFromLink(link, lookup)).find(Boolean);
      if (headerCellKnownLink) {
        return {
          coord: headerCellKnownLink,
          method: "target-header-link"
        };
      }
    }

    // Fallback for the standard incoming trader table:
    // checkbox, icon, sender, origin, target/village, arrival, arrives in, merchants, resources.
    if (cells.length >= 9) {
      const standardTargetCellCoord = getCoordFromText(cells[4].textContent);
      if (standardTargetCellCoord) {
        return {
          coord: standardTargetCellCoord,
          method: "standard-trader-target-cell"
        };
      }
    }

    const knownLinkCoords = Array.from(row.querySelectorAll("a[href]")).map(link => getKnownVillageCoordFromLink(link, lookup)).filter(Boolean);
    const uniqueKnownLinkCoords = Array.from(new Set(knownLinkCoords));

    if (uniqueKnownLinkCoords.length === 1) {
      return {
        coord: uniqueKnownLinkCoords[0],
        method: "single-known-village-link"
      };
    }

    const coordMatches = cleanText(row.textContent).match(/\d{1,3}\|\d{1,3}/g) || [];

    if (coordMatches.length >= 2) {
      return {
        coord: coordMatches[coordMatches.length - 1],
        method: uniqueKnownLinkCoords.length > 1 ? "last-coordinate-fallback-ambiguous-links" : "last-coordinate-fallback"
      };
    }

    if (uniqueKnownLinkCoords.length) {
      return {
        coord: uniqueKnownLinkCoords[uniqueKnownLinkCoords.length - 1],
        method: "last-known-village-link-fallback"
      };
    }

    return {
      coord: "",
      method: "not-found"
    };
  }

  function addIncomingToMap(incoming, coord, resources) {
    if (!incoming.has(coord)) {
      incoming.set(coord, emptyResources());
    }

    const current = incoming.get(coord);
    current.wood += resources.wood || 0;
    current.stone += resources.stone || 0;
    current.iron += resources.iron || 0;
  }

  function summarizeIncomingMap(incoming) {
    return Array.from(incoming.entries())
      .map(([coord, resources]) => ({
        coord: coord,
        resources: cloneResources(resources),
        total: totalResources(resources)
      }))
      .sort((a, b) => b.total - a.total);
  }

  function parseIncomingRows(doc, rows, lookup, url) {
    const incoming = new Map();
    const headerIndex = getIncomingTargetHeaderIndex(doc);
    const diagnostics = {
      url: url,
      headerTargetIndex: headerIndex,
      rowsSeen: rows.length,
      rowsParsed: 0,
      rowsSkippedNoResources: 0,
      rowsSkippedNoTargetCoord: 0,
      detectionMethods: {},
      totals: emptyResources(),
      ambiguousRows: [],
      parsedSamples: [],
      skippedSamples: [],
      byCoord: []
    };

    rows.forEach((row, rowIndex) => {
      const rowText = cleanText(row.textContent).slice(0, 240);

      if (isIncomingHeaderOrControlRow(row)) {
        if (diagnostics.skippedSamples.length < 8) {
          diagnostics.skippedSamples.push({
            rowIndex: rowIndex,
            reason: "header/control row",
            parserMethod: "row-skipped-before-resource-parse",
            resourceCellText: "",
            looksLikeTransportResources: false,
            text: rowText
          });
        }
        return;
      }

      const resourceParse = extractTransportResourcesFromRow(row);
      const resources = resourceParse.resources;
      const total = totalResources(resources);

      if (total <= 0) {
        diagnostics.rowsSkippedNoResources += 1;
        if (diagnostics.skippedSamples.length < 8) {
          diagnostics.skippedSamples.push({
            rowIndex: rowIndex,
            reason: "no resources",
            parserMethod: resourceParse.method,
            resourceCellText: resourceParse.resourceCellText,
            looksLikeTransportResources: rowTextLooksLikeTransportWithResources(rowText),
            text: rowText
          });
        }
        return;
      }

      const detected = detectIncomingTargetCoord(row, headerIndex, lookup);
      const coord = detected.coord;

      diagnostics.detectionMethods[detected.method] = (diagnostics.detectionMethods[detected.method] || 0) + 1;

      if (!coord) {
        diagnostics.rowsSkippedNoTargetCoord += 1;
        if (diagnostics.skippedSamples.length < 8) {
          diagnostics.skippedSamples.push({ rowIndex: rowIndex, reason: "no target coord", resources: cloneResources(resources), text: rowText });
        }
        return;
      }

      if (diagnostics.parsedSamples.length < 12) {
        diagnostics.parsedSamples.push({
          rowIndex: rowIndex,
          method: detected.method,
          resourceParserMethod: resourceParse.method,
          resourceCellText: resourceParse.resourceCellText,
          selectedCoord: coord,
          resources: cloneResources(resources),
          text: rowText
        });
      }

      if (/ambiguous|fallback/.test(detected.method) && diagnostics.ambiguousRows.length < 20) {
        diagnostics.ambiguousRows.push({
          rowIndex: rowIndex,
          method: detected.method,
          resourceParserMethod: resourceParse.method,
          resourceCellText: resourceParse.resourceCellText,
          selectedCoord: coord,
          resources: cloneResources(resources),
          text: rowText
        });
      }

      addIncomingToMap(incoming, coord, resources);
      addResources(diagnostics.totals, resources);
      diagnostics.rowsParsed += 1;
    });

    diagnostics.byCoord = summarizeIncomingMap(incoming);

    return {
      incoming: incoming,
      diagnostics: diagnostics
    };
  }

  function hasSuspiciousUnparsedIncomingRows(diagnostics) {
    if (!diagnostics || diagnostics.rowsParsed > 0) return false;
    if ((diagnostics.rowsSeen || 0) <= 3) return false;

    return (diagnostics.skippedSamples || []).some(sample => {
      return Boolean(sample && (sample.looksLikeTransportResources || rowTextLooksLikeTransportWithResources(sample.text || "")));
    });
  }

  async function loadIncomingData(villages) {
    const lookup = buildVillageLookupContext(villages);
    const incomingUrlSpecs = [
      {
        label: "incoming-group-0-all-pages",
        screen: "overview_villages",
        mode: "trader",
        type: "inc",
        group: "0",
        page: "-1",
        __skipGroup: true
      },
      {
        label: "incoming-group-0-page-0-debug",
        screen: "overview_villages",
        mode: "trader",
        type: "inc",
        group: "0",
        page: "0",
        __skipGroup: true,
        __debugOnly: true
      },
      {
        label: "incoming-without-group-debug",
        screen: "overview_villages",
        mode: "trader",
        type: "inc",
        page: "-1",
        __skipGroup: true,
        __debugOnly: true
      },
      {
        label: "all-transports-group-0-debug-only",
        screen: "overview_villages",
        mode: "trader",
        type: "all",
        group: "0",
        page: "-1",
        __skipGroup: true,
        __debugOnly: true
      }
    ];

    const attempts = [];
    let selected = null;

    for (let i = 0; i < incomingUrlSpecs.length; i++) {
      const spec = incomingUrlSpecs[i];
      const url = buildGameUrl(spec);

      try {
        const html = await fetchText(url);
        const doc = parseHtml(html);
        const rows = Array.from(doc.querySelectorAll("#trades_table tbody tr.row_a, #trades_table tbody tr.row_b, #trades_table tbody tr"));
        const parsed = parseIncomingRows(doc, rows, lookup, url);
        parsed.diagnostics.label = spec.label || "incoming";
        parsed.diagnostics.debugOnly = Boolean(spec.__debugOnly);
        attempts.push(parsed.diagnostics);

        if (!spec.__debugOnly && (!selected || parsed.diagnostics.rowsParsed > selected.diagnostics.rowsParsed)) {
          selected = parsed;
        }
      } catch (err) {
        attempts.push({
          label: spec.label || "incoming",
          url: url,
          debugOnly: Boolean(spec.__debugOnly),
          error: err && err.message ? err.message : String(err),
          rowsSeen: 0,
          rowsParsed: 0
        });
      }
    }

    if (!selected) {
      selected = {
        incoming: new Map(),
        diagnostics: {
          rowsSeen: 0,
          rowsParsed: 0,
          totals: emptyResources(),
          byCoord: []
        }
      };
    }

    if (hasSuspiciousUnparsedIncomingRows(selected.diagnostics)) {
      if (!state.debug) state.debug = {};
      state.debug.incomingTransportLoad = {
        selectedUrl: selected.diagnostics.url || "",
        selectedLabel: selected.diagnostics.label || "",
        attempts: attempts,
        selected: selected.diagnostics,
        stoppedPlanning: true,
        stopReason: "Incoming transport rows were visible but no resource amounts could be parsed."
      };

        if (state.lastSettings && state.lastSettings.debugConsole) {
        console.groupCollapsed(SCRIPT_NAME + " incoming transport diagnostics " + SCRIPT_VERSION + " - stopped planning");
        console.log("Selected incoming parser result", selected.diagnostics);
        console.log("Incoming parser attempts", attempts);
        console.groupEnd();
      }

      throw new Error("Incoming transports are visible but could not be parsed safely. Planning stopped to avoid duplicate requests and warehouse overfill. Update the script or copy diagnostics.");
    }

    if (!state.debug) state.debug = {};
    state.debug.incomingTransportLoad = {
      selectedUrl: selected.diagnostics.url || "",
      selectedLabel: selected.diagnostics.label || "",
      attempts: attempts,
      selected: selected.diagnostics
    };

    if (state.lastSettings && state.lastSettings.debugConsole) {
      console.groupCollapsed(SCRIPT_NAME + " incoming transport diagnostics " + SCRIPT_VERSION);
      console.log("Selected incoming parser result", selected.diagnostics);
      console.log("Incoming parser attempts", attempts);
      console.log("Incoming by target coord", selected.diagnostics.byCoord || []);
      console.groupEnd();
    }

    return selected.incoming;
  }

  async function loadBuildingsData() {
    const url = buildGameUrl({
      screen: "overview_villages",
      mode: "buildings",
      page: "-1"
    });

    const html = await fetchText(url);
    const doc = parseHtml(html);
    const rows = Array.from(doc.querySelectorAll("#buildings_table tbody tr, #content_value .row_a, #content_value .row_b"));
    const byCoord = new Map();

    rows.forEach(row => {
      if (row.querySelector("th")) return;

      const info = getRowVillageInfo(row);
      if (!info) return;

      const levels = {};
      const queuedBuildings = [];
      const queueIcons = Array.from(row.querySelectorAll(".queue_icon img, img[src*='buildings/']"));
      let queueEndSeconds = 0;

      queueIcons.forEach(img => {
        const src = img.getAttribute("src") || "";
        const title = img.getAttribute("title") || "";
        const buildingMatch = src.match(/buildings\/(\w+)\.(png|webp)/);

        if (buildingMatch) {
          queuedBuildings.push(buildingMatch[1]);
        }

        queueEndSeconds = Math.max(queueEndSeconds, parseQueueEndSeconds(title));
      });

      Array.from(row.querySelectorAll(".upgrade_building")).forEach(node => {
        const buildingClass = Array.from(node.classList).find(name => /^b_/.test(name));

        if (!buildingClass) return;

        const building = buildingClass.replace(/^b_/, "");
        const level = parseNumber(node.textContent);

        if (building && level >= 0) {
          levels[building] = level;
        }
      });

      queuedBuildings.forEach(building => {
        levels[building] = (levels[building] || 0) + 1;
      });

      byCoord.set(info.coord, {
        coord: info.coord,
        queueEndSeconds: queueEndSeconds,
        queueCount: queuedBuildings.length,
        buildingLevels: levels,
        queuedBuildings: queuedBuildings
      });
    });

    return byCoord;
  }

  function normalizeTemplateName(value) {
    return cleanText(value)
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function loadAccountManagerData() {
    const result = {
      templatesByCoord: new Map(),
      templateDefsByName: new Map()
    };

    if (
      typeof game_data !== "undefined" &&
      game_data.features &&
      game_data.features.AccountManager &&
      game_data.features.AccountManager.active === false
    ) {
      return result;
    }

    const mainUrl = buildGameUrl({
      screen: "am_village",
      page: "-1"
    });

    let html;

    try {
      html = await fetchText(mainUrl, { label: "Account Manager village overview" });
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not load Account Manager data:", err);
      return result;
    }

    const doc = parseHtml(html);
    const rows = Array.from(doc.querySelectorAll("#village_table tbody tr, #content_value .row_a, #content_value .row_b"));
    const assignedTemplateNames = new Set();

    rows.forEach(row => {
      if (row.querySelector("th")) return;

      const info = getRowVillageInfo(row);
      if (!info) return;

      const cells = Array.from(row.children);
      let templateName = "";

      if (cells.length > 1) {
        templateName = normalizeTemplateName(cells[1].textContent);
      }

      if (templateName) {
        result.templatesByCoord.set(info.coord, templateName);
        assignedTemplateNames.add(templateName);
      }
    });

    const options = Array.from(doc.querySelectorAll('select[name="template"] option'));
    const templateQueue = [];
    const seenTemplateIds = new Set();

    options.forEach(option => {
      const optionName = normalizeTemplateName(option.textContent);
      const templateId = option.value;

      if (!optionName || !templateId || seenTemplateIds.has(String(templateId))) return;

      const matchesAssigned = Array.from(assignedTemplateNames).some(name => {
        return name === optionName || optionName.includes(name) || name.includes(optionName);
      });

      if (!matchesAssigned) return;

      seenTemplateIds.add(String(templateId));
      templateQueue.push({
        id: templateId,
        name: optionName
      });
    });

    if (!state.debug) state.debug = {};
    state.debug.amTemplateLoad = {
      assignedTemplates: Array.from(assignedTemplateNames),
      queuedTemplates: templateQueue.map(item => ({ id: item.id, name: item.name })),
      loadedTemplates: [],
      failedTemplates: [],
      delayMs: DEFAULTS.templateRequestDelayMs
    };

    for (let i = 0; i < templateQueue.length; i++) {
      const item = templateQueue[i];
      setStatus("Loading AM template " + (i + 1) + "/" + templateQueue.length + ": " + item.name + "...", "warn");

      await throttleDataRequest("AM template delay before " + item.name, DEFAULTS.templateRequestDelayMs);

      const def = await loadTemplateDefinition(item.id, item.name);

      if (!def || !def.name) {
        state.debug.amTemplateLoad.failedTemplates.push({ id: item.id, name: item.name });
        continue;
      }

      state.debug.amTemplateLoad.loadedTemplates.push({
        id: item.id,
        name: def.name,
        buildings: def.buildings ? def.buildings.length : 0
      });

      result.templateDefsByName.set(def.name, def);

      Array.from(assignedTemplateNames).forEach(assignedName => {
        if (def.name === assignedName || def.name.includes(assignedName) || assignedName.includes(def.name)) {
          result.templateDefsByName.set(assignedName, def);
        }
      });
    }

    return result;
  }

  async function loadTemplateDefinition(templateId, templateName) {
    const url = buildGameUrl({
      screen: "am_village",
      mode: "queue",
      template: templateId
    });

    try {
      const html = await fetchText(url, { label: "AM template " + templateName, retries: DEFAULTS.fetchMaxRetries, retryDelayMs: DEFAULTS.fetchRetryDelayMs });
      const doc = parseHtml(html);
      const buildings = [];

      Array.from(doc.querySelectorAll(".sortable_row")).forEach(row => {
        const building = row.getAttribute("data-building") || "";
        const absText = cleanText(row.querySelector(".level_absolute")?.textContent || "");
        const absMatch = absText.match(/\d+/);

        if (!building || !absMatch) return;

        buildings.push({
          name: building,
          levelAbsolute: parseInt(absMatch[0], 10)
        });
      });

      let farmCapacityPercent = 99;
      const customFarm = doc.querySelector('input[name="farm_upgrade_toggle"]');
      const populationSelect = doc.querySelector('select[name="population_upgrades"]');

      if (customFarm && customFarm.checked && populationSelect) {
        farmCapacityPercent = 100 - parseNumber(populationSelect.value);
      }

      return {
        name: templateName,
        buildings: buildings,
        farmCapacityPercent: farmCapacityPercent
      };
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not load AM template " + templateName + ":", err);
      return null;
    }
  }

  async function loadBuildingConstants() {
    const localKey = getWorldKey("twactics_building_constants");

    try {
      const existing = localStorage.getItem(localKey);
      if (existing) {
        return new Map(JSON.parse(existing));
      }
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not read cached building constants:", err);
    }

    const response = await fetch("/interface.php?func=get_building_info", {
      method: "GET",
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error("Could not load building constants.");
    }

    const xml = await response.text();
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const constants = new Map();
    const config = doc.querySelector("config");

    if (!config) {
      return constants;
    }

    Array.from(config.children).forEach(node => {
      const name = node.tagName.toLowerCase();

      constants.set(name, {
        wood: parseNumber(node.querySelector("wood")?.textContent || "0"),
        stone: parseNumber(node.querySelector("stone")?.textContent || "0"),
        iron: parseNumber(node.querySelector("iron")?.textContent || "0"),
        woodFactor: parseFloatSafe(node.querySelector("wood_factor")?.textContent, 1),
        stoneFactor: parseFloatSafe(node.querySelector("stone_factor")?.textContent, 1),
        ironFactor: parseFloatSafe(node.querySelector("iron_factor")?.textContent, 1),
        buildTime: parseFloatSafe(node.querySelector("build_time")?.textContent, 0),
        buildTimeFactor: parseFloatSafe(node.querySelector("build_time_factor")?.textContent, 1)
      });
    });

    try {
      localStorage.setItem(localKey, JSON.stringify(Array.from(constants.entries())));
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not cache building constants:", err);
    }

    return constants;
  }

  function getWorldKey(name) {
    const world = typeof game_data !== "undefined" && game_data.world ? game_data.world : "world";
    return world + "_" + name;
  }

  function emptyResources() {
    return {
      wood: 0,
      stone: 0,
      iron: 0
    };
  }

  function addResources(target, source) {
    target.wood += source.wood || 0;
    target.stone += source.stone || 0;
    target.iron += source.iron || 0;
    return target;
  }

  function subtractResources(target, source) {
    target.wood -= source.wood || 0;
    target.stone -= source.stone || 0;
    target.iron -= source.iron || 0;
    return target;
  }

  function cloneResources(source) {
    return {
      wood: source.wood || 0,
      stone: source.stone || 0,
      iron: source.iron || 0
    };
  }

  function totalResources(source) {
    return Math.max(0, source.wood || 0) +
      Math.max(0, source.stone || 0) +
      Math.max(0, source.iron || 0);
  }

  function calculateBuildingCostTime(hqLevel, level, constants) {
    if (!constants || level < 1) {
      return {
        seconds: 0,
        wood: 0,
        stone: 0,
        iron: 0
      };
    }

    const hq = Math.max(1, hqLevel || 1);
    const buildTime = constants.buildTime *
      Math.pow(1.2, level - 1) *
      Math.pow(1.05, -hq) *
      getBuildTimeLevelConstant(level);

    return {
      seconds: Math.round(buildTime),
      wood: Math.round(constants.wood * Math.pow(constants.woodFactor, level - 1)),
      stone: Math.round(constants.stone * Math.pow(constants.stoneFactor, level - 1)),
      iron: Math.round(constants.iron * Math.pow(constants.ironFactor, level - 1))
    };
  }

  function getBuildTimeLevelConstant(level) {
    const constants = {
      1: 1,
      2: 1,
      3: 0.112292,
      4: 0.289555,
      5: 0.46113,
      6: 0.606372,
      7: 0.723059,
      8: 0.815935,
      9: 0.889947,
      10: 0.948408,
      11: 0.994718,
      12: 1.031,
      13: 1.059231,
      14: 1.080939,
      15: 1.09729,
      16: 1.109156,
      17: 1.117308,
      18: 1.122392,
      19: 1.124817,
      20: 1.124917,
      21: 1.123181,
      22: 1.119778,
      23: 1.114984,
      24: 1.109038,
      25: 1.102077,
      26: 1.0942,
      27: 1.085601,
      28: 1.076369,
      29: 1.066566,
      30: 1.056291
    };

    return constants[level] || 1;
  }

  function calculateTemplateNeed(village, settings) {
    const need = emptyResources();
    const details = [];
    const template = village.amTemplate;

    const horizonSeconds = Math.max(0, settings.constructionHours * 3600);
    let queueSeconds = village.queueEndSeconds || 0;

    function horizonReached() {
      return horizonSeconds <= 0 || queueSeconds >= horizonSeconds;
    }

    function currentHqLevel() {
      return Math.max(1, levels.main || 1);
    }

    if (!template || !template.buildings || !template.buildings.length) {
      return {
        resources: need,
        details: details,
        simulatedQueueHours: queueSeconds / 3600
      };
    }

    const levels = Object.assign({}, village.buildingLevels || {});

    if (horizonReached()) {
      return {
        resources: need,
        details: details,
        simulatedQueueHours: queueSeconds / 3600
      };
    }

    if (levels.farm < 30 && village.farmRatio >= (template.farmCapacityPercent || 99) / 100) {
      const constants = state.buildingConstants.get("farm");
      const nextLevel = (levels.farm || 0) + 1;
      const cost = calculateBuildingCostTime(currentHqLevel(), nextLevel, constants);

      addResources(need, cost);
      details.push({
        building: "farm",
        level: nextLevel,
        reason: "farm capacity",
        resources: cloneResources(cost),
        seconds: cost.seconds
      });

      levels.farm = nextLevel;
      queueSeconds += cost.seconds;

      if (horizonReached()) {
        return {
          resources: need,
          details: details,
          simulatedQueueHours: queueSeconds / 3600
        };
      }
    }

    for (let i = 0; i < template.buildings.length; i++) {
      const templateItem = template.buildings[i];
      const building = templateItem.name;
      const targetLevel = templateItem.levelAbsolute;
      const constants = state.buildingConstants.get(building);

      if (!constants) continue;

      while ((levels[building] || 0) < targetLevel) {
        if (horizonReached()) {
          return {
            resources: need,
            details: details,
            simulatedQueueHours: queueSeconds / 3600
          };
        }

        const nextLevel = (levels[building] || 0) + 1;
        const cost = calculateBuildingCostTime(currentHqLevel(), nextLevel, constants);

        addResources(need, cost);
        details.push({
          building: building,
          level: nextLevel,
          reason: "template",
          resources: cloneResources(cost),
          seconds: cost.seconds
        });

        levels[building] = nextLevel;
        queueSeconds += cost.seconds;

        if (horizonReached()) {
          return {
            resources: need,
            details: details,
            simulatedQueueHours: queueSeconds / 3600
          };
        }
      }
    }

    return {
      resources: need,
      details: details,
      simulatedQueueHours: queueSeconds / 3600
    };
  }

  function mergeLoadedData(villages, buildingsByCoord, incomingByCoord, amData, buildingConstants, settings) {
    state.villages = villages;
    state.villagesByCoord = new Map();
    state.villagesById = new Map();
    state.incomingByCoord = incomingByCoord;
    state.amTemplatesByCoord = amData.templatesByCoord;
    state.amTemplateDefsByName = amData.templateDefsByName;
    state.buildingConstants = buildingConstants;

    state.villages.forEach(village => {
      const buildingData = buildingsByCoord.get(village.coord);
      const templateName = amData.templatesByCoord.get(village.coord) || "";
      const template = templateName ? amData.templateDefsByName.get(templateName) : null;

      if (buildingData) {
        village.queueEndSeconds = buildingData.queueEndSeconds || 0;
        village.queueCount = buildingData.queueCount || 0;
        village.buildingLevels = buildingData.buildingLevels || {};
        village.queuedBuildings = buildingData.queuedBuildings || [];
      }

      village.amTemplateName = templateName;
      village.amTemplate = template || null;
      village.incoming = incomingByCoord.get(village.coord) || emptyResources();
      village.home = {
        wood: village.wood,
        stone: village.stone,
        iron: village.iron
      };

      const ownNeed = calculateTemplateNeed(village, settings);
      village.ownNeed = ownNeed.resources;
      village.ownNeedDetails = ownNeed.details;
      village.simulatedQueueHours = ownNeed.simulatedQueueHours;

      state.villagesByCoord.set(village.coord, village);
      state.villagesById.set(String(village.id), village);
    });
  }

  function getSettings() {
    const useAmTemplates = ui.planMode.value === "am";
    const constructionHours = Math.max(0, Math.min(72, parseFloatSafe(ui.constructionHours.value, DEFAULTS.constructionHours)));
    const reserveMerchants = Math.max(0, parseInt(ui.reserveMerchants.value, 10) || DEFAULTS.reserveMerchants);
    const maxDistance = Math.max(0, parseFloatSafe(ui.maxDistance.value, DEFAULTS.maxDistance));
    const reserveWarehousePercent = Math.max(0, Math.min(80, parseFloatSafe(ui.reserveWarehousePercent.value, DEFAULTS.reserveWarehousePercent)));
    const arrivalBalanceWindowMinutes = DEFAULTS.arrivalBalanceWindowMinutes;
    const prioritizeLowPoints = ui.prioritizeLowPoints.checked;
    const savedSettings = state.savedSettings || {};
    const enableRelayReplenishment = ui.enableRelayReplenishment ? ui.enableRelayReplenishment.checked : (savedSettings.enableRelayReplenishment !== undefined ? savedSettings.enableRelayReplenishment !== false : DEFAULTS.enableRelayReplenishment);
    const relaySafetyBufferMinutes = savedSettings.relaySafetyBufferMinutes !== undefined ? Math.max(0, Math.min(360, parseFloatSafe(savedSettings.relaySafetyBufferMinutes, DEFAULTS.relaySafetyBufferMinutes))) : DEFAULTS.relaySafetyBufferMinutes;
    const debugConsole = savedSettings.debugConsole === true;

    return {
      useAmTemplates: useAmTemplates,
      constructionHours: constructionHours,
      averageFactor: DEFAULTS.averageFactor,
      reserveMerchants: reserveMerchants,
      reserveWarehousePercent: reserveWarehousePercent,
      lowFarmBlockedReservePercent: DEFAULTS.lowFarmBlockedReservePercent,
      lowFarmFreePercent: DEFAULTS.lowFarmFreePercent,
      merchantCapacity: DEFAULTS.merchantCapacity,
      minShipment: DEFAULTS.minShipment,
      maxDistance: maxDistance,
      arrivalBalanceWindowMinutes: arrivalBalanceWindowMinutes,
      merchantMinutesPerField: getMerchantMinutesPerField(),
      targetWarehouseLimitPercent: DEFAULTS.targetWarehouseLimitPercent,
      minResourcePerOrigin: DEFAULTS.minResourcePerOrigin,
      targetQueueCoverageBuildings: DEFAULTS.targetQueueCoverageBuildings,
      queueSoonRefillBuildingCount: DEFAULTS.queueSoonRefillBuildingCount,
      emptyQueueBoost: DEFAULTS.emptyQueueBoost,
      lowPointsBoost: prioritizeLowPoints ? DEFAULTS.lowPointsBoost : 0,
      priorityMode: "construction_first",
      donorPreference: useAmTemplates ? "distance_optimized" : DEFAULTS.donorPreference,
      donorDistancePenalty: DEFAULTS.donorDistancePenalty,
      noTemplateDonorBonus: DEFAULTS.noTemplateDonorBonus,
      farmBlockedDonorBonus: DEFAULTS.farmBlockedDonorBonus,
      idleDonorBonus: DEFAULTS.idleDonorBonus,
      deadVillageDonorBonus: DEFAULTS.deadVillageDonorBonus,
      scoreDistanceTieThreshold: DEFAULTS.scoreDistanceTieThreshold,
      donorAuditLimit: DEFAULTS.donorAuditLimit,
      protectDonorConstruction: useAmTemplates,
      includeAverageBalance: false,
      prioritizeNoTemplateDonors: useAmTemplates,
      prioritizeLowPoints: prioritizeLowPoints,
      enableRelayReplenishment: enableRelayReplenishment,
      relaySafetyBufferMinutes: relaySafetyBufferMinutes,
      debugConsole: debugConsole
    };
  }

  async function loadAndPlan() {
    try {
      ui.planButton.disabled = true;
      if (ui.results) ui.results.innerHTML = "";

      const settings = getSettings();
      persistSettings();
      state.lastSettings = settings;
      state.sendLocked = false;

      setStatus(
        settings.useAmTemplates
          ? "Loading production, buildings, Account Manager and incoming transport data..."
          : "Loading production, buildings and incoming transport data...",
        "warn"
      );

      const emptyAmData = {
        templatesByCoord: new Map(),
        templateDefsByName: new Map()
      };

      state.debug = {
        dataLoad: []
      };

      setStatus("Loading production data: resources, warehouse capacity and merchants...", "warn");
      const productionData = await loadProductionData();
      await throttleDataRequest("after production data");

      setStatus("Loading building queues...", "warn");
      const buildingsData = await loadBuildingsData();
      await throttleDataRequest("after building queues");

      setStatus("Loading incoming transports from group 0...", "warn");
      const incomingData = await loadIncomingData(productionData);

      let buildingConstants = new Map();
      let amData = emptyAmData;

      if (settings.useAmTemplates) {
        await throttleDataRequest("before building constants");
        setStatus("Loading building cost data...", "warn");
        buildingConstants = await loadBuildingConstants();

        await throttleDataRequest("before Account Manager templates");
        setStatus("Loading Account Manager templates sequentially...", "warn");
        amData = await loadAccountManagerData();
      }

      mergeLoadedData(productionData, buildingsData, incomingData, amData, buildingConstants, settings);

      const planResult = createTransferPlan(settings);
      state.plan = planResult.targetPlans;
      state.stats = planResult.stats;

      logPlanDiagnostics(planResult, settings);
      renderResults(planResult);

      setStatus(
        "Loaded " + state.villages.length + " village(s). Planned " +
          planResult.targetPlans.length + " target request(s) from " +
          planResult.launches.length + " origin request source(s).",
        "success"
      );
    } catch (err) {
      console.error(SCRIPT_NAME + " failed:", err);
      setStatus(err && err.message ? err.message : String(err), "error");
    } finally {
      if (ui.planButton) ui.planButton.disabled = false;
    }
  }

  function createTransferPlan(settings) {
    const previousDebug = state.debug || {};
    state.debug = {
      incomingTransportLoad: previousDebug.incomingTransportLoad || null,
      dataLoad: previousDebug.dataLoad || [],
      amTemplateLoad: previousDebug.amTemplateLoad || null,
      cappedTargets: [],
      skippedSmallShipments: [],
      rejectedTinyResourceFragments: [],
      relayCandidates: [],
      relayAccepted: [],
      relayRejected: [],
      targetExclusions: []
    };

    const villages = state.villages.slice();
    const stats = calculateGlobalStats(villages);
    const targets = buildTargets(villages, stats, settings);
    targets.forEach((target, index) => {
      target.planningOrder = index + 1;
    });
    const donors = buildDonors(villages, stats, settings);
    const directLaunches = matchDonorsToTargets(targets, donors, settings);
    const relayLaunches = settings.enableRelayReplenishment
      ? buildRelayReplenishmentLaunches(directLaunches, targets, donors, settings, directLaunches.length + 1)
      : [];
    const launches = directLaunches.concat(relayLaunches);
    const targetPlans = groupLaunchesByTarget(launches, settings);
    const donorAudit = buildDonorAudit(donors, targets, launches, settings);

    return {
      launches: launches,
      targetPlans: targetPlans,
      targets: targets,
      donors: donors,
      donorAudit: donorAudit,
      stats: stats
    };
  }

  function calculateGlobalStats(villages) {
    const totals = villages.reduce((acc, village) => {
      const incoming = village.incoming || emptyResources();

      acc.wood += village.wood + incoming.wood;
      acc.stone += village.stone + incoming.stone;
      acc.iron += village.iron + incoming.iron;
      acc.capacity += village.capacity || 0;
      acc.points += village.points || 0;
      acc.minPoints = Math.min(acc.minPoints, village.points || 0);
      acc.maxPoints = Math.max(acc.maxPoints, village.points || 0);
      return acc;
    }, {
      wood: 0,
      stone: 0,
      iron: 0,
      capacity: 0,
      points: 0,
      minPoints: 9999999,
      maxPoints: 0
    });

    const count = Math.max(1, villages.length);
    const totalCapacity = Math.max(1, totals.capacity);

    return {
      totalWood: totals.wood,
      totalStone: totals.stone,
      totalIron: totals.iron,
      totalCapacity: totals.capacity,
      avgWood: totals.wood / count,
      avgStone: totals.stone / count,
      avgIron: totals.iron / count,
      woodFillRatio: Math.min(0.95, Math.max(0, totals.wood / totalCapacity)),
      stoneFillRatio: Math.min(0.95, Math.max(0, totals.stone / totalCapacity)),
      ironFillRatio: Math.min(0.95, Math.max(0, totals.iron / totalCapacity)),
      minPoints: totals.minPoints === 9999999 ? 0 : totals.minPoints,
      maxPoints: totals.maxPoints,
      avgPoints: totals.points / count
    };
  }

  function getTargetWarehouseLimit(village, settings) {
    const capacity = Math.max(0, village && village.capacity || 0);

    if (capacity <= 0) {
      return null;
    }

    const limitPercent = Math.max(0, Math.min(100, settings.targetWarehouseLimitPercent !== undefined ? settings.targetWarehouseLimitPercent : DEFAULTS.targetWarehouseLimitPercent));
    return Math.floor(capacity * (limitPercent / 100));
  }

  function getTargetWarehouseSpace(village, settings) {
    const limit = getTargetWarehouseLimit(village, settings);

    if (limit === null) {
      return null;
    }

    const current = getCurrentResourcesWithIncoming(village);

    return {
      wood: Math.max(0, limit - current.wood),
      stone: Math.max(0, limit - current.stone),
      iron: Math.max(0, limit - current.iron)
    };
  }

  function getTargetCurrentOverWarehouseLimit(village, settings) {
    const limit = getTargetWarehouseLimit(village, settings);

    if (limit === null) {
      return null;
    }

    const current = getCurrentResourcesWithIncoming(village);

    return {
      wood: current.wood > limit,
      stone: current.stone > limit,
      iron: current.iron > limit
    };
  }

  function hasAnyWarehouseLimitOverflow(over) {
    return Boolean(over && (over.wood || over.stone || over.iron));
  }

  function capNeedToTargetWarehouse(village, need, settings) {
    const space = getTargetWarehouseSpace(village, settings);
    const capped = cloneResources(need || emptyResources());
    const reduced = emptyResources();
    const currentOverLimit = getTargetCurrentOverWarehouseLimit(village, settings);

    if (!space) {
      return {
        need: capped,
        reduced: reduced,
        limited: false,
        space: null,
        currentOverLimit: currentOverLimit,
        blockedByCurrentOverLimit: false
      };
    }

    ["wood", "stone", "iron"].forEach(key => {
      const before = capped[key] || 0;
      capped[key] = Math.max(0, Math.min(before, space[key] || 0));
      reduced[key] = Math.max(0, before - capped[key]);
    });

    return {
      need: capped,
      reduced: reduced,
      limited: totalResources(reduced) > 0,
      space: space,
      currentOverLimit: currentOverLimit,
      blockedByCurrentOverLimit: false
    };
  }

  function sumNeedDetails(details, limit) {
    const need = emptyResources();
    const selected = [];
    const maxItems = Math.max(0, limit || 0);

    (details || []).forEach(detail => {
      if (selected.length >= maxItems) return;
      const resources = detail && detail.resources ? detail.resources : emptyResources();
      if (totalResources(resources) <= 0) return;
      addResources(need, resources);
      selected.push(detail);
    });

    return {
      resources: need,
      details: selected,
      count: selected.length
    };
  }

  function getTargetQueueCoverage(village, settings) {
    const currentQueueCount = Math.max(0, village.queueCount || 0);
    const currentQueueHours = (village.queueEndSeconds || 0) / 3600;
    const targetQueueHours = Math.max(0, settings.constructionHours || DEFAULTS.constructionHours);
    const horizonSeconds = targetQueueHours * 3600;
    const details = village.ownNeedDetails || [];
    const resources = emptyResources();
    const selected = [];
    let simulatedSeconds = Math.max(0, village.queueEndSeconds || 0);

    details.forEach(detail => {
      if (horizonSeconds <= 0 || simulatedSeconds >= horizonSeconds) return;
      const detailResources = detail && detail.resources ? detail.resources : emptyResources();
      if (totalResources(detailResources) <= 0) return;

      addResources(resources, detailResources);
      selected.push(detail);
      simulatedSeconds += Math.max(0, detail.seconds || 0);
    });

    const simulatedQueueHours = simulatedSeconds / 3600;

    return {
      currentQueueCount: currentQueueCount,
      targetQueueCount: targetQueueHours,
      targetQueueHours: targetQueueHours,
      currentQueueHours: currentQueueHours,
      queueHours: currentQueueHours,
      missingQueueHours: Math.max(0, targetQueueHours - currentQueueHours),
      wantedBuilds: selected.length,
      plannedBuilds: selected.length,
      details: selected,
      resources: resources,
      simulatedQueueHours: simulatedQueueHours,
      mode: selected.length > 0 ? "time coverage" : "already covered"
    };
  }

  function formatQueueCoverage(queueCoverage) {
    if (!queueCoverage) return "";

    const current = Number.isFinite(queueCoverage.currentQueueHours) ? queueCoverage.currentQueueHours : 0;
    const target = Number.isFinite(queueCoverage.targetQueueHours) ? queueCoverage.targetQueueHours : DEFAULTS.constructionHours;
    const simulated = Number.isFinite(queueCoverage.simulatedQueueHours) ? queueCoverage.simulatedQueueHours : current;
    const builds = queueCoverage.plannedBuilds || 0;

    if (builds > 0) {
      return current.toFixed(1) + "h -> " + Math.min(simulated, Math.max(target, current)).toFixed(1) + "h, +" + builds + " build(s)";
    }

    return current.toFixed(1) + "h / " + target.toFixed(1) + "h";
  }

  function getTargetPriorityTier(target, settings) {
    if (!settings.useAmTemplates) return 50;

    const queueHours = Math.max(0, target.queueHours || 0);
    const horizonHours = Math.max(1, settings.constructionHours || DEFAULTS.constructionHours);

    if (target.queueEmpty) return 0;
    if (queueHours <= 1) return 1;
    if (queueHours <= Math.min(3, horizonHours)) return 2;
    if (queueHours < horizonHours) return 3;
    return 4;
  }

  function sortTargetsForPlanning(a, b, settings) {
    if (!settings.useAmTemplates) {
      const scoreDiff = b.score - a.score;
      if (scoreDiff) return scoreDiff;
      return b.totalNeed - a.totalNeed;
    }

    const tierDiff = (a.priorityTier || 0) - (b.priorityTier || 0);
    if (tierDiff) return tierDiff;

    const queueDiff = (a.queueHours || 0) - (b.queueHours || 0);
    if (Math.abs(queueDiff) > 0.05) return queueDiff;

    if (settings.prioritizeLowPoints) {
      const pointDiff = (a.village.points || 0) - (b.village.points || 0);
      if (pointDiff) return pointDiff;
    }

    const missingHourDiff = (b.queueCoverage && b.queueCoverage.missingQueueHours || 0) - (a.queueCoverage && a.queueCoverage.missingQueueHours || 0);
    if (Math.abs(missingHourDiff) > 0.05) return missingHourDiff;

    const plannedBuildDiff = (b.queueCoverage && b.queueCoverage.plannedBuilds || 0) - (a.queueCoverage && a.queueCoverage.plannedBuilds || 0);
    if (plannedBuildDiff) return plannedBuildDiff;

    return b.totalNeed - a.totalNeed;
  }

  function determineTargetNoNeedReason(hasTemplateData, queueCoverage, needBeforeWarehouseCap, needAfterWarehouseCap, warehouseCap) {
    if (!hasTemplateData) {
      return "AM template assigned but template definition was not loaded or matched";
    }

    if (!queueCoverage || !(queueCoverage.plannedBuilds > 0)) {
      return "queue coverage already satisfied, or no next template building found within coverage horizon";
    }

    if (totalResources(needBeforeWarehouseCap || emptyResources()) <= 0) {
      return "current + incoming resources already cover the simulated template need";
    }

    if (warehouseCap && totalResources(needBeforeWarehouseCap || emptyResources()) > 0 && totalResources(needAfterWarehouseCap || emptyResources()) <= 0) {
      return "90% target warehouse cap removed all remaining need";
    }

    return "no positive requestable need after current resources, incoming resources and warehouse cap";
  }

  function pushTargetExclusionDiagnostic(data) {
    if (!state.debug || !state.debug.targetExclusions) return;
    state.debug.targetExclusions.push(data);
  }

  function buildTargets(villages, stats, settings) {
    return villages.map(village => {
      const current = getCurrentResourcesWithIncoming(village);
      const hasTemplate = Boolean(village.amTemplateName);
      const hasTemplateData = Boolean(village.amTemplate);
      const queueHours = (village.queueEndSeconds || 0) / 3600;
      const queueEmpty = (village.queueCount || 0) === 0 && queueHours === 0;
      const queueSoon = hasTemplate && settings.constructionHours > 0
        ? Math.max(0, 1 - Math.min(1, queueHours / settings.constructionHours))
        : 0;

      const pointRange = Math.max(1, stats.maxPoints - stats.minPoints);
      const lowPointRatio = stats.maxPoints > 0
        ? (stats.maxPoints - (village.points || 0)) / pointRange
        : 0;

      let constructionNeed = emptyResources();
      let warehouseTarget = emptyResources();
      let need = emptyResources();
      let score = 0;

      let queueCoverage = null;

      if (settings.useAmTemplates) {
        queueCoverage = getTargetQueueCoverage(village, settings);
        constructionNeed = cloneResources(queueCoverage.resources || emptyResources());
        need = {
          wood: Math.max(0, constructionNeed.wood - current.wood),
          stone: Math.max(0, constructionNeed.stone - current.stone),
          iron: Math.max(0, constructionNeed.iron - current.iron)
        };
      } else {
        warehouseTarget = getWarehouseBalanceTarget(village, stats);
        need = {
          wood: Math.max(0, warehouseTarget.wood - current.wood),
          stone: Math.max(0, warehouseTarget.stone - current.stone),
          iron: Math.max(0, warehouseTarget.iron - current.iron)
        };
      }

      const needBeforeWarehouseCap = cloneResources(need);
      const warehouseCap = capNeedToTargetWarehouse(village, need, settings);
      need = warehouseCap.need;

      if (warehouseCap && warehouseCap.limited && state.debug && state.debug.cappedTargets) {
        state.debug.cappedTargets.push({
          coord: village.coord,
          id: village.id,
          name: village.name,
          capacity: village.capacity || 0,
          safeLimit: getTargetWarehouseLimit(village, settings),
          currentWithIncoming: getCurrentResourcesWithIncoming(village),
          remainingSafeSpace: cloneResources(warehouseCap.space || emptyResources()),
          reduced: cloneResources(warehouseCap.reduced || emptyResources()),
          cappedNeed: cloneResources(need),
          currentOverLimit: warehouseCap.currentOverLimit || null
        });
      }

      if (settings.useAmTemplates) {
        const queueCoverageMissingHours = queueCoverage ? Math.max(0, queueCoverage.missingQueueHours || 0) : 0;
        const queueCoverageBuilds = queueCoverage ? Math.max(0, queueCoverage.plannedBuilds || 0) : 0;
        score = totalResources(need) / 1000;
        score += queueCoverageMissingHours * 35;
        score += queueCoverageBuilds * 12;

        if (hasTemplate) {
          score += 10;
        }

        if (hasTemplate && queueEmpty) {
          score += settings.emptyQueueBoost;
        }

        if (hasTemplate) {
          score += queueSoon * 20;
        }

        if (!hasTemplateData && hasTemplate) {
          score *= 0.35;
        }
      } else {
        score = totalResources(need) / 1000;
        score += lowPointRatio * settings.lowPointsBoost * 0.35;
      }

      const totalNeed = totalResources(need);

      if (settings.useAmTemplates && hasTemplate && totalNeed <= 0) {
        pushTargetExclusionDiagnostic({
          coord: village.coord,
          id: village.id,
          name: village.name,
          points: village.points || 0,
          amTemplateName: village.amTemplateName || "",
          hasTemplateData: hasTemplateData,
          queueCount: village.queueCount || 0,
          queueHours: queueHours,
          queueCoverage: formatQueueCoverage(queueCoverage),
          plannedBuilds: queueCoverage ? queueCoverage.plannedBuilds : 0,
          current: getCurrentResourcesOnly(village),
          incoming: cloneResources(village.incoming || emptyResources()),
          currentPlusIncoming: getCurrentResourcesWithIncoming(village),
          constructionNeed: cloneResources(constructionNeed || emptyResources()),
          needBeforeWarehouseCap: cloneResources(needBeforeWarehouseCap || emptyResources()),
          needAfterWarehouseCap: cloneResources(need || emptyResources()),
          warehouseSpace: warehouseCap ? cloneResources(warehouseCap.space || emptyResources()) : null,
          warehouseReduced: warehouseCap ? cloneResources(warehouseCap.reduced || emptyResources()) : emptyResources(),
          currentOverLimit: warehouseCap ? warehouseCap.currentOverLimit : null,
          reason: determineTargetNoNeedReason(hasTemplateData, queueCoverage, needBeforeWarehouseCap, need, warehouseCap),
          nextBuilds: (queueCoverage && queueCoverage.details ? queueCoverage.details : []).slice(0, 5).map(detail => ({
            building: detail.building,
            level: detail.level,
            reason: detail.reason,
            seconds: detail.seconds,
            resources: cloneResources(detail.resources || emptyResources())
          }))
        });
      }

      const targetDraft = {
        village: village,
        need: need,
        initialNeed: cloneResources(need),
        arrivalBuckets: new Map(),
        constructionNeed: constructionNeed,
        warehouseTarget: warehouseTarget,
        warehouseSpace: warehouseCap.space,
        warehouseLimited: warehouseCap.limited,
        warehouseReduced: warehouseCap.reduced,
        totalNeed: totalNeed,
        score: score,
        hasTemplate: hasTemplate,
        hasTemplateData: hasTemplateData,
        queueEmpty: queueEmpty,
        queueHours: queueHours,
        queueCoverage: queueCoverage,
        lowPointRatio: lowPointRatio,
        reason: buildTargetReason(village, totalNeed, hasTemplate, queueEmpty, queueHours, lowPointRatio, settings, warehouseTarget, warehouseCap, queueCoverage)
      };

      targetDraft.priorityTier = getTargetPriorityTier(targetDraft, settings);
      return targetDraft;
    })
      .filter(target => target.totalNeed >= settings.minShipment || (settings.useAmTemplates && target.totalNeed > 0))
      .sort((a, b) => sortTargetsForPlanning(a, b, settings));
  }

  function buildTargetReason(village, totalNeed, hasTemplate, queueEmpty, queueHours, lowPointRatio, settings, warehouseTarget, warehouseCap, queueCoverage) {
    const reasons = [];

    if (!settings.useAmTemplates) {
      reasons.push("below warehouse % target");
      if (warehouseTarget && totalResources(warehouseTarget) > 0) {
        reasons.push("target " + formatResources(warehouseTarget));
      }
    } else if (hasTemplate && queueEmpty) {
      reasons.push("AM template + empty queue");
    } else if (hasTemplate && queueHours <= settings.constructionHours) {
      reasons.push("AM queue ends soon");
    } else if (hasTemplate) {
      reasons.push("AM template active");
    }

    if (settings.useAmTemplates && queueCoverage && queueCoverage.wantedBuilds > 0) {
      reasons.push("build coverage " + formatQueueCoverage(queueCoverage));
    }

    if (lowPointRatio > 0.5 && settings.prioritizeLowPoints) {
      reasons.push("lower points");
    }

    if (warehouseCap && warehouseCap.limited) {
      const overLimitText = warehouseCap.currentOverLimit && hasAnyWarehouseLimitOverflow(warehouseCap.currentOverLimit)
        ? " (resource-specific cap; already over: " + formatWarehouseOverResources(warehouseCap.currentOverLimit) + ")"
        : "";
      reasons.push("90% target warehouse safety limit reduced by " + formatNumber(totalResources(warehouseCap.reduced)) + overLimitText);
    }

    if (totalNeed > 0) {
      reasons.push("resource deficit " + formatNumber(totalNeed));
    }

    if (!reasons.length) {
      reasons.push(settings.useAmTemplates ? "construction target" : "warehouse balance target");
    }

    return reasons.join(", ");
  }

  function getCurrentResourcesOnly(village) {
    return {
      wood: village.wood || 0,
      stone: village.stone || 0,
      iron: village.iron || 0
    };
  }

  function getCurrentResourcesWithIncoming(village) {
    const incoming = village.incoming || emptyResources();

    return {
      wood: (village.wood || 0) + incoming.wood,
      stone: (village.stone || 0) + incoming.stone,
      iron: (village.iron || 0) + incoming.iron
    };
  }

  function getDetectedWorldSpeedFactor() {
    const candidates = [];

    if (typeof game_data !== "undefined") {
      if (game_data.speed) candidates.push(game_data.speed);
      if (game_data.unit_speed) candidates.push(game_data.unit_speed);
      if (game_data.world_config && game_data.world_config.speed) candidates.push(game_data.world_config.speed);
      if (game_data.world_config && game_data.world_config.unit_speed) candidates.push(game_data.world_config.unit_speed);
      if (game_data.config && game_data.config.speed) candidates.push(game_data.config.speed);
      if (game_data.config && game_data.config.unit_speed) candidates.push(game_data.config.unit_speed);
    }

    for (let i = 0; i < candidates.length; i++) {
      const value = parseFloatSafe(candidates[i], 0);
      if (value > 0) return value;
    }

    return 1;
  }

  function getMerchantMinutesPerField() {
    const speed = getDetectedWorldSpeedFactor();
    return Math.max(0.1, DEFAULTS.baseMerchantMinutesPerField / Math.max(0.1, speed));
  }

  function getTravelMinutes(distance, settings) {
    return Math.max(0, (distance || 0) * (settings.merchantMinutesPerField || getMerchantMinutesPerField()));
  }

  function getArrivalBucketIndex(travelMinutes, settings) {
    const windowMinutes = Math.max(1, settings.arrivalBalanceWindowMinutes || DEFAULTS.arrivalBalanceWindowMinutes);
    return Math.floor(Math.max(0, travelMinutes || 0) / windowMinutes);
  }

  function getTargetArrivalBucket(target, bucketIndex) {
    if (!target.arrivalBuckets) target.arrivalBuckets = new Map();
    const key = String(bucketIndex || 0);

    if (!target.arrivalBuckets.has(key)) {
      target.arrivalBuckets.set(key, emptyResources());
    }

    return target.arrivalBuckets.get(key);
  }

  function addResourcesToArrivalBucket(target, bucketIndex, resources) {
    const bucket = getTargetArrivalBucket(target, bucketIndex);
    addResources(bucket, resources || emptyResources());
  }

  function getActiveResourceKeys(resources) {
    return ["wood", "stone", "iron"].filter(key => (resources && resources[key] || 0) > 0);
  }

  function cleanSmallResourceAmounts(resources, minAmount) {
    const cleaned = cloneResources(resources || emptyResources());
    const removed = emptyResources();
    const threshold = Math.max(0, minAmount || 0);

    if (threshold <= 0) {
      return {
        resources: cleaned,
        removed: removed,
        changed: false
      };
    }

    ["wood", "stone", "iron"].forEach(key => {
      const value = Math.max(0, Math.floor(cleaned[key] || 0));
      if (value > 0 && value < threshold) {
        removed[key] = value;
        cleaned[key] = 0;
      } else {
        cleaned[key] = value;
      }
    });

    return {
      resources: cleaned,
      removed: removed,
      changed: totalResources(removed) > 0
    };
  }

  function hasResourceAtLeast(resources, minAmount) {
    const threshold = Math.max(0, minAmount || 0);
    if (threshold <= 0) return totalResources(resources || emptyResources()) > 0;
    return ["wood", "stone", "iron"].some(key => (resources && resources[key] || 0) >= threshold);
  }

  function getArrivalBalancePriority(target, bucketIndex, planned, remainingNeed, resourceKey) {
    const activeKeys = getActiveResourceKeys(remainingNeed);
    if (activeKeys.length <= 1) return 1;

    const initialNeed = target.initialNeed || remainingNeed || emptyResources();
    const initialTotal = Math.max(1, totalResources(initialNeed));
    const expectedRatio = Math.max(0.05, (initialNeed[resourceKey] || 0) / initialTotal);
    const bucket = getTargetArrivalBucket(target, bucketIndex);
    const currentBucketTotal = totalResources(bucket) + totalResources(planned || emptyResources());
    const currentResourceAmount = (bucket[resourceKey] || 0) + ((planned && planned[resourceKey]) || 0);
    const currentRatio = currentBucketTotal > 0 ? currentResourceAmount / currentBucketTotal : 0;
    const remainingTotal = Math.max(1, totalResources(remainingNeed || emptyResources()));
    const remainingRatio = (remainingNeed[resourceKey] || 0) / remainingTotal;

    return (expectedRatio - currentRatio) * 3 + remainingRatio;
  }

  function getArrivalBalanceCandidateScore(donor, target, bucketIndex, remainingNeed, settings) {
    if (!settings.arrivalBalanceWindowMinutes || settings.arrivalBalanceWindowMinutes <= 0) return 0;

    const activeKeys = getActiveResourceKeys(remainingNeed);
    if (activeKeys.length <= 1) return 0;

    let score = 0;
    activeKeys.forEach(key => {
      const possible = Math.max(0, Math.min(donor.available[key] || 0, remainingNeed[key] || 0));
      if (possible <= 0) return;
      score += Math.min(possible, settings.merchantCapacity * 8) / 1000 * getArrivalBalancePriority(target, bucketIndex, emptyResources(), remainingNeed, key);
    });

    return score;
  }

  function createArrivalBalanceSummary(targetPlan, settings) {
    const activeKeys = getActiveResourceKeys(targetPlan.resources);
    if (activeKeys.length <= 1 || !targetPlan.launches || targetPlan.launches.length <= 1) {
      return "Single-resource/simple arrival";
    }

    const buckets = new Map();
    targetPlan.launches.forEach(launch => {
      const key = String(launch.arrivalBucket || 0);
      if (!buckets.has(key)) buckets.set(key, emptyResources());
      addResources(buckets.get(key), launch.resources || emptyResources());
    });

    let unevenBuckets = 0;
    buckets.forEach(bucket => {
      const bucketTotal = totalResources(bucket);
      if (bucketTotal < settings.minShipment * 2) return;

      const shares = activeKeys.map(key => (bucket[key] || 0) / bucketTotal);
      const maxShare = Math.max.apply(null, shares);
      const missingCount = activeKeys.filter(key => (bucket[key] || 0) <= 0).length;

      if (maxShare >= 0.82 || missingCount >= Math.max(1, activeKeys.length - 1)) {
        unevenBuckets++;
      }
    });

    const windowMinutes = settings.arrivalBalanceWindowMinutes || DEFAULTS.arrivalBalanceWindowMinutes;
    return buckets.size + " arrival window(s), " + (unevenBuckets ? unevenBuckets + " uneven" : "balanced") + " (~" + windowMinutes + "m)";
  }

  function getWarehouseBalanceTarget(village, stats) {
    const capacity = village.capacity || 0;

    return {
      wood: Math.round(capacity * (stats.woodFillRatio || 0)),
      stone: Math.round(capacity * (stats.stoneFillRatio || 0)),
      iron: Math.round(capacity * (stats.ironFillRatio || 0))
    };
  }

  function isFarmBlockedDonor(village, settings) {
    const levels = village.buildingLevels || {};
    const farmLevel = levels.farm || 0;
    const farmMax = village.farmMax || 0;

    if (farmLevel < 30 || farmMax <= 0) {
      return false;
    }

    const freeFarmRatio = Math.max(0, (farmMax - (village.farmUsed || 0)) / farmMax);
    return freeFarmRatio <= (settings.lowFarmFreePercent / 100);
  }

  function getWarehouseReserveRatio(village, settings) {
    const normalReserve = Math.max(0, Math.min(0.8, settings.reserveWarehousePercent / 100));

    if (isFarmBlockedDonor(village, settings)) {
      return Math.min(normalReserve, settings.lowFarmBlockedReservePercent / 100);
    }

    return normalReserve;
  }

  function buildDonors(villages, stats, settings) {
    return villages.map(village => {
      // Only resources currently present in the origin can be requested right now.
      // Incoming resources are counted for target need, but not as requestable donor stock.
      const current = getCurrentResourcesOnly(village);
      const warehouseProtect = Math.round((village.capacity || 0) * getWarehouseReserveRatio(village, settings));

      let ownNeed = emptyResources();
      let balanceProtect = emptyResources();

      if (settings.useAmTemplates && settings.protectDonorConstruction) {
        ownNeed = cloneResources(village.ownNeed || emptyResources());
      }

      if (!settings.useAmTemplates) {
        balanceProtect = getWarehouseBalanceTarget(village, stats);
      }

      const protect = {
        wood: Math.max(warehouseProtect, ownNeed.wood, balanceProtect.wood),
        stone: Math.max(warehouseProtect, ownNeed.stone, balanceProtect.stone),
        iron: Math.max(warehouseProtect, ownNeed.iron, balanceProtect.iron)
      };

      const available = {
        wood: Math.max(0, current.wood - protect.wood),
        stone: Math.max(0, current.stone - protect.stone),
        iron: Math.max(0, current.iron - protect.iron)
      };

      const merchantsAvailable = Math.max(0, (village.merchants || 0) - settings.reserveMerchants);
      const merchantCapacityTotal = merchantsAvailable * settings.merchantCapacity;
      const totalAvailable = Math.min(totalResources(available), merchantCapacityTotal);
      const hasTemplate = Boolean(village.amTemplateName);
      const queueEmpty = (village.queueCount || 0) === 0 && (village.queueEndSeconds || 0) === 0;
      const farmBlocked = isFarmBlockedDonor(village, settings);
      const deadVillage = farmBlocked && !hasTemplate;
      const idleDonor = !hasTemplate || queueEmpty;

      let baseScore = totalAvailable / 1000;
      baseScore += merchantsAvailable * 1.15;

      if (settings.prioritizeNoTemplateDonors && !hasTemplate) {
        baseScore += settings.noTemplateDonorBonus;
      }

      if (farmBlocked) {
        baseScore += settings.farmBlockedDonorBonus;
      }

      if (idleDonor) {
        baseScore += settings.idleDonorBonus;
      }

      if (deadVillage) {
        baseScore += settings.deadVillageDonorBonus;
      }

      return {
        village: village,
        available: available,
        initialAvailable: cloneResources(available),
        protected: protect,
        totalAvailable: totalAvailable,
        initialTotalAvailable: totalAvailable,
        merchantsAvailable: merchantsAvailable,
        initialMerchantsAvailable: merchantsAvailable,
        usedTotal: 0,
        usedTransfers: 0,
        baseScore: baseScore,
        hasTemplate: hasTemplate,
        queueEmpty: queueEmpty,
        farmBlocked: farmBlocked,
        deadVillage: deadVillage,
        idleDonor: idleDonor,
        reason: buildDonorReason(village, totalAvailable, merchantsAvailable, hasTemplate, farmBlocked, deadVillage, settings)
      };
    })
      .filter(donor => donor.totalAvailable >= settings.minShipment && donor.merchantsAvailable > 0)
      .sort((a, b) => b.baseScore - a.baseScore);
  }

  function buildDonorReason(village, totalAvailable, merchantsAvailable, hasTemplate, farmBlocked, deadVillage, settings) {
    const reasons = [];

    reasons.push("available " + formatNumber(totalAvailable));
    reasons.push(merchantsAvailable + " merchant(s)");
    reasons.push("reserve " + settings.reserveWarehousePercent + "% WH");

    if (deadVillage) {
      reasons.push("farm capped + no AM template");
    } else if (farmBlocked) {
      reasons.push("farm capped / low free farm");
    }

    if (!hasTemplate) {
      reasons.push("no AM template");
    }

    return reasons.join(", ");
  }

  function matchDonorsToTargets(targets, donors, settings) {
    const launches = [];
    let launchId = 1;

    targets.forEach(target => {
      const need = cloneResources(target.need);

      if (totalResources(need) < settings.minShipment) return;

      let safety = 0;

      while (totalResources(need) >= settings.minShipment && safety < 200) {
        safety++;

        const usableDonors = donors
          .filter(donor => {
            if (donor.village.coord === target.village.coord) return false;
            if (donor.blockedTargetIds && donor.blockedTargetIds.has(String(target.village.id))) return false;
            if (donor.merchantsAvailable <= 0) return false;
            if (totalResources(donor.available) < settings.minShipment) return false;
            if (!hasResourceAtLeast(donor.available, settings.minResourcePerOrigin)) return false;

            const distance = getDistance(donor.village.coord, target.village.coord);
            if (settings.maxDistance > 0 && distance > settings.maxDistance) return false;

            return true;
          })
          .map(donor => {
            const distance = getDistance(donor.village.coord, target.village.coord);
            const travelMinutes = getTravelMinutes(distance, settings);
            const arrivalBucket = getArrivalBucketIndex(travelMinutes, settings);
            return {
              donor: donor,
              distance: distance,
              travelMinutes: travelMinutes,
              arrivalBucket: arrivalBucket,
              score: getDonorMatchScore(donor, target, distance, settings, need) + getArrivalBalanceCandidateScore(donor, target, arrivalBucket, need, settings)
            };
          })
          .sort((a, b) => sortDonorMatches(a, b, settings));

        if (!usableDonors.length) break;

        const match = usableDonors[0];
        const donor = match.donor;
        const shipment = createShipment(donor, target, need, settings, match);

        if (totalResources(shipment.resources) < settings.minShipment || !hasResourceAtLeast(shipment.resources, settings.minResourcePerOrigin)) {
          if (!donor.blockedTargetIds) donor.blockedTargetIds = new Set();
          donor.blockedTargetIds.add(String(target.village.id));

          if (state.debug && state.debug.skippedSmallShipments) {
            state.debug.skippedSmallShipments.push({
              target: target.village.coord,
              targetId: target.village.id,
              origin: donor.village.coord,
              originId: donor.village.id,
              attempted: cloneResources(shipment.attemptedResources || shipment.resources || emptyResources()),
              keptAfterSmallFragmentFilter: cloneResources(shipment.resources || emptyResources()),
              removedSmallFragments: cloneResources(shipment.removedSmallFragments || emptyResources()),
              minShipment: settings.minShipment,
              minResourcePerOrigin: settings.minResourcePerOrigin
            });
          }

          continue;
        }

        subtractResources(donor.available, shipment.resources);
        subtractResources(need, shipment.resources);
        addResourcesToArrivalBucket(target, match.arrivalBucket, shipment.resources);
        donor.merchantsAvailable = Math.max(0, donor.merchantsAvailable - shipment.merchantsUsed);
        donor.totalAvailable = Math.min(
          totalResources(donor.available),
          donor.merchantsAvailable * settings.merchantCapacity
        );
        donor.usedTotal += totalResources(shipment.resources);
        donor.usedTransfers += 1;

        launches.push({
          id: launchId++,
          origin: donor.village,
          target: target.village,
          resources: shipment.resources,
          total: totalResources(shipment.resources),
          merchantsUsed: shipment.merchantsUsed,
          distance: match.distance,
          travelMinutes: match.travelMinutes,
          arrivalBucket: match.arrivalBucket,
          targetScore: target.score,
          targetOrder: target.planningOrder || 999999,
          targetPriorityTier: target.priorityTier,
          targetQueueCoverage: target.queueCoverage || null,
          donorScore: match.score,
          targetReason: target.reason,
          donorReason: donor.reason
        });
      }
    });

    return launches;
  }


  function buildRelayReplenishmentLaunches(directLaunches, targets, donors, settings, startId) {
    const relayLaunches = [];
    let launchId = Math.max(1, startId || 1);

    const activeTargetIds = new Set((targets || [])
      .filter(target => totalResources(target.need || emptyResources()) > 0)
      .map(target => String(target.village.id)));

    const outgoingByOrigin = new Map();
    (directLaunches || []).forEach(launch => {
      if (!launch || launch.isRelay || !launch.origin || !launch.resources) return;
      const key = String(launch.origin.id);
      const current = outgoingByOrigin.get(key) || {
        village: launch.origin,
        resources: emptyResources(),
        total: 0,
        launches: 0,
        targetNames: [],
        minDirectTravelMinutes: Infinity,
        maxDirectTravelMinutes: 0
      };

      addResources(current.resources, launch.resources);
      current.total += totalResources(launch.resources || emptyResources());
      current.launches += 1;
      if (launch.target && launch.target.name) current.targetNames.push(launch.target.name);
      if (launch.travelMinutes !== undefined) {
        current.minDirectTravelMinutes = Math.min(current.minDirectTravelMinutes, launch.travelMinutes || 0);
        current.maxDirectTravelMinutes = Math.max(current.maxDirectTravelMinutes, launch.travelMinutes || 0);
      }
      outgoingByOrigin.set(key, current);
    });

    const middlemanIds = new Set(Array.from(outgoingByOrigin.keys()));
    const directOriginIds = new Set(Array.from(outgoingByOrigin.keys()));
    const donorById = new Map((donors || []).map(donor => [String(donor.village.id), donor]));
    const relaySafetyBufferMinutes = Math.max(0, settings.relaySafetyBufferMinutes !== undefined ? settings.relaySafetyBufferMinutes : DEFAULTS.relaySafetyBufferMinutes);

    outgoingByOrigin.forEach(outgoing => {
      const middleman = outgoing.village;
      const middlemanId = String(middleman.id);
      const queueSeconds = Math.max(0, middleman.queueEndSeconds || 0);
      const queueHours = queueSeconds / 3600;
      const middlemanHasTemplate = Boolean(middleman.amTemplateName);
      const middlemanQueueEmpty = queueSeconds <= 0;
      const candidateBase = {
        middleman: middleman.coord,
        middlemanId: middleman.id,
        name: middleman.name,
        outgoing: cloneResources(outgoing.resources),
        outgoingTotal: outgoing.total,
        queueHours: queueHours,
        hasAmTemplate: middlemanHasTemplate,
        amTemplateName: middleman.amTemplateName || "",
        targets: outgoing.targetNames.slice(0, 5)
      };

      if (state.debug && state.debug.relayCandidates) {
        state.debug.relayCandidates.push(Object.assign({}, candidateBase));
      }

      if (outgoing.total < settings.minShipment || !hasResourceAtLeast(outgoing.resources, settings.minResourcePerOrigin)) {
        pushRelayRejected(candidateBase, "outgoing below relay minimum");
        return;
      }

      if (activeTargetIds.has(middlemanId)) {
        pushRelayRejected(candidateBase, "middleman is an active resource target");
        return;
      }

      if (middlemanHasTemplate && middlemanQueueEmpty) {
        pushRelayRejected(candidateBase, "middleman has active AM template but no construction queue");
        return;
      }

      const relaySpace = getRelayWarehouseSpaceAfterOutgoing(middleman, outgoing.resources, settings);
      let relayNeed = capResourcesToSpace(outgoing.resources, relaySpace);
      relayNeed = cleanSmallResourceAmounts(relayNeed, settings.minResourcePerOrigin).resources;

      if (totalResources(relayNeed) < settings.minShipment || !hasResourceAtLeast(relayNeed, settings.minResourcePerOrigin)) {
        pushRelayRejected(Object.assign({}, candidateBase, { relaySpace: cloneResources(relaySpace), relayNeed: cloneResources(relayNeed) }), "no safe relay space after outgoing resources");
        return;
      }

      const relayTarget = {
        village: middleman,
        initialNeed: cloneResources(relayNeed),
        arrivalBuckets: new Map()
      };

      let safety = 0;
      while (totalResources(relayNeed) >= settings.minShipment && safety < 80) {
        safety += 1;

        const matches = (donors || [])
          .filter(donor => {
            if (!donor || !donor.village) return false;
            const donorId = String(donor.village.id);
            if (donorId === middlemanId) return false;
            if (middlemanIds.has(donorId)) return false;
            if (activeTargetIds.has(donorId)) return false;
            if (donor.merchantsAvailable <= 0) return false;
            if (totalResources(donor.available || emptyResources()) < settings.minShipment) return false;

            const matching = getMatchingResources(donor.available || emptyResources(), relayNeed);
            if (!hasResourceAtLeast(matching, settings.minResourcePerOrigin)) return false;

            const distance = getDistance(donor.village.coord, middleman.coord);
            if (settings.maxDistance > 0 && distance > settings.maxDistance) return false;

            const travelMinutes = getTravelMinutes(distance, settings);
            if (middlemanHasTemplate && queueSeconds < ((travelMinutes + relaySafetyBufferMinutes) * 60)) return false;

            return true;
          })
          .map(donor => {
            const distance = getDistance(donor.village.coord, middleman.coord);
            const travelMinutes = getTravelMinutes(distance, settings);
            const arrivalBucket = getArrivalBucketIndex(travelMinutes, settings);
            const matching = getMatchingResources(donor.available || emptyResources(), relayNeed);
            const directOriginPenalty = directOriginIds.has(String(donor.village.id)) ? 500 : 0;
            return {
              donor: donor,
              distance: distance,
              travelMinutes: travelMinutes,
              arrivalBucket: arrivalBucket,
              matching: matching,
              score: donor.baseScore - distance * settings.donorDistancePenalty - directOriginPenalty + Math.min(totalResources(matching), settings.merchantCapacity * 10) / 1000
            };
          })
          .sort((a, b) => sortDonorMatches(a, b, settings));

        if (!matches.length) {
          pushRelayRejected(Object.assign({}, candidateBase, { relayNeedRemaining: cloneResources(relayNeed), relaySpace: cloneResources(relaySpace) }), "no eligible relay refill donor with enough queue buffer");
          break;
        }

        const match = matches[0];
        const donor = match.donor;
        const shipment = createShipment(donor, relayTarget, relayNeed, settings, match);

        if (totalResources(shipment.resources) < settings.minShipment || !hasResourceAtLeast(shipment.resources, settings.minResourcePerOrigin)) {
          if (!donor.blockedTargetIds) donor.blockedTargetIds = new Set();
          donor.blockedTargetIds.add("relay:" + middlemanId);
          pushRelayRejected(Object.assign({}, candidateBase, {
            donor: donor.village.coord,
            attempted: cloneResources(shipment.attemptedResources || emptyResources()),
            kept: cloneResources(shipment.resources || emptyResources())
          }), "relay shipment below minimum after small-fragment filter");
          continue;
        }

        subtractResources(donor.available, shipment.resources);
        subtractResources(relayNeed, shipment.resources);
        addResourcesToArrivalBucket(relayTarget, match.arrivalBucket, shipment.resources);
        donor.merchantsAvailable = Math.max(0, donor.merchantsAvailable - shipment.merchantsUsed);
        donor.totalAvailable = Math.min(totalResources(donor.available), donor.merchantsAvailable * settings.merchantCapacity);
        donor.usedTotal += totalResources(shipment.resources);
        donor.usedTransfers += 1;

        const relayReason = middlemanHasTemplate
          ? "Relay refill after this village sent resources onward; queue buffer " + formatTravelMinutes(queueSeconds / 60) + ", refill arrives in ~" + formatTravelMinutes(match.travelMinutes) + " + " + relaySafetyBufferMinutes + "m safety"
          : "Relay refill after this village sent resources onward; middleman has no active AM template, so no queue buffer is required";

        const relayLaunch = {
          id: launchId++,
          origin: donor.village,
          target: middleman,
          resources: shipment.resources,
          total: totalResources(shipment.resources),
          merchantsUsed: shipment.merchantsUsed,
          distance: match.distance,
          travelMinutes: match.travelMinutes,
          arrivalBucket: match.arrivalBucket,
          targetScore: 0,
          targetOrder: 100000 + relayLaunches.length,
          targetPriorityTier: 90,
          targetQueueCoverage: null,
          donorScore: match.score,
          targetReason: relayReason,
          donorReason: donor.reason,
          isRelay: true,
          relayMiddleman: middleman.coord,
          relayOutgoingOffset: cloneResources(outgoing.resources),
          relayOriginalTargets: outgoing.targetNames.slice(0, 8)
        };

        relayLaunches.push(relayLaunch);

        if (state.debug && state.debug.relayAccepted) {
          state.debug.relayAccepted.push({
            middleman: middleman.coord,
            middlemanId: middleman.id,
            origin: donor.village.coord,
            originId: donor.village.id,
            resources: cloneResources(shipment.resources),
            total: relayLaunch.total,
            travelMinutes: Math.round(match.travelMinutes),
            queueHours: Math.round(queueHours * 10) / 10,
            hasAmTemplate: middlemanHasTemplate,
            amTemplateName: middleman.amTemplateName || "",
            safetyBufferMinutes: middlemanHasTemplate ? relaySafetyBufferMinutes : 0,
            remainingRelayNeed: cloneResources(relayNeed)
          });
        }
      }
    });

    return relayLaunches;
  }

  function pushRelayRejected(candidate, reason) {
    if (!state.debug || !state.debug.relayRejected) return;
    state.debug.relayRejected.push(Object.assign({}, candidate || {}, { reason: reason }));
  }

  function getMatchingResources(available, need) {
    return {
      wood: Math.min(Math.max(0, available && available.wood || 0), Math.max(0, need && need.wood || 0)),
      stone: Math.min(Math.max(0, available && available.stone || 0), Math.max(0, need && need.stone || 0)),
      iron: Math.min(Math.max(0, available && available.iron || 0), Math.max(0, need && need.iron || 0))
    };
  }

  function capResourcesToSpace(resources, space) {
    const src = resources || emptyResources();
    const targetSpace = space || emptyResources();
    return {
      wood: Math.max(0, Math.min(src.wood || 0, targetSpace.wood || 0)),
      stone: Math.max(0, Math.min(src.stone || 0, targetSpace.stone || 0)),
      iron: Math.max(0, Math.min(src.iron || 0, targetSpace.iron || 0))
    };
  }

  function getRelayWarehouseSpaceAfterOutgoing(village, outgoingResources, settings) {
    const limit = getTargetWarehouseLimit(village, settings);
    if (limit === null) {
      return {
        wood: Number.MAX_SAFE_INTEGER,
        stone: Number.MAX_SAFE_INTEGER,
        iron: Number.MAX_SAFE_INTEGER
      };
    }

    const current = getCurrentResourcesWithIncoming(village);
    const outgoing = outgoingResources || emptyResources();
    return {
      wood: Math.max(0, limit - Math.max(0, current.wood - (outgoing.wood || 0))),
      stone: Math.max(0, limit - Math.max(0, current.stone - (outgoing.stone || 0))),
      iron: Math.max(0, limit - Math.max(0, current.iron - (outgoing.iron || 0)))
    };
  }

  function groupLaunchesByTarget(launches, settings) {
    const map = new Map();

    launches.forEach(launch => {
      const key = (launch.isRelay ? "relay:" : "direct:") + String(launch.target.id);

      if (!map.has(key)) {
        map.set(key, {
          id: map.size + 1,
          target: launch.target,
          launches: [],
          resources: emptyResources(),
          total: 0,
          merchantsUsed: 0,
          maxDistance: 0,
          targetReason: launch.targetReason,
          targetOrder: launch.targetOrder || 999999,
          targetPriorityTier: launch.targetPriorityTier,
          targetQueueCoverage: launch.targetQueueCoverage || null,
          isRelay: Boolean(launch.isRelay),
          planType: launch.isRelay ? "relay" : "direct",
          relayOutgoingOffset: launch.relayOutgoingOffset ? cloneResources(launch.relayOutgoingOffset) : emptyResources(),
          relayOriginalTargets: launch.relayOriginalTargets ? launch.relayOriginalTargets.slice() : []
        });
      }

      const plan = map.get(key);
      if (launch.isRelay) {
        plan.isRelay = true;
        plan.planType = "relay";
        if (launch.relayOutgoingOffset && totalResources(plan.relayOutgoingOffset || emptyResources()) <= 0) {
          plan.relayOutgoingOffset = cloneResources(launch.relayOutgoingOffset);
        }
        if (launch.relayOriginalTargets && launch.relayOriginalTargets.length && (!plan.relayOriginalTargets || !plan.relayOriginalTargets.length)) {
          plan.relayOriginalTargets = launch.relayOriginalTargets.slice();
        }
      }
      plan.launches.push(launch);
      plan.resources.wood += launch.resources.wood;
      plan.resources.stone += launch.resources.stone;
      plan.resources.iron += launch.resources.iron;
      plan.total += launch.total;
      plan.merchantsUsed += launch.merchantsUsed;
      plan.maxDistance = Math.max(plan.maxDistance, launch.distance);
    });

    const plans = Array.from(map.values());
    plans.forEach(plan => {
      plan.arrivalBalance = createArrivalBalanceSummary(plan, settings || DEFAULTS);
    });

    return plans.sort((a, b) => {
      if (Boolean(a.isRelay) !== Boolean(b.isRelay)) return a.isRelay ? 1 : -1;
      return (a.targetOrder || 999999) - (b.targetOrder || 999999);
    });
  }

  function buildDonorAudit(donors, targets, launches, settings) {
    const usedByCoord = new Map();

    launches.forEach(launch => {
      const coord = launch.origin.coord;
      const current = usedByCoord.get(coord) || {
        total: 0,
        transfers: 0,
        nearestDistance: 9999
      };

      current.total += launch.total;
      current.transfers += 1;
      current.nearestDistance = Math.min(current.nearestDistance, launch.distance);
      usedByCoord.set(coord, current);
    });

    const activeTargets = targets.filter(target => totalResources(target.need) >= settings.minShipment);

    return donors
      .slice()
      .sort((a, b) => b.baseScore - a.baseScore)
      .slice(0, settings.donorAuditLimit)
      .map(donor => {
        const used = usedByCoord.get(donor.village.coord);
        const nearestTargetDistance = activeTargets.length
          ? Math.min.apply(null, activeTargets.map(target => getDistance(donor.village.coord, target.village.coord)))
          : 0;

        return {
          village: donor.village,
          available: donor.initialAvailable || donor.available,
          protected: donor.protected || emptyResources(),
          merchants: donor.initialMerchantsAvailable || donor.merchantsAvailable,
          score: donor.baseScore,
          usedTotal: used ? used.total : 0,
          usedTransfers: used ? used.transfers : 0,
          nearestTargetDistance: nearestTargetDistance === 9999 ? 0 : nearestTargetDistance,
          status: getDonorAuditStatus(donor, activeTargets, used, nearestTargetDistance, settings),
          reason: donor.reason
        };
      });
  }

  function getDonorAuditStatus(donor, activeTargets, used, nearestTargetDistance, settings) {
    if (used && used.total > 0) {
      return "Used: " + formatNumber(used.total) + " in " + used.transfers + " send(s)";
    }

    if (donor.initialTotalAvailable < settings.minShipment || donor.initialMerchantsAvailable <= 0) {
      return "Not used: protected by reserve or no merchants";
    }

    if (!activeTargets.length) {
      return "Not used: no matching target need";
    }

    if (settings.maxDistance > 0 && nearestTargetDistance > settings.maxDistance) {
      return "Not used: excluded by max distance";
    }

    return "Not used: needs filled by higher-score / nearer donors";
  }

  function sortDonorMatches(a, b, settings) {
    if (settings.donorPreference === "smart_balanced") {
      const scoreDiff = b.score - a.score;

      if (Math.abs(scoreDiff) > settings.scoreDistanceTieThreshold) {
        return scoreDiff;
      }

      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }

      return scoreDiff;
    }

    if (settings.donorPreference === "distance_optimized") {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (b.donor.totalAvailable !== a.donor.totalAvailable) return b.donor.totalAvailable - a.donor.totalAvailable;
      return b.score - a.score;
    }

    if (settings.donorPreference === "closest") {
      return a.distance - b.distance;
    }

    if (settings.donorPreference === "highest_surplus") {
      return b.donor.totalAvailable - a.donor.totalAvailable;
    }

    return b.score - a.score;
  }

  function getDonorMatchScore(donor, target, distance, settings, remainingNeed) {
    let score = donor.baseScore;

    score -= distance * settings.donorDistancePenalty;

    if (settings.prioritizeNoTemplateDonors && !donor.hasTemplate) {
      score += Math.round(settings.noTemplateDonorBonus * 0.45);
    }

    if (donor.farmBlocked) {
      score += Math.round(settings.farmBlockedDonorBonus * 0.45);
    }

    if (donor.deadVillage) {
      score += Math.round(settings.deadVillageDonorBonus * 0.45);
    }

    if (target.queueEmpty && donor.village.points > target.village.points) {
      score += 8;
    }

    return score;
  }

  function createShipment(donor, target, need, settings, match) {
    const capacity = Math.max(0, donor.merchantsAvailable * settings.merchantCapacity);
    const desired = emptyResources();
    let capacityLeft = capacity;
    let safety = 0;
    const bucketIndex = match && match.arrivalBucket !== undefined ? match.arrivalBucket : 0;
    const chunkSize = Math.max(1, settings.merchantCapacity || DEFAULTS.merchantCapacity);

    while (capacityLeft > 0 && totalResources(need) > 0 && safety < 1000) {
      safety++;

      const candidates = getActiveResourceKeys(need)
        .filter(key => Math.max(0, (donor.available[key] || 0) - (desired[key] || 0)) > 0)
        .filter(key => Math.max(0, (need[key] || 0) - (desired[key] || 0)) > 0)
        .map(key => ({
          key: key,
          priority: getArrivalBalancePriority(target, bucketIndex, desired, need, key)
        }))
        .sort((a, b) => b.priority - a.priority);

      if (!candidates.length) break;

      const resourceKey = candidates[0].key;
      const availableLeft = Math.max(0, (donor.available[resourceKey] || 0) - (desired[resourceKey] || 0));
      const neededLeft = Math.max(0, (need[resourceKey] || 0) - (desired[resourceKey] || 0));
      const amount = Math.min(chunkSize, capacityLeft, availableLeft, neededLeft);

      if (amount <= 0) break;

      desired[resourceKey] += Math.floor(amount);
      capacityLeft -= amount;
    }

    const attempted = cloneResources(desired);
    const cleaned = cleanSmallResourceAmounts(desired, settings.minResourcePerOrigin);
    const totalDesired = totalResources(cleaned.resources);
    const merchantsUsed = Math.ceil(totalDesired / settings.merchantCapacity);

    if (cleaned.changed && state.debug && state.debug.rejectedTinyResourceFragments) {
      state.debug.rejectedTinyResourceFragments.push({
        target: target.village.coord,
        targetId: target.village.id,
        origin: donor.village.coord,
        originId: donor.village.id,
        attempted: attempted,
        removed: cloneResources(cleaned.removed),
        kept: cloneResources(cleaned.resources),
        minResourcePerOrigin: settings.minResourcePerOrigin
      });
    }

    return {
      resources: cleaned.resources,
      attemptedResources: attempted,
      removedSmallFragments: cleaned.removed,
      merchantsUsed: merchantsUsed
    };
  }

  function buildTargetWarehouseAudit(targetPlans, settings) {
    return (targetPlans || []).map(plan => {
      const target = plan.target;
      const currentWithIncoming = getCurrentResourcesWithIncoming(target);
      const relayOutgoingOffset = plan && plan.isRelay ? cloneResources(plan.relayOutgoingOffset || emptyResources()) : emptyResources();
      const projectedBase = {
        wood: Math.max(0, currentWithIncoming.wood - relayOutgoingOffset.wood),
        stone: Math.max(0, currentWithIncoming.stone - relayOutgoingOffset.stone),
        iron: Math.max(0, currentWithIncoming.iron - relayOutgoingOffset.iron)
      };
      const safeLimit = getTargetWarehouseLimit(target, settings);
      const afterPlanned = {
        wood: projectedBase.wood + (plan.resources.wood || 0),
        stone: projectedBase.stone + (plan.resources.stone || 0),
        iron: projectedBase.iron + (plan.resources.iron || 0)
      };

      const planned = cloneResources(plan.resources || emptyResources());
      const overSafeLimit = safeLimit !== null ? {
        wood: afterPlanned.wood > safeLimit,
        stone: afterPlanned.stone > safeLimit,
        iron: afterPlanned.iron > safeLimit
      } : null;
      const plannedOverSafeLimit = safeLimit !== null ? {
        wood: planned.wood > 0 && afterPlanned.wood > safeLimit,
        stone: planned.stone > 0 && afterPlanned.stone > safeLimit,
        iron: planned.iron > 0 && afterPlanned.iron > safeLimit
      } : null;
      const preExistingOverSafeLimit = safeLimit !== null ? {
        wood: projectedBase.wood > safeLimit,
        stone: projectedBase.stone > safeLimit,
        iron: projectedBase.iron > safeLimit
      } : null;

      return {
        target: target.coord,
        targetId: target.id,
        warehouseCapacity: target.capacity || 0,
        targetSafeLimitPercent: settings.targetWarehouseLimitPercent,
        safeLimit: safeLimit,
        currentPlusIncoming: currentWithIncoming,
        relayOutgoingOffset: relayOutgoingOffset,
        projectedBaseAfterOutgoing: projectedBase,
        planned: planned,
        afterPlanned: afterPlanned,
        overSafeLimit: overSafeLimit,
        plannedOverSafeLimit: plannedOverSafeLimit,
        preExistingOverSafeLimit: preExistingOverSafeLimit,
        total: plan.total,
        origins: plan.launches ? plan.launches.length : 0,
        arrivalBalance: plan.arrivalBalance
      };
    });
  }

  function buildOriginUsagePlanAudit(launches, settings) {
    const map = new Map();

    (launches || []).forEach(launch => {
      const coord = launch.origin.coord;
      const current = map.get(coord) || {
        origin: coord,
        originId: launch.origin.id,
        name: launch.origin.name,
        planned: emptyResources(),
        plannedTotal: 0,
        plannedMerchants: 0,
        transfers: 0,
        originCurrent: getCurrentResourcesOnly(launch.origin),
        originMerchants: launch.origin.merchants || 0
      };

      addResources(current.planned, launch.resources || emptyResources());
      current.plannedTotal += launch.total || totalResources(launch.resources || emptyResources());
      current.plannedMerchants += launch.merchantsUsed || Math.ceil((launch.total || 0) / settings.merchantCapacity);
      current.transfers += 1;
      map.set(coord, current);
    });

    return Array.from(map.values()).map(origin => ({
      origin: origin.origin,
      originId: origin.originId,
      name: origin.name,
      planned: origin.planned,
      plannedTotal: origin.plannedTotal,
      plannedMerchants: origin.plannedMerchants,
      transfers: origin.transfers,
      originCurrent: origin.originCurrent,
      originMerchants: origin.originMerchants,
      overOriginWood: origin.planned.wood > origin.originCurrent.wood,
      overOriginStone: origin.planned.stone > origin.originCurrent.stone,
      overOriginIron: origin.planned.iron > origin.originCurrent.iron,
      overOriginMerchants: origin.plannedMerchants > origin.originMerchants
    }));
  }


  function getTargetUsableDonorDiagnostics(target, donors, settings) {
    const counts = {
      checked: 0,
      sameVillage: 0,
      blockedForTarget: 0,
      noMerchants: 0,
      noAvailableResources: 0,
      noResourceFragmentAtLeastMinimum: 0,
      outsideMaxDistance: 0,
      noMatchingNeededResource: 0,
      usable: 0
    };
    const samples = [];
    const need = target && target.need ? target.need : emptyResources();

    (donors || []).forEach(donor => {
      counts.checked += 1;
      let status = "usable";
      const distance = getDistance(donor.village.coord, target.village.coord);
      const matchingResources = {
        wood: Math.min(Math.max(0, donor.available.wood || 0), Math.max(0, need.wood || 0)),
        stone: Math.min(Math.max(0, donor.available.stone || 0), Math.max(0, need.stone || 0)),
        iron: Math.min(Math.max(0, donor.available.iron || 0), Math.max(0, need.iron || 0))
      };

      if (donor.village.coord === target.village.coord) {
        counts.sameVillage += 1;
        status = "same village";
      } else if (donor.blockedTargetIds && donor.blockedTargetIds.has(String(target.village.id))) {
        counts.blockedForTarget += 1;
        status = "blocked after tiny/failed shipment attempt";
      } else if (donor.merchantsAvailable <= 0) {
        counts.noMerchants += 1;
        status = "no merchants";
      } else if (totalResources(donor.available) < settings.minShipment) {
        counts.noAvailableResources += 1;
        status = "available below minimum shipment";
      } else if (!hasResourceAtLeast(donor.available, settings.minResourcePerOrigin)) {
        counts.noResourceFragmentAtLeastMinimum += 1;
        status = "no resource fragment >= minimum";
      } else if (settings.maxDistance > 0 && distance > settings.maxDistance) {
        counts.outsideMaxDistance += 1;
        status = "outside max distance";
      } else if (!hasResourceAtLeast(matchingResources, settings.minResourcePerOrigin)) {
        counts.noMatchingNeededResource += 1;
        status = "no matching needed resource >= minimum";
      } else {
        counts.usable += 1;
      }

      if ((status === "usable" || samples.length < 12) && samples.length < 20) {
        samples.push({
          origin: donor.village.coord,
          originId: donor.village.id,
          name: donor.village.name,
          distance: Math.round(distance * 10) / 10,
          merchantsAvailable: donor.merchantsAvailable,
          available: cloneResources(donor.available),
          matchingResources: matchingResources,
          status: status
        });
      }
    });

    return {
      counts: counts,
      samples: samples
    };
  }

  function buildUnplannedTargetDiagnostics(planResult, settings) {
    const plannedTargetIds = new Set((planResult.launches || []).map(launch => String(launch.target.id)));
    return (planResult.targets || [])
      .filter(target => totalResources(target.need || emptyResources()) > 0)
      .filter(target => !plannedTargetIds.has(String(target.village.id)))
      .slice(0, 40)
      .map(target => {
        let reason = "not planned";
        const totalNeed = totalResources(target.need || emptyResources());
        const donorDiagnostics = getTargetUsableDonorDiagnostics(target, planResult.donors || [], settings);

        if (totalNeed < settings.minShipment) {
          reason = "target need below minimum shipment";
        } else if (!donorDiagnostics.counts.usable) {
          if (donorDiagnostics.counts.outsideMaxDistance > 0) {
            reason = "no usable donor inside max distance";
          } else if (donorDiagnostics.counts.noMatchingNeededResource > 0) {
            reason = "no donor with matching needed resource above minimum";
          } else if (donorDiagnostics.counts.noMerchants > 0) {
            reason = "donors had no merchants left";
          } else {
            reason = "no usable donor found";
          }
        }

        return {
          coord: target.village.coord,
          targetId: target.village.id,
          name: target.village.name,
          points: target.village.points || 0,
          priorityTier: target.priorityTier,
          queueCount: target.queueCoverage ? target.queueCoverage.currentQueueCount : target.village.queueCount || 0,
          queueHours: target.queueHours,
          totalNeed: totalNeed,
          need: cloneResources(target.need || emptyResources()),
          reason: reason,
          targetReason: target.reason,
          donorDiagnostics: donorDiagnostics
        };
      });
  }

  function logPlanDiagnostics(planResult, settings) {
    const targetWarehouseAudit = buildTargetWarehouseAudit(planResult.targetPlans, settings);
    const originUsageAudit = buildOriginUsagePlanAudit(planResult.launches, settings);
    const overWarehouse = targetWarehouseAudit.filter(row => row.plannedOverSafeLimit && (row.plannedOverSafeLimit.wood || row.plannedOverSafeLimit.stone || row.plannedOverSafeLimit.iron));
    const overOrigins = originUsageAudit.filter(row => row.overOriginWood || row.overOriginStone || row.overOriginIron || row.overOriginMerchants);
    const debug = state.debug || {};

    const diagnostics = {
      version: SCRIPT_VERSION,
      settings: {
        mode: settings.useAmTemplates ? "AM construction" : "Warehouse balance",
        targetWarehouseLimitPercent: settings.targetWarehouseLimitPercent,
        minResourcePerOrigin: settings.minResourcePerOrigin,
        targetQueueCoverageHours: settings.constructionHours,
        targetQueueCoverageBuildings: settings.targetQueueCoverageBuildings,
        minShipment: settings.minShipment,
        maxDistance: settings.maxDistance,
        reserveWarehousePercent: settings.reserveWarehousePercent,
        reserveMerchants: settings.reserveMerchants,
        arrivalBalanceWindowMinutes: settings.arrivalBalanceWindowMinutes,
        merchantMinutesPerField: settings.merchantMinutesPerField,
        prioritizeLowPoints: settings.prioritizeLowPoints,
        enableRelayReplenishment: settings.enableRelayReplenishment !== false,
        relaySafetyBufferMinutes: settings.relaySafetyBufferMinutes,
        dataRequestDelayMs: DEFAULTS.dataRequestDelayMs,
        templateRequestDelayMs: DEFAULTS.templateRequestDelayMs,
        fetchRetryDelayMs: DEFAULTS.fetchRetryDelayMs,
        fetchMaxRetries: DEFAULTS.fetchMaxRetries
      },
      counts: {
        villages: state.villages.length,
        targetsBuilt: planResult.targets ? planResult.targets.length : 0,
        targetPlans: planResult.targetPlans.length,
        launches: planResult.launches.length,
        donors: planResult.donors.length,
        cappedTargets: debug.cappedTargets ? debug.cappedTargets.length : 0,
        skippedSmallShipments: debug.skippedSmallShipments ? debug.skippedSmallShipments.length : 0,
        rejectedTinyResourceFragments: debug.rejectedTinyResourceFragments ? debug.rejectedTinyResourceFragments.length : 0,
        relayCandidates: debug.relayCandidates ? debug.relayCandidates.length : 0,
        relayAccepted: debug.relayAccepted ? debug.relayAccepted.length : 0,
        relayRejected: debug.relayRejected ? debug.relayRejected.length : 0,
        incomingRowsParsed: debug.incomingTransportLoad && debug.incomingTransportLoad.selected ? debug.incomingTransportLoad.selected.rowsParsed : 0,
        queueCoverageTargetHours: settings.constructionHours,
        queueCoverageTargetBuildings: settings.targetQueueCoverageBuildings,
        targetsWithIncoming: debug.incomingTransportLoad && debug.incomingTransportLoad.selected && debug.incomingTransportLoad.selected.byCoord ? debug.incomingTransportLoad.selected.byCoord.length : 0,
        targetsOverSafeWarehouseLimit: overWarehouse.length,
        originsOverAvailableResourcesOrMerchants: overOrigins.length,
        dataLoadSteps: debug.dataLoad ? debug.dataLoad.length : 0,
        amTemplatesLoaded: debug.amTemplateLoad && debug.amTemplateLoad.loadedTemplates ? debug.amTemplateLoad.loadedTemplates.length : 0,
        amTemplatesFailed: debug.amTemplateLoad && debug.amTemplateLoad.failedTemplates ? debug.amTemplateLoad.failedTemplates.length : 0,
        targetExclusions: debug.targetExclusions ? debug.targetExclusions.length : 0
      },
      stats: planResult.stats,
      overWarehouse: overWarehouse,
      overOrigins: overOrigins,
      targetWarehouseAudit: targetWarehouseAudit,
      originUsageAudit: originUsageAudit,
      incomingTransportLoad: debug.incomingTransportLoad || null,
      dataLoad: debug.dataLoad || [],
      amTemplateLoad: debug.amTemplateLoad || null,
      targetPlanningOrder: (planResult.targets || []).slice(0, 40).map(target => ({
        order: target.planningOrder,
        coord: target.village.coord,
        name: target.village.name,
        points: target.village.points || 0,
        priorityTier: target.priorityTier,
        queueCount: target.queueCoverage ? target.queueCoverage.currentQueueCount : target.village.queueCount || 0,
        queueHours: target.queueHours,
        queueCoverage: formatQueueCoverage(target.queueCoverage),
        plannedBuilds: target.queueCoverage ? target.queueCoverage.plannedBuilds : 0,
        totalNeed: target.totalNeed,
        need: cloneResources(target.need || emptyResources()),
        reason: target.reason
      })),
      unplannedTargets: buildUnplannedTargetDiagnostics(planResult, settings),
      targetExclusions: debug.targetExclusions || [],
      relayReplenishment: {
        candidates: debug.relayCandidates || [],
        accepted: debug.relayAccepted || [],
        rejected: debug.relayRejected || []
      },
      cappedTargets: debug.cappedTargets || [],
      skippedSmallShipments: debug.skippedSmallShipments || [],
      rejectedTinyResourceFragments: debug.rejectedTinyResourceFragments || []
    };

    state.lastDiagnostics = diagnostics;

    if (settings.debugConsole) {
      console.groupCollapsed(SCRIPT_NAME + " plan diagnostics " + SCRIPT_VERSION);
      console.log("Summary", diagnostics.counts);
      console.log("Settings", diagnostics.settings);
      console.log("Targets over 90% warehouse safety limit", overWarehouse);
      console.log("Origins over available resources/merchants", overOrigins);
      console.log("Target warehouse audit", targetWarehouseAudit);
      console.log("Origin usage audit", originUsageAudit);
      console.log("Incoming transport load", diagnostics.incomingTransportLoad);
      console.log("Data load steps", diagnostics.dataLoad);
      console.log("AM template load", diagnostics.amTemplateLoad);
      console.log("Target planning order", diagnostics.targetPlanningOrder);
      console.log("Unplanned targets", diagnostics.unplannedTargets);
      console.log("Target exclusions / no-need AM villages", diagnostics.targetExclusions);
      console.log("Relay replenishment", diagnostics.relayReplenishment);
      console.log("Capped targets", diagnostics.cappedTargets);
      console.log("Skipped small shipments", diagnostics.skippedSmallShipments);
      console.log("Rejected tiny resource fragments", diagnostics.rejectedTinyResourceFragments);
      console.log("Full diagnostics", diagnostics);
      console.groupEnd();
    }
  }

  function getFirstEnabledSendButton() {
    if (state.sendLocked) return null;

    return Array.from(document.querySelectorAll(".twrp-send-button"))
      .find(button => !button.disabled);
  }

  function focusFirstSendButton() {
    const nextButton = getFirstEnabledSendButton();

    if (nextButton) {
      nextButton.focus();
      return true;
    }

    return false;
  }

  function removeSentTargetRow(button) {
    const row = button.closest("tr");

    if (row) {
      row.remove();
    }

    if (!focusFirstSendButton()) {
      setStatus("All visible target requests are completed.", "success");
    }
  }

  function releaseSendLockAfterDelay(button) {
    const delayMs = DEFAULTS.sendDelayMs;

    setStatus("Resources requested. Next request is available in " + delayMs + "ms.", "success");

    window.setTimeout(function () {
      removeSentTargetRow(button);
      state.sendLocked = false;
      focusFirstSendButton();
    }, delayMs);
  }

  function installHoldEnterSendHandler() {
    if (state.enterSendHandlerInstalled) return;

    state.enterSendHandlerInstalled = true;

    window.addEventListener("keydown", function (event) {
      const key = event.key || event.code;

      if (key !== "Enter" && event.which !== 13) {
        return;
      }

      const button = getFirstEnabledSendButton();

      if (!button) {
        return;
      }

      event.preventDefault();
      button.click();
    });
  }

  function getCsrfToken() {
    if (typeof window.csrf_token !== "undefined" && window.csrf_token) return window.csrf_token;
    if (typeof game_data !== "undefined" && game_data.csrf) return game_data.csrf;

    const input = document.querySelector('input[name="h"]');
    return input ? input.value : "";
  }

  function responseHasError(response) {
    if (!response) return false;
    return Boolean(response.error || response.errors || response.warning || response.warnings);
  }

  function getResponseMessage(response, fallback) {
    if (!response) return fallback;
    return response.success || response.message || response.error || response.warning || fallback;
  }

  function postMarketAction(options, data) {
    return new Promise((resolve, reject) => {
      try {
        TribalWars.post(
          "market",
          options,
          data,
          response => {
            if (responseHasError(response)) {
              reject(response);
              return;
            }
            resolve(response);
          },
          error => reject(error)
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  function buildCallDataForTargetPlan(targetPlan) {
    const data = {};

    targetPlan.launches.forEach(launch => {
      const woodKey = "resource[" + launch.origin.id + "][wood]";
      const stoneKey = "resource[" + launch.origin.id + "][stone]";
      const ironKey = "resource[" + launch.origin.id + "][iron]";

      data[woodKey] = (data[woodKey] || 0) + Math.max(0, Math.round(launch.resources.wood || 0));
      data[stoneKey] = (data[stoneKey] || 0) + Math.max(0, Math.round(launch.resources.stone || 0));
      data[ironKey] = (data[ironKey] || 0) + Math.max(0, Math.round(launch.resources.iron || 0));
    });

    return data;
  }

  async function requestTargetPlan(targetPlan, button) {
    if (!targetPlan || !targetPlan.target || !targetPlan.launches || !targetPlan.launches.length) return;
    if (!button || button.disabled || state.sendLocked) return;

    state.sendLocked = true;
    button.disabled = true;
    button.textContent = "Requesting...";

    const data = buildCallDataForTargetPlan(targetPlan);
    const options = {
      village: targetPlan.target.id,
      ajaxaction: "call"
    };

    const csrf = getCsrfToken();
    if (csrf) options.h = csrf;

    const debugPayload = Object.assign({}, data);

    if (state.lastSettings && state.lastSettings.debugConsole) console.log(SCRIPT_NAME + " grouped request", {
      target: targetPlan.target.coord,
      targetId: targetPlan.target.id,
      origins: targetPlan.launches.map(launch => ({
        coord: launch.origin.coord,
        id: launch.origin.id,
        resources: Object.assign({}, launch.resources),
        merchantsUsed: launch.merchantsUsed,
        travelMinutes: launch.travelMinutes,
        arrivalBucket: launch.arrivalBucket
      })),
      total: targetPlan.total,
      merchantsUsed: targetPlan.merchantsUsed,
      arrivalBalance: targetPlan.arrivalBalance,
      targetStorageAudit: createTargetPlanStorageAudit(targetPlan, state.lastSettings || getSettings()),
      payload: debugPayload,
      payloadOriginCount: targetPlan.launches.length,
      payloadResourceKeys: Object.keys(debugPayload).length
    });

    try {
      const response = await postMarketAction(options, data);

      if (state.lastSettings && state.lastSettings.debugConsole) console.log(SCRIPT_NAME + " grouped request response", {
        target: targetPlan.target.coord,
        targetId: targetPlan.target.id,
        success: !responseHasError(response),
        message: getResponseMessage(response, "Resources requested."),
        response: response
      });

      if (typeof UI !== "undefined" && UI.SuccessMessage) {
        UI.SuccessMessage(getResponseMessage(response, "Resources requested."), 1500);
      }

      button.textContent = "Requested";
      releaseSendLockAfterDelay(button);
    } catch (error) {
      console.error(SCRIPT_NAME + " request failed:", error);

      if (typeof UI !== "undefined" && UI.ErrorMessage) {
        UI.ErrorMessage(getResponseMessage(error, "Could not request resources."), 2500);
      }

      state.sendLocked = false;
      button.disabled = false;
      button.textContent = "Request";
      focusFirstSendButton();
    }
  }

  function renderResults(planResult) {
    ui.results.innerHTML = "";
    state.sendLocked = false;

    if (!planResult.targetPlans.length) {
      const empty = document.createElement("div");
      empty.className = "twrp-empty";
      empty.innerHTML =
        "<strong>No useful transfers found.</strong><br>" +
        "Try increasing build coverage, lowering origin reserve, or increasing max distance.";
      ui.results.appendChild(empty);
      renderDiagnostics(planResult);
      return;
    }

    renderTargetTable(planResult.targetPlans);
    renderDiagnostics(planResult);
  }

  function renderTargetTable(targetPlans) {
    const title = document.createElement("div");
    title.className = "twrp-section-title";
    title.textContent = "Recommended requests";
    ui.results.appendChild(title);

    const tableWrap = document.createElement("div");
    tableWrap.className = "twrp-table-wrap";

    const table = document.createElement("table");
    table.className = "twrp-table twrp-main-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    ["#", "Target", "Resources", "Origins", "Merch", "Dist", "Action"].forEach(label => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    targetPlans.forEach(targetPlan => {
      const row = document.createElement("tr");

      appendCell(row, String(targetPlan.id));
      appendCell(row, (targetPlan.isRelay ? "Relay refill: " : "") + targetPlan.target.name, "twrp-left twrp-target-name");
      const targetAudit = createTargetPlanStorageAudit(targetPlan, state.lastSettings || getSettings());
      const incomingLine = totalResources(targetAudit.incoming) > 0 ? "\nIncoming: " + formatResources(targetAudit.incoming) : "\nIncoming: -";
      const safeLine = targetAudit.safeLimit === null ? "" : "\nAfter: " + formatResources(targetAudit.afterPlanned) + " / safe " + formatNumber(targetAudit.safeLimit);
      appendCell(row, formatResources(targetPlan.resources) + "\n" + (targetPlan.arrivalBalance || "") + incomingLine + safeLine, "twrp-left twrp-resource-cell");

      const originsCell = document.createElement("td");
      originsCell.className = "twrp-left";

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = targetPlan.launches.length + " origin(s)";
      details.appendChild(summary);

      const originList = document.createElement("div");
      originList.className = "twrp-origin-list";

      targetPlan.launches.forEach(launch => {
        const line = document.createElement("div");
        line.className = "twrp-origin-line";
        line.innerHTML =
          "<strong>" + escapeHtml(launch.origin.name) + "</strong><br>" +
          "<span>" + escapeHtml((launch.isRelay ? "Relay refill: " : "") + formatResources(launch.resources)) + " | " +
          escapeHtml(launch.distance.toFixed(1)) + " fields" +
          (launch.travelMinutes !== undefined ? " | ~" + formatTravelMinutes(launch.travelMinutes) : "") +
          "</span>";
        originList.appendChild(line);
      });

      details.appendChild(originList);
      originsCell.appendChild(details);
      row.appendChild(originsCell);

      appendCell(row, String(targetPlan.merchantsUsed));
      appendCell(row, targetPlan.maxDistance.toFixed(1));

      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn twrp-send-button";
      button.textContent = "Request";
      button.title = targetPlan.targetReason;
      button.addEventListener("click", function () {
        requestTargetPlan(targetPlan, button);
      });
      actionCell.appendChild(button);
      row.appendChild(actionCell);

      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    ui.results.appendChild(tableWrap);

    installHoldEnterSendHandler();
    focusFirstSendButton();

  }

  function renderDiagnostics(planResult) {
    const details = document.createElement("details");
    details.className = "twrp-details";

    const summary = document.createElement("summary");
    summary.textContent = "Audit";
    details.appendChild(summary);

    const incomingTitle = document.createElement("div");
    incomingTitle.className = "twrp-section-title";
    incomingTitle.textContent = "Incoming / target warehouse audit";
    details.appendChild(incomingTitle);

    const settings = state.lastSettings || getSettings();
    details.appendChild(createMiniTable(
      ["Village", "Current", "Incoming", "Planned", "After", "Safe", "Over"],
      (planResult.targetPlans || []).map(plan => {
        const audit = createTargetPlanStorageAudit(plan, settings);
        return [
          plan.target.name,
          formatResources(audit.current),
          formatResources(audit.incoming),
          formatResources(audit.planned),
          formatResources(audit.afterPlanned),
          audit.safeLimit === null ? "unknown" : formatNumber(audit.safeLimit),
          formatAuditOverLabel(audit)
        ];
      })
    ));

    const targetTitle = document.createElement("div");
    targetTitle.className = "twrp-section-title";
    targetTitle.textContent = "Top targets";
    details.appendChild(targetTitle);

    details.appendChild(createMiniTable(
      ["Village", "Need", "Queue", "Points", "Reason"],
      planResult.targets.slice(0, 12).map(target => [
        target.village.name,
        formatResources(target.need),
        target.queueCoverage ? formatQueueCoverage(target.queueCoverage) : target.queueHours.toFixed(1) + "h",
        String(target.village.points || 0),
        target.reason
      ])
    ));

    const relayData = state.lastDiagnostics && state.lastDiagnostics.relayReplenishment ? state.lastDiagnostics.relayReplenishment : null;
    const relayAccepted = relayData && relayData.accepted ? relayData.accepted : [];
    const relayRejected = relayData && relayData.rejected ? relayData.rejected : [];
    const relayRows = [];

    relayAccepted.slice(0, 8).forEach(row => {
      relayRows.push([
        "Accepted",
        row.middleman || row.name || "",
        row.origin || "",
        formatResources(row.resources || emptyResources()),
        (row.queueHours || 0).toFixed ? row.queueHours.toFixed(1) + "h" : String(row.queueHours || ""),
        "refill arrives in ~" + formatTravelMinutes(row.travelMinutes || 0)
      ]);
    });

    relayRejected.slice(0, Math.max(0, 12 - relayRows.length)).forEach(row => {
      relayRows.push([
        "Rejected",
        row.middleman || row.name || "",
        "-",
        formatResources(row.outgoing || emptyResources()),
        (row.queueHours || 0).toFixed ? row.queueHours.toFixed(1) + "h" : String(row.queueHours || ""),
        row.reason || "not eligible"
      ]);
    });

    if (relayRows.length) {
      const relayTitle = document.createElement("div");
      relayTitle.className = "twrp-section-title";
      relayTitle.textContent = "Relay replenishment audit";
      details.appendChild(relayTitle);
      details.appendChild(createMiniTable(
        ["Status", "Middleman", "Refill origin", "Resources/outgoing", "Queue", "Reason"],
        relayRows
      ));
    }

    const donorTitle = document.createElement("div");
    donorTitle.className = "twrp-section-title";
    donorTitle.textContent = "Top donors / why used or skipped";
    details.appendChild(donorTitle);

    details.appendChild(createMiniTable(
      ["Village", "Available", "Protected", "Merch", "Score", "Status"],
      (planResult.donorAudit || []).map(donor => [
        donor.village.name,
        formatResources(donor.available),
        formatResources(donor.protected || emptyResources()),
        String(donor.merchants),
        donor.score.toFixed(1),
        donor.status
      ])
    ));

    ui.results.appendChild(details);
  }

  function createMiniTable(headers, rows) {
    const wrap = document.createElement("div");
    wrap.className = "twrp-table-wrap twrp-mini-wrap";

    const table = document.createElement("table");
    table.className = "twrp-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    headers.forEach(label => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    rows.forEach(rowData => {
      const row = document.createElement("tr");
      rowData.forEach((value, index) => appendCell(row, value, index === 0 || index === rowData.length - 1 ? "twrp-left" : ""));
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);

    return wrap;
  }

  function appendCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text;

    if (className) {
      cell.className = className;
    }

    row.appendChild(cell);
    return cell;
  }

  function formatResources(resources) {
    const parts = [];

    if (resources.wood > 0) parts.push("W " + formatNumber(resources.wood));
    if (resources.stone > 0) parts.push("C " + formatNumber(resources.stone));
    if (resources.iron > 0) parts.push("I " + formatNumber(resources.iron));

    return parts.length ? parts.join(" / ") : "-";
  }

  function formatWarehouseOverResources(over) {
    const parts = [];

    if (over && over.wood) parts.push("wood");
    if (over && over.stone) parts.push("clay");
    if (over && over.iron) parts.push("iron");

    return parts.length ? parts.join(" / ") : "none";
  }

  function formatAuditOverLabel(audit) {
    if (audit.plannedOverSafeLimit && hasAnyWarehouseLimitOverflow(audit.plannedOverSafeLimit)) {
      return "YES";
    }

    if (audit.preExistingOverSafeLimit && hasAnyWarehouseLimitOverflow(audit.preExistingOverSafeLimit)) {
      return "existing: " + formatWarehouseOverResources(audit.preExistingOverSafeLimit);
    }

    return "no";
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Math.round(value || 0));
  }

  function formatTravelMinutes(value) {
    const minutes = Math.max(0, Math.round(value || 0));
    if (minutes < 60) return minutes + "m";

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours + "h" + (rest ? " " + rest + "m" : "");
  }

  function createTargetPlanStorageAudit(targetPlan, settings) {
    const target = targetPlan && targetPlan.target ? targetPlan.target : {};
    const current = getCurrentResourcesOnly(target);
    const incoming = cloneResources(target.incoming || emptyResources());
    const currentPlusIncoming = getCurrentResourcesWithIncoming(target);
    const relayOutgoingOffset = targetPlan && targetPlan.isRelay ? cloneResources(targetPlan.relayOutgoingOffset || emptyResources()) : emptyResources();
    const projectedBaseAfterOutgoing = {
      wood: Math.max(0, currentPlusIncoming.wood - relayOutgoingOffset.wood),
      stone: Math.max(0, currentPlusIncoming.stone - relayOutgoingOffset.stone),
      iron: Math.max(0, currentPlusIncoming.iron - relayOutgoingOffset.iron)
    };
    const planned = cloneResources(targetPlan && targetPlan.resources ? targetPlan.resources : emptyResources());
    const safeLimit = getTargetWarehouseLimit(target, settings || DEFAULTS);
    const afterPlanned = {
      wood: projectedBaseAfterOutgoing.wood + (planned.wood || 0),
      stone: projectedBaseAfterOutgoing.stone + (planned.stone || 0),
      iron: projectedBaseAfterOutgoing.iron + (planned.iron || 0)
    };

    const overSafeLimit = safeLimit !== null ? {
      wood: afterPlanned.wood > safeLimit,
      stone: afterPlanned.stone > safeLimit,
      iron: afterPlanned.iron > safeLimit
    } : null;
    const plannedOverSafeLimit = safeLimit !== null ? {
      wood: planned.wood > 0 && afterPlanned.wood > safeLimit,
      stone: planned.stone > 0 && afterPlanned.stone > safeLimit,
      iron: planned.iron > 0 && afterPlanned.iron > safeLimit
    } : null;
    const preExistingOverSafeLimit = safeLimit !== null ? {
      wood: projectedBaseAfterOutgoing.wood > safeLimit,
      stone: projectedBaseAfterOutgoing.stone > safeLimit,
      iron: projectedBaseAfterOutgoing.iron > safeLimit
    } : null;

    return {
      target: target.coord || "",
      targetId: target.id || "",
      capacity: target.capacity || 0,
      safeLimitPercent: settings && settings.targetWarehouseLimitPercent !== undefined ? settings.targetWarehouseLimitPercent : DEFAULTS.targetWarehouseLimitPercent,
      safeLimit: safeLimit,
      current: current,
      incoming: incoming,
      currentPlusIncoming: currentPlusIncoming,
      relayOutgoingOffset: relayOutgoingOffset,
      projectedBaseAfterOutgoing: projectedBaseAfterOutgoing,
      planned: planned,
      afterPlanned: afterPlanned,
      overSafeLimit: overSafeLimit,
      plannedOverSafeLimit: plannedOverSafeLimit,
      preExistingOverSafeLimit: preExistingOverSafeLimit
    };
  }

  function setStatus(message, type) {
    if (!ui.status) return;

    ui.status.textContent = message || "";
    ui.status.className = "twrp-status";

    if (type) {
      ui.status.classList.add("twrp-status-" + type);
    }
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BOX_ID} {
        position: fixed;
        top: 72px;
        right: 28px;
        width: 980px;
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

      #${BOX_ID} * {
        box-sizing: border-box;
      }

      .twrp-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 11px 13px;
        background: linear-gradient(180deg, #d8b776, #bd8f43);
        border-bottom: 1px solid #8f6a2f;
        cursor: move;
      }

      .twrp-title {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-weight: bold;
        font-size: 15px;
      }

      .twrp-subtitle {
        font-size: 11px;
        font-weight: normal;
        opacity: 0.82;
      }

      .twrp-close {
        width: 24px;
        height: 24px;
        border: 1px solid #7d510f;
        background: #fff4d5;
        color: #2f1b00;
        border-radius: 5px;
        cursor: pointer;
        font-weight: bold;
      }

      .twrp-body {
        padding: 12px;
        max-height: calc(88vh - 48px);
        overflow-y: auto;
      }

      .twrp-quick-help {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }

      .twrp-pill {
        padding: 5px 8px;
        background: #fff7e5;
        border: 1px solid #d0ad6a;
        border-radius: 999px;
        color: #4b3318;
        white-space: nowrap;
      }

      .twrp-panel {
        background: #fff7e5;
        border: 1px solid #d0ad6a;
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 10px;
      }

      .twrp-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 8px;
        align-items: end;
      }

      .twrp-label {
        display: block;
        font-weight: bold;
        margin-bottom: 4px;
        color: #3b2a18;
        white-space: nowrap;
      }

      .twrp-hint {
        font-size: 10px;
        opacity: 0.72;
        margin-top: 3px;
        min-height: 13px;
      }

      .twrp-label-row {
        display: flex;
        align-items: center;
        gap: 5px;
        margin-bottom: 4px;
      }

      .twrp-label-row .twrp-label {
        margin-bottom: 0;
      }

      .twrp-info-button {
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

      .twrp-info-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000000;
        background: rgba(0,0,0,0.22);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }

      .twrp-info-dialog {
        width: min(460px, 94vw);
        background: #fff7e5;
        border: 1px solid #8f6a2f;
        border-radius: 8px;
        box-shadow: 0 12px 35px rgba(0,0,0,0.35);
        color: #2e2112;
      }

      .twrp-info-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 9px 10px;
        background: linear-gradient(180deg, #d8b776, #bd8f43);
        border-bottom: 1px solid #8f6a2f;
        font-weight: bold;
      }

      .twrp-info-content {
        padding: 11px;
        line-height: 1.45;
        white-space: pre-line;
      }

      .twrp-info-close {
        width: 24px;
        height: 24px;
        border: 1px solid #7d510f;
        background: #fff4d5;
        color: #2f1b00;
        border-radius: 5px;
        cursor: pointer;
        font-weight: bold;
      }

      .twrp-select,
      .twrp-input {
        width: 100%;
        padding: 6px;
        border: 1px solid #b99351;
        border-radius: 5px;
        background: #fffdf7;
        color: #2f1b00;
        outline: none;
      }

      .twrp-select:focus,
      .twrp-input:focus {
        border-color: #7d510f;
        box-shadow: 0 0 0 2px rgba(125,81,15,0.16);
      }

      .twrp-check-row {
        display: flex;
        gap: 6px;
        align-items: center;
        min-height: 30px;
        padding: 6px;
        border: 1px solid #b99351;
        border-radius: 5px;
        background: #fffdf7;
      }

      .twrp-toggle-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-start;
        margin-top: 8px;
      }

      .twrp-toggle-row > div {
        width: 216px;
        max-width: 100%;
      }

      .twrp-scriptdata-note {
        margin-top: 8px;
        padding: 7px 8px;
        border: 1px solid #d0ad6a;
        border-radius: 6px;
        background: #fffaf0;
        font-size: 10px;
        line-height: 1.35;
        color: #4b3318;
      }

      .twrp-scriptdata-note code {
        font-family: monospace;
        font-size: 10px;
        background: rgba(255,255,255,0.75);
        border: 1px solid #ead8b3;
        border-radius: 3px;
        padding: 1px 3px;
      }

      .twrp-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }

      .twrp-buttons .btn,
      .twrp-table .btn {
        cursor: pointer;
        border-radius: 5px;
      }

      .twrp-primary {
        font-weight: bold;
      }

      .twrp-status {
        padding: 8px;
        margin: 9px 0;
        border: 1px solid #d0ad6a;
        background: #fff7e5;
        border-radius: 7px;
        line-height: 1.35;
      }

      .twrp-status-success {
        background: #dff0d8;
        border-color: #9bc18e;
      }

      .twrp-status-warn {
        background: #fff4d5;
      }

      .twrp-status-error {
        background: #f2dede;
        border-color: #c99a9a;
      }


      .twrp-empty {
        padding: 12px;
        background: #fff4d5;
        border: 1px solid #d0ad6a;
        border-radius: 8px;
        line-height: 1.45;
      }

      .twrp-section-title {
        margin-top: 12px;
        margin-bottom: 6px;
        font-weight: bold;
        font-size: 13px;
      }

      .twrp-table-wrap {
        max-height: 420px;
        overflow: auto;
        border: 1px solid #d0ad6a;
        border-radius: 8px;
        background: #fff7e5;
      }

      .twrp-mini-wrap {
        max-height: 230px;
        margin-bottom: 8px;
      }

      .twrp-table {
        border-collapse: separate;
        border-spacing: 0;
        width: 100%;
      }

      .twrp-table th {
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

      .twrp-table td {
        border-bottom: 1px solid #e1c999;
        border-right: 1px solid #ead8b3;
        padding: 7px 6px;
        text-align: center;
        background: #fffaf0;
        vertical-align: top;
      }

      .twrp-table tr:nth-child(even) td {
        background: #f4e8cf;
      }

      .twrp-main-table th:nth-child(2),
      .twrp-main-table td:nth-child(2) {
        min-width: 230px;
      }

      .twrp-main-table th:nth-child(3),
      .twrp-main-table td:nth-child(3) {
        min-width: 150px;
      }

      .twrp-left {
        text-align: left !important;
      }

      .twrp-target-name {
        font-weight: bold;
      }

      .twrp-resource-cell {
        font-family: monospace;
        font-size: 12px;
      }

      .twrp-origin-list {
        margin-top: 5px;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }

      .twrp-origin-line {
        padding: 5px;
        background: rgba(255,255,255,0.55);
        border: 1px solid #ead8b3;
        border-radius: 5px;
      }

      .twrp-origin-line span {
        font-size: 11px;
        opacity: 0.85;
      }

      .twrp-small {
        font-size: 11px;
        opacity: 0.78;
        line-height: 1.35;
      }

      .twrp-details {
        margin-top: 10px;
        background: #fff7e5;
        border: 1px solid #d0ad6a;
        border-radius: 8px;
        padding: 8px;
      }

      .twrp-details > summary {
        cursor: pointer;
        font-weight: bold;
      }


      .twrp-footer {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #d0ad6a;
        font-size: 11px;
        opacity: 0.78;
      }

      @media (max-width: 980px) {
        #${BOX_ID} {
          top: 50px;
          left: 5px;
          right: 5px;
          width: auto;
        }

        .twrp-grid {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 560px) {
        .twrp-grid {
          grid-template-columns: 1fr;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function makeDraggable(box, handle) {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("mousedown", function (event) {
      if (event.target.classList.contains("twrp-close")) return;

      isDragging = true;

      const rect = box.getBoundingClientRect();

      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;

      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      box.style.right = "auto";

      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", function (event) {
      if (!isDragging) return;

      box.style.left = event.clientX - offsetX + "px";
      box.style.top = event.clientY - offsetY + "px";
    });

    document.addEventListener("mouseup", function () {
      isDragging = false;
      document.body.style.userSelect = "";
    });
  }

  function closeDialog() {
    const box = document.getElementById(BOX_ID);
    if (box) box.remove();

    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();

    window.twacticsResourceBalancerLoaded = false;
    delete window.twacticsResourceBalancer;

    if (state.lastSettings && state.lastSettings.debugConsole) console.log(SCRIPT_NAME + " closed");
  }

  function showInfoDialog(title, body) {
    const old = document.querySelector(".twrp-info-overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.className = "twrp-info-overlay";

    const dialog = document.createElement("div");
    dialog.className = "twrp-info-dialog";

    const head = document.createElement("div");
    head.className = "twrp-info-head";

    const titleNode = document.createElement("div");
    titleNode.textContent = title;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "twrp-info-close";
    close.textContent = "x";

    const content = document.createElement("div");
    content.className = "twrp-info-content";
    content.textContent = body;

    function removeDialog() {
      overlay.remove();
    }

    close.addEventListener("click", removeDialog);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) removeDialog();
    });

    head.appendChild(titleNode);
    head.appendChild(close);
    dialog.appendChild(head);
    dialog.appendChild(content);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  function addInfoButton(wrap, title, body) {
    const label = wrap.querySelector(".twrp-label");
    if (!label) return;

    let labelRow = label.parentNode && label.parentNode.classList && label.parentNode.classList.contains("twrp-label-row")
      ? label.parentNode
      : null;

    if (!labelRow) {
      labelRow = document.createElement("div");
      labelRow.className = "twrp-label-row";
      wrap.insertBefore(labelRow, label);
      labelRow.appendChild(label);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "twrp-info-button";
    button.textContent = "?";
    button.setAttribute("aria-label", title + " help");
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      showInfoDialog(title, body);
    });

    labelRow.appendChild(button);
  }

  function addHint(wrap, text) {
    const hint = document.createElement("div");
    hint.className = "twrp-hint";
    hint.textContent = text;
    wrap.appendChild(hint);
  }

  function createInput(labelText, value, type) {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.className = "twrp-label";
    label.textContent = labelText;

    const input = document.createElement("input");
    input.className = "twrp-input";
    input.type = type || "number";
    input.value = String(value);

    wrap.appendChild(label);
    wrap.appendChild(input);

    return {
      wrap: wrap,
      input: input
    };
  }

  function createSelect(labelText, options, defaultValue) {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.className = "twrp-label";
    label.textContent = labelText;

    const select = document.createElement("select");
    select.className = "twrp-select";

    options.forEach(optionData => {
      const option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.text;
      select.appendChild(option);
    });

    select.value = defaultValue;

    wrap.appendChild(label);
    wrap.appendChild(select);

    return {
      wrap: wrap,
      select: select
    };
  }

  function createCheckbox(labelText, checked) {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.className = "twrp-label";
    label.textContent = labelText;

    const row = document.createElement("div");
    row.className = "twrp-check-row";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;

    const text = document.createElement("span");
    text.textContent = checked ? "Enabled" : "Disabled";

    input.addEventListener("change", function () {
      text.textContent = input.checked ? "Enabled" : "Disabled";
    });

    row.appendChild(input);
    row.appendChild(text);

    wrap.appendChild(label);
    wrap.appendChild(row);

    return {
      wrap: wrap,
      input: input
    };
  }

  function createDialog() {
    addStyles();

    const old = document.getElementById(BOX_ID);
    if (old) old.remove();

    const box = document.createElement("div");
    box.id = BOX_ID;

    const header = document.createElement("div");
    header.className = "twrp-header";

    const title = document.createElement("div");
    title.className = "twrp-title";
    title.innerHTML =
      "<span>" + escapeHtml(SCRIPT_NAME + " " + SCRIPT_VERSION) + "</span>" +
      "<span class=\"twrp-subtitle\">Resource planning with grouped target requests</span>";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "twrp-close";
    closeButton.textContent = "x";
    closeButton.addEventListener("click", closeDialog);

    header.appendChild(title);
    header.appendChild(closeButton);

    const body = document.createElement("div");
    body.className = "twrp-body";

    const panel = document.createElement("div");
    panel.className = "twrp-panel";

    const grid = document.createElement("div");
    grid.className = "twrp-grid";

    const initialSettings = state.savedSettings || normalizeSettings(DEFAULTS);

    const planMode = createSelect("Plan mode", [
      { value: "am", text: "AM construction" },
      { value: "warehouse", text: "Warehouse balance" }
    ], initialSettings.useAmTemplates ? "am" : "warehouse");
    const constructionHours = createInput("Build coverage", initialSettings.constructionHours);
    const reserveMerchants = createInput("Reserve merchants", initialSettings.reserveMerchants);
    const reserveWarehousePercent = createInput("Origin reserve", initialSettings.reserveWarehousePercent);
    const maxDistance = createInput("Max distance", initialSettings.maxDistance);
    const prioritizeLowPoints = createCheckbox("Low-point priority", initialSettings.prioritizeLowPoints);
    const enableRelayReplenishment = createCheckbox("Relay replenishment", initialSettings.enableRelayReplenishment !== false);

    addHint(planMode.wrap, "AM template or WH %");
    addHint(constructionHours.wrap, "hours");
    addHint(reserveMerchants.wrap, "kept home");
    addHint(reserveWarehousePercent.wrap, "% warehouse");
    addHint(maxDistance.wrap, "0 = any");
    addHint(prioritizeLowPoints.wrap, "lowest points first");
    addHint(enableRelayReplenishment.wrap, "refill used origins");

    addInfoButton(
      prioritizeLowPoints.wrap,
      "Low-point priority",
      "Prioritizes lower-point target villages within the same queue urgency.\n\nExample: if one 800-point village and one 6,000-point village both need resources to reach the 8h build coverage target, the 800-point village is planned first.\n\nIt does not mean higher-point villages are ignored. If resources and donors are still available, the planner continues upward."
    );

    addInfoButton(
      enableRelayReplenishment.wrap,
      "Relay replenishment",
      "After normal target requests, the planner can refill origin villages that just sent resources onward.\n\nExample: Village A sends resources to a target. Village B can send a refill to Village A, so Village A is not drained after helping.\n\nIf Village A has an active AM construction template, it must also have an active queue and the refill must arrive before the queue risks stopping.\n\nIf Village A has no active AM construction template, it may be used as a finished/idle middleman even without a queue. Relay still respects the 90% warehouse cap per resource."
    );

    [
      planMode.wrap,
      constructionHours.wrap,
      reserveMerchants.wrap,
      reserveWarehousePercent.wrap,
      maxDistance.wrap
    ].forEach(node => grid.appendChild(node));

    const toggleRow = document.createElement("div");
    toggleRow.className = "twrp-toggle-row";
    [
      prioritizeLowPoints.wrap,
      enableRelayReplenishment.wrap
    ].forEach(node => toggleRow.appendChild(node));

    panel.appendChild(grid);
    panel.appendChild(toggleRow);

    function updateModeControls() {
      const amMode = planMode.select.value === "am";
      constructionHours.input.disabled = !amMode;
      constructionHours.wrap.style.opacity = amMode ? "1" : "0.55";
    }

    planMode.select.addEventListener("change", updateModeControls);
    updateModeControls();

    const buttons = document.createElement("div");
    buttons.className = "twrp-buttons";

    const planButton = document.createElement("button");
    planButton.type = "button";
    planButton.className = "btn twrp-primary";
    planButton.textContent = "Create plan";
    planButton.addEventListener("click", loadAndPlan);

    buttons.appendChild(planButton);
    panel.appendChild(buttons);

    const scriptDataNote = document.createElement("div");
    scriptDataNote.className = "twrp-scriptdata-note";
    scriptDataNote.innerHTML = "<strong>User data:</strong> Supports <code>TribalWars.scriptData</code>. When enabled in the Script Library, personal settings are loaded as JSON before the script runs. Expected format and options are documented in the script description.";
    panel.appendChild(scriptDataNote);

    const status = document.createElement("div");
    status.className = "twrp-status";
    status.textContent = "Ready. Choose settings and create a plan.";

    const results = document.createElement("div");

    const footer = document.createElement("div");
    footer.className = "twrp-footer";
    footer.textContent = "Created by Twactics (zidrox)";

    body.appendChild(panel);
    body.appendChild(status);
    body.appendChild(results);
    body.appendChild(footer);

    box.appendChild(header);
    box.appendChild(body);
    document.body.appendChild(box);

    ui.planMode = planMode.select;
    ui.constructionHours = constructionHours.input;
    ui.reserveMerchants = reserveMerchants.input;
    ui.reserveWarehousePercent = reserveWarehousePercent.input;
    ui.maxDistance = maxDistance.input;
    ui.prioritizeLowPoints = prioritizeLowPoints.input;
    ui.enableRelayReplenishment = enableRelayReplenishment.input;
    ui.planButton = planButton;
    ui.status = status;
    ui.results = results;

    installSettingsAutoSave();
    persistSettings();

    makeDraggable(box, header);
  }

  createDialog();

  console.log(SCRIPT_NAME + " " + SCRIPT_VERSION + " loaded");
})();
