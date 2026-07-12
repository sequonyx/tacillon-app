/* LT v0.7 — Product manual publishing (company side, online-only).
   One screen: the safety-agreement settings, the publish switch, the public
   link + print-ready QR code, and the warranty-registration list. Publishing
   makes the manual readable by ANYONE holding the link — that is the point —
   so the state always comes fresh from the server, never from cache. */

import * as backend from './backend.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Returns { published } so the caller can refresh the library row. */
export async function runPublishScreen(ctx) {
  const body = document.getElementById('publish-body');
  const backBtn = document.getElementById('btn-publish-back');
  ctx.ui.show('screen-publish');
  body.innerHTML = '<p class="screen-sub">Checking the publish status…</p>';

  let finish = null;
  const done = new Promise((resolve) => { finish = resolve; });
  backBtn.onclick = () => finish();

  let state = null;         // { published, public_id } — server truth
  try {
    state = await backend.getPublishState(ctx.kcRef.id);
  } catch {
    body.innerHTML = `
      <p class="screen-sub">Publishing needs a connection — the server could not be reached.
      Go back and try again when online.</p>`;
    await done;
    return null;
  }

  let registrations = null; // null = failed to load
  try { registrations = await backend.listRegistrations(ctx.kcRef.id); } catch { /* shown as unavailable */ }

  render();
  await done;
  return { published: state.published };

  function publicUrl() {
    return location.origin + location.pathname + '?m=' + state.public_id;
  }

  async function saveSettings(requires, text) {
    ctx.kc.requires_safety_agreement = requires;
    ctx.kc.safety_protocol_text = text;
    await backend.saveKCDoc(ctx.kcRef.id, ctx.kc);
    backend.cacheUpdateKC({
      id: ctx.kcRef.id, kc_type: ctx.kcRef.kc_type,
      title: ctx.kc.title, doc: ctx.kc, updated_at: new Date().toISOString()
    });
  }

  function render() {
    const doc = ctx.kc;
    const steps = (doc.steps || []).length;
    const requires = !!doc.requires_safety_agreement;

    body.innerHTML = `
      <div class="gate-heading">${escapeHtml(doc.title)}</div>
      <div class="screen-sub">${steps} step${steps === 1 ? '' : 's'} ·
        ${state.published ? '<span class="live-tag">LIVE — anyone with the link or QR code can open this manual</span>' : 'not published — customers cannot open this manual yet'}</div>

      <div class="field">
        <label>Warranty gate</label>
        <label class="check-item ${requires ? 'checked' : ''}" id="p-req-row">
          <input type="checkbox" id="p-requires" ${requires ? 'checked' : ''}>
          <span class="check-decl">Customers must read and agree to a safety protocol to activate
          their warranty before the manual opens. Each agreement is recorded with their email.</span>
        </label>
      </div>
      <div class="field" id="p-protocol-field" ${requires ? '' : 'hidden'}>
        <label for="p-protocol">Safety protocol — exactly what the customer agrees to follow</label>
        <textarea id="p-protocol" rows="6" placeholder="e.g. Always unplug the unit before opening the housing. Keep away from water. Do not operate with a damaged cord.">${escapeHtml(doc.safety_protocol_text || '')}</textarea>
      </div>
      <button class="btn btn-secondary" id="p-save">SAVE SETTINGS</button>
      <div id="p-msg" class="auth-msg"></div>

      <button class="btn ${state.published ? 'btn-danger-ghost' : 'btn-primary btn-big'}" id="p-toggle">
        ${state.published ? 'UNPUBLISH — TAKE THE MANUAL OFFLINE' : 'PUBLISH TO CUSTOMERS'}</button>

      <div id="p-public" ${state.published ? '' : 'hidden'}>
        <div class="field">
          <label>Public link — opens the manual with no login</label>
          <div class="link-row">
            <input id="p-link" readonly value="${escapeHtml(publicUrl())}">
            <button class="btn btn-secondary row-edit" id="p-copy">COPY</button>
          </div>
        </div>
        <button class="btn btn-secondary" id="p-open">OPEN AS A CUSTOMER SEES IT</button>
        <div class="field" style="margin-top:10px;">
          <label>QR code — print it and put it on the product or its packaging</label>
          <div class="qr-card"><img id="p-qr" alt="QR code for this manual"></div>
          <div class="video-note">Press and hold the image to save or share it for printing.</div>
        </div>
      </div>

      <div class="gate-heading" style="margin-top:12px;">Warranty registrations</div>
      <div class="screen-sub" id="p-reg-sub"></div>
      <div id="p-reg-list" class="builder-list"></div>
    `;

    const $ = (id) => body.querySelector(id);
    const msg = (text, cls = '') => {
      $('#p-msg').textContent = text;
      $('#p-msg').className = 'auth-msg' + (cls ? ' ' + cls : '');
    };

    $('#p-requires').addEventListener('change', () => {
      $('#p-protocol-field').hidden = !$('#p-requires').checked;
      $('#p-req-row').classList.toggle('checked', $('#p-requires').checked);
    });

    $('#p-save').addEventListener('click', async () => {
      const requires = $('#p-requires').checked;
      const text = $('#p-protocol').value.trim();
      if (requires && !text) {
        msg('Write the safety protocol the customer must agree to, or switch the warranty gate off.', 'bad');
        return;
      }
      msg('Saving…');
      try {
        await saveSettings(requires, text);
        msg('Settings saved.', 'ok');
      } catch {
        msg('Could not save — check the connection and try again.', 'bad');
      }
    });

    $('#p-toggle').addEventListener('click', async () => {
      if (!state.published) {
        if (steps === 0) {
          msg('Add at least one step before publishing — customers would open an empty manual.', 'bad');
          return;
        }
        const requires = $('#p-requires').checked;
        const text = $('#p-protocol').value.trim();
        if (requires && !text) {
          msg('Write the safety protocol before publishing, or switch the warranty gate off.', 'bad');
          return;
        }
        const sure = await ctx.ui.modal(
          'Publish this manual? Anyone with the link or QR code can open it — no login. You can unpublish at any time.',
          ['CANCEL', 'PUBLISH']);
        if (sure !== 1) return;
        msg('Publishing…');
        try {
          await saveSettings(requires, text); // publish always carries the latest settings
          state = await backend.setPublished(ctx.kcRef.id, true);
          render();
        } catch {
          msg('Could not publish — check the connection and try again.', 'bad');
        }
      } else {
        const sure = await ctx.ui.modal(
          'Unpublish this manual? Customer links and printed QR codes stop working until it is published again. Warranty registrations are kept.',
          ['CANCEL', 'UNPUBLISH']);
        if (sure !== 1) return;
        msg('Unpublishing…');
        try {
          state = await backend.setPublished(ctx.kcRef.id, false);
          render();
        } catch {
          msg('Could not unpublish — check the connection and try again.', 'bad');
        }
      }
    });

    if (state.published) {
      $('#p-qr').src = qrDataUrl(publicUrl());
      $('#p-copy').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(publicUrl());
          $('#p-copy').textContent = 'COPIED';
          setTimeout(() => { const b = $('#p-copy'); if (b) b.textContent = 'COPY'; }, 1500);
        } catch {
          $('#p-link').select();
        }
      });
      $('#p-open').addEventListener('click', () => window.open(publicUrl(), '_blank'));
    }

    const regSub = $('#p-reg-sub');
    const regList = $('#p-reg-list');
    if (registrations === null) {
      regSub.textContent = 'Could not load registrations — check the connection.';
    } else if (registrations.length === 0) {
      regSub.textContent = 'No registrations yet. Each customer who agrees to the safety protocol appears here.';
    } else {
      const emp = registrations.filter((r) => r.kind === 'employee').length;
      regSub.textContent = `${registrations.length} record${registrations.length === 1 ? '' : 's'} — warranty activations`
        + (emp ? ` and ${emp} employee safety acknowledgement${emp === 1 ? '' : 's'}` : '')
        + '. These are your liability records.';
      for (const r of registrations) {
        const d = document.createElement('div');
        d.className = 'reg-row';
        d.innerHTML = `<span>${escapeHtml(r.email)}${r.kind === 'employee'
            ? `<span class="reg-emp"> · employee${r.employer_name ? ' at ' + escapeHtml(r.employer_name) : ''}</span>` : ''}</span>
          <span class="reg-date">${new Date(r.created_at).toLocaleDateString()}</span>`;
        regList.appendChild(d);
      }
    }
  }
}

/* Draw the QR to a canvas, return as a data-URL image (so a long-press on the
   phone offers save/share for printing). White quiet zone included. */
function qrDataUrl(url) {
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const scale = 8; // crisp enough to print at sticker size
  const size = (n + quiet * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) g.fillRect((quiet + c) * scale, (quiet + r) * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}
