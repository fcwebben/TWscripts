/*
 * Relic Village Planner
 *
 * Helps players find good villages for Relic placement based on visible village coordinates.
 * No server requests, no automation, no external files.
 * The script only reads visible village coordinates from the current page.
 */

(function () {
  if (window.twRelicVillagePlannerLoaded) {
    console.log("Relic Village Planner already loaded");
    return;
  }

  window.twRelicVillagePlannerLoaded = true;

  const SCRIPT_NAME = "Relic Village Planner";
  const SCRIPT_VERSION = "v1.0.0";

  const state = {
    villages: [],
    candidates: [],
    plan: [],
    selectedRange: 2,
    placementCount: 1
  };

  const ui = {};

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getParam(name, url) {
    try {
      return new URL(url || window.location.href, window.location.origin).searchParams.get(name);
    } catch (e) {
      return null;
    }
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

  function isCombinedPage() {
    return getParam("screen") === "overview_villages" && getParam("mode") === "combined";
  }

  function getRelicMaxTiles(range) {
	  return 2 * range * range + 2 * range + 1;
	}

	function getRelicRangeLabel(range) {
	  if (range === 2) return "Shoddy / Sturdy";
	  if (range === 3) return "Enhanced / Superior";
	  if (range === 4) return "Renowned";
	  return "Unknown";
	}

	function getRelicOffsets(range) {
	  const offsets = [];

	  for (let dx = -range; dx <= range; dx++) {
		for (let dy = -range; dy <= range; dy++) {
		  if (Math.abs(dx) + Math.abs(dy) <= range) {
			offsets.push({
			  dx: dx,
			  dy: dy
			});
		  }
		}
	  }

	  return offsets;
	}

  function getRelevantTables() {
    const tables = [];

    const combinedTable = document.getElementById("combined_table");
    if (combinedTable) tables.push(combinedTable);

    document.querySelectorAll("table.overview_table, #content_value table.vis").forEach(table => {
      if (!tables.includes(table)) {
        tables.push(table);
      }
    });

    return tables;
  }

  function extractVillagesFromCurrentPage() {
    const villages = [];
    const seen = new Set();
    const tables = getRelevantTables();

    tables.forEach(table => {
      table.querySelectorAll("tr").forEach(row => {
        if (row.querySelector("th")) return;

        const rowText = cleanText(row.textContent);
        const coordData = parseCoord(rowText);

        if (!coordData) return;

        let villageLink = null;

        const links = Array.from(row.querySelectorAll('a[href*="village="]'));

        villageLink =
          links.find(link => parseCoord(link.textContent)) ||
          links.find(link => {
            const href = link.getAttribute("href") || "";
            return href.includes("screen=overview") || href.includes("screen=place") || href.includes("screen=main");
          }) ||
          links[0] ||
          null;

        const villageId = villageLink ? getParam("village", villageLink.getAttribute("href")) : "";
        const key = villageId || coordData.coord;

        if (seen.has(key)) return;
        seen.add(key);

        let name = villageLink ? cleanText(villageLink.textContent) : "";
        if (!name || !parseCoord(name)) {
          const firstCell = row.querySelector("td");
          name = firstCell ? cleanText(firstCell.textContent) : "";
        }

        if (!name) {
          name = "Village " + coordData.coord;
        }

        villages.push({
          id: villageId,
          name: name,
          x: coordData.x,
          y: coordData.y,
          coord: coordData.coord,
          href: villageLink ? villageLink.getAttribute("href") : ""
        });
      });
    });

    return villages;
  }

  function calculateCandidates(villages, range) {
    const offsets = getRelicOffsets(range);
    const villageByCoord = new Map();

    villages.forEach(village => {
      villageByCoord.set(village.coord, village);
    });

    const candidates = villages.map(village => {
      const covered = [];

      offsets.forEach(offset => {
        const targetCoord = (village.x + offset.dx) + "|" + (village.y + offset.dy);

        if (villageByCoord.has(targetCoord)) {
          covered.push(villageByCoord.get(targetCoord));
        }
      });

      covered.sort((a, b) => {
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      });

      return {
        village: village,
        coord: village.coord,
        covered: covered,
        coveredCount: covered.length,
        maxTiles: offsets.length
      };
    });

    candidates.sort((a, b) => {
      if (b.coveredCount !== a.coveredCount) return b.coveredCount - a.coveredCount;
      if (a.village.y !== b.village.y) return a.village.y - b.village.y;
      return a.village.x - b.village.x;
    });

    return candidates;
  }

  function buildGreedyPlan(candidates, placementCount) {
    const selected = [];
    const coveredCoords = new Set();
    const usedCandidateCoords = new Set();

    for (let i = 0; i < placementCount; i++) {
      let bestCandidate = null;
      let bestNewCovered = [];

      candidates.forEach(candidate => {
        if (usedCandidateCoords.has(candidate.coord)) return;

        const newCovered = candidate.covered.filter(village => !coveredCoords.has(village.coord));

        if (
          !bestCandidate ||
          newCovered.length > bestNewCovered.length ||
          (newCovered.length === bestNewCovered.length && candidate.coveredCount > bestCandidate.coveredCount)
        ) {
          bestCandidate = candidate;
          bestNewCovered = newCovered;
        }
      });

      if (!bestCandidate || bestNewCovered.length === 0) break;

      bestNewCovered.forEach(village => {
        coveredCoords.add(village.coord);
      });

      usedCandidateCoords.add(bestCandidate.coord);

      selected.push({
        candidate: bestCandidate,
        newCovered: bestNewCovered,
        totalCoveredAfter: coveredCoords.size
      });
    }

    return selected;
  }

  function setStatus(message, type) {
    if (!ui.status) return;

    ui.status.textContent = message || "";
    ui.status.className = "twvp-status";

    if (type) {
      ui.status.classList.add("twvp-status-" + type);
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }

    const temp = document.createElement("textarea");
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand("copy");
    temp.remove();

    return Promise.resolve();
  }

  function copyPlan() {
    if (!state.plan.length) {
      setStatus("No plan to copy. Run analysis first.", "warn");
      return;
    }

    const lines = [];

    lines.push(SCRIPT_NAME + " - " + getRelicRangeLabel(state.selectedRange));
    lines.push("Relic range: " + state.selectedRange);
    lines.push("");

    state.plan.forEach((item, index) => {
      lines.push(
        (index + 1) +
          ". " +
          item.candidate.village.name +
          " [" +
          item.candidate.coord +
          "] - new covered: " +
          item.newCovered.length +
          ", total covered: " +
          item.totalCoveredAfter
      );
    });

    copyText(lines.join("\n"))
      .then(() => setStatus("Plan copied to clipboard.", "success"))
      .catch(() => setStatus("Could not copy plan.", "error"));
  }

  function runAnalysis() {
    const selectedRange = parseInt(ui.rangeSelect.value, 10);
    const placementCount = parseInt(ui.placementInput.value, 10);

    if (![2, 3, 4].includes(selectedRange)) {
	  setStatus("Invalid relic range selected.", "error");
	  return;
	}

    if (isNaN(placementCount) || placementCount <= 0 || placementCount > 10) {
      setStatus("Please enter a placement count between 1 and 10.", "error");
      return;
    }

    const villages = extractVillagesFromCurrentPage();

    state.villages = villages;
    state.selectedRange = selectedRange;
    state.placementCount = placementCount;
    state.candidates = calculateCandidates(villages, selectedRange);
    state.plan = buildGreedyPlan(state.candidates, placementCount);

    renderResults();

    if (!villages.length) {
      setStatus("No village coordinates found. Run this on the Combined overview page.", "error");
      return;
    }

    setStatus(
      "Analyzed " +
        villages.length +
        " village(s). Range " +
        selectedRange +
        " can cover up to " +
        getRelicMaxTiles(selectedRange) +
        " tile(s).",
      "success"
    );
  }

  function createVillageLink(village) {
    if (village.href) {
      const link = document.createElement("a");
      link.href = village.href;
      link.textContent = village.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }

    const span = document.createElement("span");
    span.textContent = village.name;
    return span;
  }

  function createCoveredDetails(candidate) {
    const details = document.createElement("details");

    const summary = document.createElement("summary");
    summary.textContent = "Show " + candidate.covered.length + " covered";
    details.appendChild(summary);

    const list = document.createElement("div");
    list.className = "twvp-covered-list";

    candidate.covered.forEach(village => {
      const line = document.createElement("div");
      line.textContent = village.coord + " - " + village.name;
      list.appendChild(line);
    });

    details.appendChild(list);

    return details;
  }

  function renderPlanTable(container) {
    if (!state.plan.length) return;

    const heading = document.createElement("div");
    heading.className = "twvp-section-title";
    heading.textContent = "Suggested placement plan";
    container.appendChild(heading);

    const note = document.createElement("div");
    note.className = "twvp-small";
    note.textContent =
      "This is a simple greedy plan. It chooses the best next village based on currently uncovered villages.";
    container.appendChild(note);

    const table = document.createElement("table");
    table.className = "twvp-table";
    table.width = "100%";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    ["#", "Relic village", "Coord", "New covered", "Total covered"].forEach(label => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    state.plan.forEach((item, index) => {
      const row = document.createElement("tr");

      const numberCell = document.createElement("td");
      numberCell.textContent = String(index + 1);

      const villageCell = document.createElement("td");
      villageCell.className = "twvp-left";
      villageCell.appendChild(createVillageLink(item.candidate.village));

      const coordCell = document.createElement("td");
      coordCell.textContent = item.candidate.coord;

      const newCoveredCell = document.createElement("td");
      newCoveredCell.textContent = String(item.newCovered.length);

      const totalCell = document.createElement("td");
      totalCell.textContent = item.totalCoveredAfter + " / " + state.villages.length;

      row.appendChild(numberCell);
      row.appendChild(villageCell);
      row.appendChild(coordCell);
      row.appendChild(newCoveredCell);
      row.appendChild(totalCell);

      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    container.appendChild(table);
  }

  function renderCandidateTable(container) {
    if (!state.candidates.length) return;

    const heading = document.createElement("div");
    heading.className = "twvp-section-title";
    heading.textContent = "Best individual relic villages";
    container.appendChild(heading);

    const tableWrap = document.createElement("div");
    tableWrap.className = "twvp-table-wrap";

    const table = document.createElement("table");
    table.className = "twvp-table";
    table.width = "100%";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    ["#", "Village", "Coord", "Covered", "Covered villages"].forEach(label => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });

    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const maxTiles = getRelicMaxTiles(state.selectedRange);

    state.candidates.forEach((candidate, index) => {
      const row = document.createElement("tr");

      if (candidate.coveredCount === maxTiles) {
        row.className = "twvp-perfect";
      }

      const numberCell = document.createElement("td");
      numberCell.textContent = String(index + 1);

      const villageCell = document.createElement("td");
      villageCell.className = "twvp-left";
      villageCell.appendChild(createVillageLink(candidate.village));

      const coordCell = document.createElement("td");
      coordCell.textContent = candidate.coord;

      const coveredCell = document.createElement("td");
      coveredCell.textContent = candidate.coveredCount + " / " + maxTiles;

      const detailsCell = document.createElement("td");
      detailsCell.className = "twvp-left";
      detailsCell.appendChild(createCoveredDetails(candidate));

      row.appendChild(numberCell);
      row.appendChild(villageCell);
      row.appendChild(coordCell);
      row.appendChild(coveredCell);
      row.appendChild(detailsCell);

      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);
  }

  function renderResults() {
    ui.results.innerHTML = "";

    if (!state.villages.length) return;

    const summary = document.createElement("div");
    summary.className = "twvp-summary";

    const best = state.candidates[0];
    const maxTiles = getRelicMaxTiles(state.selectedRange);

    summary.textContent =
      "Found " +
      state.villages.length +
      " village(s). Best single placement covers " +
      best.coveredCount +
      " / " +
      maxTiles +
      " possible tile(s).";

    ui.results.appendChild(summary);

    renderPlanTable(ui.results);
    renderCandidateTable(ui.results);
  }

  function addStyles() {
    if (document.getElementById("tw-relic-village-planner-style")) return;

    const style = document.createElement("style");
    style.id = "tw-relic-village-planner-style";

    style.textContent = `
      #tw-relic-village-planner {
        position: fixed;
        top: 110px;
        right: 40px;
        width: 720px;
        max-width: 95vw;
        max-height: 82vh;
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

      #tw-relic-village-planner * {
        box-sizing: border-box;
      }

      .twvp-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 9px 11px;
        background: #cfa95e;
        border-bottom: 1px solid #7d510f;
        cursor: move;
      }

      .twvp-header-title {
        font-weight: bold;
        font-size: 15px;
      }

      .twvp-close {
        width: 18px;
        height: 18px;
        line-height: 15px;
        border: 1px solid #7d510f;
        background: #f4e4bc;
        color: #2f1b00;
        border-radius: 3px;
        cursor: pointer;
        font-weight: bold;
      }

      .twvp-body {
        padding: 10px;
        max-height: calc(82vh - 42px);
        overflow-y: auto;
      }

      .twvp-help {
        margin-bottom: 10px;
        line-height: 1.35;
      }

      .twvp-settings {
        display: grid;
        grid-template-columns: 1fr 160px;
        gap: 8px;
        margin-bottom: 8px;
      }

      .twvp-label {
        display: block;
        font-weight: bold;
        margin-bottom: 4px;
      }

      .twvp-select,
      .twvp-input {
        width: 100%;
        padding: 5px;
        border: 1px solid #7d510f;
        border-radius: 4px;
        background: #fffaf0;
        color: #2f1b00;
      }

      .twvp-small {
        font-size: 11px;
        opacity: 0.75;
        line-height: 1.35;
        margin-top: 3px;
        margin-bottom: 7px;
      }

      .twvp-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0;
      }

      .twvp-buttons .btn {
        cursor: pointer;
      }

      .twvp-status {
        padding: 6px;
        margin: 8px 0;
        border: 1px solid #bd9c5a;
        background: #fff4d5;
        border-radius: 4px;
      }

      .twvp-status-success {
        background: #dff0d8;
      }

      .twvp-status-warn {
        background: #fff4d5;
      }

      .twvp-status-error {
        background: #f2dede;
      }

      .twvp-summary {
        padding: 6px;
        margin: 8px 0;
        background: #fff4d5;
        border: 1px solid #bd9c5a;
        border-radius: 4px;
        font-weight: bold;
      }

      .twvp-section-title {
        margin-top: 12px;
        margin-bottom: 5px;
        font-weight: bold;
        font-size: 13px;
      }

      .twvp-table-wrap {
        max-height: 360px;
        overflow-y: auto;
        border: 1px solid #bd9c5a;
      }

      .twvp-table {
        border-collapse: collapse;
        width: 100%;
      }

      .twvp-table th {
        background: #cfa95e;
        border: 1px solid #bd9c5a;
        padding: 5px;
        text-align: center;
      }

      .twvp-table td {
        border: 1px solid #bd9c5a;
        padding: 5px;
        text-align: center;
        background: #fff5da;
        vertical-align: top;
      }

      .twvp-table tr:nth-child(even) td {
        background: #f0e2be;
      }

      .twvp-table tr.twvp-perfect td {
        background: #dff0d8;
      }

      .twvp-left {
        text-align: left !important;
      }

      .twvp-covered-list {
        margin-top: 5px;
        max-height: 120px;
        overflow-y: auto;
        font-size: 11px;
        line-height: 1.35;
      }

      .twvp-footer {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #bd9c5a;
        font-size: 11px;
        opacity: 0.8;
      }
    `;

    document.head.appendChild(style);
  }

  function makeDraggable(box, handle) {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("mousedown", function (event) {
      if (event.target.classList.contains("twvp-close")) return;

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
    const box = document.getElementById("tw-relic-village-planner");
    if (box) box.remove();

    window.twRelicVillagePlannerLoaded = false;
    console.log("Relic Village Planner closed");
  }

  function createDialog() {
    addStyles();

    const old = document.getElementById("tw-relic-village-planner");
    if (old) old.remove();

    const box = document.createElement("div");
    box.id = "tw-relic-village-planner";

    const header = document.createElement("div");
    header.className = "twvp-header";

    const title = document.createElement("div");
    title.className = "twvp-header-title";
    title.textContent = SCRIPT_NAME;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "twvp-close";
    closeBtn.textContent = "x";
    closeBtn.addEventListener("click", closeDialog);

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "twvp-body";

    const help = document.createElement("div");
    help.className = "twvp-help";
    help.textContent =
      "This tool reads the visible village coordinates on the Combined overview page and finds good villages for Relic placement.";

    const settings = document.createElement("div");
    settings.className = "twvp-settings";

    const rangeWrap = document.createElement("div");

    const rangeLabel = document.createElement("label");
    rangeLabel.className = "twvp-label";
    rangeLabel.textContent = "Relic quality / range";

    const rangeSelect = document.createElement("select");
    rangeSelect.className = "twvp-select";

    [
	  { value: "2", text: "Shoddy / Sturdy - Range 2 - max 13 tiles" },
	  { value: "3", text: "Enhanced / Superior - Range 3 - max 25 tiles" },
	  { value: "4", text: "Renowned - Range 4 - max 41 tiles" }
	].forEach(optionData => {
      const option = document.createElement("option");
      option.value = optionData.value;
      option.textContent = optionData.text;
      rangeSelect.appendChild(option);
    });

    const rangeHelp = document.createElement("div");
    rangeHelp.className = "twvp-small";
    rangeHelp.textContent = "The calculation uses diamond coverage / Manhattan distance: abs(dx) + abs(dy) <= range.";

    rangeWrap.appendChild(rangeLabel);
    rangeWrap.appendChild(rangeSelect);
    rangeWrap.appendChild(rangeHelp);

    const placementWrap = document.createElement("div");

    const placementLabel = document.createElement("label");
    placementLabel.className = "twvp-label";
    placementLabel.textContent = "Placements to plan";

    const placementInput = document.createElement("input");
    placementInput.className = "twvp-input";
    placementInput.type = "number";
    placementInput.min = "1";
    placementInput.max = "10";
    placementInput.value = "1";

    const placementHelp = document.createElement("div");
    placementHelp.className = "twvp-small";
    placementHelp.textContent = "Used for the suggested greedy placement plan.";

    placementWrap.appendChild(placementLabel);
    placementWrap.appendChild(placementInput);
    placementWrap.appendChild(placementHelp);

    settings.appendChild(rangeWrap);
    settings.appendChild(placementWrap);

    const buttons = document.createElement("div");
    buttons.className = "twvp-buttons";

    const analyzeBtn = document.createElement("button");
    analyzeBtn.type = "button";
    analyzeBtn.className = "btn";
    analyzeBtn.textContent = "Analyze villages";
    analyzeBtn.addEventListener("click", runAnalysis);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn";
    copyBtn.textContent = "Copy plan";
    copyBtn.addEventListener("click", copyPlan);

    buttons.appendChild(analyzeBtn);
    buttons.appendChild(copyBtn);

    const status = document.createElement("div");
    status.className = "twvp-status";

    if (isCombinedPage()) {
      status.textContent = "Ready. Choose relic range and click Analyze villages.";
    } else {
      status.textContent = "Best used on Overview -> Combined. The script will still try to read visible village coordinates.";
      status.classList.add("twvp-status-warn");
    }

    const results = document.createElement("div");

    const footer = document.createElement("div");
    footer.className = "twvp-footer";
    footer.textContent = "Created by Twactics";

    body.appendChild(help);
    body.appendChild(settings);
    body.appendChild(buttons);
    body.appendChild(status);
    body.appendChild(results);
    body.appendChild(footer);

    box.appendChild(header);
    box.appendChild(body);

    document.body.appendChild(box);

    ui.rangeSelect = rangeSelect;
    ui.placementInput = placementInput;
    ui.status = status;
    ui.results = results;

    makeDraggable(box, header);
  }

  createDialog();

  console.log(SCRIPT_NAME + " " + SCRIPT_VERSION + " loaded");
})();
