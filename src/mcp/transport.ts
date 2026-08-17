// ---------------------------------------------------------------------------
// Transport wiring (D5 — the low-level SDK `Server`; D19 — v1 is stdio-only;
// OBSERVABILITY.md §Log events for `shutdown`).
//
// This module owns exactly one decision — WHICH transport, and how it is
// attached and detached. It does not build the server, register handlers, or
// install signal traps: that is `buildServer`/`main` (WP-40), which calls
// `connectTransport` and later `handle.close(reason)`.
//
// STDIO IS THE PROTOCOL. stdout carries JSON-RPC frames, which is why the whole
// codebase logs to stderr and why `no-console` is on in eslint. Both streams are
// injectable so a test can drive a real `StdioServerTransport` over a pair of
// in-memory pipes instead of hijacking the process' own descriptors.
//
// EOF IS A SHUTDOWN SIGNAL. The SDK transport attaches a `data` listener and
// nothing else: when the client goes away and stdin ends, it simply stops
// receiving. An MCP server that keeps running there is an orphan process on the
// user's machine, so EOF is wired here to the same close path a signal uses,
// and reported with the `stdin_eof` reason from the frozen vocabulary.
//
// HTTP IS REFUSED (D19). `core/settings.ts` still parses `JIRA_TRANSPORT`,
// `JIRA_HTTP_PORT` and `JIRA_HTTP_TOKEN` so the configuration surface stays
// stable across the v1.5 reinstatement — the refusal lives here, at the only
// place that would have had to implement the listener, the token gate (CC-30)
// and session handling.
//
// Layering: `core ← api ← mcp ← tools`. The SDK enters the codebase here (and
// in WP-40's assembly), never below.
// ---------------------------------------------------------------------------

import type { Readable, Writable } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { JiraError } from '../core/types.js';
import type { Logger, Settings, TransportKind } from '../core/types.js';

/**
 * Why the server is going down — the `reason` field of the `shutdown` event
 * (OBSERVABILITY.md). Closed vocabulary: a log field the operator greps for is
 * a contract, not a free-text note.
 */
export type ShutdownReason = 'stdin_eof' | 'sigint' | 'sigterm' | 'fatal';

/**
 * The slice of the SDK `Server` this module needs.
 *
 * Structural rather than the concrete class so a test can connect a fake and
 * assert the wiring without standing up a protocol implementation — and so this
 * module never grows an opinion about how the server was built.
 */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface TransportDeps {
  readonly settings: Settings;
  /** Root logger (cid `-`); the `shutdown` event is not part of a tool call. */
  readonly logger: Logger;
  /** Defaults to `process.stdin`; injected in tests. */
  readonly stdin?: Readable | undefined;
  /** Defaults to `process.stdout`; injected in tests. */
  readonly stdout?: Writable | undefined;
}

/** A live transport attachment, and the one way to take it down. */
export interface TransportHandle {
  readonly kind: TransportKind;
  /** The attached transport; WP-40 needs it for nothing else than diagnostics. */
  readonly transport: Transport;
  readonly closed: boolean;
  /** Detach and close the server. Idempotent — the first reason is the one logged. */
  close(reason: ShutdownReason): Promise<void>;
}

/** Message of the D19 refusal; asserted verbatim by the test. */
export const HTTP_TRANSPORT_MESSAGE =
  'JIRA_TRANSPORT=http is not available in v1: the Streamable HTTP transport was ' +
  'demoted to v1.5 (D19). This build serves the stdio transport only.';

export const HTTP_TRANSPORT_REMEDIATION =
  'Set JIRA_TRANSPORT=stdio (the default) and register the server as a stdio MCP ' +
  'server. JIRA_HTTP_PORT and JIRA_HTTP_TOKEN keep being parsed so the ' +
  'configuration survives the v1.5 upgrade unchanged.';

/**
 * The refusal for every transport this build cannot serve, keyed by kind.
 *
 * A table rather than an `isHttp ? … : generic-fallback` pair, because the
 * fallback was unreachable code: `TRANSPORT_KINDS` has exactly two members and
 * `core/settings.ts` rejects anything outside it, so the only kind that ever
 * reaches here is `http`. The `Record` keeps that honest at COMPILE time —
 * adding a transport makes this table incomplete and breaks the build here,
 * which is where the new kind's refusal belongs, instead of silently shipping a
 * generic sentence no test ever exercised.
 */
const REFUSALS: Record<
  Exclude<TransportKind, 'stdio'>,
  { readonly message: string; readonly remediation: string }
> = {
  http: { message: HTTP_TRANSPORT_MESSAGE, remediation: HTTP_TRANSPORT_REMEDIATION },
};

function unsupportedTransport(kind: Exclude<TransportKind, 'stdio'>): JiraError {
  const refusal = REFUSALS[kind];
  return new JiraError({
    kind: 'config',
    message: refusal.message,
    retryable: false,
    remediation: refusal.remediation,
  });
}

/**
 * Fail before anything is constructed if the configured transport cannot be
 * served. Separate from {@link connectTransport} so startup validation (and
 * doctor) can ask the question without owning a server instance.
 */
export function assertTransportSupported(settings: Settings): void {
  if (settings.transport !== 'stdio') throw unsupportedTransport(settings.transport);
}

/**
 * Attach `server` to the configured transport.
 *
 * Throws (rather than returning a result envelope) on purpose: this runs at
 * startup, before any MCP session exists, so there is no channel to answer on —
 * `main` turns the `JiraError` into a stderr message and a non-zero exit.
 */
export async function connectTransport(
  server: ConnectableServer,
  deps: TransportDeps,
): Promise<TransportHandle> {
  assertTransportSupported(deps.settings);

  const stdin = deps.stdin ?? process.stdin;
  const transport = new StdioServerTransport(stdin, deps.stdout ?? process.stdout);

  let closed = false;
  let closing: Promise<void> | undefined;

  const detach = (): void => {
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
  };

  const close = (reason: ShutdownReason): Promise<void> => {
    // Idempotent, and it returns the SAME promise: EOF and a signal can race,
    // and closing the SDK server twice is not a defined operation.
    if (closing !== undefined) return closing;
    detach();
    deps.logger.emit('shutdown', { reason });
    // `closing` is assigned BEFORE `server.close()` runs, which is why the call
    // is deferred into a `then` rather than made inline: closing the server
    // closes the transport, and the transport's `onclose` re-enters this
    // function SYNCHRONOUSLY (see the chaining below). An inline call would run
    // that re-entry while `closing` was still `undefined` — a second `shutdown`
    // line and a second `server.close()` for one shutdown.
    closing = Promise.resolve()
      .then(() => server.close())
      .finally(() => {
        closed = true;
      });
    return closing;
  };

  function onEnd(): void {
    // The client hung up. `void` rather than await: this is an event listener,
    // and a rejected close is still a close.
    void close('stdin_eof').catch(() => {
      /* the shutdown event is already on stderr; nothing left to report to */
    });
  }

  // `connect` calls `transport.start()`, which puts stdin in flowing mode — so
  // the EOF listener is attached afterwards, when there is a stream to end.
  await server.connect(transport);
  stdin.on('end', onEnd);
  stdin.on('close', onEnd);

  // THE TRANSPORT CAN DIE WITHOUT EOF. The SDK closes it from the inside when a
  // frame overruns the 10 MiB read buffer — a plausible hostile or merely buggy
  // client — and that close detaches its own `data` listener, so the `end`/
  // `close` wiring above never fires either. Without this chain the session
  // would be gone while the process stayed up: no `shutdown` line, `server`
  // never closed, an orphan holding a stdio handle nobody can reach. `fatal` is
  // the reason from the frozen vocabulary (OBSERVABILITY.md) that fits a
  // transport that died on us rather than a client that said goodbye.
  //
  // `connect` already installed the Protocol's own `onclose`; this chains it
  // instead of replacing it, because that handler is what rejects the requests
  // still in flight.
  const protocolOnClose = transport.onclose;
  transport.onclose = (): void => {
    protocolOnClose?.();
    void close('fatal').catch(() => {
      /* the shutdown event is already on stderr; nothing left to report to */
    });
  };

  return {
    kind: 'stdio',
    transport,
    get closed(): boolean {
      return closed;
    },
    close,
  };
}
