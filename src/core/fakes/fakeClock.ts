// Manually driven {@link Clock} (test-only).
//
// Time never advances on its own: `now()` returns the current virtual time and
// `sleep()` resolves only when the test ticks the clock past the sleep's due
// time. No real timer is involved anywhere — which is the point, because the
// retry/backoff sequences of `core/http.ts` are asserted exactly (CC-11…CC-14)
// and a suite that waited 8 real seconds for one backoff would never be run.

import type { Clock } from '../types.js';

/** A {@link Clock} whose time is driven manually by the test. */
export interface FakeClock extends Clock {
  /** Advance virtual time by `ms`, resolving every sleep that comes due. */
  advance(ms: number): void;
  /** Set virtual time absolutely (epoch ms), resolving any now-due sleeps. */
  set(ms: number): void;
  /** How many sleeps are still waiting — a leak check for retry loops. */
  pendingSleeps(): number;
}

interface PendingSleep {
  due: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * The rejection a cancelled `sleep` produces. `name` is `AbortError` because
 * that is what callers branch on — the platform's own convention, and
 * `core/http.ts` distinguishes an abort from a timeout by it.
 */
function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Create a controllable clock starting at `startMs` (default 0).
 *
 * NOTE: even `sleep(0)` resolves only on the next `advance`/`set` tick. That is
 * deliberate — a test that forgets to tick then surfaces as a hang, which is
 * debuggable, instead of a race that passes on one machine and fails on another.
 */
export function createFakeClock(startMs = 0): FakeClock {
  let current = startMs;
  let pending: PendingSleep[] = [];

  const detach = (p: PendingSleep): void => {
    if (p.signal && p.onAbort) {
      p.signal.removeEventListener('abort', p.onAbort);
    }
  };

  const flush = (): void => {
    // Due order, ties broken by registration order (Array#sort is stable): a
    // single `advance` past several sleeps must release them in the order a real
    // timer would, or a test asserting a retry sequence reads backwards.
    const due = pending.filter((p) => p.due <= current).sort((a, b) => a.due - b.due);
    if (due.length === 0) return;
    pending = pending.filter((p) => p.due > current);
    for (const p of due) {
      detach(p);
      p.resolve();
    }
  };

  return {
    now: () => current,

    sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const entry: PendingSleep = { due: current + ms, resolve, reject };
        if (signal) {
          const onAbort = (): void => {
            pending = pending.filter((p) => p !== entry);
            detach(entry);
            reject(abortError());
          };
          entry.signal = signal;
          entry.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        pending.push(entry);
      }),

    advance: (ms: number): void => {
      current += ms;
      flush();
    },

    set: (ms: number): void => {
      current = ms;
      flush();
    },

    pendingSleeps: () => pending.length,
  };
}
