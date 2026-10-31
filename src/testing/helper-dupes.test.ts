// Scripted check for V3-56 (TSN-R4 / TSN-05): the api ring's shared helpers are
// defined exactly once.
//
// Every api module used to carry its own copy of the record readers and the
// request/failure helpers, and the copies drifted. They now live in
// `src/api/guards.ts` (pure readers) and `src/api/wire.ts` (sending and
// failures); `abortError` lives in `src/core/clock.ts`. This suite scans the
// production sources and fails when a second top-level definition of any of
// those names appears, so a new module imports the helper instead of copying
// it. Modules that need a different wording bind the shared helper under
// their own name (`requireIssueRecord`, `requireFilterText`, ...).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

const SRC = join(REPO_ROOT, 'src');

/** Helpers that must be defined once in the api ring, and where. */
const API_HELPERS: Readonly<Record<string, string>> = {
  isRecord: 'src/api/guards.ts',
  asRecord: 'src/api/guards.ts',
  readString: 'src/api/guards.ts',
  readNumber: 'src/api/guards.ts',
  compact: 'src/api/guards.ts',
  send: 'src/api/wire.ts',
  sendOne: 'src/api/wire.ts',
  writeControls: 'src/api/wire.ts',
  runClassic: 'src/api/wire.ts',
  shapeError: 'src/api/wire.ts',
  requireRecord: 'src/api/wire.ts',
  requireField: 'src/api/wire.ts',
  requireText: 'src/api/wire.ts',
  SHAPE_REMEDIATION: 'src/api/wire.ts',
};

/** Helpers that must be defined once anywhere in `src/`. */
const GLOBAL_HELPERS: Readonly<Record<string, string>> = {
  abortError: 'src/core/clock.ts',
};

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Top-level `function NAME` / `const NAME =` definitions per file. */
function definitionsOf(name: string, files: readonly string[]): string[] {
  const pattern = new RegExp(
    `^(?:export )?(?:(?:async )?function\\*? ${name}\\b|const ${name}\\s*[=:])`,
    'm',
  );
  return files
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(REPO_ROOT, file).split(sep).join('/'));
}

const API_FILES = productionFiles(join(SRC, 'api'));
const ALL_FILES = productionFiles(SRC);

describe('shared helpers are defined once (V3-56)', () => {
  for (const [name, home] of Object.entries(API_HELPERS)) {
    test(`${name} is defined only in ${home} within src/api`, () => {
      assert.deepEqual(definitionsOf(name, API_FILES), [home]);
    });
  }
  for (const [name, home] of Object.entries(GLOBAL_HELPERS)) {
    test(`${name} is defined only in ${home} within src`, () => {
      assert.deepEqual(definitionsOf(name, ALL_FILES), [home]);
    });
  }
});
