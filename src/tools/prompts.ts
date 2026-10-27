// ---------------------------------------------------------------------------
// The prompts the tools ring contributes (TOOLS.md §Prompts, D125).
//
// Each is a fixed sequence over read tools — the workflows a team runs every
// week against Jira, written down once so a model does not reinvent the JQL.
// `mcp/prompts.ts` owns the mechanics: validation, gating on `requires`, the
// read-only rule appended to every message. This module owns only the texts,
// declared on the package of the tool each workflow is built around:
//
//   - jira_sprint_review     (agile)   list_boards → list_sprints → get_sprint_issues
//   - jira_standup           (search)  jira_search over a recent window
//   - jira_triage_unassigned (search)  jira_search + jira_search_users
//   - jira_release_notes     (collab)  list_versions → jira_search by fixVersion
//   - jira_issue_brief       (issues)  get_issue → comments → changelog → remote links
//   - jira_worklog_summary   (issues)  jira_search by worklogDate → get_worklogs
//   - jira_epic_progress     (search)  get_issue → jira_count per category → jira_search
//   - jira_my_work           (search)  jira_search on currentUser()
//   - jira_blocked_report    (search)  jira_search by link type → get_issue for blockers
//   - jira_bulk_preflight    (search)  jira_count → sample → get_my_permissions (D153)
//
// Arguments land inside JQL, so each is pinned down before `render` sees it:
// project keys and ids by pattern, relative dates by pattern, and the one free
// text — a version name — quoted and escaped with {@link jqlString}. The JQL
// of `jira_bulk_preflight` is the caller's own query, passed through whole.
// ---------------------------------------------------------------------------

import { definePrompt } from '../mcp/prompts.js';
import type { PromptArgumentSpec, PromptSpec } from '../mcp/types.js';

/** A Jira project key: a letter, then letters, digits or underscores. */
const PROJECT_KEY_PATTERN = /[A-Z][A-Z0-9_]{1,49}/;

/** A positive numeric id, as the Agile API issues for sprints. */
const SPRINT_ID_PATTERN = /[1-9][0-9]{0,17}/;

/** A JQL relative date going back from now: -1d, -36h, -2w, -90m. */
const RELATIVE_DATE_PATTERN = /-[1-9][0-9]{0,3}[mhdw]/;

/** The look-back window `jira_standup` uses when the caller gives none. */
export const STANDUP_DEFAULT_SINCE = '-1d';

/**
 * A JQL string literal: double-quoted, with `\` and `"` escaped. The only safe
 * way to put free text — a version name with spaces or quotes — into JQL.
 */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const PROJECT_ARG: PromptArgumentSpec = {
  name: 'project',
  description: 'Project key in capitals, e.g. PROJ.',
  required: true,
  pattern: PROJECT_KEY_PATTERN,
  maxLength: 50,
};

/** `render` only ever sees validated arguments; a required one is present. */
function arg(args: Readonly<Record<string, string>>, name: string): string {
  return args[name] ?? '';
}

function lines(...parts: readonly string[]): string {
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// agile
// ---------------------------------------------------------------------------

const SPRINT_FIELDS =
  '["summary", "status", "assignee", "issuetype", "priority", "resolution"]';

export const sprintReviewPrompt: PromptSpec = definePrompt({
  name: 'jira_sprint_review',
  title: 'Sprint review',
  description:
    "Review a project's sprint — the active one unless a sprint id is given: what " +
    'got done, what did not, by whom, and what is blocked or unowned.',
  requires: ['jira_list_boards', 'jira_list_sprints', 'jira_get_sprint_issues'],
  arguments: [
    PROJECT_ARG,
    {
      name: 'sprint',
      description: 'Numeric sprint id. Omit for the active sprint.',
      required: false,
      pattern: SPRINT_ID_PATTERN,
      maxLength: 18,
    },
  ],
  example: { project: 'PROJ' },
  render(args) {
    const project = arg(args, 'project');
    const sprint = args['sprint'];
    const steps =
      sprint === undefined
        ? [
            `Call jira_list_boards with projectKeyOrId "${project}" and pick the ` +
              'scrum board of the project (ask the user if there are several).',
            'Call jira_list_sprints with that boardId and state "active". If no ' +
              'sprint is active, call it again with state "closed" and take the one ' +
              'that ended last. Note its id, name, goal and dates.',
          ]
        : [
            `The sprint is ${sprint}. Only the board knows its name, goal and dates: ` +
              `call jira_list_boards with projectKeyOrId "${project}", then ` +
              `jira_list_sprints with that boardId, and find id ${sprint} there.`,
          ];
    steps.push(
      `Call jira_get_sprint_issues with the sprintId, jql "project = ${project}" ` +
        `and fields ${SPRINT_FIELDS}. Page with startAt until every issue is in.`,
      'Report: the sprint name, goal and dates; how many issues are done, in ' +
        'progress and not started (by status category); what is not done, grouped ' +
        'by assignee; issues with no assignee; issues of the highest priorities that ' +
        'are not done. Close with two or three observations a team would discuss.',
    );
    return lines(
      `Review a sprint of Jira project ${project}.`,
      '',
      ...steps.map((step, index) => `${String(index + 1)}. ${step}`),
    );
  },
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const DIGEST_FIELDS =
  '["summary", "status", "assignee", "issuetype", "priority", "updated", "created"]';

export const standupPrompt: PromptSpec = definePrompt({
  name: 'jira_standup',
  title: 'Stand-up digest',
  description:
    'A stand-up digest for one project: per assignee, what was finished, what moved ' +
    'and what is new since a window, plus work in progress that has gone quiet.',
  requires: ['jira_search'],
  arguments: [
    PROJECT_ARG,
    {
      name: 'since',
      description: `JQL relative date to look back to: -1d, -3d, -12h, -1w. Default ${STANDUP_DEFAULT_SINCE}.`,
      required: false,
      pattern: RELATIVE_DATE_PATTERN,
      maxLength: 6,
    },
  ],
  example: { project: 'PROJ' },
  render(args) {
    const project = arg(args, 'project');
    const since = args['since'] ?? STANDUP_DEFAULT_SINCE;
    return lines(
      `Prepare a stand-up digest for Jira project ${project}, covering ${since} until now.`,
      '',
      `1. Call jira_search with jql "project = ${project} AND updated >= ${since} ` +
        `ORDER BY assignee ASC, updated DESC" and fields ${DIGEST_FIELDS}. Follow ` +
        'nextPageToken until there is none, or stop at 200 issues and say that you did.',
      `2. Call jira_search with jql "project = ${project} AND statusCategory = ` +
        `'In Progress' AND updated < ${since} ORDER BY updated ASC" and the same ` +
        'fields: work in progress that nobody touched in the window.',
      '3. Report per assignee, unassigned last: finished in the window (status ' +
        'category Done), moved but not finished, and created in the window. Then ' +
        'list the quiet in-progress issues from step 2 as possible blockers, oldest ' +
        'first. Keep it short enough to read aloud.',
    );
  },
});

const TRIAGE_FIELDS =
  '["summary", "issuetype", "priority", "created", "components", "labels", "reporter"]';

export const triageUnassignedPrompt: PromptSpec = definePrompt({
  name: 'jira_triage_unassigned',
  title: 'Triage unassigned issues',
  description:
    'Triage the unresolved issues of a project that nobody owns: rank them and ' +
    'propose an assignee for each from who can be assigned — proposals only.',
  requires: ['jira_search', 'jira_search_users'],
  arguments: [PROJECT_ARG],
  example: { project: 'PROJ' },
  render(args) {
    const project = arg(args, 'project');
    return lines(
      `Triage the unassigned, unresolved issues of Jira project ${project}.`,
      '',
      `1. Call jira_search with jql "project = ${project} AND assignee IS EMPTY AND ` +
        'resolution = Unresolved ORDER BY priority DESC, created ASC", fields ' +
        `${TRIAGE_FIELDS} and maxResults 50. If a nextPageToken comes back, say how ` +
        'many you looked at and that there are more.',
      '2. For each component among them, call jira_search with jql "project = ' +
        `${project} AND component = <the component, quoted> AND resolved >= -90d" and ` +
        'fields ["assignee"]: who has recently finished work there.',
      '3. For the ten most urgent issues, call jira_search_users with issue set to the ' +
        'issue key and no query: who can be assigned that issue at all.',
      '4. Report a table: key, summary, priority, age in days, proposed assignee and ' +
        'a one-line reason. Propose only people step 3 returned for that issue; ' +
        'when step 2 gave no signal, say the proposal is a guess. The user decides.',
    );
  },
});

// ---------------------------------------------------------------------------
// collab
// ---------------------------------------------------------------------------

const RELEASE_FIELDS =
  '["summary", "issuetype", "status", "resolution", "priority", "components"]';

export const releaseNotesPrompt: PromptSpec = definePrompt({
  name: 'jira_release_notes',
  title: 'Release notes',
  description:
    'Draft release notes for one version of a project from the issues filed under ' +
    'it, grouped by issue type, with anything still open listed apart.',
  requires: ['jira_list_versions', 'jira_search'],
  arguments: [
    PROJECT_ARG,
    {
      name: 'version',
      description: 'The version name exactly as Jira shows it, e.g. 2.4.0.',
      required: true,
      maxLength: 200,
    },
  ],
  example: { project: 'PROJ', version: '2.4.0' },
  render(args) {
    const project = arg(args, 'project');
    const version = arg(args, 'version');
    return lines(
      `Draft release notes for version ${JSON.stringify(version)} of Jira project ${project}.`,
      '',
      `1. Call jira_list_versions with project "${project}" and query ` +
        `${JSON.stringify(version)}. Find the version whose name matches exactly and ` +
        'note its release date and whether it is released. If none matches exactly, ' +
        'stop and show the user the closest names.',
      `2. Call jira_search with jql ${JSON.stringify(
        `project = ${project} AND fixVersion = ${jqlString(version)} ORDER BY issuetype ASC, key ASC`,
      )} and fields ${RELEASE_FIELDS}. Follow nextPageToken until there is none.`,
      '3. Write the notes: a heading with the version and its date, then sections ' +
        'for new features, improvements and bug fixes (by issue type), one line per ' +
        'issue — key and summary, rewritten for a reader outside the team only where ' +
        'the summary is unclear. List issues that are not in status category Done ' +
        'separately, as open items the release still carries.',
    );
  },
});

// ---------------------------------------------------------------------------
// The second set (D153): one issue, one epic, my own work, blockers, time
// logged, and the look before a bulk change.
// ---------------------------------------------------------------------------

/** An issue key: a project key, a dash, a positive number. */
const ISSUE_KEY_PATTERN = /[A-Z][A-Z0-9_]{1,49}-[1-9][0-9]{0,17}/;

/** The look-back window `jira_worklog_summary` uses when the caller gives none. */
export const WORKLOG_DEFAULT_SINCE = '-1w';

/** What `jira_bulk_preflight` can be asked to prepare for — also its completions (D154). */
const BULK_ACTIONS = ['edit', 'transition', 'delete'] as const;
const BULK_ACTION_PATTERN = new RegExp(BULK_ACTIONS.join('|'));

/** The permission each bulk action needs on every matching issue. */
const BULK_PERMISSION: Readonly<Record<string, string>> = {
  edit: 'EDIT_ISSUES',
  transition: 'TRANSITION_ISSUES',
  delete: 'DELETE_ISSUES',
};

/** How many matching issues `jira_bulk_preflight` samples. */
export const BULK_PREFLIGHT_SAMPLE = 20;

const ISSUE_ARG: PromptArgumentSpec = {
  name: 'issue',
  description: 'Issue key in capitals, e.g. PROJ-123.',
  required: true,
  pattern: ISSUE_KEY_PATTERN,
  maxLength: 70,
};

function numbered(steps: readonly string[]): string[] {
  return steps.map((step, index) => `${String(index + 1)}. ${step}`);
}

// issues -------------------------------------------------------------------

export const issueBriefPrompt: PromptSpec = definePrompt({
  name: 'jira_issue_brief',
  title: 'Issue brief',
  description:
    'Brief one issue for someone picking it up: what it asks, where it stands, ' +
    'what was decided in the comments, what changed lately and what it links to.',
  requires: [
    'jira_get_issue',
    'jira_get_comments',
    'jira_get_changelog',
    'jira_get_remote_links',
  ],
  arguments: [ISSUE_ARG],
  example: { issue: 'PROJ-123' },
  render(args) {
    const issue = arg(args, 'issue');
    return lines(
      `Brief Jira issue ${issue} for someone who has to pick it up today.`,
      '',
      ...numbered([
        `Call jira_get_issue with issue "${issue}" and format "text": summary, ` +
          'description, status, assignee, reporter, priority, parent, links and dates.',
        `Call jira_get_comments with issue "${issue}", orderBy "-created" and format ` +
          '"text". Read the newest 50; say so when there are more.',
        `Call jira_get_changelog with issue "${issue}" and page to the last page: ` +
          'the latest status, assignee and priority changes, and when they happened.',
        `Call jira_get_remote_links with issue "${issue}": pull requests, documents ` +
          'and pages linked from outside Jira.',
        'Write the brief: one paragraph on what the issue asks; where it stands and ' +
          'since when; decisions and open questions from the comments, with who said ' +
          'them; linked and blocking issues; external links. End with the next step ' +
          'the issue seems to wait for.',
      ]),
    );
  },
});

export const worklogSummaryPrompt: PromptSpec = definePrompt({
  name: 'jira_worklog_summary',
  title: 'Worklog summary',
  description:
    'Sum the time logged on a project over a window, per person and per issue, ' +
    'from the worklogs themselves rather than the issue totals.',
  requires: ['jira_search', 'jira_get_worklogs'],
  arguments: [
    PROJECT_ARG,
    {
      name: 'since',
      description: `JQL relative date to look back to: -1w, -2w, -30d. Default ${WORKLOG_DEFAULT_SINCE}.`,
      required: false,
      pattern: RELATIVE_DATE_PATTERN,
      maxLength: 6,
    },
  ],
  example: { project: 'PROJ' },
  render(args) {
    const project = arg(args, 'project');
    const since = args['since'] ?? WORKLOG_DEFAULT_SINCE;
    return lines(
      `Summarise the time logged on Jira project ${project} from ${since} until now.`,
      '',
      ...numbered([
        `Call jira_search with jql "project = ${project} AND worklogDate >= ${since} ` +
          'ORDER BY key ASC" and fields ["summary", "issuetype", "assignee"]. Follow ' +
          'nextPageToken until there is none, or stop at 100 issues and say that you did.',
        'For each issue, call jira_get_worklogs with that issue and page until every ' +
          `worklog is in. Keep only worklogs whose started date is within ${since} of ` +
          'now; an issue also carries older ones.',
        'Report: hours per person, highest first; then per issue — key, summary, ' +
          'hours and who logged them. Give the total, and name the issues whose ' +
          'worklogs could not all be read.',
      ]),
    );
  },
});

// search -------------------------------------------------------------------

const PROGRESS_FIELDS =
  '["summary", "status", "assignee", "issuetype", "priority", "updated"]';

export const epicProgressPrompt: PromptSpec = definePrompt({
  name: 'jira_epic_progress',
  title: 'Epic progress',
  description:
    'Report how far an epic is: its children by status category, what is left and ' +
    'who holds it, and children that have not moved in two weeks.',
  requires: ['jira_get_issue', 'jira_count', 'jira_search'],
  arguments: [
    { ...ISSUE_ARG, name: 'epic', description: 'Epic key in capitals, e.g. PROJ-42.' },
  ],
  example: { epic: 'PROJ-42' },
  render(args) {
    const epic = arg(args, 'epic');
    return lines(
      `Report the progress of Jira epic ${epic}.`,
      '',
      ...numbered([
        `Call jira_get_issue with issue "${epic}" and fields ["summary", "status", ` +
          '"duedate", "assignee", "issuetype"]. If it is not an epic, say so and stop.',
        `Call jira_count three times, with jql "parent = ${epic} AND statusCategory ` +
          `= Done", "parent = ${epic} AND statusCategory = 'In Progress'" and ` +
          `"parent = ${epic} AND statusCategory = 'To Do'".`,
        `Call jira_search with jql "parent = ${epic} AND statusCategory != Done ` +
          `ORDER BY priority DESC, updated ASC" and fields ${PROGRESS_FIELDS}. Follow ` +
          'nextPageToken until there is none.',
        'Report: the epic, its status and due date; done / in progress / to do as ' +
          'counts and a percentage of the whole; what is left grouped by assignee, ' +
          'unassigned last; and the open children not updated in 14 days. Close with ' +
          'whether the due date looks reachable, and why.',
      ]),
    );
  },
});

const MY_WORK_FIELDS =
  '["summary", "status", "priority", "duedate", "updated", "project"]';

export const myWorkPrompt: PromptSpec = definePrompt({
  name: 'jira_my_work',
  title: 'My work',
  description:
    "The calling user's open work, ordered for today: overdue and due soon first, " +
    'then in progress, then the rest — optionally within one project.',
  requires: ['jira_search'],
  arguments: [
    {
      ...PROJECT_ARG,
      required: false,
      description: 'Project key in capitals, e.g. PROJ. Omit for every project.',
    },
  ],
  example: {},
  render(args) {
    const project = args['project'];
    const scope = project === undefined ? '' : `project = ${project} AND `;
    return lines(
      project === undefined
        ? 'List my open Jira work and order it for today.'
        : `List my open work in Jira project ${project} and order it for today.`,
      '',
      ...numbered([
        `Call jira_search with jql "${scope}assignee = currentUser() AND resolution ` +
          `= Unresolved ORDER BY duedate ASC, priority DESC" and fields ${MY_WORK_FIELDS}. ` +
          'Follow nextPageToken until there is none, or stop at 100 issues and say that you did.',
        `Call jira_search with jql "${scope}reporter = currentUser() AND resolution ` +
          '= Unresolved AND assignee IS EMPTY ORDER BY created DESC" and the same ' +
          'fields: what I reported that nobody has taken.',
        'Report in this order: overdue; due within seven days; in progress; the ' +
          'rest by priority; then my unowned reports. One line each — key, summary, ' +
          'status, due date. Keep it to one screen.',
      ]),
    );
  },
});

const BLOCKED_FIELDS =
  '["summary", "status", "assignee", "priority", "issuelinks", "updated"]';

export const blockedReportPrompt: PromptSpec = definePrompt({
  name: 'jira_blocked_report',
  title: 'Blocked report',
  description:
    'List the unresolved issues of a project that are blocked by another issue, ' +
    'with what blocks each, whether the blocker is still open and who owns it.',
  requires: ['jira_search', 'jira_get_issue'],
  arguments: [PROJECT_ARG],
  example: { project: 'PROJ' },
  render(args) {
    const project = arg(args, 'project');
    return lines(
      `Report what is blocked in Jira project ${project}.`,
      '',
      ...numbered([
        `Call jira_search with jql "project = ${project} AND resolution = ` +
          "Unresolved AND issueLinkType = 'is blocked by' ORDER BY priority DESC\" and " +
          `fields ${BLOCKED_FIELDS}. Follow nextPageToken until there is none, or stop ` +
          'at 100 issues and say that you did. If the site has no such link type, the ' +
          'search fails: say so and stop.',
        'From each issue\'s issuelinks, take the inward "is blocked by" links. Where ' +
          "a link does not carry the blocker's status or assignee, call jira_get_issue " +
          'with the blockers\' keys in issues and fields ["summary", "status", "assignee"].',
        'Report a table: blocked issue, its priority and assignee, the blocker, the ' +
          "blocker's status and assignee. Put first the issues whose blockers are all " +
          'done — they may only need unblocking — and flag blockers in other projects.',
      ]),
    );
  },
});

export const bulkPreflightPrompt: PromptSpec = definePrompt({
  name: 'jira_bulk_preflight',
  title: 'Bulk change preflight',
  description:
    'Before a bulk edit, transition or delete: how many issues a JQL matches, a ' +
    'sample of them, and whether you hold the permission the change needs.',
  requires: ['jira_count', 'jira_search', 'jira_get_my_permissions'],
  arguments: [
    {
      name: 'jql',
      description: 'The JQL that selects the issues the bulk change would touch.',
      required: true,
      maxLength: 200,
    },
    {
      name: 'action',
      description: 'What the change would do: edit, transition or delete. Default edit.',
      required: false,
      pattern: BULK_ACTION_PATTERN,
      values: BULK_ACTIONS,
      maxLength: 10,
    },
  ],
  example: { jql: 'project = PROJ AND labels = cleanup' },
  render(args) {
    const jql = arg(args, 'jql');
    const action = args['action'] ?? 'edit';
    const permission = BULK_PERMISSION[action] ?? 'EDIT_ISSUES';
    return lines(
      `Prepare a bulk ${action} of the Jira issues matching ${JSON.stringify(jql)}. ` +
        'Do not make the change: report what it would touch.',
      '',
      ...numbered([
        `Call jira_count with jql ${JSON.stringify(jql)}. If it is 0, say so and stop.`,
        `Call jira_search with the same jql, fields ["summary", "status", ` +
          `"assignee", "project", "issuetype"] and maxResults ${String(BULK_PREFLIGHT_SAMPLE)}: ` +
          'a sample, not the whole set.',
        'For each project in the sample, call jira_get_my_permissions with ' +
          `permissions ["${permission}", "BULK_CHANGE"] and that project.`,
        'Report: the match count; the projects, issue types and statuses the sample ' +
          'spans; any sample issue that looks out of place for the query; and per ' +
          `project whether ${permission} and BULK_CHANGE are held. Warn when the ` +
          'count is large or spans several projects, and suggest a narrower JQL if ' +
          `one is obvious.${action === 'delete' ? ' A delete cannot be undone — say so plainly.' : ''}`,
      ]),
    );
  },
});
