import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createNodeResolver } from 'eslint-plugin-import-x/node-resolver';
import prettier from 'eslint-config-prettier';

// Node globals, declared inline instead of pulling in the `globals` package —
// this repo's authorized dependency set does not include it, and the surface we
// actually touch is small. `no-undef` is disabled for TypeScript by
// typescript-eslint's eslint-recommended overrides; this map is what keeps the
// plain-JS files (bin launcher, scripts, this config) honest.
const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Buffer: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  globalThis: 'readonly',
  performance: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
};

const cjsGlobals = {
  ...nodeGlobals,
  __dirname: 'readonly',
  __filename: 'readonly',
  exports: 'writable',
  module: 'writable',
  require: 'readonly',
};

// ARCHITECTURE.md §Cross-cutting seams: `AbortSignal.timeout` owns a real timer
// the fake clock cannot drive, which would make every timeout test wall-clock
// bound. Timeouts are `clock.sleep(timeoutMs)` raced against fetch with an
// explicit AbortController. Banned with no exemption, in every file type.
const noAbortSignalTimeout = {
  selector: "MemberExpression[object.name='AbortSignal'][property.name='timeout']",
  message:
    'AbortSignal.timeout is banned (ARCHITECTURE.md): race clock.sleep() against ' +
    'the fetch promise with an explicit AbortController instead, so the fake clock ' +
    'drives timeout tests.',
};

// ARCHITECTURE.md §MCP server style: zod runtime usage is quarantined to
// src/mcp/define.ts so a future zod-v4 migration (D9) stays a bounded change.
// Type-only imports are fine anywhere — they vanish at build time.
const noZodRuntimeImport = {
  selector: "ImportDeclaration[importKind!='type'][source.value=/^zod(\\u002F.*)?$/]",
  message:
    'zod runtime usage is quarantined to src/mcp/define.ts (ARCHITECTURE.md / D9). ' +
    'Import the re-exported helpers from mcp/define.js, or use `import type`.',
};

export default tseslint.config(
  { ignores: ['build/', 'coverage/', 'node_modules/', 'docs/'] },

  js.configs.recommended,

  // Type-checked rules for the TypeScript source. Scoped to src/ so plain-JS
  // config/bin/script files stay on the syntax-only ruleset.
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...nodeGlobals },
    },
    rules: {
      // A forgotten await in an async handler silently drops errors.
      '@typescript-eslint/no-floating-promises': 'error',
      // ARCHITECTURE.md §Typing strategy: wire data enters as `unknown` and is
      // narrowed by hand-rolled guards. `any` defeats the whole contract.
      '@typescript-eslint/no-explicit-any': 'error',
      // stdout is the stdio JSON-RPC channel: console.log/info/debug (stdout)
      // are forbidden in the server source; console.warn/error (stderr, via the
      // redacting logger) remain allowed.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // node:test's top-level test()/describe() return a promise the runner itself
  // manages; not awaiting them is the intended idiom, so this rule would only
  // produce noise in colocated *.test.ts files.
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Determinism seams (ARCHITECTURE.md §Cross-cutting seams, TESTING.md):
  // all time flows through the injected Clock and all randomness through the
  // injected rng, so retries/backoff/jitter are asserted exactly (CC-11…CC-14).
  // The seam modules themselves are the only place the primitives may appear,
  // so they are excluded from this block rather than switched off in a later
  // one (a later `off` for the same rule would unset it repo-wide).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/core/clock.ts', 'src/core/rng.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'setTimeout',
          message:
            'Use the core/clock.ts sleep seam so timing is testable under the mock clock.',
        },
        {
          name: 'setInterval',
          message:
            'Use the core/clock.ts seam so timing is testable under the mock clock.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message:
            'Use the injected Clock (core/clock.ts) so time is testable under the mock clock.',
        },
        {
          object: 'Math',
          property: 'random',
          message:
            'Use the injected rng seam so backoff jitter and correlation ids are deterministic in tests.',
        },
      ],
    },
  },

  // AbortSignal.timeout + the zod quarantine. Both live on no-restricted-syntax,
  // so they are configured together; src/mcp/define.ts is excluded here and
  // re-listed below with only the AbortSignal entry (splitting the rule across
  // an `off` override would drop the AbortSignal ban with it).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/mcp/define.ts'],
    rules: {
      'no-restricted-syntax': ['error', noAbortSignalTimeout, noZodRuntimeImport],
    },
  },
  {
    files: ['src/mcp/define.ts'],
    rules: {
      'no-restricted-syntax': ['error', noAbortSignalTimeout],
    },
  },

  // Layer boundaries — core <- api <- mcp <- tools — as import-x path zones:
  // a target directory may not import *from* the listed higher layers. tools/
  // and cli/ are composition roots and are intentionally unrestricted.
  //
  // The resolver is import-x's own node resolver taught the TypeScript
  // extension aliases, so NodeNext's `./foo.js` specifiers resolve to `foo.ts`.
  // Without that mapping every cross-layer import would silently fail to
  // resolve and the zone rule would pass by doing nothing.
  {
    files: ['src/**/*.ts'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createNodeResolver({
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
          extensionAlias: {
            '.js': ['.ts', '.tsx', '.js'],
            '.mjs': ['.mts', '.mjs'],
            '.cjs': ['.cts', '.cjs'],
          },
        }),
      ],
    },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/core',
              from: ['./src/api', './src/mcp', './src/tools', './src/cli'],
              message:
                'core is layer 0 — it must not import from api/, mcp/, tools/ or cli/.',
            },
            {
              target: './src/api',
              from: ['./src/mcp', './src/tools', './src/cli'],
              message: 'api is layer 1 — it must not import from mcp/, tools/ or cli/.',
            },
            {
              target: './src/mcp',
              from: ['./src/tools', './src/cli'],
              message: 'mcp is layer 2 — it must not import from tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },

  // The same layer map expressed with string-based no-restricted-imports, so
  // enforcement never depends on module resolution (ARCHITECTURE.md §Layering:
  // "enforced twice"). The three globs are disjoint, so no config clobbers
  // another's copy of the rule.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/mcp/**', '**/tools/**', '**/cli/**'],
              message:
                'core is layer 0 — it must not import from api/, mcp/, tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/mcp/**', '**/tools/**', '**/cli/**'],
              message: 'api is layer 1 — it must not import from mcp/, tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tools/**', '**/cli/**'],
              message: 'mcp is layer 2 — it must not import from tools/ or cli/.',
            },
          ],
        },
      ],
    },
  },

  // Plain JS/MJS (this config, scripts/docs-lint.mjs, future tooling):
  // syntax-only. These are CLIs — stdout is their report channel, so console is
  // allowed.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...nodeGlobals } },
    rules: {
      'no-restricted-syntax': ['error', noAbortSignalTimeout],
    },
  },

  // CommonJS launcher shim (bin/*.cjs): must stay CJS so it parses on old Node
  // versions before it can print the engines error, so it needs the CJS source
  // type rather than the ESM default.
  {
    files: ['**/*.cjs'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...cjsGlobals },
    },
    rules: {
      // The launcher is deliberately ES5-shaped so the version guard still runs
      // (rather than dying at parse time) on the old runtimes it exists to warn.
      'no-var': 'off',
      'no-restricted-syntax': ['error', noAbortSignalTimeout],
    },
  },

  prettier,
);
