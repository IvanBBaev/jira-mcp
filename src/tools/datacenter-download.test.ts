// ---------------------------------------------------------------------------
// tools/datacenter-download.test.ts — `jira_download_attachment` on the Data
// Center preview (D117, stage 13.8, CC-370…CC-377).
//
// The download is driven end to end through the real tool handler, the real
// Data Center adapter and a real media directory in a temp dir; only Jira is
// faked. The fixtures follow Atlassian's Data Center documentation for
// `GET /rest/api/2/attachment/{id}` and the attachment servlet
// (`/secure/attachment/{id}/{filename}`); they are NOT recordings of a Data
// Center instance (D104), which is why the tool stays UNVERIFIED.
//
// What is proven is the adapter's own contract: metadata on v2 first, the
// size cap before any bytes move, the byte URL BUILT from the id and the
// metadata's filename (the record's `content` URL is never read), the Cloud
// filename sanitizing and media-directory refusal, and the upload still
// unserved because no served tool can remove an attachment (D109).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ATTACHMENT_CONTENT_PATH_TEMPLATE,
  ATTACHMENT_PATH_TEMPLATE,
  SECURE_ATTACHMENT_PATH_TEMPLATE,
} from '../api/attachments.js';
import { DATACENTER_API, DATACENTER_TOOLS } from '../api/datacenter.js';
import { CLOUD_API } from '../api/port.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  createFakeLogger,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import type { FakeJiraRequest } from '../core/fakes/index.js';
import { errorFromResponse } from '../core/errors.js';
import { MAX_ATTACHMENT_BYTES } from '../core/http-util.js';
import type { AnyToolSpec, PackageSpec, ToolCtx, ToolResult } from '../mcp/types.js';
import { attachmentsPackage, createAttachmentsPackage } from './attachments.js';

const EMAIL = 'jdoe@corp.example';
const BYTES = new Uint8Array([0x68, 0x69, 0x0a]);

/** A Data Center user object as `/rest/api/2` sends one. */
const DC_USER = {
  self: 'https://jira.corp.example/jira/rest/api/2/user?username=jdoe',
  name: 'jdoe',
  key: 'JIRAUSER10100',
  emailAddress: EMAIL,
  displayName: 'Jane Doe',
  active: true,
};

/** `GET /rest/api/2/attachment/{id}` on Data Center. // synthetic */
function dcAttachment(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    self: 'https://jira.corp.example/jira/rest/api/2/attachment/60001',
    id: '60001',
    filename: 'a.txt',
    author: DC_USER,
    created: '2026-09-01T09:00:00.000+0300',
    size: BYTES.byteLength,
    mimeType: 'text/plain',
    content: 'https://jira.corp.example/jira/secure/attachment/60001/a.txt',
    ...overrides,
  };
}

const META_ROUTE = 'GET /rest/api/2/attachment/60001';
/** Anchored: the metadata route is a prefix of nothing else, but be explicit. */
const META_ONLY = /^GET \/rest\/api\/2\/attachment\/60001$/;
const BYTES_ROUTE = /^GET \/secure\/attachment\/60001\//;

function ctxOf(jira: FakeJiraRequest, api = DATACENTER_API): ToolCtx {
  const clock = createFakeClock(1_000);
  return {
    jira: jira.fn,
    api,
    log: createFakeLogger({ cid: 'c-test01', clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 30_000, maxPages: 20 },
    deadlineAt: 9_000_000,
  };
}

function toolOf(pkg: PackageSpec, name: string): AnyToolSpec {
  const tool = pkg.tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `the package has no ${name}`);
  return tool;
}

function download(
  pkg: PackageSpec,
  jira: FakeJiraRequest,
  api = DATACENTER_API,
): Promise<ToolResult> {
  const tool = toolOf(pkg, 'jira_download_attachment');
  return tool.handler(tool.input.parse({ attachmentId: '60001' }), ctxOf(jira, api));
}

async function withMediaDir<T>(
  fn: (dir: string, pkg: PackageSpec) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-dc-media-'));
  try {
    return await fn(dir, createAttachmentsPackage({ mediaDir: dir }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function httpError(status: number, pathTemplate: string): Error {
  return errorFromResponse({
    status,
    method: 'GET',
    pathTemplate,
    body: { errorMessages: ['nope'], errors: {} },
  });
}

interface DownloadData {
  path: string;
  name: string;
  filename: string;
  bytes: number;
  mimeType: string;
  renamed: boolean;
  attachmentId: string;
}

test('[CC-370] jira_download_attachment on Data Center: v2 metadata, then the servlet bytes, into the media dir', async () => {
  await withMediaDir(async (dir, pkg) => {
    const jira = createFakeJiraRequest()
      .on(META_ONLY, jiraOk(dcAttachment()))
      .on(BYTES_ROUTE, jiraOk(BYTES));

    const result = await download(pkg, jira);

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(jira.routes(), [META_ROUTE, 'GET /secure/attachment/60001/a.txt']);
    const [meta, bytes] = jira.calls;
    assert.equal(meta?.root, 'v2');
    assert.equal(meta?.pathTemplate, ATTACHMENT_PATH_TEMPLATE);
    assert.equal(meta?.accept, undefined, 'the metadata is JSON');
    assert.equal(bytes?.root, 'secure');
    assert.equal(bytes?.pathTemplate, SECURE_ATTACHMENT_PATH_TEMPLATE);
    assert.equal(bytes?.accept, 'binary');
    // No Cloud `redirect=false` or any other query rides along.
    assert.equal(bytes?.query, undefined);

    const data = result.data as DownloadData;
    assert.deepEqual(data, {
      path: join(dir, 'a.txt'),
      name: 'a.txt',
      filename: 'a.txt',
      bytes: BYTES.byteLength,
      mimeType: 'text/plain',
      renamed: false,
      attachmentId: '60001',
    });
    assert.deepEqual(new Uint8Array(await readFile(data.path)), BYTES);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(EMAIL));
  });
});

test('[CC-371] a hostile filename is ONE encoded segment on the wire and a sanitized basename on disk', async () => {
  for (const [filename, segment, onDisk] of [
    ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', 'passwd'],
    ['my report?v=1#x.txt', 'my%20report%3Fv%3D1%23x.txt', undefined],
    ['50%.txt', '50%25.txt', '50%.txt'],
    ['a\\b.txt', 'a%5Cb.txt', undefined],
  ] as const) {
    await withMediaDir(async (dir, pkg) => {
      const jira = createFakeJiraRequest()
        .on(META_ONLY, jiraOk(dcAttachment({ filename })))
        .on(BYTES_ROUTE, jiraOk(BYTES));

      const result = await download(pkg, jira);

      assert.equal(result.ok, true, `${filename}: ${JSON.stringify(result.error)}`);
      assert.equal(jira.calls[1]?.path, `/attachment/60001/${segment}`, filename);
      const data = result.data as DownloadData;
      // Whatever Jira called it, the file is a direct child of the media dir.
      assert.deepEqual(await readdir(dir), [data.name], filename);
      assert.equal(data.path, join(dir, data.name), filename);
      if (onDisk !== undefined) assert.equal(data.name, onDisk, filename);
      assert.equal(data.filename, filename, 'the Jira name is reported as sent');
    });
  }
});

test('[CC-371] a filename that would be a dot segment, nothing, or ill-formed Unicode is refused before any byte request', async () => {
  for (const filename of ['', '.', '..', '...', 'bad\uD800.txt']) {
    await withMediaDir(async (dir, pkg) => {
      const jira = createFakeJiraRequest()
        .on(META_ONLY, jiraOk(dcAttachment({ filename })))
        .on(BYTES_ROUTE, jiraOk(BYTES));

      const result = await download(pkg, jira);

      assert.equal(result.ok, false, JSON.stringify(filename));
      assert.equal(result.error?.kind, 'unexpected_shape', JSON.stringify(filename));
      assert.deepEqual(jira.routes(), [META_ROUTE], 'only the metadata was read');
      assert.deepEqual(await readdir(dir), []);
    });
  }
});

test('[CC-372] an attachment over the cap is refused from its metadata, before the transfer', async () => {
  await withMediaDir(async (dir, pkg) => {
    const jira = createFakeJiraRequest()
      .on(META_ONLY, jiraOk(dcAttachment({ size: MAX_ATTACHMENT_BYTES + 1 })))
      .on(BYTES_ROUTE, jiraOk(BYTES));

    const result = await download(pkg, jira);

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'validation');
    assert.match(String(result.error?.message), /50 MiB|too large|limit/i);
    assert.deepEqual(jira.routes(), [META_ROUTE], 'no byte request was made');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('[CC-372] bytes over the cap that the metadata under-reported are still refused, and nothing is written', async () => {
  await withMediaDir(async (dir, pkg) => {
    const jira = createFakeJiraRequest()
      .on(META_ONLY, jiraOk(dcAttachment({ size: 1 })))
      .on(BYTES_ROUTE, jiraOk(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)));

    const result = await download(pkg, jira);

    assert.equal(result.error?.kind, 'validation');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('[CC-399] a 200 page that is not the attachment is refused, and nothing is written', async () => {
  const html = new TextEncoder().encode('<!DOCTYPE html><title>Log in - Jira</title>');
  const cases: readonly {
    meta: unknown;
    body: Uint8Array;
    headers?: Record<string, string>;
  }[] = [
    // The stated size does not match: a login page in place of a 3-byte file.
    { meta: dcAttachment(), body: html },
    // A truncated body is refused the same way.
    { meta: dcAttachment(), body: BYTES.subarray(0, 2) },
    // No size to compare, but an HTML page for a text attachment.
    {
      meta: dcAttachment({ size: undefined }),
      body: html,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    },
    // Same length as stated, still HTML for a non-HTML attachment.
    { meta: dcAttachment(), body: BYTES, headers: { 'Content-Type': 'TEXT/HTML' } },
  ];
  for (const { meta, body, headers } of cases) {
    await withMediaDir(async (dir, pkg) => {
      const jira = createFakeJiraRequest()
        .on(META_ONLY, jiraOk(meta))
        .on(BYTES_ROUTE, jiraOk(body, headers === undefined ? undefined : { headers }));

      const result = await download(pkg, jira);

      assert.equal(result.error?.kind, 'unexpected_shape');
      assert.match(result.error?.message ?? '', /login or proxy page/);
      assert.deepEqual(await readdir(dir), []);
    });
  }
});

test('[CC-399] an HTML attachment served as HTML, and a body matching its size, still download', async () => {
  const page = new TextEncoder().encode('<p>hi</p>');
  await withMediaDir(async (dir, pkg) => {
    const jira = createFakeJiraRequest()
      .on(
        META_ONLY,
        jiraOk(
          dcAttachment({
            filename: 'a.html',
            mimeType: 'text/html',
            size: page.byteLength,
          }),
        ),
      )
      .on(BYTES_ROUTE, jiraOk(page, { headers: { 'content-type': 'text/html' } }));

    const result = await download(pkg, jira);

    assert.equal(result.error, undefined);
    assert.deepEqual(await readdir(dir), ['a.html']);
  });
});

test('[CC-373] 404 on the metadata or on the servlet is not_found; 403 maps as on Cloud', async () => {
  for (const [label, rules, kind, sent] of [
    [
      'metadata 404',
      [[META_ONLY, jiraErr(httpError(404, ATTACHMENT_PATH_TEMPLATE))]],
      'not_found',
      1,
    ],
    [
      'servlet 404',
      [
        [META_ONLY, jiraOk(dcAttachment())],
        [BYTES_ROUTE, jiraErr(httpError(404, SECURE_ATTACHMENT_PATH_TEMPLATE))],
      ],
      'not_found',
      2,
    ],
    [
      'metadata 403',
      [[META_ONLY, jiraErr(httpError(403, ATTACHMENT_PATH_TEMPLATE))]],
      'permission',
      1,
    ],
    [
      'servlet 403',
      [
        [META_ONLY, jiraOk(dcAttachment())],
        [BYTES_ROUTE, jiraErr(httpError(403, SECURE_ATTACHMENT_PATH_TEMPLATE))],
      ],
      'permission',
      2,
    ],
  ] as const) {
    await withMediaDir(async (dir, pkg) => {
      const jira = createFakeJiraRequest();
      for (const [match, stub] of rules) jira.on(match, stub);

      const result = await download(pkg, jira);

      assert.equal(result.ok, false, label);
      assert.equal(result.error?.kind, kind, label);
      assert.equal(jira.calls.length, sent, label);
      assert.deepEqual(await readdir(dir), [], label);
    });
  }

  // The same 403 on Cloud lands on the same kind: the mapping is shared.
  await withMediaDir(async (_dir, pkg) => {
    const cloud = createFakeJiraRequest().on(
      'GET /rest/api/3/attachment/60001',
      jiraErr(httpError(403, ATTACHMENT_PATH_TEMPLATE)),
    );
    const result = await download(pkg, cloud, CLOUD_API);
    assert.equal(result.error?.kind, 'permission');
  });
});

test("[CC-374] the record's content URL is never fetched — not off-host, not elsewhere on the host", async () => {
  for (const content of [
    'https://evil.example/steal?token=1',
    'https://jira.corp.example/jira/rest/api/2/myself',
    'https://jira.corp.example/jira/secure/attachment/99999/other.txt',
    '/secure/admin/ViewApplicationProperties.jspa',
  ]) {
    await withMediaDir(async (_dir, pkg) => {
      const jira = createFakeJiraRequest()
        .on(META_ONLY, jiraOk(dcAttachment({ content })))
        .on(BYTES_ROUTE, jiraOk(BYTES));

      const result = await download(pkg, jira);

      assert.equal(result.ok, true, content);
      assert.deepEqual(
        jira.routes(),
        [META_ROUTE, 'GET /secure/attachment/60001/a.txt'],
        content,
      );
      for (const call of jira.calls) {
        assert.doesNotMatch(
          JSON.stringify(call),
          /evil\.example|myself|99999|jspa/,
          content,
        );
      }
    });
  }
});

test('[CC-375] no Cloud route on Data Center: never /rest/api/3, never /attachment/content', async () => {
  await withMediaDir(async (_dir, pkg) => {
    const jira = createFakeJiraRequest()
      .on(META_ONLY, jiraOk(dcAttachment()))
      .on(BYTES_ROUTE, jiraOk(BYTES));
    await download(pkg, jira);
    for (const route of jira.routes()) {
      assert.doesNotMatch(route, /\/rest\/api\/3\//, route);
      assert.doesNotMatch(route, /\/attachment\/content/, route);
      assert.match(
        route,
        /^GET (\/rest\/api\/2\/attachment\/|\/secure\/attachment\/)/,
        route,
      );
    }
    for (const call of jira.calls) {
      assert.notEqual(call.pathTemplate, ATTACHMENT_CONTENT_PATH_TEMPLATE);
    }
  });
});

test('[CC-375] the Cloud download is unchanged: v3 metadata, /attachment/content with redirect=false', async () => {
  await withMediaDir(async (_dir, pkg) => {
    const jira = createFakeJiraRequest()
      .on(/^GET \/rest\/api\/3\/attachment\/60001$/, jiraOk(dcAttachment()))
      .on('GET /rest/api/3/attachment/content/60001', jiraOk(BYTES));

    const result = await download(pkg, jira, CLOUD_API);

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(jira.routes(), [
      'GET /rest/api/3/attachment/60001',
      'GET /rest/api/3/attachment/content/60001',
    ]);
    assert.equal(jira.calls[1]?.pathTemplate, ATTACHMENT_CONTENT_PATH_TEMPLATE);
    assert.deepEqual(jira.calls[1]?.query, { redirect: false });
    assert.equal(jira.calls[1]?.root, undefined);
  });
});

test('[CC-376] with no media directory the Data Center download is a config refusal that sends nothing', async () => {
  for (const pkg of [attachmentsPackage, createAttachmentsPackage({ mediaDir: '  ' })]) {
    const jira = createFakeJiraRequest()
      .on(META_ONLY, jiraOk(dcAttachment()))
      .on(BYTES_ROUTE, jiraOk(BYTES));

    const result = await download(pkg, jira);

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'config');
    assert.match(
      `${String(result.error?.message)} ${String(result.error?.remediation)}`,
      /JIRA_MEDIA_DIR/,
    );
    assert.equal(jira.calls.length, 0, 'a refusal must cost nothing');
  }
});

test('[CC-377] the download is served on Data Center and the upload is not — no served tool removes an attachment', () => {
  assert.equal(DATACENTER_TOOLS.has('jira_download_attachment'), true);
  assert.equal(DATACENTER_TOOLS.has('jira_upload_attachment'), false);
  // No tool in the catalog removes an attachment, so an upload could not be
  // undone by a served write (D109's line; D117).
  assert.equal(DATACENTER_TOOLS.has('jira_delete_attachment'), false);

  const jira = createFakeJiraRequest();
  assert.throws(
    () => DATACENTER_API.uploadAttachment({ jira: jira.fn } as never),
    (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, 'unsupported');
      return true;
    },
  );
  assert.equal(jira.calls.length, 0);
  assert.notEqual(DATACENTER_API.downloadAttachment, CLOUD_API.downloadAttachment);
});
