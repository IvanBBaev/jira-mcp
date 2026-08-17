// ---------------------------------------------------------------------------
// The append-only write journal (OBSERVABILITY.md §Write journal, CC-33).
//
// `JIRA_JOURNAL_PATH` turns on a JSONL record of every EXECUTED write. Plan-mode
// calls never reach here — nothing happened, so there is nothing to record.
//
// THREE PROPERTIES, AND THEY ARE THE WHOLE MODULE.
//
// 1. `append` NEVER throws and never rejects. The write it describes already
//    happened; a tool that failed because its audit line could not be written
//    would tell the model to retry a mutation that succeeded — the worst
//    available outcome. A failure is a `'failed'` status, a `journal_write_failed`
//    event, and (upstream) a `journal_unavailable` hint on an `ok: true` result.
// 2. Appends are SERIALIZED through a promise chain. Two tool calls can finish
//    inside the same tick, and `O_APPEND` only guarantees atomicity for writes
//    the kernel does not split; a torn line in an audit file is worse than a
//    missing one, because it is silently unparseable.
// 3. The file is created 0600 and rotated at ~5 MB (rename to `.1`, keep one
//    previous file). An unbounded audit file on a laptop is a slow-motion disk
//    failure.
//
// Content is metadata only: `{ ts, cid, tool, argsHash, ok, httpStatus?,
// issueKey? }` (O-8). No field values, no ADF, no JQL. The serialized line still
// passes the redactor before it is written — the journal inherits the choke
// point rather than bypassing it, so a future field cannot leak a token by being
// added in one place and forgotten in another.
//
// Layering: `core` is layer 0. Time comes from the injected {@link Clock}; the
// only host facility used is `node:fs`.
// ---------------------------------------------------------------------------

import { open, rename, stat } from 'node:fs/promises';

import type {
  Clock,
  Journal,
  JournalEntry,
  JournalEntryInput,
  JournalStatus,
  Logger,
  Redactor,
} from './types.js';

/** Rotation threshold — OBSERVABILITY.md's "~5 MB", in bytes. */
export const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;

/** Owner read/write only: the journal names issues this account touched. */
export const JOURNAL_FILE_MODE = 0o600;

/** Suffix of the single retained previous generation. */
export const JOURNAL_ROTATED_SUFFIX = '.1';

/** `errorKind` when the failure carried no errno (a serialization bug, say). */
export const UNKNOWN_JOURNAL_ERROR = 'unknown';

export interface FileJournalOptions {
  /** `JIRA_JOURNAL_PATH`, already resolved to an absolute path by the caller. */
  readonly path: string;
  /** `ts` comes from here; the wall clock is banned outside `core/clock.ts`. */
  readonly clock: Clock;
  /** Root logger. Absent in tests that only assert file contents. */
  readonly logger?: Logger | undefined;
  /** Redaction choke point applied to the serialized line. */
  readonly redactor?: Redactor | undefined;
  /** Rotation threshold; defaults to {@link JOURNAL_MAX_BYTES}. */
  readonly maxBytes?: number | undefined;
}

/**
 * The `errorKind` field of `journal_write_failed`.
 *
 * The errno code (`EACCES`, `ENOSPC`, `EROFS`…) is the machine-stable name an
 * operator can act on, and unlike the message it carries no path — the
 * never-log list forbids one, and a journal path can name a project. Anything
 * without an errno degrades to {@link UNKNOWN_JOURNAL_ERROR}.
 */
function errorKindOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return UNKNOWN_JOURNAL_ERROR;
}

/**
 * Rotate when the incoming line would push the file past the threshold.
 *
 * Checked BEFORE the append rather than after, so the file never exceeds the
 * budget it advertises; an absent file needs no rotation, and a file that is
 * already empty is never rotated (that would produce an empty `.1` and throw
 * away the generation that still held data).
 */
async function rotateIfNeeded(
  path: string,
  incomingBytes: number,
  maxBytes: number,
): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // Missing (or unstattable) — the append below is what reports the problem.
    return;
  }
  if (size === 0 || size + incomingBytes <= maxBytes) return;
  await rename(path, `${path}${JOURNAL_ROTATED_SUFFIX}`);
}

/**
 * Create the file-backed {@link Journal}.
 *
 * Nothing is opened here: a journal that fails at construction would have to
 * fail startup, and OBSERVABILITY.md is explicit that a journal problem is never
 * fatal. The first append is what discovers a bad path, and it reports it the
 * same way every later failure is reported.
 */
export function createFileJournal(options: FileJournalOptions): Journal {
  const { path, clock } = options;
  const maxBytes = options.maxBytes ?? JOURNAL_MAX_BYTES;
  const redactLine = (line: string): string =>
    options.redactor === undefined ? line : options.redactor.redactString(line);

  // Serialization tail. Every append waits for the previous one, so lines never
  // interleave; the tail is kept resolved (failures are already handled) so one
  // bad append cannot poison the chain.
  let tail: Promise<void> = Promise.resolve();

  const writeLine = async (line: string): Promise<void> => {
    await rotateIfNeeded(path, Buffer.byteLength(line, 'utf8'), maxBytes);
    // `a` + an explicit mode: the mode only applies when the file is created,
    // which is exactly the moment the 0600 requirement is about.
    const handle = await open(path, 'a', JOURNAL_FILE_MODE);
    try {
      await handle.write(line, null, 'utf8');
    } finally {
      await handle.close();
    }
  };

  const attempt = async (entry: JournalEntry): Promise<JournalStatus> => {
    try {
      // Key order is the documented line shape; `JSON.stringify` preserves
      // insertion order, so a journal read by `head -1` looks like the spec.
      const line = `${redactLine(JSON.stringify(entry))}\n`;
      await writeLine(line);
      return 'ok';
    } catch (error) {
      options.logger?.emit('journal_write_failed', { errorKind: errorKindOf(error) });
      return 'failed';
    }
  };

  return {
    append(input: JournalEntryInput): Promise<JournalStatus> {
      let entry: JournalEntry;
      try {
        entry = {
          ts: new Date(clock.now()).toISOString(),
          cid: input.cid,
          tool: input.tool,
          argsHash: input.argsHash,
          ok: input.ok,
          ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
          ...(input.issueKey === undefined ? {} : { issueKey: input.issueKey }),
        };
      } catch (error) {
        // A clock that throws (or an unrepresentable time) is still not a tool
        // failure — the same contract applies before the chain as inside it.
        options.logger?.emit('journal_write_failed', { errorKind: errorKindOf(error) });
        return Promise.resolve('failed');
      }

      const queued = tail.then(() => attempt(entry));
      tail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
  };
}
