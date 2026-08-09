import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import {
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
