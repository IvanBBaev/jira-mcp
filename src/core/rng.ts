// The real {@link Rng} — the ONLY module (with `core/clock.ts`) where
// `Math.random` is lint-legal (ARCHITECTURE.md §Cross-cutting seams).
//
// Two consumers: retry / Retry-After jitter in `core/http.ts` (JIRA-API.md
// §Rate limiting and retries — synchronized agents must not stampede a tenant
// when the rate-limit window reopens) and correlation-id generation in
// `core/log.ts`. Both are asserted exactly in tests by injecting a scripted
// sequence instead of this function, which is the whole reason the seam exists.
//
// Not a security primitive: jitter and correlation ids are diagnostics, not
// tokens. Anything that needs unpredictability uses `node:crypto` directly.

import type { Rng } from './types.js';

/**
 * Create an {@link Rng} backed by `Math.random` — a float in `[0, 1)`, same
 * contract as the platform function it wraps.
 */
export function createSystemRng(): Rng {
  return () => Math.random();
}

/** The process-wide randomness seam. Composition roots inject this. */
export const systemRng: Rng = createSystemRng();
