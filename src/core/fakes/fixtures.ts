// The recorded-fixture corpus: where `test/fixtures/` lives, how one is read,
// and the {@link FixtureLoader} implementation that `createFakeJiraRequest`'s
// hook has been waiting for (TESTING.md §Fixtures).
//
// Test-only, like the rest of `core/fakes/**` — excluded from coverage and from
// the published tarball. This is the ONE module in `core` that touches the
// filesystem, and it does so for a reason no other module shares: a fixture is a
// file on disk, and something has to know where the disk is. Everything else
// takes a fixture as an argument.
//
// Two rules, both inherited from TESTING.md §Mocking tiers:
//
//  1. **A fixture the fake cannot find is a test failure**, never a fallback to
//     `{}` — so the loader throws, naming the corpus and what is actually in it,
//     rather than returning `undefined` and letting a guard "pass" against
//     nothing.
//  2. **Fixtures are read, never written, by tests.** Recording is
//     `scripts/record-fixture.mjs`'s job, under an operator's supervision.
//
// Every load returns a `structuredClone`, so a test that mutates a body cannot
// poison the next test that asks for the same fixture.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FixtureLoader } from './fakeJiraRequest.js';

/**
 * Walk up from this module until a `package.json` appears. Resolved from the
 * module's own location rather than `process.cwd()`, because the test runner is
 * free to be started from anywhere — and this file executes as
 * `build/core/fakes/fixtures.js`, three levels under the repo root.
 */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `core/fakes/fixtures: no package.json found above ${from}; ` +
          'cannot locate the repo root, so test/fixtures/ cannot be resolved.',
      );
    }
    dir = parent;
  }
}

/** Absolute path of the repo root, derived from this module's own location. */
export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** Absolute path of the fixture corpus (TESTING.md §Fixtures). */
export const FIXTURES_DIR = join(REPO_ROOT, 'test', 'fixtures');

/** True when the corpus directory exists at all. */
export function fixturesDirExists(dir: string = FIXTURES_DIR): boolean {
  return existsSync(dir);
}

/**
 * Every `*.json` under `dir`, as `/`-separated paths RELATIVE to it, sorted.
 * A missing directory yields `[]` — the emptiness is the caller's to judge, and
 * the PII lint judges it loudly (`src/testing/fixture-pii.test.ts`).
 */
export function listFixtureFiles(dir: string = FIXTURES_DIR): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];

  const walk = (absolute: string, prefix: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(child, rel);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(rel);
    }
  };

  walk(dir, '');
  return found.sort();
}

/** Parse one fixture file. A malformed fixture names itself in the error. */
export function readFixtureJson(absolutePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(
      `core/fakes/fixtures: cannot read ${absolutePath}: ${String(
        error instanceof Error ? error.message : error,
      )}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `core/fakes/fixtures: ${absolutePath} is not valid JSON: ${String(
        error instanceof Error ? error.message : error,
      )}`,
      { cause: error },
    );
  }
}

/** Options for {@link createFixtureLoader}. */
export interface FixtureLoaderOptions {
  /** Corpus root. Defaults to {@link FIXTURES_DIR}. */
  readonly dir?: string;
}

/**
 * Build a {@link FixtureLoader} over a corpus directory.
 *
 * `name` is the path under the corpus WITHOUT the `.json` extension, `/`-joined
 * on every platform: `createFixtureLoader()('errors/rate-limited-429')`. A name
 * that escapes the corpus, and a name with no file behind it, both throw.
 */
export function createFixtureLoader(options: FixtureLoaderOptions = {}): FixtureLoader {
  const dir = options.dir ?? FIXTURES_DIR;
  const cache = new Map<string, unknown>();

  return (name: string): unknown => {
    const cached = cache.get(name);
    if (cached !== undefined) return structuredClone(cached);

    const absolute = resolve(dir, `${name}.json`);
    // `..` in a fixture name is always a mistake, and a mistake that reads an
    // arbitrary file would report as a confusing JSON parse error somewhere else.
    const inside = relative(dir, absolute);
    if (inside.startsWith(`..${sep}`) || inside === '..') {
      throw new Error(
        `core/fakes/fixtures: fixture name ${JSON.stringify(name)} escapes the ` +
          `corpus at ${dir}. Fixture names are corpus-relative.`,
      );
    }

    if (!existsSync(absolute)) {
      const available = listFixtureFiles(dir).map((file) => file.replace(/\.json$/, ''));
      throw new Error(
        `core/fakes/fixtures: fixture ${JSON.stringify(name)} not found under ${dir}. ` +
          'A fixture the fake cannot find is a test failure, not a fallback to {} ' +
          '(TESTING.md §Mocking tiers). ' +
          (available.length === 0
            ? 'The corpus is empty — record one with scripts/record-fixture.mjs.'
            : `Available: ${available.join(', ')}.`),
      );
    }

    const body = readFixtureJson(absolute);
    cache.set(name, body);
    return structuredClone(body);
  };
}

/**
 * The loader over the repo's own corpus — what a test passes as
 * `createFakeJiraRequest({ loadFixture: repoFixtureLoader })`.
 */
export const repoFixtureLoader: FixtureLoader = createFixtureLoader();
