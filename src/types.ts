// mission-bullet — shared type definitions (mb-001)
//
// Foundational types for every subsequent module. Lock the contracts
// here before any IO / provider / CLI code lands, the same way
// GeneralStaff's src/types.ts does.
//
// ## Design decision that matters
//
// Markdown-on-disk, not SQLite. Entries have to stay grep-able,
// editor-native, diffable via git, and readable by eyeball without a
// query layer. The whole point of bullet journaling is "the paper is
// the tool"; a schema-driven DB would turn this into an app. Cost: we
// can't do fancy cross-entry queries without re-reading files. That's
// acceptable — a monthly review reads ~30 files, a weekly one ~7.
// When cross-entry aggregation is needed (themes, migrations), it
// happens at read time in memory.
//
// ## Conventions (match ../generalstaff/src/types.ts)
//
// - `export interface` for object shapes; `export type X = union` for enums.
// - ISO strings for dates/timestamps, never Date objects.
// - `VALID_*: readonly X[]` constants paired with `isX(v: unknown): v is X`
//   type guards for parse boundaries (YAML frontmatter off disk).
// - Hand-rolled guards only — no schema library.
// - No barrel re-exports; consumers `import type { ... } from "./types"`.

// --- Primitive aliases ---

/** ISO date, YYYY-MM-DD (e.g. "2026-04-21"). */
export type ISODate = string;

/** ISO 8601 timestamp with timezone (e.g. "2026-04-21T14:30:00.000Z"). */
export type ISOTimestamp = string;

// --- Enums ---

/**
 * Entry lifecycle.
 * - `open`: still accepting writes (the day is live, or the week
 *   hasn't been reviewed yet).
 * - `closed`: weekly review has run through this entry; further
 *   writes are discouraged. No hard enforcement at the file level —
 *   this is a convention the CLI honors.
 */
export type EntryStatus = "open" | "closed";

export const VALID_ENTRY_STATUSES: readonly EntryStatus[] = ["open", "closed"];

export type ReflectionPeriod = "week" | "month";

export const VALID_REFLECTION_PERIODS: readonly ReflectionPeriod[] = [
  "week",
  "month",
];

/**
 * Migration candidate decision state.
 * - `pending`: surfaced by the AI, no user decision yet. Explicit
 *   (vs. absent) so partially-reviewed reflections round-trip cleanly
 *   through YAML without the loader inferring state from missing fields.
 * - `accept` / `reject` / `defer`: the user's decision during review.
 *   `defer` = "surface this again next review."
 */
export type MigrationDecision = "pending" | "accept" | "reject" | "defer";

export const VALID_MIGRATION_DECISIONS: readonly MigrationDecision[] = [
  "pending",
  "accept",
  "reject",
  "defer",
];

// --- Entry (raw) ---

/**
 * YAML frontmatter at the top of every entries/YYYY/MM/DD.md file.
 * `date` is the entry's identity — exactly one entry per day, so the
 * date and the path are in 1:1 correspondence and no synthetic id is
 * needed.
 */
export interface EntryFrontmatter {
  date: ISODate;
  status: EntryStatus;
  /**
   * mb-007: when items from this entry are migrated forward during a
   * review, the destination entry paths are appended here so the
   * source history isn't lost.
   */
  migrated_to: string[];
  /**
   * One ISO-8601 timestamp per `bullet today` invocation, formatted
   * in the Eastern timezone (America/New_York, so the offset is
   * `-04:00` in EDT and `-05:00` in EST). Appended on every open; a
   * day with three writing sessions has three entries. Provides a
   * lightweight "when did I sit down to journal" log without
   * touching the raw body.
   */
  sessions: string[];
}

/**
 * A fully-loaded entry. `rawMarkdown` is the verbatim body — the
 * single most load-bearing invariant in this tool is that this string
 * is never modified after its first write.
 */
export interface Entry {
  frontmatter: EntryFrontmatter;
  rawMarkdown: string;
  path: string;
}

// --- Monthly log (entries/YYYY/MM/monthly.md) ---

/**
 * Monthly log frontmatter. The monthly log is Carroll's month-scale
 * planning artifact — Calendar, Goals, Bills/recurring. One file per
 * month, separate from daily entries. Schema is intentionally
 * minimal.
 */
export interface MonthlyLogFrontmatter {
  /** `YYYY-MM`. */
  month: string;
  status: EntryStatus;
  /**
   * Eastern-timezone ISO timestamps, appended on every
   * `bullet month` invocation — same session-logging discipline as
   * daily entries.
   */
  sessions: string[];
}

export function isMonthlyLogFrontmatter(
  v: unknown,
): v is MonthlyLogFrontmatter {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.month === "string" &&
    typeof o.status === "string" &&
    VALID_ENTRY_STATUSES.includes(o.status as EntryStatus) &&
    isStringArray(o.sessions)
  );
}

// --- Theme ---

/**
 * An emergent theme surfaced during reflection. Themes live embedded
 * in the reflection that surfaced them (see `ReflectionFrontmatter`);
 * there is no global theme index file. Cross-period aggregation
 * (mb-006's "cross-week theme persistence") happens at read time.
 */
export interface Theme {
  /** Short noun-phrase, e.g. "healthcare frustrations". */
  label: string;
  entries_mentioning: ISODate[];
  first_seen: ISODate;
  last_seen: ISODate;
  /** Optional AI-written observation about the theme; null when absent. */
  notes: string | null;
}

// --- Migration candidate ---

/**
 * An item the AI proposes for migration during a review. Presented
 * with a y/n/defer prompt; `user_decision` captures the outcome.
 * `migrated_to` on the candidate mirrors the `migrated_to[]` array on
 * the source entry — redundant on purpose so reflection files and
 * entry files can each answer "what happened?" without cross-referencing.
 */
export interface MigrationCandidate {
  source_entry_date: ISODate;
  /** Short verbatim excerpt from the source entry, for display. */
  source_text_fragment: string;
  /** AI-authored: why this looks migratable. */
  reason_for_surfacing: string;
  user_decision: MigrationDecision;
  /** Set when decision="accept" and migration was executed; else null. */
  migrated_to: string | null;
}

// --- Reflection ---

export interface ReflectionFrontmatter {
  period: ReflectionPeriod;
  start_date: ISODate;
  end_date: ISODate;
  /** Dates of the entries this reflection covered. */
  entries_reviewed: ISODate[];
  /** Embedded — no separate themes.json. */
  themes_surfaced: Theme[];
  migrations_proposed: MigrationCandidate[];
}

/**
 * A weekly (reflections/YYYY-WNN.md) or monthly (reflections/YYYY-MM.md)
 * reflection file. `notesMarkdown` is the user's reflection prose —
 * free-form body, not parsed.
 */
export interface Reflection {
  frontmatter: ReflectionFrontmatter;
  notesMarkdown: string;
  path: string;
}

// --- Session context ---

/**
 * In-memory state a CLI command carries from argument parsing through
 * to IO and LLM calls. Resolved once at command start so a long-
 * running review that straddles midnight doesn't see two "todays",
 * and so mid-run cwd changes don't confuse path resolution.
 *
 * Speculative shape; revisit when mb-003 lands and the daily-capture
 * flow forces the real requirements out.
 */
export interface SessionContext {
  today: ISODate;
  /** Absolute path to entries/. */
  entriesDir: string;
  /** Absolute path to reflections/. */
  reflectionsDir: string;
  /**
   * Resolved from MISSION_BULLET_EDITOR / $EDITOR / platform fallback
   * by mb-003. Null before mb-003 wires it in.
   */
  editorCommand: string | null;
  /**
   * Provider id from mb-002's registry. Null before mb-002 wires it
   * in, and for commands that make no LLM calls (e.g. `bullet today`).
   */
  providerId: string | null;
}

// --- Type guards (parse boundaries) ---

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function isEntryFrontmatter(v: unknown): v is EntryFrontmatter {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.date === "string" &&
    typeof o.status === "string" &&
    VALID_ENTRY_STATUSES.includes(o.status as EntryStatus) &&
    isStringArray(o.migrated_to) &&
    isStringArray(o.sessions)
  );
}

export function isTheme(v: unknown): v is Theme {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.label === "string" &&
    isStringArray(o.entries_mentioning) &&
    typeof o.first_seen === "string" &&
    typeof o.last_seen === "string" &&
    (o.notes === null || typeof o.notes === "string")
  );
}

export function isMigrationCandidate(v: unknown): v is MigrationCandidate {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.source_entry_date === "string" &&
    typeof o.source_text_fragment === "string" &&
    typeof o.reason_for_surfacing === "string" &&
    typeof o.user_decision === "string" &&
    VALID_MIGRATION_DECISIONS.includes(o.user_decision as MigrationDecision) &&
    (o.migrated_to === null || typeof o.migrated_to === "string")
  );
}

export function isReflectionFrontmatter(
  v: unknown,
): v is ReflectionFrontmatter {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.period !== "string" ||
    !VALID_REFLECTION_PERIODS.includes(o.period as ReflectionPeriod) ||
    typeof o.start_date !== "string" ||
    typeof o.end_date !== "string" ||
    !isStringArray(o.entries_reviewed)
  ) {
    return false;
  }
  if (!Array.isArray(o.themes_surfaced)) return false;
  for (const t of o.themes_surfaced) {
    if (!isTheme(t)) return false;
  }
  if (!Array.isArray(o.migrations_proposed)) return false;
  for (const m of o.migrations_proposed) {
    if (!isMigrationCandidate(m)) return false;
  }
  return true;
}
