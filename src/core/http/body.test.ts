// The download sink (D531, TSN-14): with a declared length a download is held
// ONCE — one buffer allocated up front, the chunk in flight on top — instead of
// as chunks plus their joined copy. The declared length is only a hint: a body
// that runs past it or stops short must still come back byte-exact.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ATTACHMENT_BYTES } from '../http-util.js';
import { createByteSink, declaredLength } from './body.js';

function bytes(from: number, count: number): Uint8Array {
  return Uint8Array.from({ length: count }, (_, i) => (from + i) % 256);
}

test('CC-5264: a declared length is preallocated, so the sink never holds more than the file', () => {
  const size = 64 * 1024;
  const chunk = 4 * 1024;
  const sink = createByteSink(size);
  let peak = 0;
  for (let offset = 0; offset < size; offset += chunk) {
    sink.push(bytes(offset, chunk));
    // Peak = what the sink holds + the one chunk the stream just handed over.
    peak = Math.max(peak, sink.held + chunk);
  }
  const out = sink.finish();

  assert.equal(peak, size + chunk, 'peak is 1x the file plus one chunk');
  assert.equal(out.byteLength, size);
  assert.equal(
    out.buffer.byteLength,
    size,
    'finish returns the buffer itself, not a copy',
  );
  assert.deepEqual(out.subarray(0, 4), bytes(0, 4));
  assert.deepEqual(out.subarray(size - 4), bytes(size - 4, 4));
});

test('CC-5265: a body that outruns its declared length falls back to chunks, byte-exact', () => {
  const sink = createByteSink(4);
  sink.push(bytes(0, 3));
  sink.push(bytes(3, 3));
  sink.push(bytes(6, 2));

  assert.deepEqual(sink.finish(), bytes(0, 8));
});

test('CC-5266: a body shorter than declared comes back as the prefix it filled', () => {
  const sink = createByteSink(10);
  sink.push(bytes(0, 3));

  assert.deepEqual(sink.finish(), bytes(0, 3));
});

test('CC-5267: without a declared length the chunks are joined at the end', () => {
  const sink = createByteSink(undefined);
  sink.push(bytes(0, 2));
  sink.push(bytes(2, 2));
  assert.equal(sink.held, 4);
  assert.deepEqual(sink.finish(), bytes(0, 4));
  assert.deepEqual(createByteSink(undefined).finish(), new Uint8Array(0));
});

test('CC-5268: only a plain integer within the cap is a usable declared length', () => {
  assert.equal(declaredLength('1234'), 1234);
  assert.equal(declaredLength(' 0 '), 0);
  assert.equal(declaredLength(String(MAX_ATTACHMENT_BYTES)), MAX_ATTACHMENT_BYTES);
  for (const header of [
    null,
    '',
    '-1',
    '1e6',
    '12, 12',
    '0x10',
    String(MAX_ATTACHMENT_BYTES + 1),
    '99999999999999999999',
  ]) {
    assert.equal(declaredLength(header), undefined, String(header));
  }
});
