/* LT — Session closure (Deploy Agent)
   Every session that entered the ledger must end with exactly one terminal
   event: session_complete, or session_closed with an explicit reason.
   TESTING is logged as the literal single word so test sessions can be
   filtered out of operational data during analysis. */

export const CLOSURE_OPTIONS = [
  { label: 'EQUIPMENT MALFUNCTION', reason: 'equipment malfunction' },
  { label: 'EMERGENCY', reason: 'emergency' },
  { label: 'POWER OUTAGE', reason: 'power outage' },
  { label: 'TESTING', reason: 'TESTING' },
  { label: 'OTHER (STATE REASON)', reason: null } // freetext
];

/* Closure-reason screen. Returns the reason string to record.
   allowCancel: adds a cancel option and may return null (session stays open).
   Without allowCancel a reason is mandatory — the options re-present until
   one is chosen. */
export async function chooseClosureReason(ui, { allowCancel = false, heading } = {}) {
  const labels = CLOSURE_OPTIONS.map((o) => o.label);
  if (allowCancel) labels.push('CANCEL — DO NOT END SESSION');
  for (;;) {
    const pick = await ui.modal(
      heading || 'This session is ending before completion. The reason will be recorded in the ledger:',
      labels
    );
    if (allowCancel && pick === CLOSURE_OPTIONS.length) return null;
    const opt = CLOSURE_OPTIONS[pick];
    if (opt.reason !== null) return opt.reason;
    const text = await ui.modalInput('State the reason for ending the session:', 'reason');
    if (text !== null && text.trim() !== '') return 'other: ' + text.trim();
    if (allowCancel) return null;
  }
}

/* Append the mandatory terminal event for a session that did not complete. */
export function appendSessionClosed(ledger, { session_id, step_id = null, closed_from, reason, extra = null }) {
  return ledger.append('session_closed', {
    session_id,
    step_id,
    method: 'tap',
    detail: { reason, closed_from, ...(extra || {}) }
  });
}
