// Tests for the plan/apply write gate (D14, CC-20, CC-32).
//
// The load-bearing claims, in the order they are asserted below:
//   * a read tool is never gated;
//   * in plan mode the FIRST mutating request is captured and NOTHING reaches
//     the network, while the reads a plan is built from still go through;
//   * `apply: true` alone never writes — a plan_id is required;
//   * a plan_id is single-use, and it is burned even by a failed apply;
//   * arguments that drifted between plan and apply invalidate the plan_id.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { createRedactor } from '../core/redact.js';
import type { ControlFields } from './types.js';
import type { AnyToolSpec, PlannedRequest, ToolCtx, ToolResult } from './types.js';
import type { JiraRequestFn, Rng } from '../core/types.js';
import { defineTool, toolInput, writeToolInput, z } from './define.js';
import { ok } from './result.js';
import {
  IRREVERSIBLE_ENV_VAR,
  MAX_OUTSTANDING_PLANS,
  PLAN_ID_PATTERN,
  PLAN_NOTICE_LINE,
  createPlanStore,
  createWriteGate,
  isPlanResult,
  newPlanId,
  noteBeforeState,
  planFingerprint,
  splitControlFields,
  writeGatedResult,
} from './write-mode.js';
import type { WriteGateCall } from './write-mode.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinct, reproducible draws — never `Math.random` [eslint]. */
function countingRng(start = 1): Rng {
  let n = start;
  return (): number => {
    n += 1;
    return (n % 4096) / 4096;
  };
}

function constantRng(value = 0): Rng {
  return (): number => value;
}

function makeCtx(jira: JiraRequestFn): ToolCtx {
  return {
    jira,
    log: createFakeLogger(),
    clock: createFakeClock(1_000),
    cid: 'c-abc123',
    limits: { maxResultChars: 25_000, maxPages: 20 },
    deadlineAt: 121_000,
  };
}

const readTool = defineTool({
  name: 'jira_test_read',
  title: 'Test read',
  description: 'Reads a thing.',
  package: 'issues',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: toolInput({ key: z.string() }),
  async handler(args, ctx) {
    const res = await ctx.jira<{ id: string }>({
      method: 'GET',
      path: `/issue/${args.key}`,
      pathTemplate: '/issue/{key}',
    });
    return ok({ id: res.data.id });
  },
});

const writeTool = defineTool({
  name: 'jira_test_write',
  title: 'Test write',
  description: 'Writes a thing.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ summary: z.string() }),
  async handler(args, ctx) {
    const res = await ctx.jira<{ key: string }>({
      method: 'POST',
      path: '/issue',
      body: { fields: { summary: args.summary } },
    });
    return ok({ created: res.data.key });
  },
});

/** A write tool that READS first — the reads must survive plan mode (CC-20). */
const writeAfterReadTool = defineTool({
  name: 'jira_test_write_checked',
  title: 'Test checked write',
  description: 'Reads, then writes.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ key: z.string() }),
  async handler(args, ctx) {
    const meta = await ctx.jira<{ id: string }>({
      method: 'GET',
      path: `/issue/${args.key}/transitions`,
      pathTemplate: '/issue/{key}/transitions',
    });
    await ctx.jira({
      method: 'POST',
      path: `/issue/${args.key}/transitions`,
      body: { transition: { id: meta.data.id } },
    });
    return ok({ transitioned: true });
  },
});

/** A write whose meaning lives on the query string, not in a body. */
const queryWriteTool = defineTool({
  name: 'jira_test_write_query',
  title: 'Test query write',
  description: 'Writes with query parameters and no body.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({
    subtasks: z.boolean().optional(),
    notify: z.string().optional(),
  }),
  async handler(args, ctx) {
    await ctx.jira({
      method: 'DELETE',
      path: '/issue/ABC-1',
      pathTemplate: '/issue/{key}',
      query: { deleteSubtasks: args.subtasks, notifyUsers: args.notify },
    });
    return ok({ deleted: true });
  },
});

/** A write tool that swallows every error — the gate must not depend on it. */
const swallowingTool = defineTool({
  name: 'jira_test_write_swallows',
  title: 'Test swallowing write',
  description: 'Writes, catching everything.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ summary: z.string() }),
  async handler(args, ctx) {
    try {
      await ctx.jira({ method: 'POST', path: '/issue', body: { summary: args.summary } });
    } catch {
      /* the tool decides the failure is not fatal */
    }
    return ok({ swallowed: true });
  },
});

/**
 * WP-72 fixture: an irreversible tool shaped exactly like the real delete tools —
 * read the target, note the snapshot, then destroy it.
 */
const deleteTool = defineTool({
  name: 'jira_test_delete',
  title: 'Test delete',
  description: 'Reads a thing, then destroys it.',
  package: 'issues-delete',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'irreversible',
  input: writeToolInput({ key: z.string() }),
  async handler(args, ctx) {
    const found = await ctx.jira<{ summary: string }>({
      method: 'GET',
      path: `/issue/${args.key}`,
      pathTemplate: '/issue/{key}',
    });
    const before = { key: args.key, summary: found.data.summary };
    noteBeforeState(ctx.jira, before);
    await ctx.jira({
      method: 'DELETE',
      path: `/issue/${args.key}`,
      pathTemplate: '/issue/{key}',
    });
    return ok({ deleted: true, before }, { untrusted: true });
  },
});

/** Notes two snapshots — only the first may reach the plan envelope. */
const doubleNoteTool = defineTool({
  name: 'jira_test_delete_twice',
  title: 'Test double note',
  description: 'Notes twice, then destroys.',
  package: 'issues-delete',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'irreversible',
  input: writeToolInput({ key: z.string() }),
  async handler(args, ctx) {
    noteBeforeState(ctx.jira, { first: args.key });
    noteBeforeState(ctx.jira, { second: args.key });
    await ctx.jira({ method: 'DELETE', path: `/issue/${args.key}` });
    return ok({ deleted: true });
  },
});

function callOf(
  tool: AnyToolSpec,
  args: Record<string, unknown>,
  control: ControlFields,
  jira: JiraRequestFn,
): WriteGateCall {
  return {
    tool,
    args,
    control,
    jira,
    invoke: (seam: JiraRequestFn): Promise<ToolResult<unknown>> =>
      tool.handler(args, makeCtx(seam)),
  };
}

function planIdOf(result: ToolResult<unknown>): string {
  const data = result.data as { plan_id?: unknown } | undefined;
  assert.equal(typeof data?.plan_id, 'string');
  return String(data?.plan_id);
}

// ---------------------------------------------------------------------------
// Control fields
// ---------------------------------------------------------------------------

test('splitControlFields separates the three control fields from the payload', () => {
  const split = splitControlFields({
    summary: 'Hi',
    apply: true,
    plan_id: 'plan_abc',
    profile: 'prod',
    nested: { apply: false },
  });

  assert.deepEqual(split.control, { apply: true, plan_id: 'plan_abc', profile: 'prod' });
  assert.deepEqual(split.rest, { summary: 'Hi', nested: { apply: false } });
});

test('splitControlFields ignores wrongly-typed control values and non-objects', () => {
  const wrongTypes = splitControlFields({ apply: 'yes', plan_id: 7, profile: null });
  assert.deepEqual(wrongTypes.control, {});
  assert.deepEqual(wrongTypes.rest, {});

  assert.deepEqual(splitControlFields(null), { control: {}, rest: {} });
  assert.deepEqual(splitControlFields([1, 2]), { control: {}, rest: {} });
});

// ---------------------------------------------------------------------------
// Plan ids and the binding fingerprint
// ---------------------------------------------------------------------------

test('newPlanId draws from the injected rng and matches the id shape', () => {
  assert.equal(newPlanId(constantRng(0)), 'plan_000000000000000000000000');
  assert.match(newPlanId(countingRng()), PLAN_ID_PATTERN);
});

test('planFingerprint ignores key order but tracks tool, args and profile', () => {
  const a = planFingerprint('jira_test_write', { a: 1, b: [{ x: 1, y: 2 }] }, undefined);
  const b = planFingerprint('jira_test_write', { b: [{ y: 2, x: 1 }], a: 1 }, undefined);
  assert.equal(a, b);

  assert.notEqual(a, planFingerprint('jira_other_write', { a: 1, b: [] }, undefined));
  assert.notEqual(a, planFingerprint('jira_test_write', { a: 2 }, undefined));
  assert.notEqual(
    a,
    planFingerprint('jira_test_write', { a: 1, b: [{ x: 1, y: 2 }] }, 'prod'),
  );
});

// ---------------------------------------------------------------------------
// The plan store
// ---------------------------------------------------------------------------

test('a plan id is single-use, and a mismatched apply burns it too', () => {
  const store = createPlanStore(countingRng());
  const binding = { tool: 'jira_test_write', fingerprint: 'fp-1' };

  const id = store.issue(binding);
  assert.match(id, PLAN_ID_PATTERN);
  assert.equal(store.size, 1);

  assert.equal(store.consume(id, binding), 'ok');
  assert.equal(store.size, 0);
  assert.equal(store.consume(id, binding), 'unknown');

  const second = store.issue(binding);
  assert.equal(store.consume(second, { ...binding, fingerprint: 'fp-2' }), 'mismatch');
  assert.equal(store.size, 0, 'a mismatch still spends the id');

  const third = store.issue(binding);
  assert.equal(store.consume(third, { ...binding, tool: 'jira_other' }), 'mismatch');
});

test('the store is bounded — the oldest outstanding plan is evicted', () => {
  const store = createPlanStore(countingRng(), 3);
  const ids = [0, 1, 2, 3].map((n) =>
    store.issue({ tool: 'jira_test_write', fingerprint: `fp-${String(n)}` }),
  );

  assert.equal(store.size, 3);
  assert.equal(
    store.consume(String(ids[0]), { tool: 'jira_test_write', fingerprint: 'fp-0' }),
    'unknown',
  );
  assert.equal(
    store.consume(String(ids[3]), { tool: 'jira_test_write', fingerprint: 'fp-3' }),
    'ok',
  );
  assert.equal(MAX_OUTSTANDING_PLANS, 64);
});

// ---------------------------------------------------------------------------
// The gate — reads
// ---------------------------------------------------------------------------

test('a read tool is not gated in either write mode', async () => {
  for (const writeMode of ['plan', 'apply'] as const) {
    const fake = createFakeJiraRequest();
    fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ id: '10001' }));
    const gate = createWriteGate({
      writeMode,
      allowIrreversible: false,
      rng: countingRng(),
    });

    const result = await gate.execute(callOf(readTool, { key: 'ABC-1' }, {}, fake.fn));

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { id: '10001' });
    assert.equal(gate.outstandingPlans, 0);
  }
});

// ---------------------------------------------------------------------------
// The gate — plan mode
// ---------------------------------------------------------------------------

test('CC-20: plan mode captures the write, returns a plan and touches no network', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(writeTool, { summary: 'Ship it' }, {}, fake.fn),
  );

  assert.equal(result.ok, true);
  assert.equal(isPlanResult(result), true);
  assert.deepEqual(fake.calls, [], 'CC-20: nothing hit the wire in plan mode');

  const data = result.data as { executed: unknown; planned: unknown };
  assert.equal(data.executed, false);
  assert.deepEqual(data.planned, {
    method: 'POST',
    path: '/issue',
    body: { fields: { summary: 'Ship it' } },
  });

  const hint = (result.hints ?? [])[0];
  assert.equal(hint?.code, 'plan');
  assert.ok(hint?.message.startsWith(PLAN_NOTICE_LINE));
  assert.ok(hint?.message.includes(planIdOf(result)));
  assert.ok(hint?.message.includes('jira_test_write'));
  assert.equal(gate.outstandingPlans, 1);
});

test('plan mode still performs the reads a truthful plan is built from', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1/transitions', jiraOk({ id: '31' }));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(writeAfterReadTool, { key: 'ABC-1' }, {}, fake.fn),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fake.routes(), ['GET /rest/api/3/issue/ABC-1/transitions']);
  assert.deepEqual((result.data as { planned: unknown }).planned, {
    method: 'POST',
    path: '/issue/ABC-1/transitions',
    body: { transition: { id: '31' } },
  });
});

test('the plan shows the query the URL would carry, minus the entries it drops', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(queryWriteTool, { subtasks: false, notify: 'watchers' }, {}, fake.fn),
  );

  assert.deepEqual((result.data as { planned: unknown }).planned, {
    method: 'DELETE',
    path: '/issue/ABC-1',
    // `false` survives as a boolean: a plan that showed `"false"` would invite
    // the model to reason about a string, and `deleteSubtasks` is not one.
    query: { deleteSubtasks: false, notifyUsers: 'watchers' },
  });
  assert.deepEqual(fake.calls, [], 'CC-20 still holds for a query-only write');
});

test('a query whose every value is undefined leaves no query key on the plan', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(callOf(queryWriteTool, {}, {}, fake.fn));

  // `buildQueryString` would emit nothing, so the URL carries no `?` — and the
  // plan must not imply one.
  assert.deepEqual((result.data as { planned: unknown }).planned, {
    method: 'DELETE',
    path: '/issue/ABC-1',
  });
});

test('plan mode redacts string query values and leaves the scalars alone', async () => {
  const redactor = createFakeRedactor(['watchers']);
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
    redact: (value) => redactor.redact(value),
  });

  const result = await gate.execute(
    callOf(queryWriteTool, { subtasks: true, notify: 'watchers' }, {}, fake.fn),
  );

  const planned = (result.data as { planned: PlannedRequest }).planned;
  assert.notEqual(planned.query?.notifyUsers, 'watchers');
  assert.equal(planned.query?.deleteSubtasks, true);
  assert.equal(redactor.calls.length, 1, 'only the string value is worth redacting');
});

test('plan mode redacts the captured body through the injected redactor', async () => {
  const redactor = createFakeRedactor(['Ship it']);
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
    redact: (value) => redactor.redact(value),
  });

  const result = await gate.execute(
    callOf(writeTool, { summary: 'Ship it' }, {}, fake.fn),
  );

  const planned = (result.data as { planned: { body: { fields: { summary: string } } } })
    .planned;
  assert.notEqual(planned.body.fields.summary, 'Ship it');
  assert.equal(redactor.calls.length, 1);
});

test('the plan shows the WHOLE body, not a depth-capped summary of it', async () => {
  // The preview is the approval surface: an operator who cannot see the link
  // inside a comment body is approving something they were never shown. The
  // real redactor runs here on purpose — a fake would hide a cap of its own.
  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'spec',
                      marks: [
                        {
                          type: 'link',
                          attrs: { href: 'https://evil.example/pay?to=me' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const commentTool = defineTool({
    name: 'jira_test_write_adf',
    title: 'Test rich write',
    description: 'Writes a rich-text thing.',
    package: 'issues-write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: 'standard',
    input: writeToolInput({ issue: z.string() }),
    async handler(args, ctx) {
      await ctx.jira({ method: 'POST', path: `/issue/${args.issue}/comment`, body });
      return ok({ added: true });
    },
  });
  const redactor = createRedactor();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
    redact: (value) => redactor.redact(value),
  });

  const result = await gate.execute(
    callOf(commentTool, { issue: 'ABC-1' }, {}, createFakeJiraRequest().fn),
  );

  const planned = (result.data as { planned: PlannedRequest }).planned;
  assert.deepEqual(planned.body, body);
  assert.ok(!JSON.stringify(planned.body).includes('[MAX_DEPTH]'));
});

test('a handler that swallows the capture still yields a plan, not a fake success', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(swallowingTool, { summary: 'Quiet' }, {}, fake.fn),
  );

  assert.equal(isPlanResult(result), true);
  assert.equal((result.data as { executed: unknown }).executed, false);
  assert.deepEqual(fake.calls, []);
});

test('apply: true in plan mode is ignored, and the hint says so', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(writeTool, { summary: 'Ship it' }, { apply: true }, fake.fn),
  );

  assert.equal(isPlanResult(result), true);
  assert.deepEqual(fake.calls, []);
  assert.ok((result.hints ?? [])[0]?.message.includes('JIRA_WRITE_MODE=plan'));
});

// ---------------------------------------------------------------------------
// The gate — apply mode
// ---------------------------------------------------------------------------

test('apply mode without a plan_id refuses and sends nothing', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(writeTool, { summary: 'Ship it' }, { apply: true }, fake.fn),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'write_gated');
  assert.ok(result.error?.message.includes('plan_id'));
  assert.ok(result.error?.message.includes('Nothing was sent to Jira'));
  assert.deepEqual(fake.calls, []);
});

test('apply mode without apply: true produces a plan instead of a write', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(writeTool, { summary: 'Ship it' }, {}, fake.fn),
  );

  assert.equal(isPlanResult(result), true);
  assert.deepEqual(fake.calls, []);
});

test('apply mode with an unknown plan_id refuses', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(
      writeTool,
      { summary: 'Ship it' },
      { apply: true, plan_id: 'plan_deadbeefdeadbeefdeadbeef' },
      fake.fn,
    ),
  );

  assert.equal(result.error?.kind, 'write_gated');
  assert.ok(result.error?.message.includes('single-use'));
  assert.deepEqual(fake.calls, []);
});

test('plan then apply with identical arguments executes exactly once', async () => {
  const fake = createFakeJiraRequest();
  fake.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-9' }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { summary: 'Ship it' };

  const planResult = await gate.execute(callOf(writeTool, args, {}, fake.fn));
  const planId = planIdOf(planResult);
  assert.equal(gate.outstandingPlans, 1);

  const applied = await gate.execute(
    callOf(writeTool, args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.data, { created: 'ABC-9' });
  assert.deepEqual(fake.routes(), ['POST /rest/api/3/issue']);
  assert.equal(gate.outstandingPlans, 0);

  const replay = await gate.execute(
    callOf(writeTool, args, { apply: true, plan_id: planId }, fake.fn),
  );
  assert.equal(replay.error?.kind, 'write_gated');
  assert.deepEqual(fake.routes(), ['POST /rest/api/3/issue'], 'single-use');
});

test('argument drift between plan and apply invalidates the plan_id (CC-32)', async () => {
  const fake = createFakeJiraRequest();
  fake.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-9' }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const planResult = await gate.execute(
    callOf(writeTool, { summary: 'Ship it' }, {}, fake.fn),
  );
  const planId = planIdOf(planResult);

  const drifted = await gate.execute(
    callOf(
      writeTool,
      { summary: 'Ship something else' },
      { apply: true, plan_id: planId },
      fake.fn,
    ),
  );

  assert.equal(drifted.error?.kind, 'write_gated');
  assert.ok(drifted.error?.message.includes('arguments changed'));
  assert.deepEqual(fake.calls, []);
  assert.equal(gate.outstandingPlans, 0, 'the drifted apply burned the id');
});

test('a plan bound to one profile does not authorize another', async () => {
  const fake = createFakeJiraRequest();
  fake.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-9' }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { summary: 'Ship it' };

  const planResult = await gate.execute(
    callOf(writeTool, args, { profile: 'staging' }, fake.fn),
  );
  const planId = planIdOf(planResult);

  const crossed = await gate.execute(
    callOf(writeTool, args, { apply: true, plan_id: planId, profile: 'prod' }, fake.fn),
  );

  assert.equal(crossed.error?.kind, 'write_gated');
  assert.deepEqual(fake.calls, []);
});

test('writeGatedResult is never retryable and always names the replan path', () => {
  for (const reason of ['missing', 'unknown', 'mismatch'] as const) {
    const result = writeGatedResult(reason);
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'write_gated');
    assert.equal(result.error?.retryable, false);
    assert.ok(result.error?.remediation?.includes('apply: true'));
  }
});

test('writeGatedResult("irreversible") points at the operator, not at a replan', () => {
  const result = writeGatedResult('irreversible');
  assert.equal(result.error?.kind, 'write_gated');
  assert.equal(result.error?.retryable, false);
  assert.ok(result.error?.message.includes('The plan_id was NOT consumed'));
  assert.ok(result.error?.remediation?.includes(IRREVERSIBLE_ENV_VAR));
});

// ---------------------------------------------------------------------------
// The gate — the irreversible tier (WP-72)
// ---------------------------------------------------------------------------

test('CC-61: an irreversible plan works WITHOUT the opt-in and warns that apply is off', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(callOf(deleteTool, { key: 'ABC-1' }, {}, fake.fn));

  assert.equal(result.ok, true, 'a plan is a read plus a description — never gated');
  assert.equal(isPlanResult(result), true);
  assert.deepEqual(fake.routes(), ['GET /rest/api/3/issue/ABC-1'], 'the read only');
  assert.deepEqual((result.data as { planned: unknown }).planned, {
    method: 'DELETE',
    path: '/issue/ABC-1',
  });

  const message = (result.hints ?? [])[0]?.message ?? '';
  assert.ok(message.includes(IRREVERSIBLE_ENV_VAR), 'the hint names the missing var');
  assert.ok(message.includes('IRREVERSIBLE'));
  assert.equal(gate.outstandingPlans, 1, 'the plan is still usable once enabled');
});

test('CC-64: an irreversible plan carries the before-state and is tainted', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });

  const result = await gate.execute(callOf(deleteTool, { key: 'ABC-1' }, {}, fake.fn));

  assert.deepEqual((result.data as { before: unknown }).before, {
    key: 'ABC-1',
    summary: 'Old title',
  });
  assert.equal(result._untrusted, true, 'D15: a before-state is tenant-authored prose');
  assert.ok(
    !((result.hints ?? [])[0]?.message ?? '').includes(IRREVERSIBLE_ENV_VAR),
    'no scare text once the operator has enabled the tier',
  );
});

test('the before-state goes through the injected redactor', async () => {
  const redactor = createFakeRedactor(['Old title']);
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
    redact: (value) => redactor.redact(value),
  });

  const result = await gate.execute(callOf(deleteTool, { key: 'ABC-1' }, {}, fake.fn));

  const before = (result.data as { before: { summary: string } }).before;
  assert.notEqual(before.summary, 'Old title');
  assert.equal(
    redactor.calls.length,
    1,
    'a DELETE has no body, so the before-state is the only redactable payload',
  );
});

test('CC-60: an irreversible apply without the opt-in is gated and burns nothing', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { key: 'ABC-1' };

  const planId = planIdOf(await gate.execute(callOf(deleteTool, args, {}, fake.fn)));
  fake.reset();

  const refused = await gate.execute(
    callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(refused.ok, false);
  assert.equal(refused.error?.kind, 'write_gated');
  assert.equal(refused.error?.retryable, false);
  assert.ok(refused.error?.message.includes(IRREVERSIBLE_ENV_VAR));
  assert.ok(refused.error?.message.includes('Nothing was sent to Jira'));
  assert.ok(refused.error?.remediation?.includes(IRREVERSIBLE_ENV_VAR));
  assert.deepEqual(fake.calls, [], 'not even the before-state read happened');
  assert.equal(gate.outstandingPlans, 1, 'a config refusal must not cost the plan_id');
});

test('with the opt-in, plan then apply deletes once and echoes the before-state', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  fake.on('DELETE /rest/api/3/issue/ABC-1', jiraOk(undefined, { status: 204 }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    rng: countingRng(),
  });
  const args = { key: 'ABC-1' };

  const planId = planIdOf(await gate.execute(callOf(deleteTool, args, {}, fake.fn)));

  const applied = await gate.execute(
    callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.data, {
    deleted: true,
    before: { key: 'ABC-1', summary: 'Old title' },
  });
  assert.deepEqual(fake.routes(), [
    'GET /rest/api/3/issue/ABC-1',
    'GET /rest/api/3/issue/ABC-1',
    'DELETE /rest/api/3/issue/ABC-1',
  ]);
  assert.equal(gate.outstandingPlans, 0);

  const replay = await gate.execute(
    callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
  );
  assert.equal(replay.error?.kind, 'write_gated');
  assert.equal(fake.routes().length, 3, 'single-use, even for a delete');
});

test('the standard tier is untouched by the irreversible switch', async () => {
  for (const allowIrreversible of [false, true]) {
    const fake = createFakeJiraRequest();
    fake.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-9' }));
    const gate = createWriteGate({
      writeMode: 'apply',
      allowIrreversible,
      rng: countingRng(),
    });
    const args = { summary: 'Ship it' };

    const planResult = await gate.execute(callOf(writeTool, args, {}, fake.fn));
    const planId = planIdOf(planResult);

    assert.equal(planResult._untrusted, undefined, 'no before-state, no taint');
    assert.ok(
      !((planResult.hints ?? [])[0]?.message ?? '').includes(IRREVERSIBLE_ENV_VAR),
    );
    assert.equal(Object.hasOwn(planResult.data as object, 'before'), false);

    const applied = await gate.execute(
      callOf(writeTool, args, { apply: true, plan_id: planId }, fake.fn),
    );
    assert.deepEqual(applied.data, { created: 'ABC-9' });
    assert.deepEqual(fake.routes(), ['POST /rest/api/3/issue']);
  }
});

test('CC-62: noteBeforeState is a no-op outside plan mode and keeps the first snapshot', async () => {
  const fake = createFakeJiraRequest();
  noteBeforeState(fake.fn, { key: 'ABC-1' }); // an unregistered seam: apply mode

  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: true,
    rng: countingRng(),
  });
  const result = await gate.execute(
    callOf(doubleNoteTool, { key: 'ABC-1' }, {}, fake.fn),
  );

  assert.deepEqual((result.data as { before: unknown }).before, { first: 'ABC-1' });
  assert.deepEqual(fake.calls, []);
});

test('isPlanResult only fires for a successful envelope carrying the plan hint', () => {
  assert.equal(isPlanResult(ok({ executed: false })), false);
  assert.equal(
    isPlanResult(ok({ executed: false }, { hints: [{ code: 'plan', message: 'x' }] })),
    true,
  );
  assert.equal(isPlanResult(writeGatedResult('missing')), false);
});
