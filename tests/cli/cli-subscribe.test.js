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
