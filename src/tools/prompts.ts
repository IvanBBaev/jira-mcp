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
//
// Arguments land inside JQL, so each is pinned down before `render` sees it:
// project keys and ids by pattern, relative dates by pattern, and the one free
// text — a version name — quoted and escaped with {@link jqlString}.
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
