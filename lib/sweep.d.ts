/**
 * Type declarations for lib/sweep.js — v1 TTL sweep + the retention policy
 * shared with the tiered sweep (FND-BUS-01, #101).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/sweep.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

/** What the sweep does with an expired event an active cursor still owes. */
export type UnackedPolicy = 'retain' | 'archive' | 'discard';

/** The accepted `unacked_policy` values, in documentation order. */
export const UNACKED_POLICIES: readonly UnackedPolicy[];

/** Validate `config.unacked_policy` (default 'retain'); throws on an unknown value. */
export function resolveUnackedPolicy(config: { unacked_policy?: string } | null | undefined): UnackedPolicy;

/** Per-cursor line of the reconciliation report. */
export interface UnackedCursorReport {
  cursor_id: string;
  /** Expired events this cursor owed at sweep time. */
  count: number;
  oldest_event_id: number;
  newest_event_id: number;
  disposition: 'retained' | 'archived' | 'discarded';
  /**
   * Why: 'unacked_policy' (the configured policy decided), 'retention_cap'
   * (archived: emitted more than `unacked_retention_days` ago), or
   * 'retention_cap_pending' (over the cap, not moved this tiered pass because
   * its bucket was locked or the batch was full; retried on the next sweep).
   */
  reason: 'unacked_policy' | 'retention_cap' | 'retention_cap_pending';
}

/**
 * Reconciliation report: expired events an active cursor had not acked (or
 * that had pending delivery_attempts), what the sweep did with them and why.
 * The policy's own count key is always present (`retained`, `archived` or
 * `discarded`); under 'retain', `archived` also appears when the retention
 * cap archived rows. One cursor line per (cursor, disposition, reason).
 */
export interface UnackedReport {
  retained?: number;
  archived?: number;
  discarded?: number;
  /** The `unacked_retention_days` cap in force for this pass. */
  retention_cap_days: number;
  cursors: UnackedCursorReport[];
}

/** Result of a single sweep pass. */
export interface SweepResult {
  events_deleted: number;
  unacked_policy: UnackedPolicy;
  unacked: UnackedReport;
}

/** Sweep config subset read by runSweep(). */
export interface SweepConfig {
  /** Copy every swept row to `events_archive` first. */
  archive_mode?: boolean;
  /** Default 'retain': an owed expired event is never swept. */
  unacked_policy?: UnackedPolicy;
  /** Retain cap in days (default 30): older owed rows are archived, never discarded. */
  unacked_retention_days?: number;
  /** Run the tiered sweep (lib/sweep-v2.js) from runConfiguredSweep/startSweep. */
  tiered_archive?: boolean;
  /** Test override for "now" (epoch ms). */
  now?: number;
}

/**
 * Fill the connection's `temp._wb_owed(event_id, cursor_id)` table with every
 * expired event an active consumer still owes and return the per-cursor
 * summary (without `disposition`). Read-only on bus.db itself.
 */
export function collectOwedExpired(
  db: SqliteDatabase,
  now: number,
): Array<Omit<UnackedCursorReport, 'disposition' | 'reason'>>;

/** Default `unacked_retention_days` (30). */
export const DEFAULT_UNACKED_RETENTION_DAYS: number;

/** Validate `config.unacked_retention_days` (default 30); throws unless a positive number. */
export function resolveRetentionCapDays(config: { unacked_retention_days?: unknown } | null | undefined): number;

/** The pairs in `temp._wb_owed`, each flagged `over_cap` (emitted more than `capDays` before `now`). */
export function owedPairsWithCap(
  db: SqliteDatabase,
  now: number,
  capDays: number,
): Array<{ event_id: number; cursor_id: string; over_cap: boolean }>;

/** Build the reconciliation report from owed pairs and a per-pair fate. */
export function buildUnackedReport(
  pairs: Array<{ event_id: number; cursor_id: string; over_cap: boolean }>,
  fateOf: (pair: { event_id: number; cursor_id: string; over_cap: boolean }) => {
    disposition: UnackedCursorReport['disposition'];
    reason: UnackedCursorReport['reason'];
  },
  opts: { policy: UnackedPolicy; capDays: number },
): UnackedReport;

/**
 * Run a single sweep pass. An event is removed only after its lifetime
 * (`expires_at`, `ttl_hours`); the dedup window (`dedup_expires_at`) no longer
 * deletes rows. Expired events an active cursor still owes follow
 * `unacked_policy` and are reported in `unacked`. `archive_mode` copies every
 * swept row to `events_archive` first.
 */
export function runSweep(db: SqliteDatabase, config: SweepConfig): SweepResult;

/**
 * One pass of the configured tier: runSweepV2 when `config.tiered_archive`,
 * else runSweep. This is what `wicked-bus cleanup` and the background sweep run.
 */
export function runConfiguredSweep(
  db: SqliteDatabase,
  config: SweepConfig & Record<string, unknown>,
): SweepResult | import('./sweep-v2.js').SweepV2Result;

/**
 * Start a background sweep interval (`config.sweep_interval_minutes`) running
 * runConfiguredSweep(). Returns the interval handle, or null when the interval
 * is absent, non-finite, or not positive. Runtime checks also protect direct
 * JavaScript callers from unsafe raw values.
 * Sweep errors inside the interval are swallowed (non-fatal).
 */
export function startSweep(
  db: SqliteDatabase,
  config: SweepConfig & { sweep_interval_minutes?: number },
): ReturnType<typeof setInterval> | null;
