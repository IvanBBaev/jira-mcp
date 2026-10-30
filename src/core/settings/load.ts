// `loadSettings` (D516): read the env file, then fold the section readers in
// a fixed order into one `Settings` value and one aggregated report. The order
// is the order findings appear in the report, so it is part of the contract.

import { loadEnvFile } from '../config.js';
import type { EnvFileResult, EnvFileOptions } from '../config.js';
import { resolveHost } from '../host.js';
import type { Clock, HostRef, Settings } from '../types.js';
import { readAuth } from './auth.js';
import { createEnvReader } from './env-reader.js';
import { fromHostProblem } from './hosts.js';
import { readLimits } from './limits.js';
import { readProfiles } from './profiles.js';
import {
  buildReport,
  type Add,
  type StartupFinding,
  type StartupReport,
} from './report.js';
import { checkCredentials, checkDeployment } from './requirements.js';
import { checkRedaction, collectSecrets } from './secrets.js';
import { readSurface } from './surface.js';
import { checkTokenExpiry } from './token-expiry.js';
import { readDiagnostics, readTransport } from './transport.js';

/** What `main()` and `doctor` receive from one environment pass. */
export interface LoadSettingsResult {
  readonly settings: Settings;
  readonly report: StartupReport;
  /**
   * Every secret VALUE found in the environment, deduplicated — feed it
   * straight to `createRedactor({ secrets })` (WP-12) before anything logs.
   * Registration is exhaustive on purpose (AUTH.md): an unused profile token is
   * still a secret that must never reach a transcript.
   */
  readonly secrets: readonly string[];
  /** Resolved host; absent when `JIRA_SITE` is missing, malformed or denied. */
  readonly host?: HostRef;
  /** Which env file was used, and where the loader looked. */
  readonly envFile: EnvFileResult;
}

/** Options for {@link loadSettings}; every ambient input is injectable. */
export interface LoadSettingsOptions extends EnvFileOptions {
  /**
   * Clock used for the `JIRA_TOKEN_EXPIRES` horizon. When omitted the expiry
   * is still parsed and validated, but no `token_expiry_warning` is produced —
   * `Date.now()` is banned outside `core/clock.ts` [eslint], so time has to be
   * injected. `main()` and `doctor` pass the real clock.
   */
  readonly clock?: Clock;
  /**
   * Read the env file before parsing. Default `true`, but the file is only
   * loaded when reading `process.env` — a caller-supplied `env` object is used
   * verbatim, which is what makes tests hermetic.
   */
  readonly loadEnvFile?: boolean;
}

/**
 * Resolve the whole `JIRA_*` surface, aggregating every problem. Never throws.
 */
export function loadSettings(options: LoadSettingsOptions = {}): LoadSettingsResult {
  const env = options.env ?? process.env;
  const usingProcessEnv = env === process.env;

  // Env-first: the file only populates variables the client did not pass
  // (`process.loadEnvFile` does not overwrite existing entries).
  const envFile =
    usingProcessEnv && (options.loadEnvFile ?? true)
      ? loadEnvFile(options)
      : { loaded: false, candidates: [], problems: [] };

  const findings: StartupFinding[] = [];
  const add: Add = (finding) => findings.push(finding);
  for (const problem of envFile.problems) {
    add({
      severity: problem.severity,
      code: problem.code,
      message: problem.message,
      field: problem.field,
    });
  }
  const read = createEnvReader(env, add);

  const auth = readAuth(read, options, add);
  const profile = readProfiles(env, read, add);
  const effective = checkCredentials(auth, profile, add);
  checkDeployment(auth, add);
  const resolution = resolveHost(
    effective.site,
    auth.allowedHosts,
    effective.variable,
    auth.deployment,
  );
  for (const problem of resolution.problems) add(fromHostProblem(problem));
  checkTokenExpiry(auth.tokenExpires, auth.authMode, options.clock, add);
  const surface = readSurface(read, add);
  const limits = readLimits(read, options, add);
  const transport = readTransport(read, add);
  const diagnostics = readDiagnostics(read, options);

  const settings: Settings = {
    ...auth,
    profiles: profile.profiles,
    activeProfile: profile.activeProfileRaw,
    lockProfile: profile.lockProfile,
    ...surface,
    ...limits,
    ...transport,
    ...diagnostics,
  };
  checkRedaction(settings, add);

  return {
    settings,
    report: buildReport(findings),
    secrets: collectSecrets(settings),
    ...(resolution.host === undefined ? {} : { host: resolution.host }),
    envFile,
  };
}
