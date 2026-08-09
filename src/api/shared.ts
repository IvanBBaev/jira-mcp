// ---------------------------------------------------------------------------
// api/shared.ts — the two Jira pagination loops (WP-15).
//
// Jira Cloud speaks TWO pagination models (JIRA-API.md §Two pagination models)
// and nothing else in the api ring should have to remember which endpoint uses
// which:
//
//   * token model  — `/rest/api/3/search/jql` only. Ask for a page, get a
//     `nextPageToken` back, hand it to the next request; there is no `startAt`
//     and no `total`. Driven here by {@link searchPages}.
//   * classic model — almost everything else (comments, worklogs, changelog,
//     project/status search, users, the whole Agile root):
//     `startAt` / `maxResults` / `total` / `isLast`. Driven here by
//     {@link fetchAll}, one page at a time by {@link fetchPage}.
//
// This module is deliberately endpoint-AGNOSTIC. It knows the shape of a LOOP,
// not the shape of an issue: the caller passes a `request` builder (which owns
// the path, the JQL, the field list, `safe: true` on the search POSTs) and a
// `readPage` narrowing function (which owns `issues` vs `values` vs `comments`
// and the runtime guard behind it). Endpoint knowledge lands in Wave 2
// (`api/search.ts`, `api/issues.ts`, `api/meta.ts`, `api/agile.ts`).
//
// Three properties every loop here guarantees:
//
//  1. **It terminates.** A hard page cap (`maxPages`, default
//     {@link DEFAULT_MAX_PAGES} = the documented `JIRA_MAX_PAGES`) bounds every
//     loop even when the server keeps handing out cursors. Hitting the cap is a
//     STOP REASON, not an exception — the pages already read are real data.
//  2. **It is budget-aware.** Between pages it re-checks the caller's
//     `AbortSignal` and the call-budget `deadlineAt`, and stops with the matching
//     {@link PageStopReason} rather than firing a request that cannot finish.
//     A failure of a request already in flight — an `AbortError`, a `JiraError`
//     — is never swallowed: it propagates untouched.
//  3. **It keeps token discipline.** A `nextPageToken` is one-time-use and bound
//     to the query that produced it (JIRA-API.md §Search, CC-01). The loop never
//     re-sends a token it has already spent, and refuses to send one alongside a
//     changed query — both are surfaced as a `JiraError`, never as duplicated or
//     silently short results.
//
// Nothing here reads the environment (the cap arrives as an option) or the host
// clock (time arrives as the injected {@link Clock}).
// ---------------------------------------------------------------------------

import {
  JiraError,
  type Clock,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
} from '../core/types.js';

// ---------------------------------------------------------------------------
// 1. Constants and the stop-reason contract
// ---------------------------------------------------------------------------

/**
 * Default hard page cap — the documented default of `JIRA_MAX_PAGES`
 * (CONFIGURATION.md §HTTP behaviour). It is duplicated here as a LITERAL and
 * never read from `process.env`: `core/settings.ts` owns the environment, and a
 * caller that has a `Settings`/`ToolLimits` in hand passes `maxPages` explicitly.
 */
export const DEFAULT_MAX_PAGES = 20;

/**
 * The wire name of the search cursor (JIRA-API.md §Search). It travels in the
 * query string on `GET /search/jql` and in the body on the `POST` form, so the
 * query-identity guard strips it from both.
 */
export const NEXT_PAGE_TOKEN_KEY = 'nextPageToken';

/**
 * Why a pagination loop stopped. Machine-stable: Wave-2 callers branch on it to
 * choose the hint they attach to the envelope (TOOLS.md §Hint catalog).
 *
 * - `exhausted`  — the server said there is no more data (`isLast`, no token, a
 *   short page, or `startAt` reached `total`). The result is COMPLETE; no hint.
 * - `max_pages`  — the `maxPages` guard tripped while more data existed. The
 *   result is partial: surface `truncated` and tell the model to narrow the
 *   query, and note that the resume cursor names a tail nobody has read.
 * - `aborted`    — the caller's `AbortSignal` was already aborted at a page
 *   boundary. The MCP request is going away; there is normally nobody left to
 *   hint at, but the pages read so far are returned rather than discarded.
 * - `budget`     — the call budget (`JIRA_CALL_BUDGET_MS`, carried as
 *   `deadlineAt`) expired at a page boundary. Partial, same handling as
 *   `max_pages`; the loop stops BEFORE issuing a request that `core/http.ts`
 *   would only reject with `kind=budget_exceeded`, which would have thrown the
 *   collected pages away.
 */
export type PageStopReason = 'exhausted' | 'max_pages' | 'aborted' | 'budget';

/** Fields both loop results share. */
export interface PageLoopResult<T> {
  /** Every item read, in page order. */
  readonly items: readonly T[];
  /** How many pages were actually fetched. */
  readonly pages: number;
  readonly stopReason: PageStopReason;
  /** `stopReason !== 'exhausted'` — precomputed so no caller re-derives it wrong. */
  readonly partial: boolean;
}

/** What {@link searchPages} returns. */
export interface TokenLoopResult<T> extends PageLoopResult<T> {
  /**
   * The unspent token the loop stopped in front of; present only when the result
   * is partial. It has never been sent, so it is still valid to resume with —
   * subject to the caveat in TOOLS.md that a TRUNCATED result must not be paged
   * on, because the tail the token names was never seen.
   */
  readonly nextPageToken?: string;
}

/** What {@link fetchAll} returns. */
export interface ClassicLoopResult<T> extends PageLoopResult<T> {
  /** The offset to resume from; present only when the result is partial. */
  readonly nextStartAt?: number;
  /** The server's `total`, when the endpoint reported one. */
  readonly total?: number;
}

// ---------------------------------------------------------------------------
// 2. Cursors, page views and the shared option shapes
// ---------------------------------------------------------------------------

/** What the token-model `request` builder is told about the page it must build. */
export interface TokenCursor {
  /** Zero-based index of the page about to be requested. */
  readonly page: number;
  /**
   * The cursor for this page. `undefined` on the first page of a fresh loop —
   * the builder then sends no token at all rather than `nextPageToken=undefined`.
   */
  readonly nextPageToken?: string;
}

/** The narrowed view of one token-model response. */
export interface TokenPage<T> {
  readonly items: readonly T[];
  /** Absent (or empty) means "no more pages". */
  readonly nextPageToken?: string;
  /** `true` ends the loop even if a token is still present. */
  readonly isLast?: boolean;
}

/** What the classic `request` builder is told about the page it must build. */
export interface ClassicCursor {
  /** Zero-based index of the page about to be requested. */
  readonly page: number;
  readonly startAt: number;
  readonly maxResults: number;
}

/** The narrowed view of one classic response. */
export interface ClassicPage<T> {
  readonly items: readonly T[];
  /** `true` ends the loop. */
  readonly isLast?: boolean;
  /** Total matching rows, when the endpoint reports one. */
  readonly total?: number;
  /** The offset the server echoed; falls back to the requested one. */
  readonly startAt?: number;
  /** The page size the server actually applied — it may cap the requested one. */
  readonly maxResults?: number;
}

/**
 * Deadline plumbing, expressed as a union so `deadlineAt` cannot arrive without
 * the {@link Clock} that gives it meaning. `Date.now()` is banned outside
 * `core/clock.ts` [eslint], so a budget check with no clock could only be a
 * silent no-op — the type makes that unrepresentable instead.
 */
export type BudgetGuard =
  | { readonly deadlineAt?: undefined; readonly clock?: Clock }
  | { readonly deadlineAt: number; readonly clock: Clock };

/** Loop controls stamped onto every outgoing request. */
interface LoopControls {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

// ---------------------------------------------------------------------------
// 3. Token pagination — `/rest/api/3/search/jql`
// ---------------------------------------------------------------------------

/** Options for {@link searchPages}. */
export type TokenPaginateOptions<T> = TokenPaginateBase<T> & BudgetGuard;

/** The non-budget half of {@link TokenPaginateOptions}. */
export interface TokenPaginateBase<T> {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Builds the request for one page. Owns path, JQL, fields and `safe: true`. */
  readonly request: (cursor: TokenCursor) => JiraRequestSpec;
  /** Narrows one raw response into items plus the cursor. Owns the runtime guard. */
  readonly readPage: (response: JiraResponse) => TokenPage<T>;
  /**
   * A token supplied by the CALLER (the model paging on from a previous tool
   * call). It is sent as-is on the first page: an expired one fails fast with
   * Jira's own 400, which is exactly CC-01's "no silent restart" rule.
   */
  readonly startToken?: string;
  /** Hard page cap; defaults to {@link DEFAULT_MAX_PAGES}. */
  readonly maxPages?: number;
  /** Cancellation from the MCP request; stamped onto every page request. */
  readonly signal?: AbortSignal;
}

/**
 * Walk the token-paginated search endpoint until it runs out of pages, the page
 * cap trips, the caller aborts or the call budget expires.
 *
 * The loop stops when the response says `isLast: true` OR carries no
 * `nextPageToken`. It never re-sends a token it has already spent, and never
 * sends a token next to a query that changed — see the module header.
 */
export async function searchPages<T>(
  options: TokenPaginateOptions<T>,
): Promise<TokenLoopResult<T>> {
  const maxPages = normalizePositiveInt(
    options.maxPages ?? DEFAULT_MAX_PAGES,
    'maxPages',
  );
  const items: T[] = [];
  const spent = new Set<string>();
  let identity: string | undefined;
  let token = normalizeToken(options.startToken);
  let pages = 0;

  for (;;) {
    const boundary = boundaryStop(options, options.signal);
    if (boundary !== undefined) return tokenResult(items, pages, boundary, token);
    if (pages >= maxPages) return tokenResult(items, pages, 'max_pages', token);

    if (token !== undefined) {
      if (spent.has(token)) {
        // A repeated cursor is either a Jira bug or a token we already burned;
        // sending it again would duplicate a page or spin forever. Both are
        // worse than failing loudly, and `max_pages` would misreport the cause.
        throw new JiraError({
          kind: 'unexpected_shape',
          message:
            'Jira handed back a nextPageToken that this search already used. ' +
            'Tokens are one-time-use, so the loop stopped instead of re-sending it. ' +
            'Re-run the search from the first page.',
          remediation:
            'Re-run the search without a nextPageToken; if it recurs, narrow the JQL.',
        });
      }
      spent.add(token);
    }

    const spec = withLoopControls(
      options.request({ page: pages, nextPageToken: token }),
      options,
    );
    const signature = queryIdentityOf(spec);
    if (identity === undefined) {
      identity = signature;
    } else if (signature !== identity) {
      // JIRA-API.md §Search: a token is invalidated when the JQL or the field
      // list changes. Sending it anyway earns a confusing 400 at best and a
      // wrong page at worst.
      throw new JiraError({
        kind: 'validation',
        message:
          'The paginated request changed between pages while carrying a ' +
          'nextPageToken. A search token is bound to the JQL and field list that ' +
          'produced it, so the loop refused to send it against a different query.',
        remediation:
          'Keep the request identical across pages, or start a new search without a token.',
      });
    }

    const page = options.readPage(await options.jira(spec));
    pages += 1;
    items.push(...page.items);

    const next = normalizeToken(page.nextPageToken);
    if (page.isLast === true || next === undefined) {
      return tokenResult(items, pages, 'exhausted', undefined);
    }
    token = next;
  }
}

// ---------------------------------------------------------------------------
// 4. Classic pagination — startAt / maxResults / total / isLast
// ---------------------------------------------------------------------------

/** The non-budget half of the classic option shapes. */
export interface ClassicBase<T> {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Builds the request for one page from the offset cursor. */
  readonly request: (cursor: ClassicCursor) => JiraRequestSpec;
  /** Narrows one raw response into items plus the paging fields. */
  readonly readPage: (response: JiraResponse) => ClassicPage<T>;
  /** Cancellation from the MCP request; stamped onto every page request. */
  readonly signal?: AbortSignal;
}

/** Options for {@link fetchPage}. */
export type ClassicPageOptions<T> = ClassicBase<T> & {
  /** Offset of the page to read; defaults to 0. */
  readonly startAt?: number;
  /** Page size to ask for. The server may return fewer, or cap it. */
  readonly maxResults: number;
} & BudgetGuard;

/** Options for {@link fetchAll}. */
export type ClassicPaginateOptions<T> = ClassicBase<T> & {
  /** Offset to start from; defaults to 0. */
  readonly startAt?: number;
  /** Page size for every request the loop makes. */
  readonly pageSize: number;
  /** Hard page cap; defaults to {@link DEFAULT_MAX_PAGES}. */
  readonly maxPages?: number;
} & BudgetGuard;

/**
 * Read exactly ONE classic page. The single-page path for tools that expose
 * `startAt`/`maxResults` to the model directly (comments, changelog, worklogs)
 * — no loop, therefore no stop reason. It still stamps `signal`/`deadlineAt`
 * onto the request, so a single page is cancelled and budgeted like a looped one.
 */
export async function fetchPage<T>(
  options: ClassicPageOptions<T>,
): Promise<ClassicPage<T>> {
  return requestClassicPage(options, {
    page: 0,
    startAt: options.startAt ?? 0,
    maxResults: options.maxResults,
  });
}

/**
 * Walk a classic offset-paginated endpoint until it is exhausted, the page cap
 * trips, the caller aborts or the call budget expires.
 *
 * "Exhausted" is any of: `isLast: true`, an empty page, a page shorter than the
 * size the server said it applied, or `startAt` reaching a reported `total`.
 * The empty-page rule is also the anti-spin guard — a server that keeps
 * answering zero rows can never advance the offset, so the loop must not treat
 * it as "keep going".
 */
export async function fetchAll<T>(
  options: ClassicPaginateOptions<T>,
): Promise<ClassicLoopResult<T>> {
  const maxPages = normalizePositiveInt(
    options.maxPages ?? DEFAULT_MAX_PAGES,
    'maxPages',
  );
  const pageSize = normalizePositiveInt(options.pageSize, 'pageSize');
  const items: T[] = [];
  let startAt = options.startAt ?? 0;
  let total: number | undefined;
  let pages = 0;

  for (;;) {
    const boundary = boundaryStop(options, options.signal);
    if (boundary !== undefined)
      return classicResult(items, pages, boundary, startAt, total);
    if (pages >= maxPages) {
      return classicResult(items, pages, 'max_pages', startAt, total);
    }

    const page = await requestClassicPage(options, {
      page: pages,
      startAt,
      maxResults: pageSize,
    });
    pages += 1;
    items.push(...page.items);
    if (total === undefined) total = page.total;

    // The server's own `maxResults` wins: it may silently cap the page size, and
    // comparing against the REQUESTED size would then read every full page as
    // short and stop after one.
    const applied = page.maxResults ?? pageSize;
    const read = page.items.length;
    startAt = (page.startAt ?? startAt) + read;

    const done =
      page.isLast === true ||
      read === 0 ||
      read < applied ||
      (total !== undefined && startAt >= total);
    if (done) return classicResult(items, pages, 'exhausted', startAt, total);
  }
}

async function requestClassicPage<T>(
  options: ClassicBase<T> & LoopControls,
  cursor: ClassicCursor,
): Promise<ClassicPage<T>> {
  const spec = withLoopControls(options.request(cursor), options);
  return options.readPage(await options.jira(spec));
}

// ---------------------------------------------------------------------------
// 5. Internals
// ---------------------------------------------------------------------------

/**
 * Whether the loop must stop BEFORE issuing another request. Abort wins over the
 * budget: an explicit cancellation is the more specific fact, and reporting
 * `budget` for a client that hung up would send the wrong hint.
 */
function boundaryStop(
  guard: BudgetGuard,
  signal: AbortSignal | undefined,
): 'aborted' | 'budget' | undefined {
  if (signal?.aborted === true) return 'aborted';
  if (guard.deadlineAt !== undefined && guard.clock.now() >= guard.deadlineAt) {
    return 'budget';
  }
  return undefined;
}

/**
 * Stamp the loop's cancellation and deadline onto a caller-built spec. A spec
 * that set its own keeps it — the builder is closer to the endpoint (a doctor
 * probe may want a tighter deadline) — but a builder that forgot still gets the
 * loop's, so cancellation cannot silently fail to reach the wire.
 */
function withLoopControls(
  spec: JiraRequestSpec,
  controls: LoopControls,
): JiraRequestSpec {
  const signal = spec.signal ?? controls.signal;
  const deadlineAt = spec.deadlineAt ?? controls.deadlineAt;
  if (signal === spec.signal && deadlineAt === spec.deadlineAt) return spec;
  return { ...spec, signal, deadlineAt };
}

/** An absent or empty token means "no cursor"; `''` must never go on the wire. */
function normalizeToken(token: string | undefined): string | undefined {
  if (token === undefined || token.length === 0) return undefined;
  return token;
}

/**
 * A page cap of 0 (or 2.5, or -1) is a configuration mistake, not a request to
 * fetch nothing: silently clamping it would turn a bad `JIRA_MAX_PAGES` into a
 * mysteriously empty result set.
 */
function normalizePositiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new JiraError({
      kind: 'config',
      message: `${name} must be an integer >= 1, received ${String(value)}.`,
      remediation:
        name === 'maxPages'
          ? 'Check JIRA_MAX_PAGES (CONFIGURATION.md); the documented default is 20.'
          : `Pass a positive integer ${name}.`,
    });
  }
  return value;
}

function tokenResult<T>(
  items: readonly T[],
  pages: number,
  stopReason: PageStopReason,
  nextPageToken: string | undefined,
): TokenLoopResult<T> {
  const partial = stopReason !== 'exhausted';
  return {
    items,
    pages,
    stopReason,
    partial,
    ...(partial && nextPageToken !== undefined ? { nextPageToken } : {}),
  };
}

function classicResult<T>(
  items: readonly T[],
  pages: number,
  stopReason: PageStopReason,
  nextStartAt: number,
  total: number | undefined,
): ClassicLoopResult<T> {
  const partial = stopReason !== 'exhausted';
  return {
    items,
    pages,
    stopReason,
    partial,
    ...(partial ? { nextStartAt } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

/**
 * A stable fingerprint of everything about a request EXCEPT its cursor: method,
 * root, path, query and body with `nextPageToken` removed. Two specs share a
 * fingerprint exactly when they are the same query asked at different offsets,
 * which is the condition a search token requires.
 */
function queryIdentityOf(spec: JiraRequestSpec): string {
  return stableStringify({
    method: spec.method,
    root: spec.root ?? 'v3',
    path: spec.path,
    query: omitKey(spec.query, NEXT_PAGE_TOKEN_KEY),
    body: omitKey(spec.body, NEXT_PAGE_TOKEN_KEY),
  });
}

/** Drop one key from a plain object; anything else passes through untouched. */
function omitKey(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k !== key) out[k] = v;
  }
  return out;
}

/**
 * JSON with object keys sorted, so two structurally equal requests fingerprint
 * identically regardless of key order. The depth cap keeps a pathological (or
 * cyclic) body from turning a fingerprint into a stack overflow — a request that
 * deep is not one this loop can meaningfully compare anyway.
 */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > 12) return '"[max-depth]"';
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, depth + 1)}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
