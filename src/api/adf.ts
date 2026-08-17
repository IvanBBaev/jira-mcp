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
// unescaped) though the parser accepts nothing it does not emit.
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
  // inside it, and a URL containing them was already malformed.
  return /[\s()<>]/.test(clean) ? `<${clean.replace(/[<>]/g, '')}>` : clean;
}

/**
 * Wrap a text node's content in the markup for the marks it carries. Order is
 * innermost-first — code, then em, then strong, then link — so the result parses
 * back to the same mark set. Marks outside the subset (strike, underline,
 * textColor, subsup) are dropped exactly as the text path drops them.
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

  let out = code ? inlineCode(text) : escapeMarkdown(text);
  if (em) out = `*${out}*`;
  if (strong) out = `**${out}**`;
  if (href !== undefined) out = `[${out}](${href})`;
  return out;
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
function renderMedia(node: AdfNode): string {
  const file = node.attrs?.file;
  const fromFile =
    isRecord(file) && typeof file.name === 'string' ? file.name : undefined;
  const name = attrString(node, 'alt') ?? attrString(node, '__fileName') ?? fromFile;
  if (name !== undefined && name.length > 0) return `[media: ${collapse(name)}]`;
  const id = attrString(node, 'id');
  return id === undefined ? '[media]' : `[media: id=${id}]`;
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

  let lead = '';
  let nested = '';
  for (const child of children) {
    const type = nodeType(child);
    if (type === 'taskList' || type === 'bulletList' || type === 'orderedList') {
      nested += flatten(child, deeper(state));
    } else {
      lead += flatten(child, deeper(state));
    }
  }

  const indent = listIndent(state.listDepth);
  const body = collapse(lead);
  return `${indent}${box}${body === '' ? '' : ` ${body}`}\n${nested}`;
}

/**
 * One `listItem`, with its marker on the first line and its continuation lines
 * aligned under the text. Nested lists are rendered separately so they keep the
 * indentation their own depth gives them rather than inheriting this item's.
 */
function renderListItem(item: unknown, marker: string, state: FlattenState): string {
  const children: unknown[] =
    isRecord(item) && Array.isArray(item.content) ? item.content : [item];

  let lead = '';
  let nested = '';
  for (const child of children) {
    const type = nodeType(child);
    if (type === 'bulletList' || type === 'orderedList' || type === 'taskList') {
      nested += flatten(child, deeper(state));
    } else {
      lead += flatten(child, deeper(state));
    }
  }

  const indent = listIndent(state.listDepth);
  const body = lead.replace(/\n+$/, '');
  if (body === '') return `${indent}${marker}\n${nested}`;

  const continuation = indent + ' '.repeat(marker.length + 1);
  const rendered = body
    .split('\n')
    .map((line, index) =>
      index === 0 ? `${indent}${marker} ${line}` : `${continuation}${line}`,
    )
    .join('\n');
  return `${rendered}\n${nested}`;
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

/** One table row, `|`-joined, one line — JIRA-API.md §ADF. */
function renderTableRow(node: AdfNode, state: FlattenState): string {
  const cells = Array.isArray(node.content) ? node.content : [];
  const rendered = cells.map((cell) => collapse(flatten(cell, deeper(state))));
  return `${rendered.join(' | ')}\n`;
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
  if (typeof value === 'string') return value;
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
    case 'mention':
      return renderMention(node);
    case 'emoji':
      return attrString(node, 'shortName') ?? attrString(node, 'text') ?? '';
    case 'status':
      return attrString(node, 'text') ?? '';
    case 'date':
      return renderDate(node);
    case 'inlineCard':
      return renderCard(node);
    case 'blockCard':
    case 'embedCard': {
      const label = renderCard(node);
      return label === '' ? '' : `${label}\n`;
    }
    case 'media':
    case 'mediaInline':
      return renderMedia(node);

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
      if (!state.markdown) return `${inner}\n`;
      const hashes = '#'.repeat(headingLevel(node));
      return inner === '' ? `${hashes}\n` : `${hashes} ${inner}\n`;
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
      const panelType = attrString(node, 'panelType') ?? 'info';
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
  if (typeof node.text === 'string' && node.text !== '') return node.text;
  return `[${typeLabel(type)}]`;
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
// never resolves anything. In particular it creates NO mentions: a `mention`
// node needs an accountId, the converter is pure and network-free, and a
// fabricated id produces a comment that pings the wrong person. `@name` stays
// literal text, which is exactly what Jira's own editor shows for an unresolved
// handle. The read direction keeps rendering mentions (CC-07), so the mention
// round trip is deliberately one-way.
// ---------------------------------------------------------------------------

/** Nesting cap for the inline scanner — `[[[[[…` must not own the stack. */
const MAX_INLINE_DEPTH = 8;

/** Deepest list nesting built; past it, items join the deepest open list. */
const MAX_PARSE_LIST_DEPTH = 16;

/** Bullet markers accepted on input. Only `-` is ever emitted. */
const BULLET_MARKERS = new Set(['-', '+', '*']);

/** What a backslash may escape (CommonMark's ASCII punctuation set). */
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!<>|~^$&\'"/:;,=?@%');

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
  readonly inline: AdfNode[];
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

/** How many times `ch` repeats starting at `start`. */
function runLength(text: string, start: number, ch: string): number {
  let n = 0;
  while (text.charAt(start + n) === ch) n += 1;
  return n;
}

/**
 * Index of the delimiter that closes the one just consumed, or -1. A code span
 * is stepped over rather than scanned: CommonMark binds code tighter than links
 * and emphasis, so the `[` in `` `[x` `` is literal and must not be counted —
 * counting it loses the link (or the emphasis) that wraps the span.
 */
function matchDelimiter(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') {
      const span = readCodeSpan(text, i);
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
function findDelimiter(text: string, from: number, delim: string): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') {
      const span = readCodeSpan(text, i);
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
): { readonly text: string; readonly next: number } | undefined {
  const length = runLength(text, start, '`');
  const fence = '`'.repeat(length);
  let from = start + length;
  while (from < text.length) {
    const at = text.indexOf(fence, from);
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
): { readonly label: string; readonly href: string; readonly next: number } | undefined {
  const labelEnd = matchDelimiter(text, start + 1, '[', ']');
  if (labelEnd === -1) return undefined;
  if (text.charAt(labelEnd + 1) !== '(') return undefined;
  const hrefEnd = matchDelimiter(text, labelEnd + 2, '(', ')');
  if (hrefEnd === -1) return undefined;

  const raw = text.slice(labelEnd + 2, hrefEnd).trim();
  const href = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  if (href === '') return undefined;
  return { label: text.slice(start + 1, labelEnd), href, next: hrefEnd + 1 };
}

function readEmphasis(
  text: string,
  start: number,
):
  | {
      readonly text: string;
      readonly strong: boolean;
      readonly em: boolean;
      readonly next: number;
    }
  | undefined {
  const run = Math.min(runLength(text, start, '*'), 3);
  for (let length = run; length >= 1; length -= 1) {
    const delim = '*'.repeat(length);
    const at = findDelimiter(text, start + length, delim);
    if (at === -1) continue;
    const inner = text.slice(start + length, at);
    if (inner === '') continue;
    return { text: inner, strong: length >= 2, em: length !== 2, next: at + length };
  }
  return undefined;
}

/** Add a mark to every text node, skipping nodes that already carry it. */
function addMark(nodes: readonly AdfNode[], mark: AdfNode): AdfNode[] {
  return nodes.map((node) => {
    if (node.type !== 'text') return node;
    const existing: unknown[] = Array.isArray(node.marks) ? node.marks : [];
    if (existing.some((m) => isRecord(m) && m.type === mark.type)) return node;
    return { ...node, marks: [...existing, mark] };
  });
}

/** One line of inline markdown → inline ADF nodes. Never throws. */
function parseInline(text: string, depth: number): AdfNode[] {
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
      const span = readCodeSpan(text, i);
      if (span !== undefined) {
        flush();
        out.push({ type: 'text', text: span.text, marks: [{ type: 'code' }] });
        i = span.next;
        continue;
      }
    }

    if (ch === '[' && depth < MAX_INLINE_DEPTH) {
      const link = readLink(text, i);
      if (link !== undefined) {
        flush();
        const mark: AdfNode = { type: 'link', attrs: { href: link.href } };
        out.push(...addMark(parseInline(link.label, depth + 1), mark));
        i = link.next;
        continue;
      }
    }

    if (ch === '*' && depth < MAX_INLINE_DEPTH) {
      const emphasis = readEmphasis(text, i);
      if (emphasis !== undefined) {
        flush();
        let nodes = parseInline(emphasis.text, depth + 1);
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
function paragraphNode(lines: readonly string[]): AdfNode {
  const inline: AdfNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) inline.push({ type: 'hardBreak' });
    inline.push(...parseInline(line, 0));
  });
  return { type: 'paragraph', content: inline };
}

function headingNode(level: number, text: string): AdfNode {
  return { type: 'heading', attrs: { level }, content: parseInline(text, 0) };
}

function codeBlockNode(language: string, text: string): AdfNode {
  const node: AdfNode = {
    type: 'codeBlock',
    content: text === '' ? [] : [{ type: 'text', text }],
  };
  if (language !== '') node.attrs = { language };
  return node;
}

function itemNode(inline: AdfNode[]): OpenItem {
  const children: AdfNode[] = [{ type: 'paragraph', content: inline }];
  return { node: { type: 'listItem', content: children }, children, inline };
}

/** A closing fence is a bare run of backticks at least as long as the opener. */
function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && /^`+$/.test(trimmed);
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
 */
export function adfFromMarkdown(text: string): AdfDoc {
  const source = typeof text === 'string' ? text : '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  const content: AdfNode[] = [];
  const stack: OpenList[] = [];
  let paragraph: string[] = [];
  let fence:
    { readonly marker: string; readonly language: string; body: string[] } | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    content.push(paragraphNode(paragraph));
    paragraph = [];
  };

  const openItem = (
    lineIndent: number,
    ordered: boolean,
    start: number,
    rest: string,
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
    const item = itemNode(parseInline(rest, 0));
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

  for (const line of lines) {
    if (fence !== undefined) {
      if (isFenceClose(line, fence.marker)) {
        content.push(codeBlockNode(fence.language, fence.body.join('\n')));
        fence = undefined;
      } else fence.body.push(line);
      continue;
    }

    const opening = FENCE.exec(line);
    if (opening !== null) {
      flushParagraph();
      stack.length = 0;
      fence = {
        marker: opening[1] ?? '```',
        language: (opening[2] ?? '').trim(),
        body: [],
      };
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      stack.length = 0;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph();
      stack.length = 0;
      content.push(headingNode((heading[1] ?? '#').length, heading[2] ?? ''));
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flushParagraph();
      const marker = item[2] ?? '-';
      const ordered = !BULLET_MARKERS.has(marker);
      const start = ordered ? Number.parseInt(marker, 10) : 1;
      openItem(indentWidth(item[1] ?? ''), ordered, start, item[3] ?? '');
      continue;
    }

    // Inside a list, a more-indented plain line continues the current item
    // rather than ending the list — that is what the renderer emits for an
    // item whose text runs over one line.
    const open = stack.at(-1);
    if (open !== undefined && indentWidth(line) > open.indent) {
      open.item.inline.push({ type: 'hardBreak' }, ...parseInline(line.trim(), 0));
      continue;
    }
    stack.length = 0;
    paragraph.push(line);
  }

  // An unterminated fence still yields its code block: dropping it would
  // silently swallow the rest of the document.
  if (fence !== undefined) {
    content.push(codeBlockNode(fence.language, fence.body.join('\n')));
  }
  flushParagraph();

  return { type: 'doc', version: 1, content };
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
