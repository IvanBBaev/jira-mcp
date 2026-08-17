// Adversarial suite for `scripts/record-fixture.mjs` — the redaction half of
// TESTING.md §Fixtures, ported from the wave-9 scratchpad driver so it actually
// runs in `npm run check` instead of in a file nobody executes.
//
// It drives the REAL recorder with an injected fake fetch whose responses carry
// every category of sensitive value we know how to leak, then reads the artefact
// BACK OFF DISK and asserts none of them survived. Reading the file rather than
// the in-memory document is the whole point: the fixture is what gets committed
// forever, and the last transformation before it lands (key sorting, the
// `assertClean` gate, the 0600 write) is exactly where a leak would hide.
//
// **Why a compiled test may import `scripts/`.** The layering zones in
// `eslint.config.js` (`import-x/no-restricted-paths` plus the string-based
// `no-restricted-imports`) target `./src/core`, `./src/api` and `./src/mcp`.
// `src/testing/**` is not a zone member in either direction, so reaching the
// recorder from here weakens nothing and needs no override. The import is a
// dynamic `import()` of a `file:` URL built from the repo root — a `.mjs` file
// outside `rootDir` cannot be a static import without dragging it into the
// TypeScript program, and there is no `.d.ts` for it; the shapes below are this
// suite's own reading of the recorder's contract, which is why the assertions
// are all against observable behaviour rather than types.
//
// **What this suite needs:** a current `build/`. The recorder loads the compiled
// `build/core/*` and `build/api/*` itself (that is the code under test — the
// redactor and the HTTP client are the real ones), so a stale build tests stale
// behaviour. `npm run check` builds before it tests, so the gate is honest.
//
// Every constant below is a fabricated tenant. If one of them ever appears in a
// file under `test/fixtures/`, the other half of this work — the corpus lint in
// `./fixture-pii.test.ts` — is what fails.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { REPO_ROOT } from '../core/fakes/fixtures.js';
import type { Clock } from '../core/types.js';

// --- the recorder's contract, as this suite understands it -----------------

interface RecordOptions {
  readonly scenario: string;
  readonly out: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
  readonly force?: boolean;
  readonly maxBodyBytes?: number;
  readonly allowOpaqueKeys?: readonly string[];
  readonly note?: string;
  readonly log?: (message: string) => void;
}

interface RecordSummary {
  readonly path: string;
  readonly bytes: number;
  readonly exchanges: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly stats: unknown;
  readonly warnings: readonly string[];
}

interface RecordModule {
  readonly record: (options: RecordOptions) => Promise<RecordSummary>;
}

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

const RECORDER_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'record-fixture.mjs')).href;

let recorderModule: Promise<RecordModule> | undefined;

/** Load the recorder once; a second `import()` of the same URL is cached anyway. */
function loadRecorder(): Promise<RecordModule> {
  // A computed specifier is `any` to TypeScript — asserted, not trusted: every
  // property this suite touches is exercised below.
  recorderModule ??= import(RECORDER_URL) as Promise<RecordModule>;
  return recorderModule;
}

// --- the shape of what lands on disk ---------------------------------------

interface RecordedRequest {
  readonly method?: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly headersDropped?: readonly string[];
  readonly body?: unknown;
}

interface RecordedResponse {
  readonly status: number;
  readonly statusText?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface RecordedExchange {
  readonly request: RecordedRequest;
  readonly response?: RecordedResponse;
  readonly error?: { readonly name: string; readonly message: string };
}

interface RecordedDocument {
  readonly scenario: string;
  readonly synthetic: boolean;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly site: string;
  readonly note?: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly exchanges: readonly RecordedExchange[];
}

interface AdfNode {
  readonly type: string;
  readonly version?: number;
  readonly text?: string;
  readonly content?: readonly AdfNode[];
}

interface RecordedUser {
  readonly self: string;
  readonly accountId: string;
  readonly emailAddress?: string;
  readonly displayName: string;
  readonly avatarUrls: Readonly<Record<string, string>>;
}

interface RecordedAttachment {
  readonly content: string;
  readonly thumbnail: string;
}

interface RecordedIssue {
  readonly key: string;
  readonly fields: {
    readonly assignee: RecordedUser;
    readonly description: AdfNode;
    readonly customfield_10099: Readonly<Record<string, string>>;
    readonly attachment: readonly RecordedAttachment[];
  };
}

interface SearchBody {
  readonly nextPageToken?: string;
  readonly issues: readonly RecordedIssue[];
}

// --- the tenant we are pretending to be ------------------------------------
// Every literal here is a leak if it lands in the artefact.

const SITE = 'acme-prod.atlassian.net';
const REAL_EMAIL = 'ivan.baev@acmecorp.example';
const REAL_TOKEN = 'ATATT3xFfGF0TfRealTokenValue0123456789abcdefGHIJKLMNOP';
const BASIC = Buffer.from(`${REAL_EMAIL}:${REAL_TOKEN}`).toString('base64');

const SECOND_EMAIL = 'maria.petrova@acmecorp.example';
const ACCOUNT_A = '5d8f2a9c1b3e4f5a6b7c8d9e';
const ACCOUNT_B = '712020:3f6e6a3d-1c2b-4a5e-9f01-2b3c4d5e6f70';
const NAME_A = 'Ivan Baev';
const NAME_B = 'Maria Petrova';
/** Under the recorder's four-character floor for free-text needles — CC-71. */
const SHORT_NAME = 'Bob';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' +
  'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const SIGNED_TOKEN = 'S3cretMediaTokenAbcdefGhijklMnopQrstuvWxyz0123456789';
const NEXT_PAGE_TOKEN = 'CAEaAggDKAEwAToJCgcIBBCg3rICQgIIAA0eZXhhbXBsZQ0eXAMPLE99';
const OPAQUE_BLOB = 'Zm9vYmFyQmF6UXV4MDEyMzQ1Njc4OWFiY2RlZkdISUpLTE1OT1A';
const GRAVATAR_HASH = '9f8e7d6c5b4a39281706';

const ENV = {
  JIRA_SITE: SITE,
  JIRA_EMAIL: REAL_EMAIL,
  JIRA_API_TOKEN: REAL_TOKEN,
  JIRA_LOG_LEVEL: 'error',
} as const;

/**
 * Frozen, and never advanced. `now()` therefore makes `recordedAt` deterministic
 * so a re-record is byte-identical, and `sleep()` resolves only on a tick that
 * never comes — so the timeout race inside `core/http.ts` can never beat the
 * (instant) fake fetch. It still rejects with an `AbortError` when cancelled,
 * which is the contract `armDeadline` awaits on the way out.
 */
const CLOCK: Clock = createFakeClock(Date.parse('2026-01-02T03:04:05.000Z'));

// --- fake wire payloads ----------------------------------------------------

function json(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      // A tenant cookie: the KEY must not survive at all, masked or otherwise.
      'set-cookie': `atlassian.xsrf.token=${SIGNED_TOKEN}; Path=/; Secure`,
      'x-aaccountid': ACCOUNT_A,
      ...headers,
    },
  });
}

function user(accountId: string, email: string, name: string): RecordedUser {
  return {
    self: `https://${SITE}/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`,
    accountId,
    emailAddress: email,
    displayName: name,
    avatarUrls: {
      '48x48':
        `https://secure.gravatar.com/avatar/${GRAVATAR_HASH}` +
        `?d=https%3A%2F%2F${SITE}%2Favatar.png`,
      '24x24': `https://${SITE}/secure/useravatar?size=small&ownerId=${accountId}`,
    },
  };
}

/** A deep ADF tree — deeper than the redactor's MAX_DEPTH of 12, on purpose. */
function deepAdf(depth: number, leafText: string): AdfNode {
  let node: AdfNode = { type: 'text', text: leafText };
  for (let i = 0; i < depth; i += 1) {
    node = { type: i % 2 === 0 ? 'paragraph' : 'tableCell', content: [node] };
  }
  return { type: 'doc', version: 1, content: [node] };
}

const SEARCH_PAGE_1 = {
  nextPageToken: NEXT_PAGE_TOKEN,
  issues: [
    {
      id: '10001',
      key: 'ACME-1',
      self: `https://${SITE}/rest/api/3/issue/10001`,
      fields: {
        summary: `Ping ${NAME_A} about the ${SITE} migration`,
        assignee: user(ACCOUNT_A, REAL_EMAIL, NAME_A),
        reporter: user(ACCOUNT_B, SECOND_EMAIL, NAME_B),
        // accountIds nested in arrays, several levels down
        watchers: { watchers: [{ accountId: ACCOUNT_A }, { accountId: ACCOUNT_B }] },
        // a display name inside deep ADF text
        description: deepAdf(16, `Escalated by ${NAME_B} (${SECOND_EMAIL})`),
        // pathological: the sensitive value is the KEY, not the value
        customfield_10099: { [REAL_EMAIL]: 'watching', [ACCOUNT_A]: 'lead' },
        // pathological: a token in a URL query string
        attachment: [
          {
            content:
              `https://api.media.atlassian.com/file/abc/binary` +
              `?token=${JWT}&client=${ACCOUNT_A}`,
            thumbnail: `https://api.media.atlassian.com/file/abc/image?sig=${SIGNED_TOKEN}`,
            author: user(ACCOUNT_A, REAL_EMAIL, NAME_A),
          },
        ],
      },
    },
  ],
};

const SEARCH_PAGE_2 = {
  issues: [
    {
      id: '10002',
      key: 'ACME-2',
      self: `https://${SITE}/rest/api/3/issue/10002`,
      fields: {},
    },
  ],
};

type FakeHandler = (
  url: string,
  init?: unknown,
) => Response | undefined | Promise<Response | undefined>;

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input !== null && typeof input === 'object' && 'url' in input) {
    const { url } = input;
    if (typeof url === 'string') return url;
  }
  throw new Error('the fake fetch was handed an input shape it does not understand');
}

function fakeFetch(handler: FakeHandler): FetchLike {
  return async (input, init) => {
    const url = urlOf(input);
    const response = await handler(url, init);
    // An unmatched URL is a bug in the test, not a silent empty response.
    assert.ok(response instanceof Response, `no fake response for ${url}`);
    return response;
  };
}

/** The two-page search, which is what most of group 1 asserts against. */
const searchFetch = (): FetchLike =>
  fakeFetch((url) =>
    url.includes('nextPageToken') ? json(200, SEARCH_PAGE_2) : json(200, SEARCH_PAGE_1),
  );

// --- harness ---------------------------------------------------------------

const DIR = mkdtempSync(join(tmpdir(), 'record-fixture-test-'));

after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const out = (name: string): string => join(DIR, `${name}.json`);

const searchOut = out('search-page');

function required<T>(value: T | undefined, what: string): T {
  assert.ok(value !== undefined, `${what} is missing from the recorded document`);
  return value;
}

async function readDocument(path: string): Promise<RecordedDocument> {
  return JSON.parse(await readFile(path, 'utf8')) as RecordedDocument;
}

interface SearchRecording {
  readonly summary: RecordSummary;
  /** The artefact's exact bytes — what a reviewer would read. */
  readonly text: string;
  readonly doc: RecordedDocument;
}

let searchRun: Promise<SearchRecording> | undefined;

/**
 * Record the search scenario exactly once, no matter which test needs it first.
 * Thirteen of the checks below are "this string is not in that file", and each
 * deserves its own name in the report; re-recording per test would be thirteen
 * runs of the same work — and the destination may only be written once.
 */
function searchRecording(): Promise<SearchRecording> {
  searchRun ??= (async (): Promise<SearchRecording> => {
    const { record } = await loadRecorder();
    const summary = await record({
      scenario: 'search-page',
      out: searchOut,
      params: { jql: 'project = ACME order by created DESC' },
      env: ENV,
      clock: CLOCK,
      fetchImpl: searchFetch(),
    });
    const text = await readFile(searchOut, 'utf8');
    return { summary, text, doc: JSON.parse(text) as RecordedDocument };
  })();
  return searchRun;
}

function exchange(doc: RecordedDocument, index = 0): RecordedExchange {
  return required(doc.exchanges[index], `exchange ${String(index)}`);
}

function responseOf(doc: RecordedDocument, index = 0): RecordedResponse {
  return required(exchange(doc, index).response, `exchange ${String(index)} response`);
}

function searchBody(doc: RecordedDocument, index = 0): SearchBody {
  return responseOf(doc, index).body as SearchBody;
}

function firstIssue(doc: RecordedDocument): RecordedIssue {
  return required(searchBody(doc).issues[0], 'issue 0');
}

// ---------------------------------------------------------------------------
// 1. The happy path, then read the artefact back off disk
// ---------------------------------------------------------------------------

test('records two pages through the real api/* path', async () => {
  const { summary } = await searchRecording();
  assert.equal(summary.exchanges, 2);
  assert.equal(summary.path, searchOut);
});

const NEEDLES: readonly (readonly [string, string])[] = [
  ['site host', SITE],
  ['site label', 'acme-prod'],
  ['api token', REAL_TOKEN],
  ['basic blob', BASIC],
  ['owner email', REAL_EMAIL],
  ['second email', SECOND_EMAIL],
  ['accountId (24-hex)', ACCOUNT_A],
  ['accountId (legacy)', ACCOUNT_B],
  ['display name A', NAME_A],
  ['display name B', NAME_B],
  ['JWT', JWT],
  ['signed media token', SIGNED_TOKEN],
  ['gravatar hash', GRAVATAR_HASH],
];

for (const [label, needle] of NEEDLES) {
  test(`on-disk file contains no ${label}`, async () => {
    const { text } = await searchRecording();
    assert.ok(!text.includes(needle), `found ${JSON.stringify(needle)} in the fixture`);
  });
}

test('uses the documented placeholder vocabulary', async () => {
  const { text } = await searchRecording();
  assert.match(text, /example\.atlassian\.net/);
  assert.match(text, /user-1@example\.invalid/);
  assert.match(text, /5b10a2844c20165700ede201/);
  assert.match(text, /User 1/);
});

test('replaces a display name buried 16 ADF levels deep', async () => {
  const { text, doc } = await searchRecording();
  assert.ok(!text.includes('[MAX_DEPTH]'), 'redactor depth cap leaked into the fixture');

  const description = firstIssue(doc).fields.description;
  let node = required(description.content?.[0], 'ADF root child');
  let depth = 0;
  while (node.content !== undefined) {
    node = required(node.content[0], `ADF child at depth ${String(depth)}`);
    depth += 1;
  }
  assert.ok(depth >= 15, `ADF tree was flattened at depth ${String(depth)}`);
  assert.match(
    required(node.text, 'ADF leaf text'),
    /Escalated by User \d+ \(user-\d+@example\.invalid\)/,
  );
});

/**
 * The other half of the display-name story, and the uncomfortable one. A name
 * too short to be a safe free-text needle is left in prose ON PURPOSE — see
 * CC-71 — so what this test pins is that the decision stays *visible*: the
 * field is still replaced, the prose residue is still there, and the run says
 * so out loud. If the recorder ever starts sweeping short names silently, the
 * first two assertions flip; if it stops warning, the third does.
 */
test('CC-71: a display name too short to sweep survives in prose, and is announced', async () => {
  const { record } = await loadRecorder();
  const shortOut = out('short-display-name');
  const prose = `Escalated by ${SHORT_NAME} after the standup`;
  const summary = await record({
    scenario: 'search-page',
    out: shortOut,
    params: { jql: 'project = ACME' },
    env: ENV,
    clock: CLOCK,
    fetchImpl: fakeFetch(() =>
      json(200, {
        issues: [
          {
            id: '10003',
            key: 'ACME-3',
            self: `https://${SITE}/rest/api/3/issue/10003`,
            fields: {
              assignee: user(ACCOUNT_A, REAL_EMAIL, SHORT_NAME),
              description: deepAdf(2, prose),
            },
          },
        ],
      }),
    ),
  });

  const doc = await readDocument(shortOut);
  const issue = required(searchBody(doc).issues[0], 'issue 0');

  // 1. The `displayName` FIELD is replaced even when the name is short.
  assert.match(issue.fields.assignee.displayName, /^User \d+$/);

  // 2. The same name inside free text is deliberately NOT swept. Asserting the
  //    residue is the point: this is the documented cost of not corrupting a
  //    fixture by replacing every "Bob" in every body.
  let node: AdfNode = required(issue.fields.description.content?.[0], 'ADF root child');
  while (node.content !== undefined) node = required(node.content[0], 'ADF child');
  assert.equal(required(node.text, 'ADF leaf text'), prose);

  // 3. …and the run said so, so the residue is reviewed, not silent.
  assert.ok(
    summary.warnings.some((w) => w.includes('shorter than 4 characters')),
    `no short-name warning in ${JSON.stringify(summary.warnings)}`,
  );
});

test('a sensitive value used as an object KEY is redacted', async () => {
  const { doc } = await searchRecording();
  const keys = Object.keys(firstIssue(doc).fields.customfield_10099);
  assert.deepEqual(keys.sort(), ['5b10a2844c20165700ede201', 'user-1@example.invalid']);
});

test('a token embedded in a URL query is masked, URL shape kept', async () => {
  const { doc } = await searchRecording();
  const attachment = required(firstIssue(doc).fields.attachment[0], 'attachment 0');
  assert.match(
    attachment.content,
    /^https:\/\/api\.media\.atlassian\.com\/file\/abc\/binary\?/,
  );
  assert.match(attachment.content, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  assert.match(attachment.thumbnail, /sig=%5BREDACTED%5D|sig=\[REDACTED\]/);
});

test('credential headers are dropped, not masked', async () => {
  const { doc } = await searchRecording();
  const request = exchange(doc).request;
  assert.equal(request.headers.authorization, undefined);
  assert.deepEqual(request.headersDropped, ['authorization']);
  assert.equal(responseOf(doc).headers['set-cookie'], undefined);
  const flat = JSON.stringify(doc).toLowerCase();
  assert.ok(!flat.includes('"set-cookie"'), 'a set-cookie KEY reached the document');
});

test('avatar URLs (incl. the gravatar hash of an email) are replaced', async () => {
  const { doc } = await searchRecording();
  const avatars = firstIssue(doc).fields.assignee.avatarUrls;
  assert.deepEqual(Object.values(avatars).sort(), [
    'https://example.atlassian.net/avatar/24x24',
    'https://example.atlassian.net/avatar/48x48',
  ]);
});

test('nextPageToken survives — it is the one legitimate opaque blob', async () => {
  const { doc } = await searchRecording();
  assert.equal(searchBody(doc).nextPageToken, NEXT_PAGE_TOKEN);
  assert.equal(doc.exchanges.length, 2);
});

test('file mode is 0600', async () => {
  await searchRecording();
  const info = await stat(searchOut);
  assert.equal(info.mode & 0o777, 0o600);
});

test('output is deterministic: re-recording is byte-identical', async () => {
  const { text } = await searchRecording();
  const { record } = await loadRecorder();
  const again = out('search-page-again');
  await record({
    scenario: 'search-page',
    out: again,
    params: { jql: 'project = ACME order by created DESC' },
    env: ENV,
    clock: CLOCK,
    fetchImpl: searchFetch(),
  });
  // Byte-for-byte: the destination path never appears inside the document, so
  // there is nothing legitimate to normalise away before comparing.
  assert.equal(await readFile(again, 'utf8'), text);
});

test('object keys are sorted, so a re-record diffs as data', async () => {
  const { doc } = await searchRecording();
  const keys = Object.keys(exchange(doc).request);
  assert.deepEqual(keys, [...keys].sort());
});

test('never silently overwrites an existing fixture', async () => {
  const { text } = await searchRecording();
  const { record } = await loadRecorder();
  await assert.rejects(
    record({
      scenario: 'myself',
      out: searchOut,
      env: ENV,
      clock: CLOCK,
      fetchImpl: fakeFetch(() => json(200, user(ACCOUNT_A, REAL_EMAIL, NAME_A))),
    }),
    /already exists/,
  );
  assert.equal(
    await readFile(searchOut, 'utf8'),
    text,
    'the existing fixture was touched',
  );
});

test('the envelope declares its own provenance', async () => {
  // Not in the wave-9 driver: this is the invariant the corpus lint in
  // ./fixture-pii.test.ts relies on when it decides whether a committed fixture
  // is allowed to claim it was recorded rather than hand-written.
  const { doc } = await searchRecording();
  assert.equal(doc.scenario, 'search-page');
  assert.equal(doc.synthetic, false);
  assert.equal(doc.recordedBy, 'scripts/record-fixture.mjs');
  assert.equal(doc.recordedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(doc.site, 'example.atlassian.net');
});

// ---------------------------------------------------------------------------
// 2. Pathological: a body that is not UTF-8
// ---------------------------------------------------------------------------

test('binary body becomes a descriptor, never bytes or base64', async () => {
  const { record } = await loadRecorder();
  const target = out('binary');
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xfd,
  ]);
  // Driven through error-404 on purpose: the api layer rejects a body it cannot
  // parse, and only an error scenario treats that rejection as the expected
  // outcome — so the exchange still reaches the file, which is what is under test.
  const result = await record({
    scenario: 'error-404',
    out: target,
    env: ENV,
    clock: CLOCK,
    fetchImpl: fakeFetch(
      () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    ),
  });
  const doc = await readDocument(target);
  const body = responseOf(doc).body as { $binary?: unknown };
  assert.deepEqual(body.$binary, {
    bytes: 11,
    contentType: 'image/png',
    why: 'not decodable as UTF-8',
  });
  assert.ok(result.warnings.some((w) => w.includes('not UTF-8')));
});

// ---------------------------------------------------------------------------
// 3. Pathological: a response larger than the cap
// ---------------------------------------------------------------------------

test('over-cap body aborts the run and writes NOTHING', async () => {
  const { record } = await loadRecorder();
  const target = out('too-big');
  const huge = 'x'.repeat(200_000);
  await assert.rejects(
    record({
      scenario: 'myself',
      out: target,
      env: ENV,
      clock: CLOCK,
      maxBodyBytes: 4096,
      fetchImpl: fakeFetch(() => json(200, { blob: huge })),
    }),
    /exceeded --max-body-bytes/,
  );
  await assert.rejects(stat(target), /ENOENT/, 'a partial fixture was written');
});

// ---------------------------------------------------------------------------
// 4. Fail-loud: something credential-shaped the redactor cannot classify
// ---------------------------------------------------------------------------

test('unknown high-entropy value fails with the field path, writes nothing', async () => {
  const { record } = await loadRecorder();
  const target = out('opaque');
  await assert.rejects(
    record({
      scenario: 'myself',
      out: target,
      env: ENV,
      clock: CLOCK,
      fetchImpl: fakeFetch(() =>
        json(200, {
          ...user(ACCOUNT_A, REAL_EMAIL, NAME_A),
          sessionBlob: OPAQUE_BLOB,
        }),
      ),
    }),
    (error: Error) => {
      assert.match(error.message, /Redaction is incomplete — NOTHING was written/);
      assert.match(error.message, /\$\.exchanges\[0\]\.response\.body\.sessionBlob/);
      assert.match(error.message, /could not be classified/);
      return true;
    },
  );
  await assert.rejects(stat(target), /ENOENT/, 'a half-redacted fixture was written');
});

test('--allow-opaque-key is the deliberate escape hatch', async () => {
  const { record } = await loadRecorder();
  const target = out('opaque-allowed');
  await record({
    scenario: 'myself',
    out: target,
    env: ENV,
    clock: CLOCK,
    allowOpaqueKeys: ['sessionBlob'],
    fetchImpl: fakeFetch(() =>
      json(200, {
        ...user(ACCOUNT_A, REAL_EMAIL, NAME_A),
        sessionBlob: OPAQUE_BLOB,
      }),
    ),
  });
  const doc = await readDocument(target);
  const body = responseOf(doc).body as { sessionBlob?: unknown };
  assert.equal(body.sessionBlob, OPAQUE_BLOB);
});

// ---------------------------------------------------------------------------
// 5. Error scenarios still record the exchange
// ---------------------------------------------------------------------------

test('a 404 is recorded and its body redacted', async () => {
  const { record } = await loadRecorder();
  const target = out('error-404');
  await record({
    scenario: 'error-404',
    out: target,
    env: ENV,
    clock: CLOCK,
    fetchImpl: fakeFetch(() =>
      json(404, {
        errorMessages: [
          `Issue does not exist or ${REAL_EMAIL} has no permission to see it.`,
        ],
        errors: {},
      }),
    ),
  });
  const doc = await readDocument(target);
  const response = responseOf(doc);
  assert.equal(response.status, 404);
  const body = response.body as { errorMessages?: readonly string[] };
  assert.match(
    required(body.errorMessages?.[0], 'errorMessages[0]'),
    /user-1@example\.invalid/,
  );
});

test('an error scenario that SUCCEEDS is a failure, not a fixture', async () => {
  const { record } = await loadRecorder();
  const target = out('error-404-but-ok');
  await assert.rejects(
    record({
      scenario: 'error-404',
      out: target,
      env: ENV,
      clock: CLOCK,
      fetchImpl: fakeFetch(() => json(200, { id: '1', key: 'ZZZ-1', fields: {} })),
    }),
    /ACCEPTED the request that was supposed to fail/,
  );
  await assert.rejects(stat(target), /ENOENT/);
});

// ---------------------------------------------------------------------------
// 6. Usage guards
// ---------------------------------------------------------------------------

test('an unknown scenario is a usage error', async () => {
  const { record } = await loadRecorder();
  await assert.rejects(
    record({ scenario: 'nope', out: out('nope'), env: ENV, clock: CLOCK }),
    /Unknown scenario/,
  );
});

test('a scenario refuses to run without its required input', async () => {
  const { record } = await loadRecorder();
  await assert.rejects(
    record({ scenario: 'issue-detail', out: out('x'), env: ENV, clock: CLOCK }),
    /needs --issue/,
  );
});

test('--out must name a .json file', async () => {
  const { record } = await loadRecorder();
  await assert.rejects(
    record({ scenario: 'myself', out: join(DIR, 'nope.txt'), env: ENV, clock: CLOCK }),
    /must name a \.json file/,
  );
});

test('missing credentials fail before any request is made', async () => {
  const { record } = await loadRecorder();
  let called = false;
  await assert.rejects(
    record({
      scenario: 'myself',
      out: out('nocreds'),
      env: { JIRA_SITE: SITE, JIRA_LOG_LEVEL: 'error' },
      clock: CLOCK,
      fetchImpl: () => {
        called = true;
        throw new Error('should not be reached');
      },
    }),
  );
  assert.equal(called, false, 'a request was made without credentials');
});

test('--force is the only way to replace a fixture', async () => {
  const { record } = await loadRecorder();
  const target = out('forced');
  await writeFile(target, '{"stale":true}\n', { mode: 0o600 });
  await record({
    scenario: 'myself',
    out: target,
    env: ENV,
    clock: CLOCK,
    force: true,
    fetchImpl: fakeFetch(() => json(200, user(ACCOUNT_A, REAL_EMAIL, NAME_A))),
  });
  const doc = await readDocument(target);
  assert.equal(doc.scenario, 'myself');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});
