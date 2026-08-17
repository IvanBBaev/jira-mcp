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
// Scope is TOOLS.md §Package `agile`: list boards, list a board's sprints, read
// a sprint's issues, move issues INTO a sprint or OUT to the backlog, and walk a
// sprint through its lifecycle — create, start, close (WP-61). Deliberately
// absent:
//
//   * backlog read — deferred by O-4 (DECISIONS.md). The documented v1
//     approximation is the JQL `sprint is EMPTY AND statusCategory != Done`
//     through the search package, not an endpoint here;
//   * sprint delete, and the board-scoped backlog move
//     (`POST /backlog/{boardId}/issue`, which exists only to RANK while moving).
//     Deleting a sprint is unrecoverable and no read here can preview it; the
//     ranked move needs a rank vocabulary no tool asks for.
//
// This ring returns DATA + PAGINATION METADATA. Hints (`truncated`,
// `fields_defaulted`), the result envelope and the plan/apply write gate belong
// to the tool ring (WP-34) — which is why {@link listSprintIssues} reports
// `fieldsDefaulted` as a fact rather than emitting a hint, and why
// {@link moveIssuesToSprint} simply performs the POST: the gate decides whether
// this module is called at all.
//
// Two wire facts are easy to get wrong and are pinned by the tests below:
//
//   * the sprint lifecycle uses `POST /sprint/{sprintId}` — Atlassian's
//     "partially update sprint" — and NEVER `PUT /sprint/{sprintId}`. The PUT is
//     a FULL update whose documented behaviour is "any fields not present in the
//     request JSON will be set to null", so starting a sprint with it would erase
//     the sprint's name and goal;
//   * the 50-issue batch cap is Jira's own, on the sprint route and the backlog
//     route alike, and is refused locally (D22) rather than half-applied
//     upstream.
//
// One agile-specific error rule lives here (CC-34): a 403/404 from the Agile
// root usually means "Jira Software is not available to this account on this
// site", not "that board is gone" — see {@link asAgileError}. Nothing else is
// remapped; every other failure propagates from `core/http.ts` untouched.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import {
  JiraError,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
  type QueryParams,
} from '../core/types.js';
import { DEFAULT_SEARCH_FIELDS } from './search.js';
import {
  budgetOf,
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
 * "Must not differ" is now enforced by construction rather than by comment:
 * this is `DEFAULT_SEARCH_FIELDS` from `api/search.ts` under the name the sprint
 * tools import. The alias stays because the two names carry different meanings
 * to a reader of `agile.ts`, and because the tool ring already imports this one.
 */
export const DEFAULT_SPRINT_ISSUE_FIELDS: readonly string[] = DEFAULT_SEARCH_FIELDS;

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

/** Options for {@link moveIssuesToBacklog} — the sprint move without a target. */
export type MoveIssuesToBacklogOptions = AgileBase & {
  /** Issue keys or ids, 1…{@link MAX_MOVE_ISSUES}. */
  readonly issues: readonly string[];
} & BudgetGuard;

/** Options for {@link createSprint}. */
export type CreateSprintOptions = AgileBase & {
  /** The sprint name; Jira requires it and does not default it. */
  readonly name: string;
  /** The board the sprint is created on (Jira calls it `originBoardId`). */
  readonly originBoardId: number | string;
  readonly goal?: string;
  /**
   * ISO-8601 timestamps, forwarded VERBATIM. The worklog offset rule (D16 /
   * CC-23) is a `/rest/api/3/issue/{key}/worklog` rule and does not apply here:
   * the Agile API takes the sprint window as an absolute instant and Atlassian
   * documents it as `2015-04-11T15:22:00.000+10:00` (JIRA-API.md §Agile).
   */
  readonly startDate?: string;
  readonly endDate?: string;
} & BudgetGuard;

/** Options for {@link startSprint}. */
export type StartSprintOptions = AgileBase & {
  readonly sprintId: number | string;
  /**
   * Both are REQUIRED by Jira for `state: 'active'` and are checked here before
   * anything is sent — see {@link requireSprintWindow}. Typed optional so the
   * check is reachable from every caller, not only from a schema that already
   * demands them.
   */
  readonly startDate?: string;
  readonly endDate?: string;
} & BudgetGuard;

/** Options for {@link closeSprint}. */
export type CloseSprintOptions = AgileBase & {
  readonly sprintId: number | string;
} & BudgetGuard;

/** The two states this ring can drive a sprint into (`future` is the start). */
export type SprintLifecycleState = Extract<SprintState, 'active' | 'closed'>;

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

/** What {@link moveIssuesToBacklog} returns — the same, minus the target. */
export interface BacklogMoveResult {
  /** The issue keys/ids sent, in order — Jira answers 204 with no body. */
  readonly issues: readonly string[];
  readonly status: number;
}

/** What {@link createSprint} returns: the sprint Jira actually made. */
export interface CreateSprintResult {
  readonly sprint: AgileSprint;
  /** The upstream status (201 in practice); carried for the journal/log. */
  readonly status: number;
}

/** What {@link startSprint} and {@link closeSprint} return. */
export interface SprintStateResult {
  readonly sprintId: number;
  /** The state that was requested and that Jira accepted. */
  readonly state: SprintLifecycleState;
  readonly status: number;
  /**
   * The sprint as Jira echoed it back, when the echo was a sprint at all.
   * Optional ON PURPOSE: the write has already happened by the time this body is
   * read, so a shape surprise here must not turn an applied write into a failed
   * tool call. {@link createSprint} is the opposite case — a created sprint
   * without an id is worthless, so it narrows strictly.
   */
  readonly sprint?: AgileSprint;
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
// 5. Writes
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
  const issues = normalizeIssueKeys(options.issues, 'sprint');

  const spec: JiraRequestSpec = {
    method: 'POST',
    root: 'agile',
    path: `/sprint/${sprintId}/issue`,
    pathTemplate: '/sprint/{sprintId}/issue',
    body: { issues },
    ...writeControls(options),
  };

  const response = await agileCall({ rootProbe: false }, () => options.jira(spec));
  return { sprintId: Number(sprintId), issues, status: response.status };
}

/**
 * Move issues to the backlog. `POST /rest/agile/1.0/backlog/issue` with
 * `{ issues: [...] }`; Jira answers `204` with no body.
 *
 * Atlassian defines it as "remove future and active sprints from a given set of
 * issues" — there is no board in the request, because the backlog an issue falls
 * into is decided by its project and its board configuration, not by the caller.
 * The board-scoped sibling (`/backlog/{boardId}/issue`) exists only to rank while
 * moving and is out of scope (module header).
 *
 * Same cap, same refusal, same no-replay rule as {@link moveIssuesToSprint}: the
 * spec carries no `safe` flag, so an ambiguous failure surfaces as
 * `ambiguous_write` instead of being retried into a double move (CC-12/13).
 */
export async function moveIssuesToBacklog(
  options: MoveIssuesToBacklogOptions,
): Promise<BacklogMoveResult> {
  const issues = normalizeIssueKeys(options.issues, 'backlog');

  const spec: JiraRequestSpec = {
    method: 'POST',
    root: 'agile',
    path: '/backlog/issue',
    body: { issues },
    ...writeControls(options),
  };

  const response = await agileCall({ rootProbe: false }, () => options.jira(spec));
  return { issues, status: response.status };
}

/**
 * Create a sprint. `POST /rest/agile/1.0/sprint`; Jira answers `201` with the
 * created sprint, which is narrowed strictly — a create whose id cannot be read
 * is useless to every caller.
 *
 * `name` and `originBoardId` are the only required inputs. A sprint is born in
 * the `future` state; `startDate`/`endDate` here only PLAN the window, they do
 * not start it — {@link startSprint} does, and Jira requires the window to exist
 * by then either way.
 */
export async function createSprint(
  options: CreateSprintOptions,
): Promise<CreateSprintResult> {
  const originBoardId = agileId(options.originBoardId, 'originBoardId');
  const name = requireSprintName(options.name);
  const goal = trimmedOrUndefined(options.goal);
  const startDate = trimmedOrUndefined(options.startDate);
  const endDate = trimmedOrUndefined(options.endDate);

  const spec: JiraRequestSpec = {
    method: 'POST',
    root: 'agile',
    path: '/sprint',
    body: {
      name,
      originBoardId: Number(originBoardId),
      ...(goal === undefined ? {} : { goal }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
    },
    ...writeControls(options),
  };

  const response = await agileCall({ rootProbe: false }, () => options.jira(spec));
  return {
    sprint: narrowSprint(response.data, 'POST /sprint'),
    status: response.status,
  };
}

/**
 * Start a sprint: partial update to `state: 'active'`.
 *
 * Jira's precondition is "the sprint must be in the `future` state and have a
 * startDate and endDate set". The dates half is checked HERE, before the wire
 * (D22's spirit: a caller mistake that Jira would answer with a generic 400 is
 * better answered locally, naming the field). The state half cannot be checked
 * without a read the caller did not ask for, so it stays Jira's 400 — re-aimed
 * by {@link staleSprintState}.
 */
export async function startSprint(
  options: StartSprintOptions,
): Promise<SprintStateResult> {
  const sprintId = agileId(options.sprintId, 'sprintId');
  const window = requireSprintWindow(options.startDate, options.endDate);
  return updateSprintState(options, sprintId, {
    state: 'active',
    startDate: window.startDate,
    endDate: window.endDate,
  });
}

/**
 * Close a sprint: partial update to `state: 'closed'`.
 *
 * Jira requires the sprint to be `active`, sets `completeDate` to the time of the
 * request, and moves every issue that is not done out of the sprint — where they
 * land (backlog or the next sprint) is board configuration, not an input here.
 * Nothing in this ring can undo it.
 */
export async function closeSprint(
  options: CloseSprintOptions,
): Promise<SprintStateResult> {
  const sprintId = agileId(options.sprintId, 'sprintId');
  return updateSprintState(options, sprintId, { state: 'closed' });
}

/** The body of a sprint partial update — never a full sprint. */
interface SprintStatePatch {
  readonly state: SprintLifecycleState;
  readonly startDate?: string;
  readonly endDate?: string;
}

/**
 * The one wire call behind {@link startSprint} and {@link closeSprint}.
 *
 * `POST /sprint/{sprintId}` is Atlassian's "partially update sprint": fields the
 * body omits are left alone. The neighbouring `PUT /sprint/{sprintId}` is a FULL
 * update that sets every absent field to null, which would silently erase the
 * sprint's name and goal — see the module header. Neither verb is replayed on an
 * ambiguous failure (CC-13), and no `safe` flag is set.
 */
async function updateSprintState(
  options: AgileBase & BudgetGuard,
  sprintId: string,
  body: SprintStatePatch,
): Promise<SprintStateResult> {
  const spec: JiraRequestSpec = {
    method: 'POST',
    root: 'agile',
    path: `/sprint/${sprintId}`,
    pathTemplate: '/sprint/{sprintId}',
    body,
    ...writeControls(options),
  };

  const response = await agileCall({ rootProbe: false }, async () => {
    try {
      return await options.jira(spec);
    } catch (error) {
      throw staleSprintState(error, body.state);
    }
  });

  const sprint = sprintEcho(response.data);
  return {
    sprintId: Number(sprintId),
    state: body.state,
    status: response.status,
    ...(sprint === undefined ? {} : { sprint }),
  };
}

// ---------------------------------------------------------------------------
// 6. Paging plumbing and input normalisation
// ---------------------------------------------------------------------------

/**
 * The per-request controls every write in this module forwards. Kept in one
 * helper so a new write cannot forget the deadline and quietly escape the call
 * budget; `safe` is deliberately NOT among them (JIRA-API.md §Rate limiting).
 */
function writeControls(
  options: AgileBase & BudgetGuard,
): Pick<JiraRequestSpec, 'signal' | 'deadlineAt'> {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  };
}

/**
 * Run one classic agile loop: everything {@link fetchAll} needs, rebuilt field
 * by field from the caller's options.
 *
 * The rebuild is deliberate, and the budget half goes through
 * {@link budgetOf}, because {@link BudgetGuard} is a UNION — spreading the
 * options object would let a `deadlineAt` arrive next to an absent `clock`,
 * which is the exact pairing the union exists to make unrepresentable.
 * Rebuilding also keeps the route's own inputs (`boardId`, `state`, `fields`, …)
 * out of the loop options, so the loop only ever sees loop concerns.
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
  return fetchAll<T>({ ...base, ...budgetOf(guard) });
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
    throw createJiraError({
      kind: 'validation',
      reason: `${name} must be a positive integer Jira id, received ${JSON.stringify(String(value))}.`,
      remediation: name.toLowerCase().includes('board')
        ? 'Call jira_list_boards to get the numeric board id.'
        : 'Call jira_list_sprints to get the numeric sprint id.',
    });
  }
  return text;
}

/** Which move a batch is being validated for — only the wording differs. */
type MoveTarget = 'sprint' | 'backlog';

/** The api function each target names in its own refusal. */
const MOVE_CALLERS: Readonly<Record<MoveTarget, string>> = Object.freeze({
  sprint: 'moveIssuesToSprint',
  backlog: 'moveIssuesToBacklog',
});

/**
 * Trim, drop blanks, and enforce the 1…{@link MAX_MOVE_ISSUES} batch rule.
 *
 * Both move routes share the cap and share the refusal (D22): an oversized batch
 * is rejected before a request exists, because Jira would otherwise move the
 * first issues and fail the rest, leaving a partially applied write nobody asked
 * for. "Nothing was sent." is the load-bearing half of that message.
 */
function normalizeIssueKeys(
  issues: readonly string[],
  target: MoveTarget,
): readonly string[] {
  const cleaned = issues.map((issue) => issue.trim()).filter((issue) => issue.length > 0);
  if (cleaned.length === 0) {
    throw createJiraError({
      kind: 'validation',
      reason: `${MOVE_CALLERS[target]} needs at least one issue key or id; none was supplied.`,
      remediation: 'Pass the issue keys to move, e.g. ["ABC-1", "ABC-2"].',
    });
  }
  if (cleaned.length > MAX_MOVE_ISSUES) {
    throw createJiraError({
      kind: 'validation',
      reason:
        `Jira moves at most ${String(MAX_MOVE_ISSUES)} issues per ${target} call; ` +
        `${String(cleaned.length)} were supplied. Nothing was sent.`,
      remediation: `Split the move into batches of ${String(MAX_MOVE_ISSUES)} issues or fewer.`,
    });
  }
  return cleaned;
}

/** A sprint needs a name Jira can store; whitespace is not one. */
function requireSprintName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'createSprint needs a non-empty name; Jira has no default. Nothing was sent.',
      remediation:
        'Pass the sprint name, e.g. "Sprint 14" — the board prefix Jira suggests in the UI is not applied by the API.',
    });
  }
  return name;
}

/** Optional free text: trimmed, and absent rather than empty. */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/**
 * The client-side half of Jira's `state: 'active'` precondition: a sprint cannot
 * start without a window. Checked here so the failure names the field that is
 * missing instead of arriving as Jira's generic "sprint cannot be started" 400 —
 * and so nothing is sent for a call that cannot succeed.
 *
 * The values themselves are forwarded verbatim (no reformatting, no timezone
 * inference — D16/CC-23 is a worklog rule and does not reach here).
 */
function requireSprintWindow(
  startDate: string | undefined,
  endDate: string | undefined,
): { readonly startDate: string; readonly endDate: string } {
  const start = trimmedOrUndefined(startDate);
  const end = trimmedOrUndefined(endDate);
  const missing = [
    ...(start === undefined ? ['startDate'] : []),
    ...(end === undefined ? ['endDate'] : []),
  ];
  if (start === undefined || end === undefined) {
    const names = missing.join(' and ');
    throw createJiraError({
      kind: 'validation',
      reason:
        `Starting a sprint sets state=active, which Jira accepts only when the sprint has ` +
        `both startDate and endDate; ${names} ${missing.length === 1 ? 'is' : 'are'} missing. ` +
        'Nothing was sent.',
      remediation:
        `Pass ${names} as an ISO-8601 timestamp with a UTC offset, ` +
        'e.g. 2026-01-31T09:00:00.000+02:00 — that is the form the Agile API documents ' +
        'for the sprint window.',
    });
  }
  return { startDate: start, endDate: end };
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

/**
 * The sprint a state change echoes back, or `undefined` when the body is not one.
 *
 * Lenient BY DESIGN, unlike every other guard in this file: the write has already
 * been applied by the time this runs, so an unreadable echo is a cosmetic loss,
 * not a failure. Turning it into `unexpected_shape` would report a sprint that
 * IS started as not started — the worst answer available.
 */
function sprintEcho(value: unknown): AgileSprint | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'number' || typeof value.name !== 'string') return undefined;
  return narrowSprint(value, 'POST /sprint/{sprintId}');
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
  return createJiraError({
    kind: 'unexpected_shape',
    reason: message,
    remediation:
      'This is a server-side bug or an upstream change: report it. Retrying will not help.',
  });
}

// ---------------------------------------------------------------------------
// 8. Error shaping: the missing root (CC-34) and the stale sprint state
// ---------------------------------------------------------------------------

/** Why a start was refused — the sprint's own state is the usual reason. */
const SPRINT_START_REMEDIATION =
  'A sprint can only be started from the "future" state, and a board that already ' +
  'has an active sprint refuses a second one unless parallel sprints are enabled. ' +
  'Re-fetch the sprints with jira_list_sprints, act on the state Jira reports now, ' +
  'and check that the startDate/endDate you sent are ISO-8601 with an offset. ' +
  'Retrying this call unchanged will fail the same way.';

/** Why a close was refused. Closed is terminal, so this one is often final. */
const SPRINT_CLOSE_REMEDIATION =
  'A sprint can only be closed from the "active" state, and a closed sprint cannot ' +
  'be reopened or updated through this API. Re-fetch the sprints with ' +
  'jira_list_sprints and act on the state Jira reports now; if it is already ' +
  'closed, the work is done — do not retry.';

/**
 * A 400 from a sprint state change, re-aimed — CC-21's shape applied to a sprint.
 *
 * Jira's own messages travel through verbatim (in `jiraMessages` and in the
 * reason); only the remediation changes, because "fix the request fields and
 * retry" is wrong advice for the usual cause: the sprint moved on between the
 * `jira_list_sprints` that produced the id and this call, so the state the caller
 * planned against is stale. Everything that is not a 400 passes through
 * untouched — a 403/404 belongs to {@link asAgileError} instead.
 */
/** Jira's own sentences end themselves; do not staple a second full stop on. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function staleSprintState(error: unknown, state: SprintLifecycleState): unknown {
  if (!(error instanceof JiraError) || error.httpStatus !== 400) return error;
  const said = error.jiraMessages ?? [];
  return createJiraError({
    kind: error.kind,
    reason: sentence(
      `Jira refused to move this sprint to ${state}` +
        `${said.length === 0 ? '' : `: ${said.join('; ')}`}`,
    ),
    remediation: state === 'active' ? SPRINT_START_REMEDIATION : SPRINT_CLOSE_REMEDIATION,
    httpStatus: error.httpStatus,
    ...(said.length === 0 ? {} : { jiraMessages: said }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    cause: error,
  });
}

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
    return createJiraError({
      kind: 'unsupported',
      reason:
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
  // other possibility, which is what CC-34 is about. The original message is
  // `cause + remediation` (createJiraError's format), so the old remediation is
  // sliced off the tail before the extended one is appended in its place.
  const reason =
    error.remediation !== undefined && error.message.endsWith(error.remediation)
      ? error.message.slice(0, error.message.length - error.remediation.length).trimEnd()
      : error.message;
  return createJiraError({
    kind: error.kind,
    reason,
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
