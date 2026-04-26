// mission-bullet — migration-forward engine (mb-007).
//
// Carries accepted migration candidates from a weekly review into
// next week's daily entries. Runs at the tail of `review week`,
// after the user's interactive decisions and before the reflection
// file lands.
//
// ## What it does
//
// For each accepted MigrationCandidate:
//
//   1. Appends a bullet to next Monday's entry body, inside a
//      clearly-labeled "## Migrated items" section with an HTML
//      provenance banner. Creates the destination entry with an
//      empty-sessions skeleton if it doesn't exist yet.
//   2. Appends the destination path to the SOURCE entry's
//      `migrated_to` frontmatter array, so the source history
//      isn't lost (Carroll's rule — always leave a trail of where
//      things went).
//   3. Records the destination path on the MigrationCandidate's
//      `migrated_to` field so the reflection file carries the
//      same breadcrumb.
//
// ## Raw-is-sacred boundaries
//
// - Source entry body: never touched. Only its frontmatter is
//   updated, via the same splice path mb-004 uses.
// - Destination entry body: append-only, inside an auto-generated
//   section behind a visible provenance banner. See
//   `addMigrationBullets` in ./frontmatter.ts for the discipline
//   this inherits.
//
// ## Idempotency
//
// Re-running a review with `--force` doesn't duplicate anything:
//   - `addMigrationBullets` skips bullets already present by exact
//     text match.
//   - Source `migrated_to` is append-unique.

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import {
  atomicWrite,
  rawEntryPath,
  readEntry,
  toStoragePath,
  updateRawFrontmatter,
} from "./entry-io";
import {
  addMigrationBullets,
  appendMonthlyGoals,
  rewriteRawBody,
} from "./frontmatter";
import { nextMondayAfter } from "./isoweek";
import {
  buildMonthlySkeleton,
  monthlyLogPath,
  nextMonthAfter,
} from "./month";
import { buildSkeleton } from "./today";
import type { ISODate, MigrationCandidate } from "./types";

export interface MigrationResult {
  /** Empty string when there was nothing to migrate. */
  destinationPath: string;
  destinationDate: ISODate;
  itemsAdded: number;
  itemsAlreadyPresent: number;
  /** Source-entry dates whose `migrated_to` frontmatter was updated. */
  sourcesUpdated: ISODate[];
}

function formatBullet(m: MigrationCandidate, sourceWeek: string): string {
  return `- "${m.source_text_fragment}" (from week ${sourceWeek}, ${m.source_entry_date})`;
}

/**
 * Execute all accepted migrations from a weekly review.
 *
 * Mutates each input MigrationCandidate's `migrated_to` field to
 * the destination storage path (forward-slash, relative to repo
 * root) — callers use these values when writing the reflection
 * file's frontmatter, so the reflection + source entries + destination
 * entry all carry the same breadcrumb.
 */
export async function migrateAccepted(
  accepted: MigrationCandidate[],
  sourceWeekSpec: string,
  entriesDir: string,
  repoRoot: string,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    destinationPath: "",
    destinationDate: "",
    itemsAdded: 0,
    itemsAlreadyPresent: 0,
    sourcesUpdated: [],
  };
  if (accepted.length === 0) return result;

  const destDate = nextMondayAfter(sourceWeekSpec);
  const destPath = rawEntryPath(entriesDir, destDate);
  result.destinationPath = destPath;
  result.destinationDate = destDate;

  // 1. Ensure destination entry exists. Pass an empty sessions list
  //    — migration is automated, not a journaling session; the first
  //    time the user runs `bullet today` on this date the session log
  //    catches up naturally.
  if (!existsSync(destPath)) {
    await atomicWrite(destPath, buildSkeleton(destDate, []));
  }

  // 2. Compute bullets, count which were already present, then
  //    append the fresh ones.
  const bullets = accepted.map((m) => formatBullet(m, sourceWeekSpec));
  const original = await readFile(destPath, "utf8");
  for (const b of bullets) {
    if (original.includes(b)) result.itemsAlreadyPresent++;
    else result.itemsAdded++;
  }
  if (result.itemsAdded > 0) {
    const updated = addMigrationBullets(original, bullets);
    await atomicWrite(destPath, updated);
  }

  // 3. Update each source entry's `migrated_to` (once per source
  //    date, even if multiple items from that date migrate). Also
  //    record the destination path on each candidate so the
  //    reflection file's frontmatter carries it.
  const destStorageForm = toStoragePath(destPath, repoRoot);
  const sourceDatesTouched = new Set<ISODate>();
  for (const m of accepted) {
    m.migrated_to = destStorageForm;

    if (sourceDatesTouched.has(m.source_entry_date)) continue;
    sourceDatesTouched.add(m.source_entry_date);

    const sourcePath = rawEntryPath(entriesDir, m.source_entry_date);
    if (!existsSync(sourcePath)) continue;
    const entry = await readEntry(sourcePath);
    if (entry.frontmatter.migrated_to.includes(destStorageForm)) continue;
    await updateRawFrontmatter(sourcePath, {
      ...entry.frontmatter,
      migrated_to: [...entry.frontmatter.migrated_to, destStorageForm],
    });
    result.sourcesUpdated.push(m.source_entry_date);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Daily migration (mb-010) — `bullet migrate`
// ---------------------------------------------------------------------------
//
// Differences from weekly migration above:
//
//   - Destination is an explicit ISO date (today, by default), not
//     "next Monday after the source week."
//   - Bullets land as TASKS (`- [ ] text (from YYYY-MM-DD)`), not
//     quoted notes — `bullet tasks --open` should pick them up so the
//     user can complete them on today's entry.
//   - Source body is mutated. Each accepted task's `- [ ]` line on the
//     source becomes `- [x] text (migrated to YYYY-MM-DD)` so the user
//     reading the source entry sees clearly that the item moved on,
//     and `bullet tasks --open` doesn't double-count migrated tasks
//     between source and destination.
//
// The source-body mutation is a deliberate raw-is-sacred exception
// authorized by the per-item interactive `[y]accept` prompt — see the
// `rewriteRawBody` doc-comment in ./frontmatter.ts for the discipline
// inherited.
//
// The companion `strikeSourceTasks` handles the `[s]trike` decision
// (`- [x] ~~text~~` — abandoned, not migrated, no destination).

// Trailing HTML comment placed on every tool-authored line. Hidden
// in rendered markdown but visible in raw `.md`, and unambiguous as
// machine metadata for any LLM that ingests entries (e.g.
// claude-note --ask) — keeps the user's voice / tool annotations cleanly
// separable.
const AUTO_MARK = "<!-- bullet-migrate auto-mark -->";

// Strip a trailing `(from YYYY-MM-DD)` suffix when re-migrating an
// already-carried task so the destination bullet shows a single
// most-recent-hop provenance (`(from B)`) instead of stacking
// (`(from A) (from B)`). The source rewrite still keeps the chain.
const FROM_SUFFIX_RE = /\s*\(from \d{4}-\d{2}-\d{2}\)\s*$/;

function formatDayBullet(m: MigrationCandidate): string {
  // Task-list syntax so `bullet tasks` picks the carried item up on
  // today's entry. Visible provenance suffix for human reading; HTML
  // comment marker for LLM disambiguation.
  const baseText = m.source_text_fragment.replace(FROM_SUFFIX_RE, "");
  return `- [ ] ${baseText} (from ${m.source_entry_date}) ${AUTO_MARK}`;
}

/**
 * Match an open task line (GFM `- [ ]` or the user's `- []` shorthand).
 * Group 1 is the leading indent; group 2 is the verbatim task text;
 * group 3 captures any trailing `\r` so the rewriter can preserve
 * CRLF line endings on Windows-edited files. `gm` flags + `\r?$`
 * make `^`/`$` line-anchored even when the body uses CRLF — `.`
 * doesn't match `\r`, so without the explicit `\r?` the regex would
 * silently miss every task line on Windows entries.
 *
 * The non-capturing `(?:\s+<!-- bullet-migrate auto-mark -->)?` peels
 * off the trailing tool-attribution marker when present so the
 * source-rewrite lookup keys off clean text, and the rewriter doesn't
 * tack a second auto-mark onto an already-marked line on re-migration.
 */
const OPEN_TASK_LINE_RE =
  /^(\s*)- \[ ?\] (.+?)(?:\s+<!-- bullet-migrate auto-mark -->)?(\r?)$/gm;

interface SourceLineRewrite {
  sourceDate: ISODate;
  originalText: string;
  /** Builds the replacement line given the source's leading indent. */
  build: (indent: string) => string;
}

interface SourceRewriteResult {
  itemsApplied: number;
  /** Tasks that were requested but not found in the source body. */
  itemsNotFound: number;
  /** Source dates whose body was actually mutated. */
  sourcesTouched: ISODate[];
}

/**
 * Apply line-level rewrites to source entry bodies. Each rewrite
 * targets exactly one open `- [ ]` line by verbatim text match;
 * anything else in the body (other tasks, prose, the metadata block)
 * is preserved byte-identically. Multiple rewrites against the same
 * source file batch into a single read-modify-write.
 */
async function applySourceLineRewrites(
  rewrites: SourceLineRewrite[],
  entriesDir: string,
): Promise<SourceRewriteResult> {
  const result: SourceRewriteResult = {
    itemsApplied: 0,
    itemsNotFound: 0,
    sourcesTouched: [],
  };
  if (rewrites.length === 0) return result;

  const byDate = new Map<ISODate, SourceLineRewrite[]>();
  for (const r of rewrites) {
    const arr = byDate.get(r.sourceDate) ?? [];
    arr.push(r);
    byDate.set(r.sourceDate, arr);
  }

  for (const [date, items] of byDate) {
    const path = rawEntryPath(entriesDir, date);
    if (!existsSync(path)) {
      result.itemsNotFound += items.length;
      continue;
    }
    const original = await readFile(path, "utf8");
    const remaining = new Map<string, SourceLineRewrite>();
    for (const item of items) remaining.set(item.originalText, item);

    let touched = false;
    const updated = rewriteRawBody(original, (body) => {
      // Whole-body replace so `gm` + `\r?$` handle CRLF correctly
      // and the captured trailing `\r` (if any) re-appended on each
      // rewritten line preserves the user's existing line-ending style.
      // Splitting on `\n` would have stranded `\r` inside each line
      // and broken on Windows-saved entries.
      return body.replace(
        OPEN_TASK_LINE_RE,
        (full, indent: string, text: string, crlf: string) => {
          const rewrite = remaining.get(text);
          if (!rewrite) return full;
          remaining.delete(text);
          touched = true;
          return rewrite.build(indent) + crlf;
        },
      );
    });

    result.itemsApplied += items.length - remaining.size;
    result.itemsNotFound += remaining.size;
    if (touched) {
      await atomicWrite(path, updated);
      result.sourcesTouched.push(date);
    }
  }
  return result;
}

export interface DayMigrationResult extends MigrationResult {
  /** Source `- [ ]` lines rewritten to `- [x] ... (migrated to ...)`. */
  sourceLinesMarked: number;
  /** Accepted items whose source line couldn't be located for marking. */
  sourceLinesNotFound: number;
}

/**
 * Carry accepted items from a daily migration into the destination
 * day's entry, mark their source lines as migrated, and update each
 * source's `migrated_to` frontmatter.
 *
 * Mirrors `migrateAccepted` (weekly) for the destination + frontmatter
 * sides; adds source-body marking which weekly deliberately skips. See
 * the section comment above for why daily marks the source.
 */
export async function migrateAcceptedToDay(
  accepted: MigrationCandidate[],
  destDate: ISODate,
  entriesDir: string,
  repoRoot: string,
): Promise<DayMigrationResult> {
  const result: DayMigrationResult = {
    destinationPath: "",
    destinationDate: "",
    itemsAdded: 0,
    itemsAlreadyPresent: 0,
    sourcesUpdated: [],
    sourceLinesMarked: 0,
    sourceLinesNotFound: 0,
  };
  if (accepted.length === 0) return result;

  const destPath = rawEntryPath(entriesDir, destDate);
  result.destinationPath = destPath;
  result.destinationDate = destDate;

  // 1. Ensure destination entry exists. Empty sessions list — the
  //    user will record their journaling session via `bullet today`
  //    when they open the file to write.
  if (!existsSync(destPath)) {
    await atomicWrite(destPath, buildSkeleton(destDate, []));
  }

  // 2. Append bullets (idempotent on text match).
  const bullets = accepted.map(formatDayBullet);
  const original = await readFile(destPath, "utf8");
  for (const b of bullets) {
    if (original.includes(b)) result.itemsAlreadyPresent++;
    else result.itemsAdded++;
  }
  if (result.itemsAdded > 0) {
    const updatedDest = addMigrationBullets(original, bullets);
    await atomicWrite(destPath, updatedDest);
  }

  // 3. Mark source `- [ ]` lines as migrated. One read-modify-write
  //    per source date even if multiple items came from the same day.
  const markRewrites: SourceLineRewrite[] = accepted.map((m) => ({
    sourceDate: m.source_entry_date,
    originalText: m.source_text_fragment,
    build: (indent) =>
      `${indent}- [x] ${m.source_text_fragment} (migrated to ${destDate}) ${AUTO_MARK}`,
  }));
  const markResult = await applySourceLineRewrites(markRewrites, entriesDir);
  result.sourceLinesMarked = markResult.itemsApplied;
  result.sourceLinesNotFound = markResult.itemsNotFound;

  // 4. Update each source's `migrated_to` frontmatter (one entry per
  //    source date). Mutates each MigrationCandidate's `migrated_to`
  //    so callers can record provenance from the candidate side too.
  const destStorageForm = toStoragePath(destPath, repoRoot);
  const sourceDatesTouched = new Set<ISODate>();
  for (const m of accepted) {
    m.migrated_to = destStorageForm;

    if (sourceDatesTouched.has(m.source_entry_date)) continue;
    sourceDatesTouched.add(m.source_entry_date);

    const sourcePath = rawEntryPath(entriesDir, m.source_entry_date);
    if (!existsSync(sourcePath)) continue;
    const entry = await readEntry(sourcePath);
    if (entry.frontmatter.migrated_to.includes(destStorageForm)) continue;
    await updateRawFrontmatter(sourcePath, {
      ...entry.frontmatter,
      migrated_to: [...entry.frontmatter.migrated_to, destStorageForm],
    });
    result.sourcesUpdated.push(m.source_entry_date);
  }

  return result;
}

export interface StrikeRequest {
  sourceDate: ISODate;
  /** Verbatim task text without the `- [ ]` prefix. */
  taskText: string;
}

export interface StrikeResult {
  itemsStruck: number;
  itemsNotFound: number;
  sourcesTouched: ISODate[];
}

/**
 * Mark source `- [ ]` lines as struck: `- [ ] foo` → `- [x] ~~foo~~`.
 *
 * Used by `bullet migrate` when the user picks `[s]trike` for a task —
 * "no longer relevant, didn't actually do it, don't carry forward."
 * The `[x]` removes it from `bullet tasks --open`; the `~~strikethrough~~`
 * conveys to the human reader that it wasn't actually accomplished.
 *
 * No destination, no frontmatter mutation — strike is purely a
 * source-side state change. Same per-item user-consent discipline as
 * `migrateAcceptedToDay`.
 */
export async function strikeSourceTasks(
  strikes: StrikeRequest[],
  entriesDir: string,
): Promise<StrikeResult> {
  const rewrites: SourceLineRewrite[] = strikes.map((s) => ({
    sourceDate: s.sourceDate,
    originalText: s.taskText,
    build: (indent) => `${indent}- [x] ~~${s.taskText}~~ ${AUTO_MARK}`,
  }));
  const r = await applySourceLineRewrites(rewrites, entriesDir);
  return {
    itemsStruck: r.itemsApplied,
    itemsNotFound: r.itemsNotFound,
    sourcesTouched: r.sourcesTouched,
  };
}

function formatMonthlyBullet(m: MigrationCandidate): string {
  // Month-scale migrations land as tasks in the Goals section so
  // `bullet tasks` picks them up. The parenthetical citation
  // preserves provenance without requiring the user to look at
  // frontmatter.
  return `- [ ] ${m.source_text_fragment} (carried from ${m.source_entry_date})`;
}

/**
 * Monthly version of `migrateAccepted`: accepted items from a
 * monthly review land in next month's monthly log, appended under
 * the "Goals for the month" section as `- [ ]` tasks.
 *
 * Source-entry updates and idempotency work identically to the
 * weekly path; the only differences are (a) destination is a
 * monthly log, not a daily entry, and (b) bullets carry task
 * markers so they integrate with `bullet tasks`.
 */
export async function migrateAcceptedToMonth(
  accepted: MigrationCandidate[],
  sourceMonthSpec: string,
  entriesDir: string,
  repoRoot: string,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    destinationPath: "",
    destinationDate: "",
    itemsAdded: 0,
    itemsAlreadyPresent: 0,
    sourcesUpdated: [],
  };
  if (accepted.length === 0) return result;

  const destMonth = nextMonthAfter(sourceMonthSpec);
  const destPath = monthlyLogPath(entriesDir, destMonth);
  result.destinationPath = destPath;
  result.destinationDate = destMonth;

  // 1. Ensure destination monthly log exists.
  if (!existsSync(destPath)) {
    await mkdir(dirname(destPath), { recursive: true });
    await atomicWrite(destPath, buildMonthlySkeleton(destMonth, []));
  }

  // 2. Append goals.
  const bullets = accepted.map(formatMonthlyBullet);
  const original = await readFile(destPath, "utf8");
  for (const b of bullets) {
    if (original.includes(b)) result.itemsAlreadyPresent++;
    else result.itemsAdded++;
  }
  if (result.itemsAdded > 0) {
    const updated = appendMonthlyGoals(original, bullets);
    await atomicWrite(destPath, updated);
  }

  // 3. Update source entries' migrated_to + record on candidates.
  const destStorageForm = toStoragePath(destPath, repoRoot);
  const sourceDatesTouched = new Set<ISODate>();
  for (const m of accepted) {
    m.migrated_to = destStorageForm;

    if (sourceDatesTouched.has(m.source_entry_date)) continue;
    sourceDatesTouched.add(m.source_entry_date);

    const sourcePath = rawEntryPath(entriesDir, m.source_entry_date);
    if (!existsSync(sourcePath)) continue;
    const entry = await readEntry(sourcePath);
    if (entry.frontmatter.migrated_to.includes(destStorageForm)) continue;
    await updateRawFrontmatter(sourcePath, {
      ...entry.frontmatter,
      migrated_to: [...entry.frontmatter.migrated_to, destStorageForm],
    });
    result.sourcesUpdated.push(m.source_entry_date);
  }

  return result;
}
