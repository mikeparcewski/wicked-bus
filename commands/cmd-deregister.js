/**
 * wicked-bus deregister command.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { deregister } from '../lib/register.js';

export async function cmdDeregister(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  const subscriptionId = args['subscription-id'];
  if (!subscriptionId) {
    throw new Error('--subscription-id is required');
  }

  const result = deregister(db, subscriptionId);
  db.close();

  process.stdout.write(JSON.stringify(result) + '\n');
}
