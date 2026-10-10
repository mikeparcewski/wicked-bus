/**
 * TTL sweep -- removes expired events, never silently dropping one an active
 * consumer still owes an ack for.
 *
 * Retention model (FND-BUS-01, #101):
 *   - An event's LIFETIME is `expires_at` (`ttl_hours`, 72 h by default,
 *     per-event overridable). The sweep never removes an event before it.
 *   - The idempotency-dedup window (`dedup_expires_at`, `dedup_ttl_hours`) is
 *     separate: it only decides whether emit() treats a reused key as a
 *     duplicate (see lib/emit.js), it no longer deletes rows.
 *   - An expired event is OWED when an active cursor whose subscription filter
 *     matches it has not acked past it, or it has pending `delivery_attempts`.
 *     `config.unacked_policy` decides what happens to owed expired events:
 *       'retain'  (default) — never swept; still delivered by poll()
 *       'archive' — copied to `events_archive`, then deleted
 *       'discard' — deleted (the pre-2.4 behaviour, now reported)
 *   - Retention cap (`config.unacked_retention_days`, default 30): under
 *     'retain', an owed expired event emitted longer ago than the cap is
 *     ARCHIVED (moved to `events_archive`, or the warm bucket on the tiered
 *     sweep), never discarded, so an abandoned registered cursor cannot hold
 *     its backlog live forever (operator ruling 2026-10-10, #101).
 *     Every sweep returns a reconciliation report naming, per cursor, what was
 *     retained, archived or discarded, and why (`reason`).
 *
 * @module lib/sweep
 */

import { dirname } from 'node:path';
import {
  collectOwedExpired, resolveUnackedPolicy, resolveRetentionCapDays, owedPairsWithCap, buildUnackedReport,
} from './retention.js';
import { runSweepV2 } from './sweep-v2.js';

export {
  UNACKED_POLICIES, resolveUnackedPolicy, collectOwedExpired,
  DEFAULT_UNACKED_RETENTION_DAYS, resolveRetentionCapDays, owedPairsWithCap, buildUnackedReport,
} from './retention.js';

const ARCHIVE_TABLE_DDL = `
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
`;
// Columns must mirror `events` exactly because the archive INSERTs use
// SELECT *. A companion ALTER in lib/migrate.js upgrades pre-v2 archives.

/**
 * Run a single v1 sweep pass (in-database; `events_archive` when archiving).
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @param {boolean} [config.archive_mode]   - copy every swept row to events_archive first
 * @param {'retain'|'archive'|'discard'} [config.unacked_policy] - default 'retain'
 * @param {number} [config.unacked_retention_days] - retain cap, default 30
 * @param {number} [config.now]             - test override for "now"
 * @returns {{ events_deleted: number, unacked_policy: string, unacked: object }}
 */
export function runSweep(db, config) {
  const now = config?.now ?? Date.now();
  const policy = resolveUnackedPolicy(config);
  const capDays = resolveRetentionCapDays(config);

  const txn = db.transaction(() => {
    collectOwedExpired(db, now);
    const pairs = owedPairsWithCap(db, now, capDays);
    // Under 'retain', owed rows past the retention cap are archived, never
    // discarded (operator ruling 2026-10-10, #101).
    const capped = policy === 'retain' ? [...new Set(pairs.filter((p) => p.over_cap).map((p) => p.event_id))] : [];
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _wb_capped (event_id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM temp._wb_capped');
    const insCapped = db.prepare('INSERT INTO temp._wb_capped (event_id) VALUES (?)');
    for (const id of capped) insCapped.run(id);
    const owedEvents = new Set(pairs.map((p) => p.event_id)).size;
    const notOwed = 'event_id NOT IN (SELECT event_id FROM temp._wb_owed)';

    const archivesOwed = policy === 'archive' && owedEvents > 0;
    if (config?.archive_mode || archivesOwed || capped.length > 0) db.exec(ARCHIVE_TABLE_DDL);
    if (config?.archive_mode) {
      db.prepare(`INSERT OR IGNORE INTO events_archive SELECT * FROM events WHERE expires_at < ? AND ${notOwed}`).run(now);
    }
    if (archivesOwed) {
      db.prepare('INSERT OR IGNORE INTO events_archive SELECT * FROM events WHERE event_id IN (SELECT event_id FROM temp._wb_owed)').run();
    }
    if (capped.length > 0) {
      db.prepare('INSERT OR IGNORE INTO events_archive SELECT * FROM events WHERE event_id IN (SELECT event_id FROM temp._wb_capped)').run();
    }

    // Keyed on `expires_at` — the event's lifetime — never `dedup_expires_at`.
    const result = policy === 'retain'
      ? db.prepare(`DELETE FROM events WHERE expires_at < ? AND (${notOwed} OR event_id IN (SELECT event_id FROM temp._wb_capped))`).run(now)
      : db.prepare('DELETE FROM events WHERE expires_at < ?').run(now);
    db.exec('DELETE FROM temp._wb_owed');
    db.exec('DELETE FROM temp._wb_capped');

    const verb = policy === 'retain' ? 'retained' : policy === 'archive' ? 'archived' : 'discarded';
    return {
      events_deleted: result.changes,
      unacked_policy: policy,
      // Reconciliation report: what happened to expired events a consumer had
      // not acked yet, per cursor, and why. Empty when every consumer is caught up.
      unacked: buildUnackedReport(pairs, (p) => (policy === 'retain' && p.over_cap
        ? { disposition: 'archived', reason: 'retention_cap' }
        : { disposition: verb, reason: 'unacked_policy' }), { policy, capDays }),
    };
  });

  return txn();
}

/**
 * One sweep pass of the configured tier: the monthly warm-bucket sweep
 * (lib/sweep-v2.js) when `config.tiered_archive` is true, else the v1 sweep.
 * Both honour `unacked_policy`.
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 */
export function runConfiguredSweep(db, config) {
  if (!config?.tiered_archive) return runSweep(db, config);
  // Warm buckets live beside the live db they came from: an explicit db_path
  // (CLI --db-path) gets its own archive/ dir, never the default data dir's.
  const dataDir = config.data_dir ?? (config.db_path ? dirname(config.db_path) : undefined);
  return runSweepV2(db, dataDir ? { ...config, data_dir: dataDir } : config);
}

/**
 * Start a background sweep interval.
 *
 * `config.sweep_interval_minutes` is coerced defensively here too: loadConfig()
 * already guarantees a finite number, but a direct caller can still pass a raw
 * string/garbage value, and a truthy `"0"` must not slip past the disable check
 * into a 0ms setInterval spin (mirrors lib/checkpoint.js's startCheckpoint).
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 * @returns {NodeJS.Timeout|null} The interval handle, or null if sweep is disabled.
 */
export function startSweep(db, config) {
  const minutes = Number(config?.sweep_interval_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  const intervalMs = Math.max(1000, minutes * 60_000);
  return setInterval(() => {
    try {
      runConfiguredSweep(db, config);
    } catch (_) {
      // Sweep errors are non-fatal
    }
  }, intervalMs);
}
