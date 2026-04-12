import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: global flags', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-global-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('--db-path overrides database location', () => {
    const customDb = join(tmpDir, 'custom.db');
    const result = run([
      'init', '--db-path', customDb,
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
  });

  it('--payload @file reads from file', () => {
    const payloadFile = join(tmpDir, 'payload.json');
    writeFileSync(payloadFile, '{"runId":"r1","status":"passed"}');

    const result = run([
      'emit',
      '--type', 'wicked.test.run.completed',
      '--domain', 'wicked-testing',
      '--payload', `@${payloadFile}`,
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.event_id).toBe(1);
  });
});
