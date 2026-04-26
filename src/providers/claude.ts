// mission-bullet — Claude Code CLI provider (mb-002)
//
// Invokes `claude -p <prompt>` as a subprocess and yields stdout
// chunks as Claude streams its response. Uses the user's Claude
// Code subscription via the locally-installed CLI — no API key
// to manage, no separate billing.
//
// The Claude Code CLI takes a single prompt string, so multi-turn
// ChatMessage arrays are flattened into a tagged single prompt
// ([System] / [User] / [Assistant] blocks). For mb-005 review this
// is sufficient — a single-turn call.

import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
} from "./types";

function flattenMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const tag =
      m.role === "system"
        ? "[System]"
        : m.role === "user"
          ? "[User]"
          : "[Assistant]";
    parts.push(`${tag}\n${m.content}`);
  }
  return parts.join("\n\n");
}

export function createClaudeProvider(model?: string): LLMProvider {
  return {
    kind: "claude",
    id: model ? `claude:${model}` : "claude",
    async *chat(
      messages: ChatMessage[],
      options?: ChatOptions,
    ): AsyncIterable<string> {
      const prompt = flattenMessages(messages);
      const args = ["-p", prompt];
      const modelArg = options?.model ?? model;
      if (modelArg) {
        args.push("--model", modelArg);
      }
      const proc = Bun.spawn(["claude", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...(options?.signal !== undefined && { signal: options.signal }),
      });

      // Capture stderr in parallel so we can surface it on failure.
      const stderrPromise = new Response(proc.stderr).text();

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }

      await proc.exited;
      if (proc.exitCode !== 0) {
        const stderr = await stderrPromise;
        throw new Error(
          `claude -p exited ${proc.exitCode}: ${stderr.slice(0, 500)}`,
        );
      }
    },
  };
}
