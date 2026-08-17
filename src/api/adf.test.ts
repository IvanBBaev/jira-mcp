// ADF unit suite (TESTING.md §Suites 1). Ported from servicenow-mcp's
// `test/jira-adf.test.js`, plus one named test per mandatory delta of
// JIRA-API.md §ADF — the donor never saw `table`, `codeBlock`, `panel`,
// `media`, `taskList`, `emoji`, `status` or `date`.
//
// Every ADF object below is a SYNTHETIC fixture: hand-built from the node
// shapes Atlassian documents, because the scratch site that would let
// `scripts/record-fixture.mjs` (WP-41) record real ones does not exist until
// Gate C. Blocks that mimic a recorded response carry a `synthetic: true`
// comment, matching the marker recorded fixtures use for hand-crafted entries
// (TESTING.md §Fixtures).
//
// Examples only: every generated case lives in `adf.property.test.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adfFromMarkdown,
  adfFromText,
  adfToMarkdown,
  adfToText,
  DEPTH_LIMIT_MARKER,
  isAdfDoc,
  MAX_LIST_INDENT_DEPTH,
  renderAdfDocs,
  toAdf,
  type AdfNode,
} from './adf.js';
import { JiraError } from '../core/types.js';

/** `{ type: 'paragraph', content: [{ type: 'text', text }] }`, for brevity. */
function para(text: string): AdfNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function doc(...content: AdfNode[]): AdfNode {
  return { type: 'doc', version: 1, content };
}

// ---------------------------------------------------------------------------
// Donor parity
// ---------------------------------------------------------------------------

test('donor parity: text, hardBreak, strings, arrays and primitives', () => {
  assert.equal(adfToText({ type: 'text', text: 'hi' }), 'hi');
  assert.equal(adfToText('raw'), 'raw');
  assert.equal(
    adfToText([
      { type: 'text', text: 'x' },
      { type: 'text', text: 'y' },
    ]),
    'xy',
  );
  assert.equal(adfToText(42), '');
  assert.equal(adfToText(true), '');
  // A hardBreak alone is nothing but a line ending, and the delta below trims
  // trailing whitespace — the donor returned '\n' here.
  assert.equal(adfToText({ type: 'hardBreak' }), '');
  assert.equal(adfToText(doc(para('a'), para('b'))), 'a\nb');
});

test('CC-08 null, undefined and an empty doc flatten to an empty string', () => {
  assert.equal(adfToText(null), '');
  assert.equal(adfToText(undefined), '');
  assert.equal(adfToText({ type: 'doc', version: 1, content: [] }), '');
  assert.equal(adfToText({}), '[unknown]');
  // Never the string "undefined".
  assert.ok(!adfToText(null).includes('undefined'));
});

test('delta: the flattened document carries no trailing newline', () => {
  assert.equal(adfToText(doc(para('hello'))), 'hello');
  assert.equal(adfToText(adfFromText('hello')), 'hello');
});

// ---------------------------------------------------------------------------
// Inline node deltas
// ---------------------------------------------------------------------------

test('CC-07 mention falls back to the accountId when the display name is absent', () => {
  // synthetic: true — mention attrs as Jira Cloud emits them.
  assert.equal(
    adfToText({ type: 'mention', attrs: { id: 'x', text: '@Alice' } }),
    '@Alice',
  );
  assert.equal(
    adfToText({ type: 'mention', attrs: { id: '5b10a2844c20165700ede21g' } }),
    '@5b10a2844c20165700ede21g',
  );
  // A displayName-shaped attr without the leading @ still renders as a mention.
  assert.equal(adfToText({ type: 'mention', attrs: { displayName: 'Bob' } }), '@Bob');
  // Neither name nor id: nothing, rather than a stray '@'.
  assert.equal(adfToText({ type: 'mention' }), '');
  assert.equal(adfToText({ type: 'mention', attrs: { text: '' } }), '');
});

test('delta: emoji renders its shortName (the donor dropped it)', () => {
  assert.equal(
    adfToText({ type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } }),
    ':tada:',
  );
  // No shortName recorded — the rendered character is still better than nothing.
  assert.equal(adfToText({ type: 'emoji', attrs: { text: '🎉' } }), '🎉');
  assert.equal(adfToText({ type: 'emoji' }), '');
});

test('delta: status renders its text (the donor dropped it)', () => {
  assert.equal(
    adfToText({ type: 'status', attrs: { text: 'In Progress', color: 'blue' } }),
    'In Progress',
  );
  assert.equal(adfToText({ type: 'status' }), '');
});

test('delta: date renders an ISO calendar date (the donor dropped it)', () => {
  // attrs.timestamp is epoch milliseconds, as a string.
  assert.equal(
    adfToText({ type: 'date', attrs: { timestamp: '1786233600000' } }),
    '2026-08-09',
  );
  assert.equal(
    adfToText({ type: 'date', attrs: { timestamp: 1786233600000 } }),
    '2026-08-09',
  );
  // Garbage never throws: the raw value survives, or nothing does.
  assert.equal(adfToText({ type: 'date', attrs: { timestamp: 'soon' } }), 'soon');
  assert.equal(adfToText({ type: 'date', attrs: { timestamp: 1e20 } }), '');
  assert.equal(adfToText({ type: 'date' }), '');
});

test('cards render the title when Jira resolved one, the URL otherwise', () => {
  const url = 'https://example.atlassian.net/browse/ABC-1';
  assert.equal(adfToText({ type: 'inlineCard', attrs: { url } }), url);
  assert.equal(
    adfToText({ type: 'inlineCard', attrs: { url, title: 'ABC-1: Login' } }),
    'ABC-1: Login',
  );
  assert.equal(adfToText({ type: 'blockCard', attrs: { url } }), url);
  assert.equal(
    adfToText({ type: 'inlineCard', attrs: { data: { name: 'Design doc' } } }),
    'Design doc',
  );
  // A card with nothing resolvable contributes nothing rather than throwing.
  assert.equal(adfToText({ type: 'inlineCard' }), '');
  // A description whose only content is a smart link is not blank.
  assert.equal(
    adfToText(
      doc({ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url } }] }),
    ),
    url,
  );
});

// ---------------------------------------------------------------------------
// Block node deltas
// ---------------------------------------------------------------------------

test('delta: codeBlock is fenced and names its language', () => {
  const node: AdfNode = {
    type: 'codeBlock',
    attrs: { language: 'java' },
    content: [{ type: 'text', text: 'int x = 1;\nint y = 2;' }],
  };
  assert.equal(adfToText(node), '```java\nint x = 1;\nint y = 2;\n```');
  // No language attr: still fenced, so the boundary is unambiguous.
  assert.equal(
    adfToText({ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }),
    '```\nx\n```',
  );
});

test('delta: panel is labelled with its type', () => {
  const node: AdfNode = {
    type: 'panel',
    attrs: { panelType: 'warning' },
    content: [para('Do not deploy on Friday.')],
  };
  assert.equal(adfToText(node), '[panel:warning]\nDo not deploy on Friday.');
  // panelType is optional in old content; `info` is Jira's own default.
  assert.equal(
    adfToText({ type: 'panel', content: [para('note')] }),
    '[panel:info]\nnote',
  );
});

test('delta: table renders one line per row with |-joined cells', () => {
  // synthetic: true — table/tableRow/tableHeader/tableCell as Jira emits them.
  const table: AdfNode = {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', attrs: {}, content: [para('Env')] },
          { type: 'tableHeader', attrs: {}, content: [para('Status')] },
        ],
      },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', attrs: {}, content: [para('prod')] },
          { type: 'tableCell', attrs: {}, content: [para('green')] },
        ],
      },
    ],
  };
  assert.equal(adfToText(table), 'Env | Status\nprod | green');
});

test('delta: a multi-paragraph table cell collapses onto its row line', () => {
  const table: AdfNode = {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [para('one'), para('two')] },
          { type: 'tableCell', content: [para('three')] },
        ],
      },
    ],
  };
  assert.equal(adfToText(table), 'one two | three');
});

test('delta: media renders a filename placeholder and never a URL', () => {
  // synthetic: true — mediaSingle > media, the shape an inline screenshot takes.
  const media: AdfNode = {
    type: 'mediaSingle',
    attrs: { layout: 'center' },
    content: [
      {
        type: 'media',
        attrs: {
          id: '4f9a0111-2222-3333-4444-555566667777',
          type: 'file',
          collection: 'jira-project-10000',
          alt: 'login-error.png',
          url: 'https://media.example.invalid/file/4f9a0111?token=secret',
          width: 1024,
          height: 768,
        },
      },
    ],
  };
  const out = adfToText(media);
  assert.equal(out, '[media: login-error.png]');
  assert.ok(!out.includes('http'), 'a media URL must never reach the model');
  assert.ok(!out.includes('token'));

  // No filename anywhere: the id still correlates with jira_list_attachments.
  assert.equal(
    adfToText({
      type: 'media',
      attrs: { id: 'abc-123', type: 'file', url: 'https://x.invalid/y' },
    }),
    '[media: id=abc-123]',
  );
  assert.equal(adfToText({ type: 'media' }), '[media]');
  // Older payloads carry the name in __fileName; a mediaGroup holds several.
  assert.equal(
    adfToText({
      type: 'mediaGroup',
      content: [
        { type: 'media', attrs: { __fileName: 'a.pdf' } },
        { type: 'media', attrs: { file: { name: 'b.pdf' } } },
      ],
    }),
    '[media: a.pdf] [media: b.pdf]',
  );
});

test('delta: taskList renders checkboxes for TODO and DONE', () => {
  // synthetic: true — taskList/taskItem with localId + state.
  const tasks: AdfNode = {
    type: 'taskList',
    attrs: { localId: 'list-1' },
    content: [
      {
        type: 'taskItem',
        attrs: { localId: 't1', state: 'DONE' },
        content: [{ type: 'text', text: 'ship it' }],
      },
      {
        type: 'taskItem',
        attrs: { localId: 't2', state: 'TODO' },
        content: [{ type: 'text', text: 'write docs' }],
      },
      { type: 'taskItem', attrs: { localId: 't3' } },
    ],
  };
  assert.equal(adfToText(tasks), '[x] ship it\n[ ] write docs\n[ ]');
});

test('delta: a nested taskList indents under its parent item', () => {
  const tasks: AdfNode = {
    type: 'taskList',
    content: [
      {
        type: 'taskItem',
        attrs: { state: 'TODO' },
        content: [
          { type: 'text', text: 'release' },
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { state: 'DONE' },
                content: [{ type: 'text', text: 'tag' }],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(adfToText(tasks), '[ ] release\n  [x] tag');
});

test('blockquote does not add a blank line of its own (donor fix)', () => {
  assert.equal(
    adfToText({ type: 'blockquote', content: [para('quoted'), para('more')] }),
    'quoted\nmore',
  );
});

// ---------------------------------------------------------------------------
// Lists and the depth cap (CC-09)
// ---------------------------------------------------------------------------

test('delta: nested bullet and ordered lists indent two spaces per level', () => {
  // synthetic: true — bulletList > listItem > (paragraph, orderedList).
  const list: AdfNode = {
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          para('one'),
          {
            type: 'orderedList',
            attrs: { order: 1 },
            content: [
              { type: 'listItem', content: [para('a')] },
              { type: 'listItem', content: [para('b')] },
            ],
          },
        ],
      },
      { type: 'listItem', content: [para('two')] },
    ],
  };
  assert.equal(adfToText(list), '- one\n  1. a\n  2. b\n- two');
});

test('orderedList honours its start attribute and multi-line items align', () => {
  const list: AdfNode = {
    type: 'orderedList',
    attrs: { order: 7 },
    content: [
      { type: 'listItem', content: [para('seven'), para('still seven')] },
      { type: 'listItem', content: [para('eight')] },
    ],
  };
  assert.equal(adfToText(list), '7. seven\n   still seven\n8. eight');
});

test('CC-09 list indentation stops growing at MAX_LIST_INDENT_DEPTH', () => {
  let node: AdfNode = {
    type: 'bulletList',
    content: [{ type: 'listItem', content: [para('leaf')] }],
  };
  for (let level = 1; level < 12; level += 1) {
    node = { type: 'bulletList', content: [{ type: 'listItem', content: [node] }] };
  }

  const lines = adfToText(node).split('\n');
  const widest = Math.max(...lines.map((line) => line.length - line.trimStart().length));
  assert.equal(widest, MAX_LIST_INDENT_DEPTH * 2);
  assert.equal(lines.at(-1), `${'  '.repeat(MAX_LIST_INDENT_DEPTH)}- leaf`);
});

test('CC-09 nesting past the depth cap degrades instead of overflowing the stack', () => {
  let node: AdfNode = para('buried');
  for (let level = 0; level < 5000; level += 1) {
    node = { type: 'blockquote', content: [node] };
  }
  const out = adfToText(node);
  assert.equal(typeof out, 'string');
  assert.equal(out, DEPTH_LIMIT_MARKER);
});

test('CC-09 a cyclic node tree terminates at the depth cap', () => {
  const cyclic: AdfNode = { type: 'paragraph', content: [] };
  cyclic.content?.push(cyclic);
  const out = adfToText(cyclic);
  assert.equal(typeof out, 'string');
  assert.ok(out.includes(DEPTH_LIMIT_MARKER));
});

// ---------------------------------------------------------------------------
// Unknown nodes (CC-06)
// ---------------------------------------------------------------------------

test('CC-06 an unknown container recurses so no text is dropped', () => {
  assert.equal(
    adfToText({ type: 'weirdCustomNode', content: [{ type: 'text', text: 'kept' }] }),
    'kept',
  );
  assert.equal(
    adfToText({
      type: 'someFutureBlock',
      content: [para('kept'), { type: 'anotherOne', content: [para('also')] }],
    }),
    'kept\nalso',
  );
});

test('CC-06 an unknown leaf degrades to a bracketed placeholder naming the type', () => {
  assert.equal(
    adfToText({ type: 'futureInlineThing', attrs: { foo: 'bar' } }),
    '[futureInlineThing]',
  );
  assert.equal(adfToText({ type: 'futureThing', content: [] }), '[futureThing]');
  // The type name is echoed, so it is bounded and single-line before it lands
  // in a model's context.
  const long = adfToText({ type: 'x'.repeat(200) });
  assert.ok(long.length < 60, long);
  assert.ok(!adfToText({ type: 'a\nb' }).includes('\n'));
});

// ---------------------------------------------------------------------------
// Text -> ADF (CC-10)
// ---------------------------------------------------------------------------

test('CC-10 adfFromText pins the version and wraps a single line', () => {
  const built = adfFromText('hello');
  assert.equal(built.type, 'doc');
  assert.equal(built.version, 1);
  assert.deepEqual(built.content, [
    { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
  ]);
});

test('CC-10 a blank line starts a paragraph, a single newline is a hardBreak', () => {
  const built = adfFromText('a\nb\n\nc');
  assert.equal(built.content.length, 2);
  assert.deepEqual(built.content[0], {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'a' },
      { type: 'hardBreak' },
      { type: 'text', text: 'b' },
    ],
  });
  assert.deepEqual(built.content[1], para('c'));
});

test('CC-10 CRLF is normalised before splitting', () => {
  const built = adfFromText('line1\r\nline2\r\n\r\nline3');
  assert.equal(built.content.length, 2);
  const text = JSON.stringify(built);
  assert.ok(!text.includes('\\r'), 'no carriage return may leak into a text node');
});

test('CC-10 leading and trailing blank paragraphs are trimmed', () => {
  const built = adfFromText('\n\n   \nhello\n \n\n');
  assert.deepEqual(built.content, [para('hello')]);
});

test('CC-10 blank input yields an empty doc, never an empty text node', () => {
  assert.deepEqual(adfFromText('').content, []);
  assert.deepEqual(adfFromText('   \n\t\n').content, []);
  assert.equal(adfFromText('').version, 1);
});

test('toAdf wraps a string, normalises a document and rejects everything else', () => {
  assert.equal(toAdf('hi').type, 'doc');
  assert.equal(toAdf('hi').version, 1);

  const custom: AdfNode = { type: 'doc', version: 1, content: [para('kept')] };
  assert.deepEqual(toAdf(custom).content, [para('kept')]);

  // A caller-built doc missing the pinned header is repaired, not rejected.
  assert.equal(toAdf({ type: 'doc', content: [] }).version, 1);
  assert.equal(toAdf({ content: [para('x')] } as unknown as AdfNode).type, 'doc');

  // A bare node is not a document: replacing a description with one corrupts it.
  assert.throws(() => toAdf({ type: 'paragraph' }), JiraError);
  assert.throws(() => toAdf([] as unknown as AdfNode), JiraError);
  assert.throws(() => toAdf(null as unknown as AdfNode), JiraError);
  assert.throws(() => toAdf(42 as unknown as AdfNode), JiraError);

  try {
    toAdf(null as unknown as AdfNode);
    assert.fail('expected a JiraError');
  } catch (error) {
    assert.ok(error instanceof JiraError);
    assert.equal(error.kind, 'validation');
    assert.ok(error.remediation);
  }
});

test('isAdfDoc separates an ADF field value from a scalar one', () => {
  assert.equal(isAdfDoc({ type: 'doc', version: 1, content: [] }), true);
  assert.equal(isAdfDoc(adfFromText('x')), true);
  assert.equal(isAdfDoc({ type: 'paragraph', content: [] }), false);
  assert.equal(isAdfDoc('a description'), false);
  assert.equal(isAdfDoc(null), false);
  assert.equal(isAdfDoc([{ type: 'doc', content: [] }]), false);
});

// ---------------------------------------------------------------------------
// End to end over a recorded-shape description
// ---------------------------------------------------------------------------

test('a full issue description flattens to readable text', () => {
  // synthetic: true — every node of the TESTING.md §Fixtures ADF coverage list
  // in one description, in the shape `GET /rest/api/3/issue/{key}` returns.
  // Replaced by a recorded fixture once the scratch site exists (Gate C, WP-41).
  const description: AdfNode = doc(
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Login outage' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Reported by ' },
        {
          type: 'mention',
          attrs: { id: '5b10a2844c20165700ede21g', text: '@Alice Example' },
        },
        { type: 'text', text: ' on ' },
        { type: 'date', attrs: { timestamp: '1786233600000' } },
        { type: 'text', text: ' ' },
        { type: 'emoji', attrs: { shortName: ':fire:', id: '1f525', text: '🔥' } },
      ],
    },
    { type: 'panel', attrs: { panelType: 'error' }, content: [para('Customer facing.')] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para('SSO login fails')] },
        {
          type: 'listItem',
          content: [
            para('Affected tenants'),
            {
              type: 'orderedList',
              content: [
                { type: 'listItem', content: [para('acme')] },
                { type: 'listItem', content: [para('globex')] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [para('Env')] },
            { type: 'tableHeader', content: [para('State')] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [para('prod')] },
            {
              type: 'tableCell',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'status', attrs: { text: 'DOWN', color: 'red' } }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'codeBlock',
      attrs: { language: 'text' },
      content: [{ type: 'text', text: 'HTTP 503 from auth-gateway' }],
    },
    {
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [
        {
          type: 'media',
          attrs: {
            id: 'abc-123',
            type: 'file',
            collection: 'jira-project-10000',
            alt: 'trace.png',
          },
        },
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { state: 'DONE' },
          content: [{ type: 'text', text: 'rollback' }],
        },
        {
          type: 'taskItem',
          attrs: { state: 'TODO' },
          content: [{ type: 'text', text: 'post-mortem' }],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'inlineCard',
          attrs: { url: 'https://example.atlassian.net/browse/OPS-9' },
        },
      ],
    },
    { type: 'somethingAtlassianAddedLater', attrs: { localId: 'z' } },
  );

  assert.equal(
    adfToText(description),
    [
      'Login outage',
      'Reported by @Alice Example on 2026-08-09 :fire:',
      '[panel:error]',
      'Customer facing.',
      '- SSO login fails',
      '- Affected tenants',
      '  1. acme',
      '  2. globex',
      'Env | State',
      'prod | DOWN',
      '```text',
      'HTTP 503 from auth-gateway',
      '```',
      '[media: trace.png]',
      '[x] rollback',
      '[ ] post-mortem',
      'https://example.atlassian.net/browse/OPS-9',
      '[somethingAtlassianAddedLater]',
    ].join('\n'),
  );
});

// ---------------------------------------------------------------------------
// Markdown subset — ADF → markdown
//
// `format: 'markdown'` renders the same fields the text path renders; only the
// rendering differs. Every test below therefore either pins a construct INSIDE
// the subset (headings, lists, fences, strong/em/code/link) or asserts that a
// construct OUTSIDE it degrades exactly as `adfToText` degrades it.
// ---------------------------------------------------------------------------

test('markdown: headings, marks and links become markup', () => {
  const description = doc(
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Call ' },
        { type: 'text', text: 'getIssue()', marks: [{ type: 'code' }] },
        { type: 'text', text: ' with ' },
        { type: 'text', text: 'both', marks: [{ type: 'strong' }, { type: 'em' }] },
        { type: 'text', text: ' — see ' },
        {
          type: 'text',
          text: 'the docs',
          marks: [{ type: 'link', attrs: { href: 'https://x.test/a b' } }],
        },
      ],
    },
  );

  assert.equal(
    adfToMarkdown(description),
    [
      '## Steps',
      'Call `getIssue()` with ***both*** — see [the docs](<https://x.test/a b>)',
    ].join('\n'),
  );
  // The default path is untouched: same fields, no markup.
  assert.equal(adfToText(description), 'Steps\nCall getIssue() with both — see the docs');
});

test('CC-42: markdown: text that looks like markup is escaped and survives the round trip', () => {
  const description = doc(
    para('# not a heading * really [nope] `tick` \\ ]'),
    para('1. not a list'),
    para('- not a bullet'),
    para('> not a quote'),
  );

  assert.equal(
    adfToMarkdown(description),
    [
      '\\# not a heading \\* really \\[nope\\] \\`tick\\` \\\\ \\]',
      '1\\. not a list',
      '\\- not a bullet',
      '\\> not a quote',
    ].join('\n\n'),
  );
  assert.deepEqual(adfFromMarkdown(adfToMarkdown(description)), description);
});

test('markdown: a code fence widens around backticks and sanitises its info string', () => {
  // `attrs.language` is tenant data: a newline or a backtick in it would end the
  // fence line early and let an attrs value forge document structure.
  const fenced = doc({
    type: 'codeBlock',
    attrs: { language: 'js`\n```' },
    content: [{ type: 'text', text: 'a\n```\nb' }],
  });

  assert.equal(adfToMarkdown(fenced), '````js\na\n```\nb\n````');
  assert.deepEqual(
    adfFromMarkdown(adfToMarkdown(fenced)),
    doc({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [{ type: 'text', text: 'a\n```\nb' }],
    }),
  );

  // Inline code widens the same way, and code content is never escaped.
  const inline = doc({
    type: 'paragraph',
    content: [{ type: 'text', text: 'a`b *c*', marks: [{ type: 'code' }] }],
  });
  assert.equal(adfToMarkdown(inline), '``a`b *c*``');
  assert.deepEqual(adfFromMarkdown(adfToMarkdown(inline)), inline);
});

test('markdown: nested lists keep their markers, indentation and ordered start', () => {
  const description = doc({
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          para('first'),
          {
            type: 'orderedList',
            attrs: { order: 3 },
            content: [
              { type: 'listItem', content: [para('alpha')] },
              { type: 'listItem', content: [para('beta')] },
            ],
          },
        ],
      },
      { type: 'listItem', content: [para('second')] },
    ],
  });

  assert.equal(
    adfToMarkdown(description),
    ['- first', '  3. alpha', '  4. beta', '- second'].join('\n'),
  );
  assert.deepEqual(adfFromMarkdown(adfToMarkdown(description)), description);
});

test('markdown: an item continued on the next line stays one paragraph', () => {
  const description = doc({
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'first' },
              { type: 'hardBreak' },
              { type: 'text', text: 'continued' },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(adfToMarkdown(description), '- first\n  continued');
  assert.deepEqual(adfFromMarkdown(adfToMarkdown(description)), description);
});

test('markdown: blocks are separated so they do not fuse on re-read', () => {
  // Without the blank line the second paragraph would come back as a hardBreak
  // inside the first (CC-10), and the paragraph after a list as a continuation
  // of its last item.
  assert.equal(adfToMarkdown(doc(para('one'), para('two'))), 'one\n\ntwo');
  assert.deepEqual(adfFromMarkdown('one\n\ntwo'), doc(para('one'), para('two')));

  const listThenText = doc(
    { type: 'bulletList', content: [{ type: 'listItem', content: [para('a')] }] },
    para('tail'),
  );
  assert.equal(adfToMarkdown(listThenText), '- a\n\ntail');
  assert.deepEqual(adfFromMarkdown(adfToMarkdown(listThenText)), listThenText);
});

test('CC-43: markdown: only http(s) and mailto links keep their markup', () => {
  const links = doc({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: 'ok',
        marks: [{ type: 'link', attrs: { href: 'https://x.test/a' } }],
      },
      { type: 'text', text: ' ' },
      {
        type: 'text',
        text: 'mail',
        marks: [{ type: 'link', attrs: { href: 'mailto:ops@x.test' } }],
      },
      { type: 'text', text: ' ' },
      {
        type: 'text',
        text: 'script',
        marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
      },
      { type: 'text', text: ' ' },
      {
        type: 'text',
        text: 'data',
        marks: [{ type: 'link', attrs: { href: 'data:text/html,x' } }],
      },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'broken', marks: [{ type: 'link', attrs: { href: 7 } }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'bare', marks: [{ type: 'link' }] },
    ],
  });

  assert.equal(
    adfToMarkdown(links),
    '[ok](https://x.test/a) [mail](mailto:ops@x.test) script data broken bare',
  );
  // The text path never carried a URL, so nothing regresses there.
  assert.equal(adfToText(links), 'ok mail script data broken bare');
});

test('markdown: heading levels are clamped into 1..6', () => {
  const heading = (attrs: Record<string, unknown> | undefined): AdfNode => ({
    type: 'heading',
    ...(attrs === undefined ? {} : { attrs }),
    content: [{ type: 'text', text: 'x' }],
  });

  assert.equal(adfToMarkdown(heading({ level: 0 })), '# x');
  assert.equal(adfToMarkdown(heading({ level: 1 })), '# x');
  assert.equal(adfToMarkdown(heading({ level: 6 })), '###### x');
  assert.equal(adfToMarkdown(heading({ level: 9 })), '###### x');
  assert.equal(adfToMarkdown(heading({ level: 2.7 })), '## x');
  assert.equal(adfToMarkdown(heading({ level: 'two' })), '# x');
  assert.equal(adfToMarkdown(heading(undefined)), '# x');
  // An empty heading keeps its hashes rather than emitting a trailing space.
  assert.equal(adfToMarkdown({ type: 'heading', attrs: { level: 3 } }), '###');
});

test('CC-41: CC-06/CC-07 markdown parity: everything outside the subset renders as text does', () => {
  const outside: AdfNode[] = [
    { type: 'mention', attrs: { text: 'Alice Example' } },
    { type: 'mention', attrs: { id: 'acc-1' } },
    { type: 'emoji', attrs: { shortName: ':fire:' } },
    { type: 'status', attrs: { text: 'DOWN' } },
    { type: 'date', attrs: { timestamp: '1754697600000' } },
    { type: 'inlineCard', attrs: { url: 'https://x.test/OPS-9' } },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'trace.png' } }] },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { state: 'DONE' },
          content: [{ type: 'text', text: 'rollback' }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [para('Env')] },
            { type: 'tableCell', content: [para('State')] },
          ],
        },
      ],
    },
    { type: 'panel', attrs: { panelType: 'error' }, content: [para('Customer facing.')] },
    { type: 'rule' },
    { type: 'somethingAtlassianAddedLater', attrs: { localId: 'z' } },
  ];

  for (const node of outside) {
    assert.equal(adfToMarkdown(node), adfToText(node), `parity for ${node.type}`);
  }
  // Spot-check the two the subset is most often asked about.
  assert.equal(adfToMarkdown(outside[0]), '@Alice Example');
  assert.equal(adfToMarkdown(outside[8]), 'Env | State');
});

test('CC-09 markdown parity: the depth and indent caps hold on the markdown path', () => {
  let nested: AdfNode = { type: 'listItem', content: [para('deepest')] };
  for (let level = 0; level < 12; level += 1) {
    nested = {
      type: 'listItem',
      content: [para(`level ${level}`), { type: 'bulletList', content: [nested] }],
    };
  }
  const markdown = adfToMarkdown({ type: 'bulletList', content: [nested] });
  const widest = Math.max(
    ...markdown.split('\n').map((line) => (line.length - line.trimStart().length) / 2),
  );
  assert.equal(widest, MAX_LIST_INDENT_DEPTH);

  let deep: AdfNode = para('buried');
  for (let level = 0; level < 5000; level += 1)
    deep = { type: 'blockquote', content: [deep] };
  assert.ok(adfToMarkdown(deep).includes(DEPTH_LIMIT_MARKER));
  assert.equal(adfToMarkdown(deep), adfToText(deep));
});

// ---------------------------------------------------------------------------
// Markdown subset — markdown → ADF
// ---------------------------------------------------------------------------

test('CC-10 parity: adfFromMarkdown matches adfFromText on markup-free text', () => {
  const cases = [
    'plain',
    'a\r\nb',
    'a\rb',
    '\n\nlead and trail\n\n',
    'one\ntwo\n\nthree',
    '\tindented',
    'trailing spaces   ',
    '',
    '   ',
  ];
  for (const text of cases) {
    assert.deepEqual(adfFromMarkdown(text), adfFromText(text), JSON.stringify(text));
  }
});

test('adfFromMarkdown: constructs outside the subset stay paragraph text', () => {
  for (const line of [
    '> quoted',
    '| a | b |',
    '<b>html</b>',
    '[ref][1]',
    'a _b_ c',
    '~~strike~~',
    'https://x.test/bare',
    '#hashtag',
    '1234567890. not ordered',
  ]) {
    assert.deepEqual(adfFromMarkdown(line), doc(para(line)), line);
  }

  // A setext heading is two paragraph lines, not a heading.
  assert.deepEqual(
    adfFromMarkdown('Title\n====='),
    doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Title' },
        { type: 'hardBreak' },
        { type: 'text', text: '=====' },
      ],
    }),
  );

  // An image degrades to the link its syntax already contains, plus a literal
  // `!` — the subset has no media, and inventing one would be a fetchable URL.
  assert.deepEqual(
    adfFromMarkdown('![alt](https://x.test/i.png)'),
    doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: '!' },
        {
          type: 'text',
          text: 'alt',
          marks: [{ type: 'link', attrs: { href: 'https://x.test/i.png' } }],
        },
      ],
    }),
  );
});

test('adfFromMarkdown: an unterminated fence still yields its code block', () => {
  assert.deepEqual(
    adfFromMarkdown('```py\nx = 1'),
    doc({
      type: 'codeBlock',
      attrs: { language: 'py' },
      content: [{ type: 'text', text: 'x = 1' }],
    }),
  );
  // No language, no attrs — and an empty body is a node with no content.
  assert.deepEqual(adfFromMarkdown('```\n```'), doc({ type: 'codeBlock', content: [] }));
});

test('adfFromMarkdown: markers the renderer never emits are still accepted', () => {
  assert.deepEqual(
    adfFromMarkdown('+ plus\n* star'),
    doc({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para('plus')] },
        { type: 'listItem', content: [para('star')] },
      ],
    }),
  );
  assert.deepEqual(
    adfFromMarkdown('7) paren'),
    doc({
      type: 'orderedList',
      attrs: { order: 7 },
      content: [{ type: 'listItem', content: [para('paren')] }],
    }),
  );
  // A bare marker is an empty item, not a dropped line.
  assert.deepEqual(
    adfFromMarkdown('-'),
    doc({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }],
    }),
  );
});

test('adfFromMarkdown: a sibling list of the other kind closes the open one', () => {
  const parsed = adfFromMarkdown('- bullet\n1. ordered');
  assert.equal(parsed.content.length, 2);
  assert.equal(parsed.content[0]?.type, 'bulletList');
  assert.equal(parsed.content[1]?.type, 'orderedList');
  // `order: 1` is the default and is not written back as an attr.
  assert.equal(parsed.content[1]?.attrs, undefined);
});

test('adfFromMarkdown: list nesting stops at the parse cap', () => {
  const lines = Array.from(
    { length: 24 },
    (_, level) => `${'  '.repeat(level)}- level ${level}`,
  );
  const parsed = adfFromMarkdown(lines.join('\n'));
  assert.equal(listDepthOf(parsed), 16);
  // Everything past the cap joins the deepest open list rather than growing it.
  assert.equal(itemCountOf(parsed), 24);
});

test('adfFromMarkdown: nested emphasis and links stop at the inline cap', () => {
  const parsed = adfFromMarkdown(`${'['.repeat(40)}x${'](https://x.test/a)'.repeat(40)}`);
  assert.equal(parsed.content.length, 1);
  assert.ok(adfToText(parsed).includes('x'));
});

/** Deepest chain of nested lists in a tree — the parse-cap assertion above. */
function listDepthOf(node: AdfNode): number {
  const own = node.type === 'bulletList' || node.type === 'orderedList' ? 1 : 0;
  let deepest = 0;
  for (const child of node.content ?? []) deepest = Math.max(deepest, listDepthOf(child));
  return deepest + own;
}

/** Every `listItem` in a tree, at any depth. */
function itemCountOf(node: AdfNode): number {
  let count = node.type === 'listItem' ? 1 : 0;
  for (const child of node.content ?? []) count += itemCountOf(child);
  return count;
}

test('CC-44: markdown round trip: the documented lossy cases', () => {
  // A `rule` renders as `---`, which is the paragraph text it literally is: the
  // subset has no horizontal rule.
  assert.deepEqual(
    adfFromMarkdown(adfToMarkdown(doc({ type: 'rule' }))),
    doc(para('---')),
  );
  // An empty paragraph has no markdown spelling at all.
  assert.deepEqual(adfFromMarkdown(adfToMarkdown(doc(para('')))), doc());
  // Mentions are one-way by design: creating one needs an accountId, and the
  // converters are pure and network-free.
  assert.deepEqual(
    adfFromMarkdown(
      adfToMarkdown(
        doc({
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { text: 'Alice' } }],
        }),
      ),
    ),
    doc(para('@Alice')),
  );
  // A table comes back as the single line the text path already flattened it to.
  assert.deepEqual(
    adfFromMarkdown(
      adfToMarkdown(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [para('Env')] },
                { type: 'tableCell', content: [para('State')] },
              ],
            },
          ],
        }),
      ),
    ),
    doc(para('Env | State')),
  );
  // A link the renderer refused to emit keeps its text and loses its target.
  assert.deepEqual(
    adfFromMarkdown(
      adfToMarkdown(
        doc({
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'evil',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        }),
      ),
    ),
    doc(para('evil')),
  );
});

// ---------------------------------------------------------------------------
// renderAdfDocs — the tool ring's re-render seam
// ---------------------------------------------------------------------------

test('renderAdfDocs replaces every document in a payload and leaves the rest alone', () => {
  const description = doc({
    type: 'heading',
    attrs: { level: 1 },
    content: [{ type: 'text', text: 'Title' }],
  });
  const payload = {
    fields: {
      summary: 'plain string',
      description,
      count: 3,
      nothing: null,
      labels: ['a', 'b'],
      comments: [{ body: doc(para('hi')) }],
      notADoc: { type: 'doc', content: 'not an array' },
    },
  };

  const rendered = renderAdfDocs(payload, adfToMarkdown);
  assert.equal(rendered.fields.description, '# Title');
  assert.equal(rendered.fields.comments[0]?.body, 'hi');
  assert.equal(rendered.fields.summary, 'plain string');
  assert.equal(rendered.fields.count, 3);
  assert.equal(rendered.fields.nothing, null);
  assert.deepEqual(rendered.fields.labels, ['a', 'b']);
  assert.deepEqual(rendered.fields.notADoc, { type: 'doc', content: 'not an array' });
  // Non-mutating: the caller's payload still holds the tree.
  assert.ok(isAdfDoc(payload.fields.description));
});

test('renderAdfDocs stops descending at the render depth cap', () => {
  let nested: unknown = doc(para('buried'));
  for (let level = 0; level < 20; level += 1) nested = { nested };

  let cursor: unknown = renderAdfDocs(nested, adfToMarkdown);
  for (let level = 0; level < 20; level += 1) {
    cursor = (cursor as { readonly nested: unknown }).nested;
  }
  assert.ok(isAdfDoc(cursor));
});
