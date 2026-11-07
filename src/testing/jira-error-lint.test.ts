// V3-55 / D536: `createJiraError` is the only sanctioned way to build a
// `JiraError`. The eslint `no-restricted-syntax` entry enforces it; this fixture
// pins that the rule fires outside the choke point and stays quiet inside it
// and in tests.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';

const FIXTURE = [
  "import { JiraError } from './types.js';",
  '',
  'export function broken(): JiraError {',
  "  return new JiraError({ kind: 'config', message: 'raw' });",
  '}',
  '',
].join('\n');

const RULE = 'no-restricted-syntax';

async function directConstructionHits(filePath: string): Promise<string[]> {
  // The resolved config only: no parsing, so the path need not exist.
  const eslint = new ESLint();
  const config = (await eslint.calculateConfigForFile(filePath)) as {
    rules?: Record<string, unknown>;
  };
  const entries = config.rules?.[RULE];
  const selectors = Array.isArray(entries)
    ? entries.slice(1).map((entry) => (entry as { selector: string }).selector)
    : [];
  return selectors.filter((selector) => selector.includes("callee.name='JiraError'"));
}

describe('JiraError choke-point lint rule (V3-55)', () => {
  it('fires on a direct `new JiraError(...)` outside core/errors.ts', async () => {
    const eslint = new ESLint();
    const [result] = await eslint.lintText(FIXTURE, {
      filePath: 'src/mcp/registry.ts',
    });
    assert.ok(result);
    const hits = result.messages.filter(
      (message) => message.ruleId === RULE && /createJiraError/.test(message.message),
    );
    assert.equal(hits.length, 1, JSON.stringify(result.messages, null, 2));
    assert.equal(hits[0]?.line, 4);
  });

  it('is configured for every layer, and exempts only the choke point and tests', async () => {
    for (const file of [
      'src/core/http-util.ts',
      'src/api/shared.ts',
      'src/mcp/define.ts',
      'src/tools/index.ts',
    ]) {
      assert.equal((await directConstructionHits(file)).length, 1, file);
    }
    for (const file of ['src/core/errors.ts', 'src/core/errors.test.ts']) {
      assert.equal((await directConstructionHits(file)).length, 0, file);
    }
  });
});
