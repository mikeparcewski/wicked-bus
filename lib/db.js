/**
 * Database connection manager.
 * @module lib/db
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveDbPath, ensureDataDir } from './paths.js';
import { migrate, TARGET_SCHEMA_VERSION } from './migrate.js';
import { WBError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SCHEMA_SQL_PATH = join(__dirname, 'schema.sql');
const MAX_SUPPORTED_SCHEMA_VERSION = TARGET_SCHEMA_VERSION;

/**
 * Open (or create) the SQLite database, apply PRAGMAs and schema.
 * better-sqlite3 is synchronous, so this function is synchronous.
 * @param {object} [config] - Merged config object
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(config = {}) {
  const Database = require('better-sqlite3');

  ensureDataDir();
  const dbPath = resolveDbPath(config);

  const db = new Database(dbPath);

  // Apply PRAGMAs in order
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Execute schema DDL (idempotent)
  const schemaSql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
  // Split by semicolons and execute each statement
  // Filter out PRAGMA lines since we already applied them
  const statements = schemaSql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.toUpperCase().startsWith('PRAGMA'));

  for (const stmt of statements) {
    db.exec(stmt + ';');
  }

  // Apply pending v2+ migrations on top of the v1 baseline DDL
  migrate(db);

  // Schema version check
  checkSchemaVersion(db);

  return db;
}

/**
 * Check that the DB schema version is supported.
 * @param {import('better-sqlite3').Database} db
 */
function checkSchemaVersion(db) {
  const row = db.prepare(
    'SELECT MAX(version) as max_version FROM schema_migrations'
  ).get();

  if (row && row.max_version > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new WBError('WB-005', 'SCHEMA_VERSION_UNSUPPORTED', {
      message:
        `Database schema version ${row.max_version} is newer than supported ` +
        `(${MAX_SUPPORTED_SCHEMA_VERSION}). Upgrade with: npm install -g wicked-bus`,
      declared: row.max_version,
      max_supported: MAX_SUPPORTED_SCHEMA_VERSION,
    });
  }
}
