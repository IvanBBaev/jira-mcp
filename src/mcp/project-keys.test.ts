import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUD_API } from '../api/port.js';
import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeJiraRequest, jiraErr, jiraOk } from '../core/fakes/fakeJiraRequest.js';
import {
  createProjectKeySource,
  PROJECT_KEYS_BUDGET_MS,
  PROJECT_KEYS_RETRY_MS,
} from './project-keys.js';

const PROJECTS = '/rest/api/3/project/search';

function page(...keys: string[]) {
  return jiraOk({
    startAt: 0,
    maxResults: 50,
    total: keys.length,
    isLast: true,
    values: keys.map((key, i) => ({ id: String(10000 + i), key, name: `${key} name` })),
  });
}

function harness(options: { ttlS?: number; scope?: readonly string[] } = {}) {
  const fake = createFakeJiraRequest();
  const clock = createFakeClock(1_000_000);
  const source = createProjectKeySource({
    api: CLOUD_API,
    jira: fake.fn,
    clock,
    ttlS: options.ttlS ?? 300,
    maxPages: 3,
    scope: options.scope,
  });
  return { fake, clock, source };
}

test('[CC-5390] one read fills the cache; warm completions send nothing', async () => {
  const { fake, clock, source } = harness();
  assert.ok(source);
  fake.on(`GET ${PROJECTS}`, page('ZED', 'ABC', 'ABC'));
  assert.deepEqual(await source(), ['ABC', 'ZED']);
  clock.advance(299_999);
  assert.deepEqual(await source(), ['ABC', 'ZED']);
  assert.equal(fake.calls.length, 1);
  const [request] = fake.calls;
  // Default profile, a budget of its own, the configured page cap.
  assert.equal(request?.profile, undefined);
  assert.equal(request?.deadlineAt, 1_000_000 + PROJECT_KEYS_BUDGET_MS);
});

test('[CC-5391] an expired entry is read again', async () => {
  const { fake, clock, source } = harness({ ttlS: 60 });
  assert.ok(source);
  fake.on(`GET ${PROJECTS}`, page('ABC'), 1).on(`GET ${PROJECTS}`, page('ABC', 'NEW'));
  assert.deepEqual(await source(), ['ABC']);
  clock.advance(60_000);
  assert.deepEqual(await source(), ['ABC', 'NEW']);
  assert.equal(fake.calls.length, 2);
});

test('[CC-5392] completions arriving during a read share it', async () => {
  const { fake, source } = harness();
  assert.ok(source);
  fake.on(`GET ${PROJECTS}`, page('ABC'));
  const all = await Promise.all([source(), source(), source()]);
  assert.deepEqual(all, [['ABC'], ['ABC'], ['ABC']]);
  assert.equal(fake.calls.length, 1);
});

test('[CC-5393] a failed read completes to nothing, is not cached, and backs off', async () => {
  const { fake, clock, source } = harness();
  assert.ok(source);
  fake
    .on(`GET ${PROJECTS}`, jiraErr(new Error('boom')), 1)
    .on(`GET ${PROJECTS}`, page('ABC'));
  assert.deepEqual(await source(), []);
  // Inside the back-off: no request, still nothing.
  clock.advance(PROJECT_KEYS_RETRY_MS - 1);
  assert.deepEqual(await source(), []);
  assert.equal(fake.calls.length, 1);
  // After it: read again, and the success is cached.
  clock.advance(1);
  assert.deepEqual(await source(), ['ABC']);
  assert.equal(fake.calls.length, 2);
});

test('[CC-5394] a read that throws before its first await does not wedge the source', async () => {
  const clock = createFakeClock(0);
  let calls = 0;
  const source = createProjectKeySource({
    api: {
      ...CLOUD_API,
      listProjects: () => {
        calls += 1;
        throw new Error('sync');
      },
    },
    jira: createFakeJiraRequest().fn,
    clock,
    ttlS: 300,
    maxPages: 1,
  });
  assert.ok(source);
  assert.deepEqual(await source(), []);
  clock.advance(PROJECT_KEYS_RETRY_MS);
  assert.deepEqual(await source(), []);
  assert.equal(calls, 2);
});

test('[CC-5395] JIRA_PROJECTS: the scope keys, sorted, with no Jira call', async () => {
  const { fake, source } = harness({ scope: ['ZED', 'ABC', 'ZED'], ttlS: 0 });
  assert.ok(source);
  assert.deepEqual(await source(), ['ABC', 'ZED']);
  assert.equal(fake.calls.length, 0);
});

test('[CC-5396] JIRA_META_CACHE_TTL_S=0 without a scope turns live completions off', () => {
  const { source } = harness({ ttlS: 0 });
  assert.equal(source, undefined);
});
