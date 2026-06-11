/**
 * wicked-bus public API.
 * @module wicked-bus
 */

export { emit } from './emit.js';
export { poll, ack, matchesFilter } from './poll.js';
export { register, deregister } from './register.js';
export { openDb } from './db.js';
export { loadConfig } from './config.js';
export { resolveDataDir, ensureDataDir, resolveDbPath } from './paths.js';
export { startSweep, runSweep } from './sweep.js';
export { listDeadLetters, replayDeadLetter, dropDeadLetter } from './dlq.js';
export { subscribe } from './subscribe.js';
export { WBError, ERROR_CODES, EXIT_CODES } from './errors.js';

// ── v2 surface (#10) ────────────────────────────────────────────────────────
// Opt-in features that previously could only be exercised through the CLI
// binary. Each re-export is additive — the 1.x surface above is unchanged — and
// safe to import even when the underlying feature is disabled: importing does
// not start a daemon, open a socket, or enforce a schema. Names match the real
// module exports (the original proposal referenced a few that never shipped:
// `applyRegistryPolicy` is `applyOnEmit`; CAS is exposed as a namespace rather
// than flat `casRead`/`casWrite`/`gcCas` to avoid generic names at the root).

// Push-or-poll subscriber: prefers the daemon's push delivery, falls back to
// polling when no daemon is reachable.
export { subscribePushOrPoll } from './subscribe-push-or-poll.js';

// Daemon client: probe for a running daemon and connect as a push subscriber.
export { probeDaemon, connectAsSubscriber } from './daemon-client.js';

// Lower-level daemon integration: notify the daemon of a freshly emitted row.
export { notifyEmit } from './daemon-notify.js';

// Causality propagation (AsyncLocalStorage): run work within a correlation
// context and read the active context.
export { withContext, currentContext } from './causality.js';

// JSON Schema registry: look up a registered schema and apply registry policy
// (validate / coerce) to a payload at emit time.
export { getSchema, applyOnEmit } from './schema-registry.js';

// Tiered-storage sweep with monthly archive buckets.
export { runSweepV2 } from './sweep-v2.js';

// Cross-tier resolving poll (live + archived buckets).
export { pollResolve } from './query.js';

// Content-addressable store for large payloads. Namespaced because the module
// uses intentionally generic verbs (`put`, `get`, `gc`); reach them as
// `cas.put(...)`, `cas.get(...)`, `cas.gc(...)`, etc.
export * as cas from './cas.js';
