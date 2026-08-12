/**
 * Type declarations for lib/cas.js — content-addressable store for large
 * event payloads (`<dataDir>/cas/<sha[0:2]>/<sha>`).
 *
 * Re-exported from the package root as the `cas` namespace
 * (`import { cas } from 'wicked-bus'`).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/cas.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

export const DEFAULT_OBJECT_MAX_BYTES: number;
export const DEFAULT_GC_GRACE_DAYS: number;

/** Standard CAS root for a given dataDir (`<dataDir>/cas`). */
export function casDir(dataDir: string): string;

/**
 * Store content in the CAS. Returns the SHA-256 hex digest; duplicate
 * content (same SHA) is a no-op.
 *
 * @throws {import('./errors.js').WBError} WB-001 (content not Buffer/string),
 *         WB-008 (object exceeds the size cap).
 */
export function put(
  dataDir: string,
  content: Buffer | string,
  opts?: { max_bytes?: number },
): string;

/** Read content for a SHA. Returns null when not found. */
export function get(dataDir: string, sha: string): Buffer | null;

export function exists(dataDir: string, sha: string): boolean;

export interface CasStats {
  root: string;
  object_count: number;
  total_bytes: number;
}

/** Aggregate stats: total objects, total bytes, root path. */
export function stats(dataDir: string): CasStats;

export interface CasGcOptions {
  dataDir: string;
  /** Open connection to the live bus.db (reference source). */
  liveDb: SqliteDatabase;
  /** Grace window in days before an orphan is eligible (default 7). */
  grace_days?: number;
  /** Test-injectable timestamp (epoch ms). */
  now?: number;
  /** Warm bucket basenames the operator has agreed are intentionally absent. */
  allow_missing_buckets?: string[];
  /** Report without deleting (default false). */
  dry_run?: boolean;
}

export interface CasGcResult {
  live_shas: number;
  considered: number;
  deleted: number;
  skipped_in_grace: number;
  bytes_freed: number;
}

/**
 * Garbage-collect CAS entries not referenced by any event in the live tier
 * or any warm bucket, past the grace window.
 *
 * @throws {import('./errors.js').WBError} WB-010 when any warm bucket is
 *         unreadable (never silently shrinks the live set on incomplete data).
 * @throws {Error} when dataDir or liveDb is missing.
 */
export function gc(opts: CasGcOptions): CasGcResult;
