// Node-native daily-migration engine for the desktop app (mb-011 phase 2).
//
// Ports the semantics of src/migrate.ts and src/migrate-day.ts into the
// Electron main process so `bullet migrate` can happen inside the app
// without a terminal round-trip. The library under src/ stays Bun-only;
// this module re-implements just enough to:
//
//   - scan back from the destination date for the most recent daily
//     entry that still has `- [ ]` tasks (up to 14 days)
//   - apply a batch of per-task decisions: accept (carry forward),
//     strike (mark abandoned), or reject (no-op, stays open)
//
// ## Raw-is-sacred discipline inherited verbatim from frontmatter.ts
//
// - Source body lines are rewritten only for tasks the user explicitly
//   picked accept or strike on; reject touches nothing. Every tool-
//   authored line ends with `<!-- bullet-migrate auto-mark -->` so an
//   LLM ingesting the entry (e.g. claude-note --ask) can tell tool
//   annotations from the user's own writing.
// - Destination body gains bullets only inside a `## Migrated items`
//   section behind a provenance banner — append-only, idempotent on
//   exact text match.
// - Source frontmatter gains one forward-slashed storage path per
//   destination in `migrated_to`; never removes prior entries.
//
// CRLF line endings on Windows-saved entries are tolerated by the
// `\r?$` tail on OPEN_TASK_LINE_RE (matches src/migrate-day.ts fix).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  RAW_ANCHOR,
  assembleFile,
  atomicWrite,
  defaultFrontmatter,
  entryPath,
  parseFrontmatterBlock,
  splitAtAnchor,
} from "./adapter.mjs";

const AUTO_MARK = "<!-- bullet-migrate auto-mark -->";
const MIGRATION_BANNER =
  "<!-- migration-forward — auto-generated from prior reviews; you can edit items below -->";
const MIGRATION_HEADER = "## Migrated items";

// Group 1 = leading indent, group 2 = task text, group 3 = optional \r.
// The non-capturing `(?:\s+<!-- bullet-migrate auto-mark -->)?` consumes
// the trailing tool-attribution marker when present so callers (the
// modal display and the source rewriter) see clean task text. Without
// this peel-off, `extractOpenTasks` would surface raw `foo (from X)
// <!-- bullet-migrate auto-mark -->` strings into the migrate modal,
// and the source-rewrite path would tack a second auto-mark onto an
// already-marked line on re-migration.
const OPEN_TASK_LINE_RE =
  /^(\s*)- \[ ?\] (.+?)(?:\s+<!-- bullet-migrate auto-mark -->)?(\r?)$/gm;

// Strip a trailing `(from YYYY-MM-DD)` provenance suffix. Used when
// rebuilding a destination bullet on re-migration so the new entry
// shows only the most-recent hop instead of stacking `(from A) (from
// B)`. The source rewrite still preserves the chain — only the
// destination gets the cleaned text.
const FROM_SUFFIX_RE = /\s*\(from \d{4}-\d{2}-\d{2}\)\s*$/;

const DEFAULT_LOOKBACK_DAYS = 14;

export function previousDayIso(date) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return (
    `${dt.getUTCFullYear()}-` +
    `${String(dt.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(dt.getUTCDate()).padStart(2, "0")}`
  );
}

export function extractOpenTasks(body) {
  const tasks = [];
  for (const m of body.matchAll(OPEN_TASK_LINE_RE)) {
    if (m[2] !== undefined) tasks.push(m[2]);
  }
  return tasks;
}

async function loadOpenTasksForDate(entriesDir, date) {
  const path = entryPath(entriesDir, date);
  if (!existsSync(path)) return [];
  const content = await readFile(path, "utf8");
  const { body } = splitAtAnchor(content);
  return extractOpenTasks(body);
}

async function findRecentSource(entriesDir, beforeDate, maxDaysBack = DEFAULT_LOOKBACK_DAYS) {
  let cursor = beforeDate;
  for (let i = 0; i < maxDaysBack; i++) {
    cursor = previousDayIso(cursor);
    const tasks = await loadOpenTasksForDate(entriesDir, cursor);
    if (tasks.length > 0) return { date: cursor, tasks };
  }
  return null;
}

// `from` is optional — null means walk back from `destDate` automatically.
// Returns { source: null, destDate } when there is nothing to migrate, or
// { source: { date, tasks }, destDate } when the user has work to do.
export async function scanForMigration(entriesDir, destDate, fromDate) {
  if (fromDate) {
    if (fromDate === destDate) {
      throw new Error(`--from and --to are the same date (${destDate})`);
    }
    const path = entryPath(entriesDir, fromDate);
    if (!existsSync(path)) {
      throw new Error(`No entry file exists for ${fromDate}`);
    }
    const tasks = await loadOpenTasksForDate(entriesDir, fromDate);
    return { source: tasks.length > 0 ? { date: fromDate, tasks } : null, destDate };
  }
  const source = await findRecentSource(entriesDir, destDate);
  return { source, destDate };
}

// --- destination append (idempotent on exact text match) ---

function addMigrationBullets(content, bullets) {
  if (bullets.length === 0) return content;
  const fresh = bullets.filter((b) => !content.includes(b));
  if (fresh.length === 0) return content;

  const anchorIdx = content.lastIndexOf(RAW_ANCHOR);
  if (anchorIdx < 0) {
    throw new Error("Cannot migrate into entry missing metadata anchor");
  }
  const bodyPart = content.slice(0, anchorIdx);
  const afterAnchor = content.slice(anchorIdx);

  const headerIdx = bodyPart.indexOf(MIGRATION_HEADER);
  if (headerIdx < 0) {
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

// --- source body rewrite (splices just the body region; anchor +
//     frontmatter bytes below it are preserved identically) ---

function rewriteSourceBody(content, rewriter) {
  const anchorIdx = content.lastIndexOf(RAW_ANCHOR);
  if (anchorIdx < 0) {
    throw new Error("Source entry missing metadata anchor; refusing to rewrite blind");
  }
  const body = content.slice(0, anchorIdx);
  const tail = content.slice(anchorIdx);
  return rewriter(body) + tail;
}

// --- storage-path form used in source's migrated_to frontmatter ---

function toStoragePath(absolutePath, projectRoot) {
  const normalized = absolutePath.replaceAll("\\", "/");
  const rootNormalized = projectRoot.replaceAll("\\", "/");
  if (normalized.startsWith(rootNormalized)) {
    return normalized.slice(rootNormalized.length).replace(/^\/+/, "");
  }
  return normalized;
}

// Skeleton for a brand-new destination file. Matches src/today.ts
// `buildSkeleton(date, [])` byte-for-byte so first-creation files look
// the same whether migrate ran from the CLI or the desktop app.
function buildSkeleton(date) {
  return (
    "\n\n" +
    RAW_ANCHOR +
    "\n---\n" +
    `date: ${date}\n` +
    `status: open\n` +
    `migrated_to: []\n` +
    `sessions: []\n` +
    "---\n"
  );
}

/**
 * Strike a single open task on a given day, in-place. Carroll's
 * "no longer relevant" mark — `- [ ] foo` becomes
 * `- [x] ~~foo~~ <!-- bullet-migrate auto-mark -->`. Silently no-ops
 * if the line isn't found (already struck, already done, or text
 * mismatch). Same source-rewrite discipline as the migrate flow:
 * splice only the body region; frontmatter + anchor preserved
 * byte-identical.
 */
export async function strikeOpenTask({ entriesDir, date, taskText }) {
  const path = entryPath(entriesDir, date);
  if (!existsSync(path)) {
    return { struck: 0, found: false, reason: "no entry" };
  }
  const content = await readFile(path, "utf8");
  let touched = false;
  const newContent = rewriteSourceBody(content, (body) =>
    body.replace(OPEN_TASK_LINE_RE, (full, indent, text, crlf) => {
      if (text !== taskText) return full;
      touched = true;
      return `${indent}- [x] ~~${text}~~ ${AUTO_MARK}${crlf}`;
    }),
  );
  if (!touched) {
    return { struck: 0, found: false, reason: "task line not found" };
  }
  await atomicWrite(path, newContent);
  return { struck: 1, found: true };
}

/**
 * Apply per-task decisions. `decisions` is an array of
 * `{ taskText: string, decision: 'accept' | 'reject' | 'strike' }`.
 * Returns a summary object for the UI to render back to the user.
 */
export async function applyMigration({ entriesDir, projectRoot, sourceDate, destDate, decisions }) {
  const accepts = decisions.filter((d) => d.decision === "accept");
  const strikes = decisions.filter((d) => d.decision === "strike");
  const rejects = decisions.filter((d) => d.decision === "reject");

  const summary = {
    accepted: accepts.length,
    rejected: rejects.length,
    strikeRequested: strikes.length,
    carried: 0,
    alreadyPresent: 0,
    struck: 0,
    sourceLinesNotFound: 0,
    sourceDate,
    destDate,
    destinationPath: entryPath(entriesDir, destDate),
  };

  if (accepts.length === 0 && strikes.length === 0) return summary;

  // 1. Destination entry — ensure exists, then append accepted bullets.
  const destPath = entryPath(entriesDir, destDate);
  if (accepts.length > 0) {
    if (!existsSync(destPath)) {
      await atomicWrite(destPath, buildSkeleton(destDate));
    }
    const bullets = accepts.map((a) => {
      const baseText = a.taskText.replace(FROM_SUFFIX_RE, "");
      return `- [ ] ${baseText} (from ${sourceDate}) ${AUTO_MARK}`;
    });
    const destContent = await readFile(destPath, "utf8");
    for (const b of bullets) {
      if (destContent.includes(b)) summary.alreadyPresent++;
      else summary.carried++;
    }
    if (summary.carried > 0) {
      const updated = addMigrationBullets(destContent, bullets);
      await atomicWrite(destPath, updated);
    }
  }

  // 2. Source body rewrite. Accepts + strikes rewrite the same
  //    `- [ ]` line (the user picked one or the other, never both).
  //    One read-modify-write handles both.
  const sourcePath = entryPath(entriesDir, sourceDate);
  if (!existsSync(sourcePath)) {
    // No source file — the scan found nothing rewritable anyway. The
    // accepted items did land on dest via step 1.
    return summary;
  }

  const rewrites = new Map();
  for (const a of accepts) {
    rewrites.set(
      a.taskText,
      (indent) => `${indent}- [x] ${a.taskText} (migrated to ${destDate}) ${AUTO_MARK}`,
    );
  }
  for (const s of strikes) {
    rewrites.set(
      s.taskText,
      (indent) => `${indent}- [x] ~~${s.taskText}~~ ${AUTO_MARK}`,
    );
  }

  if (rewrites.size > 0) {
    const sourceContent = await readFile(sourcePath, "utf8");
    const remaining = new Map(rewrites);
    let touched = false;
    const newContent = rewriteSourceBody(sourceContent, (body) =>
      body.replace(OPEN_TASK_LINE_RE, (full, indent, text, crlf) => {
        const build = remaining.get(text);
        if (!build) return full;
        remaining.delete(text);
        touched = true;
        return build(indent) + crlf;
      }),
    );
    summary.struck = strikes.length - strikes.filter((s) => remaining.has(s.taskText)).length;
    summary.sourceLinesNotFound = remaining.size;
    if (touched) {
      await atomicWrite(sourcePath, newContent);
    }
  }

  // 3. Source frontmatter — append destination storage path to
  //    `migrated_to` (append-unique). Only for accepts; strikes have
  //    no destination.
  if (accepts.length > 0) {
    const postRewrite = await readFile(sourcePath, "utf8");
    const { body, frontmatterBlock } = splitAtAnchor(postRewrite);
    const fm = frontmatterBlock
      ? { ...defaultFrontmatter(sourceDate), ...parseFrontmatterBlock(frontmatterBlock) }
      : defaultFrontmatter(sourceDate);
    const destStorage = toStoragePath(destPath, projectRoot);
    const migratedTo = Array.isArray(fm.migrated_to) ? fm.migrated_to : [];
    if (!migratedTo.includes(destStorage)) {
      fm.migrated_to = [...migratedTo, destStorage];
      await atomicWrite(sourcePath, assembleFile(body, fm));
    }
  }

  return summary;
}
