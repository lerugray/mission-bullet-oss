// mission-bullet — YAML-subset parser/serializer for entry frontmatter (mb-004).
//
// Hand-rolled to stay zero-dep. Our schema is narrow (4 keys for raw
// entries) so a full YAML parser would be overkill — the GS house
// style is "hand-rolled type guards at parse boundaries, no schema
// libraries." Same spirit here at the serialization boundary.
//
// ## Wire format
//
// - Bottom-frontmatter layout: an HTML-comment anchor line marks the
//   boundary between user-authored body (above) and machine-managed
//   metadata (below). today.ts established this layout — see the
//   skeleton comment there for why metadata lives at the bottom.
// - Inside the fenced `--- ... ---` block, two primitives:
//     * scalar:  `key: value`     — bare for plain strings/nulls, or
//                                    JSON-quoted for anything awkward
//     * array:   `key: ["a","b"]` — JSON-compatible flow sequence
// - Parser accepts both bare and double-quoted scalars, JSON or bare
//   flow sequences. Writer always emits the stricter form (bare where
//   safe, JSON where not) so round-trips are deterministic.
//
// ## The only mutation into a raw entry file
//
// `replaceRawFrontmatter` is the sole frontmatter writer to an
// existing raw entry path. It splices at the anchor — the body string
// is never re-serialized, so frontmatter writes are mechanically
// incapable of modifying the user's prose. This is the hard floor of
// raw-is-sacred discipline; if you add a second writer, think hard
// about whether the body bytes could drift.

import type {
  EntryFrontmatter,
  MonthlyLogFrontmatter,
  ReflectionFrontmatter,
} from "./types";
import {
  isEntryFrontmatter,
  isMonthlyLogFrontmatter,
  isReflectionFrontmatter,
} from "./types";

export const RAW_ANCHOR =
  "<!-- mission-bullet metadata — do not edit by hand -->";
const REFLECTION_ANCHOR =
  "<!-- mission-bullet reflection metadata — do not edit by hand -->";
const MONTHLY_ANCHOR =
  "<!-- mission-bullet monthly metadata — do not edit by hand -->";
const MIGRATION_BANNER =
  "<!-- migration-forward — auto-generated from prior reviews; you can edit items below -->";
const MIGRATION_HEADER = "## Migrated items";

export class FrontmatterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterParseError";
  }
}

// --- Internal primitives ---

interface ParsedYamlBlock {
  scalars: Record<string, string | null>;
  // Kept as `unknown[]` so reflection frontmatter's object-arrays
  // (themes_surfaced, migrations_proposed) flow through the same
  // parser path as the string-array fields. Callers narrow via the
  // per-type guard in ./types.ts.
  arrays: Record<string, unknown[]>;
}

function parseYamlBlock(blockLines: string[]): ParsedYamlBlock {
  const scalars: Record<string, string | null> = {};
  const arrays: Record<string, unknown[]> = {};
  for (const rawLine of blockLines) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      throw new FrontmatterParseError(`No colon in frontmatter line: ${line}`);
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === "null") {
      scalars[key] = null;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      arrays[key] = parseArrayValue(rest);
    } else if (rest.startsWith('"') && rest.endsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(rest);
        if (typeof parsed !== "string") {
          throw new FrontmatterParseError(
            `Quoted scalar for ${key} did not parse as a string`,
          );
        }
        scalars[key] = parsed;
      } catch {
        throw new FrontmatterParseError(
          `Malformed quoted scalar for ${key}: ${rest}`,
        );
      }
    } else {
      scalars[key] = rest;
    }
  }
  return { scalars, arrays };
}

function parseArrayValue(rest: string): unknown[] {
  // Preferred path: JSON-compatible flow sequence. Writer always emits
  // this form, so round-trips land here every time — for both string
  // arrays (tags, sessions) and object arrays (themes, migrations).
  try {
    const parsed: unknown = JSON.parse(rest);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to bare-split tolerance for hand-edits.
  }
  const inner = rest.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function emitScalar(value: string | null): string {
  if (value === null) return "null";
  // Bare is safe when the value has no leading/trailing whitespace,
  // doesn't contain the YAML key/value ambiguity `": "`, and doesn't
  // start with a character that YAML treats as structural. Anything
  // outside that envelope gets JSON-quoted.
  const needsQuote =
    value.length === 0 ||
    value !== value.trim() ||
    value.includes(": ") ||
    /^[\s"'{}[\]&*!|>%@`#?-]/.test(value);
  return needsQuote ? JSON.stringify(value) : value;
}

function emitArray(values: string[]): string {
  // JSON.stringify gives us a YAML-compatible flow sequence for free,
  // with proper escaping for any special characters in tag strings.
  return JSON.stringify(values);
}

// --- Document splitter ---

function splitAtAnchor(
  content: string,
  anchor: string,
): { body: string; blockLines: string[] } {
  const anchorIdx = content.lastIndexOf(anchor);
  if (anchorIdx < 0) {
    throw new FrontmatterParseError(
      `Metadata anchor not found (expected: ${anchor})`,
    );
  }
  const body = content.slice(0, anchorIdx);
  const tail = content.slice(anchorIdx + anchor.length).replace(/^\n/, "");
  const tailLines = tail.split("\n");
  const firstFenceIdx = tailLines.findIndex((l) => l.trim() === "---");
  if (firstFenceIdx < 0) {
    throw new FrontmatterParseError("Missing opening `---` after anchor");
  }
  const secondFenceRel = tailLines
    .slice(firstFenceIdx + 1)
    .findIndex((l) => l.trim() === "---");
  if (secondFenceRel < 0) {
    throw new FrontmatterParseError("Missing closing `---` in frontmatter");
  }
  const blockLines = tailLines.slice(
    firstFenceIdx + 1,
    firstFenceIdx + 1 + secondFenceRel,
  );
  return { body, blockLines };
}

// --- Public API: raw entry ---

export function parseRawEntryFile(content: string): {
  body: string;
  frontmatter: EntryFrontmatter;
} {
  const { body, blockLines } = splitAtAnchor(content, RAW_ANCHOR);
  const { scalars, arrays } = parseYamlBlock(blockLines);

  const candidate: Record<string, unknown> = {
    date: scalars.date,
    status: scalars.status,
    migrated_to: arrays.migrated_to ?? [],
    // Default to [] for entries written before the sessions field
    // existed — parser is tolerant so pre-existing files don't break.
    // Legacy refined_at / tags_discovered keys (from before refine
    // was removed) are silently ignored.
    sessions: arrays.sessions ?? [],
  };
  if (!isEntryFrontmatter(candidate)) {
    throw new FrontmatterParseError(
      `Raw entry frontmatter failed schema check. Got: ${JSON.stringify(candidate)}`,
    );
  }
  return { body, frontmatter: candidate };
}

function serializeRawFrontmatter(fm: EntryFrontmatter): string {
  return (
    "---\n" +
    `date: ${emitScalar(fm.date)}\n` +
    `status: ${emitScalar(fm.status)}\n` +
    `migrated_to: ${emitArray(fm.migrated_to)}\n` +
    `sessions: ${emitArray(fm.sessions)}\n` +
    "---\n"
  );
}

/**
 * Append migration bullets to a raw entry's body, inside a clearly
 * labeled auto-generated section. Used by mb-007 to carry accepted
 * migration candidates forward from a weekly review into next
 * Monday's entry.
 *
 * ## Relationship to raw-is-sacred
 *
 * Unlike `replaceRawFrontmatter` — which never touches body — this
 * function DOES modify body. The discipline is narrower but still
 * tight:
 *
 * 1. Append-only. Existing body content is never rewritten, only
 *    added to. The section lives at the end of body, before the
 *    metadata anchor.
 * 2. Provenance-banner-required. The section is introduced by an
 *    HTML comment explicitly flagging it as auto-generated, so the
 *    user opens the file and immediately sees which prose is
 *    machine-authored.
 * 3. Idempotent on bullet text. Re-running a review with `--force`
 *    doesn't duplicate items — bullets already present anywhere in
 *    the file are skipped.
 *
 * If a future task needs to write body content for a different
 * reason, flag it as a second exception to raw-is-sacred and apply
 * the same three rules.
 */
export function addMigrationBullets(
  content: string,
  bullets: string[],
): string {
  if (bullets.length === 0) return content;
  const fresh = bullets.filter((b) => !content.includes(b));
  if (fresh.length === 0) return content;

  const anchorIdx = content.lastIndexOf(RAW_ANCHOR);
  if (anchorIdx < 0) {
    throw new FrontmatterParseError(
      "Cannot migrate into entry missing metadata anchor",
    );
  }
  const bodyPart = content.slice(0, anchorIdx);
  const afterAnchor = content.slice(anchorIdx);

  const headerIdx = bodyPart.indexOf(MIGRATION_HEADER);
  if (headerIdx < 0) {
    // No section yet — create it at end of body, with banner.
    const trimmed = bodyPart.replace(/\s*$/, "");
    const sep = trimmed === "" ? "" : "\n\n";
    const rebuilt =
      trimmed +
      sep +
      MIGRATION_BANNER +
      "\n" +
      MIGRATION_HEADER +
      "\n\n" +
      fresh.join("\n") +
      "\n\n";
    return rebuilt + afterAnchor;
  }

  // Section exists. Find its end (next `## ` heading or end of body)
  // and insert new bullets there so they stay clustered with the
  // section header.
  const afterHeader = headerIdx + MIGRATION_HEADER.length;
  const rest = bodyPart.slice(afterHeader);
  const nextHeading = rest.match(/\n##\s/);
  const insertAt =
    nextHeading && nextHeading.index !== undefined
      ? afterHeader + nextHeading.index
      : bodyPart.length;
  const before = bodyPart.slice(0, insertAt).replace(/\s*$/, "");
  const after = bodyPart.slice(insertAt);
  const rebuilt =
    before +
    "\n" +
    fresh.join("\n") +
    (after.startsWith("\n") ? "" : "\n") +
    after;
  return rebuilt.replace(/\s*$/, "") + "\n\n" + afterAnchor.replace(/^\s*/, "");
}

/**
 * Run `rewriter` on a raw entry's body section, leaving the metadata
 * anchor and frontmatter block byte-identical. Used by mb-010 daily
 * migration to mark individual source task lines (`- [ ] foo` →
 * `- [x] foo (migrated to YYYY-MM-DD)` or `- [x] ~~foo~~`) without
 * touching the anchor or YAML below it.
 *
 * The body string passed to `rewriter` ends just before the anchor —
 * the anchor itself is NOT included. Whatever string `rewriter`
 * returns becomes the new body; the anchor + frontmatter is appended
 * verbatim.
 *
 * ## Raw-is-sacred discipline
 *
 * This is the third sanctioned exception to "raw text never modified"
 * (after `addMigrationBullets` for append-only carry-forward and
 * `replaceRawFrontmatter` for frontmatter-only updates). It exists
 * specifically because daily migration is a per-task user-confirmed
 * decision — the user picks `[y]accept` or `[s]trike` for each
 * individual `- [ ]` line, so the mutation is explicit and granular,
 * not blanket AI rewriting. If you add a fourth body-mutation path,
 * it should similarly require per-item user consent.
 */
export function rewriteRawBody(
  content: string,
  rewriter: (body: string) => string,
): string {
  const anchorIdx = content.lastIndexOf(RAW_ANCHOR);
  if (anchorIdx < 0) {
    throw new FrontmatterParseError(
      "Raw entry missing metadata anchor; refusing to rewrite blind",
    );
  }
  const body = content.slice(0, anchorIdx);
  const tail = content.slice(anchorIdx);
  return rewriter(body) + tail;
}

/**
 * Splice a new frontmatter block into a raw entry file, leaving the
 * body bytes untouched. The single entry point for updating a raw
 * entry after creation — if you're adding another writer, think hard
 * about whether the user's text could get clobbered.
 */
export function replaceRawFrontmatter(
  content: string,
  next: EntryFrontmatter,
): string {
  const anchorIdx = content.lastIndexOf(RAW_ANCHOR);
  if (anchorIdx < 0) {
    throw new FrontmatterParseError(
      "Raw entry missing metadata anchor; refusing to write blind",
    );
  }
  return (
    content.slice(0, anchorIdx) +
    RAW_ANCHOR +
    "\n" +
    serializeRawFrontmatter(next)
  );
}

// --- Public API: monthly log ---

function serializeMonthlyFrontmatter(fm: MonthlyLogFrontmatter): string {
  return (
    "---\n" +
    `month: ${emitScalar(fm.month)}\n` +
    `status: ${emitScalar(fm.status)}\n` +
    `sessions: ${emitArray(fm.sessions)}\n` +
    "---\n"
  );
}

export function parseMonthlyLogFile(content: string): {
  body: string;
  frontmatter: MonthlyLogFrontmatter;
} {
  const { body, blockLines } = splitAtAnchor(content, MONTHLY_ANCHOR);
  const { scalars, arrays } = parseYamlBlock(blockLines);
  const candidate: Record<string, unknown> = {
    month: scalars.month,
    status: scalars.status,
    sessions: arrays.sessions ?? [],
  };
  if (!isMonthlyLogFrontmatter(candidate)) {
    throw new FrontmatterParseError(
      `Monthly log frontmatter failed schema check. Got: ${JSON.stringify(candidate)}`,
    );
  }
  return { body, frontmatter: candidate };
}

/**
 * Append `- [ ]` task bullets to the monthly log's "Goals for the
 * month" section, so items migrated forward from a monthly review
 * land where Carroll intended — in the new month's goals list,
 * picked up by `bullet tasks`.
 *
 * Idempotent: bullets already present anywhere in the file are
 * skipped. If the user deleted the Goals section from the skeleton,
 * we append at end of body rather than failing — user intent wins.
 */
export function appendMonthlyGoals(
  content: string,
  bullets: string[],
): string {
  if (bullets.length === 0) return content;
  const fresh = bullets.filter((b) => !content.includes(b));
  if (fresh.length === 0) return content;

  const anchorIdx = content.lastIndexOf(MONTHLY_ANCHOR);
  if (anchorIdx < 0) {
    throw new FrontmatterParseError(
      "Monthly log missing metadata anchor; cannot append goals",
    );
  }
  const bodyPart = content.slice(0, anchorIdx);
  const afterAnchor = content.slice(anchorIdx);

  const goalsHeader = "## Goals for the month";
  const headerIdx = bodyPart.indexOf(goalsHeader);
  if (headerIdx < 0) {
    // Section missing — user edited it out. Append at end of body.
    const trimmed = bodyPart.replace(/\s*$/, "");
    const sep = trimmed === "" ? "" : "\n\n";
    const rebuilt =
      trimmed + sep + goalsHeader + "\n\n" + fresh.join("\n") + "\n\n";
    return rebuilt + afterAnchor;
  }

  // Insert right before the next `## ` heading (or end of body) so
  // bullets cluster with the Goals header, not scatter elsewhere.
  const afterHeader = headerIdx + goalsHeader.length;
  const rest = bodyPart.slice(afterHeader);
  const nextHeading = rest.match(/\n##\s/);
  const insertAt =
    nextHeading && nextHeading.index !== undefined
      ? afterHeader + nextHeading.index
      : bodyPart.length;
  const before = bodyPart.slice(0, insertAt).replace(/\s*$/, "");
  const after = bodyPart.slice(insertAt);
  const rebuilt =
    before +
    "\n" +
    fresh.join("\n") +
    (after.startsWith("\n") ? "" : "\n") +
    after;
  return rebuilt.replace(/\s*$/, "") + "\n\n" + afterAnchor.replace(/^\s*/, "");
}

/**
 * Splice a new frontmatter block into a monthly log, leaving body
 * bytes untouched. Same raw-is-sacred splice path as
 * `replaceRawFrontmatter` — body is never re-serialized, so a
 * session append or `review month` write can't clobber the user's
 * planning prose.
 */
export function replaceMonthlyLogFrontmatter(
  content: string,
  next: MonthlyLogFrontmatter,
): string {
  const anchorIdx = content.lastIndexOf(MONTHLY_ANCHOR);
  if (anchorIdx < 0) {
    throw new FrontmatterParseError(
      "Monthly log missing metadata anchor; refusing to write blind",
    );
  }
  return (
    content.slice(0, anchorIdx) +
    MONTHLY_ANCHOR +
    "\n" +
    serializeMonthlyFrontmatter(next)
  );
}

// --- Public API: reflection (weekly / monthly) ---

function serializeReflectionFrontmatter(fm: ReflectionFrontmatter): string {
  // Object arrays serialize via JSON.stringify — that produces a
  // flow-sequence shape YAML accepts, and our parseArrayValue reads
  // it back through the same path as the string-array fields.
  return (
    "---\n" +
    `period: ${emitScalar(fm.period)}\n` +
    `start_date: ${emitScalar(fm.start_date)}\n` +
    `end_date: ${emitScalar(fm.end_date)}\n` +
    `entries_reviewed: ${emitArray(fm.entries_reviewed)}\n` +
    `themes_surfaced: ${JSON.stringify(fm.themes_surfaced)}\n` +
    `migrations_proposed: ${JSON.stringify(fm.migrations_proposed)}\n` +
    "---\n"
  );
}

/**
 * Compose the full contents of a weekly or monthly reflection file.
 * The `renderedBody` parameter is the already-assembled visible body
 * (section headers, AI-surfaced themes/migrations, editor placeholder
 * for the user's reflection notes); this function just appends the
 * machine-readable metadata block at the bottom.
 */
export function assembleReflectionFile(
  renderedBody: string,
  fm: ReflectionFrontmatter,
): string {
  return (
    renderedBody.trimEnd() +
    "\n\n" +
    REFLECTION_ANCHOR +
    "\n" +
    serializeReflectionFrontmatter(fm)
  );
}

export function parseReflectionFile(content: string): {
  body: string;
  frontmatter: ReflectionFrontmatter;
} {
  const { body, blockLines } = splitAtAnchor(content, REFLECTION_ANCHOR);
  const { scalars, arrays } = parseYamlBlock(blockLines);
  const candidate: Record<string, unknown> = {
    period: scalars.period,
    start_date: scalars.start_date,
    end_date: scalars.end_date,
    entries_reviewed: arrays.entries_reviewed ?? [],
    themes_surfaced: arrays.themes_surfaced ?? [],
    migrations_proposed: arrays.migrations_proposed ?? [],
  };
  if (!isReflectionFrontmatter(candidate)) {
    throw new FrontmatterParseError(
      "Reflection frontmatter failed schema check",
    );
  }
  return { body, frontmatter: candidate };
}
