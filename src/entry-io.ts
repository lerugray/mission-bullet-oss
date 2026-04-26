// mission-bullet — entry file IO (mb-004).
//
// Reads and writes entry files with the atomic tmp+rename pattern
// used in GS's src/state.ts, so a crash mid-write can never leave a
// half-written entry. All storage-facing paths are normalized to
// forward slashes for portability — Windows backslashes stay in the
// runtime filesystem layer only.

import { randomBytes } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  parseRawEntryFile,
  replaceRawFrontmatter,
} from "./frontmatter";
import type { Entry, EntryFrontmatter, ISODate } from "./types";

function dateParts(date: ISODate): {
  year: string;
  month: string;
  day: string;
} {
  const parts = date.split("-");
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  return { year, month, day };
}

export function rawEntryPath(entriesDir: string, date: ISODate): string {
  const { year, month, day } = dateParts(date);
  return join(entriesDir, year, month, `${day}.md`);
}

/**
 * Convert an absolute filesystem path to a portable storage form:
 * relative to the repo root when possible, always forward slashes.
 * Used by migrate to record destination paths in a form that's
 * stable across machines.
 */
export function toStoragePath(absolutePath: string, repoRoot: string): string {
  const normalized = absolutePath.replaceAll("\\", "/");
  const rootNormalized = repoRoot.replaceAll("\\", "/");
  if (normalized.startsWith(rootNormalized)) {
    return normalized.slice(rootNormalized.length).replace(/^\/+/, "");
  }
  return normalized;
}

export async function readEntry(path: string): Promise<Entry> {
  const content = await readFile(path, "utf8");
  const { body, frontmatter } = parseRawEntryFile(content);
  return {
    frontmatter,
    rawMarkdown: body,
    path,
  };
}

/**
 * Atomic write: stage to a randomized tmp path, then rename into
 * place. Mirrors GS's `atomicWrite` in src/state.ts — a crashed run
 * leaves an orphan `.tmp` file, never a half-written entry.
 */
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

/**
 * Update the frontmatter of an existing raw entry file without
 * touching its body. Body bytes are preserved because
 * `replaceRawFrontmatter` splices at the anchor rather than
 * re-serializing the whole document.
 */
export async function updateRawFrontmatter(
  path: string,
  next: EntryFrontmatter,
): Promise<void> {
  const original = await readFile(path, "utf8");
  const updated = replaceRawFrontmatter(original, next);
  await atomicWrite(path, updated);
}
