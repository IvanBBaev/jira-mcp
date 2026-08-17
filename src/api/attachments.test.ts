// Tests for api/attachments.ts — metadata, downloads and uploads (WP-70).
//
// Contract tier (TESTING.md §Mocking tiers): every case drives the module
// through `fakeJiraRequest` plus an in-memory {@link MediaStore}, so neither a
// socket nor a real filesystem is involved. What is asserted is what this ring
// promises — the request it builds, the allowlist it narrows a response down
// to, and the two filename rules that make the media directory a boundary
// rather than a suggestion (D45).
//
// Bodies are inline plain objects marked `// synthetic`, shaped field-for-field
// like real Jira Cloud v3 attachment records and using the placeholder
// vocabulary the fixture PII lint enforces (`example.atlassian.net`,
// `5b10a2844c20165700ede21g`-style accountIds).
//
// The sanitization table is the load-bearing part of this file: a filename on
// an attachment is tenant-controlled text that this server turns into a path,
// which is the one place where a hostile Jira project could otherwise reach
// outside the directory an operator opened to it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeClock, createFakeJiraRequest, jiraOk } from '../core/fakes/index.js';
import type { FakeJiraRequest } from '../core/fakes/index.js';
import { MAX_ATTACHMENT_BYTES } from '../core/http-util.js';
import { JiraError } from '../core/types.js';
import type { JiraRequestSpec } from '../core/types.js';
import {
  ATTACHMENT_CONTENT_PATH_TEMPLATE,
  ATTACHMENT_PATH_TEMPLATE,
  DEFAULT_ATTACHMENT_MIME,
  FALLBACK_MEDIA_NAME,
  ISSUE_ATTACHMENTS_PATH_TEMPLATE,
  ISSUE_PATH_TEMPLATE,
  MAX_MEDIA_NAME_CHARS,
  UPLOAD_FIELD_NAME,
  downloadAttachment,
  getAttachment,
  listAttachments,
  requireLocalName,
  safeMediaName,
  uploadAttachment,
} from './attachments.js';
import type { MediaReadResult, MediaStore, MediaWriteResult } from './attachments.js';

const SITE = 'https://example.atlassian.net';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to reject');
}

function asJiraError(error: unknown): JiraError {
  assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
  return error;
}

/** Index into a mapped list; `noUncheckedIndexedAccess` makes `[0]` optional. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, got ${String(item)}`);
  }
  return item;
}

function lastSpec(jira: FakeJiraRequest): JiraRequestSpec {
  const spec = jira.lastRequest();
  assert.ok(spec !== undefined, 'expected a request to have been made');
  return spec;
}

/** A recording, in-memory {@link MediaStore}. No `node:fs` in this ring. */
interface FakeStore extends MediaStore {
  readonly writes: readonly MediaWriteResult[];
  readonly reads: readonly string[];
  /** Seed a readable file. */
  put(name: string, bytes: Uint8Array): FakeStore;
}

function createFakeStore(dir = '/media'): FakeStore {
  const files = new Map<string, Uint8Array>();
  const writes: MediaWriteResult[] = [];
  const reads: string[] = [];
  const store: FakeStore = {
    dir,
    writes,
    reads,
    put(name, bytes) {
      files.set(name, bytes);
      return store;
    },
    write(name, bytes): Promise<MediaWriteResult> {
      // Mirrors the real store's contract: never overwrite, report the name
      // actually used.
      let candidate = name;
      for (let i = 1; files.has(candidate); i += 1) candidate = `${name}-${String(i)}`;
      files.set(candidate, bytes);
      const result: MediaWriteResult = {
        name: candidate,
        path: `${dir}/${candidate}`,
        bytes: bytes.byteLength,
      };
      writes.push(result);
      return Promise.resolve(result);
    },
    read(name): Promise<MediaReadResult> {
      reads.push(name);
      const bytes = files.get(name);
      if (bytes === undefined) {
        return Promise.reject(new Error(`no such fake file: ${name}`));
      }
      return Promise.resolve({ path: `${dir}/${name}`, bytes });
    },
  };
  return store;
}

/** One attachment record, as Jira sends it. // synthetic */
function attachmentRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    self: `${SITE}/rest/api/3/attachment/10001`,
    id: '10001',
    filename: 'report.pdf',
    author: {
      self: `${SITE}/rest/api/3/user?accountId=${ACCOUNT_ID}`,
      accountId: ACCOUNT_ID,
      displayName: 'User One',
      active: true,
      avatarUrls: { '48x48': `${SITE}/secure/useravatar?size=large` },
    },
    created: '2026-01-02T03:04:05.000+0000',
    size: 4096,
    mimeType: 'application/pdf',
    // The three URLs the mapper must never pass on: `content` is a signed
    // download link, which is a credential a model has no use for.
    content: `${SITE}/secure/attachment/10001/report.pdf`,
    thumbnail: `${SITE}/secure/thumbnail/10001/report.pdf`,
    ...overrides,
  };
}

/** An issue read with `fields=attachment`. // synthetic */
function issueWithAttachments(rows: readonly unknown[]): Record<string, unknown> {
  return {
    id: '10000',
    key: 'ABC-1',
    self: `${SITE}/rest/api/3/issue/10000`,
    fields: { attachment: rows },
  };
}

// ---------------------------------------------------------------------------
// safeMediaName — Jira-supplied names are untrusted (D45)
// ---------------------------------------------------------------------------

test('safeMediaName reduces every hostile filename to a basename', () => {
  const cases: readonly (readonly [string, string])[] = [
    // Plain names survive untouched — sanitizing must not be lossy for the
    // 99% case, or every download would look "renamed".
    ['report.pdf', 'report.pdf'],
    ['Q3 summary (final).xlsx', 'Q3 summary (final).xlsx'],
    ['доклад.pdf', 'доклад.pdf'],
    // Traversal, POSIX and Windows.
    ['../../etc/passwd', 'passwd'],
    ['/etc/shadow', 'shadow'],
    ['..\\..\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
    ['C:\\Users\\me\\.ssh\\id_rsa', 'id_rsa'],
    // A name that is nothing BUT traversal has no basename left.
    ['..', FALLBACK_MEDIA_NAME],
    ['../..', FALLBACK_MEDIA_NAME],
    ['/', FALLBACK_MEDIA_NAME],
    // Dotfiles: a download must not quietly drop something into place under a
    // name the operator would not notice.
    ['.bashrc', 'bashrc'],
    ['...hidden.txt', 'hidden.txt'],
    // Control characters, including the NUL a C-level path API would truncate
    // at and the newline that would forge a second line in a log.
    ['re\u0000port.pdf', 'report.pdf'],
    ['re\nport\tx.pdf', 'reportx.pdf'],
    ['\u007fdel.txt', 'del.txt'],
    // Characters Windows refuses outright.
    ['a:b|c?d*e"f<g>h.txt', 'abcdefgh.txt'],
    // Trailing dots and spaces: Windows strips them on creation, so a check
    // that ran after them would compare the wrong name.
    ['report.pdf...', 'report.pdf'],
    ['report.pdf   ', 'report.pdf'],
    // Windows device names are unusable as files even with an extension.
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['console.txt', 'console.txt'],
    // Nothing printable survives.
    ['\u0001\u0002', FALLBACK_MEDIA_NAME],
    ['   ', FALLBACK_MEDIA_NAME],
    ['', FALLBACK_MEDIA_NAME],
  ];

  for (const [raw, expected] of cases) {
    assert.equal(safeMediaName(raw), expected, `safeMediaName(${JSON.stringify(raw)})`);
  }
});

test('safeMediaName caps the length and keeps a short extension', () => {
  const long = `${'a'.repeat(400)}.pdf`;
  const result = safeMediaName(long);

  assert.equal(result.length, MAX_MEDIA_NAME_CHARS);
  assert.ok(result.endsWith('.pdf'), 'the extension must survive the truncation');

  // A "extension" longer than the allowance is just more name: keeping it
  // would spend the whole budget on a suffix nothing can open.
  const oddSuffix = safeMediaName(`${'b'.repeat(400)}.thisisnotanextension`);
  assert.equal(oddSuffix.length, MAX_MEDIA_NAME_CHARS);
  assert.equal(oddSuffix, 'b'.repeat(MAX_MEDIA_NAME_CHARS));
});

// ---------------------------------------------------------------------------
// requireLocalName — model-supplied names are REFUSED, never rewritten (D45)
// ---------------------------------------------------------------------------

test('requireLocalName accepts a plain basename and trims it', () => {
  assert.equal(requireLocalName('report.pdf'), 'report.pdf');
  assert.equal(requireLocalName('  report.pdf  '), 'report.pdf');
  assert.equal(requireLocalName('Q3 summary (final).xlsx'), 'Q3 summary (final).xlsx');
});

test('requireLocalName refuses anything that is not a name in the media directory', () => {
  const cases: readonly string[] = [
    '',
    '   ',
    '.',
    '..',
    '../secrets.env',
    './report.pdf',
    '.env',
    'sub/report.pdf',
    'sub\\report.pdf',
    '/etc/passwd',
    'C:\\Users\\me\\id_rsa',
    'report.pdf\u0000.png',
    'report\n.pdf',
    'a'.repeat(MAX_MEDIA_NAME_CHARS + 1),
  ];

  for (const raw of cases) {
    let error: unknown;
    try {
      requireLocalName(raw);
    } catch (thrown) {
      error = thrown;
    }
    const err = asJiraError(error);
    assert.equal(err.kind, 'validation', `requireLocalName(${JSON.stringify(raw)})`);
    assert.match(err.remediation ?? '', /JIRA_MEDIA_DIR/);
  }
});

// ---------------------------------------------------------------------------
// listAttachments
// ---------------------------------------------------------------------------

test('listAttachments reads the issue with fields=attachment', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(issueWithAttachments([attachmentRow()])),
  );

  const result = await listAttachments({ jira: jira.fn, issueKey: 'ABC-1' });

  assert.deepEqual(jira.routes(), ['GET /rest/api/3/issue/ABC-1']);
  const spec = lastSpec(jira);
  assert.equal(spec.pathTemplate, ISSUE_PATH_TEMPLATE);
  assert.deepEqual(spec.query, { fields: 'attachment' });
  assert.equal(result.issueKey, 'ABC-1');
  assert.equal(result.attachments.length, 1);
});

test('listAttachments narrows a row to the allowlist and drops every URL', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(issueWithAttachments([attachmentRow()])),
  );

  const result = await listAttachments({ jira: jira.fn, issueKey: 'ABC-1' });

  assert.deepEqual(at(result.attachments, 0), {
    id: '10001',
    filename: 'report.pdf',
    size: 4096,
    mimeType: 'application/pdf',
    author: { accountId: ACCOUNT_ID, displayName: 'User One' },
    created: '2026-01-02T03:04:05.000+0000',
  });
});

test('listAttachments keeps Jira raw filename — sanitization is a disk concern', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(issueWithAttachments([attachmentRow({ filename: '../../etc/passwd' })])),
  );

  const result = await listAttachments({ jira: jira.fn, issueKey: 'ABC-1' });

  // The listing reports what Jira holds; nothing here touches a path, and a
  // rewritten name would misidentify the attachment for a later download.
  assert.equal(at(result.attachments, 0).filename, '../../etc/passwd');
});

test('listAttachments answers an empty list when the field is absent or null', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk({ key: 'ABC-1', fields: {} }))
    .enqueue(jiraOk({ key: 'ABC-1', fields: { attachment: null } }))
    .enqueue(jiraOk({ key: 'ABC-1' }));

  for (let i = 0; i < 3; i += 1) {
    const result = await listAttachments({ jira: jira.fn, issueKey: 'ABC-1' });
    assert.deepEqual(result.attachments, []);
    assert.equal(result.issueKey, 'ABC-1');
  }
});

test('listAttachments falls back to the requested key when Jira sends none', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ fields: { attachment: [] } }));

  const result = await listAttachments({ jira: jira.fn, issueKey: '10000' });

  assert.equal(result.issueKey, '10000');
});

test('listAttachments refuses a response whose shape it cannot read', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(jiraOk('not json at all'))
    .enqueue(jiraOk({ fields: { attachment: { id: '1' } } }))
    .enqueue(jiraOk(issueWithAttachments([{ filename: 'x.pdf' }])))
    .enqueue(jiraOk(issueWithAttachments([{ id: '10001' }])));

  for (let i = 0; i < 4; i += 1) {
    const err = asJiraError(
      await caught(() => listAttachments({ jira: jira.fn, issueKey: 'ABC-1' })),
    );
    assert.equal(err.kind, 'unexpected_shape');
  }
});

test('listAttachments refuses an empty issue key before any request', async () => {
  const jira = createFakeJiraRequest();

  const err = asJiraError(
    await caught(() => listAttachments({ jira: jira.fn, issueKey: '   ' })),
  );

  assert.equal(err.kind, 'validation');
  assert.equal(jira.calls.length, 0, 'nothing may reach the wire');
});

test('listAttachments forwards the signal and the deadline', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk(issueWithAttachments([])));
  const controller = new AbortController();

  await listAttachments({
    jira: jira.fn,
    issueKey: 'ABC-1',
    signal: controller.signal,
    deadlineAt: 1_700_000_000_000,
    clock: createFakeClock(1_700_000_000_000),
  });

  const spec = lastSpec(jira);
  assert.equal(spec.signal, controller.signal);
  assert.equal(spec.deadlineAt, 1_700_000_000_000);
});

// ---------------------------------------------------------------------------
// getAttachment
// ---------------------------------------------------------------------------

test('getAttachment reads one record by id and tolerates a numeric id', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk(attachmentRow({ id: 10001, size: 'huge', author: { displayName: 'X' } })),
  );

  const result = await getAttachment({ jira: jira.fn, attachmentId: '10001' });

  assert.deepEqual(jira.routes(), ['GET /rest/api/3/attachment/10001']);
  assert.equal(lastSpec(jira).pathTemplate, ATTACHMENT_PATH_TEMPLATE);
  // A non-numeric size and an author without an accountId are dropped rather
  // than passed on half-read.
  assert.deepEqual(result, {
    id: '10001',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    created: '2026-01-02T03:04:05.000+0000',
  });
});

test('getAttachment refuses an empty id before any request', async () => {
  const jira = createFakeJiraRequest();

  const err = asJiraError(
    await caught(() => getAttachment({ jira: jira.fn, attachmentId: '' })),
  );

  assert.equal(err.kind, 'validation');
  assert.equal(jira.calls.length, 0);
});

// ---------------------------------------------------------------------------
// downloadAttachment
// ---------------------------------------------------------------------------

test('downloadAttachment reads metadata, then the bytes, then writes them', async () => {
  const jira = createFakeJiraRequest()
    .on('GET /rest/api/3/attachment/10001', jiraOk(attachmentRow()))
    .on('GET /rest/api/3/attachment/content/10001', jiraOk(new Uint8Array([1, 2, 3, 4])));
  const store = createFakeStore();

  const result = await downloadAttachment({
    jira: jira.fn,
    attachmentId: '10001',
    store,
  });

  assert.deepEqual(jira.routes(), [
    'GET /rest/api/3/attachment/10001',
    'GET /rest/api/3/attachment/content/10001',
  ]);
  const spec = lastSpec(jira);
  assert.equal(spec.pathTemplate, ATTACHMENT_CONTENT_PATH_TEMPLATE);
  assert.equal(spec.accept, 'binary');
  // `redirect=false` keeps the transfer on the site host instead of a signed
  // URL on an Atlassian media host (JIRA-API.md §Attachments).
  assert.deepEqual(spec.query, { redirect: false });
  assert.deepEqual(result, {
    attachment: {
      id: '10001',
      filename: 'report.pdf',
      size: 4096,
      mimeType: 'application/pdf',
      author: { accountId: ACCOUNT_ID, displayName: 'User One' },
      created: '2026-01-02T03:04:05.000+0000',
    },
    path: '/media/report.pdf',
    name: 'report.pdf',
    bytes: 4,
    mimeType: 'application/pdf',
    renamed: false,
  });
});

test('downloadAttachment sanitizes the Jira filename before it can become a path', async () => {
  const jira = createFakeJiraRequest()
    .on(
      'GET /rest/api/3/attachment/10001',
      jiraOk(attachmentRow({ filename: '../../../etc/passwd', mimeType: undefined })),
    )
    .on('GET /rest/api/3/attachment/content/10001', jiraOk(new Uint8Array([7])));
  const store = createFakeStore();

  const result = await downloadAttachment({
    jira: jira.fn,
    attachmentId: '10001',
    store,
  });

  assert.equal(at(store.writes, 0).name, 'passwd');
  assert.equal(result.path, '/media/passwd');
  assert.equal(result.renamed, true, 'a rewritten name must be reported');
  assert.equal(result.mimeType, DEFAULT_ATTACHMENT_MIME);
});

test('downloadAttachment reports the uniquified name a collision produced', async () => {
  const jira = createFakeJiraRequest()
    .on('GET /rest/api/3/attachment/10001', jiraOk(attachmentRow()))
    .on('GET /rest/api/3/attachment/content/10001', jiraOk(new Uint8Array([1])));
  const store = createFakeStore().put('report.pdf', new Uint8Array([0]));

  const result = await downloadAttachment({
    jira: jira.fn,
    attachmentId: '10001',
    store,
  });

  assert.equal(result.name, 'report.pdf-1');
  assert.equal(result.renamed, true);
});

test('downloadAttachment without a media directory refuses and names the setting', async () => {
  const jira = createFakeJiraRequest();

  const err = asJiraError(
    await caught(() => downloadAttachment({ jira: jira.fn, attachmentId: '10001' })),
  );

  assert.equal(err.kind, 'config');
  assert.match(err.message, /JIRA_MEDIA_DIR/);
  assert.equal(jira.calls.length, 0, 'a refusal must cost nothing');
});

test('downloadAttachment refuses an oversized attachment before the transfer', async () => {
  const jira = createFakeJiraRequest().on(
    'GET /rest/api/3/attachment/10001',
    jiraOk(attachmentRow({ size: MAX_ATTACHMENT_BYTES + 1 })),
  );
  const store = createFakeStore();

  const err = asJiraError(
    await caught(() =>
      downloadAttachment({ jira: jira.fn, attachmentId: '10001', store }),
    ),
  );

  assert.equal(err.kind, 'validation');
  assert.equal(jira.calls.length, 1, 'the metadata read is the only cost');
  assert.equal(store.writes.length, 0);
});

test('downloadAttachment refuses a content response that carried no bytes', async () => {
  const jira = createFakeJiraRequest()
    .on('GET /rest/api/3/attachment/10001', jiraOk(attachmentRow()))
    .on('GET /rest/api/3/attachment/content/10001', jiraOk({ error: 'nope' }));
  const store = createFakeStore();

  const err = asJiraError(
    await caught(() =>
      downloadAttachment({ jira: jira.fn, attachmentId: '10001', store }),
    ),
  );

  assert.equal(err.kind, 'unexpected_shape');
  assert.equal(store.writes.length, 0, 'nothing may be written');
});

test('downloadAttachment refuses bytes over the cap even when the metadata lied', async () => {
  const jira = createFakeJiraRequest()
    .on('GET /rest/api/3/attachment/10001', jiraOk(attachmentRow({ size: 10 })))
    .on(
      'GET /rest/api/3/attachment/content/10001',
      // The client caps the stream itself; this covers the belt-and-braces
      // check for a transport that hands over a buffer it never metered.
      jiraOk(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)),
    );
  const store = createFakeStore();

  const err = asJiraError(
    await caught(() =>
      downloadAttachment({ jira: jira.fn, attachmentId: '10001', store }),
    ),
  );

  assert.equal(err.kind, 'validation');
  assert.equal(store.writes.length, 0);
});

// ---------------------------------------------------------------------------
// uploadAttachment
// ---------------------------------------------------------------------------

test('uploadAttachment posts one multipart part named file', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([attachmentRow()]));
  const store = createFakeStore().put('report.pdf', new Uint8Array([1, 2, 3]));

  const result = await uploadAttachment({
    jira: jira.fn,
    issueKey: 'ABC-1',
    name: 'report.pdf',
    contentType: 'application/pdf',
    store,
  });

  assert.deepEqual(jira.routes(), ['POST /rest/api/3/issue/ABC-1/attachments']);
  const spec = lastSpec(jira);
  assert.equal(spec.pathTemplate, ISSUE_ATTACHMENTS_PATH_TEMPLATE);
  assert.equal(spec.body, undefined, 'a multipart upload carries no JSON body');
  const part = at(spec.multipart ?? [], 0);
  assert.equal(part.field, UPLOAD_FIELD_NAME);
  assert.equal(part.filename, 'report.pdf');
  assert.equal(part.contentType, 'application/pdf');
  assert.deepEqual([...part.bytes], [1, 2, 3]);
  assert.deepEqual(result, {
    attachments: [
      {
        id: '10001',
        filename: 'report.pdf',
        size: 4096,
        mimeType: 'application/pdf',
        author: { accountId: ACCOUNT_ID, displayName: 'User One' },
        created: '2026-01-02T03:04:05.000+0000',
      },
    ],
    name: 'report.pdf',
    bytes: 3,
  });
});

test('uploadAttachment defaults the part content type to octet-stream', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk([attachmentRow()]));
  const store = createFakeStore().put('report.pdf', new Uint8Array([1]));

  await uploadAttachment({
    jira: jira.fn,
    issueKey: 'ABC-1',
    name: 'report.pdf',
    store,
  });

  assert.equal(
    at(lastSpec(jira).multipart ?? [], 0).contentType,
    DEFAULT_ATTACHMENT_MIME,
  );
});

test('uploadAttachment without a media directory refuses and names the setting', async () => {
  const jira = createFakeJiraRequest();

  const err = asJiraError(
    await caught(() =>
      uploadAttachment({ jira: jira.fn, issueKey: 'ABC-1', name: 'report.pdf' }),
    ),
  );

  assert.equal(err.kind, 'config');
  assert.match(err.message, /JIRA_MEDIA_DIR/);
  assert.equal(jira.calls.length, 0);
});

test('uploadAttachment refuses a path before it ever touches the disk', async () => {
  const store = createFakeStore();
  const jira = createFakeJiraRequest();

  for (const name of ['../../etc/passwd', '/etc/passwd', 'sub/report.pdf', '.env']) {
    const err = asJiraError(
      await caught(() =>
        uploadAttachment({ jira: jira.fn, issueKey: 'ABC-1', name, store }),
      ),
    );
    assert.equal(err.kind, 'validation', name);
  }

  // The whole point of refusing here: the model cannot make this server open a
  // file outside the directory an operator opened to it.
  assert.deepEqual(store.reads, []);
  assert.equal(jira.calls.length, 0);
});

test('uploadAttachment refuses an oversized local file before any part exists', async () => {
  const jira = createFakeJiraRequest();
  const store = createFakeStore().put(
    'huge.bin',
    new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
  );

  const err = asJiraError(
    await caught(() =>
      uploadAttachment({ jira: jira.fn, issueKey: 'ABC-1', name: 'huge.bin', store }),
    ),
  );

  assert.equal(err.kind, 'validation');
  assert.equal(jira.calls.length, 0, 'not one byte may be sent');
});

test('uploadAttachment refuses an empty issue key before reading the file', async () => {
  const jira = createFakeJiraRequest();
  const store = createFakeStore().put('report.pdf', new Uint8Array([1]));

  const err = asJiraError(
    await caught(() =>
      uploadAttachment({ jira: jira.fn, issueKey: '', name: 'report.pdf', store }),
    ),
  );

  assert.equal(err.kind, 'validation');
  assert.deepEqual(store.reads, []);
});

test('uploadAttachment refuses a response that is not the array Jira documents', async () => {
  const jira = createFakeJiraRequest().enqueue(jiraOk({ id: '10001' }));
  const store = createFakeStore().put('report.pdf', new Uint8Array([1]));

  const err = asJiraError(
    await caught(() =>
      uploadAttachment({ jira: jira.fn, issueKey: 'ABC-1', name: 'report.pdf', store }),
    ),
  );

  assert.equal(err.kind, 'unexpected_shape');
});
