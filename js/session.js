/* LT v0.1 — Active Session (Deploy Agent)
   Sterile, gated, spoken. The next step is never rendered or spoken until the
   current step's confirmation is in the ledger. CRM language rule: the system
   frames verification as the system doing its job — never doubt of the TECH. */

import { speak, stopSpeaking, voiceSupported, VoiceListener } from './speech.js';

const SNAPSHOT_KEY = 'lt_active_session';

export function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearSnapshot() {
  localStorage.removeItem(SNAPSHOT_KEY);
}

function saveSnapshot(state) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...state, last_activity: Date.now() }));
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min} min ${sec} s` : `${sec} s`;
}

export async function runSession(ctx, resumeState = null) {
  const { kc, ledger, ui } = ctx;
  const stepById = new Map(kc.steps.map((s) => [s.step_id, s]));
  const thresholdMs = (kc.interruption_threshold_minutes || 30) * 60 * 1000;

  const state = resumeState || {
    session_id: ctx.sessionId,
    current: kc.steps[0].step_id,
    completed: [],            // [{step_id, title}] in confirmation order
    confirmations: { voice: 0, tap: 0 },
    interruptions: 0,
    started_at: Date.now()
  };
  const sessionId = state.session_id;

  const body = document.getElementById('session-body');
  const progressEl = document.getElementById('session-progress');
  const pauseBtn = document.getElementById('btn-pause');

  let wakeLock = null;
  let sessionLive = true;

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      await ledger.append('wake_lock_status', { session_id: sessionId, detail: 'unsupported' });
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      await ledger.append('wake_lock_status', { session_id: sessionId, detail: 'acquired' });
      wakeLock.addEventListener('release', () => {
        if (sessionLive) ledger.append('wake_lock_status', { session_id: sessionId, detail: 'released' });
      });
    } catch (e) {
      await ledger.append('wake_lock_status', { session_id: sessionId, detail: 'failed: ' + e.message });
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && sessionLive) acquireWakeLock();
  };
  document.addEventListener('visibilitychange', onVisibility);

  function cleanup() {
    sessionLive = false;
    document.removeEventListener('visibilitychange', onVisibility);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    stopSpeaking();
    pauseBtn.style.display = 'none';
  }

  /* ---------- session begin (user gesture → fullscreen, wake lock, DND reminder) ---------- */
  ui.show('screen-session');
  pauseBtn.style.display = 'none';
  progressEl.textContent = '';

  await new Promise((resolve) => {
    body.innerHTML = `
      <div class="step-card">
        <div class="step-title">${resumeState ? 'Resuming session' : 'Session ready'}</div>
        <p class="step-instruction">The screen will stay awake and the app will go full screen.
        Enable <strong>Do Not Disturb</strong> on this phone now, so notifications cannot interrupt the procedure.</p>
      </div>
      <button class="btn btn-primary btn-big" id="btn-begin">DO NOT DISTURB IS ON — BEGIN</button>
    `;
    document.getElementById('btn-begin').addEventListener('click', async () => {
      try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* not fatal */ }
      await acquireWakeLock();
      await ledger.append(resumeState ? 'interruption_end' : 'dnd_reminder',
        resumeState
          ? { session_id: sessionId, detail: 'resumed_from_app_reload' }
          : { session_id: sessionId, detail: 'acknowledged' });
      resolve();
    });
  });

  /* Rapid reconfirmation when resuming with prior completed steps. */
  if (resumeState && state.completed.length > 0) {
    await rapidReconfirm();
  }

  /* ---------- main gated loop ---------- */
  while (state.current) {
    const step = stepById.get(state.current);
    const stepIndex = kc.steps.findIndex((s) => s.step_id === step.step_id);
    progressEl.textContent = `STEP ${stepIndex + 1} / ${kc.steps.length}`;
    pauseBtn.style.display = '';

    const outcome = await runStep(step);

    if (outcome.action === 'exit') { cleanup(); return outcome; }
    if (outcome.action === 'repeat') continue;

    state.completed.push({ step_id: step.step_id, title: step.title });

    let next = null;
    if (outcome.action === 'goto') {
      next = outcome.target;
    } else {
      next = stepIndex + 1 < kc.steps.length ? kc.steps[stepIndex + 1].step_id : null;
    }
    state.current = next;
    saveSnapshot(state);
  }

  /* ---------- completion ---------- */
  const durationMs = Date.now() - state.started_at;
  const summary = {
    duration: fmtDuration(durationMs),
    steps_confirmed: state.completed.length,
    voice: state.confirmations.voice,
    tap: state.confirmations.tap,
    interruptions: state.interruptions
  };
  await ledger.append('session_complete', { session_id: sessionId, detail: summary });
  clearSnapshot();
  cleanup();
  await speak('Procedure complete. All steps confirmed. Session closed.');
  return { action: 'complete', summary };

  /* ================= step runner ================= */

  async function runStep(step) {
    await ledger.append('step_presented', { session_id: sessionId, step_id: step.step_id });

    body.innerHTML = `
      <div class="step-card ${step.critical ? 'critical' : ''}">
        ${step.critical ? '<div class="critical-banner">CRITICAL ACTION</div>' : ''}
        <div class="step-title">${step.title}</div>
        <div class="step-label-tag">${step.equipment_label || ''}</div>
        <p class="step-instruction">${step.instruction}</p>
        ${step.failure_note ? `<div class="failure-note">${step.failure_note}</div>` : ''}
      </div>
      ${step.video ? `
        <video class="step-video" src="${step.video}" preload="metadata" controls playsinline></video>
      ` : ''}
      <button class="btn btn-replay" id="btn-replay">&#128266; REPLAY INSTRUCTION</button>
      <div id="confirm-area" style="display:flex;flex-direction:column;gap:14px;"></div>
    `;

    const confirmArea = document.getElementById('confirm-area');

    const speakStep = async () => {
      const text = (step.critical ? 'Critical action. Verify before execution. ' : '') + step.phraseology;
      await speak(text);
      await ledger.append('step_spoken', { session_id: sessionId, step_id: step.step_id });
    };
    document.getElementById('btn-replay').addEventListener('click', () => {
      if (listener) listener.suspend();
      speakStep().then(() => { if (listener) listener.resume(); });
    });

    let listener = null;
    let pauseRequested = null; // set by pause button while a stage is running

    const onPauseClick = () => { pauseRequested = true; if (listener) listener.stop(); stopSpeaking(); };
    pauseBtn.onclick = onPauseClick;

    await speakStep();

    /* ----- stage 1 for critical steps: prerequisite verification (tap required) ----- */
    if (step.critical && step.critical_prerequisites.length > 0) {
      const stage1 = await new Promise((resolve) => {
        const block = document.createElement('div');
        block.className = 'prereq-block';
        block.innerHTML = `<h4>STAGE 1 — VERIFY PREREQUISITES</h4>` +
          step.critical_prerequisites.map((p, i) => `
            <label class="prereq-item"><input type="checkbox" data-prereq="${i}"><span>${p}</span></label>
          `).join('');
        confirmArea.appendChild(block);

        const holdEl = ui.holdButton('PREREQUISITES VERIFIED', 'press and hold', true);
        holdEl.setDisabled(true);
        confirmArea.appendChild(holdEl.el);

        const boxes = Array.from(block.querySelectorAll('input[type=checkbox]'));
        boxes.forEach((b) => b.addEventListener('change', () => {
          holdEl.setDisabled(!boxes.every((x) => x.checked));
        }));

        holdEl.onComplete(() => resolve('confirmed'));

        // pause can interrupt stage 1
        const iv = setInterval(() => {
          if (pauseRequested) { clearInterval(iv); resolve('paused'); }
        }, 200);
      });

      if (stage1 === 'paused') return await pauseFlow(step);

      await ledger.append('critical_prereq_confirm', {
        session_id: sessionId, step_id: step.step_id, method: 'tap',
        detail: { prerequisites: step.critical_prerequisites }
      });
      await speak('Prerequisites verified. Execute.');
      confirmArea.innerHTML = '';
    }

    /* ----- stage 2: execution confirmation — voice with tap fallback ----- */
    const result = await new Promise((resolve) => {
      const status = document.createElement('div');
      status.className = 'voice-status';
      status.innerHTML = `<div class="mic-dot"></div><div class="voice-text">Preparing voice confirmation…</div>`;
      confirmArea.appendChild(status);
      const statusText = status.querySelector('.voice-text');

      const hold = ui.holdButton(step.required_callout.toUpperCase(), 'press and hold to confirm', step.critical);
      confirmArea.appendChild(hold.el);
      hold.onComplete(() => finish({ method: 'tap', detail: null }));

      let alt = null;
      if (step.alternate_confirm) {
        alt = ui.holdButton(step.alternate_confirm.label, 'press and hold', true);
        confirmArea.appendChild(alt.el);
        alt.onComplete(() => finish({ method: 'tap', detail: step.alternate_confirm.detail, spoken: step.alternate_confirm.spoken }));
      }

      let done = false;
      function finish(r) {
        if (done) return;
        done = true;
        if (listener) { listener.stop(); listener = null; }
        clearInterval(iv);
        resolve(r);
      }

      const iv = setInterval(() => {
        if (pauseRequested && !done) { done = true; if (listener) { listener.stop(); listener = null; } clearInterval(iv); resolve({ paused: true }); }
      }, 200);

      if (voiceSupported() && navigator.onLine) {
        listener = new VoiceListener(step.callout_keywords, {
          onMatch: (transcript) => finish({ method: 'voice', detail: { transcript } }),
          onReject: async (transcript) => {
            await ledger.append('callout_rejected', {
              session_id: sessionId, step_id: step.step_id, method: 'voice',
              detail: { heard: transcript, required: step.required_callout }
            });
            statusText.innerHTML = `Standing by for callout: <span class="callout-want">“${step.required_callout}”</span>`;
            listener.suspend();
            await speak(`Confirming we heard the required callout. Say: ${step.required_callout}.`);
            if (listener) listener.resume();
          },
          onUnavailable: (reason) => {
            const why = reason === 'mic-denied' ? 'Microphone unavailable'
              : reason === 'offline' ? 'Voice needs a network connection'
              : 'Voice not supported on this device';
            statusText.textContent = `${why} — confirm with the hold button below.`;
            status.classList.remove('listening');
          },
          onStateChange: (on) => {
            status.classList.toggle('listening', on);
            if (on) statusText.innerHTML = `Listening for callout: <span class="callout-want">“${step.required_callout}”</span>`;
          }
        });
        listener.start();
      } else {
        statusText.textContent = (voiceSupported() ? 'Voice needs a network connection' : 'Voice not supported on this device')
          + ' — confirm with the hold button below.';
      }
    });

    if (result.paused) return await pauseFlow(step);

    state.confirmations[result.method]++;
    await ledger.append('step_confirmed', {
      session_id: sessionId, step_id: step.step_id, method: result.method, detail: result.detail
    });

    pauseBtn.onclick = null;
    if (result.spoken) {
      await speak(result.spoken);
    } else {
      await speak(`${step.required_callout}. Confirmed.`);
    }

    /* ----- post-step decision (IF/THEN branch, e.g. after S13) ----- */
    if (step.post_decision) {
      const choice = await new Promise((resolve) => {
        body.innerHTML = `
          <div class="decision-block">
            <div class="decision-prompt">${step.post_decision.prompt}</div>
            <div id="decision-actions" style="display:flex;flex-direction:column;gap:12px;"></div>
          </div>
        `;
        const actions = document.getElementById('decision-actions');
        step.post_decision.options.forEach((opt) => {
          const h = ui.holdButton(opt.label, 'press and hold');
          h.onComplete(() => resolve(opt));
          actions.appendChild(h.el);
        });
        speak(step.post_decision.prompt);
      });
      await ledger.append('branch_decision', {
        session_id: sessionId, step_id: step.step_id, method: 'tap',
        detail: { decision: choice.detail, goto: choice.goto }
      });
      await speak(choice.spoken);
      return { action: 'goto', target: choice.goto };
    }

    return { action: 'advance' };
  }

  /* ================= pause / interruption ================= */

  async function pauseFlow(step) {
    state.interruptions++;
    const pausedAt = Date.now();
    await ledger.append('interruption_start', { session_id: sessionId, step_id: step.step_id });
    saveSnapshot({ ...state, paused_at: pausedAt });

    ui.show('screen-pause');
    const timerEl = document.getElementById('pause-timer');
    const noteEl = document.getElementById('pause-note');
    noteEl.textContent = `Resume within ${kc.interruption_threshold_minutes} minutes for rapid reconfirmation. After that, the session restarts from the beginning.`;
    const tick = setInterval(() => { timerEl.textContent = fmtClock(Date.now() - pausedAt); }, 500);

    const choice = await new Promise((resolve) => {
      document.getElementById('btn-resume').onclick = () => resolve('resume');
      document.getElementById('btn-abandon').onclick = async () => {
        const sure = await ui.modal('End this session? The procedure is not complete. This will be recorded.', ['END SESSION', 'STAY PAUSED']);
        if (sure === 0) resolve('abandon');
      };
      document.getElementById('btn-pause-review').onclick = () => { ui.openReview('screen-pause'); };
    });
    clearInterval(tick);

    if (choice === 'abandon') {
      await ledger.append('session_abandoned', { session_id: sessionId, step_id: step.step_id, detail: { elapsed_pause_ms: Date.now() - pausedAt } });
      clearSnapshot();
      return { action: 'exit', reason: 'abandoned' };
    }

    const elapsed = Date.now() - pausedAt;
    if (elapsed >= thresholdMs) {
      await ledger.append('session_restart_forced', {
        session_id: sessionId, step_id: step.step_id,
        detail: { pause_minutes: Math.round(elapsed / 60000), threshold_minutes: kc.interruption_threshold_minutes }
      });
      clearSnapshot();
      await ui.modal('The pause exceeded ' + kc.interruption_threshold_minutes + ' minutes. To protect the procedure, the session must restart from the beginning, including all gates.', ['UNDERSTOOD']);
      return { action: 'exit', reason: 'restart_forced' };
    }

    ui.show('screen-session');
    if (state.completed.length > 0) await rapidReconfirm();
    await ledger.append('interruption_end', { session_id: sessionId, step_id: step.step_id, detail: { pause_ms: elapsed } });
    return { action: 'repeat' }; // re-present the current step in full
  }

  /* ================= rapid reconfirmation ================= */

  async function rapidReconfirm() {
    pauseBtn.style.display = 'none';
    progressEl.textContent = 'RECONFIRM';
    body.innerHTML = `
      <div class="step-card">
        <div class="step-title">Rapid reconfirmation</div>
        <p class="step-instruction">Confirming the record matches the work already done. Tap COMPLETE as each completed step is read aloud.</p>
      </div>
      <div id="reconfirm-list"></div>
    `;
    const list = document.getElementById('reconfirm-list');

    for (let i = 0; i < state.completed.length; i++) {
      const c = state.completed[i];
      const row = document.createElement('div');
      row.className = 'reconfirm-item';
      row.innerHTML = `<span>${i + 1}. ${c.title}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'COMPLETE';
      row.appendChild(btn);
      list.appendChild(row);
      row.scrollIntoView({ block: 'nearest' });

      await speak(`Step. ${c.title}.`);
      await new Promise((resolve) => { btn.onclick = resolve; });
      btn.disabled = true;
      row.classList.add('done');
      await ledger.append('rapid_reconfirm', { session_id: sessionId, step_id: c.step_id, method: 'tap' });
    }
    await speak('Reconfirmation complete. Resuming procedure.');
  }
}
