// ---------------------------------------------------------------------------
// Server assembly (ARCHITECTURE.md §Dependency injection boundary, §MCP server
// style — D5; OBSERVABILITY.md §Write journal — CC-33).
//
// `buildServer` is PURE in the sense that matters here: it reads no environment,
// touches no process stream, opens no transport and performs no I/O. Everything
// it needs arrives as a parameter, including the tool MANIFEST — which is the
// whole reason this function can live in the mcp ring at all. Importing
// `src/tools` from here would invert the layering (`core ← api ← mcp ← tools`);
// injecting the manifest keeps the arrow pointing the right way, and it is what
// lets a test drive the real protocol with two fixture tools instead of the
// twenty-seven real ones.
//
// It also cannot live in `src/index.ts`: that module is import-free at module
// scope (a Node version guard has to run before any modern syntax is parsed),
// while `buildServer` is synchronous and needs its imports at call time.
//
// LOW-LEVEL `Server`, NOT `McpServer` (D5). `McpServer.registerTool` runs its own
// zod validation and throws `McpError` on a bad argument — which loses the
// `ToolResult` envelope, the hints and the remediation text, i.e. everything a
// model needs to fix its own call. With `setRequestHandler` the registry stays
// the single call boundary and every outcome is an envelope.
//
// THE JOURNAL IS WIRED HERE, AND ONLY HERE. `RegistryDeps` and `WriteGateDeps`
// have no `journal` seam (both are frozen-by-convention contracts owned by other
// work packages), but `RegistryDeps.gate` is injectable — so an executed write is
// detected where the truth actually is: at the request seam. See
// {@link journalingGate}.
// ---------------------------------------------------------------------------

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { isJiraError } from '../core/errors.js';
import { NO_CID, currentCid } from '../core/log.js';
import type {
  Clock,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  Journal,
  JournalStatus,
  Logger,
  Redactor,
  Rng,
  Settings,
} from '../core/types.js';
import { sessionRecentWrites, writtenIssueIds } from './recent-writes.js';
import type { RecentWrites } from './recent-writes.js';
import { createRegistry } from './registry.js';
import type { RenderedResult } from './result.js';
import type { ConnectableServer } from './transport.js';
import type { AnyToolSpec, PackageSpec, ToolResult } from './types.js';
import { createWriteGate, planFingerprint } from './write-mode.js';
import type { WriteGate, WriteGateCall } from './write-mode.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything the server needs, and nothing it could have discovered for itself.
 *
 * Declared here rather than in `mcp/types.ts` because that file is a frozen
 * contract shared with the api and tool rings, and this shape names the SDK's
 * neighbourhood (a manifest, a journal, a gate) that only the composition root
 * assembles.
 */
export interface BuildServerDeps {
  readonly settings: Settings;
  /**
   * The full `PACKAGES` manifest — ungated. `createRegistry` applies the gating
   * triple itself, and `jira_capabilities` needs to know what was excluded, so
   * the manifest must arrive whole.
   */
  readonly packages: readonly PackageSpec[];
  /** npm package name, reported in the MCP handshake. */
  readonly serverName: string;
  /** Server version, reported in the handshake and in `jira_capabilities`. */
  readonly version: string;
  /** The real request function (`core/http.ts`), or a fake in tests. */
  readonly jira: JiraRequestFn;
  /** Root logger (cid `-`); the registry derives a per-call child. */
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly clock: Clock;
  readonly rng: Rng;
  /** Present iff `JIRA_JOURNAL_PATH` is configured. Absent = journaling off. */
  readonly journal?: Journal | undefined;
  /** Injectable for tests; built from `settings.writeMode` otherwise. */
  readonly gate?: WriteGate | undefined;
  /**
   * CC-02 — where applied writes leave their issue ids for `jira_search` to
   * reconcile. Defaults to the ambient `sessionRecentWrites`, which is the
   * instance the search tool reads (`mcp/recent-writes.ts` explains why the read
   * side cannot be injected); a test passes its own to keep the session clean.
   */
  readonly recentWrites?: RecentWrites | undefined;
}

// ---------------------------------------------------------------------------
// SDK adapters
// ---------------------------------------------------------------------------

/** Convert one frozen {@link AnyToolSpec} into the SDK's `tools/list` shape. */
export function toMcpTool(spec: AnyToolSpec): Tool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: toJsonSchemaCompat(spec.input as AnyObjectSchema, {
      strictUnions: true,
      // The schema describes what a CALLER sends, so defaults and coercions are
      // rendered on their input side — an `output` rendering would advertise
      // fields the model is not allowed to pass.
      pipeStrategy: 'input',
    }) as Tool['inputSchema'],
    annotations: spec.annotations,
  };
}

/**
 * Project a {@link RenderedResult} onto the SDK's `CallToolResult`.
 *
 * Both channels carry the same envelope: `content` is the text rendering the
 * model reads (already carrying the plan notice or the taint banner when one
 * applies), `structuredContent` the byte-clean JSON a program reads. `isError`
 * mirrors `ok: false` — MCP's own failure flag, so a client that never looks
 * inside the envelope still knows the call did not succeed.
 *
 * The envelope is SPREAD into a fresh object: the SDK types
 * `structuredContent` as an index-signature record, and the rendered result is
 * a frozen interface value we do not want a consumer mutating in place.
 */
export function toCallToolResult(rendered: RenderedResult): CallToolResult {
  return {
    content: [{ type: 'text', text: rendered.text }],
    structuredContent: { ...rendered.structuredContent },
    ...(rendered.structuredContent.ok ? {} : { isError: true }),
  };
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
 * Only a request that actually left the process produces a line, which is
 * exactly what an audit trail must mean. A mutation that came back 4xx IS
 * journaled, with `ok: false` and its status: the request was made, and "was
 * this attempted?" is the question the journal exists to answer.
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
  deps: { readonly recent: RecentWrites },
): WriteGate {
  return {
    get outstandingPlans(): number {
      return inner.outstandingPlans;
    },

    async execute(call: WriteGateCall): Promise<ToolResult<unknown>> {
      if (call.tool.writeTier === undefined) return inner.execute(call);

      let executed = false;
      const observing: JiraRequestFn = async <T = unknown>(
        req: JiraRequestSpec,
      ): Promise<JiraResponse<T>> => {
        if (isMutation(req)) executed = true;
        return call.jira<T>(req);
      };

      const result = await inner.execute({ ...call, jira: observing });
      if (executed && result.ok) deps.recent.record(writtenIssueIds(call.args, result));
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Build a connectable MCP server from injected dependencies.
 *
 * Returns the SDK `Server` behind the structural {@link ConnectableServer}: the
 * caller chooses the transport (`mcp/transport.ts`), and nothing here assumes
 * one exists. Handler registration is complete before the function returns, so a
 * client that sends `initialize` and `tools/list` in the same tick cannot race
 * the wiring.
 */
export function buildServer(deps: BuildServerDeps): ConnectableServer {
  const { settings } = deps;

  const baseGate =
    deps.gate ??
    createWriteGate({
      writeMode: settings.writeMode,
      allowIrreversible: settings.allowIrreversible,
      rng: deps.rng,
      redact: (value: unknown) => deps.redactor.redact(value),
    });

  const journaled =
    deps.journal === undefined
      ? baseGate
      : journalingGate(baseGate, { journal: deps.journal });

  const registry = createRegistry(deps.packages, {
    settings,
    jira: deps.jira,
    logger: deps.logger,
    clock: deps.clock,
    rng: deps.rng,
    redactor: deps.redactor,
    // CC-02 outermost: it observes the result the journal may already have
    // hinted on, and journaling stays the last thing that can touch an envelope.
    gate: recordingGate(journaled, {
      recent: deps.recentWrites ?? sessionRecentWrites,
    }),
  });

  const server = new Server(
    { name: deps.serverName, version: deps.version },
    {
      capabilities: {
        // `listChanged` is honest rather than aspirational: the surface is fixed
        // at startup, so the server simply never sends the notification. What it
        // buys is a client that keeps the capability path open for the v1.5
        // profile switch, which does change the surface mid-session.
        tools: { listChanged: true },
        logging: {},
      },
    },
  );

  // Schemas are converted ONCE, here, not per `tools/list`: the manifest is
  // immutable, the conversion is pure, and a schema the SDK cannot render should
  // fail at startup rather than on a client's first request.
  const listed: readonly Tool[] = registry.tools.map(toMcpTool);

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...listed] }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // `registry.call` never throws — an unknown name, a schema refusal and a
    // handler bug all come back as rendered envelopes — so there is deliberately
    // no try/catch here to convert a throw into a bare protocol error.
    const rendered = await registry.call(
      request.params.name,
      request.params.arguments ?? {},
      // Client cancellation and request timeouts arrive on this signal; the
      // registry forwards it into `ToolCtx.signal` and thence to fetch.
      { signal: extra.signal },
    );
    return toCallToolResult(rendered);
  });

  return server;
}
