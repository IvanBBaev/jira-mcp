// ---------------------------------------------------------------------------
// api/datacenter/search.ts — JQL search and the issue count on Jira Data Center (D106,
// D114): the classic `POST /rest/api/2/search` with offset paging carried in an
// opaque `dc1:` cursor, and the exact `total` as the count.
//
// Moved out of `api/search.ts` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { createJiraError } from '../../core/errors.js';
import type { JiraResponse } from '../../core/types.js';
import { isRecord } from '../guards.js';
import {
  type ApproximateCountOptions,
  type ApproximateCountResult,
  DEFAULT_SEARCH_MAX_PAGES,
  normalizeExpand,
  normalizeIssueIds,
  normalizeToken,
  resolveFields,
  resolveMaxResults,
  type SearchIssue,
  type SearchIssuesOptions,
  type SearchIssuesResult,
  toSearchIssue,
} from '../search.js';
import { budgetOf, type ClassicPage, fetchAll } from '../shared.js';
import { responseShapeError } from '../wire.js';

/** Data Center's search route, under the `v2` root. */
export const DATACENTER_SEARCH_PATH = '/search';

/**
 * The prefix of a Data Center cursor. Data Center pages by `startAt`, but the
 * tool contract is an opaque `nextPageToken` handed back verbatim; the offset
 * is carried inside one. Versioned, so a later format can refuse this one
 * explicitly instead of misreading it.
 */
export const DATACENTER_CURSOR_PREFIX = 'dc1:';

const DATACENTER_CURSOR_RE = /^dc1:(0|[1-9][0-9]{0,8})$/;

function encodeDataCenterCursor(startAt: number): string {
  return `${DATACENTER_CURSOR_PREFIX}${String(startAt)}`;
}

function decodeDataCenterCursor(token: string): number {
  const match = DATACENTER_CURSOR_RE.exec(token);
  if (match === null) {
    throw createJiraError({
      kind: 'validation',
      reason: `nextPageToken ${JSON.stringify(token)} is not a cursor this server issued for a Jira Data Center search.`,
      remediation:
        'Pass back data.nextPageToken exactly as the previous jira_search returned it, or omit it to start from the first page.',
    });
  }
  return Number(match[1]);
}

/**
 * {@link searchIssues} on Jira Data Center — `POST /rest/api/2/search`.
 *
 * Data Center has no `/search/jql`: it pages by `startAt` and reports a
 * `total`. The classic loop does the paging (so the budget, abort and page-cap
 * rules are the shared ones), and the offset travels to the caller inside an
 * opaque `dc1:` cursor so `jira_search` keeps one contract on both products.
 * There is no expiring cursor on Data Center, so `restarted` is always false.
 *
 * `reconcileIssues` is a Cloud feature of `/search/jql` and is refused when
 * the caller names ids; the session's own recent writes are only compared
 * against the rows (there are no Data Center writes yet, so that list is empty
 * in practice).
 */
export async function searchIssuesDataCenter(
  options: SearchIssuesOptions,
): Promise<SearchIssuesResult> {
  if (options.reconcileIssues !== undefined && options.reconcileIssues.length > 0) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'reconcileIssues is not available on Jira Data Center: it is a feature of the Cloud search endpoint.',
      remediation: 'Drop reconcileIssues.',
    });
  }
  const fields = resolveFields(options.fields);
  const maxResults = resolveMaxResults(options.maxResults);
  const expand = normalizeExpand(options.expand);
  const recentIds = normalizeIssueIds(
    options.recentlyWrittenIssueIds,
    'recentlyWrittenIssueIds',
  );
  const token = normalizeToken(options.nextPageToken);
  const startAt = token === undefined ? 0 : decodeDataCenterCursor(token);
  const maxPages = options.maxPages ?? DEFAULT_SEARCH_MAX_PAGES;

  const loop = await fetchAll<SearchIssue>({
    jira: options.jira,
    request: (cursor) => ({
      method: 'POST',
      root: 'v2',
      path: DATACENTER_SEARCH_PATH,
      // A read that uses POST for the JQL body — replayable like a GET.
      safe: true,
      body: {
        jql: options.jql,
        startAt: cursor.startAt,
        maxResults: cursor.maxResults,
        fields: [...fields.value],
        ...(expand === undefined ? {} : { expand: expand.split(',') }),
      },
    }),
    readPage: readDataCenterSearchPage,
    startAt,
    pageSize: maxResults.value,
    maxPages,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...budgetOf(options),
  });

  const returnedIds = new Set(loop.items.map((issue) => issue.id));
  return {
    issues: loop.items,
    ...(loop.nextStartAt === undefined
      ? {}
      : { nextPageToken: encodeDataCenterCursor(loop.nextStartAt) }),
    pages: loop.pages,
    maxPages,
    stopReason: loop.stopReason,
    partial: loop.partial,
    fields: fields.value,
    fieldsDefaulted: fields.defaulted,
    maxResults: maxResults.value,
    clamped: maxResults.clamped,
    restarted: false,
    ...(recentIds.length === 0
      ? {}
      : { missingRecentIssueIds: recentIds.filter((id) => !returnedIds.has(id)) }),
  };
}

function readDataCenterSearchPage(response: JiraResponse): ClassicPage<SearchIssue> {
  const data = response.data;
  const where = `/rest/api/2${DATACENTER_SEARCH_PATH}`;
  if (!isRecord(data))
    throw responseShapeError('search', `${where} did not return a JSON object`);
  const rows = data.issues ?? [];
  if (!Array.isArray(rows)) {
    throw responseShapeError('search', `${where} returned a non-array "issues" property`);
  }
  return {
    items: rows.map(toSearchIssue),
    ...(typeof data.total === 'number' ? { total: data.total } : {}),
    ...(typeof data.startAt === 'number' ? { startAt: data.startAt } : {}),
    ...(typeof data.maxResults === 'number' ? { maxResults: data.maxResults } : {}),
  };
}

/**
 * {@link approximateCount} on Jira Data Center — `POST /rest/api/2/search` with
 * `maxResults: 0`, reading `total` (D114).
 *
 * Data Center has no `/search/approximate-count`; the classic search counts the
 * matches exactly and reports them as `total`, and `maxResults: 0` asks for the
 * count alone. POST rather than `GET ?jql=` because it is the route the search
 * twin already uses, it is a documented read on Data Center, and it keeps a long
 * JQL out of the URL and the access log. One field is named so that a host that
 * ignored `maxResults: 0` would still send only a little per row.
 *
 * The result says `approximate: false`: the number is the host's own count at
 * query time, so the tool ring raises no `approximate` hint for it.
 */
export async function countIssuesDataCenter(
  options: ApproximateCountOptions,
): Promise<ApproximateCountResult> {
  const where = `/rest/api/2${DATACENTER_SEARCH_PATH}`;
  const response = await options.jira({
    method: 'POST',
    root: 'v2',
    path: DATACENTER_SEARCH_PATH,
    // A read that uses POST for the JQL body — replayable like a GET.
    safe: true,
    body: {
      jql: options.jql,
      startAt: 0,
      maxResults: 0,
      fields: [...DATACENTER_COUNT_FIELDS],
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });

  const data = response.data;
  if (
    !isRecord(data) ||
    typeof data.total !== 'number' ||
    !Number.isInteger(data.total) ||
    data.total < 0
  ) {
    throw responseShapeError(
      'search',
      `${where} did not return a non-negative integer "total" property`,
    );
  }
  return { count: data.total, approximate: false };
}

/** The one field a Data Center count names (see {@link countIssuesDataCenter}). */
const DATACENTER_COUNT_FIELDS: readonly string[] = Object.freeze(['summary']);
