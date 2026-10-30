// The ONLY entry to the network (ARCHITECTURE.md §Layering): this barrel and
// the stage modules under `core/http/` behind it are the only code that calls
// `fetch`. The barrel is the public face; nothing outside `core/http*` imports
// a stage module directly (D515: the split keeps every function under 150
// lines and puts the retry policy in a pure, table-tested `decideNext`).
//
// `createJiraRequest(options)` builds the `JiraRequestFn` every `api/*` module
// calls. It owns URL assembly, authorization, the retry matrix, the per-host
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
//
// `createAuthRequest(options)` is the module's second, much smaller export: the
// only way to reach Atlassian's OAuth endpoints. It exists here and not in
// `core/oauth.ts` for one reason — `core/http*` is the only code allowed to call
// `fetch`, and a token exchange is a network call like any other. It is a
// separate primitive rather than a mode of `jiraRequest` because almost nothing
// it does is the same: no site host, no semaphore, no call budget, no Jira error
// shapes, and above all a POST that is NEVER retried (D94). `core/oauth.ts`
// imports this; this must never import `core/oauth.ts` — that direction is the
// cycle.

export { MAX_DETAIL_CHARS } from './http/failures.js';
export { UPSTREAM_DEGRADED_AFTER } from './http/health.js';
export type {
  BasicCredentials,
  BearerCredentials,
  CredentialResolver,
  JiraCredentials,
} from './http/credentials.js';
export { createJiraRequest } from './http/jira-request.js';
export type { JiraHttpOptions } from './http/jira-request.js';
export { createAuthRequest } from './http/auth-request.js';
export type {
  AuthRequestFn,
  AuthRequestOptions,
  AuthRequestSpec,
  AuthResponse,
} from './http/auth-request.js';
