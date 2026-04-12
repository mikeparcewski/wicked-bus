import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: status', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-status-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('returns bus health JSON', () => {
    // Emit an event first
    run([
      'emit',
      '--type', 'wicked.test.run.completed',
      '--domain', 'wicked-testing',
      '--payload', '{}',
    ], { dataDir: tmpDir });

    const result = run(['status'], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.total_events).toBe(1);
    expect(output.oldest_event_id).toBe(1);
    expect(output.newest_event_id).toBe(1);
    expect(output.db_path).toBeTruthy();
  });
});
