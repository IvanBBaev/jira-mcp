#!/usr/bin/env node
/**
 * verify-live — drive the BUILT server against a real Jira Cloud site.
 *
 * This is the automatable half of the Gate C runbook (docs/ai/gate-c.md). It is
 * a development script, not shipped code: it is absent from the `files`
 * allowlist and from the tarball assertion, and nothing under src/ imports it.
 *
 * What it is for. The unit suite runs behind a network fence against fixtures,
 * so it can only prove that the client does what we believe Jira wants. Gate C
 * asks the other question — does Jira agree? Every check below is written as a
 * named CLAIM with a PASS/FAIL/SKIP verdict, so the run's output is the gate's
 * evidence rather than a wall of prose.
 *
 * How it talks to the server. Exactly like `src/index.test.ts`: the compiled
 * entry is spawned as a child process and driven over real stdio with the MCP
 * SDK client. Nothing here reaches for `fetch` — `core/http.ts` remains the only
 * module that knows what the network is, and this script only ever sees tool
 * results. That also means the run exercises the shipped assembly (bin entry,
 * transport, registry, gate), not an in-process shortcut.
 *
 * Safety rules, in order of how much they matter:
 *
 *   1. **No credentials, no run.** With JIRA_SITE / JIRA_EMAIL /
 *      JIRA_API_TOKEN absent the script prints the runbook pointer and exits 0.
 *      It can never wander onto a site by accident.
 *   2. **Reads by default.** The write phase needs `--write`, the delete phase
 *      needs `--irreversible`. Neither is implied by the other.
 *   3. **Writes touch only what this script created.** The write phase creates
 *      one throwaway issue and confines every mutation to it. The exceptions are
 *      project- or board-scoped by Jira's own API: `jira_create_version` /
 *      `jira_create_component` (named with the run id, the version archived
 *      again on the way out) and `jira_create_sprint` (named with the run id,
 *      started and closed so it does not sit on the backlog). **The sprint
 *      cannot be removed** — this server ships no sprint delete, on purpose —
 *      so `--write` leaves one behind and the run says so at the end.
 *   4. **Deletes come last**, and only against the throwaway issue.
 *
 * Write mode is a server setting, not a per-call one, so each phase gets its own
 * child server: plan, apply, apply-without-the-irreversible-opt-in, and
 * apply-with-it. That split is also what proves the gate — a plan_id is
 * in-memory and dies with its process (D14), so a plan must be applied by the
 * same child that issued it.
 *
 * Usage:
 *   node scripts/verify-live.mjs --project SCRATCH
 *   node scripts/verify-live.mjs --project SCRATCH --write
 *   node scripts/verify-live.mjs --project SCRATCH --write --irreversible
 *
 * Exit codes: 0 = no claim failed (skips are fine), 1 = at least one FAIL,
 * 2 = usage or setup error (no build, bad flags).
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const RUNBOOK = 'docs/ai/gate-c.md';

/** One tool call's ceiling. Generous: a cold Jira Cloud site is slow. */
const CALL_TIMEOUT_MS = 90_000;

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_CONFIG = 2;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const USAGE = `verify-live — drive the built server against a real Jira Cloud site.

Usage: node scripts/verify-live.mjs [flags]

Flags:
  --project <KEY>     Project used for reads and for the throwaway issue.
  --project2 <KEY>    Second project, of the other type, for read comparison.
  --issue <KEY>       Rich-ADF sample issue for the read claims.
                      Defaults to the first issue found in --project.
  --issue-type <NAME> Issue type for the throwaway issue (default: Task).
  --user2 <ID>        Second user's accountId, for watcher/assign claims.
                      Defaults to the authenticated user.
  --write             Run the write phase (creates ONE throwaway issue, and
                      ONE throwaway sprint that no tool here can delete).
  --irreversible      Run the delete phase (deletes the throwaway issue).
  --record <DIR>      Write redacted per-claim result JSON into DIR.
  --keep              Do not delete the throwaway issue even with --irreversible.
  --help              Print this text.

Environment (all three required, or the script exits 0 without doing anything):
  JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN

Full runbook: ${RUNBOOK}
`;

/** @returns {{ values: Record<string, string | boolean | undefined> }} */
function readFlags() {
  return parseArgs({
    args: process.argv.slice(2),
    options: {
      project: { type: 'string' },
      project2: { type: 'string' },
      issue: { type: 'string' },
      'issue-type': { type: 'string', default: 'Task' },
      user2: { type: 'string' },
      write: { type: 'boolean', default: false },
      irreversible: { type: 'boolean', default: false },
      record: { type: 'string' },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
}

// ---------------------------------------------------------------------------
// Claim ledger
// ---------------------------------------------------------------------------

/** Thrown by a claim body that cannot run — reported SKIP, never FAIL. */
class Skipped extends Error {}

function skip(why) {
  throw new Skipped(why);
}

/** @type {{ id: string, title: string, status: string, note: string }[]} */
const ledger = [];

const STATUS_LABEL = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP' };

/**
 * Run one claim and record its verdict. A claim body returns a short note for
 * the report, throws `Skipped` to skip, or throws anything else to fail.
 *
 * Failures never stop the run: an operator repairing a scratch site wants the
 * whole picture in one pass, which is the same rule the doctor CLI follows.
 */
async function claim(id, title, body) {
  try {
    const note = await body();
    ledger.push({ id, title, status: 'PASS', note: note ?? '' });
  } catch (error) {
    if (error instanceof Skipped) {
      ledger.push({ id, title, status: 'SKIP', note: error.message });
      return;
    }
    ledger.push({ id, title, status: 'FAIL', note: messageOf(error) });
  }
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Server sessions
// ---------------------------------------------------------------------------

/**
 * Variables the child needs but that this script has no opinion about. The
 * environment below is otherwise built from nothing, which is the point — but
 * "nothing" was too literal:
 *
 *   - `NODE_EXTRA_CA_CERTS` — an operator behind a TLS-inspecting corporate
 *     proxy cannot complete a single request without it. Dropping it made Gate C
 *     unrunnable on exactly the machines most likely to be running it.
 *   - `JIRA_ALLOWED_HOSTS` — required for any site that is not on the canonical
 *     `.atlassian.net` suffix.
 *   - `JIRA_JOURNAL_PATH` — the runbook tells the operator to set it for an
 *     independent record of every executed write; without the passthrough that
 *     instruction was inert.
 *   - `JIRA_LOG_LEVEL` — likewise, the runbook's "re-run with debug" step.
 *   - `NODE_OPTIONS` — how `scripts/rehearse-live.mjs` reaches the fake, and how
 *     an operator would attach a profiler or a heap limit.
 *
 * Credentials are still never inherited: JIRA_SITE / JIRA_EMAIL /
 * JIRA_API_TOKEN come only from `credentials`, and HOME / XDG_CONFIG_HOME still
 * point at an empty temporary directory so a developer `.env` on this machine
 * cannot be the thing that supplies them.
 */
const PASSTHROUGH = [
  'JIRA_ALLOWED_HOSTS',
  'JIRA_JOURNAL_PATH',
  'JIRA_MEDIA_DIR',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  // Proxy configuration, for the same reason as the CA bundle.
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];

/**
 * A deliberately minimal child environment. HOME and XDG point at an empty
 * temporary directory, so a developer `.env` on this machine can never be the
 * thing that supplies credentials — only what is passed here.
 */
function childEnv(home, credentials, overrides) {
  const env = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    TZ: 'UTC',
    JIRA_SITE: credentials.site,
    JIRA_EMAIL: credentials.email,
    JIRA_API_TOKEN: credentials.token,
    JIRA_LOG_LEVEL: process.env['JIRA_LOG_LEVEL'] ?? 'info',
  };
  // The attachment tools refuse with `config` unless the server itself has a
  // media directory — the script writing the file is not enough, the child has
  // to be told where to look. Same shape for every other passthrough: present
  // and non-empty, or absent entirely.
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return { ...env, ...overrides };
}

/**
 * Spawn the built server, run `body` against it, then close it. Mirrors
 * `startServer` in src/index.test.ts — including attaching the stderr listener
 * before the process starts, because the startup report is written within
 * milliseconds of spawn and a later listener would race it.
 */
async function withServer(credentials, overrides, body) {
  const home = await mkdtemp(join(tmpdir(), 'jira-mcp-verify-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: home,
    stderr: 'pipe',
    env: childEnv(home, credentials, overrides),
  });

  let stderr = '';
  const sink = (chunk) => {
    stderr += chunk.toString('utf8');
  };
  const attachedEarly = transport.stderr !== undefined && transport.stderr !== null;
  if (attachedEarly) transport.stderr.on('data', sink);

  const client = new Client({ name: 'jira-mcp-verify-live', version: '0.0.0' });
  await client.connect(transport);
  if (!attachedEarly) transport.stderr?.on('data', sink);

  const session = { client, stderr: () => stderr };
  try {
    return await body(session);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
}

/** The media directory, or undefined when the attachment claims cannot run. */
function mediaDir() {
  const value = process.env['JIRA_MEDIA_DIR'];
  return value === undefined || value === '' ? undefined : value;
}

/** A promise with a deadline. `AbortSignal.timeout` is banned repo-wide. */
async function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}: no answer within ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** State captured for the fixture recorder, when `--record` is on. */
const recorded = [];
let recordingFor = '-';

/**
 * Call one tool and return its envelope. `structuredContent` is the byte-clean
 * envelope; the text block carries the same JSON but is prefixed in plan mode
 * and wrapped when the result is branded `_untrusted`, so it is the wrong thing
 * to parse.
 */
async function call(session, name, args = {}) {
  const result = await withTimeout(
    session.client.callTool({ name, arguments: args }),
    CALL_TIMEOUT_MS,
    name,
  );
  const envelope = result.structuredContent;
  if (envelope === undefined || envelope === null) {
    throw new Error(`${name}: no structuredContent in the result`);
  }
  recorded.push({ claim: recordingFor, tool: name, args, envelope });
  return envelope;
}

/** Assert `ok: true` and hand back `data`. */
function dataOf(envelope, name) {
  if (envelope.ok !== true) {
    const error = envelope.error ?? {};
    throw new Error(
      `${name} returned ok:false (kind=${String(error.kind)}): ${String(error.message)}`,
    );
  }
  if (envelope.data === undefined) throw new Error(`${name}: ok:true with no data`);
  return envelope.data;
}

/**
 * Like `dataOf`, but treats the named error kinds as a missing precondition
 * rather than a defect.
 *
 * A brand-new scratch site is very often Jira Work Management only, and then
 * every `/rest/agile/1.0` call answers 403. The server maps that to
 * `kind: unsupported` with a remediation that names the licence — which is the
 * correct behaviour, and is exactly what the agile claims are supposed to prove.
 * Reporting FAIL for it would put a red line in the gate's evidence for
 * something that is a property of the site, not of the code, and would send the
 * owner looking for a bug that is not there.
 */
function dataOrSkip(envelope, name, skippable) {
  if (envelope.ok === false) {
    const error = envelope.error ?? {};
    if (skippable.includes(error.kind)) {
      skip(`${name}: ${String(error.kind)} on this site — ${String(error.message)}`);
    }
  }
  return dataOf(envelope, name);
}

/** Assert `ok: false` with the expected kind, and hand back the error record. */
function errorOf(envelope, name, expectedKind) {
  if (envelope.ok !== false) {
    throw new Error(`${name}: expected ok:false (${expectedKind}), got ok:true`);
  }
  const error = envelope.error ?? {};
  if (error.kind !== expectedKind) {
    throw new Error(
      `${name}: expected kind=${expectedKind}, got kind=${String(error.kind)}`,
    );
  }
  return error;
}

/**
 * Plan a write, then apply it with the plan_id the plan issued.
 *
 * The apply repeats the plan's arguments byte for byte: the server stores a
 * fingerprint of tool name + normalized arguments under the plan_id, so drifted
 * arguments are refused even with the right id (D14).
 */
async function planAndApply(session, name, args) {
  const plan = dataOf(await call(session, name, args), `${name} (plan)`);
  if (plan.executed !== false) {
    throw new Error(`${name}: plan did not report executed:false`);
  }
  const planId = plan.plan_id;
  if (typeof planId !== 'string' || planId === '') {
    throw new Error(`${name}: plan carried no plan_id`);
  }
  const applied = dataOf(
    await call(session, name, { ...args, apply: true, plan_id: planId }),
    `${name} (apply)`,
  );
  return { plan, applied };
}

/**
 * Like `planAndApply`, but treats the named error kinds ON THE APPLY as a
 * missing precondition rather than a defect.
 *
 * Only the sprint state changes use it. "Start" and "close" have preconditions
 * that live on the site, not in the request — a board that already has an active
 * sprint refuses a second one, and a sprint that is not `active` cannot be
 * closed. Jira answers both with a generic HTTP 400, which the server maps to
 * `kind: validation` and re-aims with SPRINT_START_REMEDIATION /
 * SPRINT_CLOSE_REMEDIATION. That is the server behaving correctly, so it SKIPs
 * with the remediation quoted, exactly as an unlicensed agile surface does.
 *
 * The plan half is never skippable: a plan touches no network, so a failure
 * there is ours.
 */
async function planAndApplyOrSkip(session, name, args, skippable) {
  const plan = dataOf(await call(session, name, args), `${name} (plan)`);
  const planId = plan.plan_id;
  if (typeof planId !== 'string' || planId === '') {
    throw new Error(`${name}: plan carried no plan_id`);
  }
  const envelope = await call(session, name, { ...args, apply: true, plan_id: planId });
  return { plan, applied: dataOrSkip(envelope, `${name} (apply)`, skippable) };
}

/** Plan a write without applying it — used for the wire-shape assertions. */
async function planOnly(session, name, args) {
  const plan = dataOf(await call(session, name, args), `${name} (plan)`);
  if (plan.planned === undefined) {
    throw new Error(`${name}: plan carried no 'planned' request preview`);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Fixture recording (--record)
// ---------------------------------------------------------------------------

/**
 * Redact a recorded scenario capture.
 *
 * This is deliberately NOT the fixture recorder TESTING.md specifies. That one
 * has to capture RAW Jira responses, which only exist inside `core/http.ts` —
 * out of reach from this side of the pipe. What is recorded here is the
 * tool-level envelope: useful as a scenario transcript and as raw material for
 * hand-written fixtures, but it must never be dropped into `test/fixtures/`
 * unreviewed, because the shapes have already been through `api/*` mapping.
 *
 * The redaction below is a coarse net over the placeholder vocabulary the
 * fixture PII lint enforces. It is a starting point for review, not a
 * substitute for it.
 */
/**
 * Every spelling of the site that could appear in a captured envelope. The old
 * derivation was `[site, `${site}.atlassian.net`]`, which produces
 * `https://scratch.atlassian.net.atlassian.net` for the usual URL form — a
 * string that occurs nowhere — and never yields the bare hostname at all.
 *
 * @param {string | undefined} site
 * @returns {string[]}
 */
function siteAliases(site) {
  if (site === undefined || site === '') return [];
  const aliases = [site];
  let host = site;
  try {
    host = new URL(site.includes('://') ? site : `https://${site}`).hostname;
    aliases.push(host, `https://${host}`);
  } catch {
    // Not URL-shaped; fall through to the shorthand rule below.
  }
  // The server appends the canonical suffix to a dot-less name, so `scratch`
  // reaches the wire — and therefore the capture — as `scratch.atlassian.net`.
  if (!host.includes('.')) aliases.push(`${host}.atlassian.net`);
  return aliases.filter((value) => value !== '');
}

function buildRedactor(credentials) {
  const emails = new Map();
  const accounts = new Map();
  const names = new Map();

  // Whatever the operator typed for JIRA_SITE, plus the hostname the server
  // actually resolved it to. `credentials.site` may be a full URL
  // (`https://scratch.atlassian.net`), a bare host, or a dot-less shorthand
  // (`scratch`) that the server expands. Longest first, so replacing the URL
  // form cannot leave a bare hostname behind — and so a short shorthand never
  // eats a prefix of the long form.
  const hosts = [...new Set(siteAliases(credentials.site))].sort(
    (a, b) => b.length - a.length,
  );

  // Literals we know by value. Pattern matching is a net, not a proof:
  // Atlassian's own documented accountId (`5b10a2844c20165700ede21g`) is not
  // pure hex, so a `[0-9a-f]{24}` pattern silently misses it. Whatever this run
  // actually learned gets redacted by identity, regardless of shape.
  const isSecret = (value) => typeof value === 'string' && value.length >= 6;
  const knownAccounts = [found.accountId, found.secondAccountId].filter(isSecret);
  // The token should never reach a tool envelope. Belt and braces: this file is
  // the artefact that gets attached to the gate.
  const knownSecrets = [credentials.token].filter(isSecret);

  const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  // Both accountId shapes Atlassian issues: the legacy 24-character opaque id
  // (NOT hex — it is base-36-ish) and the modern `<digits>:<uuid>` form.
  const ACCOUNT =
    /\b\d{4,8}:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-z]{24}\b/gi;

  const stableId = (map, key, make) => {
    const seen = map.get(key);
    if (seen !== undefined) return seen;
    const minted = make(map.size + 1);
    map.set(key, minted);
    return minted;
  };

  const maskCounter = (n) => `5b10a2844c20165700ede2${String(n).padStart(2, '0')}`;
  // A minted placeholder is itself 24 characters of [0-9a-z], so it matches
  // ACCOUNT on the next pass. Without this guard every masked id gets masked
  // again and the counter drifts — the capture stays consistent, but only by
  // accident. Same guard as scripts/record-fixture.mjs.
  const maskAccount = (id) =>
    /^5b10a2844c20165700ede2\d{2}$/.test(id) ? id : stableId(accounts, id, maskCounter);
  // Resolved once: `maskAccount` mints on first call, so calling it per string
  // would burn counters on ids that never appear in that string.
  const knownMasks = knownAccounts.map((id) => [id, maskAccount(id)]);

  const redactString = (value) => {
    let out = value;
    for (const host of hosts) out = out.split(host).join('example.atlassian.net');
    for (const secret of knownSecrets) out = out.split(secret).join('REDACTED');
    out = out.replace(EMAIL, (match) =>
      stableId(emails, match, (n) => `user-${String(n)}@example.invalid`),
    );
    for (const [id, mask] of knownMasks) out = out.split(id).join(mask);
    out = out.replace(ACCOUNT, (match) => maskAccount(match));
    return out;
  };

  const walk = (node, key) => {
    if (typeof node === 'string') {
      if (key === 'displayName') {
        return stableId(names, node, (n) => `User ${String(n)}`);
      }
      return redactString(node);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    }
    return node;
  };

  return (value) => walk(value, undefined);
}

async function writeRecording(dir, credentials) {
  const redact = buildRedactor(credentials);
  const target = resolve(REPO_ROOT, dir);
  await mkdir(target, { recursive: true });
  const document = {
    $note:
      'Redacted scenario capture from scripts/verify-live.mjs. These are ' +
      'tool-level envelopes, NOT raw Jira responses — review before using ' +
      'them as anything. See docs/ai/gate-c.md.',
    recordedAt: new Date().toISOString(),
    calls: redact(recorded),
  };
  const file = join(target, 'verify-live-capture.json');
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// Phase 1 — reads, and the two wire-shape claims (plan mode, nothing mutates)
// ---------------------------------------------------------------------------

/** Shared discoveries that later phases depend on. */
const found = {
  accountId: undefined,
  secondAccountId: undefined,
  issueKey: undefined,
  projectNumericId: undefined,
  styles: [],
};

/** The watcher/assign target: the second user if the site has one, else self. */
function watcherTarget(flags) {
  return flags.user2 ?? found.secondAccountId ?? found.accountId;
}

async function readPhase(session, flags, credentials) {
  await claim('C01', 'handshake: built server answers over stdio', async () => {
    const info = session.client.getServerVersion();
    if (info?.name !== 'jira-mcp-ai') {
      throw new Error(`server named itself ${String(info?.name)}`);
    }
    const listed = await session.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    if (!names.every((name) => name.startsWith('jira_'))) {
      throw new Error('a tool name does not start with jira_');
    }
    return `${String(names.length)} tools, server ${String(info.version)}`;
  });

  await claim('C02', 'jira_capabilities reflects the live configuration', async () => {
    const data = dataOf(await call(session, 'jira_capabilities'), 'jira_capabilities');
    if (data.writeMode !== 'plan') {
      throw new Error(`expected writeMode plan, got ${String(data.writeMode)}`);
    }
    return `site=${String(data.site)} packages=${String(data.packages?.length)}`;
  });

  await claim('C03', 'jira_get_myself authenticates the API token', async () => {
    const data = dataOf(await call(session, 'jira_get_myself'), 'jira_get_myself');
    if (typeof data.accountId !== 'string' || data.accountId === '') {
      throw new Error('no accountId in the result');
    }
    found.accountId = data.accountId;
    return 'authenticated, accountId captured';
  });

  await claim('C04', 'both project types are visible', async () => {
    const data = dataOf(await call(session, 'jira_list_projects'), 'jira_list_projects');
    const projects = data.projects ?? [];
    if (projects.length === 0) throw new Error('no projects returned');
    // `style`/`simplified` are optional in the mapped shape and are dropped when
    // Jira omits them, so their absence is missing evidence, not a failed site.
    const classified = projects.filter((p) => p.simplified !== undefined);
    if (classified.length === 0) {
      skip('Jira returned no style/simplified flags — classify the projects by hand');
    }
    found.styles = [
      ...new Set(classified.map((p) => `${String(p.style)}/${String(p.simplified)}`)),
    ];
    const teamManaged = classified.some((p) => p.simplified === true);
    const companyManaged = classified.some((p) => p.simplified === false);
    if (!teamManaged || !companyManaged) {
      throw new Error(
        `scratch site needs one team-managed AND one company-managed project; ` +
          `saw styles ${found.styles.join(', ')}`,
      );
    }
    return `${String(projects.length)} projects, styles ${found.styles.join(', ')}`;
  });

  await claim('C05', '/search/jql paginates by nextPageToken', async () => {
    const jql = flags.project
      ? `project = ${flags.project} ORDER BY created ASC`
      : 'ORDER BY created ASC';
    const first = dataOf(
      await call(session, 'jira_search', { jql, maxResults: 2 }),
      'jira_search (page 1)',
    );
    if (typeof first.hasMore !== 'boolean') {
      throw new Error('hasMore missing — the loop has no stop condition');
    }
    found.issueKey ??= first.issues?.[0]?.key;
    if (first.hasMore !== true) {
      skip('only one page of results — add more sample issues to page properly');
    }
    if (typeof first.nextPageToken !== 'string') {
      throw new Error('hasMore:true but no nextPageToken');
    }
    const second = dataOf(
      await call(session, 'jira_search', {
        jql,
        maxResults: 2,
        nextPageToken: first.nextPageToken,
      }),
      'jira_search (page 2)',
    );
    const firstKeys = new Set((first.issues ?? []).map((i) => i.key));
    const overlap = (second.issues ?? []).filter((i) => firstKeys.has(i.key));
    if (overlap.length > 0) {
      throw new Error(`page 2 repeated ${String(overlap.length)} issue(s) from page 1`);
    }
    return `page 1 ${String(first.issues?.length)} + page 2 ${String(
      second.issues?.length,
    )}, no overlap`;
  });

  await claim('C06', 'jira_count answers approximately', async () => {
    const jql = flags.project ? `project = ${flags.project}` : 'ORDER BY created ASC';
    const data = dataOf(await call(session, 'jira_count', { jql }), 'jira_count');
    if (typeof data.count !== 'number') throw new Error('no numeric count');
    return `count=${String(data.count)} (approximate=${String(data.approximate)})`;
  });

  await claim('C07', 'jira_get_issue flattens real ADF', async () => {
    const key = flags.issue ?? found.issueKey;
    if (key === undefined) skip('no issue available — pass --issue');
    found.issueKey = key;
    const text = dataOf(
      await call(session, 'jira_get_issue', { issue: key }),
      'jira_get_issue (text)',
    );
    const markdown = dataOf(
      await call(session, 'jira_get_issue', { issue: key, format: 'markdown' }),
      'jira_get_issue (markdown)',
    );
    const raw = dataOf(
      await call(session, 'jira_get_issue', { issue: key, raw: true }),
      'jira_get_issue (raw)',
    );
    if (text === undefined || markdown === undefined || raw === undefined) {
      throw new Error('one of the three formats returned no data');
    }
    return `${key} read in text, markdown and raw ADF`;
  });

  await claim(
    'C08',
    'issue satellites read (comments, transitions, log, work)',
    async () => {
      const key = found.issueKey;
      if (key === undefined) skip('no issue available');
      const tools = [
        'jira_get_comments',
        'jira_get_transitions',
        'jira_get_changelog',
        'jira_get_worklogs',
      ];
      for (const tool of tools) {
        dataOf(await call(session, tool, { issue: key }), tool);
      }
      return tools.length + ' tools green on ' + key;
    },
  );

  await claim('C09', 'metadata reads resolve names to ids', async () => {
    if (flags.project === undefined) skip('no --project');
    const data = dataOf(
      await call(session, 'jira_get_project', { project: flags.project }),
      'jira_get_project',
    );
    // Jira's own id is numeric but arrives as a string here; the version-create
    // body is the one place that needs it back as a number (C15/C22).
    const numericId = data.project?.id;
    if (numericId !== undefined) found.projectNumericId = Number(numericId);
    dataOf(await call(session, 'jira_list_fields'), 'jira_list_fields');
    dataOf(
      await call(session, 'jira_get_create_meta', { project: flags.project }),
      'jira_get_create_meta',
    );
    dataOf(await call(session, 'jira_list_link_types'), 'jira_list_link_types');
    return `project id ${String(found.projectNumericId)}, fields + createmeta + links`;
  });

  await claim('C10', 'jira_search_users finds the second user', async () => {
    // `query` is REQUIRED by the tool schema and the schema is strict, so it has
    // to be present in both shapes — omitting it is a validation error, not a
    // broader search. With `project` also set the search asks for *assignable*
    // users, which is the question the assign and watcher claims depend on.
    // An empty-ish query is the widest net Jira's user search accepts.
    const args =
      flags.project === undefined
        ? { query: 'a' }
        : { query: 'a', project: flags.project };
    const data = dataOf(
      await call(session, 'jira_search_users', args),
      'jira_search_users',
    );
    const users = data.users ?? [];
    if (users.length < 2) {
      throw new Error(
        `expected the scratch site to have a second user, saw ${String(users.length)}`,
      );
    }
    const other = users.find((u) => u.accountId !== found.accountId);
    if (other !== undefined) found.secondAccountId = other.accountId;
    return `${String(users.length)} users, scope=${String(data.scope)}`;
  });

  await claim('C11', 'agile surface reads (boards, sprints, sprint issues)', async () => {
    const boards = dataOrSkip(
      await call(session, 'jira_list_boards', {}),
      'jira_list_boards',
      ['unsupported'],
    );
    const board = (boards.boards ?? [])[0];
    if (board === undefined) skip('no board on the site — create a Scrum board');
    const sprints = dataOf(
      await call(session, 'jira_list_sprints', { boardId: board.id }),
      'jira_list_sprints',
    );
    const sprint = (sprints.sprints ?? [])[0];
    if (sprint === undefined) return `board ${String(board.id)}, no sprints yet`;
    dataOf(
      await call(session, 'jira_get_sprint_issues', { sprintId: sprint.id }),
      'jira_get_sprint_issues',
    );
    return `board ${String(board.id)}, sprint ${String(sprint.id)} read`;
  });

  await claim('C12', 'saved filters read', async () => {
    const data = dataOf(
      await call(session, 'jira_list_filters', {}),
      'jira_list_filters',
    );
    return `${String((data.filters ?? []).length)} filter(s)`;
  });

  // NOT "follows the 303 media-host hop". The client asks for
  // `/attachment/content/{id}?redirect=false`, and for that Jira answers 200
  // with the bytes — no hop. The redirect-following code exists because Jira
  // MAY redirect anyway, but this claim cannot make it do so, and naming the
  // claim after a branch it does not reach would put a false statement in the
  // gate's evidence. What it does prove is the part that matters operationally:
  // bytes land on disk, under the configured media directory, at the size Jira
  // reported. The hop itself is exercised by scripts/rehearse-live.mjs pass B.
  await claim('C13', 'attachment download delivers bytes to JIRA_MEDIA_DIR', async () => {
    const key = found.issueKey;
    if (key === undefined) skip('no issue available');
    const list = dataOf(
      await call(session, 'jira_list_attachments', { issue: key }),
      'jira_list_attachments',
    );
    const attachment = (list.attachments ?? [])[0];
    if (attachment === undefined) {
      skip('sample issue has no attachment — attach a file to it');
    }
    if (mediaDir() === undefined) skip('JIRA_MEDIA_DIR not set — see the runbook');
    const data = dataOf(
      await call(session, 'jira_download_attachment', { attachmentId: attachment.id }),
      'jira_download_attachment',
    );
    if (typeof data.bytes !== 'number' || data.bytes <= 0) {
      throw new Error('download reported no bytes');
    }
    if (typeof data.path !== 'string' || !data.path.startsWith(mediaDir())) {
      throw new Error(
        `download landed at ${String(data.path)}, outside JIRA_MEDIA_DIR ${String(mediaDir())}`,
      );
    }
    if (attachment.size !== undefined && attachment.size !== data.bytes) {
      throw new Error(
        `Jira listed ${String(attachment.size)} bytes but delivered ${String(data.bytes)}`,
      );
    }
    return `${String(data.bytes)} bytes landed at ${String(data.path)}`;
  });

  // The two claims Wave 7 could not settle without a live site. Both are
  // decidable from PLAN mode: the plan carries `planned.body`, which is the
  // exact request that would go on the wire. The apply-side confirmation (that
  // Jira actually accepts these shapes) is C20 and C21 in the write phase.

  await claim('C14', 'watcher add sends a BARE JSON string body', async () => {
    const key = found.issueKey;
    if (key === undefined) skip('no issue available');
    const accountId = watcherTarget(flags);
    if (accountId === undefined) skip('no accountId available');
    const plan = await planOnly(session, 'jira_add_watcher', { issue: key, accountId });
    if (typeof plan.planned.body !== 'string') {
      throw new Error(
        `planned.body is ${typeof plan.planned.body}, expected a bare JSON string ` +
          `(JIRA-API.md §Watcher writes)`,
      );
    }
    return 'planned.body is a bare string, as JIRA-API.md claims';
  });

  await claim('C15', 'version create sends a NUMERIC projectId', async () => {
    if (found.projectNumericId === undefined) skip('no numeric project id — see C09');
    const plan = await planOnly(session, 'jira_create_version', {
      projectId: found.projectNumericId,
      name: `gate-c-${runId()}`,
    });
    const sent = plan.planned.body?.projectId;
    if (typeof sent !== 'number') {
      throw new Error(
        `planned.body.projectId is ${typeof sent}, expected a number (D52)`,
      );
    }
    return `planned.body.projectId is the number ${String(sent)}`;
  });

  await claim('C16', 'diagnostics went to stderr, never to stdout', () => {
    const diagnostics = session.stderr();
    if (!/server_start|settings_report/.test(diagnostics)) {
      throw new Error('no startup event on stderr');
    }
    if (diagnostics.includes(credentials.token)) {
      throw new Error('THE API TOKEN APPEARED IN THE LOG — stop and investigate');
    }
    return 'startup report on stderr, no token in it';
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — writes, against a throwaway issue this script creates
// ---------------------------------------------------------------------------

let RUN_ID;
function runId() {
  RUN_ID ??= `${String(Date.now()).slice(-8)}`;
  return RUN_ID;
}

/**
 * What this run made and is responsible for.
 *
 * `sprintId` is the odd one out: every other entry here is deletable by a tool
 * this server exposes, and the delete phase removes them. A sprint is not —
 * `src/api/agile.ts` deliberately ships no delete, so a sprint created by C27
 * OUTLIVES the run and has to be removed from the Jira UI by hand. The tail of
 * `run()` says so, loudly, with the name.
 */
const created = {
  issueKey: undefined,
  commentId: undefined,
  worklogId: undefined,
  sprintId: undefined,
  sprintName: undefined,
  sprintStarted: false,
};

async function writePhase(session, flags) {
  await claim('C17', 'plan → apply creates the throwaway issue', async () => {
    if (flags.project === undefined) skip('no --project');
    const args = {
      project: flags.project,
      issueType: flags['issue-type'],
      summary: `gate-c verify-live ${runId()} (safe to delete)`,
      description: 'Created by scripts/verify-live.mjs during Gate C. Safe to delete.',
    };
    const { plan, applied } = await planAndApply(session, 'jira_create_issue', args);
    if (plan.planned?.method !== 'POST') {
      throw new Error(`plan previewed ${String(plan.planned?.method)}, expected POST`);
    }
    if (typeof applied.key !== 'string') throw new Error('apply returned no issue key');
    created.issueKey = applied.key;
    return `created ${applied.key}`;
  });

  await claim('C18', 'apply without a plan_id is refused', async () => {
    if (flags.project === undefined) skip('no --project');
    const envelope = await call(session, 'jira_add_comment', {
      issue: created.issueKey ?? flags.project,
      body: 'this must never be posted',
      apply: true,
    });
    const error = errorOf(envelope, 'jira_add_comment', 'write_gated');
    if (!/plan_id/.test(String(error.message))) {
      throw new Error('write_gated message does not name plan_id');
    }
    return 'refused: apply:true alone never executes';
  });

  await claim('C19', 'a drifted apply is refused (fingerprint binding)', async () => {
    const key = created.issueKey;
    if (key === undefined) skip('no throwaway issue');
    const args = { issue: key, body: 'fingerprint probe — original text' };
    const plan = dataOf(await call(session, 'jira_add_comment', args), 'plan');
    const envelope = await call(session, 'jira_add_comment', {
      ...args,
      body: 'fingerprint probe — DRIFTED text',
      apply: true,
      plan_id: plan.plan_id,
    });
    errorOf(envelope, 'jira_add_comment', 'write_gated');
    return 'refused: arguments changed between plan and apply';
  });

  await claim('C20', 'standard writes land on the throwaway issue', async () => {
    const key = created.issueKey;
    if (key === undefined) skip('no throwaway issue');
    const comment = await planAndApply(session, 'jira_add_comment', {
      issue: key,
      body: 'Gate C verification comment.',
    });
    created.commentId = comment.applied.id;

    await planAndApply(session, 'jira_update_issue', {
      issue: key,
      labels: ['gate-c'],
    });

    const worklog = await planAndApply(session, 'jira_add_worklog', {
      issue: key,
      timeSpent: '1m',
    });
    created.worklogId = worklog.applied.id;

    if (found.accountId !== undefined) {
      await planAndApply(session, 'jira_assign_issue', {
        issue: key,
        accountId: found.accountId,
      });
    }
    return 'comment, labels, worklog and assignee applied';
  });

  await claim('C21', 'watcher add is ACCEPTED with the bare string body', async () => {
    const key = created.issueKey;
    if (key === undefined) skip('no throwaway issue');
    const accountId = watcherTarget(flags);
    if (accountId === undefined) skip('no accountId available');
    await planAndApply(session, 'jira_add_watcher', { issue: key, accountId });
    const watchers = dataOf(
      await call(session, 'jira_list_watchers', { issue: key }),
      'jira_list_watchers',
    );
    await planAndApply(session, 'jira_remove_watcher', { issue: key, accountId });
    // An empty list with `watchersVisible: false` means the token lacks the
    // "view voters and watchers" permission — the roster is withheld, not empty.
    // Jira accepting the POST is what proves the body shape either way.
    if (watchers.watchersVisible === false) {
      return 'Jira accepted the bare string; roster withheld, so unverified by read';
    }
    if (!(watchers.watchers ?? []).some((w) => w.accountId === accountId)) {
      throw new Error('Jira took the request but the watcher is not on the issue');
    }
    return 'Jira accepted the bare string; watcher observed then removed';
  });

  await claim(
    'C22',
    'version create is ACCEPTED with the numeric projectId',
    async () => {
      if (found.projectNumericId === undefined) skip('no numeric project id');
      const name = `gate-c-${runId()}`;
      const { applied } = await planAndApply(session, 'jira_create_version', {
        projectId: found.projectNumericId,
        name,
      });
      const versionId = applied.version?.id;
      if (versionId === undefined) throw new Error('create returned no version id');
      // Jira sends version ids back as strings; `jira_update_version` wants a
      // number. Getting this wrong is a validation error AFTER the version
      // already exists, which leaves named litter on the scratch project.
      const numericVersionId = Number(versionId);
      if (!Number.isInteger(numericVersionId)) {
        throw new Error(`version id ${String(versionId)} is not an integer`);
      }
      await planAndApply(session, 'jira_update_version', {
        versionId: numericVersionId,
        archived: true,
      });
      return `version ${String(versionId)} created and archived again`;
    },
  );

  await claim('C23', 'multipart upload carries X-Atlassian-Token: no-check', async () => {
    const key = created.issueKey;
    if (key === undefined) skip('no throwaway issue');
    const dir = mediaDir();
    if (dir === undefined) skip('JIRA_MEDIA_DIR not set — see the runbook');
    // An upload names a file that must ALREADY be inside JIRA_MEDIA_DIR — the
    // server never reads from anywhere else, so the script stages it there.
    const name = `gate-c-${runId()}.txt`;
    await writeFile(join(dir, name), `Gate C upload probe ${runId()}\n`);
    await planAndApply(session, 'jira_upload_attachment', { issue: key, name });
    const list = dataOf(
      await call(session, 'jira_list_attachments', { issue: key }),
      'jira_list_attachments',
    );
    if (!(list.attachments ?? []).some((a) => a.filename === name)) {
      throw new Error('upload reported success but the file is not on the issue');
    }
    return `${name} uploaded and observed on ${key}`;
  });

  await agileWriteClaims(session);
}

// ---------------------------------------------------------------------------
// Phase 2b — the agile write surface
// ---------------------------------------------------------------------------

/**
 * The agile writes: create a sprint, move an issue in and back out, start it,
 * close it.
 *
 * Why this is its own block. `/rest/agile/1.0` is a different API behind a
 * different licence with different paging, and it is the one write surface whose
 * preconditions are properties of the SITE rather than of the request. Three
 * things follow, and every claim below is shaped by them:
 *
 *   1. **Licence.** A site without Jira Software answers 403 for the whole root.
 *      The server maps that to `kind: unsupported` (CC-34), so each claim starts
 *      at the same board probe C11 uses and SKIPs on it. A gate run on a Work
 *      Management site must stay green.
 *   2. **State.** A board that already has an active sprint refuses a second
 *      one; a sprint that is not active cannot be closed. Both are HTTP 400 →
 *      `kind: validation` with a re-aimed remediation, and both SKIP.
 *   3. **No delete.** This server exposes no way to remove a sprint, on purpose.
 *      C27 therefore leaves one behind on the site, permanently, and says so in
 *      its own note as well as at the end of the run.
 */
async function agileWriteClaims(session) {
  await claim(
    'C27',
    'agile writes: plan → apply creates a throwaway sprint',
    async () => {
      const boards = dataOrSkip(
        await call(session, 'jira_list_boards', {}),
        'jira_list_boards',
        ['unsupported'],
      );
      // Only a Scrum board owns sprints. Prefer one; if the site has only another
      // kind, still try — a refusal is informative — but name the type in the note
      // so a FAIL is not mistaken for a client bug.
      const all = boards.boards ?? [];
      const board = all.find((b) => b.type === 'scrum') ?? all[0];
      if (board === undefined) skip('no board on the site — create a Scrum board (1.3)');

      const name = `gate-c-${runId()} (safe to delete)`;
      const { plan, applied } = await planAndApply(session, 'jira_create_sprint', {
        name,
        originBoardId: board.id,
      });
      // The agile analogue of C15/C22: `originBoardId` travels as a NUMBER, while
      // most ids in the v3 API are strings. Checking the plan's own preview
      // localises a regression to the client instead of to Jira's 400.
      const sentBoardId = plan.planned?.body?.originBoardId;
      if (typeof sentBoardId !== 'number') {
        throw new Error(
          `planned.body.originBoardId is ${typeof sentBoardId}, expected a number`,
        );
      }
      const sprint = applied.sprint;
      if (typeof sprint?.id !== 'number') throw new Error('create returned no sprint id');
      if (sprint.state !== undefined && sprint.state !== 'future') {
        throw new Error(
          `a new sprint reported state ${String(sprint.state)}, expected future`,
        );
      }
      created.sprintId = sprint.id;
      created.sprintName = name;
      return (
        `sprint ${String(sprint.id)} on ${String(board.type ?? 'unknown-type')} board ` +
        `${String(board.id)} — NO TOOL HERE CAN DELETE A SPRINT: "${name}" stays on the ` +
        `site until you remove it by hand (Backlog → sprint → Delete)`
      );
    },
  );

  await claim(
    'C28',
    'an issue moves into the sprint and back to the backlog',
    async () => {
      const key = created.issueKey;
      const sprintId = created.sprintId;
      if (key === undefined) skip('no throwaway issue');
      if (sprintId === undefined) skip('no throwaway sprint — see C27');

      const move = await planAndApply(session, 'jira_move_to_sprint', {
        sprintId,
        issues: [key],
      });
      if (move.applied.sprintId !== sprintId) {
        throw new Error(
          `move echoed sprint ${String(move.applied.sprintId)}, expected ${String(sprintId)}`,
        );
      }
      // `moved` counts what was SENT — the route answers 204 with no body, so this
      // is "Jira accepted one issue", not "Jira confirmed one issue". The read
      // below is what turns it into an observation.
      if (move.applied.moved !== 1) {
        throw new Error(`move reported moved=${String(move.applied.moved)}, expected 1`);
      }
      const inSprint = dataOf(
        await call(session, 'jira_get_sprint_issues', { sprintId }),
        'jira_get_sprint_issues',
      );
      const observed = (inSprint.issues ?? []).some((issue) => issue.key === key);

      await planAndApply(session, 'jira_move_to_backlog', { issues: [key] });
      const after = dataOf(
        await call(session, 'jira_get_sprint_issues', { sprintId }),
        'jira_get_sprint_issues',
      );
      if ((after.issues ?? []).some((issue) => issue.key === key)) {
        throw new Error(
          `${key} is still in sprint ${String(sprintId)} after the backlog move`,
        );
      }
      // Jira's agile reads are index-backed and can lag a write by seconds. A
      // move that was accepted but is not yet visible is not a failure of this
      // client — same reasoning as the withheld watcher roster in C21.
      if (!observed) {
        return `${key} accepted into sprint ${String(sprintId)} and moved back; the sprint read did not show it yet (index lag)`;
      }
      return `${key} observed in sprint ${String(sprintId)}, then back on the backlog`;
    },
  );

  await claim(
    'C29',
    'jira_start_sprint moves the sprint from future to active',
    async () => {
      const sprintId = created.sprintId;
      if (sprintId === undefined) skip('no throwaway sprint — see C27');
      // The documented format: ISO-8601 with an explicit UTC OFFSET. `toISOString`
      // ends in `Z`, which the tool description does not promise Jira accepts, so
      // the offset form is spelled out here rather than assumed.
      const startDate = offsetIso(Date.now());
      const endDate = offsetIso(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const { applied } = await planAndApplyOrSkip(
        session,
        'jira_start_sprint',
        { sprintId, startDate, endDate },
        ['validation'],
      );
      if (applied.state !== 'active') {
        throw new Error(`start reported state ${String(applied.state)}, expected active`);
      }
      created.sprintStarted = true;
      return `sprint ${String(sprintId)} is active, dates sent with an explicit offset`;
    },
  );

  await claim('C30', 'jira_close_sprint completes the sprint (terminal)', async () => {
    const sprintId = created.sprintId;
    if (sprintId === undefined) skip('no throwaway sprint — see C27');
    if (created.sprintStarted !== true) skip('the sprint never started — see C29');
    const { applied } = await planAndApplyOrSkip(
      session,
      'jira_close_sprint',
      { sprintId },
      ['validation'],
    );
    if (applied.state !== 'closed') {
      throw new Error(`close reported state ${String(applied.state)}, expected closed`);
    }
    // Closing is one-way: there is no reopen tool and no delete tool, so the
    // sprint is now a permanent, harmless entry in the board's history.
    return `sprint ${String(sprintId)} closed — terminal, and still not deletable from here`;
  });
}

/**
 * `2026-08-16T09:00:00.000+00:00` — ISO-8601 with an explicit offset.
 *
 * `Date#toISOString` produces the `Z` form. Jira's own examples and the tool
 * description both use an offset, so the offset is what the gate sends; if a
 * site rejects it, that is a finding worth having.
 */
function offsetIso(ms) {
  return new Date(ms).toISOString().replace(/Z$/, '+00:00');
}

// ---------------------------------------------------------------------------
// Phase 3 — the irreversible tier, in both directions
// ---------------------------------------------------------------------------

async function refusalPhase(session) {
  await claim('C24', 'irreversible plan works without the opt-in', async () => {
    const key = created.issueKey;
    if (key === undefined) skip('no throwaway issue');
    const plan = await planOnly(session, 'jira_delete_issue', { issue: key });
    if (plan.before === undefined) {
      throw new Error('plan carried no data.before snapshot of what would be destroyed');
    }
    return 'plan shows the before-state even though the apply is barred';
  });

  await claim('C25', 'apply is REFUSED without JIRA_ALLOW_IRREVERSIBLE', async () => {
    const key = created.issueKey;
    if (key === undefined) skip('no throwaway issue');
    const args = { issue: key };
    const plan = dataOf(await call(session, 'jira_delete_issue', args), 'plan');
    const envelope = await call(session, 'jira_delete_issue', {
      ...args,
      apply: true,
      plan_id: plan.plan_id,
    });
    const error = errorOf(envelope, 'jira_delete_issue', 'write_gated');
    if (!/JIRA_ALLOW_IRREVERSIBLE/.test(String(error.remediation ?? error.message))) {
      throw new Error('the refusal does not name JIRA_ALLOW_IRREVERSIBLE');
    }
    return 'refused locally, nothing reached the network';
  });
}

async function deletePhase(session) {
  await claim('C26', 'deletes execute with the opt-in on', async () => {
    const key = created.issueKey;
    if (key === undefined) skip('no throwaway issue');

    if (created.worklogId !== undefined) {
      await planAndApply(session, 'jira_delete_worklog', {
        issue: key,
        worklogId: String(created.worklogId),
      });
    }
    if (created.commentId !== undefined) {
      await planAndApply(session, 'jira_delete_comment', {
        issue: key,
        commentId: String(created.commentId),
      });
    }
    const { applied } = await planAndApply(session, 'jira_delete_issue', { issue: key });
    if (applied.before === undefined) {
      throw new Error('the apply did not echo the before-state snapshot');
    }
    created.issueKey = undefined;
    return `${key} and its comment/worklog deleted, snapshot echoed`;
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report() {
  const width = Math.max(...ledger.map((row) => row.title.length), 0);
  const lines = ['', 'Gate C — live verification', ''];
  for (const row of ledger) {
    const title = row.title.padEnd(width);
    const note = row.note === '' ? '' : `  — ${row.note}`;
    lines.push(`  ${STATUS_LABEL[row.status]}  ${row.id}  ${title}${note}`);
  }
  const failed = ledger.filter((row) => row.status === 'FAIL');
  const skipped = ledger.filter((row) => row.status === 'SKIP');
  const passed = ledger.length - failed.length - skipped.length;
  lines.push(
    '',
    `  ${String(passed)} passed, ${String(failed.length)} failed, ` +
      `${String(skipped.length)} skipped`,
    '',
  );
  return { text: lines.join('\n'), failed: failed.length };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function run() {
  let flags;
  try {
    flags = readFlags().values;
  } catch (error) {
    console.error(`verify-live: ${messageOf(error)}\n\n${USAGE}`);
    return EXIT_CONFIG;
  }

  if (flags.help === true) {
    console.log(USAGE);
    return EXIT_OK;
  }

  // Named explicitly rather than derived from the keys: the env var is
  // JIRA_API_TOKEN, and an error message that invents a JIRA_TOKEN sends the
  // reader looking for a variable that does not exist.
  const CREDENTIAL_VARS = [
    ['site', 'JIRA_SITE'],
    ['email', 'JIRA_EMAIL'],
    ['token', 'JIRA_API_TOKEN'],
  ];
  const credentials = Object.fromEntries(
    CREDENTIAL_VARS.map(([key, name]) => [key, process.env[name]]),
  );
  const missing = CREDENTIAL_VARS.filter(
    ([key]) => credentials[key] === undefined || credentials[key] === '',
  ).map(([, name]) => name);

  if (missing.length > 0) {
    // The whole point of this branch: with no credentials in the environment the
    // script is inert. It does not prompt, it does not read a .env, it does not
    // guess a site — it points at the runbook and leaves.
    console.log(
      `verify-live: ${missing.join(', ')} not set — nothing to verify against.\n` +
        `This script only ever runs against a site you name explicitly in the\n` +
        `environment. Set up the scratch site first: ${RUNBOOK}\n`,
    );
    return EXIT_OK;
  }

  if (!existsSync(SERVER_ENTRY)) {
    console.error(
      'verify-live: build/index.js is missing. Run `npm run build` first — this\n' +
        'script drives the COMPILED server, exactly as a client would spawn it.',
    );
    return EXIT_CONFIG;
  }

  const site = credentials.site;
  console.error(`verify-live: driving ${site} as ${credentials.email}`);
  console.error(
    `verify-live: phases — read${flags.write === true ? ' + write' : ''}` +
      `${flags.irreversible === true ? ' + delete' : ''}\n`,
  );

  recordingFor = 'read';
  await withServer(credentials, { JIRA_WRITE_MODE: 'plan' }, (session) =>
    readPhase(session, flags, credentials),
  );

  if (flags.write === true) {
    recordingFor = 'write';
    await withServer(credentials, { JIRA_WRITE_MODE: 'apply' }, (session) =>
      writePhase(session, flags),
    );

    recordingFor = 'refusal';
    // A separate child on purpose: the refusal must come from a server that was
    // STARTED without the opt-in, which is the only configuration that proves it.
    await withServer(credentials, { JIRA_WRITE_MODE: 'apply' }, (session) =>
      refusalPhase(session),
    );

    if (flags.irreversible === true && flags.keep !== true) {
      recordingFor = 'delete';
      await withServer(
        credentials,
        { JIRA_WRITE_MODE: 'apply', JIRA_ALLOW_IRREVERSIBLE: 'true' },
        (session) => deletePhase(session),
      );
    }
  }

  const { text, failed } = report();
  console.log(text);

  if (created.issueKey !== undefined) {
    console.error(
      `verify-live: the throwaway issue ${created.issueKey} was NOT deleted.\n` +
        'Re-run with --irreversible, or delete it by hand.\n',
    );
  }

  if (created.sprintId !== undefined) {
    // Not conditional on --irreversible: no run of this script can clean this
    // up. This server exposes no sprint delete, by design, so the only remedy
    // is the Jira UI.
    console.error(
      `verify-live: sprint ${String(created.sprintId)} "${String(created.sprintName)}" is\n` +
        'STILL ON THE SITE. No tool this server exposes can delete a sprint, so\n' +
        '--irreversible does not remove it either. Delete it from the Jira UI:\n' +
        'Backlog → the sprint → ••• → Delete sprint.\n',
    );
  }

  if (typeof flags.record === 'string' && flags.record !== '') {
    const file = await writeRecording(flags.record, credentials);
    console.error(`verify-live: redacted capture written to ${file}`);
  }

  return failed > 0 ? EXIT_FAILURE : EXIT_OK;
}

process.exitCode = await run();
