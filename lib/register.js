/**
 * Registration and deregistration of providers/subscribers.
 * @module lib/register
 */

import { v4 as uuidv4 } from 'uuid';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolveDataDir } from './paths.js';
import { WBError } from './errors.js';

/**
 * Register a provider or subscriber.
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.plugin - Plugin name
 * @param {'provider'|'subscriber'} opts.role
 * @param {string} opts.filter - Event type filter (for subscribers) or comma-separated event types (for providers)
 * @param {string} [opts.schema_version] - Schema version (providers)
 * @param {'oldest'|'latest'} [opts.cursor_init='latest'] - Cursor initialization (subscribers)
 * @returns {object}
 */
export function register(db, opts) {
  const subscriptionId = uuidv4();
  const now = Date.now();

  const insertSub = db.prepare(`
    INSERT INTO subscriptions (
      subscription_id, plugin, role, event_type_filter,
      schema_version, registered_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertSub.run(
    subscriptionId,
    opts.plugin,
    opts.role,
    opts.filter,
    opts.schema_version || null,
    now
  );

  const result = {
    subscription_id: subscriptionId,
    plugin: opts.plugin,
    role: opts.role,
    registered_at: now,
  };

  if (opts.role === 'provider') {
    // Write sidecar JSON
    writeSidecar(opts.plugin, {
      subscription_id: subscriptionId,
      plugin: opts.plugin,
      role: 'provider',
      event_types: opts.filter.split(',').map(s => s.trim()),
      schema_version: opts.schema_version || null,
      registered_at: new Date(now).toISOString(),
      registered_at_ms: now,
    });
    result.filter = opts.filter;
  }

  if (opts.role === 'subscriber') {
    // Create cursor
    const cursorId = uuidv4();
    let lastEventId = 0;

    if (opts.cursor_init === 'latest') {
      const row = db.prepare('SELECT MAX(event_id) as max_id FROM events').get();
      lastEventId = row && row.max_id != null ? row.max_id : 0;
    }

    db.prepare(`
      INSERT INTO cursors (
        cursor_id, subscription_id, last_event_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(cursorId, subscriptionId, lastEventId, now);

    result.cursor_id = cursorId;
    result.filter = opts.filter;
    result.cursor_init = opts.cursor_init || 'latest';
    result.last_event_id = lastEventId;
  }

  return result;
}

/**
 * Deregister a subscription (soft delete).
 * @param {import('better-sqlite3').Database} db
 * @param {string} subscriptionId
 * @returns {object}
 */
export function deregister(db, subscriptionId) {
  const now = Date.now();

  const sub = db.prepare(
    'SELECT * FROM subscriptions WHERE subscription_id = ?'
  ).get(subscriptionId);

  if (!sub) {
    throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
      message: `Subscription not found: ${subscriptionId}`,
      subscription_id: subscriptionId,
      reason: 'subscription not found',
    });
  }

  const txn = db.transaction(() => {
    // Soft-delete the subscription
    db.prepare(
      'UPDATE subscriptions SET deregistered_at = ? WHERE subscription_id = ?'
    ).run(now, subscriptionId);

    // Soft-delete associated cursors (for subscribers)
    if (sub.role === 'subscriber') {
      db.prepare(
        'UPDATE cursors SET deregistered_at = ? WHERE subscription_id = ? AND deregistered_at IS NULL'
      ).run(now, subscriptionId);
    }

    // Remove provider sidecar
    if (sub.role === 'provider') {
      removeSidecar(sub.plugin);
    }
  });

  txn();

  return {
    deregistered: true,
    subscription_id: subscriptionId,
    deregistered_at: now,
  };
}

/**
 * Write a provider sidecar JSON file.
 */
function writeSidecar(plugin, data) {
  try {
    const dataDir = resolveDataDir();
    const providersDir = join(dataDir, 'providers');
    mkdirSync(providersDir, { recursive: true });
    const sidecarPath = join(providersDir, `${plugin}.json`);
    writeFileSync(sidecarPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_) {
    // Sidecar write failure is non-fatal
  }
}

/**
 * Remove a provider sidecar JSON file.
 */
function removeSidecar(plugin) {
  try {
    const dataDir = resolveDataDir();
    const sidecarPath = join(dataDir, 'providers', `${plugin}.json`);
    unlinkSync(sidecarPath);
  } catch (_) {
    // Sidecar removal failure is non-fatal
  }
}
