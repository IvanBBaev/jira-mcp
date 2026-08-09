import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeRedactor, FAKE_PLACEHOLDER } from './fakeRedactor.js';

test('registered secrets are replaced, not passed through', () => {
  const redactor = createFakeRedactor(['s3cr3t-token']);
  const out = redactor.redactString('Authorization: Basic s3cr3t-token');
  assert.equal(out, `Authorization: Basic ${FAKE_PLACEHOLDER}`);
  assert.ok(!out.includes('s3cr3t-token'));
});

test('redaction reaches every depth of a structure', () => {
  const redactor = createFakeRedactor(['tok']);
  const out = redactor.redact({
    headers: { authorization: 'Basic tok' },
    list: ['a tok here', { deep: 'tok' }],
    count: 3,
    nothing: null,
  });

  assert.deepEqual(out, {
    headers: { authorization: `Basic ${FAKE_PLACEHOLDER}` },
    list: [`a ${FAKE_PLACEHOLDER} here`, { deep: FAKE_PLACEHOLDER }],
    count: 3,
    nothing: null,
  });
});

test('every occurrence is replaced, not just the first', () => {
  const redactor = createFakeRedactor(['x1']);
  assert.equal(redactor.redactString('x1 x1'), `${FAKE_PLACEHOLDER} ${FAKE_PLACEHOLDER}`);
});

test('a secret containing regex metacharacters is matched literally', () => {
  const redactor = createFakeRedactor(['a+b.c(d)']);
  assert.equal(redactor.redactString('token=a+b.c(d)!'), `token=${FAKE_PLACEHOLDER}!`);
  // The pattern must not be interpreted: `a+b.c(d)` as a regex would match `aab…`.
  assert.equal(redactor.redactString('aabXcd'), 'aabXcd');
});

test('calls are recorded so a test can assert the choke point was used', () => {
  const redactor = createFakeRedactor(['tok']);
  redactor.redact({ a: 'tok' });
  redactor.redactString('tok');

  assert.deepEqual(redactor.calls, [{ a: 'tok' }]);
  assert.deepEqual(redactor.stringCalls, ['tok']);

  redactor.clear();
  assert.equal(redactor.calls.length, 0);
  assert.equal(redactor.stringCalls.length, 0);
  // clear() drops recordings, not registrations.
  assert.deepEqual(redactor.secrets, ['tok']);
});

test('addSecret registers late secrets, deduplicates and ignores empty', () => {
  const redactor = createFakeRedactor();
  redactor.addSecret('later');
  redactor.addSecret('later');
  redactor.addSecret('');

  assert.deepEqual(redactor.secrets, ['later']);
  assert.equal(redactor.redactString('a later b'), `a ${FAKE_PLACEHOLDER} b`);
  // An empty secret would match between every character and blank the output.
  assert.equal(redactor.redactString('untouched'), 'untouched');
});

test('the placeholder is configurable', () => {
  const redactor = createFakeRedactor(['tok'], '***');
  assert.equal(redactor.redactString('tok'), '***');
});
