/* LT v0.1 — Session Ledger
   Append-only, hash-chained log stored in localStorage.
   Every entry: {seq, timestamp_iso, session_id, event_type, step_id, method, detail, prev_hash, hash}
   hash = SHA-256 of the entry's canonical JSON (fixed key order) including prev_hash.
   First entry's prev_hash = "GENESIS". */

/* The production ledger's storage slot. Exported so the self-test harness can
   read it back and refuse to run if its own isolation did not take effect. */
export const PRODUCTION_STORE_KEY = 'lt_ledger_v1';

/* The device's chain identifier — sidecar metadata for the server archive,
   never part of the hashed entry (Addendum 01 §4.2(b)). Generated once and
   persisted; rotated when clear() starts a fresh chain, because seq restarts
   at 1 there and the server's UNIQUE (chain_id, seq) would otherwise collide
   with the retired chain's positions. */
const CHAIN_ID_KEY = 'lt_chain_id_v1';

/* Events that end a session's lifecycle. session_abandoned and
   session_restart_forced are no longer written (v0.2+) but remain terminal so
   sessions in pre-existing ledgers do not read as still open. session_aborted
   (v0.6+) is the safety-halt terminal: the session can never resume. */
const TERMINAL_EVENTS = new Set([
  'session_complete',
  'session_closed',
  'session_aborted',
  'session_abandoned',
  'session_restart_forced'
]);

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
  /* storeKey — which local storage slot this ledger occupies. Defaults to the
     production slot, so existing behaviour with no argument is unchanged.

     A ledger opened under any OTHER key is ISOLATED, and isolation means two
     things governed by the one condition, so they cannot drift apart:
       1. it reads and writes its own slot and can neither see nor overwrite
          production entries;
       2. it never enqueues to the sync queue, so nothing it records can reach
          the server. (Part B adds that enqueue — the guard point is marked in
          append() and clear(). Until Part B lands there is nothing to suppress,
          but the flag is the single condition it must be written behind.)

     This exists so the self-test harness can exercise the real chain logic on
     the same origin as the live app without touching the real audit record. */
  constructor(storeKey = PRODUCTION_STORE_KEY) {
    this.storeKey = storeKey;
    this.isolated = storeKey !== PRODUCTION_STORE_KEY;
    this.entries = this._load();
    this._queue = Promise.resolve(); // serialize appends so the chain stays ordered
  }

  _load() {
    try {
      const raw = localStorage.getItem(this.storeKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _save() {
    localStorage.setItem(this.storeKey, JSON.stringify(this.entries));
  }

  _chainId(rotate) {
    let id = rotate ? null : localStorage.getItem(CHAIN_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CHAIN_ID_KEY, id);
    }
    return id;
  }

  /* PART B — queue the entry for the server archive. Called after the local
     write, guarded by isolation, and never awaited: the caller — a live
     session — must never wait on the network. sync.js is loaded dynamically
     so an isolated ledger (the self-test harness) never touches the queue or
     the module graph at all. Nothing in here may throw: a failed enqueue
     leaves the entry local-only, exactly like any unsynced capture. */
  _enqueue(entry, newChain = false) {
    try {
      if (this.isolated) return;
      const chain_id = this._chainId(newChain);
      import('./sync.js')
        .then((sync) => sync.enqueue('ledger_event', { entry, chain_id }))
        .catch(() => { /* stays local; never surfaces mid-session */ });
    } catch { /* archive enqueue must never break the local append */ }
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
      this._enqueue(entry); // after the local write; the local write stays unconditional
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

  /* Wipe the stored history and start a fresh chain. The new chain's first
     entry records what was deleted, and the last hash of the old chain, so a
     previously exported file can be matched to the ledger that replaced it. */
  clear() {
    this._queue = this._queue.then(async () => {
      const deleted = this.entries.length;
      const lastHash = deleted > 0 ? this.entries[deleted - 1].hash : null;
      this.entries = [];
      const entry = {
        seq: 1,
        timestamp_iso: new Date().toISOString(),
        session_id: null,
        event_type: 'ledger_cleared',
        step_id: null,
        method: 'tap',
        detail: { deleted_entries: deleted, previous_chain_last_hash: lastHash },
        prev_hash: 'GENESIS'
      };
      entry.hash = await sha256Hex(canonical(entry));
      this.entries.push(entry);
      this._save();
      /* Same guard as append(). A record that a wipe occurred is exactly what
         the durable archive exists to hold. newChain: this entry restarts the
         chain at seq 1, so it must open a new chain_id on the server. */
      this._enqueue(entry, true);
      return entry;
    });
    return this._queue;
  }

  /* Lifecycle status of the most recent session in the ledger. Only the
     newest session can still be open: new sessions cannot start while one is
     unresolved, and sessions from ledgers written before the closure rule are
     grandfathered. Returns null if no session has ever entered the ledger. */
  latestSessionStatus() {
    let id = null;
    for (const e of this.entries) if (e.session_id) id = e.session_id;
    if (!id) return null;
    const list = this.entries.filter((e) => e.session_id === id);
    const has = (t) => list.some((e) => e.event_type === t);
    const terminal = list.some((e) => TERMINAL_EVENTS.has(e.event_type));
    return {
      session_id: id,
      open: !terminal,
      declined: has('gate_declined'),
      lastEvent: list[list.length - 1]
    };
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
      const closedEv = list.filter((e) => e.event_type === 'session_closed').pop();
      const abortEv = list.filter((e) => e.event_type === 'session_aborted').pop();
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
        blocked: list.some((e) => e.event_type === 'gate_declined'),
        closed_reason: closedEv && closedEv.detail ? closedEv.detail.reason : null,
        aborted_reason: abortEv && abortEv.detail
          ? (abortEv.detail.reason_label || abortEv.detail.reason_code) : null
      });
    }
    return out.reverse(); // newest first
  }
}
