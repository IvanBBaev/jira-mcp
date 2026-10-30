// Secret registration (D516): every secret value in the environment, for the
// redactor, and the warning when one of them would blank ordinary output.

import {
  DEFAULT_PLACEHOLDER,
  MIN_DISTINCTIVE_SECRET_LENGTH,
  redactionRisk,
} from '../redact.js';
import type { Settings } from '../types.js';
import { profileVar } from './profiles.js';
import type { Add } from './report.js';

/**
 * Every secret value in the environment paired with the variable it came from —
 * the active token, the tokens of INACTIVE profiles, `JIRA_HTTP_TOKEN` and the
 * OAuth client secret (AUTH.md §Secret registration is exhaustive at startup).
 * {@link collectSecrets} is this list with the names dropped, so a diagnostic
 * that names a variable and the set actually handed to the redactor can never
 * drift apart.
 *
 * Registration ignores `authMode` on purpose: a client secret sitting in the
 * environment of a server running basic auth is still a secret, and the mode is
 * exactly the kind of thing that gets flipped between runs.
 */
function secretVariables(settings: Settings): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  const push = (field: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) out.push({ field, value });
  };
  push('JIRA_API_TOKEN', settings.apiToken);
  for (const profile of Object.values(settings.profiles)) {
    push(profileVar(profile.name, 'API_TOKEN'), profile.apiToken);
  }
  push('JIRA_HTTP_TOKEN', settings.httpToken);
  push('JIRA_OAUTH_CLIENT_SECRET', settings.oauth.clientSecret);
  push('JIRA_PAT', settings.pat);
  return out;
}

/**
 * Every secret value in the environment. Deduplicated and order-stable so the
 * redactor's longest-first ordering is reproducible.
 */
export function collectSecrets(settings: Settings): readonly string[] {
  const seen = new Set<string>();
  for (const { value } of secretVariables(settings)) seen.add(value);
  return [...seen];
}

/**
 * The redaction blast radius. Every secret is registered with the redactor as
 * a literal needle, so a placeholder token (`t`, `settings`) scrubs the
 * server's own output away and the operator is left staring at a wall of
 * placeholders with nothing saying why. The redactor will not refuse such a
 * value — declining to protect a secret is the one failure mode worse than an
 * unreadable log (see `redactionRisk`) — so the complaint belongs here, where a
 * `warning` is visible in doctor and in the startup report and still lets the
 * server run. One finding per variable, not per distinct value: two variables
 * holding the same placeholder are two edits the operator has to make.
 */
export function checkRedaction(settings: Settings, add: Add): void {
  for (const { field, value } of secretVariables(settings)) {
    const risk = redactionRisk(value);
    if (risk === undefined) continue;
    add({
      severity: 'warning',
      code: 'redaction_collision',
      message:
        risk === 'too_short'
          ? `${field} is shorter than ${String(MIN_DISTINCTIVE_SECRET_LENGTH)} characters. Secrets are redacted as literal text, so a value this short also blanks ordinary text that contains it and output comes back as a wall of ${DEFAULT_PLACEHOLDER}. Nothing is under-redacted; replace the placeholder with the real credential to get readable output back.`
          : `${field} is a substring of text this server prints itself, so redacting it blanks that text too and diagnostics come back unreadable. Nothing is under-redacted; replace the placeholder with the real credential to get readable output back.`,
      field,
    });
  }
}
