// Host normalization and the default-deny egress allowlist (WP-11).
//
// `JIRA_SITE` accepts three shapes — `"mycompany"`, `"mycompany.atlassian.net"`
// and a full URL — and every one of them is resolved ONCE into a {@link HostRef}
// (ARCHITECTURE.md §Cross-cutting seams). Call sites never see a bare string, so
// the v2 OAuth gateway (`api.atlassian.com/ex/jira/{cloudId}`, a different origin
// plus a path prefix) becomes a change in this file rather than in every URL
// assembly.
//
// Egress policy (JIRA-API.md §Hosts, THREAT-MODEL.md §SSRF / egress): the
// canonical Cloud suffix `.atlassian.net` is allowed by default; ANY other host
// requires an explicit `JIRA_ALLOWED_HOSTS` entry. Matching is exact host or
// anchored regex — **suffix matching is banned by construction**. This is not
// style: `evil-atlassian.net` ends with the donor's `endsWith('.atlassian.net')`
// check string minus the dot, and every regex compiled here is wrapped in
// `^(?: … )$` so even a sloppy operator pattern cannot match a suffix.
//
// Private/loopback hosts are NOT blocked separately: the allowlist is
// default-deny and `JIRA_SITE` comes from the operator's environment, not from
// model-controlled input, so a second blocklist would only break the legitimate
// on-prem case without closing a hole the allowlist leaves open.

import type { HostRef } from './types.js';

/** The one host suffix that needs no allowlist entry (JIRA-API.md §Hosts). */
export const CANONICAL_SITE_SUFFIX = '.atlassian.net';

/** v1 always resolves an empty path prefix; the v2 gateway is what fills it. */
export const V1_PATH_PREFIX = '';

// Anchored on both ends: `evil-atlassian.net` cannot match, because the literal
// dot before `atlassian` is part of the pattern.
const CANONICAL_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/;

/** A DNS name: dot-separated LDH labels, no leading/trailing dot or dash. */
const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** Problem codes this module can report; stable strings, asserted in tests. */
export type HostProblemCode =
  | 'site_missing'
  | 'site_malformed'
  | 'site_credentials'
  | 'site_scheme'
  | 'site_port'
  | 'site_path_stripped'
  | 'host_not_allowed'
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
 * - `/pattern/` — a regular expression, slash-delimited. The source is wrapped
 *   in `^(?: … )$` before compilation, so an operator who forgets the anchors
 *   still gets whole-host matching instead of an accidental suffix rule.
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
 */
export function resolveHost(
  rawSite: string | undefined,
  allowedHosts: readonly string[] = [],
): HostResolution {
  const problems: HostProblem[] = [];
  const allowlist = compileAllowlist(allowedHosts);
  problems.push(...allowlist.problems);

  const site = rawSite?.trim() ?? '';
  if (site.length === 0) {
    problems.push(
      problem(
        'error',
        'site_missing',
        'JIRA_SITE is not set. Set it to your site name ("mycompany"), host ("mycompany.atlassian.net") or full URL.',
        'JIRA_SITE',
      ),
    );
    return { problems };
  }

  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(site);
  let url: URL;
  try {
    url = new URL(hasScheme ? site : `https://${site}`);
  } catch {
    problems.push(
      problem(
        'error',
        'site_malformed',
        `JIRA_SITE ${JSON.stringify(site)} is not a usable site name, host or URL. Use "mycompany", "mycompany.atlassian.net" or "https://mycompany.atlassian.net".`,
        'JIRA_SITE',
      ),
    );
    return { problems };
  }

  if (url.protocol !== 'https:') {
    problems.push(
      problem(
        'error',
        'site_scheme',
        `JIRA_SITE uses the ${url.protocol} scheme; only https is accepted (the API token travels in an Authorization header). Drop the scheme or use https://.`,
        'JIRA_SITE',
      ),
    );
    return { problems };
  }

  if (url.username !== '' || url.password !== '') {
    problems.push(
      problem(
        'error',
        'site_credentials',
        'JIRA_SITE must not embed credentials (user:password@host). Put the account in JIRA_EMAIL and the token in JIRA_API_TOKEN.',
        'JIRA_SITE',
      ),
    );
    return { problems };
  }

  if (
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    problems.push(
      problem(
        'warning',
        'site_path_stripped',
        `JIRA_SITE ${JSON.stringify(site)} carries a path/query; only the origin is used. Requests are built from the API root, so the extra part is ignored.`,
        'JIRA_SITE',
      ),
    );
  }

  let hostname = url.hostname.toLowerCase();
  if (!HOSTNAME_RE.test(hostname)) {
    problems.push(
      problem(
        'error',
        'site_malformed',
        `JIRA_SITE resolves to host ${JSON.stringify(hostname)}, which is not a valid DNS name (letters, digits, hyphens and dots only; no IP literals). Use the site host name.`,
        'JIRA_SITE',
      ),
    );
    return { problems };
  }

  // A dot-less value is a site NAME, not a host: complete it to the canonical
  // Cloud suffix, which is the shape the docs advertise ("mycompany").
  if (!hostname.includes('.')) {
    hostname = `${hostname}${CANONICAL_SITE_SUFFIX}`;
  }

  const canonical = isCanonicalCloudHost(hostname);
  const allowlisted = allowlist.matchers.some((m) => m.matches(hostname));

  if (!canonical && !allowlisted) {
    problems.push(
      problem(
        'error',
        'host_not_allowed',
        `JIRA_SITE host ${JSON.stringify(hostname)} is not ${CANONICAL_SITE_SUFFIX} and is not listed in JIRA_ALLOWED_HOSTS. Add it there (exact host or /anchored-regex/) to allow requests to it.`,
        'JIRA_ALLOWED_HOSTS',
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
        `JIRA_SITE names port ${url.port} on ${hostname}; a port is only accepted for a host listed in JIRA_ALLOWED_HOSTS. Drop the port for Jira Cloud.`,
        'JIRA_SITE',
      ),
    );
    return { hostname, problems };
  }

  const origin = `https://${hostname}${url.port === '' ? '' : `:${url.port}`}`;
  return {
    host: { origin, pathPrefix: V1_PATH_PREFIX },
    hostname,
    problems,
  };
}
