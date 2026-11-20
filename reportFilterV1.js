/*
 * Twactics Report Filter v1.0.0
 * Created for fcwebben/TWscripts
 * Filters the CURRENT Tribal Wars report-list page by the TOTAL units sent
 * by attackers. Includes all unit types and does not count troop losses twice.
 * Fetches report details via same-origin GET with bounded concurrency.
 * This is a visual filter only: no reports are intentionally changed or deleted.
 * CAUTION: Opening report details may mark unread reports as read in the game.
 */
(function twacticsReportFilterScript() {
  'use strict';

  const APP_ID = 'twactics-report-filter';
  const STYLE_ID = 'twactics-report-filter-style';
  const VERSION = '1.0.0';
  const CONCURRENCY = 3;
  const REQUEST_SPACING_MS = 350;
  const REQUEST_TIMEOUT_MS = 15000;

  if (window.twacticsReportFilter && typeof window.twacticsReportFilter.destroy === 'function') {
    window.twacticsReportFilter.destroy();
  }

  const list = document.querySelector('#report_list');
  if (!list || new URLSearchParams(location.search).get('screen') !== 'report') {
    const message = 'Twactics Report Filter: open a Tribal Wars report-list page first.';
    if (window.UI && typeof window.UI.ErrorMessage === 'function') {
      window.UI.ErrorMessage(message);
    } else {
      alert(message);
    }
    return;
  }

  const entries = Array.from(list.querySelectorAll('tr'))
    .map((row) => {
      const link = row.querySelector('a.report-link[data-id]');
      const checkbox = row.querySelector('input[type="checkbox"][name^="id_"]');
      if (!link || !checkbox) return null;
      return {
        id: link.getAttribute('data-id'),
        url: link.href,
        row,
        checkbox,
        originalDisplay: row.style.display,
        badge: null
      };
    })
    .filter(Boolean);

  if (!entries.length) {
    const message = 'Twactics Report Filter: no report rows found on this page.';
    if (window.UI && typeof window.UI.ErrorMessage === 'function') {
      window.UI.ErrorMessage(message);
    } else {
      alert(message);
    }
    return;
  }

  const form = list.closest('form');
  const state = {
    entries,
    cache: new Map(),
    controller: null,
    runId: 0,
    running: false,
    active: false,
    threshold: 1000,
    failedIds: new Set(),
    startedRequests: 0,
    processed: 0,
    nextRequestAt: 0,
    fatalError: '',
    destroyed: false
  };

  const css = document.createElement('style');
  css.id = STYLE_ID;
  css.textContent = `
    #${APP_ID} { box-sizing: border-box; background: #f4eedf; border: 1px solid #c4b68d;
      border-radius: 5px; padding: 13px 15px; margin: 12px 0; color: #3d3426;
      font: 13px Arial, sans-serif; max-width: 920px; }
    #${APP_ID} * { box-sizing: border-box; }
    #${APP_ID} .twfr-head { display: flex; align-items: center; justify-content: space-between;
      gap: 12px; margin-bottom: 11px; }
    #${APP_ID} .twfr-head strong { font-size: 16px; }
    #${APP_ID} .twfr-head small { font-weight: normal; color: #847758; font-size: 11px; }
    #${APP_ID} .twfr-controls { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; }
    #${APP_ID} label { display: flex; flex-direction: column; gap: 4px; font-weight: bold; }
    #${APP_ID} input[type="number"] { width: 155px; padding: 7px 9px; border: 1px solid #b8a781;
      border-radius: 3px; background: #fff; color: #302a20; font-size: 14px; }
    #${APP_ID} button { padding: 7px 11px; border: 1px solid #a89670; border-radius: 3px;
      background: #eee1bd; color: #302a20; cursor: pointer; font-size: 12px; font-weight: bold; }
    #${APP_ID} button[data-action="scan"] { background: #467345; color: #fff; border-color: #365b35; }
    #${APP_ID} button[data-action="close"] { padding: 3px 7px; font-size: 16px; background: transparent;
      border: 0; }
    #${APP_ID} button:disabled { opacity: .5; cursor: not-allowed; }
    #${APP_ID} .twfr-status { margin-top: 11px; font-weight: bold; }
    #${APP_ID} .twfr-track { height: 5px; background: #e3d7bc; margin-top: 7px; border-radius: 4px;
      overflow: hidden; }
    #${APP_ID} .twfr-progress { width: 0%; height: 100%; background: #467345; transition: width .1s; }
    #${APP_ID} .twfr-note { margin: 8px 0 0; line-height: 1.45; color: #685c49; font-size: 11px; }
    #${APP_ID} .twfr-error { color: #aa3427; font-weight: bold; }
    #report_list .twfr-badge { display: inline-block; margin-left: 8px; padding: 2px 5px;
      border: 1px solid #c1b38f; background: #f1ead7; color: #4b4130;
      font: 11px Arial, sans-serif; border-radius: 3px; white-space: nowrap; }
  `;
  document.head.appendChild(css);

  const panel = document.createElement('div');
  panel.id = APP_ID;
  panel.innerHTML = `
    <div class="twfr-head">
      <strong>Twactics Report Filter <small>v${VERSION}</small></strong>
      <button type="button" data-action="close" title="Close and restore all rows" aria-label="Close">&times;</button>
    </div>
    <div class="twfr-controls">
      <label for="twfr-threshold">Attacker sent more than (units)
        <input id="twfr-threshold" type="number" min="0" step="1" value="1000">
      </label>
      <button type="button" data-action="scan">Filter reports</button>
      <button type="button" data-action="reset">Show all</button>
      <button type="button" data-action="stop" disabled>Stop</button>
    </div>
    <div class="twfr-status" role="status" aria-live="polite"></div>
    <div class="twfr-track"><div class="twfr-progress"></div></div>
    <p class="twfr-note">Scans reports on this page only. Counts all attacker unit types, including scouts and nobles.
      Reports with unreadable counts stay visible. Reading report details may mark them as read in the game.
      This is a visual filter: bulk actions such as "Delete all" still operate on the full folder.</p>
  `;
  if (form) form.parentNode.insertBefore(panel, form);
  else list.parentNode.insertBefore(panel, list);

  const thresholdInput = panel.querySelector('#twfr-threshold');
  const statusEl = panel.querySelector('.twfr-status');
  const progressEl = panel.querySelector('.twfr-progress');
  const scanButton = panel.querySelector('[data-action="scan"]');
  const stopButton = panel.querySelector('[data-action="stop"]');

  function matchesFilters(report, filters) {
    return report.total > filters.minAttackerUnits;
  }

  function readUnitCount(raw) {
    if (raw === null || raw === undefined) return null;
    const normalized = String(raw).trim().replace(/[\s.,\u00a0]/g, '');
    if (!/^\d+$/.test(normalized)) return null;
    const number = Number(normalized);
    return Number.isSafeInteger(number) ? number : null;
  }

  function extractReport(html, expectedId) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = Array.from(doc.querySelectorAll('#attack_info_att_units'));
    const table = tables.find((element) => !element.closest('.report-preview')) ||
      tables.find((element) => {
        const preview = element.closest('.report-preview');
        if (!preview) return false;
        return Array.from(preview.querySelectorAll('a[href*="report_id="]'))
          .some((link) => new URL(link.getAttribute('href'), location.href).searchParams.get('report_id') === expectedId);
      });
    if (!table) return null;

    // The first numeric row is Quantity; the next is Losses. Never add Losses.
    const quantityRow = Array.from(table.rows).find((row) => row.querySelector('td.unit-item'));
    if (!quantityRow) return null;
    const cells = Array.from(quantityRow.querySelectorAll('td.unit-item'));
    if (cells.length < 4) return null;

    const units = {};
    let total = 0;
    for (const cell of cells) {
      const quantity = readUnitCount(cell.getAttribute('data-unit-count') ?? cell.textContent);
      if (quantity === null) return null;
      const type = Array.from(cell.classList).find((name) => name.startsWith('unit-item-'));
      if (type) units[type.slice('unit-item-'.length)] = quantity;
      total += quantity;
    }
    return Number.isSafeInteger(total) ? { total, units } : null;
  }

  async function getReport(entry, signal) {
    const url = new URL(entry.url, location.href);
    if (url.origin !== location.origin || url.searchParams.get('screen') !== 'report') {
      throw new Error('Unexpected report URL');
    }
    const requestController = new AbortController();
    const onAbort = () => requestController.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.href, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'text/html' }, signal: requestController.signal
      });
      if (response.status === 403 || response.status === 429) {
        const error = new Error('Server rejected report requests (HTTP ' + response.status + ')');
        error.fatal = true;
        throw error;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const report = extractReport(await response.text(), entry.id);
      if (!report) throw new Error('Attacker unit quantities not found');
      return report;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  function ensureBadge(entry, total) {
    if (!entry.badge) {
      entry.badge = document.createElement('span');
      entry.badge.className = 'twfr-badge';
      const subject = entry.row.querySelector('td.report-subject');
      if (subject) subject.appendChild(entry.badge);
    }
    if (entry.badge) entry.badge.textContent = total.toLocaleString('en-US') + ' units';
  }

  function restrictHiddenSelection() {
    if (!state.active || state.destroyed) return;
    for (const entry of entries) {
      if (entry.row.style.display === 'none') entry.checkbox.checked = false;
    }
  }

  function applyRowVisibility() {
    if (state.destroyed) return;
    for (const entry of entries) {
      const report = state.cache.get(entry.id);
      if (!state.active || !report || matchesFilters(report, { minAttackerUnits: state.threshold })) {
        entry.row.style.display = entry.originalDisplay;
      } else {
        entry.row.style.display = 'none';
      }
      if (state.active && report) ensureBadge(entry, report.total);
    }
    restrictHiddenSelection();
  }

  function updateStatus(message) {
    if (state.destroyed) return;
    const known = entries.filter((entry) => state.cache.has(entry.id)).length;
    const matching = entries.filter((entry) => {
      const report = state.cache.get(entry.id);
      return report && matchesFilters(report, { minAttackerUnits: state.threshold });
    }).length;
    const unresolved = entries.length - known;
    const prefix = message ? message + ' — ' : '';
    const summary = state.active
      ? `${matching} matching · ${known} counted · ${unresolved} unverified · ${state.processed}/${entries.length} processed`
      : `${entries.length} reports on this page. Ready to filter.`;
    statusEl.textContent = prefix + summary;
    statusEl.classList.toggle('twfr-error', Boolean(state.fatalError));
    const progress = state.active ? state.processed / entries.length : 0;
    progressEl.style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
  }

  function updateControls() {
    scanButton.disabled = state.running;
    thresholdInput.disabled = state.running;
    stopButton.disabled = !state.running;
  }

  function stopScan() {
    if (!state.running) return;
    state.runId++;
    state.controller?.abort();
    state.controller = null;
    state.running = false;
    updateControls();
    updateStatus('Stopped. Unverified reports remain visible');
  }

  async function runFilter() {
    if (state.running || state.destroyed) return;
    const threshold = Number(thresholdInput.value);
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      thresholdInput.focus();
      statusEl.textContent = 'Enter a whole number of units (0 or more).';
      return;
    }
    state.threshold = threshold;
    state.active = true;
    state.failedIds.clear();
    state.startedRequests = 0;
    state.processed = entries.filter((entry) => state.cache.has(entry.id)).length;
    state.nextRequestAt = Date.now();
    state.fatalError = '';
    state.running = true;
    const runId = ++state.runId;
    state.controller = new AbortController();
    const signal = state.controller.signal;
    const pending = entries.filter((entry) => !state.cache.has(entry.id));
    let cursor = 0;
    updateControls();
    applyRowVisibility();
    updateStatus('Scanning');

    async function waitForTurn() {
      const startAt = Math.max(Date.now(), state.nextRequestAt);
      state.nextRequestAt = startAt + REQUEST_SPACING_MS;
      const delay = startAt - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }

    async function worker() {
      while (runId === state.runId && !signal.aborted && cursor < pending.length) {
        const entry = pending[cursor++];
        await waitForTurn();
        if (runId !== state.runId || signal.aborted) return;
        try {
          state.startedRequests++;
          const report = await getReport(entry, signal);
          if (runId !== state.runId || signal.aborted) return;
          state.cache.set(entry.id, report);
          applyRowVisibility();
        } catch (error) {
          if (runId !== state.runId || signal.aborted) return;
          state.failedIds.add(entry.id);
          console.warn('[Twactics Report Filter] Could not read report ' + entry.id, error);
          if (error.fatal) {
            state.fatalError = error.message;
            state.controller.abort();
          }
        } finally {
          if (runId === state.runId) {
            state.processed++;
            updateStatus(state.fatalError || 'Scanning');
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    if (runId !== state.runId || state.destroyed) return;
    state.running = false;
    state.controller = null;
    updateControls();
    if (state.fatalError) updateStatus(state.fatalError + '. Stopped');
    else if (state.failedIds.size) updateStatus('Done; ' + state.failedIds.size + ' reports could not be read');
    else updateStatus('Done');
  }

  function showAll() {
    stopScan();
    state.active = false;
    state.fatalError = '';
    for (const entry of entries) {
      entry.row.style.display = entry.originalDisplay;
      entry.badge?.remove();
      entry.badge = null;
    }
    updateStatus('All rows restored');
  }

  function onPanelClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    switch (button.getAttribute('data-action')) {
      case 'scan': void runFilter(); break;
      case 'stop': stopScan(); break;
      case 'reset': showAll(); break;
      case 'close': destroy(); break;
    }
  }

  function onPanelKeydown(event) {
    if (event.key === 'Enter' && event.target === thresholdInput) {
      event.preventDefault();
      void runFilter();
    }
  }

  function onFormClick(event) {
    if (state.active && event.target.matches('input.selectAll')) {
      setTimeout(restrictHiddenSelection, 0);
    }
  }

  function onFormSubmit() {
    restrictHiddenSelection();
  }

  function destroy() {
    if (state.destroyed) return;
    stopScan();
    showAll();
    state.destroyed = true;
    panel.removeEventListener('click', onPanelClick);
    panel.removeEventListener('keydown', onPanelKeydown);
    if (form) {
      form.removeEventListener('click', onFormClick);
      form.removeEventListener('submit', onFormSubmit, true);
    }
    panel.remove();
    css.remove();
    if (window.twacticsReportFilter?.state === state) delete window.twacticsReportFilter;
  }

  panel.addEventListener('click', onPanelClick);
  panel.addEventListener('keydown', onPanelKeydown);
  if (form) {
    form.addEventListener('click', onFormClick);
    form.addEventListener('submit', onFormSubmit, true);
  }

  window.twacticsReportFilter = {
    state,
    run: runFilter,
    showAll,
    stop: stopScan,
    destroy,
    extractReport
  };
  updateControls();
  updateStatus('Loaded');
})();
