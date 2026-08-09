// Scoped environment overrides for tests.
//
// `loadSettings()` reads `process.env`, so settings/doctor tests have to write
// to it — and a test that forgets to clean up poisons every test that runs after
// it in the same process. `withEnv` restores the previous values in a `finally`,
// so even a throwing assertion cannot leak state.
//
// The network fence already stripped ambient `JIRA_*` variables on import
// (`./network-fence.js`), so what a test sets here is the whole environment as
// far as the code under test is concerned.

/**
 * Variables to set for the duration of the callback. An `undefined` value
 * DELETES the variable — that is how "this var is not set" is expressed, since
 * `process.env.X = undefined` would set the literal string `"undefined"`.
 */
export type EnvOverrides = Readonly<Record<string, string | undefined>>;

/**
 * Apply `overrides` to `process.env`, run `fn`, then restore every touched key
 * to exactly what it was — including keys that were previously absent, which are
 * deleted again rather than set to an empty string.
 */
export async function withEnv<T>(
  overrides: EnvOverrides,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
