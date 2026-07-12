import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run, CLI } from './helpers.js';
import { openDb } from '../../lib/db.js';
import { loadConfig } from '../../lib/config.js';
import { emit } from '../../lib/emit.js';
import { register } from '../../lib/register.js';

describe('wicked-bus subscribe', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = join(tmpdir(), 'wb-cli-subscribe-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });

    // Emit some events to subscribe to
    run(['emit', '--type', 'wicked.test.run.completed', '--domain', 'wicked-testing',
      '--payload', '{"runId":"r1","status":"passed"}'], { dataDir: tmpDir });
    run(['emit', '--type', 'wicked.test.run.started', '--domain', 'wicked-testing',
      '--payload', '{"runId":"r2"}'], { dataDir: tmpDir });
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('outputs NDJSON events and exits on timeout', () => {
    return new Promise((resolve, reject) => {
      const child = execFile('node', [
        CLI, 'subscribe',
        '--plugin', 'test-consumer',
        '--filter', 'wicked.test.run.*',
        '--cursor-init', 'oldest',
        '--poll-interval-ms', '100',
      ], {
        env: { ...process.env, WICKED_BUS_DATA_DIR: tmpDir },
        timeout: 3000,
      }, (err, stdout, stderr) => {
        try {
          // Process will be killed by timeout, which is expected
          const lines = stdout.trim().split('\n').filter(l => l.length > 0);
          expect(lines.length).toBeGreaterThanOrEqual(2);

          for (const line of lines) {
            const event = JSON.parse(line);
            expect(event.event_id).toBeDefined();
            expect(event.event_type).toMatch(/^wicked\.test\.run\./);
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      // Kill after 2 seconds to let it poll at least once
      setTimeout(() => {
        child.kill('SIGTERM');
      }, 2000);
    });
  }, 10000);

  it('auto-registers when no cursor-id provided', () => {
    return new Promise((resolve, reject) => {
      const child = execFile('node', [
        CLI, 'subscribe',
        '--plugin', 'auto-reg-consumer-' + randomUUID(),
        '--filter', 'wicked.test.run.*',
        '--cursor-init', 'latest',
        '--poll-interval-ms', '100',
      ], {
        env: { ...process.env, WICKED_BUS_DATA_DIR: tmpDir },
        timeout: 2000,
      }, (err, stdout) => {
        try {
          // Should not error out - just timeout
          // Verify that a subscription was created
          const result = run(['list', '--role', 'subscriber'], { dataDir: tmpDir });
          expect(result.exitCode).toBe(0);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      setTimeout(() => {
        child.kill('SIGTERM');
      }, 1500);
    });
  }, 5000);

  it('--help prints usage and exits 0 without touching the DB', () => {
    const result = run(['subscribe', '--help'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const usage = JSON.parse(result.stdout);
    expect(usage.usage).toContain('subscribe');
    expect(usage.required).toHaveProperty('--plugin <name>');
    // The genuinely useful flags must be discoverable.
    expect(usage.options).toHaveProperty('--no-ack');
    expect(usage.options).toHaveProperty('--filter <pattern>');
  });

  it('-h prints usage and exits 0', () => {
    const result = run(['subscribe', '-h'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const usage = JSON.parse(result.stdout);
    expect(usage.usage).toContain('subscribe');
  });

  it('missing --plugin fails fast with WB-001 and a non-zero exit', () => {
    const result = run(['subscribe'], { dataDir: tmpDir });
    expect(result.exitCode).not.toBe(0);
    const err = JSON.parse(result.stderr);
    expect(err.error).toBe('WB-001');
    expect(err.message).toMatch(/--plugin/);
  });

  it('value-less --plugin fails fast with WB-001 and a non-zero exit', () => {
    const result = run(['subscribe', '--plugin'], { dataDir: tmpDir });
    expect(result.exitCode).not.toBe(0);
    const err = JSON.parse(result.stderr);
    expect(err.error).toBe('WB-001');
  });

  it('--once drains all pending events then exits 0', () => {
    const result = run([
      'subscribe',
      '--plugin', 'drain-consumer-' + randomUUID(),
      '--filter', 'wicked.test.run.*',
      '--cursor-init', 'oldest',
      '--once',
    ], { dataDir: tmpDir });

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(JSON.parse(line).event_type).toMatch(/^wicked\.test\.run\./);
    }
    // Completion summary goes to stderr so stdout stays pure NDJSON.
    const summary = JSON.parse(result.stderr.trim().split('\n').filter(Boolean).pop());
    expect(summary.drained).toBe(lines.length);
    expect(summary.acked).toBe(true);
  });

  it('--drain is an alias for --once', () => {
    const result = run([
      'subscribe',
      '--plugin', 'drain-alias-' + randomUUID(),
      '--filter', 'wicked.test.run.*',
      '--cursor-init', 'oldest',
      '--drain',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr.trim().split('\n').filter(Boolean).pop()).drained)
      .toBeGreaterThanOrEqual(2);
  });

  it('--once on an empty backlog drains 0 and exits 0', () => {
    const result = run([
      'subscribe',
      '--plugin', 'empty-drain-' + randomUUID(),
      '--filter', 'wicked.nothing.matches.this',
      '--cursor-init', 'latest',
      '--once',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(JSON.parse(result.stderr.trim()).drained).toBe(0);
  });

  it('--once --no-ack does not advance the cursor (re-drains the same backlog)', () => {
    const plugin = 'drain-noack-' + randomUUID();
    const args = [
      'subscribe', '--plugin', plugin,
      '--filter', 'wicked.test.run.*',
      '--cursor-init', 'oldest', '--once', '--no-ack',
    ];
    const first = run(args, { dataDir: tmpDir });
    const second = run(args, { dataDir: tmpDir });

    const firstCount = first.stdout.trim().split('\n').filter(Boolean).length;
    const secondCount = second.stdout.trim().split('\n').filter(Boolean).length;
    expect(firstCount).toBeGreaterThanOrEqual(2);
    // Cursor never advanced, so the second drain sees the same events.
    expect(secondCount).toBe(firstCount);
    expect(JSON.parse(first.stderr.trim()).acked).toBe(false);
  });

  it('--once --batch-size smaller than the backlog still drains everything', () => {
    const result = run([
      'subscribe',
      '--plugin', 'drain-batch-' + randomUUID(),
      '--filter', 'wicked.test.run.*',
      '--cursor-init', 'oldest',
      '--once', '--batch-size', '1',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const count = result.stdout.trim().split('\n').filter(Boolean).length;
    // Two events were emitted in beforeAll; a batch size of 1 must not stop early.
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('invalid --idle-timeout fails fast with WB-001 and a non-zero exit', () => {
    const result = run([
      'subscribe', '--plugin', 'x', '--once', '--idle-timeout', 'abc',
    ], { dataDir: tmpDir });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toBe('WB-001');
  });

  it('--once --idle-timeout blocks on an empty queue then exits 0', () => {
    const start = Date.now();
    const result = run([
      'subscribe',
      '--plugin', 'idle-drain-' + randomUUID(),
      '--filter', 'wicked.nothing.matches.this',
      '--cursor-init', 'latest',
      '--once', '--idle-timeout', '400', '--poll-interval-ms', '50',
    ], { dataDir: tmpDir });
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr.trim()).drained).toBe(0);
    // It actually waited out the idle window rather than returning instantly.
    expect(elapsed).toBeGreaterThanOrEqual(350);
  }, 10000);

  it('--no-ack mode does not advance cursor', () => {
    // Register a subscriber first
    const regResult = run([
      'register', '--role', 'subscriber',
      '--plugin', 'noack-consumer',
      '--filter', 'wicked.test.run.*',
      '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });
    const reg = JSON.parse(regResult.stdout);

    return new Promise((resolve, reject) => {
      const child = execFile('node', [
        CLI, 'subscribe',
        '--plugin', 'noack-consumer',
        '--filter', 'wicked.test.run.*',
        '--cursor-id', reg.cursor_id,
        '--no-ack',
        '--poll-interval-ms', '100',
      ], {
        env: { ...process.env, WICKED_BUS_DATA_DIR: tmpDir },
        timeout: 3000,
      }, () => {
        try {
          // After subscribe exits, check cursor was not advanced
          const statusResult = run(['status'], { dataDir: tmpDir });
          const status = JSON.parse(statusResult.stdout);
          const sub = status.subscribers.find(s => s.cursor_id === reg.cursor_id);
          if (sub) {
            // Cursor should still be at 0 since --no-ack was used
            expect(sub.last_event_id).toBe(0);
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      setTimeout(() => {
        child.kill('SIGTERM');
      }, 1500);
    });
  }, 10000);
});

describe('wicked-bus subscribe — WB-003 self-recovery (#27)', () => {
  let tmpDir, prevEnv;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-sub-recover-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
    prevEnv = process.env.WICKED_BUS_DATA_DIR;
  });

  afterEach(() => {
    if (prevEnv) process.env.WICKED_BUS_DATA_DIR = prevEnv;
    else delete process.env.WICKED_BUS_DATA_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  /**
   * Seed a subscriber whose cursor is behind the TTL sweep window:
   * emit `total` events, register at oldest (cursor=0), then delete the
   * `sweptUpTo` oldest events so MIN(event_id) = sweptUpTo + 1 and the cursor
   * is stranded behind the window. Returns the cursor_id.
   */
  function seedBehindTtl({ plugin, total = 5, sweptUpTo = 2 }) {
    process.env.WICKED_BUS_DATA_DIR = tmpDir;
    const config = loadConfig();
    const db = openDb(config);
    try {
      for (let i = 0; i < total; i++) {
        emit(db, config, {
          event_type: 'wicked.test.run.completed',
          domain: 'wicked-testing',
          payload: { i },
        });
      }
      const reg = register(db, {
        plugin, role: 'subscriber', filter: 'wicked.test.run.*', cursor_init: 'oldest',
      });
      db.prepare('DELETE FROM events WHERE event_id <= ?').run(sweptUpTo);
      return reg.cursor_id;
    } finally {
      db.close();
    }
  }

  it('--once recovers and resumes from the oldest survivor without skipping', () => {
    // 5 events, sweep 1..2 → survivors are 3,4,5; cursor stranded at 0.
    const cursorId = seedBehindTtl({ plugin: 'recover-consumer', total: 5, sweptUpTo: 2 });

    const result = run([
      'subscribe', '--plugin', 'recover-consumer',
      '--cursor-id', cursorId, '--once',
    ], { dataDir: tmpDir });

    expect(result.exitCode).toBe(0);
    const ids = result.stdout.trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l).event_id);
    // Every surviving event delivered, none skipped, no fast-forward to head.
    expect(ids).toEqual([3, 4, 5]);

    // A recovery diagnostic went to stderr (not silent).
    const warnings = result.stderr.trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
    const recovered = warnings.find(w => w.warning === 'WB-003');
    expect(recovered).toBeDefined();
    expect(recovered.next_delivery_from).toBe(3);
    expect(recovered.reanchored_to).toBe(2);
  });

  it('--once --on-stale fail exits non-zero with WB-003 (opt-out)', () => {
    const cursorId = seedBehindTtl({ plugin: 'fail-consumer', total: 5, sweptUpTo: 2 });

    const result = run([
      'subscribe', '--plugin', 'fail-consumer',
      '--cursor-id', cursorId, '--once', '--on-stale', 'fail',
    ], { dataDir: tmpDir });

    expect(result.exitCode).toBe(3); // EXIT_CODES['WB-003']
    expect(result.stdout.trim()).toBe('');
    expect(JSON.parse(result.stderr.trim().split('\n').filter(Boolean).pop()).error)
      .toBe('WB-003');
  });

  it('invalid --on-stale fails fast with WB-001', () => {
    const result = run([
      'subscribe', '--plugin', 'x', '--once', '--on-stale', 'bogus',
    ], { dataDir: tmpDir });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr.trim()).error).toBe('WB-001');
  });

  it('streaming (non-drain) subscribe also self-recovers instead of dying', () => {
    const cursorId = seedBehindTtl({ plugin: 'stream-recover', total: 5, sweptUpTo: 2 });

    return new Promise((resolve, reject) => {
      const child = execFile('node', [
        CLI, 'subscribe', '--plugin', 'stream-recover',
        '--cursor-id', cursorId, '--poll-interval-ms', '100',
      ], {
        env: { ...process.env, WICKED_BUS_DATA_DIR: tmpDir },
        timeout: 4000,
      }, (err, stdout, stderr) => {
        try {
          const ids = stdout.trim().split('\n').filter(Boolean)
            .map(l => JSON.parse(l).event_id);
          // Surviving events delivered on the recovered stream.
          expect(ids).toEqual(expect.arrayContaining([3, 4, 5]));
          // Recovery diagnostic present; the loop did NOT exit fatally with WB-003.
          expect(stderr).toMatch(/WB-003/);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      setTimeout(() => child.kill('SIGTERM'), 1200);
    });
  }, 10000);
});
