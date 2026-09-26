import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import {
  compileAllowlist,
  gatewayHost,
  isAllowedHost,
  isCanonicalCloudHost,
  isValidCloudId,
  resolveHost,
  OAUTH_AUTH_HOST,
  OAUTH_GATEWAY_HOST,
  type HostProblemCode,
} from './host.js';
import { buildRequestUrl } from './http-util.js';
import { JiraError } from './types.js';

function codes(problems: readonly { code: HostProblemCode }[]): string[] {
  return problems.map((problem) => problem.code);
}

describe('resolveHost', () => {
  it('accepts a bare site name and completes it to .atlassian.net', () => {
    const result = resolveHost('mycompany');
    assert.deepEqual(result.host, {
      origin: 'https://mycompany.atlassian.net',
      pathPrefix: '',
    });
    assert.equal(result.hostname, 'mycompany.atlassian.net');
    assert.deepEqual(result.problems, []);
  });

  it('accepts a full host name unchanged', () => {
    const result = resolveHost('mycompany.atlassian.net');
    assert.equal(result.host?.origin, 'https://mycompany.atlassian.net');
    assert.deepEqual(result.problems, []);
  });

  it('accepts a full URL and normalizes case', () => {
    const result = resolveHost('https://MyCompany.Atlassian.NET');
    assert.equal(result.host?.origin, 'https://mycompany.atlassian.net');
    assert.deepEqual(result.problems, []);
  });

  it('strips a URL path with a warning, not an error (CC-27)', () => {
    const result = resolveHost('https://mycompany.atlassian.net/jira/software');
    assert.equal(result.host?.origin, 'https://mycompany.atlassian.net');
    assert.deepEqual(codes(result.problems), ['site_path_stripped']);
    assert.equal(result.problems[0]?.severity, 'warning');
  });

  it('resolves an empty path prefix in v1', () => {
    assert.equal(resolveHost('mycompany').host?.pathPrefix, '');
  });

  it('reports a missing site as an error naming JIRA_SITE', () => {
    for (const value of [undefined, '', '   ']) {
      const result = resolveHost(value);
      assert.equal(result.host, undefined);
      assert.deepEqual(codes(result.problems), ['site_missing']);
      assert.equal(result.problems[0]?.field, 'JIRA_SITE');
    }
  });

  it('rejects a non-https scheme', () => {
    const result = resolveHost('http://mycompany.atlassian.net');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['site_scheme']);
  });

  it('rejects embedded credentials', () => {
    const result = resolveHost('https://user:pass@mycompany.atlassian.net');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['site_credentials']);
  });

  it('rejects a malformed host', () => {
    const result = resolveHost('https://not_a host!/');
    assert.equal(result.host, undefined);
    assert.equal(
      result.problems.some((p) => p.code === 'site_malformed'),
      true,
    );
  });

  it('rejects a host the URL parser accepts but DNS would not', () => {
    // WHATWG URL parsing tolerates underscores and IP literals; the resolver
    // does not, because the value is interpolated into every request URL and
    // the allowlist compares DNS names.
    for (const site of [
      'https://exa_mple.com',
      'https://[::1]',
      'https://a-.example.com',
    ]) {
      const result = resolveHost(site);
      assert.equal(result.host, undefined, site);
      assert.deepEqual(codes(result.problems), ['site_malformed'], site);
      assert.match(String(result.problems[0]?.message), /not a valid DNS name/);
    }
  });

  it('rejects a port on a canonical Cloud host', () => {
    const result = resolveHost('https://mycompany.atlassian.net:8443');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['site_port']);
  });

  it('[CC-143] a bare host:port is a host with a port, not a URL scheme', () => {
    const kept = resolveHost('jira.example.com:8443', ['jira.example.com']);
    assert.equal(kept.host?.origin, 'https://jira.example.com:8443');
    assert.deepEqual(kept.problems, []);
    // On a canonical Cloud host the port is still refused — as a port.
    const cloud = resolveHost('mycompany.atlassian.net:8443');
    assert.deepEqual(codes(cloud.problems), ['site_port']);
  });

  it('keeps a port on an explicitly allowlisted host', () => {
    const result = resolveHost('https://jira.example.com:8443', ['jira.example.com']);
    assert.equal(result.host?.origin, 'https://jira.example.com:8443');
    assert.deepEqual(result.problems, []);
  });
});

describe('host allowlist (default deny)', () => {
  it('rejects a non-atlassian.net host and names JIRA_ALLOWED_HOSTS (CC-28)', () => {
    const result = resolveHost('jira.example.com');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['host_not_allowed']);
    assert.equal(result.problems[0]?.field, 'JIRA_ALLOWED_HOSTS');
    assert.match(String(result.problems[0]?.message), /JIRA_ALLOWED_HOSTS/);
  });

  it('accepts a non-atlassian.net host listed exactly', () => {
    const result = resolveHost('jira.example.com', ['jira.example.com']);
    assert.equal(result.host?.origin, 'https://jira.example.com');
    assert.deepEqual(result.problems, []);
  });

  it('[CC-179] never completes an allowlisted single-label host to a Cloud site', () => {
    for (const site of ['jira', 'https://jira']) {
      const result = resolveHost(site, ['jira']);
      assert.equal(result.host?.origin, 'https://jira', site);
      assert.deepEqual(result.problems, [], site);
    }
    const ported = resolveHost('https://jira:8443', ['jira']);
    assert.equal(ported.host?.origin, 'https://jira:8443');
  });

  it('[CC-179] a single-label host with a port is refused as itself, not as a Cloud site', () => {
    const result = resolveHost('jira:8443');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['host_not_allowed']);
    assert.match(String(result.problems[0]?.message), /"jira"/);
    assert.doesNotMatch(String(result.problems[0]?.message), /atlassian\.net"/);
  });

  it('[CC-233] an allowlisted loopback, private or internal host is refused at startup', () => {
    for (const site of [
      '10.0.0.5',
      '127.0.0.1',
      'localhost',
      'jira.internal',
      'https://jira.local:8443',
    ]) {
      const host = new URL(site.includes('://') ? site : `https://${site}`).hostname;
      const result = resolveHost(site, [host]);
      assert.equal(result.host, undefined, site);
      assert.deepEqual(codes(result.problems), ['host_blocked'], site);
      assert.equal(result.problems[0]?.field, 'JIRA_SITE', site);
    }
    assert.deepEqual(resolveHost('internal.atlassian.net').problems, []);
  });

  it('rejects evil-atlassian.net — suffix matching is banned', () => {
    assert.equal(isCanonicalCloudHost('evil-atlassian.net'), false);
    assert.equal(isAllowedHost('evil-atlassian.net'), false);
    const result = resolveHost('https://evil-atlassian.net');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['host_not_allowed']);
  });

  it('rejects a host that merely ends with an allowlisted entry', () => {
    assert.equal(isAllowedHost('evil-example.com', ['example.com']), false);
    assert.equal(isAllowedHost('jira.example.com.evil.net', ['jira.example.com']), false);
  });

  it('[CC-231] refuses an unanchored regex entry instead of wrapping it', () => {
    const allow = ['/jira\\.example\\.com/'];
    const compiled = compileAllowlist(allow);
    assert.deepEqual(compiled.matchers, []);
    assert.deepEqual(codes(compiled.problems), ['allowlist_invalid_pattern']);
    assert.equal(compiled.problems[0]?.severity, 'error');
    assert.match(String(compiled.problems[0]?.message), /not anchored/);
    assert.match(
      String(compiled.problems[0]?.message),
      /\/\^jira\\\.example\\\.com\$\//,
      'the message spells the anchored fix',
    );
    assert.equal(isAllowedHost('jira.example.com', allow), false);
    // Half an anchor is still unanchored.
    assert.equal(compileAllowlist(['/^jira\\.example\\.com/']).matchers.length, 0);
    assert.equal(compileAllowlist(['/jira\\.example\\.com$/']).matchers.length, 0);
  });

  it('[CC-231] still wraps an anchored alternation so it cannot match a suffix', () => {
    const allow = ['/^jira\\.example\\.com|other\\.example\\.com$/'];
    assert.equal(isAllowedHost('jira.example.com', allow), true);
    assert.equal(isAllowedHost('jira.example.com.attacker.net', allow), false);
  });

  it('[CC-231] refuses suffix forms of an exact host', () => {
    const compiled = compileAllowlist(['*.example.com', '.example.com']);
    assert.deepEqual(compiled.matchers, []);
    assert.deepEqual(codes(compiled.problems), [
      'allowlist_invalid_pattern',
      'allowlist_invalid_pattern',
    ]);
  });

  it('supports an anchored regex written with explicit anchors', () => {
    const allow = ['/^jira\\.[a-z]+\\.example\\.com$/'];
    assert.equal(isAllowedHost('jira.eu.example.com', allow), true);
    assert.equal(isAllowedHost('jira.eu.example.com.evil.net', allow), false);
  });

  it('reports an invalid allowlist entry as an error instead of denying silently', () => {
    const bad = compileAllowlist(['/([/', 'not a host']);
    assert.deepEqual(bad.matchers, []);
    assert.deepEqual(codes(bad.problems), [
      'allowlist_invalid_pattern',
      'allowlist_invalid_pattern',
    ]);
    assert.equal(bad.problems[0]?.severity, 'error');
  });

  it('surfaces allowlist problems through resolveHost', () => {
    const result = resolveHost('mycompany', ['not a host']);
    assert.equal(result.host?.origin, 'https://mycompany.atlassian.net');
    assert.deepEqual(codes(result.problems), ['allowlist_invalid_pattern']);
  });

  it('ignores empty entries and trims whitespace', () => {
    assert.equal(isAllowedHost('jira.example.com', ['', '  jira.example.com  ']), true);
    assert.equal(
      isAllowedHost('', ['jira.example.com']),
      false,
      'an empty host matches nothing',
    );
    assert.equal(isAllowedHost('   ', ['jira.example.com']), false);
  });

  it('allows any canonical Cloud host without an allowlist', () => {
    assert.equal(isAllowedHost('anything.atlassian.net'), true);
    assert.equal(isAllowedHost('sub.domain.atlassian.net'), false);
  });
});

const CLOUD_ID = '11223344-5566-7788-99aa-bbccddeeff00';
const GATEWAY_ORIGIN = `https://${OAUTH_GATEWAY_HOST}`;

/**
 * The cloudId is the one component of a gateway URL that the operator did not
 * write: it arrives from an Atlassian response, or from an env var pasted out of
 * a login run. So the interesting cases are not typos but path metacharacters —
 * each of these, left unchecked, would address a different site or a different
 * API than the caller asked for.
 */
test('a cloudId containing a slash or dot-segment is refused before a URL is built [CC-101]', () => {
  const hostile = [
    'cid/../../../rest/api/3/myself',
    '../other-tenant',
    '..',
    'cid/extra',
    '/cid',
    'cid?expand=all',
    'cid#fragment',
    'cid%2f..',
    'evil.example.com',
    'other.atlassian.net',
    'cid:8443',
    'cid with space',
    '',
  ];

  for (const value of hostile) {
    assert.equal(isValidCloudId(value), false, value);
    assert.throws(
      () => gatewayHost(GATEWAY_ORIGIN, value),
      (error: unknown) =>
        error instanceof JiraError &&
        error.kind === 'config' &&
        // The refusal names the value, so an operator can see which env var to
        // fix — but it never becomes part of a URL on the way out.
        error.message.includes(JSON.stringify(value)),
      value,
    );
  }
});

describe('the OAuth gateway address', () => {
  it('names the token host and the API host apart', () => {
    assert.equal(OAUTH_AUTH_HOST, 'auth.atlassian.com');
    assert.equal(OAUTH_GATEWAY_HOST, 'api.atlassian.com');
  });

  it('accepts the identifier shape Atlassian actually mints', () => {
    assert.equal(isValidCloudId(CLOUD_ID), true);
    assert.equal(isValidCloudId('ABC123'), true);
    assert.equal(isValidCloudId('a'), true);
  });

  it('addresses one site as https://api.atlassian.com/ex/jira/<cloudId>', () => {
    assert.deepEqual(gatewayHost(GATEWAY_ORIGIN, CLOUD_ID), {
      origin: 'https://api.atlassian.com',
      pathPrefix: `/ex/jira/${CLOUD_ID}`,
    });
  });

  it('composes with buildRequestUrl into a full request URL', () => {
    const host = gatewayHost(GATEWAY_ORIGIN, CLOUD_ID);
    assert.equal(
      buildRequestUrl(host, 'v3', '/issue/ABC-1'),
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/issue/ABC-1`,
    );
    assert.equal(
      buildRequestUrl(host, 'agile', '/board', { maxResults: 50 }),
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/agile/1.0/board?maxResults=50`,
    );
  });

  it('normalizes the origin so it matches the URL that is finally sent', () => {
    assert.equal(
      gatewayHost('https://API.Atlassian.COM:443/', CLOUD_ID).origin,
      'https://api.atlassian.com',
    );
  });

  it('keeps a test override honest: an origin is a scheme and a host, nothing more', () => {
    const refused = [
      'http://api.atlassian.com',
      'https://api.atlassian.com/ex/jira',
      'https://api.atlassian.com/?tenant=other',
      'https://api.atlassian.com/#x',
      'https://user:pass@api.atlassian.com',
      'api.atlassian.com',
      'not a url',
      '',
    ];
    for (const origin of refused) {
      assert.throws(
        () => gatewayHost(origin, CLOUD_ID),
        (error: unknown) => error instanceof JiraError && error.kind === 'config',
        origin,
      );
    }
    // A private gateway is still reachable — the rule is about shape, not host.
    assert.equal(
      gatewayHost('https://gateway.test:8443', CLOUD_ID).origin,
      'https://gateway.test:8443',
    );
  });

  it('does not blanket-allow the OAuth hosts in basic mode (D97)', () => {
    assert.equal(isAllowedHost(OAUTH_GATEWAY_HOST), false);
    assert.equal(isAllowedHost(OAUTH_AUTH_HOST), false);
    // In oauth mode the settings layer appends them to the effective allowlist,
    // and only then does egress open — one mode at a time.
    assert.equal(isAllowedHost(OAUTH_GATEWAY_HOST, [OAUTH_GATEWAY_HOST]), true);
    assert.equal(
      isAllowedHost('api.atlassian.com.evil.net', [OAUTH_GATEWAY_HOST]),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Data Center host rules (D106, stage 13.2)
// ---------------------------------------------------------------------------

describe('resolveHost under JIRA_DEPLOYMENT=datacenter', () => {
  const ALLOWED = ['jira.corp.example'];
  const dc = (site: string, allowed: readonly string[] = ALLOWED) =>
    resolveHost(site, allowed, 'JIRA_SITE', 'datacenter');

  it('CC-257: keeps the context path as the path prefix, where Cloud strips it', () => {
    assert.deepEqual(dc('https://jira.corp.example/jira').host, {
      origin: 'https://jira.corp.example',
      pathPrefix: '/jira',
    });
    // A trailing slash is the browser's spelling of the same base URL.
    assert.equal(dc('https://jira.corp.example/jira/').host?.pathPrefix, '/jira');
    assert.equal(
      dc('jira.corp.example:8443/jira').host?.origin,
      'https://jira.corp.example:8443',
    );
    assert.equal(dc('https://jira.corp.example').host?.pathPrefix, '');
    assert.deepEqual(dc('https://jira.corp.example/jira').problems, []);
    // Cloud behaviour is untouched (CC-27): same shape of URL, path stripped.
    const cloud = resolveHost('https://jira.corp.example/jira', ALLOWED);
    assert.equal(cloud.host?.pathPrefix, '');
    assert.deepEqual(codes(cloud.problems), ['site_path_stripped']);
  });

  it('CC-257: a query or fragment is still stripped with a warning, the path kept', () => {
    const result = dc('https://jira.corp.example/jira?os_authType=basic#x');
    assert.equal(result.host?.pathPrefix, '/jira');
    assert.deepEqual(codes(result.problems), ['site_path_stripped']);
    assert.equal(result.problems[0]?.severity, 'warning');
    assert.match(result.problems[0]?.message ?? '', /context path, if any, is kept/);
  });

  it('CC-257: the context path composes with the v2 root into one request URL', () => {
    const host = dc('https://jira.corp.example/jira').host;
    assert.ok(host !== undefined);
    assert.equal(
      buildRequestUrl(host, 'v2', '/issue/ABC-1'),
      'https://jira.corp.example/jira/rest/api/2/issue/ABC-1',
    );
  });

  it('CC-258: an Atlassian Cloud host is refused, naming JIRA_DEPLOYMENT', () => {
    for (const site of [
      'mycompany.atlassian.net',
      'https://mycompany.atlassian.net/jira',
    ]) {
      const result = dc(site);
      assert.equal(result.host, undefined);
      assert.deepEqual(codes(result.problems), ['host_deployment_mismatch'], site);
      assert.equal(result.problems.at(-1)?.field, 'JIRA_DEPLOYMENT');
    }
  });

  it('CC-258: a dot-less name is never completed to an Atlassian Cloud host', () => {
    // On Cloud "mycompany" means mycompany.atlassian.net; on Data Center that
    // completion would send the PAT to somebody else's Cloud tenant.
    const result = dc('mycompany', []);
    assert.equal(result.host, undefined);
    assert.equal(result.hostname, 'mycompany');
    assert.deepEqual(codes(result.problems), ['host_not_allowed']);
  });

  it('CC-259: a context path that already carries the REST root is refused', () => {
    for (const site of [
      'https://jira.corp.example/rest/api/2',
      'https://jira.corp.example/jira/REST/api/latest',
    ]) {
      const result = dc(site);
      assert.equal(result.host, undefined, site);
      assert.deepEqual(codes(result.problems), ['site_context_path'], site);
      assert.match(result.problems[0]?.message ?? '', /base URL/);
    }
    // A segment that merely starts with "rest" is a real context path.
    assert.equal(
      dc('https://jira.corp.example/restricted').host?.pathPrefix,
      '/restricted',
    );
  });

  it('CC-259: a context path the request builder would reject is refused at startup', () => {
    // `%2e` survives URL parsing inside a segment, and `assertApiPath` refuses
    // an escaped dot on every request — so the same predicate refuses it here.
    const result = dc('https://jira.corp.example/a%2eb');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['site_context_path']);
  });
});
