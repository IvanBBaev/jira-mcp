// ---------------------------------------------------------------------------
// api/users.ts — the authenticated identity and user lookup (WP-20).
//
// Two calls, one privacy rule and one decision behind them:
//
//  1. **`GET /rest/api/3/myself`** — who the credentials belong to. Also the
//     source of the worklog `started` offset (D16): the site's calendar, not the
//     host's, so `timeZone` is carried through here rather than dropped as
//     noise. `api/worklogs.ts` caches it per process; this module just reads.
//  2. **User search** — the ONLY path from a human name to an `accountId`. Cloud
//     is GDPR-mode: there are no usernames and no user keys (JIRA-API.md
//     §Users), so every other tool takes an `accountId` and something has to
//     produce it. O-5 folds "who can this be assigned to" into the SAME
//     function as an input (`project` / `issueKey`) instead of a second tool —
//     it switches the endpoint to `/user/assignable/search`, nothing else.
//
// The privacy rule (CC-19): a tenant may mask `emailAddress`, and a masked
// record is a NORMAL result, never an error. The api ring reports the fact as
// `emailHidden` and passes an email through only when Jira actually sent one;
// deciding whether the model is allowed to see it (`includeEmail`, TOOLS.md
// §Read shaping / THREAT-MODEL.md §PII) is the tool ring's call, not this one's.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import type {
  JiraError,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  QueryParams,
} from '../core/types.js';
import {
  fetchAll,
  type BudgetGuard,
  type ClassicCursor,
  type ClassicPage,
  type PageStopReason,
} from './shared.js';

// ---------------------------------------------------------------------------
// 1. Wire constants and caps
// ---------------------------------------------------------------------------

/** `GET /rest/api/3/myself` — relative to the `v3` root. */
export const MYSELF_PATH = '/myself';

/** `GET /rest/api/3/user/search` — the plain name/email lookup. */
export const USER_SEARCH_PATH = '/user/search';

/** `GET /rest/api/3/user/assignable/search` — the O-5 variant. */
export const ASSIGNABLE_USER_SEARCH_PATH = '/user/assignable/search';

/** Page size used when the caller names none. Jira's own default is 50 too. */
export const DEFAULT_USER_SEARCH_MAX_RESULTS = 50;

/**
 * Cap on the page size. The endpoint allows 1000; a thousand user records is a
 * context-window bill nobody asked for, and a name lookup that needs more than
 * a hundred candidates needs a better query, not a bigger page.
 */
export const MAX_USER_SEARCH_RESULTS = 100;

/**
 * Default page cap: ONE page. A name lookup is answered by the first page or
 * by a better query; a caller that wants a roster passes `maxPages`.
 */
export const DEFAULT_USER_SEARCH_MAX_PAGES = 1;

// ---------------------------------------------------------------------------
// 2. Public shapes
// ---------------------------------------------------------------------------

/**
 * A user as Jira returned it, narrowed to the fields anything downstream reads.
 *
 * `accountId` is the only guaranteed field — it is the identity in GDPR mode.
 * `displayName` is optional on purpose: Jira's schema always sends one, but
 * privacy settings and anonymized accounts can blank it, and inventing a
 * placeholder here would hide that from the tool ring. `emailAddress` is
 * present only when the tenant actually disclosed it (CC-19).
 */
export interface JiraUser {
  readonly accountId: string;
  readonly displayName?: string;
  readonly active?: boolean;
  /** `atlassian` | `app` | `customer` — an `app` row is a bot, not a human. */
  readonly accountType?: string;
  readonly emailAddress?: string;
  /** IANA zone, e.g. `Australia/Sydney`. Populated by `/myself` (D16). */
  readonly timeZone?: string;
  readonly locale?: string;
}

/** The non-budget half of {@link GetMyselfOptions}. */
export interface GetMyselfBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request. */
  readonly signal?: AbortSignal;
}

/** Options for {@link getMyself}. */
export type GetMyselfOptions = GetMyselfBase & BudgetGuard;

/** What {@link getMyself} returns. */
export interface MyselfResult {
  /** The authenticated identity, including `timeZone` when the site reports one. */
  readonly user: JiraUser;
  /** CC-19 — the tenant disclosed no email address for the caller's own account. */
  readonly emailHidden: boolean;
}

/**
 * Which endpoint answered a {@link searchUsers} call: `query` is the plain
 * name/email lookup, `assignable` the O-5 "who can this be assigned to" variant.
 */
export type UserSearchScope = 'query' | 'assignable';

/** The non-budget half of {@link SearchUsersOptions}. */
export interface SearchUsersBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Name or email fragment to match. Required — Jira rejects a blank lookup. */
  readonly query: string;
  /**
   * O-5 — restrict to users assignable to issues in this project (id or key).
   * Switches the call to {@link ASSIGNABLE_USER_SEARCH_PATH}.
   */
  readonly project?: string;
  /**
   * O-5 — restrict to users assignable to this specific issue. Switches the
   * call to {@link ASSIGNABLE_USER_SEARCH_PATH} and WINS over `project`: an
   * issue's assignable set is the narrower, more specific question, and sending
   * both leaves the choice to undocumented server behaviour.
   */
  readonly issueKey?: string;
  /** Page size; clamped to {@link MAX_USER_SEARCH_RESULTS}. */
  readonly maxResults?: number;
  /** Offset of the first page; defaults to 0. */
  readonly startAt?: number;
  /** Page cap; defaults to {@link DEFAULT_USER_SEARCH_MAX_PAGES}. */
  readonly maxPages?: number;
  /** Cancellation from the MCP request. */
  readonly signal?: AbortSignal;
}

/** Options for {@link searchUsers}. */
export type SearchUsersOptions = SearchUsersBase & BudgetGuard;

/** What {@link searchUsers} returns: rows plus everything a hint is derived from. */
export interface SearchUsersResult {
  readonly users: readonly JiraUser[];
  /** Which endpoint answered (O-5). */
  readonly scope: UserSearchScope;
  /** How many pages were actually read. */
  readonly pages: number;
  /** The page cap actually applied — see {@link SearchUsersResult.stopReason}. */
  readonly maxPages: number;
  /**
   * Why the loop stopped. With the default cap of one page, `max_pages` means
   * "there are more matches", not "the answer was cut short".
   */
  readonly stopReason: PageStopReason;
  /** `stopReason !== 'exhausted'`. */
  readonly partial: boolean;
  /** The offset to resume from; present only when the result is partial. */
  readonly nextStartAt?: number;
  /** The page size actually sent, after clamping. */
  readonly maxResults: number;
  /** The requested page size exceeded the cap and was clamped. */
  readonly clamped: boolean;
  /**
   * CC-19 — at least one returned record carried no email address, so an
   * `includeEmail: true` caller must be told the value is unavailable rather
   * than missing by error. `false` for an empty result: nothing was hidden.
   */
  readonly emailHidden: boolean;
}

// ---------------------------------------------------------------------------
// 3. Identity
// ---------------------------------------------------------------------------

/**
 * Read the authenticated user (`GET /rest/api/3/myself`).
 *
 * Doubles as the credential probe used by the doctor CLI (AUTH.md §Doctor) and
 * as the worklog offset source (D16) — which is why `timeZone` survives the
 * narrowing even though no tool prints it directly.
 */
export async function getMyself(options: GetMyselfOptions): Promise<MyselfResult> {
  const response = await options.jira({
    method: 'GET',
    path: MYSELF_PATH,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });

  const user = toJiraUser(response.data, `${MYSELF_PATH} response`);
  return { user, emailHidden: user.emailAddress === undefined };
}

// ---------------------------------------------------------------------------
// 4. User search (plain + assignable, O-5)
// ---------------------------------------------------------------------------

/**
 * Resolve a human name or email fragment to `accountId`s.
 *
 * Passing `issueKey` or `project` switches to the assignable-user endpoint
 * (O-5) — same inputs, same output shape, narrower candidate set. Both
 * endpoints answer with a bare JSON array and no `total`/`isLast`, so the
 * classic loop's "a short page ends it" rule is what terminates the sweep.
 */
export async function searchUsers(
  options: SearchUsersOptions,
): Promise<SearchUsersResult> {
  const query = requireQuery(options.query);
  const maxResults = resolveMaxResults(options.maxResults);
  const scope: UserSearchScope =
    options.issueKey !== undefined || options.project !== undefined
      ? 'assignable'
      : 'query';
  const maxPages = options.maxPages ?? DEFAULT_USER_SEARCH_MAX_PAGES;
  const path = scope === 'assignable' ? ASSIGNABLE_USER_SEARCH_PATH : USER_SEARCH_PATH;
  const scopeQuery = assignableScopeQuery(options);

  const request = (cursor: ClassicCursor): JiraRequestSpec => ({
    method: 'GET',
    path,
    query: {
      query,
      ...scopeQuery,
      startAt: cursor.startAt,
      maxResults: cursor.maxResults,
    },
  });

  const loop = await fetchAll<JiraUser>({
    jira: options.jira,
    request,
    readPage: (response) => readUserPage(response, path),
    pageSize: maxResults.value,
    maxPages,
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...budgetOf(options),
  });

  return {
    users: loop.items,
    scope,
    pages: loop.pages,
    maxPages,
    stopReason: loop.stopReason,
    partial: loop.partial,
    ...(loop.nextStartAt === undefined ? {} : { nextStartAt: loop.nextStartAt }),
    maxResults: maxResults.value,
    clamped: maxResults.clamped,
    emailHidden: loop.items.some((user) => user.emailAddress === undefined),
  };
}

/**
 * The scope parameter for the assignable endpoint. `issueKey` wins over
 * `project` (see {@link SearchUsersBase.issueKey}); an empty object means the
 * plain lookup, which takes neither.
 */
function assignableScopeQuery(options: SearchUsersBase): QueryParams {
  const issueKey = trimmed(options.issueKey);
  if (issueKey !== undefined) return { issueKey };
  const project = trimmed(options.project);
  if (project !== undefined) return { project };
  return {};
}

// ---------------------------------------------------------------------------
// 5. Response narrowing
// ---------------------------------------------------------------------------

/**
 * Narrow one user-search page. Both endpoints answer with a BARE array — there
 * is no envelope, so `total`, `isLast` and the echoed `startAt` are all absent
 * and the loop relies on a short page to stop.
 */
function readUserPage(response: JiraResponse, path: string): ClassicPage<JiraUser> {
  const rows = response.data;
  if (!Array.isArray(rows)) {
    throw shapeError(`${path} did not return a JSON array of users`);
  }
  return {
    items: rows.map((row, index) => toJiraUser(row, `user at position ${index}`)),
  };
}

/** Narrow one user record. `accountId` is the identity; everything else is optional. */
function toJiraUser(row: unknown, what: string): JiraUser {
  if (!isRecord(row)) {
    throw shapeError(`${what} is not a JSON object`);
  }
  const accountId = row['accountId'];
  if (typeof accountId !== 'string' || accountId === '') {
    throw shapeError(`${what} has no string "accountId"`);
  }
  return {
    accountId,
    ...optionalString(row, 'displayName'),
    ...(typeof row['active'] === 'boolean' ? { active: row['active'] } : {}),
    ...optionalString(row, 'accountType'),
    // CC-19: a masked email arrives as an absent key or an empty string. Both
    // mean "the tenant will not disclose it" — never an error, just an omission.
    ...optionalString(row, 'emailAddress'),
    ...optionalString(row, 'timeZone'),
    ...optionalString(row, 'locale'),
  };
}

// ---------------------------------------------------------------------------
// 6. Input normalization
// ---------------------------------------------------------------------------

function requireQuery(query: string): string {
  const value = query.trim();
  if (value === '') {
    throw createJiraError({
      kind: 'validation',
      reason: 'A user search needs a non-empty query.',
      remediation:
        'Pass part of the display name or email address to match, e.g. query: "ivan".',
    });
  }
  return value;
}

function resolveMaxResults(requested: number | undefined): {
  readonly value: number;
  readonly clamped: boolean;
} {
  if (requested === undefined) {
    return { value: DEFAULT_USER_SEARCH_MAX_RESULTS, clamped: false };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    throw createJiraError({
      kind: 'validation',
      reason: `maxResults must be a whole number of at least 1, received ${String(requested)}.`,
      remediation: `Pass maxResults between 1 and ${String(MAX_USER_SEARCH_RESULTS)}, or omit it for ${String(DEFAULT_USER_SEARCH_MAX_RESULTS)}.`,
    });
  }
  return requested > MAX_USER_SEARCH_RESULTS
    ? { value: MAX_USER_SEARCH_RESULTS, clamped: true }
    : { value: requested, clamped: false };
}

/**
 * Re-express the budget half of the options as the {@link BudgetGuard} union, so
 * `deadlineAt` and `clock` stay welded together across the spread.
 */
function budgetOf(guard: BudgetGuard): BudgetGuard {
  return guard.deadlineAt === undefined
    ? { ...(guard.clock === undefined ? {} : { clock: guard.clock }) }
    : { deadlineAt: guard.deadlineAt, clock: guard.clock };
}

// ---------------------------------------------------------------------------
// 7. Small shared helpers
// ---------------------------------------------------------------------------

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** `{ key: value }` when the record carries a non-empty string there, else `{}`. */
function optionalString(
  row: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeError(what: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason: `Jira's user response could not be read: ${what}.`,
  });
}
