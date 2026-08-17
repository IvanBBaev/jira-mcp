// ---------------------------------------------------------------------------
// Env ↔ docs sync (TESTING.md suite 8).
//
// docs/CONFIGURATION.md is the contract a user configures the server against.
// Nothing in the build enforces that it stays true, so this test does: it
// collects every `JIRA_*` name that appears in the TypeScript sources and every
// variable row of the configuration tables, and asserts the two sets are equal
// and that every documented default literal is the value the loader actually
// falls back to.
//
// Both failure directions matter and both name the offender:
//   - a variable read by the code but absent from the docs is invisible to the
//     user, and — because `server.json` is checked against this same table by
//     `src/manifest-sync.test.ts` (suite 10) rather than generated from it —
//     invisible to anyone installing from the MCP registry too;
//   - a documented variable no longer read anywhere is a promise the server
//     stopped keeping.
//
// The scan reads the ORIGINAL `src/**/*.ts`, not the compiled output, because
// the compiler erases the type-level and comment-level mentions that make a
// variable discoverable. The repo root is found by walking up from this file's
// compiled location (`build/env-docs-sync.test.js`), so the test works no matter
// where the runner is invoked from.
//
// Scope: `JIRA_*` only, deliberately. `XDG_CONFIG_HOME` and `HOME` participate
// in env-file resolution but carry no prefix, and widening the scan to every
// SCREAMING_CASE identifier would drown the signal in unrelated constants.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadSettings } from './core/settings.js';
import type { Settings } from './core/types.js';

// ---------------------------------------------------------------------------
// Repo layout
// ---------------------------------------------------------------------------

/** Nearest ancestor of the compiled test file that holds the manifest. */
function repoRoot(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let hops = 0; hops < 8; hops += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  assert.fail('could not locate the repo root from the compiled test location');
}

const ROOT = repoRoot();
const SRC_DIR = join(ROOT, 'src');
const DOC_PATH = join(ROOT, 'docs', 'CONFIGURATION.md');

// ---------------------------------------------------------------------------
// The source side
// ---------------------------------------------------------------------------

/**
 * `JIRA_PROFILE_<NAME>_SITE|EMAIL|API_TOKEN` is a family, not a variable: the
 * code builds the names at runtime and the docs write them with a placeholder,
 * so neither side ever produces a concrete token. Both sides collapse to this
 * one label instead.
 */
const PROFILE_FAMILY = 'JIRA_PROFILE_<NAME>_*';

/**
 * `JIRA_`-prefixed identifiers that are exported constants, not environment
 * variables. Each one is listed with the reason it is not a config knob — an
 * unexplained entry here is how a real variable disappears from the docs.
 */
const NOT_ENV_VARS = new Map<string, string>([
  ['JIRA_ACCEPT_MODES', 'core/types.ts: the response decoding modes (json / binary).'],
  ['JIRA_API_ROOTS', 'core/types.ts: the API root vocabulary (v3 / agile).'],
  ['JIRA_ERROR_KINDS', 'core/types.ts: the error-kind catalog of TOOLS.md.'],
  ['JIRA_ROOT_PATHS', 'core/http-util.ts: the path prefix each API root lives under.'],
]);

/** A `JIRA_*` token as it appears in the sources, with where it was seen. */
type Sightings = ReadonlyMap<string, readonly string[]>;

const ENV_TOKEN_RE = /\bJIRA_[A-Z0-9_]*[A-Z0-9]\b/g;

let sourceCache: Sightings | undefined;

async function scanSource(): Promise<Sightings> {
  if (sourceCache !== undefined) return sourceCache;

  const entries = await readdir(SRC_DIR, { recursive: true });
  const files = entries
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .sort();
  assert.ok(files.length > 20, `expected a populated src tree, found ${files.length}`);

  const seen = new Map<string, string[]>();
  const note = (token: string, file: string): void => {
    const at = seen.get(token);
    if (at === undefined) seen.set(token, [file]);
    else if (!at.includes(file)) at.push(file);
  };

  for (const file of files) {
    const text = await readFile(join(SRC_DIR, file), 'utf8');
    const relative = `src/${file.split('\\').join('/')}`;

    for (const [token] of text.matchAll(ENV_TOKEN_RE)) {
      if (NOT_ENV_VARS.has(token)) continue;
      note(token.startsWith('JIRA_PROFILE_') ? PROFILE_FAMILY : token, relative);
    }
    // The profile names are assembled from parts (`JIRA_PROFILE_${name}_SITE`),
    // so no whole token ever appears — the prefix is the only evidence there is.
    if (text.includes('JIRA_PROFILE_')) note(PROFILE_FAMILY, relative);
  }

  sourceCache = seen;
  return seen;
}

// ---------------------------------------------------------------------------
// The docs side
// ---------------------------------------------------------------------------

interface DocRow {
  /** Variable name, or `PROFILE_FAMILY` for the profile row. */
  readonly name: string;
  /** Documented default, or `undefined` for the `—` placeholder. */
  readonly defaultValue: string | undefined;
  /** The `##` heading the row sits under. */
  readonly section: string;
  /** 1-based line number in docs/CONFIGURATION.md, for failure messages. */
  readonly line: number;
}

const TEST_ONLY_SECTION = 'Test-only variables';
const NO_DEFAULT_CELL = '—';

/** Split a markdown table row into trimmed cells. */
function cells(line: string): string[] {
  return line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((cell) => cell.trim());
}

/** `` `value` `` → `value`; the em-dash placeholder → `undefined`. */
function parseDefault(cell: string, line: number): string | undefined {
  if (cell === NO_DEFAULT_CELL) return undefined;
  const literal = /^`([^`]+)`$/.exec(cell);
  assert.ok(
    literal !== null,
    `docs/CONFIGURATION.md:${line}: a Default cell must be \`backticked\` or ` +
      `the placeholder "${NO_DEFAULT_CELL}", found ${JSON.stringify(cell)}`,
  );
  return literal[1];
}

let docsCache: readonly DocRow[] | undefined;

async function parseDocs(): Promise<readonly DocRow[]> {
  if (docsCache !== undefined) return docsCache;

  const lines = (await readFile(DOC_PATH, 'utf8')).split('\n');
  const rows: DocRow[] = [];

  let section = '';
  let defaultColumn: number | undefined;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const lineNumber = index + 1;

    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      continue;
    }
    if (!line.startsWith('|')) {
      defaultColumn = undefined;
      continue;
    }

    const cell = cells(line);
    const first = cell[0] ?? '';

    // Header row: remember which column carries the defaults. The tables do not
    // all have the same shape (some carry a "Required" column), so the index is
    // read off the header rather than assumed.
    if (first === 'Variable') {
      defaultColumn = cell.indexOf('Default');
      assert.notEqual(
        defaultColumn,
        -1,
        `docs/CONFIGURATION.md:${lineNumber}: a variable table needs a Default column`,
      );
      continue;
    }
    if (defaultColumn === undefined) continue; // a table that lists something else
    if (/^-+$/.test(first.replaceAll(':', ''))) continue; // the ---|--- separator

    // Only the first cell names variables: descriptions cross-reference other
    // variables in backticks and must not be mistaken for rows of their own.
    const names = [...first.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1] ?? '')
      .filter((name) => name.startsWith('JIRA_'))
      .map((name) => (name.startsWith('JIRA_PROFILE_') ? PROFILE_FAMILY : name));
    if (names.length === 0) continue;

    const unique = [...new Set(names)];
    assert.equal(
      unique.length,
      1,
      `docs/CONFIGURATION.md:${lineNumber}: one row must document one variable, ` +
        `found ${unique.join(', ')}`,
    );

    rows.push({
      name: unique[0] ?? '',
      defaultValue: parseDefault(cell[defaultColumn] ?? '', lineNumber),
      section,
      line: lineNumber,
    });
  }

  docsCache = rows;
  return rows;
}

// ---------------------------------------------------------------------------
// The defaults side
// ---------------------------------------------------------------------------

/**
 * How a documented variable shows up in a `Settings` built from an EMPTY
 * environment — i.e. its effective default. `undefined` means "no default";
 * the docs write that as `—`.
 *
 * Every documented variable needs an entry (asserted below), so adding a row to
 * docs/CONFIGURATION.md without teaching the loader about it fails here.
 */
type DefaultProbe = (settings: Settings) => string | undefined;

/** A variable the loader does not own — nothing in `Settings` to compare to. */
const NOT_IN_SETTINGS: DefaultProbe = () => undefined;

const list = (values: readonly string[]): string | undefined =>
  values.length === 0 ? undefined : values.join(',');

const CODE_DEFAULTS: ReadonlyMap<string, DefaultProbe> = new Map([
  // Resolved by core/config.ts before settings exist.
  ['JIRA_ENV_FILE', NOT_IN_SETTINGS],
  ['JIRA_SITE', (s: Settings) => s.site],
  ['JIRA_EMAIL', (s: Settings) => s.email],
  ['JIRA_API_TOKEN', (s: Settings) => s.apiToken],
  ['JIRA_TOKEN_EXPIRES', (s: Settings) => s.tokenExpires],
  ['JIRA_ALLOWED_HOSTS', (s: Settings) => list(s.allowedHosts)],
  [PROFILE_FAMILY, (s: Settings) => list(Object.keys(s.profiles))],
  ['JIRA_ACTIVE_PROFILE', (s: Settings) => s.activeProfile],
  ['JIRA_LOCK_PROFILE', (s: Settings) => String(s.lockProfile)],
  ['JIRA_TOOL_PACKAGES', (s: Settings) => list(s.toolPackages)],
  ['JIRA_PACKAGES_DENY', (s: Settings) => list(s.packagesDeny)],
  ['JIRA_PACKAGES_READONLY', (s: Settings) => list(s.packagesReadonly)],
  ['JIRA_WRITE_MODE', (s: Settings) => s.writeMode],
  ['JIRA_ALLOW_IRREVERSIBLE', (s: Settings) => String(s.allowIrreversible)],
  ['JIRA_REQUEST_TIMEOUT_MS', (s: Settings) => String(s.requestTimeoutMs)],
  ['JIRA_CALL_BUDGET_MS', (s: Settings) => String(s.callBudgetMs)],
  ['JIRA_HOST_CONCURRENCY', (s: Settings) => String(s.hostConcurrency)],
  ['JIRA_RETRY_ATTEMPTS', (s: Settings) => String(s.retryAttempts)],
  ['JIRA_MAX_RESULT_CHARS', (s: Settings) => String(s.maxResultChars)],
  ['JIRA_MAX_PAGES', (s: Settings) => String(s.maxPages)],
  ['JIRA_MEDIA_DIR', (s: Settings) => s.mediaDir],
  ['JIRA_TRANSPORT', (s: Settings) => s.transport],
  ['JIRA_HTTP_PORT', (s: Settings) => String(s.httpPort)],
  ['JIRA_HTTP_TOKEN', (s: Settings) => s.httpToken],
  ['JIRA_LOG_LEVEL', (s: Settings) => s.logLevel],
  ['JIRA_JOURNAL_PATH', (s: Settings) => s.journalPath],
  // Read by the test harness (src/testing/), never by the server.
  ['JIRA_LIVE_TEST', NOT_IN_SETTINGS],
]);

/**
 * Settings as they come out of an EMPTY environment: `env: {}` is not
 * `process.env`, so the loader skips the env file too and every value below is
 * a hard-coded default rather than something this machine happens to export.
 */
function defaultSettings(): Settings {
  return loadSettings({ env: {}, loadEnvFile: false }).settings;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('env ↔ docs sync', () => {
  test('the scan finds the variables it is supposed to find', async () => {
    // A parser that silently matches nothing would make every set comparison
    // below pass. These sentinels fail first, and say so.
    const source = await scanSource();
    const docs = await parseDocs();

    assert.ok(
      source.size >= 20,
      `the source scan found only ${source.size} JIRA_* names — the scan is broken`,
    );
    assert.ok(
      docs.length >= 20,
      `the docs parse found only ${docs.length} rows — the table shape changed`,
    );
    for (const sentinel of ['JIRA_SITE', 'JIRA_WRITE_MODE', PROFILE_FAMILY]) {
      assert.ok(source.has(sentinel), `${sentinel} missing from the source scan`);
      assert.ok(
        docs.some((row) => row.name === sentinel),
        `${sentinel} missing from the docs parse`,
      );
    }

    const names = docs.map((row) => row.name);
    assert.equal(
      names.length,
      new Set(names).size,
      `docs/CONFIGURATION.md documents a variable twice: ${names.join(', ')}`,
    );
  });

  test('every JIRA_* name in src/ has a row in docs/CONFIGURATION.md', async () => {
    const source = await scanSource();
    const documented = new Set((await parseDocs()).map((row) => row.name));

    const undocumented = [...source]
      .filter(([name]) => !documented.has(name))
      .map(([name, files]) => `${name} (read in ${files.join(', ')})`);

    assert.deepEqual(
      undocumented,
      [],
      `undocumented environment variable(s): ${undocumented.join('; ')} — add a ` +
        'row to docs/CONFIGURATION.md, or list the name in NOT_ENV_VARS with a reason',
    );
  });

  test('every variable documented in CONFIGURATION.md is still read in src/', async () => {
    const source = await scanSource();
    const dead = (await parseDocs())
      .filter((row) => !source.has(row.name))
      .map((row) => `${row.name} (docs/CONFIGURATION.md:${row.line})`);

    assert.deepEqual(
      dead,
      [],
      `documented but dead environment variable(s): ${dead.join('; ')} — the code ` +
        'stopped reading them, so the row is a promise the server no longer keeps',
    );
  });

  test('every documented default is the value the loader falls back to', async () => {
    const docs = await parseDocs();
    const settings = defaultSettings();

    const unmapped = docs
      .filter((row) => !CODE_DEFAULTS.has(row.name))
      .map((row) => `${row.name} (docs/CONFIGURATION.md:${row.line})`);
    assert.deepEqual(
      unmapped,
      [],
      `no default probe for ${unmapped.join('; ')} — add one to CODE_DEFAULTS so ` +
        'the documented default is checked against the loader',
    );

    const stale = [...CODE_DEFAULTS.keys()].filter(
      (name) => !docs.some((row) => row.name === name),
    );
    assert.deepEqual(
      stale,
      [],
      `CODE_DEFAULTS probes an undocumented variable: ${stale.join(', ')}`,
    );

    for (const row of docs) {
      const probe = CODE_DEFAULTS.get(row.name);
      if (probe === undefined) continue; // already reported above
      assert.equal(
        probe(settings),
        row.defaultValue,
        `${row.name}: docs/CONFIGURATION.md:${row.line} documents ` +
          `${row.defaultValue === undefined ? NO_DEFAULT_CELL : `\`${row.defaultValue}\``} ` +
          'but an empty environment produces ' +
          `${probe(settings) === undefined ? '(unset)' : `\`${String(probe(settings))}\``}`,
      );
    }
  });

  test('test-only variables are read by the harness, never by the server', async () => {
    const source = await scanSource();
    const testOnly = (await parseDocs()).filter(
      (row) => row.section === TEST_ONLY_SECTION,
    );
    assert.ok(testOnly.length > 0, `no rows found under "## ${TEST_ONLY_SECTION}"`);

    for (const row of testOnly) {
      const files = source.get(row.name) ?? [];
      const leaked = files.filter((file) => !file.startsWith('src/testing/'));
      assert.deepEqual(
        leaked,
        [],
        `${row.name} is documented as test-only but is read by ${leaked.join(', ')}`,
      );
    }
  });
});
