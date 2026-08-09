// Wire-tier fetch mock (TESTING.md §Mocking tiers).
//
// `withFetch` swaps a recording mock into `globalThis.fetch` for the duration of
// a callback and restores whatever was there before — normally the network fence
// — even when the callback throws. This is the seam `core/http.ts` is tested
// through: retry matrix, backoff sequences, host allowlist, redirect refusal,
// header rules. Everything above the client uses the contract tier
// (`createFakeJiraRequest`) instead.
//
// Two ways to program it, both on the same mock:
//   * `enqueue(spec)` — a scripted SEQUENCE, consumed in order regardless of
//     URL (what TESTING.md calls `scriptFetch`); ideal for "503, 503, 200".
//   * `on(match, spec)` — a rule keyed by URL or predicate, for order-
//     independent routing.
// A request matching nothing throws and names itself. There is deliberately no
// empty-object fallback: a silent `{}` turns a routing bug into a passing test.

// @types/node's undici typings do not expose `RequestInfo` / `BodyInit` as
// standalone global names (those are DOM-only, and `lib` is ES2023 here), so
// derive the shapes we need from the global `fetch`, `Headers` and `Response`.
type FetchInput = Parameters<typeof fetch>[0];
type HeadersInput = ConstructorParameters<typeof Headers>[0];
type ResponseBody = ConstructorParameters<typeof Response>[0];

/** A request as the mock observed it; header names are lowercased. */
export interface RecordedRequest {
  /** Uppercased HTTP method. */
  readonly method: string;
  /** The URL exactly as the caller passed it. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Request body decoded as text, or `undefined` when there was none. */
  readonly body?: string;
}

/**
 * What the mock should answer with — at most one body field. `error` rejects
 * instead of resolving, which is how a transport failure (DNS, socket reset) is
 * modelled; the retry matrix treats it differently from a 5xx status.
 */
export interface ResponseSpec {
  /** Defaults to 200. */
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialized as JSON, with `content-type: application/json` unless overridden. */
  readonly json?: unknown;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  /** Reject the call with this error instead of returning a response. */
  readonly error?: Error;
}

/**
 * How a rule selects requests: a substring of the URL, a regex tested against
 * the URL, or a predicate over the whole recorded request (use the predicate to
 * match on method, headers or body).
 */
export type FetchMatcher = string | RegExp | ((req: RecordedRequest) => boolean);

/** The handle `withFetch` passes to the callback. All setters are chainable. */
export interface FetchMock {
  /** Every request seen so far, in order. */
  readonly requests: readonly RecordedRequest[];
  /** The most recent request, or `undefined` when there was none. */
  lastRequest(): RecordedRequest | undefined;
  /** Append to the scripted sequence; the queue is consumed before any rule. */
  enqueue(spec: ResponseSpec): FetchMock;
  /** Answer up to `times` (default: unlimited) requests matching `match`. */
  on(match: FetchMatcher, spec: ResponseSpec, times?: number): FetchMock;
  /** Answer anything left unmatched. Opt-in — the default is to throw. */
  fallback(spec: ResponseSpec): FetchMock;
}

interface Rule {
  readonly match: FetchMatcher;
  readonly spec: ResponseSpec;
  remaining: number;
}

/** Statuses whose response body must be null, or the `Response` ctor throws. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function isRequest(input: FetchInput): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (isRequest(input)) return input.url;
  return '<unknown url>';
}

function requestMethod(input: FetchInput, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (isRequest(input)) return input.method.toUpperCase();
  return 'GET';
}

function captureHeaders(input: FetchInput, init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const merge = (source: HeadersInput): void => {
    if (source === undefined) return;
    new Headers(source).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  };
  if (isRequest(input)) merge(input.headers);
  merge(init?.headers);
  return out;
}

async function captureBody(
  input: FetchInput,
  init?: RequestInit,
): Promise<string | undefined> {
  const raw = init?.body;
  if (raw === undefined || raw === null) {
    if (isRequest(input)) {
      const text = await input.clone().text();
      return text === '' ? undefined : text;
    }
    return undefined;
  }
  if (typeof raw === 'string') return raw;
  if (raw instanceof URLSearchParams) return raw.toString();
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  // Blob / ReadableStream / FormData are not part of the Jira surface; a marker
  // beats pretending the body was empty.
  return '<unsupported body>';
}

function matches(rule: Rule, req: RecordedRequest): boolean {
  const { match } = rule;
  if (typeof match === 'string') return req.url.includes(match);
  if (match instanceof RegExp) return match.test(req.url);
  return match(req);
}

function buildResponse(spec: ResponseSpec): Response {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers);
  let body: ResponseBody = null;

  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (spec.text !== undefined) {
    body = spec.text;
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
  } else if (spec.bytes !== undefined) {
    body = spec.bytes;
  }

  if (BODYLESS_STATUSES.has(status)) body = null;

  return new Response(body, {
    status,
    statusText: spec.statusText ?? '',
    headers,
  });
}

/**
 * Run `fn` with a recording `fetch` mock installed, then restore the previous
 * global (normally the network fence) — including when `fn` throws, so one
 * failing test cannot leave every test after it unfenced.
 */
export async function withFetch<T>(fn: (mock: FetchMock) => T | Promise<T>): Promise<T> {
  const requests: RecordedRequest[] = [];
  const queue: ResponseSpec[] = [];
  const rules: Rule[] = [];
  let fallbackSpec: ResponseSpec | undefined;

  const mock: FetchMock = {
    requests,
    lastRequest: () => requests[requests.length - 1],
    enqueue: (spec) => {
      queue.push(spec);
      return mock;
    },
    on: (match, spec, times = Number.POSITIVE_INFINITY) => {
      rules.push({ match, spec, remaining: times });
      return mock;
    },
    fallback: (spec) => {
      fallbackSpec = spec;
      return mock;
    },
  };

  const resolveSpec = (req: RecordedRequest): ResponseSpec | undefined => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    for (const rule of rules) {
      if (rule.remaining > 0 && matches(rule, req)) {
        rule.remaining -= 1;
        return rule.spec;
      }
    }
    return fallbackSpec;
  };

  const mockFetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const record: RecordedRequest = {
      method: requestMethod(input, init),
      url: requestUrl(input),
      headers: captureHeaders(input, init),
      body: await captureBody(input, init),
    };
    requests.push(record);

    const spec = resolveSpec(record);
    if (spec === undefined) {
      throw new Error(
        `withFetch: unexpected request ${record.method} ${record.url} ` +
          '(no queued response, no matching rule, no fallback)',
      );
    }
    if (spec.error !== undefined) throw spec.error;
    return buildResponse(spec);
  };

  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn(mock);
  } finally {
    globalThis.fetch = previous;
  }
}
