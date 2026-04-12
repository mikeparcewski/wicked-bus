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
  archive_mode: false,
  log_level: 'warn',
  db_path: null,
  max_payload_bytes: 1048576,
};

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Load config from <dataDir>/config.json, merged with defaults.
 * Malformed JSON is silently ignored (defaults used).
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

  // Validate
  if (config.dedup_ttl_hours > config.ttl_hours) {
    throw new Error(
      `Invalid config: dedup_ttl_hours (${config.dedup_ttl_hours}) must be <= ttl_hours (${config.ttl_hours})`
    );
  }
  if (config.sweep_interval_minutes < 0) {
    throw new Error('Invalid config: sweep_interval_minutes must be >= 0');
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
