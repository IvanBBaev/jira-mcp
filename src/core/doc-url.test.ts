// Suite for the tag-pinned documentation links (D545, V3-69).
//
// Three contracts: `docUrl` builds an absolute GitHub URL pinned to the
// installed version's tag (never `blob/main` when the version is known); every
// anchor in `DOC_ANCHORS` resolves to a real heading of the file it names, so a
// renamed heading fails the gate; and every `ErrorKind` has its own entry in
// TROUBLESHOOTING.md. A last check bans a bare `.md` file name in a string
// literal of the operator-facing modules, so a remediation cannot bypass the
// helper. It reads the ORIGINAL sources, found by walking up from
// `build/core/`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  DOC_ANCHORS,
  DOC_REPO_URL,
  docRef,
  docUrl,
  readPackageVersion,
  type DocFile,
} from './doc-url.js';
import { JIRA_ERROR_KINDS } from './types.js';

/** `build/core/` → the repo root. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * GitHub's heading-anchor slug (github-slugger): lowercase, drop punctuation
 * but keep `_` and `-`, and turn EACH space into a hyphen — so "13 — unverified"
 * becomes `13--unverified`, which is what the browser receives.
 */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/ /g, '-');
}

/** Every heading anchor of `docs/<file>`, with GitHub's duplicate suffixes. */
function anchorsOf(file: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const raw of readFileSync(join(ROOT, 'docs', file), 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(raw);
    if (!m?.[1]) continue;
    const base = slug(m[1]);
    let candidate = base;
    for (let n = 1; anchors.has(candidate); n += 1) candidate = `${base}-${n}`;
    anchors.add(candidate);
  }
  return anchors;
}

describe('docUrl', () => {
  test('pins the link to the given ref and appends the anchor', () => {
    assert.equal(
      docUrl('AUTH.md', 'scoped-api-tokens', 'v1.2.3'),
      `${DOC_REPO_URL}/blob/v1.2.3/docs/AUTH.md#scoped-api-tokens`,
    );
  });

  test('an empty anchor links the top of the page', () => {
    assert.equal(
      docUrl('CONFIGURATION.md', '', 'v1.2.3'),
      `${DOC_REPO_URL}/blob/v1.2.3/docs/CONFIGURATION.md`,
    );
  });

  test('by default pins the installed version tag, not main', () => {
    const version = readPackageVersion();
    assert.ok(version, 'package.json version is readable from build/core/');
    const url = docUrl('TROUBLESHOOTING.md', 'auth');
    assert.equal(url, `${DOC_REPO_URL}/blob/v${version}/docs/TROUBLESHOOTING.md#auth`);
    assert.ok(!url.includes('/blob/main/'));
  });
});

describe('docRef / readPackageVersion', () => {
  test('a version becomes its tag; none falls back to main', () => {
    assert.equal(docRef('1.1.0'), 'v1.1.0');
    assert.equal(docRef(undefined), 'main');
    assert.equal(docRef(''), 'main');
  });

  test('an unreadable or malformed manifest yields undefined', () => {
    assert.equal(
      readPackageVersion(() => {
        throw new Error('ENOENT');
      }),
      undefined,
    );
    assert.equal(
      readPackageVersion(() => 'not json'),
      undefined,
    );
    assert.equal(
      readPackageVersion(() => '{"version":7}'),
      undefined,
    );
    assert.equal(
      readPackageVersion(() => '{"version":"2.0.0"}'),
      '2.0.0',
    );
  });
});

describe('anchor registry', () => {
  for (const [file, anchors] of Object.entries(DOC_ANCHORS)) {
    test(`every registered anchor of ${file} is a heading`, () => {
      const present = anchorsOf(file);
      for (const anchor of anchors) {
        if (anchor === '') continue;
        assert.ok(present.has(anchor), `docs/${file} has no heading for #${anchor}`);
      }
    });
  }

  test('every ErrorKind has its own TROUBLESHOOTING.md anchor', () => {
    const registered: readonly string[] = DOC_ANCHORS['TROUBLESHOOTING.md'];
    const present = anchorsOf('TROUBLESHOOTING.md');
    for (const kind of JIRA_ERROR_KINDS) {
      assert.ok(
        registered.includes(kind),
        `DOC_ANCHORS lacks TROUBLESHOOTING.md#${kind}`,
      );
      assert.ok(
        present.has(kind),
        `docs/TROUBLESHOOTING.md has no "### \`${kind}\`" heading`,
      );
    }
  });
});

/** The modules whose strings an operator reads. */
const OPERATOR_FACING = [
  'src/index.ts',
  'src/cli/doctor.ts',
  'src/cli/login.ts',
  'src/core/settings/report.ts',
  'src/core/settings/requirements.ts',
] as const;

const DOC_FILE_IN_STRING = /\b[A-Z][A-Z0-9-]*\.md\b|blob\/main/;

describe('operator-facing strings', () => {
  for (const rel of OPERATOR_FACING) {
    test(`${rel} links docs only through docUrl`, () => {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
      const offenders: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          // `docUrl('AUTH.md', …)` arguments are the helper itself.
          const parent = node.parent;
          const isDocUrlArg =
            ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === 'docUrl';
          // Import specifiers are module paths, not operator text.
          const isModulePath =
            ts.isImportDeclaration(parent) ||
            ts.isExportDeclaration(parent) ||
            (ts.isCallExpression(parent) &&
              parent.expression.kind === ts.SyntaxKind.ImportKeyword);
          if (!isDocUrlArg && !isModulePath && DOC_FILE_IN_STRING.test(node.text)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            offenders.push(
              `${rel}:${line + 1}: ${JSON.stringify(node.text.slice(0, 80))}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      assert.deepEqual(offenders, [], 'use docUrl() for documentation links');
    });
  }

  test('the registry keys are files under docs/', () => {
    for (const file of Object.keys(DOC_ANCHORS) as DocFile[]) {
      assert.ok(readFileSync(join(ROOT, 'docs', file), 'utf8').length > 0);
    }
  });
});
