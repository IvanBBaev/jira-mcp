// Tests for the `attachments` tool package (WP-70): list, download, upload.
//
// Two tiers meet here. The Jira side is contract tier — a fake `JiraRequestFn`
// that answers programmed routes and THROWS on anything else, with inline
// bodies marked `// synthetic`. The DISK side is real: `createNodeMediaStore`
// is the only `node:fs` code in the package, and a fake filesystem would prove
// nothing about the properties that matter (the `wx` no-overwrite flag, the
// mode bits, what `resolve` does to a name). Every case that touches disk runs
// inside a fresh `mkdtemp` directory that is removed afterwards.
//
// What these tests pin down:
//   * D45 — the media directory is a boundary: a Jira filename is sanitized on
//     the way in, a model-supplied name is REFUSED rather than rewritten, and
//     the store re-checks the resolved path even when both rules already ran;
//   * a download NEVER overwrites — a second call leaves a second file, and
//     says so with `renamed: true`;
//   * with no `JIRA_MEDIA_DIR` the two byte-moving tools answer `config` and
//     name the setting, while listing keeps working;
//   * the annotation quadruples, including the bespoke read-but-not-idempotent
//     one on `jira_download_attachment` (see the module banner), and the write
//     tier on the upload;
//   * the upload sends ONE multipart part named `file`, carrying the bytes that
//     are really on disk.

import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MAX_MEDIA_NAME_CHARS, UPLOAD_FIELD_NAME } from '../api/attachments.js';
import { createFakeClock, createFakeJiraRequest, jiraOk } from '../core/fakes/index.js';
import { MAX_ATTACHMENT_BYTES } from '../core/http-util.js';
import { JiraError } from '../core/types.js';
import type { JiraRequestFn, JiraRequestSpec } from '../core/types.js';
import { createFakeLogger } from '../core/fakes/index.js';
import type { AnyToolSpec, PackageSpec, ToolCtx, ToolResult } from '../mcp/types.js';
import {
  MAX_NAME_COLLISIONS,
  MEDIA_FILE_MODE,
  attachmentsPackage,
  createAttachmentsPackage,
  createNodeMediaStore,
  listAttachmentsTool,
} from './attachments.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SITE = 'https://example.atlassian.net';
const ACCOUNT_ID = '5b10a2844c20165700ede21g';

const ISSUE_ROUTE = 'GET /rest/api/3/issue/ABC-1';
const META_ROUTE = 'GET /rest/api/3/attachment/10001';
const CONTENT_ROUTE = 'GET /rest/api/3/attachment/content/10001';
const UPLOAD_ROUTE = 'POST /rest/api/3/issue/ABC-1/attachments';

/** The tool context the registry builds, with every seam faked. */
function createCtx(jira: JiraRequestFn): ToolCtx {
  const clock = createFakeClock(1_000);
  return {
    jira,
    log: createFakeLogger({ clock }),
    clock,
    cid: 'c-test01',
    limits: { maxResultChars: 100_000, maxPages: 20 },
    deadlineAt: 61_000,
  };
}

/** Unwrap a successful envelope, failing loudly (with the error) when it is not. */
function dataOf<T>(result: ToolResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  if (result.data === undefined) throw new Error('ok result carried no data');
  return result.data;
}

/** A tool out of the package under test, by name. */
function toolOf(pkg: PackageSpec, name: string): AnyToolSpec {
  const tool = pkg.tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `the package has no ${name}`);
  return tool;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The permission cases below take away a right and assert the refusal. Root has
 * no rights to take away — the `chmod` succeeds and the syscall goes through
 * anyway — so under root they would assert nothing and fail for the wrong
 * reason.
 */
const skipAsRoot: string | false =
  process.getuid?.() === 0 ? 'chmod does not restrict root' : false;

async function caught(fn: () => Promise<unknown>): Promise<JiraError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to reject');
}

/** One attachment record, as Jira sends it. // synthetic */
function attachmentRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    self: `${SITE}/rest/api/3/attachment/10001`,
    id: '10001',
    filename: 'report.pdf',
    author: { accountId: ACCOUNT_ID, displayName: 'User One' },
    created: '2026-01-02T03:04:05.000+0000',
    size: 4,
    mimeType: 'application/pdf',
    content: `${SITE}/secure/attachment/10001/report.pdf`,
    ...overrides,
  };
}

/** A fake programmed for the download pair: metadata, then bytes. */
function downloadFake(
  bytes: Uint8Array,
  meta: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof createFakeJiraRequest> {
  return createFakeJiraRequest()
    .on(CONTENT_ROUTE, jiraOk(bytes))
    .on(META_ROUTE, jiraOk(attachmentRow(meta)));
}

// ---------------------------------------------------------------------------
// `jira_list_attachments`
// ---------------------------------------------------------------------------

test('jira_list_attachments works with no media directory at all', async () => {
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    // synthetic — GET /rest/api/3/issue/ABC-1?fields=attachment
    jiraOk({ key: 'ABC-1', fields: { attachment: [attachmentRow()] } }),
  );

  const result = await listAttachmentsTool.handler(
    { issue: 'ABC-1' },
    createCtx(fake.fn),
  );
  const data = dataOf(result);

  assert.deepEqual(fake.routes(), [ISSUE_ROUTE]);
  assert.equal(data.count, 1);
  assert.equal(data.issue, 'ABC-1');
  // Filenames are tenant-authored free text, so the whole result is branded.
  assert.equal(result._untrusted, true);
});

test('jira_list_attachments reports an empty list, not an error', async () => {
  const fake = createFakeJiraRequest().on(
    ISSUE_ROUTE,
    jiraOk({ key: 'ABC-1', fields: {} }),
  );

  const data = dataOf(
    await listAttachmentsTool.handler({ issue: 'ABC-1' }, createCtx(fake.fn)),
  );

  assert.equal(data.count, 0);
  assert.deepEqual(data.attachments, []);
});

// ---------------------------------------------------------------------------
// `jira_download_attachment`
// ---------------------------------------------------------------------------

test('jira_download_attachment writes the bytes into the media directory', async () => {
  await withTempDir(async (dir) => {
    const pkg = createAttachmentsPackage({ mediaDir: dir });
    const fake = downloadFake(new Uint8Array([1, 2, 3, 4]));

    const result = await toolOf(pkg, 'jira_download_attachment').handler(
      { attachmentId: '10001' },
      createCtx(fake.fn),
    );
    const data = dataOf(result) as { path: string; name: string; renamed: boolean };

    assert.deepEqual(fake.routes(), [META_ROUTE, CONTENT_ROUTE]);
    assert.equal(data.path, join(dir, 'report.pdf'));
    assert.equal(data.name, 'report.pdf');
    assert.equal(data.renamed, false);
    assert.deepEqual([...(await readFile(data.path))], [1, 2, 3, 4]);
    // The file is created for this server alone, like the write journal.
    const info = await stat(data.path);
    assert.equal(info.mode & 0o777, MEDIA_FILE_MODE);
    // Jira's filename is still tenant text after the local name was derived.
    assert.equal(result._untrusted, true);
  });
});

test('jira_download_attachment accepts a numeric attachment id', async () => {
  await withTempDir(async (dir) => {
    const pkg = createAttachmentsPackage({ mediaDir: dir });
    const fake = downloadFake(new Uint8Array([9]));

    const data = dataOf(
      await toolOf(pkg, 'jira_download_attachment').handler(
        { attachmentId: 10_001 },
        createCtx(fake.fn),
      ),
    ) as { attachmentId: string };

    assert.equal(data.attachmentId, '10001');
    assert.deepEqual(fake.routes(), [META_ROUTE, CONTENT_ROUTE]);
  });
});

test('CC-55: a hostile Jira filename lands inside the directory under a safe name', async () => {
  await withTempDir(async (dir) => {
    const pkg = createAttachmentsPackage({ mediaDir: dir });
    const fake = downloadFake(new Uint8Array([1]), {
      filename: '../../../../../../etc/cron.d/pwn',
    });

    const data = dataOf(
      await toolOf(pkg, 'jira_download_attachment').handler(
        { attachmentId: '10001' },
        createCtx(fake.fn),
      ),
    ) as { path: string; name: string; filename: string; renamed: boolean };

    assert.equal(data.path, join(dir, 'pwn'));
    assert.equal(data.name, 'pwn');
    assert.equal(data.renamed, true);
    // The result still reports what Jira holds, so the model is not misled
    // about which attachment it just fetched.
    assert.equal(data.filename, '../../../../../../etc/cron.d/pwn');
  });
});

test('CC-56: downloading twice leaves two files — nothing is ever overwritten', async () => {
  await withTempDir(async (dir) => {
    const pkg = createAttachmentsPackage({ mediaDir: dir });
    const tool = toolOf(pkg, 'jira_download_attachment');

    const first = dataOf(
      await tool.handler(
        { attachmentId: '10001' },
        createCtx(downloadFake(new Uint8Array([1, 1])).fn),
      ),
    ) as { path: string; renamed: boolean };
    const second = dataOf(
      await tool.handler(
        { attachmentId: '10001' },
        createCtx(downloadFake(new Uint8Array([2, 2])).fn),
      ),
    ) as { path: string; name: string; renamed: boolean };

    assert.equal(first.renamed, false);
    assert.equal(second.name, 'report-1.pdf');
    assert.equal(second.renamed, true);
    assert.deepEqual([...(await readFile(first.path))], [1, 1], 'the first file stands');
    assert.deepEqual([...(await readFile(second.path))], [2, 2]);
  });
});

test('CC-58: jira_download_attachment without a media directory refuses by configuration', async () => {
  const fake = createFakeJiraRequest();

  const result = await toolOf(attachmentsPackage, 'jira_download_attachment').handler(
    { attachmentId: '10001' },
    createCtx(fake.fn),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'config');
  assert.match(result.error?.message ?? '', /JIRA_MEDIA_DIR/);
  assert.equal(fake.calls.length, 0, 'a refusal must cost no Jira call');
});

test('a missing media directory is a configuration error, not a crash', async () => {
  await withTempDir(async (dir) => {
    const pkg = createAttachmentsPackage({ mediaDir: join(dir, 'not-created') });
    const fake = downloadFake(new Uint8Array([1]));

    const result = await toolOf(pkg, 'jira_download_attachment').handler(
      { attachmentId: '10001' },
      createCtx(fake.fn),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'config');
    assert.match(result.error?.message ?? '', /does not exist/);
  });
});

// ---------------------------------------------------------------------------
// `jira_upload_attachment`
// ---------------------------------------------------------------------------

test('jira_upload_attachment sends one multipart part named file', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'notes.txt'), 'hello');
    const pkg = createAttachmentsPackage({ mediaDir: dir });
    const fake = createFakeJiraRequest().on(
      UPLOAD_ROUTE,
      // synthetic — POST /rest/api/3/issue/ABC-1/attachments
      jiraOk([attachmentRow({ id: '10002', filename: 'notes.txt', size: 5 })]),
    );

    const data = dataOf(
      await toolOf(pkg, 'jira_upload_attachment').handler(
        { issue: 'ABC-1', name: 'notes.txt', contentType: 'text/plain' },
        createCtx(fake.fn),
      ),
    ) as { name: string; bytes: number; attachments: readonly { id: string }[] };

    const spec: JiraRequestSpec | undefined = fake.lastRequest();
    const part = spec?.multipart?.[0];
    assert.ok(part !== undefined, 'the upload must carry a multipart part');
    assert.equal(spec?.multipart?.length, 1);
    assert.equal(part.field, UPLOAD_FIELD_NAME);
    assert.equal(part.filename, 'notes.txt');
    assert.equal(part.contentType, 'text/plain');
    assert.equal(Buffer.from(part.bytes).toString('utf8'), 'hello');
    assert.equal(data.bytes, 5);
    assert.equal(data.attachments[0]?.id, '10002');
    // A created attachment is not content the model must be warned about; the
    // bytes came from the operator's own directory.
    assert.equal(
      (
        await toolOf(pkg, 'jira_upload_attachment').handler(
          { issue: 'ABC-1', name: 'notes.txt' },
          createCtx(
            createFakeJiraRequest().on(UPLOAD_ROUTE, jiraOk([attachmentRow()])).fn,
          ),
        )
      )._untrusted,
      undefined,
    );
  });
});

test('CC-57: jira_upload_attachment refuses a path instead of reading it', async () => {
  await withTempDir(async (dir) => {
    // A real, readable secret next to the media directory: if the confinement
    // were advisory, this is the file that would leave the host.
    const secret = join(dir, 'secret.env');
    await writeFile(secret, 'JIRA_API_TOKEN=hunter2');
    const media = join(dir, 'media');
    await mkdir(media);
    const pkg = createAttachmentsPackage({ mediaDir: media });
    const fake = createFakeJiraRequest();

    for (const name of ['../secret.env', secret, 'sub/../../secret.env', '.env']) {
      const result = await toolOf(pkg, 'jira_upload_attachment').handler(
        { issue: 'ABC-1', name },
        createCtx(fake.fn),
      );
      assert.equal(result.ok, false, name);
      assert.equal(result.error?.kind, 'validation', name);
    }
    assert.equal(fake.calls.length, 0, 'nothing may reach Jira');
  });
});

test('jira_upload_attachment reports a name that is not in the directory', async () => {
  await withTempDir(async (dir) => {
    const pkg = createAttachmentsPackage({ mediaDir: dir });
    const fake = createFakeJiraRequest();

    const result = await toolOf(pkg, 'jira_upload_attachment').handler(
      { issue: 'ABC-1', name: 'nothing-here.txt' },
      createCtx(fake.fn),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.kind, 'not_found');
    assert.equal(fake.calls.length, 0);
  });
});

test('jira_upload_attachment refuses a directory and an oversized file', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'folder'));
    // Sparse: `truncate` reports the size without spending 50 MiB of disk.
    const huge = await open(join(dir, 'huge.bin'), 'w');
    try {
      await huge.truncate(MAX_ATTACHMENT_BYTES + 1);
    } finally {
      await huge.close();
    }
    const pkg = createAttachmentsPackage({ mediaDir: dir });
    const fake = createFakeJiraRequest();

    for (const name of ['folder', 'huge.bin']) {
      const result = await toolOf(pkg, 'jira_upload_attachment').handler(
        { issue: 'ABC-1', name },
        createCtx(fake.fn),
      );
      assert.equal(result.ok, false, name);
      assert.equal(result.error?.kind, 'validation', name);
    }
    assert.equal(fake.calls.length, 0);
  });
});

test('jira_upload_attachment without a media directory refuses by configuration', async () => {
  const fake = createFakeJiraRequest();

  const result = await toolOf(attachmentsPackage, 'jira_upload_attachment').handler(
    { issue: 'ABC-1', name: 'notes.txt' },
    createCtx(fake.fn),
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.kind, 'config');
  assert.match(result.error?.message ?? '', /JIRA_MEDIA_DIR/);
});

// ---------------------------------------------------------------------------
// The store itself — the second lock (THREAT-MODEL.md §Local filesystem)
// ---------------------------------------------------------------------------

test('the store refuses a name that resolves out of the directory', async () => {
  await withTempDir(async (dir) => {
    const store = createNodeMediaStore(dir);

    for (const name of ['../escape.txt', '../../escape.txt', 'sub/../../escape.txt']) {
      const write = await caught(() => store.write(name, new Uint8Array([1])));
      assert.equal(write.kind, 'validation', name);
      const read = await caught(() => store.read(name));
      assert.equal(read.kind, 'validation', name);
    }

    // And the directory itself is not a file in it.
    assert.equal((await caught(() => store.read('.'))).kind, 'validation');

    // An ABSOLUTE path is not a special case that escapes: `join` neutralizes
    // the leading separator, so the name lands under the root and the real
    // /etc/hosts — which certainly exists on this host — is never opened.
    assert.equal((await caught(() => store.read('/etc/hosts'))).kind, 'not_found');
  });
});

test('CC-69: the store refuses a symlink whose target leaves the directory', async () => {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      // The stand-in for ~/.ssh/id_rsa: a readable file the model must never
      // be able to attach to an issue.
      const secret = join(outside, 'id_rsa');
      await writeFile(secret, 'PRIVATE KEY MATERIAL');
      await symlink(secret, join(dir, 'notes.txt'));

      const store = createNodeMediaStore(dir);
      const error = await caught(() => store.read('notes.txt'));

      assert.equal(error.kind, 'validation');
      assert.match(error.message, /symbolic link/i);
    });
  });
});

test('the store still follows a symlink that stays inside the directory', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'real.txt'), 'A');
    await symlink(join(dir, 'sub', 'real.txt'), join(dir, 'alias.txt'));

    const store = createNodeMediaStore(dir);
    const read = await store.read('alias.txt');

    assert.deepEqual([...read.bytes], [65]);
  });
});

test('the store reports a dangling symlink as a missing file', async () => {
  await withTempDir(async (dir) => {
    await symlink(join(dir, 'gone.txt'), join(dir, 'alias.txt'));

    const store = createNodeMediaStore(dir);

    assert.equal((await caught(() => store.read('alias.txt'))).kind, 'not_found');
  });
});

test('the store gives up after a hundred collisions instead of looping', async () => {
  await withTempDir(async (dir) => {
    const store = createNodeMediaStore(dir);
    await writeFile(join(dir, 'report.pdf'), '');
    for (let i = 1; i <= MAX_NAME_COLLISIONS; i += 1) {
      await writeFile(join(dir, `report-${String(i)}.pdf`), '');
    }

    const error = await caught(() => store.write('report.pdf', new Uint8Array([1])));

    assert.equal(error.kind, 'validation');
    assert.match(error.message, /already holds/);
  });
});

test('the store resolves its directory once, so a relative dir still works', async () => {
  await withTempDir(async (dir) => {
    const store = createNodeMediaStore(dir);
    const written = await store.write('a.txt', new Uint8Array([65]));

    assert.equal(store.dir, dir);
    assert.equal(written.path, join(dir, 'a.txt'));
    assert.equal(written.bytes, 1);
    const read = await store.read('a.txt');
    assert.deepEqual([...read.bytes], [65]);
  });
});

test('a collision variant only splits off something that is really an extension', async () => {
  await withTempDir(async (dir) => {
    const store = createNodeMediaStore(dir);
    for (const taken of ['report.pdf', 'notes', '.env', 'design.walkthrough-notes']) {
      await writeFile(join(dir, taken), '');
    }

    const nameOf = async (name: string): Promise<string> =>
      (await store.write(name, new Uint8Array([1]))).name;

    // The everyday case: the counter goes before the extension, so the file
    // still opens in the application Jira sent it for.
    assert.equal(await nameOf('report.pdf'), 'report-1.pdf');
    // No dot at all — there is nothing to preserve.
    assert.equal(await nameOf('notes'), 'notes-1');
    // A leading dot is the whole name, not an extension: `-1.env` would be a
    // different file entirely.
    assert.equal(await nameOf('.env'), '.env-1');
    // A dot in the middle of a long tail is not an extension either; splitting
    // at the LAST dot would rename the file to `design-1.walkthrough-notes`.
    assert.equal(await nameOf('design.walkthrough-notes'), 'design.walkthrough-notes-1');
  });
});

test('CC-74: a media directory that is really a path through a file is a config error', async () => {
  await withTempDir(async (dir) => {
    // The typo an operator makes once: JIRA_MEDIA_DIR pointing THROUGH a file.
    // Every syscall under it fails with ENOTDIR, not ENOENT.
    await writeFile(join(dir, 'media'), 'a file, not a directory');
    const store = createNodeMediaStore(join(dir, 'media', 'attachments'));

    const write = await caught(() => store.write('a.txt', new Uint8Array([1])));
    assert.equal(write.kind, 'config');
    assert.match(write.message, /does not exist/);
    assert.match(write.remediation ?? '', /JIRA_MEDIA_DIR/);

    // The read side diagnoses only the cases it can act on, so this one is
    // reported by errno — which is still enough to fix the setting.
    const read = await caught(() => store.read('a.txt'));
    assert.equal(read.kind, 'config');
    assert.match(read.message, /failed \(ENOTDIR\)/);
  });
});

test('CC-74: an errno the store has no advice for is still named in the report', async () => {
  await withTempDir(async (dir) => {
    const store = createNodeMediaStore(dir);
    // 300 characters is past the per-component limit of every filesystem this
    // server runs on. Jira's own filename is trimmed before it gets here, so
    // this stands in for the failures nobody enumerated: the point is that the
    // report carries the errno instead of swallowing it.
    const name = `${'a'.repeat(300)}.txt`;

    const error = await caught(() => store.write(name, new Uint8Array([1])));

    assert.equal(error.kind, 'config');
    assert.match(error.message, /failed \(ENAMETOOLONG\)/);
    assert.deepEqual(await readdir(dir), [], 'a failed create leaves nothing behind');
  });
});

test(
  'CC-74: a media directory the server cannot write to is a config error',
  { skip: skipAsRoot },
  async () => {
    await withTempDir(async (dir) => {
      // r-x: the directory exists and can be listed, which is exactly why
      // "does not exist" would be the wrong thing to tell the operator.
      const locked = join(dir, 'locked');
      await mkdir(locked, 0o555);
      try {
        const pkg = createAttachmentsPackage({ mediaDir: locked });
        const fake = downloadFake(new Uint8Array([1, 2, 3, 4]));

        const result = await toolOf(pkg, 'jira_download_attachment').handler(
          { attachmentId: '10001' },
          createCtx(fake.fn),
        );

        assert.equal(result.ok, false);
        assert.equal(result.error?.kind, 'config');
        assert.match(result.error?.message ?? '', /is not writable by this server/);
        assert.match(result.error?.remediation ?? '', /JIRA_MEDIA_DIR/);
        assert.deepEqual(await readdir(locked), [], 'a refused write leaves no stub');
      } finally {
        // Restore the write bit so the temp tree can be removed.
        await chmod(locked, 0o700);
      }
    });
  },
);

test(
  'CC-74: a file the server cannot read is a config error, not a missing file',
  { skip: skipAsRoot },
  async () => {
    await withTempDir(async (dir) => {
      // The file is there and `stat` still describes it, so the size check
      // passes and only the read itself fails.
      await writeFile(join(dir, 'notes.txt'), 'hello');
      await chmod(join(dir, 'notes.txt'), 0o000);
      const pkg = createAttachmentsPackage({ mediaDir: dir });
      const fake = createFakeJiraRequest();

      const result = await toolOf(pkg, 'jira_upload_attachment').handler(
        { issue: 'ABC-1', name: 'notes.txt' },
        createCtx(fake.fn),
      );

      assert.equal(result.ok, false);
      // `not_found` would send the operator looking for a file that is right
      // where they put it; the mode bits are the thing to fix.
      assert.equal(result.error?.kind, 'config');
      assert.match(result.error?.message ?? '', /not readable by this server/);
      assert.equal(fake.calls.length, 0, 'an unreadable file must cost no Jira call');
    });
  },
);

// ---------------------------------------------------------------------------
// Schemas, annotations and the package
// ---------------------------------------------------------------------------

test('every attachments input schema is strict and rejects unknown keys', () => {
  const download = toolOf(attachmentsPackage, 'jira_download_attachment');
  const upload = toolOf(attachmentsPackage, 'jira_upload_attachment');

  assert.equal(listAttachmentsTool.input.safeParse({ issue: 'ABC-1' }).success, true);
  assert.equal(
    listAttachmentsTool.input.safeParse({ issue: 'ABC-1', fields: [] }).success,
    false,
  );
  assert.equal(download.input.safeParse({ attachmentId: 10_001 }).success, true);
  assert.equal(
    download.input.safeParse({ attachmentId: '1', dir: '/tmp' }).success,
    false,
  );
  // The write control fields are auto-injected by `writeToolInput`.
  assert.equal(
    upload.input.safeParse({
      issue: 'ABC-1',
      name: 'notes.txt',
      apply: true,
      plan_id: 'p-1',
    }).success,
    true,
  );
  assert.equal(
    upload.input.safeParse({ issue: 'ABC-1', name: 'notes.txt', path: '/etc/passwd' })
      .success,
    false,
  );
  // The schema caps the name length before any filesystem call sees it.
  assert.equal(
    upload.input.safeParse({ issue: 'ABC-1', name: 'a'.repeat(MAX_MEDIA_NAME_CHARS + 1) })
      .success,
    false,
  );
});

test('the listing is a plain read and the upload is a standard write', () => {
  assert.deepEqual(listAttachmentsTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(listAttachmentsTool.writeTier, undefined);

  const upload = toolOf(attachmentsPackage, 'jira_upload_attachment');
  assert.deepEqual(upload.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(upload.writeTier, 'standard');
});

test('the download is read-only towards Jira but NOT idempotent locally', () => {
  // The bespoke quadruple, and the reason for it: `readOnlyHint: false` would
  // put the tool behind the plan/apply gate, which captures unsafe REQUESTS —
  // a download issues only GETs, so plan mode would capture nothing and still
  // write the file. Read-only is the honest hint; `idempotentHint: false` is
  // what tells a caller that a second call leaves a second file.
  const download = toolOf(attachmentsPackage, 'jira_download_attachment');

  assert.deepEqual(download.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(download.writeTier, undefined, 'a read tool may not carry a write tier');
  assert.match(download.description, /media directory/);
  assert.match(download.description, /never/);
});

test('the package is three tools under one deniable id', () => {
  assert.equal(attachmentsPackage.id, 'attachments');
  assert.deepEqual(
    attachmentsPackage.tools.map((tool) => tool.name),
    ['jira_list_attachments', 'jira_download_attachment', 'jira_upload_attachment'],
  );
  for (const tool of attachmentsPackage.tools) {
    assert.equal(tool.package, 'attachments', tool.name);
  }
  // A blank directory is the same as none: an operator who exported
  // `JIRA_MEDIA_DIR=` did not configure one.
  const blank = createAttachmentsPackage({ mediaDir: '   ' });
  assert.equal(blank.tools.length, 3);
});
