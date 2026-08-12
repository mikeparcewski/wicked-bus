/**
 * Type declarations for lib/index.cjs — the CJS shim.
 *
 * The shim is a Proxy that forwards property access to the ESM module once
 * it has loaded asynchronously; a synchronous `require('wicked-bus')` access
 * BEFORE the microtask that loads the ESM module completes throws. The
 * supported usage from CJS is dynamic import:
 *
 *     const bus = await import('wicked-bus');
 *
 * The value surface is identical to the ESM entry; the namespace merge below
 * re-exports the type surface so `import type { EventRow } from 'wicked-bus'`
 * also works from CommonJS TypeScript.
 */

import type * as wickedBus from './index.js';

declare const shim: typeof wickedBus;

declare namespace shim {
  // envelope + emission
  export type WickedEventType = wickedBus.WickedEventType;
  export type EventPayload = wickedBus.EventPayload;
  export type EventInput = wickedBus.EventInput;
  export type EmitResult = wickedBus.EmitResult;
  // polling
  export type EventRow = wickedBus.EventRow;
  export type PollOptions = wickedBus.PollOptions;
  export type AckResult = wickedBus.AckResult;
  export type ReanchorResult = wickedBus.ReanchorResult;
  // registration
  export type RegisterRole = wickedBus.RegisterRole;
  export type CursorInit = wickedBus.CursorInit;
  export type RegisterOptions = wickedBus.RegisterOptions;
  export type ProviderRegisterResult = wickedBus.ProviderRegisterResult;
  export type SubscriberRegisterResult = wickedBus.SubscriberRegisterResult;
  export type RegisterResult = wickedBus.RegisterResult;
  export type DeregisterResult = wickedBus.DeregisterResult;
  export type DeregisterByPluginResult = wickedBus.DeregisterByPluginResult;
  // db / config
  export type SqliteDatabase = wickedBus.SqliteDatabase;
  export type SqliteStatement = wickedBus.SqliteStatement;
  export type BusConfig = wickedBus.BusConfig;
  export type LogLevel = wickedBus.LogLevel;
  // sweeps
  export type SweepResult = wickedBus.SweepResult;
  export type SweepV2Config = wickedBus.SweepV2Config;
  export type SweepV2Result = wickedBus.SweepV2Result;
  export type WalCheckpointResult = wickedBus.WalCheckpointResult;
  export type LiveTierBloatWarning = wickedBus.LiveTierBloatWarning;
  // DLQ
  export type DeadLetterRow = wickedBus.DeadLetterRow;
  export type ListDeadLettersOptions = wickedBus.ListDeadLettersOptions;
  export type ReplayDeadLetterResult = wickedBus.ReplayDeadLetterResult;
  export type DropDeadLetterResult = wickedBus.DropDeadLetterResult;
  // managed subscriber
  export type SubscribedEvent = wickedBus.SubscribedEvent;
  export type SubscriberLag = wickedBus.SubscriberLag;
  export type SubscribeOptions = wickedBus.SubscribeOptions;
  export type SubscribeHandle = wickedBus.SubscribeHandle;
  // errors
  export type WBErrorCode = wickedBus.WBErrorCode;
  export type WBErrorName = wickedBus.WBErrorName;
  export type WBErrorContext = wickedBus.WBErrorContext;
  // push-or-poll + daemon
  export type PushOrPollOptions = wickedBus.PushOrPollOptions;
  export type PushOrPollSubscriber = wickedBus.PushOrPollSubscriber;
  export type NotifyFrame = wickedBus.NotifyFrame;
  export type PushSubscriber = wickedBus.PushSubscriber;
  export type PushSubscriberEndState = wickedBus.PushSubscriberEndState;
  export type ConnectAsSubscriberOptions = wickedBus.ConnectAsSubscriberOptions;
  export type NotifyEmitResult = wickedBus.NotifyEmitResult;
  // causality
  export type CausalityContext = wickedBus.CausalityContext;
  // schema registry
  export type SchemaRow = wickedBus.SchemaRow;
  export type ApplyOnEmitArgs = wickedBus.ApplyOnEmitArgs;
  export type ApplyOnEmitResult = wickedBus.ApplyOnEmitResult;
  // cross-tier query
  export type EventFieldFilter = wickedBus.EventFieldFilter;
  export type PollResolveOptions = wickedBus.PollResolveOptions;
  // CAS
  export type CasStats = wickedBus.CasStats;
  export type CasGcOptions = wickedBus.CasGcOptions;
  export type CasGcResult = wickedBus.CasGcResult;
}

export = shim;
