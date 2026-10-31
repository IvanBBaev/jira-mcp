// The quota hold (D534): after Jira refuses a call because an hourly points
// quota is spent (D127), every later call to the same host fails here, before
// the wire, until the instant Jira said the quota lifts.
//
// This is not the circuit breaker D13 rules out. It never opens on the host's
// health, only on Jira's own statement that the quota is spent; it closes at
// the instant Jira named, not after a probe; and the error it raises is the
// same `rate_limited` answer the wire would have given, reset instant
// included. Sending the call anyway would only collect another 429 and count
// toward Atlassian's abuse heuristics.

import { MAX_QUOTA_HOLD_MS } from '../http-util.js';
import type { RateLimitInfo, RateLimitReason } from '../http-util.js';
import type { CallContext } from './context.js';

/** One host's hold: no call goes out before `untilMs`. */
export interface QuotaHold {
  readonly untilMs: number;
  readonly reason: RateLimitReason;
}

/**
 * Open (or extend) the host's hold after a quota 429. A quota 429 with no
 * reset instant opens nothing: there is no honest time to hold until. The
 * hold never runs past {@link MAX_QUOTA_HOLD_MS}, one quota window, so a
 * broken or hostile reset header cannot shut the server out for longer.
 */
export function openQuotaHold(ctx: CallContext, limit: RateLimitInfo): void {
  if (!limit.quota || limit.reason === undefined || limit.resetAtMs === undefined) {
    return;
  }
  const now = ctx.clock.now();
  const untilMs = Math.min(limit.resetAtMs, now + MAX_QUOTA_HOLD_MS);
  if (untilMs <= now) return;
  const held = ctx.quotaHolds.get(ctx.host);
  if (held !== undefined && held.untilMs >= untilMs) return;
  ctx.quotaHolds.set(ctx.host, { untilMs, reason: limit.reason });
}

/**
 * Refuse the call when its host is held; drop a hold whose instant has come.
 * The call closes the hold at exactly `untilMs`: that request is sent.
 */
export function assertNotQuotaHeld(ctx: CallContext): void {
  const held = ctx.quotaHolds.get(ctx.host);
  if (held === undefined) return;
  const now = ctx.clock.now();
  if (now >= held.untilMs) {
    ctx.quotaHolds.delete(ctx.host);
    return;
  }
  const resetAt = new Date(held.untilMs).toISOString();
  ctx.logger.emit('rate_limited', {
    retryAfterS: Math.ceil((held.untilMs - now) / 1000),
    waitS: 0,
    reason: held.reason,
  });
  throw ctx.fail({
    kind: 'rate_limited',
    message: `${ctx.method} ${ctx.route} was not sent: the ${held.reason} rate-limit quota is spent until ${resetAt}. Jira refused an earlier call with HTTP 429.`,
    remediation: `Do not retry before ${resetAt}. Tell the user; when the quota lifts, make fewer, narrower calls.`,
  });
}
