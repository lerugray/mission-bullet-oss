// mission-bullet — ISO 8601 week helpers (mb-005).
//
// Pure functions for computing ISO week numbers, date ranges, and
// formatted specs. `bullet review week` uses these to resolve "the
// current week" or a user-provided "YYYY-WNN" into a concrete
// Mon–Sun date range of entries to load.
//
// ## Why ISO, not US-style (Sun–Sat)?
//
// Entries are date-keyed as `YYYY-MM-DD`, and our `sessions`
// timestamps carry ISO-8601 offsets — ISO-week matches the rest of
// the tool's conventions. The week-boundary preference wasn't
// specified in the task spec; if Sun–Sat is needed, flip the
// `dayNum` offset and week-1-anchor computation below.

import type { ISODate } from "./types";

const ISO_WEEK_SPEC = /^(\d{4})-W(\d{2})$/;

/** The ISO year and week number containing the given date. */
export function isoWeekOf(date: Date): { year: number; week: number } {
  // Work in UTC to sidestep DST/timezone drift — weeks are calendar,
  // not wall-clock.
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Shift to the Thursday of this ISO week. ISO weeks are anchored on
  // Thursday — the week is "of" whichever calendar year contains its
  // Thursday.
  const dayNum = (target.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  // Week 1 is the week containing Jan 4 (equivalently, the one
  // containing the first Thursday of the year).
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - firstThursdayDayNum + 3,
  );
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { year: target.getUTCFullYear(), week };
}

/** Format a date's ISO week as `YYYY-WNN` (defaults to now). */
export function formatIsoWeek(now: Date = new Date()): string {
  const { year, week } = isoWeekOf(now);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Parse `YYYY-WNN`. Throws on malformed input. */
export function parseIsoWeek(spec: string): {
  year: number;
  week: number;
} {
  const m = ISO_WEEK_SPEC.exec(spec);
  if (!m) {
    throw new Error(`Not a valid ISO week spec: "${spec}" (expected YYYY-WNN)`);
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) {
    throw new Error(`ISO week out of range: ${spec}`);
  }
  return { year, week };
}

/**
 * Monday (start) and Sunday (end) of the given ISO week, as
 * `YYYY-MM-DD` ISODate strings.
 */
export function isoWeekDateRange(
  year: number,
  week: number,
): { start: ISODate; end: ISODate } {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(Date.UTC(year, 0, 4 - jan4DayNum));
  const start = new Date(week1Monday);
  start.setUTCDate(start.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    start: formatIsoDate(start),
    end: formatIsoDate(end),
  };
}

function formatIsoDate(d: Date): ISODate {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Iterate ISODate strings from `start` to `end` inclusive. */
export function* isoDateRangeIter(
  start: ISODate,
  end: ISODate,
): Generator<ISODate> {
  const current = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (current.getTime() <= stop.getTime()) {
    yield formatIsoDate(current);
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

/**
 * The Monday of the week immediately after the given ISO week spec.
 * Used by mb-007 to resolve "where do accepted migrations land"
 * (Carroll's rule: migrate forward to the start of the next logical
 * period). `nextMondayAfter("2026-W17")` → `"2026-04-27"`.
 */
export function nextMondayAfter(weekSpec: string): ISODate {
  const { year, week } = parseIsoWeek(weekSpec);
  const { start } = isoWeekDateRange(year, week);
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return formatIsoDate(d);
}
