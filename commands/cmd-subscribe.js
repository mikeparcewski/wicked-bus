/**
 * wicked-bus subscribe command -- streaming NDJSON poll.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { poll, ack } from '../lib/poll.js';
import { register } from '../lib/register.js';
import { startSweep } from '../lib/sweep.js';

export async function cmdSubscribe(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  const plugin = args.plugin;
  const filter = args.filter;
  const pollIntervalMs = Number(args['poll-interval-ms']) || 1000;
  const batchSize = Number(args['batch-size']) || 100;
  const noAck = args['no-ack'] === true;

  let cursorId = args['cursor-id'] || null;

  // If no cursor-id, try implicit cursor lookup or register
  if (!cursorId) {
    // Look for an existing active subscription matching plugin + filter
    const existing = db.prepare(`
      SELECT s.subscription_id, c.cursor_id
      FROM subscriptions s
      JOIN cursors c ON c.subscription_id = s.subscription_id
      WHERE s.plugin = ? AND s.event_type_filter = ?
        AND s.role = 'subscriber'
        AND s.deregistered_at IS NULL
        AND c.deregistered_at IS NULL
    `).all(plugin, filter);

    if (existing.length === 1) {
      cursorId = existing[0].cursor_id;
    } else if (existing.length > 1) {
      throw new Error(
        'Multiple active subscriptions match plugin + filter. ' +
        'Provide --cursor-id to disambiguate.'
      );
    } else {
      // Auto-register
      const cursorInit = args['cursor-init'] || 'latest';
      const reg = register(db, { plugin, role: 'subscriber', filter, cursor_init: cursorInit });
      cursorId = reg.cursor_id;
    }
  }

  // Start background sweep
  const sweepHandle = startSweep(db, config);

  // Graceful shutdown
  let running = true;
  const shutdown = () => {
    running = false;
    if (sweepHandle) clearInterval(sweepHandle);
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Poll loop
  while (running) {
    try {
      const events = poll(db, cursorId, { batchSize });
      for (const event of events) {
        // Output NDJSON
        process.stdout.write(JSON.stringify(event) + '\n');

        // Auto-ack unless --no-ack
        if (!noAck) {
          ack(db, cursorId, event.event_id);
        }
      }
    } catch (err) {
      // Output error but continue polling if possible
      process.stderr.write(JSON.stringify({
        error: err.error || 'UNKNOWN',
        code: err.code || 'POLL_ERROR',
        message: err.message,
      }) + '\n');

      // Fatal errors: WB-003, WB-006
      if (err.error === 'WB-003' || err.error === 'WB-006') {
        if (sweepHandle) clearInterval(sweepHandle);
        db.close();
        throw err;
      }
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}
