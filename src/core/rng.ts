// The real {@link Rng} — the ONLY module (with `core/clock.ts`) where
// `Math.random` is lint-legal (ARCHITECTURE.md §Cross-cutting seams).
//
// Two consumers: retry / Retry-After jitter in `core/http.ts` (JIRA-API.md
// §Rate limiting and retries — synchronized agents must not stampede a tenant
// when the rate-limit window reopens) and correlation-id generation in
// `core/log.ts`. Both are asserted exactly in tests by injecting a scripted
// sequence instead of this function, which is the whole reason the seam exists.
//
// `Rng` is not a security primitive: jitter and correlation ids are
// diagnostics, not tokens. Anything that must be unguessable draws from the
// second seam here, {@link SecureRandom}, which is `node:crypto` in production
// (D511): plan ids are the first consumer, because a server-wide plan store
// makes an id a handle another session could try to apply.

import { randomBytes } from 'node:crypto';

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

/**
 * The unpredictable-bytes seam (D511): `byteLength` bytes from a CSPRNG. A
 * separate seam from {@link Rng} so tests keep a scripted float sequence for
 * jitter while a token-shaped value can never come from `Math.random`.
 */
export type SecureRandom = (byteLength: number) => Uint8Array;

/** Create a {@link SecureRandom} backed by `node:crypto.randomBytes`. */
export function createSecureRandom(): SecureRandom {
  return (byteLength: number) => randomBytes(byteLength);
}

/** The process-wide CSPRNG seam. Plan ids draw from it unless a test injects one. */
export const systemSecureRandom: SecureRandom = createSecureRandom();
