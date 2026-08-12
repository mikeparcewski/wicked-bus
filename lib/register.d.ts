/**
 * Type declarations for lib/register.js — provider/subscriber registration.
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/register.js — CI runs `npm run typecheck` so drift fails loudly.
 */

import type { SqliteDatabase } from './db.js';

export type RegisterRole = 'provider' | 'subscriber';

/** Cursor initialization for new subscribers. */
export type CursorInit = 'oldest' | 'latest';

export interface RegisterOptions {
  /** Plugin name (publisher or subscriber identity). */
  plugin: string;
  role: RegisterRole;
  /**
   * Event type filter (subscribers, e.g. `wicked.test.run.*@wicked-testing`)
   * or comma-separated provided event types (providers).
   */
  filter: string;
  /** Schema version announced by providers. */
  schema_version?: string | null;
  /** Cursor initialization for subscribers (default 'latest'). */
  cursor_init?: CursorInit;
}

export interface ProviderRegisterResult {
  subscription_id: string;
  plugin: string;
  role: 'provider';
  registered_at: number;
  filter: string;
}

export interface SubscriberRegisterResult {
  subscription_id: string;
  plugin: string;
  role: 'subscriber';
  registered_at: number;
  filter: string;
  cursor_id: string;
  cursor_init: CursorInit;
  last_event_id: number;
}

export type RegisterResult = ProviderRegisterResult | SubscriberRegisterResult;

/**
 * Register a provider or subscriber. Subscribers get a fresh cursor
 * (anchored per `cursor_init`); providers get a sidecar JSON file under
 * `<dataDir>/providers/`.
 */
export function register(
  db: SqliteDatabase,
  opts: RegisterOptions & { role: 'subscriber' },
): SubscriberRegisterResult;
export function register(
  db: SqliteDatabase,
  opts: RegisterOptions & { role: 'provider' },
): ProviderRegisterResult;
export function register(db: SqliteDatabase, opts: RegisterOptions): RegisterResult;

export interface DeregisterResult {
  deregistered: true;
  subscription_id: string;
  deregistered_at: number;
}

/**
 * Deregister a subscription (soft delete; subscriber cursors are soft-deleted
 * too, provider sidecars removed).
 *
 * @throws {import('./errors.js').WBError} WB-006 when the subscription does
 *         not exist.
 */
export function deregister(db: SqliteDatabase, subscriptionId: string): DeregisterResult;

export interface DeregisterByPluginResult {
  deregistered: true;
  plugin: string;
  subscription_ids: string[];
  count: number;
  deregistered_at: number;
}

/**
 * Deregister every active subscription for a plugin (soft delete), optionally
 * restricted to one role. Operator recovery ergonomics for wedged plugins.
 *
 * @throws {import('./errors.js').WBError} WB-001 (invalid plugin/role),
 *         WB-006 (no active subscription matched).
 */
export function deregisterByPlugin(
  db: SqliteDatabase,
  plugin: string,
  opts?: { role?: RegisterRole },
): DeregisterByPluginResult;
