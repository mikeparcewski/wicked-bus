/**
 * Type declarations for lib/poll.js — cursor-based polling and acknowledgment.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/poll.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

/**
 * A stored event row as returned by poll() / pollResolve() — the full
 * `events` table row (v2 schema: v1 columns plus causality + registry/CAS
 * columns, which are null for pre-v2 rows and producers that don't set them).
 *
 * `payload` is the JSON text exactly as stored — poll() does NOT parse it;
 * callers JSON.parse() it themselves. (The managed subscribe() helper parses
 * before invoking the handler — see SubscribedEvent.)
 */
export interface EventRow {
  event_id: number;
  /** Stored event type. Canonically four-segment (see WickedEventType). */
  event_type: string;
  domain: string;
  subdomain: string;
  /** JSON text as stored. For registry cas-auto offloads this is `{"$cas":"<sha>"}`. */
  payload: string;
  schema_version: string;
  idempotency_key: string;
  /** Epoch milliseconds. */
  emitted_at: number;
  /** Epoch ms — row hidden from poll() past this. */
  expires_at: number;
  /** Epoch ms — row deleted by sweep past this. */
  dedup_expires_at: number;
  /** JSON text or null. */
  metadata: string | null;
  parent_event_id: number | null;
  session_id: string | null;
  correlation_id: string | null;
  producer_id: string | null;
  origin_node_id: string | null;
  registry_schema_version: number | null;
  /** SHA-256 of a CAS-offloaded payload, when the registry offloaded it. */
  payload_cas_sha: string | null;
}

export interface PollOptions {
  /** Max rows returned (default 100). */
  batchSize?: number;
  /**
   * Read-only floor override: return events with `event_id > afterEventId`
   * instead of the cursor's persisted position. The cursor is NOT mutated.
   */
  afterEventId?: number;
}

/** Result of ack(). */
export interface AckResult {
  acked: true;
  cursor_id: string;
  last_event_id: number;
}

/** Result of reanchorCursor(). */
export interface ReanchorResult {
  reanchored: true;
  cursor_id: string;
  last_event_id: number;
}

/**
 * Poll for events after the cursor's position, in ascending event_id order.
 * Does not advance the cursor — call ack() after processing.
 *
 * @throws {import('./errors.js').WBError} WB-006 (cursor/subscription not
 *         found or deregistered), WB-003 (cursor behind the TTL sweep window).
 */
export function poll(db: SqliteDatabase, cursorId: string, options?: PollOptions): EventRow[];

/**
 * Durably advance a cursor to `lastEventId` (marks everything at or below it
 * as consumed).
 *
 * @throws {import('./errors.js').WBError} WB-006 when the cursor is missing
 *         or deregistered.
 */
export function ack(db: SqliteDatabase, cursorId: string, lastEventId: number): AckResult;

/**
 * Re-anchor a cursor that fell behind the TTL sweep window (WB-003 recovery).
 * Set `newLastEventId` to `oldest_available_event_id - 1` so the next poll
 * resumes from the oldest surviving event.
 *
 * @throws {import('./errors.js').WBError} WB-001 (invalid position),
 *         WB-006 (cursor missing or deregistered).
 */
export function reanchorCursor(
  db: SqliteDatabase,
  cursorId: string,
  newLastEventId: number,
): ReanchorResult;

/**
 * Match an event type + domain against a subscription filter string
 * (`pattern[@domain]`). Wildcards are trailing-only: `prefix.*` matches
 * exactly one extra segment, `prefix.**` one or more, `*` matches every type.
 */
export function matchesFilter(eventType: string, domain: string, filterStr: string): boolean;
