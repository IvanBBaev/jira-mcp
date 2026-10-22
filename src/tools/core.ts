// ---------------------------------------------------------------------------
// Package `core` — TOOLS.md §Package `core`.
//
// Three tools, and they answer the questions every session starts with: "what
// is this server?" (`jira_capabilities`, local), "who am I on it?"
// (`jira_get_myself`, one GET) and, since D122, "what may I do here?"
// (`jira_get_my_permissions`, one GET). The package is ALWAYS registered — a
// deny list force-re-adds it (CC-29) — because a session that lost its other
// tools needs something left to ask why.
//
// WHY THIS MODULE EXPORTS A FACTORY AND NOT A CONSTANT. `jira_capabilities`
// describes the registry that contains `jira_capabilities`. That circle is
// resolved by injection, not by reaching for a global: the composition root
// (WP-40) hands in a {@link CapabilitiesInfo}, or a thunk returning one when the
// value is only known after the registry is built. The tool ring therefore
// stays free of server state, and the manifest stays testable with a literal.
//
// COUNTERS (D12). OBSERVABILITY.md §Counters puts the in-process telemetry
// counters (requests, retries, rate-limit waits, errors by kind) in
// `jira_capabilities` output and the doctor report — those two places and
// nowhere else. They arrive exactly as predicted: one more OPTIONAL field on
// `CapabilitiesInfo`, filled in by the composition root's thunk, with no change
// to the tool, its schema or its description. Optional because a report
// assembled without a `Telemetry` (a test, a manifest literal) is still a valid
// report.
//
// Layering: `core ← api ← mcp ← tools`. Tools are the composition root.
// ---------------------------------------------------------------------------

import { MAX_PERMISSION_KEYS, type PermissionCheck } from '../api/permissions.js';
import type { MyselfResult } from '../api/users.js';
import type { Counters } from '../core/telemetry.js';
import type { TransportKind, WriteMode } from '../core/types.js';
import { defineTool, toolInput, z } from '../mcp/define.js';
import { errorResult } from '../mcp/errors.js';
import { ok } from '../mcp/result.js';
import type { ExclusionReason } from '../mcp/registry.js';
import {
  LOCAL_READ_ANNOTATIONS,
  READ_ANNOTATIONS,
  callBase,
  guarded,
} from '../mcp/tool-helpers.js';
import type {
  PackageId,
  PackageSpec,
  ToolResult,
  ToolSpec,
  WriteTier,
} from '../mcp/types.js';

// ---------------------------------------------------------------------------
// What `jira_capabilities` reports
// ---------------------------------------------------------------------------

/**
 * One tool as `jira_capabilities` lists it: enough for a model to decide whether
 * to call it, not the whole `ToolSpec` (a schema per tool would blow the result
 * budget, and `tools/list` already carries the schemas).
 */
export interface CapabilityTool {
  readonly name: string;
  readonly title: string;
  readonly package: PackageId;
  /** `annotations.readOnlyHint` — a false here means the plan/apply gate applies. */
  readonly readOnly: boolean;
  /** Present iff the tool writes; mirrors `ToolSpec.writeTier`. */
  readonly writeTier?: WriteTier;
}

/** One enabled package with the tools that survived the gating triple. */
export interface CapabilityPackage {
  readonly id: PackageId;
  readonly title: string;
  readonly description: string;
  readonly tools: readonly CapabilityTool[];
}

/**
 * A manifest tool this configuration made uncallable, and why (CC-29). Reported
 * because "the tool you remember is gone" and "the tool never existed" need
 * different fixes, and only the server can tell them apart.
 */
export interface CapabilityExclusion {
  readonly name: string;
  readonly reason: ExclusionReason;
}

/** The per-call limits a model can actually act on (narrow a request, page). */
export interface CapabilityLimits {
  /** `JIRA_MAX_RESULT_CHARS` — the truncation budget one result gets. */
  readonly maxResultChars: number;
  /** `JIRA_MAX_PAGES` — the loop guard on sweeping reads. */
  readonly maxPages: number;
  /** `JIRA_REQUEST_TIMEOUT_MS`. */
  readonly requestTimeoutMs: number;
  /** `JIRA_CALL_BUDGET_MS` — total HTTP time one tool call may spend. */
  readonly callBudgetMs: number;
}

/**
 * Everything `jira_capabilities` returns — assembled by the composition root
 * (WP-40) from the settings and the built registry, never read out of a global
 * here.
 *
 * INVENTED SHAPE (WP-30): TOOLS.md names the contents ("registered
 * packages/tools, active profile, write mode, site") but not the field names.
 * This interface is that list plus three additions each earning its place:
 * `limits` (a model that knows the budget narrows its own request instead of
 * being truncated), `excludedTools` (CC-29's whole point), and `version`
 * (OBSERVABILITY.md §Startup requires the version to be visible here).
 *
 * Secrets are structurally absent: no token, no email, no profile credentials —
 * `site` is the only place a host name appears.
 */
export interface CapabilitiesInfo {
  /** npm package name of this server (`jira-mcp-ai`). */
  readonly serverName: string;
  /** Server version, as in `server_start` and the startup line. */
  readonly version: string;
  /** The Jira site this process talks to; absent when unconfigured. */
  readonly site?: string;
  /**
   * Present only on Jira Data Center (D106): the adapter serving this server is
   * a preview (reads, and writes since D109) never verified against a Data Center
   * instance. Absent on Cloud, whose report is unchanged.
   */
  readonly deployment?: {
    readonly product: 'datacenter';
    readonly verified: false;
    readonly note: string;
  };
  readonly transport: TransportKind;
  /** `plan` (default) or `apply` — the write gate a write tool will meet. */
  readonly writeMode: WriteMode;
  /** The profile used when a call names none; absent when only defaults exist. */
  readonly activeProfile?: string;
  /** `JIRA_LOCK_PROFILE` — when true, a `profile` argument is rejected (O-6). */
  readonly profileLocked: boolean;
  /** Enabled packages in manifest order, each holding only its enabled tools. */
  readonly packages: readonly CapabilityPackage[];
  /** Manifest tools gated out here (CC-29). Omitted from the payload when empty. */
  readonly excludedTools?: readonly CapabilityExclusion[];
  readonly limits: CapabilityLimits;
  /** Whether executed writes are being journaled (`JIRA_JOURNAL_PATH`). */
  readonly journalEnabled: boolean;
  /**
   * In-process counters since startup (D12) — requests, retries, rate-limit
   * waits and errors by kind. Absent when the report was assembled without a
   * `Telemetry`; a live server always has one, and the thunk re-reads it on
   * every call, so what a model sees is the current value, not a startup
   * snapshot. Zeros are meaningful: nothing has reached Jira yet.
   */
  readonly counters?: Counters;
}

/**
 * How the composition root supplies the report: eagerly, or as a thunk
 * evaluated per call. The thunk exists for the circle described at the top of
 * this file — and it is re-read on every call, so a value that changes at
 * runtime (counters, D12) needs no further plumbing.
 */
export type CapabilitiesSource = CapabilitiesInfo | (() => CapabilitiesInfo);

/** Read the source and drop an empty exclusion list — never report `[]`. */
function snapshot(source: CapabilitiesSource): CapabilitiesInfo {
  const { excludedTools, ...info } = typeof source === 'function' ? source() : source;
  return excludedTools !== undefined && excludedTools.length > 0
    ? { ...info, excludedTools }
    : info;
}

// ---------------------------------------------------------------------------
// jira_capabilities
// ---------------------------------------------------------------------------

const capabilitiesInput = toolInput({});

/**
 * Build the `jira_capabilities` tool over `source`.
 *
 * The handler is deliberately NOT `async`: it performs no I/O, and an `async`
 * function with nothing to await is a lie about its cost (and an eslint error
 * under `require-await`). That is also why it does not use `guarded` — the
 * shared catch site is for the network calls of every other tool, and here the
 * only thing that can throw is the injected thunk. A thunk that blows up becomes
 * an error envelope like any other failure, which is safe precisely because this
 * tool performs no write and can therefore never swallow a plan capture.
 */
export function capabilitiesTool(
  source: CapabilitiesSource,
): ToolSpec<{ profile?: string }, CapabilitiesInfo> {
  return defineTool({
    name: 'jira_capabilities',
    title: 'Describe this server',
    description:
      'Describe this server without calling Jira: the packages and tools that are ' +
      'registered, the site, the active profile, the write mode (plan vs apply) and ' +
      'the per-call limits. Local only — no network, no permissions. Call it first ' +
      'when a tool name, a package or the write mode is unclear, and when a tool you ' +
      'expected is missing: excludedTools names what this configuration gated out.',
    package: 'core',
    // The one tool that touches no external system (TOOLS.md §Annotations).
    annotations: LOCAL_READ_ANNOTATIONS,
    input: capabilitiesInput,
    handler: (): Promise<ToolResult<CapabilitiesInfo>> => {
      try {
        // Metadata only — nothing here is Jira free text, so no D15 brand.
        return Promise.resolve(ok(snapshot(source)));
      } catch (error) {
        return Promise.resolve(errorResult(error));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// jira_get_myself
// ---------------------------------------------------------------------------

/**
 * The authenticated identity, narrowed. `emailAddress` is dropped on purpose:
 * TOOLS.md §Read shaping allows an address only out of `jira_search_users` with
 * `includeEmail: true`, and a tool that never offers one has no masking to
 * report either — hence no `email_hidden` hint here (CC-19 belongs to the user
 * search). `timeZone` survives because worklog timestamps are written in it
 * (D16).
 */
export interface MyselfData {
  /**
   * The only identity Jira Cloud accepts on a write — there are no usernames.
   * Always present on Cloud; absent on Data Center, which reports `name` and
   * `key` instead (D106).
   */
  readonly accountId?: string;
  /** Data Center login name. Absent on Cloud. */
  readonly name?: string;
  /** Data Center user key, stable across renames. Absent on Cloud. */
  readonly key?: string;
  readonly displayName?: string;
  readonly active?: boolean;
  /** `atlassian`, `app`, `customer` — a customer account is a JSM portal user. */
  readonly accountType?: string;
  /** IANA zone of the account; the offset worklog `started` values carry (D16). */
  readonly timeZone?: string;
  readonly locale?: string;
}

/** Absent keys are omitted rather than set to `undefined` (envelope hygiene). */
function myselfData(user: MyselfResult['user']): MyselfData {
  if (!('accountId' in user)) {
    return {
      ...(user.name === undefined ? {} : { name: user.name }),
      ...(user.key === undefined ? {} : { key: user.key }),
      ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
      ...(user.active === undefined ? {} : { active: user.active }),
      ...(user.timeZone === undefined ? {} : { timeZone: user.timeZone }),
      ...(user.locale === undefined ? {} : { locale: user.locale }),
    };
  }
  return {
    accountId: user.accountId,
    ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
    ...(user.active === undefined ? {} : { active: user.active }),
    ...(user.accountType === undefined ? {} : { accountType: user.accountType }),
    ...(user.timeZone === undefined ? {} : { timeZone: user.timeZone }),
    ...(user.locale === undefined ? {} : { locale: user.locale }),
  };
}

const getMyselfInput = toolInput({});

export const getMyselfTool = defineTool({
  name: 'jira_get_myself',
  title: 'Get authenticated user',
  description:
    'Verify the configured credentials and return the account they belong to: ' +
    'accountId, displayName, active, accountType, timeZone and locale. The ' +
    'accountId is the identity every write is attributed to — Jira has no ' +
    'usernames — and the timeZone is the offset worklog timestamps are written ' +
    'in. Email is never returned; resolve people with jira_search_users. A 401 ' +
    'here means the credentials are wrong, not the request.',
  package: 'core',
  annotations: READ_ANNOTATIONS,
  input: getMyselfInput,
  handler: async (_args, ctx): Promise<ToolResult<MyselfData>> =>
    guarded(async () => {
      const myself = await ctx.api.getMyself(callBase(ctx));
      // An account record is metadata, not Jira free text: no D15 brand.
      return ok(myselfData(myself.user));
    }),
});

// ---------------------------------------------------------------------------
// jira_get_my_permissions (D122)
// ---------------------------------------------------------------------------

/**
 * One permission check, as answered. `granted` is Jira's verdict for the
 * scope the call named; a key Jira did not answer is never here — it is in
 * {@link MyPermissionsData.unanswered} instead (CC-1401).
 */
export interface MyPermissionData {
  readonly key: string;
  readonly granted: boolean;
  /** Jira's display name for the permission, when it sent one. */
  readonly name?: string;
  /** `GLOBAL` or `PROJECT` — which scope the permission is evaluated in. */
  readonly type?: string;
}

/**
 * The result of `jira_get_my_permissions`. `context` names the scope the check
 * ran in, and only the most specific one given is echoed back (CC-1403), so a
 * caller can see at a glance whether `granted` means "on this issue", "in
 * this project" or "somewhere on the site".
 */
export interface MyPermissionsData {
  readonly context: 'global' | 'project' | 'issue';
  /** The project key or id the check ran against (`context: 'project'`). */
  readonly project?: string;
  /** The issue key or id the check ran against (`context: 'issue'`). */
  readonly issue?: string;
  readonly permissions: readonly MyPermissionData[];
  /**
   * Keys Jira did not answer at all — present only when non-empty. Not the
   * same as denied: a missing answer is a question Jira did not take, not a
   * verdict (CC-1401).
   */
  readonly unanswered?: readonly string[];
}

const getMyPermissionsInput = toolInput({
  permissions: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_PERMISSION_KEYS)
    .describe(
      'Permission keys to check, one per entry (not a comma-separated string), at ' +
        `most ${String(MAX_PERMISSION_KEYS)}. Common keys: BROWSE_PROJECTS, ` +
        'CREATE_ISSUES, EDIT_ISSUES, TRANSITION_ISSUES, ADD_COMMENTS, ' +
        'WORK_ON_ISSUES, DELETE_ISSUES, ADMINISTER_PROJECTS, BULK_CHANGE, ' +
        'ADMINISTER. Keys Jira does not know make the whole call fail.',
    ),
  issue: z
    .string()
    // Trimmed so a blank scope is refused here rather than silently widening
    // the check to the whole site (CC-560, CC-1400).
    .trim()
    .min(1)
    .optional()
    .describe(
      'Issue key or id to check the permissions ON. Wins over `project` when both ' +
        'are given: only the most specific scope is sent.',
    ),
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Project key or id to check the permissions IN. Without `issue` and ' +
        '`project` a project permission reads granted if the account holds it in ' +
        'ANY project.',
    ),
});

/** Absent keys are omitted rather than set to `undefined` (envelope hygiene). */
function permissionData(check: PermissionCheck): MyPermissionData {
  return {
    key: check.key,
    granted: check.granted,
    ...(check.name === undefined ? {} : { name: check.name }),
    ...(check.type === undefined ? {} : { type: check.type }),
  };
}

export const getMyPermissionsTool = defineTool({
  name: 'jira_get_my_permissions',
  title: 'Check my permissions',
  description:
    'Check whether the configured account holds the named permissions globally, ' +
    'in a project or on one issue, before a write. Each key comes back granted ' +
    'true or false; a key Jira did not answer is listed under unanswered, never ' +
    'reported as denied. `issue` wins over `project`; with neither, a project ' +
    'permission is granted if held in any project. Common keys: BROWSE_PROJECTS, ' +
    'CREATE_ISSUES, EDIT_ISSUES, TRANSITION_ISSUES, ADD_COMMENTS, WORK_ON_ISSUES, ' +
    'DELETE_ISSUES, ADMINISTER_PROJECTS, BULK_CHANGE.',
  package: 'core',
  annotations: READ_ANNOTATIONS,
  input: getMyPermissionsInput,
  handler: async (args, ctx): Promise<ToolResult<MyPermissionsData>> =>
    guarded(async () => {
      const result = await ctx.api.getMyPermissions({
        ...callBase(ctx),
        permissions: args.permissions,
        ...(args.project === undefined ? {} : { projectKey: args.project }),
        ...(args.issue === undefined ? {} : { issueKey: args.issue }),
      });
      // Permission verdicts are metadata, not Jira free text: no D15 brand.
      return ok({
        context: result.context,
        ...(result.projectKey === undefined ? {} : { project: result.projectKey }),
        ...(result.issueKey === undefined ? {} : { issue: result.issueKey }),
        permissions: result.permissions.map(permissionData),
        ...(result.unanswered.length === 0 ? {} : { unanswered: result.unanswered }),
      });
    }),
});

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

/**
 * The `core` package as the `PACKAGES` manifest (WP-40) declares it. A function
 * rather than a constant because `jira_capabilities` needs the report the
 * composition root assembles; pass a thunk when the report depends on the
 * registry this package ends up in.
 *
 * Tool order is TOOLS.md's table order, which is also the order
 * `jira_capabilities` and the README table render.
 */
export function corePackage(source: CapabilitiesSource): PackageSpec {
  return {
    id: 'core',
    title: 'Core',
    description:
      'Server self-description, credential and permission checks — always ' +
      'registered, even when every other package is denied.',
    tools: [capabilitiesTool(source), getMyselfTool, getMyPermissionsTool],
  };
}
