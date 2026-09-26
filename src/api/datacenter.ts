// ---------------------------------------------------------------------------
// api/datacenter.ts — the Jira Data Center adapter, read stage (Phase 13,
// stage 13.3, D106).
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
//   * Rich text is wiki markup, not ADF. It passes through as the string Jira
//     sent; `format: "markdown"` is refused, because the text is not markdown
//     and labelling it so would be a lie the model would repeat.
//   * `/search/jql`, `/project/search` and `/statuses/search` are Cloud-only;
//     their Data Center twins live next to the Cloud functions
//     (`searchIssuesDataCenter`, `listProjectsDataCenter`,
//     `listStatusesDataCenter`), where the private mappers are.
//
// Everything else is not served: {@link DATACENTER_TOOLS} is the allowlist the
// registry enforces, and every port member outside it throws `unsupported`
// should anything reach it anyway.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import type {
  JiraError,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
} from '../core/types.js';
import {
  getIssue,
  listComments,
  listTransitions,
  listWorklogs,
  shapeIssueFields,
} from './issues.js';
import {
  getProject,
  listFields,
  listLinkTypes,
  listProjectsDataCenter,
  listStatusesDataCenter,
} from './meta.js';
import { CLOUD_API } from './port.js';
import type { JiraApi } from './port.js';
import { searchIssuesDataCenter } from './search.js';
import { getMyselfDataCenter } from './users.js';

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
  'jira_list_boards',
  'jira_list_sprints',
  'jira_get_sprint_issues',
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
  shapeIssueFields: (value, raw, format) => {
    refuseMarkdown(format);
    return shapeIssueFields(value, raw, format, 'datacenter');
  },
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

/** The Jira Data Center adapter (read stage). UNVERIFIED — see the header. */
export const DATACENTER_API: JiraApi = buildDataCenterApi();
