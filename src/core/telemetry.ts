// ---------------------------------------------------------------------------
// In-process counters (OBSERVABILITY.md §Counters, D12).
//
// Four numbers and nothing else: how many logical requests went out, how many
// retries they cost, how many of those retries were rate-limit waits, and how
// the failures split by error kind. They exist so an operator can ask "is this
// server being throttled?" without turning on debug logging and reading events.
//
// WHAT THIS MODULE DELIBERATELY IS NOT. No OTel, no metrics endpoint, no
// timers, no per-host or per-route split, no phone-home. The counters live in
// one closure, are read in exactly two places (`jira_capabilities` output and
// the doctor report) and die with the process. That is the whole contract, and
// keeping it small is what makes it safe to increment on the hot path.
//
// NOT A SINGLETON. `createTelemetry()` returns an instance the composition root
// injects into `core/http.ts` — the only module that touches the network, and
// therefore the only module that can honestly count requests. Two clients (two
// profiles, or two tests) never share a counter unless they were handed the
// same instance on purpose.
//
// Layering: `core` is layer 0. No imports, no clock, no state outside the
// closure.
// ---------------------------------------------------------------------------

/** `errors` bucket for a throw that was not a `JiraError` (a bug, not a kind). */
export const UNKNOWN_ERROR_KIND = 'unknown';

/** An immutable reading of the counters. Safe to serialize as-is. */
export interface Counters {
  /** Logical requests started — one per `JiraRequestFn` call, not per attempt. */
  readonly requests: number;
  /** Retry attempts made, whatever the reason (transport, 429, 5xx). */
  readonly retries: number;
  /** The subset of retries that waited out a 429 (`Retry-After` or backoff). */
  readonly rateLimitWaits: number;
  /** Failures by `JiraErrorKind`; a kind with no failures is absent, not 0. */
  readonly errors: Readonly<Record<string, number>>;
}

/**
 * The write side, held by `core/http.ts`. Every method is total and cheap:
 * counting must never be able to fail a request it is only observing.
 */
export interface Telemetry {
  /** One logical request went out (retries of it are not requests). */
  recordRequest(): void;
  /** One retry attempt was made. */
  recordRetry(): void;
  /** One retry attempt was a 429 wait; also counted as a retry by the caller. */
  recordRateLimitWait(): void;
  /** One request ended in a failure of `kind`. */
  recordError(kind: string): void;
  /** Current values, detached — a later increment never mutates a snapshot. */
  snapshot(): Counters;
}

/** All-zero counters: what a server that never called Jira reports. */
export function zeroCounters(): Counters {
  return { requests: 0, retries: 0, rateLimitWaits: 0, errors: {} };
}

/** Create an independent counter set. */
export function createTelemetry(): Telemetry {
  let requests = 0;
  let retries = 0;
  let rateLimitWaits = 0;
  const errors = new Map<string, number>();

  return {
    recordRequest(): void {
      requests += 1;
    },
    recordRetry(): void {
      retries += 1;
    },
    recordRateLimitWait(): void {
      rateLimitWaits += 1;
    },
    recordError(kind: string): void {
      const key = kind === '' ? UNKNOWN_ERROR_KIND : kind;
      errors.set(key, (errors.get(key) ?? 0) + 1);
    },
    snapshot(): Counters {
      // Sorted so two readings of the same state render identically — the
      // doctor report and the capabilities payload are both read by humans.
      const byKind: Record<string, number> = {};
      for (const key of [...errors.keys()].sort()) {
        byKind[key] = errors.get(key) ?? 0;
      }
      return { requests, retries, rateLimitWaits, errors: byKind };
    },
  };
}
