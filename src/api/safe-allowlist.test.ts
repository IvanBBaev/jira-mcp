// The `safe: true` allowlist (V3-41, QA-R9).
//
// One bit on a `JiraRequestSpec` carries three safety meanings at once:
//
//   * replay   — `core/http` retries a `safe` request on 502/503/504 and on a
//                transport failure, like a GET (`isReplayable`);
//   * plan     — the write gate lets a `safe` request through plan capture and
//                through the read-only seam a read tool runs on (D527);
//   * journal  — `mcp/server` keeps a `safe` request out of the mutation
//                journal.
//
// Setting it on a write spec — to "fix" a flaky retry, say — would quietly make
// that write replayable, let it run in plan mode and leave it unjournaled. So
// every request literal in `src/` that sets `safe` is collected from the source
// and compared against the frozen list below, each entry with the reason the
// request is a pure read. Adding one, moving one or dropping one is a reviewed
// diff of this file.
//
// The scan reads the TypeScript source (not the build), finds every object
// literal with a `safe` property, and names it by the chain of named
// declarations around it plus the literal's `method` and `path`. A `safe`
// that is not the literal `true` (a variable, a shorthand, `false`) fails too:
// the list can only vouch for what it can read.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** `build/api/` → the repo root. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

/**
 * The frozen allowlist: every request that may carry `safe: true`, keyed as
 * `<file> › <enclosing declarations> · <METHOD> <path>`, with why it is a read.
 */
const SAFE_ALLOWLIST: Readonly<Record<string, string>> = {
  'src/api/search.ts › searchIssues › buildSpec · POST SEARCH_JQL_PATH':
    'JQL search: the body carries the query, nothing is stored.',
  'src/api/search.ts › searchIssuesDataCenter › request · POST DATACENTER_SEARCH_PATH':
    'Data Center JQL search page: a read with the JQL in the body.',
  'src/api/search.ts › approximateCount · POST APPROXIMATE_COUNT_PATH':
    'Approximate issue count for a JQL: a read.',
  'src/api/search.ts › countIssuesDataCenter · POST DATACENTER_SEARCH_PATH':
    'Data Center count: a zero-row search, a read.',
  'src/api/search.ts › parseJql · POST JQL_PARSE_PATH':
    'JQL validation: Jira parses the queries and stores nothing.',
  'src/api/issues/bulk.ts › getIssuesBulk · POST ISSUE_BULKFETCH_PATH':
    'Issue bulkfetch: reads up to the cap of issues by key or id (D527).',
  'src/api/issues/changelog.ts › getChangelogsBulk · POST CHANGELOG_BULKFETCH_PATH':
    'Changelog bulkfetch: reads the change history of many issues (D527).',
  "src/mcp/project-scope.ts › assertIssues · POST ctx.deployment === 'datacenter' ? '/search' : '/search/jql'":
    'The JIRA_PROJECTS guard resolving issue keys to projects: a search.',
  "src/cli/doctor.ts › PROBES › run · POST '/search/jql'":
    'The doctor search probe: one-row search, a read.',
};

/** One object literal in the source that sets `safe`. */
interface SafeSite {
  /** The allowlist key. */
  readonly key: string;
  /** `file:line`, for the failure message. */
  readonly at: string;
  /** The `safe` initializer as written, when it is not the literal `true`. */
  readonly nonLiteral?: string;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** The literal's `method`/`path` initializers as written, e.g. `POST SEARCH_JQL_PATH`. */
function requestOf(literal: ts.ObjectLiteralExpression, source: ts.SourceFile): string {
  const text = (prop: string): string => {
    for (const member of literal.properties) {
      if (ts.isPropertyAssignment(member) && propertyName(member.name) === prop) {
        const init = member.initializer;
        return ts.isStringLiteral(init) && prop === 'method'
          ? init.text
          : init.getText(source).replace(/\s+/g, ' ');
      }
      if (ts.isShorthandPropertyAssignment(member) && member.name.text === prop) {
        return member.name.text;
      }
    }
    return `<no ${prop}>`;
  };
  return `${text('method')} ${text('path')}`;
}

function isFunctionLike(node: ts.Node | undefined): boolean {
  return (
    node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
  );
}

/** The named declarations around `node`, outermost first. */
function enclosingNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    let name: string | undefined;
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isFunctionExpression(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isClassDeclaration(at)) &&
      at.name !== undefined
    ) {
      name = propertyName(at.name);
    } else if (
      ts.isVariableDeclaration(at) &&
      ts.isIdentifier(at.name) &&
      (isFunctionLike(at.initializer) || ts.isSourceFile(at.parent.parent.parent))
    ) {
      // A function-valued or module-level binding; a local such as
      // `const response = await send(...)` is not a name a reviewer looks for.
      name = at.name.text;
    } else if (ts.isPropertyAssignment(at) && isFunctionLike(at.initializer)) {
      name = propertyName(at.name);
    }
    if (name !== undefined) names.unshift(name);
  }
  return names;
}

/** Every object literal in `text` with a `safe` property. */
function scanSafeSites(file: string, text: string): SafeSite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: SafeSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const member of node.properties) {
        const isSafe =
          (ts.isPropertyAssignment(member) && propertyName(member.name) === 'safe') ||
          (ts.isShorthandPropertyAssignment(member) && member.name.text === 'safe');
        if (!isSafe) continue;
        const scope = enclosingNames(node);
        const key = `${file} › ${scope.length === 0 ? '<module>' : scope.join(' › ')} · ${requestOf(node, source)}`;
        const line =
          source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1;
        const literalTrue =
          ts.isPropertyAssignment(member) &&
          member.initializer.kind === ts.SyntaxKind.TrueKeyword;
        sites.push({
          key,
          at: `${file}:${line}`,
          ...(literalTrue ? {} : { nonLiteral: member.getText(source) }),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** Every production `.ts` file under `src/`, repo-relative with `/`. */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...productionFiles(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(relative(ROOT, path).split(sep).join('/'));
    }
  }
  return out.sort();
}

/** The allowlist verdict over a set of sites: the problems, one line each. */
function checkSafeSites(
  sites: readonly SafeSite[],
  allowlist: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const site of sites) {
    const earlier = seen.get(site.key);
    if (earlier !== undefined) {
      problems.push(
        `${site.at}: ${site.key} is ambiguous (also ${earlier}) — give the request its own named function.`,
      );
    }
    seen.set(site.key, site.at);
    if (site.nonLiteral !== undefined) {
      problems.push(
        `${site.at}: \`${site.nonLiteral}\` on ${site.key} — \`safe\` must be the literal \`true\` so the allowlist can vouch for it.`,
      );
    } else if (!Object.hasOwn(allowlist, site.key)) {
      problems.push(
        `${site.at}: \`safe: true\` on ${site.key} is not on the allowlist. A safe request is replayed on a 5xx, ` +
          'runs in plan mode and is not journaled: only a pure read may carry it. If this one is, add it to ' +
          'SAFE_ALLOWLIST in src/api/safe-allowlist.test.ts with the reason.',
      );
    }
  }
  for (const key of Object.keys(allowlist)) {
    if (!seen.has(key)) {
      problems.push(`allowlist entry no longer matches a request: ${key} — remove it.`);
    }
  }
  return problems;
}

test('[CC-5190] every `safe` request in src/ is on the frozen allowlist, and every entry still matches one', () => {
  const files = productionFiles(SRC);
  assert.ok(files.length > 50, `the scan found only ${files.length} source files`);
  const sites = files.flatMap((file) =>
    scanSafeSites(file, readFileSync(join(ROOT, file), 'utf8')),
  );
  assert.deepEqual(checkSafeSites(sites, SAFE_ALLOWLIST), []);
  assert.equal(sites.length, Object.keys(SAFE_ALLOWLIST).length);
});

test('[CC-5191] every allowlist entry gives a reason', () => {
  for (const [key, reason] of Object.entries(SAFE_ALLOWLIST)) {
    assert.ok(reason.trim().length >= 10, `${key}: the reason is missing`);
  }
});

test('[CC-5192] `safe: true` added to a write spec fails with a message naming the spec', () => {
  const source = [
    'export async function createIssue(options) {',
    '  return send(options, { method: "POST", path: ISSUE_PATH, safe: true, body: {} });',
    '}',
  ].join('\n');
  const problems = checkSafeSites(scanSafeSites('src/api/x.ts', source), {});
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /^src\/api\/x\.ts:2: /);
  assert.match(problems[0] ?? '', /src\/api\/x\.ts › createIssue · POST ISSUE_PATH/);
  assert.match(problems[0] ?? '', /not on the allowlist/);
});

test('[CC-5193] a non-literal `safe` (variable, shorthand, false) fails even when the request is allowlisted', () => {
  const source = [
    'function a(flag) { return { method: "POST", path: P, safe: flag }; }',
    'function b(safe) { return { method: "POST", path: P, safe }; }',
    'function c() { return { method: "PUT", path: P, safe: false }; }',
  ].join('\n');
  const sites = scanSafeSites('src/api/x.ts', source);
  const allow = Object.fromEntries(sites.map((site) => [site.key, 'a read']));
  const problems = checkSafeSites(sites, allow);
  assert.equal(problems.length, 3);
  assert.match(problems[0] ?? '', /`safe: flag`.*literal `true`/);
  assert.match(problems[1] ?? '', /`safe`.*literal `true`/);
  assert.match(problems[2] ?? '', /`safe: false`.*literal `true`/);
});

test('[CC-5194] a stale allowlist entry and an ambiguous key both fail', () => {
  const source = [
    'function twice() {',
    '  a({ method: "POST", path: P, safe: true });',
    '  b({ method: "POST", path: P, safe: true });',
    '}',
  ].join('\n');
  const key = 'src/api/x.ts › twice · POST P';
  const problems = checkSafeSites(scanSafeSites('src/api/x.ts', source), {
    [key]: 'a read',
    'src/api/x.ts › gone · POST Q': 'a read that was removed',
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? '', /ambiguous/);
  assert.match(problems[1] ?? '', /no longer matches a request: src\/api\/x\.ts › gone/);
});
