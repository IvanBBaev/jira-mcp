// ---------------------------------------------------------------------------
// api/collab.ts — the collaboration surface (WP-71, D45).
//
// Five small Jira sub-APIs that share one property: they are about WHO cares
// about an issue and HOW a project is carved up, not about the issue itself.
// None of them is reachable through `jira_update_issue`, so without this module
// a model can describe a release but never cut one.
//
//   * watchers  — `GET|POST|DELETE /issue/{issueIdOrKey}/watchers`
//   * votes     — `POST|DELETE /issue/{issueIdOrKey}/votes` (SELF only)
//   * components— `GET /project/{projectIdOrKey}/component`, `POST /component`,
//                 `PUT /component/{id}`
//   * versions  — `GET /project/{projectIdOrKey}/version`, `POST /version`,
//                 `PUT /version/{id}`
//   * roles     — `GET /project/{projectIdOrKey}/role[/{id}]`
//
// Six rules, the first two of which are security boundaries rather than style:
//
//  1. **Every mapper is an ALLOWLIST.** Watcher rows, component leads, version
//     rows and role actors all arrive with avatar URL bags, `self` links, group
//     ids and locale-formatted date strings. Each mapper BUILDS a new object out
//     of the fields this server promises and never spreads the wire record
//     (D41), so a field Atlassian adds tomorrow cannot leak by default.
//  2. **Users are accountIds** (JIRA-API.md §Users, D2/CC-19). The watcher write
//     takes an accountId and nothing else; a role actor that carries no
//     accountId (a GROUP actor) is reported without one rather than with a name
//     that looks addressable but is not.
//  3. **Nothing is deleted here.** Removing a watcher or a vote is a *reversible*
//     write — the same tool re-adds it — and there is deliberately no component
//     or version delete in this module: those DO destroy data (Jira reassigns or
//     strips the field on every issue that referenced it) and belong to the
//     irreversible tier (WP-72), not to this one.
//  4. **`description` is a PLAIN STRING on components and versions** — not ADF.
//     These two endpoints predate the v3 rich-text migration and were never
//     converted, so D44's `format` argument does NOT apply here and no ADF
//     conversion happens on the way in or out. Sending an ADF document would
//     store its JSON as literal text.
//  5. **The two updates are PARTIAL PUTs.** Only the fields the caller named are
//     put in the body; an omitted field keeps its stored value. This is the
//     opposite of `PUT /issue/{key}`'s whole-value replace (CC-31/CC-39), and it
//     is why {@link updateComponent} and {@link updateVersion} refuse an empty
//     change (D22) instead of sending `{}` — an empty body is a successful
//     no-op upstream, which would report "updated" for a call that did nothing.
//  6. **Wire data enters as `unknown`** and is narrowed by hand-rolled guards
//     (ARCHITECTURE.md §Typing strategy); a shape Jira should never send becomes
//     a `JiraError` with `kind: "unexpected_shape"`.
//
// Permissions are the dominant failure mode of this whole surface, and Jira
// reports them badly: a project you may not administer and a project key that
// does not exist are BOTH a 404 (JIRA-API.md §Error response shapes), and the
// watcher write needs a permission — "Manage watchers" — that most accounts
// which can read the issue do not have. {@link asCollabError} therefore appends
// the permission by name to the remediation of a 403/404, following the CC-34
// pattern of `asAgileError` in `api/agile.ts`: the kind is kept (the id really
// may be wrong), the other possibility is spelled out.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import { encodeSegment } from '../core/http-util.js';
import {
  JiraError,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
} from '../core/types.js';
import {
  budgetOf,
  fetchAll,
  type BudgetGuard,
  type ClassicCursor,
  type ClassicLoopResult,
  type ClassicPage,
} from './shared.js';

// ---------------------------------------------------------------------------
// 1. Endpoints, page size and closed vocabularies
// ---------------------------------------------------------------------------

/** `pathTemplate` for the watcher routes — logs and errors show this, never a key. */
export const WATCHERS_PATH_TEMPLATE = '/issue/{issueIdOrKey}/watchers';

/** `pathTemplate` for both vote routes. */
export const VOTES_PATH_TEMPLATE = '/issue/{issueIdOrKey}/votes';

/** The PAGINATED component list. `/project/{key}/components` (plural) is not paged. */
export const PROJECT_COMPONENTS_PATH_TEMPLATE = '/project/{projectIdOrKey}/component';

/** Component create is project-less in the URL; the project travels in the body. */
export const COMPONENT_COLLECTION_PATH = '/component';

/** `pathTemplate` for the single-component route. */
export const COMPONENT_PATH_TEMPLATE = '/component/{id}';

/** The PAGINATED version list. `/project/{key}/versions` (plural) is not paged. */
export const PROJECT_VERSIONS_PATH_TEMPLATE = '/project/{projectIdOrKey}/version';

/** Version create is project-less in the URL; `projectId` travels in the body. */
export const VERSION_COLLECTION_PATH = '/version';

/** `pathTemplate` for the single-version route. */
export const VERSION_PATH_TEMPLATE = '/version/{id}';

/** `pathTemplate` for the project role map. */
export const PROJECT_ROLES_PATH_TEMPLATE = '/project/{projectIdOrKey}/role';

/** `pathTemplate` for one project role with its actors. */
export const PROJECT_ROLE_PATH_TEMPLATE = '/project/{projectIdOrKey}/role/{id}';

/**
 * Page size for the two paginated reads, both of which default to 50 server
 * side. Over-asking would be harmless (`fetchAll` believes the `maxResults` the
 * SERVER echoes, not the one we sent), but 50 rows is also about as many
 * components or versions as a model can use in one turn.
 */
export const COLLAB_PAGE_SIZE = 50;

/** Who a component's issues are assigned to by default (`assigneeType`). */
export const ASSIGNEE_TYPES = [
  'PROJECT_DEFAULT',
  'COMPONENT_LEAD',
  'PROJECT_LEAD',
  'UNASSIGNED',
] as const;

/** One value of {@link ASSIGNEE_TYPES}. */
export type ComponentAssigneeType = (typeof ASSIGNEE_TYPES)[number];

/** The `status` filter vocabulary of the version list. */
export const VERSION_STATUSES = ['released', 'unreleased', 'archived'] as const;

/** One value of {@link VERSION_STATUSES}. */
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/**
 * Version dates are ISO-8601 CALENDAR DATES — `YYYY-MM-DD`, no time, no zone.
 * A full timestamp is rejected by Jira with a 400 whose message names the field
 * but not the format, so the check happens here instead (D22).
 */
const RELEASE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Jira ids on this surface are positive integers, without exception. */
const POSITIVE_INT = /^[1-9][0-9]*$/;

// ---------------------------------------------------------------------------
// 2. Option shapes
// ---------------------------------------------------------------------------

/** What every call here needs: the injected wire seam and a cancellation. */
export interface CollabBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request; stamped onto every request issued. */
  readonly signal?: AbortSignal;
}

/** The paging controls of the two paginated reads. */
export interface CollabPagedBase extends CollabBase {
  /** Rows per request; defaults to {@link COLLAB_PAGE_SIZE}. */
  readonly pageSize?: number;
  /** Hard page cap; defaults to `DEFAULT_MAX_PAGES` from `api/shared.ts`. */
  readonly maxPages?: number;
  /** Offset to start from — resume a `max_pages` stop from its `nextStartAt`. */
  readonly startAt?: number;
}

/** Options for a single-request collaboration call. */
export type CollabOptions = CollabBase & BudgetGuard;

/** Options for {@link listWatchers}. */
export type ListWatchersOptions = CollabOptions & {
  /** Issue key (`ABC-1`) or numeric id. */
  readonly issue: string;
};

/** Options for {@link addWatcher} and {@link removeWatcher}. */
export type WatcherOptions = ListWatchersOptions & {
  /** The account to add or remove. accountId only — never a username (CC-19). */
  readonly accountId: string;
};

/** Options for {@link addVote} and {@link removeVote} — the vote is always yours. */
export type VoteOptions = ListWatchersOptions;

/** Options for {@link listComponents}. */
export type ListComponentsOptions = CollabPagedBase &
  BudgetGuard & {
    /** Project key (`ABC`) or numeric project id. */
    readonly project: string;
    /** Literal substring Jira matches against component name and description. */
    readonly query?: string;
  };

/** Options for {@link createComponent}. */
export type CreateComponentOptions = CollabOptions & {
  /**
   * The project KEY. `POST /component` documents `project` as the key, which is
   * the opposite of {@link CreateVersionOptions}, which needs a numeric id.
   */
  readonly project: string;
  readonly name: string;
  /** PLAIN TEXT, not ADF (module header rule 4). */
  readonly description?: string;
  readonly leadAccountId?: string;
  readonly assigneeType?: ComponentAssigneeType;
};

/** Options for {@link updateComponent} — a partial PUT (module header rule 5). */
export type UpdateComponentOptions = CollabOptions & {
  readonly componentId: string | number;
  readonly name?: string;
  /** PLAIN TEXT. `''` is a real value here: it CLEARS the description. */
  readonly description?: string;
  readonly leadAccountId?: string;
  readonly assigneeType?: ComponentAssigneeType;
};

/** Options for {@link listVersions}. */
export type ListVersionsOptions = CollabPagedBase &
  BudgetGuard & {
    /** Project key (`ABC`) or numeric project id. */
    readonly project: string;
    /** Literal substring Jira matches against version name and description. */
    readonly query?: string;
    /** Restrict to these lifecycle states; omitted means every state. */
    readonly status?: readonly VersionStatus[];
  };

/** Options for {@link createVersion}. */
export type CreateVersionOptions = CollabOptions & {
  /**
   * The NUMERIC project id. `POST /version` takes `projectId`, not a key —
   * `jira_get_project` reports the id (see {@link CreateComponentOptions}).
   */
  readonly projectId: string | number;
  readonly name: string;
  /** PLAIN TEXT, not ADF (module header rule 4). */
  readonly description?: string;
  /** `YYYY-MM-DD`. */
  readonly startDate?: string;
  /** `YYYY-MM-DD`. */
  readonly releaseDate?: string;
  readonly released?: boolean;
  readonly archived?: boolean;
};

/** Options for {@link updateVersion} — a partial PUT (module header rule 5). */
export type UpdateVersionOptions = CollabOptions & {
  readonly versionId: string | number;
  readonly name?: string;
  /** PLAIN TEXT. `''` is a real value here: it CLEARS the description. */
  readonly description?: string;
  /** `YYYY-MM-DD`. */
  readonly startDate?: string;
  /** `YYYY-MM-DD`. */
  readonly releaseDate?: string;
  readonly released?: boolean;
  readonly archived?: boolean;
};

/** Options for {@link listProjectRoles}. */
export type ListProjectRolesOptions = CollabOptions & {
  /** Project key (`ABC`) or numeric project id. */
  readonly project: string;
};

/** Options for {@link getProjectRole}. */
export type GetProjectRoleOptions = ListProjectRolesOptions & {
  /** Role id, from {@link listProjectRoles}. */
  readonly roleId: string | number;
};

// ---------------------------------------------------------------------------
// 3. Result shapes — the allowlists, in type form
// ---------------------------------------------------------------------------

/** A user on this surface. Narrower than `UserRef`: no avatars, no `self`. */
export interface CollabUser {
  readonly accountId: string;
  readonly displayName?: string;
  readonly active?: boolean;
}

/** What `GET /issue/{key}/watchers` reports, reduced. */
export interface WatcherList {
  /** Whether the AUTHENTICATED account is watching — per-caller state. */
  readonly isWatching?: boolean;
  /** Jira's own count; can exceed `watchers.length` on a restricted read. */
  readonly watchCount?: number;
  /**
   * The watchers themselves. Jira omits this array entirely when the caller
   * lacks "View voters and watchers", which is NOT the same as "nobody watches
   * this issue" — {@link WatcherList.watchersVisible} is what says which it was.
   */
  readonly watchers: readonly CollabUser[];
  /** `false` ⇒ Jira sent no `watchers` array: the list was withheld, not empty. */
  readonly watchersVisible: boolean;
}

/** The result of a watcher write. Jira answers 204 with no body. */
export interface WatcherChange {
  readonly issue: string;
  readonly accountId: string;
  /** The upstream status (204 in practice); carried for the journal. */
  readonly status: number;
}

/** The result of a vote write. Jira answers 204 with no body. */
export interface VoteChange {
  readonly issue: string;
  /** The upstream status (204 in practice); carried for the journal. */
  readonly status: number;
}

/** A project component, reduced to what a model can act on. */
export interface ProjectComponent {
  readonly id: string;
  readonly name: string;
  /** Free text written by a tenant user. PLAIN, never ADF. */
  readonly description?: string;
  /** The project key Jira echoes back on the row. */
  readonly project?: string;
  readonly projectId?: number;
  readonly lead?: CollabUser;
  readonly assigneeType?: string;
  /** `false` ⇒ Jira will fall back to the project default when assigning. */
  readonly isAssigneeTypeValid?: boolean;
}

/** A project version (a "release"), reduced to what a model can act on. */
export interface ProjectVersion {
  readonly id: string;
  readonly name: string;
  /** Free text written by a tenant user. PLAIN, never ADF. */
  readonly description?: string;
  readonly projectId?: number;
  readonly archived?: boolean;
  readonly released?: boolean;
  /** `YYYY-MM-DD`, exactly as stored. */
  readonly startDate?: string;
  /** `YYYY-MM-DD`, exactly as stored. */
  readonly releaseDate?: string;
  /** Jira's own verdict: unreleased and past its `releaseDate`. */
  readonly overdue?: boolean;
}

/** The result of a component write: what Jira stored, plus the status. */
export interface ComponentChange {
  readonly component: ProjectComponent;
  readonly status: number;
}

/** The result of a version write: what Jira stored, plus the status. */
export interface VersionChange {
  readonly version: ProjectVersion;
  readonly status: number;
}

/** One row of the project role map. */
export interface ProjectRole {
  readonly id: string;
  /** The role name — tenant-authored free text ("Administrators", "Пилоти"). */
  readonly name: string;
}

/**
 * One member of a project role. A USER actor carries an accountId; a GROUP
 * actor never does, and is reported without one rather than with a group name
 * dressed up as an identity (module header rule 2).
 */
export interface RoleActor {
  /** `atlassian-user-role-actor` | `atlassian-group-role-actor`. */
  readonly type: string;
  readonly accountId?: string;
  readonly displayName?: string;
}

/** One project role with the accounts and groups in it. */
export interface ProjectRoleDetail extends ProjectRole {
  readonly description?: string;
  readonly actors: readonly RoleActor[];
}

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

/**
 * List an issue's watchers — `GET /issue/{issueIdOrKey}/watchers`.
 *
 * Not paginated: Jira answers with the whole list, and a watcher list long
 * enough to matter does not exist in practice.
 *
 * The read needs "View voters and watchers" on top of "Browse projects". An
 * account with only the latter gets a 200 with `watchers` ABSENT — the count is
 * still there — which is why {@link WatcherList.watchersVisible} exists: an
 * empty array and a withheld array must never look the same to a caller.
 */
export async function listWatchers(options: ListWatchersOptions): Promise<WatcherList> {
  const response = await collabCall(WATCH_READ_HINT, () =>
    sendOne(options, {
      method: 'GET',
      path: issuePath(options.issue, '/watchers'),
      pathTemplate: WATCHERS_PATH_TEMPLATE,
    }),
  );
  return mapWatchers(requireRecord(response.data, 'watcher list'));
}

/**
 * List a project's components, one classic page at a time —
 * `GET /project/{projectIdOrKey}/component`.
 *
 * The PAGINATED route is the singular one. `/project/{key}/components` exists
 * too and returns every component in one unbounded array; on a project with
 * hundreds of components that is the whole result budget in one response, so it
 * is not used here.
 */
export function listComponents(
  options: ListComponentsOptions,
): Promise<ClassicLoopResult<ProjectComponent>> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  return collabCall(PROJECT_READ_HINT, () =>
    runClassic(
      options,
      (cursor) => ({
        method: 'GET',
        path: `/project/${project}/component`,
        pathTemplate: PROJECT_COMPONENTS_PATH_TEMPLATE,
        query: {
          startAt: cursor.startAt,
          maxResults: cursor.maxResults,
          query: trimmed(options.query),
        },
      }),
      (response) => classicPage(response, 'component', mapComponent),
    ),
  );
}

/**
 * List a project's versions, one classic page at a time —
 * `GET /project/{projectIdOrKey}/version`.
 *
 * Same singular/plural split as {@link listComponents}: `/versions` is the
 * unbounded route and is not used.
 */
export function listVersions(
  options: ListVersionsOptions,
): Promise<ClassicLoopResult<ProjectVersion>> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  const status = options.status;
  return collabCall(PROJECT_READ_HINT, () =>
    runClassic(
      options,
      (cursor) => ({
        method: 'GET',
        path: `/project/${project}/version`,
        pathTemplate: PROJECT_VERSIONS_PATH_TEMPLATE,
        query: {
          startAt: cursor.startAt,
          maxResults: cursor.maxResults,
          query: trimmed(options.query),
          status:
            status === undefined || status.length === 0 ? undefined : status.join(','),
        },
      }),
      (response) => classicPage(response, 'version', mapVersion),
    ),
  );
}

/**
 * List a project's roles — `GET /project/{projectIdOrKey}/role`.
 *
 * The wire shape is a MAP of role name → role URL, with the id only present as
 * the last segment of that URL:
 *
 * ```json
 * { "Administrators": "https://site/rest/api/3/project/ABC/role/10002" }
 * ```
 *
 * That is unusable as-is — the id is what {@link getProjectRole} takes — so the
 * map is flattened to `[{ id, name }]` here, sorted by name so two calls
 * against the same project produce the same order (object key order is an
 * implementation detail of whatever JSON parser ran).
 */
export async function listProjectRoles(
  options: ListProjectRolesOptions,
): Promise<readonly ProjectRole[]> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  const response = await collabCall(ROLE_READ_HINT, () =>
    sendOne(options, {
      method: 'GET',
      path: `/project/${project}/role`,
      pathTemplate: PROJECT_ROLES_PATH_TEMPLATE,
    }),
  );
  return mapRoleMap(requireRecord(response.data, 'project role map'));
}

/**
 * Read one project role and who is in it —
 * `GET /project/{projectIdOrKey}/role/{id}`.
 *
 * The actors are allowlisted hard: Jira sends an `actorUser`/`actorGroup` pair
 * with group ids and avatar bags, and none of that helps a model decide who to
 * assign work to.
 */
export async function getProjectRole(
  options: GetProjectRoleOptions,
): Promise<ProjectRoleDetail> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  const roleId = positiveId(options.roleId, 'roleId', ROLE_ID_REMEDIATION);
  const response = await collabCall(ROLE_READ_HINT, () =>
    sendOne(options, {
      method: 'GET',
      path: `/project/${project}/role/${roleId}`,
      pathTemplate: PROJECT_ROLE_PATH_TEMPLATE,
    }),
  );
  return mapRoleDetail(requireRecord(response.data, 'project role'), roleId);
}

// ---------------------------------------------------------------------------
// 5. Writes — all reversible, all standard tier
// ---------------------------------------------------------------------------

/**
 * Add a watcher — `POST /issue/{issueIdOrKey}/watchers`.
 *
 * The body is the accountId as a BARE JSON STRING (`"5b10a2…"`), not an object.
 * That is genuinely how the endpoint is documented, and `core/http.ts`
 * `JSON.stringify`s the body it is handed, so passing the raw string is what
 * puts the quotes on the wire.
 *
 * Adding a watcher who is already watching is a no-op upstream, so the call is
 * idempotent. Watching on someone else's behalf needs "Manage watchers";
 * watching yourself needs only "Browse projects".
 */
export async function addWatcher(options: WatcherOptions): Promise<WatcherChange> {
  const issue = issuePath(options.issue, '/watchers');
  const accountId = requireText(options.accountId, 'accountId', ACCOUNT_ID_REMEDIATION);
  const response = await collabCall(WATCH_WRITE_HINT, () =>
    options.jira({
      method: 'POST',
      path: issue,
      pathTemplate: WATCHERS_PATH_TEMPLATE,
      body: accountId,
      ...writeControls(options),
    }),
  );
  return { issue: options.issue, accountId, status: response.status };
}

/**
 * Remove a watcher — `DELETE /issue/{issueIdOrKey}/watchers?accountId=…`.
 *
 * The account travels as a QUERY PARAMETER, not in the body — a DELETE with a
 * body is what most HTTP clients drop silently, and Jira does not read one here.
 *
 * This is a `DELETE` that destroys nothing: the watch is a link, and
 * {@link addWatcher} puts it back. It is therefore standard tier and NOT
 * annotated destructive.
 */
export async function removeWatcher(options: WatcherOptions): Promise<WatcherChange> {
  const issue = issuePath(options.issue, '/watchers');
  const accountId = requireText(options.accountId, 'accountId', ACCOUNT_ID_REMEDIATION);
  const response = await collabCall(WATCH_WRITE_HINT, () =>
    options.jira({
      method: 'DELETE',
      path: issue,
      pathTemplate: WATCHERS_PATH_TEMPLATE,
      query: { accountId },
      ...writeControls(options),
    }),
  );
  return { issue: options.issue, accountId, status: response.status };
}

/**
 * Vote for an issue — `POST /issue/{issueIdOrKey}/votes`.
 *
 * The vote is ALWAYS the authenticated account's own: the endpoint takes no
 * body and no accountId, and there is no API for voting on someone's behalf.
 * A model that is asked to "add Ivan's vote" cannot do it and must say so.
 *
 * Jira also refuses a vote on an issue you reported, with a 404 whose message
 * says why — {@link asCollabError} keeps that message and adds the rest.
 */
export async function addVote(options: VoteOptions): Promise<VoteChange> {
  return voteCall(options, 'POST');
}

/**
 * Withdraw your vote — `DELETE /issue/{issueIdOrKey}/votes`.
 *
 * Self-only and reversible, exactly like {@link addVote}; removing a vote you
 * never cast is a no-op, not an error.
 */
export async function removeVote(options: VoteOptions): Promise<VoteChange> {
  return voteCall(options, 'DELETE');
}

/**
 * Create a component — `POST /component`.
 *
 * `project` is the project KEY, in the BODY; the URL carries no project. Note
 * the asymmetry with {@link createVersion}, which needs the numeric project id
 * instead — that is Jira's design, not a normalisation this module adds.
 *
 * `description` is stored as PLAIN TEXT (module header rule 4).
 */
export async function createComponent(
  options: CreateComponentOptions,
): Promise<ComponentChange> {
  const body: Record<string, unknown> = {
    name: requireText(options.name, 'component name', COMPONENT_NAME_REMEDIATION),
    project: requireText(options.project, 'project key', PROJECT_REMEDIATION),
  };
  if (options.description !== undefined) body.description = options.description;
  if (options.leadAccountId !== undefined) {
    body.leadAccountId = requireText(
      options.leadAccountId,
      'leadAccountId',
      ACCOUNT_ID_REMEDIATION,
    );
  }
  if (options.assigneeType !== undefined) body.assigneeType = options.assigneeType;

  const response = await collabCall(PROJECT_ADMIN_HINT, () =>
    options.jira({
      method: 'POST',
      path: COMPONENT_COLLECTION_PATH,
      body,
      ...writeControls(options),
    }),
  );
  return {
    component: mapComponent(requireRecord(response.data, 'component')),
    status: response.status,
  };
}

/**
 * Update a component — `PUT /component/{id}`, PARTIAL.
 *
 * Only the named fields are sent; everything else keeps its stored value. An
 * empty change is refused before the request is built (D22) rather than sent as
 * `{}`, which Jira accepts as a successful no-op.
 *
 * `project` is deliberately absent: Jira cannot move a component between
 * projects, and offering the field would only produce a confusing 400.
 */
export async function updateComponent(
  options: UpdateComponentOptions,
): Promise<ComponentChange> {
  const id = positiveId(options.componentId, 'componentId', COMPONENT_ID_REMEDIATION);
  const body: Record<string, unknown> = {};
  if (options.name !== undefined) {
    body.name = requireText(options.name, 'component name', COMPONENT_NAME_REMEDIATION);
  }
  // `''` is kept on purpose: an empty description is how a description is cleared.
  if (options.description !== undefined) body.description = options.description;
  if (options.leadAccountId !== undefined) {
    body.leadAccountId = requireText(
      options.leadAccountId,
      'leadAccountId',
      ACCOUNT_ID_REMEDIATION,
    );
  }
  if (options.assigneeType !== undefined) body.assigneeType = options.assigneeType;
  requireChange(body, 'component', 'name, description, leadAccountId or assigneeType');

  const response = await collabCall(PROJECT_ADMIN_HINT, () =>
    options.jira({
      method: 'PUT',
      path: `${COMPONENT_COLLECTION_PATH}/${id}`,
      pathTemplate: COMPONENT_PATH_TEMPLATE,
      body,
      ...writeControls(options),
    }),
  );
  return {
    component: mapComponent(requireRecord(response.data, 'component')),
    status: response.status,
  };
}

/**
 * Create a version — `POST /version`.
 *
 * `projectId` is the NUMERIC id and is required; the key is not accepted here
 * (see {@link createComponent} for the asymmetry). `jira_get_project` reports
 * the id.
 *
 * Dates are forwarded VERBATIM as `YYYY-MM-DD` after a format check — no
 * timezone maths, no "today" resolution, because the model knows which calendar
 * day it means and this module does not.
 */
export async function createVersion(
  options: CreateVersionOptions,
): Promise<VersionChange> {
  const body: Record<string, unknown> = {
    name: requireText(options.name, 'version name', VERSION_NAME_REMEDIATION),
    projectId: Number(positiveId(options.projectId, 'projectId', PROJECT_ID_REMEDIATION)),
  };
  addVersionFields(body, options);

  const response = await collabCall(PROJECT_ADMIN_HINT, () =>
    options.jira({
      method: 'POST',
      path: VERSION_COLLECTION_PATH,
      body,
      ...writeControls(options),
    }),
  );
  return {
    version: mapVersion(requireRecord(response.data, 'version')),
    status: response.status,
  };
}

/**
 * Update a version — `PUT /version/{id}`, PARTIAL.
 *
 * This is how a release is cut (`released: true`) and how it is un-cut
 * (`released: false`): both directions work, which is why the write is standard
 * tier rather than irreversible. `archived: true` hides the version from
 * pickers and is likewise reversible.
 *
 * An empty change is refused (D22) — see {@link updateComponent}.
 */
export async function updateVersion(
  options: UpdateVersionOptions,
): Promise<VersionChange> {
  const id = positiveId(options.versionId, 'versionId', VERSION_ID_REMEDIATION);
  const body: Record<string, unknown> = {};
  if (options.name !== undefined) {
    body.name = requireText(options.name, 'version name', VERSION_NAME_REMEDIATION);
  }
  addVersionFields(body, options);
  requireChange(
    body,
    'version',
    'name, description, startDate, releaseDate, released or archived',
  );

  const response = await collabCall(PROJECT_ADMIN_HINT, () =>
    options.jira({
      method: 'PUT',
      path: `${VERSION_COLLECTION_PATH}/${id}`,
      pathTemplate: VERSION_PATH_TEMPLATE,
      body,
      ...writeControls(options),
    }),
  );
  return {
    version: mapVersion(requireRecord(response.data, 'version')),
    status: response.status,
  };
}

// ---------------------------------------------------------------------------
// 6. Request plumbing and input normalisation
// ---------------------------------------------------------------------------

/** The two vote routes differ only by verb, so they share one implementation. */
async function voteCall(
  options: VoteOptions,
  method: 'POST' | 'DELETE',
): Promise<VoteChange> {
  const path = issuePath(options.issue, '/votes');
  const response = await collabCall(VOTE_HINT, () =>
    options.jira({
      method,
      path,
      pathTemplate: VOTES_PATH_TEMPLATE,
      ...writeControls(options),
    }),
  );
  return { issue: options.issue, status: response.status };
}

/** The optional half of both version bodies — identical on create and update. */
function addVersionFields(
  body: Record<string, unknown>,
  options: {
    readonly description?: string;
    readonly startDate?: string;
    readonly releaseDate?: string;
    readonly released?: boolean;
    readonly archived?: boolean;
  },
): void {
  // `''` is kept on purpose: an empty description is how a description is cleared.
  if (options.description !== undefined) body.description = options.description;
  if (options.startDate !== undefined) {
    body.startDate = calendarDate(options.startDate, 'startDate');
  }
  if (options.releaseDate !== undefined) {
    body.releaseDate = calendarDate(options.releaseDate, 'releaseDate');
  }
  if (options.released !== undefined) body.released = options.released;
  if (options.archived !== undefined) body.archived = options.archived;
}

/**
 * Issue ONE request, stamping the caller's cancellation and call-budget
 * deadline onto it. A spec that set its own keeps it, mirroring
 * `withLoopControls` in `api/shared.ts` so single and looped reads behave
 * identically.
 */
function sendOne(
  options: CollabOptions,
  spec: JiraRequestSpec,
): Promise<JiraResponse<unknown>> {
  return options.jira({
    ...spec,
    signal: spec.signal ?? options.signal,
    deadlineAt: spec.deadlineAt ?? options.deadlineAt,
  });
}

/**
 * The per-request controls every write here forwards. `safe` is deliberately
 * NOT among them: an unsafe write is never replayed (JIRA-API.md §Rate limiting
 * and retries), and a replayed `POST /votes` would be harmless while a replayed
 * anything-else would not — the exception is not worth the precedent.
 */
function writeControls(
  options: CollabOptions,
): Pick<JiraRequestSpec, 'signal' | 'deadlineAt'> {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  };
}

/**
 * Run the classic pagination loop. The `deadlineAt`/`clock` pair goes through
 * {@link budgetOf} rather than being spread raw, because {@link BudgetGuard} is
 * a UNION: spreading it would let a `deadlineAt` reach `fetchAll` beside an
 * absent clock, which is the exact pairing the union exists to prevent.
 */
function runClassic<T>(
  options: CollabPagedBase & BudgetGuard,
  request: (cursor: ClassicCursor) => JiraRequestSpec,
  readPage: (response: JiraResponse) => ClassicPage<T>,
): Promise<ClassicLoopResult<T>> {
  const base = {
    jira: options.jira,
    request,
    readPage,
    pageSize: options.pageSize ?? COLLAB_PAGE_SIZE,
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
 * `/issue/<encoded key>` plus a LITERAL suffix. The key is encoded on its own
 * per the `JiraRequestSpec.path` contract; `encodeSegment` REJECTS traversal
 * segments and separators rather than encoding them, so a key carrying `../`
 * fails validation before any request exists.
 */
function issuePath(issue: string, suffix: string): string {
  const key = requireText(issue, 'issue key or id', ISSUE_REMEDIATION);
  return `/issue/${encodeSegment(key, 'issue key or id')}${suffix}`;
}

/** Validate-and-encode ONE path segment (see {@link issuePath} for the why). */
function pathSegment(value: string, what: string, remediation: string): string {
  return encodeSegment(requireText(value, what, remediation), what);
}

/**
 * Validate a positive-integer id and return it as a path segment. Jira ids on
 * this surface are always positive integers, so anything else is a caller
 * mistake — most often a NAME where an id belongs — and the check doubles as
 * the guarantee that no unencoded caller string reaches the URL.
 */
function positiveId(value: string | number, what: string, remediation: string): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!POSITIVE_INT.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `${what} must be a positive integer Jira id, received ${JSON.stringify(String(value))}. Nothing was sent.`,
      remediation,
    });
  }
  return text;
}

/** A required non-empty string, trimmed (D22 — the refusal names the field). */
function requireText(value: string, what: string, remediation: string): string {
  const clean = value.trim();
  if (clean === '') {
    throw createJiraError({
      kind: 'validation',
      reason: `A ${what} is required and must not be empty. Nothing was sent.`,
      remediation,
    });
  }
  return clean;
}

/** Version dates are calendar dates; a timestamp is a caller mistake (D22). */
function calendarDate(value: string, what: string): string {
  const clean = value.trim();
  if (!RELEASE_DATE.test(clean)) {
    throw createJiraError({
      kind: 'validation',
      reason: `${what} must be an ISO-8601 calendar date (YYYY-MM-DD), received ${JSON.stringify(value)}. Nothing was sent.`,
      remediation:
        'Pass the date only — 2026-03-31, not a timestamp and not a time zone. ' +
        'Jira versions have no time of day.',
    });
  }
  return clean;
}

/**
 * A partial PUT with nothing in it is refused (D22). Jira accepts `{}` with a
 * 200 and changes nothing, which would be reported as a successful update — the
 * one failure mode a write tool must never have.
 */
function requireChange(
  body: Record<string, unknown>,
  what: string,
  fields: string,
): void {
  if (Object.keys(body).length > 0) return;
  throw createJiraError({
    kind: 'validation',
    reason: `An update needs at least one field to change. Nothing was sent.`,
    remediation: `Pass the ${what} field to change (${fields}); omitted fields keep their current value.`,
  });
}

/** Blank query filters are omitted from the URL rather than sent as `''`. */
function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  return clean.length === 0 ? undefined : clean;
}

// ---------------------------------------------------------------------------
// 7. Error translation (the CC-34 pattern, applied to permissions)
// ---------------------------------------------------------------------------

const ISSUE_REMEDIATION =
  'Pass the issue key (for example PROJ-123) or its numeric id; jira_search ' +
  'finds one from a JQL query.';

const PROJECT_REMEDIATION =
  'Pass the project key (for example ABC) or its numeric id; jira_list_projects ' +
  'lists both.';

const PROJECT_ID_REMEDIATION =
  'Pass the NUMERIC project id, which jira_get_project reports as `id` — this ' +
  'endpoint does not accept a project key.';

const ACCOUNT_ID_REMEDIATION =
  'Jira Cloud identifies users by accountId only; jira_search_users turns a name ' +
  'or an email fragment into one.';

const COMPONENT_ID_REMEDIATION =
  'Call jira_list_components to get the numeric component id.';

const COMPONENT_NAME_REMEDIATION =
  'Give the component a name; it is what appears in the issue view and it must ' +
  'be unique within the project.';

const VERSION_ID_REMEDIATION = 'Call jira_list_versions to get the numeric version id.';

const ROLE_ID_REMEDIATION =
  'Call jira_list_project_roles without a roleId to get the numeric role id.';

const VERSION_NAME_REMEDIATION =
  'Give the version a name (for example 1.4.0); it must be unique within the project.';

const WATCH_READ_HINT =
  'Reading watchers needs the "View voters and watchers" project permission on top ' +
  'of "Browse projects"; Jira answers 404 for an issue you may not see, so a wrong ' +
  'key and a missing permission look identical here.';

const WATCH_WRITE_HINT =
  'Watching on someone else\'s behalf needs the "Manage watchers" project ' +
  'permission ("Browse projects" is enough to watch as yourself); Jira answers 404 ' +
  'for an issue you may not see, so a wrong key and a missing permission look ' +
  'identical here.';

const VOTE_HINT =
  'Voting needs "Browse projects" and voting enabled on the site; you cannot vote ' +
  'on an issue you reported or on a resolved issue, and Jira answers 404 for an ' +
  'issue you may not see.';

const PROJECT_READ_HINT =
  'Reading a project needs the "Browse projects" project permission; Jira answers ' +
  '404 for a project you may not see, so a wrong key and a missing permission look ' +
  'identical here.';

const ROLE_READ_HINT =
  'Reading project roles needs the "Administer projects" project permission (or ' +
  '"Administer Jira" globally); Jira answers 404 for a project you may not ' +
  'administer, so a wrong key and a missing permission look identical here.';

const PROJECT_ADMIN_HINT =
  'Creating or changing components and versions needs the "Administer projects" ' +
  'project permission (or "Administer Jira" globally); Jira answers 404 for a ' +
  'project you may not administer, so a wrong id and a missing permission look ' +
  'identical here.';

/**
 * Run a collaboration call, naming the permission a 403/404 may really be about.
 *
 * `core/http.ts` maps status → kind with no knowledge of the route, and on this
 * surface that is not enough: "Manage watchers" and "Administer projects" are
 * permissions most accounts do NOT have, and Jira reports their absence with the
 * same 404 it uses for a key that does not exist. Without this the model reads
 * "not found" and starts hunting for a better key it will never find.
 */
async function collabCall<T>(hint: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asCollabError(error, hint);
  }
}

/**
 * Append the permission sentence to a 403/404 remediation, keeping everything
 * else — kind included, because the id really may be wrong. Modelled on
 * `asAgileError` (CC-34): the original remediation is sliced off the tail of the
 * message (which `createJiraError` builds as `reason + ' ' + remediation`)
 * before the extended one is appended in its place.
 */
function asCollabError(error: unknown, hint: string): unknown {
  if (!(error instanceof JiraError)) return error;
  const status = error.httpStatus;
  if (status !== 403 && status !== 404) return error;
  // A 403 the client already read as `auth` (CC-18: expired token) keeps its
  // kind and its remediation — a project permission is not that user's problem.
  if (error.kind !== 'permission' && error.kind !== 'not_found') return error;

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
    remediation: error.remediation === undefined ? hint : `${error.remediation} ${hint}`,
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// 8. Guards — wire `unknown` → the shapes above
// ---------------------------------------------------------------------------

/** The one remediation every shape failure here shares. */
const SHAPE_REMEDIATION =
  'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).';

function shapeError(message: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason: message,
    remediation: SHAPE_REMEDIATION,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) {
    throw shapeError(`Jira returned a ${what} that is not a JSON object.`);
  }
  return record;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Component and version ids arrive as strings; `projectId` arrives as a number. */
function readId(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireField(value: string | undefined, field: string, what: string): string {
  if (value === undefined) {
    throw shapeError(`Jira returned a ${what} without a usable "${field}".`);
  }
  return value;
}

/**
 * Drop `undefined`-valued keys, so a mapped row contains only what Jira actually
 * sent — `{"description": undefined}` and an absent `description` are the same
 * JSON but not the same object to a test or a consumer.
 */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/**
 * Narrow one page of a classic collection. A missing or non-array `values` is
 * `unexpected_shape` rather than an empty page — "zero components" and "the
 * response was not what we think it is" must never look the same.
 */
function classicPage<T>(
  response: JiraResponse,
  what: string,
  map: (entry: Record<string, unknown>) => T,
): ClassicPage<T> {
  const body = requireRecord(response.data, `${what} page`);
  const raw = body.values;
  if (!Array.isArray(raw)) {
    throw shapeError(`A ${what} page arrived without a "values" array.`);
  }
  return {
    items: raw.map((entry, index) => map(requireRecord(entry, `${what} row #${index}`))),
    isLast: readBoolean(body, 'isLast'),
    total: readNumber(body, 'total'),
    startAt: readNumber(body, 'startAt'),
    maxResults: readNumber(body, 'maxResults'),
  };
}

/**
 * The watcher allowlist. What is NOT here: `self`, `avatarUrls`, `emailAddress`,
 * `timeZone`, `accountType`. Built, never spread (D41).
 */
function mapUser(value: unknown): CollabUser | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const accountId = readString(record, 'accountId');
  // A user without an accountId is not addressable in GDPR-mode Cloud, so it is
  // dropped rather than half-reported (JIRA-API.md §Users).
  if (accountId === undefined) return undefined;
  return compact({
    accountId,
    displayName: readString(record, 'displayName'),
    active: readBoolean(record, 'active'),
  });
}

function mapWatchers(body: Record<string, unknown>): WatcherList {
  const raw = body.watchers;
  const visible = Array.isArray(raw);
  const watchers = visible
    ? raw
        .map((entry) => mapUser(entry))
        .filter((entry): entry is CollabUser => entry !== undefined)
    : [];
  return compact({
    isWatching: readBoolean(body, 'isWatching'),
    watchCount: readNumber(body, 'watchCount'),
    watchers,
    watchersVisible: visible,
  });
}

/**
 * The component allowlist. What is NOT here: `self`, `lead` avatar bags,
 * `realAssignee`, `assignee`, `realAssigneeType`, `issueCount`, `componentBean`
 * extras. Built, never spread (D41).
 */
function mapComponent(entry: Record<string, unknown>): ProjectComponent {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'component'),
    name: requireField(readString(entry, 'name'), 'name', 'component'),
    description: readString(entry, 'description'),
    project: readString(entry, 'project'),
    projectId: readNumber(entry, 'projectId'),
    lead: mapUser(entry.lead),
    assigneeType: readString(entry, 'assigneeType'),
    isAssigneeTypeValid: readBoolean(entry, 'isAssigneeTypeValid'),
  });
}

/**
 * The version allowlist. What is NOT here: `self`, `userStartDate` and
 * `userReleaseDate` (the same dates re-rendered in the CALLER's locale, which is
 * a formatting artefact, not data), `operations`, `issuesStatusForFixVersion`.
 * Built, never spread (D41).
 */
function mapVersion(entry: Record<string, unknown>): ProjectVersion {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'version'),
    name: requireField(readString(entry, 'name'), 'name', 'version'),
    description: readString(entry, 'description'),
    projectId: readNumber(entry, 'projectId'),
    archived: readBoolean(entry, 'archived'),
    released: readBoolean(entry, 'released'),
    startDate: readString(entry, 'startDate'),
    releaseDate: readString(entry, 'releaseDate'),
    overdue: readBoolean(entry, 'overdue'),
  });
}

/**
 * Flatten the role name → role URL map. The id is the last path segment of the
 * URL and there is no other way to get it from this endpoint; a value that is
 * not a URL ending in a positive integer means the endpoint changed shape, so it
 * is `unexpected_shape` rather than a silently skipped row.
 */
function mapRoleMap(body: Record<string, unknown>): readonly ProjectRole[] {
  const roles: ProjectRole[] = [];
  for (const [name, value] of Object.entries(body)) {
    if (typeof value !== 'string') {
      throw shapeError(`The project role map entry "${name}" is not a URL string.`);
    }
    const id = value.slice(value.lastIndexOf('/') + 1);
    if (!POSITIVE_INT.test(id)) {
      throw shapeError(
        `The project role URL for "${name}" does not end in a numeric role id.`,
      );
    }
    roles.push({ id, name });
  }
  return roles.sort((left, right) => (left.name < right.name ? -1 : 1));
}

/**
 * The role-detail allowlist. Actors keep `type`, `accountId` and `displayName`
 * and nothing else — `actorGroup.groupId`, `actorUser.avatarUrl` and the
 * numeric actor id are tenant internals a model cannot act on.
 */
function mapRoleDetail(
  body: Record<string, unknown>,
  fallbackId: string,
): ProjectRoleDetail {
  const raw = body.actors;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw shapeError('Jira returned a project role whose "actors" is not an array.');
  }
  const actors = (raw ?? []).map((entry, index) =>
    mapActor(requireRecord(entry, `project role actor #${index}`)),
  );
  return compact({
    // Jira echoes the id; the requested one is the fallback so a terse response
    // cannot turn a successful read into `unexpected_shape`.
    id: readId(body, 'id') ?? fallbackId,
    name: requireField(readString(body, 'name'), 'name', 'project role'),
    description: readString(body, 'description'),
    actors,
  });
}

function mapActor(entry: Record<string, unknown>): RoleActor {
  const user = asRecord(entry.actorUser);
  return compact({
    type: requireField(readString(entry, 'type'), 'type', 'project role actor'),
    accountId: user === undefined ? undefined : readString(user, 'accountId'),
    displayName: readString(entry, 'displayName'),
  });
}
