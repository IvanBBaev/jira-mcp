// ---------------------------------------------------------------------------
// api/permissions.ts — "may I?" before "do it" (D122).
//
// One call: `GET /rest/api/3/mypermissions`, the only Cloud route that answers
// whether the AUTHENTICATED user holds a named permission — site-wide, in one
// project or on one issue. Every write tool in this server fails cleanly when
// the permission is missing (`forbidden`, JIRA-API.md §Error mapping), so the
// server never needed the question to be safe. It needs it to be CHEAP: a
// plan that would be refused at apply time is a plan the model should not
// build, and a Gate C run against an account that lacks "Administer projects"
// should know that before it burns seven claims finding out (O-2).
//
// Three rules shape the function, each of which Jira's own answer makes easy
// to get wrong:
//
//  1. **The scope is one parameter, the most specific one.** Cloud reads
//     `projectKey` and `issueKey` independently and, when both are present,
//     evaluates the PROJECT and ignores the issue — so a caller asking about an
//     issue inside a project would silently get the project's answer. Only the
//     issue goes on the wire when one is given; the result's `context` names
//     which scope actually answered (CC-1403).
//  2. **A key Jira did not answer is `unanswered`, never `false`.** The
//     `permissions` record only carries what Jira chose to evaluate; a key
//     that is missing from it (a Data Center build that filters differently,
//     a key Jira knows but the site does not expose) is a question without an
//     answer, and reporting it as "denied" would stop a model from an action
//     it may well be allowed to take (CC-1401).
//  3. **Extra answers are dropped.** A Data Center build that ignores the
//     `permissions` filter sends the whole catalog; the result holds the keys
//     that were asked for, in the order they were asked (CC-1402).
//
// The keys are validated before the wire (CC-1400): a blank key, a key with
// characters no Jira permission key has, or more keys than fit a sane query
// string is a caller mistake Jira would report as a bare 400 — refusing it
// here keeps the request off the network and names the key at fault.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import type { JiraError, JiraRequestFn, QueryParams } from '../core/types.js';
import type { BudgetGuard } from './shared.js';

// ---------------------------------------------------------------------------
// 1. Wire constants and caps
// ---------------------------------------------------------------------------

/** `GET /rest/api/3/mypermissions` — relative to the `v3` root. */
export const MY_PERMISSIONS_PATH = '/mypermissions';

/**
 * The most permission keys one call takes. The server's own cap, not Jira's:
 * the keys travel in the query string, and Jira's whole catalog is a few dozen
 * keys, so fifty answers any honest question and keeps the URL short.
 */
export const MAX_PERMISSION_KEYS = 50;

/**
 * What a Jira permission key looks like: `BROWSE_PROJECTS`, `ADMINISTER`,
 * `com.example.app:custom-permission` for an app-declared one. Anything else
 * (a space, a comma, a quote) could only split or break the query parameter.
 */
const PERMISSION_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

// ---------------------------------------------------------------------------
// 2. Types
// ---------------------------------------------------------------------------

/** Which scope Jira evaluated the permissions in. */
export type PermissionContext = 'global' | 'project' | 'issue';

/** One permission as Jira answered it. */
export interface PermissionCheck {
  /** The key as it was asked for. */
  readonly key: string;
  /** Jira's `havePermission` for the evaluated scope. */
  readonly granted: boolean;
  /** Jira's display name for the permission, when it sent one. */
  readonly name?: string;
  /** `GLOBAL` or `PROJECT`, when Jira sent it. */
  readonly type?: string;
}

export interface GetMyPermissionsBase {
  readonly jira: JiraRequestFn;
  readonly signal?: AbortSignal;
  /** Permission keys to evaluate; at least one, at most {@link MAX_PERMISSION_KEYS}. */
  readonly permissions: readonly string[];
  /** Project key or numeric id; ignored on the wire when `issueKey` is given. */
  readonly projectKey?: string;
  /** Issue key or numeric id; the most specific scope, wins over the project. */
  readonly issueKey?: string;
}

export type GetMyPermissionsOptions = GetMyPermissionsBase & BudgetGuard;

export interface MyPermissionsResult {
  readonly context: PermissionContext;
  /** The project the answer is about, when `context` is `project`. */
  readonly projectKey?: string;
  /** The issue the answer is about, when `context` is `issue`. */
  readonly issueKey?: string;
  /** The keys Jira answered, in request order. */
  readonly permissions: readonly PermissionCheck[];
  /** The keys Jira did not answer, in request order — unknown, not denied. */
  readonly unanswered: readonly string[];
}

// ---------------------------------------------------------------------------
// 3. The call
// ---------------------------------------------------------------------------

/**
 * Ask Jira which of the given permissions the authenticated user holds
 * (`GET /rest/api/3/mypermissions`).
 *
 * The scope is the most specific reference given: the issue when there is
 * one, else the project, else the whole site. Without a scope Jira reports a
 * project permission as granted when the user holds it in ANY project, which
 * says "somewhere", not "here" — pass the project or issue to ask "here".
 */
export async function getMyPermissions(
  options: GetMyPermissionsOptions,
): Promise<MyPermissionsResult> {
  const keys = normalisePermissionKeys(options.permissions);
  const scope = scopeOf(options);

  const response = await options.jira({
    method: 'GET',
    path: MY_PERMISSIONS_PATH,
    query: { permissions: keys.join(','), ...scope.query },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });

  const answers = answersOf(response.data);
  const permissions: PermissionCheck[] = [];
  const unanswered: string[] = [];
  for (const key of keys) {
    const answer = answers[key];
    if (answer === undefined) {
      unanswered.push(key);
      continue;
    }
    permissions.push(toPermissionCheck(key, answer));
  }

  return { ...scope.result, permissions, unanswered };
}

// ---------------------------------------------------------------------------
// 4. Validation before the wire
// ---------------------------------------------------------------------------

/**
 * Trim, refuse the malformed, drop exact repeats, cap the count — all before
 * anything reaches the network (CC-1400). Request order is kept so the result
 * can be read against the question.
 */
function normalisePermissionKeys(permissions: readonly string[]): string[] {
  const keys: string[] = [];
  for (const raw of permissions) {
    const key = raw.trim();
    if (key === '') {
      throw createJiraError({
        kind: 'validation',
        reason: 'getMyPermissions was given a blank permission key. Nothing was sent.',
        remediation:
          'Pass Jira permission keys such as BROWSE_PROJECTS, CREATE_ISSUES or EDIT_ISSUES.',
      });
    }
    if (!PERMISSION_KEY_PATTERN.test(key)) {
      throw createJiraError({
        kind: 'validation',
        reason: `${JSON.stringify(key)} is not a Jira permission key. Nothing was sent.`,
        remediation:
          'Permission keys are upper-case words joined by underscores (BROWSE_PROJECTS, ' +
          'ADMINISTER_PROJECTS); pass one key per array entry, not a comma-separated list.',
      });
    }
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) {
    throw createJiraError({
      kind: 'validation',
      reason: 'getMyPermissions needs at least one permission key; none was supplied.',
      remediation: 'Pass the keys to check, e.g. ["BROWSE_PROJECTS", "CREATE_ISSUES"].',
    });
  }
  if (keys.length > MAX_PERMISSION_KEYS) {
    throw createJiraError({
      kind: 'validation',
      reason:
        `getMyPermissions checks at most ${String(MAX_PERMISSION_KEYS)} permission keys ` +
        `per call; ${String(keys.length)} were supplied. Nothing was sent.`,
      remediation: `Split the keys into calls of ${String(MAX_PERMISSION_KEYS)} or fewer.`,
    });
  }
  return keys;
}

interface Scope {
  readonly query: QueryParams;
  readonly result: Pick<MyPermissionsResult, 'context' | 'projectKey' | 'issueKey'>;
}

/**
 * The one scope parameter that goes on the wire (CC-1403). A reference that is
 * all digits is sent as the `…Id` parameter, anything else as the `…Key` one:
 * no Jira project or issue key is purely numeric, so the shape decides.
 */
function scopeOf(options: GetMyPermissionsBase): Scope {
  const issue = scopeValue(options.issueKey, 'issueKey');
  if (issue !== undefined) {
    return {
      query: { [isNumericId(issue) ? 'issueId' : 'issueKey']: issue },
      result: { context: 'issue', issueKey: issue },
    };
  }
  const project = scopeValue(options.projectKey, 'projectKey');
  if (project !== undefined) {
    return {
      query: { [isNumericId(project) ? 'projectId' : 'projectKey']: project },
      result: { context: 'project', projectKey: project },
    };
  }
  return { query: {}, result: { context: 'global' } };
}

/**
 * A blank scope is refused rather than dropped: dropping it would silently
 * widen the question from "in this project" to "in any project" (the CC-560
 * lesson from the user search).
 */
function scopeValue(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') {
    throw createJiraError({
      kind: 'validation',
      reason: `getMyPermissions was given a blank ${name}. Nothing was sent.`,
      remediation: `Pass the ${name === 'issueKey' ? 'issue' : 'project'} key or id, or leave it out to ask site-wide.`,
    });
  }
  return trimmed;
}

function isNumericId(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

// ---------------------------------------------------------------------------
// 5. Reading the answer
// ---------------------------------------------------------------------------

/** `{ permissions: { KEY: { havePermission, … } } }` — the record, or a shape error. */
function answersOf(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) throw shapeError('the body is not an object');
  const answers = data['permissions'];
  if (!isRecord(answers)) throw shapeError('"permissions" is not an object');
  return answers;
}

function toPermissionCheck(key: string, answer: unknown): PermissionCheck {
  if (!isRecord(answer)) throw shapeError(`the entry for ${key} is not an object`);
  const granted = answer['havePermission'];
  if (typeof granted !== 'boolean') {
    throw shapeError(`the entry for ${key} has no boolean "havePermission"`);
  }
  return {
    key,
    granted,
    ...optionalString(answer, 'name'),
    ...optionalString(answer, 'type'),
  };
}

/** `{ key: value }` when the record carries a non-empty string there, else `{}`. */
function optionalString(
  row: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeError(what: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason: `Jira's permissions response could not be read: ${what}.`,
  });
}
