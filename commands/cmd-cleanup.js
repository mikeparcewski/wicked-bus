/**
 * wicked-bus cleanup command -- sweep expired events.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { runSweep } from '../lib/sweep.js';

export async function cmdCleanup(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);

  // --archive flag overrides config
  if (args.archive === true) {
    config.archive_mode = true;
  }

  const db = openDb(config);
  const dryRun = args['dry-run'] === true;

  if (dryRun) {
    const now = Date.now();
    const count = db.prepare(
      'SELECT COUNT(*) as count FROM events WHERE dedup_expires_at < ?'
    ).get(now);

    const result = {
      events_deleted: count.count,
      dry_run: true,
    };
    db.close();
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const result = runSweep(db, config);
  result.dry_run = false;

  db.close();
  process.stdout.write(JSON.stringify(result) + '\n');
}
