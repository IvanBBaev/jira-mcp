// ADF property suite (TESTING.md §Suites 5 — "fast-check, small").
//
// The example-based suite in `adf.test.ts` pins the shapes we know. These
// properties defend the two invariants that must hold for shapes we have never
// seen, because ADF arrives from the wire as `unknown` and Atlassian adds node
// types without asking:
//
//   1. `adfToText` is total — it returns a string for ANY input and never
//      throws (CC-06, CC-09). A parser that throws turns one odd comment into a
//      failed tool call.
//   2. `adfFromText` is structurally valid — always `{ type: 'doc',
//      version: 1, content: [...] }` with well-formed paragraphs, so a write
//      tool cannot build a body Jira rejects on shape (CC-10).
//
// Run counts stay small on purpose: this is a gate in `npm run check`, not a
// fuzzing campaign.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { adfFromText, adfToText, isAdfDoc, toAdf, type AdfNode } from './adf.js';

const RUNS = { numRuns: 100 } as const;

/**
 * Node type names: the real vocabulary, plus names Atlassian has not invented
 * yet, plus hostile ones (empty, whitespace, very long).
 */
const typeArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'doc',
    'paragraph',
    'text',
    'heading',
    'hardBreak',
    'mention',
    'emoji',
    'status',
    'date',
    'inlineCard',
    'blockCard',
    'codeBlock',
    'panel',
    'rule',
    'table',
    'tableRow',
    'tableCell',
    'tableHeader',
    'bulletList',
    'orderedList',
    'listItem',
    'taskList',
    'taskItem',
    'media',
    'mediaSingle',
    'mediaGroup',
    'blockquote',
    'expand',
    'nodeAtlassianAddsIn2027',
    '',
    'weird\ntype',
  ),
  fc.string(),
);

const attrsArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.constantFrom(
    'id',
    'text',
    'url',
    'title',
    'state',
    'language',
    'panelType',
    'timestamp',
    'alt',
    'order',
    'shortName',
  ),
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.string(), { maxLength: 2 }),
    fc.record({ name: fc.string(), url: fc.string() }),
  ),
  { maxKeys: 4 },
);

/** An arbitrary node tree — mostly ADF-shaped, never guaranteed to be valid. */
const { node: adfTreeArb } = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 4 },
    fc.record(
      { type: typeArb, text: fc.string(), attrs: attrsArb },
      { requiredKeys: ['type'] },
    ),
    fc.record(
      {
        type: typeArb,
        attrs: attrsArb,
        content: fc.array(tie('node'), { maxLength: 3 }),
      },
      { requiredKeys: ['type', 'content'] },
    ),
  ),
}));

/** Plain text that actually exercises the line/paragraph rules of CC-10. */
const textArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(
      fc.constantFrom('a', 'bb', ' ', '\t', '\n', '\r\n', '\n\n', '\n \n', 'é', '🎉'),
      {
        maxLength: 30,
      },
    )
    .map((parts) => parts.join('')),
  fc.string(),
);

// ---------------------------------------------------------------------------
// 1. adfToText is total
// ---------------------------------------------------------------------------

test('property: adfToText returns a string for any ADF-shaped tree, never throwing', () => {
  fc.assert(
    fc.property(adfTreeArb, (tree) => {
      const out = adfToText(tree);
      assert.equal(typeof out, 'string');
    }),
    RUNS,
  );
});

test('property: adfToText survives arbitrary non-ADF values', () => {
  fc.assert(
    fc.property(fc.anything(), (value) => {
      assert.equal(typeof adfToText(value), 'string');
    }),
    RUNS,
  );
});

test('property: a flattened tree never ends in whitespace', () => {
  fc.assert(
    fc.property(adfTreeArb, (tree) => {
      const out = adfToText(tree);
      assert.equal(out, out.trimEnd());
    }),
    RUNS,
  );
});

test('property: a media node never leaks its URL into the text', () => {
  fc.assert(
    fc.property(fc.webUrl(), fc.string(), (url, alt) => {
      const out = adfToText({
        type: 'mediaSingle',
        content: [{ type: 'media', attrs: { id: 'media-id', type: 'file', url, alt } }],
      });
      assert.ok(!out.includes(url), out);
    }),
    RUNS,
  );
});

// ---------------------------------------------------------------------------
// 2. adfFromText is structurally valid
// ---------------------------------------------------------------------------

test('property: adfFromText always builds a document Jira accepts structurally', () => {
  fc.assert(
    fc.property(textArb, (text) => {
      const built = adfFromText(text);
      assert.equal(built.type, 'doc');
      assert.equal(built.version, 1);
      assert.ok(Array.isArray(built.content));
      assert.ok(isAdfDoc(built));

      for (const block of built.content) {
        assert.equal(block.type, 'paragraph');
        const inline = block.content;
        assert.ok(Array.isArray(inline) && inline.length > 0);
        for (const leaf of inline) {
          assert.ok(leaf.type === 'text' || leaf.type === 'hardBreak');
          if (leaf.type === 'text') {
            // An empty text node is invalid ADF; blank lines are separators.
            assert.equal(typeof leaf.text, 'string');
            assert.ok((leaf.text ?? '').length > 0);
          }
        }
      }

      // CRLF is normalised away before any text node is built (CC-10).
      assert.ok(!JSON.stringify(built).includes('\\r'));
    }),
    RUNS,
  );
});

test('property: no leading or trailing blank paragraph survives (CC-10)', () => {
  fc.assert(
    fc.property(textArb, (text) => {
      const { content } = adfFromText(text);
      if (content.length === 0) return;
      const first = content[0];
      const last = content[content.length - 1];
      assert.ok(first !== undefined && (first.content?.length ?? 0) > 0);
      assert.ok(last !== undefined && (last.content?.length ?? 0) > 0);
    }),
    RUNS,
  );
});

test('property: the round trip drops no non-blank line', () => {
  fc.assert(
    fc.property(textArb, (text) => {
      const out = adfToText(adfFromText(text));
      const lines = text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      for (const line of lines) {
        assert.ok(
          out.includes(line),
          `${JSON.stringify(line)} missing from ${JSON.stringify(out)}`,
        );
      }
    }),
    RUNS,
  );
});

test('property: toAdf on plain text equals adfFromText and never throws', () => {
  fc.assert(
    fc.property(textArb, (text) => {
      assert.deepEqual(toAdf(text), adfFromText(text));
    }),
    RUNS,
  );
});

test('property: toAdf passes a document through with the version pinned', () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 3 }), (texts) => {
      const content: AdfNode[] = texts
        .filter((t) => t.length > 0)
        .map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] }));
      const normalized = toAdf({ type: 'doc', content });
      assert.equal(normalized.version, 1);
      assert.deepEqual(normalized.content, content);
    }),
    RUNS,
  );
});
