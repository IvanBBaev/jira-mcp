// api/issues/issue-links.ts — issue link read and delete (D143, D517).

import { createJiraError } from '../../core/errors.js';
import type { JiraRequestSpec } from '../../core/types.js';
import { asRecord } from '../guards.js';
import type { BudgetGuard } from '../shared.js';
import { responseShapeError, send } from '../wire.js';
import { requireIssueRecord, requireString } from './errors.js';
import { ISSUE_LINK_PATH } from './paths.js';
import { shapeLinkedIssue } from './shape.js';
import type { IssueRequestBase, LinkedIssueRef } from './types.js';

// ---------------------------------------------------------------------------
// 16. Issue link delete (D143)
//
// `DELETE /rest/api/3/issueLink/{linkId}` removes the link from BOTH issues at
// once — Jira stores one link, not two halves — so the before-state is read
// from the link resource itself, which names both ends, rather than from either
// issue's `issuelinks` field, which states only the other end.
// ---------------------------------------------------------------------------

/** One issue link — the `GET` and `DELETE` target. */
export const ISSUE_LINK_ITEM_PATH_TEMPLATE = '/issueLink/{linkId}';

/** A link as its own resource states it: both ends, under Jira's own names. */
export interface IssueLinkDetail {
  readonly id: string;
  readonly type: {
    readonly id?: string;
    readonly name?: string;
    readonly inward?: string;
    readonly outward?: string;
  };
  readonly inwardIssue: LinkedIssueRef;
  readonly outwardIssue: LinkedIssueRef;
}

export interface GetIssueLinkBase extends IssueRequestBase {
  /** Numeric link id, as `jira_get_issue` reports it in `issuelinks[].id`. */
  readonly linkId: string | number;
}

export type GetIssueLinkOptions = GetIssueLinkBase & BudgetGuard;

export interface DeleteIssueLinkInput {
  readonly linkId: string | number;
}

export type DeleteIssueLinkOptions = IssueRequestBase &
  DeleteIssueLinkInput &
  BudgetGuard;

export interface DeleteIssueLinkResult {
  readonly linkId: string;
  readonly deleted: true;
}

/** Read ONE issue link — `GET /rest/api/3/issueLink/{linkId}`. */
export async function getIssueLink(
  options: GetIssueLinkOptions,
): Promise<IssueLinkDetail> {
  const id = issueLinkIdSegment(options.linkId);
  const response = await send(options, {
    method: 'GET',
    path: `${ISSUE_LINK_PATH}/${id}`,
    pathTemplate: ISSUE_LINK_ITEM_PATH_TEMPLATE,
  });
  const record = requireIssueRecord(response.data, 'issue link');
  const linkId = requireString(record.id, 'the issue link "id"');
  const inwardIssue = shapeLinkedIssue(record.inwardIssue);
  const outwardIssue = shapeLinkedIssue(record.outwardIssue);
  if (inwardIssue === undefined || outwardIssue === undefined) {
    throw responseShapeError('issue', 'the issue link does not name both of its issues');
  }
  const type = asRecord(record.type) ?? {};
  return {
    id: linkId,
    type: {
      ...(typeof type.id === 'string' ? { id: type.id } : {}),
      ...(typeof type.name === 'string' ? { name: type.name } : {}),
      ...(typeof type.inward === 'string' ? { inward: type.inward } : {}),
      ...(typeof type.outward === 'string' ? { outward: type.outward } : {}),
    },
    inwardIssue,
    outwardIssue,
  };
}

export function deleteIssueLinkRequest(input: DeleteIssueLinkInput): JiraRequestSpec {
  const id = issueLinkIdSegment(input.linkId);
  return {
    method: 'DELETE',
    path: `${ISSUE_LINK_PATH}/${id}`,
    pathTemplate: ISSUE_LINK_ITEM_PATH_TEMPLATE,
  };
}

/** Delete one issue link. Answers 204; both issues lose it. */
export async function deleteIssueLink(
  options: DeleteIssueLinkOptions,
): Promise<DeleteIssueLinkResult> {
  const linkId = issueLinkIdSegment(options.linkId);
  await send(options, deleteIssueLinkRequest({ linkId }));
  return { linkId, deleted: true };
}

/** Validate an issue link id as a path segment (D22). */
function issueLinkIdSegment(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `An issue link id must be a positive integer, received ${JSON.stringify(String(value))}.`,
      remediation:
        'Read the issue with jira_get_issue (fields: ["issuelinks"]) and pass ' +
        'data.fields.issuelinks[].id, which is the numeric id of the link.',
    });
  }
  return text;
}
