// The egress allowlist as the loader assembles it (D516): the operator's
// `JIRA_ALLOWED_HOSTS` split into entries, widened by the OAuth hosts a mode
// needs (D97, D301), and the host resolver's problems as findings.

import type { HostProblem } from '../host.js';
import { originHost } from './env-reader.js';
import type { StartupFinding } from './report.js';

/** A host-resolver problem as a startup finding. */
export function fromHostProblem(problem: HostProblem): StartupFinding {
  return {
    severity: problem.severity,
    code: problem.code,
    message: problem.message,
    field: problem.field,
  };
}

/**
 * The operator's allowlist plus the hostnames of the given OAuth origins, in
 * that order and deduplicated. Hostnames only: `compileAllowlist` matches hosts,
 * and the port an origin may carry is not part of that decision.
 */
export function withOAuthHosts(
  configured: readonly string[],
  origins: readonly string[],
): string[] {
  const out = [...configured];
  for (const origin of origins) {
    const hostname = originHost(origin);
    if (!out.includes(hostname)) out.push(hostname);
  }
  return out;
}

/**
 * Splits `JIRA_ALLOWED_HOSTS` on commas, except inside a slash-delimited regex
 * entry: `/^jira\d{1,3}\.example\.com$/` is one entry, not two broken halves
 * reported as invalid host names (CC-484). An entry that opens with `/` and
 * never closes is kept whole, for the host check to refuse by its own text.
 */
export function splitAllowedHosts(raw: string): string[] {
  const entries: string[] = [];
  let open: string | undefined;
  for (const part of raw.split(',')) {
    if (open !== undefined) {
      open = `${open},${part}`;
      if (part.trimEnd().endsWith('/')) {
        entries.push(open);
        open = undefined;
      }
      continue;
    }
    const trimmed = part.trim();
    if (trimmed.startsWith('/') && (trimmed.length === 1 || !trimmed.endsWith('/'))) {
      open = part;
    } else {
      entries.push(part);
    }
  }
  if (open !== undefined) entries.push(open);
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
