/**
 * Type declarations for lib/causality.js — cross-process causality
 * propagation (AsyncLocalStorage + WICKED_BUS_* env vars).
 *
 * Hand-authored against the runtime module. Keep in lockstep with
 * lib/causality.js — CI runs `npm run typecheck` so drift fails loudly.
 */

/**
 * Causality context fields propagated onto every emit() inside a
 * withContext() frame (or inherited from the env vars in a spawned child).
 */
export interface CausalityContext {
  correlation_id?: string | null;
  session_id?: string | null;
  parent_event_id?: number | null;
  producer_id?: string | null;
}

/**
 * Run `fn` with the given context fields attached; emits inside the body
 * inherit the context and successive emits chain via parent_event_id.
 * Nested calls inherit-and-override per field. Returns `fn`'s result
 * (sync value or Promise — AsyncLocalStorage follows the async flow).
 */
export function withContext<T>(ctx: CausalityContext, fn: () => T): T;

/**
 * Read the active context: the AsyncLocalStorage frame if one exists,
 * otherwise the WICKED_BUS_* env vars; `{}` when nothing is set. The result
 * is a snapshot copy.
 */
export function currentContext(): CausalityContext;

/**
 * Set parent_event_id on the active frame so the next emit in the same
 * withContext() block chains to `eventId`. emit() calls this itself —
 * exported for advanced integrations.
 */
export function recordEmit(eventId: number): void;

/**
 * Build an env object for spawn()/exec() so a child process inherits the
 * active causality context: `spawn(cmd, args, { env: { ...process.env,
 * ...causalityEnv() } })`. Returns `{}` when no context is active.
 */
export function causalityEnv(): Record<string, string>;

/** The four env var names used for cross-process propagation. */
export const CAUSALITY_ENV_KEYS: {
  readonly correlation_id: 'WICKED_BUS_CORRELATION_ID';
  readonly session_id: 'WICKED_BUS_SESSION_ID';
  readonly parent_event_id: 'WICKED_BUS_PARENT_EVENT_ID';
  readonly producer_id: 'WICKED_BUS_PRODUCER_ID';
};
