/**
 * wicked-bus cleanup command -- sweep expired events.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { runConfiguredSweep, collectOwedExpired, resolveUnackedPolicy } from '../lib/sweep.js';

export async function cmdCleanup(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);

  // --archive flag overrides config
  if (args.archive === true) {
    config.archive_mode = true;
  }
  // --tiered: monthly warm-bucket tier (FND-BUS-02, #102); config: tiered_archive
  if (args.tiered === true) {
    config.tiered_archive = true;
  }
  // --unacked-policy retain|archive|discard (FND-BUS-01, #101); config: unacked_policy
  if (typeof args['unacked-policy'] === 'string') {
    config.unacked_policy = args['unacked-policy'];
  }
  const policy = resolveUnackedPolicy(config);

  const db = openDb(config);
  const dryRun = args['dry-run'] === true;

  if (dryRun) {
    const now = Date.now();
    // Same eligibility as the sweep: expired (`expires_at`), and under
    // 'retain' not owed to an active cursor. Read-only: the owed set lives in
    // a TEMP table, so nothing in bus.db is written.
    const owedByCursor = collectOwedExpired(db, now);
    const owed = db.prepare('SELECT COUNT(DISTINCT event_id) AS n FROM temp._wb_owed').get().n;
    const expired = db.prepare('SELECT COUNT(*) as count FROM events WHERE expires_at < ?').get(now).count;
    const verb = policy === 'retain' ? 'retained' : policy === 'archive' || config.tiered_archive ? 'archived' : 'discarded';

    const result = {
      [config.tiered_archive ? 'events_moved' : 'events_deleted']: policy === 'retain' ? expired - owed : expired,
      unacked_policy: policy,
      unacked: { [verb]: owed, cursors: owedByCursor.map((c) => ({ ...c, disposition: verb })) },
      dry_run: true,
    };
    db.close();
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const result = runConfiguredSweep(db, config);
  result.dry_run = false;

  db.close();
  process.stdout.write(JSON.stringify(result) + '\n');
}
