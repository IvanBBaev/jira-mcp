// Wiki writer property suite (stage 13.4a). The examples in
// `wiki-writer.test.ts` pin the shapes we thought of; these defend three
// invariants over shapes we did not:
//
//   1. Round trip (CC-299): over the node subset the writer serves, reading
//      the written markup back with `wikiToText` gives `adfToText` of the same
//      document, up to the documented conventions — lines trimmed, the gap
//      after a list marker collapsed to one space, blank lines
//      and ``` fence lines ignored, control characters dropped. Text is
//      generated rich in wiki metacharacters, so a missed escape shows up here
//      as text that changed on the way back.
//   2. Soundness (CC-300): in `wikiFromText` output, once every `\X` escape
//      and every numeric reference is removed, no wiki metacharacter, no
//      backslash, no emoticon and no line-leading block tag is left.
//   3. Totality (CC-301): `wikiFromText` and `wikiFromMarkdown` never throw
//      on any string — whatever a model sends, the Cloud builders' output is
//      inside the subset.
//
// Tables are left out of 1: `adfToText` collapses cell whitespace, so the two
// sides are not comparable line by line (CC-288 pins them by example).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { adfToText, type AdfNode } from './adf.js';
import { wikiToText } from './wiki.js';
import { wikiFromAdf, wikiFromMarkdown, wikiFromText } from './wiki-writer.js';

const RUNS = { numRuns: 100 } as const;

// eslint-disable-next-line no-control-regex -- the writer drops these
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Both sides of the round trip, in the conventions the writer documents. */
function norm(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(CONTROL_RE, '')
      .split('\n')
      // A list marker's separator is `\s+` on the wiki side, so the space
      // between marker and item text is not preserved (only its presence).
      .map((line) => line.trim().replace(/^(-|\d+\.)\s+/, '$1 '))
      .filter((line) => line !== '' && !line.startsWith('```'))
      .join('\n')
  );
}

/** Pieces of text chosen to collide with every escape rule the writer has. */
const PIECES = [
  'a',
  'Zz',
  '7',
  ' ',
  '\t',
  '*',
  '_',
  '-',
  '+',
  '^',
  '~',
  '?',
  '{',
  '}',
  '[',
  ']',
  '|',
  '!',
  '#',
  '\\',
  '\\\\',
  '&',
  '&amp;',
  '&#35;',
  ':',
  ';',
  '(',
  ')',
  '(y)',
  ':)',
  ';)',
  'h1. ',
  'bq. ',
  '----',
  '{code}',
  '{{',
  '}}',
  '[~x]',
  '??',
  'x.png',
  'http://x.test',
  '@',
  'é',
  '🎉',
  '\uE000',
  '\uE001',
  '\u2028',
  '\u0007',
  '\r',
];

const richTextArb: fc.Arbitrary<string> = fc
  .array(fc.oneof(fc.constantFrom(...PIECES), fc.string({ maxLength: 2 })), {
    minLength: 1,
    maxLength: 8,
  })
  .map((parts) => parts.join(''));

const markArb: fc.Arbitrary<AdfNode[]> = fc
  .tuple(
    fc.subarray(['strong', 'em', 'strike', 'code'], { maxLength: 3 }),
    fc.option(
      fc.constantFrom(
        'https://x.test/a?b=[1]|2',
        'mailto:ops@x.test',
        '~user',
        'javascript:alert(1)',
      ),
      { nil: undefined },
    ),
  )
  .map(([kinds, href]) => {
    const marks: AdfNode[] = kinds.map((type) => ({ type }));
    if (href !== undefined) marks.push({ type: 'link', attrs: { href } });
    return marks;
  });

const inlineNodeArb: fc.Arbitrary<AdfNode> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(richTextArb, markArb)
      .map(([text, marks]): AdfNode =>
        marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks },
      ),
  },
  { weight: 1, arbitrary: fc.constant<AdfNode>({ type: 'hardBreak' }) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.option(richTextArb, { nil: undefined }), markArb)
      .map(([text, marks]): AdfNode => ({
        type: 'mention',
        attrs: text === undefined ? { id: 'acc-1' } : { id: 'acc-1', text: `@${text}` },
        marks,
      })),
  },
);

const inlineArb = fc.array(inlineNodeArb, { minLength: 1, maxLength: 4 });

const paragraphArb: fc.Arbitrary<AdfNode> = inlineArb.map((content) => ({
  type: 'paragraph',
  content,
}));

const headingArb: fc.Arbitrary<AdfNode> = fc
  .tuple(fc.integer({ min: 1, max: 6 }), inlineArb)
  .map(([level, content]) => ({ type: 'heading', attrs: { level }, content }));

const codeBlockArb: fc.Arbitrary<AdfNode> = fc
  .tuple(
    fc.option(fc.constantFrom('js', 'c++', 'bad lang}'), { nil: undefined }),
    fc.array(fc.constantFrom('a', ' ', '\n', '{code}', '*', '\\', '&#35;', '```', '|'), {
      maxLength: 8,
    }),
  )
  .map(([language, parts]) => {
    const body = parts.join('');
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
  const blocksArb = fc.array(fc.oneof(paragraphArb, codeBlockArb), { maxLength: 2 });
  const itemArb: fc.Arbitrary<AdfNode> = fc
    .tuple(inlineArb, blocksArb, nestedArb)
    .map(([content, blocks, nested]) => ({
      type: 'listItem',
      content: [
        { type: 'paragraph', content },
        ...blocks,
        ...(nested === undefined ? [] : [nested]),
      ],
    }));
  return fc
    .tuple(fc.boolean(), fc.array(itemArb, { minLength: 1, maxLength: 3 }))
    .map(([ordered, content]) => ({
      type: ordered ? 'orderedList' : 'bulletList',
      content,
    }));
}

const leafBlockArb: fc.Arbitrary<AdfNode> = fc.oneof(
  paragraphArb,
  headingArb,
  codeBlockArb,
  listArb(2),
  fc.constant<AdfNode>({ type: 'rule' }),
);

const blockArb: fc.Arbitrary<AdfNode> = fc.oneof(
  { weight: 4, arbitrary: leafBlockArb },
  {
    weight: 1,
    arbitrary: fc
      .array(leafBlockArb, { minLength: 1, maxLength: 2 })
      .map((content): AdfNode => ({ type: 'blockquote', content })),
  },
);

const docArb: fc.Arbitrary<AdfNode> = fc
  .array(blockArb, { maxLength: 4 })
  .map((content) => ({ type: 'doc', version: 1, content }));

test('CC-299: property — wikiToText(wikiFromAdf(doc)) reads as adfToText(doc)', () => {
  fc.assert(
    fc.property(docArb, (doc) => {
      assert.equal(norm(wikiToText(wikiFromAdf(doc))), norm(adfToText(doc)));
    }),
    RUNS,
  );
});

const anyTextArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(fc.constantFrom(...PIECES, '\n', '\n\n'), { maxLength: 20 })
    .map((p) => p.join('')),
  fc.string(),
  fc.string({ unit: 'binary' }),
);

test('CC-300: property — wikiFromText leaves no live markup once escapes are removed', () => {
  fc.assert(
    fc.property(anyTextArb, (text) => {
      const wiki = wikiFromText(text);
      const bare = wiki.replace(/\\[*_\-+^~?{}[\]|!]/g, '').replace(/&#\d+;/g, '');
      assert.doesNotMatch(bare, /[*_\-+^~?{}[\]|!\\]/);
      assert.doesNotMatch(wiki, /:[()PpDd]|;\)/);
      assert.doesNotMatch(wiki, /\((?:[ynix/!+?*-]|\*[rgby]|on|off|flag|flagoff)\)/i);
      for (const line of wiki.split('\n')) {
        assert.doesNotMatch(line, /^\s*(?:#|h[1-6]\.|bq\.)/i, line);
      }
      assert.doesNotMatch(wiki, /[\r\uE000\uE001\u2028\u2029]/);
      // And it reads back as the text it came from.
      assert.equal(norm(wikiToText(wiki)), norm(text));
    }),
    RUNS,
  );
});

test('CC-301: property — wikiFromText and wikiFromMarkdown never throw', () => {
  fc.assert(
    fc.property(anyTextArb, (text) => {
      assert.equal(typeof wikiFromText(text), 'string');
      assert.equal(typeof wikiFromMarkdown(text), 'string');
      assert.equal(
        typeof wikiFromMarkdown(`- ${text}\n  1. ${text}\n\`\`\`js\n${text}\n\`\`\``),
        'string',
      );
    }),
    RUNS,
  );
});
