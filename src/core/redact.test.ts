import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PLACEHOLDER, createRedactor, stripCredentialShapes } from './redact.js';

const TOKEN = 'ATATT3xFfGF0-super-secret-token-value';

describe('createRedactor — registered secrets', () => {
  it('masks a registered secret in free text', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const output = redactor.redactString(`request failed with token ${TOKEN} attached`);

    assert.ok(!output.includes(TOKEN));
    assert.ok(output.includes(DEFAULT_PLACEHOLDER));
  });

  it('masks a registered secret inside a URL query string', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const output = redactor.redactString(
      `https://example.atlassian.net/rest/api/3/myself?api_token=${TOKEN}&expand=groups`,
    );

    assert.ok(!output.includes(TOKEN));
    assert.ok(output.includes('expand=groups'), 'non-secret query data was destroyed');
  });

  it('masks a percent-encoded secret', () => {
    const secret = 'tok en/with+chars';
    const redactor = createRedactor({ secrets: [secret] });
    const output = redactor.redactString(`?t=${encodeURIComponent(secret)}`);

    assert.ok(!output.includes(encodeURIComponent(secret)));
    assert.ok(output.includes(DEFAULT_PLACEHOLDER));
  });

  it('masks a registered secret inside a serialized JSON blob', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const blob = JSON.stringify({ auth: { headers: { token: TOKEN } }, ok: false });
    const output = redactor.redactString(blob);

    assert.ok(!output.includes(TOKEN));
    assert.equal((JSON.parse(output) as { ok: boolean }).ok, false);
  });

  it('is not defeated by JSON escaping', () => {
    // A token carrying a quote and a backslash reaches a log line ESCAPED. A
    // literal-only match would sail straight past it.
    const secret = 'pa"ss\\word\ttab';
    const redactor = createRedactor({ secrets: [secret] });
    const line = JSON.stringify({ fields: { detail: `auth=${secret}` } });

    assert.ok(
      line.includes('pa\\"ss'),
      'precondition: the secret is escaped in the line',
    );

    const output = redactor.redactString(line);
    assert.ok(!output.includes(secret), 'raw form survived');
    assert.ok(
      !output.includes(JSON.stringify(secret).slice(1, -1)),
      'escaped form survived',
    );
  });

  it('registers secrets discovered later via addSecret', () => {
    const redactor = createRedactor();
    assert.ok(redactor.redactString(TOKEN).includes(TOKEN));

    redactor.addSecret(TOKEN);
    assert.equal(redactor.redactString(TOKEN), DEFAULT_PLACEHOLDER);
  });

  it('ignores an empty secret rather than blanking every line', () => {
    const redactor = createRedactor({ secrets: [''] });
    redactor.addSecret('');
    assert.equal(redactor.redactString('issue PROJ-1 updated'), 'issue PROJ-1 updated');
  });

  it('prefers the longest match when one secret prefixes another', () => {
    const redactor = createRedactor({ secrets: ['abc', 'abcdef'] });
    assert.equal(redactor.redactString('abcdef'), DEFAULT_PLACEHOLDER);
  });

  it('treats a secret full of regex metacharacters literally', () => {
    const secret = '.*+?[](){}|^$';
    const redactor = createRedactor({ secrets: [secret] });

    assert.equal(redactor.redactString(`x${secret}y`), `x${DEFAULT_PLACEHOLDER}y`);
    assert.equal(redactor.redactString('anything else'), 'anything else');
  });

  it('honours a custom placeholder', () => {
    const redactor = createRedactor({ secrets: [TOKEN], placeholder: '***' });
    assert.equal(redactor.redactString(TOKEN), '***');
  });

  it('is idempotent', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const once = redactor.redactString(`Authorization: Basic ${TOKEN}`);
    assert.equal(redactor.redactString(once), once);
  });
});

describe('stripCredentialShapes', () => {
  it('masks an Authorization header value but keeps name and scheme', () => {
    const output = stripCredentialShapes('Authorization: Basic dXNlckB4LmNvbTp0b2tlbg==');

    assert.ok(output.startsWith('Authorization: Basic '));
    assert.ok(!output.includes('dXNlckB4LmNvbTp0b2tlbg=='));
  });

  it('masks a bearer token that was never registered', () => {
    const output = stripCredentialShapes(
      'sent Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig now',
    );

    assert.ok(!output.includes('eyJhbGciOiJIUzI1NiJ9.payload.sig'));
    assert.ok(output.includes('Bearer '));
  });

  it('masks Atlassian URL-auth and token-bearing query parameters', () => {
    const output = stripCredentialShapes(
      '/rest/api/3/myself?os_authType=basic&os_password=hunter2&jql=project%3DPROJ',
    );

    assert.ok(!output.includes('hunter2'));
    assert.ok(output.includes('jql=project%3DPROJ'), 'workspace data must survive');
  });

  it('masks a Cookie echo', () => {
    const output = stripCredentialShapes('cookie: JSESSIONID=8A1B2C3D4E5F');
    assert.ok(!output.includes('8A1B2C3D4E5F'));
  });

  it('leaves ordinary text alone', () => {
    const text = 'GET /rest/api/3/issue/{key} → 200 in 143 ms';
    assert.equal(stripCredentialShapes(text), text);
  });
});

describe('createRedactor — deep values', () => {
  it('walks nested objects and arrays', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const output = redactor.redact({
      profile: { name: 'default', token: TOKEN },
      history: [{ token: TOKEN }, 'clean'],
    });

    assert.ok(!JSON.stringify(output).includes(TOKEN));
    assert.equal(JSON.stringify(output).includes('"name":"default"'), true);
  });

  it('scrubs object keys as well as values', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const output = redactor.redact({ [TOKEN]: 'value' }) as Record<string, unknown>;

    assert.deepEqual(Object.keys(output), [DEFAULT_PLACEHOLDER]);
  });

  it('passes numbers and booleans through and stringifies bigint', () => {
    const redactor = createRedactor();
    assert.deepEqual(redactor.redact({ n: 42, b: true, big: 9_007_199_254_740_993n }), {
      n: 42,
      b: true,
      big: '9007199254740993',
    });
  });

  it('preserves null and undefined', () => {
    const redactor = createRedactor();
    assert.deepEqual(redactor.redact({ a: null, b: undefined }), {
      a: null,
      b: undefined,
    });
  });

  it('copies Date values', () => {
    const redactor = createRedactor();
    const output = redactor.redact({ at: new Date(1_700_000_000_000) }) as { at: Date };

    assert.ok(output.at instanceof Date);
    assert.equal(output.at.getTime(), 1_700_000_000_000);
  });

  it('denies non-plain objects wholesale', () => {
    const redactor = createRedactor();
    const output = redactor.redact({
      map: new Map([['token', TOKEN]]),
      set: new Set([TOKEN]),
    });

    assert.deepEqual(output, { map: DEFAULT_PLACEHOLDER, set: DEFAULT_PLACEHOLDER });
    assert.ok(!JSON.stringify(output).includes(TOKEN));
  });

  it('replaces functions and symbols with the placeholder', () => {
    const redactor = createRedactor();
    assert.deepEqual(redactor.redact({ fn: () => TOKEN, sym: Symbol('s') }), {
      fn: DEFAULT_PLACEHOLDER,
      sym: DEFAULT_PLACEHOLDER,
    });
  });

  it('marks cycles instead of recursing forever', () => {
    const redactor = createRedactor();
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    const output = redactor.redact(node) as Record<string, unknown>;
    assert.equal(output.self, '[CIRCULAR]');
  });

  it('denies structures deeper than the depth cap', () => {
    const redactor = createRedactor();
    let deep: Record<string, unknown> = { token: TOKEN };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };

    const serialized = JSON.stringify(redactor.redact(deep));
    assert.ok(serialized.includes('[MAX_DEPTH]'));
    assert.ok(!serialized.includes(TOKEN));
  });

  it('projects an Error without its stack and keeps own fields', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    const error = Object.assign(new Error(`bad token ${TOKEN}`), {
      kind: 'auth',
      httpStatus: 401,
    });

    const output = redactor.redact(error) as Record<string, unknown>;

    assert.equal(output.name, 'Error');
    assert.equal(typeof output.message, 'string');
    assert.ok(!(output.message as string).includes(TOKEN));
    assert.equal(output.kind, 'auth');
    assert.equal(output.httpStatus, 401);
    assert.equal(output.stack, undefined, 'the stack must never reach a sink');
  });

  it('never throws on a property whose getter throws', () => {
    const redactor = createRedactor();
    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
      safe: 'kept',
    };

    const output = redactor.redact(hostile) as Record<string, unknown>;
    assert.equal(output.boom, '[UNREADABLE]');
    assert.equal(output.safe, 'kept');
  });

  it('redacts a bare string or leaves a primitive untouched', () => {
    const redactor = createRedactor({ secrets: [TOKEN] });
    assert.equal(redactor.redact(TOKEN), DEFAULT_PLACEHOLDER);
    assert.equal(redactor.redact(7), 7);
  });
});
