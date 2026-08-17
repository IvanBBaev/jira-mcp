// ---------------------------------------------------------------------------
// The manifest snapshot — the structural contract of the whole tool surface.
//
// WHAT IT LOCKS: package order, tool order, tool names, the full annotation
// quadruple, `writeTier`, and the top-level key list of each input schema. Those
// are the things a client's stored configuration, a prompt and a permission
// policy are written against, so changing one silently is the failure this test
// exists to prevent.
//
// WHAT IT DELIBERATELY DOES NOT LOCK: titles and descriptions. They are model
// ergonomics, they get reworded often, and a snapshot that fails on every
// wording pass gets regenerated without being read — which is how a snapshot
// stops catching anything at all.
//
// REGENERATING IT (structure changed on purpose):
//
//     npm run build && UPDATE_SNAPSHOT=1 node --import ./build/testing/network-fence.js \
//       --test "build/tools/index.test.js"
//
// That rewrites `src/tools/manifest.snapshot.json` from the live manifest; the
// diff is then reviewed like any other source change. The snapshot lives next to
// this file in `src/`, and the path below resolves to the same place whether it
// is computed from the source tree or from `build/` — both are two directories
// deep.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  createFakeRedactor,
} from '../core/fakes/index.js';
import type { Rng, Settings } from '../core/types.js';
import { createRegistry, selectPackages } from '../mcp/registry.js';
import { toMcpTool } from '../mcp/server.js';
import type {
  AnyToolSpec,
  PackageSpec,
  ToolAnnotations,
  WriteTier,
} from '../mcp/types.js';
import {
  FALLBACK_SERVER_NAME,
  FALLBACK_VERSION,
  PACKAGES,
  SERVER_NAME,
  SERVER_VERSION,
  buildCapabilitiesInfo,
  createPackages,
} from './index.js';
import type { CapabilitiesInfo } from './core.js';

const SNAPSHOT_URL = new URL('../../src/tools/manifest.snapshot.json', import.meta.url);

const REGENERATE =
  'npm run build && UPDATE_SNAPSHOT=1 node --import ./build/testing/network-fence.js --test "build/tools/index.test.js"';

// ---------------------------------------------------------------------------
// The snapshot shape
// ---------------------------------------------------------------------------

interface ToolSnapshot {
  readonly name: string;
  readonly annotations: ToolAnnotations;
  readonly writeTier?: WriteTier;
  /** Top-level properties of the JSON Schema a client actually receives. */
  readonly inputKeys: readonly string[];
}

interface PackageSnapshot {
  readonly id: string;
  readonly tools: readonly ToolSnapshot[];
}

interface ManifestSnapshot {
  readonly $regenerate: string;
  readonly packages: readonly PackageSnapshot[];
}

/**
 * The input keys as the SDK renders them, not as zod holds them: what a client
 * sees is the converted JSON Schema, and that conversion is where a schema the
 * SDK cannot express would quietly lose a field. Sorted, because the order of
 * object keys in a schema carries no meaning and an alphabetical list keeps a
 * harmless reordering out of the diff.
 */
function inputKeysOf(spec: AnyToolSpec): readonly string[] {
  const schema = toMcpTool(spec).inputSchema;
  const properties: unknown = (schema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== 'object') return [];
  return Object.keys(properties).sort();
}

function toolSnapshot(spec: AnyToolSpec): ToolSnapshot {
  return {
    name: spec.name,
    annotations: spec.annotations,
    ...(spec.writeTier === undefined ? {} : { writeTier: spec.writeTier }),
    inputKeys: inputKeysOf(spec),
  };
}

function manifestSnapshot(packages: readonly PackageSpec[]): ManifestSnapshot {
  return {
    $regenerate: REGENERATE,
    packages: packages.map((pkg) => ({
      id: pkg.id,
      tools: pkg.tools.map(toolSnapshot),
    })),
  };
}

/** Prettier's JSON style: two spaces, trailing newline — `format:check` runs on it. */
function serialize(snapshot: ManifestSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SETTINGS: Settings = {
  site: 'example.atlassian.net',
  allowedHosts: [],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'plan',
  allowIrreversible: false,
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
};

function settingsOf(overrides: Partial<Settings> = {}): Settings {
  return { ...BASE_SETTINGS, ...overrides };
}

const countingRng: Rng = () => 0.5;

/** Report assembled the way `main()` assembles it, over a given configuration. */
function reportFor(settings: Settings): CapabilitiesInfo {
  return buildCapabilitiesInfo({
    settings,
    selection: selectPackages(PACKAGES, settings),
    serverName: 'jira-mcp-ai',
    version: '9.9.9',
  });
}

/** Call one tool of a manifest through the real registry, as the server would. */
async function callTool(
  packages: readonly PackageSpec[],
  name: string,
  settings: Settings = BASE_SETTINGS,
): Promise<Record<string, unknown>> {
  const jira = createFakeJiraRequest();
  const registry = createRegistry(packages, {
    settings,
    jira: jira.fn,
    logger: createFakeLogger(),
    clock: createFakeClock(1_000),
    rng: countingRng,
    redactor: createFakeRedactor([]),
  });
  const rendered = await registry.call(name, {});
  assert.equal(jira.calls.length, 0, 'jira_capabilities must not touch the network');
  return rendered.structuredContent as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('the tool manifest', () => {
  test('matches the committed structural snapshot', () => {
    const current = manifestSnapshot(PACKAGES);

    if (process.env['UPDATE_SNAPSHOT'] === '1') {
      writeFileSync(SNAPSHOT_URL, serialize(current), 'utf8');
      return;
    }

    const committed: unknown = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8'));
    assert.deepEqual(
      current,
      committed,
      `The tool surface no longer matches src/tools/manifest.snapshot.json. If the change is intentional, regenerate it with:\n  ${REGENERATE}`,
    );
  });

  test('lists the packages in TOOLS.md order, core first', () => {
    assert.deepEqual(
      PACKAGES.map((pkg) => pkg.id),
      [
        'core',
        'search',
        'issues',
        'issues-write',
        'issues-delete',
        'attachments',
        'collab',
        'meta',
        'users',
        'agile',
      ],
    );
  });

  test('declares every tool name exactly once', () => {
    const names = PACKAGES.flatMap((pkg) => pkg.tools.map((tool) => tool.name));
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.every((name) => name.startsWith('jira_')));
  });

  test('tags every tool with the package that holds it', () => {
    for (const pkg of PACKAGES) {
      for (const tool of pkg.tools) assert.equal(tool.package, pkg.id);
    }
  });

  test('gives every write tool a tier and every read tool none', () => {
    for (const pkg of PACKAGES) {
      for (const tool of pkg.tools) {
        assert.equal(
          tool.writeTier === undefined,
          tool.annotations.readOnlyHint,
          `${tool.name}: writeTier must be present iff the tool is not read-only`,
        );
      }
    }
  });
});

describe('the server identity', () => {
  test('comes from the shipped package.json', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const source = pkg as { name: string; version: string };
    assert.equal(SERVER_NAME, source.name);
    assert.equal(SERVER_VERSION, source.version);
  });

  test('CC-75: falls back rather than refusing to start when package.json is unusable', async () => {
    // A stripped container image, a half-finished install, a `files` list that
    // dropped the manifest: the version is observability, not a precondition for
    // serving, so none of those may take the server down at import time. The
    // path can only be exercised where `../../package.json` is a file this test
    // owns, so the compiled tree is copied next to one.
    const build = fileURLToPath(new URL('..', import.meta.url));
    const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));
    const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-identity-'));
    try {
      const copy = join(dir, 'build');
      await cp(build, copy, {
        recursive: true,
        // Maps and tests would point the copy back at this tree; it is imported
        // here, never measured or re-run.
        filter: (from: string): boolean =>
          !from.endsWith('.map') && !from.endsWith('.test.js') && !from.endsWith('.d.ts'),
      });
      // The nearest package scope has to stay valid or nothing loads at all —
      // and it must NOT be the manifest under test, which is one level up.
      await writeFile(join(copy, 'package.json'), '{ "type": "module" }');
      await symlink(modules, join(dir, 'node_modules'));

      const entry = pathToFileURL(join(copy, 'tools', 'index.js')).href;
      const manifest = join(dir, 'package.json');
      const identityOf = async (
        label: string,
        content?: string,
      ): Promise<readonly [string, string]> => {
        if (content === undefined) await rm(manifest, { force: true });
        else await writeFile(manifest, content);
        // A distinct query re-executes the module body; `new URL` inside it
        // resolves relative to the module path and never inherits the query.
        const loaded = (await import(`${entry}?identity=${label}`)) as {
          SERVER_NAME: string;
          SERVER_VERSION: string;
        };
        return [loaded.SERVER_NAME, loaded.SERVER_VERSION];
      };

      // The fallbacks are the real package's own name and version, so a passing
      // assertion below would prove nothing on its own. This case is the
      // control: it shows the copy really reads the manifest next to it, which
      // is what makes the four failures after it evidence.
      assert.deepEqual(
        await identityOf('control', '{ "name": "sentinel-pkg", "version": "9.9.9" }'),
        ['sentinel-pkg', '9.9.9'],
      );

      const fallback = [FALLBACK_SERVER_NAME, FALLBACK_VERSION];
      assert.deepEqual(await identityOf('missing'), fallback, 'no package.json');
      assert.deepEqual(
        await identityOf('truncated', '{ "name": "jira'),
        fallback,
        'unparseable JSON',
      );
      assert.deepEqual(
        await identityOf('scalar', '"a string, not an object"'),
        fallback,
        'valid JSON that is not an object',
      );
      assert.deepEqual(
        await identityOf('typed', '{ "name": "", "version": 7 }'),
        fallback,
        'an empty name and a numeric version',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PACKAGES (the unbound manifest)', () => {
  test('answers jira_capabilities with a config error instead of a stub report', async () => {
    const envelope = await callTool(PACKAGES, 'jira_capabilities');
    assert.equal(envelope['ok'], false);
    const error = envelope['error'] as { kind: string; message: string };
    assert.equal(error.kind, 'config');
    assert.match(error.message, /unbound PACKAGES manifest/);
  });
});

describe('createPackages', () => {
  test('binds the report source and re-reads it on every call', async () => {
    let calls = 0;
    const packages = createPackages((): CapabilitiesInfo => {
      calls += 1;
      return { ...reportFor(BASE_SETTINGS), version: `v${String(calls)}` };
    });

    const first = await callTool(packages, 'jira_capabilities');
    const second = await callTool(packages, 'jira_capabilities');

    assert.equal(first['ok'], true);
    assert.equal((first['data'] as CapabilitiesInfo).version, 'v1');
    assert.equal((second['data'] as CapabilitiesInfo).version, 'v2');
  });

  test('produces the same structure as the unbound manifest', () => {
    assert.deepEqual(
      manifestSnapshot(createPackages(reportFor(BASE_SETTINGS))),
      manifestSnapshot(PACKAGES),
    );
  });
});

describe('buildCapabilitiesInfo', () => {
  test('reports the settings a caller can act on', () => {
    const report = reportFor(
      settingsOf({ writeMode: 'apply', activeProfile: 'prod', maxPages: 7 }),
    );

    assert.equal(report.serverName, 'jira-mcp-ai');
    assert.equal(report.version, '9.9.9');
    assert.equal(report.site, 'example.atlassian.net');
    assert.equal(report.transport, 'stdio');
    assert.equal(report.writeMode, 'apply');
    assert.equal(report.activeProfile, 'prod');
    assert.equal(report.profileLocked, true);
    assert.equal(report.limits.maxPages, 7);
    assert.equal(report.limits.maxResultChars, 25_000);
    assert.equal(report.limits.requestTimeoutMs, 30_000);
    assert.equal(report.limits.callBudgetMs, 120_000);
  });

  test('describes the GATED surface, not the compiled-in one', () => {
    const report = reportFor(settingsOf({ toolPackages: ['core', 'search'] }));

    assert.deepEqual(
      report.packages.map((pkg) => pkg.id),
      ['core', 'search'],
    );
    const names = report.packages.flatMap((pkg) => pkg.tools.map((tool) => tool.name));
    assert.ok(names.includes('jira_capabilities'));
    assert.ok(!names.includes('jira_create_issue'));
  });

  test('carries per-tool name, package, readOnly and writeTier', () => {
    const report = reportFor(BASE_SETTINGS);
    const tools = report.packages.flatMap((pkg) => pkg.tools);

    const capabilities = tools.find((tool) => tool.name === 'jira_capabilities');
    assert.ok(capabilities);
    assert.equal(capabilities.package, 'core');
    assert.equal(capabilities.readOnly, true);
    assert.equal(capabilities.writeTier, undefined);

    const written = tools.filter((tool) => !tool.readOnly);
    assert.ok(written.length > 0);
    assert.ok(written.every((tool) => tool.writeTier !== undefined));
  });

  test('omits excludedTools when the configuration removed nothing', () => {
    assert.equal(reportFor(BASE_SETTINGS).excludedTools, undefined);
  });

  test('names what a deny list removed, and keeps core callable (CC-29)', () => {
    const report = reportFor(settingsOf({ packagesDeny: ['agile', 'core'] }));

    assert.ok(report.packages.some((pkg) => pkg.id === 'core'));
    assert.ok(!report.packages.some((pkg) => pkg.id === 'agile'));

    const excluded = report.excludedTools ?? [];
    assert.ok(excluded.length > 0);
    assert.ok(excluded.every((entry) => entry.reason === 'package_disabled'));
    assert.ok(!excluded.some((entry) => entry.name === 'jira_capabilities'));
  });

  test('reports a read-only package as tool-level exclusions', () => {
    const report = reportFor(settingsOf({ packagesReadonly: ['issues-write'] }));

    const excluded = report.excludedTools ?? [];
    assert.ok(excluded.length > 0);
    assert.ok(excluded.every((entry) => entry.reason === 'readonly'));

    const gated = report.packages.find((pkg) => pkg.id === 'issues-write');
    assert.ok(gated);
    assert.ok(gated.tools.every((tool) => tool.readOnly));
  });

  test('reports journaling from JIRA_JOURNAL_PATH', () => {
    assert.equal(reportFor(BASE_SETTINGS).journalEnabled, false);
    assert.equal(
      reportFor(settingsOf({ journalPath: '/tmp/jira-writes.jsonl' })).journalEnabled,
      true,
    );
  });

  test('falls back to the identity of the running server, never to a placeholder', () => {
    // `main()` passes the identity explicitly; every other caller (a test, a
    // doctor probe, a future embedding) gets the same answer the handshake
    // gives, because a report that named a different server than the handshake
    // would make a client's version check meaningless.
    const report = buildCapabilitiesInfo({
      settings: BASE_SETTINGS,
      selection: selectPackages(PACKAGES, BASE_SETTINGS),
    });

    assert.equal(report.serverName, SERVER_NAME);
    assert.equal(report.version, SERVER_VERSION);
  });

  test('omits site entirely when the server is not pointed at one', () => {
    // `jira_capabilities` is answerable before JIRA_SITE is set — it is how a
    // caller finds out the server is unconfigured. The key must be ABSENT
    // rather than `undefined`: `site` present-and-empty reads as a site.
    const report = reportFor(settingsOf({ site: undefined }));

    assert.equal(Object.hasOwn(report, 'site'), false);
    assert.equal(report.serverName, 'jira-mcp-ai');
  });

  test('contains no credential-shaped field at all', () => {
    const serialized = JSON.stringify(
      reportFor(
        settingsOf({
          email: 'someone@example.com',
          apiToken: 'super-secret-token',
          httpToken: 'http-secret',
          profiles: {
            prod: { name: 'prod', email: 'p@example.com', apiToken: 'profile-secret' },
          },
        }),
      ),
    );

    assert.ok(!serialized.includes('super-secret-token'));
    assert.ok(!serialized.includes('profile-secret'));
    assert.ok(!serialized.includes('http-secret'));
    assert.ok(!serialized.includes('someone@example.com'));
  });
});

// ---------------------------------------------------------------------------
// README drift
// ---------------------------------------------------------------------------

describe('the README tool tables', () => {
  test('are in sync with the manifest', async () => {
    // The generator's own `--check` mode is the assertion: running the real
    // command means the test cannot pass while `npm run readme` would produce a
    // different file, which a reimplementation of the rendering here could.
    const { execFile } = await import('node:child_process');
    const script = fileURLToPath(
      new URL('../../scripts/generate-readme.mjs', import.meta.url),
    );

    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [script, '--check'],
        { timeout: 30_000 },
        (_error, _stdout, stderr) => {
          resolve({ code: child.exitCode ?? 1, stderr });
        },
      );
    });

    assert.equal(
      result.code,
      0,
      `README.md no longer matches the tool manifest. Regenerate it with \`npm run readme\`.\n${result.stderr}`,
    );
  });
});
