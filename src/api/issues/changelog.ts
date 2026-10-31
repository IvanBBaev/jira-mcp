// api/issues/changelog.ts — changelog reads: the classic page, the Cloud
// bulkfetch and the Data Center embedded block (D517).

import { createJiraError } from '../../core/errors.js';
import { asRecord, isRecord } from '../guards.js';
import { requireText, responseShapeError, send } from '../wire.js';
import { classicList } from './classic-list.js';
import { isUnknownArray, requireIssueRecord } from './errors.js';
import {
  ISSUE_REMEDIATION,
  issuePath,
  normalizeList,
  normalizePageSize,
  normalizeStartAt,
} from './input.js';
import {
  CHANGELOG_BULKFETCH_PATH,
  DEFAULT_CHANGELOG_PAGE_SIZE,
  ISSUE_CHANGELOG_PATH_TEMPLATE,
  ISSUE_PATH_TEMPLATE,
} from './paths.js';
import { shapeChangelogEntry } from './shape.js';
import {
  MAX_BULK_CHANGELOG_ISSUES,
  MAX_BULK_CHANGELOG_RESULTS,
  type ChangelogEntry,
  type ChangelogResult,
  type ChangelogsBulkResult,
  type GetChangelogsBulkOptions,
  type IssueChangelogPage,
  type ListChangelogOptions,
} from './types.js';

/**
 * Read a page of the changelog — `GET /rest/api/3/issue/{issueIdOrKey}/changelog`.
 *
 * Jira returns it OLDEST FIRST and that order is kept: re-sorting would make
 * `startAt` meaningless. "What changed recently" reads the tail (TOOLS.md).
 */
export async function listChangelog(
  options: ListChangelogOptions,
): Promise<ChangelogResult> {
  const page = await classicList<ChangelogEntry>(options, {
    defaultPageSize: DEFAULT_CHANGELOG_PAGE_SIZE,
    suffix: '/changelog',
    pathTemplate: ISSUE_CHANGELOG_PATH_TEMPLATE,
    collection: 'values',
    map: (value) => shapeChangelogEntry(value, options.deployment),
  });
  return { ...page.meta, histories: page.items };
}

/**
 * One page of the change history of up to {@link MAX_BULK_CHANGELOG_ISSUES}
 * issues — `POST /rest/api/3/changelog/bulkfetch` (D150). Histories come back
 * grouped by issue id; a page can end mid-issue, and the cursor resumes it.
 * Entries are shaped exactly like {@link listChangelog}'s. Cloud only.
 */
export async function getChangelogsBulk(
  options: GetChangelogsBulkOptions,
): Promise<ChangelogsBulkResult> {
  const requested = [
    ...new Set(
      options.issues.map((issue) =>
        requireText(issue, 'issue key or id', ISSUE_REMEDIATION),
      ),
    ),
  ];
  if (requested.length === 0 || requested.length > MAX_BULK_CHANGELOG_ISSUES) {
    throw createJiraError({
      kind: 'validation',
      reason:
        `A bulk changelog read takes 1 to ${String(MAX_BULK_CHANGELOG_ISSUES)} distinct ` +
        `keys or ids, received ${String(requested.length)}. Nothing was sent.`,
      remediation: `Split the keys into batches of at most ${String(MAX_BULK_CHANGELOG_ISSUES)}.`,
    });
  }
  const maxResults = options.maxResults;
  if (
    maxResults !== undefined &&
    (!Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > MAX_BULK_CHANGELOG_RESULTS)
  ) {
    throw createJiraError({
      kind: 'validation',
      reason:
        `maxResults must be a whole number from 1 to ${String(MAX_BULK_CHANGELOG_RESULTS)}, ` +
        `received ${String(maxResults)}. Nothing was sent.`,
      remediation: "Leave maxResults out for Jira's default page size.",
    });
  }
  const fieldIds = normalizeList(options.fieldIds);
  const token = options.nextPageToken?.trim();

  // A pure read on a POST verb, like the issue bulkfetch (D527).
  const response = await send(options, {
    method: 'POST',
    path: CHANGELOG_BULKFETCH_PATH,
    safe: true,
    body: {
      issueIdsOrKeys: requested,
      ...(fieldIds.length === 0 ? {} : { fieldIds }),
      ...(maxResults === undefined ? {} : { maxResults }),
      ...(token === undefined || token === '' ? {} : { nextPageToken: token }),
    },
  });

  const data = requireIssueRecord(response.data, 'bulk changelog read');
  const issues: IssueChangelogPage[] = [];
  const blocks = isUnknownArray(data.issueChangeLogs) ? data.issueChangeLogs : [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record === undefined) continue;
    const issueId =
      typeof record.issueId === 'string'
        ? record.issueId
        : typeof record.issueId === 'number'
          ? String(record.issueId)
          : undefined;
    if (issueId === undefined) continue;
    const histories: ChangelogEntry[] = [];
    for (const row of isUnknownArray(record.changeHistories)
      ? record.changeHistories
      : []) {
      const entry = shapeChangelogEntry(row, options.deployment);
      if (entry !== undefined) histories.push(entry);
    }
    issues.push({ issueId, histories });
  }
  const next =
    typeof data.nextPageToken === 'string' && data.nextPageToken !== ''
      ? data.nextPageToken
      : undefined;
  return {
    issues,
    requested,
    ...(fieldIds.length === 0 ? {} : { fieldIds }),
    ...(next === undefined ? {} : { nextPageToken: next }),
    hasMore: next !== undefined,
  };
}

/**
 * {@link listChangelog} on Jira Data Center — the history embedded in
 * `GET /rest/api/2/issue/{issueIdOrKey}?expand=changelog&fields=` (D114).
 *
 * Data Center has no `/issue/{key}/changelog` route (it is Cloud-only), so the
 * history is read the long-standing way: embedded in an issue read, with
 * `fields=` asking for no fields beside it. The embedded block is one window,
 * `[startAt, startAt + histories.length)` of `total`; the caller's `startAt` /
 * `maxResults` page INSIDE that window, client-side, so the result keeps the
 * Cloud shape and `nextStartAt` means the same thing. Each call re-reads the
 * issue: the window is not cached between pages.
 *
 * Truncation is never silent: when the window does not cover `[0, total)`, the
 * result carries {@link ChangelogIncomplete} with an `INCOMPLETE:` note naming
 * the reachable range, and paging stops at the window's end.
 *
 * Authors take the Data Center projection (name/key/displayName — no email, no
 * accountId); items pass through as on Cloud. UNVERIFIED: whether a Data Center
 * host caps the embedded block, and that `fields=` means "no fields" there.
 */
export async function listChangelogDataCenter(
  options: ListChangelogOptions,
): Promise<ChangelogResult> {
  const startAt = normalizeStartAt(options.startAt);
  const pageSize = normalizePageSize(options.maxResults ?? DEFAULT_CHANGELOG_PAGE_SIZE);
  const response = await send(options, {
    method: 'GET',
    root: 'v2',
    path: issuePath(options.issue),
    pathTemplate: ISSUE_PATH_TEMPLATE,
    query: { expand: 'changelog', fields: '' },
  });

  const data = requireIssueRecord(response.data, 'issue');
  if (!isRecord(data.changelog)) {
    throw responseShapeError(
      'issue',
      'the issue read embedded no "changelog" object for expand=changelog',
    );
  }
  const block = data.changelog;
  const rows = block.histories ?? [];
  if (!isUnknownArray(rows)) {
    throw responseShapeError(
      'issue',
      'the embedded changelog has a non-array "histories"',
    );
  }
  const windowStart = nonNegativeInteger(block.startAt) ?? 0;
  const windowEnd = windowStart + rows.length;
  const declared = nonNegativeInteger(block.total);
  const total = declared === undefined ? windowEnd : Math.max(declared, windowEnd);

  const pageEnd = Math.min(startAt + pageSize, windowEnd);
  const histories: ChangelogEntry[] = [];
  for (let offset = Math.max(startAt, windowStart); offset < pageEnd; offset += 1) {
    const entry = shapeChangelogEntry(rows[offset - windowStart], 'datacenter');
    if (entry !== undefined) histories.push(entry);
  }
  const more = startAt + pageSize < windowEnd;
  const complete = windowStart === 0 && windowEnd >= total;

  return {
    histories,
    pages: 1,
    stopReason: more ? 'max_pages' : 'exhausted',
    partial: more,
    startAt,
    maxResults: pageSize,
    total,
    ...(more ? { nextStartAt: startAt + pageSize } : {}),
    ...(complete
      ? {}
      : {
          incomplete: {
            reachableStartAt: windowStart,
            reachableEndAt: windowEnd,
            total,
            note: incompleteChangelogNote(windowStart, windowEnd, total),
          },
        }),
  };
}

function incompleteChangelogNote(start: number, end: number, total: number): string {
  const held =
    end === start
      ? 'none of them'
      : `only histories ${String(start)}–${String(end - 1)} (0-based, oldest first)`;
  return (
    `INCOMPLETE: this issue has ${String(total)} change histories, and Jira Data ` +
    `Center embedded ${held} in the issue read. Data Center has no paginated ` +
    'changelog route, so the rest cannot be read through this server; do not ' +
    'present this history as complete.'
  );
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
