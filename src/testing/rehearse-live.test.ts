// Suite for the Cloud rehearsal's own verdict (`scripts/rehearse-live.mjs`).
//
// The rehearsal itself — the built server over real stdio MCP against the
// fake, pass by pass — is slow and stays OUTSIDE `npm run check` (TESTING.md
// "Rehearsing the live gate"). What is pinned here is what keeps its green
// honest: it must never report a pass nobody ran.
//
// Every arm below has to stop before the first pass starts, so the child is
// spawned with a short timeout: an arm that reached a pass would be killed,
// and the test fails on the exit code rather than hanging the suite.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

const REHEARSAL_PATH = join(REPO_ROOT, 'scripts', 'rehearse-live.mjs');

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
