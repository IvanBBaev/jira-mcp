import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import { ENVELOPE_OUTPUT_SCHEMA } from './output-schema.js';
import { err, ok, renderResult } from './result.js';
import type { ToolResult } from './types.js';

const validate = new AjvJsonSchemaValidator().getValidator(ENVELOPE_OUTPUT_SCHEMA ?? {});

/** What a client receives as `structuredContent` for `result` at `budget`. */
function emitted(result: ToolResult<unknown>, budget = 25_000): unknown {
  return renderResult(result, { maxResultChars: budget, redact: (v) => v })
    .structuredContent;
}

const ERROR = {
  kind: 'not_found',
  message: 'Issue ABC-1 does not exist.',
  retryable: false,
  httpStatus: 404,
} as const;

const PAGE = { issues: Array.from({ length: 40 }, (_, i) => ({ key: `ABC-${i}` })) };

test('[CC-1461] every envelope shape the renderer emits passes the advertised schema', () => {
  const cases: Record<string, unknown> = {
    success: emitted(ok({ key: 'ABC-1' })),
    'success, untrusted with hint': emitted(ok({ summary: 'x' }, { untrusted: true })),
    failure: emitted(err(ERROR)),
    'failure, untrusted': emitted(err(ERROR, { untrusted: true })),
    'budget truncation': emitted(ok(PAGE), 300),
    'item too large': emitted(ok({ description: 'y'.repeat(2_000) }), 600),
    'the floor, data gone': emitted(ok(PAGE), 5),
    'null data': emitted(ok(null)),
  };
  for (const [name, envelope] of Object.entries(cases)) {
    const outcome = validate(envelope);
    assert.equal(outcome.valid, true, `${name}: ${outcome.errorMessage ?? ''}`);
  }
});

test('[CC-1462] the schema still rejects what is not an envelope', () => {
  for (const bad of [
    {},
    { ok: 'yes' },
    { ok: true, _untrusted: false },
    { ok: false, hints: {} },
  ]) {
    assert.equal(validate(bad).valid, false, JSON.stringify(bad));
  }
});

test('[CC-1463] the schema stays one shallow object, so tools/list pays little for it', () => {
  // 61 tools carry the same schema; the field-by-field draft cost 786 bytes
  // each, a third of the list (D131).
  assert.ok(JSON.stringify(ENVELOPE_OUTPUT_SCHEMA).length <= 256);
  assert.ok(Object.isFrozen(ENVELOPE_OUTPUT_SCHEMA));
});
