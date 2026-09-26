import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { parseEnv } from 'node:util';

import { createJiraError } from '../core/errors.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  createFakeRedactor,
  jiraErr,
  jiraOk,
  type FakeClock,
  type FakeJiraRequest,
  type FakeLogger,
  type FakeRedactor,
  type JiraStubResult,
} from '../core/fakes/index.js';
import type { EnvFileHost } from '../core/config.js';
import type { JiraHttpOptions } from '../core/http.js';
import {
  profileKey,
  TOKEN_STORE_VERSION,
  type StoredTokens,
  type TokenStore,
} from '../core/oauth.js';
import {
  createReadlinePrompt,
  doctorUsage,
  EXIT_CONFIG,
  EXIT_OK,
  EXIT_PROBE_FAILED,
  mergeEnvFile,
  nodeDoctorFs,
  run,
  SEARCH_PROBE_JQL,
  type DoctorFsHost,
  type DoctorOptions,
  type DoctorReport,
} from './doctor.js';

const TOKEN = 'super-secret-token-value';
const HOME = '/home/ops';
const CWD = '/work/checkout';
const XDG_ENV_PATH = `${HOME}/.config/jira-mcp-ai/.env`;
const START_MS = Date.parse('2026-08-09T12:00:00.000Z');
const MS_PER_DAY = 86400000;

function baseEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    JIRA_SITE: 'acme.atlassian.net',
    JIRA_EMAIL: 'ops@example.com',
    JIRA_API_TOKEN: TOKEN,
    ...extra,
  };
}

interface Rig {
  readonly options: DoctorOptions;
  readonly jira: FakeJiraRequest;
  readonly logger: FakeLogger;
  readonly clock: FakeClock;
  readonly redactor: FakeRedactor;
  stdout(): string;
  stderr(): string;
  /** What `--save` wrote, if anything. */
  readonly written: { path?: string; contents?: string };
}

interface RigOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Path → permission bits, as `statFile` would report them. */
  readonly files?: Readonly<Record<string, number>>;
  /** Path → contents, for `--save` merging. */
  readonly texts?: Readonly<Record<string, string>>;
  /** Make the journal append probe fail. */
  readonly appendError?: Error;
  /** What the env lock reports through `writeSecret`'s `onWarning`. */
  readonly saveWarning?: string;
  /** Make `--save`'s write fail. */
  readonly writeError?: Error;
  readonly extra?: Partial<DoctorOptions>;
}

function rig(setup: RigOptions = {}): Rig {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const clock = createFakeClock(START_MS);
  const logger = createFakeLogger({ clock });
  // Seeded with NOTHING on purpose: the secrets must be registered by doctor
  // itself, from the settings it just loaded.
  const redactor = createFakeRedactor();
  const jira = createFakeJiraRequest();
  const written: { path?: string; contents?: string } = {};

  const files = setup.files ?? {};
  const texts = setup.texts ?? {};

  const envFileHost: EnvFileHost = {
    statFile: (path) => files[path],
    loadFile: () => {
      throw new Error('the tests never load a real env file');
    },
  };

  const fs: DoctorFsHost = {
    readText: (path) => texts[path],
    touchAppend: () => {
      if (setup.appendError !== undefined) throw setup.appendError;
    },
    writeSecret: (path, render, options) => {
      // The real seam warns here when it breaks a stale lock; doctor must put
      // that on stderr, not into the report.
      if (setup.saveWarning !== undefined) options.onWarning?.(setup.saveWarning);
      if (setup.writeError !== undefined) return Promise.reject(setup.writeError);
      written.path = path;
      written.contents = render(texts[path]);
      return Promise.resolve();
    },
  };

  const options: DoctorOptions = {
    env: setup.env ?? baseEnv(),
    homeDir: HOME,
    cwd: CWD,
    platform: 'linux',
    envFileHost,
    clock,
    logger,
    redactor,
    fs,
    stdout: (text) => outChunks.push(text),
    stderr: (text) => errChunks.push(text),
    isTTY: false,
    ...setup.extra,
  };

  return {
    options,
    jira,
    logger,
    clock,
    redactor,
    written,
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
  };
}

/** Program the four network probes with a healthy site. */
function healthy(jira: FakeJiraRequest): FakeJiraRequest {
  return jira
    .on(
      'GET /rest/api/3/myself',
      jiraOk({
        accountId: '5b10a2844c20165700ede21g',
        displayName: 'Ops Bot',
        timeZone: 'Europe/Sofia',
      }),
    )
    .on(
      'GET /rest/api/3/serverInfo',
      jiraOk({ deploymentType: 'Cloud', version: '1001.0.0-SNAPSHOT' }),
    )
    .on('POST /rest/api/3/search/jql', jiraOk({ issues: [{ key: 'ABC-1' }] }))
    .on('GET /rest/agile/1.0/board', jiraOk({ values: [{ id: 1 }], total: 1 }));
}

/**
 * A healthy site with one route answering differently. The override is
 * registered BEFORE `healthy`, because the fake tries its rules in insertion
 * order and `healthy` already claims all four routes.
 */
function healthyExcept(
  jira: FakeJiraRequest,
  route: string,
  result: JiraStubResult,
): FakeJiraRequest {
  return healthy(jira.on(route, result));
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test('unknown option is a usage error on stderr, exit 2', async () => {
  const r = rig();
  const code = await run({ ...r.options, argv: ['--verbose'] });

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /Unknown option "--verbose"/);
  assert.match(r.stderr(), /Usage: jira-mcp-ai doctor/);
  assert.equal(r.stdout(), '', 'a usage error must not pollute the report stream');
});

test('--help prints usage on stdout and exits 0', async () => {
  const r = rig();
  const code = await run({ ...r.options, argv: ['--help'] });

  assert.equal(code, EXIT_OK);
  assert.equal(r.stdout(), doctorUsage());
  assert.equal(r.jira.calls.length, 0);
});

test('-h is the same door as --help', async () => {
  const r = rig();
  const code = await run({ ...r.options, argv: ['-h'] });

  assert.equal(code, EXIT_OK);
  assert.equal(r.stdout(), doctorUsage());
});

test('a positional argument is a usage error that names it, exit 2', async () => {
  const r = rig();
  // The mistake this catches: `doctor mysite.atlassian.net`, i.e. someone who
  // expects the site as an argument rather than as JIRA_SITE.
  const code = await run({ ...r.options, argv: ['mysite.atlassian.net'] });

  assert.equal(code, EXIT_CONFIG);
  assert.match(
    r.stderr(),
    /Unexpected argument "mysite\.atlassian\.net"; doctor takes options only\./,
  );
  assert.match(r.stderr(), /Usage: jira-mcp-ai doctor/);
  assert.equal(r.stdout(), '');
});

test('CC-79: omitting argv means no options, not a second read of process.argv', async () => {
  const r = rig();
  assert.equal(r.options.argv, undefined, 'the rig deliberately leaves argv unset');
  // `process.argv` here is the test runner's, and the earlier default
  // (`process.argv.slice(2)`) turned that into "Unexpected argument". The bin
  // dispatcher has already stripped the subcommand, so "nothing" is the only
  // honest default.
  const code = await run({ ...r.options, jiraRequest: healthy(r.jira).fn });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.doesNotMatch(r.stderr(), /Unexpected argument/);
  assert.match(out, /11 probes: /);
});

test('with nothing injected the report goes to the real stdout and usage to the real stderr', async () => {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  // Bound to their own streams: these are only ever put back where they came
  // from, but binding says so in the types instead of leaving a detached method.
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const sink =
    (chunks: string[]) =>
    (chunk: string | Uint8Array): boolean => {
      chunks.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    };

  let help: number;
  let bad: number;
  process.stdout.write = sink(outChunks);
  process.stderr.write = sink(errChunks);
  try {
    // Both paths return before any settings are read, so this run stays
    // hermetic despite injecting nothing at all.
    help = await run({ argv: ['--help'] });
    bad = await run({ argv: ['--nope'] });
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  assert.equal(help, EXIT_OK);
  assert.equal(bad, EXIT_CONFIG);
  assert.equal(outChunks.join(''), doctorUsage(), 'D11: the report stream is stdout');
  assert.match(errChunks.join(''), /Unknown option "--nope"/);
  assert.equal(
    errChunks.join('').includes('Usage: jira-mcp-ai doctor'),
    true,
    'the usage text accompanies the error on the same stream',
  );
});

test('--save with --json is rejected before anything runs', async () => {
  const r = rig();
  const code = await run({ ...r.options, argv: ['--save', '--json'] });

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /--save prompts for input/);
});

// ---------------------------------------------------------------------------
// The probe matrix
// ---------------------------------------------------------------------------

test('a healthy site passes every probe: exit 0', async () => {
  const r = rig();
  const code = await run({
    ...r.options,
    argv: [],
    jiraRequest: healthy(r.jira).fn,
  });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[ ok \] identity: Ops Bot \(accountId 5b10a2844c20165700ede21g\)/);
  assert.match(out, /\[ ok \] deployment: Jira Cloud \(version 1001\.0\.0-SNAPSHOT\)/);
  assert.match(out, /\[ ok \] search: search\/jql returned 1 issue/);
  assert.match(out, /\[ ok \] agile: 1 board visible/);
  assert.match(out, /11 probes: /);
  assert.deepEqual(r.jira.routes(), [
    'GET /rest/api/3/myself',
    'GET /rest/api/3/serverInfo',
    'POST /rest/api/3/search/jql',
    'GET /rest/agile/1.0/board',
  ]);
});

test('the search probe uses the new endpoint, one page, as a safe POST', async () => {
  const r = rig();
  await run({ ...r.options, argv: [], jiraRequest: healthy(r.jira).fn });

  const search = r.jira.calls.find((call) => call.path === '/search/jql');
  assert.ok(search, 'the search probe must run');
  assert.equal(search.method, 'POST');
  assert.equal(search.safe, true);
  assert.deepEqual(search.body, {
    jql: SEARCH_PROBE_JQL,
    maxResults: 1,
    fields: ['key'],
  });
});

test('the search probe carries a JQL restriction, which large sites require', () => {
  // Regression guard for D88. A fixture cannot reproduce this — the rejection
  // is a property of site size, and the fake accepts anything — so the test
  // that protects it asserts on the shape of the query instead: whatever the
  // probe sends, it must not be `ORDER BY` and nothing else.
  const withoutOrder = SEARCH_PROBE_JQL.replace(/\border\s+by\b.*$/i, '').trim();
  assert.notEqual(withoutOrder, '', 'the probe JQL is only an ORDER BY clause');
});

test('an auth failure fails the run: exit 1, the other probes still run', async () => {
  const r = rig();
  const denied = createJiraError({
    kind: 'auth',
    reason: 'Jira rejected the credentials (401).',
    httpStatus: 401,
  });
  healthy(r.jira);
  r.jira.enqueue(jiraErr(denied));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(out, /\[FAIL] identity: .*401.*\(kind auth\)/);
  // Exactly one probe failed; deployment/search/agile were still attempted.
  assert.equal(r.jira.calls.length, 4);
});

test('a refused connection fails every network probe: exit 1', async () => {
  const r = rig();
  const refused = new TypeError('fetch failed');
  r.jira.on(/./, jiraErr(refused));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(out, /\[FAIL] identity: .*fetch failed.*\(kind transport\)/);
  assert.match(out, /\[FAIL] deployment: /);
  assert.match(out, /\[FAIL] search: /);
  // Agile degrades to a warning: a site without Jira Software still works.
  assert.match(out, /\[warn] agile: /);
});

test('--offline runs the local probes only and touches no seam', async () => {
  const r = rig();
  const code = await run({
    ...r.options,
    argv: ['--offline'],
    jiraRequest: healthy(r.jira).fn,
  });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.equal(r.jira.calls.length, 0, 'offline means no request may be issued');
  assert.match(out, /offline: network probes skipped/);
  for (const probe of ['identity', 'deployment', 'search', 'agile']) {
    assert.match(out, new RegExp(`\\[skip] ${probe}: skipped \\(--offline\\)`));
  }
  assert.match(out, /\[ ok \] host: https:\/\/acme\.atlassian\.net/);
});

test('a broken configuration exits 2 and skips the network probes', async () => {
  const r = rig({ env: { JIRA_LOG_LEVEL: 'debug' } });
  const code = await run({ ...r.options, argv: [] });

  const out = r.stdout();
  assert.equal(code, EXIT_CONFIG, out);
  assert.match(out, /\[FAIL] settings: JIRA_EMAIL is not set/);
  assert.match(out, /\[FAIL] settings: JIRA_API_TOKEN is not set/);
  assert.match(out, /\[FAIL] host: JIRA_SITE/);
  assert.match(out, /\[skip] identity: skipped: no usable site or credentials/);
});

test('the http transport is a supported loopback bind, not a failure (D101)', async () => {
  const r = rig({
    env: baseEnv({ JIRA_TRANSPORT: 'http', JIRA_HTTP_TOKEN: 'loopback-token' }),
  });
  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[ ok \] gating: transport http \(loopback 127\.0\.0\.1:3334\)/);
  assert.doesNotMatch(out, /not available/);
});

test('an unwritable journal path fails the journal probe', async () => {
  const r = rig({
    env: baseEnv({ JIRA_JOURNAL_PATH: '/nope/writes.jsonl' }),
    appendError: new Error(
      "ENOENT: no such file or directory, open '/nope/writes.jsonl'",
    ),
  });
  const code = await run({ ...r.options, argv: ['--offline'] });

  assert.equal(code, EXIT_PROBE_FAILED);
  assert.match(r.stdout(), /\[FAIL] journal: cannot append to "\/nope\/writes\.jsonl"/);
});

test('a permissive env file is reported as a warning, not a failure', async () => {
  const r = rig({ files: { [XDG_ENV_PATH]: 0o644 } });
  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /\[ ok \] env file: found "\/home\/ops\/\.config\/jira-mcp-ai\/\.env" \(xdg/,
  );
  assert.match(out, /\[warn] env file: mode 0644 is readable beyond the owner/);
  assert.match(out, /→ chmod 600 \/home\/ops\/\.config\/jira-mcp-ai\/\.env/);
});

test('a host outside the canonical suffix says which setting let it through', async () => {
  const r = rig({
    env: baseEnv({
      JIRA_SITE: 'jira.internal.example.com',
      JIRA_ALLOWED_HOSTS: 'jira.internal.example.com',
    }),
  });
  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  // Naming the allowlist matters: an operator who does not remember setting it
  // is looking at a host they did not intend to reach.
  assert.match(
    out,
    /\[ ok \] host: https:\/\/jira\.internal\.example\.com — allowed by JIRA_ALLOWED_HOSTS \(1 entry\)/,
  );
});

test('a 0600 env file is stated as fact, not left to be inferred', async () => {
  const r = rig({ files: { [XDG_ENV_PATH]: 0o600 } });
  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[ ok \] env file: mode 0600\n/);
  assert.doesNotMatch(out, /readable beyond the owner/);
});

test('identity: a body without an accountId fails and blames the site, not the token', async () => {
  const r = rig();
  healthyExcept(r.jira, 'GET /rest/api/3/myself', jiraOk('<html>login</html>'));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(out, /\[FAIL] identity: \/myself answered without an accountId/);
  assert.match(out, /→ The site returned an unexpected body/);
});

test('identity: a nameless, timezone-less account still passes, with both said out loud', async () => {
  const r = rig();
  healthyExcept(r.jira, 'GET /rest/api/3/myself', jiraOk({ accountId: '1a2b' }));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  // A warning, not a failure: the server works; only worklog offsets suffer.
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[ ok \] identity: unnamed account \(accountId 1a2b\)/);
  assert.match(out, /\[warn] identity: the account has no timezone/);
});

test('deployment: a serverInfo body with neither field warns without a version suffix', async () => {
  const r = rig();
  healthyExcept(r.jira, 'GET /rest/api/3/serverInfo', jiraOk({}));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[warn] deployment: \/serverInfo reported no deploymentType\n/);
});

test('deployment: Server is a warning that names D2, not a failure', async () => {
  const r = rig();
  healthyExcept(
    r.jira,
    'GET /rest/api/3/serverInfo',
    jiraOk({ deploymentType: 'Server', version: '9.4.0' }),
  );

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  // Exit 0 on purpose: the probes that matter all answered. The operator is
  // told the product is unsupported, and decides.
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /\[warn] deployment: deployment type is Server, not Cloud \(version 9\.4\.0\)/,
  );
  assert.match(out, /→ v1 targets Jira Cloud only \(D2\)/);
});

test('search: a body without an issues array fails and points at D6', async () => {
  const r = rig();
  healthyExcept(r.jira, 'POST /rest/api/3/search/jql', jiraOk({ total: 0 }));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(out, /\[FAIL] search: search\/jql answered without an issues array/);
  assert.match(out, /→ Only \/rest\/api\/3\/search\/jql is supported \(D6\)/);
});

test('search: a nextPageToken is reported as more pages, not as a bigger count', async () => {
  const r = rig();
  healthyExcept(
    r.jira,
    'POST /rest/api/3/search/jql',
    jiraOk({ issues: [{ key: 'ABC-1' }, { key: 'ABC-2' }], nextPageToken: 'eyJ0IjoxfQ' }),
  );

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /\[ ok \] search: search\/jql returned 2 issues \(more pages available\)/,
  );
});

test('agile: an unrecognisable board body is a warning, because agile is optional', async () => {
  const r = rig();
  healthyExcept(r.jira, 'GET /rest/agile/1.0/board', jiraOk({ total: 0 }));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /\[warn] agile: \/rest\/agile\/1\.0\/board answered without a values array/,
  );
});

test('agile: an empty body is warned about, not dereferenced', async () => {
  const r = rig();
  // What a 204 or a proxy that swallowed the body looks like by the time it
  // reaches a probe: `data` is null, and `typeof null === "object"`.
  healthyExcept(r.jira, 'GET /rest/agile/1.0/board', jiraOk(null));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /\[warn] agile: \/rest\/agile\/1\.0\/board answered without a values array/,
  );
});

test('agile: zero boards is information plus the consequence for the agile tools', async () => {
  const r = rig();
  healthyExcept(r.jira, 'GET /rest/agile/1.0/board', jiraOk({ values: [], total: 0 }));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[info] agile: 0 boards visible on the first page/);
  assert.match(out, /→ The agile tools will find nothing until this account/);
});

test('journal: a world-readable journal warns and prints the exact chmod', async () => {
  const path = '/var/lib/jira/writes.jsonl';
  const r = rig({
    env: baseEnv({ JIRA_JOURNAL_PATH: path }),
    files: { [path]: 0o644 },
  });
  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // The journal records what was written to Jira and by whom; 0644 leaks that
  // to every account on the box.
  assert.equal(code, EXIT_OK, out);
  assert.match(out, new RegExp(`\\[ ok \\] journal: appendable: "${path}"`));
  assert.match(out, /\[warn] journal: mode 0644 is readable beyond the owner/);
  assert.match(out, new RegExp(`→ chmod 600 ${path}`));
});

test('a near-expiry token warns on stdout and emits the log event with cid "-"', async () => {
  const expires = new Date(START_MS + 9 * MS_PER_DAY).toISOString();
  const r = rig({ env: baseEnv({ JIRA_TOKEN_EXPIRES: expires }) });

  const code = await run({ ...r.options, argv: ['--offline'] });

  assert.equal(code, EXIT_OK);
  assert.match(r.stdout(), /\[warn] token expiry: The API token expires in 9 day\(s\)/);
  const events = r.logger.eventsOf('token_expiry_warning');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.cid, '-');
  assert.deepEqual(events[0]?.fields, { daysLeft: 9 });
  assert.equal(r.logger.eventsOf('settings_report')[0]?.cid, '-');
});

test('a healthy far-off expiry is reported as ok', async () => {
  const expires = new Date(START_MS + 200 * MS_PER_DAY).toISOString();
  const r = rig({ env: baseEnv({ JIRA_TOKEN_EXPIRES: expires }) });

  const code = await run({ ...r.options, argv: ['--offline'] });

  assert.equal(code, EXIT_OK);
  assert.match(r.stdout(), /\[ ok \] token expiry: the API token expires in 200 days/);
  assert.equal(r.logger.has('token_expiry_warning'), false);
});

test('an unparseable JIRA_TOKEN_EXPIRES is a config error, exit 2, with an example date', async () => {
  const r = rig({ env: baseEnv({ JIRA_TOKEN_EXPIRES: 'next tuesday' }) });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // Exit 2, not 1: doctor could not check the thing it was asked to check, and
  // the probe prints ONLY the parse failure — no "expires in NaN days" line.
  assert.equal(code, EXIT_CONFIG, out);
  assert.match(out, /\[FAIL] token expiry: JIRA_TOKEN_EXPIRES "next tuesday" is not an/);
  assert.match(out, /e\.g\. 2027-01-31/);
  assert.doesNotMatch(out, /token expiry: the API token expires/);
  assert.equal(r.logger.has('token_expiry_warning'), false);
});

test('gating: apply mode, deny and read-only lists and an unlocked profile are all surfaced', async () => {
  const r = rig({
    env: baseEnv({
      JIRA_WRITE_MODE: 'apply',
      JIRA_PACKAGES_DENY: 'agile',
      JIRA_PACKAGES_READONLY: 'issues',
      JIRA_ACTIVE_PROFILE: 'work',
      JIRA_PROFILE_WORK_SITE: 'acme.atlassian.net',
      JIRA_PROFILE_WORK_EMAIL: 'ops@example.com',
      JIRA_PROFILE_WORK_API_TOKEN: 'work-profile-token-value',
      JIRA_LOCK_PROFILE: 'false',
    }),
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // Every one of these loosens a safety default, so every one is a warn or an
  // info line — the run still exits 0, because the operator chose them.
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[warn] gating: write mode is apply: write tools execute/);
  assert.match(out, /→ Set JIRA_WRITE_MODE=plan/);
  assert.match(out, /\[info] gating: packages .*, denied agile, read-only issues/);
  assert.match(out, /\[info] gating: active profile "work"\n/);
  assert.match(out, /\[warn] gating: JIRA_LOCK_PROFILE is off/);
});

test('CC-88: gating fails on a package selection the server would refuse to start on', async () => {
  // `assertStartupOk`'s remediation promises that doctor "prints the same report
  // without starting the server". The gating triple is the one place that was
  // untrue: `core/settings.ts` splits the three variables into token lists but
  // never looks the tokens up — the vocabulary lives in `mcp/registry.ts` and the
  // server only meets it while building the tool surface. Doctor printed the raw
  // tokens as an `info` line and exited 0; the server then died with exit 2.
  //
  // The plugin install path makes this reachable without a typo: an unexpanded
  // `${user_config.jira_tool_packages}` is exactly such a token.
  for (const [variable, value] of [
    ['JIRA_TOOL_PACKAGES', 'bogus'],
    ['JIRA_TOOL_PACKAGES', '${user_config.jira_tool_packages}'],
    ['JIRA_PACKAGES_DENY', 'core,nosuch'],
    ['JIRA_PACKAGES_READONLY', 'issue'],
  ] as const) {
    const r = rig({ env: baseEnv({ [variable]: value }) });
    const code = await run({ ...r.options, argv: ['--offline'] });

    const out = r.stdout();
    assert.equal(
      code,
      EXIT_PROBE_FAILED,
      `${variable}=${value} was reported green:\n${out}`,
    );
    // The token is named, and so is the vocabulary that would have accepted it —
    // the same two sentences `expandSelection` throws at the server.
    assert.match(out, new RegExp(`\\[FAIL] gating: ${variable} names `));
    assert.ok(out.includes(`which is not a known package or profile`), out);
    assert.match(
      out,
      /→ Use a profile \(core, reader, all\) or a comma list of packages/,
    );
  }
});

test('CC-88: a valid selection, profile or explicit list, stays green', async () => {
  // The guard above must not turn a legitimate configuration red: profiles and
  // package ids share one namespace, an empty token is skipped, and case and
  // surrounding space are normalised — all of that is `expandSelection`'s
  // behaviour, and doctor inherits it by calling it rather than restating it.
  for (const value of ['all', 'reader', 'core', 'core, search ,', 'CORE,Issues']) {
    const r = rig({ env: baseEnv({ JIRA_TOOL_PACKAGES: value }) });
    const code = await run({ ...r.options, argv: ['--offline'] });

    const out = r.stdout();
    assert.equal(code, EXIT_OK, `JIRA_TOOL_PACKAGES=${value} was reported red:\n${out}`);
    assert.doesNotMatch(out, /not a known package or profile/);
  }
});

test('D84: a variable still holding a client placeholder fails instead of loading', async () => {
  // The free-text variables have no vocabulary to check a value against, so an
  // unsubstituted `${user_config.…}` loaded clean and doctor went green:
  // JIRA_MEDIA_DIR became a real (relative) attachment sandbox named after the
  // placeholder, and offline there is nothing to reject a placeholder token or
  // address either. Each of these was exit 0 before this guard.
  for (const [variable, value, echoed] of [
    ['JIRA_MEDIA_DIR', '${user_config.jira_media_dir}', true],
    ['JIRA_JOURNAL_PATH', '${user_config.jira_journal_path}', true],
    // A secret keeps its redaction even when its value is plainly a
    // placeholder: the guard hands the text to the same writer as everything
    // else, so the redactor decides what reaches the screen.
    ['JIRA_API_TOKEN', '${input:jira_api_token}', false],
  ] as const) {
    const r = rig({ env: baseEnv({ [variable]: value }) });
    const code = await run({ ...r.options, argv: ['--offline'] });

    const out = r.stdout();
    assert.equal(
      code,
      EXIT_PROBE_FAILED,
      `${variable}=${value} was reported green:\n${out}`,
    );
    // The variable is named, the literal text is quoted back so the operator
    // recognises it in the config file, and the next action is spelled out.
    assert.match(
      out,
      new RegExp(`\\[FAIL] settings: ${variable} still holds the literal placeholder `),
    );
    assert.equal(out.includes(value), echoed, out);
    assert.ok(out.includes(`Give ${variable} a real value`), out);
  }
});

test('D84: the placeholder guard adds no second line where a variable checks itself', async () => {
  // A variable with a vocabulary or a format rejects the placeholder itself,
  // with the better message. One broken variable, one line.
  for (const [variable, value, existing] of [
    [
      'JIRA_WRITE_MODE',
      '${user_config.jira_write_mode}',
      /\[FAIL] settings: JIRA_WRITE_MODE must be one of plan \| apply/,
    ],
    [
      'JIRA_EMAIL',
      '${env:JIRA_EMAIL}',
      /\[FAIL] settings: JIRA_EMAIL ".*" is not an email address/,
    ],
  ] as const) {
    const r = rig({ env: baseEnv({ [variable]: value }) });

    await run({ ...r.options, argv: ['--offline'] });

    const out = r.stdout();
    assert.match(out, existing);
    assert.doesNotMatch(
      out,
      new RegExp(`${variable} still holds the literal placeholder`),
    );
  }
});

test('D84: a value that merely contains a dollar or braces stays green', async () => {
  // The guard must not fire on legitimate values: a token is opaque bytes, and
  // JIRA_ALLOWED_HOSTS takes anchored regexes, where `$` and `{` both occur.
  const r = rig({
    env: baseEnv({
      JIRA_API_TOKEN: 'ATATT$3xample{token}value',
      JIRA_ALLOWED_HOSTS: '/^jira-[0-9]{2}\\.example\\.com$/',
    }),
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.doesNotMatch(out, /literal placeholder/);
});

test('gating: a locked profile is stated as locked', async () => {
  const r = rig({
    env: baseEnv({
      JIRA_ACTIVE_PROFILE: 'work',
      JIRA_PROFILE_WORK_SITE: 'acme.atlassian.net',
      JIRA_PROFILE_WORK_EMAIL: 'ops@example.com',
      JIRA_PROFILE_WORK_API_TOKEN: 'work-profile-token-value',
    }),
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  // Locked is the default (O-6), so the report says so and does not warn.
  assert.match(out, /\[info] gating: active profile "work" \(locked\)/);
  assert.doesNotMatch(out, /JIRA_LOCK_PROFILE is off/);
});

// ---------------------------------------------------------------------------
// The OAuth token store (probe 11, AUTH.md §Doctor)
//
// Every case here runs `--offline`. That is not a shortcut: probe 11 is a LOCAL
// probe by design, because "am I authorized at all" is the first question an
// operator without a network answer needs settled, and running these offline is
// the assertion that it stayed local.
// ---------------------------------------------------------------------------

const CLIENT_ID = 'a1B2c3D4e5F6g7H8i9J0';
const CLIENT_SECRET = 'oauth-client-secret-value';
const TOKEN_FILE = `${HOME}/.config/jira-mcp-ai/oauth.json`;
const CLOUD_ID = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const ACCESS_TOKEN = 'oauth-access-token-value';
const REFRESH_TOKEN = 'oauth-refresh-token-value';
const MS_PER_MINUTE = 60000;

function oauthEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    JIRA_SITE: 'acme.atlassian.net',
    JIRA_AUTH_MODE: 'oauth',
    JIRA_OAUTH_CLIENT_ID: CLIENT_ID,
    JIRA_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    JIRA_OAUTH_TOKEN_FILE: TOKEN_FILE,
    ...extra,
  };
}

function grant(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    cloudId: CLOUD_ID,
    site: 'https://acme.atlassian.net',
    clientId: CLIENT_ID,
    scopes: ['read:jira-work', 'offline_access'],
    refreshToken: REFRESH_TOKEN,
    accessToken: ACCESS_TOKEN,
    expiresAt: START_MS + 45 * MS_PER_MINUTE,
    obtainedAt: START_MS - MS_PER_MINUTE,
    ...overrides,
  };
}

interface FakeStore {
  readonly store: TokenStore;
  /** How many times doctor asked the store for an entry. */
  reads(): number;
}

/**
 * A token store doctor can only read.
 *
 * The write methods throw rather than record: doctor diagnoses, and a probe
 * that quietly rewrote the file an operator is trying to understand would be a
 * bug this fake should surface as a failure, not as a passing assertion.
 */
function fakeStore(
  entries: Readonly<Record<string, StoredTokens>> = {},
  setup: { readonly path?: string; readonly error?: Error } = {},
): FakeStore {
  let reads = 0;
  const readOnly = (): never => {
    throw new Error('doctor must never write to the OAuth token store');
  };
  const store: TokenStore = {
    path: setup.path ?? TOKEN_FILE,
    read: () => Promise.resolve({ version: TOKEN_STORE_VERSION, tokens: entries }),
    get: (profile?: string) => {
      reads += 1;
      if (setup.error !== undefined) return Promise.reject(setup.error);
      return Promise.resolve(entries[profileKey(profile)]);
    },
    put: readOnly,
    remove: readOnly,
    update: readOnly,
  };
  return { store, reads: () => reads };
}

test('basic mode names the mode instead of reporting on a store nothing reads', async () => {
  const store = fakeStore({ default: grant() });
  const r = rig({ extra: { tokenStore: store.store } });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[info] oauth token store: auth mode is basic; the OAuth token/);
  // The symptom of a half-configured OAuth app is a green basic-auth report, so
  // the mode is stated — but the store itself is not even opened.
  assert.equal(store.reads(), 0, 'basic mode must not read the store');
});

test('a stored grant is described by site, cloudId, scopes and horizon — never by token', async () => {
  const store = fakeStore({ default: grant() });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    new RegExp(
      `\\[ ok \\] oauth token store: auth mode is oauth, client id "${CLIENT_ID}"`,
    ),
  );
  assert.match(
    out,
    new RegExp(`\\[ ok \\] oauth token store: store "${TOKEN_FILE}" \\(mode 0600\\)`),
  );
  assert.match(
    out,
    new RegExp(
      `\\[ ok \\] oauth token store: a grant for https://acme\\.atlassian\\.net \\(cloudId ${CLOUD_ID}\\) is stored under profile "default"`,
    ),
  );
  assert.match(out, /granted scopes read:jira-work offline_access/);
  assert.match(out, /\[ ok \] oauth token store: a refresh token is stored/);
  assert.match(
    out,
    /\[ ok \] oauth token store: the OAuth access token expires in 45 minutes/,
  );
  // The whole point of the probe's wording (CC-103): a stored grant says which
  // sites the authorization covers, never what the account may do on them.
  assert.doesNotMatch(out, /oauth token store: [^\n]*permission/);
  assert.equal(out.includes(ACCESS_TOKEN), false, 'no access token may reach stdout');
  assert.equal(out.includes(REFRESH_TOKEN), false, 'no refresh token may reach stdout');
  assert.equal(out.includes(CLIENT_SECRET), false);
});

test('the OAuth horizon grows its unit with the time left, never rounding it away', async () => {
  const cases: readonly (readonly [number, string])[] = [
    [89, '89 minutes'],
    [90, '1 hour'],
    [5 * 60, '5 hours'],
    [47 * 60, '47 hours'],
    [3 * 24 * 60, '3 days'],
  ];
  for (const [minutes, expected] of cases) {
    const store = fakeStore({
      default: grant({ expiresAt: START_MS + minutes * MS_PER_MINUTE }),
    });
    const r = rig({
      env: oauthEnv(),
      files: { [TOKEN_FILE]: 0o600 },
      extra: { tokenStore: store.store },
    });

    const code = await run({ ...r.options, argv: ['--offline'] });

    const out = r.stdout();
    assert.equal(code, EXIT_OK, out);
    assert.match(
      out,
      new RegExp(`oauth token store: the OAuth access token expires in ${expected}\\n`),
    );
  }
});

test('a grant that recorded no scopes says so instead of printing an empty list', async () => {
  const store = fakeStore({ default: grant({ scopes: [] }) });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, /\[info] oauth token store: the grant recorded no scopes/);
  assert.doesNotMatch(out, /granted scopes/);
});

test('on Windows the store mode is neither judged nor printed', async () => {
  // POSIX bits mean nothing on NTFS: a 0644 that would warn on Linux is
  // reported as a plain "store <path>" with no mode at all.
  const store = fakeStore({ default: grant() });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o644 },
    extra: { tokenStore: store.store, platform: 'win32' },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(out, new RegExp(`\\[ ok \\] oauth token store: store "${TOKEN_FILE}"\\n`));
  assert.doesNotMatch(out, /readable beyond the owner|mode 0644/);
});

test('without an injected store, doctor reads the file JIRA_OAUTH_TOKEN_FILE names', async () => {
  const dir = tempDir();
  try {
    const tokenFile = join(dir, 'oauth.json');
    writeFileSync(
      tokenFile,
      JSON.stringify({ version: TOKEN_STORE_VERSION, tokens: { default: grant() } }),
      { mode: 0o600 },
    );
    const r = rig({
      env: oauthEnv({ JIRA_OAUTH_TOKEN_FILE: tokenFile }),
      files: { [tokenFile]: 0o600 },
    });

    const code = await run({ ...r.options, argv: ['--offline'] });

    const out = r.stdout();
    assert.equal(code, EXIT_OK, out);
    assert.match(
      out,
      new RegExp(
        `oauth token store: a grant for https://acme\\.atlassian\\.net \\(cloudId ${CLOUD_ID}\\) is stored under profile "default"`,
      ),
    );
    assert.equal(out.includes(ACCESS_TOKEN), false, 'no access token may reach stdout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oauth mode with no store fails the probe and names the login command', async () => {
  const store = fakeStore();
  const r = rig({ env: oauthEnv(), extra: { tokenStore: store.store } });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // Exit 1, not 2: the configuration is complete, the authorization is missing —
  // and the remediation is a command, not a variable (CC-102).
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(
    out,
    new RegExp(`\\[info] oauth token store: no store file at "${TOKEN_FILE}" yet`),
  );
  assert.match(
    out,
    /\[FAIL] oauth token store: no authorization is stored for profile "default"/,
  );
  assert.match(out, /→ Run `jira-mcp-ai login` once/);
  assert.equal(store.reads(), 1, 'the store is read once per run, not once per probe');
});

test('the login hint carries the profile the missing grant belongs to', async () => {
  const store = fakeStore({ default: grant() });
  const r = rig({
    env: oauthEnv({
      JIRA_ACTIVE_PROFILE: 'work',
      JIRA_PROFILE_WORK_SITE: 'acme.atlassian.net',
    }),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // The default profile's grant is present and irrelevant: a per-profile store
  // is keyed by profile, so "logged in" is a question with one answer per key.
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(out, /no authorization is stored for profile "work"/);
  assert.match(out, /→ Run `jira-mcp-ai login --profile work` once/);
});

test('a store readable beyond its owner warns with the exact chmod', async () => {
  const store = fakeStore({ default: grant() });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o644 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // A refresh token is a long-lived credential; 0644 hands it to every account
  // on the box. Same shape as the journal and env-file warnings.
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    new RegExp(`\\[warn] oauth token store: store "${TOKEN_FILE}" has mode 0644`),
  );
  assert.match(out, new RegExp(`→ chmod 600 ${TOKEN_FILE}`));
});

test('a damaged store is reported as damaged, and the rest of the report survives', async () => {
  const damaged = createJiraError({
    kind: 'config',
    reason: `The OAuth token store ${TOKEN_FILE} has a damaged entry for profile "default": cloudId is missing or empty.`,
    remediation: 'Delete it and run `jira-mcp-ai login` again.',
  });
  const store = fakeStore({}, { error: damaged });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // Exit 1: the settings loaded cleanly, so this is a probe finding a broken
  // thing on disk, not doctor refusing the configuration it was handed.
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(
    out,
    /\[FAIL] oauth token store: The OAuth token store .* has a damaged entry/,
  );
  // "The file is broken" and "you are not logged in" are different problems, so
  // the missing-grant line must NOT also appear.
  assert.doesNotMatch(out, /no authorization is stored/);
  assert.match(out, /11 probes: /, 'the other probes still ran');
});

test('a grant belonging to another OAuth client is called out before it 401s', async () => {
  const store = fakeStore({ default: grant({ clientId: 'an-older-client-id' }) });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // Rotating the app is exactly how this happens, and the refresh failure it
  // produces upstream reads as "unknown client", which names nothing local.
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(
    out,
    /\[FAIL] oauth token store: the stored grant belongs to a different OAuth client/,
  );
  assert.match(out, /→ Run `jira-mcp-ai login` once/);
});

test('oauth mode without a client id prints the cause before the consequence, exit 2', async () => {
  const store = fakeStore();
  const r = rig({
    env: {
      JIRA_SITE: 'acme.atlassian.net',
      JIRA_AUTH_MODE: 'oauth',
      JIRA_OAUTH_TOKEN_FILE: TOKEN_FILE,
    },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_CONFIG, out);
  const cause = out.indexOf('needs JIRA_OAUTH_CLIENT_ID');
  const consequence = out.indexOf('auth mode is oauth, but no client id is configured');
  assert.notEqual(cause, -1, out);
  assert.notEqual(consequence, -1, out);
  assert.ok(cause < consequence, 'the missing variable is named before its effect');
  // The secret is missing too, and its finding belongs to the same heading
  // rather than to the settings probe.
  assert.match(out, /\[FAIL] oauth token store: .*needs JIRA_OAUTH_CLIENT_SECRET/s);
});

test('probe 9 reports the OAuth horizon in oauth mode, not the basic-auth variable', async () => {
  const store = fakeStore({
    default: grant({ expiresAt: START_MS + 30 * MS_PER_MINUTE }),
  });
  const r = rig({
    env: oauthEnv({
      JIRA_TOKEN_EXPIRES: new Date(START_MS + 9 * MS_PER_DAY).toISOString(),
    }),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /\[ ok \] token expiry: the OAuth access token expires in 30 minutes/,
  );
  // JIRA_TOKEN_EXPIRES describes a credential this mode never sends. Warning
  // about its nine remaining days would be advice about a different server.
  assert.doesNotMatch(out, /the API token expires/);
  assert.equal(r.logger.has('token_expiry_warning'), false);
  assert.match(out, /JIRA_TOKEN_EXPIRES describes the API token of basic auth/);
});

test('a stored grant with no access token yet is information, not a failure', async () => {
  const store = fakeStore({
    default: { ...grant(), accessToken: undefined, expiresAt: undefined },
  });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  // This is the normal state right after a refresh-token rotation was persisted:
  // the grant is good, the access token is simply not fetched yet.
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /only a refresh token is stored; the next call fetches an access token/,
  );
});

test('an expired access token is not a failure either — the refresh is automatic', async () => {
  const store = fakeStore({ default: grant({ expiresAt: START_MS - MS_PER_MINUTE }) });
  const r = rig({
    env: oauthEnv(),
    files: { [TOKEN_FILE]: 0o600 },
    extra: { tokenStore: store.store },
  });

  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_OK, out);
  assert.match(
    out,
    /the stored OAuth access token has expired; the next call refreshes it/,
  );
});

// ---------------------------------------------------------------------------
// Machine-readable output and redaction
// ---------------------------------------------------------------------------

test('--json emits one parseable report and nothing else', async () => {
  const r = rig();
  const code = await run({
    ...r.options,
    argv: ['--json'],
    jiraRequest: healthy(r.jira).fn,
  });

  assert.equal(code, EXIT_OK);
  const report = JSON.parse(r.stdout()) as DoctorReport;
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, EXIT_OK);
  assert.equal(report.offline, false);
  assert.equal(report.ts, START_MS);
  assert.equal(report.host, 'https://acme.atlassian.net');
  assert.equal(report.probes.length, 11);
  assert.deepEqual(
    report.probes.map((probe) => probe.id),
    [
      'settings',
      'host',
      'env-file',
      'identity',
      'deployment',
      'search',
      'agile',
      'journal',
      'token-expiry',
      'gating',
      'oauth',
    ],
  );
  const identity = report.probes.find((probe) => probe.id === 'identity');
  assert.equal(identity?.status, 'info');
  assert.match(identity?.findings[0]?.text ?? '', /accountId/);
  assert.equal(report.summary.fail, 0);
});

test('--json reports the failing probe and the exit code it produced', async () => {
  const r = rig();
  r.jira.on(/./, jiraErr(new TypeError('fetch failed')));

  const code = await run({ ...r.options, argv: ['--json'], jiraRequest: r.jira.fn });

  const report = JSON.parse(r.stdout()) as DoctorReport;
  assert.equal(code, EXIT_PROBE_FAILED);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, EXIT_PROBE_FAILED);
  assert.equal(report.probes.find((probe) => probe.id === 'search')?.status, 'fail');
});

test('the API token never reaches stdout, even inside an error message', async () => {
  const r = rig();
  // The nastiest realistic case: an upstream error that echoes the credential.
  r.jira.on(/./, jiraErr(new Error(`401 for Basic ops@example.com:${TOKEN}`)));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  assert.equal(code, EXIT_PROBE_FAILED);
  assert.equal(r.stdout().includes(TOKEN), false);
  assert.equal(r.stderr().includes(TOKEN), false);
  assert.match(r.stdout(), /\[REDACTED]/);
  assert.ok(r.redactor.secrets.includes(TOKEN), 'doctor must register the token itself');
});

test('CC-78: --json stays parseable when a secret also occurs inside JSON syntax', async () => {
  // A one-character token is a placeholder someone pasted, and it matches the
  // "t" in `true`. Redacting the SERIALIZED text produced `"ok": [REDACTED]rue`
  // — a report no `jq` and no CI step could read.
  const r = rig({ env: baseEnv({ JIRA_API_TOKEN: 't' }) });

  const code = await run({ ...r.options, argv: ['--json', '--offline'] });

  const text = r.stdout();
  const report = JSON.parse(text) as DoctorReport;
  assert.equal(code, EXIT_OK, text);
  assert.equal(report.ok, true, 'booleans survive redaction');
  assert.equal(report.exitCode, EXIT_OK);
  assert.equal(report.probes.length, 11);
  // The document is valid and unreadable, which is the honest outcome: every
  // string carrying the needle is blanked, ids included, so the probe can only
  // be found by position. The collision itself is reported — as a warning on
  // the settings probe, because nothing is UNDER-redacted.
  const settings = report.probes[0];
  assert.equal(settings?.status, 'warn');
  assert.match(settings?.id ?? '', /\[REDACTED]/, 'the tree itself was redacted');
});

test('a finding whose remediation is empty renders no dangling arrow', async () => {
  const r = rig();
  // `isJiraError` accepts any Error carrying `kind` and `retryable`, so an
  // injected client can hand doctor a remediation of "". The renderer must
  // treat that as "no next action" rather than printing a bare "→".
  const bare = Object.assign(new Error('the site said no'), {
    kind: 'auth',
    retryable: false,
    remediation: '',
  });
  r.jira.on(/./, jiraErr(bare));

  const code = await run({ ...r.options, argv: [], jiraRequest: r.jira.fn });

  const out = r.stdout();
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(out, /\[FAIL] identity: the site said no \(kind auth\)/);
  // An arrow with nothing after it, on any line.
  assert.doesNotMatch(out, /→[ \t]*\n/);
});

test('the --json report is redacted too', async () => {
  const r = rig({ env: baseEnv({ JIRA_JOURNAL_PATH: `/tmp/${TOKEN}.jsonl` }) });

  await run({ ...r.options, argv: ['--json', '--offline'] });

  assert.equal(r.stdout().includes(TOKEN), false);
  const report = JSON.parse(r.stdout()) as DoctorReport;
  assert.equal(report.probes.length, 11);
});

// ---------------------------------------------------------------------------
// Counters (D12, OBSERVABILITY.md §Counters)
// ---------------------------------------------------------------------------

test('the report counts what the probes cost on the wire', async () => {
  const r = rig();
  let captured: JiraHttpOptions | undefined;
  const jira = healthy(r.jira);

  const code = await run({
    ...r.options,
    argv: ['--json'],
    // The factory seam receives the telemetry doctor built; counting one
    // request per call is what `core/http.ts` does for real.
    createRequest: (options) => {
      captured = options;
      return async (spec) => {
        options.telemetry?.recordRequest();
        return await jira.fn(spec);
      };
    },
  });

  assert.equal(code, EXIT_OK);
  assert.notEqual(captured?.telemetry, undefined, 'doctor must inject a telemetry');
  const report = JSON.parse(r.stdout()) as DoctorReport;
  assert.equal(report.counters?.requests, r.jira.calls.length);
  assert.equal(report.counters?.retries, 0);
  assert.deepEqual(report.counters?.errors, {});
});

test('without an injected request, doctor builds the real one on the loaded settings', async () => {
  // Nothing is injected, so the probes travel on `createJiraRequest` itself,
  // which reads `fetch` off `globalThis` at call time. The test owns that fetch
  // rather than leaning on the network fence: the fence is lifted under
  // JIRA_LIVE_TEST=1, and this test must never send a request anywhere. The
  // transport error the real layer raises names the host it was built on, and
  // that is the proof. Retries are off because the fake clock never advances on
  // its own, and a retry backoff would wait on it forever.
  const r = rig({ env: baseEnv({ JIRA_RETRY_ATTEMPTS: '0' }) });
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Promise.reject(new TypeError('fetch failed'));
  };

  let code: number;
  try {
    code = await run({ ...r.options, argv: ['--json'] });
  } finally {
    globalThis.fetch = previous;
  }

  assert.equal(code, EXIT_PROBE_FAILED, r.stdout());
  assert.ok(
    urls.includes('https://acme.atlassian.net/rest/api/3/myself'),
    JSON.stringify(urls),
  );
  const report = JSON.parse(r.stdout()) as DoctorReport;
  const identity = report.probes.find((probe) => probe.id === 'identity');
  assert.equal(identity?.status, 'fail');
  assert.match(
    identity?.findings.map((finding) => finding.text).join('\n') ?? '',
    /Could not reach Jira at https:\/\/acme\.atlassian\.net for GET \/rest\/api\/3\/myself/,
  );
  // The counters come from the real `core/http.ts`, so they are reported.
  assert.ok((report.counters?.requests ?? 0) >= 1, JSON.stringify(report.counters));
});

test('an injected request function leaves the counters out rather than reporting zeros', async () => {
  const r = rig();

  await run({ ...r.options, argv: ['--json'], jiraRequest: healthy(r.jira).fn });

  const report = JSON.parse(r.stdout()) as DoctorReport;
  assert.ok(r.jira.calls.length > 0, 'the probes did issue requests');
  assert.equal(report.counters, undefined);
});

test('an offline run reports zeros, because no request is an honest zero', async () => {
  const r = rig();

  await run({ ...r.options, argv: ['--json', '--offline'] });

  const report = JSON.parse(r.stdout()) as DoctorReport;
  assert.deepEqual(report.counters, {
    requests: 0,
    retries: 0,
    rateLimitWaits: 0,
    errors: {},
  });
});

test('the human summary renders the counters, retries and error kinds included', async () => {
  const r = rig();
  const jira = healthy(r.jira);

  await run({
    ...r.options,
    argv: [],
    createRequest: (options) => async (spec) => {
      options.telemetry?.recordRequest();
      options.telemetry?.recordRetry();
      options.telemetry?.recordRateLimitWait();
      options.telemetry?.recordError('rate_limited');
      return await jira.fn(spec);
    },
  });

  const out = r.stdout();
  assert.match(out, /HTTP: \d+ requests, \d+ retries, \d+ rate-limit waits, /);
  assert.match(out, /\d+ errors \(rate_limited \d+\)/);
});

test('a summary with nothing to report keeps the counters line minimal', async () => {
  const r = rig();

  await run({ ...r.options, argv: ['--offline'] });

  assert.match(r.stdout(), /\nHTTP: 0 requests\n/);
});

// ---------------------------------------------------------------------------
// `--save`
// ---------------------------------------------------------------------------

test('--save refuses to hang on a non-interactive run', async () => {
  const r = rig();
  const code = await run({ ...r.options, argv: ['--save'] });

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /--save needs a terminal/);
  assert.equal(r.written.path, undefined);
});

test('--save writes the merged env file and does not probe', async () => {
  const r = rig({
    texts: {
      [XDG_ENV_PATH]:
        '# my jira config\nJIRA_SITE=old.atlassian.net\nJIRA_WRITE_MODE=apply\n',
    },
    files: { [XDG_ENV_PATH]: 0o600 },
  });
  const answers = ['acme.atlassian.net', 'ops@example.com', TOKEN, ''];
  let asked = 0;

  const code = await run({
    ...r.options,
    argv: ['--save'],
    jiraRequest: healthy(r.jira).fn,
    prompt: (_question, options) => {
      const answer = answers[asked++] ?? '';
      assert.equal(options.secret, asked === 3, 'only the token is marked secret');
      return Promise.resolve(answer);
    },
  });

  assert.equal(code, EXIT_OK);
  assert.equal(
    r.jira.calls.length,
    0,
    '--save must not probe with the old configuration',
  );
  assert.equal(r.written.path, XDG_ENV_PATH);
  assert.equal(
    r.written.contents,
    [
      '# my jira config',
      'JIRA_SITE=acme.atlassian.net',
      'JIRA_WRITE_MODE=apply',
      'JIRA_EMAIL=ops@example.com',
      `JIRA_API_TOKEN=${TOKEN}`,
      '',
    ].join('\n'),
  );
  assert.equal(r.stdout().includes(TOKEN), false, 'the token is written, never echoed');
});

test('[CC-180] --save never writes into the project-local .env it loaded', async () => {
  // `loadSettings` only reads an env file when it runs over `process.env`, so
  // this test has to as well — otherwise nothing is loaded and the target
  // falls back to the XDG path for the wrong reason.
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('JIRA_') || key === 'XDG_CONFIG_HOME') delete process.env[key];
    }
    const projectEnv = join(CWD, '.env');
    const r = rig({
      texts: { [projectEnv]: 'JIRA_SITE=old.atlassian.net\n' },
      extra: {
        env: process.env,
        envFileHost: {
          statFile: (path) => (path === projectEnv ? 0o600 : undefined),
          loadFile: () => undefined,
        },
      },
    });
    const answers = ['acme.atlassian.net', 'ops@example.com', TOKEN, ''];
    let asked = 0;

    const code = await run({
      ...r.options,
      argv: ['--save'],
      jiraRequest: healthy(r.jira).fn,
      prompt: () => Promise.resolve(answers[asked++] ?? ''),
    });

    assert.equal(code, EXIT_OK, r.stderr());
    assert.equal(r.written.path, XDG_ENV_PATH);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('[CC-212] --save refuses when an active profile or oauth mode would ignore what it writes', async () => {
  const cases = [
    {
      env: baseEnv({
        JIRA_ACTIVE_PROFILE: 'eu',
        JIRA_PROFILE_EU_API_TOKEN: 'eu-profile-token-value',
      }),
      says: /overrides them with JIRA_PROFILE_EU_API_TOKEN/,
    },
    { env: oauthEnv(), says: /jira-mcp-ai login/ },
  ];
  for (const { env, says } of cases) {
    const r = rig({ env });
    let asked = 0;
    const code = await run({
      ...r.options,
      argv: ['--save'],
      prompt: () => {
        asked += 1;
        return Promise.resolve('x');
      },
    });
    assert.equal(code, EXIT_CONFIG, r.stderr());
    assert.match(r.stderr(), says);
    assert.equal(asked, 0, 'nothing is asked for that would not be used');
    assert.equal(r.written.contents, undefined);
  }
});

test('--save aborts without writing when an answer is empty', async () => {
  const r = rig();
  const answers = ['acme.atlassian.net', ''];
  let asked = 0;

  const code = await run({
    ...r.options,
    argv: ['--save'],
    prompt: () => Promise.resolve(answers[asked++] ?? ''),
  });

  assert.equal(code, EXIT_CONFIG);
  assert.match(r.stderr(), /Aborted: nothing was written/);
  assert.equal(r.written.contents, undefined);
});

test('[CC-190] [CC-210] --save refuses a site, email or expiry the next start would refuse, and a value a .env file cannot hold', async () => {
  const cases = [
    {
      answers: ['http://acme.atlassian.net', 'ops@example.com', TOKEN, ''],
      says: /https/,
    },
    { answers: ['acme.atlassian.net', 'ops', TOKEN, ''], says: /JIRA_EMAIL "ops"/ },
    {
      answers: ['acme.atlassian.net', 'ops@example.com', TOKEN, '1/31/2027'],
      says: /JIRA_TOKEN_EXPIRES "1\/31\/2027"/,
    },
    {
      // [CC-210] a value no .env quoting can carry is refused, not mangled.
      answers: ['acme.atlassian.net', 'ops@example.com', "it's", ''],
      says: /JIRA_API_TOKEN contains a single quote/,
    },
  ];
  for (const { answers, says } of cases) {
    const r = rig();
    let asked = 0;
    const code = await run({
      ...r.options,
      argv: ['--save'],
      prompt: () => Promise.resolve(answers[asked++] ?? ''),
    });
    assert.equal(code, EXIT_CONFIG, answers.join(' '));
    assert.match(r.stderr(), says);
    assert.match(r.stderr(), /Aborted: nothing was written/);
    assert.equal(r.written.contents, undefined);
  }
});

test('--save records the expiry date when one is given', async () => {
  const r = rig();
  const answers = ['acme.atlassian.net', 'ops@example.com', TOKEN, '2027-01-31'];
  let asked = 0;

  const code = await run({
    ...r.options,
    argv: ['--save'],
    prompt: () => Promise.resolve(answers[asked++] ?? ''),
  });

  assert.equal(code, EXIT_OK);
  assert.match(r.written.contents ?? '', /^JIRA_TOKEN_EXPIRES=2027-01-31$/m);
  assert.match(r.stdout(), /Saved\. Run `jira-mcp-ai doctor` to verify/);
});

test('--save prompts when a prompt is injected, whatever the terminal says', async () => {
  const r = rig();
  const { isTTY: rigIsTTY, ...withoutTTY } = r.options;
  assert.equal(
    rigIsTTY,
    false,
    'the rig pins isTTY; this test drops it so the default applies',
  );
  const answers = ['acme.atlassian.net', 'ops@example.com', TOKEN, ''];
  let asked = 0;

  // No `isTTY` at all: the default consults `process.stdin.isTTY`, which under
  // the test runner is not a terminal. An injected prompt is the caller saying
  // "I will answer", and it must outrank that check — otherwise this path
  // could only ever be tested by owning the process's stdin.
  const code = await run({
    ...withoutTTY,
    argv: ['--save'],
    prompt: () => Promise.resolve(answers[asked++] ?? ''),
  });

  assert.equal(code, EXIT_OK, r.stderr());
  assert.equal(asked, 4);
  assert.equal(r.written.path, XDG_ENV_PATH);
});

test("--save puts the lock's warning on stderr and keeps the report stream clean", async () => {
  const r = rig({ saveWarning: 'Removed a stale lock left by pid 4242.' });
  const answers = ['acme.atlassian.net', 'ops@example.com', TOKEN, ''];
  let asked = 0;

  const code = await run({
    ...r.options,
    argv: ['--save'],
    prompt: () => Promise.resolve(answers[asked++] ?? ''),
  });

  assert.equal(code, EXIT_OK);
  // D11: the file was still written, so the outcome belongs on stdout and the
  // diagnostic about HOW it was written belongs on stderr.
  assert.equal(r.stderr(), 'Removed a stale lock left by pid 4242.\n');
  assert.match(r.stdout(), /Saved\./);
  assert.equal(r.written.path, XDG_ENV_PATH);
});

test('--save reports a failed write on stderr and exits 2', async () => {
  const r = rig({
    writeError: new Error("EACCES: permission denied, open '/home/ops/.config'"),
  });
  const answers = ['acme.atlassian.net', 'ops@example.com', TOKEN, ''];
  let asked = 0;

  const code = await run({
    ...r.options,
    argv: ['--save'],
    prompt: () => Promise.resolve(answers[asked++] ?? ''),
  });

  assert.equal(code, EXIT_CONFIG);
  assert.match(
    r.stderr(),
    /Could not write "\/home\/ops\/\.config\/jira-mcp-ai\/\.env": EACCES: permission denied/,
  );
  // No "Saved." — the operator must not be told a token was stored when it
  // was not, and the token must not appear in the failure either.
  assert.doesNotMatch(r.stdout(), /Saved\./);
  assert.equal(r.stderr().includes(TOKEN), false);
});

test('[CC-210] mergeEnvFile keeps foreign lines and quotes values so they read back intact', () => {
  const token = 'has space, "quote", back\\slash and #hash';
  const merged = mergeEnvFile('# header\nexport JIRA_EMAIL=old@example.com\nOTHER=1', [
    ['JIRA_EMAIL', 'new@example.com'],
    ['JIRA_API_TOKEN', token],
  ]);

  assert.equal(
    merged,
    [
      '# header',
      'JIRA_EMAIL=new@example.com',
      'OTHER=1',
      `JIRA_API_TOKEN='${token}'`,
      '',
    ].join('\n'),
  );
  // The reader is Node's own parser, so the round trip is judged by it.
  assert.equal(parseEnv(merged)['JIRA_API_TOKEN'], token);
  assert.equal(
    mergeEnvFile(undefined, [['JIRA_SITE', 'acme.atlassian.net']]),
    'JIRA_SITE=acme.atlassian.net\n',
  );
});

test('[CC-237] mergeEnvFile rewrites every assignment of a key, so a later duplicate cannot win', () => {
  const merged = mergeEnvFile(
    'JIRA_API_TOKEN=first\nOTHER=1\nexport JIRA_API_TOKEN=last',
    [['JIRA_API_TOKEN', 'fresh']],
  );

  assert.equal(merged, 'JIRA_API_TOKEN=fresh\nOTHER=1\nJIRA_API_TOKEN=fresh\n');
  // Node's parser keeps the last assignment — that is what the next start reads.
  assert.equal(parseEnv(merged)['JIRA_API_TOKEN'], 'fresh');
});

// ---------------------------------------------------------------------------
// The real host adapters
//
// Everything above runs against injected seams. These four tests exercise the
// defaults themselves — the filesystem, the readline prompt and one full run
// over `process.env` — because a seam that is only ever faked is a seam whose
// real implementation nobody has read.
// ---------------------------------------------------------------------------

/** A temp directory removed by the caller's `finally`. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jira-doctor-'));
}

test('nodeDoctorFs.readText answers with the contents, and with undefined for what is not there', () => {
  const dir = tempDir();
  try {
    const path = join(dir, '.env');
    writeFileSync(path, 'JIRA_SITE=acme.atlassian.net\n');

    assert.equal(nodeDoctorFs.readText(path), 'JIRA_SITE=acme.atlassian.net\n');
    // A missing file is "nothing to merge", not a crash: `--save` calls this to
    // decide whether it is creating or updating.
    assert.equal(nodeDoctorFs.readText(join(dir, 'absent')), undefined);
    // So is a directory, which is what a mistyped JIRA_ENV_FILE tends to be.
    assert.equal(nodeDoctorFs.readText(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nodeDoctorFs.touchAppend creates at 0600 and never truncates', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'writes.jsonl');
    nodeDoctorFs.touchAppend(path);

    assert.equal(existsSync(path), true);
    // The journal holds issue keys and who wrote them; the probe that proves it
    // is writable must not be the thing that creates it world-readable.
    assert.equal(statSync(path).mode & 0o777, 0o600);

    writeFileSync(path, '{"op":"first"}\n', { flag: 'a' });
    nodeDoctorFs.touchAppend(path);
    // The probe runs on every doctor invocation. Opening with 'w' instead of
    // 'a' would silently erase the operator's audit trail.
    assert.equal(readFileSync(path, 'utf8'), '{"op":"first"}\n');

    // A path whose directory does not exist must throw, so the probe can fail.
    assert.throws(() => {
      nodeDoctorFs.touchAppend(join(dir, 'no-such-dir', 'writes.jsonl'));
    }, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nodeDoctorFs.writeSecret writes 0600 under the lock and releases it', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, '.env');
    const warnings: string[] = [];
    const clock = createFakeClock(START_MS);

    await nodeDoctorFs.writeSecret(path, () => `JIRA_API_TOKEN=${TOKEN}\n`, {
      clock,
      onWarning: (message) => warnings.push(message),
    });

    assert.equal(readFileSync(path, 'utf8'), `JIRA_API_TOKEN=${TOKEN}\n`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(warnings, [], 'a clean write warns about nothing');
    // The lock is a directory next to the target. Leaving it behind would make
    // the NEXT `--save` wait for a process that already exited.
    assert.equal(existsSync(`${path}.lock`), false);

    // Second write over an existing file: still 0600, contents replaced whole.
    await nodeDoctorFs.writeSecret(path, () => 'JIRA_SITE=acme.atlassian.net\n', {
      clock,
    });
    assert.equal(readFileSync(path, 'utf8'), 'JIRA_SITE=acme.atlassian.net\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[CC-239] nodeDoctorFs.writeSecret reads the file it merges into while holding the lock', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, '.env');
    // Written by "someone else" after doctor prompted, before it saves.
    writeFileSync(path, 'OTHER=edited-meanwhile\n');
    let lockHeldDuringRead = false;

    await nodeDoctorFs.writeSecret(
      path,
      (existing) => {
        lockHeldDuringRead = existsSync(`${path}.lock`);
        return mergeEnvFile(existing, [['JIRA_SITE', 'acme.atlassian.net']]);
      },
      { clock: createFakeClock(START_MS) },
    );

    assert.equal(lockHeldDuringRead, true, 'the read must happen inside the lock');
    assert.equal(
      readFileSync(path, 'utf8'),
      'OTHER=edited-meanwhile\nJIRA_SITE=acme.atlassian.net\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createReadlinePrompt asks on its output stream, trims the answer and closes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

  const ask = createReadlinePrompt(input, output);
  const answer = ask('Atlassian account email: ', { secret: false });
  input.write('  ops@example.com  \n');
  assert.equal(await answer, 'ops@example.com');
  assert.equal(written.join(''), 'Atlassian account email: ');

  // The second question proves the first interface was closed: a readline
  // instance left open keeps the process alive and steals the next line.
  const second = ask('API token: ', { secret: true });
  input.write(`${TOKEN}\n`);
  assert.equal(await second, TOKEN);
  input.end();
});

test('CC-80: a real env file on disk is loaded, reported once, and its mode judged once', async () => {
  const dir = tempDir();
  const saved = { ...process.env };
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  try {
    const envPath = join(dir, 'jira.env');
    const journalPath = join(dir, 'writes.jsonl');
    writeFileSync(
      envPath,
      [
        'JIRA_SITE=acme.atlassian.net',
        'JIRA_EMAIL=ops@example.com',
        `JIRA_API_TOKEN=${TOKEN}`,
        `JIRA_JOURNAL_PATH=${journalPath}`,
        // Keeps the DEFAULT logger — the one this test is here to exercise —
        // off the real stderr: `settings_report` is an info event.
        'JIRA_LOG_LEVEL=error',
        '',
      ].join('\n'),
    );
    // Explicitly, not via the write above: a strict umask would already give
    // 0600 and the permission warning would never fire.
    chmodSync(envPath, 0o644);

    for (const key of Object.keys(process.env)) {
      if (key.startsWith('JIRA_')) delete process.env[key];
    }
    process.env['JIRA_ENV_FILE'] = envPath;

    // Nothing injected but the two writers and `--offline`: the clock, rng,
    // env, platform, env-file host, filesystem, logger and TTY check are all
    // the real defaults, which is the point of this test.
    const code = await run({
      argv: ['--offline'],
      stdout: (text) => outChunks.push(text),
      stderr: (text) => errChunks.push(text),
    });

    const out = outChunks.join('');
    assert.equal(code, EXIT_OK, out);
    assert.match(out, new RegExp(`\\[ ok \\] env file: loaded "${envPath}"`));
    assert.match(out, /\(explicit location\)/);
    // Loading the file also loaded the token into `process.env`, and doctor
    // registered it before printing anything.
    assert.equal(out.includes(TOKEN), false);
    // The permissive mode is reported ONCE. `loadEnvFile` raises it as a
    // startup finding and `describeEnvFile` must not re-derive its own verdict
    // on top — the operator would read two different sentences about one file.
    assert.equal(out.split('0644').length - 1, 1, out);
    assert.doesNotMatch(out, /readable beyond the owner/);
    // The real `touchAppend` ran against a real directory.
    assert.equal(existsSync(journalPath), true);
    assert.match(out, new RegExp(`\\[ ok \\] journal: appendable: "${journalPath}"`));
    assert.equal(errChunks.join(''), '', 'D11: nothing but the report was printed');
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});
