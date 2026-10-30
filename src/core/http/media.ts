// The one redirect this module ever follows: an attachment download's 303 to
// Atlassian's media host — anonymous, https-only, once (D515).

import { isBlockedHost } from '../http-util.js';
import type { JiraError } from '../types.js';
import type { CallContext, HopTarget } from './context.js';

/**
 * Resolve the media URL a 303 points at, or refuse to go there.
 *
 * Jira answers `GET /attachment/content/{id}` with a redirect to a signed,
 * short-lived URL on an Atlassian media host that is NOT the site host and
 * is not knowable in advance — so the operator allowlist deliberately does
 * not apply to it (it would have to be widened to a wildcard to work at
 * all, which is worse). What does apply: https only, the SSRF blocklist,
 * exactly one hop, and no credentials.
 */
export function mediaHop(ctx: CallContext, location: string, status: number): HopTarget {
  const refuse = (why: string): JiraError =>
    ctx.fail({
      kind: 'config',
      message: `Jira answered ${ctx.method} ${ctx.route} with a ${String(status)} redirect ${why}.`,
      httpStatus: status,
      retryable: false,
      remediation:
        'Attachment downloads follow exactly one redirect, to an https host that is not private or link-local. Check JIRA_SITE and any proxy that may be rewriting the response.',
    });

  if (location === '') throw refuse('but no Location header');
  let target: URL;
  try {
    target = new URL(location, ctx.url);
  } catch {
    throw refuse('to an unparseable location');
  }
  if (target.protocol !== 'https:') throw refuse('to a non-https location');
  if (isBlockedHost(target.hostname)) {
    throw refuse(`to "${target.host}", which is never contacted`);
  }
  // No authorization, no XSRF token, no cookies: the signed URL is the only
  // credential the media host needs, and undici would strip ours anyway.
  return { url: target.toString(), headers: { accept: '*/*' } };
}
