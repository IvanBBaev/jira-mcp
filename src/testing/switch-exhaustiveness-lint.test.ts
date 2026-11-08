// V3-59 / D537 / TSN-08: a switch over a union must name every member, and a
// `default:` arm does not count as coverage. This fixture pins that the rule
// fires when a union grows a member a switch forgot — even behind a default —
// and stays quiet once every member has its case.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';

const RULE = '@typescript-eslint/switch-exhaustiveness-check';

// Linted as the text of an existing module, so the type-aware project service
// knows the file; the fixture does not import anything.
const HOST_FILE = 'src/core/assert-never.ts';

function fixture(cases: readonly string[], withDefault: boolean): string {
  return [
    "type Mode = 'basic' | 'oauth' | 'pat' | 'ghost';",
    '',
    'export function describeMode(mode: Mode): string {',
    '  switch (mode) {',
    ...cases.flatMap((name) => [`    case '${name}':`, `      return '${name}';`]),
    ...(withDefault ? ['    default:', "      return 'other';"] : []),
    '  }',
    '}',
    '',
  ].join('\n');
}

async function hits(text: string): Promise<string[]> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(text, { filePath: HOST_FILE });
  assert.ok(result);
  return result.messages
    .filter((message) => message.ruleId === RULE)
    .map((message) => message.message);
}

describe('switch exhaustiveness lint rule (V3-59)', () => {
  it('fires on a union member the switch forgot', async () => {
    const found = await hits(fixture(['basic', 'oauth', 'pat'], false));
    assert.equal(found.length, 1, found.join('\n'));
    assert.match(found[0] ?? '', /"ghost"/);
  });

  it('does not let a default arm stand in for the missing member', async () => {
    const found = await hits(fixture(['basic', 'oauth', 'pat'], true));
    assert.equal(found.length, 1, found.join('\n'));
    assert.match(found[0] ?? '', /"ghost"/);
  });

  it('stays quiet once every member has its case', async () => {
    assert.deepEqual(await hits(fixture(['basic', 'oauth', 'pat', 'ghost'], false)), []);
  });
});
