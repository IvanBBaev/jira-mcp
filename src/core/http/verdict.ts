// The verdict on a finished attempt, in words: the 429 announcement and its
// wait, and the error (or the value) each `decideNext` outcome ends in (D515).
// `decide.ts` picks the tag; this module owns what the tag says.

import {
  RETRY_AFTER_JITTER,
  backoffMs,
  capRetryAfterMs,
  jitterMs,
  parseRetryAfterMs,
} from '../http-util.js';
import type { RateLimitInfo } from '../http-util.js';
import { boundedJiraMessages } from '../errors.js';
import type { JiraError, JiraResponse, JiraResponseHeaders } from '../types.js';
import type { AttemptFailure, AttemptResult, CallContext } from './context.js';
import type { FailTag } from './decide.js';
import { WRITE_NOT_APPLIED, WRITE_OUTCOME_UNKNOWN } from './failures.js';
import { describeStatus, parseJson, projectErrorBody } from './status.js';

export function ambiguousWrite(ctx: CallContext, reason: string, cause?: unknown): never {
  const { method, route } = ctx;
  ctx.logger.emit('ambiguous_write', { method, pathTemplate: route });
  throw ctx.fail({
    kind: 'ambiguous_write',
    message: `${method} ${route} ${reason}, so it is unknown whether Jira applied the change. It was NOT retried.`,
    retryable: false,
    remediation:
      'Read the issue back (or search for it) to find out whether the change landed before sending it again — a blind retry can duplicate the write.',
    cause,
  });
}

/**
 * Log a 429 and work out how long a retry would wait. Emitted whether or
 * not the loop then retries, because the operator asks about throttling,
 * not about retries. A spent quota waits for nothing (D127).
 */
export function announceRateLimit(
  ctx: CallContext,
  headers: JiraResponseHeaders,
  limit: RateLimitInfo,
  attempt: number,
): number {
  const { clock, logger, rng } = ctx;
  const serverMs = parseRetryAfterMs(headers['retry-after'], clock.now());
  const retryAfterS = serverMs === undefined ? undefined : Math.round(serverMs / 1000);
  if (limit.quota) {
    logger.emit('rate_limited', { retryAfterS, waitS: 0, reason: limit.reason });
    return 0;
  }
  const cappedMs = serverMs === undefined ? undefined : capRetryAfterMs(serverMs);
  // A zero (or past-date) Retry-After would retry back to back with no
  // jitter, so it earns the same backoff as no header at all (CC-203).
  const waitMs =
    cappedMs === undefined || cappedMs === 0
      ? backoffMs(attempt, rng)
      : jitterMs(cappedMs, RETRY_AFTER_JITTER, rng);
  logger.emit('rate_limited', {
    retryAfterS,
    waitS: Math.round(waitMs / 1000),
    reason: limit.reason,
  });
  return waitMs;
}

/** The error for a lost response (no status, or a body lost after one). */
export function lostFailure(
  ctx: CallContext,
  tag: FailTag,
  failure: AttemptFailure,
  landed: number | undefined,
  attemptTimeoutMs: number,
): JiraError {
  const { method, route, fail, logger } = ctx;
  if (tag === 'cancelled') {
    // The caller cancelled; the outcome of an unsafe write is still
    // unknown, but this is not a failure we retry or dress up.
    return fail({
      kind: 'transport',
      message: `${method} ${route} was cancelled by the caller.`,
      retryable: false,
      remediation: ctx.replayable
        ? 'Call again if the result is still needed.'
        : ctx.inFlight.cancelledUnsent
          ? WRITE_NOT_APPLIED
          : WRITE_OUTCOME_UNKNOWN,
      cause: failure.cause,
    });
  }
  if (tag === 'applied_reply_lost') {
    // Jira already said yes; only the reply is lost. Calling it ambiguous
    // invites a resend, and a resend of a create is a duplicate (CC-205) —
    // whether the body then timed out, failed, or the caller cancelled it
    // (CC-416).
    logger.emit('ambiguous_write', { method, pathTemplate: route });
    const lost =
      failure.reason === 'timeout'
        ? 'timed out'
        : failure.reason === 'aborted'
          ? 'was cancelled by the caller'
          : 'failed in transit';
    return fail({
      kind: 'ambiguous_write',
      message: `${method} ${route} was applied (Jira answered ${String(landed)}), but its response body ${lost}, so the result it carried is unknown. It was NOT retried.`,
      httpStatus: landed,
      retryable: false,
      remediation:
        'Do not send it again. Read the issue back (or search for it) to get what the reply would have carried, such as a created key.',
      cause: failure.cause,
    });
  }
  if (tag === 'ambiguous_write') {
    return ambiguousWrite(
      ctx,
      failure.reason === 'timeout'
        ? 'timed out after the request was sent'
        : 'failed in transit',
      failure.cause,
    );
  }
  return fail({
    kind: tag === 'timeout' ? 'timeout' : 'transport',
    message:
      tag === 'timeout'
        ? `${method} ${route} timed out after ${String(attemptTimeoutMs)} ms.`
        : `Could not reach Jira at ${ctx.creds.host.origin} for ${method} ${route}.`,
    remediation:
      tag === 'timeout'
        ? 'Ask for less in one request, or raise JIRA_REQUEST_TIMEOUT_MS.'
        : 'Check network connectivity and any proxy configuration, then retry.',
    cause: failure.cause,
  });
}

/** The error for an answered attempt the policy refuses. */
export function answeredFailure(
  ctx: CallContext,
  tag: FailTag,
  result: AttemptResult,
  limit: RateLimitInfo,
): JiraError {
  const { method, route, url, fail, logger } = ctx;
  const { status, headers } = result;
  if (tag === 'redirect') {
    const location = headers['location'] ?? '';
    // No initializer: both arms of the try assign, so the compiler proves
    // it is set. A dead `''` here is what eslint 10's `init-declarations`
    // family flags, and it hides which branch actually decides the value.
    let targetHost: string;
    try {
      targetHost = new URL(location, url).host;
    } catch {
      targetHost = '';
    }
    return fail({
      kind: 'config',
      message:
        targetHost === '' || targetHost === new URL(url).host
          ? `Jira answered ${method} ${route} with a ${String(status)} redirect; redirects are never followed.`
          : `Jira answered ${method} ${route} with a ${String(status)} redirect to "${targetHost}"; off-host redirects are never followed.`,
      httpStatus: status,
      retryable: false,
      remediation:
        'Check JIRA_SITE: a redirect usually means the site name is wrong, or a proxy is intercepting the call. The Authorization header is never sent to a redirect target.',
    });
  }
  if (tag === 'quota') {
    // An hourly points quota is spent: a 60 s wait cannot help, and every
    // retry would be refused the same way while eating the call budget,
    // so this one fails at once with the instant it lifts (D127).
    const resetAt =
      limit.resetAtMs === undefined ? '' : new Date(limit.resetAtMs).toISOString();
    return fail({
      kind: 'rate_limited',
      message: `Jira refused ${method} ${route}: the ${String(limit.reason)} rate-limit quota is spent${resetAt === '' ? '' : ` until ${resetAt}`}.`,
      httpStatus: 429,
      remediation:
        resetAt === ''
          ? 'Do not retry now: the quota is hourly. Tell the user, and try again later with fewer calls.'
          : `Do not retry before ${resetAt}. Tell the user; when the quota lifts, make fewer, narrower calls.`,
    });
  }
  if (tag === 'rate_limited') {
    return fail({
      kind: 'rate_limited',
      message: `Jira rate limited ${method} ${route}${limit.reason === undefined ? '' : ` (${limit.reason})`} and the retry budget is spent.`,
      httpStatus: 429,
      remediation:
        limit.reason === 'jira-per-issue-on-write'
          ? 'This issue takes writes too fast: wait a few seconds before the next write to it, and batch field changes into one update.'
          : 'Wait before calling again, and reduce how many issues this call asks for.',
    });
  }
  if (tag === 'ambiguous_write') {
    return ambiguousWrite(ctx, `failed with HTTP ${String(status)}`);
  }
  const body = projectErrorBody(result.text);
  const mapping = describeStatus(status, headers, ctx.creds.kind);
  if (mapping.kind === 'auth') {
    logger.emit('auth_failure', { status, pathTemplate: route });
  }
  return fail({
    kind: mapping.kind,
    message:
      body.messages.length > 0
        ? `Jira rejected ${method} ${route} with HTTP ${String(status)}: ${boundedJiraMessages(body.messages, ctx.redactor)}`
        : `Jira rejected ${method} ${route} with HTTP ${String(status)}.`,
    httpStatus: status,
    jiraMessages: body.messages,
    remediation: mapping.remediation,
    detail: body.detail,
  });
}

/** A 2xx body, as the caller's `data`. */
export function successValue<T>(
  ctx: CallContext,
  result: AttemptResult,
): JiraResponse<T> {
  const { method, route, fail, logger } = ctx;
  const { status, headers } = result;
  if (ctx.wantsBinary) return { status, headers, data: result.bytes as T };

  const text = result.text;
  if (status === 204 || status === 205 || text.trim() === '') {
    return { status, headers, data: undefined as T };
  }
  const parsed = parseJson(text);
  if (!parsed.ok && !ctx.replayable) {
    // A 2xx on an unsafe write may mean Jira applied it and a proxy mangled
    // the reply, or that a login page answered and nothing landed. Either
    // way "a proxy is answering" invites a resend, and a resend of a create
    // is a duplicate — so it is reported the CC-205 way (CC-482).
    logger.emit('ambiguous_write', { method, pathTemplate: route });
    throw fail({
      kind: 'ambiguous_write',
      message: `${method} ${route} was answered with HTTP ${String(status)}, but the body was not JSON, so it is unknown whether Jira applied the change. It was NOT retried.`,
      httpStatus: status,
      detail: text.trim(),
      retryable: false,
      remediation:
        'Read the issue back (or search for it) to find out whether the change landed before sending it again. If a proxy or login page is answering instead of Jira, check JIRA_SITE and any corporate proxy.',
    });
  }
  if (!parsed.ok) {
    throw fail({
      kind: 'unexpected_shape',
      message: `Jira answered ${method} ${route} with HTTP ${String(status)} but the body was not JSON.`,
      httpStatus: status,
      detail: text.trim(),
      remediation:
        'A proxy or login page is probably answering instead of Jira. Check JIRA_SITE and any corporate proxy.',
    });
  }
  return { status, headers, data: parsed.value as T };
}
