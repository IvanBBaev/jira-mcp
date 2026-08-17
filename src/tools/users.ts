// ---------------------------------------------------------------------------
// Package `users` — the name → accountId lookup (TOOLS.md §Package `users`, WP-34).
//
// One tool. It exists because Jira Cloud is GDPR-mode: there are no usernames
// and no user keys (JIRA-API.md §Users), so every other tool in the catalog
// takes an `accountId` and nothing else — and this is the ONLY call that turns
// "Ivan" into one.
//
// Two properties are load-bearing here and are asserted in `users.test.ts`:
//
//  1. **Email is opt-in, and dropping it is this ring's job.** `api/users.ts`
//     passes `emailAddress` through whenever Jira sent one; THREAT-MODEL.md §PII
//     says the model may not see it unless it asked. So `includeEmail` defaults
//     to false and every row is re-projected here — an omitted key, never a
//     `null` and never the string "undefined".
//  2. **A masked email is a normal result (CC-19).** A tenant that hides email
//     addresses answers with rows that simply have no `emailAddress`. That is
//     reported as the `email_hidden` hint — and only when the caller actually
//     asked for email, because a hint about a field nobody requested is noise.
//
// Not content-bearing: TOOLS.md §Untrusted content brands tools whose result can
// carry Jira-authored free text (issue/comment/changelog/worklog bodies). A user
// directory row is `accountId` + `displayName` + `active`; nothing here is
// branded `_untrusted`.
//
// A page-cap stop is NOT the `truncated` hint — see `pagingOf` in
// `mcp/tool-helpers.ts`, which owns the paging surface for every package.
//
// Layering: `core ← api ← mcp ← tools`. Tools are a composition root; the
// network is reached only through `ctx.jira`, which `api/users.ts` receives as
// its `jira` seam.
// ---------------------------------------------------------------------------

import type { PageStopReason } from '../api/shared.js';
import {
  DEFAULT_USER_SEARCH_MAX_RESULTS,
  MAX_USER_SEARCH_RESULTS,
  searchUsers,
  type JiraUser,
} from '../api/users.js';
import { defineTool, toolInput, z } from '../mcp/define.js';
import { ok } from '../mcp/result.js';
import {
  READ_ANNOTATIONS,
  callBase,
  guarded,
  pagingOf,
  type PagingInfo as PagingInfoOf,
} from '../mcp/tool-helpers.js';
import type { Hint, PackageSpec } from '../mcp/types.js';

// ---------------------------------------------------------------------------
// 1. Pagination reporting (NOT the `truncated` hint)
// ---------------------------------------------------------------------------

/**
 * What the caller must know about the classic loop behind this read: how far it
 * got and whether Jira still has rows it never read — `mcp/tool-helpers.ts`
 * owns the shape, this is it instantiated with the api ring's stop reasons.
 *
 * This is deliberately NOT the `truncated` hint: stopping at the page cap means
 * more rows exist upstream and `nextStartAt` will fetch them, where `truncated`
 * means the character budget tripped and the model should NOT page on.
 */
type PagingInfo = PagingInfoOf<PageStopReason>;

/** Why a partial result is partial, in words — the remedies differ per reason. */
const PARTIAL_NOTES: Readonly<Record<Exclude<PageStopReason, 'exhausted'>, string>> =
  Object.freeze({
    max_pages:
      'INCOMPLETE: one page is read per call, and Jira had more matching users. ' +
      'Call again with startAt = paging.nextStartAt, or narrow `query`.',
    budget:
      'INCOMPLETE: the call budget expired before Jira ran out of matching users. ' +
      'Call again with startAt = paging.nextStartAt, or narrow `query`.',
    aborted:
      'INCOMPLETE: the call was cancelled before Jira ran out of matching users. ' +
      'Re-run it to read the rest.',
  });

// ---------------------------------------------------------------------------
// 2. `jira_search_users`
// ---------------------------------------------------------------------------

/**
 * CC-19. Raised only when the caller asked for email: a hint about a field
 * nobody requested is noise, and the absence would otherwise read as an error.
 */
const EMAIL_HIDDEN_HINT: Hint = {
  code: 'email_hidden',
  message:
    'This site masks user email addresses (GDPR), so at least one row came back ' +
    'without one. The email is unavailable, not missing by error — identify the ' +
    'user by accountId.',
};

/** CC-04-shaped: the page size was above the tool cap and was clamped, not refused. */
const CLAMPED_HINT: Hint = {
  code: 'clamped',
  message:
    `maxResults was above this tool's cap and was clamped to ` +
    `${String(MAX_USER_SEARCH_RESULTS)}. Ask for ${String(MAX_USER_SEARCH_RESULTS)} ` +
    'or fewer; a name lookup needing more candidates needs a better query.',
};

const searchUsersInput = toolInput({
  query: z
    .string()
    .min(1)
    .describe(
      'A display name, part of one, or an email address. Matched server-side by ' +
        'Jira. There are no usernames on Cloud, so this is the only thing to search by.',
    ),
  issue: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Issue key or id. Present ⇒ only users who can be ASSIGNED to that issue are ' +
        'returned. Wins over `project` when both are given.',
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Project key or id. Present ⇒ only users assignable in that project are ' +
        'returned. Ignored when `issue` is also given.',
    ),
  includeEmail: z
    .boolean()
    .optional()
    .describe(
      'Return emailAddress when Jira exposes it. Default false: email is personal ' +
        'data and is dropped from every row unless it is explicitly asked for.',
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Rows to ask for; default ${String(DEFAULT_USER_SEARCH_MAX_RESULTS)}, values ` +
        `above ${String(MAX_USER_SEARCH_RESULTS)} are clamped. One page per call.`,
    ),
  startAt: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Offset to resume from — pass `paging.nextStartAt` from the previous call.',
    ),
});

/** One directory row, as TOOLS.md §Read shaping defines a user everywhere. */
interface UserRow {
  readonly accountId: string;
  /** Absent when Jira sent none — omitted, never the string "undefined". */
  readonly displayName?: string;
  readonly active?: boolean;
  /** Present only with `includeEmail: true` AND an email Jira actually sent. */
  readonly emailAddress?: string;
}

/** Result of {@link searchUsersTool}. */
interface UserSearchData {
  readonly users: readonly UserRow[];
  readonly count: number;
  /** `assignable` ⇒ the assignable-user endpoint answered (O-5), `query` ⇒ plain search. */
  readonly scope: 'query' | 'assignable';
  /** Echoed so a paged result says what it was searched for. */
  readonly query: string;
  /** The page size actually sent, after clamping. */
  readonly maxResults: number;
  /** `false` ⇒ emailAddress was stripped from every row before it got here. */
  readonly emailIncluded: boolean;
  readonly paging: PagingInfo;
}

/**
 * Re-project a Jira user onto the documented shape. Everything else Jira sends
 * (`accountType`, `timeZone`, `locale`, avatars) is dropped, and `emailAddress`
 * survives only when the caller opted in — THREAT-MODEL.md §PII.
 */
function projectUser(user: JiraUser, includeEmail: boolean): UserRow {
  return {
    accountId: user.accountId,
    ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
    ...(user.active === undefined ? {} : { active: user.active }),
    ...(includeEmail && user.emailAddress !== undefined
      ? { emailAddress: user.emailAddress }
      : {}),
  };
}

export const searchUsersTool = defineTool<
  z.infer<typeof searchUsersInput>,
  UserSearchData
>({
  name: 'jira_search_users',
  title: 'Search users',
  description:
    'Finds Jira users by display name or email and returns their accountId — the ' +
    'id every other tool takes, since Cloud has no usernames. Pass `issue` or ' +
    '`project` to restrict the answer to people who can be assigned there (issue ' +
    'wins). Email is personal data: it is dropped unless includeEmail is true, and ' +
    'a site that masks it says so with the email_hidden hint. One page per call — ' +
    'when paging.partial is true, call again with startAt = paging.nextStartAt.',
  package: 'users',
  annotations: READ_ANNOTATIONS,
  input: searchUsersInput,
  handler(args, ctx) {
    return guarded(async () => {
      const result = await searchUsers({
        ...callBase(ctx),
        query: args.query,
        issueKey: args.issue,
        project: args.project,
        maxResults: args.maxResults,
        startAt: args.startAt,
      });

      const includeEmail = args.includeEmail === true;
      const users = result.users.map((user) => projectUser(user, includeEmail));

      const hints: Hint[] = [];
      if (result.clamped) hints.push(CLAMPED_HINT);
      // CC-19: only meaningful to a caller that asked for the field.
      if (includeEmail && result.emailHidden) hints.push(EMAIL_HIDDEN_HINT);

      return ok<UserSearchData>(
        {
          users,
          count: users.length,
          scope: result.scope,
          query: args.query,
          maxResults: result.maxResults,
          emailIncluded: includeEmail,
          paging: pagingOf(result, PARTIAL_NOTES),
        },
        hints.length === 0 ? {} : { hints },
      );
    });
  },
});

// ---------------------------------------------------------------------------
// 3. The package
// ---------------------------------------------------------------------------

/**
 * The `users` package. `tools/index.ts` (WP-40) imports this const and puts it
 * in the ordered `PACKAGES` manifest; nothing here registers itself.
 */
export const usersPackage: PackageSpec = {
  id: 'users',
  title: 'User lookup',
  description:
    'Finding people by name or email — the one path from a human name to the ' +
    'accountId every other tool requires.',
  tools: [searchUsersTool],
};
