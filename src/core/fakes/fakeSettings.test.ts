import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSettings } from '../settings.js';
import {
  FAKE_AUTH_SETTINGS,
  FAKE_OAUTH_SETTINGS,
  FAKE_OAUTH_TOKEN_FILE,
} from './fakeSettings.js';

// A fixture is only useful while it still resembles the thing it stands in for.
// These assert the two ways this one could rot into a lie: drifting away from
// what `loadSettings` actually produces, and acquiring credentials it has no
// business holding.

test('the fake auth block matches what loadSettings produces with no JIRA_OAUTH_* set', () => {
  const { settings } = loadSettings({
    env: { JIRA_SITE: 'example', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'tok' },
  });

  assert.equal(settings.authMode, FAKE_AUTH_SETTINGS.authMode);
  assert.deepEqual(settings.oauth.scopes, FAKE_OAUTH_SETTINGS.scopes);
  assert.equal(settings.oauth.redirectPort, FAKE_OAUTH_SETTINGS.redirectPort);
  assert.equal(settings.oauth.authOrigin, FAKE_OAUTH_SETTINGS.authOrigin);
  assert.equal(settings.oauth.gatewayOrigin, FAKE_OAUTH_SETTINGS.gatewayOrigin);
  // `tokenFile` is deliberately NOT compared: the real one is derived from the
  // running user's config directory, so asserting equality would assert that CI
  // and a laptop share a home directory. The fake pins an unusable path instead.
  assert.notEqual(settings.oauth.tokenFile, FAKE_OAUTH_TOKEN_FILE);
});

test('the fake carries no client credentials', () => {
  assert.equal(FAKE_OAUTH_SETTINGS.clientId, undefined);
  assert.equal(FAKE_OAUTH_SETTINGS.clientSecret, undefined);
});
