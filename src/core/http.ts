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
// Counters (D12) are one more injected seam: an optional `Telemetry` counts
// requests, retries, rate-limit waits and errors by kind. It is the only module
// that can count them honestly, because it is the only one on the wire; absent,
// nothing is counted and nothing else changes.
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
//   * retry waits and semaphore queueing both count against the call budget,
//     and an attempt is not over until its BODY is — the timeout, the budget and
//     the host slot all cover the body read, because "the headers arrived" is
//     not the same as "the call finished" (a stalled attachment transfer used to
//     escape all three);
//   * attachment transfers (WP-70) are bounded by `MAX_ATTACHMENT_BYTES` in both
//     directions, and the ONE redirect this module ever follows — the 303 from
//     `GET /attachment/content/{id}` to Atlassian's media host — is followed
//     ANONYMOUSLY, once, https-only, and only for a binary GET.

import { JIRA_ROOT_PATHS, JiraError } from './types.js';
import type {
  Clock,
  HostRef,
  JiraErrorKind,
  JiraMultipartFile,
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
  MAX_ATTACHMENT_BYTES,
  RETRY_AFTER_JITTER,
  assertHostAllowed,
  backoffMs,
  buildRequestUrl,
  capRetryAfterMs,
  createSemaphorePool,
  hostFromOrigin,
  isBlockedHost,
  isRedirectStatus,
  isReplayable,
  jitterMs,
  parseRetryAfterMs,
  shouldRetryStatus,
} from './http-util.js';
import type { SlotRelease } from './http-util.js';
import { REMEDIATION, kindForStatus } from './errors.js';
import { UNKNOWN_ERROR_KIND } from './telemetry.js';
import type { Telemetry } from './telemetry.js';

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
  /**
   * In-process counters (D12). Absent means "count nothing": the client works
   * exactly the same, so a test or a second client needs no counter set.
   */
  readonly telemetry?: Telemetry;
}

type FailureReason = 'timeout' | 'transport' | 'aborted';

interface AttemptFailure {
  readonly reason: FailureReason;
  readonly cause: unknown;
}

/**
 * Where one `fetch` goes and what it carries. Normally there is exactly one per
 * attempt (the Jira route); a binary GET that Jira answers with a 303 produces
 * a second, deliberately credential-free one for the media host.
 */
interface HopTarget {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string | FormData;
}

interface JiraErrorBody {
  readonly messages: readonly string[];
  readonly detail?: string;
}

/**
 * The abort envelope of ONE attempt: the signal every `fetch` of that attempt
 * carries, plus a race that ends any promise the attempt is waiting on.
 *
 * It is armed before the first byte is sent and disarmed only after the last
 * byte is read, so the attempt timeout (and through it the call budget) covers
 * the body, not just the headers.
 */
interface AttemptGuard {
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
 * One attempt's response, body already consumed. The body is materialised
 * inside the attempt on purpose: after this object exists there is nothing left
 * to await, so the retry decisions below cannot leak a half-read stream past
 * the timeout that was supposed to bound it.
 */
interface AttemptResult {
  readonly status: number;
  readonly headers: JiraResponseHeaders;
  /** The body as text; empty for a binary read and for a drained one. */
  readonly text: string;
  /** Set only by a successful binary read. */
  readonly bytes?: Uint8Array;
}

/** `Response.ok`, decided from a status that has outlived its `Response`. */
function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
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

interface StatusMapping {
  readonly kind: JiraErrorKind;
  readonly remediation: string;
}

/**
 * HTTP status → error kind + remediation. The kind comes from the single
 * status table in `errors.ts` (`kindForStatus`), which owns the CC-18 rule:
 * a 403 carrying Jira's login-denied headers is `auth`, but an ordinary
 * permission 403 with `X-Seraph-LoginReason: OK` is not. The remediation is
 * written for the model reading the tool result, so it names the next action,
 * not the failure; statuses without a bespoke text fall back to the kind's
 * `REMEDIATION` entry.
 */
function describeStatus(status: number, headers: JiraResponseHeaders): StatusMapping {
  const kind = kindForStatus(status, { headers });
  if (kind === 'auth') {
    return {
      kind,
      remediation:
        'Check JIRA_EMAIL and JIRA_API_TOKEN. Atlassian API tokens expire within a year — regenerate the token at id.atlassian.com if it has.',
    };
  }
  if (status === 400) {
    return {
      kind,
      remediation:
        'Jira rejected the request fields; the messages above name the offending field. Fix the input and retry.',
    };
  }
  if (status === 403) {
    return {
      kind,
      remediation:
        'The account is authenticated but lacks the required Jira permission for this project or issue. Ask a Jira admin, or use a different project.',
    };
  }
  if (status === 404) {
    return {
      kind,
      remediation:
        'Jira returns 404 both for "does not exist" and for "you cannot see it" — verify the key/id, then verify the account has Browse Projects on it.',
    };
  }
  if (status === 405 || status === 410) {
    return {
      kind,
      remediation:
        'This endpoint is not available on this site. Note that the legacy /rest/api/3/search endpoints were removed in 2025 — searches must use /search/jql.',
    };
  }
  if (status === 409) {
    return {
      kind,
      remediation:
        'The resource changed underneath this call (concurrent edit, or the issue moved). Re-read it and retry.',
    };
  }
  if (status === 413 || status === 414) {
    return {
      kind,
      remediation:
        'The request was too large. Send fewer fields, or a smaller page size.',
    };
  }
  if (status === 429) {
    return {
      kind,
      remediation:
        'Jira is rate limiting this site. Retry later, or reduce the call volume.',
    };
  }
  if (status >= 500 && kind === 'transport') {
    return {
      kind,
      remediation:
        'Jira returned a server error. This is usually transient — retry shortly.',
    };
  }
  return { kind, remediation: REMEDIATION[kind] };
}

/**
 * Build the `JiraRequestFn` used by the whole api ring.
 *
 * The returned function is safe to call concurrently: per-host queueing is the
 * only shared state, and it lives in this closure.
 */
export function createJiraRequest(options: JiraHttpOptions): JiraRequestFn {
  const { clock, rng, logger } = options;
  const telemetry = options.telemetry;
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

  const jiraRequest = async function jiraRequest<T = unknown>(
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

    const wantsBinary = spec.accept === 'binary';

    /** Breach of {@link MAX_ATTACHMENT_BYTES}, in either direction. */
    const tooLarge = (bytes: number, direction: 'download' | 'upload'): JiraError =>
      fail({
        // Same kind an HTTP 413 maps to: the caller asked for something the
        // wire will not carry, and no retry can change that.
        kind: 'validation',
        message: `The ${direction} for ${method} ${route} is over the ${String(MAX_ATTACHMENT_BYTES)}-byte attachment limit (${String(bytes)} bytes).`,
        retryable: false,
        remediation:
          'This limit is compiled in and has no environment override. Use a smaller file, or move the attachment outside this server.',
      });

    /**
     * Read a whole body as bytes, counting AS IT ARRIVES and aborting the
     * transfer at the byte that crosses the cap — buffering first and checking
     * afterwards would defeat the point of having a cap.
     *
     * Every read is raced against the attempt guard: a source that drips one
     * chunk an hour is exactly the transfer the timeout exists for, and it is
     * indistinguishable from a healthy one until the clock says otherwise.
     */
    const readCapped = async (
      guard: AttemptGuard,
      response: Response,
    ): Promise<Uint8Array> => {
      const body = response.body;
      if (body === null) {
        // No stream to meter (an empty body, or a fetch stub that returns
        // none): the buffer is already in memory, so just police its size.
        const buffer = await guard.guard(response.arrayBuffer());
        if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
          throw tooLarge(buffer.byteLength, 'download');
        }
        return new Uint8Array(buffer);
      }

      // `Response.body` is a stream of bytes, but the ambient type leaves the
      // chunk type open; this is the one place that pins it.
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const chunk = await guard.guard(reader.read());
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > MAX_ATTACHMENT_BYTES) throw tooLarge(total, 'download');
          chunks.push(chunk.value);
        }
      } catch (error) {
        // Whatever ended the read — the cap, the attempt timeout, the caller —
        // the transfer stops here rather than going on pulling bytes that now
        // have no destination.
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }

      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    };

    /**
     * Turn the declared parts into a `FormData`, refusing anything the Jira
     * upload route cannot mean. The size check runs on the summed part sizes
     * BEFORE a single `Blob` exists, so an oversized upload never gets copied.
     */
    const buildMultipart = (parts: readonly JiraMultipartFile[]): FormData => {
      if (spec.body !== undefined) {
        throw fail({
          kind: 'config',
          message: `${method} ${route} was given both a JSON body and multipart parts.`,
          remediation: 'A request carries one or the other; this is a caller bug.',
        });
      }
      if (method !== 'POST') {
        throw fail({
          kind: 'config',
          message: `${method} ${route} cannot carry multipart parts; only POST uploads can.`,
          remediation: 'This is a caller bug: send the upload as a POST.',
        });
      }
      if (parts.length === 0) {
        throw fail({
          kind: 'config',
          message: `${method} ${route} was given an empty multipart body.`,
          remediation: 'Send at least one file part.',
        });
      }

      let total = 0;
      for (const part of parts) total += part.bytes.byteLength;
      if (total > MAX_ATTACHMENT_BYTES) throw tooLarge(total, 'upload');

      const form = new FormData();
      for (const part of parts) {
        const blob = new Blob([part.bytes], {
          type: part.contentType ?? 'application/octet-stream',
        });
        form.append(part.field, blob, part.filename);
      }
      return form;
    };

    const requestHeaders: Record<string, string> = {
      // A binary read takes whatever Jira sends; only the JSON path may insist.
      accept: wantsBinary ? '*/*' : 'application/json',
      authorization: basicAuthHeader(creds.email, creds.apiToken),
    };
    let payload: string | FormData | undefined;
    if (spec.multipart !== undefined) {
      payload = buildMultipart(spec.multipart);
      // Jira refuses an upload without this XSRF opt-out (JIRA-API.md).
      requestHeaders['x-atlassian-token'] = 'no-check';
      // No content-type by hand: only `fetch` knows the boundary it generated,
      // and a boundary-less multipart header makes Jira answer 400.
    } else if (spec.body !== undefined) {
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
     * Arm one attempt's timeout. The timer is a clock sleep, not a real one,
     * and it is disarmed by the attempt's own `finally` — after the body, not
     * after the headers.
     */
    const armAttempt = (attemptTimeoutMs: number): AttemptGuard => {
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
      // Each `guard()` race observes this rejection, but the last race of an
      // attempt may already have settled when the abort lands; claiming it here
      // keeps that from being reported as an unhandled rejection.
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
          spec.signal?.removeEventListener('abort', onCallerAbort);
          stopTimer.abort();
          await timer;
        },
      };
    };

    /**
     * Read a body whose CONTENT cannot change the outcome — an error body, a
     * drained redirect. The status has already decided what happens, so a read
     * that fails costs a message snippet, not the verdict.
     */
    const readTextOrEmpty = async (
      guard: AttemptGuard,
      response: Response,
    ): Promise<string> => {
      try {
        return await guard.guard(response.text());
      } catch {
        return '';
      }
    };

    /**
     * One network hop. `fetch` is read off `globalThis` HERE, not at module
     * load, and the timeout comes from the attempt guard — both are the seams
     * the wire tests drive.
     */
    const sendOnce = async (
      guard: AttemptGuard,
      target: HopTarget,
    ): Promise<Response> => {
      const fetchFn = globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        throw fail({
          kind: 'config',
          message: 'This runtime has no global fetch.',
          remediation: 'Run the server on Node 22 or newer.',
        });
      }
      if (spec.signal?.aborted) throw abortError();

      return await guard.guard(
        fetchFn(target.url, {
          method,
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
    };

    /**
     * Resolve the media URL a 303 points at, or refuse to go there.
     *
     * Jira answers `GET /attachment/content/{id}` with a redirect to a signed,
     * short-lived URL on an Atlassian media host that is NOT the site host and
     * is not knowable in advance — so the operator allowlist deliberately does
     * not apply to it (it would have to be widened to a wildcard to work at
     * all, which is worse). What does apply: https only, the SSRF blocklist,
     * exactly one hop, and no credentials.
     */
    const mediaHop = (location: string, status: number): HopTarget => {
      const refuse = (why: string): JiraError =>
        fail({
          kind: 'config',
          message: `Jira answered ${method} ${route} with a ${String(status)} redirect ${why}.`,
          httpStatus: status,
          retryable: false,
          remediation:
            'Attachment downloads follow exactly one redirect, to an https host that is not private or link-local. Check JIRA_SITE and any proxy that may be rewriting the response.',
        });

      if (location === '') throw refuse('but no Location header');
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        throw refuse('to an unparseable location');
      }
      if (target.protocol !== 'https:') throw refuse('to a non-https location');
      if (isBlockedHost(target.hostname)) {
        throw refuse(`to "${target.host}", which is never contacted`);
      }
      // No authorization, no XSRF token, no cookies: the signed URL is the only
      // credential the media host needs, and undici would strip ours anyway.
      return { url: target.toString(), headers: { accept: '*/*' } };
    };

    /**
     * Every `fetch` of one attempt — which is one, except for the
     * attachment-download 303. That hop runs INSIDE the attempt, so it still
     * holds the host semaphore slot, shares the one attempt timeout, and does
     * not spend a retry.
     */
    const sendAttempt = async (
      guard: AttemptGuard,
      attempt: number,
      attemptStartedAt: number,
    ): Promise<Response> => {
      const first = await sendOnce(guard, {
        url,
        headers: requestHeaders,
        body: payload,
      });
      // Only a binary GET may be redirected anywhere; for everything else a 3xx
      // stays what it has always been — a refusal, raised by the main loop.
      if (!wantsBinary || method !== 'GET' || !isRedirectStatus(first.status)) {
        return first;
      }

      const location = first.headers.get('location') ?? '';
      await readTextOrEmpty(guard, first);
      // The hop gets its own http_response event so the redirect is visible in
      // the log; the media URL itself is a bearer credential and never logged.
      logger.emit('http_response', {
        method,
        pathTemplate: route,
        status: first.status,
        durationMs: clock.now() - attemptStartedAt,
        attempt,
      });
      return await sendOnce(guard, mediaHop(location, first.status));
    };

    /**
     * One attempt as the retry loop sees it: from the first byte sent to the
     * last byte read. Consuming the body HERE is what puts it under the attempt
     * timeout, under the call budget and under the host semaphore — and what
     * turns a body that never arrives into a failed attempt rather than a
     * successful call that quietly reports no data.
     */
    const runAttempt = async (
      guard: AttemptGuard,
      attempt: number,
      attemptStartedAt: number,
    ): Promise<AttemptResult> => {
      const response = await sendAttempt(guard, attempt, attemptStartedAt);
      const status = response.status;
      // Emitted on the headers, before the body: a response that arrived and
      // then stalled must still show up in the log as the status it was.
      logger.emit('http_response', {
        method,
        pathTemplate: route,
        status,
        durationMs: clock.now() - attemptStartedAt,
        attempt,
      });

      const headers = headersOf(response);
      if (!isSuccessStatus(status)) {
        return { status, headers, text: await readTextOrEmpty(guard, response) };
      }
      if (wantsBinary) {
        // The body is bytes by contract, so nothing here parses or inspects it
        // — the only thing that can still go wrong is size, and `readCapped`
        // owns that.
        return { status, headers, text: '', bytes: await readCapped(guard, response) };
      }
      return { status, headers, text: await guard.guard(response.text()) };
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
    // One logical request, whatever it costs in attempts (D12).
    telemetry?.recordRequest();

    for (let attempt = 1; ; attempt += 1) {
      if (remaining() <= 0) budgetExceeded();

      const attemptTimeoutMs = Math.min(timeoutMs, remaining());
      const release = await acquireSlot();
      const guard = armAttempt(attemptTimeoutMs);
      const attemptStartedAt = clock.now();
      let result: AttemptResult | undefined;
      let failure: AttemptFailure | undefined;

      try {
        result = await runAttempt(guard, attempt, attemptStartedAt);
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
        // The slot and the timeout cover the whole attempt, body included, and
        // both end HERE — before any backoff wait, so a sleeping retry never
        // sits on a slot another call could be using.
        await guard.disarm();
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
          telemetry?.recordRetry();
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

      if (!result) {
        // Unreachable: `runAttempt` either returns a result or throws.
        throw fail({
          kind: 'unexpected_shape',
          message: `${method} ${route} produced no response.`,
        });
      }

      const { status, headers } = result;

      if (isRedirectStatus(status)) {
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

        if (attempt <= maxRetries) {
          logger.emit('http_retry', {
            method,
            pathTemplate: route,
            reason: '429',
            attempt,
            delayMs: waitMs,
          });
          // A 429 wait is a retry AND the throttling signal an operator asks
          // about, so it lands in both counters (OBSERVABILITY.md §Counters).
          telemetry?.recordRetry();
          telemetry?.recordRateLimitWait();
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
          const delayMs = backoffMs(attempt, rng);
          logger.emit('http_retry', {
            method,
            pathTemplate: route,
            reason: '5xx',
            attempt,
            delayMs,
          });
          telemetry?.recordRetry();
          await waitFor(delayMs);
          continue;
        }
        if (!replayable) ambiguousWrite(`failed with HTTP ${String(status)}`);
      } else {
        noteSuccess();
      }

      if (!isSuccessStatus(status)) {
        const body = projectErrorBody(result.text);
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

      if (wantsBinary) return { status, headers, data: result.bytes as T };

      const text = result.text;
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

  if (telemetry === undefined) return jiraRequest;

  // Errors are counted at the boundary rather than at each `fail()` site: this
  // is the one place that sees EVERY failure a request produced, including the
  // host-policy refusal raised before the loop, and it cannot double-count a
  // retry that was later recovered.
  return async <T = unknown>(spec: JiraRequestSpec): Promise<JiraResponse<T>> => {
    try {
      return await jiraRequest<T>(spec);
    } catch (error) {
      telemetry.recordError(error instanceof JiraError ? error.kind : UNKNOWN_ERROR_KIND);
      throw error;
    }
  };
}
