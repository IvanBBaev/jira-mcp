// ---------------------------------------------------------------------------
// The tool registry: package gating and the per-call boundary
// (ARCHITECTURE.md §Package gating and write safety, CONFIGURATION.md §Tool
// surface gating, OBSERVABILITY.md §Log events, CC-29).
//
// Two jobs, both of them boundaries.
//
// GATING. The exposed tool surface is decided once, at construction, from three
// env knobs applied in a fixed order: `JIRA_TOOL_PACKAGES` selects (a profile or
// an explicit list), `JIRA_PACKAGES_DENY` subtracts and always wins, and
// `JIRA_PACKAGES_READONLY` drops the write-tier tools of the packages it names.
// `core` is then force-re-added (CC-29): capabilities and doctor must exist even
// in a configuration that denied everything, and `core/settings.ts` only WARNS
// about denying it — the enforcement is here, because the registry is what
// actually builds the surface.
//
// THE CALL BOUNDARY. Every tool call goes through `call()`, which is the only
// place a handler runs. It mints the correlation id, runs the whole call inside
// `runWithCid`, validates the arguments, splits the control fields off, hands
// the write gate a substituted `jira` seam, renders both channels of the result
// through the redactor, and turns ANY throw into a complete `ok: false`
// envelope. A handler that throws is a bug, not a protocol event: the model must
// still receive an envelope it can read, and the diagnosis belongs in a stderr
// event keyed by the same cid.
//
// `tools` carries the gated specs as metadata for `tools/list`; their handlers
// are never invoked directly (`defineTool` freezes a spec, so the wrapper cannot
// be installed onto it — `call()` IS the wrapper).
//
// Layering: `core ← api ← mcp ← tools`. No zod import (schemas arrive already
// built on the spec), no SDK.
// ---------------------------------------------------------------------------

import { isJiraError, toLogFields } from '../core/errors.js';
import { newCorrelationId, runWithCid } from '../core/log.js';
import { JiraError } from '../core/types.js';
import type {
  Clock,
  ErrorRecord,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
  LogFields,
  Logger,
  Redactor,
  Rng,
  Settings,
} from '../core/types.js';
import { UNEXPECTED_THROW_KIND, errorResult, errorResultOf } from './errors.js';
import { renderResult } from './result.js';
import type { RenderedResult } from './result.js';
import { PACKAGE_IDS, PACKAGE_PROFILES } from './types.js';
import type {
  AnyToolSpec,
  PackageId,
  PackageProfile,
  PackageSpec,
  ToolCtx,
  ToolResult,
} from './types.js';
import {
  PLAN_NOTICE_LINE,
  createWriteGate,
  isPlanResult,
  splitControlFields,
} from './write-mode.js';
import type { WriteGate } from './write-mode.js';

// ---------------------------------------------------------------------------
// Selection vocabulary
// ---------------------------------------------------------------------------

/**
 * What each `JIRA_TOOL_PACKAGES` profile expands to (CONFIGURATION.md).
 *
 * `reader` is documented as "core + search + issues + meta + users + agile
 * reads". Gating is package-granular and `agile` carries a write tool, so the
 * only way to honour "reads" is to treat the whole `reader` selection as
 * read-only — which is also the fail-safe direction for a profile whose name
 * promises exactly that.
 */
export const PROFILE_PACKAGES: Readonly<Record<PackageProfile, readonly PackageId[]>> = {
  core: ['core'],
  reader: ['core', 'search', 'issues', 'meta', 'users', 'agile'],
  all: PACKAGE_IDS,
};

/** The `JIRA_TOOL_PACKAGES` profile that implies a read-only surface. */
const READONLY_PROFILE: PackageProfile = 'reader';

/** Denying this away is not possible — capabilities/doctor must always exist. */
const ALWAYS_ON: PackageId = 'core';

function isPackageId(token: string): token is PackageId {
  return (PACKAGE_IDS as readonly string[]).includes(token);
}

function isPackageProfile(token: string): token is PackageProfile {
  return (PACKAGE_PROFILES as readonly string[]).includes(token);
}

function selectionError(envVar: string, token: string): JiraError {
  return new JiraError({
    kind: 'config',
    message: `${envVar} names "${token}", which is not a known package or profile.`,
    retryable: false,
    remediation:
      `Use a profile (${PACKAGE_PROFILES.join(', ')}) or a comma list of packages ` +
      `(${PACKAGE_IDS.join(', ')}).`,
  });
}

/**
 * Expand raw env tokens into package ids. Profiles and package ids share one
 * namespace on purpose (`core` is both), so a token is resolved as a profile
 * first and as a package second — the two agree wherever they overlap.
 *
 * An unknown token fails the process. A silently ignored one would hand the
 * operator a surface they did not ask for and believe they had restricted.
 */
export function expandSelection(
  tokens: readonly string[],
  envVar: string,
): Set<PackageId> {
  const out = new Set<PackageId>();
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (token === '') continue;
    if (isPackageProfile(token)) {
      for (const id of PROFILE_PACKAGES[token]) out.add(id);
      continue;
    }
    if (isPackageId(token)) {
      out.add(token);
      continue;
    }
    throw selectionError(envVar, token);
  }
  return out;
}

/** Why a manifest tool is not callable in this configuration. */
export type ExclusionReason = 'package_disabled' | 'readonly';

/** The gated surface, plus enough detail to explain a refusal. */
export interface PackageSelection {
  /** Enabled packages in canonical order, each holding only its enabled tools. */
  readonly packages: readonly PackageSpec[];
  readonly enabledPackages: readonly PackageId[];
  /** Manifest tools that are NOT callable here, keyed by tool name. */
  readonly excludedTools: ReadonlyMap<string, ExclusionReason>;
}

function assertManifest(manifest: readonly PackageSpec[]): void {
  const seenPackages = new Set<string>();
  const seenTools = new Set<string>();
  for (const pkg of manifest) {
    if (seenPackages.has(pkg.id)) {
      throw new JiraError({
        kind: 'config',
        message: `The tool manifest declares package "${pkg.id}" twice.`,
        retryable: false,
        remediation: 'Each package appears once in the PACKAGES manifest.',
      });
    }
    seenPackages.add(pkg.id);
    for (const tool of pkg.tools) {
      if (seenTools.has(tool.name)) {
        throw new JiraError({
          kind: 'config',
          message: `The tool manifest declares tool "${tool.name}" twice.`,
          retryable: false,
          remediation: 'Tool names are globally unique across packages.',
        });
      }
      seenTools.add(tool.name);
    }
  }
}

/**
 * Apply the gating triple. Order is normative: select → deny (wins) → force
 * `core` back in (CC-29) → drop write-tier tools of the read-only packages.
 *
 * A selected package the manifest does not carry is skipped rather than fatal:
 * packages land incrementally and the default selection is `all`, so failing
 * here would make the default configuration unbootable until the last package
 * exists.
 */
export function selectPackages(
  manifest: readonly PackageSpec[],
  settings: Settings,
): PackageSelection {
  assertManifest(manifest);

  const selected = expandSelection(settings.toolPackages, 'JIRA_TOOL_PACKAGES');
  for (const denied of expandSelection(settings.packagesDeny, 'JIRA_PACKAGES_DENY')) {
    selected.delete(denied);
  }
  selected.add(ALWAYS_ON);

  const readOnly = expandSelection(settings.packagesReadonly, 'JIRA_PACKAGES_READONLY');
  const readerProfile = settings.toolPackages.some(
    (token) => token.trim().toLowerCase() === READONLY_PROFILE,
  );

  const excludedTools = new Map<string, ExclusionReason>();
  const packages: PackageSpec[] = [];

  for (const id of PACKAGE_IDS) {
    const pkg = manifest.find((candidate) => candidate.id === id);
    if (pkg === undefined) continue;

    if (!selected.has(id)) {
      for (const tool of pkg.tools) excludedTools.set(tool.name, 'package_disabled');
      continue;
    }

    const stripWrites = readerProfile || readOnly.has(id);
    const tools = pkg.tools.filter((tool) => {
      const drop = stripWrites && tool.writeTier !== undefined;
      if (drop) excludedTools.set(tool.name, 'readonly');
      return !drop;
    });
    packages.push({ ...pkg, tools });
  }

  return {
    packages,
    enabledPackages: packages.map((pkg) => pkg.id),
    excludedTools,
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface RegistryDeps {
  readonly settings: Settings;
  /** The real request function; `core/http.ts` in production. */
  readonly jira: JiraRequestFn;
  /** Root logger; every call runs against a `withCid` child. */
  readonly logger: Logger;
  readonly clock: Clock;
  /** Source of correlation ids and plan ids. */
  readonly rng: Rng;
  /** Redaction choke point, applied to every rendered result. */
  readonly redactor: Redactor;
  /** Injectable for tests; built from `settings.writeMode` otherwise. */
  readonly gate?: WriteGate | undefined;
}

/** Per-call inputs the transport knows and the registry does not. */
export interface CallOptions {
  /** Cancellation forwarded from the MCP request. */
  readonly signal?: AbortSignal | undefined;
}

export interface ToolRegistry {
  /** Enabled packages, canonical order, each holding only its enabled tools. */
  readonly packages: readonly PackageSpec[];
  /** Enabled tools, flattened — the `tools/list` surface. */
  readonly tools: readonly AnyToolSpec[];
  readonly enabledPackages: readonly PackageId[];
  /** Manifest tools this configuration gated out, keyed by name. */
  readonly excludedTools: ReadonlyMap<string, ExclusionReason>;
  has(name: string): boolean;
  get(name: string): AnyToolSpec | undefined;
  /** Run one tool call. Never throws: a failure is always a rendered envelope. */
  call(name: string, args: unknown, options?: CallOptions): Promise<RenderedResult>;
}

/** Bind a per-call profile onto every request the handler issues. */
function withProfile(inner: JiraRequestFn, profile: string): JiraRequestFn {
  return <T = unknown>(req: JiraRequestSpec): Promise<JiraResponse<T>> =>
    inner<T>(req.profile === undefined ? { ...req, profile } : req);
}

/**
 * The log-safe projection of an `ErrorRecord`, mirroring `toLogFields` for the
 * case where the failure never was a thrown `JiraError` (a handler returned
 * `ok: false`). Same three keys, same CC-15 never-log guarantee: no message, no
 * detail, no Jira text.
 */
function recordLogFields(record: ErrorRecord): LogFields {
  return {
    errorKind: record.kind,
    retryable: record.retryable,
    ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
  };
}

function throwLogFields(error: unknown): LogFields {
  return isJiraError(error)
    ? toLogFields(error)
    : { errorKind: UNEXPECTED_THROW_KIND, retryable: false };
}

/** Bound the noise of a schema refusal without swallowing the actionable part. */
const MAX_REPORTED_ISSUES = 8;

function validationResult(
  toolName: string,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): ToolResult<never> {
  const listed = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => {
      const at = issue.path.map((segment) => String(segment)).join('.');
      return `${at === '' ? '(root)' : at}: ${issue.message}`;
    })
    .join('; ');
  const more =
    issues.length > MAX_REPORTED_ISSUES
      ? ` (+${String(issues.length - MAX_REPORTED_ISSUES)} more)`
      : '';
  return errorResultOf(
    'validation',
    `Arguments rejected by the schema of ${toolName}: ${listed}${more}.`,
    {
      retryable: false,
      remediation:
        'Fix the listed fields and call again; the schema is strict, so an ' +
        'unrecognized key is an error rather than an ignored extra.',
    },
  );
}

/**
 * Two error kinds are raised deep in `core/http.ts`, which knows the route but
 * not the tool. OBSERVABILITY.md requires the tool name on both, and this
 * boundary is the only place that has it — `ErrorRecord` has no `tool` field, so
 * the name rides in `message`, appended once and idempotently.
 */
const TOOL_ENRICHED_KINDS = new Set(['budget_exceeded', 'ambiguous_write']);

function enrichWithToolName(
  result: ToolResult<unknown>,
  toolName: string,
): ToolResult<unknown> {
  const record = result.error;
  if (record === undefined || !TOOL_ENRICHED_KINDS.has(record.kind)) return result;
  const marker = `Tool: ${toolName}.`;
  if (record.message.includes(marker)) return result;
  return {
    ...result,
    error: { ...record, message: `${record.message} ${marker}` },
  };
}

export function createRegistry(
  manifest: readonly PackageSpec[],
  deps: RegistryDeps,
): ToolRegistry {
  const { settings } = deps;
  const selection = selectPackages(manifest, settings);
  const gate =
    deps.gate ??
    createWriteGate({
      writeMode: settings.writeMode,
      allowIrreversible: settings.allowIrreversible,
      rng: deps.rng,
      redact: (value: unknown) => deps.redactor.redact(value),
    });

  const tools: AnyToolSpec[] = [];
  const byName = new Map<string, AnyToolSpec>();
  for (const pkg of selection.packages) {
    for (const tool of pkg.tools) {
      tools.push(tool);
      byName.set(tool.name, tool);
    }
  }

  const renderOptions = {
    maxResultChars: settings.maxResultChars,
    redact: (value: unknown) => deps.redactor.redact(value),
  };

  const render = (result: ToolResult<unknown>): RenderedResult => {
    try {
      return renderResult(result, renderOptions);
    } catch (error) {
      // Rendering a result that cannot be serialized must still produce a
      // result. The fallback carries only fixed texts, so redacting the string
      // is belt-and-braces rather than the mechanism.
      const fallback = errorResult(error);
      return {
        structuredContent: fallback,
        text: deps.redactor.redactString(JSON.stringify(fallback) ?? '{}'),
        truncated: false,
      };
    }
  };

  /** The envelope for a name this configuration does not serve. */
  const unavailable = (name: string): ToolResult<never> => {
    const reason = selection.excludedTools.get(name);
    if (reason === 'readonly') {
      return errorResultOf(
        'write_gated',
        `Tool "${name}" is a write tool in a read-only package ` +
          '(JIRA_PACKAGES_READONLY, or the reader profile). Nothing was sent to Jira.',
        {
          retryable: false,
          remediation:
            'Remove the package from JIRA_PACKAGES_READONLY (or widen ' +
            'JIRA_TOOL_PACKAGES beyond the reader profile) and restart the server, ' +
            'or use a read tool.',
        },
      );
    }
    if (reason === 'package_disabled') {
      return errorResultOf(
        'config',
        `Tool "${name}" exists but its package is not enabled on this server ` +
          '(JIRA_TOOL_PACKAGES / JIRA_PACKAGES_DENY).',
        {
          retryable: false,
          remediation:
            'Enable the package in JIRA_TOOL_PACKAGES (and remove it from ' +
            'JIRA_PACKAGES_DENY), then restart the server.',
        },
      );
    }
    return errorResultOf('not_found', `No tool named "${name}" is registered.`, {
      retryable: false,
      remediation: 'Call tools/list (or jira_capabilities) for the enabled surface.',
    });
  };

  const runTool = async (
    spec: AnyToolSpec,
    args: unknown,
    options: CallOptions,
    cid: string,
    log: Logger,
    startedAt: number,
  ): Promise<ToolResult<unknown>> => {
    const parsed = spec.input.safeParse(args);
    if (!parsed.success) return validationResult(spec.name, parsed.error.issues);

    const { control, rest } = splitControlFields(parsed.data);
    if (control.profile !== undefined && settings.lockProfile) {
      return errorResultOf(
        'config',
        'Per-call profile switching is disabled (JIRA_LOCK_PROFILE). The call named ' +
          'a profile, so it was refused instead of being run against the default ' +
          'tenant.',
        {
          retryable: false,
          remediation:
            'Drop the profile argument, or start the server with ' +
            'JIRA_LOCK_PROFILE=false and JIRA_ACTIVE_PROFILE set deliberately.',
        },
      );
    }

    const jira =
      control.profile === undefined ? deps.jira : withProfile(deps.jira, control.profile);
    const ctx = (seam: JiraRequestFn): ToolCtx => ({
      jira: seam,
      log,
      clock: deps.clock,
      cid,
      limits: {
        maxResultChars: settings.maxResultChars,
        maxPages: settings.maxPages,
      },
      deadlineAt: startedAt + settings.callBudgetMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return gate.execute({
      tool: spec,
      args: rest,
      control,
      jira,
      invoke: (seam: JiraRequestFn) => spec.handler(rest, ctx(seam)),
    });
  };

  return {
    packages: selection.packages,
    tools,
    enabledPackages: selection.enabledPackages,
    excludedTools: selection.excludedTools,

    has: (name: string): boolean => byName.has(name),
    get: (name: string): AnyToolSpec | undefined => byName.get(name),

    call: (
      name: string,
      args: unknown,
      options: CallOptions = {},
    ): Promise<RenderedResult> => {
      const cid = newCorrelationId(deps.rng);
      const log = deps.logger.withCid(cid);
      const startedAt = deps.clock.now();

      return runWithCid(cid, async (): Promise<RenderedResult> => {
        log.emit('tool_call_start', { tool: name });

        let result: ToolResult<unknown>;
        let thrown: unknown;
        const spec = byName.get(name);
        try {
          result =
            spec === undefined
              ? unavailable(name)
              : await runTool(spec, args, options, cid, log, startedAt);
        } catch (error) {
          // A handler that throws is a bug; the model still gets an envelope,
          // and the diagnosis lands on tool_call_end under this cid.
          thrown = error;
          result = errorResult(error);
        }

        result = enrichWithToolName(result, name);
        const rendered = render(result);
        const text = isPlanResult(result)
          ? `${PLAN_NOTICE_LINE}\n${rendered.text}`
          : rendered.text;

        const errorFields =
          thrown !== undefined
            ? throwLogFields(thrown)
            : rendered.structuredContent.error === undefined
              ? {}
              : recordLogFields(rendered.structuredContent.error);

        log.emit('tool_call_end', {
          tool: name,
          ok: result.ok,
          durationMs: deps.clock.now() - startedAt,
          ...(rendered.truncated ? { truncated: true } : {}),
          ...errorFields,
        });

        return { ...rendered, text };
      });
    },
  };
}
