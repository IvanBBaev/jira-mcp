// Scope map binding for docs/AUTH.md (DOC-R6) and the governance page
// docs/ADMIN-OVERVIEW.md (DOC-R5).
//
// The 2026-10-29 docs review found the AUTH scope table calling itself
// exhaustive while it missed whole families (bulk, filters, remote links,
// permissions, sprint update/rank/estimate, portfolio). The table is now one
// row per tool between `<!-- scope-map -->` and `<!-- /scope-map -->`, and
// this suite recomputes everything AUTH.md derives from it:
//
// - the rows are exactly the manifest's tools;
// - every scope is in the default `JIRA_OAUTH_SCOPES` list or is a documented
//   exclusion;
// - each preset covers what it promises, holds no unused scope, and its
//   "not covered" list is exactly what it leaves out;
// - the default list's gaps and surplus are the ones AUTH.md names.
//
// It also checks that every `JIRA_*` name ADMIN-OVERVIEW.md mentions is a
// documented configuration variable, so the summary cannot drift from
// CONFIGURATION.md. It lives in `tools/` because it imports the manifest.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../core/fakes/fixtures.js';
import { DEFAULT_OAUTH_SCOPES } from '../core/settings.js';
import { PROFILE_PACKAGES } from '../mcp/registry.js';
import { PACKAGES } from './index.js';

const AUTH = readFileSync(join(REPO_ROOT, 'docs', 'AUTH.md'), 'utf8');
const ADMIN = readFileSync(join(REPO_ROOT, 'docs', 'ADMIN-OVERVIEW.md'), 'utf8');
const CONFIGURATION = readFileSync(join(REPO_ROOT, 'docs', 'CONFIGURATION.md'), 'utf8');

/** Scopes AUTH.md keeps out of the default on purpose (finding 5). */
const DOCUMENTED_EXCLUSIONS: ReadonlySet<string> = new Set([
  'delete:sprint:jira-software',
]);
/** Not a Jira scope: it only makes the refresh token appear. */
const OFFLINE = 'offline_access';
const WRITE_PREFIX = /^(?:write|manage|delete):/;

const TOOLS = PACKAGES.flatMap((pkg) =>
  pkg.tools.map((tool) => ({
    name: tool.name,
    pkg: pkg.id,
    write: tool.writeTier !== undefined,
  })),
);

/** The text between a pair of HTML comment markers, exactly once. */
function between(doc: string, open: string, close: string, what: string): string {
  const parts = doc.split(open);
  assert.equal(parts.length, 2, `AUTH.md needs exactly one ${what}`);
  const body = parts[1]?.split(close)[0];
  assert.ok(body !== undefined && body !== parts[1], `${what} is not closed`);
  return body;
}

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');

interface Row {
  readonly pkg: string;
  readonly tool: string;
  readonly scopes: readonly string[];
}

function scopeMap(): Row[] {
  const body = between(AUTH, '<!-- scope-map -->', '<!-- /scope-map -->', 'scope map');
  return body
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      const scopesCell = cells[3] ?? '';
      return {
        pkg: backticked(cells[1] ?? '')[0] ?? '',
        tool: backticked(cells[2] ?? '')[0] ?? '',
        scopes: scopesCell === 'none' ? [] : backticked(scopesCell),
      };
    });
}

const ROWS = scopeMap();
const SCOPES_OF = new Map(ROWS.map((row) => [row.tool, new Set(row.scopes)]));

function preset(key: string): Set<string> {
  const body = between(
    AUTH,
    `<!-- scope-preset:${key} -->`,
    '<!-- /scope-preset -->',
    `scope-preset:${key}`,
  );
  const text = /```text\n([^\n]+)\n```/.exec(body)?.[1];
  assert.ok(text, `scope-preset:${key} needs one \`\`\`text line`);
  const list = text.split(',').map((scope) => scope.trim());
  assert.equal(new Set(list).size, list.length, `scope-preset:${key} repeats a scope`);
  return new Set(list);
}

function toolList(key: string): string[] {
  const body = between(AUTH, `<!-- tools:${key} -->`, '<!-- /tools -->', `tools:${key}`);
  return backticked(body);
}

const covers = (granted: ReadonlySet<string>, tool: string): boolean =>
  [...(SCOPES_OF.get(tool) ?? [])].every((scope) => granted.has(scope));

const uncovered = (granted: ReadonlySet<string>): string[] =>
  TOOLS.filter((tool) => !covers(granted, tool.name))
    .map((tool) => tool.name)
    .sort();

/** Scopes in a list that no covered tool needs. */
function unused(granted: ReadonlySet<string>): string[] {
  const needed = new Set(
    TOOLS.filter((tool) => covers(granted, tool.name)).flatMap((tool) => [
      ...(SCOPES_OF.get(tool.name) ?? []),
    ]),
  );
  return [...granted].filter((scope) => scope !== OFFLINE && !needed.has(scope)).sort();
}

describe('AUTH.md scope map (manifest-bound)', () => {
  test('the scope map has one row per manifest tool, in its package', () => {
    const names = ROWS.map((row) => row.tool);
    assert.equal(new Set(names).size, names.length, 'a tool has two scope-map rows');
    const documented = new Set(names);
    const actual = new Set<string>(TOOLS.map((tool) => tool.name));
    assert.deepEqual(
      {
        missing: [...actual].filter((name) => !documented.has(name)).sort(),
        extra: [...documented].filter((name) => !actual.has(name)).sort(),
      },
      { missing: [], extra: [] },
      'AUTH.md scope map disagrees with the manifest',
    );
    for (const tool of TOOLS) {
      const row = ROWS.find((candidate) => candidate.tool === tool.name);
      assert.equal(row?.pkg, tool.pkg, `${tool.name} is listed under the wrong package`);
    }
  });

  test('every mapped scope is a default scope or a documented exclusion', () => {
    const known = new Set([...DEFAULT_OAUTH_SCOPES, ...DOCUMENTED_EXCLUSIONS]);
    for (const row of ROWS) {
      for (const scope of row.scopes) {
        assert.ok(known.has(scope), `${row.tool}: unknown scope ${scope}`);
        assert.notEqual(scope, OFFLINE, `${row.tool}: offline_access is not per tool`);
      }
    }
  });

  test('only jira_capabilities needs no scope; a write needs a write scope', () => {
    for (const tool of TOOLS) {
      const scopes = [...(SCOPES_OF.get(tool.name) ?? [])];
      if (tool.name === 'jira_capabilities') {
        assert.deepEqual(scopes, [], 'jira_capabilities makes no HTTP call');
        continue;
      }
      assert.ok(scopes.length > 0, `${tool.name} maps to no scope`);
      if (tool.write) {
        assert.ok(
          scopes.some((scope) => WRITE_PREFIX.test(scope)),
          `${tool.name} is a write but maps to read scopes only`,
        );
      }
    }
  });

  test('the reader preset is read-only and covers the reader profile', () => {
    const reader = preset('reader');
    assert.ok(reader.has(OFFLINE), 'the reader preset needs offline_access');
    assert.deepEqual(
      [...reader].filter((scope) => WRITE_PREFIX.test(scope)),
      [],
      'the reader preset holds a write scope',
    );
    for (const scope of reader) {
      assert.ok(
        DEFAULT_OAUTH_SCOPES.includes(scope),
        `reader: ${scope} is not a default scope`,
      );
    }
    const profile = new Set<string>(PROFILE_PACKAGES.reader);
    const gaps = TOOLS.filter(
      (tool) => profile.has(tool.pkg) && !tool.write && !covers(reader, tool.name),
    ).map((tool) => tool.name);
    assert.deepEqual(gaps, [], 'the reader preset misses a read of the reader profile');
    assert.deepEqual(unused(reader), [], 'the reader preset holds a scope no tool uses');
    const readGaps = TOOLS.filter((tool) => !tool.write && !covers(reader, tool.name))
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(
      readGaps,
      toolList('not-reader').sort(),
      'tools:not-reader is stale',
    );
  });

  test('the core-writes preset leaves out exactly the listed tools', () => {
    const core = preset('core-writes');
    assert.ok(core.has(OFFLINE), 'the core-writes preset needs offline_access');
    for (const scope of core) {
      assert.ok(
        DEFAULT_OAUTH_SCOPES.includes(scope),
        `core-writes: ${scope} is not a default scope`,
      );
      assert.ok(!/^(?:manage|delete):/.test(scope), `core-writes holds ${scope}`);
    }
    assert.deepEqual(
      unused(core),
      [],
      'the core-writes preset holds a scope no tool uses',
    );
    assert.deepEqual(
      uncovered(core),
      toolList('not-core-writes').sort(),
      'tools:not-core-writes is stale',
    );
  });

  test('the default list: its gaps and its surplus are the documented ones', () => {
    const defaults = new Set(DEFAULT_OAUTH_SCOPES);
    assert.deepEqual(
      uncovered(defaults),
      toolList('not-default').sort(),
      'tools:not-default is stale',
    );
    const surplus = backticked(
      between(
        AUTH,
        '<!-- scopes:default-surplus -->',
        '<!-- /scopes -->',
        'default surplus',
      ),
    );
    assert.deepEqual(unused(defaults), surplus.sort(), 'scopes:default-surplus is stale');
  });
});

describe('ADMIN-OVERVIEW.md (config-bound)', () => {
  test('every JIRA_* name it mentions is a documented configuration variable', () => {
    const documented = new Set(
      [...CONFIGURATION.matchAll(/^\| `(JIRA_[A-Z0-9_]+)`/gm)].map((match) => match[1]),
    );
    const named = new Set(
      [...ADMIN.matchAll(/\bJIRA_[A-Z0-9_]+\b/g)].map((match) => match[0]),
    );
    assert.ok(named.size > 0, 'ADMIN-OVERVIEW.md names no variable');
    const unknown = [...named].filter((name) => !documented.has(name)).sort();
    assert.deepEqual(unknown, [], 'ADMIN-OVERVIEW.md names an undocumented variable');
  });

  test('it links the deep documents it summarises', () => {
    for (const target of [
      'AUTH.md',
      'THREAT-MODEL.md',
      'CONFIGURATION.md',
      'OBSERVABILITY.md',
    ]) {
      assert.ok(
        ADMIN.includes(`](${target}`),
        `ADMIN-OVERVIEW.md does not link ${target}`,
      );
    }
  });
});
