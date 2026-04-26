// mission-bullet — `bullet today` command (mb-003)
//
// Core daily-capture flow: resolve today's entry path, create a
// minimal skeleton if the file doesn't exist yet, hand off to the
// user's editor, and print the path on exit. Nothing else — no
// auto-processing, no LLM calls, no prompts inside the file.
//
// Editor resolution precedence: MISSION_BULLET_EDITOR env var →
// $EDITOR env var → platform fallback (notepad on win32, nano
// elsewhere). See README.md §Usage and .env.example for context.
//
// "Today" is resolved once when the command is invoked — a session
// that straddles midnight writes to the day the user typed the
// command, not the day they eventually saved.

import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { readEntry, updateRawFrontmatter } from "./entry-io";
import type { EntryFrontmatter, ISODate, SessionContext } from "./types";

/** Format a Date (defaulting to now) as an ISO date, e.g. "2026-04-21". */
export function resolveToday(now: Date = new Date()): ISODate {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Current wall-clock time in the Eastern timezone (America/New_York),
 * formatted as ISO-8601 with the live offset — so the suffix is
 * `-05:00` in EST and `-04:00` in EDT, auto-handling DST.
 *
 * We avoid a timezone library by using Intl.DateTimeFormat to pull the
 * eastern wall-clock components and then inferring the offset from
 * `Date.UTC(...eastern parts) - now`. This stays zero-dep and reuses
 * the ICU tzdata that Bun ships with.
 */
export function nowEasternIso(now: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  // Intl's 24h mode returns "24" for midnight in some engines — normalize.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  // asIfUtc > now  <=>  wall clock is ahead of UTC  <=>  positive offset.
  const offsetMinutes = Math.round((asIfUtc - now.getTime()) / 60000);
  const signChar = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${signChar}${offH}:${offM}`;
}

/** Build the entries/YYYY/MM/DD.md path for the given context. */
export function todayEntryPath(ctx: SessionContext): string {
  const parts = ctx.today.split("-");
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) {
    throw new Error(`Invalid ISO date in SessionContext.today: ${ctx.today}`);
  }
  return join(ctx.entriesDir, year, month, `${day}.md`);
}

/**
 * Pick the editor command: MISSION_BULLET_EDITOR wins, then $EDITOR,
 * then a platform fallback. Returned as a single string — caller
 * splits on whitespace to separate the executable from any flags
 * (e.g. "code --wait" → ["code", "--wait"]).
 */
export function resolveEditor(
  env: Record<string, string | undefined> = process.env,
): string {
  const mbEditor = env.MISSION_BULLET_EDITOR?.trim();
  if (mbEditor) return mbEditor;
  const envEditor = env.EDITOR?.trim();
  if (envEditor) return envEditor;
  return process.platform === "win32" ? "notepad" : "nano";
}

/**
 * Empty body on top, metadata block at the bottom behind an HTML
 * comment guard. This is deliberately NOT the standard "YAML
 * frontmatter at the top" layout because plain editors like Notepad
 * open a file with the cursor at line 1 — if the frontmatter lived
 * there, user-typed text would land above it and corrupt the
 * structure. Flipping the metadata to the bottom lets the user open
 * the file and start typing immediately without scrolling past
 * boilerplate. The comment guard doubles as a visual "do not edit"
 * signal and as a parser anchor when reading the file back.
 *
 * Type guard `isEntryFrontmatter` in src/types.ts accepts this
 * shape; the parser (lands with a later IO task) will look for the
 * HTML comment line and treat the YAML block below it as the
 * frontmatter.
 */
export function buildSkeleton(
  date: ISODate,
  sessions: string[] = [],
): string {
  // `sessions` is an array so mb-007's migration path can create a
  // destination entry with no session yet (the user hasn't opened it
  // — migration is automated, not a journaling session). `bullet
  // today` passes `[sessionStamp]` so the day's first invocation
  // still records itself.
  const fm: EntryFrontmatter = {
    date,
    status: "open",
    migrated_to: [],
    sessions,
  };
  return (
    "\n\n" +
    "<!-- mission-bullet metadata — do not edit by hand -->\n" +
    "---\n" +
    `date: ${fm.date}\n` +
    `status: ${fm.status}\n` +
    `migrated_to: []\n` +
    `sessions: ${JSON.stringify(fm.sessions)}\n` +
    "---\n"
  );
}

/**
 * Spawn the editor with stdio inherited so terminal editors (vim,
 * nano) work, and wait for it to exit. GUI editors like VS Code
 * need their own "wait" flag on the command line
 * (MISSION_BULLET_EDITOR="code --wait") — without it they fork and
 * return immediately.
 */
async function openInEditor(
  editorCommand: string,
  filePath: string,
): Promise<number> {
  const parts = editorCommand.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Editor command resolved to empty string");
  }
  const proc = Bun.spawn([...parts, filePath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return proc.exitCode ?? 0;
}

/**
 * Build the SessionContext for this command invocation. Paths are
 * resolved absolutely against cwd so subsequent code doesn't depend
 * on the shell staying in the same directory. `providerId` stays
 * null — `bullet today` makes no LLM calls.
 */
function buildContext(): SessionContext {
  const today = resolveToday();
  return {
    today,
    entriesDir: resolve(process.cwd(), "entries"),
    reflectionsDir: resolve(process.cwd(), "reflections"),
    editorCommand: resolveEditor(),
    providerId: null,
  };
}

/**
 * Run the `bullet today` command. Returns the editor's exit code so
 * the caller can propagate it to `process.exit` — a user who saves
 * and quits cleanly sees exit 0.
 */
export async function runToday(): Promise<number> {
  const ctx = buildContext();
  const path = todayEntryPath(ctx);
  const sessionStamp = nowEasternIso();

  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buildSkeleton(ctx.today, [sessionStamp]), "utf8");
  } else {
    // Existing entry: append this open to the session log. Uses the
    // frontmatter splice path, so body bytes stay byte-for-byte intact.
    // Pre-existing entries that predate the `sessions` field parse
    // with a synthesized empty array — no migration needed.
    const entry = await readEntry(path);
    await updateRawFrontmatter(path, {
      ...entry.frontmatter,
      sessions: [...entry.frontmatter.sessions, sessionStamp],
    });
  }

  if (ctx.editorCommand === null) {
    throw new Error("No editor resolved; set MISSION_BULLET_EDITOR or EDITOR");
  }
  const exitCode = await openInEditor(ctx.editorCommand, path);

  console.log(`Saved to ${path}`);
  console.log(`Session logged: ${sessionStamp}`);
  return exitCode;
}
