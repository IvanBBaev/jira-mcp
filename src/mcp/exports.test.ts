import assert from 'node:assert/strict';
import test from 'node:test';

import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { createMemoryMedia } from '../testing/memory-media.js';
import {
  EXPORT_MIME,
  EXPORT_NAME_PATTERN,
  EXPORT_PREVIEW_CHARS,
  exportFileName,
  exportLinkOf,
  exportRows,
  previewOf,
  readExport,
  toJsonl,
} from './exports.js';
import { RESOURCE_NOT_FOUND } from './resources.js';
import { err, ok } from './result.js';

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

test('[CC-1558] export file names are stamped, random-suffixed and match the read pattern', () => {
  const clock = createFakeClock(Date.UTC(2026, 9, 27, 8, 15, 0, 123));
  const name = exportFileName('jira_get_sprint_issues', clock, () => 0.5);
  assert.equal(name, 'jira-export-get_sprint_issues-20261027T081500Z-80000000.jsonl');
  assert.match(name, EXPORT_NAME_PATTERN);
  assert.match(
    exportFileName('jira_search', clock, () => 0),
    EXPORT_NAME_PATTERN,
  );
  // A collision variant is still an export; a path or a foreign file is not.
  assert.match(name.replace('.jsonl', '-2.jsonl'), EXPORT_NAME_PATTERN);
  for (const bad of [
    '../secret.jsonl',
    'notes.txt',
    `${name}/x`,
    name.replace('.jsonl', '.json'),
  ]) {
    assert.doesNotMatch(bad, EXPORT_NAME_PATTERN);
  }
});

test('[CC-1559] JSONL is one row per line and the preview is cut at its limit', () => {
  assert.equal(toJsonl([{ a: 1 }, 'x']), '{"a":1}\n"x"\n');
  assert.equal(toJsonl([]), '');
  assert.deepEqual(previewOf('short'), { preview: 'short' });
  const long = 'y'.repeat(EXPORT_PREVIEW_CHARS + 1);
  assert.deepEqual(previewOf(long), {
    preview: long.slice(0, EXPORT_PREVIEW_CHARS),
    preview_truncated: true,
  });
});

test('[CC-1560] exportRows writes the redacted rows and keeps cursors inline', async () => {
  const media = createMemoryMedia();
  const deps = {
    media,
    clock: createFakeClock(Date.UTC(2026, 9, 27)),
    rng: () => 0.25,
    redact: (value: unknown) => createFakeRedactor(['s3cret']).redact(value),
  };
  const result = ok(
    {
      issues: [{ key: 'A-1', note: 's3cret' }, { key: 'A-2' }],
      nextPageToken: 'n',
      hasMore: true,
    },
    { untrusted: true },
  );

  const exported = await exportRows('jira_search', 'issues', result, deps);
  assert.equal(exported._untrusted, true);
  const data = exported.data as Record<string, unknown>;
  assert.equal('issues' in data, false);
  assert.equal(data['nextPageToken'], 'n');
  assert.equal(data['hasMore'], true);
  assert.equal(data['output'], 'file');
  const descriptor = data['export'] as Record<string, unknown>;
  const name = String(descriptor['name']);
  assert.equal(descriptor['uri'], `jira://exports/${name}`);
  assert.equal(descriptor['path'], `/media/${name}`);
  assert.equal(descriptor['rows'], 2);
  assert.equal(descriptor['mimeType'], EXPORT_MIME);

  const written = text(media.files.get(name));
  assert.equal(written.includes('s3cret'), false);
  assert.equal(written.split('\n').length, 3);
  assert.equal(descriptor['bytes'], new TextEncoder().encode(written).byteLength);
  assert.equal(descriptor['preview'], written);

  // A failure passes through; a missing row array is a declaration bug.
  const failed = err({
    kind: 'not_found',
    message: 'gone',
    reason: 'gone',
    retryable: false,
  });
  assert.equal(await exportRows('jira_search', 'issues', failed, deps), failed);
  await assert.rejects(
    exportRows('jira_search', 'rows', result, deps),
    /declares fileOutput/,
  );
  assert.equal(media.files.size, 1);
});

test('[CC-1561] the resource link and the export read only answer for export uris', async () => {
  const media = createMemoryMedia();
  const name = 'jira-export-search-20261027T000000Z-0000abcd.jsonl';
  media.files.set(name, new TextEncoder().encode('{"key":"A-1"}\n'));
  const uri = `jira://exports/${name}`;

  assert.deepEqual(
    exportLinkOf({ ok: true, data: { export: { uri, name, bytes: 14 } } }),
    { type: 'resource_link', uri, name, mimeType: EXPORT_MIME, size: 14 },
  );
  assert.equal(exportLinkOf({ ok: true, data: { issues: [] } }), undefined);
  assert.equal(exportLinkOf({ ok: false }), undefined);

  const read = await readExport(uri, media);
  assert.deepEqual(read.contents, [
    { uri, mimeType: EXPORT_MIME, text: '{"key":"A-1"}\n' },
  ]);

  const notFound = (error: unknown): boolean =>
    error instanceof McpError && error.code === RESOURCE_NOT_FOUND;
  await assert.rejects(readExport('jira://exports/../etc/passwd', media), notFound);
  await assert.rejects(readExport(`${uri.replace('abcd', 'abce')}`, media), notFound);
  await assert.rejects(readExport(uri, undefined), notFound);
});
