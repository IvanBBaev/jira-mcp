/**
 * The unreachable arm of an exhaustive switch (D537 / TSN-08).
 *
 * `switch-exhaustiveness-check` runs with `considerDefaultExhaustiveForUnions:
 * false`, so a `default:` never stands in for a missing union member. Where a
 * switch still needs a `default:` arm (a value that crossed a trust boundary,
 * a function that must return), that arm calls `assertNever(value)`: the
 * parameter type makes a forgotten member a compile error, and the throw
 * makes a value outside the declared type fail loudly instead of falling
 * through.
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unexpected ${what}: ${String(value)}`);
}
