/**
 * wicked-bus cleanup command -- sweep expired events.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import {
  runConfiguredSweep, collectOwedExpired, resolveUnackedPolicy, resolveRetentionCapDays, owedPairsWithCap, buildUnackedReport,
} from '../lib/sweep.js';
import { DEFAULT_BATCH_SIZE } from '../lib/sweep-v2.js';

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
  // --retention-days N (operator ruling 2026-10-10, #101); config: unacked_retention_days
  if (args['retention-days'] !== undefined && args['retention-days'] !== true) {
    config.unacked_retention_days = Number(args['retention-days']);
  }
  const policy = resolveUnackedPolicy(config);
  const capDays = resolveRetentionCapDays(config);

  const db = openDb(config);
  const dryRun = args['dry-run'] === true;

  if (dryRun) {
    const now = Date.now();
    // Same eligibility as the sweep: expired (`expires_at`), and under
    // 'retain' not owed to an active cursor. Read-only: the owed set lives in
    // a TEMP table, so nothing in bus.db is written.
    collectOwedExpired(db, now);
    const pairs = owedPairsWithCap(db, now, capDays);
    db.exec('DELETE FROM temp._wb_owed');
    const owed = new Set(pairs.map((p) => p.event_id)).size;
    const heldIds = policy === 'retain' ? new Set(pairs.filter((p) => !p.over_cap).map((p) => p.event_id)) : new Set();
    const expired = db.prepare('SELECT COUNT(*) as count FROM events WHERE expires_at < ?').get(now).count;
    const verb = policy === 'retain' ? 'retained' : policy === 'archive' || config.tiered_archive ? 'archived' : 'discarded';
    // The tiered sweep moves at most one batch per pass, oldest first (same
    // selection as lib/sweep-v2.js); an over-cap row past the batch is
    // `retention_cap_pending`. Bucket locks are only known at run time.
    let moved = null;
    if (config.tiered_archive) {
      const batch = config.sweep_batch_size ?? DEFAULT_BATCH_SIZE;
      moved = new Set(db.prepare('SELECT event_id FROM events WHERE expires_at < ? ORDER BY event_id ASC LIMIT ?')
        .all(now, batch + heldIds.size).map((r) => r.event_id).filter((id) => !heldIds.has(id)).slice(0, batch));
    }
    const fate = (p) => {
      if (!(policy === 'retain' && p.over_cap)) return { disposition: verb, reason: 'unacked_policy' };
      if (moved && !moved.has(p.event_id)) return { disposition: 'retained', reason: 'retention_cap_pending' };
      return { disposition: 'archived', reason: 'retention_cap' };
    };

    const result = {
      [config.tiered_archive ? 'events_moved' : 'events_deleted']: moved ? moved.size : expired - heldIds.size,
      unacked_policy: policy,
      unacked: buildUnackedReport(pairs, fate, { policy, capDays }),
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
