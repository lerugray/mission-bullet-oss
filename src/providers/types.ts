// mission-bullet — LLM provider abstraction (mb-002)
//
// Streaming chat interface shared by three providers:
// - `claude`     — invokes the local Claude Code CLI (`claude -p ...`);
//                  uses the user's subscription, no API key needed.
// - `openrouter` — HTTP streaming against openrouter.ai (cloud).
// - `ollama`     — HTTP streaming against a local Ollama server.
//
// Shape differs from GS's one-shot `invoke` because mb-004/005 need
// token-level streaming for review UX — the user sees the AI's
// response arrive incrementally rather than waiting on a full reply.
//
// No consumer imports these files directly; everything flows through
// `resolveProvider()` in ./registry.ts.

export type ProviderKind = "claude" | "openrouter" | "ollama" | "dry-run";

export const VALID_PROVIDER_KINDS: readonly ProviderKind[] = [
  "claude",
  "openrouter",
  "ollama",
  "dry-run",
];

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** Override the provider's configured model for this call. */
  model?: string;
  /** Sampling temperature. Default chosen per-provider. */
  temperature?: number;
  /** Hard cap on response tokens. */
  maxTokens?: number;
  /** Abort signal for cancellation (Ctrl-C or timeout). */
  signal?: AbortSignal;
}

export interface LLMProvider {
  kind: ProviderKind;
  /** Human-readable id, e.g. "claude" or "openrouter:anthropic/claude-sonnet-4-6". */
  id: string;
  /**
   * Stream chat response tokens. Yields plain text fragments; the
   * caller concatenates to assemble the full response. Throws on
   * transport errors.
   */
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}
