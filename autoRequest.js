(function () {
  "use strict";

  const KEY = "__twsrAutoRequest";
  const previous = window[KEY];
  if (previous && typeof previous.stop === "function") {
    previous.stop("Stopped by running the script again");
    return;
  }

  const tools = [
    { id: "twactics-smart-resource-sender", name: "Smart Mint Resource Sender", button: ".twsr-send-button", status: '[id="twsr-status"]', errorClass: "twsr-status-error", balancer: false },
    { id: "twactics-resource-balancer", name: "Resource Balancer", button: ".twrp-send-button", status: ".twrp-status", errorClass: "twrp-status-error", balancer: true }
  ].map(function (tool) {
    tool.root = document.getElementById(tool.id);
    return tool;
  }).filter(function (tool) {
    return tool.root && tool.root.querySelector(tool.button);
  });

  if (tools.length !== 1) {
    alert(tools.length > 1
      ? "Both Twactics tools have request rows. Close the tool you do not want to run, then run this script again."
      : "Open Twactics Smart Mint Resource Sender or Resource Balancer and create a plan first.");
    return;
  }

  const tool = tools[0];
  const root = tool.root;
  const allSendButtons = ".twsr-send-button, .twrp-send-button";
  const POLL_MS = 100;
  const GAP_MS = 250;
  const START_TIMEOUT_MS = 2000;
  const REQUEST_TIMEOUT_MS = 120000;
  const attempts = new Map();
  const buttonIds = new WeakMap();
  let nextId = 0;
  let timer = 0;
  let stopped = false;
  let pending = null;
  let clicks = 0;
  let waitStarted = Date.now();
  let stopKey = "";
  const initialState = getState();
  const initialPlan = initialState && initialState.plan;
  const controller = { stop: stop, tool: tool.name, version: "1.0" };

  function getState() {
    return tool.balancer && window.twacticsResourceBalancer
      ? window.twacticsResourceBalancer.state
      : null;
  }

  function textOf(element) {
    return String(element && element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function getButtons() {
    return Array.from(root.querySelectorAll(tool.button));
  }

  function done(button) {
    return /^(Requested|Sent|Done|Completed)\b/i.test(textOf(button));
  }

  function ready(button) {
    return button && button.isConnected && root.contains(button) && !button.disabled &&
      button.getAttribute("aria-disabled") !== "true" && /^Request$/i.test(textOf(button));
  }

  function busy(buttons) {
    const state = getState();
    const status = root.querySelector(tool.status);
    return Boolean(state && state.sendLocked) ||
      /^(Requesting|Refreshing|Loading)\b/i.test(textOf(status)) ||
      buttons.some(function (button) {
        return /^(Requesting|Refreshing)\b/i.test(textOf(button)) ||
          ((button.disabled || button.getAttribute("aria-disabled") === "true") && !done(button));
      });
  }

  function errorText() {
    const status = root.querySelector(tool.status);
    if (status && (status.classList.contains(tool.errorClass) ||
      /Last request was not completed|Refresh village data before retrying/i.test(textOf(status)))) {
      return textOf(status) || "Request error";
    }
    return "";
  }

  function cleanup() {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onWindowBlur);
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("click", onManualClick, true);
    if (window[KEY] === controller) delete window[KEY];
  }

  function stop(message) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (!stopKey) cleanup();
    console.info("[Twactics auto-request] " + tool.name + ": " +
      (message || "Stopped") + " (" + clicks + " click(s))." +
      (pending ? " A request already started may still finish." : ""));
  }

  function onFocus(event) {
    const element = event.target;
    if (element && element.matches && element.matches(allSendButtons)) element.blur();
  }

  function keyOf(event) {
    if (event.key === "Enter" || event.code === "NumpadEnter" || event.keyCode === 13) return "Enter";
    if (event.key === "Escape" || event.keyCode === 27) return "Escape";
    return "";
  }

  function onKey(event) {
    const key = keyOf(event);
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopKey = stopKey || key;
    onFocus({ target: document.activeElement });
    stop("Stopped with " + key);
  }

  function onKeyUp(event) {
    if (stopped && keyOf(event) === stopKey) cleanup();
  }

  function onWindowBlur() {
    if (stopped) cleanup();
  }

  function onManualClick(event) {
    if (!event.isTrusted || !event.target || !root.contains(event.target)) return;
    const button = event.target.closest && event.target.closest("button, a, input[type=button], input[type=submit]");
    if (button && (button.matches(tool.button) || button.matches(".twrp-primary") ||
      /^(Create (?:a )?plan|Refresh (?:village )?data)\b/i.test(textOf(button) || button.value || ""))) {
      stop("Stopped for your manual action");
    }
  }

  function schedule() {
    if (!stopped) timer = setTimeout(step, POLL_MS);
  }

  function step() {
    if (stopped) return;
    try {
      tick();
    } catch (error) {
      console.error("[Twactics auto-request]", error);
      stop("Unexpected error; stopped");
    }
  }

  function tick() {
    if (!root.isConnected || document.getElementById(tool.id) !== root) return stop("Tool closed or replaced");
    const state = getState();
    const planButton = tool.balancer && root.querySelector(".twrp-primary");
    if (tool.balancer && ((initialState && state !== initialState) ||
      (state && state.plan !== initialPlan) || (planButton && planButton.disabled))) {
      return stop("Plan changed; create and review the new plan before restarting");
    }
    const error = errorText();
    if (error) return stop(error + "; stopped");

    const now = Date.now();
    const buttons = getButtons();
    if (busy(buttons)) {
      if (pending) {
        pending.sawBusy = true;
        pending.settledAt = 0;
      }
      if (now - (pending ? pending.startedAt : waitStarted) >= REQUEST_TIMEOUT_MS) {
        return stop("Request or refresh timed out; check the tool before restarting");
      }
      schedule();
      return;
    }

    if (pending) {
      const completed = !root.contains(pending.button) || done(pending.button);
      if (!completed && !pending.sawBusy) {
        if (now - pending.startedAt >= START_TIMEOUT_MS) return stop("The button did not start a request; stopped");
        schedule();
        return;
      }
      if (!completed && tool.balancer && ready(pending.button)) {
        return stop("The request returned to Request without completing; stopped without retrying");
      }
      if (!completed && !ready(pending.button)) {
        if (now - pending.startedAt >= REQUEST_TIMEOUT_MS) return stop("Request did not finish; stopped");
        schedule();
        return;
      }
      if (!pending.settledAt) pending.settledAt = now;
      if (now - pending.settledAt < GAP_MS) {
        schedule();
        return;
      }
      pending = null;
      waitStarted = now;
    }

    const button = buttons.find(ready);
    if (!button) {
      return stop(buttons.every(done) ? "All request rows completed" : "No enabled Request button; stopped");
    }

    if (!tool.balancer) {
      let target = button.getAttribute("data-strr-request-target");
      if (target) {
        target = "target:" + target;
      } else {
        if (!buttonIds.has(button)) buttonIds.set(button, ++nextId);
        target = "button:" + buttonIds.get(button);
      }
      const count = attempts.get(target) || 0;
      if (count >= 3) return stop("The same Smart Sender request is still present after three attempts; stopped");
      attempts.set(target, count + 1);
    }

    pending = { button: button, startedAt: now, settledAt: 0, sawBusy: false };
    clicks += 1;
    button.blur();
    button.click();
    if (stopped) return;
    pending.sawBusy = busy(getButtons());
    schedule();
  }

  const initialError = errorText();
  if (initialError) {
    alert("Twactics auto-request cannot start: " + initialError);
    return;
  }
  if (busy(getButtons())) {
    alert("A Twactics request or refresh is already running. Wait for it to finish, then run this script again.");
    return;
  }

  window[KEY] = controller;
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("click", onManualClick, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onWindowBlur);
  onFocus({ target: document.activeElement });
  console.info("[Twactics auto-request] " + tool.name + ": started. Enter, Escape or running the script again stops further requests.");
  step();
})();
