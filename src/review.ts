// mission-bullet — `bullet review week` command (mb-005).
//
// Orchestrates a weekly bullet-journal review:
//   1. Resolve the ISO week to a Mon–Sun date range.
//   2. Load the raw entries that exist in that range.
//   3. Print a short summary so the user sees what the model's about
//      to read.
//   4. One LLM call returns themes + migration candidates as JSON.
//   5. For each migration candidate: interactive y/n/defer prompt.
//   6. Assemble a reflections/YYYY-WNN.md file with section headers
//      that make AI-authored vs user-authored content visually
//      distinct, plus a structured frontmatter block at the bottom.
//   7. Open the file in the user's editor so they can type the
//      "Your reflection notes" section free-form.
//
// ## Design notes
//
// - Only raw entries feed the model — that's the source of truth.
// - Migration is proposed here, not executed — accepted candidates
//   are recorded with `user_decision: "accept"` but copy-forward
//   into next week's daily entries is mb-007 territory.
// - Interactive prompt lives behind a small `decide()` function so a
//   GUI (such as the Electron desktop app under desktop-app/) can
//   swap the terminal UX out without rewriting the review engine.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "path";
import { atomicWrite, rawEntryPath } from "./entry-io";
import {
  assembleReflectionFile,
  parseMonthlyLogFile,
} from "./frontmatter";
import {
  formatIsoWeek,
  isoDateRangeIter,
  isoWeekDateRange,
  parseIsoWeek,
} from "./isoweek";
import {
  migrateAccepted,
  migrateAcceptedToMonth,
  type MigrationResult,
} from "./migrate";
import {
  currentYearMonth,
  monthDateRange,
  monthlyLogPath,
} from "./month";
import { createDryRunProvider } from "./providers/dry-run";
import { resolveProvider } from "./providers/registry";
import type { ChatMessage, LLMProvider } from "./providers/types";
import { parseRawEntryFile } from "./frontmatter";
import { nowEasternIso, resolveEditor } from "./today";
import type {
  ISODate,
  MigrationCandidate,
  MigrationDecision,
  ReflectionFrontmatter,
  Theme,
} from "./types";

interface ReviewArgs {
  weekSpec: string;
  force: boolean;
  dryRun: boolean;
  /**
   * GUI mode — defer all migration candidates instead of prompting,
   * skip the editor handoff at the end. The desktop app spawns the
   * CLI with this flag so a user who never touches the terminal can
   * still produce reflection files; per-migration accept/reject
   * happens later in the GUI against the saved YAML.
   */
  nonInteractive: boolean;
}

interface WeekEntry {
  date: ISODate;
  rawBody: string;
  rawPath: string;
}

interface ModelTheme {
  label: string;
  entries_mentioning: string[];
  notes: string | null;
}

interface ModelMigration {
  source_entry_date: string;
  source_text_fragment: string;
  reason_for_surfacing: string;
}

interface ModelReviewResponse {
  themes: ModelTheme[];
  migrations: ModelMigration[];
}

function parseArgs(argv: string[]): ReviewArgs {
  let weekSpec: string | null = null;
  let force = false;
  let dryRun = false;
  let nonInteractive = false;
  for (const arg of argv) {
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (weekSpec !== null) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    weekSpec = arg;
  }
  return { weekSpec: weekSpec ?? formatIsoWeek(), force, dryRun, nonInteractive };
}

/**
 * Convert model migrations to candidates with `defer` for everything
 * — the GUI's stand-in for `decideMigrationsInteractively`. The user
 * later flips them to accept/reject from the desktop app's WeeklyView,
 * which writes back to the reflection file.
 */
function deferAllMigrations(
  migrations: ModelMigration[],
): MigrationCandidate[] {
  return migrations.map((m) => ({
    source_entry_date: m.source_entry_date,
    source_text_fragment: m.source_text_fragment,
    reason_for_surfacing: m.reason_for_surfacing,
    user_decision: "defer" as const,
    migrated_to: null,
  }));
}

async function loadEntriesInRange(
  entriesDir: string,
  start: ISODate,
  end: ISODate,
): Promise<WeekEntry[]> {
  const result: WeekEntry[] = [];
  for (const date of isoDateRangeIter(start, end)) {
    const path = rawEntryPath(entriesDir, date);
    if (!existsSync(path)) continue;
    const content = await readFile(path, "utf8");
    const { body } = parseRawEntryFile(content);
    const trimmed = body.trim();
    // Skip skeleton-only entries — they add noise to the model input
    // without informing theme detection.
    if (trimmed.length < 10) continue;
    result.push({ date, rawBody: trimmed, rawPath: path });
  }
  return result;
}

function printWeekSummary(
  weekSpec: string,
  start: ISODate,
  end: ISODate,
  entries: WeekEntry[],
): void {
  console.error(`\nWeek ${weekSpec} (${start} to ${end})`);
  console.error(`Entries found: ${entries.length}`);
  for (const e of entries) {
    const firstLine = e.rawBody.split("\n").find((l) => l.trim().length > 0) ?? "";
    const snippet =
      firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
    console.error(`  ${e.date}  ${snippet}`);
  }
  console.error("");
}

function buildReviewSystemPrompt(scopeLabel: string, nextScopeLabel: string): string {
  return `\
You are analyzing ${scopeLabel} of a personal bullet-journal for patterns. Your output is structural analysis, not interpretation or advice.

You will receive a set of daily entries, each with an ISO date and raw text. Your job:

(a) Identify themes that actually appear across multiple entries.
(b) Identify migration candidates — items the user explicitly named as open tasks, recurring concerns, or unresolved questions that might carry forward into ${nextScopeLabel}.

Hard rules:

1. Only surface themes that actually appear in the source. No inferences about what the user "must be feeling" or interpretations of their mood.
2. Only surface migration candidates the user explicitly named — tasks they said, questions they asked, concerns they raised. If it's implicit, leave it.
3. For each theme, list the ISO dates of entries that mention it.
4. For each migration candidate, quote a short verbatim fragment from the source (<= 20 words), the ISO date it came from, and a one-sentence reason.
5. Don't editorialize, advise, or comfort. This is analysis, not therapy.

Output format: a single JSON object. Nothing else — no preamble, no markdown fences, no trailing commentary.

{
  "themes": [
    {"label": "short lowercase noun-phrase", "entries_mentioning": ["YYYY-MM-DD", ...], "notes": null}
  ],
  "migrations": [
    {"source_entry_date": "YYYY-MM-DD", "source_text_fragment": "short verbatim quote", "reason_for_surfacing": "one sentence"}
  ]
}

Up to 6 themes, up to 8 migration candidates. Return empty arrays if none found. The "notes" field on a theme is null by default; set it only if there's a specific factual observation worth recording (e.g. frequency or span).`;
}

function buildReviewUserMessage(
  scopeHeader: string,
  entries: WeekEntry[],
  extraContext: { label: string; body: string } | null,
): string {
  const lines: string[] = [scopeHeader, ""];
  for (const e of entries) {
    lines.push(`### ${e.date}`);
    lines.push("");
    lines.push(e.rawBody);
    lines.push("");
  }
  if (extraContext) {
    lines.push(`### ${extraContext.label}`);
    lines.push("");
    lines.push(extraContext.body);
    lines.push("");
  }
  return lines.join("\n");
}

function extractJsonObject(raw: string): string {
  // Robust brace-match that respects JSON strings and escapes — the
  // model occasionally wraps output in ```json fences or adds a
  // leading "Here's the analysis:" line despite prompt instructions.
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in model response");
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced braces in model response");
}

function isModelReviewResponse(v: unknown): v is ModelReviewResponse {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.themes) || !Array.isArray(o.migrations)) return false;
  for (const t of o.themes) {
    if (t == null || typeof t !== "object") return false;
    const tt = t as Record<string, unknown>;
    if (typeof tt.label !== "string") return false;
    if (
      !Array.isArray(tt.entries_mentioning) ||
      !tt.entries_mentioning.every((x) => typeof x === "string")
    ) {
      return false;
    }
    if (tt.notes !== null && typeof tt.notes !== "string") return false;
  }
  for (const m of o.migrations) {
    if (m == null || typeof m !== "object") return false;
    const mm = m as Record<string, unknown>;
    if (
      typeof mm.source_entry_date !== "string" ||
      typeof mm.source_text_fragment !== "string" ||
      typeof mm.reason_for_surfacing !== "string"
    ) {
      return false;
    }
  }
  return true;
}

async function callModelForReview(
  provider: LLMProvider,
  scopeLabel: string,
  nextScopeLabel: string,
  scopeHeader: string,
  entries: WeekEntry[],
  extraContext: { label: string; body: string } | null,
): Promise<ModelReviewResponse> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildReviewSystemPrompt(scopeLabel, nextScopeLabel),
    },
    {
      role: "user",
      content: buildReviewUserMessage(scopeHeader, entries, extraContext),
    },
  ];
  console.error(`Surfacing themes + migration candidates via ${provider.id}...`);
  let buffer = "";
  for await (const chunk of provider.chat(messages, {
    temperature: 0.2,
    maxTokens: 2000,
  })) {
    buffer += chunk;
  }
  const jsonText = extractJsonObject(buffer);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Model response was not valid JSON: ${msg}`);
  }
  if (!isModelReviewResponse(parsed)) {
    throw new Error(
      `Model response did not match expected schema. Got: ${jsonText.slice(0, 400)}`,
    );
  }
  return parsed;
}

/**
 * Interactive migration-decision prompt. Isolated behind a small
 * function so a future GUI can swap in its own decide UI without
 * touching the review engine.
 */
async function decideMigrationsInteractively(
  migrations: ModelMigration[],
): Promise<MigrationCandidate[]> {
  if (migrations.length === 0) return [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const decided: MigrationCandidate[] = [];

  try {
    for (let i = 0; i < migrations.length; i++) {
      const m = migrations[i];
      if (m === undefined) continue;
      console.error("");
      console.error(`Migration ${i + 1}/${migrations.length}:`);
      console.error(`  Date:     ${m.source_entry_date}`);
      console.error(`  Fragment: "${m.source_text_fragment}"`);
      console.error(`  Reason:   ${m.reason_for_surfacing}`);

      let decision: MigrationDecision | null = null;
      while (decision === null) {
        const answer = (
          await rl.question("  [y]accept / [n]reject / [d]efer / [q]uit: ")
        )
          .trim()
          .toLowerCase();
        if (answer === "y" || answer === "yes") decision = "accept";
        else if (answer === "n" || answer === "no") decision = "reject";
        else if (answer === "d" || answer === "defer") decision = "defer";
        else if (answer === "q" || answer === "quit") {
          // Mark remaining migrations as pending and return.
          for (let j = i; j < migrations.length; j++) {
            const mj = migrations[j];
            if (mj === undefined) continue;
            decided.push({
              source_entry_date: mj.source_entry_date,
              source_text_fragment: mj.source_text_fragment,
              reason_for_surfacing: mj.reason_for_surfacing,
              user_decision: "pending",
              migrated_to: null,
            });
          }
          return decided;
        } else {
          console.error("  (type y, n, d, or q)");
        }
      }

      decided.push({
        source_entry_date: m.source_entry_date,
        source_text_fragment: m.source_text_fragment,
        reason_for_surfacing: m.reason_for_surfacing,
        user_decision: decision,
        migrated_to: null,
      });
    }
    return decided;
  } finally {
    rl.close();
  }
}

/** Fill in first_seen / last_seen from entries_mentioning (min / max). */
function enrichThemes(raw: ModelTheme[]): Theme[] {
  return raw.map((t) => {
    const sorted = [...t.entries_mentioning].sort();
    const firstSeen = sorted[0] ?? "";
    const lastSeen = sorted[sorted.length - 1] ?? firstSeen;
    return {
      label: t.label,
      entries_mentioning: sorted,
      first_seen: firstSeen,
      last_seen: lastSeen,
      notes: t.notes,
    };
  });
}

function renderReflectionBody(
  weekSpec: string,
  start: ISODate,
  end: ISODate,
  themes: Theme[],
  migrations: MigrationCandidate[],
  entriesReviewed: ISODate[],
  generatedAt: string,
  modelId: string,
): string {
  const lines: string[] = [];
  lines.push(
    `<!-- mission-bullet weekly reflection for ${weekSpec} (${start} – ${end}).`,
  );
  lines.push(`     generated ${generatedAt} by ${modelId}.`);
  lines.push(
    "     Everything above \"Your reflection notes\" is AI-surfaced from the week's entries.",
  );
  lines.push(
    "     The section below is yours; type freely. The structured metadata at the",
  );
  lines.push("     bottom is machine-readable and shouldn't be hand-edited. -->");
  lines.push("");
  lines.push(`# Week ${weekSpec} reflection`);
  lines.push("");
  lines.push(`_Range: ${start} to ${end}. Entries reviewed: ${entriesReviewed.length}._`);
  lines.push("");

  lines.push("## AI-surfaced themes");
  lines.push("");
  if (themes.length === 0) {
    lines.push("_(none surfaced this week)_");
  } else {
    for (const t of themes) {
      const span =
        t.first_seen === t.last_seen
          ? t.first_seen
          : `${t.first_seen}..${t.last_seen}`;
      const dates = t.entries_mentioning.join(", ");
      const suffix = t.notes ? ` — ${t.notes}` : "";
      lines.push(`- **${t.label}** (${span}; in ${dates})${suffix}`);
    }
  }
  lines.push("");

  lines.push("## AI-surfaced migration candidates — your decisions");
  lines.push("");
  if (migrations.length === 0) {
    lines.push("_(none surfaced this week)_");
  } else {
    for (const m of migrations) {
      const destSuffix =
        m.user_decision === "accept" && m.migrated_to
          ? ` → carried forward to ${m.migrated_to}`
          : "";
      lines.push(
        `- **${m.user_decision}**: "${m.source_text_fragment}" (${m.source_entry_date})${destSuffix}`,
      );
      lines.push(`  - Reason: ${m.reason_for_surfacing}`);
    }
  }
  lines.push("");

  lines.push("## Your reflection notes");
  lines.push("");
  lines.push(
    "<!-- Write your own reflection below. Everything above was surfaced by the model; this section is yours. -->",
  );
  lines.push("");
  lines.push("");

  return lines.join("\n");
}

export async function runReviewWeek(argv: string[]): Promise<number> {
  let args: ReviewArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`review week: ${msg}`);
    console.error("Usage: bullet review week [YYYY-WNN] [--force]");
    return 2;
  }

  let year: number;
  let week: number;
  try {
    ({ year, week } = parseIsoWeek(args.weekSpec));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`review week: ${msg}`);
    return 2;
  }
  const { start, end } = isoWeekDateRange(year, week);

  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const reflectionsDir = resolve(repoRoot, "reflections");
  const reflectionPath = join(reflectionsDir, `${args.weekSpec}.md`);

  if (existsSync(reflectionPath) && !args.force) {
    console.error(
      `${reflectionPath} already exists. Pass --force to overwrite it.`,
    );
    return 1;
  }

  const entries = await loadEntriesInRange(entriesDir, start, end);
  if (entries.length === 0) {
    console.error(
      `No entries for week ${args.weekSpec} (${start} to ${end}). Nothing to review.`,
    );
    return 0;
  }

  printWeekSummary(args.weekSpec, start, end, entries);

  const provider = args.dryRun
    ? createDryRunProvider()
    : await resolveProvider();
  let modelResponse: ModelReviewResponse;
  try {
    modelResponse = await callModelForReview(
      provider,
      "a week",
      "next week",
      `Week ${args.weekSpec} (${start} to ${end}). Entries:`,
      entries,
      null,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`review week: ${msg}`);
    return 1;
  }

  const themes = enrichThemes(modelResponse.themes);
  const migrations = args.nonInteractive
    ? deferAllMigrations(modelResponse.migrations)
    : await decideMigrationsInteractively(modelResponse.migrations);

  // Carry accepted items forward into next Monday's entry before we
  // write the reflection — migration mutates each accepted candidate's
  // `migrated_to` field in place, so the reflection frontmatter +
  // rendered body both record where items actually landed.
  const accepted = migrations.filter((m) => m.user_decision === "accept");
  let migrationResult: MigrationResult | null = null;
  if (accepted.length > 0) {
    try {
      migrationResult = await migrateAccepted(
        accepted,
        args.weekSpec,
        entriesDir,
        repoRoot,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`review week: migration failed — ${msg}`);
      return 1;
    }
  }

  const entriesReviewed = entries.map((e) => e.date);
  const generatedAt = nowEasternIso();
  const frontmatter: ReflectionFrontmatter = {
    period: "week",
    start_date: start,
    end_date: end,
    entries_reviewed: entriesReviewed,
    themes_surfaced: themes,
    migrations_proposed: migrations,
  };
  const body = renderReflectionBody(
    args.weekSpec,
    start,
    end,
    themes,
    migrations,
    entriesReviewed,
    generatedAt,
    provider.id,
  );
  const content = assembleReflectionFile(body, frontmatter);
  await atomicWrite(reflectionPath, content);

  console.error("");
  console.error(`Wrote reflection -> ${reflectionPath}`);
  console.error(
    `Themes: ${themes.length}   Migrations: ${migrations.length}` +
      `   (${migrations.filter((m) => m.user_decision === "accept").length} accepted, ` +
      `${migrations.filter((m) => m.user_decision === "defer").length} deferred, ` +
      `${migrations.filter((m) => m.user_decision === "reject").length} rejected)`,
  );
  if (migrationResult && migrationResult.itemsAdded > 0) {
    console.error(
      `Carried ${migrationResult.itemsAdded} item(s) forward -> ${migrationResult.destinationPath}`,
    );
    if (migrationResult.itemsAlreadyPresent > 0) {
      console.error(
        `  (${migrationResult.itemsAlreadyPresent} already present from a prior migration, skipped)`,
      );
    }
  } else if (migrationResult && migrationResult.itemsAlreadyPresent > 0) {
    console.error(
      `All ${migrationResult.itemsAlreadyPresent} accepted item(s) were already at ${migrationResult.destinationPath} from a prior run.`,
    );
  }
  console.error("");
  if (args.nonInteractive) {
    console.error(`Saved ${reflectionPath}`);
    return 0;
  }
  console.error(
    "Opening the file in your editor so you can add your own reflection notes...",
  );

  // Hand off to the editor for the user's reflection notes. Uses the
  // same editor-resolution path as `bullet today`.
  const editorCommand = resolveEditor();
  const parts = editorCommand.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    console.error(
      "Editor command resolved to empty string; reflection file written, open manually.",
    );
    return 0;
  }
  const proc = Bun.spawn([...parts, reflectionPath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  console.error(`Saved ${reflectionPath}`);
  return proc.exitCode ?? 0;
}

// ---------------------------------------------------------------------------
// Monthly review (mb-006)
// ---------------------------------------------------------------------------

interface ReviewMonthArgs {
  monthSpec: string;
  force: boolean;
  dryRun: boolean;
  nonInteractive: boolean;
}

function parseMonthArgs(argv: string[]): ReviewMonthArgs {
  let monthSpec: string | null = null;
  let force = false;
  let dryRun = false;
  let nonInteractive = false;
  for (const arg of argv) {
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (monthSpec !== null) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    monthSpec = arg;
  }
  return { monthSpec: monthSpec ?? currentYearMonth(), force, dryRun, nonInteractive };
}

function renderMonthReflectionBody(
  monthSpec: string,
  start: ISODate,
  end: ISODate,
  themes: Theme[],
  migrations: MigrationCandidate[],
  entriesReviewed: ISODate[],
  generatedAt: string,
  modelId: string,
  monthlyLogIncluded: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    `<!-- mission-bullet monthly reflection for ${monthSpec} (${start} – ${end}).`,
  );
  lines.push(`     generated ${generatedAt} by ${modelId}.`);
  lines.push(
    "     Everything above \"Your reflection notes\" is AI-surfaced from the month's entries",
  );
  lines.push(
    `     ${monthlyLogIncluded ? "and monthly log " : ""}— the section below is yours; type freely.`,
  );
  lines.push(
    "     The structured metadata at the bottom is machine-readable; don't hand-edit. -->",
  );
  lines.push("");
  lines.push(`# Month ${monthSpec} reflection`);
  lines.push("");
  lines.push(
    `_Range: ${start} to ${end}. Daily entries reviewed: ${entriesReviewed.length}${monthlyLogIncluded ? ". Monthly log included in analysis." : "."}_`,
  );
  lines.push("");

  lines.push("## AI-surfaced themes");
  lines.push("");
  if (themes.length === 0) {
    lines.push("_(none surfaced this month)_");
  } else {
    for (const t of themes) {
      const span =
        t.first_seen === t.last_seen
          ? t.first_seen
          : `${t.first_seen}..${t.last_seen}`;
      const dates = t.entries_mentioning.join(", ");
      const suffix = t.notes ? ` — ${t.notes}` : "";
      lines.push(`- **${t.label}** (${span}; in ${dates})${suffix}`);
    }
  }
  lines.push("");

  lines.push("## AI-surfaced migration candidates — your decisions");
  lines.push("");
  if (migrations.length === 0) {
    lines.push("_(none surfaced this month)_");
  } else {
    for (const m of migrations) {
      const destSuffix =
        m.user_decision === "accept" && m.migrated_to
          ? ` → carried forward to ${m.migrated_to}`
          : "";
      lines.push(
        `- **${m.user_decision}**: "${m.source_text_fragment}" (${m.source_entry_date})${destSuffix}`,
      );
      lines.push(`  - Reason: ${m.reason_for_surfacing}`);
    }
  }
  lines.push("");

  lines.push("## Your reflection notes");
  lines.push("");
  lines.push(
    "<!-- Write your own reflection below. Everything above was surfaced by the model; this section is yours. -->",
  );
  lines.push("");
  lines.push("");

  return lines.join("\n");
}

export async function runReviewMonth(argv: string[]): Promise<number> {
  let args: ReviewMonthArgs;
  try {
    args = parseMonthArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`review month: ${msg}`);
    console.error("Usage: bullet review month [YYYY-MM] [--force]");
    return 2;
  }
  if (!/^\d{4}-\d{2}$/.test(args.monthSpec)) {
    console.error(`review month: month must be YYYY-MM, got "${args.monthSpec}"`);
    return 2;
  }

  const { start, end } = monthDateRange(args.monthSpec);

  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const reflectionsDir = resolve(repoRoot, "reflections");
  const reflectionPath = join(reflectionsDir, `${args.monthSpec}.md`);

  if (existsSync(reflectionPath) && !args.force) {
    console.error(
      `${reflectionPath} already exists. Pass --force to overwrite it.`,
    );
    return 1;
  }

  const entries = await loadEntriesInRange(entriesDir, start, end);

  // Monthly log is extra context the model should see — that's where
  // the user wrote goals/bills/calendar, and themes often tie back to
  // those commitments. Include if present.
  const monthlyLog = monthlyLogPath(entriesDir, args.monthSpec);
  let monthlyLogBody: string | null = null;
  if (existsSync(monthlyLog)) {
    const content = await readFile(monthlyLog, "utf8");
    try {
      const { body } = parseMonthlyLogFile(content);
      const trimmed = body.trim();
      if (trimmed.length > 10) monthlyLogBody = trimmed;
    } catch {
      // Monthly log malformed — skip rather than fail the review.
    }
  }

  if (entries.length === 0 && !monthlyLogBody) {
    console.error(
      `No entries or monthly log for ${args.monthSpec} (${start} to ${end}). Nothing to review.`,
    );
    return 0;
  }

  console.error(`\nMonth ${args.monthSpec} (${start} to ${end})`);
  console.error(
    `Daily entries: ${entries.length}${monthlyLogBody ? "  Monthly log: yes" : ""}`,
  );
  for (const e of entries) {
    const firstLine =
      e.rawBody.split("\n").find((l) => l.trim().length > 0) ?? "";
    const snippet =
      firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
    console.error(`  ${e.date}  ${snippet}`);
  }
  console.error("");

  const provider = args.dryRun
    ? createDryRunProvider()
    : await resolveProvider();
  let modelResponse: ModelReviewResponse;
  try {
    modelResponse = await callModelForReview(
      provider,
      "a month",
      "next month",
      `Month ${args.monthSpec} (${start} to ${end}). Entries:`,
      entries,
      monthlyLogBody
        ? { label: `Monthly log (${args.monthSpec})`, body: monthlyLogBody }
        : null,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`review month: ${msg}`);
    return 1;
  }

  const themes = enrichThemes(modelResponse.themes);
  const migrations = args.nonInteractive
    ? deferAllMigrations(modelResponse.migrations)
    : await decideMigrationsInteractively(modelResponse.migrations);

  const accepted = migrations.filter((m) => m.user_decision === "accept");
  let migrationResult: MigrationResult | null = null;
  if (accepted.length > 0) {
    try {
      migrationResult = await migrateAcceptedToMonth(
        accepted,
        args.monthSpec,
        entriesDir,
        repoRoot,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`review month: migration failed — ${msg}`);
      return 1;
    }
  }

  const entriesReviewed = entries.map((e) => e.date);
  const generatedAt = nowEasternIso();
  const frontmatter: ReflectionFrontmatter = {
    period: "month",
    start_date: start,
    end_date: end,
    entries_reviewed: entriesReviewed,
    themes_surfaced: themes,
    migrations_proposed: migrations,
  };
  const body = renderMonthReflectionBody(
    args.monthSpec,
    start,
    end,
    themes,
    migrations,
    entriesReviewed,
    generatedAt,
    provider.id,
    monthlyLogBody !== null,
  );
  const content = assembleReflectionFile(body, frontmatter);
  await atomicWrite(reflectionPath, content);

  console.error("");
  console.error(`Wrote reflection -> ${reflectionPath}`);
  console.error(
    `Themes: ${themes.length}   Migrations: ${migrations.length}` +
      `   (${accepted.length} accepted, ` +
      `${migrations.filter((m) => m.user_decision === "defer").length} deferred, ` +
      `${migrations.filter((m) => m.user_decision === "reject").length} rejected)`,
  );
  if (migrationResult && migrationResult.itemsAdded > 0) {
    console.error(
      `Carried ${migrationResult.itemsAdded} item(s) forward -> ${migrationResult.destinationPath}`,
    );
  }
  console.error("");
  if (args.nonInteractive) {
    console.error(`Saved ${reflectionPath}`);
    return 0;
  }
  console.error(
    "Opening the file in your editor so you can add your own reflection notes...",
  );

  const editorCommand = resolveEditor();
  const parts = editorCommand.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    console.error(
      "Editor command resolved to empty string; reflection file written, open manually.",
    );
    return 0;
  }
  const proc = Bun.spawn([...parts, reflectionPath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  console.error(`Saved ${reflectionPath}`);
  return proc.exitCode ?? 0;
}
