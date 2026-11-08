#!/usr/bin/env node
/**
 * record-demo — the README demo, recorded from a real run instead of drawn.
 *
 * WHAT IT SHOWS. Three beats, in the order a reader needs them:
 *   1. a transition and a worklog come back as PLANS — nothing is sent to Jira;
 *   2. a call that names an issue outside `JIRA_PROJECTS` is refused at call
 *      time, before any request leaves the process;
 *   3. the two plans are applied with their `plan_id`, and a re-read shows
 *      the effect.
 *
 * HOW. The built server (`build/index.js`) is spawned over stdio MCP, exactly
 * as a client spawns it, against `scripts/fake-jira.mjs` — the same loopback
 * stand-in and the same child-only DNS preload `scripts/rehearse-live.mjs`
 * uses, so no tenant and no credential is involved. The client is this
 * script: the "you ›" lines are scripted prompts, not a model. Every other line
 * of the transcript is read from the tool results, and the run fails instead
 * of rendering if a beat does not behave (see `checkDemo`), so the recording
 * cannot show something the server did not do.
 *
 * OUTPUT. The transcript goes to stdout. `--cast <file>` also writes an
 * asciicast v2 recording with fixed timings. `--gif <file>` writes the cast to
 * a temporary file and renders it with `agg`
 * (https://github.com/asciinema/agg), which must be on PATH; without it the
 * script says so and exits 2 rather than producing anything else. The README
 * GIF is made with:
 *
 *   npm run build
 *   node scripts/record-demo.mjs --gif docs/assets/demo.gif
 *
 * Exit codes: 0 = recorded, 1 = a beat misbehaved, 2 = setup error (no build,
 * no openssl, no agg).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  API_HOST,
  MEDIA_HOST,
  REHEARSAL_DNS_PRELOAD,
  startFakeJira,
} from './fake-jira.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(REPO_ROOT, 'build', 'index.js');

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_CONFIG = 2;

const EMAIL = 'demo@example.invalid';
const TOKEN = 'demo-token-not-a-real-secret';
export const IN_SCOPE = 'SCRATCH';
export const OUT_OF_SCOPE = 'LEGACY';
export const ISSUE = `${IN_SCOPE}-1`;
export const FOREIGN_ISSUE = `${OUT_OF_SCOPE}-1`;

/** Fixed, so a plan and its apply carry identical arguments. */
const WORK_STARTED = '2026-11-02T09:00:00+00:00';

export const TRANSITION_ARGS = Object.freeze({
  issue: ISSUE,
  transition: 'Done',
  fields: { resolution: { name: 'Done' } },
});
export const WORKLOG_ARGS = Object.freeze({
  issue: ISSUE,
  timeSpentSeconds: 7200,
  started: WORK_STARTED,
});
export const FOREIGN_ARGS = Object.freeze({ issue: FOREIGN_ISSUE, transition: 'Done' });

/** The server's configuration for the recording: scoped, writes armed. */
export const DEMO_ENV = Object.freeze({
  JIRA_PROJECTS: IN_SCOPE,
  JIRA_WRITE_MODE: 'apply',
});

// ---------------------------------------------------------------------------
// Pure helpers (pinned by src/testing/record-demo.test.ts)
// ---------------------------------------------------------------------------

/** The envelope a tool result carries in `structuredContent`. */
function envelope(result) {
  return result?.structuredContent ?? {};
}

/** `plan_9f31c04ab2…` — enough to tell two plans apart on screen. */
export function shortPlanId(id) {
  return typeof id === 'string' && id.length > 15 ? `${id.slice(0, 15)}…` : String(id);
}

/**
 * Every way the three beats can fail to prove what the transcript says.
 * Returns failure messages; empty means the recording is honest.
 *
 * @param {object} run
 * @param {object} run.transitionPlan   result of the planned transition
 * @param {object} run.worklogPlan      result of the planned worklog
 * @param {object} run.refusal          result of the out-of-scope call
 * @param {object} run.transitionApply  result of the applied transition
 * @param {object} run.worklogApply     result of the applied worklog
 * @param {object} run.reread           result of the final jira_get_issue
 * @param {readonly { method: string, path: string }[]} run.requestsBeforeApply
 *   what the fake saw up to the first apply
 * @param {readonly { method: string, path: string }[]} run.requests
 *   what the fake saw in the whole run
 */
export function checkDemo(run) {
  const failures = [];
  for (const [label, result] of [
    ['transition plan', run.transitionPlan],
    ['worklog plan', run.worklogPlan],
  ]) {
    const env = envelope(result);
    if (env.ok !== true || env.data?.executed !== false) {
      failures.push(`${label}: expected an unexecuted plan`);
    } else if (typeof env.data.plan_id !== 'string') {
      failures.push(`${label}: no plan_id`);
    }
  }

  const refusal = envelope(run.refusal);
  if (refusal.ok !== false || refusal.error?.kind !== 'permission') {
    failures.push('out-of-scope call: expected a permission refusal');
  }

  // Plan mode sends reads only; the writes must not appear before the apply.
  const earlyWrites = run.requestsBeforeApply.filter((r) => r.method !== 'GET');
  if (earlyWrites.length > 0) {
    failures.push(
      `a write reached Jira before the apply: ${earlyWrites.map((r) => `${r.method} ${r.path}`).join(', ')}`,
    );
  }
  // The refusal happens at call time: nothing naming the foreign issue or
  // project may ever reach the wire.
  const foreign = run.requests.filter(
    (r) => r.path.includes(FOREIGN_ISSUE) || r.path.includes(`/${OUT_OF_SCOPE}`),
  );
  if (foreign.length > 0) {
    failures.push(
      `the out-of-scope call reached Jira: ${foreign.map((r) => `${r.method} ${r.path}`).join(', ')}`,
    );
  }

  for (const [label, result] of [
    ['transition apply', run.transitionApply],
    ['worklog apply', run.worklogApply],
  ]) {
    const env = envelope(result);
    if (env.ok !== true || env.data?.executed !== true) {
      failures.push(`${label}: expected an executed write`);
    }
  }

  const status =
    envelope(run.reread).data?.fields?.status?.name ?? envelope(run.reread).data?.status;
  if (status !== 'Done') {
    failures.push(`re-read: expected status Done, got ${JSON.stringify(status)}`);
  }
  return failures;
}

/** One transcript line per entry; `kind` picks the colour. */
function line(kind, text) {
  return { kind, text };
}

/**
 * The transcript, built only from tool results.
 *
 * @returns {{ kind: string, text: string }[]}
 */
export function renderTranscript(run) {
  const tPlan = envelope(run.transitionPlan).data ?? {};
  const wPlan = envelope(run.worklogPlan).data ?? {};
  const refused = envelope(run.refusal).error ?? {};
  const diff = (tPlan.diff ?? []).find((d) => d.field === 'status');
  const reread = envelope(run.reread).data ?? {};
  const status = reread.fields?.status?.name ?? reread.status ?? '?';
  const hours = (WORKLOG_ARGS.timeSpentSeconds / 3600).toString();

  return [
    line(
      'caption',
      `jira-mcp-ai · JIRA_PROJECTS=${IN_SCOPE} · JIRA_WRITE_MODE=apply · fake Jira on loopback`,
    ),
    line('blank', ''),
    line('you', `Move ${ISSUE} to Done and log the ${hours}h I spent.`),
    line('tool', `jira_transition_issue — plan`),
    line(
      'detail',
      `  would ${tPlan.planned?.method ?? '?'} ${tPlan.planned?.path ?? '?'}` +
        (diff === undefined ? '' : `   status ${diff.from} → ${diff.to}`),
    ),
    line('detail', `  plan_id ${shortPlanId(tPlan.plan_id)}`),
    line(
      'tool',
      `jira_add_worklog — plan   ${hours}h   plan_id ${shortPlanId(wPlan.plan_id)}`,
    ),
    line('warn', '  NOT performed — plan mode. Nothing was sent to Jira.'),
    line('blank', ''),
    line('you', `Close ${FOREIGN_ISSUE} too while you are at it.`),
    line(
      'tool',
      `jira_transition_issue ${FOREIGN_ISSUE} — refused (${refused.kind ?? '?'})`,
    ),
    line('warn', `  ${refused.reason ?? refused.message ?? '?'}`),
    line('blank', ''),
    line('you', `The ${ISSUE} plans look right. Apply them.`),
    line('tool', `jira_transition_issue — apply   ok   ${ISSUE} → ${diff?.to ?? '?'}`),
    line('tool', `jira_add_worklog — apply   ok   ${hours}h logged`),
    line('tool', `jira_get_issue — read   status ${status}`),
  ];
}

const ANSI = {
  caption: '\u001b[2m',
  you: '\u001b[1;36m',
  tool: '\u001b[32m',
  detail: '\u001b[2m',
  warn: '\u001b[33m',
  blank: '',
};
const RESET = '\u001b[0m';

/** Wrap at `width` columns on spaces, keeping a two-space hanging indent. */
export function wrap(text, width) {
  if (text.length <= width) return [text];
  const out = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 2) cut = width;
    out.push(rest.slice(0, cut));
    rest = `  ${rest.slice(cut).trimStart()}`;
  }
  out.push(rest);
  return out;
}

/** Plain or coloured text, one string per terminal row. */
export function formatLines(lines, { width = 96, color = false } = {}) {
  const prefix = { you: 'you › ', tool: '▸ ' };
  return lines.flatMap(({ kind, text }) =>
    wrap(`${prefix[kind] ?? ''}${text}`, width).map((row) =>
      color && ANSI[kind] ? `${ANSI[kind]}${row}${RESET}` : row,
    ),
  );
}

/**
 * An asciicast v2 recording with fixed timings: the same transcript always
 * gives the same file, so the GIF changes only when the server's answers do.
 */
export function toAsciicast(
  lines,
  { width = 96, height = 26, title = 'jira-mcp-ai demo' } = {},
) {
  const header = { version: 2, width, height, title, env: { TERM: 'xterm-256color' } };
  const pause = {
    you: 1.4,
    tool: 0.9,
    detail: 0.35,
    warn: 0.8,
    caption: 0.6,
    blank: 0.4,
  };
  const events = [];
  let t = 0.5;
  for (const entry of lines) {
    for (const row of formatLines([entry], { width, color: true })) {
      events.push([Number(t.toFixed(2)), 'o', `${row}\r\n`]);
    }
    t += pause[entry.kind] ?? 0.5;
  }
  // Hold the last frame so the loop does not restart mid-read.
  events.push([Number((t + 3).toFixed(2)), 'o', '']);
  return (
    [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

async function record(workdir) {
  const certDir = join(workdir, 'tls');
  await mkdir(certDir, { recursive: true });
  const preload = join(workdir, 'rehearsal-dns.mjs');
  await writeFile(preload, REHEARSAL_DNS_PRELOAD, 'utf8');

  const fake = await startFakeJira({
    email: EMAIL,
    token: TOKEN,
    projectKey: IN_SCOPE,
    project2Key: OUT_OF_SCOPE,
    certDir,
  });
  const home = join(workdir, 'home');
  await mkdir(home, { recursive: true });
  // A minimal environment: no developer `.env`, no inherited JIRA_* value.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: home,
    stderr: 'pipe',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      TZ: 'UTC',
      JIRA_SITE: fake.origin,
      JIRA_EMAIL: EMAIL,
      JIRA_API_TOKEN: TOKEN,
      JIRA_ALLOWED_HOSTS: `${API_HOST},${MEDIA_HOST}`,
      NODE_EXTRA_CA_CERTS: fake.certFile,
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
      ...DEMO_ENV,
    },
  });
  const client = new Client({ name: 'jira-mcp-record-demo', version: '0.0.0' });
  try {
    await client.connect(transport);
    const transitionPlan = await call(client, 'jira_transition_issue', TRANSITION_ARGS);
    const worklogPlan = await call(client, 'jira_add_worklog', WORKLOG_ARGS);
    const refusal = await call(client, 'jira_transition_issue', FOREIGN_ARGS);
    const requestsBeforeApply = fake.requests.slice();
    const transitionApply = await call(client, 'jira_transition_issue', {
      ...TRANSITION_ARGS,
      apply: true,
      plan_id: envelope(transitionPlan).data?.plan_id,
    });
    const worklogApply = await call(client, 'jira_add_worklog', {
      ...WORKLOG_ARGS,
      apply: true,
      plan_id: envelope(worklogPlan).data?.plan_id,
    });
    const reread = await call(client, 'jira_get_issue', { issue: ISSUE });
    return {
      transitionPlan,
      worklogPlan,
      refusal,
      transitionApply,
      worklogApply,
      reread,
      requestsBeforeApply,
      requests: fake.requests.slice(),
    };
  } finally {
    try {
      await transport.close();
    } catch {
      // Already gone is what we wanted.
    }
    await fake.close();
  }
}

function hasAgg() {
  try {
    execFileSync('agg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      cast: { type: 'string' },
      gif: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help === true) {
    process.stdout.write(
      'record-demo — record the README demo against scripts/fake-jira.mjs.\n\n' +
        'Flags: --cast <file> (asciicast v2), --gif <file> (needs agg on PATH), --help\n',
    );
    return EXIT_OK;
  }
  if (!existsSync(SERVER_ENTRY)) {
    process.stderr.write(`no build at ${SERVER_ENTRY} — run \`npm run build\` first.\n`);
    return EXIT_CONFIG;
  }
  if (values.gif !== undefined && !hasAgg()) {
    process.stderr.write(
      'agg is not on PATH, so no GIF was rendered. Install it ' +
        '(https://github.com/asciinema/agg), or pass --cast <file> and render later.\n',
    );
    return EXIT_CONFIG;
  }

  const workdir = await mkdtemp(join(tmpdir(), 'record-demo-'));
  try {
    const run = await record(workdir);
    const failures = checkDemo(run);
    if (failures.length > 0) {
      for (const failure of failures) process.stderr.write(`demo: ${failure}\n`);
      return EXIT_FAILURE;
    }
    const lines = renderTranscript(run);
    process.stdout.write(
      formatLines(lines, { color: process.stdout.isTTY === true }).join('\n') + '\n',
    );

    const cast = toAsciicast(lines);
    if (values.cast !== undefined) {
      await writeFile(resolve(values.cast), cast, 'utf8');
      process.stderr.write(`cast written: ${values.cast}\n`);
    }
    if (values.gif !== undefined) {
      const castFile = join(workdir, 'demo.cast');
      await writeFile(castFile, cast, 'utf8');
      execFileSync('agg', ['--font-size', '16', castFile, resolve(values.gif)], {
        stdio: 'inherit',
      });
      process.stderr.write(`gif written: ${values.gif}\n`);
    }
    return EXIT_OK;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

function isEntryPoint(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `record-demo: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = EXIT_CONFIG;
    },
  );
}
