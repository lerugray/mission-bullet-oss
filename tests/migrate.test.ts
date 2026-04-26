// Migration-forward invariants (mb-009).
//
// Covers both weekly (-> daily entry) and monthly (-> monthly log)
// migration. The raw-is-sacred floor lives here — source bodies must
// never drift after migration, regardless of how many times it runs.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { parseMonthlyLogFile, parseRawEntryFile } from "../src/frontmatter";
import {
  migrateAccepted,
  migrateAcceptedToDay,
  migrateAcceptedToMonth,
  strikeSourceTasks,
} from "../src/migrate";
import { buildMonthlySkeleton } from "../src/month";
import { buildSkeleton } from "../src/today";
import type { MigrationCandidate } from "../src/types";

const TMP = join(process.cwd(), "tmp-migrate-test");
const ENTRIES = join(TMP, "entries");

async function setupTempRepo(): Promise<void> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(ENTRIES, { recursive: true });
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

async function writeSourceEntry(
  date: string,
  bodyPrefix: string,
): Promise<string> {
  const [year, month] = date.split("-");
  const path = join(ENTRIES, year!, month!, `${date.split("-")[2]}.md`);
  await mkdir(dirname(path), { recursive: true });
  const content =
    bodyPrefix +
    "\n\n" +
    "<!-- mission-bullet metadata — do not edit by hand -->\n" +
    "---\n" +
    `date: ${date}\n` +
    "status: open\n" +
    "migrated_to: []\n" +
    `sessions: ["${date}T09:00:00-04:00"]\n` +
    "---\n";
  await writeFile(path, content, "utf8");
  return path;
}

describe("migrateAccepted (weekly)", () => {
  beforeEach(setupTempRepo);

  test("creates destination, appends bullet, preserves source body", async () => {
    const bodyPrefix = "My Tuesday notes.\n\nNeed to call the clinic.";
    const srcPath = await writeSourceEntry("2026-04-21", bodyPrefix);
    const originalSrcBody = bodyPrefix + "\n\n";

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-21",
        source_text_fragment: "call the clinic",
        reason_for_surfacing: "Open task",
        user_decision: "accept",
        migrated_to: null,
      },
    ];

    const result = await migrateAccepted(accepted, "2026-W17", ENTRIES, TMP);
    expect(result.itemsAdded).toBe(1);
    expect(result.destinationDate).toBe("2026-04-27");

    // Source body byte-identical.
    const srcAfter = await readFile(srcPath, "utf8");
    const srcParsed = parseRawEntryFile(srcAfter);
    expect(srcParsed.body).toBe(originalSrcBody);

    // Source migrated_to updated.
    expect(srcParsed.frontmatter.migrated_to).toContain(
      "entries/2026/04/27.md",
    );

    // Destination contains the bullet.
    const destPath = join(ENTRIES, "2026", "04", "27.md");
    const destContent = await readFile(destPath, "utf8");
    expect(destContent).toContain('"call the clinic"');
    expect(destContent).toContain("## Migrated items");
  });

  test("is idempotent across runs", async () => {
    await writeSourceEntry("2026-04-21", "body");

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-21",
        source_text_fragment: "call the clinic",
        reason_for_surfacing: "Open",
        user_decision: "accept",
        migrated_to: null,
      },
    ];
    const r1 = await migrateAccepted(accepted, "2026-W17", ENTRIES, TMP);
    expect(r1.itemsAdded).toBe(1);

    const r2 = await migrateAccepted(accepted, "2026-W17", ENTRIES, TMP);
    expect(r2.itemsAdded).toBe(0);
    expect(r2.itemsAlreadyPresent).toBe(1);
  });

  test("skips non-existent source entries silently", async () => {
    // No source entry written — migration should still produce
    // destination without crashing, sourcesUpdated stays empty.
    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-21",
        source_text_fragment: "orphan item",
        reason_for_surfacing: "Whatever",
        user_decision: "accept",
        migrated_to: null,
      },
    ];
    const r = await migrateAccepted(accepted, "2026-W17", ENTRIES, TMP);
    expect(r.itemsAdded).toBe(1);
    expect(r.sourcesUpdated).toEqual([]);
  });
});

describe("migrateAcceptedToMonth", () => {
  beforeEach(setupTempRepo);

  test("appends task-bullets to next month's Goals section", async () => {
    // Write this month's monthly log so the source path exists.
    const sourceMonthPath = join(ENTRIES, "2026", "04", "monthly.md");
    await mkdir(dirname(sourceMonthPath), { recursive: true });
    await writeFile(
      sourceMonthPath,
      buildMonthlySkeleton("2026-04", []),
      "utf8",
    );
    await writeSourceEntry("2026-04-15", "mid-month notes");

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-15",
        source_text_fragment: "finish Q2 strategy draft",
        reason_for_surfacing: "Still open",
        user_decision: "accept",
        migrated_to: null,
      },
    ];
    const r = await migrateAcceptedToMonth(
      accepted,
      "2026-04",
      ENTRIES,
      TMP,
    );
    expect(r.destinationDate).toBe("2026-05");
    expect(r.itemsAdded).toBe(1);

    // Destination monthly log has the task bullet under Goals.
    const destPath = join(ENTRIES, "2026", "05", "monthly.md");
    const destContent = await readFile(destPath, "utf8");
    const goalsIdx = destContent.indexOf("## Goals for the month");
    const bulletIdx = destContent.indexOf(
      "- [ ] finish Q2 strategy draft (carried from 2026-04-15)",
    );
    expect(bulletIdx).toBeGreaterThan(goalsIdx);

    // Parseable as a valid monthly log.
    expect(() => parseMonthlyLogFile(destContent)).not.toThrow();
  });

  test("is idempotent and year-rollover-safe (Dec → next Jan)", async () => {
    await writeSourceEntry("2026-12-15", "late year");

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-12-15",
        source_text_fragment: "end-of-year review",
        reason_for_surfacing: "",
        user_decision: "accept",
        migrated_to: null,
      },
    ];
    const r1 = await migrateAcceptedToMonth(
      accepted,
      "2026-12",
      ENTRIES,
      TMP,
    );
    expect(r1.destinationDate).toBe("2027-01");
    expect(r1.itemsAdded).toBe(1);

    const r2 = await migrateAcceptedToMonth(
      accepted,
      "2026-12",
      ENTRIES,
      TMP,
    );
    expect(r2.itemsAdded).toBe(0);
  });
});

describe("migrateAcceptedToDay (mb-010)", () => {
  beforeEach(setupTempRepo);

  test("appends task-bullet to dest, marks source line, updates frontmatter", async () => {
    const body =
      "Tuesday morning notes.\n\n" +
      "- [ ] call the clinic about the referral\n" +
      "- [x] emailed Sam back\n" +
      "Some closing thought.";
    const srcPath = await writeSourceEntry("2026-04-22", body);

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-22",
        source_text_fragment: "call the clinic about the referral",
        reason_for_surfacing: "user-selected via bullet migrate",
        user_decision: "accept",
        migrated_to: null,
      },
    ];

    const r = await migrateAcceptedToDay(
      accepted,
      "2026-04-23",
      ENTRIES,
      TMP,
    );
    expect(r.destinationDate).toBe("2026-04-23");
    expect(r.itemsAdded).toBe(1);
    expect(r.sourceLinesMarked).toBe(1);
    expect(r.sourceLinesNotFound).toBe(0);
    expect(r.sourcesUpdated).toEqual(["2026-04-22"]);

    // Source: open `- [ ]` is now `- [x] ... (migrated to 2026-04-23) <auto-mark>`,
    // unrelated lines preserved byte-identically.
    const srcAfter = await readFile(srcPath, "utf8");
    expect(srcAfter).toContain(
      "- [x] call the clinic about the referral (migrated to 2026-04-23) <!-- bullet-migrate auto-mark -->",
    );
    expect(srcAfter).not.toContain(
      "- [ ] call the clinic about the referral",
    );
    // Pre-existing user-marked done task must NOT carry the auto-mark.
    expect(srcAfter).toContain("- [x] emailed Sam back");
    expect(srcAfter).not.toMatch(
      /- \[x\] emailed Sam back.*bullet-migrate auto-mark/,
    );
    expect(srcAfter).toContain("Tuesday morning notes.");
    expect(srcAfter).toContain("Some closing thought.");

    // Source frontmatter records the destination.
    const srcParsed = parseRawEntryFile(srcAfter);
    expect(srcParsed.frontmatter.migrated_to).toContain(
      "entries/2026/04/23.md",
    );

    // Destination: task-style bullet under `## Migrated items`,
    // tagged with the auto-mark so an LLM ingest can distinguish it
    // from the user's own writing.
    const destPath = join(ENTRIES, "2026", "04", "23.md");
    const destContent = await readFile(destPath, "utf8");
    expect(destContent).toContain("## Migrated items");
    expect(destContent).toContain(
      "- [ ] call the clinic about the referral (from 2026-04-22) <!-- bullet-migrate auto-mark -->",
    );
  });

  test("preserves indentation when marking nested source tasks", async () => {
    const body =
      "Project notes:\n" +
      "- [ ] parent task\n" +
      "  - [ ] nested sub-task\n" +
      "  - [ ] another nested\n";
    await writeSourceEntry("2026-04-22", body);

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-22",
        source_text_fragment: "nested sub-task",
        reason_for_surfacing: "",
        user_decision: "accept",
        migrated_to: null,
      },
    ];

    await migrateAcceptedToDay(accepted, "2026-04-23", ENTRIES, TMP);

    const srcAfter = await readFile(
      join(ENTRIES, "2026", "04", "22.md"),
      "utf8",
    );
    // Two-space indent preserved on the rewritten line; auto-mark
    // appended.
    expect(srcAfter).toContain(
      "  - [x] nested sub-task (migrated to 2026-04-23) <!-- bullet-migrate auto-mark -->",
    );
    // Sibling sub-task untouched.
    expect(srcAfter).toContain("  - [ ] another nested");
    // Parent untouched.
    expect(srcAfter).toContain("- [ ] parent task");
  });

  test("idempotent: re-running with the same accepted list adds nothing", async () => {
    const body = "- [ ] follow up on Q2";
    await writeSourceEntry("2026-04-22", body);

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-22",
        source_text_fragment: "follow up on Q2",
        reason_for_surfacing: "",
        user_decision: "accept",
        migrated_to: null,
      },
    ];

    const r1 = await migrateAcceptedToDay(
      accepted,
      "2026-04-23",
      ENTRIES,
      TMP,
    );
    expect(r1.itemsAdded).toBe(1);
    expect(r1.sourceLinesMarked).toBe(1);

    // Reset migrated_to back to null on the candidate so a second pass
    // mirrors what the handler would feed in (each call constructs
    // fresh candidates).
    accepted[0]!.migrated_to = null;
    const r2 = await migrateAcceptedToDay(
      accepted,
      "2026-04-23",
      ENTRIES,
      TMP,
    );
    expect(r2.itemsAdded).toBe(0);
    expect(r2.itemsAlreadyPresent).toBe(1);
    // Source line was already rewritten on the first pass — second
    // pass can't find a `- [ ]` form to mark.
    expect(r2.sourceLinesMarked).toBe(0);
    expect(r2.sourceLinesNotFound).toBe(1);
  });

  test("re-migrating a previously-carried task strips stale `(from)` suffix", async () => {
    // Day B already holds a carry-forward bullet whose source_text
    // includes `(from 2026-04-21)`. Re-migrating to day C must not
    // produce `(from 2026-04-21) (from 2026-04-22)` — only the most-
    // recent hop belongs on the destination. The original chain stays
    // visible on day B's now-rewritten line and via `migrated_to`
    // frontmatter pointers.
    const body = "- [ ] follow up on Q2 (from 2026-04-21)";
    await writeSourceEntry("2026-04-22", body);

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-22",
        source_text_fragment: "follow up on Q2 (from 2026-04-21)",
        reason_for_surfacing: "",
        user_decision: "accept",
        migrated_to: null,
      },
    ];

    const r = await migrateAcceptedToDay(
      accepted,
      "2026-04-23",
      ENTRIES,
      TMP,
    );
    expect(r.itemsAdded).toBe(1);

    const destPath = join(ENTRIES, "2026", "04", "23.md");
    const destContent = await readFile(destPath, "utf8");
    expect(destContent).toContain(
      "- [ ] follow up on Q2 (from 2026-04-22) <!-- bullet-migrate auto-mark -->",
    );
    // The stale `(from 2026-04-21)` must NOT be carried onto the
    // destination — only the latest hop (2026-04-22 → 2026-04-23).
    expect(destContent).not.toContain("(from 2026-04-21)");
  });

  test("source line not found is reported, not thrown", async () => {
    const body = "- [ ] real task in the body";
    await writeSourceEntry("2026-04-22", body);

    const accepted: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-22",
        source_text_fragment: "phantom task that doesn't exist",
        reason_for_surfacing: "",
        user_decision: "accept",
        migrated_to: null,
      },
    ];

    const r = await migrateAcceptedToDay(
      accepted,
      "2026-04-23",
      ENTRIES,
      TMP,
    );
    // Destination bullet still added (engine doesn't gate on source-line
    // presence — the user already said "accept").
    expect(r.itemsAdded).toBe(1);
    expect(r.sourceLinesMarked).toBe(0);
    expect(r.sourceLinesNotFound).toBe(1);
  });
});

describe("strikeSourceTasks (mb-010)", () => {
  beforeEach(setupTempRepo);

  test("rewrites `- [ ] foo` to `- [x] ~~foo~~`, leaves rest intact", async () => {
    const body =
      "Morning thoughts.\n" +
      "- [ ] reset sleep schedule\n" +
      "- [ ] keep this one\n" +
      "Closing line.";
    const srcPath = await writeSourceEntry("2026-04-22", body);

    const r = await strikeSourceTasks(
      [{ sourceDate: "2026-04-22", taskText: "reset sleep schedule" }],
      ENTRIES,
    );
    expect(r.itemsStruck).toBe(1);
    expect(r.itemsNotFound).toBe(0);
    expect(r.sourcesTouched).toEqual(["2026-04-22"]);

    const after = await readFile(srcPath, "utf8");
    expect(after).toContain(
      "- [x] ~~reset sleep schedule~~ <!-- bullet-migrate auto-mark -->",
    );
    expect(after).not.toContain("- [ ] reset sleep schedule");
    // The other open task must NOT carry the auto-mark.
    expect(after).toContain("- [ ] keep this one");
    expect(after).not.toMatch(
      /- \[ \] keep this one.*bullet-migrate auto-mark/,
    );
    expect(after).toContain("Morning thoughts.");
    expect(after).toContain("Closing line.");
  });

  test("idempotent: striking again finds nothing (line is no longer open)", async () => {
    await writeSourceEntry("2026-04-22", "- [ ] gone");

    const r1 = await strikeSourceTasks(
      [{ sourceDate: "2026-04-22", taskText: "gone" }],
      ENTRIES,
    );
    expect(r1.itemsStruck).toBe(1);

    const r2 = await strikeSourceTasks(
      [{ sourceDate: "2026-04-22", taskText: "gone" }],
      ENTRIES,
    );
    expect(r2.itemsStruck).toBe(0);
    expect(r2.itemsNotFound).toBe(1);
  });

  test("missing source file reports notFound rather than crashing", async () => {
    const r = await strikeSourceTasks(
      [{ sourceDate: "2099-01-01", taskText: "anything" }],
      ENTRIES,
    );
    expect(r.itemsStruck).toBe(0);
    expect(r.itemsNotFound).toBe(1);
    expect(r.sourcesTouched).toEqual([]);
  });

  test("preserves CRLF line endings on Windows-saved entries", async () => {
    // Hand-build the entry with explicit `\r\n` line endings so we
    // exercise the same shape Notepad produces on the home PC.
    // Helper writes LF — bypass it.
    const date = "2026-04-22";
    const path = join(ENTRIES, "2026", "04", "22.md");
    await mkdir(dirname(path), { recursive: true });
    const content =
      "morning notes\r\n" +
      "- [] reset sleep schedule\r\n" +
      "- [ ] keep this one\r\n" +
      "\r\n" +
      "<!-- mission-bullet metadata — do not edit by hand -->\r\n" +
      "---\r\n" +
      `date: ${date}\r\n` +
      "status: open\r\n" +
      "migrated_to: []\r\n" +
      "sessions: []\r\n" +
      "---\r\n";
    await writeFile(path, content, "utf8");

    const r = await strikeSourceTasks(
      [{ sourceDate: date, taskText: "reset sleep schedule" }],
      ENTRIES,
    );
    expect(r.itemsStruck).toBe(1);

    const after = await readFile(path, "utf8");
    expect(after).toContain(
      "- [x] ~~reset sleep schedule~~ <!-- bullet-migrate auto-mark -->\r\n",
    );
    // Untouched lines keep their CRLF.
    expect(after).toContain("- [ ] keep this one\r\n");
    expect(after).toContain("morning notes\r\n");
    // No bare `\n` got introduced in place of `\r\n` on the rewritten line.
    expect(after).not.toMatch(/auto-mark -->\n[^\r]/);
  });
});
