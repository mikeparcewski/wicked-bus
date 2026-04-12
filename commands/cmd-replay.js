/**
 * wicked-bus replay command -- reset cursor to a specific event ID.
 */

import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { WBError } from '../lib/errors.js';

export async function cmdReplay(args, globals) {
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  const config = loadConfig(configOverrides);
  const db = openDb(config);

  const cursorId = args['cursor-id'];
  const fromEventId = Number(args['from-event-id']);

  if (!cursorId) {
    throw new Error('--cursor-id is required');
  }
  if (isNaN(fromEventId)) {
    throw new Error('--from-event-id must be a number');
  }

  // Verify cursor exists
  const cursor = db.prepare(
    'SELECT * FROM cursors WHERE cursor_id = ? AND deregistered_at IS NULL'
  ).get(cursorId);

  if (!cursor) {
    throw new WBError('WB-006', 'CURSOR_NOT_FOUND', {
      message: `Cursor not found: ${cursorId}`,
      cursor_id: cursorId,
      reason: 'cursor not found or deregistered',
    });
  }

  // Check that from_event_id is not below the oldest available event
  const oldest = db.prepare('SELECT MIN(event_id) as min_id FROM events').get();
  if (oldest && oldest.min_id != null && fromEventId < oldest.min_id) {
    throw new WBError('WB-003', 'CURSOR_BEHIND_TTL_WINDOW', {
      message: `from_event_id ${fromEventId} is below the oldest available event (${oldest.min_id})`,
      cursor_last_event_id: cursor.last_event_id,
      oldest_available_event_id: oldest.min_id,
    });
  }

  // Reset cursor to from_event_id - 1
  const resetTo = fromEventId - 1;
  db.prepare(
    'UPDATE cursors SET last_event_id = ? WHERE cursor_id = ?'
  ).run(resetTo, cursorId);

  const result = {
    replayed: true,
    cursor_id: cursorId,
    reset_to: resetTo,
    from_event_id: fromEventId,
  };

  db.close();
  process.stdout.write(JSON.stringify(result) + '\n');
}
