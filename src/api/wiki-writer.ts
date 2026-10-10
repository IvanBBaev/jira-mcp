// ---------------------------------------------------------------------------
// api/wiki-writer.ts — ADF rendered as Jira wiki markup (Phase 13, stage 13.4a,
// D106).
//
// Jira Data Center's REST v2 takes rich text as wiki markup where Cloud's v3
// takes ADF. The Cloud write builders already produce ADF (`adfFromMarkdown`,
// `toAdf`), so the Data Center write path (stage 13.4b) rewrites those
// documents here rather than parsing markdown a second time:
//
//   paragraph                → its lines, a hardBreak is a real newline
//   heading (level n)        → `hn. text`
//   bulletList / orderedList → `* item` / `# item`, depth by repeating (`*#`)
//   codeBlock                → `{code:lang}` … `{code}` (or `{noformat}`)
//   blockquote               → `{quote}` … `{quote}`
//   rule                     → `----`
//   table                    → `||h||h||` / `|c|c|`
//   strong em strike code    → `*x*` `_x_` `-x-` `{{x}}`
//   link                     → `[label|url]`
//   mention                  → its display text (`@Name`) as LITERAL text,
//                              unless the Data Center adapter resolved it
//                              (D112): then `[~username]`
//
// Escaping is the whole risk, so it is one rule applied to every text
// character (`encodeLine`): tenant text never gains markup.
//
//   * The metacharacters `* _ - + ^ ~ ? { } [ ] | !` are backslash-escaped,
//     which is Atlassian's documented escape.
//   * What a backslash cannot express becomes a numeric character reference:
//     a literal backslash (`\\` is a line break), a line-leading `#`, `h1.` or
//     `bq.`, an `&` that would start an entity, the `(` of an emoticon and the
//     character after `:` / `;` that would complete one, `[ ] |` inside a link
//     label or a table cell (where the token split happens before escapes),
//     and the line separators U+2028/U+2029. JIRA-API.md §Jira Data Center
//     records that Jira passing references through is UNVERIFIED.
//   * C0/C1 control characters other than tab and newline are dropped — no
//     XML-based renderer accepts them — and `\r\n` / `\r` become `\n`.
//   * Code block bodies are verbatim, as Jira renders them.
//
// A mark is written only where Jira's own boundary rule lets it render (no
// letter or digit on either side, no edge whitespace inside); elsewhere the
// text is kept and the mark dropped, never the other way round.
//
// A mention is written as `[~name]` ONLY when the node carries the
// {@link DATA_CENTER_MENTION} tag (D112), which nothing but
// {@link tagDataCenterMentions} sets. The tag is a symbol-keyed property, so no
// JSON input — a caller's raw ADF document, a `fields` value — can carry it:
// a mention the Data Center user search did not resolve, and every Cloud
// accountId, stays literal display text (CC-286). The tagged username is
// re-checked against {@link isWikiMentionUsername} when it is written, so it
// cannot close the link early or open markup (CC-324). Any node or mark
// outside the subset above is a `validation` error naming it — dropping
// content silently from a write is the one thing this must not do.
// ---------------------------------------------------------------------------

import { JiraError } from '../core/types.js';
import {
  adfFromMarkdown,
  MAX_NODE_DEPTH,
  renderMention,
  toAdf,
  unsafeHref,
  type AdfNode,
} from './adf.js';

/**
 * D112 — the tag the Data Center adapter puts on a mention node whose `attrs.id`
 * its user search resolved to a username. Symbol-keyed and module-private, so
 * a mention built from JSON can never carry it.
 */
const DATA_CENTER_MENTION = Symbol('jira-mcp.dataCenterMention');

/**
 * D112 — the usernames written as `[~name]`: letters, digits and `. _ - @ +`,
 * at most 255. Nothing in it can end the link (`]`), alias it (`|`), open a
 * macro or another link (`{ } [`), escape (`\`) or break the line. A Data
 * Center username outside this set is refused, never rewritten: a rewritten
 * username would mention somebody else.
 */
const WIKI_MENTION_USERNAME_RE = /^[\p{L}\p{N}._@+-]{1,255}$/u;

/** Whether `name` can be written as `[~name]` without gaining markup (D112). */
export function isWikiMentionUsername(name: string): boolean {
  return WIKI_MENTION_USERNAME_RE.test(name);
}

/**
 * D112 — a copy of `doc` in which every `mention` node whose `attrs.id` is one
 * of `usernames` carries the Data Center mention tag, so {@link wikiFromAdf}
 * writes it as `[~id]`. Called by the Data Center adapter on the document its
 * markdown parse built from a map its own user search produced; every other
 * node, and every mention whose id is not in the set, is returned as is. A
 * username that {@link isWikiMentionUsername} refuses is a `validation` error.
 */
export function tagDataCenterMentions(
  doc: AdfNode,
  usernames: ReadonlySet<string>,
): AdfNode {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > MAX_NODE_DEPTH || !isRecord(value)) return value;
    const node = value as AdfNode;
    if (node.type === 'mention') {
      const id = node.attrs?.id;
      if (typeof id !== 'string' || !usernames.has(id)) return node;
      if (!isWikiMentionUsername(id)) throw unsafeUsername();
      return { ...node, [DATA_CENTER_MENTION]: id };
    }
    if (!Array.isArray(node.content)) return node;
    return {
      ...node,
      content: (node.content as readonly unknown[]).map((child) =>
        walk(child, depth + 1),
      ),
    };
  };
  return walk(doc, 0) as AdfNode;
}

function unsafeUsername(): JiraError {
  return new JiraError({
    kind: 'validation',
    message:
      'A mention resolved to a Jira Data Center username that cannot be written as wiki markup safely (it holds a character outside letters, digits and . _ - @ +).',
    remediation: 'Write the name as plain text instead of an @[...] mention.',
  });
}

/** The tagged username of a mention node, or `undefined` for any other. */
function taggedUsername(node: AdfNode): string | undefined {
  const tag = (node as unknown as Record<symbol, unknown>)[DATA_CENTER_MENTION];
  return typeof tag === 'string' ? tag : undefined;
}

/** The language names `{code:lang}` carries; anything else gets plain `{code}`. */
const LANGUAGE_RE = /^[\w+#.-]{1,32}$/;

/** Breaks a closing tag inside a code body that holds both closers. */
const ZWSP = '\u200B';

/** Backslash-escaped wherever they appear in text. */
const META = new Set(['*', '_', '-', '+', '^', '~', '?', '{', '}', '[', ']', '|', '!']);

/** Written as references inside a link label or a table cell. */
const BRACKETED = new Set(['[', ']', '|']);

/** Characters that are never passed through as themselves. */
const ALWAYS_REFERENCED = new Set(['\\', '\uE000', '\uE001', '\u2028', '\u2029']);

/** Dropped: C0 except tab and newline, DEL and C1. `\r` is normalised first. */
// eslint-disable-next-line no-control-regex -- removing them is the point
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** `&…;` that Jira's renderer would read as a character reference. */
const ENTITY_LIKE_RE = /^&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

/** The parenthesised emoticons (`(y)`, `(!)`, `(on)`, `(*r)`, …). */
const PAREN_EMOTICON_RE = /^\((?:[ynix/!+?*-]|\*[rgby]|on|off|flag|flagoff)\)/i;

/**
 * A macro name that, after the second `{` of `{{`, would close into a tag:
 * `{name}` (the inner text ends there) or `{name:…}` / `{name\}`.
 */
const MACRO_NAME_RE =
  /^(?:quote|color|code|noformat|panel|anchor|info|note|tip|warning)(?:$|:|\\\})/i;

/** A line-leading block tag: `h1.` … `h6.` and `bq.`. */
const BLOCK_TAG_RE = /^(?:h[1-6]|bq)\./i;

/** The inline marks, outermost first. `link` is handled as the outermost. */
const MARK_LEVELS = ['link', 'strong', 'em', 'strike', 'code'] as const;
type MarkLevel = (typeof MARK_LEVELS)[number];

const MARK_DELIMITERS: Readonly<Record<Exclude<MarkLevel, 'link'>, [string, string]>> = {
  strong: ['*', '*'],
  em: ['_', '_'],
  strike: ['-', '-'],
  code: ['{{', '}}'],
};

/** One text character with the marks it carries. */
interface Atom {
  readonly ch: string;
  readonly strong: boolean;
  readonly em: boolean;
  readonly strike: boolean;
  readonly code: boolean;
  /** A safe link target, or `''` for none. */
  readonly href: string;
  /** Written verbatim in place of `ch`: a resolved `[~username]` (D112). */
  readonly raw?: string;
}

type Line = readonly Atom[];

interface Ctx {
  readonly depth: number;
  /** Inside a table cell: `[ ] |` are references everywhere. */
  readonly cell: boolean;
  /** Inside a `{quote}`: a nested quote renders its children only. */
  readonly quoted: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const SUBSET =
  'paragraphs, headings, bullet and numbered lists, code blocks, quotes, rules, ' +
  'tables, mentions, and text with the strong, em, strike, code and link marks';

function label(type: unknown): string {
  if (typeof type !== 'string' || type.trim() === '') return '(untyped)';
  const oneLine = type.replace(/[^\w.:-]/g, '?');
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

function unsupported(what: string, where?: string): JiraError {
  return new JiraError({
    kind: 'validation',
    message: `Jira Data Center wiki markup cannot express ${what}${where === undefined ? '' : ` ${where}`}.`,
    remediation: `Rewrite the content using only ${SUBSET}.`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function children(node: AdfNode): readonly unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

function asNode(value: unknown, ctx: Ctx): AdfNode {
  if (ctx.depth > MAX_NODE_DEPTH) {
    throw new JiraError({
      kind: 'validation',
      message: `The document nests deeper than ${String(MAX_NODE_DEPTH)} levels.`,
      remediation: 'Flatten the structure before writing it.',
    });
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw unsupported(
      `a node of type "${label(isRecord(value) ? value.type : undefined)}"`,
    );
  }
  return value as AdfNode;
}

function deeper(ctx: Ctx): Ctx {
  return { ...ctx, depth: ctx.depth + 1 };
}

// ---------------------------------------------------------------------------
// Inline: nodes → lines of atoms → escaped, marked text
// ---------------------------------------------------------------------------

function normalise(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
}

interface MarkSet {
  strong: boolean;
  em: boolean;
  strike: boolean;
  code: boolean;
  href: string;
}

function readMarks(node: AdfNode): MarkSet {
  const set: MarkSet = { strong: false, em: false, strike: false, code: false, href: '' };
  const raw = node.marks;
  if (raw === undefined) return set;
  if (!Array.isArray(raw)) throw unsupported('a text node whose marks are not a list');
  for (const mark of raw as readonly unknown[]) {
    const type = isRecord(mark) ? mark.type : undefined;
    switch (type) {
      case 'strong':
      case 'em':
      case 'strike':
      case 'code':
        set[type] = true;
        break;
      case 'link': {
        const attrs = isRecord(mark) && isRecord(mark.attrs) ? mark.attrs : {};
        const href = typeof attrs.href === 'string' ? normalise(attrs.href).trim() : '';
        // CC-153's rule, re-checked: an unsafe scheme keeps its text, not its link.
        set.href = href === '' || unsafeHref(href) ? '' : href;
        break;
      }
      default:
        throw unsupported(`the "${label(type)}" mark`);
    }
  }
  return set;
}

/** Inline content split into lines at every hardBreak and newline. */
function inlineLines(nodes: readonly unknown[], ctx: Ctx): Atom[][] {
  const lines: Atom[][] = [[]];
  const push = (text: string, marks: MarkSet): void => {
    for (const ch of normalise(text)) {
      if (ch === '\n') lines.push([]);
      else lines[lines.length - 1]?.push({ ch, ...marks });
    }
  };
  for (const value of nodes) {
    const node = asNode(value, ctx);
    switch (node.type) {
      case 'text':
        push(typeof node.text === 'string' ? node.text : '', readMarks(node));
        break;
      case 'mention': {
        const marks = readMarks(node);
        const username = taggedUsername(node);
        if (username === undefined || marks.code || marks.href !== '') {
          // Unresolved, a Cloud accountId, or inside a span that cannot hold a
          // link: literal display text (CC-286).
          push(renderMention(node), marks);
        } else {
          if (!isWikiMentionUsername(username)) throw unsafeUsername();
          // One atom: `@` stands in for the boundary checks, which see a
          // non-word character exactly as Jira sees the `[`.
          lines[lines.length - 1]?.push({ ch: '@', ...marks, raw: `[~${username}]` });
        }
        break;
      }
      case 'hardBreak':
        lines.push([]);
        break;
      default:
        throw unsupported(`a "${label(node.type)}" node`, 'inside a line of text');
    }
  }
  return lines;
}

function referenceOf(ch: string): string {
  return `&#${String(ch.codePointAt(0) ?? 0)};`;
}

/**
 * Every character of a line in its written form (inside a table cell when
 * `cell`). Left to right, because the
 * rule for `)` depends on what the previous character became.
 */
function encodeLine(line: Line, cell: boolean): string[] {
  const chars = line.map((atom) => atom.ch);
  const firstText = chars.findIndex((ch) => !/\s/.test(ch));
  const out: string[] = [];
  for (let k = 0; k < chars.length; k += 1) {
    const ch = chars[k] ?? '';
    const prev = k > 0 ? chars[k - 1] : undefined;
    const prevOut = k > 0 ? (out[k - 1] ?? '') : '';
    const ahead = (): string => chars.slice(k, k + 10).join('');
    const raw = line[k]?.raw;
    let written: string;
    if (raw !== undefined) written = raw;
    else if (ALWAYS_REFERENCED.has(ch)) written = referenceOf(ch);
    else if (k === firstText && (ch === '#' || BLOCK_TAG_RE.test(ahead())))
      written = referenceOf(ch);
    // Wider than `ahead()`: the longest HTML5 entity name is 31 letters (CC-402).
    else if (ch === '&' && ENTITY_LIKE_RE.test(chars.slice(k, k + 40).join('')))
      written = referenceOf(ch);
    else if (ch === '(' && PAREN_EMOTICON_RE.test(ahead())) written = referenceOf(ch);
    else if (prev === ':' && /^[()PpDd]$/.test(ch)) written = referenceOf(ch);
    // `;)` is an emoticon, and so is the `;` that ends a reference before `)`.
    else if (ch === ')' && (prev === ';' || prevOut.endsWith(';')))
      written = referenceOf(ch);
    // A link label or a table cell is split out before escapes are read.
    else if ((cell || line[k]?.href !== '') && BRACKETED.has(ch))
      written = referenceOf(ch);
    else if (META.has(ch)) written = `\\${ch}`;
    else written = ch;
    out.push(written);
  }
  return out;
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function keyOf(atom: Atom, level: number): string {
  const mark = MARK_LEVELS[level];
  if (mark === 'link') return atom.href;
  return mark !== undefined && atom[mark] ? '1' : '';
}

/**
 * Render atoms `[from, to)` of a line from mark level `level` inward: split
 * into maximal runs that agree on this level's mark, wrap the marked runs.
 */
function renderRange(
  line: Line,
  enc: readonly string[],
  from: number,
  to: number,
  level: number,
): string {
  if (level >= MARK_LEVELS.length) return enc.slice(from, to).join('');
  let out = '';
  let start = from;
  while (start < to) {
    const atom = line[start];
    if (atom === undefined) break;
    const key = keyOf(atom, level);
    let end = start + 1;
    while (end < to) {
      const next = line[end];
      if (next === undefined || keyOf(next, level) !== key) break;
      end += 1;
    }
    out +=
      key === ''
        ? renderRange(line, enc, start, end, level + 1)
        : wrapRun(line, enc, start, end, level, key);
    start = end;
  }
  return out;
}

function wrapRun(
  line: Line,
  enc: readonly string[],
  from: number,
  to: number,
  level: number,
  key: string,
): string {
  const plain = (): string => renderRange(line, enc, from, to, level + 1);
  // Edge whitespace goes outside the mark: `* x *` does not render.
  let start = from;
  let end = to;
  while (start < end && isSpace(line[start]?.ch)) start += 1;
  while (end > start && isSpace(line[end - 1]?.ch)) end -= 1;
  if (start === end) return plain();

  const mark = MARK_LEVELS[level] ?? 'code';
  if (mark !== 'link' && mark !== 'code') {
    // Jira renders `*x*` only with no letter or digit outside it; the same
    // mark on the far side of a link boundary would abut it, too, unless
    // whitespace separates them.
    const abuts = (atom: Atom | undefined): boolean =>
      atom !== undefined && (isWordChar(atom.ch) || (atom[mark] && !isSpace(atom.ch)));
    if (abuts(line[start - 1]) || abuts(line[end])) {
      return plain();
    }
  }

  const inner = renderRange(line, enc, start, end, level + 1);
  const wrapped =
    mark === 'link'
      ? `[${inner}|${encodeUrl(key)}]`
      : mark === 'code'
        ? // The second `{` of `{{` is the one bare `{` the writer emits, and a
          // letter after it would spell a macro tag — `{{quote}}` holds
          // `{quote}`. Referencing its first letter breaks the tag (CC-401).
          `{{${MACRO_NAME_RE.test(inner) ? inner.replace(/^./, referenceOf) : inner}}}`
        : `${MARK_DELIMITERS[mark][0]}${inner}${MARK_DELIMITERS[mark][1]}`;
  return (
    renderRange(line, enc, from, start, level + 1) +
    wrapped +
    renderRange(line, enc, end, to, level + 1)
  );
}

/** Percent-encode what would end or re-tokenise `[label|url]`. */
function encodeUrl(href: string): string {
  let out = '';
  for (const ch of href) {
    if (/[[\]|{}!\\"<>]/.test(ch) || /\s/.test(ch) || (out === '' && /[~^]/.test(ch))) {
      out +=
        ch === '!' || ch === '~'
          ? `%${ch === '!' ? '21' : '7E'}`
          : encodeURIComponent(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

function renderLine(line: Line, ctx: Ctx): string {
  const enc = encodeLine(line, ctx.cell);
  return renderRange(line, enc, 0, line.length, 0);
}

function renderInline(nodes: readonly unknown[], ctx: Ctx): string[] {
  return inlineLines(nodes, ctx).map((line) => renderLine(line, ctx));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function codeBody(node: AdfNode, ctx: Ctx): string {
  let body = '';
  for (const value of children(node)) {
    const child = asNode(value, deeper(ctx));
    if (child.type === 'text') body += typeof child.text === 'string' ? child.text : '';
    else if (child.type === 'hardBreak') body += '\n';
    else throw unsupported(`a "${label(child.type)}" node`, 'inside a code block');
  }
  return normalise(body);
}

function codeLanguage(node: AdfNode): string {
  const raw = node.attrs?.language;
  return typeof raw === 'string' && LANGUAGE_RE.test(raw) ? raw : '';
}

/**
 * `{code}` unless the body would close it early; then `{noformat}`; a body
 * that holds both closers gets a zero-width space after each `{` of a closer.
 * Inside a `{quote}` the body's own `{quote}` gets the same space: whether
 * Jira's renderer lets a code macro shield the outer quote's closer has never
 * been seen on a host, so the writer does not rely on it (CC-398).
 */
function renderCodeBlock(node: AdfNode, ctx: Ctx): string {
  const raw = codeBody(node, ctx);
  const body = ctx.quoted ? raw.replace(/\{(quote)\}/gi, `{${ZWSP}$1}`) : raw;
  const language = codeLanguage(node);
  const hasCode = /\{code\}/i.test(body);
  if (!hasCode) return `{code${language === '' ? '' : `:${language}`}}\n${body}\n{code}`;
  if (!/\{noformat\}/i.test(body)) return `{noformat}\n${body}\n{noformat}`;
  const broken = body.replace(/\{(code|noformat)\}/gi, `{${ZWSP}$1}`);
  return `{noformat}\n${broken}\n{noformat}`;
}

/** A code block inside a list item: one `{{…}}` span per non-blank line. */
function codeAsSpans(node: AdfNode, ctx: Ctx): string[] {
  const body = codeBody(node, ctx);
  const plain: Omit<Atom, 'ch'> = {
    strong: false,
    em: false,
    strike: false,
    code: true,
    href: '',
  };
  return body
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .map((text) =>
      renderLine(
        Array.from(text, (ch) => ({ ch, ...plain })),
        ctx,
      ),
    );
}

function headingLevel(node: AdfNode): number {
  const raw = node.attrs?.level;
  const level = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 1;
  return Math.min(Math.max(level, 1), 6);
}

/** Inline blocks flattened onto one wiki line, joined by `\\`. */
function oneLine(parts: readonly string[]): string {
  return parts.join('\\\\');
}

function renderList(node: AdfNode, prefix: string, ctx: Ctx): string[] {
  const marker = prefix + (node.type === 'orderedList' ? '#' : '*');
  const out: string[] = [];
  for (const value of children(node)) {
    const item = asNode(value, deeper(ctx));
    if (item.type !== 'listItem') {
      throw unsupported(`a "${label(item.type)}" node`, 'directly inside a list');
    }
    out.push(...renderListItem(item, marker, deeper(ctx)));
  }
  return out;
}

/**
 * One list item. Its text blocks share one line (`\\` between them); a nested
 * list follows on its own lines; text after a nested list opens a new item at
 * this depth, since wiki markup cannot continue an item after a sub-list.
 */
function renderListItem(item: AdfNode, marker: string, ctx: Ctx): string[] {
  const out: string[] = [];
  let parts: string[] = [];
  let open = false;
  const flush = (force: boolean): void => {
    if (parts.length > 0 || (force && !open)) out.push(`${marker} ${oneLine(parts)}`);
    if (parts.length > 0 || force) open = true;
    parts = [];
  };
  for (const value of children(item)) {
    const child = asNode(value, deeper(ctx));
    switch (child.type) {
      case 'paragraph':
        parts.push(...renderInline(children(child), deeper(ctx)));
        break;
      case 'codeBlock':
        parts.push(...codeAsSpans(child, deeper(ctx)));
        break;
      case 'bulletList':
      case 'orderedList':
        flush(true);
        out.push(...renderList(child, marker, deeper(ctx)));
        break;
      default:
        throw unsupported(`a "${label(child.type)}" node`, 'inside a list item');
    }
  }
  flush(!open);
  return out;
}

function renderCell(cell: AdfNode, ctx: Ctx): string {
  const parts: string[] = [];
  for (const value of children(cell)) {
    const child = asNode(value, deeper(ctx));
    if (child.type === 'paragraph' || child.type === 'heading') {
      parts.push(...renderInline(children(child), deeper(ctx)));
    } else {
      throw unsupported(`a "${label(child.type)}" node`, 'inside a table cell');
    }
  }
  const text = oneLine(parts);
  return text.trim() === '' ? ' ' : text;
}

function renderTable(node: AdfNode, ctx: Ctx): string {
  const cellCtx: Ctx = { ...deeper(ctx), cell: true };
  const rows: string[] = [];
  for (const value of children(node)) {
    const row = asNode(value, deeper(ctx));
    if (row.type !== 'tableRow') {
      throw unsupported(`a "${label(row.type)}" node`, 'directly inside a table');
    }
    let line = '';
    let last = '|';
    for (const cellValue of children(row)) {
      const cell = asNode(cellValue, cellCtx);
      if (cell.type !== 'tableHeader' && cell.type !== 'tableCell') {
        throw unsupported(`a "${label(cell.type)}" node`, 'directly inside a table row');
      }
      last = cell.type === 'tableHeader' ? '||' : '|';
      line += `${last}${renderCell(cell, cellCtx)}`;
    }
    if (line !== '') rows.push(`${line}${last}`);
  }
  return rows.join('\n');
}

/** One block → its wiki text, `''` when it has nothing to say. */
function renderBlock(value: unknown, ctx: Ctx): string {
  const node = asNode(value, ctx);
  const inner = deeper(ctx);
  switch (node.type) {
    case 'paragraph':
      return renderInline(children(node), inner).join('\n');
    case 'heading': {
      const text = oneLine(renderInline(children(node), inner));
      // `h2.` with nothing after it is not a heading to Jira: it is text.
      return text.trim() === '' ? '' : `h${String(headingLevel(node))}. ${text}`;
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(node, '', inner).join('\n');
    case 'codeBlock':
      return renderCodeBlock(node, inner);
    case 'blockquote': {
      // `{quote}` does not nest: an inner quote opening would close the outer.
      const body = renderBlocks(children(node), { ...inner, quoted: true });
      if (ctx.quoted) return body;
      return body === '' ? '' : `{quote}\n${body}\n{quote}`;
    }
    case 'rule':
      return '----';
    case 'table':
      return renderTable(node, inner);
    default:
      throw unsupported(`a "${label(node.type)}" node`);
  }
}

function renderBlocks(nodes: readonly unknown[], ctx: Ctx): string {
  return nodes
    .map((node) => renderBlock(node, ctx))
    .filter((block) => block !== '')
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render an ADF document as Jira wiki markup (the Data Center v2 body format).
 *
 * Covers what `adfFromMarkdown` and `toAdf` build, plus `blockquote`, `rule`,
 * `strike` and `table`. Tenant text is escaped so that it never gains markup,
 * and `wikiToText(wikiFromAdf(doc))` reads back as `adfToText(doc)` up to the
 * conventions in `wiki-writer.test.ts` (CC-278). Pure; throws a `validation`
 * `JiraError` naming the node or mark for anything outside the subset, and
 * for a root that is not a `doc`.
 */
export function wikiFromAdf(doc: AdfNode): string {
  const ctx: Ctx = { depth: 0, cell: false, quoted: false };
  const root = asNode(doc, ctx);
  if (root.type !== 'doc') {
    throw unsupported(`a "${label(root.type)}" node`, 'as a whole document');
  }
  return renderBlocks(children(root), deeper(ctx));
}

/** Markdown (the tools' `adfFromMarkdown` subset) → wiki markup, via ADF. */
export function wikiFromMarkdown(md: string): string {
  return wikiFromAdf(adfFromMarkdown(md));
}

/** Plain text → wiki markup: every character literal, paragraphs kept. */
export function wikiFromText(text: string): string {
  return wikiFromAdf(toAdf(text));
}
