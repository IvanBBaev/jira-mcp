// Tests for `mcp/recent-writes.ts` (WP-51) — CC-02's session registry.
//
// Two properties matter here and are asserted directly rather than through the
// server: the BOUND (an unbounded registry would make `api/search.ts` refuse
// every search that carries it, since `reconcileIssues` accepts at most fifty
// ids), and the EXTRACTION rule — an id recorded wrongly is worse than one not
// recorded at all, because it silently reconciles a stranger's issue on every
// later search.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_RECENT_WRITES,
  createRecentWrites,
  sessionRecentWrites,
  writtenIssueIds,
} from './recent-writes.js';
import type { ToolResult } from './types.js';

/** A successful envelope carrying `data` — the only shape extraction reads. */
function okResult(data: unknown): ToolResult<unknown> {
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('a fresh registry is empty and hands back a detached array', () => {
  const recent = createRecentWrites();

  assert.deepEqual(recent.snapshot(), []);
  assert.notEqual(recent.snapshot(), recent.snapshot());
});

test('ids come back in insertion order', () => {
  const recent = createRecentWrites();
  recent.record(['10003']);
  recent.record(['10001', '10002']);

  assert.deepEqual(recent.snapshot(), ['10003', '10001', '10002']);
});

test('re-recording an id moves it to the end instead of duplicating it', () => {
  const recent = createRecentWrites();
  recent.record(['10001', '10002']);
  recent.record(['10001']);

  assert.deepEqual(recent.snapshot(), ['10002', '10001']);
});

test('the registry is bounded, dropping the oldest ids first', () => {
  const recent = createRecentWrites();
  for (let n = 1; n <= MAX_RECENT_WRITES + 5; n += 1) recent.record([String(10_000 + n)]);

  const snapshot = recent.snapshot();
  assert.equal(snapshot.length, MAX_RECENT_WRITES);
  // The five oldest are gone; the newest is last.
  assert.equal(snapshot[0], '10006');
  assert.equal(snapshot.at(-1), String(10_000 + MAX_RECENT_WRITES + 5));
});

test('the bound is the reconcile cap `api/search.ts` enforces', () => {
  // A larger registry would make every auto-reconciled search fail validation.
  assert.equal(MAX_RECENT_WRITES, 50);
});

test('a non-numeric id is never recorded — reconcileIssues takes ids, not keys', () => {
  const recent = createRecentWrites();
  recent.record(['ABC-1', '', ' ', '10_001', '10001']);

  assert.deepEqual(recent.snapshot(), ['10001']);
});

test('clear forgets everything', () => {
  const recent = createRecentWrites();
  recent.record(['10001']);
  recent.clear();

  assert.deepEqual(recent.snapshot(), []);
});

test('the ambient session registry is a registry like any other', () => {
  sessionRecentWrites.clear();
  try {
    sessionRecentWrites.record(['10001']);
    assert.deepEqual(sessionRecentWrites.snapshot(), ['10001']);
  } finally {
    sessionRecentWrites.clear();
  }
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test('a numeric issue argument is the id that was written', () => {
  assert.deepEqual(writtenIssueIds({ issue: '10001' }), ['10001']);
  assert.deepEqual(writtenIssueIds({ issue: 10_001 }), ['10001']);
});

test('an issue KEY argument yields nothing — it cannot be resolved offline', () => {
  assert.deepEqual(writtenIssueIds({ issue: 'ABC-1' }), []);
});

test('both ends of a link are recorded, numeric ones only', () => {
  assert.deepEqual(writtenIssueIds({ inwardIssue: '10001', outwardIssue: 'ABC-2' }), [
    '10001',
  ]);
  assert.deepEqual(writtenIssueIds({ inwardIssue: '10001', outwardIssue: '10002' }), [
    '10001',
    '10002',
  ]);
});

test('a batch argument contributes every numeric member (jira_move_to_sprint)', () => {
  assert.deepEqual(writtenIssueIds({ issues: ['10001', 'ABC-2', '10003'] }), [
    '10001',
    '10003',
  ]);
});

test('a create contributes the id it just minted', () => {
  assert.deepEqual(writtenIssueIds({}, okResult({ id: '10009', key: 'ABC-9' })), [
    '10009',
  ]);
});

test('a comment id is NOT an issue id', () => {
  // `jira_add_comment` returns the COMMENT: an `id`, and no issue `key`.
  assert.deepEqual(
    writtenIssueIds({ issue: 'ABC-1' }, okResult({ id: '10500', body: 'hi' })),
    [],
  );
});

test('a worklog contributes its issueId and never its own id', () => {
  assert.deepEqual(
    writtenIssueIds({ issue: 'ABC-1' }, okResult({ id: '10600', issueId: '10001' })),
    ['10001'],
  );
});

test('a result that is not an object contributes nothing', () => {
  assert.deepEqual(writtenIssueIds({}, okResult(null)), []);
  assert.deepEqual(writtenIssueIds({}, okResult('ABC-1')), []);
  assert.deepEqual(writtenIssueIds({}), []);
});

test('a nonsense argument shape is ignored rather than recorded', () => {
  assert.deepEqual(
    writtenIssueIds({ issue: { id: '10001' }, issues: 'ABC-1', inwardIssue: null }),
    [],
  );
});
