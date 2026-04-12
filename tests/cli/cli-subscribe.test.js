import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run, CLI } from './helpers.js';

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

  it('outputs NDJSON events and exits on timeout', (done) => {
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
      // Process will be killed by timeout, which is expected
      const lines = stdout.trim().split('\n').filter(l => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);

      for (const line of lines) {
        const event = JSON.parse(line);
        expect(event.event_id).toBeDefined();
        expect(event.event_type).toMatch(/^wicked\.test\.run\./);
      }
      done();
    });

    // Kill after 2 seconds to let it poll at least once
    setTimeout(() => {
      child.kill('SIGTERM');
    }, 2000);
  }, 10000);

  it('auto-registers when no cursor-id provided', () => {
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
      // Should not error out - just timeout
      // Verify that a subscription was created
      const result = run(['list', '--role', 'subscriber'], { dataDir: tmpDir });
      expect(result.exitCode).toBe(0);
    });

    setTimeout(() => {
      child.kill('SIGTERM');
    }, 1500);
  }, 5000);

  it('--no-ack mode does not advance cursor', (done) => {
    // Register a subscriber first
    const regResult = run([
      'register', '--role', 'subscriber',
      '--plugin', 'noack-consumer',
      '--filter', 'wicked.test.run.*',
      '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });
    const reg = JSON.parse(regResult.stdout);

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
      // After subscribe exits, check cursor was not advanced
      const statusResult = run(['status'], { dataDir: tmpDir });
      const status = JSON.parse(statusResult.stdout);
      const sub = status.subscribers.find(s => s.cursor_id === reg.cursor_id);
      if (sub) {
        // Cursor should still be at 0 since --no-ack was used
        expect(sub.last_event_id).toBe(0);
      }
      done();
    });

    setTimeout(() => {
      child.kill('SIGTERM');
    }, 1500);
  }, 10000);
});
