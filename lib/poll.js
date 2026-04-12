/**
 * Event polling and acknowledgment.
 * @module lib/poll
 */

import { WBError } from './errors.js';

/**
 * Match an event against a filter string.
 * @param {string} eventType - The event_type to test
 * @param {string} domain - The domain of the event
 * @param {string} filterStr - Filter pattern, e.g. 'wicked.test.run.*@wicked-testing'
 * @returns {boolean}
 */
export function matchesFilter(eventType, domain, filterStr) {
  let typePattern, domainFilter;
  const atIdx = filterStr.indexOf('@');
  if (atIdx !== -1) {
    typePattern = filterStr.slice(0, atIdx);
    domainFilter = filterStr.slice(atIdx + 1);
  } else {
    typePattern = filterStr;
    domainFilter = null;
  }

  // Domain check
  if (domainFilter && domain !== domainFilter) return false;

  // Catch-all (*@domain)
  if (typePattern === '*') return true;

  // Exact match
  if (typePattern === eventType) return true;

  // Single-level wildcard (prefix.*)
  if (typePattern.endsWith('.*')) {
    const prefix = typePattern.slice(0, -2);
    if (eventType.startsWith(prefix + '.')) {
      const remainder = eventType.slice(prefix.length + 1);
      return !remainder.includes('.'); // single-level only
    }
  }

  return false;
}

/**
 * Build SQL WHERE clauses from a filter string for optimized queries.
 * @param {string} filterStr
 * @returns {{ where: string, params: object }}
 */
function buildFilterSql(filterStr) {
  let typePattern, domainFilter;
  const atIdx = filterStr.indexOf('@');
  if (atIdx !== -1) {
    typePattern = filterStr.slice(0, atIdx);
    domainFilter = filterStr.slice(atIdx + 1);
  } else {
    typePattern = filterStr;
    domainFilter = null;
  }

  const conditions = [];
  const params = {};

  // Domain filter
  if (domainFilter) {
    conditions.push('domain = :domain_filter');
    params.domain_filter = domainFilter;
  }

  // Type filter
  if (typePattern === '*') {
    // Catch-all: no type filter
  } else if (typePattern.endsWith('.*')) {
    const prefix = typePattern.slice(0, -2);
    conditions.push("event_type LIKE :prefix_like");
    conditions.push("event_type NOT LIKE :prefix_multi");
    params.prefix_like = prefix + '.%';
    params.prefix_multi = prefix + '.%.%';
  } else {
    // Exact match
    conditions.push('event_type = :exact_type');
    params.exact_type = typePattern;
  }

  return {
    where: conditions.length > 0 ? conditions.join(' AND ') : '1=1',
    params,
  };
}

/**
 * Poll for events from the given cursor position.
 * @param {import('better-sqlite3').Database} db
 * @param {string} cursorId
 * @param {object} [options]
 * @param {number} [options.batchSize=100]
 * @returns {object[]} Array of event rows
 */
export function poll(db, cursorId, options = {}) {
  const batchSize = options.batchSize || 100;

  // Load cursor
  const cursor = db.prepare(
    'SELECT * FROM cursors WHERE cursor_id = ?'
  ).get(cursorId);

  if (!cursor || cursor.deregistered_at != null) {
    throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
      message: 'Cursor not found or deregistered',
      cursor_id: cursorId,
      reason: 'cursor not found or deregistered',
    });
  }

  // WB-003 check: cursor behind oldest available row
  const oldest = db.prepare('SELECT MIN(event_id) as min_id FROM events').get();
  if (oldest && oldest.min_id != null) {
    if (cursor.last_event_id < oldest.min_id - 1) {
      throw new WBError('WB-003', 'CURSOR_BEHIND_TTL_WINDOW', {
        message: 'Cursor is behind the TTL window; events have been swept',
        cursor_last_event_id: cursor.last_event_id,
        oldest_available_event_id: oldest.min_id,
      });
    }
  }

  // Load subscription for filter
  const sub = db.prepare(
    'SELECT * FROM subscriptions WHERE subscription_id = ?'
  ).get(cursor.subscription_id);

  if (!sub) {
    throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
      message: 'Subscription not found for cursor',
      cursor_id: cursorId,
      reason: 'subscription not found',
    });
  }

  const filter = sub.event_type_filter;
  const { where, params } = buildFilterSql(filter);
  const now = Date.now();

  const sql = `
    SELECT * FROM events
    WHERE event_id > :last_event_id
      AND expires_at > :now
      AND ${where}
    ORDER BY event_id ASC
    LIMIT :batch_size
  `;

  const allParams = {
    ...params,
    last_event_id: cursor.last_event_id,
    now,
    batch_size: batchSize,
  };

  return db.prepare(sql).all(allParams);
}

/**
 * Acknowledge events up to the given event_id for a cursor.
 * @param {import('better-sqlite3').Database} db
 * @param {string} cursorId
 * @param {number} lastEventId
 * @returns {{ acked: boolean, cursor_id: string, last_event_id: number }}
 */
export function ack(db, cursorId, lastEventId) {
  const now = Date.now();

  // Check cursor exists and is active
  const cursor = db.prepare(
    'SELECT * FROM cursors WHERE cursor_id = ?'
  ).get(cursorId);

  if (!cursor || cursor.deregistered_at != null) {
    throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
      message: 'Cursor not found or deregistered',
      cursor_id: cursorId,
      reason: 'cursor not found or deregistered',
    });
  }

  const update = db.prepare(`
    UPDATE cursors
    SET last_event_id = ?, acked_at = ?
    WHERE cursor_id = ? AND deregistered_at IS NULL
  `);

  const txn = db.transaction(() => {
    const result = update.run(lastEventId, now, cursorId);
    if (result.changes === 0) {
      throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
        message: 'Cursor not found or deregistered',
        cursor_id: cursorId,
        reason: 'cursor not found or deregistered',
      });
    }
  });

  txn();

  return {
    acked: true,
    cursor_id: cursorId,
    last_event_id: lastEventId,
  };
}
