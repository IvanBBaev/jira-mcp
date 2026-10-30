// Suite for `scripts/surface-facts.mjs` (D526): the count and version keys the
// README status box and the Pages site write in `<!-- count:KEY -->` markers,
// and the released-surface baseline `src/tools/released.json`.
//
// docs-lint check 9 is the consumer; this suite pins the key grammar on a
// small hand-made manifest, so a wrong count is a failing assertion here
// rather than a confusing docs-lint finding. The script is reached with a
// dynamic `import()` of a `file:` URL, for the reasons
// `./record-fixture.test.ts` gives; the shapes below are this suite's reading
// of its exports.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../core/fakes/fixtures.js';
import { PACKAGES } from '../tools/index.js';

interface FakeTool {
  readonly name: string;
  readonly writeTier?: 'standard' | 'irreversible';
  readonly annotations: { readonly readOnlyHint?: boolean };
}

interface FakePackage {
  readonly id: string;
  readonly tools: readonly FakeTool[];
}

interface Released {
  readonly version: string;
  readonly next: string;
  readonly live: {
    readonly release: string;
    readonly reads: number;
    readonly writes: number;
  };
  readonly since: Readonly<Record<string, string>>;
}

type Resolved = { readonly value: number | string } | { readonly error: string };

interface FactsModule {
  compareVersions(a: string, b: string): number;
  loadPackages(path?: string): Promise<readonly FakePackage[]>;
  loadReleased(path?: string): Released;
  saveReleased(data: Released, path: string): void;
  stampRelease(
    released: Released,
    packages: readonly FakePackage[],
    version: string,
    next: string,
  ): Released;
  sinceOf(released: Released, name: string): string | undefined;
  resolveCount(
    key: string,
    packages: readonly FakePackage[],
    released: Released,
  ): Resolved;
  resolveVersion(key: string, released: Released): Resolved;
}

interface GeneratorModule {
  renderTools(packages: readonly unknown[], released: Released): string;
}

const facts = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'surface-facts.mjs')).href
)) as FactsModule;
const generator = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'generate-readme.mjs')).href
)) as GeneratorModule;

const read = (name: string): FakeTool => ({ name, annotations: { readOnlyHint: true } });
const write = (
  name: string,
  writeTier: 'standard' | 'irreversible' = 'standard',
): FakeTool => ({
  name,
  writeTier,
  annotations: {},
});

/** Two releases and a tool on `main` only: `a` read+write in 0.1.0, `b` added in 0.2.0. */
const PKGS: readonly FakePackage[] = [
  { id: 'a', tools: [read('r1'), read('r2'), write('w1')] },
  { id: 'b', tools: [write('d1', 'irreversible'), read('r3')] },
];
const RELEASED: Released = {
  version: '0.2.0',
  next: '0.3.0',
  live: { release: '0.2.0', reads: 2, writes: 1 },
  since: { r1: '0.1.0', w1: '0.1.0', r2: '0.2.0', d1: '0.2.0' },
};

const value = (key: string): number | string => {
  const resolved = facts.resolveCount(key, PKGS, RELEASED);
  assert.ok('value' in resolved, `${key}: ${'error' in resolved ? resolved.error : ''}`);
  return resolved.value;
};
const error = (key: string): string => {
  const resolved = facts.resolveCount(key, PKGS, RELEASED);
  assert.ok('error' in resolved, `${key} should not resolve`);
  return resolved.error;
};

describe('surface-facts count keys', () => {
  test('count main, a package, and a release', () => {
    assert.equal(value('tools'), 5);
    assert.equal(value('reads'), 3);
    assert.equal(value('writes'), 2);
    assert.equal(value('standard'), 1);
    assert.equal(value('irreversible'), 1);
    assert.equal(value('packages'), 2);
    assert.equal(value('reads:a'), 2);
    assert.equal(value('tools@released'), 4);
    assert.equal(value('tools@0.1.0'), 2);
    assert.equal(value('packages@0.1.0'), 1);
    assert.equal(value('writes:b@0.2.0'), 1);
  });

  test('derive live, unproven and unreleased from the baseline', () => {
    assert.equal(value('live'), 3);
    assert.equal(value('live-reads'), 2);
    assert.equal(value('live-writes'), 1);
    assert.equal(value('unproven@released'), 1);
    assert.equal(value('unproven-reads@released'), 0);
    assert.equal(value('unproven-writes@0.2.0'), 1);
    assert.equal(value('unproven'), 2);
    assert.equal(value('unreleased'), 1);
  });

  test('refuse a key that cannot be answered, saying why', () => {
    assert.match(error('Tools'), /malformed/u);
    assert.match(error('tools@latest'), /unknown version/u);
    assert.match(error('tools@0.3.0'), /after the latest release/u);
    assert.match(error('tools:nope'), /unknown package nope/u);
    assert.match(error('packages:a'), /takes no package/u);
    assert.match(error('live@0.2.0'), /take no package or version/u);
    assert.match(error('unproven:a'), /takes no package/u);
    assert.match(error('unproven@0.1.0'), /live run covers 0\.2\.0/u);
    assert.match(error('unreleased@0.2.0'), /takes no package or version/u);
    assert.match(error('bogus'), /unknown count metric/u);
  });

  test('resolve the two version keys and nothing else', () => {
    assert.deepEqual(facts.resolveVersion('released', RELEASED), { value: '0.2.0' });
    assert.deepEqual(facts.resolveVersion('next', RELEASED), { value: '0.3.0' });
    assert.match(
      (facts.resolveVersion('latest', RELEASED) as { error: string }).error,
      /unknown version key/u,
    );
  });

  test('order versions numerically, not as strings', () => {
    assert.ok(facts.compareVersions('1.10.0', '1.9.0') > 0);
    assert.ok(facts.compareVersions('1.0.0', '1.0.1') < 0);
    assert.equal(facts.compareVersions('2.0.0', '2.0.0'), 0);
  });
});

describe('stamping a release', () => {
  test('give every unreleased tool the new version and keep the old ones', () => {
    const stamped = facts.stampRelease(RELEASED, PKGS, '0.3.0', '0.4.0');
    assert.equal(stamped.version, '0.3.0');
    assert.equal(stamped.next, '0.4.0');
    assert.equal(facts.sinceOf(stamped, 'r3'), '0.3.0');
    assert.equal(facts.sinceOf(stamped, 'r1'), '0.1.0');
    assert.equal(facts.sinceOf(RELEASED, 'r3'), undefined, 'the input is not mutated');
  });

  test('refuse a version that is malformed or not after the last one', () => {
    assert.throws(() => facts.stampRelease(RELEASED, PKGS, '0.3', '0.4.0'), /X\.Y\.Z/u);
    assert.throws(
      () => facts.stampRelease(RELEASED, PKGS, '0.2.0', '0.4.0'),
      /not after/u,
    );
  });

  test('render the README without the unreleased sentence once everything shipped', () => {
    const released = facts.loadReleased();
    const all = facts.stampRelease(released, PACKAGES, '99.0.0', '99.1.0');
    const block = generator.renderTools(PACKAGES, all);
    assert.match(block, /all of\nthem are in the latest release, 99\.0\.0\./u);
    assert.doesNotMatch(block, /\(unreleased\)/u);
  });
});

describe('the released-surface baseline', () => {
  test('the committed baseline loads and names only tools the manifest registers', () => {
    const released = facts.loadReleased();
    const names = new Set<string>(
      PACKAGES.flatMap((pkg) => pkg.tools.map((tool) => tool.name)),
    );
    for (const name of Object.keys(released.since)) assert.ok(names.has(name), name);
  });

  test('loadPackages refuses a missing build by naming the command', async () => {
    await assert.rejects(
      facts.loadPackages(join(tmpdir(), 'no-such-manifest.js')),
      /npm run build/u,
    );
  });

  test('loadReleased rejects each malformed field, and saveReleased round-trips', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-released-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'released.json');
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [{ version: '1' }, /version must be/u],
      [{ next: 'x' }, /next must be/u],
      [{ next: '0.1.0' }, /must be after version/u],
      [{ live: { release: '0.2.0', reads: 1 } }, /must be integers/u],
      [{ live: {} }, /live\.release/u],
      [{ since: { r1: '0.9.0' } }, /since\.r1/u],
    ];
    for (const [override, pattern] of cases) {
      writeFileSync(file, JSON.stringify({ ...RELEASED, ...override }), 'utf8');
      assert.throws(() => facts.loadReleased(file), pattern);
    }

    facts.saveReleased(RELEASED, file);
    assert.deepEqual(facts.loadReleased(file), RELEASED);
    assert.ok(readFileSync(file, 'utf8').endsWith('}\n'));
  });
});
