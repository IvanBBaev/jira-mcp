// ---------------------------------------------------------------------------
// Description hygiene over the real tool surface (V3-36).
//
// A tool's description and its argument descriptions are what a model reads to
// pick a tool and fill its input; the manifest snapshot strips that prose, so
// nothing else checks it. Two rules hold here:
//
//  - no internal tracker id (CC-31, D124, V3-07, a review item) reaches the
//    model: it cannot resolve one, and may go looking for a "CC-31" issue;
//  - every description is keyword-first: it opens with an imperative verb and
//    names the tool's Jira noun within the first 80 characters, which is where
//    a model scanning the list, or a client's tool search, looks first. D509
//    holds the upfront reads to the same window.
//
// It lives in the tools ring, not in mcp/, because only a composition root may
// see both the manifest and the server's `toMcpTool` (eslint layer zones).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { toMcpTool } from '../mcp/server.js';

import { PACKAGES } from './index.js';

/** How much of the description has to carry the verb and the noun. */
const KEYWORD_WINDOW = 80;

/** The internal tracker prefixes: corner cases, decisions, work packages, review items. */
const TRACKER_ID =
  /\b(?:(?:CC|D|V\d|WP|O|MCP|ARC|TSN|SEC|QA|JIR|PRD|DOC|OPS)-R?\d+|D\d{2,})\b/;

/** The imperative verbs a description may open with. */
const OPENING_VERBS: ReadonlySet<string> = new Set([
  'Add',
  'Analyze',
  'Apply',
  'Attach',
  'Cast',
  'Change',
  'Check',
  'Complete',
  'Count',
  'Create',
  'Delete',
  'Describe',
  'Download',
  'Edit',
  'Find',
  'Get',
  'Link',
  'List',
  'Log',
  'Make',
  'Move',
  'Poll',
  'Rank',
  'Read',
  'Remove',
  'Save',
  'Search',
  'Send',
  'Set',
  'Start',
  'Stop',
  'Summarise',
  'Update',
  'Upload',
  'Verify',
  'Withdraw',
  'Write',
]);

/** Adverbs allowed ahead of the verb ("Permanently delete …"). */
const LEADING_ADVERBS: ReadonlySet<string> = new Set(['Permanently']);

/** Name tokens that are the verb of `jira_<verb>_<noun>`, not its noun. */
const NAME_VERBS: ReadonlySet<string> = new Set([
  'add',
  'assign',
  'close',
  'count',
  'create',
  'delete',
  'download',
  'get',
  'link',
  'list',
  'move',
  'parse',
  'rank',
  'remove',
  'search',
  'set',
  'start',
  'transition',
  'unlink',
  'update',
  'upload',
]);

/** Name tokens that carry no noun. */
const NAME_FILLERS: ReadonlySet<string> = new Set(['my', 'to']);

/**
 * Tools whose name holds no noun a description would use; each names the noun
 * that stands in for it. Kept short on purpose: a new tool should name its noun.
 */
const NOUN_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  jira_count: ['issue'],
  jira_get_myself: ['account'],
};

/** Every model-visible string of one tool: its description and the schema's. */
function modelVisibleStrings(tool: Tool): { where: string; text: string }[] {
  const found = [{ where: 'description', text: tool.description ?? '' }];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      found.push({ where: path, text: node });
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    }
  };
  walk(tool.inputSchema, 'inputSchema');
  return found;
}

/** The nouns a tool's name commits its description to. */
function nameNouns(name: string): readonly string[] {
  const override = NOUN_OVERRIDES[name];
  if (override) return override;
  const tokens = name.split('_').slice(1);
  if (tokens.length > 1 && NAME_VERBS.has(tokens[0] ?? '')) tokens.shift();
  return tokens
    .filter((token) => !NAME_FILLERS.has(token))
    .map((token) => token.replace(/(?:ies|es|s)$/, ''));
}

/** Why a description is not keyword-first, or `undefined` when it is. */
function keywordFirstProblem(name: string, description: string): string | undefined {
  const head = description.slice(0, KEYWORD_WINDOW);
  const words = head.split(/\s+/);
  const first = LEADING_ADVERBS.has(words[0] ?? '') ? (words[1] ?? '') : (words[0] ?? '');
  const verb = first.charAt(0).toUpperCase() + first.slice(1);
  if (!OPENING_VERBS.has(verb)) {
    return `opens with "${words.slice(0, 2).join(' ')}", not an imperative verb from the allowed list`;
  }
  const nouns = nameNouns(name);
  const lower = head.toLowerCase();
  if (!nouns.some((noun) => new RegExp(`\\b${noun}`).test(lower))) {
    return `names none of [${nouns.join(', ')}] in its first ${KEYWORD_WINDOW} characters`;
  }
  return undefined;
}

const TOOLS: readonly Tool[] = PACKAGES.flatMap((pkg) => pkg.tools).map((spec) =>
  toMcpTool(spec, { maxResultChars: 25_000 }),
);

test('[CC-5170] no model-visible string carries an internal tracker id', () => {
  const leaks: string[] = [];
  for (const tool of TOOLS) {
    for (const { where, text } of modelVisibleStrings(tool)) {
      const hit = TRACKER_ID.exec(text);
      if (hit) leaks.push(`${tool.name} ${where}: "${hit[0]}"`);
    }
  }
  assert.deepEqual(leaks, []);
});

test('[CC-5171] the tracker pattern catches every id form and spares issue keys', () => {
  for (const id of [
    'CC-31',
    'D124',
    'D-124',
    'V3-07',
    'WP-12',
    'O-9',
    'MCP-06',
    'DOC-R7',
  ]) {
    assert.ok(TRACKER_ID.test(`see ${id} here`), id);
  }
  for (const text of [
    'PROJ-123',
    'ABCD-12',
    'SAN-1204',
    'UTF-8',
    'ISO-8601',
    'D3',
    'ADF',
  ]) {
    assert.equal(TRACKER_ID.test(text), false, text);
  }
});

test('[CC-5172] every description is keyword-first', () => {
  const problems = TOOLS.flatMap((tool) => {
    const problem = keywordFirstProblem(tool.name, tool.description ?? '');
    return problem ? [`${tool.name}: ${problem}`] : [];
  });
  assert.deepEqual(problems, []);
});

test('[CC-5173] the keyword rule rejects a context-first opening and a missing noun', () => {
  assert.match(
    keywordFirstProblem('jira_list_fields', 'THE discovery tool for field ids.') ?? '',
    /not an imperative verb/,
  );
  assert.match(
    keywordFirstProblem('jira_list_versions', 'Lists the versions of a project.') ?? '',
    /not an imperative verb/,
  );
  assert.match(
    keywordFirstProblem('jira_get_worklogs', 'List the work logged on an issue.') ?? '',
    /names none of \[worklog\]/,
  );
  assert.equal(
    keywordFirstProblem('jira_delete_issue', 'Permanently delete one issue.'),
    undefined,
  );
  const late = `List ${'x'.repeat(KEYWORD_WINDOW)} versions.`;
  assert.match(keywordFirstProblem('jira_list_versions', late) ?? '', /names none/);
});

test('[CC-5174] a name yields its nouns, not its verb or fillers', () => {
  assert.deepEqual(nameNouns('jira_get_my_permissions'), ['permission']);
  assert.deepEqual(nameNouns('jira_move_to_sprint'), ['sprint']);
  assert.deepEqual(nameNouns('jira_get_changelogs_bulk'), ['changelog', 'bulk']);
  assert.deepEqual(nameNouns('jira_sprint_summary'), ['sprint', 'summary']);
  assert.deepEqual(nameNouns('jira_get_transitions'), ['transition']);
  assert.deepEqual(nameNouns('jira_count'), ['issue']);
});

test('[CC-5175] every noun override names a real tool', () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  for (const name of Object.keys(NOUN_OVERRIDES)) assert.ok(names.has(name), name);
});
