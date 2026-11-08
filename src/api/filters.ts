// ---------------------------------------------------------------------------
// api/filters.ts — saved filter reads (WP-62).
//
// A Jira "filter" is a saved JQL query with a name, an owner and a share
// scope. It matters to this server for one reason: it is the shortest path
// from a human's vocabulary ("my team's escalations board") to a JQL string
// this server can actually execute. The intended flow is exactly two calls —
// `jira_list_filters` to find the filter, then its `jql` fed into
// `jira_search`.
//
// What this module owns (TOOLS.md §Package `search`):
//
//   * `GET /filter/search` — {@link searchFilters}, classic pagination
//   * `GET /filter/{id}`   — {@link getFilter}
//   * `POST /filter`       — {@link createFilter} (D147)
//   * `PUT /filter/{id}`   — {@link updateFilter} (D147)
//
// and their Jira Data Center twins (D115, stage 13.7a — UNVERIFIED against a
// real Data Center host):
//
//   * `GET /rest/api/2/filter/favourite` — {@link searchFiltersDataCenter}
//   * `GET /rest/api/2/filter/{id}`      — {@link getFilterDataCenter}
//
// Three rules, the first of which is a security boundary rather than a style
// preference:
//
//  1. **The mapper is an ALLOWLIST.** `GET /filter/{id}` answers with
//     `sharePermissions`, `editPermissions`, `subscriptions` and (on request)
//     `sharedUsers` — the tenant's access-control internals, including group
//     names and the account ids of everyone a filter is shared with. None of
//     that is anyone's business here, and none of it would help a model write
//     JQL. {@link mapFilter} therefore builds a NEW object out of the six
//     fields we promise and never spreads the wire record, so a field
//     Atlassian adds tomorrow cannot leak by default.
//  2. **Pagination is never hand-rolled** — `/filter/search` speaks the classic
//     `startAt`/`maxResults`/`total`/`isLast` model, so it goes through
//     `fetchAll` from `api/shared.ts` and inherits its page cap, budget checks
//     and stop reasons verbatim (`api/meta.ts` is the donor of this idiom).
//  3. **Wire data enters as `unknown`** and is narrowed by hand-rolled guards
//     (ARCHITECTURE.md §Typing strategy); a shape Jira should never send
//     becomes a `JiraError` with `kind: "unexpected_shape"`.
//
// The two writes (D147) touch the name, the JQL and the description — never
// the share or edit permissions. A filter created here carries no
// `sharePermissions`, so it is private to the authenticated user; an update
// sends the three allowlisted fields only.
//
// Filter ids are positive integers and are validated BEFORE any request is
// built (D22), so a caller that passes a filter NAME where an id belongs gets
// a `validation` error naming `jira_list_filters` instead of a Jira 404 that
// reads like "the filter was deleted".
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import {
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
} from '../core/types.js';
import { type BudgetGuard, type ClassicLoopResult, type ClassicPage } from './shared.js';
import { shapeDataCenterUser, type DataCenterUser } from './users.js';
import { asRecord, compact, readNumber, readString } from './guards.js';
import {
  SHAPE_REMEDIATION,
  requireField,
  requireRecord,
  requireText,
  runClassic,
  sendOne,
  shapeError,
} from './wire.js';
export {
  FILTER_FAVOURITE_PATH,
  DATACENTER_FILTER_SCOPE_NOTE,
  searchFiltersDataCenter,
  getFilterDataCenter,
} from './datacenter/filters.js';

// ---------------------------------------------------------------------------
// 1. Endpoints, page size and the expand set
// ---------------------------------------------------------------------------

/** The search route; unlike `/filter/{id}` it carries no dynamic segment. */
export const FILTER_SEARCH_PATH = '/filter/search';

/** `pathTemplate` for the single-filter route — logs and errors show this. */
export const FILTER_PATH_TEMPLATE = '/filter/{id}';

/** `POST` target of {@link createFilter} (D147). */
export const FILTER_CREATE_PATH = '/filter';

/**
 * Page size for `/filter/search`, whose documented default is 50. Over-asking
 * would be harmless (`fetchAll` compares a page against the size the SERVER
 * says it applied), but the default is also the number of rows a model can
 * usefully read at once.
 */
export const FILTER_PAGE_SIZE = 50;

/**
 * The expand set of `/filter/search`. Everything this server reports about a
 * filter beyond `id`/`name` is an EXPAND on this endpoint — without it Jira
 * answers with names and self links only, which is useless for the one job a
 * filter has here (hand its JQL to `jira_search`).
 *
 * The list is deliberately short. `sharePermissions`, `editPermissions`,
 * `subscriptions` and `sharedUsers` are expands too, and are never requested:
 * see rule 1 in the module header.
 *
 * `favourite` is ALSO an expand on this endpoint and is deliberately absent —
 * it is per-caller state, not a property of the filter, and asking for it on
 * every list row buys nothing. {@link getFilter} reports it because the
 * single-filter route returns it without an expand.
 */
export const FILTER_SEARCH_EXPAND = 'description,owner,jql';

// ---------------------------------------------------------------------------
// 2. Option shapes
// ---------------------------------------------------------------------------

/** What every call here needs: the injected wire seam and a cancellation. */
export interface FilterBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request; stamped onto every request issued. */
  readonly signal?: AbortSignal | undefined;
}

/** The paging controls of {@link searchFilters}. */
export interface FilterPagedBase extends FilterBase {
  /** Rows per request; defaults to {@link FILTER_PAGE_SIZE}. */
  readonly pageSize?: number | undefined;
  /** Hard page cap; defaults to `DEFAULT_MAX_PAGES` from `api/shared.ts`. */
  readonly maxPages?: number | undefined;
  /** Offset to start from — resume a `max_pages` stop from its `nextStartAt`. */
  readonly startAt?: number | undefined;
}

/** Options for a single-request filter read. */
export type FilterOptions = FilterBase & BudgetGuard;

/** Options for {@link searchFilters}. */
export type SearchFiltersOptions = FilterPagedBase & {
  /** Literal substring matched by Jira against the filter NAME. */
  readonly filterName?: string;
  /** Only filters owned by this account (accountId, never a username — D2/CC-19). */
  readonly accountId?: string;
} & BudgetGuard;

/** Options for {@link getFilter}. */
export type GetFilterOptions = FilterOptions & {
  /** Positive integer filter id; validated before the request is built (D22). */
  readonly filterId: number | string;
};

// ---------------------------------------------------------------------------
// 3. Result shape — the allowlist, in type form
// ---------------------------------------------------------------------------

/**
 * A filter's owner. Narrower than `UserRef` in `api/meta.ts` on purpose: the
 * only question a caller asks here is "whose filter is this", so `active` and
 * everything else Jira sends about the account is dropped.
 */
export interface FilterOwner {
  readonly accountId: string;
  readonly displayName?: string | undefined;
}

/**
 * A saved filter, reduced to what a model can act on. This is the complete set
 * of fields this server will ever report for a filter — see rule 1 in the
 * module header for why the list is closed.
 */
export interface SavedFilter {
  readonly id: string;
  readonly name: string;
  /** Free text written by a tenant user; present when expanded/returned. */
  readonly description?: string | undefined;
  /**
   * Cloud: `{accountId, displayName?}`. Data Center (D115): the Data Center
   * user projection `{name?, key?, displayName, active?}` — never an accountId.
   */
  readonly owner?: FilterOwner | DataCenterUser | undefined;
  /** The saved JQL — the field the whole tool exists for. */
  readonly jql?: string | undefined;
  /**
   * Whether the AUTHENTICATED user favourited it. Per-caller state, so it is
   * reported by {@link getFilter} only (see {@link FILTER_SEARCH_EXPAND}).
   */
  readonly favourite?: boolean | undefined;
}

/**
 * What a filter list is a list OF, when it is not what Cloud's search means.
 * Set by the Data Center twin only (D115): its one stable list route returns
 * the caller's FAVOURITE filters, so a result that silently read as "every
 * filter you can see" would be a lie. Cloud never sets it.
 */
export interface FilterListScope {
  readonly source: 'favourites';
  readonly note: string;
}

/** The result of {@link searchFilters} and {@link searchFiltersDataCenter}. */
export type FilterSearchResult = ClassicLoopResult<SavedFilter> & {
  readonly scope?: FilterListScope;
};

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

/**
 * Search saved filters — `GET /filter/search`, classic pagination.
 *
 * With no `filterName` and no `accountId` this lists every filter the caller
 * can see, which on a mature tenant is thousands of rows; the loop's page cap
 * and the one-page-per-call default of the tool ring (D20) are what keep that
 * from becoming the whole result budget.
 *
 * A `max_pages` or `budget` stop is a SUCCESSFUL read of a prefix: `partial`
 * and `stopReason` travel out exactly as `fetchAll` reports them, and the tool
 * ring renders them as paging data, never as the `truncated` hint (which
 * belongs to the `JIRA_MAX_RESULT_CHARS` rendering budget).
 */
export function searchFilters(
  options: SearchFiltersOptions,
): Promise<FilterSearchResult> {
  return runClassic(
    options,
    FILTER_PAGE_SIZE,
    (cursor) => ({
      method: 'GET',
      path: FILTER_SEARCH_PATH,
      query: {
        startAt: cursor.startAt,
        maxResults: cursor.maxResults,
        expand: FILTER_SEARCH_EXPAND,
        filterName: trimmed(options.filterName),
        accountId: trimmed(options.accountId),
      },
    }),
    (response) =>
      classicPage(response, 'values', 'filter search', (entry) =>
        mapFilter(entry, 'cloud'),
      ),
  );
}

/**
 * Read one saved filter — `GET /filter/{id}`.
 *
 * No `expand` is sent: the single-filter route returns `description`, `owner`,
 * `jql` and `favourite` by default, and its only expand options are the
 * share-scope internals this module refuses to read.
 *
 * A filter that does not exist and a filter the caller may not see are BOTH a
 * 404 from Jira (JIRA-API.md §Error response shapes); `core/http.ts` spells
 * that ambiguity out when it builds the error, not this module.
 */
export async function getFilter(options: GetFilterOptions): Promise<SavedFilter> {
  const id = filterId(options.filterId);
  const response = await sendOne(options, {
    method: 'GET',
    path: `/filter/${id}`,
    pathTemplate: FILTER_PATH_TEMPLATE,
  });
  return mapFilter(requireRecord(response.data, 'filter'), 'cloud');
}

// ---------------------------------------------------------------------------
// 4a. Writes — create and update (D147)
// ---------------------------------------------------------------------------

/** Pure input of {@link createFilterRequest}. */
export interface CreateFilterInput {
  readonly name: string;
  readonly jql: string;
  readonly description?: string;
}

/** Options for {@link createFilter}. */
export type CreateFilterOptions = FilterOptions & CreateFilterInput;

/**
 * Pure input of {@link updateFilterRequest}: the id plus the COMPLETE set of
 * the three editable fields, already merged with the live filter.
 */
export interface UpdateFilterInput {
  readonly filterId: number | string;
  readonly name: string;
  readonly jql: string;
  readonly description?: string;
}

/**
 * Options for {@link updateFilter}. Every field is optional; at least one
 * must be named. `description: ""` clears the description.
 */
export type UpdateFilterOptions = FilterOptions & {
  readonly filterId: number | string;
  readonly name?: string;
  readonly jql?: string;
  readonly description?: string;
};

/**
 * Build `POST /filter`. No `sharePermissions` and no `editPermissions` are
 * sent, so the new filter is private to its owner. Blank names and blank
 * JQL are refused before anything is built (D22).
 */
export function createFilterRequest(input: CreateFilterInput): JiraRequestSpec {
  const description = input.description?.trim();
  return {
    method: 'POST',
    path: '/filter',
    pathTemplate: FILTER_CREATE_PATH,
    body: {
      name: requireFilterText(input.name, 'name'),
      jql: requireFilterText(input.jql, 'jql'),
      ...(description === undefined || description === '' ? {} : { description }),
    },
  };
}

/** Save a JQL query as a new private filter and return it through the allowlist. */
export async function createFilter(options: CreateFilterOptions): Promise<SavedFilter> {
  const response = await sendOne(options, createFilterRequest(options));
  return mapFilter(requireRecord(response.data, 'filter'), 'cloud');
}

/**
 * Build `PUT /filter/{id}` from a merged field set. The body names the three
 * editable fields only, so the share and edit permissions are never part of
 * a request this server builds.
 */
export function updateFilterRequest(input: UpdateFilterInput): JiraRequestSpec {
  const id = filterId(input.filterId);
  return {
    method: 'PUT',
    path: `/filter/${id}`,
    pathTemplate: FILTER_PATH_TEMPLATE,
    body: {
      name: requireFilterText(input.name, 'name'),
      jql: requireFilterText(input.jql, 'jql'),
      ...(input.description === undefined
        ? {}
        : { description: input.description.trim() }),
    },
  };
}

/**
 * Edit a filter's name, JQL or description. The live filter is read first
 * and the named fields are merged over it, so the PUT always carries a full
 * name/JQL pair whatever Jira does with an omitted field; a call naming no
 * field, or a blank name or JQL, is refused before anything is sent.
 */
export async function updateFilter(options: UpdateFilterOptions): Promise<SavedFilter> {
  const id = filterId(options.filterId);
  if (
    options.name === undefined &&
    options.jql === undefined &&
    options.description === undefined
  ) {
    throw createJiraError({
      kind: 'validation',
      reason: 'A filter update needs at least one of name, jql or description.',
      remediation: 'Name the field to change; jira_get_filter shows the current values.',
    });
  }
  if (options.name !== undefined) requireFilterText(options.name, 'name');
  if (options.jql !== undefined) requireFilterText(options.jql, 'jql');
  const current = await getFilter({ ...options, filterId: id });
  const description = options.description ?? current.description;
  const response = await sendOne(
    options,
    updateFilterRequest({
      filterId: id,
      name: options.name ?? current.name,
      jql: options.jql ?? current.jql ?? '',
      ...(description === undefined ? {} : { description }),
    }),
  );
  return mapFilter(requireRecord(response.data, 'filter'), 'cloud');
}

// ---------------------------------------------------------------------------
// 5. Request plumbing
// ---------------------------------------------------------------------------

/**
 * Validate a filter id and return it as a path segment. Filter ids are always
 * positive integers, so anything else is a caller mistake — and the check
 * doubles as the guarantee that no unencoded caller string reaches the URL
 * (`JiraRequestSpec.path` requires pre-encoded segments; `[0-9]+` needs none).
 */
export function filterId(value: number | string): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `filterId must be a positive integer Jira id, received ${JSON.stringify(String(value))}.`,
      remediation: 'Call jira_list_filters to get the numeric filter id.',
    });
  }
  return text;
}

/** {@link requireText} worded for a filter field. */
function requireFilterText(value: string, field: string): string {
  return requireText(
    value,
    field,
    `Pass a non-empty ${field}.`,
    (what) => `A filter ${what} must not be blank.`,
  );
}

/** Blank query filters are omitted from the URL rather than sent as `''`. */
export function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  return clean.length === 0 ? undefined : clean;
}

// ---------------------------------------------------------------------------
// 6. Guards — wire `unknown` → the shapes above
// ---------------------------------------------------------------------------

/** Filter ids arrive as strings on `/filter/{id}` and as numbers in search rows. */
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

/**
 * Narrow one page of the classic collection: the paging fields plus `items`
 * mapped from `collectionKey`. A missing or non-array collection is
 * `unexpected_shape` rather than an empty page — "zero filters" and "the
 * response was not what we think it is" must never look the same to a caller.
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
      SHAPE_REMEDIATION,
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

/**
 * The allowlist itself. Note what is NOT here: `sharePermissions`,
 * `editPermissions`, `subscriptions`, `sharedUsers`, `searchUrl`, `viewUrl`,
 * `self`. The object is BUILT, never spread from the wire record, so the list
 * cannot grow by accident when Atlassian adds a field.
 */
export function mapFilter(
  entry: Record<string, unknown>,
  deployment: 'cloud' | 'datacenter',
): SavedFilter {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'filter'),
    name: requireField(readString(entry, 'name'), 'name', 'filter'),
    description: readString(entry, 'description'),
    owner:
      deployment === 'cloud'
        ? mapOwner(entry.owner)
        : // D115: name/key/displayName only; an owner with an accountId is dropped.
          shapeDataCenterUser(entry.owner),
    jql: readString(entry, 'jql'),
    favourite: readBoolean(entry, 'favourite'),
  });
}

function mapOwner(value: unknown): FilterOwner | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const accountId = readString(record, 'accountId');
  // An owner without an accountId is not addressable in GDPR-mode Cloud, so it
  // is dropped rather than half-reported (JIRA-API.md §Users).
  if (accountId === undefined) return undefined;
  return compact({
    accountId,
    displayName: readString(record, 'displayName'),
  });
}
