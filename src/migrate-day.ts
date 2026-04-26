// mission-bullet — `bullet migrate` command (mb-010).
//
// Daily bullet-journal migration: for each open `- [ ]` task on a
// prior entry (yesterday by default), prompt the user to accept (carry
// forward to today), strike (mark as abandoned), reject (leave open),
// or quit. Pure local logic — no LLM call, no network — same shape as
// the migration step in weekly review but at day-grain.
//
// ## Source resolution
//
// - `--from YYYY-MM-DD` overrides explicitly.
// - Otherwise, walk backwards from the destination day until we hit a
//   raw entry that has at least one open task (cap: 14 days back). The
//   typical case is yesterday; the lookback handles weekends, vacations,
//   or any gap when the user didn't journal.
//
// ## Destination resolution
//
// - `--to YYYY-MM-DD` overrides explicitly.
// - Otherwise, today (per `resolveToday`).
//
// ## Side effects on disk per decision
//
//   accept → bullet appended to dest's `## Migrated items` section,
//            source `- [ ] X` rewritten to `- [x] X (migrated to <dest>)`,
//            source `migrated_to` frontmatter appended.
//   strike → source `- [ ] X` rewritten to `- [x] ~~X~~`. No dest, no
//            frontmatter mutation.
//   reject → no-op. Source line stays open; reappears next migration.
//   quit   → applies decisions made before quit; remaining items are
//            left as-is. Matches weekly review's quit semantics so the
//            muscle memory transfers.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "path";
import { rawEntryPath } from "./entry-io";
import { parseRawEntryFile } from "./frontmatter";
import {
  migrateAcceptedToDay,
  strikeSourceTasks,
  type DayMigrationResult,
  type StrikeRequest,
  type StrikeResult,
} from "./migrate";
import { resolveToday } from "./today";
import type { ISODate, MigrationCandidate } from "./types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Matches GFM `- [ ]` and the user's `- []` shorthand. Group 2 is the
// verbatim task text. Anchored per-line via `gm`; `\r?$` tolerates
// CRLF line endings so files saved by Notepad on Windows parse
// correctly. The `m` flag makes `$` match before `\n`; the `\r?`
// consumes any carriage return that would otherwise leave the regex
// stranded between `\r` and `\n`. (`.` doesn't match `\r`, which is
// the trap the per-line split was falling into before.)
//
// The non-capturing `(?:\s+<!-- bullet-migrate auto-mark -->)?` peels
// off the trailing tool-attribution marker so already-migrated bullets
// surface as clean text in the interactive `bullet migrate` prompt
// instead of `foo (from X) <!-- bullet-migrate auto-mark -->`.
const OPEN_TASK_LINE_RE =
  /^(\s*)- \[ ?\] (.+?)(?:\s+<!-- bullet-migrate auto-mark -->)?\r?$/gm;
const DEFAULT_LOOKBACK_DAYS = 14;

interface MigrateArgs {
  fromDate: ISODate | null;
  toDate: ISODate | null;
}

function parseArgs(argv: string[]): MigrateArgs {
  let fromDate: ISODate | null = null;
  let toDate: ISODate | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from") {
      const v = argv[++i];
      if (!v || !ISO_DATE_RE.test(v)) {
        throw new Error("--from requires a YYYY-MM-DD date");
      }
      fromDate = v;
    } else if (arg === "--to") {
      const v = argv[++i];
      if (!v || !ISO_DATE_RE.test(v)) {
        throw new Error("--to requires a YYYY-MM-DD date");
      }
      toDate = v;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { fromDate, toDate };
}

/**
 * Calendar-arithmetic step backward by one day. UTC is intentional —
 * the input is a YYYY-MM-DD string with no timezone, and stepping in
 * UTC avoids DST jitter that would otherwise occasionally skip or
 * repeat a day around spring/fall transitions.
 */
export function previousDayIso(date: ISODate): ISODate {
  const parts = date.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    Number.isNaN(y) ||
    Number.isNaN(m) ||
    Number.isNaN(d)
  ) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return (
    `${dt.getUTCFullYear()}-` +
    `${String(dt.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(dt.getUTCDate()).padStart(2, "0")}`
  );
}

export interface OpenTasksOnDate {
  date: ISODate;
  tasks: string[];
}

export function extractOpenTasks(body: string): string[] {
  const tasks: string[] = [];
  // matchAll on the whole body (not per-line split) so the regex's
  // `gm` + `\r?$` handles CRLF. Reset lastIndex implicitly via
  // matchAll's internal copy — safe to call repeatedly.
  for (const m of body.matchAll(OPEN_TASK_LINE_RE)) {
    if (m[2] !== undefined) tasks.push(m[2]);
  }
  return tasks;
}

async function loadOpenTasks(
  entriesDir: string,
  date: ISODate,
): Promise<string[]> {
  const path = rawEntryPath(entriesDir, date);
  if (!existsSync(path)) return [];
  const content = await readFile(path, "utf8");
  let body: string;
  try {
    ({ body } = parseRawEntryFile(content));
  } catch {
    return [];
  }
  return extractOpenTasks(body);
}

export async function findRecentSource(
  entriesDir: string,
  beforeDate: ISODate,
  maxDaysBack: number = DEFAULT_LOOKBACK_DAYS,
): Promise<OpenTasksOnDate | null> {
  let cursor = beforeDate;
  for (let i = 0; i < maxDaysBack; i++) {
    cursor = previousDayIso(cursor);
    const tasks = await loadOpenTasks(entriesDir, cursor);
    if (tasks.length > 0) return { date: cursor, tasks };
  }
  return null;
}

type Decision = "accept" | "reject" | "strike";

interface DecidedTask {
  taskText: string;
  decision: Decision;
}

/**
 * Interactive per-task prompt. Behind a small function boundary so a
 * future GUI can swap the terminal UX out without touching the engine
 * — same convention as `decideMigrationsInteractively` in review.ts.
 *
 * Returns decisions made up to the point of [q]uit (or all of them).
 * Items skipped via quit are simply absent from the result; the
 * caller computes "skipped count" by comparing lengths.
 */
async function decideTasksInteractively(
  source: OpenTasksOnDate,
  destDate: ISODate,
): Promise<DecidedTask[]> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const decided: DecidedTask[] = [];
  try {
    console.error("");
    console.error(
      `Open tasks from ${source.date} -> migrate forward to ${destDate}:`,
    );
    for (let i = 0; i < source.tasks.length; i++) {
      const task = source.tasks[i];
      if (task === undefined) continue;
      console.error("");
      console.error(`Task ${i + 1}/${source.tasks.length}:`);
      console.error(`  - [ ] ${task}`);
      let decision: Decision | null = null;
      while (decision === null) {
        const answer = (
          await rl.question(
            "  [y]accept / [n]reject / [s]trike / [q]uit: ",
          )
        )
          .trim()
          .toLowerCase();
        if (answer === "y" || answer === "yes") decision = "accept";
        else if (answer === "n" || answer === "no") decision = "reject";
        else if (answer === "s" || answer === "strike") decision = "strike";
        else if (answer === "q" || answer === "quit") {
          return decided;
        } else {
          console.error("  (type y, n, s, or q)");
        }
      }
      decided.push({ taskText: task, decision });
    }
    return decided;
  } finally {
    rl.close();
  }
}

export async function runMigrate(argv: string[]): Promise<number> {
  let args: MigrateArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`migrate: ${msg}`);
    console.error(
      "Usage: bullet migrate [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
    );
    return 2;
  }

  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const destDate = args.toDate ?? resolveToday();

  // Resolve source — explicit override or walk-back default.
  let source: OpenTasksOnDate | null;
  if (args.fromDate) {
    if (args.fromDate === destDate) {
      console.error(
        `migrate: --from and --to are the same date (${destDate}); nothing to migrate.`,
      );
      return 2;
    }
    const path = rawEntryPath(entriesDir, args.fromDate);
    if (!existsSync(path)) {
      console.error(
        `migrate: no entry file at ${path}. (Pass a date that has a daily entry.)`,
      );
      return 1;
    }
    source = { date: args.fromDate, tasks: await loadOpenTasks(entriesDir, args.fromDate) };
  } else {
    source = await findRecentSource(entriesDir, destDate);
  }

  if (source === null) {
    console.error(
      `migrate: no entry with open tasks found in the ${DEFAULT_LOOKBACK_DAYS} days before ${destDate}.`,
    );
    console.error(
      `         Pass --from YYYY-MM-DD to point at a specific older entry.`,
    );
    return 0;
  }

  if (source.tasks.length === 0) {
    console.error(
      `migrate: ${source.date} has no open tasks. Nothing to migrate.`,
    );
    return 0;
  }

  const sourceFinal = source;
  const decisions = await decideTasksInteractively(sourceFinal, destDate);
  const accepts = decisions.filter((d) => d.decision === "accept");
  const strikes = decisions.filter((d) => d.decision === "strike");
  const rejects = decisions.filter((d) => d.decision === "reject");
  const skipped = sourceFinal.tasks.length - decisions.length;

  let migrateResult: DayMigrationResult | null = null;
  if (accepts.length > 0) {
    const candidates: MigrationCandidate[] = accepts.map((d) => ({
      source_entry_date: sourceFinal.date,
      source_text_fragment: d.taskText,
      reason_for_surfacing: "user-selected via bullet migrate",
      user_decision: "accept",
      migrated_to: null,
    }));
    try {
      migrateResult = await migrateAcceptedToDay(
        candidates,
        destDate,
        entriesDir,
        repoRoot,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`migrate: failed during accept step — ${msg}`);
      return 1;
    }
  }

  let strikeResult: StrikeResult | null = null;
  if (strikes.length > 0) {
    const requests: StrikeRequest[] = strikes.map((d) => ({
      sourceDate: sourceFinal.date,
      taskText: d.taskText,
    }));
    try {
      strikeResult = await strikeSourceTasks(requests, entriesDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`migrate: failed during strike step — ${msg}`);
      return 1;
    }
  }

  console.error("");
  console.error(
    `Decisions: ${accepts.length} accept, ${rejects.length} reject, ${strikes.length} strike` +
      (skipped > 0 ? `, ${skipped} skipped (quit)` : ""),
  );
  if (migrateResult && migrateResult.itemsAdded > 0) {
    console.error(
      `Carried ${migrateResult.itemsAdded} item(s) forward -> ${migrateResult.destinationPath}`,
    );
    if (migrateResult.itemsAlreadyPresent > 0) {
      console.error(
        `  (${migrateResult.itemsAlreadyPresent} already present from a prior migration, skipped)`,
      );
    }
    if (migrateResult.sourceLinesNotFound > 0) {
      console.error(
        `  (warning: ${migrateResult.sourceLinesNotFound} source line(s) couldn't be located for marking — likely already changed)`,
      );
    }
  } else if (migrateResult && migrateResult.itemsAlreadyPresent > 0) {
    console.error(
      `All ${migrateResult.itemsAlreadyPresent} accepted item(s) were already at ${migrateResult.destinationPath} from a prior run.`,
    );
  }
  if (strikeResult && strikeResult.itemsStruck > 0) {
    console.error(
      `Struck ${strikeResult.itemsStruck} item(s) on ${sourceFinal.date}.`,
    );
  }

  return 0;
}
