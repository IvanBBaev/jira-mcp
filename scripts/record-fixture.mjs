#!/usr/bin/env node
/**
 * record-fixture — turn real Jira Cloud traffic into redacted `test/fixtures/*.json`.
 *
 * TESTING.md §Fixtures makes two promises about this script, and both of them are
 * about the disk: the fixtures are what Jira ACTUALLY returned (not what we wish
 * it returned), and "redaction runs inside the record script — raw responses
 * never touch disk". Everything below follows from those two sentences.
 *
 * How it captures
 *   In-process, wrapping the fetch seam. `core/http.ts` reads `globalThis.fetch`
 *   at call time (that is what `withFetch()` exploits in the suites), so a
 *   recorder can borrow the same seam: it swaps in a wrapper that DELEGATES to
 *   the fetch that was already installed, records the pair, hands the caller a
 *   replayed Response and restores the original in a `finally`. The recorder is
 *   therefore not a second place that knows what a socket is — ARCHITECTURE.md's
 *   "only core/http.ts touches the network" still holds, and the request that is
 *   recorded is the real one, with the real headers, retries and query strings
 *   the server would have sent, because the whole `api/*` code path ran to
 *   produce it.
 *
 * How it redacts
 *   Nothing is written until the WHOLE document has been through the redactor and
 *   then re-inspected by {@link assertClean}. A token that reaches the filesystem
 *   for a millisecond has leaked, so there is no "write then clean" path here and
 *   there must never be one. Three layers, in order:
 *     1. `core/redact.ts` — the repo's own choke point: registered secrets (the
 *        API token, the Basic blob) plus credential SHAPES (`Authorization:` /
 *        `Bearer …` / `?token=…`). Reused rather than reimplemented, so this
 *        script cannot drift from what the server considers a secret.
 *     2. the fixture placeholder vocabulary TESTING.md names — site host, emails,
 *        accountIds (both formats), displayNames, avatar URLs. Stable, so the
 *        same person is the same placeholder everywhere in the file.
 *     3. structural drops — a credential-bearing header or body key is removed
 *        entirely rather than recorded with a placeholder value, because the
 *        fixture PII lint fails on the KEY.
 *   `assertClean` then walks the redacted document as an adversary and refuses to
 *   write if it still finds an email shape, a non-placeholder accountId, the real
 *   host, a credential key, a JWT, an Atlassian `ATATT…` token, a registered
 *   secret, or an unclassifiable high-entropy blob. That last rule is the point:
 *   something credential-shaped that the redactor could not name FAILS the run
 *   with the JSON path of the offending field. Half-redacted is not a state this
 *   script is allowed to produce.
 *
 * How it writes
 *   Operator-named destination, `0600`, and `wx` — an existing fixture is never
 *   silently overwritten (`--force` is the deliberate way). Captured payloads get
 *   their object keys sorted and a fixed two-space encoding, so re-recording a
 *   scenario produces a reviewable diff instead of key-order noise.
 *
 * How it differs from `verify-live.mjs --record`
 *   That one records the TOOL-LEVEL envelope — data that has already been through
 *   `api/*` mapping and the tool ring — and its captures are evidence for a Gate C
 *   report, not fixtures. This one records the wire: status, headers and the raw
 *   body, before any mapping, which is exactly what `fakeJiraRequest` must be fed
 *   if the guards in `api/*` are to be tested against Jira rather than against our
 *   idea of Jira. Both redact with the same placeholder vocabulary on purpose.
 *
 * Usage
 *   JIRA_SITE=… JIRA_EMAIL=… JIRA_API_TOKEN=… \
 *     node scripts/record-fixture.mjs --scenario issue-detail --issue ABC-123 \
 *       --out test/fixtures/issue-detail.json
 *   node scripts/record-fixture.mjs --list
 *
 * Credentials come from the same environment the server reads (JIRA_SITE,
 * JIRA_EMAIL, JIRA_API_TOKEN, plus the `.env` file `loadSettings` finds), because
 * an operator who can start the server should not have to learn a second way to
 * point at a site. Unlike `verify-live.mjs`, missing credentials are a usage
 * error here: this script is never run by CI, so "quietly do nothing" would only
 * ever hide a typo.
 *
 * Exit codes: 0 recorded · 1 recording or redaction failed · 2 usage.
 *
 * The tables in §2 are the entire redaction configuration. Keep them readable:
 * a rule nobody can find is a rule nobody will extend when Jira adds a field.
 */

import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 1. Limits
// ---------------------------------------------------------------------------

/**
 * Bodies larger than this abort the run rather than being truncated. A truncated
 * fixture is a corrupt fixture — the guards would be asserted against half a JSON
 * document — and an unbounded read is how a recorder eats a machine's memory on
 * an attachment download. Raise it deliberately with `--max-body-bytes`.
 */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Statuses whose Response constructor rejects a body outright. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Rows a paged scenario asks for. Small: a fixture has to stay reviewable. */
const PAGE_SIZE = 5;

// ---------------------------------------------------------------------------
// 2. The placeholder vocabulary (TESTING.md §Fixtures) and what triggers it
// ---------------------------------------------------------------------------

/** Every recorded site collapses to this one hostname. */
const PLACEHOLDER_SITE = 'example.atlassian.net';

/** The bare tenant label, for the site name outside a hostname. */
const PLACEHOLDER_LABEL = 'example';

/** `user-1@example.invalid`, `user-2@…` — minted in first-seen order. */
const mintEmailPlaceholder = (n) => `user-${String(n)}@example.invalid`;

/** `5b10a2844c20165700ede2NN` — the 24-char accountId TESTING.md names. */
const mintAccountPlaceholder = (n) => `5b10a2844c20165700ede2${pad2(n)}`;

/**
 * `557058:00000000-0000-0000-0000-0000000000NN` — the OTHER accountId format.
 * TESTING.md requires both formats to be replaced but its vocabulary sentence
 * only names the 24-char one; collapsing a `nnnnnn:uuid` id into a 24-char
 * placeholder would destroy the very shape a fixture exists to preserve, so the
 * second form gets a format-preserving stand-in. See the handoff's doc delta.
 */
const mintLegacyAccountPlaceholder = (n) =>
  `557058:00000000-0000-0000-0000-${pad2(n).padStart(12, '0')}`;

/** `User 1`, `User 2` — one per distinct real display name. */
const mintDisplayNamePlaceholder = (n) => `User ${String(n)}`;

/** Avatars are per-user URLs (often a gravatar hash of the email). All go. */
const avatarPlaceholder = (size) => `https://${PLACEHOLDER_SITE}/avatar/${size}`;

/** An email anywhere in a key, a value or a URL. */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** Both documented accountId formats (JIRA-API.md §Users). */
const ACCOUNT_RE =
  /\b[0-9a-f]{24}\b|\b\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The placeholders themselves, so a second pass is a no-op instead of a re-mint. */
const PLACEHOLDER_EMAIL_RE = /^user-\d+@example\.invalid$/;
const PLACEHOLDER_ACCOUNT_RE =
  /^(?:5b10a2844c20165700ede2[0-9a-f]{2}|\d{6}:0{8}-0{4}-0{4}-0{4}-0{10}\d{2})$/;
const PLACEHOLDER_DISPLAY_NAME_RE = /^User \d+$/;

/** `eyJ…` — a JWT is never workspace data worth keeping. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

/** Atlassian's own token prefixes (API tokens, scoped tokens, app passwords). */
const ATLASSIAN_TOKEN_RE = /\b(?:ATATT|ATCTT|ATBB)[A-Za-z0-9_\-=.+/]{16,}/g;

/**
 * Keys whose value is a credential. The property is DROPPED, not masked: the
 * fixture PII lint fails on the presence of the key itself, and a fixture has no
 * use for a header it must never replay.
 */
const CREDENTIAL_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-atlassian-token-auth',
  'apitoken',
  'api_token',
  'password',
]);

/** Keys carrying a human name. */
const DISPLAY_NAME_KEYS = new Set(['displayname']);

/** Keys carrying an address, even when the value is not email-shaped. */
const EMAIL_KEYS = new Set(['emailaddress', 'email']);

/** Keys carrying an accountId, so the harvest pass can learn it by name. */
const ACCOUNT_ID_KEYS = new Set(['accountid', 'x-aaccountid', 'authoraccountid']);

/** A map of size → avatar URL. Every value is replaced. */
const AVATAR_MAP_KEYS = new Set(['avatarurls']);

/** A single avatar URL. */
const AVATAR_URL_KEYS = new Set(['avatarurl']);

/** Query parameters whose value is a credential wherever the URL points. */
const SENSITIVE_QUERY_KEY_RE =
  /^(?:os_authtype|os_username|os_password|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret|jwt|jsessionid|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;

/**
 * Keys whose value is legitimately an opaque high-entropy blob. Everything else
 * that looks like one fails the run — see {@link isOpaqueBlob}. Extend this the
 * way TESTING.md describes extending the placeholder vocabulary: deliberately,
 * because a wrong entry here is a credential nobody will ever notice again.
 */
const OPAQUE_ALLOWED_KEYS = new Set(['nextpagetoken', 'pagetoken', 'continuationtoken']);

// ---------------------------------------------------------------------------
// 3. Errors
// ---------------------------------------------------------------------------

/** Bad invocation: exits 2, prints usage-shaped advice. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Recording or redaction refused to continue: exits 1, nothing was written. */
class RecorderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecorderError';
  }
}

// ---------------------------------------------------------------------------
// 4. Small helpers
// ---------------------------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** A string with enough entropy to be a credential and no other explanation. */
function isOpaqueBlob(value) {
  return (
    typeof value === 'string' &&
    value.length >= 40 &&
    /^[A-Za-z0-9+/=_-]+$/.test(value) &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value)
  );
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** Sort object keys everywhere so a re-record diffs as data, not as ordering. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 5. The redactor
// ---------------------------------------------------------------------------

/**
 * Build the fixture redactor around the repo's own secret scrubber.
 *
 * `scrub` is `Redactor.redactString` from `core/redact.ts` — registered secrets
 * plus credential shapes. The walk here is NOT `Redactor.redact`: that one masks
 * a value where it stands, and a fixture needs the opposite of that — a
 * placeholder shaped like what it replaced, names learned from the keys that
 * name them and then swept out of free prose, and credential-bearing keys
 * removed rather than masked, because the fixture PII lint fails on the key
 * (D71).
 */
function createFixtureRedactor({ scrub, hosts, labels, placeholder }) {
  const emails = new Map();
  const accounts = new Map();
  const names = new Map();
  const warnings = [];
  const stats = {
    hostHits: 0,
    labelHits: 0,
    credentialShapeHits: 0,
    tokenShapeHits: 0,
    droppedKeys: 0,
    avatarsReplaced: 0,
  };

  const hostPatterns = [...hosts]
    .filter((host) => host.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((host) => new RegExp(escapeRegExp(host), 'gi'));

  const labelPatterns = [...labels]
    .filter((label) => label.length >= 4)
    .map((label) => new RegExp(`\\b${escapeRegExp(label)}\\b`, 'gi'));

  const stable = (map, key, mint, max) => {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    if (map.size >= max) {
      throw new RecorderError(
        `More than ${String(max)} distinct values need a placeholder from the same family; ` +
          'the vocabulary cannot mint a stable id past that. Record a smaller page ' +
          '(--issue / a narrower --jql) so the fixture stays reviewable.',
      );
    }
    const minted = mint(map.size + 1);
    map.set(key, minted);
    return minted;
  };

  /** Secrets and site identity only — safe for the operator's terminal. */
  const plain = (text) => {
    let out = scrub(text);
    if (out !== text) stats.credentialShapeHits += 1;
    for (const pattern of hostPatterns) {
      out = out.replace(pattern, () => {
        stats.hostHits += 1;
        return PLACEHOLDER_SITE;
      });
    }
    for (const pattern of labelPatterns) {
      out = out.replace(pattern, () => {
        stats.labelHits += 1;
        return PLACEHOLDER_LABEL;
      });
    }
    const before = out;
    out = out.replace(JWT_RE, placeholder).replace(ATLASSIAN_TOKEN_RE, placeholder);
    if (out !== before) stats.tokenShapeHits += 1;
    return out;
  };

  /**
   * Names harvested from `displayName` keys, longest first, so "Maria Petrova"
   * is replaced before a colleague called "Maria". Short names are deliberately
   * NOT free-text needles — replacing every "Bob" in a body would corrupt the
   * fixture, and a fixture nobody trusts is a fixture nobody uses.
   */
  const nameNeedles = [];
  const MIN_NAME_NEEDLE = 4;

  const learnName = (real) => {
    const already = names.has(real);
    const minted = stable(names, real, mintDisplayNamePlaceholder, 999);
    if (!already && real.length >= MIN_NAME_NEEDLE) {
      nameNeedles.push(real);
      nameNeedles.sort((a, b) => b.length - a.length);
    } else if (!already) {
      // The `displayName` field itself is still replaced — only the free-text
      // sweep declines. Say so out loud: a name this short surviving inside an
      // ADF comment is invisible to the fixture PII lint, which knows email
      // shapes, accountIds, hostnames and credential keys, not first names.
      warnings.push(
        `a display name shorter than ${String(MIN_NAME_NEEDLE)} characters was not swept from free text; ` +
          'check the fixture by hand, or rename the account on the scratch site',
      );
    }
    return minted;
  };

  /**
   * Pass one: learn who is in this capture BEFORE rewriting any of it.
   *
   * A display name is only recognisable by the key it sits under, but it shows
   * up again as prose — "Escalated by Maria Petrova" inside an ADF text node, a
   * comment, a changelog `fromString`. Harvesting first means the prose gets the
   * same placeholder as the user object, and means it does not matter whether
   * the prose appears before or after the `displayName` that explains it.
   */
  const harvest = (node, key) => {
    const lowerKey = key === undefined ? undefined : key.toLowerCase();
    if (lowerKey !== undefined && CREDENTIAL_KEYS.has(lowerKey)) return;
    if (typeof node === 'string') {
      if (node === '' || lowerKey === undefined) return;
      if (DISPLAY_NAME_KEYS.has(lowerKey) && !PLACEHOLDER_DISPLAY_NAME_RE.test(node)) {
        learnName(node);
        return;
      }
      if (EMAIL_KEYS.has(lowerKey) && !PLACEHOLDER_EMAIL_RE.test(node)) {
        stable(emails, node.toLowerCase(), mintEmailPlaceholder, 999);
        return;
      }
      if (ACCOUNT_ID_KEYS.has(lowerKey) && !PLACEHOLDER_ACCOUNT_RE.test(node)) {
        stable(
          accounts,
          node.toLowerCase(),
          node.includes(':') ? mintLegacyAccountPlaceholder : mintAccountPlaceholder,
          99,
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, key);
      return;
    }
    if (isPlainObject(node)) {
      for (const [childKey, child] of Object.entries(node)) harvest(child, childKey);
    }
  };

  /** Everything `plain` does, plus the PII vocabulary that mints stable ids. */
  const text = (value) => {
    let out = plain(value);
    for (const needle of nameNeedles) {
      if (!out.includes(needle)) continue;
      out = out.split(needle).join(names.get(needle));
    }
    out = out.replace(EMAIL_RE, (match) =>
      PLACEHOLDER_EMAIL_RE.test(match)
        ? match
        : stable(emails, match.toLowerCase(), mintEmailPlaceholder, 999),
    );
    out = out.replace(ACCOUNT_RE, (match) => {
      if (PLACEHOLDER_ACCOUNT_RE.test(match)) return match;
      const mint = match.includes(':')
        ? mintLegacyAccountPlaceholder
        : mintAccountPlaceholder;
      return stable(accounts, match.toLowerCase(), mint, 99);
    });
    if (isHttpUrl(out)) out = redactUrl(out);
    return out;
  };

  /**
   * A URL's query is the one place a credential hides behind a name nobody
   * registered — a signed media link, a `?token=` on a redirect. Named
   * parameters go by name; anything else whose value is an opaque blob goes on
   * shape, which is the same rule `assertClean` would fail the run on.
   */
  const redactUrl = (value) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return value;
    }
    let changed = false;
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = 'redacted';
      parsed.password = 'redacted';
      changed = true;
      warnings.push(
        'a URL carried inline userinfo (user:password@host); it was replaced',
      );
    }
    for (const key of [...parsed.searchParams.keys()]) {
      const current = parsed.searchParams.get(key);
      if (SENSITIVE_QUERY_KEY_RE.test(key) || isOpaqueBlob(current)) {
        parsed.searchParams.set(key, placeholder);
        changed = true;
        stats.tokenShapeHits += 1;
      }
    }
    return changed ? parsed.href : value;
  };

  /**
   * Walk a captured payload. Keys are redacted as well as values — a secret used
   * as a property name leaks exactly as loudly as one used as a value — and the
   * key-aware rules run first, because `{"displayName": "Bob"}` is only PII by
   * virtue of the key it sits under.
   */
  const walk = (node, path, key) => {
    const lowerKey = key === undefined ? undefined : key.toLowerCase();

    if (lowerKey !== undefined && AVATAR_MAP_KEYS.has(lowerKey) && isPlainObject(node)) {
      const out = {};
      for (const size of Object.keys(node)) {
        out[text(size)] = avatarPlaceholder(text(size));
        stats.avatarsReplaced += 1;
      }
      return out;
    }
    if (
      lowerKey !== undefined &&
      AVATAR_URL_KEYS.has(lowerKey) &&
      typeof node === 'string'
    ) {
      stats.avatarsReplaced += 1;
      return avatarPlaceholder('default');
    }
    if (
      lowerKey !== undefined &&
      DISPLAY_NAME_KEYS.has(lowerKey) &&
      typeof node === 'string'
    ) {
      if (node === '' || PLACEHOLDER_DISPLAY_NAME_RE.test(node)) return node;
      return learnName(node);
    }
    if (lowerKey !== undefined && EMAIL_KEYS.has(lowerKey) && typeof node === 'string') {
      if (node === '') return node;
      return PLACEHOLDER_EMAIL_RE.test(node)
        ? node
        : stable(emails, node.toLowerCase(), mintEmailPlaceholder, 999);
    }

    if (typeof node === 'string') return text(node);
    if (typeof node === 'number' || typeof node === 'boolean' || node === null)
      return node;
    if (Array.isArray(node))
      return node.map((item, index) =>
        walk(item, `${path}[${String(index)}]`, undefined),
      );
    if (isPlainObject(node)) {
      const out = {};
      for (const [childKey, child] of Object.entries(node)) {
        if (CREDENTIAL_KEYS.has(childKey.toLowerCase())) {
          stats.droppedKeys += 1;
          warnings.push(
            `${path}.${childKey}: credential-bearing key dropped from the fixture`,
          );
          continue;
        }
        if (child === undefined) continue;
        out[text(childKey)] = walk(child, `${path}.${childKey}`, childKey);
      }
      return out;
    }
    // Nothing else can reach here: captures are built out of JSON primitives.
    return placeholder;
  };

  return {
    plain,
    text,
    harvest,
    walk,
    warnings,
    stats,
    counts: () => ({
      emails: emails.size,
      accountIds: accounts.size,
      displayNames: names.size,
    }),
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// 6. The adversary: refuse to write anything that still looks sensitive
// ---------------------------------------------------------------------------

/**
 * Re-inspect the redacted document and throw with every finding at once. This is
 * the in-script mirror of the fixture PII lint TESTING.md specifies, run BEFORE
 * the write rather than after the commit — the lint is the thing that fails the
 * build, this is the thing that stops the leak.
 */
function assertClean(document, { secrets, hosts, labels, allowOpaqueKeys }) {
  const findings = [];
  const needles = [];
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    needles.push(secret);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) needles.push(encoded);
  }
  const hostNeedles = [...hosts, ...labels].filter((entry) => entry.length >= 4);
  const allowedOpaque = new Set(
    [...OPAQUE_ALLOWED_KEYS, ...allowOpaqueKeys].map((key) => key.toLowerCase()),
  );

  const checkString = (value, path, key) => {
    for (const needle of needles) {
      if (value.includes(needle)) {
        findings.push(`${path}: a registered secret survived redaction`);
        return;
      }
    }
    for (const needle of hostNeedles) {
      if (value.toLowerCase().includes(needle.toLowerCase())) {
        findings.push(`${path}: the real site name (${needle}) survived redaction`);
        return;
      }
    }
    for (const match of value.matchAll(EMAIL_RE)) {
      if (!PLACEHOLDER_EMAIL_RE.test(match[0])) {
        findings.push(`${path}: email-shaped string "${match[0]}" is not a placeholder`);
        return;
      }
    }
    for (const match of value.matchAll(ACCOUNT_RE)) {
      if (!PLACEHOLDER_ACCOUNT_RE.test(match[0])) {
        findings.push(
          `${path}: accountId-shaped string "${match[0]}" is not a placeholder`,
        );
        return;
      }
    }
    if (JWT_RE.test(value)) {
      JWT_RE.lastIndex = 0;
      findings.push(`${path}: JWT-shaped token survived redaction`);
      return;
    }
    JWT_RE.lastIndex = 0;
    if (ATLASSIAN_TOKEN_RE.test(value)) {
      ATLASSIAN_TOKEN_RE.lastIndex = 0;
      findings.push(`${path}: Atlassian token prefix survived redaction`);
      return;
    }
    ATLASSIAN_TOKEN_RE.lastIndex = 0;
    if (isOpaqueBlob(value) && !allowedOpaque.has(String(key ?? '').toLowerCase())) {
      findings.push(
        `${path}: high-entropy value under key "${String(key ?? '(none)')}" could not be ` +
          'classified. Redact it, or add the key to OPAQUE_ALLOWED_KEYS / pass ' +
          '--allow-opaque-key once you have confirmed it is not a credential',
      );
    }
  };

  const walk = (node, path, key) => {
    if (typeof node === 'string') {
      checkString(node, path, key);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${String(index)}]`, key));
      return;
    }
    if (isPlainObject(node)) {
      for (const [childKey, child] of Object.entries(node)) {
        if (CREDENTIAL_KEYS.has(childKey.toLowerCase())) {
          findings.push(
            `${path}.${childKey}: credential-bearing key reached the document`,
          );
          continue;
        }
        checkString(childKey, `${path}.${childKey} (key)`, childKey);
        walk(child, `${path}.${childKey}`, childKey);
      }
    }
  };

  walk(document, '$', undefined);

  if (findings.length > 0) {
    throw new RecorderError(
      `Redaction is incomplete — NOTHING was written. ${String(findings.length)} finding(s):\n` +
        findings.map((finding) => `  ${finding}`).join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------
// 7. The capture wrapper
// ---------------------------------------------------------------------------

function headerObject(source) {
  const out = {};
  if (source === undefined || source === null) return out;
  if (Array.isArray(source)) {
    for (const pair of source) out[String(pair[0]).toLowerCase()] = String(pair[1]);
    return out;
  }
  if (typeof source.forEach === 'function' && typeof source.get === 'function') {
    source.forEach((value, name) => {
      out[String(name).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const [name, value] of Object.entries(source)) {
    out[String(name).toLowerCase()] = String(value);
  }
  return out;
}

function headerPairs(source) {
  return Object.entries(headerObject(source));
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * A body that is not decodable UTF-8 (an attachment download, a PNG avatar)
 * becomes a descriptor. Never the bytes, and never base64 of the bytes: a
 * fixture is a reviewable text file, and "a reviewer cannot read it" is the same
 * failure mode as "a reviewer did not notice the token in it". No content hash
 * either — a hash of a short body is a lookup key for the body.
 */
function binaryDescriptor(bytes, contentType, why) {
  return {
    $binary: {
      bytes,
      ...(contentType === undefined ? {} : { contentType }),
      why,
    },
  };
}

function decodeBody(bytes, contentType, warnings, where) {
  if (bytes.byteLength === 0) return undefined;
  const asText = decodeUtf8(bytes);
  if (asText === undefined) {
    warnings.push(`${where}: body is not UTF-8; recorded as a descriptor`);
    return binaryDescriptor(bytes.byteLength, contentType, 'not decodable as UTF-8');
  }
  if (/json/i.test(contentType ?? '')) {
    try {
      return JSON.parse(asText);
    } catch (error) {
      warnings.push(
        `${where}: content-type claims JSON but the body did not parse (${describeError(error)}); ` +
          'recorded as text',
      );
      return { $text: asText };
    }
  }
  try {
    return JSON.parse(asText);
  } catch {
    return { $text: asText };
  }
}

function describeRequestBody(body, warnings) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return { $text: body };
    }
  }
  const tag = Object.prototype.toString.call(body);
  if (tag === '[object FormData]') {
    const parts = [];
    for (const [name, value] of body.entries()) {
      if (value !== null && typeof value === 'object' && typeof value.size === 'number') {
        parts.push({
          name,
          kind: 'file',
          filename: typeof value.name === 'string' ? value.name : '',
          contentType: typeof value.type === 'string' ? value.type : '',
          bytes: value.size,
        });
      } else {
        parts.push({ name, kind: 'field', bytes: String(value).length });
      }
    }
    warnings.push(
      'a multipart request body was recorded as a part list, without contents',
    );
    return { $multipart: parts };
  }
  if (ArrayBuffer.isView(body)) {
    return binaryDescriptor(body.byteLength, undefined, 'binary request body');
  }
  if (body instanceof ArrayBuffer) {
    return binaryDescriptor(body.byteLength, undefined, 'binary request body');
  }
  if (typeof body.getReader === 'function') {
    return { $unrecorded: 'streaming request body' };
  }
  return { $unrecorded: `request body of type ${tag}` };
}

async function readBodyBytes(response, maxBodyBytes) {
  const stream = response.body;
  if (stream !== null && stream !== undefined && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw new RecorderError(
          `A response body exceeded --max-body-bytes (${String(maxBodyBytes)}); nothing was ` +
            'written. A fixture that large is not reviewable — narrow the scenario, or ' +
            'raise the cap deliberately.',
        );
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBodyBytes) {
    throw new RecorderError(
      `A response body exceeded --max-body-bytes (${String(maxBodyBytes)}); nothing was written.`,
    );
  }
  return buffer;
}

/**
 * Wrap the fetch seam. `inner` is whatever fetch was installed — the runtime's,
 * or an injected fake when this script is verifying itself. The wrapper opens no
 * socket of its own; it records what crossed the one `core/http.ts` opened.
 */
function createCapture({ maxBodyBytes, warnings }) {
  const exchanges = [];
  const state = { fatal: undefined };

  /**
   * A body over the cap must abort the RUN, but throwing from inside the wrapper
   * would be indistinguishable from a socket error: `core/http.ts` would treat it
   * as a transport failure and retry, and the operator would wait out the whole
   * backoff schedule to be told the same thing three times. Record the verdict
   * and hand back something boring instead; `record()` rethrows it before any
   * write, whether the scenario went on to succeed or to fail.
   */
  const benign = () =>
    new Response('{}', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    });

  const wrap = (inner) => async (input, init) => {
    if (state.fatal !== undefined) return benign();

    // The slot is reserved BEFORE the call so concurrent requests keep their
    // start order; completion order is a property of the network, not of the run.
    const slot = { request: describeRequest(input, init, warnings) };
    exchanges.push(slot);

    let response;
    try {
      response = await inner(input, init);
    } catch (error) {
      slot.error = {
        name: error?.name ?? 'Error',
        message: String(error?.message ?? error),
      };
      throw error;
    }

    const status = typeof response.status === 'number' ? response.status : 0;
    if (status < 200 || status > 599) {
      // Outside what the Response constructor accepts, so it cannot be replayed:
      // pass the original through untouched rather than consuming its body.
      slot.response = {
        status,
        headers: headerObject(response.headers),
        body: { $unrecorded: 'status outside 200-599; body passed through unread' },
      };
      return response;
    }

    let bytes;
    try {
      bytes = await readBodyBytes(response, maxBodyBytes);
    } catch (error) {
      state.fatal = error;
      slot.response = {
        status,
        headers: headerObject(response.headers),
        body: { $unrecorded: 'body exceeded the cap; the run was aborted' },
      };
      return benign();
    }
    const headers = headerObject(response.headers);
    slot.response = {
      status,
      statusText: typeof response.statusText === 'string' ? response.statusText : '',
      headers,
      body: decodeBody(
        bytes,
        headers['content-type'],
        warnings,
        `response ${String(status)}`,
      ),
    };

    const useNullBody = bytes.byteLength === 0 || NULL_BODY_STATUSES.has(status);
    return new Response(useNullBody ? null : bytes, {
      status,
      statusText: slot.response.statusText,
      headers: headerPairs(response.headers),
    });
  };

  return { exchanges, wrap, state };
}

function describeRequest(input, init, warnings) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : String(input?.url ?? '');
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  const headers = headerObject(init?.headers ?? input?.headers);
  const dropped = [];
  for (const name of Object.keys(headers)) {
    if (CREDENTIAL_KEYS.has(name)) {
      delete headers[name];
      dropped.push(name);
    }
  }
  const body = describeRequestBody(init?.body, warnings);
  return {
    method,
    url,
    headers,
    ...(dropped.length > 0 ? { headersDropped: dropped.sort() } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

// ---------------------------------------------------------------------------
// 8. Scenarios
// ---------------------------------------------------------------------------

/**
 * What can be recorded. Each entry drives the REAL `api/*` call path, so the
 * captured request carries the field lists, expands and page sizes the server
 * actually sends — a fixture recorded against a hand-written URL would be a
 * fixture for a request nobody makes.
 *
 * `needs` names the required `--flag`s. `run` returns a note for the operator.
 */
const SCENARIOS = [
  {
    name: 'search-page',
    needs: ['jql'],
    summary: 'JQL search: page 1, plus page 2 when the site returns a nextPageToken',
    async run({ api, jira, params }) {
      const first = await api.search.searchIssues({
        jira,
        jql: params.jql,
        maxResults: PAGE_SIZE,
        maxPages: 1,
      });
      if (first.nextPageToken === undefined) {
        return 'only one page: this JQL has no second page, so the fixture does not cover the cursor case (TESTING.md wants both)';
      }
      await api.search.searchIssues({
        jira,
        jql: params.jql,
        maxResults: PAGE_SIZE,
        maxPages: 1,
        nextPageToken: first.nextPageToken,
      });
      return 'recorded page 1 (with nextPageToken) and page 2';
    },
  },
  {
    name: 'issue-detail',
    needs: ['issue'],
    summary:
      'One issue with changelog + rendered fields (issuelinks / fixVersions / ADF)',
    async run({ api, jira, params }) {
      await api.issues.getIssue({
        jira,
        issue: params.issue,
        expand: ['changelog', 'renderedFields'],
      });
      return "check the fixture covers TESTING.md's ADF set (table, codeBlock, panel, media, taskList)";
    },
  },
  {
    name: 'comments',
    needs: ['issue'],
    summary: 'A page of comments (classic startAt pagination, ADF bodies)',
    async run({ api, jira, params }) {
      await api.issues.listComments({ jira, issue: params.issue, maxResults: PAGE_SIZE });
    },
  },
  {
    name: 'changelog',
    needs: ['issue'],
    summary: 'A page of changelog entries',
    async run({ api, jira, params }) {
      await api.issues.listChangelog({
        jira,
        issue: params.issue,
        maxResults: PAGE_SIZE,
      });
    },
  },
  {
    name: 'transitions',
    needs: ['issue'],
    summary: 'Available transitions with their screens (expand=transitions.fields)',
    async run({ api, jira, params }) {
      await api.issues.listTransitions({ jira, issue: params.issue, expandFields: true });
    },
  },
  {
    name: 'createmeta',
    needs: ['project'],
    summary: "Create screen: the project issue-type list, then one type's fields",
    async run({ api, jira, params }) {
      const types = await api.meta.listCreateMetaIssueTypes({
        jira,
        project: params.project,
        pageSize: PAGE_SIZE,
        maxPages: 1,
      });
      const first = types.items[0];
      if (first === undefined) {
        return 'the project exposed no issue types; only the issue-type page was recorded';
      }
      await api.meta.getCreateMeta({
        jira,
        project: params.project,
        issueTypeId: first.id,
        pageSize: PAGE_SIZE,
        maxPages: 1,
      });
      return `recorded the create screen for issue type ${first.id}`;
    },
  },
  {
    name: 'fields',
    needs: [],
    summary: 'The field catalog, including custom fields',
    async run({ api, jira }) {
      await api.meta.listFields({ jira });
      return 'confirm the fixture actually contains customfield_* rows';
    },
  },
  {
    name: 'projects',
    needs: [],
    summary: 'A page of projects',
    async run({ api, jira }) {
      await api.meta.listProjects({ jira, pageSize: PAGE_SIZE, maxPages: 1 });
    },
  },
  {
    name: 'user-search',
    needs: ['query'],
    summary: 'User search (every row is PII; the vocabulary does the work here)',
    async run({ api, jira, params }) {
      await api.users.searchUsers({
        jira,
        query: params.query,
        maxResults: PAGE_SIZE,
        maxPages: 1,
      });
    },
  },
  {
    name: 'myself',
    needs: [],
    summary: 'GET /myself — the identity probe doctor and the worklog clock use',
    async run({ api, jira }) {
      await api.users.getMyself({ jira });
    },
  },
  {
    name: 'agile',
    needs: [],
    summary: "Agile boards, then the first board's sprints and the first sprint's issues",
    async run({ api, jira, params }) {
      const boards = await api.agile.listBoards({
        jira,
        pageSize: PAGE_SIZE,
        maxPages: 1,
        ...(params.project === undefined ? {} : { projectKeyOrId: params.project }),
      });
      const board = boards.items[0];
      if (board === undefined)
        return 'no boards on this site; only the board page was recorded';
      const sprints = await api.agile.listSprints({
        jira,
        boardId: board.id,
        pageSize: PAGE_SIZE,
        maxPages: 1,
      });
      const sprint = sprints.items[0];
      if (sprint === undefined) {
        return `board ${String(board.id)} has no sprints (kanban?); board + sprint pages recorded`;
      }
      await api.agile.listSprintIssues({
        jira,
        sprintId: sprint.id,
        pageSize: PAGE_SIZE,
        maxPages: 1,
      });
      return `recorded boards, sprints of board ${String(board.id)} and issues of sprint ${String(sprint.id)}`;
    },
  },
  {
    name: 'error-400',
    needs: [],
    summary: 'A field-validation 400: deliberately invalid JQL',
    async run({ api, jira, params }) {
      const jql = params.jql ?? 'project = ';
      return `Jira rejected the request as expected — ${await expectRejection(
        api.search.searchIssues({ jira, jql, maxResults: 1, maxPages: 1 }),
        'error-400',
      )}`;
    },
  },
  {
    name: 'error-404',
    needs: [],
    summary: 'The permission-masked 404: an issue that does not exist (or is invisible)',
    async run({ api, jira, params }) {
      const issue = params.issue ?? 'ZZZ-999999';
      return `Jira rejected the request as expected — ${await expectRejection(
        api.issues.getIssue({ jira, issue }),
        'error-404',
      )}`;
    },
  },
];

/**
 * An error scenario that SUCCEEDS has recorded the wrong thing, and a fixture
 * that claims to be a 404 but holds a 200 is worse than no fixture.
 */
async function expectRejection(promise, what) {
  try {
    await promise;
  } catch (error) {
    return describeError(error);
  }
  throw new RecorderError(
    `${what}: Jira ACCEPTED the request that was supposed to fail, so the recorded ` +
      'exchange is not the error shape this scenario claims. Nothing was written; ' +
      'adjust the scenario inputs.',
  );
}

// ---------------------------------------------------------------------------
// 9. Assembly — the same wiring src/index.ts does, minus the transport
// ---------------------------------------------------------------------------

async function loadBuild() {
  try {
    const [clock, rng, settings, redact, log, http, host, telemetry, credentials] =
      await Promise.all([
        import('../build/core/clock.js'),
        import('../build/core/rng.js'),
        import('../build/core/settings.js'),
        import('../build/core/redact.js'),
        import('../build/core/log.js'),
        import('../build/core/http.js'),
        import('../build/core/host.js'),
        import('../build/core/telemetry.js'),
        import('../build/core/credentials.js'),
      ]);
    const [search, issues, meta, users, agile] = await Promise.all([
      import('../build/api/search.js'),
      import('../build/api/issues.js'),
      import('../build/api/meta.js'),
      import('../build/api/users.js'),
      import('../build/api/agile.js'),
    ]);
    return {
      core: { clock, rng, settings, redact, log, http, host, telemetry, credentials },
      api: { search, issues, meta, users, agile },
    };
  } catch (error) {
    throw new UsageError(
      `Cannot load ./build — run \`npm run build\` first.\n  ${describeError(error)}`,
    );
  }
}

/** Every spelling of the site that must not survive into a fixture. */
function siteIdentity({ settings, host }) {
  const hosts = new Set();
  const labels = new Set();
  const add = (raw) => {
    if (typeof raw !== 'string' || raw === '') return;
    const trimmed = raw
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '');
    if (trimmed === '') return;
    hosts.add(trimmed.toLowerCase());
    const label = trimmed.split('.')[0];
    if (label !== undefined && label !== '') labels.add(label.toLowerCase());
  };
  add(settings.site);
  if (host !== undefined) add(host.origin);
  for (const profile of Object.values(settings.profiles ?? {})) add(profile?.site);
  return { hosts: [...hosts], labels: [...labels] };
}

// ---------------------------------------------------------------------------
// 10. Recording
// ---------------------------------------------------------------------------

/**
 * Record one scenario into one file.
 *
 * Exported so the recorder can be driven with an injected `fetchImpl` and a fixed
 * `clock` — that is how its redaction is proven without a live site, and how a
 * future colocated suite could assert the same thing inside `npm run check`.
 */
export async function record(options) {
  const {
    scenario: scenarioName,
    out,
    params = {},
    env = process.env,
    fetchImpl,
    clock: injectedClock,
    force = false,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    allowOpaqueKeys = [],
    note,
    log = () => {},
  } = options;

  const scenario = SCENARIOS.find((candidate) => candidate.name === scenarioName);
  if (scenario === undefined) {
    throw new UsageError(
      `Unknown scenario ${JSON.stringify(String(scenarioName))}. Run with --list to see them.`,
    );
  }
  for (const need of scenario.needs) {
    if (params[need] === undefined || params[need] === '') {
      throw new UsageError(`Scenario "${scenario.name}" needs --${need}.`);
    }
  }
  if (typeof out !== 'string' || out === '') throw new UsageError('--out is required.');
  const outPath = resolve(out);
  if (!outPath.endsWith('.json')) {
    throw new UsageError(
      `--out must name a .json file; got ${relative(REPO_ROOT, outPath)}`,
    );
  }
  // Checked before a single live call: burning a request only to discover the
  // destination is taken is rude, and clobbering a reviewed fixture is worse.
  const exists = await access(outPath).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    throw new UsageError(
      `${relative(REPO_ROOT, outPath)} already exists. Fixtures are reviewed and committed ` +
        'forever, so this script never overwrites one silently — delete it, pick another ' +
        'name, or pass --force.',
    );
  }

  const build = await loadBuild();
  const clock = injectedClock ?? build.core.clock.systemClock;
  const usingProcessEnv = env === process.env;
  const loaded = build.core.settings.loadSettings(
    usingProcessEnv ? { clock } : { env, clock, loadEnvFile: false },
  );
  build.core.settings.assertStartupOk(loaded.report);

  const resolver = build.core.credentials.buildCredentialResolver({
    settings: loaded.settings,
    ...(loaded.host === undefined ? {} : { host: loaded.host }),
    resolveHost: build.core.host.resolveHost,
  });
  const credentials = resolver();

  const redactor = build.core.redact.createRedactor({ secrets: loaded.secrets });
  // The Basic blob is what actually rides on the wire; register it so a stray
  // echo of the header value is caught by a literal, not only by a shape.
  const basic = Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString(
    'base64',
  );
  redactor.addSecret(credentials.apiToken);
  redactor.addSecret(basic);

  const { hosts, labels } = siteIdentity({
    settings: loaded.settings,
    host: loaded.host,
  });
  const fixtureRedactor = createFixtureRedactor({
    scrub: (value) => redactor.redactString(value),
    hosts,
    labels,
    placeholder: build.core.redact.DEFAULT_PLACEHOLDER,
  });

  const warnings = fixtureRedactor.warnings;
  const capture = createCapture({ maxBodyBytes, warnings });

  const logger = build.core.log
    .createLogger({ level: loaded.settings.logLevel, clock, redactor })
    .withCid(build.core.log.NO_CID);
  const jira = build.core.http.createJiraRequest({
    credentials: resolver,
    clock,
    rng: build.core.rng.systemRng,
    logger,
    redactor,
    telemetry: build.core.telemetry.createTelemetry(),
    allowedHosts: loaded.settings.allowedHosts,
    requestTimeoutMs: loaded.settings.requestTimeoutMs,
    callBudgetMs: loaded.settings.callBudgetMs,
    hostConcurrency: loaded.settings.hostConcurrency,
    retryAttempts: loaded.settings.retryAttempts,
  });

  const previousFetch = globalThis.fetch;
  const inner = fetchImpl ?? previousFetch;
  if (typeof inner !== 'function') {
    throw new UsageError('No fetch implementation is available in this runtime.');
  }
  let scenarioNote;
  let scenarioError;
  try {
    globalThis.fetch = capture.wrap(inner);
    scenarioNote = await scenario.run({ api: build.api, jira, params });
  } catch (error) {
    scenarioError = error;
  } finally {
    globalThis.fetch = previousFetch;
  }

  // The capture's own verdict outranks whatever the scenario made of the benign
  // reply it was handed afterwards.
  if (capture.state.fatal !== undefined) throw capture.state.fatal;
  if (scenarioError !== undefined) throw scenarioError;

  if (capture.exchanges.length === 0) {
    throw new RecorderError(
      `Scenario "${scenario.name}" made no HTTP call, so there is nothing to record.`,
    );
  }
  for (const slot of capture.exchanges) {
    if (slot.response === undefined && slot.error === undefined) {
      throw new RecorderError(
        'A request was started but never completed (the run was interrupted); nothing was written.',
      );
    }
  }

  const recordedAt = new Date(clock.now()).toISOString();
  // Two passes, in this order. Pass one learns every person in the capture from
  // the keys that name them; pass two rewrites, and only then can it recognise
  // "Escalated by Maria Petrova" in an ADF text node as the same person as the
  // `displayName` three exchanges further down.
  fixtureRedactor.harvest(capture.exchanges, undefined);
  fixtureRedactor.harvest(params, undefined);
  const exchanges = capture.exchanges.map((slot, index) =>
    sortKeysDeep(fixtureRedactor.walk(slot, `$.exchanges[${String(index)}]`, undefined)),
  );
  const document = {
    scenario: scenario.name,
    synthetic: false,
    recordedBy: 'scripts/record-fixture.mjs',
    recordedAt,
    site: PLACEHOLDER_SITE,
    ...(note === undefined || note === ''
      ? {}
      : { note: fixtureRedactor.text(String(note)) }),
    params: sortKeysDeep(fixtureRedactor.walk(params, '$.params', undefined)),
    exchanges,
  };

  assertClean(document, {
    secrets: [...loaded.secrets, credentials.apiToken, basic],
    hosts,
    labels,
    allowOpaqueKeys,
  });

  const text = `${JSON.stringify(document, null, 2)}\n`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text, { mode: 0o600, flag: force ? 'w' : 'wx' });
  await chmod(outPath, 0o600);

  if (scenarioNote !== undefined)
    log(`note: ${fixtureRedactor.plain(String(scenarioNote))}`);

  return {
    path: outPath,
    bytes: Buffer.byteLength(text),
    exchanges: exchanges.length,
    counts: fixtureRedactor.counts(),
    stats: fixtureRedactor.stats,
    warnings: [...warnings],
  };
}

// ---------------------------------------------------------------------------
// 11. CLI
// ---------------------------------------------------------------------------

const CLI_OPTIONS = {
  scenario: { type: 'string' },
  out: { type: 'string' },
  jql: { type: 'string' },
  issue: { type: 'string' },
  project: { type: 'string' },
  query: { type: 'string' },
  note: { type: 'string' },
  'max-body-bytes': { type: 'string' },
  'allow-opaque-key': { type: 'string', multiple: true },
  force: { type: 'boolean' },
  list: { type: 'boolean' },
  help: { type: 'boolean' },
};

function usage() {
  const rows = SCENARIOS.map((scenario) => {
    const needs =
      scenario.needs.length === 0
        ? ''
        : ` (needs ${scenario.needs.map((need) => `--${need}`).join(' ')})`;
    return `  ${scenario.name.padEnd(14)} ${scenario.summary}${needs}`;
  });
  return [
    'record-fixture — record redacted Jira Cloud fixtures (docs/TESTING.md §Fixtures)',
    '',
    'Usage:',
    '  node scripts/record-fixture.mjs --scenario <name> --out test/fixtures/<name>.json [inputs]',
    '  node scripts/record-fixture.mjs --list',
    '',
    'Scenarios:',
    ...rows,
    '',
    'Inputs: --jql --issue --project --query',
    'Options:',
    '  --note <text>              provenance line stored in the fixture',
    '  --force                    overwrite an existing fixture (never silent)',
    '  --max-body-bytes <n>       cap per response body (default 1 MiB)',
    '  --allow-opaque-key <key>   accept a high-entropy value under this key',
    '',
    'Credentials come from JIRA_SITE / JIRA_EMAIL / JIRA_API_TOKEN, exactly as the',
    'server reads them. Recorded bodies are redacted in memory; nothing reaches the',
    'disk until the whole document passes the leak check.',
  ].join('\n');
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true });
  } catch (error) {
    throw new UsageError(describeError(error));
  }
  const flags = parsed.values;

  if (flags.help === true) {
    console.log(usage());
    return 0;
  }
  if (flags.list === true) {
    for (const scenario of SCENARIOS) {
      const needs = scenario.needs.map((need) => `--${need}`).join(' ');
      console.log(
        `${scenario.name.padEnd(14)} ${scenario.summary}${needs === '' ? '' : ` (needs ${needs})`}`,
      );
    }
    return 0;
  }

  let maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
  if (flags['max-body-bytes'] !== undefined) {
    maxBodyBytes = Number(flags['max-body-bytes']);
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) {
      throw new UsageError('--max-body-bytes must be an integer of at least 1024.');
    }
  }

  const summary = await record({
    scenario: flags.scenario,
    out: flags.out,
    params: {
      ...(flags.jql === undefined ? {} : { jql: flags.jql }),
      ...(flags.issue === undefined ? {} : { issue: flags.issue }),
      ...(flags.project === undefined ? {} : { project: flags.project }),
      ...(flags.query === undefined ? {} : { query: flags.query }),
    },
    force: flags.force === true,
    maxBodyBytes,
    allowOpaqueKeys: flags['allow-opaque-key'] ?? [],
    ...(flags.note === undefined ? {} : { note: flags.note }),
    log: (line) => {
      console.log(line);
    },
  });

  const { counts, stats } = summary;
  console.log(
    `wrote ${relative(REPO_ROOT, summary.path)} (${String(summary.bytes)} bytes, mode 0600)`,
  );
  console.log(
    `  ${String(summary.exchanges)} exchange(s); replaced ${String(stats.hostHits)} host mention(s), ` +
      `${String(counts.emails)} email(s), ${String(counts.accountIds)} accountId(s), ` +
      `${String(counts.displayNames)} display name(s), ${String(stats.avatarsReplaced)} avatar URL(s)`,
  );
  console.log(
    `  dropped ${String(stats.droppedKeys)} credential key(s); masked ${String(stats.credentialShapeHits)} ` +
      `credential shape(s) and ${String(stats.tokenShapeHits)} token shape(s); ` +
      `${String(stats.labelHits)} bare site-name mention(s)`,
  );
  for (const warning of summary.warnings) console.warn(`  warning: ${warning}`);
  console.log(
    '  review before committing: free text (summaries, comments, ADF) is workspace prose ' +
      'this script does not paraphrase — read it for names, customer data and internal URLs.',
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`record-fixture: ${error.message}`);
      console.error('');
      console.error(usage());
      process.exitCode = 2;
    } else {
      console.error(`record-fixture: ${describeError(error)}`);
      process.exitCode = 1;
    }
  }
}
