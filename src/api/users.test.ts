// Tests for `api/users.ts` (WP-20) — contract tier (TESTING.md §Mocking tiers).
//
// Bodies are inline plain objects shaped after the real `/rest/api/3/myself` and
// `/rest/api/3/user/search` payloads and marked `// synthetic`; the recorded
// fixtures replace them in WP-41. Placeholders follow TESTING.md:
// `example.atlassian.net`, `5b10a2844c20165700ede21g`-style accountIds,
// `user-1@example.invalid`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeClock, createFakeJiraRequest, jiraOk } from '../core/fakes/index.js';
import { JiraError } from '../core/types.js';
import {
  ASSIGNABLE_USER_SEARCH_PATH,
  DEFAULT_USER_SEARCH_MAX_RESULTS,
  MAX_MENTION_CANDIDATES_LISTED,
  MAX_MENTION_NAMES,
  MAX_USER_SEARCH_RESULTS,
  MYSELF_PATH,
  USER_SEARCH_PATH,
  getMyself,
  resolveMentionNames,
  searchUsers,
} from './users.js';

const MYSELF_ROUTE = `GET /rest/api/3${MYSELF_PATH}`;
const SEARCH_ROUTE = `GET /rest/api/3${USER_SEARCH_PATH}`;
const ASSIGNABLE_ROUTE = `GET /rest/api/3${ASSIGNABLE_USER_SEARCH_PATH}`;

/** A user record as Jira returns it on a site that discloses email. // synthetic */
function user(
  accountId: string,
  displayName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    self: `https://example.atlassian.net/rest/api/3/user?accountId=${accountId}`,
    accountId,
    accountType: 'atlassian',
    displayName,
    active: true,
    avatarUrls: {
      '48x48': `https://example.atlassian.net/avatar/${accountId}`,
    },
    ...extra,
  };
}

function isJiraErrorOfKind(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof JiraError && error.kind === kind;
}

// ---------------------------------------------------------------------------
// GET /myself
// ---------------------------------------------------------------------------

test('getMyself returns the caller identity including the Jira timezone (D16)', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(
      user('5b10a2844c20165700ede21g', 'User One', {
        emailAddress: 'user-1@example.invalid',
        timeZone: 'Australia/Sydney',
        locale: 'en_US',
      }),
    ), // synthetic
  );

  const result = await getMyself({ jira: jira.fn });

  assert.deepEqual(jira.routes(), [MYSELF_ROUTE]);
  assert.equal(result.user.accountId, '5b10a2844c20165700ede21g');
  assert.equal(result.user.displayName, 'User One');
  assert.equal(result.user.active, true);
  assert.equal(result.user.timeZone, 'Australia/Sydney', 'D16 reads this field');
  assert.equal(result.user.emailAddress, 'user-1@example.invalid');
  assert.equal(result.emailHidden, false);
});

test('CC-19: getMyself reports a masked email as hidden, not as a failure', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(user('5b10a2844c20165700ede21g', 'User One', { timeZone: 'Europe/Sofia' })), // synthetic
  );

  const result = await getMyself({ jira: jira.fn });

  assert.equal(result.emailHidden, true);
  assert.equal(result.user.emailAddress, undefined);
  assert.equal(result.user.accountId, '5b10a2844c20165700ede21g');
});

test('getMyself treats an empty email string as masked', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(user('5b10a2844c20165700ede21g', 'User One', { emailAddress: '' })), // synthetic
  );

  const result = await getMyself({ jira: jira.fn });

  assert.equal(result.emailHidden, true);
  assert.equal(result.user.emailAddress, undefined);
});

test('getMyself carries the call budget and the abort signal to the wire', async () => {
  const clock = createFakeClock(1_000);
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(user('5b10a2844c20165700ede21g', 'User One')), // synthetic
  );

  await getMyself({
    jira: jira.fn,
    signal: controller.signal,
    clock,
    deadlineAt: 4_000,
  });

  assert.equal(jira.lastRequest()?.deadlineAt, 4_000);
  assert.equal(jira.lastRequest()?.signal, controller.signal);
});

test('getMyself rejects a response with no accountId', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ displayName: 'User One' })); // synthetic

  await assert.rejects(
    getMyself({ jira: jira.fn }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

// ---------------------------------------------------------------------------
// D16 — the per-process /myself cache
// ---------------------------------------------------------------------------

test('D16: a second getMyself on the same request function issues no GET /myself', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(
      user('5b10a2844c20165700ede21g', 'User One', { timeZone: 'Australia/Sydney' }),
    ), // synthetic — enqueued ONCE; a second wire call would run the queue dry
  );

  const first = await getMyself({ jira: jira.fn });
  const second = await getMyself({ jira: jira.fn });

  assert.deepEqual(jira.routes(), [MYSELF_ROUTE], 'the wire was touched exactly once');
  assert.equal(second.user.timeZone, 'Australia/Sydney');
  assert.equal(second, first, 'the cached result is handed back as-is');
});

test('D16: distinct request functions never share a cached identity', async () => {
  const alpha = createFakeJiraRequest().enqueue(
    jiraOk(user('5b10a2844c20165700ede21g', 'User One', { timeZone: 'Europe/Sofia' })), // synthetic
  );
  const beta = createFakeJiraRequest().enqueue(
    jiraOk(
      user('5b10ac8d82e05b22cc7d4ef5', 'User Two', { timeZone: 'Australia/Sydney' }),
    ), // synthetic — a second tenant behind a `withProfile` wrapper
  );

  const one = await getMyself({ jira: alpha.fn });
  const two = await getMyself({ jira: beta.fn });

  assert.equal(one.user.accountId, '5b10a2844c20165700ede21g');
  assert.equal(two.user.accountId, '5b10ac8d82e05b22cc7d4ef5');
  assert.equal(two.user.timeZone, 'Australia/Sydney', 'no cross-tenant bleed');
  assert.deepEqual(alpha.routes(), [MYSELF_ROUTE]);
  assert.deepEqual(beta.routes(), [MYSELF_ROUTE]);
});

test('D16: a failed read is never cached', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ displayName: 'User One' })) // synthetic — no accountId
    .enqueue(
      jiraOk(user('5b10a2844c20165700ede21g', 'User One', { timeZone: 'Europe/Sofia' })), // synthetic
    );

  await assert.rejects(
    getMyself({ jira: jira.fn }),
    isJiraErrorOfKind('unexpected_shape'),
  );
  const recovered = await getMyself({ jira: jira.fn });

  assert.equal(recovered.user.accountId, '5b10a2844c20165700ede21g');
  assert.deepEqual(jira.routes(), [MYSELF_ROUTE, MYSELF_ROUTE], 'the retry hit Jira');
});

test('D16: refresh: true re-reads /myself and replaces the cached answer', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(
      jiraOk(user('5b10a2844c20165700ede21g', 'User One', { timeZone: 'Europe/Sofia' })), // synthetic
    )
    .enqueue(
      jiraOk(
        user('5b10a2844c20165700ede21g', 'User One', { timeZone: 'Australia/Sydney' }),
      ), // synthetic — the site's timezone was changed under us
    );

  await getMyself({ jira: jira.fn });
  const refreshed = await getMyself({ jira: jira.fn, refresh: true });
  const afterwards = await getMyself({ jira: jira.fn });

  assert.deepEqual(jira.routes(), [MYSELF_ROUTE, MYSELF_ROUTE]);
  assert.equal(refreshed.user.timeZone, 'Australia/Sydney');
  assert.equal(afterwards.user.timeZone, 'Australia/Sydney', 'the cache was replaced');
});

// ---------------------------------------------------------------------------
// GET /user/search
// ---------------------------------------------------------------------------

test('searchUsers resolves a name fragment to accountIds', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([
      user('5b10a2844c20165700ede21g', 'User One', {
        emailAddress: 'user-1@example.invalid',
      }),
      user('712020:1f6b0e1a-0000-4000-8000-000000000001', 'Automation for Jira', {
        accountType: 'app',
      }),
    ]), // synthetic — the endpoint answers with a bare array
  );

  const result = await searchUsers({ jira: jira.fn, query: 'user' });

  assert.deepEqual(jira.routes(), [SEARCH_ROUTE]);
  assert.deepEqual(jira.lastRequest()?.query, {
    query: 'user',
    startAt: 0,
    maxResults: DEFAULT_USER_SEARCH_MAX_RESULTS,
  });
  assert.equal(result.scope, 'query');
  assert.deepEqual(
    result.users.map((row) => row.accountId),
    ['5b10a2844c20165700ede21g', '712020:1f6b0e1a-0000-4000-8000-000000000001'],
  );
  assert.equal(result.users[1]?.accountType, 'app', 'a bot stays identifiable');
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
});

test('CC-19: a masked email in a search result is reported, never an error', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([
      user('5b10a2844c20165700ede21g', 'User One', {
        emailAddress: 'user-1@example.invalid',
      }),
      user('5b10ac8d82e05b22cc7d4ef5', 'User Two'), // synthetic — tenant masks this one
    ]),
  );

  const result = await searchUsers({ jira: jira.fn, query: 'user' });

  assert.equal(result.emailHidden, true);
  assert.equal(result.users[1]?.emailAddress, undefined);
  assert.equal(result.users[1]?.displayName, 'User Two', 'the record itself is usable');
});

test('an empty result hides nothing', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([])); // synthetic

  const result = await searchUsers({ jira: jira.fn, query: 'nobody' });

  assert.deepEqual(result.users, []);
  assert.equal(result.emailHidden, false);
  assert.equal(result.stopReason, 'exhausted');
});

test('a blank query is refused before anything reaches the wire', async () => {
  const jira = createFakeJiraRequest();

  await assert.rejects(
    searchUsers({ jira: jira.fn, query: '   ' }),
    isJiraErrorOfKind('validation'),
  );
  assert.equal(jira.calls.length, 0);
});

test('an over-cap maxResults is clamped and the clamp is reported', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([])); // synthetic

  const result = await searchUsers({ jira: jira.fn, query: 'user', maxResults: 900 });

  assert.equal(jira.lastRequest()?.query?.maxResults, MAX_USER_SEARCH_RESULTS);
  assert.equal(result.maxResults, MAX_USER_SEARCH_RESULTS);
  assert.equal(result.clamped, true);
});

test('a non-array response is a shape error', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ values: [] })); // synthetic

  await assert.rejects(
    searchUsers({ jira: jira.fn, query: 'user' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

test('a user row without an accountId is a shape error', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([{ displayName: 'User One' }])); // synthetic

  await assert.rejects(
    searchUsers({ jira: jira.fn, query: 'user' }),
    isJiraErrorOfKind('unexpected_shape'),
  );
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('a sweep walks offsets until a short page ends it', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk([user('acct-1', 'User One'), user('acct-2', 'User Two')])) // synthetic
    .enqueue(jiraOk([user('acct-3', 'User Three')])); // synthetic

  const result = await searchUsers({
    jira: jira.fn,
    query: 'user',
    maxResults: 2,
    maxPages: 3,
  });

  assert.equal(result.users.length, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.partial, false);
  assert.equal(jira.calls[0]?.query?.startAt, 0);
  assert.equal(jira.calls[1]?.query?.startAt, 2);
});

test('the default single-page read reports max_pages and the resume offset', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([user('acct-1', 'User One'), user('acct-2', 'User Two')]), // synthetic — a full page
  );

  const result = await searchUsers({ jira: jira.fn, query: 'user', maxResults: 2 });

  assert.equal(result.pages, 1);
  assert.equal(result.maxPages, 1);
  assert.equal(result.stopReason, 'max_pages');
  assert.equal(result.partial, true);
  assert.equal(result.nextStartAt, 2);
  assert.equal(jira.calls.length, 1);
});

test('a caller-supplied startAt is where the sweep begins', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([user('acct-3', 'User Three')])); // synthetic

  await searchUsers({ jira: jira.fn, query: 'user', startAt: 50, maxResults: 25 });

  assert.equal(jira.lastRequest()?.query?.startAt, 50);
});

// ---------------------------------------------------------------------------
// O-5 — assignable search as inputs, not as a second tool
// ---------------------------------------------------------------------------

test('O-5: a project input switches to the assignable-user endpoint', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([user('5b10a2844c20165700ede21g', 'User One')]), // synthetic
  );

  const result = await searchUsers({ jira: jira.fn, query: 'user', project: 'ABC' });

  assert.deepEqual(jira.routes(), [ASSIGNABLE_ROUTE]);
  assert.deepEqual(jira.lastRequest()?.query, {
    query: 'user',
    project: 'ABC',
    startAt: 0,
    maxResults: DEFAULT_USER_SEARCH_MAX_RESULTS,
  });
  assert.equal(result.scope, 'assignable');
  assert.equal(result.users[0]?.accountId, '5b10a2844c20165700ede21g');
});

test('O-5: an issueKey input switches to the assignable-user endpoint', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([user('5b10a2844c20165700ede21g', 'User One')]), // synthetic
  );

  const result = await searchUsers({ jira: jira.fn, query: 'user', issueKey: 'ABC-1' });

  assert.deepEqual(jira.routes(), [ASSIGNABLE_ROUTE]);
  assert.equal(jira.lastRequest()?.query?.issueKey, 'ABC-1');
  assert.equal(jira.lastRequest()?.query?.project, undefined);
  assert.equal(result.scope, 'assignable');
});

test('O-5: issueKey wins over project so the request is never ambiguous', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([])); // synthetic

  await searchUsers({
    jira: jira.fn,
    query: 'user',
    issueKey: 'ABC-1',
    project: 'ABC',
  });

  assert.equal(jira.lastRequest()?.query?.issueKey, 'ABC-1');
  assert.equal(jira.lastRequest()?.query?.project, undefined);
});

test('O-5: a blank project input falls back to the plain lookup', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([])); // synthetic

  const result = await searchUsers({ jira: jira.fn, query: 'user', project: '  ' });

  assert.deepEqual(jira.routes(), [SEARCH_ROUTE]);
  assert.equal(result.scope, 'query');
});

// ---------------------------------------------------------------------------
// D100 — mention resolution (@[name] → accountId)
// ---------------------------------------------------------------------------

/** A validation refusal whose message (reason + remediation) matches every pattern. */
function isMentionRefusal(...patterns: readonly RegExp[]): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof JiraError, 'expected a JiraError');
    assert.equal(error.kind, 'validation');
    for (const pattern of patterns) assert.match(error.message, pattern);
    return true;
  };
}

test('resolveMentionNames resolves a unique match through the plain one-page search', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([user('5b10a2844c20165700ede21g', 'User One')]), // synthetic
  );

  const resolved = await resolveMentionNames({ jira: jira.fn, names: ['User One'] });

  assert.deepEqual(jira.routes(), [SEARCH_ROUTE], 'plain scope, never assignable');
  assert.deepEqual(jira.lastRequest()?.query, {
    query: 'User One',
    startAt: 0,
    maxResults: DEFAULT_USER_SEARCH_MAX_RESULTS,
  });
  assert.equal(resolved.size, 1);
  assert.deepEqual(resolved.get('User One'), {
    id: '5b10a2844c20165700ede21g',
    text: '@User One',
  });
});

test('resolveMentionNames carries the abort signal to the wire', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([user('5b10a2844c20165700ede21g', 'User One')]), // synthetic
  );

  await resolveMentionNames({
    jira: jira.fn,
    names: ['User One'],
    signal: controller.signal,
  });

  assert.equal(jira.lastRequest()?.signal, controller.signal);
});

test('no names yields an empty map and no wire calls', async () => {
  const jira = createFakeJiraRequest();

  const resolved = await resolveMentionNames({ jira: jira.fn, names: [] });

  assert.equal(resolved.size, 0);
  assert.equal(jira.calls.length, 0);
});

test('CC-112: duplicate spellings share one search and resolve to the same target', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([user('5b10a2844c20165700ede21g', 'User One')]), // synthetic — enqueued ONCE
  );

  const resolved = await resolveMentionNames({
    jira: jira.fn,
    names: ['User One', 'USER ONE', 'User One'],
  });

  assert.equal(jira.calls.length, 1, 'one case-insensitive group, one search');
  assert.equal(resolved.size, 2, 'every distinct raw spelling is a key');
  assert.equal(resolved.get('User One')?.id, '5b10a2844c20165700ede21g');
  assert.equal(
    resolved.get('USER ONE'),
    resolved.get('User One'),
    'both spellings share the one resolved target',
  );
});

test('CC-112: more than 20 distinct case-insensitive names refuse before any search', async () => {
  const jira = createFakeJiraRequest();
  const names = Array.from(
    { length: MAX_MENTION_NAMES + 1 },
    (_, index) => `User ${String(index)}`,
  );

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names }),
    isMentionRefusal(/at most 20 distinct names/, /21/),
  );
  assert.equal(jira.calls.length, 0, 'the cap is checked before the wire');
});

test('CC-112: twenty distinct names pass the cap even with a duplicate spelling', async () => {
  const jira = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk([user('5b10a2844c20165700ede21g', 'Resolved Human')]), // synthetic
  );
  const distinct = Array.from(
    { length: MAX_MENTION_NAMES },
    (_, index) => `User ${String(index)}`,
  );

  const resolved = await resolveMentionNames({
    jira: jira.fn,
    names: [...distinct, 'USER 0'],
  });

  assert.equal(jira.calls.length, MAX_MENTION_NAMES, 'the duplicate cost no search');
  assert.equal(resolved.size, MAX_MENTION_NAMES + 1);
});

test('CC-106: a name with zero matches refuses and points at jira_search_users', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([])); // synthetic

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names: ['Nobody Known'] }),
    isMentionRefusal(/@\[Nobody Known\]/, /jira_search_users/),
  );
});

test('CC-106: matches that are all inactive refuse with the inactive wording', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([user('5b10a2844c20165700ede21g', 'User One', { active: false })]), // synthetic
  );

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names: ['User One'] }),
    isMentionRefusal(/@\[User One\]/, /inactive/, /jira_search_users/),
  );
});

test('CC-106: resolution fails fast on the first failing name in document order', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([])); // synthetic — first name only

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names: ['Nobody Known', 'User One'] }),
    isMentionRefusal(/@\[Nobody Known\]/),
  );
  assert.equal(jira.calls.length, 1, 'no search follows the refusal');
});

test('CC-107: ambiguity refuses and lists candidates as displayName (accountId)', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([
      user('5b10a2844c20165700ede21g', 'User One'),
      user('5b10ac8d82e05b22cc7d4ef5', 'User Two'),
    ]), // synthetic
  );

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names: ['User'] }),
    isMentionRefusal(
      /@\[User\]/,
      /User One \(5b10a2844c20165700ede21g\)/,
      /User Two \(5b10ac8d82e05b22cc7d4ef5\)/,
      /jira_search_users/,
    ),
  );
});

test('CC-107: a unique case-insensitive exact display-name match beats partials', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([
      user('5b10a2844c20165700ede21g', 'User Twofold'),
      user('5b10ac8d82e05b22cc7d4ef5', 'User Two'),
      user('5b10ac8d82e05b22cc7d4ef6', 'User Twombly'),
    ]), // synthetic
  );

  const resolved = await resolveMentionNames({ jira: jira.fn, names: ['user two'] });

  assert.deepEqual(resolved.get('user two'), {
    id: '5b10ac8d82e05b22cc7d4ef5',
    text: '@User Two',
  });
});

test('CC-107: two exact display-name matches still refuse', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([
      user('5b10a2844c20165700ede21g', 'User Two'),
      user('5b10ac8d82e05b22cc7d4ef5', 'User Two'),
    ]), // synthetic — homonymous colleagues
  );

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names: ['User Two'] }),
    isMentionRefusal(
      /User Two \(5b10a2844c20165700ede21g\)/,
      /User Two \(5b10ac8d82e05b22cc7d4ef5\)/,
    ),
  );
});

test('an ambiguity refusal lists at most 5 candidates', async () => {
  const roster = [
    'User Alpha',
    'User Bravo',
    'User Charlie',
    'User Delta',
    'User Echo',
    'User Foxtrot',
    'User Golf',
  ];
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(roster.map((name, index) => user(`acct-${String(index + 1)}`, name))), // synthetic
  );

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names: ['User'] }),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      for (const [index, name] of roster
        .slice(0, MAX_MENTION_CANDIDATES_LISTED)
        .entries()) {
        assert.match(
          error.message,
          new RegExp(`${name} \\(acct-${String(index + 1)}\\)`),
        );
      }
      assert.doesNotMatch(error.message, /User Foxtrot|User Golf/);
      assert.match(error.message, /and 2 more/);
      return true;
    },
  );
});

test('CC-113: app and inactive rows are excluded before the exact tiebreak', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([
      user('712020:1f6b0e1a-0000-4000-8000-000000000001', 'User One', {
        accountType: 'app',
      }),
      user('5b10a2844c20165700ede21g', 'User One', { active: false }),
      user('5b10ac8d82e05b22cc7d4ef5', 'User Onederful'),
    ]), // synthetic — the two EXACT name matches are a bot and a leaver
  );

  const resolved = await resolveMentionNames({ jira: jira.fn, names: ['User One'] });

  assert.deepEqual(resolved.get('User One'), {
    id: '5b10ac8d82e05b22cc7d4ef5',
    text: '@User Onederful',
  });
});

test('a full page with no exact match is ambiguous even with one candidate', async () => {
  const bots = Array.from({ length: DEFAULT_USER_SEARCH_MAX_RESULTS - 1 }, (_, index) =>
    user(`app-${String(index)}`, `Robot ${String(index)}`, { accountType: 'app' }),
  );
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([...bots, user('5b10a2844c20165700ede21g', 'User Onederful')]), // synthetic — a FULL page
  );

  await assert.rejects(
    resolveMentionNames({ jira: jira.fn, names: ['User'] }),
    isMentionRefusal(/@\[User\]/, /full page/, /first page/),
  );
});

test('a full page with a unique exact match still resolves', async () => {
  const partials = Array.from(
    { length: DEFAULT_USER_SEARCH_MAX_RESULTS - 1 },
    (_, index) => user(`acct-${String(index)}`, `User Two ${String(index)}`),
  );
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([...partials, user('5b10ac8d82e05b22cc7d4ef5', 'User Two')]), // synthetic — a FULL page
  );

  const resolved = await resolveMentionNames({ jira: jira.fn, names: ['User Two'] });

  assert.equal(resolved.get('User Two')?.id, '5b10ac8d82e05b22cc7d4ef5');
});

test('a match without a display name resolves with text omitted', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk([
      { accountId: '5b10a2844c20165700ede21g', active: true, accountType: 'atlassian' },
    ]), // synthetic — tenant blanked the name
  );

  const resolved = await resolveMentionNames({ jira: jira.fn, names: ['ghost'] });

  assert.deepEqual(resolved.get('ghost'), { id: '5b10a2844c20165700ede21g' });
});
