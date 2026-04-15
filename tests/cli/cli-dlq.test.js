import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';
import { openDb } from '../../lib/db.js';
import { writeDefaultConfig, loadConfig } from '../../lib/config.js';
import { register } from '../../lib/register.js';

describe('CLI: dlq', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-dlq-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  /**
   * Seed a single dead_letters row directly via the lib API. CLI-only seeding
   * isn't available because the only writer is the managed subscribe() loop.
   */
  function seedDlqRow({ plugin = 'wicked-brain', lastError = 'boom' } = {}) {
    const prevEnv = process.env.WICKED_BUS_DATA_DIR;
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    writeDefaultConfig(tmpDir);
    const db = openDb(loadConfig());
    try {
      const reg = register(db, {
        plugin,
        role: 'subscriber',
        filter: 'wicked.fact.extracted.*',
        cursor_init: 'oldest',
      });
      const result = db.prepare(`
        INSERT INTO dead_letters (
          cursor_id, subscription_id, event_id, event_type, domain, subdomain,
          payload, emitted_at, attempts, last_error, dead_lettered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reg.cursor_id, reg.subscription_id, 1,
        'wicked.fact.extracted.test', plugin, '',
        JSON.stringify({ k: 'v' }), Date.now(), 2, lastError, Date.now()
      );
      return { dlId: Number(result.lastInsertRowid), cursorId: reg.cursor_id };
    } finally {
      db.close();
      if (prevEnv) process.env.WICKED_BUS_DATA_DIR = prevEnv;
      else delete process.env.WICKED_BUS_DATA_DIR;
    }
  }

  describe('list', () => {
    it('returns empty array on a clean bus', () => {
      const result = run(['dlq', 'list'], { dataDir: tmpDir });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dead_letters).toEqual([]);
      expect(output.count).toBe(0);
    });

    it('returns seeded DLQ rows with parsed payload', () => {
      seedDlqRow();
      const result = run(['dlq', 'list'], { dataDir: tmpDir });
      const output = JSON.parse(result.stdout.trim());
      expect(output.count).toBe(1);
      expect(output.dead_letters[0].plugin).toBe('wicked-brain');
      expect(output.dead_letters[0].payload).toEqual({ k: 'v' });
    });

    it('--plugin filter narrows results', () => {
      seedDlqRow({ plugin: 'wicked-brain' });
      seedDlqRow({ plugin: 'wicked-crew' });
      const result = run(['dlq', 'list', '--plugin', 'wicked-brain'], { dataDir: tmpDir });
      const output = JSON.parse(result.stdout.trim());
      expect(output.count).toBe(1);
      expect(output.dead_letters[0].plugin).toBe('wicked-brain');
    });
  });

  describe('replay', () => {
    it('--dry-run reports what would be replayed without mutating state', () => {
      const { dlId } = seedDlqRow();
      const result = run(['dlq', 'replay', '--dl-id', String(dlId), '--dry-run'], { dataDir: tmpDir });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dry_run).toBe(true);
      expect(output.would_replay.dl_id).toBe(dlId);

      // Verify replay_requested_at is still null
      const list = JSON.parse(run(['dlq', 'list'], { dataDir: tmpDir }).stdout.trim());
      expect(list.dead_letters[0].replay_requested_at).toBeNull();
    });

    it('marks the DLQ row for replay', () => {
      const { dlId } = seedDlqRow();
      const result = run(['dlq', 'replay', '--dl-id', String(dlId)], { dataDir: tmpDir });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.replayed).toBe(true);

      const list = JSON.parse(run(['dlq', 'list'], { dataDir: tmpDir }).stdout.trim());
      expect(list.dead_letters[0].replay_requested_at).not.toBeNull();
    });

    it('exits non-zero when --dl-id is missing', () => {
      const result = run(['dlq', 'replay'], { dataDir: tmpDir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--dl-id');
    });

    it('exits with WB-006 exit code for missing dl_id', () => {
      const result = run(['dlq', 'replay', '--dl-id', '9999'], { dataDir: tmpDir });
      expect(result.exitCode).toBe(6);
    });
  });

  describe('drop', () => {
    it('removes the DLQ row', () => {
      const { dlId } = seedDlqRow();
      const result = run(['dlq', 'drop', '--dl-id', String(dlId)], { dataDir: tmpDir });
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.dropped).toBe(true);

      const list = JSON.parse(run(['dlq', 'list'], { dataDir: tmpDir }).stdout.trim());
      expect(list.count).toBe(0);
    });

    it('exits with WB-006 exit code for missing dl_id', () => {
      const result = run(['dlq', 'drop', '--dl-id', '9999'], { dataDir: tmpDir });
      expect(result.exitCode).toBe(6);
    });
  });

  describe('subcommand routing', () => {
    it('exits non-zero when no subcommand is given', () => {
      const result = run(['dlq'], { dataDir: tmpDir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('subcommand');
    });

    it('exits non-zero on unknown subcommand', () => {
      const result = run(['dlq', 'bogus'], { dataDir: tmpDir });
      expect(result.exitCode).not.toBe(0);
    });
  });
});
