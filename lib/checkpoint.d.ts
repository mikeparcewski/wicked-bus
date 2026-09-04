/**
 * Type declarations for lib/checkpoint.js — periodic WAL checkpoint.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/checkpoint.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

/** Result of a single checkpoint pass (the TRUNCATE pragma row, decoded). */
export interface CheckpointResult {
  /**
   * True when a concurrent reader deferred the truncate — not an error; the
   * next tick tries again.
   */
  busy: boolean;
  /** Total frames in the WAL log (-1 when the db is not in WAL mode). */
  log: number;
  /** Frames moved into the main db file (-1 when the db is not in WAL mode). */
  checkpointed: number;
}

/**
 * Run a single busy-tolerant PASSIVE→TRUNCATE WAL checkpoint on `db`'s own
 * connection. Never blocks the event loop: busy_timeout is zeroed for the
 * attempt (and restored), so a live reader yields `busy: true` immediately.
 */
export function runCheckpoint(db: SqliteDatabase): CheckpointResult;

/**
 * Start a background checkpoint interval
 * (`config.checkpoint_interval_minutes`, default 5; 0 disables). Returns the
 * unref'd interval handle, or null when disabled. Errors inside the interval
 * are swallowed (non-fatal). Callers clearInterval the handle on shutdown.
 */
export function startCheckpoint(
  db: SqliteDatabase,
  config: { checkpoint_interval_minutes?: number },
): ReturnType<typeof setInterval> | null;
