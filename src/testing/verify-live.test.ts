// Adversarial suite for the safety helpers inside `scripts/verify-live.mjs` —
// the Gate C driver.
//
// Gate C is the one procedure in this repo that runs against a REAL Atlassian
// tenant with a real token, and it is run once, at the end of a release, by
// somebody who is tired. Three of its decisions are made by pure functions, and
// those three are the ones that can hurt a site:
//
//   - the guard that refuses a destructive run unless the operator names the
//     host (CC-83);
//   - the patterns that decide which issues, versions, sprints and files the
//     gate is allowed to call its own — the input to `--purge` (CC-84);
//   - the residue table, which is the operator's only account of what a run
//     left behind and how to remove it (CC-85).
//
// `scripts/rehearse-live.mjs` exercises all three end to end against the fake,
// but a rehearsal is a slow, whole-system check that nobody runs in a tight
// loop; these are the fast, hostile inputs. The two are complementary: the
// rehearsal proves the wiring, this proves the predicate.
//
// **Why a compiled test may import `scripts/`.** The layering zones in
// `eslint.config.js` (`import-x/no-restricted-paths` plus the string-based
// `no-restricted-imports`) target `./src/core`, `./src/api` and `./src/mcp`.
// `src/testing/**` is not a zone member in either direction, so reaching the
// driver from here weakens nothing and needs no override. The import is a
// dynamic `import()` of a `file:` URL built from the repo root, exactly as
// `./record-fixture.test.ts` reaches the fixture recorder (D75): a `.mjs` file
// outside `rootDir` cannot be a static import without dragging it into the
// TypeScript program, and there is no `.d.ts` for it.
//
// The driver guards its own entry point (`invokedDirectly`), so importing it
// here does NOT start a Gate C run. That guard is load-bearing for this file:
// without it, this import would try to drive a Jira site from inside the unit
// suite, behind the network fence, with no credentials.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

// --- the driver's contract, as this suite understands it -------------------

interface ResidueRow {
  readonly kind: string;
  readonly title: string;
  readonly items: readonly string[];
  readonly removal: 'command' | 'manual' | 'local';
  readonly how: string;
  readonly unavailable: readonly string[];
}

interface DriverModule {
  readonly siteHost: (site: unknown) => string | undefined;
  readonly confirmSiteError: (
    site: unknown,
    confirm: unknown,
    destructive: boolean,
  ) => string | undefined;
  readonly isGateCIssue: (summary: unknown) => boolean;
  readonly isGateCArtifact: (name: unknown) => boolean;
  readonly GATE_C_MEDIA_FILE: RegExp;
  readonly residuePlan: (inventory?: unknown) => readonly ResidueRow[];
  readonly renderResidue: (plan: readonly ResidueRow[]) => string;
}

const DRIVER_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'verify-live.mjs')).href;

// A computed specifier is `any` to TypeScript — asserted, not trusted: every
// property this suite touches is exercised below.
const driver = (await import(DRIVER_URL)) as DriverModule;

/** The summary `writePhase` really writes, with a plausible run id. */
const REAL_SUMMARY = 'gate-c verify-live 45703112 (safe to delete)';

// ---------------------------------------------------------------------------
// CC-83 — a destructive run has to name the site
// ---------------------------------------------------------------------------

test('CC-83: a read-only run is never blocked, however the site is written', () => {
  // The guard exists for writes. A read against the wrong site is embarrassing;
  // making reads need a flag would only teach operators to always pass it.
  for (const site of ['https://scratch.atlassian.net', 'scratch.atlassian.net', '']) {
    assert.equal(driver.confirmSiteError(site, undefined, false), undefined);
  }
});

test('CC-83: a destructive run with no --confirm-site is refused, and the message names the site', () => {
  const message = driver.confirmSiteError(
    'https://scratch.atlassian.net',
    undefined,
    true,
  );
  assert.ok(message !== undefined, 'an unconfirmed destructive run must be refused');
  // The refusal has to be actionable at 2am: it names the host that would have
  // been mutated and the exact flag to add. A bare "missing --confirm-site"
  // invites the operator to guess, and the guess is the accident.
  assert.match(message, /--confirm-site/);
  assert.match(message, /scratch\.atlassian\.net/);
});

test('CC-83: a destructive run confirming a DIFFERENT site is refused and names both hosts', () => {
  const message = driver.confirmSiteError(
    'https://production.atlassian.net',
    'scratch.atlassian.net',
    true,
  );
  assert.ok(message !== undefined, 'a mismatch must be refused');
  assert.match(message, /scratch\.atlassian\.net/);
  assert.match(message, /production\.atlassian\.net/);
});

test('CC-83: the confirmation matches however either side spells the host', () => {
  // The real failure mode is a stale `export JIRA_SITE=…`, not a typo, so the
  // guard must not reject a site the operator named correctly in a different
  // shape — that would train them to work around it. Scheme, trailing slash,
  // case and port are all noise.
  const spellings = [
    'https://scratch.atlassian.net',
    'https://scratch.atlassian.net/',
    'HTTPS://Scratch.Atlassian.NET',
    'scratch.atlassian.net',
    'https://scratch.atlassian.net:443',
  ];
  for (const site of spellings) {
    for (const confirm of spellings) {
      assert.equal(
        driver.confirmSiteError(site, confirm, true),
        undefined,
        `${site} should be confirmed by ${confirm}`,
      );
    }
  }
  // …and a host that merely CONTAINS the confirmed one is still a different
  // site. A substring check here would accept a tenant nobody meant to touch.
  assert.notEqual(
    driver.confirmSiteError(
      'https://scratch.atlassian.net.evil.example',
      'scratch.atlassian.net',
      true,
    ),
    undefined,
  );
});

test('CC-83: an unparseable JIRA_SITE refuses the run instead of comparing nothing', () => {
  for (const site of [undefined, '', '   ', 'https://', 'not a url at all']) {
    assert.notEqual(
      driver.confirmSiteError(site, 'scratch.atlassian.net', true),
      undefined,
      `${String(site)} must not be treated as confirmed`,
    );
  }
  assert.equal(
    driver.siteHost('  https://scratch.atlassian.net/browse/X  '),
    'scratch.atlassian.net',
  );
  assert.equal(driver.siteHost('jira.rehearsal.test:44301'), 'jira.rehearsal.test');
});

// ---------------------------------------------------------------------------
// CC-84 — what the gate is allowed to call its own
// ---------------------------------------------------------------------------

test('CC-84: the issue matcher accepts exactly what the gate writes', () => {
  assert.ok(driver.isGateCIssue(REAL_SUMMARY));
  // Jira round-trips summaries with incidental whitespace often enough that
  // trimming is worth doing; the anchors still apply after the trim.
  assert.ok(driver.isGateCIssue(`  ${REAL_SUMMARY}  `));
});

test('CC-84: the issue matcher refuses everything a human could plausibly have written', () => {
  // This list is the reason the matcher is anchored. Jira's `~` operator, which
  // narrows the residue query on the wire, is a fuzzy WORD match: it would
  // return every one of these for `summary ~ "gate-c verify-live"`. The
  // client-side re-check is what stands between `--purge` and a real issue.
  const notOurs = [
    'Gate C rollout plan',
    'gate-c verify-live',
    'gate-c verify-live 45703112',
    'RE: gate-c verify-live 45703112 (safe to delete)',
    'gate-c verify-live 45703112 (safe to delete) — do not delete',
    'gate-c verify-live abc (safe to delete)',
    'gate-c verify-live 45703112 (SAFE TO DELETE)',
    'gate-c verify-live 457031121234567890 (safe to delete)',
    '',
    undefined,
    null,
    42,
    { summary: REAL_SUMMARY },
    [REAL_SUMMARY],
  ];
  for (const summary of notOurs) {
    assert.equal(
      driver.isGateCIssue(summary),
      false,
      `${JSON.stringify(summary)} is not this gate's issue`,
    );
  }
});

test('CC-84: the artifact matcher covers the version and sprint names and nothing else', () => {
  // Both shapes the driver actually creates: `jira_create_version` uses the bare
  // name, `jira_create_sprint` appends the reassurance.
  assert.ok(driver.isGateCArtifact('gate-c-45703112'));
  assert.ok(driver.isGateCArtifact('gate-c-45703112 (safe to delete)'));
  for (const name of [
    'gate-c',
    'gate-c-release',
    'gate-c-2024-q1',
    'pre-gate-c-45703112',
    'gate-c-45703112-rc1',
    'Gate-C-45703112',
    undefined,
  ]) {
    assert.equal(
      driver.isGateCArtifact(name),
      false,
      `${String(name)} is not this gate's artifact`,
    );
  }
});

test('CC-84: the media matcher only claims files the gate staged itself', () => {
  assert.ok(driver.GATE_C_MEDIA_FILE.test('gate-c-45703112.txt'));
  // A downloaded attachment is named by Jira and may be something the operator
  // wanted. Deleting by this prefix is the only rule that cannot eat it.
  for (const name of [
    'gate-c-45703112.txt.bak',
    'gate-c-45703112.pdf',
    'quarterly-report.txt',
    'gate-c-.txt',
  ]) {
    assert.equal(driver.GATE_C_MEDIA_FILE.test(name), false, `${name} is not ours`);
  }
});

// ---------------------------------------------------------------------------
// CC-85 — the residue table is complete, and honest about what it cannot clear
// ---------------------------------------------------------------------------

test('CC-85: the residue table lists every class even when the site is clean', () => {
  const plan = driver.residuePlan({});
  assert.deepEqual(
    plan.map((row) => row.kind),
    ['issues', 'versions', 'components', 'sprints', 'media'],
  );
  // An empty class still prints. "The site is clean" has to be something the
  // operator READS, not something they infer from an absence.
  const rendered = driver.renderResidue(plan);
  for (const row of plan) {
    assert.ok(rendered.includes(`${row.title}: none`), `${row.kind} vanished when empty`);
  }
});

test('CC-85: every class states how it is removed, and only issues and files are automatic', () => {
  const plan = driver.residuePlan({});
  const removal = Object.fromEntries(plan.map((row) => [row.kind, row.removal]));
  // The honest half: this server ships no version delete and no sprint delete
  // (D73 — the gate does not get to widen the product's write surface), so a
  // `--write` run leaves one of each behind permanently and the table has to
  // say so rather than imply a command exists.
  assert.deepEqual(removal, {
    issues: 'command',
    versions: 'manual',
    components: 'manual',
    sprints: 'manual',
    media: 'local',
  });
  for (const row of plan) {
    assert.notEqual(row.how.trim(), '', `${row.kind} does not say how to remove it`);
    if (row.removal === 'manual') {
      assert.match(row.how, /→/, `${row.kind} does not give a UI path`);
    }
  }
});

test('CC-85: the run that found the residue prints the command that clears it', () => {
  const command =
    'node scripts/verify-live.mjs --project SCRATCH --residue --purge ' +
    '--irreversible --confirm-site scratch.atlassian.net';
  const plan = driver.residuePlan({
    issues: [{ key: 'SCRATCH-42', summary: REAL_SUMMARY }],
    versions: [{ id: '10120', name: 'gate-c-45703112', archived: true }],
    sprints: [{ id: 7, name: 'gate-c-45703112 (safe to delete)', state: 'closed' }],
    mediaFiles: ['gate-c-45703112.txt'],
    purgeCommand: command,
  });
  const rendered = driver.renderResidue(plan);
  // Copy-pasteable, with this run's real project and host in it: a placeholder
  // the operator has to fill in is a step they will get wrong.
  assert.ok(rendered.includes(command), 'the cleanup command is not printed');
  for (const item of [
    'SCRATCH-42',
    'gate-c-45703112',
    'archived',
    'closed',
    'gate-c-45703112.txt',
  ]) {
    assert.ok(rendered.includes(item), `the table does not mention ${item}`);
  }
});

test('CC-85: a class the inventory could not read never renders as clean', () => {
  // The dangerous case is not a messy site, it is a blind one. A token that
  // cannot see sprints, or a site with no Jira Software licence, makes the
  // sprint query fail — and `sprints: none` under a query that never returned
  // is a lie the operator has no way to catch.
  const plan = driver.residuePlan({
    unavailable: [
      { kind: 'sprints', why: 'unsupported' },
      { kind: 'sprints', why: 'board 2: forbidden' },
    ],
  });
  const sprints = plan.find((row) => row.kind === 'sprints');
  assert.deepEqual(sprints?.unavailable, ['unsupported', 'board 2: forbidden']);

  const rendered = driver.renderResidue(plan);
  assert.ok(
    !rendered.includes('sprints: none'),
    'a class nobody read claimed to be clean',
  );
  assert.match(rendered, /sprints: UNKNOWN/);
  // Both reasons survive: "which board refused" is the whole diagnosis.
  assert.match(rendered, /unsupported/);
  assert.match(rendered, /board 2: forbidden/);
  // Classes that WERE read still report honestly in the same table.
  assert.ok(rendered.includes('throwaway issues: none'));

  // A partial read is the third state: what was seen is listed, under a header
  // that refuses to call the list complete.
  const partial = driver.renderResidue(
    driver.residuePlan({
      issues: [{ key: 'SCRATCH-42', summary: REAL_SUMMARY }],
      unavailable: [{ kind: 'issues', why: 'rate_limited on page 3' }],
    }),
  );
  assert.match(partial, /throwaway issues: UNKNOWN/);
  assert.match(partial, /seen so far: 1/);
  assert.ok(partial.includes('SCRATCH-42'));
});
