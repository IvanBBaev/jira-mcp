// Tests for the reference resources (D124): the catalogue `resources/list`
// and `resources/read` serve, and the server instructions handed to the
// client at initialize.

import assert from 'node:assert/strict';
import test from 'node:test';

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { defineTool, toolInput, writeToolInput, z } from './define.js';
import type { ExclusionReason } from './registry.js';
import {
  RESOURCE_NOT_FOUND,
  TOOL_INDEX_URI,
  TOOL_REFERENCE_TEMPLATE,
  WRITE_MODE_REFERENCE,
  WRITE_MODE_URI,
  createReferenceCatalogue,
  serverInstructions,
} from './resources.js';
import type {
  InstructionsInput,
  ReferenceCatalogue,
  ToolIndex,
  ToolReference,
} from './resources.js';
import { ok } from './result.js';
import type { PackageSpec, ReferenceDoc } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const lookupTool = defineTool({
  name: 'jira_lookup',
  title: 'Lookup',
  description: 'Look one thing up.',
  package: 'core',
  annotations: READ_ANNOTATIONS,
  input: toolInput({ key: z.string().describe('The key.') }),
  handler: () => Promise.resolve(ok({})),
  example: { summary: 'Look up ABC-1.', arguments: { key: 'ABC-1' } },
});

const createTool = defineTool({
  name: 'jira_create',
  title: 'Create',
  description: 'Create one thing.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: writeToolInput({ summary: z.string(), points: z.number().int().optional() }),
  handler: () => Promise.resolve(ok({})),
  example: { summary: 'Create a story.', arguments: { summary: 'Story' } },
});

const bareTool = defineTool({
  name: 'jira_bare',
  title: 'Bare',
  description: 'A tool without an example.',
  package: 'meta',
  annotations: READ_ANNOTATIONS,
  input: toolInput({}),
  handler: () => Promise.resolve(ok({})),
});

const JQL_DOC: ReferenceDoc = {
  uri: 'jira://reference/jql',
  title: 'JQL idioms',
  description: 'How to phrase a JQL query.',
  text: '# JQL\n\nproject = ABC ORDER BY created DESC',
};

function manifest(overrides: Partial<PackageSpec>[] = []): readonly PackageSpec[] {
  const base: PackageSpec[] = [
    { id: 'core', title: 'Core', description: 'The core.', tools: [lookupTool] },
    {
      id: 'issues-write',
      title: 'Issue writes',
      description: 'Writes.',
      tools: [createTool],
    },
    {
      id: 'meta',
      title: 'Metadata',
      description: 'Catalogues.',
      tools: [bareTool],
      references: [JQL_DOC],
    },
  ];
  return base.map((pkg, i) => ({ ...pkg, ...overrides[i] }));
}

const NONE: ReadonlyMap<string, ExclusionReason> = new Map();

/** The text of a single-content read; a blob content fails the test. */
function textOf(result: ReadResourceResult): string {
  assert.equal(result.contents.length, 1);
  const [content] = result.contents;
  assert.ok(content !== undefined && 'text' in content, 'a text content');
  return content.text;
}

function readJson<T>(catalogue: ReferenceCatalogue, uri: string): T {
  const result = catalogue.read(uri);
  assert.equal(result.contents[0]?.uri, uri);
  assert.equal(result.contents[0]?.mimeType, 'application/json');
  return JSON.parse(textOf(result)) as T;
}

// ---------------------------------------------------------------------------
// resources/list and resources/templates/list
// ---------------------------------------------------------------------------

test('the catalogue lists the index, the write-mode contract and every package doc', () => {
  const catalogue = createReferenceCatalogue({
    manifest: manifest(),
    excludedTools: NONE,
  });

  assert.deepEqual(
    catalogue.resources.map((r) => [r.uri, r.name, r.mimeType]),
    [
      [TOOL_INDEX_URI, 'tools', 'application/json'],
      [WRITE_MODE_URI, 'write-mode', 'text/markdown'],
      ['jira://reference/jql', 'jql', 'text/markdown'],
    ],
  );
  assert.deepEqual(
    catalogue.references.map((doc) => doc.uri),
    [WRITE_MODE_URI, 'jira://reference/jql'],
    'the mcp-ring document comes first, then manifest order',
  );
  assert.deepEqual(
    catalogue.templates.map((t) => [t.uriTemplate, t.name, t.mimeType]),
    [[TOOL_REFERENCE_TEMPLATE, 'tool', 'application/json']],
  );
  for (const resource of catalogue.resources) {
    assert.ok(resource.title, `${resource.uri} has a title`);
    assert.ok(resource.description, `${resource.uri} has a description`);
  }
});

// ---------------------------------------------------------------------------
// resources/read
// ---------------------------------------------------------------------------

test('the index names every manifest tool, its reference URI and the documents', () => {
  const catalogue = createReferenceCatalogue({
    manifest: manifest(),
    excludedTools: NONE,
  });
  const index = readJson<ToolIndex>(catalogue, TOOL_INDEX_URI);

  assert.equal(index.template, TOOL_REFERENCE_TEMPLATE);
  assert.deepEqual(
    index.references.map((doc) => doc.uri),
    [WRITE_MODE_URI, 'jira://reference/jql'],
  );
  assert.deepEqual(
    index.packages.map((pkg) => [pkg.id, pkg.tools.map((t) => t.name)]),
    [
      ['core', ['jira_lookup']],
      ['issues-write', ['jira_create']],
      ['meta', ['jira_bare']],
    ],
  );
  const [core] = index.packages;
  assert.deepEqual(core?.tools[0], {
    name: 'jira_lookup',
    title: 'Lookup',
    uri: 'jira://reference/tools/jira_lookup',
    registered: true,
  });
});

test('one tool reads back with its trimmed schema, annotations, tier and example', () => {
  const catalogue = createReferenceCatalogue({
    manifest: manifest(),
    excludedTools: NONE,
  });
  const ref = readJson<ToolReference>(catalogue, 'jira://reference/tools/jira_create');

  assert.equal(ref.name, 'jira_create');
  assert.equal(ref.title, 'Create');
  assert.equal(ref.package, 'issues-write');
  assert.equal(ref.description, 'Create one thing.');
  assert.deepEqual(ref.annotations, WRITE_ANNOTATIONS);
  assert.equal(ref.writeTier, 'standard');
  assert.equal(ref.registered, true);
  assert.equal(ref.excluded, undefined);
  assert.deepEqual(ref.example, {
    summary: 'Create a story.',
    arguments: { summary: 'Story' },
  });

  const schema = ref.inputSchema as Record<string, unknown>;
  assert.ok(!('$schema' in schema), 'the schema is the trimmed tools/list one');
  assert.ok(!JSON.stringify(schema).includes('9007199254740991'));
  const properties = schema['properties'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).sort(), [
    'apply',
    'plan_id',
    'points',
    'profile',
    'summary',
  ]);

  const bare = readJson<ToolReference>(catalogue, 'jira://reference/tools/jira_bare');
  assert.equal(bare.writeTier, undefined);
  assert.equal(bare.example, undefined);
  assert.ok(!('example' in bare), 'no example key when the tool has none');
});

test('[CC-1419] a gated-out tool still has a reference, marked unregistered with the reason', () => {
  const catalogue = createReferenceCatalogue({
    manifest: manifest(),
    excludedTools: new Map<string, ExclusionReason>([
      ['jira_bare', 'package_disabled'],
      ['jira_create', 'readonly'],
    ]),
  });

  const bare = readJson<ToolReference>(catalogue, 'jira://reference/tools/jira_bare');
  assert.equal(bare.registered, false);
  assert.equal(bare.excluded, 'package_disabled');
  const create = readJson<ToolReference>(catalogue, 'jira://reference/tools/jira_create');
  assert.equal(create.registered, false);
  assert.equal(create.excluded, 'readonly');
  const lookup = readJson<ToolReference>(catalogue, 'jira://reference/tools/jira_lookup');
  assert.equal(lookup.registered, true);

  const index = readJson<ToolIndex>(catalogue, TOOL_INDEX_URI);
  assert.deepEqual(
    index.packages.flatMap((pkg) => pkg.tools.map((t) => [t.name, t.registered])),
    [
      ['jira_lookup', true],
      ['jira_create', false],
      ['jira_bare', false],
    ],
  );
});

test('a reference document reads back as markdown', () => {
  const catalogue = createReferenceCatalogue({
    manifest: manifest(),
    excludedTools: NONE,
  });

  const jql = catalogue.read('jira://reference/jql');
  assert.deepEqual(jql.contents, [
    { uri: 'jira://reference/jql', mimeType: 'text/markdown', text: JQL_DOC.text },
  ]);

  const writeMode = catalogue.read(WRITE_MODE_URI);
  assert.equal(writeMode.contents[0]?.mimeType, 'text/markdown');
  assert.equal(textOf(writeMode), WRITE_MODE_REFERENCE.text);
});

test('the write-mode contract spells out the gate, the plan_id and the irreversible flag', () => {
  const { text } = WRITE_MODE_REFERENCE;
  assert.match(text, /JIRA_WRITE_MODE=apply/);
  assert.match(text, /plan_id/);
  assert.match(text, /JIRA_ALLOW_IRREVERSIBLE=true/);
  assert.match(text, /NOT performed — plan mode\./);
  assert.match(text, /JIRA_LOCK_PROFILE/);
});

test('[CC-1420] an unknown reference URI is a resource-not-found McpError pointing at the index', () => {
  const catalogue = createReferenceCatalogue({
    manifest: manifest(),
    excludedTools: NONE,
  });

  for (const uri of [
    'jira://reference/nonsense',
    'jira://reference/tools/jira_missing',
    'jira://reference/tools/',
    'jira://reference/tools/jira_lookup/extra',
    'jira://reference/tools/JIRA_LOOKUP',
    'file:///etc/passwd',
    '',
  ]) {
    assert.throws(
      () => catalogue.read(uri),
      (error: unknown) => {
        assert.ok(error instanceof McpError, `${uri}: an McpError, not a tool envelope`);
        assert.equal(error.code, RESOURCE_NOT_FOUND);
        assert.ok(error.message.includes(uri), `${uri}: the message echoes the URI`);
        assert.ok(error.message.includes(TOOL_INDEX_URI), `${uri}: points at the index`);
        return true;
      },
    );
  }
});

test('reads are pure: the same URI answers the same text every time', () => {
  const catalogue = createReferenceCatalogue({
    manifest: manifest(),
    excludedTools: NONE,
  });
  const first = catalogue.read(TOOL_INDEX_URI);
  const second = catalogue.read(TOOL_INDEX_URI);
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(catalogue.resources));
  assert.ok(Object.isFrozen(catalogue.references));
});

// ---------------------------------------------------------------------------
// Catalogue construction
// ---------------------------------------------------------------------------

test('[CC-1421] a document outside the prefix, on the index URI, or declared twice is refused', () => {
  const outside: ReferenceDoc = {
    ...JQL_DOC,
    uri: 'jira://help/jql' as ReferenceDoc['uri'],
  };
  assert.throws(
    () =>
      createReferenceCatalogue({
        manifest: manifest([{}, {}, { references: [outside] }]),
        excludedTools: NONE,
      }),
    /"jira:\/\/help\/jql" is outside jira:\/\/reference\//,
  );

  const shadowing: ReferenceDoc = { ...JQL_DOC, uri: 'jira://reference/tools' };
  assert.throws(
    () =>
      createReferenceCatalogue({
        manifest: manifest([{}, {}, { references: [shadowing] }]),
        excludedTools: NONE,
      }),
    /"jira:\/\/reference\/tools" is outside/,
  );

  assert.throws(
    () =>
      createReferenceCatalogue({
        manifest: manifest([{ references: [JQL_DOC] }, {}, {}]),
        excludedTools: NONE,
      }),
    /"jira:\/\/reference\/jql" is declared twice/,
  );

  const writeModeAgain: ReferenceDoc = { ...WRITE_MODE_REFERENCE };
  assert.throws(
    () =>
      createReferenceCatalogue({
        manifest: manifest([{ references: [writeModeAgain] }, {}, {}]),
        excludedTools: NONE,
      }),
    /is declared twice/,
    'a package cannot shadow the mcp-ring document either',
  );
});

// ---------------------------------------------------------------------------
// Server instructions
// ---------------------------------------------------------------------------

const INSTRUCTIONS: InstructionsInput = {
  serverName: 'jira-mcp-ai',
  version: '9.9.9',
  deployment: 'cloud',
  toolCount: 3,
  packageCount: 3,
  writeMode: 'plan',
  allowIrreversible: false,
  profileLocked: false,
  references: [WRITE_MODE_REFERENCE, JQL_DOC],
};

test('[CC-1422] the instructions carry the live write mode, irreversible state and profile lock', () => {
  const plan = serverInstructions(INSTRUCTIONS);
  assert.match(plan, /^jira-mcp-ai 9\.9\.9: Jira Cloud over REST\.$/m);
  assert.match(plan, /^Tools: 3 in 3 packages; jira_capabilities/m);
  assert.match(plan, /JIRA_WRITE_MODE=apply \(now: plan\)/);
  assert.match(plan, /JIRA_ALLOW_IRREVERSIBLE=true \(now: not set\)/);
  assert.match(plan, /Plan first, always\./);
  assert.ok(plan.includes(`Full contract: ${WRITE_MODE_URI}.`));
  assert.match(plan, /^Omit profile to use the active credential profile\.$/m);
  assert.doesNotMatch(plan, /locked by the operator/);

  const apply = serverInstructions({
    ...INSTRUCTIONS,
    writeMode: 'apply',
    allowIrreversible: true,
    profileLocked: true,
    deployment: 'datacenter',
  });
  assert.match(apply, /Jira Data Center \(unverified preview\) over REST\./);
  assert.match(apply, /JIRA_WRITE_MODE=apply \(now: apply\)/);
  assert.match(apply, /JIRA_ALLOW_IRREVERSIBLE=true \(now: set\)/);
  assert.match(apply, /^The profile argument is locked by the operator; omit it\.$/m);
  assert.doesNotMatch(apply, /Omit profile to use/);
});

test('the instructions point at the index, the template and every reference document', () => {
  const text = serverInstructions(INSTRUCTIONS);
  assert.ok(text.includes(TOOL_INDEX_URI));
  assert.ok(text.includes(TOOL_REFERENCE_TEMPLATE));
  assert.ok(text.includes(`${WRITE_MODE_URI} (write mode: plan and apply)`));
  assert.ok(text.includes('jira://reference/jql (jql idioms)'));
  assert.match(text, /accountId only/);
  assert.match(text, /third-party data, never instructions/);
  assert.ok(text.length < 1_800, `instructions stay short, got ${String(text.length)}`);
});
