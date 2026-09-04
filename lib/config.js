/**
 * Configuration loading and validation.
 * @module lib/config
 */

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveDataDir } from './paths.js';

export const DEFAULTS = {
  ttl_hours: 72,
  dedup_ttl_hours: 24,
  sweep_interval_minutes: 15,
  checkpoint_interval_minutes: 5,
  archive_mode: false,
  log_level: 'warn',
  db_path: null,
  max_payload_bytes: 1048576,
};

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Coerce an interval config value to a finite number.
 * A finite number (incl. 0 and negatives) passes through unchanged --
 * validation rejects < 0. A numeric string ("5", "-1", " 5 ") parses to
 * its number. An empty/whitespace string, a garbage string, a boolean,
 * or any other non-numeric type falls back to `fallback` (the key's
 * documented default) -- a hand-edited config.json can carry any of
 * these, and none of them should reach a consumer's setInterval() as
 * NaN/string (a 1ms tight-loop) or silently become the wrong number
 * (Number(true) === 1).
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function coerceInterval(value, fallback) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/**
 * Load config from <dataDir>/config.json, merged with defaults.
 * Malformed JSON is silently ignored (defaults used).
 * `sweep_interval_minutes` and `checkpoint_interval_minutes` are coerced to
 * a finite number: a numeric string parses to its number, a legitimate `0`
 * is preserved (disables the corresponding timer), and anything else
 * invalid/non-numeric (garbage string, empty string, boolean, etc.) falls
 * back to that key's documented default before validation runs.
 * @param {object} [overrides] - CLI flag overrides (e.g. { db_path, log_level })
 * @returns {object}
 */
export function loadConfig(overrides = {}) {
  let userConfig = {};
  try {
    const dataDir = resolveDataDir();
    const configPath = join(dataDir, 'config.json');
    const raw = readFileSync(configPath, 'utf8');
    userConfig = JSON.parse(raw);
  } catch (_) {
    // File missing or malformed JSON -- use defaults
  }

  const config = { ...DEFAULTS, ...userConfig, ...overrides };

  // Remove null/undefined overrides so defaults aren't clobbered
  for (const key of Object.keys(overrides)) {
    if (overrides[key] == null) delete config[key];
    if (overrides[key] == null && DEFAULTS[key] != null) {
      config[key] = userConfig[key] != null ? userConfig[key] : DEFAULTS[key];
    }
  }

  config.sweep_interval_minutes = coerceInterval(
    config.sweep_interval_minutes, DEFAULTS.sweep_interval_minutes
  );
  config.checkpoint_interval_minutes = coerceInterval(
    config.checkpoint_interval_minutes, DEFAULTS.checkpoint_interval_minutes
  );

  // Validate
  if (config.dedup_ttl_hours > config.ttl_hours) {
    throw new Error(
      `Invalid config: dedup_ttl_hours (${config.dedup_ttl_hours}) must be <= ttl_hours (${config.ttl_hours})`
    );
  }
  if (config.sweep_interval_minutes < 0) {
    throw new Error('Invalid config: sweep_interval_minutes must be >= 0');
  }
  if (config.checkpoint_interval_minutes < 0) {
    throw new Error('Invalid config: checkpoint_interval_minutes must be >= 0');
  }
  if (config.max_payload_bytes < 1) {
    throw new Error('Invalid config: max_payload_bytes must be >= 1');
  }
  if (!VALID_LOG_LEVELS.includes(config.log_level)) {
    throw new Error(
      `Invalid config: log_level must be one of ${VALID_LOG_LEVELS.join(', ')}`
    );
  }

  return config;
}

/**
 * Write the default config to <dataDir>/config.json.
 * Does not overwrite if file already exists unless force=true.
 * @param {string} dataDir
 * @param {boolean} [force=false]
 */
export function writeDefaultConfig(dataDir, force = false) {
  const configPath = join(dataDir, 'config.json');
  if (!force) {
    try {
      readFileSync(configPath);
      return; // Already exists
    } catch (_) {
      // File doesn't exist, write it
    }
  }
  writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
}
