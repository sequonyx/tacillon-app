/* LT v0.1 — App controller: screens, UI helpers, wiring. */

import { Ledger } from './ledger.js';
import { runGates } from './gates.js';
import { runSession, loadSnapshot, clearSnapshot } from './session.js';
import { chooseClosureReason, appendSessionClosed } from './closure.js';
import { renderReview } from './review.js';

const APP_VERSION = '0.2.0';
const HOLD_SECONDS = 1.5;

/* ---------------- UI helpers ---------------- */

function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  window.scrollTo(0, 0);
}

/* Hold-to-confirm button: press and hold 1.5 s. Prevents accidental taps.
   variant: false = green confirm, true = amber critical, 'danger' = red decline/abort */
function holdButton(label, hint, variant = false) {
  const el = document.createElement('button');
  el.className = 'hold-btn' + (variant === 'danger' ? ' danger' : variant ? ' warn' : '');
  el.innerHTML = `
    <span class="hold-fill"></span>
    <span class="hold-label">${label}</span>
    <span class="hold-hint">${hint || 'press and hold'}</span>
  `;
  const fill = el.querySelector('.hold-fill');

  let raf = null;
  let startAt = 0;
  let completeCb = null;
  let fired = false;

  function frame() {
    const pct = Math.min(1, (performance.now() - startAt) / (HOLD_SECONDS * 1000));
    fill.style.width = (pct * 100) + '%';
    if (pct >= 1) {
      cancel(false);
      fill.style.width = '100%';
      if (!fired && completeCb) { fired = true; completeCb(); }
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function begin(e) {
    if (el.disabled || fired) return;
    e.preventDefault();
    startAt = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function cancel(resetFill = true) {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (resetFill) fill.style.width = '0%';
  }

  el.addEventListener('pointerdown', begin);
  el.addEventListener('pointerup', () => cancel());
  el.addEventListener('pointercancel', () => cancel());
  el.addEventListener('pointerleave', () => cancel());
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    el,
    onComplete(cb) { completeCb = cb; },
    setDisabled(v) { el.disabled = v; }
  };
}

/* Simple modal. Returns index of the tapped button. */
function modal(text, buttonLabels) {
  return new Promise((resolve) => {
    const wrap = document.getElementById('modal');
    document.getElementById('modal-text').textContent = text;
    const actions = document.getElementById('modal-actions');
    actions.innerHTML = '';
    buttonLabels.forEach((label, i) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (i === 0 ? 'btn-primary' : 'btn-secondary');
      b.textContent = label;
      b.addEventListener('click', () => { wrap.classList.add('hidden'); resolve(i); });
      actions.appendChild(b);
    });
    wrap.classList.remove('hidden');
  });
}

/* Modal with a text input. Returns the typed string, or null if cancelled. */
function modalInput(text, placeholder) {
  return new Promise((resolve) => {
    const wrap = document.getElementById('modal');
    document.getElementById('modal-text').textContent = text;
    const actions = document.getElementById('modal-actions');
    actions.innerHTML = '';

    const input = document.createElement('input');
    input.className = 'label-input';
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    actions.appendChild(input);

    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = 'RECORD';
    save.addEventListener('click', () => { wrap.classList.add('hidden'); resolve(input.value); });
    actions.appendChild(save);

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', () => { wrap.classList.add('hidden'); resolve(null); });
    actions.appendChild(cancel);

    wrap.classList.remove('hidden');
    input.focus();
  });
}

let reviewBackTarget = 'screen-home';
function openReview(backTarget = 'screen-home') {
  reviewBackTarget = backTarget;
  renderReview(ctx);
  show('screen-review');
}

const ui = { show, holdButton, modal, modalInput, openReview };

/* ---------------- boot ---------------- */

/* sessionId is set only while a session flow is live, so nothing (e.g. a
   review_view from the home screen) can attach a session to the ledger before
   the first gate label confirm. pendingSessionId is the identity generated on
   app open, held internally until a session actually starts. */
const ctx = {
  kc: null, ledger: new Ledger(), ui,
  sessionId: null, pendingSessionId: null,
  sessionLogged: false,   // set by gates.js at the first gate_label_confirm
  appVersion: APP_VERSION
};

function newSessionId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `LT-${t}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

async function boot() {
  document.getElementById('app-version').textContent = 'v' + APP_VERSION;
  ctx.pendingSessionId = newSessionId(); // generated on app open, not yet in the ledger

  // Load the Knowledge Container
  try {
    const res = await fetch('kc/pool-cleaning.json');
    ctx.kc = await res.json();
  } catch (e) {
    document.getElementById('home-status').textContent =
      'Could not load the knowledge container. Check the connection and reload.';
    show('screen-home');
    return;
  }

  document.getElementById('home-kc-title').textContent =
    `${ctx.kc.title} — ${ctx.kc.kc_id} v${ctx.kc.kc_version}`;
  document.getElementById('home-status').textContent =
    `${ctx.kc.steps.length} steps · OC: ${ctx.kc.oc_name} · all data stays on this phone`;

  // Service worker for offline app shell + installability
  if ('serviceWorker' in navigator) {
    // When a new version finishes installing it takes control immediately
    // (skipWaiting + clients.claim). Reload once so the fresh files show on
    // THIS launch instead of the next one — but only from the home screen,
    // never mid-session.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return; // first-ever install: nothing old to replace
      if (!document.getElementById('screen-home').classList.contains('active')) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }

  wireHome();
  show('screen-home');
  await resolveIncompleteSession();
}

function wireHome() {
  document.getElementById('btn-start-session').addEventListener('click', startSession);
  document.getElementById('btn-review-mode').addEventListener('click', () => openReview('screen-home'));
  document.getElementById('btn-ledger').addEventListener('click', showLedgerScreen);

  document.querySelectorAll('[data-back]').forEach((b) =>
    b.addEventListener('click', () => show(reviewBackTarget && b.closest('#screen-review') ? reviewBackTarget : 'screen-home')));

  document.getElementById('btn-blocked-home').addEventListener('click', () => show('screen-home'));
  document.getElementById('btn-summary-home').addEventListener('click', () => show('screen-home'));

  document.getElementById('btn-gate-abort').addEventListener('click', async () => {
    const sure = await modal('Exit the gate sequence? No session will start.', ['EXIT', 'CONTINUE GATES']);
    if (sure === 0) {
      /* Before the first label confirm the session never entered the ledger —
         exiting writes nothing. After it, the exit is a terminal path and
         must close with a recorded reason. */
      if (ctx.sessionLogged) {
        await ctx.ledger.append('gate_declined', {
          session_id: ctx.sessionId,
          detail: { gate: 'exit', reason: 'TECH exited the gate sequence' }
        });
        const reason = await chooseClosureReason(ui);
        await appendSessionClosed(ctx.ledger, {
          session_id: ctx.sessionId, closed_from: 'gate_declined', reason
        });
      }
      location.reload();
    }
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    await ctx.ledger.append('export', { detail: { entries: ctx.ledger.entries.length } });
    ctx.ledger.export();
  });

  document.getElementById('btn-delete-history').addEventListener('click', async () => {
    const entries = ctx.ledger.entries;
    if (entries.length === 0 ||
        (entries.length === 1 && entries[0].event_type === 'ledger_cleared')) {
      await modal('There is no history to delete.', ['OK']);
      return;
    }
    /* An export appends an 'export' event last, so anything after it means
       there are entries no exported file contains. */
    if (entries[entries.length - 1].event_type !== 'export') {
      const pick = await modal(
        'Some entries have not been exported. Deleting is permanent — export first to keep a copy.',
        ['EXPORT NOW', 'DELETE WITHOUT EXPORTING', 'CANCEL']);
      if (pick === 0) {
        await ctx.ledger.append('export', { detail: { entries: entries.length } });
        ctx.ledger.export();
        return; // tap DELETE HISTORY again once the file is saved
      }
      if (pick === 2) return;
    } else {
      const pick = await modal(
        'Delete all ledger history from this phone? Exported files are not affected. This cannot be undone.',
        ['CANCEL', 'DELETE HISTORY']);
      if (pick === 0) return;
    }
    await ctx.ledger.clear();
    showLedgerScreen(); // re-render: list is empty again
  });

  document.getElementById('btn-verify').addEventListener('click', async () => {
    const out = document.getElementById('verify-result');
    out.textContent = 'Verifying…';
    out.className = 'verify-result';
    const r = await ctx.ledger.verify();
    if (r.ok) {
      out.textContent = `Integrity verified — ${r.count} entries, hash chain intact.`;
      out.className = 'verify-result ok';
    } else {
      out.textContent = `INTEGRITY FAILURE at entry #${r.brokenAt}: ${r.reason}.`;
      out.className = 'verify-result bad';
    }
  });
}

/* ---------------- session flow ---------------- */

async function startSession() {
  /* A new session cannot start while an incomplete one is unresolved. */
  const resolved = await resolveIncompleteSession();
  if (resolved === 'resumed') return; // the prior session ran instead

  ctx.sessionId = ctx.pendingSessionId;
  ctx.sessionLogged = false;
  /* No ledger entry yet — the session enters the ledger at the first
     successful gate_label_confirm, or not at all. */

  await runGatedSession();
}

/* Gates, then the guided session. Used for new sessions and for continuing
   a session that was interrupted during the gate sequence. */
async function runGatedSession() {
  const gateResult = await runGates(ctx);
  if (!gateResult.passed) {
    /* Terminal path: a session that entered the ledger must close with a
       recorded reason, even when it ends at gate_declined. */
    if (ctx.sessionLogged) {
      const reason = await chooseClosureReason(ui, {
        heading: 'The session ended at a gate. The closure reason will be recorded in the ledger:'
      });
      await appendSessionClosed(ctx.ledger, {
        session_id: ctx.sessionId, closed_from: 'gate_declined', reason
      });
    }
    endSessionContext();
    document.getElementById('blocked-reason').textContent = gateResult.reason;
    show('screen-blocked');
    return;
  }

  const result = await runSession(ctx);
  finishSession(result);
}

function endSessionContext() {
  ctx.sessionId = null;
  ctx.sessionLogged = false;
  ctx.pendingSessionId = newSessionId(); // fresh identity for the next session
}

function finishSession(result) {
  endSessionContext();
  if (result.action === 'complete') {
    const s = result.summary;
    document.getElementById('summary-body').innerHTML = `
      <div class="summary-stat"><span class="k">Duration</span><span class="v">${s.duration}</span></div>
      <div class="summary-stat"><span class="k">Steps confirmed</span><span class="v">${s.steps_confirmed}</span></div>
      <div class="summary-stat"><span class="k">Voice confirmations</span><span class="v">${s.voice}</span></div>
      <div class="summary-stat"><span class="k">Tap confirmations</span><span class="v">${s.tap}</span></div>
      <div class="summary-stat"><span class="k">Interruptions</span><span class="v">${s.interruptions}</span></div>
      <div class="summary-stat"><span class="k">Ledger</span><span class="v">recorded &amp; chained</span></div>
    `;
    show('screen-summary');
  } else {
    show('screen-home');
  }
}

/* ---------------- single active session + crash recovery ----------------

   An incomplete session = started (present in the ledger) but neither
   session_complete nor session_closed. It must be continued or closed out
   (with a recorded reason) before anything else can start. */

function findIncompleteSession() {
  const snap = loadSnapshot();
  const latest = ctx.ledger.latestSessionStatus();

  if (snap) {
    if (latest && latest.session_id === snap.session_id && !latest.open) {
      clearSnapshot(); // terminal event already recorded — snapshot is stale
    } else {
      return { kind: 'resumable', snap };
    }
  }
  if (latest && latest.open) {
    return {
      /* gate_declined already recorded but the app closed before the closure
         reason was: only the reason is still owed. Otherwise the app closed
         during the gate sequence, where no resumable state is persisted. */
      kind: latest.declined ? 'needs_closure' : 'unresumable',
      session_id: latest.session_id,
      step_id: latest.lastEvent ? latest.lastEvent.step_id : null
    };
  }
  return null;
}

/* Returns false (nothing to resolve), 'resumed', or 'closed'. */
async function resolveIncompleteSession() {
  const inc = findIncompleteSession();
  if (!inc) return false;

  if (inc.kind === 'resumable') {
    const pick = await modal('Continue previous session?', ['CONTINUE', 'CLOSE OUT']);
    if (pick === 0) {
      ctx.sessionId = inc.snap.session_id;
      ctx.sessionLogged = true;
      await ctx.ledger.append('session_resumed', {
        session_id: inc.snap.session_id, step_id: inc.snap.current, method: 'tap',
        detail: { resumed_at_step: inc.snap.current, steps_already_confirmed: inc.snap.completed.length }
      });
      const result = await runSession(ctx, inc.snap);
      finishSession(result);
      return 'resumed';
    }
    const reason = await chooseClosureReason(ui, { allowCancel: true });
    if (reason === null) return resolveIncompleteSession(); // backed out — the prompt is the only way past
    await appendSessionClosed(ctx.ledger, {
      session_id: inc.snap.session_id, step_id: inc.snap.current,
      closed_from: 'resume_prompt', reason
    });
    clearSnapshot();
    return 'closed';
  }

  if (inc.kind === 'needs_closure') {
    await modal('The previous session ended at a gate, but its closure reason was never recorded. Record it now.', ['RECORD REASON']);
    const reason = await chooseClosureReason(ui);
    await appendSessionClosed(ctx.ledger, {
      session_id: inc.session_id, step_id: inc.step_id, closed_from: 'gate_declined', reason
    });
    return 'closed';
  }

  /* Interrupted during the gate sequence: gate progress is not persisted, so
     Continue re-runs the gates from the start under the same session id
     (founder decision, 2026-07-10). */
  const pick = await modal('Continue previous session? It was interrupted during the pre-session gates, so the gates will run again from the start.', ['CONTINUE', 'CLOSE OUT']);
  if (pick === 0) {
    ctx.sessionId = inc.session_id;
    ctx.sessionLogged = true; // already in the ledger — keep its identity
    await ctx.ledger.append('session_resumed', {
      session_id: inc.session_id, method: 'tap',
      detail: { resumed_at_step: null, resume_point: 'gates_rerun_from_start' }
    });
    await runGatedSession();
    return 'resumed';
  }
  const reason = await chooseClosureReason(ui, { allowCancel: true });
  if (reason === null) return resolveIncompleteSession(); // backed out — the prompt is the only way past
  await appendSessionClosed(ctx.ledger, {
    session_id: inc.session_id, step_id: inc.step_id, closed_from: 'resume_prompt',
    reason, extra: { interrupted_during: 'gates' }
  });
  return 'closed';
}

/* ---------------- ledger screen ---------------- */

function showLedgerScreen() {
  const wrap = document.getElementById('ledger-sessions');
  document.getElementById('verify-result').textContent = '';
  const sums = ctx.ledger.sessionSummaries();
  wrap.innerHTML = sums.length === 0 ? '<p class="review-hint">No sessions recorded yet.</p>' : '';
  for (const s of sums) {
    const d = document.createElement('div');
    d.className = 'ledger-session-card';
    const status = s.completed ? 'COMPLETED'
      : s.closed_reason ? `CLOSED — ${s.closed_reason.toUpperCase()}`
      : s.blocked ? 'BLOCKED AT GATE'
      : 'NOT COMPLETED';
    d.innerHTML = `
      <h3>${s.session_id}</h3>
      <div class="meta">${new Date(s.started).toLocaleString()} — ${status}</div>
      <div class="meta">${s.events} events · ${s.steps_confirmed} steps confirmed
        (${s.voice} voice / ${s.tap} tap) · ${s.interruptions} interruption(s)</div>
    `;
    wrap.appendChild(d);
  }
  show('screen-ledger');
}

boot();
