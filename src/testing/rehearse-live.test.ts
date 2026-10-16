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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
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
  readonly auditRecording: (
    dir: string | undefined,
    accountIds: readonly string[],
  ) => Promise<string[]>;
  readonly spawnDriver: (
    args: readonly string[],
    env: Record<string, string>,
    verbose: boolean,
    timeoutMs?: number,
  ) => Promise<{ exitCode: number | string; stdout: string; stderr: string }>;
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

// The driver, stood in for by a one-line node program.
const driver = (
  code: string,
  timeoutMs?: number,
): Promise<{ exitCode: number | string; stdout: string }> =>
  rehearsal.spawnDriver(
    ['-e', code],
    { PATH: process.env['PATH'] ?? '' },
    false,
    timeoutMs,
  );

test('CC-1105: a driver that never exits fails its pass instead of crashing the rehearsal', async () => {
  // It used to reject, and main() turned that into exit 2 — "set-up error" —
  // with every later pass unrun.
  const run = await driver(
    "process.stdout.write('partial'); setInterval(() => {}, 1000);",
    300,
  );
  assert.equal(run.exitCode, 'none (killed after 300 ms)');
  assert.equal(run.stdout, 'partial');
});

test('CC-1105: a driver killed by a signal has no exit code, not EXIT_FAILURE', async () => {
  // `code ?? 1` once read this as exit 1 — the code pass D expects.
  const run = await driver("process.kill(process.pid, 'SIGKILL');");
  assert.equal(run.exitCode, 'none (killed by SIGKILL)');
  // The control: a real exit code still comes through as a number.
  assert.equal((await driver('process.exit(3);')).exitCode, 3);
});

test('CC-1106: the recording audit catches a percent-encoded or Basic-encoded secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rehearse-live-audit-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const accountId = '712020:aaaaaaaa-0000-4000-8000-000000000001';
  const basic = Buffer.from(
    'rehearsal@example.invalid:rehearsal-token-not-a-real-secret',
  ).toString('base64');
  writeFileSync(
    join(dir, 'leaky.json'),
    JSON.stringify({
      url: `/rest/api/3/user/search?query=rehearsal%40example.invalid&accountId=${encodeURIComponent(accountId)}`,
      headers: { authorization: `Basic ${basic}` },
    }),
  );
  writeFileSync(join(dir, 'clean.json'), JSON.stringify({ url: '/rest/api/3/myself' }));
  assert.deepEqual((await rehearsal.auditRecording(dir, [accountId])).sort(), [
    `leaky.json leaks accountId #1 (${accountId})`,
    'leaky.json leaks the Basic credential',
    'leaky.json leaks the account email',
  ]);
});
