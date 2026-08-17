import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_STALE_MS,
  SECRET_FILE_MODE,
  acquireEnvLock,
  withEnvLock,
  writeFileAtomic,
  writeGuardedFile,
  type EnvLockOptions,
} from './env-lock.js';
import { JiraError, type Clock } from './types.js';

const POSIX = process.platform !== 'win32';
/**
 * Permission-based failure injection only works for an unprivileged user: root
 * ignores the mode bits, so an "unremovable" directory would still be removed.
 */
const CAN_DENY_WRITE = POSIX && process.getuid?.() !== 0;

/**
 * A clock whose `sleep` advances virtual time instead of waiting: the acquire
 * loop then runs to its deadline in microseconds, with no real timer involved.
 */
function autoClock(startMs: number): Clock {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
      await Promise.resolve();
    },
  };
}

const root = mkdtempSync(join(tmpdir(), 'jira-mcp-lock-'));
let dir = root;
let counter = 0;

beforeEach(() => {
  counter += 1;
  dir = join(root, `case-${String(counter)}`);
  mkdirSync(dir, { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(overrides: Partial<EnvLockOptions> = {}): EnvLockOptions {
  return {
    clock: autoClock(1_000_000),
    acquireTimeoutMs: 200,
    retryDelayMs: 10,
    pid: 4242,
    host: 'test-host',
    ...overrides,
  };
}

describe('writeFileAtomic', () => {
  it('writes the file with mode 0600', () => {
    const target = join(dir, '.env');
    writeFileAtomic(target, 'JIRA_X=1\n');
    assert.equal(readFileSync(target, 'utf8'), 'JIRA_X=1\n');
    if (POSIX) assert.equal(statSync(target).mode & 0o777, SECRET_FILE_MODE);
  });

  it('creates missing parent directories', () => {
    const target = join(dir, 'nested', 'deeper', '.env');
    writeFileAtomic(target, 'a=1');
    assert.equal(readFileSync(target, 'utf8'), 'a=1');
    if (POSIX) assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
  });

  it('replaces an existing file and leaves no temp files behind', () => {
    const target = join(dir, '.env');
    writeFileSync(target, 'old', { mode: 0o644 });
    writeFileAtomic(target, 'new');
    assert.equal(readFileSync(target, 'utf8'), 'new');
    if (POSIX) assert.equal(statSync(target).mode & 0o777, SECRET_FILE_MODE);
    assert.deepEqual(readdirSync(dir), ['.env']);
  });

  it('removes the temp file when the rename fails', () => {
    const target = join(dir, '.env');
    // A directory under the target name: the write succeeds, `rename` cannot.
    mkdirSync(target);
    writeFileSync(join(target, 'kid'), 'x');

    assert.throws(() => {
      writeFileAtomic(target, 'new');
    });
    // The failure is reported, not papered over — and it litters nothing: a
    // leftover `.env.tmp-*` is a 0600 file holding the credentials we could
    // not install, sitting next to the env file forever.
    assert.deepEqual(readdirSync(dir), ['.env']);
    assert.deepEqual(readdirSync(target), ['kid']);
  });
});

describe('acquireEnvLock', () => {
  it('creates the lock directory and removes it on release', async () => {
    const target = join(dir, '.env');
    const lock = await acquireEnvLock(target, options());
    assert.equal(lock.path, `${target}.lock`);
    assert.equal(existsSync(lock.path), true);
    assert.equal(lock.targetPath, target);
    assert.deepEqual(lock.owner.pid, 4242);
    lock.release();
    assert.equal(existsSync(lock.path), false);
  });

  it('records the owner inside the lock', async () => {
    const target = join(dir, '.env');
    const lock = await acquireEnvLock(target, options());
    const owner: unknown = JSON.parse(
      readFileSync(join(lock.path, 'owner.json'), 'utf8'),
    );
    assert.deepEqual(owner, { pid: 4242, host: 'test-host', acquiredAt: 1_000_000 });
    lock.release();
  });

  it('excludes a second holder while the lock is fresh', async () => {
    const target = join(dir, '.env');
    // Simulate another process: the lock exists and was just touched.
    mkdirSync(`${target}.lock`);
    writeFileSync(join(`${target}.lock`, 'owner.json'), '{"pid":1}\n');

    await assert.rejects(
      acquireEnvLock(target, options({ clock: autoClock(Date.now()) })),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.equal(error.kind, 'timeout');
        assert.match(error.message, /env lock/);
        return true;
      },
    );
    // The other process's lock is untouched.
    assert.equal(existsSync(`${target}.lock`), true);
  });

  it('is re-acquirable once the previous holder releases', async () => {
    const target = join(dir, '.env');
    const first = await acquireEnvLock(target, options());
    first.release();
    const second = await acquireEnvLock(target, options());
    assert.equal(existsSync(second.path), true);
    second.release();
  });

  it('breaks a stale lock once and reports it', async () => {
    const target = join(dir, '.env');
    mkdirSync(`${target}.lock`);
    writeFileSync(join(`${target}.lock`, 'owner.json'), '{"pid":999}\n');

    const warnings: string[] = [];
    // Virtual "now" sits far past the lock's real mtime, so it reads as stale.
    const lock = await acquireEnvLock(
      target,
      options({
        clock: autoClock(Date.now() + 10 * DEFAULT_STALE_MS),
        onWarning: (message) => warnings.push(message),
      }),
    );
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /stale lock/);
    assert.match(String(warnings[0]), /999/);
    lock.release();
  });

  it('does not break a lock that is younger than staleMs', async () => {
    const target = join(dir, '.env');
    mkdirSync(`${target}.lock`);
    const warnings: string[] = [];
    await assert.rejects(
      acquireEnvLock(
        target,
        options({
          clock: autoClock(Date.now()),
          staleMs: 10 * DEFAULT_STALE_MS,
          onWarning: (message) => warnings.push(message),
        }),
      ),
      JiraError,
    );
    assert.deepEqual(warnings, []);
  });

  it('release is idempotent', async () => {
    const lock = await acquireEnvLock(join(dir, '.env'), options());
    lock.release();
    lock.release();
    assert.equal(existsSync(lock.path), false);
  });

  it('refresh keeps the lock alive without recreating it', async () => {
    const lock = await acquireEnvLock(join(dir, '.env'), options());
    const before = statSync(lock.path).mtimeMs;
    lock.refresh();
    assert.ok(statSync(lock.path).mtimeMs >= before);
    assert.equal(existsSync(join(lock.path, 'owner.json')), true);
    lock.release();
  });

  it('honours an abort signal', async () => {
    const target = join(dir, '.env');
    mkdirSync(`${target}.lock`);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      acquireEnvLock(target, options({ signal: controller.signal })),
      /abort/i,
    );
  });

  it('falls back to this process when no pid/host is supplied', async () => {
    const lock = await acquireEnvLock(join(dir, '.env'), {
      clock: autoClock(Date.now()),
    });
    assert.equal(lock.owner.pid, process.pid);
    assert.equal(lock.owner.host, hostname());
    lock.release();
  });

  it('waits the documented budget in the documented steps by default', async () => {
    const target = join(dir, '.env');
    mkdirSync(`${target}.lock`);
    writeFileSync(join(`${target}.lock`, 'owner.json'), '{"pid":1}\n');

    // Count the module's own calls into the injected clock: with no override
    // the wait must be DEFAULT_ACQUIRE_TIMEOUT_MS long in DEFAULT_RETRY_DELAY_MS
    // steps, and the lock must not read as stale inside that window.
    let sleeps = 0;
    const base = autoClock(Date.now());
    const clock: Clock = {
      now: () => base.now(),
      sleep: async (ms, signal) => {
        sleeps += 1;
        await base.sleep(ms, signal);
      },
    };

    await assert.rejects(acquireEnvLock(target, { clock }), (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'timeout');
      assert.ok(
        error.message.includes(`${String(DEFAULT_ACQUIRE_TIMEOUT_MS)}ms`),
        error.message,
      );
      return true;
    });
    assert.equal(sleeps, DEFAULT_ACQUIRE_TIMEOUT_MS / DEFAULT_RETRY_DELAY_MS);
    // Not broken as stale: DEFAULT_ACQUIRE_TIMEOUT_MS < DEFAULT_STALE_MS.
    assert.equal(existsSync(join(`${target}.lock`, 'owner.json')), true);
  });

  it('rethrows a mkdir failure that is not EEXIST instead of waiting it out', async () => {
    // A regular file where the lock directory's parent should be: this can
    // never become acquirable, so laundering it into a timeout would send the
    // operator off to hunt a nonexistent competing process.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');

    await assert.rejects(
      acquireEnvLock(join(dir, '.env'), options({ lockPath: join(blocker, 'x.lock') })),
      (error: unknown) => {
        assert.equal(error instanceof JiraError, false);
        const { code } = error as { code?: unknown };
        assert.ok(
          code === 'ENOTDIR' || code === 'ENOENT',
          `unexpected errno ${String(code)}`,
        );
        return true;
      },
    );
  });

  it('names a stale lock with no owner record as unknown', async () => {
    const target = join(dir, '.env');
    mkdirSync(`${target}.lock`);

    const warnings: string[] = [];
    const lock = await acquireEnvLock(
      target,
      options({
        clock: autoClock(Date.now() + 10 * DEFAULT_STALE_MS),
        onWarning: (message) => warnings.push(message),
      }),
    );
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /owner unknown/);
    lock.release();
  });

  it('does not echo the raw owner record into the timeout error', async () => {
    const target = join(dir, '.env');
    mkdirSync(`${target}.lock`);
    // Nothing guarantees the lock file still holds the JSON we write: a local
    // writer can put escape sequences and megabytes there, and this string
    // reaches doctor's stderr and a JiraError a model reads back.
    // C0 (ESC, BEL), DEL and C1 (CSI) all carry terminal control; plain
    // non-ASCII must survive the filter rather than be collateral damage.
    const hostile = [0x1b, 0x07, 0x7f, 0x9b].map((code) => String.fromCharCode(code));
    writeFileSync(
      join(`${target}.lock`, 'owner.json'),
      `${hostile.join('')}[2Jcaf\u00e9-evil${'A'.repeat(5000)}\nsecond line\n`,
    );

    await assert.rejects(
      acquireEnvLock(target, options({ clock: autoClock(Date.now()) })),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        for (const banned of [...hostile, '\n']) {
          assert.equal(
            error.message.includes(banned),
            false,
            `leaked ${JSON.stringify(banned)}`,
          );
        }
        assert.equal(error.message.includes('second line'), false);
        assert.ok(error.message.length < 600, `length ${String(error.message.length)}`);
        // Bounded, not blanked: the operator still sees what is in there.
        assert.match(error.message, /caf\u00e9-evilAAA/);
        return true;
      },
    );
  });

  it('treats an owner record of only blank and control bytes as no record', async () => {
    const target = join(dir, '.env');
    mkdirSync(`${target}.lock`);
    writeFileSync(join(`${target}.lock`, 'owner.json'), '\u0007\u0000\t\n');

    await assert.rejects(
      acquireEnvLock(target, options({ clock: autoClock(Date.now()) })),
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.match(error.message, /held by an unknown process/);
        return true;
      },
    );
  });

  it(
    'times out instead of looping when a stale lock cannot be removed',
    {
      skip: CAN_DENY_WRITE ? false : 'needs POSIX permissions as a non-root user',
    },
    async () => {
      const holder = join(dir, 'holder');
      mkdirSync(holder);
      const target = join(holder, '.env');
      mkdirSync(`${target}.lock`);

      const warnings: string[] = [];
      chmodSync(holder, 0o500);
      try {
        await assert.rejects(
          acquireEnvLock(
            target,
            options({
              clock: autoClock(Date.now() + 10 * DEFAULT_STALE_MS),
              onWarning: (message) => warnings.push(message),
            }),
          ),
          (error: unknown) => {
            assert.ok(error instanceof JiraError);
            assert.equal(error.kind, 'timeout');
            return true;
          },
        );
        // One break attempt, not one per retry: `brokenOnce` still holds when the
        // removal itself fails, so the warning is not repeated 20 times.
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0]), /stale lock/);
        assert.equal(existsSync(`${target}.lock`), true);
      } finally {
        chmodSync(holder, 0o700);
      }
    },
  );
});

describe('a holder whose lock was broken under it', () => {
  it('release does not remove the lock a second holder now owns', async () => {
    const target = join(dir, '.env');
    const warnings: string[] = [];
    const lock = await acquireEnvLock(
      target,
      options({ onWarning: (message) => warnings.push(message) }),
    );

    // What a stalled holder wakes up to: another process judged this lock
    // stale, broke it, and is now writing `target` under its own lock.
    rmSync(lock.path, { recursive: true, force: true });
    mkdirSync(lock.path);
    writeFileSync(join(lock.path, 'owner.json'), '{"pid":777}\n');

    lock.release();

    // Removing it here would hand `target` to a third writer while the second
    // is mid-write — the last-writer-wins failure the lock exists to prevent.
    assert.equal(existsSync(lock.path), true);
    assert.equal(readFileSync(join(lock.path, 'owner.json'), 'utf8'), '{"pid":777}\n');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /no longer ours/);
    assert.match(String(warnings[0]), /777/);
  });

  it('refresh does not resurrect a lock nobody holds', async () => {
    const target = join(dir, '.env');
    const warnings: string[] = [];
    const lock = await acquireEnvLock(
      target,
      options({ onWarning: (message) => warnings.push(message) }),
    );
    rmSync(lock.path, { recursive: true, force: true });

    lock.refresh();

    // `writeFileAtomic` would `mkdir -p` the lock back into existence, leaving
    // a directory with our record in it that nobody will ever release.
    assert.equal(existsSync(lock.path), false);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]), /no longer ours/);

    // And the lock is inert afterwards: no second warning, no resurrection.
    lock.refresh();
    lock.release();
    assert.equal(existsSync(lock.path), false);
    assert.equal(warnings.length, 1);
  });

  it('refresh does not overwrite a second holder record', async () => {
    const target = join(dir, '.env');
    const lock = await acquireEnvLock(target, options());
    writeFileSync(join(lock.path, 'owner.json'), '{"pid":777}\n');

    lock.refresh();

    assert.equal(readFileSync(join(lock.path, 'owner.json'), 'utf8'), '{"pid":777}\n');
  });

  it('refresh is inert after release', async () => {
    const lock = await acquireEnvLock(join(dir, '.env'), options());
    lock.release();
    lock.refresh();
    assert.equal(existsSync(lock.path), false);
  });

  it(
    'release survives a lock directory it cannot remove',
    { skip: CAN_DENY_WRITE ? false : 'needs POSIX permissions as a non-root user' },
    async () => {
      const holder = join(dir, 'holder');
      mkdirSync(holder);
      const lock = await acquireEnvLock(join(holder, '.env'), options());

      chmodSync(holder, 0o500);
      try {
        // A release that throws would escape the `finally` in `withEnvLock` and
        // mask whatever the guarded body was reporting.
        lock.release();
        assert.equal(existsSync(lock.path), true);
        lock.release();
      } finally {
        chmodSync(holder, 0o700);
      }
    },
  );
});

describe('withEnvLock / writeGuardedFile', () => {
  it('releases the lock when the body throws', async () => {
    const target = join(dir, '.env');
    await assert.rejects(
      withEnvLock(target, options(), () => {
        throw new Error('body failed');
      }),
      /body failed/,
    );
    assert.equal(existsSync(`${target}.lock`), false);
  });

  it('writes the guarded file at 0600 and leaves no lock behind', async () => {
    const target = join(dir, '.env');
    await writeGuardedFile(target, 'JIRA_SITE=mycompany\n', options());
    assert.equal(readFileSync(target, 'utf8'), 'JIRA_SITE=mycompany\n');
    if (POSIX) assert.equal(statSync(target).mode & 0o777, SECRET_FILE_MODE);
    assert.equal(existsSync(`${target}.lock`), false);
    assert.deepEqual(readdirSync(dir), ['.env']);
  });

  it('serializes writers: the second waits for the first to release', async () => {
    const target = join(dir, '.env');
    const order: string[] = [];
    const first = await acquireEnvLock(target, options());
    order.push('first-acquired');

    const secondPromise = acquireEnvLock(
      target,
      options({ acquireTimeoutMs: 5000, retryDelayMs: 1 }),
    ).then((lock) => {
      order.push('second-acquired');
      return lock;
    });

    // The waiter cannot make progress until the holder releases.
    await Promise.resolve();
    assert.deepEqual(order, ['first-acquired']);
    first.release();

    const second = await secondPromise;
    assert.deepEqual(order, ['first-acquired', 'second-acquired']);
    second.release();
  });
});
