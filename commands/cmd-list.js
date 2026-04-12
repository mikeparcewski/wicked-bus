/**
 * wicked-bus list command.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';

export async function cmdList(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  let sql = 'SELECT * FROM subscriptions';
  const conditions = [];
  const params = {};

  if (args.role) {
    conditions.push('role = :role');
    params.role = args.role;
  }

  if (!args['include-deregistered']) {
    conditions.push('deregistered_at IS NULL');
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY registered_at DESC';

  const rows = db.prepare(sql).all(params);
  db.close();

  process.stdout.write(JSON.stringify(rows) + '\n');
}
