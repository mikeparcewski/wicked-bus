/**
 * wicked-bus dlq command — list, replay, drop dead-lettered events.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { listDeadLetters, replayDeadLetter, dropDeadLetter } from '../lib/dlq.js';
import { WBError } from '../lib/errors.js';

export async function cmdDlq(args, globals, positional = []) {
  const subcommand = positional[0];

  if (!subcommand) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: 'dlq requires a subcommand: list | replay | drop',
      reason: 'missing dlq subcommand',
    });
  }

  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  try {
    switch (subcommand) {
      case 'list': {
        const opts = {};
        if (args.plugin) opts.plugin = args.plugin;
        if (args['cursor-id']) opts.cursorId = args['cursor-id'];
        if (args.limit) opts.limit = parseInt(args.limit, 10);
        const rows = listDeadLetters(db, opts);
        process.stdout.write(JSON.stringify({ dead_letters: rows, count: rows.length }) + '\n');
        return;
      }

      case 'replay': {
        const dlId = parseDlId(args);
        if (args['dry-run']) {
          const row = db.prepare('SELECT * FROM dead_letters WHERE dl_id = ?').get(dlId);
          if (!row) {
            throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
              message: `Dead letter not found: ${dlId}`,
              dl_id: dlId,
              reason: 'dead letter row not found',
            });
          }
          process.stdout.write(JSON.stringify({
            dry_run: true,
            would_replay: {
              dl_id: row.dl_id,
              event_id: row.event_id,
              event_type: row.event_type,
              domain: row.domain,
              attempts: row.attempts,
              last_error: row.last_error,
            },
          }) + '\n');
          return;
        }
        const result = replayDeadLetter(db, dlId);
        process.stdout.write(JSON.stringify(result) + '\n');
        return;
      }

      case 'drop': {
        const dlId = parseDlId(args);
        const result = dropDeadLetter(db, dlId);
        process.stdout.write(JSON.stringify(result) + '\n');
        return;
      }

      default:
        throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
          message: `Unknown dlq subcommand: ${subcommand}`,
          reason: 'unknown dlq subcommand',
        });
    }
  } finally {
    db.close();
  }
}

function parseDlId(args) {
  const raw = args['dl-id'];
  if (raw == null || raw === true) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: '--dl-id <number> is required',
      reason: 'missing --dl-id',
    });
  }
  const dlId = parseInt(raw, 10);
  if (!Number.isInteger(dlId) || dlId <= 0) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: `--dl-id must be a positive integer, got: ${raw}`,
      reason: 'invalid --dl-id',
    });
  }
  return dlId;
}
