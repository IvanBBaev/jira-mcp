#!/usr/bin/env node
// CommonJS launcher whose only job is the Node version guard. It must stay
// parseable by ancient Node (no arrow functions, no `?.`/`??`, no ESM syntax):
// the real entry is an ESM graph that old Node fails to *parse*, so a guard
// living inside it could never run. `import()` is deliberately the one modern
// construct here — it has been parseable since Node 12, long before the
// runtimes this guard exists to warn about.
//
// Failure sets `process.exitCode` and returns; it never calls `process.exit()`.
// Every failure here is a diagnostic on stderr, and under an MCP client stderr
// is a pipe: `process.exit()` tears the process down with the write still in the
// pipe buffer, which silently truncates the message at 64 KiB (measured). The
// same rule governs `src/index.ts` (CC-91), and for the same reason — the one
// sentence explaining why the server did not start is the whole value of these
// paths, so it must survive.
'use strict';

var major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  console.error(
    'jira-mcp-ai requires Node.js >= 22, but this is ' +
      process.versions.node +
      '.\nNode 22 is the floor because the server loads env files with ' +
      'process.loadEnvFile() instead of dotenv.\nUse a newer runtime, e.g.: nvm install 24 && nvm use 24',
  );
  process.exitCode = 1;
} else {
  // Importing the entry module is not enough to start it: its self-run guard
  // compares process.argv[1] against its own path, and here argv[1] is *this*
  // shim (ARCHITECTURE.md §Dependency injection boundary). So call the exported
  // entry point explicitly, or the binary exits 0 having done nothing at all.
  import('../build/index.js')
    .then(function (mod) {
      var run = mod && mod.main;
      if (typeof run !== 'function') {
        console.error(
          'jira-mcp-ai: build/index.js exports no main() entry point. ' +
            'From a source checkout, run `npm run build` first.',
        );
        process.exitCode = 1;
        return undefined;
      }
      return run();
    })
    .catch(function (err) {
      console.error(
        'jira-mcp-ai: the compiled server could not be started. From a source ' +
          'checkout, run `npm run build` first.\n' +
          (err && err.stack ? err.stack : String(err)),
      );
      process.exitCode = 1;
    });
}
