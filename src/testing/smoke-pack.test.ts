// Suite for the packed-tarball smoke (V3-75): the pure helpers inside
// `scripts/smoke-pack.mjs`, plus the facts the CI job depends on.
//
// The smoke itself is not run here: `npm install` asks the registry, and this
// suite runs behind the network fence. The script is reached with a dynamic
// `import()` of a `file:` URL, for the reasons `./record-fixture.test.ts`
// gives; it only installs when it is the entry point, so importing it here
// does nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

interface Expected {
  readonly version: string;
  readonly tools: number;
}

interface SmokeModule {
  readonly LOWER_BOUND_PACKAGE: string;
  readonly PROTOCOL_VERSION: string;
  lowerBound(range: string): string;
  consumerManifest(overrides?: Record<string, string>): Record<string, unknown>;
  checkHandshake(responses: Map<number, unknown>, expected: Expected): string[];
}

const SCRIPT_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'smoke-pack.mjs')).href;
const smoke = (await import(SCRIPT_URL)) as SmokeModule;

const EXPECTED: Expected = { version: '1.1.0', tools: 3 };

function initOk(version = '1.1.0', capabilities: unknown = { tools: {} }) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: smoke.PROTOCOL_VERSION,
      capabilities,
      serverInfo: { name: 'jira-mcp-ai', version },
    },
  };
}

function listOk(count = 3, extra: Record<string, unknown> = {}) {
  const tools = Array.from({ length: count }, (_, i) => ({ name: `jira_t${i}` }));
  return { jsonrpc: '2.0', id: 2, result: { tools, ...extra } };
}

const responses = (...messages: unknown[]) =>
  new Map(messages.map((m) => [(m as { id: number }).id, m]));

describe('smoke-pack lowerBound', () => {
  test('caret, tilde, >= and exact ranges give their floor', () => {
    assert.equal(smoke.lowerBound('^1.32.1'), '1.32.1');
    assert.equal(smoke.lowerBound('~1.32.1'), '1.32.1');
    assert.equal(smoke.lowerBound('>=1.30.0'), '1.30.0');
    assert.equal(smoke.lowerBound('>= 1.30.0'), '1.30.0');
    assert.equal(smoke.lowerBound('1.32.1'), '1.32.1');
    assert.equal(smoke.lowerBound(' ^2.0.0-rc.1 '), '2.0.0-rc.1');
  });

  test('a range with no single obvious floor throws instead of guessing', () => {
    for (const range of [
      '1.x',
      '*',
      'latest',
      '^1.2 || ^2.0.0',
      '1.0.0 - 2.0.0',
      '^1.2',
      '',
    ]) {
      assert.throws(() => smoke.lowerBound(range), /cannot derive a lower bound/u, range);
    }
  });

  test('the declared SDK range has a derivable floor', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const range = pkg.dependencies[smoke.LOWER_BOUND_PACKAGE];
    assert.ok(
      range !== undefined,
      `${smoke.LOWER_BOUND_PACKAGE} is a runtime dependency`,
    );
    assert.match(smoke.lowerBound(range), /^\d+\.\d+\.\d+/u);
  });
});

describe('smoke-pack consumerManifest', () => {
  test('is an empty private project, with overrides only when asked', () => {
    const plain = smoke.consumerManifest();
    assert.equal(plain.private, true);
    assert.equal('overrides' in plain, false);
    assert.equal('dependencies' in plain, false);
    assert.deepEqual(smoke.consumerManifest({ x: '1.0.0' }).overrides, { x: '1.0.0' });
  });
});

describe('smoke-pack checkHandshake', () => {
  test('a clean handshake has no failures', () => {
    assert.deepEqual(smoke.checkHandshake(responses(initOk(), listOk()), EXPECTED), []);
  });

  test('missing responses are reported', () => {
    assert.deepEqual(smoke.checkHandshake(new Map(), EXPECTED), [
      'no response to initialize',
      'no response to tools/list',
    ]);
  });

  test('a wrong version, a missing tools capability and a wrong count each fail', () => {
    const failures = smoke.checkHandshake(
      responses(initOk('1.0.0', {}), listOk(2)),
      EXPECTED,
    );
    assert.equal(failures.length, 3);
    assert.match(failures[0] ?? '', /version "1\.0\.0", expected 1\.1\.0/u);
    assert.match(failures[1] ?? '', /tools capability/u);
    assert.match(failures[2] ?? '', /returned 2 tools, expected 3/u);
  });

  test('JSON-RPC errors and a paginated list fail', () => {
    const error = { code: -32603, message: 'boom' };
    assert.deepEqual(
      smoke
        .checkHandshake(
          responses({ jsonrpc: '2.0', id: 1, error }, { jsonrpc: '2.0', id: 2, error }),
          EXPECTED,
        )
        .map((f) => f.split(':')[0]),
      ['initialize failed', 'tools/list failed'],
    );
    assert.deepEqual(
      smoke.checkHandshake(responses(initOk(), listOk(3, { nextCursor: 'c' })), EXPECTED),
      ['tools/list paginated; the smoke expects one page'],
    );
    assert.deepEqual(
      smoke.checkHandshake(
        responses(initOk(), { jsonrpc: '2.0', id: 2, result: {} }),
        EXPECTED,
      ),
      ['tools/list returned no tools array'],
    );
  });
});

describe('smoke-pack in CI', () => {
  test('ci.yml runs the smoke on the resolved and the lower-bound SDK', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /node scripts\/smoke-pack\.mjs --tarball/u);
    assert.match(ci, /--lower-bound/u);
  });
});
