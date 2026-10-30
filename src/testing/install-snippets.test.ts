// Suite for the client-registration snippets (V3-32): the README quick start,
// the Pages #install section and CONFIGURATION.md §Registering with a client.
//
// docs-lint check 5 keeps every literal `jira-mcp-ai@x.y.z` pin equal to
// CONFIGURATION.md's, but the Cursor and VS Code install links carry the pin
// encoded (base64 and percent-encoding), out of that regex's reach. This suite
// decodes them so a release bump that misses a link fails here. It also makes
// the secret-safety rule mechanical: no registration snippet in a user doc
// carries an API token, so a pasted example can never put one in a repository.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { REPO_ROOT } from '../core/fakes/fixtures.js';

const SNIPPET_DOCS = [
  'README.md',
  'docs/index.html',
  'docs/CONFIGURATION.md',
  'docs/AUTH.md',
] as const;

const LINK_DOCS = ['README.md', 'docs/index.html', 'docs/CONFIGURATION.md'] as const;

const PIN_RE = /jira-mcp-ai@\d+\.\d+\.\d+/;

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

function canonicalPin(): string {
  const pin = PIN_RE.exec(read('docs/CONFIGURATION.md'))?.[0];
  assert.ok(pin, 'CONFIGURATION.md states no pinned registration example');
  return pin;
}

interface ServerConfig {
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: Record<string, unknown>;
}

/** Every install link in `text`, decoded to the server config it installs. */
function installLinks(text: string): { kind: string; config: ServerConfig }[] {
  const out: { kind: string; config: ServerConfig }[] = [];
  const unescaped = text.replaceAll('&amp;', '&');
  for (const m of unescaped.matchAll(
    /https:\/\/cursor\.com\/[a-z-]*\/?install-mcp\?([^)"\s]+)/g,
  )) {
    const config = new URLSearchParams(m[1]).get('config');
    assert.ok(config, `Cursor link without a config: ${m[0]}`);
    out.push({
      kind: 'cursor',
      config: JSON.parse(Buffer.from(config, 'base64').toString('utf8')) as ServerConfig,
    });
  }
  for (const m of unescaped.matchAll(
    /https:\/\/insiders\.vscode\.dev\/redirect\/mcp\/install\?([^)"\s]+)/g,
  )) {
    const config = new URLSearchParams(m[1]).get('config');
    assert.ok(config, `VS Code link without a config: ${m[0]}`);
    out.push({ kind: 'vscode', config: JSON.parse(config) as ServerConfig });
  }
  return out;
}

describe('client registration snippets (V3-32)', () => {
  test('CC-5150: every install link installs the pinned version with no secret', () => {
    const pin = canonicalPin();
    for (const rel of LINK_DOCS) {
      const links = installLinks(read(rel));
      const kinds = new Set(links.map((l) => l.kind));
      assert.ok(kinds.has('cursor'), `${rel} has no Cursor install link`);
      assert.ok(kinds.has('vscode'), `${rel} has no VS Code install link`);
      for (const { kind, config } of links) {
        assert.equal(config.command, 'npx', `${rel} ${kind} link command`);
        assert.deepEqual(config.args, ['-y', pin], `${rel} ${kind} link args`);
        const env = Object.keys(config.env ?? {});
        assert.deepEqual(
          env.filter((name) => /TOKEN|SECRET|PASSWORD|EMAIL/.test(name)),
          [],
          `${rel} ${kind} link carries a credential`,
        );
      }
    }
  });

  test('CC-5151: no registration snippet sets the API token', () => {
    for (const rel of SNIPPET_DOCS) {
      const text = read(rel);
      // A JSON env entry, in plain or syntax-highlighted HTML form...
      const json = /"JIRA_API_TOKEN"(?:<\/span>)?\s*:/.exec(text);
      assert.equal(json, null, `${rel} puts JIRA_API_TOKEN in a client config`);
      // ...or a `claude mcp add -e` / `--env` flag.
      const flag = /(?:-e|--env)\s+JIRA_API_TOKEN=/.exec(text);
      assert.equal(flag, null, `${rel} passes JIRA_API_TOKEN on a command line`);
    }
  });

  test('CC-5152: README and the site send the user to the owned registration section', () => {
    const anchor = 'CONFIGURATION.md#registering-with-a-client';
    assert.match(read('docs/CONFIGURATION.md'), /^## Registering with a client$/m);
    for (const rel of ['README.md', 'docs/index.html']) {
      assert.ok(read(rel).includes(anchor), `${rel} does not link ${anchor}`);
    }
  });

  test('CC-5153: README and the site no longer copy the PATH and log-location prose', () => {
    for (const rel of ['README.md', 'docs/index.html']) {
      const text = read(rel);
      assert.equal(
        text.includes('Library/Logs/Claude'),
        false,
        `${rel} restates the log locations`,
      );
      assert.equal(
        text.includes('/usr/local/bin/npx'),
        false,
        `${rel} restates the PATH fix`,
      );
    }
  });
});
