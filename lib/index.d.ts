/**
 * Type declarations for lib/index.js — the wicked-bus public API barrel.
 *
 * Mirrors the runtime barrel exactly: every value re-exported by
 * lib/index.js is declared here, plus the supporting types (type-space
 * only — imports like `import type { EventRow } from 'wicked-bus'` work
 * even though the runtime barrel doesn't ship them). Keep in lockstep —
 * CI runs `npm run typecheck` against a consumer-shaped fixture importing
 * every symbol, so drift fails loudly.
 */

// --- Event emission ---
export { emit } from './emit.js';
export type { WickedEventType, EventPayload, EventInput, EmitResult } from './emit.js';

// --- Polling, acknowledgment, cursor recovery ---
export { poll, ack, matchesFilter, reanchorCursor } from './poll.js';
export type { EventRow, PollOptions, AckResult, ReanchorResult } from './poll.js';

// --- Registration ---
export { register, deregister, deregisterByPlugin } from './register.js';
export type {
  RegisterRole,
  CursorInit,
  RegisterOptions,
  ProviderRegisterResult,
  SubscriberRegisterResult,
  RegisterResult,
  DeregisterResult,
  DeregisterByPluginResult,
} from './register.js';

// --- Database, config, paths ---
export { openDb } from './db.js';
export type { SqliteDatabase, SqliteStatement } from './db.js';
export { loadConfig } from './config.js';
export type { BusConfig, LogLevel } from './config.js';
export { resolveDataDir, ensureDataDir, resolveDbPath } from './paths.js';

// --- v1 TTL sweep ---
export { startSweep, runSweep } from './sweep.js';
export type { SweepResult } from './sweep.js';

// --- Periodic WAL checkpoint (bus.db-wal must not outgrow bus.db) ---
export { startCheckpoint, runCheckpoint } from './checkpoint.js';
export type { CheckpointResult } from './checkpoint.js';

// --- Dead-letter queue (inspect / replay / drop) ---
export { listDeadLetters, replayDeadLetter, dropDeadLetter } from './dlq.js';
export type {
  DeadLetterRow,
  ListDeadLettersOptions,
  ReplayDeadLetterResult,
  DropDeadLetterResult,
} from './dlq.js';

// --- Managed subscriber (at-least-once, retry + DLQ) ---
export { subscribe } from './subscribe.js';
export type {
  SubscribedEvent,
  SubscriberLag,
  SubscribeOptions,
  SubscribeHandle,
} from './subscribe.js';

// --- Errors ---
export { WBError, ERROR_CODES, EXIT_CODES } from './errors.js';
export type { WBErrorCode, WBErrorName, WBErrorContext } from './errors.js';

// ── v2 surface (#10) ────────────────────────────────────────────────────────

// Push-or-poll subscriber (at-most-once; acks before yielding).
export { subscribePushOrPoll } from './subscribe-push-or-poll.js';
export type { PushOrPollOptions, PushOrPollSubscriber } from './subscribe-push-or-poll.js';

// Daemon client: probe + connect as a push subscriber.
export { probeDaemon, connectAsSubscriber } from './daemon-client.js';
export type {
  NotifyFrame,
  PushSubscriber,
  PushSubscriberEndState,
  ConnectAsSubscriberOptions,
} from './daemon-client.js';

// Lower-level daemon integration: notify the daemon of a fresh emit.
export { notifyEmit } from './daemon-notify.js';
export type { NotifyEmitResult } from './daemon-notify.js';

// Causality propagation (AsyncLocalStorage).
export { withContext, currentContext } from './causality.js';
export type { CausalityContext } from './causality.js';

// JSON Schema registry.
export { getSchema, applyOnEmit } from './schema-registry.js';
export type { SchemaRow, ApplyOnEmitArgs, ApplyOnEmitResult } from './schema-registry.js';

// Tiered-storage sweep with monthly archive buckets.
export { runSweepV2 } from './sweep-v2.js';
export type {
  SweepV2Config,
  SweepV2Result,
  WalCheckpointResult,
  LiveTierBloatWarning,
} from './sweep-v2.js';

// Cross-tier resolving poll (live + archived buckets).
export { pollResolve } from './query.js';
export type { EventFieldFilter, PollResolveOptions } from './query.js';

// Content-addressable store, namespaced (`cas.put(...)`, `cas.get(...)`, …).
export * as cas from './cas.js';
export type { CasStats, CasGcOptions, CasGcResult } from './cas.js';
