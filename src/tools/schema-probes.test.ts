// ---------------------------------------------------------------------------
// The schema half of the tool-spec contract, proved over the whole manifest
// (D519, CC-5120–5123).
//
// `defineTool` used to probe every input schema when the manifest module was
// imported — on every server start, re-proving what the gate had already
// proved. Those probes now live in `checkToolSchema` and run here instead, over
// the manifest as tooling sees it AND as `main()` binds it (the report source,
// a media dir and a report dir change which factories build the core,
// attachments and portfolio tools). A malformed schema therefore still fails
// `npm run check`, which is where it always had to surface.
//
// It lives in the tools ring because only a composition root may see the
// manifest (eslint layer zones).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkToolSchema } from '../mcp/define.js';
import { toInputSchema } from '../mcp/schema.js';
import type { AnyToolSpec, PackageSpec } from '../mcp/types.js';

import { createPackages, PACKAGES } from './index.js';

const bound = createPackages(
  () => {
    throw new Error('the report is never read by a schema probe');
  },
  { mediaDir: '/tmp/jira-mcp-media', reportDir: '/tmp/jira-mcp-reports' },
);

function specsOf(manifest: readonly PackageSpec[]): readonly AnyToolSpec[] {
  return manifest.flatMap((pkg) => pkg.tools);
}

test('[CC-5120] every tool in the unbound manifest passes the schema probes', () => {
  const specs = specsOf(PACKAGES);
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    assert.doesNotThrow(() => checkToolSchema(spec), `tool ${spec.name}`);
  }
});

test('[CC-5121] every tool in the manifest main() binds passes the schema probes', () => {
  const specs = specsOf(bound);
  assert.deepEqual(
    specs.map((spec) => spec.name),
    specsOf(PACKAGES).map((spec) => spec.name),
    'the bound manifest lists the same tools in the same order',
  );
  for (const spec of specs) {
    assert.doesNotThrow(() => checkToolSchema(spec), `tool ${spec.name}`);
  }
});

test('[CC-5122] every input schema converts, once per spec, to one frozen tree', () => {
  for (const spec of specsOf(PACKAGES)) {
    const first = toInputSchema(spec);
    assert.equal(toInputSchema(spec), first, `tool ${spec.name} is memoised`);
    assert.ok(Object.isFrozen(first), `tool ${spec.name} schema is frozen`);
    const properties = (first as { properties?: object }).properties;
    assert.ok(properties === undefined || Object.isFrozen(properties));
  }
});
