// ---------------------------------------------------------------------------
// api/port.ts — the domain-level port between the tools ring and the api ring
// (Phase 13, stage 13.1, D106).
//
// D104 found that the only seam this codebase had was `JiraRequestFn`, which is
// transport-level: it can change WHERE a request goes (origin, path prefix,
// root) but not WHAT the request is. Tools imported concrete functions out of
// `src/api/*`, so a backend whose routes, bodies or user identifiers differ in
// shape — Jira Data Center: v2 routes, wiki markup instead of ADF, `name`/`key`
// instead of `accountId` — had nowhere to plug in without branching inside
// every api function.
//
// This module is that seam. {@link JiraApi} names every api-ring function the
// tools ring may call, and a tool reaches them only through `ctx.api`. The
// registry chooses the implementation once per server; {@link CLOUD_API} is the
// only one that exists today, and it is nothing but the existing functions, by
// identity — adopting the port changes no request, no body and no result.
//
// What belongs in the port, and what does not:
//
//   * IN: every function that talks to Jira (it takes a `jira` request
//     function), and every converter whose output or input is a WIRE BODY
//     FORMAT — `adfFromMarkdown`, `extractMentions`, `shapeIssueFields` — since
//     ADF is exactly what a Data Center adapter would replace.
//   * OUT: constants, types, and pure helpers whose meaning does not depend on
//     the backend (`resolveTransitionId`, `startedInstant`, `filterFields`).
//     Tools keep importing those directly. `src/tools/port-boundary.test.ts`
//     enforces the split: a tool that imports any other api-ring FUNCTION
//     directly fails the suite, so a new tool cannot bypass the port by
//     accident.
//
// The signatures are the Cloud functions' own (`typeof`), on purpose: the port
// is the domain contract the tools were already written against, and a second
// adapter conforms to it rather than the tools conforming to two.
// ---------------------------------------------------------------------------

import { adfFromMarkdown, extractMentions } from './adf.js';
import {
  closeSprint,
  updateSprint,
  rankIssues,
  setEstimate,
  createSprint,
  deleteSprint,
  getBoardConfiguration,
  getSprint,
  listBoards,
  listSprintIssues,
  listBacklogIssues,
  listSprints,
  moveIssuesToBacklog,
  moveIssuesToSprint,
  startSprint,
} from './agile.js';
import {
  deleteAttachment,
  downloadAttachment,
  getAttachment,
  listAttachments,
  uploadAttachment,
} from './attachments.js';
import { getBulkStatus, submitBulkDelete, submitBulkEdit } from './bulk.js';
import {
  addVote,
  addWatcher,
  createComponent,
  createVersion,
  deleteComponent,
  deleteVersion,
  getComponent,
  getComponentRelatedIssueCounts,
  getProjectRole,
  getVersion,
  getVersionRelatedIssueCounts,
  listComponents,
  listProjectRoles,
  listVersions,
  listWatchers,
  removeVote,
  removeWatcher,
  updateComponent,
  updateVersion,
} from './collab.js';
import { createFilter, getFilter, searchFilters, updateFilter } from './filters.js';
import {
  addComment,
  addRemoteLink,
  addWorklog,
  assignIssue,
  createIssue,
  deleteComment,
  deleteIssue,
  deleteIssueLink,
  deleteRemoteLink,
  deleteWorklog,
  getComment,
  getIssue,
  getIssueLink,
  getChangelogsBulk,
  getIssuesBulk,
  getRemoteLink,
  getWorklog,
  linkIssues,
  listChangelog,
  listComments,
  listRemoteLinks,
  listTransitions,
  listWorklogs,
  shapeIssueFields,
  transitionIssue,
  updateComment,
  updateIssue,
  updateWorklog,
} from './issues.js';
import {
  getCreateMeta,
  getProject,
  listCreateMetaIssueTypes,
  listFields,
  listLinkTypes,
  listPriorities,
  listResolutions,
  listIssueTypes,
  getTimeTrackingConfig,
  listLabels,
  listProjects,
  listStatuses,
} from './meta.js';
import { getMyPermissions } from './permissions.js';
import { approximateCount, parseJql, searchIssues } from './search.js';
import {
  getMyself,
  resolveMentionNames,
  searchUsers,
  type SearchUsersOptions,
  type SearchUsersResult,
  type ShapedUser,
} from './users.js';
import type { JiraDeployment } from '../core/types.js';

/** Which backend an adapter speaks to. Only `cloud` has an adapter so far (D106). */
export type { JiraDeployment };

/**
 * Every api-ring function the tools ring may call. One flat namespace: the
 * names are already unique across the api modules, and a flat `ctx.api.getIssue`
 * reads the same as the direct call it replaced.
 *
 * Produced by: this module ({@link CLOUD_API}).
 * Consumed by: `mcp/registry.ts` (puts it on `ToolCtx.api`), every tool handler.
 */
export interface JiraApi {
  readonly deployment: JiraDeployment;
  /**
   * The tool names this adapter can serve; absent means every tool. The
   * registry excludes the rest (`deployment_unsupported`), so a tool whose
   * routes the backend lacks is never listed rather than failing when called.
   */
  readonly serves?: ReadonlySet<string>;

  // --- wire body format (ADF on Cloud) ---
  readonly adfFromMarkdown: typeof adfFromMarkdown;
  readonly extractMentions: typeof extractMentions;
  readonly shapeIssueFields: typeof shapeIssueFields;

  // --- agile ---
  readonly closeSprint: typeof closeSprint;
  readonly updateSprint: typeof updateSprint;
  readonly rankIssues: typeof rankIssues;
  readonly setEstimate: typeof setEstimate;
  readonly createSprint: typeof createSprint;
  readonly deleteSprint: typeof deleteSprint;
  readonly getBoardConfiguration: typeof getBoardConfiguration;
  readonly getSprint: typeof getSprint;
  readonly listBoards: typeof listBoards;
  readonly listSprintIssues: typeof listSprintIssues;
  readonly listBacklogIssues: typeof listBacklogIssues;
  readonly listSprints: typeof listSprints;
  readonly moveIssuesToBacklog: typeof moveIssuesToBacklog;
  readonly moveIssuesToSprint: typeof moveIssuesToSprint;
  readonly startSprint: typeof startSprint;

  // --- attachments ---
  readonly deleteAttachment: typeof deleteAttachment;
  readonly downloadAttachment: typeof downloadAttachment;
  readonly getAttachment: typeof getAttachment;
  readonly listAttachments: typeof listAttachments;
  readonly uploadAttachment: typeof uploadAttachment;

  // --- bulk ---
  readonly getBulkStatus: typeof getBulkStatus;
  readonly submitBulkDelete: typeof submitBulkDelete;
  readonly submitBulkEdit: typeof submitBulkEdit;

  // --- collab ---
  readonly addVote: typeof addVote;
  readonly addWatcher: typeof addWatcher;
  readonly createComponent: typeof createComponent;
  readonly createVersion: typeof createVersion;
  readonly deleteComponent: typeof deleteComponent;
  readonly deleteVersion: typeof deleteVersion;
  readonly getComponent: typeof getComponent;
  readonly getComponentRelatedIssueCounts: typeof getComponentRelatedIssueCounts;
  readonly getProjectRole: typeof getProjectRole;
  readonly getVersion: typeof getVersion;
  readonly getVersionRelatedIssueCounts: typeof getVersionRelatedIssueCounts;
  readonly listComponents: typeof listComponents;
  readonly listProjectRoles: typeof listProjectRoles;
  readonly listVersions: typeof listVersions;
  readonly listWatchers: typeof listWatchers;
  readonly removeVote: typeof removeVote;
  readonly removeWatcher: typeof removeWatcher;
  readonly updateComponent: typeof updateComponent;
  readonly updateVersion: typeof updateVersion;

  // --- filters ---
  readonly createFilter: typeof createFilter;
  readonly getFilter: typeof getFilter;
  readonly searchFilters: typeof searchFilters;
  readonly updateFilter: typeof updateFilter;

  // --- issues ---
  readonly addComment: typeof addComment;
  readonly addRemoteLink: typeof addRemoteLink;
  readonly addWorklog: typeof addWorklog;
  readonly assignIssue: typeof assignIssue;
  readonly createIssue: typeof createIssue;
  readonly deleteComment: typeof deleteComment;
  readonly deleteIssue: typeof deleteIssue;
  readonly deleteIssueLink: typeof deleteIssueLink;
  readonly deleteRemoteLink: typeof deleteRemoteLink;
  readonly deleteWorklog: typeof deleteWorklog;
  readonly getComment: typeof getComment;
  readonly getIssue: typeof getIssue;
  readonly getChangelogsBulk: typeof getChangelogsBulk;
  readonly getIssuesBulk: typeof getIssuesBulk;
  readonly getIssueLink: typeof getIssueLink;
  readonly getRemoteLink: typeof getRemoteLink;
  readonly getWorklog: typeof getWorklog;
  readonly linkIssues: typeof linkIssues;
  readonly listChangelog: typeof listChangelog;
  readonly listComments: typeof listComments;
  readonly listRemoteLinks: typeof listRemoteLinks;
  readonly listTransitions: typeof listTransitions;
  readonly listWorklogs: typeof listWorklogs;
  readonly transitionIssue: typeof transitionIssue;
  readonly updateComment: typeof updateComment;
  readonly updateIssue: typeof updateIssue;
  readonly updateWorklog: typeof updateWorklog;

  // --- meta ---
  readonly getCreateMeta: typeof getCreateMeta;
  readonly getProject: typeof getProject;
  readonly listCreateMetaIssueTypes: typeof listCreateMetaIssueTypes;
  readonly listFields: typeof listFields;
  readonly listLinkTypes: typeof listLinkTypes;
  readonly listPriorities: typeof listPriorities;
  readonly listResolutions: typeof listResolutions;
  readonly listIssueTypes: typeof listIssueTypes;
  readonly getTimeTrackingConfig: typeof getTimeTrackingConfig;
  readonly listLabels: typeof listLabels;
  readonly listProjects: typeof listProjects;
  readonly listStatuses: typeof listStatuses;

  // --- permissions ---
  readonly getMyPermissions: typeof getMyPermissions;

  // --- search ---
  readonly approximateCount: typeof approximateCount;
  readonly parseJql: typeof parseJql;
  readonly searchIssues: typeof searchIssues;

  // --- users ---
  readonly getMyself: typeof getMyself;
  readonly resolveMentionNames: typeof resolveMentionNames;
  /**
   * Widened from `typeof searchUsers` (D110): the Data Center twin answers with
   * `name` + `key` users, which carry no accountId.
   */
  readonly searchUsers: (
    options: SearchUsersOptions,
  ) => Promise<SearchUsersResult<ShapedUser>>;
}

/**
 * The Jira Cloud adapter: the existing api-ring functions, by identity. Frozen,
 * so no caller can swap a function out from under every later tool call.
 */
export const CLOUD_API: JiraApi = Object.freeze({
  deployment: 'cloud',

  adfFromMarkdown,
  extractMentions,
  shapeIssueFields,

  closeSprint,
  updateSprint,
  rankIssues,
  setEstimate,
  createSprint,
  deleteSprint,
  getBoardConfiguration,
  getSprint,
  listBoards,
  listSprintIssues,
  listBacklogIssues,
  listSprints,
  moveIssuesToBacklog,
  moveIssuesToSprint,
  startSprint,

  deleteAttachment,
  downloadAttachment,
  getAttachment,
  listAttachments,
  uploadAttachment,

  getBulkStatus,
  submitBulkDelete,
  submitBulkEdit,

  addVote,
  addWatcher,
  createComponent,
  createVersion,
  deleteComponent,
  deleteVersion,
  getComponent,
  getComponentRelatedIssueCounts,
  getProjectRole,
  getVersion,
  getVersionRelatedIssueCounts,
  listComponents,
  listProjectRoles,
  listVersions,
  listWatchers,
  removeVote,
  removeWatcher,
  updateComponent,
  updateVersion,

  createFilter,
  getFilter,
  searchFilters,
  updateFilter,

  addComment,
  addRemoteLink,
  addWorklog,
  assignIssue,
  createIssue,
  deleteComment,
  deleteIssue,
  deleteIssueLink,
  deleteRemoteLink,
  deleteWorklog,
  getComment,
  getIssue,
  getIssueLink,
  getChangelogsBulk,
  getIssuesBulk,
  getRemoteLink,
  getWorklog,
  linkIssues,
  listChangelog,
  listComments,
  listRemoteLinks,
  listTransitions,
  listWorklogs,
  transitionIssue,
  updateComment,
  updateIssue,
  updateWorklog,

  getCreateMeta,
  getProject,
  listCreateMetaIssueTypes,
  listFields,
  listLinkTypes,
  listPriorities,
  listResolutions,
  listIssueTypes,
  getTimeTrackingConfig,
  listLabels,
  listProjects,
  listStatuses,

  getMyPermissions,

  approximateCount,
  parseJql,
  searchIssues,

  getMyself,
  resolveMentionNames,
  searchUsers,
});
