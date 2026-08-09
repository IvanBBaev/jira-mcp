import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSystemRng, systemRng } from './rng.js';

describe('createSystemRng', () => {
  it('returns floats inside the [0, 1) contract', () => {
    const rng = createSystemRng();
    for (let i = 0; i < 1_000; i += 1) {
      const value = rng();
      assert.ok(Number.isFinite(value), `non-finite draw: ${String(value)}`);
      assert.ok(value >= 0 && value < 1, `draw outside [0, 1): ${String(value)}`);
    }
  });

  it('varies between draws', () => {
    const rng = createSystemRng();
    const draws = new Set(Array.from({ length: 50 }, () => rng()));
    // A constant seam would silently disable retry jitter — the one property of
    // this module that matters at runtime (JIRA-API.md §Rate limiting).
    assert.ok(draws.size > 1, 'the rng returned a constant');
  });

  it('exposes a ready-made process-wide rng', () => {
    assert.equal(typeof systemRng, 'function');
    const value = systemRng();
    assert.ok(value >= 0 && value < 1);
  });
});
