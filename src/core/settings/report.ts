// The aggregated startup report (D516): the finding shape every section
// reader emits through an `Add` sink, and the report built from them.

import { docUrl } from '../doc-url.js';
import { createJiraError } from '../errors.js';

/** `error` blocks startup via {@link assertStartupOk}; `warning` never does. */
export type FindingSeverity = 'error' | 'warning';

/** One config problem, machine-stable `code` first. */
export interface StartupFinding {
  readonly severity: FindingSeverity;
  /** Stable code, e.g. `invalid_number`, `token_expiry_warning`. */
  readonly code: string;
  /** Cause, then the recovery action. Never contains a secret VALUE. */
  readonly message: string;
  /** The env var the operator has to edit, when there is one. */
  readonly field?: string;
  /** Extra structured context for the log event (e.g. `daysLeft`). */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Every problem found in one pass over the environment. */
export interface StartupReport {
  /** True iff there are zero error-severity findings. */
  readonly ok: boolean;
  readonly findings: readonly StartupFinding[];
  readonly errors: readonly StartupFinding[];
  readonly warnings: readonly StartupFinding[];
  /** Worst severity present, or `undefined` when the report is clean. */
  readonly worst?: FindingSeverity;
}

/** The sink every section reader reports into, in reading order. */
export type Add = (finding: StartupFinding) => void;

/** Group findings into the aggregated report shape. */
export function buildReport(findings: readonly StartupFinding[]): StartupReport {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const worst: FindingSeverity | undefined =
    errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : undefined;
  return {
    ok: errors.length === 0,
    findings,
    errors,
    warnings,
    ...(worst === undefined ? {} : { worst }),
  };
}

/** Human-readable rendering; also the body of the `assertStartupOk` error. */
export function formatStartupReport(report: StartupReport): string {
  const lines: string[] = [];
  if (report.errors.length > 0) {
    lines.push(`Configuration errors (${String(report.errors.length)}):`);
    for (const finding of report.errors)
      lines.push(`  - [${finding.code}] ${finding.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push(`Configuration warnings (${String(report.warnings.length)}):`);
    for (const finding of report.warnings)
      lines.push(`  - [${finding.code}] ${finding.message}`);
  }
  if (lines.length === 0) lines.push('Configuration OK.');
  return lines.join('\n');
}

/**
 * Fail closed on error-severity findings. Warnings pass — a token expiring in
 * three weeks must not stop a server that still works today.
 *
 * Throws `JiraError { kind: 'config' }`; the aggregated text is the message, so
 * one failed start shows every problem at once.
 */
export function assertStartupOk(report: StartupReport): void {
  if (report.ok) return;
  throw createJiraError({
    kind: 'config',
    reason: `Invalid configuration:\n${formatStartupReport(report)}`,
    retryable: false,
    remediation: `Fix the JIRA_* variables listed above (names and defaults: ${docUrl('CONFIGURATION.md', '')}), then restart. \`jira-mcp-ai doctor\` prints the same report without starting the server.`,
  });
}
