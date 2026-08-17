// ---------------------------------------------------------------------------
// Hint catalog ↔ docs sync (CC-72).
//
// TOOLS.md calls the hint vocabulary *closed*, and `mcp/result.ts` enforces that
// closure at runtime by rejecting any code outside `HINT_CODES`. So the catalog
// table in TOOLS.md is not decoration: it is the only place a caller can learn
// what the closed set contains, and a code that exists in one and not the other
// is either an undocumented hint or a documented hint nothing can ever emit.
//
// This is the mechanizable half of the TOOLS.md claim. The other half — that the
// table is edited *first* and the code follows — stays [honor] (D77): a test can
// observe the state of two files, never the order in which someone edited them.
//
// The docs side is parsed out of the ORIGINAL markdown, found by walking up from
// this file's compiled location, the same way `env-docs-sync.test.ts` does it.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HINT_CODES } from './types.js';

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

const DOC_PATH = join(repoRoot(), 'docs', 'TOOLS.md');
const CATALOG_HEADING = '## Hint catalog (closed vocabulary)';

interface DocRow {
  readonly code: string;
  /** 1-based line number in docs/TOOLS.md, for failure messages. */
  readonly line: number;
}

/**
 * The catalog rows, in document order. Only the table under
 * {@link CATALOG_HEADING} is read — TOOLS.md mentions individual codes in prose
 * all over, and a prose mention is not a catalog entry.
 */
async function parseCatalog(): Promise<readonly DocRow[]> {
  const lines = (await readFile(DOC_PATH, 'utf8')).split('\n');
  const start = lines.indexOf(CATALOG_HEADING);
  assert.notEqual(
    start,
    -1,
    `docs/TOOLS.md no longer has a "${CATALOG_HEADING}" heading — this test ` +
      'parses the table under it, so a renamed heading is drift, not a rename',
  );

  const rows: DocRow[] = [];
  let inTable = false;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line.startsWith('## ')) break; // next section: the table is over
    if (!line.startsWith('|')) {
      if (inTable) break; // a blank line after the table ends it
      continue;
    }

    const first = (line.split('|')[1] ?? '').trim();
    if (first === 'Code') {
      inTable = true;
      continue;
    }
    if (/^-+$/.test(first.replaceAll(':', ''))) continue; // the ---|--- separator
    if (!inTable) continue;

    const code = /^`([^`]+)`$/.exec(first);
    assert.ok(
      code !== null,
      `docs/TOOLS.md:${index + 1}: a catalog row must open with a \`backticked\` ` +
        `code, found ${JSON.stringify(first)}`,
    );
    rows.push({ code: code[1] ?? '', line: index + 1 });
  }

  return rows;
}

describe('CC-72: hint catalog ↔ TOOLS.md', () => {
  test('the parser finds the catalog table it is supposed to find', async () => {
    // A parser that silently matched nothing would make both set comparisons
    // below pass vacuously. This fails first, and says why.
    const rows = await parseCatalog();
    assert.ok(
      rows.length >= 10,
      `the catalog parse found only ${rows.length} row(s) — the table shape changed`,
    );

    const codes = rows.map((row) => row.code);
    assert.equal(
      codes.length,
      new Set(codes).size,
      `docs/TOOLS.md lists a hint code twice: ${codes.join(', ')}`,
    );
  });

  test('every code in the TOOLS.md catalog exists in HINT_CODES', async () => {
    const known = new Set<string>(HINT_CODES);
    const dead = (await parseCatalog())
      .filter((row) => !known.has(row.code))
      .map((row) => `${row.code} (docs/TOOLS.md:${row.line})`);

    assert.deepEqual(
      dead,
      [],
      `documented but unemittable hint code(s): ${dead.join('; ')} — ` +
        'mcp/result.ts rejects any code outside HINT_CODES, so the row promises ' +
        'a hint no tool can ever return',
    );
  });

  test('every code in HINT_CODES has a row in the TOOLS.md catalog', async () => {
    const documented = new Set((await parseCatalog()).map((row) => row.code));
    const undocumented = HINT_CODES.filter((code) => !documented.has(code));

    assert.deepEqual(
      [...undocumented],
      [],
      `undocumented hint code(s): ${undocumented.join(', ')} — add a row to the ` +
        'hint catalog in docs/TOOLS.md (spec first, then code — D77)',
    );
  });
});
