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

import { CLOUD_API } from '../api/port.js';
import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraErr, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { createRedactor } from '../core/redact.js';
import { JiraError } from '../core/types.js';
import type { ControlFields } from './types.js';
import type { AnyToolSpec, PlannedRequest, ToolCtx, ToolResult } from './types.js';
import type { JiraRequestFn, Rng } from '../core/types.js';
import { defineTool, toolInput, writeToolInput, z } from './define.js';
import { ok } from './result.js';
import {
  CONFIRM_BEFORE_MAX_CHARS,
  CONFIRM_ENV_VAR,
  IRREVERSIBLE_ENV_VAR,
  MAX_EVICTED_TOMBSTONES,
  MAX_OUTSTANDING_PLANS,
  PLAN_ID_PATTERN,
  PLAN_NOTICE_LINE,
  createPlanStore,
  confirmSummary,
  createWriteGate,
  isPlanResult,
  newPlanId,
  noteBeforeState,
  planFingerprint,
  splitControlFields,
  writeGatedResult,
} from './write-mode.js';
import type {
  ConfirmRequest,
  IrreversibleConfirmer,
  WriteGateCall,
} from './write-mode.js';

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
    api: CLOUD_API,
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

/** Sorts its argument in place before writing, as a normalising handler might. */
const sortingTool = defineTool({
  name: 'jira_test_sorting_write',
  title: 'Test sorting write',
  description: 'Sorts the ids in place, then writes them.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ ids: z.array(z.string()) }),
  async handler(args, ctx) {
    args.ids.sort();
    await ctx.jira({ method: 'POST', path: '/thing', body: { ids: args.ids } });
    return ok({ written: args.ids });
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

test('[CC-553] the fingerprint spells the profile the way credentials resolve it', () => {
  assert.equal(
    planFingerprint('jira_x', { a: 1 }, ' EU '),
    planFingerprint('jira_x', { a: 1 }, 'eu'),
  );
  assert.notEqual(
    planFingerprint('jira_x', { a: 1 }, 'eu'),
    planFingerprint('jira_x', { a: 1 }, 'us'),
  );
});

test('[CC-145] an own __proto__ key is fingerprinted like any other key', () => {
  const planned = JSON.parse(
    '{"fields":{"customfield_1":{"__proto__":{"value":"A"}}}}',
  ) as unknown;
  const applied = JSON.parse(
    '{"fields":{"customfield_1":{"__proto__":{"value":"B"}}}}',
  ) as unknown;
  assert.notEqual(
    planFingerprint('jira_test_write', planned, undefined),
    planFingerprint('jira_test_write', applied, undefined),
  );
  assert.equal(
    planFingerprint('jira_test_write', planned, undefined),
    planFingerprint('jira_test_write', structuredClone(planned), undefined),
  );
});

test('newPlanId clamps a wild draw and treats a non-finite one as zero', () => {
  // A misbehaving rng must never produce an id outside the shape the store
  // and the apply path agree on — 24 lowercase hex digits, no more, no less.
  assert.equal(
    newPlanId(() => Number.NaN),
    'plan_000000000000000000000000',
  );
  assert.equal(
    newPlanId(() => Number.POSITIVE_INFINITY),
    'plan_000000000000000000000000',
  );
  assert.equal(
    newPlanId(() => -1),
    'plan_000000000000000000000000',
  );
  assert.equal(
    newPlanId(() => 2),
    'plan_ffffffffffffffffffffffff',
  );
  assert.match(
    newPlanId(() => 2),
    PLAN_ID_PATTERN,
  );
});

test('planFingerprint binds an absent field and an explicit undefined the same way', () => {
  // Zod-parsed args carry `undefined` for every optional key the caller left
  // out; JSON has no such value, so the fingerprint must not see a difference
  // between "not given" and "given as undefined" or a re-parse would drift.
  const absent = planFingerprint('jira_test_write', { a: 1 }, undefined);
  const explicit = planFingerprint('jira_test_write', { a: 1, b: undefined }, undefined);
  assert.equal(explicit, absent);
  assert.notEqual(
    planFingerprint('jira_test_write', { a: 1, b: null }, undefined),
    absent,
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
    'evicted',
  );
  assert.equal(
    store.consume(String(ids[3]), { tool: 'jira_test_write', fingerprint: 'fp-3' }),
    'ok',
  );
  assert.equal(MAX_OUTSTANDING_PLANS, 64);
});

test('CC-1000: an evicted id is reported as evicted once, then as unknown', () => {
  const store = createPlanStore(countingRng(), 1);
  const binding = { tool: 'jira_test_write', fingerprint: 'fp' };
  const first = store.issue(binding);
  store.issue(binding);

  assert.equal(store.consume(first, binding), 'evicted');
  assert.equal(store.consume(first, binding), 'unknown', 'the tombstone is spent too');
  assert.equal(store.consume('plan_ffffffffffffffffffffffff', binding), 'unknown');
});

test('CC-1000: the tombstones are bounded — the oldest evicted id becomes unknown', () => {
  const store = createPlanStore(countingRng(), 1);
  const binding = { tool: 'jira_test_write', fingerprint: 'fp' };
  const ids = Array.from({ length: MAX_EVICTED_TOMBSTONES + 2 }, () =>
    store.issue(binding),
  );

  // ids[0 .. N] were evicted; only the newest N tombstones are kept.
  assert.equal(store.consume(String(ids[0]), binding), 'unknown');
  assert.equal(store.consume(String(ids[1]), binding), 'evicted');
  assert.equal(store.consume(String(ids.at(-1)), binding), 'ok');
  assert.equal(MAX_EVICTED_TOMBSTONES, 256);
});

test('a colliding plan id is drawn again; a stuck rng lets the newer plan win', () => {
  // Eight zero draws (two ids' worth) then a counting sequence: the second
  // issue lands on the first id, notices the collision and draws a fresh one.
  let draws = 0;
  const stuckThenCounting: Rng = () => {
    draws += 1;
    return draws <= 8 ? 0 : (draws % 4096) / 4096;
  };
  const store = createPlanStore(stuckThenCounting);
  const first = store.issue({ tool: 'jira_test_write', fingerprint: 'fp-1' });
  const second = store.issue({ tool: 'jira_test_write', fingerprint: 'fp-2' });
  assert.equal(first, 'plan_000000000000000000000000');
  assert.notEqual(second, first);
  assert.equal(store.size, 2, 'both plans stay outstanding');
  assert.equal(
    store.consume(first, { tool: 'jira_test_write', fingerprint: 'fp-1' }),
    'ok',
  );
  assert.equal(
    store.consume(second, { tool: 'jira_test_write', fingerprint: 'fp-2' }),
    'ok',
  );

  // An rng that never moves cannot escape the collision. The id then binds
  // the NEWER request only — it must never authorize two different ones.
  const stuck = createPlanStore(constantRng(0));
  const older = stuck.issue({ tool: 'jira_test_write', fingerprint: 'fp-old' });
  const newer = stuck.issue({ tool: 'jira_test_write', fingerprint: 'fp-new' });
  assert.equal(newer, older);
  assert.equal(stuck.size, 1, 'the older plan is gone, not shadowed');
  assert.equal(
    stuck.consume(older, { tool: 'jira_test_write', fingerprint: 'fp-old' }),
    'mismatch',
    'the id no longer authorizes the older request',
  );
  assert.equal(stuck.size, 0, 'and the mismatch burned it for the newer one too');
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

test('CC-86: the plan of a multipart upload names the file, without the bytes', async () => {
  // `jira_upload_attachment` carries its payload in `multipart` and sets no
  // `body` at all. A capture that reads only method/path/query/body renders
  // the plan as `{"method":"POST","path":"/issue/ABC-1/attachments"}` — an
  // approval surface that never says WHICH file leaves the host, so the
  // operator approves an upload they were never shown.
  const uploadTool = defineTool({
    name: 'jira_test_write_upload',
    title: 'Test upload',
    description: 'Uploads a file.',
    package: 'attachments',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: 'standard',
    input: writeToolInput({ issue: z.string() }),
    async handler(args, ctx) {
      await ctx.jira({
        method: 'POST',
        path: `/issue/${args.issue}/attachments`,
        pathTemplate: '/issue/{key}/attachments',
        multipart: [
          {
            field: 'file',
            filename: 'salary-review.pdf',
            contentType: 'application/pdf',
            bytes: new Uint8Array([1, 2, 3, 4, 5]),
          },
        ],
      });
      return ok({ uploaded: true });
    },
  });
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const result = await gate.execute(
    callOf(uploadTool, { issue: 'ABC-1' }, {}, createFakeJiraRequest().fn),
  );

  const planned = (result.data as { planned: Record<string, unknown> }).planned;
  assert.deepEqual(planned.multipart, [
    {
      field: 'file',
      filename: 'salary-review.pdf',
      contentType: 'application/pdf',
      bytes: 5,
    },
  ]);
  // The metadata is the approval surface; the payload itself is not — a plan
  // envelope must never carry the file contents.
  assert.ok(!JSON.stringify(planned).includes('"0":1'), 'no raw bytes in the plan');
});

test('the plan of a multipart upload redacts the filename and skips an absent content type', async () => {
  // The filename is caller text like any other and goes through the redactor;
  // a part that names no content type shows none rather than an `undefined`.
  const redactor = createFakeRedactor(['salary']);
  const uploadTool = defineTool({
    name: 'jira_test_write_upload',
    title: 'Test upload',
    description: 'Uploads a file.',
    package: 'attachments',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: 'standard',
    input: writeToolInput({ issue: z.string() }),
    async handler(args, ctx) {
      await ctx.jira({
        method: 'POST',
        path: `/issue/${args.issue}/attachments`,
        pathTemplate: '/issue/{key}/attachments',
        multipart: [
          { field: 'file', filename: 'salary-review.pdf', bytes: new Uint8Array(3) },
        ],
      });
      return ok({ uploaded: true });
    },
  });
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
    redact: (value) => redactor.redact(value),
  });

  const result = await gate.execute(
    callOf(uploadTool, { issue: 'ABC-1' }, {}, createFakeJiraRequest().fn),
  );

  const planned = (result.data as { planned: Record<string, unknown> }).planned;
  assert.deepEqual(planned.multipart, [
    { field: 'file', filename: '[REDACTED]-review.pdf', bytes: 3 },
  ]);
  assert.ok(
    redactor.calls.includes('salary-review.pdf'),
    'the filename went through the redactor',
  );
});

test('[CC-426] an upload whose file changed after the plan is refused and sends nothing', async () => {
  // The arguments of an upload name a file, not its bytes: a plan_id bound to
  // the arguments alone authorized whatever sat on disk at apply time.
  let content = new Uint8Array([1, 2, 3, 4, 5]);
  let swallow = false;
  const uploadTool = defineTool({
    name: 'jira_test_write_upload',
    title: 'Test upload',
    description: 'Uploads a file.',
    package: 'attachments',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: 'standard',
    input: writeToolInput({ issue: z.string() }),
    async handler(args, ctx) {
      try {
        await ctx.jira({
          method: 'POST',
          path: `/issue/${args.issue}/attachments`,
          pathTemplate: '/issue/{key}/attachments',
          multipart: [{ field: 'file', filename: 'report.txt', bytes: content }],
        });
      } catch (error) {
        if (!swallow) throw error;
      }
      return ok({ uploaded: true });
    },
  });
  const fake = createFakeJiraRequest();
  fake.on('POST /rest/api/3/issue/ABC-1/attachments', jiraOk([]), 5);
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { issue: 'ABC-1' };
  const planAndApply = async (): Promise<ToolResult<unknown>> => {
    const planId = planIdOf(await gate.execute(callOf(uploadTool, args, {}, fake.fn)));
    content = new Uint8Array(4096).fill(88);
    return gate.execute(
      callOf(uploadTool, args, { apply: true, plan_id: planId }, fake.fn),
    );
  };

  const drifted = await planAndApply();
  assert.equal(drifted.error?.kind, 'write_gated');
  assert.ok(drifted.error?.message.includes('The file changed'));
  assert.deepEqual(fake.routes(), [], 'nothing reached Jira');

  // A handler that swallows the rejection cannot turn it into a success.
  swallow = true;
  content = new Uint8Array([1, 2, 3, 4, 5]);
  const swallowed = await planAndApply();
  assert.equal(swallowed.error?.kind, 'write_gated');
  assert.deepEqual(fake.routes(), []);
  assert.equal(gate.outstandingPlans, 0, 'both plan ids are spent');

  // The unchanged file still uploads, once.
  const planId = planIdOf(await gate.execute(callOf(uploadTool, args, {}, fake.fn)));
  const applied = await gate.execute(
    callOf(uploadTool, args, { apply: true, plan_id: planId }, fake.fn),
  );
  assert.equal(applied.ok, true);
  assert.deepEqual(fake.routes(), ['POST /rest/api/3/issue/ABC-1/attachments']);
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

test('[CC-552] a handler that sorts its arguments in place does not void its own plan', async () => {
  const fake = createFakeJiraRequest();
  fake.on('POST /rest/api/3/thing', jiraOk({}));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const planned = await gate.execute(
    callOf(sortingTool, { ids: ['B', 'A'] }, {}, fake.fn),
  );
  assert.equal(isPlanResult(planned), true);
  const applied = await gate.execute(
    callOf(
      sortingTool,
      { ids: ['B', 'A'] },
      { apply: true, plan_id: planIdOf(planned) },
      fake.fn,
    ),
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(fake.calls.length, 1);
});

test('[CC-550] the plan-mode hint names the operator restart, not a re-invocation that only plans again', async () => {
  const fake = createFakeJiraRequest();
  const planGate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const planned = await planGate.execute(
    callOf(writeTool, { summary: 'Ship it' }, {}, fake.fn),
  );
  const planHint = (planned.hints ?? [])[0]?.message ?? '';
  assert.ok(planHint.includes('JIRA_WRITE_MODE=apply'), planHint);
  assert.ok(!planHint.includes('`apply: true` and'), planHint);

  // Following that advice anyway only mints another plan, which is why it must not be given.
  const again = await planGate.execute(
    callOf(
      writeTool,
      { summary: 'Ship it' },
      { apply: true, plan_id: planIdOf(planned) },
      fake.fn,
    ),
  );
  assert.equal(isPlanResult(again), true);
  assert.deepEqual(fake.calls, []);

  const applyGate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const applyPlan = await applyGate.execute(
    callOf(writeTool, { summary: 'Ship it' }, {}, fake.fn),
  );
  const applyHint = (applyPlan.hints ?? [])[0]?.message ?? '';
  assert.ok(applyHint.includes('`apply: true` and'), applyHint);
  assert.ok(!applyHint.includes('JIRA_WRITE_MODE'), applyHint);
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

test('CC-1000: applying a plan the bound evicted is refused as evicted, nothing sent', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
    store: createPlanStore(countingRng(), 1),
  });

  const first = await gate.execute(callOf(writeTool, { summary: 'One' }, {}, fake.fn));
  await gate.execute(callOf(writeTool, { summary: 'Two' }, {}, fake.fn));
  const applied = await gate.execute(
    callOf(
      writeTool,
      { summary: 'One' },
      { apply: true, plan_id: planIdOf(first) },
      fake.fn,
    ),
  );

  assert.equal(applied.error?.kind, 'write_gated');
  assert.ok(applied.error?.message.includes('expired unused'));
  assert.deepEqual(fake.calls, []);
});

test('writeGatedResult is never retryable and always names the replan path', () => {
  for (const reason of ['missing', 'unknown', 'mismatch', 'evicted'] as const) {
    const result = writeGatedResult(reason);
    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'write_gated');
    assert.equal(result.error?.retryable, false);
    assert.ok(result.error?.remediation?.includes('apply: true'));
  }
});

test('CC-1000: the evicted refusal names the bound instead of an earlier process', () => {
  const message = writeGatedResult('evicted').error?.message ?? '';
  assert.ok(message.includes(`at most ${String(MAX_OUTSTANDING_PLANS)} unapplied plans`));
  assert.ok(!message.includes('earlier server process'));
  assert.ok(message.includes('Nothing was sent to Jira.'));
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

// ---------------------------------------------------------------------------
// The gate — human confirmation of an irreversible apply (D303)
// ---------------------------------------------------------------------------

/** A scripted confirmer that records every question it is asked. */
function scriptedConfirmer(
  answer: boolean | Error,
  available = true,
): IrreversibleConfirmer & { readonly asked: ConfirmRequest[] } {
  const asked: ConfirmRequest[] = [];
  return {
    asked,
    available: () => available,
    ask: (request) => {
      asked.push(request);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

function confirmingGate(confirmer: IrreversibleConfirmer | undefined) {
  return createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    irreversibleConfirm: 'elicit',
    confirmer,
    rng: countingRng(),
  });
}

test('[CC-3013] a confirmed irreversible apply asks once, quoting the plan, then deletes', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  fake.on('DELETE /rest/api/3/issue/ABC-1', jiraOk(undefined, { status: 204 }));
  const confirmer = scriptedConfirmer(true);
  const gate = confirmingGate(confirmer);
  const args = { key: 'ABC-1' };

  const planId = planIdOf(await gate.execute(callOf(deleteTool, args, {}, fake.fn)));
  assert.equal(confirmer.asked.length, 0, 'planning never asks');

  const applied = await gate.execute(
    callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(applied.ok, true);
  assert.equal(confirmer.asked.length, 1);
  const message = confirmer.asked[0]?.message ?? '';
  assert.equal(confirmer.asked[0]?.tool, 'jira_test_delete');
  assert.match(message, /IRREVERSIBLE jira_test_delete: DELETE \/issue\/ABC-1\./);
  assert.match(
    message,
    /Old title/,
    'the question quotes the before-state the plan showed',
  );
  assert.deepEqual(fake.routes(), [
    'GET /rest/api/3/issue/ABC-1',
    'GET /rest/api/3/issue/ABC-1',
    'DELETE /rest/api/3/issue/ABC-1',
  ]);
});

test('[CC-3014] a declined confirmation sends nothing and spends the plan', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  const confirmer = scriptedConfirmer(false);
  const gate = confirmingGate(confirmer);
  const args = { key: 'ABC-1' };

  const planId = planIdOf(await gate.execute(callOf(deleteTool, args, {}, fake.fn)));
  fake.reset();

  const refused = await gate.execute(
    callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(refused.error?.kind, 'write_gated');
  assert.match(refused.error?.message ?? '', /not given/);
  assert.match(refused.error?.message ?? '', /plan_id is spent/);
  assert.deepEqual(fake.calls, [], 'refused before the handler ran');
  assert.equal(gate.outstandingPlans, 0);

  const retry = await gate.execute(
    callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
  );
  assert.match(
    retry.error?.message ?? '',
    /unknown/,
    'a decline cannot be retried into a yes',
  );
  assert.equal(confirmer.asked.length, 1, 'the spent id is refused without asking again');
});

test('[CC-3015] a client that cannot be asked is refused before the plan is spent', async () => {
  for (const confirmer of [scriptedConfirmer(true, false), undefined]) {
    const fake = createFakeJiraRequest();
    fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
    const gate = confirmingGate(confirmer);
    const args = { key: 'ABC-1' };

    const planId = planIdOf(await gate.execute(callOf(deleteTool, args, {}, fake.fn)));
    fake.reset();

    const refused = await gate.execute(
      callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
    );

    assert.equal(refused.error?.kind, 'write_gated');
    assert.match(refused.error?.message ?? '', /does not support form elicitation/);
    assert.ok(refused.error?.remediation?.includes(CONFIRM_ENV_VAR));
    assert.deepEqual(fake.calls, []);
    assert.equal(gate.outstandingPlans, 1, 'the plan survives a client switch');
    assert.equal(confirmer?.asked.length ?? 0, 0);
  }
});

test('[CC-3016] a confirmation request that fails counts as a decline', async () => {
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  const gate = confirmingGate(scriptedConfirmer(new Error('client went away')));
  const args = { key: 'ABC-1' };

  const planId = planIdOf(await gate.execute(callOf(deleteTool, args, {}, fake.fn)));
  fake.reset();

  const refused = await gate.execute(
    callOf(deleteTool, args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(refused.error?.kind, 'write_gated');
  assert.match(refused.error?.message ?? '', /could not be delivered/);
  assert.deepEqual(fake.calls, []);
  assert.equal(gate.outstandingPlans, 0);
});

test('[CC-3017] nobody is asked for a standard write, under off, or for a plan that fails its checks', async () => {
  const never: IrreversibleConfirmer = {
    available: () => true,
    ask: () => Promise.reject(new Error('must not be asked')),
  };

  // A standard-tier write under elicit.
  const standard = createFakeJiraRequest();
  standard.on('POST /rest/api/3/issue', jiraOk({ key: 'ABC-9' }));
  const gate = confirmingGate(never);
  const planId = planIdOf(
    await gate.execute(callOf(writeTool, { summary: 'S' }, {}, standard.fn)),
  );
  const created = await gate.execute(
    callOf(writeTool, { summary: 'S' }, { apply: true, plan_id: planId }, standard.fn),
  );
  assert.equal(created.ok, true);

  // An irreversible write under off.
  const fake = createFakeJiraRequest();
  fake.on('GET /rest/api/3/issue/ABC-1', jiraOk({ summary: 'Old title' }));
  fake.on('DELETE /rest/api/3/issue/ABC-1', jiraOk(undefined, { status: 204 }));
  const off = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: true,
    irreversibleConfirm: 'off',
    confirmer: never,
    rng: countingRng(),
  });
  const offId = planIdOf(
    await off.execute(callOf(deleteTool, { key: 'ABC-1' }, {}, fake.fn)),
  );
  const deleted = await off.execute(
    callOf(deleteTool, { key: 'ABC-1' }, { apply: true, plan_id: offId }, fake.fn),
  );
  assert.equal(deleted.ok, true);

  // A mismatched apply under elicit: refused by the plan_id, never asked.
  const elicit = confirmingGate(never);
  const id = planIdOf(
    await elicit.execute(callOf(deleteTool, { key: 'ABC-1' }, {}, fake.fn)),
  );
  const mismatch = await elicit.execute(
    callOf(deleteTool, { key: 'ABC-2' }, { apply: true, plan_id: id }, fake.fn),
  );
  assert.equal(mismatch.error?.kind, 'write_gated');
  assert.match(mismatch.error?.message ?? '', /arguments changed/);

  // Without the opt-in the tier refusal still comes first.
  const locked = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    irreversibleConfirm: 'elicit',
    confirmer: never,
    rng: countingRng(),
  });
  const lockedId = planIdOf(
    await locked.execute(callOf(deleteTool, { key: 'ABC-1' }, {}, fake.fn)),
  );
  const tier = await locked.execute(
    callOf(deleteTool, { key: 'ABC-1' }, { apply: true, plan_id: lockedId }, fake.fn),
  );
  assert.ok(tier.error?.message.includes(IRREVERSIBLE_ENV_VAR));
});

test('confirmSummary caps the before excerpt and omits it when nothing was noted', () => {
  const planned = { method: 'DELETE', path: '/rest/api/3/issue/ABC-1' } as const;
  const bare = confirmSummary('jira_x', planned, { noted: false, value: undefined });
  assert.equal(
    bare,
    'Confirm IRREVERSIBLE jira_x: DELETE /rest/api/3/issue/ABC-1. Jira cannot undo this.',
  );

  const long = confirmSummary('jira_x', planned, {
    noted: true,
    value: 'y'.repeat(5000),
  });
  assert.ok(long.startsWith(`${bare} It destroys: "`));
  assert.ok(long.endsWith('…'));
  assert.ok(
    long.length <= bare.length + ' It destroys: '.length + CONFIRM_BEFORE_MAX_CHARS + 1,
  );
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

// ---------------------------------------------------------------------------
// Plan context: diff and stale plans (D132)
// ---------------------------------------------------------------------------

/** A PUT whose plan context reads the live summary and `updated` stamp. */
const editTool = defineTool({
  name: 'jira_test_edit',
  title: 'Test edit',
  description: 'Overwrites a summary.',
  package: 'issues-write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  writeTier: 'standard',
  input: writeToolInput({ summary: z.string() }),
  async handler(args, ctx) {
    await ctx.jira({
      method: 'PUT',
      path: '/issue/ABC-1',
      pathTemplate: '/issue/{key}',
      body: { fields: { summary: args.summary } },
    });
    return ok({ edited: true });
  },
});

function editCallOf(
  args: { summary: string },
  control: ControlFields,
  jira: JiraRequestFn,
  context?: WriteGateCall['context'],
): WriteGateCall {
  return {
    ...callOf(editTool, args, control, jira),
    context:
      context ??
      (async (seam) => {
        const live = await seam<{ fields: { summary: string; updated: string } }>({
          method: 'GET',
          path: '/issue/ABC-1',
          pathTemplate: '/issue/{key}',
        });
        return {
          diff: [{ field: 'summary', from: live.data.fields.summary, to: args.summary }],
          version: live.data.fields.updated,
        };
      }),
  };
}

const LIVE_ROUTE = 'GET /rest/api/3/issue/ABC-1';
const PUT_ROUTE = 'PUT /rest/api/3/issue/ABC-1';

function liveIssue(updated: string, summary = 'Old title'): ReturnType<typeof jiraOk> {
  return jiraOk({ fields: { summary, updated } });
}

test('CC-1465: a plan carries the context diff, tainted, and sends nothing', async () => {
  const fake = createFakeJiraRequest();
  fake.on(LIVE_ROUTE, liveIssue('2026-10-24T10:00:00.000+0000'));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });

  const planned = await gate.execute(editCallOf({ summary: 'New title' }, {}, fake.fn));

  assert.equal(planned.ok, true);
  assert.deepEqual((planned.data as { diff: unknown }).diff, [
    { field: 'summary', from: 'Old title', to: 'New title' },
  ]);
  assert.equal(planned._untrusted, true, 'the diff echoes tenant data');
  assert.deepEqual(fake.routes(), [LIVE_ROUTE], 'only the context read left the process');
});

test('CC-1466: an apply against an unchanged issue writes once', async () => {
  const fake = createFakeJiraRequest();
  fake.on(LIVE_ROUTE, liveIssue('2026-10-24T10:00:00.000+0000'));
  fake.on(PUT_ROUTE, jiraOk(undefined, { status: 204 }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { summary: 'New title' };

  const planId = planIdOf(await gate.execute(editCallOf(args, {}, fake.fn)));
  const applied = await gate.execute(
    editCallOf(args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(applied.ok, true);
  assert.deepEqual(fake.routes(), [LIVE_ROUTE, LIVE_ROUTE, PUT_ROUTE]);
  assert.equal(gate.outstandingPlans, 0);
});

test('CC-1467: an issue changed after the plan is refused as stale and the plan is spent', async () => {
  const fake = createFakeJiraRequest();
  fake.on(LIVE_ROUTE, liveIssue('2026-10-24T10:00:00.000+0000'), 1);
  fake.on(LIVE_ROUTE, liveIssue('2026-10-24T10:05:00.000+0000', 'Someone else'));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { summary: 'New title' };

  const planId = planIdOf(await gate.execute(editCallOf(args, {}, fake.fn)));
  const refused = await gate.execute(
    editCallOf(args, { apply: true, plan_id: planId }, fake.fn),
  );

  assert.equal(refused.ok, false);
  assert.equal(refused.error?.kind, 'write_gated');
  assert.ok(refused.error?.message.includes('changed in Jira after the plan'));
  assert.ok(refused.error?.message.includes('Nothing was sent to Jira'));
  assert.deepEqual(fake.routes(), [LIVE_ROUTE, LIVE_ROUTE], 'no PUT');
  assert.equal(gate.outstandingPlans, 0, 'a stale plan_id is burned');

  const replay = await gate.execute(
    editCallOf(args, { apply: true, plan_id: planId }, fake.fn),
  );
  assert.equal(replay.error?.kind, 'write_gated');
  assert.ok(!fake.routes().includes(PUT_ROUTE));
});

test('CC-1468: a failed context read in plan mode still issues a plan, without a diff', async () => {
  const fake = createFakeJiraRequest();
  fake.on(
    LIVE_ROUTE,
    jiraErr(new JiraError({ kind: 'not_found', message: '404 from Jira.' })),
  );
  fake.on(PUT_ROUTE, jiraOk(undefined, { status: 204 }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { summary: 'New title' };

  const planned = await gate.execute(editCallOf(args, {}, fake.fn));

  assert.equal(planned.ok, true);
  assert.equal(Object.hasOwn(planned.data as object, 'diff'), false);
  assert.equal(planned._untrusted, undefined);

  // No version was bound, so the apply skips the stale check — but it still
  // reads the context, and that read failing is now an error.
  const applied = await gate.execute(
    editCallOf(args, { apply: true, plan_id: planIdOf(planned) }, fake.fn),
  );
  assert.equal(applied.ok, false);
  assert.equal(applied.error?.kind, 'not_found');
  assert.equal(gate.outstandingPlans, 1, 'a failed pre-read must not cost the plan_id');
  assert.ok(!fake.routes().includes(PUT_ROUTE));
});

test('CC-1469: a plan bound to no version applies without a stale check', async () => {
  const fake = createFakeJiraRequest();
  fake.on(PUT_ROUTE, jiraOk(undefined, { status: 204 }));
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const args = { summary: 'New title' };
  let reads = 0;
  const versionless: WriteGateCall['context'] = () => {
    reads += 1;
    return Promise.resolve({ diff: [] });
  };

  const planId = planIdOf(await gate.execute(editCallOf(args, {}, fake.fn, versionless)));
  const applied = await gate.execute(
    editCallOf(args, { apply: true, plan_id: planId }, fake.fn, versionless),
  );

  assert.equal(applied.ok, true);
  assert.equal(reads, 2);
  assert.deepEqual(fake.routes(), [PUT_ROUTE]);
});

test('CC-1470: a context that tries to write is refused before the network', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const sneaky: WriteGateCall['context'] = async (seam) => {
    await seam({ method: 'DELETE', path: '/issue/ABC-1', pathTemplate: '/issue/{key}' });
    return { diff: [] };
  };

  const planned = await gate.execute(editCallOf({ summary: 'x' }, {}, fake.fn, sneaky));

  assert.equal(planned.ok, true, 'the write itself is still planned');
  assert.equal(Object.hasOwn(planned.data as object, 'diff'), false);
  assert.deepEqual(fake.calls, []);
});

test('CC-1471: a handler that refuses locally costs no context read', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'apply',
    allowIrreversible: false,
    rng: countingRng(),
  });
  let reads = 0;
  const call: WriteGateCall = {
    ...callOf(writeTool, { summary: '' }, {}, fake.fn),
    invoke: () => Promise.resolve(ok({ refused: true })),
    context: () => {
      reads += 1;
      return Promise.resolve({ diff: [] });
    },
  };

  const result = await gate.execute(call);

  assert.deepEqual(result.data, { refused: true });
  assert.equal(reads, 0, 'only a captured mutation earns the read');
  assert.deepEqual(fake.calls, []);
});

// ---------------------------------------------------------------------------
// Preflight (the JIRA_PROJECTS scope guard, D400)
// ---------------------------------------------------------------------------

test('CC-4003: [D400] a plan-mode mutation the preflight refuses issues no plan', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const seen: string[] = [];
  // The refusal reaches the handler as its write's failure, as on apply.
  await assert.rejects(
    gate.execute({
      ...callOf(writeTool, { summary: 's' }, {}, fake.fn),
      preflight: (req) => {
        seen.push(`${req.method} ${req.path}`);
        return Promise.reject(
          new JiraError({
            kind: 'permission',
            message: 'outside the scope',
            retryable: false,
          }),
        );
      },
    }),
    (error: unknown) => error instanceof JiraError && error.kind === 'permission',
  );
  assert.deepEqual(seen, ['POST /issue']);
  assert.equal(gate.outstandingPlans, 0);
  assert.equal(fake.calls.length, 0);
});

test('[D400] a plan-mode mutation the preflight admits is planned as before', async () => {
  const fake = createFakeJiraRequest();
  const gate = createWriteGate({
    writeMode: 'plan',
    allowIrreversible: false,
    rng: countingRng(),
  });
  const result = await gate.execute({
    ...callOf(writeTool, { summary: 's' }, {}, fake.fn),
    preflight: () => Promise.resolve(),
  });
  assert.equal(result.ok, true);
  planIdOf(result);
  assert.equal(fake.calls.length, 0);
});
