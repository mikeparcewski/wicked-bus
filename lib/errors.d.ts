/**
 * Type declarations for lib/errors.js — WBError class, error codes, exit codes.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/errors.js — CI runs `npm run typecheck` so drift fails loudly.
 */

/** Structured wicked-bus error code (`WB-001` … `WB-013`). */
export type WBErrorCode =
  | 'WB-001'
  | 'WB-002'
  | 'WB-003'
  | 'WB-004'
  | 'WB-005'
  | 'WB-006'
  | 'WB-007'
  | 'WB-008'
  | 'WB-009'
  | 'WB-010'
  | 'WB-011'
  | 'WB-012'
  | 'WB-013';

/** Map of error code → machine-readable name. */
export const ERROR_CODES: {
  readonly 'WB-001': 'INVALID_EVENT_SCHEMA';
  readonly 'WB-002': 'DUPLICATE_EVENT';
  readonly 'WB-003': 'CURSOR_BEHIND_TTL_WINDOW';
  readonly 'WB-004': 'DISK_FULL';
  readonly 'WB-005': 'SCHEMA_VERSION_UNSUPPORTED';
  readonly 'WB-006': 'CURSOR_NOT_FOUND';
  readonly 'WB-007': 'LARGE_SCAN_REJECTED';
  readonly 'WB-008': 'PAYLOAD_TOO_LARGE';
  readonly 'WB-009': 'SCHEMA_MISMATCH';
  readonly 'WB-010': 'CAS_GC_INCOMPLETE_BUCKET_SET';
  readonly 'WB-011': 'UI_TOKEN_PERMISSION_MISMATCH';
  readonly 'WB-012': 'LIVE_TIER_BLOAT_WARNING';
  readonly 'WB-013': 'SPILL_BUCKET_UNAVAILABLE';
};

/** Machine-readable error name (`INVALID_EVENT_SCHEMA`, `DUPLICATE_EVENT`, …). */
export type WBErrorName = (typeof ERROR_CODES)[WBErrorCode];

/** Map of error code → CLI process exit code (WB-001 → 1, … WB-013 → 13). */
export const EXIT_CODES: { readonly [K in WBErrorCode]: number };

/**
 * Additional structured context attached to a WBError. `message` (when
 * present) becomes the Error message; the remaining keys are error-specific
 * diagnostics (`cursor_id`, `original_event_id`, `db_path`, …).
 */
export interface WBErrorContext {
  message?: string;
  [key: string]: unknown;
}

/**
 * Structured wicked-bus error. All errors thrown by the public API are
 * WBError instances; `error` is the `WB-xxx` code, `code` the machine name,
 * and `context` the structured diagnostics. `toJSON()` yields the CLI's
 * structured JSON error shape.
 */
export class WBError extends Error {
  constructor(error: WBErrorCode, code: WBErrorName, context?: WBErrorContext);
  error: WBErrorCode;
  code: WBErrorName;
  context: WBErrorContext;
  toJSON(): {
    error: WBErrorCode;
    code: WBErrorName;
    message: string;
    context: WBErrorContext;
  };
}
