// api/issues/bulk.ts — the issue bulkfetch (D149, D517).

import { createJiraError } from '../../core/errors.js';
import { asRecord } from '../guards.js';
import { requireText, send } from '../wire.js';
import { requireIssueRecord } from './errors.js';
import { ISSUE_REMEDIATION, normalizeList } from './input.js';
import { ISSUE_BULKFETCH_PATH } from './paths.js';
import { shapeIssueRecord } from './shape.js';
import {
  BULK_MULTI_VALUE_FIELDS,
  BULK_RESTRICTED_EXPANDS,
  MAX_BULK_EFFICIENT_FIELDS,
  MAX_BULK_ISSUES,
  MAX_BULK_ISSUES_EFFICIENT,
  type GetIssuesBulkOptions,
  type IssueBulkError,
  type IssuesBulkResult,
} from './types.js';

/**
 * Read up to {@link MAX_BULK_ISSUES} issues in one call, or up to
 * {@link MAX_BULK_ISSUES_EFFICIENT} when the request shape qualifies —
 * `POST /rest/api/3/issue/bulkfetch` (D149). Each issue is shaped exactly like
 * {@link getIssue}; the refs Jira could not serve come back in `errors` and
 * `unmatched` instead of failing the whole read. Cloud only.
 */
export async function getIssuesBulk(
  options: GetIssuesBulkOptions,
): Promise<IssuesBulkResult> {
  const requested = [
    ...new Set(
      options.issues.map((issue) =>
        requireText(issue, 'issue key or id', ISSUE_REMEDIATION),
      ),
    ),
  ];
  if (requested.length === 0 || requested.length > MAX_BULK_ISSUES_EFFICIENT) {
    throw createJiraError({
      kind: 'validation',
      reason:
        `A bulk issue read takes 1 to ${String(MAX_BULK_ISSUES_EFFICIENT)} distinct keys or ids, ` +
        `received ${String(requested.length)}. Nothing was sent.`,
      remediation: `Split the keys into batches of at most ${String(MAX_BULK_ISSUES_EFFICIENT)}.`,
    });
  }
  const fields = normalizeList(options.fields);
  const expand = normalizeList(
    typeof options.expand === 'string' ? options.expand.split(',') : options.expand,
  );
  if (requested.length > MAX_BULK_ISSUES) {
    const why = bulkFetchIneligibility(fields, expand);
    if (why !== undefined) {
      throw createJiraError({
        kind: 'validation',
        reason:
          `${String(requested.length)} distinct keys or ids is over ${String(MAX_BULK_ISSUES)}, ` +
          `and only a request Jira can serve efficiently may name up to ` +
          `${String(MAX_BULK_ISSUES_EFFICIENT)}: ${why} Nothing was sent.`,
        remediation:
          `Name the single-value fields you need (at most ${String(MAX_BULK_EFFICIENT_FIELDS)}, ` +
          'no comment/worklog/attachment) and drop changelog, editmeta, operations, ' +
          'renderedFields, transitions and versionedRepresentations from expand — or ' +
          `split the keys into batches of at most ${String(MAX_BULK_ISSUES)}.`,
      });
    }
  }
  const properties = normalizeList(options.properties);
  const raw = options.raw === true;

  // A pure read on a POST verb: `safe` lets it retry like a GET and pass the
  // read-only seam a read tool runs on (D527).
  const response = await send(options, {
    method: 'POST',
    path: ISSUE_BULKFETCH_PATH,
    safe: true,
    body: {
      issueIdsOrKeys: requested,
      ...(fields.length === 0 ? {} : { fields }),
      ...(expand.length === 0 ? {} : { expand }),
      ...(properties.length === 0 ? {} : { properties }),
    },
  });

  const data = requireIssueRecord(response.data, 'bulk issue read');
  const issues = (Array.isArray(data.issues) ? data.issues : []).map((entry, index) =>
    shapeIssueRecord(
      requireIssueRecord(entry, `issues[${String(index)}]`),
      `issues[${String(index)}]`,
      raw,
      options,
    ),
  );
  const answered = new Set<string>();
  for (const issue of issues) {
    answered.add(issue.id);
    answered.add(issue.key.toUpperCase());
  }
  return {
    issues,
    errors: (Array.isArray(data.issueErrors) ? data.issueErrors : []).map(
      mapBulkIssueError,
    ),
    requested,
    unmatched: requested.filter((ref) => !answered.has(ref.toUpperCase())),
    raw,
    ...(fields.length === 0 ? {} : { fieldsRequested: fields }),
    expand,
  };
}

/**
 * Why a bulk read may not use the 1000-issue cap, or `undefined` when its
 * shape qualifies. The published conditions (operation reference, 2026-10-30):
 * `fields` names at least one positive include, no `*all`/`*navigable`
 * wildcard, at most {@link MAX_BULK_EFFICIENT_FIELDS} includes, none of them
 * multi-value; `expand` holds none of {@link BULK_RESTRICTED_EXPANDS}. Only
 * the multi-value fields the reference names are checked here; Jira judges
 * the rest and answers a 400.
 */
export function bulkFetchIneligibility(
  fields: readonly string[],
  expand: readonly string[],
): string | undefined {
  const includes = fields.filter((field) => !field.startsWith('-'));
  if (includes.length === 0) {
    return "fields must name at least one field to include (exclusions alone and Jira's default set do not qualify).";
  }
  const wildcard = includes.find((field) => field.startsWith('*'));
  if (wildcard !== undefined) {
    return `fields may not use the ${wildcard} wildcard.`;
  }
  if (includes.length > MAX_BULK_EFFICIENT_FIELDS) {
    return `fields names ${String(includes.length)} fields, over ${String(MAX_BULK_EFFICIENT_FIELDS)}.`;
  }
  const multi = includes.find((field) =>
    BULK_MULTI_VALUE_FIELDS.has(field.toLowerCase()),
  );
  if (multi !== undefined) {
    return `fields includes ${multi}, which returns multiple values.`;
  }
  const restricted = expand.find((section) =>
    BULK_RESTRICTED_EXPANDS.has(section.toLowerCase()),
  );
  if (restricted !== undefined) {
    return `expand includes ${restricted}.`;
  }
  return undefined;
}

/**
 * One `issueErrors` entry, allowlisted (D41): the status, the failed element
 * number and every message string found in `elementErrors` — never the entry
 * itself, whose shape is unverified (D149).
 */
function mapBulkIssueError(value: unknown): IssueBulkError {
  const entry = asRecord(value) ?? {};
  const element = asRecord(entry.elementErrors) ?? entry;
  const messages: string[] = [];
  if (Array.isArray(element.errorMessages)) {
    for (const message of element.errorMessages) {
      if (typeof message === 'string') messages.push(message);
    }
  }
  const errors = asRecord(element.errors);
  if (errors !== undefined) {
    for (const [name, message] of Object.entries(errors)) {
      if (typeof message === 'string') messages.push(`${name}: ${message}`);
    }
  }
  return {
    ...(typeof entry.status === 'number' ? { status: entry.status } : {}),
    ...(typeof entry.failedElementNumber === 'number'
      ? { failedElementNumber: entry.failedElementNumber }
      : {}),
    messages,
  };
}
