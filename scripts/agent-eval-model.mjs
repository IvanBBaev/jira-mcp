#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Tool-selection eval, model tier (D528, V3-46, MCP-05).
//
// The deterministic tier (src/tools/agent-eval.test.ts) runs in every gate and
// scores a keyword search over `tools/list`. This tier asks a real model: each
// golden task in `test/agent-evals/tasks.json` is sent to the Anthropic
// Messages API with the server's whole `tools/list` (every package) converted
// to the Anthropic tool format, and the first `tool_use` block of the answer is
// compared with the task's expected tool and its golden key arguments.
//
// It is OWNER-RUN ONLY. It spends API credit (48 requests, each carrying the
// ~114k-character tool list; the list is marked for prompt caching so repeat
// requests read it from cache), so it never runs in CI or in `npm run check`:
// it refuses to start when `CI` is set. Whether to schedule it is an open
// review question (MCP review, question 5); until that is decided it is
// manual.
//
// The key comes from the environment only — never pass it on the command line
// and never commit it. It uses plain `fetch` so the package gains no
// dependency for a script that ships nowhere.
//
// Usage (after `npm run build`):
//     ANTHROPIC_API_KEY=<key> node scripts/agent-eval-model.mjs [--model ID] [--only ID,ID] [--json]
//   --model   model id (default claude-opus-5-5)
//   --only    run only the named task ids
//   --json    print the per-task results as JSON on stdout
// Exit code: 0 when the run completed (whatever the score), 1 on a usage or
// API error. The score is a report for the owner, not a gate.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = join(ROOT, 'test', 'agent-evals', 'tasks.json');
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM_PROMPT =
  'You are an assistant connected to a Jira Cloud MCP server. For the user request, ' +
  'call the single tool you would call FIRST to make progress, with the arguments you ' +
  'can already fill in. Always answer with a tool call; do not ask questions.';

function fail(message) {
  process.stderr.write(`agent-eval-model: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { model: DEFAULT_MODEL, only: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') options.model = argv[++i] ?? fail('--model needs a value');
    else if (arg === '--only')
      options.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else if (arg === '--json') options.json = true;
    else fail(`unknown argument ${arg}`);
  }
  return options;
}

/** The server's tools in the Anthropic tool format, the last one marked for caching. */
async function loadTools() {
  const manifest = join(ROOT, 'build', 'tools', 'index.js');
  if (!existsSync(manifest)) fail('build/ is missing — run `npm run build` first');
  const { PACKAGES } = await import(pathToFileURL(manifest).href);
  const { toMcpTool } = await import(
    pathToFileURL(join(ROOT, 'build', 'mcp', 'server.js')).href
  );
  const tools = PACKAGES.flatMap((pkg) => pkg.tools)
    .map((spec) => toMcpTool(spec, { maxResultChars: 25_000 }))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema,
    }));
  tools[tools.length - 1] = {
    ...tools[tools.length - 1],
    cache_control: { type: 'ephemeral' },
  };
  return tools;
}

async function ask(apiKey, model, tools, task) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      tools,
      // Forced tool choice (`any`) is rejected by current models; the system
      // prompt asks for a tool call instead.
      tool_choice: { type: 'auto' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: task }],
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${body?.error?.message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

/** Golden argument keys the model's call matched by value (loose, JSON-equal). */
function compareArgs(golden, actual) {
  const keys = Object.keys(golden);
  const matched = keys.filter(
    (key) => JSON.stringify(actual?.[key]) === JSON.stringify(golden[key]),
  );
  return { matched: matched.length, total: keys.length };
}

async function main() {
  if (process.env.CI)
    fail('refusing to run under CI: this tier spends API credit and is owner-run only');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    fail('set ANTHROPIC_API_KEY in the environment (never on the command line)');
  const options = parseArgs(process.argv.slice(2));

  const { tasks } = JSON.parse(readFileSync(TASKS, 'utf8'));
  const selected = options.only ? tasks.filter((t) => options.only.has(t.id)) : tasks;
  if (selected.length === 0) fail('no task selected');
  const tools = await loadTools();

  const results = [];
  for (const task of selected) {
    let result;
    try {
      const message = await ask(apiKey, options.model, tools, task.task);
      const call = message.content.find((block) => block.type === 'tool_use');
      result = {
        id: task.id,
        expected: task.expected,
        chosen: call?.name ?? null,
        stopReason: message.stop_reason,
        hit: call?.name === task.expected,
        args: call
          ? compareArgs(task.args, call.input)
          : { matched: 0, total: Object.keys(task.args).length },
      };
    } catch (error) {
      result = {
        id: task.id,
        expected: task.expected,
        chosen: null,
        error: String(error),
        hit: false,
      };
    }
    results.push(result);
    const mark = result.hit ? 'ok  ' : 'MISS';
    const argNote = result.args
      ? ` args ${result.args.matched}/${result.args.total}`
      : '';
    process.stderr.write(
      `${mark} ${task.id}: ${result.chosen ?? result.error ?? `no tool call (${result.stopReason})`}${argNote}\n`,
    );
  }

  const hits = results.filter((r) => r.hit).length;
  const argTotals = results.reduce(
    (sum, r) =>
      r.hit && r.args
        ? { matched: sum.matched + r.args.matched, total: sum.total + r.args.total }
        : sum,
    { matched: 0, total: 0 },
  );
  process.stderr.write(
    `\n${options.model}: first-tool accuracy ${hits}/${results.length} ` +
      `(${((hits / results.length) * 100).toFixed(1)} %); golden args matched on hits ` +
      `${argTotals.matched}/${argTotals.total}\n`,
  );
  if (options.json)
    process.stdout.write(
      `${JSON.stringify({ model: options.model, results }, null, 2)}\n`,
    );
  if (results.some((r) => r.error)) process.exit(1);
}

await main();
