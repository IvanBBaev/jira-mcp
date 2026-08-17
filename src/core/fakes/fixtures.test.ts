// The fixture loader, and the wiring that finally connects `test/fixtures/` to
// `createFakeJiraRequest`'s long-dangling `loadFixture` hook (TESTING.md
// §Mocking tiers). The corpus-wide PII lint lives in
// `src/testing/fixture-pii.test.ts`; this file is about the plumbing.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeJiraRequest, jiraOk } from './fakeJiraRequest.js';
import {
  createFixtureLoader,
  FIXTURES_DIR,
  fixturesDirExists,
  listFixtureFiles,
  readFixtureJson,
  REPO_ROOT,
  repoFixtureLoader,
} from './fixtures.js';

/** A corpus in a temp dir, so the loader's rules can be tested without files. */
function withCorpus(
  files: Readonly<Record<string, unknown>>,
  body: (dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'jira-mcp-fixtures-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, ...`${name}.json`.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, `${JSON.stringify(content, null, 2)}\n`);
    }
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the corpus is located from the module, not from process.cwd()', () => {
  // The runner may be started from anywhere; this file executes as
  // build/core/fakes/fixtures.test.js, three levels down.
  assert.equal(FIXTURES_DIR, join(REPO_ROOT, 'test', 'fixtures'));
  assert.ok(fixturesDirExists(), `expected a corpus at ${FIXTURES_DIR}`);
  assert.equal(fixturesDirExists(join(REPO_ROOT, 'test', 'no-such-dir')), false);
});

test('listFixtureFiles returns sorted, corpus-relative, /-separated json paths', () => {
  const files = listFixtureFiles();
  assert.ok(files.length > 0, 'the committed corpus must not be empty');
  for (const file of files) {
    assert.ok(file.endsWith('.json'), `${file} is not a .json file`);
    assert.ok(!file.startsWith('/'), `${file} is not corpus-relative`);
    assert.ok(!file.includes('\\'), `${file} must use / on every platform`);
  }
  assert.deepEqual(files, [...files].sort(), 'listing must be stable/sorted');
  // A missing directory is empty, not an exception — the caller judges emptiness.
  assert.deepEqual(listFixtureFiles(join(REPO_ROOT, 'test', 'no-such-dir')), []);
});

test('the fake loads a committed fixture through the injected loader', async () => {
  const fake = createFakeJiraRequest({ loadFixture: repoFixtureLoader });
  const document = fake.fixture('errors/rate-limited-429');

  assert.ok(document !== null && typeof document === 'object');
  const record = document as Record<string, unknown>;
  assert.equal(record.scenario, 'rate-limited-429');
  assert.equal(record.synthetic, true);
  assert.equal(record.site, 'example.atlassian.net');

  // And it is usable as a canned body, which is the whole point of the hook.
  const exchanges = record.exchanges as { response: { status: number } }[];
  const first = exchanges[0];
  assert.ok(first !== undefined, 'the fixture must carry at least one exchange');
  fake.on('POST /rest/api/3/search/jql', jiraOk({}, { status: first.response.status }));
  const res = await fake.fn({ method: 'POST', path: '/search/jql' });
  assert.equal(res.status, 429);
});

test('a fixture the fake cannot find is a test failure, never {}', () => {
  const fake = createFakeJiraRequest({ loadFixture: repoFixtureLoader });
  assert.throws(
    () => fake.fixture('search/jql-page-1'),
    (error: Error) => {
      assert.match(error.message, /not found under/);
      // The message has to be actionable: it names the corpus and its contents.
      assert.match(error.message, /rate-limited-429/);
      assert.match(error.message, /not a fallback to \{\}/);
      return true;
    },
  );
});

test('a fixture name cannot escape the corpus', () => {
  withCorpus({ ok: { a: 1 } }, (dir) => {
    const load = createFixtureLoader({ dir });
    assert.throws(() => load('../package'), /escapes the corpus/);
    assert.throws(() => load('../../etc/passwd'), /escapes the corpus/);
    assert.deepEqual(load('ok'), { a: 1 });
  });
});

test('every load returns a fresh clone, so one test cannot poison the next', () => {
  withCorpus({ 'page/one': { issues: [{ key: 'EX-1' }] } }, (dir) => {
    const load = createFixtureLoader({ dir });
    const first = load('page/one') as { issues: { key: string }[] };
    const issue = first.issues[0];
    assert.ok(issue !== undefined);
    issue.key = 'MUTATED';
    first.issues.push({ key: 'EX-2' });

    const second = load('page/one');
    assert.deepEqual(second, { issues: [{ key: 'EX-1' }] });
    assert.notEqual(first, second);
  });
});

test('nested names resolve, and the empty-corpus message says so', () => {
  withCorpus({ 'deep/nest/body': { ok: true } }, (dir) => {
    assert.deepEqual(createFixtureLoader({ dir })('deep/nest/body'), { ok: true });
    assert.deepEqual(listFixtureFiles(dir), ['deep/nest/body.json']);
  });
  withCorpus({}, (dir) => {
    assert.throws(() => createFixtureLoader({ dir })('anything'), /corpus is empty/);
  });
});

test('a malformed fixture names itself instead of failing somewhere else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jira-mcp-fixtures-'));
  try {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ "not": json }');
    assert.throws(() => readFixtureJson(broken), /broken\.json is not valid JSON/);
    assert.throws(
      () => createFixtureLoader({ dir })('broken'),
      /broken\.json is not valid JSON/,
    );
    assert.throws(
      () => readFixtureJson(join(dir, 'absent.json')),
      /cannot read .*absent\.json/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
