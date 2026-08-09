import { getEventListeners } from 'node:events';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSystemClock, systemClock } from './clock.js';

/** How many timers the runtime is currently holding. */
function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

async function expectAbort(promise: Promise<void>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error('expected the sleep to reject');
}

describe('createSystemClock', () => {
  it('now() reports wall-clock epoch milliseconds', () => {
    const clock = createSystemClock();
    const before = Date.now();
    const observed = clock.now();
    const after = Date.now();

    assert.ok(Number.isInteger(observed));
    assert.ok(
      observed >= before && observed <= after,
      `${observed} outside [${before}, ${after}]`,
    );
  });

  it('now() advances as real time passes', async () => {
    const clock = createSystemClock();
    const first = clock.now();
    await clock.sleep(12);
    assert.ok(clock.now() >= first + 10, 'the clock did not move across a sleep');
  });

  it('sleep resolves after the requested delay', async () => {
    const clock = createSystemClock();
    const started = Date.now();
    await clock.sleep(25);
    // Timers may fire a hair early on some platforms; the point is that it waited.
    assert.ok(Date.now() - started >= 20, 'sleep returned too early');
  });

  it('sleep(0) resolves without waiting', async () => {
    const clock = createSystemClock();
    const started = Date.now();
    await clock.sleep(0);
    assert.ok(Date.now() - started < 100);
  });

  it('sleep clamps a non-finite or negative delay instead of throwing', async () => {
    const clock = createSystemClock();
    await clock.sleep(-500);
    await clock.sleep(Number.NaN);
  });

  it('sleep rejects with an AbortError when the signal is already aborted', async () => {
    const clock = createSystemClock();
    const error = await expectAbort(clock.sleep(50_000, AbortSignal.abort()));
    assert.equal(error.name, 'AbortError');
  });

  it('sleep rejects promptly when the signal aborts mid-wait', async () => {
    const clock = createSystemClock();
    const controller = new AbortController();
    const started = Date.now();
    const pending = clock.sleep(60_000, controller.signal);

    setTimeout(() => controller.abort(), 5);
    const error = await expectAbort(pending);

    assert.equal(error.name, 'AbortError');
    assert.ok(Date.now() - started < 1_000, 'the abort did not short-circuit the wait');
  });

  it('sleep leaves no dangling timer after an abort', async () => {
    const clock = createSystemClock();
    const baseline = activeTimers();

    const controller = new AbortController();
    const pending = clock.sleep(60_000, controller.signal);
    assert.equal(activeTimers(), baseline + 1, 'the sleep did not arm a timer');

    controller.abort();
    await expectAbort(pending);

    // The whole point: an aborted retry wait must not keep the event loop (or a
    // test run, or the process after shutdown) alive for another minute.
    assert.equal(activeTimers(), baseline, 'the aborted sleep left its timer armed');
  });

  it('sleep leaves no dangling timer after resolving', async () => {
    const clock = createSystemClock();
    const baseline = activeTimers();
    await clock.sleep(5);
    assert.equal(activeTimers(), baseline);
  });

  it('sleep detaches its abort listener when it resolves', async () => {
    const clock = createSystemClock();
    const controller = new AbortController();

    for (let i = 0; i < 5; i += 1) {
      await clock.sleep(1, controller.signal);
    }

    // A signal that outlives many waits (one per retry attempt) must not
    // accumulate a listener per completed wait.
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('exposes a ready-made system clock', () => {
    assert.equal(typeof systemClock.now, 'function');
    assert.equal(typeof systemClock.sleep, 'function');
    assert.ok(
      systemClock.now() > 1_600_000_000_000,
      'the shared clock is not wall-clock bound',
    );
  });
});
