// Tests for api/collab.ts — the collaboration surface (WP-71).
//
// Contract tier (TESTING.md §Mocking tiers): every case drives the module
// through `fakeJiraRequest`, so no socket is involved and the assertions are
// about what this ring promises — the request it builds, the allowlist it
// narrows the response to, and the refusals it produces BEFORE a request exists.
//
// Bodies are inline plain objects marked `// synthetic`, shaped field-for-field
// like real Jira Cloud v3 responses and using the placeholder vocabulary the
// fixture PII lint enforces (`example.atlassian.net`, `5b10a2…`-style
// accountIds).
//
// Three groups of cases are load-bearing rather than incidental:
//
//  * the PARTIAL PUT cases, which assert with `deepEqual` on the whole body that
//    ONLY the named fields travel — a leaked `undefined`-valued key would clear
//    a stored value on the tenant's side;
//  * the ALLOWLIST cases, likewise whole-object `deepEqual`, because a field
//    Atlassian adds tomorrow must not reach a model by default;
//  * the "withheld vs empty" watcher case, where a 200 without a `watchers`
//    array means "you may not see them", not "nobody watches this".

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { createJiraError } from '../core/errors.js';
import { JiraError } from '../core/types.js';
import {
  COLLAB_PAGE_SIZE,
  COMPONENT_PATH_TEMPLATE,
  PROJECT_COMPONENTS_PATH_TEMPLATE,
  PROJECT_ROLES_PATH_TEMPLATE,
  PROJECT_ROLE_PATH_TEMPLATE,
  PROJECT_VERSIONS_PATH_TEMPLATE,
  VERSION_PATH_TEMPLATE,
  VOTES_PATH_TEMPLATE,
  WATCHERS_PATH_TEMPLATE,
  addVote,
  addWatcher,
  createComponent,
  createVersion,
  getProjectRole,
  listComponents,
  listProjectRoles,
  listVersions,
  listWatchers,
  removeVote,
  removeWatcher,
  updateComponent,
  updateVersion,
} from './collab.js';

const SITE = 'https://example.atlassian.net';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';
const OTHER_ACCOUNT_ID = '5b10ac8d82e05b22cc7d4ef5';

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

/** One user, as Jira embeds it everywhere on this surface. // synthetic */
function userRow(accountId: string, displayName: string): Record<string, unknown> {
  return {
    self: `${SITE}/rest/api/3/user?accountId=${accountId}`,
    accountId,
    displayName,
    active: true,
    // Everything below must never reach a caller.
    emailAddress: 'user@example.com',
    timeZone: 'Europe/Sofia',
    accountType: 'atlassian',
    avatarUrls: { '48x48': `${SITE}/secure/useravatar?size=large` },
  };
}

/** One `/project/{key}/component` row. // synthetic */
function componentRow(index: number): Record<string, unknown> {
  const id = String(10100 + index);
  return {
    self: `${SITE}/rest/api/3/component/${id}`,
    id,
    name: `Component ${index}`,
    description: `Owns area ${index}.`,
    lead: userRow(ACCOUNT_ID, 'User One'),
    assigneeType: 'PROJECT_LEAD',
    assignee: userRow(ACCOUNT_ID, 'User One'),
    realAssigneeType: 'PROJECT_LEAD',
    realAssignee: userRow(ACCOUNT_ID, 'User One'),
    isAssigneeTypeValid: false,
    project: 'ABC',
    projectId: 10000,
  };
}

/** One `/project/{key}/version` row. // synthetic */
function versionRow(index: number): Record<string, unknown> {
  const id = String(10200 + index);
  return {
    self: `${SITE}/rest/api/3/version/${id}`,
    id,
    description: `Release ${index}.`,
    name: `1.${index}.0`,
    archived: false,
    released: index === 1,
    startDate: '2026-01-05',
    releaseDate: '2026-03-31',
    overdue: false,
    userStartDate: '05/Jan/26',
    userReleaseDate: '31/Mar/26',
    projectId: 10000,
    operations: [{ id: 'edit-version', label: 'Edit' }],
  };
}

/**
 * One classic page (PageBean). `maxResults` is the page's own length so a page
 * reads as FULL — a short page is one of the loop's stop conditions, and a
 * fixture that is accidentally short would end the loop for the wrong reason.
 * // synthetic
 */
function page(
  startAt: number,
  values: readonly Record<string, unknown>[],
  isLast: boolean,
  total = 100,
): Record<string, unknown> {
  return {
    self: `${SITE}/rest/api/3/x`,
    maxResults: Math.max(values.length, 1),
    startAt,
    total,
    isLast,
    values,
  };
}

// ---------------------------------------------------------------------------
// listWatchers
// ---------------------------------------------------------------------------

test('listWatchers reads the issue watcher route and allowlists each watcher', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({
      self: `${SITE}/rest/api/3/issue/ABC-1/watchers`,
      isWatching: true,
      watchCount: 2,
      watchers: [
        userRow(ACCOUNT_ID, 'User One'),
        userRow(OTHER_ACCOUNT_ID, 'User Two'),
        // GDPR-mode Cloud never sends this, but a mapper that half-reports an
        // unaddressable user is worse than one that drops it.
        { displayName: 'Legacy User', name: 'legacy' },
      ],
    }),
  );

  const result = await listWatchers({ jira: jira.fn, issue: 'ABC-1' });

  assert.deepEqual(jira.routes(), ['GET /rest/api/3/issue/ABC-1/watchers']);
  assert.equal(jira.lastRequest()?.method, 'GET');
  assert.equal(jira.lastRequest()?.pathTemplate, WATCHERS_PATH_TEMPLATE);
  assert.deepEqual(result, {
    isWatching: true,
    watchCount: 2,
    watchersVisible: true,
    watchers: [
      { accountId: ACCOUNT_ID, displayName: 'User One', active: true },
      { accountId: OTHER_ACCOUNT_ID, displayName: 'User Two', active: true },
    ],
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of ['emailAddress', 'avatarUrls', 'timeZone', 'self', 'legacy']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} leaked into the watchers`);
  }
});

test('listWatchers separates a withheld watcher list from an empty one', async () => {
  const jira = createFakeJiraRequest()
    // No `watchers` key at all: the caller lacks "View voters and watchers".
    .enqueue(jiraOk({ isWatching: false, watchCount: 4 }))
    .enqueue(jiraOk({ isWatching: false, watchCount: 0, watchers: [] }));

  const withheld = await listWatchers({ jira: jira.fn, issue: 'ABC-1' });
  const empty = await listWatchers({ jira: jira.fn, issue: 'ABC-1' });

  assert.equal(withheld.watchersVisible, false);
  assert.deepEqual(withheld.watchers, []);
  assert.equal(withheld.watchCount, 4);
  assert.equal(empty.watchersVisible, true);
  assert.equal(empty.watchCount, 0);
});

test('listWatchers rejects a body that is not an object', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk('nope'));

  const error = asJiraError(
    await caught(() => listWatchers({ jira: jira.fn, issue: 'A-1' })),
  );

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /watcher list that is not a JSON object/);
});

test('listWatchers refuses an empty issue key before any request', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => listWatchers({ jira: jira.fn, issue: '  ' })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /Nothing was sent\./);
  assert.deepEqual(jira.routes(), []);
});

test('listWatchers refuses a traversal segment in the issue key', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => listWatchers({ jira: jira.fn, issue: '../../admin' })),
  );

  assert.equal(error.kind, 'validation');
  assert.deepEqual(jira.routes(), []);
});

test('listWatchers carries the caller signal and deadline onto the request', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(jiraOk({ watchCount: 0, watchers: [] }));

  await listWatchers({
    jira: jira.fn,
    issue: 'ABC-1',
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);
});

// ---------------------------------------------------------------------------
// Watcher writes
// ---------------------------------------------------------------------------

test('addWatcher POSTs the accountId as a bare JSON string body', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(undefined, { status: 204 }));

  const result = await addWatcher({
    jira: jira.fn,
    issue: 'ABC-1',
    accountId: `  ${ACCOUNT_ID}  `,
  });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['POST /rest/api/3/issue/ABC-1/watchers']);
  assert.equal(spec?.pathTemplate, WATCHERS_PATH_TEMPLATE);
  // The body is the string itself — `core/http.ts` stringifies it into `"5b10…"`.
  assert.equal(spec?.body, ACCOUNT_ID);
  assert.equal(JSON.stringify(spec?.body), `"${ACCOUNT_ID}"`);
  assert.equal(spec?.query, undefined);
  // `safe` is never set on a write: an unsafe write is not replayed.
  assert.equal(spec?.safe, undefined);
  assert.deepEqual(result, { issue: 'ABC-1', accountId: ACCOUNT_ID, status: 204 });
});

test('removeWatcher DELETEs with the accountId in the query, not the body', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(undefined, { status: 204 }));

  const result = await removeWatcher({
    jira: jira.fn,
    issue: 'ABC-1',
    accountId: ACCOUNT_ID,
    signal: new AbortController().signal,
    clock: createFakeClock(0),
    deadlineAt: 9_000,
  });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['DELETE /rest/api/3/issue/ABC-1/watchers']);
  assert.deepEqual(spec?.query, { accountId: ACCOUNT_ID });
  assert.equal(spec?.body, undefined);
  assert.equal(spec?.deadlineAt, 9_000);
  assert.equal(result.accountId, ACCOUNT_ID);
});

test('watcher writes refuse a blank accountId before any request', async () => {
  const jira = createFakeJiraRequest();

  const add = asJiraError(
    await caught(() => addWatcher({ jira: jira.fn, issue: 'ABC-1', accountId: '' })),
  );
  const remove = asJiraError(
    await caught(() => removeWatcher({ jira: jira.fn, issue: 'ABC-1', accountId: '  ' })),
  );

  assert.equal(add.kind, 'validation');
  assert.match(add.message, /accountId is required/);
  assert.match(add.message, /accountId only/);
  assert.equal(remove.kind, 'validation');
  assert.deepEqual(jira.routes(), []);
});

test('a 404 on a watcher write names the "Manage watchers" permission', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({
        kind: 'not_found',
        reason: 'Jira could not find issue ABC-1.',
        remediation: 'Check the key.',
        httpStatus: 404,
        jiraMessages: ['Issue does not exist or you do not have permission to see it.'],
        detail: 'issue',
      }),
    ),
  );

  const error = asJiraError(
    await caught(() =>
      addWatcher({ jira: jira.fn, issue: 'ABC-1', accountId: ACCOUNT_ID }),
    ),
  );

  assert.equal(error.kind, 'not_found');
  assert.equal(error.httpStatus, 404);
  assert.match(error.message, /Manage watchers/);
  // The upstream remediation is kept, once, ahead of the added sentence.
  assert.match(error.message ?? '', /Check the key\. Watching on someone/);
  assert.equal((error.message.match(/Check the key\./g) ?? []).length, 1);
  assert.deepEqual(error.jiraMessages, [
    'Issue does not exist or you do not have permission to see it.',
  ]);
  assert.equal(error.detail, 'issue');
  assert.equal(error.cause instanceof JiraError, true);
});

test('a 403 read failure names "View voters and watchers"', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({ kind: 'permission', reason: 'Forbidden.', httpStatus: 403 }),
    ),
  );

  const error = asJiraError(
    await caught(() => listWatchers({ jira: jira.fn, issue: 'A-1' })),
  );

  assert.equal(error.kind, 'permission');
  assert.match(error.message, /View voters and watchers/);
});

test('errors that are not a 403 or 404 permission case pass through untouched', async () => {
  const rate = createJiraError({
    kind: 'rate_limited',
    reason: 'Slow down.',
    httpStatus: 429,
  });
  const auth = createJiraError({
    kind: 'auth',
    reason: 'Token expired.',
    httpStatus: 403,
  });
  const plain = new Error('socket hang up');
  const jira = createFakeJiraRequest()
    .enqueue(jiraErr(rate))
    .enqueue(jiraErr(auth))
    .enqueue(jiraErr(plain));

  assert.equal(await caught(() => listWatchers({ jira: jira.fn, issue: 'A-1' })), rate);
  assert.equal(await caught(() => listWatchers({ jira: jira.fn, issue: 'A-1' })), auth);
  assert.equal(await caught(() => listWatchers({ jira: jira.fn, issue: 'A-1' })), plain);
});

test('a permission error with no remediation of its own gets the hint alone', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // Built directly, not through `createJiraError`, because that helper always
    // supplies a per-kind default remediation — this is the bare-error case.
    jiraErr(new JiraError({ kind: 'not_found', message: 'Gone.', httpStatus: 404 })),
  );

  const error = asJiraError(
    await caught(() => listWatchers({ jira: jira.fn, issue: 'A-1' })),
  );

  assert.equal(error.message.startsWith('Gone. '), true);
  assert.match(error.message, /View voters and watchers/);
});

test('CC-96: a 401 refusing project configuration is permission, not auth', async () => {
  // What a live tenant answers for an account that is not a project admin: the
  // role route 401s, on company-managed and team-managed projects alike, while
  // every other call in the same session succeeds on the same credentials.
  const jira = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({
        kind: 'auth',
        reason: 'Jira rejected GET /project/{projectIdOrKey}/role with HTTP 401.',
        remediation:
          'Check JIRA_EMAIL and JIRA_API_TOKEN. Atlassian API tokens expire within a year — regenerate the token at id.atlassian.com if it has.',
        httpStatus: 401,
        jiraMessages: ['You cannot edit the configuration of this project.'],
        detail: 'project',
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => listProjectRoles({ jira: jira.fn, project: 'ABC' })),
  );

  assert.equal(error.kind, 'permission');
  assert.equal(error.httpStatus, 401);
  assert.match(error.message, /Administer projects/);
  // The credentials advice must not survive in any form: acting on it costs the
  // user a working token and leaves the refusal exactly as it was.
  assert.doesNotMatch(error.message, /id\.atlassian\.com/);
  assert.doesNotMatch(error.remediation ?? '', /id\.atlassian\.com/);
  assert.deepEqual(error.jiraMessages, [
    'You cannot edit the configuration of this project.',
  ]);
  assert.equal(error.detail, 'project');
  assert.equal(error.cause instanceof JiraError, true);
});

test('CC-96: an ordinary 401 on the same route keeps its auth kind', async () => {
  // The rewrite is keyed on Jira's sentence, not on the status, because a
  // genuinely expired token reaches this route with a 401 too — and there the
  // "regenerate the token" remediation is the correct instruction.
  const expired = createJiraError({
    kind: 'auth',
    reason: 'Jira rejected GET /project/{projectIdOrKey}/role with HTTP 401.',
    httpStatus: 401,
    jiraMessages: ['Client must be authenticated to access this resource.'],
  });
  const jira = createFakeJiraRequest().enqueue(jiraErr(expired));

  assert.equal(
    await caught(() => listProjectRoles({ jira: jira.fn, project: 'ABC' })),
    expired,
  );
});

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

test('addVote and removeVote hit the self-only vote route with no body', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(undefined, { status: 204 }))
    .enqueue(jiraOk(undefined, { status: 204 }));

  const added = await addVote({ jira: jira.fn, issue: 'ABC-1' });
  const removed = await removeVote({ jira: jira.fn, issue: 'ABC-1' });

  assert.deepEqual(jira.routes(), [
    'POST /rest/api/3/issue/ABC-1/votes',
    'DELETE /rest/api/3/issue/ABC-1/votes',
  ]);
  for (const spec of jira.calls) {
    assert.equal(spec.pathTemplate, VOTES_PATH_TEMPLATE);
    // No body and no accountId anywhere: the vote is always the caller's own.
    assert.equal(spec.body, undefined);
    assert.equal(spec.query, undefined);
    assert.equal(spec.safe, undefined);
  }
  assert.deepEqual(added, { issue: 'ABC-1', status: 204 });
  assert.deepEqual(removed, { issue: 'ABC-1', status: 204 });
});

test('a vote failure explains the reporter and resolution rules', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({
        kind: 'not_found',
        reason: 'Jira could not find issue ABC-1.',
        httpStatus: 404,
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => addVote({ jira: jira.fn, issue: 'ABC-1' })),
  );

  assert.match(error.message, /cannot vote on an issue you reported/);
});

// ---------------------------------------------------------------------------
// listComponents
// ---------------------------------------------------------------------------

test('listComponents pages the singular component route and allowlists rows', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(page(0, [componentRow(1), componentRow(2)], false)))
    .enqueue(jiraOk(page(2, [componentRow(3)], true)));

  const result = await listComponents({ jira: jira.fn, project: 'ABC', pageSize: 2 });

  assert.deepEqual(jira.routes(), [
    'GET /rest/api/3/project/ABC/component',
    'GET /rest/api/3/project/ABC/component',
  ]);
  assert.equal(jira.calls[0]?.pathTemplate, PROJECT_COMPONENTS_PATH_TEMPLATE);
  assert.deepEqual(jira.calls[0]?.query, { startAt: 0, maxResults: 2, query: undefined });
  assert.equal(jira.calls[1]?.query?.startAt, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.pages, 2);
  assert.deepEqual(at(result.items, 0), {
    id: '10101',
    name: 'Component 1',
    description: 'Owns area 1.',
    project: 'ABC',
    projectId: 10000,
    lead: { accountId: ACCOUNT_ID, displayName: 'User One', active: true },
    assigneeType: 'PROJECT_LEAD',
    isAssigneeTypeValid: false,
  });
  const serialized = JSON.stringify(result.items);
  for (const forbidden of ['realAssignee', 'avatarUrls', 'self', 'emailAddress']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} leaked into a component`);
  }
});

test('listComponents forwards a trimmed query and omits a blank one', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(page(0, [], true)))
    .enqueue(jiraOk(page(0, [], true)));

  await listComponents({ jira: jira.fn, project: 'ABC', query: '  api  ' });
  assert.equal(jira.lastRequest()?.query?.query, 'api');
  assert.equal(jira.lastRequest()?.query?.maxResults, COLLAB_PAGE_SIZE);

  await listComponents({ jira: jira.fn, project: 'ABC', query: '   ' });
  assert.equal(jira.lastRequest()?.query?.query, undefined);
});

test('listComponents honours startAt, maxPages, signal and the call budget', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(page(20, [componentRow(1), componentRow(2)], false)),
  );

  const result = await listComponents({
    jira: jira.fn,
    project: '10000',
    pageSize: 2,
    startAt: 20,
    maxPages: 1,
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 60_000,
  });

  assert.equal(jira.lastRequest()?.query?.startAt, 20);
  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 60_000);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.nextStartAt, 22);
});

test('listComponents rejects a page without a values array', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ startAt: 0, isLast: true }));

  const error = asJiraError(
    await caught(() => listComponents({ jira: jira.fn, project: 'ABC' })),
  );

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /component page arrived without a "values" array/);
});

test('listComponents rejects a row that is missing its id or name', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(page(0, [{ name: 'No id' }], true)))
    .enqueue(jiraOk(page(0, [{ id: '10101' }], true)))
    .enqueue(
      jiraOk(page(0, ['not a row'] as unknown as Record<string, unknown>[], true)),
    );

  const noId = asJiraError(
    await caught(() => listComponents({ jira: jira.fn, project: 'A' })),
  );
  const noName = asJiraError(
    await caught(() => listComponents({ jira: jira.fn, project: 'A' })),
  );
  const notARow = asJiraError(
    await caught(() => listComponents({ jira: jira.fn, project: 'A' })),
  );

  assert.match(noId.message, /component without a usable "id"/);
  assert.match(noName.message, /component without a usable "name"/);
  assert.match(notARow.message, /component row #0 that is not a JSON object/);
});

test('listComponents refuses a blank project before any request', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => listComponents({ jira: jira.fn, project: '' })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /jira_list_projects/);
  assert.deepEqual(jira.routes(), []);
});

// ---------------------------------------------------------------------------
// Component writes
// ---------------------------------------------------------------------------

test('createComponent posts the project KEY in the body and plain-text description', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(componentRow(1), { status: 201 }));

  const result = await createComponent({
    jira: jira.fn,
    project: 'ABC',
    name: '  Billing  ',
    description: 'Invoices and dunning.',
    leadAccountId: ACCOUNT_ID,
    assigneeType: 'COMPONENT_LEAD',
  });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['POST /rest/api/3/component']);
  // A constant route carries no pathTemplate.
  assert.equal(spec?.pathTemplate, undefined);
  assert.deepEqual(spec?.body, {
    name: 'Billing',
    project: 'ABC',
    description: 'Invoices and dunning.',
    leadAccountId: ACCOUNT_ID,
    assigneeType: 'COMPONENT_LEAD',
  });
  // The description travels as a string — no ADF document, no `format` field.
  assert.equal(typeof (spec?.body as { description: unknown }).description, 'string');
  assert.equal(result.status, 201);
  assert.equal(result.component.id, '10101');
});

test('createComponent sends only the fields it was given', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(componentRow(1)));

  await createComponent({ jira: jira.fn, project: 'ABC', name: 'Billing' });

  assert.deepEqual(jira.lastRequest()?.body, { name: 'Billing', project: 'ABC' });
});

test('createComponent refuses a blank name or project and a blank lead', async () => {
  const jira = createFakeJiraRequest();

  const noName = asJiraError(
    await caught(() => createComponent({ jira: jira.fn, project: 'ABC', name: ' ' })),
  );
  const noProject = asJiraError(
    await caught(() => createComponent({ jira: jira.fn, project: '', name: 'Billing' })),
  );
  const badLead = asJiraError(
    await caught(() =>
      createComponent({ jira: jira.fn, project: 'ABC', name: 'B', leadAccountId: ' ' }),
    ),
  );

  assert.match(noName.message, /component name is required/);
  assert.match(noProject.message, /project key is required/);
  assert.match(badLead.message, /leadAccountId is required/);
  assert.deepEqual(jira.routes(), []);
});

test('updateComponent PUTs ONLY the fields it was given', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(componentRow(1)));

  await updateComponent({ jira: jira.fn, componentId: '10101', name: 'Billing v2' });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['PUT /rest/api/3/component/10101']);
  assert.equal(spec?.pathTemplate, COMPONENT_PATH_TEMPLATE);
  // deepEqual on the whole body: an omitted field must not appear at all.
  assert.deepEqual(spec?.body, { name: 'Billing v2' });
  assert.deepEqual(Object.keys(spec?.body as object), ['name']);
});

test('updateComponent treats an empty description as an explicit clear', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(componentRow(1)));

  await updateComponent({
    jira: jira.fn,
    componentId: 10101,
    description: '',
    leadAccountId: OTHER_ACCOUNT_ID,
    assigneeType: 'UNASSIGNED',
  });

  assert.deepEqual(jira.lastRequest()?.body, {
    description: '',
    leadAccountId: OTHER_ACCOUNT_ID,
    assigneeType: 'UNASSIGNED',
  });
});

test('updateComponent refuses an empty change and a non-numeric id', async () => {
  const jira = createFakeJiraRequest();

  const empty = asJiraError(
    await caught(() => updateComponent({ jira: jira.fn, componentId: '10101' })),
  );
  const badId = asJiraError(
    await caught(() =>
      updateComponent({ jira: jira.fn, componentId: 'Billing', name: 'x' }),
    ),
  );

  assert.equal(empty.kind, 'validation');
  assert.match(empty.message, /at least one field to change\. Nothing was sent\./);
  assert.match(empty.message, /omitted fields keep their current value/);
  assert.equal(badId.kind, 'validation');
  assert.match(badId.message, /componentId must be a positive integer Jira id/);
  assert.match(badId.message, /jira_list_components/);
  assert.deepEqual(jira.routes(), []);
});

test('a component write failure names the project-admin permission', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({ kind: 'permission', reason: 'Forbidden.', httpStatus: 403 }),
    ),
  );

  const error = asJiraError(
    await caught(() => createComponent({ jira: jira.fn, project: 'ABC', name: 'B' })),
  );

  assert.match(error.message, /Administer projects/);
});

test('a component write that answers with a non-object body is unexpected_shape', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([1, 2, 3]));

  const error = asJiraError(
    await caught(() => createComponent({ jira: jira.fn, project: 'ABC', name: 'B' })),
  );

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /component that is not a JSON object/);
});

// ---------------------------------------------------------------------------
// listVersions
// ---------------------------------------------------------------------------

test('listVersions pages the singular version route and allowlists rows', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(page(0, [versionRow(1)], true)));

  const result = await listVersions({
    jira: jira.fn,
    project: 'ABC',
    pageSize: 2,
    status: ['released', 'unreleased'],
    query: '1.',
  });

  assert.deepEqual(jira.routes(), ['GET /rest/api/3/project/ABC/version']);
  assert.equal(jira.lastRequest()?.pathTemplate, PROJECT_VERSIONS_PATH_TEMPLATE);
  assert.deepEqual(jira.lastRequest()?.query, {
    startAt: 0,
    maxResults: 2,
    query: '1.',
    status: 'released,unreleased',
  });
  assert.deepEqual(at(result.items, 0), {
    id: '10201',
    name: '1.1.0',
    description: 'Release 1.',
    projectId: 10000,
    archived: false,
    released: true,
    startDate: '2026-01-05',
    releaseDate: '2026-03-31',
    overdue: false,
  });
  // The locale-rendered duplicates of the same dates never travel.
  const serialized = JSON.stringify(result.items);
  for (const forbidden of ['userStartDate', 'userReleaseDate', 'operations', 'self']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} leaked into a version`);
  }
});

test('listVersions omits an empty status filter rather than sending an empty string', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk(page(0, [], true)))
    .enqueue(jiraOk(page(0, [], true)));

  await listVersions({ jira: jira.fn, project: 'ABC', status: [] });
  assert.equal(jira.lastRequest()?.query?.status, undefined);

  await listVersions({ jira: jira.fn, project: 'ABC' });
  assert.equal(jira.lastRequest()?.query?.status, undefined);
});

test('listVersions rejects a row that is missing its name', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(page(0, [{ id: '10201' }], true)));

  const error = asJiraError(
    await caught(() => listVersions({ jira: jira.fn, project: 'A' })),
  );

  assert.match(error.message, /version without a usable "name"/);
});

// ---------------------------------------------------------------------------
// Version writes
// ---------------------------------------------------------------------------

test('createVersion posts the NUMERIC projectId and verbatim calendar dates', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(versionRow(1), { status: 201 }));

  const result = await createVersion({
    jira: jira.fn,
    projectId: '10000',
    name: '1.4.0',
    description: 'Spring release.',
    startDate: ' 2026-01-05 ',
    releaseDate: '2026-03-31',
    released: false,
    archived: false,
  });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['POST /rest/api/3/version']);
  assert.deepEqual(spec?.body, {
    name: '1.4.0',
    projectId: 10000,
    description: 'Spring release.',
    startDate: '2026-01-05',
    releaseDate: '2026-03-31',
    released: false,
    archived: false,
  });
  // `projectId` is a number on the wire, not the string the caller may pass.
  assert.equal(typeof (spec?.body as { projectId: unknown }).projectId, 'number');
  assert.equal(result.version.name, '1.1.0');
  assert.equal(result.status, 201);
});

test('createVersion refuses a project KEY where the numeric id belongs', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => createVersion({ jira: jira.fn, projectId: 'ABC', name: '1.0.0' })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /projectId must be a positive integer Jira id/);
  assert.match(error.message, /jira_get_project/);
  assert.deepEqual(jira.routes(), []);
});

test('CC-51: createVersion refuses a timestamp where a calendar date belongs', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() =>
      createVersion({
        jira: jira.fn,
        projectId: 10000,
        name: '1.0.0',
        releaseDate: '2026-03-31T00:00:00.000Z',
      }),
    ),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /YYYY-MM-DD/);
  assert.match(error.message, /Nothing was sent\./);
  assert.deepEqual(jira.routes(), []);
});

test('createVersion refuses a blank name', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => createVersion({ jira: jira.fn, projectId: 10000, name: '  ' })),
  );

  assert.match(error.message, /version name is required/);
});

test('updateVersion PUTs ONLY the fields it was given', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(versionRow(1)));

  await updateVersion({ jira: jira.fn, versionId: 10201, released: true });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['PUT /rest/api/3/version/10201']);
  assert.equal(spec?.pathTemplate, VERSION_PATH_TEMPLATE);
  assert.deepEqual(spec?.body, { released: true });
  assert.deepEqual(Object.keys(spec?.body as object), ['released']);
});

test('updateVersion can un-release and archive in one partial body', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(versionRow(1)));

  await updateVersion({
    jira: jira.fn,
    versionId: '10201',
    name: '1.1.1',
    description: '',
    startDate: '2026-02-01',
    releaseDate: '2026-04-30',
    released: false,
    archived: true,
  });

  assert.deepEqual(jira.lastRequest()?.body, {
    name: '1.1.1',
    description: '',
    startDate: '2026-02-01',
    releaseDate: '2026-04-30',
    released: false,
    archived: true,
  });
});

test('updateVersion refuses an empty change and a non-numeric id', async () => {
  const jira = createFakeJiraRequest();

  const empty = asJiraError(
    await caught(() => updateVersion({ jira: jira.fn, versionId: 10201 })),
  );
  const badId = asJiraError(
    await caught(() =>
      updateVersion({ jira: jira.fn, versionId: '1.4.0', released: true }),
    ),
  );
  const badName = asJiraError(
    await caught(() => updateVersion({ jira: jira.fn, versionId: 10201, name: ' ' })),
  );

  assert.match(empty.message, /at least one field to change/);
  assert.match(empty.message, /released or archived/);
  assert.match(badId.message, /versionId must be a positive integer Jira id/);
  assert.match(badId.message, /jira_list_versions/);
  assert.match(badName.message, /version name is required/);
  assert.deepEqual(jira.routes(), []);
});

test('updateVersion rejects a response body that is not an object', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(null));

  const error = asJiraError(
    await caught(() =>
      updateVersion({ jira: jira.fn, versionId: 10201, released: true }),
    ),
  );

  assert.equal(error.kind, 'unexpected_shape');
  assert.match(error.message, /version that is not a JSON object/);
});

// ---------------------------------------------------------------------------
// Project roles
// ---------------------------------------------------------------------------

test('listProjectRoles flattens the name-to-URL map into sorted id/name rows', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // synthetic — this endpoint really does answer with a bare object map.
    jiraOk({
      Developers: `${SITE}/rest/api/3/project/ABC/role/10001`,
      Administrators: `${SITE}/rest/api/3/project/ABC/role/10002`,
    }),
  );

  const roles = await listProjectRoles({ jira: jira.fn, project: 'ABC' });

  assert.deepEqual(jira.routes(), ['GET /rest/api/3/project/ABC/role']);
  assert.equal(jira.lastRequest()?.pathTemplate, PROJECT_ROLES_PATH_TEMPLATE);
  assert.deepEqual(roles, [
    { id: '10002', name: 'Administrators' },
    { id: '10001', name: 'Developers' },
  ]);
});

test('listProjectRoles rejects a map whose values are not role URLs', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ Developers: 10001 }))
    .enqueue(jiraOk({ Developers: `${SITE}/rest/api/3/project/ABC/role/latest` }));

  const notString = asJiraError(
    await caught(() => listProjectRoles({ jira: jira.fn, project: 'ABC' })),
  );
  const notNumeric = asJiraError(
    await caught(() => listProjectRoles({ jira: jira.fn, project: 'ABC' })),
  );

  assert.equal(notString.kind, 'unexpected_shape');
  assert.match(notString.message, /"Developers" is not a URL string/);
  assert.match(notNumeric.message, /does not end in a numeric role id/);
});

test('getProjectRole allowlists actors and reports groups without an accountId', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // synthetic
    jiraOk({
      self: `${SITE}/rest/api/3/project/ABC/role/10002`,
      name: 'Administrators',
      id: 10002,
      description: 'A project role that represents administrators.',
      actors: [
        {
          id: 10240,
          displayName: 'User One',
          type: 'atlassian-user-role-actor',
          actorUser: { accountId: ACCOUNT_ID },
          avatarUrl: `${SITE}/secure/useravatar?size=xsmall`,
        },
        {
          id: 10241,
          displayName: 'jira-administrators',
          type: 'atlassian-group-role-actor',
          name: 'jira-administrators',
          actorGroup: {
            name: 'jira-administrators',
            groupId: '952d12c3-5b5b-4d04-bb32-44d383afc4b2',
          },
        },
      ],
      scope: { type: 'PROJECT', project: { id: '10000' } },
    }),
  );

  const role = await getProjectRole({ jira: jira.fn, project: 'ABC', roleId: '10002' });

  assert.deepEqual(jira.routes(), ['GET /rest/api/3/project/ABC/role/10002']);
  assert.equal(jira.lastRequest()?.pathTemplate, PROJECT_ROLE_PATH_TEMPLATE);
  assert.deepEqual(role, {
    id: '10002',
    name: 'Administrators',
    description: 'A project role that represents administrators.',
    actors: [
      {
        type: 'atlassian-user-role-actor',
        accountId: ACCOUNT_ID,
        displayName: 'User One',
      },
      { type: 'atlassian-group-role-actor', displayName: 'jira-administrators' },
    ],
  });
  const serialized = JSON.stringify(role);
  for (const forbidden of ['groupId', 'avatarUrl', 'scope', 'self', '10240']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} leaked into a role`);
  }
});

test('getProjectRole falls back to the requested id and tolerates no actors', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ name: 'Developers' }));

  const role = await getProjectRole({ jira: jira.fn, project: 'ABC', roleId: 10001 });

  assert.deepEqual(role, { id: '10001', name: 'Developers', actors: [] });
});

test('getProjectRole rejects a bad role id, a bad actors array and a nameless role', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ name: 'Developers', actors: 'many' }))
    .enqueue(jiraOk({ name: 'Developers', actors: ['nope'] }))
    .enqueue(jiraOk({ name: 'Developers', actors: [{ displayName: 'User One' }] }))
    .enqueue(jiraOk({ id: 10001 }));

  const badId = asJiraError(
    await caught(() => getProjectRole({ jira: jira.fn, project: 'ABC', roleId: 'Devs' })),
  );
  const badActors = asJiraError(
    await caught(() => getProjectRole({ jira: jira.fn, project: 'ABC', roleId: 10001 })),
  );
  const badActor = asJiraError(
    await caught(() => getProjectRole({ jira: jira.fn, project: 'ABC', roleId: 10001 })),
  );
  const noType = asJiraError(
    await caught(() => getProjectRole({ jira: jira.fn, project: 'ABC', roleId: 10001 })),
  );
  const noName = asJiraError(
    await caught(() => getProjectRole({ jira: jira.fn, project: 'ABC', roleId: 10001 })),
  );

  assert.equal(badId.kind, 'validation');
  assert.match(badId.message, /roleId must be a positive integer Jira id/);
  assert.match(badId.message, /jira_list_project_roles/);
  assert.match(badActors.message, /"actors" is not an array/);
  assert.match(badActor.message, /project role actor #0 that is not a JSON object/);
  assert.match(noType.message, /project role actor without a usable "type"/);
  assert.match(noName.message, /project role without a usable "name"/);
});

test('a role read failure names the project-administration permission', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({
        kind: 'not_found',
        reason: 'Jira could not find project ABC.',
        httpStatus: 404,
      }),
    ),
  );

  const error = asJiraError(
    await caught(() => listProjectRoles({ jira: jira.fn, project: 'ABC' })),
  );

  assert.match(error.message, /Administer projects/);
  assert.match(error.message, /404/);
});
