// api/issues/write.ts — the write executors (D517).

import { createJiraError, isJiraError } from '../../core/errors.js';
import { asRecord } from '../guards.js';
import { requireText, responseShapeError, send } from '../wire.js';
import { requireIssueRecord, requireString, staleTransition } from './errors.js';
import {
  commentIdSegment,
  issuePath,
  resolveAssignee,
  resolveDataCenterAssignee,
} from './input.js';
import { ISSUE_COMMENT_ITEM_PATH_TEMPLATE } from './paths.js';
import {
  addCommentRequest,
  addWorklogRequest,
  assignIssueDataCenterRequest,
  assignIssueRequest,
  createIssueRequest,
  linkIssuesRequest,
  transitionIssueRequest,
  updateCommentRequest,
  updateIssueRequest,
} from './requests.js';
import { shapeComment, shapeVisibility, shapeWorklog } from './shape.js';
import type { IssueComment, IssueWorklog, JiraVisibility } from './types.js';
import type {
  AddCommentOptions,
  AddWorklogOptions,
  AssignIssueOptions,
  AssignIssueResult,
  CreateIssueOptions,
  CreatedIssue,
  LinkIssuesOptions,
  LinkIssuesResult,
  TransitionIssueOptions,
  TransitionIssueResult,
  UpdateCommentOptions,
  UpdateIssueOptions,
  UpdateIssueResult,
} from './write-types.js';

// ---------------------------------------------------------------------------
// 7. Writes
// ---------------------------------------------------------------------------

/**
 * Create an issue — `POST /rest/api/3/issue`.
 *
 * CC-24: an unknown custom field id comes back as Jira's own 400 with
 * `errors: { customfield_10999: "Field ... cannot be set" }`, and that
 * field-level message travels out untouched — the api ring never rewrites a
 * validation error, because Jira names the offending field better than a guess.
 */
export async function createIssue(options: CreateIssueOptions): Promise<CreatedIssue> {
  const response = await send(options, createIssueRequest(options));
  const data = requireIssueRecord(response.data, 'created issue');
  return {
    id: requireString(data.id, 'issue.id'),
    key: requireString(data.key, 'issue.key'),
    ...(typeof data.self === 'string' ? { self: data.self } : {}),
  };
}

/**
 * Update an issue — `PUT /rest/api/3/issue/{issueIdOrKey}`.
 *
 * Answers 204 with no body, so the result is an acknowledgement: a caller that
 * needs the new state re-reads the issue (and CC-02 applies to searching for it).
 */
export async function updateIssue(
  options: UpdateIssueOptions,
): Promise<UpdateIssueResult> {
  await send(options, updateIssueRequest(options));
  return {
    issue: options.issue,
    updated: true,
    ...(options.notifyUsers === undefined ? {} : { notifyUsers: options.notifyUsers }),
  };
}

/**
 * Move an issue through its workflow —
 * `POST /rest/api/3/issue/{issueIdOrKey}/transitions`.
 *
 * CC-21: a transition id is workflow-specific AND time-specific — the workflow
 * can change between the `GET` that listed it and this `POST`, and Jira answers
 * that with a flat 400. Jira's own messages are preserved; only the remediation
 * is replaced, because "correct the fields" is useless advice for an id that was
 * valid a second ago.
 */
export async function transitionIssue(
  options: TransitionIssueOptions,
): Promise<TransitionIssueResult> {
  const transitionId = requireText(options.transitionId, 'transition id');
  try {
    await send(options, transitionIssueRequest(options));
  } catch (error) {
    throw isJiraError(error) && error.httpStatus === 400
      ? staleTransition(error, transitionId)
      : error;
  }
  return { issue: options.issue, transitionId, transitioned: true };
}

/** Add a comment — `POST /rest/api/3/issue/{issueIdOrKey}/comment`. */
export async function addComment(options: AddCommentOptions): Promise<IssueComment> {
  const response = await send(options, addCommentRequest(options));
  const comment = shapeComment(response.data, undefined, options.deployment);
  if (comment === undefined)
    throw responseShapeError('issue', 'the created comment has no string "id"');
  return comment;
}

/**
 * Edit a comment — `PUT /rest/api/3/issue/{issueIdOrKey}/comment/{id}`.
 *
 * Answers with the UPDATED comment, so the result is the same shape
 * {@link addComment} returns and no re-read is needed to see what was stored.
 * The body replacement is total — see {@link updateCommentRequest}.
 *
 * A comment that does not exist, one on another issue, and one the caller may
 * not edit are all a 404 from Jira; `core/http.ts` spells that out.
 */
export async function updateComment(
  options: UpdateCommentOptions,
): Promise<IssueComment> {
  const visibility =
    options.visibility === undefined
      ? await storedCommentVisibility(options)
      : options.visibility;
  const response = await send(options, updateCommentRequest({ ...options, visibility }));
  const comment = shapeComment(response.data, undefined, options.deployment);
  if (comment === undefined)
    throw responseShapeError('issue', 'the updated comment has no string "id"');
  return comment;
}

/**
 * CC-510 — the restriction an edit must carry forward. Jira reads a comment
 * `PUT` without `visibility` as "make it public", so a body-only edit of a
 * role- or group-restricted comment would publish it. The comment is read
 * first (a GET, so it runs in plan mode too and the plan shows what is kept)
 * and its stored restriction resent; `null` means it had none.
 */
async function storedCommentVisibility(
  options: UpdateCommentOptions,
): Promise<JiraVisibility | null> {
  const id = commentIdSegment(options.commentId);
  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue, `/comment/${id}`),
    pathTemplate: ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
  });
  const record = asRecord(response.data);
  if (record === undefined || typeof record.id !== 'string') {
    throw responseShapeError('issue', 'the comment to edit has no string "id"');
  }
  if (record.visibility === undefined || record.visibility === null) return null;
  const stored = shapeVisibility(record.visibility);
  if (stored?.type === undefined || (stored.value ?? stored.identifier) === undefined) {
    // A restriction this server cannot restate must not be dropped silently.
    throw responseShapeError(
      'issue',
      'the comment to edit carries a visibility without a type and a value',
    );
  }
  return stored;
}

/**
 * Assign or unassign — `PUT /rest/api/3/issue/{issueIdOrKey}/assignee`.
 *
 * Idempotent: assigning the current assignee again is a 204, not an error.
 */
export async function assignIssue(
  options: AssignIssueOptions,
): Promise<AssignIssueResult> {
  const accountId = resolveAssignee(options);
  await send(options, assignIssueRequest(options));
  return { issue: options.issue, accountId, assigned: true };
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
 * Log work — `POST /rest/api/3/issue/{issueIdOrKey}/worklog`.
 *
 * `startedAt` defaults to the injected clock, never to the host clock: `Date.now`
 * is banned outside `core/clock.ts` [eslint], so a call with neither an explicit
 * `startedAt` nor a `clock` is refused instead of silently reading the wall clock.
 */
export async function addWorklog(options: AddWorklogOptions): Promise<IssueWorklog> {
  const startedAt = options.startedAt ?? options.clock?.now();
  if (startedAt === undefined) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'addWorklog needs a start time, and neither startedAt nor a Clock was ' +
        'supplied. Time never comes from the host clock in this server.',
      remediation:
        'Pass startedAt as epoch milliseconds, or pass the injected clock so the ' +
        'default "now" can be read from it.',
    });
  }

  const response = await send(options, addWorklogRequest({ ...options, startedAt }));
  const worklog = shapeWorklog(response.data, options.deployment);
  if (worklog === undefined)
    throw responseShapeError('issue', 'the created worklog has no string "id"');
  return worklog;
}

/**
 * Link two issues — `POST /rest/api/3/issueLink`.
 *
 * Answers 201 with an empty body, so the result echoes what was linked rather
 * than inventing a link id Jira did not return.
 */
export async function linkIssues(options: LinkIssuesOptions): Promise<LinkIssuesResult> {
  await send(options, linkIssuesRequest(options));
  return {
    linkType: options.linkType.trim(),
    inwardIssue: options.inwardIssue.trim(),
    outwardIssue: options.outwardIssue.trim(),
    linked: true,
  };
}
