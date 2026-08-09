import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MESSAGE_DETAIL_MAX,
  NON_JSON_DETAIL_MAX,
  REMEDIATION,
  bodySnippet,
  createJiraError,
  errorFromResponse,
  extractJiraMessages,
  isJiraError,
  kindForStatus,
  toErrorRecord,
  toJiraError,
  toLogFields,
} from './errors.js';
import { createLogger } from './log.js';
import { createRedactor } from './redact.js';
import { JIRA_ERROR_KINDS, JiraError, RETRYABLE_ERROR_KINDS } from './types.js';
import type { Logger, Redactor } from './types.js';

const TOKEN = 'ATATT3xFfGF0-super-secret-token-value';

describe('kindForStatus', () => {
  it('maps the documented statuses onto the frozen kind catalog', () => {
    const table: ReadonlyArray<readonly [number, string]> = [
      [400, 'validation'],
      [401, 'auth'],
      [402, 'unsupported'],
      [403, 'permission'],
      [404, 'not_found'],
      [405, 'validation'],
      [408, 'timeout'],
      [409, 'validation'],
      [410, 'not_found'],
      [413, 'validation'],
      [415, 'validation'],
      [422, 'validation'],
      [429, 'rate_limited'],
      [500, 'transport'],
      [502, 'transport'],
      [503, 'transport'],
      [504, 'transport'],
      [501, 'unsupported'],
    ];

    for (const [status, kind] of table) {
      assert.equal(kindForStatus(status), kind, `status ${status}`);
    }
  });

  it('falls back by range for an unlisted status', () => {
    assert.equal(kindForStatus(418), 'validation');
    assert.equal(kindForStatus(599), 'transport');
  });

  it('reads a 403 carrying Jira login-denied headers as auth (CC-18)', () => {
    assert.equal(
      kindForStatus(403, {
        headers: { 'x-authentication-denied-reason': 'CAPTCHA_CHALLENGE' },
      }),
      'auth',
    );
    assert.equal(
      kindForStatus(403, { headers: { 'x-failed-login-count': '3' } }),
      'auth',
    );
    assert.equal(
      kindForStatus(403, {
        headers: { 'x-seraph-loginreason': 'AUTHENTICATION_DENIED' },
      }),
      'auth',
    );
  });

  it('leaves an ordinary 403 a permission error', () => {
    assert.equal(
      kindForStatus(403, { headers: { 'x-seraph-loginreason': 'OK' } }),
      'permission',
    );
    assert.equal(
      kindForStatus(403, { headers: { 'content-type': 'application/json' } }),
      'permission',
    );
  });

  it('reads an Agile-root 403/404 as unsupported (CC-34)', () => {
    assert.equal(kindForStatus(403, { apiRoot: 'agile' }), 'unsupported');
    assert.equal(kindForStatus(404, { apiRoot: 'agile' }), 'unsupported');
    assert.equal(kindForStatus(404, { apiRoot: 'v3' }), 'not_found');
    assert.equal(kindForStatus(400, { apiRoot: 'agile' }), 'validation');
  });
});

describe('extractJiraMessages', () => {
  it('reads the errorMessages[] shape', () => {
    assert.deepEqual(
      extractJiraMessages({ errorMessages: ['Issue does not exist.'], errors: {} }),
      ['Issue does not exist.'],
    );
  });

  it('flattens the errors{} shape as "field: message"', () => {
    assert.deepEqual(
      extractJiraMessages({
        errorMessages: [],
        errors: { summary: 'Field is required.', customfield_10011: 'Invalid value.' },
      }),
      ['summary: Field is required.', 'customfield_10011: Invalid value.'],
    );
  });

  it('reads the bare message shape', () => {
    assert.deepEqual(extractJiraMessages({ message: 'Board not found' }), [
      'Board not found',
    ]);
  });

  it('keeps the documented precedence when several shapes are present', () => {
    assert.deepEqual(
      extractJiraMessages({
        errorMessages: ['first'],
        errors: { field: 'second' },
        message: 'third',
      }),
      ['first', 'field: second', 'third'],
    );
  });

  it('drops duplicates, blanks and non-string entries', () => {
    assert.deepEqual(
      extractJiraMessages({
        errorMessages: ['dup', 'dup', '   ', 42],
        errors: { a: { nested: true } },
        message: 'dup',
      }),
      ['dup'],
    );
  });

  it('returns nothing for a body that is not a Jira error object', () => {
    assert.deepEqual(extractJiraMessages('<html>502 Bad Gateway</html>'), []);
    assert.deepEqual(extractJiraMessages(null), []);
    assert.deepEqual(extractJiraMessages(undefined), []);
    assert.deepEqual(extractJiraMessages([{ errorMessages: ['x'] }]), []);
    assert.deepEqual(extractJiraMessages({ unrelated: true }), []);
  });
});

describe('bodySnippet (CC-15)', () => {
  it('returns a bounded, whitespace-collapsed snippet of a non-JSON body', () => {
    const html = `<html>\n  <body>\n    ${'proxy denied '.repeat(60)}\n  </body>\n</html>`;
    const snippet = bodySnippet(html);

    assert.ok(snippet);
    assert.ok(snippet.length <= NON_JSON_DETAIL_MAX);
    assert.ok(!snippet.includes('\n'));
    assert.ok(snippet.endsWith('…'), 'a truncated snippet must say so');
  });

  it('redacts the snippet', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const snippet = bodySnippet(`<pre>token ${TOKEN}</pre>`, redactor);

    assert.ok(snippet);
    assert.ok(!snippet.includes(TOKEN));
  });

  it('strips credential shapes even without a redactor', () => {
    const snippet = bodySnippet(
      'denied for Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.a.b',
    );
    assert.ok(snippet);
    assert.ok(!snippet.includes('eyJhbGciOiJIUzI1NiJ9.a.b'));
  });

  it('returns nothing for a parsed JSON body or an empty one', () => {
    assert.equal(bodySnippet({ errorMessages: ['x'] }), undefined);
    assert.equal(bodySnippet(undefined), undefined);
    assert.equal(bodySnippet('   '), undefined);
  });
});

describe('REMEDIATION', () => {
  it('covers every frozen kind with non-empty text', () => {
    for (const kind of JIRA_ERROR_KINDS) {
      assert.equal(typeof REMEDIATION[kind], 'string');
      assert.ok(REMEDIATION[kind].length > 20, `remediation too thin for ${kind}`);
    }
    assert.deepEqual(Object.keys(REMEDIATION).sort(), [...JIRA_ERROR_KINDS].sort());
  });

  it('warns that a 404 may really be a permission problem (CC-16)', () => {
    assert.match(REMEDIATION.not_found, /permission/i);
  });

  it('mentions token expiry for auth failures (CC-17)', () => {
    assert.match(REMEDIATION.auth, /expire|token/i);
  });

  it('tells the caller to verify rather than retry an ambiguous write', () => {
    assert.match(REMEDIATION.ambiguous_write, /NOT\b|not retried/);
    assert.match(REMEDIATION.ambiguous_write, /duplicate/i);
  });
});

describe('createJiraError', () => {
  it('builds cause-then-remediation messages', () => {
    const error = createJiraError({
      kind: 'permission',
      reason: 'Jira returned HTTP 403.',
    });

    assert.ok(error instanceof JiraError);
    assert.ok(error.message.startsWith('Jira returned HTTP 403. '));
    assert.ok(error.message.endsWith(REMEDIATION.permission));
    assert.equal(error.remediation, REMEDIATION.permission);
  });

  it('defaults retryable from the frozen retryable set', () => {
    for (const kind of JIRA_ERROR_KINDS) {
      const error = createJiraError({ kind, reason: 'x.' });
      assert.equal(error.retryable, RETRYABLE_ERROR_KINDS.includes(kind), kind);
    }
  });

  it('honours an explicit retryable override', () => {
    const error = createJiraError({ kind: 'transport', reason: 'x.', retryable: false });
    assert.equal(error.retryable, false);
  });

  it('omits the remediation entirely when asked', () => {
    const error = createJiraError({
      kind: 'config',
      reason: 'JIRA_SITE is missing.',
      remediation: '',
    });

    assert.equal(error.message, 'JIRA_SITE is missing.');
    assert.equal(error.remediation, undefined);
  });

  it('redacts the reason, the detail and Jira messages at construction', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const error = createJiraError({
      kind: 'auth',
      reason: `Rejected token ${TOKEN}.`,
      jiraMessages: [`token ${TOKEN} is invalid`],
      detail: `<html>${TOKEN}</html>`,
      redactor,
    });

    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!JSON.stringify(error.jiraMessages).includes(TOKEN));
    assert.ok(error.detail !== undefined && !error.detail.includes(TOKEN));
  });

  it('still strips credential shapes when no redactor is injected', () => {
    const error = createJiraError({
      kind: 'auth',
      reason: 'Rejected Authorization: Basic dXNlckB4LmNvbTp0b2tlbg==.',
    });

    assert.ok(!error.message.includes('dXNlckB4LmNvbTp0b2tlbg=='));
  });

  it('keeps the underlying error on the cause chain', () => {
    const cause = new TypeError('fetch failed');
    const error = createJiraError({ kind: 'transport', reason: 'x.', cause });
    assert.equal(error.cause, cause);
  });
});

describe('errorFromResponse', () => {
  it('maps status, route and Jira messages into one error', () => {
    const error = errorFromResponse({
      status: 404,
      method: 'GET',
      pathTemplate: '/issue/{issueIdOrKey}',
      body: {
        errorMessages: ['Issue does not exist or you do not have permission to see it.'],
      },
    });

    assert.equal(error.kind, 'not_found');
    assert.equal(error.httpStatus, 404);
    assert.equal(error.retryable, false);
    assert.ok(error.message.includes('HTTP 404'));
    assert.ok(error.message.includes('GET /issue/{issueIdOrKey}'));
    assert.deepEqual(error.jiraMessages, [
      'Issue does not exist or you do not have permission to see it.',
    ]);
    assert.ok(error.message.endsWith(REMEDIATION.not_found));
  });

  it('marks a 429 retryable', () => {
    const error = errorFromResponse({
      status: 429,
      body: { message: 'Rate limit exceeded' },
    });
    assert.equal(error.kind, 'rate_limited');
    assert.equal(error.retryable, true);
  });

  it('carries a non-JSON body as a bounded detail, never in the message (CC-15)', () => {
    const html = `<html><head><title>502</title></head><body>${'x'.repeat(1_000)}</body></html>`;
    const error = errorFromResponse({
      status: 502,
      method: 'POST',
      pathTemplate: '/issue',
      body: html,
    });

    assert.equal(error.kind, 'transport');
    assert.ok(error.detail !== undefined);
    assert.ok(error.detail.length <= NON_JSON_DETAIL_MAX);
    assert.ok(
      !error.message.includes('x'.repeat(50)),
      'the raw body leaked into the message',
    );
    assert.ok(error.message.includes('non-JSON body'));
  });

  it('bounds the Jira messages embedded in the message', () => {
    const error = errorFromResponse({
      status: 400,
      body: {
        errorMessages: Array.from({ length: 40 }, (_, i) => `problem number ${i}`),
      },
    });

    assert.ok(
      error.message.length < MESSAGE_DETAIL_MAX + REMEDIATION.validation.length + 80,
    );
    assert.ok(error.message.includes('…'));
    assert.equal(error.jiraMessages?.length, 40, 'the full list survives on the error');
  });

  it('redacts a secret echoed back by Jira', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const error = errorFromResponse({
      status: 401,
      body: { errorMessages: [`Token ${TOKEN} is not valid`] },
      redactor,
    });

    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!JSON.stringify(toErrorRecord(error)).includes(TOKEN));
  });

  it('applies the CC-18 and CC-34 reclassifications end to end', () => {
    assert.equal(
      errorFromResponse({ status: 403, headers: { 'x-failed-login-count': '5' } }).kind,
      'auth',
    );
    assert.equal(
      errorFromResponse({ status: 404, apiRoot: 'agile' }).kind,
      'unsupported',
    );
  });

  it('accepts a kind override from the retry engine', () => {
    const error = errorFromResponse({ status: 500, kind: 'ambiguous_write' });

    assert.equal(error.kind, 'ambiguous_write');
    assert.equal(error.retryable, false);
    assert.ok(error.message.endsWith(REMEDIATION.ambiguous_write));
  });

  it('degrades gracefully when there is no body at all', () => {
    const error = errorFromResponse({ status: 503 });

    assert.equal(error.kind, 'transport');
    assert.equal(error.jiraMessages, undefined);
    assert.equal(error.detail, undefined);
    assert.ok(error.message.startsWith('Jira returned HTTP 503.'));
  });
});

describe('toJiraError', () => {
  it('passes a JiraError through untouched', () => {
    const original = createJiraError({ kind: 'validation', reason: 'x.' });
    assert.equal(toJiraError(original), original);
  });

  it('wraps a platform error as transport by default', () => {
    const error = toJiraError(new TypeError('fetch failed'));

    assert.equal(error.kind, 'transport');
    assert.ok(error.message.includes('fetch failed'));
    assert.equal(error.retryable, true);
  });

  it('accepts a kind and reason override and redacts the wrapped message', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const error = toJiraError(new Error(`bad ${TOKEN}`), { kind: 'auth', redactor });

    assert.equal(error.kind, 'auth');
    assert.ok(!error.message.includes(TOKEN));
  });

  it('handles a thrown non-error', () => {
    const error = toJiraError('something odd');
    assert.equal(error.kind, 'transport');
    assert.ok(error.message.length > 0);
  });

  it('narrows with isJiraError', () => {
    assert.equal(isJiraError(createJiraError({ kind: 'config', reason: 'x.' })), true);
    assert.equal(isJiraError(new Error('plain')), false);
    assert.equal(isJiraError('nope'), false);
  });
});

describe('toErrorRecord', () => {
  it('projects the full error', () => {
    const error = errorFromResponse({
      status: 400,
      method: 'POST',
      pathTemplate: '/issue',
      body: { errors: { summary: 'Field is required.' } },
    });

    assert.deepEqual(toErrorRecord(error), {
      kind: 'validation',
      message: error.message,
      retryable: false,
      httpStatus: 400,
      jiraMessages: ['summary: Field is required.'],
      remediation: REMEDIATION.validation,
    });
  });

  it('omits absent keys rather than emitting undefined', () => {
    const record = toErrorRecord(
      createJiraError({ kind: 'write_gated', reason: 'Blocked by the write gate.' }),
    );

    assert.deepEqual(Object.keys(record), [
      'kind',
      'message',
      'retryable',
      'remediation',
    ]);
    assert.ok(!Object.hasOwn(record, 'httpStatus'));
    assert.ok(!Object.hasOwn(record, 'detail'));
  });

  it('carries no stack, cause or non-contract key', () => {
    const record = toErrorRecord(
      createJiraError({ kind: 'transport', reason: 'x.', cause: new Error('inner') }),
    );

    const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    for (const key of Object.keys(serialized)) {
      assert.ok(
        [
          'kind',
          'message',
          'retryable',
          'httpStatus',
          'jiraMessages',
          'remediation',
          'detail',
        ].includes(key),
        `unexpected key ${key}`,
      );
    }
  });
});

describe('errors + logger compose', () => {
  const rawBody = `<html>proxy rejected credential ${TOKEN} for user@example.com</html>`;

  function logToString(emit: (log: Logger) => void, redactor: Redactor): string {
    const captured: string[] = [];
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    };

    try {
      emit(createLogger({ redactor, level: 'debug' }));
    } finally {
      process.stderr.write = originalErr;
    }
    return captured.join('');
  }

  it('logs the error projection with no secret, no body and no stack', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const error = errorFromResponse({
      status: 401,
      method: 'GET',
      pathTemplate: '/myself',
      body: rawBody,
      redactor,
    });

    const line = logToString(
      (log) =>
        log.emit('auth_failure', {
          status: 401,
          pathTemplate: '/myself',
          ...toLogFields(error),
        }),
      redactor,
    );

    assert.ok(line.includes('auth_failure'));
    assert.ok(line.includes('"errorKind":"auth"'));
    assert.ok(!line.includes(TOKEN), 'the registered secret reached stderr');
    assert.ok(!line.includes('<html>'), 'the raw response body reached stderr');
    assert.ok(!line.includes('stack'), 'a stack reached stderr');
  });

  it('still redacts the secret if a whole error object is logged by mistake', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const error = errorFromResponse({ status: 401, body: rawBody, redactor });

    const line = logToString((log) => log.emit('auth_failure', { error }), redactor);

    assert.ok(!line.includes(TOKEN));
    assert.ok(!line.includes('stack'));
  });
});
