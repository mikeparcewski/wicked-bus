/**
 * crew-sidecar — a reusable poll→handle→ack sidecar for the wicked-crew
 * execution engine, built on the real wicked-bus library surface
 * (loadConfig / openDb / register / poll / ack / emit).
 *
 * Two guarantees this factory provides on top of the raw bus:
 *
 *  1. IDEMPOTENT HANDLING. The bus is at-least-once: a poll can re-deliver an
 *     event that was already handled but not yet acked (e.g. after a crash).
 *     Every event carries a stable `idempotency_key`; we persist the set of
 *     handled keys and skip any re-delivery, so `handle()` runs exactly once
 *     per logical event even across restarts.
 *
 *  2. DURABLE CURSOR. On first start we `register()` a subscriber and persist
 *     its `cursor_id` + `subscription_id` to a JSON state file. On restart we
 *     RESUME from that cursor instead of re-registering, so we neither miss
 *     events nor create orphan subscriptions.
 *
 * State lives under the bus data dir (so `WICKED_BUS_DATA_DIR` isolates it too):
 *   <dataDir>/crew/<name>.state.json
 *
 * Runtime deps: only the wicked-bus library. No new dependencies.
 */

import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

import {
  loadConfig,
  openDb,
  register,
  poll,
  ack,
  emit,
  resolveDataDir,
} from '../../lib/index.js';

/**
 * @typedef {object} SidecarEvent  A raw bus row with payload already parsed.
 * @property {number} event_id
 * @property {string} event_type
 * @property {string} domain
 * @property {string} idempotency_key
 * @property {object} payload        parsed JSON payload
 * @property {string|null} correlation_id
 */

/**
 * Create a sidecar bound to a persistent subscription.
 *
 * @param {object} opts
 * @param {string} opts.name          Stable identity — names the state file & subscription plugin.
 * @param {string} opts.filter        Bus filter (e.g. 'wicked.run.*' or exact 'wicked.skill.needed').
 * @param {'oldest'|'latest'} [opts.cursorInit='oldest']
 * @param {(ctx: {event: SidecarEvent, payload: object, sidecar: object}) => void} opts.handle
 *        Called exactly once per logical event. May emit follow-on events via `ctx.sidecar.emit`.
 * @param {object} [deps]             Injectable {config, db} for tests; defaults to real bus.
 * @returns {object} sidecar
 */
export function createSidecar(opts, deps = {}) {
  const { name, filter, handle } = opts;
  const cursorInit = opts.cursorInit || 'oldest';
  if (!name || !filter || typeof handle !== 'function') {
    throw new Error('createSidecar requires { name, filter, handle }');
  }

  const config = deps.config || loadConfig();
  const db = deps.db || openDb(config);

  const dataDir = resolveDataDir();
  const stateDir = join(dataDir, 'crew');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `${name}.state.json`);

  let state = loadState(statePath) || {
    name,
    filter,
    cursor_id: null,
    subscription_id: null,
    last_acked_event_id: 0,
    handled: {},          // idempotency_key -> { event_id, at }
    records: [],          // domain-specific records the handler appends
  };

  function persist() {
    const tmp = statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(tmp, statePath); // atomic on same filesystem
  }

  /**
   * Register once, then resume forever. Returns { resumed: boolean }.
   */
  function ensureRegistered() {
    if (state.cursor_id) {
      // Resume: verify the durable cursor still resolves. A stale poll throws
      // WB-006 (cursor gone) — surface that rather than silently re-registering.
      return { resumed: true, cursor_id: state.cursor_id };
    }
    const reg = register(db, {
      plugin: name,
      role: 'subscriber',
      filter,
      cursor_init: cursorInit,
    });
    state.cursor_id = reg.cursor_id;
    state.subscription_id = reg.subscription_id;
    state.last_acked_event_id = reg.last_event_id || 0;
    persist();
    return { resumed: false, cursor_id: reg.cursor_id };
  }

  /**
   * Emit a follow-on event from inside a handler. Deterministic
   * idempotency keys make re-emits safe: a duplicate key is rejected by the
   * bus (WB-002) and reported as `duplicate:true` instead of throwing.
   */
  function sidecarEmit(event) {
    try {
      const res = emit(db, config, event);
      return { ...res, duplicate: false };
    } catch (err) {
      // WBError carries the code in `.error` and details in `.context`.
      if (err && err.error === 'WB-002') {
        return {
          event_id: err.context ? err.context.original_event_id : null,
          idempotency_key: event.idempotency_key,
          duplicate: true,
        };
      }
      throw err;
    }
  }

  const api = {
    name,
    filter,
    config,
    db,
    get state() { return state; },
    emit: sidecarEmit,
    ensureRegistered,
    persist,

    /**
     * One poll→handle→(ack) cycle.
     * @param {object} [o]
     * @param {number} [o.batchSize=50]
     * @param {boolean} [o.ack=true]  Set false to simulate a crash BEFORE ack,
     *        which leaves events eligible for re-delivery on the next poll.
     * @returns {{ polled:number, handled:number, skipped:number, ackedTo:number|null }}
     */
    tick(o = {}) {
      ensureRegistered();
      const batchSize = o.batchSize || 50;
      const doAck = o.ack !== false;

      const rows = poll(db, state.cursor_id, { batchSize });
      let handled = 0;
      let skipped = 0;
      let maxId = state.last_acked_event_id;

      for (const row of rows) {
        if (row.event_id > maxId) maxId = row.event_id;
        const key = row.idempotency_key;

        if (state.handled[key]) {
          skipped++;
          log(name, `skip re-delivered event ${row.event_id} (key=${key})`);
          continue;
        }

        const payload = parsePayload(row.payload);
        const event = { ...row, payload };

        handle({ event, payload, sidecar: api });

        state.handled[key] = { event_id: row.event_id, at: Date.now() };
        handled++;
        persist(); // persist handled-marker BEFORE ack so a crash never re-runs handle
      }

      let ackedTo = null;
      if (doAck && maxId > state.last_acked_event_id) {
        ack(db, state.cursor_id, maxId);
        state.last_acked_event_id = maxId;
        ackedTo = maxId;
        persist();
      }

      return { polled: rows.length, handled, skipped, ackedTo };
    },

    close() {
      try { db.close(); } catch (_) { /* ignore */ }
    },
  };

  return api;
}

// ── helpers ──────────────────────────────────────────────────────────────

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_) {
    return null;
  }
}

function parsePayload(payload) {
  if (payload == null) return {};
  if (typeof payload === 'object') return payload; // already parsed
  try {
    return JSON.parse(payload);
  } catch (_) {
    return { _raw: payload };
  }
}

export function log(name, msg) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), sidecar: name, msg }) + '\n'
  );
}
