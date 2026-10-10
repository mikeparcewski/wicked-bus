/**
 * Type declarations for lib/config.js — configuration loading and validation.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/config.js — CI runs `npm run typecheck` so drift fails loudly.
 */

/** Valid `log_level` values accepted by loadConfig(). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Merged runtime configuration (defaults ← `<dataDir>/config.json` ← caller
 * overrides). Extra keys from config.json are merged through untouched.
 */
export interface BusConfig {
  /**
   * Event VISIBILITY TTL in hours (default 72), per-event overridable via `emit({ ttl_hours })`.
   * Rows past `expires_at` are hidden from `poll()`. It does NOT bound how long a row is kept:
   * the sweep deletes on `dedup_expires_at`, so under the defaults a row is gone 48 h before its
   * visibility window would end, and raising `ttl_hours` alone retains nothing longer (#85).
   */
  ttl_hours: number;
  /**
   * Idempotency-dedup TTL in hours (default 24) — and, because both sweep paths delete on
   * `dedup_expires_at`, the row's actual LIFETIME: a subscriber has this long to ack before the
   * rows it never read are removed (`WB-003`, re-anchored by `subscribe()` since 2.3.5). Deleting
   * the row is what frees the `idempotency_key` UNIQUE slot, which `lib/dlq.js` replay depends on.
   * Must be <= `ttl_hours`, so raising retention means raising BOTH (#85).
   */
  dedup_ttl_hours: number;
  /**
   * Background sweep cadence in minutes (default 15). 0 disables startSweep().
   * Coerced to a finite number by loadConfig(); invalid/non-numeric input
   * (garbage string, empty string, boolean, etc.) falls back to the default.
   */
  sweep_interval_minutes: number;
  /**
   * Periodic WAL-checkpoint cadence in minutes (default 5). 0 disables
   * startCheckpoint(). Coerced to a finite number by loadConfig(); invalid/
   * non-numeric input falls back to the default.
   */
  checkpoint_interval_minutes: number;
  /** When true, the v1 sweep copies rows to `events_archive` before deleting. */
  archive_mode: boolean;
  /**
   * What the sweep does with an expired event an active cursor has not acked
   * (FND-BUS-01, #101): 'retain' (default — never swept, still delivered),
   * 'archive' (copied to `events_archive`, then deleted) or 'discard'.
   */
  unacked_policy: 'retain' | 'archive' | 'discard';
  /**
   * Retention cap in days (default 30) for the unacked backlog under 'retain':
   * an owed expired event emitted longer ago is ARCHIVED (`events_archive`, or
   * the warm bucket on the tiered sweep), never discarded, and the sweep
   * report names it with `reason: 'retention_cap'` (#101). Must be > 0.
   */
  unacked_retention_days: number;
  /**
   * Run the monthly warm-bucket tier (lib/sweep-v2.js) from `wicked-bus
   * cleanup` and the background sweep instead of the in-db v1 sweep
   * (FND-BUS-02, #102). Default false.
   */
  tiered_archive: boolean;
  log_level: LogLevel;
  /** Explicit database file path; null resolves to `<dataDir>/bus.db`. */
  db_path: string | null;
  /** Maximum event payload size in bytes (default 1 MiB). */
  max_payload_bytes: number;
  /**
   * Read by emit(): set false to skip the fire-and-forget daemon notify hop
   * (deployments without a daemon, or tests). Not part of DEFAULTS.
   */
  daemon_notify?: boolean;
  /** config.json may carry additional keys; they are merged through as-is. */
  [key: string]: unknown;
}

/** Built-in defaults merged under config.json and overrides. */
export const DEFAULTS: {
  ttl_hours: number;
  dedup_ttl_hours: number;
  sweep_interval_minutes: number;
  checkpoint_interval_minutes: number;
  archive_mode: boolean;
  unacked_policy: 'retain';
  unacked_retention_days: number;
  tiered_archive: boolean;
  log_level: LogLevel;
  db_path: null;
  max_payload_bytes: number;
};

/**
 * Load config from `<dataDir>/config.json`, merged with defaults and the
 * given overrides (missing/malformed config.json is silently ignored).
 * Null/undefined override values do not clobber defaults.
 *
 * `sweep_interval_minutes` and `checkpoint_interval_minutes` are coerced to
 * a finite number before validation, so the returned `BusConfig` honors its
 * declared `number` typing even when config.json holds a hand-edited string.
 * A coerced negative (e.g. `"-1"`) still throws, same as a negative number.
 *
 * @throws {Error} on invalid combinations (dedup_ttl_hours > ttl_hours,
 *         negative sweep/checkpoint interval (after coercion), non-positive
 *         max_payload_bytes, or an unknown log_level).
 */
export function loadConfig(overrides?: Partial<BusConfig>): BusConfig;

/**
 * Write DEFAULTS to `<dataDir>/config.json`. No-op when the file already
 * exists unless `force` is true.
 */
export function writeDefaultConfig(dataDir: string, force?: boolean): void;
