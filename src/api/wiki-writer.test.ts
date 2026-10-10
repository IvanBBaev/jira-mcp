// ADF → Jira wiki markup (stage 13.4a). The example catalogue: one test per
// construct and per escape rule, each checked two ways — the exact markup
// written, and that `wikiToText` reads it back as `adfToText` reads the ADF.
// The fast-check properties live in `wiki-writer.property.test.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JiraError } from '../core/types.js';
import { adfFromMarkdown, adfToText, toAdf, type AdfNode } from './adf.js';
import { wikiToText } from './wiki.js';
import {
  isWikiMentionUsername,
  tagDataCenterMentions,
  wikiFromAdf,
  wikiFromMarkdown,
  wikiFromText,
} from './wiki-writer.js';

function doc(...content: AdfNode[]): AdfNode {
  return { type: 'doc', version: 1, content };
}

function p(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function t(text: string, ...marks: AdfNode[]): AdfNode {
  return marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks };
}

const strong: AdfNode = { type: 'strong' };
const em: AdfNode = { type: 'em' };
const strike: AdfNode = { type: 'strike' };
const code: AdfNode = { type: 'code' };
function link(href: unknown): AdfNode {
  return { type: 'link', attrs: { href } };
}

/** Plain text in `adfToText`'s spelling, trimmed per line, blank lines gone. */
function norm(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

function assertRoundTrip(adf: AdfNode): void {
  assert.equal(norm(wikiToText(wikiFromAdf(adf))), norm(adfToText(adf)));
}

function validationError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof JiraError);
    assert.equal(error.kind, 'validation');
    assert.match(error.message, pattern);
    assert.match(error.remediation ?? '', /paragraphs, headings|Flatten the structure/);
    return true;
  });
}

test('CC-276: the node subset renders as wiki markup and reads back as adfToText', () => {
  const adf = doc(
    { type: 'heading', attrs: { level: 2 }, content: [t('Plan')] },
    p(t('one'), { type: 'hardBreak' }, t('two')),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [p(t('a'))] },
        {
          type: 'listItem',
          content: [
            p(t('b')),
            {
              type: 'orderedList',
              content: [{ type: 'listItem', content: [p(t('b1'))] }],
            },
          ],
        },
      ],
    },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;\n*b*')] },
    { type: 'blockquote', content: [p(t('quoted'))] },
    { type: 'rule' },
    p(
      t('s', strong),
      t(' '),
      t('e', em),
      t(' '),
      t('x', strike),
      t(' '),
      t('c', code),
      t(' '),
      t('l', link('https://x.test/a')),
    ),
  );
  assert.equal(
    wikiFromAdf(adf),
    [
      'h2. Plan',
      '',
      'one\ntwo',
      '',
      '* a\n* b\n*# b1',
      '',
      '{code:ts}\nconst a = 1;\n*b*\n{code}',
      '',
      '{quote}\nquoted\n{quote}',
      '',
      '----',
      '',
      '*s* _e_ -x- {{c}} [l|https://x.test/a]',
    ].join('\n'),
  );
  assertRoundTrip(adf);
});

test('CC-276: wikiFromMarkdown and wikiFromText are the ADF writer over the Cloud builders', () => {
  const md = '# Title\n\nSome **bold** and `code`.\n\n- item\n  1. sub';
  assert.equal(wikiFromMarkdown(md), wikiFromAdf(adfFromMarkdown(md)));
  assert.equal(
    wikiFromMarkdown(md),
    'h1. Title\n\nSome *bold* and {{&#99;ode}}.\n\n* item\n*# sub',
  );
  const text = 'first line\nsecond *line*\n\nnext paragraph';
  assert.equal(wikiFromText(text), wikiFromAdf(toAdf(text)));
  assert.equal(wikiFromText(text), 'first line\nsecond \\*line\\*\n\nnext paragraph');
  assert.equal(wikiFromText(''), '');
});

test('CC-277: every wiki metacharacter in text is backslash-escaped and reads back literally', () => {
  const text = 'a * b _ c - d + e ^ f ~ g ? h { i } j [ k ] l | m ! n';
  const wiki = wikiFromText(text);
  assert.equal(
    wiki,
    'a \\* b \\_ c \\- d \\+ e \\^ f \\~ g \\? h \\{ i \\} j \\[ k \\] l \\| m \\! n',
  );
  assert.equal(wikiToText(wiki), text);
  // The shapes that WOULD be markup if written raw.
  for (const hostile of [
    '*bold*',
    '_em_',
    '-strike-',
    '+ins+',
    '^sup^',
    '~sub~',
    '??cite??',
    '{{mono}}',
    '[label|https://evil.test]',
    '[~admin]',
    '!image.png!',
    '{color:red}x{color}',
  ]) {
    assert.equal(wikiToText(wikiFromText(hostile)), hostile, hostile);
  }
  // The reader side of the same promise: an escaped macro brace is text, so
  // `{quote}` / `{color}` stripping must not eat it (or the text around it).
  assert.equal(wikiToText('\\{quote} kept'), '{quote} kept');
  assert.equal(wikiToText('\\{color:red\\}x'), '{color:red}x');
});

test('CC-278: line-leading block syntax is neutralised, never read as structure', () => {
  const lines = [
    '# numbered?',
    '#',
    'h1. heading?',
    'H3. heading?',
    '  bq. quote?',
    'BQ. quote?',
    '* bullet?',
    '- dash?',
    '----',
    '|| a || b ||',
    '| a | b |',
    '{code}',
    '{noformat}',
    '{quote}',
    '{info}',
  ];
  const wiki = wikiFromText(lines.join('\n'));
  assert.equal(
    wiki,
    [
      '&#35; numbered\\?',
      '&#35;',
      '&#104;1. heading\\?',
      '&#72;3. heading\\?',
      '  &#98;q. quote\\?',
      '&#66;Q. quote\\?',
      '\\* bullet\\?',
      '\\- dash\\?',
      '\\-\\-\\-\\-',
      '\\|\\| a \\|\\| b \\|\\|',
      '\\| a \\| b \\|',
      '\\{code\\}',
      '\\{noformat\\}',
      '\\{quote\\}',
      '\\{info\\}',
    ].join('\n'),
  );
  assert.equal(norm(wikiToText(wiki)), norm(lines.join('\n')));
  // Mid-line the same characters need only the backslash.
  assert.equal(wikiFromText('x # h1. bq.'), 'x # h1. bq.');
});

test('CC-279: what a backslash cannot say is written as a numeric character reference', () => {
  const cases: [string, string][] = [
    // `\\` is a line break in wiki markup: a literal backslash is `&#92;`.
    ['C:\\temp\\x', 'C:&#92;temp&#92;x'],
    ['a\\\\b', 'a&#92;&#92;b'],
    // An `&` that would start a reference is itself a reference.
    ['&amp; &#35; &#x23; & plain &;', '&#38;amp; &#38;#35; &#38;#x23; & plain &;'],
    // Emoticons: `:)` `:(` `:P` `:D` `;)` and the parenthesised family.
    [':) :( :P :D ;)', ':&#41; :&#40; :&#80; :&#68; ;&#41;'],
    [
      '(y) (N) (/) (!) (on) (off) (*r) (flag) (flagoff) (yes)',
      '&#40;y) &#40;N) &#40;/) &#40;\\!) &#40;on) &#40;off) &#40;\\*r) &#40;flag) &#40;flagoff) (yes)',
    ],
    // A reference's own `;` before `)` would be `;)`.
    ['\\)', '&#92;&#41;'],
    // The reader's private-use sentinels and the Unicode line separators.
    ['a\uE000b\uE001c\u2028d\u2029e', 'a&#57344;b&#57345;c&#8232;d&#8233;e'],
  ];
  for (const [text, expected] of cases) {
    const wiki = wikiFromText(text);
    assert.equal(wiki, expected, text);
    assert.doesNotMatch(
      wiki,
      /(?<!&#\d+);\)|:[()PpDd]|\((?:[ynix/!+?*-]|\*[rgby]|on|off|flag|flagoff)\)/i,
    );
    assert.equal(wikiToText(wiki), text, text);
  }
});

test('CC-280: wikiToText decodes valid numeric references last, and nothing else', () => {
  assert.equal(wikiToText('&#35; &#x2A;bold&#X2a; &#104;1. x'), '# *bold* h1. x');
  // Decoded characters are not re-read as markup, and one pass means one pass.
  assert.equal(wikiToText('&#42;x&#42;'), '*x*');
  assert.equal(wikiToText('&#38;#35;'), '&#35;');
  // Named entities, NUL, surrogates and out-of-range values stay as written.
  assert.equal(
    wikiToText('&amp; &#0; &#xD800; &#1114112; &#x110000; &#12345678;'),
    '&amp; &#0; &#xD800; &#1114112; &#x110000; &#12345678;',
  );
  assert.equal(wikiToText('&#x1F600;'), '\u{1F600}');
  // Code bodies are verbatim.
  assert.equal(wikiToText('{code}\n&#35;\n{code}'), '```\n&#35;\n```');
  // A line that skipped escape parking (it holds a sentinel) is still decoded.
  assert.equal(wikiToText('\uE000 &#35;'), '\uE000 #');
});

test('CC-281: control characters are dropped and CR/CRLF become newlines', () => {
  const text = 'a\u0000b\u0007c\u001Fd\u007Fe\u0085f\tg\r\nh\ri';
  const wiki = wikiFromText(text);
  assert.equal(wiki, 'abcdef\tg\nh\ni');
  assert.doesNotMatch(wiki, /\r/);
  const code = wikiFromAdf(doc({ type: 'codeBlock', content: [t('x\r\ny\u0000z')] }));
  assert.equal(code, '{code}\nx\nyz\n{code}');
});

test('CC-282: a mark is written only where Jira renders it; the text always stays', () => {
  // Mid-word marks do not render in wiki markup: text kept, mark dropped.
  assert.equal(
    wikiFromAdf(doc(p(t('un'), t('believ', strong), t('able')))),
    'unbelievable',
  );
  assert.equal(wikiFromAdf(doc(p(t('a'), t('b', em)))), 'ab');
  assert.equal(wikiFromAdf(doc(p(t('x', strike), t('1')))), 'x1');
  // Code (`{{}}`) renders mid-word, so it is kept.
  assert.equal(wikiFromAdf(doc(p(t('a'), t('b', code), t('c')))), 'a{{b}}c');
  // Edge whitespace moves outside the mark; whitespace alone carries none.
  assert.equal(wikiFromAdf(doc(p(t('a'), t(' b ', strong), t('c')))), 'a *b* c');
  assert.equal(wikiFromAdf(doc(p(t('a'), t('   ', em), t('b')))), 'a   b');
  // Nested marks, outermost first, and punctuation neighbours keep the mark.
  assert.equal(
    wikiFromAdf(doc(p(t('"'), t('x', strong, em, strike), t('"')))),
    '"*_-x-_*"',
  );
  // The same mark on both sides of a link split cannot abut: it is dropped.
  assert.equal(
    wikiFromAdf(doc(p(t('a', strong), t('b', strong, link('https://x.test'))))),
    'a[b|https://x.test]',
  );
  for (const adf of [
    doc(p(t('un'), t('believ', strong), t('able'))),
    doc(p(t('a'), t(' b ', strong), t('c'))),
    doc(p(t('"'), t('x', strong, em, strike), t('"'))),
    doc(p(t('a', strong), t('b', strong, link('https://x.test')))),
  ]) {
    assertRoundTrip(adf);
  }
});

test('CC-283: links keep safe targets only, and a label or URL cannot break out', () => {
  // Unsafe schemes (CC-153's rule, re-checked here) lose the link, keep the text.
  for (const href of [
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'vbscript:x',
    'data:text/html,x',
    '',
    '   ',
    42,
    undefined,
  ]) {
    assert.equal(wikiFromAdf(doc(p(t('click', link(href))))), 'click', String(href));
  }
  // `|` and `]` in a label are references; in a URL they are percent-encoded.
  const adf = doc(p(t('a|b]c[d', link('https://x.test/p?q=a|b]c[d e{f}!~'))));
  assert.equal(
    wikiFromAdf(adf),
    '[a&#124;b&#93;c&#91;d|https://x.test/p?q=a%7Cb%5Dc%5Bd%20e%7Bf%7D%21~]',
  );
  assertRoundTrip(adf);
  // A leading `~` or `^` would read as a mention or an attachment.
  assert.equal(wikiFromAdf(doc(p(t('u', link('~admin'))))), '[u|%7Eadmin]');
  assert.equal(wikiFromAdf(doc(p(t('u', link('^file.txt'))))), '[u|%5Efile.txt]');
  // A whitespace-only label drops the link, keeping the whitespace.
  assert.equal(
    wikiFromAdf(doc(p(t('a'), t(' ', link('https://x.test')), t('b')))),
    'a b',
  );
  // Marks inside a link label.
  assert.equal(
    wikiFromAdf(doc(p(t('go', strong, link('https://x.test'))))),
    '[*go*|https://x.test]',
  );
});

test('CC-284: a code body that would close {code} early falls back to {noformat}, then to a ZWSP', () => {
  assert.equal(
    wikiFromAdf(doc({ type: 'codeBlock', content: [t('a {code} b')] })),
    '{noformat}\na {code} b\n{noformat}',
  );
  assert.equal(
    wikiFromAdf(
      doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [t('{CODE}')] }),
    ),
    '{noformat}\n{CODE}\n{noformat}',
  );
  assert.equal(
    wikiFromAdf(doc({ type: 'codeBlock', content: [t('{code}{noformat}')] })),
    '{noformat}\n{\u200Bcode}{\u200Bnoformat}\n{noformat}',
  );
  // A language that is not a plain name is not written into the tag.
  assert.equal(
    wikiFromAdf(
      doc({ type: 'codeBlock', attrs: { language: 'x}|y' }, content: [t('z')] }),
    ),
    '{code}\nz\n{code}',
  );
  assert.equal(wikiFromAdf(doc({ type: 'codeBlock' })), '{code}\n\n{code}');
  // Verbatim body: no escaping inside.
  const body = '*a* [b|c] \\ &#35; h1. x';
  assert.equal(
    wikiFromAdf(doc({ type: 'codeBlock', content: [t(body)] })),
    `{code}\n${body}\n{code}`,
  );
  const fallback = doc({ type: 'codeBlock', content: [t('x\n{code}\ny')] });
  assertRoundTrip(fallback);
});

test('CC-401: inline code cannot spell a macro tag with the `{{` that opens it', () => {
  const cases: [string, string, string][] = [
    ['use `quote` here', 'use {{&#113;uote}} here', 'use quote here'],
    ['`color`', '{{&#99;olor}}', 'color'],
    ['x `QUOTE` y', 'x {{&#81;UOTE}} y', 'x QUOTE y'],
    ['`color:red}`', '{{&#99;olor:red\\}}}', 'color:red}'],
    // Nothing after `{{` that closes into a tag: written as is.
    ['`b`', '{{b}}', 'b'],
    ['`quote x`', '{{quote x}}', 'quote x'],
  ];
  for (const [markdown, expected, text] of cases) {
    const wiki = wikiFromMarkdown(markdown);
    assert.equal(wiki, expected, markdown);
    assert.equal(wikiToText(wiki), text, markdown);
  }
});

test('[CC-418] inline code cannot spell a panel macro tag either', () => {
  const cases: [string, string, string][] = [
    [
      'Use `note` then `note`',
      'Use {{&#110;ote}} then {{&#110;ote}}',
      'Use note then note',
    ],
    ['`info`', '{{&#105;nfo}}', 'info'],
    ['`warning` and `Tip`', '{{&#119;arning}} and {{&#84;ip}}', 'warning and Tip'],
    ['`tip:title=x}`', '{{&#116;ip:title=x\\}}}', 'tip:title=x}'],
    // A longer word is no tag.
    ['`notes`', '{{notes}}', 'notes'],
  ];
  for (const [markdown, expected, text] of cases) {
    const wiki = wikiFromMarkdown(markdown);
    assert.equal(wiki, expected, markdown);
    assert.equal(wikiToText(wiki), text, markdown);
  }
});

test('CC-402: a named entity of any length is written as text', () => {
  const text = 'a &rightarrow; b &CounterClockwiseContourIntegral; c';
  const wiki = wikiFromText(text);
  assert.equal(wiki, 'a &#38;rightarrow; b &#38;CounterClockwiseContourIntegral; c');
  assert.equal(wikiToText(wiki), text);
});

test('CC-398: a code body inside a quote cannot close the quote', () => {
  const quoted = (text: string, language?: string): AdfNode =>
    doc({
      type: 'blockquote',
      content: [
        {
          type: 'codeBlock',
          ...(language === undefined ? {} : { attrs: { language } }),
          content: [t(text)],
        },
      ],
    });
  assert.equal(
    wikiFromAdf(quoted('a {quote} b', 'js')),
    '{quote}\n{code:js}\na {\u200Bquote} b\n{code}\n{quote}',
  );
  assert.equal(
    wikiFromAdf(quoted('{QUOTE}{code}')),
    '{quote}\n{noformat}\n{\u200BQUOTE}{code}\n{noformat}\n{quote}',
  );
  // A nested quote is still the same quote: its code is guarded too.
  assert.equal(
    wikiFromAdf(
      doc({
        type: 'blockquote',
        content: [
          {
            type: 'blockquote',
            content: [{ type: 'codeBlock', content: [t('{quote}')] }],
          },
        ],
      }),
    ),
    '{quote}\n{code}\n{\u200Bquote}\n{code}\n{quote}',
  );
  // Outside a quote the body stays verbatim.
  assert.equal(
    wikiFromAdf(doc({ type: 'codeBlock', content: [t('{quote}')] })),
    '{code}\n{quote}\n{code}',
  );
});

test('CC-285: lists nest by repeated markers; the documented conventions hold', () => {
  const md = '1. one\n   - a\n     1. deep\n   - b\n2. two';
  assert.equal(wikiFromMarkdown(md), '# one\n#* a\n#*# deep\n#* b\n# two');
  assert.equal(
    norm(wikiToText(wikiFromMarkdown(md))),
    norm(adfToText(adfFromMarkdown(md))),
  );
  // An empty item stays an item.
  const empty = doc({ type: 'bulletList', content: [{ type: 'listItem', content: [] }] });
  assert.equal(wikiFromAdf(empty), '* ');
  assertRoundTrip(empty);
  // An item that opens with a nested list gets an empty line of its own.
  const leadingNest = doc({
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('x'))] }] },
        ],
      },
    ],
  });
  assert.equal(wikiFromAdf(leadingNest), '* \n** x');
  // Two paragraphs share the item's line; text after a nested list opens a
  // new item at the same depth; a code block becomes {{…}} lines.
  const item = doc({
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          p(t('first')),
          p(t('second')),
          { type: 'codeBlock', content: [t('  x = 1\n\n{y}')] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('n'))] }] },
          p(t('after')),
        ],
      },
    ],
  });
  assert.equal(
    wikiFromAdf(item),
    '* first\\\\second\\\\{{x = 1}}\\\\{{\\{y\\}}}\n** n\n* after',
  );
  // The start number of an ordered list is not expressible: `attrs.order` is lost.
  assert.equal(
    wikiFromAdf(
      doc({
        type: 'orderedList',
        attrs: { order: 5 },
        content: [{ type: 'listItem', content: [p(t('five'))] }],
      }),
    ),
    '# five',
  );
});

test('CC-286: a mention is written as its literal display text, never as [~id]', () => {
  const mention = (attrs: Record<string, unknown>): AdfNode => ({
    type: 'mention',
    attrs,
  });
  assert.equal(
    wikiFromAdf(doc(p(t('cc '), mention({ id: '557058:abc', text: '@Ann Lee' })))),
    'cc @Ann Lee',
  );
  assert.equal(wikiFromAdf(doc(p(mention({ id: '557058:abc', text: 'Ann' })))), '@Ann');
  assert.equal(wikiFromAdf(doc(p(mention({ id: '557058:abc' })))), '@557058:abc');
  assert.equal(wikiFromAdf(doc(p(t('x'), mention({}), t('y')))), 'xy');
  // The display text is tenant text: escaped like any other.
  const hostile = doc(p(mention({ id: 'x', text: '@[~admin] *b* h1.' })));
  assert.equal(wikiFromAdf(hostile), '@\\[\\~admin\\] \\*b\\* h1.');
  assert.doesNotMatch(wikiFromAdf(hostile), /\[~/);
  assertRoundTrip(hostile);
  // A mention inherits the marks around it that wiki markup can express.
  assert.equal(
    wikiFromAdf(doc(p({ ...mention({ text: '@Ann' }), marks: [strong] }))),
    '*@Ann*',
  );
  // The markdown builder's mention path lands here too.
  const md = adfFromMarkdown('ping @[Ann]', {
    mentions: new Map([['Ann', { id: '557058:abc', text: '@Ann Lee' }]]),
  });
  assert.equal(wikiFromAdf(md), 'ping @Ann Lee');
});

test('CC-329: a tagged Data Center mention is written [~username]; nothing else is', () => {
  const mention = (id: string, text: string, marks?: AdfNode[]): AdfNode => ({
    type: 'mention',
    attrs: { id, text },
    ...(marks === undefined ? {} : { marks }),
  });
  const source = doc(
    p(t('cc '), mention('jdoe', '@Jane Doe'), t(' and '), mention('ann', '@Ann')),
  );
  const before = JSON.stringify(source);
  const tagged = tagDataCenterMentions(source, new Set(['jdoe']));
  // Only the ids in the set; the input is not mutated, and the tag is invisible
  // to JSON, so a serialised copy carries no tag and stays literal.
  assert.equal(wikiFromAdf(tagged), 'cc [~jdoe] and @Ann');
  assert.equal(JSON.stringify(source), before);
  assert.equal(JSON.stringify(tagged), before);
  assert.equal(
    wikiFromAdf(JSON.parse(JSON.stringify(tagged)) as AdfNode),
    'cc @Jane Doe and @Ann',
  );
  assert.equal(wikiFromAdf(structuredClone(tagged)), 'cc @Jane Doe and @Ann');
  // The link reads back the way wiki.ts renders a user link.
  assert.equal(wikiToText('cc [~jdoe]'), 'cc @jdoe');
  // Marks wiki markup can wrap a link keep it; a code span or a link cannot
  // hold one, so the mention falls back to its literal text there.
  const marked = (marks: AdfNode[]): string =>
    wikiFromAdf(
      tagDataCenterMentions(
        doc(p(mention('jdoe', '@Jane Doe', marks))),
        new Set(['jdoe']),
      ),
    );
  assert.equal(marked([strong]), '*[~jdoe]*');
  assert.equal(marked([code]), '{{@Jane Doe}}');
  assert.match(
    marked([link('https://example.com/')]),
    /^\[@Jane Doe\|https:\/\/example\.com\/\]$/,
  );
  // Next to word characters the link is its own token, as Jira reads it.
  const glued = tagDataCenterMentions(
    doc(p(t('a'), mention('jdoe', '@J'), t('b'))),
    new Set(['jdoe']),
  );
  assert.equal(wikiFromAdf(glued), 'a[~jdoe]b');
  // Nested content is reached; depth is bounded like every other walk.
  const nested = doc({
    type: 'bulletList',
    content: [{ type: 'listItem', content: [p(mention('jdoe', '@J'))] }],
  });
  assert.equal(
    wikiFromAdf(tagDataCenterMentions(nested, new Set(['jdoe']))),
    '* [~jdoe]',
  );
  // The markdown builder's mentions, tagged, land here too.
  const md = adfFromMarkdown('ping @[Jane]', {
    mentions: new Map([['Jane', { id: 'jdoe', text: '@Jane Doe' }]]),
  });
  assert.equal(wikiFromAdf(md), 'ping @Jane Doe');
  assert.equal(wikiFromAdf(tagDataCenterMentions(md, new Set(['jdoe']))), 'ping [~jdoe]');
});

test('CC-324: a username that could gain wiki markup is never tagged or written', () => {
  for (const name of [
    'jdoe',
    'j.doe',
    'j_doe',
    'j-doe',
    'jdoe@corp.example',
    'j+doe',
    'Ülle',
    '1234',
  ]) {
    assert.equal(isWikiMentionUsername(name), true, name);
  }
  for (const name of [
    '',
    'j]doe',
    'j|doe',
    'j\ndoe',
    'j\rdoe',
    'j}doe',
    'j{doe',
    'j[doe',
    'j~doe',
    'j\\doe',
    'j doe',
    'j*doe',
    'x'.repeat(256),
  ]) {
    assert.equal(isWikiMentionUsername(name), false, JSON.stringify(name));
    assert.throws(
      () =>
        tagDataCenterMentions(
          doc(p({ type: 'mention', attrs: { id: name, text: '@x' } })),
          new Set([name]),
        ),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.equal(error.kind, 'validation');
        assert.match(error.remediation ?? '', /plain text/);
        return true;
      },
    );
  }
});

test('CC-287: anything outside the subset is a validation error naming it, never dropped', () => {
  validationError(
    () => wikiFromAdf(doc({ type: 'panel', content: [p(t('x'))] })),
    /"panel" node/,
  );
  validationError(
    () => wikiFromAdf(doc(p({ type: 'emoji', attrs: { shortName: ':x:' } }))),
    /"emoji" node/,
  );
  validationError(
    () => wikiFromAdf(doc(p(t('x', { type: 'underline' })))),
    /"underline" mark/,
  );
  validationError(
    () => wikiFromAdf(doc(p(t('x', { type: 'textColor', attrs: { color: '#f00' } })))),
    /"textColor" mark/,
  );
  validationError(() => wikiFromAdf(doc(t('bare text'))), /"text" node/);
  validationError(() => wikiFromAdf(p(t('x'))), /"paragraph" node as a whole document/);
  validationError(
    () => wikiFromAdf(doc({ type: 'bulletList', content: [p(t('x'))] })),
    /"paragraph" node directly inside a list/,
  );
  validationError(
    () =>
      wikiFromAdf(
        doc({
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'rule' }] }],
        }),
      ),
    /"rule" node inside a list item/,
  );
  validationError(
    () =>
      wikiFromAdf(doc({ type: 'codeBlock', content: [{ type: 'mention', attrs: {} }] })),
    /"mention" node inside a code block/,
  );
  validationError(
    () => wikiFromAdf(doc({ type: 'table', content: [p(t('x'))] })),
    /"paragraph" node directly inside a table/,
  );
  validationError(
    () =>
      wikiFromAdf(
        doc({ type: 'table', content: [{ type: 'tableRow', content: [p(t('x'))] }] }),
      ),
    /directly inside a table row/,
  );
  validationError(
    () =>
      wikiFromAdf(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [{ type: 'tableCell', content: [{ type: 'rule' }] }],
            },
          ],
        }),
      ),
    /"rule" node inside a table cell/,
  );
  validationError(
    () => wikiFromAdf(doc(p(t('x')), 'junk' as unknown as AdfNode)),
    /"\(untyped\)"/,
  );
  validationError(
    () => wikiFromAdf(doc(p(t('x', 'junk' as unknown as AdfNode)))),
    /"\(untyped\)" mark/,
  );
  validationError(
    () => wikiFromAdf(doc(p({ type: 'text', text: 'x', marks: 'strong' }))),
    /marks are not a list/,
  );
  // A hostile type name is sanitised and truncated before it reaches a message.
  validationError(
    () => wikiFromAdf(doc({ type: `evil\n"type"${'x'.repeat(100)}` })),
    /"evil\?\?type\?x{29}…" node/,
  );
  // Nesting past MAX_NODE_DEPTH (and so a cycle) is refused, not recursed.
  let deep: AdfNode = p(t('x'));
  for (let i = 0; i < 70; i += 1) deep = { type: 'blockquote', content: [deep] };
  validationError(() => wikiFromAdf(doc(deep)), /nests deeper than 64/);
  const cyclic: AdfNode = { type: 'blockquote', content: [] };
  (cyclic.content as AdfNode[]).push(cyclic);
  assert.throws(() => wikiFromAdf(doc(cyclic)), /nests deeper/);
});

test('CC-288: tables write || headers and | cells, with [ ] | inside a cell as references', () => {
  const cell = (type: string, ...content: AdfNode[]): AdfNode => ({ type, content });
  const adf = doc({
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [cell('tableHeader', p(t('a|b[c]'))), cell('tableHeader')],
      },
      {
        type: 'tableRow',
        content: [
          cell('tableCell', p(t('x', link('https://x.test/a|b')))),
          cell('tableCell', p(t('one')), p(t('two', strong))),
        ],
      },
    ],
  });
  assert.equal(
    wikiFromAdf(adf),
    '||a&#124;b&#91;c&#93;|| ||\n|[x|https://x.test/a%7Cb]|one\\\\*two*|',
  );
  assert.equal(wikiToText(wikiFromAdf(adf)), 'a|b[c] |\nx | one\ntwo');
  // An empty table and an empty row write nothing.
  assert.equal(wikiFromAdf(doc({ type: 'table', content: [{ type: 'tableRow' }] })), '');
});

test('CC-289: quotes do not nest, and an empty heading or quote writes nothing', () => {
  const adf = doc({
    type: 'blockquote',
    content: [p(t('outer')), { type: 'blockquote', content: [p(t('inner', strike))] }],
  });
  assert.equal(
    wikiFromAdf(adf),
    '{quote}\nouter\n\ninner\n{quote}'.replace('inner', '-inner-'),
  );
  assertRoundTrip(adf);
  assert.equal(
    wikiFromAdf(doc({ type: 'heading', attrs: { level: 3 }, content: [] }, p(t('x')))),
    'x',
  );
  assert.equal(wikiFromAdf(doc({ type: 'heading', content: [t('  ')] })), '');
  assert.equal(wikiFromAdf(doc({ type: 'blockquote', content: [] })), '');
  // The heading level is clamped the way adfToText reads it.
  assert.equal(
    wikiFromAdf(doc({ type: 'heading', attrs: { level: 9 }, content: [t('x')] })),
    'h6. x',
  );
  assert.equal(
    wikiFromAdf(doc({ type: 'heading', attrs: { level: 'x' }, content: [t('x')] })),
    'h1. x',
  );
  // A heading's hard break stays inside the heading.
  assert.equal(
    wikiFromAdf(
      doc({
        type: 'heading',
        attrs: { level: 1 },
        content: [t('a'), { type: 'hardBreak' }, t('b')],
      }),
    ),
    'h1. a\\\\b',
  );
});
