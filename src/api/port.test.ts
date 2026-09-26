// ---------------------------------------------------------------------------
// api/port.test.ts — the Cloud adapter is the existing api ring, by identity
// (D106). If any member were a wrapper, a re-implementation or a stale copy,
// adopting the port would have changed behaviour; identity is what proves it
// did not.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import * as adf from './adf.js';
import * as agile from './agile.js';
import * as attachments from './attachments.js';
import * as bulk from './bulk.js';
import * as collab from './collab.js';
import * as filters from './filters.js';
import * as issues from './issues.js';
import * as meta from './meta.js';
import { CLOUD_API } from './port.js';
import * as search from './search.js';
import * as users from './users.js';

const MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  adf,
  agile,
  attachments,
  bulk,
  collab,
  filters,
  issues,
  meta,
  search,
  users,
};

test('every Cloud adapter member is the api-ring export of the same name', () => {
  const members = Object.entries(CLOUD_API).filter(([name]) => name !== 'deployment');
  assert.equal(members.length, 70);
  for (const [name, value] of members) {
    assert.equal(typeof value, 'function', `${name} is a function`);
    const owners = Object.entries(MODULES).filter(([, mod]) => mod[name] === value);
    assert.equal(
      owners.length,
      1,
      `${name} is exported, by identity, by exactly one module`,
    );
  }
});

test('the Cloud adapter names its deployment and cannot be mutated', () => {
  assert.equal(CLOUD_API.deployment, 'cloud');
  assert.ok(Object.isFrozen(CLOUD_API));
  assert.throws(() => {
    (CLOUD_API as { getIssue: unknown }).getIssue = () => undefined;
  }, TypeError);
});
