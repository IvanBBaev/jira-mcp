// ---------------------------------------------------------------------------
// The plan/apply write gate (THREAT-MODEL.md §Write safety — the normative gate
// contract, TOOLS.md §Plan-mode contract, D14, CC-20, CC-32).
//
// The gate is the one place that decides whether a write leaves the process. It
// works by SUBSTITUTING the `jira` seam a write tool is handed rather than by
// asking the tool to behave: in plan mode the tool runs normally, its reads go
// to Jira (a plan needs transitions, create-meta and field ids to be truthful),
// and the first request that would MUTATE is captured and refused. That is why
// tools contain no plan-mode branch at all, and why "nothing hit the wire" is a
// property of the seam instead of a discipline every tool author must keep.
//
// SINGLE-USE IDS. A plan returns a `plan_id` minted from the injected Rng and
// bound to (tool, profile, normalized arguments). Applying consumes it — on a
// match, on a mismatch, on a stale id, always — so a plan can authorize exactly
// one write and an argument that drifted between plan and apply surfaces as
// `write_gated` rather than as a surprise mutation (CC-32). The store is a plain
// Map: the ids die with the process, deliberately, because a plan that outlives
// the session it was reviewed in is no longer a reviewed plan.
//
// TOOLS.md also specifies "a stable hash of tool name + normalized arguments"
// for the id itself. D14 and the WP brief supersede that: a hash is reproducible
// without ever having seen a plan, which defeats single-use. The hash survives
// here as the BINDING (`planFingerprint`), not as the id.
//
// TIERS (D45). `writeTier: 'standard'` is everything above. `'irreversible'`
// adds exactly two things and changes nothing else: an APPLY additionally needs
// the operator opt-in `JIRA_ALLOW_IRREVERSIBLE`, and a PLAN additionally carries
// a `before` snapshot of what is about to be destroyed. Planning is always
// allowed — a plan is a read plus a description — so a model can always find out
// what a delete would cost before anyone decides to allow it.
//
// Layering: `core ← api ← mcp ← tools`. No zod, no SDK.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import type {
  JiraMultipartFile,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  QueryParams,
  QueryValue,
  Rng,
  WriteMode,
} from '../core/types.js';
import { CONTROL_FIELD_NAMES } from './define.js';
import { errorResultOf } from './errors.js';
import { ok } from './result.js';
import type {
  AnyToolSpec,
  ControlFields,
  PlanPayload,
  PlannedRequest,
  ToolResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Normative texts
// ---------------------------------------------------------------------------

/**
 * First line of a plan's text rendering (TOOLS.md §Plan-mode contract).
 *
 * `renderResult` mirrors the envelope as JSON and has no banner hook, so the
 * line is prepended by the call boundary in `mcp/registry.ts` — the same shape
 * the D15 taint banner already uses, and the JSON stays parseable after the
 * first line is dropped.
 */
export const PLAN_NOTICE_LINE = 'NOT performed — plan mode.';

/** Remediation shared by every `write_gated` refusal this module produces. */
export const REPLAN_REMEDIATION =
  'Re-run the tool WITHOUT apply to obtain a fresh plan_id, then repeat the call ' +
  'with identical arguments plus apply: true and that plan_id.';

/** The environment variable that unlocks the irreversible tier (D45). */
export const IRREVERSIBLE_ENV_VAR = 'JIRA_ALLOW_IRREVERSIBLE';

/**
 * Remediation for the one refusal a re-plan cannot fix: the operator has to
 * enable the tier first, so the text names the variable instead of the ritual.
 */
export const IRREVERSIBLE_REMEDIATION =
  `Restart the server with ${IRREVERSIBLE_ENV_VAR}=true (in addition to ` +
  'JIRA_WRITE_MODE=apply), then repeat plan then apply. Planning keeps working ' +
  'without it: re-run without apply to see what would be destroyed.';

/** The `plan` hint's message: the exact re-invocation, per TOOLS.md. */
export function planHintMessage(
  toolName: string,
  planId: string,
  ignoredApply: boolean,
  applyDisabled = false,
): string {
  const base =
    `${PLAN_NOTICE_LINE} Nothing was sent to Jira. Review \`data.planned\`, then ` +
    `re-invoke \`${toolName}\` with the IDENTICAL arguments plus \`apply: true\` and ` +
    `\`plan_id: "${planId}"\`. The id is single-use and dies with this server process.`;
  const withMode = ignoredApply
    ? `${base} \`apply: true\` was ignored because the server runs with ` +
      'JIRA_WRITE_MODE=plan.'
    : base;
  // The irreversible warning rides inside the `plan` hint: HINT_CODES is a
  // closed vocabulary (TOOLS.md), so a new code would be a spec change first.
  return applyDisabled
    ? `${withMode} This tool is IRREVERSIBLE and this server was started without ` +
        `${IRREVERSIBLE_ENV_VAR}=true, so that apply will be refused until an ` +
        'operator enables it. `data.before` is what the call would destroy.'
    : withMode;
}

// ---------------------------------------------------------------------------
// Control fields
// ---------------------------------------------------------------------------

/** Arguments as a handler sees them: the caller's shape minus the control fields. */
export interface SplitArgs {
  readonly control: ControlFields;
  /** Everything that is not a control field; this is what reaches the handler. */
  readonly rest: Record<string, unknown>;
}

/**
 * Split `apply` / `plan_id` / `profile` off the validated arguments.
 *
 * `define.ts` injects them into every tool's schema and promises the handler
 * never sees them, so the split happens exactly once, here, before the gate
 * decides anything — a tool that redefined one of the names would find its own
 * field removed, which is the documented trade of making them a law.
 */
export function splitControlFields(args: unknown): SplitArgs {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { control: {}, rest: {} };
  }
  const source = args as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  const control: {
    apply?: boolean;
    plan_id?: string;
    profile?: string;
  } = {};

  for (const [key, value] of Object.entries(source)) {
    if (!(CONTROL_FIELD_NAMES as readonly string[]).includes(key)) {
      rest[key] = value;
      continue;
    }
    if (key === 'apply' && typeof value === 'boolean') control.apply = value;
    if (key === 'plan_id' && typeof value === 'string') control.plan_id = value;
    if (key === 'profile' && typeof value === 'string') control.profile = value;
  }
  return { control, rest };
}

// ---------------------------------------------------------------------------
// Plan ids and the binding fingerprint
// ---------------------------------------------------------------------------

/** Shape of every id this module mints; asserted by the tests and by `consume`. */
export const PLAN_ID_PATTERN = /^plan_[0-9a-f]{24}$/;

/** How many outstanding plans one process keeps before evicting the oldest. */
export const MAX_OUTSTANDING_PLANS = 64;

/**
 * Mint a plan id from the injected Rng — never `Math.random`, so a test can
 * assert the exact id a call returns. Four 24-bit draws; this is a handle, not
 * a capability token (the store is in-process and unreachable from the wire).
 */
export function newPlanId(rng: Rng): string {
  let hex = '';
  for (let draw = 0; draw < 4; draw += 1) {
    const raw = rng();
    const unit = Number.isFinite(raw)
      ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON)
      : 0;
    hex += Math.floor(unit * 0x100_0000)
      .toString(16)
      .padStart(6, '0');
  }
  return `plan_${hex}`;
}

/** Key order is normalized so `{a,b}` and `{b,a}` are the same request. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}

/**
 * What a `plan_id` is bound to: the tool, the target tenant and the normalized
 * arguments. Hashed rather than stored so an outstanding plan holds no issue
 * text in memory, and compared as hex so drift is a single `!==`.
 */
export function planFingerprint(
  toolName: string,
  args: unknown,
  profile: string | undefined,
): string {
  const canonical =
    JSON.stringify({
      tool: toolName,
      profile: profile ?? null,
      args: canonicalize(args),
    }) ?? 'null';
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// The plan store
// ---------------------------------------------------------------------------

/** What an outstanding plan authorizes. */
export interface PlanBinding {
  readonly tool: string;
  readonly fingerprint: string;
}

/** Outcome of an apply's id check; `ok` is the only one that lets a write run. */
export type PlanConsumeOutcome = 'ok' | 'unknown' | 'mismatch';

/**
 * In-memory, single-use plan ids (D14). No TTL: the lifetime IS the process, and
 * a sweep timer would need a real clock the fake clock cannot drive.
 */
export interface PlanStore {
  /** Register a binding and return its id. */
  issue(binding: PlanBinding): string;
  /** Check and consume `planId`; the id is spent whatever the answer is. */
  consume(planId: string, binding: PlanBinding): PlanConsumeOutcome;
  /** Outstanding plans — a leak check for the tests. */
  readonly size: number;
}

export function createPlanStore(
  rng: Rng,
  maxOutstanding: number = MAX_OUTSTANDING_PLANS,
): PlanStore {
  const plans = new Map<string, PlanBinding>();

  return {
    get size(): number {
      return plans.size;
    },

    issue(binding: PlanBinding): string {
      // Bounded memory: the oldest unapplied plan loses. Map iterates in
      // insertion order, so "oldest" needs no timestamp and therefore no clock.
      while (plans.size >= Math.max(1, maxOutstanding)) {
        const oldest = plans.keys().next();
        if (oldest.done === true) break;
        plans.delete(oldest.value);
      }

      let id = newPlanId(rng);
      for (let attempt = 0; plans.has(id) && attempt < 8; attempt += 1) {
        id = newPlanId(rng);
      }
      // A deterministic (test) rng can repeat forever; the newer plan wins so an
      // id never authorizes two different requests.
      plans.delete(id);
      plans.set(id, binding);
      return id;
    },

    consume(planId: string, binding: PlanBinding): PlanConsumeOutcome {
      const found = plans.get(planId);
      if (found === undefined) return 'unknown';
      // Single-use is unconditional: a mismatched apply burns the id too, so a
      // caller cannot probe arguments against a live plan.
      plans.delete(planId);
      if (found.tool !== binding.tool) return 'mismatch';
      return found.fingerprint === binding.fingerprint ? 'ok' : 'mismatch';
    },
  };
}

// ---------------------------------------------------------------------------
// The capturing request seam (CC-20)
// ---------------------------------------------------------------------------

/** Thrown by the capturing seam to unwind the handler; never leaves this module. */
class PlanCaptured extends Error {
  constructor() {
    super('plan captured');
    this.name = 'PlanCaptured';
  }
}

/** GET is a read; so is anything `core/http.ts` may safely replay (`safe: true`). */
function isReadRequest(req: JiraRequestSpec): boolean {
  return req.method === 'GET' || req.safe === true;
}

/** What a handler noted about the entity it is about to destroy. */
interface BeforeSlot {
  noted: boolean;
  value: unknown;
}

/**
 * The before-state channel, keyed by the seam a handler was handed.
 *
 * Only the handler knows how to read the entity it is about to delete, and only
 * the gate builds the plan envelope — but the gate DISCARDS the handler's result
 * once a request was captured (the handler never returns; it unwinds through
 * `PlanCaptured`), so the snapshot cannot travel back as a return value. It
 * travels through the seam instead: the gate registers a slot for the capturing
 * seam it just built, and `noteBeforeState(ctx.jira, …)` fills that slot.
 *
 * Why a WeakMap keyed by the seam rather than a field on `ToolCtx`:
 *   - `ToolCtx` is the frozen tool contract; a delete-only field would leak an
 *     irreversible-tier concern into every read tool's signature.
 *   - the seam is already per-call and already the thing plan mode substitutes,
 *     so identity is exactly the right key: two concurrent calls hold two seams.
 *   - in apply mode the handler is handed the REAL seam, which was never
 *     registered, so the same unconditional `noteBeforeState` call is a silent
 *     no-op — the tool needs no plan-mode branch, which is the whole point of
 *     this module.
 * Entries die with the seam; nothing is ever removed by hand.
 */
const beforeSlots = new WeakMap<JiraRequestFn, BeforeSlot>();

/**
 * Record what the current call is about to destroy, for the plan envelope.
 *
 * Call it with `ctx.jira` before issuing the mutation. Outside plan mode it does
 * nothing. The FIRST note wins, mirroring the first-mutation rule below.
 */
export function noteBeforeState(jira: JiraRequestFn, before: unknown): void {
  const slot = beforeSlots.get(jira);
  if (slot === undefined || slot.noted) return;
  slot.noted = true;
  slot.value = before;
}

/**
 * What a plan SHOWS about one multipart part: the metadata, never the payload.
 *
 * `bytes` is the part's SIZE, not its contents — the plan envelope is an
 * approval surface rendered back to the model, and a file the user asked to
 * upload has no business being echoed into it.
 */
export interface PlannedMultipartPart {
  readonly field: string;
  readonly filename: string;
  readonly contentType?: string;
  /** Byte length of the part. */
  readonly bytes: number;
}

/**
 * A captured request, plus the multipart summary `PlannedRequest` has no room
 * for. Uploads (`POST /issue/{key}/attachments`) carry their whole meaning in
 * `multipart` and set no `body`, so a plan built from method/path/query/body
 * alone would describe them as a bare path — nothing to approve (CC-86).
 */
interface PlannedUpload extends PlannedRequest {
  readonly multipart?: readonly PlannedMultipartPart[];
}

interface PlanCapture {
  readonly jira: JiraRequestFn;
  readonly planned: PlannedUpload | undefined;
  /** Filled by `noteBeforeState` while the handler runs. */
  readonly before: BeforeSlot;
}

/**
 * The query a plan should SHOW: what the URL would actually carry.
 *
 * `undefined` values are dropped because `buildQueryString` drops them, and an
 * object that ends up empty becomes no `query` key at all — the plan must not
 * imply a `?` the apply would never send. Only string values pass through the
 * redactor: numbers and booleans cannot hide a secret, and coercing them would
 * turn `deleteSubtasks: true` into `"true"` in the model's eyes.
 */
function plannedQuery(
  query: QueryParams | undefined,
  redact: ((value: unknown) => unknown) | undefined,
): QueryParams | undefined {
  if (query === undefined) return undefined;
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    out[key] =
      typeof value === 'string' && redact !== undefined ? String(redact(value)) : value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * The multipart a plan should SHOW: which file, of what type, how big.
 *
 * The filename goes through the redactor because it is user-supplied text like
 * any other; `bytes` is reduced to a length so the payload cannot ride into the
 * envelope. An empty list becomes no `multipart` key at all.
 */
function plannedMultipart(
  parts: readonly JiraMultipartFile[] | undefined,
  redact: ((value: unknown) => unknown) | undefined,
): readonly PlannedMultipartPart[] | undefined {
  if (parts === undefined || parts.length === 0) return undefined;
  return parts.map((part) => ({
    field: part.field,
    filename: redact === undefined ? part.filename : String(redact(part.filename)),
    ...(part.contentType === undefined ? {} : { contentType: part.contentType }),
    bytes: part.bytes.byteLength,
  }));
}

function createPlanCapture(
  inner: JiraRequestFn,
  redact: ((value: unknown) => unknown) | undefined,
): PlanCapture {
  let planned: PlannedUpload | undefined;
  const before: BeforeSlot = { noted: false, value: undefined };

  const jira: JiraRequestFn = <T = unknown>(
    req: JiraRequestSpec,
  ): Promise<JiraResponse<T>> => {
    if (isReadRequest(req)) return inner<T>(req);
    // Keep the FIRST mutation: a handler that swallowed the unwind and tried a
    // second write must not be able to rewrite the plan the model approved.
    if (planned === undefined) {
      const query = plannedQuery(req.query, redact);
      const multipart = plannedMultipart(req.multipart, redact);
      planned = {
        method: req.method,
        path: req.path,
        ...(query === undefined ? {} : { query }),
        ...(multipart === undefined ? {} : { multipart }),
        ...(req.body === undefined
          ? {}
          : { body: redact === undefined ? req.body : redact(req.body) }),
      };
    }
    // Rejected rather than thrown synchronously so a handler that never awaits
    // still sees a rejection instead of a torn call stack.
    return Promise.reject(new PlanCaptured());
  };

  beforeSlots.set(jira, before);

  return {
    jira,
    before,
    get planned(): PlannedUpload | undefined {
      return planned;
    },
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface WriteGateDeps {
  /** `JIRA_WRITE_MODE`. `plan` (default) never executes a write. */
  readonly writeMode: WriteMode;
  /**
   * `JIRA_ALLOW_IRREVERSIBLE`. Required, not optional: forgetting it at a
   * construction site would silently arm the deletes, so the compiler asks.
   */
  readonly allowIrreversible: boolean;
  /** Source of plan ids; the same seam correlation ids use. */
  readonly rng: Rng;
  /** Redaction choke point applied to a captured body (`PlannedRequest.body`). */
  readonly redact?: ((value: unknown) => unknown) | undefined;
  /** Injectable for tests; one store per gate otherwise. */
  readonly store?: PlanStore | undefined;
}

export interface WriteGateCall {
  readonly tool: AnyToolSpec;
  /** Arguments the handler will see — control fields already stripped. */
  readonly args: Record<string, unknown>;
  readonly control: ControlFields;
  /** The real request function; reads use it even in plan mode. */
  readonly jira: JiraRequestFn;
  /** Run the handler against whichever seam the gate chooses. */
  invoke(jira: JiraRequestFn): Promise<ToolResult<unknown>>;
}

export interface WriteGate {
  /** Run one tool call under the gate. Reads pass straight through. */
  execute(call: WriteGateCall): Promise<ToolResult<unknown>>;
  /** Outstanding plan ids; diagnostics and tests only. */
  readonly outstandingPlans: number;
}

/** Every reason the gate refuses an apply. `ok` is not one of them. */
export type GateRefusal = 'missing' | 'irreversible' | PlanConsumeOutcome;

function refusal(reason: GateRefusal): string {
  switch (reason) {
    case 'missing':
      return (
        'This write needs a plan_id: `apply: true` alone never executes. Nothing was ' +
        'sent to Jira.'
      );
    case 'irreversible':
      return (
        'This tool is in the irreversible tier: it destroys data that Jira cannot ' +
        `give back, and this server was started without ${IRREVERSIBLE_ENV_VAR}=true. ` +
        'The plan_id was NOT consumed. Nothing was sent to Jira.'
      );
    case 'unknown':
      return (
        'That plan_id is unknown, already used, or was issued by an earlier server ' +
        'process. Plans are single-use and in-memory. Nothing was sent to Jira.'
      );
    default:
      return (
        'The arguments changed between the plan and this apply, so the plan_id no ' +
        'longer describes this request. Nothing was sent to Jira.'
      );
  }
}

/** A `write_gated` envelope: the refusal path never reaches the network. */
export function writeGatedResult(reason: GateRefusal): ToolResult<never> {
  return errorResultOf('write_gated', refusal(reason), {
    retryable: false,
    // Re-planning cannot fix a server that is not allowed to delete; that one
    // refusal points at the operator instead.
    remediation:
      reason === 'irreversible' ? IRREVERSIBLE_REMEDIATION : REPLAN_REMEDIATION,
  });
}

/** True when `result` is a plan envelope — the registry's banner condition. */
export function isPlanResult(result: ToolResult<unknown>): boolean {
  return result.ok && (result.hints ?? []).some((hint) => hint.code === 'plan');
}

/**
 * The plan of an irreversible call: `PlanPayload` plus what is about to be lost.
 *
 * Declared here rather than in `mcp/types.ts` because the extra key is produced
 * by exactly one gate branch and consumed by the reader of that envelope; the
 * contract file keeps describing the shape EVERY plan has. A tool's apply result
 * echoes the same snapshot under the same key, so plan and receipt read alike.
 */
export interface IrreversiblePlanPayload extends PlanPayload {
  readonly before: unknown;
}

export function createWriteGate(deps: WriteGateDeps): WriteGate {
  const store = deps.store ?? createPlanStore(deps.rng);

  const plan = async (call: WriteGateCall): Promise<ToolResult<unknown>> => {
    const capture = createPlanCapture(call.jira, deps.redact);
    let handlerResult: ToolResult<unknown> | undefined;
    try {
      handlerResult = await call.invoke(capture.jira);
    } catch (error) {
      if (!(error instanceof PlanCaptured)) throw error;
    }

    const planned = capture.planned;
    if (planned === undefined) {
      // The handler refused before reaching its write (a local validation error,
      // an empty diff). Its own envelope is the truthful answer.
      return handlerResult ?? writeGatedResult('missing');
    }

    const planId = store.issue({
      tool: call.tool.name,
      fingerprint: planFingerprint(call.tool.name, call.args, call.control.profile),
    });
    const base: PlanPayload = { executed: false, planned, plan_id: planId };
    const noted = capture.before.noted;
    const payload: PlanPayload | IrreversiblePlanPayload = noted
      ? {
          ...base,
          before:
            deps.redact === undefined
              ? capture.before.value
              : deps.redact(capture.before.value),
        }
      : base;

    return ok(payload, {
      hints: [
        {
          code: 'plan',
          message: planHintMessage(
            call.tool.name,
            planId,
            deps.writeMode === 'plan' && call.control.apply === true,
            call.tool.writeTier === 'irreversible' && !deps.allowIrreversible,
          ),
        },
      ],
      // A before-state is tenant-authored prose (summaries, comment bodies), so
      // the plan envelope carries the D15 brand its tool would have carried.
      ...(noted ? { untrusted: true } : {}),
    });
  };

  return {
    get outstandingPlans(): number {
      return store.size;
    },

    async execute(call: WriteGateCall): Promise<ToolResult<unknown>> {
      // Reads are never gated, including the reads a plan is built from.
      if (call.tool.writeTier === undefined) return call.invoke(call.jira);

      const wantsApply = call.control.apply === true;
      if (deps.writeMode !== 'apply' || !wantsApply) return plan(call);

      // Checked BEFORE the plan_id is consumed: this refusal is the operator's
      // to fix, so it must not also burn the plan the caller will re-apply once
      // the tier is enabled. Standard-tier calls never see this branch.
      if (call.tool.writeTier === 'irreversible' && !deps.allowIrreversible) {
        return writeGatedResult('irreversible');
      }

      const planId = call.control.plan_id;
      if (planId === undefined || planId === '') return writeGatedResult('missing');

      const outcome = store.consume(planId, {
        tool: call.tool.name,
        fingerprint: planFingerprint(call.tool.name, call.args, call.control.profile),
      });
      if (outcome !== 'ok') return writeGatedResult(outcome);

      return call.invoke(call.jira);
    },
  };
}
