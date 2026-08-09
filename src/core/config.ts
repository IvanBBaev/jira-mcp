// Env-file discovery and loading (WP-11).
//
// CONFIGURATION.md §Env file resolution owns the order; this module implements
// exactly it:
//
//   1. `JIRA_ENV_FILE`                                  (explicit path)
//   2. `$XDG_CONFIG_HOME/jira-mcp-ai/.env`              (default `~/.config/…`)
//   3. project-local `.env`                             (development only)
//
// The first candidate that EXISTS wins; the rest are not consulted. A missing
// file at a fallback location is normal operation (most deployments pass env
// vars from the MCP client config and have no file at all). A missing file at an
// explicit `JIRA_ENV_FILE` path is an error — the operator named a path, so
// silently ignoring it would start the server with the wrong credentials.
//
// Loading goes through Node's own `process.loadEnvFile()`; dotenv is banned
// (D10) because dotenv ≥ 17 prints a banner on **stdout**, which is the MCP
// protocol channel. `process.loadEnvFile` also has the precedence we want: a
// variable already present in `process.env` is NOT overwritten by the file, so
// values passed by the MCP client win over the file (verified behaviour of the
// `--env-file` loader this API shares).

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Directory name used under `$XDG_CONFIG_HOME` / `~/.config`. */
export const CONFIG_DIR_NAME = 'jira-mcp-ai';

/** Which rule produced a candidate path. */
export type EnvFileSource = 'explicit' | 'xdg' | 'project';

/** One location the env file may live in, in resolution order. */
export interface EnvFileCandidate {
  readonly source: EnvFileSource;
  readonly path: string;
}

/** Stable problem codes; substring-asserted in tests. */
export type EnvFileProblemCode =
  'env_file_missing' | 'env_file_unreadable' | 'env_file_permissive';

/** Severity mirrors the startup-report severities. */
export type EnvFileProblemSeverity = 'error' | 'warning';

/** Something wrong with the env file itself (not with its contents). */
export interface EnvFileProblem {
  readonly severity: EnvFileProblemSeverity;
  readonly code: EnvFileProblemCode;
  readonly message: string;
  readonly field: string;
}

/** Outcome of {@link loadEnvFile}. */
export interface EnvFileResult {
  /** True when a file was found AND read into `process.env`. */
  readonly loaded: boolean;
  /** The file that was used, when one was. */
  readonly path?: string;
  readonly source?: EnvFileSource;
  /** Permission bits (`mode & 0o777`) of the used file — doctor probe 3 reads it. */
  readonly mode?: number;
  /** Every location that was considered, in order. */
  readonly candidates: readonly EnvFileCandidate[];
  readonly problems: readonly EnvFileProblem[];
}

/**
 * Filesystem seam. Tests substitute it to observe which path was loaded without
 * mutating the real `process.env`; production uses {@link nodeEnvFileHost}.
 */
export interface EnvFileHost {
  /** `mode & 0o777` of a regular file, or `undefined` when it is not one. */
  statFile(path: string): number | undefined;
  /** Load into `process.env`; throws when the file cannot be read or parsed. */
  loadFile(path: string): void;
}

/** The real host: `statSync` + `process.loadEnvFile`. */
export const nodeEnvFileHost: EnvFileHost = {
  statFile(path: string): number | undefined {
    try {
      const stat = statSync(path);
      return stat.isFile() ? stat.mode & 0o777 : undefined;
    } catch {
      return undefined;
    }
  },
  loadFile(path: string): void {
    process.loadEnvFile(path);
  },
};

/** Inputs for env-file resolution; every ambient value is injectable for tests. */
export interface EnvFileOptions {
  /** Env to read `JIRA_ENV_FILE` / `XDG_CONFIG_HOME` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Home directory for the `~/.config` fallback. Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** Working directory for the project-local `.env`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Platform; only used to skip POSIX permission checks on Windows. */
  readonly platform?: NodeJS.Platform;
  /** Filesystem seam. Defaults to {@link nodeEnvFileHost}. */
  readonly host?: EnvFileHost;
}

/** Expand a leading `~` — env vars carry no shell expansion of their own. */
function expandTilde(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homeDir, path.slice(2));
  }
  return path;
}

/**
 * The ordered candidate list. Exported because `doctor` reports where it looked
 * — "no env file found" is only actionable next to the paths that were tried.
 */
export function resolveEnvFileCandidates(
  options: EnvFileOptions = {},
): readonly EnvFileCandidate[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  const candidates: EnvFileCandidate[] = [];

  const explicit = env.JIRA_ENV_FILE?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    candidates.push({
      source: 'explicit',
      path: resolve(cwd, expandTilde(explicit, homeDir)),
    });
  }

  // A relative `XDG_CONFIG_HOME` is invalid per the XDG spec and must be
  // ignored rather than resolved against the cwd — resolving it would make the
  // config location depend on where the server happened to be started.
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configHome =
    xdg !== undefined && xdg.length > 0 && isAbsolute(expandTilde(xdg, homeDir))
      ? expandTilde(xdg, homeDir)
      : homeDir.length > 0
        ? join(homeDir, '.config')
        : undefined;
  if (configHome !== undefined) {
    candidates.push({ source: 'xdg', path: join(configHome, CONFIG_DIR_NAME, '.env') });
  }

  candidates.push({ source: 'project', path: resolve(cwd, '.env') });

  return candidates;
}

/**
 * The path a writer (`doctor --save`, future `login`) should create: the
 * explicit override when set, otherwise the XDG location. Never the
 * project-local `.env` — writing credentials into a checkout is a footgun.
 */
export function preferredEnvFilePath(options: EnvFileOptions = {}): string {
  const candidates = resolveEnvFileCandidates(options);
  const writable = candidates.find((c) => c.source !== 'project');
  // `resolveEnvFileCandidates` always ends with the project candidate, so the
  // fallback below only triggers when there is no home directory at all.
  return writable?.path ?? candidates[candidates.length - 1]?.path ?? resolve('.env');
}

/**
 * Resolve and load the env file, if there is one. Never throws: every failure
 * becomes a problem in the result, so the startup report can show all of them
 * at once.
 */
export function loadEnvFile(options: EnvFileOptions = {}): EnvFileResult {
  const host = options.host ?? nodeEnvFileHost;
  const platform = options.platform ?? process.platform;
  const candidates = resolveEnvFileCandidates(options);
  const problems: EnvFileProblem[] = [];

  for (const candidate of candidates) {
    const mode = host.statFile(candidate.path);

    if (mode === undefined) {
      if (candidate.source === 'explicit') {
        problems.push({
          severity: 'error',
          code: 'env_file_missing',
          message: `JIRA_ENV_FILE points at ${candidate.path}, which does not exist or is not a readable file. Create it or unset JIRA_ENV_FILE to fall back to ~/.config/${CONFIG_DIR_NAME}/.env.`,
          field: 'JIRA_ENV_FILE',
        });
        // An explicit path that is wrong must not silently fall through to a
        // different file — the operator would then debug the wrong credentials.
        return { loaded: false, candidates, problems };
      }
      continue;
    }

    // 0600 is what `doctor --save` writes; anything group/other readable means
    // the token is exposed to other accounts on the machine. Warning, not
    // error: refusing to start would strand an operator behind a bad umask.
    if (platform !== 'win32' && (mode & 0o077) !== 0) {
      problems.push({
        severity: 'warning',
        code: 'env_file_permissive',
        message: `Env file ${candidate.path} has mode 0${mode.toString(8)}; it holds the API token. Run: chmod 600 ${candidate.path}`,
        field: 'JIRA_ENV_FILE',
      });
    }

    try {
      host.loadFile(candidate.path);
    } catch (cause) {
      problems.push({
        severity: 'error',
        code: 'env_file_unreadable',
        message: `Env file ${candidate.path} could not be loaded (${String(cause)}). Fix the file's syntax or permissions.`,
        field: 'JIRA_ENV_FILE',
      });
      return {
        loaded: false,
        path: candidate.path,
        source: candidate.source,
        mode,
        candidates,
        problems,
      };
    }

    return {
      loaded: true,
      path: candidate.path,
      source: candidate.source,
      mode,
      candidates,
      problems,
    };
  }

  return { loaded: false, candidates, problems };
}
