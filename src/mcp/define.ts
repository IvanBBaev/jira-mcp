// ---------------------------------------------------------------------------
// `defineTool` — tools as data, validated at IMPORT time (ARCHITECTURE.md
// §Tool definition contract, TOOLS.md §Control fields / §Annotations reference).
//
// A tool is a plain object: name, title, description, package, the mandatory
// annotation quadruple, a `.strict()` zod input schema and a handler. Nothing in
// a `ToolSpec` reaches for a transport, a server or global state, which is what
// lets the same array drive server registration, the manifest snapshot test,
// README generation and `server.json` generation from ONE source.
//
// `defineTool` is an identity function for the type system plus a set of
// assertions. They are deliberately eager: a malformed spec is a programming
// error that must surface when the manifest module is loaded — in
// `npm run check`, not on a user's `tools/call`.
//
// THE ZOD QUARANTINE LIVES HERE. `eslint.config.js` bans runtime `zod` imports
// in every other file (ARCHITECTURE.md §MCP server style, D9), so the schema
// builders below — and the re-exported `z` — are the only legal way for a tool
// module to reach zod values. Keep every runtime zod touch inside this file.
//
// Layering: `core ← api ← mcp ← tools`. This file imports `core` types only.
// ---------------------------------------------------------------------------

import { z } from 'zod';

import { JiraError } from '../core/types.js';
import { PACKAGE_IDS, WRITE_TIERS } from './types.js';
import type { ToolAnnotations, ToolSpec } from './types.js';

/**
 * Re-exported so tool modules can build schemas without importing `zod`
 * directly — which eslint forbids outside this file. Prefer {@link toolInput} /
 * {@link writeToolInput} for the object itself; `z` is for the leaves.
 */
export { z } from 'zod';

// ---------------------------------------------------------------------------
// Name and strictness probes
// ---------------------------------------------------------------------------

/** `jira_` + lowercase snake case. Matches every name in TOOLS.md. */
export const TOOL_NAME_PATTERN = /^jira_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** A key no real caller would send, used to probe `.strict()` behaviour. */
const STRICTNESS_PROBE = '__jira_mcp_strictness_probe__';

/**
 * True when `schema` rejects unknown keys. Probed BEHAVIOURALLY rather than by
 * reading zod internals: a `.strict()` object reports an `unrecognized_keys`
 * issue alongside any missing-field issues, wrappers (`.refine`, `.default`)
 * pass the inner issues through, and a stripping object simply succeeds or fails
 * without ever mentioning the probe key.
 */
export function rejectsUnknownKeys(schema: z.ZodTypeAny): boolean {
  const parsed = schema.safeParse({ [STRICTNESS_PROBE]: 1 });
  if (parsed.success) return false;
  return parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
}

/**
 * True when `schema` declares `key` — i.e. it does not report it as an
 * unrecognized key. Missing-required-field issues are irrelevant here, so the
 * probe works on a schema with any number of required arguments.
 */
export function declaresKey(schema: z.ZodTypeAny, key: string, sample: unknown): boolean {
  const parsed = schema.safeParse({ [key]: sample });
  if (parsed.success) return true;
  return !parsed.error.issues.some(
    (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes(key),
  );
}

// ---------------------------------------------------------------------------
// Control fields (TOOLS.md §Control fields)
// ---------------------------------------------------------------------------

/** The three auto-injected control fields, in `ControlFields` declaration order. */
export const CONTROL_FIELD_NAMES = ['apply', 'plan_id', 'profile'] as const;

/** One of the auto-injected control-field names. */
export type ControlFieldName = (typeof CONTROL_FIELD_NAMES)[number];

/** Write-only control fields: present on a write tool, absent on a read tool. */
export const WRITE_CONTROL_FIELD_NAMES = ['apply', 'plan_id'] as const;

/** Probe values used to detect a declared control field; the type never matters. */
const CONTROL_PROBE: Readonly<Record<ControlFieldName, unknown>> = Object.freeze({
  apply: true,
  plan_id: 'probe',
  profile: 'probe',
});

/** Normative `.describe()` text for `profile`; client UIs render it verbatim. */
export const PROFILE_DESCRIPTION =
  'Named credential profile for this call. Omit to use the active profile. ' +
  'Rejected when the server locks the profile (JIRA_LOCK_PROFILE).';

/** Normative `.describe()` text for `apply` (write tools only). */
export const APPLY_DESCRIPTION =
  'Set true to EXECUTE this write. Omit (or false) to get a plan of the request ' +
  'that would be sent. Executing also requires the server to run with ' +
  'JIRA_WRITE_MODE=apply.';

/** Normative `.describe()` text for `plan_id` (write tools only). */
export const PLAN_ID_DESCRIPTION =
  'The single-use id returned by the preceding plan-mode call. Required together ' +
  'with apply: true; a mismatch means the arguments changed since the plan, and ' +
  'the write is refused rather than executed.';

/** The shared `profile` argument, identical on every tool. */
export const profileArg = z.string().min(1).optional().describe(PROFILE_DESCRIPTION);

/** The `apply` gate flag, present on write tools only. */
export const applyArg = z.boolean().optional().describe(APPLY_DESCRIPTION);

/** The `plan_id` binding, present on write tools only. */
export const planIdArg = z.string().min(1).optional().describe(PLAN_ID_DESCRIPTION);

/**
 * Input schema for a READ tool: the caller's shape plus the auto-injected
 * `profile` control field, sealed with `.strict()`.
 *
 * Control fields are spread LAST on purpose — unlike the tiktok donor's
 * `account`, they are a law rather than a default: `mcp/write-mode.ts` (WP-24)
 * strips them before the handler runs, so a tool that redefined one would find
 * its own field silently removed.
 */
export function toolInput<Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<Shape & { profile: typeof profileArg }, 'strict'> {
  return z.object({ ...shape, profile: profileArg }).strict();
}

/**
 * Input schema for a WRITE tool: {@link toolInput} plus the `apply` / `plan_id`
 * plan-gate fields (D14). A read tool must NOT carry these — `defineTool`
 * rejects the mismatch.
 */
export function writeToolInput<Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<
  Shape & {
    apply: typeof applyArg;
    plan_id: typeof planIdArg;
    profile: typeof profileArg;
  },
  'strict'
> {
  return z
    .object({ ...shape, apply: applyArg, plan_id: planIdArg, profile: profileArg })
    .strict();
}

// ---------------------------------------------------------------------------
// The import-time assertions
// ---------------------------------------------------------------------------

/** The annotation quadruple, in `ToolAnnotations` declaration order. */
const ANNOTATION_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const satisfies readonly (keyof ToolAnnotations)[];

/**
 * A malformed tool spec is a startup problem, so it surfaces as
 * `kind: 'config'` — the same kind doctor reports for a bad environment. It is
 * never a `validation` error: nothing about the caller's request is wrong.
 */
function specError(name: string, problem: string): JiraError {
  return new JiraError({
    kind: 'config',
    message: `Tool spec "${name}" is invalid: ${problem}.`,
    retryable: false,
    remediation:
      'Fix the tool definition; this is a bug in the server, not in the request.',
  });
}

/**
 * Register a tool. Returns the spec unchanged (frozen), so a module can both
 * export the value and use it inline in the `PACKAGES` manifest.
 *
 * Assertions, in order: name pattern, non-empty title/description, known
 * package, the annotation quadruple present and boolean,
 * `readOnlyHint && destructiveHint` rejected, `writeTier ⇔ !readOnlyHint`,
 * handler callable, `.strict()` probed behaviourally, and the auto-injected
 * control fields declared (`profile` always; `apply`/`plan_id` on write tools
 * and only there).
 */
export function defineTool<In, Out>(spec: ToolSpec<In, Out>): ToolSpec<In, Out> {
  const { name } = spec;

  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw specError(
      String(name),
      'the name must be lowercase snake case prefixed with "jira_" ' +
        `(${TOOL_NAME_PATTERN.source})`,
    );
  }
  if (typeof spec.title !== 'string' || spec.title.trim() === '') {
    throw specError(name, 'title is empty');
  }
  if (typeof spec.description !== 'string' || spec.description.trim() === '') {
    throw specError(name, 'description is empty');
  }
  if (!PACKAGE_IDS.includes(spec.package)) {
    throw specError(
      name,
      `package "${String(spec.package)}" is not one of ${PACKAGE_IDS.join(', ')}`,
    );
  }
  if (typeof spec.handler !== 'function') {
    throw specError(name, 'handler is not a function');
  }

  const annotations: Partial<ToolAnnotations> = spec.annotations ?? {};
  for (const key of ANNOTATION_KEYS) {
    if (typeof annotations[key] !== 'boolean') {
      throw specError(
        name,
        `annotations.${key} is missing — all four MCP hints are mandatory, ` +
          'because an absent hint defaults to the permissive reading in clients',
      );
    }
  }
  if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
    throw specError(name, 'a read-only tool cannot also be destructive');
  }

  const isWrite = annotations.readOnlyHint === false;
  const { writeTier } = spec;
  if (isWrite && writeTier === undefined) {
    throw specError(name, 'a tool that is not readOnlyHint must declare a writeTier');
  }
  if (!isWrite && writeTier !== undefined) {
    throw specError(name, 'a readOnlyHint tool must not declare a writeTier');
  }
  if (writeTier !== undefined && !WRITE_TIERS.includes(writeTier)) {
    throw specError(
      name,
      `writeTier "${String(writeTier)}" is not one of ${WRITE_TIERS.join(', ')}`,
    );
  }

  const input: z.ZodTypeAny = spec.input;
  if (!rejectsUnknownKeys(input)) {
    throw specError(
      name,
      'the input schema accepts unknown keys — build it with toolInput()/' +
        'writeToolInput(), which seal the object with .strict()',
    );
  }
  if (!declaresKey(input, 'profile', CONTROL_PROBE.profile)) {
    throw specError(
      name,
      'the input schema does not declare the auto-injected control field ' +
        '"profile" — build it with toolInput()/writeToolInput()',
    );
  }
  for (const key of WRITE_CONTROL_FIELD_NAMES) {
    const declared = declaresKey(input, key, CONTROL_PROBE[key]);
    if (isWrite && !declared) {
      throw specError(
        name,
        `the input schema of a write tool must declare the control field "${key}" ` +
          '— build it with writeToolInput()',
      );
    }
    if (!isWrite && declared) {
      throw specError(
        name,
        `the input schema declares the write-only control field "${key}" on a ` +
          'read-only tool — build it with toolInput()',
      );
    }
  }

  Object.freeze(spec.annotations);
  return Object.freeze(spec);
}
