/**
 * wicked-bus ack command.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { ack } from '../lib/poll.js';

export async function cmdAck(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  const cursorId = args['cursor-id'];
  const lastEventId = Number(args['last-event-id']);

  if (!cursorId) {
    throw new Error('--cursor-id is required');
  }
  if (isNaN(lastEventId)) {
    throw new Error('--last-event-id must be a number');
  }

  const result = ack(db, cursorId, lastEventId);
  db.close();

  process.stdout.write(JSON.stringify(result) + '\n');
}
