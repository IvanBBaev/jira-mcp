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
 * Four kinds of finding, reported in this order:
 *   1. forbidden  — a path that must never ship, with the reason it must not.
 *   2. missing    — a path the tarball has to contain and does not.
 *   3. unexpected — a path nobody declared. Not necessarily dangerous; still a
 *                   deliberate decision somebody has to make.
 *   4. dangling   — a shipped file referencing a file the tarball does not
 *                   carry. `--publish` only; see below.
 *
 * Two modes, because two different builds exist:
 *   - default    — the development build (`npm run build`), which emits source
 *                  maps because `.c8rc.json` remaps coverage through them.
 *   - `--publish`— the tarball build (`npm run build:publish`,
 *                  tsconfig.publish.json), which emits none. This mode adds the
 *                  `dangling` check: no shipped file may carry a
 *                  `sourceMappingURL` footer, because no map ships. Running it
 *                  against a development build is expected to fail, and that is
 *                  the point — it asserts which config produced `build/`.
 * Both modes assert that tsconfig.publish.json still exists and still says what
 * `--publish` depends on, so deleting it fails the everyday gate rather than
 * release day.
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
 * `--publish` says `build/` was produced by `npm run build:publish`. Only
 * `npm run tarball:publish` and the release runbook pass it.
 */
const PUBLISH_MODE = process.argv.slice(2).includes('--publish');

/** The publish config, and the settings `--publish` exists to enforce. */
const PUBLISH_TSCONFIG = 'tsconfig.publish.json';
const PUBLISH_TSCONFIG_EXPECTED = {
  extends: './tsconfig.json',
  compilerOptions: { sourceMap: false, declarationMap: false },
};

/**
 * tsc reads tsconfig files as JSONC; `JSON.parse` does not. The publish config
 * carries a long comment explaining why it exists, so strip whole-line `//`
 * comments before parsing. Anything else — a block comment, a trailing comment
 * after a value — fails the parse, which is reported rather than guessed at.
 */
function parseJsonc(text) {
  return JSON.parse(
    text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n'),
  );
}

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
 * Files the tarball must ship EXECUTABLE, with the shebang each must open with.
 *
 * npm records a file's mode as it is on disk and `npm install` restores it, so a
 * bin entry that lost its `+x` in the working tree ships without it and the
 * consumer's `node_modules/.bin` symlink points at a file the shell refuses to
 * run. Nothing else notices: `npm run` and `node bin/…` both work regardless,
 * because they invoke the interpreter themselves. Only a stranger's `npx` finds
 * out. The shebang half is the same failure from the other side — the mode says
 * "execute me", the first line says what with.
 */
const EXECUTABLE_FILES = [
  { path: 'bin/jira-mcp-ai.cjs', shebang: '#!/usr/bin/env node' },
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

for (const { path, shebang } of EXECUTABLE_FILES) {
  const entry = tarball.files.find((f) => f.path === path);
  if (!entry) continue; // already reported as missing above
  if ((entry.mode & 0o111) === 0) {
    findings.push(
      `unexpected: ${path} — packs as mode ${(entry.mode & 0o777).toString(8)}, ` +
        'not executable. `npx` and the node_modules/.bin symlink cannot run it; ' +
        'restore it with `chmod +x`',
    );
  }
  const firstLine = readFileSync(resolve(REPO_ROOT, path), 'utf8').split('\n', 1)[0];
  if (firstLine !== shebang) {
    findings.push(
      `unexpected: ${path} — opens with ${JSON.stringify(firstLine)}, expected ` +
        `${JSON.stringify(shebang)}; an executable without it is run by the shell`,
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

/**
 * The publish config is load-bearing for `--publish` and for the release, and
 * nothing else in the gate compiles it — so assert its shape in BOTH modes.
 * Deleting it, or flipping a map flag back on, then fails on the next
 * `npm run check` instead of on release day.
 */
const publishTsconfigPath = resolve(REPO_ROOT, PUBLISH_TSCONFIG);
if (!existsSync(publishTsconfigPath)) {
  findings.push(
    `missing:    ${PUBLISH_TSCONFIG} — the publish build (\`npm run build:publish\`) ` +
      'compiles with it; without it the tarball ships dangling sourceMappingURL footers',
  );
} else {
  let publishTsconfig;
  try {
    publishTsconfig = parseJsonc(readFileSync(publishTsconfigPath, 'utf8'));
  } catch (error) {
    findings.push(
      `unexpected: ${PUBLISH_TSCONFIG} — not parseable as JSON once whole-line ` +
        `// comments are removed (${error.message})`,
    );
  }
  if (publishTsconfig) {
    if (publishTsconfig.extends !== PUBLISH_TSCONFIG_EXPECTED.extends) {
      findings.push(
        `unexpected: ${PUBLISH_TSCONFIG} — \`extends\` is ` +
          `${JSON.stringify(publishTsconfig.extends)}, expected ` +
          `${JSON.stringify(PUBLISH_TSCONFIG_EXPECTED.extends)}: the publish build must ` +
          'differ from the development build only in the map flags',
      );
    }
    for (const [flag, want] of Object.entries(
      PUBLISH_TSCONFIG_EXPECTED.compilerOptions,
    )) {
      const got = publishTsconfig.compilerOptions?.[flag];
      if (got !== want) {
        findings.push(
          `unexpected: ${PUBLISH_TSCONFIG} — \`compilerOptions.${flag}\` is ` +
            `${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
      }
    }
  }
}

/**
 * A shipped file may not reference a file the tarball does not carry. `files`
 * excludes every source map from the tarball (see FORBIDDEN above), so a
 * `sourceMappingURL` footer in a shipped file is a dangling reference — which
 * is what the publish build exists to prevent. Checked in `--publish` only:
 * the development build emits those footers on purpose, and its maps are what
 * `.c8rc.json` remaps coverage through.
 */
if (PUBLISH_MODE) {
  const SOURCE_MAPPING_URL_RE = /\/\/#\s*sourceMappingURL=(\S+)/;
  for (const path of shipped) {
    if (!path.startsWith('build/')) continue;
    if (!ALLOWED_BUILD_SUFFIXES.some((s) => path.endsWith(s))) continue;
    const match = SOURCE_MAPPING_URL_RE.exec(
      readFileSync(resolve(REPO_ROOT, path), 'utf8'),
    );
    if (match) {
      findings.push(
        `dangling:   ${path} — references ${match[1]}, which \`files\` never ships. ` +
          `Build with \`npm run build:publish\` (${PUBLISH_TSCONFIG}), not \`npm run build\``,
      );
    }
  }
}

if (findings.length > 0) {
  for (const f of [...new Set(findings)].sort()) console.error(f);
  console.error(
    `\ncheck-tarball: ${findings.length} finding(s) across ${shipped.length} packed file(s)` +
      `${PUBLISH_MODE ? ' (--publish)' : ''}.\n` +
      'Fix the `files` array in package.json, rebuild with the config the mode\n' +
      'expects, or — if the change is deliberate — update the tables at the top of\n' +
      'scripts/check-tarball.mjs in the same commit.',
  );
  process.exit(1);
}

console.error(
  `check-tarball: ${tarball.entryCount} file(s) clean ` +
    `(${kb(tarball.size)} packed, ${kb(tarball.unpackedSize)} unpacked)` +
    `${PUBLISH_MODE ? ' — publish build, no dangling source-map references' : ''}`,
);
