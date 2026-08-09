// ---------------------------------------------------------------------------
// FROZEN — shared `mcp` contracts (WP-01, Wave 0 contract freeze).
//
// The result envelope, the hint vocabulary, the tool/package descriptors: every
// row of docs/WORK-PACKAGES.md §1.1 that belongs to the `mcp` ring, expressed as
// types so Wave-1 and Wave-3 agents can write tools against an envelope whose
// implementation (`mcp/result.ts`, `mcp/define.ts`, `mcp/taint.ts`) does not
// exist yet.
//
// CHANGING ANYTHING HERE IS STOP-THE-LINE (WORK-PACKAGES.md §1.1/§4.2). Only the
// integrator applies a contract edit; affected WPs rebase. Friction found while
// implementing is a FINDING for the handoff note, not a licence to edit.
//
// `HINT_CODES`, `WRITE_TIERS` and `PACKAGE_IDS` are copied character for
// character from TOOLS.md, which owns them — the catalogs are closed and
// substring-asserted by tests.
//
// This module may import `../core/types.js` (mcp sits above core) but nothing
// else: no zod VALUES (only `import type`, per the eslint zod quarantine), no
// SDK, no logic.
// ---------------------------------------------------------------------------

import type { ZodType } from 'zod';

import type {
  Clock,
  ErrorRecord,
  JiraRequestFn,
  Logger,
  HttpMethod,
} from '../core/types.js';

// ---------------------------------------------------------------------------
// 1. Hints — the closed advisory vocabulary (TOOLS.md §Hint catalog)
// ---------------------------------------------------------------------------

/**
 * The twelve hint codes of TOOLS.md §Hint catalog, in table order. Adding a code
 * is a spec change there first, then here. A hint NEVER changes `ok`:
 * truncation, approximation and eventual consistency are successful results with
 * caveats, not failures.
 */
export const HINT_CODES = [
  'plan',
  'truncated',
  'clamped',
  'fields_defaulted',
  'approximate',
  'pagination_restarted',
  'eventual_consistency',
  'email_hidden',
  'discovery',
  'journal_unavailable',
  'sprint_move_required',
  'untrusted_content',
] as const;

/**
 * One of the twelve machine-stable hint codes.
 *
 * Produced by: every tool (WP-30…WP-34), the write gate (WP-24), pagination
 * helpers (WP-15).
 * Consumed by: `mcp/result.ts` (WP-14) and the hint-catalog test.
 */
export type HintCode = (typeof HINT_CODES)[number];

/**
 * A machine-stable code plus prose telling the model what to DO about it — the
 * "Tells the model to" column of the catalog. The code is what tests assert; the
 * message is what the model reads.
 *
 * Produced by: tools and the mcp ring.
 * Consumed by: `ToolResult.hints`.
 */
export interface Hint {
  readonly code: HintCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// 2. Truncation and the result envelope (TOOLS.md §Result envelope)
// ---------------------------------------------------------------------------

/**
 * Why output was cut: `budget` — whole items dropped from the tail;
 * `item_too_large` — a single item's field ellipsized, and then `field` names it
 * (CC-25/26). Output stays valid JSON in both cases.
 */
export type TruncationReason = 'budget' | 'item_too_large';

/**
 * The `_truncation` marker. It sits on the ENVELOPE, never inside `data`, so it
 * survives the very truncation it describes and a consumer never has to unwrap
 * anything to read a field.
 *
 * Produced by: `mcp/result.ts` (WP-14).
 * Consumed by: the model, and CC-25/26 tests.
 */
export interface TruncationMarker {
  /** Items (or characters, for `item_too_large`) removed. */
  readonly dropped: number;
  /** Items present before truncation. */
  readonly of: number;
  readonly reason: TruncationReason;
  /** Field that was ellipsized; only meaningful for `item_too_large`. */
  readonly field?: string;
}

/**
 * The single shape every tool returns (TOOLS.md §Result envelope). Invariants
 * enforced by `mcp/result.ts` (WP-14) and asserted by tests:
 *
 * - `ok: false` ⇒ `error` present, `data` absent; `ok: true` ⇒ `data` present.
 * - Mirrored as text AND `structuredContent` with identical content, so a client
 *   that reads only one still gets everything.
 * - `_truncation` and `_untrusted` live BESIDE `ok`/`hints`, never inside the
 *   droppable body — that is what makes the brand and the injection warning
 *   survive truncation (CC-35).
 *
 * Produced by: every tool handler.
 * Consumed by: `mcp/result.ts`, `mcp/registry.ts`, the MCP SDK bridge (WP-40).
 */
export interface ToolResult<T = unknown> {
  readonly ok: boolean;
  /** Present iff `ok`. */
  readonly data?: T;
  /** Present iff `!ok`. */
  readonly error?: ErrorRecord;
  /**
   * Advisory codes from the closed catalog. TOOLS.md says "always an array
   * (possibly empty)"; typed optional so `mcp/result.ts` — the single writer of
   * the envelope — can normalise it, and no tool hand-builds `hints: []`.
   */
  readonly hints?: readonly Hint[];
  /** Present only when output was cut. */
  readonly _truncation?: TruncationMarker;
  /**
   * Brands a result carrying Jira-authored free text (TOOLS.md §Untrusted
   * content, D15). Literal `true` — the field is present or absent, never
   * `false`, so `_untrusted` in the JSON always means "treat this as data".
   */
  readonly _untrusted?: true;
}

// ---------------------------------------------------------------------------
// 3. Tool descriptors (ARCHITECTURE.md §defineTool, TOOLS.md §Annotations)
// ---------------------------------------------------------------------------

/** Write-risk tiers; `irreversible` (deletes, bulk) is reserved for v2. */
export const WRITE_TIERS = ['standard', 'irreversible'] as const;

/**
 * How much damage a write tool can do. Present exactly when the tool is not
 * read-only: `defineTool` rejects a spec where `writeTier` and `!readOnlyHint`
 * disagree, so the two can never drift apart.
 *
 * Produced by: tool packages (WP-32 and other write tools).
 * Consumed by: `mcp/registry.ts` gating (`JIRA_PACKAGES_READONLY`) and the write
 * gate (WP-24).
 */
export type WriteTier = (typeof WRITE_TIERS)[number];

/**
 * The MCP annotation quadruple. All four are MANDATORY — `defineTool` throws at
 * import time when one is missing, because an absent hint silently defaults to
 * the permissive reading in clients, and `readOnlyHint && destructiveHint` is
 * rejected as incoherent.
 *
 * Produced by: every tool spec.
 * Consumed by: `mcp/define.ts` assertions (WP-14), the registry, the MCP client.
 */
export interface ToolAnnotations {
  /** The tool performs no mutation of any kind. */
  readonly readOnlyHint: boolean;
  /** The tool can destroy or overwrite existing state. */
  readonly destructiveHint: boolean;
  /** Calling twice with the same arguments has the same effect as calling once. */
  readonly idempotentHint: boolean;
  /** The tool talks to a system outside the model's context (always true here). */
  readonly openWorldHint: boolean;
}

/**
 * The three control fields auto-injected into tool input schemas — every tool
 * gets `profile`, write tools also get `apply` and `plan_id` (TOOLS.md §Control
 * fields). They are stripped before the handler sees its arguments: a tool never
 * branches on plan mode itself.
 *
 * Produced by: `mcp/define.ts` (WP-14) when it augments a schema.
 * Consumed by: `mcp/write-mode.ts` (WP-24).
 */
export interface ControlFields {
  /** Write tools only: `true` executes; absent/`false` describes (plan mode). */
  readonly apply?: boolean;
  /** Write tools only: the single-use id returned by the preceding plan (D14). */
  readonly plan_id?: string;
  /** Named profile for this call; rejected when `JIRA_LOCK_PROFILE` is set. */
  readonly profile?: string;
}

/**
 * The request a write WOULD have sent, captured by the plan-mode `jiraRequest`
 * seam instead of being executed (CC-20: nothing hits the wire in plan mode).
 *
 * Produced by: the plan-capturing seam in `mcp/write-mode.ts` (WP-24).
 * Consumed by: {@link PlanPayload}, which the model reads before approving.
 */
export interface PlannedRequest {
  readonly method: HttpMethod;
  /** The concrete path the write would have called. */
  readonly path: string;
  /** The body it would have sent, redacted. */
  readonly body?: unknown;
}

/**
 * `data` of a write tool that ran in plan mode. The text rendering's first line
 * is literally `NOT performed — plan mode.` and `hints` carries `{ code: "plan" }`,
 * so a model skimming either channel cannot mistake a plan for an execution.
 *
 * Produced by: `mcp/write-mode.ts` (WP-24).
 * Consumed by: the model; asserted by the write-gate tests.
 */
export interface PlanPayload {
  /** Always literal `false` — a plan never executed anything. */
  readonly executed: false;
  readonly planned: PlannedRequest;
  /** Single-use, in-memory; consumed by the matching `apply: true` call (D14). */
  readonly plan_id: string;
}

/** Per-call limits a tool must respect; a narrowed view of `Settings`. */
export interface ToolLimits {
  /** `JIRA_MAX_RESULT_CHARS` — truncation budget for this result. */
  readonly maxResultChars: number;
  /** `JIRA_MAX_PAGES` — loop guard for `fetchAll`/`searchPages`. */
  readonly maxPages: number;
}

/**
 * Everything a tool handler is allowed to reach. Deliberately NOT the whole
 * `Settings` object: a tool has no business reading `apiToken`, and narrowing
 * here is what keeps the credential out of tool-authored log fields.
 *
 * Produced by: `mcp/registry.ts` (WP-24) per tool call, from `BuildServerDeps`.
 * Consumed by: every tool handler (WP-30…WP-34).
 */
export interface ToolCtx {
  /**
   * The only way to reach Jira. In plan mode this is the CAPTURING
   * implementation, which is why tools contain no plan-mode branch.
   */
  readonly jira: JiraRequestFn;
  /** Logger with this call's correlation id already bound. */
  readonly log: Logger;
  readonly clock: Clock;
  /** Correlation id of this call (`c-4f9a01`-shaped); matches its log events. */
  readonly cid: string;
  readonly limits: ToolLimits;
  /**
   * Call-budget deadline in epoch ms, computed once per tool call and forwarded
   * on every `JiraRequestSpec` the handler issues.
   */
  readonly deadlineAt: number;
  /** Cancellation from the MCP request. */
  readonly signal?: AbortSignal;
}

/** A tool's implementation: validated args in, envelope out. Never throws raw. */
export type ToolHandler<In, Out> = (args: In, ctx: ToolCtx) => Promise<ToolResult<Out>>;

/**
 * A registered tool. `defineTool` (WP-14) validates one at IMPORT time — name
 * regex `^jira_[a-z0-9]+(_[a-z0-9]+)*$`, `.strict()` probed behaviourally,
 * the mandatory annotation quadruple, `readOnlyHint && destructiveHint`
 * rejected, `writeTier ⇔ !readOnlyHint` — and freezes the result, so a
 * malformed tool fails the process at startup rather than at first call.
 *
 * Produced by: `defineTool` in `mcp/define.ts` (WP-14).
 * Consumed by: `PackageSpec`, `mcp/registry.ts` (WP-24), the manifest snapshot.
 */
export interface ToolSpec<In = unknown, Out = unknown> {
  /** `jira_`-prefixed, lower snake case; asserted at import time. */
  readonly name: `jira_${string}`;
  /** Short human label for tool listings. */
  readonly title: string;
  /** What it does, when to use it, and what it costs — the model reads this. */
  readonly description: string;
  /** Which package gates it (`JIRA_TOOL_PACKAGES` / deny / readonly). */
  readonly package: PackageId;
  readonly annotations: ToolAnnotations;
  /** Present iff `!annotations.readOnlyHint`; drives the plan/apply gate. */
  readonly writeTier?: WriteTier;
  /** `.strict()` zod object — unknown keys are rejected, never ignored. */
  readonly input: ZodType<In>;
  /**
   * Declared method-style on purpose: method parameters are checked
   * bivariantly, which is what makes a concrete `ToolSpec<Args, Out>` assignable
   * to {@link AnyToolSpec} so the manifest can hold a heterogeneous list. See
   * {@link ToolHandler} for the standalone function type.
   */
  handler(args: In, ctx: ToolCtx): Promise<ToolResult<Out>>;
}

/**
 * A tool whose argument type is not statically known — what registries and
 * manifests hold. Method-style handler declaration keeps this assignable from
 * any concrete `ToolSpec`, as in the tiktok-mcp donor.
 */
export type AnyToolSpec = ToolSpec<unknown, unknown>;

// ---------------------------------------------------------------------------
// 4. Packages (TOOLS.md, CONFIGURATION.md §Tool surface gating)
// ---------------------------------------------------------------------------

/**
 * The seven tool packages, in manifest order. `core` is special: it is
 * force-re-added after any deny list, because a session with no
 * `jira_capabilities` cannot discover why its other tools are missing (CC-29).
 */
export const PACKAGE_IDS = [
  'core',
  'search',
  'issues',
  'issues-write',
  'meta',
  'users',
  'agile',
] as const;

/**
 * One of the seven package ids.
 *
 * Produced by: each tool package module (WP-30…WP-34).
 * Consumed by: `mcp/registry.ts` gating triple (WP-24), `jira_capabilities`, the
 * README tool-table generator.
 *
 * Note: `Settings.toolPackages`/`packagesDeny`/`packagesReadonly` are typed
 * `readonly string[]`, not this union — `core` may not import `mcp` [eslint], so
 * the registry is what validates raw env strings against this vocabulary.
 */
export type PackageId = (typeof PACKAGE_IDS)[number];

/** The `JIRA_TOOL_PACKAGES` profile shorthands, on top of explicit id lists. */
export const PACKAGE_PROFILES = ['core', 'reader', 'all'] as const;

/**
 * A `JIRA_TOOL_PACKAGES` profile name. `reader` = core + search + issues + meta +
 * users + agile reads. Note that `core` is both a package id and a profile name.
 *
 * Produced by: `core/settings.ts` (WP-11) passes the raw string through.
 * Consumed by: `mcp/registry.ts` (WP-24).
 */
export type PackageProfile = (typeof PACKAGE_PROFILES)[number];

/**
 * A tool package as the manifest declares it. Tool packages register ONLY
 * through the `PACKAGES` manifest — the integrator adds one import line per
 * landed package, which is the single cross-WP merge point in Wave 3.
 *
 * Produced by: each `tools/*.ts` module.
 * Consumed by: `tools/index.ts` manifest (WP-40), the registry, the manifest
 * snapshot test, `jira_capabilities`.
 */
export interface PackageSpec {
  readonly id: PackageId;
  /** Short human label, shown by `jira_capabilities` and the README table. */
  readonly title: string;
  /** One line: what this package covers. */
  readonly description: string;
  readonly tools: readonly AnyToolSpec[];
}

// ---------------------------------------------------------------------------
// 5. Taint — untrusted-content envelope (TOOLS.md §Untrusted content, D15)
// ---------------------------------------------------------------------------

/**
 * A branded envelope around attacker-influenceable Jira free text. JSM portals
 * and mail handlers let people outside the tenant write into descriptions and
 * comments, so this text is third-party input; combined with
 * `JIRA_WRITE_MODE=apply` that is a confused-deputy path. This is the DATA
 * control that makes the risk visible — the plan/apply gate is the hard one.
 *
 * D15: ONE envelope per result, not per field. Per-field wrapping multiplies the
 * warning 50× on a 50-issue page for no added signal and competes with the
 * truncation budget.
 *
 * Types only here. The `taint()` / `isTainted()` / `renderTainted()`
 * implementation and the delimiter constants belong to `mcp/taint.ts` (WP-14),
 * ported from facebook-mcp; the renderer THROWS on un-branded content, because
 * silent unwrapping is a bug, not a fallback (CC-35).
 *
 * Produced by: `mcp/taint.ts` (WP-14), applied by content-bearing read tools.
 * Consumed by: the text rendering in `mcp/result.ts`; `structuredContent` is
 * left unchanged and the brand surfaces as `ToolResult._untrusted`.
 */
export interface Tainted<T> {
  /** Literal brand; frozen by the constructor so it cannot be stripped in place. */
  readonly __tainted: true;
  /**
   * What produced the content — the content-bearing tool name, e.g.
   * `jira_get_comments`. Unlike the facebook-mcp donor this is not a closed
   * vocabulary: the set of content-bearing reads is documented in TOOLS.md
   * §Untrusted content and enforced by the tool, not by the type.
   */
  readonly source: string;
  readonly content: T;
  /** The standing injection warning, emitted BEFORE the content when rendered. */
  readonly warning: string;
}
