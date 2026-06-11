/**
 * CLI test helpers.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CLI = join(__dirname, '..', '..', 'commands', 'cli.js');

// spawnSync (vs execFileSync) so stderr is captured on the success path too —
// commands like `subscribe --once` write a completion summary to stderr while
// keeping stdout a pure NDJSON event stream.
export function run(args, opts = {}) {
  const env = {
    ...process.env,
    WICKED_BUS_DATA_DIR: opts.dataDir || process.env.WICKED_BUS_DATA_DIR,
    ...opts.env,
  };
  const result = spawnSync('node', [CLI, ...args], {
    env,
    encoding: 'utf8',
    timeout: opts.timeout || 10000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    // status is null when the process is terminated by a signal (e.g. timeout).
    exitCode: result.status,
  };
}
