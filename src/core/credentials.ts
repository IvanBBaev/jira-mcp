// ---------------------------------------------------------------------------
// The credential rule — AUTH.md §Profiles, D29.
//
// ONE implementation of "which site, email and token does this call actually
// use". It lived in two places before: the composition root built the per-call
// resolver `core/http.ts` asks for, and `cli/doctor.ts` re-derived the same
// per-field profile override to report what it was about to send. Two copies of
// one rule is two ways for a profile to mean something different depending on
// who asked, so both now consume this module.
//
// THIS MODULE IS IMPORT-FREE AT RUNTIME. `src/index.ts` re-exports
// {@link buildCredentialResolver} from here, and that file may not pull a real
// module graph in at load time — its Node version guard has to run on a runtime
// that cannot parse the rest of the server. Everything below is therefore plain
// functions over injected values: the host resolver arrives as a dependency
// rather than as an import of `core/host.ts`, and the error is built
// structurally instead of importing `JiraError`. Keep it that way — an import
// added here is an import added to the entry point.
//
// Layering: `core` is layer 0; type-only imports are the only ones present.
// ---------------------------------------------------------------------------

import type { CredentialResolver, JiraCredentials } from './http.js';
import type { HostResolution } from './host.js';
import type { HostRef, ProfileConfig, Settings } from './types.js';

/**
 * A `config` {@link JiraError} without importing the class.
 *
 * The shape is what `isJiraError` structurally recognises (`kind`, `retryable`,
 * plus the `Error` base), so this value is rendered as a `config` envelope,
 * counted under `config` by the telemetry counters and carries its remediation
 * exactly like a constructed one. `core/errors.ts` would be the natural home for
 * the real thing, but importing it here would drag `core/redact.ts` and the rest
 * of the graph into `src/index.ts` (see the module header).
 */
export function configError(message: string, remediation: string): Error {
  return Object.assign(new Error(message), {
    name: 'JiraError',
    kind: 'config',
    retryable: false,
    remediation,
  });
}

/**
 * The slice of {@link Settings} the credential rule reads. A `Pick` rather than
 * the full type so `loadSettings` itself can apply the rule mid-load, before a
 * `Settings` value exists to hand over.
 */
export type CredentialSource = Pick<
  Settings,
  'profiles' | 'site' | 'email' | 'apiToken' | 'activeProfile'
>;

/**
 * The profile a name refers to, or `undefined` when it names none.
 *
 * Profile names are matched case-insensitively because the environment spells
 * them in upper case (`JIRA_PROFILE_EU_SITE`) and humans write them in lower
 * case; `loadSettings` keys the map by the lowercased name.
 */
export function profileOf(
  settings: CredentialSource,
  profileName: string | undefined,
): ProfileConfig | undefined {
  const key = profileName?.toLowerCase();
  return key === undefined ? undefined : settings.profiles[key];
}

/**
 * The raw site/email/token a call would use, per field.
 *
 * A VIEW, NOT A VALIDATION: nothing here throws, nothing is resolved against
 * `JIRA_ALLOWED_HOSTS`, and a name that matches no profile simply contributes no
 * overrides. That is what `doctor` wants — it reports what is missing rather
 * than refusing to run — while {@link buildCredentialResolver} is the one that
 * turns the same three fields into a usable request or an error.
 *
 * `site` is the profile's raw `site` string; it still has to go through
 * `resolveHost` before it may be spoken to.
 */
export interface EffectiveCredentials {
  readonly site?: string;
  readonly email?: string;
  readonly apiToken?: string;
}

/**
 * Apply the per-field profile override (AUTH.md): a named profile's
 * `site`/`email`/`apiToken` win, each falling back to the top-level value, so a
 * profile that only overrides the token still works.
 *
 * `profileName` defaults to `settings.activeProfile` — the profile a call that
 * names none gets.
 */
export function effectiveCredentials(
  settings: CredentialSource,
  profileName: string | undefined = settings.activeProfile,
): EffectiveCredentials {
  const profile = profileOf(settings, profileName);
  const site = profile?.site ?? settings.site;
  const email = profile?.email ?? settings.email;
  const apiToken = profile?.apiToken ?? settings.apiToken;
  return {
    ...(site === undefined ? {} : { site }),
    ...(email === undefined ? {} : { email }),
    ...(apiToken === undefined ? {} : { apiToken }),
  };
}

/**
 * What {@link buildCredentialResolver} needs. Passed in rather than imported so
 * the import ban above (and in `src/index.ts`) holds: `resolveHost` arrives from
 * the caller's dynamic import.
 */
export interface CredentialDeps {
  readonly settings: Settings;
  /** The already-resolved default host from `loadSettings`. */
  readonly host?: HostRef | undefined;
  readonly resolveHost: (
    rawSite: string | undefined,
    allowedHosts: readonly string[],
  ) => HostResolution;
}

/** The host a profile talks to: its own `site` when it sets one, else the default. */
function profileHost(
  deps: CredentialDeps,
  site: string | undefined,
): HostRef | undefined {
  if (site === undefined || site === '') return deps.host;
  return deps.resolveHost(site, deps.settings.allowedHosts).host;
}

/**
 * Turn settings into the per-call credential lookup `core/http.ts` asks for.
 *
 * INVENTED (WP-40): nothing in `core` built one — `loadSettings` resolves the
 * DEFAULT host and doctor only ever needs the active credentials, so the profile
 * fan-out landed at the composition root. WP-51 moved it here so doctor and the
 * root share the rule instead of restating it.
 *
 * Resolution rules, matching AUTH.md: the per-field override of
 * {@link effectiveCredentials}, plus two things only the resolver can do. A
 * profile that names its own site is re-resolved through the same allowlist as
 * the default one — a profile is not a way around `JIRA_ALLOWED_HOSTS` (D29).
 * And an unknown profile is an error rather than a silent fallback to the
 * default credentials, because "typo in the profile name" and "call the default
 * site" must not look the same to a caller. The lookup is deferred rather than
 * eager because an unusable INACTIVE profile must not stop a server whose active
 * one is fine.
 */
export function buildCredentialResolver(deps: CredentialDeps): CredentialResolver {
  const { settings } = deps;

  return (profileName?: string): JiraCredentials => {
    const requested = profileName ?? settings.activeProfile;
    const profile = profileOf(settings, requested);

    if (requested !== undefined && profile === undefined) {
      throw configError(
        `Profile "${requested}" is not configured.`,
        'Define JIRA_PROFILE_<NAME>_SITE / _EMAIL / _API_TOKEN for it, or call ' +
          'without a profile to use the default credentials. jira_capabilities ' +
          'reports the active profile.',
      );
    }

    const effective = effectiveCredentials(settings, requested);
    const host = profileHost(deps, profile?.site);
    const { email, apiToken } = effective;

    if (host === undefined || email === undefined || apiToken === undefined) {
      throw configError(
        requested === undefined
          ? 'This server has no usable Jira credentials: JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN must all be set.'
          : `Profile "${requested}" has no usable credentials: site, email and API token must all resolve.`,
        'Run `jira-mcp-ai doctor` — it reports which of the three is missing and ' +
          'where it looked for the env file.',
      );
    }

    return { host, email, apiToken };
  };
}
