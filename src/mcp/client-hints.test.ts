import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLIENT_MAX_RESULT_CHARS,
  MAX_RESULT_SIZE_META,
  REQUIRES_USER_INTERACTION_META,
  TEXT_CHANNEL_SLACK_CHARS,
  clientHints,
} from './client-hints.js';
import { defineTool, toolInput, writeToolInput, z } from './define.js';
import { ok } from './result.js';
import type { AnyToolSpec, WriteTier } from './types.js';

const DEFAULT_BUDGET = { maxResultChars: 25_000 };

function readTool(): AnyToolSpec {
  return defineTool({
    name: 'jira_fx_read',
    title: 'Read',
    description: 'Reads an issue.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: toolInput({ issue: z.string() }),
    handler: () => Promise.resolve(ok({})),
  });
}

function writeTool(tier: WriteTier): AnyToolSpec {
  return defineTool({
    name: 'jira_fx_write',
    title: 'Write',
    description: 'Writes an issue.',
    package: tier === 'irreversible' ? 'issues-delete' : 'issues-write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: tier === 'irreversible',
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: tier,
    input: writeToolInput({ issue: z.string() }),
    handler: () => Promise.resolve(ok({})),
  });
}

test('[CC-1456] only the irreversible tier forces a prompt on every call', () => {
  assert.deepEqual(clientHints(writeTool('irreversible'), DEFAULT_BUDGET), {
    [REQUIRES_USER_INTERACTION_META]: true,
  });
  // A standard write already has the plan/apply gate and an allow rule may
  // legitimately cover it; a read never needs the ceremony.
  assert.equal(clientHints(writeTool('standard'), DEFAULT_BUDGET), undefined);
  assert.equal(clientHints(readTool(), DEFAULT_BUDGET), undefined);
});

test('[CC-1457] the default budget stays under the client threshold, so no size hint', () => {
  // 25 000 + slack is far below Claude Code's 50 000 default: declaring a size
  // would only add bytes to tools/list.
  assert.equal(clientHints(readTool(), DEFAULT_BUDGET), undefined);
  assert.equal(clientHints(readTool(), { maxResultChars: 45_904 }), undefined);
});

test('[CC-1458] a raised budget raises the client threshold by the text-channel slack', () => {
  const hints = clientHints(readTool(), { maxResultChars: 120_000 });
  assert.deepEqual(hints, { [MAX_RESULT_SIZE_META]: 120_000 + TEXT_CHANNEL_SLACK_CHARS });
  // Every tool gets it — the budget is server-wide, not per tool.
  assert.deepEqual(clientHints(writeTool('irreversible'), { maxResultChars: 120_000 }), {
    [REQUIRES_USER_INTERACTION_META]: true,
    [MAX_RESULT_SIZE_META]: 120_000 + TEXT_CHANNEL_SLACK_CHARS,
  });
});

test('[CC-1459] the size hint is capped at the client ceiling', () => {
  const hints = clientHints(readTool(), { maxResultChars: 10_000_000 });
  assert.deepEqual(hints, { [MAX_RESULT_SIZE_META]: CLIENT_MAX_RESULT_CHARS });
});
