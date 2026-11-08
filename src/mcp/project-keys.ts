// ---------------------------------------------------------------------------
// Project keys for `completion/complete`, stage B (D551, V3-66).
//
// One `jira_list_projects`-shaped read — `api.listProjects` on the default
// profile — cached for `JIRA_META_CACHE_TTL_S`, so a client typing a project
// key costs at most one Jira read per TTL, not one per keystroke:
//
//   - warm: the keys come from memory, no network on the completion path;
//   - cold or expired: one read, shared by every completion that arrives while
//     it runs (single flight), bounded by its own deadline;
//   - a failed read completes to nothing and is not cached, but the next read
//     waits out a short back-off, so a broken tenant is not hammered per key;
//   - `JIRA_PROJECTS` set: the scope's keys, with no Jira call at all — a key
//     outside the scope would only be refused by the scope guard (D400);
//   - `JIRA_META_CACHE_TTL_S=0`: no live completions; stage A only (D154).
//
// The Jira credential is process-wide (one per profile, never per session), so
// one cache per server factory is shared by every session it builds (D540).
//
// Layering: `core ← api ← mcp ← tools`.
// ---------------------------------------------------------------------------

import type { JiraApi } from '../api/port.js';
import type { Clock, JiraRequestFn } from '../core/types.js';

/** The budget of one project read made for a completion. */
export const PROJECT_KEYS_BUDGET_MS = 5_000;

/** How long a failed read keeps the next one from going out. */
export const PROJECT_KEYS_RETRY_MS = 30_000;

/** Supplies the project keys a `projectKey` completion offers. */
export type ProjectKeySource = () => Promise<readonly string[]>;

export interface ProjectKeyDeps {
  readonly api: JiraApi;
  /** The raw request seam; requests carry no profile, so the default one. */
  readonly jira: JiraRequestFn;
  readonly clock: Clock;
  /** `JIRA_META_CACHE_TTL_S`; `0` turns live completions off. */
  readonly ttlS: number;
  /** `JIRA_MAX_PAGES`, the page cap of the read. */
  readonly maxPages: number;
  /** `JIRA_PROJECTS` (D400): when non-empty, the keys offered, and no read. */
  readonly scope?: readonly string[] | undefined;
}

const NONE: readonly string[] = Object.freeze([]);

/**
 * The project-key source for completions, or `undefined` when live
 * completions are off (`ttlS` 0 and no scope).
 */
export function createProjectKeySource(
  deps: ProjectKeyDeps,
): ProjectKeySource | undefined {
  const scope = deps.scope ?? [];
  if (scope.length > 0) {
    const keys = Object.freeze([...new Set(scope)].sort());
    return () => Promise.resolve(keys);
  }
  if (deps.ttlS <= 0) return undefined;

  const ttlMs = deps.ttlS * 1000;
  const { clock } = deps;
  let cached: { readonly keys: readonly string[]; readonly until: number } | undefined;
  let retryAt = 0;
  let inFlight: Promise<readonly string[]> | undefined;

  async function load(): Promise<readonly string[]> {
    try {
      const loop = await deps.api.listProjects({
        jira: deps.jira,
        maxPages: deps.maxPages,
        deadlineAt: clock.now() + PROJECT_KEYS_BUDGET_MS,
        clock,
      });
      const keys = Object.freeze(
        [...new Set(loop.items.map((project) => project.key))].sort(),
      );
      cached = { keys, until: clock.now() + ttlMs };
      return keys;
    } catch {
      retryAt = clock.now() + PROJECT_KEYS_RETRY_MS;
      return NONE;
    }
  }

  return () => {
    const now = clock.now();
    if (cached !== undefined && now < cached.until) return Promise.resolve(cached.keys);
    if (inFlight !== undefined) return inFlight;
    if (now < retryAt) return Promise.resolve(NONE);
    // Cleared in a `.finally`, which always runs after this assignment — even
    // when the read fails before its first await.
    const flight = load().finally(() => {
      inFlight = undefined;
    });
    inFlight = flight;
    return flight;
  };
}
