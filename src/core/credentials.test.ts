// ---------------------------------------------------------------------------
// Tests for the one credential rule (WP-51).
//
// The resolver half is also exercised through `src/index.test.ts`, which reaches
// it via the re-export the bin surface depends on. What is tested HERE is the
// property that made the module exist: the non-throwing view doctor reports and
// the throwing resolver the server signs requests with never disagree about
// which site, email and token a call uses.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCredentialResolver,
  configError,
  effectiveCredentials,
  profileOf,
} from './credentials.js';
import type { HostResolution } from './host.js';
import type { HostRef, Settings } from './types.js';

const DEFAULT_HOST: HostRef = { origin: 'https://example.atlassian.net', pathPrefix: '' };

const BASE_SETTINGS: Settings = {
  site: 'example.atlassian.net',
  email: 'default@example.com',
  apiToken: 'default-token',
  allowedHosts: [],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'plan',
  allowIrreversible: false,
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
};

function settingsOf(overrides: Partial<Settings> = {}): Settings {
  return { ...BASE_SETTINGS, ...overrides };
}

/** Stand-in for `core/host.ts`: the default site plus whatever is allow-listed. */
function fakeResolveHost(
  site: string | undefined,
  allowedHosts: readonly string[],
): HostResolution {
  if (site === undefined || site === '') return { problems: [] };
  if (site !== 'example.atlassian.net' && !allowedHosts.includes(site)) {
    return {
      problems: [
        {
          severity: 'error',
          code: 'host_not_allowed',
          message: `${site} is not allowed.`,
          field: 'JIRA_ALLOWED_HOSTS',
        },
      ],
    };
  }
  return { host: { origin: `https://${site}`, pathPrefix: '' }, problems: [] };
}

describe('profileOf', () => {
  it('matches a profile name case-insensitively', () => {
    const settings = settingsOf({
      profiles: { eu: { name: 'eu', email: 'eu@example.com' } },
    });

    assert.equal(profileOf(settings, 'EU')?.name, 'eu');
    assert.equal(profileOf(settings, 'eu')?.name, 'eu');
  });

  it('has nothing to look up without a name', () => {
    assert.equal(profileOf(settingsOf(), undefined), undefined);
  });
});

describe('effectiveCredentials', () => {
  it('reports the top-level values when no profile is active', () => {
    assert.deepEqual(effectiveCredentials(settingsOf()), {
      site: 'example.atlassian.net',
      email: 'default@example.com',
      apiToken: 'default-token',
    });
  });

  it('overrides per field, so a profile may replace only the token', () => {
    const settings = settingsOf({
      activeProfile: 'eu',
      profiles: { eu: { name: 'eu', apiToken: 'eu-token' } },
    });

    assert.deepEqual(effectiveCredentials(settings), {
      site: 'example.atlassian.net',
      email: 'default@example.com',
      apiToken: 'eu-token',
    });
  });

  it('defaults to the active profile but answers about any named one', () => {
    const settings = settingsOf({
      activeProfile: 'eu',
      profiles: {
        eu: { name: 'eu', email: 'eu@example.com' },
        us: { name: 'us', email: 'us@example.com' },
      },
    });

    assert.equal(effectiveCredentials(settings).email, 'eu@example.com');
    assert.equal(effectiveCredentials(settings, 'us').email, 'us@example.com');
  });

  it('reports a profile site raw — resolving it is the resolver’s job', () => {
    const settings = settingsOf({
      activeProfile: 'eu',
      profiles: { eu: { name: 'eu', site: 'other.atlassian.net' } },
    });

    assert.equal(effectiveCredentials(settings).site, 'other.atlassian.net');
  });

  it('is a view, not a validation: an unknown name contributes no overrides', () => {
    const settings = settingsOf({ activeProfile: 'typo' });

    assert.equal(effectiveCredentials(settings).email, 'default@example.com');
  });

  it('omits missing fields instead of setting them to undefined', () => {
    const bare = effectiveCredentials(
      settingsOf({ site: undefined, email: undefined, apiToken: undefined }),
    );

    assert.deepEqual(bare, {});
    assert.deepEqual(Object.keys(bare), []);
  });
});

describe('buildCredentialResolver', () => {
  it('signs with the same fields the view reports', () => {
    const settings = settingsOf({
      activeProfile: 'eu',
      profiles: { eu: { name: 'eu', apiToken: 'eu-token' } },
    });
    const resolve = buildCredentialResolver({
      settings,
      host: DEFAULT_HOST,
      resolveHost: fakeResolveHost,
    });
    const view = effectiveCredentials(settings);

    const credentials = resolve();
    assert.equal(credentials.email, view.email);
    assert.equal(credentials.apiToken, view.apiToken);
    assert.equal(credentials.host.origin, `https://${String(view.site)}`);
  });

  it('re-resolves a profile site through JIRA_ALLOWED_HOSTS (D29)', () => {
    const settings = settingsOf({
      allowedHosts: ['other.atlassian.net'],
      profiles: { eu: { name: 'eu', site: 'other.atlassian.net' } },
    });
    const resolve = buildCredentialResolver({
      settings,
      host: DEFAULT_HOST,
      resolveHost: fakeResolveHost,
    });

    assert.equal(resolve('eu').host.origin, 'https://other.atlassian.net');
  });

  it('refuses a profile site the allowlist rejects', () => {
    const settings = settingsOf({
      profiles: { eu: { name: 'eu', site: 'evil.example.com' } },
    });
    const resolve = buildCredentialResolver({
      settings,
      host: DEFAULT_HOST,
      resolveHost: fakeResolveHost,
    });

    assert.throws(() => resolve('eu'), /no usable credentials/);
  });

  it('rejects an unknown profile instead of falling back to the default', () => {
    const resolve = buildCredentialResolver({
      settings: settingsOf(),
      host: DEFAULT_HOST,
      resolveHost: fakeResolveHost,
    });

    assert.throws(() => resolve('nope'), /Profile "nope" is not configured/);
  });

  it('is deferred: a broken inactive profile does not break the active one', () => {
    const settings = settingsOf({
      email: undefined,
      activeProfile: 'eu',
      profiles: {
        eu: { name: 'eu', email: 'eu@example.com' },
        us: { name: 'us' },
      },
    });
    const resolve = buildCredentialResolver({
      settings,
      host: DEFAULT_HOST,
      resolveHost: fakeResolveHost,
    });

    assert.equal(resolve().email, 'eu@example.com');
    assert.throws(() => resolve('us'), /Profile "us" has no usable credentials/);
  });
});

describe('configError', () => {
  it('is structurally the config JiraError the envelope expects', () => {
    const error = configError('nope', 'do this instead');

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'JiraError');
    assert.deepEqual(
      { ...error },
      {
        name: 'JiraError',
        kind: 'config',
        retryable: false,
        remediation: 'do this instead',
      },
    );
  });
});
