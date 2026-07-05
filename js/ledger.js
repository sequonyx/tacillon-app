/* LT v0.1 — Session Ledger
   Append-only, hash-chained log stored in localStorage.
   Every entry: {seq, timestamp_iso, session_id, event_type, step_id, method, detail, prev_hash, hash}
   hash = SHA-256 of the entry's canonical JSON (fixed key order) including prev_hash.
   First entry's prev_hash = "GENESIS". */

const STORE_KEY = 'lt_ledger_v1';

// Canonical serialization: fixed key order so hashes are reproducible.
function canonical(entry) {
  return JSON.stringify({
    seq: entry.seq,
    timestamp_iso: entry.timestamp_iso,
    session_id: entry.session_id,
    event_type: entry.event_type,
    step_id: entry.step_id,
    method: entry.method,
    detail: entry.detail,
    prev_hash: entry.prev_hash
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Ledger {
  constructor() {
    this.entries = this._load();
    this._queue = Promise.resolve(); // serialize appends so the chain stays ordered
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(this.entries));
  }

  /* Append an event. Returns a promise resolving to the stored entry. */
  append(event_type, { session_id = null, step_id = null, method = null, detail = null } = {}) {
    this._queue = this._queue.then(async () => {
      const prev = this.entries[this.entries.length - 1];
      const entry = {
        seq: this.entries.length + 1,
        timestamp_iso: new Date().toISOString(),
        session_id,
        event_type,
        step_id,
        method,
        detail,
        prev_hash: prev ? prev.hash : 'GENESIS'
      };
      entry.hash = await sha256Hex(canonical(entry));
      this.entries.push(entry);
      this._save();
      return entry;
    });
    return this._queue;
  }

  /* Recompute every hash; report the first break, if any. */
  async verify() {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const expectedPrev = i === 0 ? 'GENESIS' : this.entries[i - 1].hash;
      if (e.prev_hash !== expectedPrev) {
        return { ok: false, brokenAt: e.seq, reason: 'prev_hash does not match previous entry' };
      }
      const recomputed = await sha256Hex(canonical(e));
      if (recomputed !== e.hash) {
        return { ok: false, brokenAt: e.seq, reason: 'entry content does not match its hash' };
      }
    }
    return { ok: true, count: this.entries.length };
  }

  /* Download all entries as lt-ledger.json */
  export() {
    const blob = new Blob(
      [JSON.stringify({ exported_at: new Date().toISOString(), entries: this.entries }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lt-ledger.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* Group entries by session for the human-readable summary view. */
  sessionSummaries() {
    const by = new Map();
    for (const e of this.entries) {
      if (!e.session_id) continue;
      if (!by.has(e.session_id)) by.set(e.session_id, []);
      by.get(e.session_id).push(e);
    }
    const out = [];
    for (const [id, list] of by) {
      const first = list[0];
      const last = list[list.length - 1];
      const confirms = list.filter((e) => e.event_type === 'step_confirmed');
      out.push({
        session_id: id,
        started: first.timestamp_iso,
        ended: last.timestamp_iso,
        events: list.length,
        steps_confirmed: confirms.length,
        voice: confirms.filter((e) => e.method === 'voice').length,
        tap: confirms.filter((e) => e.method === 'tap').length,
        interruptions: list.filter((e) => e.event_type === 'interruption_start').length,
        completed: list.some((e) => e.event_type === 'session_complete'),
        blocked: list.some((e) => e.event_type === 'gate_declined')
      });
    }
    return out.reverse(); // newest first
  }
}
