// ---------------------------------------------------------------------------
// tools/port-boundary.test.ts — the tools ring reaches the api ring only
// through `ctx.api` and `api/port.js` (D106, D538).
//
// The port only works if nothing goes around it: one tool that still imports
// `getIssue` directly would keep calling the Cloud function under any other
// adapter, silently, and one that imports a Cloud DTO type or page-size
// constant from `api/issues.ts` pins the tools to the Cloud module rather than
// to the contract. So this reads every tool module's source and refuses:
//
//   * any import from an api module other than `api/port.js`;
//   * a value import of a port FUNCTION other than the pure, backend-neutral
//     helpers below — the rest are reached through `ctx.api`;
//   * a value import of the Cloud adapter or its limits — a handler reads
//     `ctx.api` and `ctx.api.limits`, which follow the deployment.
//
// Types and schema/description constants re-exported by the port stay
// importable.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import * as port from '../api/port.js';
import { CLOUD_API } from '../api/port.js';

/** The compiled test sits at `build/tools/`, so the repo root is two levels up. */
const REPO = new URL('../../', import.meta.url);

/**
 * Api-ring functions a tool may import (from the port): pure, network-free,
 * and meaningful on any backend. A function lands here only if it neither
 * talks to Jira nor produces or consumes a wire body format — see `api/port.ts`.
 */
const PURE_HELPERS: ReadonlySet<string> = new Set([
  'filterFields',
  'filterLabels',
  'resolveTransitionId',
  'startedInstant',
]);

/** Port values that are per-deployment: a tool reads them off `ctx.api`. */
const ADAPTER_VALUES: ReadonlySet<string> = new Set(['CLOUD_API', 'CLOUD_LIMITS']);

interface ApiImport {
  readonly file: string;
  /** The specifier after `../api/`, e.g. `port.js`. */
  readonly module: string;
  readonly name: string;
  readonly typeOnly: boolean;
}

function toolSources(): readonly { file: string; source: string }[] {
  const dir = new URL('src/tools/', REPO);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(new URL(file, dir), 'utf8') }));
}

/** Every named import from `../api/**` in the tool modules. */
function apiImports(): readonly ApiImport[] {
  const out: ApiImport[] = [];
  const statement = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'\.\.\/api\/([^']+)';/g;
  for (const { file, source } of toolSources()) {
    for (const match of source.matchAll(statement)) {
      for (const raw of (match[2] ?? '').split(',')) {
        // `getIssue as fetchIssue` is still getIssue: judge the exported name.
        const spec = raw.trim();
        if (spec === '') continue;
        const inlineType = spec.startsWith('type ');
        const name = spec.replace(/^type\s+/, '').split(/\s+as\s+/)[0] ?? '';
        out.push({
          file,
          module: match[3] ?? '',
          name,
          typeOnly: match[1] !== undefined || inlineType,
        });
      }
    }
  }
  return out;
}

test('the scan sees the tool modules and their port imports', () => {
  const imports = apiImports();
  // Non-vacuity: types, schema constants and the pure helpers all come in.
  assert.ok(imports.length >= 100, `found ${String(imports.length)} api imports`);
  assert.ok(imports.some((i) => i.name === 'resolveTransitionId' && !i.typeOnly));
  assert.ok(imports.some((i) => i.name === 'IssueDetail' && i.typeOnly));
  assert.ok(imports.some((i) => i.name === 'MAX_PAGE_SIZE' && !i.typeOnly));
});

test('D538: no tool imports an api module other than the port', () => {
  const offenders = apiImports()
    .filter((i) => i.module !== 'port.js')
    .map((i) => `${i.file}: ${i.typeOnly ? 'type ' : ''}${i.name} from api/${i.module}`);
  assert.deepEqual(offenders, [], 'import it from ../api/port.js (re-export it there)');
});

test('no tool imports an api-ring function except the pure helpers', () => {
  const exports = port as Readonly<Record<string, unknown>>;
  const offenders: string[] = [];
  for (const { file, name, typeOnly } of apiImports()) {
    if (typeOnly) continue;
    if (ADAPTER_VALUES.has(name)) {
      offenders.push(`${file}: ${name} (read ctx.api instead)`);
      continue;
    }
    if (typeof exports[name] !== 'function') continue;
    if (PURE_HELPERS.has(name)) continue;
    offenders.push(`${file}: ${name}`);
  }
  assert.deepEqual(offenders, [], 'call these through ctx.api instead');
});

test('no tool imports an api module wholesale or by side effect', () => {
  // `import * as issues from '../api/issues.js'` would reach every function
  // without naming one, so the named-import scan above could not see it; a
  // default or bare import would slip past it the same way.
  const other =
    /import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+'\.\.\/api\/|import\s+'\.\.\/api\/|import\(\s*'\.\.\/api\//;
  const offenders = toolSources()
    .filter(({ source }) => other.test(source))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test('no pure helper is also a port member', () => {
  for (const name of PURE_HELPERS) {
    assert.equal(Object.hasOwn(CLOUD_API, name), false, name);
  }
});

test('every pure helper is re-exported by the port', () => {
  const exports = port as Readonly<Record<string, unknown>>;
  for (const name of PURE_HELPERS) {
    assert.equal(typeof exports[name], 'function', name);
  }
});
