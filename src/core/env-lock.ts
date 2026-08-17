// Cross-process env lock + atomic 0600 writes (WP-11).
//
// CONFIGURATION.md: "Files written by the CLI (`doctor --save`, future `login`)
// are created atomically with mode `0600`, guarded by a cross-process env lock."
// This module is that guard. It writes no env file itself — `doctor --save`
// (WP-25) owns the contents; here lives only the "how", so the two concerns
// (what to write / how to write it safely) cannot drift apart.
//
// Two independent properties:
//
// 1. **Atomicity.** {@link writeFileAtomic} writes a sibling temp file, fsyncs
//    it, then `rename()`s it over the target. `rename` within one filesystem is
//    atomic, so a reader either sees the whole old file or the whole new one —
//    never a half-written token. A plain `writeFileSync` truncates first, and a
//    crash there leaves an empty env file, i.e. credentials silently gone.
//    Permissions are set on the file descriptor BEFORE the rename, so the
//    secret is never briefly world-readable (umask cannot widen 0600 either
//    way, but an inherited umask can only be trusted to narrow, not to set).
//
// 2. **Mutual exclusion.** Two `doctor --save` runs (or a save racing an
//    editor-driven one) would otherwise last-writer-wins and drop a field.
//    The lock is an advisory `mkdir` on `<target>.lock`: `mkdir` is atomic and
//    fails with EEXIST on every POSIX filesystem and on Windows, and unlike
//    `open(O_EXCL)` on NFS it has no known silent-success mode.
//
// Stale locks. A holder that is SIGKILLed leaves the directory behind, and a
// lock nobody can break turns one crash into a permanently unusable CLI. The
// rule here:
//   - liveness is judged by the lock's **mtime**, not by the recorded pid —
//     pids are reused, and on a shared/containerized filesystem the pid in the
//     file belongs to a different namespace than the one checking it;
//   - a lock older than `staleMs` (default 30s, ~1000× the work it guards) is
//     considered abandoned and is broken ONCE per acquisition; a second break
//     within the same acquire is refused, so two processes cannot ping-pong;
//   - before breaking, the owner record is re-read and must be byte-identical
//     to the one seen when staleness was detected. That closes the common race
//     (holder released and a third process took the lock in between). The
//     residual race — the original holder is alive but has been frozen for
//     longer than `staleMs` — is not closable with files alone; a long-running
//     holder is expected to call {@link EnvLock.refresh} instead;
//   - breaking is always reported through `onWarning`, because a broken lock is
//     evidence of an earlier crash and should be visible in doctor output;
//   - a holder that was broken never touches the lock again. `refresh` and
//     `release` first re-read the owner record and compare it byte-for-byte
//     with the one they wrote. Without that check the residual race above does
//     not merely allow a second writer, it cascades: the thawed holder's
//     `release` would `rm` the *new* holder's lock directory and let a third
//     writer straight in, and its `refresh` would stamp its own owner record
//     over the new holder's (or, if nobody retook it, recreate the directory
//     via `writeFileAtomic`'s `mkdir -p` and resurrect a lock with no holder).
//     Losing the lock is reported through `onWarning` too, and the lock object
//     goes inert — the same state as after `release`.
//
// Owner records in diagnostics. `<lock>/owner.json` is read back into warnings
// and into the timeout error message, and nothing guarantees it still holds the
// JSON we wrote: a crashed run of another version, an unrelated tool, or anyone
// who can write the config directory can leave arbitrary bytes there. So it is
// never echoed raw — {@link describeOwner} keeps the first line, drops control
// characters (terminal escapes included) and caps the length, so a lock file
// cannot inject newlines or escape sequences into doctor's stderr or into a
// `JiraError` message that a model will read back.
//
// No timers and no ambient time: `setTimeout`/`Date.now` are banned outside the
// clock seam [eslint], so waiting is `clock.sleep()` and every timestamp comes
// from the injected {@link Clock}. That also makes the retry/stale behaviour
// testable with a fake clock instead of real sleeps. There is deliberately no
// background heartbeat: an interval would need a real timer, so a holder that
// works longer than `staleMs` calls `refresh()` explicitly.
//
// No env var configures any of this — there is no `JIRA_LOCK_*` row in
// CONFIGURATION.md, and adding a read here would fail the env ↔ docs sync test
// (TESTING.md suite 8). Callers pass options.

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { JiraError, type Clock } from './types.js';

/** Mode for files that hold credentials: owner read/write only. */
export const SECRET_FILE_MODE = 0o600;
/** Mode for directories that hold such files. */
export const SECRET_DIR_MODE = 0o700;

/** A lock untouched for this long is treated as abandoned. */
export const DEFAULT_STALE_MS = 30000;
/** How long {@link acquireEnvLock} keeps retrying before giving up. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 10000;
/** Wait between acquisition attempts. */
export const DEFAULT_RETRY_DELAY_MS = 50;

/** Owner record written inside the lock directory; diagnostics only. */
export interface EnvLockOwner {
  readonly pid: number;
  readonly host: string;
  /** Epoch ms from the injected clock, not from `Date.now`. */
  readonly acquiredAt: number;
}

/** Inputs for {@link acquireEnvLock}; ambient time is injected, never read. */
export interface EnvLockOptions {
  /** Required: this module never touches the host clock directly. */
  readonly clock: Clock;
  /** Lock path. Defaults to `<targetPath>.lock`. */
  readonly lockPath?: string;
  /** Abandonment horizon. Default {@link DEFAULT_STALE_MS}. */
  readonly staleMs?: number;
  /** Give up after this long. Default {@link DEFAULT_ACQUIRE_TIMEOUT_MS}. */
  readonly acquireTimeoutMs?: number;
  /** Pause between attempts. Default {@link DEFAULT_RETRY_DELAY_MS}. */
  readonly retryDelayMs?: number;
  /** Caller's pid, injectable for tests. Defaults to `process.pid`. */
  readonly pid?: number;
  /** Caller's host name, injectable for tests. Defaults to `os.hostname()`. */
  readonly host?: string;
  /**
   * Diagnostics sink. `Logger` is not used on purpose: `LOG_EVENTS` is a closed
   * vocabulary (WP-01) with no lock event in it, and `core` must not invent one.
   * WP-25 forwards these strings to stderr.
   */
  readonly onWarning?: (message: string) => void;
  /** Abort waiting early (Ctrl-C). */
  readonly signal?: AbortSignal;
}

/** A held lock. Always release in a `finally` — or use {@link withEnvLock}. */
export interface EnvLock {
  /** The lock directory path. */
  readonly path: string;
  /** The path this lock guards. */
  readonly targetPath: string;
  /** Who we recorded ourselves as. */
  readonly owner: EnvLockOwner;
  /** Touch the lock so a long operation is not judged stale. */
  refresh(): void;
  /** Release; idempotent, and never throws for an already-gone lock. */
  release(): void;
}

const OWNER_FILE = 'owner.json';

function errnoCode(cause: unknown): string | undefined {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause as { code?: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Read the owner record verbatim; the raw text is the race-detection token. */
function readOwnerRaw(lockPath: string): string | undefined {
  try {
    return readFileSync(join(lockPath, OWNER_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

/** Longest owner record quoted in a diagnostic, in characters. */
const OWNER_QUOTE_MAX = 200;

/**
 * First line of `raw` with control characters removed and length capped.
 *
 * Written as one pass rather than `split('\n')[0].replace(...)`: the indexed
 * access and a `codePointAt` result both come back `| undefined` under
 * `noUncheckedIndexedAccess`, and the `?? ''` / `?? 0` those need are arms no
 * input can reach — dead branches bought for nothing. `charCodeAt` is typed
 * `number`, and for a surrogate pair it returns the high surrogate (≥ 0x20), so
 * the pair is kept whole: the loop appends `char`, not the code unit.
 */
function printableFirstLine(raw: string): string {
  let clean = '';
  for (const char of raw) {
    if (char === '\n') break;
    const code = char.charCodeAt(0);
    // Drop C0 (incl. TAB/CR), DEL and C1 — the ranges that carry terminal
    // escape sequences. Everything printable, including non-ASCII, survives.
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      clean += char;
    }
  }
  clean = clean.trim();
  return clean.length > OWNER_QUOTE_MAX ? `${clean.slice(0, OWNER_QUOTE_MAX)}...` : clean;
}

/**
 * Render an owner record for a human. The bytes are untrusted (see the header):
 * quoting them raw would let a lock file inject escape sequences and newlines
 * into diagnostics. `fallback` names the "no usable record" case.
 */
function describeOwner(raw: string | undefined, fallback: string): string {
  const clean = printableFirstLine(raw ?? '');
  return clean === '' ? fallback : clean;
}

/** Lock mtime in epoch ms, or `undefined` when the lock is not there. */
function lockMtimeMs(lockPath: string): number | undefined {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Write `contents` to `targetPath` atomically with mode `0600`.
 *
 * Not lock-aware by itself — hold {@link acquireEnvLock} around it whenever two
 * processes might write the same file.
 */
export function writeFileAtomic(
  targetPath: string,
  contents: string,
  options: { readonly mode?: number; readonly tmpSuffix?: string } = {},
): void {
  const mode = options.mode ?? SECRET_FILE_MODE;
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });

  // The temp file MUST be a sibling: `rename` is only atomic within one
  // filesystem, and `/tmp` is routinely a different one.
  const suffix = options.tmpSuffix ?? `${String(process.pid)}-${String(nextSeq())}`;
  const tmpPath = `${targetPath}.tmp-${suffix}`;

  // `wx` fails if the temp name already exists rather than clobbering a
  // concurrent writer's file.
  const fd = openSync(tmpPath, 'wx', mode);
  try {
    // Explicit chmod: the open mode is masked by the process umask, and a
    // credentials file must be 0600 regardless of how the shell was configured.
    fchmodSync(fd, mode);
    writeSync(fd, contents);
    // Durability before visibility: rename may otherwise be persisted while the
    // data is still only in the page cache, leaving a zero-length file.
    fsyncSync(fd);
  } catch (cause) {
    closeSync(fd);
    try {
      unlinkSync(tmpPath);
    } catch {
      // The temp file is already gone; the original error is what matters.
    }
    throw cause;
  }
  closeSync(fd);

  try {
    renameSync(tmpPath, targetPath);
  } catch (cause) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Same as above: do not mask the rename failure.
    }
    throw cause;
  }
}

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

/**
 * Acquire the advisory lock guarding `targetPath`. Resolves when held; rejects
 * with `JiraError { kind: 'timeout' }` when the wait budget runs out.
 */
export async function acquireEnvLock(
  targetPath: string,
  options: EnvLockOptions,
): Promise<EnvLock> {
  const { clock } = options;
  const lockPath = options.lockPath ?? `${targetPath}.lock`;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const deadline = clock.now() + acquireTimeoutMs;

  let brokenOnce = false;

  for (;;) {
    options.signal?.throwIfAborted();

    const owner: EnvLockOwner = { pid, host, acquiredAt: clock.now() };
    // The exact bytes on disk are our claim to the lock: `refresh`/`release`
    // compare against them to notice a lock that was broken under us.
    const record = `${JSON.stringify(owner)}\n`;
    try {
      mkdirSync(lockPath, { recursive: false, mode: SECRET_DIR_MODE });
      writeFileAtomic(join(lockPath, OWNER_FILE), record, { mode: SECRET_FILE_MODE });
      return makeLock(lockPath, targetPath, owner, record, options.onWarning);
    } catch (cause) {
      if (errnoCode(cause) !== 'EEXIST') throw cause;
    }

    // Someone holds it. Decide whether that someone is still alive.
    const mtime = lockMtimeMs(lockPath);
    if (mtime !== undefined && clock.now() - mtime > staleMs && !brokenOnce) {
      const before = readOwnerRaw(lockPath);
      // Re-check under the same observation: if the record changed between the
      // staleness check and now, a live process owns the lock — do not break it.
      if (readOwnerRaw(lockPath) === before && lockMtimeMs(lockPath) === mtime) {
        brokenOnce = true;
        options.onWarning?.(
          `Breaking stale lock ${lockPath} (untouched for ${String(clock.now() - mtime)}ms, owner ${describeOwner(before, 'unknown')}). A previous run was probably killed.`,
        );
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // NOT the "another breaker got there first" case — `force` already
          // swallows a vanished directory. This is a removal that genuinely
          // cannot happen (unwritable parent, or the directory held open on
          // Windows/NFS). Swallow it: the lock is still there, so the next
          // attempt sees it, `brokenOnce` stops a second break, and the wait
          // ends in a timeout error that names the path.
        }
        continue;
      }
    }

    if (clock.now() >= deadline) {
      throw new JiraError({
        kind: 'timeout',
        message: `Timed out after ${String(acquireTimeoutMs)}ms waiting for the env lock ${lockPath}, held by ${describeOwner(readOwnerRaw(lockPath), 'an unknown process')}.`,
        retryable: true,
        remediation: `Wait for the other jira-mcp-ai process to finish. If none is running, remove ${lockPath} and retry.`,
      });
    }

    await clock.sleep(retryDelayMs, options.signal);
  }
}

function makeLock(
  lockPath: string,
  targetPath: string,
  owner: EnvLockOwner,
  record: string,
  onWarning?: (message: string) => void,
): EnvLock {
  let released = false;

  /**
   * Still ours? The owner record we wrote is the claim. A mismatch means the
   * lock was broken as stale while this process was stalled — and `undefined`
   * (gone, unreadable) means the same thing. `refresh` rewrites the identical
   * bytes, so refreshing never invalidates the claim.
   */
  const stillOurs = (): boolean => readOwnerRaw(lockPath) === record;

  const warnLost = (action: string): void => {
    onWarning?.(
      `Not ${action} the env lock ${lockPath}: it is no longer ours (now ${describeOwner(readOwnerRaw(lockPath), 'unheld')}). It was broken as stale while this run was stalled — assume another process wrote ${targetPath}.`,
    );
  };

  return {
    path: lockPath,
    targetPath,
    owner,
    refresh(): void {
      if (released) return;
      if (!stillOurs()) {
        // `writeFileAtomic` would `mkdir -p` the lock directory back into
        // existence, resurrecting a lock nobody holds — or overwrite the new
        // holder's record with ours. Go inert instead.
        released = true;
        warnLost('refreshing');
        return;
      }
      // Rewriting the owner file bumps the lock directory's mtime, which is the
      // liveness signal other processes read.
      writeFileAtomic(join(lockPath, OWNER_FILE), record, { mode: SECRET_FILE_MODE });
    },
    release(): void {
      if (released) return;
      released = true;
      if (!stillOurs()) {
        // Removing it here would delete the *new* holder's lock and hand the
        // file to a third writer — the exact failure this module exists to
        // prevent. The lock is gone or belongs to someone else; either way
        // there is nothing of ours left to release.
        warnLost('releasing');
        return;
      }
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // `force` already swallows a directory that is simply gone, so this is
        // a removal that cannot happen: an unwritable parent, or the directory
        // held open (Windows/NFS). Nothing useful is left to do — the lock now
        // ages out as stale, which is the documented recovery path.
      }
    },
  };
}

/** Run `fn` while holding the lock; releases even when `fn` throws. */
export async function withEnvLock<T>(
  targetPath: string,
  options: EnvLockOptions,
  fn: (lock: EnvLock) => T | Promise<T>,
): Promise<T> {
  const lock = await acquireEnvLock(targetPath, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/**
 * The intended entry point for CLI writers: take the lock, write atomically at
 * `0600`, release. `doctor --save` (WP-25) supplies the rendered file body.
 */
export async function writeGuardedFile(
  targetPath: string,
  contents: string,
  options: EnvLockOptions,
): Promise<void> {
  await withEnvLock(targetPath, options, () => {
    writeFileAtomic(targetPath, contents);
  });
}
