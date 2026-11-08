// api/issues/types.ts — the public read shapes and read options (D517).

import type { JiraDeployment, JiraRequestFn } from '../../core/types.js';
import type { BudgetGuard, PageStopReason } from '../shared.js';
import type { ShapedUser } from '../users.js';

// ---------------------------------------------------------------------------
// 2. Public shapes — reads
// ---------------------------------------------------------------------------

/** Comment/worklog visibility, passed through as Jira words it. */
export interface JiraVisibility {
  readonly type?: string | undefined;
  readonly value?: string | undefined;
  readonly identifier?: string | undefined;
}

/** A linked issue, projected to the handful of fields a model reasons about. */
export interface LinkedIssueRef {
  readonly id?: string | undefined;
  readonly key: string;
  readonly summary?: string | undefined;
  readonly status?: string | undefined;
  readonly issueType?: string | undefined;
  readonly priority?: string | undefined;
}

/**
 * One entry of the `issuelinks` field, shaped rather than stringified.
 *
 * Jira states a link from the OTHER issue's perspective (`inwardIssue` /
 * `outwardIssue`); {@link IssueLink.relation} restates it from THIS issue's
 * perspective — "blocks" vs "is blocked by" — which is the only form a model
 * can act on without knowing Jira's link grammar.
 */
export interface IssueLink {
  readonly id?: string;
  readonly type: {
    readonly id?: string;
    readonly name?: string;
    readonly inward?: string;
    readonly outward?: string;
  };
  readonly direction: 'inward' | 'outward';
  readonly relation?: string;
  readonly issue: LinkedIssueRef;
}

/**
 * One changelog history. `items` are passed through EXACTLY as Jira sent them
 * (`field`, `fieldtype`, `from`, `fromString`, `to`, `toString`) — the payload of
 * an `expand` is returned unmodified (TOOLS.md §Read shaping). Only the author
 * is projected, because the user rule holds everywhere.
 */
export interface ChangelogEntry {
  readonly id?: string;
  readonly created?: string;
  readonly author?: ShapedUser;
  readonly items: readonly Readonly<Record<string, unknown>>[];
}

/** The `changelog` block `expand=changelog` adds to an issue. */
export interface IssueChangelog {
  readonly histories: readonly ChangelogEntry[];
  readonly startAt?: number;
  readonly maxResults?: number;
  readonly total?: number;
}

/** One issue as {@link getIssue} shaped it. */
export interface IssueDetail {
  readonly id: string;
  readonly key: string;
  readonly self?: string;
  /**
   * The requested fields under the ids/names requested — never renamed,
   * reordered or dropped. Values are shaped (ADF flattened unless `raw`, users
   * projected, `issuelinks`/`parent` restated); unknown and custom fields pass
   * through as received.
   */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Present only when `expand` asked for it. */
  readonly changelog?: IssueChangelog;
  /** Present only when `properties` asked for them. */
  readonly properties?: Readonly<Record<string, unknown>>;
  /**
   * Every other top-level section an `expand` added (`renderedFields`,
   * `names`, `schema`, `transitions`, `operations`, `versionedRepresentations`
   * …), under Jira's own section names. Shaped like `fields` — users projected,
   * ADF rendered per `raw`/`format` — so an expand cannot carry an email address
   * out. Absent when the response had none.
   */
  readonly expanded?: Readonly<Record<string, unknown>>;
  /** `true` when ADF was left as a tree because the caller asked for it. */
  readonly raw: boolean;
  /** The field list actually requested; absent means "Jira's navigable set". */
  readonly fieldsRequested?: readonly string[];
  /** The expand sections actually requested. */
  readonly expand: readonly string[];
}

/** One comment, body already flattened. */
export interface IssueComment {
  readonly id: string;
  readonly author?: ShapedUser;
  readonly updateAuthor?: ShapedUser;
  readonly body: string;
  readonly created?: string;
  readonly updated?: string;
  readonly visibility?: JiraVisibility;
  /** Jira Service Management: `false` marks an internal comment. */
  readonly jsdPublic?: boolean;
}

/** One worklog entry, comment already flattened. */
export interface IssueWorklog {
  readonly id: string;
  readonly issueId?: string;
  readonly author?: ShapedUser;
  readonly updateAuthor?: ShapedUser;
  readonly comment?: string;
  readonly started?: string;
  readonly timeSpent?: string;
  readonly timeSpentSeconds?: number;
  readonly created?: string;
  readonly updated?: string;
  readonly visibility?: JiraVisibility;
}

/** One workflow transition available from the issue's current status. */
export interface IssueTransition {
  readonly id: string;
  readonly name?: string;
  readonly to?: {
    readonly id?: string;
    readonly name?: string;
    readonly statusCategory?: { readonly key?: string; readonly name?: string };
  };
  readonly hasScreen?: boolean;
  readonly isAvailable?: boolean;
  readonly isGlobal?: boolean;
  readonly isInitial?: boolean;
  readonly isConditional?: boolean;
  readonly looped?: boolean;
  /** Only when `expandFields` asked for the transition screen. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Paging facts every classic list here reports. */
export interface ClassicListMeta {
  readonly pages: number;
  readonly stopReason: PageStopReason;
  /** `stopReason !== 'exhausted'` — more rows exist behind {@link nextStartAt}. */
  readonly partial: boolean;
  /** The offset the read started from. */
  readonly startAt: number;
  /** The page size actually requested, after clamping. */
  readonly maxResults: number;
  readonly total?: number;
  /** The offset to resume from; present only when the result is partial. */
  readonly nextStartAt?: number;
}

export interface CommentsResult extends ClassicListMeta {
  readonly comments: readonly IssueComment[];
  /** The ordering actually sent (TOOLS.md default: `-created`). */
  readonly orderBy: string;
}

export interface WorklogsResult extends ClassicListMeta {
  readonly worklogs: readonly IssueWorklog[];
}

export interface ChangelogResult extends ClassicListMeta {
  /** Oldest first — Jira's order, kept (TOOLS.md §jira_get_changelog). */
  readonly histories: readonly ChangelogEntry[];
  /**
   * Data Center only (D114): present when the changelog the issue read embedded
   * did not cover the whole history, so some of it cannot be read through this
   * server. Never present on Cloud, whose paginated route reaches every row.
   */
  readonly incomplete?: ChangelogIncomplete;
}

/**
 * Which part of an issue's history a Data Center changelog read could reach
 * (D114). Data Center has no paginated changelog route; its history comes
 * embedded in `GET /issue/{key}?expand=changelog`, and when that embedded block
 * holds fewer histories than its `total`, the rest are out of reach.
 */
export interface ChangelogIncomplete {
  /** The offset of the first history the embedded block held. */
  readonly reachableStartAt: number;
  /** One past the offset of the last history the embedded block held. */
  readonly reachableEndAt: number;
  /** How many histories the issue has, by Jira's `total`. */
  readonly total: number;
  /** An `INCOMPLETE:` sentence the model can repeat. */
  readonly note: string;
}

export interface TransitionsResult {
  readonly transitions: readonly IssueTransition[];
}

// ---------------------------------------------------------------------------
// 3. Option shapes — reads
// ---------------------------------------------------------------------------

/** What every call in this module needs: the seam, and a way to be cancelled. */
export interface IssueRequestBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request; stamped onto every request. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Which user dialect the read shaping projects (D106) — and the shaping of
   * the comment or worklog a write answers with (D109). Absent means `cloud`,
   * so every existing caller is unchanged; the Data Center adapter passes
   * `datacenter`. It changes how users are recognised and nothing else.
   */
  readonly deployment?: JiraDeployment | undefined;
}

/** Offsets and caps shared by the three classic lists. */
export interface ClassicListBase extends IssueRequestBase {
  /** Issue key (`PROJ-1`) or numeric id. */
  readonly issue: string;
  readonly startAt?: number | undefined;
  /** Page size; clamped to {@link MAX_PAGE_SIZE}. */
  readonly maxResults?: number | undefined;
  /** Page cap; defaults to {@link DEFAULT_LIST_MAX_PAGES}. */
  readonly maxPages?: number | undefined;
}

export interface GetIssueBase extends IssueRequestBase {
  /** Issue key (`PROJ-1`) or numeric id. */
  readonly issue: string;
  /** Fields to request; omitted means Jira's navigable set. */
  readonly fields?: readonly string[] | undefined;
  /** `expand` sections, passed through unmodified (`changelog`, `renderedFields`). */
  readonly expand?: readonly string[] | string | undefined;
  /** Issue property keys to fetch alongside the fields. */
  readonly properties?: readonly string[] | undefined;
  /** `true` returns ADF trees instead of flattened text (TOOLS.md §Read shaping). */
  readonly raw?: boolean | undefined;
  /**
   * How rich-text fields are rendered when `raw` is off: `text` (default)
   * flattens, `markdown` keeps the documented subset (TOOLS.md §Read shaping).
   * A rendering choice only — same request, same fields, same places.
   * Ignored under `raw`, which returns the documents themselves.
   */
  readonly format?: 'text' | 'markdown' | undefined;
}

export type GetIssueOptions = GetIssueBase & BudgetGuard;

/**
 * Most issues one `POST /issue/bulkfetch` accepts for any request shape
 * (D149). Jira's operation reference: "By default you can request up to 100
 * issues in a single call."
 */
export const MAX_BULK_ISSUES = 100;

/**
 * Most issues one `POST /issue/bulkfetch` accepts when the request is shaped
 * so Jira can serve it efficiently (D149 amendment, 2026-10-30; Jira Software
 * changelog 2026-08-28). See {@link bulkFetchIneligibility} for the shape.
 */
export const MAX_BULK_ISSUES_EFFICIENT = 1000;

/** Most explicitly included fields a request may name and still qualify for 1000. */
export const MAX_BULK_EFFICIENT_FIELDS = 100;

/** `expand` sections that hold a bulk read to {@link MAX_BULK_ISSUES} (published list). */
export const BULK_RESTRICTED_EXPANDS: ReadonlySet<string> = new Set([
  'changelog',
  'editmeta',
  'operations',
  'renderedfields',
  'transitions',
  'versionedrepresentations',
]);

/**
 * The multi-value fields the reference names as examples. Others exist (a
 * custom multi-select, say) and cannot be known without the field catalogue —
 * Jira refuses those with a 400, which surfaces as `validation` verbatim.
 */
export const BULK_MULTI_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'comment',
  'worklog',
  'attachment',
]);

export interface GetIssuesBulkBase extends Omit<GetIssueBase, 'issue'> {
  /**
   * Issue keys or numeric ids, 1–{@link MAX_BULK_ISSUES} after de-duplication,
   * or up to {@link MAX_BULK_ISSUES_EFFICIENT} for a qualifying shape.
   */
  readonly issues: readonly string[];
}

export type GetIssuesBulkOptions = GetIssuesBulkBase & BudgetGuard;

/** One issue of a bulk read: {@link IssueDetail} without the per-call echoes. */
export type IssueRecord = Omit<IssueDetail, 'raw' | 'fieldsRequested' | 'expand'>;

/**
 * One entry of `issueErrors`. Jira's shape for it is not verified against a
 * live tenant (D149), so every member is read defensively and only the
 * messages are guaranteed — an empty list when Jira sent none.
 */
export interface IssueBulkError {
  readonly status?: number;
  readonly failedElementNumber?: number;
  readonly messages: readonly string[];
}

export interface IssuesBulkResult {
  readonly issues: readonly IssueRecord[];
  readonly errors: readonly IssueBulkError[];
  /** The de-duplicated refs that were sent, in request order. */
  readonly requested: readonly string[];
  /**
   * Requested refs no returned issue answers to by its current key or id.
   * A moved issue comes back under its NEW key and lands here too — check
   * `issues` before reading an entry as "gone" (CC-1546).
   */
  readonly unmatched: readonly string[];
  readonly raw: boolean;
  readonly fieldsRequested?: readonly string[];
  readonly expand: readonly string[];
}

/** Most issues one `POST /changelog/bulkfetch` accepts (D150). */
export const MAX_BULK_CHANGELOG_ISSUES = 1000;

/** Most histories one bulk changelog page may return (D150). */
export const MAX_BULK_CHANGELOG_RESULTS = 1000;

export interface GetChangelogsBulkBase extends IssueRequestBase {
  /** Issue keys or ids, 1–{@link MAX_BULK_CHANGELOG_ISSUES} after de-duplication. */
  readonly issues: readonly string[];
  /** Field ids to keep (`status`, `assignee`, `customfield_10020`); empty means every field. */
  readonly fieldIds?: readonly string[] | undefined;
  /** Histories per page, 1–{@link MAX_BULK_CHANGELOG_RESULTS}; Jira's default when absent. */
  readonly maxResults?: number | undefined;
  /** Cursor from the previous page; send it with the SAME issues and fieldIds. */
  readonly nextPageToken?: string | undefined;
}

export type GetChangelogsBulkOptions = GetChangelogsBulkBase & BudgetGuard;

/** One issue's slice of a bulk changelog page. */
export interface IssueChangelogPage {
  /** Jira keys this block by numeric id only — never by key (D150). */
  readonly issueId: string;
  /** Oldest first within the issue, as Jira sent them. */
  readonly histories: readonly ChangelogEntry[];
}

export interface ChangelogsBulkResult {
  readonly issues: readonly IssueChangelogPage[];
  /** The de-duplicated refs that were sent, in request order. */
  readonly requested: readonly string[];
  readonly fieldIds?: readonly string[];
  readonly nextPageToken?: string;
  /** `nextPageToken !== undefined`, stated so the decision needs no inference. */
  readonly hasMore: boolean;
}

export interface ListCommentsBase extends ClassicListBase {
  /** `-created` (default), `created`, `-updated`, `updated`. */
  readonly orderBy?: string | undefined;
  /**
   * How comment bodies are rendered: `text` (default) flattens, `markdown`
   * keeps the documented subset (TOOLS.md §Read shaping). A rendering choice
   * only — same request, same shape, same fields either way.
   */
  readonly format?: 'text' | 'markdown' | undefined;
}

export type ListCommentsOptions = ListCommentsBase & BudgetGuard;
export type ListWorklogsOptions = ClassicListBase & BudgetGuard;
export type ListChangelogOptions = ClassicListBase & BudgetGuard;

export interface ListTransitionsBase extends IssueRequestBase {
  readonly issue: string;
  /** Ask for `transitions.fields` — the transition screen, needed for CC-21. */
  readonly expandFields?: boolean | undefined;
}

export type ListTransitionsOptions = ListTransitionsBase & BudgetGuard;
