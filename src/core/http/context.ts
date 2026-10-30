// The state one Jira call threads through its stages (D515).
//
// `jiraRequest` used to be one closure whose helpers shared its locals. The
// stages are module functions now, so what they shared is spelled out: the
// client's long-lived pieces ({@link ClientContext}), the call's fixed facts
// ({@link CallContext}) and the two flags the attempt in flight sets
// ({@link InFlight}). Nothing here does anything; it is only the shape.

import type {
  Clock,
  JiraApiRoot,
  JiraRequestSpec,
  JiraResponseHeaders,
  Logger,
  Redactor,
  Rng,
} from '../types.js';
import type { SemaphorePool } from '../http-util.js';
import type { Telemetry } from '../telemetry.js';
import type { JiraCredentials } from './credentials.js';
import type { FailureReason } from './decide.js';
import type { Fail } from './failures.js';

export interface AttemptFailure {
  readonly reason: FailureReason;
  readonly cause: unknown;
}

/**
 * What one turn of the retry loop got: a response, or the reason there is none.
 *
 * A discriminated union rather than two `let`s, because "exactly one of the two
 * is set" is an invariant the compiler can hold — the earlier shape needed a
 * runtime guard against a state (`neither`) that `runAttempt` cannot produce.
 */
export type AttemptOutcome =
  | { readonly kind: 'result'; readonly result: AttemptResult }
  | { readonly kind: 'failure'; readonly failure: AttemptFailure };

/**
 * Where one `fetch` goes and what it carries. Normally there is exactly one per
 * attempt (the Jira route); a binary GET that Jira answers with a 303 produces
 * a second, deliberately credential-free one for the media host.
 */
export interface HopTarget {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string | FormData;
}

/**
 * One attempt's response, body already consumed. The body is materialised
 * inside the attempt on purpose: after this object exists there is nothing left
 * to await, so the retry decisions cannot leak a half-read stream past
 * the timeout that was supposed to bound it.
 */
export interface AttemptResult {
  readonly status: number;
  readonly headers: JiraResponseHeaders;
  /** The body as text; empty for a binary read and for a drained one. */
  readonly text: string;
  /** Set only by a successful binary read. */
  readonly bytes?: Uint8Array;
}

/** What one client shares across every call it makes. */
export interface ClientContext {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly logger: Logger;
  readonly telemetry?: Telemetry;
  readonly redactor?: Redactor;
  readonly fail: Fail;
  /** Per-host queueing: the only state two concurrent calls share. */
  readonly pool: SemaphorePool;
  readonly concurrency: number;
  /** Consecutive transport/5xx failures per host, for `upstream_degraded`. */
  readonly consecutiveFailures: Map<string, number>;
}

/** What the attempt in flight has learned so far; reset at its start. */
export interface InFlight {
  /**
   * The status of the attempt in flight, once its headers arrived: a body that
   * fails after a 2xx is a write that landed, not one that may have.
   */
  answeredStatus: number | undefined;
  /** Set when the caller's cancel stopped an attempt before its fetch began. */
  cancelledUnsent: boolean;
}

/** One call: the client's pieces plus everything fixed before the first try. */
export interface CallContext extends ClientContext {
  readonly spec: JiraRequestSpec;
  readonly method: JiraRequestSpec['method'];
  readonly root: JiraApiRoot;
  /** The path template under its root: what every log line names. */
  readonly route: string;
  readonly creds: JiraCredentials;
  readonly host: string;
  readonly url: string;
  readonly startedAt: number;
  readonly budgetMs: number;
  readonly deadlineAt: number;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly replayable: boolean;
  readonly wantsBinary: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string | FormData | undefined;
  readonly inFlight: InFlight;
}
