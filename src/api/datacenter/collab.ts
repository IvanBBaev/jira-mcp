// ---------------------------------------------------------------------------
// api/datacenter/collab.ts — the component, version and watcher twins on Jira Data Center
// (D106, D111): the documented array routes paged client-side, and the
// watcher writes that take a username.
//
// Moved out of `api/collab.ts` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { createJiraError } from '../../core/errors.js';
import {
  COLLAB_PAGE_SIZE,
  type CollabBase,
  collabCall,
  type CollabPagedBase,
  issuePath,
  type ListComponentsOptions,
  type ListVersionsOptions,
  mapComponent,
  mapVersion,
  pathSegment,
  PROJECT_READ_HINT,
  PROJECT_REMEDIATION,
  type ProjectComponent,
  type ProjectVersion,
  trimmed,
  USERNAME_REMEDIATION,
  type VersionStatus,
  WATCH_WRITE_HINT,
  type WatcherChange,
  type WatcherOptions,
  WATCHERS_PATH_TEMPLATE,
} from '../collab.js';
import {
  type BudgetGuard,
  type ClassicLoopResult,
  DEFAULT_MAX_PAGES,
} from '../shared.js';
import { refuseAccountIdOnDataCenter } from '../users.js';
import {
  requireRecord,
  requireWriteText,
  sendOne,
  SHAPE_REMEDIATION,
  shapeError,
  writeControls,
} from '../wire.js';

/**
 * One complete, unpaginated read, windowed client-side and reported in the
 * classic loop's own terms: `startAt` and `pageSize × maxPages` cut the
 * matched rows the way Cloud's paged route would (CC-490, as CC-352 does for
 * the favourite filters).
 */
function windowedList<T>(
  matched: readonly T[],
  options: CollabPagedBase,
): ClassicLoopResult<T> {
  const startAt = options.startAt ?? 0;
  const window =
    (options.pageSize ?? COLLAB_PAGE_SIZE) * (options.maxPages ?? DEFAULT_MAX_PAGES);
  const end = startAt + window;
  const more = end < matched.length;
  return {
    items: matched.slice(startAt, end),
    pages: 1,
    stopReason: more ? 'max_pages' : 'exhausted',
    partial: more,
    total: matched.length,
    ...(more ? { nextStartAt: end } : {}),
  };
}

/** Case-insensitive substring over a row's name and description. */
function matchesQuery(
  row: { readonly name: string; readonly description?: string },
  query: string | undefined,
): boolean {
  const needle = trimmed(query)?.toLowerCase();
  if (needle === undefined) return true;
  return (
    row.name.toLowerCase().includes(needle) ||
    (row.description?.toLowerCase().includes(needle) ?? false)
  );
}

/** A Data Center list endpoint's bare array, or `unexpected_shape`. */
async function dataCenterArray(
  options: CollabBase & BudgetGuard,
  path: string,
  pathTemplate: string,
  what: string,
): Promise<readonly Record<string, unknown>[]> {
  const response = await collabCall(PROJECT_READ_HINT, () =>
    sendOne(options, { method: 'GET', root: 'v2', path, pathTemplate }),
  );
  if (!Array.isArray(response.data)) {
    throw shapeError(
      `GET ${pathTemplate} answered with something other than a JSON array of ${what}s.`,
      SHAPE_REMEDIATION,
    );
  }
  return response.data.map((entry, index) =>
    requireRecord(entry, `${what} #${String(index)}`),
  );
}

/**
 * {@link listComponents} on Jira Data Center — `GET /rest/api/2/project/{p}/components`.
 *
 * The paginated `/component` route is not relied on for Data Center; the
 * documented `/components` array is, and `query` is applied here over name and
 * description — what Cloud's server-side `query` matches. One request, paged
 * client-side.
 */
export async function listComponentsDataCenter(
  options: ListComponentsOptions,
): Promise<ClassicLoopResult<ProjectComponent>> {
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  const rows = await dataCenterArray(
    options,
    `/project/${project}/components`,
    '/project/{projectIdOrKey}/components',
    'component',
  );
  return windowedList(
    rows
      .map((row) => mapComponent(row, 'datacenter'))
      .filter((component) => matchesQuery(component, options.query)),
    options,
  );
}

/** A Data Center version's lifecycle state, in {@link VERSION_STATUSES}' words. */
function versionStatus(version: ProjectVersion): VersionStatus {
  if (version.archived === true) return 'archived';
  return version.released === true ? 'released' : 'unreleased';
}

/**
 * {@link listVersions} on Jira Data Center — `GET /rest/api/2/project/{p}/versions`.
 *
 * The documented array route; `query` (name and description) and `status`
 * (archived wins over released, as Jira's own lifecycle has it) are applied
 * here. One request, paged client-side.
 */
export async function listVersionsDataCenter(
  options: ListVersionsOptions,
): Promise<ClassicLoopResult<ProjectVersion>> {
  if (options.issueCounts === true) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'Per-version issue counts are a Jira Cloud read (expand=issuesstatus); this ' +
        'Data Center adapter does not offer them. Nothing was sent.',
      remediation:
        'Drop issueCounts, or count one version with jira_search and ' +
        'JQL fixVersion = <id>.',
    });
  }
  const project = pathSegment(options.project, 'project key or id', PROJECT_REMEDIATION);
  const rows = await dataCenterArray(
    options,
    `/project/${project}/versions`,
    '/project/{projectIdOrKey}/versions',
    'version',
  );
  const statuses = options.status;
  return windowedList(
    rows
      .map((row) => mapVersion(row))
      .filter(
        (version) =>
          matchesQuery(version, options.query) &&
          (statuses === undefined ||
            statuses.length === 0 ||
            statuses.includes(versionStatus(version))),
      ),
    options,
  );
}

/**
 * {@link addWatcher} on Jira Data Center (D111) —
 * `POST /rest/api/2/issue/{issueIdOrKey}/watchers` with the USERNAME as the bare
 * JSON string body, the same idiom Cloud uses for the accountId. UNVERIFIED.
 */
export async function addWatcherDataCenter(
  options: WatcherOptions,
): Promise<WatcherChange> {
  const issue = issuePath(options.issue, '/watchers');
  const username = dataCenterWatcher(options);
  const response = await collabCall(WATCH_WRITE_HINT, () =>
    options.jira({
      method: 'POST',
      root: 'v2',
      path: issue,
      pathTemplate: WATCHERS_PATH_TEMPLATE,
      body: username,
      ...writeControls(options),
    }),
  );
  return { issue: options.issue, username, status: response.status };
}

/**
 * {@link removeWatcher} on Jira Data Center (D111) —
 * `DELETE /rest/api/2/issue/{issueIdOrKey}/watchers?username=…`: the user
 * travels as a query parameter, as on Cloud, under Data Center's name for it.
 * UNVERIFIED.
 */
export async function removeWatcherDataCenter(
  options: WatcherOptions,
): Promise<WatcherChange> {
  const issue = issuePath(options.issue, '/watchers');
  const username = dataCenterWatcher(options);
  const response = await collabCall(WATCH_WRITE_HINT, () =>
    options.jira({
      method: 'DELETE',
      root: 'v2',
      path: issue,
      pathTemplate: WATCHERS_PATH_TEMPLATE,
      query: { username },
      ...writeControls(options),
    }),
  );
  return { issue: options.issue, username, status: response.status };
}

/** The Data Center watcher: a username, and never an accountId (D111). */
function dataCenterWatcher(options: WatcherOptions): string {
  refuseAccountIdOnDataCenter(options.accountId);
  return requireWriteText(options.username ?? '', 'username', USERNAME_REMEDIATION);
}
