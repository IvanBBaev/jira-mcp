#!/usr/bin/env node
/**
 * smoke-pack — install the packed tarball the way a consumer does and prove it
 * starts (V3-75, OPS-R6).
 *
 * `check-tarball.mjs` proves the file list; it cannot prove that the package
 * starts. A consumer gets no lockfile and no shrinkwrap: `npm install
 * jira-mcp-ai` resolves the dependency ranges on install day, while the gate
 * only ever runs against the versions in `package-lock.json`. So an SDK minor
 * release that breaks the stdio handshake, or a runtime file the `files`
 * allowlist forgot, would reach users with CI green. This script closes both:
 *
 *   1. `npm pack` the current `build/` (or take `--tarball <path>`);
 *   2. `npm install` the tarball into an empty directory, without a lockfile;
 *   3. spawn the installed `node_modules/.bin/jira-mcp-ai` (the CommonJS shim,
 *      exactly what `npx jira-mcp-ai` runs) with placeholder credentials and an
 *      empty HOME, and complete MCP `initialize` + `tools/list` over stdio;
 *   4. assert the reported version is the package's and the tool count with
 *      every package listed equals the built manifest's.
 *
 * `--lower-bound` adds an npm `overrides` entry that pins
 * `@modelcontextprotocol/sdk` to the floor of the range `package.json`
 * declares, and checks the floor is what got installed: the declared range is
 * a promise to consumers, and this is the only place it is tested.
 *
 * Startup reads configuration and nothing else, so the handshake never touches
 * the network; the child also gets a `fetch` that rejects, so a regression that
 * did call out fails here instead of reaching the placeholder site.
 *
 * Usage (after `npm run build:publish`; `npm install` needs the registry, which
 * is why this runs in ci.yml job `smoke`, not in `npm run check`):
 *     node scripts/smoke-pack.mjs [--tarball <path>] [--lower-bound] [--keep]
 * Exit 0 on a clean handshake, 1 on a failed assertion, 2 on a setup error.
 * The pure helpers are exported for `src/testing/smoke-pack.test.ts`; the smoke
 * only runs when this file is the entry point.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(REPO_ROOT, 'build', 'tools', 'index.js');

/** The dependency whose declared floor `--lower-bound` pins. */
export const LOWER_BOUND_PACKAGE = '@modelcontextprotocol/sdk';

/** Protocol version the smoke client offers in `initialize`. */
export const PROTOCOL_VERSION = '2025-06-18';

const HANDSHAKE_TIMEOUT_MS = 30_000;

const SEMVER = String.raw`(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?`;
const FLOOR_RE = new RegExp(`^(?:\\^|~|>=\\s*)?${SEMVER}$`, 'u');

/**
 * The lowest version a dependency range admits: `^1.32.1`, `~1.32.1`,
 * `>=1.32.1` and an exact `1.32.1` all give `1.32.1`. Anything else (unions,
 * hyphen ranges, `x` wildcards, tags) throws: the floor of such a range is not
 * one obvious version, and guessing would test the wrong thing.
 */
export function lowerBound(range) {
  const match = FLOOR_RE.exec(String(range).trim());
  if (match === null) {
    throw new Error(`cannot derive a lower bound from the range "${range}"`);
  }
  return `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}`;
}

/** The consumer project's package.json: empty, plus the optional override. */
export function consumerManifest(overrides) {
  const manifest = { name: 'jira-mcp-ai-smoke', version: '0.0.0', private: true };
  return overrides === undefined ? manifest : { ...manifest, overrides };
}

/**
 * Every failed assertion about one handshake, one string each; empty is a
 * pass. `responses` maps a JSON-RPC id to the message the server sent for it.
 */
export function checkHandshake(responses, expected) {
  const failures = [];
  const init = responses.get(1);
  if (init === undefined) failures.push('no response to initialize');
  else if (init.error !== undefined) {
    failures.push(`initialize failed: ${JSON.stringify(init.error)}`);
  } else {
    const info = init.result?.serverInfo;
    if (info?.version !== expected.version) {
      failures.push(
        `initialize reported version ${JSON.stringify(info?.version)}, expected ${expected.version}`,
      );
    }
    if (init.result?.capabilities?.tools === undefined) {
      failures.push('initialize did not advertise the tools capability');
    }
  }
  const list = responses.get(2);
  if (list === undefined) failures.push('no response to tools/list');
  else if (list.error !== undefined) {
    failures.push(`tools/list failed: ${JSON.stringify(list.error)}`);
  } else {
    const tools = list.result?.tools;
    if (!Array.isArray(tools)) failures.push('tools/list returned no tools array');
    else if (tools.length !== expected.tools) {
      failures.push(
        `tools/list returned ${tools.length} tools, expected ${expected.tools}`,
      );
    }
    if (list.result?.nextCursor !== undefined) {
      failures.push('tools/list paginated; the smoke expects one page');
    }
  }
  return failures;
}

// ---------- the smoke itself ----------

class SetupError extends Error {}

function parseArgs(argv) {
  const args = { tarball: undefined, lowerBound: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lower-bound') args.lowerBound = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--tarball') {
      args.tarball = argv[(i += 1)];
      if (args.tarball === undefined) throw new SetupError('--tarball needs a path');
    } else throw new SetupError(`unknown argument: ${arg}`);
  }
  return args;
}

function npm(args, cwd) {
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new SetupError(
      `npm ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function pack(destination) {
  if (!existsSync(MANIFEST)) {
    throw new SetupError(
      `${MANIFEST} does not exist. Run \`npm run build:publish\` first.`,
    );
  }
  const out = JSON.parse(
    npm(['pack', '--json', '--pack-destination', destination], REPO_ROOT),
  );
  return join(destination, out[0].filename);
}

async function expectedTools() {
  const { PACKAGES } = await import(pathToFileURL(MANIFEST).href);
  return PACKAGES.reduce((sum, pkg) => sum + pkg.tools.length, 0);
}

const FENCE = `data:text/javascript,${encodeURIComponent(
  "globalThis.fetch = () => Promise.reject(new Error('smoke-pack: the network is fenced off'));",
)}`;

function rpc(id, method, params = {}) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/** Spawn the installed binary, run the handshake, collect responses by id. */
function handshake(bin, home) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, [], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        NODE_OPTIONS: `--import=${FENCE}`,
        JIRA_SITE: 'https://smoke.atlassian.net',
        JIRA_EMAIL: 'smoke@example.com',
        JIRA_API_TOKEN: 'smoke-placeholder',
        JIRA_TOOL_PACKAGES: 'all',
      },
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolvePromise(responses);
    };
    const timer = setTimeout(
      () => finish(new Error(`handshake timed out; stderr:\n${stderr}`)),
      HANDSHAKE_TIMEOUT_MS,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`non-JSON line on stdout (stdout is the protocol): ${line}`));
          return;
        }
        if (message.id !== undefined) responses.set(message.id, message);
        if (message.id === 1) {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          child.stdin.write(rpc(2, 'tools/list'));
        }
        if (message.id === 2) finish(null);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', (error) => finish(error));
    child.on('exit', (code) =>
      finish(new Error(`server exited (${code}) before tools/list; stderr:\n${stderr}`)),
    );
    child.stdin.write(
      rpc(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'smoke-pack', version: '0' },
      }),
    );
  });
}

function installedVersion(root, name) {
  const path = join(root, 'node_modules', ...name.split('/'), 'package.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'jira-mcp-smoke-'));
  try {
    const tarball = args.tarball === undefined ? pack(work) : resolve(args.tarball);
    const consumer = join(work, 'consumer');
    const home = join(work, 'home');
    mkdirSync(consumer);
    mkdirSync(home);

    let floor;
    if (args.lowerBound) {
      floor = lowerBound(pkg.dependencies[LOWER_BOUND_PACKAGE]);
    }
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify(consumerManifest(floor && { [LOWER_BOUND_PACKAGE]: floor }), null, 2)}\n`,
    );
    npm(['install', '--no-audit', '--no-fund', tarball], consumer);

    const sdk = installedVersion(consumer, LOWER_BOUND_PACKAGE);
    const nested = installedVersion(
      join(consumer, 'node_modules', pkg.name),
      LOWER_BOUND_PACKAGE,
    );
    const failures = [];
    if (floor !== undefined && (sdk !== floor || nested !== undefined)) {
      failures.push(
        `${LOWER_BOUND_PACKAGE} resolved to ${sdk}${nested ? ` (nested ${nested})` : ''}, expected the floor ${floor}`,
      );
    }

    const bin = join(consumer, 'node_modules', '.bin', pkg.name);
    const responses = await handshake(bin, home);
    failures.push(
      ...checkHandshake(responses, {
        version: pkg.version,
        tools: await expectedTools(),
      }),
    );

    const label = `${pkg.name}@${pkg.version} with ${LOWER_BOUND_PACKAGE}@${sdk ?? '?'}`;
    if (failures.length > 0) {
      for (const failure of failures)
        process.stderr.write(`smoke-pack: FAIL ${failure}\n`);
      process.exitCode = 1;
      return;
    }
    const tools = responses.get(2).result.tools.length;
    process.stdout.write(
      `smoke-pack: ok — ${label}, initialize + tools/list (${tools} tools)\n`,
    );
  } finally {
    if (args.keep) process.stderr.write(`smoke-pack: kept ${work}\n`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`smoke-pack: ${error.message}\n`);
    process.exitCode = error instanceof SetupError ? 2 : 1;
  });
}
