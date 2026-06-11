/**
 * wicked-bus subscribe command -- streaming NDJSON poll.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { poll, ack } from '../lib/poll.js';
import { register } from '../lib/register.js';
import { startSweep } from '../lib/sweep.js';
import { WBError } from '../lib/errors.js';

const SUBSCRIBE_USAGE = {
  usage: 'wicked-bus subscribe --plugin <name> [options]',
  description:
    'Stream events matching a filter as newline-delimited JSON (NDJSON) to stdout. ' +
    'Runs until SIGINT/SIGTERM.',
  required: {
    '--plugin <name>':
      'Subscriber identity. The durable cursor is keyed on (plugin, filter).',
  },
  options: {
    '--filter <pattern>':
      "Event type filter, e.g. 'wicked.test.run.*' or '*@wicked-testing'. Default: all events.",
    '--cursor-id <id>':
      'Resume an explicit cursor instead of resolving one by (plugin, filter).',
    '--cursor-init <oldest|latest>':
      'Where a NEWLY registered subscription starts. Default: latest.',
    '--poll-interval-ms <ms>': 'Poll cadence. Default: 1000.',
    '--batch-size <n>': 'Maximum events delivered per poll. Default: 100.',
    '--no-ack':
      'Do not advance the cursor after delivering. Events re-deliver on the next run.',
    '-h, --help': 'Show this help and exit.',
  },
};

/**
 * True when the user asked for help. `--help` is captured by the arg parser as
 * `args.help`; the short `-h` form is not a `--flag`, so it lands in positionals.
 */
function wantsHelp(args) {
  return args.help === true || (args._positional || []).includes('-h');
}

export async function cmdSubscribe(args, globals) {
  // Help and argument validation happen BEFORE any DB access so `--help`
  // never falls through to a confusing SQLite error, and a missing required
  // arg fails fast with a structured, non-zero-exit WBError.
  if (wantsHelp(args)) {
    process.stdout.write(JSON.stringify(SUBSCRIBE_USAGE, null, 2) + '\n');
    return;
  }

  const plugin = args.plugin;
  if (!plugin || plugin === true) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: '--plugin <name> is required (run `wicked-bus subscribe --help`)',
      reason: 'missing --plugin',
    });
  }

  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  // event_type_filter is NOT NULL; default an absent (or value-less) --filter
  // to the catch-all '*' so subscribe does not fall through to a DB error.
  const filter = typeof args.filter === 'string' ? args.filter : '*';
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
      throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
        message:
          'Multiple active subscriptions match plugin + filter. ' +
          'Provide --cursor-id to disambiguate.',
        reason: 'ambiguous subscription',
        plugin,
        filter,
      });
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
