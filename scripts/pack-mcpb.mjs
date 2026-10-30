#!/usr/bin/env node
/**
 * pack-mcpb — build the Claude Desktop bundle (`.mcpb`) from the npm tarball.
 *
 * A Desktop user who installs through JSON config has to have a Node >= 22 on
 * the PATH Desktop sees, which is the most common first-run failure. An MCPB
 * bundle carries the server and its production dependencies, and Desktop runs
 * it on its own Node runtime, so that failure cannot happen (D521).
 *
 * The bundle is built from the SAME tarball `npm publish` ships, never from the
 * working tree: what Desktop runs is byte-for-byte what npm serves, plus
 * `node_modules` installed from the committed lockfile and the manifest.
 *
 *   1. `--tarball <path>` names the tarball; without it the script runs
 *      `npm pack` in the repo (which reads `build/` off disk — build first,
 *      ideally with `npm run build:publish`, so no source maps ship).
 *   2. The tarball is extracted to a temporary directory as `server/`.
 *   3. `npm ci --omit=dev --ignore-scripts` installs the production
 *      dependencies there from the repo's `package-lock.json`.
 *   4. `mcpb/manifest.json` is stamped with the tarball's version (the template
 *      carries none, so a release bumps no fifth manifest) and checked.
 *   5. A deterministic zip is written to `<out>/<name>-<version>.mcpb`
 *      (sorted entries, fixed timestamps), with its sha256 beside it in
 *      `sha256sum` format.
 *
 * Usage: node scripts/pack-mcpb.mjs [--tarball <file.tgz>] [--out <dir>]
 * Default `--out` is `mcpb/dist` (git-ignored). Exit 1 on any failure.
 *
 * The pure helpers (`stampManifest`, `checkManifest`, `createZip`, `crc32`) are
 * exported for `src/mcpb-manifest.test.ts`; the build only runs when this file
 * is the entry point.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(REPO_ROOT, 'mcpb', 'manifest.json');
const DEFAULT_OUT = join(REPO_ROOT, 'mcpb', 'dist');

/** Top-level keys of the MCPB manifest schema, version 0.3. */
export const MANIFEST_KEYS = Object.freeze([
  '$schema',
  'manifest_version',
  'name',
  'display_name',
  'version',
  'description',
  'long_description',
  'author',
  'repository',
  'homepage',
  'documentation',
  'support',
  'icon',
  'icons',
  'screenshots',
  'localization',
  'server',
  'tools',
  'tools_generated',
  'prompts',
  'prompts_generated',
  'keywords',
  'license',
  'privacy_policies',
  'compatibility',
  'user_config',
  '_meta',
]);

const USER_CONFIG_TYPES = new Set(['string', 'number', 'boolean', 'directory', 'file']);

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * The template with the tarball's version. The template must not carry one:
 * a second source of the version is a second thing a release has to bump.
 */
export function stampManifest(template, pkg) {
  if ('version' in template) {
    throw new Error(
      'mcpb/manifest.json must not carry a version; it is stamped from the tarball',
    );
  }
  if (template.name !== pkg.name) {
    throw new Error(
      `manifest name "${template.name}" is not the package name "${pkg.name}"`,
    );
  }
  const { manifest_version: manifestVersion, name, ...rest } = template;
  return { manifest_version: manifestVersion, name, version: pkg.version, ...rest };
}

/**
 * Findings for a stamped manifest, one string each; empty when it is sound.
 * `files` is the set of archive paths, so the entry point is proven to exist.
 *
 * The one rule that is ours rather than the schema's: every optional
 * `user_config` field needs a default. Desktop leaves `${user_config.x}`
 * unexpanded when the user gave no value and the manifest no default, and the
 * server would then receive the literal placeholder (D84).
 */
export function checkManifest(manifest, files) {
  const findings = [];
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) findings.push(`unknown top-level key "${key}"`);
  }
  if (manifest.manifest_version !== '0.3') findings.push('manifest_version is not "0.3"');
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    findings.push('version is missing');
  }
  const server = manifest.server ?? {};
  if (server.type !== 'node') findings.push('server.type is not "node"');
  if (!files.has(server.entry_point)) {
    findings.push(`entry point "${server.entry_point}" is not in the bundle`);
  }
  const args = server.mcp_config?.args ?? [];
  if (!args.includes(`\${__dirname}/${server.entry_point}`)) {
    findings.push('mcp_config.args does not start the entry point');
  }
  const config = manifest.user_config ?? {};
  for (const [key, field] of Object.entries(config)) {
    if (!USER_CONFIG_TYPES.has(field.type)) findings.push(`user_config.${key}: bad type`);
    if (!field.title || !field.description) {
      findings.push(`user_config.${key}: title and description are required`);
    }
    if (field.required !== true && field.default === undefined) {
      findings.push(`user_config.${key}: optional without a default`);
    }
  }
  const placeholders = JSON.stringify(server.mcp_config ?? {}).matchAll(
    /\$\{user_config\.([^}]+)\}/g,
  );
  for (const [, key] of placeholders) {
    if (!(key in config))
      findings.push(`mcp_config references undeclared user_config.${key}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), as the zip format stores it. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00:00 in MS-DOS date/time: the zip epoch, so builds repeat. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * A zip archive of `entries` (`{ name, data, mode }`), sorted by name, every
 * entry deflated, timestamps fixed and Unix modes recorded — the same input
 * always yields the same bytes. No zip64: more than 65 535 entries or 4 GiB is
 * refused rather than written wrong.
 */
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  if (sorted.length > 0xffff) throw new Error(`${sorted.length} entries need zip64`);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode } of sorted) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(((0o100000 | (mode & 0o777)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
    if (offset > 0xffffffff)
      throw new Error('archive exceeds 4 GiB; zip64 is not supported');
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
}

/**
 * Every regular file under `root` as an archive entry under `prefix`. The
 * `node_modules/.bin` shims are skipped (nothing runs them, and they are
 * symlinks); any other symlink fails the build, because a zip entry cannot
 * carry one portably.
 */
function collect(root, prefix) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join('/');
      if (rel === 'node_modules/.bin') continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`symlink in the bundle: ${rel}`);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) {
        entries.push({
          name: `${prefix}${rel}`,
          data: readFileSync(path),
          mode: info.mode & 0o111 ? 0o755 : 0o644,
        });
      }
    }
  };
  walk(root);
  return entries;
}

function parseArgs(argv) {
  const options = { tarball: undefined, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--tarball' || flag === '--out') && value !== undefined) {
      options[flag.slice(2)] = resolve(value);
      i++;
    } else {
      throw new Error(
        `usage: pack-mcpb.mjs [--tarball <file.tgz>] [--out <dir>] (got "${flag}")`,
      );
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const staging = mkdtempSync(join(tmpdir(), 'jira-mcpb-'));
  try {
    let tarball = options.tarball;
    if (tarball === undefined) {
      const packed = JSON.parse(
        run('npm', ['pack', '--json', '--pack-destination', staging], REPO_ROOT),
      );
      tarball = join(staging, packed[0].filename);
    }
    run('tar', ['-xzf', tarball, '-C', staging]);
    const serverDir = join(staging, 'package');
    const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));

    copyFileSync(
      join(REPO_ROOT, 'package-lock.json'),
      join(serverDir, 'package-lock.json'),
    );
    run(
      'npm',
      [
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      serverDir,
    );

    const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    const manifest = stampManifest(template, pkg);
    const entries = collect(serverDir, 'server/');
    const findings = checkManifest(manifest, new Set(entries.map((entry) => entry.name)));
    if (findings.length > 0) {
      throw new Error(`manifest check failed:\n  ${findings.join('\n  ')}`);
    }
    entries.push({
      name: 'manifest.json',
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      mode: 0o644,
    });

    const archive = createZip(entries);
    const file = `${pkg.name}-${pkg.version}.mcpb`;
    const digest = createHash('sha256').update(archive).digest('hex');
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, file), archive);
    writeFileSync(join(options.out, `${file}.sha256`), `${digest}  ${file}\n`);
    console.log(`${join(options.out, file)}`);
    console.log(`  tarball ${basename(tarball)}`);
    console.log(`  ${entries.length} entries, ${archive.length} bytes`);
    console.log(`  sha256 ${digest}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`pack-mcpb: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
