/**
 * Event emission with idempotency and TTL computation.
 * @module lib/emit
 */

import { v4 as uuidv4 } from 'uuid';
import { validateEvent } from './validate.js';
import { WBError } from './errors.js';

/**
 * Emit an event to the bus.
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - Merged config
 * @param {object} event - Event data
 * @param {string} event.event_type
 * @param {string} event.domain
 * @param {string} [event.subdomain]
 * @param {object|string} event.payload
 * @param {string} [event.schema_version]
 * @param {string} [event.idempotency_key]
 * @param {number} [event.ttl_hours] - Per-event TTL override
 * @param {string|object} [event.metadata]
 * @returns {{ event_id: number, idempotency_key: string }}
 */
export function emit(db, config, event) {
  // Validate
  validateEvent(event, config);

  const idempotencyKey = event.idempotency_key || uuidv4();
  const emittedAt = Date.now();
  const ttlHours = event.ttl_hours != null ? event.ttl_hours : config.ttl_hours;
  const expiresAt = emittedAt + (ttlHours * 3_600_000);
  const dedupExpiresAt = emittedAt + (config.dedup_ttl_hours * 3_600_000);

  const payloadStr = typeof event.payload === 'string'
    ? event.payload
    : JSON.stringify(event.payload);

  const metadataStr = event.metadata != null
    ? (typeof event.metadata === 'string' ? event.metadata : JSON.stringify(event.metadata))
    : null;

  const schemaVersion = event.schema_version || '1.0.0';

  try {
    const subdomain = event.subdomain || '';

    const stmt = db.prepare(`
      INSERT INTO events (
        event_type, domain, subdomain, payload, schema_version,
        idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      event.event_type,
      event.domain,
      subdomain,
      payloadStr,
      schemaVersion,
      idempotencyKey,
      emittedAt,
      expiresAt,
      dedupExpiresAt,
      metadataStr
    );

    return {
      event_id: Number(result.lastInsertRowid),
      idempotency_key: idempotencyKey,
    };
  } catch (err) {
    // Duplicate idempotency_key
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = db.prepare(
        'SELECT event_id FROM events WHERE idempotency_key = ?'
      ).get(idempotencyKey);

      throw new WBError('WB-002', 'DUPLICATE_EVENT', {
        message: `Duplicate idempotency_key: ${idempotencyKey}`,
        original_event_id: existing ? existing.event_id : null,
        idempotency_key: idempotencyKey,
      });
    }

    // Disk full
    if (
      (err.code && err.code.includes('SQLITE_FULL')) ||
      (err.code === 'ENOSPC') ||
      (err.message && err.message.includes('SQLITE_FULL'))
    ) {
      const dbPath = db.name;
      try { db.close(); } catch (_) { /* ignore close errors */ }
      // Re-open to verify integrity
      try {
        const Database = db.constructor;
        const verifyDb = new Database(dbPath);
        verifyDb.pragma('integrity_check');
        verifyDb.close();
      } catch (_) { /* ignore verification errors */ }

      throw new WBError('WB-004', 'DISK_FULL', {
        message: 'Database disk is full',
        sqlite_error: err.code || 'SQLITE_FULL',
        db_path: dbPath,
      });
    }

    throw err;
  }
}
