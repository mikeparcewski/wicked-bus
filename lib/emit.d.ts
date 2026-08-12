/**
 * Type declarations for lib/emit.js — event emission with idempotency and TTL.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/emit.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';
import type { BusConfig } from './config.js';

/**
 * Canonical event-type grammar (reqs/SPEC.md): four dot-separated segments,
 * `wicked.<domain>.<noun>.<past-tense-verb>` — e.g.
 * `wicked.test.run.completed`. The second segment is the producer's short
 * name (`test`, `crew`, `brain`, …).
 *
 * Note: runtime validation enforces the looser pattern
 * `/^wicked\.[a-z0-9_]+(\.[a-z0-9_]+)*$/` (any 2+ segments, max 128 chars);
 * this type encodes the canonical v1-catalog grammar every published event
 * type follows. Producers deliberately emitting a non-catalog type can cast.
 */
export type WickedEventType = `wicked.${string}.${string}.${string}`;

/**
 * Event payload: a JSON-serializable object. Runtime validation (WB-001)
 * rejects arrays, primitives, and strings that do not parse to a JSON object.
 */
export type EventPayload = Record<string, unknown>;

/** Input envelope accepted by emit(). */
export interface EventInput {
  /** Four-segment event type, `wicked.<domain>.<noun>.<verb>`. Max 128 chars. */
  event_type: WickedEventType;
  /** Publisher identity — the full package name (e.g. `wicked-testing`). Max 64 chars. */
  domain: string;
  /** Functional area within the publisher (dot-separated). Defaults to ''. Max 64 chars. */
  subdomain?: string | null;
  /** JSON object, or a string containing a serialized JSON object. */
  payload: EventPayload | string;
  /** Semver `1.x.y` (default '1.0.0'). Majors above 1 are rejected with WB-005. */
  schema_version?: string | null;
  /** Dedup key (UNIQUE). Defaults to a fresh UUID. Duplicates throw WB-002. */
  idempotency_key?: string | null;
  /** Per-event visibility TTL override in hours (defaults to config.ttl_hours). */
  ttl_hours?: number | null;
  /** Free-form metadata; objects are JSON-stringified for storage. */
  metadata?: Record<string, unknown> | string | null;
  /**
   * Causality overrides. When omitted, values are inherited from the active
   * withContext() frame or the WICKED_BUS_* env vars; pass an explicit null
   * to opt out of inherited propagation for that field.
   */
  correlation_id?: string | null;
  session_id?: string | null;
  parent_event_id?: number | null;
  producer_id?: string | null;
}

/** Result of a successful emit(). */
export interface EmitResult {
  event_id: number;
  idempotency_key: string;
}

/**
 * Emit an event to the bus. Synchronous insert (better-sqlite3); the
 * daemon push notification is fire-and-forget on the next macrotask
 * (disable via `config.daemon_notify === false`).
 *
 * @throws {import('./errors.js').WBError} WB-001 (invalid envelope),
 *         WB-002 (duplicate idempotency_key), WB-004 (disk full),
 *         WB-005 (unsupported schema_version), WB-008 (registry strict
 *         payload cap exceeded).
 */
export function emit(db: SqliteDatabase, config: BusConfig, event: EventInput): EmitResult;
