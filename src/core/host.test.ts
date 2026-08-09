import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compileAllowlist,
  isAllowedHost,
  isCanonicalCloudHost,
  resolveHost,
  type HostProblemCode,
} from './host.js';

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

  it('rejects a port on a canonical Cloud host', () => {
    const result = resolveHost('https://mycompany.atlassian.net:8443');
    assert.equal(result.host, undefined);
    assert.deepEqual(codes(result.problems), ['site_port']);
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

  it('anchors regex entries on both ends', () => {
    const allow = ['/jira\\.example\\.com/'];
    assert.equal(isAllowedHost('jira.example.com', allow), true);
    assert.equal(isAllowedHost('evil.jira.example.com.attacker.net', allow), false);
    assert.equal(isAllowedHost('xjira.example.com', allow), false);
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
  });

  it('allows any canonical Cloud host without an allowlist', () => {
    assert.equal(isAllowedHost('anything.atlassian.net'), true);
    assert.equal(isAllowedHost('sub.domain.atlassian.net'), false);
  });
});
