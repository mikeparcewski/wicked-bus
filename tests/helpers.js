/**
 * Shared test helpers for wicked-bus tests.
 */

import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Create a temporary test directory for isolated DB testing.
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function createTempDir() {
  const dir = join(tmpdir(), 'wicked-bus-test-' + randomUUID());
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    },
  };
}

/**
 * Create a DB instance in a temp directory.
 * Sets WICKED_BUS_DATA_DIR to the temp dir.
 * @returns {{ db: import('better-sqlite3').Database, config: object, dir: string, cleanup: () => void }}
 */
export async function createTestDb() {
  const { dir, cleanup } = createTempDir();
  const oldEnv = process.env.WICKED_BUS_DATA_DIR;
  process.env.WICKED_BUS_DATA_DIR = dir;

  const { openDb } = await import('../lib/db.js');
  const { loadConfig, writeDefaultConfig } = await import('../lib/config.js');

  writeDefaultConfig(dir);
  const config = loadConfig();
  const db = openDb(config);

  return {
    db,
    config,
    dir,
    cleanup() {
      try { db.close(); } catch (_) { /* ignore */ }
      process.env.WICKED_BUS_DATA_DIR = oldEnv || '';
      if (!oldEnv) delete process.env.WICKED_BUS_DATA_DIR;
      cleanup();
    },
  };
}
