// Suite for the Cloud rehearsal's own verdict (`scripts/rehearse-live.mjs`).
//
// The rehearsal itself — the built server over real stdio MCP against the
// fake, pass by pass — is slow and stays OUTSIDE `npm run check` (TESTING.md
// "Rehearsing the live gate"). What is pinned here is what keeps its green
// honest: it must never report a pass nobody ran, and a pass's check must
// never read a claim that is missing as one that behaved.
//
// The script guards its entry point, so importing it (a dynamic `import()` of
// a `file:` URL, argued in `./verify-live.test.ts`) starts nothing.
//
// Every CLI arm below has to stop before the first pass starts, so the child is
// spawned with a short timeout: an arm that reached a pass would be killed,
// and the test fails on the exit code rather than hanging the suite.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

const REHEARSAL_PATH = join(REPO_ROOT, 'scripts', 'rehearse-live.mjs');

interface Claim {
  readonly id: string;
  readonly status: string;
  readonly note: string;
}

interface CheckInput {
  readonly requests: readonly Record<string, unknown>[];
  readonly claims: readonly Claim[];
  readonly state: { readonly sprints: readonly Record<string, unknown>[] };
  readonly stderr: string;
}

interface RehearsalModule {
  readonly PASSES: readonly {
    readonly id: string;
    readonly check: (input: CheckInput) => string[];
  }[];
}

// Computed specifiers are `any` to TypeScript — asserted, not trusted.
const rehearsal = (await import(pathToFileURL(REHEARSAL_PATH).href)) as RehearsalModule;

function checkOf(id: string): (input: CheckInput) => string[] {
  const pass = rehearsal.PASSES.find((candidate) => candidate.id === id);
  assert.ok(pass !== undefined, `no pass ${id}`);
  return pass.check;
}

const claim = (id: string, status: string, note = ''): Claim => ({ id, status, note });

/** Each pass's input with everything else green, so only the claims decide. */
const GREEN: Record<string, Omit<CheckInput, 'claims'>> = {
  B: {
    requests: [{ onMediaHost: true, hasAuthorization: false }],
    state: { sprints: [] },
    stderr: '',
  },
  C: {
    requests: [
      { method: 'GET', path: '/rest/api/3/myself' },
      { method: 'GET', path: '/rest/api/3/myself' },
      { method: 'GET', path: '/rest/api/3/field' },
      { method: 'GET', path: '/rest/api/3/field' },
    ],
    state: { sprints: [] },
    stderr: '',
  },
  D: {
    requests: [{ method: 'POST', path: '/rest/api/3/issue' }],
    state: { sprints: [] },
    stderr: '',
  },
};

const PRESENT: Record<string, readonly Claim[]> = {
  B: [claim('C13', 'PASS')],
  C: [claim('C03', 'PASS'), claim('C09', 'PASS')],
  D: [claim('C17', 'FAIL', 'the create was refused')],
};

for (const id of ['B', 'C', 'D']) {
  test(`CC-1103: pass ${id} fails when the claim it judges never ran`, () => {
    const input = GREEN[id];
    const present = PRESENT[id];
    assert.ok(input !== undefined && present !== undefined);
    // The control: with the claims there, the check is green.
    assert.deepEqual(checkOf(id)({ ...input, claims: present }), []);
    const failures = checkOf(id)({ ...input, claims: [] });
    for (const row of present) {
      assert.ok(
        failures.includes(`${row.id} did not run`),
        `pass ${id} let a missing ${row.id} through: ${JSON.stringify(failures)}`,
      );
    }
  });
}

test('CC-1103: pass G fails when the refused sprint is not on the fake at all', () => {
  const sprint = (state: string): Record<string, unknown> => ({
    name: 'gate-c-sprint',
    state,
  });
  const input = (sprints: readonly Record<string, unknown>[]): CheckInput => ({
    requests: [
      {
        method: 'POST',
        path: '/rest/agile/1.0/sprint/1',
        body: { state: 'active' },
      },
    ],
    claims: [
      claim('C27', 'PASS'),
      claim('C28', 'PASS'),
      claim('C29', 'SKIP', 'the board already has an active sprint'),
      claim('C30', 'SKIP'),
    ],
    state: { sprints },
    stderr: '',
  });
  assert.deepEqual(checkOf('G')(input([sprint('future')])), []);
  for (const sprints of [[], [sprint('future'), sprint('future')]]) {
    assert.ok(
      checkOf('G')(input(sprints)).includes(
        `expected 1 gate-c sprint on the fake, saw ${String(sprints.length)}`,
      ),
      `pass G let ${String(sprints.length)} sprints through`,
    );
  }
});

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): Promise<CliRun> {
  const coverage = process.env['NODE_V8_COVERAGE'];
  return new Promise<CliRun>((resolve) => {
    const child = execFile(
      process.execPath,
      [REHEARSAL_PATH, ...args],
      {
        cwd: REPO_ROOT,
        env: {
          PATH: process.env['PATH'] ?? '',
          ...(coverage === undefined ? {} : { NODE_V8_COVERAGE: coverage }),
        },
        timeout: 15_000,
        killSignal: 'SIGKILL',
      },
      (_error, stdout, stderr) => {
        resolve({ code: child.exitCode, stdout, stderr });
      },
    );
  });
}

test('CC-1102: an unknown --pass id is refused before any pass runs', async () => {
  const run = await runCli(['--pass', 'A', '--pass', 'Z']);
  // Dropping Z and running A alone would end green for a pass nobody ran.
  assert.equal(run.code, 2, `exit ${String(run.code)}; stderr: ${run.stderr}`);
  assert.match(run.stderr, /no pass named Z \(passes: A B C/u);
  assert.equal(run.stdout, '', 'a pass started before the refusal');
});
