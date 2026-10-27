// The prompts the tools ring ships (TOOLS.md §Prompts, D125): each stays read
// only, each names exactly the tools it is gated on whatever its arguments, and
// every argument that lands in JQL is pinned down or quoted.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { PROMPT_RULES, createPromptCatalogue, toolTokens } from '../mcp/prompts.js';
import type { AnyToolSpec, PromptSpec } from '../mcp/types.js';
import { PACKAGES } from './index.js';
import {
  BULK_PREFLIGHT_SAMPLE,
  STANDUP_DEFAULT_SINCE,
  WORKLOG_DEFAULT_SINCE,
  blockedReportPrompt,
  bulkPreflightPrompt,
  epicProgressPrompt,
  issueBriefPrompt,
  jqlString,
  myWorkPrompt,
  releaseNotesPrompt,
  sprintReviewPrompt,
  standupPrompt,
  triageUnassignedPrompt,
  worklogSummaryPrompt,
} from './prompts.js';

const TOOLS = new Map<string, AnyToolSpec>(
  PACKAGES.flatMap((pkg) => pkg.tools.map((tool) => [tool.name, tool])),
);
const PROMPTS: readonly PromptSpec[] = PACKAGES.flatMap((pkg) => pkg.prompts ?? []);

const catalogue = createPromptCatalogue({
  manifest: PACKAGES,
  registeredTools: new Set(TOOLS.keys()),
  excludedTools: new Map(),
});

function text(name: string, args: Record<string, string>): string {
  const [message] = catalogue.get(name, args).messages;
  assert.ok(message !== undefined && message.content.type === 'text');
  return message.content.text;
}

function refused(name: string, args: Record<string, string>, pattern: RegExp): void {
  assert.throws(
    () => catalogue.get(name, args),
    (error: unknown) => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, ErrorCode.InvalidParams);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test('the manifest ships the ten prompts, each on the package of its anchor tool', () => {
  const where = Object.fromEntries(
    PACKAGES.flatMap((pkg) => (pkg.prompts ?? []).map((prompt) => [prompt.name, pkg.id])),
  );
  assert.deepEqual(where, {
    jira_sprint_review: 'agile',
    jira_standup: 'search',
    jira_triage_unassigned: 'search',
    jira_release_notes: 'collab',
    jira_issue_brief: 'issues',
    jira_worklog_summary: 'issues',
    jira_epic_progress: 'search',
    jira_my_work: 'search',
    jira_blocked_report: 'search',
    jira_bulk_preflight: 'search',
  });
  assert.deepEqual(
    [...PROMPTS].sort((a, b) => a.name.localeCompare(b.name)),
    [
      blockedReportPrompt,
      bulkPreflightPrompt,
      epicProgressPrompt,
      issueBriefPrompt,
      myWorkPrompt,
      releaseNotesPrompt,
      sprintReviewPrompt,
      standupPrompt,
      triageUnassignedPrompt,
      worklogSummaryPrompt,
    ],
  );
});

test('[CC-1430] every prompt requires only manifest tools, and only read-only ones', () => {
  for (const prompt of PROMPTS) {
    assert.ok(!TOOLS.has(prompt.name), `${prompt.name} is not also a tool`);
    for (const name of prompt.requires) {
      const tool = TOOLS.get(name);
      assert.ok(tool, `${prompt.name} requires ${name}, which the manifest lacks`);
      assert.equal(
        tool.annotations.readOnlyHint,
        true,
        `${prompt.name} requires ${name}, which writes`,
      );
    }
  }
});

test('every argument combination names only the tools a prompt is gated on', () => {
  const variants: readonly [string, Record<string, string>][] = [
    ['jira_sprint_review', { project: 'PROJ' }],
    ['jira_sprint_review', { project: 'PROJ', sprint: '42' }],
    ['jira_standup', { project: 'PROJ' }],
    ['jira_standup', { project: 'PROJ', since: '-3d' }],
    ['jira_triage_unassigned', { project: 'PROJ' }],
    ['jira_release_notes', { project: 'PROJ', version: '2.4.0' }],
    ['jira_issue_brief', { issue: 'PROJ-7' }],
    ['jira_worklog_summary', { project: 'PROJ' }],
    ['jira_worklog_summary', { project: 'PROJ', since: '-30d' }],
    ['jira_epic_progress', { epic: 'PROJ-42' }],
    ['jira_my_work', { project: 'PROJ' }],
    ['jira_blocked_report', { project: 'PROJ' }],
    ['jira_bulk_preflight', { jql: 'project = PROJ' }],
    ['jira_bulk_preflight', { jql: 'project = PROJ', action: 'delete' }],
  ];
  for (const [name, args] of variants) {
    const prompt = PROMPTS.find((p) => p.name === name);
    assert.ok(prompt);
    const rendered = text(name, args);
    assert.ok(rendered.endsWith(PROMPT_RULES));
    for (const tool of toolTokens(rendered)) {
      assert.ok(prompt.requires.includes(tool), `${name} names ${tool}`);
    }
    assert.ok(rendered.includes('PROJ'));
  }
});

test('the sprint review finds the active sprint, or uses the one it is given', () => {
  const active = text('jira_sprint_review', { project: 'PROJ' });
  assert.match(active, /jira_list_boards with projectKeyOrId "PROJ"/);
  assert.match(active, /state "active"/);
  assert.match(active, /jira_get_sprint_issues with the sprintId, jql "project = PROJ"/);

  const given = text('jira_sprint_review', { project: 'PROJ', sprint: '42' });
  assert.match(given, /^1\. The sprint is 42\./m);
  assert.match(given, /^2\. Call jira_get_sprint_issues/m);
  refused('jira_sprint_review', { project: 'PROJ', sprint: 'active' }, /"sprint"/);
  refused('jira_sprint_review', { project: 'PROJ', sprint: '0' }, /"sprint"/);
});

test('the stand-up looks back one day unless told otherwise', () => {
  assert.equal(STANDUP_DEFAULT_SINCE, '-1d');
  assert.match(text('jira_standup', { project: 'PROJ' }), /updated >= -1d ORDER BY/);
  const week = text('jira_standup', { project: 'PROJ', since: '-1w' });
  assert.match(week, /updated >= -1w ORDER BY/);
  assert.match(week, /statusCategory = 'In Progress' AND updated < -1w/);
  for (const since of ['1d', '-1y', '-0d', '-1d OR 1=1', 'startOfDay()']) {
    refused('jira_standup', { project: 'PROJ', since }, /"since"/);
  }
});

test('the triage proposes from assignable users and never assigns', () => {
  const triage = text('jira_triage_unassigned', { project: 'PROJ' });
  assert.match(triage, /assignee IS EMPTY AND resolution = Unresolved/);
  assert.match(triage, /jira_search_users with issue set to the issue key/);
  assert.match(triage, /The user decides\./);
});

test('[CC-1429] a version name lands in JQL as one quoted, escaped string literal', () => {
  assert.equal(jqlString('2.4.0'), '"2.4.0"');
  assert.equal(jqlString('v2 "beta" \\ x'), '"v2 \\"beta\\" \\\\ x"');

  const version = 'Q4 "big" release\\2';
  const notes = text('jira_release_notes', { project: 'PROJ', version });
  const jql = `project = PROJ AND fixVersion = ${jqlString(version)} ORDER BY issuetype ASC, key ASC`;
  assert.ok(notes.includes(`jql ${JSON.stringify(jql)}`), notes);
  assert.ok(notes.includes(`query ${JSON.stringify(version)}`));
  refused('jira_release_notes', { project: 'PROJ' }, /needs the argument "version"/);
  refused('jira_release_notes', { project: 'PROJ', version: 'a\u0000b' }, /control/);
});

test('a project argument must be a project key', () => {
  const withProject = PROMPTS.filter((prompt) =>
    prompt.arguments.some((argument) => argument.name === 'project'),
  ).map((prompt) => prompt.name);
  assert.equal(withProject.length, 7);
  for (const name of withProject) {
    for (const project of ['proj', 'P', '1PROJ', 'PROJ OR project = X', 'PR"OJ']) {
      const extra: Record<string, string> =
        name === 'jira_release_notes' ? { version: '1' } : {};
      refused(name, { project, ...extra }, /"project"/);
    }
  }
});

test('[CC-1566] an issue or epic argument must be an issue key', () => {
  for (const [name, key] of [
    ['jira_issue_brief', 'issue'],
    ['jira_epic_progress', 'epic'],
  ] as const) {
    for (const value of ['PROJ', 'proj-1', 'PROJ-0', 'PROJ-1 OR key = X', 'PROJ-1"']) {
      refused(name, { [key]: value }, new RegExp(`"${key}"`));
    }
  }
  const brief = text('jira_issue_brief', { issue: 'PROJ-7' });
  for (const tool of issueBriefPrompt.requires) {
    assert.ok(brief.includes(`${tool} with issue "PROJ-7"`), tool);
  }
  assert.match(text('jira_epic_progress', { epic: 'PROJ-42' }), /parent = PROJ-42 AND/);
});

test('[CC-1567] the bulk preflight passes the JQL through whole and only counts and samples', () => {
  const jql = 'project = PROJ AND summary ~ "a \\"b\\"" ORDER BY key';
  const rendered = text('jira_bulk_preflight', { jql });
  assert.ok(rendered.includes(`jira_count with jql ${JSON.stringify(jql)}.`));
  assert.ok(rendered.includes(`maxResults ${String(BULK_PREFLIGHT_SAMPLE)}`));
  assert.match(rendered, /\["EDIT_ISSUES", "BULK_CHANGE"\]/);
  assert.match(rendered, /Do not make the change/);
  assert.doesNotMatch(rendered, /cannot be undone/);

  const deleting = text('jira_bulk_preflight', { jql, action: 'delete' });
  assert.match(deleting, /\["DELETE_ISSUES", "BULK_CHANGE"\]/);
  assert.match(deleting, /cannot be undone/);
  assert.match(
    text('jira_bulk_preflight', { jql, action: 'transition' }),
    /\["TRANSITION_ISSUES", "BULK_CHANGE"\]/,
  );
  for (const action of ['assign', 'EDIT', 'edit,delete']) {
    refused('jira_bulk_preflight', { jql, action }, /"action"/);
  }
  refused('jira_bulk_preflight', { jql: 'x'.repeat(201) }, /"jql"/);
});

test('[CC-1568] windows and scopes default as documented', () => {
  assert.equal(WORKLOG_DEFAULT_SINCE, '-1w');
  assert.match(
    text('jira_worklog_summary', { project: 'PROJ' }),
    /project = PROJ AND worklogDate >= -1w /,
  );
  assert.match(
    text('jira_worklog_summary', { project: 'PROJ', since: '-30d' }),
    /worklogDate >= -30d /,
  );
  const everywhere = text('jira_my_work', {});
  assert.match(everywhere, /jql "assignee = currentUser\(\)/);
  assert.doesNotMatch(everywhere, /project = /);
  assert.match(
    text('jira_my_work', { project: 'PROJ' }),
    /jql "project = PROJ AND assignee = currentUser\(\)/,
  );
  assert.match(
    text('jira_blocked_report', { project: 'PROJ' }),
    /issueLinkType = 'is blocked by'/,
  );
});

test('TOOLS.md documents every prompt', () => {
  const doc = readFileSync(new URL('../../docs/TOOLS.md', import.meta.url), 'utf8');
  assert.match(doc, /^## Prompts$/m);
  for (const prompt of PROMPTS) {
    assert.ok(doc.includes(`\`${prompt.name}\``), `TOOLS.md names ${prompt.name}`);
  }
});
