// The abort envelope of one attempt, and the clock-driven deadline the slot
// queue waits under (D515). Both are clock sleeps, never real timers.

import type { Clock } from '../types.js';
import { abortError, timeoutError } from './failures.js';

/**
 * The abort envelope of ONE attempt: the signal every `fetch` of that attempt
 * carries, plus a race that ends any promise the attempt is waiting on.
 *
 * It is armed before the first byte is sent and disarmed only after the last
 * byte is read, so the attempt timeout (and through it the call budget) covers
 * the body, not just the headers.
 */
export interface AttemptGuard {
  /** Handed to `fetch`; aborted by the timeout or by the caller's own signal. */
  readonly signal: AbortSignal;
  /**
   * Race `work` against the guard, so a fetch — or a body stream — that ignores
   * `signal` still cannot hang the call.
   */
  readonly guard: <V>(work: Promise<V>) => Promise<V>;
  /** Stop the timer and detach the caller-abort listener. Idempotent. */
  readonly disarm: () => Promise<void>;
}

/**
 * Arm one attempt's timeout. The timer is a clock sleep, not a real one, and it
 * is disarmed by the attempt's own `finally` — after the body, not after the
 * headers.
 *
 * It takes its clock and the caller's signal as arguments rather than closing
 * over a request, because the OAuth primitive (`auth-request.ts`) needs exactly the same
 * envelope and a second hand-rolled timer is a second place for the fake clock
 * to be forgotten.
 */
export function armAttempt(
  clock: Clock,
  attemptTimeoutMs: number,
  callerSignal?: AbortSignal,
): AttemptGuard {
  const fetchAbort = new AbortController();
  const stopTimer = new AbortController();
  let timedOut = false;

  const onCallerAbort = (): void => {
    fetchAbort.abort();
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  // Rejects as soon as the controller aborts, whoever aborted it — so a fetch
  // implementation that ignores `signal` still cannot hang the call.
  const aborted = new Promise<never>((_resolve, reject) => {
    fetchAbort.signal.addEventListener(
      'abort',
      () => {
        reject(timedOut ? timeoutError() : abortError());
      },
      { once: true },
    );
  });
  // Each `guard()` race observes this rejection, but the last race of an attempt
  // may already have settled when the abort lands; claiming it here keeps that
  // from being reported as an unhandled rejection.
  void aborted.catch(() => undefined);

  const timer = clock.sleep(attemptTimeoutMs, stopTimer.signal).then(
    () => {
      timedOut = true;
      fetchAbort.abort();
    },
    () => {
      // Timer cancelled because the attempt finished first.
    },
  );

  return {
    signal: fetchAbort.signal,
    guard: <V>(work: Promise<V>): Promise<V> => Promise.race([work, aborted]),
    disarm: async () => {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      stopTimer.abort();
      await timer;
    },
  };
}

/** A clock-driven deadline: see {@link armDeadline}. */
export interface Deadline {
  readonly signal: AbortSignal;
  readonly expired: () => boolean;
  readonly cancel: () => Promise<void>;
}

/**
 * Arm a clock-driven deadline. `signal` fires when `ms` of clock time pass;
 * `cancel()` stops the pending sleep so the fake clock ends a test with no
 * leaked waiters.
 */
export function armDeadline(clock: Clock, ms: number): Deadline {
  const trigger = new AbortController();
  const stop = new AbortController();
  let expired = false;
  const timer = clock.sleep(Math.max(0, ms), stop.signal).then(
    () => {
      expired = true;
      trigger.abort();
    },
    () => {
      // Cancelled because the operation finished first: the normal path.
    },
  );
  return {
    signal: trigger.signal,
    expired: () => expired,
    cancel: async () => {
      stop.abort();
      await timer;
    },
  };
}
