// Network fence — the hard stop against real network access in tests.
//
// Loaded as `node --import ./build/testing/network-fence.js` (see the `test`
// script), so it runs BEFORE any test module and before anything can cache a
// reference to the real `fetch`. Two jobs, both on import:
//
//  1. Replace global `fetch` with a guard that throws SYNCHRONOUSLY and names
//     the request it refused. A rejected promise would be swallowed by any
//     `catch` in the code under test and the suite would pass while silently
//     hitting the internet; a synchronous throw cannot be mistaken for a
//     modelled upstream failure.
//  2. Strip ambient `JIRA_*` variables (TESTING.md §Principles), so a developer
//     with real credentials in their shell runs the same suite as CI.
//
// Both are skipped when `JIRA_LIVE_TEST=1` — that is the env-gated live read
// suite (TESTING.md suite 9), which by definition needs real credentials and a
// real socket. Nothing else may disable the fence.
//
// This module is deliberately NOT re-exported from `./index.js`: importing the
// barrel must never install a throwing global as a side effect.

// @types/node's undici typings do not expose `RequestInfo` as a standalone
// global name (that one is DOM-only, and `lib` is ES2023 here), so derive the
// argument shapes from the global `fetch` itself.
type FetchInput = Parameters<typeof fetch>[0];

/** Prefix of every variable the harness strips. */
const ENV_PREFIX = 'JIRA_';

/** The one `JIRA_*` variable the harness must preserve — it selects the mode. */
const LIVE_TEST_VAR = 'JIRA_LIVE_TEST';

/** True when the env-gated live read suite is running (TESTING.md suite 9). */
export function isLiveTestRun(): boolean {
  return process.env[LIVE_TEST_VAR] === '1';
}

/**
 * Thrown by the fenced `fetch`. Carries the refused target separately from the
 * message so a test can assert on it without string surgery.
 */
export class NetworkFenceError extends Error {
  /** `"<METHOD> <url>"` of the refused request. */
  readonly target: string;

  constructor(target: string) {
    super(
      `network access is disabled in tests — refused ${target}. ` +
        'Use withFetch() to program a response at the wire tier, or ' +
        'createFakeJiraRequest() at the contract tier.',
    );
    this.name = 'NetworkFenceError';
    this.target = target;
    Object.setPrototypeOf(this, NetworkFenceError.prototype);
  }
}

function isRequest(input: FetchInput): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

/**
 * Describe a refused call as `"<METHOD> <url>"`. Naming the URL is the point:
 * `network access is disabled` alone leaves the reader guessing which of a
 * dozen calls escaped, which is exactly the moment a fence stops being useful.
 */
export function describeRequest(input: FetchInput, init?: RequestInit): string {
  let url = '<unknown url>';
  let method = init?.method;

  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else if (isRequest(input)) {
    url = input.url;
    method ??= input.method;
  }

  return `${(method ?? 'GET').toUpperCase()} ${url}`;
}

/** The real `fetch`, captured before the fence replaced it. */
export const realFetch: typeof fetch = globalThis.fetch;

/** The guard installed in place of `fetch`. Always throws; never returns. */
export const fenceFetch: typeof fetch = (input, init) => {
  throw new NetworkFenceError(describeRequest(input, init));
};

/** Install the guard. Idempotent; `withFetch` restores it on exit. */
export function installNetworkFence(): void {
  globalThis.fetch = fenceFetch;
}

/**
 * Restore the real `fetch`. For the live read suite only — a unit test that
 * needs a programmed response uses `withFetch`, never this.
 */
export function uninstallNetworkFence(): void {
  globalThis.fetch = realFetch;
}

/**
 * Delete every `JIRA_*` variable except {@link LIVE_TEST_VAR} and return the
 * names removed. Ambient config is the classic "passes on my machine" bug: a
 * settings test that reads `JIRA_SITE` from the developer's shell asserts
 * nothing.
 */
export function stripJiraEnv(): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(ENV_PREFIX) && name !== LIVE_TEST_VAR) {
      delete process.env[name];
      removed.push(name);
    }
  }
  return removed;
}

// Side effects, kept last so the exports above are fully initialised first.
if (!isLiveTestRun()) {
  stripJiraEnv();
  installNetworkFence();
}
