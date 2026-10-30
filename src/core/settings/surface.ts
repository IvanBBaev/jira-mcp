// The tool surface (D516): package gating, the project scope guard (D400) and
// the write gate (`JIRA_WRITE_MODE`, the irreversible-write knobs).

import {
  IRREVERSIBLE_CONFIRMS,
  WRITE_MODES,
  type IrreversibleConfirm,
  type Settings,
  type WriteMode,
} from '../types.js';
import {
  DEFAULT_IRREVERSIBLE_CONFIRM,
  DEFAULT_TOOL_PACKAGES,
  DEFAULT_WRITE_MODE,
} from './defaults.js';
import type { EnvReader } from './env-reader.js';
import type { Add } from './report.js';

/**
 * What `JIRA_PROJECTS` accepts as a project key (D400): a letter, then letters,
 * digits or underscores, compared after upper-casing. Jira's own default is
 * stricter (2–10 characters), but an administrator can widen it, so only the
 * character class is enforced here.
 */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,254}$/;

/** The slice of `Settings` the surface section owns, in `Settings` key order. */
export type SurfaceSettings = Pick<
  Settings,
  | 'toolPackages'
  | 'packagesDeny'
  | 'packagesReadonly'
  | 'projects'
  | 'writeMode'
  | 'allowIrreversible'
  | 'irreversibleConfirm'
>;

/** Read package gating, the project scope and the write gate. */
export function readSurface(read: EnvReader, add: Add): SurfaceSettings {
  // --- Tool surface gating -------------------------------------------------
  const toolPackages = read.csv('JIRA_TOOL_PACKAGES');
  const packagesDeny = read.csv('JIRA_PACKAGES_DENY');
  const packagesReadonly = read.csv('JIRA_PACKAGES_READONLY');

  if (packagesDeny.includes('core')) {
    // CC-29: the deny list cannot remove `core` — capabilities and doctor must
    // always exist. The value passes through unchanged; `mcp/registry.ts` does
    // the re-adding, so this is the visible half of that invariant.
    add({
      severity: 'warning',
      code: 'core_package_undeniable',
      message:
        'JIRA_PACKAGES_DENY lists "core"; the core package is force-re-added (CC-29) because capabilities and doctor depend on it. Remove it from the deny list to silence this.',
      field: 'JIRA_PACKAGES_DENY',
    });
  }

  // --- Project scope guard (D400) -----------------------------------------
  // Keys, not ids: the operator writes what Jira shows. Upper-cased because a
  // Jira project key is upper case and the guard compares exactly. A token that
  // cannot be a project key is an ERROR finding: a typo here must not narrow
  // (or silently widen) the scope the operator meant.
  const projects: string[] = [];
  const projectsRaw = read.str('JIRA_PROJECTS');
  if (projectsRaw !== undefined) {
    for (const part of projectsRaw.split(',')) {
      const key = part.trim().toUpperCase();
      if (key.length === 0) continue;
      if (!PROJECT_KEY_PATTERN.test(key)) {
        add({
          severity: 'error',
          code: 'invalid_project_key',
          message: `JIRA_PROJECTS lists ${JSON.stringify(part.trim())}, which is not a Jira project key (a letter, then letters, digits or underscores; at most 255 characters). Fix or remove it.`,
          field: 'JIRA_PROJECTS',
        });
        continue;
      }
      if (!projects.includes(key)) projects.push(key);
    }
  }

  const writeMode = read.enumOf<WriteMode>(
    'JIRA_WRITE_MODE',
    WRITE_MODES,
    DEFAULT_WRITE_MODE,
  );
  const allowIrreversible = read.bool('JIRA_ALLOW_IRREVERSIBLE', false);
  const irreversibleConfirm = read.enumOf<IrreversibleConfirm>(
    'JIRA_IRREVERSIBLE_CONFIRM',
    IRREVERSIBLE_CONFIRMS,
    DEFAULT_IRREVERSIBLE_CONFIRM,
  );

  return {
    toolPackages: toolPackages.length > 0 ? toolPackages : [DEFAULT_TOOL_PACKAGES],
    packagesDeny,
    packagesReadonly,
    projects,
    writeMode,
    allowIrreversible,
    irreversibleConfirm,
  };
}
