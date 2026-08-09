// The real {@link Clock} — the ONLY module (with `core/rng.ts`) where the host
// time primitives are lint-legal (ARCHITECTURE.md §Cross-cutting seams).
//
// Everything else in the server takes a `Clock` by injection, so retry backoff,
// per-request timeouts, the call budget and every `durationMs` field of the
// log-event table are asserted exactly under `createFakeClock` (CC-11…CC-14)
// instead of being wall-clock bound.
//
// `sleep` is the timeout primitive too: `AbortSignal.timeout` is banned
// project-wide [eslint] because it owns a real timer the fake clock cannot
// drive, so a per-request timeout is `sleep(ms, signal)` raced against the fetch
// promise with an explicit `AbortController`.

import type { Clock } from './types.js';

/**
 * Node's timer ceiling: a delay above this overflows the internal 32-bit field
 * and the timer fires almost immediately (with a runtime warning). A Jira
 * `Retry-After` is capped long before it reaches here, but a clamp costs one
 * comparison and turns a "why did the backoff not wait?" bug into a no-op.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The rejection a cancelled `sleep` produces. `name` is `AbortError` because
 * that is what callers branch on — the platform convention, matched by
 * `createFakeClock` so code cannot tell the two clocks apart.
 */
function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** Non-finite or negative waits collapse to 0; huge waits clamp to Node's ceiling. */
function normalizeDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_TIMEOUT_MS);
}

/**
 * Create a {@link Clock} backed by the host: `Date.now()` and `setTimeout`.
 *
 * `sleep` never leaves a timer behind — the abort path clears it and the timer
 * path detaches the abort listener, so a cancelled retry wait does not keep the
 * event loop (or a test run) alive.
 */
export function createSystemClock(): Clock {
  return {
    now: (): number => Date.now(),

    sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }

        // A holder, because the abort listener must be able to clear a timer
        // that is created after it — and the timer callback must be able to
        // detach that same listener.
        const state: { timer?: ReturnType<typeof setTimeout> } = {};

        const onAbort = (): void => {
          if (state.timer !== undefined) clearTimeout(state.timer);
          reject(abortError());
        };

        state.timer = setTimeout(() => {
          // `{ once: true }` only detaches after the event fires, so the
          // resolve path has to detach by hand or a long-lived signal
          // accumulates one listener per completed wait.
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, normalizeDelay(ms));

        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

/**
 * The process-wide system clock. Composition roots inject this; every other
 * module receives a `Clock` and never imports this module.
 */
export const systemClock: Clock = createSystemClock();
