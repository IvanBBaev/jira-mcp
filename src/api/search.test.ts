// Tests for `api/search.ts` (WP-20) — contract tier (TESTING.md §Mocking tiers).
//
// Response bodies are inline plain objects shaped after the real
// `/rest/api/3/search/jql` and `/search/approximate-count` payloads and marked
// `// synthetic`; the recorded fixtures that replace them land in WP-41
// (`fake.fixture(...)` is already the hook). Placeholder vocabulary is
// TESTING.md's: `example.atlassian.net`, `5b10a2844c20165700ede21g`-style
// accountIds, `user-1@example.invalid`.
//
// The fake throws on a route nobody programmed, so "the loop stopped here" is
// asserted by construction: one page too many surfaces as an unexpected request
// rather than as a quietly wrong row count.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { errorFromResponse } from '../core/errors.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import {
  JiraError,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
} from '../core/types.js';
import {
  APPROXIMATE_COUNT_PATH,
  DEFAULT_SEARCH_FIELDS,
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_SEARCH_RESULTS,
  SEARCH_JQL_PATH,
  approximateCount,
  searchIssues,
} from './search.js';

const JQL = 'project = ABC ORDER BY created DESC';
const SEARCH_ROUTE = `POST /rest/api/3${SEARCH_JQL_PATH}`;
const COUNT_ROUTE = `POST /rest/api/3${APPROXIMATE_COUNT_PATH}`;

/** One `/search/jql` issue row, trimmed to what the module narrows. // synthetic */
function issue(id: string, key: string): Record<string, unknown> {
  return {
    id,
    key,
    self: `https://example.atlassian.net/rest/api/3/issue/${id}`,
    fields: {
      summary: `Issue ${key}`,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      assignee: {
        accountId: '5b10a2844c20165700ede21g',
        displayName: 'User One',
        active: true,
      },
      updated: '2026-08-09T10:00:00.000+0000',
    },
  };
}

/** The 400 Jira answers with when a cursor has gone stale (CC-01). // synthetic */
function expiredTokenError(): JiraError {
  return errorFromResponse({
    status: 400,
    body: {
      errorMessages: ['The provided next page token is invalid or expired.'],
      errors: {},
    },
    method: 'POST',
    pathTemplate: SEARCH_JQL_PATH,
  });
}

/** The 400 Jira answers with for bad JQL — must NOT be mistaken for CC-01. // synthetic */
function jqlSyntaxError(): JiraError {
  return errorFromResponse({
    status: 400,
    body: {
      errorMessages: [
        "Error in the JQL Query: Expecting operator but got 'ABC'. (line 1, character 9)",
      ],
      errors: {},
    },
    method: 'POST',
    pathTemplate: SEARCH_JQL_PATH,
  });
}

function bodyOf(spec: JiraRequestSpec | undefined): Record<string, unknown> {
  assert.ok(spec !== undefined, 'expected a recorded request');
  const body = spec.body;
  assert.ok(
    typeof body === 'object' && body !== null && !Array.isArray(body),
    'expected a JSON object body',
  );
  return body as Record<string, unknown>;
}

function keys(issues: readonly { readonly key: string }[]): string[] {
  return issues.map((row) => row.key);
}

function isJiraErrorOfKind(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof JiraError && error.kind === kind;
}

/** Wraps a fake so virtual time passes on every completed call. */
function spendingClock(inner: JiraRequestFn, spend: () => void): JiraRequestFn {
  return async <T>(spec: JiraRequestSpec): Promise<JiraResponse<T>> => {
    const response = await inner<T>(spec);
    spend();
    return response;
  };
}

// ---------------------------------------------------------------------------
// Token protocol (D6)
// ---------------------------------------------------------------------------

test('walks the token protocol across three pages and never builds a legacy path', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' })) // synthetic
    .enqueue(jiraOk({ issues: [issue('10002', 'ABC-2')], nextPageToken: 'tok-2' })) // synthetic
    .enqueue(jiraOk({ issues: [issue('10003', 'ABC-3')], isLast: true })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL, maxPages: 5 });

  assert.deepEqual(keys(result.issues), ['ABC-1', 'ABC-2', 'ABC-3']);
  assert.equal(result.pages, 3);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.nextPageToken, undefined);
  assert.equal(result.restarted, false);
  assert.deepEqual(jira.routes(), [SEARCH_ROUTE, SEARCH_ROUTE, SEARCH_ROUTE]);
  assert.equal(bodyOf(jira.calls[0])['nextPageToken'], undefined);
  assert.equal(bodyOf(jira.calls[1])['nextPageToken'], 'tok-1');
  assert.equal(bodyOf(jira.calls[2])['nextPageToken'], 'tok-2');
  assert.equal(jira.calls[0]?.safe, true, 'a read over POST is replayable');
});

test('a page carrying no more token ends the loop as exhausted', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: [issue('10001', 'ABC-1')] }), // synthetic
  );

  const result = await searchIssues({ jira: jira.fn, jql: JQL, maxPages: 4 });

  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.pages, 1);
  assert.equal(jira.calls.length, 1);
});

test('an issues array that is not an array is a shape error, not an empty page', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: 'nope' })); // synthetic

  await assert.rejects(
    searchIssues({ jira: jira.fn, jql: JQL }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

// ---------------------------------------------------------------------------
// CC-03 — default field set
// ---------------------------------------------------------------------------

test('CC-03: no caller fields injects the documented default set', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL });

  assert.deepEqual(bodyOf(jira.lastRequest())['fields'], [...DEFAULT_SEARCH_FIELDS]);
  assert.deepEqual(result.fields, [...DEFAULT_SEARCH_FIELDS]);
  assert.equal(result.fieldsDefaulted, true);
});

test('CC-03: an empty field list is defaulted, never sent as empty', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL, fields: ['', '  '] });

  assert.deepEqual(bodyOf(jira.lastRequest())['fields'], [...DEFAULT_SEARCH_FIELDS]);
  assert.equal(result.fieldsDefaulted, true);
});

test('CC-03: caller fields are sent verbatim and reported as not defaulted', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({
    jira: jira.fn,
    jql: JQL,
    fields: ['summary', 'customfield_10011'],
  });

  assert.deepEqual(bodyOf(jira.lastRequest())['fields'], [
    'summary',
    'customfield_10011',
  ]);
  assert.equal(result.fieldsDefaulted, false);
});

// ---------------------------------------------------------------------------
// CC-04 — maxResults clamp
// ---------------------------------------------------------------------------

test('CC-04: an over-cap maxResults is clamped and the clamp is reported', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL, maxResults: 500 });

  assert.equal(bodyOf(jira.lastRequest())['maxResults'], MAX_SEARCH_RESULTS);
  assert.equal(result.maxResults, MAX_SEARCH_RESULTS);
  assert.equal(result.clamped, true);
});

test('CC-04: a maxResults within the cap is sent unchanged', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL, maxResults: 10 });

  assert.equal(bodyOf(jira.lastRequest())['maxResults'], 10);
  assert.equal(result.clamped, false);
});

test('the default page size is used when the caller names none', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL });

  assert.equal(bodyOf(jira.lastRequest())['maxResults'], DEFAULT_SEARCH_MAX_RESULTS);
  assert.equal(result.maxResults, DEFAULT_SEARCH_MAX_RESULTS);
});

test('a nonsensical maxResults is refused before anything reaches the wire', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    searchIssues({ jira: jira.fn, jql: JQL, maxResults: 0 }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

test('the default single-page read reports max_pages and hands back the cursor', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' }), // synthetic
  );

  const result = await searchIssues({ jira: jira.fn, jql: JQL });

  assert.equal(result.pages, 1);
  assert.equal(result.maxPages, 1);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.nextPageToken, 'tok-1');
  assert.equal(jira.calls.length, 1, 'the default read never fetches a second page');
});

test('an explicit sweep cap stops at maxPages and reports the cap it used', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' })) // synthetic
    .enqueue(jiraOk({ issues: [issue('10002', 'ABC-2')], nextPageToken: 'tok-2' })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL, maxPages: 2 });

  assert.equal(result.pages, 2);
  assert.equal(result.maxPages, 2);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.nextPageToken, 'tok-2');
});

test('an expired call budget stops the sweep with a partial result', async () => {
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' }), // synthetic
  );

  const result = await searchIssues({
    jira: spendingClock(jira.fn, () => {
      clock.advance(600); // page one spent the rest of the budget
    }),
    jql: JQL,
    maxPages: 5,
    clock,
    deadlineAt: 1_500,
  });

  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.partial, true);
  assert.equal(result.nextPageToken, 'tok-1');
  assert.equal(jira.calls.length, 1, 'no request is sent into an expired budget');
});

test('an aborted request stops the sweep and reports it as aborted', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' }), // synthetic
  );

  const result = await searchIssues({
    jira: spendingClock(jira.fn, () => {
      controller.abort();
    }),
    jql: JQL,
    maxPages: 5,
    signal: controller.signal,
  });

  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.partial, true);
  assert.equal(jira.calls[0]?.signal, controller.signal, 'the signal reaches the wire');
});

// ---------------------------------------------------------------------------
// CC-01 — expired cursor
// ---------------------------------------------------------------------------

test('CC-01: a cursor that expires mid-sweep restarts the search exactly once', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' })) // synthetic
    .enqueue(jiraErr(expiredTokenError()))
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-9' })) // synthetic
    .enqueue(jiraOk({ issues: [issue('10002', 'ABC-2')] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL, maxPages: 4 });

  assert.equal(result.restarted, true);
  assert.deepEqual(keys(result.issues), ['ABC-1', 'ABC-2']);
  assert.equal(result.pages, 2, 'the restarted run is the one that is reported');
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(jira.calls.length, 4);
  assert.equal(
    bodyOf(jira.calls[2])['nextPageToken'],
    undefined,
    'the restart is page one',
  );
});

test('CC-01: a second expiry propagates instead of restarting forever', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' })) // synthetic
    .enqueue(jiraErr(expiredTokenError()))
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-9' })) // synthetic
    .enqueue(jiraErr(expiredTokenError()));

  await assert.rejects(
    searchIssues({ jira: jira.fn, jql: JQL, maxPages: 4 }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 4, 'exactly one restart, then the error is Jira’s');
});

test('CC-01: a caller-supplied token that expired fails fast with remediation', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraErr(expiredTokenError()));

  await assert.rejects(
    searchIssues({ jira: jira.fn, jql: JQL, nextPageToken: 'stale-token', maxPages: 4 }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'validation');
      assert.equal(error.httpStatus, 400);
      assert.match(error.message, /nextPageToken/);
      assert.match(error.message, /omit nextPageToken/i);
      return true;
    },
  );
  assert.equal(jira.calls.length, 1, 'no silent restart behind the caller’s back');
  assert.equal(bodyOf(jira.calls[0])['nextPageToken'], 'stale-token');
});

test('CC-01: the marker is matched even when Jira spells nextPageToken as one word', async () => {
  const oneWord = errorFromResponse({
    status: 400,
    // synthetic — the alternative wording Atlassian has shipped
    body: {
      errorMessages: ['The provided nextPageToken is invalid or expired'],
      errors: {},
    },
    method: 'POST',
    pathTemplate: SEARCH_JQL_PATH,
  });
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')], nextPageToken: 'tok-1' })) // synthetic
    .enqueue(jiraErr(oneWord))
    .enqueue(jiraOk({ issues: [issue('10001', 'ABC-1')] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL, maxPages: 4 });

  assert.equal(result.restarted, true);
  assert.equal(jira.calls.length, 3);
});

// ---------------------------------------------------------------------------
// CC-05 — Jira's own errors survive
// ---------------------------------------------------------------------------

test('CC-05: a JQL syntax 400 propagates untouched', async () => {
  const upstream = jqlSyntaxError();
  const jira = createFakeJiraRequest().enqueue(jiraErr(upstream));

  await assert.rejects(
    searchIssues({ jira: jira.fn, jql: 'project ABC', maxPages: 4 }),
    (error: unknown) => {
      assert.equal(error, upstream, 'the error object itself must survive');
      return true;
    },
  );
  assert.equal(jira.calls.length, 1, 'a JQL error is never retried as a cursor problem');
});

test('CC-05: a permission 403 propagates untouched', async () => {
  const upstream = errorFromResponse({
    status: 403,
    body: {
      errorMessages: ['You do not have permission to view these issues.'],
      errors: {},
    }, // synthetic
    method: 'POST',
    pathTemplate: SEARCH_JQL_PATH,
  });
  const jira = createFakeJiraRequest().enqueue(jiraErr(upstream));

  await assert.rejects(searchIssues({ jira: jira.fn, jql: JQL }), (error: unknown) => {
    assert.equal(error, upstream);
    return true;
  });
});

// ---------------------------------------------------------------------------
// CC-02 — read-after-write reconciliation
// ---------------------------------------------------------------------------

test('CC-02: recently written ids are reconciled and the missing ones reported', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: [issue('10001', 'ABC-1')] }), // synthetic — 10002 has not indexed yet
  );

  const result = await searchIssues({
    jira: jira.fn,
    jql: JQL,
    recentlyWrittenIssueIds: ['10001', '10002'],
  });

  assert.deepEqual(bodyOf(jira.lastRequest())['reconcileIssues'], [10001, 10002]);
  assert.deepEqual(result.reconciledIssueIds, ['10001', '10002']);
  assert.deepEqual(result.missingRecentIssueIds, ['10002']);
});

test('CC-02: every recent write showing up leaves an empty missing list', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: [issue('10001', 'ABC-1'), issue('10002', 'ABC-2')] }), // synthetic
  );

  const result = await searchIssues({
    jira: jira.fn,
    jql: JQL,
    recentlyWrittenIssueIds: [10001, 10002],
  });

  assert.deepEqual(result.missingRecentIssueIds, []);
});

test('CC-02: an explicit reconcileIssues list wins over the recent-write list', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({
    jira: jira.fn,
    jql: JQL,
    reconcileIssues: ['10005'],
    recentlyWrittenIssueIds: ['10001'],
  });

  assert.deepEqual(bodyOf(jira.lastRequest())['reconcileIssues'], [10005]);
  assert.deepEqual(result.missingRecentIssueIds, ['10001']);
});

test('CC-02: no reconcile ids means no reconcileIssues on the wire', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  const result = await searchIssues({ jira: jira.fn, jql: JQL });

  assert.equal('reconcileIssues' in bodyOf(jira.lastRequest()), false);
  assert.equal(result.reconciledIssueIds, undefined);
  assert.equal(result.missingRecentIssueIds, undefined);
});

test('CC-02: an issue KEY in the reconcile list is refused with remediation', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    searchIssues({ jira: jira.fn, jql: JQL, reconcileIssues: ['ABC-1'] }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// expand
// ---------------------------------------------------------------------------

test('expand sections are joined into the comma string the endpoint expects', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: [] })); // synthetic

  await searchIssues({
    jira: jira.fn,
    jql: JQL,
    expand: ['changelog', 'renderedFields'],
  });

  assert.equal(bodyOf(jira.lastRequest())['expand'], 'changelog,renderedFields');
});

// ---------------------------------------------------------------------------
// jira_count — approximate count
// ---------------------------------------------------------------------------

test('approximateCount posts the JQL and labels the answer as an estimate', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ count: 153 })); // synthetic

  const result = await approximateCount({ jira: jira.fn, jql: JQL });

  assert.deepEqual(result, { count: 153, approximate: true });
  assert.deepEqual(jira.routes(), [COUNT_ROUTE]);
  assert.deepEqual(bodyOf(jira.lastRequest()), { jql: JQL });
  assert.equal(jira.lastRequest()?.safe, true);
});

test('approximateCount carries the call budget and the abort signal', async () => {
  const clock = createFakeClock(1_000);
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(jiraOk({ count: 0 })); // synthetic

  await approximateCount({
    jira: jira.fn,
    jql: JQL,
    signal: controller.signal,
    clock,
    deadlineAt: 4_000,
  });

  assert.equal(jira.lastRequest()?.deadlineAt, 4_000);
  assert.equal(jira.lastRequest()?.signal, controller.signal);
});

test('approximateCount rejects a response with no numeric count', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ approximateCount: 12 })); // synthetic

  await assert.rejects(
    approximateCount({ jira: jira.fn, jql: JQL }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});
