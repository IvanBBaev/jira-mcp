// ---------------------------------------------------------------------------
// File output for large reads (D152).
//
// A tool that declares `fileOutput` takes `output: "file"`: the registry runs
// the read as usual, then this module moves the page's rows out of the
// envelope into a JSONL file in JIRA_MEDIA_DIR and leaves a descriptor behind
// — the path, a `jira://exports/<name>` uri, the row count, the size and a
// short preview. Everything else in `data` (cursors, paging) stays inline, so
// the next call still knows where to continue: one page per file.
//
// The rows are redacted BEFORE they are written. The envelope is redacted
// again on render, but the file never passes through the renderer, so this is
// the only redaction its bytes get.
//
// Pure apart from the injected `MediaStore`: the name comes from the Clock and
// the Rng, never from the wall clock or `Math.random`.
// ---------------------------------------------------------------------------

import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import type { MediaStore } from '../api/attachments.js';
import { createJiraError } from '../core/errors.js';
import type { Clock, Rng } from '../core/types.js';
import { RESOURCE_NOT_FOUND } from './resources.js';
import type { ToolResult } from './types.js';

/** The scheme every export resource lives under. */
export const EXPORT_URI_PREFIX = 'jira://exports/';

/** The resource template a client fills with an export's file name. */
export const EXPORT_TEMPLATE = `${EXPORT_URI_PREFIX}{name}`;

/** One JSON document per line. */
export const EXPORT_MIME = 'application/jsonl';

/** How much of the file the envelope repeats inline. */
export const EXPORT_PREVIEW_CHARS = 2000;

/**
 * What an export file is called. Strict on purpose: the export resource reads
 * only names this module could have written, so `jira://exports/` is never a
 * general reader over JIRA_MEDIA_DIR. The optional `-N` is the media store's
 * collision variant.
 */
export const EXPORT_NAME_PATTERN =
  /^jira-export-[a-z0-9_]+-\d{8}T\d{6}Z-[0-9a-f]{8}(?:-\d{1,3})?\.jsonl$/;

/** The `data.export` descriptor that replaces the rows. */
export interface ExportDescriptor {
  readonly name: string;
  readonly path: string;
  readonly uri: string;
  readonly mimeType: string;
  /** Rows written — one line each. */
  readonly rows: number;
  readonly bytes: number;
  /** The first {@link EXPORT_PREVIEW_CHARS} characters of the file. */
  readonly preview: string;
  readonly preview_truncated?: true;
}

/** What {@link exportRows} needs besides the result. */
export interface ExportDeps {
  readonly media: MediaStore;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly redact: (value: unknown) => unknown;
}

/** `20261027T081500Z` — sortable and free of characters a file system minds. */
function stampOf(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** The file name for one export of `tool` (its `jira_` prefix dropped). */
export function exportFileName(tool: string, clock: Clock, rng: Rng): string {
  const hex = Math.floor(rng() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, '0')
    .slice(-8);
  return `jira-export-${tool.replace(/^jira_/, '')}-${stampOf(clock.now())}-${hex}.jsonl`;
}

/** The leading slice of `text` the envelope repeats, flagged when cut. */
export function previewOf(text: string): { preview: string; preview_truncated?: true } {
  return text.length <= EXPORT_PREVIEW_CHARS
    ? { preview: text }
    : { preview: text.slice(0, EXPORT_PREVIEW_CHARS), preview_truncated: true };
}

/** One row per line, newline-terminated; an empty page is an empty file. */
export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Move `data[rowsKey]` of a successful result into a file and put the
 * descriptor in its place. A failed result passes through untouched — there
 * is nothing to write. A result without an array under `rowsKey` is a bug in
 * the tool's declaration and throws.
 */
export async function exportRows(
  tool: string,
  rowsKey: string,
  result: ToolResult<unknown>,
  deps: ExportDeps,
): Promise<ToolResult<unknown>> {
  if (!result.ok) return result;
  const data = result.data;
  const rows = isRecord(data) ? data[rowsKey] : undefined;
  if (!isRecord(data) || !Array.isArray(rows)) {
    throw new Error(
      `${tool} declares fileOutput rows "${rowsKey}" but returned no such array.`,
    );
  }
  const redacted = deps.redact(rows);
  const text = toJsonl(Array.isArray(redacted) ? redacted : rows);
  const written = await deps.media.write(
    exportFileName(tool, deps.clock, deps.rng),
    new TextEncoder().encode(text),
  );
  const descriptor: ExportDescriptor = {
    name: written.name,
    path: written.path,
    uri: `${EXPORT_URI_PREFIX}${written.name}`,
    mimeType: EXPORT_MIME,
    rows: rows.length,
    bytes: written.bytes,
    ...previewOf(text),
  };
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== rowsKey) kept[key] = value;
  }
  return { ...result, data: { ...kept, output: 'file', export: descriptor } };
}

/** The `resource_link` content block for an envelope that carries an export. */
export function exportLinkOf(
  structured: Record<string, unknown>,
): CallToolResult['content'][number] | undefined {
  if (structured['ok'] !== true) return undefined;
  const data = structured['data'];
  const descriptor = isRecord(data) ? data['export'] : undefined;
  if (!isRecord(descriptor)) return undefined;
  const { uri, name, bytes } = descriptor;
  if (typeof uri !== 'string' || !uri.startsWith(EXPORT_URI_PREFIX)) return undefined;
  if (typeof name !== 'string') return undefined;
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType: EXPORT_MIME,
    ...(typeof bytes === 'number' ? { size: bytes } : {}),
  };
}

/** Whether `uri` addresses the export namespace at all. */
export function isExportUri(uri: string): boolean {
  return uri.startsWith(EXPORT_URI_PREFIX);
}

function exportNotFound(uri: string): McpError {
  return new McpError(
    RESOURCE_NOT_FOUND,
    `Unknown export "${uri}". Exports are the files a tool called with ` +
      'output: "file" wrote to JIRA_MEDIA_DIR; use the uri that call returned.',
  );
}

/**
 * Read one export back as a resource. Only a name matching
 * {@link EXPORT_NAME_PATTERN} is looked up, and only when a media directory
 * is configured; anything else, or a file that is gone, is "not found".
 */
export async function readExport(
  uri: string,
  media: MediaStore | undefined,
): Promise<ReadResourceResult> {
  const name = uri.slice(EXPORT_URI_PREFIX.length);
  if (media === undefined || !EXPORT_NAME_PATTERN.test(name)) throw exportNotFound(uri);
  let bytes: Uint8Array;
  try {
    ({ bytes } = await media.read(name));
  } catch {
    throw exportNotFound(uri);
  }
  return {
    contents: [{ uri, mimeType: EXPORT_MIME, text: new TextDecoder().decode(bytes) }],
  };
}

/** The config error for `output: "file"` without JIRA_MEDIA_DIR. */
export function noMediaDirError(tool: string): ReturnType<typeof createJiraError> {
  return createJiraError({
    kind: 'config',
    reason: `${tool} was called with output: "file", but JIRA_MEDIA_DIR is not set. Nothing was sent to Jira.`,
    remediation:
      'Set JIRA_MEDIA_DIR to a writable directory and restart the server, or call ' +
      'again without output (the rows come back inline).',
  });
}
