import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: deregister', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-dereg-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('deregisters a subscription', () => {
    // Register first
    const regResult = run([
      'register',
      '--role', 'subscriber',
      '--plugin', 'test-consumer',
      '--filter', 'wicked.test.*',
      '--cursor-init', 'oldest',
    ], { dataDir: tmpDir });
    const { subscription_id } = JSON.parse(regResult.stdout.trim());

    // Deregister
    const result = run([
      'deregister',
      '--subscription-id', subscription_id,
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.deregistered).toBe(true);
    expect(output.subscription_id).toBe(subscription_id);
  });
});
