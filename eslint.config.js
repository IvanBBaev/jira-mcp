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
// src/mcp/define.ts, which exports a curated `z` (D537), so a zod major or a
// schema-library swap stays a one-file change and the builders tool modules
// may reach are reviewed. Type-only imports are fine anywhere — they vanish
// at build time.
const noZodRuntimeImport = {
  selector: "ImportDeclaration[importKind!='type'][source.value=/^zod(\\u002F.*)?$/]",
  message:
    'zod runtime usage is quarantined to src/mcp/define.ts (ARCHITECTURE.md / D537). ' +
    'Import the curated `z` and helpers from mcp/define.js, or use `import type`.',
};

// ARCHITECTURE.md §Error model / D536: redaction and the cause-then-recovery
// message are applied by `createJiraError` at construction; the `JiraError`
// constructor only copies fields. A direct `new JiraError(...)` skips both, so
// it is allowed only inside core/errors.ts (the choke point) and in tests.
const noDirectJiraError = {
  selector: "NewExpression[callee.name='JiraError']",
  message:
    'Build errors with createJiraError() from core/errors.ts (D536): a direct ' +
    '`new JiraError(...)` skips redaction and the remediation composition.',
};

// D539 / V3-61: `src/mcp/sdk.ts` is the one production module that imports the
// MCP SDK, so an SDK major or the 3.0 wire (V3-28) changes a single file. Static
// imports and re-exports are banned by `@typescript-eslint/no-restricted-imports`
// (a separate rule name, so it does not clobber the layer patterns that live on
// the base `no-restricted-imports`); a dynamic `import()` by this selector. Tests
// are exempt: they drive the server through the SDK's client side.
const SDK_SPECIFIERS = ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'];
const SDK_SEAM_MESSAGE =
  'Import the MCP SDK through src/mcp/sdk.ts (D539): it is the one module that ' +
  'touches @modelcontextprotocol/sdk. Re-export the symbol there if it is missing.';
const noSdkDynamicImport = {
  selector: 'ImportExpression[source.value=/^@modelcontextprotocol\\u002Fsdk/]',
  message: SDK_SEAM_MESSAGE,
};

// D518 / V3-13: the Data Center twins live in src/api/datacenter/. Cloud api
// modules must not depend on them, so removing Data Center (V3-27, 3.0) stays a
// directory delete. A static `import` of a `datacenter/` module or of the
// `datacenter.js` barrel is banned outside that directory; `export … from` stays
// allowed, because the Cloud modules keep re-exporting the moved names as
// compatibility barrels. adapters.ts picks the adapter, so it is exempt.
const noDataCenterImport = {
  selector: 'ImportDeclaration[source.value=/(^|\\u002F)datacenter(\\u002F|\\.js$)/]',
  message:
    'Cloud api modules must not import the Data Center adapter (D518): keep the ' +
    'dependency one-way, from src/api/datacenter/ to the Cloud modules.',
};

export default tseslint.config(
  {
    ignores: [
      'build/',
      'coverage/',
      'node_modules/',
      'docs/',
      '.stryker-tmp/',
      'reports/',
    ],
  },

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
      // D537 / TSN-08: a switch over a union must name every member. A
      // `default:` does not count as coverage, so adding a member to a union
      // (an `AuthMode`, a tool kind) fails lint at every switch that forgot
      // it; unreachable defaults call `assertNever` from core/assert-never.ts.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: false,
          allowDefaultCaseForExhaustiveSwitch: true,
        },
      ],
      // D537 / TSN-13: type-only imports are spelled `import type`, which
      // `verbatimModuleSyntax` then keeps out of the emitted JavaScript.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // D537 / TSN-08 `strictTypeChecked` trial (959 hits over src/, 2026-11-08):
      // the rules with a handful of hits are adopted here; the rest stay off
      // until a work package budgets them — no-unnecessary-condition 599 (585
      // in tests), restrict-template-expressions 135, no-unnecessary-type-
      // arguments 71, no-confusing-void-expression 54, no-unnecessary-type-
      // conversion 26, no-deprecated 25, no-dynamic-delete 19, no-non-null-
      // assertion 14 (tests only), no-misused-spread 4 (deliberate code-point
      // splits), no-unnecessary-type-parameters 2 (test helpers), and
      // no-unnecessary-boolean-literal-compare 5 (its fixes drop `=== true` on
      // values the types call boolean but the runtime may leave undefined,
      // such as `process.stdin.isTTY`).
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/restrict-plus-operands': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumberAndString: false,
          allowRegExp: false,
        },
      ],
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

  // AbortSignal.timeout, the zod quarantine, the JiraError choke point and the
  // SDK seam's dynamic-import half. All four live on no-restricted-syntax, so
  // they are configured together; the exempt files are excluded here and re-listed below with only the entries
  // that still apply to them (splitting the rule across an `off` override
  // would drop the other bans with it).
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/mcp/define.ts',
      'src/mcp/sdk.ts',
      'src/core/errors.ts',
      'src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        noAbortSignalTimeout,
        noZodRuntimeImport,
        noDirectJiraError,
        noSdkDynamicImport,
      ],
    },
  },
  {
    files: ['src/mcp/define.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noAbortSignalTimeout,
        noDirectJiraError,
        noSdkDynamicImport,
      ],
    },
  },
  {
    files: ['src/mcp/sdk.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noAbortSignalTimeout,
        noZodRuntimeImport,
        noDirectJiraError,
      ],
    },
  },
  // The Cloud api modules carry the base bans plus the Data Center one (D518).
  {
    files: ['src/api/**/*.ts'],
    ignores: [
      'src/api/datacenter/**',
      'src/api/datacenter.ts',
      'src/api/adapters.ts',
      'src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        noAbortSignalTimeout,
        noZodRuntimeImport,
        noDirectJiraError,
        noSdkDynamicImport,
        noDataCenterImport,
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/mcp/sdk.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: SDK_SPECIFIERS, message: SDK_SEAM_MESSAGE }] },
      ],
    },
  },
  {
    files: ['src/core/errors.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', noAbortSignalTimeout, noZodRuntimeImport],
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
