// Tests for the JSON Schema trim (CC-1416, D124): what `tools/list` and the
// per-tool reference drop from the converter's output, and what they keep.

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROFILE_DESCRIPTION, defineTool, toolInput, z } from './define.js';
import { ok } from './result.js';
import { toInputSchema, trimJsonSchema } from './schema.js';

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const SAFE_MIN = Number.MIN_SAFE_INTEGER;

test('[CC-1416] trimJsonSchema drops $schema and the safe-integer bounds at every depth', () => {
  const trimmed = trimJsonSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      sprintId: { type: 'integer', minimum: 1, maximum: SAFE_MAX },
      offset: { type: 'integer', minimum: SAFE_MIN, maximum: SAFE_MAX },
      page: { type: 'integer', minimum: 0, maximum: 1000 },
      ids: {
        type: 'array',
        items: { type: 'integer', minimum: SAFE_MIN, maximum: SAFE_MAX },
        maxItems: 100,
      },
      nested: { anyOf: [{ type: 'integer', maximum: SAFE_MAX }, { type: 'null' }] },
    },
    required: ['sprintId'],
    additionalProperties: false,
  });

  assert.deepEqual(trimmed, {
    type: 'object',
    properties: {
      sprintId: { type: 'integer', minimum: 1 },
      offset: { type: 'integer' },
      page: { type: 'integer', minimum: 0, maximum: 1000 },
      ids: { type: 'array', items: { type: 'integer' }, maxItems: 100 },
      nested: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    },
    required: ['sprintId'],
    additionalProperties: false,
  });
});

test('trimJsonSchema is pure and passes scalars and arrays through', () => {
  const input = { $schema: 'x', type: 'string', minLength: 1 };
  const before = JSON.stringify(input);
  assert.deepEqual(trimJsonSchema(input), { type: 'string', minLength: 1 });
  assert.equal(JSON.stringify(input), before, 'the converter output is not mutated');

  assert.equal(trimJsonSchema('text'), 'text');
  assert.equal(trimJsonSchema(null), null);
  assert.equal(trimJsonSchema(7), 7);
  assert.deepEqual(trimJsonSchema([1, { $schema: 'x' }]), [1, {}]);
});

test('toInputSchema keeps descriptions, real bounds and strictness, nothing else', () => {
  const tool = defineTool({
    name: 'jira_fx_probe',
    title: 'Probe',
    description: 'A probe.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: toolInput({
      sprintId: z.number().int().min(1).describe('The sprint.'),
      offset: z.number().int().optional(),
    }),
    handler: () => Promise.resolve(ok({})),
  });

  const schema = toInputSchema(tool) as Record<string, unknown>;
  const text = JSON.stringify(schema);
  assert.ok(!('$schema' in schema), 'no $schema keyword');
  assert.ok(!text.includes(String(SAFE_MAX)), 'no MAX_SAFE_INTEGER bound');
  assert.ok(!text.includes(String(SAFE_MIN)), 'no MIN_SAFE_INTEGER bound');

  const properties = schema['properties'] as Record<string, Record<string, unknown>>;
  assert.equal(properties['sprintId']?.['type'], 'integer');
  assert.equal(properties['sprintId']?.['minimum'], 1);
  assert.equal(properties['sprintId']?.['description'], 'The sprint.');
  assert.equal(properties['offset']?.['type'], 'integer');
  assert.equal(properties['offset']?.['minimum'], undefined);
  assert.equal(properties['profile']?.['description'], PROFILE_DESCRIPTION);
  assert.equal(schema['additionalProperties'], false);
  assert.deepEqual(schema['required'], ['sprintId']);
});
