// mission-bullet — OpenRouter provider (mb-002)
//
// HTTP streaming chat against openrouter.ai's OpenAI-compatible
// endpoint. Requires OPENROUTER_API_KEY. Streams parsed as SSE
// (Server-Sent Events) — each `data:` line carries a JSON delta.

import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
} from "./types";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export function createOpenRouterProvider(config: {
  apiKey: string;
  model: string;
}): LLMProvider {
  return {
    kind: "openrouter",
    id: `openrouter:${config.model}`,
    async *chat(
      messages: ChatMessage[],
      options?: ChatOptions,
    ): AsyncIterable<string> {
      const model = options?.model ?? config.model;
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
      };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
          // Attribution headers — OpenRouter uses these for its
          // rankings + to identify the calling app in dashboards.
          "HTTP-Referer": "https://github.com/lerugray/mission-bullet",
          "X-Title": "mission-bullet",
        },
        body: JSON.stringify(body),
        ...(options?.signal !== undefined && { signal: options.signal }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(
          `OpenRouter ${response.status} ${response.statusText}: ${errBody.slice(0, 500)}`,
        );
      }
      if (!response.body) {
        throw new Error("OpenRouter response missing body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE framing: split on newlines, process each `data:` line.
          while (true) {
            const newlineIdx = buffer.indexOf("\n");
            if (newlineIdx < 0) break;
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line || !line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) yield delta;
            } catch {
              // Skip malformed SSE frames — OpenRouter occasionally
              // sends keep-alive comments or partial JSON in flaky
              // networks. Better to drop the frame than to crash
              // mid-stream.
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
