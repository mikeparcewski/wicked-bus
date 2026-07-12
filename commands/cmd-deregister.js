/**
 * wicked-bus deregister command.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { deregister, deregisterByPlugin } from '../lib/register.js';
import { WBError } from '../lib/errors.js';

export async function cmdDeregister(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const subscriptionId =
    args['subscription-id'] && args['subscription-id'] !== true
      ? args['subscription-id']
      : null;
  const plugin = args.plugin && args.plugin !== true ? args.plugin : null;
  // Guard `--role` with no value (args.role === true) so it isn't bound as a
  // boolean into the SQL query (which would throw a raw driver error).
  const role = args.role && args.role !== true ? args.role : null;

  // Validate args before touching the DB so a bad invocation fails fast.
  if (!subscriptionId && !plugin) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: '--subscription-id or --plugin is required',
      reason: 'missing --subscription-id / --plugin',
    });
  }

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  // --subscription-id targets one subscription; --plugin resets every active
  // subscription for a plugin in one command (recovery ergonomics: no `list`
  // to look up an id first). --subscription-id wins if both are supplied.
  const result = subscriptionId
    ? deregister(db, subscriptionId)
    : deregisterByPlugin(db, plugin, role ? { role } : {});
  db.close();

  process.stdout.write(JSON.stringify(result) + '\n');
}
