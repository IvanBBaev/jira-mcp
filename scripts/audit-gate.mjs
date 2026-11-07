#!/usr/bin/env node
/**
 * audit-gate — the advisory audit with a reviewed, expiring override (D546).
 *
 * `npm audit --omit=dev --audit-level=high` has no override: an advisory
 * disclosed on release morning, with no fix yet and no reachable code path in
 * this package, still blocks every merge and the publish. This script runs the
 * same audit and reads `audit-allowlist.json` at the repository root, so such an
 * advisory can be unblocked by one reviewed commit that expires on its own.
 *
 * Exit 1 when any of these hold, one finding per line:
 *   - a high or critical advisory whose GHSA id is not on the allowlist;
 *   - an allowlist entry whose `expires` date has passed (the override lapses
 *     and the advisory must be fixed or re-reviewed);
 *   - the allowlist is malformed: every entry needs `ghsa`, `package`, a
 *     non-empty `reason` and an `expires` date no more than MAX_EXPIRY_DAYS
 *     ahead, so no entry can be parked indefinitely.
 * Exit 2 when the audit itself gives no report (registry down, npm error):
 * no answer is not a clean answer.
 *
 * Moderate and low advisories are listed and do not fail, as before. An entry
 * that matches nothing any more is a warning: the fix landed and the line can
 * go, but that is no reason to fail a build.
 *
 * Run standalone (`node scripts/audit-gate.mjs`) or as `npm run audit:prod`,
 * the last step of `npm run check` and the `audit` job in ci.yml. The pure
 * helpers are exported for `src/testing/audit-gate.test.ts`; the audit only
 * runs when this file is the entry point.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_FILE = 'audit-allowlist.json';

/** Severities that fail the gate unless allowlisted. */
export const BLOCKING_SEVERITIES = Object.freeze(['high', 'critical']);

/** The longest an entry may be parked before somebody has to look again. */
export const MAX_EXPIRY_DAYS = 90;

const GHSA_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `https://github.com/advisories/GHSA-xxxx-xxxx-xxxx` → `GHSA-xxxx-xxxx-xxxx`. */
function ghsaOf(url) {
  if (typeof url !== 'string') return undefined;
  const id = url.split('/').pop();
  return id !== undefined && GHSA_RE.test(id) ? id : undefined;
}

/**
 * Every advisory in an `npm audit --json` (report version 2) document, one per
 * GHSA id. A package listed only because it depends on a vulnerable package
 * carries a string in `via`; the advisory itself sits under the package it was
 * filed against, so only the object entries are advisories.
 */
export function collectAdvisories(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('npm audit gave no JSON object');
  }
  if (report.error !== undefined) {
    const error = report.error;
    throw new Error(
      `npm audit failed: ${error?.summary ?? error?.code ?? JSON.stringify(error)}`,
    );
  }
  if (report.vulnerabilities === null || typeof report.vulnerabilities !== 'object') {
    throw new Error('npm audit report has no "vulnerabilities" object');
  }
  const byId = new Map();
  for (const entry of Object.values(report.vulnerabilities)) {
    for (const via of entry?.via ?? []) {
      if (via === null || typeof via !== 'object') continue;
      const ghsa = ghsaOf(via.url);
      const id = ghsa ?? `npm-${String(via.source)}`;
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        ghsa,
        package: String(via.name ?? entry.name),
        severity: String(via.severity ?? entry.severity),
        title: String(via.title ?? ''),
        url: typeof via.url === 'string' ? via.url : undefined,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Whole days from `today` to `date`, both `YYYY-MM-DD` read as UTC. */
function daysBetween(today, date) {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
}

function isRealDate(date) {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Reads the allowlist document. Returns the entries that are well-formed and
 * not expired, plus one problem string per entry that is neither. `expires` is
 * the last day the entry holds: on the day after, it fails the gate.
 */
export function readAllowlist(doc, today) {
  const problems = [];
  const entries = [];
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.advisories)) {
    return {
      entries,
      problems: [`${ALLOWLIST_FILE}: expected an object with an "advisories" array`],
    };
  }
  const seen = new Set();
  doc.advisories.forEach((raw, index) => {
    const at = `${ALLOWLIST_FILE} advisories[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const { ghsa, package: pkg, reason, expires } = raw;
    const unknown = Object.keys(raw).filter(
      (key) => !['ghsa', 'package', 'reason', 'expires'].includes(key),
    );
    const bad = [];
    if (typeof ghsa !== 'string' || !GHSA_RE.test(ghsa))
      bad.push('"ghsa" must be a GHSA id');
    if (typeof pkg !== 'string' || pkg.trim() === '') bad.push('"package" is required');
    if (typeof reason !== 'string' || reason.trim() === '')
      bad.push('"reason" is required');
    if (typeof expires !== 'string' || !isRealDate(expires)) {
      bad.push('"expires" must be a YYYY-MM-DD date');
    } else if (daysBetween(today, expires) > MAX_EXPIRY_DAYS) {
      bad.push(`"expires" ${expires} is more than ${MAX_EXPIRY_DAYS} days ahead`);
    }
    if (unknown.length > 0) bad.push(`unknown field(s) ${unknown.join(', ')}`);
    if (bad.length > 0) {
      problems.push(`${at}: ${bad.join('; ')}`);
      return;
    }
    const key = ghsa.toLowerCase();
    if (seen.has(key)) {
      problems.push(`${at}: ${ghsa} is listed twice`);
      return;
    }
    seen.add(key);
    if (daysBetween(today, expires) < 0) {
      problems.push(
        `${at}: ${ghsa} (${pkg}) expired on ${expires} — fix it or re-review it`,
      );
      return;
    }
    entries.push({ ghsa, package: pkg, reason, expires });
  });
  return { entries, problems };
}

/**
 * The verdict: `failures` fail the gate, `allowed` are blocking advisories the
 * allowlist covers, `info` are the non-blocking ones, `stale` are entries that
 * match no advisory any more.
 */
export function evaluate(advisories, allowlist) {
  const listed = new Map(
    allowlist.entries.map((entry) => [entry.ghsa.toLowerCase(), entry]),
  );
  const used = new Set();
  const failures = [...allowlist.problems];
  const allowed = [];
  const info = [];
  for (const advisory of advisories) {
    const describe = `${advisory.severity} ${advisory.id} in ${advisory.package}: ${advisory.title}`;
    if (!BLOCKING_SEVERITIES.includes(advisory.severity)) {
      info.push(describe);
      continue;
    }
    const entry =
      advisory.ghsa === undefined ? undefined : listed.get(advisory.ghsa.toLowerCase());
    if (entry === undefined) {
      failures.push(`${describe} — not on ${ALLOWLIST_FILE}`);
      continue;
    }
    used.add(entry.ghsa.toLowerCase());
    allowed.push(`${describe} — allowlisted until ${entry.expires}: ${entry.reason}`);
  }
  const stale = allowlist.entries
    .filter((entry) => !used.has(entry.ghsa.toLowerCase()))
    .map(
      (entry) =>
        `${entry.ghsa} (${entry.package}) matches no high/critical advisory — remove it`,
    );
  return { failures, allowed, info, stale };
}

// The rest asks the registry, which the suite behind the network fence never
// reaches; every verdict it prints comes from the helpers above, which are
// covered there. CI's `audit` job is what runs it.
/* c8 ignore start */
function runAudit() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    const detail = (result.stderr || result.stdout || '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ');
    throw new Error(`npm audit gave no JSON report (exit ${result.status}): ${detail}`);
  }
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const doc = JSON.parse(readFileSync(resolve(REPO_ROOT, ALLOWLIST_FILE), 'utf8'));
  const allowlist = readAllowlist(doc, today);
  const advisories = collectAdvisories(runAudit());
  const { failures, allowed, info, stale } = evaluate(advisories, allowlist);
  for (const line of info) console.log(`info     ${line}`);
  for (const line of allowed) console.log(`allowed  ${line}`);
  for (const line of stale) console.log(`warning  ${line}`);
  for (const line of failures) console.log(`FAIL     ${line}`);
  if (failures.length > 0) {
    console.log(`audit-gate: ${failures.length} finding(s); see docs/RELEASING.md §3.2`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `audit-gate: clean — ${advisories.length} advisory(ies), ${allowed.length} allowlisted, ` +
      `${info.length} below high`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(
      `audit-gate: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
/* c8 ignore stop */
