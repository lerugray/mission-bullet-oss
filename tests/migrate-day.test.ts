// `bullet migrate` handler-side helpers (mb-010).
//
// Covers calendar arithmetic, open-task extraction, and the walk-back
// source resolution. The runMigrate end-to-end path uses interactive
// stdin, exercised by manual invocation rather than these tests; the
// engine-side mutations are covered in tests/migrate.test.ts.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  extractOpenTasks,
  findRecentSource,
  previousDayIso,
} from "../src/migrate-day";

const TMP = join(process.cwd(), "tmp-migrate-day-test");
const ENTRIES = join(TMP, "entries");

async function setupTempRepo(): Promise<void> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(ENTRIES, { recursive: true });
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

async function writeEntry(date: string, body: string): Promise<void> {
  const parts = date.split("-");
  const year = parts[0]!;
  const month = parts[1]!;
  const day = parts[2]!;
  const path = join(ENTRIES, year, month, `${day}.md`);
  await mkdir(dirname(path), { recursive: true });
  const content =
    body +
    "\n\n" +
    "<!-- mission-bullet metadata — do not edit by hand -->\n" +
    "---\n" +
    `date: ${date}\n` +
    "status: open\n" +
    "migrated_to: []\n" +
    "sessions: []\n" +
    "---\n";
  await writeFile(path, content, "utf8");
}

describe("previousDayIso", () => {
  test("steps back one day in the middle of a month", () => {
    expect(previousDayIso("2026-04-23")).toBe("2026-04-22");
  });

  test("crosses month boundary correctly", () => {
    expect(previousDayIso("2026-05-01")).toBe("2026-04-30");
  });

  test("crosses year boundary correctly", () => {
    expect(previousDayIso("2026-01-01")).toBe("2025-12-31");
  });

  test("handles leap-year Feb 29 -> Feb 28", () => {
    // 2024 is a leap year — 2024-03-01 → 2024-02-29.
    expect(previousDayIso("2024-03-01")).toBe("2024-02-29");
    // 2026 is not — 2026-03-01 → 2026-02-28.
    expect(previousDayIso("2026-03-01")).toBe("2026-02-28");
  });

  test("rejects malformed input", () => {
    expect(() => previousDayIso("not-a-date")).toThrow();
  });
});

describe("extractOpenTasks", () => {
  test("matches both `- [ ]` and the user's `- []` shorthand", () => {
    const body = "- [ ] one\n- [] two\n- [x] done\n";
    expect(extractOpenTasks(body)).toEqual(["one", "two"]);
  });

  test("ignores text containing `[ ]` mid-line (anchored at line start)", () => {
    const body = "stray [ ] in prose\n- [ ] real task\n";
    expect(extractOpenTasks(body)).toEqual(["real task"]);
  });

  test("captures verbatim text including parentheticals and special chars", () => {
    const body = "- [ ] call dr. (re: referral) & confirm @ 2pm\n";
    expect(extractOpenTasks(body)).toEqual([
      "call dr. (re: referral) & confirm @ 2pm",
    ]);
  });

  test("captures nested indented tasks the same as top-level", () => {
    const body = "- [ ] parent\n  - [ ] child\n    - [ ] grandchild\n";
    expect(extractOpenTasks(body)).toEqual(["parent", "child", "grandchild"]);
  });

  test("returns empty when body has no open tasks", () => {
    expect(extractOpenTasks("just prose, nothing else")).toEqual([]);
    expect(extractOpenTasks("- [x] all done\n- [X] also done")).toEqual([]);
  });

  test("handles CRLF line endings (Windows-saved files)", () => {
    // Notepad on Windows defaults to CRLF. Without `\r?$` tolerance,
    // `(.+)$` stranded between `\r` and `\n` and silently matched
    // nothing. Lock the fix in place so a future regex tweak can't
    // silently regress it for the user's home/work entries.
    const body = "- [ ] one\r\n- [] two\r\n- [x] done\r\n";
    expect(extractOpenTasks(body)).toEqual(["one", "two"]);
  });

  test("strips trailing `bullet-migrate auto-mark` HTML comment", () => {
    // Carry-forward bullets land on the destination as
    // `- [ ] task (from YYYY-MM-DD) <!-- bullet-migrate auto-mark -->`.
    // When the user re-migrates them forward, the prompt and the
    // source-rewrite lookup both key off task text — the auto-mark
    // must be peeled off so callers see clean strings instead of
    // surfacing the tool-attribution comment in the UI.
    const body =
      "- [ ] foo (from 2026-04-22) <!-- bullet-migrate auto-mark -->\n" +
      "- [ ] bare task\n";
    expect(extractOpenTasks(body)).toEqual([
      "foo (from 2026-04-22)",
      "bare task",
    ]);
  });

  test("strips auto-mark even with CRLF line endings", () => {
    const body =
      "- [ ] foo (from 2026-04-22) <!-- bullet-migrate auto-mark -->\r\n";
    expect(extractOpenTasks(body)).toEqual(["foo (from 2026-04-22)"]);
  });
});

describe("findRecentSource", () => {
  beforeEach(setupTempRepo);

  test("returns yesterday when yesterday has open tasks", async () => {
    await writeEntry("2026-04-22", "- [ ] yesterday's task");
    const r = await findRecentSource(ENTRIES, "2026-04-23", 14);
    expect(r).toEqual({
      date: "2026-04-22",
      tasks: ["yesterday's task"],
    });
  });

  test("walks back past empty/missing days to find the first with tasks", async () => {
    // 22nd missing entirely, 21st exists but has no open tasks, 20th
    // has an open task.
    await writeEntry("2026-04-21", "- [x] all done\nsome thoughts");
    await writeEntry("2026-04-20", "- [ ] real open task");
    const r = await findRecentSource(ENTRIES, "2026-04-23", 14);
    expect(r).toEqual({
      date: "2026-04-20",
      tasks: ["real open task"],
    });
  });

  test("returns null when no entries within lookback window have open tasks", async () => {
    await writeEntry("2026-04-22", "no tasks here, just prose");
    const r = await findRecentSource(ENTRIES, "2026-04-23", 7);
    expect(r).toBeNull();
  });

  test("respects maxDaysBack — won't reach further-back entries", async () => {
    await writeEntry("2026-04-15", "- [ ] far-back task");
    // Look back only 3 days from 2026-04-23 — won't reach the 15th.
    const r = await findRecentSource(ENTRIES, "2026-04-23", 3);
    expect(r).toBeNull();
  });

  test("does not consider the destination day itself as a source", async () => {
    // If today's entry has open tasks, those are not migration
    // candidates — we only look at PRIOR days.
    await writeEntry("2026-04-23", "- [ ] today's own task");
    const r = await findRecentSource(ENTRIES, "2026-04-23", 14);
    expect(r).toBeNull();
  });
});
