// ---------------------------------------------------------------------------
// api/datacenter/filters.ts — the saved-filter reads on Jira Data Center (D115, UNVERIFIED):
// the caller's favourites, filtered and paged client-side, and one filter by id.
//
// Moved out of `api/filters.ts` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { createJiraError } from '../../core/errors.js';
import {
  FILTER_PAGE_SIZE,
  FILTER_PATH_TEMPLATE,
  filterId,
  type FilterSearchResult,
  type GetFilterOptions,
  mapFilter,
  type SavedFilter,
  type SearchFiltersOptions,
  trimmed,
} from '../filters.js';
import { DEFAULT_MAX_PAGES } from '../shared.js';
import { requireRecord, sendOne, SHAPE_REMEDIATION, shapeError } from '../wire.js';

/** The Data Center list route: the caller's favourite filters, one array. */
export const FILTER_FAVOURITE_PATH = '/filter/favourite';

/** Why a Data Center filter list is not Cloud's "every filter you can see". */
export const DATACENTER_FILTER_SCOPE_NOTE =
  'SCOPE: on Jira Data Center this lists only YOUR FAVOURITE filters ' +
  '(GET /rest/api/2/filter/favourite) — Data Center has no stable route that ' +
  'searches every filter you can see. A filter you know exists but that is not ' +
  'here can still be read with jira_get_filter by its numeric id; favouriting ' +
  'it in Jira adds it to this list. filterName and paging are applied by this ' +
  'server to that list.';

/**
 * Search saved filters on Jira Data Center — `GET /rest/api/2/filter/favourite`.
 *
 * Cloud's `/filter/search` is not a Data Center route this server relies on
 * (D115), so the list is the caller's favourites, read in ONE request (the
 * route is documented as an unpaged array). Every Cloud argument is accounted
 * for before or after that request, none is dropped silently:
 *
 *   * `accountId` — refused as `validation` BEFORE any request: Data Center
 *     has no accountIds, and the favourites route cannot be narrowed by owner.
 *   * `filterName` — applied here, as a case-insensitive substring of the
 *     name; blank means "no filter", exactly as on Cloud.
 *   * `startAt` / `pageSize` / `maxPages` — applied here, as a slice of the
 *     filtered list, with Cloud's `partial`/`nextStartAt` semantics.
 *
 * The result carries {@link DATACENTER_FILTER_SCOPE_NOTE} as `scope`, so the
 * list cannot be mistaken for Cloud's "every filter you can see".
 */
export async function searchFiltersDataCenter(
  options: SearchFiltersOptions,
): Promise<FilterSearchResult> {
  if (options.accountId !== undefined) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'accountId is a Jira Cloud identifier; Jira Data Center has no accountIds, ' +
        'and its filter list (your favourite filters) cannot be narrowed by owner. ' +
        'Nothing was sent.',
      remediation:
        "Drop accountId. Each returned filter's owner.name says whose it is; narrow " +
        'with filterName instead.',
    });
  }
  const response = await sendOne(options, {
    method: 'GET',
    root: 'v2',
    path: FILTER_FAVOURITE_PATH,
  });
  if (!Array.isArray(response.data)) {
    throw shapeError(
      'The Data Center favourite-filter list is not a JSON array.',
      SHAPE_REMEDIATION,
    );
  }
  const rows: unknown[] = response.data;
  const all = rows.map((row, index) =>
    mapFilter(requireRecord(row, `favourite filter row #${index}`), 'datacenter'),
  );
  const needle = trimmed(options.filterName)?.toLowerCase();
  const matched =
    needle === undefined
      ? all
      : all.filter((filter) => filter.name.toLowerCase().includes(needle));

  const startAt = options.startAt ?? 0;
  const window =
    (options.pageSize ?? FILTER_PAGE_SIZE) * (options.maxPages ?? DEFAULT_MAX_PAGES);
  const end = startAt + window;
  const more = end < matched.length;
  return {
    items: matched.slice(startAt, end),
    pages: 1,
    stopReason: more ? 'max_pages' : 'exhausted',
    partial: more,
    total: matched.length,
    ...(more ? { nextStartAt: end } : {}),
    scope: { source: 'favourites', note: DATACENTER_FILTER_SCOPE_NOTE },
  };
}

/**
 * Read one saved filter on Jira Data Center — `GET /rest/api/2/filter/{id}`.
 * The same id validation (D22) and the same allowlist as Cloud; the owner is
 * the Data Center user projection, so an owner carrying an accountId is
 * dropped rather than reported (D115).
 */
export async function getFilterDataCenter(
  options: GetFilterOptions,
): Promise<SavedFilter> {
  const id = filterId(options.filterId);
  const response = await sendOne(options, {
    method: 'GET',
    root: 'v2',
    path: `/filter/${id}`,
    pathTemplate: FILTER_PATH_TEMPLATE,
  });
  return mapFilter(requireRecord(response.data, 'filter'), 'datacenter');
}
