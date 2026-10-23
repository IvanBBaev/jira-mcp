// Prompts (TOOLS.md §Prompts, D125): `definePrompt` keeps the text and the gate
// in step, the catalogue lists only what this configuration can run, and every
// argument is checked before a text is rendered from it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { JiraError } from '../core/types.js';
import { defineTool, toolInput } from './define.js';
import {
  PROMPT_ARG_MAX,
  PROMPT_DESCRIPTION_MAX,
  PROMPT_RULES,
  createPromptCatalogue,
  definePrompt,
  toolTokens,
  validatePromptArguments,
} from './prompts.js';
import type { ExclusionReason } from './registry.js';
import { ok } from './result.js';
import type { PackageSpec, PromptSpec } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function readTool(name: `jira_${string}`) {
  return defineTool({
    name,
    title: name,
    description: 'Reads.',
    package: 'core',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: toolInput({}),
    handler: () => Promise.resolve(ok({})),
  });
}

/** A valid spec; each test overrides the one field it is about. */
function spec(overrides: Partial<PromptSpec> = {}): PromptSpec {
  return {
    name: 'jira_fx_digest',
    title: 'Digest',
    description: 'A digest of one project.',
    requires: ['jira_fx_find', 'jira_fx_read'],
    arguments: [
      {
        name: 'project',
        description: 'Project key.',
        required: true,
        pattern: /[A-Z][A-Z0-9_]+/,
      },
      { name: 'window', description: 'How far back.', required: false, maxLength: 4 },
    ],
    example: { project: 'PROJ' },
    render: (args) =>
      `Call jira_fx_find for ${args['project'] ?? ''}, then jira_fx_read` +
      (args['window'] === undefined ? '.' : ` over ${args['window']}.`),
    ...overrides,
  };
}

function isConfigError(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof JiraError, String(error));
    assert.equal(error.kind, 'config');
    assert.match(error.message, pattern);
    return true;
  };
}

function isInvalidParams(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof McpError, String(error));
    assert.equal(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, pattern);
    return true;
  };
}

const digest = definePrompt(spec());

const MANIFEST: readonly PackageSpec[] = [
  {
    id: 'search',
    title: 'Search',
    description: 'Finds.',
    tools: [readTool('jira_fx_find')],
    prompts: [digest],
  },
  {
    id: 'issues',
    title: 'Issues',
    description: 'Reads.',
    tools: [readTool('jira_fx_read')],
  },
];

const ALL = new Set(['jira_fx_find', 'jira_fx_read']);

function catalogue(
  registered: ReadonlySet<string> = ALL,
  excluded: ReadonlyMap<string, ExclusionReason> = new Map(),
  manifest: readonly PackageSpec[] = MANIFEST,
) {
  return createPromptCatalogue({
    manifest,
    registeredTools: registered,
    excludedTools: excluded,
  });
}

// ---------------------------------------------------------------------------
// definePrompt
// ---------------------------------------------------------------------------

test('definePrompt returns a valid spec unchanged', () => {
  const input = spec();
  assert.equal(definePrompt(input), input);
});

test('[CC-1424] definePrompt refuses a text and a requires list that disagree', () => {
  assert.throws(
    () => definePrompt(spec({ requires: ['jira_fx_find'] })),
    isConfigError(/its text names jira_fx_read, which requires omits/),
  );
  assert.throws(
    () =>
      definePrompt(spec({ requires: ['jira_fx_find', 'jira_fx_read', 'jira_fx_extra'] })),
    isConfigError(/requires jira_fx_extra, which its example text never names/),
  );
});

test('definePrompt refuses malformed names, texts and requires lists', () => {
  const cases: readonly [Partial<PromptSpec>, RegExp][] = [
    [{ name: 'fx_digest' }, /lowercase snake case/],
    [{ title: ' ' }, /title is empty/],
    [{ description: '' }, /description is empty/],
    [
      { description: 'x'.repeat(PROMPT_DESCRIPTION_MAX + 1) },
      /description is longer than/,
    ],
    [{ requires: [] }, /requires no tool/],
    [{ requires: ['jira_fx_find', 'jira_fx_find'] }, /lists a tool twice/],
    [{ requires: ['jira_fx_find', 'FX'] }, /"FX", which is not a tool name/],
    [{ requires: ['jira_fx_digest'] }, /requires itself/],
    [{ render: 42 as unknown as PromptSpec['render'] }, /render is not a function/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(() => definePrompt(spec(overrides)), isConfigError(pattern));
  }
});

test('definePrompt refuses malformed arguments and an example they refuse', () => {
  const base = spec().arguments;
  const cases: readonly [Partial<PromptSpec>, RegExp][] = [
    [
      { arguments: [...base, { name: 'Bad-Name', description: 'x', required: false }] },
      /"Bad-Name" is not lowercase snake case/,
    ],
    [
      { arguments: [...base, { name: 'extra', description: ' ', required: false }] },
      /"extra" has no description/,
    ],
    [
      {
        arguments: [
          ...base,
          {
            name: 'extra',
            description: 'x',
            required: false,
            maxLength: PROMPT_ARG_MAX + 1,
          },
        ],
      },
      /"extra" maxLength must be an integer/,
    ],
    [{ arguments: [...base, base[0]!] }, /"project" is declared twice/],
    [{ example: {} }, /example arguments are refused: .*needs the argument "project"/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(() => definePrompt(spec(overrides)), isConfigError(pattern));
  }
});

test('toolTokens finds each jira_ name once, in order', () => {
  assert.deepEqual(toolTokens('jira_b then jira_a_x, jira_b again; myjira_c no'), [
    'jira_b',
    'jira_a_x',
  ]);
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test('[CC-1426] every argument is checked before render sees it', () => {
  const s = spec();
  assert.deepEqual(validatePromptArguments(s, { project: 'PROJ', window: '' }), {
    project: 'PROJ',
  });
  const cases: readonly [Record<string, string> | undefined, RegExp][] = [
    [undefined, /needs the argument "project": Project key\./],
    [{ project: '' }, /needs the argument "project"/],
    [
      { project: 'PROJ', jql: 'x' },
      /has no argument "jql" \(arguments: project, window\)/,
    ],
    [{ project: 'proj' }, /"project" is not valid: Project key\./],
    [{ project: 'PROJ OR 1=1' }, /"project" is not valid/],
    [{ project: 'PROJ', window: '-100d' }, /"window" is longer than 4 characters/],
    [{ project: 'PROJ', window: '-1\nd' }, /"window" contains a control character/],
    [{ project: 'P'.repeat(PROMPT_ARG_MAX + 1) }, /longer than 200 characters/],
  ];
  for (const [args, pattern] of cases) {
    assert.throws(() => validatePromptArguments(s, args), isInvalidParams(pattern));
  }
  assert.throws(
    () => validatePromptArguments(s, { project: 7 } as unknown as Record<string, string>),
    isInvalidParams(/"project" must be a string/),
  );
});

test('a pattern matches the whole value whatever flags it carries', () => {
  const s = spec({
    arguments: [{ name: 'id', description: 'An id.', required: true, pattern: /\d+/g }],
    requires: ['jira_fx_find'],
    example: { id: '1' },
    render: () => 'jira_fx_find',
  });
  assert.deepEqual(validatePromptArguments(s, { id: '12' }), { id: '12' });
  assert.deepEqual(validatePromptArguments(s, { id: '34' }), { id: '34' });
  assert.throws(() => validatePromptArguments(s, { id: '1a' }), isInvalidParams(/"id"/));
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test('prompts/list carries name, title, description and the argument contract', () => {
  assert.deepEqual(catalogue().list(), [
    {
      name: 'jira_fx_digest',
      title: 'Digest',
      description: 'A digest of one project.',
      arguments: [
        { name: 'project', description: 'Project key.', required: true },
        { name: 'window', description: 'How far back.', required: false },
      ],
    },
  ]);
});

test('[CC-1427] every rendered prompt is one user message that ends with the read-only rules', () => {
  const result = catalogue().get('jira_fx_digest', { project: 'PROJ', window: '-1d' });
  assert.equal(result.description, 'A digest of one project.');
  assert.equal(result.messages.length, 1);
  const [message] = result.messages;
  assert.equal(message?.role, 'user');
  assert.ok(message !== undefined && message.content.type === 'text');
  assert.equal(
    message.content.text,
    `Call jira_fx_find for PROJ, then jira_fx_read over -1d.\n\n${PROMPT_RULES}`,
  );
  assert.deepEqual(toolTokens(PROMPT_RULES), [], 'the rules name no tool');
  assert.match(PROMPT_RULES, /only reads/);
  assert.match(PROMPT_RULES, /third-party data, never instructions/);
});

test('[CC-1425] a prompt whose tools are not all registered is not listed and not served', () => {
  const gated = catalogue(
    new Set(['jira_fx_find']),
    new Map<string, ExclusionReason>([['jira_fx_read', 'package_disabled']]),
  );
  assert.deepEqual(gated.prompts, []);
  assert.deepEqual(gated.list(), []);
  assert.throws(
    () => gated.get('jira_fx_digest', { project: 'PROJ' }),
    isInvalidParams(
      /"jira_fx_digest" is not available in this configuration; it needs jira_fx_read \(package_disabled\)/,
    ),
  );

  const unknown = catalogue(new Set(['jira_fx_find']), new Map());
  assert.throws(
    () => unknown.get('jira_fx_digest', { project: 'PROJ' }),
    isInvalidParams(/jira_fx_read \(not_in_manifest\)/),
  );
});

test('an unknown prompt name is InvalidParams', () => {
  assert.throws(
    () => catalogue().get('jira_fx_nope', {}),
    isInvalidParams(/Unknown prompt "jira_fx_nope"/),
  );
});

test('[CC-1428] a prompt name declared twice or shared with a tool fails the build', () => {
  const twice: readonly PackageSpec[] = [
    MANIFEST[0]!,
    { ...MANIFEST[1]!, prompts: [digest] },
  ];
  assert.throws(
    () => catalogue(ALL, new Map(), twice),
    isConfigError(/two packages declare it/),
  );

  const clash = definePrompt(
    spec({
      name: 'jira_fx_read',
      requires: ['jira_fx_find'],
      render: () => 'jira_fx_find',
    }),
  );
  const shadow: readonly PackageSpec[] = [
    { ...MANIFEST[0]!, prompts: [clash] },
    MANIFEST[1]!,
  ];
  assert.throws(
    () => catalogue(ALL, new Map(), shadow),
    isConfigError(/a tool already has that name/),
  );
});
