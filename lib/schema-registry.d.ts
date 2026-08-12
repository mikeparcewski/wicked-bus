/**
 * Type declarations for lib/schema-registry.js — JSON Schema registry
 * (payload size policy + structural validation at emit time).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/schema-registry.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

/** A row of the `schemas` registry table. */
export interface SchemaRow {
  event_type: string;
  version: number;
  /** JSON Schema document as stored JSON text. */
  json_schema: string;
  retention: 'default' | 'forever' | 'short';
  payload_max_bytes: number;
  archive_to: 'warm' | 'cold' | 'none';
  /** Oversize policy: warn (default), offload to CAS, or reject with WB-008. */
  payload_oversize: 'warn' | 'cas-auto' | 'strict';
  deprecated_at: number | null;
  sunset_at: number | null;
}

/**
 * Look up the latest registered schema for an event_type, or null when no
 * row exists (in which case emit-side policy is entirely disabled).
 */
export function getSchema(db: SqliteDatabase, eventType: string): SchemaRow | null;

export interface ApplyOnEmitArgs {
  db: SqliteDatabase;
  /** Data dir — required for cas-auto offload. */
  dataDir: string;
  eventType: string;
  /** Already-stringified payload. */
  payloadStr: string;
}

export interface ApplyOnEmitResult {
  /** Possibly rewritten payload (`{"$cas":"<sha>"}` after cas-auto offload). */
  payload: string;
  /** Set when cas-auto offload happened. */
  payload_cas_sha: string | null;
  /** The registry schema version that matched, or null when none did. */
  registry_schema_version: number | null;
  /** Observability items (WB-008/WB-009 warn-mode findings) the caller may log. */
  warnings: string[];
}

/**
 * Apply the registry's policy to an outgoing event before insert. No-op
 * pass-through when no schema row matches the event_type.
 *
 * @throws {import('./errors.js').WBError} WB-008 in strict oversize mode
 *         (or when cas-auto has no dataDir).
 */
export function applyOnEmit(args: ApplyOnEmitArgs): ApplyOnEmitResult;

/**
 * Validate a value against the supported JSON Schema subset (type, required,
 * properties, additionalProperties:false, enum, min/maxLength, minimum/
 * maximum, items). Returns violation strings; empty array = valid.
 */
export function validateAgainst(schema: unknown, value: unknown): string[];
