// api/issues/worklog-edit.ts — worklog edit (D142, D517).

import { createJiraError } from '../../core/errors.js';
import type { JiraRequestSpec } from '../../core/types.js';
import { toAdf, type AdfNode } from '../adf.js';
import type { BudgetGuard } from '../shared.js';
import { responseShapeError, send } from '../wire.js';
import {
  ISSUE_WORKLOG_ITEM_PATH_TEMPLATE,
  getWorklog,
  worklogIdSegment,
} from './deletes.js';
import { issuePath, resolveTimeSpent } from './input.js';
import { shapeWorklog } from './shape.js';
import { formatJiraTimestamp } from './time.js';
import type { IssueRequestBase, IssueWorklog, JiraVisibility } from './types.js';

// ---------------------------------------------------------------------------
// 15. Worklog edit (D142)
//
// `PUT /issue/{key}/worklog/{id}` with ONLY the fields the caller named — a
// duration, a start, a comment — so an edit of the comment does not restate the
// time and an edit of the time does not restate the comment. At least one
// field is required: a body-less PUT would report success for a no-op. The
// entry's stored visibility is read first and resent, so an edit can never
// widen who sees the entry, whatever Jira does with an omitted key (CC-510's
// hazard, on a worklog).
// ---------------------------------------------------------------------------

export interface UpdateWorklogInput {
  readonly issue: string;
  /** Numeric worklog id, as `jira_get_worklogs` reports it. */
  readonly worklogId: string | number;
  /** Mutually exclusive with {@link UpdateWorklogInput.timeSpent}. */
  readonly timeSpentSeconds?: number;
  /** Jira duration string, e.g. `2h 30m`. */
  readonly timeSpent?: string;
  /** New start, epoch milliseconds; needs {@link UpdateWorklogInput.utcOffsetMinutes}. */
  readonly startedAt?: number;
  /** D16/CC-23 — minutes east of UTC the new `started` is rendered in. */
  readonly utcOffsetMinutes?: number;
  /** The new comment; replaces the stored one outright. */
  readonly comment?: string | AdfNode;
  /** The restriction to resend; filled from the stored entry by {@link updateWorklog}. */
  readonly visibility?: JiraVisibility;
}

export type UpdateWorklogOptions = IssueRequestBase &
  Omit<UpdateWorklogInput, 'visibility'> &
  BudgetGuard;

/**
 * The worklog PUT. Each named field is sent as `addWorklogRequest` would send
 * it — the same duration rule, the same explicit-offset `started` (never `Z`),
 * the same ADF comment — and nothing else is.
 */
export function updateWorklogRequest(input: UpdateWorklogInput): JiraRequestSpec {
  const id = worklogIdSegment(input.worklogId);
  const touchesTime =
    input.timeSpentSeconds !== undefined || input.timeSpent !== undefined;
  const spent = touchesTime
    ? resolveTimeSpent({ ...input, startedAt: 0, utcOffsetMinutes: 0 })
    : {};
  if (input.startedAt !== undefined && input.utcOffsetMinutes === undefined) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'A new worklog start needs the offset to render it in, and utcOffsetMinutes ' +
        'was not supplied.',
      remediation:
        "Pass utcOffsetMinutes for the authenticated user's Jira timezone; " +
        'utcOffsetMinutesForZone converts a zone name.',
    });
  }
  if (!touchesTime && input.startedAt === undefined && input.comment === undefined) {
    throw createJiraError({
      kind: 'validation',
      reason: 'A worklog edit needs at least one change, and none was supplied.',
      remediation:
        'Pass timeSpentSeconds or timeSpent, started, or comment — whichever the ' +
        'entry should change.',
    });
  }
  return {
    method: 'PUT',
    path: issuePath(input.issue, `/worklog/${id}`),
    pathTemplate: ISSUE_WORKLOG_ITEM_PATH_TEMPLATE,
    body: {
      ...spent,
      ...(input.startedAt === undefined
        ? {}
        : { started: formatJiraTimestamp(input.startedAt, input.utcOffsetMinutes ?? 0) }),
      ...(input.comment === undefined ? {} : { comment: toAdf(input.comment) }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    },
  };
}

/**
 * Edit one worklog — `PUT /rest/api/3/issue/{issueIdOrKey}/worklog/{id}`.
 *
 * The request is validated before anything is read, then the stored entry is
 * read (a GET, so plan mode runs it and the plan shows the restriction kept)
 * and its visibility carried into the PUT. Answers with the UPDATED entry.
 */
export async function updateWorklog(
  options: UpdateWorklogOptions,
): Promise<IssueWorklog> {
  updateWorklogRequest(options);
  const stored = await getWorklog({ ...options, worklogId: options.worklogId });
  const response = await send(
    options,
    updateWorklogRequest({ ...options, visibility: stored.visibility }),
  );
  const worklog = shapeWorklog(response.data, options.deployment);
  if (worklog === undefined)
    throw responseShapeError('issue', 'the updated worklog has no string "id"');
  return worklog;
}
