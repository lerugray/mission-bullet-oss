// ISO week math tests (mb-009).
import { describe, expect, test } from "bun:test";
import {
  formatIsoWeek,
  isoDateRangeIter,
  isoWeekDateRange,
  isoWeekOf,
  nextMondayAfter,
  parseIsoWeek,
} from "../src/isoweek";
import { monthDateRange, nextMonthAfter } from "../src/month";

describe("isoWeekOf + formatIsoWeek", () => {
  test("mid-year Tuesday", () => {
    expect(formatIsoWeek(new Date("2026-04-21T12:00:00Z"))).toBe("2026-W17");
  });

  test("year-boundary: Jan 1 belongs to prior year's last week when it's Fri+", () => {
    // Jan 1 2027 is a Friday → ISO 2026-W53 (the week that contains
    // Dec 28 Mon through Jan 3 Sun).
    const { year, week } = isoWeekOf(new Date("2027-01-01T12:00:00Z"));
    expect(year).toBe(2026);
    expect(week).toBe(53);
  });

  test("mid-year Sunday still in same week (ISO weeks end Sunday)", () => {
    expect(formatIsoWeek(new Date("2026-04-26T23:00:00Z"))).toBe("2026-W17");
  });
});

describe("parseIsoWeek", () => {
  test("accepts well-formed spec", () => {
    expect(parseIsoWeek("2026-W17")).toEqual({ year: 2026, week: 17 });
  });

  test("rejects malformed spec", () => {
    expect(() => parseIsoWeek("2026-17")).toThrow();
    expect(() => parseIsoWeek("W17")).toThrow();
    expect(() => parseIsoWeek("2026-W60")).toThrow();
  });
});

describe("isoWeekDateRange + isoDateRangeIter", () => {
  test("gives Monday–Sunday", () => {
    const r = isoWeekDateRange(2026, 17);
    expect(r.start).toBe("2026-04-20");
    expect(r.end).toBe("2026-04-26");
  });

  test("iterator yields all seven days inclusive", () => {
    const days = Array.from(isoDateRangeIter("2026-04-20", "2026-04-26"));
    expect(days).toEqual([
      "2026-04-20",
      "2026-04-21",
      "2026-04-22",
      "2026-04-23",
      "2026-04-24",
      "2026-04-25",
      "2026-04-26",
    ]);
  });
});

describe("nextMondayAfter", () => {
  test("next week's Monday", () => {
    expect(nextMondayAfter("2026-W17")).toBe("2026-04-27");
  });

  test("year rollover (2026-W53 → 2027-W01 Monday)", () => {
    expect(nextMondayAfter("2026-W53")).toBe("2027-01-04");
  });
});

describe("nextMonthAfter + monthDateRange", () => {
  test("mid-year rollover", () => {
    expect(nextMonthAfter("2026-04")).toBe("2026-05");
  });

  test("year rollover (Dec → next Jan)", () => {
    expect(nextMonthAfter("2026-12")).toBe("2027-01");
  });

  test("month date range", () => {
    expect(monthDateRange("2026-04")).toEqual({
      start: "2026-04-01",
      end: "2026-04-30",
    });
    expect(monthDateRange("2024-02")).toEqual({
      start: "2024-02-01",
      end: "2024-02-29", // 2024 is a leap year
    });
  });
});
