// Contract-tier Jira client fake (TESTING.md §Mocking tiers).
//
// Stubs the `JiraRequestFn` contract so `api/*`, `tools/*`, the registry and the
// envelope can be tested without the real HTTP client: canned `JiraResponse`
// values keyed by method + path, plus a recording of every request that was
// made. The wire tier (`src/testing/with-fetch.ts`) is the seam BELOW this one
// and is what `core/http.ts` itself is tested through.
//
// Two rules this fake exists to enforce:
//
//  1. **An unmatched route is a test failure**, never an empty object
//     (TESTING.md §Mocking tiers). A fake that answers `{}` to a route nobody
//     programmed lets a guard "pass" against a response Jira never sends.
//  2. **Canned bodies come from `test/fixtures/`, not from imagination.**
//     Hand-authored fakes drift into the shape we wish Jira had. The loader for
//     that corpus now exists — `createFixtureLoader` / `repoFixtureLoader` in
//     `./fixtures.ts` — so a test that wants a real body writes
//     `createFakeJiraRequest({ loadFixture: repoFixtureLoader }).fixture('name')`.
//     It is still passed in rather than defaulted, for one reason: the corpus is
//     nearly empty until a scratch site exists (Gate C / O-2), and a fake that
//     silently reached for a corpus of two synthetic files would make "loaded
//     from fixtures" look true across a suite where it is not. Injecting the
//     loader keeps the claim per-test and honest. Flipping the default is a
//     one-line change here once the minimum fixture set is recorded.

import {
  JIRA_ROOT_PATHS,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
} from '../types.js';

/** What a programmed route answers with: a response, or a thrown error. */
export type JiraStubResult =
  | {
      readonly data: unknown;
      /** Defaults to 200. */
      readonly status?: number;
      /** Lowercased on the way out, like the real client's. */
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly error: Error };

/** Programmed success. `jiraOk(body)` is the common case. */
export function jiraOk(
  data: unknown,
  init?: { status?: number; headers?: Readonly<Record<string, string>> },
): JiraStubResult {
  return { data, status: init?.status, headers: init?.headers };
}

/**
 * Programmed failure — the fake rejects with `error`. Use a real `JiraError` to
 * exercise how a tool maps a kind onto the envelope.
 */
export function jiraErr(error: Error): JiraStubResult {
  return { error };
}

/**
 * How a rule selects requests. A string is matched as a PREFIX of the route
 * (`"GET /rest/api/3/issue/ABC-1"`), a regex is tested against it, and a
 * predicate sees the whole spec — use that to assert on query or body.
 */
export type JiraMatcher = string | RegExp | ((req: JiraRequestSpec) => boolean);

/** The recording, programming and inspection handle. */
export interface FakeJiraRequest {
  /** The seam to inject wherever a `JiraRequestFn` is expected. */
  readonly fn: JiraRequestFn;
  /** Every request received, in order, exactly as the caller built it. */
  readonly calls: readonly JiraRequestSpec[];
  /** The most recent request, or `undefined` when there was none. */
  lastRequest(): JiraRequestSpec | undefined;
  /** `"<METHOD> <absolute path>"` for each call — what the matchers see. */
  routes(): readonly string[];
  /** Answer up to `times` (default: unlimited) requests matching `match`. */
  on(match: JiraMatcher, result: JiraStubResult, times?: number): FakeJiraRequest;
  /** Append to the scripted sequence; the queue is consumed before any rule. */
  enqueue(result: JiraStubResult): FakeJiraRequest;
  /**
   * Load a canned body through the injected fixture loader. Throws when no
   * loader was configured — the same "loudly, not empty" rule as an unmatched
   * route.
   */
  fixture(name: string): unknown;
  /** Drop recorded calls, queued results and rules. */
  reset(): void;
}

/**
 * Resolves a fixture name (`'errors/rate-limited-429'`, corpus-relative, no
 * extension) to a parsed JSON body. The repo's implementation over
 * `test/fixtures/` is `createFixtureLoader()` in `./fixtures.ts`; a test may
 * substitute any function, which is how the corpus-independent cases stay
 * corpus-independent.
 *
 * Returning `undefined` means "not found" and the fake turns it into a failure;
 * the repo loader throws first, with the corpus listing in the message.
 */
export type FixtureLoader = (name: string) => unknown;

export interface FakeJiraRequestOptions {
  /**
   * Hook for `test/fixtures/*.json`; see {@link FixtureLoader}. Pass
   * `repoFixtureLoader` (`./fixtures.ts`) to read the committed corpus.
   */
  readonly loadFixture?: FixtureLoader;
}

interface Rule {
  readonly match: JiraMatcher;
  readonly result: JiraStubResult;
  remaining: number;
}

function lowercaseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * The route a matcher sees: method plus the path the real client would build,
 * API root included — `GET /rest/api/3/issue/ABC-1`,
 * `GET /rest/agile/1.0/board`. Including the root is what keeps a v3 path and
 * an Agile path with the same tail distinguishable.
 */
export function routeOf(req: JiraRequestSpec): string {
  return `${req.method} ${JIRA_ROOT_PATHS[req.root ?? 'v3']}${req.path}`;
}

function matches(rule: Rule, req: JiraRequestSpec, route: string): boolean {
  const { match } = rule;
  if (typeof match === 'string') return route.startsWith(match);
  if (match instanceof RegExp) return match.test(route);
  return match(req);
}

/**
 * Create a contract-tier fake Jira client. Rules are tried in insertion order,
 * so register the more specific route first when one prefix contains another.
 */
export function createFakeJiraRequest(
  options: FakeJiraRequestOptions = {},
): FakeJiraRequest {
  const calls: JiraRequestSpec[] = [];
  const queue: JiraStubResult[] = [];
  const rules: Rule[] = [];

  const resolveResult = (
    req: JiraRequestSpec,
    route: string,
  ): JiraStubResult | undefined => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    for (const rule of rules) {
      if (rule.remaining > 0 && matches(rule, req, route)) {
        rule.remaining -= 1;
        return rule.result;
      }
    }
    return undefined;
  };

  const fn: JiraRequestFn = <T>(req: JiraRequestSpec): Promise<JiraResponse<T>> => {
    calls.push(req);
    const route = routeOf(req);
    const result = resolveResult(req, route);

    if (result === undefined) {
      // Thrown, not rejected: an unprogrammed route is a bug in the TEST, and it
      // must not be mistakable for a modelled upstream failure.
      throw new Error(
        `createFakeJiraRequest: unexpected request ${route} ` +
          '(no queued result and no matching rule). Fakes never invent a ' +
          'response — program the route or add the fixture.',
      );
    }
    if ('error' in result) return Promise.reject(result.error);

    return Promise.resolve({
      status: result.status ?? 200,
      headers: lowercaseHeaders(result.headers),
      data: result.data as T,
    });
  };

  const fake: FakeJiraRequest = {
    fn,
    calls,
    lastRequest: () => calls[calls.length - 1],
    routes: () => calls.map(routeOf),
    on: (match, result, times = Number.POSITIVE_INFINITY) => {
      rules.push({ match, result, remaining: times });
      return fake;
    },
    enqueue: (result) => {
      queue.push(result);
      return fake;
    },
    fixture: (name) => {
      const load = options.loadFixture;
      if (load === undefined) {
        throw new Error(
          `createFakeJiraRequest: no fixture loader configured, cannot load ` +
            `"${name}". Pass { loadFixture: repoFixtureLoader } from ` +
            "'core/fakes/fixtures.js' to read test/fixtures/ (TESTING.md " +
            '§Fixtures), or supply the body inline.',
        );
      }
      const body = load(name);
      if (body === undefined) {
        throw new Error(
          `createFakeJiraRequest: fixture "${name}" not found. A fixture the ` +
            'fake cannot find is a test failure, not a fallback to {}.',
        );
      }
      return body;
    },
    reset: () => {
      calls.length = 0;
      queue.length = 0;
      rules.length = 0;
    },
  };

  return fake;
}
