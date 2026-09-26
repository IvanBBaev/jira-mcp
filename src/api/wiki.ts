// ---------------------------------------------------------------------------
// api/wiki.ts — Jira wiki markup flattened to plain text (Phase 13, stage
// 13.3b, D106).
//
// Jira Data Center's REST v2 carries rich text as wiki markup, where Cloud's v3
// carries ADF. `adfToText` gives Cloud reads one plain-text convention; this
// module gives Data Center reads the SAME convention, so a model reading
// `text` gets the same shape of answer from either product:
//
//   headings → their text          lists → `- item` / `1. item`, 2-space nesting
//   *bold* _italic_ {{mono}} …    → the text, marks removed
//   [text|url]                     → text          [url] → url
//   [~username]                    → @username     (Data Center mentions)
//   !file.png|thumbnail!           → [media: file.png]
//   {code:js}…{code} / {noformat}  → a ``` fence, content verbatim
//   {quote}…{quote} / bq. x        → the text
//   {info}/{note}/{warning}/{tip}  → [panel:info] … (the ADF panel spelling)
//   ||h1||h2|| / |a|b|             → `h1 | h2` / `a | b`
//   ----                           → ---           \\ → a line break
//
// Conservative by design:
//
//   * Pure and total: never throws, never touches the network, and returns
//     its input unchanged in spirit when it recognises nothing.
//   * An inline mark is removed only when it is PAIRED on one line with the
//     boundaries Jira itself requires (a non-word character or the line edge
//     outside, a non-space inside) — `2026-09-26`, `a*b` and `x - y - z` are
//     left alone.
//   * An unknown `{macro}` is left as written: a visible token is better than
//     silently dropping content nobody here understood.
//   * Lines longer than {@link MAX_INLINE_LINE_CHARS} skip inline processing,
//     so a hostile line cannot make the pairing regexes quadratic.
//
// It is a READ-side rendering only. The write side (markdown → wiki) is stage
// 13.4 and is not here.
// ---------------------------------------------------------------------------

/** Longest line that inline marks are removed from; longer ones pass verbatim. */
export const MAX_INLINE_LINE_CHARS = 10_000;

/** Private-use sentinels for parked escapes and line breaks (see `inline`). */
const ESCAPE = '\uE000';
const BREAK = '\uE001';
const SENTINEL_RE = /[\uE000\uE001]/;
const ESCAPED_RE = /\uE000(\d+)\uE000/g;

/** The panel-like macros, rendered with the ADF panel spelling. */
const PANEL_MACROS: ReadonlySet<string> = new Set([
  'info',
  'note',
  'warning',
  'tip',
  'panel',
]);

const CODE_OPEN_RE = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/;
const HEADING_RE = /^\s*h[1-6]\.\s+(.*)$/;
const QUOTE_LINE_RE = /^\s*bq\.\s+(.*)$/;
const LIST_RE = /^\s*([*#-]+)\s+(.*)$/;
const RULE_RE = /^\s*-{4,}\s*$/;
const TABLE_RE = /^\s*\|\|?(.*?)\|?\|?\s*$/;

/**
 * Flatten Jira wiki markup to plain text, in the conventions of `adfToText`.
 * A non-string input yields `''`, as `adfToText` does for a non-document.
 */
export function wikiToText(input: unknown): string {
  if (typeof input !== 'string') return '';
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const listCounters: number[] = [];
  // The kind at each depth: a bullet list and a numbered one are separate lists.
  const listKinds: boolean[] = [];
  // Panel macros open and close with the same tag; the second one closes.
  const openPanels = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    // {code}/{noformat}: content verbatim up to the closing tag.
    const code = CODE_OPEN_RE.exec(line);
    if (code !== null) {
      const tag = code[1] ?? 'code';
      const language = tag === 'code' ? languageOf(code[2]) : '';
      const body: string[] = [];
      const close = `{${tag}}`;
      let rest = code[3] ?? '';
      // An unclosed block still renders what it had; nothing is dropped.
      for (;;) {
        const at = rest.indexOf(close);
        if (at >= 0) {
          body.push(rest.slice(0, at));
          break;
        }
        body.push(rest);
        i += 1;
        if (i >= lines.length) break;
        rest = lines[i] ?? '';
      }
      while (body.length > 0 && body[0] === '') body.shift();
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      listCounters.length = 0;
      listKinds.length = 0;
      out.push('```' + language, ...body, '```');
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '') {
      listCounters.length = 0;
      listKinds.length = 0;
      continue;
    }

    // Block macros on a line of their own.
    const macro = /^\{(\w+)(?::[^}]*)?\}$/.exec(trimmed);
    if (macro !== null) {
      const name = (macro[1] ?? '').toLowerCase();
      if (name === 'quote' || name === 'color') continue;
      if (PANEL_MACROS.has(name)) {
        if (openPanels.has(name)) {
          openPanels.delete(name);
        } else {
          openPanels.add(name);
          out.push(name === 'panel' ? '[panel]' : `[panel:${name}]`);
        }
        continue;
      }
    }

    if (RULE_RE.test(line)) {
      listCounters.length = 0;
      listKinds.length = 0;
      out.push('---');
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      listCounters.length = 0;
      listKinds.length = 0;
      pushText(out, inline(heading[1] ?? ''));
      continue;
    }

    const quote = QUOTE_LINE_RE.exec(line);
    if (quote !== null) {
      listCounters.length = 0;
      listKinds.length = 0;
      pushText(out, inline(quote[1] ?? ''));
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list !== null && isListMarker(list[1] ?? '')) {
      const markers = list[1] ?? '';
      const depth = markers.length;
      listCounters.length = depth;
      listKinds.length = depth;
      const ordered = markers.endsWith('#');
      if (listKinds[depth - 1] !== ordered) listCounters[depth - 1] = 0;
      listKinds[depth - 1] = ordered;
      const count = (listCounters[depth - 1] ?? 0) + 1;
      listCounters[depth - 1] = count;
      const bullet = ordered ? `${String(count)}.` : '-';
      out.push(`${'  '.repeat(depth - 1)}${bullet} ${inline(list[2] ?? '')}`.trimEnd());
      continue;
    }
    listCounters.length = 0;
    listKinds.length = 0;

    if (trimmed.startsWith('|')) {
      const table = TABLE_RE.exec(trimmed);
      if (table !== null) {
        const cells = splitCells(table[1] ?? '').map((cell) => inline(cell.trim()));
        pushText(out, cells.join(' | '));
        continue;
      }
    }

    pushText(out, inline(stripBlockMacros(line)));
  }

  return out.join('\n').trimEnd();
}

/** `{code:language=js|title=x}` and `{code:js}` both name the language. */
function languageOf(params: string | undefined): string {
  if (params === undefined) return '';
  const first = params.split('|')[0]?.trim() ?? '';
  const value = first.includes('=')
    ? first.startsWith('language=')
      ? first.slice('language='.length)
      : ''
    : first;
  return /^[\w+#.-]{1,32}$/.test(value) ? value : '';
}

/** `*`, `**`, `#`, `#*`… are list markers; a bare `-` only at depth one. */
function isListMarker(markers: string): boolean {
  if (markers === '-') return true;
  return /^[*#]+$/.test(markers);
}

/**
 * Split a table row on `|` / `||`, but not inside `[...]`: a link or a mention
 * in a cell carries a `|` of its own.
 */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let depth = 0;
  let cell = '';
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i] ?? '';
    if (ch === '[') depth += 1;
    else if (ch === ']' && depth > 0) depth -= 1;
    if (ch === '|' && depth === 0) {
      cells.push(cell);
      cell = '';
      if (row[i + 1] === '|') i += 1;
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** Push a rendered line, splitting on the line breaks `\\` produced. */
function pushText(out: string[], text: string): void {
  for (const part of text.split('\n')) {
    const cleaned = part.trimEnd();
    if (cleaned !== '') out.push(cleaned);
  }
}

/** Inline `{quote}` and `{color}` tags inside a line are markup, not text. */
function stripBlockMacros(line: string): string {
  return line.replace(/\{(?:quote|color(?::[^}]*)?)\}/gi, '');
}

/**
 * The inline marks, in the order that keeps them from interfering: escapes are
 * protected first, then links and images (whose targets must not be read as
 * marks), then the paired marks, then the line break.
 */
function inline(text: string): string {
  if (text.length > MAX_INLINE_LINE_CHARS) return text;
  // Escapes and `\\` line breaks are parked behind private-use sentinels while
  // the marks are removed. A line that already contains a sentinel character
  // skips that parking rather than risk rewriting its own text.
  const park = !SENTINEL_RE.test(text);
  const escapes: string[] = [];
  let s = text;
  if (park) {
    // `\\` first, so the escape rule cannot read its second backslash as
    // escaping the character after it.
    s = s.replace(/\\\\/g, BREAK);
    s = s.replace(/\\([*_+\-^~?{}[\]!|])/g, (_m, ch: string) => {
      escapes.push(ch);
      return `${ESCAPE}${String(escapes.length - 1)}${ESCAPE}`;
    });
  }

  s = s.replace(/\{\{(.+?)\}\}/g, '$1');
  // An image names a file with an extension, or a URL — `Wow!Great!` is prose.
  s = s.replace(
    /!((?:https?:\/\/[^!\s|]+)|(?:[^!\s|][^!|\n]*?\.[A-Za-z0-9]{2,5}))(?:\|[^!\n]*)?!/g,
    (_m, file: string) => `[media: ${file.trim()}]`,
  );
  s = s.replace(/\[([^\]|\n]*)\|([^\]\n]*)\]/g, (_m, label: string, target: string) => {
    const shown = label.trim();
    return shown === '' ? (target.split('|')[0]?.trim() ?? '') : shown;
  });
  s = s.replace(/\[~([^\]\n]+)\]/g, '@$1');
  s = s.replace(/\[\^([^\]\n]+)\]/g, '$1');
  s = s.replace(/\[((?:https?|mailto|ftp):[^\]\s]+)\]/g, '$1');

  for (const mark of ['*', '_', '-', '+', '^', '~']) s = unmark(s, mark);
  s = s.replace(/(^|[^\w?])\?\?(?=\S)(.*?\S)\?\?(?![\w?])/g, '$1$2');
  s = s.replace(/\{color(?::[^}]*)?\}/gi, '');
  if (!park) return s;

  s = s.split(BREAK).join('\n');
  return s.replace(ESCAPED_RE, (_m, n: string) => escapes[Number(n)] ?? '');
}

/** Remove one paired inline mark, with Jira's boundary rules on both sides. */
function unmark(text: string, mark: string): string {
  // Two escapings: `-` needs one only inside a class, `*`/`+` only outside,
  // `^` in both — and under the `u` flag a needless escape is a syntax error.
  const out = /[*+^]/.test(mark) ? `\\${mark}` : mark;
  const cls = /[-^]/.test(mark) ? `\\${mark}` : mark;
  const re = new RegExp(
    `(^|[^\\p{L}\\p{N}${cls}])${out}(?=[^\\s${cls}])([^${cls}\\n]*?[^\\s${cls}])${out}(?![\\p{L}\\p{N}${cls}])`,
    'gu',
  );
  return text.replace(
    re,
    (_whole: string, before: string, inner: string) => `${before}${inner}`,
  );
}
