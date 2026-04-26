// mission-bullet — Ollama provider (mb-002)
//
// HTTP streaming chat against a local Ollama server. Preferred for
// personal-data privacy when hardware allows — entries never leave
// the machine. Ollama streams as ndjson (newline-delimited JSON);
// each line is a message fragment.

import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
} from "./types";

export function createOllamaProvider(config: {
  baseUrl: string;
  model: string;
}): LLMProvider {
  const host = config.baseUrl.replace(/\/$/, "");
  return {
    kind: "ollama",
    id: `ollama:${config.model}`,
    async *chat(
      messages: ChatMessage[],
      options?: ChatOptions,
    ): AsyncIterable<string> {
      const model = options?.model ?? config.model;
      const ollamaOptions: Record<string, unknown> = {};
      if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature;
      if (options?.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens;

      const response = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          options: ollamaOptions,
        }),
        ...(options?.signal !== undefined && { signal: options.signal }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(
          `Ollama ${response.status} ${response.statusText}: ${errBody.slice(0, 500)}`,
        );
      }
      if (!response.body) {
        throw new Error("Ollama response missing body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // ndjson framing: one JSON object per line.
          while (true) {
            const newlineIdx = buffer.indexOf("\n");
            if (newlineIdx < 0) break;
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;
            try {
              const parsed = JSON.parse(line) as {
                message?: { content?: string };
                done?: boolean;
              };
              const content = parsed.message?.content;
              if (content) yield content;
              if (parsed.done) return;
            } catch {
              // Ollama occasionally emits partial lines during backpressure.
              // Skip malformed frames rather than crashing mid-stream.
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
