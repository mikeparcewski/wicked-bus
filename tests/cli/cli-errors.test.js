import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: error handling', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-errors-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('WB-001: validation error exits 1 with JSON stderr', () => {
    const result = run([
      'emit', '--type', 'bad', '--domain', 'x', '--payload', '{}',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error).toBe('WB-001');
    expect(err.code).toBe('INVALID_EVENT_SCHEMA');
    expect(err.message).toBeTruthy();
  });

  it('WB-005: schema version error exits 5', () => {
    const result = run([
      'emit', '--type', 'wicked.test.run.completed', '--domain', 'x',
      '--payload', '{}', '--schema-version', '2.0.0',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(5);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error).toBe('WB-005');
  });

  it('WB-006: ack with invalid cursor exits 6', () => {
    const result = run([
      'ack', '--cursor-id', 'nonexistent', '--last-event-id', '1',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(6);
    const err = JSON.parse(result.stderr.trim());
    expect(err.error).toBe('WB-006');
  });

  it('error format follows structured JSON envelope', () => {
    const result = run([
      'emit', '--type', 'bad', '--domain', 'x', '--payload', '{}',
    ], { dataDir: tmpDir });
    const err = JSON.parse(result.stderr.trim());
    expect(err).toHaveProperty('error');
    expect(err).toHaveProperty('code');
    expect(err).toHaveProperty('message');
    expect(err).toHaveProperty('context');
  });
});
