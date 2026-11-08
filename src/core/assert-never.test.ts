import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertNever } from './assert-never.js';

test('assertNever throws with the value and what it was', () => {
  assert.throws(() => assertNever('ghost' as never, 'auth mode'), {
    message: 'Unexpected auth mode: ghost',
  });
});

test('assertNever names a generic value by default', () => {
  assert.throws(() => assertNever(7 as never), { message: 'Unexpected value: 7' });
});
