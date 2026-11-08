// The JIRA_PROJECTS scope matrix over the real catalogue (D400, V3-33, QA-R3).
//
// `project-scope.test.ts` proves the guard route by route. This file proves it
// TOOL by tool: every tool in `PACKAGES` runs through the real registry, the
// real write gate and its real handler, against a small recorded Jira world in
// which project ABC is in scope and project XYZ is not. Each scoped tool runs
// three ways:
//
//   * in scope        — every reference is in ABC: a write is planned, then
//                       applied, and its mutation reaches the network; a read
//                       answers `ok`;
//   * out of scope    — one reference is in XYZ (by key prefix, by numeric id,
//                       or an ABC key that moved to XYZ): refused as
//                       `permission` before any mutation, and the refusal names
//                       the offending reference and its project;
//   * unresolved      — one reference resolves to no project (an issue with no
//                       project field, a board with no location, …): refused
//                       the same way (fail closed), naming the reference.
//
// The matrix iterates the catalogue, so a tool added to `PACKAGES` without a
// row here — or without an entry in one of the explicit exemption lists —
// fails the first test.
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
import { createJiraError } from '../core/errors.js';
import { JIRA_ROOT_PATHS } from '../core/types.js';
import type {
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  Rng,
  Settings,
} from '../core/types.js';
import { createRegistry } from '../mcp/registry.js';
import type { PackageSpec } from '../mcp/types.js';
import { createMemoryMedia } from '../testing/memory-media.js';
import { createAttachmentsPackage } from './attachments.js';
import { PACKAGES } from './index.js';
import { createPortfolioPackage } from './portfolio.js';

// ---------------------------------------------------------------------------
// The world: ABC is in scope, XYZ is not
// ---------------------------------------------------------------------------

interface IssueFacts {
  readonly id: string;
  /** `undefined` — the issue answers with no project field (unresolvable). */
  readonly project: string | undefined;
}

const ISSUES: Readonly<Record<string, IssueFacts>> = {
  'ABC-1': { id: '10001', project: 'ABC' },
  'ABC-2': { id: '10002', project: 'ABC' },
  // An issue moved from ABC to XYZ still answers to its old key.
  'ABC-7': { id: '10007', project: 'XYZ' },
  'ABC-9': { id: '10009', project: undefined },
  'XYZ-1': { id: '20001', project: 'XYZ' },
};

const PROJECT_IDS: Readonly<Record<string, string>> = { ABC: '1000', XYZ: '2000' };
const BOARDS: Readonly<Record<string, string | undefined>> = {
  '1': 'ABC',
  '2': 'XYZ',
  '9': undefined,
};
const SPRINTS: Readonly<Record<string, string | undefined>> = {
  '11': '1',
  '12': '2',
  '19': undefined,
};
const COMPONENTS: Readonly<Record<string, string | undefined>> = {
  '101': 'ABC',
  '102': 'XYZ',
  '109': undefined,
};
const VERSIONS: Readonly<Record<string, string | undefined>> = {
  '201': '1000',
  '202': '2000',
  '209': undefined,
};
const LINKS: Readonly<Record<string, readonly [string, string] | undefined>> = {
  '301': ['ABC-1', 'ABC-2'],
  '302': ['ABC-1', 'XYZ-1'],
  '309': undefined,
};

const ISSUE_BY_ID = new Map(Object.entries(ISSUES).map(([key, f]) => [f.id, key]));
const PROJECT_BY_ID = new Map(Object.entries(PROJECT_IDS).map(([k, id]) => [id, k]));

function notFound(what: string): never {
  throw createJiraError({ kind: 'not_found', reason: `${what} does not exist.` });
}

function issueKeyOf(ref: string): string {
  const key = ISSUE_BY_ID.get(ref) ?? ref.toUpperCase();
  if (ISSUES[key] === undefined) notFound(`Issue ${ref}`);
  return key;
}

function issueBody(ref: string): Record<string, unknown> {
  const key = issueKeyOf(ref);
  const facts = ISSUES[key] ?? notFound(`Issue ${ref}`);
  return {
    id: facts.id,
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { id: '10000', name: 'Task' },
      labels: [],
      ...(facts.project === undefined
        ? {}
        : { project: { id: PROJECT_IDS[facts.project], key: facts.project } }),
    },
  };
}

function projectBody(ref: string): Record<string, unknown> {
  const key = PROJECT_BY_ID.get(ref) ?? ref.toUpperCase();
  const id = PROJECT_IDS[key];
  // An unknown numeric id answers with no key: unresolvable, not absent.
  if (id === undefined)
    return /^\d+$/.test(ref) ? { id: ref } : notFound(`Project ${ref}`);
  return { id, key, name: `Project ${key}`, issueTypes: [{ id: '10000', name: 'Task' }] };
}

const EMPTY_PAGE = { values: [], startAt: 0, maxResults: 50, total: 0, isLast: true };

/** The issues a `issuekey in (…)` search names, as Jira returns them. */
function searchBody(jql: string): Record<string, unknown> {
  const match = /issuekey in \(([^)]*)\)/.exec(jql);
  if (match === null) return { issues: [], isLast: true };
  const refs = (match[1] ?? '').split(',').map((s) => JSON.parse(s.trim()) as string);
  const issues = refs
    .map((ref) => ISSUE_BY_ID.get(ref) ?? ref.toUpperCase())
    .filter((key) => ISSUES[key] !== undefined)
    .map((key) => issueBody(key));
  return { issues, isLast: true };
}

/** One answer per route; `undefined` falls through to the generic answers. */
function answer(req: JiraRequestSpec): unknown {
  const seg = req.path
    .split('/')
    .slice(1)
    .map((s) => decodeURIComponent(s));
  const [head, second, third] = seg;
  const read = req.method === 'GET';
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (req.root === 'agile' || req.root === 'software') {
    if (head === 'board' && second !== undefined && third === undefined && read) {
      if (!(second in BOARDS)) notFound(`Board ${second}`);
      const key = BOARDS[second];
      return {
        id: Number(second),
        name: `Board ${second}`,
        type: 'scrum',
        ...(key === undefined ? {} : { location: { projectKey: key } }),
      };
    }
    if (head === 'board' && second === undefined) {
      return {
        ...EMPTY_PAGE,
        values: [
          { id: 1, name: 'B1', type: 'scrum', location: { projectKey: 'ABC' } },
          { id: 2, name: 'B2', type: 'scrum', location: { projectKey: 'XYZ' } },
        ],
      };
    }
    if (head === 'board' && third === 'configuration') {
      return { id: Number(second), name: 'B', columnConfig: { columns: [] } };
    }
    if (head === 'board' && (third === 'backlog' || third === 'issue'))
      return { issues: [], startAt: 0, maxResults: 50, total: 0 };
    if (head === 'sprint' && second !== undefined && third === undefined && read) {
      if (!(second in SPRINTS)) notFound(`Sprint ${second}`);
      const board = SPRINTS[second];
      return {
        id: Number(second),
        name: `Sprint ${second}`,
        state: 'future',
        ...(board === undefined ? {} : { originBoardId: Number(board) }),
      };
    }
    if (head === 'sprint' && third === 'issue' && read)
      return { issues: [], startAt: 0, maxResults: 50, total: 0 };
    if (head === 'board' && third === 'sprint') return EMPTY_PAGE;
    if (!read)
      return req.method === 'POST' && head === 'sprint'
        ? { id: 13, name: 'S', state: 'future', originBoardId: 1 }
        : {};
    return EMPTY_PAGE;
  }

  switch (head) {
    case 'issue': {
      if (second === undefined) return { id: '10003', key: 'ABC-3' };
      if (second === 'createmeta') return { issueTypes: [], values: [] };
      if (third === undefined) return read ? issueBody(second) : {};
      if (third === 'transitions')
        return read
          ? { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] }
          : {};
      if (third === 'comment') {
        if (!read) return { id: '1', body: { type: 'doc', version: 1, content: [] } };
        return seg[3] === undefined
          ? { comments: [], startAt: 0, maxResults: 50, total: 0 }
          : { id: seg[3], body: { type: 'doc', version: 1, content: [] } };
      }
      if (third === 'worklog') {
        if (!read) return { id: '1', timeSpentSeconds: 3600 };
        return seg[3] === undefined
          ? { worklogs: [], startAt: 0, maxResults: 50, total: 0 }
          : { id: seg[3], timeSpentSeconds: 3600 };
      }
      if (third === 'changelog') return { ...EMPTY_PAGE };
      if (third === 'remotelink') {
        if (!read) return { id: 1, self: 'https://x/1' };
        return seg[3] === undefined ? [] : { id: Number(seg[3]), object: { title: 't' } };
      }
      if (third === 'watchers') return read ? { watchers: [], watchCount: 0 } : {};
      if (third === 'votes') return read ? { votes: 0, hasVoted: false } : {};
      if (third === 'attachments') return read ? [] : [{ id: '501', filename: 'f.txt' }];
      return read ? {} : {};
    }
    case 'search': {
      if (second === 'approximate-count') return { count: 0 };
      const jql = body['jql'] ?? req.query?.['jql'];
      return searchBody(typeof jql === 'string' ? jql : '');
    }
    case 'project': {
      if (second === undefined || second === 'search')
        return {
          ...EMPTY_PAGE,
          values: [
            { id: '1000', key: 'ABC', name: 'Project ABC' },
            { id: '2000', key: 'XYZ', name: 'Project XYZ' },
          ],
        };
      if (third === undefined) return projectBody(second);
      if (third === 'role') return {};
      return third === 'components' || third === 'versions' ? [] : EMPTY_PAGE;
    }
    case 'component': {
      if (second === undefined) return { id: '103', name: 'c', project: 'ABC' };
      if (!(second in COMPONENTS)) notFound(`Component ${second}`);
      const key = COMPONENTS[second];
      if (!read) return { id: second, name: 'n', project: 'ABC' };
      return {
        id: second,
        name: `Component ${second}`,
        ...(key === undefined
          ? {}
          : { project: key, projectId: Number(PROJECT_IDS[key]) }),
      };
    }
    case 'version': {
      if (second === undefined) return { id: '203', name: 'v', projectId: 1000 };
      if (!(second in VERSIONS)) notFound(`Version ${second}`);
      const projectId = VERSIONS[second];
      if (!read) return { id: second, name: 'n', projectId: 1000 };
      return {
        id: second,
        name: `Version ${second}`,
        ...(projectId === undefined ? {} : { projectId: Number(projectId) }),
      };
    }
    case 'issueLink': {
      if (second === undefined) return {};
      if (!(second in LINKS)) notFound(`Issue link ${second}`);
      const ends = LINKS[second];
      if (!read) return {};
      return {
        id: second,
        type: { name: 'Blocks' },
        ...(ends === undefined
          ? {}
          : { inwardIssue: { key: ends[0] }, outwardIssue: { key: ends[1] } }),
      };
    }
    case 'issueLinkType':
      return {
        issueLinkTypes: [
          { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        ],
      };
    case 'changelog':
      return { issueChangeLogs: [] };
    case 'mypermissions':
      return { permissions: {} };
    case 'user':
      return [];
    case 'statuses':
      return { ...EMPTY_PAGE };
    case 'bulk':
      return read ? {} : { taskId: '10000' };
    case 'myself':
      return { accountId: 'acc-me', displayName: 'Me' };
    case 'field':
      return [];
    case undefined:
    default:
      return read ? EMPTY_PAGE : {};
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

function isMutation(req: JiraRequestSpec): boolean {
  return req.method !== 'GET' && req.safe !== true;
}

function routeOf(req: JiraRequestSpec): string {
  return `${req.method} ${JIRA_ROOT_PATHS[req.root ?? 'v3']}${req.path}`;
}

// ---------------------------------------------------------------------------
// The registry under test
// ---------------------------------------------------------------------------

const SETTINGS: Settings = {
  allowedHosts: [],
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
  projects: ['ABC'],
  ...FAKE_AUTH_SETTINGS,
};

function countingRng(): Rng {
  let n = 1;
  return (): number => {
    n += 1;
    return (n % 4096) / 4096;
  };
}

let reportDir: string | undefined;

async function manifest(): Promise<readonly PackageSpec[]> {
  reportDir ??= await mkdtemp(join(tmpdir(), 'jira-mcp-scope-matrix-'));
  const media = createMemoryMedia();
  media.files.set('f.txt', new TextEncoder().encode('hello'));
  return PACKAGES.map((pkg) => {
    if (pkg.id === 'attachments') return createAttachmentsPackage({ store: media });
    if (pkg.id === 'portfolio') return createPortfolioPackage({ reportDir });
    return pkg;
  });
}

test.after(async () => {
  if (reportDir !== undefined) await rm(reportDir, { recursive: true, force: true });
});

interface Outcome {
  readonly ok: boolean;
  readonly kind: string | undefined;
  readonly message: string;
  readonly data: unknown;
  readonly world: World;
}

async function run(tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const world = createWorld();
  const registry = createRegistry(await manifest(), {
    settings: SETTINGS,
    jira: world.seam,
    logger: createFakeLogger(),
    clock: createFakeClock(1_000),
    rng: countingRng(),
    redactor: createFakeRedactor([]),
  });
  const first = await registry.call(tool, args);
  const content = first.structuredContent as {
    ok: boolean;
    data?: { plan_id?: string; executed?: boolean };
    error?: { kind: string; message: string };
  };
  const planId = content.data?.plan_id;
  const spec = registry.get(tool);
  if (!content.ok || spec?.writeTier === undefined || planId === undefined) {
    return {
      ok: content.ok,
      kind: content.error?.kind,
      message: content.error?.message ?? '',
      data: content.data,
      world,
    };
  }
  const applied = await registry.call(tool, { ...args, apply: true, plan_id: planId });
  const out = applied.structuredContent as typeof content;
  return {
    ok: out.ok,
    kind: out.error?.kind,
    message: out.error?.message ?? '',
    data: out.data,
    world,
  };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

interface Variant {
  /** What the variant changes, for the test name. */
  readonly label: string;
  readonly args: Args;
  /** Every string the refusal must contain: the reference and its project. */
  readonly names: readonly string[];
}

interface Row {
  readonly args: Args;
  readonly out: readonly Variant[];
  readonly unresolved: readonly Variant[];
}

const outIssue = (issue: Args = {}): Variant[] => [
  { label: 'issue in XYZ', args: { ...issue, issue: 'XYZ-1' }, names: ['XYZ-1', 'XYZ'] },
  {
    label: 'issue moved to XYZ',
    args: { ...issue, issue: 'ABC-7' },
    names: ['ABC-7', 'project XYZ'],
  },
];
const ghostIssue = (issue: Args = {}): Variant[] => [
  {
    label: 'issue without a project',
    args: { ...issue, issue: 'ABC-9' },
    names: ['ABC-9'],
  },
];

/** A tool whose only scope anchor is `issue`. */
function issueRow(extra: Args = {}): Row {
  return {
    args: { issue: 'ABC-1', ...extra },
    out: outIssue(extra),
    unresolved: ghostIssue(extra),
  };
}

const START = '2026-11-02T09:00:00.000Z';
const END = '2026-11-16T17:00:00.000Z';

function sprintRow(extra: Args = {}): Row {
  return {
    args: { sprintId: 11, ...extra },
    out: [
      {
        label: 'sprint on an XYZ board',
        args: { ...extra, sprintId: 12 },
        names: ['Sprint 12', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'sprint without a board',
        args: { ...extra, sprintId: 19 },
        names: ['Sprint 19'],
      },
    ],
  };
}

function boardRow(extra: Args = {}): Row {
  return {
    args: { boardId: 1, ...extra },
    out: [
      {
        label: 'board in XYZ',
        args: { ...extra, boardId: 2 },
        names: ['Board 2', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'board without a location',
        args: { ...extra, boardId: 9 },
        names: ['Board 9'],
      },
    ],
  };
}

function projectRow(field: string, extra: Args = {}, inScope = 'ABC'): Row {
  return {
    args: { [field]: inScope, ...extra },
    out: [
      {
        label: 'project XYZ by key',
        args: { ...extra, [field]: 'XYZ' },
        names: ['"XYZ"', 'XYZ'],
      },
      {
        label: 'project XYZ by id',
        args: { ...extra, [field]: '2000' },
        names: ['"2000"', 'project XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'project id without a key',
        args: { ...extra, [field]: '9000' },
        names: ['"9000"'],
      },
    ],
  };
}

/** Many issues: one out-of-scope by prefix, one moved, one unresolvable. */
function issuesRow(extra: Args = {}): Row {
  return {
    args: { issues: ['ABC-1', 'ABC-2'], ...extra },
    out: [
      {
        label: 'one issue in XYZ',
        args: { ...extra, issues: ['ABC-1', 'XYZ-1'] },
        names: ['XYZ-1', 'XYZ'],
      },
      {
        label: 'one issue moved to XYZ',
        args: { ...extra, issues: ['ABC-1', 'ABC-7'] },
        names: ['ABC-7', 'project XYZ'],
      },
      {
        label: 'a single issue in XYZ',
        args: { ...extra, issues: ['XYZ-1'] },
        names: ['XYZ-1', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'one issue without a project',
        args: { ...extra, issues: ['ABC-1', 'ABC-9'] },
        names: ['ABC-9'],
      },
    ],
  };
}

/** Every write tool and every read that names a project, issue, board or sprint. */
const MATRIX: Readonly<Record<string, Row>> = {
  // --- core / search -------------------------------------------------------
  jira_get_my_permissions: {
    args: { permissions: ['BROWSE_PROJECTS'], project: 'ABC', issue: 'ABC-1' },
    out: [
      {
        label: 'project XYZ',
        args: { permissions: ['BROWSE_PROJECTS'], project: 'XYZ' },
        names: ['"XYZ"'],
      },
      {
        label: 'issue in XYZ',
        args: { permissions: ['BROWSE_PROJECTS'], issue: 'XYZ-1' },
        names: ['XYZ-1', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'issue without a project',
        args: { permissions: ['BROWSE_PROJECTS'], issue: 'ABC-9' },
        names: ['ABC-9'],
      },
    ],
  },

  // --- issues (reads) ------------------------------------------------------
  jira_get_issue: issueRow(),
  jira_get_comments: issueRow(),
  jira_get_transitions: issueRow(),
  jira_get_changelog: issueRow(),
  jira_get_changelogs_bulk: issuesRow(),
  jira_get_worklogs: issueRow(),
  jira_get_remote_links: issueRow(),

  // --- issues-write --------------------------------------------------------
  jira_create_issue: {
    args: { project: 'ABC', issueType: 'Task', summary: 's', parent: 'ABC-2' },
    out: [
      {
        label: 'project XYZ',
        args: { project: 'XYZ', issueType: 'Task', summary: 's' },
        names: ['"XYZ"'],
      },
      {
        label: 'parent in XYZ',
        args: { project: 'ABC', issueType: 'Task', summary: 's', parent: 'XYZ-1' },
        names: ['XYZ-1', 'XYZ'],
      },
      {
        label: 'parent moved to XYZ',
        args: { project: 'ABC', issueType: 'Task', summary: 's', parent: 'ABC-7' },
        names: ['ABC-7', 'project XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'parent without a project',
        args: { project: 'ABC', issueType: 'Task', summary: 's', parent: 'ABC-9' },
        names: ['ABC-9'],
      },
    ],
  },
  jira_update_issue: {
    ...issueRow({ summary: 'new' }),
    out: [
      ...outIssue({ summary: 'new' }),
      {
        label: 'parent in XYZ',
        args: { issue: 'ABC-1', parent: 'XYZ-1' },
        names: ['XYZ-1', 'XYZ'],
      },
      {
        label: 'parent moved to XYZ',
        args: { issue: 'ABC-1', parent: 'ABC-7' },
        names: ['ABC-7', 'project XYZ'],
      },
    ],
  },
  jira_transition_issue: issueRow({ transition: 'Done' }),
  jira_add_comment: issueRow({ body: 'hello' }),
  jira_update_comment: issueRow({ commentId: '1', body: 'hello' }),
  jira_assign_issue: issueRow({ accountId: 'acc-1' }),
  jira_add_worklog: issueRow({ timeSpent: '1h' }),
  jira_update_worklog: issueRow({ worklogId: '1', timeSpent: '1h' }),
  jira_link_issues: {
    args: { linkType: 'Blocks', inwardIssue: 'ABC-1', outwardIssue: 'ABC-2' },
    out: [
      {
        label: 'outward in XYZ',
        args: { linkType: 'Blocks', inwardIssue: 'ABC-1', outwardIssue: 'XYZ-1' },
        names: ['XYZ-1', 'XYZ'],
      },
      {
        label: 'inward moved to XYZ',
        args: { linkType: 'Blocks', inwardIssue: 'ABC-7', outwardIssue: 'ABC-2' },
        names: ['ABC-7', 'project XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'outward without a project',
        args: { linkType: 'Blocks', inwardIssue: 'ABC-1', outwardIssue: 'ABC-9' },
        names: ['ABC-9'],
      },
    ],
  },
  jira_add_remote_link: issueRow({ url: 'https://example.com/a', title: 'A' }),

  // --- issues-delete -------------------------------------------------------
  jira_delete_issue: issueRow(),
  jira_delete_comment: issueRow({ commentId: '1' }),
  jira_delete_worklog: issueRow({ worklogId: '1' }),
  jira_unlink_issues: {
    args: { linkId: '301' },
    out: [
      {
        label: 'link with an end in XYZ',
        args: { linkId: '302' },
        names: ['XYZ-1', 'XYZ'],
      },
    ],
    unresolved: [
      { label: 'link without ends', args: { linkId: '309' }, names: ['Issue link 309'] },
    ],
  },
  jira_delete_remote_link: issueRow({ linkId: '1' }),
  jira_delete_component: {
    args: { componentId: '101' },
    out: [
      {
        label: 'component in XYZ',
        args: { componentId: '102' },
        names: ['Component 102', 'XYZ'],
      },
      {
        label: 'moveIssuesTo in XYZ',
        args: { componentId: '101', moveIssuesTo: '102' },
        names: ['Component 102', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'component without a project',
        args: { componentId: '109' },
        names: ['Component 109'],
      },
    ],
  },
  jira_delete_version: {
    args: { versionId: '201' },
    out: [
      {
        label: 'version in XYZ',
        args: { versionId: '202' },
        names: ['Version 202', 'XYZ'],
      },
      {
        label: 'moveFixIssuesTo in XYZ',
        args: { versionId: '201', moveFixIssuesTo: '202' },
        names: ['Version 202', 'XYZ'],
      },
      {
        label: 'moveAffectedIssuesTo in XYZ',
        args: { versionId: '201', moveAffectedIssuesTo: '202' },
        names: ['Version 202', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'version without a project',
        args: { versionId: '209' },
        names: ['Version 209'],
      },
    ],
  },
  jira_delete_sprint: sprintRow(),
  jira_bulk_delete_issues: issuesRow(),
  jira_bulk_edit_issues: issuesRow({ labels: ['x'], labelsAction: 'ADD' }),

  // --- attachments ---------------------------------------------------------
  jira_list_attachments: issueRow(),
  jira_upload_attachment: issueRow({ name: 'f.txt' }),

  // --- collab --------------------------------------------------------------
  jira_list_watchers: issueRow(),
  jira_add_watcher: issueRow({ accountId: 'acc-1' }),
  jira_remove_watcher: issueRow({ accountId: 'acc-1' }),
  jira_add_vote: issueRow(),
  jira_remove_vote: issueRow(),
  jira_list_components: projectRow('project'),
  jira_create_component: projectRow('project', { name: 'c' }),
  jira_update_component: {
    args: { componentId: '101', name: 'n' },
    out: [
      {
        label: 'component in XYZ',
        args: { componentId: '102', name: 'n' },
        names: ['Component 102', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'component without a project',
        args: { componentId: '109', name: 'n' },
        names: ['Component 109'],
      },
    ],
  },
  jira_list_versions: projectRow('project'),
  jira_create_version: {
    ...projectRow('projectId', { name: 'v' }, '1000'),
    // `projectId` is numeric-only in the schema, so there is no by-key variant.
    out: projectRow('projectId', { name: 'v' }).out.filter((v) =>
      v.label.endsWith('by id'),
    ),
  },
  jira_update_version: {
    args: { versionId: '201', name: 'n' },
    out: [
      {
        label: 'version in XYZ',
        args: { versionId: '202', name: 'n' },
        names: ['Version 202', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'version without a project',
        args: { versionId: '209', name: 'n' },
        names: ['Version 209'],
      },
    ],
  },
  jira_list_project_roles: projectRow('project'),

  // --- meta / users --------------------------------------------------------
  jira_get_project: projectRow('project'),
  jira_get_create_meta: projectRow('project'),
  jira_list_statuses: {
    args: { projectId: '1000' },
    out: [
      {
        label: 'project XYZ by id',
        args: { projectId: '2000' },
        names: ['"2000"', 'project XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'project id without a key',
        args: { projectId: '9000' },
        names: ['"9000"'],
      },
    ],
  },
  jira_search_users: {
    args: { query: 'ann', project: 'ABC' },
    out: [
      { label: 'project XYZ', args: { query: 'ann', project: 'XYZ' }, names: ['"XYZ"'] },
      {
        label: 'issue in XYZ',
        args: { query: 'ann', issue: 'XYZ-1' },
        names: ['XYZ-1', 'XYZ'],
      },
      {
        label: 'issue moved to XYZ',
        args: { query: 'ann', issue: 'ABC-7' },
        names: ['ABC-7', 'project XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'issue without a project',
        args: { query: 'ann', issue: 'ABC-9' },
        names: ['ABC-9'],
      },
    ],
  },

  // --- agile ---------------------------------------------------------------
  jira_get_board_config: boardRow(),
  jira_list_sprints: boardRow(),
  jira_get_sprint_issues: sprintRow(),
  jira_get_backlog: boardRow(),
  jira_move_to_sprint: {
    args: { sprintId: 11, issues: ['ABC-1', 'ABC-2'] },
    out: [
      {
        label: 'sprint on an XYZ board',
        args: { sprintId: 12, issues: ['ABC-1'] },
        names: ['Sprint 12', 'XYZ'],
      },
      ...issuesRow({ sprintId: 11 }).out,
    ],
    unresolved: [
      {
        label: 'sprint without a board',
        args: { sprintId: 19, issues: ['ABC-1'] },
        names: ['Sprint 19'],
      },
      ...issuesRow({ sprintId: 11 }).unresolved,
    ],
  },
  jira_move_to_backlog: issuesRow(),
  jira_create_sprint: {
    args: { name: 'S', originBoardId: 1 },
    out: [
      {
        label: 'board in XYZ',
        args: { name: 'S', originBoardId: 2 },
        names: ['Board 2', 'XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'board without a location',
        args: { name: 'S', originBoardId: 9 },
        names: ['Board 9'],
      },
    ],
  },
  jira_start_sprint: sprintRow({ startDate: START, endDate: END }),
  jira_close_sprint: sprintRow(),
  jira_update_sprint: sprintRow({ name: 'renamed' }),
  jira_rank_issues: {
    args: { issues: ['ABC-1'], rankBeforeIssue: 'ABC-2' },
    out: [
      {
        label: 'ranked issue in XYZ',
        args: { issues: ['XYZ-1'], rankBeforeIssue: 'ABC-2' },
        names: ['XYZ-1', 'XYZ'],
      },
      {
        label: 'before-anchor in XYZ',
        args: { issues: ['ABC-1'], rankBeforeIssue: 'XYZ-1' },
        names: ['XYZ-1', 'XYZ'],
      },
      {
        label: 'after-anchor moved to XYZ',
        args: { issues: ['ABC-1'], rankAfterIssue: 'ABC-7' },
        names: ['ABC-7', 'project XYZ'],
      },
    ],
    unresolved: [
      {
        label: 'anchor without a project',
        args: { issues: ['ABC-1'], rankBeforeIssue: 'ABC-9' },
        names: ['ABC-9'],
      },
    ],
  },
  jira_set_estimate: {
    args: { issue: 'ABC-1', boardId: 1, value: '1h' },
    out: [
      ...outIssue({ boardId: 1, value: '1h' }),
      {
        label: 'board in XYZ',
        args: { issue: 'ABC-1', boardId: 2, value: '1h' },
        names: ['Board 2', 'XYZ'],
      },
    ],
    unresolved: [
      ...ghostIssue({ boardId: 1, value: '1h' }),
      {
        label: 'board without a location',
        args: { issue: 'ABC-1', boardId: 9, value: '1h' },
        names: ['Board 9'],
      },
    ],
  },
  jira_sprint_summary: sprintRow(),
};

/**
 * Tools whose JQL or list result is confined rather than refused: every
 * search they send carries the project clause, and every list they return is
 * filtered to ABC.
 */
const CONFINED: Readonly<Record<string, Args>> = {
  jira_search: { jql: 'project = XYZ' },
  jira_count: { jql: 'project = XYZ' },
  jira_list_projects: {},
  jira_list_boards: {},
  jira_portfolio_analyze: { projects: ['ABC', 'XYZ'] },
  jira_portfolio_report: { projects: ['ABC', 'XYZ'] },
};

/** Jira's attachment metadata names no issue, so these always refuse (D400). */
const ALWAYS_REFUSED: Readonly<Record<string, Args>> = {
  jira_delete_attachment: { attachmentId: '501' },
  jira_download_attachment: { attachmentId: '501' },
};

/** Tools with nothing project-shaped to scope, and why. */
const EXEMPT: Readonly<Record<string, string>> = {
  jira_capabilities: 'local; sends no request',
  jira_get_myself: 'the caller, not a project',
  jira_parse_jql: 'parses JQL without running it',
  jira_get_bulk_status: 'a bulk task by id; the bulk request was scoped when submitted',
  jira_list_filters: 'filters are site-wide objects',
  jira_get_filter: 'filters are site-wide objects',
  jira_create_filter:
    'filters are site-wide; running one goes through the confined search',
  jira_update_filter:
    'filters are site-wide; running one goes through the confined search',
  jira_list_fields: 'site-wide metadata',
  jira_list_link_types: 'site-wide metadata',
  jira_list_priorities: 'site-wide metadata',
  jira_list_resolutions: 'site-wide metadata',
  jira_list_issue_types: 'site-wide metadata',
  jira_list_labels: 'site-wide metadata',
  jira_get_timetracking_config: 'site-wide metadata',
};

const CATALOGUE = PACKAGES.flatMap((pkg) => pkg.tools);
const WRITES: ReadonlySet<string> = new Set<string>(
  CATALOGUE.filter((t) => t.writeTier !== undefined).map((t) => t.name),
);

// ---------------------------------------------------------------------------
// Catalogue coverage
// ---------------------------------------------------------------------------

test('CC-5154: every catalogue tool has exactly one matrix row or exemption', () => {
  const lists: Record<string, readonly string[]> = {
    MATRIX: Object.keys(MATRIX),
    CONFINED: Object.keys(CONFINED),
    ALWAYS_REFUSED: Object.keys(ALWAYS_REFUSED),
    EXEMPT: Object.keys(EXEMPT),
  };
  const seen = new Map<string, string>();
  for (const [list, names] of Object.entries(lists)) {
    for (const name of names) {
      assert.equal(
        seen.get(name),
        undefined,
        `${name} is in ${list} and ${seen.get(name) ?? ''}`,
      );
      seen.set(name, list);
    }
  }
  const catalogue: readonly string[] = CATALOGUE.map((t) => t.name);
  const missing = catalogue.filter((name) => !seen.has(name));
  assert.deepEqual(missing, [], 'add a MATRIX row (or a reasoned exemption) for each');
  const stale = [...seen.keys()].filter((name) => !catalogue.includes(name));
  assert.deepEqual(stale, [], 'rows for tools that are no longer in the catalogue');
});

test('CC-5155: only filters are exempt among the writes, and every other write has all three columns', () => {
  const exemptWrites = Object.keys(EXEMPT).filter((name) => WRITES.has(name));
  assert.deepEqual(exemptWrites.sort(), ['jira_create_filter', 'jira_update_filter']);
  for (const name of WRITES) {
    if (name in EXEMPT || name in ALWAYS_REFUSED) continue;
    const row = MATRIX[name];
    assert.ok(row !== undefined, `${name} has a matrix row`);
    assert.ok(row.out.length > 0, `${name} has an out-of-scope case`);
    assert.ok(row.unresolved.length > 0, `${name} has an unresolved case`);
  }
});

// ---------------------------------------------------------------------------
// The three columns
// ---------------------------------------------------------------------------

async function assertRefused(
  tool: string,
  variant: Variant,
  unresolved: boolean,
): Promise<void> {
  const outcome = await run(tool, variant.args);
  assert.equal(outcome.ok, false, `${tool} must be refused`);
  assert.equal(outcome.kind, 'permission', outcome.message);
  assert.match(outcome.message, /JIRA_PROJECTS: ABC/);
  for (const name of variant.names) {
    assert.ok(
      outcome.message.includes(name),
      `the refusal names ${name}: ${outcome.message}`,
    );
  }
  if (unresolved) assert.match(outcome.message, /could not be resolved to a project/);
  assert.deepEqual(
    outcome.world.calls.filter(isMutation).map(routeOf),
    [],
    'no mutation reached Jira',
  );
}

for (const [tool, row] of Object.entries(MATRIX)) {
  const write = WRITES.has(tool);

  test(`CC-5156: ${tool} in scope ${write ? 'plans, applies and reaches Jira' : 'answers'}`, async () => {
    const outcome = await run(tool, row.args);
    assert.equal(outcome.ok, true, `${tool}: ${outcome.kind ?? ''} ${outcome.message}`);
    if (write) {
      assert.deepEqual(
        (outcome.data as { executed?: boolean } | undefined)?.executed,
        true,
        `${tool} executed`,
      );
      assert.ok(
        outcome.world.calls.some(isMutation),
        `${tool} sent its mutation: ${outcome.world.calls.map(routeOf).join(', ')}`,
      );
    }
  });

  for (const variant of row.out) {
    test(`CC-5157: out of scope: ${tool} with ${variant.label} is refused, naming it`, async () => {
      await assertRefused(tool, variant, false);
    });
  }
  for (const variant of row.unresolved) {
    test(`CC-5158: unresolved: ${tool} with ${variant.label} is refused, naming it`, async () => {
      await assertRefused(tool, variant, true);
    });
  }
}

for (const [tool, args] of Object.entries(CONFINED)) {
  test(`CC-5159: ${tool} confines every search to ABC and filters every list`, async () => {
    const outcome = await run(tool, args);
    assert.equal(outcome.ok, true, `${tool}: ${outcome.kind ?? ''} ${outcome.message}`);
    for (const req of outcome.world.calls) {
      const jql =
        (req.body as { jql?: unknown } | undefined)?.jql ??
        req.query?.['jql'] ??
        undefined;
      if (typeof jql === 'string' && !jql.startsWith('issuekey in')) {
        assert.ok(jql.startsWith('project in ("ABC")'), `${routeOf(req)}: ${jql}`);
      }
    }
    assert.doesNotMatch(JSON.stringify(outcome.data ?? null), /"XYZ"|Project XYZ/);
  });
}

for (const [tool, args] of Object.entries(ALWAYS_REFUSED)) {
  test(`CC-5160: ${tool} is refused before any request (attachment by id)`, async () => {
    const outcome = await run(tool, args);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.kind, 'permission', outcome.message);
    assert.match(outcome.message, /attachment addressed by id/);
    assert.deepEqual(outcome.world.calls.filter(isMutation).map(routeOf), []);
  });
}
