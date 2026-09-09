// ---------------------------------------------------------------------------
// Loopback Streamable HTTP transport (D101 — the scheduling call D19 deferred,
// now taken; ARCHITECTURE.md §Transport holds the design this implements).
//
// This module owns the listener and nothing else: `index.ts` decides WHICH
// transport runs, `buildServer` decides what a session can do. One process, one
// `http.Server` bound to `127.0.0.1:JIRA_HTTP_PORT` — host and port together,
// because a bare port binds every interface and publishes the tool surface on
// the machine's LAN address (CC-115).
//
// EVERY REQUEST WALKS THE SAME GATE LINE, in this order: path, Host, Origin
// (DNS-rebinding defense, CC-116), bearer token (constant-time, CC-114), and
// only then JSON-RPC routing. The guards run before the SDK ever sees a byte of
// body, so a hostile page in a local browser gets a 403, not a parser.
//
// ONE MCP SESSION PER `Mcp-Session-Id` (CC-117). Each session gets its own
// `Server` from the injected factory: the SDK binds one `Server` to one
// transport, and — more importantly — the write-gate's plan_id table lives
// inside the `buildServer` product, so a session's plans die with its `Server`
// and an armed plan from a dead session can never be applied. Sessions end on
// HTTP DELETE (the SDK handles it and calls `onsessionclosed`) or when the
// clock-driven sweeper finds them idle.
//
// INBOUND, NOT OUTBOUND. "Only `core/http.ts` touches the network" is about
// outbound requests to Jira; this module accepts loopback connections the same
// way the login CLI's callback listener does, and issues none. `fetch` never
// appears here, so the test fence is irrelevant to it.
//
// This module emits exactly ONE log event, `shutdown`, exactly once, at close —
// the same invariant the stdio module keeps (`server_start` stays in
// `index.ts`). Diagnostics have nowhere else to go: stdout is sacred and the
// tool surface has its own logging.
//
// Layering: `core ← api ← mcp ← tools`. The SDK enters here and in the stdio
// sibling, never below.
// ---------------------------------------------------------------------------

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { JiraError } from '../core/types.js';
import type { Clock, Logger, Settings } from '../core/types.js';
import type { ConnectableServer, ShutdownReason, TransportHandle } from './transport.js';

export interface HttpTransportDeps {
  /** `transport === 'http'`; the port and token both come from here. */
  readonly settings: Settings;
  /** Root logger (cid `-`); the `shutdown` event is not part of a tool call. */
  readonly logger: Logger;
  readonly clock: Clock;
  /** One fresh `Server` per MCP session; plans/gate state live inside it. */
  readonly createServer: () => ConnectableServer;
}

/**
 * Idle sessions are destroyed after this long without a request — and with no
 * response still open: a client holding the standalone SSE stream is
 * connected, not idle, however long it stays quiet.
 */
export const HTTP_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;

/** How often the idle sweeper wakes. */
export const HTTP_IDLE_SWEEP_INTERVAL_MS = 60_000;

/** The only path served; no `/healthz` — doctor is the health check. */
const MCP_PATH = '/mcp';

/** Same literal as the login CLI: loopback by address, never by wildcard. */
const LOOPBACK_HOST = '127.0.0.1';

const BEARER_PREFIX = 'Bearer ';

/**
 * One live MCP session. `server` and `transport` are a bound pair; `closed`
 * makes teardown idempotent when DELETE, the idle sweeper, and shutdown race.
 */
interface SessionEntry {
  readonly server: ConnectableServer;
  readonly transport: StreamableHTTPServerTransport;
  lastActivity: number;
  /** Responses not yet closed; a live SSE stream keeps this above zero. */
  open: number;
  closed: boolean;
}

/**
 * Refuse in the SDK's own JSON-RPC error shape so a client sees one grammar
 * regardless of which layer said no. `id: null` — the body was never parsed,
 * so there is no request id to echo.
 */
function refuse(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * CC-116, Host half: the header must name the bound loopback authority —
 * `127.0.0.1:<port>` or `localhost:<port>`, hostname case-folded, and on port
 * 80 the bare host too: RFC 9110 has clients elide the scheme's default port,
 * so the bare spelling IS that authority's canonical name. A DNS-rebound page
 * carries its own hostname here and fails.
 *
 * Exported for the port-80 cases alone: binding port 80 needs privileges no
 * test has, so the socket-level suite cannot reach them.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const lower = host.toLowerCase();
  if (
    lower === `${LOOPBACK_HOST}:${String(port)}` ||
    lower === `localhost:${String(port)}`
  ) {
    return true;
  }
  return port === 80 && (lower === LOOPBACK_HOST || lower === 'localhost');
}

/**
 * CC-116, Origin half: absent passes (curl and MCP clients send none); present
 * must parse as an http(s) URL whose hostname is loopback — any port, so local
 * tooling like MCP inspector (`http://localhost:6274`) works.
 */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === LOOPBACK_HOST ||
    hostname === 'localhost' ||
    // WHATWG URL keeps the brackets on an IPv6 hostname; accept both spellings.
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * CC-114: `Authorization: Bearer <token>` compared in constant time — the
 * length gate first because `timingSafeEqual` throws on unequal lengths (the
 * login CLI's `sameState` pattern). `expected` is encoded once, at bind time;
 * the presented value is never logged, echoed, or kept.
 */
function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return false;
  const presented = Buffer.from(header.slice(BEARER_PREFIX.length), 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** Node folds duplicate headers into arrays; a duplicated one is ignored. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Bind the loopback listener and serve Streamable HTTP until
 * `handle.close(reason)`.
 *
 * Resolves once the listener is bound. Throws (rather than answering on some
 * channel) on a missing token or an unbindable port: this runs at startup,
 * before any session exists — `main` turns the `JiraError` into a stderr
 * message and a non-zero exit.
 */
export async function connectHttpTransport(
  deps: HttpTransportDeps,
): Promise<TransportHandle> {
  const { settings, logger, clock, createServer } = deps;

  // Defense in depth: `assertStartupOk` already refused this configuration
  // (settings error `http_token_missing`, CC-30), but the gate that keeps an
  // unauthenticated listener off the machine fails closed twice.
  const token = settings.httpToken;
  if (token === undefined) {
    throw new JiraError({
      kind: 'config',
      message:
        'JIRA_TRANSPORT=http requires JIRA_HTTP_TOKEN; the HTTP transport fails ' +
        'closed without it (CC-30).',
      retryable: false,
      remediation:
        'Set a random bearer token in JIRA_HTTP_TOKEN or use the stdio transport.',
    });
  }

  const port = settings.httpPort;
  const expectedToken = Buffer.from(token, 'utf8');
  const sessions = new Map<string, SessionEntry>();

  const teardown = async (sid: string): Promise<void> => {
    const entry = sessions.get(sid);
    if (entry === undefined || entry.closed) return;
    entry.closed = true;
    sessions.delete(sid);
    // Transport first: its `onclose` runs the Protocol's `_onclose`, which
    // aborts every in-flight request handler (verified in SDK 1.30.0 source) —
    // the `server.close()` after it is then a settled no-op, kept because the
    // ordering is an SDK implementation detail this module must not lean on.
    // Each close is guarded on its own — a rejected close is still a close
    // (the stdio module's rule), and teardown's callers, the SDK's
    // `onsessionclosed` callback and the sweeper's loop, have no channel for a
    // rejection short of crashing the process or ending the sweeps.
    try {
      await entry.transport.close();
    } catch {
      /* already out of the map; nothing is left to answer on */
    }
    try {
      await entry.server.close();
    } catch {
      /* same */
    }
  };

  /**
   * CC-117, idle half: count the response against the session until it is
   * done. A response can outlive its request by half an hour — the standalone
   * SSE GET — and the sweeper must see that session as connected, not idle.
   * `finish` fires when a response has fully flushed; `close` when the socket
   * lets go without one — an aborted POST, a destroyed stream. Whichever comes
   * first ends the response's claim on the session.
   */
  const trackResponse = (entry: SessionEntry, res: ServerResponse): void => {
    entry.open += 1;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      entry.open -= 1;
      entry.lastActivity = clock.now();
    };
    res.once('finish', settle);
    res.once('close', settle);
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    // 1. Path — only /mcp exists.
    const path = (req.url ?? '').split('?', 1)[0] ?? '';
    if (path !== MCP_PATH) {
      refuse(res, 404, -32001, 'Not found: only /mcp is served.');
      return;
    }

    // 2–3. Host, then Origin (CC-116) — before any JSON-RPC processing.
    if (!hostAllowed(headerValue(req.headers.host), port)) {
      refuse(res, 403, -32000, 'Forbidden: Host is not the bound loopback authority.');
      return;
    }
    if (!originAllowed(headerValue(req.headers.origin))) {
      refuse(res, 403, -32000, 'Forbidden: Origin is not a loopback origin.');
      return;
    }

    // 4. Bearer (CC-114). The refusal names neither the expected nor the
    // presented value.
    if (!bearerMatches(headerValue(req.headers.authorization), expectedToken)) {
      refuse(res, 401, -32000, 'Unauthorized: missing or invalid bearer token.');
      return;
    }

    // 5. Route by method + Mcp-Session-Id (CC-117).
    const sid = headerValue(req.headers['mcp-session-id']);
    if (sid === undefined) {
      if (req.method !== 'POST') {
        refuse(res, 400, -32000, 'Bad Request: Mcp-Session-Id header required.');
        return;
      }
      const entry: SessionEntry = {
        server: createServer(),
        transport: new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sessionId: string): void => {
            sessions.set(sessionId, entry);
          },
          onsessionclosed: (sessionId: string): void => {
            // Fire-and-forget is safe: teardown never rejects.
            void teardown(sessionId);
          },
        }),
        lastActivity: clock.now(),
        open: 0,
        closed: false,
      };
      await entry.server.connect(entry.transport);
      trackResponse(entry, res);
      // The SDK reads the body itself and refuses a non-initialize POST
      // without a session on its own (400).
      await entry.transport.handleRequest(req, res);
      if (entry.transport.sessionId === undefined) {
        // The POST never became a session (already answered above). Close the
        // speculative pair so a junk POST cannot leak a Server per request.
        entry.closed = true;
        await entry.transport.close();
        await entry.server.close();
      }
      return;
    }

    const entry = sessions.get(sid);
    if (entry === undefined) {
      refuse(res, 404, -32001, 'Session not found');
      return;
    }
    entry.lastActivity = clock.now();
    trackResponse(entry, res);
    // DELETE is the SDK's to handle: it answers 200 and fires
    // `onsessionclosed`, which runs `teardown` above.
    await entry.transport.handleRequest(req, res);
  };

  const httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      // The socket died mid-write or the SDK threw after answering. Nothing is
      // logged — this module emits only `shutdown` — but a request that got
      // nothing yet deserves a refusal in the same shape as every other.
      try {
        if (res.headersSent) {
          res.destroy();
        } else {
          refuse(res, 500, -32603, 'Internal error.');
        }
      } catch {
        /* the connection is already gone; there is nothing left to answer on */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: unknown): void => {
      reject(
        new JiraError({
          kind: 'config',
          message: `The HTTP transport could not bind ${LOOPBACK_HOST}:${String(port)}: ${
            error instanceof Error ? error.message : 'unknown error'
          }.`,
          retryable: false,
          remediation: 'Free the port or set JIRA_HTTP_PORT to another one.',
          cause: error,
        }),
      );
    };
    httpServer.once('error', onListenError);
    // Host and port together: passing only a port binds every interface, which
    // would publish a tool-executing endpoint on the machine's LAN address.
    httpServer.listen({ host: LOOPBACK_HOST, port }, () => {
      httpServer.removeListener('error', onListenError);
      resolve();
    });
  });

  // Idle sweeper (CC-117, idle half). No raw timers anywhere in src: the loop
  // sleeps on the injected Clock, so tests drive it with a fake and the real
  // build gets a real timer through `core/clock.ts`.
  const sweeper = new AbortController();
  void (async () => {
    for (;;) {
      await clock.sleep(HTTP_IDLE_SWEEP_INTERVAL_MS, sweeper.signal); // rejects on abort
      for (const [sid, entry] of sessions) {
        if (
          entry.open === 0 &&
          clock.now() - entry.lastActivity >= HTTP_SESSION_IDLE_TIMEOUT_MS
        ) {
          await teardown(sid);
        }
      }
    }
  })().catch(() => {
    /* the aborted sleep ends the loop; teardown itself never rejects */
  });

  let closed = false;
  let closing: Promise<void> | undefined;

  const close = (reason: ShutdownReason): Promise<void> => {
    // Idempotent, and it returns the SAME promise: a signal and a second
    // signal can race, and closing the SDK pairs twice is not a defined
    // operation. The first reason is the one logged.
    if (closing !== undefined) return closing;
    closing = Promise.resolve()
      .then(async () => {
        // Stop accepting first; the callback fires only once every connection
        // is gone, which `closeAllConnections` below guarantees (an SSE or
        // in-flight POST would otherwise hold the server open — the login
        // CLI's lesson).
        const stopped = new Promise<void>((resolve) => {
          httpServer.close(() => {
            resolve();
          });
        });
        for (const sid of [...sessions.keys()]) {
          await teardown(sid);
        }
        httpServer.closeAllConnections();
        sweeper.abort();
        await stopped;
        logger.emit('shutdown', { reason });
      })
      .finally(() => {
        closed = true;
      });
    return closing;
  };

  // No `transport` field: an HTTP handle has no single transport — each
  // session owns its own.
  const handle: TransportHandle = {
    kind: 'http',
    get closed(): boolean {
      return closed;
    },
    close,
  };
  return handle;
}
