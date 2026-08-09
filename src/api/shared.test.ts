// Tests for the two pagination loops (WP-15).
//
// Every case here is about LOOP behaviour — termination, stop reasons, budget
// plumbing, token discipline. Nothing asserts a Jira field name: the request
// builders and `readPage` narrowers below are stand-ins for what Wave 2 will
// write, deliberately shaped like the real endpoints (`issues` for search,
// `values` for a classic collection) without the module under test knowing.
//
// The fake Jira client throws on a route nobody programmed, which doubles as the
// assertion that a loop stopped when it should have: an extra page would surface
// as "unexpected request", not as a silently wrong count.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError, type JiraRequestSpec, type JiraResponse } from '../core/types.js';
import {
  DEFAULT_MAX_PAGES,
  NEXT_PAGE_TOKEN_KEY,
  fetchAll,
  fetchPage,
  searchPages,
  type ClassicCursor,
  type ClassicPage,
  type TokenCursor,
  type TokenPage,
} from './shared.js';

interface Row {
  readonly id: string;
}

/** `n` rows, ids continuing after `offset` — enough to make a page look full. */
function rows(count: number, offset = 0): Row[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: String(offset + index + 1),
  }));
}

function ids(items: readonly Row[]): string[] {
  return items.map((row) => row.id);
}

/** An abort rejection shaped like the platform's, as `core/clock.ts` produces it. */
function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isJiraErrorOfKind(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof JiraError && error.kind === kind;
}

// --- token model stand-ins (search/jql) ------------------------------------

function tokenRequest(cursor: TokenCursor): JiraRequestSpec {
  return {
    method: 'GET',
    path: '/search/jql',
    query: {
      jql: 'project = ABC ORDER BY created DESC',
      maxResults: 50,
      ...(cursor.nextPageToken === undefined
        ? {}
        : { [NEXT_PAGE_TOKEN_KEY]: cursor.nextPageToken }),
    },
  };
}

function readTokenPage(response: JiraResponse): TokenPage<Row> {
  const data = response.data as {
    issues?: readonly Row[];
    nextPageToken?: string;
    isLast?: boolean;
  };
  return {
    items: data.issues ?? [],
    nextPageToken: data.nextPageToken,
    isLast: data.isLast,
  };
}

// --- classic model stand-ins (comments, agile) ------------------------------

function classicRequest(cursor: ClassicCursor): JiraRequestSpec {
  return {
    method: 'GET',
    path: '/issue/ABC-1/comment',
    query: { startAt: cursor.startAt, maxResults: cursor.maxResults },
  };
}

function readClassicPage(response: JiraResponse): ClassicPage<Row> {
  const data = response.data as {
    values?: readonly Row[];
    startAt?: number;
    maxResults?: number;
    total?: number;
    isLast?: boolean;
  };
  return {
    items: data.values ?? [],
    startAt: data.startAt,
    maxResults: data.maxResults,
    total: data.total,
    isLast: data.isLast,
  };
}

// ---------------------------------------------------------------------------
// Token pagination
// ---------------------------------------------------------------------------

test('searchPages follows nextPageToken until Jira stops issuing one', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1, 0), nextPageToken: 't1' }))
    .enqueue(jiraOk({ issues: rows(1, 1), nextPageToken: 't2' }))
    .enqueue(jiraOk({ issues: rows(1, 2) }));

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: tokenRequest,
    readPage: readTokenPage,
  });

  assert.deepEqual(ids(result.items), ['1', '2', '3']);
  assert.equal(result.pages, 3);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.nextPageToken, undefined);
  // Each token travels exactly once, in order; page one carries none.
  assert.deepEqual(
    jira.calls.map((call) => call.query?.[NEXT_PAGE_TOKEN_KEY]),
    [undefined, 't1', 't2'],
  );
});

test('searchPages stops on isLast even when a token is still present', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: rows(2), nextPageToken: 't1', isLast: true }),
  );

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: tokenRequest,
    readPage: readTokenPage,
  });

  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  // A complete result exposes no resume cursor, however chatty the server was.
  assert.equal(result.nextPageToken, undefined);
});

test('searchPages stops at maxPages with a resume token instead of throwing', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1, 0), nextPageToken: 't1' }))
    .enqueue(jiraOk({ issues: rows(1, 1), nextPageToken: 't2' }));

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: tokenRequest,
    readPage: readTokenPage,
    maxPages: 2,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.deepEqual(ids(result.items), ['1', '2']);
  assert.equal(result.nextPageToken, 't2');
  assert.equal(jira.calls.length, 2, 'the cap must be checked before the next request');
});

test('DEFAULT_MAX_PAGES is the documented default and JIRA_MAX_PAGES is never read', async () => {
  assert.equal(DEFAULT_MAX_PAGES, 20, 'CONFIGURATION.md documents JIRA_MAX_PAGES = 20');

  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1, 0), nextPageToken: 't1' }))
    .enqueue(jiraOk({ issues: rows(1, 1) }));

  process.env.JIRA_MAX_PAGES = '1';
  try {
    const result = await searchPages<Row>({
      jira: jira.fn,
      request: tokenRequest,
      readPage: readTokenPage,
    });
    // The env said one page; the helper takes options only, so it read two.
    assert.equal(result.pages, 2);
    assert.equal(result.stopReason, 'exhausted');
  } finally {
    delete process.env.JIRA_MAX_PAGES;
  }
});

test('searchPages sends a caller-supplied start token on the first request', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ issues: rows(1) }));

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: tokenRequest,
    readPage: readTokenPage,
    startToken: 'from-a-previous-tool-call',
  });

  assert.equal(result.pages, 1);
  assert.equal(jira.calls[0]?.query?.[NEXT_PAGE_TOKEN_KEY], 'from-a-previous-tool-call');
});

test('an expired caller-supplied token fails fast rather than restarting silently', async () => {
  // CC-01: a token the MODEL passed in is a deliberate resume; swallowing its
  // 400 and re-running from page one would silently repeat data it already saw.
  const jira = createFakeJiraRequest().enqueue(
    jiraErr(
      new JiraError({
        kind: 'validation',
        httpStatus: 400,
        message: 'The next page token is invalid or expired.',
      }),
    ),
  );

  await assert.rejects(
    searchPages<Row>({
      jira: jira.fn,
      request: tokenRequest,
      readPage: readTokenPage,
      startToken: 'expired',
    }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 1, 'no silent restart from page one');
});

test('searchPages refuses to re-send a token Jira handed back twice', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1, 0), nextPageToken: 't1' }))
    .enqueue(jiraOk({ issues: rows(1, 1), nextPageToken: 't1' }));

  await assert.rejects(
    searchPages<Row>({
      jira: jira.fn,
      request: tokenRequest,
      readPage: readTokenPage,
    }),
    isJiraErrorOfKind('unexpected_shape'),
  );
  // Two pages were fetched; the third — the repeat — never went out.
  assert.equal(jira.calls.length, 2);
});

test('searchPages refuses to carry a token into a changed query', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1, 0), nextPageToken: 't1' }))
    .enqueue(jiraOk({ issues: rows(1, 1) }));

  await assert.rejects(
    searchPages<Row>({
      jira: jira.fn,
      request: (cursor) => {
        const spec = tokenRequest(cursor);
        // The field list changes on page two — exactly what invalidates a token.
        return { ...spec, query: { ...spec.query, fields: `summary,${cursor.page}` } };
      },
      readPage: readTokenPage,
    }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 1, 'the changed page-two request is never sent');
});

test('query identity ignores key order and the cursor itself', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1, 0), nextPageToken: 't1' }))
    .enqueue(jiraOk({ issues: rows(1, 1) }));

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: (cursor) => ({
      method: 'POST',
      path: '/search/jql',
      safe: true,
      body:
        cursor.page === 0
          ? { jql: 'project = ABC', fields: ['summary'], maxResults: 50 }
          : {
              maxResults: 50,
              [NEXT_PAGE_TOKEN_KEY]: cursor.nextPageToken,
              fields: ['summary'],
              jql: 'project = ABC',
            },
    }),
    readPage: readTokenPage,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'exhausted');
});

// ---------------------------------------------------------------------------
// Budget and cancellation
// ---------------------------------------------------------------------------

test('an abort of a request in flight propagates untouched', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1), nextPageToken: 't1' }))
    .enqueue(jiraErr(abortError()));

  await assert.rejects(
    searchPages<Row>({
      jira: jira.fn,
      request: tokenRequest,
      readPage: readTokenPage,
    }),
    { name: 'AbortError' },
  );
});

test('a signal aborted between pages keeps the pages already read', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: rows(1), nextPageToken: 't1' }),
  );

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: tokenRequest,
    readPage: (response) => {
      controller.abort(); // the client hung up while page one was being read
      return readTokenPage(response);
    },
    signal: controller.signal,
  });

  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.partial, true);
  assert.deepEqual(ids(result.items), ['1']);
  assert.equal(result.nextPageToken, 't1');
  assert.equal(jira.calls.length, 1);
});

test('an expired call budget stops the loop with a partial result', async () => {
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ issues: rows(1), nextPageToken: 't1' }),
  );

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: tokenRequest,
    readPage: (response) => {
      clock.advance(600); // page one used the rest of the budget
      return readTokenPage(response);
    },
    clock,
    deadlineAt: 1_500,
  });

  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.partial, true);
  assert.equal(result.nextPageToken, 't1');
  assert.equal(jira.calls.length, 1, 'no request is sent into an expired budget');
});

test('an abort outranks an expired budget as the reported stop reason', async () => {
  const clock = createFakeClock(9_000);
  const controller = new AbortController();
  controller.abort();
  const jira = createFakeJiraRequest();

  const result = await searchPages<Row>({
    jira: jira.fn,
    request: tokenRequest,
    readPage: readTokenPage,
    signal: controller.signal,
    clock,
    deadlineAt: 1_000,
  });

  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.pages, 0);
  assert.equal(result.items.length, 0);
  assert.equal(jira.calls.length, 0);
});

test('every page request carries the loop controls unless the builder set its own', async () => {
  const loopController = new AbortController();
  const ownController = new AbortController();
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ issues: rows(1, 0), nextPageToken: 't1' }))
    .enqueue(jiraOk({ issues: rows(1, 1) }));

  await searchPages<Row>({
    jira: jira.fn,
    request: (cursor) =>
      cursor.page === 0
        ? tokenRequest(cursor)
        : { ...tokenRequest(cursor), signal: ownController.signal, deadlineAt: 9_999 },
    readPage: readTokenPage,
    signal: loopController.signal,
    clock,
    deadlineAt: 8_000,
  });

  assert.equal(jira.calls[0]?.signal, loopController.signal);
  assert.equal(jira.calls[0]?.deadlineAt, 8_000);
  assert.equal(jira.calls[1]?.signal, ownController.signal);
  assert.equal(jira.calls[1]?.deadlineAt, 9_999);
});

// ---------------------------------------------------------------------------
// Classic pagination
// ---------------------------------------------------------------------------

test('fetchPage reads exactly one classic page at the requested offset', async () => {
  const clock = createFakeClock(1_000);
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ values: rows(2, 50), startAt: 50, maxResults: 2, total: 90 }),
  );

  const page = await fetchPage<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    startAt: 50,
    maxResults: 2,
    signal: controller.signal,
    clock,
    deadlineAt: 5_000,
  });

  assert.deepEqual(ids(page.items), ['51', '52']);
  assert.equal(page.total, 90);
  assert.equal(jira.calls.length, 1);
  assert.equal(jira.calls[0]?.query?.startAt, 50);
  assert.equal(jira.calls[0]?.query?.maxResults, 2);
  // A single page is cancelled and budgeted like a looped one.
  assert.equal(jira.calls[0]?.signal, controller.signal);
  assert.equal(jira.calls[0]?.deadlineAt, 5_000);
});

test('fetchAll walks startAt/maxResults until isLast', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ values: rows(2, 0), startAt: 0, maxResults: 2, isLast: false }))
    .enqueue(jiraOk({ values: rows(2, 2), startAt: 2, maxResults: 2, isLast: true }));

  const result = await fetchAll<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    pageSize: 2,
  });

  assert.deepEqual(ids(result.items), ['1', '2', '3', '4']);
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.nextStartAt, undefined);
  assert.deepEqual(
    jira.calls.map((call) => call.query?.startAt),
    [0, 2],
  );
});

test('fetchAll treats a short page as the end', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ values: rows(2, 0), startAt: 0, maxResults: 2 }))
    .enqueue(jiraOk({ values: rows(1, 2), startAt: 2, maxResults: 2 }));

  const result = await fetchAll<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    pageSize: 2,
  });

  assert.deepEqual(ids(result.items), ['1', '2', '3']);
  assert.equal(result.stopReason, 'exhausted');
});

test('fetchAll stops once startAt reaches the reported total', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ values: rows(2, 0), startAt: 0, maxResults: 2, total: 4 }))
    .enqueue(jiraOk({ values: rows(2, 2), startAt: 2, maxResults: 2, total: 4 }));

  const result = await fetchAll<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    pageSize: 2,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.total, 4);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.items.length, 4);
});

test('fetchAll stops on an empty page instead of spinning at the same offset', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ values: rows(2, 0), startAt: 0, maxResults: 2, total: 99 }))
    .enqueue(jiraOk({ values: [], startAt: 2, maxResults: 2, total: 99 }));

  const result = await fetchAll<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    pageSize: 2,
  });

  // `total` claims more rows exist, but a zero-row page cannot advance the
  // offset, so continuing would loop until the page cap for nothing.
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.items.length, 2);
});

test('fetchAll measures a short page against the size the server applied', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ values: rows(50, 0), startAt: 0, maxResults: 50 }))
    .enqueue(jiraOk({ values: rows(10, 50), startAt: 50, maxResults: 50 }));

  const result = await fetchAll<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    // The caller asked for 100; Jira capped the page at 50. Comparing against
    // the REQUESTED size would read a full page as short and stop after one.
    pageSize: 100,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.items.length, 60);
  assert.equal(result.stopReason, 'exhausted');
});

test('fetchAll stops at maxPages with a resume offset instead of throwing', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ values: rows(2, 0), startAt: 0, maxResults: 2, total: 99 }))
    .enqueue(jiraOk({ values: rows(2, 2), startAt: 2, maxResults: 2, total: 99 }));

  const result = await fetchAll<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    pageSize: 2,
    maxPages: 2,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.nextStartAt, 4);
  assert.equal(result.total, 99);
  assert.equal(jira.calls.length, 2);
});

test('fetchAll starts from a caller-supplied offset', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({ values: rows(1, 10), startAt: 10, maxResults: 5, isLast: true }),
  );

  const result = await fetchAll<Row>({
    jira: jira.fn,
    request: classicRequest,
    readPage: readClassicPage,
    startAt: 10,
    pageSize: 5,
  });

  assert.equal(jira.calls[0]?.query?.startAt, 10);
  assert.deepEqual(ids(result.items), ['11']);
});

test('a page-level failure propagates out of the classic loop', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ values: rows(2, 0), startAt: 0, maxResults: 2 }))
    .enqueue(
      jiraErr(
        new JiraError({ kind: 'rate_limited', httpStatus: 429, message: 'slow down' }),
      ),
    );

  await assert.rejects(
    fetchAll<Row>({
      jira: jira.fn,
      request: classicRequest,
      readPage: readClassicPage,
      pageSize: 2,
    }),
    isJiraErrorOfKind('rate_limited'),
  );
});

// ---------------------------------------------------------------------------
// Guard-rail configuration
// ---------------------------------------------------------------------------

test('a non-positive maxPages is a config error, not an empty result', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    searchPages<Row>({
      jira: jira.fn,
      request: tokenRequest,
      readPage: readTokenPage,
      maxPages: 0,
    }),
    isJiraErrorOfKind('config'),
  );
  await assert.rejects(
    fetchAll<Row>({
      jira: jira.fn,
      request: classicRequest,
      readPage: readClassicPage,
      pageSize: 2,
      maxPages: 2.5,
    }),
    isJiraErrorOfKind('config'),
  );
  await assert.rejects(
    fetchAll<Row>({
      jira: jira.fn,
      request: classicRequest,
      readPage: readClassicPage,
      pageSize: 0,
    }),
    isJiraErrorOfKind('config'),
  );
  assert.equal(jira.calls.length, 0);
});
