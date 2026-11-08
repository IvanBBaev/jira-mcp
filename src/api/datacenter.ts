// ---------------------------------------------------------------------------
// api/datacenter.ts — compatibility barrel for the Jira Data Center adapter.
//
// The adapter and its endpoint twins live in `src/api/datacenter/` (V3-13,
// D518). This file keeps the old import path working; new code imports from
// `./datacenter/adapter.js`.
// ---------------------------------------------------------------------------

export * from './datacenter/adapter.js';
