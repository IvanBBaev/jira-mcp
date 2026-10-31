// api/issues/paths.ts — the issue surface's wire constants (D517).

// ---------------------------------------------------------------------------
// 1. Wire constants
// ---------------------------------------------------------------------------

/** The issue collection — `POST` here creates. Relative to the `v3` root. */
export const ISSUE_COLLECTION_PATH = '/issue';

/** The bulk read endpoint (D149) — Cloud only. */
export const ISSUE_BULKFETCH_PATH = '/issue/bulkfetch';

/** The bulk changelog endpoint (D150) — Cloud only. */
export const CHANGELOG_BULKFETCH_PATH = '/changelog/bulkfetch';

/** Issue links live outside the issue resource (JIRA-API.md §Issue links). */
export const ISSUE_LINK_PATH = '/issueLink';

/** Route templates. They are what logs and errors see — never a concrete key. */
export const ISSUE_PATH_TEMPLATE = '/issue/{issueIdOrKey}';
export const ISSUE_COMMENT_PATH_TEMPLATE = '/issue/{issueIdOrKey}/comment';
/** One comment inside the thread — the `PUT` target of {@link updateComment}. */
export const ISSUE_COMMENT_ITEM_PATH_TEMPLATE = '/issue/{issueIdOrKey}/comment/{id}';
export const ISSUE_TRANSITIONS_PATH_TEMPLATE = '/issue/{issueIdOrKey}/transitions';
export const ISSUE_WORKLOG_PATH_TEMPLATE = '/issue/{issueIdOrKey}/worklog';
export const ISSUE_CHANGELOG_PATH_TEMPLATE = '/issue/{issueIdOrKey}/changelog';
export const ISSUE_ASSIGNEE_PATH_TEMPLATE = '/issue/{issueIdOrKey}/assignee';

/**
 * TOOLS.md §jira_get_comments — newest first. Jira's own default is oldest
 * first, which is the wrong end of a long thread for every digest a model builds.
 */
export const DEFAULT_COMMENT_ORDER_BY = '-created';

export const DEFAULT_COMMENT_PAGE_SIZE = 50;
export const DEFAULT_WORKLOG_PAGE_SIZE = 50;
export const DEFAULT_CHANGELOG_PAGE_SIZE = 100;

/** Tool-level page cap: a page of issue data is spent on a context window. */
export const MAX_PAGE_SIZE = 100;

/**
 * Default page cap for the classic lists here: ONE page, matching
 * `DEFAULT_SEARCH_MAX_PAGES` in `api/search.ts`. The tools expose
 * `startAt`/`maxResults` to the model, so the default call reads one page and
 * reports `nextStartAt`; a caller that wants a sweep passes `maxPages`.
 */
export const DEFAULT_LIST_MAX_PAGES = 1;

/**
 * Recursion cap for read shaping. Wire data is JSON so it cannot be cyclic, but
 * it can be absurdly deep (a custom field holding a whole document); past this
 * the value is handed back untouched rather than blowing the stack.
 */
export const MAX_SHAPE_DEPTH = 16;
