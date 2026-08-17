// ---------------------------------------------------------------------------
// Package `issues-delete` — the irreversible surface (D45, WP-72).
//
// Three tools that destroy data Jira cannot give back: an issue, a comment, a
// worklog entry. They are a PACKAGE of their own for one reason — a deployment
// that wants none of this sets `JIRA_PACKAGES_DENY=issues-delete` and the whole
// surface stops existing, without arguing about individual tool names.
//
// THEY ARE NOT ORDINARY WRITES. `writeTier: 'irreversible'` (mcp/write-mode.ts)
// adds two things to the standard plan/apply gate:
//
//   1. an APPLY additionally needs `JIRA_ALLOW_IRREVERSIBLE=true`. Planning is
//      always allowed, so a model can always find out what a delete would cost
//      even on a server that will never let it happen;
//   2. a PLAN carries `data.before` — the entity as it exists right now. That
//      is what this file's handlers are mostly about: each one READS the target
//      through `ctx.jira` (a GET, so plan mode lets it through), hands the
//      snapshot to `noteBeforeState`, and only then issues the delete. In plan
//      mode the delete is captured and the gate publishes the snapshot; in apply
//      mode `noteBeforeState` is a no-op and the same snapshot is echoed in the
//      receipt, because Jira answers 204 with no body and a receipt that said
//      only `{deleted: true}` would be unauditable.
//
// NOTHING HERE BRANCHES ON PLAN MODE — same rule as `issues-write.ts`, same
// reason: two code paths, one of them tested.
//
// UNLIKE `issues-write.ts`, EVERY RESULT HERE IS `_untrusted` (D15). A write
// echoes what the caller sent; a before-state is tenant-authored prose (issue
// summaries, comment bodies, display names) that this server just read out of
// somebody else's project and is about to put in front of a model that is
// deciding whether to destroy it. That is exactly the case the brand exists for.
//
// SNAPSHOTS ARE BUILT BY CONSTRUCTION (D41): every field is named and copied,
// no wire object is ever spread, and free text is excerpted rather than
// forwarded whole — the plan has to be readable, not complete.
//
// Layering: `core ← api ← mcp ← tools`. Tools are the composition root.
// ---------------------------------------------------------------------------

import {
  deleteComment,
  deleteIssue,
  deleteWorklog,
  getComment,
  getIssue,
  getWorklog,
} from '../api/issues.js';
import type {
  DeleteCommentResult,
  DeleteIssueResult,
  DeleteWorklogResult,
  IssueComment,
  IssueDetail,
  IssueWorklog,
} from '../api/issues.js';
import { defineTool, writeToolInput, z } from '../mcp/define.js';
import { ok } from '../mcp/result.js';
import { callBase, guarded } from '../mcp/tool-helpers.js';
import type { PackageSpec, ToolAnnotations, ToolResult } from '../mcp/types.js';
import { noteBeforeState } from '../mcp/write-mode.js';

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * The one quadruple `mcp/tool-helpers.ts` does not have, and cannot have:
 * `DESTRUCTIVE_WRITE_ANNOTATIONS` is destructive AND idempotent, which is right
 * for a transition or a field overwrite (doing it twice lands in the same
 * place) and wrong for a delete. A repeated delete does not re-converge — the
 * second call answers 404, so the outcome of "once" and "twice" differ, and the
 * house retry policy (JIRA-API.md §Rate limiting and retries) never replays an
 * unsafe request precisely because it cannot tell those apart. Claiming
 * idempotence here would invite exactly the replay that policy forbids.
 */
const DELETE_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

// ---------------------------------------------------------------------------
// Before-state snapshots
// ---------------------------------------------------------------------------

/** How much free text a snapshot carries; a plan is a summary, not an export. */
const EXCERPT_CHARS = 500;

/** How many subtask keys a plan lists before it just reports the count. */
const SUBTASK_PREVIEW = 20;

/** Fields the issue snapshot needs — nothing else is fetched, so nothing leaks. */
const ISSUE_BEFORE_FIELDS = ['summary', 'status', 'issuetype', 'subtasks'] as const;

interface UserBefore {
  readonly accountId?: string;
  readonly displayName?: string;
}

interface IssueBefore {
  readonly kind: 'issue';
  readonly id: string;
  readonly key: string;
  readonly summary?: string;
  readonly status?: string;
  readonly issueType?: string;
  /** Up to {@link SUBTASK_PREVIEW} keys; compare with {@link subtaskCount}. */
  readonly subtasks: readonly string[];
  readonly subtaskCount: number;
  /**
   * What the delete will do with those subtasks. It rides in the snapshot
   * because `PlanPayload.planned` carries method, path and body only — the flag
   * is a query parameter, so this is the only place a plan can state whether
   * one issue or a whole tree is about to disappear.
   */
  readonly deleteSubtasks: boolean;
}

interface CommentBefore {
  readonly kind: 'comment';
  readonly issue: string;
  readonly id: string;
  readonly author?: UserBefore;
  readonly created?: string;
  readonly updated?: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  /** JSM only: `false` marks an internal comment. */
  readonly jsdPublic?: boolean;
}

interface WorklogBefore {
  readonly kind: 'worklog';
  readonly issue: string;
  readonly id: string;
  readonly author?: UserBefore;
  readonly started?: string;
  readonly timeSpent?: string;
  readonly timeSpentSeconds?: number;
  readonly comment?: string;
  readonly commentTruncated?: boolean;
}

/** Free text, capped. The marker is a character so the cut is visible as data. */
function excerpt(text: string): { readonly text: string; readonly truncated: boolean } {
  return text.length <= EXCERPT_CHARS
    ? { text, truncated: false }
    : { text: `${text.slice(0, EXCERPT_CHARS)}…`, truncated: true };
}

/** `{accountId?, displayName?}` from an already-projected user, or nothing. */
function userBefore(user: IssueComment['author']): UserBefore | undefined {
  if (user === undefined) return undefined;
  return {
    ...(user.accountId === '' ? {} : { accountId: user.accountId }),
    ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
  };
}

/** `fields.status.name`, `fields.issuetype.name` — a record's `name`, if any. */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/** The subtask keys, by construction — wire rows are read for `key` and dropped. */
function subtaskKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const row of value as readonly unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const key = (row as { key?: unknown }).key;
    if (typeof key === 'string' && key !== '') keys.push(key);
  }
  return keys;
}

function issueBefore(detail: IssueDetail, deleteSubtasks: boolean): IssueBefore {
  const fields = detail.fields;
  const summary = fields.summary;
  const keys = subtaskKeys(fields.subtasks);
  const status = nameOf(fields.status);
  const issueType = nameOf(fields.issuetype);
  return {
    kind: 'issue',
    id: detail.id,
    key: detail.key,
    ...(typeof summary === 'string' ? { summary } : {}),
    ...(status === undefined ? {} : { status }),
    ...(issueType === undefined ? {} : { issueType }),
    subtasks: keys.slice(0, SUBTASK_PREVIEW),
    subtaskCount: keys.length,
    deleteSubtasks,
  };
}

function commentBefore(issue: string, comment: IssueComment): CommentBefore {
  const body = excerpt(comment.body);
  const author = userBefore(comment.author);
  return {
    kind: 'comment',
    issue,
    id: comment.id,
    ...(author === undefined ? {} : { author }),
    ...(comment.created === undefined ? {} : { created: comment.created }),
    ...(comment.updated === undefined ? {} : { updated: comment.updated }),
    body: body.text,
    bodyTruncated: body.truncated,
    ...(comment.jsdPublic === undefined ? {} : { jsdPublic: comment.jsdPublic }),
  };
}

function worklogBefore(issue: string, worklog: IssueWorklog): WorklogBefore {
  const author = userBefore(worklog.author);
  const comment = worklog.comment === undefined ? undefined : excerpt(worklog.comment);
  return {
    kind: 'worklog',
    issue,
    id: worklog.id,
    ...(author === undefined ? {} : { author }),
    ...(worklog.started === undefined ? {} : { started: worklog.started }),
    ...(worklog.timeSpent === undefined ? {} : { timeSpent: worklog.timeSpent }),
    ...(worklog.timeSpentSeconds === undefined
      ? {}
      : { timeSpentSeconds: worklog.timeSpentSeconds }),
    ...(comment === undefined
      ? {}
      : { comment: comment.text, commentTruncated: comment.truncated }),
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * A receipt: what the api reported, plus the snapshot the plan showed. Jira
 * answers 204 with an empty body, so `before` IS the record of what was lost —
 * the same object, under the same key, in the plan and in the apply.
 */
export interface DeletedIssue extends DeleteIssueResult {
  readonly before: IssueBefore;
}

export interface DeletedComment extends DeleteCommentResult {
  readonly before: CommentBefore;
}

export interface DeletedWorklog extends DeleteWorklogResult {
  readonly before: WorklogBefore;
}

// ---------------------------------------------------------------------------
// Shared arguments
// ---------------------------------------------------------------------------

const issueArg = z.string().min(1).describe('Issue key (PROJ-123) or numeric issue id.');

const commentIdArg = z
  .string()
  .min(1)
  .describe('Numeric comment id, as jira_get_comments reports it.');

const worklogIdArg = z
  .string()
  .min(1)
  .describe('Numeric worklog id, as jira_get_worklogs reports it.');

// ---------------------------------------------------------------------------
// jira_delete_issue
// ---------------------------------------------------------------------------

const deleteIssueInput = writeToolInput({
  issue: issueArg,
  deleteSubtasks: z
    .boolean()
    .optional()
    .describe(
      'true also deletes every subtask of this issue. Default false, which makes ' +
        'Jira REFUSE an issue that has subtasks rather than take them silently.',
    ),
});

export const deleteIssueTool = defineTool({
  name: 'jira_delete_issue',
  title: 'Delete issue',
  description:
    'Permanently delete one issue. IRREVERSIBLE: Jira has no undo and no trash for ' +
    'this, the issue and its comments, worklogs and attachments are gone. Requires ' +
    'the server to run with JIRA_ALLOW_IRREVERSIBLE=true on top of the usual plan → ' +
    'apply; without it the plan still works and shows what would be destroyed. An ' +
    'issue with subtasks is refused unless deleteSubtasks is true, which deletes ' +
    'them too. Consider closing the issue instead.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: deleteIssueInput,
  handler: async (args, ctx): Promise<ToolResult<DeletedIssue>> =>
    guarded(async () => {
      const base = callBase(ctx);
      const deleteSubtasks = args.deleteSubtasks === true;
      // A GET: it travels to Jira in plan mode too, so the plan describes the
      // issue as it is NOW rather than as the caller remembers it.
      const detail = await getIssue({
        ...base,
        issue: args.issue,
        fields: ISSUE_BEFORE_FIELDS,
      });
      const before = issueBefore(detail, deleteSubtasks);
      noteBeforeState(ctx.jira, before);

      const deleted = await deleteIssue({ ...base, issue: args.issue, deleteSubtasks });
      return ok({ ...deleted, before }, { untrusted: true });
    }),
});

// ---------------------------------------------------------------------------
// jira_delete_comment
// ---------------------------------------------------------------------------

const deleteCommentInput = writeToolInput({
  issue: issueArg,
  commentId: commentIdArg,
});

export const deleteCommentTool = defineTool({
  name: 'jira_delete_comment',
  title: 'Delete comment',
  description:
    'Permanently delete one comment from an issue. IRREVERSIBLE: the comment is not ' +
    'recoverable and the deletion is not recorded in the issue changelog. Requires ' +
    'JIRA_ALLOW_IRREVERSIBLE=true on top of the usual plan → apply; the plan works ' +
    'without it and shows the comment that would be destroyed. To correct a comment, ' +
    'jira_update_comment edits it in place instead.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: deleteCommentInput,
  handler: async (args, ctx): Promise<ToolResult<DeletedComment>> =>
    guarded(async () => {
      const base = callBase(ctx);
      const comment = await getComment({
        ...base,
        issue: args.issue,
        commentId: args.commentId,
      });
      const before = commentBefore(args.issue, comment);
      noteBeforeState(ctx.jira, before);

      const deleted = await deleteComment({
        ...base,
        issue: args.issue,
        commentId: args.commentId,
      });
      return ok({ ...deleted, before }, { untrusted: true });
    }),
});

// ---------------------------------------------------------------------------
// jira_delete_worklog
// ---------------------------------------------------------------------------

const deleteWorklogInput = writeToolInput({
  issue: issueArg,
  worklogId: worklogIdArg,
});

export const deleteWorklogTool = defineTool({
  name: 'jira_delete_worklog',
  title: 'Delete worklog',
  description:
    'Permanently delete one worklog entry from an issue. IRREVERSIBLE: the logged ' +
    'time is gone and Jira gives it back to the remaining estimate (its default ' +
    'adjustment). Requires JIRA_ALLOW_IRREVERSIBLE=true on top of the usual plan → ' +
    'apply; the plan works without it and shows the entry that would be destroyed.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: deleteWorklogInput,
  handler: async (args, ctx): Promise<ToolResult<DeletedWorklog>> =>
    guarded(async () => {
      const base = callBase(ctx);
      const worklog = await getWorklog({
        ...base,
        issue: args.issue,
        worklogId: args.worklogId,
      });
      const before = worklogBefore(args.issue, worklog);
      noteBeforeState(ctx.jira, before);

      const deleted = await deleteWorklog({
        ...base,
        issue: args.issue,
        worklogId: args.worklogId,
      });
      return ok({ ...deleted, before }, { untrusted: true });
    }),
});

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

/**
 * The `issues-delete` package. Not in the `reader` profile and not in any
 * read-only selection — `PROFILE_PACKAGES` lists packages, and this one is
 * simply absent from `reader`, so a read-only deployment cannot reach these
 * tools at all, gate or no gate.
 */
export const issuesDeletePackage: PackageSpec = {
  id: 'issues-delete',
  title: 'Issues (delete)',
  description:
    'Irreversible deletions: an issue, a comment, a worklog entry. Every tool is ' +
    'plan-gated AND needs JIRA_ALLOW_IRREVERSIBLE; every plan shows what would be ' +
    'destroyed.',
  tools: [deleteIssueTool, deleteCommentTool, deleteWorklogTool],
};
