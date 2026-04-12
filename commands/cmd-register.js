/**
 * wicked-bus register command.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { register } from '../lib/register.js';

export async function cmdRegister(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  const opts = {
    plugin: args.plugin,
    role: args.role,
    filter: args.events || args.filter || '',
    schema_version: args['schema-version'] || undefined,
    cursor_init: args['cursor-init'] || 'latest',
  };

  const result = register(db, opts);
  db.close();

  process.stdout.write(JSON.stringify(result) + '\n');
}
