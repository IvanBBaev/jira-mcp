// ---------------------------------------------------------------------------
// api/issues.ts — the issue surface: every read and every write v1 ships (WP-21).
//
// One domain, six rules that the modules under `api/issues/` exist to enforce:
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
//     `deleteIssue`, `deleteComment` and `deleteWorklog` live in `issues/deletes.ts`,
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

// This module is a re-export barrel (D517). The code lives in `api/issues/`,
// split by concern first and by sub-domain second:
//
//   paths.ts          wire constants and path templates
//   types.ts          read result shapes and read options
//   write-types.ts    write inputs, options and results
//   read.ts           single-issue reads, comments, worklogs, transitions
//   bulk.ts           the issue bulkfetch (D149)
//   changelog.ts      changelog reads, bulk and Data Center
//   requests.ts       the pure write request builders (CC-20)
//   write.ts          the write executors
//   time.ts           worklog time (D16 / CC-23), pure, no api imports
//   shape.ts          read shaping (the user shaper is `api/users.ts`)
//   classic-list.ts   the classic-pagination list reader
//   input.ts          paths and input normalization
//   errors.ts         error re-aiming and response guards
//   deletes.ts        the delete tier (D45)
//   worklog-edit.ts   worklog edit (D142)
//   issue-links.ts    issue link read and delete (D143)
//   remote-links.ts   remote links (D141, D145)
//
// Nothing outside `api/issues*` imports a module under `api/issues/`; the
// public surface is exactly the list below.

export {
  ISSUE_COLLECTION_PATH,
  ISSUE_BULKFETCH_PATH,
  CHANGELOG_BULKFETCH_PATH,
  ISSUE_LINK_PATH,
  ISSUE_PATH_TEMPLATE,
  ISSUE_COMMENT_PATH_TEMPLATE,
  ISSUE_COMMENT_ITEM_PATH_TEMPLATE,
  ISSUE_TRANSITIONS_PATH_TEMPLATE,
  ISSUE_WORKLOG_PATH_TEMPLATE,
  ISSUE_CHANGELOG_PATH_TEMPLATE,
  ISSUE_ASSIGNEE_PATH_TEMPLATE,
  DEFAULT_COMMENT_ORDER_BY,
  DEFAULT_COMMENT_PAGE_SIZE,
  DEFAULT_WORKLOG_PAGE_SIZE,
  DEFAULT_CHANGELOG_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_LIST_MAX_PAGES,
  MAX_SHAPE_DEPTH,
} from './issues/paths.js';
export {
  MAX_BULK_ISSUES,
  MAX_BULK_ISSUES_EFFICIENT,
  MAX_BULK_EFFICIENT_FIELDS,
  BULK_RESTRICTED_EXPANDS,
  MAX_BULK_CHANGELOG_ISSUES,
  MAX_BULK_CHANGELOG_RESULTS,
} from './issues/types.js';
export type {
  JiraVisibility,
  LinkedIssueRef,
  IssueLink,
  ChangelogEntry,
  IssueChangelog,
  IssueDetail,
  IssueComment,
  IssueWorklog,
  IssueTransition,
  ClassicListMeta,
  CommentsResult,
  WorklogsResult,
  ChangelogResult,
  ChangelogIncomplete,
  TransitionsResult,
  IssueRequestBase,
  ClassicListBase,
  GetIssueBase,
  GetIssueOptions,
  GetIssuesBulkBase,
  GetIssuesBulkOptions,
  IssueRecord,
  IssueBulkError,
  IssuesBulkResult,
  GetChangelogsBulkBase,
  GetChangelogsBulkOptions,
  IssueChangelogPage,
  ChangelogsBulkResult,
  ListCommentsBase,
  ListCommentsOptions,
  ListWorklogsOptions,
  ListChangelogOptions,
  ListTransitionsBase,
  ListTransitionsOptions,
} from './issues/types.js';
export {
  getIssue,
  listComments,
  listWorklogs,
  listTransitions,
  resolveTransitionId,
  NO_TRANSITION_MATCHES,
  AMBIGUOUS_TRANSITION,
} from './issues/read.js';
export { getIssuesBulk, bulkFetchIneligibility } from './issues/bulk.js';
export {
  listChangelog,
  getChangelogsBulk,
  listChangelogDataCenter,
} from './issues/changelog.js';
export type {
  CreateIssueInput,
  CreateIssueOptions,
  CreatedIssue,
  UpdateIssueInput,
  UpdateIssueOptions,
  UpdateIssueResult,
  TransitionIssueInput,
  TransitionIssueOptions,
  TransitionIssueResult,
  AddCommentInput,
  AddCommentOptions,
  UpdateCommentInput,
  UpdateCommentOptions,
  AssignIssueInput,
  AssignIssueOptions,
  CloudAssignIssueResult,
  DataCenterAssignIssueResult,
  AssignIssueResult,
  AddWorklogInput,
  AddWorklogOptions,
  LinkIssuesInput,
  LinkIssuesOptions,
  LinkIssuesResult,
} from './issues/write-types.js';
export {
  createIssueRequest,
  updateIssueRequest,
  transitionIssueRequest,
  addCommentRequest,
  updateCommentRequest,
  assignIssueRequest,
  assignIssueDataCenterRequest,
  addWorklogRequest,
  linkIssuesRequest,
} from './issues/requests.js';
export {
  createIssue,
  updateIssue,
  transitionIssue,
  addComment,
  updateComment,
  assignIssue,
  assignIssueDataCenter,
  addWorklog,
  linkIssues,
} from './issues/write.js';
export {
  formatJiraTimestamp,
  utcOffsetMinutesForZone,
  WORKLOG_STARTED_PATTERN,
  startedInstant,
} from './issues/time.js';
export type { StartedInstant } from './issues/time.js';
export { shapeIssueFields } from './issues/shape.js';
export { shapeUser } from './users.js';
export {
  ISSUE_WORKLOG_ITEM_PATH_TEMPLATE,
  getComment,
  getWorklog,
  deleteIssueRequest,
  deleteCommentRequest,
  deleteWorklogRequest,
  deleteIssue,
  deleteComment,
  deleteWorklog,
} from './issues/deletes.js';
export type {
  GetCommentBase,
  GetCommentOptions,
  GetWorklogBase,
  GetWorklogOptions,
  DeleteIssueInput,
  DeleteIssueOptions,
  DeleteIssueResult,
  DeleteCommentInput,
  DeleteCommentOptions,
  DeleteCommentResult,
  DeleteWorklogInput,
  DeleteWorklogOptions,
  DeleteWorklogResult,
} from './issues/deletes.js';
export {
  ISSUE_REMOTE_LINK_PATH_TEMPLATE,
  listRemoteLinks,
  addRemoteLinkRequest,
  addRemoteLink,
  ISSUE_REMOTE_LINK_ITEM_PATH_TEMPLATE,
  getRemoteLink,
  deleteRemoteLinkRequest,
  deleteRemoteLink,
} from './issues/remote-links.js';
export type {
  RemoteLink,
  RemoteLinksResult,
  ListRemoteLinksBase,
  ListRemoteLinksOptions,
  AddRemoteLinkInput,
  AddRemoteLinkOptions,
  AddRemoteLinkResult,
  RemoteLinkRef,
  GetRemoteLinkOptions,
  DeleteRemoteLinkOptions,
  DeleteRemoteLinkResult,
} from './issues/remote-links.js';
export { updateWorklogRequest, updateWorklog } from './issues/worklog-edit.js';
export type { UpdateWorklogInput, UpdateWorklogOptions } from './issues/worklog-edit.js';
export {
  ISSUE_LINK_ITEM_PATH_TEMPLATE,
  getIssueLink,
  deleteIssueLinkRequest,
  deleteIssueLink,
} from './issues/issue-links.js';
export type {
  IssueLinkDetail,
  GetIssueLinkBase,
  GetIssueLinkOptions,
  DeleteIssueLinkInput,
  DeleteIssueLinkOptions,
  DeleteIssueLinkResult,
} from './issues/issue-links.js';

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
export type { JiraUser } from './users.js';
