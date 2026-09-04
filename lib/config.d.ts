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
  /** Event visibility TTL in hours (default 72). Rows past it are hidden from poll. */
  ttl_hours: number;
  /** Idempotency-dedup TTL in hours (default 24). Rows past it are deleted by sweep. Must be <= ttl_hours. */
  dedup_ttl_hours: number;
  /** Background sweep cadence in minutes (default 15). 0 disables startSweep(). */
  sweep_interval_minutes: number;
  /** Periodic WAL-checkpoint cadence in minutes (default 5). 0 disables startCheckpoint(). */
  checkpoint_interval_minutes: number;
  /** When true, the v1 sweep copies rows to `events_archive` before deleting. */
  archive_mode: boolean;
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
  log_level: LogLevel;
  db_path: null;
  max_payload_bytes: number;
};

/**
 * Load config from `<dataDir>/config.json`, merged with defaults and the
 * given overrides (missing/malformed config.json is silently ignored).
 * Null/undefined override values do not clobber defaults.
 *
 * @throws {Error} on invalid combinations (dedup_ttl_hours > ttl_hours,
 *         negative sweep interval, non-positive max_payload_bytes, or an
 *         unknown log_level).
 */
export function loadConfig(overrides?: Partial<BusConfig>): BusConfig;

/**
 * Write DEFAULTS to `<dataDir>/config.json`. No-op when the file already
 * exists unless `force` is true.
 */
export function writeDefaultConfig(dataDir: string, force?: boolean): void;
