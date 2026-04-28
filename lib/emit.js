/**
 * Event emission with idempotency and TTL computation.
 * @module lib/emit
 */

import { v4 as uuidv4 } from 'uuid';
import { validateEvent } from './validate.js';
import { WBError } from './errors.js';
import { notifyEmit } from './daemon-notify.js';
import { resolveDataDir } from './paths.js';
import { applyOnEmit } from './schema-registry.js';
import { currentContext, recordEmit } from './causality.js';

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

  const initialPayloadStr = typeof event.payload === 'string'
    ? event.payload
    : JSON.stringify(event.payload);

  const metadataStr = event.metadata != null
    ? (typeof event.metadata === 'string' ? event.metadata : JSON.stringify(event.metadata))
    : null;

  const schemaVersion = event.schema_version || '1.0.0';

  // Apply registered schema policy (size cap + cas-auto offload + JSON Schema
  // checks). When no schema row matches event_type, this is a no-op pass-through
  // and v1 behavior is preserved exactly.
  const registry = applyOnEmit({
    db,
    dataDir: resolveDataDir(),
    eventType: event.event_type,
    payloadStr: initialPayloadStr,
  });
  const payloadStr = registry.payload;
  if (config.log_level !== 'silent' && registry.warnings.length > 0) {
    for (const w of registry.warnings) {
      process.stderr.write(JSON.stringify({
        level: 'warn',
        domain: 'wicked-bus.registry',
        event_type: event.event_type,
        message: w,
      }) + '\n');
    }
  }

  // Causality context: explicit fields on the event override the active
  // withContext() / env-var context. Producers can opt out of cross-process
  // propagation by passing parent_event_id: null, etc.
  const ctx = currentContext();
  const correlationId = chooseField(event, ctx, 'correlation_id');
  const sessionId     = chooseField(event, ctx, 'session_id');
  const parentEventId = chooseField(event, ctx, 'parent_event_id');
  const producerId    = chooseField(event, ctx, 'producer_id');

  try {
    const subdomain = event.subdomain || '';

    const stmt = db.prepare(`
      INSERT INTO events (
        event_type, domain, subdomain, payload, schema_version,
        idempotency_key, emitted_at, expires_at, dedup_expires_at, metadata,
        registry_schema_version, payload_cas_sha,
        correlation_id, session_id, parent_event_id, producer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      metadataStr,
      registry.registry_schema_version,
      registry.payload_cas_sha,
      correlationId,
      sessionId,
      parentEventId,
      producerId,
    );

    const eventId = Number(result.lastInsertRowid);

    // Update the active context so the next emit in the same withContext()
    // block chains via parent_event_id.
    recordEmit(eventId);

    // Fire-and-forget: notify the daemon (if running) so it can fan out the
    // event to push subscribers. Scheduled with setImmediate so emit() stays
    // synchronous from the caller's perspective. Disabled when
    // config.daemon_notify === false (set by tests that don't want the
    // notify hop, or by deployments that run without a daemon).
    if (config.daemon_notify !== false) {
      const daemonRow = {
        event_id: eventId,
        event_type: event.event_type,
        domain: event.domain,
        subdomain,
        payload: payloadStr,
        schema_version: schemaVersion,
        idempotency_key: idempotencyKey,
        emitted_at: emittedAt,
        expires_at: expiresAt,
        dedup_expires_at: dedupExpiresAt,
        metadata: metadataStr,
        registry_schema_version: registry.registry_schema_version,
        payload_cas_sha: registry.payload_cas_sha,
        correlation_id: correlationId,
        session_id: sessionId,
        parent_event_id: parentEventId,
        producer_id: producerId,
      };
      setImmediate(() => {
        // notifyEmit() never throws by contract — but defend against changes.
        notifyEmit(resolveDataDir(), daemonRow).catch(() => { /* swallowed */ });
      });
    }

    return {
      event_id: eventId,
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

/**
 * Pick a causality field: explicit on the event > active context > null.
 */
function chooseField(event, ctx, key) {
  if (event && Object.prototype.hasOwnProperty.call(event, key)) {
    return event[key] ?? null;
  }
  return ctx[key] ?? null;
}
