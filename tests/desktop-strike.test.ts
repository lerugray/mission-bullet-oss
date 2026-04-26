// Inline strike action wired to the daily view's `Shift+X` shortcut.
// The function lives in desktop-app/migrate-adapter.mjs (Node-native,
// no Bun-specific APIs) so the desktop app's Electron main process
// can call it. Bun's test runner can import the .mjs directly.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";

const TMP = join(process.cwd(), "tmp-desktop-strike-test");
const ENTRIES = join(TMP, "entries");

const RAW_ANCHOR = "<!-- mission-bullet metadata — do not edit by hand -->";

async function writeEntry(date: string, body: string): Promise<string> {
  const [year, month, day] = date.split("-");
  const path = join(ENTRIES, year!, month!, `${day}.md`);
  await mkdir(dirname(path), { recursive: true });
  const content =
    body +
    "\n\n" +
    RAW_ANCHOR +
    "\n---\n" +
    `date: ${date}\n` +
    "status: open\n" +
    "migrated_to: []\n" +
    'sessions: []\n' +
    "---\n";
  await writeFile(path, content, "utf8");
  return path;
}

async function setup() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(ENTRIES, { recursive: true });
}

// The .mjs adapter has no .d.ts. Cast through this helper once so
// per-test imports stay tidy and the function signature is asserted
// at the boundary instead of at every call site.
type StrikeResult = { struck: number; found: boolean; reason?: string };
type Adapter = {
  strikeOpenTask: (opts: {
    entriesDir: string;
    date: string;
    taskText: string;
  }) => Promise<StrikeResult>;
};
async function loadAdapter(): Promise<Adapter> {
  // @ts-expect-error — .mjs adapter has no .d.ts; cast at the boundary.
  return (await import("../desktop-app/migrate-adapter.mjs")) as Adapter;
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe("strikeOpenTask (desktop migrate-adapter)", () => {
  beforeEach(setup);

  test("rewrites `- [ ] foo` to `- [x] ~~foo~~ <auto-mark>`", async () => {
    const path = await writeEntry(
      "2026-04-22",
      "- [ ] reset sleep schedule\n- [ ] keep this one",
    );
    const { strikeOpenTask } = await loadAdapter();
    const r = await strikeOpenTask({
      entriesDir: ENTRIES,
      date: "2026-04-22",
      taskText: "reset sleep schedule",
    });
    expect(r.struck).toBe(1);
    expect(r.found).toBe(true);

    const after = await readFile(path, "utf8");
    expect(after).toContain(
      "- [x] ~~reset sleep schedule~~ <!-- bullet-migrate auto-mark -->",
    );
    // Sibling task untouched.
    expect(after).toContain("- [ ] keep this one");
    // Sibling NOT carrying the auto-mark.
    expect(after).not.toMatch(
      /- \[ \] keep this one.*bullet-migrate auto-mark/,
    );
  });

  test("preserves `(from YYYY-MM-DD)` provenance when striking a carried task", async () => {
    // Carry-forward bullets often have provenance suffixes — strike
    // must include them in the rewrite so the original chain stays
    // visible alongside the strikethrough wrapper.
    const path = await writeEntry(
      "2026-04-24",
      "- [ ] follow up on Q2 (from 2026-04-21) <!-- bullet-migrate auto-mark -->",
    );
    const { strikeOpenTask } = await loadAdapter();
    const r = await strikeOpenTask({
      entriesDir: ENTRIES,
      date: "2026-04-24",
      taskText: "follow up on Q2 (from 2026-04-21)",
    });
    expect(r.struck).toBe(1);

    const after = await readFile(path, "utf8");
    expect(after).toContain(
      "- [x] ~~follow up on Q2 (from 2026-04-21)~~ <!-- bullet-migrate auto-mark -->",
    );
  });

  test("idempotent: re-running on an already-struck line is a no-op", async () => {
    const path = await writeEntry("2026-04-22", "- [ ] foo");
    const { strikeOpenTask } = await loadAdapter();
    const r1 = await strikeOpenTask({
      entriesDir: ENTRIES,
      date: "2026-04-22",
      taskText: "foo",
    });
    expect(r1.struck).toBe(1);
    const after1 = await readFile(path, "utf8");

    const r2 = await strikeOpenTask({
      entriesDir: ENTRIES,
      date: "2026-04-22",
      taskText: "foo",
    });
    expect(r2.struck).toBe(0);
    expect(r2.found).toBe(false);
    const after2 = await readFile(path, "utf8");
    expect(after2).toBe(after1);
  });

  test("returns found=false on text mismatch instead of throwing", async () => {
    await writeEntry("2026-04-22", "- [ ] real task");
    const { strikeOpenTask } = await loadAdapter();
    const r = await strikeOpenTask({
      entriesDir: ENTRIES,
      date: "2026-04-22",
      taskText: "phantom task",
    });
    expect(r.struck).toBe(0);
    expect(r.found).toBe(false);
  });

  test("missing entry file returns found=false instead of throwing", async () => {
    const { strikeOpenTask } = await loadAdapter();
    const r = await strikeOpenTask({
      entriesDir: ENTRIES,
      date: "2026-04-99",
      taskText: "anything",
    });
    expect(r.struck).toBe(0);
    expect(r.found).toBe(false);
  });
});
