import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from './helpers.js';

describe('CLI: replay', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), 'wb-cli-replay-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    run(['init'], { dataDir: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('resets cursor position', () => {
    // Emit events
    run(['emit', '--type', 'wicked.test.run.completed', '--domain', 'x', '--payload', '{}'], { dataDir: tmpDir });
    run(['emit', '--type', 'wicked.test.run.started', '--domain', 'x', '--payload', '{}'], { dataDir: tmpDir });

    // Register subscriber
    const regResult = run([
      'register', '--role', 'subscriber', '--plugin', 'test',
      '--filter', 'wicked.test.run.*', '--cursor-init', 'latest',
    ], { dataDir: tmpDir });
    const { cursor_id } = JSON.parse(regResult.stdout.trim());

    // Replay from event 1
    const result = run([
      'replay', '--cursor-id', cursor_id, '--from-event-id', '1',
    ], { dataDir: tmpDir });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.replayed).toBe(true);
    expect(output.reset_to).toBe(0);
    expect(output.from_event_id).toBe(1);
  });
});
