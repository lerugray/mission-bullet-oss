// mission-bullet — claude-note command unit + integration tests.
//
// Unit tests cover pure helpers (path, skeleton, prompt shape,
// prior-turn parsing, message construction, section formatting).
// An integration test walks the full --ask flow end-to-end using
// the dry-run provider so the file-append + conversation-history
// wiring is exercised without burning tokens.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  buildClaudeNoteSkeleton,
  buildMessages,
  buildSystemPrompt,
  claudeNotePath,
  formatResponseSection,
  parsePriorTurns,
  resolveAskModel,
  runClaudeNote,
} from "../src/claude-note";

// ---- claudeNotePath -------------------------------------------------

describe("claudeNotePath", () => {
  test("builds entries/YYYY/MM/DD.claude.md path", () => {
    const p = claudeNotePath("/tmp/entries", "2026-04-22");
    expect(p.replaceAll("\\", "/")).toBe(
      "/tmp/entries/2026/04/22.claude.md",
    );
  });

  test("throws on empty date string", () => {
    expect(() => claudeNotePath("/tmp/entries", "")).toThrow();
  });

  test("throws on date missing day/month parts", () => {
    expect(() => claudeNotePath("/tmp/entries", "2026")).toThrow();
  });
});

// ---- buildClaudeNoteSkeleton ----------------------------------------

describe("buildClaudeNoteSkeleton", () => {
  test("includes the date in the title", () => {
    const skel = buildClaudeNoteSkeleton("2026-04-22");
    expect(skel).toContain("# Claude — parallel notes, 2026-04-22");
  });

  test("names the sibling raw entry file", () => {
    const skel = buildClaudeNoteSkeleton("2026-04-22");
    expect(skel).toContain("`22.md`");
  });

  test("makes the 'not part of the raw journal' contract explicit", () => {
    const skel = buildClaudeNoteSkeleton("2026-04-22");
    expect(skel).toContain("Not part of the raw journal");
    expect(skel).toContain("explicitly asks");
  });

  test("ends with a separator + blank line so the body can be appended cleanly", () => {
    const skel = buildClaudeNoteSkeleton("2026-04-22");
    expect(skel).toMatch(/---\n\n$/);
  });
});

// ---- buildSystemPrompt ----------------------------------------------

describe("buildSystemPrompt", () => {
  test("includes the raw entry body verbatim", () => {
    const raw = "I need to call the clinic today.";
    const prompt = buildSystemPrompt(raw);
    expect(prompt).toContain("I need to call the clinic today.");
  });

  test("codifies the voice rules so they travel with every call", () => {
    const prompt = buildSystemPrompt("raw");
    // Sample a few rules by exact phrase so a future edit to
    // CLAUDE_NOTE_VOICE has to update this test, forcing a decision.
    expect(prompt).toContain("No sycophancy");
    expect(prompt).toContain("No therapy-speak");
    expect(prompt).toContain("Peer reading a friend's journal");
  });
});

// ---- parsePriorTurns ------------------------------------------------

describe("parsePriorTurns", () => {
  test("returns empty list for a file with only the skeleton", () => {
    const content =
      "# Claude — parallel notes, 2026-04-22\n\n" +
      "*framing*\n\n---\n\n";
    expect(parsePriorTurns(content)).toEqual([]);
  });

  test("extracts a single section with question and body", () => {
    const content =
      "# skeleton...\n\n---\n\n" +
      "## 2026-04-22T05:30:00-04:00 — openrouter:google/gemma-4-31b-it:free\n\n" +
      "**Question:** what do you think?\n\n" +
      "Here is my thoughtful response.\n\n" +
      "It spans multiple paragraphs.\n";
    const turns = parsePriorTurns(content);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("what do you think?");
    expect(turns[0]?.response).toContain("thoughtful response");
    expect(turns[0]?.response).toContain("multiple paragraphs");
  });

  test("extracts multiple sections in order", () => {
    const content =
      "# skel\n\n---\n\n" +
      "## 2026-04-22T05:30:00-04:00 — provider:model-a\n\n" +
      "**Question:** first question\n\n" +
      "first response\n\n" +
      "## 2026-04-22T06:00:00-04:00 — provider:model-b\n\n" +
      "**Question:** second question\n\n" +
      "second response\n";
    const turns = parsePriorTurns(content);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.question).toBe("first question");
    expect(turns[0]?.response).toBe("first response");
    expect(turns[1]?.question).toBe("second question");
    expect(turns[1]?.response).toBe("second response");
  });

  test("handles a section missing the **Question:** line without crashing", () => {
    const content =
      "# skel\n\n---\n\n" +
      "## 2026-04-22T05:30:00-04:00 — provider:model\n\n" +
      "free-form pasted-in commentary, no question line.\n";
    const turns = parsePriorTurns(content);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.question).toBe("(earlier question)");
    expect(turns[0]?.response).toContain("free-form pasted-in");
  });
});

// ---- buildMessages --------------------------------------------------

describe("buildMessages", () => {
  test("starts with a system turn, ends with a user turn", () => {
    const msgs = buildMessages("raw", [], "my question");
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[msgs.length - 1]?.role).toBe("user");
    expect(msgs[msgs.length - 1]?.content).toBe("my question");
  });

  test("interleaves prior turns as user/assistant pairs", () => {
    const prior = [
      { question: "q1", response: "r1" },
      { question: "q2", response: "r2" },
    ];
    const msgs = buildMessages("raw", prior, "q3");
    // system, user(q1), assistant(r1), user(q2), assistant(r2), user(q3)
    expect(msgs).toHaveLength(6);
    expect(msgs[1]).toEqual({ role: "user", content: "q1" });
    expect(msgs[2]).toEqual({ role: "assistant", content: "r1" });
    expect(msgs[3]).toEqual({ role: "user", content: "q2" });
    expect(msgs[4]).toEqual({ role: "assistant", content: "r2" });
    expect(msgs[5]).toEqual({ role: "user", content: "q3" });
  });
});

// ---- formatResponseSection ------------------------------------------

describe("formatResponseSection", () => {
  test("builds header with timestamp, provider and model label when distinct", () => {
    const out = formatResponseSection({
      timestamp: "2026-04-22T05:30:00-04:00",
      providerId: "openrouter",
      model: "google/gemma-4-31b-it:free",
      ask: "what do you think?",
      response: "A thoughtful take.",
      truncated: false,
      truncationReason: null,
    });
    expect(out).toContain(
      "## 2026-04-22T05:30:00-04:00 — openrouter (google/gemma-4-31b-it:free)",
    );
    expect(out).toContain("**Question:** what do you think?");
    expect(out).toContain("A thoughtful take.");
  });

  test("collapses header to provider-only when model equals provider id", () => {
    const out = formatResponseSection({
      timestamp: "2026-04-22T05:30:00-04:00",
      providerId: "dry-run:canned",
      model: "dry-run:canned",
      ask: "q",
      response: "r",
      truncated: false,
      truncationReason: null,
    });
    expect(out).toContain("## 2026-04-22T05:30:00-04:00 — dry-run:canned\n");
    expect(out).not.toContain("(dry-run:canned)");
  });

  test("appends a truncation marker when the stream errored mid-response", () => {
    const out = formatResponseSection({
      timestamp: "t",
      providerId: "p",
      model: "m",
      ask: "q",
      response: "partial",
      truncated: true,
      truncationReason: "rate limit exceeded",
    });
    expect(out).toContain("[TRUNCATED mid-response: rate limit exceeded]");
  });
});

// ---- resolveAskModel ------------------------------------------------

describe("resolveAskModel", () => {
  test("--model flag always wins", () => {
    expect(resolveAskModel("explicit-model", null, "openrouter", {})).toBe(
      "explicit-model",
    );
    expect(
      resolveAskModel("explicit-model", "claude", "claude", {
        MISSION_BULLET_CLAUDE_NOTE_MODEL: "ignored",
      }),
    ).toBe("explicit-model");
  });

  test("explicit --provider skips the env default (since it's likely for another provider)", () => {
    // User overrode provider for this call. Env default was set for
    // OpenRouter; we should NOT forward it to Claude.
    expect(
      resolveAskModel(null, "claude", "claude", {
        MISSION_BULLET_CLAUDE_NOTE_MODEL: "google/gemma-4-31b-it:free",
      }),
    ).toBeNull();
  });

  test("no overrides: env default wins when set", () => {
    expect(
      resolveAskModel(null, null, "openrouter", {
        MISSION_BULLET_CLAUDE_NOTE_MODEL: "custom/model:tag",
      }),
    ).toBe("custom/model:tag");
  });

  test("no overrides, no env: OpenRouter gets the shipped default", () => {
    expect(resolveAskModel(null, null, "openrouter", {})).toBe(
      "google/gemma-4-31b-it:free",
    );
  });

  test("no overrides, no env, non-openrouter provider: null (provider picks default)", () => {
    expect(resolveAskModel(null, null, "claude", {})).toBeNull();
    expect(resolveAskModel(null, null, "ollama", {})).toBeNull();
  });
});

// ---- End-to-end --ask via dry-run -----------------------------------

const TMP = join(process.cwd(), "tmp-claude-note-test");
const ENTRIES = join(TMP, "entries");

async function setupTempRepo(): Promise<void> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(ENTRIES, { recursive: true });
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

async function writeRawEntry(date: string, body: string): Promise<string> {
  const [year, month, day] = date.split("-");
  const path = join(ENTRIES, year!, month!, `${day}.md`);
  await mkdir(join(ENTRIES, year!, month!), { recursive: true });
  const content =
    body +
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

describe("runClaudeNote --ask (dry-run end-to-end)", () => {
  beforeEach(setupTempRepo);

  test("writes a new claude-note file with skeleton + appended section", async () => {
    await writeRawEntry("2026-05-01", "Today I thought about widgets.");
    const originalCwd = process.cwd();
    process.chdir(TMP);
    try {
      const exitCode = await runClaudeNote([
        "2026-05-01",
        "--ask",
        "what do you make of the widget thought",
        "--dry-run",
      ]);
      expect(exitCode).toBe(0);
      const noteContent = await readFile(
        join(ENTRIES, "2026/05/01.claude.md"),
        "utf8",
      );
      expect(noteContent).toContain("# Claude — parallel notes, 2026-05-01");
      expect(noteContent).toContain(
        "**Question:** what do you make of the widget thought",
      );
      expect(noteContent).toContain("DRY-RUN canned commentary");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("appends a second section when asked again, preserving the first", async () => {
    await writeRawEntry("2026-05-02", "Another day, another thought.");
    const originalCwd = process.cwd();
    process.chdir(TMP);
    try {
      await runClaudeNote([
        "2026-05-02",
        "--ask",
        "first question",
        "--dry-run",
      ]);
      await runClaudeNote([
        "2026-05-02",
        "--ask",
        "second question",
        "--dry-run",
      ]);
      const noteContent = await readFile(
        join(ENTRIES, "2026/05/02.claude.md"),
        "utf8",
      );
      expect(noteContent).toContain("**Question:** first question");
      expect(noteContent).toContain("**Question:** second question");
      const turns = parsePriorTurns(noteContent);
      expect(turns).toHaveLength(2);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("leaves the raw entry byte-for-byte unchanged", async () => {
    const rawPath = await writeRawEntry(
      "2026-05-03",
      "Raw content that must not drift.",
    );
    const originalContent = await readFile(rawPath, "utf8");
    const originalCwd = process.cwd();
    process.chdir(TMP);
    try {
      await runClaudeNote([
        "2026-05-03",
        "--ask",
        "comment on this",
        "--dry-run",
      ]);
      const afterContent = await readFile(rawPath, "utf8");
      expect(afterContent).toBe(originalContent);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("accepts --provider override alongside --dry-run", async () => {
    // --dry-run forces the dry-run provider regardless, but the CLI
    // should still accept --provider in the same invocation without
    // choking on the argument.
    await writeRawEntry("2026-05-05", "entry.");
    const originalCwd = process.cwd();
    process.chdir(TMP);
    try {
      const exitCode = await runClaudeNote([
        "2026-05-05",
        "--provider",
        "openrouter",
        "--ask",
        "q",
        "--dry-run",
      ]);
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("rejects invalid --provider value", async () => {
    const originalCwd = process.cwd();
    process.chdir(TMP);
    try {
      const exitCode = await runClaudeNote([
        "--provider",
        "not-a-real-provider",
        "--ask",
        "q",
        "--dry-run",
      ]);
      expect(exitCode).toBe(2);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("exits non-zero when asked about a date with no raw entry", async () => {
    const originalCwd = process.cwd();
    process.chdir(TMP);
    try {
      const exitCode = await runClaudeNote([
        "2026-05-04",
        "--ask",
        "is anyone there?",
        "--dry-run",
      ]);
      expect(exitCode).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
