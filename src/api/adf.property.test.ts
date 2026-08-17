// ADF property suite (TESTING.md §Suites 5 — "fast-check, small").
//
// The example-based suite in `adf.test.ts` pins the shapes we know; every
// fast-check property lives here, so that file stays readable as a catalogue of
// shapes and this one carries the generators. The invariants defended below
// must hold for shapes we have never seen, because ADF arrives from the wire as
// `unknown` and Atlassian adds node types without asking:
//
//   1. `adfToText` is total — it returns a string for ANY input and never
//      throws (CC-06, CC-09). A parser that throws turns one odd comment into a
//      failed tool call.
//   2. `adfFromText` is structurally valid — always `{ type: 'doc',
//      version: 1, content: [...] }` with well-formed paragraphs, so a write
//      tool cannot build a body Jira rejects on shape (CC-10).
//   3. The markdown pair round-trips over the documented subset, and
//      `adfFromMarkdown` is total with markdown as its own fixed point.
//
// Run counts stay small on purpose: this is a gate in `npm run check`, not a
// fuzzing campaign.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  adfFromMarkdown,
  adfFromText,
  adfToMarkdown,
  adfToText,
  isAdfDoc,
  toAdf,
  type AdfNode,
} from './adf.js';

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
            // CRLF is normalised away before any text node is built (CC-10).
            // Assert on the character, not on its JSON escape: a `\r` escape in
            // the serialised doc is also what a literal backslash followed by
            // `r` in the input produces, and that text must survive untouched.
            assert.ok(!(leaf.text ?? '').includes('\r'));
          }
        }
      }
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

// ---------------------------------------------------------------------------
// Markdown round trip. The example-based subset cases live in `adf.test.ts`;
// these two are their generated half — the same node vocabulary, generated
// instead of hand-written, so a subset the examples never spelled out cannot
// survive one direction and not the other.
// ---------------------------------------------------------------------------
/** The mark array as `unknown[]`: `Array.isArray` alone widens it to `any[]`. */
function markArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

/** Mark type as a string, for sorting a mark array into a stable order. */
function markType(mark: unknown): string {
  return typeof mark === 'object' && mark !== null && 'type' in mark
    ? String((mark as { readonly type: unknown }).type)
    : '';
}

/**
 * The normal form the round trip is defined up to: marks sorted, adjacent text
 * nodes with the same mark set merged, empty text nodes dropped. Markdown has
 * no spelling for any of those distinctions — `**a****b**` is one bold run —
 * so a converter that preserved them would have to invent syntax.
 */
function canonical(node: AdfNode): AdfNode {
  const out: AdfNode = { ...node };
  const marks = markArray(out.marks);
  if (marks !== undefined) {
    out.marks = [...marks].sort((a, b) => markType(a).localeCompare(markType(b)));
  }
  if (Array.isArray(node.content)) {
    const merged: AdfNode[] = [];
    for (const child of node.content) {
      const next = canonical(child);
      if (next.type === 'text' && next.text === '') continue;
      const prev = merged.at(-1);
      if (
        prev !== undefined &&
        prev.type === 'text' &&
        next.type === 'text' &&
        JSON.stringify(prev.marks ?? null) === JSON.stringify(next.marks ?? null)
      ) {
        merged[merged.length - 1] = {
          ...prev,
          text: `${prev.text ?? ''}${next.text ?? ''}`,
        };
        continue;
      }
      merged.push(next);
    }
    out.content = merged;
  }
  return out;
}

/** Text that carries no structure of its own: no line breaks, no edge spaces. */
const inlineTextArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((raw) => raw.replace(/\s+/g, ' '))
  .filter((raw) => raw !== '' && raw.trim() === raw);

const inlineArb: fc.Arbitrary<AdfNode[]> = fc.array(
  fc
    .tuple(
      inlineTextArb,
      fc.subarray(['code', 'em', 'strong'], { maxLength: 3 }),
      fc.option(fc.constantFrom('https://x.test/a', 'mailto:ops@x.test'), {
        nil: undefined,
      }),
    )
    .map(([text, kinds, href]): AdfNode => {
      const marks: AdfNode[] = kinds.map((type) => ({ type }));
      if (href !== undefined) marks.push({ type: 'link', attrs: { href } });
      return marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks };
    }),
  { minLength: 1, maxLength: 3 },
);

const paragraphArb: fc.Arbitrary<AdfNode> = inlineArb.map((content) => ({
  type: 'paragraph',
  content,
}));

const headingArb: fc.Arbitrary<AdfNode> = fc
  .tuple(fc.integer({ min: 1, max: 6 }), inlineArb)
  .map(([level, content]) => ({ type: 'heading', attrs: { level }, content }));

const codeBlockArb: fc.Arbitrary<AdfNode> = fc
  .tuple(
    fc.option(fc.constantFrom('js', 'python', 'text'), { nil: undefined }),
    fc.string({
      unit: fc.constantFrom('a', 'b', ' ', '\n', '`', '*', '#'),
      maxLength: 20,
    }),
  )
  .map(([language, body]) => {
    const node: AdfNode = {
      type: 'codeBlock',
      content: body === '' ? [] : [{ type: 'text', text: body }],
    };
    if (language !== undefined) node.attrs = { language };
    return node;
  });

function listArb(depth: number): fc.Arbitrary<AdfNode> {
  const nestedArb: fc.Arbitrary<AdfNode | undefined> =
    depth <= 0
      ? fc.constant(undefined)
      : fc.option(listArb(depth - 1), { nil: undefined, freq: 3 });

  const itemArb: fc.Arbitrary<AdfNode> = fc
    .tuple(inlineArb, nestedArb)
    .map(([content, nested]) => ({
      type: 'listItem',
      content:
        nested === undefined
          ? [{ type: 'paragraph', content }]
          : [{ type: 'paragraph', content }, nested],
    }));

  return fc
    .tuple(
      fc.boolean(),
      fc.option(fc.integer({ min: 2, max: 99 }), { nil: undefined }),
      fc.array(itemArb, { minLength: 1, maxLength: 3 }),
    )
    .map(([ordered, order, items]) => {
      const node: AdfNode = {
        type: ordered ? 'orderedList' : 'bulletList',
        content: items,
      };
      if (ordered && order !== undefined) node.attrs = { order };
      return node;
    });
}

const subsetDocArb: fc.Arbitrary<AdfNode> = fc
  .array(fc.oneof(paragraphArb, headingArb, codeBlockArb, listArb(2)), {
    maxLength: 3,
  })
  .map((content) => ({ type: 'doc', version: 1, content }));

test('property: the subset survives adfToMarkdown → adfFromMarkdown', () => {
  fc.assert(
    fc.property(subsetDocArb, (generated) => {
      const source = canonical(generated);
      assert.deepEqual(canonical(adfFromMarkdown(adfToMarkdown(source))), source);
    }),
    RUNS,
  );
});

test('property: adfFromMarkdown is total and its markdown is a fixed point', () => {
  const noisyArb = fc.string({
    unit: fc.constantFrom(
      'a',
      ' ',
      '\n',
      '\t',
      '#',
      '-',
      '+',
      '*',
      '`',
      '[',
      ']',
      '(',
      ')',
      '\\',
      '>',
      '1',
      '.',
      ')',
      '|',
      '_',
      '!',
      ':',
      '/',
    ),
    maxLength: 40,
  });

  fc.assert(
    fc.property(fc.oneof(noisyArb, fc.string()), (text) => {
      const parsed = adfFromMarkdown(text);
      assert.ok(isAdfDoc(parsed));
      // Normalising twice must equal normalising once: a converter that grew or
      // shrank its own output would drift on every edit round trip.
      const once = adfToMarkdown(parsed);
      assert.equal(adfToMarkdown(adfFromMarkdown(once)), once);
    }),
    RUNS,
  );
});
