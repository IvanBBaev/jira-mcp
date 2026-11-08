// ---------------------------------------------------------------------------
// api/datacenter/meta.ts — the project, status and create-metadata reads on Jira Data
// Center (D106, D116): the routes that are Cloud-only (`/project/search`,
// `/statuses/search`, the Cloud createmeta shape) and their Data Center twins.
//
// Moved out of `api/meta.ts` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { createJiraError } from '../../core/errors.js';
import { JiraError } from '../../core/types.js';
import { asRecord, compact, readString } from '../guards.js';
import {
  classicPage,
  CREATE_META_PAGE_SIZE,
  type CreateMetaIssueTypesOptions,
  type CreateMetaOptions,
  type CreateMetaResult,
  DEFAULT_PROJECT_EXPAND,
  type IssueTypeRef,
  type ListProjectsOptions,
  type ListStatusesOptions,
  mapCreateMetaField,
  mapIssueType,
  mapProject,
  pathSegment,
  type ProjectSummary,
  readId,
  type StatusInfo,
  trimmed,
} from '../meta.js';
import type { ClassicLoopResult } from '../shared.js';
import { requireField, requireRecord, runClassic, sendOne, shapeError } from '../wire.js';

/**
 * Refuse a filter the Data Center endpoint cannot apply, rather than ignoring
 * it: a silently dropped filter answers a narrower question than the caller
 * asked, with rows that look like the answer to the one they did ask.
 */
function notOnDataCenter(what: string, remediation: string): JiraError {
  return createJiraError({
    kind: 'validation',
    reason: `${what} is not available on Jira Data Center.`,
    remediation,
  });
}

/** One complete, unpaginated read reported in the classic loop's own terms. */
function wholeList<T>(items: readonly T[]): ClassicLoopResult<T> {
  return {
    items,
    pages: 1,
    stopReason: 'exhausted',
    partial: false,
    total: items.length,
  };
}

/**
 * {@link listProjects} on Jira Data Center — `GET /rest/api/2/project`.
 *
 * Data Center has no `/project/search`: `/project` answers every visible
 * project in one bare array. `query` and `typeKey` are therefore applied here
 * (case-insensitive substring over key and name, which is what Cloud's
 * `query` matches; exact `projectTypeKey`), and the result is one complete
 * page. `orderBy` has no Data Center equivalent and is refused.
 */
export async function listProjectsDataCenter(
  options: ListProjectsOptions,
): Promise<ClassicLoopResult<ProjectSummary>> {
  if (trimmed(options.orderBy) !== undefined) {
    throw notOnDataCenter(
      'Ordering projects (orderBy)',
      "Drop orderBy; the list comes back in the server's order.",
    );
  }
  const response = await sendOne(options, {
    method: 'GET',
    root: 'v2',
    path: '/project',
    query: { expand: options.expand ?? DEFAULT_PROJECT_EXPAND },
  });
  if (!Array.isArray(response.data)) {
    throw shapeError(
      'GET /project answered with something other than a JSON array of projects.',
      'Re-run; if it persists the site may be behind a proxy rewriting responses.',
    );
  }
  const needle = trimmed(options.query)?.toLowerCase();
  const typeKey = trimmed(options.typeKey);
  const projects = response.data
    .map((entry, index) =>
      mapProject(requireRecord(entry, `project #${index}`), 'datacenter'),
    )
    .filter(
      (project) =>
        (needle === undefined ||
          project.key.toLowerCase().includes(needle) ||
          project.name.toLowerCase().includes(needle)) &&
        (typeKey === undefined || project.projectTypeKey === typeKey),
    );
  return wholeList(projects);
}

/** Data Center's status-category `key` → the Cloud category word (JIRA-API.md). */
const DC_STATUS_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  new: 'TODO',
  indeterminate: 'IN_PROGRESS',
  done: 'DONE',
});

/**
 * {@link listStatuses} on Jira Data Center — `GET /rest/api/2/status`.
 *
 * Data Center has no `/statuses/search`. `/status` answers every status in one
 * array with the category as a nested object; its `key` (`new`,
 * `indeterminate`, `done`) is mapped to the `TODO` / `IN_PROGRESS` / `DONE`
 * word the Cloud read returns, so `statusCategory` means one thing on both.
 * `searchString` and `statusCategory` are applied here; `projectId` and
 * `expand` have no equivalent on this endpoint and are refused.
 */
export async function listStatusesDataCenter(
  options: ListStatusesOptions,
): Promise<ClassicLoopResult<StatusInfo>> {
  if (trimmed(options.projectId) !== undefined) {
    throw notOnDataCenter(
      'Filtering statuses by projectId',
      'Drop projectId; Data Center statuses are global, and jira_get_transitions lists the ones an issue can move to.',
    );
  }
  if (trimmed(options.expand) !== undefined) {
    throw notOnDataCenter('Expanding statuses (expand)', 'Drop expand.');
  }
  const response = await sendOne(options, { method: 'GET', root: 'v2', path: '/status' });
  if (!Array.isArray(response.data)) {
    throw shapeError(
      'GET /status answered with something other than a JSON array of statuses.',
      'Re-run; if it persists the site may be behind a proxy rewriting responses.',
    );
  }
  const needle = trimmed(options.searchString)?.toLowerCase();
  const category = trimmed(options.statusCategory)?.toUpperCase();
  const statuses = response.data
    .map((entry, index) => {
      const record = requireRecord(entry, `status #${index}`);
      const categoryKey = readString(asRecord(record.statusCategory) ?? {}, 'key');
      return compact({
        id: requireField(readId(record, 'id'), 'id', 'status'),
        name: requireField(readString(record, 'name'), 'name', 'status'),
        description: readString(record, 'description'),
        statusCategory:
          categoryKey === undefined ? undefined : DC_STATUS_CATEGORY[categoryKey],
      });
    })
    .filter(
      (status) =>
        (needle === undefined || status.name.toLowerCase().includes(needle)) &&
        (category === undefined || status.statusCategory === category),
    );
  return wholeList(statuses);
}

/**
 * The Data Center release that added the paged create-metadata routes. Older
 * releases only have the all-projects `GET /issue/createmeta?expand=...`,
 * which Jira 9.0 removed and this server never calls (D116).
 */
const DC_CREATE_META_FLOOR = 'Jira Data Center 8.4';

/** Jersey's message for a path no resource matches, e.g. `null for uri: https://…`. */
const JERSEY_NO_ROUTE = /^null for uri\b/i;

/**
 * Re-aim a 404 from a Data Center create-metadata route (D116).
 *
 * A host older than 8.4 has no such route, and answers an unknown REST path
 * with no Jira error messages of its own (an empty or HTML body, or Jersey's
 * `{"message":"null for uri: …"}` — CC-380); that is `unsupported`, because no
 * project key will ever fix it. A 404 that carries Jira's own messages ("No
 * project could be found...") is a missing project or issue type and keeps
 * `not_found`, with the version floor named as the other possibility. Every
 * other failure passes through untouched, and neither branch falls back to
 * the legacy route.
 */
function asDataCenterCreateMetaError(error: unknown, step: string): unknown {
  if (!(error instanceof JiraError) || error.httpStatus !== 404) return error;
  if (error.kind !== 'not_found') return error;
  // The REST framework's own answer to an unmatched path ("null for uri: …",
  // CC-380) is not a Jira message: it means the route is missing, exactly as
  // an empty body does.
  const said = (error.jiraMessages ?? []).filter((text) => !JERSEY_NO_ROUTE.test(text));
  if (said.length === 0) {
    return createJiraError({
      kind: 'unsupported',
      reason:
        `This Jira host answered 404 for the paged create metadata (${step}) ` +
        'without a Jira error message, so the route itself is missing.',
      remediation:
        `jira_get_create_meta needs ${DC_CREATE_META_FLOOR} or later; the legacy ` +
        '/issue/createmeta?expand= route is deliberately not used (Jira 9.0 removed it). ' +
        'Upgrade the host, or read a field set from an existing issue with jira_get_issue.',
      httpStatus: 404,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      cause: error,
    });
  }
  return createJiraError({
    kind: 'not_found',
    reason: `Jira returned HTTP 404 for the create metadata (${step}): ${said.join('; ')}`,
    remediation:
      'Check the project key with jira_list_projects and the issue type id with ' +
      `jira_get_create_meta without issueTypeId. If both are right, the host may be older than ${DC_CREATE_META_FLOOR}, which added this route.`,
    httpStatus: 404,
    jiraMessages: said,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    cause: error,
  });
}

/** Run a Data Center create-metadata read with its 404 re-aimed (D116). */
async function dataCenterCreateMeta<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asDataCenterCreateMetaError(error, step);
  }
}

/**
 * {@link listCreateMetaIssueTypes} on Jira Data Center —
 * `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes` (8.4+).
 *
 * The path matches Cloud's, but the page does not: Data Center wraps the rows
 * in `values` beside `startAt`/`maxResults`/`total`/`isLast`, where Cloud says
 * `issueTypes`. So this is a twin, not an `onV2` reuse. A page without a
 * `values` array is `unexpected_shape`.
 */
export function listCreateMetaIssueTypesDataCenter(
  options: CreateMetaIssueTypesOptions,
): Promise<ClassicLoopResult<IssueTypeRef>> {
  const project = pathSegment(options.project, 'project key or id');
  return dataCenterCreateMeta('the issue type list', () =>
    runClassic(
      options,
      CREATE_META_PAGE_SIZE,
      (cursor) => ({
        method: 'GET',
        root: 'v2',
        path: `/issue/createmeta/${project}/issuetypes`,
        pathTemplate: '/issue/createmeta/{projectIdOrKey}/issuetypes',
        query: { startAt: cursor.startAt, maxResults: cursor.maxResults },
      }),
      (response) =>
        classicPage(response, 'values', 'createmeta issue types', mapIssueType),
    ),
  );
}

/**
 * {@link getCreateMeta} on Jira Data Center —
 * `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}`
 * (8.4+).
 *
 * Rows come in `values`, not `fields`; each row carries the same `fieldId`,
 * `required`, `schema`, `operations` and `allowedValues` Cloud sends, so the
 * Cloud field mapper applies. That mapper never reads `defaultValue` and keeps
 * only `id`/`value`/`name` of an allowed value, so a user-typed field leaks
 * neither an email nor a user key — a user allowed value keeps its username.
 */
export async function getCreateMetaDataCenter(
  options: CreateMetaOptions,
): Promise<CreateMetaResult> {
  const project = pathSegment(options.project, 'project key or id');
  const issueTypeId = pathSegment(options.issueTypeId, 'issue type id');
  const loop = await dataCenterCreateMeta('the create screen', () =>
    runClassic(
      options,
      CREATE_META_PAGE_SIZE,
      (cursor) => ({
        method: 'GET',
        root: 'v2',
        path: `/issue/createmeta/${project}/issuetypes/${issueTypeId}`,
        pathTemplate: '/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
        query: { startAt: cursor.startAt, maxResults: cursor.maxResults },
      }),
      (response) =>
        classicPage(response, 'values', 'createmeta fields', mapCreateMetaField),
    ),
  );
  return {
    ...loop,
    project: options.project,
    issueTypeId: options.issueTypeId,
    required: loop.items.filter((field) => field.required),
  };
}
