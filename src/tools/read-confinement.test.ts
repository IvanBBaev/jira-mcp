// Read confinement over the real catalogue (D527, V3-40, QA-R4).
//
// The write gate hands every read tool a read-only seam: a GET or a `safe`
// request passes, anything else is refused before the network and surfaces as
// the fixed unexpected-error envelope. This file proves both halves:
//
//   * the seam   — a real read tool whose handler is made to send a mutation
//                  gets the internal error, and nothing reaches Jira;
//   * the label  — every tool annotated `readOnlyHint: true` runs through the
//                  real registry, gate and handler against a recording Jira
//                  that answers every route, answers `ok`, and sends only GET
//                  or `safe` requests.
//
// The fixture table iterates the catalogue, so a read tool added to
// `PACKAGES` without fixture arguments fails the first test.
//
// It lives in `tools/` rather than `mcp/` because it imports the manifest, and
// `mcp` may not import `tools` (the layering lint).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import { JIRA_ROOT_PATHS } from '../core/types.js';
import type {
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  Rng,
  Settings,
  WriteMode,
} from '../core/types.js';
import { UNEXPECTED_THROW_KIND, UNEXPECTED_THROW_MESSAGE } from '../mcp/errors.js';
import { createRegistry, selectPackages } from '../mcp/registry.js';
import type { AnyToolSpec, PackageSpec } from '../mcp/types.js';
import { createMemoryMedia } from '../testing/memory-media.js';
import { createAttachmentsPackage } from './attachments.js';
import { PACKAGES, buildCapabilitiesInfo, createPackages } from './index.js';
import type { CapabilitiesInfo } from './core.js';
import { createPortfolioPackage } from './portfolio.js';

// ---------------------------------------------------------------------------
// A Jira that answers every route a read tool sends
// ---------------------------------------------------------------------------

const PAGE = { values: [], startAt: 0, maxResults: 50, total: 0, isLast: true };
const ISSUE_PAGE = { issues: [], startAt: 0, maxResults: 50, total: 0 };

function issue(key: string): Record<string, unknown> {
  return {
    id: '10001',
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { id: '10000', name: 'Task' },
      project: { id: '1000', key: 'ABC' },
      labels: [],
    },
  };
}

/** One answer per route; the default is an empty page. */
function answer(req: JiraRequestSpec): unknown {
  const seg = req.path
    .split('/')
    .slice(1)
    .map((s) => decodeURIComponent(s));
  const [head, second, third] = seg;

  if (req.root === 'agile' || req.root === 'software') {
    if (head === 'board' && second === undefined) return PAGE;
    if (head === 'board' && third === undefined)
      return {
        id: Number(second),
        name: 'B',
        type: 'scrum',
        location: { projectKey: 'ABC' },
      };
    if (head === 'board' && third === 'configuration')
      return { id: Number(second), name: 'B', columnConfig: { columns: [] } };
    if (head === 'board' && third === 'sprint') return PAGE;
    if (head === 'sprint' && third === undefined) {
      // An active sprint, so the summary reads the Sprint-field history too.
      return {
        id: Number(second),
        name: `Sprint ${second ?? ''}`,
        state: 'active',
        startDate: '2026-10-19T09:00:00.000Z',
        endDate: '2026-11-02T17:00:00.000Z',
        originBoardId: 1,
      };
    }
    return ISSUE_PAGE;
  }

  switch (head) {
    case 'myself':
      return { accountId: 'acc-me', displayName: 'Me', active: true };
    case 'mypermissions':
      return { permissions: {} };
    case 'search':
      if (second === 'approximate-count') return { count: 0 };
      return { issues: [issue('ABC-1')], isLast: true };
    case 'jql': {
      // `/jql/parse` answers one entry per query sent.
      const queries = (req.body as { queries?: unknown } | undefined)?.queries;
      const sent = Array.isArray(queries) ? queries : [];
      return { queries: sent.map((query: unknown) => ({ query, errors: [] })) };
    }
    case 'filter':
      if (second === 'search') return PAGE;
      return { id: second, name: 'F', jql: 'project = ABC' };
    case 'issue':
      if (second === 'bulkfetch') return { issues: [issue('ABC-1')], issueErrors: [] };
      if (second === 'createmeta') return { issueTypes: [], values: [] };
      if (third === undefined) return issue(second ?? 'ABC-1');
      if (third === 'transitions') return { transitions: [] };
      if (third === 'comment')
        return { comments: [], startAt: 0, maxResults: 50, total: 0 };
      if (third === 'worklog')
        return { worklogs: [], startAt: 0, maxResults: 50, total: 0 };
      if (third === 'changelog') return PAGE;
      if (third === 'remotelink') return [];
      if (third === 'watchers') return { watchers: [], watchCount: 0 };
      return {};
    case 'changelog':
      return { issueChangeLogs: [] };
    case 'bulk':
      return { taskId: second, status: 'COMPLETE', progressPercent: 100 };
    case 'attachment':
      if (second === 'content') return new TextEncoder().encode('hello');
      return {
        id: second,
        filename: 'f.txt',
        size: 5,
        mimeType: 'text/plain',
        content: `https://example.atlassian.net/rest/api/3/attachment/content/${second ?? ''}`,
      };
    case 'project':
      if (second === undefined || second === 'search') return PAGE;
      if (third === undefined)
        return { id: '1000', key: 'ABC', name: 'Project ABC', issueTypes: [] };
      if (third === 'role') return {};
      return third === 'components' || third === 'versions' ? [] : PAGE;
    case 'priority':
    case 'resolution':
      return PAGE;
    case 'field':
    case 'user':
    case 'issuetype':
      return [];
    case 'issueLinkType':
      return { issueLinkTypes: [] };
    case 'configuration':
      return {
        timeTrackingEnabled: true,
        workingHoursPerDay: 8,
        workingDaysPerWeek: 5,
        timeFormat: 'pretty',
        defaultUnit: 'minute',
      };
    case 'statuses':
    case 'label':
    case undefined:
    default:
      return PAGE;
  }
}

interface World {
  readonly seam: JiraRequestFn;
  readonly calls: JiraRequestSpec[];
}

function createWorld(): World {
  const calls: JiraRequestSpec[] = [];
  const seam: JiraRequestFn = async <T = unknown>(
    req: JiraRequestSpec,
  ): Promise<JiraResponse<T>> => {
    calls.push(req);
    await Promise.resolve();
    return { status: 200, headers: {}, data: answer(req) as T };
  };
  return { seam, calls };
}

function isRead(req: JiraRequestSpec): boolean {
  return req.method === 'GET' || req.safe === true;
}

function routeOf(req: JiraRequestSpec): string {
  return `${req.method} ${JIRA_ROOT_PATHS[req.root ?? 'v3']}${req.path}${req.safe === true ? ' (safe)' : ''}`;
}

// ---------------------------------------------------------------------------
// The registry under test
// ---------------------------------------------------------------------------

function settings(writeMode: WriteMode): Settings {
  return {
    allowedHosts: [],
    profiles: {},
    lockProfile: true,
    toolPackages: ['all'],
    packagesDeny: [],
    packagesReadonly: [],
    writeMode,
    allowIrreversible: true,
    irreversibleConfirm: 'off',
    requestTimeoutMs: 30_000,
    callBudgetMs: 120_000,
    hostConcurrency: 4,
    retryAttempts: 3,
    maxResultChars: 25_000,
    maxPages: 20,
    metaCacheTtlS: 300,
    mediaMaxBytes: 1073741824,
    transport: 'stdio',
    httpPort: 3334,
    logLevel: 'info',
    ...FAKE_AUTH_SETTINGS,
  };
}

function countingRng(): Rng {
  let n = 1;
  return (): number => {
    n += 1;
    return (n % 4096) / 4096;
  };
}

let reportDir: string | undefined;

/** The manifest as `main()` binds it: a capabilities report, a media store, a report dir. */
async function manifest(): Promise<readonly PackageSpec[]> {
  reportDir ??= await mkdtemp(join(tmpdir(), 'jira-mcp-read-confinement-'));
  const media = createMemoryMedia();
  const dir = reportDir;
  const bound: readonly PackageSpec[] = createPackages((): CapabilitiesInfo =>
    buildCapabilitiesInfo({
      settings: settings('apply'),
      selection: selectPackages(bound, settings('apply')),
      host: { origin: 'https://example.atlassian.net', pathPrefix: '' },
      serverName: 'jira-mcp-ai',
      version: '9.9.9',
    }),
  ).map((pkg) => {
    if (pkg.id === 'attachments') return createAttachmentsPackage({ store: media });
    if (pkg.id === 'portfolio') return createPortfolioPackage({ reportDir: dir });
    return pkg;
  });
  return bound;
}

test.after(async () => {
  if (reportDir !== undefined) await rm(reportDir, { recursive: true, force: true });
});

interface Outcome {
  readonly ok: boolean;
  readonly error: {
    kind: string;
    message: string;
    retryable?: boolean;
    detail?: unknown;
  };
  readonly calls: readonly JiraRequestSpec[];
}

async function run(
  tool: string,
  args: Record<string, unknown>,
  options: {
    readonly writeMode?: WriteMode;
    readonly packages?: readonly PackageSpec[];
  } = {},
): Promise<Outcome> {
  const world = createWorld();
  const registry = createRegistry(options.packages ?? (await manifest()), {
    settings: settings(options.writeMode ?? 'apply'),
    jira: world.seam,
    logger: createFakeLogger(),
    clock: createFakeClock(Date.parse('2026-10-30T12:00:00.000Z')),
    rng: countingRng(),
    redactor: createFakeRedactor([]),
  });
  const result = await registry.call(tool, args);
  const content = result.structuredContent as {
    ok: boolean;
    error?: Outcome['error'];
  };
  return {
    ok: content.ok,
    error: content.error ?? { kind: '', message: '' },
    calls: world.calls,
  };
}

// ---------------------------------------------------------------------------
// Fixtures: every read tool, with arguments that drive its requests
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

/**
 * One or more argument sets per read tool. A tool with several request paths
 * gets one variant per path (a single and a bulk issue read; a sprint summary
 * that reads the bulk changelog).
 */
const FIXTURES: Readonly<Record<string, readonly Args[]>> = {
  // core
  jira_capabilities: [{}],
  jira_get_myself: [{}],
  jira_get_my_permissions: [{ permissions: ['BROWSE_PROJECTS'], project: 'ABC' }],
  // search
  jira_search: [{ jql: 'project = ABC' }],
  jira_count: [{ jql: 'project = ABC' }],
  jira_parse_jql: [{ queries: ['project = ABC'] }],
  jira_list_filters: [{ filterName: 'sprint' }],
  jira_get_filter: [{ filterId: '10042' }],
  // issues
  jira_get_issue: [{ issue: 'ABC-1' }, { issues: ['ABC-1', 'ABC-2'] }],
  jira_get_comments: [{ issue: 'ABC-1' }],
  jira_get_transitions: [{ issue: 'ABC-1' }],
  jira_get_changelog: [{ issue: 'ABC-1' }],
  jira_get_changelogs_bulk: [{ issues: ['ABC-1', 'ABC-2'], fieldIds: ['status'] }],
  jira_get_worklogs: [{ issue: 'ABC-1' }],
  jira_get_remote_links: [{ issue: 'ABC-1' }],
  jira_get_bulk_status: [{ taskId: '10001' }],
  // attachments
  jira_list_attachments: [{ issue: 'ABC-1' }],
  jira_download_attachment: [{ attachmentId: '10500' }],
  // collab
  jira_list_watchers: [{ issue: 'ABC-1' }],
  jira_list_components: [{ project: 'ABC' }],
  jira_list_versions: [{ project: 'ABC' }],
  jira_list_project_roles: [{ project: 'ABC' }],
  // meta / users
  jira_list_projects: [{}],
  jira_get_project: [{ project: 'ABC' }],
  jira_list_fields: [{}],
  jira_get_create_meta: [{ project: 'ABC' }],
  jira_list_statuses: [{ projectId: '1000' }],
  jira_list_link_types: [{}],
  jira_list_priorities: [{}],
  jira_list_resolutions: [{}],
  jira_list_issue_types: [{}],
  jira_list_labels: [{}],
  jira_get_timetracking_config: [{}],
  jira_search_users: [{ query: 'ann' }],
  // agile
  jira_list_boards: [{}],
  jira_get_board_config: [{ boardId: 1 }],
  jira_list_sprints: [{ boardId: 1 }],
  jira_get_sprint_issues: [{ sprintId: 11 }],
  jira_get_backlog: [{ boardId: 1 }],
  jira_sprint_summary: [{ sprintId: 11 }],
  // portfolio
  jira_portfolio_analyze: [{ projects: ['ABC', 'DEF'] }],
  jira_portfolio_report: [{ projects: ['ABC', 'DEF'] }],
};

/** Reads answered locally, from configuration, with no request to Jira. */
const LOCAL: ReadonlySet<string> = new Set(['jira_capabilities']);

const CATALOGUE: readonly AnyToolSpec[] = PACKAGES.flatMap((pkg) => pkg.tools);
const READS: readonly string[] = CATALOGUE.filter(
  (t) => t.annotations.readOnlyHint === true,
).map((t) => t.name);

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** The manifest with one read tool's handler replaced by `send`. */
async function withHandler(
  tool: string,
  send: (jira: JiraRequestFn) => Promise<unknown>,
): Promise<readonly PackageSpec[]> {
  return (await manifest()).map((pkg) => ({
    ...pkg,
    tools: pkg.tools.map((spec): AnyToolSpec =>
      spec.name === tool
        ? {
            ...spec,
            handler: async (_args, ctx) => {
              await send(ctx.jira);
              return { ok: true, data: {} };
            },
          }
        : spec,
    ),
  }));
}

for (const method of ['PUT', 'POST', 'DELETE'] as const) {
  for (const writeMode of ['apply', 'plan'] as const) {
    test(`CC-5180: a read tool that sends a ${method} gets the internal error and nothing reaches Jira (${writeMode} mode)`, async () => {
      const packages = await withHandler('jira_get_issue', (jira) =>
        jira({ method, path: '/issue/ABC-1', body: { fields: { summary: 'x' } } }),
      );
      const outcome = await run(
        'jira_get_issue',
        { issue: 'ABC-1' },
        { packages, writeMode },
      );
      assert.equal(outcome.ok, false);
      assert.deepEqual(outcome.calls.map(routeOf), [], 'no request reached Jira');
      assert.equal(outcome.error.kind, UNEXPECTED_THROW_KIND);
    });
  }
}

test('CC-5181: the refusal is the fixed unexpected-error envelope: no detail, not retryable', async () => {
  const packages = await withHandler('jira_list_projects', (jira) =>
    jira({ method: 'DELETE', path: '/project/ABC' }),
  );
  const outcome = await run('jira_list_projects', {}, { packages });
  assert.equal(outcome.error.message, UNEXPECTED_THROW_MESSAGE);
  assert.equal(outcome.error.retryable, false);
  assert.equal(outcome.error.detail, undefined);
});

test('CC-5182: a read tool’s GET and safe POST pass the seam and reach Jira', async () => {
  const packages = await withHandler('jira_get_issue', async (jira) => {
    await jira({ method: 'GET', path: '/issue/ABC-1' });
    await jira({ method: 'POST', path: '/search/jql', body: { jql: 'x' }, safe: true });
  });
  const outcome = await run('jira_get_issue', { issue: 'ABC-1' }, { packages });
  assert.equal(outcome.ok, true, outcome.error.message);
  assert.deepEqual(outcome.calls.map(routeOf), [
    'GET /rest/api/3/issue/ABC-1',
    'POST /rest/api/3/search/jql (safe)',
  ]);
});

test('CC-5183: a mutation after a read is refused; the read already sent stands alone', async () => {
  const packages = await withHandler('jira_get_issue', async (jira) => {
    await jira({ method: 'GET', path: '/issue/ABC-1' });
    await jira({ method: 'PUT', path: '/issue/ABC-1', body: {} });
  });
  const outcome = await run('jira_get_issue', { issue: 'ABC-1' }, { packages });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.kind, UNEXPECTED_THROW_KIND);
  assert.deepEqual(outcome.calls.map(routeOf), ['GET /rest/api/3/issue/ABC-1']);
});

// ---------------------------------------------------------------------------
// The label, across the catalogue
// ---------------------------------------------------------------------------

test('CC-5184: every read tool has fixture arguments, and every fixture names a read tool', () => {
  assert.equal(READS.length > 0, true);
  const missing = READS.filter((name) => FIXTURES[name] === undefined);
  assert.deepEqual(missing, [], 'add FIXTURES arguments for each new read tool');
  const stale = Object.keys(FIXTURES).filter((name) => !READS.includes(name));
  assert.deepEqual(stale, [], 'fixtures for tools that are not reads in the catalogue');
  for (const name of LOCAL) assert.ok(READS.includes(name), `${name} is a read`);
});

for (const tool of READS) {
  const variants = FIXTURES[tool] ?? [];
  variants.forEach((args, index) => {
    const label = variants.length > 1 ? ` (variant ${String(index + 1)})` : '';
    test(`CC-5185: ${tool}${label} answers ok and sends only GET or safe requests`, async () => {
      const outcome = await run(tool, args);
      assert.equal(
        outcome.ok,
        true,
        `${tool}: ${outcome.error.kind} ${outcome.error.message} — ${outcome.calls.map(routeOf).join(', ')}`,
      );
      const mutations = outcome.calls.filter((req) => !isRead(req)).map(routeOf);
      assert.deepEqual(mutations, [], `${tool} sent a mutation`);
      if (LOCAL.has(tool)) {
        assert.deepEqual(outcome.calls.map(routeOf), [], `${tool} is local`);
      } else {
        assert.ok(outcome.calls.length > 0, `${tool}'s fixture reached Jira`);
      }
    });
  });
}

test('CC-5186: the POST reads are safe — both bulkfetch routes and the JQL search', async () => {
  const routes = new Set<string>();
  for (const [tool, variants] of Object.entries(FIXTURES)) {
    for (const args of variants) {
      for (const req of (await run(tool, args)).calls) {
        if (req.method !== 'GET') routes.add(routeOf(req));
      }
    }
  }
  for (const route of [
    'POST /rest/api/3/issue/bulkfetch (safe)',
    'POST /rest/api/3/changelog/bulkfetch (safe)',
    'POST /rest/api/3/search/jql (safe)',
  ]) {
    assert.ok(routes.has(route), `${route} among ${[...routes].join(', ')}`);
  }
});

test('CC-5187: read tools answer the same in plan mode — the write mode never gates a read', async () => {
  for (const tool of ['jira_get_issue', 'jira_get_changelogs_bulk', 'jira_search']) {
    const args = FIXTURES[tool]?.at(-1) ?? {};
    const applied = await run(tool, args, { writeMode: 'apply' });
    const planned = await run(tool, args, { writeMode: 'plan' });
    assert.equal(planned.ok, true, `${tool}: ${planned.error.message}`);
    assert.deepEqual(planned.calls.map(routeOf), applied.calls.map(routeOf));
  }
});
