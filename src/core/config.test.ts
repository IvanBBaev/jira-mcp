import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { withEnv } from '../testing/with-env.js';
import {
  CONFIG_DIR_NAME,
  loadEnvFile,
  preferredEnvFilePath,
  resolveEnvFileCandidates,
  type EnvFileHost,
} from './config.js';

/** Filesystem seam: `existing` maps path -> mode; everything else is absent. */
function fakeHost(
  existing: Readonly<Record<string, number>>,
  onLoad?: (path: string) => void,
): { host: EnvFileHost; loaded: string[] } {
  const loaded: string[] = [];
  return {
    loaded,
    host: {
      statFile: (path) => existing[path],
      loadFile: (path) => {
        loaded.push(path);
        onLoad?.(path);
      },
    },
  };
}

const base = {
  homeDir: '/home/tester',
  cwd: '/work/project',
  platform: 'linux' as const,
};

describe('resolveEnvFileCandidates', () => {
  it('orders explicit, XDG, then project-local', () => {
    const candidates = resolveEnvFileCandidates({
      ...base,
      env: { JIRA_ENV_FILE: '/etc/jira.env', XDG_CONFIG_HOME: '/home/tester/xdg' },
    });
    assert.deepEqual(candidates, [
      { source: 'explicit', path: '/etc/jira.env' },
      { source: 'xdg', path: `/home/tester/xdg/${CONFIG_DIR_NAME}/.env` },
      { source: 'project', path: '/work/project/.env' },
    ]);
  });

  it('defaults the config home to ~/.config when XDG_CONFIG_HOME is unset', () => {
    const candidates = resolveEnvFileCandidates({ ...base, env: {} });
    assert.deepEqual(candidates, [
      { source: 'xdg', path: `/home/tester/.config/${CONFIG_DIR_NAME}/.env` },
      { source: 'project', path: '/work/project/.env' },
    ]);
  });

  it('ignores a relative XDG_CONFIG_HOME instead of resolving it against the cwd', () => {
    const candidates = resolveEnvFileCandidates({
      ...base,
      env: { XDG_CONFIG_HOME: 'relative/config' },
    });
    assert.equal(candidates[0]?.path, `/home/tester/.config/${CONFIG_DIR_NAME}/.env`);
  });

  it('expands a leading ~ in JIRA_ENV_FILE', () => {
    const candidates = resolveEnvFileCandidates({
      ...base,
      env: { JIRA_ENV_FILE: '~/secrets/jira.env' },
    });
    assert.equal(candidates[0]?.path, '/home/tester/secrets/jira.env');
  });

  it('never offers the project-local .env as a write target', () => {
    assert.equal(
      preferredEnvFilePath({ ...base, env: {} }),
      `/home/tester/.config/${CONFIG_DIR_NAME}/.env`,
    );
    assert.equal(
      preferredEnvFilePath({ ...base, env: { JIRA_ENV_FILE: '/etc/jira.env' } }),
      '/etc/jira.env',
    );
  });
});

describe('loadEnvFile resolution', () => {
  it('prefers JIRA_ENV_FILE over every other location', () => {
    const { host, loaded } = fakeHost({
      '/etc/jira.env': 0o600,
      [`/home/tester/.config/${CONFIG_DIR_NAME}/.env`]: 0o600,
      '/work/project/.env': 0o600,
    });
    const result = loadEnvFile({
      ...base,
      env: { JIRA_ENV_FILE: '/etc/jira.env' },
      host,
    });
    assert.equal(result.loaded, true);
    assert.equal(result.source, 'explicit');
    assert.deepEqual(loaded, ['/etc/jira.env']);
    assert.deepEqual(result.problems, []);
  });

  it('falls back to the XDG location before the project-local .env', () => {
    const xdgPath = `/home/tester/.config/${CONFIG_DIR_NAME}/.env`;
    const { host, loaded } = fakeHost({ [xdgPath]: 0o600, '/work/project/.env': 0o600 });
    const result = loadEnvFile({ ...base, env: {}, host });
    assert.equal(result.source, 'xdg');
    assert.deepEqual(loaded, [xdgPath]);
  });

  it('uses the project-local .env when nothing else exists', () => {
    const { host } = fakeHost({ '/work/project/.env': 0o600 });
    const result = loadEnvFile({ ...base, env: {}, host });
    assert.equal(result.source, 'project');
    assert.equal(result.path, '/work/project/.env');
  });

  it('treats a missing file at a fallback location as normal, not an error', () => {
    const { host, loaded } = fakeHost({});
    const result = loadEnvFile({ ...base, env: {}, host });
    assert.equal(result.loaded, false);
    assert.deepEqual(loaded, []);
    assert.deepEqual(result.problems, []);
    assert.equal(result.candidates.length, 2);
  });

  it('treats a missing file at an explicit JIRA_ENV_FILE path as an error', () => {
    const { host, loaded } = fakeHost({ '/work/project/.env': 0o600 });
    const result = loadEnvFile({
      ...base,
      env: { JIRA_ENV_FILE: '/etc/nope.env' },
      host,
    });
    assert.equal(result.loaded, false);
    assert.deepEqual(
      result.problems.map((p) => p.code),
      ['env_file_missing'],
    );
    assert.equal(result.problems[0]?.severity, 'error');
    assert.equal(result.problems[0]?.field, 'JIRA_ENV_FILE');
    // and it must NOT silently fall through to a different file
    assert.deepEqual(loaded, []);
  });

  it('warns about group/world-readable permissions but still loads', () => {
    const { host } = fakeHost({ '/work/project/.env': 0o644 });
    const result = loadEnvFile({ ...base, env: {}, host });
    assert.equal(result.loaded, true);
    assert.deepEqual(
      result.problems.map((p) => p.code),
      ['env_file_permissive'],
    );
    assert.equal(result.problems[0]?.severity, 'warning');
    assert.match(String(result.problems[0]?.message), /chmod 600/);
  });

  it('skips the permission warning on win32', () => {
    const { host } = fakeHost({ '/work/project/.env': 0o644 });
    const result = loadEnvFile({ ...base, platform: 'win32', env: {}, host });
    assert.equal(result.loaded, true);
    assert.deepEqual(result.problems, []);
  });

  it('reports an unreadable file as an error', () => {
    const { host } = fakeHost({ '/work/project/.env': 0o600 }, () => {
      throw new Error('boom');
    });
    const result = loadEnvFile({ ...base, env: {}, host });
    assert.equal(result.loaded, false);
    assert.deepEqual(
      result.problems.map((p) => p.code),
      ['env_file_unreadable'],
    );
  });
});

describe('loadEnvFile against the real filesystem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jira-mcp-env-'));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads variables with process.loadEnvFile and lets the process env win', async () => {
    const file = join(dir, 'sample.env');
    writeFileSync(file, 'ENV_FILE_PROBE_A=from-file\nENV_FILE_PROBE_B=from-file\n', {
      mode: 0o600,
    });

    await withEnv(
      {
        JIRA_ENV_FILE: file,
        ENV_FILE_PROBE_A: undefined,
        ENV_FILE_PROBE_B: 'from-process',
      },
      () => {
        const result = loadEnvFile();
        assert.equal(result.loaded, true);
        assert.equal(result.path, file);
        assert.equal(result.mode, 0o600);
        // absent -> filled from the file
        assert.equal(process.env.ENV_FILE_PROBE_A, 'from-file');
        // already set -> the file does NOT overwrite it
        assert.equal(process.env.ENV_FILE_PROBE_B, 'from-process');
      },
    );

    assert.equal(process.env.ENV_FILE_PROBE_A, undefined);
    assert.equal(process.env.ENV_FILE_PROBE_B, undefined);
  });
});
