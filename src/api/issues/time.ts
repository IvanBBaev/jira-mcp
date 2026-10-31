// api/issues/time.ts — worklog time (D16 / CC-23). Pure: it imports nothing
// from the api ring (D517).

import { createJiraError } from '../../core/errors.js';

// ---------------------------------------------------------------------------
// 8. Worklog time (D16 / CC-23)
// ---------------------------------------------------------------------------

/**
 * Format an instant the way Jira's worklog `started` field demands:
 * `2026-08-07T10:00:00.000+0000` — milliseconds mandatory, offset mandatory,
 * `Z` REJECTED (JIRA-API.md §Issue links, worklogs, changelog).
 *
 * The offset is data, not an observation: it arrives as minutes east of UTC and
 * shifts the rendered wall clock accordingly, so the same instant logged by a
 * user in `Asia/Kolkata` reads `15:30+0530` while the process runs in UTC.
 */
export function formatJiraTimestamp(epochMs: number, utcOffsetMinutes: number): string {
  const offset = normalizeOffsetMinutes(utcOffsetMinutes);
  if (!Number.isFinite(epochMs)) {
    throw createJiraError({
      kind: 'validation',
      reason: `A timestamp must be finite epoch milliseconds, received ${String(epochMs)}.`,
      remediation: 'Pass the instant as a number of milliseconds since 1970-01-01.',
    });
  }

  const shifted = new Date(epochMs + offset * 60_000);
  const iso = Number.isNaN(shifted.getTime()) ? '' : shifted.toISOString();
  // A year outside 0000-9999 renders as an expanded `+275760-…` form that no
  // fixed slice can read; refuse it rather than emit a truncated timestamp.
  if (iso.length !== 24 || !iso.endsWith('Z')) {
    throw createJiraError({
      kind: 'validation',
      reason: `The timestamp ${String(epochMs)} is outside the range Jira accepts.`,
      remediation: 'Pass a start time within the ordinary calendar range.',
    });
  }

  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${iso.slice(0, 23)}${sign}${hours}${minutes}`;
}

/**
 * Convert an IANA zone name (what `GET /rest/api/3/myself` returns as
 * `timeZone`) into the minutes-east-of-UTC offset {@link addWorklog} wants, AT a
 * given instant — the offset of a zone is not a constant, it moves with DST.
 *
 * D16's fallback lives here: an unknown or unsupported zone yields the HOST
 * offset rather than throwing, because a worklog with a slightly wrong offset is
 * still a worklog, while a hard failure loses the user's work entry.
 */
export function utcOffsetMinutesForZone(timeZone: string, atEpochMs: number): number {
  const at = new Date(atEpochMs);
  if (Number.isNaN(at.getTime())) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);

    const read = (type: string): number => {
      const part = parts.find((entry) => entry.type === type);
      return part === undefined ? Number.NaN : Number(part.value);
    };
    // Intl counts years by era (`0000` is `1 BC`); the arithmetic needs the
    // astronomical year.
    const eraYear = read('year');
    const year =
      parts.find((entry) => entry.type === 'era')?.value === 'BC' ? 1 - eraYear : eraYear;
    const month = read('month');
    const day = read('day');
    const hour = read('hour') % 24;
    const minute = read('minute');
    const second = read('second');
    if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) {
      return -at.getTimezoneOffset();
    }

    // Not `Date.UTC`: it maps years 0-99 to 1900-1999, and a `started` in year
    // 0050 then read an offset of decades and failed the ±14h check (CC-922).
    const wall = new Date(0);
    wall.setUTCFullYear(year, month - 1, day);
    wall.setUTCHours(hour, minute, second, 0);
    const asUtc = wall.getTime();
    return Math.round((asUtc - (atEpochMs - at.getMilliseconds())) / 60_000);
  } catch {
    // An invalid zone name throws a RangeError out of Intl; the host offset is
    // the documented fallback (D16).
    return -at.getTimezoneOffset();
  }
}

/**
 * `YYYY-MM-DDTHH:mm[:ss[.sss]]` with an OPTIONAL offset (`Z`, `+02:00`, `+0200`).
 * A space instead of `T` is accepted because models write it; it is normalized
 * away before parsing. The time ranges are pinned here (`23:59:59` and no
 * further) so that a parse failure downstream can only mean an impossible
 * CALENDAR date, which needs a different check — see {@link startedInstant}.
 *
 * Exported because the tool ring validates the same string with it before the
 * call ever reaches here: one pattern, so the schema and the parser cannot
 * disagree about what a `started` value is. The regex carries no `g` flag, so it
 * holds no `lastIndex` state and sharing the instance is safe.
 */
export const WORKLOG_STARTED_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d{1,3})?)(Z|[+-]\d{2}:?\d{2})?$/;

/** An instant plus the offset it must be RENDERED in (D16/CC-23). */
export interface StartedInstant {
  readonly epochMs: number;
  readonly offsetMinutes: number;
}

/**
 * CC-23. Jira's worklog `started` needs an explicit offset and rejects `Z`, so
 * the question is never "what time is it here" but "what does the wall clock
 * read for the user who logged this work".
 *
 * - No `started` at all → the injected clock's now, rendered in the user's zone.
 * - `started` WITHOUT an offset → the caller means their own wall clock, so it
 *   is read IN the user's zone (the provisional UTC reading only picks which
 *   side of a DST change the offset comes from).
 * - `started` WITH an offset → an absolute instant, re-rendered in the user's
 *   zone. Same moment, different wall clock, and never a `Z` on the wire.
 *
 * The zone is data supplied by the caller of this function, never read from the
 * host inside it — which is what lets a test pin `+0530` while the runner is UTC.
 * `undefined` means the string is not a real calendar instant; the tool ring
 * turns that into the validation envelope, because only it knows the argument
 * name to name.
 */
export function startedInstant(
  started: string | undefined,
  timeZone: string,
  nowMs: number,
): StartedInstant | undefined {
  if (started === undefined) {
    return { epochMs: nowMs, offsetMinutes: utcOffsetMinutesForZone(timeZone, nowMs) };
  }

  const match = WORKLOG_STARTED_PATTERN.exec(started);
  if (match === null) return undefined;
  const date = match[1] ?? '';
  const wallClock = `${date}T${match[2] ?? ''}`;
  const suffix = match[3];

  const asUtc = Date.parse(`${wallClock}Z`);
  // A date that does not exist must be REFUSED, not rolled over. V8's parser
  // happily turns 2026-02-30 into 2026-03-02, and silently logging work on the
  // wrong day is worse than an error the caller can fix — so the round trip has
  // to land on the same calendar date the caller wrote.
  if (Number.isNaN(asUtc) || !new Date(asUtc).toISOString().startsWith(`${date}T`)) {
    return undefined;
  }

  if (suffix === undefined) {
    // `asUtc` is off from the real instant by the zone's own offset, so the
    // offset read there can come from the wrong side of a DST change that falls
    // in between — Sydney's 17:00 on the eve of the switch probed +1100 and
    // logged the work an hour early. A second reading at the corrected instant
    // lands on the right side; a wall time inside a spring-forward gap keeps
    // the pre-change offset, i.e. moves forward by the gap (CC-520).
    const provisional = utcOffsetMinutesForZone(timeZone, asUtc);
    const offsetMinutes = utcOffsetMinutesForZone(timeZone, asUtc - provisional * 60_000);
    return { epochMs: asUtc - offsetMinutes * 60_000, offsetMinutes };
  }

  // `+0530` and `+05:30` both mean the same thing; only one of them is ISO.
  const normalized =
    suffix === 'Z' ? 'Z' : `${suffix.slice(0, 3)}:${suffix.slice(suffix.length - 2)}`;
  const epochMs = Date.parse(`${wallClock}${normalized}`);
  if (Number.isNaN(epochMs)) return undefined;
  return { epochMs, offsetMinutes: utcOffsetMinutesForZone(timeZone, epochMs) };
}

function normalizeOffsetMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || Math.abs(minutes) > 14 * 60) {
    throw createJiraError({
      kind: 'validation',
      reason: `utcOffsetMinutes must be a whole number of minutes within ±14 hours, received ${String(minutes)}.`,
      remediation:
        "Pass the offset of the authenticated user's Jira timezone in minutes east " +
        'of UTC (+05:30 is 330); utcOffsetMinutesForZone converts a zone name.',
    });
  }
  return minutes;
}
