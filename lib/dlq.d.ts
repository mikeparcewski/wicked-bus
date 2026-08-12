/**
 * Type declarations for lib/dlq.js — dead-letter queue inspection and
 * operator controls (list / replay / drop).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/dlq.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

/**
 * A dead-lettered event as returned by listDeadLetters().
 *
 * Rows are denormalized snapshots of the originating event taken at DLQ
 * time — the original `events` row may have been swept since. Unlike raw
 * poll() rows, `payload` here IS parsed from JSON.
 */
export interface DeadLetterRow {
  dl_id: number;
  cursor_id: string;
  subscription_id: string;
  /** event_id of the originating event (its `events` row may be gone). */
  event_id: number;
  event_type: string;
  domain: string;
  subdomain: string;
  /** Parsed JSON payload (as snapshotted at dead-letter time). */
  payload: unknown;
  emitted_at: number;
  /** Handler attempts consumed before dead-lettering (and by failed replays). */
  attempts: number;
  last_error: string | null;
  dead_lettered_at: number;
  /** Set while a replay is pending; cleared on replay failure, row deleted on success. */
  replay_requested_at: number | null;
  /** Subscriber plugin name (LEFT JOIN — null if the subscription row is gone). */
  plugin: string | null;
}

export interface ListDeadLettersOptions {
  /** Filter to a single subscriber plugin. */
  plugin?: string;
  /** Filter to a single cursor. */
  cursorId?: string;
  /** Max rows returned (default 100). */
  limit?: number;
}

/**
 * List dead-lettered events, most recent first.
 *
 * @throws {import('./errors.js').WBError} WB-001 when a stored payload is
 *         malformed JSON.
 */
export function listDeadLetters(
  db: SqliteDatabase,
  opts?: ListDeadLettersOptions,
): DeadLetterRow[];

export interface ReplayDeadLetterResult {
  replayed: true;
  dl_id: number;
  replay_requested_at: number;
}

/**
 * Mark a dead-lettered event for replay. The next tick of the managed
 * subscribe() loop for its cursor drains pending replays before normal
 * polling — a single attempt, no automatic retry.
 *
 * @throws {import('./errors.js').WBError} WB-006 when the dead-letter row
 *         does not exist.
 */
export function replayDeadLetter(db: SqliteDatabase, dlId: number): ReplayDeadLetterResult;

export interface DropDeadLetterResult {
  dropped: true;
  dl_id: number;
}

/**
 * Permanently drop a dead-lettered event.
 *
 * @throws {import('./errors.js').WBError} WB-006 when the dead-letter row
 *         does not exist.
 */
export function dropDeadLetter(db: SqliteDatabase, dlId: number): DropDeadLetterResult;
