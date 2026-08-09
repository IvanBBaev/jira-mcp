// Barrel for the wire-tier test helpers.
//
// `./network-fence.js` is deliberately NOT re-exported: importing it installs a
// throwing global `fetch` and strips `JIRA_*` from the environment as import
// side effects. It is loaded once, explicitly, by the test runner
// (`node --import ./build/testing/network-fence.js`); a test that wants its
// exports imports that module by path, so the side effect is always visible at
// the import site.
//
// Excluded from the published tarball and from coverage (TESTING.md §Coverage).

export type {
  FetchMatcher,
  FetchMock,
  RecordedRequest,
  ResponseSpec,
} from './with-fetch.js';
export { withFetch } from './with-fetch.js';

export type { EnvOverrides } from './with-env.js';
export { withEnv } from './with-env.js';
