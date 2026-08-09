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
}

function deeper(state: FlattenState): FlattenState {
  return { depth: state.depth + 1, listDepth: state.listDepth };
}

function listIndent(listDepth: number): string {
  const levels = Math.min(Math.max(listDepth - 1, 0), MAX_LIST_INDENT_DEPTH);
  return LIST_INDENT_UNIT.repeat(levels);
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
      nested += flatten(child, { depth: state.depth + 1, listDepth: state.listDepth });
    } else {
      lead += flatten(child, { depth: state.depth + 1, listDepth: state.listDepth });
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
      nested += flatten(child, { depth: state.depth + 1, listDepth: state.listDepth });
    } else {
      lead += flatten(child, { depth: state.depth + 1, listDepth: state.listDepth });
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

/** Blocks whose children are inline, so they terminate their own line. */
const LEAF_BLOCKS = new Set(['paragraph', 'heading', 'mediaSingle', 'decisionItem']);

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
    case 'text':
      return typeof node.text === 'string' ? node.text : '';
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
    case 'rule':
      return '---\n';
    case 'codeBlock': {
      const language = attrString(node, 'language') ?? '';
      return `\`\`\`${language}\n${flattenChildren(node, deeper(state))}\n\`\`\`\n`;
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
    case 'orderedList':
      return renderList(node, state);
    case 'taskList':
      return flattenChildren(node, {
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
  return flatten(node, { depth: 0, listDepth: 0 }).trimEnd();
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
