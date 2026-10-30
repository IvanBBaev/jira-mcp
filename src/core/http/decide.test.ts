// Table tests for the pure retry policy (D515). The wire tests in
// `core/http.test.ts` prove the loop carries the decisions out; these prove the
// decisions themselves, for every outcome × method-safety × attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isReplayable, shouldRetryStatus } from '../http-util.js';
import type { HttpMethod } from '../types.js';
import { classifyOutcome, decideNext, failureReasonOf } from './decide.js';
import type { AttemptFacts, Decision, FailureReason } from './decide.js';

interface Request {
  readonly label: string;
  readonly method: HttpMethod;
  readonly safe?: boolean;
}

const REQUESTS: readonly Request[] = [
  { label: 'GET', method: 'GET' },
  { label: 'POST', method: 'POST' },
  { label: 'POST safe', method: 'POST', safe: true },
  { label: 'PUT', method: 'PUT' },
  { label: 'DELETE', method: 'DELETE' },
];

const MAX_RETRIES = 3;
/** First try, last retry, out of retries. */
const ATTEMPTS = [1, MAX_RETRIES, MAX_RETRIES + 1] as const;

const REASONS: readonly FailureReason[] = ['timeout', 'transport', 'aborted'];
const ANSWERED: readonly (number | undefined)[] = [undefined, 201, 502];
const STATUSES = [200, 204, 301, 303, 400, 401, 404, 409, 429, 500, 502, 503, 504];

interface Case {
  readonly request: Request;
  readonly attempt: number;
  readonly facts: AttemptFacts;
}

function factsFor(request: Request, status: number, quota = false): AttemptFacts {
  return {
    kind: 'response',
    status,
    quota,
    retryableStatus: shouldRetryStatus(status, request.method, request.safe),
  };
}

function allCases(): Case[] {
  const cases: Case[] = [];
  for (const request of REQUESTS) {
    for (const attempt of ATTEMPTS) {
      for (const reason of REASONS) {
        for (const answeredStatus of ANSWERED) {
          cases.push({
            request,
            attempt,
            facts:
              answeredStatus === undefined
                ? { kind: 'failure', reason }
                : { kind: 'failure', reason, answeredStatus },
          });
        }
      }
      for (const status of STATUSES) {
        cases.push({ request, attempt, facts: factsFor(request, status) });
      }
      cases.push({ request, attempt, facts: factsFor(request, 429, true) });
    }
  }
  return cases;
}

function decide(request: Request, attempt: number, facts: AttemptFacts): Decision {
  const policy = { replayable: isReplayable(request.method, request.safe) };
  return decideNext(
    classifyOutcome(facts, policy),
    { attempt, maxRetries: MAX_RETRIES },
    policy,
  );
}

function describeCase(c: Case): string {
  const what =
    c.facts.kind === 'failure'
      ? `${c.facts.reason}${c.facts.answeredStatus === undefined ? '' : ` after ${String(c.facts.answeredStatus)}`}`
      : `${String(c.facts.status)}${c.facts.quota ? ' quota' : ''}`;
  return `${c.request.label} attempt ${String(c.attempt)} ${what}`;
}

test('[D515] an unsafe write is never retried except on a 429, whatever the attempt', () => {
  for (const c of allCases()) {
    if (isReplayable(c.request.method, c.request.safe)) continue;
    const decision = decide(c.request, c.attempt, c.facts);
    if (decision.kind !== 'retry') continue;
    assert.equal(decision.reason, '429', describeCase(c));
    assert.ok(c.facts.kind === 'response' && c.facts.status === 429, describeCase(c));
  }
});

test('[D515] POST + an ambiguous failure fails as a write, never as a retryable error', () => {
  const ambiguous = new Set(['ambiguous_write', 'applied_reply_lost', 'cancelled']);
  for (const c of allCases()) {
    if (isReplayable(c.request.method, c.request.safe)) continue;
    const isLost = c.facts.kind === 'failure';
    const is5xx = c.facts.kind === 'response' && c.facts.status >= 500;
    if (!isLost && !is5xx) continue;
    const decision = decide(c.request, c.attempt, c.facts);
    assert.equal(decision.kind, 'fail', describeCase(c));
    assert.ok(decision.kind === 'fail' && ambiguous.has(decision.fail), describeCase(c));
  }
});

test('[D515] no retry once the retries are spent, and none on a quota 429 or a cancel', () => {
  for (const c of allCases()) {
    const decision = decide(c.request, c.attempt, c.facts);
    if (c.attempt > MAX_RETRIES) assert.notEqual(decision.kind, 'retry', describeCase(c));
    if (c.facts.kind === 'response' && c.facts.quota) {
      assert.deepEqual(
        decision,
        { kind: 'fail', fail: 'quota', health: 'unchanged' },
        describeCase(c),
      );
    }
    if (c.facts.kind === 'failure' && c.facts.reason === 'aborted') {
      assert.notEqual(decision.kind, 'retry', describeCase(c));
      assert.equal(decision.health, 'unchanged', describeCase(c));
    }
  }
});

test('[D515] every response status decides health the way upstream_degraded counts it', () => {
  for (const c of allCases()) {
    if (c.facts.kind !== 'response') continue;
    const { health } = decide(c.request, c.attempt, c.facts);
    const status = c.facts.status;
    const expected = status === 429 ? 'unchanged' : status >= 500 ? 'failure' : 'success';
    assert.equal(health, expected, describeCase(c));
  }
});

interface Row {
  readonly request: Request;
  readonly attempt: number;
  readonly facts: AttemptFacts;
  readonly expected: Decision;
}

const GET = REQUESTS[0] as Request;
const POST = REQUESTS[1] as Request;
const POST_SAFE = REQUESTS[2] as Request;
const DELETE = REQUESTS[4] as Request;

const ROWS: readonly Row[] = [
  // Lost responses.
  {
    request: GET,
    attempt: 1,
    facts: { kind: 'failure', reason: 'timeout' },
    expected: { kind: 'retry', reason: 'transport', health: 'failure' },
  },
  {
    request: GET,
    attempt: 4,
    facts: { kind: 'failure', reason: 'timeout' },
    expected: { kind: 'fail', fail: 'timeout', health: 'failure' },
  },
  {
    request: POST_SAFE,
    attempt: 4,
    facts: { kind: 'failure', reason: 'transport' },
    expected: { kind: 'fail', fail: 'transport', health: 'failure' },
  },
  {
    request: GET,
    attempt: 1,
    facts: { kind: 'failure', reason: 'aborted', answeredStatus: 200 },
    expected: { kind: 'fail', fail: 'cancelled', health: 'unchanged' },
  },
  {
    request: POST,
    attempt: 1,
    facts: { kind: 'failure', reason: 'timeout' },
    expected: { kind: 'fail', fail: 'ambiguous_write', health: 'failure' },
  },
  {
    request: POST,
    attempt: 1,
    facts: { kind: 'failure', reason: 'transport', answeredStatus: 201 },
    expected: { kind: 'fail', fail: 'applied_reply_lost', health: 'failure' },
  },
  {
    request: POST,
    attempt: 1,
    facts: { kind: 'failure', reason: 'aborted', answeredStatus: 201 },
    expected: { kind: 'fail', fail: 'applied_reply_lost', health: 'unchanged' },
  },
  {
    request: POST,
    attempt: 1,
    facts: { kind: 'failure', reason: 'aborted', answeredStatus: 502 },
    expected: { kind: 'fail', fail: 'cancelled', health: 'unchanged' },
  },
  {
    request: DELETE,
    attempt: 1,
    facts: { kind: 'failure', reason: 'aborted' },
    expected: { kind: 'fail', fail: 'cancelled', health: 'unchanged' },
  },
  // Responses.
  {
    request: GET,
    attempt: 1,
    facts: factsFor(GET, 200),
    expected: { kind: 'done', health: 'success' },
  },
  {
    request: POST,
    attempt: 1,
    facts: factsFor(POST, 201),
    expected: { kind: 'done', health: 'success' },
  },
  {
    request: GET,
    attempt: 1,
    facts: factsFor(GET, 302),
    expected: { kind: 'fail', fail: 'redirect', health: 'success' },
  },
  {
    request: GET,
    attempt: 1,
    facts: factsFor(GET, 304),
    expected: { kind: 'fail', fail: 'status', health: 'success' },
  },
  {
    request: POST,
    attempt: 1,
    facts: factsFor(POST, 404),
    expected: { kind: 'fail', fail: 'status', health: 'success' },
  },
  {
    request: POST,
    attempt: 1,
    facts: factsFor(POST, 429),
    expected: { kind: 'retry', reason: '429', health: 'unchanged' },
  },
  {
    request: POST,
    attempt: 4,
    facts: factsFor(POST, 429),
    expected: { kind: 'fail', fail: 'rate_limited', health: 'unchanged' },
  },
  {
    request: GET,
    attempt: 1,
    facts: factsFor(GET, 429, true),
    expected: { kind: 'fail', fail: 'quota', health: 'unchanged' },
  },
  {
    request: GET,
    attempt: 1,
    facts: factsFor(GET, 503),
    expected: { kind: 'retry', reason: '5xx', health: 'failure' },
  },
  {
    request: GET,
    attempt: 4,
    facts: factsFor(GET, 503),
    expected: { kind: 'fail', fail: 'status', health: 'failure' },
  },
  {
    request: GET,
    attempt: 1,
    facts: factsFor(GET, 500),
    expected: { kind: 'fail', fail: 'status', health: 'failure' },
  },
  {
    request: POST,
    attempt: 1,
    facts: factsFor(POST, 503),
    expected: { kind: 'fail', fail: 'ambiguous_write', health: 'failure' },
  },
  {
    request: POST_SAFE,
    attempt: 1,
    facts: factsFor(POST_SAFE, 504),
    expected: { kind: 'retry', reason: '5xx', health: 'failure' },
  },
  {
    // A caller that hands an unsafe write `retryableStatus: true` still gets
    // no replay: the policy is checked again inside `decideNext`.
    request: POST,
    attempt: 1,
    facts: { kind: 'response', status: 503, quota: false, retryableStatus: true },
    expected: { kind: 'fail', fail: 'ambiguous_write', health: 'failure' },
  },
];

test('[D515] decideNext table', () => {
  for (const row of ROWS) {
    assert.deepEqual(
      decide(row.request, row.attempt, row.facts),
      row.expected,
      describeCase(row),
    );
  }
});

test('[D515] maxRetries 0 means the first attempt is the last', () => {
  const policy = { replayable: true };
  const outcome = classifyOutcome({ kind: 'failure', reason: 'timeout' }, policy);
  assert.deepEqual(decideNext(outcome, { attempt: 1, maxRetries: 0 }, policy), {
    kind: 'fail',
    fail: 'timeout',
    health: 'failure',
  });
});

test('[D515] failureReasonOf names timeouts, aborts and everything else', () => {
  const named = (name: string): Error => {
    const err = new Error(name);
    err.name = name;
    return err;
  };
  assert.equal(failureReasonOf(named('TimeoutError')), 'timeout');
  assert.equal(failureReasonOf(named('AbortError')), 'aborted');
  assert.equal(failureReasonOf(new TypeError('fetch failed')), 'transport');
  assert.equal(failureReasonOf('not an error'), 'transport');
});
