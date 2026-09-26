// Atlassian Document Format (ADF) primitives — the api ring's rich-text seam.
//
// Jira Cloud's `/rest/api/3` represents rich-text fields (`description`,
// `environment`, comment and worklog bodies) as an ADF JSON tree, never a
// string (JIRA-API.md §ADF). This module owns the two directions:
//
//   read  — `adfToText(node)` flattens a tree to readable plain text; it is the
//           DEFAULT path for every content-bearing read, because `raw: true`
//           exists on `jira_get_issue` alone (TOOLS.md §Read shaping);
//   write — `adfFromText(text)` builds a minimal, version-pinned document from
//           plain text, and `toAdf(body)` accepts either direction from a tool.
//
// Ported from servicenow-mcp (`src/api/jira/shared.ts` + `test/jira-adf.test.js`)
// with the deltas JIRA-API.md §ADF makes mandatory — the donor never saw
// `table`, `codeBlock`, `panel`, `media`, `taskList`, `emoji`, `status` or
// `date`, and silently dropped every one of them. Each delta is a named test in
// `adf.test.ts`.
//
// Two invariants hold for the whole module:
//   * `adfToText` NEVER throws. Wire data is `unknown`; a new Atlassian node
//     type, a malformed attrs bag, a cycle or a pathological nesting depth all
//     degrade to text (CC-06, CC-09). A thrown parser is an outage.
//   * No URL is ever synthesised for attachments. `media` renders a filename or
//     id placeholder, never the media URL — v1 fetches no attachments, and an
//     unfetchable signed URL in a model's context is a liability, not data.

import { JiraError } from '../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A minimal ADF node. The real schema is far larger; we read a subset and emit
 * a smaller one, so unknown keys are tolerated rather than modelled.
 */
export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A whole ADF document. Jira accepts `version: 1` only (JIRA-API.md §ADF). */
export interface AdfDoc extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

// ---------------------------------------------------------------------------
// Caps (CC-09) — the guard against pathological trees
// ---------------------------------------------------------------------------

/**
 * Hard recursion cap. ADF from a human tops out around a dozen levels; anything
 * past this is either a generated document or an attack on the stack, and a
 * `RangeError` from a blown stack would take the whole tool call with it.
 * Reaching the cap emits {@link DEPTH_LIMIT_MARKER} and stops descending, so a
 * deep tree degrades gracefully instead of failing. This also terminates a
 * cyclic tree, which no shape check can rule out on wire data.
 */
export const MAX_NODE_DEPTH = 64;

/**
 * Indentation cap for nested lists. Past six levels the leading whitespace
 * stops growing: further nesting still renders, it just shares the sixth
 * level's indent. Unbounded indentation eats the result budget (CC-25) for a
 * distinction no reader makes.
 */
export const MAX_LIST_INDENT_DEPTH = 6;

/** What a subtree past {@link MAX_NODE_DEPTH} collapses to. */
export const DEPTH_LIMIT_MARKER = '[…]';

/** Two spaces per list level, per JIRA-API.md §ADF. */
const LIST_INDENT_UNIT = '  ';

/** Longest node-type name echoed into an unknown-node placeholder. */
const MAX_TYPE_LABEL = 40;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string attribute, or `undefined`. Empty strings count as absent. */
function attrString(node: AdfNode, key: string): string | undefined {
  const value = node.attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Collapse a flattened subtree to a single line — used for table cells. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Node type as a string, tolerating a node that has none. */
function nodeType(value: unknown): string {
  return isRecord(value) && typeof value.type === 'string' ? value.type : '';
}

/** A node-type name safe to echo into a placeholder (bounded, single-line). */
function typeLabel(type: string): string {
  const oneLine = type.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return 'unknown';
  return oneLine.length > MAX_TYPE_LABEL
    ? `${oneLine.slice(0, MAX_TYPE_LABEL)}…`
    : oneLine;
}

/** Recursion state: node depth for the cap, list depth for indentation. */
interface FlattenState {
  readonly depth: number;
  readonly listDepth: number;
  /** `true` renders the markdown subset; `false` is the plain-text path. */
  readonly markdown: boolean;
  /** Inside a table cell, which renders as one line with no block markup. */
  readonly cell?: boolean;
}

function deeper(state: FlattenState): FlattenState {
  return { ...state, depth: state.depth + 1 };
}

function listIndent(listDepth: number): string {
  const levels = Math.min(Math.max(listDepth - 1, 0), MAX_LIST_INDENT_DEPTH);
  return LIST_INDENT_UNIT.repeat(levels);
}

// ---------------------------------------------------------------------------
// Markdown dialect
//
// `adfToMarkdown` is `adfToText` with five differences and no others: headings
// take their `#` prefix, `strong`/`em`/`code`/`link` marks become markup, text
// is escaped so it cannot be re-read as markup, code fences widen around
// embedded backticks, and paragraphs (plus top-level lists) are separated by a
// blank line — without it markdown would fuse them. EVERYTHING else — tables,
// panels, media, task lists, mentions, cards, unknown nodes, the depth caps —
// renders exactly as the text path renders it (CC-06, CC-07, CC-09 parity),
// because a converter with two sets of degradation rules has two sets of bugs.
//
// The emitted dialect is deliberately narrow: `**bold**`, `*italic*`, backtick
// code spans, `[text](href)`, ATX headings, `-` bullets, `N.` ordered markers,
// fenced code. `_` is never emphasis on output (so `customfield_10020` survives
// unescaped) and the parser accepts nothing this renderer does not emit, with
// one deliberate exception: `@[name]` mention tokens (D100). The renderer never
// produces that bracketed form — mentions render as `@Display Name` (CC-110) —
// so read output fed back to the write path cannot re-resolve.
// ---------------------------------------------------------------------------

/** Deepest heading markdown can express; ADF levels are clamped into 1..6. */
const MAX_HEADING_LEVEL = 6;

/**
 * Schemes a `link` mark may keep as real `[text](href)` markup. Anything else —
 * `javascript:`, `data:`, a scheme Atlassian adds next year — renders as its
 * label text alone. THREAT-MODEL.md notes that the text path cannot smuggle
 * markdown links out of tenant content; the markdown path can, so the payload a
 * client would auto-render is restricted to the schemes a browser was going to
 * open anyway.
 */
const SAFE_LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;

/**
 * Characters that would be re-read as inline markup if left bare. `]` is here
 * for the same reason `[` is: a bare `]` inside a link label would close it
 * early and turn the whole link back into literal text.
 */
const MARKDOWN_SPECIALS = new Set(['\\', '`', '*', '[', ']']);

function escapeMarkdown(text: string): string {
  let out = '';
  for (const ch of text) out += MARKDOWN_SPECIALS.has(ch) ? `\\${ch}` : ch;
  return out;
}

/** An attr string as the current path renders it: escaped only for markdown. */
function literal(text: string, state: { readonly markdown: boolean }): string {
  return state.markdown ? escapeMarkdown(text) : text;
}

/** Length of the longest run of backticks in a string; 0 when there is none. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * A code span whose fence is always longer than any backtick run inside it, and
 * which pads by one space when the content starts or ends with a backtick or a
 * space — the pair of rules that makes `` ` `` and leading spaces survive a
 * round trip through a CommonMark reader.
 *
 * All-whitespace content takes no padding: a reader strips the pair of spaces
 * only when what is left is not itself all whitespace, so padding `'  '` would
 * hand back `'   '` — one space wider on every pass through the converter.
 */
function inlineCode(text: string): string {
  const fence = '`'.repeat(longestBacktickRun(text) + 1);
  const pad = text.trim() !== '' && /^[`\s]|[`\s]$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A link target safe to emit as markup, or `undefined` to drop the markup. */
function markdownHref(href: string): string | undefined {
  const clean = href.replace(/\s+/g, ' ').trim();
  if (!SAFE_LINK_SCHEME.test(clean)) return undefined;
  // Spaces and parentheses need the angle-bracket form; `<`/`>` cannot appear
  // inside it, and a URL containing them was already malformed. So does a
  // backtick: the bare form's closer scan steps over code spans, and one opened
  // in the href would swallow the `)` (CC-226).
  return /[\s()<>`]/.test(clean) ? `<${clean.replace(/[<>]/g, '')}>` : clean;
}

/**
 * Wrap a text node's content in the markup for the marks it carries. Order is
 * innermost-first — code, then em, then strong, then link — so the result parses
 * back to the same mark set. Marks outside the subset (strike, underline,
 * textColor, subsup) are dropped exactly as the text path drops them.
 *
 * Each line is marked on its own (CC-227): the reader parses one line at a
 * time, so `**a\nb**` came back as literal stars, and a code span across a
 * line break had a block-start escape planted inside it.
 */
function applyMarks(text: string, node: AdfNode): string {
  if (text === '') return '';
  const marks: unknown[] = Array.isArray(node.marks) ? node.marks : [];

  let code = false;
  let strong = false;
  let em = false;
  let href: string | undefined;
  for (const mark of marks) {
    if (!isRecord(mark)) continue;
    if (mark.type === 'code') code = true;
    else if (mark.type === 'strong') strong = true;
    else if (mark.type === 'em') em = true;
    else if (mark.type === 'link') {
      const target = isRecord(mark.attrs) ? mark.attrs.href : undefined;
      if (typeof target === 'string') href = markdownHref(target) ?? href;
    }
  }

  return text
    .split('\n')
    .map((line) => {
      if (line === '') return '';
      // CC-222: emphasis delimiters go inside the whitespace, never around it.
      // A `**` with a space on its inner side is literal to the reader (CC-191),
      // so `**Note: **rest` came back as a stray star and the wrong italics.
      // Whitespace alone takes no emphasis at all. Code keeps its spaces: the
      // span pads for them itself.
      const edges = !code && (strong || em) ? /^(\s*)(.*?)(\s*)$/s.exec(line) : null;
      const lead = edges?.[1] ?? '';
      const core = edges?.[2] ?? line;
      const trail = edges?.[3] ?? '';

      let out = code ? inlineCode(core) : escapeMarkdown(core);
      if (core !== '') {
        if (em) out = `*${out}*`;
        if (strong) out = `**${out}**`;
      }
      out = `${lead}${out}${trail}`;
      if (href !== undefined) out = `[${out}](${href})`;
      return out;
    })
    .join('\n');
}

/** `attrs.level` clamped into the range markdown can express (1..6). */
function headingLevel(node: AdfNode): number {
  const raw = node.attrs?.level;
  const level = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 1;
  return Math.min(Math.max(level, 1), MAX_HEADING_LEVEL);
}

/**
 * Escape a line-leading block marker inside a paragraph, so text that merely
 * begins with `- ` or `# ` does not come back as a list or a heading. Ordered
 * markers take the backslash on the dot (`1\. `), because a digit is not
 * escapable and `\1` would survive as a literal backslash.
 *
 * The `*`, `` ` `` and `[` markers need no case here: {@link escapeMarkdown}
 * already escaped every one of them inside the text.
 */
function escapeBlockStart(line: string): string {
  const ordered = ORDERED_START.exec(line);
  if (ordered !== null) {
    const head = ordered[1] ?? '';
    return `${head}\\${line.slice(head.length)}`;
  }
  const match = MARKER_START.exec(line) ?? QUOTE_START.exec(line);
  if (match === null) return line;
  const indent = match[1] ?? '';
  return `${indent}\\${line.slice(indent.length)}`;
}

// ---------------------------------------------------------------------------
// Node renderers
// ---------------------------------------------------------------------------

/**
 * `mention` → `@displayName`, falling back to the accountId when the display
 * name is absent (CC-07). Jira omits `attrs.text` for users the caller cannot
 * see; the donor rendered those as an empty string, which turns "assigned to
 * someone" into "assigned to". The accountId is at least resolvable via
 * `jira_search_users`.
 */
function renderMention(node: AdfNode): string {
  const name = attrString(node, 'text') ?? attrString(node, 'displayName');
  if (name !== undefined) return name.startsWith('@') ? name : `@${name}`;
  const id = attrString(node, 'id') ?? attrString(node, 'accountId');
  return id === undefined ? '' : `@${id}`;
}

/** `date` → its ISO calendar date. `attrs.timestamp` is epoch ms, as a string. */
function renderDate(node: AdfNode): string {
  const raw = node.attrs?.timestamp;
  const ms =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isFinite(ms)) {
    const date = new Date(ms);
    // An out-of-range epoch yields an Invalid Date whose toISOString() throws.
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return typeof raw === 'string' ? raw : '';
}

/**
 * Smart links (`inlineCard` / `blockCard` / `embedCard`) carry no text node:
 * the human-readable label is the resolved title when Jira embedded one, and
 * the URL otherwise. A card with neither contributes nothing rather than
 * throwing.
 */
function renderCard(node: AdfNode): string {
  const title = attrString(node, 'title');
  if (title !== undefined) return title;
  const data = node.attrs?.data;
  if (isRecord(data)) {
    const name = data.name;
    if (typeof name === 'string' && name.length > 0) return name;
    const dataUrl = data.url;
    if (typeof dataUrl === 'string' && dataUrl.length > 0) return dataUrl;
  }
  return attrString(node, 'url') ?? '';
}

/**
 * `media` / `mediaInline` → `[media: name]`. Deliberately NOT the URL: v1
 * fetches no attachments, media URLs are short-lived signed links, and a model
 * handed one will try to follow it. Filenames live in `alt` on modern payloads
 * and in `__fileName` on older ones; failing both, the media id is still enough
 * to correlate with `jira_list_attachments`.
 */
function renderMedia(node: AdfNode, markdown = false): string {
  const file = node.attrs?.file;
  const fromFile =
    isRecord(file) && typeof file.name === 'string' ? file.name : undefined;
  const name = attrString(node, 'alt') ?? attrString(node, '__fileName') ?? fromFile;
  const id = attrString(node, 'id');
  const label =
    name !== undefined && name.length > 0
      ? `media: ${collapse(name)}`
      : id === undefined
        ? 'media'
        : `media: id=${id}`;
  // CC-147: on the markdown path the brackets are escaped too — `[media: x]`
  // directly followed by a text node starting `(javascript:…)` is a link.
  return markdown ? `\\[${escapeMarkdown(label)}\\]` : `[${label}]`;
}

/**
 * `taskItem` → `[x] done` / `[ ] todo`, indented by its enclosing taskLists.
 * A nested list inside the item is rendered separately so it keeps its own
 * indentation instead of being collapsed onto the checkbox line.
 */
function renderTaskItem(node: AdfNode, state: FlattenState): string {
  const taskState = (attrString(node, 'state') ?? 'TODO').toUpperCase();
  const box = taskState === 'DONE' ? '[x]' : '[ ]';
  const children: unknown[] = Array.isArray(node.content) ? node.content : [];

  // Children keep document order, as a listItem's do (CC-232): text after a
  // nested list becomes a continuation line after it, not part of the box line.
  const indent = listIndent(state.listDepth);
  const continuation = indent + ' '.repeat(box.length + 1);
  let out = '';
  let lead = '';
  let started = false;

  const emitLead = (): void => {
    const body = collapse(lead);
    lead = '';
    if (started) {
      // On the markdown path a blank line first, as CC-223's, or the reader
      // would fold the text into the nested list's last item.
      if (body !== '') out += `${state.markdown ? '\n' : ''}${continuation}${body}\n`;
      return;
    }
    out += `${indent}${box}${body === '' ? '' : ` ${body}`}\n`;
    started = true;
  };

  for (const child of children) {
    const type = nodeType(child);
    if (type === 'taskList' || type === 'bulletList' || type === 'orderedList') {
      if (!started || lead !== '') emitLead();
      out += flatten(child, deeper(state));
    } else {
      lead += flatten(child, deeper(state));
    }
  }
  if (!started || lead !== '') emitLead();
  return out;
}

/**
 * One `listItem`, with its marker on the first line and its continuation lines
 * aligned under the text. Nested lists are rendered separately so they keep the
 * indentation their own depth gives them rather than inheriting this item's.
 *
 * Children keep document order (CC-223): a paragraph after a nested list stays
 * after it. They were hoisted, so `one`, a sublist, `two` read as `one`, `two`,
 * sublist. On the markdown path the paragraph after a sublist opens with a
 * blank continuation line, or the reader would take it for the end of the list.
 */
function renderListItem(item: unknown, marker: string, state: FlattenState): string {
  const children: unknown[] =
    isRecord(item) && Array.isArray(item.content) ? item.content : [item];

  const indent = listIndent(state.listDepth);
  const continuation = indent + ' '.repeat(marker.length + 1);
  let out = '';
  let lead = '';
  let started = false;
  let afterList = false;

  const emitLead = (): void => {
    const body = lead.replace(/\n+$/, '');
    lead = '';
    if (body === '') return;
    const lines = body.split('\n');
    if (afterList && state.markdown) lines.unshift('');
    for (const line of lines) {
      out += started ? `${continuation}${line}\n` : `${indent}${marker} ${line}\n`;
      started = true;
    }
    afterList = false;
  };

  for (const child of children) {
    const type = nodeType(child);
    if (type === 'bulletList' || type === 'orderedList' || type === 'taskList') {
      emitLead();
      if (!started) out += `${indent}${marker}\n`;
      started = true;
      out += flatten(child, deeper(state));
      afterList = true;
    } else {
      lead += flatten(child, deeper(state));
    }
  }
  emitLead();
  return started ? out : `${indent}${marker}\n`;
}

/** `bulletList` / `orderedList`, iterated here so ordered markers can count. */
function renderList(node: AdfNode, state: FlattenState): string {
  const ordered = node.type === 'orderedList';
  const rawStart = node.attrs?.order;
  const start =
    typeof rawStart === 'number' && Number.isFinite(rawStart) ? Math.trunc(rawStart) : 1;

  const items = Array.isArray(node.content) ? node.content : [];
  const childState: FlattenState = {
    ...state,
    depth: state.depth + 1,
    listDepth: state.listDepth + 1,
  };

  let out = '';
  let index = 0;
  for (const item of items) {
    out += renderListItem(item, ordered ? `${start + index}.` : '-', childState);
    index += 1;
  }
  return out;
}

/**
 * One table row, `|`-joined, one line — JIRA-API.md §ADF.
 *
 * On the markdown path a cell is flat text, as on the text path (CC-225): a
 * heading in a cell drops its `#`, and a row that opens with a list marker has
 * it escaped. `# H | - x` had come back as a heading swallowing the whole row.
 */
function renderTableRow(node: AdfNode, state: FlattenState): string {
  const cells = Array.isArray(node.content) ? node.content : [];
  const cellState: FlattenState = { ...deeper(state), cell: true };
  const rendered = cells.map((cell) => collapse(flatten(cell, cellState)));
  const row = rendered.join(' | ');
  return `${state.markdown ? escapeBlockStart(row) : row}\n`;
}

function flattenChildren(node: AdfNode, state: FlattenState): string {
  if (!Array.isArray(node.content)) return '';
  return node.content.map((child) => flatten(child, state)).join('');
}

// ---------------------------------------------------------------------------
// The flattener
// ---------------------------------------------------------------------------

/**
 * Block wrappers whose children are themselves blocks. They contribute no
 * newline of their own — their children already end with one. (The donor
 * treated `blockquote` as a leaf block and emitted a spurious blank line after
 * every quote; that is fixed here.)
 */
const BLOCK_CONTAINERS = new Set([
  'doc',
  'blockquote',
  'listItem',
  'table',
  'tableCell',
  'tableHeader',
  'layoutSection',
  'layoutColumn',
  'expand',
  'nestedExpand',
]);

/**
 * Blocks whose children are inline, so they terminate their own line.
 * `paragraph` and `heading` have their own cases — they are the two blocks the
 * markdown dialect renders differently.
 */
const LEAF_BLOCKS = new Set(['mediaSingle', 'decisionItem']);

function flatten(value: unknown, state: FlattenState): string {
  if (state.depth > MAX_NODE_DEPTH) return DEPTH_LIMIT_MARKER;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return literal(value, state);
  if (Array.isArray(value)) {
    return value.map((item) => flatten(item, deeper(state))).join('');
  }
  if (!isRecord(value)) return '';

  const node = value as AdfNode;
  const type = nodeType(node);

  switch (type) {
    // --- inline -----------------------------------------------------------
    case 'text': {
      const text = typeof node.text === 'string' ? node.text : '';
      return state.markdown ? applyMarks(text, node) : text;
    }
    case 'hardBreak':
      return '\n';
    // CC-147: every attr string below is tenant text as much as a text node's
    // is, so the markdown path escapes it the same way — a status lozenge that
    // reads `[x](javascript:…)` must not come out as a live link.
    case 'mention':
      return literal(renderMention(node), state);
    case 'emoji':
      return literal(
        attrString(node, 'shortName') ?? attrString(node, 'text') ?? '',
        state,
      );
    case 'status':
      return literal(attrString(node, 'text') ?? '', state);
    case 'date':
      return literal(renderDate(node), state);
    case 'inlineCard':
      return literal(renderCard(node), state);
    case 'blockCard':
    case 'embedCard': {
      const label = literal(renderCard(node), state);
      return label === '' ? '' : `${label}\n`;
    }
    case 'media':
    case 'mediaInline':
      return renderMedia(node, state.markdown);

    // --- blocks -----------------------------------------------------------
    case 'paragraph': {
      const inner = flattenChildren(node, deeper(state));
      if (!state.markdown) return `${inner}\n`;
      // The blank line is what makes this a paragraph rather than more of the
      // previous one: markdown joins consecutive lines, and CC-10 makes a bare
      // newline a hardBreak in the other direction.
      return `${inner.split('\n').map(escapeBlockStart).join('\n')}\n\n`;
    }
    case 'heading': {
      const inner = flattenChildren(node, deeper(state));
      if (!state.markdown || state.cell === true) return `${inner}\n`;
      const hashes = '#'.repeat(headingLevel(node));
      // An ATX heading is one line. A hardBreak (or a newline inside a text
      // node) would end it early, and the rest would parse back as a new block
      // - `## a` then `- b` becomes a heading and a list (CC-174).
      const line = inner.replace(/\n+/g, ' ');
      return line === '' ? `${hashes}\n` : `${hashes} ${line}\n`;
    }
    case 'rule':
      return '---\n';
    case 'codeBlock': {
      const language = attrString(node, 'language') ?? '';
      // Code is literal: its children render on the plain-text path even in
      // markdown mode, or every `*` in the sample would come back escaped.
      const body = flattenChildren(node, { ...deeper(state), markdown: false });
      if (!state.markdown) return `\`\`\`${language}\n${body}\n\`\`\`\n`;
      // A backtick fence's info string may hold no backticks and obviously no
      // newline: a `language` carrying either would end the fence line early and
      // let an attrs value forge document structure.
      const info = language.replace(/[`\r\n]/g, '').trim();
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
      return `${fence}${info}\n${body}\n${fence}\n`;
    }
    case 'panel': {
      const panelType = literal(attrString(node, 'panelType') ?? 'info', state);
      return `[panel:${panelType}]\n${flattenChildren(node, deeper(state))}`;
    }
    case 'mediaGroup': {
      const parts = Array.isArray(node.content)
        ? node.content
            .map((child) => flatten(child, deeper(state)))
            .filter((s) => s !== '')
        : [];
      return parts.length === 0 ? '' : `${parts.join(' ')}\n`;
    }
    case 'bulletList':
    case 'orderedList': {
      const list = renderList(node, state);
      // A blank line after a top-level list stops the next paragraph from being
      // read as a lazy continuation of the last item. Nested lists get none: a
      // blank line inside a list would close every open list instead.
      const separate = state.markdown && state.listDepth === 0 && list !== '';
      return separate ? `${list}\n` : list;
    }
    case 'taskList':
      return flattenChildren(node, {
        ...state,
        depth: state.depth + 1,
        listDepth: state.listDepth + 1,
      });
    case 'taskItem':
      return renderTaskItem(node, state);
    case 'tableRow':
      return renderTableRow(node, state);

    default:
      break;
  }

  if (BLOCK_CONTAINERS.has(type)) return flattenChildren(node, deeper(state));
  if (LEAF_BLOCKS.has(type)) return `${flattenChildren(node, deeper(state))}\n`;

  // Unknown node (CC-06). A container still recurses so no text is dropped;
  // a leaf — a new inline node whose payload lives entirely in attrs — would
  // otherwise vanish without trace, so it degrades to a placeholder naming the
  // type. Both branches are silent about attrs and neither throws.
  const inner = flattenChildren(node, deeper(state));
  if (inner !== '') return inner;
  // CC-224: the text and the type name are tenant text like any attr (CC-147),
  // and the placeholder's brackets are escaped as media's are.
  if (typeof node.text === 'string' && node.text !== '') return literal(node.text, state);
  const label = typeLabel(type);
  return state.markdown ? `\\[${escapeMarkdown(label)}\\]` : `[${label}]`;
}

/**
 * Flatten an ADF document (or any subtree, or `null`) to readable plain text.
 * Never throws: unknown nodes, malformed attrs, cycles and pathological depth
 * all degrade (CC-06, CC-09). An empty or absent document is `''`, never
 * `"undefined"` (CC-08).
 *
 * Delta over the donor: the result is right-trimmed, so a one-paragraph
 * description is `'hello'` and not `'hello\n'`.
 */
export function adfToText(node: unknown): string {
  return flatten(node, { depth: 0, listDepth: 0, markdown: false }).trimEnd();
}

/**
 * Flatten an ADF document to the markdown subset instead of plain text. Same
 * guarantees as {@link adfToText} — never throws, same caps, same degradation
 * for everything outside the subset — and the same right-trim, so a
 * one-paragraph description is `'hello'`.
 *
 * This is opt-in per call (`format: 'markdown'`); plain text stays the default
 * so existing clients keep byte-identical output.
 */
export function adfToMarkdown(node: unknown): string {
  return flatten(node, { depth: 0, listDepth: 0, markdown: true }).trimEnd();
}

/**
 * Depth cap for {@link renderAdfDocs}. Matches the shaping cap in
 * `api/issues.ts`: a value nested deeper than this is passed through untouched,
 * because it is either generated or hostile, and neither deserves a stack.
 */
const MAX_RENDER_DEPTH = 16;

function renderDocsIn(
  value: unknown,
  render: (node: unknown) => string,
  depth: number,
): unknown {
  if (depth >= MAX_RENDER_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => renderDocsIn(entry, render, depth + 1));
  }
  if (!isRecord(value)) return value;
  if (isAdfDoc(value)) return render(value);

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = renderDocsIn(child, render, depth + 1);
  }
  return out;
}

/**
 * Replace every ADF document inside an arbitrary JSON value with its rendered
 * string, non-mutatingly. This is how the tool ring re-renders a payload it
 * fetched raw: the *set* of fields that gets rendered is exactly the set
 * {@link isAdfDoc} recognises, which is the same set the plain-text shaping
 * path flattens, so `format: 'markdown'` cannot render a field that
 * `format: 'text'` would have left alone.
 */
export function renderAdfDocs<T>(value: T, render: (node: unknown) => string): T {
  return renderDocsIn(value, render, 0) as T;
}

// ---------------------------------------------------------------------------
// Text → ADF
// ---------------------------------------------------------------------------

/**
 * Build a minimal ADF document from plain text (CC-10):
 * CRLF is normalised, a blank line starts a new paragraph, a single newline
 * inside a paragraph becomes a `hardBreak`, and leading/trailing blank
 * paragraphs are trimmed. The version is pinned — Jira accepts `1` only.
 *
 * Blank input yields a doc with an empty `content` array, which is how a
 * rich-text field is cleared. Tools that require a non-empty body (a comment)
 * validate their input; that is not this builder's job.
 */
export function adfFromText(text: string): AdfDoc {
  const source = typeof text === 'string' ? text : '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current);

  const content: AdfNode[] = paragraphs.map((paragraph) => {
    const inline: AdfNode[] = [];
    paragraph.forEach((line, index) => {
      if (index > 0) inline.push({ type: 'hardBreak' });
      inline.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content: inline };
  });

  return { type: 'doc', version: 1, content };
}

// ---------------------------------------------------------------------------
// Markdown → ADF
//
// A hand-rolled, line-based parser for the same subset `adfToMarkdown` emits.
// No dependency: a markdown library is a large, churning supply-chain surface
// for a grammar we deliberately keep to eight constructs, and every one of them
// fits in a screen of code with no lookahead.
//
// Two rules make it safe on hostile input: it never throws (anything it does
// not recognise stays paragraph text — CC-06 in the other direction), and it
// never resolves anything itself. A `mention` node needs an accountId, the
// converter is pure and network-free, and a fabricated id produces a comment
// that pings the wrong person — so the only mention nodes it emits come from a
// caller-supplied resolution map of live-directory ids (D100, CC-108): a
// `@[name]` token with a map entry becomes that entry's node; with no map, or
// no entry, it stays literal text, byte-identical to the option-less call.
// Bare `@name` is never a token, which is exactly what Jira's own editor shows
// for an unresolved handle. The read direction keeps rendering mentions as
// `@Display Name`, never `@[...]` (CC-07, CC-110), so a read→write round trip
// cannot re-resolve.
// ---------------------------------------------------------------------------

/** Nesting cap for the inline scanner — `[[[[[…` must not own the stack. */
const MAX_INLINE_DEPTH = 8;

/** Deepest list nesting built; past it, items join the deepest open list. */
const MAX_PARSE_LIST_DEPTH = 16;

/** Bullet markers accepted on input. Only `-` is ever emitted. */
const BULLET_MARKERS = new Set(['-', '+', '*']);

/** What a backslash may escape (CommonMark's ASCII punctuation set). */
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!<>|~^$&\'"/:;,=?@%');

/** Longest name a `@[name]` token may carry; anything longer stays literal. */
const MAX_MENTION_NAME_LENGTH = 255;

/** A list item line: indent, marker, then the text (a bare marker is empty). */
const LIST_ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

/** An ATX heading. `###` alone is a heading with no text. */
const HEADING = /^(#{1,6})(?:[ \t]+(.*))?$/;

/**
 * A fence line: three or more backticks, then an optional info string. The info
 * string may hold no backtick (CommonMark's own rule), which is what keeps a
 * line that merely STARTS with a long code span from opening a code block.
 */
const FENCE = /^[ \t]*(`{3,})[ \t]*([^`]*)$/;

/** Line-start markers the renderer escapes so a paragraph stays a paragraph. */
const ORDERED_START = /^([ \t]*\d{1,9})[.)](?=[ \t]|$)/;
const MARKER_START = /^([ \t]*)(?:#{1,6}|[-+*])(?=[ \t]|$)/;
const QUOTE_START = /^([ \t]*)>/;

/** A list item under construction: its node plus the arrays we append to. */
interface OpenItem {
  readonly node: AdfNode;
  readonly children: AdfNode[];
  /** The paragraph a continuation line appends to — the item's latest. */
  inline: AdfNode[];
  /** Where the item's text starts; a continuation line drops that indent. */
  readonly column: number;
}

/** A list under construction, keyed by the indent of its markers. */
interface OpenList {
  readonly items: AdfNode[];
  readonly ordered: boolean;
  readonly indent: number;
  item: OpenItem;
}

/** Leading-whitespace width; a tab counts as the two spaces we emit per level. */
function indentWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 2;
    else break;
  }
  return width;
}

/** How many times `ch` repeats starting at `start`, counting at most `max`. */
function runLength(text: string, start: number, ch: string, max = Infinity): number {
  let n = 0;
  while (n < max && text.charAt(start + n) === ch) n += 1;
  return n;
}

/**
 * CC-149 — how much scanning one top-level {@link parseInline} call may do.
 * Every helper below looks AHEAD for a closer, and every `[`, `*`, `` ` `` or
 * `<` is a fresh look-ahead, so a line of 65,536 unclosed `[` is quadratic —
 * seconds of blocked event loop, which under the HTTP transport stalls every
 * session. The budget makes the total linear: once it is spent, the helpers
 * report "no closer" and the rest of the line stays literal text. Ordinary
 * markdown spends a small multiple of its length and never reaches it.
 */
interface ScanBudget {
  left: number;
}

const SCAN_BUDGET_PER_CHAR = 32;
const SCAN_BUDGET_BASE = 4096;

function scanBudget(text: string): ScanBudget {
  return { left: SCAN_BUDGET_BASE + SCAN_BUDGET_PER_CHAR * text.length };
}

/** Charge `cost` steps; `false` once the budget is spent. */
function spend(budget: ScanBudget, cost: number): boolean {
  budget.left -= cost;
  return budget.left >= 0;
}

/**
 * Index of the delimiter that closes the one just consumed, or -1. A code span
 * is stepped over rather than scanned: CommonMark binds code tighter than links
 * and emphasis, so the `[` in `` `[x` `` is literal and must not be counted —
 * counting it loses the link (or the emphasis) that wraps the span.
 */
function matchDelimiter(
  text: string,
  from: number,
  open: string,
  close: string,
  budget: ScanBudget,
): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (!spend(budget, 1)) return -1;
    const ch = text.charAt(i);
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') {
      const span = readCodeSpan(text, i, budget);
      if (span !== undefined) {
        i = span.next - 1;
        continue;
      }
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** Index of the next unescaped `delim` outside a code span, or -1. */
function findDelimiter(
  text: string,
  from: number,
  delim: string,
  budget: ScanBudget,
): number {
  for (let i = from; i < text.length; i += 1) {
    if (!spend(budget, 1)) return -1;
    const ch = text.charAt(i);
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') {
      const span = readCodeSpan(text, i, budget);
      if (span !== undefined) {
        i = span.next - 1;
        continue;
      }
    }
    if (text.startsWith(delim, i)) return i;
  }
  return -1;
}

function readCodeSpan(
  text: string,
  start: number,
  budget: ScanBudget,
): { readonly text: string; readonly next: number } | undefined {
  if (budget.left <= 0) return undefined;
  const length = runLength(text, start, '`');
  spend(budget, length);
  const fence = '`'.repeat(length);
  let from = start + length;
  while (from < text.length) {
    if (budget.left <= 0) return undefined;
    const at = text.indexOf(fence, from);
    spend(budget, (at === -1 ? text.length : at) - from + length);
    if (at === -1) return undefined;
    const found = runLength(text, at, '`');
    if (found !== length) {
      from = at + found;
      continue;
    }
    let content = text.slice(start + length, at);
    if (content === '') return undefined;
    // CommonMark strips one space from each side when both are present, which
    // is what lets a code span hold a leading backtick or space.
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    return { text: content, next: at + length };
  }
  return undefined;
}

function readLink(
  text: string,
  start: number,
  budget: ScanBudget,
): { readonly label: string; readonly href: string; readonly next: number } | undefined {
  const labelEnd = matchDelimiter(text, start + 1, '[', ']', budget);
  if (labelEnd === -1) return undefined;
  if (text.charAt(labelEnd + 1) !== '(') return undefined;
  const label = text.slice(start + 1, labelEnd);

  // CC-151: the angle-bracket form is read FIRST. The renderer emits it exactly
  // for hrefs whose parentheses do not balance (`markdownHref`), so counting
  // parentheses before looking for `<…>` would cut such an href short.
  let open = labelEnd + 2;
  while (text.charAt(open) === ' ') open += 1;
  if (text.charAt(open) === '<' && budget.left > 0) {
    const close = text.indexOf('>', open + 1);
    spend(budget, (close === -1 ? text.length : close) - open);
    if (close !== -1) {
      let after = close + 1;
      while (text.charAt(after) === ' ') after += 1;
      const href = text.slice(open + 1, close).trim();
      if (text.charAt(after) === ')' && href !== '') {
        return { label, href, next: after + 1 };
      }
    }
  }

  const hrefEnd = matchDelimiter(text, labelEnd + 2, '(', ')', budget);
  if (hrefEnd === -1) return undefined;

  const raw = text.slice(labelEnd + 2, hrefEnd).trim();
  const href = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  if (href === '') return undefined;
  return { label, href, next: hrefEnd + 1 };
}

/** End of text counts as space: nothing can flank a delimiter from there. */
function isSpace(ch: string): boolean {
  return ch === '' || /\s/.test(ch);
}

function readEmphasis(
  text: string,
  start: number,
  budget: ScanBudget,
):
  | {
      readonly text: string;
      readonly strong: boolean;
      readonly em: boolean;
      readonly next: number;
    }
  | undefined {
  const run = runLength(text, start, '*', 3);
  // CommonMark flanking, the whitespace half: a run opens only when a
  // non-space follows it and closes only when a non-space precedes it, so
  // `2 * 3 * 4` stays literal arithmetic instead of italicising " 3 " (CC-191).
  if (isSpace(text.charAt(start + run))) return undefined;
  for (let length = run; length >= 1; length -= 1) {
    const delim = '*'.repeat(length);
    let at = findDelimiter(text, start + length, delim, budget);
    while (at !== -1 && isSpace(text.charAt(at - 1))) {
      at = findDelimiter(text, at + length, delim, budget);
    }
    if (at === -1) continue;
    const inner = text.slice(start + length, at);
    if (inner === '') continue;
    return { text: inner, strong: length >= 2, em: length !== 2, next: at + length };
  }
  return undefined;
}

/** Target for one resolved `@[name]` token. `text` includes the leading `@`. */
export interface MentionTarget {
  /** accountId from a live directory response — never fabricated (CC-108). */
  readonly id: string;
  /** `@` + displayName, for plan readability; omitted when unknown. */
  readonly text?: string;
}

/**
 * One grammar, two sinks (CC-109): resolution parses with `mentions` and emits
 * a node per map hit; extraction parses with `collect` and records every valid
 * token. Both flow through the same `@[` branch of {@link parseInline}, so the
 * two modes cannot disagree about what is a token. No sink at all is the
 * pre-feature scanner, byte for byte (CC-108).
 */
interface MentionSink {
  readonly mentions?: ReadonlyMap<string, MentionTarget>;
  readonly collect?: (name: string) => void;
}

/**
 * The `@[name]` token at `start` (which must point at the `@`), or `undefined`
 * when it must stay literal: unterminated, empty or whitespace-only (as `@[]`
 * does — there is no name to search for, CC-241), or longer than
 * {@link MAX_MENTION_NAME_LENGTH}. The name is verbatim — no trim, no escape
 * processing, no nesting — because it is the resolution-map key (D100), and a
 * key that mutates in transit cannot match the map the resolver built from it.
 * The resolver trims its own copy for searching and matching (CC-241).
 */
function readMention(
  text: string,
  start: number,
): { readonly name: string; readonly next: number } | undefined {
  // Bounded look-ahead (CC-149): a name longer than the cap is refused anyway,
  // so there is no reason to scan past it for the `]`.
  const window = text.slice(start + 2, start + 3 + MAX_MENTION_NAME_LENGTH);
  const offset = window.indexOf(']');
  if (offset === -1) return undefined;
  const close = start + 2 + offset;
  const name = text.slice(start + 2, close);
  if (name.trim() === '' || name.length > MAX_MENTION_NAME_LENGTH) return undefined;
  return { name, next: close + 1 };
}

/** The emitted node (D100): the map's id verbatim, `text` only when non-empty. */
function mentionNode(target: MentionTarget): AdfNode {
  const attrs: Record<string, unknown> = { id: target.id };
  if (target.text !== undefined && target.text !== '') attrs.text = target.text;
  return { type: 'mention', attrs };
}

/**
 * Marks the ADF schema allows next to `code`. Everything else — `strong`,
 * `em` — on a code node is an INVALID_INPUT 400 from Jira (CC-148), so
 * `**\`x\`**` keeps the code and drops the bold.
 */
const CODE_COMPATIBLE_MARKS = new Set(['link', 'annotation']);

/**
 * Write-side link schemes that are never kept as a link (CC-153): the read
 * side already refuses to render them, and a comment is a bad place to plant a
 * `javascript:` URL copied out of untrusted content. Browsers ignore control
 * characters and whitespace inside a scheme, so they are stripped first.
 */
const UNSAFE_WRITE_SCHEME = /^(?:javascript|vbscript|data):/i;

function unsafeHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  return UNSAFE_WRITE_SCHEME.test(href.replace(/[\u0000-\u0020\u007f]+/g, ''));
}

/** Add a mark to every text node, skipping nodes that already carry it. */
function addMark(nodes: readonly AdfNode[], mark: AdfNode): AdfNode[] {
  return nodes.map((node) => {
    if (node.type !== 'text') return node;
    const existing: unknown[] = Array.isArray(node.marks) ? node.marks : [];
    if (existing.some((m) => isRecord(m) && m.type === mark.type)) return node;
    const isCode = existing.some((m) => isRecord(m) && m.type === 'code');
    if (
      isCode &&
      typeof mark.type === 'string' &&
      !CODE_COMPATIBLE_MARKS.has(mark.type)
    ) {
      return node;
    }
    return { ...node, marks: [...existing, mark] };
  });
}

/** One line of inline markdown → inline ADF nodes. Never throws. */
function parseInline(
  text: string,
  depth: number,
  sink?: MentionSink,
  budget: ScanBudget = scanBudget(text),
): AdfNode[] {
  const out: AdfNode[] = [];
  let buffer = '';

  const flush = (): void => {
    if (buffer === '') return;
    out.push({ type: 'text', text: buffer });
    buffer = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === '\\' && ESCAPABLE.has(text.charAt(i + 1))) {
      buffer += text.charAt(i + 1);
      i += 2;
      continue;
    }

    if (ch === '`') {
      const span = readCodeSpan(text, i, budget);
      if (span !== undefined) {
        flush();
        out.push({ type: 'text', text: span.text, marks: [{ type: 'code' }] });
        i = span.next;
        continue;
      }
    }

    // `@[name]` mention token (D100). Only a sink activates the branch, so the
    // sink-less scan stays byte-identical to the pre-feature converter
    // (CC-108). The collector consumes every valid token — exactly the
    // positions resolution consumes when every token is in the map, which the
    // resolver guarantees by refusing the call otherwise (CC-109).
    if (ch === '@' && text.charAt(i + 1) === '[' && sink !== undefined) {
      const token = readMention(text, i);
      if (token !== undefined) {
        sink.collect?.(token.name);
        const target = sink.mentions?.get(token.name);
        if (target !== undefined || sink.collect !== undefined) {
          flush();
          if (target !== undefined) out.push(mentionNode(target));
          i = token.next;
          continue;
        }
        // Resolution-map miss: fall through, so the literal text scans exactly
        // as the sink-less converter scans it (CC-108).
      }
    }

    if (ch === '[' && depth < MAX_INLINE_DEPTH) {
      const link = readLink(text, i, budget);
      if (link !== undefined) {
        flush();
        const mark: AdfNode = { type: 'link', attrs: { href: link.href } };
        const label = parseInline(link.label, depth + 1, sink, budget);
        // CC-137: `[](url)` has no text to carry the mark, and a link with
        // nothing to click is a lost link — the URL becomes its own label.
        // CC-152: the same holds for a label of only non-text nodes (a lone
        // resolved mention), which `addMark` cannot mark; the URL follows it.
        const hasText = label.some((node) => node.type === 'text');
        const separator: AdfNode[] =
          hasText || label.length === 0 ? [] : [{ type: 'text', text: ' ' }];
        const hrefText: AdfNode[] = hasText ? [] : [{ type: 'text', text: link.href }];
        if (unsafeHref(link.href)) {
          // CC-153: a refused scheme keeps its label as plain text, no link.
          out.push(...label, ...separator, ...hrefText);
        } else {
          out.push(...addMark(label, mark), ...separator, ...addMark(hrefText, mark));
        }
        i = link.next;
        continue;
      }
    }

    if (ch === '*' && depth < MAX_INLINE_DEPTH) {
      const emphasis = readEmphasis(text, i, budget);
      if (emphasis !== undefined) {
        flush();
        let nodes = parseInline(emphasis.text, depth + 1, sink, budget);
        if (emphasis.em) nodes = addMark(nodes, { type: 'em' });
        if (emphasis.strong) nodes = addMark(nodes, { type: 'strong' });
        out.push(...nodes);
        i = emphasis.next;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

/** Paragraph lines → one paragraph; a line break inside it is a hardBreak. */
function paragraphNode(lines: readonly string[], sink?: MentionSink): AdfNode {
  const inline: AdfNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) inline.push({ type: 'hardBreak' });
    inline.push(...parseInline(line, 0, sink));
  });
  return { type: 'paragraph', content: inline };
}

function headingNode(level: number, text: string, sink?: MentionSink): AdfNode {
  return { type: 'heading', attrs: { level }, content: parseInline(text, 0, sink) };
}

function codeBlockNode(language: string, text: string): AdfNode {
  const node: AdfNode = {
    type: 'codeBlock',
    content: text === '' ? [] : [{ type: 'text', text }],
  };
  if (language !== '') node.attrs = { language };
  return node;
}

function itemNode(inline: AdfNode[], column: number): OpenItem {
  const children: AdfNode[] = [{ type: 'paragraph', content: inline }];
  return { node: { type: 'listItem', content: children }, children, inline, column };
}

/** `line` without up to `width` columns of leading whitespace. */
function dropIndent(line: string, width: number): string {
  let index = 0;
  let dropped = 0;
  while (index < line.length && dropped < width) {
    const ch = line[index];
    if (ch === ' ') dropped += 1;
    else if (ch === '\t') dropped += 2;
    else break;
    index += 1;
  }
  return line.slice(index);
}

/** A closing fence is a bare run of backticks at least as long as the opener. */
function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && /^`+$/.test(trimmed);
}

/** The block-level parse behind {@link adfFromMarkdown} and
    {@link extractMentions} — one grammar for both modes (CC-109). */
function parseMarkdown(text: string, sink?: MentionSink): AdfDoc {
  const source = typeof text === 'string' ? text : '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  const content: AdfNode[] = [];
  const stack: OpenList[] = [];
  let paragraph: string[] = [];
  let fence:
    | {
        readonly marker: string;
        readonly language: string;
        readonly body: string[];
        /** The list item the fence sits in, and the indent its lines drop. */
        readonly owner?: OpenItem;
        readonly indent: number;
      }
    | undefined;
  // A blank line or a closed code block inside a list item: the next indented
  // line opens a new block in that item instead of extending the paragraph
  // before it.
  // A blank line holds an item open only as far as its OWN indent reaches: the
  // renderer writes the continuation indent on a blank line inside an item and
  // nothing on the blank line after a list, so `-` + blank + ` a` stays a list
  // followed by a paragraph (CC-154).
  let gap: 'blank' | 'block' | undefined;
  let gapIndent = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    content.push(paragraphNode(paragraph, sink));
    paragraph = [];
  };

  const openItem = (
    lineIndent: number,
    ordered: boolean,
    start: number,
    rest: string,
    column: number,
  ): void => {
    let indent = lineIndent;
    // A shallower marker closes the deeper lists; an equal marker of the other
    // kind closes this one and opens a sibling — a bullet list never turns into
    // an ordered list mid-flight.
    for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
      if (indent < top.indent || (indent === top.indent && top.ordered !== ordered)) {
        stack.pop();
        continue;
      }
      break;
    }

    const deepest = stack.at(-1);
    if (deepest !== undefined && stack.length >= MAX_PARSE_LIST_DEPTH) {
      indent = Math.min(indent, deepest.indent);
    }

    const parent = stack.at(-1);
    const item = itemNode(parseInline(rest, 0, sink), column);
    if (parent === undefined || indent > parent.indent) {
      const items: AdfNode[] = [item.node];
      const list: AdfNode = {
        type: ordered ? 'orderedList' : 'bulletList',
        content: items,
      };
      if (ordered && start !== 1) list.attrs = { order: start };
      if (parent === undefined) content.push(list);
      else parent.item.children.push(list);
      stack.push({ items, ordered, indent, item });
      return;
    }
    parent.items.push(item.node);
    parent.item = item;
  };

  const closeFence = (): void => {
    if (fence === undefined) return;
    const block = codeBlockNode(fence.language, fence.body.join('\n'));
    if (fence.owner === undefined) content.push(block);
    else {
      fence.owner.children.push(block);
      gap = 'block';
    }
    fence = undefined;
  };

  /**
   * The open list whose item a line indented by `lineIndent` belongs to — the
   * deepest one indented less than the line (CC-154). Deeper lists close.
   */
  const ownerList = (lineIndent: number): OpenList | undefined => {
    while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= lineIndent) stack.pop();
    return stack.at(-1);
  };

  for (const line of lines) {
    if (fence !== undefined) {
      if (isFenceClose(line, fence.marker)) closeFence();
      else fence.body.push(dropIndent(line, fence.indent));
      continue;
    }

    const opening = FENCE.exec(line);
    if (opening !== null) {
      flushParagraph();
      const lineIndent = indentWidth(line);
      const reach = gap === 'blank' ? Math.min(lineIndent, gapIndent) : lineIndent;
      gap = undefined;
      const owner = stack.length > 0 ? ownerList(reach) : undefined;
      if (owner === undefined) stack.length = 0;
      fence = {
        marker: opening[1] ?? '```',
        language: (opening[2] ?? '').trim(),
        body: [],
        // CommonMark strips up to the fence's own indent from each body line,
        // top level included (CC-193).
        indent: lineIndent,
        ...(owner === undefined ? {} : { owner: owner.item }),
      };
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      // A list survives a blank line only if an indented line follows it.
      if (stack.length > 0 && gap === undefined) {
        gap = 'blank';
        gapIndent = indentWidth(line);
      } else if (gap === 'blank') gapIndent = Math.min(gapIndent, indentWidth(line));
      else if (gap === 'block') {
        gap = 'blank';
        gapIndent = indentWidth(line);
      }
      continue;
    }
    const afterGap = gap;
    gap = undefined;
    const isItem = LIST_ITEM.test(line);
    if (afterGap !== undefined && stack.length > 0 && !isItem) {
      // After a gap, an indented line is a new paragraph in the item above it
      // (CC-154); anything else ends the list, as before.
      const lineIndent = indentWidth(line);
      const reach = afterGap === 'blank' ? Math.min(lineIndent, gapIndent) : lineIndent;
      const owner = ownerList(reach);
      if (owner !== undefined) {
        const inline = parseInline(line.trim(), 0, sink);
        owner.item.children.push({ type: 'paragraph', content: inline });
        owner.item.inline = inline;
        continue;
      }
      stack.length = 0;
    } else if (afterGap === 'blank' && isItem) {
      // A marker after a blank line starts a new list, as it always has.
      stack.length = 0;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      stack.length = 0;
      content.push(headingNode((heading[1] ?? '#').length, heading[2] ?? '', sink));
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flushParagraph();
      const marker = item[2] ?? '-';
      const ordered = !BULLET_MARKERS.has(marker);
      const start = ordered ? Number.parseInt(marker, 10) : 1;
      const lineIndent = indentWidth(item[1] ?? '');
      openItem(lineIndent, ordered, start, item[3] ?? '', lineIndent + marker.length + 1);
      continue;
    }

    // Inside a list, a more-indented plain line continues the current item
    // rather than ending the list — that is what the renderer emits for an
    // item whose text runs over one line. Only the item's own indent is
    // dropped: spaces after a hardBreak are text, and a trim lost them (CC-228).
    const open = stack.at(-1);
    if (open !== undefined && indentWidth(line) > open.indent) {
      const text = dropIndent(line, open.item.column);
      open.item.inline.push({ type: 'hardBreak' }, ...parseInline(text, 0, sink));
      continue;
    }
    stack.length = 0;
    paragraph.push(line);
  }

  // An unterminated fence still yields its code block: dropping it would
  // silently swallow the rest of the document.
  closeFence();
  flushParagraph();

  return { type: 'doc', version: 1, content };
}

/**
 * Parse the markdown subset into an ADF document. The inverse of
 * {@link adfToMarkdown} for everything the subset covers; anything else — block
 * quotes, tables, images, reference links, setext headings, HTML — degrades to
 * the paragraph text it was written as, never to an exception.
 *
 * CC-10 parity with {@link adfFromText} is deliberate: CRLF is normalised, a
 * blank line starts a new paragraph, a single newline inside a paragraph is a
 * `hardBreak`, and leading/trailing blank paragraphs are trimmed.
 *
 * `options.mentions` (D100) resolves `@[name]` tokens: a token whose verbatim
 * content is a map key becomes that entry's `mention` node; every other
 * spelling — no map, no entry, unterminated `@[`, empty `@[]`, or a name past
 * {@link MAX_MENTION_NAME_LENGTH} — stays literal text, byte-identical to the
 * option-less call (CC-108). No id is ever fabricated, and tokens inside code
 * spans, fenced code blocks, or behind a `\@[` escape are never tokens
 * (CC-109).
 */
export function adfFromMarkdown(
  text: string,
  options?: { readonly mentions?: ReadonlyMap<string, MentionTarget> },
): AdfDoc {
  const mentions = options?.mentions;
  return parseMarkdown(text, mentions === undefined ? undefined : { mentions });
}

/**
 * Distinct raw `@[...]` token contents, document order, exact-string dedupe
 * (case-insensitive grouping is the resolver's job — CC-112). Same grammar as
 * {@link adfFromMarkdown}: fenced code blocks, code spans and backslash-escaped
 * `\@[` are skipped, and extraction consumes a valid token exactly where
 * resolution would, so the two modes cannot disagree (CC-109). Pure, total,
 * never throws.
 */
export function extractMentions(text: string): readonly string[] {
  const names = new Set<string>();
  parseMarkdown(text, {
    collect: (name) => {
      names.add(name);
    },
  });
  return [...names];
}

/** Structural guard: is this value an ADF document rather than a scalar field? */
export function isAdfDoc(value: unknown): value is AdfDoc {
  return isRecord(value) && value.type === 'doc' && Array.isArray(value.content);
}

/**
 * Accept either plain text or a caller-supplied ADF document for a rich-text
 * field (TOOLS.md: `description` takes text or raw ADF, and either one replaces
 * the whole field — CC-31). A string is built; a document is normalised to the
 * pinned `{ type: 'doc', version: 1 }` header and otherwise passed through.
 * Anything else is a `validation` error, not a silent coercion.
 */
export function toAdf(body: string | AdfNode): AdfDoc {
  if (typeof body === 'string') return adfFromText(body);

  if (!isRecord(body)) {
    throw new JiraError({
      kind: 'validation',
      message: 'A rich-text body must be plain text or an ADF document object.',
      remediation:
        'Pass a string, or an object shaped { type: "doc", version: 1, content: [] }.',
    });
  }

  const type = body.type;
  if (typeof type === 'string' && type !== 'doc') {
    throw new JiraError({
      kind: 'validation',
      message: `A rich-text ADF body must be a whole document, not a "${typeLabel(type)}" node.`,
      remediation: 'Wrap the node in { type: "doc", version: 1, content: [ ... ] }.',
    });
  }

  const content = Array.isArray(body.content) ? body.content : [];
  return { ...body, type: 'doc', version: 1, content };
}
