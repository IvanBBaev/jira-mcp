import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JournalEntryInput } from '../types.js';
import { createFakeClock } from './fakeClock.js';
import { createMemoryJournal } from './memoryJournal.js';

const ENTRY: JournalEntryInput = {
  cid: 'c-4f9a01',
  tool: 'jira_issue_update',
  argsHash: 'sha256:deadbeef',
  ok: true,
  httpStatus: 204,
  issueKey: 'ABC-1',
};

test('an appended entry is recorded and stamped from the injected clock', async () => {
  const clock = createFakeClock(Date.parse('2026-08-09T10:00:00.000Z'));
  const journal = createMemoryJournal(clock);

  assert.equal(await journal.append(ENTRY), 'ok');
  assert.deepEqual(journal.entries, [{ ...ENTRY, ts: '2026-08-09T10:00:00.000Z' }]);

  clock.advance(1_500);
  await journal.append({ ...ENTRY, issueKey: 'ABC-2' });
  assert.equal(journal.entries[1]?.ts, '2026-08-09T10:00:01.500Z');
});

test('appends are kept in order', async () => {
  const journal = createMemoryJournal(createFakeClock());
  await journal.append({ ...ENTRY, issueKey: 'ABC-1' });
  await journal.append({ ...ENTRY, issueKey: 'ABC-2' });

  const keys = journal.entries.map((e) => e.issueKey);
  assert.deepEqual(keys, ['ABC-1', 'ABC-2']);
});

test('a journal failure returns "failed" and never throws (CC-33)', async () => {
  const journal = createMemoryJournal(createFakeClock());
  journal.failNext();

  // The write already happened upstream; throwing here would tell the model to
  // retry a write that in fact succeeded.
  assert.equal(await journal.append(ENTRY), 'failed');
  assert.equal(journal.entries.length, 0, 'a failed append records nothing');
  assert.equal(await journal.append(ENTRY), 'ok');
  assert.equal(journal.entries.length, 1);
});

test('failNext(n) fails exactly n appends', async () => {
  const journal = createMemoryJournal(createFakeClock());
  journal.failNext(2);

  assert.equal(await journal.append(ENTRY), 'failed');
  assert.equal(await journal.append(ENTRY), 'failed');
  assert.equal(await journal.append(ENTRY), 'ok');
});

test('clear drops entries and pending failures', async () => {
  const journal = createMemoryJournal(createFakeClock());
  journal.failNext(3);
  await journal.append(ENTRY);

  journal.clear();
  assert.equal(journal.entries.length, 0);
  assert.equal(await journal.append(ENTRY), 'ok');
});
