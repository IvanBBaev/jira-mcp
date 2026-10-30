// The real catalogue over the wire, per profile (V3-41, QA-R10).
//
// `mcp/call-time-guard.test.ts` proves the gating mechanism with `defineTool`
// fixtures. This file runs the same wire — `buildServer` over InMemoryTransport
// with the real `PACKAGES` — under four configurations and checks the result
// against an expectation derived from the reviewed manifest snapshot, not from
// the registry's own tables:
//
//   * default    — every package, `apply` mode, irreversible tier off;
//   * reader     — `JIRA_TOOL_PACKAGES=reader`;
//   * read-only  — `JIRA_PACKAGES_READONLY=all`;
//   * plan       — every package, `JIRA_WRITE_MODE=plan`.
//
// For each it compares `tools/list` (names and annotations) with the
// expectation, calls every tool it does not list and expects the refusal that
// names why, and calls one write per tier to see the gate answer. Moving a
// write tool into another package, or letting one through the reader profile,
// fails here.
//
// It lives in `tools/` rather than `mcp/` because it imports the manifest, and
// `mcp` may not import `tools` (the layering lint).

import assert from 'node:assert/strict';
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
import type { Rng, Settings } from '../core/types.js';
import { buildServer } from '../mcp/server.js';
import type { ToolResult } from '../mcp/types.js';

import { PACKAGES } from './index.js';

// ---------------------------------------------------------------------------
// The expectation: the reviewed manifest snapshot
// ---------------------------------------------------------------------------

interface SnapshotTool {
  readonly name: string;
  readonly annotations: ToolAnnotations;
  readonly writeTier?: 'standard' | 'irreversible';
}

interface Snapshot {
  readonly packages: readonly { readonly id: string; readonly tools: SnapshotTool[] }[];
}

const SNAPSHOT = JSON.parse(
  readFileSync(
    new URL('../../src/tools/manifest.snapshot.json', import.meta.url),
    'utf8',
  ),
) as Snapshot;

/** Every tool of the snapshot with its package. */
const CATALOGUE = SNAPSHOT.packages.flatMap((pkg) =>
  pkg.tools.map((tool) => ({ ...tool, pkg: pkg.id })),
);

/**
 * What the `reader` profile selects, as CONFIGURATION.md documents it — written
 * out here so a change to the registry's profile table has to change this too.
 */
const READER_PACKAGES: ReadonlySet<string> = new Set([
  'core',
  'search',
  'issues',
  'meta',
  'users',
  'agile',
]);

/** Why a configuration leaves a tool out, and the error kind that names it. */
type Exclusion = 'package_disabled' | 'readonly';

const REFUSAL_KIND: Readonly<Record<Exclusion, string>> = {
  package_disabled: 'config',
  readonly: 'write_gated',
};

interface Profile {
  readonly label: string;
  readonly settings: Partial<Settings>;
  /** The reason a snapshot tool is left out, or `undefined` when it is listed. */
  exclusion(tool: (typeof CATALOGUE)[number]): Exclusion | undefined;
}

const PROFILES: readonly Profile[] = [
  {
    label: 'default',
    settings: {},
    exclusion: () => undefined,
  },
  {
    label: 'reader',
    settings: { toolPackages: ['reader'] },
    exclusion: (tool) =>
      !READER_PACKAGES.has(tool.pkg)
        ? 'package_disabled'
        : tool.writeTier !== undefined
          ? 'readonly'
          : undefined,
  },
  {
    label: 'read-only',
    settings: { packagesReadonly: ['all'] },
    exclusion: (tool) => (tool.writeTier !== undefined ? 'readonly' : undefined),
  },
  {
    label: 'plan',
    settings: { writeMode: 'plan' },
    exclusion: () => undefined,
  },
];

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

const ISSUE = {
  id: '10001',
  key: 'ABC-1',
  fields: {
    summary: 'Summary of ABC-1',
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    issuetype: { id: '10000', name: 'Task', subtask: false },
    project: { id: '1000', key: 'ABC' },
    subtasks: [],
    labels: [],
  },
};

interface Harness {
  readonly client: Client;
  readonly jira: FakeJiraRequest;
  readonly journal: MemoryJournal;
}

async function withServer(
  settings: Partial<Settings>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const clock = createFakeClock(1_000);
  // Reads are answered (a plan may read the issue it is about); anything else
  // is unmatched and fails loudly.
  const jira = createFakeJiraRequest().on(
    (req) => req.method === 'GET' || req.safe === true,
    jiraOk(ISSUE),
  );
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
  const client = new Client({ name: 'catalogue-wire-test', version: '0.0.0' });
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
): Promise<{ result: CallToolResult; envelope: ToolResult<Record<string, unknown>> }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  assert.ok(result.structuredContent, `${name}: expected a structuredContent channel`);
  return {
    result,
    envelope: result.structuredContent as unknown as ToolResult<Record<string, unknown>>,
  };
}

function assertNothingSent(h: Harness, label: string): void {
  assert.deepEqual(h.jira.routes(), [], `${label}: nothing may reach Jira`);
  assert.deepEqual(h.journal.entries, [], `${label}: nothing may be journaled`);
}

/** The one write per tier each profile is probed with. */
const WRITES = {
  standard: { name: 'jira_add_comment', args: { issue: 'ABC-1', body: 'A comment.' } },
  irreversible: { name: 'jira_delete_issue', args: { issue: 'ABC-1' } },
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('[CC-5195] the snapshot expectation is non-trivial and the probe writes carry their tiers', () => {
  assert.ok(CATALOGUE.length >= 80, `the snapshot lists only ${CATALOGUE.length} tools`);
  const byName = new Map(CATALOGUE.map((tool) => [tool.name, tool]));
  assert.equal(byName.get(WRITES.standard.name)?.writeTier, 'standard');
  assert.equal(byName.get(WRITES.irreversible.name)?.writeTier, 'irreversible');
  // The manifest the server runs is the snapshot's: same names, same packages.
  assert.deepEqual(
    PACKAGES.flatMap((pkg) => pkg.tools.map((tool) => `${pkg.id}/${tool.name}`)).sort(),
    CATALOGUE.map((tool) => `${tool.pkg}/${tool.name}`).sort(),
  );
  for (const profile of PROFILES.slice(1, 3)) {
    assert.ok(
      CATALOGUE.some((tool) => profile.exclusion(tool) === 'readonly'),
      `${profile.label}: some write must be stripped`,
    );
  }
});

for (const profile of PROFILES) {
  test(`[CC-5196] ${profile.label}: tools/list over the wire is the snapshot's expectation, annotations included`, async () => {
    await withServer(profile.settings, async (h) => {
      const listed = (await h.client.listTools()).tools;
      const expected = CATALOGUE.filter((tool) => profile.exclusion(tool) === undefined);
      assert.deepEqual(
        listed.map((tool) => tool.name).sort(),
        expected.map((tool) => tool.name).sort(),
      );
      const byName = new Map(expected.map((tool) => [tool.name, tool]));
      for (const tool of listed) {
        const want = byName.get(tool.name);
        assert.deepEqual(
          tool.annotations,
          want?.annotations,
          `${tool.name}: annotations`,
        );
        assert.equal(
          tool.annotations?.readOnlyHint,
          want?.writeTier === undefined,
          `${tool.name}: readOnlyHint must say whether it writes`,
        );
      }
      assertNothingSent(h, `${profile.label} tools/list`);
    });
  });

  test(`[CC-5197] ${profile.label}: every tool it does not list is refused at invocation with the reason's kind`, async () => {
    await withServer(profile.settings, async (h) => {
      for (const tool of CATALOGUE) {
        const exclusion = profile.exclusion(tool);
        if (exclusion === undefined) continue;
        const { result, envelope } = await call(h.client, tool.name, {});
        assert.equal(result.isError, true, `${tool.name}: expected isError`);
        assert.equal(envelope.ok, false, `${tool.name}: expected a refusal`);
        assert.equal(
          envelope.error?.kind,
          REFUSAL_KIND[exclusion],
          `${tool.name} (${exclusion}): ${JSON.stringify(envelope.error)}`,
        );
      }
      assertNothingSent(h, `${profile.label} unlisted calls`);
    });
  });
}

test('[CC-5198] default (apply, irreversible off): an apply without a plan is gated per tier, nothing sent', async () => {
  await withServer({}, async (h) => {
    for (const write of Object.values(WRITES)) {
      const { envelope } = await call(h.client, write.name, {
        ...write.args,
        apply: true,
      });
      assert.equal(envelope.ok, false, write.name);
      assert.equal(envelope.error?.kind, 'write_gated', JSON.stringify(envelope.error));
    }
    const { envelope } = await call(h.client, WRITES.irreversible.name, {
      ...WRITES.irreversible.args,
      apply: true,
    });
    assert.match(envelope.error?.remediation ?? '', /JIRA_ALLOW_IRREVERSIBLE/);
    assertNothingSent(h, 'default writes');
  });
});

test('[CC-5199] plan: an apply of either tier returns an unexecuted plan and sends only reads', async () => {
  await withServer({ writeMode: 'plan' }, async (h) => {
    for (const write of Object.values(WRITES)) {
      const { envelope } = await call(h.client, write.name, {
        ...write.args,
        apply: true,
      });
      assert.equal(envelope.ok, true, `${write.name}: ${JSON.stringify(envelope.error)}`);
      assert.equal(envelope.data?.['executed'], false, write.name);
      assert.equal(typeof envelope.data?.['plan_id'], 'string', write.name);
    }
    for (const req of h.jira.calls) {
      assert.ok(
        req.method === 'GET' || req.safe === true,
        `plan mode sent ${req.method} ${req.path}`,
      );
    }
    assert.deepEqual(h.journal.entries, [], 'a plan is not journaled');
  });
});
