// Tests for api/filters.ts — saved filter reads (WP-62).
//
// Contract tier (TESTING.md §Mocking tiers): every case drives the module
// through `fakeJiraRequest`, so no socket is involved and the assertions are
// about what this ring promises — the request it builds, the ALLOWLIST it
// narrows the response down to, and the pagination metadata it passes out
// untouched.
//
// Bodies are inline plain objects marked `// synthetic`, copied field-for-field
// from real Jira Cloud v3 `/filter` responses, with the placeholder vocabulary
// the fixture PII lint enforces (`example.atlassian.net`,
// `5b10a2844c20165700ede21g`-style accountIds).
//
// The share-permission cases are the load-bearing ones: a filter payload is the
// only read in this server that carries the tenant's access-control internals,
// and the mapper's job is to make sure none of it reaches a model.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError } from '../core/types.js';
import {
  FILTER_PATH_TEMPLATE,
  FILTER_SEARCH_EXPAND,
  getFilter,
  searchFilters,
} from './filters.js';

const SITE = 'https://example.atlassian.net';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to reject');
}

function asJiraError(error: unknown): JiraError {
  assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
  return error;
}

/**
 * Index into a mapped list. `noUncheckedIndexedAccess` makes `items[0]` a
 * `T | undefined`, and a test that silently reads `undefined` proves nothing.
 */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, got ${String(item)}`);
  }
  return item;
}

/** One `/filter/search` row, as Jira sends it with our expand set. // synthetic */
function filterRow(index: number): Record<string, unknown> {
  const id = String(10000 + index);
  return {
    self: `${SITE}/rest/api/3/filter/${id}`,
    id,
    name: `Filter ${index}`,
    description: `Saved query number ${index}.`,
    owner: {
      self: `${SITE}/rest/api/3/user?accountId=${ACCOUNT_ID}`,
      accountId: ACCOUNT_ID,
      displayName: 'User One',
      active: true,
      avatarUrls: { '48x48': `${SITE}/secure/useravatar?size=large` },
    },
    jql: `project = PR${index} ORDER BY created DESC`,
    // Extra keys the guards must tolerate rather than choke on — and, in the
    // case of the last three, must never pass on.
    viewUrl: `${SITE}/issues/?filter=${id}`,
    searchUrl: `${SITE}/rest/api/3/search?jql=filter%3D${id}`,
    sharePermissions: [
      { id: 10100, type: 'group', group: { name: 'jira-software-users' } },
    ],
    editPermissions: [{ id: 10101, type: 'project', project: { id: '10000' } }],
    subscriptions: [{ id: 10102, user: { accountId: ACCOUNT_ID } }],
  };
}

/** One `/filter/search` page (classic PageBean). // synthetic */
function filterPage(
  startAt: number,
  indexes: readonly number[],
  isLast: boolean,
): Record<string, unknown> {
  return {
    self: `${SITE}/rest/api/3/filter/search?startAt=${String(startAt)}&maxResults=2`,
    maxResults: 2,
    startAt,
    // Deliberately ahead of the offset in every page below, so `isLast` is the
    // only thing that can end the loop.
    total: 10,
    isLast,
    values: indexes.map(filterRow),
  };
}

// ---------------------------------------------------------------------------
// searchFilters — wire shape
// ---------------------------------------------------------------------------

test('searchFilters asks /filter/search for the expand set it promises', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(filterPage(0, [1], true)));

  await searchFilters({ jira: jira.fn, pageSize: 2 });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['GET /rest/api/3/filter/search']);
  assert.equal(spec?.method, 'GET');
  // A constant route carries no pathTemplate.
  assert.equal(spec?.pathTemplate, undefined);
  assert.equal(spec?.query?.expand, FILTER_SEARCH_EXPAND);
  assert.equal(spec?.query?.startAt, 0);
  assert.equal(spec?.query?.maxResults, 2);
  // The share-scope expands are never requested — see the module header.
  assert.doesNotMatch(FILTER_SEARCH_EXPAND, /share|subscription|permission/i);
});

test('searchFilters forwards the server-side filters and omits blank ones', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(filterPage(0, [1], true)));

  await searchFilters({
    jira: jira.fn,
    pageSize: 2,
    filterName: '  escalations  ',
    accountId: ACCOUNT_ID,
  });

  const query = jira.lastRequest()?.query;
  assert.equal(query?.filterName, 'escalations');
  assert.equal(query?.accountId, ACCOUNT_ID);

  jira.reset();
  jira.enqueue(jiraOk(filterPage(0, [1], true)));
  await searchFilters({ jira: jira.fn, pageSize: 2, filterName: '   ' });
  const blank = jira.lastRequest()?.query;
  assert.equal(blank?.filterName, undefined);
  assert.equal(blank?.accountId, undefined);
});

test('searchFilters carries the deadline and signal onto every page request', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(jiraOk(filterPage(0, [1], true)));

  await searchFilters({
    jira: jira.fn,
    pageSize: 2,
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);
});

// ---------------------------------------------------------------------------
// searchFilters — the allowlist
// ---------------------------------------------------------------------------

test('searchFilters reports only the six allowlisted fields', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(filterPage(0, [1], true)));

  const result = await searchFilters({ jira: jira.fn, pageSize: 2 });

  // `deepEqual` on the whole object is the assertion: any field that leaks
  // through the mapper fails here, including one Atlassian adds later.
  assert.deepEqual(at(result.items, 0), {
    id: '10001',
    name: 'Filter 1',
    description: 'Saved query number 1.',
    owner: { accountId: ACCOUNT_ID, displayName: 'User One' },
    jql: 'project = PR1 ORDER BY created DESC',
  });

  // Said again as a property, because this is a security boundary and not a
  // formatting preference: no key of a mapped filter may name a share scope.
  const serialized = JSON.stringify(result.items);
  for (const forbidden of [
    'sharePermissions',
    'editPermissions',
    'subscriptions',
    'sharedUsers',
    'jira-software-users',
    'viewUrl',
    'searchUrl',
    'self',
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `${forbidden} must never reach a caller`,
    );
  }
});

test('searchFilters drops an owner Jira sent without an accountId', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // synthetic — a deleted/anonymized owner in GDPR-mode Cloud.
    jiraOk({
      maxResults: 2,
      startAt: 0,
      total: 1,
      isLast: true,
      values: [
        {
          id: '10001',
          name: 'Orphaned filter',
          owner: { displayName: 'Former Employee' },
          jql: 'project = ABC',
        },
      ],
    }),
  );

  const result = await searchFilters({ jira: jira.fn, pageSize: 2 });

  assert.deepEqual(at(result.items, 0), {
    id: '10001',
    name: 'Orphaned filter',
    jql: 'project = ABC',
  });
});

test('searchFilters normalises a numeric id and tolerates a missing jql', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // synthetic — some tenants answer with a numeric id; `jql` is absent when
    // the caller (not us) dropped the expand.
    jiraOk({
      maxResults: 2,
      startAt: 0,
      total: 1,
      isLast: true,
      values: [{ id: 10001, name: 'Numeric id' }],
    }),
  );

  const result = await searchFilters({ jira: jira.fn, pageSize: 2 });

  assert.deepEqual(at(result.items, 0), { id: '10001', name: 'Numeric id' });
});

// ---------------------------------------------------------------------------
// searchFilters — paging
// ---------------------------------------------------------------------------

test('searchFilters walks classic pages until the server says isLast', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(filterPage(0, [1, 2], false)))
    .enqueue(jiraOk(filterPage(2, [3, 4], false)))
    .enqueue(jiraOk(filterPage(4, [5, 6], true)));

  const result = await searchFilters({ jira: jira.fn, pageSize: 2 });

  assert.equal(result.pages, 3);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(result.nextStartAt, undefined);
  assert.equal(result.total, 10);
  assert.deepEqual(
    jira.calls.map((call) => call.query?.startAt),
    [0, 2, 4],
  );
  assert.equal(result.items.length, 6);
});

test('searchFilters survives a page that reports no usable total', async () => {
  // `total` is optional on a PageBean and Jira has been seen sending it as a
  // string on some routes. Either way it is only a display number: the loop is
  // ended by `isLast`, and a total that is not a number is simply not reported
  // rather than turned into NaN paging arithmetic.
  const first = { ...filterPage(0, [1, 2], false), total: '10' };
  const last = { ...filterPage(2, [3], true) };
  delete last['total'];
  const jira = createFakeJiraRequest().enqueue(jiraOk(first)).enqueue(jiraOk(last));

  const result = await searchFilters({ jira: jira.fn, pageSize: 2 });

  assert.equal(result.items.length, 3);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.total, undefined);
});

test('searchFilters reports a max_pages stop as a resumable partial prefix', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(filterPage(0, [1, 2], false)));

  // One page per call is the tool-ring default (D20); this is that shape.
  const result = await searchFilters({ jira: jira.fn, pageSize: 2, maxPages: 1 });

  // A second request would throw "unexpected request" — the cap is what stopped it.
  assert.equal(jira.calls.length, 1);
  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.nextStartAt, 2);
  assert.equal(result.total, 10);
});

test('searchFilters resumes from a caller-supplied startAt', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(filterPage(2, [3, 4], true)));

  await searchFilters({ jira: jira.fn, pageSize: 2, startAt: 2 });

  assert.equal(jira.lastRequest()?.query?.startAt, 2);
});

test('searchFilters stops on the call budget before issuing a request', async () => {
  const clock = createFakeClock(1_000);
  const jira = createFakeJiraRequest();

  const result = await searchFilters({ jira: jira.fn, clock, deadlineAt: 900 });

  // Proof that BOTH halves of the BudgetGuard union reached `fetchAll`: with the
  // clock missing, the deadline could only have been a silent no-op.
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.partial, true);
  assert.equal(result.pages, 0);
  assert.deepEqual(jira.calls, []);
});

// ---------------------------------------------------------------------------
// searchFilters — guards
// ---------------------------------------------------------------------------

test('searchFilters rejects a page without a values array', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // synthetic — a proxy that rewrote the collection key.
    jiraOk({ maxResults: 2, startAt: 0, total: 1, isLast: true, filters: [] }),
  );

  const error = asJiraError(await caught(() => searchFilters({ jira: jira.fn })));

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /values/);
});

test('searchFilters rejects a filter row without an id or a name', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // synthetic
    jiraOk({ isLast: true, values: [{ name: 'No id' }] }),
  );
  const missingId = asJiraError(await caught(() => searchFilters({ jira: jira.fn })));
  assert.equal(missingId.kind, 'unexpected_shape');
  assert.match(missingId.message, /"id"/);

  const other = createFakeJiraRequest().enqueue(
    // synthetic
    jiraOk({ isLast: true, values: [{ id: '10001' }] }),
  );
  const missingName = asJiraError(await caught(() => searchFilters({ jira: other.fn })));
  assert.equal(missingName.kind, 'unexpected_shape');
  assert.match(missingName.message, /"name"/);
});

test('searchFilters rejects a body that is not a JSON object', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk('<html>proxy</html>'));

  const error = asJiraError(await caught(() => searchFilters({ jira: jira.fn })));

  assert.equal(error.kind, 'unexpected_shape');
});

// ---------------------------------------------------------------------------
// getFilter
// ---------------------------------------------------------------------------

test('getFilter reads one filter and reports favourite', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/filter/10001',
    // synthetic — GET /rest/api/3/filter/{id} returns these WITHOUT an expand.
    jiraOk({
      ...filterRow(1),
      favourite: true,
      favouritedCount: 3,
      sharedUsers: { size: 2, items: [{ accountId: ACCOUNT_ID }] },
    }),
  );

  const filter = await getFilter({ jira: jira.fn, filterId: 10001 });

  const spec = jira.lastRequest();
  assert.equal(spec?.method, 'GET');
  assert.equal(spec?.pathTemplate, FILTER_PATH_TEMPLATE);
  // No expand: the only expands this route offers are the ones we refuse.
  assert.equal(spec?.query, undefined);

  assert.deepEqual(filter, {
    id: '10001',
    name: 'Filter 1',
    description: 'Saved query number 1.',
    owner: { accountId: ACCOUNT_ID, displayName: 'User One' },
    jql: 'project = PR1 ORDER BY created DESC',
    favourite: true,
  });
  assert.equal(JSON.stringify(filter).includes('sharedUsers'), false);
});

test('getFilter accepts an id given as a string', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/filter/10001',
    jiraOk(filterRow(1)),
  );

  const filter = await getFilter({ jira: jira.fn, filterId: ' 10001 ' });

  assert.equal(filter.id, '10001');
});

test('getFilter refuses a non-numeric id without touching the wire', async () => {
  const jira = createFakeJiraRequest();

  for (const bad of ['My saved filter', '0', '-1', '10.5', '10001; DROP', '', '../10']) {
    const error = asJiraError(
      await caught(() => getFilter({ jira: jira.fn, filterId: bad })),
    );
    assert.equal(error.kind, 'validation', `expected a validation error for ${bad}`);
    assert.match(error.message, /jira_list_filters/);
  }
  assert.deepEqual(jira.calls, []);
});

test('getFilter rejects a response that is not a JSON object', async () => {
  const jira = createFakeJiraRequest().on('GET /rest/api/3/filter/10001', jiraOk([1, 2]));

  const error = asJiraError(
    await caught(() => getFilter({ jira: jira.fn, filterId: 10001 })),
  );

  assert.equal(error.kind, 'unexpected_shape');
});

test('getFilter carries the deadline and signal onto the request', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/filter/10001',
    jiraOk(filterRow(1)),
  );

  await getFilter({
    jira: jira.fn,
    filterId: 10001,
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);
});

test('an upstream failure this ring has no opinion about propagates untouched', async () => {
  const upstream = new JiraError({
    kind: 'rate_limited',
    message: 'Jira asked us to slow down.',
    retryable: true,
  });
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/filter/10001',
    jiraErr(upstream),
  );

  const error = await caught(() => getFilter({ jira: jira.fn, filterId: 10001 }));

  assert.equal(error, upstream);
});
