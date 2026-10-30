// Credentials, auth mode, deployment and the OAuth block (D516): the first
// section of `loadSettings`, and the one that assembles the EFFECTIVE egress
// allowlist every later consumer agrees on (D97, D301).

import { defaultOAuthTokenFile, resolveConfigPath } from '../config.js';
import type { EnvFileOptions } from '../config.js';
import { isValidCloudId } from '../host.js';
import {
  AUTH_MODES,
  DEPLOYMENTS,
  OAUTH_GRANTS,
  type AuthMode,
  type JiraDeployment,
  type OAuthGrant,
  type OAuthSettings,
  type Settings,
} from '../types.js';
import {
  DEFAULT_AUTH_MODE,
  DEFAULT_DEPLOYMENT,
  DEFAULT_OAUTH_AUTH_ORIGIN,
  DEFAULT_OAUTH_GATEWAY_ORIGIN,
  DEFAULT_OAUTH_GRANT,
  DEFAULT_OAUTH_REDIRECT_PORT,
  DEFAULT_OAUTH_SCOPES,
} from './defaults.js';
import type { EnvReader } from './env-reader.js';
import { splitAllowedHosts, withOAuthHosts } from './hosts.js';
import type { Add } from './report.js';

/** `JIRA_OAUTH_REDIRECT_PORT` range: unprivileged ports only — `login` binds it. */
const MIN_OAUTH_REDIRECT_PORT = 1024;
const MAX_PORT = 65535;

/** The slice of `Settings` the auth section owns, in `Settings` key order. */
export type AuthSettings = Pick<
  Settings,
  | 'site'
  | 'email'
  | 'apiToken'
  | 'tokenExpires'
  | 'cloudId'
  | 'authMode'
  | 'deployment'
  | 'datacenterPreview'
  | 'pat'
  | 'oauth'
  | 'allowedHosts'
>;

/** Read the credentials, the auth mode, the deployment and the OAuth block. */
export function readAuth(
  read: EnvReader,
  options: EnvFileOptions,
  add: Add,
): AuthSettings {
  // --- Credentials ---------------------------------------------------------
  const site = read.str('JIRA_SITE');
  const email = read.str('JIRA_EMAIL');
  const apiToken = read.str('JIRA_API_TOKEN');
  const tokenExpires = read.str('JIRA_TOKEN_EXPIRES');
  const scopedCloudId = read.str('JIRA_CLOUD_ID');
  const configuredHosts = splitAllowedHosts(read.str('JIRA_ALLOWED_HOSTS') ?? '');

  // --- Auth mode and the OAuth block (D91) ---------------------------------
  // Parsed unconditionally, in BOTH modes: `Settings.oauth` is always a complete
  // value, so doctor can report a block an operator is halfway through filling
  // in, and a typo in one of these knobs is an error wherever it appears — the
  // house rule is that a malformed value never becomes a silent fallback. What
  // the MODE decides is which variables are *required* (`requirements.ts`) and
  // whether the OAuth hosts join the egress allowlist (D97).
  const authMode = read.enumOf<AuthMode>('JIRA_AUTH_MODE', AUTH_MODES, DEFAULT_AUTH_MODE);
  const deployment = read.enumOf<JiraDeployment>(
    'JIRA_DEPLOYMENT',
    DEPLOYMENTS,
    DEFAULT_DEPLOYMENT,
  );
  const pat = read.str('JIRA_PAT');
  const datacenterPreview = read.bool('JIRA_DATACENTER_PREVIEW', false);
  const oauth = readOAuth(read, options, add);

  const cloudId = readScopedCloudId(scopedCloudId, authMode, deployment, add);
  // D97: the two OAuth hosts are allowlisted ONLY in oauth mode, and only for
  // the origins actually configured. `Settings.allowedHosts` is the EFFECTIVE
  // list — assembled here, before `resolveHost` runs — so every consumer of it
  // (the host resolver, the per-call resolver, `core/http.ts`) agrees on what
  // egress is permitted. In basic mode the list is byte-identical to what the
  // operator wrote: v1's egress surface does not change because a feature it
  // does not use exists.
  //
  // D301: a scoped API token works only through the gateway, so basic mode with
  // `JIRA_CLOUD_ID` allowlists the gateway host — and nothing else: the auth
  // origin never sees a Basic credential.
  const allowedHosts =
    authMode === 'oauth'
      ? withOAuthHosts(configuredHosts, [oauth.authOrigin, oauth.gatewayOrigin])
      : cloudId !== undefined
        ? withOAuthHosts(configuredHosts, [oauth.gatewayOrigin])
        : configuredHosts;

  return {
    site,
    email,
    apiToken,
    tokenExpires,
    ...(cloudId === undefined ? {} : { cloudId }),
    authMode,
    deployment,
    datacenterPreview,
    ...(pat === undefined ? {} : { pat }),
    oauth,
    allowedHosts,
  };
}

/** The `JIRA_OAUTH_*` block, complete in every mode (D91). */
function readOAuth(read: EnvReader, options: EnvFileOptions, add: Add): OAuthSettings {
  const grant = read.enumOf<OAuthGrant>(
    'JIRA_OAUTH_GRANT',
    OAUTH_GRANTS,
    DEFAULT_OAUTH_GRANT,
  );
  const clientId = read.str('JIRA_OAUTH_CLIENT_ID');
  const clientSecret = read.str('JIRA_OAUTH_CLIENT_SECRET');
  const scopes = read.csv('JIRA_OAUTH_SCOPES');
  const cloudId = read.str('JIRA_OAUTH_CLOUD_ID');
  const tokenFileRaw = read.str('JIRA_OAUTH_TOKEN_FILE');
  const tokenFile =
    tokenFileRaw === undefined
      ? defaultOAuthTokenFile(options)
      : resolveConfigPath(tokenFileRaw, options);
  const redirectPort = read.int(
    'JIRA_OAUTH_REDIRECT_PORT',
    DEFAULT_OAUTH_REDIRECT_PORT,
    MIN_OAUTH_REDIRECT_PORT,
    MAX_PORT,
  );
  // Both origins exist for ONE reason: the offline test harness points the flow
  // at a local stand-in for Atlassian, because a test that must not touch the
  // network still has to exercise the authorize → exchange → refresh sequence.
  // Nothing in a real deployment sets them — they are a seam, not a knob — which
  // is why the default is the real Atlassian origin and the validation is strict.
  //
  // Strict includes the scheme: a stand-in must serve https too (the harness
  // uses `https://127.0.0.1:<port>`). There is deliberately no loopback
  // exemption. The client secret and every refresh token are sent to the auth
  // origin, and a validator that accepts cleartext for "just a test host" is one
  // copied `.env` line away from doing it against a real tenant. A unit test
  // that does not want to run a TLS listener should inject `AuthRequestFn`
  // instead of reconfiguring the origin.
  const authOrigin = read.httpsOrigin(
    'JIRA_OAUTH_AUTH_ORIGIN',
    DEFAULT_OAUTH_AUTH_ORIGIN,
  );
  const gatewayOrigin = read.httpsOrigin(
    'JIRA_OAUTH_GATEWAY_ORIGIN',
    DEFAULT_OAUTH_GATEWAY_ORIGIN,
  );

  // The cloudId is interpolated into every request path, so a value that is not
  // path-safe is refused at startup rather than at the first call — using the
  // same predicate as the request builder (CC-101), because two spellings of one
  // rule is how a check ends up rejecting what the other accepts. It is a
  // shape check, not a lookup: only the flow can say whether the id exists.
  if (cloudId !== undefined && !isValidCloudId(cloudId)) {
    add({
      severity: 'error',
      code: 'invalid_cloud_id',
      message: `JIRA_OAUTH_CLOUD_ID ${JSON.stringify(cloudId)} is not a cloud id — letters, digits and hyphens only. It is the id \`jira-mcp-ai login\` prints for the site, not the site URL; unset it to let login discover the site on every run instead.`,
      field: 'JIRA_OAUTH_CLOUD_ID',
    });
  }

  return {
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    grant,
    scopes: scopes.length > 0 ? scopes : DEFAULT_OAUTH_SCOPES,
    ...(cloudId === undefined ? {} : { cloudId }),
    tokenFile,
    redirectPort,
    authOrigin,
    gatewayOrigin,
  };
}

/**
 * D301: `JIRA_CLOUD_ID` routes a scoped API token through the gateway. The id
 * is shape-checked with the same predicate as the OAuth one; outside
 * basic-on-cloud it has no meaning and is reported as inert rather than
 * silently routing nowhere. Only a usable id is returned: consumers build a URL
 * from it unchecked.
 */
function readScopedCloudId(
  scopedCloudId: string | undefined,
  authMode: AuthMode,
  deployment: JiraDeployment,
  add: Add,
): string | undefined {
  const cloudIdApplies = authMode === 'basic' && deployment === 'cloud';
  if (scopedCloudId !== undefined && !cloudIdApplies) {
    add({
      severity: 'warning',
      code: 'cloud_id_ignored',
      message: `JIRA_CLOUD_ID routes a scoped API token through the Atlassian gateway, which only basic auth on a cloud deployment uses; with JIRA_AUTH_MODE=${authMode} and JIRA_DEPLOYMENT=${deployment} it is ignored.${authMode === 'oauth' ? ' OAuth takes its site from JIRA_OAUTH_CLOUD_ID.' : ''} Unset it to silence this.`,
      field: 'JIRA_CLOUD_ID',
    });
  } else if (scopedCloudId !== undefined && !isValidCloudId(scopedCloudId)) {
    add({
      severity: 'error',
      code: 'invalid_cloud_id',
      message: `JIRA_CLOUD_ID ${JSON.stringify(scopedCloudId)} is not a cloud id — letters, digits and hyphens only. Read the site's id from https://<your-site>/_edge/tenant_info ("cloudId"), not the site URL.`,
      field: 'JIRA_CLOUD_ID',
    });
  }
  return cloudIdApplies && scopedCloudId !== undefined && isValidCloudId(scopedCloudId)
    ? scopedCloudId
    : undefined;
}
