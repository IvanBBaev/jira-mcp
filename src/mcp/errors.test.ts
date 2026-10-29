import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJiraError } from '../core/errors.js';
import { JIRA_ERROR_KINDS, JiraError, RETRYABLE_ERROR_KINDS } from '../core/types.js';
import {
  UNEXPECTED_THROW_KIND,
  UNEXPECTED_THROW_MESSAGE,
  errorResult,
  errorResultOf,
  isJiraError,
  toErrorRecord,
} from './errors.js';

/** A raw Jira 500 body — the thing that must never reach the model's message. */
const RAW_BODY =
  '<html><title>Atlassian Cloud</title>Set-Cookie: cloud.session.token=eyJhbGciOi</html>';

test('every one of the 13 frozen kinds projects verbatim', () => {
  assert.equal(JIRA_ERROR_KINDS.length, 13);

  for (const kind of JIRA_ERROR_KINDS) {
    const record = toErrorRecord(new JiraError({ kind, message: `${kind} happened` }));
    assert.equal(record.kind, kind);
    assert.equal(record.message, `${kind} happened`);
    assert.equal(
      record.retryable,
      RETRYABLE_ERROR_KINDS.includes(kind),
      `${kind} must inherit retryability from the frozen catalog`,
    );
  }
});

test('remediation, httpStatus, jiraMessages and detail pass through unchanged', () => {
  const record = toErrorRecord(
    new JiraError({
      kind: 'validation',
      message: 'Jira rejected the field update.',
      httpStatus: 400,
      jiraMessages: ['Field "customfield_10011" cannot be set.'],
      remediation: 'Call jira_get_create_meta to see which fields this screen accepts.',
      detail: 'truncated body snippet',
    }),
  );

  assert.deepEqual(record, {
    kind: 'validation',
    message: 'Jira rejected the field update.',
    reason: 'Jira rejected the field update.',
    retryable: false,
    httpStatus: 400,
    jiraMessages: ['Field "customfield_10011" cannot be set.'],
    remediation: 'Call jira_get_create_meta to see which fields this screen accepts.',
    detail: 'truncated body snippet',
  });
});

test('absent members are omitted, never serialized as null', () => {
  const record = toErrorRecord(
    new JiraError({ kind: 'auth', message: '401 from Jira.' }),
  );

  assert.deepEqual(Object.keys(record).sort(), [
    'kind',
    'message',
    'reason',
    'retryable',
  ]);
  assert.equal('httpStatus' in record, false);
  assert.equal('detail' in record, false);
  assert.ok(!JSON.stringify(record).includes('null'));
});

test('remediation stays a separate field and is not folded into the message', () => {
  const error = new JiraError({
    kind: 'write_gated',
    message: 'This write was not performed.',
    remediation: 'Re-run with apply: true and the plan_id from the plan.',
  });
  const record = toErrorRecord(error);

  assert.equal(record.message, 'This write was not performed.');
  assert.equal(
    record.remediation,
    'Re-run with apply: true and the plan_id from the plan.',
  );
});

test('an empty remediation or detail is dropped rather than emitted empty', () => {
  const record = toErrorRecord(
    new JiraError({ kind: 'not_found', message: 'gone', remediation: '', detail: '' }),
  );
  assert.equal('remediation' in record, false);
  assert.equal('detail' in record, false);
});

test('a raw response body never reaches the model-facing message', () => {
  const record = toErrorRecord(
    new JiraError({
      kind: 'unexpected_shape',
      message: 'Jira returned a non-JSON body for this request.',
      httpStatus: 500,
      detail: RAW_BODY.slice(0, 200),
    }),
  );

  assert.ok(!record.message.includes('cloud.session.token'));
  assert.ok(!record.message.includes('<html>'));
  assert.equal(
    record.detail,
    RAW_BODY.slice(0, 200),
    'the snippet stays in its own field',
  );
});

test('a non-JiraError throw becomes unexpected_shape and leaks nothing', () => {
  for (const thrown of [
    new TypeError(RAW_BODY),
    RAW_BODY,
    undefined,
    { message: RAW_BODY },
  ]) {
    const record = toErrorRecord(thrown);
    assert.equal(record.kind, UNEXPECTED_THROW_KIND);
    assert.equal(record.message, UNEXPECTED_THROW_MESSAGE);
    assert.equal(record.retryable, false);
    assert.equal('detail' in record, false, 'a stack trace is not model-facing data');
    assert.ok(!JSON.stringify(record).includes('cloud.session.token'));
  }
});

test('a cross-realm JiraError is recognised structurally, not by prototype', () => {
  const foreign = new Error('Rate limited by Jira.') as Error & {
    kind: string;
    retryable: boolean;
    remediation: string;
  };
  foreign.kind = 'rate_limited';
  foreign.retryable = true;
  foreign.remediation = 'Wait for the Retry-After window.';

  assert.equal(isJiraError(foreign), true);
  const record = toErrorRecord(foreign);
  assert.equal(record.kind, 'rate_limited');
  assert.equal(record.retryable, true);
  assert.equal(record.message, 'Rate limited by Jira.');
});

test('a kind outside the frozen catalog is normalised to unexpected_shape', () => {
  const foreign = new Error('mystery') as Error & { kind: string; retryable: boolean };
  foreign.kind = 'teapot';
  foreign.retryable = false;

  assert.equal(isJiraError(foreign), false, 'an unknown kind is not a JiraError');
  assert.equal(toErrorRecord(foreign).kind, UNEXPECTED_THROW_KIND);
});

test('isJiraError() rejects plain objects and non-errors', () => {
  assert.equal(isJiraError({ kind: 'auth', retryable: false }), false);
  assert.equal(isJiraError('auth'), false);
  assert.equal(isJiraError(null), false);
});

test('errorResult() produces a complete ok:false envelope', () => {
  const envelope = errorResult(
    new JiraError({ kind: 'permission', message: 'You cannot browse PROJ.' }),
  );

  assert.deepEqual(envelope, {
    ok: false,
    error: {
      kind: 'permission',
      message: 'You cannot browse PROJ.',
      reason: 'You cannot browse PROJ.',
      retryable: false,
    },
  });
  assert.equal('data' in envelope, false);
});

test('errorResult() carries the caller’s hints onto the envelope', () => {
  const envelope = errorResult(
    new JiraError({ kind: 'timeout', message: 'Jira timed out.' }),
    {
      hints: [{ code: 'journal_unavailable', message: 'The journal could not be read.' }],
    },
  );

  assert.deepEqual(
    envelope.hints?.map((hint) => hint.code),
    ['journal_unavailable'],
  );
  assert.equal(envelope.error?.retryable, true, 'timeout is retryable per the catalog');
});

test('errorResultOf() builds a local refusal through the same JiraError rules', () => {
  const envelope = errorResultOf('write_gated', 'NOT performed — plan mode.', {
    remediation: 'Re-run with apply: true and the plan_id above.',
  });

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.kind, 'write_gated');
  assert.equal(envelope.error?.retryable, false);
  assert.equal(
    envelope.error?.remediation,
    'Re-run with apply: true and the plan_id above.',
  );

  const retryable = errorResultOf('rate_limited', 'Jira asked us to slow down.');
  assert.equal(retryable.error?.retryable, true, 'retryability comes from the catalog');
});

// ---------------------------------------------------------------------------
// `reason` on every ErrorRecord (D507)
// ---------------------------------------------------------------------------

test('[CC-5040] reason is the cause sentence alone; message keeps cause then remedy', () => {
  const record = toErrorRecord(
    createJiraError({
      kind: 'not_found',
      reason: 'Issue PROJ-1 does not exist, or you cannot see it.',
      remediation: 'Check the key with jira_search.',
    }),
  );

  assert.equal(record.reason, 'Issue PROJ-1 does not exist, or you cannot see it.');
  assert.equal(
    record.message,
    'Issue PROJ-1 does not exist, or you cannot see it. Check the key with jira_search.',
  );
  assert.equal(record.remediation, 'Check the key with jira_search.');
});

test('[CC-5041] an error built without a separate cause reports its message as reason', () => {
  for (const reason of [undefined, '']) {
    const record = toErrorRecord(
      new JiraError({ kind: 'auth', message: '401 from Jira.', reason }),
    );
    assert.equal(record.reason, '401 from Jira.');
  }
});

test('[CC-5042] a non-JiraError throw carries the fixed message as reason', () => {
  const record = toErrorRecord(new TypeError('boom at /secret/path'));

  assert.equal(record.reason, UNEXPECTED_THROW_MESSAGE);
  assert.ok(!JSON.stringify(record).includes('/secret/path'));
});

test('[CC-5043] every envelope built by errorResult and errorResultOf has a reason', () => {
  const fromThrow = errorResult(
    new JiraError({ kind: 'timeout', message: 'Timed out.' }),
  );
  const local = errorResultOf('write_gated', 'Not performed.', {
    remediation: 'Plan first.',
  });

  assert.equal(fromThrow.error?.reason, 'Timed out.');
  assert.equal(local.error?.reason, 'Not performed.');
});
