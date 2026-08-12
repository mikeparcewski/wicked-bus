/**
 * Type declarations for lib/query.js — cross-tier (live + warm) poll resolver.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/query.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';
import type { EventRow } from './poll.js';

/**
 * Exact-match field filter used by the cross-tier resolver and the daemon's
 * push fan-out (unlike subscription filter STRINGS, no wildcards here).
 */
export interface EventFieldFilter {
  event_type?: string;
  domain?: string;
  subdomain?: string;
}

export interface PollResolveOptions {
  /** Cursor position; events with `event_id > lastEventId` are returned. */
  lastEventId: number;
  filter?: EventFieldFilter | null;
  /** Max rows returned (default 100). */
  batchSize?: number;
}

/**
 * Resolve a poll across the live tier and warm archive buckets: reads live
 * first, spills into covering buckets when the cursor predates live, dedupes
 * by event_id (live copy wins), and returns rows in ascending event_id order.
 *
 * @throws {import('./errors.js').WBError} WB-001 (invalid lastEventId),
 *         WB-003 (gap not covered by any tier), WB-013 (a covering warm
 *         bucket exists but cannot be opened).
 */
export function pollResolve(
  liveDb: SqliteDatabase,
  archDir: string,
  opts: PollResolveOptions,
): EventRow[];

/**
 * Dedupe two row arrays by event_id, preferring the live copy on collision.
 * Exposed for test introspection.
 */
export function dedupePreferLive(warmRows: EventRow[], liveRows: EventRow[]): EventRow[];
