// ---------------------------------------------------------------------------
// The plumbing every tool package repeats — hoisted so there is ONE of each
// (WP-42). Wave 3 wrote the seven packages in parallel, and each grew its own
// private copy of the same four things: the catch site every handler body runs
// inside, the projection of `ToolCtx` onto the option shape the api ring takes,
// the annotation quadruples of TOOLS.md §Annotations reference, and the paging
// surface of TOOLS.md §Read shaping (D27).
//
// Nothing here is Jira-specific: no endpoint, no field name, no hint prose.
// Prose that differs per package — the `fields_defaulted` wording, the `clamped`
// caps, the per-package `PARTIAL_NOTES` — stays in the package that owns it,
// because unifying wording is a documentation decision, not a refactor. What is
// shared is the SHAPE.
//
// Layering: `core ← api ← mcp ← tools`. This file sits in `mcp` and imports from
// `mcp` and `core` only — in particular it never names `PageStopReason`, which
// lives in the api ring: {@link PagingInfo} is generic over the stop-reason
// union so the api ring stays the single source of truth for it.
// ---------------------------------------------------------------------------

import type { Clock, JiraError, JiraRequestFn } from '../core/types.js';
import { errorResult, isJiraError } from './errors.js';
import type { Hint, ToolAnnotations, ToolCtx, ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// 1. Failure containment
// ---------------------------------------------------------------------------

/** Extra hints to attach to a failed call, decided from the error itself. */
export type ErrorHints = (error: JiraError) => readonly Hint[];

/**
 * The catch site every handler body runs inside — and it is very deliberate
 * about WHAT it catches.
 *
 * Only a `JiraError` becomes an envelope: `errorResult` does the whole
 * projection, so the error reaches the model with the kind, the Jira messages
 * and the remediation the layer that saw the response wrote (CC-16).
 *
 * Anything else is RE-THROWN. Plan mode signals "the write was captured, unwind
 * the handler" by rejecting with `PlanCaptured`, a plain `Error`
 * (`mcp/write-mode.ts`); a handler that swallowed it would report every plan as
 * a failed write. The write gate does re-check its capture afterwards, so a
 * swallow is survivable there — but only there, and a read package that
 * swallows an internal bug turns it into a Jira-looking failure the model will
 * try to work around. `mcp/registry.ts` has the catch-all that keeps the
 * promise `ToolHandler` makes: a throw that escapes here still reaches the
 * model as an `unexpected_shape` envelope, with the diagnosis on
 * `tool_call_end` under the call's cid.
 *
 * The hints are computed from the error rather than from the call site: CC-24's
 * "unknown field" and CC-21's "stale id" are both 400s, and only the error says
 * which discovery tool would have prevented it.
 */
export async function guarded<T>(
  run: () => Promise<ToolResult<T>>,
  onError?: ErrorHints,
): Promise<ToolResult<T>> {
  try {
    return await run();
  } catch (error) {
    rethrowUnexpected(error);
    return errorResult(error, { hints: onError?.(error) });
  }
}

/**
 * The rule {@link guarded} applies, on its own: a `JiraError` is a fact about
 * Jira that the model can act on, anything else is a bug — or plan mode
 * unwinding a captured write — and has to keep travelling.
 *
 * Exported for the one package whose failure envelope is not the default one:
 * `tools/search.ts` rewrites the remediation of a JQL 400 (CC-05) and therefore
 * cannot delegate the projection to {@link guarded}. It still delegates THIS
 * decision, so there is one implementation of it and not two.
 */
export function rethrowUnexpected(error: unknown): asserts error is JiraError {
  if (!isJiraError(error)) throw error;
}

// ---------------------------------------------------------------------------
// 2. The context, projected onto what the api ring takes
// ---------------------------------------------------------------------------

/** The seam and the budget every api call is handed, unchanged. */
export interface CallBase {
  readonly jira: JiraRequestFn;
  readonly signal: AbortSignal | undefined;
  readonly deadlineAt: number;
  readonly clock: Clock;
}

/**
 * Project a `ToolCtx` onto what the api ring asks for. The deadline and the
 * clock travel TOGETHER (`BudgetGuard`): a deadline without a clock cannot be
 * checked, and the api type makes that unrepresentable.
 *
 * A paginated call adds its own `maxPages` on top — the value differs per
 * package (the loop guard for a sweeping read, a hard 1 for a "one page per
 * call" read), so it is not decided here.
 */
export function callBase(ctx: ToolCtx): CallBase {
  return {
    jira: ctx.jira,
    signal: ctx.signal,
    deadlineAt: ctx.deadlineAt,
    clock: ctx.clock,
  };
}

// ---------------------------------------------------------------------------
// 3. The annotation quadruples (TOOLS.md §Annotations reference)
// ---------------------------------------------------------------------------
//
// One constant per row of that table. All four hints are mandatory on every
// tool (`defineTool` refuses a spec that omits one, because an absent hint
// defaults to the permissive reading in clients), which is exactly why they are
// worth naming: a quadruple typed out by hand eleven times is a quadruple that
// will eventually disagree with the documentation.

/** `jira_capabilities` — the ONE tool that touches no external system. */
export const LOCAL_READ_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/** "All other reads": every read tool except `jira_capabilities`. */
export const READ_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

/**
 * The default write: creates a record or appends to one, so running it twice
 * does it twice. Covers create/comment/worklog/link — and transition, which the
 * table footnote pins to `idempotentHint: false` on purpose (it is idempotent
 * only when the target state already equals the current one).
 */
export const WRITE_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

/**
 * A write that sets a value rather than adding one: assign, and the sprint move
 * (moving an issue into the sprint it is already in is a no-op). Nothing is
 * lost, and repeating the call lands on the same state.
 */
export const IDEMPOTENT_WRITE_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

/**
 * `jira_update_issue`, `jira_update_comment` and `jira_close_sprint`. The
 * first two delete no record, but whole-value replace semantics on labels and
 * rich text (CC-31, CC-39) can silently destroy existing content; closing a
 * sprint has no undo in the Agile API. The annotation exists to make clients
 * confirm, and these are the calls worth confirming (D40).
 */
export const DESTRUCTIVE_WRITE_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
});

// ---------------------------------------------------------------------------
// 4. The paging surface (TOOLS.md §Read shaping, D27)
// ---------------------------------------------------------------------------

/**
 * What the caller must know about the classic (`startAt`) loop behind a read:
 * how far it got, and whether Jira still has rows it never read.
 *
 * This is deliberately NOT the `truncated` hint. TOOLS.md defines `truncated` as
 * "the result exceeded JIRA_MAX_RESULT_CHARS" and its message tells the model
 * not to page on; the character-budget ladder in `mcp/result.ts` owns it.
 * Stopping at the page cap is the opposite fact — more rows exist upstream and
 * `nextStartAt` is a valid cursor to fetch them with.
 *
 * Generic over the stop-reason union so this ring never has to name the api
 * ring's `PageStopReason`; every tool package instantiates it with that type.
 */
export interface PagingInfo<Reason extends string = string> {
  /** Pages actually fetched. */
  readonly pages: number;
  readonly stopReason: Reason;
  /** `true` ⇒ Jira has more matching rows than this result contains. */
  readonly partial: boolean;
  /** The server's `total`, when the endpoint reported one. */
  readonly total?: number;
  /** Offset to resume from; present only when `partial`. */
  readonly nextStartAt?: number;
  /** Prose for `partial`, so the fact survives a reader who skips booleans. */
  readonly note?: string;
}

/** The loop metadata {@link pagingOf} reads — the shared half of every loop result. */
export interface LoopMetadata<Reason extends string = string> {
  readonly pages: number;
  readonly stopReason: Reason;
  readonly partial: boolean;
  readonly nextStartAt?: number;
  readonly total?: number;
}

/**
 * Why a partial result is partial, in words, per stop reason. Partial by type:
 * the reason a complete read stopped ("exhausted") has no note, and a package
 * that never meets a stop reason need not invent prose for it.
 *
 * The prose belongs to the package, not to this file — the remedy for a page cap
 * differs between "narrow the filter, or raise JIRA_MAX_PAGES" and "call again
 * with startAt = paging.nextStartAt", and only the tool knows which it is.
 */
export type PartialNotes<Reason extends string = string> = Readonly<
  Partial<Record<Reason, string>>
>;

/**
 * Project a loop result onto {@link PagingInfo}, dropping absent optionals — an
 * omitted key, never `undefined`, so the rendered JSON says nothing it cannot
 * back up.
 */
export function pagingOf<Reason extends string>(
  loop: LoopMetadata<Reason>,
  notes: PartialNotes<NoInfer<Reason>>,
): PagingInfo<Reason> {
  const note = notes[loop.stopReason];
  return {
    pages: loop.pages,
    stopReason: loop.stopReason,
    partial: loop.partial,
    ...(loop.total === undefined ? {} : { total: loop.total }),
    ...(loop.nextStartAt === undefined ? {} : { nextStartAt: loop.nextStartAt }),
    ...(note === undefined ? {} : { note }),
  };
}
