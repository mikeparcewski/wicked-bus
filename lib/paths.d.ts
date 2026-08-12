/**
 * Type declarations for lib/paths.js — cross-platform data directory resolution.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/paths.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { BusConfig } from './config.js';

/**
 * Resolve the wicked-bus data directory (pure resolution, no side effects).
 * Priority: `WICKED_BUS_DATA_DIR` env var, then the platform-specific home
 * directory joined with `.something-wicked/wicked-bus`.
 *
 * @throws {Error} on non-Windows platforms when neither the env var nor a
 *         home directory can be resolved.
 */
export function resolveDataDir(): string;

/** Ensure the data directory exists (recursive mkdir). Returns its path. */
export function ensureDataDir(): string;

/**
 * Resolve the full database file path: `config.db_path` when set, otherwise
 * `<dataDir>/bus.db`.
 */
export function resolveDbPath(config?: Partial<BusConfig>): string;
