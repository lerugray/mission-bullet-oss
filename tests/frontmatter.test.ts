// Frontmatter parser / serializer invariants (mb-009).
//
// Locks in the hard floor: raw-is-sacred. Every code path that writes
// to a raw entry must preserve body bytes; these tests fail loudly if
// any future change quietly breaks that.

import { describe, expect, test } from "bun:test";
import {
  addMigrationBullets,
  appendMonthlyGoals,
  assembleReflectionFile,
  parseMonthlyLogFile,
  parseRawEntryFile,
  parseReflectionFile,
  replaceMonthlyLogFrontmatter,
  replaceRawFrontmatter,
} from "../src/frontmatter";
import { buildMonthlySkeleton } from "../src/month";
import { buildSkeleton } from "../src/today";
import type {
  EntryFrontmatter,
  MigrationCandidate,
  MonthlyLogFrontmatter,
  ReflectionFrontmatter,
  Theme,
} from "../src/types";

const SAMPLE_BODY = '\n\n# My thoughts\n\nHave to "call the clinic". Feeling: stressed.\n\n';

function sampleRawEntry(body = SAMPLE_BODY): string {
  return (
    body +
    "<!-- mission-bullet metadata — do not edit by hand -->\n" +
    "---\n" +
    "date: 2026-04-21\n" +
    "status: open\n" +
    "migrated_to: []\n" +
    `sessions: ["2026-04-21T09:00:00-04:00"]\n` +
    "---\n"
  );
}

describe("parseRawEntryFile", () => {
  test("parses a skeleton + user body", () => {
    const { body, frontmatter } = parseRawEntryFile(sampleRawEntry());
    expect(body).toBe(SAMPLE_BODY);
    expect(frontmatter.date).toBe("2026-04-21");
    expect(frontmatter.status).toBe("open");
    expect(frontmatter.migrated_to).toEqual([]);
    expect(frontmatter.sessions).toEqual(["2026-04-21T09:00:00-04:00"]);
  });

  test("tolerates missing `sessions` field for backwards compat", () => {
    const legacy =
      "body\n\n" +
      "<!-- mission-bullet metadata — do not edit by hand -->\n" +
      "---\n" +
      "date: 2026-04-21\n" +
      "status: open\n" +
      "migrated_to: []\n" +
      "---\n";
    const { frontmatter } = parseRawEntryFile(legacy);
    expect(frontmatter.sessions).toEqual([]);
  });

  test("ignores legacy refined_at / tags_discovered keys from before refine was removed", () => {
    const legacy =
      "body\n\n" +
      "<!-- mission-bullet metadata — do not edit by hand -->\n" +
      "---\n" +
      "date: 2026-04-21\n" +
      "status: open\n" +
      "refined_at: null\n" +
      "tags_discovered: [\"healthcare\"]\n" +
      "migrated_to: []\n" +
      `sessions: ["2026-04-21T09:00:00-04:00"]\n` +
      "---\n";
    const { frontmatter } = parseRawEntryFile(legacy);
    expect(frontmatter.date).toBe("2026-04-21");
    expect(frontmatter.sessions).toEqual(["2026-04-21T09:00:00-04:00"]);
  });

  test("throws FrontmatterParseError when anchor missing", () => {
    expect(() => parseRawEntryFile("just a body with no anchor")).toThrow();
  });
});

describe("replaceRawFrontmatter — the raw-is-sacred splice", () => {
  test("preserves body bytes byte-for-byte across frontmatter update", () => {
    const original = sampleRawEntry();
    const { frontmatter } = parseRawEntryFile(original);
    const updated = replaceRawFrontmatter(original, {
      ...frontmatter,
      sessions: [...frontmatter.sessions, "2026-04-21T14:30:00-04:00"],
    });
    const bodyAfter = updated.slice(0, updated.indexOf("<!-- mission-bullet"));
    expect(bodyAfter).toBe(SAMPLE_BODY);
  });
});

describe("buildSkeleton", () => {
  test("produces a parseable entry", () => {
    const s = buildSkeleton("2026-04-21", ["2026-04-21T09:00:00-04:00"]);
    const { frontmatter } = parseRawEntryFile(s);
    expect(frontmatter.date).toBe("2026-04-21");
    expect(frontmatter.sessions).toEqual(["2026-04-21T09:00:00-04:00"]);
  });

  test("accepts empty sessions array (migration path)", () => {
    const s = buildSkeleton("2026-04-27", []);
    const { frontmatter } = parseRawEntryFile(s);
    expect(frontmatter.sessions).toEqual([]);
  });
});

describe("addMigrationBullets", () => {
  test("creates a section when none exists, with visible banner", () => {
    const entry = buildSkeleton("2026-04-27", []);
    const updated = addMigrationBullets(entry, [
      '- "call clinic" (from week 2026-W17, 2026-04-21)',
    ]);
    expect(updated).toContain("## Migrated items");
    expect(updated).toContain("migration-forward — auto-generated");
    expect(updated).toContain('"call clinic"');
  });

  test("is idempotent — re-appending same bullet is a no-op", () => {
    const entry = buildSkeleton("2026-04-27", []);
    const bullets = ['- "call clinic" (from week 2026-W17, 2026-04-21)'];
    const first = addMigrationBullets(entry, bullets);
    const second = addMigrationBullets(first, bullets);
    expect(second).toBe(first);
  });

  test("appends new bullets under existing section header", () => {
    const entry = buildSkeleton("2026-04-27", []);
    const first = addMigrationBullets(entry, [
      '- "call clinic" (from week 2026-W17, 2026-04-21)',
    ]);
    const second = addMigrationBullets(first, [
      '- "file taxes" (from week 2026-W17, 2026-04-23)',
    ]);
    // Exactly one section header across both runs.
    const headerCount =
      second.split("## Migrated items").length - 1;
    expect(headerCount).toBe(1);
    expect(second).toContain("call clinic");
    expect(second).toContain("file taxes");
  });

  test("is still parseable after multiple append rounds", () => {
    let entry = buildSkeleton("2026-04-27", []);
    entry = addMigrationBullets(entry, ['- "one" (from week 2026-W17, 2026-04-21)']);
    entry = addMigrationBullets(entry, ['- "two" (from week 2026-W17, 2026-04-22)']);
    expect(() => parseRawEntryFile(entry)).not.toThrow();
  });
});

describe("reflection round-trip (object-array frontmatter)", () => {
  test("preserves nested Theme[] and MigrationCandidate[]", () => {
    const themes: Theme[] = [
      {
        label: "healthcare",
        entries_mentioning: ["2026-04-20", "2026-04-22"],
        first_seen: "2026-04-20",
        last_seen: "2026-04-22",
        notes: null,
      },
      {
        label: "planning",
        entries_mentioning: ["2026-04-21"],
        first_seen: "2026-04-21",
        last_seen: "2026-04-21",
        notes: "Appeared alongside scheduling worries",
      },
    ];
    const migrations: MigrationCandidate[] = [
      {
        source_entry_date: "2026-04-21",
        source_text_fragment: "call clinic",
        reason_for_surfacing: "Open task",
        user_decision: "accept",
        migrated_to: "entries/2026/04/27.md",
      },
    ];
    const fm: ReflectionFrontmatter = {
      period: "week",
      start_date: "2026-04-20",
      end_date: "2026-04-26",
      entries_reviewed: ["2026-04-20", "2026-04-21", "2026-04-22"],
      themes_surfaced: themes,
      migrations_proposed: migrations,
    };
    const content = assembleReflectionFile("# body", fm);
    const reparsed = parseReflectionFile(content);
    expect(reparsed.frontmatter.themes_surfaced).toEqual(themes);
    expect(reparsed.frontmatter.migrations_proposed).toEqual(migrations);
  });
});

describe("monthly log frontmatter round-trip", () => {
  test("buildMonthlySkeleton produces parseable log with session", () => {
    const stamp = "2026-04-21T09:00:00-04:00";
    const s = buildMonthlySkeleton("2026-04", [stamp]);
    const { frontmatter } = parseMonthlyLogFile(s);
    expect(frontmatter.month).toBe("2026-04");
    expect(frontmatter.status).toBe("open");
    expect(frontmatter.sessions).toEqual([stamp]);
  });

  test("replaceMonthlyLogFrontmatter preserves body bytes", () => {
    const s = buildMonthlySkeleton("2026-04", ["2026-04-21T09:00:00-04:00"]);
    const { body, frontmatter } = parseMonthlyLogFile(s);
    const updated = replaceMonthlyLogFrontmatter(s, {
      ...frontmatter,
      sessions: [...frontmatter.sessions, "2026-04-22T09:00:00-04:00"],
    });
    const reparsed = parseMonthlyLogFile(updated);
    expect(reparsed.body).toBe(body);
    expect(reparsed.frontmatter.sessions.length).toBe(2);
  });
});

describe("appendMonthlyGoals", () => {
  test("adds bullets under Goals section and is idempotent", () => {
    const log = buildMonthlySkeleton("2026-05", []);
    const bullet = "- [ ] finish Q2 strategy (carried from 2026-04-21)";
    const first = appendMonthlyGoals(log, [bullet]);
    expect(first).toContain(bullet);
    const second = appendMonthlyGoals(first, [bullet]);
    expect(second).toBe(first);
  });

  test("inserts bullets under Goals header (not at end of body)", () => {
    const log = buildMonthlySkeleton("2026-05", []);
    const updated = appendMonthlyGoals(log, [
      "- [ ] finish Q2 strategy (carried from 2026-04-21)",
    ]);
    const goalsIdx = updated.indexOf("## Goals for the month");
    const billsIdx = updated.indexOf("## Bills & recurring");
    const bulletIdx = updated.indexOf("- [ ] finish Q2 strategy");
    expect(bulletIdx).toBeGreaterThan(goalsIdx);
    expect(bulletIdx).toBeLessThan(billsIdx);
  });
});
