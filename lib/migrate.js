/**
 * Schema migrations.
 * Each migration is idempotent: re-running is a no-op.
 * Migrations are tracked in the schema_migrations table seeded by schema.sql.
 *
 * v1 of the npm package landed schema_migrations versions 1 and 2.
 * v2 of the npm package lands version 3 (additive columns + schemas registry +
 * cursor push-state columns). Future v2.1+ migrations will land 4, 5, ...
 *
 * @module lib/migrate
 */

export const TARGET_SCHEMA_VERSION = 3;

/**
 * Apply all pending migrations up to TARGET_SCHEMA_VERSION.
 * Caller should have a fully-opened db with WAL/foreign_keys/busy_timeout
 * already configured (db.js handles that). Returns the version after migration.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} schema version after migration
 */
export function migrate(db) {
  const current = currentVersion(db);
  if (current >= TARGET_SCHEMA_VERSION) return current;

  if (current < 3) applyMigration3(db);

  return currentVersion(db);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function currentVersion(db) {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_migrations')
    .get();
  return row && row.v != null ? row.v : 0;
}

// ---------------------------------------------------------------------------
// Migration 3 — v2 npm package: causality columns, schemas registry,
//               cursor push-state columns.
// ---------------------------------------------------------------------------

function applyMigration3(db) {
  const tx = db.transaction(() => {
    addColumnIfMissing(db, 'events', 'parent_event_id', 'INTEGER');
    addColumnIfMissing(db, 'events', 'session_id', 'TEXT');
    addColumnIfMissing(db, 'events', 'correlation_id', 'TEXT');
    addColumnIfMissing(db, 'events', 'producer_id', 'TEXT');
    addColumnIfMissing(db, 'events', 'origin_node_id', 'TEXT');
    addColumnIfMissing(db, 'events', 'registry_schema_version', 'INTEGER');
    addColumnIfMissing(db, 'events', 'payload_cas_sha', 'TEXT');

    addColumnIfMissing(db, 'cursors', 'push_socket_addr', 'TEXT');
    addColumnIfMissing(db, 'cursors', 'lag_estimate', 'INTEGER');

    // events_archive is lazily created by sweep when archive_mode is on.
    // If a pre-v2 archive exists (older DB upgraded to v2), add the same
    // v2 columns so the v1 sweep's `INSERT INTO events_archive SELECT *
    // FROM events` keeps working. New archives created by v2+ sweep
    // include these columns from the start (see lib/sweep.js).
    if (tableExists(db, 'events_archive')) {
      addColumnIfMissing(db, 'events_archive', 'parent_event_id', 'INTEGER');
      addColumnIfMissing(db, 'events_archive', 'session_id', 'TEXT');
      addColumnIfMissing(db, 'events_archive', 'correlation_id', 'TEXT');
      addColumnIfMissing(db, 'events_archive', 'producer_id', 'TEXT');
      addColumnIfMissing(db, 'events_archive', 'origin_node_id', 'TEXT');
      addColumnIfMissing(db, 'events_archive', 'registry_schema_version', 'INTEGER');
      addColumnIfMissing(db, 'events_archive', 'payload_cas_sha', 'TEXT');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_correlation_id  ON events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_events_session_id      ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_parent_event_id ON events(parent_event_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS schemas (
        event_type        TEXT    NOT NULL,
        version           INTEGER NOT NULL,
        json_schema       TEXT    NOT NULL,
        retention         TEXT    NOT NULL DEFAULT 'default'
                            CHECK(retention IN ('default','forever','short')),
        payload_max_bytes INTEGER NOT NULL DEFAULT 16384,
        archive_to        TEXT    NOT NULL DEFAULT 'warm'
                            CHECK(archive_to IN ('warm','cold','none')),
        payload_oversize  TEXT    NOT NULL DEFAULT 'warn'
                            CHECK(payload_oversize IN ('warn','cas-auto','strict')),
        deprecated_at     INTEGER,
        sunset_at         INTEGER,
        PRIMARY KEY (event_type, version)
      );
    `);

    db.prepare(
      `INSERT OR IGNORE INTO schema_migrations(version, applied_at, description)
       VALUES (?, unixepoch() * 1000, ?)`
    ).run(3, 'v2 npm: causality columns + schemas registry + cursor push-state');
  });

  tx();
}

/**
 * Idempotent column-add. SQLite ALTER TABLE ADD COLUMN is naturally additive
 * but throws "duplicate column name" on re-run. Catch that one error class.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} column
 * @param {string} typeDecl   e.g. 'TEXT', 'INTEGER'
 */
function addColumnIfMissing(db, table, column, typeDecl) {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
}

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === column);
}

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
  return !!row;
}
