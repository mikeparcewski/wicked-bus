/**
 * Schema registry — DESIGN-v2.md §6 (payload size cap + cas-auto offload)
 * and §10.2 (WB-009 schema mismatch).
 *
 * Two layers:
 *   1. Payload-size policy (`payload_max_bytes` + `payload_oversize` mode).
 *      Modes: 'warn' (default), 'cas-auto', 'strict'.
 *   2. JSON Schema validation (basic structural checks for now —
 *      type, required fields, enum, additionalProperties:false). Mirrors a
 *      tiny subset of JSON Schema draft-2020-12 sufficient for v2.0; full
 *      AJV / draft-2020 wiring lands in a follow-up. Modes: 'warn' (default),
 *      'strict'.
 *
 * Both layers are **disabled** when no `schemas` row exists for the
 * event_type. Producers without registered schemas behave exactly like v1.
 *
 * cas-auto integration: the registry returns a `transformed_payload` and
 * `payload_cas_sha` so emit() can store `{ "$cas": "<sha>" }` inline and
 * persist the offload pointer.
 *
 * @module lib/schema-registry
 */

import { WBError } from './errors.js';
import * as cas from './cas.js';

/**
 * Look up the latest registered schema for an event_type.
 * Returns null when no row exists.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} eventType
 * @returns {object|null}
 */
export function getSchema(db, eventType) {
  return db.prepare(
    `SELECT * FROM schemas
     WHERE event_type = ?
     ORDER BY version DESC
     LIMIT 1`,
  ).get(eventType) || null;
}

/**
 * Apply the registry's policy to an outgoing event before insert.
 *
 * Returns a result that emit() folds into the INSERT row:
 *   - `payload`        — possibly rewritten (cas-auto)
 *   - `payload_cas_sha`— set when cas-auto offload happened
 *   - `registry_schema_version` — the version row that matched
 *   - `warnings[]`     — observability items the caller may log
 *
 * Throws WBError on hard policy violations (strict mode).
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {string} args.dataDir            - for cas-auto offload
 * @param {string} args.eventType
 * @param {string} args.payloadStr         - already-stringified payload
 * @returns {{
 *   payload: string,
 *   payload_cas_sha: string|null,
 *   registry_schema_version: number|null,
 *   warnings: string[],
 * }}
 */
export function applyOnEmit({ db, dataDir, eventType, payloadStr }) {
  const schema = getSchema(db, eventType);
  if (!schema) {
    return {
      payload: payloadStr,
      payload_cas_sha: null,
      registry_schema_version: null,
      warnings: [],
    };
  }

  const warnings = [];
  let payload = payloadStr;
  let payloadCasSha = null;

  // 1) Size policy
  const size = Buffer.byteLength(payload, 'utf8');
  if (size > schema.payload_max_bytes) {
    switch (schema.payload_oversize) {
      case 'strict':
        throw new WBError('WB-008', 'PAYLOAD_TOO_LARGE', {
          message: `payload exceeds registry cap for ${eventType}`,
          event_type: eventType,
          size,
          payload_max_bytes: schema.payload_max_bytes,
          mode: 'strict',
        });
      case 'cas-auto': {
        if (!dataDir) {
          throw new WBError('WB-008', 'PAYLOAD_TOO_LARGE', {
            message: 'cas-auto requires dataDir to offload payload',
            event_type: eventType,
          });
        }
        payloadCasSha = cas.put(dataDir, payload);
        payload = JSON.stringify({ $cas: payloadCasSha });
        warnings.push(`payload offloaded to CAS: sha=${payloadCasSha}, original_size=${size}`);
        break;
      }
      case 'warn':
      default:
        warnings.push(
          `WB-008 (warn): ${eventType} payload size ${size} exceeds cap ${schema.payload_max_bytes}`,
        );
        break;
    }
  }

  // 2) JSON Schema validation. Schema is parsed lazily; if it can't be
  //    parsed we log a warning and skip — a corrupt registry row should
  //    never block emits.
  let parsed = null;
  try { parsed = JSON.parse(schema.json_schema); }
  catch (e) {
    warnings.push(`registry schema for ${eventType} is unparseable: ${e.message}`);
  }

  if (parsed) {
    let payloadObj = null;
    try { payloadObj = JSON.parse(payload); }
    catch (_e) {
      // payload may have been replaced by {$cas:...}; that's still valid JSON.
      // If we land here, the original payload was non-JSON and the producer
      // declared a JSON Schema — that's a hard mismatch.
      const violation = 'payload is not valid JSON';
      handleSchemaMismatch({
        eventType, parsed, payloadObj: null, violations: [violation], warnings,
      });
      return finalize({ payload, payloadCasSha, schema, warnings });
    }

    const violations = validateAgainst(parsed, payloadObj);
    if (violations.length > 0) {
      handleSchemaMismatch({ eventType, parsed, payloadObj, violations, warnings });
    }
  }

  return finalize({ payload, payloadCasSha, schema, warnings });
}

function finalize({ payload, payloadCasSha, schema, warnings }) {
  return {
    payload,
    payload_cas_sha: payloadCasSha,
    registry_schema_version: schema.version,
    warnings,
  };
}

function handleSchemaMismatch({ eventType, violations, warnings }) {
  // Mode is implicit: schema validation in this MVP is always 'warn' (the
  // schemas.payload_oversize column governs SIZE, not validation strictness).
  // A separate `validation_mode` column lands when we need 'strict' here.
  warnings.push(
    `WB-009 (warn): ${eventType} payload schema-mismatch — ${violations.join('; ')}`,
  );
}

// ---------------------------------------------------------------------------
// Tiny JSON Schema validator — sufficient subset for v2.0.
// Supports: type (string|number|integer|boolean|object|array|null),
//           required[], properties{}, additionalProperties:false,
//           enum[], minLength, maxLength, minimum, maximum, items.
// Returns an array of violation strings (empty = valid).
// ---------------------------------------------------------------------------

export function validateAgainst(schema, value) {
  const out = [];
  walk(schema, value, '', out);
  return out;
}

function walk(schema, value, path, out) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some(v => deepEqual(v, value))) {
      out.push(`${pathLabel(path)}: not in enum [${schema.enum.map(v => JSON.stringify(v)).join(', ')}]`);
    }
  }

  if (schema.type) {
    const t = jsonType(value);
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matched = allowed.some(a => typeMatches(a, t, value));
    if (!matched) {
      out.push(`${pathLabel(path)}: expected ${allowed.join('|')}, got ${t}`);
      return;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      out.push(`${pathLabel(path)}: minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      out.push(`${pathLabel(path)}: maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) {
      out.push(`${pathLabel(path)}: minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      out.push(`${pathLabel(path)}: maximum ${schema.maximum}`);
    }
  }

  if (schema.required && Array.isArray(schema.required) && jsonType(value) === 'object') {
    for (const key of schema.required) {
      if (!(key in value)) {
        out.push(`${pathLabel(path)}: missing required property '${key}'`);
      }
    }
  }

  if (schema.properties && jsonType(value) === 'object') {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in value) walk(sub, value[k], path === '' ? k : `${path}.${k}`, out);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of Object.keys(value)) {
        if (!allowed.has(k)) {
          out.push(`${pathLabel(path)}: additional property '${k}' not allowed`);
        }
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(schema.items, value[i], `${path === '' ? '' : path}[${i}]`, out);
    }
  }
}

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typeMatches(declared, actual, value) {
  if (declared === actual) return true;
  if (declared === 'integer' && actual === 'number' && Number.isInteger(value)) return true;
  return false;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function pathLabel(path) {
  return path === '' ? '<root>' : path;
}
