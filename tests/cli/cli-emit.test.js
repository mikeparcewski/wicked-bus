import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: emit', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-emit-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('emits event and returns event_id + idempotency_key', () => {
    const result = run([
      'emit',
      '--type', 'wicked.test.run.completed',
      '--domain', 'wicked-testing',
      '--payload', '{"runId":"r1","status":"passed"}',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.event_id).toBe(1);
    expect(output.idempotency_key).toBeTruthy();
  });

  it('returns WB-001 for invalid event type', () => {
    const result = run([
      'emit',
      '--type', 'invalid',
      '--domain', 'x',
      '--payload', '{}',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error).toBe('WB-001');
  });

  it('returns WB-002 for duplicate idempotency_key', () => {
    const key = randomUUID();
    run([
      'emit',
      '--type', 'wicked.test.run.completed',
      '--domain', 'wicked-testing',
      '--payload', '{}',
      '--idempotency-key', key,
    ], { dataDir: tmpDir });

    const result = run([
      'emit',
      '--type', 'wicked.test.run.completed',
      '--domain', 'wicked-testing',
      '--payload', '{}',
      '--idempotency-key', key,
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(2);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error).toBe('WB-002');
  });
});
