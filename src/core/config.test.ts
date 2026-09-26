import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { withEnv } from '../testing/with-env.js';
import {
  CONFIG_DIR_NAME,
  OAUTH_TOKEN_FILE_NAME,
  defaultOAuthTokenFile,
  loadEnvFile,
  nodeEnvFileHost,
  preferredEnvFilePath,
  resolveConfigDir,
  resolveConfigPath,
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

  it('with no home directory at all, the only candidate left is the project one', () => {
    // Nothing else to offer — the writer gets the checkout path and the
    // operator who runs without $HOME has accepted that.
    assert.equal(
      preferredEnvFilePath({ ...base, homeDir: '', env: {} }),
      '/work/project/.env',
    );
    assert.deepEqual(
      resolveEnvFileCandidates({ ...base, homeDir: '', env: {} }).map((c) => c.source),
      ['project'],
    );
  });
});

describe('config dir and the OAuth token store', () => {
  it('puts the token store beside the env file it belongs to', () => {
    assert.equal(
      resolveConfigDir({ ...base, env: {} }),
      `/home/tester/.config/${CONFIG_DIR_NAME}`,
    );
    assert.equal(
      defaultOAuthTokenFile({ ...base, env: {} }),
      `/home/tester/.config/${CONFIG_DIR_NAME}/${OAUTH_TOKEN_FILE_NAME}`,
    );
  });

  it('follows XDG_CONFIG_HOME, and ignores a relative one like the env file does', () => {
    assert.equal(
      defaultOAuthTokenFile({ ...base, env: { XDG_CONFIG_HOME: '/home/tester/xdg' } }),
      `/home/tester/xdg/${CONFIG_DIR_NAME}/${OAUTH_TOKEN_FILE_NAME}`,
    );
    assert.equal(
      defaultOAuthTokenFile({ ...base, env: { XDG_CONFIG_HOME: 'relative/config' } }),
      `/home/tester/.config/${CONFIG_DIR_NAME}/${OAUTH_TOKEN_FILE_NAME}`,
    );
  });

  it('falls back to the cwd when there is no home directory at all', () => {
    assert.equal(
      defaultOAuthTokenFile({ ...base, homeDir: '', env: {} }),
      `/work/project/${CONFIG_DIR_NAME}/${OAUTH_TOKEN_FILE_NAME}`,
    );
  });

  it('normalises an operator-supplied path the way JIRA_ENV_FILE is normalised', () => {
    assert.equal(
      resolveConfigPath('~/secrets/oauth.json', base),
      '/home/tester/secrets/oauth.json',
    );
    assert.equal(resolveConfigPath('oauth.json', base), '/work/project/oauth.json');
    assert.equal(resolveConfigPath('/var/lib/oauth.json', base), '/var/lib/oauth.json');
  });

  it('expands a bare tilde and defaults to the real home and cwd', () => {
    assert.equal(resolveConfigPath('~', base), '/home/tester');
    assert.equal(
      resolveConfigPath('~\\oauth.json', base),
      join('/home/tester', 'oauth.json'),
    );
    assert.equal(resolveConfigPath('~'), homedir());
    assert.equal(resolveConfigPath('oauth.json'), resolve(process.cwd(), 'oauth.json'));
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

  it('[CC-236] a blank process value does not shadow the file, and stays when the file lacks it', async () => {
    const file = join(dir, 'blank.env');
    writeFileSync(file, 'ENV_FILE_PROBE_C=from-file\n', { mode: 0o600 });

    await withEnv(
      { JIRA_ENV_FILE: file, ENV_FILE_PROBE_C: '', ENV_FILE_PROBE_D: '  ' },
      () => {
        assert.equal(loadEnvFile().loaded, true);
        // blank in the process env -> the file's value is used
        assert.equal(process.env.ENV_FILE_PROBE_C, 'from-file');
        // blank and absent from the file -> left exactly as it was
        assert.equal(process.env.ENV_FILE_PROBE_D, '  ');
      },
    );
  });

  it('the real host reports a file mode, and nothing for a directory or a missing path', () => {
    const file = join(dir, 'mode.env');
    writeFileSync(file, 'X=1\n');
    // Set explicitly: a `mode` on the write is masked by the umask, and a
    // hardened runner's 077 would turn 0640 into 0600.
    chmodSync(file, 0o640);

    assert.equal(nodeEnvFileHost.statFile(file), 0o640);
    assert.equal(nodeEnvFileHost.statFile(dir), undefined);
    assert.equal(nodeEnvFileHost.statFile(join(dir, 'absent.env')), undefined);
  });
});
