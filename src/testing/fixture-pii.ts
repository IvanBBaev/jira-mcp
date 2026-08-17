// Fixture PII detector — the mechanical half of TESTING.md §Fixtures'
// "Fixture PII lint" [test].
//
// The record script redacts on the way in; this detects on the way out. They are
// deliberately two implementations of the same vocabulary: redaction is a code
// path that can regress silently, and a fixture is committed forever, so the
// thing that actually fails the build has to be able to disagree with the thing
// that produced the file.
//
// This module is the shared code path for BOTH halves of the lint suite: the
// walk over the real `test/fixtures/**` corpus, and the adversarial sample
// table. A lint proven only against an empty directory proves nothing, so the
// samples run through exactly these functions — not a second, friendlier copy.
//
// What it looks for, per TESTING.md:
//
//  - an email-shaped string that is not `user-N@example.invalid`
//  - an accountId (either Jira format) outside the placeholder patterns
//  - an `*.atlassian.net` host that is not `example.atlassian.net`
//  - a credential-bearing header **KEY** — never a substring (see below)
//  - a JWT-shaped token, or an Atlassian API-token prefix (`ATATT`/`ATCTT`/`ATBB`)
//
// **Keys, never substrings.** `scripts/record-fixture.mjs` drops credential
// headers outright and leaves behind a `headersDropped: ["authorization"]` list
// naming what it removed, so the removal is visible to a reviewer. That list is
// evidence, not a finding: a lint that grepped for the substring `authorization`
// would fail every fixture the recorder has ever produced. So the credential
// rule fires on an object KEY whose lowercased form is a known credential
// header, and on nothing else.
//
// What it cannot do: a real human display name ("Maria Petrova") has no shape,
// so no detector will ever catch it. Free-text prose — summaries, comment
// bodies, project names — carries that residual risk to the human reviewer.

import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  FIXTURES_DIR,
  listFixtureFiles,
  readFixtureJson,
} from '../core/fakes/fixtures.js';

/** The rule that produced a finding. */
export type PiiRule =
  'email' | 'account-id' | 'site-host' | 'credential-key' | 'jwt' | 'atlassian-token';

/** One residue of a real tenant, located precisely enough to fix. */
export interface PiiFinding {
  /** Which rule fired. */
  readonly rule: PiiRule;
  /** JSON path into the document, e.g. `$.exchanges[0].response.body.self`. */
  readonly path: string;
  /** Whether the residue was in a value or in an object key. */
  readonly where: 'value' | 'key';
  /** The offending text, truncated — CI logs are not a good place for secrets. */
  readonly evidence: string;
  /** Human-readable one-liner, path included. */
  readonly message: string;
}

/**
 * The placeholder vocabulary the recorder writes and the lint allows
 * (TESTING.md §Fixtures). Adding a form here is a deliberate act: it widens what
 * the lint accepts, and the doc sentence has to move with it.
 */
export const FIXTURE_PLACEHOLDERS = {
  /** The only `.atlassian.net` host a fixture may name. */
  site: 'example.atlassian.net',
  /** 24-hex accountId, `5b10a2844c20165700ede2NN`. */
  accountId: (n: number): string =>
    `5b10a2844c20165700ede2${String(n % 100).padStart(2, '0')}`,
  /** Opaque `nnnnnn:uuid` accountId, `557058:00000000-…-0000000000NN`. */
  opaqueAccountId: (n: number): string =>
    `557058:00000000-0000-0000-0000-0000000000${String(n % 100).padStart(2, '0')}`,
  /** `user-N@example.invalid`. */
  email: (n: number): string => `user-${String(n)}@example.invalid`,
  /** `User N`. */
  displayName: (n: number): string => `User ${String(n)}`,
} as const;

// --- vocabulary ------------------------------------------------------------
// Kept in step with scripts/record-fixture.mjs by hand. They are separate on
// purpose (see the header): a shared constant would let one bug hide the other.

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PLACEHOLDER_EMAIL_RE = /^user-\d+@example\.invalid$/;

const ACCOUNT_RE =
  /\b[0-9a-f]{24}\b|\b\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PLACEHOLDER_ACCOUNT_RE =
  /^(?:5b10a2844c20165700ede2[0-9a-f]{2}|\d{6}:0{8}-0{4}-0{4}-0{4}-0{10}\d{2})$/;

const SITE_HOST_RE = /\b([a-z0-9][a-z0-9-]*)\.atlassian\.net\b/gi;
const PLACEHOLDER_SITE_LABEL = 'example';

const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const ATLASSIAN_TOKEN_RE = /\b(?:ATATT|ATCTT|ATBB)[A-Za-z0-9_\-=.+/]{16,}/g;

/**
 * Header/field names that carry a credential. A fixture may never contain one of
 * these as an object KEY — the recorder drops them and records the name in
 * `headersDropped`, which is a plain string array and therefore untouched by
 * this rule.
 */
export const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-atlassian-token-auth',
  'apitoken',
  'api_token',
  'password',
]);

const MAX_EVIDENCE = 20;

function truncate(text: string): string {
  return text.length <= MAX_EVIDENCE ? text : `${text.slice(0, MAX_EVIDENCE)}…`;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(base: string, key: string): string {
  return IDENTIFIER_RE.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function finding(
  rule: PiiRule,
  path: string,
  where: 'value' | 'key',
  raw: string,
  detail: string,
): PiiFinding {
  const evidence = truncate(raw);
  return {
    rule,
    path,
    where,
    evidence,
    message: `${path}: ${detail} (${where}: ${JSON.stringify(evidence)}) [${rule}]`,
  };
}

/**
 * Scan one string — a value, or an object key — for every residue class.
 * Exported so the adversarial table can address a single rule without wrapping
 * it in a document first.
 */
export function scanString(
  text: string,
  path: string,
  where: 'value' | 'key' = 'value',
): PiiFinding[] {
  const out: PiiFinding[] = [];

  for (const match of text.matchAll(EMAIL_RE)) {
    if (!PLACEHOLDER_EMAIL_RE.test(match[0])) {
      out.push(
        finding(
          'email',
          path,
          where,
          match[0],
          `email-shaped string outside the placeholder vocabulary (${FIXTURE_PLACEHOLDERS.email(
            1,
          )})`,
        ),
      );
    }
  }

  for (const match of text.matchAll(ACCOUNT_RE)) {
    if (!PLACEHOLDER_ACCOUNT_RE.test(match[0])) {
      out.push(
        finding(
          'account-id',
          path,
          where,
          match[0],
          'accountId outside the placeholder patterns ' +
            `(${FIXTURE_PLACEHOLDERS.accountId(1)} / ${FIXTURE_PLACEHOLDERS.opaqueAccountId(1)})`,
        ),
      );
    }
  }

  for (const match of text.matchAll(SITE_HOST_RE)) {
    const label = match[1];
    if (label !== undefined && label.toLowerCase() !== PLACEHOLDER_SITE_LABEL) {
      out.push(
        finding(
          'site-host',
          path,
          where,
          match[0],
          `real site hostname; fixtures name only ${FIXTURE_PLACEHOLDERS.site}`,
        ),
      );
    }
  }

  for (const match of text.matchAll(JWT_RE)) {
    out.push(finding('jwt', path, where, match[0], 'JWT-shaped token'));
  }

  for (const match of text.matchAll(ATLASSIAN_TOKEN_RE)) {
    out.push(
      finding('atlassian-token', path, where, match[0], 'Atlassian API token prefix'),
    );
  }

  return out;
}

/**
 * Walk a parsed fixture document and report every finding.
 *
 * Object keys are scanned twice, for two different reasons: as a credential
 * header name (exact match, never a substring), and as a string that may itself
 * carry PII — a body keyed by accountId leaks exactly as much as one that stores
 * it in a value.
 */
export function scanFixtureValue(value: unknown, rootPath = '$'): PiiFinding[] {
  const out: PiiFinding[] = [];

  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      out.push(...scanString(node, path, 'value'));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, `${path}[${String(index)}]`);
      });
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const here = childPath(path, key);
        if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
          out.push(
            finding(
              'credential-key',
              here,
              'key',
              key,
              'credential-bearing key; the recorder drops these and names them in ' +
                'headersDropped instead',
            ),
          );
        }
        out.push(...scanString(key, here, 'key'));
        visit(child, here);
      }
    }
    // numbers, booleans, null: nothing string-shaped to inspect.
  };

  visit(value, rootPath);
  return out;
}

/** One file's result from {@link scanFixtureDir}. */
export interface FixtureScan {
  /** Corpus-relative, `/`-separated. */
  readonly file: string;
  /** Absolute path, for an error message a human can paste. */
  readonly absolutePath: string;
  /** The parsed document, so a caller can assert on its envelope too. */
  readonly document: unknown;
  readonly findings: readonly PiiFinding[];
}

/**
 * Scan every `*.json` under `dir` (default: the repo's `test/fixtures/`).
 * Returns one entry per file, clean files included — the caller decides what an
 * empty corpus means.
 */
export function scanFixtureDir(dir: string = FIXTURES_DIR): FixtureScan[] {
  return listFixtureFiles(dir).map((file) => {
    const absolutePath = join(dir, ...file.split('/'));
    const document = readFixtureJson(absolutePath);
    return { file, absolutePath, document, findings: scanFixtureValue(document) };
  });
}

/** Render scans as a failure message: one line per finding, file-prefixed. */
export function formatScans(scans: readonly FixtureScan[]): string {
  return scans
    .flatMap((scan) => scan.findings.map((f) => `${scan.file} ${f.message}`))
    .join('\n');
}

/**
 * Non-JSON files sitting in the corpus. The walk only reads `*.json`, so a
 * stray `.har`, `.txt` or editor backup would be invisible to the lint while
 * being just as committed-forever as everything else.
 *
 * Dotfiles are skipped: `.DS_Store` and friends are the operating system's
 * litter, not a fixture, and they are not committed.
 */
export function listNonJsonFiles(dir: string = FIXTURES_DIR): string[] {
  const out: string[] = [];
  const walk = (absolute: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child, rel);
      else if (!entry.name.endsWith('.json')) out.push(rel);
    }
  };
  if (safeIsDirectory(dir)) walk(dir, '');
  return out.sort();
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
