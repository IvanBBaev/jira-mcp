import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraErr, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import type { ProgressNotification } from './progress.js';
import {
  countRequests,
  createProgressSink,
  PROGRESS_MIN_INTERVAL_MS,
} from './progress.js';
import type { ProgressUpdate } from './types.js';

function recorder(): {
  readonly sent: ProgressNotification[];
  readonly send: (n: ProgressNotification) => Promise<void>;
} {
  const sent: ProgressNotification[] = [];
  return {
    sent,
    send: (n) => {
      sent.push(n);
      return Promise.resolve();
    },
  };
}

test('[CC-1553] the sink sends the first update, throttles the rest and flushes the newest', () => {
  const clock = createFakeClock(1_000);
  const { sent, send } = recorder();
  const progress = createProgressSink('tok-1', send, clock);

  progress.sink({ progress: 1, message: 'one' });
  progress.sink({ progress: 2 });
  progress.sink({ progress: 3, message: 'three' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    method: 'notifications/progress',
    params: { progressToken: 'tok-1', progress: 1, message: 'one' },
  });

  clock.advance(PROGRESS_MIN_INTERVAL_MS);
  progress.sink({ progress: 4, total: 10 });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]?.params, { progressToken: 'tok-1', progress: 4, total: 10 });

  // Completing the work is never held back.
  progress.sink({ progress: 10, total: 10 });
  assert.equal(sent.length, 3);

  progress.sink({ progress: 11 });
  progress.flush();
  assert.deepEqual(
    sent.map((n) => n.params.progress),
    [1, 4, 10, 11],
  );
  // Nothing pending: a second flush sends nothing.
  progress.flush();
  assert.equal(sent.length, 4);
});

test('[CC-1554] the sink never goes backwards and never fails the call', () => {
  const clock = createFakeClock(1_000);
  const { sent, send } = recorder();
  const progress = createProgressSink(7, send, clock, 0);

  progress.sink({ progress: 2 });
  progress.sink({ progress: 2 });
  progress.sink({ progress: 1 });
  progress.sink({ progress: Number.NaN });
  progress.sink({ progress: 3, message: '' });
  assert.deepEqual(
    sent.map((n) => n.params),
    [
      { progressToken: 7, progress: 2 },
      { progressToken: 7, progress: 3 },
    ],
  );

  const rejecting = createProgressSink(
    't',
    () => Promise.reject(new Error('gone')),
    clock,
    0,
  );
  assert.doesNotThrow(() => {
    rejecting.sink({ progress: 1 });
  });
  const throwing = createProgressSink(
    't',
    () => {
      throw new Error('closed');
    },
    clock,
    0,
  );
  assert.doesNotThrow(() => {
    throwing.sink({ progress: 1 });
  });
});

test('[CC-1555] countRequests reports every settled request, answered or failed', async () => {
  const fake = createFakeJiraRequest()
    .on('GET /rest/api/3/myself', jiraOk({ accountId: 'a' }))
    .on('GET /rest/api/3/issue/X-1', jiraErr(new Error('boom')));
  const updates: ProgressUpdate[] = [];
  const jira = countRequests(fake.fn, (update) => updates.push(update));

  const response = await jira({ method: 'GET', path: '/myself', safe: true });
  assert.deepEqual(response.data, { accountId: 'a' });
  await assert.rejects(jira({ method: 'GET', path: '/issue/X-1', safe: true }));

  assert.deepEqual(updates, [
    { progress: 1, message: '1 Jira request(s) completed' },
    { progress: 2, message: '2 Jira request(s) completed' },
  ]);
});
