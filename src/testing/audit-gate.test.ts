// Suite for the advisory audit gate (D546): the pure helpers inside
// `scripts/audit-gate.mjs` and the committed `audit-allowlist.json`.
//
// The audit itself (`npm run audit:prod`) is not run here: it asks the
// registry, and this suite runs behind the network fence. Every verdict the
// gate can reach is pinned against synthetic `npm audit --json` documents
// instead. The script is reached with a dynamic `import()` of a `file:` URL,
// for the reasons `./record-fixture.test.ts` gives; it only audits when it is
// the entry point, so importing it here does nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

interface Advisory {
  readonly id: string;
  readonly ghsa: string | undefined;
  readonly package: string;
  readonly severity: string;
  readonly title: string;
}

interface AllowlistEntry {
  readonly ghsa: string;
  readonly package: string;
  readonly reason: string;
  readonly expires: string;
}

interface Allowlist {
  readonly entries: readonly AllowlistEntry[];
  readonly problems: readonly string[];
}

interface Verdict {
  readonly failures: readonly string[];
  readonly allowed: readonly string[];
  readonly info: readonly string[];
  readonly stale: readonly string[];
}

interface GateModule {
  readonly BLOCKING_SEVERITIES: readonly string[];
  readonly MAX_EXPIRY_DAYS: number;
  collectAdvisories(report: unknown): Advisory[];
  readAllowlist(doc: unknown, today: string): Allowlist;
  evaluate(advisories: readonly Advisory[], allowlist: Allowlist): Verdict;
}

const SCRIPT_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'audit-gate.mjs')).href;
const gate = (await import(SCRIPT_URL)) as GateModule;

const TODAY = '2026-11-07';
const HIGH = 'GHSA-xxxx-pppp-2222';
const CRITICAL = 'GHSA-cccc-ffff-3333';
const MODERATE = 'GHSA-mmmm-qqqq-4444';

function advisory(ghsa: string, name: string, severity: string, source = 1) {
  return {
    source,
    name,
    dependency: name,
    title: `${severity} issue in ${name}`,
    url: `https://github.com/advisories/${ghsa}`,
    severity,
    range: '<9.9.9',
  };
}

/** An `npm audit --json` (report version 2) document. */
function report(vulnerabilities: Record<string, unknown>) {
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {} } };
}

const SAMPLE = report({
  zod: { name: 'zod', severity: 'high', via: [advisory(HIGH, 'zod', 'high', 101)] },
  // Listed only through zod: the string `via` is not an advisory of its own.
  '@modelcontextprotocol/sdk': {
    name: '@modelcontextprotocol/sdk',
    severity: 'high',
    via: ['zod'],
  },
  'fast-uri': {
    name: 'fast-uri',
    severity: 'critical',
    via: [advisory(CRITICAL, 'fast-uri', 'critical', 102)],
  },
  '@hono/node-server': {
    name: '@hono/node-server',
    severity: 'moderate',
    via: [advisory(MODERATE, '@hono/node-server', 'moderate', 103)],
  },
});

function entry(ghsa: string, expires = '2026-12-01', pkg = 'zod'): AllowlistEntry {
  return { ghsa, package: pkg, reason: 'not reachable; no fix released', expires };
}

describe('collectAdvisories', () => {
  test('one advisory per GHSA id, transitive string entries skipped', () => {
    const found = gate.collectAdvisories(SAMPLE);
    assert.deepEqual(
      found.map((a) => [a.ghsa, a.package, a.severity]),
      [
        [CRITICAL, 'fast-uri', 'critical'],
        [MODERATE, '@hono/node-server', 'moderate'],
        [HIGH, 'zod', 'high'],
      ],
    );
  });

  test('the same advisory reached through two packages is counted once', () => {
    const twice = report({
      a: { name: 'a', severity: 'high', via: [advisory(HIGH, 'zod', 'high')] },
      b: { name: 'b', severity: 'high', via: [advisory(HIGH, 'zod', 'high')] },
    });
    assert.equal(gate.collectAdvisories(twice).length, 1);
  });

  test('a clean report has no advisories', () => {
    assert.deepEqual(gate.collectAdvisories(report({})), []);
  });

  test('an npm error document is not a clean answer', () => {
    assert.throws(
      () =>
        gate.collectAdvisories({
          error: { code: 'ENOTFOUND', summary: 'registry down' },
        }),
      /npm audit failed: registry down/,
    );
    assert.throws(() => gate.collectAdvisories({}), /no "vulnerabilities" object/);
    assert.throws(() => gate.collectAdvisories(null), /no JSON object/);
  });
});

describe('readAllowlist', () => {
  test('a well-formed, unexpired entry is accepted', () => {
    const list = gate.readAllowlist({ advisories: [entry(HIGH)] }, TODAY);
    assert.deepEqual(list.problems, []);
    assert.equal(list.entries.length, 1);
  });

  test('the expiry date is the last day the entry holds', () => {
    assert.deepEqual(
      gate.readAllowlist({ advisories: [entry(HIGH, TODAY)] }, TODAY).problems,
      [],
    );
    const lapsed = gate.readAllowlist({ advisories: [entry(HIGH, '2026-11-06')] }, TODAY);
    assert.equal(lapsed.entries.length, 0);
    assert.match(lapsed.problems[0] ?? '', /expired on 2026-11-06/);
  });

  test(`an entry may not be parked more than ${gate.MAX_EXPIRY_DAYS} days ahead`, () => {
    assert.deepEqual(
      gate.readAllowlist({ advisories: [entry(HIGH, '2027-02-05')] }, TODAY).problems,
      [],
    );
    const far = gate.readAllowlist({ advisories: [entry(HIGH, '2027-02-06')] }, TODAY);
    assert.match(far.problems[0] ?? '', /more than 90 days ahead/);
  });

  test('every field is required and nothing else is allowed', () => {
    const list = gate.readAllowlist(
      {
        advisories: [
          { ghsa: 'CVE-2026-1', package: 'zod', reason: 'x', expires: '2026-12-01' },
          { ghsa: HIGH, package: '', reason: ' ', expires: '2026-02-30' },
          { ...entry(CRITICAL), owner: 'me' },
          'GHSA-xxxx-pppp-2222',
        ],
      },
      TODAY,
    );
    assert.equal(list.entries.length, 0);
    assert.deepEqual(
      list.problems.map((p) => p.replace(/^audit-allowlist\.json /, '')),
      [
        'advisories[0]: "ghsa" must be a GHSA id',
        'advisories[1]: "package" is required; "reason" is required; "expires" must be a YYYY-MM-DD date',
        'advisories[2]: unknown field(s) owner',
        'advisories[3]: not an object',
      ],
    );
  });

  test('a duplicate GHSA id is refused, case-insensitively', () => {
    const list = gate.readAllowlist(
      { advisories: [entry(HIGH), entry(HIGH.toUpperCase())] },
      TODAY,
    );
    assert.equal(list.entries.length, 1);
    assert.match(list.problems[0] ?? '', /listed twice/);
  });

  test('a document without an advisories array is refused', () => {
    assert.match(gate.readAllowlist({}, TODAY).problems[0] ?? '', /"advisories" array/);
  });
});

describe('evaluate', () => {
  const advisories = (): Advisory[] => gate.collectAdvisories(SAMPLE);

  test('the blocking severities are high and critical', () => {
    assert.deepEqual(gate.BLOCKING_SEVERITIES, ['high', 'critical']);
  });

  test('unlisted high and critical advisories fail; moderate is information', () => {
    const verdict = gate.evaluate(
      advisories(),
      gate.readAllowlist({ advisories: [] }, TODAY),
    );
    assert.equal(verdict.failures.length, 2);
    assert.match(
      verdict.failures[0] ?? '',
      new RegExp(`critical ${CRITICAL} in fast-uri`),
    );
    assert.match(
      verdict.failures[1] ?? '',
      new RegExp(`high ${HIGH} in zod.*not on audit-allowlist`),
    );
    assert.equal(verdict.info.length, 1);
    assert.match(verdict.info[0] ?? '', /moderate/);
  });

  test('a one-line allowlist entry unblocks exactly its advisory', () => {
    const verdict = gate.evaluate(
      advisories(),
      gate.readAllowlist({ advisories: [entry(HIGH)] }, TODAY),
    );
    assert.equal(verdict.failures.length, 1);
    assert.match(verdict.failures[0] ?? '', /fast-uri/);
    assert.match(verdict.allowed[0] ?? '', /allowlisted until 2026-12-01: not reachable/);
  });

  test('every blocking advisory allowlisted is a pass', () => {
    const list = gate.readAllowlist(
      { advisories: [entry(HIGH), entry(CRITICAL, '2026-12-01', 'fast-uri')] },
      TODAY,
    );
    const verdict = gate.evaluate(advisories(), list);
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.allowed.length, 2);
  });

  test('an expired entry fails the gate and no longer covers its advisory', () => {
    const verdict = gate.evaluate(
      advisories(),
      gate.readAllowlist({ advisories: [entry(HIGH, '2026-11-01')] }, TODAY),
    );
    assert.equal(verdict.failures.length, 3);
    assert.ok(verdict.failures.some((f) => /expired on 2026-11-01/.test(f)));
    assert.ok(verdict.failures.some((f) => /zod.*not on audit-allowlist/.test(f)));
  });

  test('an expired entry fails even when its advisory is gone', () => {
    const verdict = gate.evaluate(
      [],
      gate.readAllowlist({ advisories: [entry(HIGH, '2026-11-01')] }, TODAY),
    );
    assert.equal(verdict.failures.length, 1);
  });

  test('an entry that matches nothing is a warning, not a failure', () => {
    const verdict = gate.evaluate(
      [],
      gate.readAllowlist({ advisories: [entry(HIGH)] }, TODAY),
    );
    assert.deepEqual(verdict.failures, []);
    assert.match(verdict.stale[0] ?? '', /matches no high\/critical advisory/);
  });

  test('allowlisting a moderate advisory is stale: it never blocked', () => {
    const verdict = gate.evaluate(
      advisories().filter((a) => a.severity === 'moderate'),
      gate.readAllowlist(
        { advisories: [entry(MODERATE, '2026-12-01', '@hono/node-server')] },
        TODAY,
      ),
    );
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.stale.length, 1);
  });
});

describe('audit-allowlist.json', () => {
  const doc = JSON.parse(
    readFileSync(join(REPO_ROOT, 'audit-allowlist.json'), 'utf8'),
  ) as {
    advisories: readonly AllowlistEntry[];
  };

  test('has an advisories array', () => {
    assert.ok(Array.isArray(doc.advisories));
  });

  test('every entry is well-formed on its own last day', () => {
    // Read against each entry's own expiry date, so the check does not depend
    // on the wall clock; expiry against today is the gate's job.
    for (const item of doc.advisories) {
      assert.deepEqual(
        gate.readAllowlist({ advisories: [item] }, item.expires).problems,
        [],
      );
    }
  });
});
