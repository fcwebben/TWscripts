/*
 * Copyright (c) 2026 Twactics
 * License: MIT
 *
 * Twactics Long Construction Queue
 *
 * Shows the top 20 individual building orders with the longest estimated build duration across villages.
 * The script reads the Buildings overview and checks every queued building order in each village.
 *
 * This script:
 * - Reads visible/loaded construction queue data from Overview -> Buildings
 * - Checks every queued building order, not only the first order in the queue
 * - Estimates each queue item's own build duration from the finish-time gap inside the village queue
 * - Sorts results by longest estimated build duration first
 *
 * This script does NOT:
 * - Start, cancel, reorder, or confirm construction orders
 * - Send attacks, support, or troops
 * - Auto-click game actions
 * - Use external servers or external files
 */
(function () {
  "use strict";

  const SCRIPT_NAME = "Twactics Long Construction Queue";
  const SCRIPT_VERSION = "v1.0.3";
  const BOX_ID = "twactics-long-construction-queue";
  const STYLE_ID = "twactics-long-construction-queue-style";
  const DEFAULT_MAX_ROWS = 20;

  const TIME_SOURCE = "individual-build-duration";

  const state = {
    rows: [],
    maxRows: DEFAULT_MAX_ROWS,
    sourceUrl: ""
  };

  const ui = {};

  if (window.twacticsLongConstructionQueue && typeof window.twacticsLongConstructionQueue.close === "function") {
    window.twacticsLongConstructionQueue.close();
  }

  window.twacticsLongConstructionQueue = {
    state: state,
    close: closeWidget,
    reload: loadAndRender
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

  function parseServerNow() {
    const serverDate = cleanText(document.querySelector("#serverDate") && document.querySelector("#serverDate").textContent);
    const serverTime = cleanText(document.querySelector("#serverTime") && document.querySelector("#serverTime").textContent);

    const dateMatch = serverDate.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
    const timeMatch = serverTime.match(/(\d{1,2}):(\d{2}):(\d{2})/);

    if (dateMatch && timeMatch) {
      const day = parseInt(dateMatch[1], 10);
      const month = parseInt(dateMatch[2], 10);
      let year = parseInt(dateMatch[3], 10);
      if (year < 100) year += 2000;

      return new Date(
        year,
        month - 1,
        day,
        parseInt(timeMatch[1], 10),
        parseInt(timeMatch[2], 10),
        parseInt(timeMatch[3], 10)
      );
    }

    return new Date();
  }

  function getLangValue(key, fallback) {
    if (window.lang && window.lang[key]) return String(window.lang[key]);
    return fallback;
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function patternToRegex(pattern, mode) {
    const timeSource = "(\\d{1,2}:\\d{2}(?::\\d{2})?(?::\\d{1,3})?)";
    const dateSource = "(\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?\\.?)";

    let escaped = escapeRegExp(pattern || "");

    if (mode === "relative") {
      escaped = escaped.replace(/%s/g, timeSource);
    } else {
      escaped = escaped.replace(/%1/g, dateSource).replace(/%2/g, timeSource);
    }

    return new RegExp(escaped, "i");
  }

  function normalizeSearchText(value) {
    return cleanText(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function includesAny(text, aliases) {
    const haystack = normalizeSearchText(text);
    return (aliases || []).some(alias => haystack.indexOf(normalizeSearchText(alias)) >= 0);
  }

  function parseTimeParts(timeText) {
    const match = String(timeText || "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?::\d{1,3})?/);
    if (!match) return null;

    return {
      hours: parseInt(match[1], 10),
      minutes: parseInt(match[2], 10),
      seconds: match[3] !== undefined ? parseInt(match[3], 10) : 0
    };
  }

  function buildDateWithTime(baseDate, timeText, dayOffset) {
    const parts = parseTimeParts(timeText);
    if (!parts) return null;

    const date = new Date(baseDate.getTime());
    date.setDate(date.getDate() + (dayOffset || 0));
    date.setHours(parts.hours, parts.minutes, parts.seconds, 0);
    return date;
  }

  function parseExplicitDateWithTime(baseDate, dateText, timeText) {
    const parts = parseTimeParts(timeText);
    if (!parts) return null;

    const match = String(dateText || "").match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
    if (!match) return null;

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    let year = match[3] ? parseInt(match[3], 10) : baseDate.getFullYear();
    if (year < 100) year += 2000;

    const date = new Date(year, month - 1, day, parts.hours, parts.minutes, parts.seconds, 0);

    if (date.getTime() < baseDate.getTime() - 86400000) {
      date.setFullYear(date.getFullYear() + 1);
    }

    return date;
  }

  function parseFinishDate(finishText, serverNow) {
    const text = cleanText(finishText);

    if (!text) return null;

    const todayPattern = getLangValue("aea2b0aa9ae1534226518faaefffdaad", "today at %s");
    const tomorrowPattern = getLangValue("57d28d1b211fddbb7a499ead5bf23079", "tomorrow at %s");
    const laterPattern = getLangValue("0cb274c906d622fa8ce524bcfbb7552d", "on %1 at %2");

    let match = text.match(patternToRegex(todayPattern, "relative"));
    if (match && match[1]) {
      return buildDateWithTime(serverNow, match[1], 0);
    }

    match = text.match(patternToRegex(tomorrowPattern, "relative"));
    if (match && match[1]) {
      return buildDateWithTime(serverNow, match[1], 1);
    }

    match = text.match(patternToRegex(laterPattern, "explicit"));
    if (match && match[1] && match[2]) {
      return parseExplicitDateWithTime(serverNow, match[1], match[2]);
    }

    const timeMatch = text.match(/(\d{1,2}:\d{2}(?::\d{2})?(?::\d{1,3})?)/);
    const dateMatch = text.match(/(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\.?)/);

    if (dateMatch && timeMatch) {
      return parseExplicitDateWithTime(serverNow, dateMatch[1], timeMatch[1]);
    }

    const todayAliases = ["today", "idag", "heute", "ma", "aujourd", "hoy", "oggi", "dzis", "dziś", "vandaag", "bugun", "bugün"];
    const tomorrowAliases = ["tomorrow", "imorgon", "morgen", "holnap", "demain", "mañana", "manana", "amanha", "amanhã", "domani", "jutro", "yarin", "yarın"];

    if (timeMatch && includesAny(text, todayAliases)) {
      return buildDateWithTime(serverNow, timeMatch[1], 0);
    }

    if (timeMatch && includesAny(text, tomorrowAliases)) {
      return buildDateWithTime(serverNow, timeMatch[1], 1);
    }

    if (timeMatch) {
      const today = buildDateWithTime(serverNow, timeMatch[1], 0);
      if (today && today.getTime() >= serverNow.getTime() - 30000) return today;
      return buildDateWithTime(serverNow, timeMatch[1], 1);
    }

    return null;
  }

  function splitConstructionTitle(title) {
    const text = cleanText(title);
    const parts = text.split(/\s+-\s+/);

    if (parts.length >= 2) {
      return {
        building: cleanText(parts[0]),
        finishText: cleanText(parts.slice(1).join(" - "))
      };
    }

    return {
      building: text,
      finishText: text
    };
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds || 0)));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    const parts = [];
    if (days) parts.push(days + "d");
    if (hours || days) parts.push(hours + "h");
    if (minutes || hours || days) parts.push(minutes + "m");
    if (!days && !hours) parts.push(secs + "s");
    return parts.join(" ");
  }

  function formatDateTime(date) {
    if (!date) return "-";

    function pad(value) {
      return String(value).padStart(2, "0");
    }

    return pad(date.getDate()) + "/" + pad(date.getMonth() + 1) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function getVillageDataFromRow(row) {
    const id = String(row.getAttribute("id") || "").replace(/^v_/, "");
    const villageLink =
      row.querySelector('a[href*="screen=main"][href*="village="]') ||
      row.querySelector('a[href*="screen=overview"][href*="village="]') ||
      row.querySelector('a[href*="village="]');

    const name = cleanText(villageLink ? villageLink.textContent : "Village " + id);
    const href = villageLink ? villageLink.getAttribute("href") : buildGameUrl({ village: id, screen: "main" });
    const villageId = id || getParam("village", href) || "";

    return {
      id: villageId,
      name: name,
      href: href
    };
  }

  function getQueuePosition(img, fallbackIndex) {
    const order = img.closest && img.closest('[id^="order_"]');
    const match = order && String(order.id || "").match(/order_(\d+)/);

    if (match) {
      return parseInt(match[1], 10) + 1;
    }

    return fallbackIndex + 1;
  }

  function collectConstructionOrdersFromDoc(doc, serverNow) {
    const rows = [];
    const seen = new Set();
    const serverTimestamp = serverNow.getTime();

    Array.from(doc.querySelectorAll("#villages tr.vrow")).forEach(row => {
      const village = getVillageDataFromRow(row);
      const images = Array.from(row.querySelectorAll('.order_queue .queue_icon img[data-title], .order_queue .queue_icon img[title], .order_queue img[data-title], .order_queue img[title]'));
      const queueItems = [];

      images.forEach((img, index) => {
        const title = img.getAttribute("data-title") || img.getAttribute("title") || "";
        const parsed = splitConstructionTitle(title);
        const finishDate = parseFinishDate(parsed.finishText, serverNow);

        if (!finishDate) return;

        const remainingSeconds = Math.round((finishDate.getTime() - serverTimestamp) / 1000);
        if (remainingSeconds <= 0) return;

        queueItems.push({
          villageId: village.id,
          villageName: village.name,
          villageHref: village.href,
          queuePosition: getQueuePosition(img, index),
          building: parsed.building,
          finishText: parsed.finishText,
          finishDate: finishDate,
          finishTimestamp: finishDate.getTime(),
          remainingSeconds: remainingSeconds,
          remainingHours: remainingSeconds / 3600,
          imageSrc: img.getAttribute("src") || ""
        });
      });

      queueItems
        .sort((a, b) => {
          if (a.queuePosition !== b.queuePosition) return a.queuePosition - b.queuePosition;
          return a.finishTimestamp - b.finishTimestamp;
        })
        .forEach((item, index, orderedItems) => {
          const previousFinishTimestamp = index > 0
            ? orderedItems[index - 1].finishTimestamp
            : serverTimestamp;
          const buildDurationSeconds = Math.max(0, Math.round((item.finishTimestamp - previousFinishTimestamp) / 1000));

          if (buildDurationSeconds <= 0) return;

          const key = [item.villageId, item.queuePosition, item.building, item.finishTimestamp].join("|");

          if (seen.has(key)) return;
          seen.add(key);

          rows.push(Object.assign({}, item, {
            buildDurationSeconds: buildDurationSeconds,
            buildDurationHours: buildDurationSeconds / 3600
          }));
        });
    });

    return rows;
  }

  function mergeRows(primaryRows, secondaryRows) {
    const merged = [];
    const seen = new Set();

    (primaryRows || []).concat(secondaryRows || []).forEach(item => {
      const key = [
        item.villageId || item.villageName || "",
        item.queuePosition || "",
        item.building || "",
        item.finishTimestamp || ""
      ].join("|");

      if (seen.has(key)) return;
      seen.add(key);
      merged.push(item);
    });

    return merged;
  }

  async function loadConstructionRows() {
    const url = buildGameUrl({
      screen: "overview_villages",
      mode: "buildings",
      page: -1
    });

    state.sourceUrl = url;

    const serverNow = parseServerNow();
    const currentRows = collectConstructionOrdersFromDoc(document, serverNow);

    try {
      const html = await fetchHtml(url);
      const doc = parseHtml(html);
      const fetchedRows = collectConstructionOrdersFromDoc(doc, serverNow);

      if (fetchedRows.length || !currentRows.length) {
        return mergeRows(fetchedRows, currentRows);
      }
    } catch (err) {
      console.warn(SCRIPT_NAME + " could not load all-pages Buildings overview, using current page instead:", err);
    }

    return currentRows;
  }

  function getBuildDurationSeconds(item) {
    if (item && item.buildDurationSeconds !== undefined && item.buildDurationSeconds !== null) {
      return Number(item.buildDurationSeconds) || 0;
    }

    return Number(item && item.remainingSeconds) || 0;
  }

  function getDisplayRows(rows) {
    return (rows || [])
      .slice()
      .sort((a, b) => {
        const diff = getBuildDurationSeconds(b) - getBuildDurationSeconds(a);
        if (diff !== 0) return diff;
        return (b.remainingSeconds || 0) - (a.remainingSeconds || 0);
      })
      .slice(0, state.maxRows || DEFAULT_MAX_ROWS);
  }

  function getRowClass(item, index) {
    if (index < 5) return "twlcq-row-critical";
    if (index < 10) return "twlcq-row-warning";
    return "";
  }

  function renderRows(rows) {
    const sorted = (rows || []).slice().sort((a, b) => {
      const diff = getBuildDurationSeconds(b) - getBuildDurationSeconds(a);
      if (diff !== 0) return diff;
      return (b.remainingSeconds || 0) - (a.remainingSeconds || 0);
    });
    const displayRows = getDisplayRows(rows);
    const villageCount = new Set(displayRows.map(item => item.villageId || item.villageName)).size;

    ui.results.innerHTML = "";

    const summary = document.createElement("div");
    summary.className = "twlcq-summary";
    summary.innerHTML =
      "Showing the <strong>" + displayRows.length + "</strong> building order(s) with the longest estimated build duration" +
      " from <strong>" + sorted.length + "</strong> total queued order(s)" +
      " in <strong>" + villageCount + "</strong> village(s). " +
      "<span class='twlcq-muted'>Sorted by the building order's own duration, not by queue position or final finish time.</span>";
    ui.results.appendChild(summary);

    if (!displayRows.length) {
      const empty = document.createElement("div");
      empty.className = "twlcq-status twlcq-status-warn";
      empty.textContent = "No queued building orders found.";
      ui.results.appendChild(empty);
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "twlcq-table-wrap";

    const table = document.createElement("table");
    table.className = "twlcq-table";
    table.innerHTML =
      "<thead>" +
        "<tr>" +
          "<th>#</th>" +
          "<th class='twlcq-left'>Village</th>" +
          "<th>Queue</th>" +
          "<th class='twlcq-left'>Building</th>" +
          "<th>Build duration</th>" +
          "<th>Finish time</th>" +
          "<th>Finishes in</th>" +
        "</tr>" +
      "</thead>";

    const tbody = document.createElement("tbody");

    displayRows.forEach((item, index) => {
      const tr = document.createElement("tr");
      tr.className = getRowClass(item, index);

      const buildingHtml = item.imageSrc
        ? "<img class='twlcq-building-icon' src='" + escapeHtml(item.imageSrc) + "' alt=''> " + escapeHtml(item.building)
        : escapeHtml(item.building);

      tr.innerHTML =
        "<td>" + (index + 1) + "</td>" +
        "<td class='twlcq-left'><a href='" + escapeHtml(item.villageHref || "#") + "' target='_blank' rel='noreferrer noopener'>" + escapeHtml(item.villageName) + "</a></td>" +
        "<td>" + item.queuePosition + "</td>" +
        "<td class='twlcq-left'>" + buildingHtml + "</td>" +
        "<td><strong>" + escapeHtml(formatDuration(getBuildDurationSeconds(item))) + "</strong></td>" +
        "<td>" + escapeHtml(formatDateTime(item.finishDate)) + "</td>" +
        "<td>" + escapeHtml(formatDuration(item.remainingSeconds)) + "</td>";

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    ui.results.appendChild(wrap);
  }

  async function loadAndRender() {
    try {
      ui.loadButton.disabled = true;
      setStatus("Loading Buildings overview and checking queued construction orders...", "warn");

      const rows = await loadConstructionRows();
      state.rows = rows;

      renderRows(rows);

      setStatus(
        "Loaded " + rows.length + " queued building order(s). Showing top " + (state.maxRows || DEFAULT_MAX_ROWS) + " longest estimated build durations.",
        "success"
      );
    } catch (err) {
      console.error(SCRIPT_NAME + " failed:", err);
      setStatus(err.message || String(err), "error");
    } finally {
      ui.loadButton.disabled = false;
    }
  }

  function copyResults() {
    const displayRows = getDisplayRows(state.rows || []);

    if (!displayRows.length) {
      setStatus("No rows to copy.", "warn");
      return;
    }

    const lines = [];
    lines.push("[size=14]" + SCRIPT_NAME + " " + SCRIPT_VERSION + "[/size]");
    lines.push("[i]Top " + displayRows.length + " building orders with the longest estimated build duration. Sorted from longest to shortest.[/i]");
    lines.push("");
    lines.push("[table]");
    lines.push("[**]#[||]Village[||]Queue[||]Building[||]Build duration[||]Finish time[||]Finishes in[/**]");

    displayRows.forEach((item, index) => {
      lines.push(
        "[*]" +
        [
          index + 1,
          item.villageName,
          item.queuePosition,
          item.building,
          formatDuration(getBuildDurationSeconds(item)),
          formatDateTime(item.finishDate),
          formatDuration(item.remainingSeconds)
        ].join("[|]")
      );
    });

    lines.push("[/table]");

    const text = lines.join("\n");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => setStatus("BBCode copied.", "success"))
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
    setStatus(copied ? "Copied." : "Could not copy.", copied ? "success" : "error");
  }

  function setStatus(message, type) {
    if (!ui.status) return;
    ui.status.textContent = message || "";
    ui.status.className = "twlcq-status";
    if (type) ui.status.classList.add("twlcq-status-" + type);
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

      .twlcq-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px;
        background-color: #c1a264;
        background-image: url(/graphic/screen/tableheader_bg3.png);
        background-repeat: repeat-x;
      }

      .twlcq-header h3 {
        margin: 0;
        padding: 0;
        font-size: 14px;
        line-height: 1;
      }

      .twlcq-close {
        border: 1px solid #7d510f;
        background: #f4e4bc;
        color: #2f1b00;
        border-radius: 3px;
        cursor: pointer;
        font-weight: bold;
      }

      .twlcq-body { padding: 10px; }

      .twlcq-controls {
        display: flex;
        flex-wrap: wrap;
        align-items: end;
        gap: 8px;
        margin-bottom: 8px;
      }

      .twlcq-field label {
        display: block;
        font-weight: bold;
        margin-bottom: 4px;
      }

      .twlcq-field input {
        width: 110px;
        padding: 4px;
        border: 1px solid #7d510f;
        background: #fffaf0;
        color: #2f1b00;
      }

      .twlcq-help {
        margin: 0 0 8px;
        line-height: 1.35;
      }

      .twlcq-status {
        padding: 6px;
        margin: 8px 0;
        border: 1px solid #bd9c5a;
        background: #fff4d5;
        border-radius: 4px;
      }

      .twlcq-status-success { background: #dff0d8; }
      .twlcq-status-warn { background: #fff4d5; }
      .twlcq-status-error { background: #f2dede; }

      .twlcq-summary {
        padding: 7px;
        margin: 8px 0;
        background: #fff4d5;
        border: 1px solid #bd9c5a;
        border-radius: 4px;
        line-height: 1.45;
      }

      .twlcq-muted { opacity: 0.75; }

      .twlcq-table-wrap {
        max-height: 520px;
        overflow: auto;
        border: 1px solid #bd9c5a;
      }

      .twlcq-table {
        width: 100%;
        border-collapse: collapse;
      }

      .twlcq-table th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 5px;
        border: 1px solid #bd9c5a;
        background: #cfa95e;
        text-align: center;
      }

      .twlcq-table td {
        padding: 5px;
        border: 1px solid #bd9c5a;
        background: #fff5da;
        text-align: center;
        vertical-align: middle;
      }

      .twlcq-table tr:nth-child(even) td { background: #f0e2be; }
      .twlcq-table tr.twlcq-row-warning td { background: #fff293 !important; }
      .twlcq-table tr.twlcq-row-critical td { background: #f2b6a0 !important; }
      .twlcq-left { text-align: left !important; }
      .twlcq-building-icon { width: 18px; height: 18px; vertical-align: middle; margin-right: 4px; }
    `;

    document.head.appendChild(style);
  }

  function closeWidget() {
    const box = document.getElementById(BOX_ID);
    if (box) box.remove();

    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();

    delete window.twacticsLongConstructionQueue;
  }

  function createWidget() {
    addStyles();

    const old = document.getElementById(BOX_ID);
    if (old) old.remove();

    const box = document.createElement("div");
    box.id = BOX_ID;

    const header = document.createElement("div");
    header.className = "twlcq-header";
    header.innerHTML = "<h3>" + escapeHtml(SCRIPT_NAME + " " + SCRIPT_VERSION) + "</h3>";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "twlcq-close";
    closeButton.textContent = "x";
    closeButton.addEventListener("click", closeWidget);
    header.appendChild(closeButton);

    const body = document.createElement("div");
    body.className = "twlcq-body";

    const help = document.createElement("p");
    help.className = "twlcq-help";
    help.textContent = "Shows the top 20 building orders with the longest estimated build duration. It checks all queue positions and sorts by the item's own duration, not by when it finishes in the full village queue.";

    const controls = document.createElement("div");
    controls.className = "twlcq-controls";

    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.className = "btn";
    loadButton.textContent = "Load longest build times";
    loadButton.addEventListener("click", loadAndRender);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "btn";
    copyButton.textContent = "Copy BBCode";
    copyButton.addEventListener("click", copyResults);

    controls.appendChild(loadButton);
    controls.appendChild(copyButton);

    const status = document.createElement("div");
    status.className = "twlcq-status";
    status.textContent = "Ready. Click Load longest build times.";

    const results = document.createElement("div");

    body.appendChild(help);
    body.appendChild(controls);
    body.appendChild(status);
    body.appendChild(results);

    box.appendChild(header);
    box.appendChild(body);

    const target = document.querySelector("#contentContainer") || document.querySelector("#mobileContent") || document.querySelector("#content_value") || document.body;
    target.prepend(box);

    ui.loadButton = loadButton;
    ui.copyButton = copyButton;
    ui.status = status;
    ui.results = results;
  }

  createWidget();
  console.log(SCRIPT_NAME + " " + SCRIPT_VERSION + " loaded", { mode: TIME_SOURCE });
})();
