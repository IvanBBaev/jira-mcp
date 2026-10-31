// api/issues/errors.ts — error re-aiming and response guards (D517).

import { createJiraError } from '../../core/errors.js';
import type { JiraError } from '../../core/types.js';
import { requireRecord, responseShapeError } from '../wire.js';

// ---------------------------------------------------------------------------
// 12. Errors and guards
// ---------------------------------------------------------------------------

/**
 * CC-21 — a 400 from the transition POST, re-aimed. Jira's own messages are
 * carried through verbatim in `jiraMessages` and in the reason; only the
 * remediation changes, because the generic "correct the fields" advice is wrong
 * for the common cause: a transition id that was valid when it was read and is
 * not valid now.
 */
export function staleTransition(cause: JiraError, transitionId: string): JiraError {
  const said = cause.jiraMessages ?? [];
  return createJiraError({
    kind: 'validation',
    reason:
      `Jira rejected transition ${transitionId} for this issue` +
      `${said.length === 0 ? '' : `: ${said.join('; ')}`}.`,
    remediation:
      'Re-fetch the transitions for this issue (jira_get_transitions) and use an ' +
      'id from that list: the available transitions depend on the current status ' +
      'and change whenever the workflow or the issue does. If the transition ' +
      'screen requires fields (a resolution, for example), pass them too.',
    httpStatus: cause.httpStatus,
    ...(said.length === 0 ? {} : { jiraMessages: said }),
    ...(cause.detail === undefined ? {} : { detail: cause.detail }),
    cause,
  });
}

/** {@link requireRecord} worded as an issue-response failure. */
export function requireIssueRecord(
  value: unknown,
  what: string,
): Record<string, unknown> {
  return requireRecord(value, what, (subject) =>
    responseShapeError('issue', `the ${subject} response is not a JSON object`),
  );
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which then leaks `any` through
 * every element read. This guard lands on `readonly unknown[]` instead, so wire
 * arrays stay as untyped as they really are.
 */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw responseShapeError('issue', `${what} is missing or not a string`);
  }
  return value;
}
