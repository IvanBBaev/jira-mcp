#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Startup benchmark (D519, V3-14): how much CPU the server spends before its
// first `tools/list` answer, and where it goes.
//
// Wall-clock time is not reproducible on a loaded machine (TSN-17 measured a
// load average near 55 on the dev box), so every figure here is CPU time read
// from `process.cpuUsage()` inside the measured process, reported as the median
// of N fresh processes. Two measurements:
//
//  - end to end: `build/index.js` started like a client starts it, over stdio,
//    with placeholder credentials and `fetch` fenced off; a `--import` hook
//    records the process's CPU at the moment the `tools/list` response is
//    written. This is the figure the budget applies to.
//  - stages: a separate fresh process imports the layers one at a time and
//    times each step — the SDK server, the tool manifest (which runs every
//    `defineTool`), converting every input schema to JSON Schema, and the
//    `defineTool` schema probes replayed over the manifest.
//
// The budget is 300 ms CPU end to end with every package listed (D519). The
// committed baseline lives in `test/startup-baseline.json`; the gate does not
// run this script, because no timing is stable enough for a gate.
//
// Usage (after `npm run build`):
//     node scripts/bench-startup.mjs [--runs N] [--check] [--update]
//   --check   exit 1 when the end-to-end median for `all` is over budget
//   --update  rewrite test/startup-baseline.json with this run's medians
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const ENTRY = join(BUILD, 'index.js');
const BASELINE = join(ROOT, 'test', 'startup-baseline.json');

/** End-to-end CPU budget, milliseconds, with every package listed (D519). */
export const BUDGET_MS = 300;

/** Profiles measured end to end; `all` is the one the budget applies to. */
const PROFILES = ['core', 'all'];

const RUN_TIMEOUT_MS = 30_000;

/**
 * Preload for the end-to-end child: fence the network (the testing fence
 * would also strip the placeholder `JIRA_*` credentials), watch stdout for the
 * `tools/list` response (JSON-RPC id 2) and report the process's CPU at that
 * write on stderr, behind a marker no server diagnostic uses.
 */
const HOOK_SOURCE = `
globalThis.fetch = () => Promise.reject(new Error('bench-startup: the network is fenced off'));
const write = process.stdout.write.bind(process.stdout);
let done = false;
const isListAnswer = (text) => {
  try { return JSON.parse(text).id === 2; } catch { return false; }
};
process.stdout.write = (chunk, ...rest) => {
  if (!done && isListAnswer(String(chunk))) {
    done = true;
    const cpu = process.cpuUsage();
    process.stderr.write('@@bench ' + JSON.stringify({
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssMb: process.memoryUsage().rss / 2 ** 20,
      bytes: Buffer.byteLength(String(chunk)),
    }) + '\\n');
  }
  return write(chunk, ...rest);
};
`;
const HOOK_URL = `data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`;

/** The stage breakdown, run as `node --input-type=module -e` in a fresh process. */
function stagesSource() {
  const url = (path) => JSON.stringify(pathToFileURL(join(BUILD, path)).href);
  return `
const t = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };
const out = { bootstrapMs: t() };
let at = t();
const lap = (key) => { const now = t(); out[key] = now - at; at = now; };
await import('@modelcontextprotocol/sdk/server/index.js');
await import('@modelcontextprotocol/sdk/server/stdio.js');
lap('sdkImportMs');
const { PACKAGES } = await import(${url('tools/index.js')});
lap('manifestImportMs');
const specs = PACKAGES.flatMap((pkg) => pkg.tools);
const { toInputSchema } = await import(${url('mcp/schema.js')});
lap('schemaModuleMs');
for (const spec of specs) toInputSchema(spec);
lap('schemaConvertAllMs');
const { checkToolSchema } = await import(${url('mcp/define.js')});
at = t();
for (const spec of specs) checkToolSchema(spec);
lap('schemaProbesAllMs');
out.tools = specs.length;
process.stdout.write(JSON.stringify(out));
`;
}

/**
 * An empty home and working directory, so neither the operator's
 * `~/.config/jira-mcp-ai/.env` nor a project `.env` leaks into the run.
 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'jira-mcp-bench-'));

function benchEnv(profile) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: SANDBOX,
    XDG_CONFIG_HOME: join(SANDBOX, '.config'),
    JIRA_SITE: 'https://bench.atlassian.net',
    JIRA_EMAIL: 'bench@example.com',
    JIRA_API_TOKEN: 'bench-placeholder',
    JIRA_TOOL_PACKAGES: profile,
  };
}

function rpc(id, method, params = {}) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/** One end-to-end run: spawn, initialize, list, read the hook's figure. */
function runEndToEnd(profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', HOOK_URL, ENTRY], {
      cwd: SANDBOX,
      env: benchEnv(profile),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out; stderr:\n${stderr}`)),
      RUN_TIMEOUT_MS,
    );
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      stderr += data;
      const line = stderr.split('\n').find((l) => l.startsWith('@@bench '));
      if (line !== undefined) finish(null, JSON.parse(line.slice('@@bench '.length)));
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) =>
      finish(new Error(`server exited (${code}) before tools/list; stderr:\n${stderr}`)),
    );
    child.stdin.write(
      rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'bench-startup', version: '0' },
      }),
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(rpc(2, 'tools/list'));
  });
}

function runStages() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', stagesSource()], {
      cwd: ROOT,
      env: benchEnv('all'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(JSON.parse(stdout))
        : reject(new Error(`stages failed:\n${stderr}`)),
    );
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (n) => Math.round(n * 10) / 10;

function medianOf(rows) {
  const out = {};
  for (const key of Object.keys(rows[0]))
    out[key] = round(median(rows.map((r) => r[key])));
  return out;
}

function parseArgs(argv) {
  const args = { runs: 15, check: false, update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--update') args.update = true;
    else if (arg === '--runs') args.runs = Number(argv[(i += 1)]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1)
    throw new Error('--runs must be a positive integer');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(ENTRY))
    throw new Error('build/index.js is missing — run `npm run build` first');

  const endToEnd = {};
  for (const profile of PROFILES) {
    const rows = [];
    for (let i = 0; i < args.runs; i += 1) rows.push(await runEndToEnd(profile));
    endToEnd[profile] = medianOf(rows);
  }
  const stageRows = [];
  for (let i = 0; i < args.runs; i += 1) stageRows.push(await runStages());
  const stages = medianOf(stageRows);

  const result = {
    measured: new Date().toISOString().slice(0, 10),
    node: process.version,
    runs: args.runs,
    budgetMs: BUDGET_MS,
    endToEnd,
    stages,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (existsSync(BASELINE) && !args.update) {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const was = baseline.endToEnd?.all?.cpuMs;
    if (typeof was === 'number') {
      const delta = endToEnd.all.cpuMs - was;
      process.stderr.write(
        `all: ${endToEnd.all.cpuMs} ms CPU (baseline ${was} ms, ${delta >= 0 ? '+' : ''}${round(delta)} ms)\n`,
      );
    }
  }
  if (args.update) {
    writeFileSync(BASELINE, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`baseline written to ${BASELINE}\n`);
  }
  if (endToEnd.all.cpuMs > BUDGET_MS) {
    process.stderr.write(`over budget: ${endToEnd.all.cpuMs} ms CPU > ${BUDGET_MS} ms\n`);
    if (args.check) process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    process.stderr.write(
      `bench-startup: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => rmSync(SANDBOX, { recursive: true, force: true }));
