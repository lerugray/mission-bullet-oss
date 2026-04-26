// mission-bullet — dry-run LLM provider (mb-008).
//
// Emits canned responses keyed off the system-prompt prefix — no
// network calls, no API keys, no tokens burned. Use for:
//
//   - Iterating on CLI UX without waiting for streaming
//   - Running the test harness (mb-009) so the raw-is-sacred
//     invariant can be asserted against a deterministic model
//   - Walking through review end-to-end on a new machine before any
//     real provider is configured
//
// The canned responses are deliberately simple: claude-note returns
// short canned commentary; review returns one theme and one
// migration candidate referencing a date found in the user message.

import type { ChatMessage, LLMProvider } from "./types";

function extractDatesFromMessage(user: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of user.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

export function createDryRunProvider(): LLMProvider {
  return {
    kind: "dry-run",
    id: "dry-run:canned",
    async *chat(messages: ChatMessage[]): AsyncIterable<string> {
      const system =
        messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";

      // claude-note --ask: short canned commentary keyed off the
      // user's question so the generated section is recognizable
      // but doesn't pretend to be a real model response.
      if (system.includes("commentary for the user's personal bullet journal")) {
        const lastUser = [...messages].reverse().find(
          (m) => m.role === "user",
        );
        const question = lastUser?.content?.trim() ?? "";
        yield "[DRY-RUN canned commentary]\n\n";
        yield `Responding to: "${question.slice(0, 200)}"\n\n`;
        yield "In real usage this would be a thoughtful response from the selected provider. The dry-run path is here to exercise the end-to-end file-append flow without burning any tokens.";
        return;
      }

      // Review (week or month): return a small JSON response.
      if (system.includes("analyzing ")) {
        const dates = extractDatesFromMessage(user);
        const firstDate = dates[0] ?? "2026-04-21";
        const response = {
          themes:
            dates.length >= 2
              ? [
                  {
                    label: "dry-run sample theme",
                    entries_mentioning: dates.slice(0, 3),
                    notes: null,
                  },
                ]
              : [],
          migrations:
            dates.length > 0
              ? [
                  {
                    source_entry_date: firstDate,
                    source_text_fragment:
                      "sample migration candidate (dry-run)",
                    reason_for_surfacing:
                      "Canned example for exercising the review flow",
                  },
                ]
              : [],
        };
        yield JSON.stringify(response);
        return;
      }

      yield "[DRY-RUN: unrecognized prompt shape]";
    },
  };
}
