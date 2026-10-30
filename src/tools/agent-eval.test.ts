// ---------------------------------------------------------------------------
// The tool-selection eval, deterministic tier (D528, MCP-05).
//
// An agent in a client with tool search does not see 82 tools; it sees what a
// keyword search over tool names and the start of their descriptions returns.
// A description edit that buries the verb, or a rename, can push the right
// tool out of that shortlist without breaking a single unit test. This test
// replays the golden tasks in `test/agent-evals/tasks.json` against a
// simulated description-start keyword search over the emitted `tools/list`
// and pins the top-1 and top-3 hit counts to the recorded baseline:
//  - a count BELOW the baseline fails (a selection regression);
//  - a count ABOVE it fails too, asking for a re-baseline, so an improvement is
//    locked in rather than silently there for the next change to spend.
//
// The scorer is deliberately simple and deterministic — it is a proxy for a
// tool search, not a model. The model tier is `scripts/agent-eval-model.mjs`,
// which the owner runs by hand because it spends API credit; it never runs in
// CI (docs/TESTING.md).
//
// Each task also names the key arguments of the expected first call; those
// are checked against the tool's input schema, so a renamed or newly required
// parameter breaks the golden set loudly instead of rotting it.
//
// It lives in the tools ring, not in mcp/, because only a composition root may
// see both the manifest and the server's `toMcpTool` (eslint layer zones).
//
// Re-baseline (rewrites `baseline` in the tasks file):
//     npm run build && UPDATE_AGENT_EVAL_BASELINE=1 node --import ./build/testing/network-fence.js \
//       --test "build/tools/agent-eval.test.js"
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { FAKE_AUTH_SETTINGS } from '../core/fakes/index.js';
import type { Settings } from '../core/types.js';
import { selectPackages } from '../mcp/registry.js';
import { toMcpTool } from '../mcp/server.js';

import { PACKAGES } from './index.js';

const TASKS_URL = new URL('../../test/agent-evals/tasks.json', import.meta.url);
const UPDATE_COMMAND =
  'npm run build && UPDATE_AGENT_EVAL_BASELINE=1 node --import ./build/testing/network-fence.js --test "build/tools/agent-eval.test.js"';

/** How much of a description the simulated search reads, like a client's tool search. */
const DESCRIPTION_PREFIX = 160;

/** A name token counts this much more than a description token. */
const NAME_WEIGHT = 2;

interface EvalTask {
  readonly id: string;
  readonly task: string;
  readonly expected: string;
  readonly args: Readonly<Record<string, unknown>>;
}

interface Baseline {
  readonly tasks: number;
  readonly top1: number;
  readonly top3: number;
}

interface TasksFile {
  readonly about: string;
  readonly baseline: Baseline;
  readonly tasks: readonly EvalTask[];
}

const BASE_SETTINGS: Settings = {
  site: 'example.atlassian.net',
  allowedHosts: [],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'plan',
  allowIrreversible: false,
  irreversibleConfirm: 'off',
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  metaCacheTtlS: 300,
  mediaMaxBytes: 1073741824,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
  ...FAKE_AUTH_SETTINGS,
};

/** Words that carry no tool-selection signal; `jira` is in every tool name. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'get',
  'give',
  'has',
  'have',
  'i',
  'in',
  'into',
  'is',
  'it',
  'its',
  'jira',
  'me',
  'my',
  'now',
  'of',
  'on',
  'one',
  'or',
  'right',
  'so',
  'that',
  'the',
  'their',
  'there',
  'these',
  'this',
  'to',
  'use',
  'what',
  'when',
  'which',
  'who',
  'with',
  'you',
  'your',
]);

/** Light suffix stripping, enough for `issues`/`issue`, `linked`/`link`, `ranking`/`rank`. */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss'))
    return word.slice(0, -1);
  return word;
}

/** Lower-case, split on anything but letters and digits, drop stopwords, stem. */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    tokens.add(stem(raw));
  }
  return tokens;
}

interface IndexedTool {
  readonly name: string;
  readonly nameTokens: Set<string>;
  readonly descriptionTokens: Set<string>;
}

export function indexTools(tools: readonly Tool[]): IndexedTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    nameTokens: tokenize(tool.name.replace(/_/g, ' ')),
    descriptionTokens: tokenize((tool.description ?? '').slice(0, DESCRIPTION_PREFIX)),
  }));
}

function score(query: Set<string>, tool: IndexedTool): number {
  let total = 0;
  for (const token of query) {
    if (tool.nameTokens.has(token)) total += NAME_WEIGHT;
    if (tool.descriptionTokens.has(token)) total += 1;
  }
  return total;
}

/**
 * The 1-based rank of `expected` for `query`, pessimistic on ties (every other
 * tool scoring the same ranks ahead of it); `Infinity` when it scores nothing.
 */
export function rankOf(
  query: string,
  expected: string,
  index: readonly IndexedTool[],
): number {
  const tokens = tokenize(query);
  const target = index.find((tool) => tool.name === expected);
  if (target === undefined) return Number.POSITIVE_INFINITY;
  const own = score(tokens, target);
  if (own === 0) return Number.POSITIVE_INFINITY;
  return 1 + index.filter((tool) => tool !== target && score(tokens, tool) >= own).length;
}

function listedTools(): Tool[] {
  const hints = { maxResultChars: BASE_SETTINGS.maxResultChars };
  return selectPackages(PACKAGES, BASE_SETTINGS)
    .packages.flatMap((pkg) => pkg.tools)
    .map((spec) => toMcpTool(spec, hints));
}

const file = JSON.parse(readFileSync(TASKS_URL, 'utf8')) as TasksFile;
const tools = listedTools();
const index = indexTools(tools);
const ranks = file.tasks.map((task) => ({
  task,
  rank: rankOf(task.task, task.expected, index),
}));
const measured: Baseline = {
  tasks: file.tasks.length,
  top1: ranks.filter((r) => r.rank <= 1).length,
  top3: ranks.filter((r) => r.rank <= 3).length,
};

if (process.env.UPDATE_AGENT_EVAL_BASELINE === '1') {
  writeFileSync(
    TASKS_URL,
    `${JSON.stringify({ ...file, baseline: measured }, null, 2)}\n`,
  );
  process.stderr.write(`agent-eval baseline rewritten: ${JSON.stringify(measured)}\n`);
}

const misses = ranks
  .filter((r) => r.rank > 3)
  .map((r) => `${r.task.id} → ${r.task.expected} (rank ${r.rank})`);
process.stderr.write(
  `agent-eval: top-1 ${measured.top1}/${measured.tasks}, top-3 ${measured.top3}/${measured.tasks}` +
    (misses.length > 0 ? `; outside top 3: ${misses.join(', ')}` : '') +
    '\n',
);

const baseline = (JSON.parse(readFileSync(TASKS_URL, 'utf8')) as TasksFile).baseline;

test('CC-5210: every golden task has a unique id and names a listed tool', () => {
  const names = new Set(tools.map((tool) => tool.name));
  const ids = new Set<string>();
  for (const task of file.tasks) {
    assert.ok(!ids.has(task.id), `duplicate task id ${task.id}`);
    ids.add(task.id);
    assert.ok(task.task.trim().length > 0, `${task.id}: empty task text`);
    assert.ok(
      names.has(task.expected),
      `${task.id}: ${task.expected} is not in tools/list`,
    );
  }
  assert.ok(
    file.tasks.length >= 40,
    `the golden set holds ${file.tasks.length} tasks, fewer than 40`,
  );
});

test('CC-5211: golden arguments match the expected tool input schema', () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const task of file.tasks) {
    const schema = byName.get(task.expected)?.inputSchema;
    assert.ok(schema !== undefined, `${task.id}: no schema for ${task.expected}`);
    const properties = Object.keys(schema.properties ?? {});
    for (const key of Object.keys(task.args)) {
      assert.ok(
        properties.includes(key),
        `${task.id}: ${task.expected} has no argument "${key}" (has: ${properties.join(', ')})`,
      );
    }
    for (const key of schema.required ?? []) {
      assert.ok(
        key in task.args,
        `${task.id}: ${task.expected} requires "${key}" but the golden call omits it`,
      );
    }
  }
});

test('CC-5212: the baseline covers the whole golden set', () => {
  assert.equal(
    baseline.tasks,
    measured.tasks,
    `the golden set changed size — re-baseline with: ${UPDATE_COMMAND}`,
  );
});

test('CC-5213: top-1 and top-3 hit counts do not fall below the baseline', () => {
  for (const key of ['top1', 'top3'] as const) {
    assert.ok(
      measured[key] >= baseline[key],
      `${key} regressed: ${measured[key]}/${measured.tasks} vs a baseline of ${baseline[key]}. ` +
        `Outside top 3: ${misses.join(', ') || 'none'}. A description or name change made the ` +
        'right tool harder to find; fix the wording, or re-baseline only if the trade is deliberate.',
    );
  }
});

test('CC-5214: a hit count above the baseline asks for a re-baseline', () => {
  for (const key of ['top1', 'top3'] as const) {
    assert.ok(
      measured[key] <= baseline[key],
      `${key} improved to ${measured[key]}/${measured.tasks} (baseline ${baseline[key]}): ` +
        `lock it in with: ${UPDATE_COMMAND}`,
    );
  }
});

const FAKE_TOOLS = indexTools([
  {
    name: 'jira_list_sprints',
    description: 'List the sprints of a board.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'jira_close_sprint',
    description: 'Close an active sprint.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'jira_get_issue',
    description: `${'x '.repeat(100)}sprint`,
    inputSchema: { type: 'object' },
  },
]);

test('CC-5215: ties rank pessimistically and a zero score never ranks', () => {
  assert.equal(
    rankOf('list the sprints on board 12', 'jira_list_sprints', FAKE_TOOLS),
    1,
  );
  assert.equal(rankOf('close sprint 34', 'jira_close_sprint', FAKE_TOOLS), 1);
  // A tie ranks the expected tool behind its equals.
  assert.equal(rankOf('sprint', 'jira_list_sprints', FAKE_TOOLS), 2);
  assert.equal(
    rankOf('board', 'jira_close_sprint', FAKE_TOOLS),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(rankOf('anything', 'jira_missing', FAKE_TOOLS), Number.POSITIVE_INFINITY);
});

test('CC-5216: only the name and the description start count', () => {
  assert.equal(rankOf('sprint', 'jira_get_issue', FAKE_TOOLS), Number.POSITIVE_INFINITY);
  assert.equal(rankOf('issue', 'jira_get_issue', FAKE_TOOLS), 1);
});

test('CC-5217: tokenize drops stopwords and numbers and stems plurals', () => {
  assert.deepEqual(
    [...tokenize('Show the issues in Jira sprint 34')],
    ['show', 'issue', 'sprint'],
  );
  assert.equal(stem('linked'), 'link');
  assert.equal(stem('ranking'), 'rank');
  assert.equal(stem('entries'), 'entry');
  assert.equal(stem('class'), 'class');
});

// The model tier is a script the owner runs; its refusals are reachable only by
// spawning it. Every arm below must stop before the first request: the child
// carries no network fence. The environment is built from scratch so no
// developer ANTHROPIC_API_KEY or CI flag leaks in.
const SCRIPT = fileURLToPath(
  new URL('../../scripts/agent-eval-model.mjs', import.meta.url),
);

function runScript(
  env: Record<string, string>,
  args: readonly string[] = [],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { PATH: process.env['PATH'] ?? '', ...env }, timeout: 20_000 },
      (_error, _stdout, stderr) => {
        resolve({ code: child.exitCode, stderr: String(stderr) });
      },
    );
  });
}

test('CC-5218: the model tier refuses to run under CI or without a key in the environment', async () => {
  const underCi = await runScript({ CI: 'true', ANTHROPIC_API_KEY: '<placeholder>' });
  assert.equal(underCi.code, 1);
  assert.match(underCi.stderr, /refusing to run under CI/);
  const noKey = await runScript({});
  assert.equal(noKey.code, 1);
  assert.match(noKey.stderr, /set ANTHROPIC_API_KEY/);
});

test('CC-5219: the model tier refuses an unknown flag or an empty task selection before any request', async () => {
  const env = { ANTHROPIC_API_KEY: '<placeholder>' };
  const unknown = await runScript(env, ['--temperature', '0']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown argument --temperature/);
  const none = await runScript(env, ['--only', 'no-such-task']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no task selected/);
});
