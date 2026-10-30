// Suite for the release notes and the registry entry (V3-34, RELEASING.md §2.1).
//
// CHANGELOG.md is what a user reads before bumping the pin, so the pending
// notes (every section above the latest release's heading) must answer "what
// do I change?" in user language: a Breaking section comes with Highlights and
// an "Upgrading from" block, and internal ids (decisions, corner cases, work
// packages) sit only on trailing `Decisions:` / `Corner cases:` lines.
//
// server.json lists the variables `main` supports, not the ones the release
// named in its version field supports. That gap is honest only while every
// variable the latest release lacks is announced in the pending Upgrading
// block, so a registry listing bumped on release day matches its notes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

interface Released {
  readonly version: string;
}

interface ServerJson {
  readonly description?: string;
  readonly packages?: readonly {
    readonly environmentVariables?: readonly { readonly name: string }[];
  }[];
}

const released = JSON.parse(read('src/tools/released.json')) as Released;
const server = JSON.parse(read('server.json')) as ServerJson;
const changelog = read('CHANGELOG.md');

/** The notes not yet in a release, and the text of every released section. */
function splitChangelog(): { pending: string; releasedText: string } {
  const heading = `## [${released.version}]`;
  const at = changelog.indexOf(`\n${heading}`);
  assert.ok(at > 0, `CHANGELOG.md has no ${heading} section`);
  const first = changelog.indexOf('\n## [');
  return { pending: changelog.slice(first, at), releasedText: changelog.slice(at) };
}

/** The body of `### <prefix>…` in `text`, up to the next `##`/`###` heading. */
function block(text: string, prefix: string): string | undefined {
  const re = new RegExp(
    `^### ${prefix}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,3} |(?![\\s\\S]))`,
    'm',
  );
  return re.exec(text)?.[1];
}

/** Lines that may carry internal ids: the trailing reference lines. */
const REFERENCE_LINE = /^(?:Decisions|Corner cases): /;
const INTERNAL_ID = /\b(?:D\d{1,4}|CC-\d+|V\d+-\d+|C\d{2,3})\b|Gate C claim/;

/**
 * Variables older than the CHANGELOG's habit of naming new settings: present in
 * every published server.json, never named in a released section.
 */
const PREDATES_THE_NOTES: Record<string, string> = {
  JIRA_LOG_LEVEL: 'in server.json since 0.9.0, the first published release',
};

describe('release notes (V3-34)', () => {
  test('CC-5164: a breaking release leads with Highlights, Breaking, Upgrading', () => {
    const { pending } = splitChangelog();
    if (block(pending, 'Breaking') === undefined) return;
    const order = ['Highlights', 'Breaking', 'Upgrading from '].map((name) =>
      pending.search(new RegExp(`^### ${name}`, 'm')),
    );
    assert.ok(
      order.every((at) => at >= 0),
      'pending notes with a Breaking section need ### Highlights and ### Upgrading from <version>',
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      'Highlights, Breaking and Upgrading must come in that order',
    );
    const firstOther = pending.search(/^### (?:Added|Changed|Fixed|Removed|Security)/m);
    assert.ok(
      firstOther === -1 || firstOther > order[2]!,
      'Highlights, Breaking and Upgrading must precede Added/Changed/Fixed',
    );
  });

  test('CC-5165: internal ids sit only on the trailing reference lines', () => {
    const { pending } = splitChangelog();
    const offenders = pending
      .split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => !REFERENCE_LINE.test(line) && INTERNAL_ID.test(line))
      .map(({ line }) => line.trim());
    assert.deepEqual(offenders, [], 'pending notes cite internal ids in user text');
  });

  test('CC-5166: every variable the latest release lacks is announced in Upgrading', () => {
    const { pending, releasedText } = splitChangelog();
    const names = (server.packages?.[0]?.environmentVariables ?? []).map((v) => v.name);
    for (const name of Object.keys(PREDATES_THE_NOTES)) {
      assert.ok(
        names.includes(name),
        `stale exemption: server.json no longer lists ${name}`,
      );
    }
    const unannounced = names.filter(
      (name) =>
        !(name in PREDATES_THE_NOTES) && !new RegExp(`\\b${name}\\b`).test(releasedText),
    );
    if (unannounced.length === 0) return;
    const upgrading = block(pending, 'Upgrading from ') ?? '';
    const missing = unannounced.filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(upgrading),
    );
    assert.deepEqual(
      missing,
      [],
      `server.json lists variables ${released.version} lacks; name them in the pending ### Upgrading from block`,
    );
  });

  test('CC-5167: the registry description fits the server.json schema', () => {
    // server.schema.json caps `description` at 100 characters; the registry
    // refuses a longer entry at publish time, after the npm release.
    const description = server.description ?? '';
    assert.ok(description.length > 0, 'server.json has no description');
    assert.ok(
      description.length <= 100,
      `server.json description is ${description.length} characters, the limit is 100`,
    );
  });
});
