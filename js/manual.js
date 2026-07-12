/* LT v0.7 — Product manual: customer-facing viewer + warranty-activation gate.
   A product manual is read, not operated: no gates, no ledger, no voice, no
   abort, no wake lock. Steps are grouped into SECTIONS; opening the manual
   shows the section list, and each section runs as a short guided read with
   plain NEXT taps. The one exception is critical_safety steps, which keep
   their red banner, assertion checkbox, and hold-to-confirm — safety content
   stays load-bearing even in a manual.

   Two entry points:
   - runPublicManual(publicId, ui, appVersion): a customer arriving from the
     QR code / public link, no login. When the KC requires a safety agreement
     the warranty-activation gate runs first (once per device — remembered in
     localStorage; a new device shows it again).
   - runManualViewer(doc, opts): the reading experience itself; also used by
     the company's VIEW MANUAL preview (backTo returns to the KC home). */

import * as backend from './backend.js';
import { sevOf, SEVERITY_BADGE } from './severity.js';

const AGREED_PREFIX = 'lt_manual_agreed_';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function agreementRecord(publicId) {
  try {
    const raw = localStorage.getItem(AGREED_PREFIX + publicId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function rememberAgreement(publicId, email) {
  try {
    localStorage.setItem(AGREED_PREFIX + publicId,
      JSON.stringify({ email, at: new Date().toISOString() }));
  } catch { /* private mode — the gate will simply show again next visit */ }
}

/* Sections in order of first appearance. Steps without a section (older
   content, or the author skipped the field) fall into 'General'. */
export function sectionsOf(doc) {
  const secs = [];
  for (const s of doc.steps || []) {
    const name = (s.section || '').trim() || 'General';
    let sec = secs.find((x) => x.name === name);
    if (!sec) { sec = { name, steps: [] }; secs.push(sec); }
    sec.steps.push(s);
  }
  return secs;
}

/* ================= public (QR / link) entry ================= */

export async function runPublicManual(publicId, ui, appVersion) {
  const body = document.getElementById('manual-body');
  document.getElementById('btn-manual-back').hidden = true;
  ui.show('screen-manual');
  body.innerHTML = '<p class="screen-sub">Loading the manual…</p>';

  let row = null;
  let offline = false;
  try {
    row = await backend.fetchPublicManual(publicId);
  } catch {
    offline = true;
  }

  if (!row || !row.doc || !(row.doc.steps || []).length) {
    body.innerHTML = `
      <div class="step-card">
        <div class="step-title">${offline ? 'No connection' : 'Manual not available'}</div>
        <p class="step-instruction">${offline
          ? 'The manual could not be loaded. Check the connection and reload this page.'
          : 'This manual is not available. Check the link, or contact the manufacturer of your product.'}</p>
      </div>`;
    return;
  }

  if (row.doc.requires_safety_agreement && !agreementRecord(publicId)) {
    await warrantyGate(row, publicId, ui, appVersion);
  }

  /* Public root: the viewer has nowhere to go "back" to — it stays open. */
  await runManualViewer(row.doc, { ui, title: row.title });
}

/* ================= warranty-activation gate =================
   Step A: to activate the warranty, the customer reads the safety protocol.
   Step B: they enter their email and press-and-hold AGREE. The record
   (email + the exact agreement text) is written server-side for the
   manufacturer; the device remembers so the gate shows once. */

function warrantyGate(row, publicId, ui, appVersion) {
  const body = document.getElementById('manual-body');
  return new Promise((resolve) => {
    const protocol = row.doc.safety_protocol_text || '';
    body.innerHTML = `
      <div class="manual-product">
        <div class="manual-product-name">${escapeHtml(row.title)}</div>
        <div class="manual-product-sub">USER MANUAL</div>
      </div>
      <div class="step-card safety">
        <div class="critical-banner safety">ACTIVATE YOUR WARRANTY</div>
        <p class="step-instruction">To activate the warranty for this product, read the
        safety protocol below and agree to follow it while using the product.</p>
        <div class="protocol-box">${escapeHtml(protocol)}</div>
      </div>
      <div class="field">
        <label for="gate-email">Your email — this registers your warranty with the manufacturer</label>
        <input id="gate-email" type="email" autocomplete="email" placeholder="name@example.com">
      </div>
      <div id="gate-msg" class="auth-msg"></div>
      <div id="gate-agree"></div>
      <p class="attest-fineprint">Your email, the date, and the safety protocol you agreed to
      are recorded with the manufacturer to activate your warranty.</p>
    `;

    const emailEl = document.getElementById('gate-email');
    const msgEl = document.getElementById('gate-msg');
    const agreeWrap = document.getElementById('gate-agree');
    let busy = false;

    /* A hold button fires once; each attempt (and each email edit) arms a
       fresh one so a failed send can simply be retried. */
    function arm() {
      agreeWrap.innerHTML = '';
      const hold = ui.holdButton('AGREE & ACTIVATE WARRANTY', 'press and hold to agree');
      hold.setDisabled(!EMAIL_RE.test(emailEl.value.trim()));
      hold.onComplete(async () => {
        if (busy) return;
        busy = true;
        const email = emailEl.value.trim();
        msgEl.textContent = 'Recording your warranty activation…';
        msgEl.className = 'auth-msg';
        try {
          await backend.insertRegistration({
            kcId: row.id, email,
            agreementText: protocol,
            appVersion
          });
          rememberAgreement(publicId, email);
          msgEl.textContent = 'Warranty activated.';
          msgEl.className = 'auth-msg ok';
          resolve();
        } catch {
          busy = false;
          msgEl.textContent = 'Could not record the activation — check the connection and try again.';
          msgEl.className = 'auth-msg bad';
          arm();
        }
      });
      agreeWrap.appendChild(hold.el);
      return hold;
    }

    let hold = arm();
    emailEl.addEventListener('input', () => {
      if (!busy) hold.setDisabled(!EMAIL_RE.test(emailEl.value.trim()));
    });
  });
}

/* ================= the manual viewer ================= */

export function runManualViewer(doc, { ui, title = null, backTo = null }) {
  return new Promise((resolve) => {
    const body = document.getElementById('manual-body');
    const backBtn = document.getElementById('btn-manual-back');
    const secs = sectionsOf(doc);
    const visited = new Set();
    ui.show('screen-manual');

    function setBack(label, fn) {
      if (!fn) { backBtn.hidden = true; backBtn.onclick = null; return; }
      backBtn.hidden = false;
      backBtn.innerHTML = '&#8592; ' + label;
      backBtn.onclick = fn;
    }

    function sectionsScreen() {
      ui.show('screen-manual');
      setBack('BACK', backTo ? () => { setBack('', null); resolve(); } : null);
      body.innerHTML = `
        <div class="manual-product">
          <div class="manual-product-name">${escapeHtml(title || doc.title)}</div>
          <div class="manual-product-sub">USER MANUAL</div>
        </div>
        <div class="gate-heading">Sections</div>
        <div id="manual-sections" class="builder-list"></div>
        <p class="attest-fineprint">Pick a section to be guided through it step by step.</p>
      `;
      const list = document.getElementById('manual-sections');
      for (const sec of secs) {
        const b = document.createElement('button');
        b.className = 'btn btn-secondary section-row' + (visited.has(sec.name) ? ' visited' : '');
        b.innerHTML = `
          <span class="section-name">${escapeHtml(sec.name)}</span>
          <span class="section-meta">${sec.steps.length} step${sec.steps.length === 1 ? '' : 's'}${visited.has(sec.name) ? ' · ✓' : ''}</span>
          <span class="section-arrow">&#8250;</span>`;
        b.addEventListener('click', () => runSection(sec));
        list.appendChild(b);
      }
    }

    async function runSection(sec) {
      for (let i = 0; i < sec.steps.length; i++) {
        const action = await renderStep(sec, i);
        if (action === 'sections') return sectionsScreen();
        if (action === 'prev') { i -= 2; continue; }
      }
      visited.add(sec.name);
      sectionsScreen();
    }

    /* One step of a section. Resolves 'next', 'prev', or 'sections'. */
    function renderStep(sec, i) {
      return new Promise((res) => {
        const step = sec.steps[i];
        const sev = sevOf(step);
        const last = i === sec.steps.length - 1;
        setBack('SECTIONS', () => res('sections'));

        body.innerHTML = `
          <div class="screen-sub">${escapeHtml(sec.name)} · step ${i + 1} of ${sec.steps.length}</div>
          <div class="step-card ${sev === 'critical_safety' ? 'critical safety' : sev === 'critical' ? 'critical' : ''}">
            ${sev !== 'standard' ? `<div class="critical-banner ${sev === 'critical_safety' ? 'safety' : ''}">${SEVERITY_BADGE[sev]}</div>` : ''}
            <div class="step-title">${escapeHtml(step.title)}</div>
            <p class="step-instruction">${escapeHtml(step.instruction)}</p>
            ${(step.critical_prerequisites || []).length && sev !== 'standard'
              ? `<div class="failure-note">Before this step, make sure:<br>• ${step.critical_prerequisites.map(escapeHtml).join('<br>• ')}</div>` : ''}
            ${step.failure_note ? `<div class="failure-note">${escapeHtml(step.failure_note)}</div>` : ''}
          </div>
          ${step.video ? '<video class="step-video" preload="metadata" controls playsinline></video>' : ''}
          <div id="manual-nav" style="display:flex;flex-direction:column;gap:12px;"></div>
        `;

        if (step.video) {
          const vidEl = body.querySelector('.step-video');
          backend.mediaUrl(step.video)
            .then((u) => { vidEl.src = u; })
            .catch(() => {
              const note = document.createElement('div');
              note.className = 'no-video';
              note.textContent = 'Video unavailable right now — the written step still applies.';
              vidEl.replaceWith(note);
            });
        }

        const nav = document.getElementById('manual-nav');
        const nextLabel = last ? 'DONE — BACK TO SECTIONS' : 'NEXT';

        if (sev === 'critical_safety' && step.safety_assertion) {
          /* Safety stays load-bearing: the assertion must be actively checked,
             and advancing is press-and-hold — same as a live session. */
          const item = document.createElement('label');
          item.className = 'check-item assert-item';
          item.innerHTML = `<input type="checkbox"><span class="check-decl">${escapeHtml(step.safety_assertion)}</span>`;
          nav.appendChild(item);
          const boxEl = item.querySelector('input');
          const hold = ui.holdButton(nextLabel, 'press and hold to continue');
          hold.setDisabled(true);
          boxEl.addEventListener('change', () => {
            item.classList.toggle('checked', boxEl.checked);
            hold.setDisabled(!boxEl.checked);
          });
          hold.onComplete(() => res('next'));
          nav.appendChild(hold.el);
        } else {
          const next = document.createElement('button');
          next.className = 'btn btn-primary btn-big';
          next.textContent = nextLabel;
          next.addEventListener('click', () => res('next'));
          nav.appendChild(next);
        }

        if (i > 0) {
          const prev = document.createElement('button');
          prev.className = 'btn btn-tertiary';
          prev.textContent = '← PREVIOUS STEP';
          prev.addEventListener('click', () => res('prev'));
          nav.appendChild(prev);
        }
      });
    }

    sectionsScreen();
  });
}
