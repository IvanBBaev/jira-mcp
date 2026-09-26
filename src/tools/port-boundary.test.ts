// ---------------------------------------------------------------------------
// tools/port-boundary.test.ts — the tools ring reaches the api ring only
// through `ctx.api` (D106).
//
// The port only works if nothing goes around it: one tool that still imports
// `getIssue` directly would keep calling the Cloud function under any other
// adapter, silently. So this reads every tool module's source and refuses a
// direct VALUE import of an api-ring function, with a short allowlist of pure,
// backend-neutral helpers. Constants and types stay importable.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { CLOUD_API } from '../api/port.js';

/** The compiled test sits at `build/tools/`, so the repo root is two levels up. */
const REPO = new URL('../../', import.meta.url);

/**
 * Api-ring functions a tool may import directly: pure, network-free, and
 * meaningful on any backend. A function lands here only if it neither talks to
 * Jira nor produces or consumes a wire body format — see `api/port.ts`.
 */
const PURE_HELPERS: ReadonlySet<string> = new Set([
  'filterFields',
  'resolveTransitionId',
  'startedInstant',
]);

interface ApiImport {
  readonly file: string;
  readonly module: string;
  readonly name: string;
}

/** Every non-type named import from `../api/*.js` in the tool modules. */
function apiValueImports(): readonly ApiImport[] {
  const dir = new URL('src/tools/', REPO);
  const out: ApiImport[] = [];
  const statement =
    /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'\.\.\/api\/([a-z-]+)\.js';/g;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(statement)) {
      if (match[1] !== undefined) continue;
      for (const raw of (match[2] ?? '').split(',')) {
        // `getIssue as fetchIssue` is still getIssue: judge the exported name.
        const name = raw.trim().split(/\s+as\s+/)[0] ?? '';
        if (name === '' || name.startsWith('type ')) continue;
        out.push({ file, module: match[3] ?? '', name });
      }
    }
  }
  return out;
}

test('the scan sees the tool modules and their api imports', () => {
  const imports = apiValueImports();
  // Non-vacuity: constants such as MAX_PAGE_SIZE are still imported directly,
  // and so are the pure helpers.
  assert.ok(imports.length >= 20, `found ${String(imports.length)} api value imports`);
  assert.ok(imports.some((i) => i.name === 'resolveTransitionId'));
});

test('no tool imports an api-ring function except the pure helpers', async () => {
  const offenders: string[] = [];
  for (const { file, module, name } of apiValueImports()) {
    const mod = (await import(`../api/${module}.js`)) as Record<string, unknown>;
    if (typeof mod[name] !== 'function') continue;
    if (PURE_HELPERS.has(name)) continue;
    offenders.push(`${file}: ${name} from api/${module}.ts`);
  }
  assert.deepEqual(offenders, [], 'call these through ctx.api instead');
});

test('no tool imports an api module wholesale', () => {
  // `import * as issues from '../api/issues.js'` would reach every function
  // without naming one, so the named-import scan above could not see it.
  const dir = new URL('src/tools/', REPO);
  const wholesale = /import\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s+'\.\.\/api\//;
  const offenders = readdirSync(dir).filter(
    (file) =>
      file.endsWith('.ts') &&
      !file.endsWith('.test.ts') &&
      wholesale.test(readFileSync(new URL(file, dir), 'utf8')),
  );
  assert.deepEqual(offenders, []);
});

test('no pure helper is also a port member', () => {
  for (const name of PURE_HELPERS) {
    assert.equal(Object.hasOwn(CLOUD_API, name), false, name);
  }
});
