#!/usr/bin/env node
/**
 * rehearse-datacenter — drive every Data Center tool end to end against the
 * Data Center twin of the fake Jira.
 *
 * `scripts/rehearse-live.mjs` rehearses the Cloud gate; this is its Data Center
 * counterpart for the Data Center adapter (Phase 13, D106–D117). It
 * spawns the built server (`build/index.js`) with
 *
 *   JIRA_DEPLOYMENT=datacenter  JIRA_DATACENTER_PREVIEW=true
 *   JIRA_AUTH_MODE=pat          JIRA_PAT=<the fake's token>
 *   JIRA_MEDIA_DIR=<an empty directory in the workdir>
 *
 * pointed at `scripts/fake-jira.mjs --deployment datacenter`, and over real
 * stdio MCP:
 *
 *   1. lists the tools and requires exactly `DATACENTER_TOOLS` — every tool
 *      Data Center has no route for must be absent;
 *   2. calls each of the twenty-seven served reads and requires `ok: true`
 *      (search is paged twice, through the `dc1:` cursor; the user search,
 *      the role read and the create metadata are each called a second time,
 *      as `also`, so the assignable search, the role map and the create
 *      screen are hit too), plus the one refusal
 *      the adapter promises (`format: "markdown"` → `validation`); the
 *      attachment download (D117) must land the fake's exact bytes in the
 *      media directory and nowhere else;
 *   3. requires that no result carries an email address, an avatar URL or an
 *      `accountId` — the fake sends Data Center's `emailAddress` and
 *      `avatarUrls` on every user, so this proves the server strips them;
 *   4. audits the wire: every request under the context path on `/rest/api/2`,
 *      `/rest/agile/1.0` or the attachment servlet (`/secure/attachment/`),
 *      a PAT Bearer on each, nothing Cloud-only, nothing
 *      unmatched, and every Data Center route the fake serves actually hit;
 *   5. restarts the server with a wrong PAT and requires `kind: auth`.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Like the Cloud rehearsal, it proves
 * the server's plumbing — the v2 root, the context path, PAT auth, the Data
 * Center user allowlist, classic paging, the tool allowlist — against OUR
 * reading of Atlassian's Data Center documentation. It proves nothing about
 * Data Center itself: the shapes only a real host can settle are listed in
 * docs/IMPLEMENTATION-PLAN.md, Phase 13 (13.3b onwards, D108–D115).
 *
 * HOW IT REACHES THE FAKE. Exactly as the Cloud rehearsal does, with nothing
 * added: the fake answers to `jira.rehearsal.test`, which is allowlisted through
 * JIRA_ALLOWED_HOSTS; the child alone gets the shared DNS preload
 * (`REHEARSAL_DNS_PRELOAD` from fake-jira.mjs) through NODE_OPTIONS; the fake's
 * certificate is trusted through NODE_EXTRA_CA_CERTS. The SSRF blocklist and the
 * host policy are untouched. Read-only against Jira (the download writes one
 * file into the workdir's media directory), loopback-only, offline: the D109 writes
 * are listed but not called — their request specs are pinned in-process by
 * src/tools/datacenter-write.test.ts.
 *
 * Usage:
 *   npm run build && node scripts/rehearse-datacenter.mjs [--verbose] [--keep]
 *
 * Exit codes: 0 = every check held, 1 = something regressed, 2 = setup error
 * (no build, no openssl).
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  API_HOST,
  DATACENTER_ROUTES,
  REHEARSAL_DNS_PRELOAD,
  startFakeJira,
} from './fake-jira.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const ADAPTER_ENTRY = join(REPO_ROOT, 'build', 'api', 'datacenter.js');

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CONFIG = 2;

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 30_000;

const PAT = 'rehearsal-pat-not-a-real-secret';
const CONTEXT_PATH = '/jira';
const PROJECT = 'SCRATCH';
const ISSUE = `${PROJECT}-1`;
const BOARD_ID = 1;
const SPRINT_ID = 101;
const FILTER_ID = '10000';
/** The fake's seeded attachment on the sample issue. */
const ATTACHMENT_ID = '60001';

/**
 * One call per served tool, in the order a model would plausibly make them.
 * `jira_search` is paged separately (two pages through the cursor), so it is
 * listed here with its first page only. `also` lists further argument sets for
 * the same tool, called right after it, for a second route behind one tool;
 * `checkAlso: true` runs `stepFindings` on those results too.
 */
export const DATACENTER_PLAN = Object.freeze([
  { tool: 'jira_capabilities', args: {} },
  { tool: 'jira_get_myself', args: {} },
  {
    tool: 'jira_search',
    args: { jql: `project = ${PROJECT} ORDER BY created ASC`, maxResults: 2 },
  },
  { tool: 'jira_get_issue', args: { issue: ISSUE } },
  { tool: 'jira_get_comments', args: { issue: ISSUE } },
  { tool: 'jira_get_transitions', args: { issue: ISSUE } },
  { tool: 'jira_get_worklogs', args: { issue: ISSUE } },
  { tool: 'jira_list_watchers', args: { issue: ISSUE } },
  { tool: 'jira_list_projects', args: {} },
  { tool: 'jira_get_project', args: { project: PROJECT } },
  { tool: 'jira_list_components', args: { project: PROJECT } },
  { tool: 'jira_list_versions', args: { project: PROJECT } },
  { tool: 'jira_list_fields', args: {} },
  { tool: 'jira_list_statuses', args: {} },
  { tool: 'jira_list_link_types', args: {} },
  { tool: 'jira_list_boards', args: {} },
  { tool: 'jira_list_sprints', args: { boardId: BOARD_ID } },
  { tool: 'jira_get_sprint_issues', args: { sprintId: SPRINT_ID } },
  {
    tool: 'jira_search_users',
    args: { query: 'user' },
    also: [{ query: 'user', project: PROJECT }],
  },
  {
    tool: 'jira_list_project_roles',
    args: { project: PROJECT, roleId: '10002' },
    also: [{ project: PROJECT }],
  },
  // D114 (stage 13.6c): the classic-search count, the embedded changelog and
  // the attachment list.
  { tool: 'jira_count', args: { jql: `project = ${PROJECT}` } },
  { tool: 'jira_get_changelog', args: { issue: ISSUE } },
  { tool: 'jira_list_attachments', args: { issue: ISSUE } },
  // D117 (stage 13.8): the attachment download — metadata on v2, bytes from
  // the attachment servlet, written into the child's JIRA_MEDIA_DIR.
  { tool: 'jira_download_attachment', args: { attachmentId: ATTACHMENT_ID } },
  // D115 (stage 13.7a): the favourites list and one filter.
  { tool: 'jira_list_filters', args: {} },
  { tool: 'jira_get_filter', args: { filterId: FILTER_ID } },
  // D116 (stage 13.7b): the create metadata, the issue type list first and
  // then the create screen of the fake's Task type, over the paged 8.4+ routes.
  {
    tool: 'jira_get_create_meta',
    args: { project: PROJECT },
    also: [{ project: PROJECT, issueTypeId: '10001' }],
    checkAlso: true,
  },
]);

// ---------------------------------------------------------------------------
// Pure checkers — exported so the tests can prove each one catches its failure
// ---------------------------------------------------------------------------

/**
 * The tools the plan must cover: every Data Center tool but the writes, which
 * the rehearsal lists and never calls.
 * @param {Iterable<string>} tools
 * @param {ReadonlySet<string>} writes
 * @returns {string[]}
 */
export function dataCenterReads(tools, writes) {
  return [...tools].filter((name) => !writes.has(name));
}

/** Wiki markup that must not survive the flattening of a read. */
const WIKI_MARKUP_SIGNS = ['h2. ', '{{', '[~', '*bold*', '*this*', '[link|'];

/** Anything that looks like an email address. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Keys a Data Center result must never carry after the user allowlist. */
const FORBIDDEN_KEYS = new Set(['accountid', 'emailaddress', 'avatarurls']);

/**
 * What in a tool result would leak identity the server promises to strip: an
 * `accountId` / `emailAddress` / `avatarUrls` key at any depth, an email address
 * in any string, or a Data Center avatar URL (`/secure/useravatar`).
 *
 * @returns {string[]} one line per finding, empty when clean
 */
export function leakFindings(label, value) {
  const findings = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (EMAIL_PATTERN.test(node))
        findings.push(`${label}: an email address at ${path}`);
      if (/useravatar/i.test(node)) findings.push(`${label}: an avatar URL at ${path}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${String(index)}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
          findings.push(`${label}: a "${key}" key at ${path}.${key}`);
        }
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(value, '$');
  return findings;
}

/**
 * What in the recorded traffic breaks the Data Center contract. `requests` are
 * the fake's records; `contextPath` is where the site is mounted.
 *
 * @returns {string[]} one line per finding, empty when clean
 */
export function wireFindings(requests, contextPath, routes = DATACENTER_ROUTES) {
  const findings = [];
  const roots = [
    `${contextPath}/rest/api/2/`,
    `${contextPath}/rest/agile/1.0/`,
    // D117: the attachment servlet, and only its attachment path.
    `${contextPath}/secure/attachment/`,
  ];
  for (const request of requests) {
    const line = `${request.method} ${request.path}`;
    if (!roots.some((root) => request.path.startsWith(root))) {
      findings.push(
        `${line}: outside ${contextPath}/rest/api/2, /rest/agile/1.0 and /secure/attachment`,
      );
    }
    if (request.cloudOnly !== undefined) {
      findings.push(`${line}: Cloud-only — ${request.cloudOnly}`);
    }
    if (request.outsideContextPath === true) {
      findings.push(`${line}: outside the context path ${contextPath}`);
    }
    if (request.unmatched === true) findings.push(`${line}: no Data Center route`);
    if (request.authFailure !== undefined) {
      findings.push(`${line}: authentication failed — ${request.authFailure}`);
    }
    if (request.authScheme !== 'Bearer') {
      findings.push(
        `${line}: sent ${String(request.authScheme ?? 'no')} credentials, not a PAT Bearer`,
      );
    }
    if (request.handlerError !== undefined) {
      findings.push(`${line}: the fake's handler crashed — ${request.handlerError}`);
    }
    if (request.violation !== undefined) findings.push(`${line}: ${request.violation}`);
  }
  const hit = new Set(requests.map((request) => request.route));
  for (const route of routes) {
    if (!hit.has(route)) findings.push(`${route}: never called`);
  }
  return findings;
}

/**
 * What is wrong with one attachment download (D117): the file must be the
 * fake's exact bytes, and it must sit directly inside the media directory.
 * `actual` is what the file at `data.path` holds, or `undefined` when it could
 * not be read; `mediaDir` and the directory of `data.path` are compared as the
 * caller resolved them (through realpath).
 *
 * @param {{path?: unknown, name?: unknown, bytes?: unknown}} data
 * @param {{mediaDir: string, fileDir: string | undefined,
 *   expected: Uint8Array, actual: Uint8Array | undefined}} disk
 * @returns {string[]} one line per finding, empty when clean
 */
export function downloadFindings(data, disk) {
  const findings = [];
  if (typeof data.path !== 'string' || typeof data.name !== 'string') {
    return ['jira_download_attachment: no path or name came back'];
  }
  if (disk.fileDir !== disk.mediaDir) {
    findings.push(
      `jira_download_attachment: the file landed in ${String(disk.fileDir)}, not the media directory ${disk.mediaDir}`,
    );
  }
  if (disk.actual === undefined) {
    findings.push(`jira_download_attachment: ${data.path} could not be read back`);
    return findings;
  }
  if (Buffer.compare(Buffer.from(disk.actual), Buffer.from(disk.expected)) !== 0) {
    findings.push(
      `jira_download_attachment: the file holds ${String(disk.actual.byteLength)} bytes that are not the attachment's ${String(disk.expected.byteLength)}`,
    );
  }
  if (data.bytes !== disk.expected.byteLength) {
    findings.push(
      `jira_download_attachment: reported ${JSON.stringify(data.bytes)} bytes, expected ${String(disk.expected.byteLength)}`,
    );
  }
  return findings;
}

/**
 * The difference between the tools the server listed and the ones it should
 * serve on Data Center — both directions, so a missing read and a leaked write
 * are each named.
 *
 * @returns {string[]} one line per finding, empty when the sets match
 */
export function toolListFindings(listed, expected) {
  const have = new Set(listed);
  const want = new Set(expected);
  const findings = [];
  for (const name of [...want].sort()) {
    if (!have.has(name)) findings.push(`${name}: served on Data Center but not listed`);
  }
  for (const name of [...have].sort()) {
    if (!want.has(name)) findings.push(`${name}: listed, but not a Data Center tool`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The server under test
// ---------------------------------------------------------------------------

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

/**
 * The child's environment, built from nothing: no `process.env` spread, so a
 * developer's JIRA_EMAIL / JIRA_API_TOKEN / .env can never leak in and turn
 * this into a Cloud run, and HOME points at an empty directory.
 */
export function dataCenterChildEnv({ home, site, pat, certFile, preloadUrl, mediaDir }) {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    TZ: 'UTC',
    JIRA_SITE: site,
    JIRA_DEPLOYMENT: 'datacenter',
    JIRA_DATACENTER_PREVIEW: 'true',
    JIRA_AUTH_MODE: 'pat',
    JIRA_PAT: pat,
    JIRA_ALLOWED_HOSTS: API_HOST,
    JIRA_LOG_LEVEL: 'warn',
    ...(mediaDir === undefined ? {} : { JIRA_MEDIA_DIR: mediaDir }),
    NODE_EXTRA_CA_CERTS: certFile,
    NODE_OPTIONS: `--import ${preloadUrl}`,
  };
}

async function withServer(env, body, entry = SERVER_ENTRY) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } =
    await import('@modelcontextprotocol/sdk/client/stdio.js');
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: env.HOME,
    stderr: 'pipe',
    env,
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  try {
    const client = new Client({ name: 'jira-mcp-rehearse-datacenter', version: '0.0.0' });
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'server start');
    } catch (error) {
      const tail = stderr.trim().slice(-400);
      throw new Error(
        `${String(error instanceof Error ? error.message : error)}${tail === '' ? '' : ` — server stderr: ${tail}`}`,
        { cause: error },
      );
    }
    return await body({
      client,
      async call(name, args = {}) {
        const result = await withTimeout(
          client.callTool({ name, arguments: args }),
          CALL_TIMEOUT_MS,
          name,
        );
        const envelope = result.structuredContent;
        if (envelope === undefined || envelope === null) {
          throw new Error(`${name}: no structuredContent in the result`);
        }
        return envelope;
      },
    });
  } finally {
    try {
      await transport.close();
    } catch {
      // A child that is already gone is the outcome we wanted.
    }
  }
}

function describeError(envelope) {
  const error = envelope.error ?? {};
  return `kind=${String(error.kind)}: ${String(error.message)}`;
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

/**
 * Run the whole Data Center rehearsal once.
 *
 * @param {object} [options]
 * @param {string} [options.certDir] Where the TLS material lives (default: the
 *   workdir, so a run leaves nothing behind).
 * @param {boolean} [options.keep] Keep the workdir.
 * @param {string} [options.serverEntry] The server to spawn (default: the
 *   build); the tests point it at a stand-in that fails.
 * @param {(line: string) => void} [options.log] Progress output.
 * @returns {Promise<{findings: string[], calls: {tool: string, ok: boolean}[],
 *   requests: object[], workdir: string}>}
 */
export async function runDataCenterRehearsal(options = {}) {
  const log = options.log ?? (() => {});
  if (!existsSync(SERVER_ENTRY) || !existsSync(ADAPTER_ENTRY)) {
    const error = new Error('rehearse-datacenter: no build — run `npm run build` first.');
    error.exitCode = EXIT_CONFIG;
    throw error;
  }
  const { DATACENTER_TOOLS, DATACENTER_WRITE_TOOLS } = await import(
    pathToFileURL(ADAPTER_ENTRY).href
  );

  const workdir = await mkdtemp(join(tmpdir(), 'jira-mcp-rehearse-dc-'));
  // Everything after the workdir exists runs inside the try, so a set-up
  // failure (no openssl) still removes it (CC-1501).
  let fake;
  try {
    const preload = join(workdir, 'rehearsal-dns.mjs');
    await writeFile(preload, REHEARSAL_DNS_PRELOAD, 'utf8');
    const preloadUrl = pathToFileURL(preload).href;
    fake = await startFakeJira({
      deployment: 'datacenter',
      pat: PAT,
      contextPath: CONTEXT_PATH,
      projectKey: PROJECT,
      certDir: options.certDir ?? join(workdir, 'tls'),
    });

    const findings = [];
    const calls = [];
    // The download (D117) writes here and nowhere else.
    const mediaDir = join(workdir, 'media');
    await mkdir(mediaDir);
    const serve = (env, body) =>
      withServer(env, body, options.serverEntry ?? SERVER_ENTRY);
    const envFor = async (pat) => {
      const home = await mkdtemp(join(workdir, 'home-'));
      return dataCenterChildEnv({
        home,
        site: fake.origin,
        pat,
        certFile: fake.certFile,
        preloadUrl,
        mediaDir,
      });
    };

    // A failure past set-up — a server that will not start, a call that hangs
    // or answers without structuredContent — is a regression, not a set-up
    // error: it is reported with what was found so far and exits 1 (CC-1502).
    try {
      // -- phase 1: every served tool, over one server -----------------------
      log(`phase 1: ${String(DATACENTER_PLAN.length)} tools against ${fake.origin}`);
      await serve(await envFor(PAT), async (session) => {
        const listed = (await session.client.listTools()).tools.map((tool) => tool.name);
        findings.push(
          ...toolListFindings(listed, DATACENTER_TOOLS).map(
            (line) => `tools/list: ${line}`,
          ),
          ...toolListFindings(
            DATACENTER_PLAN.map((step) => step.tool),
            dataCenterReads(DATACENTER_TOOLS, DATACENTER_WRITE_TOOLS),
          ).map((line) => `the rehearsal plan: ${line}`),
        );

        for (const step of DATACENTER_PLAN) {
          const envelope = await session.call(step.tool, step.args);
          calls.push({ tool: step.tool, ok: envelope.ok === true });
          log(`  ${envelope.ok === true ? 'ok  ' : 'FAIL'} ${step.tool}`);
          findings.push(...leakFindings(step.tool, envelope));
          if (envelope.ok !== true) {
            findings.push(`${step.tool}: ok:false (${describeError(envelope)})`);
            continue;
          }
          findings.push(...stepFindings(step.tool, envelope.data));

          if (step.tool === 'jira_download_attachment') {
            const data = envelope.data;
            const path = typeof data.path === 'string' ? data.path : undefined;
            const real = (target) => {
              try {
                return realpathSync(target);
              } catch {
                return undefined;
              }
            };
            let actual;
            try {
              actual = path === undefined ? undefined : await readFile(path);
            } catch {
              actual = undefined;
            }
            findings.push(
              ...downloadFindings(data, {
                mediaDir: real(mediaDir) ?? mediaDir,
                fileDir: path === undefined ? undefined : real(dirname(path)),
                expected: fake.state.attachments.get(ATTACHMENT_ID).bytes,
                actual,
              }),
            );
          }

          for (const [index, args] of (step.also ?? []).entries()) {
            const label = `${step.tool} (also #${String(index + 1)})`;
            const extra = await session.call(step.tool, args);
            calls.push({ tool: label, ok: extra.ok === true });
            log(`  ${extra.ok === true ? 'ok  ' : 'FAIL'} ${label}`);
            findings.push(...leakFindings(label, extra));
            if (extra.ok !== true) {
              findings.push(`${label}: ok:false (${describeError(extra)})`);
            } else if (step.checkAlso === true) {
              findings.push(...stepFindings(step.tool, extra.data));
            }
          }

          if (step.tool === 'jira_search') {
            const first = envelope.data;
            if (typeof first.nextPageToken !== 'string') {
              findings.push('jira_search: page 1 of 3 carried no nextPageToken');
              continue;
            }
            const next = await session.call(step.tool, {
              ...step.args,
              nextPageToken: first.nextPageToken,
            });
            calls.push({ tool: `${step.tool} (page 2)`, ok: next.ok === true });
            findings.push(...leakFindings(`${step.tool} (page 2)`, next));
            if (next.ok !== true) {
              findings.push(`jira_search page 2: ok:false (${describeError(next)})`);
              continue;
            }
            const keysOf = (data) => (data.issues ?? []).map((issue) => issue.key);
            const seen = new Set(keysOf(first));
            const overlap = keysOf(next.data).filter((key) => seen.has(key));
            if (keysOf(next.data).length === 0) {
              findings.push('jira_search page 2: no issues');
            }
            if (overlap.length > 0) {
              findings.push(
                `jira_search page 2: repeats ${overlap.join(', ')} from page 1`,
              );
            }
          }
        }

        // The one refusal the adapter promises: no wiki → markdown renderer.
        const markdown = await session.call('jira_get_issue', {
          issue: ISSUE,
          format: 'markdown',
        });
        if (markdown.ok !== false || markdown.error?.kind !== 'validation') {
          findings.push(
            `jira_get_issue format:"markdown": expected kind validation, got ${
              markdown.ok === true ? 'ok:true' : describeError(markdown)
            }`,
          );
        }
      });
      findings.push(
        ...wireFindings(fake.requests, CONTEXT_PATH).map((line) => `wire: ${line}`),
      );

      // -- phase 2: a wrong PAT is an auth error, not something else ----------
      log('phase 2: a wrong PAT');
      fake.clearRequests();
      await serve(await envFor(`${PAT}-wrong`), async (session) => {
        const envelope = await session.call('jira_get_myself', {});
        if (envelope.ok !== false || envelope.error?.kind !== 'auth') {
          findings.push(
            `wrong PAT: expected kind auth, got ${
              envelope.ok === true ? 'ok:true' : describeError(envelope)
            }`,
          );
        }
      });
      const refused = fake.requests.filter(
        (request) => request.authFailure !== undefined,
      );
      if (refused.length === 0) {
        findings.push('wrong PAT: the fake never refused a request');
      }
      for (const request of refused) {
        if (request.authScheme !== 'Bearer' || request.authFailure !== 'wrong token') {
          findings.push(
            `wrong PAT: ${request.method} ${request.path} failed as "${request.authFailure}" with ${String(request.authScheme)} credentials`,
          );
        }
      }
    } catch (error) {
      findings.push(
        `rehearsal aborted: ${String(error instanceof Error ? error.message : error)}`,
      );
    }

    return { findings, calls, requests: [...fake.requests], workdir };
  } finally {
    await fake?.close();
    if (options.keep !== true) await rm(workdir, { recursive: true, force: true });
  }
}

/** Per-tool checks beyond `ok: true`, where the tool has a DC-specific promise. */
export function stepFindings(tool, data) {
  const findings = [];
  if (tool === 'jira_capabilities') {
    const deployment = data.deployment;
    if (deployment?.product !== 'datacenter' || deployment?.verified !== false) {
      findings.push(
        `jira_capabilities: expected deployment {product: datacenter, verified: false}, got ${JSON.stringify(deployment)}`,
      );
    }
  }
  if (tool === 'jira_search_users') {
    // Data Center users come back by name (D110); a row without one could not
    // be put in a `fields: { assignee: { name } }` write.
    const users = Array.isArray(data.users) ? data.users : [];
    if (users.length === 0) findings.push('jira_search_users: no user came back');
    for (const [i, user] of users.entries()) {
      if (typeof user?.name !== 'string') {
        findings.push(`jira_search_users: user ${String(i)} has no name`);
      }
    }
  }
  if (tool === 'jira_list_project_roles') {
    const actors = Array.isArray(data.actors) ? data.actors : [];
    const person = actors.find((actor) => actor?.type === 'atlassian-user-role-actor');
    if (typeof person?.name !== 'string') {
      findings.push('jira_list_project_roles: no user actor came back with a name');
    }
  }
  if (tool === 'jira_count') {
    // Data Center counts through the classic search total, which is exact
    // (D114); the Cloud label `approximate: true` would be a lie here.
    if (data.approximate !== false) {
      findings.push(
        `jira_count: expected approximate: false on Data Center, got ${JSON.stringify(data.approximate)}`,
      );
    }
    if (!Number.isInteger(data.count) || data.count < 0) {
      findings.push(`jira_count: no count came back, got ${JSON.stringify(data.count)}`);
    }
  }
  if (tool === 'jira_get_changelog') {
    const histories = Array.isArray(data.histories) ? data.histories : [];
    if (histories.length === 0) findings.push('jira_get_changelog: no history came back');
    for (const [i, history] of histories.entries()) {
      if (typeof history?.author?.name !== 'string') {
        findings.push(`jira_get_changelog: history ${String(i)} has no author name`);
      }
    }
    // The fake embeds the whole history, so nothing may be flagged unreachable.
    if (data.incomplete !== undefined) {
      findings.push(
        'jira_get_changelog: a whole embedded history was flagged incomplete',
      );
    }
  }
  if (tool === 'jira_list_attachments') {
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    if (attachments.length === 0) {
      findings.push('jira_list_attachments: no attachment came back');
    }
    for (const [i, attachment] of attachments.entries()) {
      if (typeof attachment?.author?.name !== 'string') {
        findings.push(
          `jira_list_attachments: attachment ${String(i)} has no author name`,
        );
      }
      for (const key of ['self', 'content', 'thumbnail']) {
        if (attachment !== null && typeof attachment === 'object' && key in attachment) {
          findings.push(
            `jira_list_attachments: attachment ${String(i)} kept its "${key}" URL`,
          );
        }
      }
    }
  }
  if (tool === 'jira_list_filters') {
    // The Data Center list is the caller's favourites (D115); a result that did
    // not say so would read as Cloud's "every filter you can see".
    const filters = Array.isArray(data.filters) ? data.filters : [];
    if (filters.length === 0) findings.push('jira_list_filters: no filter came back');
    for (const [i, filter] of filters.entries()) {
      if (typeof filter?.owner?.name !== 'string') {
        findings.push(`jira_list_filters: filter ${String(i)} has no owner name`);
      }
    }
    if (data.scope?.source !== 'favourites') {
      findings.push(
        `jira_list_filters: expected scope.source "favourites", got ${JSON.stringify(data.scope?.source)}`,
      );
    }
  }
  if (tool === 'jira_get_filter') {
    const filter = data.filter;
    if (typeof filter?.jql !== 'string')
      findings.push('jira_get_filter: no jql came back');
    if (typeof filter?.owner?.name !== 'string') {
      findings.push('jira_get_filter: the filter has no owner name');
    }
    for (const key of ['sharePermissions', 'editPermissions', 'subscriptions']) {
      if (filter !== null && typeof filter === 'object' && key in filter) {
        findings.push(`jira_get_filter: the filter kept its "${key}"`);
      }
    }
  }
  if (tool === 'jira_get_create_meta') {
    // Data Center pages the create metadata in `values` (D116); a step that
    // came back empty means the rows were read from the wrong key.
    if (data.step === 'choose_issue_type') {
      const types = Array.isArray(data.issueTypes) ? data.issueTypes : [];
      if (types.length === 0) {
        findings.push('jira_get_create_meta: no issue type came back');
      }
    } else if (data.step === 'create_screen') {
      const fields = Array.isArray(data.fields) ? data.fields : [];
      const required = Array.isArray(data.required) ? data.required : [];
      if (data.complete !== true) {
        findings.push('jira_get_create_meta: a whole create screen was flagged partial');
      }
      if (fields.length === 0) {
        findings.push('jira_get_create_meta: no create-screen field came back');
      }
      if (!required.some((field) => field?.fieldId === 'summary')) {
        findings.push('jira_get_create_meta: summary is not among the required fields');
      }
      for (const [i, field] of fields.entries()) {
        if (field !== null && typeof field === 'object' && 'defaultValue' in field) {
          findings.push(
            `jira_get_create_meta: field ${String(i)} kept its defaultValue (a user default carries an email)`,
          );
        }
      }
    } else {
      findings.push(`jira_get_create_meta: unexpected step ${JSON.stringify(data.step)}`);
    }
  }
  if (tool === 'jira_get_issue') {
    // The wiki markup the fake sends must come back as text: in `description`,
    // and in the comment bodies of the page embedded in a default `GET /issue`
    // (CC-298).
    const description = data.fields?.description;
    const comments = data.fields?.comment?.comments;
    if (typeof description !== 'string' || description === '') {
      findings.push('jira_get_issue: no description came back');
    }
    if (!Array.isArray(comments) || comments.length === 0) {
      findings.push('jira_get_issue: no embedded comment came back');
    }
    const texts = [
      ['the description', description],
      ...(Array.isArray(comments) ? comments : []).map((comment, i) => [
        `embedded comment ${String(i)}`,
        comment?.body,
      ]),
    ];
    for (const [where, text] of texts) {
      if (typeof text !== 'string') continue;
      for (const markup of WIKI_MARKUP_SIGNS) {
        if (text.includes(markup)) {
          findings.push(`jira_get_issue: wiki markup "${markup}" survived in ${where}`);
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Standalone entry
// ---------------------------------------------------------------------------

/** `argv[1]` and this module, compared through realpath (CC-217). */
function isEntryPoint(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(resolve(entry)) === real(fileURLToPath(moduleUrl));
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      keep: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const write = (line) => process.stdout.write(`${line}\n`);
  const result = await runDataCenterRehearsal({
    keep: values.keep,
    log: values.verbose === true ? write : () => {},
  });
  if (values.verbose === true) {
    for (const request of result.requests) {
      write(`    ${String(request.status ?? '---')} ${request.method} ${request.path}`);
    }
  }
  if (values.keep === true) write(`workdir kept: ${result.workdir}`);
  const passed = result.calls.filter((call) => call.ok).length;
  write(`${String(passed)} of ${String(result.calls.length)} calls ok`);
  if (result.findings.length === 0) {
    write(
      'The Data Center rehearsal held. This says nothing about whether a real Data\n' +
        'Center host agrees — see the Phase 13 section of docs/IMPLEMENTATION-PLAN.md for\n' +
        'what still needs one.',
    );
    return EXIT_OK;
  }
  for (const finding of result.findings) write(`  REHEARSAL FAILURE  ${finding}`);
  write(`${String(result.findings.length)} finding(s).`);
  return EXIT_FAILURE;
}

if (isEntryPoint(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `rehearse-datacenter failed: ${String(error?.stack ?? error)}\n`,
      );
      process.exitCode = error?.exitCode ?? EXIT_CONFIG;
    });
}
