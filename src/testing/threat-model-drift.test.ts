// Drift test for docs/THREAT-MODEL.md (SEC-R3, DOC-R3; CC-5140…CC-5144).
//
// THREAT-MODEL is the document a security reviewer quotes, and the 2026-10-29
// review found it wrong in exactly the places a hand-kept list goes stale: the
// irreversible tier (8 named, 11 shipped) and the disk sinks (2 named, 4
// shipped). Every list of tools in it now sits between
// `<!-- tools:KEY -->` and `<!-- /tools -->`, and this suite recomputes each
// list from the code:
//
// - the write tiers from `src/tools/manifest.snapshot.json` (the surface the
//   manifest test already pins);
// - the disk-writing tools from the live tool definitions: a `fileOutput`
//   spec is an export, and a read-only tool whose description names
//   `JIRA_MEDIA_DIR` or `JIRA_REPORT_DIR` writes there;
// - the file-creating call sites under `src/`, each of which must map to a
//   row of the sink table or to a file that never holds tenant content.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../core/fakes/fixtures.js';
import { PACKAGES } from '../tools/index.js';

interface SnapshotTool {
  readonly name: string;
  readonly writeTier?: 'standard' | 'irreversible';
}

interface Snapshot {
  readonly packages: readonly { readonly tools: readonly SnapshotTool[] }[];
}

const DOC_PATH = join(REPO_ROOT, 'docs', 'THREAT-MODEL.md');
const DOC = readFileSync(DOC_PATH, 'utf8');
const SNAPSHOT = JSON.parse(
  readFileSync(join(REPO_ROOT, 'src', 'tools', 'manifest.snapshot.json'), 'utf8'),
) as Snapshot;
const SNAPSHOT_TOOLS = SNAPSHOT.packages.flatMap((pkg) => pkg.tools);

const TOOL_NAME_RE = /`(jira_[a-z0-9_]+)`/g;

/** The tool names between `<!-- tools:KEY -->` and `<!-- /tools -->`. */
function markedList(key: string): string[] {
  const re = new RegExp(`<!-- tools:${key} -->([\\s\\S]*?)<!-- /tools -->`, 'g');
  const blocks = [...DOC.matchAll(re)];
  assert.equal(blocks.length, 1, `THREAT-MODEL.md needs exactly one tools:${key} list`);
  return [...(blocks[0]?.[1] ?? '').matchAll(TOOL_NAME_RE)].map((m) => m[1] ?? '');
}

/** Order-free comparison with a message naming what is missing and extra. */
function assertSameSet(
  documented: readonly string[],
  actual: readonly string[],
  what: string,
): void {
  assert.equal(
    new Set(documented).size,
    documented.length,
    `${what}: THREAT-MODEL.md names a tool twice`,
  );
  const doc = new Set(documented);
  const code = new Set(actual);
  const missing = [...code].filter((name) => !doc.has(name)).sort();
  const extra = [...doc].filter((name) => !code.has(name)).sort();
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${what}: THREAT-MODEL.md disagrees with the code`,
  );
}

const tierOf = (tier: 'standard' | 'irreversible'): string[] =>
  SNAPSHOT_TOOLS.filter((tool) => tool.writeTier === tier).map((tool) => tool.name);

const SPECS = PACKAGES.flatMap((pkg) => pkg.tools);

/** Which sink a tool writes into, read off its definition. */
function sinkOf(
  spec: (typeof SPECS)[number],
): 'exports' | 'media' | 'reports' | undefined {
  if (spec.fileOutput !== undefined) return 'exports';
  if (!spec.annotations.readOnlyHint) return undefined;
  if (spec.description.includes('JIRA_REPORT_DIR')) return 'reports';
  if (spec.description.includes('JIRA_MEDIA_DIR')) return 'media';
  return undefined;
}

/**
 * Every source file that creates or appends to a file, and what it writes.
 * A sink name must be a row of the THREAT-MODEL table; `credentials` and
 * `operator` files never hold tenant content (THREAT-MODEL §Data handling).
 * A new call site in a file missing here fails CC-5143 until it is placed.
 */
const CALL_SITES: Readonly<Record<string, string>> = {
  'src/core/journal.ts': 'journal',
  'src/tools/attachments.ts': 'media', // the media store, shared with exports
  'src/tools/portfolio.ts': 'reports',
  'src/core/oauth.ts': 'credentials', // the oauth token store
  'src/core/env-lock.ts': 'credentials', // env file and lock owner records
  'src/cli/doctor.ts': 'operator', // `doctor --save`
};
const NON_TENANT = new Set(['credentials', 'operator']);

const FILE_CREATE_RE =
  /\b(?:open|openSync)\([^)]*'[wa]x?\+?'|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeFileAtomic)\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'testing' || entry.name === 'fakes' ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function sinkRows(): string[] {
  const table = /<!-- sinks -->([\s\S]*?)<!-- \/sinks -->/.exec(DOC)?.[1];
  assert.ok(table, 'THREAT-MODEL.md needs a <!-- sinks --> table');
  return table
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Sink'))
    .map((line) => line.split('|')[1]?.trim() ?? '');
}

describe('THREAT-MODEL.md drift (manifest-bound)', () => {
  test('CC-5140: the irreversible list is the manifest irreversible tier', () => {
    assertSameSet(
      markedList('irreversible'),
      tierOf('irreversible'),
      'irreversible tier',
    );
  });

  test('CC-5141: the standard list is the manifest standard tier', () => {
    assertSameSet(markedList('standard'), tierOf('standard'), 'standard tier');
  });

  test('CC-5142: each sink row names exactly the tools that write into it', () => {
    assert.deepEqual(
      SPECS.map((spec) => spec.name).sort(),
      SNAPSHOT_TOOLS.map((tool) => tool.name).sort(),
      'the live definitions and the manifest snapshot list different tools',
    );
    for (const sink of ['media', 'exports', 'reports'] as const) {
      const writers = SPECS.filter((spec) => sinkOf(spec) === sink).map(
        (spec) => spec.name,
      );
      assert.ok(writers.length > 0, `no tool writes into ${sink} — the derivation broke`);
      assertSameSet(markedList(sink), writers, `${sink} sink`);
    }
  });

  test('CC-5143: every file-creating call site maps to a sink row or a non-tenant file', () => {
    const rows = new Set(sinkRows());
    assert.deepEqual(
      [...rows].sort(),
      ['exports', 'journal', 'media', 'reports'],
      'the sink table rows changed',
    );
    const found = new Set<string>();
    for (const file of sourceFiles(join(REPO_ROOT, 'src'))) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line));
      if (!code.some((line) => FILE_CREATE_RE.test(line))) continue;
      found.add(rel);
      const sink = CALL_SITES[rel];
      assert.ok(
        sink !== undefined,
        `${rel} creates a file: add a THREAT-MODEL sink row (or say why it holds no ` +
          'tenant data) and map it in CALL_SITES',
      );
      assert.ok(
        rows.has(sink) || NON_TENANT.has(sink),
        `${rel} maps to unknown sink ${sink}`,
      );
    }
    assert.deepEqual(
      [...found].sort(),
      Object.keys(CALL_SITES).sort(),
      'CALL_SITES names a file that no longer creates one',
    );
  });

  test('CC-5144: every tool THREAT-MODEL.md names is on the manifest', () => {
    const known = new Set(SNAPSHOT_TOOLS.map((tool) => tool.name));
    const stale = [...new Set([...DOC.matchAll(TOOL_NAME_RE)].map((m) => m[1] ?? ''))]
      .filter((name) => !known.has(name))
      .sort();
    assert.deepEqual(
      stale,
      [],
      'THREAT-MODEL.md names tools the manifest does not register',
    );
  });
});
