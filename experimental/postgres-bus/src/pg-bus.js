/**
 * Minimal Postgres-backed bus prototype — MEASUREMENT SPIKE ONLY.
 *
 * Mirrors the wicked-bus shape at the smallest scale that lets us measure:
 *   - emit(): INSERT into an append-only events table (BIGSERIAL id)
 *   - per-subscriber durable cursor (bus_cursors row, advanced transactionally)
 *   - consumeBatch(): cursor-anchored batch claim with FOR UPDATE SKIP LOCKED
 *   - LISTEN/NOTIFY hybrid: pg_notify on emit wakes the consumer, which then
 *     runs the same SKIP LOCKED cursor read (notify is a wake-up, not the
 *     delivery channel — delivery stays durable/at-least-once via the table).
 *
 * Deliberately NOT here: idempotency keys, TTL sweep, filters, DLQ, retry,
 * schema registry — none of that changes the latency/throughput physics this
 * spike exists to measure.
 *
 * Known correctness caveat (documented, relevant for productionization):
 * advancing a cursor to MAX(id) of a batch assumes ids become visible in
 * order. With CONCURRENT emitters, a lower id can commit after a higher one
 * and be skipped forever. The bench uses a single sequential emitter so the
 * hazard is not exercised; a real PostgresBus needs txid/snapshot fencing or
 * claim-markers instead of a bare max-id cursor.
 */

import pg from 'pg';

const { Pool, Client } = pg;

export const EVENTS_TABLE = 'bus_events';
export const CURSORS_TABLE = 'bus_cursors';
export const NOTIFY_CHANNEL = 'wb_events';

const DDL = `
CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  domain      TEXT NOT NULL DEFAULT '',
  payload     JSONB NOT NULL,
  emitted_at  DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS ${CURSORS_TABLE} (
  subscriber_id  TEXT PRIMARY KEY,
  last_event_id  BIGINT NOT NULL DEFAULT 0,
  updated_at     DOUBLE PRECISION NOT NULL DEFAULT 0
);
`;

/**
 * Create a bus handle over a pg Pool.
 * @param {{ connectionString: string, poolSize?: number }} opts
 */
export function createPgBus(opts) {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.poolSize ?? 10,
  });

  async function init() {
    await pool.query(DDL);
  }

  async function reset() {
    await pool.query(
      `TRUNCATE ${EVENTS_TABLE} RESTART IDENTITY; TRUNCATE ${CURSORS_TABLE};`
    );
  }

  /**
   * Emit one event. `notify: true` adds a pg_notify in the same statement so
   * the NOTIFY fires atomically with the commit (LISTEN/NOTIFY hybrid).
   * @returns {Promise<number>} the assigned event id
   */
  async function emit(eventType, payload, { notify = false } = {}) {
    const emittedAt = Date.now();
    const sql = notify
      ? `WITH ins AS (
           INSERT INTO ${EVENTS_TABLE} (event_type, domain, payload, emitted_at)
           VALUES ($1, $2, $3, $4) RETURNING id
         )
         SELECT ins.id, pg_notify('${NOTIFY_CHANNEL}', ins.id::text) FROM ins`
      : `INSERT INTO ${EVENTS_TABLE} (event_type, domain, payload, emitted_at)
         VALUES ($1, $2, $3, $4) RETURNING id`;
    const res = await pool.query(sql, ['wicked.bench.event.emitted', 'bench', payload, emittedAt]);
    return Number(res.rows[0].id);
  }

  /** Multi-row insert used only to pre-fill for drain-only throughput runs. */
  async function emitMany(payloads) {
    const values = [];
    const params = [];
    let i = 1;
    for (const p of payloads) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
      params.push('wicked.bench.event.emitted', 'bench', p, Date.now());
    }
    await pool.query(
      `INSERT INTO ${EVENTS_TABLE} (event_type, domain, payload, emitted_at) VALUES ${values.join(',')}`,
      params
    );
  }

  /** Idempotently create a subscriber cursor (starts at 0 = oldest). */
  async function ensureCursor(subscriberId, startAt = 0) {
    await pool.query(
      `INSERT INTO ${CURSORS_TABLE} (subscriber_id, last_event_id, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (subscriber_id) DO NOTHING`,
      [subscriberId, startAt, Date.now()]
    );
  }

  /**
   * Claim and consume one batch, at-least-once:
   *   BEGIN
   *     SELECT cursor FOR UPDATE            -- serializes workers on one cursor
   *     SELECT events > cursor LIMIT k FOR UPDATE SKIP LOCKED
   *     handler(rows)                       -- processing INSIDE the txn
   *     UPDATE cursor -> max(id)            -- advance transactionally
   *   COMMIT
   * A crash before COMMIT re-delivers the whole batch (at-least-once).
   *
   * @param {string} subscriberId
   * @param {number} k batch size
   * @param {(rows: Array<{id:number, payload:object, emitted_at:number}>) => void|Promise<void>} handler
   * @returns {Promise<number>} rows consumed
   */
  async function consumeBatch(subscriberId, k, handler) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const cur = await c.query(
        `SELECT last_event_id FROM ${CURSORS_TABLE} WHERE subscriber_id = $1 FOR UPDATE`,
        [subscriberId]
      );
      if (cur.rows.length === 0) throw new Error(`no cursor: ${subscriberId}`);
      const last = Number(cur.rows[0].last_event_id);

      const res = await c.query(
        `SELECT id, payload, emitted_at FROM ${EVENTS_TABLE}
         WHERE id > $1 ORDER BY id ASC LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [last, k]
      );

      if (res.rows.length > 0) {
        await handler(res.rows);
        const maxId = Number(res.rows[res.rows.length - 1].id);
        await c.query(
          `UPDATE ${CURSORS_TABLE} SET last_event_id = $2, updated_at = $3 WHERE subscriber_id = $1`,
          [subscriberId, maxId, Date.now()]
        );
      }
      await c.query('COMMIT');
      return res.rows.length;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * LISTEN on the notify channel with a dedicated (non-pooled) connection.
   * Returns { close }. onWake() is called on every NOTIFY — the caller runs
   * a consumeBatch drain in response (coalescing is the caller's job).
   */
  async function listen(onWake) {
    const client = new Client({ connectionString: opts.connectionString });
    await client.connect();
    client.on('notification', () => onWake());
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    return {
      close: async () => { try { await client.end(); } catch (_) { /* ignore */ } },
    };
  }

  async function close() {
    await pool.end();
  }

  return { pool, init, reset, emit, emitMany, ensureCursor, consumeBatch, listen, close };
}
