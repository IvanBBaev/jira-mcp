// ---------------------------------------------------------------------------
// api/wiki.test.ts — Jira wiki markup → plain text, in `adfToText`'s
// conventions (D106, stage 13.3b).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { MAX_INLINE_LINE_CHARS, wikiToText } from './wiki.js';

test('CC-271: block markup renders in the adfToText conventions', () => {
  const cases: readonly [string, string][] = [
    ['h1. Title\nh6. Small', 'Title\nSmall'],
    ['* one\n** nested\n* two', '- one\n  - nested\n- two'],
    ['- dash item', '- dash item'],
    ['# first\n# second\n#* sub\n# third', '1. first\n2. second\n  - sub\n3. third'],
    ['* bullet\n# number', '- bullet\n1. number'],
    ['# one\n\n# restarts', '1. one\n1. restarts'],
    ['||H1||H2||\n|a|b|', 'H1 | H2\na | b'],
    ['|[a link|https://a.io]|[~jdoe]|', 'a link | @jdoe'],
    ['bq. quoted', 'quoted'],
    ['{quote}\nsaid this\n{quote}', 'said this'],
    ['{code:java}\nint x = *1*;\n{code}', '```java\nint x = *1*;\n```'],
    ['{code:language=js|title=x}a{code}', '```js\na\n```'],
    ['{noformat}\n_raw_ [x|y]\n{noformat}', '```\n_raw_ [x|y]\n```'],
    ['{info}\nCareful\n{info}', '[panel:info]\nCareful'],
    ['{panel:title=T}\nIn a panel\n{panel}', '[panel]\nIn a panel'],
    [
      '{warning}\na\n{warning}\n{warning}\nb\n{warning}',
      '[panel:warning]\na\n[panel:warning]\nb',
    ],
    ['----', '---'],
    ['para one\n\n\npara two', 'para one\npara two'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(wikiToText(input), expected, JSON.stringify(input));
  }
});

test('CC-271: inline markup renders in the adfToText conventions', () => {
  const cases: readonly [string, string][] = [
    [
      '*bold* _italic_ -strike- +under+ ^sup^ ~sub~ ??cite??',
      'bold italic strike under sup sub cite',
    ],
    ['{{monospace}} text', 'monospace text'],
    ['see [the docs|https://x.io/a|tip]', 'see the docs'],
    ['see [https://x.io]', 'see https://x.io'],
    ['ping [~jdoe] and [~JIRAUSER1]', 'ping @jdoe and @JIRAUSER1'],
    ['file [^report.pdf]', 'file report.pdf'],
    [
      '!screen shot.png|thumbnail! and !https://x.io/a.gif!',
      '[media: screen shot.png] and [media: https://x.io/a.gif]',
    ],
    ['{color:red}red{color} text', 'red text'],
    ['line one\\\\line two', 'line one\nline two'],
    ['\\*not bold\\* and \\[x\\]', '*not bold* and [x]'],
    ['*bold with _italic_ inside*', 'bold with italic inside'],
    ['(*bold*), [_it_]', '(bold), [it]'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(wikiToText(input), expected, JSON.stringify(input));
  }
});

test('CC-272: text that only looks like markup is left alone', () => {
  for (const text of [
    'released on 2026-09-26',
    'a*b*c and x_y_z',
    'x - y - z',
    '5 * 3 = 15 and 2 * 4',
    'Wow!Great! Really!',
    'what?? ok??',
    'snake_case_name and CONST_VALUE',
    '[not a link]',
    '{unknownmacro}kept{unknownmacro}',
    'e-mail and re-run',
  ]) {
    assert.equal(wikiToText(text), text, text);
  }
});

test('CC-272: a non-string is empty, as adfToText makes it', () => {
  for (const value of [undefined, null, 42, { type: 'doc' }, ['x']]) {
    assert.equal(wikiToText(value), '');
  }
});

test('CC-273: an unclosed code block keeps its content', () => {
  assert.equal(wikiToText('{code}\nline 1\n*line 2*'), '```\nline 1\n*line 2*\n```');
});

test('CC-273: a line past the inline cap passes verbatim instead of being scanned', () => {
  const long = `*${'a'.repeat(MAX_INLINE_LINE_CHARS)}*`;
  assert.equal(wikiToText(long), long);
});

test('CC-273: text carrying the private-use sentinel characters is not rewritten', () => {
  const text = 'odd 0 and \\* and  here';
  assert.equal(wikiToText(text), text);
});

test('CC-273: never throws on arbitrary input, markup-dense or not', () => {
  fc.assert(
    fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (input) => {
      const out = wikiToText(input);
      assert.equal(typeof out, 'string');
    }),
    { numRuns: 400 },
  );
  const alphabet = fc.constantFrom(...'*_-+^~?{}[]|!\\#h1. \nab'.split(''));
  fc.assert(
    fc.property(fc.array(alphabet, { maxLength: 300 }), (chars) => {
      const out = wikiToText(chars.join(''));
      assert.equal(typeof out, 'string');
    }),
    { numRuns: 600 },
  );
});
