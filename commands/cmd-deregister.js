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
  // `--role` with no value (args.role === true) is a usage error — fail fast
  // rather than silently dropping the role restriction (or binding a boolean).
  if (args.role === true) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: '--role requires a value (subscriber|provider)',
      reason: 'invalid --role',
    });
  }
  const role = args.role != null ? args.role : null;

  // Validate args before touching the DB so a bad invocation fails fast.
  if (!subscriptionId && !plugin) {
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: '--subscription-id or --plugin is required',
      reason: 'missing --subscription-id / --plugin',
    });
  }
  if (role !== null && role !== 'subscriber' && role !== 'provider') {
    // Reject a typo'd role up front rather than letting it fall through to a
    // misleading WB-006 ("no active subscription") from the empty filter.
    throw new WBError('WB-001', 'INVALID_EVENT_SCHEMA', {
      message: `--role must be one of subscriber|provider, got: ${role}`,
      reason: 'invalid --role',
    });
  }

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  // --subscription-id targets one subscription; --plugin resets every active
  // subscription for a plugin in one command (recovery ergonomics: no `list`
  // to look up an id first). --subscription-id wins if both are supplied.
  let result;
  try {
    result = subscriptionId
      ? deregister(db, subscriptionId)
      : deregisterByPlugin(db, plugin, role ? { role } : {});
  } finally {
    db.close();
  }

  process.stdout.write(JSON.stringify(result) + '\n');
}
