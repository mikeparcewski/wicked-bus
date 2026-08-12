/**
 * Type declarations for lib/subscribe.js — managed long-running subscriber.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/subscribe.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';
import type { CursorInit } from './register.js';

/**
 * Event as delivered to a subscribe() handler: the stored row with `payload`
 * JSON-parsed (left as the raw string when unparseable).
 *
 * Normal deliveries carry a live `events` row (all optional fields present);
 * replayed dead letters carry the denormalized DLQ snapshot instead, which
 * has only the envelope core (the optional fields below are absent).
 * At-least-once delivery: handlers MUST be idempotent.
 */
export interface SubscribedEvent {
  event_id: number;
  event_type: string;
  domain: string;
  subdomain: string;
  /** Parsed JSON payload (or the raw string when it wasn't valid JSON). */
  payload: unknown;
  emitted_at: number;
  /** Present on live deliveries; absent on dead-letter replay deliveries. */
  expires_at?: number;
  dedup_expires_at?: number;
  schema_version?: string;
  idempotency_key?: string;
  metadata?: string | null;
  correlation_id?: string | null;
  session_id?: string | null;
  parent_event_id?: number | null;
  producer_id?: string | null;
  origin_node_id?: string | null;
  registry_schema_version?: number | null;
  payload_cas_sha?: string | null;
}

/** Lag snapshot returned by getLag() / passed to onLag. */
export interface SubscriberLag {
  /** Events between the cursor and the head of the stream (unfiltered). */
  cursor_lag: number;
  /** Age in ms of the oldest event still ahead of the cursor, or null. */
  oldest_unacked_age_ms: number | null;
  /** Dead-letter rows accumulated for this cursor. */
  dlq_count: number;
}

export interface SubscribeOptions {
  /** Open DB handle (required). */
  db: SqliteDatabase;
  /** Subscriber plugin identity. */
  plugin: string;
  /** Event type filter (e.g. `wicked.fact.extracted.*`). */
  filter: string;
  /** Event handler; throw to retry. MUST be idempotent (at-least-once). */
  handler: (event: SubscribedEvent) => void | Promise<void>;
  /** Only used on first registration (default 'latest'). */
  cursor_init?: CursorInit;
  /** Poll cadence in ms (default 15000). */
  pollIntervalMs?: number;
  /** Events per poll (default 50). */
  batchSize?: number;
  /** Retries before dead-lettering; 0 = fail-fast (default 0). */
  maxRetries?: number;
  /** Backoff between retries: constant number, or array with last-element repeat (default 1000). */
  backoffMs?: number | number[];
  /** onLag callback cadence in ms, independent of polling (default 60000). */
  lagIntervalMs?: number;
  /** Handler/poll errors. `event` is null for polling errors (WB-003/WB-006). */
  onError?: (err: Error, event: SubscribedEvent | null) => void;
  onDeadLetter?: (event: SubscribedEvent, reason: string) => void;
  onLag?: (lag: SubscriberLag) => void;
}

/** Handle returned by subscribe(). */
export interface SubscribeHandle {
  /** Stop the loop; resolves once any in-flight handler/backoff settles. */
  stop(): Promise<void>;
  getLag(): SubscriberLag;
  cursor_id: string;
  subscription_id: string;
}

/**
 * Subscribe with a managed poll loop, retry/backoff, dead-lettering, replay
 * drain, and lifecycle. AT-LEAST-ONCE: the handler runs BEFORE the cursor is
 * acked, so the same logical event may be delivered more than once (the
 * opposite guarantee from subscribePushOrPoll, which acks before yielding).
 * Resumes an existing (plugin, filter) subscription when one is active.
 *
 * @throws {TypeError} when required options are missing.
 */
export function subscribe(opts: SubscribeOptions): SubscribeHandle;

/** Result of registerOrResume(). */
export interface RegisterOrResumeResult {
  subscription_id: string;
  cursor_id: string;
  /** True when a fresh subscription was registered, false when resumed. */
  created: boolean;
}

/**
 * Resume an existing active subscription by (plugin, filter), or register a
 * new one. Advanced/testing export — subscribe() calls this internally.
 */
export function registerOrResume(
  db: SqliteDatabase,
  opts: { plugin: string; filter: string; cursor_init?: CursorInit },
): RegisterOrResumeResult;
