import assert from 'node:assert/strict';
import { test } from 'node:test';

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
} from '../core/fakes/index.js';
import type { EnvFileHost } from '../core/config.js';
import type { JiraHttpOptions } from '../core/http.js';
import {
  doctorUsage,
  EXIT_CONFIG,
  EXIT_OK,
  EXIT_PROBE_FAILED,
  mergeEnvFile,
  run,
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
    writeSecret: (path, contents) => {
      written.path = path;
      written.contents = contents;
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
  assert.match(out, /10 probes: /);
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
    jql: 'order by created desc',
    maxResults: 1,
    fields: ['key'],
  });
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

test('a local probe can fail on its own: unsupported transport exits 1', async () => {
  const r = rig({
    env: baseEnv({ JIRA_TRANSPORT: 'http', JIRA_HTTP_TOKEN: 'loopback-token' }),
  });
  const code = await run({ ...r.options, argv: ['--offline'] });

  const out = r.stdout();
  assert.equal(code, EXIT_PROBE_FAILED, out);
  assert.match(out, /\[FAIL] gating: transport http is not available in v1/);
  assert.match(out, /v1\.5 \(D19\)/);
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
  assert.equal(report.probes.length, 10);
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

test('the --json report is redacted too', async () => {
  const r = rig({ env: baseEnv({ JIRA_JOURNAL_PATH: `/tmp/${TOKEN}.jsonl` }) });

  await run({ ...r.options, argv: ['--json', '--offline'] });

  assert.equal(r.stdout().includes(TOKEN), false);
  const report = JSON.parse(r.stdout()) as DoctorReport;
  assert.equal(report.probes.length, 10);
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

test('mergeEnvFile keeps foreign lines and quotes what needs quoting', () => {
  const merged = mergeEnvFile('# header\nexport JIRA_EMAIL=old@example.com\nOTHER=1', [
    ['JIRA_EMAIL', 'new@example.com'],
    ['JIRA_API_TOKEN', 'has space and "quote"'],
  ]);

  assert.equal(
    merged,
    [
      '# header',
      'JIRA_EMAIL=new@example.com',
      'OTHER=1',
      'JIRA_API_TOKEN="has space and \\"quote\\""',
      '',
    ].join('\n'),
  );
  assert.equal(
    mergeEnvFile(undefined, [['JIRA_SITE', 'acme.atlassian.net']]),
    'JIRA_SITE=acme.atlassian.net\n',
  );
});
