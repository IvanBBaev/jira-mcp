import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { COMPLETION_MAX_VALUES, completionOf, createCompleter } from './completions.js';
import { EXPORT_TEMPLATE } from './exports.js';
import { TOOL_REFERENCE_TEMPLATE } from './resources.js';
import type { PromptSpec } from './types.js';

const PREFLIGHT: PromptSpec = {
  name: 'jira_fx_preflight',
  title: 'Preflight',
  description: 'x',
  requires: ['jira_fx_find'],
  arguments: [
    { name: 'jql', description: 'x', required: true },
    {
      name: 'action',
      description: 'x',
      required: false,
      values: ['edit', 'transition', 'delete'],
    },
  ],
  example: { jql: 'x' },
  render: () => 'Call jira_fx_find.',
};

const completer = createCompleter({
  prompts: [PREFLIGHT],
  toolNames: ['jira_search', 'jira_get_issue', 'jira_get_comments', 'jira_search'],
});

function invalid(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof McpError, String(error));
    assert.equal(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, pattern);
    return true;
  };
}

const values = (result: ReturnType<typeof completer.complete>): readonly string[] =>
  result.completion.values;

test('[CC-1570] a prompt argument completes to its declared values by prefix', () => {
  const ref = { type: 'ref/prompt', name: 'jira_fx_preflight' } as const;
  assert.deepEqual(
    values(completer.complete({ ref, argument: { name: 'action', value: '' } })),
    ['edit', 'transition', 'delete'],
  );
  assert.deepEqual(
    completer.complete({ ref, argument: { name: 'action', value: 'T' } }),
    { completion: { values: ['transition'], total: 1, hasMore: false } },
  );
  // A free-text argument has nothing to offer.
  assert.deepEqual(
    values(completer.complete({ ref, argument: { name: 'jql', value: 'pro' } })),
    [],
  );
  assert.throws(
    () => completer.complete({ ref, argument: { name: 'nope', value: '' } }),
    invalid(/has no argument "nope"/),
  );
  assert.throws(
    () =>
      completer.complete({
        ref: { type: 'ref/prompt', name: 'jira_fx_gone' },
        argument: { name: 'action', value: '' },
      }),
    invalid(/Unknown prompt "jira_fx_gone"/),
  );
});

test('[CC-1571] the tool template completes every manifest tool name, sorted', () => {
  const ref = { type: 'ref/resource', uri: TOOL_REFERENCE_TEMPLATE } as const;
  assert.deepEqual(
    values(completer.complete({ ref, argument: { name: 'name', value: 'jira_get' } })),
    ['jira_get_comments', 'jira_get_issue'],
  );
  assert.deepEqual(
    values(completer.complete({ ref, argument: { name: 'name', value: '' } })),
    ['jira_get_comments', 'jira_get_issue', 'jira_search'],
  );
  assert.deepEqual(
    values(completer.complete({ ref, argument: { name: 'other', value: '' } })),
    [],
  );
  // Export names live only on disk: stage A never lists them.
  assert.deepEqual(
    values(
      completer.complete({
        ref: { type: 'ref/resource', uri: EXPORT_TEMPLATE },
        argument: { name: 'name', value: 'jira-export' },
      }),
    ),
    [],
  );
  assert.throws(
    () =>
      completer.complete({
        ref: { type: 'ref/resource', uri: 'jira://nowhere/{x}' },
        argument: { name: 'x', value: '' },
      }),
    invalid(/Unknown resource template/),
  );
});

test('[CC-1572] a completion stops at the protocol cap and says how many matched', () => {
  const many = Array.from(
    { length: COMPLETION_MAX_VALUES + 5 },
    (_, i) => `v${String(i)}`,
  );
  const result = completionOf(many, 'V');
  assert.equal(result.completion.values.length, COMPLETION_MAX_VALUES);
  assert.equal(result.completion.total, COMPLETION_MAX_VALUES + 5);
  assert.equal(result.completion.hasMore, true);
});
