// Tests for the `portfolio` tool package (D126): `jira_portfolio_analyze` and
// `jira_portfolio_report`.
//
// Contract tier — a fake `JiraRequestFn` that answers programmed routes and
// THROWS on anything else, so a refusal that still reached Jira fails loudly.
// Response bodies are inline and synthetic.
//
// What these tests pin down:
//   * CC-1439 — the scope is exactly one of projects and jql; a bad scope is a
//     validation error with nothing sent, and the JQL is built from upper-cased,
//     de-duplicated, quoted keys;
//   * CC-1440 — the sweep reads at most maxIssues, and a cut or a page-cap
//     stop is reported as a partial scope with a note;
//   * CC-1441 — board lookups degrade: not_found/permission note one project,
//     unsupported stops the lookups, anything else fails the call;
//   * CC-1442 — the analysis carries Jira free text, so it is branded untrusted;
//   * CC-1443 — the report tool refuses without JIRA_REPORT_DIR before any
//     call, writes through the store under a clock-derived name, returns keys
//     and counts but never the document;
//   * CC-1444 — the node store never overwrites (`-1` suffix), writes mode 0600
//     and reports a missing directory as `config`.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CLOUD_API } from '../api/port.js';
import { SEARCH_JQL_PATH } from '../api/search.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError, type JiraRequestFn, type JiraRequestSpec } from '../core/types.js';
import type { ToolCtx, ToolResult } from '../mcp/types.js';
import {
  REPORT_FILE_MODE,
  analyzePortfolioTool,
  createNodeReportStore,
  createPortfolioPackage,
  portfolioJql,
  reportFileName,
  type PortfolioReportData,
  type ReportStore,
} from './portfolio.js';

const SEARCH_ROUTE = `POST /rest/api/3${SEARCH_JQL_PATH}`;
const BOARDS_ROUTE = 'GET /rest/agile/1.0/board';
/** 2026-10-24T10:15:00Z */
const NOW = Date.UTC(2026, 9, 24, 10, 15, 0);

function createCtx(jira: JiraRequestFn, maxPages = 20): ToolCtx {
  const clock = createFakeClock(NOW);
  return {
    jira,
    api: CLOUD_API,
    log: createFakeLogger({ clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 100_000, maxPages },
    deadlineAt: NOW + 30_000,
  };
}

function dataOf<T>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  if (result.data === undefined) throw new Error('ok result carried no data');
  return result.data;
}

function issue(
  key: string,
  summary: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: key,
    key,
    fields: {
      summary,
      project: { key: key.slice(0, key.lastIndexOf('-')) },
      issuetype: { name: 'Story' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      ...extra,
    },
  };
}

function page(rows: readonly Record<string, unknown>[], nextPageToken?: string): unknown {
  // synthetic — POST /rest/api/3/search/jql
  return {
    issues: rows,
    ...(nextPageToken === undefined ? { isLast: true } : { nextPageToken }),
  };
}

function boards(project: string, names: readonly string[]): unknown {
  // synthetic — GET /rest/agile/1.0/board?projectKeyOrId=…
  return {
    maxResults: 50,
    startAt: 0,
    isLast: true,
    values: names.map((name, index) => ({
      id: index + 1,
      name,
      type: 'scrum',
      location: { projectKey: project },
    })),
  };
}

const forProject =
  (project: string) =>
  (spec: JiraRequestSpec): boolean =>
    spec.method === 'GET' &&
    spec.path === '/board' &&
    spec.query?.projectKeyOrId === project;

const ROWS = [
  issue('WEB-1', 'Export invoices to CSV'),
  issue('MOB-1', 'Export invoices to CSV'),
];

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('[CC-1439] the JQL is built from upper-cased, de-duplicated, quoted project keys', () => {
  assert.equal(
    portfolioJql({ projects: ['web', 'MOB', 'WEB'] }),
    'project in ("WEB", "MOB") ORDER BY key ASC',
  );
  assert.equal(
    portfolioJql({ projects: ['WEB', 'MOB'], includeDone: false, updatedWithinDays: 30 }),
    'project in ("WEB", "MOB") AND statusCategory != Done AND updated >= -30d ORDER BY key ASC',
  );
  assert.equal(portfolioJql({ jql: 'labels = q4' }), 'labels = q4');
  assert.equal(
    portfolioJql({ jql: 'labels = q4 order by created DESC', includeDone: false }),
    '(labels = q4) AND statusCategory != Done',
  );
});

test('[CC-1439] neither, both, or updatedWithinDays with jql is a validation error and nothing is sent', async () => {
  for (const args of [
    {},
    { projects: ['WEB', 'MOB'], jql: 'project = WEB' },
    { jql: 'project = WEB', updatedWithinDays: 7 },
  ]) {
    const fake = createFakeJiraRequest();
    const result = await analyzePortfolioTool.handler(args, createCtx(fake.fn));
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'validation');
    assert.match(result.error?.remediation ?? '', /Nothing was sent/);
    assert.equal(fake.calls.length, 0);
  }
});

test('[CC-1439] the input schema takes 2–10 well-formed project keys and refuses unknown fields', () => {
  const schema = analyzePortfolioTool.input;
  assert.equal(schema.safeParse({ projects: ['WEB'] }).success, false);
  assert.equal(schema.safeParse({ projects: ['WEB', 'MOB'] }).success, true);
  assert.equal(schema.safeParse({ projects: ['WEB', 'MO B'] }).success, false);
  assert.equal(schema.safeParse({ projects: ['WEB', 'MOB"'] }).success, false);
  assert.equal(
    schema.safeParse({ projects: Array.from({ length: 11 }, (_, i) => `P${String(i)}`) })
      .success,
    false,
  );
  assert.equal(
    schema.safeParse({ projects: ['WEB', 'MOB'], maxIssues: 1001 }).success,
    false,
  );
  assert.equal(schema.safeParse({ projects: ['WEB', 'MOB'], bogus: 1 }).success, false);
});

// ---------------------------------------------------------------------------
// `jira_portfolio_analyze`
// ---------------------------------------------------------------------------

test('[CC-1442] analyze sweeps once, looks up boards per project and brands the result untrusted', async () => {
  const fake = createFakeJiraRequest()
    .on(SEARCH_ROUTE, jiraOk(page(ROWS)))
    .on(forProject('MOB'), jiraOk(boards('MOB', ['Mobile scrum'])))
    .on(forProject('WEB'), jiraOk(boards('WEB', ['Web kanban', 'Web scrum'])));
  const result = await analyzePortfolioTool.handler(
    { projects: ['WEB', 'MOB'] },
    createCtx(fake.fn),
  );
  const data = dataOf(result);
  assert.equal(result._untrusted, true);
  assert.deepEqual(data.scope, {
    jql: 'project in ("WEB", "MOB") ORDER BY key ASC',
    issuesRead: 2,
    partial: false,
    stopReason: 'exhausted',
    restarted: false,
  });
  assert.deepEqual(data.boards, {
    byProject: { MOB: ['Mobile scrum'], WEB: ['Web kanban', 'Web scrum'] },
  });
  assert.equal(data.analysis.duplicates[0]?.kind, 'duplicate');
  const body = fake.calls[0]?.body as Record<string, unknown>;
  assert.equal(body.maxResults, 100);
  assert.ok(Array.isArray(body.fields) && body.fields.includes('issuelinks'));
});

test('[CC-1440] maxIssues caps the sweep and a cut is a partial scope with a note', async () => {
  const fake = createFakeJiraRequest().on(
    SEARCH_ROUTE,
    jiraOk(page([issue('WEB-1', 'a b'), issue('WEB-2', 'c d'), issue('MOB-1', 'e f')])),
  );
  const data = dataOf(
    await analyzePortfolioTool.handler(
      { projects: ['WEB', 'MOB'], maxIssues: 2, includeBoards: false },
      createCtx(fake.fn),
    ),
  );
  assert.equal((fake.calls[0]?.body as Record<string, unknown>).maxResults, 2);
  assert.equal(data.scope.issuesRead, 2);
  assert.equal(data.scope.partial, true);
  assert.equal(data.scope.stopReason, 'max_pages');
  assert.match(data.scope.note ?? '', /first 2 issues/);
  assert.equal(data.boards, undefined);
  assert.equal(fake.calls.length, 1, 'includeBoards:false sends no board lookup');
});

test('[CC-1440] a page-cap stop from the search is reported as partial', async () => {
  const fake = createFakeJiraRequest().on(SEARCH_ROUTE, jiraOk(page(ROWS, 'tok-2')));
  const data = dataOf(
    await analyzePortfolioTool.handler(
      { projects: ['WEB', 'MOB'], includeBoards: false },
      createCtx(fake.fn, 1),
    ),
  );
  assert.equal(data.scope.partial, true);
  assert.equal(data.scope.stopReason, 'max_pages');
  assert.match(data.scope.note ?? '', /first 100 issues/);
});

function boardError(
  kind: 'not_found' | 'permission' | 'unsupported' | 'auth',
): JiraError {
  return new JiraError({ kind, message: `board lookup: ${kind}`, remediation: 'n/a' });
}

test('[CC-1441] a not_found or permission board lookup notes the project and carries on', async () => {
  const fake = createFakeJiraRequest()
    .on(SEARCH_ROUTE, jiraOk(page(ROWS)))
    .on(forProject('MOB'), jiraErr(boardError('permission')))
    .on(forProject('WEB'), jiraErr(boardError('not_found')));
  const data = dataOf(
    await analyzePortfolioTool.handler({ projects: ['WEB', 'MOB'] }, createCtx(fake.fn)),
  );
  assert.deepEqual(data.boards, {
    byProject: {},
    note: 'Boards of MOB could not be read (permission). Boards of WEB could not be read (not_found).',
  });
});

test('[CC-1441] an unsupported board lookup stops the lookups after the first project', async () => {
  const fake = createFakeJiraRequest()
    .on(SEARCH_ROUTE, jiraOk(page(ROWS)))
    .on(BOARDS_ROUTE, jiraErr(boardError('unsupported')));
  const data = dataOf(
    await analyzePortfolioTool.handler({ projects: ['WEB', 'MOB'] }, createCtx(fake.fn)),
  );
  assert.match(data.boards?.note ?? '', /no Jira Software/);
  assert.equal(fake.calls.filter((call) => call.path === '/board').length, 1);
});

test('[CC-1441] any other board failure fails the call', async () => {
  const fake = createFakeJiraRequest()
    .on(SEARCH_ROUTE, jiraOk(page(ROWS)))
    .on(BOARDS_ROUTE, jiraErr(boardError('auth')));
  const result = await analyzePortfolioTool.handler(
    { projects: ['WEB', 'MOB'] },
    createCtx(fake.fn),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'auth');
});

// ---------------------------------------------------------------------------
// `jira_portfolio_report`
// ---------------------------------------------------------------------------

type ReportHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
) => Promise<ToolResult<PortfolioReportData>>;

function reportToolOf(store?: ReportStore): ReportHandler {
  const pkg = createPortfolioPackage(store === undefined ? {} : { store });
  const tool = pkg.tools.find((candidate) => candidate.name === 'jira_portfolio_report');
  assert.ok(tool !== undefined);
  return (args, ctx) => (tool.handler as ReportHandler)(args, ctx);
}

test('[CC-1443] without JIRA_REPORT_DIR the report is refused as config before any call', async () => {
  const fake = createFakeJiraRequest();
  const result = await reportToolOf()({ projects: ['WEB', 'MOB'] }, createCtx(fake.fn));
  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'config');
  assert.match(result.error?.message ?? '', /JIRA_REPORT_DIR/);
  assert.equal(fake.calls.length, 0);

  // A bad scope still says so first.
  const scoped = await reportToolOf()({}, createCtx(fake.fn));
  assert.equal(scoped.error?.kind, 'validation');
});

test('[CC-1443] the report goes through the store under a clock-derived name; keys and counts come back, not the document', async () => {
  const written: { name: string; text: string }[] = [];
  const store: ReportStore = {
    dir: '/reports',
    write(name, text) {
      written.push({ name, text });
      return Promise.resolve({
        name,
        path: `/reports/${name}`,
        bytes: Buffer.byteLength(text),
      });
    },
  };
  const fake = createFakeJiraRequest().on(SEARCH_ROUTE, jiraOk(page(ROWS)));
  const result = await reportToolOf(store)(
    { projects: ['WEB', 'MOB'], title: 'Q4 overlap', includeBoards: false },
    createCtx(fake.fn),
  );
  const data = dataOf(result);
  assert.equal(written.length, 1);
  assert.equal(written[0]?.name, 'portfolio-20261024T101500Z.md');
  assert.ok(written[0]?.text.startsWith('# Q4 overlap\n'));
  assert.ok(written[0]?.text.includes('Generated 2026-10-24T10:15:00.000Z'));
  assert.deepEqual(data.counts, {
    issues: 2,
    open: 2,
    duplicates: 1,
    overlaps: 0,
    reuse: 0,
    dependencies: 0,
    hotspots: 0,
  });
  assert.equal(data.path, '/reports/portfolio-20261024T101500Z.md');
  assert.deepEqual(data.projects, ['MOB', 'WEB']);
  assert.ok(
    !JSON.stringify(data).includes('Export invoices'),
    'no Jira text in the result',
  );
  assert.equal(result._untrusted, undefined);
});

test('reportFileName is a UTC stamp without milliseconds', () => {
  assert.equal(reportFileName(NOW + 987), 'portfolio-20261024T101500Z.md');
});

// ---------------------------------------------------------------------------
// The node store
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-report-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('[CC-1444] the node store never overwrites and writes owner-only files', async () => {
  await withTempDir(async (dir) => {
    const store = createNodeReportStore(dir);
    await writeFile(join(dir, 'r.md'), 'keep me');
    const first = await store.write('r.md', 'new');
    assert.equal(first.name, 'r-1.md');
    assert.equal(first.bytes, 3);
    assert.equal(await readFile(join(dir, 'r.md'), 'utf8'), 'keep me');
    assert.equal(await readFile(first.path, 'utf8'), 'new');
    const second = await store.write('r.md', 'again');
    assert.equal(second.name, 'r-2.md');
    if (process.platform !== 'win32') {
      assert.equal((await stat(first.path)).mode & 0o777, REPORT_FILE_MODE);
    }
  });
});

test('[CC-1444] a missing report directory is a config error', async () => {
  await withTempDir(async (dir) => {
    const store = createNodeReportStore(join(dir, 'missing'));
    await assert.rejects(store.write('r.md', 'x'), (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'config');
      assert.match(error.message, /does not exist/);
      return true;
    });
  });
});
