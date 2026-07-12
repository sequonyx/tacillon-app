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

/* ================= safety-protocol gate =================
   The customer reads the safety protocol, then agrees as one of:
   - the OWNER: their agreement activates the product's warranty; or
   - an EMPLOYEE whose employer owns the product: they name the employer and
     acknowledge they have read (or will read immediately, before using the
     equipment) the full safety instructions.
   Either way the record — email, kind, employer, and the exact agreement
   text — is written server-side for the manufacturer, and the device
   remembers so the gate shows once. */

const EMPLOYEE_ACK =
  'I have read — or will read immediately, and before using this equipment — the full safety instructions above, and I will follow them.';

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
        <div class="critical-banner safety">SAFETY PROTOCOL</div>
        <p class="step-instruction">Before the manual opens, read the safety protocol below.
        You will agree to follow it while using this product.</p>
        <div class="protocol-box">${escapeHtml(protocol)}</div>
      </div>
      <div class="field">
        <label>Who is using this product?</label>
        <label class="radio-item"><input type="radio" name="gate-who" value="warranty" checked>
          <span>I bought it — <strong>activate my warranty</strong></span></label>
        <label class="radio-item"><input type="radio" name="gate-who" value="employee">
          <span>My <strong>employer</strong> owns it — I use it at work</span></label>
      </div>
      <div class="field" id="gate-employer-field" hidden>
        <label for="gate-employer">Your employer — the company this product belongs to</label>
        <input id="gate-employer" type="text" autocomplete="organization" placeholder="e.g. ACME Services LLC">
      </div>
      <div class="field">
        <label for="gate-email" id="gate-email-label">Your email — this registers your warranty with the manufacturer</label>
        <input id="gate-email" type="email" autocomplete="email" placeholder="name@example.com">
      </div>
      <label class="check-item assert-item" id="gate-ack-item" hidden>
        <input type="checkbox" id="gate-ack"><span class="check-decl">${escapeHtml(EMPLOYEE_ACK)}</span>
      </label>
      <div id="gate-msg" class="auth-msg"></div>
      <div id="gate-agree"></div>
      <p class="attest-fineprint">Your details, the date, and the safety protocol you agreed to
      are recorded with the manufacturer.</p>
    `;

    const emailEl = document.getElementById('gate-email');
    const employerEl = document.getElementById('gate-employer');
    const ackEl = document.getElementById('gate-ack');
    const ackItem = document.getElementById('gate-ack-item');
    const msgEl = document.getElementById('gate-msg');
    const agreeWrap = document.getElementById('gate-agree');
    let busy = false;
    let hold = null;

    const mode = () => body.querySelector('[name="gate-who"]:checked').value;
    const ready = () => {
      if (!EMAIL_RE.test(emailEl.value.trim())) return false;
      if (mode() === 'employee') return !!employerEl.value.trim() && ackEl.checked;
      return true;
    };

    /* A hold button fires once; every mode switch, edit, or failed attempt
       re-arms a fresh one so the gate can always be retried. */
    function arm() {
      agreeWrap.innerHTML = '';
      hold = ui.holdButton(
        mode() === 'employee' ? 'AGREE & OPEN THE MANUAL' : 'AGREE & ACTIVATE WARRANTY',
        'press and hold to agree');
      hold.setDisabled(!ready());
      hold.onComplete(async () => {
        if (busy) return;
        busy = true;
        const kind = mode();
        const email = emailEl.value.trim();
        const employerName = kind === 'employee' ? employerEl.value.trim() : null;
        msgEl.textContent = 'Recording your agreement…';
        msgEl.className = 'auth-msg';
        try {
          await backend.insertRegistration({
            kcId: row.id, email, kind, employerName,
            agreementText: kind === 'employee' ? `${protocol}\n\n${EMPLOYEE_ACK}` : protocol,
            appVersion
          });
          rememberAgreement(publicId, email);
          msgEl.textContent = kind === 'employee' ? 'Acknowledgement recorded.' : 'Warranty activated.';
          msgEl.className = 'auth-msg ok';
          resolve();
        } catch {
          busy = false;
          msgEl.textContent = 'Could not record the agreement — check the connection and try again.';
          msgEl.className = 'auth-msg bad';
          arm();
        }
      });
      agreeWrap.appendChild(hold.el);
    }

    body.querySelectorAll('[name="gate-who"]').forEach((r) => r.addEventListener('change', () => {
      const employee = mode() === 'employee';
      document.getElementById('gate-employer-field').hidden = !employee;
      ackItem.hidden = !employee;
      document.getElementById('gate-email-label').textContent = employee
        ? 'Your email — identifies who acknowledged the safety protocol'
        : 'Your email — this registers your warranty with the manufacturer';
      if (!busy) arm();
    }));
    emailEl.addEventListener('input', () => { if (!busy) hold.setDisabled(!ready()); });
    employerEl.addEventListener('input', () => { if (!busy) hold.setDisabled(!ready()); });
    ackEl.addEventListener('change', () => {
      ackItem.classList.toggle('checked', ackEl.checked);
      if (!busy) hold.setDisabled(!ready());
    });

    arm();
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
