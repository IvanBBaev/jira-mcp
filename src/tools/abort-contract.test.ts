// The all-tools abort contract (V3-58, TSN-R6, CC-5350).
//
// Cancellation used to be a convention: every api helper had to spread
// `signal` and `deadlineAt` from the tool's context into each request, and a
// helper that forgot produced a request no client could cancel. The registry
// now binds both onto the `jira` seam of every call, so this suite proves the
// STRUCTURE rather than each spread: every registered tool, called with an
// already-aborted signal, must send ZERO requests to the wire and, if it needs
// Jira at all, answer with the caller-cancelled `transport` envelope.
//
// It runs the real HTTP client (`createJiraRequest`) against a recording fetch
// mock, in apply mode with every gate open, so nothing above the wire can stop
// a request on the signal's behalf. The argument table must name every tool:
// a new tool fails the coverage test until it has an entry here.
//
// Lives in tools/ (a composition root) rather than mcp/: it needs the real
// manifest, and the mcp zone may not import from tools/.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import { createJiraRequest } from '../core/http.js';
import type { Rng, Settings } from '../core/types.js';
import { createRegistry } from '../mcp/registry.js';
import { createMemoryMedia } from '../testing/memory-media.js';
import { withFetch } from '../testing/with-fetch.js';
import { createAttachmentsPackage } from './attachments.js';
import { createPackages } from './index.js';
import { createPortfolioPackage, type ReportStore } from './portfolio.js';

const SITE = { origin: 'https://acme.atlassian.net', pathPrefix: '' } as const;

const SETTINGS: Settings = {
  ...FAKE_AUTH_SETTINGS,
  site: SITE.origin,
  allowedHosts: ['acme.atlassian.net'],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'apply',
  allowIrreversible: true,
  irreversibleConfirm: 'off',
  writeConfirm: 'off',
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
};

const RNG: Rng = () => 0.5;
const KEY = 'ABC-1';

/**
 * Tools that never reach Jira. They still run under the same assertion of
 * zero requests; they are simply allowed to succeed.
 */
const LOCAL_TOOLS: ReadonlySet<string> = new Set(['jira_capabilities']);

/** The smallest valid arguments of every registered tool. */
const ARGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // core
  jira_capabilities: {},
  jira_get_myself: {},
  jira_get_my_permissions: { permissions: ['BROWSE_PROJECTS'] },
  // search
  jira_search: { jql: 'project = ABC' },
  jira_count: { jql: 'project = ABC' },
  jira_parse_jql: { queries: ['project = ABC'] },
  jira_list_filters: {},
  jira_get_filter: { filterId: 10 },
  jira_create_filter: { name: 'Mine', jql: 'project = ABC' },
  jira_update_filter: { filterId: 10, name: 'Renamed' },
  // issues
  jira_get_issue: { issue: KEY },
  jira_get_comments: { issue: KEY },
  jira_get_transitions: { issue: KEY },
  jira_get_changelog: { issue: KEY },
  jira_get_changelogs_bulk: { issues: [KEY] },
  jira_get_worklogs: { issue: KEY },
  jira_get_remote_links: { issue: KEY },
  jira_get_bulk_status: { taskId: '10001' },
  // issues-write
  jira_create_issue: { project: 'ABC', issueType: 'Task', summary: 'Hello' },
  jira_update_issue: { issue: KEY, summary: 'Renamed' },
  jira_transition_issue: { issue: KEY, transition: 'Done' },
  jira_add_comment: { issue: KEY, body: 'Hello' },
  jira_update_comment: { issue: KEY, commentId: '10', body: 'Hello' },
  jira_assign_issue: { issue: KEY, accountId: 'abc' },
  jira_add_worklog: { issue: KEY, timeSpent: '1h' },
  jira_update_worklog: { issue: KEY, worklogId: '10', timeSpent: '2h' },
  jira_link_issues: { linkType: 'Blocks', inwardIssue: KEY, outwardIssue: 'ABC-2' },
  jira_add_remote_link: { issue: KEY, url: 'https://example.com/pr/1', title: 'PR 1' },
  // issues-delete
  jira_delete_issue: { issue: KEY },
  jira_delete_comment: { issue: KEY, commentId: '10' },
  jira_delete_worklog: { issue: KEY, worklogId: '10' },
  jira_unlink_issues: { linkId: '10' },
  jira_delete_attachment: { attachmentId: '10' },
  jira_delete_remote_link: { issue: KEY, linkId: '10' },
  jira_delete_component: { componentId: 10 },
  jira_delete_version: { versionId: 10 },
  jira_delete_sprint: { sprintId: 10 },
  jira_bulk_delete_issues: { issues: [KEY] },
  jira_bulk_edit_issues: { issues: [KEY], labels: ['x'], labelsAction: 'ADD' },
  // attachments
  jira_list_attachments: { issue: KEY },
  jira_download_attachment: { attachmentId: '10' },
  jira_upload_attachment: { issue: KEY, name: 'notes.txt' },
  // collab
  jira_list_watchers: { issue: KEY },
  jira_add_watcher: { issue: KEY, accountId: 'abc' },
  jira_remove_watcher: { issue: KEY, accountId: 'abc' },
  jira_add_vote: { issue: KEY },
  jira_remove_vote: { issue: KEY },
  jira_list_components: { project: 'ABC' },
  jira_create_component: { project: 'ABC', name: 'Backend' },
  jira_update_component: { componentId: 10, name: 'Frontend' },
  jira_list_versions: { project: 'ABC' },
  jira_create_version: { projectId: 10000, name: '1.0.0' },
  jira_update_version: { versionId: 10, name: '1.0.1' },
  jira_list_project_roles: { project: 'ABC' },
  // meta
  jira_list_projects: {},
  jira_get_project: { project: 'ABC' },
  jira_list_fields: {},
  jira_get_create_meta: { project: 'ABC' },
  jira_list_statuses: {},
  jira_list_link_types: {},
  jira_list_priorities: {},
  jira_list_resolutions: {},
  jira_list_issue_types: {},
  jira_list_labels: {},
  jira_get_timetracking_config: {},
  // users
  jira_search_users: { query: 'ana' },
  // agile
  jira_list_boards: {},
  jira_get_board_config: { boardId: 1 },
  jira_list_sprints: { boardId: 1 },
  jira_get_sprint_issues: { sprintId: 1 },
  jira_get_backlog: { boardId: 1 },
  jira_move_to_sprint: { sprintId: 1, issues: [KEY] },
  jira_move_to_backlog: { issues: [KEY] },
  jira_create_sprint: { name: 'Sprint 1', originBoardId: 1 },
  jira_start_sprint: {
    sprintId: 1,
    startDate: '2026-01-01T09:00:00.000+00:00',
    endDate: '2026-01-15T09:00:00.000+00:00',
  },
  jira_close_sprint: { sprintId: 1 },
  jira_update_sprint: { sprintId: 1, name: 'Sprint 2' },
  jira_rank_issues: { issues: [KEY], rankBeforeIssue: 'ABC-2' },
  jira_set_estimate: { issue: KEY, boardId: 1, value: 3 },
  jira_sprint_summary: { sprintId: 1 },
  // portfolio
  jira_portfolio_analyze: { jql: 'project = ABC' },
  jira_portfolio_report: { jql: 'project = ABC' },
};

/**
 * What every read a PLAN makes answers: enough of an entity for the plan to
 * describe it. Only the plan reads it — the aborted apply below must never
 * reach the wire to see it.
 */
const PLAN_READ = {
  id: '10',
  key: KEY,
  name: 'Thing',
  jql: 'project = ABC',
  filename: 'notes.txt',
  accountId: 'abc',
  inwardIssue: { id: '1', key: KEY },
  outwardIssue: { id: '2', key: 'ABC-2' },
};

/** The plans whose reads need a different shape than {@link PLAN_READ}. */
const PLAN_READS: Readonly<Record<string, unknown>> = {
  jira_transition_issue: { transitions: [{ id: '31', name: 'Done' }] },
  jira_delete_remote_link: { ...PLAN_READ, id: 10 },
  jira_delete_component: { ...PLAN_READ, id: 10 },
  jira_delete_version: { ...PLAN_READ, id: 10 },
  jira_delete_sprint: { ...PLAN_READ, id: 10 },
};

function buildRegistry(jira: ReturnType<typeof createJiraRequest>) {
  const media = createMemoryMedia();
  media.files.set('notes.txt', new TextEncoder().encode('hello'));
  // The byte-moving attachment tools and the report tool need a store; the
  // manifest binds them to JIRA_MEDIA_DIR / JIRA_REPORT_DIR, so swap in stores
  // held in memory. A tool refused for config would prove nothing.
  const reports: ReportStore = {
    dir: '/reports',
    write: (name, text) =>
      Promise.resolve({ name, path: `/reports/${name}`, bytes: text.length }),
  };
  const packages = createPackages(() => {
    throw new Error('the capabilities report is not under test');
  }).map((pkg) => {
    if (pkg.id === 'attachments') return createAttachmentsPackage({ store: media });
    if (pkg.id === 'portfolio') return createPortfolioPackage({ store: reports });
    return pkg;
  });
  return createRegistry(packages, {
    settings: SETTINGS,
    jira,
    logger: createFakeLogger(),
    clock: createFakeClock(1_700_000_000_000),
    rng: RNG,
    redactor: createFakeRedactor(),
    media,
  });
}

type Registry = ReturnType<typeof buildRegistry>;

function realClient(): ReturnType<typeof createJiraRequest> {
  const clock = createFakeClock(1_700_000_000_000);
  return createJiraRequest({
    credentials: {
      kind: 'basic',
      host: SITE,
      email: 'me@example.com',
      apiToken: 'not-a-real-token',
    },
    clock,
    rng: RNG,
    logger: createFakeLogger({ clock }),
    allowedHosts: SETTINGS.allowedHosts,
  });
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

test('CC-5350: the argument table names every registered tool, and only those', () => {
  const registry = buildRegistry(realClient());
  const registered = registry.tools.map((tool) => tool.name).sort();
  assert.deepEqual(Object.keys(ARGS).sort(), registered);
  for (const tool of registry.tools) {
    const parsed = tool.input.safeParse(ARGS[tool.name]);
    assert.ok(parsed.success, `${tool.name}: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

/**
 * Whether a result is the caller-cancelled answer: the `transport` envelope, or
 * a paged read that stopped before its first page and says so (`stopReason:
 * "aborted"`, `partial: true`) — the paging contract keeps what it already had.
 */
function isCancelled(result: Awaited<ReturnType<Registry['call']>>): boolean {
  const { ok, error, data } = result.structuredContent;
  if (!ok)
    return error?.kind === 'transport' && /cancelled by the caller/u.test(error.message);
  return JSON.stringify(data).includes('"stopReason":"aborted"');
}

/**
 * Plan a write with a live signal, so the apply below has a plan_id to spend.
 * Returns the id, or the rendered refusal when the plan itself failed.
 */
async function planOf(
  registry: Registry,
  name: string,
): Promise<{ planId: string } | { refusal: string }> {
  return withFetch(async (mock) => {
    mock.fallback({ status: 200, json: PLAN_READS[name] ?? PLAN_READ });
    const plan = await registry.call(name, ARGS[name]);
    const planId = (plan.structuredContent.data as { plan_id?: unknown } | undefined)
      ?.plan_id;
    return typeof planId === 'string' ? { planId } : { refusal: plan.text.slice(-400) };
  });
}

test('CC-5350: every tool called with an aborted signal sends nothing and reports the cancel', async () => {
  const registry = buildRegistry(realClient());
  assert.ok(registry.tools.length > 0);
  const failures: string[] = [];
  for (const tool of registry.tools) {
    let args = ARGS[tool.name];
    // A write is cancelled on its APPLY path — the one that would mutate — so
    // it is planned first, unaborted, and then applied with the dead signal.
    if (tool.writeTier !== undefined) {
      const plan = await planOf(registry, tool.name);
      if ('refusal' in plan) {
        failures.push(`${tool.name}: could not plan: ${plan.refusal}`);
        continue;
      }
      args = { ...args, apply: true, plan_id: plan.planId };
    }
    await withFetch(async (mock) => {
      mock.fallback({ status: 200, json: {} });
      const result = await registry.call(tool.name, args, { signal: abortedSignal() });
      const sent = mock.requests.length;
      if (sent > 0) {
        failures.push(`${tool.name}: sent ${String(sent)} request(s) after the abort`);
        return;
      }
      if (LOCAL_TOOLS.has(tool.name)) return;
      if (!isCancelled(result))
        failures.push(
          `${tool.name}: ${JSON.stringify(result.structuredContent).slice(0, 600)}`,
        );
    });
  }
  assert.deepEqual(failures, []);
});
