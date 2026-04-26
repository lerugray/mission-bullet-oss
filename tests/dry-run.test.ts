// Dry-run provider shape tests (mb-008 / mb-009).
//
// The dry-run provider is the backbone of the test harness: it
// returns deterministic canned responses so integration paths can
// be asserted without a real LLM. This suite pins the shape so a
// future change to the canned output doesn't silently break tests
// that depend on it.

import { describe, expect, test } from "bun:test";
import { createDryRunProvider } from "../src/providers/dry-run";
import type { ChatMessage } from "../src/providers/types";

async function collect(
  provider: ReturnType<typeof createDryRunProvider>,
  messages: ChatMessage[],
): Promise<string> {
  let out = "";
  for await (const chunk of provider.chat(messages)) out += chunk;
  return out;
}

describe("dry-run provider", () => {
  const provider = createDryRunProvider();

  test("review: returns JSON with themes + migrations arrays", async () => {
    const out = await collect(provider, [
      {
        role: "system",
        content: "You are analyzing a week of a personal bullet-journal...",
      },
      {
        role: "user",
        content:
          "Week 2026-W17. Entries:\n### 2026-04-20\nfoo\n### 2026-04-21\nbar",
      },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("themes");
    expect(parsed).toHaveProperty("migrations");
    expect(Array.isArray(parsed.themes)).toBe(true);
    expect(Array.isArray(parsed.migrations)).toBe(true);
    expect(parsed.migrations[0]?.source_entry_date).toBe("2026-04-20");
  });

  test("review with no dates: returns empty arrays", async () => {
    const out = await collect(provider, [
      {
        role: "system",
        content: "You are analyzing a month of a personal bullet-journal...",
      },
      { role: "user", content: "nothing useful here" },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.themes).toEqual([]);
    expect(parsed.migrations).toEqual([]);
  });
});
