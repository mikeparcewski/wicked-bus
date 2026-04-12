import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: ack', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-ack-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('acks a cursor', () => {
    // Register subscriber
    const regResult = run([
      'register',
      '--role', 'subscriber',
      '--plugin', 'test-consumer',
      '--filter', 'wicked.test.*',
      '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });
    const { cursor_id } = JSON.parse(regResult.stdout.trim());

    // Ack
    const result = run([
      'ack',
      '--cursor-id', cursor_id,
      '--last-event-id', '5',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.acked).toBe(true);
    expect(output.last_event_id).toBe(5);
  });

  it('returns WB-006 for invalid cursor', () => {
    const result = run([
      'ack',
      '--cursor-id', 'nonexistent',
      '--last-event-id', '5',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(6);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error).toBe('WB-006');
  });
});
