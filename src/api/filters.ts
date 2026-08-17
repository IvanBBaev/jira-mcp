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
// Filter ids are positive integers and are validated BEFORE any request is
// built (D22), so a caller that passes a filter NAME where an id belongs gets
// a `validation` error naming `jira_list_filters` instead of a Jira 404 that
// reads like "the filter was deleted".
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import {
  type JiraError,
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
// 1. Endpoints, page size and the expand set
// ---------------------------------------------------------------------------

/** The search route; unlike `/filter/{id}` it carries no dynamic segment. */
export const FILTER_SEARCH_PATH = '/filter/search';

/** `pathTemplate` for the single-filter route — logs and errors show this. */
export const FILTER_PATH_TEMPLATE = '/filter/{id}';

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
  readonly signal?: AbortSignal;
}

/** The paging controls of {@link searchFilters}. */
export interface FilterPagedBase extends FilterBase {
  /** Rows per request; defaults to {@link FILTER_PAGE_SIZE}. */
  readonly pageSize?: number;
  /** Hard page cap; defaults to `DEFAULT_MAX_PAGES` from `api/shared.ts`. */
  readonly maxPages?: number;
  /** Offset to start from — resume a `max_pages` stop from its `nextStartAt`. */
  readonly startAt?: number;
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
  readonly displayName?: string;
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
  readonly description?: string;
  readonly owner?: FilterOwner;
  /** The saved JQL — the field the whole tool exists for. */
  readonly jql?: string;
  /**
   * Whether the AUTHENTICATED user favourited it. Per-caller state, so it is
   * reported by {@link getFilter} only (see {@link FILTER_SEARCH_EXPAND}).
   */
  readonly favourite?: boolean;
}

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
): Promise<ClassicLoopResult<SavedFilter>> {
  return runClassic(
    options,
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
    (response) => classicPage(response, 'values', 'filter search', mapFilter),
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
  return mapFilter(requireRecord(response.data, 'filter'));
}

// ---------------------------------------------------------------------------
// 5. Request plumbing
// ---------------------------------------------------------------------------

/**
 * Issue ONE request, stamping the caller's cancellation and call-budget
 * deadline onto it. A spec that set its own keeps it, mirroring
 * `withLoopControls` in `api/shared.ts` so single and looped reads behave
 * identically.
 */
function sendOne(
  options: FilterOptions,
  spec: JiraRequestSpec,
): Promise<JiraResponse<unknown>> {
  return options.jira({
    ...spec,
    signal: spec.signal ?? options.signal,
    deadlineAt: spec.deadlineAt ?? options.deadlineAt,
  });
}

/**
 * Run the classic pagination loop. The `deadlineAt`/`clock` pair goes through
 * {@link budgetOf} rather than being spread raw, because {@link BudgetGuard}
 * is a UNION: spreading it would let a `deadlineAt` reach `fetchAll` beside an
 * absent clock, which is the exact pairing the union exists to prevent.
 */
function runClassic<T>(
  options: FilterPagedBase & BudgetGuard,
  request: (cursor: ClassicCursor) => JiraRequestSpec,
  readPage: (response: JiraResponse) => ClassicPage<T>,
): Promise<ClassicLoopResult<T>> {
  const base = {
    jira: options.jira,
    request,
    readPage,
    pageSize: options.pageSize ?? FILTER_PAGE_SIZE,
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
 * Validate a filter id and return it as a path segment. Filter ids are always
 * positive integers, so anything else is a caller mistake — and the check
 * doubles as the guarantee that no unencoded caller string reaches the URL
 * (`JiraRequestSpec.path` requires pre-encoded segments; `[0-9]+` needs none).
 */
function filterId(value: number | string): string {
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

/** Blank query filters are omitted from the URL rather than sent as `''`. */
function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  return clean.length === 0 ? undefined : clean;
}

// ---------------------------------------------------------------------------
// 6. Guards — wire `unknown` → the shapes above
// ---------------------------------------------------------------------------

function shapeError(message: string, remediation: string): JiraError {
  return createJiraError({ kind: 'unexpected_shape', reason: message, remediation });
}

/** The one remediation every shape failure here shares. */
const SHAPE_REMEDIATION =
  'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).';

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
      SHAPE_REMEDIATION,
    );
  }
  return record;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

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

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireField(value: string | undefined, field: string, what: string): string {
  if (value === undefined) {
    throw shapeError(
      `Jira returned a ${what} without a usable "${field}".`,
      SHAPE_REMEDIATION,
    );
  }
  return value;
}

/**
 * Drop `undefined`-valued keys, so a mapped filter contains only what Jira
 * actually sent — `{"jql": undefined}` and an absent `jql` are the same JSON
 * but not the same object to a test or a consumer.
 */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
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
function mapFilter(entry: Record<string, unknown>): SavedFilter {
  return compact({
    id: requireField(readId(entry, 'id'), 'id', 'filter'),
    name: requireField(readString(entry, 'name'), 'name', 'filter'),
    description: readString(entry, 'description'),
    owner: mapOwner(entry.owner),
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
