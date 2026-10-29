// ---------------------------------------------------------------------------
// The upfront-loaded reads (D509) against the real tool surface.
//
// `mcp/client-hints.ts` names the tools that carry `anthropic/alwaysLoad`, but
// the mcp ring cannot see the tools ring, so a renamed or removed tool would
// leave a dead name behind without failing anything there. This test closes
// that gap and holds the named tools to what being upfront asks of them: a
// read, a description Claude Code does not cut, and the verb plus the Jira
// noun at the very start, where a model scanning the list looks first.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { ALWAYS_LOAD_META, ALWAYS_LOAD_TOOLS, clientHints } from '../mcp/client-hints.js';
import type { AnyToolSpec } from '../mcp/types.js';

import { PACKAGES } from './index.js';

/** Claude Code cuts an upfront tool's description at this many characters. */
const UPFRONT_DESCRIPTION_LIMIT = 4_096;

/** How much of the description has to carry the verb and the noun. */
const KEYWORD_WINDOW = 80;

const ALL_TOOLS: readonly AnyToolSpec[] = PACKAGES.flatMap((pkg) => pkg.tools);
const BUDGET = { maxResultChars: 25_000 };

test('[D509] every upfront name is a listed read', () => {
  assert.ok(ALWAYS_LOAD_TOOLS.size > 0 && ALWAYS_LOAD_TOOLS.size <= 5);
  for (const name of ALWAYS_LOAD_TOOLS) {
    const spec = ALL_TOOLS.find((tool) => tool.name === name);
    assert.ok(spec, `${name} is not a tool`);
    assert.equal(spec.annotations.readOnlyHint, true, name);
    assert.equal(spec.writeTier, undefined, name);
  }
});

test('[D509] exactly the named tools load upfront', () => {
  const upfront = ALL_TOOLS.filter(
    (spec) => clientHints(spec, BUDGET)?.[ALWAYS_LOAD_META],
  );
  assert.deepEqual(
    upfront.map((spec) => spec.name).sort(),
    [...ALWAYS_LOAD_TOOLS].sort(),
  );
});

test('[D509] an upfront description is keyword-first and fits the client cut', () => {
  for (const name of ALWAYS_LOAD_TOOLS) {
    const spec = ALL_TOOLS.find((tool) => tool.name === name);
    assert.ok(spec);
    assert.ok(spec.description.length <= UPFRONT_DESCRIPTION_LIMIT, name);
    const head = spec.description.slice(0, KEYWORD_WINDOW);
    assert.match(head, /^(Search|Count|Get|Find) /, `${name} opens with its verb`);
    assert.match(head, /\b(issues?|users?)\b/, `${name} names its Jira noun early`);
  }
});
