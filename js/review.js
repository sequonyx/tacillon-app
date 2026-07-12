/* LT v0.1 — Review Mode
   Browsable library of ALL step clips — before, during (via pause), and outside
   sessions. No gates. Viewing a clip writes a review_view ledger event. */

import { mediaUrl } from './backend.js';
import { sevOf, SEVERITY_BADGE } from './severity.js';

export function renderReview(ctx) {
  const { kc, ledger } = ctx;
  const list = document.getElementById('review-list');
  list.innerHTML = '';

  /* Equipment with a linked product manual (captured in the builder, carried
     in the doc's manifest so it resolves offline-authored KCs too). */
  const manifest = kc.equipment_manifest || [];

  kc.steps.forEach((step, i) => {
    const sev = sevOf(step);
    const mEntry = step.equipment_label
      ? manifest.find((m) => m.label === step.equipment_label && m.manual_url)
      : null;
    const item = document.createElement('div');
    item.className = 'review-item'
      + (sev === 'critical_safety' ? ' critical safety' : sev === 'critical' ? ' critical' : '');

    item.innerHTML = `
      <h3>
        <span class="step-num">${String(i + 1).padStart(2, '0')}</span>
        <span>${step.title}</span>
        ${step.phase ? `<span class="badge-phase">${String(step.phase).toUpperCase()}</span>` : ''}
        ${sev !== 'standard' ? `<span class="${sev === 'critical_safety' ? 'badge-safety' : 'badge-critical'}">${SEVERITY_BADGE[sev]}</span>` : ''}
      </h3>
      <div class="review-instruction">${step.instruction}</div>
      ${sev === 'critical_safety' && step.safety_assertion
        ? `<div class="review-assertion">Safety assertion: ${step.safety_assertion}</div>` : ''}
    `;

    if (mEntry) {
      /* Opens in a new tab — never navigates away from a paused session. */
      const a = document.createElement('a');
      a.className = 'btn btn-secondary manual-link';
      a.href = mEntry.manual_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `📖 PRODUCT MANUAL — ${step.equipment_label}`;
      item.appendChild(a);
    }

    if (step.video) {
      const video = document.createElement('video');
      if (step.video.startsWith('vault:')) {
        /* cloud-stored clip: resolve a signed URL; offline → note instead */
        mediaUrl(step.video)
          .then((u) => { video.src = u; })
          .catch(() => {
            const note = document.createElement('div');
            note.className = 'no-video';
            note.textContent = 'Video unavailable offline — it will play when connected.';
            video.replaceWith(note);
          });
      } else {
        video.src = step.video;
        video.poster = step.video.replace('clips/', 'clips/thumbs/').replace('.mp4', '.jpg');
      }
      video.controls = true;
      video.playsInline = true;
      video.preload = 'none';

      let loggedThisPlay = false;
      video.addEventListener('play', () => {
        if (loggedThisPlay) return;
        loggedThisPlay = true;
        ledger.append('review_view', {
          session_id: ctx.sessionId || null,
          step_id: step.step_id
        });
      });
      video.addEventListener('ended', () => { loggedThisPlay = false; });

      // Only one clip plays at a time
      video.addEventListener('play', () => {
        list.querySelectorAll('video').forEach((v) => { if (v !== video) v.pause(); });
      });

      item.appendChild(video);
    } else {
      const note = document.createElement('div');
      note.className = 'no-video';
      note.textContent = 'No video for this step — guided by text and voice only.';
      item.appendChild(note);
    }

    list.appendChild(item);
  });
}
