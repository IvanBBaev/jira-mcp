// Tests for the `users` tool package (WP-34): `jira_search_users`.
//
// Contract tier — a fake `JiraRequestFn` that answers programmed routes and
// THROWS on anything else, so "the tool called the wrong endpoint" surfaces as a
// loud failure rather than a quietly empty result. The response bodies are
// inline plain objects marked `// synthetic` (no fixtures exist until WP-41),
// hand-shaped from JIRA-API.md with the TESTING.md placeholder vocabulary.
//
// What these tests pin down:
//   * THREAT-MODEL.md §PII — `emailAddress` is dropped unless the caller asked;
//   * CC-19 — a GDPR-masked email is a NORMAL result carrying `email_hidden`;
//   * O-5 / D26 — `issue`/`project` switch to the assignable endpoint, and
//     `issue` wins when both are given;
//   * a page-cap stop is a resume cursor, NEVER the `truncated` hint;
//   * the annotation quadruple, the absence of `writeTier`, and a strict schema.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraOk,
} from '../core/fakes/index.js';
import type { JiraRequestFn } from '../core/types.js';
import type { ToolCtx, ToolResult } from '../mcp/types.js';
import { searchUsersTool, usersPackage } from './users.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SEARCH_ROUTE = 'GET /rest/api/3/user/search';
const ASSIGNABLE_ROUTE = 'GET /rest/api/3/user/assignable/search';

/** A user row as Jira sends it — avatars, `self` and `accountType` included. */
function userRow(accountId: string, extra: Record<string, unknown> = {}): unknown {
  // synthetic — shape of GET /rest/api/3/user/search rows
  return {
    self: `https://example.atlassian.net/rest/api/3/user?accountId=${accountId}`,
    accountId,
    displayName: 'Ada Example',
    active: true,
    accountType: 'atlassian',
    timeZone: 'Europe/Sofia',
    locale: 'en_US',
    avatarUrls: { '48x48': 'https://example.atlassian.net/avatar/48' },
    ...extra,
  };
}

/** The tool context the registry builds, with every seam faked. */
function createCtx(jira: JiraRequestFn): ToolCtx {
  const clock = createFakeClock(1_000);
  return {
    jira,
    log: createFakeLogger({ clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 100_000, maxPages: 20 },
    deadlineAt: 61_000,
  };
}

/** Unwrap a successful envelope, failing loudly (with the error) when it is not. */
function dataOf<T>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  if (result.data === undefined) throw new Error('ok result carried no data');
  return result.data;
}

function hintCodes(result: ToolResult<unknown>): readonly string[] {
  return (result.hints ?? []).map((hint) => hint.code);
}

// ---------------------------------------------------------------------------
// Email is opt-in (THREAT-MODEL.md §PII)
// ---------------------------------------------------------------------------

test('jira_search_users drops emailAddress unless includeEmail was asked for', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([
      userRow('5b10a2844c20165700ede21g', { emailAddress: 'ada@example.invalid' }),
    ]),
  );

  const result = await searchUsersTool.handler({ query: 'ada' }, createCtx(fake.fn));
  const data = dataOf(result);

  assert.equal(data.count, 1);
  assert.deepEqual(data.users, [
    { accountId: '5b10a2844c20165700ede21g', displayName: 'Ada Example', active: true },
  ]);
  assert.equal(data.emailIncluded, false);
  assert.ok(!JSON.stringify(data).includes('example.invalid'));
  // Everything Jira sent beyond the documented shape is dropped too.
  assert.ok(!JSON.stringify(data).includes('accountType'));
  assert.deepEqual(hintCodes(result), []);
});

test('jira_search_users returns emailAddress with includeEmail: true', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([
      userRow('5b10a2844c20165700ede21g', { emailAddress: 'ada@example.invalid' }),
    ]),
  );

  const result = await searchUsersTool.handler(
    { query: 'ada', includeEmail: true },
    createCtx(fake.fn),
  );
  const data = dataOf(result);

  assert.equal(data.emailIncluded, true);
  assert.equal(data.users[0]?.emailAddress, 'ada@example.invalid');
  // Nothing was masked, so nothing to say about it.
  assert.deepEqual(hintCodes(result), []);
});

test('CC-19: a masked email is a normal result carrying the email_hidden hint', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    // synthetic — a GDPR-masked tenant simply omits emailAddress
    jiraOk([userRow('5b10a2844c20165700ede21g'), userRow('62b10a2844c2016570001a3f')]),
  );

  const result = await searchUsersTool.handler(
    { query: 'ada', includeEmail: true },
    createCtx(fake.fn),
  );
  const data = dataOf(result);

  assert.equal(result.ok, true);
  assert.deepEqual(hintCodes(result), ['email_hidden']);
  assert.equal(data.users.length, 2);
  assert.equal(data.users[0]?.accountId, '5b10a2844c20165700ede21g');
  assert.equal(data.users[0]?.displayName, 'Ada Example');
  assert.equal(data.users[0]?.emailAddress, undefined);
});

test('CC-19: no email_hidden hint when the caller never asked for email', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  const result = await searchUsersTool.handler({ query: 'ada' }, createCtx(fake.fn));

  dataOf(result);
  assert.deepEqual(hintCodes(result), []);
});

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

test('a user without displayName keeps the key absent, never the string "undefined"', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    // synthetic — an app/service account with no display name and no active flag
    jiraOk([{ accountId: '5b10a2844c20165700ede21g', accountType: 'app' }]),
  );

  const result = await searchUsersTool.handler({ query: 'bot' }, createCtx(fake.fn));
  const data = dataOf(result);

  const [user] = data.users;
  assert.deepEqual(user, { accountId: '5b10a2844c20165700ede21g' });
  assert.equal(Object.hasOwn(user ?? {}, 'displayName'), false);
  assert.ok(!JSON.stringify(data.users).includes('undefined'));
});

// ---------------------------------------------------------------------------
// O-5 / D26 — the assignable switch
// ---------------------------------------------------------------------------

test('O-5: `issue` switches to the assignable-user endpoint', async () => {
  const fake = createFakeJiraRequest().on(
    ASSIGNABLE_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  const result = await searchUsersTool.handler(
    { query: 'ada', issue: 'ABC-1' },
    createCtx(fake.fn),
  );

  assert.equal(dataOf(result).scope, 'assignable');
  assert.deepEqual(fake.routes(), [ASSIGNABLE_ROUTE]);
  assert.equal(fake.lastRequest()?.query?.issueKey, 'ABC-1');
});

test('O-5: `project` switches to the assignable-user endpoint', async () => {
  const fake = createFakeJiraRequest().on(
    ASSIGNABLE_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  const result = await searchUsersTool.handler(
    { query: 'ada', project: 'ABC' },
    createCtx(fake.fn),
  );

  assert.equal(dataOf(result).scope, 'assignable');
  assert.equal(fake.lastRequest()?.query?.project, 'ABC');
  assert.equal(fake.lastRequest()?.query?.issueKey, undefined);
});

test('O-5: `issue` wins over `project` when both are given', async () => {
  const fake = createFakeJiraRequest().on(
    ASSIGNABLE_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  await searchUsersTool.handler(
    { query: 'ada', issue: 'ABC-1', project: 'ABC' },
    createCtx(fake.fn),
  );

  assert.equal(fake.lastRequest()?.query?.issueKey, 'ABC-1');
  assert.equal(fake.lastRequest()?.query?.project, undefined);
});

test('no scope input keeps the plain search endpoint', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  const result = await searchUsersTool.handler({ query: 'ada' }, createCtx(fake.fn));

  assert.equal(dataOf(result).scope, 'query');
  assert.deepEqual(fake.routes(), [SEARCH_ROUTE]);
});

// ---------------------------------------------------------------------------
// Pagination — a page cap is a cursor, not `truncated`
// ---------------------------------------------------------------------------

test('a page-cap stop exposes the resume cursor and never the truncated hint', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    // A FULL page: Jira has more rows, and one page is read per call.
    jiraOk([userRow('5b10a2844c20165700ede21g'), userRow('62b10a2844c2016570001a3f')]),
  );

  const result = await searchUsersTool.handler(
    { query: 'ada', maxResults: 2 },
    createCtx(fake.fn),
  );
  const data = dataOf(result);

  assert.equal(data.paging.partial, true);
  assert.equal(data.paging.stopReason, 'max_pages');
  assert.equal(data.paging.nextStartAt, 2);
  assert.ok((data.paging.note ?? '').includes('INCOMPLETE'));
  assert.ok(!hintCodes(result).includes('truncated'));
  assert.equal(result._truncation, undefined);
  // Exactly one page was fetched.
  assert.equal(fake.calls.length, 1);
});

test('an exhausted search reports no cursor and no hints', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  const result = await searchUsersTool.handler(
    { query: 'ada', maxResults: 25, startAt: 0 },
    createCtx(fake.fn),
  );
  const data = dataOf(result);

  assert.equal(data.paging.partial, false);
  assert.equal(data.paging.stopReason, 'exhausted');
  assert.equal(data.paging.nextStartAt, undefined);
  assert.equal(data.paging.note, undefined);
  assert.deepEqual(hintCodes(result), []);
  assert.equal(fake.lastRequest()?.query?.maxResults, 25);
});

test('CC-04-shaped: maxResults above the cap is clamped, with the clamped hint', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  const result = await searchUsersTool.handler(
    { query: 'ada', maxResults: 500 },
    createCtx(fake.fn),
  );
  const data = dataOf(result);

  assert.equal(data.maxResults, 100);
  assert.equal(fake.lastRequest()?.query?.maxResults, 100);
  assert.deepEqual(hintCodes(result), ['clamped']);
});

test('startAt is forwarded as the offset to resume from', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([userRow('5b10a2844c20165700ede21g')]),
  );

  await searchUsersTool.handler({ query: 'ada', startAt: 50 }, createCtx(fake.fn));

  assert.equal(fake.lastRequest()?.query?.startAt, 50);
});

// ---------------------------------------------------------------------------
// Errors, schema and descriptor
// ---------------------------------------------------------------------------

test('an api-ring validation error becomes an ok: false envelope, not a throw', async () => {
  const fake = createFakeJiraRequest();

  const result = await searchUsersTool.handler({ query: '   ' }, createCtx(fake.fn));

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'validation');
  assert.equal(result.data, undefined);
  // Nothing was sent: a blank query never reaches the wire.
  assert.equal(fake.calls.length, 0);
});

test('the input schema is strict and rejects unknown keys', () => {
  assert.equal(searchUsersTool.input.safeParse({ query: 'ada' }).success, true);
  assert.equal(
    searchUsersTool.input.safeParse({ query: 'ada', includeEmails: true }).success,
    false,
  );
  assert.equal(searchUsersTool.input.safeParse({ query: '' }).success, false);
  assert.equal(searchUsersTool.input.safeParse({}).success, false);
  // The control field is auto-injected by `toolInput`.
  assert.equal(
    searchUsersTool.input.safeParse({ query: 'ada', profile: 'work' }).success,
    true,
  );
});

test('jira_search_users is annotated as a read and declares no write tier', () => {
  assert.equal(searchUsersTool.name, 'jira_search_users');
  assert.equal(searchUsersTool.package, 'users');
  assert.deepEqual(searchUsersTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(searchUsersTool.writeTier, undefined);
  assert.ok(searchUsersTool.description.length <= 500);
});

test('the users package exports exactly its one tool', () => {
  assert.equal(usersPackage.id, 'users');
  assert.deepEqual(
    usersPackage.tools.map((tool) => tool.name),
    ['jira_search_users'],
  );
});
