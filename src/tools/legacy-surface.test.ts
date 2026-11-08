// The frozen 1.x legacy surface (V3-45, QA-R6).
//
// `test/legacy-surface-1.x.json` is a copy of `manifest.snapshot.json` taken on
// 2026-10-30, before the 2.0 renames (V3-24). That work regenerates the
// snapshot, so `index.test.ts` stops protecting the old names the moment it
// starts. This file holds them instead: through 2.x, every 1.x name, called
// over the wire under that name, must
//
//   (a) resolve to a callable tool;
//   (b) accept arguments built from its 1.x input schema, and still refuse an
//       unknown key;
//   (c) keep its 1.x write tier (read, standard, irreversible) and, wherever it
//       is listed under that name, its 1.x annotations;
//   (d) obey the package filters (JIRA_PACKAGES_DENY, JIRA_TOOL_PACKAGES,
//       JIRA_PACKAGES_READONLY, the reader profile) for its 1.x package, and
//       the JIRA_PROJECTS scope;
//   (e) once renamed, stay out of `tools/list` — a 1.x name that is not listed
//       is a hidden alias, and every check above still runs against it.
//
// The checks are behavioural and use only the old name, so they do not care
// how V3-24 implements its aliases. Both files are frozen: the JSON by the
// hash pinned below, and this file by review — a pure move of the server code
// keeps these tests unchanged, and deleting an alias or changing its tier
// fails one of them.
//
// It lives in `tools/` rather than `mcp/` because it runs the real `PACKAGES`,
// and `mcp` may not import `tools` (the layering lint).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import type { FakeJiraRequest } from '../core/fakes/fakeJiraRequest.js';
import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { FAKE_AUTH_SETTINGS } from '../core/fakes/fakeSettings.js';
import { createMemoryJournal } from '../core/fakes/memoryJournal.js';
import type { MemoryJournal } from '../core/fakes/memoryJournal.js';
import type { JiraRequestSpec, Rng, Settings } from '../core/types.js';
import { buildServer } from '../mcp/server.js';
import type { ToolResult } from '../mcp/types.js';

import { PACKAGES } from './index.js';

// ---------------------------------------------------------------------------
// The frozen surface
// ---------------------------------------------------------------------------

/** sha256 of `JSON.stringify(JSON.parse(file))`, so formatting may change. */
const FROZEN_SHA256 = '1bb7be4314fcb80b40bdccbd3d4c568425222b422f5b42815730b2e2eed4f9ac';

/** The 1.x surface as it was frozen; the count is part of the contract. */
const FROZEN_TOOL_COUNT = 82;
const FROZEN_WRITE_COUNTS = { standard: 29, irreversible: 11 } as const;

interface JsonSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
}

type Tier = 'read' | 'standard' | 'irreversible';

interface LegacyTool {
  readonly name: string;
  readonly pkg: string;
  readonly tier: Tier;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: JsonSchema;
}

interface FrozenFile {
  readonly packages: readonly {
    readonly id: string;
    readonly tools: readonly {
      readonly name: string;
      readonly annotations: ToolAnnotations;
      readonly writeTier?: 'standard' | 'irreversible';
      readonly inputSchema: JsonSchema;
    }[];
  }[];
}

const FROZEN_TEXT = readFileSync(
  new URL('../../test/legacy-surface-1.x.json', import.meta.url),
  'utf8',
);
const FROZEN = JSON.parse(FROZEN_TEXT) as FrozenFile;

const LEGACY: readonly LegacyTool[] = FROZEN.packages.flatMap((pkg) =>
  pkg.tools.map((tool) => ({
    name: tool.name,
    pkg: pkg.id,
    tier: tool.writeTier ?? 'read',
    annotations: tool.annotations,
    inputSchema: tool.inputSchema,
  })),
);

const LEGACY_PACKAGES: readonly string[] = FROZEN.packages.map((pkg) => pkg.id);

/** The package the server always loads, whatever the filters say. */
const ALWAYS_ON = 'core';

/** What the `reader` profile selected in 1.x, as CONFIGURATION.md documents it. */
const READER_PACKAGES_1X: ReadonlySet<string> = new Set([
  'core',
  'search',
  'issues',
  'meta',
  'users',
  'agile',
]);

// ---------------------------------------------------------------------------
// Arguments built from the 1.x input schema
// ---------------------------------------------------------------------------

/** Values a field of a given name gets, before the generic candidates. */
const BY_FIELD: Readonly<Record<string, string>> = {
  issue: 'ABC-1',
  project: 'ABC',
  jql: 'project = ABC',
  accountId: '557058:abc',
  body: 'A body.',
  comment: 'A comment.',
  reconcileIssues: '10001',
  url: 'https://example.com/pull/42',
};

/** A field named `…Id` or `…Ids` takes a numeric Jira id. */
const NUMERIC_ID_FIELD = /Ids?$/;

/** Tried in order; the first that fits the field's pattern and length wins. */
const CANDIDATES: readonly string[] = [
  'ABC-1',
  'ABC',
  '1',
  '2026-10-30',
  '2026-10-30T10:00:00Z',
  'text/plain',
  'x',
];

/**
 * Cross-field rules that JSON Schema cannot state (exactly-one-of, at least
 * one change). These are frozen with the rest: each override is the 1.x way to
 * call the tool, and must stay valid.
 */
const REQUIRED_EXTRAS: Readonly<Record<string, Record<string, unknown>>> = {
  jira_get_issue: { issue: 'ABC-1' },
  jira_update_issue: { summary: 'A summary' },
  jira_update_filter: { name: 'A filter' },
  jira_assign_issue: { accountId: '557058:abc' },
  jira_add_worklog: { timeSpentSeconds: 60 },
  jira_update_worklog: { timeSpentSeconds: 60 },
  jira_bulk_edit_issues: { priorityId: '1' },
  jira_add_watcher: { accountId: '557058:abc' },
  jira_remove_watcher: { accountId: '557058:abc' },
};

/** Optional fields left out of the full call: the other half of an either-or. */
const FULL_EXCLUDES: Readonly<Record<string, readonly string[]>> = {
  jira_get_issue: ['issues'],
  jira_assign_issue: ['username', 'unassign'],
  jira_add_worklog: ['timeSpent'],
  jira_update_worklog: ['timeSpent'],
  jira_add_watcher: ['username'],
  jira_remove_watcher: ['username'],
};

/** Tools refused before the scope guard runs, with the refusal they get. */
const SCOPE_PRECONDITIONS: Readonly<Record<string, RegExp>> = {
  // No JIRA_MEDIA_DIR in this harness: an upload is refused up front.
  jira_upload_attachment: /JIRA_MEDIA_DIR/,
};

/**
 * Control fields the registry owns: `profile` is refused under a locked
 * profile, `output` may route to a file, and `apply`/`plan_id` are set by
 * each test itself.
 */
const CONTROL_FIELDS: ReadonlySet<string> = new Set([
  'profile',
  'output',
  'apply',
  'plan_id',
]);

function sampleString(field: string, schema: JsonSchema): string {
  const named = BY_FIELD[field] ?? (NUMERIC_ID_FIELD.test(field) ? '10001' : undefined);
  for (const candidate of named === undefined ? CANDIDATES : [named, ...CANDIDATES]) {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(candidate))
      continue;
    if (schema.minLength !== undefined && candidate.length < schema.minLength) continue;
    if (schema.maxLength !== undefined && candidate.length > schema.maxLength) continue;
    return candidate;
  }
  throw new Error(`no sample fits ${field}: ${JSON.stringify(schema)}`);
}

function sampleValue(field: string, schema: JsonSchema): unknown {
  const [first] = schema.anyOf ?? [];
  if (first !== undefined) return sampleValue(field, first);
  if (schema.enum !== undefined) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      return sampleString(field, schema);
    case 'integer':
    case 'number': {
      const low =
        schema.minimum ??
        (schema.exclusiveMinimum === undefined ? 1 : schema.exclusiveMinimum + 1);
      return Math.min(low, schema.maximum ?? low);
    }
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: Math.max(1, schema.minItems ?? 1) }, () =>
        sampleValue(field, schema.items ?? { type: 'string' }),
      );
    case 'object':
      return sampleObject(schema, () => false);
    case undefined:
    default:
      throw new Error(`no sample for ${field}: ${JSON.stringify(schema)}`);
  }
}

function sampleObject(
  schema: JsonSchema,
  includeOptional: (field: string) => boolean,
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [field, child] of Object.entries(schema.properties ?? {})) {
    if (CONTROL_FIELDS.has(field)) continue;
    if (required.has(field) || includeOptional(field))
      out[field] = sampleValue(field, child);
  }
  return out;
}

/** Required fields only (plus the frozen either-or choice). */
function minimalArgs(tool: LegacyTool): Record<string, unknown> {
  return {
    ...sampleObject(tool.inputSchema, () => false),
    ...REQUIRED_EXTRAS[tool.name],
  };
}

/** Every 1.x field except control fields and the excluded half of an either-or. */
function fullArgs(tool: LegacyTool): Record<string, unknown> {
  const excluded = new Set(FULL_EXCLUDES[tool.name] ?? []);
  return {
    ...sampleObject(tool.inputSchema, (field) => !excluded.has(field)),
    ...REQUIRED_EXTRAS[tool.name],
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const BASE_SETTINGS: Settings = {
  allowedHosts: [],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'apply',
  allowIrreversible: false,
  irreversibleConfirm: 'off',
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  metaCacheTtlS: 300,
  mediaMaxBytes: 1073741824,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
  ...FAKE_AUTH_SETTINGS,
};

function countingRng(): Rng {
  let n = 1;
  return (): number => {
    n += 1;
    return (n % 4096) / 4096;
  };
}

function issueIn(project: string): Record<string, unknown> {
  const projectId = project === 'ABC' ? '1000' : '2000';
  return {
    id: '10001',
    key: `${project}-1`,
    fields: {
      summary: `Summary of ${project}-1`,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { id: '10000', name: 'Task', subtask: false },
      project: { id: projectId, key: project },
      subtasks: [],
      labels: [],
    },
  };
}

const isRead = (req: JiraRequestSpec): boolean =>
  req.method === 'GET' || req.safe === true;

interface Harness {
  readonly client: Client;
  readonly jira: FakeJiraRequest;
  readonly journal: MemoryJournal;
}

async function withServer(
  settings: Partial<Settings>,
  fn: (h: Harness) => Promise<void>,
  world: { readonly project: string } = { project: 'ABC' },
): Promise<void> {
  const clock = createFakeClock(1_000);
  // Reads are answered with one issue; a write is unmatched and fails loudly,
  // so no test here can mutate anything by accident.
  const jira = createFakeJiraRequest().on(isRead, jiraOk(issueIn(world.project)));
  const journal = createMemoryJournal(clock);
  const server = buildServer({
    settings: { ...BASE_SETTINGS, ...settings },
    packages: PACKAGES,
    serverName: 'jira-mcp-ai',
    version: '9.9.9',
    jira: jira.fn,
    logger: createFakeLogger(),
    redactor: createFakeRedactor([]),
    clock,
    rng: countingRng(),
    journal,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'legacy-surface-test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    await fn({ client, jira, journal });
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult<Record<string, unknown>>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  assert.ok(result.structuredContent, `${name}: expected a structuredContent channel`);
  return result.structuredContent as unknown as ToolResult<Record<string, unknown>>;
}

/** The refusal for a tool whose package this configuration did not select. */
function isPackageDisabled(envelope: ToolResult<unknown>): boolean {
  return (
    envelope.error?.kind === 'config' &&
    /package is not enabled/.test(envelope.error.message)
  );
}

function describe(envelope: ToolResult<unknown>): string {
  return JSON.stringify(envelope.error ?? { ok: envelope.ok });
}

/**
 * The registry's refusal of arguments the input schema rejects. A handler may
 * still refuse with `validation` for a reason of the world (no such
 * transition, nothing to change): that is not a schema break.
 */
function isSchemaRefusal(envelope: ToolResult<unknown>): boolean {
  return (
    envelope.error?.kind === 'validation' &&
    envelope.error.message.startsWith('Arguments rejected by the schema of ')
  );
}

/** Neither "no such tool" nor "your arguments do not fit the schema". */
function assertServed(
  tool: LegacyTool,
  envelope: ToolResult<unknown>,
  label: string,
): void {
  assert.notEqual(
    envelope.error?.kind,
    'not_found',
    `${tool.name} (${label}): the 1.x name is gone`,
  );
  assert.ok(
    !isSchemaRefusal(envelope),
    `${tool.name} (${label}): 1.x arguments rejected: ${describe(envelope)}`,
  );
}

function assertNoWrites(h: Harness, label: string): void {
  const writes = h.jira.calls.filter((req) => !isRead(req));
  assert.deepEqual(
    writes.map((req) => `${req.method} ${req.path}`),
    [],
    `${label}: nothing may be written`,
  );
  assert.deepEqual(h.journal.entries, [], `${label}: nothing may be journaled`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('[CC-5200] the frozen 1.x surface is intact and self-consistent', () => {
  const digest = createHash('sha256')
    .update(JSON.stringify(JSON.parse(FROZEN_TEXT)))
    .digest('hex');
  assert.equal(
    digest,
    FROZEN_SHA256,
    'test/legacy-surface-1.x.json changed. It is frozen: restore it from git, never regenerate it.',
  );
  assert.equal(LEGACY.length, FROZEN_TOOL_COUNT);
  assert.equal(new Set(LEGACY.map((tool) => tool.name)).size, LEGACY.length);
  assert.equal(
    LEGACY.filter((t) => t.tier === 'standard').length,
    FROZEN_WRITE_COUNTS.standard,
  );
  assert.equal(
    LEGACY.filter((t) => t.tier === 'irreversible').length,
    FROZEN_WRITE_COUNTS.irreversible,
  );
  assert.ok(LEGACY_PACKAGES.includes(ALWAYS_ON));
  for (const tool of LEGACY) {
    assert.equal(tool.annotations.readOnlyHint, tool.tier === 'read', tool.name);
    if (tool.tier === 'irreversible')
      assert.equal(tool.annotations.destructiveHint, true);
  }
  // The overrides name only 1.x tools, so a typo cannot silently skip one.
  const names = new Set(LEGACY.map((tool) => tool.name));
  for (const name of [
    ...Object.keys(REQUIRED_EXTRAS),
    ...Object.keys(FULL_EXCLUDES),
    ...Object.keys(SCOPE_PRECONDITIONS),
  ]) {
    assert.ok(names.has(name), `override for unknown tool ${name}`);
  }
});

test('[CC-5201] every 1.x name is callable with its required 1.x arguments (plan mode)', async () => {
  await withServer({ writeMode: 'plan' }, async (h) => {
    for (const tool of LEGACY) {
      assertServed(tool, await call(h.client, tool.name, minimalArgs(tool)), 'minimal');
    }
    assertNoWrites(h, 'minimal calls');
  });
});

test('[CC-5202] every 1.x name accepts all of its 1.x fields, and still refuses an unknown key', async () => {
  await withServer({ writeMode: 'plan' }, async (h) => {
    for (const tool of LEGACY) {
      assertServed(tool, await call(h.client, tool.name, fullArgs(tool)), 'full');
      const strict = await call(h.client, tool.name, {
        ...minimalArgs(tool),
        legacy_surface_probe: true,
      });
      assert.ok(
        isSchemaRefusal(strict),
        `${tool.name}: an unknown key must still be refused: ${describe(strict)}`,
      );
    }
    assertNoWrites(h, 'full calls');
  });
});

test('[CC-5203] a 1.x name that is listed carries its 1.x annotations; one that is not is a hidden alias', async () => {
  await withServer({ allowIrreversible: true }, async (h) => {
    const listed = new Map((await h.client.listTools()).tools.map((t) => [t.name, t]));
    let hidden = 0;
    for (const tool of LEGACY) {
      const entry = listed.get(tool.name);
      if (entry === undefined) {
        // Renamed: not listed, still served (CC-5201/5202 call it by this name).
        hidden += 1;
        continue;
      }
      assert.deepEqual(entry.annotations, tool.annotations, `${tool.name}: annotations`);
    }
    // Hidden aliases do not crowd the list: it never holds more 1.x names than
    // there are, and every hidden one is accounted for by a listed newcomer.
    const newcomers = [...listed.keys()].filter(
      (name) => !LEGACY.some((tool) => tool.name === name),
    );
    assert.ok(
      newcomers.length >= hidden,
      `${String(hidden)} hidden 1.x names, ${String(newcomers.length)} new names`,
    );
  });
});

test('[CC-5204] read-only everywhere: a 1.x write is refused as write_gated, a 1.x read is served', async () => {
  await withServer({ packagesReadonly: ['all'] }, async (h) => {
    for (const tool of LEGACY) {
      const envelope = await call(h.client, tool.name, minimalArgs(tool));
      if (tool.tier === 'read') {
        assertServed(tool, envelope, 'read-only');
        assert.notEqual(
          envelope.error?.kind,
          'write_gated',
          `${tool.name}: ${describe(envelope)}`,
        );
      } else {
        assert.equal(
          envelope.error?.kind,
          'write_gated',
          `${tool.name}: ${describe(envelope)}`,
        );
      }
    }
    assertNoWrites(h, 'read-only');
  });
});

test('[CC-5205] apply mode, irreversible tier off: a 1.x write keeps its tier at the gate', async () => {
  await withServer({}, async (h) => {
    for (const tool of LEGACY) {
      if (tool.tier === 'read') continue;
      const envelope = await call(h.client, tool.name, {
        ...minimalArgs(tool),
        apply: true,
      });
      assert.equal(
        envelope.error?.kind,
        'write_gated',
        `${tool.name}: ${describe(envelope)}`,
      );
      const namesTier = /JIRA_ALLOW_IRREVERSIBLE/.test(envelope.error?.remediation ?? '');
      assert.equal(
        namesTier,
        tool.tier === 'irreversible',
        `${tool.name} (${tool.tier}): ${describe(envelope)}`,
      );
    }
    assertNoWrites(h, 'apply without a plan');
  });
});

for (const pkg of LEGACY_PACKAGES) {
  test(`[CC-5206] JIRA_PACKAGES_DENY=${pkg} refuses its 1.x names (core stays on)`, async () => {
    await withServer({ packagesDeny: [pkg] }, async (h) => {
      for (const tool of LEGACY) {
        const envelope = await call(h.client, tool.name, minimalArgs(tool));
        assert.equal(
          isPackageDisabled(envelope),
          tool.pkg === pkg && pkg !== ALWAYS_ON,
          `${tool.name} (deny ${pkg}): ${describe(envelope)}`,
        );
      }
      // Default write mode is apply and the calls carry no `apply`: a write is
      // a preview, so nothing is sent either way.
      assertNoWrites(h, `deny ${pkg}`);
    });
  });

  test(`[CC-5207] JIRA_TOOL_PACKAGES=${pkg} serves exactly its 1.x names (plus core), and read-only strips its writes`, async () => {
    await withServer({ toolPackages: [pkg], writeMode: 'plan' }, async (h) => {
      for (const tool of LEGACY) {
        const envelope = await call(h.client, tool.name, minimalArgs(tool));
        const selected = tool.pkg === pkg || tool.pkg === ALWAYS_ON;
        if (selected) assertServed(tool, envelope, `select ${pkg}`);
        assert.equal(
          isPackageDisabled(envelope),
          !selected,
          `${tool.name} (select ${pkg}): ${describe(envelope)}`,
        );
      }
      assertNoWrites(h, `select ${pkg}`);
    });
    await withServer({ packagesReadonly: [pkg] }, async (h) => {
      for (const tool of LEGACY) {
        if (tool.tier === 'read') continue;
        const envelope = await call(h.client, tool.name, minimalArgs(tool));
        assert.equal(
          envelope.error?.kind === 'write_gated',
          tool.pkg === pkg,
          `${tool.name} (readonly ${pkg}): ${describe(envelope)}`,
        );
      }
      assertNoWrites(h, `readonly ${pkg}`);
    });
  });
}

test('[CC-5208] the reader profile serves the 1.x reads of its packages and nothing else', async () => {
  await withServer({ toolPackages: ['reader'] }, async (h) => {
    for (const tool of LEGACY) {
      const envelope = await call(h.client, tool.name, minimalArgs(tool));
      if (!READER_PACKAGES_1X.has(tool.pkg)) {
        assert.ok(isPackageDisabled(envelope), `${tool.name}: ${describe(envelope)}`);
      } else if (tool.tier !== 'read') {
        assert.equal(
          envelope.error?.kind,
          'write_gated',
          `${tool.name}: ${describe(envelope)}`,
        );
      } else {
        assertServed(tool, envelope, 'reader');
      }
    }
    assertNoWrites(h, 'reader');
  });
});

test('[CC-5209] JIRA_PROJECTS: a 1.x name that takes an issue is refused for an issue outside the scope', async () => {
  const takesIssue = LEGACY.filter((tool) =>
    (tool.inputSchema.required ?? []).includes('issue'),
  );
  assert.ok(
    takesIssue.length >= 20,
    `only ${String(takesIssue.length)} 1.x tools take an issue`,
  );
  // Every issue the fake returns lives in XYZ; the scope is ABC.
  await withServer(
    { projects: ['ABC'], writeMode: 'plan' },
    async (h) => {
      for (const tool of takesIssue) {
        const envelope = await call(h.client, tool.name, {
          ...minimalArgs(tool),
          issue: 'XYZ-1',
          ...(tool.tier === 'read' ? {} : { apply: true }),
        });
        const precondition = SCOPE_PRECONDITIONS[tool.name];
        if (precondition !== undefined) {
          // Refused earlier, for a reason that holds whatever the issue.
          assert.equal(
            envelope.error?.kind,
            'config',
            `${tool.name}: ${describe(envelope)}`,
          );
          assert.match(envelope.error?.message ?? '', precondition, tool.name);
          continue;
        }
        assert.equal(
          envelope.error?.kind,
          'permission',
          `${tool.name}: ${describe(envelope)}`,
        );
        assert.match(
          envelope.error?.message ?? '',
          /XYZ/,
          `${tool.name}: names the project`,
        );
      }
      assertNoWrites(h, 'out of scope');
    },
    { project: 'XYZ' },
  );
});
