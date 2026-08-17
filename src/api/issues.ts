// ---------------------------------------------------------------------------
// api/issues.ts — the issue surface: every read and every write v1 ships (WP-21).
//
// One domain, six rules that the rest of this file exists to enforce:
//
//  1. **v3 only, ADF both ways.** Rich text arrives as an ADF tree and is
//     flattened with `adfToText` on the way out (TOOLS.md §Read shaping), and is
//     built with `toAdf` on the way in. `raw: true` on {@link getIssue} is the
//     ONE escape hatch that returns the tree untouched.
//  2. **Users by accountId only** (JIRA-API.md §Users). Every user-shaped object
//     read from the wire collapses to `{ accountId, displayName?, active? }`, so
//     an `emailAddress` or an avatar URL never rides along into a model's
//     context; every user WRITTEN is an accountId, never a name.
//  3. **Paths are built per segment, never concatenated.** Dynamic segments go
//     through `encodeSegment` (core/http-util.ts) and the spec carries the
//     matching `pathTemplate`, so logs and errors name `/issue/{issueIdOrKey}`
//     and a key can never smuggle a `../` into the URL.
//  4. **Writes are unsafe.** No write here sets `safe`, so `core/http.ts` never
//     replays one on a 5xx or a transport failure — an ambiguous write surfaces
//     as `ambiguous_write` instead of silently duplicating a comment or a
//     worklog (JIRA-API.md §Rate limiting and retries).
//  5. **Deletes are a tier, not a write** (D45, superseding D7's v1 exclusion).
//     `deleteIssue`, `deleteComment` and `deleteWorklog` live in section 13,
//     apart from the ordinary writes, because reaching them takes more than
//     `JIRA_WRITE_MODE=apply`: the tool ring marks them `irreversible` and the
//     gate then also demands `JIRA_ALLOW_IRREVERSIBLE` and a before-state in
//     the plan. Nothing here enforces that — this ring builds requests.
//  6. **Data + metadata, never envelopes.** Results carry the facts a hint is
//     derived from (`partial`, `stopReason`, `nextStartAt`, `total`); choosing
//     and wording hints is the tool ring's job (TOOLS.md §Hint catalog).
//
// Plan mode (CC-20) needs the exact method/path/body a write WOULD send without
// touching the network, so every write is split in two: a pure
// `<name>Request(input)` builder that returns the {@link JiraRequestSpec}, and
// an executor that sends what the builder built. The plan and the apply can
// therefore never drift apart, because they are the same function.
//
// Corner cases implemented here: CC-16 (404 means "not found OR no permission" —
// see {@link getIssue}), CC-20 (the request builders), CC-21 (stale transition
// id), CC-22 (assign vs unassign), CC-23 (worklog `started` offset), CC-24
// (unknown custom field → Jira's field-level 400, passed through untouched).
// ---------------------------------------------------------------------------

import { createJiraError, isJiraError } from '../core/errors.js';
import { encodeSegment } from '../core/http-util.js';
import type {
  JiraError,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
} from '../core/types.js';
import { adfToMarkdown, adfToText, isAdfDoc, toAdf, type AdfNode } from './adf.js';
import {
  budgetOf,
  fetchAll,
  type BudgetGuard,
  type ClassicCursor,
  type ClassicPage,
  type PageStopReason,
} from './shared.js';
import type { JiraUser } from './users.js';

// ---------------------------------------------------------------------------
// 1. Wire constants
// ---------------------------------------------------------------------------

/** The issue collection — `POST` here creates. Relative to the `v3` root. */
export const ISSUE_COLLECTION_PATH = '/issue';

/** Issue links live outside the issue resource (JIRA-API.md §Issue links). */
export const ISSUE_LINK_PATH = '/issueLink';

/** Route templates. They are what logs and errors see — never a concrete key. */
export const ISSUE_PATH_TEMPLATE = '/issue/{issueIdOrKey}';
export const ISSUE_COMMENT_PATH_TEMPLATE = '/issue/{issueIdOrKey}/comment';
/** One comment inside the thread — the `PUT` target of {@link updateComment}. */
export const ISSUE_COMMENT_ITEM_PATH_TEMPLATE = '/issue/{issueIdOrKey}/comment/{id}';
export const ISSUE_TRANSITIONS_PATH_TEMPLATE = '/issue/{issueIdOrKey}/transitions';
export const ISSUE_WORKLOG_PATH_TEMPLATE = '/issue/{issueIdOrKey}/worklog';
export const ISSUE_CHANGELOG_PATH_TEMPLATE = '/issue/{issueIdOrKey}/changelog';
export const ISSUE_ASSIGNEE_PATH_TEMPLATE = '/issue/{issueIdOrKey}/assignee';

/**
 * TOOLS.md §jira_get_comments — newest first. Jira's own default is oldest
 * first, which is the wrong end of a long thread for every digest a model builds.
 */
export const DEFAULT_COMMENT_ORDER_BY = '-created';

export const DEFAULT_COMMENT_PAGE_SIZE = 50;
export const DEFAULT_WORKLOG_PAGE_SIZE = 50;
export const DEFAULT_CHANGELOG_PAGE_SIZE = 100;

/** Tool-level page cap: a page of issue data is spent on a context window. */
export const MAX_PAGE_SIZE = 100;

/**
 * Default page cap for the classic lists here: ONE page, matching
 * `DEFAULT_SEARCH_MAX_PAGES` in `api/search.ts`. The tools expose
 * `startAt`/`maxResults` to the model, so the default call reads one page and
 * reports `nextStartAt`; a caller that wants a sweep passes `maxPages`.
 */
export const DEFAULT_LIST_MAX_PAGES = 1;

/**
 * Recursion cap for read shaping. Wire data is JSON so it cannot be cyclic, but
 * it can be absurdly deep (a custom field holding a whole document); past this
 * the value is handed back untouched rather than blowing the stack.
 */
export const MAX_SHAPE_DEPTH = 16;

// ---------------------------------------------------------------------------
// 2. Public shapes — reads
// ---------------------------------------------------------------------------

/**
 * The user record, defined once in `api/users.ts` and re-exported here so the
 * shapes on this module's results keep naming it locally.
 *
 * The TYPE is the wide one (`/myself` fills in `timeZone`, user search can carry
 * `emailAddress`); the PROJECTION this module emits stays the narrow three-key
 * one — {@link shapeUser} builds every user on a read result and copies nothing
 * beyond `accountId`/`displayName`/`active`, which is the PII collapse TOOLS.md
 * §Read shaping mandates and `shapeUser`'s own tests pin.
 */
export type { JiraUser };

/** Comment/worklog visibility, passed through as Jira words it. */
export interface JiraVisibility {
  readonly type?: string;
  readonly value?: string;
  readonly identifier?: string;
}

/** A linked issue, projected to the handful of fields a model reasons about. */
export interface LinkedIssueRef {
  readonly id?: string;
  readonly key: string;
  readonly summary?: string;
  readonly status?: string;
  readonly issueType?: string;
  readonly priority?: string;
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
  readonly author?: JiraUser;
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
  readonly author?: JiraUser;
  readonly updateAuthor?: JiraUser;
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
  readonly author?: JiraUser;
  readonly updateAuthor?: JiraUser;
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
  readonly signal?: AbortSignal;
}

/** Offsets and caps shared by the three classic lists. */
export interface ClassicListBase extends IssueRequestBase {
  /** Issue key (`PROJ-1`) or numeric id. */
  readonly issue: string;
  readonly startAt?: number;
  /** Page size; clamped to {@link MAX_PAGE_SIZE}. */
  readonly maxResults?: number;
  /** Page cap; defaults to {@link DEFAULT_LIST_MAX_PAGES}. */
  readonly maxPages?: number;
}

export interface GetIssueBase extends IssueRequestBase {
  /** Issue key (`PROJ-1`) or numeric id. */
  readonly issue: string;
  /** Fields to request; omitted means Jira's navigable set. */
  readonly fields?: readonly string[];
  /** `expand` sections, passed through unmodified (`changelog`, `renderedFields`). */
  readonly expand?: readonly string[] | string;
  /** Issue property keys to fetch alongside the fields. */
  readonly properties?: readonly string[];
  /** `true` returns ADF trees instead of flattened text (TOOLS.md §Read shaping). */
  readonly raw?: boolean;
  /**
   * How rich-text fields are rendered when `raw` is off: `text` (default)
   * flattens, `markdown` keeps the documented subset (TOOLS.md §Read shaping).
   * A rendering choice only — same request, same fields, same places.
   * Ignored under `raw`, which returns the documents themselves.
   */
  readonly format?: 'text' | 'markdown';
}

export type GetIssueOptions = GetIssueBase & BudgetGuard;

export interface ListCommentsBase extends ClassicListBase {
  /** `-created` (default), `created`, `-updated`, `updated`. */
  readonly orderBy?: string;
  /**
   * How comment bodies are rendered: `text` (default) flattens, `markdown`
   * keeps the documented subset (TOOLS.md §Read shaping). A rendering choice
   * only — same request, same shape, same fields either way.
   */
  readonly format?: 'text' | 'markdown';
}

export type ListCommentsOptions = ListCommentsBase & BudgetGuard;
export type ListWorklogsOptions = ClassicListBase & BudgetGuard;
export type ListChangelogOptions = ClassicListBase & BudgetGuard;

export interface ListTransitionsBase extends IssueRequestBase {
  readonly issue: string;
  /** Ask for `transitions.fields` — the transition screen, needed for CC-21. */
  readonly expandFields?: boolean;
}

export type ListTransitionsOptions = ListTransitionsBase & BudgetGuard;

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

/**
 * Read one issue — `GET /rest/api/3/issue/{issueIdOrKey}`.
 *
 * CC-16: Jira answers **404 for an issue that exists but this account may not
 * see**, exactly as it does for one that does not exist. That ambiguity is
 * already spelled out by the `not_found` remediation the core error factory
 * attaches, so the 404 propagates from here untouched — rewriting it would
 * replace "not found OR no permission" with a confident lie.
 */
export async function getIssue(options: GetIssueOptions): Promise<IssueDetail> {
  const fields = normalizeList(options.fields);
  const expand = normalizeList(
    typeof options.expand === 'string' ? options.expand.split(',') : options.expand,
  );
  const properties = normalizeList(options.properties);
  const raw = options.raw === true;

  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue),
    pathTemplate: ISSUE_PATH_TEMPLATE,
    query: {
      fields: csv(fields),
      expand: csv(expand),
      properties: csv(properties),
    },
  });

  const data = requireRecord(response.data, 'issue');
  const id = requireString(data.id, 'issue.id');
  const key = requireString(data.key, 'issue.key');
  const changelog = shapeChangelogBlock(data.changelog);
  const props = asRecord(data.properties);

  return {
    id,
    key,
    ...(typeof data.self === 'string' ? { self: data.self } : {}),
    fields: shapeIssueFields(data.fields, raw, options.format),
    ...(changelog === undefined ? {} : { changelog }),
    ...(props === undefined ? {} : { properties: props }),
    raw,
    ...(fields.length === 0 ? {} : { fieldsRequested: fields }),
    expand,
  };
}

/**
 * Read a page of comments — `GET /rest/api/3/issue/{issueIdOrKey}/comment`.
 * Classic pagination; bodies are flattened, authors projected.
 */
export async function listComments(
  options: ListCommentsOptions,
): Promise<CommentsResult> {
  const orderBy = trimmedOr(options.orderBy, DEFAULT_COMMENT_ORDER_BY);
  const page = await classicList<IssueComment>(options, {
    defaultPageSize: DEFAULT_COMMENT_PAGE_SIZE,
    suffix: '/comment',
    pathTemplate: ISSUE_COMMENT_PATH_TEMPLATE,
    query: { orderBy },
    collection: 'comments',
    map: (value) => shapeComment(value, options.format),
  });
  return { ...page.meta, comments: page.items, orderBy };
}

/**
 * Read a page of worklogs — `GET /rest/api/3/issue/{issueIdOrKey}/worklog`.
 */
export async function listWorklogs(
  options: ListWorklogsOptions,
): Promise<WorklogsResult> {
  const page = await classicList<IssueWorklog>(options, {
    defaultPageSize: DEFAULT_WORKLOG_PAGE_SIZE,
    suffix: '/worklog',
    pathTemplate: ISSUE_WORKLOG_PATH_TEMPLATE,
    collection: 'worklogs',
    map: shapeWorklog,
  });
  return { ...page.meta, worklogs: page.items };
}

/**
 * Read a page of the changelog — `GET /rest/api/3/issue/{issueIdOrKey}/changelog`.
 *
 * Jira returns it OLDEST FIRST and that order is kept: re-sorting would make
 * `startAt` meaningless. "What changed recently" reads the tail (TOOLS.md).
 */
export async function listChangelog(
  options: ListChangelogOptions,
): Promise<ChangelogResult> {
  const page = await classicList<ChangelogEntry>(options, {
    defaultPageSize: DEFAULT_CHANGELOG_PAGE_SIZE,
    suffix: '/changelog',
    pathTemplate: ISSUE_CHANGELOG_PATH_TEMPLATE,
    collection: 'values',
    map: shapeChangelogEntry,
  });
  return { ...page.meta, histories: page.items };
}

/**
 * List the transitions available from the issue's CURRENT status —
 * `GET /rest/api/3/issue/{issueIdOrKey}/transitions`.
 *
 * Not paginated. Mandatory before {@link transitionIssue}: status cannot be set
 * through an update, and a transition id is workflow-specific and mutable
 * (JIRA-API.md §Transitions).
 */
export async function listTransitions(
  options: ListTransitionsOptions,
): Promise<TransitionsResult> {
  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue, '/transitions'),
    pathTemplate: ISSUE_TRANSITIONS_PATH_TEMPLATE,
    query: {
      expand: options.expandFields === true ? 'transitions.fields' : undefined,
    },
  });

  const data = requireRecord(response.data, 'transitions');
  const rows = data.transitions ?? [];
  if (!isUnknownArray(rows)) {
    throw shapeError('the transitions response has a non-array "transitions"');
  }
  const transitions: IssueTransition[] = [];
  for (const row of rows) {
    const transition = shapeTransition(row);
    if (transition !== undefined) transitions.push(transition);
  }
  return { transitions };
}

/**
 * CC-21 — turn a transition id OR name into the id the POST needs, against the
 * live list. An unresolvable value fails with a `validation` error that NAMES
 * every currently valid transition, which is the anti-hallucination path: a
 * model that invented "Close" is told what actually exists instead of being sent
 * to Jira to earn an opaque 400.
 *
 * Pure — no network. The caller reads the list with {@link listTransitions}.
 */
export function resolveTransitionId(
  transitions: readonly IssueTransition[],
  wanted: string,
): string {
  const want = requireText(wanted, 'transition id or name');
  const byId = transitions.find((entry) => entry.id === want);
  if (byId !== undefined) return byId.id;

  const folded = want.toLowerCase();
  const byName = transitions.find((entry) => entry.name?.toLowerCase() === folded);
  if (byName !== undefined) return byName.id;

  const catalog = transitions
    .map((entry) => `${entry.id} (${entry.name ?? 'unnamed'})`)
    .join(', ');
  throw createJiraError({
    kind: 'validation',
    reason:
      `No transition matches ${JSON.stringify(want)} from this issue's current ` +
      `status. Available now: ${catalog === '' ? 'none' : catalog}.`,
    remediation:
      'Transitions depend on the current status and on the workflow, which can ' +
      'change at any time. Pick an id from the list above, or re-read it with ' +
      'jira_get_transitions.',
  });
}

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
   * Restrict the edited comment to a project role or a group. Absent means the
   * visibility Jira has stored is left as it is.
   */
  readonly visibility?: JiraVisibility;
}

export type UpdateCommentOptions = IssueRequestBase & UpdateCommentInput & BudgetGuard;

export interface AssignIssueInput {
  readonly issue: string;
  /** The accountId to assign to. Mutually exclusive with `unassign` (CC-22). */
  readonly accountId?: string;
  /** `true` sends `accountId: null`, which is how Jira clears an assignee. */
  readonly unassign?: boolean;
}

export type AssignIssueOptions = IssueRequestBase & AssignIssueInput & BudgetGuard;

export interface AssignIssueResult {
  readonly issue: string;
  /** `null` when the issue was unassigned. */
  readonly accountId: string | null;
  readonly assigned: true;
}

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
  if (input.dueDate !== undefined) fields.dueDate = requireText(input.dueDate, 'dueDate');

  return {
    method: 'POST',
    path: ISSUE_COLLECTION_PATH,
    body: { fields: mergeExtraFields(fields, input.fields) },
  };
}

export function updateIssueRequest(input: UpdateIssueInput): JiraRequestSpec {
  const replacesLabels = input.labels !== undefined;
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
    fields.dueDate =
      input.dueDate === null ? null : requireText(input.dueDate, 'dueDate');
  }

  const labelOps: Record<string, string>[] = [
    ...normalizeLabels(input.labelsAdd ?? []).map((label) => ({ add: label })),
    ...normalizeLabels(input.labelsRemove ?? []).map((label) => ({ remove: label })),
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
 * builder does not send — author, created/updated stamps — Jira keeps.
 */
export function updateCommentRequest(input: UpdateCommentInput): JiraRequestSpec {
  const id = commentIdSegment(input.commentId);
  return {
    method: 'PUT',
    path: issuePath(input.issue, `/comment/${id}`),
    pathTemplate: ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
    body: {
      body: toAdf(input.body),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
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
  const data = requireRecord(response.data, 'created issue');
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
  const comment = shapeComment(response.data);
  if (comment === undefined) throw shapeError('the created comment has no string "id"');
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
  const response = await send(options, updateCommentRequest(options));
  const comment = shapeComment(response.data);
  if (comment === undefined) throw shapeError('the updated comment has no string "id"');
  return comment;
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
  const worklog = shapeWorklog(response.data);
  if (worklog === undefined) throw shapeError('the created worklog has no string "id"');
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

// ---------------------------------------------------------------------------
// 8. Worklog time (D16 / CC-23)
// ---------------------------------------------------------------------------

/**
 * Format an instant the way Jira's worklog `started` field demands:
 * `2026-08-07T10:00:00.000+0000` — milliseconds mandatory, offset mandatory,
 * `Z` REJECTED (JIRA-API.md §Issue links, worklogs, changelog).
 *
 * The offset is data, not an observation: it arrives as minutes east of UTC and
 * shifts the rendered wall clock accordingly, so the same instant logged by a
 * user in `Asia/Kolkata` reads `15:30+0530` while the process runs in UTC.
 */
export function formatJiraTimestamp(epochMs: number, utcOffsetMinutes: number): string {
  const offset = normalizeOffsetMinutes(utcOffsetMinutes);
  if (!Number.isFinite(epochMs)) {
    throw createJiraError({
      kind: 'validation',
      reason: `A timestamp must be finite epoch milliseconds, received ${String(epochMs)}.`,
      remediation: 'Pass the instant as a number of milliseconds since 1970-01-01.',
    });
  }

  const shifted = new Date(epochMs + offset * 60_000);
  const iso = Number.isNaN(shifted.getTime()) ? '' : shifted.toISOString();
  // A year outside 0000-9999 renders as an expanded `+275760-…` form that no
  // fixed slice can read; refuse it rather than emit a truncated timestamp.
  if (iso.length !== 24 || !iso.endsWith('Z')) {
    throw createJiraError({
      kind: 'validation',
      reason: `The timestamp ${String(epochMs)} is outside the range Jira accepts.`,
      remediation: 'Pass a start time within the ordinary calendar range.',
    });
  }

  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${iso.slice(0, 23)}${sign}${hours}${minutes}`;
}

/**
 * Convert an IANA zone name (what `GET /rest/api/3/myself` returns as
 * `timeZone`) into the minutes-east-of-UTC offset {@link addWorklog} wants, AT a
 * given instant — the offset of a zone is not a constant, it moves with DST.
 *
 * D16's fallback lives here: an unknown or unsupported zone yields the HOST
 * offset rather than throwing, because a worklog with a slightly wrong offset is
 * still a worklog, while a hard failure loses the user's work entry.
 */
export function utcOffsetMinutesForZone(timeZone: string, atEpochMs: number): number {
  const at = new Date(atEpochMs);
  if (Number.isNaN(at.getTime())) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);

    const read = (type: string): number => {
      const part = parts.find((entry) => entry.type === type);
      return part === undefined ? Number.NaN : Number(part.value);
    };
    const year = read('year');
    const month = read('month');
    const day = read('day');
    const hour = read('hour') % 24;
    const minute = read('minute');
    const second = read('second');
    if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) {
      return -at.getTimezoneOffset();
    }

    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.round((asUtc - (atEpochMs - at.getMilliseconds())) / 60_000);
  } catch {
    // An invalid zone name throws a RangeError out of Intl; the host offset is
    // the documented fallback (D16).
    return -at.getTimezoneOffset();
  }
}

/**
 * `YYYY-MM-DDTHH:mm[:ss[.sss]]` with an OPTIONAL offset (`Z`, `+02:00`, `+0200`).
 * A space instead of `T` is accepted because models write it; it is normalized
 * away before parsing. The time ranges are pinned here (`23:59:59` and no
 * further) so that a parse failure downstream can only mean an impossible
 * CALENDAR date, which needs a different check — see {@link startedInstant}.
 *
 * Exported because the tool ring validates the same string with it before the
 * call ever reaches here: one pattern, so the schema and the parser cannot
 * disagree about what a `started` value is. The regex carries no `g` flag, so it
 * holds no `lastIndex` state and sharing the instance is safe.
 */
export const WORKLOG_STARTED_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d{1,3})?)(Z|[+-]\d{2}:?\d{2})?$/;

/** An instant plus the offset it must be RENDERED in (D16/CC-23). */
export interface StartedInstant {
  readonly epochMs: number;
  readonly offsetMinutes: number;
}

/**
 * CC-23. Jira's worklog `started` needs an explicit offset and rejects `Z`, so
 * the question is never "what time is it here" but "what does the wall clock
 * read for the user who logged this work".
 *
 * - No `started` at all → the injected clock's now, rendered in the user's zone.
 * - `started` WITHOUT an offset → the caller means their own wall clock, so it
 *   is read IN the user's zone (the provisional UTC reading only picks which
 *   side of a DST change the offset comes from).
 * - `started` WITH an offset → an absolute instant, re-rendered in the user's
 *   zone. Same moment, different wall clock, and never a `Z` on the wire.
 *
 * The zone is data supplied by the caller of this function, never read from the
 * host inside it — which is what lets a test pin `+0530` while the runner is UTC.
 * `undefined` means the string is not a real calendar instant; the tool ring
 * turns that into the validation envelope, because only it knows the argument
 * name to name.
 */
export function startedInstant(
  started: string | undefined,
  timeZone: string,
  nowMs: number,
): StartedInstant | undefined {
  if (started === undefined) {
    return { epochMs: nowMs, offsetMinutes: utcOffsetMinutesForZone(timeZone, nowMs) };
  }

  const match = WORKLOG_STARTED_PATTERN.exec(started);
  if (match === null) return undefined;
  const date = match[1] ?? '';
  const wallClock = `${date}T${match[2] ?? ''}`;
  const suffix = match[3];

  const asUtc = Date.parse(`${wallClock}Z`);
  // A date that does not exist must be REFUSED, not rolled over. V8's parser
  // happily turns 2026-02-30 into 2026-03-02, and silently logging work on the
  // wrong day is worse than an error the caller can fix — so the round trip has
  // to land on the same calendar date the caller wrote.
  if (Number.isNaN(asUtc) || !new Date(asUtc).toISOString().startsWith(`${date}T`)) {
    return undefined;
  }

  if (suffix === undefined) {
    const offsetMinutes = utcOffsetMinutesForZone(timeZone, asUtc);
    return { epochMs: asUtc - offsetMinutes * 60_000, offsetMinutes };
  }

  // `+0530` and `+05:30` both mean the same thing; only one of them is ISO.
  const normalized =
    suffix === 'Z' ? 'Z' : `${suffix.slice(0, 3)}:${suffix.slice(suffix.length - 2)}`;
  const epochMs = Date.parse(`${wallClock}${normalized}`);
  if (Number.isNaN(epochMs)) return undefined;
  return { epochMs, offsetMinutes: utcOffsetMinutesForZone(timeZone, epochMs) };
}

// ---------------------------------------------------------------------------
// 9. Read shaping
// ---------------------------------------------------------------------------

/**
 * Shape a whole `fields` bag. Keys survive exactly as Jira sent them — a
 * requested field is never renamed, reordered or dropped (TOOLS.md §Read
 * shaping) — and only VALUES are projected.
 *
 * Exported because it is THE issue read-shaper: `api/search.ts` and
 * `api/agile.ts` return raw `fields` bags by design, so `tools/search.ts` and
 * `tools/agile.ts` apply this same projection at the tool ring — one shaper,
 * identical output everywhere an issue row appears (TOOLS.md §Read shaping).
 *
 * `format` picks the renderer for the documents this walk finds; it changes
 * nothing about WHICH values are rendered, so a markdown read and a text read
 * differ only where a document had structure to keep. It is meaningless under
 * `raw`, which hands the documents back untouched.
 */
export function shapeIssueFields(
  value: unknown,
  raw: boolean,
  format?: 'text' | 'markdown',
): Record<string, unknown> {
  const fields = asRecord(value);
  if (fields === undefined) return {};
  const render = raw ? undefined : format === 'markdown' ? adfToMarkdown : adfToText;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    if (key === 'issuelinks') out[key] = shapeIssueLinks(entry, render);
    else if (key === 'parent') out[key] = shapeLinkedIssue(entry) ?? null;
    else out[key] = shapeValue(entry, render, 0);
  }
  return out;
}

/**
 * The generic value projection: ADF documents go through `render` (or survive
 * as trees when it is `undefined`, which is what `raw` means), user objects
 * collapse to `{ accountId, displayName?, active? }`, and every other structure
 * is preserved node for node — `fixVersions`, `components`, `versions` and
 * custom fields keep their shape rather than being stringified.
 */
function shapeValue(
  value: unknown,
  render: ((node: unknown) => string) | undefined,
  depth: number,
): unknown {
  if (depth >= MAX_SHAPE_DEPTH) return value;
  if (isUnknownArray(value)) {
    return value.map((entry) => shapeValue(entry, render, depth + 1));
  }
  if (!isRecord(value)) return value;
  if (isAdfDoc(value)) return render === undefined ? value : render(value);
  const user = shapeUser(value);
  if (user !== undefined) return user;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = shapeValue(entry, render, depth + 1);
  }
  return out;
}

/**
 * A user object, or `undefined` when this record is not one. Recognised by
 * `accountId` — Cloud identifies users by nothing else (JIRA-API.md §Users) —
 * and everything else is dropped, `emailAddress` and `avatarUrls` included.
 *
 * Exported alongside {@link shapeIssueFields} for the tool ring.
 */
export function shapeUser(value: unknown): JiraUser | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.accountId !== 'string') return undefined;
  return {
    accountId: record.accountId,
    ...(typeof record.displayName === 'string'
      ? { displayName: record.displayName }
      : {}),
    ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
  };
}

function shapeVisibility(value: unknown): JiraVisibility | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return {
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.value === 'string' ? { value: record.value } : {}),
    ...(typeof record.identifier === 'string' ? { identifier: record.identifier } : {}),
  };
}

function shapeIssueLinks(
  value: unknown,
  render: ((node: unknown) => string) | undefined,
): unknown {
  if (!isUnknownArray(value)) return shapeValue(value, render, 0);
  const links: IssueLink[] = [];
  for (const entry of value) {
    const link = shapeIssueLink(entry);
    if (link !== undefined) links.push(link);
  }
  return links;
}

function shapeIssueLink(value: unknown): IssueLink | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const type = asRecord(record.type) ?? {};
  const outward = shapeLinkedIssue(record.outwardIssue);
  const inward = shapeLinkedIssue(record.inwardIssue);
  const issue = outward ?? inward;
  if (issue === undefined) return undefined;

  const direction: 'inward' | 'outward' = outward === undefined ? 'inward' : 'outward';
  const relation = direction === 'outward' ? type.outward : type.inward;

  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    type: {
      ...(typeof type.id === 'string' ? { id: type.id } : {}),
      ...(typeof type.name === 'string' ? { name: type.name } : {}),
      ...(typeof type.inward === 'string' ? { inward: type.inward } : {}),
      ...(typeof type.outward === 'string' ? { outward: type.outward } : {}),
    },
    direction,
    ...(typeof relation === 'string' ? { relation } : {}),
    issue,
  };
}

/** A `parent` / `inwardIssue` / `outwardIssue` reference, flattened one level. */
function shapeLinkedIssue(value: unknown): LinkedIssueRef | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.key !== 'string') return undefined;
  const fields = asRecord(record.fields) ?? {};
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    key: record.key,
    ...(typeof fields.summary === 'string' ? { summary: fields.summary } : {}),
    ...(namedOf(fields.status) === undefined ? {} : { status: namedOf(fields.status) }),
    ...(namedOf(fields.issuetype) === undefined
      ? {}
      : { issueType: namedOf(fields.issuetype) }),
    ...(namedOf(fields.priority) === undefined
      ? {}
      : { priority: namedOf(fields.priority) }),
  };
}

/** The `name` of a `{ id, name, ... }` reference object, when it has one. */
function namedOf(value: unknown): string | undefined {
  const record = asRecord(value);
  return record !== undefined && typeof record.name === 'string'
    ? record.name
    : undefined;
}

function shapeComment(
  value: unknown,
  format?: 'text' | 'markdown',
): IssueComment | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== 'string') return undefined;
  const author = shapeUser(record.author);
  const updateAuthor = shapeUser(record.updateAuthor);
  const visibility = shapeVisibility(record.visibility);
  const render = format === 'markdown' ? adfToMarkdown : adfToText;
  return {
    id: record.id,
    ...(author === undefined ? {} : { author }),
    ...(updateAuthor === undefined ? {} : { updateAuthor }),
    body: render(record.body),
    ...(typeof record.created === 'string' ? { created: record.created } : {}),
    ...(typeof record.updated === 'string' ? { updated: record.updated } : {}),
    ...(visibility === undefined ? {} : { visibility }),
    ...(typeof record.jsdPublic === 'boolean' ? { jsdPublic: record.jsdPublic } : {}),
  };
}

function shapeWorklog(value: unknown): IssueWorklog | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== 'string') return undefined;
  const author = shapeUser(record.author);
  const updateAuthor = shapeUser(record.updateAuthor);
  const visibility = shapeVisibility(record.visibility);
  const comment = record.comment === undefined ? undefined : adfToText(record.comment);
  return {
    id: record.id,
    ...(typeof record.issueId === 'string' ? { issueId: record.issueId } : {}),
    ...(author === undefined ? {} : { author }),
    ...(updateAuthor === undefined ? {} : { updateAuthor }),
    ...(comment === undefined ? {} : { comment }),
    ...(typeof record.started === 'string' ? { started: record.started } : {}),
    ...(typeof record.timeSpent === 'string' ? { timeSpent: record.timeSpent } : {}),
    ...(typeof record.timeSpentSeconds === 'number'
      ? { timeSpentSeconds: record.timeSpentSeconds }
      : {}),
    ...(typeof record.created === 'string' ? { created: record.created } : {}),
    ...(typeof record.updated === 'string' ? { updated: record.updated } : {}),
    ...(visibility === undefined ? {} : { visibility }),
  };
}

function shapeTransition(value: unknown): IssueTransition | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  // Jira reports the id as a string; a number is tolerated because some older
  // builds sent one and the id is only ever echoed back on the POST.
  const id =
    typeof record.id === 'string'
      ? record.id
      : typeof record.id === 'number'
        ? String(record.id)
        : undefined;
  if (id === undefined) return undefined;

  const to = asRecord(record.to);
  const category = asRecord(to?.statusCategory);
  const fields = asRecord(record.fields);

  return {
    id,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(to === undefined
      ? {}
      : {
          to: {
            ...(typeof to.id === 'string' ? { id: to.id } : {}),
            ...(typeof to.name === 'string' ? { name: to.name } : {}),
            ...(category === undefined
              ? {}
              : {
                  statusCategory: {
                    ...(typeof category.key === 'string' ? { key: category.key } : {}),
                    ...(typeof category.name === 'string' ? { name: category.name } : {}),
                  },
                }),
          },
        }),
    ...boolField(record, 'hasScreen'),
    ...boolField(record, 'isAvailable'),
    ...boolField(record, 'isGlobal'),
    ...boolField(record, 'isInitial'),
    ...boolField(record, 'isConditional'),
    ...boolField(record, 'looped'),
    ...(fields === undefined ? {} : { fields }),
  };
}

function boolField(
  record: Record<string, unknown>,
  key: string,
): Record<string, boolean> {
  const value = record[key];
  return typeof value === 'boolean' ? { [key]: value } : {};
}

function shapeChangelogEntry(value: unknown): ChangelogEntry | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const author = shapeUser(record.author);
  const items: Readonly<Record<string, unknown>>[] = isUnknownArray(record.items)
    ? record.items.filter(isRecord)
    : [];
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.created === 'string' ? { created: record.created } : {}),
    ...(author === undefined ? {} : { author }),
    items,
  };
}

/** The `changelog` block `expand=changelog` embeds in an issue read. */
function shapeChangelogBlock(value: unknown): IssueChangelog | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const rows = isUnknownArray(record.histories) ? record.histories : [];
  const histories: ChangelogEntry[] = [];
  for (const row of rows) {
    const entry = shapeChangelogEntry(row);
    if (entry !== undefined) histories.push(entry);
  }
  return {
    histories,
    ...(typeof record.startAt === 'number' ? { startAt: record.startAt } : {}),
    ...(typeof record.maxResults === 'number' ? { maxResults: record.maxResults } : {}),
    ...(typeof record.total === 'number' ? { total: record.total } : {}),
  };
}

// ---------------------------------------------------------------------------
// 10. Transport helpers
// ---------------------------------------------------------------------------

/** Stamp cancellation and the call budget onto a spec, then send it. */
async function send(
  options: IssueRequestBase & BudgetGuard,
  spec: JiraRequestSpec,
): Promise<JiraResponse> {
  return options.jira({
    ...spec,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });
}

interface ClassicListSpec<T> {
  readonly defaultPageSize: number;
  /** Appended to `/issue/{id}` — already a literal, never caller data. */
  readonly suffix: string;
  readonly pathTemplate: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  /** The array key in the response body: `comments`, `worklogs`, `values`. */
  readonly collection: string;
  readonly map: (row: unknown) => T | undefined;
}

/**
 * Drive one classic (`startAt`/`maxResults`) collection under an issue.
 *
 * Always goes through {@link fetchAll} — even for the default single page — so
 * the stop-reason contract, the abort/budget boundary checks and the page cap
 * come from `api/shared.ts` rather than being re-derived per endpoint.
 */
async function classicList<T>(
  options: ClassicListBase & BudgetGuard,
  spec: ClassicListSpec<T>,
): Promise<{ items: readonly T[]; meta: ClassicListMeta }> {
  const startAt = normalizeStartAt(options.startAt);
  const pageSize = normalizePageSize(options.maxResults ?? spec.defaultPageSize);
  const path = issuePath(options.issue, spec.suffix);

  const request = (cursor: ClassicCursor): JiraRequestSpec => ({
    method: 'GET',
    path,
    pathTemplate: spec.pathTemplate,
    query: {
      startAt: cursor.startAt,
      maxResults: cursor.maxResults,
      ...(spec.query ?? {}),
    },
  });

  const readPage = (response: JiraResponse): ClassicPage<T> => {
    const data = requireRecord(response.data, spec.collection);
    const rows = data[spec.collection] ?? [];
    if (!isUnknownArray(rows)) {
      throw shapeError(`"${spec.collection}" is present but is not an array`);
    }
    const items: T[] = [];
    for (const row of rows) {
      const mapped = spec.map(row);
      if (mapped !== undefined) items.push(mapped);
    }
    return {
      items,
      ...(typeof data.isLast === 'boolean' ? { isLast: data.isLast } : {}),
      ...(typeof data.total === 'number' ? { total: data.total } : {}),
      ...(typeof data.startAt === 'number' ? { startAt: data.startAt } : {}),
      ...(typeof data.maxResults === 'number' ? { maxResults: data.maxResults } : {}),
    };
  };

  const base = {
    jira: options.jira,
    request,
    readPage,
    startAt,
    pageSize,
    maxPages: options.maxPages ?? DEFAULT_LIST_MAX_PAGES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const loop = await fetchAll<T>({ ...base, ...budgetOf(options) });

  return {
    items: loop.items,
    meta: {
      pages: loop.pages,
      stopReason: loop.stopReason,
      partial: loop.partial,
      startAt,
      maxResults: pageSize,
      ...(loop.total === undefined ? {} : { total: loop.total }),
      ...(loop.nextStartAt === undefined ? {} : { nextStartAt: loop.nextStartAt }),
    },
  };
}

// ---------------------------------------------------------------------------
// 11. Paths and input normalization
// ---------------------------------------------------------------------------

/**
 * `/issue/<encoded key>` plus an optional LITERAL suffix.
 *
 * The key is percent-encoded on its own, per the `JiraRequestSpec.path`
 * contract: encoding the whole path would eat the slashes, and encoding nothing
 * would let a key carry a `../` into the URL. `encodeSegment` rejects the
 * traversal and control-character cases outright rather than encoding them.
 */
function issuePath(issue: string, suffix = ''): string {
  const key = requireText(issue, 'issue key or id', ISSUE_REMEDIATION);
  return `${ISSUE_COLLECTION_PATH}/${encodeSegment(key, 'issue key or id')}${suffix}`;
}

const ISSUE_REMEDIATION =
  'Pass the issue key (for example PROJ-123) or its numeric id; jira_search ' +
  'finds one from a JQL query.';

/**
 * Validate a comment id and return it as a path segment (D22). Jira comment ids
 * are always positive integers, so anything else is a caller mistake — most
 * often the comment BODY or an author name — and the check doubles as the
 * guarantee that no unencoded caller string reaches the URL.
 */
function commentIdSegment(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `A comment id must be a positive integer, received ${JSON.stringify(String(value))}.`,
      remediation:
        'Read the thread with jira_get_comments and pass data.comments[].id, ' +
        'which is the numeric id of the comment to edit.',
    });
  }
  return text;
}

/** A non-empty trimmed string, or a `validation` error naming the input. */
function requireText(value: string, what: string, remediation?: string): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (clean === '') {
    throw createJiraError({
      kind: 'validation',
      reason: `A ${what} is required and must not be empty.`,
      ...(remediation === undefined ? {} : { remediation }),
    });
  }
  return clean;
}

/** `{ id }` for an all-digit value, `{ key }` otherwise — projects and issues. */
function keyOrIdRef(value: string, what: string): Record<string, string> {
  const clean = requireText(value, what);
  return /^\d+$/.test(clean) ? { id: clean } : { key: clean };
}

/** `{ id }` for an all-digit value, `{ name }` otherwise — types, priorities. */
function nameOrIdRef(value: string, what: string): Record<string, string> {
  const clean = requireText(value, what);
  return /^\d+$/.test(clean) ? { id: clean } : { name: clean };
}

function normalizeLabels(labels: readonly string[]): string[] {
  return labels.map((label) => requireText(label, 'label'));
}

/**
 * Merge the raw `fields` passthrough into the named ones. A key set by BOTH is a
 * validation error rather than a silent winner: either resolution order surprises
 * somebody, and the surprise is a wrong write.
 */
function mergeExtraFields(
  named: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (extra === undefined) return named;
  const out: Record<string, unknown> = { ...named };
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(named, key)) {
      throw createJiraError({
        kind: 'validation',
        reason: `The field "${key}" was set twice: once as a named option and once in the raw fields object.`,
        remediation: `Set ${key} in exactly one place — drop it from the raw fields object, or drop the named option.`,
      });
    }
    out[key] = value;
  }
  return out;
}

/** CC-22 — `accountId` and `unassign` are mutually exclusive, and one is required. */
function resolveAssignee(input: AssignIssueInput): string | null {
  const unassign = input.unassign === true;
  const named = input.accountId !== undefined && input.accountId.trim() !== '';
  if (unassign && named) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'accountId and unassign: true were both supplied, so the intended ' +
        'assignee is ambiguous.',
      remediation:
        'Pass accountId to assign, or unassign: true to clear the assignee — ' +
        'never both.',
    });
  }
  if (unassign) return null;
  if (!named) {
    throw createJiraError({
      kind: 'validation',
      reason: 'An assignment needs either an accountId or unassign: true.',
      remediation:
        'Jira Cloud identifies users by accountId only; jira_search_users turns a ' +
        'display name or email into one.',
    });
  }
  return requireText(input.accountId ?? '', 'accountId');
}

/** Exactly one of `timeSpentSeconds` / `timeSpent`, as TOOLS.md specifies. */
function resolveTimeSpent(input: AddWorklogInput): Record<string, unknown> {
  const hasSeconds = input.timeSpentSeconds !== undefined;
  const hasText = input.timeSpent !== undefined && input.timeSpent.trim() !== '';
  if (hasSeconds === hasText) {
    throw createJiraError({
      kind: 'validation',
      reason: hasSeconds
        ? 'timeSpentSeconds and timeSpent were both supplied; Jira accepts exactly one.'
        : 'A worklog needs the time spent: either timeSpentSeconds or timeSpent.',
      remediation:
        'Pass timeSpentSeconds (preferred, e.g. 9000) or timeSpent as a Jira ' +
        'duration string (e.g. "2h 30m") — never both.',
    });
  }
  if (hasSeconds) {
    const seconds = input.timeSpentSeconds ?? 0;
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw createJiraError({
        kind: 'validation',
        reason: `timeSpentSeconds must be a whole number of seconds above zero, received ${String(seconds)}.`,
        remediation: 'Pass the duration in seconds, e.g. 9000 for two and a half hours.',
      });
    }
    return { timeSpentSeconds: seconds };
  }
  return { timeSpent: requireText(input.timeSpent ?? '', 'timeSpent') };
}

function normalizeOffsetMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || Math.abs(minutes) > 14 * 60) {
    throw createJiraError({
      kind: 'validation',
      reason: `utcOffsetMinutes must be a whole number of minutes within ±14 hours, received ${String(minutes)}.`,
      remediation:
        "Pass the offset of the authenticated user's Jira timezone in minutes east " +
        'of UTC (+05:30 is 330); utcOffsetMinutesForZone converts a zone name.',
    });
  }
  return minutes;
}

function normalizeStartAt(startAt: number | undefined): number {
  if (startAt === undefined) return 0;
  if (!Number.isInteger(startAt) || startAt < 0) {
    throw createJiraError({
      kind: 'validation',
      reason: `startAt must be a whole number of rows, zero or more, received ${String(startAt)}.`,
      remediation:
        'Pass the offset the previous page reported as nextStartAt, or omit it.',
    });
  }
  return startAt;
}

function normalizePageSize(maxResults: number): number {
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw createJiraError({
      kind: 'validation',
      reason: `maxResults must be a whole number of at least 1, received ${String(maxResults)}.`,
      remediation: `Pass maxResults between 1 and ${String(MAX_PAGE_SIZE)}, or omit it.`,
    });
  }
  return Math.min(maxResults, MAX_PAGE_SIZE);
}

/** Trim, drop the blanks, keep the order — for `fields`/`expand`/`properties`. */
function normalizeList(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  return values.map((value) => value.trim()).filter((value) => value !== '');
}

/** Jira takes list query parameters as CSV; an empty list is omitted entirely. */
function csv(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : values.join(',');
}

function trimmedOr(value: string | undefined, fallback: string): string {
  const clean = value?.trim() ?? '';
  return clean === '' ? fallback : clean;
}

// ---------------------------------------------------------------------------
// 12. Errors and guards
// ---------------------------------------------------------------------------

/**
 * CC-21 — a 400 from the transition POST, re-aimed. Jira's own messages are
 * carried through verbatim in `jiraMessages` and in the reason; only the
 * remediation changes, because the generic "correct the fields" advice is wrong
 * for the common cause: a transition id that was valid when it was read and is
 * not valid now.
 */
function staleTransition(cause: JiraError, transitionId: string): JiraError {
  const said = cause.jiraMessages ?? [];
  return createJiraError({
    kind: 'validation',
    reason:
      `Jira rejected transition ${transitionId} for this issue` +
      `${said.length === 0 ? '' : `: ${said.join('; ')}`}.`,
    remediation:
      'Re-fetch the transitions for this issue (jira_get_transitions) and use an ' +
      'id from that list: the available transitions depend on the current status ' +
      'and change whenever the workflow or the issue does. If the transition ' +
      'screen requires fields (a resolution, for example), pass them too.',
    httpStatus: cause.httpStatus,
    ...(said.length === 0 ? {} : { jiraMessages: said }),
    ...(cause.detail === undefined ? {} : { detail: cause.detail }),
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which then leaks `any` through
 * every element read. This guard lands on `readonly unknown[]` instead, so wire
 * arrays stay as untyped as they really are.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw shapeError(`the ${what} response is not a JSON object`);
  return value;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw shapeError(`${what} is missing or not a string`);
  }
  return value;
}

function shapeError(what: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason: `Jira's issue response could not be read: ${what}.`,
  });
}

// ---------------------------------------------------------------------------
// 13. Deletes (D45 / WP-72)
//
// Appended rather than filed beside the other writes so this work package moves
// no existing line of the file. The rules above still hold — the requests are
// unsafe (never replayed), each is split builder/executor for plan mode, and
// every dynamic segment is validated before it can reach a URL.
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
  readonly format?: 'text' | 'markdown';
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
  if (comment === undefined) throw shapeError('the comment has no string "id"');
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
  if (worklog === undefined) throw shapeError('the worklog has no string "id"');
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
function worklogIdSegment(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `A worklog id must be a positive integer, received ${JSON.stringify(String(value))}.`,
      remediation:
        'Read the log with jira_get_worklogs and pass data.worklogs[].id, which is ' +
        'the numeric id of the entry to delete.',
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
