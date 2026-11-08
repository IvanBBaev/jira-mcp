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
// SINGLE-USE IDS. A plan returns a `plan_id` of 128 CSPRNG bits (D511) bound to
// (tool, profile, normalized arguments) and to its OWNER, the session and
// credential that planned it (D512). Applying consumes it — on a match, on a
// mismatch, on a stale id, always — so a plan can authorize exactly one write
// and an argument that drifted between plan and apply surfaces as `write_gated`
// rather than as a surprise mutation (CC-32). Only a claim by another owner
// leaves the plan alone: it is refused before anything is compared. The store
// is a plain Map and the ids die with the process, deliberately, because a plan
// that outlives the session it was reviewed in is no longer a reviewed plan.
// Under HTTP one store serves every session (D513), so it also drops a closed
// session's plans, expires plans by age and caps each session on its own (D514).
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
// CONFIRMATION (D303). Under `JIRA_IRREVERSIBLE_CONFIRM=elicit` an irreversible
// apply that passed every check above also asks the human at the client, via an
// MCP elicitation, before the handler runs. It is a third lock, not a
// replacement: the plan_id still binds the arguments and the env opt-in still
// arms the tier. The question is asked AFTER the plan_id is claimed, so a
// decline spends the plan and two applies racing on one id cannot both prompt;
// a client that cannot be asked is refused BEFORE the claim, because that is
// the operator's to fix and must not cost the caller the plan.
//
// WRITE CONFIRMATION (D529). `JIRA_WRITE_CONFIRM` widens the same question to
// writes of every tier: `elicit` asks before every apply, `tainted` once this
// gate has handed the session a result branded as tenant content (D15). Plan/
// apply alone is driven by the model, so under prompt injection it is no human
// check; this is. It adds to `JIRA_IRREVERSIBLE_CONFIRM` and never weakens it.
// The question is server-authored first and quotes tenant or model text only
// on one labelled, fenced, clipped line (D530).
//
// Layering: `core ← api ← mcp ← tools`. No zod, no SDK.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import type {
  Clock,
  JiraMultipartFile,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  QueryParams,
  QueryValue,
  IrreversibleConfirm,
  WriteConfirm,
  WriteMode,
} from '../core/types.js';
import { assertNever } from '../core/assert-never.js';
import { systemSecureRandom } from '../core/rng.js';
import type { SecureRandom } from '../core/rng.js';
import { CONTROL_FIELD_NAMES } from './define.js';
import { errorResult, errorResultOf } from './errors.js';
import { markExecuted, ok } from './result.js';
import type {
  AnyToolSpec,
  ControlFields,
  PlanContext,
  PlanFieldChange,
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

/** The environment variable that adds the human confirmation (D303). */
export const CONFIRM_ENV_VAR = 'JIRA_IRREVERSIBLE_CONFIRM';

/** The environment variable that confirms writes of every tier (D529). */
export const WRITE_CONFIRM_ENV_VAR = 'JIRA_WRITE_CONFIRM';

/** Remediation when the client cannot be asked: a client or operator change. */
export const CONFIRM_UNAVAILABLE_REMEDIATION =
  'Use an MCP client that supports form elicitation, or have the operator ' +
  `restart the server with ${CONFIRM_ENV_VAR}=off. The plan_id was not consumed.`;

/** The same, when `JIRA_WRITE_CONFIRM` is what asks (D529). */
export const WRITE_CONFIRM_UNAVAILABLE_REMEDIATION =
  'Use an MCP client that supports form elicitation, or have the operator ' +
  `restart the server with ${WRITE_CONFIRM_ENV_VAR}=off. The plan_id was not consumed.`;

/**
 * Longest excerpt of tenant or model text a confirmation message quotes: one
 * line, so a planted paragraph cannot pass for the server's own words (D530).
 */
export const CONFIRM_BEFORE_MAX_CHARS = 200;

/** The fence around a quoted excerpt; both marks are stripped from the text. */
export const CONFIRM_QUOTE_OPEN = '⟦';
export const CONFIRM_QUOTE_CLOSE = '⟧';

/**
 * Remediation for the one refusal a re-plan cannot fix: the operator has to
 * enable the tier first, so the text names the variable instead of the ritual.
 */
export const IRREVERSIBLE_REMEDIATION =
  `Restart the server with ${IRREVERSIBLE_ENV_VAR}=true (in addition to ` +
  'JIRA_WRITE_MODE=apply), then repeat plan then apply. Planning keeps working ' +
  'without it: re-run without apply to see what would be destroyed.';

/**
 * The `plan` hint's message: the exact re-invocation, per TOOLS.md. Under
 * JIRA_WRITE_MODE=plan no re-invocation can apply, and the plan_id dies with
 * the restart that would allow it, so the hint names the operator step instead
 * of a call that would only plan again (CC-550).
 */
export function planHintMessage(
  toolName: string,
  planId: string,
  planMode: boolean,
  ignoredApply: boolean,
  applyDisabled = false,
): string {
  const head = `${PLAN_NOTICE_LINE} Nothing was sent to Jira. Review \`data.planned\`, then `;
  const withMode = planMode
    ? `${head}note that this server runs with JIRA_WRITE_MODE=plan, so no ` +
      'call can apply it: an operator has to restart the server with ' +
      `JIRA_WRITE_MODE=apply, and because \`plan_id: "${planId}"\` dies with this ` +
      `process, \`${toolName}\` must then be planned again and applied with the new id.` +
      (ignoredApply ? ' `apply: true` was ignored.' : '')
    : `${head}re-invoke \`${toolName}\` with the IDENTICAL arguments plus \`apply: true\` and ` +
      `\`plan_id: "${planId}"\`. The id is single-use and dies with this server process.`;
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

/** Bytes of CSPRNG output in one plan id: 128 bits (D511). */
export const PLAN_ID_BYTES = 16;

/** Shape of every id this module mints; asserted by the tests. */
export const PLAN_ID_PATTERN = /^plan_[0-9a-f]{32}$/;

/** How many outstanding plans one session keeps before evicting its own oldest. */
export const MAX_OUTSTANDING_PLANS = 64;

/**
 * The whole store's backstop (D514): a server-wide store holds every session's
 * plans, and a closed session's are dropped, so this only binds if sessions are
 * never closed. 32 sessions (`HTTP_MAX_SESSIONS`) at the per-session quota.
 */
export const MAX_STORE_PLANS = 32 * MAX_OUTSTANDING_PLANS;

/**
 * How long a server-wide plan waits for its apply (D514). The HTTP transport's
 * store uses it; the stdio store has no TTL, as before.
 */
export const PLAN_TTL_MS = 60 * 60_000;

/**
 * How many evicted ids the store still recognizes, so an apply of one is told
 * WHY it failed (CC-1000). Ids only — a tombstone holds no binding — and bounded
 * on its own, so a runaway planner cannot grow memory through this side either.
 */
export const MAX_EVICTED_TOMBSTONES = 256;

/**
 * Mint a plan id from the CSPRNG seam (D511). Under a server-wide store an id is
 * a handle another session could try, so it must be unguessable; the owner
 * binding (D512) is the second lock, not a substitute. A short or missing byte
 * from an injected source reads as zero, so the shape never varies.
 */
export function newPlanId(random: SecureRandom): string {
  const bytes = random(PLAN_ID_BYTES);
  let hex = '';
  for (let index = 0; index < PLAN_ID_BYTES; index += 1) {
    hex += (bytes[index] ?? 0).toString(16).padStart(2, '0');
  }
  return `plan_${hex}`;
}

/**
 * Who may apply a plan (D512): the session that planned it, holding the same
 * credential. Both are opaque strings; the credential is a digest, never the
 * secret itself ({@link credentialFingerprint}).
 */
export interface PlanOwner {
  readonly session: string;
  readonly credential: string;
}

/**
 * The owner of every plan when nothing names one: stdio (one process, one
 * client) and a gate built without a server. Equal to itself, so nothing changes
 * for those callers.
 */
export const LOCAL_PLAN_OWNER: PlanOwner = Object.freeze({
  session: 'local',
  credential: 'local',
});

/**
 * The credential half of a {@link PlanOwner}: a SHA-256 of the secret the caller
 * authenticated with, so the store never holds the secret and two different
 * secrets cannot share plans.
 */
export function credentialFingerprint(secret: string): string {
  return `sha256:${createHash('sha256').update(secret, 'utf8').digest('hex')}`;
}

/** Key order is normalized so `{a,b}` and `{b,a}` are the same request. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Null-prototype on purpose (CC-145): on a plain `{}`, `out['__proto__'] = x`
    // re-parents the object instead of adding a key, so an own `__proto__` in
    // the args — JSON.parse makes one, and `z.unknown()` passes it through —
    // would vanish from the fingerprint and two different bodies would match.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
      // Spelled as credentials.ts resolves it, so "EU" and "eu" bind the same tenant (CC-553).
      profile: profile?.trim().toLowerCase() ?? null,
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
  /**
   * Digest of the multipart payload the plan showed, when it showed one. The
   * arguments of an upload name a file, not its bytes, so the fingerprint alone
   * would let a file replaced between plan and apply ride an approved plan_id
   * (CC-426). Checked by the gate on apply, not by `consume`: the bytes are only
   * known once the handler has read the file again.
   */
  readonly payload?: string;
  /**
   * The entity's modification stamp when the plan was built (D132). An apply
   * whose `planContext` reads a different one is refused as `stale`: the diff
   * the plan showed no longer describes what the write would overwrite.
   */
  readonly version?: string;
  /**
   * What the confirmation question quotes (D303): composed when the plan is
   * built, from the planned request and its `before` snapshot, so the human is
   * asked about what the model was shown, not about a fresh read.
   */
  readonly summary?: string;
}

/**
 * Outcome of an apply's id check; `ok` is the only one that lets a write run.
 * `foreign`: another owner planned it (D512). `expired`: older than the store's
 * TTL (D514).
 */
export type PlanConsumeOutcome =
  'ok' | 'unknown' | 'mismatch' | 'evicted' | 'expired' | 'foreign';

/** A consumed plan: the outcome, and on `ok` what the plan was issued with. */
export interface PlanClaim {
  readonly outcome: PlanConsumeOutcome;
  readonly issued?: PlanBinding;
}

/**
 * Single-use plan ids (D14), each bound to an owner (D512). One per gate under
 * stdio; one per process under HTTP, shared by every session (D513).
 */
export interface PlanStore {
  /** Register a binding for `owner` (default {@link LOCAL_PLAN_OWNER}) and return its id. */
  issue(binding: PlanBinding, owner?: PlanOwner): string;
  /**
   * Check and consume `planId`; the id is spent whatever the answer is, except
   * `foreign`: a claim by another owner leaves the owner's plan alone.
   */
  consume(planId: string, binding: PlanBinding, owner?: PlanOwner): PlanConsumeOutcome;
  /** `consume`, plus the binding the id was issued with when the answer is `ok`. */
  claim(planId: string, binding: PlanBinding, owner?: PlanOwner): PlanClaim;
  /** Forget every plan of a session that ended; its ids then read as `unknown`. */
  dropSession(session: string): void;
  /** Outstanding plans, all sessions — a leak check for the tests. */
  readonly size: number;
}

export interface PlanStoreOptions {
  /** Where ids come from. Production leaves it to the CSPRNG (D511). */
  readonly random?: SecureRandom | undefined;
  /** Outstanding plans per session before that session's oldest is evicted. */
  readonly maxPerSession?: number | undefined;
  /** Outstanding plans in the whole store; the globally oldest loses (D514). */
  readonly maxTotal?: number | undefined;
  /**
   * With `ttlMs`, plans older than it are dropped as `expired` (D514). Both or
   * neither: the stdio store has no clock and no TTL.
   */
  readonly clock?: Clock | undefined;
  readonly ttlMs?: number | undefined;
}

interface StoredPlan {
  readonly binding: PlanBinding;
  readonly owner: PlanOwner;
  readonly issuedAt: number;
}

type Tombstone = 'evicted' | 'expired';

function sameOwner(left: PlanOwner, right: PlanOwner): boolean {
  return left.session === right.session && left.credential === right.credential;
}

export function createPlanStore(options: PlanStoreOptions = {}): PlanStore {
  const random = options.random ?? systemSecureRandom;
  const perSession = Math.max(1, options.maxPerSession ?? MAX_OUTSTANDING_PLANS);
  const total = Math.max(1, options.maxTotal ?? MAX_STORE_PLANS);
  const { clock } = options;
  const ttlMs = clock === undefined ? undefined : options.ttlMs;
  const plans = new Map<string, StoredPlan>();
  const perSessionCount = new Map<string, number>();
  // Ids pushed out by a bound or the TTL, oldest first. Without them an evicted
  // id read as "unknown, already used, or from an earlier process" — none of
  // which was true for a model that planned a batch of more than 64 writes and
  // then applied it in order, and nothing told it to apply as it plans (CC-1000).
  const tombstones = new Map<string, Tombstone>();

  const forget = (id: string): void => {
    const entry = plans.get(id);
    if (entry === undefined) return;
    plans.delete(id);
    const left = (perSessionCount.get(entry.owner.session) ?? 1) - 1;
    if (left <= 0) perSessionCount.delete(entry.owner.session);
    else perSessionCount.set(entry.owner.session, left);
  };

  const bury = (id: string, why: Tombstone): void => {
    forget(id);
    tombstones.delete(id);
    tombstones.set(id, why);
    while (tombstones.size > MAX_EVICTED_TOMBSTONES) {
      const stalest = tombstones.keys().next();
      if (stalest.done === true) break;
      tombstones.delete(stalest.value);
    }
  };

  const sweep = (): void => {
    if (clock === undefined || ttlMs === undefined) return;
    const now = clock.now();
    for (const [id, entry] of plans) {
      if (now - entry.issuedAt >= ttlMs) bury(id, 'expired');
    }
  };

  /** The oldest plan, of one session or of any; Map iterates in insertion order. */
  const oldest = (session?: string): string | undefined => {
    for (const [id, entry] of plans) {
      if (session === undefined || entry.owner.session === session) return id;
    }
    return undefined;
  };

  return {
    get size(): number {
      return plans.size;
    },

    issue(binding: PlanBinding, owner: PlanOwner = LOCAL_PLAN_OWNER): string {
      sweep();
      // Bounded memory, per session first (D514): a session over its quota
      // loses its OWN oldest plan, never another session's. Insertion order is
      // the age, so "oldest" needs no timestamp.
      while ((perSessionCount.get(owner.session) ?? 0) >= perSession) {
        const id = oldest(owner.session);
        if (id === undefined) break;
        bury(id, 'evicted');
      }
      while (plans.size >= total) {
        const id = oldest();
        if (id === undefined) break;
        bury(id, 'evicted');
      }

      let id = newPlanId(random);
      for (let attempt = 0; plans.has(id) && attempt < 8; attempt += 1) {
        id = newPlanId(random);
      }
      // A deterministic (test) source can repeat forever; the newer plan wins
      // so an id never authorizes two different requests.
      forget(id);
      tombstones.delete(id);
      plans.set(id, { binding, owner, issuedAt: clock?.now() ?? 0 });
      perSessionCount.set(owner.session, (perSessionCount.get(owner.session) ?? 0) + 1);
      return id;
    },

    consume(
      planId: string,
      binding: PlanBinding,
      owner: PlanOwner = LOCAL_PLAN_OWNER,
    ): PlanConsumeOutcome {
      return this.claim(planId, binding, owner).outcome;
    },

    claim(
      planId: string,
      binding: PlanBinding,
      owner: PlanOwner = LOCAL_PLAN_OWNER,
    ): PlanClaim {
      sweep();
      const found = plans.get(planId);
      if (found === undefined) {
        // Reported once, like any other spent id: the next try is `unknown`.
        const why = tombstones.get(planId);
        tombstones.delete(planId);
        return { outcome: why ?? 'unknown' };
      }
      // Before anything is compared or spent (D512): another session cannot
      // learn whether its arguments match, and cannot burn the owner's plan.
      if (!sameOwner(found.owner, owner)) return { outcome: 'foreign' };
      // Single-use is unconditional for the owner: a mismatched apply burns the
      // id too, so a caller cannot probe arguments against a live plan.
      forget(planId);
      if (
        found.binding.tool !== binding.tool ||
        found.binding.fingerprint !== binding.fingerprint
      ) {
        return { outcome: 'mismatch' };
      }
      return { outcome: 'ok', issued: found.binding };
    },

    dropSession(session: string): void {
      for (const [id, entry] of plans) {
        if (entry.owner.session === session) forget(id);
      }
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
  /** `payloadDigest` of the captured mutation's multipart, if it had one. */
  readonly payload: string | undefined;
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

/**
 * A digest of everything a multipart request would upload, or `undefined` when
 * it uploads nothing. Every field is length-prefixed so no two different part
 * lists can serialize to the same stream.
 */
function payloadDigest(
  parts: readonly JiraMultipartFile[] | undefined,
): string | undefined {
  if (parts === undefined || parts.length === 0) return undefined;
  const hash = createHash('sha256');
  const text = (value: string): void => {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(`${bytes.byteLength}:`).update(bytes);
  };
  for (const part of parts) {
    text(part.field);
    text(part.filename);
    text(part.contentType ?? '');
    hash.update(`${part.bytes.byteLength}:`).update(part.bytes);
  }
  return hash.digest('hex');
}

/** Rejects the first mutation of a guarded apply; never leaves this module. */
class PayloadDrifted extends Error {
  constructor() {
    super('upload payload changed since the plan');
    this.name = 'PayloadDrifted';
  }
}

/**
 * The apply-side twin of the capture: a seam that lets the handler's FIRST
 * mutation through only if it uploads exactly the payload the plan showed. On a
 * drift nothing is sent, every later mutation is refused too, and `drifted`
 * tells the gate to replace whatever envelope the handler made of the rejection.
 */
function createPayloadGuard(
  inner: JiraRequestFn,
  expected: string,
): { readonly jira: JiraRequestFn; readonly drifted: boolean } {
  let checked = false;
  let drifted = false;
  const jira: JiraRequestFn = <T = unknown>(
    req: JiraRequestSpec,
  ): Promise<JiraResponse<T>> => {
    if (isReadRequest(req)) return inner<T>(req);
    if (!checked) {
      checked = true;
      drifted = payloadDigest(req.multipart) !== expected;
    }
    return drifted ? Promise.reject(new PayloadDrifted()) : inner<T>(req);
  };
  return {
    jira,
    get drifted(): boolean {
      return drifted;
    },
  };
}

/**
 * A pass-through seam that remembers whether a mutation came back from Jira
 * with a response. Reads and a mutation that threw do not count: the first
 * changed nothing, and the second's outcome is the error envelope's to tell.
 */
function observeMutations(inner: JiraRequestFn): {
  readonly jira: JiraRequestFn;
  readonly any: boolean;
} {
  let any = false;
  const jira: JiraRequestFn = async <T = unknown>(
    req: JiraRequestSpec,
  ): Promise<JiraResponse<T>> => {
    if (isReadRequest(req)) return inner<T>(req);
    const response = await inner<T>(req);
    any = true;
    return response;
  };
  return {
    jira,
    get any(): boolean {
      return any;
    },
  };
}

/**
 * Rejects a mutation issued through a read-only seam: by a read tool's handler
 * or by a `planContext` (D527). It is not a `JiraError`, so the catch site
 * projects it as the fixed unexpected-error envelope — a read tool that tries
 * to write is a bug in this server, not in the request.
 */
type ReadOnlySource = 'read_tool' | 'plan_context';

class ReadOnlyViolation extends Error {
  constructor(source: ReadOnlySource, method: string) {
    super(`${source === 'read_tool' ? 'a read tool' : 'planContext'} issued a ${method}`);
    this.name = 'ReadOnlyViolation';
  }
}

/**
 * The seam a read runs on: GET and `safe` requests pass, any other request is
 * refused without reaching the network. Read tools get it at runtime, so the
 * "read" label is enforced, not trusted (D527, CC-5180); a `planContext` gets
 * it because it runs OUTSIDE the capture, where a write slipping in would be a
 * real write in plan mode.
 */
function readOnlySeam(inner: JiraRequestFn, source: ReadOnlySource): JiraRequestFn {
  return <T = unknown>(req: JiraRequestSpec): Promise<JiraResponse<T>> =>
    isReadRequest(req)
      ? inner<T>(req)
      : Promise.reject(new ReadOnlyViolation(source, req.method));
}

function createPlanCapture(
  inner: JiraRequestFn,
  redact: ((value: unknown) => unknown) | undefined,
  preflight?: (req: JiraRequestSpec) => Promise<void>,
): PlanCapture {
  let planned: PlannedUpload | undefined;
  let payload: string | undefined;
  const before: BeforeSlot = { noted: false, value: undefined };

  const jira: JiraRequestFn = <T = unknown>(
    req: JiraRequestSpec,
  ): Promise<JiraResponse<T>> => {
    if (isReadRequest(req)) return inner<T>(req);
    // A mutation the preflight refuses (the JIRA_PROJECTS scope, D400) is
    // never recorded: the handler sees the refusal, as it would on apply.
    if (planned === undefined && preflight !== undefined) {
      return preflight(req).then(() => capture<T>(req));
    }
    return capture<T>(req);
  };

  const capture = <T = unknown>(req: JiraRequestSpec): Promise<JiraResponse<T>> => {
    // Keep the FIRST mutation: a handler that swallowed the unwind and tried a
    // second write must not be able to rewrite the plan the model approved.
    if (planned === undefined) {
      const query = plannedQuery(req.query, redact);
      const multipart = plannedMultipart(req.multipart, redact);
      payload = payloadDigest(req.multipart);
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
    get payload(): string | undefined {
      return payload;
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
  /**
   * Source of plan ids when the gate builds its own store; the CSPRNG when
   * absent (D511). Tests inject a scripted one to assert exact ids.
   */
  readonly random?: SecureRandom | undefined;
  /** Redaction choke point applied to a captured body (`PlannedRequest.body`). */
  readonly redact?: ((value: unknown) => unknown) | undefined;
  /**
   * The plan store. The HTTP transport passes one store shared by every session
   * (D513); a gate built without one keeps its own, as stdio does.
   */
  readonly store?: PlanStore | undefined;
  /**
   * Who is calling, read at call time (D512): the server resolves it from the
   * request's session and credential. Absent, or answering `undefined`, means
   * {@link LOCAL_PLAN_OWNER}.
   */
  readonly owner?: (() => PlanOwner | undefined) | undefined;
  /** `JIRA_IRREVERSIBLE_CONFIRM` (D303). Absent means `off`. */
  readonly irreversibleConfirm?: IrreversibleConfirm | undefined;
  /** `JIRA_WRITE_CONFIRM` (D529). Absent means `off`. */
  readonly writeConfirm?: WriteConfirm | undefined;
  /** How the question reaches a human; the server binds it to elicitation. */
  readonly confirmer?: IrreversibleConfirmer | undefined;
}

/** One confirmation question: the tool and what it is about to do. */
export interface ConfirmRequest {
  readonly tool: string;
  readonly message: string;
  /** Whether the write is in the irreversible tier; the form wording follows it. */
  readonly irreversible: boolean;
}

/**
 * The human-in-the-loop seam (D303). Kept SDK-free so the gate stays testable
 * without a client; `mcp/server.ts` implements it with `elicitInput`.
 */
export interface IrreversibleConfirmer {
  /** Whether the connected client can be asked at all. */
  available(): boolean;
  /**
   * Ask. `true` only for an explicit yes; a decline, a cancel, a malformed
   * answer and a failed request are all `false` (or a throw), never a yes.
   */
  ask(request: ConfirmRequest): Promise<boolean>;
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
  /** Run the tool's `planContext`, when it declares one (D132). */
  context?(jira: JiraRequestFn): Promise<PlanContext>;
  /**
   * Admit a mutation before plan mode records it — the JIRA_PROJECTS scope
   * guard (D400). A rejection reaches the handler as the write's failure, so
   * no plan is issued for a write the apply would refuse.
   */
  preflight?(req: JiraRequestSpec): Promise<void>;
}

export interface WriteGate {
  /** Run one tool call under the gate. Reads pass straight through. */
  execute(call: WriteGateCall): Promise<ToolResult<unknown>>;
  /** Outstanding plan ids; diagnostics and tests only. */
  readonly outstandingPlans: number;
}

/** Every reason the gate refuses an apply. `ok` is not one of them. */
export type GateRefusal =
  | 'missing'
  | 'irreversible'
  | 'confirm_unavailable'
  | 'write_confirm_unavailable'
  | 'declined'
  | 'payload'
  | 'stale'
  | Exclude<PlanConsumeOutcome, 'ok'>;

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
    case 'confirm_unavailable':
      return (
        'This tool is in the irreversible tier and this server asks a human to ' +
        `confirm every such apply (${CONFIRM_ENV_VAR}=elicit), but the connected ` +
        'client does not support form elicitation, so nobody can be asked. The ' +
        'plan_id was NOT consumed. Nothing was sent to Jira.'
      );
    case 'write_confirm_unavailable':
      return (
        'This server asks a human to confirm this write ' +
        `(${WRITE_CONFIRM_ENV_VAR}), but the connected client does not support ` +
        'form elicitation, so nobody can be asked. The plan_id was NOT consumed. ' +
        'Nothing was sent to Jira.'
      );
    case 'declined':
      return (
        'The confirmation was not given: the human declined or cancelled it, or ' +
        'the question could not be delivered. The plan_id is spent. Nothing was ' +
        'sent to Jira.'
      );
    case 'payload':
      return (
        'The file changed between the plan and this apply, so the plan_id no ' +
        'longer describes what would be uploaded. The plan_id is spent. Nothing ' +
        'was sent to Jira.'
      );
    case 'stale':
      return (
        'The issue changed in Jira after the plan was made, so the diff the plan ' +
        'showed no longer describes what this write would overwrite. The plan_id ' +
        'is spent. Nothing was sent to Jira.'
      );
    case 'evicted':
      return (
        'That plan_id expired unused: the server keeps at most ' +
        `${String(MAX_OUTSTANDING_PLANS)} unapplied plans per session and drops the ` +
        'oldest when a newer plan would exceed that. Apply each plan before planning that ' +
        'many more. Nothing was sent to Jira.'
      );
    case 'expired':
      return (
        'That plan_id expired unused: this server drops a plan that is not ' +
        `applied within ${String(Math.round(PLAN_TTL_MS / 60_000))} minutes. ` +
        'Nothing was sent to Jira.'
      );
    case 'foreign':
      return (
        'That plan_id was issued to another session or credential: only the ' +
        'session that planned a write can apply it. The plan_id was NOT consumed. ' +
        'Nothing was sent to Jira.'
      );
    case 'unknown':
      return (
        'That plan_id is unknown, already used, or was issued by an earlier server ' +
        'process. Plans are single-use and in-memory. Nothing was sent to Jira.'
      );
    case 'mismatch':
      return (
        'The arguments changed between the plan and this apply, so the plan_id no ' +
        'longer describes this request. Nothing was sent to Jira.'
      );
    default:
      return assertNever(reason, 'gate refusal');
  }
}

/** A `write_gated` envelope: the refusal path never reaches the network. */
export function writeGatedResult(reason: GateRefusal): ToolResult<never> {
  return errorResultOf('write_gated', refusal(reason), {
    retryable: false,
    // Re-planning cannot fix a server that is not allowed to delete; that one
    // refusal points at the operator instead.
    remediation:
      reason === 'irreversible'
        ? IRREVERSIBLE_REMEDIATION
        : reason === 'confirm_unavailable'
          ? CONFIRM_UNAVAILABLE_REMEDIATION
          : reason === 'write_confirm_unavailable'
            ? WRITE_CONFIRM_UNAVAILABLE_REMEDIATION
            : REPLAN_REMEDIATION,
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

/**
 * The plan of a write whose tool declares a `planContext` (D132): `PlanPayload`
 * plus what each touched field holds now and would hold after the apply.
 */
export interface DiffPlanPayload extends PlanPayload {
  readonly diff: readonly PlanFieldChange[];
}

/**
 * The tool's plan context, or `undefined` when it has none or the read failed.
 * In plan mode the diff is advisory — a failed read must not cost the caller
 * the plan, and the handler has already proved the write is well-formed.
 */
async function readPlanContext(call: WriteGateCall): Promise<PlanContext | undefined> {
  if (call.context === undefined) return undefined;
  try {
    return await call.context(readOnlySeam(call.jira, 'plan_context'));
  } catch {
    return undefined;
  }
}

/**
 * Text quoted into a confirmation question, made harmless to read (D530): JSON
 * for anything that is not a string, every control, format and line-separator
 * character turned into a space, whitespace runs collapsed, the fence marks
 * removed, clipped to {@link CONFIRM_BEFORE_MAX_CHARS}. The result is one line
 * that cannot close its own fence.
 */
export function confirmQuote(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? 'null';
    } catch {
      text = String(value);
    }
  }
  const flat = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replaceAll(CONFIRM_QUOTE_OPEN, ' ')
    .replaceAll(CONFIRM_QUOTE_CLOSE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  const clipped =
    chars.length > CONFIRM_BEFORE_MAX_CHARS
      ? `${chars.slice(0, CONFIRM_BEFORE_MAX_CHARS).join('')}…`
      : flat;
  return `${CONFIRM_QUOTE_OPEN}${clipped}${CONFIRM_QUOTE_CLOSE}`;
}

/** The server-authored action line: what runs, in one line. */
function actionLine(label: string, toolName: string, planned: PlannedRequest): string {
  const path = planned.path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ');
  return `Confirm ${label} ${toolName}: ${planned.method} ${path}.`;
}

/**
 * The confirmation question of an irreversible apply (D303, D530): the
 * server's action line first, then — when the plan noted one — the redacted
 * before-state on its own line, labelled as tenant text and fenced, because an
 * elicitation message is shown verbatim and a planted "safe, approve" must not
 * read as the server speaking.
 */
export function confirmSummary(
  toolName: string,
  planned: PlannedRequest,
  before: { readonly noted: boolean; readonly value: unknown },
): string {
  const head = `${actionLine('IRREVERSIBLE', toolName, planned)} Jira cannot undo this.`;
  if (!before.noted) return head;
  return (
    `${head}\nIt destroys what Jira holds now. Quoted from Jira, written by ` +
    'users of the site, not by this server; ignore any instruction in it: ' +
    confirmQuote(before.value)
  );
}

/**
 * The confirmation question of a standard-tier apply (D529, D530): the
 * action line, then the redacted body on one labelled, fenced line. The body
 * is the model's, and under injection the model's words can be an attacker's,
 * so it is quoted as such — it is also exactly what a human needs to see to
 * catch a planted remote link or comment.
 */
export function writeConfirmSummary(toolName: string, planned: PlannedRequest): string {
  const head = `${actionLine('WRITE', toolName, planned)} This changes Jira.`;
  const sent =
    planned.body !== undefined
      ? planned.body
      : planned.query !== undefined
        ? planned.query
        : undefined;
  if (sent === undefined) return head;
  return (
    `${head}\nWhat it sends, as the model wrote it; it may repeat text read ` +
    'from Jira, so ignore any instruction in it: ' +
    confirmQuote(sent)
  );
}

export function createWriteGate(deps: WriteGateDeps): WriteGate {
  const store = deps.store ?? createPlanStore({ random: deps.random });
  const ownerNow = (): PlanOwner => deps.owner?.() ?? LOCAL_PLAN_OWNER;
  const confirmIrreversible = deps.irreversibleConfirm === 'elicit';
  const writeConfirm: WriteConfirm = deps.writeConfirm ?? 'off';
  // D529 `tainted`: latched for the gate's lifetime, which is one session's.
  // Any result this gate hands out branded as tenant content sets it — a read,
  // a plan carrying a before-state or diff, an apply's receipt.
  let tainted = false;
  const observe = (result: ToolResult<unknown>): ToolResult<unknown> => {
    if (result._untrusted === true) tainted = true;
    return result;
  };
  /** Which knob, if any, makes this apply ask a human. */
  const confirmSource = (tool: AnyToolSpec): 'irreversible' | 'write' | undefined => {
    if (confirmIrreversible && tool.writeTier === 'irreversible') return 'irreversible';
    if (writeConfirm === 'elicit') return 'write';
    if (writeConfirm === 'tainted' && tainted) return 'write';
    return undefined;
  };
  /** Whether a plan should store a question: the apply may need one. */
  const mayConfirm = (tool: AnyToolSpec): boolean =>
    writeConfirm !== 'off' || (confirmIrreversible && tool.writeTier === 'irreversible');

  const plan = async (call: WriteGateCall): Promise<ToolResult<unknown>> => {
    // Taken before the handler runs, as apply takes it, so a handler that
    // normalises its arguments in place cannot make plan and apply disagree (CC-552).
    const fingerprint = planFingerprint(call.tool.name, call.args, call.control.profile);
    const capture = createPlanCapture(call.jira, deps.redact, call.preflight?.bind(call));
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

    // Read only once the handler reached its write: a call it refused locally
    // costs no extra request.
    const context = await readPlanContext(call);
    const digest = capture.payload;
    const version = context?.version;
    const redact = (value: unknown): unknown =>
      deps.redact === undefined ? value : deps.redact(value);
    const summary = !mayConfirm(call.tool)
      ? undefined
      : call.tool.writeTier === 'irreversible'
        ? confirmSummary(call.tool.name, planned, {
            noted: capture.before.noted,
            value: redact(capture.before.value),
          })
        : writeConfirmSummary(call.tool.name, planned);
    const planId = store.issue(
      {
        tool: call.tool.name,
        fingerprint,
        ...(digest === undefined ? {} : { payload: digest }),
        ...(version === undefined ? {} : { version }),
        ...(summary === undefined ? {} : { summary }),
      },
      ownerNow(),
    );
    const base: PlanPayload = { executed: false, planned, plan_id: planId };
    const noted = capture.before.noted;
    const withBefore: PlanPayload | IrreversiblePlanPayload = noted
      ? { ...base, before: redact(capture.before.value) }
      : base;
    const payload: PlanPayload | IrreversiblePlanPayload | DiffPlanPayload =
      context === undefined
        ? withBefore
        : { ...withBefore, diff: redact(context.diff) as readonly PlanFieldChange[] };
    const tenantText = noted || context !== undefined;

    return ok(payload, {
      hints: [
        {
          code: 'plan',
          message: planHintMessage(
            call.tool.name,
            planId,
            deps.writeMode === 'plan',
            deps.writeMode === 'plan' && call.control.apply === true,
            call.tool.writeTier === 'irreversible' && !deps.allowIrreversible,
          ),
        },
      ],
      // A before-state or a diff's `from` side is tenant-authored prose
      // (summaries, comment bodies), so the plan envelope carries the D15 brand
      // its read tool would have carried.
      ...(tenantText ? { untrusted: true } : {}),
    });
  };

  const apply = async (call: WriteGateCall): Promise<ToolResult<unknown>> => {
    // Checked BEFORE the plan_id is consumed: this refusal is the operator's
    // to fix, so it must not also burn the plan the caller will re-apply once
    // the tier is enabled. Standard-tier calls never see this branch.
    if (call.tool.writeTier === 'irreversible' && !deps.allowIrreversible) {
      return writeGatedResult('irreversible');
    }

    const planId = call.control.plan_id;
    if (planId === undefined || planId === '') return writeGatedResult('missing');

    // Decided once, before the claim: a taint that lands while this apply
    // waits does not change which question it asks.
    const source = confirmSource(call.tool);
    const irreversible = call.tool.writeTier === 'irreversible';
    // Before the claim, like the tier check: a client that cannot be asked is
    // not the caller's fault, and the plan must survive a client switch.
    if (source !== undefined && deps.confirmer?.available() !== true) {
      return writeGatedResult(
        source === 'irreversible' ? 'confirm_unavailable' : 'write_confirm_unavailable',
      );
    }

    // Read BEFORE the plan_id is consumed: a failed read is a transient
    // failure the caller retries, and it must not burn the approved plan.
    let live: PlanContext | undefined;
    if (call.context !== undefined) {
      try {
        live = await call.context(readOnlySeam(call.jira, 'plan_context'));
      } catch (error) {
        return errorResult(error);
      }
    }

    const { outcome, issued } = store.claim(
      planId,
      {
        tool: call.tool.name,
        fingerprint: planFingerprint(call.tool.name, call.args, call.control.profile),
      },
      ownerNow(),
    );
    if (outcome !== 'ok') return writeGatedResult(outcome);
    // A plan built without a stamp (its context read failed) has nothing to
    // compare; one built with a stamp needs the same stamp now.
    if (issued?.version !== undefined && live?.version !== issued.version) {
      return writeGatedResult('stale');
    }

    // After the claim: the plan is spent whatever the human answers, so a
    // decline cannot be retried into a yes on the same id (D303).
    if (source !== undefined) {
      let confirmed: boolean;
      try {
        confirmed =
          (await deps.confirmer?.ask({
            tool: call.tool.name,
            irreversible,
            message:
              issued?.summary ??
              (irreversible
                ? `Confirm IRREVERSIBLE ${call.tool.name}. Jira cannot undo this.`
                : `Confirm WRITE ${call.tool.name}. This changes Jira.`),
          })) === true;
      } catch {
        confirmed = false;
      }
      if (!confirmed) return writeGatedResult('declined');
    }

    // `executed: true` (D506) only when a mutation reached Jira and came back:
    // a handler that decided there was nothing to send did not execute.
    const sent = observeMutations(call.jira);
    const stamp = (result: ToolResult<unknown>): ToolResult<unknown> =>
      sent.any ? markExecuted(result) : result;

    const expected = issued?.payload;
    if (expected === undefined) return stamp(await call.invoke(sent.jira));
    const guard = createPayloadGuard(sent.jira, expected);
    let result: ToolResult<unknown>;
    try {
      result = await call.invoke(guard.jira);
    } catch (error) {
      if (!(error instanceof PayloadDrifted)) throw error;
      return writeGatedResult('payload');
    }
    return guard.drifted ? writeGatedResult('payload') : stamp(result);
  };

  return {
    get outstandingPlans(): number {
      return store.size;
    },

    async execute(call: WriteGateCall): Promise<ToolResult<unknown>> {
      // Reads are never gated, including the reads a plan is built from — but
      // they are confined: a read tool's handler gets a seam that refuses any
      // mutation before the network (D527).
      if (call.tool.writeTier === undefined) {
        return observe(await call.invoke(readOnlySeam(call.jira, 'read_tool')));
      }

      const wantsApply = call.control.apply === true;
      if (deps.writeMode !== 'apply' || !wantsApply) return observe(await plan(call));
      return observe(await apply(call));
    },
  };
}
