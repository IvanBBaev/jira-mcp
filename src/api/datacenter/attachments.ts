// ---------------------------------------------------------------------------
// api/datacenter/attachments.ts — the attachment list and download on Jira Data Center (D114,
// D117): the Cloud list on the v2 root with the Data Center author, and the
// bytes from the attachment servlet (`/secure/attachment/{id}/{filename}`).
//
// Moved out of `api/attachments.ts` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { encodeSegment, MAX_ATTACHMENT_BYTES } from '../../core/http-util.js';
import type { JiraResponse } from '../../core/types.js';
import {
  ATTACHMENT_PATH_TEMPLATE,
  type DataCenterAttachmentAuthor,
  type DownloadAttachmentOptions,
  type DownloadAttachmentResult,
  type JiraAttachment,
  type ListAttachmentsOptions,
  type ListAttachmentsResult,
  readIssueAttachments,
  requireAttachmentId,
  requireStore,
  toJiraAttachment,
  tooLarge,
  writeDownload,
} from '../attachments.js';
import { shapeDataCenterUser } from '../users.js';
import { responseShapeError, writeControls } from '../wire.js';

/**
 * `GET {contextPath}/secure/attachment/{id}/{filename}` — the bytes on Data
 * Center (D117). The attachment servlet, not a REST route: the `secure` root.
 */
export const SECURE_ATTACHMENT_PATH_TEMPLATE = '/attachment/{id}/{filename}';

/**
 * {@link listAttachments} on Jira Data Center —
 * `GET /rest/api/2/issue/{issueIdOrKey}?fields=attachment` (D114).
 *
 * The same route and the same allowlist as Cloud on the v2 root: the `self`,
 * `content` and `thumbnail` URLs are dropped, and the author takes the Data
 * Center projection (name/key/displayName — no email, no avatar, no
 * accountId). The download has its own twin
 * ({@link downloadAttachmentDataCenter}, D117); the upload is not served.
 */
export async function listAttachmentsDataCenter(
  options: ListAttachmentsOptions,
): Promise<ListAttachmentsResult> {
  return readIssueAttachments(options, 'v2', toDataCenterAuthor);
}

/**
 * {@link downloadAttachment} on Jira Data Center (D117). UNVERIFIED.
 *
 * Data Center has no `/attachment/content/{id}`. The bytes are served by the
 * attachment servlet at `/secure/attachment/{id}/{filename}`, outside the REST
 * API, so the order is the Cloud one with a different second call:
 *
 *  1. `GET /rest/api/2/attachment/{id}` — the metadata, with the Data Center
 *     author; it names the file and gives the size checked BEFORE any bytes
 *     move.
 *  2. `GET {contextPath}/secure/attachment/{id}/{filename}` — the bytes. The
 *     URL is BUILT here from the id and the metadata's filename, under the
 *     configured host and context path. The metadata's `content` URL is never
 *     read: it is tenant-supplied text, and following it would let a record
 *     point the authenticated request at any path or host.
 *
 * `core/http.ts` never follows a redirect from the `secure` root: on Data
 * Center a redirect there is the login page, and the bytes of an HTML page
 * are not the attachment. The size cap, the filename sanitizing and the
 * media-directory refusal are the Cloud ones.
 */
export async function downloadAttachmentDataCenter(
  options: DownloadAttachmentOptions,
): Promise<DownloadAttachmentResult> {
  const store = requireStore(options.store, 'download');
  const id = requireAttachmentId(options.attachmentId);
  const meta = await options.jira({
    method: 'GET',
    root: 'v2',
    path: `/attachment/${encodeSegment(id, 'attachment id')}`,
    pathTemplate: ATTACHMENT_PATH_TEMPLATE,
    ...writeControls(options),
  });
  const attachment = toJiraAttachment(
    meta.data,
    'the attachment response',
    toDataCenterAuthor,
  );

  if (attachment.size !== undefined && attachment.size > MAX_ATTACHMENT_BYTES) {
    throw tooLarge(attachment.size);
  }

  const response: JiraResponse<unknown> = await options.jira({
    method: 'GET',
    root: 'secure',
    path: `/attachment/${encodeSegment(id, 'attachment id')}/${encodeFilenameSegment(attachment.filename)}`,
    pathTemplate: SECURE_ATTACHMENT_PATH_TEMPLATE,
    accept: 'binary',
    ...writeControls(options),
  });

  refuseServletSubstitute(attachment, response);
  return await writeDownload(store, attachment, response.data);
}

/**
 * The servlet sits outside `/rest`, where an SSO gateway, a WAF or a session
 * interstitial can answer 200 with a page of its own. Those bytes are not the
 * attachment, so they are refused before anything is written (CC-399): when
 * the metadata states a size the body must match it, and an HTML body is
 * accepted only for an attachment that is itself HTML. The cap is checked
 * first, so an over-cap body stays the `validation` refusal of CC-372.
 */
function refuseServletSubstitute(
  attachment: JiraAttachment,
  response: JiraResponse<unknown>,
): void {
  const bytes = response.data;
  if (!(bytes instanceof Uint8Array)) return;
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw tooLarge(bytes.byteLength);
  const { size } = attachment;
  if (
    size !== undefined &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    bytes.byteLength !== size
  ) {
    throw responseShapeError(
      'attachment',
      `the servlet answered ${String(bytes.byteLength)} bytes for an attachment of ${String(size)} bytes, which is a login or proxy page rather than the file`,
    );
  }
  const contentType = (response.headers['content-type'] ?? '').toLowerCase();
  const mimeType = (attachment.mimeType ?? '').toLowerCase();
  if (contentType.startsWith('text/html') && !mimeType.startsWith('text/html')) {
    throw responseShapeError(
      'attachment',
      'the servlet answered an HTML page for an attachment that is not HTML, which is a login or proxy page rather than the file',
    );
  }
}

/**
 * Jira's filename as ONE path segment of the servlet URL. Unlike
 * {@link encodeSegment} it accepts spaces and the other characters real file
 * names carry — every one of them is percent-encoded, `/`, `\`, `?`, `#` and
 * `%` included, so a name cannot add a segment, a query or a fragment. A name
 * that is empty or only dots (`.`, `..`) would be a dot segment, and one that
 * is not well-formed Unicode cannot be encoded at all; both are refused before
 * anything is sent.
 */
function encodeFilenameSegment(filename: string): string {
  if (filename === '' || /^\.+$/.test(filename)) {
    throw responseShapeError(
      'attachment',
      `the attachment's filename "${filename}" cannot name a download`,
    );
  }
  try {
    return encodeURIComponent(filename);
  } catch {
    throw responseShapeError(
      'attachment',
      "the attachment's filename is not well-formed Unicode",
    );
  }
}

/**
 * The Data Center author: the Data Center user allowlist, less `active`. A
 * record with an accountId, or with neither a name nor a key, is dropped.
 */
function toDataCenterAuthor(value: unknown): DataCenterAttachmentAuthor | undefined {
  const user = shapeDataCenterUser(value);
  if (user === undefined) return undefined;
  return {
    ...(user.name === undefined ? {} : { name: user.name }),
    ...(user.key === undefined ? {} : { key: user.key }),
    ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
  };
}
