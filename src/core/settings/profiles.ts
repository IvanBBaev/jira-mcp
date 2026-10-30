// Named profiles (D516): `JIRA_PROFILE_<NAME>_SITE|EMAIL|API_TOKEN`, the active
// profile and the lock. v1 parses and validates them; per-call switching stays
// locked (O-6).

import type { ProfileConfig, Settings } from '../types.js';
import { DEFAULT_LOCK_PROFILE } from './defaults.js';
import type { EnvReader } from './env-reader.js';
import type { Add } from './report.js';

const PROFILE_KEY_RE = /^JIRA_PROFILE_(.+)_(SITE|EMAIL|API_TOKEN)$/;
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** The profile section: its `Settings` slice plus what later sections need. */
export interface ProfileSection {
  readonly profiles: Settings['profiles'];
  /** `JIRA_ACTIVE_PROFILE` as written; `Settings.activeProfile`. */
  readonly activeProfileRaw: string | undefined;
  /** The lower-cased lookup key the credential rule takes. */
  readonly activeProfileKey: string | undefined;
  /** The profile the key names, when it exists. */
  readonly activeProfile: ProfileConfig | undefined;
  readonly lockProfile: boolean;
}

/** Read the profiles, resolve the active one and the lock. */
export function readProfiles(
  env: NodeJS.ProcessEnv,
  read: EnvReader,
  add: Add,
): ProfileSection {
  const profiles = parseProfiles(env, add);
  const activeProfileRaw = read.str('JIRA_ACTIVE_PROFILE');
  const activeProfileKey = activeProfileRaw?.toLowerCase();
  // Own keys only, as in `profileOf` (CC-760): `constructor` is not a profile.
  const activeProfile =
    activeProfileKey !== undefined && Object.hasOwn(profiles, activeProfileKey)
      ? profiles[activeProfileKey]
      : undefined;

  if (activeProfileRaw !== undefined && activeProfile === undefined) {
    const known = Object.keys(profiles);
    add({
      severity: 'error',
      code: 'unknown_profile',
      message: `JIRA_ACTIVE_PROFILE names ${JSON.stringify(activeProfileRaw)}, for which no ${profileVar('<NAME>', 'SITE')}-style variables are set. ${known.length === 0 ? 'No profiles are defined.' : `Known profiles: ${known.join(', ')}.`}`,
      field: 'JIRA_ACTIVE_PROFILE',
    });
  }

  const lockProfile = read.bool('JIRA_LOCK_PROFILE', DEFAULT_LOCK_PROFILE);
  return { profiles, activeProfileRaw, activeProfileKey, activeProfile, lockProfile };
}

/** `JIRA_PROFILE_<NAME>_<FIELD>`, built rather than spelled out. */
export function profileVar(name: string, field: 'SITE' | 'EMAIL' | 'API_TOKEN'): string {
  return `JIRA_PROFILE_${name.toUpperCase()}_${field}`;
}

/**
 * Collect every `JIRA_PROFILE_<NAME>_SITE|EMAIL|API_TOKEN` into profiles, keyed
 * by lower-cased name so `JIRA_ACTIVE_PROFILE=work` finds `JIRA_PROFILE_WORK_*`.
 * `ProfileConfig.name` is that same lower-cased key, so `profiles[k].name === k`
 * holds whatever case the operator spelled the variable in.
 */
function parseProfiles(
  env: NodeJS.ProcessEnv,
  add: Add,
): Readonly<Record<string, ProfileConfig>> {
  const drafts = new Map<
    string,
    { name: string; site?: string; email?: string; apiToken?: string }
  >();
  // The variable each profile field was read from, keyed `<name>:<FIELD>`.
  // Names are case-insensitive, so `JIRA_PROFILE_eu_SITE` and
  // `JIRA_PROFILE_EU_SITE` are the same field: taking the last one silently
  // would pick a site by environment order, and a second API token would never
  // reach the redactor (CC-188).
  const sources = new Map<string, string>();

  for (const key of Object.keys(env)) {
    const match = PROFILE_KEY_RE.exec(key);
    if (match === null) continue;
    const rawName = match[1];
    const field = match[2];
    if (rawName === undefined || field === undefined) continue;

    if (!PROFILE_NAME_RE.test(rawName)) {
      add({
        severity: 'error',
        code: 'invalid_profile_name',
        message: `${key} has an unusable profile name; use letters, digits, hyphen and underscore only.`,
        field: key,
      });
      continue;
    }

    const value = env[key]?.trim();
    if (value === undefined || value.length === 0) {
      add({
        severity: 'error',
        code: 'empty_profile_value',
        message: `${key} is set but empty. Give it a value or unset it.`,
        field: key,
      });
      continue;
    }

    const lower = rawName.toLowerCase();
    const earlier = sources.get(`${lower}:${field}`);
    if (earlier !== undefined) {
      add({
        severity: 'error',
        code: 'duplicate_profile_variable',
        message: `${key} and ${earlier} set the same profile field (profile names are case-insensitive). Keep one of them.`,
        field: key,
      });
      continue;
    }
    sources.set(`${lower}:${field}`, key);
    const draft = drafts.get(lower) ?? { name: lower };
    if (field === 'SITE') draft.site = value;
    else if (field === 'EMAIL') draft.email = value;
    else draft.apiToken = value;
    drafts.set(lower, draft);
  }

  const out: Record<string, ProfileConfig> = {};
  for (const [key, draft] of drafts) {
    // Defined, not assigned: `PROFILE_NAME_RE` admits `__proto__`, and
    // assigning that key re-parents the record instead of adding a profile, so
    // the profile vanished and its API token never reached the redactor (CC-761).
    Object.defineProperty(out, key, {
      value: {
        name: draft.name,
        ...(draft.site === undefined ? {} : { site: draft.site }),
        ...(draft.email === undefined ? {} : { email: draft.email }),
        ...(draft.apiToken === undefined ? {} : { apiToken: draft.apiToken }),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
