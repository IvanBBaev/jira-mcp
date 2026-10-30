// `createJiraRequest`: the client the whole api ring calls (D515). This module
// builds the per-call context and runs the retry loop; every stage the loop
// drives lives in its own module beside this one.

import { JIRA_ROOT_PATHS, JiraError } from '../types.js';
import type {
  Clock,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  Logger,
  Redactor,
  Rng,
} from '../types.js';
import {
  DEFAULT_CALL_BUDGET_MS,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  assertHostAllowed,
  backoffMs,
  buildRequestUrl,
  createSemaphorePool,
  hostFromOrigin,
  isReplayable,
  parseRateLimit,
  shouldRetryStatus,
} from '../http-util.js';
import type { RateLimitInfo } from '../http-util.js';
import { UNKNOWN_ERROR_KIND } from '../telemetry.js';
import type { Telemetry } from '../telemetry.js';
import { runAttempt } from './attempt.js';
import { buildMultipart } from './body.js';
import { budgetExceeded, remaining, waitFor } from './budget.js';
import type {
  AttemptOutcome,
  AttemptResult,
  CallContext,
  ClientContext,
} from './context.js';
import { authorizationHeader } from './credentials.js';
import type { CredentialResolver, JiraCredentials } from './credentials.js';
import { classifyOutcome, decideNext, failureReasonOf } from './decide.js';
import type { AttemptFacts, ReplayPolicy } from './decide.js';
import { makeFail } from './failures.js';
import { armAttempt } from './guard.js';
import { noteFailure, noteSuccess } from './health.js';
import { acquireSlot } from './slots.js';
import {
  announceRateLimit,
  answeredFailure,
  lostFailure,
  successValue,
} from './verdict.js';

/**
 * Everything the client needs, passed explicitly — the shape mirrors the
 * relevant `Settings` fields but is NOT `Settings`: `core/http*` never
 * imports settings (CONFIGURATION.md).
 */
export interface JiraHttpOptions {
  /** Static credentials, or a resolver called once per request. */
  readonly credentials: JiraCredentials | CredentialResolver;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly logger: Logger;
  /** Applied to every error message, remediation and body snippet. */
  readonly redactor?: Redactor;
  /** `Settings.allowedHosts` — extra exact hosts or anchored `/^regex$/`. */
  readonly allowedHosts?: readonly string[];
  /** Default per-request timeout; `JiraRequestSpec.timeoutMs` overrides it. */
  readonly requestTimeoutMs?: number;
  /** Default call budget, used when the caller passes no shared `deadlineAt`. */
  readonly callBudgetMs?: number;
  /** Per-host semaphore slots. */
  readonly hostConcurrency?: number;
  /** Retries (not total tries) per request. */
  readonly retryAttempts?: number;
  /**
   * In-process counters (D12). Absent means "count nothing": the client works
   * exactly the same, so a test or a second client needs no counter set.
   */
  readonly telemetry?: Telemetry;
}

/** The defaults a call falls back to when its spec names none. */
interface ClientDefaults {
  readonly resolveCredentials: CredentialResolver;
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly budgetMs: number;
  readonly retries: number;
}

/**
 * Fix everything about one call that does not change between attempts: the
 * credentials (awaited — in oauth mode this is where a refresh happens, and it
 * happens before the host is read off the answer, because the refreshed
 * credentials may legitimately name a different host than the last call used),
 * the host policy, the URL, the budget and the payload.
 */
async function openCall(
  client: ClientContext,
  defaults: ClientDefaults,
  spec: JiraRequestSpec,
): Promise<CallContext> {
  const method = spec.method;
  const root = spec.root ?? 'v3';
  const route = `${JIRA_ROOT_PATHS[root]}${spec.pathTemplate ?? spec.path}`;
  const creds = await defaults.resolveCredentials(spec.profile);
  const host = hostFromOrigin(creds.host.origin);
  assertHostAllowed(host, defaults.allowedHosts, 'request host');

  const url = buildRequestUrl(creds.host, root, spec.path, spec.query);
  const startedAt = client.clock.now();
  const wantsBinary = spec.accept === 'binary';
  const headers: Record<string, string> = {
    // A binary read takes whatever Jira sends; only the JSON path may insist.
    accept: wantsBinary ? '*/*' : 'application/json',
    authorization: authorizationHeader(creds),
  };
  let payload: string | FormData | undefined;
  if (spec.multipart !== undefined) {
    payload = buildMultipart({ method, route, fail: client.fail, spec }, spec.multipart);
    // Jira refuses an upload without this XSRF opt-out (JIRA-API.md).
    headers['x-atlassian-token'] = 'no-check';
    // No content-type by hand: only `fetch` knows the boundary it generated,
    // and a boundary-less multipart header makes Jira answer 400.
  } else if (spec.body !== undefined) {
    payload = JSON.stringify(spec.body);
    headers['content-type'] = 'application/json';
  }

  return {
    ...client,
    spec,
    method,
    root,
    route,
    creds,
    host,
    url,
    startedAt,
    budgetMs: defaults.budgetMs,
    deadlineAt: spec.deadlineAt ?? startedAt + defaults.budgetMs,
    maxRetries: Math.max(0, spec.retryAttempts ?? defaults.retries),
    timeoutMs: spec.timeoutMs ?? defaults.timeoutMs,
    replayable: isReplayable(method, spec.safe),
    wantsBinary,
    headers,
    payload,
    inFlight: { answeredStatus: undefined, cancelledUnsent: false },
  };
}

/** One attempt with its slot and guard, settled into an outcome. */
async function attemptOnce(
  ctx: CallContext,
  attempt: number,
): Promise<{ readonly outcome: AttemptOutcome; readonly attemptTimeoutMs: number }> {
  if (remaining(ctx) <= 0) budgetExceeded(ctx);

  const release = await acquireSlot(ctx);
  // Measured AFTER the slot: a queued wait spends budget, and an attempt
  // timeout computed before it would let the attempt run past the deadline.
  const left = remaining(ctx);
  if (left <= 0) {
    release();
    budgetExceeded(ctx);
  }
  const attemptTimeoutMs = Math.min(ctx.timeoutMs, left);
  const guard = armAttempt(ctx.clock, attemptTimeoutMs, ctx.spec.signal);
  const attemptStartedAt = ctx.clock.now();
  // No initializer: the try assigns and so does every non-throwing path of
  // the catch, which is what proves there is no third state to guard.
  let outcome: AttemptOutcome;

  try {
    outcome = {
      kind: 'result',
      result: await runAttempt(ctx, guard, attempt, attemptStartedAt),
    };
  } catch (error) {
    if (error instanceof JiraError) throw error;
    outcome = {
      kind: 'failure',
      failure: { reason: failureReasonOf(error), cause: error },
    };
  } finally {
    // The slot and the timeout cover the whole attempt, body included, and
    // both end HERE — before any backoff wait, so a sleeping retry never
    // sits on a slot another call could be using.
    await guard.disarm();
    release();
  }
  return { outcome, attemptTimeoutMs };
}

/** An outcome, with the rate-limit headers riding along with a result. */
type Seen =
  | {
      readonly kind: 'failure';
      readonly failure: Extract<AttemptOutcome, { kind: 'failure' }>['failure'];
    }
  | {
      readonly kind: 'result';
      readonly result: AttemptResult;
      readonly limit: RateLimitInfo;
    };

/**
 * Reduce an outcome to the facts the pure policy reads. A response's
 * rate-limit headers are counted here, for every response, before any
 * decision is made.
 */
function factsOf(
  ctx: CallContext,
  outcome: AttemptOutcome,
): { seen: Seen; facts: AttemptFacts } {
  if (outcome.kind === 'failure') {
    const { reason } = outcome.failure;
    const answeredStatus = ctx.inFlight.answeredStatus;
    return {
      seen: outcome,
      facts:
        answeredStatus === undefined
          ? { kind: 'failure', reason }
          : { kind: 'failure', reason, answeredStatus },
    };
  }
  const { status, headers } = outcome.result;
  const limit = parseRateLimit(headers, ctx.clock.now());
  ctx.telemetry?.recordRateLimit({
    atMs: ctx.clock.now(),
    limited: status === 429,
    nearLimit: limit.nearLimit,
    ...(limit.reason === undefined ? {} : { reason: limit.reason }),
    ...(limit.resetAtMs === undefined ? {} : { resetAtMs: limit.resetAtMs }),
  });
  return {
    seen: { kind: 'result', result: outcome.result, limit },
    facts: {
      kind: 'response',
      status,
      quota: limit.quota,
      retryableStatus: shouldRetryStatus(status, ctx.method, ctx.spec.safe),
    },
  };
}

/** The retry loop: attempt, decide (pure), then act — health first. */
async function runCall<T>(ctx: CallContext): Promise<JiraResponse<T>> {
  const { method, route, logger, telemetry } = ctx;
  const policy: ReplayPolicy = { replayable: ctx.replayable };

  for (let attempt = 1; ; attempt += 1) {
    const { outcome, attemptTimeoutMs } = await attemptOnce(ctx, attempt);
    const { seen, facts } = factsOf(ctx, outcome);
    const classified = classifyOutcome(facts, policy);
    const decision = decideNext(
      classified,
      { attempt, maxRetries: ctx.maxRetries },
      policy,
    );

    if (decision.health === 'failure') noteFailure(ctx);
    if (decision.health === 'success') noteSuccess(ctx);
    const rateLimitWaitMs =
      seen.kind === 'result' && classified.kind === 'rate_limited'
        ? announceRateLimit(ctx, seen.result.headers, seen.limit, attempt)
        : 0;

    if (decision.kind === 'retry') {
      const delayMs =
        decision.reason === '429' ? rateLimitWaitMs : backoffMs(attempt, ctx.rng);
      logger.emit('http_retry', {
        method,
        pathTemplate: route,
        reason: decision.reason,
        attempt,
        delayMs,
      });
      telemetry?.recordRetry();
      // A 429 wait is a retry AND the throttling signal an operator asks
      // about, so it lands in both counters (OBSERVABILITY.md §Counters).
      if (decision.reason === '429') telemetry?.recordRateLimitWait();
      await waitFor(ctx, delayMs);
      continue;
    }
    if (seen.kind === 'failure') {
      // A lost response is never `done`: `decideNext` has no such arm.
      throw lostFailure(
        ctx,
        decision.kind === 'fail' ? decision.fail : 'transport',
        seen.failure,
        classified.kind === 'lost' ? classified.landed : undefined,
        attemptTimeoutMs,
      );
    }
    if (decision.kind === 'fail') {
      throw answeredFailure(ctx, decision.fail, seen.result, seen.limit);
    }
    return successValue<T>(ctx, seen.result);
  }
}

/**
 * Build the `JiraRequestFn` used by the whole api ring.
 *
 * The returned function is safe to call concurrently: per-host queueing is the
 * only shared state, and it lives in this closure.
 */
export function createJiraRequest(options: JiraHttpOptions): JiraRequestFn {
  const telemetry = options.telemetry;
  const concurrency = options.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY;
  const credentials = options.credentials;
  const client: ClientContext = {
    clock: options.clock,
    rng: options.rng,
    logger: options.logger,
    telemetry,
    redactor: options.redactor,
    fail: makeFail(options.redactor),
    pool: createSemaphorePool(concurrency),
    concurrency,
    consecutiveFailures: new Map<string, number>(),
  };
  const defaults: ClientDefaults = {
    resolveCredentials:
      typeof credentials === 'function'
        ? credentials
        : (): JiraCredentials => credentials,
    allowedHosts: options.allowedHosts ?? [],
    timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    budgetMs: options.callBudgetMs ?? DEFAULT_CALL_BUDGET_MS,
    retries: options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
  };

  const jiraRequest = async function jiraRequest<T = unknown>(
    spec: JiraRequestSpec,
  ): Promise<JiraResponse<T>> {
    const ctx = await openCall(client, defaults, spec);
    ctx.logger.emit('http_request', { method: ctx.method, pathTemplate: ctx.route });
    // One logical request, whatever it costs in attempts (D12).
    telemetry?.recordRequest();
    return await runCall<T>(ctx);
  };

  if (telemetry === undefined) return jiraRequest;

  // Errors are counted at the boundary rather than at each `fail()` site: this
  // is the one place that sees EVERY failure a request produced, including the
  // host-policy refusal raised before the loop, and it cannot double-count a
  // retry that was later recovered.
  return async <T = unknown>(spec: JiraRequestSpec): Promise<JiraResponse<T>> => {
    try {
      return await jiraRequest<T>(spec);
    } catch (error) {
      telemetry.recordError(error instanceof JiraError ? error.kind : UNKNOWN_ERROR_KIND);
      throw error;
    }
  };
}
