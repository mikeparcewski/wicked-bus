#!/usr/bin/env node

/**
 * Postinstall script -- auto-create data directory on npm install.
 * Must not fail -- all errors are swallowed.
 */

import { ensureDataDir } from '../lib/paths.js';

try {
  ensureDataDir();
} catch (_) {
  // Swallow: postinstall must not fail npm install
}
