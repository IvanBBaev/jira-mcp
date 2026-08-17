#!/usr/bin/env node
/**
 * docs-lint — mechanical enforcement of the rules docs/README.md states in prose.
 *
 * Six checks:
 *   1. link      — every relative markdown link inside docs/** resolves, and a
 *                  `#anchor` names a heading that actually exists in the target.
 *   2. banner    — every spec doc carries a `> Status:` banner in its first lines,
 *                  opening with the status that doc is allowed to claim, and no
 *                  banner still carries the retired pre-code phrasing.
 *   3. owned     — a literal owned by one document appears in that document and
 *                  nowhere else (the single-writer rule of the fact-ownership
 *                  table in docs/README.md).
 *   4. cc-ref    — every `CC-nn` reference resolves to an id defined in
 *                  docs/CORNER-CASES.md.
 *   5. pin-mirror — copies of the pinned registration example that live outside
 *                  check 3's reach (README.md is outside docs/, the Pages page
 *                  is not markdown) carry the same version CONFIGURATION.md does.
 *   6. test-bound — every **[test]** claim is backed by a test that exists: an
 *                  inline tag names its test (`[test: CC-nn]` / `[test: path]`),
 *                  and every CC-nn defined is reached by a real test NAME.
 *
 * Run standalone (`node scripts/docs-lint.mjs`) or as part of `npm run check`.
 * Exit code 1 with one `path:line: message` per finding; 0 when clean.
 *
 * The tables below are the whole configuration surface. Keep them short: a check
 * nobody can read is a check nobody will maintain.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

/**
 * Published review reports are immutable records of what a panel said on a date.
 * They are not spec, so they carry no status banner and are not bound by the
 * single-writer rule — they quote the spec as it stood.
 */
const ARCHIVE_DIRS = ['reviews'];

/**
 * Directories that are not part of the repo at all — local, git-excluded
 * working notes (`.git/info/exclude`). CI lints the committed tree, which
 * never contains them; skipping here keeps the local gate identical to CI.
 */
const LOCAL_ONLY_DIRS = ['ai'];

/** Docs exempt from the `> Status:` banner check. Empty by design — keep it so. */
const BANNER_EXEMPT = new Set();

/**
 * A status banner is a claim about the document's relationship to the code, so
 * it is checked as a claim, not as decoration. The spec corpus shipped with the
 * implementation, so the default claim is "normative and implemented"; the
 * pre-code phrasing it replaced is now false and is banned outright, so a
 * copy-pasted old banner fails instead of quietly lying.
 */
const BANNER_STATUS_DEFAULT = 'normative and implemented';

/** Docs whose status is legitimately something other than the default. */
const BANNER_STATUS_BY_DOC = new Map([
  ['DECISIONS.md', 'living document'],
  ['ROADMAP.md', 'aspirational'],
  ['WORK-PACKAGES.md', 'historical'],
  // A runbook of owner actions that have not been taken: normative about what
  // to do, and a lie if it claimed to describe shipped behaviour.
  ['RELEASING.md', 'procedural'],
]);

/** Phrasings that only made sense while the spec ran ahead of the code. */
const RETIRED_BANNER_RE = /pre-code|target[ -]state|code may lag/i;

/**
 * Literals whose value is owned by exactly one document (docs/README.md
 * §"Fact ownership"). Each must appear in its owner and in no other doc.
 *
 * `allow` lists docs that may name the literal without owning it, for the
 * derived mentions docs/README.md describes: a decision row recording *which*
 * value was chosen, or a catalog column listing it per tool. Every entry needs
 * a reason — an unexplained allowlist is how a single-writer rule rots.
 *
 * `enabled: false` parks a check whose finding is real but not yet actionable.
 */
const OWNED_LITERALS = [
  {
    pattern: /\b120000\b/,
    owner: 'CONFIGURATION.md',
    what: 'JIRA_CALL_BUDGET_MS default',
  },
  {
    pattern: /\b30000\b/,
    owner: 'CONFIGURATION.md',
    what: 'JIRA_REQUEST_TIMEOUT_MS default',
  },
  { pattern: /\b3334\b/, owner: 'CONFIGURATION.md', what: 'JIRA_HTTP_PORT default' },
  {
    pattern: /jira-mcp-ai@\d+\.\d+\.\d+/,
    owner: 'CONFIGURATION.md',
    what: 'pinned npx registration example',
  },
  { pattern: /\b5000\b/, owner: 'JIRA-API.md', what: 'maxResults endpoint cap' },
  { pattern: /MAX_RETRY_AFTER_MS/, owner: 'JIRA-API.md', what: 'retry-after ceiling' },
  // Deliberately the whole "N tools / M packages" phrase: a bare `\d+ tools`
  // also matches per-package counts and third-party tool counts (D1's Rovo
  // note), neither of which TOOLS.md owns.
  {
    pattern: /\b\d+ tools \/ \d+ packages\b/,
    owner: 'TOOLS.md',
    what: 'v1 tool/package count',
  },
  {
    pattern: /\b25000\b/,
    owner: 'CONFIGURATION.md',
    what: 'JIRA_MAX_RESULT_CHARS default',
  },
  {
    pattern: /\/rest\/api\/3\/search\/jql/,
    owner: 'JIRA-API.md',
    what: 'search endpoint path',
    allow: {
      'DECISIONS.md':
        'D6 records the choice of this endpoint — naming it is the decision',
      'TOOLS.md': 'the tool catalog names the endpoint each tool calls',
    },
  },
  // Deliberately the definitional phrasing, not the bare suffix: example
  // hostnames (`example.atlassian.net` in a fixture rule, `<site>.atlassian.net`
  // in a URL template) are illustrations, and banning those would only teach
  // people to write the suffix in a way the regex misses.
  {
    pattern: /canonical suffix[:\s]+`?\.atlassian\.net`?/i,
    owner: 'JIRA-API.md',
    what: 'canonical Cloud host suffix rule',
  },
];

/**
 * Bare `[test]` claims that do not yet carry a pointer (check 6a), with the
 * reason each is still open. Every entry is a promise to come back: an entry
 * only ever suppresses a tag that is still bare, so writing the pointer both
 * turns the real check on and makes the entry here stale — and a stale entry
 * is itself reported. The list cannot rot in place, and cannot grow quietly.
 *
 * `match` is tested against the LINE the tag sits on — line numbers move, prose
 * does not.
 *
 * Empty as of the Wave-10 doc-binding pass: every `[test]` in the corpus now
 * names the suite that backs it. Keep it that way — an entry added here is a
 * debt, and the check reports it the moment it is paid.
 */
const PENDING_TEST_CLAIMS = [];

/**
 * CC ids that CORNER-CASES.md defines but no test NAME reaches yet (check 6b).
 * The convention held through CC-35 (plus CC-46/CC-47) and was dropped as later
 * waves appended cases, so this is one historical backlog, not a policy.
 *
 * Empty as of the Wave-10 doc-binding pass — the backlog was closed, not
 * grandfathered: every defined case now names its id in a test. Adding an id
 * here is allowed, but it is a debt with a receipt: check 6b reports any id in
 * this list that has since become bound, so the allowlist cannot outlive the
 * drift it documents.
 */
const PENDING_CC_BINDINGS = [];

const findings = [];

function report(file, line, message) {
  findings.push(`${relative(REPO_ROOT, file)}:${line}: ${message}`);
}

function listMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = relative(DOCS_DIR, full);
      if (LOCAL_ONLY_DIRS.includes(rel)) continue;
      out.push(...listMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

function isArchive(file) {
  const rel = relative(DOCS_DIR, file);
  return ARCHIVE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** GitHub's heading-anchor slug: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

const anchorCache = new Map();

function anchorsOf(file) {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const anchors = new Set();
  const text = readFileSync(file, 'utf8');
  let inFence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(raw);
    if (!m) continue;
    // Duplicate headings get -1, -2, … suffixes, exactly as GitHub does.
    const base = slug(m[1]);
    let candidate = base;
    let n = 1;
    while (anchors.has(candidate)) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    anchors.add(candidate);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

// --- check 1: links ------------------------------------------------------

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks(file, text) {
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1];
    if (/^(?:https?|mailto|tel):/i.test(target)) continue;
    const line = lineOf(text, m.index);
    const hashAt = target.indexOf('#');
    const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : decodeURIComponent(target.slice(hashAt + 1));

    let resolved = file;
    if (pathPart !== '') {
      resolved = resolve(dirname(file), pathPart);
      if (!existsSync(resolved)) {
        report(file, line, `link target does not exist: ${target}`);
        continue;
      }
      if (statSync(resolved).isDirectory()) {
        if (anchor) report(file, line, `anchor on a directory link: ${target}`);
        continue;
      }
    }
    if (!anchor) continue;
    if (!resolved.endsWith('.md')) continue;
    if (!anchorsOf(resolved).has(anchor)) {
      report(file, line, `no heading matches anchor: ${target}`);
    }
  }
}

// --- check 2: status banner ---------------------------------------------

function checkBanner(file, text) {
  if (isArchive(file)) return;
  const rel = relative(DOCS_DIR, file);
  if (BANNER_EXEMPT.has(rel)) return;

  const lines = text.split('\n');
  const start = lines.slice(0, 10).findIndex((l) => /^>\s*Status:/.test(l));
  if (start === -1) {
    report(file, 1, 'missing `> Status:` banner in the first 10 lines');
    return;
  }
  // The banner is the whole quote block it opens, not just its first line —
  // the stale phrasing usually sits in the continuation.
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].startsWith('>')) end += 1;

  const opening = `> Status: ${BANNER_STATUS_BY_DOC.get(rel) ?? BANNER_STATUS_DEFAULT}`;
  if (!lines[start].startsWith(opening)) {
    report(file, start + 1, `status banner must open \`${opening}\``);
  }
  const retired = RETIRED_BANNER_RE.exec(lines.slice(start, end + 1).join('\n'));
  if (retired) {
    report(
      file,
      start + 1,
      `status banner still claims ${JSON.stringify(retired[0])}; the code ships ` +
        'with the spec — state what is true now',
    );
  }
}

// --- check 3: owned literals --------------------------------------------

function checkOwnedLiterals(files) {
  for (const rule of OWNED_LITERALS) {
    if (rule.enabled === false) continue;
    const re = new RegExp(rule.pattern.source, `g${rule.pattern.flags.replace('g', '')}`);
    const ownerPath = join(DOCS_DIR, rule.owner);
    let seenInOwner = false;

    for (const file of files) {
      if (isArchive(file)) continue;
      const text = readFileSync(file, 'utf8');
      const hits = [...text.matchAll(re)];
      if (hits.length === 0) continue;
      if (file === ownerPath) {
        seenInOwner = true;
        continue;
      }
      if (rule.allow?.[relative(DOCS_DIR, file)]) continue;
      report(
        file,
        lineOf(text, hits[0].index),
        `${rule.what} is owned by docs/${rule.owner}; link to it instead of ` +
          `restating ${JSON.stringify(hits[0][0])}`,
      );
    }

    if (!seenInOwner) {
      report(ownerPath, 1, `owner doc no longer states the ${rule.what}`);
    }
  }
}

// --- check 4: CC-nn references ------------------------------------------

const CC_DEF_RE = /^[ \t]*-[ \t]+\*\*(CC-\d+)\*\*/gm;
const CC_REF_RE = /\bCC-\d+\b/g;

const CORNER_CASES_DOC = join(DOCS_DIR, 'CORNER-CASES.md');

/** Every defined `CC-nn` mapped to the line that defines it. Check 6b wants the line. */
function definedCornerCases() {
  const text = readFileSync(CORNER_CASES_DOC, 'utf8');
  return new Map([...text.matchAll(CC_DEF_RE)].map((m) => [m[1], lineOf(text, m.index)]));
}

function checkCornerCaseRefs(files, defined) {
  if (defined.size === 0) {
    report(
      CORNER_CASES_DOC,
      1,
      'no `- **CC-nn**` definitions found — has the format changed?',
    );
    return;
  }
  for (const file of files) {
    if (isArchive(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(CC_REF_RE)) {
      if (!defined.has(m[0])) {
        report(file, lineOf(text, m.index), `${m[0]} is not defined in CORNER-CASES.md`);
      }
    }
  }
}

// --- check 5: version-pin mirrors ----------------------------------------

/**
 * The pinned `npx` registration example is owned by docs/CONFIGURATION.md
 * (check 3), but the copies users actually paste live outside that check's
 * reach: README.md sits outside docs/, the GitHub Pages page is HTML, not
 * markdown, and the Claude-plugin manifest is JSON that registers the same
 * artifact (D68). The Wave-8 release audit found three Pages pins silently
 * drifted, so these files are checked as mirrors: every pin in them must equal
 * the owner's value.
 */
const PIN_RE = /jira-mcp-ai@\d+\.\d+\.\d+/g;
const PIN_MIRRORS = ['README.md', 'docs/index.html', '.claude-plugin/plugin.json'];

function checkPinMirrors() {
  const ownerText = readFileSync(join(DOCS_DIR, 'CONFIGURATION.md'), 'utf8');
  const canonical = (ownerText.match(PIN_RE) ?? [])[0];
  if (!canonical) return; // check 3 already reports the missing owner value
  for (const rel of PIN_MIRRORS) {
    const file = join(REPO_ROOT, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(PIN_RE)) {
      if (m[0] !== canonical) {
        report(
          file,
          lineOf(text, m.index),
          `pinned version ${JSON.stringify(m[0])} drifted from ` +
            `docs/CONFIGURATION.md's ${JSON.stringify(canonical)}`,
        );
      }
    }
  }
}

// --- check 6: [test] claims are bound to a test that exists ---------------

/**
 * docs/README.md sells **[test]** as "asserted by a named test". Nothing used
 * to check that, so a doc could promise a suite that was never written — which
 * is how TESTING.md came to specify a fixture PII lint, and a `test/fixtures/`
 * directory, that do not exist. This check makes the promise mechanical.
 *
 * Two bindings, because the corpus states the claim in two shapes:
 *
 *   6a  an inline `[test]` tag names what asserts it — `[test: CC-nn]` or
 *       `[test: src/path/file.test.ts]`, comma-separated for several. A bare
 *       `[test]` is a promise with no address and is reported as one.
 *   6b  every `CC-nn` CORNER-CASES.md defines is reached by a test NAME, which
 *       is precisely what that document's header already promises in prose.
 *
 * Names, not file text. An id in a comment outlives the assertion it describes;
 * a name is printed by `node --test`, so a red run says which corner case
 * broke. The strictness is free — every id that reaches a test file today
 * reaches it through a name.
 *
 * Read from `src/**`, never `build/**`: `npm run docs:lint` must run without a
 * build, and does — one pass over the test sources, cached for both halves.
 *
 * The honest limit: a path pointer is checked for existence, not for content.
 * No regex can tell whether a file really asserts an English sentence, and
 * pretending otherwise is the fuzzy-matching trap this check exists to avoid.
 * Where existence is not enough, use the CC form — it binds to one name, and
 * 6b keeps that name honest from the other side. A CC pointer that names no
 * defined id is already check 4's finding, not repeated here.
 */

const SRC_DIR = join(REPO_ROOT, 'src');

/** `test('…')`, `it.skip("…")`, `describe(\`…\`)` — the name a runner prints. */
const TEST_NAME_RE =
  /\b(?:test|it|describe)\s*(?:\.\s*[A-Za-z]+\s*)?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

const TEST_TAG_RE = /\[test\b(?::([^\]]*))?\]/g;
const POINTER_PATH_RE = /^src\/[\w./-]+\.test\.ts$/;
const POINTER_CC_RE = /^CC-\d+$/;

/** docs/README.md's `- **[test]** — …` bullet defines the tag; it is not a claim. */
const TAG_DEFINITION_RE = /^\s*-\s*\*\*\[test\]\*\*/;

function listTests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTests(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

let boundCache = null;

/** Every `CC-nn` that reaches a test name anywhere in `src/**`. Computed once. */
function boundCornerCases() {
  if (boundCache) return boundCache;
  boundCache = new Set();
  if (!existsSync(SRC_DIR)) return boundCache;
  for (const file of listTests(SRC_DIR)) {
    for (const m of readFileSync(file, 'utf8').matchAll(TEST_NAME_RE)) {
      for (const id of m[2].matchAll(CC_REF_RE)) boundCache.add(id[0]);
    }
  }
  return boundCache;
}

const claimedPending = new Set();

function checkTestClaims(file, text) {
  if (isArchive(file)) return;
  const doc = relative(DOCS_DIR, file);
  const lines = text.split('\n');

  for (const m of text.matchAll(TEST_TAG_RE)) {
    const line = lineOf(text, m.index);
    if (TAG_DEFINITION_RE.test(lines[line - 1])) continue;

    // ``[test: `src/x.test.ts`, CC-12]`` — backticks are markdown, not address.
    const pointers = (m[1] ?? '')
      .split(',')
      .map((p) => p.replace(/[`\s]/g, ''))
      .filter(Boolean);

    if (pointers.length === 0) {
      // Only a BARE tag can be pending: the moment someone writes a pointer it
      // gets checked like any other, and the allowlist entry falls stale.
      const pending = PENDING_TEST_CLAIMS.find(
        (p) => p.doc === doc && p.match.test(lines[line - 1]),
      );
      if (pending) {
        claimedPending.add(pending);
        continue;
      }
      report(
        file,
        line,
        'a `[test]` claim must name the test that asserts it: ' +
          '`[test: CC-nn]` or `[test: src/…/file.test.ts]`',
      );
      continue;
    }
    for (const pointer of pointers) {
      if (POINTER_CC_RE.test(pointer)) {
        if (!boundCornerCases().has(pointer)) {
          report(
            file,
            line,
            `[test: ${pointer}] — no test name in src/** carries ${pointer}`,
          );
        }
      } else if (POINTER_PATH_RE.test(pointer)) {
        if (!existsSync(join(REPO_ROOT, pointer))) {
          report(file, line, `[test: ${pointer}] — that test file does not exist`);
        }
      } else {
        report(
          file,
          line,
          `[test: ${pointer}] — a pointer is a CC-nn id or a src/…/file.test.ts path`,
        );
      }
    }
  }
}

function checkCornerCaseBindings(defined) {
  const bound = boundCornerCases();
  const pending = new Map();
  for (const group of PENDING_CC_BINDINGS) {
    for (const id of group.ids) pending.set(id, group.why);
  }

  for (const [id, line] of defined) {
    if (!bound.has(id)) {
      if (pending.has(id)) continue;
      report(
        CORNER_CASES_DOC,
        line,
        `${id} is defined but no test name in src/** carries it — name the test ` +
          `\`${id}: …\`, as this document's header says test names do`,
      );
      continue;
    }
    if (pending.has(id)) {
      report(
        CORNER_CASES_DOC,
        line,
        `${id} is bound now — delete it from PENDING_CC_BINDINGS in ` +
          'scripts/docs-lint.mjs (the list may only shrink)',
      );
    }
  }
  for (const id of pending.keys()) {
    if (!defined.has(id)) {
      report(
        CORNER_CASES_DOC,
        1,
        `PENDING_CC_BINDINGS lists ${id}, which this document no longer defines`,
      );
    }
  }
}

/** An allowlist entry that stopped matching is drift of its own. */
function checkPendingTestClaims() {
  for (const pending of PENDING_TEST_CLAIMS) {
    if (claimedPending.has(pending)) continue;
    report(
      join(DOCS_DIR, pending.doc),
      1,
      `PENDING_TEST_CLAIMS entry ${pending.match} matches no \`[test]\` claim ` +
        'here any more — delete it from scripts/docs-lint.mjs',
    );
  }
}

// --- run -----------------------------------------------------------------

if (!existsSync(DOCS_DIR)) {
  console.error('docs-lint: docs/ not found');
  process.exit(1);
}

const files = listMarkdown(DOCS_DIR);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  checkLinks(file, text);
  checkBanner(file, text);
  checkTestClaims(file, text);
}
const cornerCases = definedCornerCases();
checkOwnedLiterals(files);
checkCornerCaseRefs(files, cornerCases);
checkPinMirrors();
checkCornerCaseBindings(cornerCases);
checkPendingTestClaims();

const parked = OWNED_LITERALS.filter((r) => r.enabled === false).length;
const pendingBindings =
  PENDING_TEST_CLAIMS.length +
  PENDING_CC_BINDINGS.reduce((n, group) => n + group.ids.length, 0);

if (findings.length > 0) {
  for (const f of findings) console.error(f);
  console.error(`\ndocs-lint: ${findings.length} finding(s)`);
  process.exit(1);
}

console.error(
  `docs-lint: ${files.length} file(s) clean` +
    (parked > 0
      ? ` (${parked} owned-literal check(s) parked — see TODO(integrator))`
      : '') +
    (pendingBindings > 0
      ? ` (${pendingBindings} [test] binding(s) pending — see PENDING_TEST_CLAIMS ` +
        'and PENDING_CC_BINDINGS)'
      : ''),
);
