/**
 * surface-facts — the tool-surface numbers the README and the Pages site quote,
 * computed from the built manifest and the released-surface baseline (D526).
 *
 * Two sources, both machine-owned:
 *   - `build/tools/index.js` — the manifest `main` registers (what is on `main`);
 *   - `src/tools/released.json` — which release first shipped each tool, the
 *     latest release, the next version, and the Gate C live-proof figures.
 *
 * A count in prose is written as `<!-- count:KEY -->N<!-- /count -->` and a
 * version as `<!-- version:KEY -->X.Y.Z<!-- /version -->`; docs-lint resolves
 * every KEY here and fails on a mismatch. Count keys:
 *
 *   tools | reads | writes | standard | irreversible   [:<package>] [@<version>]
 *   packages                                             [@<version>]
 *   unproven | unproven-reads | unproven-writes          [@<version>]
 *   live | live-reads | live-writes
 *   unreleased
 *
 * `@<version>` counts the tools a release shipped (`@released` = the latest);
 * no suffix counts `main`. `unproven*` is the matching count minus the live
 * figure, so it needs a version at or after `live.release`.
 *
 * Version keys: `released` (the latest release) and `next` (the version the
 * unreleased rows will ship in).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = resolve(REPO_ROOT, 'build/tools/index.js');
export const RELEASED_PATH = resolve(REPO_ROOT, 'src/tools/released.json');

const VERSION_RE = /^\d+\.\d+\.\d+$/u;

/** Numeric semver comparison of plain `X.Y.Z` versions. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** The built manifest's packages. Requires `npm run build`. */
export async function loadPackages(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `The built manifest ${manifestPath} does not exist. Run \`npm run build\` first.`,
    );
  }
  const module = await import(pathToFileURL(manifestPath).href);
  return module.PACKAGES;
}

/** The released-surface baseline, shape-checked so a typo fails loudly. */
export function loadReleased(path = RELEASED_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const bad = (what) => new Error(`${path}: ${what}`);
  if (!VERSION_RE.test(data.version ?? '')) throw bad('version must be X.Y.Z');
  if (!VERSION_RE.test(data.next ?? '')) throw bad('next must be X.Y.Z');
  if (compareVersions(data.next, data.version) <= 0) {
    throw bad(`next (${data.next}) must be after version (${data.version})`);
  }
  const live = data.live ?? {};
  if (!VERSION_RE.test(live.release ?? '')) throw bad('live.release must be X.Y.Z');
  if (!Number.isInteger(live.reads) || !Number.isInteger(live.writes)) {
    throw bad('live.reads and live.writes must be integers');
  }
  for (const [name, since] of Object.entries(data.since ?? {})) {
    if (!VERSION_RE.test(since) || compareVersions(since, data.version) > 0) {
      throw bad(`since.${name} must be X.Y.Z, at or before ${data.version}`);
    }
  }
  return data;
}

export function saveReleased(data, path = RELEASED_PATH) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * Mark everything on `main` as shipped in `version` and move `next` on.
 * Tools that were already released keep their first version.
 */
export function stampRelease(released, packages, version, next) {
  if (!VERSION_RE.test(version) || !VERSION_RE.test(next)) {
    throw new Error('--released and --next need X.Y.Z versions.');
  }
  if (compareVersions(version, released.version) <= 0) {
    throw new Error(`--released ${version} is not after ${released.version}.`);
  }
  const since = { ...released.since };
  for (const pkg of packages) {
    for (const tool of pkg.tools) since[tool.name] ??= version;
  }
  return { ...released, version, next, since };
}

/** The release that first shipped a tool, or `undefined` when it is unreleased. */
export function sinceOf(released, name) {
  return released.since[name];
}

function kind(tool) {
  if (tool.annotations.readOnlyHint) return 'reads';
  return tool.writeTier === 'irreversible' ? 'irreversible' : 'standard';
}

/**
 * Resolve one count key, or return `{ error }` saying why it cannot be.
 * See the module comment for the grammar.
 */
export function resolveCount(key, packages, released) {
  const match = /^([a-z-]+)(?::([a-z-]+))?(?:@([\w.]+))?$/u.exec(key);
  if (!match) return { error: `malformed count key ${JSON.stringify(key)}` };
  const [, metric, pkgId, rawVersion] = match;
  const version = rawVersion === 'released' ? released.version : rawVersion;
  if (version !== undefined && !VERSION_RE.test(version)) {
    return { error: `unknown version ${JSON.stringify(rawVersion)} in ${key}` };
  }
  if (version !== undefined && compareVersions(version, released.version) > 0) {
    return { error: `${key} names a version after the latest release` };
  }

  const shipped = (tool) => {
    if (version === undefined) return true;
    const since = sinceOf(released, tool.name);
    return since !== undefined && compareVersions(since, version) <= 0;
  };
  let scope = packages;
  if (pkgId !== undefined) {
    scope = packages.filter((pkg) => pkg.id === pkgId);
    if (scope.length === 0) return { error: `unknown package ${pkgId} in ${key}` };
  }
  const tools = scope.flatMap((pkg) => pkg.tools.filter(shipped));
  const count = (wanted) =>
    tools.filter((tool) => {
      const k = kind(tool);
      if (wanted === 'tools') return true;
      if (wanted === 'writes') return k !== 'reads';
      return k === wanted;
    }).length;

  const live = { reads: released.live.reads, writes: released.live.writes };
  live.tools = live.reads + live.writes;
  const noScope = pkgId === undefined && rawVersion === undefined;

  switch (metric) {
    case 'tools':
    case 'reads':
    case 'writes':
    case 'standard':
    case 'irreversible':
      return { value: count(metric) };
    case 'packages':
      if (pkgId !== undefined) return { error: `${key}: packages takes no package` };
      return { value: scope.filter((pkg) => pkg.tools.some(shipped)).length };
    case 'live':
    case 'live-reads':
    case 'live-writes':
      if (!noScope) return { error: `${key}: live figures take no package or version` };
      return { value: live[metric === 'live' ? 'tools' : metric.slice(5)] };
    case 'unproven':
    case 'unproven-reads':
    case 'unproven-writes': {
      if (pkgId !== undefined) return { error: `${key}: unproven takes no package` };
      if (version !== undefined && compareVersions(version, released.live.release) < 0) {
        return { error: `${key}: the live run covers ${released.live.release}` };
      }
      const of = metric === 'unproven' ? 'tools' : metric.slice(9);
      return { value: count(of) - live[of] };
    }
    case 'unreleased': {
      if (!noScope) return { error: `${key}: unreleased takes no package or version` };
      const all = packages.flatMap((pkg) => pkg.tools);
      return {
        value: all.filter((tool) => sinceOf(released, tool.name) === undefined).length,
      };
    }
    default:
      return { error: `unknown count metric ${JSON.stringify(metric)} in ${key}` };
  }
}

/** Resolve one version key. */
export function resolveVersion(key, released) {
  if (key === 'released') return { value: released.version };
  if (key === 'next') return { value: released.next };
  return { error: `unknown version key ${JSON.stringify(key)}` };
}
