// api/issues/input.ts — issue paths and input normalization (D517).

import { createJiraError } from '../../core/errors.js';
import { encodeSegment } from '../../core/http-util.js';
import { refuseAccountIdOnDataCenter, refuseUsernameOnCloud } from '../users.js';
import { requireText } from '../wire.js';
import { ISSUE_COLLECTION_PATH, MAX_PAGE_SIZE } from './paths.js';
import type { AddWorklogInput, AssignIssueInput } from './write-types.js';

// ---------------------------------------------------------------------------
// 11. Paths and input normalization
// ---------------------------------------------------------------------------

/**
 * `/issue/<encoded key>` plus an optional LITERAL suffix.
 *
 * The key is percent-encoded on its own, per the `JiraRequestSpec.path`
 * contract: encoding the whole path would eat the slashes, and encoding nothing
 * would let a key carry a `../` into the URL. `encodeSegment` rejects the
 * traversal and control-character cases outright rather than encoding them.
 */
export function issuePath(issue: string, suffix = ''): string {
  const key = requireText(issue, 'issue key or id', ISSUE_REMEDIATION);
  return `${ISSUE_COLLECTION_PATH}/${encodeSegment(key, 'issue key or id')}${suffix}`;
}

export const ISSUE_REMEDIATION =
  'Pass the issue key (for example PROJ-123) or its numeric id; jira_search ' +
  'finds one from a JQL query.';

/**
 * Validate a comment id and return it as a path segment (D22). Jira comment ids
 * are always positive integers, so anything else is a caller mistake — most
 * often the comment BODY or an author name — and the check doubles as the
 * guarantee that no unencoded caller string reaches the URL.
 */
export function commentIdSegment(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `A comment id must be a positive integer, received ${JSON.stringify(String(value))}.`,
      remediation:
        'Read the thread with jira_get_comments and pass data.comments[].id, ' +
        'which is the numeric id of the comment to edit.',
    });
  }
  return text;
}

/** `{ id }` for an all-digit value, `{ key }` otherwise — projects and issues. */
export function keyOrIdRef(value: string, what: string): Record<string, string> {
  const clean = requireText(value, what);
  return /^\d+$/.test(clean) ? { id: clean } : { key: clean };
}

/** `{ id }` for an all-digit value, `{ name }` otherwise — types, priorities. */
export function nameOrIdRef(value: string, what: string): Record<string, string> {
  const clean = requireText(value, what);
  return /^\d+$/.test(clean) ? { id: clean } : { name: clean };
}

export function normalizeLabels(labels: readonly string[]): string[] {
  return labels.map((label) => requireText(label, 'label'));
}

/**
 * Merge the raw `fields` passthrough into the named ones. A key set by BOTH is a
 * validation error rather than a silent winner: either resolution order surprises
 * somebody, and the surprise is a wrong write.
 */
export function mergeExtraFields(
  named: Record<string, unknown>,
  extra: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (extra === undefined) return named;
  const out: Record<string, unknown> = { ...named };
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(named, key)) {
      throw createJiraError({
        kind: 'validation',
        reason: `The field "${key}" was set twice: once as a named option and once in the raw fields object.`,
        remediation: `Set ${key} in exactly one place — drop it from the raw fields object, or drop the named option.`,
      });
    }
    out[key] = value;
  }
  return out;
}

/**
 * CC-22 — `accountId` and `unassign` are mutually exclusive, and one is
 * required. A `username` is refused first: Cloud has none (D111).
 */
export function resolveAssignee(input: AssignIssueInput): string | null {
  refuseUsernameOnCloud(input.username);
  const unassign = input.unassign === true;
  const named = input.accountId !== undefined && input.accountId.trim() !== '';
  if (unassign && named) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'accountId and unassign: true were both supplied, so the intended ' +
        'assignee is ambiguous.',
      remediation:
        'Pass accountId to assign, or unassign: true to clear the assignee — ' +
        'never both.',
    });
  }
  if (unassign) return null;
  if (!named) {
    throw createJiraError({
      kind: 'validation',
      reason: 'An assignment needs either an accountId or unassign: true.',
      remediation:
        'Jira Cloud identifies users by accountId only; jira_search_users turns a ' +
        'display name or email into one.',
    });
  }
  return requireText(input.accountId ?? '', 'accountId');
}

/**
 * CC-22 on Jira Data Center (D111) — `username` and `unassign` are mutually
 * exclusive, one is required, and an `accountId` is refused first: Data Center
 * has none.
 */
export function resolveDataCenterAssignee(input: AssignIssueInput): string | null {
  refuseAccountIdOnDataCenter(input.accountId);
  const unassign = input.unassign === true;
  const named = input.username !== undefined && input.username.trim() !== '';
  if (unassign && named) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'username and unassign: true were both supplied, so the intended ' +
        'assignee is ambiguous.',
      remediation:
        'Pass username to assign, or unassign: true to clear the assignee — ' +
        'never both.',
    });
  }
  if (unassign) return null;
  if (!named) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'An assignment on Jira Data Center needs either a username or unassign: true.',
      remediation:
        'Jira Data Center identifies users by username — the `name` its user ' +
        'fields return.',
    });
  }
  return requireText(input.username ?? '', 'username');
}

/** Exactly one of `timeSpentSeconds` / `timeSpent`, as TOOLS.md specifies. */
export function resolveTimeSpent(input: AddWorklogInput): Record<string, unknown> {
  const hasSeconds = input.timeSpentSeconds !== undefined;
  const hasText = input.timeSpent !== undefined && input.timeSpent.trim() !== '';
  if (hasSeconds === hasText) {
    throw createJiraError({
      kind: 'validation',
      reason: hasSeconds
        ? 'timeSpentSeconds and timeSpent were both supplied; Jira accepts exactly one.'
        : 'A worklog needs the time spent: either timeSpentSeconds or timeSpent.',
      remediation:
        'Pass timeSpentSeconds (preferred, e.g. 9000) or timeSpent as a Jira ' +
        'duration string (e.g. "2h 30m") — never both.',
    });
  }
  if (hasSeconds) {
    const seconds = input.timeSpentSeconds ?? 0;
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw createJiraError({
        kind: 'validation',
        reason: `timeSpentSeconds must be a whole number of seconds above zero, received ${String(seconds)}.`,
        remediation: 'Pass the duration in seconds, e.g. 9000 for two and a half hours.',
      });
    }
    return { timeSpentSeconds: seconds };
  }
  return { timeSpent: requireText(input.timeSpent ?? '', 'timeSpent') };
}

export function normalizeStartAt(startAt: number | undefined): number {
  if (startAt === undefined) return 0;
  if (!Number.isInteger(startAt) || startAt < 0) {
    throw createJiraError({
      kind: 'validation',
      reason: `startAt must be a whole number of rows, zero or more, received ${String(startAt)}.`,
      remediation:
        'Pass the offset the previous page reported as nextStartAt, or omit it.',
    });
  }
  return startAt;
}

export function normalizePageSize(maxResults: number): number {
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw createJiraError({
      kind: 'validation',
      reason: `maxResults must be a whole number of at least 1, received ${String(maxResults)}.`,
      remediation: `Pass maxResults between 1 and ${String(MAX_PAGE_SIZE)}, or omit it.`,
    });
  }
  return Math.min(maxResults, MAX_PAGE_SIZE);
}

/** Trim, drop the blanks, keep the order — for `fields`/`expand`/`properties`. */
export function normalizeList(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  return values.map((value) => value.trim()).filter((value) => value !== '');
}

/** Jira takes list query parameters as CSV; an empty list is omitted entirely. */
export function csv(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : values.join(',');
}

export function trimmedOr(value: string | undefined, fallback: string): string {
  const clean = value?.trim() ?? '';
  return clean === '' ? fallback : clean;
}
