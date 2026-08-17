// Tests for the transport seam.
//
// The stdio path is exercised against a REAL `StdioServerTransport` driven over
// a pair of in-memory pipes, so the wiring that matters — a JSON-RPC frame
// arriving as a parsed message, EOF turning into a shutdown — is asserted
// against the SDK rather than against a mock of it. Only the server is a fake:
// this module must not know how the server was built (D5 / WP-40).

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createFakeLogger } from '../core/fakes/fakeLogger.js';
import { JiraError } from '../core/types.js';
import type { Settings } from '../core/types.js';
import {
  HTTP_TRANSPORT_MESSAGE,
  assertTransportSupported,
  connectTransport,
} from './transport.js';
import type { ConnectableServer } from './transport.js';

const BASE_SETTINGS: Settings = {
  allowedHosts: [],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'plan',
  allowIrreversible: false,
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
};

function settingsOf(overrides: Partial<Settings> = {}): Settings {
  return { ...BASE_SETTINGS, ...overrides };
}

interface FakeServer extends ConnectableServer {
  readonly connected: readonly Transport[];
  readonly closeCalls: number;
}

function fakeServer(): FakeServer {
  const connected: Transport[] = [];
  let closeCalls = 0;
  return {
    connect(transport: Transport): Promise<void> {
      connected.push(transport);
      return transport.start();
    },
    close(): Promise<void> {
      closeCalls += 1;
      return Promise.resolve();
    },
    get connected(): readonly Transport[] {
      return connected;
    },
    get closeCalls(): number {
      return closeCalls;
    },
  };
}

/** Resolves on the next macrotask tick — enough for stream events to land. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('D19: the http transport is refused with a config error naming v1.5', () => {
  assert.throws(
    () => assertTransportSupported(settingsOf({ transport: 'http' })),
    (error: unknown) => {
      assert.ok(error instanceof JiraError);
      assert.equal(error.kind, 'config');
      assert.equal(error.retryable, false);
      assert.equal(error.message, HTTP_TRANSPORT_MESSAGE);
      assert.ok(error.message.includes('v1.5'));
      assert.ok(error.remediation?.includes('JIRA_TRANSPORT=stdio'));
      return true;
    },
  );
});

test('connectTransport refuses http before it touches the server', async () => {
  const server = fakeServer();
  const logger = createFakeLogger();

  await assert.rejects(
    connectTransport(server, {
      settings: settingsOf({ transport: 'http' }),
      logger,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    }),
    (error: unknown) => error instanceof JiraError && error.kind === 'config',
  );

  assert.deepEqual(server.connected, []);
  assert.deepEqual(logger.events, []);
});

test('stdio is accepted', () => {
  assert.doesNotThrow(() => assertTransportSupported(settingsOf()));
});

// ---------------------------------------------------------------------------
// The stdio attachment
// ---------------------------------------------------------------------------

test('connect hands the server a started stdio transport that parses frames', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = fakeServer();
  const handle = await connectTransport(server, {
    settings: settingsOf(),
    logger: createFakeLogger(),
    stdin,
    stdout,
  });

  assert.equal(handle.kind, 'stdio');
  assert.deepEqual(server.connected, [handle.transport]);
  assert.equal(handle.closed, false);

  const received: unknown[] = [];
  handle.transport.onmessage = (message): void => {
    received.push(message);
  };
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  await tick();

  assert.deepEqual(received, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);

  await handle.close('sigterm');
});

test('stdin EOF closes the server and logs shutdown with reason stdin_eof', async () => {
  const stdin = new PassThrough();
  const server = fakeServer();
  const logger = createFakeLogger();
  const handle = await connectTransport(server, {
    settings: settingsOf(),
    logger,
    stdin,
    stdout: new PassThrough(),
  });

  stdin.end();
  await tick();
  await tick();

  assert.equal(server.closeCalls, 1);
  assert.equal(handle.closed, true);

  const shutdown = logger.eventsOf('shutdown');
  assert.equal(shutdown.length, 1);
  assert.deepEqual(shutdown[0]?.fields, { reason: 'stdin_eof' });
});

test('close is idempotent — the first reason is the one reported', async () => {
  const stdin = new PassThrough();
  const server = fakeServer();
  const logger = createFakeLogger();
  const handle = await connectTransport(server, {
    settings: settingsOf(),
    logger,
    stdin,
    stdout: new PassThrough(),
  });

  await handle.close('sigint');
  await handle.close('sigterm');
  stdin.end();
  await tick();
  await tick();

  assert.equal(server.closeCalls, 1);
  assert.equal(handle.closed, true);
  assert.deepEqual(
    logger.eventsOf('shutdown').map((event) => (event.fields ?? {})['reason']),
    ['sigint'],
  );
});

test('a close after EOF does not close the server twice', async () => {
  const stdin = new PassThrough();
  const server = fakeServer();
  const handle = await connectTransport(server, {
    settings: settingsOf(),
    logger: createFakeLogger(),
    stdin,
    stdout: new PassThrough(),
  });

  stdin.end();
  await tick();
  await handle.close('fatal');

  assert.equal(server.closeCalls, 1);
});

// ---------------------------------------------------------------------------
// A transport that dies on its own
//
// Every case above is a goodbye: EOF or a signal, initiated by someone who
// still holds the handle. These are the other direction — the SDK transport
// tearing itself down mid-session, which is what a hostile client's oversized
// frame produces. Nothing in the process would hear it if `connectTransport`
// did not chain `onclose`.
// ---------------------------------------------------------------------------

test('a frame that overruns the read buffer is a fatal shutdown, not a silently dead session', async () => {
  const stdin = new PassThrough();
  const server = fakeServer();
  const logger = createFakeLogger();
  const handle = await connectTransport(server, {
    settings: settingsOf(),
    logger,
    stdin,
    stdout: new PassThrough(),
  });

  const errors: unknown[] = [];
  handle.transport.onerror = (error): void => {
    errors.push(error);
  };

  // 10 MiB + 1 byte with no newline anywhere in it: the SDK's `ReadBuffer`
  // refuses to grow past its cap, the transport reports and closes itself, and
  // stdin is never ended — so the EOF path cannot be what notices.
  const megabyte = Buffer.alloc(1024 * 1024, 0x78);
  for (let i = 0; i < 10; i += 1) stdin.write(megabyte);
  stdin.write('x');
  for (let i = 0; i < 200 && !handle.closed; i += 1) await tick();

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /ReadBuffer exceeded maximum size/);
  assert.equal(handle.closed, true, 'the handle must know the session is gone');
  assert.equal(server.closeCalls, 1);
  assert.deepEqual(
    logger.eventsOf('shutdown').map((event) => (event.fields ?? {})['reason']),
    ['fatal'],
  );
});

test('closing a server that closes its own transport still reports exactly one shutdown', async () => {
  // The real SDK `Server.close()` closes the transport, whose `onclose` fires
  // back into the handle SYNCHRONOUSLY. `fakeServer` cannot show that; this one
  // does. Without the re-entrancy guard in `close`, the re-entry sees
  // `closing === undefined` and shuts down a second time.
  const stdin = new PassThrough();
  const logger = createFakeLogger();
  let closeCalls = 0;
  let attached: Transport | undefined;
  const server: ConnectableServer = {
    connect(transport: Transport): Promise<void> {
      attached = transport;
      return transport.start();
    },
    async close(): Promise<void> {
      closeCalls += 1;
      await attached?.close();
    },
  };

  const handle = await connectTransport(server, {
    settings: settingsOf(),
    logger,
    stdin,
    stdout: new PassThrough(),
  });
  await handle.close('sigterm');
  await tick();

  assert.equal(closeCalls, 1);
  assert.equal(handle.closed, true);
  assert.deepEqual(
    logger.eventsOf('shutdown').map((event) => (event.fields ?? {})['reason']),
    ['sigterm'],
  );
});

// ---------------------------------------------------------------------------
// A close that itself fails
//
// `close()` is wired into two event listeners — stdin's `end`/`close` and the
// transport's `onclose` — and an event listener has no caller to hand a
// rejection to. Both swallow, which is only defensible if the shutdown still
// happened and the failure is still visible to whoever holds the handle.
// ---------------------------------------------------------------------------

/** A server whose `close()` always rejects, with an identifiable failure. */
function unclosableServer(failure: Error): ConnectableServer {
  return {
    connect(transport: Transport): Promise<void> {
      return transport.start();
    },
    close(): Promise<void> {
      return Promise.reject(failure);
    },
  };
}

test('EOF still shuts the session down when the server refuses to close', async () => {
  const stdin = new PassThrough();
  const logger = createFakeLogger();
  const failure = new Error('the server refused to close');
  const handle = await connectTransport(unclosableServer(failure), {
    settings: settingsOf(),
    logger,
    stdin,
    stdout: new PassThrough(),
  });

  stdin.end();
  await tick();
  await tick();

  // The listener swallowed the rejection — an unhandled one would take the
  // process down, and there is no client left to answer anyway — but nothing
  // else was lost: the shutdown was logged, the handle knows the session is
  // gone, and a caller that still holds it is told what went wrong.
  assert.deepEqual(
    logger.eventsOf('shutdown').map((event) => (event.fields ?? {})['reason']),
    ['stdin_eof'],
  );
  assert.equal(handle.closed, true);
  await assert.rejects(handle.close('sigterm'), (error: unknown) => error === failure);
});

test('a transport that dies on its own reports fatal even if the close fails', async () => {
  const logger = createFakeLogger();
  const failure = new Error('the server refused to close');
  const handle = await connectTransport(unclosableServer(failure), {
    settings: settingsOf(),
    logger,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });

  // The transport tearing itself down — what an oversized frame ends in, minus
  // the 10 MiB. `onclose` is the only thing left to notice.
  await handle.transport.close();
  await tick();

  assert.deepEqual(
    logger.eventsOf('shutdown').map((event) => (event.fields ?? {})['reason']),
    ['fatal'],
  );
  assert.equal(handle.closed, true);
  await assert.rejects(handle.close('sigterm'), (error: unknown) => error === failure);
});

test('a shutdown log line is the only thing this module ever emits', async () => {
  const stdin = new PassThrough();
  const logger = createFakeLogger();
  const handle = await connectTransport(fakeServer(), {
    settings: settingsOf(),
    logger,
    stdin,
    stdout: new PassThrough(),
  });

  assert.equal(logger.events.length, 0, 'attaching is silent — stdout is the protocol');

  await handle.close('sigterm');

  assert.deepEqual(
    logger.events.map((event) => event.event),
    ['shutdown'],
  );
});
