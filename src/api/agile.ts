// ---------------------------------------------------------------------------
// api/agile.ts — boards, sprints and sprint membership (WP-23).
//
// The Jira Software endpoints live under a DIFFERENT root from everything else
// this server speaks: `/rest/agile/1.0` (`root: 'agile'` on every spec below),
// and they page with the classic `startAt` / `maxResults` / `total` / `isLast`
// protocol rather than the search endpoint's `nextPageToken` (JIRA-API.md §Two
// pagination models). Every loop here therefore goes through {@link fetchAll}
// from `api/shared.ts`; this module owns only the routes, the query vocabulary
// and the runtime guards that turn `unknown` wire data into typed rows.
//
// Scope is exactly TOOLS.md §Package `agile`: list boards, list a board's
// sprints, read a sprint's issues, move issues INTO a sprint. Deliberately
// absent:
//
//   * backlog read — deferred by O-4 (DECISIONS.md). The documented v1
//     approximation is the JQL `sprint is EMPTY AND statusCategory != Done`
//     through the search package, not an endpoint here;
//   * sprint create/update/delete and move-to-backlog — v1.5 (ROADMAP.md).
//
// This ring returns DATA + PAGINATION METADATA. Hints (`truncated`,
// `fields_defaulted`), the result envelope and the plan/apply write gate belong
// to the tool ring (WP-34) — which is why {@link listSprintIssues} reports
// `fieldsDefaulted` as a fact rather than emitting a hint, and why
// {@link moveIssuesToSprint} simply performs the POST: the gate decides whether
// this module is called at all.
//
// One agile-specific error rule lives here (CC-34): a 403/404 from the Agile
// root usually means "Jira Software is not available to this account on this
// site", not "that board is gone" — see {@link asAgileError}. Nothing else is
// remapped; every other failure propagates from `core/http.ts` untouched.
// ---------------------------------------------------------------------------

import {
  JiraError,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
  type QueryParams,
} from '../core/types.js';
import {
  fetchAll,
  type BudgetGuard,
  type ClassicCursor,
  type ClassicLoopResult,
  type ClassicPage,
} from './shared.js';

// ---------------------------------------------------------------------------
// 1. Constants and closed vocabularies
// ---------------------------------------------------------------------------

/**
 * Page size used when a caller names none. The Agile endpoints default to 50
 * and cap there, so asking for more only produces a server-applied smaller
 * `maxResults` — which `fetchAll` already honours over the requested size.
 */
export const DEFAULT_AGILE_PAGE_SIZE = 50;

/**
 * The field set injected when a caller asks for none (CC-03: never send an
 * empty `fields`). It is the same list `jira_search` documents in TOOLS.md
 * §Package `search`, because a sprint's issues are rendered by the tool ring
 * exactly like a search page — a model that switches between the two must not
 * get a different column set.
 *
 * NOTE for the integrator: `api/search.ts` (WP-20) owns the same literal. The
 * two must stay equal; deduplicating them is a Wave-4 tidy, not a WP-23 edit
 * (the modules were written in parallel).
 */
export const DEFAULT_SPRINT_ISSUE_FIELDS: readonly string[] = Object.freeze([
  'summary',
  'status',
  'assignee',
  'priority',
  'issuetype',
  'updated',
]);

/**
 * Jira refuses more than 50 issues in one move (`POST /sprint/{id}/issue`), and
 * TOOLS.md caps the tool input at the same number. Checked locally so an
 * oversized batch never reaches the wire as a half-applied write.
 */
export const MAX_MOVE_ISSUES = 50;

/** The `state` filter vocabulary of the sprint list (TOOLS.md). */
export const SPRINT_STATES = ['active', 'future', 'closed'] as const;

/** One sprint state, as accepted by the `state` query parameter. */
export type SprintState = (typeof SPRINT_STATES)[number];

/** The `type` filter vocabulary of the board list (TOOLS.md). */
export const BOARD_TYPES = ['scrum', 'kanban'] as const;

/**
 * One board type, as accepted by the `type` query parameter. The `type` a board
 * REPORTS is a plain string, not this union: team-managed boards come back as
 * `simple`, which is a value Jira returns but not one it accepts as a filter.
 */
export type BoardType = (typeof BOARD_TYPES)[number];

// ---------------------------------------------------------------------------
// 2. Row shapes
// ---------------------------------------------------------------------------

/**
 * One board. `location` is flattened to the three project fields a model
 * actually needs to say "the SCRUM board of project ABC"; the avatar URIs and
 * the `self` link Jira also sends are dropped — they cost result budget and
 * nothing downstream can use them.
 */
export interface AgileBoard {
  readonly id: number;
  readonly name: string;
  /** `scrum`, `kanban` or `simple` (team-managed). Absent if Jira omits it. */
  readonly type?: string;
  readonly projectId?: number;
  readonly projectKey?: string;
  readonly projectName?: string;
}

/** One sprint. Dates are ISO-8601 strings exactly as Jira sent them. */
export interface AgileSprint {
  readonly id: number;
  readonly name: string;
  /** `active`, `future` or `closed`; a future Jira state passes through as-is. */
  readonly state?: string;
  readonly goal?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly completeDate?: string;
  /** The board the sprint was created on — not necessarily the queried one. */
  readonly originBoardId?: number;
}

/**
 * One issue of a sprint. `fields` is passed through VERBATIM under the ids that
 * were requested (TOOLS.md §Read shaping) — this ring never renames, reorders
 * or drops a requested field.
 *
 * FINDING for WP-34: ADF-typed values are NOT flattened here. The default field
 * set carries none, but a caller that asks for `description` gets the raw ADF
 * tree, so the tool must run the same shaper `jira_search` uses before it
 * renders the result.
 */
export interface AgileIssue {
  readonly key: string;
  readonly id?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 3. Option shapes
// ---------------------------------------------------------------------------

/** What every call in this module needs: the wire seam and a cancellation. */
interface AgileBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request; stamped onto every page request. */
  readonly signal?: AbortSignal;
}

/** The paging controls shared by the three read loops. */
interface AgilePagedBase extends AgileBase {
  /** Page size to request; defaults to {@link DEFAULT_AGILE_PAGE_SIZE}. */
  readonly pageSize?: number;
  /** Hard page cap; defaults to `DEFAULT_MAX_PAGES` from `api/shared.ts`. */
  readonly maxPages?: number;
  /** Offset to start from — resume a `max_pages` stop from its `nextStartAt`. */
  readonly startAt?: number;
}

/** Options for {@link listBoards}. */
export type ListBoardsOptions = AgilePagedBase & {
  /** Only boards of this project (key or numeric id). */
  readonly projectKeyOrId?: string | number;
  /** Only boards of this type. */
  readonly type?: BoardType;
} & BudgetGuard;

/** Options for {@link listSprints}. */
export type ListSprintsOptions = AgilePagedBase & {
  /** The board whose sprints to list. */
  readonly boardId: number | string;
  /** One state or several; several are sent as the CSV Jira expects. */
  readonly state?: SprintState | readonly SprintState[];
} & BudgetGuard;

/** Options for {@link listSprintIssues}. */
export type ListSprintIssuesOptions = AgilePagedBase & {
  readonly sprintId: number | string;
  /**
   * Field ids to return. Empty or absent injects
   * {@link DEFAULT_SPRINT_ISSUE_FIELDS} (CC-03) and reports
   * `fieldsDefaulted: true`.
   */
  readonly fields?: readonly string[];
  /** Extra JQL, ANDed by Jira with "issue is in this sprint". */
  readonly jql?: string;
} & BudgetGuard;

/** Options for {@link moveIssuesToSprint}. */
export type MoveIssuesToSprintOptions = AgileBase & {
  readonly sprintId: number | string;
  /** Issue keys or ids, 1…{@link MAX_MOVE_ISSUES}. */
  readonly issues: readonly string[];
} & BudgetGuard;

/** What {@link listSprintIssues} returns on top of the loop metadata. */
export interface SprintIssuesResult extends ClassicLoopResult<AgileIssue> {
  /** The field ids actually sent — the caller's list, or the default set. */
  readonly fields: readonly string[];
  /** `true` when the default set was injected because the caller sent none. */
  readonly fieldsDefaulted: boolean;
}

/** What {@link moveIssuesToSprint} returns. */
export interface MoveIssuesResult {
  readonly sprintId: number;
  /** The issue keys/ids sent, in order — Jira answers 204 with no body. */
  readonly issues: readonly string[];
  /** The upstream status (204 in practice); carried for the journal/log. */
  readonly status: number;
}

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

/**
 * List the boards visible to the account, optionally narrowed to one project or
 * one board type. `GET /rest/agile/1.0/board`, classic pagination.
 *
 * This is the one agile route with no id in its path, which makes it the
 * reliable probe for CC-34: a 403/404 here cannot mean "that board is gone".
 */
export async function listBoards(
  options: ListBoardsOptions,
): Promise<ClassicLoopResult<AgileBoard>> {
  return agileCall({ rootProbe: true }, () =>
    runClassic<AgileBoard>(
      options,
      (cursor) => ({
        method: 'GET',
        root: 'agile',
        path: '/board',
        query: {
          ...pageQuery(cursor),
          ...(options.projectKeyOrId === undefined
            ? {}
            : { projectKeyOrId: String(options.projectKeyOrId) }),
          ...(options.type === undefined ? {} : { type: options.type }),
        },
      }),
      (response) => readCollection(response, 'GET /board', 'values', narrowBoard),
    ),
  );
}

/**
 * List a board's sprints, optionally filtered by state.
 * `GET /rest/agile/1.0/board/{boardId}/sprint`, classic pagination.
 *
 * The endpoint reports `isLast` but no `total`, so the loop terminates on
 * `isLast` (or on a short page) rather than on an offset reaching a count —
 * both paths already live in `fetchAll`.
 */
export async function listSprints(
  options: ListSprintsOptions,
): Promise<ClassicLoopResult<AgileSprint>> {
  const boardId = agileId(options.boardId, 'boardId');
  const state = csvOrUndefined(options.state);

  return agileCall({ rootProbe: false }, () =>
    runClassic<AgileSprint>(
      options,
      (cursor) => ({
        method: 'GET',
        root: 'agile',
        path: `/board/${boardId}/sprint`,
        pathTemplate: '/board/{boardId}/sprint',
        query: {
          ...pageQuery(cursor),
          ...(state === undefined ? {} : { state }),
        },
      }),
      (response) =>
        readCollection(response, 'GET /board/{boardId}/sprint', 'values', narrowSprint),
    ),
  );
}

/**
 * Read the issues of a sprint. `GET /rest/agile/1.0/sprint/{sprintId}/issue`,
 * classic pagination — note that this route names its rows `issues`, not
 * `values`, and reports `total` but no `isLast`.
 *
 * CC-03: an absent or empty `fields` is never sent as "no fields" (which on the
 * agile root means "everything Jira has", a page-sized wall of custom fields).
 * The documented default set is injected and the substitution is reported, so
 * the tool can raise `fields_defaulted`.
 */
export async function listSprintIssues(
  options: ListSprintIssuesOptions,
): Promise<SprintIssuesResult> {
  const sprintId = agileId(options.sprintId, 'sprintId');
  const requested = (options.fields ?? [])
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  const fieldsDefaulted = requested.length === 0;
  const fields = fieldsDefaulted ? DEFAULT_SPRINT_ISSUE_FIELDS : requested;
  const jql = options.jql?.trim();

  const page = await agileCall({ rootProbe: false }, () =>
    runClassic<AgileIssue>(
      options,
      (cursor) => ({
        method: 'GET',
        root: 'agile',
        path: `/sprint/${sprintId}/issue`,
        pathTemplate: '/sprint/{sprintId}/issue',
        query: {
          ...pageQuery(cursor),
          fields: fields.join(','),
          ...(jql === undefined || jql.length === 0 ? {} : { jql }),
        },
      }),
      (response) =>
        readCollection(response, 'GET /sprint/{sprintId}/issue', 'issues', narrowIssue),
    ),
  );

  return { ...page, fields, fieldsDefaulted };
}

// ---------------------------------------------------------------------------
// 5. Write
// ---------------------------------------------------------------------------

/**
 * Move issues into a sprint. `POST /rest/agile/1.0/sprint/{sprintId}/issue`
 * with `{ issues: [...] }`; Jira answers `204` with no body.
 *
 * This is a WRITE, so the spec deliberately carries NO `safe` flag: an
 * ambiguous 5xx/transport failure must surface as `ambiguous_write` rather than
 * be replayed (JIRA-API.md §Rate limiting and retries, CC-12/13). Partial
 * application is real — Jira may move some issues and reject others — which is
 * the other reason a replay is unacceptable.
 *
 * The batch is validated locally first: an empty list is a caller bug, and an
 * oversized one would be rejected by Jira only after the first 50 had moved.
 */
export async function moveIssuesToSprint(
  options: MoveIssuesToSprintOptions,
): Promise<MoveIssuesResult> {
  const sprintId = agileId(options.sprintId, 'sprintId');
  const issues = normalizeIssueKeys(options.issues);

  const spec: JiraRequestSpec = {
    method: 'POST',
    root: 'agile',
    path: `/sprint/${sprintId}/issue`,
    pathTemplate: '/sprint/{sprintId}/issue',
    body: { issues },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  };

  const response = await agileCall({ rootProbe: false }, () => options.jira(spec));
  return { sprintId: Number(sprintId), issues, status: response.status };
}

// ---------------------------------------------------------------------------
// 6. Paging plumbing and input normalisation
// ---------------------------------------------------------------------------

/**
 * Run one classic agile loop: everything {@link fetchAll} needs, rebuilt field
 * by field from the caller's options.
 *
 * The rebuild is deliberate, and the budget half is split in two arms, because
 * {@link BudgetGuard} is a UNION — spreading the options object would let a
 * `deadlineAt` arrive next to an absent `clock`, which is the exact pairing the
 * union exists to make unrepresentable. Rebuilding also keeps the route's own
 * inputs (`boardId`, `state`, `fields`, …) out of the loop options, so the loop
 * only ever sees loop concerns.
 */
function runClassic<T>(
  options: AgilePagedBase & BudgetGuard,
  request: (cursor: ClassicCursor) => JiraRequestSpec,
  readPage: (response: JiraResponse) => ClassicPage<T>,
): Promise<ClassicLoopResult<T>> {
  const base = {
    jira: options.jira,
    request,
    readPage,
    pageSize: options.pageSize ?? DEFAULT_AGILE_PAGE_SIZE,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
  };
  // Narrowed through a plain `BudgetGuard` binding so the discriminant is read
  // off the union itself, not off an intersection TS may not distribute.
  const guard: BudgetGuard = options;
  return guard.deadlineAt === undefined
    ? fetchAll<T>({
        ...base,
        ...(guard.clock === undefined ? {} : { clock: guard.clock }),
      })
    : fetchAll<T>({ ...base, clock: guard.clock, deadlineAt: guard.deadlineAt });
}

/**
 * Validate a board/sprint id and return it as a path segment. Agile ids are
 * always positive integers, so anything else is a caller mistake — and the
 * check doubles as the guarantee that no unencoded caller string reaches the
 * URL (`JiraRequestSpec.path` requires pre-encoded segments).
 */
function agileId(value: number | string, name: string): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new JiraError({
      kind: 'validation',
      message: `${name} must be a positive integer Jira id, received ${JSON.stringify(String(value))}.`,
      remediation:
        name === 'boardId'
          ? 'Call jira_list_boards to get the numeric board id.'
          : 'Call jira_list_sprints to get the numeric sprint id.',
    });
  }
  return text;
}

/** Trim, drop blanks, and enforce the 1…{@link MAX_MOVE_ISSUES} batch rule. */
function normalizeIssueKeys(issues: readonly string[]): readonly string[] {
  const cleaned = issues.map((issue) => issue.trim()).filter((issue) => issue.length > 0);
  if (cleaned.length === 0) {
    throw new JiraError({
      kind: 'validation',
      message:
        'moveIssuesToSprint needs at least one issue key or id; none was supplied.',
      remediation: 'Pass the issue keys to move, e.g. ["ABC-1", "ABC-2"].',
    });
  }
  if (cleaned.length > MAX_MOVE_ISSUES) {
    throw new JiraError({
      kind: 'validation',
      message:
        `Jira moves at most ${String(MAX_MOVE_ISSUES)} issues per sprint call; ` +
        `${String(cleaned.length)} were supplied. Nothing was sent.`,
      remediation: `Split the move into batches of ${String(MAX_MOVE_ISSUES)} issues or fewer.`,
    });
  }
  return cleaned;
}

/** The two paging parameters every classic agile route takes. */
function pageQuery(cursor: ClassicCursor): QueryParams {
  return { startAt: cursor.startAt, maxResults: cursor.maxResults };
}

/**
 * One value or several, as the CSV Jira expects. An empty list means "no
 * filter", never `state=` — an empty parameter is not the same request.
 */
function csvOrUndefined(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const parts = (typeof value === 'string' ? [value] : value)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? undefined : parts.join(',');
}

// ---------------------------------------------------------------------------
// 7. Response guards
// ---------------------------------------------------------------------------

/**
 * Narrow one classic agile page. The rows live under `values` on the board and
 * sprint routes but under `issues` on the sprint-issue route, so the key is a
 * parameter; everything else about the envelope is identical.
 */
function readCollection<T>(
  response: JiraResponse,
  endpoint: string,
  key: 'values' | 'issues',
  narrow: (value: unknown, endpoint: string) => T,
): ClassicPage<T> {
  const body = expectRecord(response.data, endpoint, 'response body');
  const rows = body[key];
  if (!isUnknownArray(rows)) {
    throw unexpectedShape(
      `${endpoint} returned no \`${key}\` array — the Agile API changed shape, ` +
        'or a proxy rewrote the response.',
    );
  }
  return {
    items: rows.map((row) => narrow(row, endpoint)),
    ...(typeof body.startAt === 'number' ? { startAt: body.startAt } : {}),
    ...(typeof body.maxResults === 'number' ? { maxResults: body.maxResults } : {}),
    ...(typeof body.total === 'number' ? { total: body.total } : {}),
    ...(typeof body.isLast === 'boolean' ? { isLast: body.isLast } : {}),
  };
}

function narrowBoard(value: unknown, endpoint: string): AgileBoard {
  const board = expectRecord(value, endpoint, 'board');
  const location = isRecord(board.location) ? board.location : undefined;
  return {
    id: requireNumber(board.id, endpoint, 'board.id'),
    name: requireString(board.name, endpoint, 'board.name'),
    ...(typeof board.type === 'string' ? { type: board.type } : {}),
    ...(typeof location?.projectId === 'number' ? { projectId: location.projectId } : {}),
    ...(typeof location?.projectKey === 'string'
      ? { projectKey: location.projectKey }
      : {}),
    ...(typeof location?.projectName === 'string'
      ? { projectName: location.projectName }
      : {}),
  };
}

function narrowSprint(value: unknown, endpoint: string): AgileSprint {
  const sprint = expectRecord(value, endpoint, 'sprint');
  return {
    id: requireNumber(sprint.id, endpoint, 'sprint.id'),
    name: requireString(sprint.name, endpoint, 'sprint.name'),
    ...(typeof sprint.state === 'string' ? { state: sprint.state } : {}),
    ...(typeof sprint.goal === 'string' ? { goal: sprint.goal } : {}),
    ...(typeof sprint.startDate === 'string' ? { startDate: sprint.startDate } : {}),
    ...(typeof sprint.endDate === 'string' ? { endDate: sprint.endDate } : {}),
    ...(typeof sprint.completeDate === 'string'
      ? { completeDate: sprint.completeDate }
      : {}),
    ...(typeof sprint.originBoardId === 'number'
      ? { originBoardId: sprint.originBoardId }
      : {}),
  };
}

function narrowIssue(value: unknown, endpoint: string): AgileIssue {
  const issue = expectRecord(value, endpoint, 'issue');
  return {
    key: requireString(issue.key, endpoint, 'issue.key'),
    ...(typeof issue.id === 'string' ? { id: issue.id } : {}),
    ...(isRecord(issue.fields) ? { fields: issue.fields } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `Array.isArray` narrowed to `unknown[]` instead of `any[]`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function expectRecord(
  value: unknown,
  endpoint: string,
  what: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw unexpectedShape(`${endpoint} returned a ${what} that is not a JSON object.`);
  }
  return value;
}

function requireNumber(value: unknown, endpoint: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw unexpectedShape(`${endpoint} returned a ${field} that is not a number.`);
  }
  return value;
}

function requireString(value: unknown, endpoint: string, field: string): string {
  if (typeof value !== 'string') {
    throw unexpectedShape(`${endpoint} returned a ${field} that is not a string.`);
  }
  return value;
}

function unexpectedShape(message: string): JiraError {
  return new JiraError({
    kind: 'unexpected_shape',
    message,
    remediation:
      'This is a server-side bug or an upstream change: report it. Retrying will not help.',
  });
}

// ---------------------------------------------------------------------------
// 8. CC-34 — the Agile root may simply not be there
// ---------------------------------------------------------------------------

/** Nothing on this root works when Jira Software is absent or not permitted. */
const AGILE_ROOT_REMEDIATION =
  'The Agile API (/rest/agile/1.0) needs Jira Software on this site and an ' +
  'account allowed to view boards. Verify the licence and the account, then ' +
  'retry; no agile tool can work until then.';

/** …but on an id-bearing route the id is the likelier culprit, so say both. */
const AGILE_SCOPED_REMEDIATION =
  'If other agile calls fail the same way, the Agile API itself may be ' +
  'unavailable on this site (Jira Software licence or board permission) rather ' +
  'than the board/sprint being missing.';

/**
 * Run an agile call, translating the one failure mode this ring understands
 * better than `core/http.ts` does (CC-34).
 *
 * `core/http.ts` maps status → kind with no knowledge of the API root, so a
 * site without Jira Software turns every agile call into a flat `not_found` —
 * which reads like "that board does not exist" and sends the model hunting for
 * a board id that was never the problem.
 */
async function agileCall<T>(
  context: { readonly rootProbe: boolean },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asAgileError(error, context);
  }
}

function asAgileError(error: unknown, context: { readonly rootProbe: boolean }): unknown {
  if (!(error instanceof JiraError)) return error;
  const status = error.httpStatus;
  if (status !== 403 && status !== 404) return error;
  // Only the two kinds a missing Agile root can hide behind are rewritten. A 403
  // that the client already read as `auth` (CC-18: expired token, login denied)
  // keeps its kind — telling that user to check their Jira Software licence
  // would send them after the wrong problem. And a kind that is already
  // `unsupported` needs nothing from this ring: whoever set it said it better.
  if (error.kind !== 'permission' && error.kind !== 'not_found') return error;

  // `/board` carries no id, so a 403/404 there cannot be about a missing board:
  // the root itself is unavailable.
  if (context.rootProbe) {
    return new JiraError({
      kind: 'unsupported',
      message:
        `The Jira Agile API answered ${String(status)} for the board list. ` +
        'Jira Software is not available to this account on this site.',
      httpStatus: status,
      ...(error.jiraMessages === undefined ? {} : { jiraMessages: error.jiraMessages }),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      remediation: AGILE_ROOT_REMEDIATION,
      cause: error,
    });
  }

  // An id-bearing route: keep the kind (the id really may be wrong) but name the
  // other possibility, which is what CC-34 is about.
  return new JiraError({
    kind: error.kind,
    message: error.message,
    httpStatus: status,
    ...(error.jiraMessages === undefined ? {} : { jiraMessages: error.jiraMessages }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    remediation:
      error.remediation === undefined
        ? AGILE_SCOPED_REMEDIATION
        : `${error.remediation} ${AGILE_SCOPED_REMEDIATION}`,
    cause: error,
  });
}
