// The ONLY module that touches the network (ARCHITECTURE.md §Layering).
//
// `createJiraRequest(options)` builds the `JiraRequestFn` every `api/*` module
// calls. It owns URL assembly, Basic auth, the retry matrix, the per-host
// semaphore, the call budget and status→`JiraError` mapping. It owns no
// process state: no env reads, no settings import, no module singletons, no
// module-level `fetch` capture. Everything that varies — credentials, clock,
// rng, logger, redactor, limits — arrives through `options`, so two clients
// (two profiles, or two tests) can never share a queue or a counter.
//
// Determinism seams (all four enforced in eslint):
//   * time     — injected `Clock`; `Date.now` and bare timers are banned.
//   * jitter   — injected `Rng`; `Math.random` is banned.
//   * timeouts — `clock.sleep(ms, signal)` raced against the fetch promise with
//                an explicit `AbortController`; `AbortSignal.timeout` is banned
//                because it owns a real timer the fake clock cannot drive.
//   * fetch    — read off `globalThis` AT CALL TIME, which is what makes
//                `withFetch` a working seam.
//
// Safety properties this module is responsible for:
//   * default-deny host policy on every request AND on every redirect target,
//     with `redirect: 'manual'` so a 3xx is never followed (CC-27/CC-28);
//   * an unsafe write that fails ambiguously (timeout / transport / 5xx after
//     the request went out) is NEVER replayed — it surfaces
//     `kind: 'ambiguous_write'` (CC-12/CC-13);
//   * 429 is retried for every method, honouring `Retry-After` capped at 60 s
//     (CC-11/CC-14); 5xx and transport failures are retried only for GET or a
//     request explicitly marked `safe: true`;
//   * retry waits and semaphore queueing both count against the call budget.

import { JIRA_ROOT_PATHS, JiraError } from './types.js';
import type {
  Clock,
  HostRef,
  JiraErrorKind,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  JiraResponseHeaders,
  Logger,
  Redactor,
  Rng,
} from './types.js';
import {
  DEFAULT_CALL_BUDGET_MS,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  RETRY_AFTER_JITTER,
  assertHostAllowed,
  backoffMs,
  buildRequestUrl,
  capRetryAfterMs,
  createSemaphorePool,
  hostFromOrigin,
  isRedirectStatus,
  isReplayable,
  jitterMs,
  parseRetryAfterMs,
  shouldRetryStatus,
} from './http-util.js';
import type { SlotRelease } from './http-util.js';

/** Bound on the body snippet carried on `JiraError.detail` (CC-15). */
export const MAX_DETAIL_CHARS = 200;

/** Consecutive host failures before `upstream_degraded` is emitted. */
export const UPSTREAM_DEGRADED_AFTER = 3;

/** Resolved credentials for one profile. */
export interface JiraCredentials {
  readonly host: HostRef;
  readonly email: string;
  readonly apiToken: string;
}

/**
 * Per-call credential lookup. Profile resolution itself belongs to settings +
 * request context (WP-11/WP-24); the client only asks for the answer, which is
 * why a profile switch needs no change here.
 */
export type CredentialResolver = (profile?: string) => JiraCredentials;

/**
 * Everything the client needs, passed explicitly — the shape mirrors the
 * relevant `Settings` fields but is NOT `Settings`: `core/http.ts` never
 * imports settings (CONFIGURATION.md).
 */
export interface JiraHttpOptions {
  /** Static credentials, or a resolver called once per request. */
  readonly credentials: JiraCredentials | CredentialResolver;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly logger: Logger;
  /** Applied to every error message, remediation and body snippet. */
  readonly redactor?: Redactor;
  /** `Settings.allowedHosts` — extra exact hosts or anchored `/^regex$/`. */
  readonly allowedHosts?: readonly string[];
  /** Default per-request timeout; `JiraRequestSpec.timeoutMs` overrides it. */
  readonly requestTimeoutMs?: number;
  /** Default call budget, used when the caller passes no shared `deadlineAt`. */
  readonly callBudgetMs?: number;
  /** Per-host semaphore slots. */
  readonly hostConcurrency?: number;
  /** Retries (not total tries) per request. */
  readonly retryAttempts?: number;
}

type FailureReason = 'timeout' | 'transport' | 'aborted';

interface AttemptFailure {
  readonly reason: FailureReason;
  readonly cause: unknown;
}

interface JiraErrorBody {
  readonly messages: readonly string[];
  readonly detail?: string;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function timeoutError(): Error {
  const err = new Error('The request timed out');
  err.name = 'TimeoutError';
  return err;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function basicAuthHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')}`;
}

function headersOf(response: Response): JiraResponseHeaders {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Minimal projection of Jira's three error shapes (`errorMessages[]`,
 * `errors{}`, `message`) — JIRA-API.md §Error response shapes.
 *
 * Deliberately PRIVATE and deliberately minimal: the full extractor with its
 * field-name mapping is `core/errors.ts` (WP-12). This exists only so the
 * client can populate `JiraError.jiraMessages` without importing upwards, and
 * should collapse into the WP-12 helper once that lands.
 */
function projectErrorBody(text: string): JiraErrorBody {
  if (text.trim() === '') return { messages: [] };

  const parsed = parseJson(text);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    // CC-15: a non-JSON error body (HTML from a proxy, plain text from a WAF)
    // survives as a bounded snippet, never as a full body.
    return { messages: [], detail: text.trim().slice(0, MAX_DETAIL_CHARS) };
  }

  const body = parsed.value as Record<string, unknown>;
  const messages: string[] = [];

  const errorMessages = body['errorMessages'];
  if (Array.isArray(errorMessages)) {
    for (const entry of errorMessages) {
      if (typeof entry === 'string' && entry !== '') messages.push(entry);
    }
  }

  const errors = body['errors'];
  if (typeof errors === 'object' && errors !== null && !Array.isArray(errors)) {
    for (const [field, value] of Object.entries(errors)) {
      if (typeof value === 'string') messages.push(`${field}: ${value}`);
    }
  }

  const message = body['message'];
  if (messages.length === 0 && typeof message === 'string' && message !== '') {
    messages.push(message);
  }

  return { messages };
}

/**
 * A 403 that is really an authentication problem: Jira's CAPTCHA / denied-login
 * responses carry these headers (CC-18). Without the split the model is told to
 * ask for permissions when the real fix is a new token.
 */
function isAuthDenial(headers: JiraResponseHeaders): boolean {
  return (
    'x-authentication-denied-reason' in headers ||
    'x-seraph-loginreason' in headers ||
    'x-failed-login-count' in headers
  );
}

interface StatusMapping {
  readonly kind: JiraErrorKind;
  readonly remediation: string;
}

/**
 * HTTP status → error kind + remediation (ERRORS.md §Status mapping). The
 * remediation is written for the model reading the tool result, so it names the
 * next action, not the failure.
 */
function describeStatus(status: number, headers: JiraResponseHeaders): StatusMapping {
  if (status === 400) {
    return {
      kind: 'validation',
      remediation:
        'Jira rejected the request fields; the messages above name the offending field. Fix the input and retry.',
    };
  }
  if (status === 401 || (status === 403 && isAuthDenial(headers))) {
    return {
      kind: 'auth',
      remediation:
        'Check JIRA_EMAIL and JIRA_API_TOKEN. Atlassian API tokens expire within a year — regenerate the token at id.atlassian.com if it has.',
    };
  }
  if (status === 403) {
    return {
      kind: 'permission',
      remediation:
        'The account is authenticated but lacks the required Jira permission for this project or issue. Ask a Jira admin, or use a different project.',
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      remediation:
        'Jira returns 404 both for "does not exist" and for "you cannot see it" — verify the key/id, then verify the account has Browse Projects on it.',
    };
  }
  if (status === 405 || status === 410) {
    return {
      kind: 'unsupported',
      remediation:
        'This endpoint is not available on this site. Note that the legacy /rest/api/3/search endpoints were removed in 2025 — searches must use /search/jql.',
    };
  }
  if (status === 409) {
    return {
      kind: 'validation',
      remediation:
        'The resource changed underneath this call (concurrent edit, or the issue moved). Re-read it and retry.',
    };
  }
  if (status === 413 || status === 414) {
    return {
      kind: 'validation',
      remediation:
        'The request was too large. Send fewer fields, or a smaller page size.',
    };
  }
  if (status === 429) {
    return {
      kind: 'rate_limited',
      remediation:
        'Jira is rate limiting this site. Retry later, or reduce the call volume.',
    };
  }
  if (status >= 500) {
    return {
      kind: 'transport',
      remediation:
        'Jira returned a server error. This is usually transient — retry shortly.',
    };
  }
  return {
    kind: 'validation',
    remediation: 'Jira rejected the request. See the messages above.',
  };
}

/**
 * Build the `JiraRequestFn` used by the whole api ring.
 *
 * The returned function is safe to call concurrently: per-host queueing is the
 * only shared state, and it lives in this closure.
 */
export function createJiraRequest(options: JiraHttpOptions): JiraRequestFn {
  const { clock, rng, logger } = options;
  const allowedHosts = options.allowedHosts ?? [];
  const defaultTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const defaultBudgetMs = options.callBudgetMs ?? DEFAULT_CALL_BUDGET_MS;
  const defaultRetries = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const concurrency = options.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY;
  const pool = createSemaphorePool(concurrency);
  const credentials = options.credentials;
  const resolveCredentials: CredentialResolver =
    typeof credentials === 'function' ? credentials : () => credentials;

  /** Consecutive transport/5xx failures per host, for `upstream_degraded`. */
  const consecutiveFailures = new Map<string, number>();

  const clean = (text: string): string => options.redactor?.redactString(text) ?? text;

  const fail = (init: {
    kind: JiraErrorKind;
    message: string;
    httpStatus?: number;
    jiraMessages?: readonly string[];
    retryable?: boolean;
    remediation?: string;
    detail?: string;
    cause?: unknown;
  }): JiraError =>
    new JiraError({
      ...init,
      message: clean(init.message),
      remediation: init.remediation === undefined ? undefined : clean(init.remediation),
      detail: init.detail === undefined ? undefined : clean(init.detail),
      jiraMessages: init.jiraMessages?.map((entry) => clean(entry)),
    });

  /**
   * Arm a clock-driven deadline. `signal` fires when `ms` of clock time pass;
   * `cancel()` stops the pending sleep so the fake clock ends a test with no
   * leaked waiters.
   */
  const armDeadline = (
    ms: number,
  ): { signal: AbortSignal; expired: () => boolean; cancel: () => Promise<void> } => {
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
  };

  return async function jiraRequest<T = unknown>(
    spec: JiraRequestSpec,
  ): Promise<JiraResponse<T>> {
    const method = spec.method;
    const root = spec.root ?? 'v3';
    const route = `${JIRA_ROOT_PATHS[root]}${spec.pathTemplate ?? spec.path}`;
    const creds = resolveCredentials(spec.profile);
    const host = hostFromOrigin(creds.host.origin);
    assertHostAllowed(host, allowedHosts, 'request host');

    const url = buildRequestUrl(creds.host, root, spec.path, spec.query);
    const startedAt = clock.now();
    const budgetMs = defaultBudgetMs;
    const deadlineAt = spec.deadlineAt ?? startedAt + budgetMs;
    const maxRetries = Math.max(0, spec.retryAttempts ?? defaultRetries);
    const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;
    const replayable = isReplayable(method, spec.safe);

    const requestHeaders: Record<string, string> = {
      accept: 'application/json',
      authorization: basicAuthHeader(creds.email, creds.apiToken),
    };
    let payload: string | undefined;
    if (spec.body !== undefined) {
      payload = JSON.stringify(spec.body);
      requestHeaders['content-type'] = 'application/json';
    }

    const remaining = (): number => deadlineAt - clock.now();

    const budgetExceeded = (): never => {
      const elapsedMs = clock.now() - startedAt;
      logger.emit('budget_exceeded', { budgetMs, elapsedMs });
      throw fail({
        kind: 'budget_exceeded',
        message: `The call budget was exhausted while calling ${method} ${route} (${String(elapsedMs)} ms of ${String(budgetMs)} ms used by this request).`,
        remediation:
          'Ask for less in one call (fewer fields, a smaller page size, fewer pages), or raise JIRA_CALL_BUDGET_MS.',
      });
    };

    /** Sleep `ms`, but never past the budget. */
    const waitFor = async (ms: number): Promise<void> => {
      if (remaining() <= ms) budgetExceeded();
      await clock.sleep(ms, spec.signal);
    };

    const noteFailure = (): void => {
      const count = (consecutiveFailures.get(host) ?? 0) + 1;
      consecutiveFailures.set(host, count);
      if (count === UPSTREAM_DEGRADED_AFTER) {
        logger.emit('upstream_degraded', { consecutiveFailures: count, host });
      }
    };

    const noteSuccess = (): void => {
      consecutiveFailures.delete(host);
    };

    /** Wait for a semaphore slot; queueing counts against the call budget. */
    const acquireSlot = async (): Promise<SlotRelease> => {
      if (remaining() <= 0) budgetExceeded();
      if (pool.queued(host) === 0 && pool.active(host) < concurrency) {
        return pool.acquire(host);
      }
      const deadline = armDeadline(remaining());
      try {
        return await pool.acquire(host, deadline.signal);
      } catch (error) {
        if (deadline.expired()) return budgetExceeded();
        throw error;
      } finally {
        await deadline.cancel();
      }
    };

    /**
     * One network attempt. `fetch` is read off `globalThis` HERE, not at module
     * load, and the timeout is a clock sleep racing the fetch — both are the
     * seams the wire tests drive.
     */
    const sendOnce = async (attemptTimeoutMs: number): Promise<Response> => {
      const fetchFn = globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        throw fail({
          kind: 'config',
          message: 'This runtime has no global fetch.',
          remediation: 'Run the server on Node 22 or newer.',
        });
      }
      if (spec.signal?.aborted) throw abortError();

      const fetchAbort = new AbortController();
      const stopTimer = new AbortController();
      let timedOut = false;

      const onCallerAbort = (): void => {
        fetchAbort.abort();
      };
      spec.signal?.addEventListener('abort', onCallerAbort, { once: true });

      // Rejects as soon as the controller aborts, whoever aborted it — so a
      // fetch implementation that ignores `signal` still cannot hang the call.
      const aborted = new Promise<never>((_resolve, reject) => {
        fetchAbort.signal.addEventListener(
          'abort',
          () => {
            reject(timedOut ? timeoutError() : abortError());
          },
          { once: true },
        );
      });

      const timer = clock.sleep(attemptTimeoutMs, stopTimer.signal).then(
        () => {
          timedOut = true;
          fetchAbort.abort();
        },
        () => {
          // Timer cancelled because the response arrived first.
        },
      );

      try {
        return await Promise.race([
          fetchFn(url, {
            method,
            headers: requestHeaders,
            body: payload,
            signal: fetchAbort.signal,
            // Never follow a redirect: the target is attacker-influenced data
            // and following it would leak the Authorization header off-host.
            redirect: 'manual',
          }),
          aborted,
        ]);
      } finally {
        spec.signal?.removeEventListener('abort', onCallerAbort);
        stopTimer.abort();
        await timer;
      }
    };

    const ambiguousWrite = (reason: string, cause?: unknown): never => {
      logger.emit('ambiguous_write', { method, pathTemplate: route });
      throw fail({
        kind: 'ambiguous_write',
        message: `${method} ${route} ${reason}, so it is unknown whether Jira applied the change. It was NOT retried.`,
        retryable: false,
        remediation:
          'Read the issue back (or search for it) to find out whether the change landed before sending it again — a blind retry can duplicate the write.',
        cause,
      });
    };

    logger.emit('http_request', { method, pathTemplate: route });

    for (let attempt = 1; ; attempt += 1) {
      if (remaining() <= 0) budgetExceeded();

      const attemptTimeoutMs = Math.min(timeoutMs, remaining());
      const release = await acquireSlot();
      const attemptStartedAt = clock.now();
      let response: Response | undefined;
      let failure: AttemptFailure | undefined;

      try {
        response = await sendOnce(attemptTimeoutMs);
      } catch (error) {
        if (error instanceof JiraError) throw error;
        const name = errorName(error);
        if (name === 'TimeoutError') {
          failure = { reason: 'timeout', cause: error };
        } else if (name === 'AbortError') {
          failure = { reason: 'aborted', cause: error };
        } else {
          failure = { reason: 'transport', cause: error };
        }
      } finally {
        release();
      }

      if (failure) {
        if (failure.reason === 'aborted') {
          // The caller cancelled; the outcome of an unsafe write is still
          // unknown, but this is not a failure we retry or dress up.
          throw fail({
            kind: 'transport',
            message: `${method} ${route} was cancelled by the caller.`,
            retryable: false,
            remediation: replayable
              ? 'Call again if the result is still needed.'
              : 'The write may or may not have been applied — verify the current state before sending it again.',
            cause: failure.cause,
          });
        }

        noteFailure();
        const canRetry = replayable && attempt <= maxRetries;
        if (canRetry) {
          const delayMs = backoffMs(attempt, rng);
          logger.emit('http_retry', {
            method,
            pathTemplate: route,
            reason: 'transport',
            attempt,
            delayMs,
          });
          await waitFor(delayMs);
          continue;
        }
        if (!replayable) {
          ambiguousWrite(
            failure.reason === 'timeout'
              ? 'timed out after the request was sent'
              : 'failed in transit',
            failure.cause,
          );
        }
        throw fail({
          kind: failure.reason === 'timeout' ? 'timeout' : 'transport',
          message:
            failure.reason === 'timeout'
              ? `${method} ${route} timed out after ${String(attemptTimeoutMs)} ms.`
              : `Could not reach Jira at ${creds.host.origin} for ${method} ${route}.`,
          remediation:
            failure.reason === 'timeout'
              ? 'Ask for less in one request, or raise JIRA_REQUEST_TIMEOUT_MS.'
              : 'Check network connectivity and any proxy configuration, then retry.',
          cause: failure.cause,
        });
      }

      if (!response) {
        // Unreachable: `sendOnce` either returns a Response or throws.
        throw fail({
          kind: 'unexpected_shape',
          message: `${method} ${route} produced no response.`,
        });
      }

      const status = response.status;
      const headers = headersOf(response);
      logger.emit('http_response', {
        method,
        pathTemplate: route,
        status,
        durationMs: clock.now() - attemptStartedAt,
        attempt,
      });

      if (isRedirectStatus(status)) {
        await response.text().catch(() => '');
        const location = headers['location'] ?? '';
        let targetHost = '';
        try {
          targetHost = new URL(location, url).host;
        } catch {
          targetHost = '';
        }
        noteSuccess();
        throw fail({
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

      if (status === 429) {
        const serverMs = parseRetryAfterMs(headers['retry-after'], clock.now());
        const cappedMs = serverMs === undefined ? undefined : capRetryAfterMs(serverMs);
        const waitMs =
          cappedMs === undefined
            ? backoffMs(attempt, rng)
            : jitterMs(cappedMs, RETRY_AFTER_JITTER, rng);
        logger.emit('rate_limited', {
          retryAfterS: serverMs === undefined ? undefined : Math.round(serverMs / 1000),
          waitS: Math.round(waitMs / 1000),
        });
        await response.text().catch(() => '');

        if (attempt <= maxRetries) {
          logger.emit('http_retry', {
            method,
            pathTemplate: route,
            reason: '429',
            attempt,
            delayMs: waitMs,
          });
          await waitFor(waitMs);
          continue;
        }
        throw fail({
          kind: 'rate_limited',
          message: `Jira rate limited ${method} ${route} and the retry budget is spent.`,
          httpStatus: 429,
          remediation:
            'Wait before calling again, and reduce how many issues this call asks for.',
        });
      }

      if (status >= 500) {
        noteFailure();
        if (shouldRetryStatus(status, method, spec.safe) && attempt <= maxRetries) {
          await response.text().catch(() => '');
          const delayMs = backoffMs(attempt, rng);
          logger.emit('http_retry', {
            method,
            pathTemplate: route,
            reason: '5xx',
            attempt,
            delayMs,
          });
          await waitFor(delayMs);
          continue;
        }
        if (!replayable) {
          await response.text().catch(() => '');
          ambiguousWrite(`failed with HTTP ${String(status)}`);
        }
      } else {
        noteSuccess();
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const body = projectErrorBody(text);
        const mapping = describeStatus(status, headers);
        if (mapping.kind === 'auth') {
          logger.emit('auth_failure', { status, pathTemplate: route });
        }
        throw fail({
          kind: mapping.kind,
          message:
            body.messages.length > 0
              ? `Jira rejected ${method} ${route} with HTTP ${String(status)}: ${body.messages.join('; ')}`
              : `Jira rejected ${method} ${route} with HTTP ${String(status)}.`,
          httpStatus: status,
          jiraMessages: body.messages,
          remediation: mapping.remediation,
          detail: body.detail,
        });
      }

      const text = await response.text().catch(() => '');
      if (status === 204 || status === 205 || text.trim() === '') {
        return { status, headers, data: undefined as T };
      }
      const parsed = parseJson(text);
      if (!parsed.ok) {
        throw fail({
          kind: 'unexpected_shape',
          message: `Jira answered ${method} ${route} with HTTP ${String(status)} but the body was not JSON.`,
          httpStatus: status,
          detail: text.trim().slice(0, MAX_DETAIL_CHARS),
          remediation:
            'A proxy or login page is probably answering instead of Jira. Check JIRA_SITE and any corporate proxy.',
        });
      }
      return { status, headers, data: parsed.value as T };
    }
  };
}
