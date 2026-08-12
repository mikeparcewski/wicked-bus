/**
 * Type declarations for lib/daemon-notify.js — producer-side daemon notifier.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/daemon-notify.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { EventRow } from './poll.js';

export const DEFAULT_CONNECT_TIMEOUT_MS: number;
export const DEFAULT_WRITE_TIMEOUT_MS: number;

export interface NotifyEmitResult {
  delivered: boolean;
  /** Failure reason when not delivered: 'connect-timeout', 'write-timeout', 'invalid-event', or a socket error code (e.g. 'ENOENT', 'ECONNREFUSED'). */
  reason?: string;
}

/**
 * Send a `produced` notification for a freshly emitted row to the daemon
 * socket (best-effort, fire-and-forget). Never rejects; a missed notify just
 * means subscribers see the event via poll fallback. emit() calls this
 * automatically unless `config.daemon_notify === false`.
 */
export function notifyEmit(
  dataDir: string,
  eventRow: EventRow,
  opts?: { connect_timeout_ms?: number; write_timeout_ms?: number },
): Promise<NotifyEmitResult>;
