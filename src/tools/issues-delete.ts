// ---------------------------------------------------------------------------
// Package `issues-delete` — the irreversible surface (D45, WP-72, Phases 11–12).
//
// Eight tools that destroy data Jira cannot give back: an issue, a comment, a
// worklog entry, a component, a version, a sprint, and — since Phase 12 — up
// to a thousand issues at once, deleted or bulk-edited (Phase 11 added the
// project-entity deletes; the package id predates all of them and stays for
// deny-list compatibility, CC-120/CC-126). They are a PACKAGE of their own for
// one reason — a deployment that wants none of this sets
// `JIRA_PACKAGES_DENY=issues-delete` and the whole surface stops existing,
// without arguing about individual tool names.
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
//      only `{deleted: true}` would be unauditable. The two bulk tools are the
//      exception (CC-129): pre-fetching up to a thousand issues to describe
//      them would be an incident of its own, so their before-state is the
//      request's own blast radius — a count and a capped echo of the targets —
//      and the server-side truth arrives later, from `jira_get_bulk_status`.
//
// NOTHING HERE BRANCHES ON PLAN MODE — same rule as `issues-write.ts`, same
// reason: two code paths, one of them tested.
//
// UNLIKE `issues-write.ts`, EVERY RESULT HERE IS `_untrusted` (D15). A write
// echoes what the caller sent; a before-state is tenant-authored prose (issue
// summaries, comment bodies, display names) that this server just read out of
// somebody else's project and is about to put in front of a model that is
// deciding whether to destroy it. That is exactly the case the brand exists
// for. The bulk snapshots are honestly the caller's own echo — no tenant prose
// in them — but they ride the same envelope on the same rule: one invariant
// for the whole file beats a per-tool carve-out.
//
// SNAPSHOTS ARE BUILT BY CONSTRUCTION (D41): every field is named and copied,
// no wire object is ever spread, and free text is excerpted rather than
// forwarded whole — the plan has to be readable, not complete.
//
// Layering: `core ← api ← mcp ← tools`. Tools are the composition root.
// ---------------------------------------------------------------------------

import type { AgileSprint, DeleteSprintResult } from '../api/agile.js';
import type { BulkEditAction, BulkSubmitResult } from '../api/bulk.js';
import type {
  ComponentRelatedIssueCounts,
  DeleteComponentResult,
  DeleteVersionResult,
  ProjectComponent,
  ProjectVersion,
  VersionRelatedIssueCounts,
} from '../api/collab.js';
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
import type { Hint, PackageSpec, ToolAnnotations, ToolResult } from '../mcp/types.js';
import { noteBeforeState } from '../mcp/write-mode.js';
import { labelsArg } from './issues-write.js';

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
 * idempotence here would invite exactly the replay that policy forbids. The
 * bulk submits share the quadruple for the same reason seen from the other
 * side: a replayed submit does not re-converge either — it enqueues a SECOND
 * task (CC-127).
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

/** How many bulk targets a plan echoes before it just reports the count. */
const BULK_PREVIEW = 20;

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
  /**
   * Up to {@link SUBTASK_PREVIEW} keys; compare with {@link subtaskCount}.
   * Shorter than the count for two reasons — the preview cap, and a row Jira
   * reported without a readable `key` (CC-66/CC-87).
   */
  readonly subtasks: readonly string[];
  /** How many subtask ROWS Jira reported: what `deleteSubtasks` would take. */
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

interface ComponentBefore {
  readonly kind: 'component';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly descriptionTruncated?: boolean;
  /** One string, not a user object: displayName, or the accountId without one. */
  readonly lead?: string;
  /** The project KEY when Jira sent it, else the numeric project id as text. */
  readonly project?: string;
  /**
   * How many issues reference this component — the blast radius the approver
   * reads (CC-121). Absent when Jira did not send a numeric count (CC-66), which
   * is NOT the same claim as zero.
   */
  readonly issueCount?: number;
  /**
   * Where those issues go, echoed from the arguments (CC-125). Absent means the
   * component is STRIPPED off every issue, and the plan has to say which —
   * `PlannedRequest` carries the query too, but the snapshot is what the
   * receipt echoes after the query is long gone.
   */
  readonly moveIssuesTo?: string;
}

interface VersionBefore {
  readonly kind: 'version';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly descriptionTruncated?: boolean;
  readonly archived?: boolean;
  readonly released?: boolean;
  readonly startDate?: string;
  readonly releaseDate?: string;
  /** The numeric project id as text; `mapVersion` has no key to offer. */
  readonly project?: string;
  /** Issues naming this version in `fixVersion` (CC-123). */
  readonly issuesFixedCount?: number;
  /** Issues naming this version in `affectedVersion` (CC-123). */
  readonly issuesAffectedCount?: number;
  /** Issues naming it in a custom version-picker field (CC-123). */
  readonly issueCountWithCustomFieldsShowingVersion?: number;
  /** Swap target for `fixVersion`, echoed from the arguments (CC-125). */
  readonly moveFixIssuesTo?: string;
  /**
   * Swap target for `affectedVersion` (CC-125). For both targets, ABSENT means
   * those occurrences are CLEARED — a documented outcome of the removeAndSwap
   * route (CC-122), never an input error.
   */
  readonly moveAffectedIssuesTo?: string;
}

interface SprintBefore {
  readonly kind: 'sprint';
  /** Agile ids are numbers on the wire, unlike the string ids of v3. */
  readonly id: number;
  readonly name: string;
  /**
   * `future`, `active` or `closed`, exactly as Jira reported it. Jira accepts
   * the delete in ANY state, so no client-side guard blocks it (CC-124) — this
   * field is the auditable record of what state the sprint died in.
   */
  readonly state?: string;
  readonly goal?: string;
  readonly goalTruncated?: boolean;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly completeDate?: string;
  readonly originBoardId?: number;
}

/**
 * The bulk before-state is the REQUEST, not the entities (CC-129): pre-fetching
 * up to a thousand issues to describe them would be a fan-out incident of its
 * own, and the number Jira could add — which targets are invalid or invisible —
 * arrives with the task anyway, as `invalidOrInaccessibleIssueCount` on
 * `jira_get_bulk_status`. So the plan states the blast radius the caller asked
 * for: how many, and which, capped at {@link BULK_PREVIEW}.
 */
interface BulkDeleteBefore {
  readonly kind: 'bulk-delete';
  /** Every target the request names; subtasks of selected parents die too. */
  readonly issueCount: number;
  /** Up to {@link BULK_PREVIEW} of the targets, in request order. */
  readonly issues: readonly string[];
  /** Present (and true) only when the echo is shorter than the count. */
  readonly truncated?: boolean;
}

/** What one bulk edit would write — the tool's own families, nothing derived. */
interface BulkEditsBefore {
  readonly labels?: {
    readonly action: BulkEditAction;
    readonly values: readonly string[];
  };
  readonly priorityId?: string;
  /** `null` is the recorded intent to unassign, so it survives the echo. */
  readonly assigneeAccountId?: string | null;
  readonly fixVersions?: {
    readonly action: BulkEditAction;
    readonly versionIds: readonly string[];
  };
}

interface BulkEditBefore {
  readonly kind: 'bulk-edit';
  readonly issueCount: number;
  readonly issues: readonly string[];
  readonly truncated?: boolean;
  /** The semantic change set, echoed argument for argument (CC-129). */
  readonly edits: BulkEditsBefore;
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
  const projected: UserBefore = {
    ...(user.accountId === '' ? {} : { accountId: user.accountId }),
    ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
  };
  // Jira can send an author object both of whose halves we then drop — a user
  // deleted under GDPR whose display name the tenant also withholds. Emitting
  // `"author": {}` would put a key in front of the human approving the delete
  // that answers nothing and reads as a bug; omitting it says the same thing
  // truthfully, and is what this function's contract already promised.
  return projected.accountId === undefined && projected.displayName === undefined
    ? undefined
    : projected;
}

/** `fields.status.name`, `fields.issuetype.name` — a record's `name`, if any. */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/** What Jira reported about the children: how many rows, and the named ones. */
interface SubtaskSummary {
  /** The keys of the rows Jira named, by construction — never empty strings. */
  readonly keys: readonly string[];
  /** How many ROWS Jira reported, named or not. */
  readonly count: number;
}

/**
 * Read `fields.subtasks` — counting ROWS, listing only the keys.
 *
 * CC-66 records that a `subtasks` array can carry a row without a readable
 * `key`. Leaving that row out of the LIST is right: there is nothing to name.
 * Leaving it out of the COUNT would be a lie in the one number an approver of
 * `deleteSubtasks: true` reads, because a row we could not parse is still a
 * child the delete destroys (CC-87). Counting rows means the plan can only ever
 * over-state the damage, which is the safe direction for something Jira cannot
 * undo. A `subtasks` that is not an array is Jira reporting no list at all, and
 * that is the only shape that counts zero.
 */
function subtaskSummary(value: unknown): SubtaskSummary {
  if (!Array.isArray(value)) return { keys: [], count: 0 };
  const rows = value as readonly unknown[];
  const keys: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const key = (row as { key?: unknown }).key;
    if (typeof key === 'string' && key !== '') keys.push(key);
  }
  return { keys, count: rows.length };
}

function issueBefore(detail: IssueDetail, deleteSubtasks: boolean): IssueBefore {
  const fields = detail.fields;
  const summary = fields.summary;
  const subtasks = subtaskSummary(fields.subtasks);
  const status = nameOf(fields.status);
  const issueType = nameOf(fields.issuetype);
  return {
    kind: 'issue',
    id: detail.id,
    key: detail.key,
    ...(typeof summary === 'string' ? { summary } : {}),
    ...(status === undefined ? {} : { status }),
    ...(issueType === undefined ? {} : { issueType }),
    subtasks: subtasks.keys.slice(0, SUBTASK_PREVIEW),
    subtaskCount: subtasks.count,
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

/**
 * `lead` as one string: the display name, or the accountId when that is all.
 * The api ring drops a lead without an accountId and never keeps an empty
 * display name, so whichever half is here is a non-empty string.
 */
function leadBefore(lead: ProjectComponent['lead']): string | undefined {
  return lead === undefined ? undefined : (lead.displayName ?? lead.accountId);
}

function componentBefore(
  component: ProjectComponent,
  counts: ComponentRelatedIssueCounts,
  moveIssuesTo: number | undefined,
): ComponentBefore {
  const description =
    component.description === undefined ? undefined : excerpt(component.description);
  const lead = leadBefore(component.lead);
  const project =
    component.project ??
    (component.projectId === undefined ? undefined : String(component.projectId));
  return {
    kind: 'component',
    id: component.id,
    name: component.name,
    ...(description === undefined
      ? {}
      : { description: description.text, descriptionTruncated: description.truncated }),
    ...(lead === undefined ? {} : { lead }),
    ...(project === undefined ? {} : { project }),
    ...(counts.issueCount === undefined ? {} : { issueCount: counts.issueCount }),
    ...(moveIssuesTo === undefined ? {} : { moveIssuesTo: String(moveIssuesTo) }),
  };
}

function versionBefore(
  version: ProjectVersion,
  counts: VersionRelatedIssueCounts,
  moveFixIssuesTo: number | undefined,
  moveAffectedIssuesTo: number | undefined,
): VersionBefore {
  const description =
    version.description === undefined ? undefined : excerpt(version.description);
  return {
    kind: 'version',
    id: version.id,
    name: version.name,
    ...(description === undefined
      ? {}
      : { description: description.text, descriptionTruncated: description.truncated }),
    ...(version.archived === undefined ? {} : { archived: version.archived }),
    ...(version.released === undefined ? {} : { released: version.released }),
    ...(version.startDate === undefined ? {} : { startDate: version.startDate }),
    ...(version.releaseDate === undefined ? {} : { releaseDate: version.releaseDate }),
    ...(version.projectId === undefined ? {} : { project: String(version.projectId) }),
    ...(counts.issuesFixedCount === undefined
      ? {}
      : { issuesFixedCount: counts.issuesFixedCount }),
    ...(counts.issuesAffectedCount === undefined
      ? {}
      : { issuesAffectedCount: counts.issuesAffectedCount }),
    ...(counts.issueCountWithCustomFieldsShowingVersion === undefined
      ? {}
      : {
          issueCountWithCustomFieldsShowingVersion:
            counts.issueCountWithCustomFieldsShowingVersion,
        }),
    ...(moveFixIssuesTo === undefined
      ? {}
      : { moveFixIssuesTo: String(moveFixIssuesTo) }),
    ...(moveAffectedIssuesTo === undefined
      ? {}
      : { moveAffectedIssuesTo: String(moveAffectedIssuesTo) }),
  };
}

function sprintBefore(sprint: AgileSprint): SprintBefore {
  const goal = sprint.goal === undefined ? undefined : excerpt(sprint.goal);
  return {
    kind: 'sprint',
    id: sprint.id,
    name: sprint.name,
    ...(sprint.state === undefined ? {} : { state: sprint.state }),
    ...(goal === undefined ? {} : { goal: goal.text, goalTruncated: goal.truncated }),
    ...(sprint.startDate === undefined ? {} : { startDate: sprint.startDate }),
    ...(sprint.endDate === undefined ? {} : { endDate: sprint.endDate }),
    ...(sprint.completeDate === undefined ? {} : { completeDate: sprint.completeDate }),
    ...(sprint.originBoardId === undefined
      ? {}
      : { originBoardId: sprint.originBoardId }),
  };
}

/** `{issueCount, issues (capped), truncated?}` — the half both bulk kinds share. */
function bulkTargets(issues: readonly string[]): {
  readonly issueCount: number;
  readonly issues: readonly string[];
  readonly truncated?: boolean;
} {
  return {
    issueCount: issues.length,
    issues: issues.slice(0, BULK_PREVIEW),
    ...(issues.length > BULK_PREVIEW ? { truncated: true } : {}),
  };
}

function bulkDeleteBefore(issues: readonly string[]): BulkDeleteBefore {
  return { kind: 'bulk-delete', ...bulkTargets(issues) };
}

function bulkEditBefore(args: {
  readonly issues: readonly string[];
  readonly labels?: readonly string[];
  readonly labelsAction?: BulkEditAction;
  readonly priorityId?: string;
  readonly assigneeAccountId?: string | null;
  readonly fixVersionIds?: readonly string[];
  readonly fixVersionsAction?: BulkEditAction;
}): BulkEditBefore {
  const edits: BulkEditsBefore = {
    ...(args.labels === undefined || args.labelsAction === undefined
      ? {}
      : { labels: { action: args.labelsAction, values: args.labels } }),
    ...(args.priorityId === undefined ? {} : { priorityId: args.priorityId }),
    ...(args.assigneeAccountId === undefined
      ? {}
      : { assigneeAccountId: args.assigneeAccountId }),
    ...(args.fixVersionIds === undefined || args.fixVersionsAction === undefined
      ? {}
      : {
          fixVersions: {
            action: args.fixVersionsAction,
            versionIds: args.fixVersionIds,
          },
        }),
  };
  return { kind: 'bulk-edit', ...bulkTargets(args.issues), edits };
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

export interface DeletedComponent extends DeleteComponentResult {
  readonly before: ComponentBefore;
}

export interface DeletedVersion extends DeleteVersionResult {
  readonly before: VersionBefore;
}

export interface DeletedSprint extends DeleteSprintResult {
  readonly before: SprintBefore;
}

/**
 * A bulk receipt is thinner still: Jira answers 201 with a task id and nothing
 * else, so `before` plus that id IS the whole audit record until
 * `jira_get_bulk_status` reports how the task ended.
 */
export interface BulkDeleteSubmitted extends BulkSubmitResult {
  readonly before: BulkDeleteBefore;
}

export interface BulkEditSubmitted extends BulkSubmitResult {
  readonly before: BulkEditBefore;
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

/**
 * Components, versions and sprints take NUMBERS — the same `collabIdArg`
 * pattern their read/write packages use, repeated here because those consts
 * are private to their modules on purpose. A digit string is accepted and
 * converted, because jira_list_components and jira_list_versions report ids
 * as strings.
 */
const numericIdArg = z.union([
  z.number().int().min(1),
  z
    .string()
    .regex(/^[1-9]\d*$/)
    // Past 2^53 the conversion rounds to a different id (CC-195).
    .refine((value) => Number.isSafeInteger(Number(value)), 'Not a safe integer id.')
    .transform(Number),
]);

/**
 * The bulk target list. The 1000 cap is Jira's documented request limit,
 * enforced HERE so an over-long list dies in validation and never leaves the
 * process (CC-128) — and subtasks of selected parents count against the same
 * cap server-side, so a list that validates can still be refused by Jira.
 */
const bulkIssuesArg = z
  // Trimmed here, so the plan's before-state echoes what apply sends and a
  // blank entry dies in validation, in both modes (CC-215).
  .array(z.string().trim().min(1))
  .min(1)
  // Exact duplicates dropped, first-seen order kept, BEFORE the cap: a repeat
  // neither inflates an irreversible plan's issueCount nor eats into the 1000
  // (CC-243). Key-vs-id and case aliases are left alone — only Jira knows them.
  .transform((issues) => [...new Set(issues)])
  .pipe(z.array(z.string()).max(1000))
  .describe(
    'Issue keys (PROJ-123) or numeric issue ids — at most 1000, and subtasks of ' +
      'selected parents count toward the same limit.',
  );

/** CC-131: absent means ABSENT on the wire, which leaves Jira's default (true). */
const notifyUsersArg = z
  .boolean()
  .optional()
  .describe(
    'false suppresses the bulk change notification. Omitted, the field is left ' +
      "off the request entirely and Jira's own default (notify) applies.",
  );

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
      const detail = await ctx.api.getIssue({
        ...base,
        issue: args.issue,
        fields: ISSUE_BEFORE_FIELDS,
      });
      const before = issueBefore(detail, deleteSubtasks);
      noteBeforeState(ctx.jira, before);

      const deleted = await ctx.api.deleteIssue({
        ...base,
        issue: args.issue,
        deleteSubtasks,
      });
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
      const comment = await ctx.api.getComment({
        ...base,
        issue: args.issue,
        commentId: args.commentId,
      });
      const before = commentBefore(args.issue, comment);
      noteBeforeState(ctx.jira, before);

      const deleted = await ctx.api.deleteComment({
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
      const worklog = await ctx.api.getWorklog({
        ...base,
        issue: args.issue,
        worklogId: args.worklogId,
      });
      const before = worklogBefore(args.issue, worklog);
      noteBeforeState(ctx.jira, before);

      const deleted = await ctx.api.deleteWorklog({
        ...base,
        issue: args.issue,
        worklogId: args.worklogId,
      });
      return ok({ ...deleted, before }, { untrusted: true });
    }),
});

// ---------------------------------------------------------------------------
// jira_delete_component
// ---------------------------------------------------------------------------

const deleteComponentInput = writeToolInput({
  componentId: numericIdArg.describe('Numeric component id, from jira_list_components.'),
  moveIssuesTo: numericIdArg
    .optional()
    .describe(
      'Numeric id of the component that inherits the issues. Omitted, Jira strips ' +
        'the deleted component off every issue that referenced it.',
    ),
});

export const deleteComponentTool = defineTool({
  name: 'jira_delete_component',
  title: 'Delete component',
  description:
    'Permanently delete one project component. IRREVERSIBLE: Jira has no undo, and ' +
    'every issue that references the component is rewritten — reassigned to ' +
    'moveIssuesTo when given, stripped of the component when not. Requires ' +
    'JIRA_ALLOW_IRREVERSIBLE=true on top of the usual plan → apply; the plan works ' +
    'without it and shows the component and how many issues reference it. To rename ' +
    'or re-describe a component, jira_update_component edits it in place instead.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: deleteComponentInput,
  handler: async (args, ctx): Promise<ToolResult<DeletedComponent>> =>
    guarded(async () => {
      const base = callBase(ctx);
      // Two GETs, in parallel — independent reads of the same id: the
      // component itself, and the count of issues that reference it — the
      // blast radius is the number the approver reads (CC-121).
      const [component, counts] = await Promise.all([
        ctx.api.getComponent({ ...base, componentId: args.componentId }),
        ctx.api.getComponentRelatedIssueCounts({
          ...base,
          componentId: args.componentId,
        }),
      ]);
      const before = componentBefore(component, counts, args.moveIssuesTo);
      noteBeforeState(ctx.jira, before);

      const deleted = await ctx.api.deleteComponent({
        ...base,
        componentId: args.componentId,
        moveIssuesTo: args.moveIssuesTo,
      });
      return ok({ ...deleted, before }, { untrusted: true });
    }),
});

// ---------------------------------------------------------------------------
// jira_delete_version
// ---------------------------------------------------------------------------

const deleteVersionInput = writeToolInput({
  versionId: numericIdArg.describe('Numeric version id, from jira_list_versions.'),
  moveFixIssuesTo: numericIdArg
    .optional()
    .describe(
      'Numeric id of the version that replaces this one in fixVersion fields. ' +
        'Omitted, those occurrences are cleared.',
    ),
  moveAffectedIssuesTo: numericIdArg
    .optional()
    .describe(
      'Numeric id of the version that replaces this one in affectedVersion fields. ' +
        'Omitted, those occurrences are cleared.',
    ),
});

export const deleteVersionTool = defineTool({
  name: 'jira_delete_version',
  title: 'Delete version',
  description:
    'Permanently delete one project version (a release). IRREVERSIBLE: every ' +
    'fixVersion and affectedVersion occurrence is rewritten — swapped to ' +
    'moveFixIssuesTo / moveAffectedIssuesTo when given, CLEARED when omitted, which ' +
    'is a documented outcome and not an error. Custom version-picker fields have no ' +
    'swap input and are always CLEARED of this version (the plan counts those issues). ' +
    'Requires JIRA_ALLOW_IRREVERSIBLE=true ' +
    'on top of the usual plan → apply; the plan works without it and shows the ' +
    'release with all three related-issue counts. To retire a release reversibly, ' +
    'jira_update_version with archived: true hides it instead.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: deleteVersionInput,
  handler: async (args, ctx): Promise<ToolResult<DeletedVersion>> =>
    guarded(async () => {
      const base = callBase(ctx);
      // Two GETs, in parallel — independent reads of the same id: the release
      // itself, and all three reference counts — fixVersion, affectedVersion
      // and custom pickers (CC-123).
      const [version, counts] = await Promise.all([
        ctx.api.getVersion({ ...base, versionId: args.versionId }),
        ctx.api.getVersionRelatedIssueCounts({ ...base, versionId: args.versionId }),
      ]);
      const before = versionBefore(
        version,
        counts,
        args.moveFixIssuesTo,
        args.moveAffectedIssuesTo,
      );
      noteBeforeState(ctx.jira, before);

      const deleted = await ctx.api.deleteVersion({
        ...base,
        versionId: args.versionId,
        moveFixIssuesTo: args.moveFixIssuesTo,
        moveAffectedIssuesTo: args.moveAffectedIssuesTo,
      });
      return ok({ ...deleted, before }, { untrusted: true });
    }),
});

// ---------------------------------------------------------------------------
// jira_delete_sprint
// ---------------------------------------------------------------------------

const deleteSprintInput = writeToolInput({
  sprintId: numericIdArg.describe('Sprint id, from jira_list_sprints.'),
});

export const deleteSprintTool = defineTool({
  name: 'jira_delete_sprint',
  title: 'Delete sprint',
  description:
    'Permanently delete one sprint. IRREVERSIBLE: the sprint record and its history ' +
    'are gone; its issues are NOT deleted — Jira moves the open ones to the ' +
    'backlog. Jira accepts the delete in any sprint state, so read the state in ' +
    "the plan's before-state first. Requires JIRA_ALLOW_IRREVERSIBLE=true on top " +
    'of the usual plan → apply; the plan works without it and shows the sprint ' +
    'that would be destroyed. To end an active sprint without destroying it, ' +
    'jira_close_sprint closes it instead.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: deleteSprintInput,
  handler: async (args, ctx): Promise<ToolResult<DeletedSprint>> =>
    guarded(async () => {
      const base = callBase(ctx);
      // One GET. No client-side state guard follows it (CC-124): Jira accepts
      // the delete in any state, and refusing `active` here would only push
      // callers to close-then-delete without making the loss smaller. The
      // snapshot's `state` field is the audit record instead.
      const sprint = await ctx.api.getSprint({ ...base, sprintId: args.sprintId });
      const before = sprintBefore(sprint);
      noteBeforeState(ctx.jira, before);

      const deleted = await ctx.api.deleteSprint({ ...base, sprintId: args.sprintId });
      return ok({ ...deleted, before }, { untrusted: true });
    }),
});

// ---------------------------------------------------------------------------
// jira_bulk_delete_issues
// ---------------------------------------------------------------------------

/**
 * `discovery` — the code the closed hint catalog offers for "the answer you
 * want lives one tool call away" (mcp/types.ts). A 201 from a bulk submit is
 * exactly that: ENQUEUED, not done (CC-127). Neither bulk tool ever polls the
 * queue itself — a write that blocks on a task Jira may run for minutes would
 * eat every caller's deadline budget — so the hint names the read that does.
 */
const BULK_ENQUEUED_HINT: Hint = {
  code: 'enqueued',
  message:
    'Jira ENQUEUED the bulk operation — a 201 means accepted, not done. Poll ' +
    'jira_get_bulk_status with this taskId until the task reports COMPLETE (or ' +
    'FAILED); this tool never waits on the queue itself.',
};

const bulkDeleteIssuesInput = writeToolInput({
  issues: bulkIssuesArg,
  notifyUsers: notifyUsersArg,
});

export const bulkDeleteIssuesTool = defineTool({
  name: 'jira_bulk_delete_issues',
  title: 'Bulk delete issues',
  description:
    'Permanently delete up to 1000 issues in one asynchronous bulk operation. ' +
    'IRREVERSIBLE: Jira has no undo, and subtasks of selected parents are deleted ' +
    'with them (they count toward the 1000). Requires JIRA_ALLOW_IRREVERSIBLE=true ' +
    'on top of the usual plan → apply, plus the global Bulk Change permission and ' +
    'Delete issues in every affected project. The result is a task id, not a ' +
    'finished delete — poll jira_get_bulk_status until the task completes.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: bulkDeleteIssuesInput,
  handler: async (args, ctx): Promise<ToolResult<BulkDeleteSubmitted>> =>
    guarded(async () => {
      // No GET before the write (CC-129): the before-state is the request's
      // own blast radius, built locally, so a plan makes NO network calls.
      const before = bulkDeleteBefore(args.issues);
      noteBeforeState(ctx.jira, before);

      const submitted = await ctx.api.submitBulkDelete({
        ...callBase(ctx),
        issues: args.issues,
        ...(args.notifyUsers === undefined
          ? {}
          : { sendBulkNotification: args.notifyUsers }),
      });
      return ok(
        { ...submitted, before },
        { untrusted: true, hints: [BULK_ENQUEUED_HINT] },
      );
    }),
});

// ---------------------------------------------------------------------------
// jira_bulk_edit_issues
// ---------------------------------------------------------------------------

const bulkEditActionArg = z.enum(['ADD', 'REMOVE', 'REPLACE', 'REMOVE_ALL']);

/**
 * CC-133: values and action come together; `REMOVE_ALL` takes an empty list,
 * every other action a non-empty one. Enforced here so a violation is a
 * validation error and nothing reaches the wire — Jira would refuse the same
 * shapes, but as one opaque 400 against an already-submitted queue request.
 */
function refineBulkEditFamily(
  ctx: z.RefinementCtx,
  valuesKey: string,
  values: readonly string[] | undefined,
  actionKey: string,
  action: BulkEditAction | undefined,
): void {
  if (values !== undefined && action === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [actionKey],
      message: `${valuesKey} without ${actionKey} says nothing — pass the action too.`,
    });
  }
  if (values === undefined && action !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [valuesKey],
      message:
        `${actionKey} without ${valuesKey} has nothing to act on — ` +
        `REMOVE_ALL takes an empty list.`,
    });
  }
  if (values === undefined || action === undefined) return;
  if (action === 'REMOVE_ALL' && values.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [valuesKey],
      message:
        `REMOVE_ALL clears the field wholesale; a ${valuesKey} list would be ` +
        `silently ignored, so it is refused. Pass an empty list.`,
    });
  }
  if (action !== 'REMOVE_ALL' && values.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [valuesKey],
      message: `${action} needs at least one value; only REMOVE_ALL takes an empty list.`,
    });
  }
}

const bulkEditIssuesInput = writeToolInput({
  issues: bulkIssuesArg,
  labels: labelsArg
    .optional()
    .describe('Label values for labelsAction. REMOVE_ALL takes an empty list.'),
  labelsAction: bulkEditActionArg
    .optional()
    .describe('What to do with labels: ADD, REMOVE, REPLACE or REMOVE_ALL.'),
  // Trimmed at the schema, as the issue list is (CC-215): the plan echoes
  // what apply sends, and api/bulk.ts trims before sending (CC-242).
  priorityId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Numeric priority id to set, as jira_get_create_meta lists under the ' +
        "priority field's allowedValues.",
    ),
  assigneeAccountId: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'Atlassian accountId to assign every issue to — jira_search_users turns a ' +
        'display name or email into one. null unassigns.',
    ),
  fixVersionIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      'Numeric version ids (from jira_list_versions) for fixVersionsAction. ' +
        'REMOVE_ALL takes an empty list.',
    ),
  fixVersionsAction: bulkEditActionArg
    .optional()
    .describe('What to do with fixVersions: ADD, REMOVE, REPLACE or REMOVE_ALL.'),
  notifyUsers: notifyUsersArg,
}).superRefine((value, ctx) => {
  refineBulkEditFamily(ctx, 'labels', value.labels, 'labelsAction', value.labelsAction);
  refineBulkEditFamily(
    ctx,
    'fixVersionIds',
    value.fixVersionIds,
    'fixVersionsAction',
    value.fixVersionsAction,
  );
  const hasEdit =
    value.labels !== undefined ||
    value.labelsAction !== undefined ||
    value.priorityId !== undefined ||
    value.assigneeAccountId !== undefined ||
    value.fixVersionIds !== undefined ||
    value.fixVersionsAction !== undefined;
  if (!hasEdit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'A bulk edit needs an intent: pass at least one of labels (+labelsAction), ' +
        'priorityId, assigneeAccountId or fixVersionIds (+fixVersionsAction).',
    });
  }
});

export const bulkEditIssuesTool = defineTool({
  name: 'jira_bulk_edit_issues',
  title: 'Bulk edit issues',
  description:
    'Apply one change set — labels, priority, assignee, fix versions — to up to ' +
    '1000 issues in one asynchronous bulk operation. IRREVERSIBLE tier: nothing ' +
    'records the per-issue values it overwrites, so restoring 1000 issues means ' +
    'editing 1000 issues. Requires JIRA_ALLOW_IRREVERSIBLE=true on top of the ' +
    'usual plan → apply, plus the global Bulk Change permission and Edit issues ' +
    'in every affected project. The result is a task id, not a finished edit — ' +
    'poll jira_get_bulk_status until the task completes.',
  package: 'issues-delete',
  annotations: DELETE_ANNOTATIONS,
  writeTier: 'irreversible',
  input: bulkEditIssuesInput,
  handler: async (args, ctx): Promise<ToolResult<BulkEditSubmitted>> =>
    guarded(async () => {
      // No GET before the write (CC-129) — same rule as the bulk delete above.
      // Which actions ride in `selectedActions` is the api layer's derivation
      // (CC-130); this handler only forwards the families the caller named.
      const before = bulkEditBefore(args);
      noteBeforeState(ctx.jira, before);

      const submitted = await ctx.api.submitBulkEdit({
        ...callBase(ctx),
        issues: args.issues,
        ...(args.labels === undefined || args.labelsAction === undefined
          ? {}
          : { labels: { action: args.labelsAction, values: args.labels } }),
        ...(args.priorityId === undefined ? {} : { priorityId: args.priorityId }),
        ...(args.assigneeAccountId === undefined
          ? {}
          : { assignee: { accountId: args.assigneeAccountId } }),
        ...(args.fixVersionIds === undefined || args.fixVersionsAction === undefined
          ? {}
          : {
              fixVersions: {
                action: args.fixVersionsAction,
                versionIds: args.fixVersionIds,
              },
            }),
        ...(args.notifyUsers === undefined
          ? {}
          : { sendBulkNotification: args.notifyUsers }),
      });
      return ok(
        { ...submitted, before },
        { untrusted: true, hints: [BULK_ENQUEUED_HINT] },
      );
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
 *
 * The ID is narrower than the surface: Phase 11 added the project-entity
 * deletes (component, version, sprint) and Phase 12 repeated the argument for
 * the bulk writes (CC-126) — the id stays `issues-delete` so every existing
 * `JIRA_PACKAGES_DENY=issues-delete` deployment keeps denying the WHOLE
 * irreversible surface, new tools included (CC-120). The title is what
 * generalizes.
 */
export const issuesDeletePackage: PackageSpec = {
  id: 'issues-delete',
  title: 'Deletes and bulk changes (irreversible)',
  description:
    'Irreversible deletions — an issue, a comment, a worklog entry, a component, ' +
    'a version, a sprint — and the bulk writes that delete or edit up to 1000 ' +
    'issues in one asynchronous operation.',
  tools: [
    deleteIssueTool,
    deleteCommentTool,
    deleteWorklogTool,
    deleteComponentTool,
    deleteVersionTool,
    deleteSprintTool,
    bulkDeleteIssuesTool,
    bulkEditIssuesTool,
  ],
};
