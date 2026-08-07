/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Relic Planner
 *
 * Helps players evaluate relic placement plans using visible/loaded village data,
 * relic inventory data and current relic overview data.
 *
 * This script:
 * - Reads village coordinates from Overview pages
 * - Reads farm data from Overview -> Production when needed for recruitment
 * - Reads relic data from Treasury -> Inventory
 * - Reads placed relics from Treasury -> Overview
 * - Calculates suggested relic placements after a manual user click
 *
 * This script does NOT:
 * - Send attacks, support, or troops
 * - Auto-click game actions
 * - Equip, remove, upgrade, trade, or reroll relics
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

  if (window.twacticsRelicPlannerV2Loaded) {
    console.log("Twactics Relic Planner v2 already loaded");
    return;
  }

  window.twacticsRelicPlannerV2Loaded = true;

  const SCRIPT_NAME = "Twactics Relic Planner";
  const SCRIPT_VERSION = "v1.1.3";
  const BOX_ID = "twactics-relic-planner-v2";
  const STYLE_ID = "twactics-relic-planner-v2-style";
  const DEFAULT_BENEFIT_CAP = 20;

  const QUALITY_RANGE_LABELS = {
    2: "Shoddy / Sturdy",
    3: "Enhanced / Superior",
    4: "Renowned"
  };

  const OFFENSE_WEIGHTS = {
    axe_attack: 1.0,
    axe_offdef: 1.0,
    light_attack: 1.0,
    light_offdef: 1.0,
    ram_attack: 0.45,
    ram_offdef: 0.45,
    ram_damage: 0.45,
    marcher_attack: 0.35,
    marcher_offdef: 0.35,
    heavy_attack: 0.15,
    heavy_offdef: 0.15,
    catapult_attack: 0.10,
    catapult_offdef: 0.10,
    catapult_damage: 0.10
  };

  const RECRUITMENT_WEIGHTS = {
    barracks_speed: 1.0,
    stable_speed: 1.0,
    barracks_cost: 0.45,
    stable_cost: 0.45,
    workshop_speed: 0.35,
    workshop_cost: 0.25,
    academy_speed: 0.10
  };

  const RELEVANT_INTERNAL_STAT_KEYS = {
    barracks_speed: true,
    stable_speed: true,
    workshop_speed: true,
    academy_speed: true,
    barracks_cost: true,
    stable_cost: true,
    workshop_cost: true,
    spear_attack: true,
    spear_offdef: true,
    sword_attack: true,
    sword_offdef: true,
    axe_attack: true,
    axe_offdef: true,
    archer_attack: true,
    archer_offdef: true,
    light_attack: true,
    light_offdef: true,
    marcher_attack: true,
    marcher_offdef: true,
    heavy_attack: true,
    heavy_offdef: true,
    ram_attack: true,
    ram_offdef: true,
    ram_damage: true,
    catapult_attack: true,
    catapult_offdef: true,
    catapult_damage: true
  };

  const INTERNAL_STAT_LABELS = {
    barracks_speed: "Barracks speed",
    stable_speed: "Stable speed",
    workshop_speed: "Workshop speed",
    academy_speed: "Academy speed",
    barracks_cost: "Barracks cost reduction",
    stable_cost: "Stable cost reduction",
    workshop_cost: "Workshop cost reduction",
    spear_attack: "Spear fighter attack",
    spear_offdef: "Spear fighter off/def",
    sword_attack: "Swordsman attack",
    sword_offdef: "Swordsman off/def",
    axe_attack: "Axeman attack",
    axe_offdef: "Axeman off/def",
    archer_attack: "Archer attack",
    archer_offdef: "Archer off/def",
    light_attack: "Light cavalry attack",
    light_offdef: "Light cavalry off/def",
    marcher_attack: "Mounted archer attack",
    marcher_offdef: "Mounted archer off/def",
    heavy_attack: "Heavy cavalry attack",
    heavy_offdef: "Heavy cavalry off/def",
    ram_attack: "Ram attack",
    ram_offdef: "Ram off/def",
    ram_damage: "Ram building damage",
    catapult_attack: "Catapult attack",
    catapult_offdef: "Catapult off/def",
    catapult_damage: "Catapult building damage"
  };

  const RELIC_TYPE_UNIT_KEYS = {
    halberd: "spear",
    longsword: "sword",
    greataxe: "axe",
    shortspear: "light",
    longbow: "archer",
    shortbow: "marcher",
    banner: "heavy",
    morningstar: "ram",
    bonfire: "catapult"
  };

  const MAIN_RELIC_STAT_KEYS = {
    halberd: { b_unitstat: "spear_offdef" },
    longsword: { b_unitstat: "sword_offdef" },
    greataxe: { b_unitstat: "axe_offdef" },
    shortspear: { b_unitstat: "light_offdef" },
    longbow: { b_unitstat: "archer_offdef" },
    shortbow: { b_unitstat: "marcher_offdef" },
    banner: { b_unitstat: "heavy_offdef" },
    morningstar: { b_unitstat: "ram_damage" },
    bonfire: { b_unitstat: "catapult_damage" },
    dummy: { b_recruitment_building: "barracks_speed" },
    horseshoe: { b_recruitment_building: "stable_speed" },
    wheel: { b_recruitment_building: "workshop_speed" },
    handsaw: { b_recruitment_cost: "workshop_cost" }
  };

  const SUB_STAT_KEYS_BY_ID = {
    1: "spear_offdef",
    2: "sword_offdef",
    3: "axe_offdef",
    4: "archer_offdef",
    5: "light_offdef",
    6: "marcher_offdef",
    7: "heavy_offdef",
    8: "catapult_damage",
    9: "ram_damage",
    10: "barracks_speed",
    11: "stable_speed",
    12: "workshop_speed",
    19: "barracks_cost",
    20: "stable_cost",
    21: "workshop_cost",
    22: "spear_attack",
    23: "sword_attack",
    24: "axe_attack",
    25: "archer_attack",
    26: "marcher_attack",
    27: "light_attack",
    28: "heavy_attack",
    29: "catapult_attack",
    30: "ram_attack",
    31: "spear_defense",
    32: "sword_defense",
    33: "axe_defense",
    34: "archer_defense",
    35: "light_defense",
    36: "marcher_defense",
    37: "heavy_defense",
    38: "catapult_defense",
    39: "ram_defense",
    43: "academy_speed"
  };

  const UNIT_ALIASES = {
    spear: ["spear fighter", "spear", "spearman", "pikinier", "piquier", "lancero", "lanceiro", "lanciere", "lancier", "lancnik", "kopjas", "kopjanik", "spyd", "spjut", "speervechter", "pikeman", "bộ binh giáo", "mızrak", "mızrakçı", "pikás", "lándzsás", "槍", "копей", "спис", "пик"],
    sword: ["swordsman", "sword", "epee", "sabre", "espadachin", "espadachim", "espadassin", "szermierz", "swords", "svaerd", "svärd", "zwaard", "šermiar", "kard", "espada", "miecz", "меч"],
    axe: ["axeman", "axe", "bárdos", "bardos", "baltas", "topór", "topor", "hache", "hacha", "machado", "axt", "bijl", "secur", "balta", "sjekira", "sekera", "кирка", "топор"],
    archer: ["archer", "bowman", "íjász", "ijasz", "bogenschutze", "bogenschütze", "archer", "arquero", "arqueiro", "arcier", "łucznik", "lucznik", "boogschutter", "bågskytt", "bueskytte", "стрелец", "лучник"],
    light: ["light cavalry", "light", "könnyűlovas", "konnyulovas", "leichte kavallerie", "cavalerie legere", "cavalerie légère", "caballeria ligera", "cavalaria leve", "lekka kawaleria", "lichte cavalerie", "lätt kavalleri", "let kavalerie", "kavalérie", "hafif süvari", "легкая кавалерия", "лёгкая кавалерия"],
    marcher: ["mounted archer", "horse archer", "lovas íjász", "lovas ijasz", "berittener bogenschutze", "berittener bogenschütze", "archer monte", "archer monté", "arquero a caballo", "arqueiro montado", "łucznik konny", "lucznik konny", "bereden boogschutter", "beriden bågskytt", "atli okcu", "atlı okçu", "конный лучник"],
    heavy: ["heavy cavalry", "heavy", "nehézlovas", "nehezlovas", "schwere kavallerie", "cavalerie lourde", "caballeria pesada", "cavalaria pesada", "ciezka kawaleria", "ciężka kawaleria", "zware cavalerie", "tungt kavalleri", "tung kavalerie", "agir suvari", "ağır süvari", "тяжелая кавалерия", "тяжёлая кавалерия"],
    ram: ["ram", "battering ram", "faltörő kos", "faltoro kos", "rammbock", "belier", "bélier", "ariete", "aríete", "ariete", "taran", "stormram", "murbräcka", "koçbaşı", "таран"],
    catapult: ["catapult", "katapult", "catapulta", "catapulte", "katapulta", "mancınık", "mancinik", "катапульта"],
    spy: ["scout", "spy", "felderito", "felderítő", "espion", "explorador", "scout", "zwiadowca", "verkenner", "spion", "kaşif", "kashif", "разведчик", "шпион"]
  };

  const BUILDING_ALIASES = {
    barracks: ["barracks", "barakk", "caserne", "cuartel", "quartel", "caserma", "koszary", "kaserne", "kazárna", "kazaro", "kasarna", "barak", "kışla", "kisla", "казарма"],
    stable: ["stable", "istálló", "istallo", "ecurie", "écurie", "establo", "estabulo", "estábulo", "scuderia", "stajnia", "stal", "stall", "stalla", "ahır", "ahir", "конюшня"],
    workshop: ["workshop", "műhely", "muhely", "atelier", "taller", "oficina", "officina", "warsztat", "werkplaats", "verkstad", "værksted", "dielna", "radionica", "atölye", "atolye", "мастерская"],
    academy: ["academy", "akadémia", "akademia", "academie", "académie", "academia", "accademia", "akademie", "akademi", "академия"]
  };

  const STAT_ACTION_ALIASES = {
    speed: ["recruit speed", "training speed", "toborzasi sebesseg", "toborzási sebesség", "vitesse de recrutement", "velocidad de reclutamiento", "velocidade de recrutamento", "velocita di reclutamento", "rekrutierungsgeschwindigkeit", "rekrutierungs", "szybkosc rekrutacji", "szybkość rekrutacji", "rekruteringssnelheid", "rekryteringshastighet", "tabor hızı", "tabor hizi", "скорость найма", "швидкість найму"],
    cost: ["recruit costs", "recruit cost", "toborzasi koltseg", "toborzási költség", "cout de recrutement", "coût de recrutement", "coste de reclutamiento", "custo de recrutamento", "costo di reclutamento", "rekrutierungskosten", "koszt rekrutacji", "rekruteringskostnad", "kosten rekrutering", "tabor maliyeti", "стоимость найма", "вартість найму"],
    offdef: ["offense and defense power", "offence and defence power", "offense/defense", "offence/defence", "attack and defense", "attack and defence", "tamadas es vedelem", "támadás és védelem", "attaque et defense", "attaque et défense", "ataque y defensa", "ataque e defesa", "attacco e difesa", "angriff und verteidigung", "atak i obrona", "aanval en verdediging", "anfall och forsvar", "anfall och försvar", "saldiri ve savunma", "saldırı ve savunma", "атака и защита"],
    attack: ["attack power", "offense power", "offence power", "tamadoero", "támadóerő", "tamadas", "támadás", "attaque", "ataque", "attacco", "angriff", "atak", "aanval", "anfall", "saldiri", "saldırı", "атака"],
    defense: ["defense power", "defence power", "vedelem", "védelmi", "defense", "defense", "défense", "defensa", "defesa", "difesa", "verteidigung", "obrona", "verdediging", "forsvar", "försvar", "savunma", "защита", "оборона"],
    damage: ["damage against buildings", "building damage", "epuletsebzes", "épületsebzés", "degats contre les batiments", "dégâts contre les bâtiments", "dano contra edificios", "dano contra edificios", "danni agli edifici", "gebaedeschaden", "gebäudeschaden", "obrazenia budynkow", "obrażenia budynków", "schade aan gebouwen", "byggnadsskada", "bina hasari", "bina hasarı", "урон по зданиям"]
  };


  const state = {
		villages: [],
		villagesById: new Map(),
		villagesByCoord: new Map(),
		inventoryRelics: [],
		placedRelics: [],
		plan: [],
		unlockedRelicSlots: 10,
    worldRelicSettings: {
      benefitCap: DEFAULT_BENEFIT_CAP,
      benefitCapSource: "fallback",
      detectedRanges: []
    },
		logs: []
	};

  const ui = {};

  window.twacticsRelicPlannerV2 = {
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
    return isNaN(parsed) ? 0 : parsed;
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

	  if (currentGroup && params && params.screen === "overview_villages") {
		url.searchParams.set("group", currentGroup);
	  }

	  Object.keys(params || {}).forEach(key => {
		if (params[key] !== undefined && params[key] !== null) {
		  url.searchParams.set(key, String(params[key]));
		}
	  });

	  return url.pathname + url.search;
	}
	
	function getVillageDataUrl(goal) {
	  if (goal === "offense") {
		return buildGameUrl({
		  screen: "overview_villages",
		  mode: "combined",
		  page: -1
		});
	  }

	  return buildGameUrl({
		screen: "overview_villages",
		mode: "prod",
		page: -1
	  });
	}

  function getRelicOffsets(range) {
    const radius = Math.max(0, parseInt(range || 0, 10));
    const offsets = [];

    if (!radius) return offsets;

    for (let dy = -radius; dy <= radius; dy++) {
      const halfWidth = Math.floor(Math.sqrt(Math.max(0, radius * radius - dy * dy)));

      for (let dx = -halfWidth; dx <= halfWidth; dx++) {
        offsets.push({ dx: dx, dy: dy });
      }
    }

    return offsets;
  }

  function getRelicMaxTiles(range) {
    return getRelicOffsets(range).length;
  }

  function getRelicRangeLabel(range) {
    const parsed = Math.max(0, parseInt(range || 0, 10));
    const tiles = getRelicMaxTiles(parsed);

    if (!parsed) return "Range unknown";
    return "Range " + parsed + " / " + tiles + " tile area";
  }

  async function fetchHtml(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: {
        "Accept": "text/html, */*; q=0.01"
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

  function extractBalancedValue(source, startIndex) {
    const opening = source[startIndex];
    const closing = opening === "{" ? "}" : opening === "[" ? "]" : null;

    if (!closing) {
      throw new Error("Expected balanced JSON value.");
    }

    let depth = 0;
    let insideString = false;
    let escaped = false;

    for (let i = startIndex; i < source.length; i++) {
      const char = source[i];

      if (insideString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === '"') {
          insideString = false;
        }

        continue;
      }

      if (char === '"') {
        insideString = true;
        continue;
      }

      if (char === opening) {
        depth++;
      } else if (char === closing) {
        depth--;

        if (depth === 0) {
          return source.slice(startIndex, i + 1);
        }
      }
    }

    throw new Error("Could not find end of JSON value.");
  }

  function extractInventoryRelicsFromHtml(html) {
    const doc = parseHtml(html);
    const scripts = Array.from(doc.querySelectorAll("script"));
    const relics = [];

    scripts.forEach(script => {
      const source = script.textContent || "";
      const marker = "RelicSystem.Inventory.init";

      if (!source.includes(marker)) return;

      const markerIndex = source.indexOf(marker);
      const callStart = source.indexOf("(", markerIndex);
      const arrayStart = source.indexOf("[", callStart);

      if (arrayStart === -1) return;

      try {
        const jsonText = extractBalancedValue(source, arrayStart);
        const parsed = JSON.parse(jsonText);

        if (Array.isArray(parsed)) {
          parsed.forEach(item => relics.push(item));
        }
      } catch (err) {
        console.warn(SCRIPT_NAME + " could not parse inventory relic JSON:", err);
      }
    });

    return dedupeRelics(relics.map(normalizeInventoryRelic).filter(Boolean));
  }

  function dedupeRelics(relics) {
    const map = new Map();

    relics.forEach(relic => {
      map.set(String(relic.id), relic);
    });

    return Array.from(map.values());
  }

  function normalizeInventoryRelic(raw) {
    if (!raw || raw.id === undefined || raw.id === null) return null;

    const stats = [];
    const relicType = raw.type || "";

    if (raw.main_stat) {
      const normalizedMain = normalizeRelicStat(raw.main_stat, relicType);

      stats.push({
        source: "main",
        rawName: cleanText(raw.main_stat.name || raw.main_stat.benefit && raw.main_stat.benefit.description),
        normalized: normalizedMain
      });
    }

    (raw.sub_stats || []).forEach(subStat => {
      if (!subStat) return;

      const normalizedSub = normalizeRelicStat(subStat, relicType);

      stats.push({
        source: "sub",
        rawName: cleanText(subStat.name || subStat.benefit && subStat.benefit.description),
        normalized: normalizedSub,
        perfect: subStat.perfect === true
      });
    });

    return {
      id: String(raw.id),
      name: cleanText(raw.name || ("Relic " + raw.id)),
      type: relicType,
      quality: raw.quality || "",
      range: parseInt(raw.range || 0, 10),
      villageId: raw.village_id ? String(raw.village_id) : "",
      equippedAt: raw.equipped_at || null,
      raw: raw,
      stats: stats.filter(stat => stat.normalized)
    };
  }

  function normalizeSearchText(value) {
    return cleanText(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function includesAny(text, aliases) {
    const haystack = normalizeSearchText(text);

    return (aliases || []).some(alias => {
      return haystack.indexOf(normalizeSearchText(alias)) >= 0;
    });
  }

  function getPercentValue(text) {
    const valueMatch = cleanText(text).match(/([+-]?\d+(?:[.,]\d+)?)\s*%/);

    if (!valueMatch) return null;

    return Math.abs(parseFloat(valueMatch[1].replace(",", ".")));
  }

  function formatSettingNumber(value) {
    const rounded = Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

    if (Number.isInteger(rounded)) return String(rounded);
    return String(rounded).replace(/0+$/, "").replace(/\.$/, "");
  }

  function getBenefitCap() {
    const settings = state.worldRelicSettings || {};
    const cap = Number(settings.benefitCap);

    if (!isNaN(cap) && cap > 0) return cap;
    return DEFAULT_BENEFIT_CAP;
  }

  function getBenefitCapSourceLabel() {
    const source = state.worldRelicSettings && state.worldRelicSettings.benefitCapSource;

    if (source === "help") return "detected";
    if (source === "manual") return "manual";
    if (source === "game-data") return "game data";
    return "fallback";
  }

  function getBenefitCapPillText() {
    return "Cap: " + formatSettingNumber(getBenefitCap()) + "% (" + getBenefitCapSourceLabel() + ")";
  }

  function extractNumericPercentValues(text) {
    const values = [];
    const matches = String(text || "").matchAll(/(\d+(?:[.,]\d+)?)\s*%/g);

    Array.from(matches).forEach(match => {
      const value = parseFloat(String(match[1]).replace(",", "."));

      if (!isNaN(value) && value > 0 && value <= 100) {
        values.push(value);
      }
    });

    return values;
  }

  function detectBenefitCapFromHelpHtml(html) {
    if (!html) return null;

    const doc = parseHtml(html);
    const candidates = [];
    const capAliases = [
      "cap", "maximum", "max", "limit", "exceed", "cannot exceed", "may not exceed",
      "haladhatjak", "haladhatják", "maximum", "hatar", "határ",
      "ueberschreiten", "überschreiten", "maximal", "maximum",
      "depasser", "dépasser", "maximum", "limite",
      "superar", "maximo", "máximo", "limite",
      "superare", "massimo", "limite",
      "overstiga", "överstiga", "max", "grans", "gräns",
      "overschrijden", "maximaal", "limiet",
      "przekroczyc", "przekroczyć", "maksimum", "limit",
      "depasi", "depăși", "maxim", "limita", "limită",
      "перевищ", "превыш", "максим", "обмеж", "огранич",
      "υπερβ", "μέγισ", "μεγισ", "حد", "اقصى", "أقصى"
    ];
    const relicAliases = [
      "relic", "relics", "relikvia", "relikviak", "relikviák", "ereklye", "erekl",
      "benefit", "bonus", "haszna", "hasznanak", "hasznának", "effet", "bono", "bonus",
      "relikt", "relikwia", "reliquia", "reliquie", "релик", "relică", "relicva"
    ];
    const exampleAliases = [
      "possible values", "following values", "következő értékek", "kovetkezo ertekek",
      "werte", "valeurs", "valores", "valori", "wartosci", "wartości"
    ];
    const elements = Array.from(doc.querySelectorAll("p, li, div, td"));

    function addCandidate(text) {
      const clean = cleanText(text);
      if (!clean || clean.length > 900) return;
      if (!includesAny(clean, capAliases)) return;
      if (!includesAny(clean, relicAliases)) return;
      if (includesAny(clean, exampleAliases)) return;

      const values = extractNumericPercentValues(clean).filter(value => value >= 5 && value <= 50);
      if (!values.length) return;

      let score = 0;
      if (includesAny(clean, capAliases)) score += 10;
      if (includesAny(clean, relicAliases)) score += 5;
      if (/\+\s*\d+(?:[.,]\d+)?\s*%/.test(clean)) score -= 5;

      values.forEach(value => {
        candidates.push({ value: value, score: score, text: clean });
      });
    }

    elements.forEach(element => addCandidate(element.textContent));

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.value === 20 && b.value !== 20) return -1;
      if (b.value === 20 && a.value !== 20) return 1;
      if (a.value === 10 && b.value !== 10) return -1;
      if (b.value === 10 && a.value !== 10) return 1;
      return b.value - a.value;
    });

    if (!candidates.length || candidates[0].score < 10) {
      return null;
    }

    return {
      benefitCap: candidates[0].value,
      benefitCapSource: "help",
      sourceText: candidates[0].text
    };
  }

  function detectWorldRelicSettings(data) {
    const settings = {
      benefitCap: DEFAULT_BENEFIT_CAP,
      benefitCapSource: "fallback",
      detectedRanges: []
    };
    const helpSettings = detectBenefitCapFromHelpHtml(data && data.helpHtml);
    const ranges = new Set();

    if (helpSettings && helpSettings.benefitCap) {
      settings.benefitCap = helpSettings.benefitCap;
      settings.benefitCapSource = helpSettings.benefitCapSource || "help";
      settings.benefitCapSourceText = helpSettings.sourceText || "";
    }

    ((data && data.inventoryRelics) || []).forEach(relic => {
      const range = parseInt(relic && relic.range || 0, 10);
      if (range > 0) ranges.add(range);
    });

    ((data && data.placedRelics) || []).forEach(relic => {
      const range = parseInt(relic && relic.range || 0, 10);
      if (range > 0) ranges.add(range);
    });

    settings.detectedRanges = Array.from(ranges).sort((a, b) => a - b);
    return settings;
  }

  function applyWorldRelicSettings(settings) {
    const current = state.worldRelicSettings || {};

    state.worldRelicSettings = Object.assign({}, current, settings || {});
  }

  function syncBenefitCapInputFromState() {
    if (!ui.capInput || ui.capInputWasEdited) return;
    ui.capInput.value = formatSettingNumber(getBenefitCap());
  }

  function applyBenefitCapInputToState() {
    if (!ui.capInput) return;

    const cap = parseFloat(String(ui.capInput.value || "").replace(",", "."));

    if (!isNaN(cap) && cap > 0) {
      state.worldRelicSettings.benefitCap = cap;

      if (ui.capInputWasEdited) {
        state.worldRelicSettings.benefitCapSource = "manual";
      }
    }
  }

  function getInternalStatLabel(key, fallbackText) {
    return INTERNAL_STAT_LABELS[key] || cleanText(fallbackText) || key.replace(/_/g, " ");
  }

  function normalizeKeyValue(key, value, fallbackText) {
    if (!key || !RELEVANT_INTERNAL_STAT_KEYS[key]) return null;
    if (value === null || value === undefined || isNaN(value)) return null;

    return {
      key: key,
      value: Math.abs(Number(value)),
      label: getInternalStatLabel(key, fallbackText)
    };
  }

  function getKeyFromRelicStatData(stat, relicType, text) {
    const effectType = stat && stat.effect_type ? String(stat.effect_type) : "";
    const statId = stat && stat.id !== undefined && stat.id !== null ? String(stat.id) : "";
    const type = cleanText((stat && stat.type) || relicType).toLowerCase();

    if (statId && SUB_STAT_KEYS_BY_ID[statId]) {
      return SUB_STAT_KEYS_BY_ID[statId];
    }

    if (MAIN_RELIC_STAT_KEYS[type] && MAIN_RELIC_STAT_KEYS[type][effectType]) {
      return MAIN_RELIC_STAT_KEYS[type][effectType];
    }

    if (effectType === "b_unitstat" && RELIC_TYPE_UNIT_KEYS[type]) {
      const unit = RELIC_TYPE_UNIT_KEYS[type];

      if (includesAny(text, STAT_ACTION_ALIASES.damage)) return unit + "_damage";
      if (includesAny(text, STAT_ACTION_ALIASES.attack)) return unit + "_attack";
      if (includesAny(text, STAT_ACTION_ALIASES.defense)) return unit + "_defense";
      return unit + "_offdef";
    }

    return "";
  }

  function normalizeRelicStat(stat, relicType) {
    const text = cleanText((stat && stat.name) || (stat && stat.benefit && stat.benefit.description) || "");
    const value = getPercentValue(text);

    if (value === null) return null;

    const internalKey = getKeyFromRelicStatData(stat, relicType, text);
    const normalizedInternal = normalizeKeyValue(internalKey, value, text);

    if (normalizedInternal) return normalizedInternal;

    return normalizeStat(text);
  }

  function normalizeStat(name) {
    const text = cleanText(name);
    const value = getPercentValue(text);

    if (value === null) return null;

    function unitPrefix() {
      const keys = ["light", "marcher", "heavy", "catapult", "spear", "sword", "axe", "archer", "ram", "spy"];

      for (let i = 0; i < keys.length; i++) {
        if (includesAny(text, UNIT_ALIASES[keys[i]])) return keys[i];
      }

      return "";
    }

    if (includesAny(text, STAT_ACTION_ALIASES.speed)) {
      if (includesAny(text, BUILDING_ALIASES.barracks)) return normalizeKeyValue("barracks_speed", value, text);
      if (includesAny(text, BUILDING_ALIASES.stable)) return normalizeKeyValue("stable_speed", value, text);
      if (includesAny(text, BUILDING_ALIASES.workshop)) return normalizeKeyValue("workshop_speed", value, text);
      if (includesAny(text, BUILDING_ALIASES.academy)) return normalizeKeyValue("academy_speed", value, text);
    }

    if (includesAny(text, STAT_ACTION_ALIASES.cost)) {
      if (includesAny(text, BUILDING_ALIASES.barracks)) return normalizeKeyValue("barracks_cost", value, text);
      if (includesAny(text, BUILDING_ALIASES.stable)) return normalizeKeyValue("stable_cost", value, text);
      if (includesAny(text, BUILDING_ALIASES.workshop)) return normalizeKeyValue("workshop_cost", value, text);
    }

    const unit = unitPrefix();

    if (unit) {
      if (includesAny(text, STAT_ACTION_ALIASES.damage)) return normalizeKeyValue(unit + "_damage", value, text);
      if (includesAny(text, STAT_ACTION_ALIASES.offdef)) return normalizeKeyValue(unit + "_offdef", value, text);
      if (includesAny(text, STAT_ACTION_ALIASES.attack)) return normalizeKeyValue(unit + "_attack", value, text);
      if (includesAny(text, STAT_ACTION_ALIASES.defense)) return normalizeKeyValue(unit + "_defense", value, text);
    }

    return null;
  }

  function getRelevantWeights(goal) {
    if (goal === "offense") return OFFENSE_WEIGHTS;
    return RECRUITMENT_WEIGHTS;
  }

  function getRelevantStats(relic, goal) {
    const weights = getRelevantWeights(goal);

    return (relic.stats || [])
      .map(stat => stat.normalized)
      .filter(Boolean)
      .filter(stat => weights[stat.key] !== undefined);
  }

  function parseFarmText(value) {
    const text = cleanText(value);
    const match = text.match(/([\d.,]+)\s*\/\s*([\d.,]+)/);

    if (!match) {
      return {
        used: 0,
        max: 0,
        free: 0
      };
    }

    const used = parseNumber(match[1]);
    const max = parseNumber(match[2]);

    return {
      used: used,
      max: max,
      free: Math.max(0, max - used)
    };
  }

  function looksLikeFarmText(value) {
    const farm = parseFarmText(value);
    return farm.max > 0;
  }

  function findFarmColumnIndex(table) {
    const aliases = [
      "farm", "farm space", "population", "pop", "tanya", "ferme", "granja", "fazenda", "fattoria", "bauernhof", "zagroda", "boerderij", "bondgård", "gård", "gård", "çiftlik", "ciftlik", "ферма", "ферма", "ฟาร์ม"
    ];

    for (let i = 0; i < aliases.length; i++) {
      const index = getColumnIndexByHeader(table, aliases[i]);
      if (index >= 0) return index;
    }

    return -1;
  }

  function getFarmCellFromRow(row, farmIndex) {
    const cells = Array.from(row.children);

    if (farmIndex >= 0 && cells[farmIndex] && looksLikeFarmText(cells[farmIndex].textContent)) {
      return cells[farmIndex];
    }

    for (let i = 0; i < cells.length; i++) {
      if (looksLikeFarmText(cells[i].textContent)) {
        return cells[i];
      }
    }

    return null;
  }

  function getColumnIndexByHeader(table, label) {
    const headers = Array.from(table.querySelectorAll("thead th"));
    const normalizedLabel = label.toLowerCase();

    for (let i = 0; i < headers.length; i++) {
      if (cleanText(headers[i].textContent).toLowerCase().includes(normalizedLabel)) {
        return i;
      }
    }

    return -1;
  }

  function extractVillagesFromProductionHtml(html) {
    const doc = parseHtml(html);
    const table =
			doc.querySelector("#production_table") ||
			doc.querySelector("#combined_table") ||
			doc.querySelector("table.overview_table") ||
			doc.querySelector("#content_value table.vis");
    const villages = [];
    const seen = new Set();

    if (!table) return villages;

    const farmIndex = findFarmColumnIndex(table);

    Array.from(table.querySelectorAll("tbody tr")).forEach(row => {
      if (row.querySelector("th")) return;

      const link =
        row.querySelector('a[href*="screen=overview"][href*="village="]') ||
        row.querySelector('a[href*="screen=place"][href*="village="]') ||
        row.querySelector('a[href*="village="]');

      if (!link) return;

      const name = cleanText(link.textContent);
      const coordData = parseCoord(name);

      if (!coordData) return;

      const villageId = getParam("village", link.getAttribute("href")) || coordData.coord;
      const key = String(villageId);

      if (seen.has(key)) return;
      seen.add(key);

      const farmCell = getFarmCellFromRow(row, farmIndex);
      const farm = parseFarmText(farmCell ? farmCell.textContent : "");

      villages.push({
        id: String(villageId),
        name: name,
        x: coordData.x,
        y: coordData.y,
        coord: coordData.coord,
        href: link.getAttribute("href") || "",
        farmUsed: farm.used,
        farmMax: farm.max,
        farmFree: farm.free
      });
    });

    return villages;
  }

  function extractRangeFromElement(root) {
    if (!root) return 0;

    const rangeAliases = "Range|Tartom[aá]ny|Reichweite|Port[eé]e|Alcance|R[aä]ckvidd|Zasi[eę]g|Gama|Raggio|Bereik|Dost[eę]p|Afstand|Menzil|Дальность|Діапазон";
    const rangeElement = root.querySelector && root.querySelector(".range");

    function parseRangeText(text, requireLabel) {
      const clean = cleanText(text);
      const labeledMatch = clean.match(new RegExp("(?:" + rangeAliases + ")\\s*:?\\s*(\\d{1,2})", "i"));

      if (labeledMatch) {
        const labeledRange = parseInt(labeledMatch[1], 10);
        if (!isNaN(labeledRange) && labeledRange > 0 && labeledRange <= 20) return labeledRange;
      }

      if (!requireLabel) {
        const numericMatch = clean.match(/(?:^|\D)(\d{1,2})(?:\D|$)/);
        if (numericMatch) {
          const numericRange = parseInt(numericMatch[1], 10);
          if (!isNaN(numericRange) && numericRange > 0 && numericRange <= 20) return numericRange;
        }
      }

      return 0;
    }

    if (rangeElement) {
      return parseRangeText(rangeElement.textContent || "", false);
    }

    return parseRangeText(root.textContent || "", true);
  }

  function extractPlacedRelicsFromOverviewHtml(html) {
    const doc = parseHtml(html);
    const relics = [];

    Array.from(doc.querySelectorAll("#relic_slots .relic-slot.used")).forEach((slot, index) => {
      const description = slot.querySelector(".description-container");
      if (!description) return;

      const nameEl = description.querySelector("strong");
      const name = cleanText(nameEl ? nameEl.textContent : "Placed relic");

      const locationLink = description.querySelector(".location a[href*='screen=info_village']");
      const locationText = cleanText(locationLink ? locationLink.textContent : "");
      const coordData = parseCoord(locationText);
      const villageId =
        locationLink
          ? getParam("id", locationLink.getAttribute("href")) || ""
          : "";

      const divs = Array.from(description.children);
      const statTexts = [];
      let range = 0;

      divs.forEach(div => {
        const text = cleanText(div.textContent);

        if (!text) return;

        if (div.classList && div.classList.contains("range")) {
          range = extractRangeFromElement(div) || range;
          return;
        }

        const rangeMatch = text.match(/(?:Range|Tartom[aá]ny|Reichweite|Port[eé]e|Alcance|R[aä]ckvidd|Zasi[eę]g|Gama|Raggio)\s*:?\s*(\d+)/i);
        if (rangeMatch) {
          range = parseInt(rangeMatch[1], 10);
          return;
        }

        if (div.classList && div.classList.contains("location")) return;
        if (div.querySelector && div.querySelector(".effected-other-villages-list")) return;

        if (text !== name) {
          statTexts.push(text);
        }
      });

      if (!range) {
        range = extractRangeFromElement(description);
      }

      const stats = statTexts
        .map(text => ({
          source: "placed",
          rawName: text,
          normalized: normalizeStat(text)
        }))
        .filter(stat => stat.normalized);

      if (!coordData || !range || !stats.length) {
        return;
      }

      relics.push({
        id: "placed-" + index + "-" + coordData.coord + "-" + name,
        name: name,
        range: range,
        villageId: String(villageId),
        coord: coordData.coord,
        x: coordData.x,
        y: coordData.y,
        locationName: locationText,
        stats: stats
      });
    });

    return relics;
  }
	

  function relicSignature(relic) {
    return [
      cleanText(relic && relic.name).toLowerCase(),
      String((relic && relic.range) || ""),
      (relic && relic.stats || [])
        .map(stat => stat.normalized)
        .filter(Boolean)
        .map(stat => stat.key + ":" + stat.value)
        .sort()
        .join("|")
    ].join("::");
  }

  function getRelicIdentityKey(relic) {
    const id = String(relic && relic.id || "");

    if (id) {
      return (id.indexOf("placed-") === 0 ? "placed:" : "id:") + id;
    }

    return "sig:" + relicSignature(relic);
  }

  function enrichPlacedInventoryRelic(relic) {
    const village =
      state.villagesById.get(String(relic.villageId)) ||
      state.villagesByCoord.get(relic.coord);

    return Object.assign({}, relic, {
      fromInventory: true,
      fromOverview: false,
      coord: village ? village.coord : relic.coord,
      x: village ? village.x : relic.x,
      y: village ? village.y : relic.y,
      locationName: village ? village.name : relic.locationName
    });
  }

  function mergePlacedRelicsWithInventory(inventoryRelics, overviewRelics) {
    const merged = [];
    const seenInventoryIds = new Set();
    const seenPlacedVillageSignatures = new Set();

    (inventoryRelics || []).forEach(relic => {
      if (!relic.villageId && !relic.equippedAt) return;

      const enriched = enrichPlacedInventoryRelic(relic);
      const identityKey = getRelicIdentityKey(enriched);
      const villageSignatureKey = "village:" + (enriched.villageId || enriched.coord || "") + ":" + relicSignature(enriched);

      seenInventoryIds.add(identityKey);
      seenPlacedVillageSignatures.add(villageSignatureKey);
      merged.push(enriched);
    });

    (overviewRelics || []).forEach(relic => {
      const villageSignatureKey = "village:" + (relic.villageId || relic.coord || "") + ":" + relicSignature(relic);

      if (seenPlacedVillageSignatures.has(villageSignatureKey)) return;

      seenPlacedVillageSignatures.add(villageSignatureKey);
      merged.push(Object.assign({}, relic, { fromOverview: true }));
    });

    return merged;
  }

	function countUnlockedRelicSlotsFromOverviewHtml(html) {
		const doc = parseHtml(html);
		const slots = Array.from(doc.querySelectorAll("#relic_slots .relic-slot"));

		if (!slots.length) {
			return 10;
		}

		const unlockedSlots = slots.filter(slot => {
			return !slot.classList.contains("locked");
		});

		return Math.max(1, Math.min(10, unlockedSlots.length || 10));
	}

  function rebuildVillageIndexes() {
    state.villagesById = new Map();
    state.villagesByCoord = new Map();

    state.villages.forEach(village => {
      state.villagesById.set(String(village.id), village);
      state.villagesByCoord.set(village.coord, village);
    });
  }

  function getCoveredVillages(center, range) {
    const coveredByCoord = new Map();
    const offsets = getRelicOffsets(range);

    offsets.forEach(offset => {
      const targetCoord = (center.x + offset.dx) + "|" + (center.y + offset.dy);
      const village = state.villagesByCoord.get(targetCoord);

      if (village) {
        coveredByCoord.set(village.coord, village);
      }
    });

    if (state.villagesByCoord.has(center.coord)) {
      coveredByCoord.set(center.coord, state.villagesByCoord.get(center.coord));
    }

    return Array.from(coveredByCoord.values()).sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
  }

	function getHighestFarmMax() {
	  return Math.max(0, ...state.villages.map(village => village.farmMax || 0));
	}

	function getHighestFarmFree() {
	  return Math.max(0, ...state.villages.map(village => village.farmFree || 0));
	}

	function getVillageWeight(village, weighting) {
	  if (weighting === "freeFarm") {
		const highestFreeFarm = getHighestFarmFree();

		if (highestFreeFarm > 0) {
		  return (village.farmFree || 0) / highestFreeFarm;
		}

		return 1;
	  }

	  if (weighting === "farmCap") {
		const highestFarmMax = getHighestFarmMax();

		if (highestFarmMax > 0) {
		  return (village.farmMax || 0) / highestFarmMax;
		}

		return 1;
	  }

	  return 1;
	}

  function createEmptyBonusMap() {
    return new Map();
  }

  function getVillageBonusObject(bonusMap, village) {
    const key = village.coord;

    if (!bonusMap.has(key)) {
      bonusMap.set(key, {});
    }

    return bonusMap.get(key);
  }

  function cloneBonusMap(source) {
    const clone = new Map();

    source.forEach((value, key) => {
      clone.set(key, Object.assign({}, value));
    });

    return clone;
  }

  function buildOptimizationContext(weighting) {
    const coverageCache = new Map();
    const weightCache = new Map();
    const highestFreeFarm = getHighestFarmFree();
    const highestFarmMax = getHighestFarmMax();

    state.villages.forEach(village => {
      [2, 3, 4].forEach(range => {
        coverageCache.set(village.coord + ":" + range, getCoveredVillages(village, range));
      });

      let weight = 1;

      if (weighting === "freeFarm" && highestFreeFarm > 0) {
        weight = (village.farmFree || 0) / highestFreeFarm;
      } else if (weighting === "farmCap" && highestFarmMax > 0) {
        weight = (village.farmMax || 0) / highestFarmMax;
      }

      weightCache.set(village.coord, weight);
    });

    return {
      weighting: weighting,
      coverageCache: coverageCache,
      weightCache: weightCache
    };
  }

  function getCachedCoveredVillages(center, range, optimizationContext) {
    const key = center.coord + ":" + range;

    if (optimizationContext && optimizationContext.coverageCache && optimizationContext.coverageCache.has(key)) {
      return optimizationContext.coverageCache.get(key) || [];
    }

    return getCoveredVillages(center, range);
  }

  function getCachedVillageWeight(village, weighting, optimizationContext) {
    if (optimizationContext && optimizationContext.weightCache && optimizationContext.weightCache.has(village.coord)) {
      return optimizationContext.weightCache.get(village.coord);
    }

    return getVillageWeight(village, weighting);
  }

  function applyRelicToBonuses(relic, center, bonusMap, goalAgnostic, optimizationContext) {
    const covered = getCachedCoveredVillages(center, relic.range, optimizationContext);
    const stats = (relic.stats || [])
      .map(stat => stat.normalized)
      .filter(Boolean);
    const benefitCap = getBenefitCap();

    covered.forEach(village => {
      const bonuses = getVillageBonusObject(bonusMap, village);

      stats.forEach(stat => {
        const current = bonuses[stat.key] || 0;
        bonuses[stat.key] = Math.min(benefitCap, current + stat.value);
      });
    });

    return covered;
  }

  function buildCurrentBonuses(mode, optimizationContext) {
    const bonusMap = createEmptyBonusMap();

    if (mode !== "fixed") {
      return bonusMap;
    }

    state.placedRelics.forEach(relic => {
      const center =
        state.villagesById.get(String(relic.villageId)) ||
        state.villagesByCoord.get(relic.coord) ||
        {
          x: relic.x,
          y: relic.y,
          coord: relic.coord
        };

      if (center && relic.range) {
        applyRelicToBonuses(relic, center, bonusMap, true, optimizationContext);
      }
    });

    return bonusMap;
  }

  function calculatePlacementScore(relic, center, bonusMap, goal, weighting, optimizationContext) {
    const weights = getRelevantWeights(goal);
    const relevantStats = getRelevantStats(relic, goal);
    const covered = getCachedCoveredVillages(center, relic.range, optimizationContext);
    const benefitCap = getBenefitCap();

    let score = 0;
    let rawScore = 0;
    let wastedScore = 0;
    const scoreByStat = {};

    if (!relevantStats.length || !covered.length) {
      return {
        score: 0,
        rawScore: 0,
        wastedScore: 0,
        covered: covered,
        relevantStats: relevantStats,
        scoreByStat: scoreByStat
      };
    }

    covered.forEach(village => {
      const villageWeight = getCachedVillageWeight(village, weighting, optimizationContext);
      const bonuses = bonusMap.get(village.coord) || {};

      relevantStats.forEach(stat => {
        const statWeight = weights[stat.key] || 0;

        if (!statWeight) return;

        const current = bonuses[stat.key] || 0;
        const capped = Math.min(benefitCap, current + stat.value);
        const effectiveGain = Math.max(0, capped - current);
        const wastedGain = Math.max(0, stat.value - effectiveGain);

        const statScore = effectiveGain * statWeight * villageWeight;
        const statRawScore = stat.value * statWeight * villageWeight;
        const statWastedScore = wastedGain * statWeight * villageWeight;

        score += statScore;
        rawScore += statRawScore;
        wastedScore += statWastedScore;

        scoreByStat[stat.key] = (scoreByStat[stat.key] || 0) + statScore;
      });
    });

    return {
      score: score,
      rawScore: rawScore,
      wastedScore: wastedScore,
      covered: covered,
      relevantStats: relevantStats,
      scoreByStat: scoreByStat
    };
  }

  function getAvailableRelics(mode) {
    if (mode === "rebuild") {
      const inventoryRelics = state.inventoryRelics.map(relic => {
        return Object.assign({}, relic, {
          fromInventory: true
        });
      });

      const overviewOnlyRelics = state.placedRelics
        .filter(relic => !relic.fromInventory)
        .map(relic => {
          return Object.assign({}, relic, {
            fromOverview: true
          });
        });

      return dedupeAvailableRelics(inventoryRelics.concat(overviewOnlyRelics));
    }

    return state.inventoryRelics.filter(relic => {
      return !relic.villageId && !relic.equippedAt;
    });
  }

  function dedupeAvailableRelics(relics) {
    const result = [];
    const seenKeys = new Set();

    (relics || []).forEach(relic => {
      const key = getRelicIdentityKey(relic);

      if (seenKeys.has(key)) return;

      seenKeys.add(key);
      result.push(relic);
    });

    return result;
  }

  function isBetterMove(candidate, best) {
    const EPSILON = 0.000001;

    if (!best) return true;
    if (candidate.score > best.score + EPSILON) return true;
    if (candidate.score < best.score - EPSILON) return false;

    if (candidate.wastedScore < best.wastedScore - EPSILON) return true;
    if (candidate.wastedScore > best.wastedScore + EPSILON) return false;

    return candidate.covered.length > best.covered.length;
  }

  function buildMove(step, relic, center, scored) {
    return {
      step: step,
      relic: relic,
      center: center,
      score: scored.score,
      rawScore: scored.rawScore,
      wastedScore: scored.wastedScore,
      covered: scored.covered,
      relevantStats: scored.relevantStats,
      scoreByStat: scored.scoreByStat
    };
  }

  function scorePlanPlacements(placements, baseBonuses, goal, weighting, optimizationContext) {
    const workingBonuses = cloneBonusMap(baseBonuses);
    const usedRelics = new Set();
    const usedCenters = new Set();
    const scoredPlan = [];
    let totalScore = 0;
    let totalWaste = 0;

    for (let i = 0; i < placements.length; i++) {
      const placement = placements[i];
      const relicKey = getRelicIdentityKey(placement.relic);
      const centerKey = placement.center.coord;

      if (usedRelics.has(relicKey) || usedCenters.has(centerKey)) {
        return { valid: false, totalScore: -Infinity, totalWaste: Infinity, plan: [] };
      }

      usedRelics.add(relicKey);
      usedCenters.add(centerKey);

      const scored = calculatePlacementScore(placement.relic, placement.center, workingBonuses, goal, weighting, optimizationContext);
      const move = buildMove(i + 1, placement.relic, placement.center, scored);

      scoredPlan.push(move);
      totalScore += scored.score;
      totalWaste += scored.wastedScore;
      applyRelicToBonuses(placement.relic, placement.center, workingBonuses, true, optimizationContext);
    }

    return {
      valid: true,
      totalScore: totalScore,
      totalWaste: totalWaste,
      plan: scoredPlan
    };
  }

  function isBetterPlan(candidate, current) {
    const EPSILON = 0.000001;

    if (!candidate.valid) return false;
    if (!current || !current.valid) return true;
    if (candidate.totalScore > current.totalScore + EPSILON) return true;
    if (candidate.totalScore < current.totalScore - EPSILON) return false;

    return candidate.totalWaste < current.totalWaste - EPSILON;
  }

  function improvePlanWithLocalSearch(plan, availableRelics, baseBonuses, goal, weighting, optimizationContext) {
    const workEstimate = plan.length * availableRelics.length * state.villages.length;

    if (!plan.length || workEstimate > 400000) {
      return plan;
    }

    let current = scorePlanPlacements(plan.map(item => ({ relic: item.relic, center: item.center })), baseBonuses, goal, weighting, optimizationContext);
    let improved = true;
    let passes = 0;

    while (improved && passes < 2) {
      improved = false;
      passes += 1;

      for (let index = 0; index < current.plan.length; index++) {
        const currentPlacements = current.plan.map(item => ({ relic: item.relic, center: item.center }));

        for (let relicIndex = 0; relicIndex < availableRelics.length; relicIndex++) {
          const relic = availableRelics[relicIndex];

          for (let villageIndex = 0; villageIndex < state.villages.length; villageIndex++) {
            const center = state.villages[villageIndex];

            if (
              getRelicIdentityKey(relic) === getRelicIdentityKey(currentPlacements[index].relic) &&
              center.coord === currentPlacements[index].center.coord
            ) {
              continue;
            }

            const testPlacements = currentPlacements.slice();
            testPlacements[index] = { relic: relic, center: center };
            const candidate = scorePlanPlacements(testPlacements, baseBonuses, goal, weighting, optimizationContext);

            if (isBetterPlan(candidate, current)) {
              current = candidate;
              improved = true;
            }
          }
        }
      }
    }

    return current.plan;
  }

  function optimizePlan(goal, mode, weighting, maxPlacements) {
    const optimizationContext = buildOptimizationContext(weighting);
    const baseBonuses = buildCurrentBonuses(mode, optimizationContext);
    const workingBonuses = cloneBonusMap(baseBonuses);
    const availableRelics = getAvailableRelics(mode).filter(relic => getRelevantStats(relic, goal).length > 0);
    const remainingRelics = availableRelics.slice();
    const usedCenters = new Set();
    const plan = [];

    for (let step = 0; step < maxPlacements; step++) {
      let bestMove = null;

      remainingRelics.forEach(relic => {
        state.villages.forEach(center => {
          if (usedCenters.has(center.coord)) return;

          const scored = calculatePlacementScore(relic, center, workingBonuses, goal, weighting, optimizationContext);

          if (scored.score <= 0) return;

          const candidate = buildMove(step + 1, relic, center, scored);

          if (isBetterMove(candidate, bestMove)) {
            bestMove = candidate;
          }
        });
      });

      if (!bestMove) {
        break;
      }

      applyRelicToBonuses(bestMove.relic, bestMove.center, workingBonuses, true, optimizationContext);
      usedCenters.add(bestMove.center.coord);

      const relicKey = getRelicIdentityKey(bestMove.relic);
      const index = remainingRelics.findIndex(relic => getRelicIdentityKey(relic) === relicKey);
      if (index >= 0) {
        remainingRelics.splice(index, 1);
      }

      plan.push(bestMove);
    }

    return improvePlanWithLocalSearch(plan, availableRelics, baseBonuses, goal, weighting, optimizationContext);
  }

  async function loadAllData(goal) {
	  const villageUrl = getVillageDataUrl(goal);

	  const inventoryUrl = buildGameUrl({
		screen: "relic_system",
		mode: "inventory"
	  });

	  const overviewUrl = buildGameUrl({
		screen: "relic_system",
		mode: "overview"
	  });

    const helpUrl = buildGameUrl({
      screen: "relic_system",
      mode: "help"
    });

	  if (goal === "offense") {
		setStatus("Loading village coordinates, inventory and overview data...", "warn");
	  } else {
		setStatus("Loading production, inventory and overview data...", "warn");
	  }

	  const responses = await Promise.all([
		fetchHtml(villageUrl),
		fetchHtml(inventoryUrl),
		fetchHtml(overviewUrl),
      fetchHtml(helpUrl)
	  ]);

	  state.villages = extractVillagesFromProductionHtml(responses[0]);
	  rebuildVillageIndexes();

	  state.inventoryRelics = extractInventoryRelicsFromHtml(responses[1]);
		state.placedRelics = mergePlacedRelicsWithInventory(
			state.inventoryRelics,
			extractPlacedRelicsFromOverviewHtml(responses[2])
		);
		state.unlockedRelicSlots = countUnlockedRelicSlotsFromOverviewHtml(responses[2]);
    applyWorldRelicSettings(detectWorldRelicSettings({
      inventoryRelics: state.inventoryRelics,
      placedRelics: state.placedRelics,
      helpHtml: responses[3]
    }));
    syncBenefitCapInputFromState();
    applyBenefitCapInputToState();

	  console.log(SCRIPT_NAME + " villages:", state.villages);
	  console.log(SCRIPT_NAME + " inventory relics:", state.inventoryRelics);
	  console.log(SCRIPT_NAME + " placed relics:", state.placedRelics);
    console.log(SCRIPT_NAME + " world relic settings:", state.worldRelicSettings);

	  return {
		villageUrl: villageUrl,
		inventoryUrl: inventoryUrl,
		overviewUrl: overviewUrl,
        helpUrl: helpUrl
	  };
	}

  async function loadAndOptimize() {
    try {
      ui.loadButton.disabled = true;

      const goal = ui.goalSelect.value;
			const mode = ui.modeSelect.value;
			const weighting = ui.weightSelect.value;

			const urls = await loadAllData(goal);
			const maxPlacements = Math.max(1, Math.min(10, parseInt(ui.countInput.value, 10) || state.unlockedRelicSlots || 10));

      state.plan = optimizePlan(goal, mode, weighting, maxPlacements);

      renderResults({
        goal: goal,
        mode: mode,
        weighting: weighting,
        maxPlacements: maxPlacements,
        urls: urls
      });

      setStatus(
        "Loaded " +
          state.villages.length +
          " village(s), " +
          state.inventoryRelics.length +
          " inventory relic(s), " +
          state.placedRelics.length +
          " placed relic(s). Plan rows: " +
          state.plan.length +
          ". Cap: " +
          formatSettingNumber(getBenefitCap()) +
          "% (" +
          getBenefitCapSourceLabel() +
          ").",
        "success"
      );
    } catch (err) {
      console.error(SCRIPT_NAME + " failed:", err);
      setStatus(err.message || String(err), "error");
    } finally {
      ui.loadButton.disabled = false;
    }
  }

  function formatStatList(stats) {
	  return (stats || [])
		.map(stat => {
		  if (/%/.test(stat.label)) {
			return stat.label;
		  }

		  return stat.label + " +" + stat.value + "%";
		})
		.join(", ");
	}

  function formatScore(value) {
    return Number(value || 0).toFixed(2);
  }
	
	const STAT_LABELS = {
  barracks_speed: "Barracks speed",
  stable_speed: "Stable speed",
  workshop_speed: "Workshop speed",
  academy_speed: "Academy speed",

  barracks_cost: "Barracks cost reduction",
  stable_cost: "Stable cost reduction",
  workshop_cost: "Workshop cost reduction",

  axe_attack: "Axeman attack",
  axe_offdef: "Axeman off/def",
  light_attack: "Light cavalry attack",
  light_offdef: "Light cavalry off/def",
  marcher_attack: "Mounted archer attack",
  marcher_offdef: "Mounted archer off/def",
  heavy_attack: "Heavy cavalry attack",
  heavy_offdef: "Heavy cavalry off/def",
  ram_attack: "Ram attack",
  ram_damage: "Ram building damage",
  catapult_attack: "Catapult attack",
  catapult_damage: "Catapult building damage"
};

function getStatDisplayName(key) {
  return STAT_LABELS[key] || key.replace(/_/g, " ");
}

function formatImpactStats(stats) {
  const keys = Object.keys(stats || {}).sort();

  if (!keys.length) {
    return "-";
  }

  return keys
    .map(key => {
      return getStatDisplayName(key) + " " + formatScore(stats[key]) + "%";
    })
    .join(", ");
}


const STAT_COPY_ORDER = {
  barracks_speed: 10,
  barracks_cost: 11,
  stable_speed: 20,
  stable_cost: 21,
  workshop_speed: 30,
  workshop_cost: 31,
  academy_speed: 40,
  academy_cost: 41,
  axe_attack: 100,
  axe_offdef: 101,
  spear_attack: 110,
  spear_offdef: 111,
  sword_attack: 120,
  sword_offdef: 121,
  archer_attack: 130,
  archer_offdef: 131,
  light_attack: 200,
  light_offdef: 201,
  marcher_attack: 210,
  marcher_offdef: 211,
  heavy_attack: 220,
  heavy_offdef: 221,
  ram_attack: 300,
  ram_damage: 301,
  catapult_attack: 310,
  catapult_damage: 311
};

const STAT_COPY_LABELS = {
  barracks_speed: "Barracks speed",
  barracks_cost: "Barracks cost",
  stable_speed: "Stable speed",
  stable_cost: "Stable cost",
  workshop_speed: "Workshop speed",
  workshop_cost: "Workshop cost",
  academy_speed: "Academy speed",
  academy_cost: "Academy cost"
};

function getStatCopyOrder(key) {
  return STAT_COPY_ORDER[key] !== undefined ? STAT_COPY_ORDER[key] : 999;
}

function sortStatsForCopy(stats) {
  return (stats || []).slice().sort((a, b) => {
    const keyA = a.key || "";
    const keyB = b.key || "";
    const orderA = getStatCopyOrder(keyA);
    const orderB = getStatCopyOrder(keyB);

    if (orderA !== orderB) return orderA - orderB;
    return getStatCopyLabel(keyA).localeCompare(getStatCopyLabel(keyB));
  });
}

function getStatBuildingIcon(key) {
  const normalized = String(key || "");

  if (
    normalized.indexOf("barracks_") === 0 ||
    normalized.indexOf("axe_") === 0 ||
    normalized.indexOf("spear_") === 0 ||
    normalized.indexOf("sword_") === 0 ||
    normalized.indexOf("archer_") === 0
  ) {
    return "barracks";
  }

  if (
    normalized.indexOf("stable_") === 0 ||
    normalized.indexOf("light_") === 0 ||
    normalized.indexOf("marcher_") === 0 ||
    normalized.indexOf("heavy_") === 0 ||
    normalized.indexOf("spy_") === 0
  ) {
    return "stable";
  }

  if (
    normalized.indexOf("workshop_") === 0 ||
    normalized.indexOf("ram_") === 0 ||
    normalized.indexOf("catapult_") === 0
  ) {
    return "garage";
  }

  if (normalized.indexOf("academy_") === 0) {
    return "snob";
  }

  return "main";
}

function getStatCopyLabel(key) {
  return STAT_COPY_LABELS[key] || getStatDisplayName(key);
}

function isCostStat(key) {
  return /_cost$/.test(String(key || ""));
}

function formatPercentCompact(value) {
  const rounded = Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

  if (Number.isInteger(rounded)) {
    return String(rounded);
  }

  return String(rounded).replace(/0+$/, "").replace(/\.$/, "");
}

function formatStatLineForCopy(stat, showPlusForPositive) {
  if (!stat) return "-";

  const key = stat.key || "";
  const icon = getStatBuildingIcon(key);
  const label = getStatCopyLabel(key);
  const value = formatPercentCompact(stat.value);
  const sign = isCostStat(key) ? "-" : (showPlusForPositive ? "+" : "");

  return "[building]" + icon + "[/building] " + label + " " + sign + value + "%";
}

function formatStatsForCopy(stats, showPlusForPositive) {
  const sorted = sortStatsForCopy(stats);

  if (!sorted.length) {
    return "-";
  }

  return sorted.map(stat => formatStatLineForCopy(stat, showPlusForPositive)).join("; ");
}

function formatImpactStatsForCopy(stats) {
  const sorted = Object.keys(stats || {})
    .sort((a, b) => {
      const orderA = getStatCopyOrder(a);
      const orderB = getStatCopyOrder(b);

      if (orderA !== orderB) return orderA - orderB;
      return getStatCopyLabel(a).localeCompare(getStatCopyLabel(b));
    });

  if (!sorted.length) {
    return "-";
  }

  return sorted.map(key => {
    return formatStatLineForCopy({
      key: key,
      value: stats[key]
    }, false);
  }).join("; ");
}

function getRelicQualityColor(relic) {
  const text = cleanText((relic && (relic.quality || relic.name)) || "").toLowerCase();

  if (text.indexOf("renowned") >= 0) return "#b7791f";
  if (text.indexOf("superior") >= 0) return "#6a3bb4";
  if (text.indexOf("enhanced") >= 0) return "#3b4cb4";
  if (text.indexOf("sturdy") >= 0) return "#2f855a";
  if (text.indexOf("shoddy") >= 0) return "#777777";

  return "#3b4cb4";
}

function getRelicBuildingIcon(relic, stats) {
  const sortedStats = sortStatsForCopy(stats || []);

  if (sortedStats.length) {
    return getStatBuildingIcon(sortedStats[0].key);
  }

  const name = cleanText(relic && relic.name).toLowerCase();

  if (name.indexOf("horse") >= 0) return "stable";
  if (name.indexOf("dummy") >= 0) return "barracks";
  if (name.indexOf("workshop") >= 0) return "garage";
  if (name.indexOf("academy") >= 0) return "snob";

  return "main";
}

function bbEscape(value) {
  return String(value || "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")");
}

function formatRelicForCopy(relic, stats) {
  const icon = getRelicBuildingIcon(relic, stats);
  const color = getRelicQualityColor(relic);

  return "[building]" + icon + "[/building] [b][color=" + color + "]" + bbEscape(relic.name) + "[/color][/b]";
}

function formatVillageCoordForCopy(village) {
  const coord = village && village.coord ? village.coord : "";

  return coord ? "[coord]" + coord + "[/coord]" : "-";
}

function buildVillageImpactSummary(plan) {
  const impactMap = new Map();
  const benefitCap = getBenefitCap();

  (plan || []).forEach(item => {
    item.covered.forEach(village => {
      if (!impactMap.has(village.coord)) {
        impactMap.set(village.coord, {
          village: village,
          relicCount: 0,
          stats: {}
        });
      }

      const entry = impactMap.get(village.coord);
      entry.relicCount += 1;

      item.relevantStats.forEach(stat => {
        const current = entry.stats[stat.key] || 0;
        entry.stats[stat.key] = Math.min(benefitCap, current + stat.value);
      });
    });
  });

  return Array.from(impactMap.values()).sort((a, b) => {
    if (b.relicCount !== a.relicCount) {
      return b.relicCount - a.relicCount;
    }

    if (a.village.y !== b.village.y) {
      return a.village.y - b.village.y;
    }

    return a.village.x - b.village.x;
  });
}

  function createUiElement(tagName, className, text) {
    const element = document.createElement(tagName);

    if (className) {
      element.className = className;
    }

    if (text !== undefined && text !== null) {
      element.textContent = String(text);
    }

    return element;
  }

  function getGoalLabel(goal) {
    if (goal === "offense") return "Offense";
    return "Recruitment";
  }

  function getModeLabel(mode) {
    if (mode === "fixed") return "Keep current";
    if (mode === "inventory") return "Inventory only";
    return "Full rebuild";
  }

  function getWeightingLabel(weighting) {
    if (weighting === "freeFarm") return "Free farm";
    if (weighting === "farmCap") return "Farm cap";
    return "Equal";
  }

  function getRelicQualityClass(relic) {
    const text = cleanText((relic && (relic.quality || relic.name)) || "").toLowerCase();

    if (text.indexOf("renowned") >= 0) return "twrp-quality-renowned";
    if (text.indexOf("superior") >= 0) return "twrp-quality-superior";
    if (text.indexOf("enhanced") >= 0) return "twrp-quality-enhanced";
    if (text.indexOf("sturdy") >= 0) return "twrp-quality-sturdy";
    if (text.indexOf("shoddy") >= 0) return "twrp-quality-shoddy";

    return "twrp-quality-enhanced";
  }

  function getUiStatLabel(key) {
    return getStatCopyLabel(key);
  }

  function formatUiStatValue(stat, showPlusForPositive) {
    const sign = isCostStat(stat.key) ? "-" : (showPlusForPositive ? "+" : "");
    return sign + formatPercentCompact(stat.value) + "%";
  }

  function createStatPills(stats, showPlusForPositive) {
    const wrap = createUiElement("div", "twrp-stat-pills");
    const sorted = sortStatsForCopy(stats || []);

    if (!sorted.length) {
      wrap.appendChild(createUiElement("span", "twrp-stat-pill", "No relevant stats"));
      return wrap;
    }

    sorted.forEach(stat => {
      const pill = createUiElement("span", "twrp-stat-pill twrp-stat-" + getStatBuildingIcon(stat.key));
      const label = createUiElement("span", "twrp-stat-label", getUiStatLabel(stat.key));
      const value = createUiElement("strong", "", formatUiStatValue(stat, showPlusForPositive));
      pill.appendChild(label);
      pill.appendChild(value);
      wrap.appendChild(pill);
    });

    return wrap;
  }

  function createMetricCard(label, value, detail) {
    const card = createUiElement("div", "twrp-metric-card");
    card.appendChild(createUiElement("div", "twrp-metric-label", label));
    card.appendChild(createUiElement("div", "twrp-metric-value", value));

    if (detail) {
      card.appendChild(createUiElement("div", "twrp-metric-detail", detail));
    }

    return card;
  }

  function createSectionHeader(title, subtitle) {
    const header = createUiElement("div", "twrp-section-head");
    const left = createUiElement("div", "");
    left.appendChild(createUiElement("div", "twrp-section-title", title));

    if (subtitle) {
      left.appendChild(createUiElement("div", "twrp-section-subtitle", subtitle));
    }

    header.appendChild(left);
    return header;
  }

  function renderSummaryCards(context) {
    const impactRows = buildVillageImpactSummary(state.plan);
    const summary = createUiElement("div", "twrp-summary-grid");

    summary.appendChild(createMetricCard("Placements", state.plan.length, "recommended moves"));
    summary.appendChild(createMetricCard("Villages", state.villages.length, "loaded"));
    summary.appendChild(createMetricCard("Relics", state.inventoryRelics.length, "inventory"));
    summary.appendChild(createMetricCard("Impact", impactRows.length, "affected villages"));

    const contextBar = createUiElement("div", "twrp-context-bar");
    contextBar.appendChild(createUiElement("span", "twrp-context-pill", getGoalLabel(context.goal)));
    contextBar.appendChild(createUiElement("span", "twrp-context-pill", getModeLabel(context.mode)));
    contextBar.appendChild(createUiElement("span", "twrp-context-pill", getWeightingLabel(context.weighting)));
    contextBar.appendChild(createUiElement("span", "twrp-context-pill", getBenefitCapPillText()));

    ui.results.appendChild(summary);
    ui.results.appendChild(contextBar);
  }

  function formatVillageCoordForUi(village) {
    return village && village.coord ? village.coord : "-";
  }

  function formatVillageForUi(village) {
    const coord = formatVillageCoordForUi(village);
    const name = cleanText(village && village.name);

    if (!name || name === coord) {
      return coord;
    }

    return coord + " - " + name;
  }

  function createCoveragePreview(item) {
    const details = document.createElement("details");
    details.className = "twrp-coverage-details";

    const summary = document.createElement("summary");
    summary.textContent = item.covered.length + " covered village(s)";
    details.appendChild(summary);

    const list = createUiElement("div", "twrp-covered-list");
    item.covered.forEach(village => {
      const line = createUiElement("div", "twrp-covered-line", formatVillageForUi(village));
      list.appendChild(line);
    });

    details.appendChild(list);
    return details;
  }

  function renderPlacementCards() {
    ui.results.appendChild(createSectionHeader(
      "Recommended placements",
      "Main recommendation cards. Open coverage only when needed."
    ));

    const grid = createUiElement("div", "twrp-placement-grid");

    state.plan.forEach(item => {
      const card = createUiElement("div", "twrp-placement-card");

      const top = createUiElement("div", "twrp-placement-top");
      top.appendChild(createUiElement("div", "twrp-step-badge", item.step));

      const relic = createUiElement("div", "twrp-relic-block");
      const relicName = createUiElement("div", "twrp-relic-name " + getRelicQualityClass(item.relic), item.relic.name);
      const relicMeta = createUiElement("div", "twrp-relic-meta", getRelicRangeLabel(item.relic.range));
      relic.appendChild(relicName);
      relic.appendChild(relicMeta);
      top.appendChild(relic);

      card.appendChild(top);

      const target = createUiElement("div", "twrp-target-block");
      target.appendChild(createUiElement("div", "twrp-mini-label", "Place at"));
      target.appendChild(createUiElement("div", "twrp-target-name", formatVillageForUi(item.center)));
      card.appendChild(target);

      const scoreRow = createUiElement("div", "twrp-score-row");
      scoreRow.appendChild(createMetricCard("Score", formatScore(item.score), "value"));
      scoreRow.appendChild(createMetricCard("Coverage", item.covered.length, "villages"));
      scoreRow.appendChild(createMetricCard("Waste", formatScore(item.wastedScore), "lost value"));
      card.appendChild(scoreRow);

      card.appendChild(createStatPills(item.relevantStats, true));
      card.appendChild(createCoveragePreview(item));

      grid.appendChild(card);
    });

    ui.results.appendChild(grid);
  }

  function renderVillageImpactSummary() {
    const impactRows = buildVillageImpactSummary(state.plan);

    if (!impactRows.length) {
      return;
    }

    ui.results.appendChild(createSectionHeader(
      "Village impact",
      "Top affected villages first. Full list is collapsed to keep the UI readable."
    ));

    const preview = createUiElement("div", "twrp-impact-preview");

    impactRows.slice(0, 8).forEach((item, index) => {
      const card = createUiElement("div", "twrp-impact-card");
      const head = createUiElement("div", "twrp-impact-head");
      head.appendChild(createUiElement("strong", "", (index + 1) + ". " + formatVillageCoordForUi(item.village)));
      head.appendChild(createUiElement("span", "twrp-count-pill", item.relicCount + " relics"));
      card.appendChild(head);
      card.appendChild(createStatPills(Object.keys(item.stats || {}).map(key => ({ key: key, value: item.stats[key] })), false));
      preview.appendChild(card);
    });

    ui.results.appendChild(preview);

    const details = document.createElement("details");
    details.className = "twrp-details twrp-full-impact";

    const summary = document.createElement("summary");
    summary.textContent = "Show all " + impactRows.length + " affected village(s)";
    details.appendChild(summary);

    const tableWrap = createUiElement("div", "twrp-table-wrap");
    const table = createUiElement("table", "twrp-table twrp-compact-table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    ["#", "Village", "Relics", "Stats"].forEach(label => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    impactRows.forEach((item, index) => {
      const row = document.createElement("tr");
      appendTableCell(row, String(index + 1));
      appendTableCell(row, formatVillageCoordForUi(item.village), "twrp-left");
      appendTableCell(row, String(item.relicCount));

      const statsCell = document.createElement("td");
      statsCell.className = "twrp-left";
      statsCell.appendChild(createStatPills(Object.keys(item.stats || {}).map(key => ({ key: key, value: item.stats[key] })), false));
      row.appendChild(statsCell);

      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    details.appendChild(tableWrap);
    ui.results.appendChild(details);
  }

  function appendTableCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text;

    if (className) {
      cell.className = className;
    }

    row.appendChild(cell);
    return cell;
  }

  function renderScoringInfo() {
    const details = document.createElement("details");
    details.className = "twrp-details twrp-scoring-info";

    const summary = document.createElement("summary");
    summary.textContent = "How score and waste work";
    details.appendChild(summary);

    const body = createUiElement("div", "twrp-muted-block");
    body.textContent = "Score estimates the marginal value of a placement after the " + formatSettingNumber(getBenefitCap()) + "% cap per village/stat. Waste estimates value lost because covered villages are already capped or near capped.";
    details.appendChild(body);

    ui.results.appendChild(details);
  }

  function renderResults(context) {
    ui.results.innerHTML = "";

    renderSummaryCards(context);

    if (!state.plan.length) {
      const empty = document.createElement("div");
      empty.className = "twrp-status twrp-status-warn";
      empty.textContent = "No positive-value placements found for the selected goal/mode.";
      ui.results.appendChild(empty);
      return;
    }

    renderPlacementCards();
    renderVillageImpactSummary();
    renderScoringInfo();
  }

  function copyPlan() {
    if (!state.plan.length) {
      setStatus("No plan to copy.", "warn");
      return;
    }

    const lines = [];

    lines.push("[size=14]" + SCRIPT_NAME + " " + SCRIPT_VERSION + "[/size]");
    lines.push("");
    lines.push("[b][size=12]Relic Placements[/size][/b]");
    lines.push("");
    lines.push("[table]");
    lines.push("[**]#[||]Relic[||]Village[||]Range[||]Coverage[||]Score[||]Waste[||]Stats[/**]");

    state.plan.forEach(item => {
      const cells = [
        item.step,
        formatRelicForCopy(item.relic, item.relevantStats),
        formatVillageCoordForCopy(item.center),
        item.relic.range,
        item.covered.length,
        formatScore(item.score),
        formatScore(item.wastedScore),
        formatStatsForCopy(item.relevantStats, true)
      ];

      lines.push("[*]" + cells.join("[|]"));
    });

    lines.push("[/table]");

    const impactRows = buildVillageImpactSummary(state.plan);

    if (impactRows.length) {
      lines.push("");
      lines.push("[b][size=12]Village impact summary[/size][/b]");
      lines.push("");
      lines.push("[table]");
      lines.push("[**]#[||]Village[||]Affecting Relics[||]Stats[/**]");

      impactRows.forEach((item, index) => {
        const cells = [
          index + 1,
          formatVillageCoordForCopy(item.village),
          item.relicCount,
          formatImpactStatsForCopy(item.stats)
        ];

        lines.push("[*]" + cells.join("[|]"));
      });

      lines.push("[/table]");
    }

    const text = lines.join("\n");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => setStatus("BBCode plan copied.", "success"))
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
	
	async function setDefaultMaxRelicSlotsFromOverview(countInput, wasEditedFn) {
		try {
			const overviewUrl = buildGameUrl({
				screen: "relic_system",
				mode: "overview"
			});

			const html = await fetchHtml(overviewUrl);
			const unlockedSlots = countUnlockedRelicSlotsFromOverviewHtml(html);

			state.unlockedRelicSlots = unlockedSlots;

			if (!wasEditedFn()) {
				countInput.value = String(unlockedSlots);
				setStatus(
					"Ready. Detected " + unlockedSlots + " unlocked relic slot(s).",
					"success"
				);
			}
		} catch (err) {
			console.warn(SCRIPT_NAME + " could not detect unlocked relic slots:", err);
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
        width: 920px;
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
        grid-template-columns: 1fr 1fr 1fr 90px 80px;
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

      .twrp-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0;
      }

      .twrp-buttons .btn {
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

      .twrp-covered-list {
        margin-top: 5px;
        max-height: 160px;
        overflow-y: auto;
        font-size: 11px;
        line-height: 1.35;
        text-align: left;
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

      @media (max-width: 800px) {
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


      .twrp-summary-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin: 8px 0;
      }

      .twrp-metric-card {
        padding: 8px;
        border: 1px solid #c8a765;
        border-radius: 6px;
        background: #fffaf0;
        min-width: 0;
      }

      .twrp-metric-label,
      .twrp-mini-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.72;
        margin-bottom: 3px;
      }

      .twrp-metric-value {
        font-size: 18px;
        font-weight: bold;
        line-height: 1.1;
      }

      .twrp-metric-detail {
        font-size: 11px;
        opacity: 0.75;
        margin-top: 2px;
      }

      .twrp-context-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin: 6px 0 10px;
      }

      .twrp-context-pill,
      .twrp-count-pill {
        display: inline-block;
        padding: 3px 7px;
        border: 1px solid #c8a765;
        border-radius: 999px;
        background: #fffaf0;
        font-size: 11px;
        white-space: nowrap;
      }

      .twrp-section-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        margin: 12px 0 6px;
      }

      .twrp-section-head .twrp-section-title {
        margin: 0;
        font-size: 14px;
      }

      .twrp-section-subtitle {
        margin-top: 2px;
        font-size: 11px;
        opacity: 0.74;
      }

      .twrp-placement-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 9px;
      }

      .twrp-placement-card,
      .twrp-impact-card {
        border: 1px solid #c8a765;
        border-radius: 8px;
        background: #fff7e5;
        padding: 9px;
        box-shadow: 0 1px 0 rgba(0,0,0,0.08);
      }

      .twrp-placement-top {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin-bottom: 8px;
      }

      .twrp-step-badge {
        min-width: 24px;
        height: 24px;
        padding-top: 4px;
        border-radius: 50%;
        background: #7d510f;
        color: #fffaf0;
        font-weight: bold;
        text-align: center;
        line-height: 16px;
        flex: 0 0 auto;
      }

      .twrp-relic-block {
        min-width: 0;
      }

      .twrp-relic-name {
        font-weight: bold;
        font-size: 13px;
        line-height: 1.25;
      }

      .twrp-relic-meta {
        font-size: 11px;
        opacity: 0.75;
        margin-top: 1px;
      }

      .twrp-quality-renowned { color: #8a5a13; }
      .twrp-quality-superior { color: #5f34a3; }
      .twrp-quality-enhanced { color: #2f46a3; }
      .twrp-quality-sturdy { color: #2f855a; }
      .twrp-quality-shoddy { color: #666; }

      .twrp-target-block {
        padding: 7px;
        border-radius: 6px;
        background: rgba(255,255,255,0.55);
        border: 1px solid #ead8b3;
        margin-bottom: 8px;
      }

      .twrp-target-name {
        font-weight: bold;
        overflow-wrap: anywhere;
      }

      .twrp-score-row {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-bottom: 8px;
      }

      .twrp-score-row .twrp-metric-card {
        padding: 6px;
      }

      .twrp-score-row .twrp-metric-value {
        font-size: 14px;
      }

      .twrp-stat-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        align-items: flex-start;
      }

      .twrp-stat-pill {
        display: inline-flex;
        gap: 4px;
        align-items: center;
        padding: 4px 6px;
        border-radius: 999px;
        border: 1px solid #d4bf8f;
        background: #fffaf0;
        font-size: 11px;
        line-height: 1.15;
      }

      .twrp-stat-label {
        opacity: 0.82;
      }

      .twrp-stat-barracks { border-color: #bd8b8b; }
      .twrp-stat-stable { border-color: #8b9abd; }
      .twrp-stat-garage { border-color: #bda98b; }
      .twrp-stat-snob { border-color: #a78bbd; }

      .twrp-coverage-details {
        margin-top: 8px;
        font-size: 11px;
      }

      .twrp-coverage-details > summary {
        cursor: pointer;
        opacity: 0.82;
      }

      .twrp-covered-line {
        padding: 3px 0;
        border-bottom: 1px solid rgba(189,156,90,0.25);
      }

      .twrp-impact-preview {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 8px;
      }

      .twrp-impact-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
        margin-bottom: 7px;
      }

      .twrp-full-impact .twrp-table-wrap {
        margin-top: 8px;
      }

      .twrp-compact-table td {
        vertical-align: middle;
      }

      .twrp-muted-block {
        margin-top: 8px;
        padding: 8px;
        background: #fffaf0;
        border: 1px solid #ead8b3;
        border-radius: 6px;
        line-height: 1.4;
      }

      .twrp-scoring-info {
        margin-top: 10px;
      }

      .twrp-placement-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
      }

      .twrp-placement-card,
      .twrp-impact-card {
        padding: 5px;
        border-radius: 6px;
      }

      .twrp-placement-top {
        gap: 6px;
        margin-bottom: 4px;
      }

      .twrp-step-badge {
        min-width: 20px;
        height: 20px;
        padding-top: 2px;
        font-size: 11px;
        line-height: 16px;
      }

      .twrp-relic-name {
        font-size: 12px;
        line-height: 1.15;
      }

      .twrp-relic-meta {
        font-size: 10px;
      }

      .twrp-target-block {
        padding: 4px 5px;
        margin-bottom: 4px;
      }

      .twrp-target-name {
        font-size: 10px;
      }

      .twrp-score-row {
        gap: 4px;
        margin-bottom: 5px;
      }

      .twrp-score-row .twrp-metric-card {
        padding: 4px;
      }

      .twrp-score-row .twrp-metric-label {
        font-size: 9px;
        margin-bottom: 1px;
      }

      .twrp-score-row .twrp-metric-value {
        font-size: 13px;
      }

      .twrp-score-row .twrp-metric-detail {
        display: none;
      }

      .twrp-stat-pill {
        padding: 3px 5px;
        font-size: 10px;
      }

      .twrp-coverage-details {
        margin-top: 4px;
      }

      .twrp-covered-line {
        padding: 2px 0;
      }

      @media (max-width: 1100px) {
        .twrp-placement-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 800px) {
        .twrp-summary-grid,
        .twrp-placement-grid,
        .twrp-impact-preview {
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

    window.twacticsRelicPlannerV2Loaded = false;
    delete window.twacticsRelicPlannerV2;

    console.log(SCRIPT_NAME + " closed");
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
    help.innerHTML =
      "<strong>Plan relic placements.</strong> Choose goal, simulation mode and weighting. " +
      "Click optimize, review the cards, then copy the BBCode plan when it looks right.";

    const grid = document.createElement("div");
    grid.className = "twrp-grid";

    const goalWrap = document.createElement("div");
    const goalLabel = document.createElement("label");
    goalLabel.className = "twrp-label";
    goalLabel.textContent = "Goal";

    const goalSelect = document.createElement("select");
    goalSelect.className = "twrp-select";

    [
      { value: "recruitment", text: "Recruitment output" },
      { value: "offense", text: "Offensive strength" }
    ].forEach(optionData => {
      const option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.text;
      goalSelect.appendChild(option);
    });

    goalWrap.appendChild(goalLabel);
    goalWrap.appendChild(goalSelect);

    const modeWrap = document.createElement("div");
    const modeLabel = document.createElement("label");
    modeLabel.className = "twrp-label";
    modeLabel.textContent = "Simulation mode";

    const modeSelect = document.createElement("select");
    modeSelect.className = "twrp-select";

    [
      { value: "fixed", text: "Keep current placements fixed" },
      { value: "inventory", text: "Inventory only" },
      { value: "rebuild", text: "Full rebuild simulation" }
    ].forEach(optionData => {
      const option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.text;
      modeSelect.appendChild(option);
    });
		
		modeSelect.value = "rebuild";

    modeWrap.appendChild(modeLabel);
    modeWrap.appendChild(modeSelect);

    const weightWrap = document.createElement("div");
    const weightLabel = document.createElement("label");
    weightLabel.className = "twrp-label";
    weightLabel.textContent = "Village weighting";

    const weightSelect = document.createElement("select");
    weightSelect.className = "twrp-select";

    [
      { value: "farmCap", text: "Farm capacity" },
      { value: "freeFarm", text: "Free farm" },
      { value: "equal", text: "Equal weight" }
    ].forEach(optionData => {
      const option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.text;
      weightSelect.appendChild(option);
    });
		
		weightSelect.value = "freeFarm";

		goalSelect.addEventListener("change", function () {
			if (goalSelect.value === "recruitment") {
				weightSelect.value = "freeFarm";
			}

			if (goalSelect.value === "offense") {
				weightSelect.value = "equal";
			}
		});

    weightWrap.appendChild(weightLabel);
    weightWrap.appendChild(weightSelect);

    const countWrap = document.createElement("div");
    const countLabel = document.createElement("label");
    countLabel.className = "twrp-label";
    countLabel.textContent = "Relic Slots";

    const countInput = document.createElement("input");
    countInput.className = "twrp-input";
    countInput.type = "number";
    countInput.min = "1";
    countInput.max = "10";
		countInput.value = String(state.unlockedRelicSlots || 10);
		
		let countInputWasEdited = false;

		countInput.addEventListener("input", function () {
			countInputWasEdited = true;
		});

    countWrap.appendChild(countLabel);
    countWrap.appendChild(countInput);

    const capWrap = document.createElement("div");
    const capLabel = document.createElement("label");
    capLabel.className = "twrp-label";
    capLabel.textContent = "Cap %";

    const capInput = document.createElement("input");
    capInput.className = "twrp-input";
    capInput.type = "number";
    capInput.min = "1";
    capInput.max = "100";
    capInput.step = "0.1";
    capInput.value = formatSettingNumber(getBenefitCap());

    capInput.addEventListener("input", function () {
      ui.capInputWasEdited = true;
      applyBenefitCapInputToState();
    });

    capWrap.appendChild(capLabel);
    capWrap.appendChild(capInput);

    grid.appendChild(goalWrap);
    grid.appendChild(modeWrap);
    grid.appendChild(weightWrap);
    grid.appendChild(countWrap);
    grid.appendChild(capWrap);

    const buttons = document.createElement("div");
    buttons.className = "twrp-buttons";

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "btn";
    loadButton.textContent = "Load data + optimize";
    loadButton.addEventListener("click", loadAndOptimize);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "btn";
    copyButton.textContent = "Copy plan";
    copyButton.addEventListener("click", copyPlan);

    buttons.appendChild(loadButton);
    buttons.appendChild(copyButton);

    const status = document.createElement("div");
    status.className = "twrp-status";
    status.textContent = "Ready. Choose goal/mode and click Load data + optimize.";

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

    ui.goalSelect = goalSelect;
		ui.modeSelect = modeSelect;
		ui.weightSelect = weightSelect;
		ui.countInput = countInput;
    ui.capInput = capInput;
    ui.capInputWasEdited = false;
		ui.loadButton = loadButton;
		ui.copyButton = copyButton;
		ui.status = status;
		ui.results = results;

		setDefaultMaxRelicSlotsFromOverview(countInput, function () {
			return countInputWasEdited;
		});

		makeDraggable(box, header);
  }

  createDialog();

  console.log(SCRIPT_NAME + " " + SCRIPT_VERSION + " loaded");
})();
