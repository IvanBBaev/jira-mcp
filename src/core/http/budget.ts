// The call budget: how much clock time a call has left, the error when it runs
// out, and the one sleep a retry takes (D515). Retry waits and slot queueing
// both spend it.

import { WRITE_NOT_APPLIED, errorName } from './failures.js';
import type { CallContext } from './context.js';

/** Clock time left before the call's deadline. */
export function remaining(ctx: CallContext): number {
  return ctx.deadlineAt - ctx.clock.now();
}

export function budgetExceeded(ctx: CallContext): never {
  const { method, route, budgetMs } = ctx;
  const elapsedMs = ctx.clock.now() - ctx.startedAt;
  ctx.logger.emit('budget_exceeded', { budgetMs, elapsedMs });
  throw ctx.fail({
    kind: 'budget_exceeded',
    message: `The call budget was exhausted while calling ${method} ${route} (${String(elapsedMs)} ms of ${String(budgetMs)} ms used by this request).`,
    remediation:
      'Ask for less in one call (fewer fields, a smaller page size, fewer pages), or raise JIRA_CALL_BUDGET_MS.',
  });
}

/** Sleep `ms`, but never past the budget. */
export async function waitFor(ctx: CallContext, ms: number): Promise<void> {
  if (remaining(ctx) <= ms) budgetExceeded(ctx);
  try {
    await ctx.clock.sleep(ms, ctx.spec.signal);
  } catch (error) {
    // A cancel between attempts is the same cancel as one mid-attempt and
    // gets the same typed answer, not a bare AbortError (CC-175).
    if (errorName(error) !== 'AbortError') throw error;
    throw ctx.fail({
      kind: 'transport',
      message: `${ctx.method} ${ctx.route} was cancelled by the caller while waiting to retry.`,
      retryable: false,
      // An unsafe write waits here only after a 429, which applied nothing.
      remediation: ctx.replayable
        ? 'Call again if the result is still needed.'
        : WRITE_NOT_APPLIED,
      cause: error,
    });
  }
}
