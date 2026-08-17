// ---------------------------------------------------------------------------
// api/search.ts — JQL search and the approximate-count probe (WP-20).
//
// One endpoint family, four hard rules that everything else in this file exists
// to enforce:
//
//  1. **`/rest/api/3/search/jql` only** (D6). The legacy `/search` and
//     `/search/id` endpoints were removed server-side on 2025-08-01, so the
//     path is a constant here and the legacy spelling is never constructed.
//     Paging is token-shaped (`nextPageToken`); there is no `startAt` and no
//     `total` — the count question is answered by a SEPARATE, approximate
//     endpoint (see {@link approximateCount}).
//  2. **The loop is not ours.** Page iteration goes through
//     {@link searchPages} (`api/shared.ts`): this module supplies a `request`
//     builder and a `readPage` narrower and inherits token discipline, the page
//     cap, the abort/budget boundary checks and the stop-reason contract.
//  3. **Data + metadata, no hints.** Everything a hint would be derived from is
//     surfaced as a plain field — `partial`/`stopReason` (→ `truncated`),
//     `fieldsDefaulted` (→ `fields_defaulted`), `clamped` (→ `clamped`),
//     `restarted` (→ `pagination_restarted`), `missingRecentIssueIds` (→
//     `eventual_consistency`), `approximate` on the count. Choosing and wording
//     hints is the tool ring's job (TOOLS.md §Hint catalog).
//  4. **Jira's own errors survive.** A JQL 400 propagates exactly as
//     `core/http.ts` built it (CC-05) — Jira names the offending clause far
//     better than a rewrite could. The single exception is the expired-cursor
//     400 (CC-01), which is a PROTOCOL event, not a user error: it is caught to
//     restart the loop, or re-worded only when the token came from the caller.
//
// Corner cases implemented here: CC-01 (expired `nextPageToken`), CC-02
// (read-after-write reconciliation), CC-03 (default field set), CC-04
// (`maxResults` clamp), CC-05 (JQL 400 passthrough).
// ---------------------------------------------------------------------------

import { createJiraError, isJiraError } from '../core/errors.js';
import type {
  JiraError,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
} from '../core/types.js';
import {
  budgetOf,
  searchPages,
  type BudgetGuard,
  type PageStopReason,
  type TokenCursor,
  type TokenLoopResult,
  type TokenPage,
  type TokenPaginateBase,
} from './shared.js';

// ---------------------------------------------------------------------------
// 1. Wire constants and caps
// ---------------------------------------------------------------------------

/** The only search path this server speaks (D6). Relative to the `v3` root. */
export const SEARCH_JQL_PATH = '/search/jql';

/** The approximate-count probe (JIRA-API.md §Search). Relative to the `v3` root. */
export const APPROXIMATE_COUNT_PATH = '/search/approximate-count';

/**
 * CC-03 — the field set injected when the caller names none. `/search/jql`
 * defaults to essentially `id` alone, so an empty list is not "everything", it
 * is "nothing useful"; TOOLS.md §jira_search pins this exact list as the
 * default and the tool reports `fields_defaulted` when it was applied.
 */
export const DEFAULT_SEARCH_FIELDS: readonly string[] = Object.freeze([
  'summary',
  'status',
  'assignee',
  'priority',
  'issuetype',
  'updated',
]);

/** TOOLS.md §jira_search default page size. */
export const DEFAULT_SEARCH_MAX_RESULTS = 25;

/**
 * CC-04 — the tool-level cap. The endpoint itself allows 5000; we clamp far
 * below it because a page of issues is spent on the model's context window,
 * not on a disk.
 */
export const MAX_SEARCH_RESULTS = 100;

/** JIRA-API.md §Search — the server rejects a longer `reconcileIssues` list. */
export const MAX_RECONCILE_ISSUES = 50;

/**
 * Default page cap for {@link searchIssues}: ONE page.
 *
 * `jira_search` hands the model a `nextPageToken` and lets it decide whether the
 * next page is worth the context (TOOLS.md §jira_search), so the default call
 * reads a single page. A caller that genuinely wants a sweep (a report, a
 * bulk reconcile) passes `maxPages` explicitly and gets the shared loop's cap
 * semantics. Consequence for the tool ring: a `max_pages` stop when
 * `maxPages === 1` means "more pages exist", NOT "the result was truncated".
 */
export const DEFAULT_SEARCH_MAX_PAGES = 1;

/**
 * CC-01 — the substring that distinguishes an expired/invalid cursor from every
 * other 400 the search endpoint can produce (a JQL syntax error, an unknown
 * field). Jira returns HTTP 400 for both, so the message is the only signal.
 * Matched case-insensitively; `nextPageToken` spelled as one word is normalized
 * to the spaced form first, so both wordings Atlassian has shipped are caught.
 */
export const EXPIRED_TOKEN_MARKER = 'next page token is invalid or expired';

/**
 * CC-05 remediation. `core/http.ts` maps every 400 to the same generic advice
 * ("the messages above name the offending field"), which is right for a field
 * error and useless for JQL: the offending thing is usually an unquoted value,
 * and Jira's own message points at a character offset. This is the only place
 * that knows the body was JQL.
 */
export const JQL_REMEDIATION =
  'Check the JQL: values containing spaces need double quotes ' +
  '(project = "My Project"), field names and custom field ids come from ' +
  'jira_list_fields, and people are matched by accountId, never by username.';

// ---------------------------------------------------------------------------
// 2. Public shapes
// ---------------------------------------------------------------------------

/**
 * One issue as `/search/jql` returned it, narrowed just enough to be usable.
 *
 * `id`, `key` and `fields` are guaranteed; everything else the response carried
 * (`self`, `expand`, `changelog` from an `expand` request, `renderedFields`) is
 * preserved verbatim through the index signature. Field VALUES stay raw
 * `unknown` — projecting them (ADF → text, user objects → `{ accountId,
 * displayName, active }`) is read shaping and belongs to the tool ring.
 */
export interface SearchIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

/** The non-budget half of {@link SearchIssuesOptions}. */
export interface SearchIssuesBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** The JQL to run. Sent verbatim; a syntax error is Jira's 400 to report. */
  readonly jql: string;
  /** Fields to request. Omitted/empty → {@link DEFAULT_SEARCH_FIELDS} (CC-03). */
  readonly fields?: readonly string[];
  /** Page size; clamped to {@link MAX_SEARCH_RESULTS} (CC-04). */
  readonly maxResults?: number;
  /**
   * A cursor the CALLER already holds (the model paging on). Sent as-is: if it
   * has expired the call fails fast with remediation rather than silently
   * restarting at page one and returning rows the model has already seen (CC-01).
   */
  readonly nextPageToken?: string;
  /** `expand` sections; joined into the comma string the endpoint expects. */
  readonly expand?: readonly string[] | string;
  /**
   * Issue IDs to reconcile against the search index (CC-02). Defaults to
   * {@link SearchIssuesBase.recentlyWrittenIssueIds} when that is supplied and
   * this is not. Numeric IDs only — see {@link MAX_RECONCILE_ISSUES}.
   */
  readonly reconcileIssues?: readonly (string | number)[];
  /**
   * IDs written moments ago by this session (CC-02). Feeds `reconcileIssues` AND
   * is checked against the rows that came back, so the tool ring can say WHICH
   * write has not landed in the index yet instead of guessing from a short page.
   */
  readonly recentlyWrittenIssueIds?: readonly (string | number)[];
  /** Page cap; defaults to {@link DEFAULT_SEARCH_MAX_PAGES}. */
  readonly maxPages?: number;
  /** Cancellation from the MCP request. */
  readonly signal?: AbortSignal;
}

/** Options for {@link searchIssues}. */
export type SearchIssuesOptions = SearchIssuesBase & BudgetGuard;

/** What {@link searchIssues} returns: rows plus everything a hint is derived from. */
export interface SearchIssuesResult {
  readonly issues: readonly SearchIssue[];
  /** Unspent cursor; present only when the result is partial. */
  readonly nextPageToken?: string;
  /** How many pages were actually read. */
  readonly pages: number;
  /**
   * The page cap actually applied. Reported because `stopReason: 'max_pages'`
   * means two different things: with `maxPages === 1` (the default) it is the
   * ordinary "there is another page, here is its cursor", while with an
   * explicit sweep cap it is "the sweep was cut short". Only the tool ring can
   * tell those apart, and only if it knows the cap that produced the stop.
   */
  readonly maxPages: number;
  readonly stopReason: PageStopReason;
  /** `stopReason !== 'exhausted'`. */
  readonly partial: boolean;
  /** The field list actually sent. */
  readonly fields: readonly string[];
  /** CC-03 — the caller named no fields and the default set was injected. */
  readonly fieldsDefaulted: boolean;
  /** The page size actually sent, after clamping. */
  readonly maxResults: number;
  /** CC-04 — the requested page size exceeded the cap and was clamped. */
  readonly clamped: boolean;
  /** CC-01 — a cursor expired mid-loop and the search restarted at page one. */
  readonly restarted: boolean;
  /** CC-02 — the IDs sent as `reconcileIssues`, when any were. */
  readonly reconciledIssueIds?: readonly string[];
  /**
   * CC-02 — of {@link SearchIssuesBase.recentlyWrittenIssueIds}, the ones that
   * did NOT come back. Present (possibly empty) whenever recent IDs were
   * supplied; empty means every recent write is visible in the result.
   */
  readonly missingRecentIssueIds?: readonly string[];
}

/** The non-budget half of {@link ApproximateCountOptions}. */
export interface ApproximateCountBase {
  readonly jira: JiraRequestFn;
  readonly jql: string;
  readonly signal?: AbortSignal;
}

/** Options for {@link approximateCount}. */
export type ApproximateCountOptions = ApproximateCountBase & BudgetGuard;

/** What {@link approximateCount} returns. */
export interface ApproximateCountResult {
  /** Jira's index-derived estimate — never a guaranteed row count. */
  readonly count: number;
  /**
   * Always `true`. Kept as a field rather than as folklore so the tool ring has
   * something concrete to hang the `approximate` hint on (TOOLS.md §jira_count).
   */
  readonly approximate: true;
}

// ---------------------------------------------------------------------------
// 3. Search
// ---------------------------------------------------------------------------

/**
 * Run a JQL search over `/rest/api/3/search/jql`.
 *
 * Reads {@link DEFAULT_SEARCH_MAX_PAGES} page by default; pass `maxPages` for a
 * bounded sweep. The result is data plus metadata — no envelope, no hints.
 */
export async function searchIssues(
  options: SearchIssuesOptions,
): Promise<SearchIssuesResult> {
  const fields = resolveFields(options.fields);
  const maxResults = resolveMaxResults(options.maxResults);
  const expand = normalizeExpand(options.expand);
  const recentIds = normalizeIssueIds(
    options.recentlyWrittenIssueIds,
    'recentlyWrittenIssueIds',
  );
  const reconcileIds = normalizeIssueIds(
    options.reconcileIssues ?? options.recentlyWrittenIssueIds,
    'reconcileIssues',
  );
  const startToken = normalizeToken(options.nextPageToken);

  const buildSpec = (cursor: TokenCursor): JiraRequestSpec => ({
    method: 'POST',
    path: SEARCH_JQL_PATH,
    // A pure read that happens to use POST (the body carries the JQL), so it is
    // replayable on a 5xx/transport failure like a GET (JIRA-API.md §Retries).
    safe: true,
    body: {
      jql: options.jql,
      maxResults: maxResults.value,
      fields: [...fields.value],
      ...(expand === undefined ? {} : { expand }),
      ...(reconcileIds.length === 0 ? {} : { reconcileIssues: reconcileIds.map(Number) }),
      ...(cursor.nextPageToken === undefined
        ? {}
        : { nextPageToken: cursor.nextPageToken }),
    },
  });

  // Tracked so an expired-cursor 400 on the FIRST request can be told apart
  // from one that struck mid-loop: only the latter may restart (CC-01).
  const maxPages = options.maxPages ?? DEFAULT_SEARCH_MAX_PAGES;
  let requests = 0;
  let sentToken: string | undefined;
  const run = async (
    token: string | undefined,
  ): Promise<TokenLoopResult<SearchIssue>> => {
    requests = 0;
    sentToken = undefined;
    const base: TokenPaginateBase<SearchIssue> = {
      jira: options.jira,
      request: (cursor) => {
        requests += 1;
        sentToken = cursor.nextPageToken;
        return buildSpec(cursor);
      },
      readPage: readSearchPage,
      maxPages,
      ...(token === undefined ? {} : { startToken: token }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    return searchPages<SearchIssue>({ ...base, ...budgetOf(options) });
  };

  let restarted = false;
  let loop: TokenLoopResult<SearchIssue>;
  try {
    loop = await run(startToken);
  } catch (error) {
    if (!isExpiredTokenError(error)) throw error;
    // No cursor was on the wire, so the 400 is about something a restart cannot
    // fix — send it on untouched rather than burning a second identical call.
    if (sentToken === undefined) throw error;
    if (startToken !== undefined && requests <= 1) throw callerTokenExpired(error);
    // The cursor Jira itself handed us went stale mid-sweep. Restarting is safe
    // (the search is a read) but must happen EXACTLY once — a second expiry
    // propagates instead of spinning, and `restarted` warns the tool ring that
    // the rows before the restart point may repeat.
    restarted = true;
    loop = await run(undefined);
  }

  const returnedIds = new Set(loop.items.map((issue) => issue.id));
  return {
    issues: loop.items,
    ...(loop.nextPageToken === undefined ? {} : { nextPageToken: loop.nextPageToken }),
    pages: loop.pages,
    maxPages,
    stopReason: loop.stopReason,
    partial: loop.partial,
    fields: fields.value,
    fieldsDefaulted: fields.defaulted,
    maxResults: maxResults.value,
    clamped: maxResults.clamped,
    restarted,
    ...(reconcileIds.length === 0 ? {} : { reconciledIssueIds: reconcileIds }),
    ...(recentIds.length === 0
      ? {}
      : { missingRecentIssueIds: recentIds.filter((id) => !returnedIds.has(id)) }),
  };
}

/**
 * Ask Jira how many issues a JQL matches, via
 * `POST /rest/api/3/search/approximate-count`.
 *
 * The number is derived from the search index and drifts under concurrent
 * writes — it is an estimate by construction, which is why the result says so
 * in a field rather than pretending to be a `total`.
 */
export async function approximateCount(
  options: ApproximateCountOptions,
): Promise<ApproximateCountResult> {
  const response = await options.jira({
    method: 'POST',
    path: APPROXIMATE_COUNT_PATH,
    safe: true,
    body: { jql: options.jql },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });

  const data = response.data;
  if (!isRecord(data) || typeof data.count !== 'number' || !Number.isFinite(data.count)) {
    throw shapeError(
      `${APPROXIMATE_COUNT_PATH} did not return a numeric "count" property`,
    );
  }
  return { count: data.count, approximate: true };
}

// ---------------------------------------------------------------------------
// 4. Response narrowing
// ---------------------------------------------------------------------------

/** Narrow one `/search/jql` page: `issues` plus the cursor. */
function readSearchPage(response: JiraResponse): TokenPage<SearchIssue> {
  const data = response.data;
  if (!isRecord(data)) {
    throw shapeError(`${SEARCH_JQL_PATH} did not return a JSON object`);
  }
  const rows = data.issues;
  // A page with no `issues` array at all is legal on the last page of some
  // Jira builds; an `issues` that is present but not an array is not.
  if (rows !== undefined && !Array.isArray(rows)) {
    throw shapeError(`${SEARCH_JQL_PATH} returned a non-array "issues" property`);
  }
  return {
    items: (rows ?? []).map(toSearchIssue),
    ...(typeof data.nextPageToken === 'string'
      ? { nextPageToken: data.nextPageToken }
      : {}),
    ...(typeof data.isLast === 'boolean' ? { isLast: data.isLast } : {}),
  };
}

function toSearchIssue(row: unknown, index: number): SearchIssue {
  if (!isRecord(row)) {
    throw shapeError(`issue at position ${index} is not a JSON object`);
  }
  const { id, key } = row;
  if (typeof id !== 'string' || id === '') {
    throw shapeError(`issue at position ${index} has no string "id"`);
  }
  if (typeof key !== 'string' || key === '') {
    throw shapeError(`issue at position ${index} has no string "key"`);
  }
  return { ...row, id, key, fields: isRecord(row.fields) ? row.fields : {} };
}

// ---------------------------------------------------------------------------
// 5. Input normalization (CC-02 / CC-03 / CC-04)
// ---------------------------------------------------------------------------

function resolveFields(fields: readonly string[] | undefined): {
  readonly value: readonly string[];
  readonly defaulted: boolean;
} {
  const named = (fields ?? []).map((field) => field.trim()).filter((f) => f !== '');
  // Never send an empty list: the endpoint would answer with bare IDs (CC-03).
  return named.length === 0
    ? { value: DEFAULT_SEARCH_FIELDS, defaulted: true }
    : { value: named, defaulted: false };
}

function resolveMaxResults(requested: number | undefined): {
  readonly value: number;
  readonly clamped: boolean;
} {
  if (requested === undefined) {
    return { value: DEFAULT_SEARCH_MAX_RESULTS, clamped: false };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    throw createJiraError({
      kind: 'validation',
      reason: `maxResults must be a whole number of at least 1, received ${String(requested)}.`,
      remediation: `Pass maxResults between 1 and ${String(MAX_SEARCH_RESULTS)}, or omit it for ${String(DEFAULT_SEARCH_MAX_RESULTS)}.`,
    });
  }
  return requested > MAX_SEARCH_RESULTS
    ? { value: MAX_SEARCH_RESULTS, clamped: true }
    : { value: requested, clamped: false };
}

/**
 * Normalize an issue-ID list for the wire. `reconcileIssues` takes numeric issue
 * IDs, not keys — passing `PROJ-1` earns an opaque 400, so it is refused here
 * with the remediation that names where a real ID comes from.
 */
function normalizeIssueIds(
  ids: readonly (string | number)[] | undefined,
  field: string,
): readonly string[] {
  if (ids === undefined || ids.length === 0) return [];
  const seen = new Set<string>();
  for (const id of ids) {
    const text = String(id).trim();
    if (!/^\d+$/.test(text)) {
      throw createJiraError({
        kind: 'validation',
        reason: `${field} accepts numeric issue IDs only; received ${JSON.stringify(text)}.`,
        remediation:
          'Pass the numeric "id" an issue read or create returned, not the issue key.',
      });
    }
    seen.add(text);
  }
  if (seen.size > MAX_RECONCILE_ISSUES) {
    throw createJiraError({
      kind: 'validation',
      reason: `${field} carries ${String(seen.size)} IDs; Jira accepts at most ${String(MAX_RECONCILE_ISSUES)}.`,
      remediation: `Reconcile at most ${String(MAX_RECONCILE_ISSUES)} issue IDs per search.`,
    });
  }
  return [...seen];
}

function normalizeExpand(
  expand: readonly string[] | string | undefined,
): string | undefined {
  if (expand === undefined) return undefined;
  const parts = (typeof expand === 'string' ? expand.split(',') : expand)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join(',');
}

function normalizeToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const trimmed = token.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// 6. CC-01 — expired cursor
// ---------------------------------------------------------------------------

/**
 * Is this the expired/invalid-cursor 400, as opposed to a JQL 400 (CC-05)?
 *
 * Both arrive as `kind: 'validation'` with `httpStatus: 400`; only Jira's
 * message tells them apart, so the check is deliberately narrow — a false
 * positive would restart a search whose JQL is simply wrong, hiding the real
 * error behind a duplicate failure.
 */
function isExpiredTokenError(error: unknown): error is JiraError {
  if (!isJiraError(error) || error.httpStatus !== 400) return false;
  const text = [error.message, ...(error.jiraMessages ?? [])]
    .join(' ')
    .toLowerCase()
    .replaceAll('nextpagetoken', 'next page token');
  return text.includes(EXPIRED_TOKEN_MARKER);
}

/**
 * CC-01 — the caller's own cursor was rejected on the first request. Restarting
 * silently would replay pages the model has already read and bill them to its
 * context a second time, so this fails fast and says what to do instead.
 */
function callerTokenExpired(cause: JiraError): JiraError {
  return createJiraError({
    kind: 'validation',
    reason:
      'The nextPageToken supplied with this search is invalid or has expired. ' +
      'Search cursors are one-time-use and short-lived, and the pages behind ' +
      'this one were not re-read.',
    remediation:
      'Re-run the search from the first page (omit nextPageToken); narrow the JQL ' +
      'or raise maxResults if the earlier pages are still needed.',
    httpStatus: cause.httpStatus,
    ...(cause.jiraMessages === undefined ? {} : { jiraMessages: cause.jiraMessages }),
    cause,
  });
}

// ---------------------------------------------------------------------------
// 7. Small shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeError(what: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason: `Jira's search response could not be read: ${what}.`,
  });
}
