/**
 * Cross-platform data directory resolution.
 * @module lib/paths
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const SUBDIR = join('.something-wicked', 'wicked-bus');

/**
 * Resolve the wicked-bus data directory path (pure resolution, no side effects).
 * Priority: WICKED_BUS_DATA_DIR env > platform-specific home.
 * @returns {string}
 */
export function resolveDataDir() {
  const envDir = process.env.WICKED_BUS_DATA_DIR;
  if (envDir) return envDir;

  let base;
  if (process.platform === 'win32') {
    base =
      process.env.APPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      null;
    if (!base) {
      // Last resort on Windows
      try { base = homedir(); } catch (_) { /* ignore */ }
    }
    if (!base) {
      base = process.cwd();
    }
  } else {
    base = process.env.HOME || null;
    if (!base) {
      try { base = homedir(); } catch (_) { /* ignore */ }
    }
    if (!base) {
      throw new Error(
        'Cannot resolve data directory: $HOME is not set. ' +
        'Set WICKED_BUS_DATA_DIR or export HOME.'
      );
    }
  }

  return join(base, SUBDIR);
}

/**
 * Ensure the data directory exists (creates recursively).
 * @returns {string} The data directory path.
 */
export function ensureDataDir() {
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the full database file path.
 * @param {object} [config] - Config object; uses config.db_path if set.
 * @returns {string}
 */
export function resolveDbPath(config) {
  if (config && config.db_path) return config.db_path;
  return join(resolveDataDir(), 'bus.db');
}
