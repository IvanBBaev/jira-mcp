// ---------------------------------------------------------------------------
// api/guards.ts — the pure readers every api module narrows wire JSON with.
//
// Pure: no imports, no I/O, no errors. A reader returns `undefined` for a
// value it cannot use and leaves the failure policy (`unexpected_shape`, a
// default, a skip) to the caller — the throwing twins live in `api/wire.ts`.
// Each helper is defined here once; before V3-56 every api module kept its own
// copy (TSN-05).
// ---------------------------------------------------------------------------

/** A plain JSON object: not `null`, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** {@link isRecord} as a reader: the object, or `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** A non-empty string at `key`, or `undefined`. */
export function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A finite number at `key`, or `undefined`. */
export function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A shallow copy without the `undefined` entries. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}
