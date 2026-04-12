import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';

const require = createRequire(import.meta.url);

describe('concurrent access (WAL mode)', () => {
  let tmpDir, originalEnv;

  beforeEach(() => {
    originalEnv = process.env.WICKED_BUS_DATA_DIR;
    tmpDir = join(tmpdir(), 'wb-concurrent-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.WICKED_BUS_DATA_DIR = originalEnv;
    } else {
      delete process.env.WICKED_BUS_DATA_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('concurrent read and write do not conflict', () => {
    const config = loadConfig();
    const db1 = openDb(config);
    const db2 = openDb(config);

    // Write from db1
    emit(db1, config, {
      event_type: 'wicked.test.run.completed',
      domain: 'wicked-testing',
      payload: { test: true },
    });

    // Read from db2 simultaneously
    const count = db2.prepare('SELECT COUNT(*) as c FROM events').get().c;
    expect(count).toBe(1);

    db1.close();
    db2.close();
  });
});
