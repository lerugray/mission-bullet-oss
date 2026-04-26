// mission-bullet — `bullet list` + `bullet tasks` commands.
//
// Read-only browsing over the entries directory. `list` gives a
// compact summary of daily entries and monthly logs — date, task
// completion counts, session counts, first-line snippet. `tasks`
// scans entry bodies for GitHub-flavored markdown task syntax
// (`- [ ]` / `- [x]`) and rolls them up across files.
//
// Both commands are pure readers — they never write and never call
// the LLM. They also skip `.claude.md` siblings (AI commentary
// captured by `bullet claude-note`, not a source of tasks).

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join, relative, resolve } from "path";
import {
  parseMonthlyLogFile,
  parseRawEntryFile,
} from "./frontmatter";
import { isoWeekDateRange, isoWeekOf } from "./isoweek";

// GFM task list syntax, plus a no-space `[]` shorthand for open
// tasks. `[ ]` / `[]` = open, `[x]`/`[X]` = done.
const TASK_REGEX = /^(\s*)- \[([ xX]?)\] (.+)$/gm;

interface WalkedEntry {
  path: string;
  kind: "daily" | "monthly";
  /** `YYYY-MM-DD` for daily, `YYYY-MM` for monthly. */
  date: string;
  body: string;
  sessionsCount: number;
  openTasks: number;
  doneTasks: number;
  snippet: string;
}

interface ExtractedTask {
  path: string;
  date: string;
  text: string;
  done: boolean;
}

function firstNonEmptyLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Skip HTML-comment hint lines from skeletons.
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith("<!--") &&
      !trimmed.startsWith("-->")
    ) {
      return trimmed;
    }
  }
  return "(empty)";
}

export function countTasks(body: string): { open: number; done: number } {
  let open = 0;
  let done = 0;
  for (const m of body.matchAll(TASK_REGEX)) {
    if (m[2] === "x" || m[2] === "X") done++;
    else open++;
  }
  return { open, done };
}

async function walkEntries(entriesDir: string): Promise<WalkedEntry[]> {
  if (!existsSync(entriesDir)) return [];
  const results: WalkedEntry[] = [];
  const years = await readdir(entriesDir);
  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearPath = join(entriesDir, year);
    const months = await readdir(yearPath);
    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthPath = join(yearPath, month);
      const files = await readdir(monthPath);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        // `DD.claude.md` — AI commentary sibling produced by
        // `bullet claude-note`. Not a source of tasks or entries.
        if (file.endsWith(".claude.md")) continue;
        // Legacy `.refined.md` files (from before refine was removed)
        // are kept on disk but no longer surfaced.
        if (file.endsWith(".refined.md")) continue;
        const path = join(monthPath, file);
        const content = await readFile(path, "utf8");

        if (file === "monthly.md") {
          try {
            const { body, frontmatter } = parseMonthlyLogFile(content);
            const tasks = countTasks(body);
            results.push({
              path,
              kind: "monthly",
              date: frontmatter.month,
              body,
              sessionsCount: frontmatter.sessions.length,
              openTasks: tasks.open,
              doneTasks: tasks.done,
              snippet: firstNonEmptyLine(body),
            });
          } catch {
            // Not a valid monthly log — skip.
          }
        } else if (/^\d{2}\.md$/.test(file)) {
          try {
            const { body, frontmatter } = parseRawEntryFile(content);
            const tasks = countTasks(body);
            results.push({
              path,
              kind: "daily",
              date: frontmatter.date,
              body,
              sessionsCount: frontmatter.sessions.length,
              openTasks: tasks.open,
              doneTasks: tasks.done,
              snippet: firstNonEmptyLine(body),
            });
          } catch {
            // Not a valid daily entry — skip.
          }
        }
      }
    }
  }
  return results;
}

function truncateSnippet(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function formatTaskCell(open: number, done: number): string {
  const total = open + done;
  if (total === 0) return "  .  ";
  return `${done}/${total}`.padStart(5);
}

// --- bullet list ---

interface ListArgs {
  mode: "all" | "week" | "month" | "since";
  sinceDate: string | null;
}

function parseListArgs(argv: string[]): ListArgs {
  let mode: ListArgs["mode"] = "all";
  let sinceDate: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--week") mode = "week";
    else if (arg === "--month") mode = "month";
    else if (arg === "--since") {
      mode = "since";
      sinceDate = argv[++i] ?? null;
      if (!sinceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
        throw new Error("--since requires a YYYY-MM-DD date");
      }
    } else if (arg === "--all") {
      mode = "all";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { mode, sinceDate };
}

function inRange(
  entry: WalkedEntry,
  mode: ListArgs["mode"],
  sinceDate: string | null,
  now: Date,
): boolean {
  if (mode === "all") return true;
  if (entry.kind === "monthly") {
    // Monthly logs show under `--month` if they match this calendar
    // month; otherwise only under `--all`.
    if (mode === "month") {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      return entry.date === `${y}-${m}`;
    }
    return false;
  }
  // Daily entry — `entry.date` is YYYY-MM-DD.
  if (mode === "week") {
    const { year, week } = isoWeekOf(now);
    const { start, end } = isoWeekDateRange(year, week);
    return entry.date >= start && entry.date <= end;
  }
  if (mode === "month") {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    return entry.date.startsWith(`${y}-${m}`);
  }
  if (mode === "since" && sinceDate) {
    return entry.date >= sinceDate;
  }
  return true;
}

export async function runList(argv: string[]): Promise<number> {
  let args: ListArgs;
  try {
    args = parseListArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`list: ${msg}`);
    console.error(
      "Usage: bullet list [--week | --month | --since YYYY-MM-DD | --all]",
    );
    return 2;
  }

  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const all = await walkEntries(entriesDir);
  if (all.length === 0) {
    console.log("No entries yet — run `bullet today` to capture your first.");
    return 0;
  }

  const now = new Date();
  const filtered = all.filter((e) => inRange(e, args.mode, args.sinceDate, now));
  if (filtered.length === 0) {
    console.log(`No entries in range (${args.mode}).`);
    return 0;
  }

  // Sort: daily newest-first, monthly at the end (ordered by date).
  const daily = filtered
    .filter((e) => e.kind === "daily")
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const monthly = filtered
    .filter((e) => e.kind === "monthly")
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const header = `Range: ${args.mode}${args.sinceDate ? ` (since ${args.sinceDate})` : ""}`;
  console.log(header);
  console.log("");

  if (daily.length > 0) {
    console.log(`Daily entries (${daily.length}):`);
    console.log(
      `  ${"DATE".padEnd(11)} ${"TASKS".padEnd(5)}  ${"SESS".padEnd(4)}  FIRST LINE`,
    );
    for (const e of daily) {
      const tasks = formatTaskCell(e.openTasks, e.doneTasks);
      const sess = String(e.sessionsCount).padStart(4);
      const snip = truncateSnippet(e.snippet, 60);
      console.log(`  ${e.date.padEnd(11)} ${tasks}  ${sess}  ${snip}`);
    }
    console.log("");
  }

  if (monthly.length > 0) {
    console.log(`Monthly logs (${monthly.length}):`);
    console.log(
      `  ${"MONTH".padEnd(11)} ${"TASKS".padEnd(5)}  ${"SESS".padEnd(4)}  FIRST LINE`,
    );
    for (const e of monthly) {
      const tasks = formatTaskCell(e.openTasks, e.doneTasks);
      const sess = String(e.sessionsCount).padStart(4);
      const snip = truncateSnippet(e.snippet, 60);
      console.log(`  ${e.date.padEnd(11)} ${tasks}  ${sess}  ${snip}`);
    }
    console.log("");
  }

  return 0;
}

// --- bullet tasks ---

type TasksFilter = "open" | "done" | "all";

export async function runTasks(argv: string[]): Promise<number> {
  let filter: TasksFilter = "open";
  for (const arg of argv) {
    if (arg === "--open") filter = "open";
    else if (arg === "--done") filter = "done";
    else if (arg === "--all") filter = "all";
    else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Usage: bullet tasks [--open | --done | --all]");
      return 2;
    }
  }

  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const all = await walkEntries(entriesDir);
  const tasks: ExtractedTask[] = [];
  for (const entry of all) {
    for (const m of entry.body.matchAll(TASK_REGEX)) {
      const status = m[2] ?? " ";
      const text = m[3] ?? "";
      tasks.push({
        path: entry.path,
        date: entry.date,
        text,
        done: status === "x" || status === "X",
      });
    }
  }

  const filtered = tasks.filter((t) =>
    filter === "all" ? true : filter === "open" ? !t.done : t.done,
  );

  if (filtered.length === 0) {
    console.log(`No ${filter === "all" ? "" : filter + " "}tasks found.`);
    return 0;
  }

  // Show newest first (entries are dated lexically).
  filtered.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  console.log(
    `${filter === "all" ? "All" : filter === "open" ? "Open" : "Done"} tasks (${filtered.length}):`,
  );
  for (const t of filtered) {
    const box = t.done ? "[x]" : "[ ]";
    const rel = relative(repoRoot, t.path).replaceAll("\\", "/");
    const text = truncateSnippet(t.text, 70);
    console.log(`  ${box} ${text}   (${rel})`);
  }

  return 0;
}
