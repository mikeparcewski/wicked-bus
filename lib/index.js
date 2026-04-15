/**
 * wicked-bus public API.
 * @module wicked-bus
 */

export { emit } from './emit.js';
export { poll, ack, matchesFilter } from './poll.js';
export { register, deregister } from './register.js';
export { openDb } from './db.js';
export { loadConfig } from './config.js';
export { resolveDataDir, ensureDataDir, resolveDbPath } from './paths.js';
export { startSweep, runSweep } from './sweep.js';
export { listDeadLetters } from './dlq.js';
export { WBError, ERROR_CODES, EXIT_CODES } from './errors.js';
