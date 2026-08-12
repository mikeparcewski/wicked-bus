/**
 * Type declarations for lib/sweep-v2.js — tiered sweep into monthly warm
 * archive buckets.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/sweep-v2.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

export const DEFAULT_BATCH_SIZE: number;
export const DEFAULT_BUCKET_MAX_BYTES: number;
export const DEFAULT_LIVE_BLOAT_BYTES: number;
export const DEFAULT_LIVE_BLOAT_ROWS: number;

export interface SweepV2Config {
  /** Parent dir for archive/. Defaults to WICKED_BUS_DATA_DIR. */
  data_dir?: string;
  /** Rows per batch (default 5000). */
  sweep_batch_size?: number;
  /** Bucket auto-split threshold in bytes (default 10 GB). */
  bucket_max_bytes?: number;
  /** WB-012 live-tier size trigger in bytes (default 1 GB). */
  live_bloat_bytes?: number;
  /** WB-012 live-tier row-count trigger (default 1M). */
  live_bloat_rows?: number;
  /** Test override for "now" (epoch ms). */
  now?: number;
}

/** WAL checkpoint outcome (PASSIVE → 3×busy → RESTART escalation). */
export interface WalCheckpointResult {
  mode: 'PASSIVE' | 'RESTART';
  busy_runs: number;
  /** Raw better-sqlite3 pragma result rows. */
  result: unknown;
}

/** WB-012 live-tier bloat warning (returned, not thrown). */
export interface LiveTierBloatWarning {
  error: 'WB-012';
  code: 'LIVE_TIER_BLOAT_WARNING';
  context: { message: string; [key: string]: unknown };
}

export interface SweepV2Result {
  events_moved: number;
  buckets_touched: string[];
  buckets_skipped_locked: string[];
  /** Null when the batch had no candidates (no checkpoint was attempted). */
  wal_checkpoint: WalCheckpointResult | null;
  bloat_warning: LiveTierBloatWarning | null;
}

/**
 * Run a single batch of v2 tiered sweep: move TTL'd events from live
 * (`bus.db`) into monthly warm buckets (`archive/bus-YYYY-MM[suffix].db`).
 * Warm-COMMIT happens before live-DELETE; the crash-window duplicate is
 * collapsed by pollResolve() with live-wins precedence.
 */
export function runSweepV2(db: SqliteDatabase, config?: SweepV2Config): SweepV2Result;

/**
 * Test/operator helper: acquire the advisory lock for a bucket
 * (`archive/.locks/<bucket>.lock`). Returns the lock file path.
 */
export function lockBucketForTesting(archDir: string, bucketName: string): string;

/** Test/operator helper: release an advisory bucket lock (no-op if absent). */
export function unlockBucketForTesting(archDir: string, bucketName: string): void;
