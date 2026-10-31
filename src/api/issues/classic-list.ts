// api/issues/classic-list.ts — the classic-pagination list reader (D517).

import type { JiraRequestSpec, JiraResponse } from '../../core/types.js';
import {
  budgetOf,
  fetchAll,
  type BudgetGuard,
  type ClassicCursor,
  type ClassicPage,
} from '../shared.js';
import { responseShapeError } from '../wire.js';
import { isUnknownArray, requireIssueRecord } from './errors.js';
import { issuePath, normalizePageSize, normalizeStartAt } from './input.js';
import { DEFAULT_LIST_MAX_PAGES } from './paths.js';
import type { ClassicListBase, ClassicListMeta } from './types.js';

// ---------------------------------------------------------------------------
// 10. Transport helpers
// ---------------------------------------------------------------------------

interface ClassicListSpec<T> {
  readonly defaultPageSize: number;
  /** Appended to `/issue/{id}` — already a literal, never caller data. */
  readonly suffix: string;
  readonly pathTemplate: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  /** The array key in the response body: `comments`, `worklogs`, `values`. */
  readonly collection: string;
  readonly map: (row: unknown) => T | undefined;
}

/**
 * Drive one classic (`startAt`/`maxResults`) collection under an issue.
 *
 * Always goes through {@link fetchAll} — even for the default single page — so
 * the stop-reason contract, the abort/budget boundary checks and the page cap
 * come from `api/shared.ts` rather than being re-derived per endpoint.
 */
export async function classicList<T>(
  options: ClassicListBase & BudgetGuard,
  spec: ClassicListSpec<T>,
): Promise<{ items: readonly T[]; meta: ClassicListMeta }> {
  const startAt = normalizeStartAt(options.startAt);
  const pageSize = normalizePageSize(options.maxResults ?? spec.defaultPageSize);
  const path = issuePath(options.issue, spec.suffix);

  // The offset the page in flight asked for; `readPage` needs it to tell a
  // server that ignored the window from one that honoured it (CC-900).
  let asked = startAt;
  const request = (cursor: ClassicCursor): JiraRequestSpec => {
    asked = cursor.startAt;
    return {
      method: 'GET',
      path,
      pathTemplate: spec.pathTemplate,
      query: {
        startAt: cursor.startAt,
        maxResults: cursor.maxResults,
        ...(spec.query ?? {}),
      },
    };
  };

  const readPage = (response: JiraResponse): ClassicPage<T> => {
    const data = requireIssueRecord(response.data, spec.collection);
    const sent = data[spec.collection] ?? [];
    if (!isUnknownArray(sent)) {
      throw responseShapeError(
        'issue',
        `"${spec.collection}" is present but is not an array`,
      );
    }
    // A server that ignores `startAt`/`maxResults` (Data Center's worklog route
    // answers every worklog from offset 0) echoes a lower `startAt` or sends
    // more rows than asked. Its rows are cut to the window asked for, so a
    // resumed read never returns the first page again under a later offset
    // (CC-900). UNVERIFIED on a live Data Center host; Cloud honours the window.
    const echoed = typeof data.startAt === 'number' ? data.startAt : asked;
    const skip = echoed < asked ? asked - echoed : 0;
    const ignored = skip > 0 || sent.length > pageSize;
    const rows = ignored ? sent.slice(skip, skip + pageSize) : sent;
    const items: T[] = [];
    for (const row of rows) {
      const mapped = spec.map(row);
      if (mapped !== undefined) items.push(mapped);
    }
    return {
      items,
      ...(items.length === rows.length ? {} : { scanned: rows.length }),
      ...(typeof data.isLast === 'boolean' && !ignored ? { isLast: data.isLast } : {}),
      ...(typeof data.total === 'number' ? { total: data.total } : {}),
      ...(ignored
        ? { startAt: asked, maxResults: pageSize }
        : {
            ...(typeof data.startAt === 'number' ? { startAt: data.startAt } : {}),
            ...(typeof data.maxResults === 'number'
              ? { maxResults: data.maxResults }
              : {}),
          }),
    };
  };

  const base = {
    jira: options.jira,
    request,
    readPage,
    startAt,
    pageSize,
    maxPages: options.maxPages ?? DEFAULT_LIST_MAX_PAGES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const loop = await fetchAll<T>({ ...base, ...budgetOf(options) });

  return {
    items: loop.items,
    meta: {
      pages: loop.pages,
      stopReason: loop.stopReason,
      partial: loop.partial,
      startAt,
      maxResults: pageSize,
      ...(loop.total === undefined ? {} : { total: loop.total }),
      ...(loop.nextStartAt === undefined ? {} : { nextStartAt: loop.nextStartAt }),
    },
  };
}
