// Transport policy primitives: everything `core/http.ts` decides *before* or
// *between* network calls, kept pure so it can be unit-tested without a wire.
//
// Three groups live here:
//
//  1. Host policy (SSRF defense). Default-deny: a canonical Jira Cloud site or
//     an explicit allowlist entry (exact host or ANCHORED regex). Suffix
//     matching is banned — `endsWith('atlassian.net')` happily accepts
//     `evil-atlassian.net`, which is the whole attack. The loopback/link-local/
//     metadata blocklist is checked FIRST and wins even over an allowlist entry,
//     so a mistyped (or attacker-supplied) allowlist can never point the client
//     at 169.254.169.254.
//  2. URL building. Every dynamic segment is percent-encoded individually and
//     validated: `..`, `/` and friends fail here, before the wire, because
//     `encodeURIComponent('..')` is `'..'` — encoding alone does not stop
//     traversal.
//  3. Retry arithmetic + the per-host semaphore. All randomness comes from an
//     injected `Rng` and all time from the caller's `Clock`, so backoff
//     sequences are asserted exactly in tests (CC-11…CC-14).
//
// Nothing here reads env, imports settings, or touches `globalThis.fetch`.

import { JIRA_ROOT_PATHS, JiraError } from './types.js';
import type { HostRef, HttpMethod, JiraApiRoot, QueryParams, Rng } from './types.js';

/* ------------------------------------------------------------------------- *
 * Defaults and policy constants
 * ------------------------------------------------------------------------- */

/** `JIRA_REQUEST_TIMEOUT_MS` default (CONFIGURATION.md §HTTP behaviour). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** `JIRA_CALL_BUDGET_MS` default. */
export const DEFAULT_CALL_BUDGET_MS = 120_000;
/** `JIRA_HOST_CONCURRENCY` default. */
export const DEFAULT_HOST_CONCURRENCY = 4;
/** `JIRA_RETRY_ATTEMPTS` default — retries, so total tries = this + 1. */
export const DEFAULT_RETRY_ATTEMPTS = 3;

/** Hard ceiling on an honoured `Retry-After` (JIRA-API.md, CC-14). */
export const MAX_RETRY_AFTER_MS = 60_000;
/** Exponential backoff base: 500 · 2^(attempt-1). */
export const BACKOFF_BASE_MS = 500;
/** Exponential backoff ceiling. */
export const BACKOFF_CAP_MS = 8_000;
/** Flat jitter added to every backoff wait. */
export const BACKOFF_JITTER_MS = 250;
/** Fractional jitter added on top of a capped `Retry-After` (0–20 %). */
export const RETRY_AFTER_JITTER = 0.2;

/**
 * Hard ceiling on ONE attachment transfer, in bytes — 50 MiB, both directions
 * (WP-70). Deliberately a constant and not an environment knob: it is a memory
 * bound, not a preference. An attachment travels through this process as a
 * single `Uint8Array`, so the ceiling is what keeps a hostile or merely large
 * attachment from turning into an unbounded allocation in an MCP server that
 * usually lives inside a desktop client.
 *
 * 50 MiB sits above Jira Cloud's default per-file attachment limit (10 MB) with
 * room for sites that raised it, and below the point where buffering the body
 * is reckless. Enforced DURING the transfer: a download aborts the stream at
 * the byte that crosses the line, an upload is measured before any part is
 * assembled. Breach is `kind=validation` — the same kind an HTTP 413 maps to.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/* ------------------------------------------------------------------------- *
 * Host policy
 * ------------------------------------------------------------------------- */

/**
 * A Jira Cloud site: exactly one label in front of `atlassian.net`.
 *
 * Anchored on both ends on purpose — this is the pattern the donor got wrong.
 */
export const CANONICAL_JIRA_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;

/** Names that are never contacted, whatever the allowlist says. */
const BLOCKED_NAME = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const EMBEDDED_IPV4 = /(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * Lowercase, strip IPv6 brackets and a trailing FQDN dot.
 *
 * The trailing dot matters: `evil.com.` and `evil.com` resolve to the same
 * name but are different strings, so an exact-match allowlist without this
 * normalization is trivially bypassed in the other direction.
 */
export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  if (octets.some((o) => o > 255)) return true; // not a real address: fail closed
  if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, RFC1918
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Loopback / private / link-local / metadata host, in name or literal-IP form.
 *
 * Deliberately over-broad: a false positive is a config error with a clear
 * message, a false negative is an SSRF.
 */
export function isBlockedHost(raw: string): boolean {
  const host = normalizeHost(raw);
  if (host === '') return true;
  if (BLOCKED_NAME.test(host)) return true;

  const v4 = IPV4.exec(host);
  if (v4) {
    return isBlockedIpv4(v4.slice(1).map((part) => Number(part)));
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^fe[89ab]/.test(host)) return true; // link-local
    if (/^f[cd]/.test(host)) return true; // unique-local
    if (host.startsWith('fec0')) return true; // deprecated site-local
    const mapped = EMBEDDED_IPV4.exec(host); // ::ffff:127.0.0.1
    if (mapped?.[1]) {
      return isBlockedIpv4(mapped[1].split('.').map((part) => Number(part)));
    }
  }

  return false;
}

/** Why a host was (not) accepted — `blocked` and `not_allowed` both refuse. */
export type HostVerdict = 'canonical' | 'allowlisted' | 'blocked' | 'not_allowed';

function compileHostPattern(entry: string): RegExp {
  const source = entry.slice(1, -1);
  if (!source.startsWith('^') || !source.endsWith('$')) {
    throw new JiraError({
      kind: 'config',
      message: `Allowed-host pattern ${entry} is not anchored.`,
      remediation:
        'Anchor the pattern with ^ and $ (e.g. /^jira\\.example\\.com$/). ' +
        'Unanchored patterns match substrings, which defeats the allowlist.',
    });
  }
  try {
    return new RegExp(source, 'i');
  } catch (cause) {
    throw new JiraError({
      kind: 'config',
      message: `Allowed-host pattern ${entry} is not a valid regular expression.`,
      remediation: 'Fix the pattern in JIRA_ALLOWED_HOSTS, or use an exact host name.',
      cause,
    });
  }
}

function matchesHostEntry(host: string, entry: string): boolean {
  const raw = entry.trim();
  if (raw === '') return false;
  if (raw.length > 2 && raw.startsWith('/') && raw.endsWith('/')) {
    return compileHostPattern(raw).test(host);
  }
  return host === normalizeHost(raw);
}

/**
 * Classify `rawHost` against the canonical Cloud pattern plus `allowedHosts`.
 *
 * Order is the security property: blocklist first, so an allowlist entry can
 * widen the set of *public* hosts but never reach a private one.
 *
 * @throws JiraError `kind: 'config'` if an allowlist entry is a malformed or
 * unanchored regex — a broken allowlist is a startup bug, not a silent deny.
 */
export function checkHost(
  rawHost: string,
  allowedHosts: readonly string[] = [],
): HostVerdict {
  const host = normalizeHost(rawHost);
  if (isBlockedHost(host)) return 'blocked';
  if (CANONICAL_JIRA_HOST.test(host)) return 'canonical';
  for (const entry of allowedHosts) {
    if (matchesHostEntry(host, entry)) return 'allowlisted';
  }
  return 'not_allowed';
}

/** Boolean form of {@link checkHost}. */
export function isAllowedHost(
  host: string,
  allowedHosts: readonly string[] = [],
): boolean {
  const verdict = checkHost(host, allowedHosts);
  return verdict === 'canonical' || verdict === 'allowlisted';
}

/**
 * Throwing form of {@link checkHost}. `context` names where the host came
 * from ("redirect target", "request host") so the message is actionable.
 */
export function assertHostAllowed(
  host: string,
  allowedHosts: readonly string[] = [],
  context = 'request host',
): void {
  const verdict = checkHost(host, allowedHosts);
  if (verdict === 'canonical' || verdict === 'allowlisted') return;
  if (verdict === 'blocked') {
    throw new JiraError({
      kind: 'config',
      message: `Refusing to contact "${host}" (${context}): loopback, private, link-local and metadata addresses are never contacted.`,
      remediation:
        'Point JIRA_SITE at a Jira Cloud site. This block applies even to hosts listed in JIRA_ALLOWED_HOSTS.',
    });
  }
  throw new JiraError({
    kind: 'config',
    message: `Host "${host}" (${context}) is not a Jira Cloud site and is not in the allowed-host list.`,
    remediation:
      'Use a <site>.atlassian.net host, or add the exact host — or an anchored /^pattern$/ — to JIRA_ALLOWED_HOSTS.',
  });
}

/**
 * Validate an origin string and return its host.
 *
 * @throws JiraError `kind: 'config'` for a non-https origin, an origin with
 * embedded credentials, or anything `URL` cannot parse.
 */
export function hostFromOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (cause) {
    throw new JiraError({
      kind: 'config',
      message: `Jira origin "${origin}" is not a valid URL.`,
      remediation: 'Set JIRA_SITE to a site name or an https:// URL.',
      cause,
    });
  }
  if (url.protocol !== 'https:') {
    throw new JiraError({
      kind: 'config',
      message: `Jira origin "${origin}" is not https.`,
      remediation:
        'Jira Cloud is https-only; credentials are never sent over plain http.',
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw new JiraError({
      kind: 'config',
      message: 'Jira origin must not embed credentials.',
      remediation:
        'Remove the user:password part; auth comes from JIRA_EMAIL/JIRA_API_TOKEN.',
    });
  }
  return normalizeHost(url.hostname);
}

/* ------------------------------------------------------------------------- *
 * URL building
 * ------------------------------------------------------------------------- */

// Anything that could end a segment early, smuggle a query, inject a header or
// re-open traversal after the server decodes.
const SEGMENT_FORBIDDEN = /[/\\?#%\s]/;
const PATH_FORBIDDEN = /[?#\s]/;
const PATH_DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/;
const PATH_ENCODED_DOT = /%2e/i;

/**
 * C0/C1 control characters, checked by code point rather than by a regex
 * containing literal control bytes. CR/LF in a URL is a header-injection
 * vector, so this is a rejection, never an encoding.
 */
function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function invalidPath(message: string, remediation: string): JiraError {
  return new JiraError({ kind: 'validation', message, remediation });
}

/**
 * Percent-encode one dynamic path segment after validating it.
 *
 * `encodeURIComponent` alone is not a defense: it leaves `.` untouched, so
 * `..` survives encoding intact. Traversal, separators and control characters
 * are therefore rejected outright rather than encoded.
 *
 * @throws JiraError `kind: 'validation'` — always before any network call.
 */
export function encodeSegment(value: string, label = 'path segment'): string {
  if (value === '') {
    throw invalidPath(`Empty ${label}.`, 'Provide a non-empty identifier.');
  }
  if (value !== value.trim()) {
    throw invalidPath(
      `The ${label} "${value}" has leading or trailing whitespace.`,
      'Trim the identifier before calling.',
    );
  }
  if (value === '.' || value === '..') {
    throw invalidPath(
      `The ${label} "${value}" is a path-traversal segment.`,
      'Pass a real Jira identifier (issue key, id, accountId).',
    );
  }
  if (SEGMENT_FORBIDDEN.test(value) || hasControlChar(value)) {
    throw invalidPath(
      `The ${label} "${value}" contains a character that is not allowed in an identifier (/, \\, ?, #, %, whitespace or a control character).`,
      'Pass a single identifier, not a path or a pre-encoded value.',
    );
  }
  return encodeURIComponent(value);
}

/**
 * Validate an API-root-relative path (the `path` of a `JiraRequestSpec`).
 *
 * Callers build these with {@link encodeSegment}; this is the belt-and-braces
 * check that nothing hand-assembled slipped through.
 */
export function assertApiPath(path: string): void {
  if (!path.startsWith('/')) {
    throw invalidPath(
      `Request path "${path}" must start with "/".`,
      'Paths are relative to the API root, e.g. "/issue/ABC-1".',
    );
  }
  if (path.startsWith('//') || path.includes('://')) {
    throw invalidPath(
      `Request path "${path}" looks like an absolute URL.`,
      'Pass a path relative to the API root; the host comes from configuration only.',
    );
  }
  if (PATH_FORBIDDEN.test(path) || hasControlChar(path)) {
    throw invalidPath(
      `Request path "${path}" contains "?", "#", whitespace or a control character.`,
      'Put query parameters in the request `query` object, not in the path.',
    );
  }
  if (PATH_DOT_SEGMENT.test(path) || PATH_ENCODED_DOT.test(path)) {
    throw invalidPath(
      `Request path "${path}" contains a path-traversal segment.`,
      'Build dynamic segments with encodeSegment(); "." and ".." are never valid Jira identifiers.',
    );
  }
}

/** Serialize query params, dropping `undefined` values (contract: omitted). */
export function buildQueryString(query?: QueryParams): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  return params.toString();
}

/**
 * Compose `origin + pathPrefix + apiRoot + path + query`.
 *
 * The final origin is re-compared against the configured one: if any part of
 * the path ever escaped its host, the request dies here instead of on the wire.
 */
export function buildRequestUrl(
  host: HostRef,
  root: JiraApiRoot,
  path: string,
  query?: QueryParams,
): string {
  assertApiPath(path);
  if (host.pathPrefix !== '') {
    if (host.pathPrefix.endsWith('/')) {
      throw new JiraError({
        kind: 'config',
        message: `Host path prefix "${host.pathPrefix}" must not end with "/".`,
        remediation: 'Use "" or a prefix like "/ex/jira/<cloudId>".',
      });
    }
    assertApiPath(host.pathPrefix);
  }

  const base = new URL(host.origin);
  if (base.pathname !== '/' || base.search !== '' || base.hash !== '') {
    throw new JiraError({
      kind: 'config',
      message: `Host origin "${host.origin}" must be scheme + host only.`,
      remediation: 'Move any path onto HostRef.pathPrefix.',
    });
  }

  const url = new URL(`${base.origin}${host.pathPrefix}${JIRA_ROOT_PATHS[root]}${path}`);
  if (url.origin !== base.origin) {
    throw new JiraError({
      kind: 'config',
      message: 'Refusing to send a request whose URL escaped the configured host.',
      remediation: 'This is a bug in the caller: report it.',
    });
  }

  const qs = buildQueryString(query);
  return qs === ''
    ? `${url.origin}${url.pathname}`
    : `${url.origin}${url.pathname}?${qs}`;
}

/* ------------------------------------------------------------------------- *
 * Retry arithmetic
 * ------------------------------------------------------------------------- */

const RETRY_ANY_METHOD = new Set([429]);
const RETRY_REPLAYABLE_ONLY = new Set([502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** HTTP-idempotent by method alone. Jira's writes are not, so: GET only. */
export function isIdempotent(method: HttpMethod): boolean {
  return method === 'GET';
}

/**
 * May this request be sent again after an ambiguous failure?
 *
 * GET always; anything else only with an explicit per-request `safe: true`
 * (the read-shaped POSTs: `/search/jql`, `/search/approximate-count`).
 */
export function isReplayable(method: HttpMethod, safe?: boolean): boolean {
  return isIdempotent(method) || safe === true;
}

/** 429 for every method; 502/503/504 only for replayable requests. */
export function shouldRetryStatus(
  status: number,
  method: HttpMethod,
  safe?: boolean,
): boolean {
  if (RETRY_ANY_METHOD.has(status)) return true;
  return isReplayable(method, safe) && RETRY_REPLAYABLE_ONLY.has(status);
}

/** A 3xx we must not follow (`redirect: 'manual'` surfaces these). */
export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function unitRandom(rng: Rng): number {
  const value = rng();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
}

/** `min(500 · 2^(attempt-1), 8000)` plus 0–250 ms of injected jitter. */
export function backoffMs(attempt: number, rng: Rng): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
  return base + Math.floor(unitRandom(rng) * BACKOFF_JITTER_MS);
}

/**
 * Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds.
 *
 * `nowMs` comes from the injected clock — the date form is relative to it.
 * Returns `undefined` for an absent or unparseable header; never negative.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const text = header.trim();
  if (text === '') return undefined;

  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Clamp a server-supplied wait to `[0, MAX_RETRY_AFTER_MS]` (CC-14). */
export function capRetryAfterMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/**
 * Add `0…fraction · ms` of injected jitter.
 *
 * Applied AFTER the 60 s cap, not before: when a whole fleet gets the same
 * `Retry-After` the cap is exactly where de-synchronisation matters most, so
 * the jitter must survive it. Worst case is therefore `MAX_RETRY_AFTER_MS · 1.2`.
 */
export function jitterMs(ms: number, fraction: number, rng: Rng): number {
  if (ms <= 0) return 0;
  return ms + Math.floor(ms * fraction * unitRandom(rng));
}

/* ------------------------------------------------------------------------- *
 * Per-host semaphore
 * ------------------------------------------------------------------------- */

/** Releases one slot. Idempotent — calling it twice does not over-credit. */
export type SlotRelease = () => void;

export interface SemaphorePool {
  /**
   * Wait for a slot on `key`. Rejects with an `AbortError` if `signal` fires
   * first, and removes the waiter — a caller that gave up (budget exceeded)
   * must not later be handed a slot nobody releases.
   */
  acquire(key: string, signal?: AbortSignal): Promise<SlotRelease>;
  /** In-flight holders for `key` (test/telemetry introspection). */
  active(key: string): number;
  /** Callers queued behind the limit for `key`. */
  queued(key: string): number;
}

interface Waiter {
  grant: () => void;
  cancel: (reason: Error) => void;
}

interface HostSlots {
  active: number;
  waiters: Waiter[];
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Counting semaphores keyed by host, with FIFO hand-off.
 *
 * State lives in the closure, not in a module singleton: two clients (two
 * profiles, or a test and its neighbour) never share a queue.
 */
export function createSemaphorePool(limit: number): SemaphorePool {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new JiraError({
      kind: 'config',
      message: `Host concurrency must be a positive integer, got ${String(limit)}.`,
      remediation: 'Set JIRA_HOST_CONCURRENCY to 1 or more.',
    });
  }

  const hosts = new Map<string, HostSlots>();

  const slotsFor = (key: string): HostSlots => {
    const existing = hosts.get(key);
    if (existing) return existing;
    const created: HostSlots = { active: 0, waiters: [] };
    hosts.set(key, created);
    return created;
  };

  const releaseFor = (slots: HostSlots): SlotRelease => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = slots.waiters.shift();
      if (next) {
        // Hand the slot straight over: `active` stays as it is.
        next.grant();
        return;
      }
      slots.active -= 1;
      if (slots.active === 0 && slots.waiters.length === 0) {
        // Keep the map from growing one entry per host forever.
        for (const [key, value] of hosts) {
          if (value === slots) hosts.delete(key);
        }
      }
    };
  };

  return {
    acquire(key, signal) {
      const slots = slotsFor(key);
      if (signal?.aborted) return Promise.reject(abortError());

      if (slots.active < limit) {
        slots.active += 1;
        return Promise.resolve(releaseFor(slots));
      }

      return new Promise<SlotRelease>((resolve, reject) => {
        const waiter: Waiter = {
          grant: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve(releaseFor(slots));
          },
          cancel: (reason) => {
            reject(reason);
          },
        };
        function onAbort(): void {
          const index = slots.waiters.indexOf(waiter);
          if (index >= 0) slots.waiters.splice(index, 1);
          waiter.cancel(abortError());
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        slots.waiters.push(waiter);
      });
    },

    active: (key) => hosts.get(key)?.active ?? 0,
    queued: (key) => hosts.get(key)?.waiters.length ?? 0,
  };
}
