// Tag-pinned documentation links for operator-facing remediations (D545).
//
// `doctor`, the startup configuration report, `login` and `--help` tell the
// operator where to read on. The npm tarball does not ship `docs/`, so a bare
// "see AUTH.md" points nowhere, and a `blob/main` URL describes whatever `main`
// says today — behaviour the installed version may not have. Every such link is
// built here instead: an absolute GitHub URL pinned to the tag of the installed
// version (`v<package.json version>`), so the page an operator opens is the
// page that shipped with the binary they run.
//
// THE ANCHOR REGISTRY IS THE CONTRACT. `docUrl` accepts only a file and anchor
// listed in `DOC_ANCHORS`, so the compiler refuses an unlisted one, and
// `doc-url.test.ts` resolves every listed anchor against the heading it names in
// `docs/`. A renamed heading therefore fails the gate instead of shipping a link
// that lands at the top of the page. The same test bans a `.md` file name in a
// string literal of the operator-facing modules, so a remediation cannot bypass
// the helper.
//
// The version is read from `package.json` once, lazily. A broken install whose
// manifest cannot be read falls back to `main`: a link to the newest docs is
// better than a link to a tag that does not exist.

import { readFileSync } from 'node:fs';

/** The repository the docs live in. */
export const DOC_REPO_URL = 'https://github.com/IvanBBaev/jira-mcp';

/**
 * Every anchor a remediation may link to, per file under `docs/`. An empty
 * string means "the top of the page". Add an anchor here before using it; the
 * test proves it exists.
 */
export const DOC_ANCHORS = {
  'AUTH.md': ['scoped-api-tokens'],
  'CONFIGURATION.md': [
    '',
    'jira-data-center-phase-13--unverified-preview',
    'proxy-and-custom-ca',
  ],
  'TROUBLESHOOTING.md': [
    '',
    'config',
    'auth',
    'permission',
    'not_found',
    'validation',
    'rate_limited',
    'transport',
    'timeout',
    'ambiguous_write',
    'budget_exceeded',
    'write_gated',
    'unexpected_shape',
    'unsupported',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** A file under `docs/` that remediations link to. */
export type DocFile = keyof typeof DOC_ANCHORS;

/** An anchor registered for `F`. */
export type DocAnchor<F extends DocFile> = (typeof DOC_ANCHORS)[F][number];

let cachedRef: string | undefined;

/**
 * The git ref docs are pinned to: `v<version>` for a readable version,
 * `main` for a missing or empty one.
 */
export function docRef(version: string | undefined): string {
  return version === undefined || version === '' ? 'main' : `v${version}`;
}

/** `package.json`'s version, or `undefined` when the manifest cannot be read. */
export function readPackageVersion(
  read: (url: URL) => string = (url) => readFileSync(url, 'utf8'),
): string | undefined {
  try {
    // From `build/core/doc-url.js` this resolves to the package root, which npm
    // always ships whatever `files` says.
    const raw: unknown = JSON.parse(read(new URL('../../package.json', import.meta.url)));
    if (raw !== null && typeof raw === 'object') {
      const version = (raw as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    // A broken install still gets a link — to `main`, see docRef.
  }
  return undefined;
}

/**
 * The tag-pinned URL of `docs/<file>#<anchor>`.
 *
 * `ref` defaults to the installed version's tag; tests pass one explicitly.
 */
export function docUrl<F extends DocFile>(
  file: F,
  anchor: DocAnchor<F>,
  ref: string = (cachedRef ??= docRef(readPackageVersion())),
): string {
  const base = `${DOC_REPO_URL}/blob/${ref}/docs/${file}`;
  return anchor === '' ? base : `${base}#${anchor}`;
}
