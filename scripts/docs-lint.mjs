#!/usr/bin/env node
/**
 * docs-lint — mechanical enforcement of the rules docs/README.md states in prose.
 *
 * Four checks:
 *   1. link      — every relative markdown link inside docs/** resolves, and a
 *                  `#anchor` names a heading that actually exists in the target.
 *   2. banner    — every spec doc carries a `> Status:` banner in its first lines.
 *   3. owned     — a literal owned by one document appears in that document and
 *                  nowhere else (the single-writer rule of the fact-ownership
 *                  table in docs/README.md).
 *   4. cc-ref    — every `CC-nn` reference resolves to an id defined in
 *                  docs/CORNER-CASES.md.
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

/** Docs exempt from the `> Status:` banner check. Empty by design — keep it so. */
const BANNER_EXEMPT = new Set();

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

const findings = [];

function report(file, line, message) {
  findings.push(`${relative(REPO_ROOT, file)}:${line}: ${message}`);
}

function listMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
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
  if (BANNER_EXEMPT.has(relative(DOCS_DIR, file))) return;
  const head = text.split('\n', 10);
  if (!head.some((l) => /^>\s*Status:/.test(l))) {
    report(file, 1, 'missing `> Status:` banner in the first 10 lines');
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

function checkCornerCaseRefs(files) {
  const cornerCases = join(DOCS_DIR, 'CORNER-CASES.md');
  const defined = new Set(
    [...readFileSync(cornerCases, 'utf8').matchAll(CC_DEF_RE)].map((m) => m[1]),
  );
  if (defined.size === 0) {
    report(
      cornerCases,
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
}
checkOwnedLiterals(files);
checkCornerCaseRefs(files);

const parked = OWNED_LITERALS.filter((r) => r.enabled === false).length;

if (findings.length > 0) {
  for (const f of findings) console.error(f);
  console.error(`\ndocs-lint: ${findings.length} finding(s)`);
  process.exit(1);
}

console.error(
  `docs-lint: ${files.length} file(s) clean` +
    (parked > 0
      ? ` (${parked} owned-literal check(s) parked — see TODO(integrator))`
      : ''),
);
