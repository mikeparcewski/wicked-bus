/**
 * Cross-process causality propagation — DESIGN-v2.md §8.
 *
 * In-process: callers wrap a body in `withContext({ correlation_id, ... }, fn)`;
 * any `emit()` calls inside the body inherit the context, and successive
 * emits chain via parent_event_id.
 *
 * Cross-process: spawned subprocesses inherit four env vars and the same
 * `withContext` runs at the entry point of the child to re-enter the trace.
 *   - WICKED_BUS_CORRELATION_ID
 *   - WICKED_BUS_SESSION_ID
 *   - WICKED_BUS_PARENT_EVENT_ID
 *   - WICKED_BUS_PRODUCER_ID
 *
 * The `currentContext()` accessor returns the active context, drawing from
 * the AsyncLocalStorage frame if one exists, otherwise from the env vars.
 *
 * @module lib/causality
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const ENV_KEYS = Object.freeze({
  correlation_id:   'WICKED_BUS_CORRELATION_ID',
  session_id:       'WICKED_BUS_SESSION_ID',
  parent_event_id:  'WICKED_BUS_PARENT_EVENT_ID',
  producer_id:      'WICKED_BUS_PRODUCER_ID',
});

const als = new AsyncLocalStorage();

/**
 * Run `fn` with the given context fields attached. Nested withContext()
 * calls inherit-and-override (last write wins per field).
 *
 * @param {object} ctx
 * @param {string} [ctx.correlation_id]
 * @param {string} [ctx.session_id]
 * @param {number} [ctx.parent_event_id]
 * @param {string} [ctx.producer_id]
 * @param {Function} fn  - sync or async; awaited if it returns a Promise
 * @returns {*}
 */
export function withContext(ctx, fn) {
  const inherited = currentContext();
  const merged = { ...inherited, ...sanitize(ctx) };
  return als.run(merged, fn);
}

/**
 * Read the active context. Returns an object with the four fields (any of
 * which may be `null`/`undefined`). The result is a snapshot copy — mutating
 * it does not affect the running context.
 */
export function currentContext() {
  const frame = als.getStore();
  if (frame) return { ...frame };

  // Fallback: read env vars. Useful at the entry point of a spawned child
  // before any explicit withContext() wrap.
  const fromEnv = {
    correlation_id:  process.env[ENV_KEYS.correlation_id]  || null,
    session_id:      process.env[ENV_KEYS.session_id]      || null,
    parent_event_id: parseIntOrNull(process.env[ENV_KEYS.parent_event_id]),
    producer_id:     process.env[ENV_KEYS.producer_id]     || null,
  };
  // Return undefined-y context only when truly nothing is set — keeps the
  // happy path's "no causality at all" comparison cheap.
  if (
    !fromEnv.correlation_id && !fromEnv.session_id &&
    !fromEnv.parent_event_id && !fromEnv.producer_id
  ) return {};
  return fromEnv;
}

/**
 * Set the parent_event_id for subsequent emits inside the active context.
 * Used by emit() so the next event in the same withContext() block chains
 * to the most recently emitted event_id.
 *
 * @param {number} eventId
 */
export function recordEmit(eventId) {
  const frame = als.getStore();
  if (frame) frame.parent_event_id = eventId;
}

/**
 * Build an env object suitable for passing to spawn()/exec() so the child
 * inherits the active causality context. Caller usually does:
 *
 *     spawn(cmd, args, { env: { ...process.env, ...causalityEnv() } });
 *
 * If no context is active, returns {} so the caller's spawn is unaffected.
 */
export function causalityEnv() {
  const ctx = currentContext();
  const out = {};
  if (ctx.correlation_id)  out[ENV_KEYS.correlation_id]  = String(ctx.correlation_id);
  if (ctx.session_id)      out[ENV_KEYS.session_id]      = String(ctx.session_id);
  if (ctx.parent_event_id != null) {
    out[ENV_KEYS.parent_event_id] = String(ctx.parent_event_id);
  }
  if (ctx.producer_id)     out[ENV_KEYS.producer_id]     = String(ctx.producer_id);
  return out;
}

/** Constant export for callers wanting to manipulate env vars directly. */
export const CAUSALITY_ENV_KEYS = ENV_KEYS;

// ---------------------------------------------------------------------------

function sanitize(obj) {
  const out = {};
  if (obj.correlation_id)  out.correlation_id  = String(obj.correlation_id);
  if (obj.session_id)      out.session_id      = String(obj.session_id);
  if (obj.parent_event_id != null) {
    const n = Number(obj.parent_event_id);
    if (Number.isInteger(n) && n > 0) out.parent_event_id = n;
  }
  if (obj.producer_id)     out.producer_id     = String(obj.producer_id);
  return out;
}

function parseIntOrNull(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
}
