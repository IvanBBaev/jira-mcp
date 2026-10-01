// ---------------------------------------------------------------------------
// api/datacenter.ts — the Jira Data Center adapter: reads (Phase 13,
// stage 13.3, D106), the first writes (stage 13.4b, D109), the user writes
// (stage 13.5b, D111), mention resolution (stage 13.6a, D112), the
// reversible admin and agile writes (stage 13.6b, D113), the count,
// changelog and attachment reads (stage 13.6c, D114), the saved filter
// reads (stage 13.7a, D115) and the create metadata (stage 13.7b, D116).
//
// UNVERIFIED. Every route and shape below comes from Atlassian's Data Center
// REST documentation; none has been exercised against a Data Center instance
// (D104's condition, carried by D106). The adapter is reachable only behind
// `JIRA_DATACENTER_PREVIEW=true`, and says so at startup.
//
// What Data Center changes, and where each difference is absorbed:
//
//   * The platform root is `/rest/api/2` — there is no v3. For the routes whose
//     shape is the same on both products (issue, comment, worklog, transitions,
//     field, issueLinkType, project/{key}) the Cloud function is reused through
//     {@link onV2}, which moves the request to the v2 root and nothing else.
//     The agile root (`/rest/agile/1.0`) is the same on Jira Software DC and is
//     left alone.
//   * Users have no `accountId`; they are `name` + `key`. Every read that shapes
//     users gets `deployment: 'datacenter'`, which switches the projection to
//     the Data Center allowlist — without it a DC user would fall through the
//     Cloud rule with its `emailAddress` intact.
//   * Rich text is wiki markup, not ADF. The known rich-text fields are
//     flattened to text by `api/wiki.ts` in `adfToText`'s conventions (`raw`
//     returns the markup as sent); `format: "markdown"` is refused, because
//     there is no wiki → markdown renderer and a mislabelled answer would be
//     a lie the model would repeat.
//   * `/search/jql`, `/project/search` and `/statuses/search` are Cloud-only,
//     and the paginated component/version routes are not relied on; their Data
//     Center twins live next to the Cloud functions (`searchIssuesDataCenter`,
//     `listProjectsDataCenter`, `listStatusesDataCenter`,
//     `listComponentsDataCenter`, `listVersionsDataCenter`,
//     `searchUsersDataCenter`), where the private mappers are.
//   * `/search/approximate-count` and `/issue/{key}/changelog` are Cloud-only
//     too (D114): the count is the classic search's exact `total`
//     (`countIssuesDataCenter`, `approximate: false`), and the history is the
//     block `expand=changelog` embeds in an issue read
//     (`listChangelogDataCenter`, which says `incomplete` when that block does
//     not cover the whole history). The attachment list is the Cloud route on
//     v2 with a Data Center author (`listAttachmentsDataCenter`); downloads
//     and uploads are not served.
//   * `/filter/search` is not relied on either (D115): the filter list is the
//     caller's favourites (`GET /filter/favourite`, `searchFiltersDataCenter`),
//     with `filterName` and paging applied client-side, `accountId` refused,
//     and a `scope` note saying the list is favourites only; one filter is
//     `GET /filter/{id}` on v2 (`getFilterDataCenter`). Both owners are the
//     Data Center user projection.
//   * The create metadata (D116) is served over the paged per-project routes
//     only (`/issue/createmeta/{p}/issuetypes[/{t}]`, Data Center 8.4+),
//     whose rows come in `values` rather than Cloud's `issueTypes`/`fields`
//     (`listCreateMetaIssueTypesDataCenter`, `getCreateMetaDataCenter`). The
//     legacy `/issue/createmeta?expand=` is never called — Jira 9.0 removed it
//     — and a 404 without a Jira message says the host needs 8.4 or later.
//   * Writes (D109) reuse the Cloud builders through {@link onV2Wiki}, which
//     also renders every ADF document in the body to wiki markup, so plan mode
//     captures the Data Center body. User fields are refused: an accountId
//     names nobody on Data Center.
//   * The user writes (D111) take a `username`: assignment and the watcher
//     writes have Data Center twins next to the Cloud functions
//     (`assignIssueDataCenter`, `addWatcherDataCenter`,
//     `removeWatcherDataCenter`) that build `{ name }`, the bare username
//     string and `?username=`; an accountId is refused there, and a username
//     is refused by the Cloud functions. Votes carry no user and reuse the
//     Cloud functions through {@link onV2}.
//   * The admin and agile writes (D113): component and version create/update
//     reuse the Cloud functions on the v2 root (`/component`, `/version` are
//     long-standing there, with the same body fields); a component lead is an
//     accountId on Cloud and a `leadUserName` on Data Center, so
//     `leadAccountId` is refused and no lead is sent. The sprint writes and
//     the two moves are on the agile root, which is the same on Jira Software
//     Data Center, so the Cloud functions are served as they are. Closing a
//     sprint is not served: it cannot be undone (D109's irreversibility rule).
//
//   * Mention resolution (D112) is the Cloud rule set over the Data Center user
//     search (`resolveMentionNamesDataCenter`), with the username as the
//     target id. The adapter remembers the targets it resolved, and its
//     markdown parse tags the mention nodes built from exactly those targets,
//     so the wiki writer writes them as `[~username]`; any other mention —
//     a caller's raw ADF, a Cloud accountId — stays literal text (CC-286).
//
// Everything else is not served: {@link DATACENTER_TOOLS} is the allowlist the
// registry enforces, and every port member outside it throws `unsupported`
// should anything reach it anyway.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import {
  addVote,
  addWatcherDataCenter,
  createComponent,
  createVersion,
  getProjectRole,
  listComponentsDataCenter,
  listProjectRoles,
  listVersionsDataCenter,
  listWatchers,
  removeVote,
  removeWatcherDataCenter,
  updateComponent,
  updateVersion,
} from './collab.js';
import type {
  JiraError,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
} from '../core/types.js';
import { renderAdfDocs, type AdfNode, type MentionTarget } from './adf.js';
import { listAttachmentsDataCenter } from './attachments.js';
import { getFilterDataCenter, searchFiltersDataCenter } from './filters.js';
import {
  addComment,
  addWorklog,
  assignIssueDataCenter,
  createIssue,
  getIssue,
  linkIssues,
  listChangelogDataCenter,
  listComments,
  listTransitions,
  listWorklogs,
  shapeIssueFields,
  transitionIssue,
  updateComment,
  updateIssue,
} from './issues.js';
import {
  getCreateMetaDataCenter,
  getProject,
  listCreateMetaIssueTypesDataCenter,
  listFields,
  listLinkTypes,
  listProjectsDataCenter,
  listStatusesDataCenter,
} from './meta.js';
import { CLOUD_API } from './port.js';
import type { JiraApi } from './port.js';
import { countIssuesDataCenter, searchIssuesDataCenter } from './search.js';
import {
  getMyselfDataCenter,
  resolveMentionNamesDataCenter,
  searchUsersDataCenter,
} from './users.js';
import { tagDataCenterMentions, wikiFromAdf } from './wiki-writer.js';

/**
 * The writes the Data Center adapter serves: the ones whose route and body
 * shape are the Cloud ones on the v2 root, with wiki markup in place of ADF
 * (D109, stage 13.4b), and the user writes — assignment, watchers and votes —
 * with a username in place of an accountId (D111, stage 13.5b). Every one of
 * them stays behind `JIRA_WRITE_MODE` like on Cloud. Stage 13.6b (D113) adds
 * the reversible project-admin and agile writes: component and version
 * create/update on the v2 root, and sprint create/start plus the two moves on
 * the agile root. Not served: the irreversible deletes, `jira_close_sprint`
 * (it cannot be undone) and the bulk tools — each waits for a Data Center
 * instance to verify it against.
 */
const DATACENTER_WRITE_TOOLS_LIST = [
  'jira_create_issue',
  'jira_update_issue',
  'jira_transition_issue',
  'jira_add_comment',
  'jira_update_comment',
  'jira_add_worklog',
  'jira_link_issues',
  'jira_assign_issue',
  'jira_add_watcher',
  'jira_remove_watcher',
  'jira_add_vote',
  'jira_remove_vote',
  'jira_create_component',
  'jira_update_component',
  'jira_create_version',
  'jira_update_version',
  'jira_create_sprint',
  'jira_start_sprint',
  'jira_move_to_sprint',
  'jira_move_to_backlog',
] as const;

export const DATACENTER_WRITE_TOOLS: ReadonlySet<string> = new Set(
  DATACENTER_WRITE_TOOLS_LIST,
);

/**
 * The tools the Data Center adapter serves: reads whose routes exist on Data
 * Center, each with a verdict in JIRA-API.md §Jira Data Center.
 */
export const DATACENTER_TOOLS: ReadonlySet<string> = new Set([
  'jira_capabilities',
  'jira_get_myself',
  'jira_search',
  'jira_get_issue',
  'jira_get_comments',
  'jira_get_transitions',
  'jira_get_worklogs',
  'jira_list_projects',
  'jira_get_project',
  'jira_list_fields',
  'jira_list_statuses',
  'jira_list_link_types',
  'jira_list_watchers',
  'jira_list_components',
  'jira_list_versions',
  'jira_list_boards',
  'jira_list_sprints',
  'jira_get_sprint_issues',
  'jira_search_users',
  'jira_list_project_roles',
  // D114 (stage 13.6c): the count, the changelog and the attachment list, on
  // the long-standing classic routes.
  'jira_count',
  'jira_get_changelog',
  'jira_list_attachments',
  // D115 (stage 13.7a): the saved filters — the favourites list and one filter.
  'jira_list_filters',
  'jira_get_filter',
  // D116 (stage 13.7b): the create metadata, over the paged 8.4+ routes only.
  'jira_get_create_meta',
  ...DATACENTER_WRITE_TOOLS_LIST,
]);

/**
 * The same request on the Data Center platform root: `v3` (explicit or by
 * default) becomes `v2`; `agile` is unchanged. Nothing else is touched, so the
 * budget, signal and retry flags of the spec travel as they were.
 */
export function onV2(jira: JiraRequestFn): JiraRequestFn {
  return <T = unknown>(req: JiraRequestSpec): Promise<JiraResponse<T>> =>
    jira<T>(req.root === undefined || req.root === 'v3' ? { ...req, root: 'v2' } : req);
}

/**
 * {@link onV2} for a write: every ADF document in the request body — the one a
 * Cloud builder made with `toAdf` out of text, markdown or a caller's raw
 * document — is rendered to wiki markup before the request leaves (D109). The
 * rewrite sits on the request seam, so plan mode captures the Data Center body
 * an apply would send, not the Cloud one (CC-20 stays faithful on DC). A node
 * the renderer cannot express throws `validation` here, before anything is
 * sent.
 */
export function onV2Wiki(jira: JiraRequestFn): JiraRequestFn {
  const v2 = onV2(jira);
  return <T = unknown>(req: JiraRequestSpec): Promise<JiraResponse<T>> =>
    v2<T>(
      req.body === undefined
        ? req
        : { ...req, body: renderAdfDocs(req.body, (doc) => wikiFromAdf(doc as AdfNode)) },
    );
}

/**
 * Data Center identifies users by `name` — an accountId sent to Data Center
 * names nobody. The named user fields are refused; the raw `fields` object
 * stays open for a caller who knows the username, which `jira_search_users`
 * answers on Data Center (D110).
 */
function refuseAccountId(field: string, value: unknown): void {
  if (value === undefined) return;
  throw createJiraError({
    kind: 'validation',
    reason: `${field} is an Atlassian accountId, and Jira Data Center has no accountIds: its users are identified by username.`,
    remediation:
      field === 'reporterAccountId'
        ? 'Drop reporterAccountId, or pass fields: { "reporter": { "name": "<username>" } } (jira_search_users finds the name).'
        : 'Drop assigneeAccountId, or pass fields: { "assignee": { "name": "<username>" } } (null clears it; jira_search_users finds the name), or call jira_assign_issue with username.',
  });
}

/**
 * A component lead is an accountId on Cloud and a `leadUserName` on Data Center
 * (D113). An accountId names nobody there, so it is refused rather than sent;
 * this version of the server takes no lead username, so a Data Center component
 * is created and updated without touching its lead.
 */
function refuseComponentLead(value: string | undefined): void {
  if (value === undefined) return;
  throw createJiraError({
    kind: 'validation',
    reason:
      'leadAccountId is an Atlassian accountId, and Jira Data Center has no accountIds: a component lead there is a username, which this version of the server does not send. Nothing was sent.',
    remediation:
      "Drop leadAccountId (and an assigneeType of COMPONENT_LEAD that relies on it); set the component lead in the project's settings in Jira.",
  });
}

function refuseMarkdown(format: 'text' | 'markdown' | undefined): void {
  if (format === 'markdown') {
    throw createJiraError({
      kind: 'validation',
      reason:
        'format: "markdown" is not available on Jira Data Center: its rich text is wiki markup, and it is returned as Jira sent it.',
      remediation: 'Omit format (or pass "text") to read the wiki markup as text.',
    });
  }
}

function notServed(name: string): JiraError {
  return createJiraError({
    kind: 'unsupported',
    reason: `${name} is not available on Jira Data Center in this version of the server.`,
    remediation:
      'Call jira_capabilities: it lists the tools this server serves on Data Center.',
  });
}

/** A port member the Data Center adapter does not implement. */
function stub(name: string): () => never {
  return () => {
    throw notServed(name);
  };
}

/**
 * D112 — the mention targets this adapter's own resolver produced. Only a
 * target in this set turns a mention node into `[~username]`: a map built any
 * other way (a Cloud resolution, a hand-made map) leaves the nodes untagged,
 * so the wiki writer keeps them literal. Weak, so a finished call's targets
 * are not kept alive.
 */
const resolvedTargets = new WeakSet<MentionTarget>();

async function resolveMentionNames(
  options: Parameters<JiraApi['resolveMentionNames']>[0],
): Promise<ReadonlyMap<string, MentionTarget>> {
  const resolved = await resolveMentionNamesDataCenter(options);
  for (const target of resolved.values()) resolvedTargets.add(target);
  return resolved;
}

/**
 * The Cloud markdown parse, then the tag on every mention built from a target
 * {@link resolveMentionNames} resolved here (D112). A markdown string holds no
 * ADF, so every mention node in the parse came from the map.
 */
const adfFromMarkdown: JiraApi['adfFromMarkdown'] = (text, options) => {
  const mentions = options?.mentions;
  if (mentions === undefined) return CLOUD_API.adfFromMarkdown(text);
  const doc = CLOUD_API.adfFromMarkdown(text, { mentions });
  const usernames = new Set<string>();
  for (const target of mentions.values()) {
    if (resolvedTargets.has(target)) usernames.add(target.id);
  }
  return usernames.size === 0
    ? doc
    : (tagDataCenterMentions(doc, usernames) as ReturnType<JiraApi['adfFromMarkdown']>);
};

const served: Partial<JiraApi> = {
  getMyself: getMyselfDataCenter,
  getIssue: (options) => {
    refuseMarkdown(options.format);
    return getIssue({ ...options, jira: onV2(options.jira), deployment: 'datacenter' });
  },
  listComments: (options) => {
    refuseMarkdown(options.format);
    return listComments({
      ...options,
      jira: onV2(options.jira),
      deployment: 'datacenter',
    });
  },
  listWorklogs: (options) =>
    listWorklogs({ ...options, jira: onV2(options.jira), deployment: 'datacenter' }),
  listTransitions: (options) => listTransitions({ ...options, jira: onV2(options.jira) }),
  listFields: (options) => listFields({ ...options, jira: onV2(options.jira) }),
  listLinkTypes: (options) => listLinkTypes({ ...options, jira: onV2(options.jira) }),
  getProject: (options) =>
    getProject({ ...options, jira: onV2(options.jira), deployment: 'datacenter' }),
  listProjects: listProjectsDataCenter,
  listStatuses: listStatusesDataCenter,
  searchIssues: searchIssuesDataCenter,
  // D114: the twins put their requests on the v2 root themselves.
  approximateCount: countIssuesDataCenter,
  listChangelog: listChangelogDataCenter,
  listAttachments: listAttachmentsDataCenter,
  // D115: the filter twins put their requests on the v2 root themselves.
  searchFilters: searchFiltersDataCenter,
  getFilter: getFilterDataCenter,
  // D116: `values`-paged twins on the v2 root; no legacy createmeta fallback.
  listCreateMetaIssueTypes: listCreateMetaIssueTypesDataCenter,
  getCreateMeta: getCreateMetaDataCenter,
  shapeIssueFields: (value, raw, format) => {
    refuseMarkdown(format);
    return shapeIssueFields(value, raw, format, 'datacenter');
  },
  listWatchers: (options) =>
    listWatchers({ ...options, jira: onV2(options.jira), deployment: 'datacenter' }),
  listComponents: listComponentsDataCenter,
  listVersions: listVersionsDataCenter,
  searchUsers: searchUsersDataCenter,
  listProjectRoles: (options) =>
    listProjectRoles({ ...options, jira: onV2(options.jira) }),
  getProjectRole: (options) =>
    getProjectRole({ ...options, jira: onV2(options.jira), deployment: 'datacenter' }),
  // The markdown parse is the Cloud one: the tool ring turns markdown into an
  // ADF document before the builder runs (D44), and onV2Wiki renders that
  // document to wiki markup on the way out, below the plan seam. With
  // `resolveMentions: true` the tool ring resolves every @[token] first,
  // through the Data Center user search (D112); the resolved mentions are
  // tagged here and written as `[~username]`, so a plan shows them too.
  adfFromMarkdown,
  extractMentions: CLOUD_API.extractMentions,
  resolveMentionNames,
  createIssue: (options) => {
    refuseAccountId('assigneeAccountId', options.assigneeAccountId);
    refuseAccountId('reporterAccountId', options.reporterAccountId);
    return createIssue({ ...options, jira: onV2Wiki(options.jira) });
  },
  updateIssue: (options) => {
    refuseAccountId('assigneeAccountId', options.assigneeAccountId);
    return updateIssue({ ...options, jira: onV2Wiki(options.jira) });
  },
  transitionIssue: (options) =>
    transitionIssue({ ...options, jira: onV2Wiki(options.jira) }),
  addComment: (options) =>
    addComment({ ...options, jira: onV2Wiki(options.jira), deployment: 'datacenter' }),
  updateComment: (options) =>
    updateComment({ ...options, jira: onV2Wiki(options.jira), deployment: 'datacenter' }),
  addWorklog: (options) =>
    addWorklog({ ...options, jira: onV2Wiki(options.jira), deployment: 'datacenter' }),
  linkIssues: (options) => linkIssues({ ...options, jira: onV2Wiki(options.jira) }),
  // D111: the user writes. The twins put the request on the v2 root themselves;
  // a vote has no user and no body, so the Cloud function moves over as is.
  assignIssue: assignIssueDataCenter,
  addWatcher: addWatcherDataCenter,
  removeWatcher: removeWatcherDataCenter,
  addVote: (options) => addVote({ ...options, jira: onV2(options.jira) }),
  removeVote: (options) => removeVote({ ...options, jira: onV2(options.jira) }),
  // D113: the admin writes. Same routes and body fields on the v2 root; the
  // descriptions are plain text on both products, so there is no ADF to render
  // and onV2 is enough. The answer's lead is read in the Data Center dialect.
  createComponent: (options) => {
    refuseComponentLead(options.leadAccountId);
    return createComponent({
      ...options,
      jira: onV2(options.jira),
      deployment: 'datacenter',
    });
  },
  updateComponent: (options) => {
    refuseComponentLead(options.leadAccountId);
    return updateComponent({
      ...options,
      jira: onV2(options.jira),
      deployment: 'datacenter',
    });
  },
  createVersion: (options) => createVersion({ ...options, jira: onV2(options.jira) }),
  updateVersion: (options) => updateVersion({ ...options, jira: onV2(options.jira) }),
  // D113: the agile writes. The agile root is the same on Jira Software Data
  // Center and nothing in these bodies names a user, so the Cloud functions are
  // served as they are. closeSprint stays a stub: it cannot be undone.
  createSprint: CLOUD_API.createSprint,
  startSprint: CLOUD_API.startSprint,
  moveIssuesToSprint: CLOUD_API.moveIssuesToSprint,
  moveIssuesToBacklog: CLOUD_API.moveIssuesToBacklog,
  listBoards: CLOUD_API.listBoards,
  listSprints: CLOUD_API.listSprints,
  listSprintIssues: CLOUD_API.listSprintIssues,
};

function buildDataCenterApi(): JiraApi {
  const members: Record<string, unknown> = {};
  for (const name of Object.keys(CLOUD_API)) {
    if (name === 'deployment' || name === 'serves') continue;
    members[name] = (served as Record<string, unknown>)[name] ?? stub(name);
  }
  return Object.freeze({
    ...(members as unknown as JiraApi),
    deployment: 'datacenter',
    serves: DATACENTER_TOOLS,
  });
}

/** The Jira Data Center adapter. UNVERIFIED — see the header. */
export const DATACENTER_API: JiraApi = buildDataCenterApi();
