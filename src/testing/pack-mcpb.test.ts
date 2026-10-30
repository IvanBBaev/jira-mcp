// Suite for the Claude Desktop bundle (D521): the committed template
// `mcpb/manifest.json` and the pure helpers inside `scripts/pack-mcpb.mjs`.
//
// The build itself (`npm run mcpb`) is not run here: it shells out to
// `npm pack` and `npm ci`, and the second one needs the registry. CI builds the
// bundle in its own job; this suite pins everything that can go wrong without
// a network — the manifest's shape, its parity with the Claude Code plugin
// manifest, and that the zip writer produces an archive a standard reader
// accepts, byte-for-byte the same on every run.
//
// The script is reached with a dynamic `import()` of a `file:` URL, for the
// reasons `./record-fixture.test.ts` gives; the shapes below are this suite's
// reading of its exports. The build only runs when the script is the entry
// point, so importing it here does nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

interface UserConfigField {
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly required?: boolean;
  readonly sensitive?: boolean;
  readonly default?: unknown;
}

interface Manifest {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly version?: string;
  readonly server: {
    readonly type: string;
    readonly entry_point: string;
    readonly mcp_config: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };
  };
  readonly user_config: Readonly<Record<string, UserConfigField>>;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly mode: number;
}

interface PackModule {
  readonly MANIFEST_KEYS: readonly string[];
  stampManifest(template: unknown, pkg: { name: string; version: string }): Manifest;
  checkManifest(manifest: unknown, files: ReadonlySet<string>): string[];
  createZip(entries: readonly ZipEntry[]): Buffer;
  crc32(data: Buffer): number;
}

const SCRIPT_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'pack-mcpb.mjs')).href;
const pack = (await import(SCRIPT_URL)) as PackModule;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as T;
}

const template = readJson<Manifest>('mcpb/manifest.json');
const pkg = readJson<{
  name: string;
  version: string;
  license: string;
  bin: Record<string, string>;
  files: string[];
}>('package.json');
const plugin = readJson<{
  license: string;
  keywords: string[];
  repository: string;
  userConfig: Record<string, UserConfigField>;
  mcpServers: { jira: { env: Record<string, string> } };
}>('.claude-plugin/plugin.json');

const stamped = pack.stampManifest(template, pkg);
const ENTRY = new Set([stamped.server.entry_point]);

describe('mcpb/manifest.json', () => {
  test('carries no version and only MCPB 0.3 keys', () => {
    assert.equal(template.version, undefined);
    assert.equal(template.manifest_version, '0.3');
    for (const key of Object.keys(template))
      assert.ok(pack.MANIFEST_KEYS.includes(key), key);
  });

  test('identity mirrors package.json and the plugin manifest', () => {
    assert.equal(template.name, pkg.name);
    assert.equal(template.license, pkg.license);
    assert.equal(template.license, plugin.license);
    assert.deepEqual(template.keywords, plugin.keywords);
    assert.deepEqual(template.repository, { type: 'git', url: plugin.repository });
  });

  test('the stamped manifest passes the script check against the shipped launcher', () => {
    assert.equal(stamped.version, pkg.version);
    assert.deepEqual(pack.checkManifest(stamped, ENTRY), []);
    // The entry point is the npm `bin` launcher, inside the tarball's `bin/`.
    const bin = Object.values(pkg.bin)[0]?.replace(/^\.\//, '');
    assert.equal(stamped.server.entry_point, `server/${bin}`);
    assert.ok(pkg.files.includes('bin'));
    assert.equal(stamped.server.mcp_config.command, 'node');
    assert.deepEqual(stamped.server.mcp_config.args, [
      `\${__dirname}/${stamped.server.entry_point}`,
    ]);
  });

  test('prompts for the same fields as the plugin and injects the same env', () => {
    assert.deepEqual(stamped.server.mcp_config.env, plugin.mcpServers.jira.env);
    assert.deepEqual(Object.keys(stamped.user_config), Object.keys(plugin.userConfig));
    for (const [key, field] of Object.entries(plugin.userConfig)) {
      const ours = stamped.user_config[key];
      assert.ok(ours, key);
      assert.equal(ours.title, field.title, key);
      assert.equal(ours.required, field.required, key);
      assert.equal(ours.sensitive, field.sensitive, key);
      if (field.default !== undefined) assert.equal(ours.default, field.default, key);
    }
  });

  test('every optional field has a default, so no placeholder reaches the server (D84)', () => {
    for (const [key, field] of Object.entries(stamped.user_config)) {
      if (field.required !== true) assert.notEqual(field.default, undefined, key);
    }
  });

  test('never offers the irreversible gate at install time', () => {
    const env = Object.keys(stamped.server.mcp_config.env);
    assert.ok(!env.includes('JIRA_ALLOW_IRREVERSIBLE'));
    assert.ok(!env.includes('JIRA_IRREVERSIBLE_CONFIRM'));
  });
});

describe('stampManifest / checkManifest', () => {
  test('stamping refuses a template version and a foreign name', () => {
    assert.throws(
      () => pack.stampManifest({ ...template, version: '9.9.9' }, pkg),
      /version/,
    );
    assert.throws(() => pack.stampManifest(template, { ...pkg, name: 'other' }), /name/);
  });

  test('the check names each defect', () => {
    const broken = {
      ...stamped,
      extra: true,
      server: {
        ...stamped.server,
        mcp_config: {
          ...stamped.server.mcp_config,
          env: { ...stamped.server.mcp_config.env, X: '${user_config.ghost}' },
        },
      },
      user_config: {
        ...stamped.user_config,
        loose: { type: 'string', title: 'Loose', description: 'No default.' },
        odd: { type: 'color', title: 'Odd', description: 'Bad type.', default: '' },
      },
    };
    const findings = pack.checkManifest(broken, new Set());
    for (const expected of [
      'unknown top-level key "extra"',
      'is not in the bundle',
      'user_config.loose: optional without a default',
      'user_config.odd: bad type',
      'undeclared user_config.ghost',
    ]) {
      assert.ok(
        findings.some((finding) => finding.includes(expected)),
        `${expected} in ${findings.join('; ')}`,
      );
    }
  });
});

// A minimal reader over the central directory: enough to prove the archive
// is a well-formed zip without trusting the writer's own bookkeeping.
function readZip(archive: Buffer): Map<string, { data: Buffer; mode: number }> {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const out = new Map<string, { data: Buffer; mode: number }>();
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const crc = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const mode = (archive.readUInt32LE(at + 38) >>> 16) & 0o777;
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start =
      local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = inflateRawSync(archive.subarray(start, start + size));
    assert.equal(pack.crc32(data), crc, name);
    out.set(name, { data, mode });
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return out;
}

describe('createZip', () => {
  test('crc32 matches the standard check value', () => {
    assert.equal(pack.crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  const entries: ZipEntry[] = [
    {
      name: 'server/bin/run.cjs',
      data: Buffer.from('#!/usr/bin/env node\n'),
      mode: 0o755,
    },
    { name: 'manifest.json', data: Buffer.from('{"name":"x"}\n'), mode: 0o644 },
    { name: 'server/empty.txt', data: Buffer.alloc(0), mode: 0o644 },
    { name: 'server/ünïcode.md', data: Buffer.from('a'.repeat(5000)), mode: 0o644 },
  ];

  test('round-trips names, bytes and modes through a central-directory reader', () => {
    const files = readZip(pack.createZip(entries));
    assert.deepEqual([...files.keys()], [...entries.map((e) => e.name)].sort());
    for (const entry of entries) {
      const got = files.get(entry.name);
      assert.ok(got, entry.name);
      assert.deepEqual(got.data, entry.data);
      assert.equal(got.mode, entry.mode);
    }
  });

  test('is deterministic whatever the input order', () => {
    const a = pack.createZip(entries);
    const b = pack.createZip([...entries].reverse());
    assert.deepEqual(a, b);
  });
});
