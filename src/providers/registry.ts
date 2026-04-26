// mission-bullet — provider registry (mb-002)
//
// Resolve which LLMProvider to use based on env-var presence.
// Priority (first match wins):
//   1. MISSION_BULLET_PROVIDER=<kind>   — explicit override
//   2. OLLAMA_BASE_URL reachable         — best privacy (local)
//   3. OPENROUTER_API_KEY                — explicit cloud choice
//   4. `claude` CLI on PATH              — subscription-based fallback
//   5. Error — no provider available
//
// Rationale for #4 being the fallback: most users will have Claude
// Code installed already (same CLI running this file, often), so it
// works out of the box without env-var setup. Ollama stays #2
// because entries are personal data — local inference keeps them
// off the network by default whenever the hardware can handle it.

import type { LLMProvider, ProviderKind } from "./types";
import { VALID_PROVIDER_KINDS } from "./types";
import { createClaudeProvider } from "./claude";
import { createDryRunProvider } from "./dry-run";
import { createOpenRouterProvider } from "./openrouter";
import { createOllamaProvider } from "./ollama";

export class NoProviderAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderAvailableError";
  }
}

function defaultModelFor(kind: "openrouter" | "ollama"): string {
  switch (kind) {
    case "openrouter":
      return "anthropic/claude-sonnet-4-6";
    case "ollama":
      return "qwen2.5:7b";
  }
}

function resolveModel(
  kind: "openrouter" | "ollama",
  env: Record<string, string | undefined>,
): string {
  return env.MISSION_BULLET_LLM_MODEL?.trim() || defaultModelFor(kind);
}

async function isOllamaReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/api/tags`,
      { method: "GET", signal: AbortSignal.timeout(2000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function isClaudeCliOnPath(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["claude", "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the best available provider given the current environment.
 * See the priority order at the top of this file.
 */
export async function resolveProvider(
  env: Record<string, string | undefined> = process.env,
): Promise<LLMProvider> {
  // 1. Explicit override
  const explicit = env.MISSION_BULLET_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (!VALID_PROVIDER_KINDS.includes(explicit as ProviderKind)) {
      throw new NoProviderAvailableError(
        `MISSION_BULLET_PROVIDER="${explicit}" is not one of ${VALID_PROVIDER_KINDS.join(", ")}`,
      );
    }
    return buildProviderExplicit(explicit as ProviderKind, env);
  }

  // 2. Ollama (privacy-preferred)
  const ollamaUrl = env.OLLAMA_BASE_URL?.trim();
  if (ollamaUrl && (await isOllamaReachable(ollamaUrl))) {
    return createOllamaProvider({
      baseUrl: ollamaUrl,
      model: resolveModel("ollama", env),
    });
  }

  // 3. OpenRouter
  const openrouterKey = env.OPENROUTER_API_KEY?.trim();
  if (openrouterKey) {
    return createOpenRouterProvider({
      apiKey: openrouterKey,
      model: resolveModel("openrouter", env),
    });
  }

  // 4. Claude CLI
  if (await isClaudeCliOnPath()) {
    const modelOverride = env.MISSION_BULLET_LLM_MODEL?.trim();
    return createClaudeProvider(modelOverride || undefined);
  }

  throw new NoProviderAvailableError(
    "No LLM provider available. Set one of the following (see .env.example):\n" +
      "  OLLAMA_BASE_URL   (with a reachable Ollama server)\n" +
      "  OPENROUTER_API_KEY\n" +
      "  or install the Claude Code CLI (https://claude.com/claude-code)",
  );
}

function buildProviderExplicit(
  kind: ProviderKind,
  env: Record<string, string | undefined>,
): LLMProvider {
  switch (kind) {
    case "claude": {
      const modelOverride = env.MISSION_BULLET_LLM_MODEL?.trim();
      return createClaudeProvider(modelOverride || undefined);
    }
    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY?.trim();
      if (!apiKey) {
        throw new NoProviderAvailableError(
          "MISSION_BULLET_PROVIDER=openrouter requires OPENROUTER_API_KEY",
        );
      }
      return createOpenRouterProvider({
        apiKey,
        model: resolveModel("openrouter", env),
      });
    }
    case "ollama": {
      const baseUrl = env.OLLAMA_BASE_URL?.trim();
      if (!baseUrl) {
        throw new NoProviderAvailableError(
          "MISSION_BULLET_PROVIDER=ollama requires OLLAMA_BASE_URL",
        );
      }
      return createOllamaProvider({
        baseUrl,
        model: resolveModel("ollama", env),
      });
    }
    case "dry-run":
      return createDryRunProvider();
  }
}
