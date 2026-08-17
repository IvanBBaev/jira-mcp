// ---------------------------------------------------------------------------
// Recently written issues — CC-02 (`recentlyWrittenIssueIds`).
//
// Jira's search index is eventually consistent: an issue created or updated a
// moment ago can be missing from the very next `jira_search`. `/search/jql`
// takes `reconcileIssues`, a list of NUMERIC issue ids it refreshes before
// answering — and until now the only way to fill it was for the caller to
// remember the ids itself. This module is the server's own memory: the ids of
// issues its APPLIED writes touched, so a search that named none still
// reconciles the writes this session performed (`tools/search.ts`).
//
// WHY THERE IS AN AMBIENT INSTANCE. The record side is injectable —
// `buildServer` takes a {@link RecentWrites} and the gate decorator around it
// writes there. The READ side is not: a tool handler sees only `ToolCtx`, a
// frozen contract (`mcp/types.ts`) with no seam for this, and `searchPackage` is
// a plain const that `tools/index.ts` re-exports, so there is no factory to
// thread a dependency through either. {@link sessionRecentWrites} is what makes
// the read side reachable without touching either contract; `buildServer`
// defaults to it, and a test injects its own instance instead. Two servers in
// ONE process would share the ambient registry — irrelevant for the stdio
// server (one process, one server), stated here so it is not a surprise.
//
// The registry is IN-MEMORY and SESSION-SCOPED: it dies with the process, like
// the plan ids of the write gate. Nothing here is persisted, and nothing here is
// a fact about Jira — a stale id costs at most one wasted reconcile.
//
// Layering: `mcp` ring, no imports beyond a type. Only `core/http.ts` talks to
// the network and nothing here does any I/O.
// ---------------------------------------------------------------------------

import type { ToolResult } from './types.js';

/**
 * How many ids the registry keeps — the same cap `/search/jql` puts on
 * `reconcileIssues` (`MAX_RECONCILE_ISSUES`, api/search.ts).
 *
 * The bound is what makes the read side safe: `api/search.ts` REFUSES a
 * reconcile list longer than this with a `validation` error, so an unbounded
 * registry would eventually break every search that passes it. Fifty writes deep
 * is also well past the point where the index has caught up.
 */
export const MAX_RECENT_WRITES = 50;

/**
 * The session's memory of written issue ids.
 *
 * `record` is total and silent: ids that are not numeric never get here (see
 * {@link writtenIssueIds}), and a duplicate is a no-op that only refreshes the
 * id's position.
 */
export interface RecentWrites {
  /** Remember these ids as just written. Non-numeric input is ignored. */
  record(ids: readonly string[]): void;
  /**
   * The remembered ids, oldest first, at most {@link MAX_RECENT_WRITES}. A fresh
   * array every call — the caller may hand it to `api/search.ts` unguarded.
   */
  snapshot(): readonly string[];
  /** Forget everything. For tests and for the ambient instance between them. */
  clear(): void;
}

/** Digits only — `reconcileIssues` takes issue IDS, never keys (`PROJ-1`). */
const NUMERIC_ID = /^\d+$/;

/**
 * A bounded, de-duplicated, insertion-ordered registry.
 *
 * Re-recording an id MOVES it to the end rather than leaving it where it was: a
 * second write to the same issue is newer evidence that the index needs to
 * reconcile it, and it should outlive the ids written before it. When the cap is
 * exceeded the OLDEST id is dropped, because it is the one most likely to have
 * been indexed already.
 */
export function createRecentWrites(max: number = MAX_RECENT_WRITES): RecentWrites {
  // A Set iterates in insertion order, which is the whole data structure here.
  const ids = new Set<string>();

  return {
    record(incoming: readonly string[]): void {
      for (const id of incoming) {
        if (!NUMERIC_ID.test(id)) continue;
        ids.delete(id);
        ids.add(id);
      }
      while (ids.size > max) {
        const [oldest] = ids;
        if (oldest === undefined) break;
        ids.delete(oldest);
      }
    },

    snapshot(): readonly string[] {
      return [...ids];
    },

    clear(): void {
      ids.clear();
    },
  };
}

/**
 * The process-wide registry the search tool reads and `buildServer` writes to by
 * default. See the module header for why the read side cannot be injected.
 */
export const sessionRecentWrites: RecentWrites = createRecentWrites();

/** The value at `field`, if it is a numeric id spelled as a string or a number. */
function numericId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return NUMERIC_ID.test(text) ? text : undefined;
}

/**
 * The issue ids one completed write call touched — numeric ids ONLY.
 *
 * Deliberately narrow, because a wrong id here is worse than a missing one: it
 * would make every later search reconcile an issue that has nothing to do with
 * this session, and `api/search.ts` refuses the whole list if one entry is not
 * numeric. Two sources qualify:
 *
 * - THE ARGUMENTS. `issue`, `inwardIssue`, `outwardIssue` and the `issues` batch
 *   of `jira_move_to_sprint` all name the issue the caller asked for. They accept
 *   a KEY as well as an id ("Issue key (PROJ-123) or numeric issue id"), and a
 *   key is silently skipped — resolving it would need a request, and this helper
 *   runs after the write, where a lookup could only fail or lie.
 * - THE RESULT. `id` is taken only when the data also carries an issue `key`,
 *   which is exactly the created-issue shape (`CreatedIssue`) — the one case
 *   where the id did not exist before the call. That guard is load-bearing: a
 *   comment and a worklog also come back with an `id`, and theirs is a COMMENT
 *   id, not an issue's. A worklog's own `issueId` is taken, since it names what
 *   it is.
 *
 * Callers that only ever wrote by key therefore record nothing, and CC-02
 * reconciliation for them stays what it always was: caller-supplied ids.
 */
export function writtenIssueIds(
  args: Record<string, unknown>,
  result?: ToolResult<unknown>,
): readonly string[] {
  const found: string[] = [];
  const take = (value: unknown): void => {
    const id = numericId(value);
    if (id !== undefined) found.push(id);
  };

  for (const field of ['issue', 'inwardIssue', 'outwardIssue']) take(args[field]);
  const batch: unknown = args['issues'];
  if (Array.isArray(batch)) for (const entry of batch) take(entry);

  const data: unknown = result?.data;
  if (data !== null && typeof data === 'object') {
    const record = data as { id?: unknown; key?: unknown; issueId?: unknown };
    if (typeof record.key === 'string' && record.key !== '') take(record.id);
    take(record.issueId);
  }

  return found;
}
