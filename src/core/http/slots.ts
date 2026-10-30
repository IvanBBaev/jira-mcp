// The per-host semaphore slot one attempt holds, body included (D515).

import type { SlotRelease } from '../http-util.js';
import { budgetExceeded, remaining } from './budget.js';
import type { CallContext } from './context.js';
import { WRITE_NOT_APPLIED } from './failures.js';
import { armDeadline } from './guard.js';

/** Wait for a semaphore slot; queueing counts against the call budget. */
export async function acquireSlot(ctx: CallContext): Promise<SlotRelease> {
  const { pool, host, spec } = ctx;
  // Re-read the budget rather than trust the loop's check: the two reads are
  // one synchronous run apart, so only a REAL clock can see them differ (and
  // then by a millisecond). Kept because it is the only guard on this side
  // of the seam — no test can force the window on the injected clock.
  if (remaining(ctx) <= 0) budgetExceeded(ctx);
  if (pool.queued(host) === 0 && pool.active(host) < ctx.concurrency) {
    return pool.acquire(host);
  }
  const deadline = armDeadline(ctx.clock, remaining(ctx));
  // The caller's cancel reaches the queue too: a cancelled call must not
  // hold its place ahead of live ones until the budget runs out (CC-204).
  const signal =
    spec.signal === undefined
      ? deadline.signal
      : AbortSignal.any([deadline.signal, spec.signal]);
  try {
    return await pool.acquire(host, signal);
  } catch (error) {
    if (deadline.expired()) return budgetExceeded(ctx);
    if (spec.signal?.aborted === true) {
      throw ctx.fail({
        kind: 'transport',
        message: `${ctx.method} ${ctx.route} was cancelled by the caller while waiting for a connection slot.`,
        retryable: false,
        remediation: ctx.replayable
          ? 'Call again if the result is still needed.'
          : WRITE_NOT_APPLIED,
        cause: error,
      });
    }
    // Unreachable today: the pool rejects a queued waiter only through the
    // signal it was handed, which is the deadline or the caller's. Kept as a
    // rethrow rather than folded into the branches above, because reporting
    // a future rejection as either of them would be a lie.
    throw error;
  } finally {
    await deadline.cancel();
  }
}
