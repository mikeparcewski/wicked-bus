/**
 * wicked-bus init command.
 */

import { ensureDataDir, resolveDbPath } from '../lib/paths.js';
import { loadConfig, writeDefaultConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';

export async function cmdInit(args, globals) {
  const dataDir = ensureDataDir();
  const configOverrides = {};
  if (globals.db_path) configOverrides.db_path = globals.db_path;
  if (globals.log_level) configOverrides.log_level = globals.log_level;

  // Write default config (won't overwrite unless --force)
  writeDefaultConfig(dataDir, args.force === true);

  const config = loadConfig(configOverrides);
  const db = openDb(config);
  const dbPath = resolveDbPath(config);
  db.close();

  const result = {
    initialized: true,
    data_dir: dataDir,
    db_path: dbPath,
  };

  process.stdout.write(JSON.stringify(result) + '\n');
}
