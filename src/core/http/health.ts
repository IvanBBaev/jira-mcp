// Host health: consecutive transport/5xx failures, and the `upstream_degraded`
// event at the threshold (D515).

import type { CallContext } from './context.js';

/** Consecutive host failures before `upstream_degraded` is emitted. */
export const UPSTREAM_DEGRADED_AFTER = 3;

export function noteFailure(ctx: CallContext): void {
  const { consecutiveFailures, host } = ctx;
  const count = (consecutiveFailures.get(host) ?? 0) + 1;
  consecutiveFailures.set(host, count);
  if (count === UPSTREAM_DEGRADED_AFTER) {
    ctx.logger.emit('upstream_degraded', { consecutiveFailures: count, host });
  }
}

export function noteSuccess(ctx: CallContext): void {
  ctx.consecutiveFailures.delete(ctx.host);
}
