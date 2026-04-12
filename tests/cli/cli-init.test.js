import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: init', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-init-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('creates data dir and DB, returns JSON', () => {
    const result = run(['init'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.initialized).toBe(true);
    expect(output.data_dir).toBe(tmpDir);
    expect(existsSync(join(tmpDir, 'bus.db'))).toBe(true);
    expect(existsSync(join(tmpDir, 'config.json'))).toBe(true);
  });

  it('is idempotent', () => {
    run(['init'], { dataDir: tmpDir });
    const result = run(['init'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
  });
});
