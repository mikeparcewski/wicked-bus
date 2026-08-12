/**
 * test/types/consumer.mts — consumer-shaped typecheck fixture.
 *
 * Imports EVERY symbol declared by the hand-authored lib/*.d.ts files the
 * way a downstream strict-TS consumer (wicked-crew, wicked-brain) would,
 * and exercises the key signatures. `npm run typecheck` compiles this with
 * `tsc --noEmit` under strict nodenext resolution; if the declarations drift
 * from the surface this file uses, CI fails loudly.
 *
 * Type-check only — nothing here is ever executed (all usage lives inside
 * never-invoked functions).
 */

// --- Root barrel: every runtime symbol lib/index.js re-exports ---
import {
  emit,
  poll,
  ack,
  matchesFilter,
  reanchorCursor,
  register,
  deregister,
  deregisterByPlugin,
  openDb,
  loadConfig,
  resolveDataDir,
  ensureDataDir,
  resolveDbPath,
  startSweep,
  runSweep,
  listDeadLetters,
  replayDeadLetter,
  dropDeadLetter,
  subscribe,
  WBError,
  ERROR_CODES,
  EXIT_CODES,
  subscribePushOrPoll,
  probeDaemon,
  connectAsSubscriber,
  notifyEmit,
  withContext,
  currentContext,
  getSchema,
  applyOnEmit,
  runSweepV2,
  pollResolve,
  cas,
} from 'wicked-bus';

// The CLI subpath is a side-effect-only bin script; this locks its typing so
// `import 'wicked-bus/cli'` never regresses to TS7016. Type-space only —
// consumer.mts is never executed, so the CLI never actually runs.
import 'wicked-bus/cli';

import type {
  // envelope + emission
  WickedEventType,
  EventPayload,
  EventInput,
  EmitResult,
  // polling
  EventRow,
  PollOptions,
  AckResult,
  ReanchorResult,
  // registration
  RegisterRole,
  CursorInit,
  RegisterOptions,
  ProviderRegisterResult,
  SubscriberRegisterResult,
  RegisterResult,
  DeregisterResult,
  DeregisterByPluginResult,
  // db / config
  SqliteDatabase,
  SqliteStatement,
  BusConfig,
  LogLevel,
  // sweeps
  SweepResult,
  SweepV2Config,
  SweepV2Result,
  WalCheckpointResult,
  LiveTierBloatWarning,
  // DLQ
  DeadLetterRow,
  ListDeadLettersOptions,
  ReplayDeadLetterResult,
  DropDeadLetterResult,
  // managed subscriber
  SubscribedEvent,
  SubscriberLag,
  SubscribeOptions,
  SubscribeHandle,
  // errors
  WBErrorCode,
  WBErrorName,
  WBErrorContext,
  // push-or-poll + daemon
  PushOrPollOptions,
  PushOrPollSubscriber,
  NotifyFrame,
  PushSubscriber,
  PushSubscriberEndState,
  ConnectAsSubscriberOptions,
  NotifyEmitResult,
  // causality
  CausalityContext,
  // schema registry
  SchemaRow,
  ApplyOnEmitArgs,
  ApplyOnEmitResult,
  // cross-tier query
  EventFieldFilter,
  PollResolveOptions,
  // CAS
  CasStats,
  CasGcOptions,
  CasGcResult,
} from 'wicked-bus';

// ---------------------------------------------------------------------------
// Never invoked — typecheck-only usage below.
// ---------------------------------------------------------------------------

declare function expectType<T>(value: T): void;

// --- Envelope: the 4-segment template-literal grammar --------------------
async function envelopeGrammar(): Promise<void> {
  const good: WickedEventType = 'wicked.crew.phase.completed';
  expectType<WickedEventType>(good);

  // @ts-expect-error — not a wicked.* type
  const badPrefix: WickedEventType = 'other.crew.phase.completed';
  // @ts-expect-error — too few segments for the canonical grammar
  const tooShort: WickedEventType = 'wicked.crew.phase';
  void badPrefix;
  void tooShort;
}

// --- Open, configure, emit ------------------------------------------------
function emitFlow(): void {
  const config: BusConfig = loadConfig({ log_level: 'warn' });
  expectType<LogLevel>(config.log_level);
  expectType<number>(config.ttl_hours);
  expectType<string | null>(config.db_path);

  const db: SqliteDatabase = openDb(config);
  const stmt: SqliteStatement = db.prepare('SELECT 1');
  void stmt;

  const payload: EventPayload = { run_id: 'r-1', ok: true };
  const input: EventInput = {
    event_type: 'wicked.crew.run.completed',
    domain: 'wicked-crew',
    subdomain: 'crew.phase',
    payload,
    metadata: { source: 'consumer.mts' },
    correlation_id: 'corr-1',
  };
  const result: EmitResult = emit(db, config, input);
  expectType<number>(result.event_id);
  expectType<string>(result.idempotency_key);

  // String payloads (pre-serialized JSON objects) are accepted too.
  emit(db, config, {
    event_type: 'wicked.crew.run.started',
    domain: 'wicked-crew',
    payload: '{"run_id":"r-1"}',
  });
}

// --- Paths -----------------------------------------------------------------
function pathsFlow(): void {
  expectType<string>(resolveDataDir());
  expectType<string>(ensureDataDir());
  expectType<string>(resolveDbPath({ db_path: '/tmp/bus.db' }));
}

// --- Register / poll / ack / reanchor --------------------------------------
function pollFlow(db: SqliteDatabase): void {
  const sub: SubscriberRegisterResult = register(db, {
    plugin: 'wicked-crew',
    role: 'subscriber',
    filter: 'wicked.test.run.*@wicked-testing',
    cursor_init: 'oldest',
  });
  expectType<string>(sub.cursor_id);
  expectType<number>(sub.last_event_id);

  const prov: ProviderRegisterResult = register(db, {
    plugin: 'wicked-crew',
    role: 'provider',
    filter: 'wicked.crew.run.completed,wicked.crew.run.failed',
  });
  expectType<string>(prov.filter);

  const anyRole: RegisterRole = 'subscriber';
  const opts: RegisterOptions = { plugin: 'p', role: anyRole, filter: '*' };
  const either: RegisterResult = register(db, opts);
  void either;

  const events: EventRow[] = poll(db, sub.cursor_id, { batchSize: 10 });
  for (const ev of events) {
    expectType<number>(ev.event_id);
    expectType<string>(ev.payload); // poll() does NOT parse payloads
    expectType<string | null>(ev.correlation_id);
    expectType<string | null>(ev.payload_cas_sha);
    const parsed: unknown = JSON.parse(ev.payload);
    void parsed;
  }

  const pollOpts: PollOptions = { batchSize: 5, afterEventId: 41 };
  void poll(db, sub.cursor_id, pollOpts);

  const acked: AckResult = ack(db, sub.cursor_id, 42);
  expectType<true>(acked.acked);

  const re: ReanchorResult = reanchorCursor(db, sub.cursor_id, 99);
  expectType<true>(re.reanchored);

  expectType<boolean>(matchesFilter('wicked.test.run.completed', 'wicked-testing', 'wicked.test.run.*'));

  const init: CursorInit = 'latest';
  void init;

  const dereg: DeregisterResult = deregister(db, sub.subscription_id);
  expectType<number>(dereg.deregistered_at);

  const deregAll: DeregisterByPluginResult = deregisterByPlugin(db, 'wicked-crew', {
    role: 'subscriber',
  });
  expectType<string[]>(deregAll.subscription_ids);
}

// --- Sweeps ------------------------------------------------------------------
function sweepFlow(db: SqliteDatabase, config: BusConfig): void {
  const r1: SweepResult = runSweep(db, config);
  expectType<number>(r1.events_deleted);

  const handle = startSweep(db, config);
  if (handle !== null) clearInterval(handle);

  const cfg: SweepV2Config = { sweep_batch_size: 1000, now: Date.now() };
  const r2: SweepV2Result = runSweepV2(db, cfg);
  expectType<number>(r2.events_moved);
  expectType<string[]>(r2.buckets_touched);
  const cp: WalCheckpointResult | null = r2.wal_checkpoint;
  if (cp) expectType<'PASSIVE' | 'RESTART'>(cp.mode);
  const bloat: LiveTierBloatWarning | null = r2.bloat_warning;
  if (bloat) expectType<'WB-012'>(bloat.error);
}

// --- DLQ: inspect / replay / drop -------------------------------------------
function dlqFlow(db: SqliteDatabase): void {
  const listOpts: ListDeadLettersOptions = { plugin: 'wicked-crew', limit: 20 };
  const rows: DeadLetterRow[] = listDeadLetters(db, listOpts);
  for (const row of rows) {
    expectType<number>(row.dl_id);
    expectType<unknown>(row.payload); // DLQ payloads ARE parsed
    expectType<number | null>(row.replay_requested_at);
    expectType<string | null>(row.plugin);
  }

  const replayed: ReplayDeadLetterResult = replayDeadLetter(db, 7);
  expectType<true>(replayed.replayed);

  const dropped: DropDeadLetterResult = dropDeadLetter(db, 7);
  expectType<true>(dropped.dropped);
}

// --- Managed subscriber (at-least-once) --------------------------------------
async function subscribeFlow(db: SqliteDatabase): Promise<void> {
  const options: SubscribeOptions = {
    db,
    plugin: 'wicked-crew',
    filter: 'wicked.test.run.**',
    handler: async (event: SubscribedEvent) => {
      expectType<string>(event.event_type);
      expectType<unknown>(event.payload);
      expectType<number | undefined>(event.expires_at);
    },
    maxRetries: 3,
    backoffMs: [1000, 5000, 30000],
    onError: (err: Error, event: SubscribedEvent | null) => {
      void err;
      void event;
    },
    onDeadLetter: (event: SubscribedEvent, reason: string) => {
      void event;
      void reason;
    },
    onLag: (lag: SubscriberLag) => {
      expectType<number>(lag.cursor_lag);
      expectType<number | null>(lag.oldest_unacked_age_ms);
      expectType<number>(lag.dlq_count);
    },
  };

  const handle: SubscribeHandle = subscribe(options);
  expectType<string>(handle.cursor_id);
  expectType<SubscriberLag>(handle.getLag());
  await handle.stop();
}

// --- Errors --------------------------------------------------------------------
function errorsFlow(err: unknown): void {
  if (err instanceof WBError) {
    expectType<WBErrorCode>(err.error);
    expectType<WBErrorName>(err.code);
    const ctx: WBErrorContext = err.context;
    void ctx;
    const json = err.toJSON();
    expectType<WBErrorCode>(json.error);
  }

  expectType<'CURSOR_BEHIND_TTL_WINDOW'>(ERROR_CODES['WB-003']);
  expectType<number>(EXIT_CODES['WB-006']);

  const thrown = new WBError('WB-001', 'INVALID_EVENT_SCHEMA', { message: 'nope' });
  void thrown;
}

// --- Push-or-poll subscriber (at-most-once) --------------------------------------
async function pushOrPollFlow(db: SqliteDatabase): Promise<void> {
  const opts: PushOrPollOptions = {
    db,
    cursor_id: 'cursor-1',
    dataDir: resolveDataDir(),
    filter: { domain: 'wicked-testing' },
    auto_recover: true,
  };
  const sub: PushOrPollSubscriber = await subscribePushOrPoll(opts);
  expectType<'push' | 'poll'>(sub.mode);
  expectType<number>(sub.transitionCount);
  for await (const event of sub) {
    expectType<EventRow>(event);
    break;
  }
  sub.close();
}

// --- Daemon client + notify ---------------------------------------------------
async function daemonFlow(db: SqliteDatabase): Promise<void> {
  const reachable: boolean = await probeDaemon(resolveDataDir(), 100);
  if (!reachable) return;

  const connOpts: ConnectAsSubscriberOptions = {
    dataDir: resolveDataDir(),
    subscriber_id: 'crew-acceptance',
    cursor: 0,
    filter: { event_type: 'wicked.test.run.completed' },
  };
  const pushSub: PushSubscriber = await connectAsSubscriber(connOpts);
  for await (const frame of pushSub) {
    expectType<NotifyFrame>(frame);
    expectType<number>(frame.event_id);
    const row: EventRow | null = frame.event;
    if (row === null) {
      // pointer-only notify: resolve via SELECT
      void db.prepare('SELECT * FROM events WHERE event_id = ?').get(frame.event_id);
    }
    pushSub.ack(frame.event_id);
    break;
  }
  const end: PushSubscriberEndState | null = pushSub.lastState;
  void end;
  expectType<boolean>(await pushSub.ping());
  pushSub.close();

  const notified: NotifyEmitResult = await notifyEmit(
    resolveDataDir(),
    {} as EventRow,
    { connect_timeout_ms: 50 },
  );
  expectType<boolean>(notified.delivered);
}

// --- Causality -----------------------------------------------------------------
async function causalityFlow(): Promise<void> {
  const ctx: CausalityContext = { correlation_id: 'corr-1', producer_id: 'crew' };
  const value: number = withContext(ctx, () => 42);
  expectType<number>(value);
  const p: Promise<string> = withContext(ctx, async () => 'done');
  await p;
  const active: CausalityContext = currentContext();
  expectType<string | null | undefined>(active.correlation_id);
}

// --- Schema registry --------------------------------------------------------------
function registryFlow(db: SqliteDatabase): void {
  const schema: SchemaRow | null = getSchema(db, 'wicked.test.run.completed');
  if (schema) {
    expectType<'warn' | 'cas-auto' | 'strict'>(schema.payload_oversize);
    expectType<'warm' | 'cold' | 'none'>(schema.archive_to);
  }

  const args: ApplyOnEmitArgs = {
    db,
    dataDir: resolveDataDir(),
    eventType: 'wicked.test.run.completed',
    payloadStr: '{"ok":true}',
  };
  const applied: ApplyOnEmitResult = applyOnEmit(args);
  expectType<string>(applied.payload);
  expectType<string | null>(applied.payload_cas_sha);
  expectType<string[]>(applied.warnings);
}

// --- Cross-tier query -------------------------------------------------------------
function queryFlow(db: SqliteDatabase): void {
  const filter: EventFieldFilter = { domain: 'wicked-testing' };
  const opts: PollResolveOptions = { lastEventId: 0, filter, batchSize: 50 };
  const rows: EventRow[] = pollResolve(db, '/data/archive', opts);
  void rows;
}

// --- CAS namespace -----------------------------------------------------------------
function casFlow(db: SqliteDatabase): void {
  const dataDir = resolveDataDir();
  expectType<string>(cas.casDir(dataDir));
  const sha: string = cas.put(dataDir, Buffer.from('{"big":true}'), { max_bytes: 1024 });
  const content: Buffer | null = cas.get(dataDir, sha);
  void content;
  expectType<boolean>(cas.exists(dataDir, sha));
  const s: CasStats = cas.stats(dataDir);
  expectType<number>(s.object_count);
  const gcOpts: CasGcOptions = { dataDir, liveDb: db, grace_days: 7, dry_run: true };
  const gcResult: CasGcResult = cas.gc(gcOpts);
  expectType<number>(gcResult.bytes_freed);
  expectType<number>(cas.DEFAULT_OBJECT_MAX_BYTES);
  expectType<number>(cas.DEFAULT_GC_GRACE_DAYS);
}

// Reference every never-invoked function so noUnusedLocals stays happy if
// it is ever enabled.
void envelopeGrammar;
void emitFlow;
void pathsFlow;
void pollFlow;
void sweepFlow;
void dlqFlow;
void subscribeFlow;
void errorsFlow;
void pushOrPollFlow;
void daemonFlow;
void causalityFlow;
void registryFlow;
void queryFlow;
void casFlow;
