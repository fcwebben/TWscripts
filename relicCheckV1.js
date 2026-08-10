/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Relic Inventory Audit
 *
 * Temporary diagnostic script.
 * Reads only Treasury -> Inventory data and lists every relic returned by
 * RelicSystem.Inventory.init, including raw IDs, equipped fields and stats.
 *
 * This script does NOT equip, remove, upgrade, trade or reroll relics.
 * It does not send troops and does not auto-click game actions.
 */
(function () {
  "use strict";

  if (window.twacticsRelicInventoryAuditLoaded) {
    console.log("Twactics Relic Inventory Audit already loaded");
    return;
  }

  window.twacticsRelicInventoryAuditLoaded = true;

  const SCRIPT_NAME = "Twactics Relic Inventory Audit";
  const SCRIPT_VERSION = "v1.0.0";
  const BOX_ID = "twactics-relic-inventory-audit";
  const STYLE_ID = "twactics-relic-inventory-audit-style";

  const state = {
    rawRelics: [],
    relics: [],
    inventoryUrl: ""
  };

  window.twacticsRelicInventoryAudit = {
    state: state,
    close: closeDialog,
    refresh: loadInventory
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
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.set(key, String(params[key]));
      }
    });

    return url.pathname + url.search;
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

  function extractInventoryRelicsRawFromHtml(html) {
    const doc = parseHtml(html);
    const scripts = Array.from(doc.querySelectorAll("script"));
    const relics = [];
    let foundMarker = false;

    scripts.forEach(script => {
      const source = script.textContent || "";
      const marker = "RelicSystem.Inventory.init";

      if (!source.includes(marker)) return;

      foundMarker = true;

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

    return {
      foundMarker: foundMarker,
      relics: relics
    };
  }

  function getPercentValue(text) {
    const valueMatch = cleanText(text).match(/([+-]?\d+(?:[.,]\d+)?)\s*%/);

    if (!valueMatch) return null;

    return Math.abs(parseFloat(valueMatch[1].replace(",", ".")));
  }

  function getStatText(stat) {
    return cleanText(
      (stat && stat.name) ||
      (stat && stat.benefit && stat.benefit.description) ||
      (stat && stat.description) ||
      ""
    );
  }

  function normalizeSearchText(value) {
    return cleanText(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function guessStatKey(stat, relicType, text) {
    const normalizedText = normalizeSearchText(text);
    const effectType = stat && stat.effect_type ? String(stat.effect_type) : "";
    const statId = stat && stat.id !== undefined && stat.id !== null ? String(stat.id) : "";
    const type = cleanText((stat && stat.type) || relicType).toLowerCase();

    if (normalizedText.includes("merchant") || normalizedText.includes("trader") || normalizedText.includes("haendler") || normalizedText.includes("handler")) {
      if (normalizedText.includes("travel") || normalizedText.includes("speed")) return "merchant_travel_speed";
      if (normalizedText.includes("capacity") || normalizedText.includes("carry") || normalizedText.includes("haul")) return "merchant_capacity";
    }

    if (normalizedText.includes("haul capacity")) return "haul_capacity";

    if (effectType || statId || type) {
      return [effectType, statId ? "id_" + statId : "", type].filter(Boolean).join("/");
    }

    return "";
  }

  function normalizeStatEntry(stat, source, relicType, index) {
    const text = getStatText(stat);
    const value = getPercentValue(text);

    return {
      source: source,
      index: index,
      id: stat && stat.id !== undefined && stat.id !== null ? String(stat.id) : "",
      type: stat && stat.type !== undefined && stat.type !== null ? String(stat.type) : "",
      effect_type: stat && stat.effect_type !== undefined && stat.effect_type !== null ? String(stat.effect_type) : "",
      value: value,
      text: text,
      guessedKey: guessStatKey(stat, relicType, text),
      perfect: stat && stat.perfect === true,
      raw: stat || null
    };
  }

  function normalizeInventoryRelic(raw) {
    const relicType = raw && raw.type ? String(raw.type) : "";
    const stats = [];

    if (raw && raw.main_stat) {
      stats.push(normalizeStatEntry(raw.main_stat, "main", relicType, 0));
    }

    (raw && raw.sub_stats || []).forEach((subStat, index) => {
      if (!subStat) return;
      stats.push(normalizeStatEntry(subStat, "sub", relicType, index));
    });

    const villageId = raw && raw.village_id !== undefined && raw.village_id !== null ? String(raw.village_id) : "";
    const equippedAt = raw && raw.equipped_at !== undefined && raw.equipped_at !== null ? String(raw.equipped_at) : "";

    return {
      id: raw && raw.id !== undefined && raw.id !== null ? String(raw.id) : "",
      name: cleanText(raw && raw.name || ""),
      type: relicType,
      quality: cleanText(raw && raw.quality || ""),
      range: raw && raw.range !== undefined && raw.range !== null ? String(raw.range) : "",
      villageId: villageId,
      equippedAt: equippedAt,
      status: villageId || equippedAt ? "equipped-field-present" : "inventory-only",
      stats: stats,
      raw: raw
    };
  }

  function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return "";
    const rounded = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    return (Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "")) + "%";
  }

  function formatStats(stats) {
    if (!stats || !stats.length) return "-";

    return stats.map(stat => {
      const parts = [];
      parts.push(stat.source + (stat.source === "sub" ? " #" + (stat.index + 1) : ""));
      if (stat.id) parts.push("id=" + stat.id);
      if (stat.effect_type) parts.push("effect=" + stat.effect_type);
      if (stat.type) parts.push("type=" + stat.type);
      if (stat.guessedKey) parts.push("key=" + stat.guessedKey);
      if (stat.value !== null && stat.value !== undefined && !isNaN(stat.value)) parts.push("value=" + formatPercent(stat.value));
      if (stat.perfect) parts.push("perfect=true");

      return parts.join(" | ") + "\n" + (stat.text || "-");
    }).join("\n\n");
  }

  function getShortRaw(raw) {
    if (!raw) return "";

    const copy = {
      id: raw.id,
      name: raw.name,
      type: raw.type,
      quality: raw.quality,
      range: raw.range,
      village_id: raw.village_id,
      equipped_at: raw.equipped_at,
      main_stat: raw.main_stat,
      sub_stats: raw.sub_stats
    };

    return JSON.stringify(copy, null, 2);
  }

  function toFlatRows() {
    return state.relics.map(relic => ({
      id: relic.id,
      name: relic.name,
      type: relic.type,
      quality: relic.quality,
      range: relic.range,
      status: relic.status,
      village_id: relic.villageId,
      equipped_at: relic.equippedAt,
      stats: relic.stats.map(stat => [
        stat.source,
        stat.id ? "id=" + stat.id : "",
        stat.effect_type ? "effect=" + stat.effect_type : "",
        stat.type ? "type=" + stat.type : "",
        stat.guessedKey ? "key=" + stat.guessedKey : "",
        stat.value !== null && stat.value !== undefined && !isNaN(stat.value) ? "value=" + formatPercent(stat.value) : "",
        stat.text
      ].filter(Boolean).join(" | ")).join(" || ")
    }));
  }

  function copyText(text, successMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => setStatus(successMessage, "success"))
        .catch(() => fallbackCopy(text, successMessage));
      return;
    }

    fallbackCopy(text, successMessage);
  }

  function fallbackCopy(text, successMessage) {
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
    setStatus(copied ? successMessage : "Could not copy.", copied ? "success" : "error");
  }

  function copyJson() {
    copyText(JSON.stringify(state.relics, null, 2), "Inventory relic JSON copied.");
  }

  function copyTsv() {
    const rows = toFlatRows();
    const headers = ["id", "name", "type", "quality", "range", "status", "village_id", "equipped_at", "stats"];
    const lines = [headers.join("\t")];

    rows.forEach(row => {
      lines.push(headers.map(header => String(row[header] || "").replace(/\t/g, " ").replace(/\n/g, " ")).join("\t"));
    });

    copyText(lines.join("\n"), "Inventory relic TSV copied.");
  }

  function setStatus(message, type) {
    const status = document.querySelector("#" + BOX_ID + " .twira-status");
    if (!status) return;

    status.className = "twira-status" + (type ? " twira-status-" + type : "");
    status.textContent = message || "";
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
        width: 980px;
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

      #${BOX_ID} * { box-sizing: border-box; }

      .twira-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 9px 11px;
        background: #cfa95e;
        border-bottom: 1px solid #7d510f;
        cursor: move;
      }

      .twira-title { font-weight: bold; font-size: 15px; }

      .twira-close {
        width: 20px;
        height: 20px;
        border: 1px solid #7d510f;
        background: #f4e4bc;
        color: #2f1b00;
        border-radius: 3px;
        cursor: pointer;
        font-weight: bold;
      }

      .twira-body {
        padding: 10px;
        max-height: calc(86vh - 42px);
        overflow-y: auto;
      }

      .twira-help {
        line-height: 1.35;
        margin-bottom: 8px;
      }

      .twira-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0;
      }

      .twira-buttons .btn { cursor: pointer; }

      .twira-status {
        padding: 6px;
        margin: 8px 0;
        border: 1px solid #bd9c5a;
        background: #fff4d5;
        border-radius: 4px;
      }

      .twira-status-success { background: #dff0d8; }
      .twira-status-warn { background: #fff4d5; }
      .twira-status-error { background: #f2dede; }

      .twira-summary-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin: 8px 0;
      }

      .twira-metric {
        padding: 8px;
        border: 1px solid #c8a765;
        border-radius: 6px;
        background: #fffaf0;
      }

      .twira-metric-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.72;
        margin-bottom: 3px;
      }

      .twira-metric-value {
        font-size: 18px;
        font-weight: bold;
        line-height: 1.1;
      }

      .twira-table-wrap {
        max-height: 520px;
        overflow: auto;
        border: 1px solid #bd9c5a;
        margin-top: 8px;
      }

      .twira-table {
        border-collapse: collapse;
        width: 100%;
      }

      .twira-table th {
        background: #cfa95e;
        border: 1px solid #bd9c5a;
        padding: 5px;
        text-align: center;
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .twira-table td {
        border: 1px solid #bd9c5a;
        padding: 5px;
        text-align: center;
        background: #fff5da;
        vertical-align: top;
      }

      .twira-table tr:nth-child(even) td { background: #f0e2be; }
      .twira-left { text-align: left !important; }
      .twira-mono { font-family: Consolas, Menlo, monospace; font-size: 11px; white-space: pre-wrap; }
      .twira-equipped td { background: #fde2e2 !important; }
      .twira-inventory td { background: #e7f5e7 !important; }

      .twira-note {
        margin-top: 8px;
        padding: 8px;
        background: #fffaf0;
        border: 1px solid #ead8b3;
        border-radius: 6px;
        line-height: 1.4;
      }

      @media (max-width: 800px) {
        #${BOX_ID} {
          top: 50px;
          left: 5px;
          right: 5px;
          width: auto;
        }
        .twira-summary-grid { grid-template-columns: 1fr; }
      }
    `;

    document.head.appendChild(style);
  }

  function createMetric(label, value) {
    return "<div class='twira-metric'><div class='twira-metric-label'>" + escapeHtml(label) + "</div><div class='twira-metric-value'>" + escapeHtml(value) + "</div></div>";
  }

  function render() {
    const body = document.querySelector("#" + BOX_ID + " .twira-results");
    if (!body) return;

    const total = state.relics.length;
    const equippedLike = state.relics.filter(relic => relic.status === "equipped-field-present").length;
    const inventoryOnly = state.relics.filter(relic => relic.status === "inventory-only").length;
    const ids = state.relics.map(relic => relic.id).filter(Boolean);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

    let html = "";
    html += "<div class='twira-summary-grid'>";
    html += createMetric("Total returned", total);
    html += createMetric("Inventory-only", inventoryOnly);
    html += createMetric("Equipped fields", equippedLike);
    html += createMetric("Duplicate IDs", Array.from(new Set(duplicateIds)).length);
    html += "</div>";

    html += "<div class='twira-note'>";
    html += "Rows marked <strong>equipped-field-present</strong> were returned by <code>RelicSystem.Inventory.init</code> but also had <code>village_id</code> or <code>equipped_at</code>. If those rows exist, equipped relics are present in the inventory JSON and the planner must filter or dedupe against overview more strictly.";
    html += "</div>";

    html += "<div class='twira-table-wrap'><table class='twira-table'>";
    html += "<thead><tr>";
    ["#", "ID", "Name", "Type", "Quality", "Range", "Status", "Village ID", "Equipped at", "Stats", "Raw core"].forEach(label => {
      html += "<th>" + escapeHtml(label) + "</th>";
    });
    html += "</tr></thead><tbody>";

    state.relics.forEach((relic, index) => {
      const rowClass = relic.status === "equipped-field-present" ? "twira-equipped" : "twira-inventory";
      html += "<tr class='" + rowClass + "'>";
      html += "<td>" + (index + 1) + "</td>";
      html += "<td class='twira-mono'>" + escapeHtml(relic.id) + "</td>";
      html += "<td class='twira-left'>" + escapeHtml(relic.name) + "</td>";
      html += "<td>" + escapeHtml(relic.type) + "</td>";
      html += "<td>" + escapeHtml(relic.quality) + "</td>";
      html += "<td>" + escapeHtml(relic.range) + "</td>";
      html += "<td>" + escapeHtml(relic.status) + "</td>";
      html += "<td class='twira-mono'>" + escapeHtml(relic.villageId) + "</td>";
      html += "<td class='twira-mono'>" + escapeHtml(relic.equippedAt) + "</td>";
      html += "<td class='twira-left twira-mono'>" + escapeHtml(formatStats(relic.stats)) + "</td>";
      html += "<td class='twira-left twira-mono'>" + escapeHtml(getShortRaw(relic.raw)) + "</td>";
      html += "</tr>";
    });

    if (!state.relics.length) {
      html += "<tr><td colspan='11'>No relics returned from inventory JSON.</td></tr>";
    }

    html += "</tbody></table></div>";
    body.innerHTML = html;
  }

  async function loadInventory() {
    try {
      setStatus("Loading Treasury Inventory JSON...", "warn");

      const inventoryUrl = buildGameUrl({
        screen: "relic_system",
        mode: "inventory"
      });

      state.inventoryUrl = inventoryUrl;
      const html = await fetchHtml(inventoryUrl);
      const extracted = extractInventoryRelicsRawFromHtml(html);

      state.rawRelics = extracted.relics || [];
      state.relics = state.rawRelics.map(normalizeInventoryRelic);

      window.twacticsRelicInventoryAuditData = {
        inventoryUrl: state.inventoryUrl,
        rawRelics: state.rawRelics,
        relics: state.relics,
        flatRows: toFlatRows()
      };

      console.log(SCRIPT_NAME + " " + SCRIPT_VERSION + " inventory URL:", state.inventoryUrl);
      console.log(SCRIPT_NAME + " marker found:", extracted.foundMarker);
      console.log(SCRIPT_NAME + " raw inventory relics:", state.rawRelics);
      console.table(toFlatRows());

      render();

      setStatus(
        "Loaded " + state.relics.length + " relic(s) from RelicSystem.Inventory.init. " +
        "Check red rows for equipped fields. Data also available at window.twacticsRelicInventoryAuditData.",
        "success"
      );
    } catch (err) {
      console.error(SCRIPT_NAME + " failed:", err);
      setStatus(err.message || String(err), "error");
    }
  }

  function makeDraggable(box, handle) {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("mousedown", function (event) {
      if (event.target.classList.contains("twira-close")) return;

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

    window.twacticsRelicInventoryAuditLoaded = false;
    delete window.twacticsRelicInventoryAudit;

    console.log(SCRIPT_NAME + " closed");
  }

  function createDialog() {
    addStyles();

    const old = document.getElementById(BOX_ID);
    if (old) old.remove();

    const box = document.createElement("div");
    box.id = BOX_ID;

    const header = document.createElement("div");
    header.className = "twira-header";

    const title = document.createElement("div");
    title.className = "twira-title";
    title.textContent = SCRIPT_NAME + " " + SCRIPT_VERSION;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "twira-close";
    closeButton.textContent = "x";
    closeButton.addEventListener("click", closeDialog);

    header.appendChild(title);
    header.appendChild(closeButton);

    const body = document.createElement("div");
    body.className = "twira-body";
    body.innerHTML =
      "<div class='twira-help'><strong>Inventory audit only.</strong> Fetches Treasury Inventory and lists every relic returned by <code>RelicSystem.Inventory.init</code>, including ID, stats, <code>village_id</code> and <code>equipped_at</code>. It performs no game actions.</div>" +
      "<div class='twira-buttons'>" +
      "<button type='button' class='btn' data-action='refresh'>Refresh inventory</button>" +
      "<button type='button' class='btn' data-action='copy-json'>Copy JSON</button>" +
      "<button type='button' class='btn' data-action='copy-tsv'>Copy TSV</button>" +
      "</div>" +
      "<div class='twira-status twira-status-warn'>Ready.</div>" +
      "<div class='twira-results'></div>";

    box.appendChild(header);
    box.appendChild(body);
    document.body.appendChild(box);

    body.querySelector("[data-action='refresh']").addEventListener("click", loadInventory);
    body.querySelector("[data-action='copy-json']").addEventListener("click", copyJson);
    body.querySelector("[data-action='copy-tsv']").addEventListener("click", copyTsv);

    makeDraggable(box, header);
  }

  createDialog();
  loadInventory();
})();
