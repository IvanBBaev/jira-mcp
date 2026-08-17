import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeClock } from './fakes/index.js';
import { withEnv } from '../testing/with-env.js';
import {
  DEFAULT_CALL_BUDGET_MS,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_HTTP_PORT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_TOOL_PACKAGES,
  DEFAULT_TRANSPORT,
  DEFAULT_WRITE_MODE,
  assertStartupOk,
  collectSecrets,
  formatStartupReport,
  loadSettings,
  type LoadSettingsOptions,
  type StartupReport,
} from './settings.js';
import { JiraError } from './types.js';

/**
 * `JIRA_PROFILE_<NAME>_<FIELD>` assembled at runtime: spelling the concrete
 * names out would put env names in `src/**` that CONFIGURATION.md documents only
 * as a pattern (TESTING.md suite 8).
 */
function profileVar(name: string, field: 'SITE' | 'EMAIL' | 'API_TOKEN'): string {
  return `JIRA_PROFILE_${name.toUpperCase()}_${field}`;
}

const VALID = {
  JIRA_SITE: 'mycompany',
  JIRA_EMAIL: 'me@example.com',
  JIRA_API_TOKEN: 'token-active',
} as const;

function load(
  env: Record<string, string | undefined>,
  options: Omit<LoadSettingsOptions, 'env'> = {},
): ReturnType<typeof loadSettings> {
  return loadSettings({ ...options, env });
}

function codes(report: StartupReport): string[] {
  return report.findings.map((finding) => finding.code);
}

describe('loadSettings — shape and gate', () => {
  it('returns { settings, report } and never throws on a bad environment', () => {
    const result = load({});
    assert.equal(typeof result.settings, 'object');
    assert.equal(result.report.ok, false);
    assert.equal(result.report.worst, 'error');
    assert.equal(result.report.errors.length > 0, true);
  });

  it('accepts a minimal valid environment with a clean report', () => {
    const { settings, report, host } = load({ ...VALID });
    assert.deepEqual(report.findings, []);
    assert.equal(report.ok, true);
    assert.equal(report.worst, undefined);
    assert.equal(settings.site, 'mycompany');
    assert.deepEqual(host, { origin: 'https://mycompany.atlassian.net', pathPrefix: '' });
  });

  it('assertStartupOk fails closed on error-severity findings', () => {
    const { report } = load({ ...VALID, JIRA_SITE: undefined });
    assert.throws(
      () => {
        assertStartupOk(report);
      },
      (error: unknown) => {
        assert.ok(error instanceof JiraError);
        assert.equal(error.kind, 'config');
        assert.match(error.message, /JIRA_SITE/);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('assertStartupOk lets warnings through', () => {
    const { report } = load({
      ...VALID,
      JIRA_SITE: 'https://mycompany.atlassian.net/jira/software/projects',
    });
    assert.equal(report.ok, true);
    assert.deepEqual(codes(report), ['site_path_stripped']);
    assert.equal(report.worst, 'warning');
    assertStartupOk(report);
  });

  it('aggregates every problem in one pass instead of stopping at the first', () => {
    const { report } = load({
      JIRA_SITE: 'jira.example.com',
      JIRA_REQUEST_TIMEOUT_MS: 'soon',
      JIRA_WRITE_MODE: 'yolo',
    });
    assert.deepEqual(codes(report).sort(), [
      'host_not_allowed',
      'invalid_enum',
      'invalid_number',
      'missing_credential',
      'missing_credential',
    ]);
  });

  it('formatStartupReport lists errors and warnings', () => {
    const { report } = load({ JIRA_SITE: 'mycompany', JIRA_MAX_PAGES: '0' });
    const text = formatStartupReport(report);
    assert.match(text, /Configuration errors \(3\)/);
    assert.match(text, /JIRA_MAX_PAGES/);
    assert.equal(
      formatStartupReport({ ...report, errors: [], warnings: [] }),
      'Configuration OK.',
    );
  });
});

describe('loadSettings — host and allowlist', () => {
  it('accepts the three documented JIRA_SITE shapes', () => {
    for (const site of [
      'mycompany',
      'mycompany.atlassian.net',
      'https://mycompany.atlassian.net',
    ]) {
      const { host, report } = load({ ...VALID, JIRA_SITE: site });
      assert.equal(host?.origin, 'https://mycompany.atlassian.net', site);
      assert.equal(report.ok, true, site);
    }
  });

  it('refuses a non-atlassian.net host without JIRA_ALLOWED_HOSTS (CC-28)', () => {
    const { report, host } = load({ ...VALID, JIRA_SITE: 'jira.example.com' });
    assert.equal(host, undefined);
    assert.equal(report.ok, false);
    assert.match(String(report.errors[0]?.message), /JIRA_ALLOWED_HOSTS/);
  });

  it('accepts it once JIRA_ALLOWED_HOSTS lists it', () => {
    const { report, host, settings } = load({
      ...VALID,
      JIRA_SITE: 'jira.example.com',
      JIRA_ALLOWED_HOSTS: 'other.example.com, jira.example.com',
    });
    assert.equal(report.ok, true);
    assert.equal(host?.origin, 'https://jira.example.com');
    assert.deepEqual(settings.allowedHosts, ['other.example.com', 'jira.example.com']);
  });

  it('does not accept a look-alike host (evil-atlassian.net)', () => {
    const { report } = load({ ...VALID, JIRA_SITE: 'evil-atlassian.net' });
    assert.equal(report.ok, false);
    assert.deepEqual(codes(report), ['host_not_allowed']);
  });
});

describe('loadSettings — credentials', () => {
  it('reports each missing credential separately', () => {
    const { report } = load({ JIRA_SITE: 'mycompany' });
    const fields = report.errors.map((finding) => finding.field);
    assert.deepEqual(fields, ['JIRA_EMAIL', 'JIRA_API_TOKEN']);
  });

  it('rejects an email that is not an email address', () => {
    const { report } = load({ ...VALID, JIRA_EMAIL: 'admin' });
    assert.deepEqual(codes(report), ['invalid_email']);
  });
});

describe('loadSettings — profiles (v1: locked single profile)', () => {
  it('parses JIRA_PROFILE_<NAME>_* into profiles keyed by lower-cased name', () => {
    const { settings, report } = load({
      ...VALID,
      [profileVar('work', 'SITE')]: 'workco',
      [profileVar('work', 'EMAIL')]: 'me@work.example.com',
      [profileVar('work', 'API_TOKEN')]: 'token-work',
    });
    assert.equal(report.ok, true);
    assert.deepEqual(settings.profiles.work, {
      name: 'work',
      site: 'workco',
      email: 'me@work.example.com',
      apiToken: 'token-work',
    });
  });

  it('uses the active profile credentials for host resolution', () => {
    const { host, report } = load({
      ...VALID,
      JIRA_ACTIVE_PROFILE: 'work',
      [profileVar('WORK', 'SITE')]: 'workco',
      [profileVar('WORK', 'EMAIL')]: 'me@work.example.com',
      [profileVar('WORK', 'API_TOKEN')]: 'token-work',
    });
    assert.equal(report.ok, true);
    assert.equal(host?.origin, 'https://workco.atlassian.net');
  });

  it('falls back field by field to the top-level credentials', () => {
    const { host, report } = load({
      ...VALID,
      JIRA_ACTIVE_PROFILE: 'work',
      [profileVar('work', 'API_TOKEN')]: 'token-work',
    });
    assert.equal(report.ok, true);
    assert.equal(host?.origin, 'https://mycompany.atlassian.net');
  });

  it('reports an unknown JIRA_ACTIVE_PROFILE', () => {
    const { report } = load({ ...VALID, JIRA_ACTIVE_PROFILE: 'nope' });
    assert.deepEqual(codes(report), ['unknown_profile']);
    assert.equal(report.errors[0]?.field, 'JIRA_ACTIVE_PROFILE');
  });

  it('reports an empty profile variable', () => {
    const { report } = load({ ...VALID, [profileVar('work', 'SITE')]: '   ' });
    assert.deepEqual(codes(report), ['empty_profile_value']);
  });

  it('locks the profile by default (O-6) and honours an explicit setting', () => {
    assert.equal(load({ ...VALID }).settings.lockProfile, true);
    assert.equal(
      load({ ...VALID, JIRA_LOCK_PROFILE: 'false' }).settings.lockProfile,
      false,
    );
    assert.equal(load({ ...VALID, JIRA_LOCK_PROFILE: '0' }).settings.lockProfile, false);
    assert.equal(load({ ...VALID, JIRA_LOCK_PROFILE: 'yes' }).settings.lockProfile, true);
  });

  it('reports an unparseable JIRA_LOCK_PROFILE instead of guessing', () => {
    const { report, settings } = load({ ...VALID, JIRA_LOCK_PROFILE: 'maybe' });
    assert.deepEqual(codes(report), ['invalid_boolean']);
    assert.equal(settings.lockProfile, true);
  });
});

describe('loadSettings — secrets for the redactor', () => {
  it('registers the active token, inactive profile tokens and JIRA_HTTP_TOKEN', () => {
    const { secrets } = load({
      ...VALID,
      JIRA_TRANSPORT: 'http',
      JIRA_HTTP_TOKEN: 'token-http',
      [profileVar('work', 'API_TOKEN')]: 'token-work',
      [profileVar('personal', 'API_TOKEN')]: 'token-personal',
    });
    assert.deepEqual([...secrets].sort(), [
      'token-active',
      'token-http',
      'token-personal',
      'token-work',
    ]);
  });

  it('deduplicates and skips empty values', () => {
    const { settings } = load({
      ...VALID,
      [profileVar('work', 'API_TOKEN')]: 'token-active',
    });
    assert.deepEqual(collectSecrets(settings), ['token-active']);
  });

  it('never puts a secret value into a finding message', () => {
    const { report } = load({
      JIRA_API_TOKEN: 'super-secret-token',
      JIRA_TRANSPORT: 'http',
    });
    for (const finding of report.findings) {
      assert.equal(finding.message.includes('super-secret-token'), false);
    }
  });
});

describe('loadSettings — numeric and enum knobs', () => {
  it('applies the documented defaults', () => {
    const { settings } = load({ ...VALID });
    assert.equal(settings.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(settings.callBudgetMs, DEFAULT_CALL_BUDGET_MS);
    assert.equal(settings.hostConcurrency, DEFAULT_HOST_CONCURRENCY);
    assert.equal(settings.retryAttempts, DEFAULT_RETRY_ATTEMPTS);
    assert.equal(settings.maxResultChars, DEFAULT_MAX_RESULT_CHARS);
    assert.equal(settings.maxPages, DEFAULT_MAX_PAGES);
    assert.equal(settings.httpPort, DEFAULT_HTTP_PORT);
    assert.equal(settings.writeMode, DEFAULT_WRITE_MODE);
    assert.equal(settings.transport, DEFAULT_TRANSPORT);
    assert.equal(settings.logLevel, DEFAULT_LOG_LEVEL);
    assert.deepEqual(settings.toolPackages, [DEFAULT_TOOL_PACKAGES]);
    assert.equal(settings.allowIrreversible, false);
    assert.equal(settings.mediaDir, undefined);
  });

  it('pins the defaults to the CONFIGURATION.md table literals', () => {
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30000);
    assert.equal(DEFAULT_CALL_BUDGET_MS, 120000);
    assert.equal(DEFAULT_HOST_CONCURRENCY, 4);
    assert.equal(DEFAULT_RETRY_ATTEMPTS, 3);
    assert.equal(DEFAULT_MAX_RESULT_CHARS, 25000);
    assert.equal(DEFAULT_MAX_PAGES, 20);
    assert.equal(DEFAULT_HTTP_PORT, 3334);
    assert.equal(DEFAULT_WRITE_MODE, 'plan');
    assert.equal(DEFAULT_TRANSPORT, 'stdio');
    assert.equal(DEFAULT_LOG_LEVEL, 'info');
    assert.equal(DEFAULT_TOOL_PACKAGES, 'all');
  });

  it('parses valid overrides', () => {
    const { settings, report } = load({
      ...VALID,
      JIRA_REQUEST_TIMEOUT_MS: '5000',
      JIRA_CALL_BUDGET_MS: '60000',
      JIRA_HOST_CONCURRENCY: '8',
      JIRA_RETRY_ATTEMPTS: '0',
      JIRA_MAX_RESULT_CHARS: '1000',
      JIRA_MAX_PAGES: '5',
      JIRA_HTTP_PORT: '4000',
      JIRA_WRITE_MODE: 'apply',
      JIRA_LOG_LEVEL: 'debug',
      JIRA_ALLOW_IRREVERSIBLE: 'true',
      JIRA_MEDIA_DIR: '/srv/jira-media',
    });
    assert.equal(report.ok, true);
    assert.equal(settings.requestTimeoutMs, 5000);
    assert.equal(settings.retryAttempts, 0);
    assert.equal(settings.writeMode, 'apply');
    assert.equal(settings.logLevel, 'debug');
    assert.equal(settings.allowIrreversible, true);
    assert.equal(settings.mediaDir, '/srv/jira-media');
  });

  it('treats an invalid number as an error finding, not a silent fallback', () => {
    for (const bad of ['abc', '1.5', '-1', '', ' ']) {
      const { report, settings } = load({ ...VALID, JIRA_HOST_CONCURRENCY: bad });
      if (bad.trim() === '') {
        // an unset/blank value is simply "not configured"
        assert.equal(report.ok, true, bad);
      } else {
        assert.deepEqual(codes(report), ['invalid_number'], bad);
        assert.equal(report.errors[0]?.field, 'JIRA_HOST_CONCURRENCY', bad);
      }
      assert.equal(settings.hostConcurrency, DEFAULT_HOST_CONCURRENCY, bad);
    }
  });

  it('treats an out-of-range number as an error finding', () => {
    const { report } = load({ ...VALID, JIRA_MAX_PAGES: '100000' });
    assert.deepEqual(codes(report), ['invalid_number']);
  });

  it('treats an invalid enum as an error finding', () => {
    const { report, settings } = load({ ...VALID, JIRA_LOG_LEVEL: 'chatty' });
    assert.deepEqual(codes(report), ['invalid_enum']);
    assert.equal(settings.logLevel, DEFAULT_LOG_LEVEL);
  });

  it('warns when the call budget is below the request timeout', () => {
    const { report } = load({ ...VALID, JIRA_CALL_BUDGET_MS: '1000' });
    assert.deepEqual(codes(report), ['budget_below_timeout']);
    assert.equal(report.ok, true);
  });
});

describe('loadSettings — packages and transport', () => {
  it('parses the package lists as lower-cased comma lists', () => {
    const { settings } = load({
      ...VALID,
      JIRA_TOOL_PACKAGES: 'core, Search ,issues',
      JIRA_PACKAGES_READONLY: 'Agile',
    });
    assert.deepEqual(settings.toolPackages, ['core', 'search', 'issues']);
    assert.deepEqual(settings.packagesReadonly, ['agile']);
  });

  it('warns that core cannot be denied (CC-29) and keeps the value verbatim', () => {
    const { settings, report } = load({ ...VALID, JIRA_PACKAGES_DENY: 'core,agile' });
    assert.deepEqual(codes(report), ['core_package_undeniable']);
    assert.equal(report.ok, true);
    assert.deepEqual(settings.packagesDeny, ['core', 'agile']);
  });

  it('refuses the http transport without JIRA_HTTP_TOKEN (CC-30)', () => {
    const { report } = load({ ...VALID, JIRA_TRANSPORT: 'http' });
    assert.deepEqual(codes(report), ['http_token_missing']);
    assert.equal(report.errors[0]?.field, 'JIRA_HTTP_TOKEN');
  });

  it('accepts the http transport with a token', () => {
    const { report, settings } = load({
      ...VALID,
      JIRA_TRANSPORT: 'http',
      JIRA_HTTP_TOKEN: 'token-http',
    });
    assert.equal(report.ok, true);
    assert.equal(settings.transport, 'http');
  });
});

describe('loadSettings — token expiry', () => {
  const day = 86400000;
  const now = Date.UTC(2026, 0, 1);

  it('warns when the token expires within 30 days', () => {
    const { report } = load(
      { ...VALID, JIRA_TOKEN_EXPIRES: new Date(now + 10 * day).toISOString() },
      { clock: createFakeClock(now) },
    );
    assert.deepEqual(codes(report), ['token_expiry_warning']);
    assert.equal(report.ok, true);
    assert.deepEqual(report.warnings[0]?.data, { daysLeft: 10 });
  });

  it('stays silent when the token expires further out', () => {
    const { report } = load(
      { ...VALID, JIRA_TOKEN_EXPIRES: new Date(now + 200 * day).toISOString() },
      { clock: createFakeClock(now) },
    );
    assert.deepEqual(report.findings, []);
  });

  it('warns after expiry too', () => {
    const { report } = load(
      { ...VALID, JIRA_TOKEN_EXPIRES: '2025-12-25' },
      { clock: createFakeClock(now) },
    );
    assert.deepEqual(codes(report), ['token_expiry_warning']);
    assert.match(String(report.warnings[0]?.message), /expired 7 day/);
  });

  it('reports an unparseable expiry date as an error', () => {
    const { report } = load(
      { ...VALID, JIRA_TOKEN_EXPIRES: 'next summer' },
      { clock: createFakeClock(now) },
    );
    assert.deepEqual(codes(report), ['invalid_date']);
  });

  it('skips the horizon check when no clock is injected', () => {
    const { report } = load({ ...VALID, JIRA_TOKEN_EXPIRES: '2020-01-01' });
    assert.deepEqual(report.findings, []);
  });
});

describe('loadSettings — placeholder credentials that shred the output', () => {
  /** The shape and length of a token the API-token page actually hands out. */
  const REALISTIC_TOKEN =
    `ATATT${'3xFfGF0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'.repeat(5)}`.slice(0, 192);

  it('CC-76: warns on a one-character token and still registers it as a secret', () => {
    const { report, secrets } = load({ ...VALID, JIRA_API_TOKEN: 't' });

    assert.deepEqual(codes(report), ['redaction_collision']);
    assert.equal(report.ok, true, 'a dummy token must not block startup');
    assert.equal(report.warnings[0]?.field, 'JIRA_API_TOKEN');
    assert.deepEqual(secrets, ['t'], 'the value still goes to the redactor');
  });

  it('CC-76: warns on a token the server prints itself, and keeps it registered', () => {
    const { report, secrets } = load({ ...VALID, JIRA_API_TOKEN: 'settings' });

    assert.deepEqual(codes(report), ['redaction_collision']);
    assert.match(String(report.warnings[0]?.message), /substring of text this server/);
    assert.deepEqual(secrets, ['settings']);
  });

  it('CC-76: stays silent for a realistic 192-character API token', () => {
    const { report } = load({ ...VALID, JIRA_API_TOKEN: REALISTIC_TOKEN });
    assert.deepEqual(report.findings, []);
  });

  it('names every affected variable, profile and transport tokens included', () => {
    const { report } = load({
      ...VALID,
      JIRA_TRANSPORT: 'http',
      JIRA_HTTP_TOKEN: 'dev',
      [profileVar('work', 'API_TOKEN')]: 'x',
    });

    assert.deepEqual(codes(report), ['redaction_collision', 'redaction_collision']);
    assert.deepEqual(
      report.warnings.map((finding) => finding.field),
      [profileVar('work', 'API_TOKEN'), 'JIRA_HTTP_TOKEN'],
    );
    assert.equal(report.ok, true);
  });

  it('describes the value without quoting it', () => {
    const { report } = load({ ...VALID, JIRA_API_TOKEN: 'zq' });
    assert.equal(report.warnings[0]?.message.includes('zq'), false);
  });
});

describe('loadSettings — process.env path', () => {
  it('reads process.env by default and leaks nothing afterwards', async () => {
    await withEnv({ ...VALID, JIRA_ENV_FILE: undefined, JIRA_MAX_PAGES: '7' }, () => {
      const { settings, report } = loadSettings({ loadEnvFile: false });
      assert.equal(report.ok, true);
      assert.equal(settings.site, 'mycompany');
      assert.equal(settings.maxPages, 7);
    });
    assert.equal(process.env.JIRA_SITE, undefined);
    assert.equal(process.env.JIRA_MAX_PAGES, undefined);
  });

  it('surfaces env-file problems as startup findings', async () => {
    await withEnv({ ...VALID, JIRA_ENV_FILE: '/definitely/not/here.env' }, () => {
      const { report } = loadSettings();
      assert.equal(report.ok, false);
      assert.equal(
        report.errors.some((finding) => finding.code === 'env_file_missing'),
        true,
      );
    });
  });
});
