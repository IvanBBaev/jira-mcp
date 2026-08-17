// ---------------------------------------------------------------------------
// Package `issues-write` (TOOLS.md §Package `issues-write`).
//
// The eight writes v1 allows against one issue: create it, update its fields,
// move it through the workflow, comment on it, edit a comment on it, assign it,
// log work on it and link it to another. All eight are `writeTier: 'standard'`,
// so all eight run behind the plan/apply gate (D14, CC-20/CC-32).
//
// NOTHING HERE BRANCHES ON PLAN MODE, and that is the whole design. In plan mode
// `mcp/write-mode.ts` hands the handler a CAPTURING `ctx.jira`: the handler
// "executes" exactly as it would for real, the first mutating request is
// captured instead of sent, and the gate — not this file — builds the plan
// payload and the `plan` hint. A handler that asked "am I planning?" would have
// two code paths and only one of them tested, which is the drift the seam
// exists to make impossible. The same rule explains why the reads below
// (`GET .../transitions`, `GET /myself`) are unconditional: a GET travels to the
// real network in both modes, so the plan is built from live facts and shows the
// id it would really send.
//
// THIS RING IS THIN. `api/issues.ts` owns every request body (its
// builder/executor split is what keeps plan and apply from drifting), owns ADF
// conversion, and owns the error wording — `staleTransition`'s "re-fetch the
// transitions" (CC-21) and Jira's own field-level 400 messages (CC-24) reach the
// model untouched. What is added here is the model-facing half only: strict
// input schemas, the intent-level refinements the api cannot express as types
// (CC-22), the `ToolResult` envelope and the closed-catalog hints.
//
// NO `_untrusted` BRAND. TOOLS.md §Untrusted content lists the content-bearing
// tools and every one of them is a READ. A write echoes back what the caller
// just sent (plus ids Jira minted); branding that would spend the warning where
// there is no third-party text, and teach the model to ignore it where there is.
//
// Layering: `core ← api ← mcp ← tools`. Tools are the composition root.
// ---------------------------------------------------------------------------

import { adfFromMarkdown, type AdfNode } from '../api/adf.js';
import {
  WORKLOG_STARTED_PATTERN,
  addComment,
  addWorklog,
  assignIssue,
  createIssue,
  linkIssues,
  listTransitions,
  resolveTransitionId,
  startedInstant,
  transitionIssue,
  updateComment,
  updateIssue,
} from '../api/issues.js';
import type {
  AssignIssueResult,
  CreatedIssue,
  IssueComment,
  IssueWorklog,
  JiraVisibility,
  LinkIssuesResult,
  TransitionIssueResult,
  UpdateIssueResult,
} from '../api/issues.js';
import { getMyself } from '../api/users.js';
import type { JiraError } from '../core/types.js';
import { defineTool, writeToolInput, z } from '../mcp/define.js';
import { errorResultOf } from '../mcp/errors.js';
import { ok } from '../mcp/result.js';
import {
  DESTRUCTIVE_WRITE_ANNOTATIONS,
  IDEMPOTENT_WRITE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  callBase,
  guarded,
} from '../mcp/tool-helpers.js';
import type { Hint, PackageSpec, ToolResult } from '../mcp/types.js';

// ---------------------------------------------------------------------------
// Hints (TOOLS.md §Hint catalog — closed vocabulary)
// ---------------------------------------------------------------------------

/** `discovery` — a field id was rejected, and field ids are instance-specific. */
const FIELD_DISCOVERY_HINT: Hint = {
  code: 'discovery',
  message:
    'Jira rejected a field. Field ids are instance-specific: call jira_list_fields ' +
    'for the customfield_10xxx id behind a field name, or jira_get_create_meta for ' +
    'the fields this project and issue type actually require. Jira names the ' +
    'offending field in the error above.',
};

/** `discovery` — a transition id/name is workflow- AND status-specific. */
const TRANSITION_DISCOVERY_HINT: Hint = {
  code: 'discovery',
  message:
    'Transitions depend on the workflow AND on the current status, so an id or ' +
    'name that worked before can stop existing. Call jira_get_transitions for this ' +
    'issue and use a value from that list.',
};

/** `discovery` — link type names are configured per instance. */
const LINK_TYPE_DISCOVERY_HINT: Hint = {
  code: 'discovery',
  message:
    'Link type names are instance-specific ("Blocks", "Relates", "Duplicate" and ' +
    'whatever else this site configured). Call jira_list_link_types and use a name ' +
    'from that list, spelled exactly.',
};

/** `sprint_move_required` — sprint is not a create field (TOOLS.md). */
const SPRINT_MOVE_HINT: Hint = {
  code: 'sprint_move_required',
  message:
    'A sprint cannot be set while creating an issue — the sprint field is not on ' +
    'the create screen. The issue was created in the backlog; follow with ' +
    'jira_move_to_sprint to place it in the sprint.',
};

/** CC-24: an unknown field id comes back as a 400 that names the field. */
function fieldErrorHints(error: JiraError): readonly Hint[] {
  return error.httpStatus === 400 ? [FIELD_DISCOVERY_HINT] : [];
}

/**
 * CC-21: both halves of the transition failure earn the same pointer — the name
 * that resolved against nothing (local `validation`, nothing sent) and the id
 * that Jira refused after the workflow moved under it (400).
 */
function transitionErrorHints(error: JiraError): readonly Hint[] {
  return error.kind === 'validation' ? [TRANSITION_DISCOVERY_HINT] : [];
}

/** An unknown link type name is a 400 from `POST /issueLink`. */
function linkErrorHints(error: JiraError): readonly Hint[] {
  return error.httpStatus === 400 ? [LINK_TYPE_DISCOVERY_HINT] : [];
}

// ---------------------------------------------------------------------------
// Shared arguments
// ---------------------------------------------------------------------------

const issueArg = z.string().min(1).describe('Issue key (PROJ-123) or numeric issue id.');

const accountIdArg = z
  .string()
  .min(1)
  .describe(
    'Atlassian accountId — the ONLY user identifier Jira Cloud accepts. Turn a ' +
      'display name or email into one with jira_search_users.',
  );

/**
 * Rich text as the api ring takes it: plain text (converted to ADF) or a raw ADF
 * document. The tool ring never builds ADF — `api/adf.ts` owns `toAdf`, including
 * the validation of a hand-written document.
 */
const richTextArg = z.union([z.string(), z.record(z.unknown())]);

/**
 * D44: every rich-text write input reads its STRING form in one of two
 * grammars. Which grammar is a tool-surface fact, so it is resolved here —
 * the api builders keep taking text or a finished document.
 */
const writeFormatArg = z
  .enum(['text', 'markdown'])
  .optional()
  .describe(
    'How to interpret a string rich-text input: "text" (default — blank lines ' +
      'split paragraphs, single newlines are hard breaks) or "markdown" (the ' +
      'documented subset: headings, lists, code fences, bold/italic/code, ' +
      'links). Refused alongside a raw ADF document.',
  );

const labelsArg = z.array(z.string().min(1));

const fieldsArg = z
  .record(z.unknown())
  .describe(
    'Raw field passthrough, keyed by Jira field id (customfield_10011). Values ' +
      'are sent as given; jira_get_create_meta shows the shape each field wants.',
  );

const visibilityArg = z
  .object({
    type: z.enum(['role', 'group']),
    value: z.string().min(1).describe('The project role name, or the group name.'),
  })
  .strict();

/**
 * Zod hands back `Record<string, unknown>` for a raw ADF document; the api takes
 * `AdfNode`. The assertion is safe because `toAdf` validates the document itself
 * — it refuses anything that is not a `doc` node — so a bad tree fails as a
 * `validation` error rather than as a wrong-shaped request.
 *
 * `format: 'markdown'` resolves HERE (D44): the string is parsed to a document
 * before the builder sees it, so plan mode captures the exact ADF an apply
 * would send (CC-20 stays faithful). The schemas refuse `format` next to a raw
 * document (CC-46), so the string check is exhaustive, not defensive.
 */
function asRichText(
  value: string | Record<string, unknown>,
  format?: 'text' | 'markdown',
): string | AdfNode {
  if (typeof value !== 'string') return value as AdfNode;
  return format === 'markdown' ? adfFromMarkdown(value) : value;
}

/** `asRichText` for an optional argument, keeping `undefined` distinct. */
function optionalRichText(
  value: string | Record<string, unknown> | undefined,
  format?: 'text' | 'markdown',
): string | AdfNode | undefined {
  return value === undefined ? undefined : asRichText(value, format);
}

/** `asRichText` for a nullable argument — `null` CLEARS the field (CC-31). */
function nullableRichText(
  value: string | Record<string, unknown> | null | undefined,
  format?: 'text' | 'markdown',
): string | AdfNode | null | undefined {
  return value === null || value === undefined ? value : asRichText(value, format);
}

/**
 * CC-46: `format` says how to READ a string; a raw ADF document needs no
 * reading, so the pair is refused rather than resolved — the write-side twin
 * of `raw` × `format` on the reads (D42). `null` and an absent input stay
 * legal: there is nothing to interpret, and `null` must keep clearing the
 * field.
 */
function refuseFormatOnRawAdf(
  ctx: z.RefinementCtx,
  format: 'text' | 'markdown' | undefined,
  field: string,
  value: unknown,
): void {
  if (format !== undefined && typeof value === 'object' && value !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['format'],
      message:
        `format and a raw ADF ${field} are mutually exclusive — a document ` +
        `needs no interpreting. Pass ${field} as a string, or drop format.`,
    });
  }
}

function asVisibility(
  value: { readonly type: 'role' | 'group'; readonly value: string } | undefined,
): JiraVisibility | undefined {
  return value;
}

// ---------------------------------------------------------------------------
// jira_create_issue
// ---------------------------------------------------------------------------

/**
 * TOOLS.md gives `sprint_move_required` the condition "issue created while a
 * sprint was requested", but `jira_create_issue` has no `sprint` input — the
 * only way to ask for one is the raw `fields` bag. So the narrowest honest
 * reading is implemented: the hint fires when the caller passed a field whose
 * KEY names a sprint, which is exactly the model that tried to set one and
 * needs to be told to follow with `jira_move_to_sprint`. A sprint requested by
 * its numeric custom field id (`customfield_10020`) is indistinguishable from
 * any other custom field and is deliberately NOT guessed at.
 */
function requestedSprint(fields: Record<string, unknown> | undefined): boolean {
  return fields !== undefined && Object.keys(fields).some((key) => /sprint/i.test(key));
}

const createIssueInput = writeToolInput({
  project: z.string().min(1).describe('Project key (PROJ) or numeric project id.'),
  issueType: z.string().min(1).describe('Issue type name (Task, Bug) or numeric id.'),
  summary: z.string().min(1).describe('The one-line title. Required by every project.'),
  description: richTextArg
    .optional()
    .describe('Plain text (converted to ADF) or a raw ADF document.'),
  assigneeAccountId: accountIdArg.optional(),
  labels: labelsArg.optional().describe('Labels to set on the new issue.'),
  priority: z.string().min(1).optional().describe('Priority name (High) or id.'),
  parent: z
    .string()
    .min(1)
    .optional()
    .describe('Parent issue key or id — the epic of a story, the story of a subtask.'),
  fields: fieldsArg.optional(),
  format: writeFormatArg,
}).superRefine((value, ctx) => {
  refuseFormatOnRawAdf(ctx, value.format, 'description', value.description);
});

export const createIssueTool = defineTool({
  name: 'jira_create_issue',
  title: 'Create issue',
  description:
    'Create one issue. project and issueType are instance-specific — resolve them ' +
    'with jira_list_projects and jira_get_create_meta, which also names the custom ' +
    'fields this project requires. description takes plain text (converted to ADF) ' +
    'or a raw ADF document; format: "markdown" parses a string description as the ' +
    'markdown subset. Assignees are accountId only. Custom fields go in ' +
    'fields under their customfield_10xxx id. A sprint cannot be set here: create ' +
    'first, then jira_move_to_sprint.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: createIssueInput,
  handler: async (args, ctx): Promise<ToolResult<CreatedIssue>> =>
    guarded(async () => {
      const created = await createIssue({
        ...callBase(ctx),
        project: args.project,
        issueType: args.issueType,
        summary: args.summary,
        description: optionalRichText(args.description, args.format),
        assigneeAccountId: args.assigneeAccountId,
        labels: args.labels,
        priority: args.priority,
        parent: args.parent,
        fields: args.fields,
      });
      return ok(created, {
        hints: requestedSprint(args.fields) ? [SPRINT_MOVE_HINT] : [],
      });
    }, fieldErrorHints),
});

// ---------------------------------------------------------------------------
// jira_update_issue
// ---------------------------------------------------------------------------

const updateIssueInput = writeToolInput({
  issue: issueArg,
  summary: z.string().min(1).optional(),
  description: richTextArg
    .nullable()
    .optional()
    .describe(
      'Text or ADF. REPLACES the whole rich-text field — anything the old value ' +
        'contained (tables, panels, images) is gone. null clears it.',
    ),
  assigneeAccountId: accountIdArg
    .nullable()
    .optional()
    .describe('accountId to assign to, or null to unassign.'),
  labels: labelsArg
    .optional()
    .describe(
      'REPLACES the whole label list. For an incremental edit use labelsAdd / ' +
        'labelsRemove instead — no read-modify-write, no lost race.',
    ),
  labelsAdd: labelsArg.optional().describe('Labels to add, leaving the rest alone.'),
  labelsRemove: labelsArg
    .optional()
    .describe('Labels to remove, leaving the rest alone.'),
  priority: z.string().min(1).optional().describe('Priority name (High) or id.'),
  parent: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('New parent issue key or id, or null to un-parent.'),
  fields: fieldsArg.optional(),
  notifyUsers: z
    .boolean()
    .optional()
    .describe('Default true, like Jira. false suppresses the change notification.'),
  format: writeFormatArg,
}).superRefine((value, ctx) => {
  refuseFormatOnRawAdf(ctx, value.format, 'description', value.description);
});

export const updateIssueTool = defineTool({
  name: 'jira_update_issue',
  title: 'Update issue',
  description:
    'Update fields on one issue. REPLACE semantics: description (text or ADF) ' +
    'replaces the WHOLE rich-text field, so tables and panels in the old value are ' +
    'lost — never "append" a paragraph this way. labels replaces the whole list; ' +
    'use labelsAdd / labelsRemove for incremental edits. parent: null un-parents, ' +
    'assigneeAccountId: null unassigns. format: "markdown" parses a string ' +
    'description as the markdown subset. Status is not settable here — use ' +
    'jira_transition_issue.',
  package: 'issues-write',
  annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: updateIssueInput,
  handler: async (args, ctx): Promise<ToolResult<UpdateIssueResult>> =>
    guarded(async () => {
      const updated = await updateIssue({
        ...callBase(ctx),
        issue: args.issue,
        summary: args.summary,
        description: nullableRichText(args.description, args.format),
        assigneeAccountId: args.assigneeAccountId,
        labels: args.labels,
        labelsAdd: args.labelsAdd,
        labelsRemove: args.labelsRemove,
        priority: args.priority,
        parent: args.parent,
        fields: args.fields,
        notifyUsers: args.notifyUsers,
      });
      return ok(updated);
    }, fieldErrorHints),
});

// ---------------------------------------------------------------------------
// jira_transition_issue
// ---------------------------------------------------------------------------

const transitionIssueInput = writeToolInput({
  issue: issueArg,
  transition: z
    .string()
    .min(1)
    .describe(
      'Transition NAME (Start Progress) or id (31). Resolved against the ' +
        "transitions available from this issue's current status.",
    ),
  fields: fieldsArg
    .optional()
    .describe(
      'Fields the transition screen demands, e.g. { "resolution": { "name": ' +
        '"Done" } }. jira_get_transitions reports which ones have a screen.',
    ),
  comment: richTextArg
    .optional()
    .describe('Comment added as part of the transition; text or ADF.'),
  format: writeFormatArg,
}).superRefine((value, ctx) => {
  refuseFormatOnRawAdf(ctx, value.format, 'comment', value.comment);
});

export const transitionIssueTool = defineTool({
  name: 'jira_transition_issue',
  title: 'Transition issue',
  description:
    "Move one issue through its workflow. transition takes the transition's NAME " +
    "or id and is resolved against the transitions available from the issue's " +
    'CURRENT status at call time; an unresolvable value comes back as a validation ' +
    'error listing the valid ones, and nothing is sent. Status cannot be set ' +
    'through jira_update_issue. Screens that demand a resolution take it in fields.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: transitionIssueInput,
  handler: async (args, ctx): Promise<ToolResult<TransitionIssueResult>> =>
    guarded(async () => {
      const base = callBase(ctx);
      // A GET, so it runs for real in plan mode too — the plan then shows the id
      // the apply would really send instead of the caller's name.
      const { transitions } = await listTransitions({ ...base, issue: args.issue });
      const transitionId = resolveTransitionId(transitions, args.transition);
      const result = await transitionIssue({
        ...base,
        issue: args.issue,
        transitionId,
        fields: args.fields,
        comment: optionalRichText(args.comment, args.format),
      });
      return ok(result);
    }, transitionErrorHints),
});

// ---------------------------------------------------------------------------
// jira_add_comment
// ---------------------------------------------------------------------------

const addCommentInput = writeToolInput({
  issue: issueArg,
  body: richTextArg.describe('Plain text (converted to ADF) or a raw ADF document.'),
  visibility: visibilityArg
    .optional()
    .describe('Restrict the comment to one project role or one group, by name.'),
  format: writeFormatArg,
}).superRefine((value, ctx) => {
  refuseFormatOnRawAdf(ctx, value.format, 'body', value.body);
});

export const addCommentTool = defineTool({
  name: 'jira_add_comment',
  title: 'Add comment',
  description:
    'Add a comment to one issue. body takes plain text (converted to ADF) or a raw ' +
    'ADF document; format: "markdown" parses a string body as the markdown subset. ' +
    'visibility restricts the comment to a single project role or ' +
    'group by name; omit it and everyone who can see the issue can read the ' +
    'comment. Mentions need the accountId form — jira_search_users resolves a name.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: addCommentInput,
  handler: async (args, ctx): Promise<ToolResult<IssueComment>> =>
    guarded(async () => {
      const comment = await addComment({
        ...callBase(ctx),
        issue: args.issue,
        body: asRichText(args.body, args.format),
        visibility: asVisibility(args.visibility),
      });
      return ok(comment);
    }),
});

// ---------------------------------------------------------------------------
// jira_update_comment
// ---------------------------------------------------------------------------

/**
 * The edit shares `jira_add_comment`'s body handling on purpose — one rich-text
 * convention for the whole thread — and adds the id of the comment to overwrite.
 * The issue argument keeps the name `issue` because the recent-writes registry
 * (D32) reads that key to record what this call touched; renaming it to
 * `issueIdOrKey` here would make the edit invisible to `jira_recent_writes`.
 */
const updateCommentInput = writeToolInput({
  issue: issueArg,
  commentId: z
    .union([z.string().min(1), z.number().int().positive()])
    .describe(
      'Numeric comment id, as jira_get_comments reports it in data.comments[].id.',
    ),
  body: richTextArg.describe(
    'The COMPLETE new comment: plain text (converted to ADF) or a raw ADF ' +
      'document. It replaces the stored body outright — there is no append.',
  ),
  visibility: visibilityArg
    .optional()
    .describe(
      'Restrict the edited comment to one project role or one group, by name. ' +
        'A restriction the comment already carries is not read back — pass it ' +
        'again to keep it.',
    ),
  format: writeFormatArg,
}).superRefine((value, ctx) => {
  refuseFormatOnRawAdf(ctx, value.format, 'body', value.body);
});

export const updateCommentTool = defineTool({
  name: 'jira_update_comment',
  title: 'Update comment',
  description:
    'Edit one existing comment. CC-31 REPLACE semantics: body overwrites the WHOLE ' +
    'comment, so anything the old one contained (tables, panels, mentions) is lost ' +
    'unless you resend it — read the comment with jira_get_comments first and pass ' +
    'the full new text, never just the sentence you wanted to add. commentId is the ' +
    'numeric id from that read. body takes plain text (converted to ADF), raw ADF, ' +
    'or markdown with format: "markdown".',
  package: 'issues-write',
  annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: updateCommentInput,
  handler: async (args, ctx): Promise<ToolResult<IssueComment>> =>
    guarded(async () => {
      const comment = await updateComment({
        ...callBase(ctx),
        issue: args.issue,
        commentId: args.commentId,
        body: asRichText(args.body, args.format),
        visibility: asVisibility(args.visibility),
      });
      return ok(comment);
    }),
});

// ---------------------------------------------------------------------------
// jira_assign_issue
// ---------------------------------------------------------------------------

/**
 * CC-22 — exactly one intent. The schema is where this belongs: a request that
 * carries both an accountId and `unassign: true` never reaches the gate, so
 * there is nothing to plan and nothing to apply. `api/issues.ts` refuses the
 * same pair, and that redundancy is deliberate — the api is reachable from the
 * CLI too.
 */
const assignIssueInput = writeToolInput({
  issue: issueArg,
  accountId: accountIdArg.optional(),
  unassign: z
    .boolean()
    .optional()
    .describe('true clears the assignee. Mutually exclusive with accountId.'),
}).superRefine((value, ctx) => {
  const named = value.accountId !== undefined;
  const cleared = value.unassign === true;
  if (named && cleared) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unassign'],
      message:
        'accountId and unassign: true are mutually exclusive — the intended ' +
        'assignee would be ambiguous. Pass exactly one.',
    });
  }
  if (!named && !cleared) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accountId'],
      message:
        'An assignment needs an intent: pass accountId to assign, or unassign: ' +
        'true to clear the assignee.',
    });
  }
});

export const assignIssueTool = defineTool({
  name: 'jira_assign_issue',
  title: 'Assign issue',
  description:
    'Set or clear the assignee of one issue. Pass exactly one of accountId (assign) ' +
    'or unassign: true (clear) — both together is rejected as ambiguous, neither is ' +
    'rejected as intentless. Jira Cloud identifies users by accountId only; ' +
    'jira_search_users turns a display name or email into one. Idempotent: ' +
    're-assigning the current assignee succeeds.',
  package: 'issues-write',
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: assignIssueInput,
  handler: async (args, ctx): Promise<ToolResult<AssignIssueResult>> =>
    guarded(async () => {
      const assigned = await assignIssue({
        ...callBase(ctx),
        issue: args.issue,
        accountId: args.accountId,
        unassign: args.unassign,
      });
      return ok(assigned);
    }),
});

// ---------------------------------------------------------------------------
// jira_add_worklog
// ---------------------------------------------------------------------------

/** D16's last resort: the site reported no zone for the authenticated user. */
function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const addWorklogInput = writeToolInput({
  issue: issueArg,
  timeSpentSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Preferred. Mutually exclusive with timeSpent.'),
  timeSpent: z
    .string()
    .min(1)
    .optional()
    .describe('Jira duration string, e.g. "2h 30m". Mutually exclusive with the above.'),
  started: z
    .string()
    .regex(
      WORKLOG_STARTED_PATTERN,
      'Expected YYYY-MM-DDTHH:mm[:ss[.sss]] with optional offset.',
    )
    .optional()
    .describe(
      'When the work started; defaults to now. Without an offset the value is read ' +
        "in the authenticated user's Jira timezone.",
    ),
  comment: richTextArg.optional().describe('Worklog comment; text or ADF.'),
  format: writeFormatArg,
}).superRefine((value, ctx) => {
  refuseFormatOnRawAdf(ctx, value.format, 'comment', value.comment);
  const bySeconds = value.timeSpentSeconds !== undefined;
  const byText = value.timeSpent !== undefined;
  if (bySeconds === byText) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timeSpentSeconds'],
      message: bySeconds
        ? 'timeSpentSeconds and timeSpent are mutually exclusive — pass exactly one.'
        : 'A worklog needs a duration: pass timeSpentSeconds (preferred) or timeSpent.',
    });
  }
});

export const addWorklogTool = defineTool({
  name: 'jira_add_worklog',
  title: 'Add worklog',
  description:
    'Log work against one issue. Pass exactly one of timeSpentSeconds (preferred) ' +
    'or timeSpent ("2h 30m"). started defaults to now and takes ' +
    'YYYY-MM-DDTHH:mm:ss with or without an offset: without one it is read in the ' +
    "authenticated user's Jira timezone, not the server's, and the request always " +
    'carries an explicit offset because Jira rejects a Z timestamp.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: addWorklogInput,
  handler: async (args, ctx): Promise<ToolResult<IssueWorklog>> =>
    guarded(async () => {
      const base = callBase(ctx);
      // D16: the offset belongs to the authenticated user, so it is FETCHED, not
      // observed. A GET, so plan mode passes it through and plans a real offset.
      const myself = await getMyself(base);
      const instant = startedInstant(
        args.started,
        myself.user.timeZone ?? hostTimeZone(),
        ctx.clock.now(),
      );
      if (instant === undefined) {
        return errorResultOf(
          'validation',
          'started is not a real calendar instant, so the worklog was not logged.',
          {
            remediation:
              'Pass started as YYYY-MM-DDTHH:mm:ss (optionally with .sss and an ' +
              'offset), naming a date that exists.',
          },
        );
      }

      const worklog = await addWorklog({
        ...base,
        issue: args.issue,
        timeSpentSeconds: args.timeSpentSeconds,
        timeSpent: args.timeSpent,
        startedAt: instant.epochMs,
        utcOffsetMinutes: instant.offsetMinutes,
        comment: optionalRichText(args.comment, args.format),
      });
      return ok(worklog);
    }),
});

// ---------------------------------------------------------------------------
// jira_link_issues
// ---------------------------------------------------------------------------

const linkIssuesInput = writeToolInput({
  linkType: z
    .string()
    .min(1)
    .describe('Link type NAME (Blocks, Relates). See jira_list_link_types.'),
  inwardIssue: issueArg.describe(
    'The issue at the inward end — the one "is blocked by".',
  ),
  outwardIssue: issueArg.describe(
    'The issue at the outward end — the one that "blocks".',
  ),
  comment: richTextArg
    .optional()
    .describe('Comment added to the inward issue alongside the link; text or ADF.'),
  format: writeFormatArg,
}).superRefine((value, ctx) => {
  refuseFormatOnRawAdf(ctx, value.format, 'comment', value.comment);
});

export const linkIssuesTool = defineTool({
  name: 'jira_link_issues',
  title: 'Link issues',
  description:
    'Link two issues. linkType is the link type NAME ("Blocks", "Relates"), and ' +
    'those names are instance-specific — read them from jira_list_link_types and ' +
    'spell them exactly. Direction matters: outwardIssue is the issue that acts ' +
    '(blocks), inwardIssue the one acted on (is blocked by). comment is added to ' +
    'the inward issue alongside the link.',
  package: 'issues-write',
  annotations: WRITE_ANNOTATIONS,
  writeTier: 'standard',
  input: linkIssuesInput,
  handler: async (args, ctx): Promise<ToolResult<LinkIssuesResult>> =>
    guarded(async () => {
      const linked = await linkIssues({
        ...callBase(ctx),
        linkType: args.linkType,
        inwardIssue: args.inwardIssue,
        outwardIssue: args.outwardIssue,
        comment: optionalRichText(args.comment, args.format),
      });
      return ok(linked);
    }, linkErrorHints),
});

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

/**
 * The `issues-write` package as the `PACKAGES` manifest (WP-40) declares it.
 * Tool order is TOOLS.md's table order, which is also the order
 * `jira_capabilities` and the README table render.
 */
export const issuesWritePackage: PackageSpec = {
  id: 'issues-write',
  title: 'Issues (write)',
  description:
    'Issue changes: creation, fields, workflow transitions, comments and comment ' +
    'edits, assignee, worklogs and links — every tool is plan-gated.',
  tools: [
    createIssueTool,
    updateIssueTool,
    transitionIssueTool,
    addCommentTool,
    updateCommentTool,
    assignIssueTool,
    addWorklogTool,
    linkIssuesTool,
  ],
};
