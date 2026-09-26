// Host normalization and the default-deny egress allowlist (WP-11).
//
// `JIRA_SITE` accepts three shapes — `"mycompany"`, `"mycompany.atlassian.net"`
// and a full URL — and every one of them is resolved ONCE into a {@link HostRef}
// (ARCHITECTURE.md §Cross-cutting seams). Call sites never see a bare string,
// and that bet has now been collected: the OAuth 2.0 (3LO) gateway addresses a
// site as `api.atlassian.com/ex/jira/{cloudId}` — a different origin AND a path
// prefix — and `gatewayHost` below returns it in the same two-field shape, so
// not one URL-assembly site had to learn that a second addressing scheme exists.
//
// Egress policy (JIRA-API.md §Hosts, THREAT-MODEL.md §SSRF / egress): the
// canonical Cloud suffix `.atlassian.net` is allowed by default; ANY other host
// requires an explicit `JIRA_ALLOWED_HOSTS` entry. Matching is exact host or
// anchored regex — **suffix matching is banned by construction**. This is not
// style: `evil-atlassian.net` ends with the donor's `endsWith('.atlassian.net')`
// check string minus the dot, and every regex compiled here is wrapped in
// `^(?: … )$` so even a sloppy operator pattern cannot match a suffix.
//
// Private/loopback hosts are NOT blocked here — this module only decides what
// the allowlist covers. The blocklist lives in `http-util.ts` (`checkHost`) and
// runs at request time BEFORE the allowlist, so an entry here can make a public
// host reachable but never a loopback, private, link-local or metadata one.
//
// The two Atlassian OAuth hosts named below are deliberately NOT blanket-allowed
// by `isAllowedHost`: in oauth mode `loadSettings` appends them to the effective
// `allowedHosts` and in basic mode it does not (D97). A predicate that always
// said yes would silently widen the egress of every deployment that never
// enables OAuth, and it would move the decision out of the configuration an
// operator can read into a constant nobody looks at.

import { assertApiPath, isBlockedHost } from './http-util.js';
import { JiraError } from './types.js';
import type { HostRef, JiraDeployment } from './types.js';

/** The one host suffix that needs no allowlist entry (JIRA-API.md §Hosts). */
export const CANONICAL_SITE_SUFFIX = '.atlassian.net';

/** v1 always resolves an empty path prefix; the v2 gateway is what fills it. */
export const V1_PATH_PREFIX = '';

/** Where a 3LO access token addresses a site: `/ex/jira/{cloudId}` under it. */
export const OAUTH_GATEWAY_HOST = 'api.atlassian.com';

/** Where the OAuth authorize and token endpoints live. */
export const OAUTH_AUTH_HOST = 'auth.atlassian.com';

// Anchored on both ends: `evil-atlassian.net` cannot match, because the literal
// dot before `atlassian` is part of the pattern.
const CANONICAL_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;

/** A DNS name: dot-separated LDH labels, no leading/trailing dot or dash. */
const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

// Anchored on both ends, and drawn from the smallest alphabet an identifier can
// need. The point is not that Atlassian happens to mint UUIDs — it is that a
// cloudId is interpolated straight into a URL path, and letters, digits and
// hyphens are exactly the characters that cannot mean anything else there. `/`,
// `.`, `%`, `?`, `#`, `:` and whitespace are absent by construction, so a
// cloudId can never inject a path segment, a dot-segment, a percent-escape, a
// query, a fragment or a second host into the URL built from it (CC-101).
const CLOUD_ID_RE = /^[a-z0-9-]+$/i;

/** Problem codes this module can report; stable strings, asserted in tests. */
export type HostProblemCode =
  | 'site_missing'
  | 'site_malformed'
  | 'site_credentials'
  | 'site_scheme'
  | 'site_port'
  | 'site_path_stripped'
  | 'site_context_path'
  | 'host_deployment_mismatch'
  | 'host_not_allowed'
  | 'host_blocked'
  | 'allowlist_invalid_pattern';

/** Severity of a host problem; mirrors the startup-report severities. */
export type HostProblemSeverity = 'error' | 'warning';

/** One thing wrong with `JIRA_SITE` / `JIRA_ALLOWED_HOSTS`. */
export interface HostProblem {
  readonly severity: HostProblemSeverity;
  readonly code: HostProblemCode;
  /** Cause first, then the recovery action — same rule as `JiraError`. */
  readonly message: string;
  /** The env var the operator has to edit. */
  readonly field: string;
}

/**
 * Result of {@link resolveHost}. `host` is present iff there is no
 * error-severity problem — warnings (a stripped path, CC-27) still resolve.
 */
export interface HostResolution {
  readonly host?: HostRef;
  /** The normalized hostname, present whenever one could be parsed at all. */
  readonly hostname?: string;
  readonly problems: readonly HostProblem[];
}

/** A compiled `JIRA_ALLOWED_HOSTS` entry. */
export interface AllowlistMatcher {
  /** The entry exactly as the operator wrote it (for messages). */
  readonly source: string;
  readonly kind: 'exact' | 'regex';
  matches(hostname: string): boolean;
}

/** Compiled allowlist plus whatever was wrong with it. */
export interface CompiledAllowlist {
  readonly matchers: readonly AllowlistMatcher[];
  readonly problems: readonly HostProblem[];
}

function problem(
  severity: HostProblemSeverity,
  code: HostProblemCode,
  message: string,
  field: string,
): HostProblem {
  return { severity, code, message, field };
}

/** True for `<site>.atlassian.net` and nothing else — anchored, never a suffix test. */
export function isCanonicalCloudHost(hostname: string): boolean {
  return CANONICAL_HOST_RE.test(hostname.toLowerCase());
}

/**
 * Compile `JIRA_ALLOWED_HOSTS` entries.
 *
 * Two forms are accepted:
 * - `jira.example.com` — an exact host, compared case-insensitively;
 * - `/^pattern$/` — a regular expression, slash-delimited and anchored with
 *   `^` and `$`. An unanchored `/pattern/` is refused here, at startup, because
 *   the request-time check (`checkHost` in `http-util.ts`) refuses it too: a
 *   pattern that passes startup and then fails every call is a deferred crash,
 *   not an allowlist (CC-231). The source is still wrapped in `^(?: … )$`
 *   before compilation, so `^a|b$` cannot match a suffix either.
 *
 * An unparseable entry is an error-severity problem, never a silently dropped
 * one: a typo in an allowlist must fail startup, not quietly deny.
 */
export function compileAllowlist(entries: readonly string[]): CompiledAllowlist {
  const matchers: AllowlistMatcher[] = [];
  const problems: HostProblem[] = [];

  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;

    if (entry.length > 2 && entry.startsWith('/') && entry.endsWith('/')) {
      const source = entry.slice(1, -1);
      if (!source.startsWith('^') || !source.endsWith('$')) {
        problems.push(
          problem(
            'error',
            'allowlist_invalid_pattern',
            `JIRA_ALLOWED_HOSTS entry ${JSON.stringify(entry)} is not anchored. Write it as /^${source.replace(/^\^/, '').replace(/\$$/, '')}$/ — an unanchored pattern matches substrings, which defeats the allowlist.`,
            'JIRA_ALLOWED_HOSTS',
          ),
        );
        continue;
      }
      let re: RegExp;
      try {
        re = new RegExp(`^(?:${source})$`, 'i');
      } catch (cause) {
        problems.push(
          problem(
            'error',
            'allowlist_invalid_pattern',
            `JIRA_ALLOWED_HOSTS entry ${JSON.stringify(entry)} is not a valid regular expression (${String(cause)}). Fix the pattern or use a plain host name.`,
            'JIRA_ALLOWED_HOSTS',
          ),
        );
        continue;
      }
      matchers.push({
        source: entry,
        kind: 'regex',
        matches: (hostname) => re.test(hostname),
      });
      continue;
    }

    const exact = entry.toLowerCase();
    if (!HOSTNAME_RE.test(exact)) {
      problems.push(
        problem(
          'error',
          'allowlist_invalid_pattern',
          `JIRA_ALLOWED_HOSTS entry ${JSON.stringify(entry)} is not a valid host name. Use an exact host (jira.example.com) or a slash-delimited regex (/^jira\\..*\\.example\\.com$/).`,
          'JIRA_ALLOWED_HOSTS',
        ),
      );
      continue;
    }
    matchers.push({
      source: entry,
      kind: 'exact',
      matches: (hostname) => hostname === exact,
    });
  }

  return { matchers, problems };
}

/**
 * The egress predicate: canonical Cloud host, or an explicit allowlist match.
 * `core/http.ts` uses it for redirect targets, where only the verdict matters.
 */
export function isAllowedHost(
  hostname: string,
  allowedHosts: readonly string[] = [],
): boolean {
  const host = hostname.trim().toLowerCase();
  if (host.length === 0) return false;
  if (isCanonicalCloudHost(host)) return true;
  return compileAllowlist(allowedHosts).matchers.some((m) => m.matches(host));
}

/**
 * Normalize a `JIRA_SITE` value into a {@link HostRef}, collecting every problem
 * instead of throwing on the first one — the startup report prints them all at
 * once (CONFIGURATION.md).
 *
 * Accepted inputs: `mycompany`, `mycompany.atlassian.net`,
 * `https://mycompany.atlassian.net`, `https://mycompany.atlassian.net/jira/x`
 * (path stripped with a warning — CC-27).
 *
 * `siteVariable` is the variable the value was read from, for the messages: an
 * active profile's `JIRA_PROFILE_<NAME>_SITE` overrides `JIRA_SITE`, and a
 * message naming the variable that was NOT used sends the operator to edit the
 * wrong line (CC-189).
 */
export function resolveHost(
  rawSite: string | undefined,
  allowedHosts: readonly string[] = [],
  siteVariable = 'JIRA_SITE',
  deployment: JiraDeployment = 'cloud',
): HostResolution {
  const datacenter = deployment === 'datacenter';
  const problems: HostProblem[] = [];
  const allowlist = compileAllowlist(allowedHosts);
  problems.push(...allowlist.problems);

  const site = rawSite?.trim() ?? '';
  if (site.length === 0) {
    problems.push(
      problem(
        'error',
        'site_missing',
        `${siteVariable} is not set. Set it to your site name ("mycompany"), host ("mycompany.atlassian.net") or full URL.`,
        siteVariable,
      ),
    );
    return { problems };
  }

  // A scheme is `name://`: a bare `host:port` also matches `name:`, and would be
  // read as a URL with the scheme `host:` (CC-143).
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(site);
  let url: URL;
  try {
    url = new URL(hasScheme ? site : `https://${site}`);
  } catch {
    problems.push(
      problem(
        'error',
        'site_malformed',
        `${siteVariable} ${JSON.stringify(site)} is not a usable site name, host or URL. Use "mycompany", "mycompany.atlassian.net" or "https://mycompany.atlassian.net".`,
        siteVariable,
      ),
    );
    return { problems };
  }

  if (url.protocol !== 'https:') {
    problems.push(
      problem(
        'error',
        'site_scheme',
        `${siteVariable} uses the ${url.protocol} scheme; only https is accepted (the API token travels in an Authorization header). Drop the scheme or use https://.`,
        siteVariable,
      ),
    );
    return { problems };
  }

  if (url.username !== '' || url.password !== '') {
    problems.push(
      problem(
        'error',
        'site_credentials',
        `${siteVariable} must not embed credentials (user:password@host). Put the account in JIRA_EMAIL and the token in JIRA_API_TOKEN.`,
        siteVariable,
      ),
    );
    return { problems };
  }

  // Cloud serves Jira at the root of its host, so a path there is noise and is
  // stripped (CC-27). A Data Center instance is commonly deployed under a
  // context path (`https://jira.corp.example/jira`), and dropping it would miss
  // it on every request (D104's one missing cheap thing) — so under
  // `datacenter` the path is KEPT as the host's path prefix. A query or a
  // fragment is noise on either product.
  const hasPath = url.pathname !== '' && url.pathname !== '/';
  const contextPath = datacenter && hasPath ? url.pathname.replace(/\/+$/, '') : '';
  if ((hasPath && !datacenter) || url.search !== '' || url.hash !== '') {
    problems.push(
      problem(
        'warning',
        'site_path_stripped',
        datacenter
          ? `${siteVariable} ${JSON.stringify(site)} carries a query or fragment; it is ignored. The context path, if any, is kept.`
          : `${siteVariable} ${JSON.stringify(site)} carries a path/query; only the origin is used. Requests are built from the API root, so the extra part is ignored.`,
        siteVariable,
      ),
    );
  }
  if (contextPath !== '') {
    const refusal = contextPathProblem(contextPath, site, siteVariable);
    if (refusal !== undefined) {
      problems.push(refusal);
      return { problems };
    }
  }

  let hostname = url.hostname.toLowerCase();
  if (!HOSTNAME_RE.test(hostname)) {
    problems.push(
      problem(
        'error',
        'site_malformed',
        `${siteVariable} resolves to host ${JSON.stringify(hostname)}, which is not a valid DNS name (letters, digits, hyphens and dots only; no IP literals). Use the site host name.`,
        siteVariable,
      ),
    );
    return { problems };
  }

  // A dot-less value is a site NAME, not a host: complete it to the canonical
  // Cloud suffix, which is the shape the docs advertise ("mycompany"). Not when
  // the operator allowlisted that very name (an internal single-label host) or
  // gave it a port: completing either would send the credentials to somebody
  // else's Cloud site (CC-179).
  // Never under `datacenter`: completing a Data Center host name to an
  // Atlassian Cloud one would send its credentials to somebody else's tenant.
  const allowlistedAsGiven = allowlist.matchers.some((m) => m.matches(hostname));
  if (!datacenter && !hostname.includes('.') && url.port === '' && !allowlistedAsGiven) {
    hostname = `${hostname}${CANONICAL_SITE_SUFFIX}`;
  }

  const canonical = isCanonicalCloudHost(hostname);
  const allowlisted = allowlist.matchers.some((m) => m.matches(hostname));

  if (datacenter && canonical) {
    problems.push(
      problem(
        'error',
        'host_deployment_mismatch',
        `JIRA_DEPLOYMENT=datacenter, but ${siteVariable} host ${JSON.stringify(hostname)} is an Atlassian Cloud site. Point ${siteVariable} at your Data Center base URL, or unset JIRA_DEPLOYMENT for Cloud.`,
        'JIRA_DEPLOYMENT',
      ),
    );
    return { hostname, problems };
  }

  if (!canonical && !allowlisted) {
    problems.push(
      problem(
        'error',
        'host_not_allowed',
        `${siteVariable} host ${JSON.stringify(hostname)} is not ${CANONICAL_SITE_SUFFIX} and is not listed in JIRA_ALLOWED_HOSTS. Add it there (exact host or /anchored-regex/) to allow requests to it.`,
        'JIRA_ALLOWED_HOSTS',
      ),
    );
    return { hostname, problems };
  }

  // The request layer's blocklist runs before its allowlist, so an allowlisted
  // loopback, private or metadata host (`10.0.0.5`, `localhost`,
  // `jira.internal`) would start cleanly and then fail every request. Refused
  // here, the one error names the cause; no allowlist entry can fix it (CC-233).
  if (isBlockedHost(hostname)) {
    problems.push(
      problem(
        'error',
        'host_blocked',
        `${siteVariable} host ${JSON.stringify(hostname)} is a loopback, private, link-local or metadata address, which is never contacted — not even when it is in JIRA_ALLOWED_HOSTS. Point ${siteVariable} at a public host name.`,
        siteVariable,
      ),
    );
    return { hostname, problems };
  }

  // A port on a canonical Cloud host is never right and would let a typo point
  // the client at an unexpected service on the same name; on an explicitly
  // allowlisted host (an on-prem gateway) it is legitimate.
  if (url.port !== '' && !allowlisted) {
    problems.push(
      problem(
        'error',
        'site_port',
        `${siteVariable} names port ${url.port} on ${hostname}; a port is only accepted for a host listed in JIRA_ALLOWED_HOSTS. Drop the port for Jira Cloud.`,
        siteVariable,
      ),
    );
    return { hostname, problems };
  }

  const origin = `https://${hostname}${url.port === '' ? '' : `:${url.port}`}`;
  return {
    host: { origin, pathPrefix: contextPath === '' ? V1_PATH_PREFIX : contextPath },
    hostname,
    problems,
  };
}

/**
 * Why a Data Center context path cannot be used, or `undefined` when it can.
 *
 * The request builder re-validates `HostRef.pathPrefix` with `assertApiPath`
 * on every call; running the same predicate here turns what would be a failure
 * on the first tool call into one startup finding (the CC-101 rule: one
 * spelling of the check). A path that already contains the REST root is the
 * other mistake worth naming — `https://jira.corp/rest/api/2` would otherwise
 * build `/rest/api/2/rest/api/2/...`.
 */
function contextPathProblem(
  contextPath: string,
  site: string,
  siteVariable: string,
): HostProblem | undefined {
  if (/(^|\/)rest(\/|$)/i.test(contextPath)) {
    return problem(
      'error',
      'site_context_path',
      `${siteVariable} ${JSON.stringify(site)} includes the REST API path. Give the base URL of the Jira instance — what you open in a browser, e.g. https://jira.example.com/jira — and the API root is added per request.`,
      siteVariable,
    );
  }
  try {
    assertApiPath(contextPath);
  } catch {
    return problem(
      'error',
      'site_context_path',
      `${siteVariable} ${JSON.stringify(site)} has a context path that cannot be used as a request prefix (a dot segment, an escaped dot, a backslash, whitespace or a control character). Use the base URL exactly as the browser shows it.`,
      siteVariable,
    );
  }
  return undefined;
}

/* ------------------------------------------------------------------------- *
 * The OAuth 2.0 (3LO) gateway
 * ------------------------------------------------------------------------- */

/**
 * Is this a cloudId that can be interpolated into a path without changing what
 * the path means? Anchored; letters, digits and hyphens only.
 *
 * A cloudId is the one part of the gateway address that does NOT come from the
 * operator's environment — it arrives from `/oauth/token/accessible-resources`,
 * or from an env var an operator copied out of a login run — so it is treated as
 * untrusted input and checked before it is used, not after.
 */
export function isValidCloudId(value: string): boolean {
  return CLOUD_ID_RE.test(value);
}

/**
 * Resolve the {@link HostRef} of one Jira site behind the OAuth gateway:
 * `https://api.atlassian.com` plus the `/ex/jira/<cloudId>` prefix that every
 * request path is then appended to.
 *
 * The cloudId is validated FIRST, and rejected rather than escaped. Escaping
 * would make `../` survive as `%2E%2E%2F` and leave a decoder somewhere in the
 * chain free to disagree with us about what the path was; refusing means no URL
 * is built at all from a value that was never a cloudId (CC-101). `buildRequestUrl`
 * re-checks the assembled prefix, which is the second line of defence, not the
 * first.
 *
 * The origin is validated the way `hostFromOrigin` validates `JIRA_SITE` —
 * https, no embedded credentials, scheme and host only. It is configurable
 * (`JIRA_OAUTH_GATEWAY_ORIGIN`) only so an offline fake is reachable in tests;
 * that override must not double as a way to smuggle a path onto every request.
 *
 * @throws JiraError `kind: 'config'` for a malformed cloudId or origin.
 */
export function gatewayHost(gatewayOrigin: string, cloudId: string): HostRef {
  if (!isValidCloudId(cloudId)) {
    throw new JiraError({
      kind: 'config',
      message: `The Jira cloudId ${JSON.stringify(cloudId)} is not a plain identifier (letters, digits and hyphens only), so no request URL was built from it.`,
      remediation:
        'Set JIRA_OAUTH_CLOUD_ID to the id that `jira-mcp-ai login` printed, or unset it and let the login discover the site.',
    });
  }

  const refuse = (why: string, cause?: unknown): JiraError =>
    new JiraError({
      kind: 'config',
      message: `The OAuth gateway origin ${JSON.stringify(gatewayOrigin)} ${why}.`,
      remediation: `Unset JIRA_OAUTH_GATEWAY_ORIGIN to use https://${OAUTH_GATEWAY_HOST}, or set it to a bare https origin with no path.`,
      cause,
    });

  let url: URL;
  try {
    url = new URL(gatewayOrigin);
  } catch (cause) {
    throw refuse('is not a valid URL', cause);
  }
  if (url.protocol !== 'https:') throw refuse('is not https');
  if (url.username !== '' || url.password !== '') {
    throw refuse('must not embed credentials');
  }
  if (
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw refuse('must be a scheme and a host only, with no path, query or fragment');
  }

  // `url.origin` rather than the raw string: it lowercases the host and drops a
  // redundant `:443`, so the result compares equal to what `buildRequestUrl`
  // recomputes from the assembled URL.
  return { origin: url.origin, pathPrefix: `/ex/jira/${cloudId}` };
}
