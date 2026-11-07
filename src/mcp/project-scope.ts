// The JIRA_PROJECTS scope guard (D400).
//
// A request seam that confines every tool call to an allow-list of project
// keys. It sits BELOW the write gate — the gate's capture, payload guard and
// before-state slots wrap it, so their seam identities are untouched — and the
// gate calls `check` on a plan-mode mutation before recording it, so an
// out-of-scope write is refused at plan time, not only at apply time.
//
// The guard classifies each request by its route:
//
//   - global metadata (fields, priorities, the caller, filters, …) passes;
//   - project lists are filtered down to the allowed keys;
//   - a project, issue, board, sprint, component, version or issue link named
//     by the request is resolved to its project key, through the UNGUARDED
//     inner seam, and refused when that key is outside the scope;
//   - a JQL search is rewritten to `project in (…) AND (<where>) ORDER BY …`;
//   - anything it does not recognise is refused (fail closed), and so is every
//     attachment route: Jira's attachment metadata names no issue, so there is
//     nothing to check it against.
//
// A refusal is a `permission` error raised before the request leaves; nothing
// reaches Jira. Resolutions are memoised for the life of one guard, which the
// registry builds per tool call.

import { createJiraError } from '../core/errors.js';
import type {
  JiraApiRoot,
  JiraDeployment,
  JiraError,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  QueryParams,
} from '../core/types.js';

export interface ProjectScopeDeps {
  /** Upper-cased project keys (`settings.projects`); must not be empty. */
  readonly keys: readonly string[];
  /** The seam the guard forwards to and resolves through. */
  readonly inner: JiraRequestFn;
  /** Picks the platform root of the guard's own resolution reads. */
  readonly deployment: JiraDeployment;
}

export interface ProjectScope {
  /** The guarded seam: admits, rewrites or refuses each request. */
  readonly jira: JiraRequestFn;
  /**
   * Admit a request without sending it — the plan-mode preflight. Resolves
   * when the request is in scope, rejects with the refusal otherwise.
   */
  readonly check: (req: JiraRequestSpec) => Promise<void>;
}

/** What admission decided: the request to send and an optional response filter. */
interface Admission {
  readonly req: JiraRequestSpec;
  readonly filter?: (data: unknown) => unknown;
}

const SCOPE_REMEDIATION =
  'This server is confined to the projects in JIRA_PROJECTS. Work inside those ' +
  'projects, or ask the operator to widen JIRA_PROJECTS and restart the server.';

const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;
const NUMERIC_ID = /^\d+$/;
const SEARCH_BATCH = 100;

// ---------------------------------------------------------------------------
// JQL
// ---------------------------------------------------------------------------

/** A JQL query split at its top-level `ORDER BY`. */
export interface JqlParts {
  readonly where: string;
  /** The ordering clause without the `ORDER BY` keywords, or `undefined`. */
  readonly orderBy?: string;
}

/**
 * Split a JQL string at its top-level `ORDER BY`, honouring single- and
 * double-quoted strings (with backslash escapes) and parentheses. Returns
 * `undefined` for input whose quotes or parentheses do not balance — such a
 * query cannot be confined safely, so the caller refuses it.
 */
export function splitJql(jql: string): JqlParts | undefined {
  let depth = 0;
  let quote: string | undefined;
  let orderAt: number | undefined;
  for (let i = 0; i < jql.length; i += 1) {
    const ch = jql[i];
    if (quote !== undefined) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (
      depth === 0 &&
      orderAt === undefined &&
      (ch === 'o' || ch === 'O') &&
      (i === 0 || /[\s)]/.test(jql[i - 1] ?? '')) &&
      /^order\s+by(?![A-Za-z0-9_])/i.test(jql.slice(i))
    ) {
      orderAt = i;
    }
  }
  if (quote !== undefined || depth !== 0) return undefined;
  if (orderAt === undefined) return { where: jql.trim() };
  const match = /^order\s+by/i.exec(jql.slice(orderAt));
  const orderBy = jql.slice(orderAt + (match?.[0].length ?? 0)).trim();
  return { where: jql.slice(0, orderAt).trim(), orderBy };
}

/** The JQL clause that confines a query to `keys`. */
export function projectClause(keys: readonly string[]): string {
  return `project in (${keys.map((key) => JSON.stringify(key)).join(', ')})`;
}

/**
 * Confine a JQL query to `keys`: `project in (…) AND (<where>) ORDER BY …`.
 * An absent or empty query becomes the project clause alone. Returns
 * `undefined` when the query does not balance (see {@link splitJql}).
 */
export function scopeJql(
  jql: string | undefined,
  keys: readonly string[],
): string | undefined {
  const clause = projectClause(keys);
  const parts = splitJql(jql ?? '');
  if (parts === undefined) return undefined;
  const confined = parts.where.length === 0 ? clause : `${clause} AND (${parts.where})`;
  return parts.orderBy === undefined || parts.orderBy.length === 0
    ? confined
    : `${confined} ORDER BY ${parts.orderBy}`;
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ref(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value.trim().length > 0 ? value.trim() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `{key}` / `{id}` / a bare string or number — an issue or project reference. */
function entityRef(value: unknown): string | undefined {
  const rec = record(value);
  if (rec === undefined) return ref(value);
  return ref(rec['key']) ?? ref(rec['id']);
}

function queryRef(query: QueryParams | undefined, name: string): string | undefined {
  return ref(query?.[name]);
}

function issueRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(entityRef).filter((entry): entry is string => entry !== undefined);
}

/** The project key a response carries for an issue, when it carries one. */
function issueProjectKey(issue: unknown): string | undefined {
  const project = record(record(record(issue)?.['fields'])?.['project']);
  return ref(project?.['key'])?.toUpperCase();
}

function segmentsOf(path: string): string[] | undefined {
  try {
    return path
      .split('/')
      .slice(1)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Guard state and refusals
// ---------------------------------------------------------------------------

/** What every step of one guard shares. */
interface ScopeContext {
  readonly keys: readonly string[];
  readonly allowed: ReadonlySet<string>;
  readonly scopeText: string;
  readonly inner: JiraRequestFn;
  readonly deployment: JiraDeployment;
  readonly platformRoot: JiraApiRoot;
  /** Per-guard memo: one tool call resolves each entity at most once. */
  readonly memo: Map<string, Promise<string | undefined>>;
}

function deny(ctx: ScopeContext, what: string): JiraError {
  return createJiraError({
    kind: 'permission',
    reason: `${what} is outside the project scope of this server (JIRA_PROJECTS: ${ctx.scopeText}). Nothing was sent to Jira.`,
    remediation: SCOPE_REMEDIATION,
  });
}

/**
 * The refusal for a named entity: it names the entity and, once resolved,
 * the project that put it out of scope — or says the project could not be
 * resolved, which fails closed the same way.
 */
function denyEntity(
  ctx: ScopeContext,
  what: string,
  project: string | undefined,
): JiraError {
  return deny(
    ctx,
    project === undefined
      ? `${what} could not be resolved to a project, so it`
      : `${what} (project ${project})`,
  );
}

function unbalanced(ctx: ScopeContext): JiraError {
  return createJiraError({
    kind: 'validation',
    reason:
      'The JQL has unbalanced quotes or parentheses, so it cannot be confined to ' +
      `the projects in JIRA_PROJECTS (${ctx.scopeText}). Nothing was sent to Jira.`,
    remediation: 'Close every quote and parenthesis in the JQL and call again.',
  });
}

function remember(
  ctx: ScopeContext,
  key: string,
  load: () => Promise<string | undefined>,
): Promise<string | undefined> {
  let hit = ctx.memo.get(key);
  if (hit === undefined) {
    hit = load();
    ctx.memo.set(key, hit);
  }
  return hit;
}

/** A resolution read inheriting the triggering request's profile, budget and signal. */
async function read(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  spec: JiraRequestSpec,
): Promise<unknown> {
  const response = await ctx.inner({
    ...spec,
    ...(origin.profile === undefined ? {} : { profile: origin.profile }),
    ...(origin.deadlineAt === undefined ? {} : { deadlineAt: origin.deadlineAt }),
    ...(origin.signal === undefined ? {} : { signal: origin.signal }),
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// Resolvers: entity → project key (upper-cased), or undefined
// ---------------------------------------------------------------------------

function projectKeyOf(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  projectRef: string,
): Promise<string | undefined> {
  const upper = projectRef.toUpperCase();
  if (ctx.allowed.has(upper)) return Promise.resolve(upper);
  // A key outside the list is refused without a read; only a numeric id
  // needs Jira to say which project it is.
  if (!NUMERIC_ID.test(projectRef)) return Promise.resolve(upper);
  return remember(ctx, `project:${projectRef}`, async () =>
    ref(
      record(
        await read(ctx, origin, {
          method: 'GET',
          root: ctx.platformRoot,
          path: `/project/${encodeURIComponent(projectRef)}`,
          pathTemplate: '/project/{projectIdOrKey}',
        }),
      )?.['key'],
    )?.toUpperCase(),
  );
}

function issueProjectOf(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  issueRef: string,
): Promise<string | undefined> {
  const key = ISSUE_KEY.exec(issueRef);
  if (key !== null && !ctx.allowed.has((key[1] ?? '').toUpperCase())) {
    // The key's prefix is already out of scope; no read needed to refuse.
    return Promise.resolve((key[1] ?? '').toUpperCase());
  }
  // An in-scope prefix is still confirmed: a moved issue answers to its old
  // key from its new project.
  return remember(ctx, `issue:${issueRef.toUpperCase()}`, async () =>
    issueProjectKey(
      await read(ctx, origin, {
        method: 'GET',
        root: ctx.platformRoot,
        path: `/issue/${encodeURIComponent(issueRef)}`,
        pathTemplate: '/issue/{issueIdOrKey}',
        query: { fields: 'project' },
      }),
    ),
  );
}

function boardProjectOf(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  boardId: string,
): Promise<string | undefined> {
  return remember(ctx, `board:${boardId}`, async () => {
    const location = record(
      record(
        await read(ctx, origin, {
          method: 'GET',
          root: 'agile',
          path: `/board/${encodeURIComponent(boardId)}`,
          pathTemplate: '/board/{boardId}',
        }),
      )?.['location'],
    );
    const key = ref(location?.['projectKey']);
    if (key !== undefined) return key.toUpperCase();
    const id = ref(location?.['projectId']);
    return id === undefined ? undefined : projectKeyOf(ctx, origin, id);
  });
}

function sprintProjectOf(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  sprintId: string,
): Promise<string | undefined> {
  return remember(ctx, `sprint:${sprintId}`, async () => {
    const board = ref(
      record(
        await read(ctx, origin, {
          method: 'GET',
          root: 'agile',
          path: `/sprint/${encodeURIComponent(sprintId)}`,
          pathTemplate: '/sprint/{sprintId}',
        }),
      )?.['originBoardId'],
    );
    return board === undefined ? undefined : boardProjectOf(ctx, origin, board);
  });
}

function componentProjectOf(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  id: string,
): Promise<string | undefined> {
  return remember(ctx, `component:${id}`, async () => {
    const data = record(
      await read(ctx, origin, {
        method: 'GET',
        root: ctx.platformRoot,
        path: `/component/${encodeURIComponent(id)}`,
        pathTemplate: '/component/{id}',
      }),
    );
    const key = ref(data?.['project']);
    if (key !== undefined) return key.toUpperCase();
    const projectId = ref(data?.['projectId']);
    return projectId === undefined ? undefined : projectKeyOf(ctx, origin, projectId);
  });
}

function versionProjectOf(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  id: string,
): Promise<string | undefined> {
  return remember(ctx, `version:${id}`, async () => {
    const projectId = ref(
      record(
        await read(ctx, origin, {
          method: 'GET',
          root: ctx.platformRoot,
          path: `/version/${encodeURIComponent(id)}`,
          pathTemplate: '/version/{id}',
        }),
      )?.['projectId'],
    );
    return projectId === undefined ? undefined : projectKeyOf(ctx, origin, projectId);
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertKey(ctx: ScopeContext, key: string | undefined, what: string): void {
  if (key === undefined || !ctx.allowed.has(key)) throw denyEntity(ctx, what, key);
}

async function assertProject(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  projectRef: string,
): Promise<void> {
  assertKey(
    ctx,
    await projectKeyOf(ctx, origin, projectRef),
    `Project ${JSON.stringify(projectRef)}`,
  );
}

async function assertIssue(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  issueRef: string,
): Promise<void> {
  assertKey(
    ctx,
    await issueProjectOf(ctx, origin, issueRef),
    `Issue ${JSON.stringify(issueRef)}`,
  );
}

async function assertBoard(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  boardId: string,
): Promise<void> {
  assertKey(ctx, await boardProjectOf(ctx, origin, boardId), `Board ${boardId}`);
}

async function assertSprint(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  sprintId: string,
): Promise<void> {
  assertKey(ctx, await sprintProjectOf(ctx, origin, sprintId), `Sprint ${sprintId}`);
}

async function assertComponent(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  id: string,
): Promise<void> {
  assertKey(ctx, await componentProjectOf(ctx, origin, id), `Component ${id}`);
}

async function assertVersion(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  id: string,
): Promise<void> {
  assertKey(ctx, await versionProjectOf(ctx, origin, id), `Version ${id}`);
}

/**
 * Many issues at once (bulk, rank, sprint moves): out-of-scope key prefixes
 * are refused outright, the rest are confirmed with one search per batch.
 * Every reference must come back, in scope.
 */
async function assertIssues(
  ctx: ScopeContext,
  origin: JiraRequestSpec,
  refs: readonly string[],
): Promise<void> {
  if (refs.length === 1 && refs[0] !== undefined) {
    return assertIssue(ctx, origin, refs[0]);
  }
  for (const issueRef of refs) {
    const key = ISSUE_KEY.exec(issueRef);
    if (key !== null && !ctx.allowed.has((key[1] ?? '').toUpperCase())) {
      throw denyEntity(
        ctx,
        `Issue ${JSON.stringify(issueRef)}`,
        (key[1] ?? '').toUpperCase(),
      );
    }
  }
  for (let start = 0; start < refs.length; start += SEARCH_BATCH) {
    const batch = refs.slice(start, start + SEARCH_BATCH);
    const jql = `issuekey in (${batch.map((entry) => JSON.stringify(entry)).join(', ')})`;
    const data = record(
      await read(ctx, origin, {
        method: 'POST',
        root: ctx.platformRoot,
        path: ctx.deployment === 'datacenter' ? '/search' : '/search/jql',
        body: { jql, fields: ['project'], maxResults: SEARCH_BATCH },
        safe: true,
      }),
    );
    const found = new Map<string, string | undefined>();
    for (const issue of Array.isArray(data?.['issues']) ? data['issues'] : []) {
      const project = issueProjectKey(issue);
      const rec = record(issue);
      const id = ref(rec?.['id']);
      const key = ref(rec?.['key']);
      if (id !== undefined) found.set(id, project);
      if (key !== undefined) found.set(key.toUpperCase(), project);
    }
    for (const issueRef of batch) {
      assertKey(
        ctx,
        found.get(issueRef.toUpperCase()),
        `Issue ${JSON.stringify(issueRef)}`,
      );
    }
  }
}

/** The bulk-fetch reads (D149, D150) name their issues in `issueIdsOrKeys`. */
async function assertBulkFetch(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  body: Record<string, unknown> | undefined,
): Promise<void> {
  const refs = issueRefs(body?.['issueIdsOrKeys']);
  if (refs.length === 0) throw deny(ctx, 'A bulk read without issues');
  await assertIssues(ctx, req, refs);
}

async function checkQueryRefs(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  projects: readonly string[],
  issues: readonly string[],
): Promise<void> {
  for (const name of projects) {
    const value = queryRef(req.query, name);
    if (value === undefined) continue;
    for (const part of value.split(',')) {
      if (part.trim().length > 0) await assertProject(ctx, req, part.trim());
    }
  }
  for (const name of issues) {
    const value = queryRef(req.query, name);
    if (value !== undefined) await assertIssue(ctx, req, value);
  }
}

/** Belt and braces: an issue a response carries must be in scope. */
function assertResponse(ctx: ScopeContext, data: unknown): void {
  const rec = record(data);
  if (rec === undefined) return;
  const issues = Array.isArray(rec['issues']) ? rec['issues'] : [rec];
  for (const issue of issues) {
    const key = issueProjectKey(issue);
    if (key !== undefined && !ctx.allowed.has(key)) {
      const issueKey = ref(record(issue)?.['key']);
      throw denyEntity(
        ctx,
        issueKey === undefined
          ? 'A returned issue'
          : `Returned issue ${JSON.stringify(issueKey)}`,
        key,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Rewrites and response filters
// ---------------------------------------------------------------------------

function rewriteQueryJql(ctx: ScopeContext, req: JiraRequestSpec): Admission {
  const jql = scopeJql(queryRef(req.query, 'jql'), ctx.keys);
  if (jql === undefined) throw unbalanced(ctx);
  return { req: { ...req, query: { ...req.query, jql } } };
}

function rewriteBodyJql(ctx: ScopeContext, req: JiraRequestSpec): Admission {
  const body = record(req.body) ?? {};
  const jql = scopeJql(ref(body['jql']), ctx.keys);
  if (jql === undefined) throw unbalanced(ctx);
  return { req: { ...req, body: { ...body, jql } } };
}

function filterProjects(ctx: ScopeContext, data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.filter((project) =>
      ctx.allowed.has(ref(record(project)?.['key'])?.toUpperCase() ?? ''),
    );
  }
  const rec = record(data);
  if (rec === undefined || !Array.isArray(rec['values'])) return data;
  return {
    ...rec,
    values: rec['values'].filter((project) =>
      ctx.allowed.has(ref(record(project)?.['key'])?.toUpperCase() ?? ''),
    ),
  };
}

function filterBoards(ctx: ScopeContext, data: unknown): unknown {
  const rec = record(data);
  if (rec === undefined || !Array.isArray(rec['values'])) return data;
  return {
    ...rec,
    values: rec['values'].filter((board) => {
      const key = ref(record(record(board)?.['location'])?.['projectKey']);
      return key !== undefined && ctx.allowed.has(key.toUpperCase());
    }),
  };
}

// ---------------------------------------------------------------------------
// Route classification: the platform root
// ---------------------------------------------------------------------------

const GLOBAL_PLATFORM = new Set([
  'myself',
  'serverInfo',
  'field',
  'issueLinkType',
  'priority',
  'resolution',
  'issuetype',
  'label',
  'configuration',
  'status',
  'jql',
  'filter',
]);

async function admitIssueRoute(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  seg: readonly string[],
  body: Record<string, unknown> | undefined,
): Promise<Admission> {
  const [, second, third] = seg;
  const fields = record(body?.['fields']);
  const parent = entityRef(fields?.['parent']);

  if (second === undefined) {
    // POST /issue — the new issue's project, and its parent when it has one.
    const project = entityRef(fields?.['project']);
    if (project === undefined) throw deny(ctx, 'An issue without a project');
    await assertProject(ctx, req, project);
    if (parent !== undefined) await assertIssue(ctx, req, parent);
    return { req };
  }
  if (second === 'bulkfetch' && third === undefined) {
    // POST /issue/bulkfetch (D149) — every issue it names.
    await assertBulkFetch(ctx, req, body);
    return { req };
  }
  if (second === 'createmeta') {
    if (third === undefined) throw deny(ctx, 'Create metadata without a project');
    await assertProject(ctx, req, third);
    return { req };
  }
  await assertIssue(ctx, req, second);
  if (parent !== undefined) await assertIssue(ctx, req, parent);
  return { req };
}

async function admitIssueLinkRoute(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  linkId: string | undefined,
  body: Record<string, unknown> | undefined,
): Promise<Admission> {
  if (linkId === undefined) {
    await assertIssues(
      ctx,
      req,
      [entityRef(body?.['inwardIssue']), entityRef(body?.['outwardIssue'])].filter(
        (entry): entry is string => entry !== undefined,
      ),
    );
    return { req };
  }
  const link = record(
    await read(ctx, req, {
      method: 'GET',
      root: ctx.platformRoot,
      path: `/issueLink/${encodeURIComponent(linkId)}`,
      pathTemplate: '/issueLink/{linkId}',
    }),
  );
  const ends = [entityRef(link?.['inwardIssue']), entityRef(link?.['outwardIssue'])];
  if (ends.some((end) => end === undefined))
    throw denyEntity(ctx, `Issue link ${linkId}`, undefined);
  for (const end of ends) if (end !== undefined) await assertIssue(ctx, req, end);
  return { req };
}

async function admitComponentRoute(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  id: string | undefined,
  body: Record<string, unknown> | undefined,
): Promise<Admission> {
  if (id === undefined) {
    const project = ref(body?.['project']) ?? ref(body?.['projectId']);
    if (project === undefined) throw deny(ctx, 'A component without a project');
    await assertProject(ctx, req, project);
    return { req };
  }
  await assertComponent(ctx, req, id);
  const target = queryRef(req.query, 'moveIssuesTo');
  if (target !== undefined) await assertComponent(ctx, req, target);
  return { req };
}

async function admitVersionRoute(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  id: string | undefined,
  body: Record<string, unknown> | undefined,
): Promise<Admission> {
  if (id === undefined) {
    const project = ref(body?.['projectId']) ?? ref(body?.['project']);
    if (project === undefined) throw deny(ctx, 'A version without a project');
    await assertProject(ctx, req, project);
    return { req };
  }
  await assertVersion(ctx, req, id);
  for (const name of ['moveFixIssuesTo', 'moveAffectedIssuesTo']) {
    const target = ref(body?.[name]);
    if (target !== undefined) await assertVersion(ctx, req, target);
  }
  return { req };
}

async function admitPlatform(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  seg: readonly string[],
): Promise<Admission> {
  const [head, second, third] = seg;
  const body = record(req.body);
  if (head === undefined) throw deny(ctx, 'This request');
  if (GLOBAL_PLATFORM.has(head)) return { req };

  switch (head) {
    case 'user':
      await checkQueryRefs(ctx, req, ['project', 'projectKeys'], ['issueKey']);
      return { req };
    case 'mypermissions':
      await checkQueryRefs(
        ctx,
        req,
        ['projectKey', 'projectId'],
        ['issueKey', 'issueId'],
      );
      return { req };
    case 'statuses':
      await checkQueryRefs(ctx, req, ['projectId'], []);
      return { req };
    case 'project':
      if (second === undefined || second === 'search')
        return { req, filter: (data) => filterProjects(ctx, data) };
      await assertProject(ctx, req, second);
      return { req };
    case 'issue':
      return admitIssueRoute(ctx, req, seg, body);
    case 'changelog':
      // POST /changelog/bulkfetch (D150) — every issue it names.
      if (second === 'bulkfetch' && third === undefined) {
        await assertBulkFetch(ctx, req, body);
        return { req };
      }
      throw deny(ctx, 'This changelog route');
    case 'issueLink':
      return admitIssueLinkRoute(ctx, req, second, body);
    case 'component':
      return admitComponentRoute(ctx, req, second, body);
    case 'version':
      return admitVersionRoute(ctx, req, second, body);
    case 'search':
      if (second === undefined || second === 'jql') {
        return req.method === 'GET'
          ? rewriteQueryJql(ctx, req)
          : rewriteBodyJql(ctx, req);
      }
      if (second === 'approximate-count') return rewriteBodyJql(ctx, req);
      throw deny(ctx, 'This search route');
    case 'bulk':
      if (second === 'queue') return { req };
      if (second === 'issues' && third !== undefined) {
        const refs = issueRefs(body?.['selectedIssueIdsOrKeys']);
        if (refs.length === 0) throw deny(ctx, 'A bulk request without issues');
        await assertIssues(ctx, req, refs);
        return { req };
      }
      throw deny(ctx, 'This bulk route');
    case 'attachment':
      // Jira's attachment metadata names no issue: nothing to check against.
      throw deny(ctx, 'An attachment addressed by id');
    default:
      throw deny(ctx, `The route ${req.pathTemplate ?? `/${head}`}`);
  }
}

// ---------------------------------------------------------------------------
// Route classification: the agile and software roots
// ---------------------------------------------------------------------------

async function admitAgile(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  seg: readonly string[],
): Promise<Admission> {
  const [head, second, third] = seg;
  const body = record(req.body);
  switch (head) {
    case 'board':
      if (second === undefined) {
        await checkQueryRefs(ctx, req, ['projectKeyOrId'], []);
        return { req, filter: (data) => filterBoards(ctx, data) };
      }
      await assertBoard(ctx, req, second);
      if ((third === 'backlog' || third === 'issue') && req.method === 'GET') {
        return rewriteQueryJql(ctx, req);
      }
      return { req };
    case 'sprint': {
      if (second === undefined) {
        const board = ref(body?.['originBoardId']);
        if (board === undefined) throw deny(ctx, 'A sprint without a board');
        await assertBoard(ctx, req, board);
        return { req };
      }
      await assertSprint(ctx, req, second);
      const board = ref(body?.['originBoardId']);
      if (board !== undefined) await assertBoard(ctx, req, board);
      if (third === 'issue') {
        if (req.method === 'GET') return rewriteQueryJql(ctx, req);
        await assertIssues(ctx, req, issueRefs(body?.['issues']));
      }
      return { req };
    }
    case 'backlog':
      if (second === 'issue') {
        await assertIssues(ctx, req, issueRefs(body?.['issues']));
        return { req };
      }
      throw deny(ctx, 'This backlog route');
    case 'issue': {
      if (second === undefined) throw deny(ctx, 'This agile route');
      if (second === 'rank') {
        const refs = [
          ...issueRefs(body?.['issues']),
          ...[ref(body?.['rankBeforeIssue']), ref(body?.['rankAfterIssue'])].filter(
            (entry): entry is string => entry !== undefined,
          ),
        ];
        await assertIssues(ctx, req, refs);
        return { req };
      }
      await assertIssue(ctx, req, second);
      const board = queryRef(req.query, 'boardId');
      if (board !== undefined) await assertBoard(ctx, req, board);
      return { req };
    }
    default:
      throw deny(ctx, `The agile route ${req.pathTemplate ?? `/${head ?? ''}`}`);
  }
}

/**
 * The Cloud Jira Software issue reads (D500) — the sprint-issue and backlog
 * GETs moved off the agile root. They are scoped exactly as their agile
 * twins were (the board or sprint must be in scope, and the project clause
 * is ANDed into the JQL); any other route on this root is refused, since no
 * served tool sends one.
 */
async function admitSoftware(
  ctx: ScopeContext,
  req: JiraRequestSpec,
  seg: readonly string[],
): Promise<Admission> {
  const [head, second, third, extra] = seg;
  const isRead =
    req.method === 'GET' &&
    second !== undefined &&
    extra === undefined &&
    ((head === 'sprint' && third === 'issue') ||
      (head === 'board' && (third === 'backlog' || third === 'issue')));
  if (!isRead) throw deny(ctx, `The Jira Software route ${req.pathTemplate ?? req.path}`);
  return admitAgile(ctx, req, seg);
}

async function admit(ctx: ScopeContext, req: JiraRequestSpec): Promise<Admission> {
  const seg = segmentsOf(req.path);
  if (seg === undefined) throw deny(ctx, 'This request');
  const root = req.root ?? 'v3';
  if (root === 'agile') return admitAgile(ctx, req, seg);
  if (root === 'software') return admitSoftware(ctx, req, seg);
  if (root === 'v3' || root === 'v2') return admitPlatform(ctx, req, seg);
  // `secure` is the Data Center attachment servlet — an attachment by id.
  throw deny(ctx, 'An attachment addressed by id');
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export function createProjectScope(deps: ProjectScopeDeps): ProjectScope {
  const ctx: ScopeContext = {
    keys: deps.keys,
    allowed: new Set(deps.keys),
    scopeText: deps.keys.join(', '),
    inner: deps.inner,
    deployment: deps.deployment,
    platformRoot: deps.deployment === 'datacenter' ? 'v2' : 'v3',
    memo: new Map(),
  };

  const jira: JiraRequestFn = async <T = unknown>(
    req: JiraRequestSpec,
  ): Promise<JiraResponse<T>> => {
    const admission = await admit(ctx, req);
    const response = await ctx.inner<T>(admission.req);
    if (req.accept === 'binary') return response;
    const data =
      admission.filter === undefined ? response.data : admission.filter(response.data);
    assertResponse(ctx, data);
    return admission.filter === undefined ? response : { ...response, data: data as T };
  };

  return {
    jira,
    check: async (req: JiraRequestSpec): Promise<void> => {
      await admit(ctx, req);
    },
  };
}
