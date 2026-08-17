#!/usr/bin/env node
/**
 * check-tarball — assert what `npm publish` would actually ship.
 *
 * `files` in package.json is an allowlist, but nothing proves the allowlist still
 * says what its author meant: a new build artefact, a stray `.env`, or a source
 * map carrying the whole TypeScript source can slip into a tarball and nobody
 * notices until it is on the registry, immutable. This script asks `npm pack
 * --dry-run --json` what the tarball would contain and compares that list to an
 * explicit expectation (docs/TESTING.md §Gate).
 *
 * Three kinds of finding, reported in this order:
 *   1. forbidden  — a path that must never ship, with the reason it must not.
 *   2. missing    — a path the tarball has to contain and does not.
 *   3. unexpected — a path nobody declared. Not necessarily dangerous; still a
 *                   deliberate decision somebody has to make.
 *
 * Run standalone (`node scripts/check-tarball.mjs`) or as part of `npm run check`.
 * Exit code 1 with one finding per line; 0 when clean. Requires a fresh build —
 * `npm pack` reads `build/` off disk, it does not compile.
 *
 * The tables below are the whole configuration surface. When the shipped surface
 * genuinely changes, change them here in the same commit as package.json.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Non-build files the tarball must contain, exactly — no more, no fewer.
 *
 * npm adds `package.json`, `README.md` and `LICENSE` on its own whatever `files`
 * says; `CHANGELOG.md` and `bin/` are only there because `files` lists them.
 * Listing all five keeps this check honest about the whole non-build surface
 * rather than only the part npm happens to leave to us.
 */
const REQUIRED_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'bin/jira-mcp-ai.cjs',
  'package.json',
];

/**
 * Compiled anchors. Pinning all ~80 emitted files would turn every refactor into
 * a merge conflict in this script and teach people to update it without reading
 * it. These five are the ones whose absence means the package is broken: the
 * entry the bin shim imports, its types, the CLI, the server and the tool
 * registry.
 */
const REQUIRED_BUILD_FILES = [
  'build/index.js',
  'build/index.d.ts',
  'build/cli/doctor.js',
  'build/mcp/server.js',
  'build/tools/index.js',
];

/** Everything else under `build/` may ship, as long as it is one of these. */
const ALLOWED_BUILD_SUFFIXES = ['.js', '.d.ts'];

/**
 * Paths that must never ship, each with the reason. These are all also caught by
 * the "unexpected" rule; they are named separately so the failure says *why* it
 * matters instead of leaving the reader to guess.
 */
const FORBIDDEN = [
  {
    pattern: /(^|\/)\.env(\.|$)/,
    why: 'env files hold credentials — a published one cannot be unpublished',
  },
  {
    pattern: /\.map$/,
    why: 'source maps embed absolute build paths and, with sourcesContent, the TypeScript source',
  },
  {
    pattern: /\.test\.(js|d\.ts)$/,
    why: 'test code is not part of the runtime surface',
  },
  {
    pattern: /^build\/testing\//,
    why: 'the network fence and test harness exist only for the suite',
  },
  {
    pattern: /^build\/core\/fakes\//,
    why: 'fake adapters would let a consumer wire a stub in place of the real one',
  },
  {
    pattern: /^src\//,
    why: 'TypeScript sources are not shipped; the build output is',
  },
  {
    pattern: /^docs\//,
    why: 'the spec corpus is a repository artefact, and docs/ai is local-only',
  },
  {
    pattern: /^coverage\//,
    why: 'coverage output is a CI artefact',
  },
  {
    pattern: /^node_modules\//,
    why: 'dependencies are resolved by the consumer, never vendored',
  },
  {
    pattern: /^(WORKLOG\.md|CLAUDE\.md|CLAUDE\.local\.md|\.claude\/)/,
    why: 'AI-harness files are local-only and are never committed, let alone published',
  },
  {
    pattern: /\.tsbuildinfo$/,
    why: 'incremental build state leaks the local file layout',
  },
  {
    pattern: /\.tgz$/,
    why: 'a packed tarball inside a packed tarball is always a mistake',
  },
];

// --- helpers -------------------------------------------------------------

/** @type {string[]} */
const findings = [];

/**
 * Every path package.json promises a consumer, gathered from the fields npm and
 * Node actually resolve: `bin`, `main`, `types` and every leaf of the `exports`
 * tree.
 *
 * The `files` allowlist and these fields are edited independently and nothing
 * ties them together — an `exports` subpath whose target the allowlist excludes
 * is not a broken build, not a failing test and not a lint error. It is a
 * package that installs cleanly and throws `ERR_MODULE_NOT_FOUND` the first time
 * somebody imports it, discovered after the version is immutable.
 *
 * @param {unknown} node a package.json value that may contain path targets
 * @param {Set<string>} out collected paths, tarball-relative (no leading `./`)
 */
function collectDeclaredPaths(node, out) {
  if (typeof node === 'string') {
    if (node.startsWith('./')) out.add(node.slice(2));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectDeclaredPaths(item, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    // Only VALUES are targets. `exports` keys are subpaths and condition names,
    // and a key like "./package.json" would otherwise be counted twice.
    for (const value of Object.values(node)) collectDeclaredPaths(value, out);
  }
}

/**
 * Ask npm what it would pack. `--dry-run` writes nothing to disk, and `npm pack`
 * runs `prepack`/`postpack` but never `prepublishOnly`, so this cannot recurse
 * back into `npm run check`.
 *
 * @returns {{ files: { path: string }[], entryCount: number, size: number, unpackedSize: number }}
 */
function packDryRun() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const stdout = execFileSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // npm writes its human-readable tarball listing to stderr and the JSON to
    // stdout. Inherit stderr so a real npm error is visible rather than swallowed.
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const start = stdout.indexOf('[');
  if (start < 0) {
    throw new Error(`npm pack --json produced no JSON array:\n${stdout}`);
  }
  const parsed = JSON.parse(stdout.slice(start));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(
      `npm pack --json described ${parsed.length ?? '?'} tarballs, expected 1`,
    );
  }
  return parsed[0];
}

/** Human-readable size, so the summary line is readable at a glance. */
function kb(bytes) {
  return `${Math.round(bytes / 1024)} kB`;
}

// --- run -----------------------------------------------------------------

if (!existsSync(resolve(REPO_ROOT, 'build', 'index.js'))) {
  console.error(
    'check-tarball: build/index.js is missing, so `npm pack` would report a tarball\n' +
      'that is missing every compiled file. Run `npm run build` first.',
  );
  process.exit(1);
}

const tarball = packDryRun();
const shipped = tarball.files.map((f) => f.path);
const present = new Set(shipped);

for (const path of shipped) {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(path)) {
      findings.push(`forbidden:  ${path} — ${rule.why}`);
      break;
    }
  }
}

for (const path of [...REQUIRED_FILES, ...REQUIRED_BUILD_FILES]) {
  if (!present.has(path)) {
    findings.push(`missing:    ${path} — declared expected, not in the tarball`);
  }
}

/**
 * Every entry point package.json advertises has to be in the tarball. This is
 * the one check that follows the manifest rather than a table in this file, so
 * it keeps working when somebody adds an `exports` subpath and forgets that
 * `files` decides whether the target ships.
 */
const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
const declared = new Set();
for (const field of ['bin', 'main', 'types', 'exports']) {
  collectDeclaredPaths(manifest[field], declared);
}
for (const path of [...declared].sort()) {
  if (!present.has(path)) {
    findings.push(
      `missing:    ${path} — package.json declares it as an entry point ` +
        '(bin/main/types/exports) but `files` does not ship it',
    );
  }
}

const required = new Set([...REQUIRED_FILES, ...REQUIRED_BUILD_FILES]);
for (const path of shipped) {
  if (required.has(path)) continue;
  if (path.startsWith('build/') && ALLOWED_BUILD_SUFFIXES.some((s) => path.endsWith(s))) {
    continue;
  }
  findings.push(`unexpected: ${path} — not declared in scripts/check-tarball.mjs`);
}

if (findings.length > 0) {
  for (const f of [...new Set(findings)].sort()) console.error(f);
  console.error(
    `\ncheck-tarball: ${findings.length} finding(s) across ${shipped.length} packed file(s).\n` +
      'Fix the `files` array in package.json, or — if the change is deliberate —\n' +
      'update the tables at the top of scripts/check-tarball.mjs in the same commit.',
  );
  process.exit(1);
}

console.error(
  `check-tarball: ${tarball.entryCount} file(s) clean ` +
    `(${kb(tarball.size)} packed, ${kb(tarball.unpackedSize)} unpacked)`,
);
