// ---------------------------------------------------------------------------
// api/datacenter/issues.ts — the issue twins on Jira Data Center: assignment by username
// (D111) and the change history embedded by `expand=changelog` (D114).
//
// Moved out of `api/issues/*` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { createJiraError } from '../../core/errors.js';
import type { JiraRequestSpec } from '../../core/types.js';
import { isRecord } from '../guards.js';
import { incompleteChangelogNote, nonNegativeInteger } from '../issues/changelog.js';
import { isUnknownArray, requireIssueRecord } from '../issues/errors.js';
import { issuePath, normalizePageSize, normalizeStartAt } from '../issues/input.js';
import {
  DEFAULT_CHANGELOG_PAGE_SIZE,
  ISSUE_ASSIGNEE_PATH_TEMPLATE,
  ISSUE_PATH_TEMPLATE,
} from '../issues/paths.js';
import { shapeChangelogEntry } from '../issues/shape.js';
import type {
  ChangelogEntry,
  ChangelogResult,
  ListChangelogOptions,
} from '../issues/types.js';
import type {
  AssignIssueInput,
  AssignIssueOptions,
  AssignIssueResult,
} from '../issues/write-types.js';
import { refuseAccountIdOnDataCenter } from '../users.js';
import { requireText, responseShapeError, send } from '../wire.js';

/**
 * CC-22 on Jira Data Center (D111) — `username` and `unassign` are mutually
 * exclusive, one is required, and an `accountId` is refused first: Data Center
 * has none.
 */
export function resolveDataCenterAssignee(input: AssignIssueInput): string | null {
  refuseAccountIdOnDataCenter(input.accountId);
  const unassign = input.unassign === true;
  const named = input.username !== undefined && input.username.trim() !== '';
  if (unassign && named) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'username and unassign: true were both supplied, so the intended ' +
        'assignee is ambiguous.',
      remediation:
        'Pass username to assign, or unassign: true to clear the assignee — ' +
        'never both.',
    });
  }
  if (unassign) return null;
  if (!named) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'An assignment on Jira Data Center needs either a username or unassign: true.',
      remediation:
        'Jira Data Center identifies users by username — the `name` its user ' +
        'fields return.',
    });
  }
  return requireText(input.username ?? '', 'username');
}

/**
 * {@link assignIssueRequest} on Jira Data Center (D111) —
 * `PUT /rest/api/2/issue/{issueIdOrKey}/assignee` with `{ "name": … }`, and an
 * explicit `{ "name": null }` to unassign.
 */
export function assignIssueDataCenterRequest(input: AssignIssueInput): JiraRequestSpec {
  const name = resolveDataCenterAssignee(input);
  return {
    method: 'PUT',
    root: 'v2',
    path: issuePath(input.issue, '/assignee'),
    pathTemplate: ISSUE_ASSIGNEE_PATH_TEMPLATE,
    // Explicit null for the same reason as on Cloud.
    body: { name },
  };
}

/**
 * {@link assignIssue} on Jira Data Center (D111) — the user is a username. The
 * same idempotency holds; UNVERIFIED like the rest of the adapter.
 */
export async function assignIssueDataCenter(
  options: AssignIssueOptions,
): Promise<AssignIssueResult> {
  const username = resolveDataCenterAssignee(options);
  await send(options, assignIssueDataCenterRequest(options));
  return { issue: options.issue, username, assigned: true };
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
