// api/issues/remote-links.ts — remote links: list, add, get, delete
// (D141, D145, D517).

import { createJiraError } from '../../core/errors.js';
import type { JiraRequestSpec } from '../../core/types.js';
import { asRecord } from '../guards.js';
import type { BudgetGuard } from '../shared.js';
import { requireText, responseShapeError, send } from '../wire.js';
import { isUnknownArray, requireIssueRecord } from './errors.js';
import { issuePath } from './input.js';
import type { IssueRequestBase } from './types.js';

// ---------------------------------------------------------------------------
// 14. Remote links (D141)
//
// The web links an issue carries — pull requests, Confluence pages, runbooks.
// The read is one bare array (no paging, no envelope); the write is an UPSERT:
// a POST whose `globalId` matches a link already on the issue replaces that
// link (200) instead of adding a second one (201), so the result says which.
// `icon` URLs are dropped on the way out: they are rendering noise that costs
// context and carries nothing a model reasons about.
// ---------------------------------------------------------------------------

export const ISSUE_REMOTE_LINK_PATH_TEMPLATE = '/issue/{issueIdOrKey}/remotelink';

/** One remote link, projected. `id` is a NUMBER on the wire and stays one. */
export interface RemoteLink {
  readonly id: number;
  readonly globalId?: string;
  /** Free text, e.g. "mentioned in" — Jira groups the links by it. */
  readonly relationship?: string;
  readonly application?: { readonly type?: string; readonly name?: string };
  readonly url?: string;
  readonly title?: string;
  readonly summary?: string;
  /** Only when the linked object reported one, e.g. a resolved pull request. */
  readonly resolved?: boolean;
}

export interface RemoteLinksResult {
  readonly issue: string;
  readonly remoteLinks: readonly RemoteLink[];
}

export interface ListRemoteLinksBase extends IssueRequestBase {
  readonly issue: string;
}

export type ListRemoteLinksOptions = ListRemoteLinksBase & BudgetGuard;

export interface AddRemoteLinkInput {
  readonly issue: string;
  /** Absolute http(s) URL — the link target. */
  readonly url: string;
  readonly title: string;
  readonly summary?: string;
  readonly relationship?: string;
  /**
   * The upsert key. A link on this issue with the same `globalId` is REPLACED;
   * without one every call adds a new link.
   */
  readonly globalId?: string;
}

export type AddRemoteLinkOptions = IssueRequestBase & AddRemoteLinkInput & BudgetGuard;

export interface AddRemoteLinkResult {
  readonly issue: string;
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly globalId?: string;
  /** `false` when Jira answered 200: a link with this globalId was replaced. */
  readonly created: boolean;
}

/** Read every remote link — `GET /rest/api/3/issue/{issueIdOrKey}/remotelink`. */
export async function listRemoteLinks(
  options: ListRemoteLinksOptions,
): Promise<RemoteLinksResult> {
  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue, '/remotelink'),
    pathTemplate: ISSUE_REMOTE_LINK_PATH_TEMPLATE,
  });
  if (!isUnknownArray(response.data)) {
    throw responseShapeError('issue', 'the remote link response is not a JSON array');
  }
  const remoteLinks = response.data.map((row) => {
    const link = shapeRemoteLink(row);
    // A row without a numeric id cannot be addressed by the delete, and
    // dropping it would hide a link the issue really has (D141).
    if (link === undefined)
      throw responseShapeError('issue', 'a remote link has no numeric "id"');
    return link;
  });
  return { issue: options.issue.trim(), remoteLinks };
}

export function addRemoteLinkRequest(input: AddRemoteLinkInput): JiraRequestSpec {
  const summary = input.summary?.trim();
  const relationship = input.relationship?.trim();
  const globalId = input.globalId?.trim();
  return {
    method: 'POST',
    path: issuePath(input.issue, '/remotelink'),
    pathTemplate: ISSUE_REMOTE_LINK_PATH_TEMPLATE,
    body: {
      ...(globalId === undefined || globalId === '' ? {} : { globalId }),
      ...(relationship === undefined || relationship === '' ? {} : { relationship }),
      object: {
        url: remoteLinkUrl(input.url),
        title: requireText(input.title, 'remote link title'),
        ...(summary === undefined || summary === '' ? {} : { summary }),
      },
    },
  };
}

/**
 * Add (or, by `globalId`, replace) a remote link. Jira answers `{ id, self }`
 * with 201 for a new link and 200 for a replaced one.
 */
export async function addRemoteLink(
  options: AddRemoteLinkOptions,
): Promise<AddRemoteLinkResult> {
  const request = addRemoteLinkRequest(options);
  const response = await send(options, request);
  const data = requireIssueRecord(response.data, 'remote link');
  if (typeof data.id !== 'number') {
    throw responseShapeError('issue', 'the created remote link has no numeric "id"');
  }
  const body = request.body as {
    readonly globalId?: string;
    readonly object: { readonly url: string; readonly title: string };
  };
  return {
    issue: options.issue.trim(),
    id: data.id,
    url: body.object.url,
    title: body.object.title,
    ...(body.globalId === undefined ? {} : { globalId: body.globalId }),
    created: response.status !== 200,
  };
}

function shapeRemoteLink(value: unknown): RemoteLink | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== 'number') return undefined;
  const object = asRecord(record.object) ?? {};
  const application = asRecord(record.application);
  const status = asRecord(object.status);
  const appType = application?.type;
  const appName = application?.name;
  return {
    id: record.id,
    ...(typeof record.globalId === 'string' ? { globalId: record.globalId } : {}),
    ...(typeof record.relationship === 'string'
      ? { relationship: record.relationship }
      : {}),
    ...(typeof appType === 'string' || typeof appName === 'string'
      ? {
          application: {
            ...(typeof appType === 'string' ? { type: appType } : {}),
            ...(typeof appName === 'string' ? { name: appName } : {}),
          },
        }
      : {}),
    ...(typeof object.url === 'string' ? { url: object.url } : {}),
    ...(typeof object.title === 'string' ? { title: object.title } : {}),
    ...(typeof object.summary === 'string' ? { summary: object.summary } : {}),
    ...(typeof status?.resolved === 'boolean' ? { resolved: status.resolved } : {}),
  };
}

/**
 * The link target: an absolute http or https URL, trimmed. Jira stores any
 * string, but a `javascript:` or `data:` target is a click away in the Jira UI,
 * so the scheme is checked before anything is sent (D141).
 */
function remoteLinkUrl(value: string): string {
  const clean = requireText(value, 'remote link url');
  let scheme: string | undefined;
  try {
    scheme = new URL(clean).protocol;
  } catch {
    scheme = undefined;
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw createJiraError({
      kind: 'validation',
      reason: `A remote link url must be an absolute http or https URL, received ${JSON.stringify(clean)}.`,
      remediation: 'Pass the full address, for example https://example.com/pull/42.',
    });
  }
  return clean;
}

// ---------------------------------------------------------------------------
// 17. Remote link delete (D145)
//
// `DELETE /rest/api/3/issue/{issueIdOrKey}/remotelink/{linkId}` removes one web
// link from its issue. The before-state is the link itself, read with the
// single-link GET and shaped like a `listRemoteLinks` row, so the plan names
// the title and target the model saw when it chose the id.
// ---------------------------------------------------------------------------

/** One remote link of one issue — the `GET` and `DELETE` target. */
export const ISSUE_REMOTE_LINK_ITEM_PATH_TEMPLATE =
  '/issue/{issueIdOrKey}/remotelink/{linkId}';

export interface RemoteLinkRef {
  readonly issue: string;
  /** Numeric remote link id, as `jira_get_remote_links` reports it. */
  readonly linkId: string | number;
}

export type GetRemoteLinkOptions = IssueRequestBase & RemoteLinkRef & BudgetGuard;

export type DeleteRemoteLinkOptions = IssueRequestBase & RemoteLinkRef & BudgetGuard;

export interface DeleteRemoteLinkResult {
  readonly issue: string;
  readonly linkId: number;
  readonly deleted: true;
}

/** Read ONE remote link — `GET /rest/api/3/issue/{issueIdOrKey}/remotelink/{linkId}`. */
export async function getRemoteLink(options: GetRemoteLinkOptions): Promise<RemoteLink> {
  const response = await send(options, {
    method: 'GET',
    path: issuePath(options.issue, `/remotelink/${remoteLinkIdSegment(options.linkId)}`),
    pathTemplate: ISSUE_REMOTE_LINK_ITEM_PATH_TEMPLATE,
  });
  const link = shapeRemoteLink(requireIssueRecord(response.data, 'remote link'));
  if (link === undefined)
    throw responseShapeError('issue', 'the remote link has no numeric "id"');
  return link;
}

export function deleteRemoteLinkRequest(input: RemoteLinkRef): JiraRequestSpec {
  return {
    method: 'DELETE',
    path: issuePath(input.issue, `/remotelink/${remoteLinkIdSegment(input.linkId)}`),
    pathTemplate: ISSUE_REMOTE_LINK_ITEM_PATH_TEMPLATE,
  };
}

/** Delete one remote link. Answers 204; other links on the issue stay. */
export async function deleteRemoteLink(
  options: DeleteRemoteLinkOptions,
): Promise<DeleteRemoteLinkResult> {
  const request = deleteRemoteLinkRequest(options);
  await send(options, request);
  return {
    issue: options.issue.trim(),
    linkId: Number(remoteLinkIdSegment(options.linkId)),
    deleted: true,
  };
}

/** Validate a remote link id as a path segment (D22). */
function remoteLinkIdSegment(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw createJiraError({
      kind: 'validation',
      reason: `A remote link id must be a positive integer, received ${JSON.stringify(String(value))}.`,
      remediation:
        'Read the issue with jira_get_remote_links and pass remoteLinks[].id, ' +
        'the numeric id of the link.',
    });
  }
  return text;
}
