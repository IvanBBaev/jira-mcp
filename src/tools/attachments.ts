// ---------------------------------------------------------------------------
// Package `attachments` — files on issues (TOOLS.md §Package `attachments`, WP-70).
//
// Three tools and one composition decision:
//
//  * `jira_list_attachments` — metadata only. Works on any server; needs no
//    local directory, because a list of filenames is not a file.
//  * `jira_download_attachment` — Jira's bytes onto local disk, INSIDE
//    `JIRA_MEDIA_DIR` and nowhere else.
//  * `jira_upload_attachment` — a file from that same directory onto an issue.
//
// THE DIRECTORY IS THE WHOLE SECURITY MODEL (D45). This module owns the only
// `node:fs` code in the package: `api/attachments.ts` talks to a
// {@link MediaStore} whose methods take a BASENAME, so "read/write outside
// JIRA_MEDIA_DIR" is not expressible through the seam. Three properties are
// asserted in `attachments.test.ts` and none of them may be relaxed:
//
//   1. every path is `join(dir, name)` and is re-resolved and prefix-checked
//      before the file is touched — belt and braces over the name rules;
//   2. a download NEVER overwrites: `open(…, 'wx')` fails on collision and the
//      store picks `name-1.ext`, reporting the name it really used;
//   3. an upload names a file that must already be in the directory. The model
//      cannot pass a path, and a symlink in the directory is resolved and
//      refused if it leaves it, so it cannot make this server read
//      `~/.ssh/id_rsa` either directly or through a link someone left behind.
//
// WHY `jira_download_attachment` IS A READ (D-row in the WP-70 handoff). It
// mutates local disk, which reads like a write — but `readOnlyHint: false` in
// this server means "goes through the plan/apply gate", and the gate captures
// unsafe REQUESTS (`mcp/write-mode.ts`). A download issues two GETs, so plan
// mode would capture nothing, run the handler to completion — writing the file
// — and return a normal result with no plan: a write tier that silently
// executes. Read-only towards JIRA is the honest annotation; `idempotentHint`
// is false because a second call adds a second file rather than replacing the
// first, and the description says the tool writes to disk in its first line.
//
// Layering: `core ← api ← mcp ← tools`. Tools are the composition root — this
// is where a filesystem and a media directory legally enter the program.
// ---------------------------------------------------------------------------

import { lstat, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import {
  DEFAULT_ATTACHMENT_MIME,
  MAX_MEDIA_NAME_CHARS,
  downloadAttachment,
  listAttachments,
  uploadAttachment,
  type JiraAttachment,
  type MediaReadResult,
  type MediaStore,
  type MediaWriteResult,
} from '../api/attachments.js';
import { createJiraError, isJiraError } from '../core/errors.js';
import { MAX_ATTACHMENT_BYTES } from '../core/http-util.js';
import { defineTool, toolInput, writeToolInput, z } from '../mcp/define.js';
import { ok } from '../mcp/result.js';
import { WRITE_ANNOTATIONS, callBase, guarded } from '../mcp/tool-helpers.js';
import type { PackageSpec, ToolAnnotations, ToolResult, ToolSpec } from '../mcp/types.js';

// ---------------------------------------------------------------------------
// 1. The filesystem store
// ---------------------------------------------------------------------------

/** File mode for everything this server creates — `core/journal.ts` §mode. */
export const MEDIA_FILE_MODE = 0o600;

/**
 * How many `name-N.ext` variants are tried before a download gives up. A
 * directory holding a hundred copies of one filename is a stuck loop, not a
 * workflow, and an unbounded search would hide it.
 */
export const MAX_NAME_COLLISIONS = 100;

/** Longest suffix still treated as an extension when uniquifying. */
const MAX_EXTENSION_CHARS = 12;

/**
 * The `node:fs` implementation of the api ring's seam, rooted at one directory.
 *
 * The root is resolved ONCE, here, and every operation re-checks that the
 * joined path is still under it. The name rules in `api/attachments.ts` already
 * make an escape impossible; this is the second lock, because the cost of being
 * wrong is arbitrary local file access (THREAT-MODEL.md §Local filesystem).
 *
 * Nothing is created or stat-ed at construction: a bad `JIRA_MEDIA_DIR` must
 * not take the server down at startup, since every other package works without
 * one. The first download or upload reports the problem as `kind: 'config'`.
 */
export function createNodeMediaStore(dir: string): MediaStore {
  const root = resolve(dir);

  /** Join, then verify — the joined path must stay under {@link root}. */
  const pathOf = (name: string): string => {
    const target = resolve(join(root, name));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw createJiraError({
        kind: 'validation',
        reason: `"${name}" resolves outside the media directory.`,
        remediation:
          'Pass a plain file name. This server only reads and writes files directly inside JIRA_MEDIA_DIR.',
      });
    }
    if (target === root) {
      throw createJiraError({
        kind: 'validation',
        reason: `"${name}" names the media directory itself, not a file in it.`,
        remediation: 'Pass the name of a file inside JIRA_MEDIA_DIR.',
      });
    }
    return target;
  };

  return {
    dir: root,

    async write(name: string, bytes: Uint8Array): Promise<MediaWriteResult> {
      // The `wx` flag is the no-overwrite rule itself: the kernel decides, so
      // there is no exists-then-write window for a concurrent call to slip
      // through. A collision is answered with the next variant, never with a
      // clobbered file.
      for (let attempt = 0; attempt <= MAX_NAME_COLLISIONS; attempt += 1) {
        const candidate = attempt === 0 ? name : variantOf(name, attempt);
        const path = pathOf(candidate);
        try {
          const handle = await open(path, 'wx', MEDIA_FILE_MODE);
          try {
            const { bytesWritten } = await handle.write(bytes);
            // A short write is not a syscall error: the kernel may accept
            // fewer bytes than it was offered, and a filesystem running out
            // of room is the everyday way that happens. Returning here would
            // report a truncated file as a completed download — and the name
            // would stay taken, so a later `read` would upload the stub to
            // Jira as if it were the whole attachment.
            //
            // NO TEST DRIVES THIS ARM (and none can, here): `write(2)` returns
            // short only when the volume fills up mid-call, which cannot be
            // staged deterministically from a unit test — there is no seam over
            // `node:fs` in this store on purpose, since the store IS the
            // filesystem code. It is kept because the failure it catches is
            // silent, and because the `isJiraError` passthrough in
            // {@link writeFailure} exists solely to let this diagnosis survive
            // the catch below.
            if (bytesWritten !== bytes.byteLength) {
              throw createJiraError({
                kind: 'config',
                reason: `Only ${String(bytesWritten)} of ${String(bytes.byteLength)} bytes of "${candidate}" reached ${root}; the filesystem is most likely full.`,
                remediation:
                  'Free space in JIRA_MEDIA_DIR (or point it at a larger volume) and download the attachment again.',
              });
            }
          } finally {
            await handle.close();
          }
          return { name: candidate, path, bytes: bytes.byteLength };
        } catch (error) {
          if (codeOf(error) === 'EEXIST') continue;
          // The file exists from the moment `open` returns, so any failure
          // after that leaves a partial file holding the name — and the name
          // is the only thing a later read has to go on. Remove it before
          // reporting. When `open` itself failed there is nothing to remove,
          // which is what `force` is for; a failing unlink must not replace
          // the real error with its own.
          await rm(path, { force: true }).catch(() => undefined);
          throw writeFailure(error, root, candidate);
        }
      }
      throw createJiraError({
        kind: 'validation',
        reason: `The media directory already holds ${String(MAX_NAME_COLLISIONS)} files named like "${name}".`,
        remediation:
          'Clear out the old copies in JIRA_MEDIA_DIR; this server never overwrites a downloaded file.',
      });
    },

    async read(name: string): Promise<MediaReadResult> {
      const path = pathOf(name);
      let size: number;
      try {
        // `stat` follows symlinks, so the prefix check on the NAME proves
        // nothing about the bytes: a link sitting in the directory can point
        // at ~/.ssh/id_rsa and still look like a regular file. Look at the
        // link itself first and resolve it only to reject it.
        const link = await lstat(path);
        if (link.isSymbolicLink()) await assertLinkStaysInside(path, root, name);
        const info = link.isSymbolicLink() ? await stat(path) : link;
        if (!info.isFile()) {
          throw createJiraError({
            kind: 'validation',
            reason: `"${name}" is not a regular file.`,
            remediation:
              'Upload a plain file from JIRA_MEDIA_DIR — directories, symlink targets outside it and devices are not attachments.',
          });
        }
        size = info.size;
      } catch (error) {
        throw readFailure(error, root, name);
      }
      // Stat BEFORE read: refusing a 4 GiB file must not require loading it.
      if (size > MAX_ATTACHMENT_BYTES) {
        throw createJiraError({
          kind: 'validation',
          reason: `"${name}" is ${String(size)} bytes, over the ${String(MAX_ATTACHMENT_BYTES)}-byte limit this server transfers.`,
          remediation:
            'This limit is compiled in and has no environment override. Attach the file through the Jira UI instead.',
        });
      }
      try {
        const buffer = await readFile(path);
        return { path, bytes: new Uint8Array(buffer) };
      } catch (error) {
        throw readFailure(error, root, name);
      }
    },
  };
}

/**
 * Refuse a symlink that leaves the media directory.
 *
 * Both sides are resolved with `realpath` because the ROOT itself is commonly
 * reached through a link (`/tmp` → `/private/tmp` on macOS is the everyday
 * case), and comparing a resolved target against an unresolved root would
 * reject perfectly legal files. A dangling link raises `ENOENT` here, which
 * {@link readFailure} reports as a missing file — which is what it is.
 */
async function assertLinkStaysInside(
  path: string,
  root: string,
  name: string,
): Promise<void> {
  const [target, realRoot] = await Promise.all([realpath(path), realpath(root)]);
  if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) {
    throw createJiraError({
      kind: 'validation',
      reason: `"${name}" is a symbolic link pointing outside the media directory.`,
      remediation:
        'Upload a real file from JIRA_MEDIA_DIR. This server never follows a link out of that directory.',
    });
  }
}

/** `report.pdf` + 2 ⇒ `report-2.pdf`; a long extension is treated as none. */
function variantOf(name: string, index: number): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && name.length - dot <= MAX_EXTENSION_CHARS;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  return `${stem}-${String(index)}${ext}`;
}

/**
 * The `code` of a Node system error, without an `any` in sight.
 *
 * NEITHER GUARD IS REACHABLE FROM THIS MODULE, and both are kept. The only
 * callers are {@link writeFailure} and {@link readFailure}, both of which run
 * inside a `catch` over `node:fs`, and every rejection from there is an `Error`
 * carrying a string `code`. But a `catch` binding is `unknown`, `throw null` is
 * legal JavaScript, and a diagnosis helper that itself throws a TypeError would
 * replace the operator's real error with a worse one. Two branches nobody can
 * exercise buy that this can never be the thing that fails — and the `''` arms
 * of the two `failed (code)` messages below are the same unreachable case seen
 * from the other end.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * A failed create, diagnosed. `ENOENT` here cannot mean "the file is missing" —
 * the file is the thing being created — so it means the DIRECTORY is missing,
 * which is a configuration problem and is reported as one.
 */
function writeFailure(error: unknown, root: string, name: string): Error {
  if (isJiraError(error)) return error;
  const code = codeOf(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return createJiraError({
      kind: 'config',
      reason: `The media directory ${root} does not exist, so "${name}" could not be written.`,
      remediation:
        'Create the directory JIRA_MEDIA_DIR points at (or fix the value) and restart the server.',
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return createJiraError({
      kind: 'config',
      reason: `The media directory ${root} is not writable by this server.`,
      remediation:
        'Grant the server write access to JIRA_MEDIA_DIR, or point it at a directory it owns.',
      cause: error,
    });
  }
  return createJiraError({
    kind: 'config',
    reason: `Writing "${name}" into ${root} failed${code === undefined ? '' : ` (${code})`}.`,
    remediation: 'Check the directory JIRA_MEDIA_DIR points at, then try again.',
    cause: error,
  });
}

/** A failed read. `ENOENT` is the caller naming a file that is not there. */
function readFailure(error: unknown, root: string, name: string): Error {
  if (isJiraError(error)) return error;
  const code = codeOf(error);
  if (code === 'ENOENT') {
    return createJiraError({
      kind: 'not_found',
      reason: `There is no file named "${name}" in the media directory.`,
      remediation:
        'Upload a file that is already inside JIRA_MEDIA_DIR; this server cannot read files from anywhere else.',
      cause: error,
    });
  }
  // EISDIR is unreachable through `read`'s own path: the `isFile()` check
  // answers a directory — and a symlink to one — with a validation error before
  // a byte is read. It is kept for the one case that check cannot close: a name
  // that was a regular file at `lstat` and is a directory by the time `readFile`
  // runs. Deleting it would leave that race to the generic fallback below, and
  // it is the guard above that makes this dead, not the impossibility of EISDIR.
  if (code === 'EISDIR') {
    return createJiraError({
      kind: 'validation',
      reason: `"${name}" is a directory, not a file.`,
      remediation: 'Name a single file inside JIRA_MEDIA_DIR.',
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return createJiraError({
      kind: 'config',
      reason: `"${name}" is not readable by this server.`,
      remediation:
        'Grant the server read access to the files in JIRA_MEDIA_DIR, or move the file there again.',
      cause: error,
    });
  }
  return createJiraError({
    kind: 'config',
    reason: `Reading "${name}" from ${root} failed${code === undefined ? '' : ` (${code})`}.`,
    remediation: 'Check the directory JIRA_MEDIA_DIR points at, then try again.',
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// 2. Shared arguments
// ---------------------------------------------------------------------------

/**
 * The issue argument keeps the name `issue` on the write tool: the recent-writes
 * registry (D32) reads that key to record what a call touched, so renaming it
 * would make an upload invisible to `jira_recent_writes`.
 */
const issueArg = z
  .string()
  .min(1)
  .describe('Issue key or numeric id, e.g. ABC-1. Both forms work.');

/** Jira sends attachment ids as numeric strings; a client may send the number. */
const attachmentIdArg = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe('Attachment id from jira_list_attachments — not the filename.');

// ---------------------------------------------------------------------------
// 3. `jira_list_attachments`
// ---------------------------------------------------------------------------

const listAttachmentsInput = toolInput({ issue: issueArg });

/** Result of {@link listAttachmentsTool}. */
interface AttachmentListData {
  /** The key Jira echoed — an id argument comes back as the real key. */
  readonly issue: string;
  readonly attachments: readonly JiraAttachment[];
  readonly count: number;
}

export const listAttachmentsTool = defineTool<
  z.infer<typeof listAttachmentsInput>,
  AttachmentListData
>({
  name: 'jira_list_attachments',
  title: 'List attachments',
  description:
    'Lists the files attached to one issue: id, filename, size in bytes, mime type, ' +
    'author and creation time. Metadata only — no bytes are transferred and no local ' +
    'directory is needed. The id is what jira_download_attachment takes. An issue ' +
    'with no attachments, and a project with attachments disabled, both answer with ' +
    'an empty list rather than an error.',
  package: 'attachments',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: listAttachmentsInput,
  handler: async (args, ctx): Promise<ToolResult<AttachmentListData>> =>
    guarded(async () => {
      const result = await listAttachments({ ...callBase(ctx), issueKey: args.issue });
      return ok<AttachmentListData>(
        {
          issue: result.issueKey,
          attachments: result.attachments,
          count: result.attachments.length,
        },
        // Filenames are tenant-authored free text (TOOLS.md §Untrusted content).
        { untrusted: true },
      );
    }),
});

// ---------------------------------------------------------------------------
// 4. `jira_download_attachment`
// ---------------------------------------------------------------------------

/**
 * Read-only towards Jira, non-idempotent locally: see the module banner. Not one
 * of the five shared quadruples in `mcp/tool-helpers.ts` because none of them
 * pairs `readOnlyHint: true` with `idempotentHint: false`, and this tool really
 * does leave a second file behind when it is called twice.
 */
const DOWNLOAD_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

const downloadAttachmentInput = toolInput({ attachmentId: attachmentIdArg });

/** Result of {@link downloadAttachmentTool}. */
interface AttachmentDownloadData {
  /** Absolute path of the file that was created. */
  readonly path: string;
  /** Its basename, which differs from `filename` when `renamed` is true. */
  readonly name: string;
  /** Jira's own filename — UNTRUSTED text, and never a path. */
  readonly filename: string;
  readonly bytes: number;
  readonly mimeType: string;
  /** The name on disk was sanitized or uniquified to avoid an overwrite. */
  readonly renamed: boolean;
  readonly attachmentId: string;
}

function downloadAttachmentTool(
  store: MediaStore | undefined,
): ToolSpec<z.infer<typeof downloadAttachmentInput>, AttachmentDownloadData> {
  return defineTool<z.infer<typeof downloadAttachmentInput>, AttachmentDownloadData>({
    name: 'jira_download_attachment',
    title: 'Download attachment',
    description:
      "Downloads one attachment INTO THIS SERVER'S media directory and returns the " +
      'local path — the bytes never pass through the conversation. Requires ' +
      'JIRA_MEDIA_DIR; without it the call is refused, while jira_list_attachments ' +
      'keeps working. Files over 50 MiB are refused. The name on disk is derived from ' +
      "Jira's filename and may be rewritten to keep it safe; an existing file is never " +
      'overwritten, so calling this twice leaves two files (renamed: true says so).',
    package: 'attachments',
    annotations: DOWNLOAD_ANNOTATIONS,
    input: downloadAttachmentInput,
    handler: async (args, ctx): Promise<ToolResult<AttachmentDownloadData>> =>
      guarded(async () => {
        const attachmentId = String(args.attachmentId);
        const result = await downloadAttachment({
          ...callBase(ctx),
          attachmentId,
          ...(store === undefined ? {} : { store }),
        });
        return ok<AttachmentDownloadData>(
          {
            path: result.path,
            name: result.name,
            filename: result.attachment.filename,
            bytes: result.bytes,
            mimeType: result.mimeType,
            renamed: result.renamed,
            attachmentId: result.attachment.id,
          },
          // `filename` is tenant text even after the local name was sanitized.
          { untrusted: true },
        );
      }),
  });
}

// ---------------------------------------------------------------------------
// 5. `jira_upload_attachment`
// ---------------------------------------------------------------------------

const uploadAttachmentInput = writeToolInput({
  issue: issueArg,
  name: z
    .string()
    .min(1)
    .max(MAX_MEDIA_NAME_CHARS)
    .describe(
      'File NAME inside the media directory JIRA_MEDIA_DIR names — never a path. "notes.pdf" ' +
        'is valid; "/etc/passwd", "../secret" and "sub/dir/file" are refused. The file ' +
        'must already be there; this server cannot read anything else on the host.',
    ),
  contentType: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Mime type recorded on the attachment. Defaults to ${DEFAULT_ATTACHMENT_MIME}.`,
    ),
});

/** Result of {@link uploadAttachmentTool}. */
interface AttachmentUploadData {
  readonly issue: string;
  /** The local file that was sent. */
  readonly name: string;
  readonly bytes: number;
  /** The records Jira created — one per uploaded file. */
  readonly attachments: readonly JiraAttachment[];
}

function uploadAttachmentTool(
  store: MediaStore | undefined,
): ToolSpec<z.infer<typeof uploadAttachmentInput>, AttachmentUploadData> {
  return defineTool<z.infer<typeof uploadAttachmentInput>, AttachmentUploadData>({
    name: 'jira_upload_attachment',
    title: 'Upload attachment',
    description:
      "Attaches a file from this server's media directory to an issue. `name` is a " +
      'plain file name inside JIRA_MEDIA_DIR — paths, ".." and subdirectories are ' +
      'refused, so nothing else on the host can be uploaded. Requires JIRA_MEDIA_DIR ' +
      'and a file no larger than 50 MiB. A timeout is reported as ambiguous_write and ' +
      'is never retried automatically: re-read jira_list_attachments before sending ' +
      'the file again, or the issue ends up with two copies.',
    package: 'attachments',
    annotations: WRITE_ANNOTATIONS,
    writeTier: 'standard',
    input: uploadAttachmentInput,
    handler: async (args, ctx): Promise<ToolResult<AttachmentUploadData>> =>
      guarded(async () => {
        const result = await uploadAttachment({
          ...callBase(ctx),
          issueKey: args.issue,
          name: args.name,
          ...(args.contentType === undefined ? {} : { contentType: args.contentType }),
          ...(store === undefined ? {} : { store }),
        });
        return ok<AttachmentUploadData>({
          issue: args.issue,
          name: result.name,
          bytes: result.bytes,
          attachments: result.attachments,
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 6. The package
// ---------------------------------------------------------------------------

/** What the composition root injects into {@link createAttachmentsPackage}. */
export interface AttachmentsDeps {
  /**
   * `JIRA_MEDIA_DIR`. Absent ⇒ the two byte-moving tools refuse with
   * `kind: 'config'` naming the setting, and the metadata tool still works.
   */
  readonly mediaDir?: string;
  /** Overrides {@link mediaDir} with a store built elsewhere — tests use it. */
  readonly store?: MediaStore;
}

/**
 * The `attachments` package, bound to a media directory.
 *
 * A function rather than a constant for the same reason `corePackage` is one:
 * the directory is settings, and settings enter at the composition root.
 * Binding it here — instead of reading `process.env` inside a handler — is what
 * keeps the tools ring testable and the `core ← api ← mcp ← tools` layering
 * honest.
 */
export function createAttachmentsPackage(deps: AttachmentsDeps = {}): PackageSpec {
  const store =
    deps.store ??
    (deps.mediaDir === undefined || deps.mediaDir.trim() === ''
      ? undefined
      : createNodeMediaStore(deps.mediaDir));

  return {
    id: 'attachments',
    title: 'Attachments',
    description:
      "Files on issues: list what is attached, download one into the server's media " +
      'directory, and attach a file from it. The two byte-moving tools need ' +
      'JIRA_MEDIA_DIR and never touch anything outside it.',
    tools: [
      listAttachmentsTool,
      downloadAttachmentTool(store),
      uploadAttachmentTool(store),
    ],
  };
}

/**
 * The `attachments` package with the media directory deliberately UNBOUND — the
 * structural constant a snapshot, a README table or a `server.json` reads.
 * Calling `jira_download_attachment` on it yields the same `config` envelope a
 * server with no `JIRA_MEDIA_DIR` returns, which is the honest answer: that IS a
 * server with no media directory.
 */
export const attachmentsPackage: PackageSpec = createAttachmentsPackage();
