// Recording {@link Redactor} (test-only).
//
// Value-based, like the real one: registered secret VALUES are replaced wherever
// they appear, at any depth. It really redacts rather than passing values
// through, so a test can assert both halves of the contract — that the choke
// point was called AND that the token is gone from the output.
//
// Scope is secrets, not PII: accountIds, display names and issue text are
// workspace data the model needs (THREAT-MODEL.md §Redaction scope).

import type { Redactor } from '../types.js';

/** The stand-in written over every registered secret. */
export const FAKE_PLACEHOLDER = '[REDACTED]';

/** A {@link Redactor} that records what it was asked to redact. */
export interface FakeRedactor extends Redactor {
  /** Secret values registered so far, in registration order. */
  readonly secrets: readonly string[];
  /** Every value passed to `redact`. */
  readonly calls: readonly unknown[];
  /** Every string passed to `redactString`. */
  readonly stringCalls: readonly string[];
  /** Drop the recordings; keeps the registered secrets. */
  clear(): void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a recording redactor seeded with `secrets`. Empty strings are ignored:
 * a secret of `''` would match between every character and blank the output.
 */
export function createFakeRedactor(
  secrets: readonly string[] = [],
  placeholder: string = FAKE_PLACEHOLDER,
): FakeRedactor {
  const registered: string[] = [];
  const calls: unknown[] = [];
  const stringCalls: string[] = [];

  const addSecret = (value: string): void => {
    if (value !== '' && !registered.includes(value)) registered.push(value);
  };
  for (const secret of secrets) addSecret(secret);

  const scrub = (text: string): string => {
    let out = text;
    for (const secret of registered) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), placeholder);
    }
    return out;
  };

  const deep = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = deep(item);
      }
      return out;
    }
    return value;
  };

  return {
    secrets: registered,
    calls,
    stringCalls,
    redact: (value: unknown): unknown => {
      calls.push(value);
      return deep(value);
    },
    redactString: (text: string): string => {
      stringCalls.push(text);
      return scrub(text);
    },
    addSecret,
    clear: (): void => {
      calls.length = 0;
      stringCalls.length = 0;
    },
  };
}
