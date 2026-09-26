// The `authMode` + `oauth` + `deployment` part of a `Settings` fixture, for the suites that
// build a settings literal by hand and do not exercise OAuth at all.
//
// It exists because `Settings.authMode` and `Settings.oauth` are REQUIRED:
// `loadSettings` always populates both, so every consumer sees a total value and
// no code path has to branch on `undefined`. The cost lands on test fixtures,
// which now have to spell out an OAuth block they never read. Spreading this
// constant is that spelling, written once — when `OAuthSettings` gains a field,
// one file changes instead of every suite that happens to construct `Settings`.
//
// Test-only, like the rest of `core/fakes/**`.

import {
  DEFAULT_AUTH_MODE,
  DEFAULT_OAUTH_AUTH_ORIGIN,
  DEFAULT_OAUTH_GATEWAY_ORIGIN,
  DEFAULT_OAUTH_REDIRECT_PORT,
  DEFAULT_OAUTH_SCOPES,
} from '../settings.js';
import type { OAuthSettings, Settings } from '../types.js';

/**
 * A path chosen to be unusable rather than plausible.
 *
 * Basic-mode fixtures never read the token store, so any value type-checks. A
 * path that cannot exist is still the better one: if a test ever flips
 * `authMode` to `oauth` and forgets to point this somewhere, it fails on a
 * missing directory instead of quietly opening — or rewriting — the real
 * `oauth.json` of whoever is running the suite.
 */
export const FAKE_OAUTH_TOKEN_FILE = '/nonexistent/jira-mcp-fake/oauth.json';

/**
 * The OAuth block `loadSettings` produces when no `JIRA_OAUTH_*` var is set.
 *
 * `clientId` and `clientSecret` are absent on purpose: in basic mode there is no
 * registered app, and a fixture that carried credentials would let an
 * oauth-mode test pass without ever having configured one.
 */
export const FAKE_OAUTH_SETTINGS: OAuthSettings = Object.freeze({
  scopes: DEFAULT_OAUTH_SCOPES,
  tokenFile: FAKE_OAUTH_TOKEN_FILE,
  redirectPort: DEFAULT_OAUTH_REDIRECT_PORT,
  authOrigin: DEFAULT_OAUTH_AUTH_ORIGIN,
  gatewayOrigin: DEFAULT_OAUTH_GATEWAY_ORIGIN,
});

/** Spread into a `Settings` literal that does not care how it authenticates. */
export const FAKE_AUTH_SETTINGS: Pick<
  Settings,
  'authMode' | 'oauth' | 'deployment' | 'datacenterPreview'
> = Object.freeze({
  authMode: DEFAULT_AUTH_MODE,
  oauth: FAKE_OAUTH_SETTINGS,
  deployment: 'cloud',
  datacenterPreview: false,
});
