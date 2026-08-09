import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeClock } from './fakes/fakeClock.js';
import {
  DEFAULT_LOG_LEVEL,
  LOG_LINE_KEYS,
  NO_CID,
  createLogger,
  currentCid,
  newCorrelationId,
  runWithCid,
} from './log.js';
import { createRedactor } from './redact.js';
import { LOG_EVENTS, LOG_EVENT_LEVEL } from './types.js';
import type { LogLevel, Redactor } from './types.js';

/** A stream sink that records what it was handed instead of writing it. */
function recorder(bucket: string[]) {
  return (chunk: string | Uint8Array): boolean => {
    bucket.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
}

interface Captured {
  readonly stdout: string[];
  readonly stderr: string[];
}

/**
 * Run `fn` with BOTH standard streams intercepted. stdout is captured not
 * because anything should land there but so a test can prove nothing did:
 * stdout is the MCP stdio channel and one stray byte corrupts the session.
 */
function capture(fn: () => void): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  process.stdout.write = recorder(stdout);
  process.stderr.write = recorder(stderr);
  try {
    fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout, stderr };
}

function lines(captured: Captured): string[] {
  return captured.stderr.join('').split('\n').filter(Boolean);
}

interface ParsedLine {
  ts: number;
  level: LogLevel;
  event: string;
  cid: string;
  fields?: Record<string, unknown>;
}

function parse(line: string): ParsedLine {
  return JSON.parse(line) as ParsedLine;
}

describe('createLogger — sink', () => {
  it('writes one JSON line per event to stderr and nothing to stdout', () => {
    const captured = capture(() => {
      const logger = createLogger();
      logger.emit('server_start');
      logger.emit('shutdown');
    });

    assert.deepEqual(captured.stdout, [], 'the MCP protocol channel was written to');
    assert.equal(lines(captured).length, 2);
  });

  it('terminates every line with a newline', () => {
    const captured = capture(() => createLogger().emit('server_start'));
    assert.ok(captured.stderr.join('').endsWith('\n'));
  });

  it('survives a broken stderr pipe', () => {
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => {
      throw new Error('EPIPE');
    };

    try {
      assert.doesNotThrow(() => createLogger().emit('shutdown'));
    } finally {
      process.stderr.write = originalErr;
    }
  });
});

describe('createLogger — record shape', () => {
  it('renders keys in a stable order', () => {
    const captured = capture(() =>
      createLogger().emit('tool_call_end', { tool: 'jira_get_issue' }),
    );

    const [line] = lines(captured);
    assert.ok(line);
    assert.deepEqual(Object.keys(parse(line)), [...LOG_LINE_KEYS]);
  });

  it('omits fields when there are none', () => {
    const captured = capture(() => {
      const logger = createLogger();
      logger.emit('server_start');
      logger.emit('shutdown', {});
    });

    for (const line of lines(captured)) {
      assert.deepEqual(Object.keys(parse(line)), ['ts', 'level', 'event', 'cid']);
    }
  });

  it('stamps ts from the injected clock', () => {
    const clock = createFakeClock(1_700_000_000_000);
    const captured = capture(() => createLogger({ clock }).emit('server_start'));

    const [line] = lines(captured);
    assert.ok(line);
    assert.equal(parse(line).ts, 1_700_000_000_000);
  });

  it('takes the level from the event table, not the call site', () => {
    const captured = capture(() => {
      const logger = createLogger({ level: 'debug' });
      for (const event of LOG_EVENTS) logger.emit(event);
    });

    const emitted = lines(captured).map(parse);
    assert.equal(emitted.length, LOG_EVENTS.length);
    for (const record of emitted) {
      assert.equal(
        record.level,
        LOG_EVENT_LEVEL[record.event as (typeof LOG_EVENTS)[number]],
      );
    }
  });

  it('passes the caller fields through', () => {
    const captured = capture(() =>
      createLogger({ level: 'debug' }).emit('http_response', {
        status: 200,
        durationMs: 143,
      }),
    );

    const [line] = lines(captured);
    assert.ok(line);
    assert.deepEqual(parse(line).fields, { status: 200, durationMs: 143 });
  });
});

describe('createLogger — level filtering', () => {
  it('defaults to info, dropping debug events', () => {
    assert.equal(DEFAULT_LOG_LEVEL, 'info');

    const captured = capture(() => {
      const logger = createLogger();
      logger.emit('tool_call_start');
      logger.emit('http_request');
      logger.emit('tool_call_end');
    });

    assert.deepEqual(
      lines(captured).map((line) => parse(line).event),
      ['tool_call_end'],
    );
  });

  it('drops everything below the configured level', () => {
    const captured = capture(() => {
      const logger = createLogger({ level: 'warn' });
      logger.emit('tool_call_start'); // debug
      logger.emit('server_start'); // info
      logger.emit('http_retry'); // warn
      logger.emit('ambiguous_write'); // error
    });

    assert.deepEqual(
      lines(captured).map((line) => parse(line).event),
      ['http_retry', 'ambiguous_write'],
    );
  });

  it('at error level emits only the error events', () => {
    const captured = capture(() => {
      const logger = createLogger({ level: 'error' });
      for (const event of LOG_EVENTS) logger.emit(event);
    });

    const expected = LOG_EVENTS.filter((event) => LOG_EVENT_LEVEL[event] === 'error');
    assert.deepEqual(
      lines(captured).map((line) => parse(line).event),
      [...expected],
    );
  });

  it('at debug level emits the whole table', () => {
    const captured = capture(() => {
      const logger = createLogger({ level: 'debug' });
      for (const event of LOG_EVENTS) logger.emit(event);
    });

    assert.equal(lines(captured).length, LOG_EVENTS.length);
  });
});

describe('createLogger — correlation id', () => {
  it('uses the no-call marker outside a tool call', () => {
    const captured = capture(() => createLogger().emit('server_start'));

    const [line] = lines(captured);
    assert.ok(line);
    assert.equal(parse(line).cid, NO_CID);
  });

  it('stamps the id bound by withCid', () => {
    const captured = capture(() =>
      createLogger().withCid('c-4f9a01').emit('tool_call_end'),
    );

    const [line] = lines(captured);
    assert.ok(line);
    assert.equal(parse(line).cid, 'c-4f9a01');
  });

  it('leaves the parent logger unbound', () => {
    const captured = capture(() => {
      const root = createLogger();
      root.withCid('c-4f9a01').emit('tool_call_end');
      root.emit('shutdown');
    });

    assert.deepEqual(
      lines(captured).map((line) => parse(line).cid),
      ['c-4f9a01', NO_CID],
    );
  });

  it('picks up the ambient id from runWithCid', () => {
    const captured = capture(() => {
      const logger = createLogger();
      runWithCid('c-abc123', () => {
        logger.emit('tool_call_end');
      });
      logger.emit('shutdown');
    });

    assert.deepEqual(
      lines(captured).map((line) => parse(line).cid),
      ['c-abc123', NO_CID],
    );
  });

  it('propagates the ambient id across an await boundary', async () => {
    const logger = createLogger({ level: 'debug' });
    const captured: string[] = [];
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = recorder(captured);

    try {
      await runWithCid('c-deep01', async () => {
        await Promise.resolve();
        logger.emit('http_response', { status: 200 });
      });
    } finally {
      process.stderr.write = originalErr;
    }

    const [line] = captured.join('').split('\n').filter(Boolean);
    assert.ok(line);
    assert.equal(parse(line).cid, 'c-deep01');
  });

  it('lets an explicitly bound id win over the ambient one', () => {
    const captured = capture(() => {
      runWithCid('c-ambient', () => {
        createLogger({ cid: 'c-bound1' }).emit('tool_call_end');
      });
    });

    const [line] = lines(captured);
    assert.ok(line);
    assert.equal(parse(line).cid, 'c-bound1');
  });

  it('exposes the ambient id and nothing outside a call', () => {
    assert.equal(currentCid(), undefined);
    runWithCid('c-000001', () => {
      assert.equal(currentCid(), 'c-000001');
    });
    assert.equal(currentCid(), undefined);
  });
});

describe('newCorrelationId', () => {
  it('mints a c-XXXXXX id from the injected rng', () => {
    assert.equal(
      newCorrelationId(() => 0),
      'c-000000',
    );
    assert.equal(
      newCorrelationId(() => 0.5),
      'c-800000',
    );
    assert.match(
      newCorrelationId(() => 0.999_999_9),
      /^c-[0-9a-f]{6}$/,
    );
  });

  it('clamps an out-of-contract rng instead of widening the id', () => {
    assert.equal(
      newCorrelationId(() => 1),
      'c-ffffff',
    );
    assert.match(
      newCorrelationId(() => Number.NaN),
      /^c-[0-9a-f]{6}$/,
    );
    assert.match(
      newCorrelationId(() => -3),
      /^c-[0-9a-f]{6}$/,
    );
  });
});

describe('createLogger — redaction', () => {
  const TOKEN = 'ATATT3xFfGF0-super-secret-token-value';

  it('never lets a registered secret reach a log line, in any position', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const captured = capture(() => {
      const logger = createLogger({ redactor, level: 'debug' });
      logger.emit('http_request', { note: `token ${TOKEN}` });
      logger.emit('http_request', {
        url: `https://x.atlassian.net/rest?api_token=${TOKEN}`,
      });
      logger.emit('http_request', { body: { auth: { token: TOKEN } } });
      logger.emit('http_request', { [TOKEN]: 'used as a key' });
      logger.emit('auth_failure', { header: `Authorization: Basic ${TOKEN}` });
    });

    const output = captured.stderr.join('');
    assert.equal(lines(captured).length, 5, 'precondition: every event was emitted');
    assert.ok(!output.includes(TOKEN), 'a registered secret reached stderr');
  });

  it('is not defeated by JSON escaping of the secret', () => {
    const secret = 'sec"ret\\value';
    const redactor = createRedactor({ secrets: [secret] });
    const captured = capture(() =>
      createLogger({ redactor }).emit('auth_failure', { detail: `token=${secret}` }),
    );

    const output = captured.stderr.join('');
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes(JSON.stringify(secret).slice(1, -1)));
  });

  it('masks credential shapes even with no redactor injected', () => {
    const captured = capture(() =>
      createLogger().emit('auth_failure', {
        header: 'authorization: Basic dXNlckB4LmNvbTp0b2tlbg==',
      }),
    );

    assert.ok(!captured.stderr.join('').includes('dXNlckB4LmNvbTp0b2tlbg=='));
  });

  it('redacts the correlation id too', () => {
    const redactor = createRedactor({ secrets: ['c-secret'] });
    const captured = capture(() =>
      createLogger({ redactor }).withCid('c-secret').emit('tool_call_end'),
    );

    const [line] = lines(captured);
    assert.ok(line);
    assert.equal(parse(line).cid, '[REDACTED]');
  });
});

describe('createLogger — failure containment', () => {
  it('degrades to a marker instead of throwing when rendering fails', () => {
    const hostile: Redactor = {
      redact: () => {
        throw new Error('redactor exploded');
      },
      redactString: (text: string) => text,
      addSecret: () => undefined,
    };

    const captured = capture(() => {
      assert.doesNotThrow(() =>
        createLogger({ redactor: hostile }).emit('tool_call_end', {
          tool: 'jira_search',
        }),
      );
    });

    const [line] = lines(captured);
    assert.ok(line);
    const record = parse(line);
    assert.equal(record.event, 'tool_call_end');
    assert.deepEqual(record.fields, { log_error: 'log_fields_dropped' });
  });
});
