/**
 * CLI test helpers.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CLI = join(__dirname, '..', '..', 'commands', 'cli.js');

export function run(args, opts = {}) {
  const env = {
    ...process.env,
    WICKED_BUS_DATA_DIR: opts.dataDir || process.env.WICKED_BUS_DATA_DIR,
    ...opts.env,
  };
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}
