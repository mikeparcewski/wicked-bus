/**
 * SQLite-bus push daemon process for the bench. MEASUREMENT SPIKE ONLY.
 * argv: none. Requires WICKED_BUS_DATA_DIR (throwaway dir, set by run-all).
 * Prints READY once listening; runs until killed by the orchestrator.
 */

import { startDaemon } from '../../../lib/daemon.js';
import { resolveDataDir, ensureDataDir } from '../../../lib/paths.js';

if (!process.env.WICKED_BUS_DATA_DIR) {
  console.error('FATAL: WICKED_BUS_DATA_DIR not set — refusing to touch the real bus dir');
  process.exit(2);
}

ensureDataDir();
const handle = await startDaemon({ dataDir: resolveDataDir() });
console.log('READY');

process.on('SIGTERM', async () => {
  await handle.stop();
  process.exit(0);
});
