// Suite for the README demo recorder (V3-72): the pure helpers inside
// `scripts/record-demo.mjs`.
//
// The recording itself is not run here: it spawns the built server against
// `scripts/fake-jira.mjs`, which is a whole-system run like the rehearsals.
// What is pinned is the part that keeps the recording honest — `checkDemo`
// refuses to render a run in which a beat did not do what the transcript
// says — and the determinism of the asciicast. The script is reached with a
// dynamic `import()` of a `file:` URL, for the reasons
// `./record-fixture.test.ts` gives; it only records when it is the entry
// point, so importing it here does nothing.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

interface Line {
  readonly kind: string;
  readonly text: string;
}
interface Request {
  readonly method: string;
  readonly path: string;
}
interface Run {
  transitionPlan: unknown;
  worklogPlan: unknown;
  refusal: unknown;
  transitionApply: unknown;
  worklogApply: unknown;
  reread: unknown;
  requestsBeforeApply: readonly Request[];
  requests: readonly Request[];
}

interface DemoModule {
  readonly ISSUE: string;
  readonly FOREIGN_ISSUE: string;
  readonly DEMO_ENV: Readonly<Record<string, string>>;
  checkDemo(run: Run): string[];
  renderTranscript(run: Run): Line[];
  formatLines(
    lines: readonly Line[],
    options?: { width?: number; color?: boolean },
  ): string[];
  toAsciicast(
    lines: readonly Line[],
    options?: { width?: number; height?: number },
  ): string;
  wrap(text: string, width: number): string[];
  shortPlanId(id: unknown): string;
}

const SCRIPT_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'record-demo.mjs')).href;
const demo = (await import(SCRIPT_URL)) as DemoModule;

const plan = (id: string, diff: unknown[] = []) => ({
  structuredContent: {
    ok: true,
    data: {
      executed: false,
      plan_id: id,
      planned: { method: 'POST', path: `/issue/${demo.ISSUE}/transitions` },
      diff,
    },
  },
});
const applied = () => ({ structuredContent: { ok: true, data: { executed: true } } });

function goodRun(): Run {
  return {
    transitionPlan: plan('plan_aaaaaaaaaaaaaaaaaaaa', [
      { field: 'status', from: 'In Progress', to: 'Done' },
    ]),
    worklogPlan: plan('plan_bbbbbbbbbbbbbbbbbbbb'),
    refusal: {
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          kind: 'permission',
          message: 'outside the project scope. Nothing was sent to Jira.',
        },
      },
    },
    transitionApply: applied(),
    worklogApply: applied(),
    reread: {
      structuredContent: { ok: true, data: { fields: { status: { name: 'Done' } } } },
    },
    requestsBeforeApply: [
      { method: 'GET', path: `/rest/api/3/issue/${demo.ISSUE}/transitions` },
    ],
    requests: [
      { method: 'GET', path: `/rest/api/3/issue/${demo.ISSUE}/transitions` },
      { method: 'POST', path: `/rest/api/3/issue/${demo.ISSUE}/transitions` },
    ],
  };
}

describe('record-demo checkDemo', () => {
  test('a run that does what the transcript says passes', () => {
    assert.deepEqual(demo.checkDemo(goodRun()), []);
  });

  test('the demo runs scoped with writes armed', () => {
    assert.equal(demo.DEMO_ENV['JIRA_PROJECTS'], demo.ISSUE.split('-')[0]);
    assert.equal(demo.DEMO_ENV['JIRA_WRITE_MODE'], 'apply');
  });

  test('a plan that executed is a failure', () => {
    const run = goodRun();
    run.transitionPlan = applied();
    assert.match(
      demo.checkDemo(run).join('\n'),
      /transition plan: expected an unexecuted plan/,
    );
  });

  test('a write before the apply is a failure', () => {
    const run = goodRun();
    run.requestsBeforeApply = [
      { method: 'POST', path: `/rest/api/3/issue/${demo.ISSUE}/worklog` },
    ];
    assert.match(demo.checkDemo(run).join('\n'), /a write reached Jira before the apply/);
  });

  test('a refusal of another kind, or none, is a failure', () => {
    const run = goodRun();
    run.refusal = { structuredContent: { ok: true, data: {} } };
    assert.match(demo.checkDemo(run).join('\n'), /expected a permission refusal/);
  });

  test('any request naming the foreign issue is a failure, even a read', () => {
    const run = goodRun();
    run.requests = [
      ...run.requests,
      { method: 'GET', path: `/rest/api/3/issue/${demo.FOREIGN_ISSUE}` },
    ];
    assert.match(demo.checkDemo(run).join('\n'), /the out-of-scope call reached Jira/);
  });

  test('an apply that did not execute, or a re-read not in Done, is a failure', () => {
    const run = goodRun();
    run.worklogApply = plan('plan_cccc');
    run.reread = {
      structuredContent: {
        ok: true,
        data: { fields: { status: { name: 'In Progress' } } },
      },
    };
    const failures = demo.checkDemo(run).join('\n');
    assert.match(failures, /worklog apply: expected an executed write/);
    assert.match(failures, /re-read: expected status Done, got "In Progress"/);
  });
});

describe('record-demo transcript', () => {
  test('every claim on screen comes from the run', () => {
    const text = demo
      .renderTranscript(goodRun())
      .map((l) => l.text)
      .join('\n');
    assert.match(text, /status In Progress → Done/);
    assert.match(text, /plan_id plan_aaaaaaaaaa…/);
    assert.match(text, /refused \(permission\)/);
    assert.match(text, /Nothing was sent to Jira/);
    assert.match(text, /status Done$/m);
  });

  test('wrap keeps rows within the width with a hanging indent', () => {
    const rows = demo.wrap('alpha beta gamma delta epsilon', 12);
    assert.ok(rows.every((r) => r.length <= 12));
    assert.ok(rows.slice(1).every((r) => r.startsWith('  ')));
    assert.deepEqual(demo.wrap('short', 12), ['short']);
  });

  test('formatLines colours only when asked', () => {
    const lines = [{ kind: 'you', text: 'hi' }];
    assert.deepEqual(demo.formatLines(lines), ['you › hi']);
    assert.ok((demo.formatLines(lines, { color: true })[0] ?? '').startsWith('\u001b['));
  });

  test('shortPlanId shortens long ids and passes short ones through', () => {
    assert.equal(demo.shortPlanId('plan_0123456789abcdef'), 'plan_0123456789…');
    assert.equal(demo.shortPlanId('plan_1'), 'plan_1');
  });
});

describe('record-demo asciicast', () => {
  test('is a valid v2 file and identical for identical transcripts', () => {
    const lines = demo.renderTranscript(goodRun());
    const cast = demo.toAsciicast(lines, { width: 80, height: 24 });
    assert.equal(cast, demo.toAsciicast(lines, { width: 80, height: 24 }));
    const [header, ...events] = cast
      .trimEnd()
      .split('\n')
      .map((row) => JSON.parse(row) as unknown);
    assert.deepEqual(
      { ...(header as Record<string, unknown>), env: undefined },
      { version: 2, width: 80, height: 24, title: 'jira-mcp-ai demo', env: undefined },
    );
    const times = events.map((e) => (e as [number, string, string])[0]);
    assert.ok(
      times.every((t, i) => i === 0 || t >= (times[i - 1] ?? 0)),
      'timestamps never go back',
    );
    assert.ok(events.every((e) => (e as unknown[])[1] === 'o'));
  });
});
