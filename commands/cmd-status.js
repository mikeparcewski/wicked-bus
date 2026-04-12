/**
 * wicked-bus status command.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { resolveDbPath } from '../lib/paths.js';

export async function cmdStatus(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);
  const dbPath = resolveDbPath(config);

  const totalEvents = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  const oldest = db.prepare('SELECT MIN(event_id) as min_id FROM events').get();
  const newest = db.prepare('SELECT MAX(event_id) as max_id FROM events').get();

  // Events by type
  const byType = db.prepare(
    'SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type'
  ).all();
  const eventsByType = {};
  for (const row of byType) {
    eventsByType[row.event_type] = row.count;
  }

  // Subscribers with lag
  const subscribers = db.prepare(`
    SELECT s.subscription_id, s.plugin, s.event_type_filter,
           c.cursor_id, c.last_event_id, c.acked_at
    FROM subscriptions s
    JOIN cursors c ON c.subscription_id = s.subscription_id
    WHERE s.role = 'subscriber' AND s.deregistered_at IS NULL AND c.deregistered_at IS NULL
  `).all();

  const newestId = newest.max_id || 0;
  const subscriberList = subscribers.map(s => ({
    subscription_id: s.subscription_id,
    plugin: s.plugin,
    filter: s.event_type_filter,
    cursor_id: s.cursor_id,
    last_event_id: s.last_event_id,
    lag: newestId - s.last_event_id,
    acked_at: s.acked_at,
  }));

  // Providers
  const providers = db.prepare(`
    SELECT subscription_id, plugin, event_type_filter, schema_version
    FROM subscriptions
    WHERE role = 'provider' AND deregistered_at IS NULL
  `).all();

  const result = {
    db_path: dbPath,
    total_events: totalEvents,
    oldest_event_id: oldest.min_id || null,
    newest_event_id: newest.max_id || null,
    events_by_type: eventsByType,
    subscribers: subscriberList,
    providers,
  };

  db.close();
  process.stdout.write(JSON.stringify(result) + '\n');
}
