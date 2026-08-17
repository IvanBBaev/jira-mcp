// ---------------------------------------------------------------------------
// api/attachments.ts — attachment metadata, downloads and uploads (WP-70).
//
// Three routes and one seam:
//
//  1. **`GET /rest/api/3/issue/{issueIdOrKey}?fields=attachment`** — the list a
//     model actually wants: every attachment on one issue, in one call. The
//     per-attachment route (`GET /rest/api/3/attachment/{id}`) answers the same
//     record for a single id and is what the download path reads first.
//  2. **`GET /rest/api/3/attachment/content/{id}?redirect=false`** — the bytes.
//     `redirect=false` is deliberate: Jira otherwise answers 303 to a signed URL
//     on an Atlassian media host, and staying on the site host keeps the whole
//     transfer inside the allowed-host policy. `core/http.ts` can follow that
//     one redirect anonymously when a site insists on sending it.
//  3. **`POST /rest/api/3/issue/{issueIdOrKey}/attachments`** — the upload. A
//     `multipart/form-data` body whose file field MUST be named `file`, with
//     `X-Atlassian-Token: no-check`; the client owns both details.
//
// The seam is {@link MediaStore}: this module never imports `node:fs`. It hands
// the store a BASENAME and gets bytes or a written path back, which is what
// makes "the file never leaves JIRA_MEDIA_DIR" a property of the type rather
// than of a path check that a future caller can forget (D45). Two rules follow
// from that and are enforced here:
//
//  * a filename that came FROM Jira is untrusted tenant text — it is sanitized
//    to a safe basename ({@link safeMediaName}) before it can reach a disk;
//  * a filename that came FROM the model is not sanitized but REFUSED unless it
//    already is a plain basename ({@link requireLocalName}) — silently rewriting
//    it would upload a different file than the one that was asked for, and
//    accepting a path would turn this tool into a file-exfiltration primitive.
//
// Without a media directory the two byte-moving calls refuse with `kind=config`
// naming `JIRA_MEDIA_DIR`; metadata listing works regardless.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import { MAX_ATTACHMENT_BYTES, encodeSegment } from '../core/http-util.js';
import type { JiraError, JiraRequestFn, JiraResponse } from '../core/types.js';
import type { BudgetGuard } from './shared.js';

// ---------------------------------------------------------------------------
// 1. Wire constants
// ---------------------------------------------------------------------------

/** `GET /rest/api/3/attachment/{id}` — one attachment's metadata. */
export const ATTACHMENT_PATH_TEMPLATE = '/attachment/{id}';

/** `GET /rest/api/3/attachment/content/{id}` — the bytes. */
export const ATTACHMENT_CONTENT_PATH_TEMPLATE = '/attachment/content/{id}';

/** `GET /rest/api/3/issue/{issueIdOrKey}` — read with `fields=attachment`. */
export const ISSUE_PATH_TEMPLATE = '/issue/{issueIdOrKey}';

/** `POST /rest/api/3/issue/{issueIdOrKey}/attachments` — the upload. */
export const ISSUE_ATTACHMENTS_PATH_TEMPLATE = '/issue/{issueIdOrKey}/attachments';

/**
 * The multipart field name Jira requires. Not configurable and not guessable:
 * the endpoint rejects any other name (JIRA-API.md §Attachments).
 */
export const UPLOAD_FIELD_NAME = 'file';

/** Content type used when neither Jira nor the caller names one. */
export const DEFAULT_ATTACHMENT_MIME = 'application/octet-stream';

// ---------------------------------------------------------------------------
// 2. Public shapes
// ---------------------------------------------------------------------------

/** The author of an attachment, narrowed to the two fields anything prints. */
export interface AttachmentAuthor {
  readonly accountId: string;
  readonly displayName?: string;
}

/**
 * One attachment record, built field by field from Jira's row (D41 — allowlist
 * by construction). Jira's own record also carries `self`, `content` and
 * `thumbnail` URLs; none of them survive this narrowing, because a signed URL
 * in a tool result is a credential the model has no use for.
 */
export interface JiraAttachment {
  readonly id: string;
  /** Jira's filename. UNTRUSTED tenant text — never used as a path (D45). */
  readonly filename: string;
  readonly size?: number;
  readonly mimeType?: string;
  readonly author?: AttachmentAuthor;
  /** ISO-8601 timestamp Jira recorded. */
  readonly created?: string;
}

/**
 * The local-disk seam. Every method takes a BASENAME, never a path: the store
 * owns the directory and joins internally, so "write outside JIRA_MEDIA_DIR" is
 * not expressible through this interface.
 *
 * Implemented over `node:fs/promises` in the tools ring (the composition root),
 * and over an in-memory map in tests.
 */
export interface MediaStore {
  /** Absolute path of the media directory, for messages and results. */
  readonly dir: string;
  /**
   * Write bytes under `name`, NEVER overwriting: on collision the store picks
   * a free variant and reports the name it actually used.
   */
  write(name: string, bytes: Uint8Array): Promise<MediaWriteResult>;
  /** Read a file from the media directory. Refuses one over the size cap. */
  read(name: string): Promise<MediaReadResult>;
}

/** What a {@link MediaStore.write} actually did. */
export interface MediaWriteResult {
  /** The basename on disk — equal to the requested one unless it collided. */
  readonly name: string;
  /** Absolute path, for the tool result. */
  readonly path: string;
  readonly bytes: number;
}

/** What a {@link MediaStore.read} returned. */
export interface MediaReadResult {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Common options: the wire seam plus cancellation. */
export interface AttachmentCallBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request. */
  readonly signal?: AbortSignal;
}

/** Options for {@link listAttachments}. */
export type ListAttachmentsOptions = AttachmentCallBase &
  BudgetGuard & {
    /** Issue key or id, e.g. `ABC-1`. */
    readonly issueKey: string;
  };

/** What {@link listAttachments} returns. */
export interface ListAttachmentsResult {
  /** The key Jira echoed, which may differ from the input (an id, a moved issue). */
  readonly issueKey: string;
  readonly attachments: readonly JiraAttachment[];
}

/** Options for {@link getAttachment}. */
export type GetAttachmentOptions = AttachmentCallBase &
  BudgetGuard & {
    readonly attachmentId: string;
  };

/** Options for {@link downloadAttachment}. */
export type DownloadAttachmentOptions = AttachmentCallBase &
  BudgetGuard & {
    readonly attachmentId: string;
    /** Absent means `JIRA_MEDIA_DIR` is unset — the call refuses. */
    readonly store?: MediaStore;
  };

/** What {@link downloadAttachment} wrote. */
export interface DownloadAttachmentResult {
  readonly attachment: JiraAttachment;
  /** Absolute path of the written file. */
  readonly path: string;
  /** Basename on disk after sanitization and collision handling. */
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  /** The name on disk differs from Jira's filename (sanitized or uniquified). */
  readonly renamed: boolean;
}

/** Options for {@link uploadAttachment}. */
export type UploadAttachmentOptions = AttachmentCallBase &
  BudgetGuard & {
    /** Issue key or id the file is attached to. */
    readonly issueKey: string;
    /** Basename of a file inside `JIRA_MEDIA_DIR`. Paths are refused. */
    readonly name: string;
    /** Overrides the part's content type; defaults to octet-stream. */
    readonly contentType?: string;
    /** Absent means `JIRA_MEDIA_DIR` is unset — the call refuses. */
    readonly store?: MediaStore;
  };

/** What {@link uploadAttachment} created. */
export interface UploadAttachmentResult {
  /** The records Jira created — normally one per uploaded part. */
  readonly attachments: readonly JiraAttachment[];
  /** The local file that was sent. */
  readonly name: string;
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// 3. Filename safety (D45)
// ---------------------------------------------------------------------------

/**
 * Longest basename this server writes. Filesystems allow 255 bytes; a Jira
 * filename can be far longer than that in UTF-8, and a 120-character cap leaves
 * room for a `-1` collision suffix without any byte-length arithmetic.
 */
export const MAX_MEDIA_NAME_CHARS = 120;

/** Used when nothing printable survives sanitization. */
export const FALLBACK_MEDIA_NAME = 'attachment';

/** Longest suffix still treated as an extension worth preserving. */
const MAX_EXTENSION_CHARS = 12;

/** Characters no filename may carry, whatever the host filesystem tolerates. */
const FORBIDDEN_NAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*', '/', '\\']);

/** Windows device names, which are unusable as files even with an extension. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Turn a Jira-supplied filename into a basename that is safe to create inside
 * the media directory.
 *
 * Total, never throws: a download must not fail because a tenant attached
 * `../../.ssh/authorized_keys`. Everything dangerous is removed and the worst
 * case is the {@link FALLBACK_MEDIA_NAME} placeholder. What it removes:
 * directory components (both separator families, so a Windows-style path cannot
 * survive on a POSIX host), control characters, the characters Windows refuses,
 * leading dots (`..`, and hidden files nobody asked for), trailing dots and
 * spaces (silently stripped by Windows, which would defeat a suffix check), and
 * anything past {@link MAX_MEDIA_NAME_CHARS} — extension first.
 */
export function safeMediaName(raw: string): string {
  const tail = raw.split(/[/\\]/).pop() ?? '';

  let cleaned = '';
  for (const ch of tail) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 controls and DEL: a newline or a NUL in a path is either an attack or
    // a bug, never a filename.
    if (code < 0x20 || code === 0x7f) continue;
    if (FORBIDDEN_NAME_CHARS.has(ch)) continue;
    cleaned += ch;
  }

  const trimmed = stripTrailing(cleaned.trim().replace(/^\.+/, ''));
  const base = trimmed === '' ? FALLBACK_MEDIA_NAME : trimmed;
  const guarded = RESERVED_NAME.test(base) ? `_${base}` : base;
  return truncateName(guarded);
}

/** Strip trailing dots and spaces, which Windows drops on creation. */
function stripTrailing(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1];
    if (ch !== '.' && ch !== ' ') break;
    end -= 1;
  }
  return value.slice(0, end);
}

/** Cap the length, keeping a short extension so the file stays openable. */
function truncateName(name: string): string {
  if (name.length <= MAX_MEDIA_NAME_CHARS) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= MAX_EXTENSION_CHARS ? name.slice(dot) : '';
  return `${name.slice(0, MAX_MEDIA_NAME_CHARS - ext.length)}${ext}`;
}

/**
 * Accept a MODEL-supplied name only if it already is a plain basename inside
 * the media directory, and refuse everything else.
 *
 * This is the upload half of D45 and it deliberately does NOT sanitize: an
 * upload names a file that must already exist, so rewriting the name would
 * either fail confusingly or send the wrong file. Refusing keeps the property
 * that the model can reach exactly the files an operator put in
 * `JIRA_MEDIA_DIR` and nothing else — no absolute paths, no `..`, no
 * subdirectories, no Windows drive letters, no NUL truncation tricks.
 */
export function requireLocalName(raw: string): string {
  const value = raw.trim();
  const refuse = (why: string): JiraError =>
    createJiraError({
      kind: 'validation',
      reason: `"${raw}" is not usable as an upload source: ${why}.`,
      remediation:
        'Pass the plain file name of a file inside JIRA_MEDIA_DIR — this server never reads a path, an absolute location or a subdirectory.',
    });

  if (value === '') throw refuse('it is empty');
  if (value === '.' || value === '..') throw refuse('it names a directory');
  if (value.startsWith('.')) throw refuse('it starts with a dot');
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw refuse('it contains a control character');
    if (FORBIDDEN_NAME_CHARS.has(ch)) throw refuse(`it contains "${ch}"`);
  }
  if (value.length > MAX_MEDIA_NAME_CHARS) throw refuse('it is too long');
  return value;
}

// ---------------------------------------------------------------------------
// 4. Metadata
// ---------------------------------------------------------------------------

/**
 * Every attachment on one issue, read through the issue itself
 * (`fields=attachment`) — one call, and it works for an issue key as well as an
 * id. Needs no media directory: metadata is not a file.
 */
export async function listAttachments(
  options: ListAttachmentsOptions,
): Promise<ListAttachmentsResult> {
  const key = requireIssueKey(options.issueKey);
  const response = await options.jira({
    method: 'GET',
    path: `/issue/${encodeSegment(key, 'issue key or id')}`,
    pathTemplate: ISSUE_PATH_TEMPLATE,
    query: { fields: 'attachment' },
    ...callExtras(options),
  });

  const body = requireRecord(response.data, 'the issue response');
  const fields = body['fields'];
  const rows = isRecord(fields) ? fields['attachment'] : undefined;
  if (rows === undefined || rows === null) {
    // A project with attachments disabled, or a field the caller cannot see:
    // an empty list is the honest answer, not a shape failure.
    return { issueKey: readString(body, 'key') ?? key, attachments: [] };
  }
  if (!Array.isArray(rows)) {
    throw shapeError('the issue\'s "attachment" field is not an array');
  }

  return {
    issueKey: readString(body, 'key') ?? key,
    attachments: rows.map((row, index) =>
      toJiraAttachment(row, `attachment at position ${index}`),
    ),
  };
}

/** One attachment's metadata by id (`GET /rest/api/3/attachment/{id}`). */
export async function getAttachment(
  options: GetAttachmentOptions,
): Promise<JiraAttachment> {
  const id = requireAttachmentId(options.attachmentId);
  const response = await options.jira({
    method: 'GET',
    path: `/attachment/${encodeSegment(id, 'attachment id')}`,
    pathTemplate: ATTACHMENT_PATH_TEMPLATE,
    ...callExtras(options),
  });
  return toJiraAttachment(response.data, 'the attachment response');
}

// ---------------------------------------------------------------------------
// 5. Download
// ---------------------------------------------------------------------------

/**
 * Fetch one attachment's bytes and write them into the media directory.
 *
 * Two calls, in this order on purpose: the metadata read names the file and
 * gives a size to check BEFORE any bytes move, so an oversized attachment costs
 * one cheap GET instead of a 50 MiB transfer that is thrown away at the end.
 * `redirect=false` keeps the content read on the site host (JIRA-API.md); the
 * client still knows how to follow a single media redirect for sites that send
 * one anyway.
 */
export async function downloadAttachment(
  options: DownloadAttachmentOptions,
): Promise<DownloadAttachmentResult> {
  const store = requireStore(options.store, 'download');
  const attachment = await getAttachment(options);

  if (attachment.size !== undefined && attachment.size > MAX_ATTACHMENT_BYTES) {
    throw tooLarge(attachment.size);
  }

  const id = requireAttachmentId(options.attachmentId);
  const response: JiraResponse<unknown> = await options.jira({
    method: 'GET',
    path: `/attachment/content/${encodeSegment(id, 'attachment id')}`,
    pathTemplate: ATTACHMENT_CONTENT_PATH_TEMPLATE,
    // Ask Jira to serve the bytes itself instead of redirecting to a signed
    // media URL; the client refuses to follow more than one redirect anyway.
    query: { redirect: false },
    accept: 'binary',
    ...callExtras(options),
  });

  const bytes = response.data;
  if (!(bytes instanceof Uint8Array)) {
    throw shapeError('the attachment content response carried no bytes');
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw tooLarge(bytes.byteLength);

  const written = await store.write(safeMediaName(attachment.filename), bytes);
  return {
    attachment,
    path: written.path,
    name: written.name,
    bytes: written.bytes,
    mimeType: attachment.mimeType ?? DEFAULT_ATTACHMENT_MIME,
    renamed: written.name !== attachment.filename,
  };
}

// ---------------------------------------------------------------------------
// 6. Upload
// ---------------------------------------------------------------------------

/**
 * Attach a file from the media directory to an issue.
 *
 * An unsafe write by construction: `core/http.ts` never replays a multipart
 * POST on an ambiguous failure, so a timeout surfaces as `ambiguous_write` and
 * the caller re-reads the attachment list instead of risking a duplicate.
 */
export async function uploadAttachment(
  options: UploadAttachmentOptions,
): Promise<UploadAttachmentResult> {
  const store = requireStore(options.store, 'upload');
  const key = requireIssueKey(options.issueKey);
  const name = requireLocalName(options.name);

  const file = await store.read(name);
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw tooLarge(file.bytes.byteLength);

  const response = await options.jira({
    method: 'POST',
    path: `/issue/${encodeSegment(key, 'issue key or id')}/attachments`,
    pathTemplate: ISSUE_ATTACHMENTS_PATH_TEMPLATE,
    multipart: [
      {
        field: UPLOAD_FIELD_NAME,
        filename: name,
        contentType: options.contentType ?? DEFAULT_ATTACHMENT_MIME,
        bytes: file.bytes,
      },
    ],
    ...callExtras(options),
  });

  const rows = response.data;
  if (!Array.isArray(rows)) {
    throw shapeError('the upload response is not an array of attachments');
  }
  return {
    attachments: rows.map((row, index) =>
      toJiraAttachment(row, `created attachment at position ${index}`),
    ),
    name,
    bytes: file.bytes.byteLength,
  };
}

// ---------------------------------------------------------------------------
// 7. Response narrowing
// ---------------------------------------------------------------------------

/** Narrow one attachment record; `id` and `filename` are the required pair. */
function toJiraAttachment(row: unknown, what: string): JiraAttachment {
  const record = requireRecord(row, what);
  const id = readIdentifier(record, 'id');
  if (id === undefined) throw shapeError(`${what} has no "id"`);
  const filename = readString(record, 'filename');
  if (filename === undefined) throw shapeError(`${what} has no "filename"`);

  const size = record['size'];
  const author = toAuthor(record['author']);
  return {
    id,
    filename,
    ...(typeof size === 'number' && Number.isFinite(size) ? { size } : {}),
    ...optionalString(record, 'mimeType'),
    ...(author === undefined ? {} : { author }),
    ...optionalString(record, 'created'),
  };
}

/** Narrow the author sub-record; anything without an accountId is dropped. */
function toAuthor(value: unknown): AttachmentAuthor | undefined {
  if (!isRecord(value)) return undefined;
  const accountId = readString(value, 'accountId');
  if (accountId === undefined) return undefined;
  return { accountId, ...optionalString(value, 'displayName') };
}

// ---------------------------------------------------------------------------
// 8. Input normalization and small helpers
// ---------------------------------------------------------------------------

/** The store, or the `kind=config` refusal that names the missing setting. */
function requireStore(store: MediaStore | undefined, what: string): MediaStore {
  if (store !== undefined) return store;
  throw createJiraError({
    kind: 'config',
    reason: `This server cannot ${what} attachment files because JIRA_MEDIA_DIR is not set.`,
    remediation:
      'Set JIRA_MEDIA_DIR to a directory this server may read and write, then restart it. Listing attachment metadata needs no media directory.',
  });
}

function requireIssueKey(value: string): string {
  return requireText(value, 'issue key or id', 'Pass an issue key such as ABC-1.');
}

function requireAttachmentId(value: string): string {
  return requireText(
    value,
    'attachment id',
    'Pass the numeric id from jira_list_attachments.',
  );
}

function requireText(value: string, what: string, remediation: string): string {
  const text = value.trim();
  if (text === '') {
    throw createJiraError({
      kind: 'validation',
      reason: `An empty ${what} is not a valid reference.`,
      remediation,
    });
  }
  return text;
}

/** The size refusal, worded the same way the client words its own (CC-15). */
function tooLarge(bytes: number): JiraError {
  return createJiraError({
    kind: 'validation',
    reason: `That attachment is ${String(bytes)} bytes, over the ${String(MAX_ATTACHMENT_BYTES)}-byte limit this server transfers.`,
    remediation:
      'This limit is compiled in and has no environment override. Handle the file outside this server.',
  });
}

/** `signal`/`deadlineAt` spread onto a request spec, both optional. */
function callExtras(options: AttachmentCallBase & BudgetGuard): Record<string, unknown> {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw shapeError(`${what} is not a JSON object`);
  return value;
}

/** A non-empty string field, or `undefined`. */
function readString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** An id field, which Jira sends as a string but has been known to send as a number. */
function readIdentifier(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(row, key);
}

function optionalString(
  row: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = readString(row, key);
  return value === undefined ? {} : { [key]: value };
}

function shapeError(what: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason: `Jira's attachment response could not be read: ${what}.`,
  });
}
