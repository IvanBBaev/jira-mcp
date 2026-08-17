import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeClock } from './fakes/fakeClock.js';
import { createFakeLogger } from './fakes/fakeLogger.js';
import { createFakeRedactor, FAKE_PLACEHOLDER } from './fakes/fakeRedactor.js';
import {
  createFileJournal,
  JOURNAL_FILE_MODE,
  UNKNOWN_JOURNAL_ERROR,
} from './journal.js';
import type { JournalEntryInput } from './types.js';

// The journal is the one core module that touches the filesystem, so these
// tests use a real temp directory (the network fence covers sockets, not files).
// Everything else is injected: time from the fake clock, so `ts` is asserted
// exactly rather than matched against a regex.

const ENTRY: JournalEntryInput = {
  cid: 'c-4f9a01',
  tool: 'jira_issue_update',
  argsHash: 'sha256:deadbeef',
  ok: true,
  httpStatus: 204,
  issueKey: 'ABC-1',
};

const AT = Date.parse('2026-08-09T10:00:00.000Z');

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-journal-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Split a JSONL file into its lines, dropping the trailing empty one. */
async function lines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

test('an append writes one JSONL line in the documented field order', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const journal = createFileJournal({ path, clock: createFakeClock(AT) });

    assert.equal(await journal.append(ENTRY), 'ok');

    const written = await lines(path);
    assert.equal(written.length, 1);
    // Field ORDER is part of the shape an operator reads with `head -1`
    // (OBSERVABILITY.md §Write journal), so compare the raw line, not the parse.
    assert.equal(
      written[0],
      '{"ts":"2026-08-09T10:00:00.000Z","cid":"c-4f9a01","tool":"jira_issue_update",' +
        '"argsHash":"sha256:deadbeef","ok":true,"httpStatus":204,"issueKey":"ABC-1"}',
    );
  });
});

test('optional fields are omitted rather than written as null', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const journal = createFileJournal({ path, clock: createFakeClock(AT) });

    await journal.append({
      cid: 'c-000001',
      tool: 'jira_comment_add',
      argsHash: 'sha256:abc',
      ok: false,
    });

    const [line] = await lines(path);
    assert.ok(line !== undefined);
    assert.equal(line.includes('httpStatus'), false);
    assert.equal(line.includes('issueKey'), false);
    assert.deepEqual(JSON.parse(line), {
      ts: '2026-08-09T10:00:00.000Z',
      cid: 'c-000001',
      tool: 'jira_comment_add',
      argsHash: 'sha256:abc',
      ok: false,
    });
  });
});

test('the timestamp comes from the injected clock, not the wall clock', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const clock = createFakeClock(AT);
    const journal = createFileJournal({ path, clock });

    await journal.append(ENTRY);
    clock.advance(1_500);
    await journal.append(ENTRY);

    const stamps = (await lines(path)).map(
      (line) => (JSON.parse(line) as { ts: string }).ts,
    );
    assert.deepEqual(stamps, ['2026-08-09T10:00:00.000Z', '2026-08-09T10:00:01.500Z']);
  });
});

test('concurrent appends are serialized into whole, ordered lines', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const journal = createFileJournal({ path, clock: createFakeClock(AT) });

    // Fired without awaiting: the promise chain inside the journal is the only
    // thing keeping these three lines from interleaving.
    const statuses = await Promise.all([
      journal.append({ ...ENTRY, issueKey: 'ABC-1' }),
      journal.append({ ...ENTRY, issueKey: 'ABC-2' }),
      journal.append({ ...ENTRY, issueKey: 'ABC-3' }),
    ]);
    assert.deepEqual(statuses, ['ok', 'ok', 'ok']);

    const keys = (await lines(path)).map(
      (line) => (JSON.parse(line) as { issueKey: string }).issueKey,
    );
    assert.deepEqual(keys, ['ABC-1', 'ABC-2', 'ABC-3']);
  });
});

test('the file is created 0600', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const journal = createFileJournal({ path, clock: createFakeClock(AT) });

    await journal.append(ENTRY);

    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, JOURNAL_FILE_MODE);
  });
});

test('the journal rotates to .1 once the next line would cross the threshold', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    // One entry is ~150 bytes, so a 200-byte budget rotates on every append
    // after the first — the mechanism, at a size a test can assert.
    const journal = createFileJournal({
      path,
      clock: createFakeClock(AT),
      maxBytes: 200,
    });

    await journal.append({ ...ENTRY, issueKey: 'ABC-1' });
    await journal.append({ ...ENTRY, issueKey: 'ABC-2' });

    const current = await lines(path);
    const previous = await lines(`${path}.1`);
    assert.equal(current.length, 1);
    assert.equal(previous.length, 1);
    assert.equal(
      (JSON.parse(current[0] ?? '{}') as { issueKey: string }).issueKey,
      'ABC-2',
    );
    assert.equal(
      (JSON.parse(previous[0] ?? '{}') as { issueKey: string }).issueKey,
      'ABC-1',
    );
  });
});

test('rotation keeps exactly one previous generation', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const journal = createFileJournal({
      path,
      clock: createFakeClock(AT),
      maxBytes: 200,
    });

    await journal.append({ ...ENTRY, issueKey: 'ABC-1' });
    await journal.append({ ...ENTRY, issueKey: 'ABC-2' });
    await journal.append({ ...ENTRY, issueKey: 'ABC-3' });

    // The oldest generation is gone, not archived to `.2` — the whole point of
    // the bound is that the journal cannot grow without limit.
    await assert.rejects(stat(`${path}.2`));
    assert.equal(
      (JSON.parse((await lines(`${path}.1`))[0] ?? '{}') as { issueKey: string })
        .issueKey,
      'ABC-2',
    );
  });
});

test('an unwritable path returns "failed" and emits journal_write_failed (CC-33)', async () => {
  await withTempDir(async (dir) => {
    // A path whose parent directory does not exist: ENOENT on open, every time.
    const path = join(dir, 'missing-dir', 'writes.jsonl');
    const logger = createFakeLogger();
    const journal = createFileJournal({ path, clock: createFakeClock(AT), logger });

    assert.equal(await journal.append(ENTRY), 'failed');

    const failures = logger.eventsOf('journal_write_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.level, 'warn');
    assert.equal(failures[0]?.fields?.['errorKind'], 'ENOENT');
  });
});

test('a failed append never poisons the serialization chain', async () => {
  await withTempDir(async (dir) => {
    const subdir = join(dir, 'later');
    const path = join(subdir, 'writes.jsonl');
    const journal = createFileJournal({ path, clock: createFakeClock(AT) });

    // First append lands before the directory exists.
    assert.equal(await journal.append({ ...ENTRY, issueKey: 'ABC-1' }), 'failed');

    await mkdir(subdir);

    // Same instance: the chain is kept resolved, so the next append proceeds.
    assert.equal(await journal.append({ ...ENTRY, issueKey: 'ABC-2' }), 'ok');
    const keys = (await lines(path)).map(
      (line) => (JSON.parse(line) as { issueKey: string }).issueKey,
    );
    assert.deepEqual(keys, ['ABC-2']);
  });
});

test('the failure event carries no path and no message', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'missing-dir', 'writes.jsonl');
    const logger = createFakeLogger();
    const journal = createFileJournal({ path, clock: createFakeClock(AT), logger });

    await journal.append(ENTRY);

    const serialized = JSON.stringify(logger.events);
    // The never-log list: a journal path can name a project directory.
    assert.equal(serialized.includes(dir), false);
    assert.equal(serialized.includes('missing-dir'), false);
    assert.deepEqual(Object.keys(logger.events[0]?.fields ?? {}), ['errorKind']);
  });
});

test('a non-errno failure degrades to the unknown error kind', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const logger = createFakeLogger();
    const journal = createFileJournal({
      path,
      // A clock that throws stands in for any failure without an errno; the
      // contract is the same, and the append still resolves.
      clock: {
        now: (): number => {
          throw new Error('clock is broken');
        },
        sleep: (): Promise<void> => Promise.resolve(),
      },
      logger,
    });

    assert.equal(await journal.append(ENTRY), 'failed');
    assert.equal(
      logger.eventsOf('journal_write_failed')[0]?.fields?.['errorKind'],
      UNKNOWN_JOURNAL_ERROR,
    );
  });
});

test('the serialized line passes through the redactor', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    const redactor = createFakeRedactor(['sha256:deadbeef']);
    const journal = createFileJournal({ path, clock: createFakeClock(AT), redactor });

    await journal.append(ENTRY);

    const [line] = await lines(path);
    assert.ok(line !== undefined);
    assert.equal(line.includes('sha256:deadbeef'), false);
    assert.equal((JSON.parse(line) as { argsHash: string }).argsHash, FAKE_PLACEHOLDER);
  });
});

test('an existing journal is appended to, not truncated', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'writes.jsonl');
    await writeFile(path, '{"ts":"2026-01-01T00:00:00.000Z"}\n', {
      mode: JOURNAL_FILE_MODE,
    });

    const journal = createFileJournal({ path, clock: createFakeClock(AT) });
    await journal.append(ENTRY);

    const written = await lines(path);
    assert.equal(written.length, 2);
    assert.equal(
      (JSON.parse(written[0] ?? '{}') as { ts: string }).ts,
      '2026-01-01T00:00:00.000Z',
    );
  });
});
