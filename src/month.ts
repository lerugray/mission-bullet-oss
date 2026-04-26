// mission-bullet — `bullet month` command + monthly-log helpers.
//
// Monthly log = Carroll's month-scale planning artifact, living at
// `entries/YYYY/MM/monthly.md`. One file per month. Unlike daily
// entries (rapid capture), the monthly log is deliberate planning:
// Calendar, Goals, Bills & recurring.
//
// `bullet month` parallels `bullet today` — opens the file in the
// editor, creates a skeleton with pre-populated section headers and
// example comments if the file doesn't exist yet, and appends an
// Eastern-time session timestamp to the frontmatter each invocation.

import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { atomicWrite } from "./entry-io";
import {
  parseMonthlyLogFile,
  replaceMonthlyLogFrontmatter,
} from "./frontmatter";
import { nowEasternIso, resolveEditor } from "./today";

const MONTH_SPEC = /^(\d{4})-(\d{2})$/;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Current year-month in `YYYY-MM` form. */
export function currentYearMonth(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function monthlyLogPath(
  entriesDir: string,
  yearMonth: string,
): string {
  const m = MONTH_SPEC.exec(yearMonth);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`Invalid year-month: ${yearMonth} (expected YYYY-MM)`);
  }
  return resolve(entriesDir, m[1], m[2], "monthly.md");
}

/** `"2026-12"` → `"2027-01"`, handling the year rollover. */
export function nextMonthAfter(yearMonth: string): string {
  const m = MONTH_SPEC.exec(yearMonth);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`Invalid year-month: ${yearMonth}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

/** First and last calendar day of the given month, as ISODate strings. */
export function monthDateRange(yearMonth: string): {
  start: string;
  end: string;
} {
  const m = MONTH_SPEC.exec(yearMonth);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(`Invalid year-month: ${yearMonth}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  // Day 0 of next month = last day of this month.
  const lastDay = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, "0");
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

function monthTitle(yearMonth: string): string {
  const m = MONTH_SPEC.exec(yearMonth);
  if (!m || m[1] === undefined || m[2] === undefined) return yearMonth;
  const name = MONTH_NAMES[Number(m[2]) - 1] ?? m[2];
  return `${name} ${m[1]}`;
}

/**
 * Skeleton for a new monthly log. Section headers + HTML comments
 * that walk the user through what belongs where. The `-- [ ]` task
 * syntax is called out explicitly under "Goals" so `bullet tasks`
 * can roll up open items later.
 */
export function buildMonthlySkeleton(
  yearMonth: string,
  sessions: string[] = [],
): string {
  const title = monthTitle(yearMonth);
  return (
    `# ${title} — monthly log\n\n` +
    "## Calendar\n\n" +
    "<!-- Appointments, dated events, commitments this month.\n" +
    "     Example:\n" +
    "       - 2026-04-21 (Tue) — dentist 2pm\n" +
    "       - 2026-04-25 (Sat) — sister's birthday -->\n\n" +
    "## Goals for the month\n\n" +
    "<!-- What you want to accomplish this month.\n" +
    "     Use `- [ ]` for tasks and `- [x]` when done — `bullet tasks`\n" +
    "     scans these and shows you everything still open. Example:\n" +
    "       - [ ] finish Q2 strategy draft\n" +
    "       - [ ] reset sleep schedule\n" +
    "       - [x] book weekend trip with family -->\n\n" +
    "## Bills & recurring\n\n" +
    "<!-- Due dates and recurring commitments so you don't lose\n" +
    "     track. Plain list; no special format required. Example:\n" +
    "       - 15th — rent due\n" +
    "       - 20th — credit card statement posts\n" +
    "       - 28th — therapy session (monthly) -->\n\n\n" +
    "<!-- mission-bullet monthly metadata — do not edit by hand -->\n" +
    "---\n" +
    `month: ${yearMonth}\n` +
    "status: open\n" +
    `sessions: ${JSON.stringify(sessions)}\n` +
    "---\n"
  );
}

export async function runMonth(argv: string[]): Promise<number> {
  let yearMonth: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      console.error(`Unknown flag: ${arg}`);
      console.error("Usage: bullet month [YYYY-MM]");
      return 2;
    }
    if (yearMonth !== null) {
      console.error(`Unexpected positional argument: ${arg}`);
      return 2;
    }
    yearMonth = arg;
  }
  const spec = yearMonth ?? currentYearMonth();
  if (!MONTH_SPEC.test(spec)) {
    console.error(`Year-month must be YYYY-MM: got "${spec}"`);
    return 2;
  }

  const repoRoot = process.cwd();
  const entriesDir = resolve(repoRoot, "entries");
  const path = monthlyLogPath(entriesDir, spec);
  const sessionStamp = nowEasternIso();

  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      buildMonthlySkeleton(spec, [sessionStamp]),
      "utf8",
    );
  } else {
    // Append session to existing file via the splice path — body
    // stays byte-for-byte intact.
    const content = await readFile(path, "utf8");
    const { frontmatter } = parseMonthlyLogFile(content);
    const updated = replaceMonthlyLogFrontmatter(content, {
      ...frontmatter,
      sessions: [...frontmatter.sessions, sessionStamp],
    });
    await atomicWrite(path, updated);
  }

  const editorCommand = resolveEditor();
  const parts = editorCommand.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    console.error(
      "No editor resolved; monthly log written, open manually at:",
    );
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
  console.log(`Session logged: ${sessionStamp}`);
  return proc.exitCode ?? 0;
}
