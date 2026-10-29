// ---------------------------------------------------------------------------
// One page-size behaviour across the whole tool surface (D508).
//
// Before D508 an over-cap `maxResults` was clamped by some packages, refused by
// the schema in others and passed through by a third. The shared argument in
// `mcp/tool-helpers.ts` makes the schema accept any positive integer and leaves
// the cap to the handler, which clamps and says so. This test holds every tool
// that takes a `maxResults` to that: no schema maximum anywhere, so a package
// that hand-rolls `.max()` again fails here.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnyToolSpec } from '../mcp/types.js';

import { PACKAGES } from './index.js';

const ALL_TOOLS: readonly AnyToolSpec[] = PACKAGES.flatMap((pkg) => pkg.tools);

/** The `maxResults` member of a tool's input object, when it has one. */
function maxResultsOf(
  spec: AnyToolSpec,
): { safeParse(value: unknown): { success: boolean } } | undefined {
  const shape = (spec.input as { shape?: Record<string, unknown> }).shape;
  const arg = shape?.['maxResults'];
  return arg === undefined
    ? undefined
    : (arg as { safeParse(value: unknown): { success: boolean } });
}

test('[CC-5058] no tool refuses an over-cap maxResults at the schema', () => {
  const capped = ALL_TOOLS.filter((spec) => maxResultsOf(spec) !== undefined);
  // Search, users, the issue lists, agile, collab and filters at least.
  assert.ok(capped.length >= 12, `only ${String(capped.length)} tools take maxResults`);
  for (const spec of capped) {
    const arg = maxResultsOf(spec);
    assert.equal(arg?.safeParse(1_000_000).success, true, spec.name);
    assert.equal(arg?.safeParse(0).success, false, spec.name);
  }
});
