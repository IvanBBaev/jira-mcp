// ---------------------------------------------------------------------------
// In-process counters (OBSERVABILITY.md §Counters, D12).
//
// Four numbers, plus the last rate-limit headers Jira sent: how many logical
// requests went out, how many retries they cost, how many of those retries were
// rate-limit waits, how the failures split by error kind, and whether the
// tenant's budget is running low (D128). They exist so an operator — or the
// model, through `jira_capabilities` — can ask "is this server being
// throttled?" without turning on debug logging and reading events.
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
// Layering: `core` is layer 0. No imports, no clock (the caller passes the
// instants it observed), no state outside the closure.
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
  /**
   * Rate-limit headroom (D128). Absent until a response was a 429 or carried
   * `X-RateLimit-NearLimit: true` — a server that was never squeezed reports
   * nothing rather than a reassuring `false` on every reading.
   */
  readonly rateLimit?: RateLimitHeadroom;
}

/** What the last Jira responses said about the rate-limit budget (D128). */
export interface RateLimitHeadroom {
  /** The latest response carried `X-RateLimit-NearLimit: true` (< 20 % left). */
  readonly nearLimit: boolean;
  /** ISO instant of the most recent 429; absent if none was seen. */
  readonly lastLimitedAt?: string;
  /** `RateLimit-Reason` of that 429, when Jira sent a documented one. */
  readonly lastReason?: string;
  /** When that 429 said the budget reopens, as an ISO instant. */
  readonly resetAt?: string;
}

/** One response's rate-limit headers, already parsed by the caller. */
export interface RateLimitObservation {
  /** When the response arrived (epoch ms, from the injected clock). */
  readonly atMs: number;
  /** The response was a 429. */
  readonly limited: boolean;
  readonly nearLimit: boolean;
  readonly reason?: string;
  readonly resetAtMs?: number;
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
  /** One Jira response arrived; keep what it said about the budget. */
  recordRateLimit(observation: RateLimitObservation): void;
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
  let headroom: RateLimitHeadroom | undefined;

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
    recordRateLimit(observation: RateLimitObservation): void {
      if (headroom === undefined && !observation.limited && !observation.nearLimit)
        return;
      // NearLimit tracks the latest response; the 429 details stick until the
      // next 429 replaces them, so "when were we last refused" survives the
      // successful calls that follow it.
      const last: Omit<RateLimitHeadroom, 'nearLimit'> = observation.limited
        ? {
            lastLimitedAt: new Date(observation.atMs).toISOString(),
            ...(observation.reason === undefined
              ? {}
              : { lastReason: observation.reason }),
            ...(observation.resetAtMs === undefined
              ? {}
              : { resetAt: new Date(observation.resetAtMs).toISOString() }),
          }
        : {
            ...(headroom?.lastLimitedAt === undefined
              ? {}
              : { lastLimitedAt: headroom.lastLimitedAt }),
            ...(headroom?.lastReason === undefined
              ? {}
              : { lastReason: headroom.lastReason }),
            ...(headroom?.resetAt === undefined ? {} : { resetAt: headroom.resetAt }),
          };
      headroom = { nearLimit: observation.nearLimit, ...last };
    },
    snapshot(): Counters {
      // Sorted so two readings of the same state render identically — the
      // doctor report and the capabilities payload are both read by humans.
      const byKind: Record<string, number> = {};
      for (const key of [...errors.keys()].sort()) {
        byKind[key] = errors.get(key) ?? 0;
      }
      return {
        requests,
        retries,
        rateLimitWaits,
        errors: byKind,
        ...(headroom === undefined ? {} : { rateLimit: headroom }),
      };
    },
  };
}
