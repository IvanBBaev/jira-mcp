// ---------------------------------------------------------------------------
// api/meta.ts — Jira metadata reads (WP-22).
//
// The DISCOVERY half of the server. Every id a Jira write needs is
// instance-specific — `customfield_10014` means one thing on one tenant and
// something else on the next (JIRA-API.md §Custom fields) — so a model that
// cannot enumerate projects, fields, create screens, statuses and link types can
// only guess. These reads are what the write tools point at when they emit the
// `discovery` hint (TOOLS.md §Hint catalog).
//
// What this module owns, endpoint by endpoint (TOOLS.md §Package `meta`):
//
//   * `GET /project/search`            — {@link listProjects}, classic pagination
//   * `GET /project/{idOrKey}`         — {@link getProject}
//   * `GET /field`                     — {@link listFields}, an UNPAGINATED array
//   * `GET /issue/createmeta/{p}/issuetypes[/{t}]`
//                                      — {@link listCreateMetaIssueTypes} and
//                                        {@link getCreateMeta}
//   * `GET /statuses/search`           — {@link listStatuses}, classic pagination
//   * `GET /issueLinkType`             — {@link listLinkTypes}
//
// Three rules the whole file obeys:
//
//  1. **Pagination is never hand-rolled.** Every paginated endpoint here speaks
//     the classic `startAt`/`maxResults`/`total`/`isLast` model, so it goes
//     through `fetchAll` from `api/shared.ts` and inherits its page cap, budget
//     checks and stop reasons verbatim. The `partial` / `stopReason` /
//     `nextStartAt` metadata is passed straight out to the caller — Wave 3 turns
//     it into the `truncated` hint; the api ring never invents hints or
//     envelopes.
//  2. **Wire data enters as `unknown`.** Each response is narrowed by a
//     hand-rolled guard (ARCHITECTURE.md §Typing strategy); a shape Jira should
//     never send becomes a `JiraError` with `kind: "unexpected_shape"`, never a
//     `TypeError` from inside a tool. Guards are minimal on purpose: they read
//     the fields we promise and tolerate everything else, because Atlassian adds
//     keys to these payloads constantly.
//  3. **Errors are propagated, not translated.** A 403 on `/project/{key}` is a
//     `JiraError` built by `core/http.ts` and it travels out of here untouched —
//     this ring adds no fallbacks, no empty-list-on-failure, no retry.
//
// The old monolithic `GET /issue/createmeta` (all projects at once) is
// deliberately absent: Atlassian deprecated it for performance and JIRA-API.md
// §Custom fields pins the per-project endpoints as the only ones we call.
// ---------------------------------------------------------------------------

import {
  JiraError,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
} from '../core/types.js';
import {
  fetchAll,
  type BudgetGuard,
  type ClassicCursor,
  type ClassicLoopResult,
  type ClassicPage,
} from './shared.js';

// ---------------------------------------------------------------------------
// 1. Page sizes and default expands
// ---------------------------------------------------------------------------

/**
 * Page size for `/project/search`, which caps `maxResults` at 50 server-side.
 * Over-asking is harmless — `fetchAll` compares a page against the size the
 * SERVER says it applied, not the one we requested — but asking for the cap
 * costs the fewest round trips.
 */
export const PROJECT_PAGE_SIZE = 50;

/** Page size for `/statuses/search`, whose server-side cap is 200. */
export const STATUS_PAGE_SIZE = 200;

/** Page size for both createmeta endpoints (server default and cap: 50). */
export const CREATE_META_PAGE_SIZE = 50;

/**
 * `lead` is an EXPAND on `/project/search`, not a default field, and TOOLS.md
 * promises the lead in the project list — so the loop asks for it unless the
 * caller names its own expand set.
 */
export const DEFAULT_PROJECT_EXPAND = 'lead';

/**
 * Detail expands for `/project/{idOrKey}`. `components` and `versions` come back
 * without an expand; description, lead and issue types do not.
 */
export const DEFAULT_PROJECT_DETAIL_EXPAND = 'description,lead,issueTypes';

// ---------------------------------------------------------------------------
// 2. Option shapes
// ---------------------------------------------------------------------------

/**
 * What every call here needs: the injected wire seam and the MCP request's
 * cancellation. Intersected with {@link BudgetGuard} at each call site, so
 * `deadlineAt` can never arrive without the {@link Clock} that gives it meaning.
 */
export interface MetaBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request; stamped onto every request issued. */
  readonly signal?: AbortSignal;
}

/** Paged calls additionally accept the two loop caps. */
export interface MetaPagedBase extends MetaBase {
  /** Rows per request; defaults to the endpoint's documented cap. */
  readonly pageSize?: number;
  /** Hard page cap; defaults to `DEFAULT_MAX_PAGES` in `api/shared.ts`. */
  readonly maxPages?: number;
}

/** Options for a single-request meta read. */
export type MetaOptions = MetaBase & BudgetGuard;

/** Options for a paginated meta read. */
export type MetaPagedOptions = MetaPagedBase & BudgetGuard;

/** Server-side filters of `GET /project/search`. */
export interface ProjectFilters {
  /** Literal substring matched against project name AND key by Jira. */
  readonly query?: string;
  /** `software` | `service_desk` | `business`. Passed through verbatim. */
  readonly typeKey?: string;
  /** e.g. `name`, `-lastIssueUpdatedTime`. Passed through verbatim. */
  readonly orderBy?: string;
  /** Overrides {@link DEFAULT_PROJECT_EXPAND}. */
  readonly expand?: string;
}

/** Options for {@link listProjects}. */
export type ListProjectsOptions = MetaPagedOptions & ProjectFilters;

/** Options for {@link getProject}. */
export type GetProjectOptions = MetaOptions & {
  /** Project key or numeric id — the caller passes it RAW; this module encodes it. */
  readonly project: string;
  /** Overrides {@link DEFAULT_PROJECT_DETAIL_EXPAND}. */
  readonly expand?: string;
};

/** Options for {@link listFields}. */
export type ListFieldsOptions = MetaOptions;

/** Options for {@link listCreateMetaIssueTypes}. */
export type CreateMetaIssueTypesOptions = MetaPagedOptions & {
  readonly project: string;
};

/** Options for {@link getCreateMeta}. */
export type CreateMetaOptions = MetaPagedOptions & {
  readonly project: string;
  /**
   * Issue type ID, never a name. Names are not unique across a tenant and the
   * endpoint takes an id; resolve one with {@link listCreateMetaIssueTypes}.
   */
  readonly issueTypeId: string;
};

/** Server-side filters of `GET /statuses/search`. */
export interface StatusFilters {
  /** Numeric project id (NOT a key) — restricts to that project's statuses. */
  readonly projectId?: string;
  /** Substring matched against the status name. */
  readonly searchString?: string;
  /** `TODO` | `IN_PROGRESS` | `DONE`. Passed through verbatim. */
  readonly statusCategory?: string;
  /** e.g. `usages`, `workflowUsages`. Passed through verbatim. */
  readonly expand?: string;
}

/** Options for {@link listStatuses}. */
export type ListStatusesOptions = MetaPagedOptions & StatusFilters;

/** Options for {@link listLinkTypes}. */
export type ListLinkTypesOptions = MetaOptions;

// ---------------------------------------------------------------------------
// 3. Result shapes
// ---------------------------------------------------------------------------

/**
 * A user as the whole server renders one: accountId first and never a username —
 * Cloud is GDPR-mode only (JIRA-API.md §Users). Email never appears here; it is
 * `jira_search_users`' business alone (TOOLS.md §Read shaping).
 */
export interface UserRef {
  readonly accountId: string;
  readonly displayName?: string;
  readonly active?: boolean;
}

/** One row of `/project/search`. */
export interface ProjectSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  /** `software` | `service_desk` | `business`. */
  readonly projectTypeKey?: string;
  /** `classic` | `next-gen`. */
  readonly style?: string;
  /** True for team-managed (next-gen) projects. */
  readonly simplified?: boolean;
  readonly isPrivate?: boolean;
  /** Present only when the request expanded `lead`. */
  readonly lead?: UserRef;
}

/** An issue type, as `/project/{key}` and the createmeta endpoints report one. */
export interface IssueTypeRef {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly subtask?: boolean;
  /** 0 = base, -1 = subtask, 1+ = epic and above. */
  readonly hierarchyLevel?: number;
}

/** A project component. */
export interface ComponentRef {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** A project version (fixVersion candidate). */
export interface VersionRef {
  readonly id: string;
  readonly name: string;
  readonly released?: boolean;
  readonly archived?: boolean;
  /** `YYYY-MM-DD`, as Jira sends it. Never parsed here — no clock in this ring. */
  readonly releaseDate?: string;
}

/** What `GET /project/{idOrKey}` yields. */
export interface ProjectDetail extends ProjectSummary {
  readonly description?: string;
  /** Present with the default expand; the create tools read it. */
  readonly issueTypes?: readonly IssueTypeRef[];
  /** Returned without an expand. */
  readonly components?: readonly ComponentRef[];
  /** Returned without an expand. */
  readonly versions?: readonly VersionRef[];
}

/** One row of `GET /field`. */
export interface FieldInfo {
  /** `summary`, `customfield_10014`, … — what a `fields` payload is keyed by. */
  readonly id: string;
  readonly name: string;
  /** Usually equal to `id`; Jira sends both. */
  readonly key?: string;
  readonly custom: boolean;
  /** `schema.type` — `string`, `array`, `option`, `number`, … */
  readonly schemaType?: string;
  /** `schema.items` for array-typed fields. */
  readonly schemaItems?: string;
  /** `schema.custom` — the field-type plugin key of a custom field. */
  readonly customType?: string;
  /** `schema.customId` — the numeric tail of `customfield_10014`. */
  readonly customId?: number;
  /** JQL names this field answers to; the model needs them to write JQL. */
  readonly clauseNames?: readonly string[];
  readonly searchable?: boolean;
  readonly orderable?: boolean;
  readonly navigable?: boolean;
}

/**
 * The field catalog plus the two lookups discovery actually needs.
 *
 * Both indexes are `Map`s rather than plain objects on purpose: field names are
 * tenant-authored strings, and a field literally named `constructor` or
 * `toString` would resolve against `Object.prototype` in a record and hand the
 * caller a function where an id belongs.
 */
export interface FieldCatalog {
  /** Every field, in the order Jira returned it. */
  readonly fields: readonly FieldInfo[];
  /** The `custom: true` subset, same order — the customfield_10xxx universe. */
  readonly custom: readonly FieldInfo[];
  /**
   * Lower-cased field NAME → every id carrying it. An array because Jira permits
   * duplicate names (two "Story Points" fields from two apps is the classic
   * case): a caller that finds two must ask, not guess.
   */
  readonly idsByName: ReadonlyMap<string, readonly string[]>;
  /** Field id → name, for rendering `customfield_10014` back as "Story Points". */
  readonly nameById: ReadonlyMap<string, string>;
}

/**
 * One entry of a create-screen field's `allowedValues`. Jira uses a different
 * object per field type (priority, option, version, component, issue type …),
 * but every one of them carries an `id` plus a human label in either `value` or
 * `name`, which is the whole surface a model needs to pick one. Fields whose
 * values are too numerous to enumerate (users, most pickers) carry no
 * `allowedValues` at all — they carry {@link CreateMetaField.autoCompleteUrl}.
 */
export interface AllowedValue {
  readonly id?: string;
  readonly value?: string;
  readonly name?: string;
}

/** One field of a create screen, from `.../issuetypes/{issueTypeId}`. */
export interface CreateMetaField {
  /** `summary`, `customfield_10014`, … — the key to send in `fields`. */
  readonly fieldId: string;
  readonly name: string;
  /** Jira's own `required` flag: an unset required field fails the create. */
  readonly required: boolean;
  readonly key?: string;
  readonly schemaType?: string;
  readonly schemaItems?: string;
  readonly customType?: string;
  readonly hasDefaultValue?: boolean;
  /** `set`, `add`, `remove`, … — the verbs `update` accepts for this field. */
  readonly operations?: readonly string[];
  readonly allowedValues?: readonly AllowedValue[];
  /** Present instead of `allowedValues` for open-ended pickers. */
  readonly autoCompleteUrl?: string;
}

/**
 * What {@link getCreateMeta} yields: the loop result over the create screen's
 * fields, plus the scope it was read for and the required subset every caller
 * computes anyway.
 */
export interface CreateMetaResult extends ClassicLoopResult<CreateMetaField> {
  /** Echoed back untouched (not encoded) so a caller can log what it asked for. */
  readonly project: string;
  readonly issueTypeId: string;
  /** `items.filter(f => f.required)`, precomputed. */
  readonly required: readonly CreateMetaField[];
}

/** One row of `GET /statuses/search`. */
export interface StatusInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /**
   * `TODO` | `IN_PROGRESS` | `DONE` — a bare STRING here, unlike the nested
   * `statusCategory` OBJECT an issue's `status` field carries. Same word, two
   * wire shapes; conflating them is how a status filter silently matches nothing.
   */
  readonly statusCategory?: string;
  /** `GLOBAL` for a tenant-wide status, `PROJECT` for a project-scoped one. */
  readonly scopeType?: string;
  /** Numeric project id when `scopeType` is `PROJECT`. */
  readonly scopeProjectId?: string;
}

/** One row of `GET /issueLinkType`. */
export interface LinkTypeInfo {
  readonly id: string;
  readonly name: string;
  /** e.g. `is blocked by` — the phrase for the INWARD issue. */
  readonly inward: string;
  /** e.g. `blocks` — the phrase for the OUTWARD issue. */
  readonly outward: string;
}

// ---------------------------------------------------------------------------
// 4. Projects
// ---------------------------------------------------------------------------

/**
 * List projects the caller can see, following `startAt` until the server says
 * `isLast` (or the page cap / budget / abort trips).
 *
 * The result carries `partial` and `stopReason` exactly as `fetchAll` reports
 * them: a `max_pages` or `budget` stop is a SUCCESSFUL read of a prefix, and the
 * tool layer turns it into a `truncated` hint rather than an error.
 */
export function listProjects(
  options: ListProjectsOptions,
): Promise<ClassicLoopResult<ProjectSummary>> {
  return runClassic(
    options,
    PROJECT_PAGE_SIZE,
    (cursor) => ({
      method: 'GET',
      path: '/project/search',
      query: {
        startAt: cursor.startAt,
        maxResults: cursor.maxResults,
        expand: options.expand ?? DEFAULT_PROJECT_EXPAND,
        query: trimmed(options.query),
        typeKey: trimmed(options.typeKey),
        orderBy: trimmed(options.orderBy),
      },
    }),
    (response) => classicPage(response, 'values', 'project search', mapProject),
  );
}

/**
 * Read one project in detail — issue types, components and versions included,
 * which is what a caller needs before `jira_create_issue`.
 *
 * A key that does not exist and a key the caller may not see are BOTH a 404 from
 * Jira (JIRA-API.md §Error response shapes); that ambiguity is spelled out by
 * `core/http.ts` when it builds the error, not here.
 */
export async function getProject(options: GetProjectOptions): Promise<ProjectDetail> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  const response = await sendOne(options, {
    method: 'GET',
    path: `/project/${project}`,
    pathTemplate: '/project/{projectIdOrKey}',
    query: { expand: options.expand ?? DEFAULT_PROJECT_DETAIL_EXPAND },
  });
  return mapProjectDetail(requireRecord(response.data, 'project'));
}

// ---------------------------------------------------------------------------
// 5. Fields — THE discovery call
// ---------------------------------------------------------------------------

/**
 * Read the whole field catalog. `GET /field` is one of the few Jira collections
 * that is NOT paginated — it answers with a bare JSON array — so there is no
 * loop here and no `partial` to report.
 *
 * Returns the raw list plus the two indexes every consumer would otherwise
 * rebuild: {@link FieldCatalog.idsByName} (name → ids, the "what is the id of
 * Story Points" question) and {@link FieldCatalog.nameById} (the reverse, for
 * rendering a `customfield_10014` a user will actually recognise).
 */
export async function listFields(options: ListFieldsOptions): Promise<FieldCatalog> {
  const response = await sendOne(options, { method: 'GET', path: '/field' });
  const raw = response.data;
  if (!Array.isArray(raw)) {
    throw shapeError(
      'GET /field answered with something other than a JSON array of fields.',
      'Re-run; if it persists the site may be behind a proxy rewriting responses.',
    );
  }
  const fields = raw.map((entry, index) =>
    mapField(requireRecord(entry, `field #${index}`)),
  );
  return buildFieldCatalog(fields);
}

/**
 * Client-side name/id filter for {@link FieldCatalog.fields} — `GET /field` takes
 * no query parameter, so the `query?` input of `jira_list_fields` (TOOLS.md) can
 * only be applied here. Case-insensitive substring over the field NAME and the
 * field ID, so both "story points" and "10016" find `customfield_10016`.
 *
 * Kept as a pure helper rather than an option of {@link listFields}: the catalog
 * indexes must stay complete even when the caller only wants to LOOK at three
 * fields, or a filtered listing would start reporting "no such field".
 */
export function filterFields(
  fields: readonly FieldInfo[],
  query: string | undefined,
): readonly FieldInfo[] {
  const needle = trimmed(query)?.toLowerCase();
  if (needle === undefined) return fields;
  return fields.filter(
    (field) =>
      field.name.toLowerCase().includes(needle) ||
      field.id.toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// 6. Create metadata — the modern per-project endpoints
// ---------------------------------------------------------------------------

/**
 * List the issue types a caller may create in one project —
 * `GET /issue/createmeta/{projectIdOrKey}/issuetypes`, the modern replacement
 * for the deprecated all-projects `createmeta` (JIRA-API.md §Custom fields).
 *
 * This is step one of the two-step create flow: pick an issue type id here, then
 * read its screen with {@link getCreateMeta}.
 */
export function listCreateMetaIssueTypes(
  options: CreateMetaIssueTypesOptions,
): Promise<ClassicLoopResult<IssueTypeRef>> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  return runClassic(
    options,
    CREATE_META_PAGE_SIZE,
    (cursor) => ({
      method: 'GET',
      path: `/issue/createmeta/${project}/issuetypes`,
      pathTemplate: '/issue/createmeta/{projectIdOrKey}/issuetypes',
      query: { startAt: cursor.startAt, maxResults: cursor.maxResults },
    }),
    // The collection key is `issueTypes` here, not `values` — this endpoint pair
    // is the one place Jira's classic pagination does not use `values`.
    (response) =>
      classicPage(response, 'issueTypes', 'createmeta issue types', mapIssueType),
  );
}

/**
 * Read one create screen: every field `POST /issue` accepts for this project +
 * issue type, with `required`, `allowedValues` and the `operations` an update may
 * use — `GET /issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}`.
 *
 * Paginated like its sibling (a screen with hundreds of custom fields is real),
 * so a `partial` result here means the screen was only partly read — the tool
 * layer must NOT present a partial screen as the complete required-field list.
 */
export async function getCreateMeta(
  options: CreateMetaOptions,
): Promise<CreateMetaResult> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  const issueTypeId = pathSegment(
    options.issueTypeId,
    'issue type id',
    'List the ids with the createmeta issue-types call (jira_get_create_meta without an issue type).',
  );
  const loop = await runClassic(
    options,
    CREATE_META_PAGE_SIZE,
    (cursor) => ({
      method: 'GET',
      path: `/issue/createmeta/${project}/issuetypes/${issueTypeId}`,
      pathTemplate: '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
      query: { startAt: cursor.startAt, maxResults: cursor.maxResults },
    }),
    (response) =>
      classicPage(response, 'fields', 'createmeta fields', mapCreateMetaField),
  );
  return {
    ...loop,
    project: options.project,
    issueTypeId: options.issueTypeId,
    required: loop.items.filter((field) => field.required),
  };
}

// ---------------------------------------------------------------------------
// 7. Statuses and link types
// ---------------------------------------------------------------------------

/**
 * List statuses via `GET /statuses/search` (classic pagination, optional
 * `projectId` filter).
 *
 * `GET /status` — the unfiltered, unpaginated legacy list — is deliberately not
 * used (TOOLS.md §Package `meta`): on a large tenant it returns thousands of
 * rows in one response and cannot be scoped to a project.
 */
export function listStatuses(
  options: ListStatusesOptions,
): Promise<ClassicLoopResult<StatusInfo>> {
  return runClassic(
    options,
    STATUS_PAGE_SIZE,
    (cursor) => ({
      method: 'GET',
      path: '/statuses/search',
      query: {
        startAt: cursor.startAt,
        maxResults: cursor.maxResults,
        projectId: trimmed(options.projectId),
        searchString: trimmed(options.searchString),
        statusCategory: trimmed(options.statusCategory),
        expand: trimmed(options.expand),
      },
    }),
    (response) => classicPage(response, 'values', 'status search', mapStatus),
  );
}

/**
 * List issue link types — `GET /issueLinkType`, unpaginated, wrapped in an
 * `issueLinkTypes` key. These are the exact `name` strings
 * `POST /issueLink` accepts, which is why `jira_link_issues` points at this call.
 */
export async function listLinkTypes(
  options: ListLinkTypesOptions,
): Promise<readonly LinkTypeInfo[]> {
  const response = await sendOne(options, { method: 'GET', path: '/issueLinkType' });
  const body = requireRecord(response.data, 'issue link types');
  const raw = body.issueLinkTypes;
  if (!Array.isArray(raw)) {
    throw shapeError(
      'GET /issueLinkType answered without an issueLinkTypes array.',
      'Re-run; if it persists, check that the site is a Jira Cloud v3 endpoint.',
    );
  }
  return raw.map((entry, index) =>
    mapLinkType(requireRecord(entry, `issue link type #${index}`)),
  );
}

// ---------------------------------------------------------------------------
// 8. Request plumbing
// ---------------------------------------------------------------------------

const PROJECT_REMEDIATION =
  'Pass a project key (e.g. ABC) or numeric id; list them with jira_list_projects.';

/**
 * Issue ONE request, stamping the caller's cancellation and call-budget deadline
 * onto it. A spec that set its own keeps it, mirroring `withLoopControls` in
 * `api/shared.ts` so single and looped reads behave identically.
 *
 * The {@link Clock} of the {@link BudgetGuard} is unused on this path — there is
 * no page boundary at which to check a deadline; `core/http.ts` enforces
 * `deadlineAt` for the request itself. It still travels in the same options
 * object so a caller passes one context to every function in this module.
 */
function sendOne(
  options: MetaOptions,
  spec: JiraRequestSpec,
): Promise<JiraResponse<unknown>> {
  return options.jira({
    ...spec,
    signal: spec.signal ?? options.signal,
    deadlineAt: spec.deadlineAt ?? options.deadlineAt,
  });
}

/**
 * Run one classic pagination loop. The `deadlineAt`/`clock` pair is rebuilt as a
 * discriminated pair rather than spread, because {@link BudgetGuard} is a UNION:
 * spreading it would let a `deadlineAt` reach `fetchAll` beside an absent clock,
 * which is the exact mistake the union exists to prevent.
 */
function runClassic<T>(
  options: MetaPagedOptions,
  pageSize: number,
  request: (cursor: ClassicCursor) => JiraRequestSpec,
  readPage: (response: JiraResponse) => ClassicPage<T>,
): Promise<ClassicLoopResult<T>> {
  const base = {
    jira: options.jira,
    signal: options.signal,
    maxPages: options.maxPages,
    pageSize: options.pageSize ?? pageSize,
    request,
    readPage,
  };
  return options.deadlineAt === undefined
    ? fetchAll<T>({ ...base, clock: options.clock })
    : fetchAll<T>({ ...base, clock: options.clock, deadlineAt: options.deadlineAt });
}

/**
 * Percent-encode ONE path segment, per the `JiraRequestSpec.path` contract
 * ("each dynamic segment must already be percent-encoded per segment by the
 * caller"). Encoding the whole path instead would eat the slashes; not encoding
 * at all would let a key smuggle a `../` into the URL.
 */
function pathSegment(value: string, what: string, remediation: string): string {
  const clean = value.trim();
  if (clean.length === 0) {
    throw new JiraError({
      kind: 'validation',
      message: `A ${what} is required and must not be empty.`,
      remediation,
    });
  }
  return encodeURIComponent(clean);
}

/** Blank query filters are omitted from the URL rather than sent as `''`. */
function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  return clean.length === 0 ? undefined : clean;
}

// ---------------------------------------------------------------------------
// 9. Guards — wire `unknown` → the shapes above
// ---------------------------------------------------------------------------

function shapeError(message: string, remediation: string): JiraError {
  return new JiraError({ kind: 'unexpected_shape', message, remediation });
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
    throw shapeError(
      `Jira returned a ${what} that is not a JSON object.`,
      'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).',
    );
  }
  return record;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Ids arrive as strings on most endpoints and as numbers on a few; normalise. */
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

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function requireField(value: string | undefined, field: string, what: string): string {
  if (value === undefined) {
    throw shapeError(
      `Jira returned a ${what} without a usable "${field}".`,
      'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).',
    );
  }
  return value;
}

/**
 * Drop `undefined`-valued keys, so a mapped object contains only what Jira
 * actually sent. Beyond tidiness this is a contract detail: these objects are
 * serialized into tool results, and `{"lead": undefined}` and an absent `lead`
 * are the same JSON but not the same object to a test or a consumer.
 */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/**
 * Narrow one page of a classic collection: the paging fields plus `items` mapped
 * from `collectionKey`. A missing or non-array collection is `unexpected_shape`
 * rather than an empty page — "zero rows" and "the response was not what we
 * think it is" must never look the same to a caller.
 */
function classicPage<T>(
  response: JiraResponse,
  collectionKey: string,
  what: string,
  map: (entry: Record<string, unknown>) => T,
): ClassicPage<T> {
  const body = requireRecord(response.data, `${what} page`);
  const raw = body[collectionKey];
  if (!Array.isArray(raw)) {
    throw shapeError(
      `A ${what} page arrived without a "${collectionKey}" array.`,
      'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).',
    );
  }
  return {
    items: raw.map((entry, index) => map(requireRecord(entry, `${what} row #${index}`))),
    isLast: readBoolean(body, 'isLast'),
    total: readNumber(body, 'total'),
    startAt: readNumber(body, 'startAt'),
    maxResults: readNumber(body, 'maxResults'),
  };
}

function mapUser(value: unknown): UserRef | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const accountId = readString(record, 'accountId');
  // A user object without an accountId is not addressable in GDPR-mode Cloud, so
  // it is dropped rather than half-reported (JIRA-API.md §Users).
  if (accountId === undefined) return undefined;
  return compact({
    accountId,
    displayName: readString(record, 'displayName'),
    active: readBoolean(record, 'active'),
  });
}

function mapProject(entry: Record<string, unknown>): ProjectSummary {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'project'),
    key: requireField(readString(entry, 'key'), 'key', 'project'),
    name: requireField(readString(entry, 'name'), 'name', 'project'),
    projectTypeKey: readString(entry, 'projectTypeKey'),
    style: readString(entry, 'style'),
    simplified: readBoolean(entry, 'simplified'),
    isPrivate: readBoolean(entry, 'isPrivate'),
    lead: mapUser(entry.lead),
  });
}

function mapProjectDetail(entry: Record<string, unknown>): ProjectDetail {
  return compact({
    ...mapProject(entry),
    description: readString(entry, 'description'),
    issueTypes: mapList(entry.issueTypes, 'issue type', mapIssueType),
    components: mapList(entry.components, 'component', mapComponent),
    versions: mapList(entry.versions, 'version', mapVersion),
  });
}

/**
 * Map an optional nested array; absent stays absent, present must be an array.
 * `null` counts as absent — Jira sends it in place of an empty optional often
 * enough that treating it as a shape violation would fail reads that are fine.
 */
function mapList<T>(
  value: unknown,
  what: string,
  map: (entry: Record<string, unknown>) => T,
): readonly T[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw shapeError(
      `Jira returned a non-array where a list of ${what}s was expected.`,
      'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).',
    );
  }
  return value.map((entry, index) => map(requireRecord(entry, `${what} #${index}`)));
}

function mapIssueType(entry: Record<string, unknown>): IssueTypeRef {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'issue type'),
    name: requireField(readString(entry, 'name'), 'name', 'issue type'),
    description: readString(entry, 'description'),
    subtask: readBoolean(entry, 'subtask'),
    hierarchyLevel: readNumber(entry, 'hierarchyLevel'),
  });
}

function mapComponent(entry: Record<string, unknown>): ComponentRef {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'component'),
    name: requireField(readString(entry, 'name'), 'name', 'component'),
    description: readString(entry, 'description'),
  });
}

function mapVersion(entry: Record<string, unknown>): VersionRef {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'version'),
    name: requireField(readString(entry, 'name'), 'name', 'version'),
    released: readBoolean(entry, 'released'),
    archived: readBoolean(entry, 'archived'),
    releaseDate: readString(entry, 'releaseDate'),
  });
}

function mapField(entry: Record<string, unknown>): FieldInfo {
  const schema = asRecord(entry.schema);
  return compact({
    id: requireField(readString(entry, 'id'), 'id', 'field'),
    name: requireField(readString(entry, 'name'), 'name', 'field'),
    key: readString(entry, 'key'),
    custom: readBoolean(entry, 'custom') ?? false,
    schemaType: schema === undefined ? undefined : readString(schema, 'type'),
    schemaItems: schema === undefined ? undefined : readString(schema, 'items'),
    customType: schema === undefined ? undefined : readString(schema, 'custom'),
    customId: schema === undefined ? undefined : readNumber(schema, 'customId'),
    clauseNames: readStringArray(entry, 'clauseNames'),
    searchable: readBoolean(entry, 'searchable'),
    orderable: readBoolean(entry, 'orderable'),
    navigable: readBoolean(entry, 'navigable'),
  });
}

function buildFieldCatalog(fields: readonly FieldInfo[]): FieldCatalog {
  const idsByName = new Map<string, string[]>();
  const nameById = new Map<string, string>();
  for (const field of fields) {
    const key = field.name.toLowerCase();
    const ids = idsByName.get(key);
    if (ids === undefined) idsByName.set(key, [field.id]);
    else ids.push(field.id);
    nameById.set(field.id, field.name);
  }
  return {
    fields,
    custom: fields.filter((field) => field.custom),
    idsByName,
    nameById,
  };
}

function mapCreateMetaField(entry: Record<string, unknown>): CreateMetaField {
  const schema = asRecord(entry.schema);
  // `fieldId` is what the modern endpoint sends; `key` is its older twin and is
  // still present, so it is the fallback rather than a second source of truth.
  const fieldId = requireField(
    readString(entry, 'fieldId') ?? readString(entry, 'key'),
    'fieldId',
    'createmeta field',
  );
  return compact({
    fieldId,
    name: readString(entry, 'name') ?? fieldId,
    required: readBoolean(entry, 'required') ?? false,
    key: readString(entry, 'key'),
    schemaType: schema === undefined ? undefined : readString(schema, 'type'),
    schemaItems: schema === undefined ? undefined : readString(schema, 'items'),
    customType: schema === undefined ? undefined : readString(schema, 'custom'),
    hasDefaultValue: readBoolean(entry, 'hasDefaultValue'),
    operations: readStringArray(entry, 'operations'),
    allowedValues: mapAllowedValues(entry.allowedValues),
    autoCompleteUrl: readString(entry, 'autoCompleteUrl'),
  });
}

function mapAllowedValues(value: unknown): readonly AllowedValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = asRecord(entry);
    if (record === undefined) return {};
    return compact({
      id: readId(record, 'id'),
      value: readString(record, 'value'),
      name: readString(record, 'name'),
    });
  });
}

function mapStatus(entry: Record<string, unknown>): StatusInfo {
  const scope = asRecord(entry.scope);
  const scopeProject = scope === undefined ? undefined : asRecord(scope.project);
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'status'),
    name: requireField(readString(entry, 'name'), 'name', 'status'),
    description: readString(entry, 'description'),
    statusCategory: readString(entry, 'statusCategory'),
    scopeType: scope === undefined ? undefined : readString(scope, 'type'),
    scopeProjectId: scopeProject === undefined ? undefined : readId(scopeProject, 'id'),
  });
}

function mapLinkType(entry: Record<string, unknown>): LinkTypeInfo {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'issue link type'),
    name: requireField(readString(entry, 'name'), 'name', 'issue link type'),
    inward: requireField(readString(entry, 'inward'), 'inward', 'issue link type'),
    outward: requireField(readString(entry, 'outward'), 'outward', 'issue link type'),
  });
}
