import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeClock } from './fakeClock.js';

test('time starts where the test put it and never moves on its own', async () => {
  const clock = createFakeClock(1_700_000_000_000);
  assert.equal(clock.now(), 1_700_000_000_000);
  await Promise.resolve();
  assert.equal(clock.now(), 1_700_000_000_000);
});

test('sleep resolves only once the clock is advanced past its due time', async () => {
  const clock = createFakeClock();
  let resolved = false;
  const sleeping = clock.sleep(100).then(() => {
    resolved = true;
  });

  assert.equal(clock.pendingSleeps(), 1);
  clock.advance(99);
  await Promise.resolve();
  assert.equal(resolved, false, 'must not resolve one millisecond early');

  clock.advance(1);
  await sleeping;
  assert.equal(resolved, true);
  assert.equal(clock.now(), 100);
  assert.equal(clock.pendingSleeps(), 0);
});

test('even sleep(0) waits for an explicit tick', async () => {
  const clock = createFakeClock();
  let resolved = false;
  const sleeping = clock.sleep(0).then(() => {
    resolved = true;
  });

  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(clock.pendingSleeps(), 1);

  clock.advance(0);
  await sleeping;
  assert.equal(resolved, true);
});

test('one advance releases every sleep that came due, in due order', async () => {
  const clock = createFakeClock();
  const order: number[] = [];
  const all = Promise.all([
    clock.sleep(300).then(() => order.push(300)),
    clock.sleep(100).then(() => order.push(100)),
    clock.sleep(200).then(() => order.push(200)),
  ]);

  assert.equal(clock.pendingSleeps(), 3);
  clock.advance(150);
  await Promise.resolve();
  assert.deepEqual(order, [100]);
  assert.equal(clock.pendingSleeps(), 2);

  clock.advance(150);
  await all;
  assert.deepEqual(order, [100, 200, 300]);
});

test('set moves time absolutely', async () => {
  const clock = createFakeClock(1000);
  const sleeping = clock.sleep(500);
  clock.set(2000);
  await sleeping;
  assert.equal(clock.now(), 2000);
});

test('an already-aborted signal rejects immediately with AbortError', async () => {
  const clock = createFakeClock();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(clock.sleep(100, controller.signal), { name: 'AbortError' });
  assert.equal(clock.pendingSleeps(), 0);
});

test('aborting mid-sleep rejects and drops the pending sleep', async () => {
  const clock = createFakeClock();
  const controller = new AbortController();
  const sleeping = clock.sleep(100, controller.signal);
  assert.equal(clock.pendingSleeps(), 1);

  controller.abort();
  await assert.rejects(sleeping, { name: 'AbortError' });
  assert.equal(clock.pendingSleeps(), 0);

  // A later tick must not try to resolve the abandoned sleep.
  clock.advance(1000);
  assert.equal(clock.pendingSleeps(), 0);
});

test('a completed sleep is not disturbed by a later abort', async () => {
  const clock = createFakeClock();
  const controller = new AbortController();
  const sleeping = clock.sleep(10, controller.signal);
  clock.advance(10);
  await sleeping;

  controller.abort(); // the listener was detached; nothing to reject
  assert.equal(clock.pendingSleeps(), 0);
});
