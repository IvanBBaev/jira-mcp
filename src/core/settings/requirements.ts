// What each auth mode requires (D516): the credentials it signs with, and the
// deployment it runs against (D106). Pure checks over sections already read —
// nothing here reads the environment.

import { effectiveCredentials } from '../credentials.js';
import { docUrl } from '../doc-url.js';
import { DEFAULT_OAUTH_GRANT } from './defaults.js';
import type { AuthSettings } from './auth.js';
import { profileVar, type ProfileSection } from './profiles.js';
import type { Add } from './report.js';

/** The site the host resolver checks, and the variable it was read from. */
export interface EffectiveSite {
  readonly site: string | undefined;
  readonly variable: string;
}

/**
 * Report the credentials the auth mode requires and does not have, and return
 * the effective site. `JIRA_SITE` is required in every mode — oauth resolves
 * the tenant through the gateway, but the operator still has to say which
 * tenant — so its findings come from `resolveHost`, not from here.
 */
export function checkCredentials(
  auth: AuthSettings,
  profile: ProfileSection,
  add: Add,
): EffectiveSite {
  // The credentials actually used — the per-field profile override, applied by
  // the rule's one home (`core/credentials.ts`, D29) so load-time diagnostics
  // can never disagree with the per-call resolver.
  const {
    site: effectiveSite,
    email: effectiveEmail,
    apiToken: effectiveToken,
  } = effectiveCredentials({
    profiles: profile.profiles,
    site: auth.site,
    email: auth.email,
    apiToken: auth.apiToken,
    activeProfile: profile.activeProfileKey,
  });
  const active = profile.activeProfile;
  const profileName = active?.name;
  // The variable each effective value was READ from, so a finding about a value
  // the active profile supplied names the profile's variable (CC-189).
  const emailVariable =
    profileName !== undefined && active?.email !== undefined
      ? profileVar(profileName, 'EMAIL')
      : 'JIRA_EMAIL';
  const siteVariable =
    profileName !== undefined && active?.site !== undefined
      ? profileVar(profileName, 'SITE')
      : 'JIRA_SITE';

  // Which credentials are REQUIRED is the one thing the mode changes here.
  if (auth.authMode === 'basic') {
    if (effectiveEmail === undefined) {
      add({
        severity: 'error',
        code: 'missing_credential',
        message: `${profileName === undefined ? 'JIRA_EMAIL' : profileVar(profileName, 'EMAIL')} is not set. Basic auth needs the Atlassian account email.`,
        field: 'JIRA_EMAIL',
      });
    } else if (!effectiveEmail.includes('@')) {
      add({
        severity: 'error',
        code: 'invalid_email',
        message: `${emailVariable} ${JSON.stringify(effectiveEmail)} is not an email address. Basic auth sends email:token, so a login name will always 401.`,
        field: emailVariable,
      });
    }

    if (effectiveToken === undefined) {
      add({
        severity: 'error',
        code: 'missing_credential',
        message: `${profileName === undefined ? 'JIRA_API_TOKEN' : profileVar(profileName, 'API_TOKEN')} is not set. Create one at https://id.atlassian.com/manage-profile/security/api-tokens`,
        field: 'JIRA_API_TOKEN',
      });
    }
  } else if (auth.authMode === 'pat') {
    checkPat(auth, profile.activeProfileRaw, add);
  } else {
    checkOAuth(auth, profile.activeProfileRaw, add);
  }
  if (auth.authMode !== 'oauth' && auth.oauth.grant !== DEFAULT_OAUTH_GRANT) {
    add({
      severity: 'warning',
      code: 'oauth_grant_ignored',
      message: `JIRA_OAUTH_GRANT=${auth.oauth.grant} selects how oauth mode gets its token, and JIRA_AUTH_MODE is ${auth.authMode}; it is ignored. Set JIRA_AUTH_MODE=oauth to use it, or unset it to silence this.`,
      field: 'JIRA_OAUTH_GRANT',
    });
  }
  return { site: effectiveSite, variable: siteVariable };
}

/** pat mode: one Data Center token is the whole credential, and no profiles. */
function checkPat(
  auth: AuthSettings,
  activeProfileRaw: string | undefined,
  add: Add,
): void {
  // A Data Center personal access token is the whole credential: no email,
  // no app. Its absence is the one thing to report in this mode.
  if (auth.pat === undefined) {
    add({
      severity: 'error',
      code: 'missing_credential',
      message:
        'JIRA_AUTH_MODE=pat needs JIRA_PAT: the personal access token created in Jira Data Center under Profile → Personal Access Tokens. It is sent as a bearer token to the site host.',
      field: 'JIRA_PAT',
    });
  }
  // The PAT resolver refuses every profile, the active one included, so a
  // server started with one reported itself healthy and then failed every
  // call it made (CC-763). Said here, where the report can still stop it.
  if (activeProfileRaw !== undefined) {
    add({
      severity: 'error',
      code: 'profile_unsupported',
      message: `JIRA_ACTIVE_PROFILE is ${JSON.stringify(activeProfileRaw)}, but JIRA_AUTH_MODE=pat has no profiles: a profile carries Basic-auth credentials, and this server signs with one personal access token. Unset JIRA_ACTIVE_PROFILE.`,
      field: 'JIRA_ACTIVE_PROFILE',
    });
  }
}

/** oauth mode: the app's credentials replace the email/token pair. */
function checkOAuth(
  auth: AuthSettings,
  activeProfileRaw: string | undefined,
  add: Add,
): void {
  // In oauth mode the email/token pair signs nothing, so their absence is not
  // a problem to report — sending an operator to fix `JIRA_API_TOKEN` when the
  // server never reads it is how a config error becomes an hour of debugging.
  // The app's own credentials take their place, and BOTH are required:
  // Atlassian authenticates the client on the token endpoint for the code
  // exchange and for every refresh, so there is no public-client shortcut here
  // however much PKCE would suggest one.
  if (auth.oauth.clientId === undefined) {
    add({
      severity: 'error',
      code: 'missing_credential',
      message:
        'JIRA_AUTH_MODE=oauth needs JIRA_OAUTH_CLIENT_ID: it names the OAuth 2.0 (3LO) app the login flow asks consent for. Create the app at https://developer.atlassian.com/console/myapps/ and copy its client id.',
      field: 'JIRA_OAUTH_CLIENT_ID',
    });
  }
  if (auth.oauth.clientSecret === undefined) {
    add({
      severity: 'error',
      code: 'missing_credential',
      message:
        'JIRA_AUTH_MODE=oauth needs JIRA_OAUTH_CLIENT_SECRET: Atlassian requires client authentication on the token endpoint, for the initial exchange and for every refresh. Copy it from the same app under Settings → Authentication details.',
      field: 'JIRA_OAUTH_CLIENT_SECRET',
    });
  }
  // D302: a service account has no discovery step — the client-credentials
  // grant is not a user, so accessible-resources has nobody to answer for —
  // and no profiles, because one app credential is one identity on one site.
  if (auth.oauth.grant !== 'client_credentials') return;
  if (auth.oauth.cloudId === undefined) {
    add({
      severity: 'error',
      code: 'missing_cloud_id',
      message:
        'JIRA_OAUTH_GRANT=client_credentials needs JIRA_OAUTH_CLOUD_ID: a service account token is not tied to a site the server could discover. Read the "cloudId" of https://<your-site>/_edge/tenant_info.',
      field: 'JIRA_OAUTH_CLOUD_ID',
    });
  }
  if (activeProfileRaw !== undefined) {
    add({
      severity: 'error',
      code: 'profile_unsupported',
      message: `JIRA_ACTIVE_PROFILE is ${JSON.stringify(activeProfileRaw)}, but JIRA_OAUTH_GRANT=client_credentials has no profiles: the app's credential is one service account on the site JIRA_OAUTH_CLOUD_ID names. Unset JIRA_ACTIVE_PROFILE.`,
      field: 'JIRA_ACTIVE_PROFILE',
    });
  }
}

/**
 * D106: the two products do not share a credential. A PAT exists only on Data
 * Center, and an API token with an email, or a 3LO grant, only on Cloud. A
 * mismatch is an error rather than a guess, because the guess would send one
 * product's secret to the other's host.
 */
export function checkDeployment(auth: AuthSettings, add: Add): void {
  const { authMode, deployment, datacenterPreview } = auth;
  if (authMode === 'pat' && deployment !== 'datacenter') {
    add({
      severity: 'error',
      code: 'auth_mode_deployment',
      message:
        'JIRA_AUTH_MODE=pat is a Jira Data Center credential, and JIRA_DEPLOYMENT is cloud. Jira Cloud has no personal access tokens: use JIRA_AUTH_MODE=basic (email + API token) or oauth, or set JIRA_DEPLOYMENT=datacenter.',
      field: 'JIRA_AUTH_MODE',
    });
  }
  if (deployment === 'datacenter' && authMode !== 'pat') {
    add({
      severity: 'error',
      code: 'auth_mode_deployment',
      message: `JIRA_DEPLOYMENT=datacenter authenticates with a personal access token, and JIRA_AUTH_MODE is ${authMode}. Set JIRA_AUTH_MODE=pat and JIRA_PAT.`,
      field: 'JIRA_AUTH_MODE',
    });
  }
  if (auth.pat !== undefined && authMode !== 'pat') {
    add({
      severity: 'warning',
      code: 'pat_ignored',
      message: `JIRA_PAT is set, but JIRA_AUTH_MODE is ${authMode}, which does not use it; it is ignored. Unset it to silence this.`,
      field: 'JIRA_PAT',
    });
  }
  // Fail closed: the Data Center adapter is UNVERIFIED (D106, D104's
  // condition), so it runs only on the operator's explicit acknowledgement.
  // Everything above still runs, so an operator preparing a Data Center
  // configuration sees every other problem in the same report.
  if (deployment === 'datacenter' && !datacenterPreview) {
    add({
      severity: 'error',
      code: 'deployment_unavailable',
      message: `JIRA_DEPLOYMENT=datacenter selects a Data Center adapter (reads and a first set of writes) that has never been run against a Data Center instance (${docUrl('CONFIGURATION.md', 'jira-data-center-phase-13--unverified-preview')}). It starts only with JIRA_DATACENTER_PREVIEW=true, which says you accept that. Unset JIRA_DEPLOYMENT to use Jira Cloud.`,
      field: 'JIRA_DEPLOYMENT',
    });
  } else if (deployment === 'datacenter') {
    add({
      severity: 'warning',
      code: 'deployment_unverified',
      message:
        "Jira Data Center preview: an adapter (reads and a first set of writes, still behind JIRA_WRITE_MODE) built from Atlassian's documentation and never verified against a Data Center instance. jira_capabilities lists the tools it serves; report what breaks.",
      field: 'JIRA_DATACENTER_PREVIEW',
    });
  }
  if (datacenterPreview && deployment !== 'datacenter') {
    add({
      severity: 'warning',
      code: 'datacenter_preview_ignored',
      message:
        'JIRA_DATACENTER_PREVIEW is set, but JIRA_DEPLOYMENT is cloud; it is ignored. Unset it to silence this.',
      field: 'JIRA_DATACENTER_PREVIEW',
    });
  }
}
