#!/usr/bin/env node
/**
 * generate-readme — render the README tool tables from the tool manifest.
 *
 * The manifest (`src/tools/index.ts`) is the single source of truth for the tool
 * surface; a README table maintained by hand is a second copy of it, and a
 * second copy drifts. This script reads the BUILT manifest and rewrites
 * everything between the `GENERATED:TOOLS` markers in README.md.
 *
 * Usage:
 *   node scripts/generate-readme.mjs            rewrite README.md in place
 *   node scripts/generate-readme.mjs --check    exit 1 if README.md is stale
 *   ... --readme <path>                         operate on another copy instead
 *   ... --released <X.Y.Z> [--next <X.Y.Z>]     after a release: stamp every
 *                                               unreleased tool with that version
 *                                               in src/tools/released.json, then
 *                                               regenerate (D526)
 *
 * `--check` is what the drift test runs. It never writes, so it is safe in CI.
 * `--readme` exists for the tests that exercise the WRITE path: they run it
 * against a copy in a temp directory, so an interrupted run can never leave the
 * checkout's README half-edited.
 *
 * Requires `npm run build` first: reading the manifest from `build/` rather than
 * parsing the TypeScript keeps this script free of a compiler dependency and
 * means it sees exactly the values the server will register.
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPackages,
  loadReleased,
  resolveCount,
  saveReleased,
  sinceOf,
  stampRelease,
} from './surface-facts.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = resolve(REPO_ROOT, 'README.md');

const START = '<!-- GENERATED:TOOLS:START -->';
const END = '<!-- GENERATED:TOOLS:END -->';

/** The command a failing check should tell the reader to run. */
export const REGENERATE_COMMAND = 'npm run readme';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Roughly one line of table cell; sentences are taken whole up to this. */
const SUMMARY_TARGET = 110;
const SUMMARY_MAX = 200;

/**
 * The opening sentences of a tool description, for the table's last column.
 *
 * Tool descriptions are written for the model and run several sentences; a table
 * cell that long is unreadable, and docs/TOOLS.md already holds the full text.
 * One sentence alone is sometimes too little ("Create one issue."), so sentences
 * are taken whole until the cell is about a line long — never cut mid-sentence,
 * because a truncated instruction reads as a complete but wrong one.
 */
function summarize(text) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  // Split only where a terminator is FOLLOWED by whitespace: `data.nextPageToken`
  // and `e.g.` keep their dots, which a naive `[^.!?]+[.!?]` splitter loses.
  const sentences = flat.split(/(?<=[.!?])\s+/u);

  const taken = [];
  let length = 0;
  for (const sentence of sentences) {
    const next = length === 0 ? sentence.length : length + 1 + sentence.length;
    if (taken.length > 0 && next > SUMMARY_MAX) break;
    taken.push(sentence);
    length = next;
    if (length >= SUMMARY_TARGET) break;
  }

  const summary = taken.join(' ');
  return summary.length > SUMMARY_MAX
    ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    : summary;
}

/** Markdown table cells cannot contain a raw pipe or a line break. */
function cell(text) {
  return text.replace(/\s+/gu, ' ').replaceAll('|', '\\|').trim();
}

/** What a caller most needs to know before calling: may this change anything? */
function access(tool) {
  if (tool.annotations.readOnlyHint) return 'read-only';
  return tool.writeTier === 'irreversible' ? 'write · irreversible' : 'write · standard';
}

/** The release that first shipped the tool, or the version it will ship in. */
function since(tool, released) {
  return sinceOf(released, tool.name) ?? `${released.next} (unreleased)`;
}

function renderPackage(pkg, released) {
  const rows = pkg.tools.map(
    (tool) =>
      `| \`${tool.name}\` | ${cell(tool.title)} | ${access(tool)} | ${since(
        tool,
        released,
      )} | ${cell(summarize(tool.description))} |`,
  );

  return [
    `### ${cell(pkg.title)} — \`${pkg.id}\``,
    '',
    cell(pkg.description),
    '',
    '| Tool | Title | Access | Since | What it does |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/**
 * The whole generated block, marker to marker.
 *
 * Written as prose plus tables rather than one flat list because the package is
 * the unit a reader configures: `JIRA_TOOL_PACKAGES` turns these headings on and
 * off, and a table that ignored them would not answer "what do I lose if I only
 * enable `core` and `search`?".
 */
export function renderTools(packages, released) {
  const toolCount = packages.reduce((sum, pkg) => sum + pkg.tools.length, 0);
  const writeCount = packages.reduce(
    (sum, pkg) => sum + pkg.tools.filter((tool) => !tool.annotations.readOnlyHint).length,
    0,
  );
  const unreleased = resolveCount('unreleased', packages, released).value;
  const shipped = resolveCount('tools@released', packages, released).value;
  // The pinned install is the latest release, not `main` (DOC-02): say which
  // rows a reader who copies the registration example will not have.
  const releaseLine =
    unreleased === 0
      ? [
          `The Since column names the release that first shipped each tool; all of`,
          `them are in the latest release, ${released.version}.`,
        ]
      : [
          `The Since column names the release that first shipped each tool. The latest`,
          `release, ${released.version}, has ${shipped} of them; the ${unreleased} rows marked`,
          `\`${released.next} (unreleased)\` are on \`main\` only, so the published package`,
          'does not have them yet.',
        ];

  return [
    START,
    '',
    '<!-- Generated by scripts/generate-readme.mjs from the tool manifest.',
    `     Do not edit by hand — run \`${REGENERATE_COMMAND}\`. -->`,
    '',
    `${toolCount} tools in ${packages.length} packages, ${writeCount} of them write tools`,
    'behind the plan/apply gate. `JIRA_TOOL_PACKAGES`, `JIRA_PACKAGES_DENY` and',
    '`JIRA_PACKAGES_READONLY` decide which of them a session actually sees; the',
    '`core` package is always registered. Full input and output shapes are in',
    '[`docs/TOOLS.md`](docs/TOOLS.md).',
    '',
    ...releaseLine,
    '',
    ...packages.map((pkg) => renderPackage(pkg, released)),
    END,
  ].join('\n');
}

/** Splice the generated block into an existing README. */
export function spliceReadme(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README.md is missing the ${START} / ${END} markers; restore them before generating.`,
    );
  }
  return readme.slice(0, start) + block + readme.slice(end + END.length);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The README to operate on: `--readme <path>` (resolved against cwd), else the repo's. */
function readmePath(argv) {
  const at = argv.indexOf('--readme');
  if (at === -1) return README_PATH;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--readme needs a path.');
  }
  return resolve(value);
}

/** The value after `flag`, or `undefined` when the flag is absent. */
function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

/** `1.1.0` → `1.2.0`: the default next version after a release. */
function nextMinor(version) {
  const [major, minor] = version.split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}

async function run(argv) {
  const check = argv.includes('--check');
  const target = readmePath(argv);
  const packages = await loadPackages();
  let released = loadReleased();

  const releasedVersion = flagValue(argv, '--released');
  if (releasedVersion !== undefined) {
    if (check) throw new Error('--released and --check do not combine.');
    const nextVersion = flagValue(argv, '--next') ?? nextMinor(releasedVersion);
    released = stampRelease(released, packages, releasedVersion, nextVersion);
    saveReleased(released);
    process.stderr.write(
      `src/tools/released.json: ${releasedVersion} released, next ${nextVersion}.\n`,
    );
  }

  const current = readFileSync(target, 'utf8');
  const next = spliceReadme(current, renderTools(packages, released));

  if (next === current) {
    if (!check) process.stderr.write('README.md is already up to date.\n');
    return 0;
  }

  if (check) {
    process.stderr.write(
      `README.md is out of date with the tool manifest. Regenerate it with: ${REGENERATE_COMMAND}\n`,
    );
    return 1;
  }

  writeFileSync(target, next, 'utf8');
  process.stderr.write('README.md tool tables regenerated.\n');
  return 0;
}

/**
 * `argv[1]` and this module, compared through realpath: Node realpaths the
 * entry module, so a symlinked checkout (macOS `/tmp` is one) or a path with
 * spaces would otherwise fail the guard and exit 0 having done nothing (CC-217).
 */
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

// Only when invoked directly — the drift test imports nothing from here, but a
// future consumer should not trigger a rewrite by importing this module.
if (isEntryPoint(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `generate-readme: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
