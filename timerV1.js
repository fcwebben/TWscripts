	/*
	 * Copyright (c) 2026 Twactics
	 * License: MIT
	 *
	 * Standing Timer Alert
	 *
	 * Local timer with draggable in-game dialog.
	 * No server requests, no automation, no external files.
	 */

	(function() {
	    if (window.standingTimerLoaded) {
	        console.log("Standing Timer already loaded");
	        return;
	    }

	    window.standingTimerLoaded = true;

	    let timerInterval = null;
	    let blinkInterval = null;
	    let soundTimeouts = [];
	    let audioCtx = null;
	    let originalTitle = document.title;
	    let endTime = null;
	    let alarmTimeout = null;
	    let timerFinished = false;
	    let timerUi = null;

	    function getAudioContext() {
	        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	        if (!AudioContextClass) return null;

	        if (!audioCtx) {
	            audioCtx = new AudioContextClass();
	        }

	        return audioCtx;
	    }

	    function playBeep() {
	        try {
	            const ctx = getAudioContext();
	            if (!ctx) return;

	            if (ctx.state === "suspended") {
	                ctx.resume();
	            }

	            const osc = ctx.createOscillator();
	            const gain = ctx.createGain();

	            osc.type = "sine";
	            osc.frequency.setValueAtTime(850, ctx.currentTime);
	            gain.gain.setValueAtTime(0.09, ctx.currentTime);
	            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);

	            osc.connect(gain);
	            gain.connect(ctx.destination);

	            osc.start(ctx.currentTime);
	            osc.stop(ctx.currentTime + 0.22);
	        } catch (err) {
	            console.log("Audio error:", err);
	        }
	    }

	    function playBeepGroup(count, startDelay) {
	        for (let i = 0; i < count; i++) {
	            soundTimeouts.push(setTimeout(playBeep, startDelay + i * 140));
	        }
	    }

	    function playAlarmSequence() {
	        // 3 beeps, wait 2s, 3 beeps, wait 2s, 3 beeps, wait 2s, 3 beeps
	        playBeepGroup(3, 0);
	        playBeepGroup(3, 2900);
	        playBeepGroup(3, 5800);
	        playBeepGroup(3, 8400);
	    }

	    function startTitleBlink() {
	        if (blinkInterval) return;

	        let toggle = false;
	        blinkInterval = setInterval(() => {
	            document.title = toggle ? "TIMER DONE" : originalTitle;
	            toggle = !toggle;
	        }, 800);
	    }

	    function stopEverything() {
	        if (timerInterval) clearInterval(timerInterval);
	        if (blinkInterval) clearInterval(blinkInterval);
	        if (alarmTimeout) clearTimeout(alarmTimeout);

	        timerInterval = null;
	        blinkInterval = null;
	        alarmTimeout = null;
	        timerFinished = false;
	        timerUi = null;
	        endTime = null;

	        soundTimeouts.forEach(timeout => clearTimeout(timeout));
	        soundTimeouts = [];

	        document.removeEventListener("visibilitychange", handleTimerVisibilityCheck);
	        window.removeEventListener("focus", handleTimerVisibilityCheck);
	        window.removeEventListener("pageshow", handleTimerVisibilityCheck);

	        document.title = originalTitle;

	        const overlay = document.getElementById("standing-timer-box");
	        if (overlay) overlay.remove();

	        window.standingTimerLoaded = false;

	        console.log("Standing Timer stopped");
	    }

	    function formatTime(ms) {
	        const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	        const h = Math.floor(totalSeconds / 3600);
	        const m = Math.floor((totalSeconds % 3600) / 60);
	        const s = totalSeconds % 60;

	        return [
	            String(h).padStart(2, "0"),
	            String(m).padStart(2, "0"),
	            String(s).padStart(2, "0")
	        ].join(":");
	    }

	    function finishTimer() {
	        if (timerFinished) return;

	        timerFinished = true;

	        if (timerInterval) clearInterval(timerInterval);
	        if (alarmTimeout) clearTimeout(alarmTimeout);

	        timerInterval = null;
	        alarmTimeout = null;

	        if (timerUi) {
	            timerUi.countdown.textContent = "00:00:00";
	            timerUi.status.textContent = "Time is up";
	            timerUi.startBtn.disabled = false;
	            timerUi.startBtn.style.opacity = "1";
	        }

	        document.title = "TIMER DONE";

	        startTitleBlink();
	        playAlarmSequence();
	    }

	    function updateTimerDisplay() {
	        if (!endTime || timerFinished || !timerUi) return;

	        const remaining = endTime - Date.now();

	        if (remaining <= 0) {
	            finishTimer();
	            return;
	        }

	        const remainingText = formatTime(remaining);

	        timerUi.countdown.textContent = remainingText;
	        document.title = remainingText + " - Standing Timer";
	    }

	    function handleTimerVisibilityCheck() {
	        updateTimerDisplay();
	    }

	    function startTimer(durationMs, countdown, status, startBtn) {
	        if (timerInterval) clearInterval(timerInterval);
	        if (blinkInterval) clearInterval(blinkInterval);
	        if (alarmTimeout) clearTimeout(alarmTimeout);

	        soundTimeouts.forEach(timeout => clearTimeout(timeout));
	        soundTimeouts = [];

	        timerInterval = null;
	        blinkInterval = null;
	        alarmTimeout = null;
	        timerFinished = false;

	        timerUi = {
	            countdown: countdown,
	            status: status,
	            startBtn: startBtn
	        };

	        endTime = Date.now() + durationMs;

	        status.textContent = "Timer running";
	        startBtn.disabled = true;
	        startBtn.style.opacity = "0.6";

	        document.removeEventListener("visibilitychange", handleTimerVisibilityCheck);
	        window.removeEventListener("focus", handleTimerVisibilityCheck);
	        window.removeEventListener("pageshow", handleTimerVisibilityCheck);

	        document.addEventListener("visibilitychange", handleTimerVisibilityCheck);
	        window.addEventListener("focus", handleTimerVisibilityCheck);
	        window.addEventListener("pageshow", handleTimerVisibilityCheck);

	        updateTimerDisplay();

	        timerInterval = setInterval(updateTimerDisplay, 250);

	        // Backup trigger. Browsers may still throttle background tabs,
	        // but this gives the timer a second path to finish.
	        alarmTimeout = setTimeout(finishTimer, durationMs + 50);
	    }

	    function parseDuration(hh, mm, ss) {
	        const h = parseInt(hh, 10) || 0;
	        const m = parseInt(mm, 10) || 0;
	        const s = parseInt(ss, 10) || 0;
	        return (h * 3600 + m * 60 + s) * 1000;
	    }

	    function parseSpecificTime(value) {
	        if (!value) return null;

	        const parts = value.split(":");
	        if (parts.length < 2) return null;

	        const now = new Date();
	        const target = new Date();

	        target.setHours(parseInt(parts[0], 10) || 0);
	        target.setMinutes(parseInt(parts[1], 10) || 0);
	        target.setSeconds(parts[2] ? parseInt(parts[2], 10) || 0 : 0);
	        target.setMilliseconds(0);

	        if (target <= now) {
	            target.setDate(target.getDate() + 1);
	        }

	        return target.getTime() - now.getTime();
	    }

	    function clampDurationInput(input, maxValue) {
	        let value = String(input.value || "").replace(/\D/g, "");

	        if (value.length > 2) {
	            value = value.slice(0, 2);
	        }

	        if (value !== "") {
	            const numeric = Math.min(maxValue, parseInt(value, 10));
	            value = String(numeric);
	        }

	        input.value = value;
	    }

	    function setupDurationInput(input, maxValue, nextInput) {
	        input.maxLength = 2;
	        input.inputMode = "numeric";

	        input.addEventListener("focus", function() {
	            setTimeout(function() {
	                input.select();
	            }, 0);
	        });

	        input.addEventListener("click", function() {
	            input.select();
	        });

	        input.addEventListener("input", function() {
	            clampDurationInput(input, maxValue);

	            if (nextInput && String(input.value || "").length >= 2) {
	                nextInput.focus();

	                setTimeout(function() {
	                    nextInput.select();
	                }, 0);
	            }
	        });

	        input.addEventListener("blur", function() {
	            clampDurationInput(input, maxValue);
	        });
	    }

	    function makeDraggable(box, handle) {
	        let isDragging = false;
	        let offsetX = 0;
	        let offsetY = 0;

	        handle.addEventListener("mousedown", function(e) {
	            isDragging = true;
	            offsetX = e.clientX - box.offsetLeft;
	            offsetY = e.clientY - box.offsetTop;
	            document.body.style.userSelect = "none";
	        });

	        document.addEventListener("mousemove", function(e) {
	            if (!isDragging) return;

	            box.style.left = (e.clientX - offsetX) + "px";
	            box.style.top = (e.clientY - offsetY) + "px";
	            box.style.right = "auto";
	            box.style.bottom = "auto";
	        });

	        document.addEventListener("mouseup", function() {
	            isDragging = false;
	            document.body.style.userSelect = "";
	        });
	    }

	    function createDialog() {
	        const box = document.createElement("div");
	        box.id = "standing-timer-box";
	        box.style.position = "fixed";
	        box.style.top = "120px";
	        box.style.right = "40px";
	        box.style.width = "330px";
	        box.style.zIndex = "999999";
	        box.style.background = "#f4e4bc";
	        box.style.border = "2px solid #7d510f";
	        box.style.borderRadius = "6px";
	        box.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
	        box.style.color = "#2f1b00";
	        box.style.fontFamily = "Verdana, Arial, sans-serif";
	        box.style.fontSize = "13px";

	        const header = document.createElement("div");
	        header.textContent = "Standing Timer";
	        header.style.padding = "10px 12px";
	        header.style.fontWeight = "bold";
	        header.style.fontSize = "16px";
	        header.style.cursor = "move";
	        header.style.background = "#cfa95e";
	        header.style.borderBottom = "1px solid #7d510f";

	        const content = document.createElement("div");
	        content.style.padding = "12px";

	        const help = document.createElement("div");
	        help.textContent = "Choose a countdown duration or a specific target time.";
	        help.style.marginBottom = "10px";

	        const durationLabel = document.createElement("div");
	        durationLabel.textContent = "Countdown";
	        durationLabel.style.fontWeight = "bold";
	        durationLabel.style.marginBottom = "5px";

	        const durationWrap = document.createElement("div");
	        durationWrap.style.display = "flex";
	        durationWrap.style.gap = "6px";
	        durationWrap.style.marginBottom = "10px";

	        const hh = document.createElement("input");
	        const mm = document.createElement("input");
	        const ss = document.createElement("input");

	        [hh, mm, ss].forEach((input, index) => {
	            input.type = "text";
	            input.placeholder = ["HH", "MM", "SS"][index];
	            input.style.width = "70px";
	            input.style.padding = "6px";
	            input.style.border = "1px solid #7d510f";
	            input.style.borderRadius = "4px";
	            input.style.background = "#fffaf0";
	        });

	        setupDurationInput(hh, 24, mm);
	        setupDurationInput(mm, 60, ss);
	        setupDurationInput(ss, 60, null);

	        durationWrap.appendChild(hh);
	        durationWrap.appendChild(mm);
	        durationWrap.appendChild(ss);

	        const specificLabel = document.createElement("div");
	        specificLabel.textContent = "Specific time";
	        specificLabel.style.fontWeight = "bold";
	        specificLabel.style.marginBottom = "5px";

	        const timeInput = document.createElement("input");
	        timeInput.type = "time";
	        timeInput.step = "1";
	        timeInput.style.width = "130px";
	        timeInput.style.padding = "6px";
	        timeInput.style.border = "1px solid #7d510f";
	        timeInput.style.borderRadius = "4px";
	        timeInput.style.background = "#fffaf0";
	        timeInput.style.marginBottom = "12px";

	        const countdown = document.createElement("div");
	        countdown.textContent = "00:00:00";
	        countdown.style.fontSize = "30px";
	        countdown.style.fontWeight = "bold";
	        countdown.style.textAlign = "center";
	        countdown.style.margin = "12px 0";
	        countdown.style.padding = "10px";
	        countdown.style.background = "#fff4d5";
	        countdown.style.border = "1px solid #7d510f";
	        countdown.style.borderRadius = "4px";

	        const status = document.createElement("div");
	        status.textContent = "Timer not started";
	        status.style.textAlign = "center";
	        status.style.marginBottom = "12px";

	        const buttons = document.createElement("div");
	        buttons.style.display = "flex";
	        buttons.style.justifyContent = "space-between";
	        buttons.style.gap = "8px";

	        const startBtn = document.createElement("button");
	        startBtn.textContent = "Start";
	        startBtn.type = "button";
	        startBtn.style.flex = "1";
	        startBtn.style.padding = "8px 12px";
	        startBtn.style.border = "1px solid #7d510f";
	        startBtn.style.background = "#cfa95e";
	        startBtn.style.fontWeight = "bold";
	        startBtn.style.cursor = "pointer";
	        startBtn.style.borderRadius = "4px";

	        const stopBtn = document.createElement("button");
	        stopBtn.textContent = "Stop";
	        stopBtn.type = "button";
	        stopBtn.style.flex = "1";
	        stopBtn.style.padding = "8px 12px";
	        stopBtn.style.border = "1px solid #7d510f";
	        stopBtn.style.background = "#e6d3a5";
	        stopBtn.style.fontWeight = "bold";
	        stopBtn.style.cursor = "pointer";
	        stopBtn.style.borderRadius = "4px";

	        startBtn.addEventListener("click", function() {
	            let durationMs = 0;

	            if (timeInput.value) {
	                durationMs = parseSpecificTime(timeInput.value);
	            } else {
	                durationMs = parseDuration(hh.value, mm.value, ss.value);
	            }

	            if (!durationMs || durationMs <= 0) {
	                alert("Please enter a countdown or choose a specific time.");
	                return;
	            }

	            startTimer(durationMs, countdown, status, startBtn);
	        });

	        [hh, mm, ss, timeInput].forEach(function(input) {
	            input.addEventListener("keydown", function(event) {
	                if (event.key !== "Enter") return;

	                event.preventDefault();
	                startBtn.click();
	            });
	        });

	        stopBtn.addEventListener("click", stopEverything);

	        buttons.appendChild(startBtn);
	        buttons.appendChild(stopBtn);

	        content.appendChild(help);
	        content.appendChild(durationLabel);
	        content.appendChild(durationWrap);
	        content.appendChild(specificLabel);
	        content.appendChild(timeInput);
	        content.appendChild(countdown);
	        content.appendChild(status);
	        content.appendChild(buttons);
	        const footer = document.createElement("div");
	        footer.style.marginTop = "16px";
	        footer.style.display = "flex";
	        footer.style.justifyContent = "space-between";
	        footer.style.alignItems = "center";
	        footer.style.fontSize = "11px";
	        footer.style.opacity = "0.8";

	        const feedbackText = document.createElement("span");
	        feedbackText.textContent = "Enjoy!";

	        const createdBy = document.createElement("div");
	        createdBy.textContent = "Created by Twactics";

	        footer.appendChild(feedbackText);
	        footer.appendChild(createdBy);

	        content.appendChild(footer);

	        box.appendChild(header);
	        box.appendChild(content);

	        document.body.appendChild(box);
	        makeDraggable(box, header);
	    }

	    createDialog();

	    console.log("Standing Timer loaded");
	})();
