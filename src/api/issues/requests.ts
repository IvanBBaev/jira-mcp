// api/issues/requests.ts — the pure write request builders (CC-20, D517).

import { createJiraError } from '../../core/errors.js';
import type { JiraRequestSpec } from '../../core/types.js';
import { toAdf } from '../adf.js';
import { requireText } from '../wire.js';
import {
  commentIdSegment,
  issuePath,
  keyOrIdRef,
  mergeExtraFields,
  nameOrIdRef,
  normalizeLabels,
  resolveAssignee,
  resolveDataCenterAssignee,
  resolveTimeSpent,
} from './input.js';
import {
  ISSUE_ASSIGNEE_PATH_TEMPLATE,
  ISSUE_COLLECTION_PATH,
  ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
  ISSUE_COMMENT_PATH_TEMPLATE,
  ISSUE_LINK_PATH,
  ISSUE_PATH_TEMPLATE,
  ISSUE_TRANSITIONS_PATH_TEMPLATE,
  ISSUE_WORKLOG_PATH_TEMPLATE,
} from './paths.js';
import { formatJiraTimestamp } from './time.js';
import type {
  AddCommentInput,
  AddWorklogInput,
  AssignIssueInput,
  CreateIssueInput,
  LinkIssuesInput,
  TransitionIssueInput,
  UpdateCommentInput,
  UpdateIssueInput,
} from './write-types.js';

// ---------------------------------------------------------------------------
// 6. Write request builders (CC-20)
//
// Pure functions: same input, same spec, no network, no clock. Plan mode renders
// what these return; apply sends it. None of them sets `safe` — an unsafe write
// is never replayed (JIRA-API.md §Rate limiting and retries).
// ---------------------------------------------------------------------------

export function createIssueRequest(input: CreateIssueInput): JiraRequestSpec {
  const fields: Record<string, unknown> = {
    project: keyOrIdRef(input.project, 'project key or id'),
    issuetype: nameOrIdRef(input.issueType, 'issue type name or id'),
    summary: requireText(input.summary, 'summary'),
  };
  if (input.description !== undefined) fields.description = toAdf(input.description);
  if (input.assigneeAccountId !== undefined) {
    fields.assignee = { accountId: requireText(input.assigneeAccountId, 'accountId') };
  }
  if (input.reporterAccountId !== undefined) {
    fields.reporter = { accountId: requireText(input.reporterAccountId, 'accountId') };
  }
  if (input.priority !== undefined) {
    fields.priority = nameOrIdRef(input.priority, 'priority name or id');
  }
  if (input.labels !== undefined) fields.labels = normalizeLabels(input.labels);
  if (input.parent !== undefined) {
    fields.parent = keyOrIdRef(input.parent, 'parent issue key or id');
  }
  // The system field id is all lower case: `dueDate` is an unknown field to
  // Jira and the whole create was refused (CC-196).
  if (input.dueDate !== undefined) fields.duedate = requireText(input.dueDate, 'dueDate');

  return {
    method: 'POST',
    path: ISSUE_COLLECTION_PATH,
    body: { fields: mergeExtraFields(fields, input.fields) },
  };
}

export function updateIssueRequest(input: UpdateIssueInput): JiraRequestSpec {
  // A raw `fields.labels` replaces the list exactly like the named option, so
  // it conflicts with labelsAdd/labelsRemove the same way (CC-162).
  const replacesLabels =
    input.labels !== undefined ||
    (input.fields !== undefined && Object.hasOwn(input.fields, 'labels'));
  const editsLabels = input.labelsAdd !== undefined || input.labelsRemove !== undefined;
  if (replacesLabels && editsLabels) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'labels (replace) cannot be combined with labelsAdd/labelsRemove ' +
        '(incremental): Jira rejects the same field in both "fields" and "update".',
      remediation:
        'Send labels on its own to overwrite the list, or labelsAdd/labelsRemove ' +
        'on their own to edit it without a read-modify-write race.',
    });
  }

  const fields: Record<string, unknown> = {};
  const update: Record<string, unknown> = {};

  if (input.summary !== undefined) fields.summary = requireText(input.summary, 'summary');
  if (input.description !== undefined) {
    // `null` clears the field; text or ADF replaces it WHOLESALE (CC-31).
    fields.description = input.description === null ? null : toAdf(input.description);
  }
  if (input.assigneeAccountId !== undefined) {
    fields.assignee =
      input.assigneeAccountId === null
        ? null
        : { accountId: requireText(input.assigneeAccountId, 'accountId') };
  }
  if (input.priority !== undefined) {
    fields.priority = nameOrIdRef(input.priority, 'priority name or id');
  }
  if (input.labels !== undefined) fields.labels = normalizeLabels(input.labels);
  if (input.parent !== undefined) {
    fields.parent =
      input.parent === null ? null : keyOrIdRef(input.parent, 'parent issue key or id');
  }
  if (input.dueDate !== undefined) {
    fields.duedate =
      input.dueDate === null ? null : requireText(input.dueDate, 'dueDate');
  }

  // A label both added and removed is two intents on one value: Jira applies
  // the ops in order, so the remove silently wins (CC-492).
  const labelsAdd = normalizeLabels(input.labelsAdd ?? []);
  const labelsRemove = normalizeLabels(input.labelsRemove ?? []);
  const contradicted = [
    ...new Set(labelsAdd.filter((label) => labelsRemove.includes(label))),
  ];
  if (contradicted.length > 0) {
    throw createJiraError({
      kind: 'validation',
      reason: `labelsAdd and labelsRemove both name ${contradicted.map((label) => `"${label}"`).join(', ')}.`,
      remediation: 'Name each label in labelsAdd or in labelsRemove, not in both.',
    });
  }
  const labelOps: Record<string, string>[] = [
    ...labelsAdd.map((label) => ({ add: label })),
    ...labelsRemove.map((label) => ({ remove: label })),
  ];
  if (labelOps.length > 0) update.labels = labelOps;

  const merged = mergeExtraFields(fields, input.fields);
  if (Object.keys(merged).length === 0 && Object.keys(update).length === 0) {
    throw createJiraError({
      kind: 'validation',
      reason: 'An issue update must change at least one field.',
      remediation:
        'Pass summary, description, assigneeAccountId, priority, labels, ' +
        'labelsAdd/labelsRemove, parent, dueDate or a raw fields object.',
    });
  }

  return {
    method: 'PUT',
    path: issuePath(input.issue),
    pathTemplate: ISSUE_PATH_TEMPLATE,
    query: { notifyUsers: input.notifyUsers },
    body: {
      ...(Object.keys(merged).length === 0 ? {} : { fields: merged }),
      ...(Object.keys(update).length === 0 ? {} : { update }),
    },
  };
}

export function transitionIssueRequest(input: TransitionIssueInput): JiraRequestSpec {
  const fields: Record<string, unknown> = {};
  if (input.resolution !== undefined) {
    fields.resolution = nameOrIdRef(input.resolution, 'resolution name or id');
  }
  const merged = mergeExtraFields(fields, input.fields);

  const update: Record<string, unknown> = {};
  if (input.comment !== undefined) {
    update.comment = [{ add: { body: toAdf(input.comment) } }];
  }

  return {
    method: 'POST',
    path: issuePath(input.issue, '/transitions'),
    pathTemplate: ISSUE_TRANSITIONS_PATH_TEMPLATE,
    body: {
      transition: { id: requireText(input.transitionId, 'transition id') },
      ...(Object.keys(merged).length === 0 ? {} : { fields: merged }),
      ...(Object.keys(update).length === 0 ? {} : { update }),
    },
  };
}

export function addCommentRequest(input: AddCommentInput): JiraRequestSpec {
  return {
    method: 'POST',
    path: issuePath(input.issue, '/comment'),
    pathTemplate: ISSUE_COMMENT_PATH_TEMPLATE,
    body: {
      body: toAdf(input.body),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    },
  };
}

/**
 * The edit — `PUT /issue/{issueIdOrKey}/comment/{id}`.
 *
 * Jira has no patch form for a comment: the `body` sent here REPLACES the
 * stored one in full, so a caller that wants to append must read the comment
 * first and send the whole new text (CC-31 on a comment). Everything this
 * builder does not send — author, created/updated stamps — Jira keeps, except
 * `visibility`: an absent one makes the comment public, which is why
 * {@link updateComment} fills it from the stored comment (CC-510).
 */
export function updateCommentRequest(input: UpdateCommentInput): JiraRequestSpec {
  const id = commentIdSegment(input.commentId);
  return {
    method: 'PUT',
    path: issuePath(input.issue, `/comment/${id}`),
    pathTemplate: ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
    body: {
      body: toAdf(input.body),
      ...(input.visibility === undefined || input.visibility === null
        ? {}
        : { visibility: input.visibility }),
    },
  };
}

export function assignIssueRequest(input: AssignIssueInput): JiraRequestSpec {
  const accountId = resolveAssignee(input);
  return {
    method: 'PUT',
    path: issuePath(input.issue, '/assignee'),
    pathTemplate: ISSUE_ASSIGNEE_PATH_TEMPLATE,
    // Explicit null, never an omitted key: an empty body leaves the assignee
    // untouched, which would report success for a no-op.
    body: { accountId },
  };
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
 * CC-23 — the worklog POST. `started` is formatted with an EXPLICIT offset taken
 * from `utcOffsetMinutes`; Jira rejects a `Z` suffix on this field, so
 * {@link formatJiraTimestamp} can never produce one.
 */
export function addWorklogRequest(input: AddWorklogInput): JiraRequestSpec {
  const spent = resolveTimeSpent(input);
  return {
    method: 'POST',
    path: issuePath(input.issue, '/worklog'),
    pathTemplate: ISSUE_WORKLOG_PATH_TEMPLATE,
    body: {
      ...spent,
      started: formatJiraTimestamp(input.startedAt, input.utcOffsetMinutes),
      ...(input.comment === undefined ? {} : { comment: toAdf(input.comment) }),
    },
  };
}

export function linkIssuesRequest(input: LinkIssuesInput): JiraRequestSpec {
  return {
    method: 'POST',
    path: ISSUE_LINK_PATH,
    body: {
      type: { name: requireText(input.linkType, 'link type name') },
      inwardIssue: keyOrIdRef(input.inwardIssue, 'inward issue key or id'),
      outwardIssue: keyOrIdRef(input.outwardIssue, 'outward issue key or id'),
      ...(input.comment === undefined
        ? {}
        : {
            comment: {
              body: toAdf(input.comment),
              ...(input.commentVisibility === undefined
                ? {}
                : { visibility: input.commentVisibility }),
            },
          }),
    },
  };
}
