// api/issues/deletes.ts — the delete tier and its single-item reads (D45, D517).

import { createJiraError, isJiraError } from '../../core/errors.js';
import type { JiraError, JiraRequestSpec } from '../../core/types.js';
import type { BudgetGuard } from '../shared.js';
import { responseShapeError, send } from '../wire.js';
import { commentIdSegment, issuePath } from './input.js';
import { ISSUE_COMMENT_ITEM_PATH_TEMPLATE, ISSUE_PATH_TEMPLATE } from './paths.js';
import { shapeComment, shapeWorklog } from './shape.js';
import type { IssueComment, IssueRequestBase, IssueWorklog } from './types.js';

// ---------------------------------------------------------------------------
// 13. Deletes (D45 / WP-72)
//
// Appended rather than filed beside the other writes so this work package moves
// no existing line of the file. The rules in `api/issues.ts` still hold — the
// requests are unsafe (never replayed), each is split builder/executor for plan
// mode, and every dynamic segment is validated before it can reach a URL.
//
// Jira answers all three with `204 No Content`, so there is nothing to shape on
// the way out: the results echo WHAT was destroyed. The single-item reads here
// exist for the same reason — the plan of a delete has to be able to show the
// entity before it is gone, and the paged list reads cannot address one row.
// ---------------------------------------------------------------------------

/** One worklog inside the issue's log — the `DELETE` target. */
export const ISSUE_WORKLOG_ITEM_PATH_TEMPLATE = '/issue/{issueIdOrKey}/worklog/{id}';

export interface GetCommentBase extends IssueRequestBase {
  /** Issue key (`PROJ-1`) or numeric id. */
  readonly issue: string;
  /** Numeric comment id, as `jira_get_comments` reports it. */
  readonly commentId: string | number;
  /** Body rendering, exactly as {@link listComments} means it. */
  readonly format?: 'text' | 'markdown' | undefined;
}

export type GetCommentOptions = GetCommentBase & BudgetGuard;

export interface GetWorklogBase extends IssueRequestBase {
  readonly issue: string;
  /** Numeric worklog id, as `jira_get_worklogs` reports it. */
  readonly worklogId: string | number;
}

export type GetWorklogOptions = GetWorklogBase & BudgetGuard;

export interface DeleteIssueInput {
  readonly issue: string;
  /**
   * Jira's `deleteSubtasks`. Left at `false` — Jira's own default — an issue
   * that has subtasks is refused rather than silently taking the tree with it.
   */
  readonly deleteSubtasks?: boolean;
}

export type DeleteIssueOptions = IssueRequestBase & DeleteIssueInput & BudgetGuard;

export interface DeleteIssueResult {
  readonly issue: string;
  readonly deleted: true;
  /** Echoed: the receipt has to say whether the subtasks went with it. */
  readonly deleteSubtasks: boolean;
}

export interface DeleteCommentInput {
  readonly issue: string;
  readonly commentId: string | number;
}

export type DeleteCommentOptions = IssueRequestBase & DeleteCommentInput & BudgetGuard;

export interface DeleteCommentResult {
  readonly issue: string;
  readonly commentId: string;
  readonly deleted: true;
}

export interface DeleteWorklogInput {
  readonly issue: string;
  readonly worklogId: string | number;
}

export type DeleteWorklogOptions = IssueRequestBase & DeleteWorklogInput & BudgetGuard;

export interface DeleteWorklogResult {
  readonly issue: string;
  readonly worklogId: string;
  readonly deleted: true;
}

/**
 * Read ONE comment — `GET /rest/api/3/issue/{issueIdOrKey}/comment/{id}`.
 *
 * {@link listComments} is paged and ordered, so reaching a specific id through
 * it would mean walking the thread; this is one request and cannot miss. CC-16
 * applies as everywhere else: a comment on another issue, a deleted one and one
 * this account may not see are the same 404.
 */
export async function getComment(options: GetCommentOptions): Promise<IssueComment> {
  const id = commentIdSegment(options.commentId);
  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue, `/comment/${id}`),
    pathTemplate: ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
  });
  const comment = shapeComment(response.data, options.format);
  if (comment === undefined)
    throw responseShapeError('issue', 'the comment has no string "id"');
  return comment;
}

/** Read ONE worklog — `GET /rest/api/3/issue/{issueIdOrKey}/worklog/{id}`. */
export async function getWorklog(options: GetWorklogOptions): Promise<IssueWorklog> {
  const id = worklogIdSegment(options.worklogId);
  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue, `/worklog/${id}`),
    pathTemplate: ISSUE_WORKLOG_ITEM_PATH_TEMPLATE,
  });
  const worklog = shapeWorklog(response.data);
  if (worklog === undefined)
    throw responseShapeError('issue', 'the worklog has no string "id"');
  return worklog;
}

/**
 * The delete — `DELETE /rest/api/3/issue/{issueIdOrKey}`.
 *
 * `deleteSubtasks` is ALWAYS on the query string, including when it is false:
 * the difference between losing one issue and losing a tree is exactly this
 * parameter, and a plan that omitted it would under-state what the apply does.
 */
export function deleteIssueRequest(input: DeleteIssueInput): JiraRequestSpec {
  return {
    method: 'DELETE',
    path: issuePath(input.issue),
    pathTemplate: ISSUE_PATH_TEMPLATE,
    query: { deleteSubtasks: input.deleteSubtasks === true },
  };
}

export function deleteCommentRequest(input: DeleteCommentInput): JiraRequestSpec {
  const id = commentIdSegment(input.commentId);
  return {
    method: 'DELETE',
    path: issuePath(input.issue, `/comment/${id}`),
    pathTemplate: ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
  };
}

export function deleteWorklogRequest(input: DeleteWorklogInput): JiraRequestSpec {
  const id = worklogIdSegment(input.worklogId);
  return {
    method: 'DELETE',
    path: issuePath(input.issue, `/worklog/${id}`),
    pathTemplate: ISSUE_WORKLOG_ITEM_PATH_TEMPLATE,
  };
}

/**
 * Delete an issue. Answers 204; the result echoes the target and the flag.
 *
 * The 400 an issue with subtasks earns is re-aimed the way CC-21 re-aims a
 * stale transition: Jira's own messages are kept verbatim, only the remediation
 * is replaced, because the generic "correct the fields" advice cannot mention
 * the one parameter that decides how much disappears.
 */
export async function deleteIssue(
  options: DeleteIssueOptions,
): Promise<DeleteIssueResult> {
  const deleteSubtasks = options.deleteSubtasks === true;
  try {
    await send(options, deleteIssueRequest(options));
  } catch (error) {
    throw !deleteSubtasks && isJiraError(error) && error.httpStatus === 400
      ? subtaskRefusal(error, options.issue)
      : error;
  }
  return { issue: options.issue, deleted: true, deleteSubtasks };
}

/** Delete one comment. Answers 204. */
export async function deleteComment(
  options: DeleteCommentOptions,
): Promise<DeleteCommentResult> {
  const commentId = commentIdSegment(options.commentId);
  await send(options, deleteCommentRequest({ issue: options.issue, commentId }));
  return { issue: options.issue, commentId, deleted: true };
}

/**
 * Delete one worklog. Answers 204.
 *
 * `adjustEstimate` is deliberately not exposed: Jira's default (`auto`) gives
 * the logged time back to the remaining estimate, which is what "this entry was
 * a mistake" means. Any other choice edits the estimate as a side effect of a
 * delete, and that belongs in an explicit estimate write.
 */
export async function deleteWorklog(
  options: DeleteWorklogOptions,
): Promise<DeleteWorklogResult> {
  const worklogId = worklogIdSegment(options.worklogId);
  await send(options, deleteWorklogRequest({ issue: options.issue, worklogId }));
  return { issue: options.issue, worklogId, deleted: true };
}

/**
 * Validate a worklog id as a path segment (D22) — the worklog twin of
 * {@link commentIdSegment}, kept separate because the remediation has to name
 * the tool that reports the ids.
 */
export function worklogIdSegment(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `A worklog id must be a positive integer, received ${JSON.stringify(String(value))}.`,
      remediation:
        'Read the log with jira_get_worklogs and pass data.worklogs[].id, which is ' +
        'the numeric id of the entry.',
    });
  }
  return text;
}

/**
 * A 400 from the issue DELETE, re-aimed at the parameter that causes it. The
 * reason stays Jira's — the endpoint can refuse for other reasons and this must
 * not claim to know which one — while the remediation explains the flag.
 */
function subtaskRefusal(cause: JiraError, issue: string): JiraError {
  const said = cause.jiraMessages ?? [];
  return createJiraError({
    kind: 'validation',
    reason:
      `Jira refused to delete ${issue}` +
      `${said.length === 0 ? '' : `: ${said.join('; ')}`}.`,
    remediation:
      'An issue that has subtasks is refused unless deleteSubtasks is true, and ' +
      'that flag deletes the subtasks WITH the parent — read them first ' +
      '(jira_get_issue, fields: ["subtasks"]) and re-plan with deleteSubtasks: ' +
      'true only if every one of them should go too.',
    httpStatus: cause.httpStatus,
    ...(said.length === 0 ? {} : { jiraMessages: said }),
    ...(cause.detail === undefined ? {} : { detail: cause.detail }),
    cause,
  });
}
