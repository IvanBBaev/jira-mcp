// api/issues/write-types.ts — write inputs, options and results (D517).

import type { AdfNode } from '../adf.js';
import type { BudgetGuard } from '../shared.js';
import type { IssueRequestBase, JiraVisibility } from './types.js';

// ---------------------------------------------------------------------------
// 5. Write input shapes
// ---------------------------------------------------------------------------

export interface CreateIssueInput {
  /** Project key or numeric id. */
  readonly project: string;
  /** Issue type name (`Task`) or numeric id. */
  readonly issueType: string;
  readonly summary: string;
  /** Plain text (converted) or a raw ADF document. */
  readonly description?: string | AdfNode;
  readonly assigneeAccountId?: string;
  readonly reporterAccountId?: string;
  /** Priority name (`High`) or numeric id. */
  readonly priority?: string;
  readonly labels?: readonly string[];
  /** Parent issue key or id — an epic for a story, a story for a subtask. */
  readonly parent?: string;
  /** `YYYY-MM-DD`, passed through; Jira validates the calendar. */
  readonly dueDate?: string;
  /** Raw passthrough for custom fields (`customfield_10011`). */
  readonly fields?: Readonly<Record<string, unknown>>;
}

export type CreateIssueOptions = IssueRequestBase & CreateIssueInput & BudgetGuard;

export interface CreatedIssue {
  readonly id: string;
  readonly key: string;
  readonly self?: string;
}

export interface UpdateIssueInput {
  readonly issue: string;
  readonly summary?: string;
  /** Text or ADF — either REPLACES the whole field (CC-31). `null` clears it. */
  readonly description?: string | AdfNode | null;
  /** `null` unassigns. */
  readonly assigneeAccountId?: string | null;
  readonly priority?: string;
  /** REPLACES the whole label list. Use add/remove for incremental edits. */
  readonly labels?: readonly string[];
  readonly labelsAdd?: readonly string[];
  readonly labelsRemove?: readonly string[];
  /** `null` un-parents (removes the epic link / detaches a subtask). */
  readonly parent?: string | null;
  readonly dueDate?: string | null;
  /** Raw passthrough for custom fields. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Default true, matching Jira. `false` suppresses the change notification. */
  readonly notifyUsers?: boolean;
}

export type UpdateIssueOptions = IssueRequestBase & UpdateIssueInput & BudgetGuard;

export interface UpdateIssueResult {
  readonly issue: string;
  readonly updated: true;
  readonly notifyUsers?: boolean;
}

export interface TransitionIssueInput {
  readonly issue: string;
  /** The id from {@link listTransitions} — resolve a name first. */
  readonly transitionId: string;
  /** Resolution name or id, for a transition screen that demands one. */
  readonly resolution?: string;
  /** Any other transition-screen fields, raw. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Comment added as part of the transition. */
  readonly comment?: string | AdfNode;
}

export type TransitionIssueOptions = IssueRequestBase &
  TransitionIssueInput &
  BudgetGuard;

export interface TransitionIssueResult {
  readonly issue: string;
  readonly transitionId: string;
  readonly transitioned: true;
}

export interface AddCommentInput {
  readonly issue: string;
  /** Plain text (converted) or a raw ADF document. */
  readonly body: string | AdfNode;
  /** Restrict to a project role or a group. */
  readonly visibility?: JiraVisibility;
}

export type AddCommentOptions = IssueRequestBase & AddCommentInput & BudgetGuard;

/**
 * Input of {@link updateComment}. Deliberately the same shape as
 * {@link AddCommentInput} plus the id: a caller that can add a comment can edit
 * one without learning a second body grammar.
 */
export interface UpdateCommentInput {
  readonly issue: string;
  /** Numeric comment id from `jira_get_comments`; validated before the wire (D22). */
  readonly commentId: string | number;
  /**
   * The comment's NEW body — plain text (converted) or a raw ADF document. Jira
   * replaces the stored body with this wholesale; there is no patch form
   * (CC-31's hazard, on a comment).
   */
  readonly body: string | AdfNode;
  /**
   * Restrict the edited comment to a project role or a group. `null` lifts any
   * restriction, so the comment becomes public. Absent keeps the restriction
   * the comment carries now: Jira treats a `PUT` without `visibility` as
   * "public", so {@link updateComment} reads the stored one back and resends
   * it (CC-510).
   */
  readonly visibility?: JiraVisibility | null;
}

export type UpdateCommentOptions = IssueRequestBase & UpdateCommentInput & BudgetGuard;

export interface AssignIssueInput {
  readonly issue: string;
  /**
   * The accountId to assign to (Jira Cloud). Mutually exclusive with `username`
   * and `unassign` (CC-22); refused on Data Center (D111).
   */
  readonly accountId?: string;
  /**
   * The username to assign to — Jira Data Center only (D111). Refused on Cloud,
   * which identifies users by accountId only.
   */
  readonly username?: string;
  /** `true` sends an explicit null, which is how Jira clears an assignee. */
  readonly unassign?: boolean;
}

export type AssignIssueOptions = IssueRequestBase & AssignIssueInput & BudgetGuard;

/** The result of an assignment on Jira Cloud. */
export interface CloudAssignIssueResult {
  readonly issue: string;
  /** `null` when the issue was unassigned. */
  readonly accountId: string | null;
  readonly username?: never;
  readonly assigned: true;
}

/** The result of an assignment on Jira Data Center (D111): a username, not an accountId. */
export interface DataCenterAssignIssueResult {
  readonly issue: string;
  /** `null` when the issue was unassigned. */
  readonly username: string | null;
  readonly accountId?: never;
  readonly assigned: true;
}

export type AssignIssueResult = CloudAssignIssueResult | DataCenterAssignIssueResult;

export interface AddWorklogInput {
  readonly issue: string;
  /** Preferred. Mutually exclusive with {@link AddWorklogInput.timeSpent}. */
  readonly timeSpentSeconds?: number;
  /** Jira duration string, e.g. `2h 30m`. */
  readonly timeSpent?: string;
  /**
   * When the work started, in epoch milliseconds. Required by the REQUEST
   * BUILDER; {@link addWorklog} defaults it from the injected `Clock`.
   */
  readonly startedAt: number;
  /**
   * D16/CC-23 — the injected offset source, in minutes east of UTC (`330` is
   * `+0530`). It belongs to the AUTHENTICATED USER's Jira timezone
   * (`GET /rest/api/3/myself` → `timeZone`), never to the host, and it is a
   * plain number so a test can pin it while the runner sits in UTC.
   * {@link utcOffsetMinutesForZone} converts a zone name into one.
   */
  readonly utcOffsetMinutes: number;
  readonly comment?: string | AdfNode;
}

export type AddWorklogOptions = IssueRequestBase &
  Omit<AddWorklogInput, 'startedAt'> & {
    /** Defaults to the injected clock's `now()`. */
    readonly startedAt?: number;
  } & BudgetGuard;

export interface LinkIssuesInput {
  /** Link type NAME (`Blocks`); discoverable via `jira_list_link_types`. */
  readonly linkType: string;
  /** The issue at the inward end — the one that "is blocked by". */
  readonly inwardIssue: string;
  /** The issue at the outward end — the one that "blocks". */
  readonly outwardIssue: string;
  /** Comment added to the inward issue alongside the link. */
  readonly comment?: string | AdfNode;
  readonly commentVisibility?: JiraVisibility;
}

export type LinkIssuesOptions = IssueRequestBase & LinkIssuesInput & BudgetGuard;

export interface LinkIssuesResult {
  readonly linkType: string;
  readonly inwardIssue: string;
  readonly outwardIssue: string;
  readonly linked: true;
}
