// Barrel for the `core` fakes — the deterministic stand-ins every unit test
// injects instead of the real Clock, Jira client, Redactor, Logger and Journal.
//
// Test-only: production code must never import from `core/fakes/**` (the
// directory is excluded from coverage precisely because it is not shipped
// behaviour). Layer note: these implement `core/types.ts` contracts only, so
// they stay importable from `api`, `mcp` and `tools` tests alike.

export type { FakeClock } from './fakeClock.js';
export { createFakeClock } from './fakeClock.js';

export type {
  FakeJiraRequest,
  FakeJiraRequestOptions,
  FixtureLoader,
  JiraMatcher,
  JiraStubResult,
} from './fakeJiraRequest.js';
export { createFakeJiraRequest, jiraErr, jiraOk, routeOf } from './fakeJiraRequest.js';

export type { FixtureLoaderOptions } from './fixtures.js';
export {
  createFixtureLoader,
  FIXTURES_DIR,
  fixturesDirExists,
  listFixtureFiles,
  readFixtureJson,
  REPO_ROOT,
  repoFixtureLoader,
} from './fixtures.js';

export type { FakeRedactor } from './fakeRedactor.js';
export { createFakeRedactor, FAKE_PLACEHOLDER } from './fakeRedactor.js';

export type { FakeLogger, FakeLoggerOptions } from './fakeLogger.js';
export { createFakeLogger } from './fakeLogger.js';

export type { MemoryJournal } from './memoryJournal.js';
export { createMemoryJournal } from './memoryJournal.js';
