// ---------------------------------------------------------------------------
// The write pipeline (D523–D524, ARC-07): the one constructor of the write gate
// a tool call runs under, as an explicit, ordered list of named layers.
//
// A tool call crosses these seams, innermost first:
//
//   registry (per call, on the `jira` seam — `mcp/registry.ts`):
//     meta cache → call controls → profile → project scope → progress count
//   write pipeline (per server, on the gate — this module):
//     gate → journal → recent_writes
//
// `gate` is `createWriteGate` (`mcp/write-mode.ts`): plan capture, payload
// guard, the read-only seam and the executed stamp, in that order of the call.
// `journal` (CC-33) records every executed write; `recent_writes` (CC-02)
// leaves an applied write's issue ids for `jira_search`. The order is pinned
// by `WRITE_PIPELINE_LAYERS` and a test: the recent-writes layer observes the
// envelope the journal may already have hinted on, and journaling stays the
// last thing that can touch an envelope.
//
// `buildWritePipeline` is the only place a production gate is constructed:
// `buildServer` builds the full pipeline, and a registry built without a server
// builds the same pipeline with nothing but the gate (no confirmer, so an
// irreversible apply under `elicit` fails closed — D303).
//
// THE JOURNAL IS WIRED HERE, AND ONLY HERE. `RegistryDeps` and `WriteGateDeps`
// have no `journal` seam, but the gate is injectable — so an executed write is
// detected where the truth actually is: at the request seam. See
// {@link journalingGate}.
//
// Layering: `core ← api ← mcp ← tools`. No zod, no SDK.
// ---------------------------------------------------------------------------

import { isJiraError } from '../core/errors.js';
import { NO_CID, currentCid } from '../core/log.js';
import type {
  Clock,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  Journal,
  JournalStatus,
  Settings,
} from '../core/types.js';
import { writtenIssueIds } from './recent-writes.js';
import type { RecentWrites } from './recent-writes.js';
import type { ToolResult } from './types.js';
import { createWriteGate, planFingerprint } from './write-mode.js';
import type {
  IrreversibleConfirmer,
  PlanOwner,
  PlanStore,
  WriteGate,
  WriteGateCall,
} from './write-mode.js';

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** The layers of the write pipeline, innermost first. The order is a contract. */
export const WRITE_PIPELINE_LAYERS = ['gate', 'journal', 'recent_writes'] as const;

export type WriteLayerName = (typeof WRITE_PIPELINE_LAYERS)[number];

export interface WritePipelineDeps {
  readonly settings: Pick<
    Settings,
    'writeMode' | 'allowIrreversible' | 'irreversibleConfirm' | 'reconcileWrites'
  >;
  /** Redaction choke point applied to a captured body. */
  readonly redact: (value: unknown) => unknown;
  /** Replaces the `gate` layer; tests only. The outer layers still wrap it. */
  readonly gate?: WriteGate | undefined;
  /** How an irreversible apply asks a human (D303). Absent = nobody to ask. */
  readonly confirmer?: IrreversibleConfirmer | undefined;
  /** The shared plan store (D513). Absent = the gate keeps its own. */
  readonly store?: PlanStore | undefined;
  /** The plan owner of the call in flight (D512). */
  readonly owner?: (() => PlanOwner | undefined) | undefined;
  /** Present = the `journal` layer runs (`JIRA_JOURNAL_PATH`). */
  readonly journal?: Journal | undefined;
  /**
   * Present = the `recent_writes` layer runs, unless `settings.reconcileWrites`
   * is `false` (D535).
   */
  readonly recentWrites?: RecentWrites | undefined;
  readonly clock?: Clock | undefined;
}

export interface WritePipeline {
  /** The outermost layer: what the registry calls. */
  readonly gate: WriteGate;
  /** The layers this pipeline runs, innermost first. */
  readonly layers: readonly WriteLayerName[];
}

/**
 * Build the write gate a tool call runs under, layer by layer in
 * {@link WRITE_PIPELINE_LAYERS} order. A layer whose dependency is absent is
 * left out; the `gate` layer is always there.
 */
export function buildWritePipeline(deps: WritePipelineDeps): WritePipeline {
  const { settings, journal, recentWrites } = deps;
  const wraps: Readonly<
    Record<Exclude<WriteLayerName, 'gate'>, ((inner: WriteGate) => WriteGate) | undefined>
  > = {
    journal:
      journal === undefined ? undefined : (inner) => journalingGate(inner, { journal }),
    recent_writes:
      recentWrites === undefined || settings.reconcileWrites === false
        ? undefined
        : (inner) =>
            recordingGate(inner, {
              recent: recentWrites,
              ...(deps.clock === undefined ? {} : { clock: deps.clock }),
            }),
  };

  let gate =
    deps.gate ??
    createWriteGate({
      writeMode: settings.writeMode,
      allowIrreversible: settings.allowIrreversible,
      irreversibleConfirm: settings.irreversibleConfirm,
      confirmer: deps.confirmer,
      store: deps.store,
      owner: deps.owner,
      redact: deps.redact,
    });
  const layers: WriteLayerName[] = ['gate'];
  for (const name of WRITE_PIPELINE_LAYERS) {
    if (name === 'gate') continue;
    const wrap = wraps[name];
    if (wrap === undefined) continue;
    gate = wrap(gate);
    layers.push(name);
  }
  return { gate, layers };
}

// ---------------------------------------------------------------------------
// Journaling (CC-33)
// ---------------------------------------------------------------------------

/** The `journal_unavailable` hint's message. The write itself is unaffected. */
export const JOURNAL_UNAVAILABLE_MESSAGE =
  'The write was performed, but it could not be recorded in the write journal ' +
  '(JIRA_JOURNAL_PATH). This result is unaffected — do NOT retry the write. The ' +
  'audit trail for this call is missing; check that the journal path is writable.';

/** A mutation that actually left the process, and what came back. */
interface ExecutedWrite {
  readonly httpStatus?: number;
}

/** GET is a read; so is anything `core/http.ts` may safely replay (`safe: true`). */
function isMutation(req: JiraRequestSpec): boolean {
  return req.method !== 'GET' && req.safe !== true;
}

function httpStatusOf(error: unknown): number | undefined {
  return isJiraError(error) ? error.httpStatus : undefined;
}

/**
 * The issue this call touched, for the journal's `issueKey` field.
 *
 * Read from the ARGUMENTS first (`issue`, then `inwardIssue` for a link), and
 * from the result only for a create, where the key did not exist until the write
 * happened. A multi-issue call reports no key rather than an arbitrary one — the
 * `argsHash` still identifies the call uniquely, and a half-true audit field is
 * worse than an absent one.
 */
function issueKeyOf(
  args: Record<string, unknown>,
  result?: ToolResult<unknown>,
): string | undefined {
  for (const field of ['issue', 'inwardIssue']) {
    const value = args[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  const data: unknown = result?.data;
  if (data !== null && typeof data === 'object') {
    const key: unknown = (data as { key?: unknown }).key;
    if (typeof key === 'string' && key !== '') return key;
  }
  return undefined;
}

/** Append the `journal_unavailable` hint without disturbing the rest. */
function withJournalHint(result: ToolResult<unknown>): ToolResult<unknown> {
  return {
    ...result,
    hints: [
      ...(result.hints ?? []),
      { code: 'journal_unavailable', message: JOURNAL_UNAVAILABLE_MESSAGE },
    ],
  };
}

/**
 * Wrap a {@link WriteGate} so every EXECUTED write is journaled.
 *
 * The detection is at the request seam rather than at the result, because only
 * the seam can tell the three outcomes apart that all look like "a write tool
 * returned":
 *
 * - PLAN MODE — the gate's own capturing seam intercepts the mutation before it
 *   reaches this observer, so nothing is journaled. That is the contract:
 *   "plan-mode calls are not journaled (nothing happened)".
 * - REFUSED APPLY — a missing, stale or mismatched `plan_id` returns
 *   `write_gated` without ever invoking the handler. Nothing observed, nothing
 *   journaled.
 * - LOCAL FAILURE — the handler rejected the arguments, or a read it needed
 *   failed, before issuing its mutation. Again nothing reached the wire.
 *
 * Only a mutation the handler actually issued produces a line. One that threw
 * with no HTTP status is journaled as attempted even if the throw came before
 * the wire (credential resolution, a host check): the seam cannot tell that
 * from a transport failure after the bytes left, and an audit trail must err
 * toward the write that may have landed (OBSERVABILITY.md). A mutation that
 * came back 4xx IS journaled, with `ok: false` and its status: the request was
 * made, and "was this attempted?" is the question the journal exists to answer.
 *
 * The FIRST mutation wins when a tool issues several (a transition with a
 * comment): it is the operation the plan described and the tool is named after.
 */
export function journalingGate(
  inner: WriteGate,
  deps: { readonly journal: Journal },
): WriteGate {
  return {
    get outstandingPlans(): number {
      return inner.outstandingPlans;
    },

    async execute(call: WriteGateCall): Promise<ToolResult<unknown>> {
      // Reads never journal, and wrapping their seam would only add a frame.
      if (call.tool.writeTier === undefined) return inner.execute(call);

      let executed: ExecutedWrite | undefined;
      const observing: JiraRequestFn = async <T = unknown>(
        req: JiraRequestSpec,
      ): Promise<JiraResponse<T>> => {
        if (!isMutation(req)) return call.jira<T>(req);
        try {
          const response = await call.jira<T>(req);
          executed ??= { httpStatus: response.status };
          return response;
        } catch (error) {
          executed ??= { httpStatus: httpStatusOf(error) };
          throw error;
        }
      };

      const record = (
        write: ExecutedWrite,
        outcome: boolean,
        result?: ToolResult<unknown>,
      ): Promise<JournalStatus> => {
        const issueKey = issueKeyOf(call.args, result);
        return deps.journal.append({
          // The registry runs the whole call inside `runWithCid`, so the ambient
          // id is this call's — the same one every http and retry event carries.
          // `NO_CID` is unreachable through the registry and exists so a direct
          // gate test still produces a well-formed line.
          cid: currentCid() ?? NO_CID,
          tool: call.tool.name,
          // The plan binding doubles as the journal's `argsHash`: one canonical
          // hash of (tool, profile, normalized args), already proven stable
          // enough to gate an apply, and structurally incapable of a value.
          argsHash: planFingerprint(call.tool.name, call.args, call.control.profile),
          ok: outcome,
          ...(write.httpStatus === undefined ? {} : { httpStatus: write.httpStatus }),
          ...(issueKey === undefined ? {} : { issueKey }),
        });
      };

      let result: ToolResult<unknown>;
      try {
        result = await inner.execute({ ...call, jira: observing });
      } catch (error) {
        // The handler propagated a failure — the registry above renders it into
        // an envelope. If the mutation had already left the process, the request
        // still happened, and that is precisely what the journal records. The
        // error is re-thrown untouched: journaling never changes an outcome, and
        // a failed append here has no envelope left to hint on.
        if (executed !== undefined) await record(executed, false);
        throw error;
      }
      if (executed === undefined) return result;

      const status = await record(executed, result.ok, result);

      // CC-33: a failed append is a hint, never a failed tool. Telling the model
      // a completed write failed would make it retry a mutation that succeeded.
      return status === 'ok' ? result : withJournalHint(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Recently written issues (CC-02)
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link WriteGate} so every APPLIED write leaves its issue ids in the
 * session registry, where `jira_search` picks them up as `reconcileIssues`.
 *
 * The detection is {@link journalingGate}'s, for the same reason: only the
 * request seam can tell an applied write from a plan-mode capture, a refused
 * apply or a handler that failed before sending anything. A plan-mode call never
 * reaches this observer at all — the gate's capturing seam is further in — which
 * is exactly the CC-02 rule that a plan must not pollute the registry with an
 * issue nothing touched.
 *
 * Two conditions, both necessary. The mutation must have LEFT THE PROCESS, and
 * the tool must have reported `ok`. A 4xx write is journaled (it was attempted)
 * but NOT recorded here: reconciling an id whose write was rejected only costs
 * the next search work for nothing, and the registry is meant to say "this
 * exists but the index may not know yet".
 *
 * Recording never changes an outcome: the result travels through untouched, a
 * throw is not caught, and an id that cannot be determined is simply not
 * recorded (see {@link writtenIssueIds}).
 */
export function recordingGate(
  inner: WriteGate,
  deps: { readonly recent: RecentWrites; readonly clock?: Clock },
): WriteGate {
  return {
    get outstandingPlans(): number {
      return inner.outstandingPlans;
    },

    async execute(call: WriteGateCall): Promise<ToolResult<unknown>> {
      // An irreversible write deletes or bulk-enqueues: the ids it names are
      // gone, or not written yet, and a bulk batch of them would evict the
      // real recent writes from the 50-id registry (CC-192).
      if (call.tool.writeTier === undefined || call.tool.writeTier === 'irreversible') {
        return inner.execute(call);
      }

      let executed = false;
      const observing: JiraRequestFn = async <T = unknown>(
        req: JiraRequestSpec,
      ): Promise<JiraResponse<T>> => {
        if (isMutation(req)) executed = true;
        return call.jira<T>(req);
      };

      let result: ToolResult<unknown>;
      try {
        result = await inner.execute({ ...call, jira: observing });
      } catch (error) {
        // A handler that lets its JiraError escape (the registry's catch-all
        // turns it into the envelope) is judged the same way.
        if (executed && isJiraError(error) && wasApplied({ ok: false, error })) {
          deps.recent.record(writtenIssueIds(call.args), deps.clock?.now());
        }
        throw error;
      }
      if (executed && wasApplied(result))
        deps.recent.record(writtenIssueIds(call.args, result), deps.clock?.now());
      return result;
    },
  };
}

/**
 * Whether Jira accepted the write. A success, or an `ambiguous_write` that
 * carries a 2xx: Jira said yes and only the reply body was lost (CC-205), so
 * the ids the arguments name are as written as any success's (CC-221). An
 * ambiguous write with no status may or may not have landed and stays out.
 */
function wasApplied(result: {
  readonly ok: boolean;
  readonly error?: { readonly kind: string; readonly httpStatus?: number };
}): boolean {
  if (result.ok) return true;
  const status = result.error?.httpStatus;
  return (
    result.error?.kind === 'ambiguous_write' &&
    status !== undefined &&
    status >= 200 &&
    status < 300
  );
}
