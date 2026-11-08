// ---------------------------------------------------------------------------
// api/datacenter/agile.ts — the sprint-issue read on Jira Data Center (D502). Cloud reads
// sprint issues from `/rest/software/1.0` (D500); Data Center keeps the
// `/rest/agile/1.0` route and offset paging.
//
// Moved out of `api/agile.ts` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { createJiraError } from '../../core/errors.js';
import {
  AGILE_SPRINT_ISSUES_TEMPLATE,
  agileId,
  listAgileIssuePage,
  type ListSprintIssuesOptions,
  type SprintIssuesResult,
  trimmedOrUndefined,
} from '../agile.js';

/**
 * {@link listSprintIssues} on Jira Data Center —
 * `GET /rest/agile/1.0/sprint/{sprintId}/issue` (D502).
 *
 * Data Center has no `/rest/software/1.0`; its agile route is not deprecated
 * and still pages by `startAt` with a `total`, so this twin keeps the classic
 * loop. A `nextPageToken` names a Cloud cursor and is refused (CC-5004).
 */
export async function listSprintIssuesDataCenter(
  options: ListSprintIssuesOptions,
): Promise<SprintIssuesResult> {
  if (trimmedOrUndefined(options.nextPageToken) !== undefined) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'nextPageToken is a Jira Cloud cursor; Jira Data Center pages sprint issues by offset.',
      remediation:
        'Drop nextPageToken and resume with startAt = paging.nextStartAt from the previous result.',
    });
  }
  const sprintId = agileId(options.sprintId, 'sprintId');
  return listAgileIssuePage(
    options,
    `/sprint/${sprintId}/issue`,
    AGILE_SPRINT_ISSUES_TEMPLATE,
  );
}
