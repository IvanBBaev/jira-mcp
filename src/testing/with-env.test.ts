import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withEnv } from './with-env.js';

const ABSENT = 'JIRA_MCP_TEST_ABSENT';
const PRESENT = 'JIRA_MCP_TEST_PRESENT';

test('overrides are visible inside the callback', async () => {
  await withEnv({ [ABSENT]: 'set' }, () => {
    assert.equal(process.env[ABSENT], 'set');
  });
  assert.equal(process.env[ABSENT], undefined);
});

test('a previously absent key is deleted again, not blanked', async () => {
  await withEnv({ [ABSENT]: 'set' }, () => undefined);
  assert.equal(ABSENT in process.env, false);
});

test('a previous value is restored exactly', async () => {
  process.env[PRESENT] = 'original';
  try {
    await withEnv({ [PRESENT]: 'temporary' }, () => {
      assert.equal(process.env[PRESENT], 'temporary');
    });
    assert.equal(process.env[PRESENT], 'original');
  } finally {
    delete process.env[PRESENT];
  }
});

test('undefined deletes the variable for the duration', async () => {
  process.env[PRESENT] = 'original';
  try {
    await withEnv({ [PRESENT]: undefined }, () => {
      assert.equal(PRESENT in process.env, false);
    });
    assert.equal(process.env[PRESENT], 'original');
  } finally {
    delete process.env[PRESENT];
  }
});

test('the environment is restored even when the callback throws', async () => {
  process.env[PRESENT] = 'original';
  try {
    await assert.rejects(
      withEnv({ [PRESENT]: 'temporary' }, () => {
        throw new Error('boom');
      }),
      { message: 'boom' },
    );
    assert.equal(process.env[PRESENT], 'original');
  } finally {
    delete process.env[PRESENT];
  }
});

test('the callback value is returned, async callbacks are awaited', async () => {
  assert.equal(await withEnv({}, () => 7), 7);
  assert.equal(await withEnv({}, () => Promise.resolve('done')), 'done');
});
