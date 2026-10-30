// Credentials and the one place an `Authorization` value is produced (D515).

import type { HostRef } from '../types.js';

/** v1 credentials: an Atlassian account plus one of its API tokens. */
export interface BasicCredentials {
  readonly kind: 'basic';
  readonly host: HostRef;
  readonly email: string;
  readonly apiToken: string;
}

/** v2 credentials: a 3LO access token, pointed at the gateway (D92). */
export interface BearerCredentials {
  readonly kind: 'bearer';
  readonly host: HostRef;
  readonly accessToken: string;
}

/**
 * Resolved credentials for one profile.
 *
 * `kind` is required rather than defaulted: a discriminant that may be omitted
 * is a discriminant that gets omitted, and the failure it buys — a bearer token
 * base64'd into a Basic header — is one Jira answers with a 401 that names
 * nothing. Making it mandatory costs one word per construction site and lets the
 * compiler find every one of them.
 */
export type JiraCredentials = BasicCredentials | BearerCredentials;

/**
 * Per-call credential lookup. Profile resolution itself belongs to settings +
 * request context (WP-11/WP-24); the client only asks for the answer, which is
 * why a profile switch needs no change here.
 *
 * It may be async, because the OAuth resolver refreshes: an expired access token
 * is a network round trip away from being a valid one, and the alternative —
 * refreshing in the background and hoping — hands out tokens that were fresh
 * when nobody asked.
 */
export type CredentialResolver = (
  profile?: string,
) => JiraCredentials | Promise<JiraCredentials>;

/**
 * The one place an `Authorization` value is produced.
 *
 * Both schemes go through this switch on purpose: a second producer somewhere
 * else is how a secret ends up formatted by code that never heard of the
 * redactor, and the union makes the switch exhaustive for free — a third
 * credential kind would fail to compile here rather than fall through to a
 * header that is quietly missing.
 */
export function authorizationHeader(creds: JiraCredentials): string {
  switch (creds.kind) {
    case 'basic':
      return `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`, 'utf8').toString('base64')}`;
    case 'bearer':
      return `Bearer ${creds.accessToken}`;
  }
}
