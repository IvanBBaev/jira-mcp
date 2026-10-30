// One attempt on the wire: every `fetch` it makes and the body it reads, all
// under one attempt guard (D515). `fetch` is read off `globalThis` HERE, per
// hop, which is the seam the wire tests drive.

import { MAX_TEXT_BODY_BYTES, isRedirectStatus } from '../http-util.js';
import { readBytesCapped, readTextCapped, readTextOrEmpty } from './body.js';
import type { AttemptResult, CallContext, HopTarget } from './context.js';
import { isSuccessStatus } from './decide.js';
import { abortError, requireFetch } from './failures.js';
import type { AttemptGuard } from './guard.js';
import { mediaHop } from './media.js';
import { headersOf } from './status.js';

/**
 * One network hop. `fetch` is read off `globalThis` HERE, not at module
 * load, and the timeout comes from the attempt guard — both are the seams
 * the wire tests drive.
 */
async function sendOnce(
  ctx: CallContext,
  guard: AttemptGuard,
  target: HopTarget,
): Promise<Response> {
  const fetchFn = requireFetch(ctx.fail);
  if (ctx.spec.signal?.aborted) {
    ctx.inFlight.cancelledUnsent = true;
    throw abortError();
  }

  return await guard.guard(
    fetchFn(target.url, {
      method: ctx.method,
      headers: target.headers,
      body: target.body,
      signal: guard.signal,
      // The platform never follows a redirect for us: the target is
      // attacker-influenced data, and an automatic follow would leak the
      // Authorization header off-host. The one hop this module does make
      // (see `sendAttempt`) is hand-built and anonymous.
      redirect: 'manual',
    }),
  );
}

/**
 * Every `fetch` of one attempt — which is one, except for the
 * attachment-download 303. That hop runs INSIDE the attempt, so it still
 * holds the host semaphore slot, shares the one attempt timeout, and does
 * not spend a retry.
 */
async function sendAttempt(
  ctx: CallContext,
  guard: AttemptGuard,
  attempt: number,
  attemptStartedAt: number,
): Promise<Response> {
  const { method, route } = ctx;
  const first = await sendOnce(ctx, guard, {
    url: ctx.url,
    headers: ctx.headers,
    body: ctx.payload,
  });
  // Only a binary GET may be redirected anywhere; for everything else a 3xx
  // stays what it has always been — a refusal, raised by the main loop.
  // The Data Center attachment servlet (`secure`, D117) never takes the
  // hop: there a redirect is the login page, not a signed media URL, and
  // following it anonymously would write an HTML page as the file.
  if (
    !ctx.wantsBinary ||
    method !== 'GET' ||
    ctx.root === 'secure' ||
    !isRedirectStatus(first.status)
  ) {
    return first;
  }

  const location = first.headers.get('location') ?? '';
  await readTextOrEmpty(guard, first);
  // The hop gets its own http_response event so the redirect is visible in
  // the log; the media URL itself is a bearer credential and never logged.
  ctx.logger.emit('http_response', {
    method,
    pathTemplate: route,
    status: first.status,
    durationMs: ctx.clock.now() - attemptStartedAt,
    attempt,
  });
  return await sendOnce(ctx, guard, mediaHop(ctx, location, first.status));
}

/**
 * One attempt as the retry loop sees it: from the first byte sent to the
 * last byte read. Consuming the body HERE is what puts it under the attempt
 * timeout, under the call budget and under the host semaphore — and what
 * turns a body that never arrives into a failed attempt rather than a
 * successful call that quietly reports no data.
 */
export async function runAttempt(
  ctx: CallContext,
  guard: AttemptGuard,
  attempt: number,
  attemptStartedAt: number,
): Promise<AttemptResult> {
  const { method, route, fail } = ctx;
  ctx.inFlight.answeredStatus = undefined;
  ctx.inFlight.cancelledUnsent = false;
  const response = await sendAttempt(ctx, guard, attempt, attemptStartedAt);
  const status = response.status;
  ctx.inFlight.answeredStatus = status;
  // Emitted on the headers, before the body: a response that arrived and
  // then stalled must still show up in the log as the status it was.
  ctx.logger.emit('http_response', {
    method,
    pathTemplate: route,
    status,
    durationMs: ctx.clock.now() - attemptStartedAt,
    attempt,
  });

  const headers = headersOf(response);
  if (!isSuccessStatus(status)) {
    return { status, headers, text: await readTextOrEmpty(guard, response) };
  }
  if (ctx.wantsBinary) {
    // The body is bytes by contract, so nothing here parses or inspects it
    // — the only thing that can still go wrong is size, and
    // `readBytesCapped` owns that.
    return {
      status,
      headers,
      text: '',
      bytes: await readBytesCapped(ctx, guard, response),
    };
  }
  const read = await readTextCapped(guard, response);
  if (read.kind === 'text') return { status, headers, text: read.text };
  // Over MAX_TEXT_BODY_BYTES (CC-384). A write Jira said yes to was
  // applied; only its reply is refused, so it is reported the CC-205 way.
  if (!ctx.replayable) {
    ctx.logger.emit('ambiguous_write', { method, pathTemplate: route });
    throw fail({
      kind: 'ambiguous_write',
      message: `${method} ${route} was applied (Jira answered ${String(status)}), but its response body is over the ${String(MAX_TEXT_BODY_BYTES)}-byte response limit, so the result it carried was not read. It was NOT retried.`,
      httpStatus: status,
      retryable: false,
      remediation:
        'Do not send it again. Read the issue back (or search for it) to get what the reply would have carried, such as a created key.',
    });
  }
  throw fail({
    // The same kind the attachment cap uses: no retry can change it.
    kind: 'validation',
    message: `The response to ${method} ${route} is over the ${String(MAX_TEXT_BODY_BYTES)}-byte response limit (at least ${String(read.bytes)} bytes); it was not read.`,
    httpStatus: status,
    retryable: false,
    remediation:
      'Ask for less in one request: fewer fields, a smaller maxResults, no expand. The limit is compiled in and has no environment override.',
  });
}
