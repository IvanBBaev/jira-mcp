// ---------------------------------------------------------------------------
// The shared tool plumbing (WP-42). Seven packages used to carry a private copy
// of each of these; the tests that pinned them lived seven times over, in terms
// of the package that happened to own the copy. Here they are asserted once, on
// the thing itself.
//
// The rethrow rule gets the most attention, because it is the one place where a
// plausible-looking "be defensive, catch everything" would break a seam this
// ring is not allowed to know about: plan mode unwinds a captured write by
// REJECTING, and a swallowed rejection would report every plan as a failure.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { JiraError } from '../core/types.js';
import type { JiraRequestFn } from '../core/types.js';
import { ok } from './result.js';
import {
  DESTRUCTIVE_WRITE_ANNOTATIONS,
  IDEMPOTENT_WRITE_ANNOTATIONS,
  LOCAL_READ_ANNOTATIONS,
  READ_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  callBase,
  guarded,
  pagingOf,
  rethrowUnexpected,
} from './tool-helpers.js';
import type { ToolAnnotations, ToolCtx } from './types.js';

/** A seam that must never be called: every test here stops before the network. */
const unusedJira: JiraRequestFn = () => {
  throw new Error('no request should be issued by these tests');
};

function createCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const clock = createFakeClock(1_000);
  return {
    jira: unusedJira,
    log: createFakeLogger({ cid: 'c-test01', clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 30_000, maxPages: 20 },
    deadlineAt: 9_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// guarded
// ---------------------------------------------------------------------------

test('a successful run passes through untouched', async () => {
  const envelope = ok({ answer: 42 }, { untrusted: true });

  const result = await guarded(() => Promise.resolve(envelope));

  assert.equal(result, envelope);
});

test('a JiraError becomes the error envelope its own layer worded', async () => {
  const error = new JiraError({
    kind: 'not_found',
    message: 'Issue PROJ-1 does not exist.',
    httpStatus: 404,
    remediation: 'Confirm the key with jira_search.',
  });

  const result = await guarded(() => Promise.reject(error));

  assert.equal(result.ok, false);
  assert.equal(result.data, undefined);
  assert.equal(result.error?.kind, 'not_found');
  assert.equal(result.error?.message, 'Issue PROJ-1 does not exist.');
  assert.equal(result.error?.httpStatus, 404);
  // Not reworded here: the ring that saw the response knows more than this one.
  assert.equal(result.error?.remediation, 'Confirm the key with jira_search.');
  assert.equal(result.hints, undefined);
});

test('onError hints are read off the error, not off the call site', async () => {
  const hint = { code: 'discovery', message: 'Call jira_list_fields.' } as const;
  const onError = (error: JiraError) => (error.httpStatus === 400 ? [hint] : []);

  const rejected = await guarded(
    () =>
      Promise.reject(
        new JiraError({ kind: 'validation', message: '400', httpStatus: 400 }),
      ),
    onError,
  );
  const forbidden = await guarded(
    () =>
      Promise.reject(
        new JiraError({ kind: 'permission', message: '403', httpStatus: 403 }),
      ),
    onError,
  );

  assert.deepEqual(rejected.hints, [hint]);
  // An empty hint list is omitted, never rendered as `hints: []`.
  assert.equal(forbidden.hints, undefined);
});

test('a non-JiraError is RE-THROWN, so plan capture can unwind the handler', async () => {
  // Shaped like `PlanCaptured`: a plain Error the write gate throws to stop the
  // handler once the first mutating request has been captured.
  const captured = new Error('plan captured');
  let onErrorCalls = 0;

  await assert.rejects(
    guarded(
      () => Promise.reject(captured),
      () => {
        onErrorCalls += 1;
        return [];
      },
    ),
    (error) => error === captured,
  );
  // Not merely re-thrown afterwards: the failure branch was never entered.
  assert.equal(onErrorCalls, 0);
});

test('a synchronous throw inside the run body is caught the same way', async () => {
  const error = new JiraError({ kind: 'config', message: 'JIRA_SITE is unset.' });

  const result = await guarded(() => {
    throw error;
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'config');
});

test('rethrowUnexpected is the rule on its own, for the bespoke catch sites', () => {
  const jiraError = new JiraError({ kind: 'auth', message: '401' });
  const bug = new TypeError('undefined is not a function');

  assert.doesNotThrow(() => {
    rethrowUnexpected(jiraError);
  });
  assert.throws(
    () => {
      rethrowUnexpected(bug);
    },
    (error) => error === bug,
  );
});

// ---------------------------------------------------------------------------
// callBase
// ---------------------------------------------------------------------------

test('callBase forwards the seam and the budget, and nothing else', () => {
  const ctx = createCtx();

  const base = callBase(ctx);

  // Exact key set: the logger, the cid and the limits are the tool ring's
  // business, and handing them to the api ring would invite it to make
  // decisions it must not make.
  assert.deepEqual(Object.keys(base).sort(), ['clock', 'deadlineAt', 'jira', 'signal']);
  assert.equal(base.jira, ctx.jira);
  assert.equal(base.clock, ctx.clock);
  assert.equal(base.deadlineAt, ctx.deadlineAt);
});

test('cancellation travels: an absent signal stays absent, a present one is passed', () => {
  const controller = new AbortController();

  assert.equal(callBase(createCtx()).signal, undefined);
  assert.equal(
    callBase(createCtx({ signal: controller.signal })).signal,
    controller.signal,
  );
});

// ---------------------------------------------------------------------------
// The annotation quadruples (TOOLS.md §Annotations reference)
// ---------------------------------------------------------------------------

test('each constant matches its row of the annotations table', () => {
  assert.deepEqual(LOCAL_READ_ANNOTATIONS, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(READ_ANNOTATIONS, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(WRITE_ANNOTATIONS, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(IDEMPOTENT_WRITE_ANNOTATIONS, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(DESTRUCTIVE_WRITE_ANNOTATIONS, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
});

test('the constants are shared safely: frozen, and none is self-contradictory', () => {
  const all: readonly ToolAnnotations[] = [
    LOCAL_READ_ANNOTATIONS,
    READ_ANNOTATIONS,
    WRITE_ANNOTATIONS,
    IDEMPOTENT_WRITE_ANNOTATIONS,
    DESTRUCTIVE_WRITE_ANNOTATIONS,
  ];

  for (const annotations of all) {
    // Every tool spec shares one object; a mutable one would let a single tool
    // rewrite the annotations of every other tool in the catalog.
    assert.equal(Object.isFrozen(annotations), true);
    // `defineTool` refuses this pair, and it is nonsense besides: a read-only
    // tool that destroys state.
    assert.equal(annotations.readOnlyHint && annotations.destructiveHint, false);
  }

  // Only `jira_capabilities` stays inside the process (TOOLS.md).
  assert.equal(LOCAL_READ_ANNOTATIONS.openWorldHint, false);
});

// ---------------------------------------------------------------------------
// pagingOf (TOOLS.md §Read shaping, D27)
// ---------------------------------------------------------------------------

type Reason = 'exhausted' | 'max_pages' | 'aborted' | 'budget';

const NOTES: Readonly<Partial<Record<Reason, string>>> = {
  max_pages: 'INCOMPLETE: read the next page with startAt = paging.nextStartAt.',
  budget: 'INCOMPLETE: the call budget expired.',
};

test('a complete read reports the facts and invents no optional keys', () => {
  const paging = pagingOf<Reason>(
    { pages: 2, stopReason: 'exhausted', partial: false },
    NOTES,
  );

  // Exact: an absent `total`/`nextStartAt`/`note` is an omitted key, so the
  // rendered JSON never says `"total": undefined` or, worse, `null`.
  assert.deepEqual(paging, { pages: 2, stopReason: 'exhausted', partial: false });
  assert.equal('total' in paging, false);
  assert.equal('nextStartAt' in paging, false);
  assert.equal('note' in paging, false);
});

test('a partial read carries the cursor, the total and the note for its reason', () => {
  const paging = pagingOf<Reason>(
    { pages: 1, stopReason: 'max_pages', partial: true, nextStartAt: 50, total: 231 },
    NOTES,
  );

  assert.deepEqual(paging, {
    pages: 1,
    stopReason: 'max_pages',
    partial: true,
    total: 231,
    nextStartAt: 50,
    note: NOTES.max_pages,
  });
});

test('the note is selected by stop reason, so each remedy fits its cause', () => {
  const budget = pagingOf<Reason>(
    { pages: 3, stopReason: 'budget', partial: true, nextStartAt: 150 },
    NOTES,
  );

  assert.equal(budget.note, NOTES.budget);
});

test('a reason the package wrote no prose for stays silent rather than guessing', () => {
  const aborted = pagingOf<Reason>(
    { pages: 1, stopReason: 'aborted', partial: true, nextStartAt: 50 },
    NOTES,
  );

  assert.equal(aborted.note, undefined);
  assert.equal('note' in aborted, false);
  // The fact itself still travels — `partial` and the cursor are not prose.
  assert.equal(aborted.partial, true);
  assert.equal(aborted.nextStartAt, 50);
});

test('total zero and startAt zero survive: they are values, not absences', () => {
  const paging = pagingOf<Reason>(
    { pages: 1, stopReason: 'exhausted', partial: false, total: 0, nextStartAt: 0 },
    NOTES,
  );

  assert.equal(paging.total, 0);
  assert.equal(paging.nextStartAt, 0);
});
