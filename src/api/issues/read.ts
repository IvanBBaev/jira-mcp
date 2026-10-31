// api/issues/read.ts — the single-issue read, comment and worklog pages, and
// transitions (D517).

import { createJiraError } from '../../core/errors.js';
import { requireText, responseShapeError, send } from '../wire.js';
import { classicList } from './classic-list.js';
import { isUnknownArray, requireIssueRecord } from './errors.js';
import { csv, issuePath, normalizeList, trimmedOr } from './input.js';
import {
  DEFAULT_COMMENT_ORDER_BY,
  DEFAULT_COMMENT_PAGE_SIZE,
  DEFAULT_WORKLOG_PAGE_SIZE,
  ISSUE_COMMENT_PATH_TEMPLATE,
  ISSUE_PATH_TEMPLATE,
  ISSUE_TRANSITIONS_PATH_TEMPLATE,
  ISSUE_WORKLOG_PATH_TEMPLATE,
} from './paths.js';
import {
  shapeComment,
  shapeIssueRecord,
  shapeTransition,
  shapeWorklog,
} from './shape.js';
import type {
  CommentsResult,
  GetIssueOptions,
  IssueComment,
  IssueDetail,
  IssueTransition,
  IssueWorklog,
  ListCommentsOptions,
  ListTransitionsOptions,
  ListWorklogsOptions,
  TransitionsResult,
  WorklogsResult,
} from './types.js';

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

/**
 * Read one issue — `GET /rest/api/3/issue/{issueIdOrKey}`.
 *
 * CC-16: Jira answers **404 for an issue that exists but this account may not
 * see**, exactly as it does for one that does not exist. That ambiguity is
 * already spelled out by the `not_found` remediation the core error factory
 * attaches, so the 404 propagates from here untouched — rewriting it would
 * replace "not found OR no permission" with a confident lie.
 */
export async function getIssue(options: GetIssueOptions): Promise<IssueDetail> {
  const fields = normalizeList(options.fields);
  const expand = normalizeList(
    typeof options.expand === 'string' ? options.expand.split(',') : options.expand,
  );
  const properties = normalizeList(options.properties);
  const raw = options.raw === true;

  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue),
    pathTemplate: ISSUE_PATH_TEMPLATE,
    query: {
      fields: csv(fields),
      expand: csv(expand),
      properties: csv(properties),
    },
  });

  return {
    ...shapeIssueRecord(
      requireIssueRecord(response.data, 'issue'),
      'issue',
      raw,
      options,
    ),
    raw,
    ...(fields.length === 0 ? {} : { fieldsRequested: fields }),
    expand,
  };
}

/**
 * Read a page of comments — `GET /rest/api/3/issue/{issueIdOrKey}/comment`.
 * Classic pagination; bodies are flattened, authors projected.
 */
export async function listComments(
  options: ListCommentsOptions,
): Promise<CommentsResult> {
  const orderBy = trimmedOr(options.orderBy, DEFAULT_COMMENT_ORDER_BY);
  const page = await classicList<IssueComment>(options, {
    defaultPageSize: DEFAULT_COMMENT_PAGE_SIZE,
    suffix: '/comment',
    pathTemplate: ISSUE_COMMENT_PATH_TEMPLATE,
    query: { orderBy },
    collection: 'comments',
    map: (value) => shapeComment(value, options.format, options.deployment),
  });
  return { ...page.meta, comments: page.items, orderBy };
}

/**
 * Read a page of worklogs — `GET /rest/api/3/issue/{issueIdOrKey}/worklog`.
 */
export async function listWorklogs(
  options: ListWorklogsOptions,
): Promise<WorklogsResult> {
  const page = await classicList<IssueWorklog>(options, {
    defaultPageSize: DEFAULT_WORKLOG_PAGE_SIZE,
    suffix: '/worklog',
    pathTemplate: ISSUE_WORKLOG_PATH_TEMPLATE,
    collection: 'worklogs',
    map: (value) => shapeWorklog(value, options.deployment),
  });
  return { ...page.meta, worklogs: page.items };
}

/**
 * List the transitions available from the issue's CURRENT status —
 * `GET /rest/api/3/issue/{issueIdOrKey}/transitions`.
 *
 * Not paginated. Mandatory before {@link transitionIssue}: status cannot be set
 * through an update, and a transition id is workflow-specific and mutable
 * (JIRA-API.md §Transitions).
 */
export async function listTransitions(
  options: ListTransitionsOptions,
): Promise<TransitionsResult> {
  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue, '/transitions'),
    pathTemplate: ISSUE_TRANSITIONS_PATH_TEMPLATE,
    query: {
      expand: options.expandFields === true ? 'transitions.fields' : undefined,
    },
  });

  const data = requireIssueRecord(response.data, 'transitions');
  const rows = data.transitions ?? [];
  if (!isUnknownArray(rows)) {
    throw responseShapeError(
      'issue',
      'the transitions response has a non-array "transitions"',
    );
  }
  const transitions: IssueTransition[] = [];
  for (const row of rows) {
    const transition = shapeTransition(row);
    if (transition !== undefined) transitions.push(transition);
  }
  return { transitions };
}

/**
 * The opening of the local "no such transition" refusal, exported so the tool
 * layer can tell it from the other local validation errors of the same call
 * (CC-177).
 */
export const NO_TRANSITION_MATCHES = 'No transition matches';
/** Reason prefix of the refusal for a name that several transitions share. */
export const AMBIGUOUS_TRANSITION = 'More than one transition is named';

/**
 * CC-21 — turn a transition id OR name into the id the POST needs, against the
 * live list. An unresolvable value fails with a `validation` error that NAMES
 * every currently valid transition, which is the anti-hallucination path: a
 * model that invented "Close" is told what actually exists instead of being sent
 * to Jira to earn an opaque 400.
 *
 * Pure — no network. The caller reads the list with {@link listTransitions}.
 */
export function resolveTransitionId(
  transitions: readonly IssueTransition[],
  wanted: string,
): string {
  const want = requireText(wanted, 'transition id or name');
  const byId = transitions.find((entry) => entry.id === want);
  if (byId !== undefined) return byId.id;

  // An exact-case name beats a case-folded one, and two candidates refuse
  // rather than move the issue to whichever Jira listed first (CC-428): a
  // global "Close" and a local "Close" lead to different statuses.
  const named = (match: (name: string) => boolean): IssueTransition[] =>
    transitions.filter((entry) => entry.name !== undefined && match(entry.name));
  const folded = want.toLowerCase();
  const exact = named((name) => name === want);
  const candidates =
    exact.length > 0 ? exact : named((name) => name.toLowerCase() === folded);
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return only.id;
  if (candidates.length > 1) {
    const choices = candidates
      .map(
        (entry) => `${entry.id} (${entry.name ?? 'unnamed'} -> ${entry.to?.name ?? '?'})`,
      )
      .join(', ');
    throw createJiraError({
      kind: 'validation',
      reason: `${AMBIGUOUS_TRANSITION} ${JSON.stringify(want)}: ${choices}.`,
      remediation:
        'Pass the id of the transition you mean; each one leads to the status ' +
        'shown after the arrow. Nothing was sent to Jira.',
    });
  }

  const catalog = transitions
    .map((entry) => `${entry.id} (${entry.name ?? 'unnamed'})`)
    .join(', ');
  throw createJiraError({
    kind: 'validation',
    reason:
      `${NO_TRANSITION_MATCHES} ${JSON.stringify(want)} from this issue's current ` +
      `status. Available now: ${catalog === '' ? 'none' : catalog}.`,
    remediation:
      'Transitions depend on the current status and on the workflow, which can ' +
      'change at any time. Pick an id from the list above, or re-read it with ' +
      'jira_get_transitions.',
  });
}
