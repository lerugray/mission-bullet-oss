// mission-bullet — `bullet claude-note` command (parallel-journal).
//
// Two modes, one command:
//
//   bullet claude-note [YYYY-MM-DD]
//     Opens/creates the sibling notes file in your editor. Pure
//     file plumbing, no LLM call.
//
//   bullet claude-note [YYYY-MM-DD] --ask "<question>" [--model <id>] [--dry-run]
//     Invokes an LLM provider with the raw entry and any prior Q&A
//     in the notes file as conversation context. Streams the
//     response to stdout and appends it to `DD.claude.md` as a new
//     timestamped section.
//
// ## Why this command exists
//
// The user sometimes has substantive conversations with an AI
// assistant about a day's entry — honest feedback, pushback,
// reading pointers. Those conversations are worth preserving for
// future reflection, but they are NOT raw journal content and must
// not contaminate it. The parallel-journal pattern solves this: a
// sibling file lives next to `DD.md` (raw), clearly labeled as AI
// commentary, never merged back into the raw.
//
// In `--ask` mode the tool invokes the LLM itself (via the mb-002
// provider abstraction), so the user can ask from the shell without
// being in a Claude Code session. In editor mode the tool stays
// pure plumbing — commentary gets written by whichever assistant
// the user is working with, pasted in by hand if they like.
//
// The "no AI-authored entries" rule still holds either way. The AI
// writes to `DD.claude.md` only when the user explicitly asks. It
// never touches `DD.md`.
//
// `list` and `tasks` skip `*.claude.md` files so parallel-note
// content never shows up as entries or has its checkboxes counted
// as user tasks.

import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import {
  rawEntryPath,
  readEntry,
} from "./entry-io";
import { createDryRunProvider } from "./providers/dry-run";
import { resolveProvider } from "./providers/registry";
import type { ChatMessage, ProviderKind } from "./providers/types";
import { VALID_PROVIDER_KINDS } from "./providers/types";
import { nowEasternIso, resolveEditor, resolveToday } from "./today";
import type { ISODate } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Default model for the --ask flow when no --model flag / env override. */
const DEFAULT_ASK_MODEL = "google/gemma-4-31b-it:free";

/** Build the `entries/YYYY/MM/DD.claude.md` path for the given date. */
export function claudeNotePath(
  entriesDir: string,
  date: ISODate,
): string {
  const parts = date.split("-");
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  return join(entriesDir, year, month, `${day}.claude.md`);
}

/**
 * Skeleton for a new parallel-notes file. Short on purpose — title
 * and framing paragraph only. Actual commentary lands after the
 * `---` separator, one section per `--ask` invocation (or anything
 * the user pastes in manually in editor mode).
 */
export function buildClaudeNoteSkeleton(date: ISODate): string {
  const day = date.split("-")[2] ?? "??";
  return (
    `# Claude — parallel notes, ${date}\n` +
    `\n` +
    `*A commentary track kept alongside the day's raw entry at ` +
    `\`${day}.md\`. Not part of the raw journal. Written only when ` +
    `the user explicitly asks for AI commentary on something they ` +
    `wrote. Safe to delete anytime.*\n` +
    `\n` +
    `---\n` +
    `\n`
  );
}

// ---- Voice prompt ---------------------------------------------------

// Tone validated in real journaling-with-AI use: peer-reading-a-
// friend's-journal, not coach or assistant. Any change here should
// follow an actual observed session that made it feel stale — don't
// tune this against theoretical improvement.
const CLAUDE_NOTE_VOICE = `\
You are writing commentary for the user's personal bullet journal. They have written a raw entry today and are asking you, in the section below, for honest feedback on something in it. You are NOT writing a journal entry — you are commenting on one. Keep that distinction sharp.

Voice rules, in priority order:

1. Honest. Push back where warranted. Disagree where you disagree. Name what you actually think.
2. No sycophancy. No "great question" openers. No closing affirmations. No "hope this helps."
3. No therapy-speak. No feelings-reflecting ("it sounds like you're..."). No unsolicited life advice.
4. No moralizing. If the topic is political or contested, engage the substance; skip the "reasonable people disagree" throat-clearing.
5. Peer reading a friend's journal — not an assistant, not a coach, not an analyst-for-hire.
6. If their argument leans on weak sourcing, flag better sources. If the entry's tone would hurt reception in public, say so.
7. Plain prose. Use **bold** sparingly. Avoid bullet lists unless the content is genuinely list-shaped. Match the length the question calls for — not more.

Respond to the user's question directly. No preamble. No summary of what you're about to say. No emoji unless they've used them.`;

/**
 * Build the system prompt sent to the model. Voice + raw entry.
 * Prior Q&A travels as user/assistant turns in the messages list,
 * not inlined here.
 */
export function buildSystemPrompt(rawBody: string): string {
  return (
    CLAUDE_NOTE_VOICE +
    `\n\n---\n\n` +
    `Raw entry the user wrote today:\n\n${rawBody.trim()}\n`
  );
}

// ---- Prior-turn parsing ---------------------------------------------

export interface PriorTurn {
  question: string;
  response: string;
}

/**
 * Parse an existing claude-note file for prior Q&A sections so a
 * follow-up `--ask` inherits conversational context. Section shape:
 *
 *   ## 2026-04-22T05:30:00-04:00 — openrouter:<model>
 *
 *   **Question:** his question text
 *
 *   response body (may span many lines)
 *
 * The skeleton header + `---` separator precede the first section,
 * so we ignore anything before the first `## ` line.
 */
export function parsePriorTurns(fileContent: string): PriorTurn[] {
  const lines = fileContent.split("\n");
  const turns: PriorTurn[] = [];

  let inSection = false;
  let sectionLines: string[] = [];

  const flush = (): void => {
    if (sectionLines.length === 0) return;
    // The first `**Question:** ...` line is the question; the rest
    // is the response. If no question line appears, treat the whole
    // section as a response to an unknown question — we keep it so
    // the model sees the assistant history, but use a placeholder.
    let question = "(earlier question)";
    const bodyLines: string[] = [];
    let foundQuestion = false;
    for (const line of sectionLines) {
      if (!foundQuestion) {
        const m = /^\*\*Question:\*\*\s+(.+?)\s*$/.exec(line);
        if (m && m[1]) {
          question = m[1];
          foundQuestion = true;
          continue;
        }
        if (line.trim() === "") continue;
      }
      bodyLines.push(line);
    }
    turns.push({
      question,
      response: bodyLines.join("\n").trim(),
    });
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (inSection) flush();
      inSection = true;
      sectionLines = [];
      continue;
    }
    if (inSection) sectionLines.push(line);
  }
  if (inSection) flush();

  return turns;
}

/**
 * Build the chat-message array. System prompt holds the entry
 * context; prior Q&A becomes alternating user/assistant turns; the
 * new ask is the final user turn.
 */
export function buildMessages(
  rawBody: string,
  priorTurns: PriorTurn[],
  newAsk: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(rawBody) },
  ];
  for (const t of priorTurns) {
    messages.push({ role: "user", content: t.question });
    messages.push({ role: "assistant", content: t.response });
  }
  messages.push({ role: "user", content: newAsk });
  return messages;
}

/**
 * Shape a single response section as markdown. Called once per
 * successful (or partially successful) `--ask` and appended to the
 * claude-note file.
 */
export function formatResponseSection(params: {
  timestamp: string;
  providerId: string;
  model: string;
  ask: string;
  response: string;
  truncated: boolean;
  truncationReason: string | null;
}): string {
  const { timestamp, providerId, model, ask, response, truncated, truncationReason } = params;
  const modelLabel = model && model !== providerId ? `${providerId} (${model})` : providerId;
  const trailer = truncated
    ? `\n\n*[TRUNCATED mid-response: ${truncationReason ?? "unknown error"}]*`
    : "";
  return (
    `## ${timestamp} — ${modelLabel}\n` +
    `\n` +
    `**Question:** ${ask}\n` +
    `\n` +
    response.trim() +
    trailer +
    `\n\n`
  );
}

/**
 * Pick the model id to hand the provider.
 *
 * Precedence: `--model` flag beats everything. If the user has
 * overridden the provider with `--provider` for this call, we
 * deliberately ignore the env-default model — it was configured
 * for whatever provider the env picked, and is almost certainly a
 * bad id for the provider they just asked for (e.g. an OpenRouter
 * model id won't mean anything to the Claude CLI). In that case
 * we return null and let the provider pick its own default (Claude
 * CLI → Sonnet, Ollama → its configured model, etc.).
 *
 * On the non-override path we use `MISSION_BULLET_CLAUDE_NOTE_MODEL`
 * if set, otherwise the OpenRouter-specific default (Gemma free)
 * when the resolved provider is OpenRouter, otherwise null.
 */
export function resolveAskModel(
  flagModel: string | null,
  flagProvider: ProviderKind | null,
  resolvedProviderKind: ProviderKind,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (flagModel !== null) return flagModel;
  if (flagProvider !== null) return null;
  const modelFromEnv = env.MISSION_BULLET_CLAUDE_NOTE_MODEL?.trim() || null;
  if (modelFromEnv !== null) return modelFromEnv;
  if (resolvedProviderKind === "openrouter") return DEFAULT_ASK_MODEL;
  return null;
}

// ---- CLI arg parsing ------------------------------------------------

interface ClaudeNoteArgs {
  date: ISODate;
  ask: string | null;
  model: string | null;
  /** Explicit provider override — bypasses env-driven resolution. */
  provider: ProviderKind | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ClaudeNoteArgs {
  let date: ISODate | null = null;
  let ask: string | null = null;
  let model: string | null = null;
  let provider: ProviderKind | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--ask") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--ask requires a question string");
      }
      ask = next;
      continue;
    }
    if (arg === "--model") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--model requires a model id");
      }
      model = next;
      continue;
    }
    if (arg === "--provider") {
      const next = argv[++i];
      if (next === undefined) {
        throw new Error("--provider requires a kind");
      }
      const kindLower = next.trim().toLowerCase();
      if (!VALID_PROVIDER_KINDS.includes(kindLower as ProviderKind)) {
        throw new Error(
          `--provider must be one of ${VALID_PROVIDER_KINDS.join(", ")} (got "${next}")`,
        );
      }
      provider = kindLower as ProviderKind;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (date !== null) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    if (!ISO_DATE.test(arg)) {
      throw new Error(`Date must be YYYY-MM-DD: got "${arg}"`);
    }
    date = arg;
  }
  return { date: date ?? resolveToday(), ask, model, provider, dryRun };
}

// ---- Command dispatch -----------------------------------------------

export async function runClaudeNote(argv: string[]): Promise<number> {
  let args: ClaudeNoteArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`claude-note: ${msg}`);
    console.error(
      'Usage: bullet claude-note [YYYY-MM-DD] [--ask "<question>"] [--model <id>] [--dry-run]',
    );
    return 2;
  }

  if (args.ask !== null) {
    return runAskMode(args);
  }
  return runEditorMode(args);
}

async function runEditorMode(args: ClaudeNoteArgs): Promise<number> {
  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const path = claudeNotePath(entriesDir, args.date);

  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buildClaudeNoteSkeleton(args.date), "utf8");
  }

  const editorCommand = resolveEditor();
  const parts = editorCommand.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    console.error("No editor resolved; file written, open manually at:");
    console.error(`  ${path}`);
    return 0;
  }
  const proc = Bun.spawn([...parts, path], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  console.log(`Saved ${path}`);
  return proc.exitCode ?? 0;
}

async function runAskMode(args: ClaudeNoteArgs): Promise<number> {
  const ask = args.ask;
  if (ask === null) {
    // Guarded by caller but keeps TS happy.
    return 2;
  }

  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const rawPath = rawEntryPath(entriesDir, args.date);
  const notePath = claudeNotePath(entriesDir, args.date);

  if (!existsSync(rawPath)) {
    console.error(`No raw entry for ${args.date} at ${rawPath}.`);
    console.error(
      "Tip: run `bullet today` first, or pass a date that has an entry.",
    );
    return 1;
  }

  const entry = await readEntry(rawPath);
  const rawBody = entry.rawMarkdown.trim();
  if (rawBody.length === 0) {
    console.error(
      `Entry for ${args.date} is empty — nothing to comment on.`,
    );
    return 1;
  }

  let priorTurns: PriorTurn[] = [];
  if (existsSync(notePath)) {
    const existing = await readFile(notePath, "utf8");
    priorTurns = parsePriorTurns(existing);
  }

  // Provider selection:
  // --dry-run wins (never hits a real LLM).
  // --provider <kind> overrides env-driven resolution for this call.
  // Otherwise the env-driven resolver runs as-normal.
  const provider = args.dryRun
    ? createDryRunProvider()
    : args.provider !== null
      ? await resolveProvider({
          ...process.env,
          MISSION_BULLET_PROVIDER: args.provider,
        })
      : await resolveProvider();

  const model = resolveAskModel(args.model, args.provider, provider.kind);

  console.error(
    `Asking ${provider.id}${model ? ` (model=${model})` : ""} about ${args.date}...\n`,
  );

  const messages = buildMessages(rawBody, priorTurns, ask);

  let buffer = "";
  let truncated = false;
  let truncationReason: string | null = null;
  try {
    const chatOpts: { temperature: number; model?: string } = {
      temperature: 0.7,
    };
    if (model !== null) chatOpts.model = model;
    for await (const chunk of provider.chat(messages, chatOpts)) {
      buffer += chunk;
      process.stdout.write(chunk);
    }
  } catch (e) {
    truncated = true;
    truncationReason = e instanceof Error ? e.message : String(e);
  }
  process.stdout.write("\n");

  if (buffer.trim().length === 0) {
    console.error(
      "claude-note: model returned no response. Nothing written.",
    );
    if (truncated) {
      console.error(`(underlying error: ${truncationReason})`);
    }
    return 1;
  }

  const section = formatResponseSection({
    timestamp: nowEasternIso(),
    providerId: provider.id,
    model: model ?? "",
    ask,
    response: buffer,
    truncated,
    truncationReason,
  });

  await mkdir(dirname(notePath), { recursive: true });
  if (!existsSync(notePath)) {
    await writeFile(
      notePath,
      buildClaudeNoteSkeleton(args.date) + section,
      "utf8",
    );
  } else {
    const existing = await readFile(notePath, "utf8");
    // Guarantee a blank line between existing content and the new
    // `## ...` header, regardless of how the file previously ended.
    let prefix = "";
    if (!existing.endsWith("\n")) prefix = "\n\n";
    else if (!existing.endsWith("\n\n")) prefix = "\n";
    await writeFile(notePath, existing + prefix + section, "utf8");
  }

  console.error("");
  console.error(`Appended -> ${notePath}`);
  if (truncated) {
    console.error(
      `warning: response truncated (${truncationReason}). Partial saved.`,
    );
    return 1;
  }
  return 0;
}
