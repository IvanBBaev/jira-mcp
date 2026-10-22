// Suite for the Data Center twin of the fake Jira (`scripts/fake-jira.mjs
// --deployment datacenter`) and for the pure checkers of the Data Center
// rehearsal (`scripts/rehearse-datacenter.mjs`).
//
// The rehearsal itself — the built server over real stdio MCP against the fake,
// every one of the twenty-seven Data Center reads — is a slow, whole-system check
// that, like the Cloud rehearsal, stays OUTSIDE `npm run check` (TESTING.md
// "Rehearsing the live gate"). What is pinned here is what the rehearsal's
// verdict rests on:
//
//   - the fake is Data Center-shaped where the server's promises are tested:
//     users with name/key and an email to strip, wiki-markup bodies, classic
//     paging, a PAT Bearer and nothing else (CC-290…CC-293);
//   - the Data Center mode leaves Cloud mode as it was (CC-294);
//   - each checker actually catches the failure it exists for, so a green
//     rehearsal means something (CC-295…CC-297).
//
// **Why a compiled test may import `scripts/`** is argued in
// `./verify-live.test.ts`: `src/testing/**` is in no layering zone, and the
// import is a dynamic `import()` of a `file:` URL. Both scripts guard their
// entry point, so importing them starts nothing.
//
// The fake is an HTTPS server on 127.0.0.1 with a self-signed certificate made
// by `openssl`. The network fence stubs `fetch` only; these requests go through
// `node:https` to loopback, naming the rehearsal host through SNI and the Host
// header — no DNS, no real host. Without `openssl` the fake cannot start, and
// the tests that need it are skipped with that reason rather than failed.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { DATACENTER_TOOLS, DATACENTER_WRITE_TOOLS } from '../api/datacenter.js';
import { REPO_ROOT } from '../core/fakes/fixtures.js';

// --- the scripts' contract, as this suite understands it --------------------

interface FakeRecord {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly route?: string;
  readonly authScheme?: string;
  readonly authFailure?: string;
  readonly cloudOnly?: string;
  readonly outsideContextPath?: boolean;
  readonly unmatched?: boolean;
  readonly violation?: string;
}

interface Fake {
  readonly port: number;
  readonly origin: string;
  readonly certFile: string;
  readonly requests: FakeRecord[];
  clearRequests(): void;
  close(): Promise<void>;
}

interface FakeModule {
  readonly API_HOST: string;
  readonly DATACENTER_ROUTES: readonly string[];
  readonly DATACENTER_PAT: string;
  readonly ensureCertificate: (
    dir: string,
    now?: number,
  ) => { readonly cert: Uint8Array };
  readonly cloudOnlyReason: (
    pathname: string,
    query: Record<string, string>,
  ) => string | undefined;
  readonly dataCenterAuthFailure: (header: unknown, pat: string) => string | undefined;
  readonly startFakeJira: (options: Record<string, unknown>) => Promise<Fake>;
}

interface RehearsalModule {
  readonly DATACENTER_PLAN: readonly {
    readonly tool: string;
    readonly args?: Record<string, unknown>;
    readonly also?: readonly Record<string, unknown>[];
    readonly checkAlso?: boolean;
  }[];
  readonly leakFindings: (label: string, value: unknown) => string[];
  readonly wireFindings: (
    requests: readonly Partial<FakeRecord>[],
    contextPath: string,
    routes?: readonly string[],
  ) => string[];
  readonly toolListFindings: (
    listed: Iterable<string>,
    expected: Iterable<string>,
  ) => string[];
  readonly stepFindings: (tool: string, data: unknown) => string[];
  readonly dataCenterReads: (
    tools: Iterable<string>,
    writes: ReadonlySet<string>,
  ) => string[];
  readonly dataCenterChildEnv: (
    options: Record<string, string>,
  ) => Record<string, string>;
  readonly runDataCenterRehearsal: (options?: {
    readonly serverEntry?: string;
  }) => Promise<{ readonly findings: readonly string[]; readonly workdir: string }>;
  readonly downloadFindings: (
    data: Record<string, unknown>,
    disk: {
      mediaDir: string;
      fileDir: string | undefined;
      expected: Uint8Array;
      actual: Uint8Array | undefined;
    },
  ) => string[];
}

const scriptUrl = (name: string): string =>
  pathToFileURL(join(REPO_ROOT, 'scripts', name)).href;

// Computed specifiers are `any` to TypeScript — asserted, not trusted: every
// property this suite touches is exercised below.
const fakeJira = (await import(scriptUrl('fake-jira.mjs'))) as FakeModule;
const rehearsal = (await import(scriptUrl('rehearse-datacenter.mjs'))) as RehearsalModule;

// --- the fake, started once -------------------------------------------------

const TLS_DIR = mkdtempSync(join(tmpdir(), 'jira-mcp-dc-fake-test-'));
const PAT = 'test-pat-not-a-secret';

/** Why the fake cannot start here (no `openssl`), or `undefined` when it can. */
const noTls: string | undefined = (() => {
  try {
    fakeJira.ensureCertificate(TLS_DIR);
    return undefined;
  } catch (error) {
    return `the fake needs openssl for its certificate: ${String(error)}`;
  }
})();

let dc: Fake;
let cloud: Fake;

before(async () => {
  if (noTls !== undefined) return;
  dc = await fakeJira.startFakeJira({
    deployment: 'datacenter',
    pat: PAT,
    certDir: TLS_DIR,
  });
  cloud = await fakeJira.startFakeJira({ certDir: TLS_DIR });
});

after(async () => {
  if (noTls === undefined) await Promise.all([dc.close(), cloud.close()]);
  rmSync(TLS_DIR, { recursive: true, force: true });
});

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly json: unknown;
  /** The raw body — what a byte route (the attachment servlet) is read by. */
  readonly text: string;
}

/** JSON when the body is JSON; a byte route's body is not. */
function parseMaybe(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One request to a fake over loopback TLS, the rehearsal host named via SNI. */
function send(
  fake: Fake,
  method: string,
  path: string,
  authorization?: string,
  body?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        servername: fakeJira.API_HOST,
        port: fake.port,
        method,
        path,
        ca: [readCa(fake)],
        headers: {
          host: `${fakeJira.API_HOST}:${String(fake.port)}`,
          ...(authorization === undefined ? {} : { authorization }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: parseMaybe(text),
            text,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The fake's self-signed certificate, trusted for this one request only. */
function readCa(fake: Fake): Buffer {
  return readFileSync(fake.certFile);
}

const bearer = (): string => `Bearer ${PAT}`;
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const last = (fake: Fake): FakeRecord => {
  const entry = fake.requests.at(-1);
  assert.ok(entry !== undefined, 'the fake recorded nothing');
  return entry;
};

// ---------------------------------------------------------------------------
// CC-290 — the Data Center fake answers in Data Center's shape
// ---------------------------------------------------------------------------

test(
  'CC-290: the Data Center fake mounts the site under a context path',
  { skip: noTls },
  () => {
    // A context path is the configuration the Cloud fake can never exercise, and
    // the one a Data Center adapter most easily drops (`/rest/...` instead of
    // `/jira/rest/...`) — so the twin is mounted under one by default.
    assert.match(dc.origin, /^https:\/\/jira\.rehearsal\.test:\d+\/jira$/);
  },
);

test(
  'CC-290: a Data Center user is name/key/displayName, WITH an email and no accountId',
  { skip: noTls },
  async () => {
    const reply = await send(dc, 'GET', '/jira/rest/api/2/myself', bearer());
    assert.equal(reply.status, 200);
    const me = record(reply.json);
    assert.equal(me['name'], 'rehearsal');
    assert.equal(me['key'], 'JIRAUSER10000');
    assert.equal(typeof me['displayName'], 'string');
    // The email is what makes the rehearsal's leak check mean something: a fake
    // that never sent one could not show the server stripping it.
    assert.equal(me['emailAddress'], 'rehearsal@example.invalid');
    assert.ok(!('accountId' in me), 'Data Center users have no accountId');
    assert.match(String(record(me['avatarUrls'])['48x48']), /\/jira\/secure\/useravatar/);
    assert.equal(last(dc).route, 'GET /rest/api/2/myself');
  },
);

test(
  'CC-290: rich text is wiki markup — the description, comment bodies, worklog comments',
  { skip: noTls },
  async () => {
    const issue = record(
      (await send(dc, 'GET', '/jira/rest/api/2/issue/SCRATCH-1', bearer())).json,
    );
    const fields = record(issue['fields']);
    assert.equal(
      typeof fields['description'],
      'string',
      'a DC description is a string, not ADF',
    );
    assert.match(String(fields['description']), /^h2\. /m);
    assert.match(String(fields['description']), /\[~user2\]/);
    const assignee = record(fields['assignee']);
    assert.equal(typeof assignee['name'], 'string');
    assert.ok(!('accountId' in assignee));

    const comments = record(
      (await send(dc, 'GET', '/jira/rest/api/2/issue/SCRATCH-1/comment', bearer())).json,
    );
    const first = record((comments['comments'] as unknown[])[0]);
    assert.equal(typeof first['body'], 'string');
    assert.match(String(first['body']), /\[~user2\]/);
    assert.ok(!('accountId' in record(first['author'])));

    const worklogs = record(
      (await send(dc, 'GET', '/jira/rest/api/2/issue/SCRATCH-1/worklog', bearer())).json,
    );
    const worklog = record((worklogs['worklogs'] as unknown[])[0]);
    assert.match(String(worklog['comment']), /\{\{the gate\}\}/);
  },
);

// ---------------------------------------------------------------------------
// CC-291 — a PAT Bearer and nothing else
// ---------------------------------------------------------------------------

test(
  'CC-291: anything but the PAT Bearer is a Data Center 401, and the reason is recorded',
  { skip: noTls },
  async () => {
    const cases: readonly [string | undefined, string, string | undefined][] = [
      [undefined, 'no Authorization header', undefined],
      // Even the Cloud fake's own valid Basic credential: a server configured for
      // JIRA_AUTH_MODE=pat that sends Basic is the bug this catches.
      [
        `Basic ${Buffer.from('rehearsal@example.invalid:rehearsal-token').toString('base64')}`,
        'HTTP Basic, not a PAT bearer',
        'Basic',
      ],
      [`Bearer ${PAT}-wrong`, 'wrong token', 'Bearer'],
      [`Token ${PAT}`, 'not a Bearer token', 'Token'],
    ];
    for (const [authorization, reason, scheme] of cases) {
      const reply = await send(dc, 'GET', '/jira/rest/api/2/myself', authorization);
      assert.equal(reply.status, 401, reason);
      assert.equal(reply.headers['x-seraph-loginreason'], 'AUTHENTICATED_FAILED');
      assert.deepEqual(record(reply.json)['errors'], {});
      assert.match(
        String((record(reply.json)['errorMessages'] as unknown[])[0]),
        /not authenticated/,
      );
      assert.equal(last(dc).authFailure, reason);
      assert.equal(last(dc).authScheme, scheme);
    }
    // …and the right one passes.
    assert.equal(
      (await send(dc, 'GET', '/jira/rest/api/2/myself', bearer())).status,
      200,
    );
    assert.equal(last(dc).authFailure, undefined);
  },
);

test('CC-291: the auth predicate is exact about the PAT', () => {
  assert.equal(fakeJira.dataCenterAuthFailure('Bearer p', 'p'), undefined);
  assert.equal(fakeJira.dataCenterAuthFailure('', 'p'), 'no Authorization header');
  assert.equal(fakeJira.dataCenterAuthFailure(undefined, 'p'), 'no Authorization header');
  assert.equal(fakeJira.dataCenterAuthFailure('Bearer p2', 'p'), 'wrong token');
  assert.equal(fakeJira.dataCenterAuthFailure('Bearer  p', 'p'), 'wrong token');
  assert.equal(fakeJira.dataCenterAuthFailure('bearer p', 'p'), 'not a Bearer token');
});

// ---------------------------------------------------------------------------
// CC-292 — Cloud-only routes, and anything outside the context path, are 404
// ---------------------------------------------------------------------------

test(
  'CC-292: Cloud-only routes and paths outside the context path are 404 and flagged',
  { skip: noTls },
  async () => {
    const cases: readonly [string, string, (entry: FakeRecord) => unknown][] = [
      ['GET', '/jira/rest/api/3/myself', (entry) => entry.cloudOnly],
      ['POST', '/jira/rest/api/2/search/jql', (entry) => entry.cloudOnly],
      ['GET', '/jira/rest/api/2/user?accountId=557058:abc', (entry) => entry.cloudOnly],
      ['GET', '/rest/api/2/myself', (entry) => entry.outsideContextPath],
      ['GET', '/jira/rest/api/2/issue/SCRATCH-1/remotelink', (entry) => entry.unmatched],
    ];
    for (const [method, path, flag] of cases) {
      const reply = await send(
        dc,
        method,
        path,
        bearer(),
        method === 'POST' ? {} : undefined,
      );
      assert.equal(reply.status, 404, `${method} ${path}`);
      const entry = last(dc);
      assert.ok(flag(entry) !== undefined, `${method} ${path} must be flagged`);
      assert.equal(entry.unmatched, true, `${method} ${path} must count as unmatched`);
    }
  },
);

test('CC-292: the Cloud-only predicate names each reason', () => {
  assert.match(
    String(fakeJira.cloudOnlyReason('/rest/api/3/issue/X-1', {})),
    /\/rest\/api\/3/,
  );
  assert.match(String(fakeJira.cloudOnlyReason('/rest/api/3', {})), /\/rest\/api\/3/);
  assert.match(
    String(fakeJira.cloudOnlyReason('/rest/api/2/search/approximate-count', {})),
    /enhanced search/,
  );
  assert.match(
    String(fakeJira.cloudOnlyReason('/rest/api/2/user/bulk', { accountIds: 'a' })),
    /accountId/,
  );
  assert.equal(fakeJira.cloudOnlyReason('/rest/api/2/search', {}), undefined);
  assert.equal(
    fakeJira.cloudOnlyReason('/rest/api/2/user', { username: 'x' }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// CC-293 — /search pages classically, and refuses a Cloud cursor
// ---------------------------------------------------------------------------

test(
  'CC-293: POST /search pages by startAt/maxResults/total, oldest first',
  { skip: noTls },
  async () => {
    const page = async (startAt: number): Promise<Record<string, unknown>> =>
      record(
        (
          await send(dc, 'POST', '/jira/rest/api/2/search', bearer(), {
            jql: 'project = SCRATCH ORDER BY created ASC',
            startAt,
            maxResults: 2,
          })
        ).json,
      );
    const first = await page(0);
    const second = await page(2);
    assert.equal(first['startAt'], 0);
    assert.equal(first['maxResults'], 2);
    assert.equal(typeof first['total'], 'number');
    assert.ok(!('nextPageToken' in first), 'classic search has no cursor');
    const keys = (body: Record<string, unknown>): string[] =>
      (body['issues'] as unknown[]).map((issue) => String(record(issue)['key']));
    assert.deepEqual(keys(first), ['SCRATCH-1', 'SCRATCH-2']);
    assert.equal(second['startAt'], 2);
    assert.ok(keys(second).every((key) => !keys(first).includes(key)));
  },
);

test(
  'CC-293: a Cloud cursor sent to classic /search is a 400 and a recorded violation',
  { skip: noTls },
  async () => {
    const reply = await send(dc, 'POST', '/jira/rest/api/2/search', bearer(), {
      jql: 'project = SCRATCH',
      nextPageToken: 'abc',
    });
    assert.equal(reply.status, 400);
    assert.equal(last(dc).violation, 'cloud_cursor_on_classic_search');
  },
);

// ---------------------------------------------------------------------------
// CC-294 — Cloud mode is untouched by the Data Center mode
// ---------------------------------------------------------------------------

test(
  'CC-294: the Cloud fake still serves v3 at the host root behind Basic',
  { skip: noTls },
  async () => {
    assert.match(cloud.origin, /^https:\/\/jira\.rehearsal\.test:\d+$/);
    const basic = `Basic ${Buffer.from('rehearsal@example.invalid:rehearsal-token').toString('base64')}`;
    const me = await send(cloud, 'GET', '/rest/api/3/myself', basic);
    assert.equal(me.status, 200);
    assert.equal(typeof record(me.json)['accountId'], 'string');
    const entry = last(cloud);
    // None of the Data Center bookkeeping leaks into a Cloud record.
    assert.equal(entry.authScheme, undefined);
    assert.equal(entry.cloudOnly, undefined);
    assert.equal(entry.outsideContextPath, undefined);
    // A PAT means nothing to the Cloud fake.
    assert.equal(
      (await send(cloud, 'GET', '/rest/api/3/myself', `Bearer ${PAT}`)).status,
      401,
    );
  },
);

test('CC-294: an unknown deployment or a malformed context path is refused at start', async () => {
  await assert.rejects(
    fakeJira.startFakeJira({ deployment: 'server' }),
    /unknown deployment/,
  );
  await assert.rejects(
    fakeJira.startFakeJira({ deployment: 'datacenter', contextPath: 'jira/' }),
    /malformed context path/,
  );
});

// ---------------------------------------------------------------------------
// CC-295 — the leak check catches every way identity can leak
// ---------------------------------------------------------------------------

test('CC-295: the leak check flags accountId, email and avatar keys at any depth', () => {
  const findings = rehearsal.leakFindings('t', {
    data: {
      issues: [
        { fields: { assignee: { accountId: 'x', EmailAddress: 'y', avatarUrls: {} } } },
      ],
    },
  });
  assert.equal(findings.length, 3, findings.join('\n'));
  assert.ok(
    findings.some((line) => line.includes('$.data.issues[0].fields.assignee.accountId')),
  );
});

test('CC-295: the leak check flags an email or a DC avatar URL inside any string', () => {
  assert.equal(
    rehearsal.leakFindings('t', { text: 'mail rehearsal@example.invalid now' }).length,
    1,
  );
  assert.equal(
    rehearsal.leakFindings('t', { self: 'https://h/jira/secure/useravatar?ownerId=u' })
      .length,
    1,
  );
  assert.deepEqual(
    rehearsal.leakFindings('t', {
      name: 'rehearsal',
      key: 'JIRAUSER10000',
      note: 'a @mention',
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// CC-296 — the wire audit catches every Data Center contract break
// ---------------------------------------------------------------------------

test('CC-296: clean Data Center traffic that hits every route passes the wire audit', () => {
  const requests = fakeJira.DATACENTER_ROUTES.map((route) => ({
    method: route.split(' ')[0] ?? '',
    path: `/jira${route.split(' ')[1] ?? ''}`,
    route,
    authScheme: 'Bearer',
  }));
  assert.deepEqual(rehearsal.wireFindings(requests, '/jira'), []);
});

test('CC-296: the wire audit names each break, and a route never called', () => {
  const ok = { method: 'GET', route: 'GET /rest/api/2/myself', authScheme: 'Bearer' };
  const cases: readonly [Partial<FakeRecord>, RegExp][] = [
    [{ ...ok, path: '/jira/rest/api/3/myself', cloudOnly: 'v3' }, /Cloud-only/],
    [{ ...ok, path: '/rest/api/2/myself', outsideContextPath: true }, /context path/],
    [{ ...ok, path: '/jira/rest/api/2/x', unmatched: true }, /no Data Center route/],
    [{ ...ok, path: '/jira/rest/api/2/myself', authScheme: 'Basic' }, /not a PAT Bearer/],
    [
      { ...ok, path: '/jira/rest/api/2/myself', authFailure: 'wrong token' },
      /authentication failed/,
    ],
    [
      { ...ok, path: '/jira/rest/api/2/search', violation: 'cloud_cursor' },
      /cloud_cursor/,
    ],
  ];
  for (const [request, pattern] of cases) {
    const findings = rehearsal.wireFindings([request], '/jira', [
      'GET /rest/api/2/myself',
    ]);
    assert.ok(
      findings.some((line) => pattern.test(line)),
      `${pattern.source} not found in:\n${findings.join('\n')}`,
    );
  }
  const unused = rehearsal.wireFindings(
    [{ ...ok, path: '/jira/rest/api/2/myself' }],
    '/jira',
    ['GET /rest/api/2/myself', 'GET /rest/api/2/field'],
  );
  assert.deepEqual(unused, ['GET /rest/api/2/field: never called']);
});

// ---------------------------------------------------------------------------
// CC-297 — the tool list is exactly DATACENTER_TOOLS, and the plan covers it
// ---------------------------------------------------------------------------

test('CC-297: the tool-list check names a missing read and a leaked write', () => {
  assert.deepEqual(rehearsal.toolListFindings(['a', 'b'], ['b', 'a']), []);
  assert.deepEqual(rehearsal.toolListFindings(['a', 'jira_create_issue'], ['a', 'b']), [
    'b: served on Data Center but not listed',
    'jira_create_issue: listed, but not a Data Center tool',
  ]);
});

test('CC-297: the rehearsal plan calls every Data Center read, once, and no write', () => {
  const planned = rehearsal.DATACENTER_PLAN.map((step) => step.tool);
  assert.equal(new Set(planned).size, planned.length, 'a tool is planned twice');
  const reads = rehearsal.dataCenterReads(DATACENTER_TOOLS, DATACENTER_WRITE_TOOLS);
  assert.equal(reads.length + DATACENTER_WRITE_TOOLS.size, DATACENTER_TOOLS.size);
  assert.deepEqual(rehearsal.toolListFindings(planned, reads), []);
});

test('CC-297: the child runs as a PAT Data Center preview and inherits no JIRA_* from the parent', () => {
  const env = rehearsal.dataCenterChildEnv({
    home: '/h',
    site: 'https://jira.rehearsal.test:1/jira',
    pat: 'p',
    certFile: '/c.pem',
    preloadUrl: 'file:///p.mjs',
  });
  assert.equal(env['JIRA_DEPLOYMENT'], 'datacenter');
  assert.equal(env['JIRA_DATACENTER_PREVIEW'], 'true');
  assert.equal(env['JIRA_AUTH_MODE'], 'pat');
  assert.equal(env['JIRA_PAT'], 'p');
  assert.equal(env['JIRA_ALLOWED_HOSTS'], fakeJira.API_HOST);
  assert.equal(env['NODE_OPTIONS'], '--import file:///p.mjs');
  // No Cloud credential can reach the child, whatever the developer exported.
  for (const name of ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_WRITE_MODE']) {
    assert.ok(!(name in env), `${name} must not be set`);
  }
});

// ---------------------------------------------------------------------------
// CC-298 — the rehearsal checks the embedded comment page is flattened too
// ---------------------------------------------------------------------------

test('CC-298: the get-issue check names wiki markup left in an embedded comment', () => {
  const issue = (body: unknown): unknown => ({
    fields: { description: 'Steps', comment: { comments: [{ body }] } },
  });
  assert.deepEqual(
    rehearsal.stepFindings('jira_get_issue', issue('Hi @user2, see this')),
    [],
  );
  assert.deepEqual(
    rehearsal.stepFindings('jira_get_issue', issue('Hi [~user2], see *this*')),
    [
      'jira_get_issue: wiki markup "[~" survived in embedded comment 0',
      'jira_get_issue: wiki markup "*this*" survived in embedded comment 0',
    ],
  );
  assert.deepEqual(rehearsal.stepFindings('jira_get_issue', { fields: {} }), [
    'jira_get_issue: no description came back',
    'jira_get_issue: no embedded comment came back',
  ]);
});

// ---------------------------------------------------------------------------
// CC-312 — the fake's Data Center user reads, and the checks that read them
// ---------------------------------------------------------------------------

test(
  'CC-312: the fake user search takes username, refuses the Cloud query param, and requires one',
  { skip: noTls },
  async () => {
    dc.clearRequests();
    const ok = await send(
      dc,
      'GET',
      '/jira/rest/api/2/user/search?username=user&startAt=0&maxResults=50',
      bearer(),
    );
    assert.equal(ok.status, 200);
    const rows = ok.json as Record<string, unknown>[];
    assert.ok(Array.isArray(rows) && rows.length === 2, 'both seed users match "user"');
    for (const row of rows) {
      assert.equal(typeof row['name'], 'string');
      assert.equal(typeof row['key'], 'string');
      assert.ok(!('accountId' in row), 'Data Center users have no accountId');
    }
    assert.equal(last(dc).violation, undefined);

    const cloudish = await send(
      dc,
      'GET',
      '/jira/rest/api/2/user/search?query=user',
      bearer(),
    );
    assert.equal(cloudish.status, 400);
    assert.equal(last(dc).violation, 'cloud_query_param_on_user_search');

    const bare = await send(dc, 'GET', '/jira/rest/api/2/user/search', bearer());
    assert.equal(bare.status, 400);

    const assignable = await send(
      dc,
      'GET',
      '/jira/rest/api/2/user/assignable/search?username=user&project=SCRATCH',
      bearer(),
    );
    assert.equal(assignable.status, 200);
    assert.equal(last(dc).route, 'GET /rest/api/2/user/assignable/search');
    const unscoped = await send(
      dc,
      'GET',
      '/jira/rest/api/2/user/assignable/search?username=user',
      bearer(),
    );
    assert.equal(
      unscoped.status,
      400,
      'an assignable search names a project or an issue',
    );
  },
);

test(
  'CC-312: the fake role detail names a user actor by name, with no accountId',
  { skip: noTls },
  async () => {
    const map = record(
      (await send(dc, 'GET', '/jira/rest/api/2/project/SCRATCH/role', bearer())).json,
    );
    assert.match(
      String(map['Administrators']),
      /\/jira\/rest\/api\/2\/project\/SCRATCH\/role\/10002$/,
    );
    const role = record(
      (await send(dc, 'GET', '/jira/rest/api/2/project/SCRATCH/role/10002', bearer()))
        .json,
    );
    const actors = role['actors'] as Record<string, unknown>[];
    const user = actors.find((a) => a['type'] === 'atlassian-user-role-actor');
    assert.ok(user !== undefined);
    assert.equal(user['name'], 'rehearsal');
    assert.ok(!('accountId' in user) && !('actorUser' in user));
    assert.ok(actors.some((a) => a['type'] === 'atlassian-group-role-actor'));
  },
);

test('CC-312: the step checks name a user row or a role actor that lost its name', () => {
  assert.deepEqual(
    rehearsal.stepFindings('jira_search_users', { users: [{ name: 'rehearsal' }] }),
    [],
  );
  assert.deepEqual(
    rehearsal.stepFindings('jira_search_users', { users: [{ displayName: 'User One' }] }),
    ['jira_search_users: user 0 has no name'],
  );
  assert.deepEqual(rehearsal.stepFindings('jira_search_users', { users: [] }), [
    'jira_search_users: no user came back',
  ]);
  assert.deepEqual(
    rehearsal.stepFindings('jira_list_project_roles', {
      actors: [{ type: 'atlassian-user-role-actor', name: 'rehearsal' }],
    }),
    [],
  );
  assert.deepEqual(
    rehearsal.stepFindings('jira_list_project_roles', {
      actors: [{ type: 'atlassian-user-role-actor', displayName: 'User One' }],
    }),
    ['jira_list_project_roles: no user actor came back with a name'],
  );
});

test(
  '[CC-348] the fake counts through the classic search and embeds the changelog and attachments Data Center-shaped',
  { skip: noTls },
  async () => {
    const count = record(
      (
        await send(dc, 'POST', '/jira/rest/api/2/search', bearer(), {
          jql: 'project = SCRATCH',
          startAt: 0,
          maxResults: 0,
          fields: ['summary'],
        })
      ).json,
    );
    assert.ok(Number.isInteger(count['total']) && (count['total'] as number) > 0);
    assert.deepEqual(count['issues'], []);

    const withChangelog = record(
      (
        await send(
          dc,
          'GET',
          '/jira/rest/api/2/issue/SCRATCH-1?expand=changelog&fields=',
          bearer(),
        )
      ).json,
    );
    const changelog = record(withChangelog['changelog']);
    const histories = changelog['histories'] as Record<string, unknown>[];
    assert.ok(histories.length > 0);
    assert.equal(changelog['total'], histories.length);
    assert.equal(typeof record(histories[0]?.['author'])['name'], 'string');
    assert.ok(!('accountId' in record(histories[0]?.['author'])));

    const withAttachments = record(
      (
        await send(
          dc,
          'GET',
          '/jira/rest/api/2/issue/SCRATCH-1?fields=attachment',
          bearer(),
        )
      ).json,
    );
    const attachments = record(withAttachments['fields'])['attachment'] as Record<
      string,
      unknown
    >[];
    assert.ok(attachments.length > 0);
    assert.equal(typeof record(attachments[0]?.['author'])['name'], 'string');
    // The URLs the server must strip are there to be stripped.
    assert.equal(typeof attachments[0]?.['content'], 'string');
  },
);

test('[CC-349] the step checks catch an approximate count, a nameless or incomplete changelog, and a kept attachment URL', () => {
  assert.deepEqual(
    rehearsal.stepFindings('jira_count', { count: 3, approximate: false }),
    [],
  );
  assert.deepEqual(
    rehearsal.stepFindings('jira_count', { count: 3, approximate: true }),
    ['jira_count: expected approximate: false on Data Center, got true'],
  );
  assert.deepEqual(rehearsal.stepFindings('jira_count', { approximate: false }), [
    'jira_count: no count came back, got undefined',
  ]);

  const history = { id: '1', author: { name: 'rehearsal' }, items: [] };
  assert.deepEqual(
    rehearsal.stepFindings('jira_get_changelog', { histories: [history] }),
    [],
  );
  assert.deepEqual(rehearsal.stepFindings('jira_get_changelog', { histories: [] }), [
    'jira_get_changelog: no history came back',
  ]);
  assert.deepEqual(
    rehearsal.stepFindings('jira_get_changelog', {
      histories: [{ id: '1', author: { displayName: 'User One' }, items: [] }],
    }),
    ['jira_get_changelog: history 0 has no author name'],
  );
  assert.deepEqual(
    rehearsal.stepFindings('jira_get_changelog', {
      histories: [history],
      incomplete: { note: 'INCOMPLETE' },
    }),
    ['jira_get_changelog: a whole embedded history was flagged incomplete'],
  );

  const attachment = { id: '60001', filename: 'a.txt', author: { name: 'rehearsal' } };
  assert.deepEqual(
    rehearsal.stepFindings('jira_list_attachments', { attachments: [attachment] }),
    [],
  );
  assert.deepEqual(rehearsal.stepFindings('jira_list_attachments', { attachments: [] }), [
    'jira_list_attachments: no attachment came back',
  ]);
  assert.deepEqual(
    rehearsal.stepFindings('jira_list_attachments', {
      attachments: [{ ...attachment, author: undefined, content: 'https://x/a.txt' }],
    }),
    [
      'jira_list_attachments: attachment 0 has no author name',
      'jira_list_attachments: attachment 0 kept its "content" URL',
    ],
  );
});

test(
  '[CC-358] the Data Center fake serves the favourites and one filter, and answers /filter/search 404 as a violation',
  { skip: noTls },
  async () => {
    const favourites = await send(
      dc,
      'GET',
      '/jira/rest/api/2/filter/favourite',
      bearer(),
    );
    assert.equal(favourites.status, 200);
    assert.ok(Array.isArray(favourites.json), 'the favourites list is a bare array');
    const [row] = favourites.json as unknown[];
    const owner = record(record(row)['owner']);
    assert.equal(typeof owner['name'], 'string');
    assert.ok(!('accountId' in owner));
    // The share internals are there for the server's allowlist to refuse.
    assert.ok(Array.isArray(record(row)['sharePermissions']));
    assert.equal(last(dc).route, 'GET /rest/api/2/filter/favourite');

    const one = await send(dc, 'GET', '/jira/rest/api/2/filter/10000', bearer());
    assert.equal(one.status, 200);
    assert.equal(record(one.json)['jql'], record(row)['jql']);
    assert.equal(last(dc).route, 'GET /rest/api/2/filter/{id}');

    const search = await send(dc, 'GET', '/jira/rest/api/2/filter/search', bearer());
    assert.equal(search.status, 404);
    assert.equal(last(dc).violation, 'cloud_filter_search_on_datacenter');
    assert.ok(
      rehearsal
        .wireFindings([last(dc)], '/jira', [])
        .some((line) => line.includes('cloud_filter_search_on_datacenter')),
      'the wire audit names the /filter/search violation',
    );
    assert.ok(fakeJira.DATACENTER_ROUTES.includes('GET /rest/api/2/filter/favourite'));
    assert.ok(fakeJira.DATACENTER_ROUTES.includes('GET /rest/api/2/filter/{id}'));
  },
);

test('[CC-359] the step checks catch a filter list with no scope or owner name, and a filter that kept its share internals', () => {
  const filter = {
    id: '10000',
    name: 'Mine',
    jql: 'x = y',
    owner: { name: 'rehearsal' },
  };
  const scope = { source: 'favourites', note: 'SCOPE' };
  assert.deepEqual(
    rehearsal.stepFindings('jira_list_filters', { filters: [filter], scope }),
    [],
  );
  assert.deepEqual(rehearsal.stepFindings('jira_list_filters', { filters: [], scope }), [
    'jira_list_filters: no filter came back',
  ]);
  assert.deepEqual(
    rehearsal.stepFindings('jira_list_filters', {
      filters: [{ ...filter, owner: { displayName: 'User One' } }],
    }),
    [
      'jira_list_filters: filter 0 has no owner name',
      'jira_list_filters: expected scope.source "favourites", got undefined',
    ],
  );
  assert.deepEqual(rehearsal.stepFindings('jira_get_filter', { filter }), []);
  assert.deepEqual(
    rehearsal.stepFindings('jira_get_filter', {
      filter: { id: '10000', name: 'Mine', sharePermissions: [] },
    }),
    [
      'jira_get_filter: no jql came back',
      'jira_get_filter: the filter has no owner name',
      'jira_get_filter: the filter kept its "sharePermissions"',
    ],
  );
  const planned = rehearsal.DATACENTER_PLAN.map((step) => step.tool);
  assert.ok(planned.includes('jira_list_filters'));
  assert.ok(planned.includes('jira_get_filter'));
});

// ---------------------------------------------------------------------------
// CC-366, CC-367 — the create metadata (D116, stage 13.7b)
// ---------------------------------------------------------------------------

test(
  '[CC-366] the Data Center fake pages the create metadata in `values`, a user default carrying an email',
  { skip: noTls },
  async () => {
    const types = await send(
      dc,
      'GET',
      '/jira/rest/api/2/issue/createmeta/SCRATCH/issuetypes',
      bearer(),
    );
    assert.equal(types.status, 200);
    const typePage = record(types.json);
    assert.equal(typePage['isLast'], true);
    assert.ok(Array.isArray(typePage['values']) && typePage['values'].length > 0);
    assert.ok(!('issueTypes' in typePage), 'the Cloud key is not Data Center');
    assert.equal(
      last(dc).route,
      'GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes',
    );

    const screen = await send(
      dc,
      'GET',
      '/jira/rest/api/2/issue/createmeta/SCRATCH/issuetypes/10001?startAt=0&maxResults=2',
      bearer(),
    );
    assert.equal(screen.status, 200);
    const screenPage = record(screen.json);
    assert.equal(screenPage['isLast'], false);
    assert.equal(screenPage['maxResults'], 2);
    // Without a user default that carries an email, the rehearsal's leak check
    // could not show the server dropping `defaultValue`.
    const whole = await send(
      dc,
      'GET',
      '/jira/rest/api/2/issue/createmeta/SCRATCH/issuetypes/10001',
      bearer(),
    );
    assert.match(JSON.stringify(whole.json), /"defaultValue":\{[^}]*"emailAddress"/);

    const unknown = await send(
      dc,
      'GET',
      '/jira/rest/api/2/issue/createmeta/SCRATCH/issuetypes/99999',
      bearer(),
    );
    assert.equal(unknown.status, 404);
  },
);

test(
  '[CC-366] the legacy all-projects create metadata is a 404 on the Data Center fake, recorded as a violation',
  { skip: noTls },
  async () => {
    const reply = await send(
      dc,
      'GET',
      '/jira/rest/api/2/issue/createmeta?projectKeys=SCRATCH&expand=projects.issuetypes.fields',
      bearer(),
    );
    assert.equal(reply.status, 404);
    assert.equal(last(dc).violation, 'legacy_createmeta_removed_in_jira_9');
    // The two paged routes are ones a clean rehearsal must hit; the legacy
    // route is not.
    for (const route of [
      'GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes',
      'GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
    ]) {
      assert.ok(fakeJira.DATACENTER_ROUTES.includes(route), route);
    }
    assert.ok(
      !fakeJira.DATACENTER_ROUTES.includes('GET /rest/api/2/issue/createmeta'),
      'the legacy route is not one a clean rehearsal must hit',
    );
    const findings = rehearsal.wireFindings([{ ...last(dc) }], '/jira', []);
    assert.ok(
      findings.some((line) => line.includes('legacy_createmeta_removed_in_jira_9')),
      findings.join('\n'),
    );
  },
);

test('[CC-367] the rehearsal calls the create metadata twice — the type list, then a checked create screen', () => {
  const step = rehearsal.DATACENTER_PLAN.find(
    (entry) => entry.tool === 'jira_get_create_meta',
  );
  assert.ok(step !== undefined, 'the plan does not call jira_get_create_meta');
  assert.equal(step.args?.['issueTypeId'], undefined);
  assert.equal(step.also?.length, 1);
  assert.equal(typeof step.also?.[0]?.['issueTypeId'], 'string');
  assert.equal(step.checkAlso, true);
});

test('[CC-367] the step checks catch an empty type list, a partial or summary-less screen, and a kept defaultValue', () => {
  const check = (data: unknown): string[] =>
    rehearsal.stepFindings('jira_get_create_meta', data);
  const summary = { fieldId: 'summary', name: 'Summary', required: true };

  assert.deepEqual(
    check({ step: 'choose_issue_type', issueTypes: [{ id: '10001' }] }),
    [],
  );
  assert.deepEqual(
    check({
      step: 'create_screen',
      complete: true,
      fields: [summary],
      required: [summary],
    }),
    [],
  );

  assert.match(
    check({ step: 'choose_issue_type', issueTypes: [] }).join('\n'),
    /no issue type came back/,
  );
  assert.match(
    check({ step: 'create_screen', complete: false, fieldsSoFar: [summary] }).join('\n'),
    /flagged partial/,
  );
  assert.match(
    check({ step: 'create_screen', complete: true, fields: [], required: [] }).join('\n'),
    /no create-screen field came back/,
  );
  assert.match(
    check({
      step: 'create_screen',
      complete: true,
      fields: [{ fieldId: 'labels' }],
      required: [],
    }).join('\n'),
    /summary is not among the required fields/,
  );
  assert.match(
    check({
      step: 'create_screen',
      complete: true,
      fields: [{ ...summary, defaultValue: { name: 'rehearsal' } }],
      required: [summary],
    }).join('\n'),
    /kept its defaultValue/,
  );
  assert.match(check({ step: 'wat' }).join('\n'), /unexpected step/);
});

// ---------------------------------------------------------------------------
// CC-379 — the attachment download (D117, stage 13.8)
// ---------------------------------------------------------------------------

test(
  '[CC-379] the Data Center fake serves attachment metadata on v2 and the bytes from the servlet, by exact filename',
  { skip: noTls },
  async () => {
    const meta = await send(dc, 'GET', '/jira/rest/api/2/attachment/60001', bearer());
    assert.equal(meta.status, 200);
    const row = record(meta.json);
    assert.equal(row['filename'], 'rehearsal-sample.txt');
    assert.equal(record(row['author'])['name'], 'rehearsal');
    assert.ok(!('accountId' in record(row['author'])));
    assert.match(
      String(row['content']),
      /\/jira\/secure\/attachment\/60001\/rehearsal-sample\.txt$/,
    );
    assert.equal(last(dc).route, 'GET /rest/api/2/attachment/{id}');

    const bytes = await send(
      dc,
      'GET',
      '/jira/secure/attachment/60001/rehearsal-sample.txt',
      bearer(),
    );
    assert.equal(bytes.status, 200);
    assert.match(bytes.text, /^Gate C rehearsal attachment\./);
    assert.equal(last(dc).route, 'GET /secure/attachment/{id}/{filename}');
    assert.equal(last(dc).violation, undefined);

    // The servlet answers the id AND the name it holds, nothing looser.
    for (const path of [
      '/jira/secure/attachment/60001/other.txt',
      '/jira/secure/attachment/99999/rehearsal-sample.txt',
    ]) {
      assert.equal((await send(dc, 'GET', path, bearer())).status, 404, path);
    }
    assert.equal(
      (await send(dc, 'GET', '/jira/rest/api/2/attachment/99999', bearer())).status,
      404,
    );

    for (const route of [
      'GET /rest/api/2/attachment/{id}',
      'GET /secure/attachment/{id}/{filename}',
    ]) {
      assert.ok(fakeJira.DATACENTER_ROUTES.includes(route), route);
    }
  },
);

test(
  '[CC-379] the Cloud content route is a 404 on the Data Center fake, recorded as a violation the wire audit names',
  { skip: noTls },
  async () => {
    for (const path of [
      '/jira/rest/api/2/attachment/content/60001',
      '/jira/rest/api/3/attachment/content/60001?redirect=false',
    ]) {
      const reply = await send(dc, 'GET', path, bearer());
      assert.equal(reply.status, 404, path);
      assert.equal(last(dc).violation, 'cloud_attachment_content_on_datacenter', path);
      const findings = rehearsal.wireFindings([{ ...last(dc) }], '/jira', []);
      assert.ok(
        findings.some((line) => line.includes('cloud_attachment_content_on_datacenter')),
        findings.join('\n'),
      );
    }
  },
);

test('[CC-379] the rehearsal downloads once into a JIRA_MEDIA_DIR the child is given', () => {
  const steps = rehearsal.DATACENTER_PLAN.filter(
    (entry) => entry.tool === 'jira_download_attachment',
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.args?.['attachmentId'], '60001');
  assert.ok(!rehearsal.DATACENTER_PLAN.some((e) => e.tool === 'jira_upload_attachment'));

  const base = {
    home: '/h',
    site: 'https://jira.rehearsal.test:1/jira',
    pat: 'p',
    certFile: '/c.pem',
    preloadUrl: 'file:///p.mjs',
  };
  assert.equal(
    rehearsal.dataCenterChildEnv({ ...base, mediaDir: '/m' })['JIRA_MEDIA_DIR'],
    '/m',
  );
  assert.ok(!('JIRA_MEDIA_DIR' in rehearsal.dataCenterChildEnv(base)));
});

test('[CC-379] the download check names a file outside the media dir, wrong bytes, a wrong count, and no path', () => {
  const expected = new Uint8Array([1, 2, 3]);
  const data = { path: '/m/a.txt', name: 'a.txt', bytes: 3 };
  const disk = { mediaDir: '/m', fileDir: '/m', expected, actual: expected };
  assert.deepEqual(rehearsal.downloadFindings(data, disk), []);

  const cases: readonly [
    Record<string, unknown>,
    typeof disk | Record<string, unknown>,
    RegExp,
  ][] = [
    [data, { ...disk, fileDir: '/elsewhere' }, /not the media directory/],
    [data, { ...disk, actual: new Uint8Array([1, 2, 4]) }, /not the attachment/],
    [data, { ...disk, actual: undefined }, /could not be read back/],
    [{ ...data, bytes: 4 }, disk, /reported 4 bytes, expected 3/],
    [{ name: 'a.txt' }, disk, /no path or name/],
  ];
  for (const [result, where, pattern] of cases) {
    const findings = rehearsal.downloadFindings(result, where as typeof disk);
    assert.ok(
      findings.some((line) => pattern.test(line)),
      `${pattern.source} not found in:\n${findings.join('\n')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// CC-1500 — a certificate left in the cert directory is not reused past expiry
// ---------------------------------------------------------------------------

test(
  '[CC-1500] an expired or unreadable certificate in the cert dir is regenerated, a live one reused',
  { skip: noTls },
  () => {
    // The fake's default cert dir is a fixed path under the OS temp dir, so it
    // outlives the two-day certificate; reusing it then failed every handshake.
    const dir = mkdtempSync(join(tmpdir(), 'jira-mcp-dc-cert-test-'));
    try {
      const first = fakeJira.ensureCertificate(dir);
      const again = fakeJira.ensureCertificate(dir);
      assert.deepEqual(again.cert, first.cert, 'a live certificate is reused');

      const threeDays = 3 * 24 * 60 * 60 * 1000;
      const later = fakeJira.ensureCertificate(dir, Date.now() + threeDays);
      assert.notDeepEqual(later.cert, first.cert, 'an expired certificate is replaced');

      writeFileSync(join(dir, 'fake-jira-cert.pem'), 'truncated');
      const repaired = fakeJira.ensureCertificate(dir);
      assert.match(Buffer.from(repaired.cert).toString('utf8'), /BEGIN CERTIFICATE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// CC-1501 — a set-up failure still removes the rehearsal's workdir
// ---------------------------------------------------------------------------

test('[CC-1501] a rehearsal that cannot start its fake leaves no workdir behind', async () => {
  // No openssl on PATH is the set-up failure the header names; the workdir
  // was made before the fake and removed only by a finally the fake never reached.
  const temp = mkdtempSync(join(tmpdir(), 'jira-mcp-dc-workdir-test-'));
  const saved = { TMPDIR: process.env['TMPDIR'], PATH: process.env['PATH'] };
  process.env['TMPDIR'] = temp;
  process.env['PATH'] = '';
  try {
    await assert.rejects(rehearsal.runDataCenterRehearsal(), /openssl/);
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CC-1502 — a server that fails past set-up is a finding, not a set-up error
// ---------------------------------------------------------------------------

test(
  '[CC-1502] a server that dies on start is reported as a finding, not thrown as a set-up error',
  { skip: noTls },
  async () => {
    // A throw reached main() and exited 2 — "set-up error" — for what is a
    // server regression, and dropped every finding gathered before it.
    const dir = mkdtempSync(join(tmpdir(), 'jira-mcp-dc-dead-server-'));
    const entry = join(dir, 'dead-server.mjs');
    writeFileSync(entry, 'process.exit(3);\n');
    try {
      const result = await rehearsal.runDataCenterRehearsal({ serverEntry: entry });
      assert.ok(
        result.findings.some((line) => line.startsWith('rehearsal aborted: ')),
        result.findings.join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
