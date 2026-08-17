// ---------------------------------------------------------------------------
// Distribution manifests ↔ docs/CONFIGURATION.md (TESTING.md suite 10).
//
// Three committed files describe this server to somebody else's installer:
// `server.json` (the MCP registry entry), `.claude-plugin/plugin.json` (the
// Claude Code plugin) and `.claude-plugin/marketplace.json` (the single-plugin
// marketplace that carries it). None of them is generated, none of them is
// imported by the code, and until this suite existed nothing checked any of
// them — which is how `server.json` came to declare 23 of the 25 user-facing
// variables, the two it dropped being `JIRA_ALLOW_IRREVERSIBLE` and
// `JIRA_MEDIA_DIR`: the delete gate and the filesystem sandbox.
//
// What is asserted here:
//   - `server.json` declares EXACTLY the user-facing variables
//     docs/CONFIGURATION.md documents — no more, no fewer — carrying the same
//     defaults and the same requiredness, with every token marked secret;
//   - the identity fields (registry name, npm identifier, version) mirror
//     package.json, because a registry listing that advertises a version nobody
//     can install is a support ticket rather than a bug report, and because
//     RELEASING.md §2 says the version fields of all four manifests move as one
//     set — this is the half of that rule a file can enforce;
//   - the plugin manifest injects only documented variables, wires every field
//     it prompts for, and never offers the irreversible-delete gate as an
//     install-time tick-box (D45).
//
// The docs side is read the way `src/env-docs-sync.test.ts` reads it: a
// `Variable` header row that names its own columns, a backticked name in the
// first cell, `—` for "no default". The two readers are deliberately alike and
// deliberately separate — one test file cannot import another without
// re-registering its suites in this file's run — so a change to the table shape
// has to be made twice. That is cheap for two readers; the moment a third one
// appears, the parser belongs in a module both import.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test, { describe } from 'node:test';

// ---------------------------------------------------------------------------
// Repo files
//
// The compiled test sits at `build/manifest-sync.test.js`, so the repo root is
// one level up — the same relative form `src/tools/index.test.ts` uses to read
// the shipped package.json.
// ---------------------------------------------------------------------------

const REPO = new URL('../', import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, REPO), 'utf8');
}

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(read(path));
  return parsed;
}

const DOC = 'docs/CONFIGURATION.md';
const REGISTRY = 'server.json';
const PLUGIN = '.claude-plugin/plugin.json';
const MARKETPLACE = '.claude-plugin/marketplace.json';

// ---------------------------------------------------------------------------
// The manifest side
// ---------------------------------------------------------------------------

/** One row of `packages[].environmentVariables` in the registry schema. */
interface ManifestEnvVar {
  readonly name: string;
  readonly description?: string;
  readonly isRequired?: boolean;
  readonly isSecret?: boolean;
  readonly default?: string;
  readonly choices?: readonly string[];
  readonly format?: string;
}

interface ManifestPackage {
  readonly registryType?: string;
  readonly identifier?: string;
  readonly version?: string;
  readonly transport?: { readonly type?: string };
  readonly environmentVariables?: readonly ManifestEnvVar[];
}

interface ServerManifest {
  readonly name?: string;
  readonly version?: string;
  readonly websiteUrl?: string;
  readonly repository?: { readonly url?: string };
  readonly packages?: readonly ManifestPackage[];
}

/** One entry of `userConfig` in the Claude Code plugin schema. */
interface PluginUserConfigField {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly sensitive?: boolean;
  readonly default?: string;
}

interface PluginMcpServer {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

interface PluginManifest {
  readonly name?: string;
  readonly version?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly userConfig?: Readonly<Record<string, PluginUserConfigField>>;
  readonly mcpServers?: Readonly<Record<string, PluginMcpServer>>;
}

interface MarketplaceManifest {
  readonly plugins?: readonly {
    readonly name?: string;
    readonly version?: string;
    readonly homepage?: string;
    readonly repository?: string;
  }[];
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly mcpName: string;
  readonly repository: { readonly url: string };
  readonly bin?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
}

const server = readJson(REGISTRY) as ServerManifest;
const plugin = readJson(PLUGIN) as PluginManifest;
const marketplace = readJson(MARKETPLACE) as MarketplaceManifest;
const npmPackage = readJson('package.json') as PackageManifest;

/** The one npm package `server.json` points the registry at. */
function registryPackage(): ManifestPackage {
  const packages = server.packages ?? [];
  assert.equal(
    packages.length,
    1,
    `${REGISTRY} is expected to describe exactly one package, found ${packages.length}`,
  );
  const first = packages[0];
  assert.ok(first !== undefined, `${REGISTRY}: packages[0] is missing`);
  return first;
}

function declaredEnvVars(): readonly ManifestEnvVar[] {
  return registryPackage().environmentVariables ?? [];
}

// ---------------------------------------------------------------------------
// The docs side
// ---------------------------------------------------------------------------

/**
 * `JIRA_PROFILE_<NAME>_SITE|EMAIL|API_TOKEN` is a family, not a variable — the
 * same collapse `src/env-docs-sync.test.ts` makes, and for the same reason:
 * neither the code nor the docs ever produce a concrete token.
 */
const PROFILE_FAMILY = 'JIRA_PROFILE_<NAME>_*';

const NO_DEFAULT_CELL = '—';

interface DocRow {
  /** Variable name, or `PROFILE_FAMILY` for the profile row. */
  readonly name: string;
  /** Documented default, or `undefined` for the `—` placeholder. */
  readonly defaultValue: string | undefined;
  /** The `Required` column, where the table has one; `false` where it has not. */
  readonly required: boolean;
  /** 1-based line number in docs/CONFIGURATION.md, for failure messages. */
  readonly line: number;
}

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
    `${DOC}:${line}: a Default cell must be \`backticked\` or the placeholder ` +
      `"${NO_DEFAULT_CELL}", found ${JSON.stringify(cell)}`,
  );
  return literal[1];
}

let docsCache: readonly DocRow[] | undefined;

function parseDocs(): readonly DocRow[] {
  if (docsCache !== undefined) return docsCache;

  const lines = read(DOC).split('\n');
  const rows: DocRow[] = [];

  // The tables do not all have the same shape — two carry a Required column —
  // so both indexes are read off the header rather than assumed.
  let defaultColumn: number | undefined;
  let requiredColumn = -1;

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const lineNumber = index + 1;

    if (!line.startsWith('|')) {
      defaultColumn = undefined;
      requiredColumn = -1;
      continue;
    }

    const cell = cells(line);
    const first = cell[0] ?? '';

    if (first === 'Variable') {
      defaultColumn = cell.indexOf('Default');
      requiredColumn = cell.indexOf('Required');
      assert.notEqual(
        defaultColumn,
        -1,
        `${DOC}:${lineNumber}: a variable table needs a Default column`,
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
      `${DOC}:${lineNumber}: one row must document one variable, found ` +
        unique.join(', '),
    );

    let required = false;
    if (requiredColumn !== -1) {
      const value = cell[requiredColumn] ?? '';
      assert.ok(
        value === 'yes' || value === 'no',
        `${DOC}:${lineNumber}: a Required cell must be "yes" or "no", found ` +
          JSON.stringify(value),
      );
      required = value === 'yes';
    }

    rows.push({
      name: unique[0] ?? '',
      defaultValue: parseDefault(cell[defaultColumn] ?? '', lineNumber),
      required,
      line: lineNumber,
    });
  }

  docsCache = rows;
  return rows;
}

// ---------------------------------------------------------------------------
// What the registry manifest deliberately leaves out
// ---------------------------------------------------------------------------

/**
 * Documented variables that deliberately carry NO row in `server.json`, each
 * with the reason it is out.
 *
 * A silent exclusion list is exactly how the next variable goes missing, so
 * every entry states its case — and the suite below asserts that each key is
 * still a row of docs/CONFIGURATION.md, so an excuse cannot outlive the
 * variable it excuses.
 */
const NOT_IN_REGISTRY: ReadonlyMap<string, string> = new Map([
  [
    'JIRA_LIVE_TEST',
    'test-only (docs/CONFIGURATION.md §"Test-only variables"): it gates the live ' +
      'read suite and is never read by the server, so declaring it to the registry ' +
      'would advertise a knob that does nothing to the people installing the package',
  ],
  [
    PROFILE_FAMILY,
    'a family, not a variable: the names are assembled at runtime from the profile ' +
      'name (JIRA_PROFILE_<NAME>_SITE|EMAIL|API_TOKEN) and the registry schema has ' +
      'no way to declare a wildcard, so the family is documented in prose instead',
  ],
]);

/** The documented rows the registry manifest is expected to carry. */
function expectedRows(): readonly DocRow[] {
  return parseDocs().filter((row) => !NOT_IN_REGISTRY.has(row.name));
}

/**
 * Variables whose value is a credential. The registry renders `isSecret` as
 * "do not echo this into a shell history or a settings file", so the rule is
 * mechanical rather than a per-row judgement: a name ending in `_TOKEN` holds
 * one. `JIRA_TOKEN_EXPIRES` is a date ABOUT a token, which is why the test is
 * on the suffix and not on the substring.
 */
function shouldBeSecret(name: string): boolean {
  return name.endsWith('_TOKEN');
}

/** The `format` vocabulary of the 2025-12-11 registry schema. */
const FORMATS = new Set(['string', 'number', 'boolean', 'filepath']);

// ---------------------------------------------------------------------------
// server.json ↔ docs/CONFIGURATION.md
// ---------------------------------------------------------------------------

describe('server.json ↔ docs/CONFIGURATION.md', () => {
  test('both sides parse to something worth comparing', () => {
    // A reader that silently matched nothing would make every comparison below
    // pass. These sentinels fail first, and say which side broke.
    const docs = parseDocs();
    const declared = declaredEnvVars();

    assert.ok(docs.length >= 20, `the docs parse found only ${docs.length} rows`);
    assert.ok(
      declared.length >= 20,
      `${REGISTRY} declares only ${declared.length} variables`,
    );
    for (const sentinel of ['JIRA_SITE', 'JIRA_WRITE_MODE']) {
      assert.ok(
        docs.some((row) => row.name === sentinel),
        `${sentinel} missing from the docs parse`,
      );
      assert.ok(
        declared.some((entry) => entry.name === sentinel),
        `${sentinel} missing from ${REGISTRY}`,
      );
    }

    const names = declared.map((entry) => entry.name);
    assert.equal(
      names.length,
      new Set(names).size,
      `${REGISTRY} declares a variable twice: ${names.join(', ')}`,
    );
  });

  test('CC-77: declares exactly the user-facing variables the docs document', () => {
    const expected = expectedRows();
    const declared = new Map(declaredEnvVars().map((entry) => [entry.name, entry]));
    const problems: string[] = [];

    for (const row of expected) {
      if (declared.has(row.name)) continue;
      problems.push(
        `${row.name}: documented at ${DOC}:${row.line}, MISSING from ${REGISTRY} — ` +
          'add a row to packages[0].environmentVariables',
      );
    }
    for (const name of declared.keys()) {
      if (expected.some((row) => row.name === name)) continue;
      const excuse = NOT_IN_REGISTRY.get(name);
      problems.push(
        excuse === undefined
          ? `${name}: declared in ${REGISTRY}, documented NOWHERE in ${DOC} — ` +
              'document it, or drop the manifest row'
          : `${name}: declared in ${REGISTRY} but deliberately excluded — ${excuse}`,
      );
    }

    assert.deepEqual(
      problems,
      [],
      `${REGISTRY} and ${DOC} disagree about the configuration surface:\n  ` +
        problems.join('\n  '),
    );
  });

  test('every registry exemption still names a documented variable', () => {
    const documented = new Set(parseDocs().map((row) => row.name));
    const stale = [...NOT_IN_REGISTRY.keys()].filter((name) => !documented.has(name));
    assert.deepEqual(
      stale,
      [],
      `NOT_IN_REGISTRY excuses ${stale.join(', ')}, which ${DOC} no longer ` +
        'documents — delete the entry',
    );
  });

  test('carries the default the docs document, for every variable', () => {
    const declared = new Map(declaredEnvVars().map((entry) => [entry.name, entry]));
    const show = (value: string | undefined): string =>
      value === undefined ? '(no default)' : `\`${value}\``;

    // A variable the manifest does not declare at all is the previous test's
    // failure, not this one's: one fact, one red test.
    const drift = expectedRows()
      .map((row) => ({ row, entry: declared.get(row.name) }))
      .filter(
        ({ row, entry }) => entry !== undefined && entry.default !== row.defaultValue,
      )
      .map(
        ({ row, entry }) =>
          `${row.name}: ${DOC}:${row.line} documents ${show(row.defaultValue)} but ` +
          `${REGISTRY} declares ${show(entry?.default)}`,
      );

    assert.deepEqual(drift, [], `documented defaults drifted:\n  ${drift.join('\n  ')}`);
  });

  test('marks required exactly the variables the docs mark required', () => {
    const declared = new Map(declaredEnvVars().map((entry) => [entry.name, entry]));

    const wrong = expectedRows()
      .filter((row) => {
        const entry = declared.get(row.name);
        return entry !== undefined && (entry.isRequired ?? false) !== row.required;
      })
      .map(
        (row) =>
          `${row.name}: ${DOC}:${row.line} says required=${String(row.required)}, ` +
          `${REGISTRY} says isRequired=${String(
            declared.get(row.name)?.isRequired ?? false,
          )}`,
      );

    assert.deepEqual(wrong, [], `requiredness drifted:\n  ${wrong.join('\n  ')}`);
  });

  test('marks every credential-bearing variable secret, and nothing else', () => {
    const wrong = declaredEnvVars()
      .filter((entry) => (entry.isSecret ?? false) !== shouldBeSecret(entry.name))
      .map((entry) =>
        shouldBeSecret(entry.name)
          ? `${entry.name} holds a credential but ${REGISTRY} does not mark it isSecret`
          : `${entry.name} is marked isSecret but holds no credential`,
      );

    assert.deepEqual(wrong, [], `secret flags are wrong:\n  ${wrong.join('\n  ')}`);
  });

  test('gives every declared variable a usable shape', () => {
    const problems: string[] = [];

    for (const entry of declaredEnvVars()) {
      const description = entry.description ?? '';
      if (description.trim() === '') {
        problems.push(`${entry.name}: no description — the registry renders it verbatim`);
      }
      if (!FORMATS.has(entry.format ?? '')) {
        problems.push(
          `${entry.name}: format ${JSON.stringify(entry.format)} is not one of ` +
            [...FORMATS].join(', '),
        );
      }
      if (
        entry.choices !== undefined &&
        entry.default !== undefined &&
        !entry.choices.includes(entry.default)
      ) {
        problems.push(
          `${entry.name}: default ${JSON.stringify(entry.default)} is not among its ` +
            `choices ${entry.choices.join(', ')}`,
        );
      }
    }

    assert.deepEqual(
      problems,
      [],
      `${REGISTRY} rows are malformed:\n  ` + problems.join('\n  '),
    );
  });
});

// ---------------------------------------------------------------------------
// Identity: the same package, under the same version, in every manifest
// ---------------------------------------------------------------------------

describe('manifest identity', () => {
  test('server.json names the package package.json publishes', () => {
    assert.equal(
      server.name,
      npmPackage.mcpName,
      `${REGISTRY} name must equal package.json mcpName`,
    );
    assert.equal(
      registryPackage().identifier,
      npmPackage.name,
      `${REGISTRY} packages[0].identifier must equal package.json name`,
    );
    assert.equal(registryPackage().registryType, 'npm');
  });

  test('every manifest version is package.json version (RELEASING.md §2)', () => {
    // The version fields move as one set on publish day. A registry listing that
    // advertises a version npm does not serve is the failure this catches.
    const expected = npmPackage.version;
    const found: Record<string, string | undefined> = {
      [`${REGISTRY} version`]: server.version,
      [`${REGISTRY} packages[0].version`]: registryPackage().version,
      [`${PLUGIN} version`]: plugin.version,
      [`${MARKETPLACE} plugins[0].version`]: marketplace.plugins?.[0]?.version,
    };

    const drift = Object.entries(found)
      .filter(([, value]) => value !== expected)
      .map(
        ([where, value]) => `${where} is ${String(value)}, package.json is ${expected}`,
      );

    assert.deepEqual(drift, [], `manifest versions drifted:\n  ${drift.join('\n  ')}`);
  });

  test('registers the transport the docs make the default', () => {
    const documented = parseDocs().find((row) => row.name === 'JIRA_TRANSPORT');
    assert.equal(registryPackage().transport?.type, documented?.defaultValue);
  });

  test('points every manifest at one repository', () => {
    // `https://github.com/<owner>/<repo>` — the trailing `.git`, `#readme` and
    // any query are not part of the identity.
    const slug = (url: string): string =>
      /github\.com\/([^/]+)\/([^/#?.]+)/.exec(url)?.slice(1, 3).join('/') ?? url;

    const expected = slug(npmPackage.repository.url);
    const urls: Record<string, string | undefined> = {
      [`${REGISTRY} repository.url`]: server.repository?.url,
      [`${REGISTRY} websiteUrl`]: server.websiteUrl,
      [`${PLUGIN} repository`]: plugin.repository,
      [`${PLUGIN} homepage`]: plugin.homepage,
      [`${MARKETPLACE} plugins[0].repository`]: marketplace.plugins?.[0]?.repository,
      [`${MARKETPLACE} plugins[0].homepage`]: marketplace.plugins?.[0]?.homepage,
    };

    const wrong = Object.entries(urls)
      .filter(([, url]) => url === undefined || slug(url) !== expected)
      .map(([where, url]) => `${where} is ${String(url)}, expected ${expected}`);

    assert.deepEqual(
      wrong,
      [],
      `manifests disagree on the repository:\n  ${wrong.join('\n  ')}`,
    );
  });

  test('names the same plugin in both plugin manifests', () => {
    assert.equal(plugin.name, npmPackage.name);
    assert.equal(marketplace.plugins?.[0]?.name, plugin.name);
  });
});

// ---------------------------------------------------------------------------
// The Claude Code plugin manifest
// ---------------------------------------------------------------------------

describe('.claude-plugin/plugin.json', () => {
  const servers = plugin.mcpServers ?? {};
  const env = Object.values(servers)[0]?.env ?? {};
  const userConfig = plugin.userConfig ?? {};

  test('injects only variables docs/CONFIGURATION.md documents', () => {
    const documented = new Set(parseDocs().map((row) => row.name));
    const unknownNames = Object.keys(env).filter((name) => !documented.has(name));
    assert.deepEqual(
      unknownNames,
      [],
      `${PLUGIN} sets ${unknownNames.join(', ')}, which ${DOC} does not document`,
    );
    assert.ok(Object.keys(env).length > 0, `${PLUGIN} injects no environment at all`);
  });

  test('resolves every ${user_config.…} reference, and wires every field it prompts for', () => {
    const referenced = new Set<string>();
    for (const value of Object.values(env)) {
      const match = /^\$\{user_config\.([\w]+)\}$/.exec(value);
      if (match?.[1] !== undefined) referenced.add(match[1]);
    }

    const declared = new Set(Object.keys(userConfig));
    const dangling = [...referenced].filter((field) => !declared.has(field));
    const unused = [...declared].filter((field) => !referenced.has(field));

    assert.deepEqual(
      dangling,
      [],
      `${PLUGIN} interpolates ${dangling.join(', ')}, which userConfig does not declare`,
    );
    assert.deepEqual(
      unused,
      [],
      `${PLUGIN} prompts for ${unused.join(', ')} and then never uses the answer`,
    );
  });

  test('prompts for the three credentials and nothing else as required', () => {
    const required = Object.entries(userConfig)
      .filter(([, field]) => field.required === true)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(required, ['jira_api_token', 'jira_email', 'jira_site']);
  });

  test('never offers the irreversible-delete gate as an install-time tick-box', () => {
    // D45: JIRA_ALLOW_IRREVERSIBLE is the second lock on the delete tier, on top
    // of JIRA_WRITE_MODE. A lock a user clicks past while installing is not a
    // lock — it belongs in the env file, set deliberately, after reading what it
    // does. `server.json` documents it (the registry is a catalogue, not a
    // prompt); this manifest must not carry it in any form.
    assert.ok(
      !read(PLUGIN).includes('JIRA_ALLOW_IRREVERSIBLE'),
      `${PLUGIN} must not expose JIRA_ALLOW_IRREVERSIBLE — see D45`,
    );
    assert.ok(!Object.keys(userConfig).includes('jira_allow_irreversible'));
  });

  test('CC-90: spells every field the way Claude Code documents it', () => {
    // The reference (code.claude.com/docs/en/plugins-reference) is explicit that
    // Claude Code IGNORES top-level fields it does not recognize, so a misspelt
    // key is not a load error — it is a field that silently does nothing, and
    // the closest such trap is the MCPB/DXT bundle manifest, whose equivalent of
    // `userConfig` is spelled `user_config`. That manifest is a plausible thing
    // to copy from, `claude plugin validate` only warns, and the failure mode is
    // an install that prompts for nothing and starts a server with an empty
    // environment. This suite is the strict check the runtime declines to make.
    const TOP_LEVEL = new Set([
      // Required, then the metadata fields, then the component fields.
      'name',
      '$schema',
      'displayName',
      'version',
      'description',
      'author',
      'homepage',
      'repository',
      'license',
      'keywords',
      'metadata',
      'defaultEnabled',
      'skills',
      'commands',
      'agents',
      'workflows',
      'hooks',
      'mcpServers',
      'outputStyles',
      'lspServers',
      'experimental',
      'userConfig',
      'channels',
      'dependencies',
    ]);
    const unknownTop = Object.keys(plugin as Record<string, unknown>).filter(
      (key) => !TOP_LEVEL.has(key),
    );
    assert.deepEqual(
      unknownTop,
      [],
      `${PLUGIN} carries ${unknownTop.join(', ')}, which the plugin manifest ` +
        `schema does not define — Claude Code would ignore it`,
    );

    const FIELD_KEYS = new Set([
      'type',
      'title',
      'description',
      'sensitive',
      'required',
      'default',
      'multiple',
      'min',
      'max',
    ]);
    const TYPES = new Set(['string', 'number', 'boolean', 'directory', 'file']);
    const problems: string[] = [];
    for (const [key, field] of Object.entries(userConfig)) {
      const where = `${PLUGIN} userConfig.${key}`;
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
        problems.push(`${where}: keys must be valid identifiers`);
      }
      for (const sub of Object.keys(field)) {
        if (!FIELD_KEYS.has(sub)) problems.push(`${where}.${sub} is not a schema field`);
      }
      // `type`, `title` and `description` are the three the schema marks
      // required — the dialog has no label and no help text without them.
      for (const sub of ['type', 'title', 'description'] as const) {
        if (typeof field[sub] !== 'string' || field[sub] === '') {
          problems.push(`${where}.${sub} is required and must be a non-empty string`);
        }
      }
      if (field.type !== undefined && !TYPES.has(field.type)) {
        problems.push(
          `${where}.type is ${field.type}, not one of ${[...TYPES].join('|')}`,
        );
      }
    }
    assert.deepEqual(problems, [], `${PLUGIN} userConfig:\n  ${problems.join('\n  ')}`);
  });

  test('CC-90: interpolates only inside the MCP server config, and only declared keys', () => {
    // `${user_config.KEY}` resolves in MCP `command`, `args` and `env`. It is
    // REJECTED — the component fails rather than substituting — in shell-form
    // hook commands, monitor commands and MCP `headersHelper`, because those run
    // through a shell. This manifest ships one stdio server and nothing else, so
    // the rule reduces to: every placeholder in the file lives under
    // `mcpServers`, and every one of them names a key userConfig declares.
    const declared = new Set(Object.keys(userConfig));
    const placeholders = (blob: string): string[] =>
      [...blob.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? '');

    const outside = { ...(plugin as Record<string, unknown>) };
    delete outside['mcpServers'];
    assert.deepEqual(
      placeholders(JSON.stringify(outside)),
      [],
      `${PLUGIN} interpolates outside mcpServers, where substitution does not run`,
    );

    const unresolved = placeholders(JSON.stringify(servers)).filter((token) => {
      const key = /^user_config\.([\w]+)$/.exec(token)?.[1];
      return key === undefined || !declared.has(key);
    });
    assert.deepEqual(
      unresolved,
      [],
      `${PLUGIN} interpolates ${unresolved.join(', ')}, which resolves to nothing`,
    );
  });

  test('offers the docs default as the pre-filled answer, and no other', () => {
    // The prompt is the only place most plugin users ever see these values, so a
    // pre-filled answer that disagrees with docs/CONFIGURATION.md ships a second,
    // contradictory default. A documented `—` means the server's own fallback
    // applies, and pre-filling anything there would override it at install time.
    const byDefault = new Map(parseDocs().map((row) => [row.name, row.defaultValue]));
    const problems: string[] = [];
    for (const [envName, value] of Object.entries(env)) {
      const key = /^\$\{user_config\.([\w]+)\}$/.exec(value)?.[1];
      if (key === undefined) continue;
      const field = userConfig[key];
      if (field === undefined) continue;
      const documented = byDefault.get(envName);
      if (documented === undefined) {
        if (field.default !== undefined) {
          problems.push(
            `${key}.default is ${JSON.stringify(field.default)}, but ${DOC} ` +
              `documents no default for ${envName}`,
          );
        }
        continue;
      }
      if (field.default !== documented) {
        problems.push(
          `${key}.default is ${JSON.stringify(field.default)}, ${DOC} says ` +
            `${JSON.stringify(documented)} for ${envName}`,
        );
      }
    }
    assert.deepEqual(problems, [], `${PLUGIN} defaults:\n  ${problems.join('\n  ')}`);
  });

  test('masks exactly the credential-bearing prompts', () => {
    // `sensitive` is what routes the answer to the keychain instead of
    // settings.json, so the same rule that drives `isSecret` in `server.json`
    // has to hold here: an API token typed into an unmasked field is a token in
    // a plaintext settings file and on the screen behind the installer.
    const masked: string[] = [];
    const wanted: string[] = [];
    for (const [envName, value] of Object.entries(env)) {
      const key = /^\$\{user_config\.([\w]+)\}$/.exec(value)?.[1];
      if (key === undefined) continue;
      if (userConfig[key]?.sensitive === true) masked.push(key);
      if (shouldBeSecret(envName)) wanted.push(key);
    }
    assert.deepEqual(
      masked.sort(),
      wanted.sort(),
      `${PLUGIN} masks ${masked.join(', ') || '(nothing)'}; the credential-bearing ` +
        `prompts are ${wanted.join(', ') || '(none)'}`,
    );
  });

  test('launches the package this repo publishes, non-interactively', () => {
    // `npx` prompts before installing a package it has not seen — and an MCP
    // client gives the child no TTY to answer on, so the server would hang at
    // startup with no output at all. `-y` is what makes the first launch work.
    const entry = Object.values(servers)[0];
    assert.equal(entry?.command, 'npx', `${PLUGIN} must launch the published binary`);
    const args = entry?.args ?? [];
    assert.ok(
      args.includes('-y'),
      `${PLUGIN} args must carry -y: found ${args.join(' ')}`,
    );
    const spec = args.find((arg) => arg.startsWith(npmPackage.name));
    assert.ok(
      spec !== undefined,
      `${PLUGIN} args must name ${npmPackage.name}: found ${args.join(' ')}`,
    );
    assert.match(
      spec,
      new RegExp(`^${npmPackage.name}@\\d+\\.\\d+\\.\\d+$`),
      `${PLUGIN} must pin an exact version of ${npmPackage.name}`,
    );
  });
});

// ---------------------------------------------------------------------------
// The bin entry
//
// `npx jira-mcp-ai` and every manifest above reach the server through one file:
// `bin/jira-mcp-ai.cjs`. It is the only part of the package npm makes executable
// and the only part a Node too old to parse the server can still run, which is
// the whole reason it exists. Nothing else in the suite looks at it.
// ---------------------------------------------------------------------------

describe('bin/jira-mcp-ai.cjs', () => {
  const BIN = 'bin/jira-mcp-ai.cjs';
  const source = read(BIN);

  // The shim's own comments quote the constructs the tests below forbid, and its
  // diagnostics quote shell commands in backticks, so the scans run over the
  // code with whole-line `//` comments and single-quoted strings removed. That
  // is sound only while the file holds no string containing `//` and uses no
  // double quotes — both of which the syntax test asserts before scanning.
  const code = source
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");

  test('is the binary package.json publishes, under the package name', () => {
    // `npx <name>` runs the bin whose KEY is `<name>`; a bin named anything else
    // makes `npx jira-mcp-ai` install the package and then run nothing.
    assert.deepEqual(npmPackage.bin, { [npmPackage.name]: `./${BIN}` });
    assert.ok(
      (npmPackage.files ?? []).includes('bin'),
      'package.json files must ship bin/ — the tarball has no entry point without it',
    );
  });

  test('starts with the shebang, and is executable', () => {
    assert.equal(
      source.split('\n')[0],
      '#!/usr/bin/env node',
      `${BIN} needs the env shebang: npm copies the mode, not an interpreter`,
    );
    const mode = statSync(new URL(BIN, REPO)).mode;
    assert.ok(
      (mode & 0o100) !== 0,
      `${BIN} is not owner-executable (mode ${(mode & 0o777).toString(8)})`,
    );
  });

  test('CC-89: reports a failed start with process.exitCode, never process.exit', () => {
    // Every failure path here is one line of stderr explaining why the server
    // did not start, and under an MCP client stderr is a pipe. `process.exit()`
    // tears the process down with that write still in the pipe buffer, which
    // truncates the message at 64 KiB — measured, and reached easily by the
    // `.catch()` path, which prints a module-resolution stack. `src/index.ts`
    // holds the same rule for the same reason; the shim is where it was missing.
    assert.ok(
      !code.includes('process.exit('),
      `${BIN} must set process.exitCode instead of calling process.exit()`,
    );
    assert.ok(
      code.includes('process.exitCode = 1'),
      `${BIN} must still fail with a non-zero exit code`,
    );
  });

  test('stays parseable by the old runtimes its version guard exists to warn', () => {
    // The guard prints "requires Node.js >= 22" — it can only do that on a
    // runtime that parsed the file. One arrow function anywhere in the shim and
    // the user gets a SyntaxError instead of the sentence telling them why.
    // `import(` is the deliberate exception: parseable since Node 12, long
    // before any runtime this guard is aimed at.
    assert.ok(
      !code.includes('//') && !code.includes('"'),
      `${BIN} holds "//" or a double-quoted string outside a comment; the scan ` +
        'below strips only whole-line comments and single-quoted strings',
    );
    const banned: readonly (readonly [RegExp, string])[] = [
      [/=>/, 'arrow function'],
      [/\?\?/, 'nullish coalescing'],
      [/\?\./, 'optional chaining'],
      [/`/, 'template literal'],
      [/(?:^|[^\w$.])(?:const|let|class)\s/m, 'ES6 declaration'],
      [/(?:^|[^\w$.])(?:import|export)\s/m, 'ESM statement'],
    ];
    const found = banned
      .filter(([pattern]) => pattern.test(code))
      .map(([, label]) => label);
    assert.deepEqual(found, [], `${BIN} uses post-ES5 syntax: ${found.join(', ')}`);
  });
});
