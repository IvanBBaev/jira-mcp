/**
 * Session cache for Jira's slow-moving metadata catalogues (D123).
 *
 * A model rarely asks for the field list, the status catalogue, the link
 * types or a project's create meta once; it asks before every write it
 * plans, and each ask is a full round trip for a body that changes once a
 * quarter. This decorator sits on the request seam and answers a repeat
 * `GET` on one of the catalogue routes from memory for `ttlMs` after the
 * original fetch started.
 *
 * What it will NOT cache, by construction:
 *
 * - anything but a bodiless `GET` — `POST /field` creates a custom field;
 * - routes outside the whitelist — transitions depend on the issue's state,
 *   projects on the caller's visibility, `/myself` and `/mypermissions` on
 *   the credential, assignable-user search on the project's permission
 *   scheme, and search results on the data;
 * - failed requests — an error propagates and nothing is stored;
 * - a request whose signal is already aborted — it goes to the seam, which
 *   raises the caller's `aborted` error;
 * - across profiles — the profile name is part of the key, so a `prod` fetch
 *   never answers a `staging` ask.
 *
 * Hits hand out a deep copy so a caller mutating the body (the create-meta
 * paging loops splice rows) cannot poison the next hit. Misses are not
 * coalesced: a shared in-flight promise would hand the second caller the
 * first caller's signal and deadline, and MCP tool calls on one session are
 * sequential anyway.
 *
 * Identity lookups (D129). `GET /user/search` is cached too, because a
 * mention costs one search at plan time and the same search again at apply
 * (CC-111), and Jira prices identity calls above plain reads. People change
 * faster than catalogues — an account is deactivated, a display name edited —
 * so those entries live for `ttlMs` but never longer than
 * {@link IDENTITY_CACHE_MAX_TTL_MS}, however high the operator set the knob.
 *
 * Observability: a hit is a tool call with no `http_request`/`http_response`
 * under its correlation id — no new log event, see OBSERVABILITY.md.
 */

import type {
  Clock,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  QueryParams,
} from './types.js';

/**
 * Path templates the cache may answer. Compared against `pathTemplate` when
 * the api ring set one (the create-meta routes do) and against the literal
 * `path` otherwise. Both the Cloud (`v3`) and Data Center (`v2`) roots are
 * cacheable — the root is part of the key, so they never alias.
 */
export const META_CACHE_ROUTES: readonly string[] = [
  '/field',
  '/issueLinkType',
  '/statuses/search',
  '/status',
  '/issue/createmeta/{projectIdOrKey}/issuetypes',
  '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
  '/priority/search',
  '/resolution/search',
  '/issuetype',
];

/**
 * Identity routes: cached like the catalogues, but never past
 * {@link IDENTITY_CACHE_MAX_TTL_MS} (D129).
 */
export const IDENTITY_CACHE_ROUTES: readonly string[] = ['/user/search'];

/** Ceiling on an identity entry's lifetime: five minutes (D129). */
export const IDENTITY_CACHE_MAX_TTL_MS = 300_000;

/** `maxEntries` default: a tenant has one field list and a handful of projects. */
export const DEFAULT_META_CACHE_ENTRIES = 64;

export interface MetaCacheOptions {
  readonly clock: Clock;
  /** Lifetime of an entry from the moment its fetch STARTED. `0` disables. */
  readonly ttlMs: number;
  /** Upper bound on stored entries; the oldest is evicted first. */
  readonly maxEntries?: number;
}

export interface MetaCache {
  /**
   * Wraps a request function. With `ttlMs === 0` the seam is returned
   * untouched, so a disabled cache costs nothing per call.
   */
  wrap(inner: JiraRequestFn): JiraRequestFn;
  /** Entries currently stored, expired ones included until a lookup prunes them. */
  size(): number;
  /** Forgets everything. */
  clear(): void;
}

interface Entry {
  readonly expiresAt: number;
  readonly status: number;
  readonly headers: JiraResponse['headers'];
  readonly data: unknown;
}

const ROUTES = new Set([...META_CACHE_ROUTES, ...IDENTITY_CACHE_ROUTES]);
const IDENTITY_ROUTES = new Set(IDENTITY_CACHE_ROUTES);

/** How long an entry for `req` may live, given the configured `ttlMs`. */
function ttlFor(req: JiraRequestSpec, ttlMs: number): number {
  return IDENTITY_ROUTES.has(req.pathTemplate ?? req.path)
    ? Math.min(ttlMs, IDENTITY_CACHE_MAX_TTL_MS)
    : ttlMs;
}

/** Whether the decorator may answer `req` from memory. */
export function isMetaCacheable(req: JiraRequestSpec): boolean {
  if (req.method !== 'GET') return false;
  if (req.body !== undefined || req.multipart !== undefined) return false;
  if (req.accept === 'binary') return false;
  return ROUTES.has(req.pathTemplate ?? req.path);
}

/**
 * Query parameters in a stable textual form: keys sorted, `undefined`
 * dropped (the client omits them from the wire too), values stringified
 * the way the client does.
 */
function canonicalQuery(query: QueryParams | undefined): [string, string][] {
  if (query === undefined) return [];
  const pairs: [string, string][] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    pairs.push([key, String(value)]);
  }
  return pairs;
}

/** The store key: everything that changes what Jira would answer. */
export function metaCacheKey(req: JiraRequestSpec): string {
  return JSON.stringify([
    req.profile ?? '',
    req.root ?? 'v3',
    req.path,
    canonicalQuery(req.query),
  ]);
}

export function createMetaCache(options: MetaCacheOptions): MetaCache {
  const { clock, ttlMs } = options;
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_META_CACHE_ENTRIES);
  const store = new Map<string, Entry>();

  function lookup(key: string): Entry | undefined {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (clock.now() >= entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  function remember(key: string, entry: Entry): void {
    // Delete first so a refresh moves the key to the end of the insertion
    // order; then evict from the front until there is room.
    store.delete(key);
    while (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
    store.set(key, entry);
  }

  function wrap(inner: JiraRequestFn): JiraRequestFn {
    if (ttlMs <= 0) return inner;
    return async <T = unknown>(req: JiraRequestSpec): Promise<JiraResponse<T>> => {
      if (!isMetaCacheable(req) || req.signal?.aborted === true) {
        return inner<T>(req);
      }
      const key = metaCacheKey(req);
      const hit = lookup(key);
      if (hit !== undefined) {
        return {
          status: hit.status,
          headers: { ...hit.headers },
          data: structuredClone(hit.data) as T,
        };
      }
      const startedAt = clock.now();
      const res = await inner<T>(req);
      remember(key, {
        expiresAt: startedAt + ttlFor(req, ttlMs),
        status: res.status,
        headers: res.headers,
        data: structuredClone(res.data),
      });
      return res;
    };
  }

  return {
    wrap,
    size: () => store.size,
    clear: () => store.clear(),
  };
}
