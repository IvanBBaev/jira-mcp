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
import * as permissions from './permissions.js';
import { DATACENTER_API } from './datacenter.js';
import * as port from './port.js';
import { CLOUD_API, CLOUD_LIMITS } from './port.js';
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
  permissions,
  search,
  users,
};

test('every Cloud adapter member is the api-ring export of the same name', () => {
  const members = Object.entries(CLOUD_API).filter(
    ([name]) => name !== 'deployment' && name !== 'limits',
  );
  assert.equal(members.length, 96);
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

test('D538: the Cloud limits are the api-ring constants, frozen, on both adapters', () => {
  assert.deepEqual(CLOUD_LIMITS, {
    maxPageSize: issues.MAX_PAGE_SIZE,
    maxBulkChangelogResults: issues.MAX_BULK_CHANGELOG_RESULTS,
    maxSearchResults: search.MAX_SEARCH_RESULTS,
    maxUserSearchResults: users.MAX_USER_SEARCH_RESULTS,
    collabPageSize: collab.COLLAB_PAGE_SIZE,
    agilePageSize: agile.DEFAULT_AGILE_PAGE_SIZE,
  });
  assert.ok(Object.isFrozen(CLOUD_LIMITS));
  assert.equal(CLOUD_API.limits, CLOUD_LIMITS);
  // Data Center keeps the Cloud caps until a live host shows otherwise.
  assert.equal(DATACENTER_API.limits, CLOUD_LIMITS);
});

test('D538: every value the port re-exports is the api module export, by identity', () => {
  const own = new Set(['CLOUD_API', 'CLOUD_LIMITS']);
  let reexports = 0;
  for (const [name, value] of Object.entries(port)) {
    if (own.has(name)) continue;
    const owners = Object.entries(MODULES).filter(([, mod]) => mod[name] === value);
    assert.ok(owners.length >= 1, `${name} is re-exported from an api module`);
    reexports += 1;
  }
  assert.ok(reexports >= 30, `found ${String(reexports)} re-exported values`);
});
