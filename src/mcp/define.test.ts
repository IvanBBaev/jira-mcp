import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JiraError } from '../core/types.js';
import {
  APPLY_DESCRIPTION,
  CONTROL_DESCRIPTION_BUDGET,
  PLAN_ID_DESCRIPTION,
  PROFILE_DESCRIPTION,
  TOOL_NAME_PATTERN,
  declaresKey,
  defineTool,
  outputArg,
  profileArg,
  rejectsUnknownKeys,
  toolInput,
  writeToolInput,
  z,
} from './define.js';
import { ok } from './result.js';
import type { AnyToolSpec } from './types.js';

/**
 * Builds a spec through an untyped override map so a test can inject the shapes
 * the type system forbids — which is exactly what the import-time assertions
 * exist to catch at runtime.
 */
function spec(overrides: Record<string, unknown> = {}): AnyToolSpec {
  return {
    name: 'jira_get_issue',
    title: 'Get issue',
    description: 'Fetch one issue by key or id.',
    package: 'issues',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: toolInput({ issue: z.string() }),
    handler: () => Promise.resolve(ok({})),
    ...overrides,
  } as unknown as AnyToolSpec;
}

function writeSpec(overrides: Record<string, unknown> = {}): AnyToolSpec {
  return spec({
    name: 'jira_add_comment',
    title: 'Add comment',
    description: 'Add a comment to an issue.',
    package: 'issues-write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: 'standard',
    input: writeToolInput({ issue: z.string() }),
    ...overrides,
  });
}

function assertSpecError(build: () => unknown, needle: string): void {
  assert.throws(build, (error: unknown) => {
    assert.ok(error instanceof JiraError, 'a bad spec is a JiraError');
    assert.equal(
      error.kind,
      'config',
      'a bad spec is a startup problem, not a request one',
    );
    assert.ok(
      error.message.includes(needle),
      `expected the message to mention "${needle}", got: ${error.message}`,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('a well-formed read tool passes and comes back frozen', () => {
  const tool = defineTool(spec());

  assert.equal(tool.name, 'jira_get_issue');
  assert.ok(Object.isFrozen(tool), 'the spec is frozen so nothing can retag it later');
  assert.ok(Object.isFrozen(tool.annotations));
});

test('a well-formed write tool passes with its writeTier', () => {
  const tool = defineTool(writeSpec());
  assert.equal(tool.writeTier, 'standard');
  assert.equal(tool.annotations.readOnlyHint, false);
});

// ---------------------------------------------------------------------------
// Identity assertions
// ---------------------------------------------------------------------------

test('the name must be jira_-prefixed lower snake case', () => {
  assert.ok(TOOL_NAME_PATTERN.test('jira_search'));
  assert.ok(TOOL_NAME_PATTERN.test('jira_get_issue_v2'));
  assert.ok(!TOOL_NAME_PATTERN.test('jira_'));
  assert.ok(!TOOL_NAME_PATTERN.test('jira__x'));

  for (const name of ['getIssue', 'jira-get-issue', 'jira_Get_Issue', 'jira_get_', '']) {
    assertSpecError(() => defineTool(spec({ name })), 'lowercase snake case');
  }
});

test('an empty title or description is rejected', () => {
  assertSpecError(() => defineTool(spec({ title: '   ' })), 'title is empty');
  assertSpecError(() => defineTool(spec({ description: '' })), 'description is empty');
});

test('the package must be one of the seven frozen ids', () => {
  assertSpecError(() => defineTool(spec({ package: 'issue' })), 'is not one of');
  assertSpecError(() => defineTool(spec({ package: undefined })), 'is not one of');
});

test('the handler must be callable', () => {
  assertSpecError(
    () => defineTool(spec({ handler: 'nope' })),
    'handler is not a function',
  );
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

test('each of the four annotations is mandatory', () => {
  const full = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  for (const key of Object.keys(full)) {
    const partial: Record<string, unknown> = { ...full };
    delete partial[key];
    assertSpecError(
      () => defineTool(spec({ annotations: partial })),
      `annotations.${key}`,
    );
  }
  assertSpecError(() => defineTool(spec({ annotations: undefined })), 'annotations.');
  assertSpecError(
    () => defineTool(spec({ annotations: { ...full, idempotentHint: 'yes' } })),
    'annotations.idempotentHint',
  );
});

test('a read-only tool cannot also be destructive', () => {
  assertSpecError(
    () =>
      defineTool(
        spec({
          annotations: {
            readOnlyHint: true,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        }),
      ),
    'cannot also be destructive',
  );
});

test('writeTier holds if and only if the tool is not read-only', () => {
  assertSpecError(() => defineTool(spec({ writeTier: 'standard' })), 'must not declare');
  assertSpecError(
    () => defineTool(writeSpec({ writeTier: undefined })),
    'must declare a writeTier',
  );
  assertSpecError(
    () => defineTool(writeSpec({ writeTier: 'reckless' })),
    'is not one of',
  );
});

// ---------------------------------------------------------------------------
// Strictness — probed behaviourally, never by reading zod internals
// ---------------------------------------------------------------------------

test('the strictness probe distinguishes strict from stripping objects', () => {
  assert.equal(rejectsUnknownKeys(z.object({ a: z.string() }).strict()), true);
  assert.equal(rejectsUnknownKeys(z.object({ a: z.string() })), false);
  assert.equal(rejectsUnknownKeys(z.object({}).passthrough()), false);
});

test('the probe sees through a .refine() wrapper', () => {
  const refined = toolInput({ issue: z.string() }).refine(
    (value) => value.issue.length > 0,
    'issue is required',
  );

  assert.equal(rejectsUnknownKeys(refined), true);
  assert.equal(declaresKey(refined, 'profile', 'default'), true);
  assert.equal(declaresKey(refined, 'apply', true), false);
  assert.doesNotThrow(() => defineTool(spec({ input: refined })));
});

test('an input schema that accepts unknown keys is rejected', () => {
  const loose = z.object({ issue: z.string(), profile: profileArg });
  assertSpecError(() => defineTool(spec({ input: loose })), 'accepts unknown keys');
});

test('toolInput() seals the object and injects only profile', () => {
  const schema = toolInput({ issue: z.string() });

  assert.equal(schema.safeParse({ issue: 'PROJ-1' }).success, true);
  assert.equal(schema.safeParse({ issue: 'PROJ-1', profile: 'work' }).success, true);
  assert.equal(schema.safeParse({ issue: 'PROJ-1', typo: 1 }).success, false);
  assert.equal(declaresKey(schema, 'profile', 'work'), true);
  assert.equal(declaresKey(schema, 'apply', true), false);
  assert.equal(declaresKey(schema, 'plan_id', 'p1'), false);
});

test('writeToolInput() declares the whole plan-gate control triple', () => {
  const schema = writeToolInput({ issue: z.string() });

  for (const [key, value] of [
    ['profile', 'work'],
    ['apply', true],
    ['plan_id', 'p1'],
  ] as const) {
    assert.equal(declaresKey(schema, key, value), true, `${key} must be declared`);
  }
  assert.equal(schema.safeParse({ issue: 'PROJ-1', typo: 1 }).success, false);
});

// ---------------------------------------------------------------------------
// Control fields
// ---------------------------------------------------------------------------

test('profile must be declared on every tool', () => {
  const noProfile = z.object({ issue: z.string() }).strict();
  assertSpecError(() => defineTool(spec({ input: noProfile })), '"profile"');
});

test('apply and plan_id are required on a write tool', () => {
  for (const shape of [
    z.object({ issue: z.string(), profile: profileArg }).strict(),
    z
      .object({ issue: z.string(), profile: profileArg, apply: z.boolean().optional() })
      .strict(),
  ]) {
    assertSpecError(
      () => defineTool(writeSpec({ input: shape })),
      'write tool must declare',
    );
  }
});

test('apply and plan_id are refused on a read-only tool', () => {
  assertSpecError(
    () => defineTool(spec({ input: writeToolInput({ issue: z.string() }) })),
    'write-only control field',
  );
});

test('the control-field probe survives a schema with several required arguments', () => {
  const schema = toolInput({ issue: z.string(), fields: z.array(z.string()) });
  assert.equal(declaresKey(schema, 'profile', 'work'), true);
  assert.equal(declaresKey(schema, 'nonsense', 1), false);
});

// ---------------------------------------------------------------------------
// Examples and control-field descriptions (D124)
// ---------------------------------------------------------------------------

test('[CC-1417] an example that fails its own schema, carries a control field, or is malformed is a config error', () => {
  assertSpecError(
    () => defineTool(spec({ example: { summary: '', arguments: { issue: 'ABC-1' } } })),
    'example.summary is empty',
  );
  assertSpecError(
    () => defineTool(spec({ example: { summary: 'Fetch.', arguments: ['ABC-1'] } })),
    'example.arguments is not an object',
  );
  assertSpecError(
    () => defineTool(spec({ example: { summary: 'Fetch.', arguments: null } })),
    'example.arguments is not an object',
  );
  assertSpecError(
    () =>
      defineTool(
        writeSpec({
          example: { summary: 'Add.', arguments: { issue: 'ABC-1', apply: true } },
        }),
      ),
    'control field "apply"',
  );
  assertSpecError(
    () =>
      defineTool(
        spec({
          example: { summary: 'Fetch.', arguments: { issue: 'ABC-1', profile: 'x' } },
        }),
      ),
    'control field "profile"',
  );
  assertSpecError(
    () => defineTool(spec({ example: { summary: 'Fetch.', arguments: { issue: 7 } } })),
    'do not satisfy the input schema',
  );
  assertSpecError(
    () =>
      defineTool(spec({ example: { summary: 'Fetch.', arguments: { nonsense: 'x' } } })),
    'do not satisfy the input schema',
  );
});

test('a valid example is kept and frozen with the spec', () => {
  const tool = defineTool(
    spec({ example: { summary: 'Fetch ABC-1.', arguments: { issue: 'ABC-1' } } }),
  );
  assert.deepEqual(tool.example, {
    summary: 'Fetch ABC-1.',
    arguments: { issue: 'ABC-1' },
  });
  assert.ok(Object.isFrozen(tool.example));
  assert.ok(Object.isFrozen(tool.example?.arguments));

  const plain = defineTool(spec());
  assert.equal(plain.example, undefined);
});

test('[CC-1418] the control-field descriptions stay within the per-schema budget', () => {
  for (const [name, text] of [
    ['profile', PROFILE_DESCRIPTION],
    ['apply', APPLY_DESCRIPTION],
    ['plan_id', PLAN_ID_DESCRIPTION],
  ] as const) {
    assert.ok(
      text.length <= CONTROL_DESCRIPTION_BUDGET,
      `${name}: ${String(text.length)} chars exceeds ${String(CONTROL_DESCRIPTION_BUDGET)}`,
    );
    assert.ok(text.trim() === text && text.endsWith('.'), `${name}: a full sentence`);
  }
  assert.match(PROFILE_DESCRIPTION, /JIRA_LOCK_PROFILE/);
  assert.match(APPLY_DESCRIPTION, /JIRA_WRITE_MODE=apply/);
  assert.match(PLAN_ID_DESCRIPTION, /apply: true/);
});

test('[CC-1562] fileOutput is a read-only declaration that must come with the output argument', () => {
  const tool = defineTool(
    spec({
      input: toolInput({ issue: z.string(), output: outputArg }),
      fileOutput: { rows: 'comments' },
    }),
  );
  assert.deepEqual(tool.fileOutput, { rows: 'comments' });

  assertSpecError(
    () => defineTool(spec({ fileOutput: { rows: 'comments' } })),
    'must take the "output" argument',
  );
  assertSpecError(
    () =>
      defineTool(
        spec({
          input: toolInput({ issue: z.string(), output: outputArg }),
          fileOutput: { rows: '' },
        }),
      ),
    'fileOutput.rows must name',
  );
  assertSpecError(
    () =>
      defineTool(
        writeSpec({
          input: writeToolInput({ issue: z.string(), output: outputArg }),
          fileOutput: { rows: 'comments' },
        }),
      ),
    'only a read-only tool',
  );
  assertSpecError(
    () =>
      defineTool(spec({ input: toolInput({ issue: z.string(), output: outputArg }) })),
    'does not declare fileOutput',
  );
});
