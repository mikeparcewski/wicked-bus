/**
 * Type declarations for lib/db.js — SQLite connection manager.
 *
 * Hand-authored against the runtime module. Keep in lockstep with lib/db.js —
 * CI runs `npm run typecheck` against a consumer-shaped fixture, so drift
 * fails loudly.
 */

import type { BusConfig } from './config.js';

/**
 * Minimal structural view of a better-sqlite3 prepared statement — the subset
 * the bus's public functions rely on. A real better-sqlite3 Statement
 * satisfies this interface.
 */
export interface SqliteStatement {
  run(...params: any[]): unknown;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/**
 * Minimal structural view of a better-sqlite3 `Database` — the subset the
 * bus actually uses. Declared structurally so consumers are not forced to
 * install `@types/better-sqlite3`; a real better-sqlite3 Database instance
 * satisfies this interface.
 */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction(fn: (...args: any[]) => any): (...args: any[]) => any;
  close(): unknown;
  /** Absolute path of the open database file. */
  readonly name: string;
}

/**
 * Open (or create) the SQLite database, apply PRAGMAs (WAL, NORMAL sync,
 * foreign keys, busy timeout), execute the baseline schema DDL, and run any
 * pending migrations. Synchronous (better-sqlite3).
 *
 * @throws {import('./errors.js').WBError} WB-005 when the on-disk schema
 *         version is newer than this package supports.
 */
export function openDb(config?: Partial<BusConfig>): SqliteDatabase;
