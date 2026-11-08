// ---------------------------------------------------------------------------
// mcp/write-pipeline.test.ts — the write pipeline is one constructor and one
// pinned layer order (D523–D524, ARC-07).
//
// The journal and recent-writes behaviour stays proven where it always was
// (`server.test.ts`, `tools/issues-delete.test.ts`); this file pins what the
// pipeline adds: which layers run, in which order, and that production builds a
// write gate in exactly one place.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createMemoryJournal } from '../core/fakes/memoryJournal.js';
import type { JiraRequestFn, JiraResponse, Journal } from '../core/types.js';
import { defineTool, writeToolInput, z } from './define.js';
import { createRecentWrites } from './recent-writes.js';
import { ok } from './result.js';
import type { ToolResult } from './types.js';
import type { WriteGate, WriteGateCall } from './write-mode.js';
import {
  WRITE_PIPELINE_LAYERS,
  buildWritePipeline,
  type WritePipelineDeps,
} from './write-pipeline.js';

/** The compiled test sits at `build/mcp/`, so the repo root is two levels up. */
const REPO = new URL('../../', import.meta.url);

const SETTINGS: WritePipelineDeps['settings'] = {
  writeMode: 'apply',
  allowIrreversible: false,
  irreversibleConfirm: 'off',
  writeConfirm: 'off',
};

const identity = (value: unknown): unknown => value;

const updateTool = defineTool({
  name: 'jira_fx_update',
  title: 'Update',
  description: 'Updates an issue.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ issue: z.string() }),
  handler: () => Promise.resolve(ok({})),
});

/** A gate stand-in that sends one mutation and reports success. */
const sendingGate: WriteGate = {
  outstandingPlans: 0,
  async execute(call: WriteGateCall): Promise<ToolResult<unknown>> {
    await call.jira({ method: 'PUT', path: '/issue/10001' });
    return ok({});
  },
};

const wire: JiraRequestFn = <T = unknown>(): Promise<JiraResponse<T>> =>
  Promise.resolve({ status: 204, headers: {}, data: undefined as T });

test('the layer order is gate, journal, recent_writes', () => {
  assert.deepEqual([...WRITE_PIPELINE_LAYERS], ['gate', 'journal', 'recent_writes']);
});

test('the full pipeline runs every layer in the pinned order', () => {
  const pipeline = buildWritePipeline({
    settings: SETTINGS,
    redact: identity,
    journal: createMemoryJournal(createFakeClock()),
    recentWrites: createRecentWrites(),
  });
  assert.deepEqual(pipeline.layers, ['gate', 'journal', 'recent_writes']);
});

test('a layer whose dependency is absent is left out, the gate never', () => {
  const journal = createMemoryJournal(createFakeClock());
  const recentWrites = createRecentWrites();
  const layersOf = (deps: Partial<WritePipelineDeps>): readonly string[] =>
    buildWritePipeline({ settings: SETTINGS, redact: identity, ...deps }).layers;

  assert.deepEqual(layersOf({}), ['gate'], 'the registry fallback: the gate alone');
  assert.deepEqual(layersOf({ journal }), ['gate', 'journal']);
  assert.deepEqual(layersOf({ recentWrites }), ['gate', 'recent_writes']);
  assert.deepEqual(
    layersOf({
      settings: { ...SETTINGS, reconcileWrites: false },
      journal,
      recentWrites,
    }),
    ['gate', 'journal'],
    'D535: JIRA_RECONCILE_WRITES=false drops the recent-writes layer',
  );
});

test('the journal runs inside the recent-writes layer', async () => {
  const recentWrites = createRecentWrites();
  const seenAtAppend: (readonly string[])[] = [];
  const journal: Journal = {
    append: () => {
      seenAtAppend.push(recentWrites.snapshot());
      return Promise.resolve('ok');
    },
  };
  const { gate } = buildWritePipeline({
    settings: SETTINGS,
    redact: identity,
    gate: sendingGate,
    journal,
    recentWrites,
  });

  const result = await gate.execute({
    tool: updateTool,
    args: { issue: '10001' },
    control: { apply: true },
    jira: wire,
    invoke: () => Promise.resolve(ok({})),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    seenAtAppend,
    [[]],
    'the journal appended before anything was recorded',
  );
  assert.deepEqual(recentWrites.snapshot(), ['10001']);
});

test('an injected gate replaces the gate layer and keeps the outer layers', () => {
  const pipeline = buildWritePipeline({
    settings: SETTINGS,
    redact: identity,
    gate: sendingGate,
    journal: createMemoryJournal(createFakeClock()),
  });
  assert.deepEqual(pipeline.layers, ['gate', 'journal']);
  assert.notEqual(pipeline.gate, sendingGate);
});

/** Every non-test TypeScript source under `src/`. */
function productionSources(dir: URL): readonly URL[] {
  const out: URL[] = [];
  for (const name of readdirSync(dir)) {
    const entry = new URL(name, dir);
    if (statSync(entry).isDirectory())
      out.push(...productionSources(new URL(`${name}/`, dir)));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(entry);
  }
  return out;
}

test('production constructs a write gate in exactly one place', () => {
  const sites = productionSources(new URL('src/', REPO)).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const calls = source.match(/\bcreateWriteGate\(/g)?.length ?? 0;
    const declarations = source.match(/\bfunction createWriteGate\(/g)?.length ?? 0;
    const count = calls - declarations;
    return count === 0
      ? []
      : [`${file.pathname.slice(REPO.pathname.length)}: ${String(count)}`];
  });
  assert.deepEqual(sites, ['src/mcp/write-pipeline.ts: 1']);
});
