/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Resource Planner
 *
 * Helps players create a resource transfer plan based on village resources,
 * merchants, building queues, Account Manager construction templates and incoming transports.
 *
 * This script:
 * - Reads production overview data
 * - Reads building overview data
 * - Reads Account Manager construction template data when AM construction mode is selected
 * - Reads incoming transport data
 * - Creates either an AM construction plan or a warehouse-percentage balance plan after a manual user click
 * - Allows one grouped manual send action per target row
 *
 * This script does NOT:
 * - Send attacks, support, or troops
 * - Auto-click game actions
 * - Auto-send all resources
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
  "use strict";

  if (window.twacticsResourcePlannerLoaded) {
    console.log("Twactics Resource Planner already loaded");
    return;
  }

  window.twacticsResourcePlannerLoaded = true;

  const SCRIPT_NAME = "Twactics Resource Planner";
  const SCRIPT_VERSION = "1.5.0";
  const BOX_ID = "twactics-resource-planner";
  const STYLE_ID = "twactics-resource-planner-style";

  const DEFAULTS = {
    useAmTemplates: true,
    constructionHours: 8,
    averageFactor: 0,
    reserveMerchants: 0,
    reserveWarehousePercent: 8,
    lowFarmBlockedReservePercent: 1,
    lowFarmFreePercent: 4,
    merchantCapacity: 1000,
    minShipment: 700,
    maxDistance: 0,
    emptyQueueBoost: 80,
    lowPointsBoost: 35,
    prioritizeLowPoints: true,
    sendDelayMs: 900
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
    logs: []
  };

  const ui = {};

  window.twacticsResourcePlanner = {
    close: closeDialog,
    state: state
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
      if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
        url.searchParams.set(key, String(params[key]));
      }
    });

    if (
      currentGroup &&
      params &&
      (params.screen === "overview_villages" || params.screen === "am_village")
    ) {
      url.searchParams.set("group", currentGroup);
    }

    return url.pathname + url.search;
  }

  async function fetchText(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: "text/html, */*; q=0.01"
      }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status + " while loading " + url);
    }

    return response.text();
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

  function parseCapacity(row) {
    const cells = Array.from(row.children);

    for (let i = 0; i < cells.length; i++) {
      const text = cleanText(cells[i].textContent);
      const numbers = text.match(/\d[\d.]{2,}/g);

      if (numbers && numbers.length === 1) {
        const value = parseNumber(numbers[0]);

        if (value >= 1000 && value <= 1000000) {
          const hasResourceIcon = cells[i].querySelector(".wood, .stone, .iron");
          const hasMarketLink = cells[i].querySelector('a[href*="market"]');

          if (!hasResourceIcon && !hasMarketLink) {
            return value;
          }
        }
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
        capacity: parseCapacity(row),
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

  async function loadIncomingData() {
    const url = buildGameUrl({
      screen: "overview_villages",
      mode: "trader",
      type: "inc",
      page: "-1"
    });

    const html = await fetchText(url);
    const doc = parseHtml(html);
    const rows = Array.from(doc.querySelectorAll("#trades_table tbody tr, #content_value .row_a, #content_value .row_b"));
    const incoming = new Map();

    rows.forEach(row => {
      const resources = extractResourcesFromRow(row);
      const coordMatches = cleanText(row.textContent).match(/\d{1,3}\|\d{1,3}/g) || [];
      const coord = coordMatches[coordMatches.length - 1];

      if (!coord) return;

      if (!incoming.has(coord)) {
        incoming.set(coord, emptyResources());
      }

      const current = incoming.get(coord);
      current.wood += resources.wood;
      current.stone += resources.stone;
      current.iron += resources.iron;
    });

    return incoming;
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
      html = await fetchText(mainUrl);
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
    const templateFetches = [];

    options.forEach(option => {
      const optionName = normalizeTemplateName(option.textContent);
      const templateId = option.value;

      if (!optionName || !templateId) return;

      const matchesAssigned = Array.from(assignedTemplateNames).some(name => {
        return name === optionName || optionName.includes(name) || name.includes(optionName);
      });

      if (!matchesAssigned) return;

      templateFetches.push(loadTemplateDefinition(templateId, optionName));
    });

    const templateDefs = await Promise.all(templateFetches);

    templateDefs.forEach(def => {
      if (!def || !def.name) return;
      result.templateDefsByName.set(def.name, def);

      Array.from(assignedTemplateNames).forEach(assignedName => {
        if (def.name === assignedName || def.name.includes(assignedName) || assignedName.includes(def.name)) {
          result.templateDefsByName.set(assignedName, def);
        }
      });
    });

    return result;
  }

  async function loadTemplateDefinition(templateId, templateName) {
    const url = buildGameUrl({
      screen: "am_village",
      mode: "queue",
      template: templateId
    });

    try {
      const html = await fetchText(url);
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

    if (!template || !template.buildings || !template.buildings.length) {
      return {
        resources: need,
        details: details,
        simulatedQueueHours: village.queueEndSeconds / 3600
      };
    }

    const levels = Object.assign({}, village.buildingLevels || {});
    const horizonSeconds = settings.constructionHours * 3600;
    let queueSeconds = village.queueEndSeconds || 0;
    const hqLevel = levels.main || 1;

    if (levels.farm < 30 && village.farmRatio >= (template.farmCapacityPercent || 99) / 100) {
      const constants = state.buildingConstants.get("farm");
      const nextLevel = (levels.farm || 0) + 1;
      const cost = calculateBuildingCostTime(hqLevel, nextLevel, constants);

      addResources(need, cost);
      details.push({
        building: "farm",
        level: nextLevel,
        reason: "farm capacity",
        resources: cloneResources(cost)
      });

      levels.farm = nextLevel;
      queueSeconds += cost.seconds;
    }

    for (let i = 0; i < template.buildings.length; i++) {
      const templateItem = template.buildings[i];
      const building = templateItem.name;
      const targetLevel = templateItem.levelAbsolute;
      const constants = state.buildingConstants.get(building);

      if (!constants) continue;

      while ((levels[building] || 0) < targetLevel) {
        const nextLevel = (levels[building] || 0) + 1;
        const cost = calculateBuildingCostTime(hqLevel, nextLevel, constants);

        addResources(need, cost);
        details.push({
          building: building,
          level: nextLevel,
          reason: "template",
          resources: cloneResources(cost)
        });

        levels[building] = nextLevel;
        queueSeconds += cost.seconds;

        if (queueSeconds >= horizonSeconds) {
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
    const prioritizeLowPoints = ui.prioritizeLowPoints.checked;

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
      emptyQueueBoost: DEFAULTS.emptyQueueBoost,
      lowPointsBoost: prioritizeLowPoints ? DEFAULTS.lowPointsBoost : 0,
      priorityMode: "construction_first",
      donorPreference: "distance_optimized",
      protectDonorConstruction: useAmTemplates,
      includeAverageBalance: false,
      prioritizeNoTemplateDonors: useAmTemplates,
      prioritizeLowPoints: prioritizeLowPoints
    };
  }

  async function loadAndPlan() {
    try {
      ui.planButton.disabled = true;
      ui.copyButton.disabled = true;

      const settings = getSettings();
      state.lastSettings = settings;

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

      const results = await Promise.all([
        loadProductionData(),
        loadBuildingsData(),
        loadIncomingData(),
        settings.useAmTemplates ? loadAccountManagerData() : Promise.resolve(emptyAmData),
        settings.useAmTemplates ? loadBuildingConstants() : Promise.resolve(new Map())
      ]);

      mergeLoadedData(results[0], results[1], results[2], results[3], results[4], settings);

      const planResult = createTransferPlan(settings);
      state.plan = planResult.targetPlans;
      state.stats = planResult.stats;

      renderResults(planResult);
      ui.copyButton.disabled = !state.plan.length;

      setStatus(
        "Loaded " + state.villages.length + " village(s). Planned " +
          planResult.targetPlans.length + " target send(s) from " +
          planResult.launches.length + " origin transfer(s).",
        "success"
      );
    } catch (err) {
      console.error(SCRIPT_NAME + " failed:", err);
      setStatus(err.message || String(err), "error");
    } finally {
      ui.planButton.disabled = false;
    }
  }

  function createTransferPlan(settings) {
    const villages = state.villages.slice();
    const stats = calculateGlobalStats(villages);
    const targets = buildTargets(villages, stats, settings);
    const donors = buildDonors(villages, stats, settings);
    const launches = matchDonorsToTargets(targets, donors, settings);
    const targetPlans = groupLaunchesByTarget(launches);

    return {
      launches: launches,
      targetPlans: targetPlans,
      targets: targets,
      donors: donors,
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

      if (settings.useAmTemplates) {
        constructionNeed = cloneResources(village.ownNeed || emptyResources());
        need = {
          wood: Math.max(0, constructionNeed.wood - current.wood),
          stone: Math.max(0, constructionNeed.stone - current.stone),
          iron: Math.max(0, constructionNeed.iron - current.iron)
        };

        score = totalResources(need) / 1000;

        if (hasTemplate) {
          score += 10;
        }

        if (hasTemplate && queueEmpty) {
          score += settings.emptyQueueBoost;
        }

        if (hasTemplate) {
          score += queueSoon * 30;
        }

        score += lowPointRatio * settings.lowPointsBoost;

        if (!hasTemplateData && hasTemplate) {
          score *= 0.35;
        }

        if (settings.priorityMode === "construction_first") {
          score += totalResources(constructionNeed) / 700;
        }
      } else {
        warehouseTarget = getWarehouseBalanceTarget(village, stats);
        need = {
          wood: Math.max(0, warehouseTarget.wood - current.wood),
          stone: Math.max(0, warehouseTarget.stone - current.stone),
          iron: Math.max(0, warehouseTarget.iron - current.iron)
        };

        score = totalResources(need) / 1000;
        score += lowPointRatio * settings.lowPointsBoost * 0.35;
      }

      const totalNeed = totalResources(need);

      return {
        village: village,
        need: need,
        constructionNeed: constructionNeed,
        warehouseTarget: warehouseTarget,
        totalNeed: totalNeed,
        score: score,
        hasTemplate: hasTemplate,
        hasTemplateData: hasTemplateData,
        queueEmpty: queueEmpty,
        queueHours: queueHours,
        lowPointRatio: lowPointRatio,
        reason: buildTargetReason(village, totalNeed, hasTemplate, queueEmpty, queueHours, lowPointRatio, settings, warehouseTarget)
      };
    })
      .filter(target => target.totalNeed >= settings.minShipment || (settings.useAmTemplates && target.score > settings.emptyQueueBoost))
      .sort((a, b) => b.score - a.score);
  }

  function buildTargetReason(village, totalNeed, hasTemplate, queueEmpty, queueHours, lowPointRatio, settings, warehouseTarget) {
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

    if (lowPointRatio > 0.5 && settings.prioritizeLowPoints) {
      reasons.push("lower points");
    }

    if (totalNeed > 0) {
      reasons.push("resource deficit " + formatNumber(totalNeed));
    }

    if (!reasons.length) {
      reasons.push(settings.useAmTemplates ? "construction target" : "warehouse balance target");
    }

    return reasons.join(", ");
  }

  function getCurrentResourcesWithIncoming(village) {
    const incoming = village.incoming || emptyResources();

    return {
      wood: village.wood + incoming.wood,
      stone: village.stone + incoming.stone,
      iron: village.iron + incoming.iron
    };
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
      const current = getCurrentResourcesWithIncoming(village);
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

      let baseScore = totalAvailable / 1000;
      baseScore += merchantsAvailable * 1.5;

      if (settings.prioritizeNoTemplateDonors && !hasTemplate) {
        baseScore += 30;
      }

      if (farmBlocked) {
        baseScore += 18;
      }

      if (!hasTemplate || queueEmpty) {
        baseScore += 10;
      }

      return {
        village: village,
        available: available,
        protected: protect,
        totalAvailable: totalAvailable,
        merchantsAvailable: merchantsAvailable,
        baseScore: baseScore,
        hasTemplate: hasTemplate,
        queueEmpty: queueEmpty,
        farmBlocked: farmBlocked,
        reason: buildDonorReason(village, totalAvailable, merchantsAvailable, hasTemplate, farmBlocked, settings)
      };
    })
      .filter(donor => donor.totalAvailable >= settings.minShipment && donor.merchantsAvailable > 0)
      .sort((a, b) => b.baseScore - a.baseScore);
  }

  function buildDonorReason(village, totalAvailable, merchantsAvailable, hasTemplate, farmBlocked, settings) {
    const reasons = [];

    reasons.push("available " + formatNumber(totalAvailable));
    reasons.push(merchantsAvailable + " merchant(s)");
    reasons.push("reserve " + settings.reserveWarehousePercent + "% WH");

    if (farmBlocked) {
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
            if (donor.merchantsAvailable <= 0) return false;
            if (totalResources(donor.available) < settings.minShipment) return false;

            const distance = getDistance(donor.village.coord, target.village.coord);
            if (settings.maxDistance > 0 && distance > settings.maxDistance) return false;

            return true;
          })
          .map(donor => {
            const distance = getDistance(donor.village.coord, target.village.coord);
            return {
              donor: donor,
              distance: distance,
              score: getDonorMatchScore(donor, target, distance, settings)
            };
          })
          .sort((a, b) => {
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
          });

        if (!usableDonors.length) break;

        const match = usableDonors[0];
        const donor = match.donor;
        const shipment = createShipment(donor, target, need, settings);

        if (totalResources(shipment.resources) < settings.minShipment) {
          donor.merchantsAvailable = 0;
          continue;
        }

        subtractResources(donor.available, shipment.resources);
        subtractResources(need, shipment.resources);
        donor.merchantsAvailable = Math.max(0, donor.merchantsAvailable - shipment.merchantsUsed);
        donor.totalAvailable = Math.min(
          totalResources(donor.available),
          donor.merchantsAvailable * settings.merchantCapacity
        );

        launches.push({
          id: launchId++,
          origin: donor.village,
          target: target.village,
          resources: shipment.resources,
          total: totalResources(shipment.resources),
          merchantsUsed: shipment.merchantsUsed,
          distance: match.distance,
          targetScore: target.score,
          donorScore: match.score,
          targetReason: target.reason,
          donorReason: donor.reason
        });
      }
    });

    return launches;
  }

  function groupLaunchesByTarget(launches) {
    const map = new Map();

    launches.forEach(launch => {
      const key = String(launch.target.id);

      if (!map.has(key)) {
        map.set(key, {
          id: map.size + 1,
          target: launch.target,
          launches: [],
          resources: emptyResources(),
          total: 0,
          merchantsUsed: 0,
          maxDistance: 0,
          targetReason: launch.targetReason
        });
      }

      const plan = map.get(key);
      plan.launches.push(launch);
      plan.resources.wood += launch.resources.wood;
      plan.resources.stone += launch.resources.stone;
      plan.resources.iron += launch.resources.iron;
      plan.total += launch.total;
      plan.merchantsUsed += launch.merchantsUsed;
      plan.maxDistance = Math.max(plan.maxDistance, launch.distance);
    });

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }

  function getDonorMatchScore(donor, target, distance, settings) {
    let score = donor.baseScore;

    score -= distance * 5;

    if (settings.prioritizeNoTemplateDonors && !donor.hasTemplate) {
      score += 25;
    }

    if (donor.farmBlocked) {
      score += 12;
    }

    if (target.queueEmpty && donor.village.points > target.village.points) {
      score += 8;
    }

    return score;
  }

  function createShipment(donor, target, need, settings) {
    const capacity = donor.merchantsAvailable * settings.merchantCapacity;
    const desired = {
      wood: Math.max(0, Math.min(donor.available.wood, need.wood)),
      stone: Math.max(0, Math.min(donor.available.stone, need.stone)),
      iron: Math.max(0, Math.min(donor.available.iron, need.iron))
    };

    let totalDesired = totalResources(desired);

    if (totalDesired > capacity && totalDesired > 0) {
      const factor = capacity / totalDesired;
      desired.wood = Math.floor(desired.wood * factor);
      desired.stone = Math.floor(desired.stone * factor);
      desired.iron = Math.floor(desired.iron * factor);
      totalDesired = totalResources(desired);
    }

    const merchantsUsed = Math.ceil(totalDesired / settings.merchantCapacity);

    return {
      resources: desired,
      merchantsUsed: merchantsUsed
    };
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
      setStatus("All visible target sends are completed.", "success");
    }
  }

  function releaseSendLockAfterDelay(button) {
    const delayMs = DEFAULTS.sendDelayMs;

    setStatus("Resources sent. Waiting " + (delayMs / 1000).toFixed(1) + "s before next send is available...", "success");

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

  function sendTargetPlan(targetPlan, button) {
    if (!targetPlan || !targetPlan.target || !targetPlan.launches || !targetPlan.launches.length) return;
    if (!button || button.disabled || state.sendLocked) return;

    state.sendLocked = true;

    const data = {};

    targetPlan.launches.forEach(launch => {
      const woodKey = "resource[" + launch.origin.id + "][wood]";
      const stoneKey = "resource[" + launch.origin.id + "][stone]";
      const ironKey = "resource[" + launch.origin.id + "][iron]";

      data[woodKey] = (data[woodKey] || 0) + launch.resources.wood;
      data[stoneKey] = (data[stoneKey] || 0) + launch.resources.stone;
      data[ironKey] = (data[ironKey] || 0) + launch.resources.iron;
    });

    const options = {
      village: targetPlan.target.id,
      ajaxaction: "call",
      h: window.csrf_token
    };

    button.disabled = true;
    button.textContent = "Sending...";

    try {
      TribalWars.post(
        "market",
        options,
        data,
        response => {
          console.log(SCRIPT_NAME + " grouped send response:", response);
          UI.SuccessMessage(response.success || "Resources sent.", 1500);
          button.textContent = "Sent";
          releaseSendLockAfterDelay(button);
        },
        error => {
          console.error(SCRIPT_NAME + " grouped send failed:", error);
          UI.ErrorMessage("Could not send resources.", 2500);
          state.sendLocked = false;
          button.disabled = false;
          button.textContent = "Send";
          focusFirstSendButton();
        }
      );
    } catch (err) {
      console.error(SCRIPT_NAME + " grouped send failed:", err);
      UI.ErrorMessage("Could not send resources.", 2500);
      state.sendLocked = false;
      button.disabled = false;
      button.textContent = "Send";
      focusFirstSendButton();
    }
  }

  function renderResults(planResult) {
    ui.results.innerHTML = "";
    state.sendLocked = false;

    const settings = state.lastSettings || getSettings();

    const summary = document.createElement("div");
    summary.className = "twrp-summary";
    summary.innerHTML =
      "<strong>Plan summary</strong><br>" +
      "Villages: " + state.villages.length + "<br>" +
      "Target sends: " + planResult.targetPlans.length + "<br>" +
      "Origin transfers: " + planResult.launches.length + "<br>" +
      "Targets considered: " + planResult.targets.length + "<br>" +
      "Donors considered: " + planResult.donors.length + "<br>" +
      "Mode: " + (settings.useAmTemplates ? "AM construction" : "Warehouse balance") + "<br>" +
      "Origin reserve: " + escapeHtml(settings.reserveWarehousePercent) + "% of warehouse" +
      (settings.useAmTemplates ? "<br>Construction horizon: " + escapeHtml(settings.constructionHours) + "h" : "");

    ui.results.appendChild(summary);

    if (!planResult.targetPlans.length) {
      const empty = document.createElement("div");
      empty.className = "twrp-status twrp-status-warn";
      empty.textContent = "No useful transfers found. Try increasing build coverage, lowering reserve %, or increasing max distance.";
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
    title.textContent = "Recommended target sends";
    ui.results.appendChild(title);

    const tableWrap = document.createElement("div");
    tableWrap.className = "twrp-table-wrap";

    const table = document.createElement("table");
    table.className = "twrp-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    ["#", "Target", "Total resources", "Origins", "Merchants", "Max dist", "Why", "Action"].forEach(label => {
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
      appendCell(row, targetPlan.target.name, "twrp-left");
      appendCell(row, formatResources(targetPlan.resources), "twrp-left");

      const originsCell = document.createElement("td");
      originsCell.className = "twrp-left";

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = targetPlan.launches.length + " origin village(s)";
      details.appendChild(summary);

      const originList = document.createElement("div");
      originList.className = "twrp-covered-list";

      targetPlan.launches.forEach(launch => {
        const line = document.createElement("div");
        line.textContent =
          launch.origin.name +
          " | " +
          formatResources(launch.resources) +
          " | " +
          launch.distance.toFixed(1) +
          " fields";
        originList.appendChild(line);
      });

      details.appendChild(originList);
      originsCell.appendChild(details);
      row.appendChild(originsCell);

      appendCell(row, String(targetPlan.merchantsUsed));
      appendCell(row, targetPlan.maxDistance.toFixed(1));

      const reasonCell = document.createElement("td");
      reasonCell.className = "twrp-left twrp-small";
      reasonCell.textContent = targetPlan.targetReason;
      row.appendChild(reasonCell);

      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn twrp-send-button";
      button.textContent = "Send";
      button.addEventListener("click", function () {
        sendTargetPlan(targetPlan, button);
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

    const note = document.createElement("div");
    note.className = "twrp-small";
    note.textContent = "Each Send button sends the grouped request for one target village. The first Send button is focused automatically; holding Enter will continue sending the next visible target row, with a short delay after each successful send.";
    ui.results.appendChild(note);
  }

  function renderDiagnostics(planResult) {
    const details = document.createElement("details");
    details.className = "twrp-details";

    const summary = document.createElement("summary");
    summary.textContent = "Diagnostics: top targets and donors";
    details.appendChild(summary);

    const targetTitle = document.createElement("div");
    targetTitle.className = "twrp-section-title";
    targetTitle.textContent = "Top target villages";
    details.appendChild(targetTitle);

    details.appendChild(createMiniTable(
      ["Village", "Need", "Score", "Queue", "Reason"],
      planResult.targets.slice(0, 20).map(target => [
        target.village.name,
        formatResources(target.need),
        target.score.toFixed(1),
        target.queueHours.toFixed(1) + "h",
        target.reason
      ])
    ));

    const donorTitle = document.createElement("div");
    donorTitle.className = "twrp-section-title";
    donorTitle.textContent = "Top donor villages";
    details.appendChild(donorTitle);

    details.appendChild(createMiniTable(
      ["Village", "Available", "Protected", "Merchants", "Score", "Reason"],
      planResult.donors.slice(0, 20).map(donor => [
        donor.village.name,
        formatResources(donor.available),
        formatResources(donor.protected || emptyResources()),
        String(donor.merchantsAvailable),
        donor.baseScore.toFixed(1),
        donor.reason
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

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Math.round(value || 0));
  }

  function copyPlan() {
    if (!state.plan.length) {
      setStatus("No plan to copy.", "warn");
      return;
    }

    const lines = [];
    const settings = state.lastSettings || getSettings();

    lines.push(SCRIPT_NAME + " " + SCRIPT_VERSION);
    lines.push("Mode: " + (settings.useAmTemplates ? "AM construction" : "Warehouse balance"));
    lines.push("Origin reserve: " + settings.reserveWarehousePercent + "% of warehouse");
    lines.push("");

    state.plan.forEach(targetPlan => {
      lines.push(
        targetPlan.id + ". " +
        "Target: " + targetPlan.target.name +
        " | " + formatResources(targetPlan.resources) +
        " | origins: " + targetPlan.launches.length +
        " | merchants: " + targetPlan.merchantsUsed +
        " | max distance: " + targetPlan.maxDistance.toFixed(1)
      );
      lines.push("   Reason: " + targetPlan.targetReason);

      targetPlan.launches.forEach(launch => {
        lines.push(
          "   - " + launch.origin.name +
          " -> " + formatResources(launch.resources) +
          " | distance: " + launch.distance.toFixed(1)
        );
      });

      lines.push("");
    });

    const text = lines.join("\n");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => setStatus("Plan copied.", "success"))
        .catch(() => fallbackCopy(text));
      return;
    }

    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";

    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand("copy");
    textarea.remove();

    setStatus(copied ? "Plan copied." : "Could not copy plan.", copied ? "success" : "error");
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
        top: 90px;
        right: 35px;
        width: 1080px;
        max-width: 96vw;
        max-height: 86vh;
        z-index: 999999;
        border: 2px solid #7d510f;
        border-radius: 6px;
        background: #f4e4bc;
        box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        color: #2f1b00;
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
        padding: 9px 11px;
        background: #cfa95e;
        border-bottom: 1px solid #7d510f;
        cursor: move;
      }

      .twrp-title {
        font-weight: bold;
        font-size: 15px;
      }

      .twrp-close {
        width: 20px;
        height: 20px;
        border: 1px solid #7d510f;
        background: #f4e4bc;
        color: #2f1b00;
        border-radius: 3px;
        cursor: pointer;
        font-weight: bold;
      }

      .twrp-body {
        padding: 10px;
        max-height: calc(86vh - 42px);
        overflow-y: auto;
      }

      .twrp-help {
        line-height: 1.35;
        margin-bottom: 8px;
      }

      .twrp-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 8px;
      }

      .twrp-label {
        display: block;
        font-weight: bold;
        margin-bottom: 4px;
      }

      .twrp-select,
      .twrp-input {
        width: 100%;
        padding: 5px;
        border: 1px solid #7d510f;
        border-radius: 4px;
        background: #fffaf0;
        color: #2f1b00;
      }

      .twrp-check-row {
        display: flex;
        gap: 6px;
        align-items: center;
        min-height: 27px;
      }

      .twrp-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0;
      }

      .twrp-buttons .btn,
      .twrp-table .btn {
        cursor: pointer;
      }

      .twrp-status {
        padding: 6px;
        margin: 8px 0;
        border: 1px solid #bd9c5a;
        background: #fff4d5;
        border-radius: 4px;
      }

      .twrp-status-success {
        background: #dff0d8;
      }

      .twrp-status-warn {
        background: #fff4d5;
      }

      .twrp-status-error {
        background: #f2dede;
      }

      .twrp-summary {
        padding: 7px;
        margin: 8px 0;
        background: #fff4d5;
        border: 1px solid #bd9c5a;
        border-radius: 4px;
        line-height: 1.45;
      }

      .twrp-section-title {
        margin-top: 12px;
        margin-bottom: 5px;
        font-weight: bold;
        font-size: 13px;
      }

      .twrp-table-wrap {
        max-height: 430px;
        overflow: auto;
        border: 1px solid #bd9c5a;
      }

      .twrp-mini-wrap {
        max-height: 250px;
        margin-bottom: 8px;
      }

      .twrp-table {
        border-collapse: collapse;
        width: 100%;
      }

      .twrp-table th {
        background: #cfa95e;
        border: 1px solid #bd9c5a;
        padding: 5px;
        text-align: center;
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .twrp-table td {
        border: 1px solid #bd9c5a;
        padding: 5px;
        text-align: center;
        background: #fff5da;
        vertical-align: top;
      }

      .twrp-table tr:nth-child(even) td {
        background: #f0e2be;
      }

      .twrp-left {
        text-align: left !important;
      }

      .twrp-small {
        font-size: 11px;
        opacity: 0.78;
        line-height: 1.35;
      }

      .twrp-details {
        margin-top: 10px;
      }

      .twrp-footer {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #bd9c5a;
        font-size: 11px;
        opacity: 0.8;
      }

      @media (max-width: 900px) {
        #${BOX_ID} {
          top: 50px;
          left: 5px;
          right: 5px;
          width: auto;
        }

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

    window.twacticsResourcePlannerLoaded = false;
    delete window.twacticsResourcePlanner;

    console.log(SCRIPT_NAME + " closed");
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
    title.textContent = SCRIPT_NAME + " " + SCRIPT_VERSION;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "twrp-close";
    closeButton.textContent = "x";
    closeButton.addEventListener("click", closeDialog);

    header.appendChild(title);
    header.appendChild(closeButton);

    const body = document.createElement("div");
    body.className = "twrp-body";

    const help = document.createElement("div");
    help.className = "twrp-help";
    help.textContent = "Creates a resource plan with one grouped Send button per target village. AM construction mode sends only the calculated construction deficit within the selected build coverage. Warehouse balance mode ignores AM templates and balances resource fill percentage by warehouse size. Origin reserve keeps the selected warehouse percentage at donor villages; farm-30 villages with almost no free farm use a much smaller reserve.";

    const grid = document.createElement("div");
    grid.className = "twrp-grid twrp-grid-simple";

    const planMode = createSelect("Plan mode", [
      { value: "am", text: "AM construction" },
      { value: "warehouse", text: "Warehouse balance" }
    ], DEFAULTS.useAmTemplates ? "am" : "warehouse");
    const constructionHours = createInput("Build coverage [hours]", DEFAULTS.constructionHours);
    const reserveMerchants = createInput("Reserve merchants", DEFAULTS.reserveMerchants);
    const reserveWarehousePercent = createInput("Origin reserve [% WH]", DEFAULTS.reserveWarehousePercent);
    const maxDistance = createInput("Max distance [0 = any]", DEFAULTS.maxDistance);
    const prioritizeLowPoints = createCheckbox("Prioritize low-point villages", DEFAULTS.prioritizeLowPoints);

    [
      planMode.wrap,
      constructionHours.wrap,
      reserveMerchants.wrap,
      reserveWarehousePercent.wrap,
      maxDistance.wrap,
      prioritizeLowPoints.wrap
    ].forEach(node => grid.appendChild(node));

    function updateModeControls() {
      const amMode = planMode.select.value === "am";
      constructionHours.input.disabled = !amMode;
    }

    planMode.select.addEventListener("change", updateModeControls);
    updateModeControls();

    const buttons = document.createElement("div");
    buttons.className = "twrp-buttons";

    const planButton = document.createElement("button");
    planButton.type = "button";
    planButton.className = "btn";
    planButton.textContent = "Load data + create plan";
    planButton.addEventListener("click", loadAndPlan);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "btn";
    copyButton.textContent = "Copy plan";
    copyButton.disabled = true;
    copyButton.addEventListener("click", copyPlan);

    buttons.appendChild(planButton);
    buttons.appendChild(copyButton);

    const status = document.createElement("div");
    status.className = "twrp-status";
    status.textContent = "Ready. Choose settings and click Load data + create plan.";

    const results = document.createElement("div");

    const footer = document.createElement("div");
    footer.className = "twrp-footer";
    footer.textContent = "Created by Twactics";

    body.appendChild(help);
    body.appendChild(grid);
    body.appendChild(buttons);
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
    ui.planButton = planButton;
    ui.copyButton = copyButton;
    ui.status = status;
    ui.results = results;

    makeDraggable(box, header);
  }

  createDialog();

  console.log(SCRIPT_NAME + " " + SCRIPT_VERSION + " loaded");
})();
