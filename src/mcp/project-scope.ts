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
// The guard
// ---------------------------------------------------------------------------

export function createProjectScope(deps: ProjectScopeDeps): ProjectScope {
  const keys = deps.keys;
  const allowed = new Set(keys);
  const platformRoot: JiraApiRoot = deps.deployment === 'datacenter' ? 'v2' : 'v3';
  const scopeText = keys.join(', ');

  const deny = (what: string): JiraError =>
    createJiraError({
      kind: 'permission',
      reason: `${what} is outside the project scope of this server (JIRA_PROJECTS: ${scopeText}). Nothing was sent to Jira.`,
      remediation: SCOPE_REMEDIATION,
    });

  // Per-guard memo: one tool call resolves each entity at most once.
  const memo = new Map<string, Promise<string | undefined>>();
  const remember = (
    key: string,
    load: () => Promise<string | undefined>,
  ): Promise<string | undefined> => {
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = load();
      memo.set(key, hit);
    }
    return hit;
  };

  /** A resolution read inheriting the triggering request's profile, budget and signal. */
  const read = async (
    origin: JiraRequestSpec,
    spec: JiraRequestSpec,
  ): Promise<unknown> => {
    const response = await deps.inner({
      ...spec,
      ...(origin.profile === undefined ? {} : { profile: origin.profile }),
      ...(origin.deadlineAt === undefined ? {} : { deadlineAt: origin.deadlineAt }),
      ...(origin.signal === undefined ? {} : { signal: origin.signal }),
    });
    return response.data;
  };

  // --- Resolvers: entity → project key (upper-cased), or undefined ---------

  const projectKeyOf = (
    origin: JiraRequestSpec,
    projectRef: string,
  ): Promise<string | undefined> => {
    const upper = projectRef.toUpperCase();
    if (allowed.has(upper)) return Promise.resolve(upper);
    // A key outside the list is refused without a read; only a numeric id
    // needs Jira to say which project it is.
    if (!NUMERIC_ID.test(projectRef)) return Promise.resolve(upper);
    return remember(`project:${projectRef}`, async () =>
      ref(
        record(
          await read(origin, {
            method: 'GET',
            root: platformRoot,
            path: `/project/${encodeURIComponent(projectRef)}`,
            pathTemplate: '/project/{projectIdOrKey}',
          }),
        )?.['key'],
      )?.toUpperCase(),
    );
  };

  const issueProjectOf = (
    origin: JiraRequestSpec,
    issueRef: string,
  ): Promise<string | undefined> => {
    const key = ISSUE_KEY.exec(issueRef);
    if (key !== null && !allowed.has((key[1] ?? '').toUpperCase())) {
      // The key's prefix is already out of scope; no read needed to refuse.
      return Promise.resolve((key[1] ?? '').toUpperCase());
    }
    // An in-scope prefix is still confirmed: a moved issue answers to its old
    // key from its new project.
    return remember(`issue:${issueRef.toUpperCase()}`, async () =>
      issueProjectKey(
        await read(origin, {
          method: 'GET',
          root: platformRoot,
          path: `/issue/${encodeURIComponent(issueRef)}`,
          pathTemplate: '/issue/{issueIdOrKey}',
          query: { fields: 'project' },
        }),
      ),
    );
  };

  const boardProjectOf = (
    origin: JiraRequestSpec,
    boardId: string,
  ): Promise<string | undefined> =>
    remember(`board:${boardId}`, async () => {
      const location = record(
        record(
          await read(origin, {
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
      return id === undefined ? undefined : projectKeyOf(origin, id);
    });

  const sprintProjectOf = (
    origin: JiraRequestSpec,
    sprintId: string,
  ): Promise<string | undefined> =>
    remember(`sprint:${sprintId}`, async () => {
      const board = ref(
        record(
          await read(origin, {
            method: 'GET',
            root: 'agile',
            path: `/sprint/${encodeURIComponent(sprintId)}`,
            pathTemplate: '/sprint/{sprintId}',
          }),
        )?.['originBoardId'],
      );
      return board === undefined ? undefined : boardProjectOf(origin, board);
    });

  const componentProjectOf = (
    origin: JiraRequestSpec,
    id: string,
  ): Promise<string | undefined> =>
    remember(`component:${id}`, async () => {
      const data = record(
        await read(origin, {
          method: 'GET',
          root: platformRoot,
          path: `/component/${encodeURIComponent(id)}`,
          pathTemplate: '/component/{id}',
        }),
      );
      const key = ref(data?.['project']);
      if (key !== undefined) return key.toUpperCase();
      const projectId = ref(data?.['projectId']);
      return projectId === undefined ? undefined : projectKeyOf(origin, projectId);
    });

  const versionProjectOf = (
    origin: JiraRequestSpec,
    id: string,
  ): Promise<string | undefined> =>
    remember(`version:${id}`, async () => {
      const projectId = ref(
        record(
          await read(origin, {
            method: 'GET',
            root: platformRoot,
            path: `/version/${encodeURIComponent(id)}`,
            pathTemplate: '/version/{id}',
          }),
        )?.['projectId'],
      );
      return projectId === undefined ? undefined : projectKeyOf(origin, projectId);
    });

  // --- Assertions -----------------------------------------------------------

  const assertKey = (key: string | undefined, what: string): void => {
    if (key === undefined || !allowed.has(key)) throw deny(what);
  };

  const assertProject = async (
    origin: JiraRequestSpec,
    projectRef: string,
  ): Promise<void> => {
    assertKey(
      await projectKeyOf(origin, projectRef),
      `Project ${JSON.stringify(projectRef)}`,
    );
  };

  const assertIssue = async (
    origin: JiraRequestSpec,
    issueRef: string,
  ): Promise<void> => {
    assertKey(
      await issueProjectOf(origin, issueRef),
      `Issue ${JSON.stringify(issueRef)}`,
    );
  };

  const assertBoard = async (origin: JiraRequestSpec, boardId: string): Promise<void> => {
    assertKey(await boardProjectOf(origin, boardId), `Board ${boardId}`);
  };

  const assertSprint = async (
    origin: JiraRequestSpec,
    sprintId: string,
  ): Promise<void> => {
    assertKey(await sprintProjectOf(origin, sprintId), `Sprint ${sprintId}`);
  };

  const assertComponent = async (origin: JiraRequestSpec, id: string): Promise<void> => {
    assertKey(await componentProjectOf(origin, id), `Component ${id}`);
  };

  const assertVersion = async (origin: JiraRequestSpec, id: string): Promise<void> => {
    assertKey(await versionProjectOf(origin, id), `Version ${id}`);
  };

  /**
   * Many issues at once (bulk, rank, sprint moves): out-of-scope key prefixes
   * are refused outright, the rest are confirmed with one search per batch.
   * Every reference must come back, in scope.
   */
  const assertIssues = async (
    origin: JiraRequestSpec,
    refs: readonly string[],
  ): Promise<void> => {
    if (refs.length === 1 && refs[0] !== undefined) return assertIssue(origin, refs[0]);
    for (const issueRef of refs) {
      const key = ISSUE_KEY.exec(issueRef);
      if (key !== null && !allowed.has((key[1] ?? '').toUpperCase())) {
        throw deny(`Issue ${JSON.stringify(issueRef)}`);
      }
    }
    for (let start = 0; start < refs.length; start += SEARCH_BATCH) {
      const batch = refs.slice(start, start + SEARCH_BATCH);
      const jql = `issuekey in (${batch.map((entry) => JSON.stringify(entry)).join(', ')})`;
      const data = record(
        await read(origin, {
          method: 'POST',
          root: platformRoot,
          path: deps.deployment === 'datacenter' ? '/search' : '/search/jql',
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
        assertKey(found.get(issueRef.toUpperCase()), `Issue ${JSON.stringify(issueRef)}`);
      }
    }
  };

  /** The bulk-fetch reads (D149, D150) name their issues in `issueIdsOrKeys`. */
  const assertBulkFetch = async (
    req: JiraRequestSpec,
    body: Record<string, unknown> | undefined,
  ): Promise<void> => {
    const refs = issueRefs(body?.['issueIdsOrKeys']);
    if (refs.length === 0) throw deny('A bulk read without issues');
    await assertIssues(req, refs);
  };

  // --- Route classification ------------------------------------------------

  const rewriteQueryJql = (req: JiraRequestSpec): Admission => {
    const jql = scopeJql(queryRef(req.query, 'jql'), keys);
    if (jql === undefined) throw unbalanced();
    return { req: { ...req, query: { ...req.query, jql } } };
  };

  const rewriteBodyJql = (req: JiraRequestSpec): Admission => {
    const body = record(req.body) ?? {};
    const jql = scopeJql(ref(body['jql']), keys);
    if (jql === undefined) throw unbalanced();
    return { req: { ...req, body: { ...body, jql } } };
  };

  const unbalanced = (): JiraError =>
    createJiraError({
      kind: 'validation',
      reason:
        'The JQL has unbalanced quotes or parentheses, so it cannot be confined to ' +
        `the projects in JIRA_PROJECTS (${scopeText}). Nothing was sent to Jira.`,
      remediation: 'Close every quote and parenthesis in the JQL and call again.',
    });

  const filterProjects = (data: unknown): unknown => {
    if (Array.isArray(data)) {
      return data.filter((project) =>
        allowed.has(ref(record(project)?.['key'])?.toUpperCase() ?? ''),
      );
    }
    const rec = record(data);
    if (rec === undefined || !Array.isArray(rec['values'])) return data;
    return {
      ...rec,
      values: rec['values'].filter((project) =>
        allowed.has(ref(record(project)?.['key'])?.toUpperCase() ?? ''),
      ),
    };
  };

  const filterBoards = (data: unknown): unknown => {
    const rec = record(data);
    if (rec === undefined || !Array.isArray(rec['values'])) return data;
    return {
      ...rec,
      values: rec['values'].filter((board) => {
        const key = ref(record(record(board)?.['location'])?.['projectKey']);
        return key !== undefined && allowed.has(key.toUpperCase());
      }),
    };
  };

  const checkQueryRefs = async (
    req: JiraRequestSpec,
    projects: readonly string[],
    issues: readonly string[],
  ): Promise<void> => {
    for (const name of projects) {
      const value = queryRef(req.query, name);
      if (value === undefined) continue;
      for (const part of value.split(',')) {
        if (part.trim().length > 0) await assertProject(req, part.trim());
      }
    }
    for (const name of issues) {
      const value = queryRef(req.query, name);
      if (value !== undefined) await assertIssue(req, value);
    }
  };

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

  const admitPlatform = async (
    req: JiraRequestSpec,
    seg: readonly string[],
  ): Promise<Admission> => {
    const [head, second, third] = seg;
    const body = record(req.body);
    if (head === undefined) throw deny('This request');
    if (GLOBAL_PLATFORM.has(head)) return { req };

    switch (head) {
      case 'user':
        await checkQueryRefs(req, ['project', 'projectKeys'], ['issueKey']);
        return { req };
      case 'mypermissions':
        await checkQueryRefs(req, ['projectKey', 'projectId'], ['issueKey', 'issueId']);
        return { req };
      case 'statuses':
        await checkQueryRefs(req, ['projectId'], []);
        return { req };
      case 'project':
        if (second === undefined || second === 'search')
          return { req, filter: filterProjects };
        await assertProject(req, second);
        return { req };
      case 'issue':
        return admitIssueRoute(req, seg, body);
      case 'changelog':
        // POST /changelog/bulkfetch (D150) — every issue it names.
        if (second === 'bulkfetch' && third === undefined) {
          await assertBulkFetch(req, body);
          return { req };
        }
        throw deny('This changelog route');
      case 'issueLink': {
        if (second === undefined) {
          await assertIssues(
            req,
            [entityRef(body?.['inwardIssue']), entityRef(body?.['outwardIssue'])].filter(
              (entry): entry is string => entry !== undefined,
            ),
          );
          return { req };
        }
        const link = record(
          await read(req, {
            method: 'GET',
            root: platformRoot,
            path: `/issueLink/${encodeURIComponent(second)}`,
            pathTemplate: '/issueLink/{linkId}',
          }),
        );
        const ends = [
          entityRef(link?.['inwardIssue']),
          entityRef(link?.['outwardIssue']),
        ];
        if (ends.some((end) => end === undefined)) throw deny(`Issue link ${second}`);
        for (const end of ends) if (end !== undefined) await assertIssue(req, end);
        return { req };
      }
      case 'component': {
        if (second === undefined) {
          const project = ref(body?.['project']) ?? ref(body?.['projectId']);
          if (project === undefined) throw deny('A component without a project');
          await assertProject(req, project);
          return { req };
        }
        await assertComponent(req, second);
        const target = queryRef(req.query, 'moveIssuesTo');
        if (target !== undefined) await assertComponent(req, target);
        return { req };
      }
      case 'version': {
        if (second === undefined) {
          const project = ref(body?.['projectId']) ?? ref(body?.['project']);
          if (project === undefined) throw deny('A version without a project');
          await assertProject(req, project);
          return { req };
        }
        await assertVersion(req, second);
        for (const name of ['moveFixIssuesTo', 'moveAffectedIssuesTo']) {
          const target = ref(body?.[name]);
          if (target !== undefined) await assertVersion(req, target);
        }
        return { req };
      }
      case 'search':
        if (second === undefined || second === 'jql') {
          return req.method === 'GET' ? rewriteQueryJql(req) : rewriteBodyJql(req);
        }
        if (second === 'approximate-count') return rewriteBodyJql(req);
        throw deny('This search route');
      case 'bulk':
        if (second === 'queue') return { req };
        if (second === 'issues' && third !== undefined) {
          const refs = issueRefs(body?.['selectedIssueIdsOrKeys']);
          if (refs.length === 0) throw deny('A bulk request without issues');
          await assertIssues(req, refs);
          return { req };
        }
        throw deny('This bulk route');
      case 'attachment':
        // Jira's attachment metadata names no issue: nothing to check against.
        throw deny('An attachment addressed by id');
      default:
        throw deny(`The route ${req.pathTemplate ?? `/${head}`}`);
    }
  };

  const admitIssueRoute = async (
    req: JiraRequestSpec,
    seg: readonly string[],
    body: Record<string, unknown> | undefined,
  ): Promise<Admission> => {
    const [, second, third] = seg;
    const fields = record(body?.['fields']);
    const parent = entityRef(fields?.['parent']);

    if (second === undefined) {
      // POST /issue — the new issue's project, and its parent when it has one.
      const project = entityRef(fields?.['project']);
      if (project === undefined) throw deny('An issue without a project');
      await assertProject(req, project);
      if (parent !== undefined) await assertIssue(req, parent);
      return { req };
    }
    if (second === 'bulkfetch' && third === undefined) {
      // POST /issue/bulkfetch (D149) — every issue it names.
      await assertBulkFetch(req, body);
      return { req };
    }
    if (second === 'createmeta') {
      if (third === undefined) throw deny('Create metadata without a project');
      await assertProject(req, third);
      return { req };
    }
    await assertIssue(req, second);
    if (parent !== undefined) await assertIssue(req, parent);
    return { req };
  };

  const admitAgile = async (
    req: JiraRequestSpec,
    seg: readonly string[],
  ): Promise<Admission> => {
    const [head, second, third] = seg;
    const body = record(req.body);
    switch (head) {
      case 'board':
        if (second === undefined) {
          await checkQueryRefs(req, ['projectKeyOrId'], []);
          return { req, filter: filterBoards };
        }
        await assertBoard(req, second);
        if ((third === 'backlog' || third === 'issue') && req.method === 'GET') {
          return rewriteQueryJql(req);
        }
        return { req };
      case 'sprint': {
        if (second === undefined) {
          const board = ref(body?.['originBoardId']);
          if (board === undefined) throw deny('A sprint without a board');
          await assertBoard(req, board);
          return { req };
        }
        await assertSprint(req, second);
        const board = ref(body?.['originBoardId']);
        if (board !== undefined) await assertBoard(req, board);
        if (third === 'issue') {
          if (req.method === 'GET') return rewriteQueryJql(req);
          await assertIssues(req, issueRefs(body?.['issues']));
        }
        return { req };
      }
      case 'backlog':
        if (second === 'issue') {
          await assertIssues(req, issueRefs(body?.['issues']));
          return { req };
        }
        throw deny('This backlog route');
      case 'issue': {
        if (second === undefined) throw deny('This agile route');
        if (second === 'rank') {
          const refs = [
            ...issueRefs(body?.['issues']),
            ...[ref(body?.['rankBeforeIssue']), ref(body?.['rankAfterIssue'])].filter(
              (entry): entry is string => entry !== undefined,
            ),
          ];
          await assertIssues(req, refs);
          return { req };
        }
        await assertIssue(req, second);
        const board = queryRef(req.query, 'boardId');
        if (board !== undefined) await assertBoard(req, board);
        return { req };
      }
      default:
        throw deny(`The agile route ${req.pathTemplate ?? `/${head ?? ''}`}`);
    }
  };

  const admit = async (req: JiraRequestSpec): Promise<Admission> => {
    const seg = segmentsOf(req.path);
    if (seg === undefined) throw deny('This request');
    const root = req.root ?? 'v3';
    if (root === 'agile') return admitAgile(req, seg);
    if (root === 'v3' || root === 'v2') return admitPlatform(req, seg);
    // `secure` is the Data Center attachment servlet — an attachment by id.
    throw deny('An attachment addressed by id');
  };

  /** Belt and braces: an issue a response carries must be in scope. */
  const assertResponse = (data: unknown): void => {
    const rec = record(data);
    if (rec === undefined) return;
    const issues = Array.isArray(rec['issues']) ? rec['issues'] : [rec];
    for (const issue of issues) {
      const key = issueProjectKey(issue);
      if (key !== undefined && !allowed.has(key)) throw deny('A returned issue');
    }
  };

  const jira: JiraRequestFn = async <T = unknown>(
    req: JiraRequestSpec,
  ): Promise<JiraResponse<T>> => {
    const admission = await admit(req);
    const response = await deps.inner<T>(admission.req);
    if (req.accept === 'binary') return response;
    const data =
      admission.filter === undefined ? response.data : admission.filter(response.data);
    assertResponse(data);
    return admission.filter === undefined ? response : { ...response, data: data as T };
  };

  return {
    jira,
    check: async (req: JiraRequestSpec): Promise<void> => {
      await admit(req);
    },
  };
}
