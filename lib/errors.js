/**
 * wicked-bus error classes and error codes.
 * @module lib/errors
 */

export const ERROR_CODES = {
  'WB-001': 'INVALID_EVENT_SCHEMA',
  'WB-002': 'DUPLICATE_EVENT',
  'WB-003': 'CURSOR_BEHIND_TTL_WINDOW',
  'WB-004': 'DISK_FULL',
  'WB-005': 'SCHEMA_VERSION_UNSUPPORTED',
  'WB-006': 'CURSOR_NOT_FOUND',
};

export const EXIT_CODES = {
  'WB-001': 1,
  'WB-002': 2,
  'WB-003': 3,
  'WB-004': 4,
  'WB-005': 5,
  'WB-006': 6,
};

export class WBError extends Error {
  /**
   * @param {string} error - Error code, e.g. 'WB-001'
   * @param {string} code - Machine-readable name, e.g. 'INVALID_EVENT_SCHEMA'
   * @param {object} context - Additional context
   */
  constructor(error, code, context = {}) {
    super(context.message || code);
    this.error = error;
    this.code = code;
    this.context = context;
  }

  toJSON() {
    return {
      error: this.error,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}
