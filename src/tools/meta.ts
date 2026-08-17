// ---------------------------------------------------------------------------
// Package `meta` — the discovery reads (TOOLS.md §Package `meta`, WP-33).
//
// Six read-only tools that answer "what is this instance called?": projects,
// project detail, the field catalog, create metadata, statuses and issue link
// types. Every write tool in the catalog depends on one of them, because Jira
// ids (`customfield_10016`, issue type `10002`, a numeric project id) are
// tenant-specific and cannot be guessed.
//
// Three properties are load-bearing here and are asserted in `meta.test.ts`:
//
//  1. **Nothing is a Map on the wire.** `api/meta.ts` hands back `FieldCatalog`
//     with two `ReadonlyMap` indexes; a Map serializes to `{}` through
//     `JSON.stringify`, so it would reach the model as an empty object. The
//     catalog is projected into plain arrays here — see `duplicateNamesOf`.
//  2. **A partial create screen is never presented as complete.** A page cap or
//     an exhausted call budget can stop the createmeta loop mid-screen; the
//     result then carries `complete: false`, the field keys are RENAMED to
//     `fieldsSoFar` / `requiredSoFar`, and a warning says the required list is
//     not the full one. A model scanning for `required` finds nothing rather
//     than a plausible-looking half list.
//  3. **A page-cap stop is not `truncated`.** TOOLS.md's hint catalog defines
//     `truncated` as "the result exceeded JIRA_MAX_RESULT_CHARS" and its message
//     tells the model NOT to page on — the character-budget ladder in
//     `mcp/result.ts` owns it. Stopping at the page cap is the opposite fact
//     ("more rows exist upstream"), so it is reported in `data.paging`
//     (`partial`, `stopReason`, `nextStartAt`, `note`) and never as a hint.
//
// Metadata is not content-bearing (TOOLS.md §Untrusted content): no result here
// carries Jira free text a portal user could have authored, so nothing on this
// path is branded `_untrusted`.
//
// Layering: `core ← api ← mcp ← tools`. Tools are a composition root — they may
// import from every ring below, and they reach the network only through
// `ctx.jira`, which `api/meta.ts` receives as its `jira` seam.
// ---------------------------------------------------------------------------

import {
  filterFields,
  getCreateMeta,
  getProject,
  listCreateMetaIssueTypes,
  listFields,
  listLinkTypes,
  listProjects,
  listStatuses,
} from '../api/meta.js';
import type {
  CreateMetaField,
  FieldInfo,
  IssueTypeRef,
  LinkTypeInfo,
  ProjectDetail,
  ProjectSummary,
  StatusInfo,
} from '../api/meta.js';
import type { ClassicLoopResult, PageStopReason } from '../api/shared.js';
import { defineTool, toolInput, z } from '../mcp/define.js';
import { ok } from '../mcp/result.js';
import {
  READ_ANNOTATIONS,
  callBase,
  guarded,
  pagingOf,
  type CallBase,
  type PagingInfo as PagingInfoOf,
} from '../mcp/tool-helpers.js';
import type { Hint, PackageSpec, ToolCtx } from '../mcp/types.js';

// ---------------------------------------------------------------------------
// 1. Shared plumbing
// ---------------------------------------------------------------------------

/** {@link callBase} plus the loop guard, for the paginated calls. */
function pagedOptions(ctx: ToolCtx): CallBase & { readonly maxPages: number } {
  return { ...callBase(ctx), maxPages: ctx.limits.maxPages };
}

// ---------------------------------------------------------------------------
// 2. Pagination reporting (NOT the `truncated` hint — see the module header)
// ---------------------------------------------------------------------------

/**
 * What the caller must know about a classic pagination loop: how far it got and
 * whether Jira still has rows it never read — `mcp/tool-helpers.ts` owns the
 * shape, this is it instantiated with the api ring's stop reasons.
 */
type PagingInfo = PagingInfoOf<PageStopReason>;

/**
 * Why a partial result is partial, in words. Named per stop reason because the
 * remedies differ: a page cap is a configuration ceiling, a budget stop is a
 * slow tenant, and an abort came from the client itself.
 */
const PARTIAL_NOTES: Readonly<Record<Exclude<PageStopReason, 'exhausted'>, string>> =
  Object.freeze({
    max_pages:
      'INCOMPLETE: the page cap stopped this read before Jira ran out of rows, so ' +
      'more rows exist upstream. Narrow the filter, or raise JIRA_MAX_PAGES.',
    budget:
      'INCOMPLETE: the call budget expired before Jira ran out of rows, so more ' +
      'rows exist upstream. Narrow the filter, or raise JIRA_CALL_BUDGET_MS.',
    aborted:
      'INCOMPLETE: the call was cancelled before Jira ran out of rows, so more ' +
      'rows exist upstream. Re-run the call to read the rest.',
  });

/** Project a classic loop result onto {@link PagingInfo} with this package's notes. */
function metaPaging(loop: ClassicLoopResult<unknown>): PagingInfo {
  return pagingOf(loop, PARTIAL_NOTES);
}

// ---------------------------------------------------------------------------
// 3. `jira_list_projects`
// ---------------------------------------------------------------------------

const listProjectsInput = toolInput({
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Case-insensitive substring Jira matches against project NAME and KEY. ' +
        'Omit to list every project you can see.',
    ),
});

/** Result of {@link listProjectsTool}. */
interface ProjectListData {
  readonly projects: readonly ProjectSummary[];
  readonly count: number;
  readonly paging: PagingInfo;
  /** Echoed back so a paged/partial result says what it was filtered by. */
  readonly query?: string;
}

export const listProjectsTool = defineTool<
  z.infer<typeof listProjectsInput>,
  ProjectListData
>({
  name: 'jira_list_projects',
  title: 'List projects',
  description:
    'Lists the Jira projects you can see — id, key, name, project type and lead. ' +
    'This is how a project NAME becomes the KEY every other tool wants. `query` ' +
    'is matched server-side against project name and key. The read is paged ' +
    'internally: when `paging.partial` is true more projects exist upstream, so ' +
    'narrow `query` instead of treating the list as complete.',
  package: 'meta',
  annotations: READ_ANNOTATIONS,
  input: listProjectsInput,
  handler(args, ctx) {
    return guarded(async () => {
      const loop = await listProjects({
        ...pagedOptions(ctx),
        ...(args.query === undefined ? {} : { query: args.query }),
      });
      return ok<ProjectListData>({
        projects: loop.items,
        count: loop.items.length,
        paging: metaPaging(loop),
        ...(args.query === undefined ? {} : { query: args.query }),
      });
    });
  },
});

// ---------------------------------------------------------------------------
// 4. `jira_get_project`
// ---------------------------------------------------------------------------

const getProjectInput = toolInput({
  project: z
    .string()
    .min(1)
    .describe('Project key (e.g. ABC) or numeric project id. Not the project name.'),
  expand: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Comma-separated Jira expand list, replacing the default ' +
        '"description,lead,issueTypes". Components and versions come back either way.',
    ),
});

/** Result of {@link getProjectTool}. */
interface ProjectDetailData {
  readonly project: ProjectDetail;
}

export const getProjectTool = defineTool<
  z.infer<typeof getProjectInput>,
  ProjectDetailData
>({
  name: 'jira_get_project',
  title: 'Get project',
  description:
    'Reads one project in detail: description, lead, issue types, components and ' +
    'versions — what you need before creating an issue, because issue type ids ' +
    'and component/version names are per-project. `project` is a key or a numeric ' +
    'id. A project that does not exist and one you may not see are the same 404 ' +
    'from Jira, so the error names both possibilities.',
  package: 'meta',
  annotations: READ_ANNOTATIONS,
  input: getProjectInput,
  handler(args, ctx) {
    return guarded(async () => {
      const project = await getProject({
        ...callBase(ctx),
        project: args.project,
        ...(args.expand === undefined ? {} : { expand: args.expand }),
      });
      return ok<ProjectDetailData>({ project });
    });
  },
});

// ---------------------------------------------------------------------------
// 5. `jira_list_fields` — THE discovery call
// ---------------------------------------------------------------------------

const listFieldsInput = toolInput({
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Case-insensitive substring filter over field NAME and field ID, applied by ' +
        'this server (GET /field takes no filter). "story points" and "10016" both ' +
        'find customfield_10016.',
    ),
});

/**
 * A field NAME that more than one field id answers to — two "Story Points" from
 * two apps is the classic case.
 *
 * This is `FieldCatalog.idsByName` serialized. The api ring keeps that index as
 * a `Map` on purpose (a tenant may name a field `constructor`), and a `Map`
 * JSON-serializes to `{}` — so it is projected into an array of pairs here
 * rather than being handed to the envelope.
 */
interface DuplicateFieldName {
  /** Lower-cased, exactly as the catalog keys it. */
  readonly name: string;
  /** Every field id carrying that name, in catalog order. */
  readonly ids: readonly string[];
}

/** Result of {@link listFieldsTool}. */
interface FieldListData {
  /** The catalog, filtered by `query` when one was given. */
  readonly fields: readonly FieldInfo[];
  /** `fields.length` — rows in this result. */
  readonly count: number;
  /** Fields in the whole catalog, before filtering. */
  readonly totalCount: number;
  /** `custom: true` fields in the whole catalog, before filtering. */
  readonly customCount: number;
  /** Ambiguous names across the WHOLE catalog, never just the filtered slice. */
  readonly duplicateNames: readonly DuplicateFieldName[];
  readonly query?: string;
}

/** Serialize the catalog's name→ids Map, keeping only the ambiguous entries. */
function duplicateNamesOf(
  idsByName: ReadonlyMap<string, readonly string[]>,
): readonly DuplicateFieldName[] {
  const duplicates: DuplicateFieldName[] = [];
  for (const [name, ids] of idsByName) {
    if (ids.length > 1) duplicates.push({ name, ids: [...ids] });
  }
  return duplicates;
}

export const listFieldsTool = defineTool<z.infer<typeof listFieldsInput>, FieldListData>({
  name: 'jira_list_fields',
  title: 'List fields',
  description:
    'THE discovery tool for field ids: every field with id, name, schema type and ' +
    'the custom flag, so "Story Points" resolves to customfield_10016 and back. ' +
    '`query` filters by name or id. `duplicateNames` lists names carried by more ' +
    'than one id — when a name appears there, ask which field is meant instead of ' +
    'picking one. GET /field is not paginated, so this result is always complete.',
  package: 'meta',
  annotations: READ_ANNOTATIONS,
  input: listFieldsInput,
  handler(args, ctx) {
    return guarded(async () => {
      const catalog = await listFields(callBase(ctx));
      const fields = filterFields(catalog.fields, args.query);
      return ok<FieldListData>({
        fields,
        count: fields.length,
        totalCount: catalog.fields.length,
        customCount: catalog.custom.length,
        duplicateNames: duplicateNamesOf(catalog.idsByName),
        ...(args.query === undefined ? {} : { query: args.query }),
      });
    });
  },
});

// ---------------------------------------------------------------------------
// 6. `jira_get_create_meta` — the two-step create flow
// ---------------------------------------------------------------------------

const getCreateMetaInput = toolInput({
  project: z
    .string()
    .min(1)
    .describe('Project key (e.g. ABC) or numeric project id. Not the project name.'),
  issueTypeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Issue type ID — never a name, because names are not unique across a tenant. ' +
        'Omit to list the issue type ids you may create in this project.',
    ),
});

/** Step one: which issue types may be created in this project. */
interface CreateMetaIssueTypesData {
  readonly project: string;
  readonly step: 'choose_issue_type';
  readonly issueTypes: readonly IssueTypeRef[];
  readonly count: number;
  readonly paging: PagingInfo;
}

/** Fields shared by both step-two shapes. */
interface CreateMetaScreenBase {
  readonly project: string;
  readonly issueTypeId: string;
  readonly step: 'create_screen';
  /** Fields read so far; equals the screen size only when `complete`. */
  readonly count: number;
  readonly paging: PagingInfo;
}

/** Step two, whole screen read. */
interface CreateMetaCompleteData extends CreateMetaScreenBase {
  readonly complete: true;
  readonly fields: readonly CreateMetaField[];
  /** Every field Jira marks `required` — the complete set. */
  readonly required: readonly CreateMetaField[];
}

/**
 * Step two, screen only PARTLY read.
 *
 * The keys are deliberately not `fields`/`required`: a model that scans the
 * result for `required` must come up empty rather than find a list that looks
 * authoritative and is not. `complete: false` and `warning` say the same thing
 * twice more, and the `discovery` hint says it a fourth time.
 */
interface CreateMetaPartialData extends CreateMetaScreenBase {
  readonly complete: false;
  readonly fieldsSoFar: readonly CreateMetaField[];
  readonly requiredSoFar: readonly CreateMetaField[];
  readonly warning: string;
}

type CreateMetaData =
  CreateMetaIssueTypesData | CreateMetaCompleteData | CreateMetaPartialData;

/** Verbatim text of the partial-screen warning; the test substring-asserts it. */
export const PARTIAL_CREATE_SCREEN_WARNING =
  'INCOMPLETE create screen: the read stopped before Jira ran out of fields, so ' +
  'this is NOT the full field list and NOT the full set of required fields — a ' +
  'field this screen requires may be missing from it. That is why the keys are ' +
  'named fieldsSoFar/requiredSoFar. Do not create an issue from this list and do ' +
  'not report it as the required fields; read the whole screen first.';

const CHOOSE_ISSUE_TYPE_HINT: Hint = {
  code: 'discovery',
  message:
    'Issue type ids are instance-specific. Pick one from issueTypes and call ' +
    'jira_get_create_meta again with issueTypeId to read that create screen.',
};

const PARTIAL_SCREEN_HINT: Hint = {
  code: 'discovery',
  message:
    'This create screen was only partly read, so the required-field list is ' +
    'incomplete. Re-run jira_get_create_meta (with a higher JIRA_MAX_PAGES or ' +
    'JIRA_CALL_BUDGET_MS) before creating an issue from it.',
};

export const getCreateMetaTool = defineTool<
  z.infer<typeof getCreateMetaInput>,
  CreateMetaData
>({
  name: 'jira_get_create_meta',
  title: 'Get create metadata',
  description:
    'Reads what jira_create_issue accepts for a project. Call it WITHOUT ' +
    '`issueTypeId` to list the issue types you may create there, then again WITH ' +
    'one to get that screen: field id, name, required flag, allowed values and the ' +
    'update operations each field takes. Issue type and custom field ids are ' +
    'instance-specific — never guess one. When `complete` is false the screen was ' +
    'only partly read and its required-field list is NOT the full one.',
  package: 'meta',
  annotations: READ_ANNOTATIONS,
  input: getCreateMetaInput,
  handler(args, ctx) {
    return guarded(async () => {
      if (args.issueTypeId === undefined) {
        const loop = await listCreateMetaIssueTypes({
          ...pagedOptions(ctx),
          project: args.project,
        });
        return ok<CreateMetaData>(
          {
            project: args.project,
            step: 'choose_issue_type',
            issueTypes: loop.items,
            count: loop.items.length,
            paging: metaPaging(loop),
          },
          { hints: [CHOOSE_ISSUE_TYPE_HINT] },
        );
      }

      const screen = await getCreateMeta({
        ...pagedOptions(ctx),
        project: args.project,
        issueTypeId: args.issueTypeId,
      });
      const base: CreateMetaScreenBase = {
        project: screen.project,
        issueTypeId: screen.issueTypeId,
        step: 'create_screen',
        count: screen.items.length,
        paging: metaPaging(screen),
      };
      if (screen.partial) {
        return ok<CreateMetaData>(
          {
            ...base,
            complete: false,
            fieldsSoFar: screen.items,
            requiredSoFar: screen.required,
            warning: PARTIAL_CREATE_SCREEN_WARNING,
          },
          { hints: [PARTIAL_SCREEN_HINT] },
        );
      }
      return ok<CreateMetaData>({
        ...base,
        complete: true,
        fields: screen.items,
        required: screen.required,
      });
    });
  },
});

// ---------------------------------------------------------------------------
// 7. `jira_list_statuses`
// ---------------------------------------------------------------------------

const listStatusesInput = toolInput({
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'NUMERIC project id (from jira_list_projects / jira_get_project), not a ' +
        'project key. Restricts the list to the statuses of that one project.',
    ),
});

/** Result of {@link listStatusesTool}. */
interface StatusListData {
  readonly statuses: readonly StatusInfo[];
  readonly count: number;
  readonly paging: PagingInfo;
  readonly projectId?: string;
}

export const listStatusesTool = defineTool<
  z.infer<typeof listStatusesInput>,
  StatusListData
>({
  name: 'jira_list_statuses',
  title: 'List statuses',
  description:
    'Lists workflow statuses — id, name, category and scope — so JQL like ' +
    'status = "In Review" names a status that really exists on this site. ' +
    '`projectId` narrows the list to one project and is the NUMERIC id, not the ' +
    'key. Note that statusCategory here is a plain string (TODO / IN_PROGRESS / ' +
    'DONE), unlike the nested object carried by the status field of an issue.',
  package: 'meta',
  annotations: READ_ANNOTATIONS,
  input: listStatusesInput,
  handler(args, ctx) {
    return guarded(async () => {
      const loop = await listStatuses({
        ...pagedOptions(ctx),
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      });
      return ok<StatusListData>({
        statuses: loop.items,
        count: loop.items.length,
        paging: metaPaging(loop),
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      });
    });
  },
});

// ---------------------------------------------------------------------------
// 8. `jira_list_link_types`
// ---------------------------------------------------------------------------

const listLinkTypesInput = toolInput({});

/** Result of {@link listLinkTypesTool}. */
interface LinkTypeListData {
  readonly linkTypes: readonly LinkTypeInfo[];
  readonly count: number;
}

export const listLinkTypesTool = defineTool<
  z.infer<typeof listLinkTypesInput>,
  LinkTypeListData
>({
  name: 'jira_list_link_types',
  title: 'List issue link types',
  description:
    'Lists the issue link types configured on this site with their inward and ' +
    'outward phrases (for example "blocks" / "is blocked by"). jira_link_issues ' +
    'takes the `name` from this list, so read it first rather than guessing a link ' +
    'type name. The endpoint is not paginated, so this result is always complete.',
  package: 'meta',
  annotations: READ_ANNOTATIONS,
  input: listLinkTypesInput,
  handler(_args, ctx) {
    return guarded(async () => {
      const linkTypes = await listLinkTypes(callBase(ctx));
      return ok<LinkTypeListData>({ linkTypes, count: linkTypes.length });
    });
  },
});

// ---------------------------------------------------------------------------
// 9. The package
// ---------------------------------------------------------------------------

/**
 * The `meta` package, in TOOLS.md order. `tools/index.ts` (WP-40) imports this
 * const and puts it in the ordered `PACKAGES` manifest; nothing here registers
 * itself.
 */
export const metaPackage: PackageSpec = {
  id: 'meta',
  title: 'Metadata & discovery',
  description:
    'Projects, fields, create metadata, statuses and link types — the reads that ' +
    'turn names into the ids every other package needs.',
  tools: [
    listProjectsTool,
    getProjectTool,
    listFieldsTool,
    getCreateMetaTool,
    listStatusesTool,
    listLinkTypesTool,
  ],
};
