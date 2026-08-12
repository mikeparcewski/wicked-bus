/**
 * Type declarations for lib/sweep.js — v1 TTL sweep.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/sweep.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

/** Result of a single sweep pass. */
export interface SweepResult {
  events_deleted: number;
}

/**
 * Run a single sweep pass: delete events past `dedup_expires_at`, copying
 * them to `events_archive` first when `config.archive_mode` is true.
 */
export function runSweep(
  db: SqliteDatabase,
  config: { archive_mode?: boolean },
): SweepResult;

/**
 * Start a background sweep interval (`config.sweep_interval_minutes`).
 * Returns the interval handle, or null when the interval is 0/unset.
 * Sweep errors inside the interval are swallowed (non-fatal).
 */
export function startSweep(
  db: SqliteDatabase,
  config: { sweep_interval_minutes?: number; archive_mode?: boolean },
): ReturnType<typeof setInterval> | null;
