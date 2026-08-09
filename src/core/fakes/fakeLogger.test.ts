import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOG_EVENT_LEVEL } from '../types.js';
import { createFakeClock } from './fakeClock.js';
import { createFakeLogger } from './fakeLogger.js';

test('an emitted event records name, level, cid and fields', () => {
  const log = createFakeLogger({ cid: 'cid-1' });
  log.emit('http_retry', { attempt: 2, status: 503 });

  assert.equal(log.events.length, 1);
  const [event] = log.events;
  assert.equal(event?.event, 'http_retry');
  assert.equal(event?.cid, 'cid-1');
  assert.deepEqual(event?.fields, { attempt: 2, status: 503 });
});

test('the level always comes from the contract table, never from the caller', () => {
  const log = createFakeLogger();
  log.emit('tool_call_start');
  log.emit('ambiguous_write');
  log.emit('shutdown');

  assert.deepEqual(
    log.events.map((e) => e.level),
    [
      LOG_EVENT_LEVEL['tool_call_start'],
      LOG_EVENT_LEVEL['ambiguous_write'],
      LOG_EVENT_LEVEL['shutdown'],
    ],
  );
  assert.equal(log.events[1]?.level, 'error');
});

test('the root cid defaults to "-", as at startup', () => {
  const log = createFakeLogger();
  log.emit('server_start');
  assert.equal(log.events[0]?.cid, '-');
});

test('ts comes from the injected clock, and is 0 without one', () => {
  const clock = createFakeClock(1_700_000_000_000);
  const timed = createFakeLogger({ clock });
  timed.emit('http_request');
  clock.advance(250);
  timed.emit('http_response');

  assert.equal(timed.events[0]?.ts, 1_700_000_000_000);
  assert.equal(timed.events[1]?.ts, 1_700_000_000_250);

  const untimed = createFakeLogger();
  untimed.emit('server_start');
  assert.equal(untimed.events[0]?.ts, 0);
});

test('withCid children carry the new cid and share the parent recording', () => {
  const log = createFakeLogger({ cid: '-' });
  log.emit('server_start');

  const call = log.withCid('cid-42');
  call.emit('tool_call_start', { tool: 'jira_search' });
  call.withCid('cid-43').emit('tool_call_end');

  assert.deepEqual(
    log.events.map((e) => e.cid),
    ['-', 'cid-42', 'cid-43'],
  );
  assert.equal(log.events.length, 3, 'one assertion sees the whole call');
});

test('eventsOf, has and clear query the recording', () => {
  const log = createFakeLogger();
  log.emit('http_retry', { attempt: 1 });
  log.emit('http_retry', { attempt: 2 });
  log.emit('rate_limited');

  assert.equal(log.eventsOf('http_retry').length, 2);
  assert.deepEqual(log.eventsOf('http_retry')[1]?.fields, { attempt: 2 });
  assert.equal(log.has('rate_limited'), true);
  assert.equal(log.has('auth_failure'), false);

  log.clear();
  assert.equal(log.events.length, 0);
  assert.equal(log.has('http_retry'), false);
});
