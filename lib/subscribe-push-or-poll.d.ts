/**
 * Type declarations for lib/subscribe-push-or-poll.js — push-with-poll-fallback
 * subscriber (DESIGN-v2.md §7.4 degradation contract).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/subscribe-push-or-poll.js — CI runs `npm run typecheck` so drift
 * fails loudly.
 */

import type { SqliteDatabase } from './db.js';
import type { EventRow } from './poll.js';
import type { EventFieldFilter } from './query.js';

export const DEFAULT_POLL_INTERVAL_MS: number;
export const DEFAULT_REPROBE_INTERVAL_MS: number;
export const DEFAULT_PROBE_TIMEOUT_MS: number;

export interface PushOrPollOptions {
  /** Live DB connection (poll fallback + pointer-notify resolution). */
  db: SqliteDatabase;
  /** Existing v1 cursor id — the durable anchor across push/poll handoffs. */
  cursor_id: string;
  dataDir: string;
  /** Daemon-side subscriber id (defaults to cursor_id). */
  subscriber_id?: string;
  /** Daemon-side exact-match filter (no wildcards). */
  filter?: EventFieldFilter | null;
  poll_interval_ms?: number;
  reprobe_interval_ms?: number;
  probe_timeout_ms?: number;
  /** Re-probe the daemon while in poll mode (default true). */
  auto_recover?: boolean;
}

/**
 * Async-iterable subscriber that prefers daemon push and transparently falls
 * back to polling. AT-MOST-ONCE: each event is ack'd (cursor durably
 * advanced) BEFORE it is yielded — a throw inside the `for await` body
 * silently loses the in-flight event (the opposite guarantee from the
 * managed subscribe(), which retries + dead-letters).
 */
export interface PushOrPollSubscriber extends AsyncIterable<EventRow> {
  /** Current delivery mode. */
  readonly mode: 'push' | 'poll';
  readonly isClosed: boolean;
  /** Number of push<->poll mode transitions so far. */
  readonly transitionCount: number;
  /** Manual close; subsequent iterator steps return done. */
  close(): void;
}

/**
 * Probe the daemon and return a push-or-poll subscriber bound to an existing
 * v1 cursor.
 *
 * @throws (rejects) when `db`, `cursor_id`, or `dataDir` is missing.
 */
export function subscribePushOrPoll(opts: PushOrPollOptions): Promise<PushOrPollSubscriber>;
