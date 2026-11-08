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

const values = async (
  result: ReturnType<typeof completer.complete>,
): Promise<readonly string[]> => (await result).completion.values;

test('[CC-1570] a prompt argument completes to its declared values by prefix', async () => {
  const ref = { type: 'ref/prompt', name: 'jira_fx_preflight' } as const;
  assert.deepEqual(
    await values(completer.complete({ ref, argument: { name: 'action', value: '' } })),
    ['edit', 'transition', 'delete'],
  );
  assert.deepEqual(
    await completer.complete({ ref, argument: { name: 'action', value: 'T' } }),
    { completion: { values: ['transition'], total: 1, hasMore: false } },
  );
  // A free-text argument has nothing to offer.
  assert.deepEqual(
    await values(completer.complete({ ref, argument: { name: 'jql', value: 'pro' } })),
    [],
  );
  await assert.rejects(
    completer.complete({ ref, argument: { name: 'nope', value: '' } }),
    invalid(/has no argument "nope"/),
  );
  await assert.rejects(
    completer.complete({
      ref: { type: 'ref/prompt', name: 'jira_fx_gone' },
      argument: { name: 'action', value: '' },
    }),
    invalid(/Unknown prompt "jira_fx_gone"/),
  );
});

test('[CC-1571] the tool template completes every manifest tool name, sorted', async () => {
  const ref = { type: 'ref/resource', uri: TOOL_REFERENCE_TEMPLATE } as const;
  assert.deepEqual(
    await values(
      completer.complete({ ref, argument: { name: 'name', value: 'jira_get' } }),
    ),
    ['jira_get_comments', 'jira_get_issue'],
  );
  assert.deepEqual(
    await values(completer.complete({ ref, argument: { name: 'name', value: '' } })),
    ['jira_get_comments', 'jira_get_issue', 'jira_search'],
  );
  assert.deepEqual(
    await values(completer.complete({ ref, argument: { name: 'other', value: '' } })),
    [],
  );
  // Export names live only on disk: stage A never lists them.
  assert.deepEqual(
    await values(
      completer.complete({
        ref: { type: 'ref/resource', uri: EXPORT_TEMPLATE },
        argument: { name: 'name', value: 'jira-export' },
      }),
    ),
    [],
  );
  await assert.rejects(
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

const PROJECT_PROMPT: PromptSpec = {
  name: 'jira_fx_board',
  title: 'Board',
  description: 'x',
  requires: ['jira_fx_find'],
  arguments: [
    {
      name: 'project',
      description: 'x',
      required: true,
      pattern: /[A-Z][A-Z0-9_]{1,49}/,
      maxLength: 50,
      completion: 'projectKey',
    },
    { name: 'issue', description: 'x', required: false },
  ],
  example: { project: 'ABC' },
  render: () => 'Call jira_fx_find.',
};

test('[CC-5397] a projectKey argument completes to the live keys it would accept', async () => {
  let reads = 0;
  const live = createCompleter({
    prompts: [PROJECT_PROMPT],
    toolNames: [],
    projectKeys: () => {
      reads += 1;
      // `a1` and `X` fail the argument's own pattern: never offered.
      return Promise.resolve(['ABC', 'ABD', 'XYZ', 'a1', 'X']);
    },
  });
  const ref = { type: 'ref/prompt', name: 'jira_fx_board' } as const;
  assert.deepEqual(
    await live.complete({ ref, argument: { name: 'project', value: 'ab' } }),
    { completion: { values: ['ABC', 'ABD'], total: 2, hasMore: false } },
  );
  assert.deepEqual(
    (await live.complete({ ref, argument: { name: 'project', value: '' } })).completion
      .values,
    ['ABC', 'ABD', 'XYZ'],
  );
  // Another argument of the same prompt does not touch the source.
  assert.deepEqual(
    (await live.complete({ ref, argument: { name: 'issue', value: 'A' } })).completion
      .values,
    [],
  );
  assert.equal(reads, 2);
});

test('[CC-5398] without a source a projectKey argument completes to nothing', async () => {
  const off = createCompleter({ prompts: [PROJECT_PROMPT], toolNames: [] });
  const result = await off.complete({
    ref: { type: 'ref/prompt', name: 'jira_fx_board' },
    argument: { name: 'project', value: 'A' },
  });
  assert.deepEqual(result, { completion: { values: [], total: 0, hasMore: false } });
});
