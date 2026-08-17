// ---------------------------------------------------------------------------
// The tool manifest — ARCHITECTURE.md §Tool definition contract.
//
// `PACKAGES` is the SINGLE SOURCE OF TRUTH for the tool surface. Four consumers
// read it and none of them keeps its own copy: server registration
// (`mcp/registry.ts` applies the gating triple to it), the structural snapshot
// test next door, the README generator (`scripts/generate-readme.mjs`), and —
// once it lands — `server.json`. A tool that is not in this list does not exist;
// a tool that is in it is documented, snapshotted and registered by construction.
//
// ORDER IS CONTRACT. Packages appear in TOOLS.md's package-table order, and
// tools within a package in that package's table order. `tools/list`, the README
// table and `jira_capabilities` all render in this order, so a reordering is
// visible in the snapshot diff rather than being silently absorbed.
//
// THE CAPABILITIES CIRCLE. `jira_capabilities` describes the registry that
// contains it, so `corePackage` takes the report by injection. Two exports fall
// out of that, and the difference matters:
//
//   - {@link createPackages} — the manifest BOUND to a report source. The
//     composition root passes a thunk closing over the report it assembles from
//     this very manifest; the thunk is only called at tool-call time, long after
//     the binding exists.
//   - {@link PACKAGES} — the same manifest with the report deliberately
//     UNBOUND. It is the structural constant: names, titles, packages, schemas,
//     annotations — everything a snapshot, a README table or a `server.json`
//     needs, none of which involves calling a handler. Calling
//     `jira_capabilities` on it yields a `config` error envelope explaining the
//     binding is missing, which is the honest answer and not a crash.
//
// Layering: tools are the composition root of the rings below them; nothing
// imports this module from `core`, `api` or `mcp`.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

import { JiraError } from '../core/types.js';
import type { Settings } from '../core/types.js';
import type { PackageSelection } from '../mcp/registry.js';
import type { PackageSpec } from '../mcp/types.js';
import { agilePackage } from './agile.js';
import { createAttachmentsPackage } from './attachments.js';
import { collabPackage } from './collab.js';
import { corePackage } from './core.js';
import type {
  CapabilitiesInfo,
  CapabilitiesSource,
  CapabilityExclusion,
  CapabilityLimits,
  CapabilityPackage,
  CapabilityTool,
} from './core.js';
import { issuesPackage } from './issues.js';
import { issuesDeletePackage } from './issues-delete.js';
import { issuesWritePackage } from './issues-write.js';
import { metaPackage } from './meta.js';
import { searchPackage } from './search.js';
import { usersPackage } from './users.js';

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

/** Used when `package.json` cannot be read — a broken install, not a normal run. */
export const FALLBACK_VERSION = '0.0.0';

/** Ditto for the name; the bin shim and the MCP handshake still need one. */
export const FALLBACK_SERVER_NAME = 'jira-mcp-ai';

interface ServerIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Read the shipped `package.json` ONCE, at module load.
 *
 * From `build/tools/index.js` the relative URL resolves to the package root,
 * which npm always includes in a tarball whatever `files` says. Reading it per
 * call would put a synchronous fs hit inside `jira_capabilities`; reading it
 * never would mean hard-coding a version that drifts from the one npm installed
 * — and OBSERVABILITY.md requires the version in `server_start`, in the startup
 * line and in `jira_capabilities`, all from one source.
 */
function resolveIdentity(): ServerIdentity {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    if (raw !== null && typeof raw === 'object') {
      const source = raw as { name?: unknown; version?: unknown };
      return {
        name:
          typeof source.name === 'string' && source.name !== ''
            ? source.name
            : FALLBACK_SERVER_NAME,
        version:
          typeof source.version === 'string' && source.version !== ''
            ? source.version
            : FALLBACK_VERSION,
      };
    }
  } catch {
    // A missing or malformed package.json must not stop the server from
    // starting: the version is observability, not a precondition for serving.
  }
  return { name: FALLBACK_SERVER_NAME, version: FALLBACK_VERSION };
}

const identity = resolveIdentity();

/** npm package name, as reported in the MCP handshake. */
export const SERVER_NAME = identity.name;

/** Server version, as reported in the handshake and `jira_capabilities`. */
export const SERVER_VERSION = identity.version;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** What the composition root injects into {@link createPackages}. */
export interface PackagesDeps {
  /**
   * `JIRA_MEDIA_DIR`. Absent ⇒ the attachments byte-moving tools refuse with
   * `kind: 'config'` naming the setting; the metadata tool still works.
   */
  readonly mediaDir?: string;
}

/**
 * Build the manifest against a capabilities report source.
 *
 * `core` is first because it is the package that survives every deny list
 * (CC-29) and the one a lost session falls back to; `search` second because it
 * is the entry point of nearly every workflow. The rest follow TOOLS.md.
 */
export function createPackages(
  source: CapabilitiesSource,
  deps: PackagesDeps = {},
): readonly PackageSpec[] {
  return Object.freeze([
    corePackage(source),
    searchPackage,
    issuesPackage,
    issuesWritePackage,
    issuesDeletePackage,
    createAttachmentsPackage({ mediaDir: deps.mediaDir }),
    collabPackage,
    metaPackage,
    usersPackage,
    agilePackage,
  ]);
}

/**
 * The report source used by {@link PACKAGES}: there isn't one.
 *
 * A thunk that throws rather than a stub report, because a plausible-looking
 * report full of zeroes would be indistinguishable from a real server that
 * genuinely has nothing registered. `capabilitiesTool` catches this and returns
 * a `config` envelope, so a caller who somehow invoked the unbound manifest gets
 * a diagnosis instead of a crash.
 */
function unboundReport(): never {
  throw new JiraError({
    kind: 'config',
    message:
      'jira_capabilities was called on the unbound PACKAGES manifest, which carries ' +
      'no capabilities report. This build wired the manifest without a report source.',
    retryable: false,
    remediation:
      'Register the server through main() (src/index.ts), which binds the report ' +
      'with createPackages(); PACKAGES itself is for tooling — the snapshot test, ' +
      'the README generator and server.json — not for serving calls.',
  });
}

/**
 * The manifest as a constant, for every consumer that reads STRUCTURE rather
 * than calling handlers. Registration uses {@link createPackages} instead.
 */
export const PACKAGES: readonly PackageSpec[] = createPackages(unboundReport);

// ---------------------------------------------------------------------------
// The capabilities report
// ---------------------------------------------------------------------------

export interface CapabilitiesInput {
  readonly settings: Settings;
  /**
   * The GATED surface, from `selectPackages(manifest, settings)`. The report
   * describes what is callable, not what was compiled in — a model shown a tool
   * the deny list removed would call it and be refused, which is worse than not
   * knowing it exists. What the configuration removed is reported separately, as
   * `excludedTools` (CC-29).
   */
  readonly selection: PackageSelection;
  /** Defaults to {@link SERVER_NAME}; overridable so a test needs no fixture file. */
  readonly serverName?: string;
  /** Defaults to {@link SERVER_VERSION}. */
  readonly version?: string;
}

function capabilityTool(tool: PackageSpec['tools'][number]): CapabilityTool {
  return {
    name: tool.name,
    title: tool.title,
    package: tool.package,
    readOnly: tool.annotations.readOnlyHint,
    ...(tool.writeTier === undefined ? {} : { writeTier: tool.writeTier }),
  };
}

function capabilityPackage(pkg: PackageSpec): CapabilityPackage {
  return {
    id: pkg.id,
    title: pkg.title,
    description: pkg.description,
    tools: pkg.tools.map(capabilityTool),
  };
}

function capabilityLimits(settings: Settings): CapabilityLimits {
  return {
    maxResultChars: settings.maxResultChars,
    maxPages: settings.maxPages,
    requestTimeoutMs: settings.requestTimeoutMs,
    callBudgetMs: settings.callBudgetMs,
  };
}

/**
 * Assemble what `jira_capabilities` returns.
 *
 * Every field comes from settings or from the gated selection — nothing is read
 * out of the environment here, and no secret is representable in the output
 * (there is no token, no email and no profile credential in
 * {@link CapabilitiesInfo}; `site` is the only host that appears).
 *
 * `excludedTools` is omitted when empty rather than reported as `[]`: an empty
 * list reads as "the configuration removed nothing", which is true, but the tool
 * already drops it in `snapshot()` and reporting it twice-shaped would make the
 * two paths disagree.
 */
export function buildCapabilitiesInfo(input: CapabilitiesInput): CapabilitiesInfo {
  const { settings, selection } = input;
  const excludedTools: CapabilityExclusion[] = [...selection.excludedTools].map(
    ([name, reason]) => ({ name, reason }),
  );

  return {
    serverName: input.serverName ?? SERVER_NAME,
    version: input.version ?? SERVER_VERSION,
    ...(settings.site === undefined ? {} : { site: settings.site }),
    transport: settings.transport,
    writeMode: settings.writeMode,
    ...(settings.activeProfile === undefined
      ? {}
      : { activeProfile: settings.activeProfile }),
    profileLocked: settings.lockProfile,
    packages: selection.packages.map(capabilityPackage),
    ...(excludedTools.length === 0 ? {} : { excludedTools }),
    limits: capabilityLimits(settings),
    journalEnabled: settings.journalPath !== undefined && settings.journalPath !== '',
  };
}
