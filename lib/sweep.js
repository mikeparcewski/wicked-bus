/**
 * TTL sweep -- deletes expired events, optionally archiving them first.
 * @module lib/sweep
 */

/**
 * Run a single sweep pass.
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @returns {{ events_deleted: number }}
 */
export function runSweep(db, config) {
  const now = Date.now();

  const txn = db.transaction(() => {
    if (config.archive_mode) {
      // Create archive table if not exists. Columns must mirror `events`
      // exactly because the INSERT below uses SELECT *. The v2 causality and
      // CAS columns are mirrored here to keep that contract intact; a
      // companion ALTER in lib/migrate.js handles upgrades of pre-v2 archives.
      db.exec(`
        CREATE TABLE IF NOT EXISTS events_archive (
            event_id                 INTEGER PRIMARY KEY,
            event_type               TEXT    NOT NULL,
            domain                   TEXT    NOT NULL,
            subdomain                TEXT    NOT NULL DEFAULT '',
            payload                  TEXT    NOT NULL,
            schema_version           TEXT    NOT NULL DEFAULT '1.0.0',
            idempotency_key          TEXT    NOT NULL,
            emitted_at               INTEGER NOT NULL,
            expires_at               INTEGER NOT NULL,
            dedup_expires_at         INTEGER NOT NULL,
            metadata                 TEXT,
            parent_event_id          INTEGER,
            session_id               TEXT,
            correlation_id           TEXT,
            producer_id              TEXT,
            origin_node_id           TEXT,
            registry_schema_version  INTEGER,
            payload_cas_sha          TEXT
        );
      `);

      // Copy to archive before deletion
      db.prepare(`
        INSERT OR IGNORE INTO events_archive
        SELECT * FROM events WHERE dedup_expires_at < ?
      `).run(now);
    }

    // Delete expired events
    const result = db.prepare(
      'DELETE FROM events WHERE dedup_expires_at < ?'
    ).run(now);

    return { events_deleted: result.changes };
  });

  return txn();
}

/**
 * Start a background sweep interval.
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @returns {NodeJS.Timeout|null} The interval handle, or null if sweep is disabled.
 */
export function startSweep(db, config) {
  if (!config.sweep_interval_minutes || config.sweep_interval_minutes === 0) {
    return null;
  }

  const intervalMs = config.sweep_interval_minutes * 60_000;
  return setInterval(() => {
    try {
      runSweep(db, config);
    } catch (_) {
      // Sweep errors are non-fatal
    }
  }, intervalMs);
}
