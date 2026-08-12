/**
 * Type declarations for lib/daemon-client.js — subscriber-side daemon client
 * (socket probe + push-mode subscription).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/daemon-client.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { EventRow } from './poll.js';
import type { EventFieldFilter } from './query.js';

export const DEFAULT_PROBE_TIMEOUT_MS: number;

/**
 * Test whether a daemon is reachable at this dataDir's socket within
 * `timeoutMs` (default 100ms). Resolves true/false; never rejects.
 */
export function probeDaemon(dataDir: string, timeoutMs?: number): Promise<boolean>;

/**
 * A `notify` frame yielded by a push subscriber. `event` carries the row
 * inline when it is below the daemon's inline-payload threshold; above it,
 * `event` is null and the caller resolves the row via SELECT on `event_id`.
 */
export interface NotifyFrame {
  kind: 'notify';
  event_id: number;
  event: EventRow | null;
}

/** Terminal state recorded when a push subscription's iterator ends. */
export interface PushSubscriberEndState {
  /** 'eof', 'caller-close', 'socket-error', 'protocol-error', or a daemon degrade reason. */
  reason: string;
  error?: string;
}

/**
 * Push-mode subscription handle: an async iterable of notify frames plus
 * daemon-side ack and lifecycle controls.
 */
export interface PushSubscriber extends AsyncIterable<NotifyFrame> {
  subscriber_id: string;
  /** Set when the iterator ends; null while streaming. */
  lastState: PushSubscriberEndState | null;
  /** Advance the daemon-side cursor (fire-and-forget frame). */
  ack(eventId: number): void;
  /** Keep-alive round-trip; resolves false on timeout (500ms) or when closed. */
  ping(): Promise<boolean>;
  /** Set once the daemon sent a `degrade` frame (treat as EOF, fall back to poll). */
  readonly degraded: { reason: string } | null;
  readonly isClosed: boolean;
  close(): void;
}

export interface ConnectAsSubscriberOptions {
  dataDir: string;
  /** Daemon-side subscriber identity. */
  subscriber_id: string;
  /** Starting cursor position (default 0). */
  cursor?: number;
  /** Daemon-side exact-match filter (no wildcards). */
  filter?: EventFieldFilter | null;
  connect_timeout_ms?: number;
}

/**
 * Connect to the daemon as a push-mode subscriber.
 *
 * @throws (rejects) on connect timeout or socket error before the connection
 *         is established.
 */
export function connectAsSubscriber(opts: ConnectAsSubscriberOptions): Promise<PushSubscriber>;
