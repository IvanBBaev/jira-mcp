// The retry policy of `jiraRequest`, as two pure functions (D515).
//
// The retry loop used to decide and act in the same breath: whether a timed-out
// POST was replayed was a branch between a logger call and a clock wait, so the
// canonical rule (JIRA-API.md §"Rate limiting and retries": an unsafe write is
// never replayed on an ambiguous failure) could only be tested end to end.
// Here the decision is data in, data out:
//
//   * `classifyOutcome` turns what one attempt got (a response status, or the
//     reason there is none) into an {@link Outcome};
//   * `decideNext` turns that outcome, the attempt number and the request's
//     replay policy into a {@link Decision}: retry, fail (and how), or done.
//
// Nothing here reads a clock, draws jitter, logs, counts or throws. The loop in
// `jira-request.ts` carries out the decision; how long a retry waits and the
// words of the error it raises stay there, because they need the clock, the rng
// and the response headers.

import { isRedirectStatus } from '../http-util.js';

/** Why an attempt produced no response. */
export type FailureReason = 'timeout' | 'transport' | 'aborted';

/** Name a thrown non-`JiraError` the way the retry policy needs it named. */
export function failureReasonOf(error: unknown): FailureReason {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  return 'transport';
}

/** `Response.ok`, decided from a status that has outlived its `Response`. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * What one attempt got, reduced to the facts the policy reads.
 *
 * `answeredStatus` on a failure is the status whose headers had arrived before
 * the body failed, if any: a body lost after a 2xx is a write that landed.
 */
export type AttemptFacts =
  | {
      readonly kind: 'failure';
      readonly reason: FailureReason;
      readonly answeredStatus?: number;
    }
  | {
      readonly kind: 'response';
      readonly status: number;
      /** The 429 is an hourly points quota (D127), not a burst limit. */
      readonly quota: boolean;
      /** `shouldRetryStatus(status, method, safe)` for this request. */
      readonly retryableStatus: boolean;
    };

/** The request's replay policy: GET, or a write explicitly marked `safe`. */
export interface ReplayPolicy {
  readonly replayable: boolean;
}

/**
 * One attempt, classified.
 *
 * - `cancelled`: the caller aborted and nothing is known to have landed.
 * - `lost`: no response (timeout, transport, or a cancel after a 2xx);
 *   `landed` is the 2xx status when an unsafe write was applied and only its
 *   reply was lost.
 * - `redirect`, `rate_limited`, `server_error`, `rejected`, `success`: a status.
 */
export type Outcome =
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'lost';
      readonly reason: FailureReason;
      readonly landed?: number;
    }
  | { readonly kind: 'redirect'; readonly status: number }
  | { readonly kind: 'rate_limited'; readonly quota: boolean }
  | {
      readonly kind: 'server_error';
      readonly status: number;
      readonly retryableStatus: boolean;
    }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'success'; readonly status: number };

/** Classify what one attempt got, under the request's replay policy. */
export function classifyOutcome(facts: AttemptFacts, policy: ReplayPolicy): Outcome {
  if (facts.kind === 'failure') {
    const answered = facts.answeredStatus;
    const landed =
      !policy.replayable && answered !== undefined && isSuccessStatus(answered)
        ? answered
        : undefined;
    if (facts.reason === 'aborted' && landed === undefined) return { kind: 'cancelled' };
    return landed === undefined
      ? { kind: 'lost', reason: facts.reason }
      : { kind: 'lost', reason: facts.reason, landed };
  }
  const status = facts.status;
  if (isRedirectStatus(status)) return { kind: 'redirect', status };
  if (status === 429) return { kind: 'rate_limited', quota: facts.quota };
  if (status >= 500) {
    return { kind: 'server_error', status, retryableStatus: facts.retryableStatus };
  }
  if (!isSuccessStatus(status)) return { kind: 'rejected', status };
  return { kind: 'success', status };
}

/** What the attempt says about the host's health (`upstream_degraded`). */
export type HostHealth = 'failure' | 'success' | 'unchanged';

/** Why a retry happens; the value is the `http_retry` event's `reason`. */
export type RetryReason = 'transport' | '429' | '5xx';

/**
 * Which error ends the call. The loop owns the words; the tag owns the choice.
 *
 * - `cancelled`: the caller's cancel, never retried.
 * - `applied_reply_lost`: an unsafe write Jira answered 2xx, whose body was lost.
 * - `ambiguous_write`: an unsafe write whose outcome is unknown.
 * - `timeout` / `transport`: a replayable request out of retries.
 * - `redirect`: a 3xx, never followed.
 * - `quota`: a 429 on a spent hourly quota, failed at once.
 * - `rate_limited`: a 429 out of retries.
 * - `status`: any other non-2xx, mapped by `describeStatus`.
 */
export type FailTag =
  | 'cancelled'
  | 'applied_reply_lost'
  | 'ambiguous_write'
  | 'timeout'
  | 'transport'
  | 'redirect'
  | 'quota'
  | 'rate_limited'
  | 'status';

export type Decision =
  | { readonly kind: 'retry'; readonly reason: RetryReason; readonly health: HostHealth }
  | { readonly kind: 'fail'; readonly fail: FailTag; readonly health: HostHealth }
  | { readonly kind: 'done'; readonly health: HostHealth };

/** Where the loop is: `attempt` counts from 1; `maxRetries` is retries, not tries. */
export interface AttemptState {
  readonly attempt: number;
  readonly maxRetries: number;
}

/**
 * Decide what the loop does next.
 *
 * The no-replay rule is visible in the shape: the only `retry` an unsafe write
 * can get is a 429, which Jira answers before applying anything. Every other
 * retry needs `policy.replayable`.
 *
 * `health` is applied before the decision is carried out, which is the order
 * the `upstream_degraded` event has always had relative to `http_retry`.
 */
export function decideNext(
  outcome: Outcome,
  state: AttemptState,
  policy: ReplayPolicy,
): Decision {
  const retriesLeft = state.attempt <= state.maxRetries;
  switch (outcome.kind) {
    case 'cancelled':
      return { kind: 'fail', fail: 'cancelled', health: 'unchanged' };
    case 'lost': {
      // A caller's cancel says nothing about the host's health.
      const health: HostHealth = outcome.reason === 'aborted' ? 'unchanged' : 'failure';
      if (policy.replayable && retriesLeft) {
        return { kind: 'retry', reason: 'transport', health };
      }
      if (outcome.landed !== undefined) {
        return { kind: 'fail', fail: 'applied_reply_lost', health };
      }
      if (!policy.replayable) return { kind: 'fail', fail: 'ambiguous_write', health };
      return {
        kind: 'fail',
        fail: outcome.reason === 'timeout' ? 'timeout' : 'transport',
        health,
      };
    }
    case 'redirect':
      return { kind: 'fail', fail: 'redirect', health: 'success' };
    case 'rate_limited':
      if (outcome.quota) return { kind: 'fail', fail: 'quota', health: 'unchanged' };
      return retriesLeft
        ? { kind: 'retry', reason: '429', health: 'unchanged' }
        : { kind: 'fail', fail: 'rate_limited', health: 'unchanged' };
    case 'server_error':
      // `retryableStatus` already says "replayable and 502/503/504"; the policy
      // is checked again so no caller can hand an unsafe write a 5xx replay.
      if (policy.replayable && outcome.retryableStatus && retriesLeft) {
        return { kind: 'retry', reason: '5xx', health: 'failure' };
      }
      return {
        kind: 'fail',
        fail: policy.replayable ? 'status' : 'ambiguous_write',
        health: 'failure',
      };
    case 'rejected':
      return { kind: 'fail', fail: 'status', health: 'success' };
    case 'success':
      return { kind: 'done', health: 'success' };
  }
}
