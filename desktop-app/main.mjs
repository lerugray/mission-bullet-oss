// Electron main. Hosts the Claude Design prototype (copied into
// renderer/) and exposes IPC handlers that read/write real entries via
// adapter.mjs, plus a debounced git auto-commit + background push.
//
// Runs under Electron's Node, not Bun — so this module and adapter.mjs
// use only Node-native APIs. Bun-only paths in ../src/ (spawning the
// claude CLI, editor handoff in today.ts) aren't invoked from the
// desktop app; they remain available via the CLI entry point.

import { app, BrowserWindow, Menu, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  appendBullet,
  listKnownDates,
  loadDaysRange,
  openMonthlyLog,
  readImageForDate,
  readMonthlyLog,
  readMonthlyReflection,
  readRawBody,
  readSketchDay,
  readWeeklyReflection,
  resolveProjectPaths,
  saveImageForDate,
  todayEasternISO,
  writeMonthlyBody,
  writeRawBody,
  writeSketchDay,
} from "./adapter.mjs";
import { applyMigration, scanForMigration, strikeOpenTask } from "./migrate-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { projectRoot, entriesDir, reflectionsDir } = resolveProjectPaths(join(__dirname, ".."));

// ---------------- window ----------------

function getFlagValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] || null : null;
}

const ICON_PATH = join(__dirname, "assets", "icon.png");

function createWindow() {
  const winOpts = {
    width: 1400,
    height: 960,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#f6eee3",
    title: "mission-bullet",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (existsSync(ICON_PATH)) winOpts.icon = ICON_PATH;
  const win = new BrowserWindow(winOpts);
  win.removeMenu();
  const initialDate = getFlagValue("--initial-date");
  const loadOpts = initialDate ? { hash: `date=${initialDate}` } : undefined;
  win.loadFile(join(__dirname, "renderer", "index.html"), loadOpts);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  attachContextMenu(win);
  if (process.argv.includes("--dev")) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

// Right-click context menu with spell-check suggestions + standard edit
// actions. Electron ships no default menu — without this, right-click on
// the renderer is a no-op. Spell check itself is on by default in
// Chromium; we just need to surface the suggestions and wire the edit
// commands.
function attachContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const items = [];
    const { dictionarySuggestions = [], misspelledWord, editFlags = {} } = params;

    if (misspelledWord && dictionarySuggestions.length > 0) {
      for (const suggestion of dictionarySuggestions.slice(0, 5)) {
        items.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      items.push({ type: "separator" });
      items.push({
        label: "Add to dictionary",
        click: () =>
          win.webContents.session.addWordToSpellCheckerDictionary(misspelledWord),
      });
      items.push({ type: "separator" });
    }

    items.push({ role: "undo", enabled: editFlags.canUndo });
    items.push({ role: "redo", enabled: editFlags.canRedo });
    items.push({ type: "separator" });
    items.push({ role: "cut", enabled: editFlags.canCut });
    items.push({ role: "copy", enabled: editFlags.canCopy });
    items.push({ role: "paste", enabled: editFlags.canPaste });
    items.push({ role: "selectAll", enabled: editFlags.canSelectAll });

    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function screenshotArg() {
  const idx = process.argv.indexOf("--screenshot");
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

async function runScreenshotAndExit(outPath, captureConsole) {
  const win = createWindow();
  const logs = [];
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    logs.push({ level, message, line, sourceId });
  });
  await new Promise((res) => win.webContents.once("did-finish-load", res));
  // Wait until React mounted the app shell + the IPC-driven days load
  // settled. The poll runs until the shell exists AND the loading
  // placeholder is gone, or until 10s.
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const shell = document.querySelector('.shell');
        const loading = Array.from(document.querySelectorAll('div')).find(
          (el) => (el.textContent || '').trim().toLowerCase() === 'loading entries…'
        );
        if (shell && !loading) return resolve(true);
        if (Date.now() - start > 10000) return resolve(false);
        setTimeout(check, 100);
      };
      check();
    })
  `);
  const dispatchKey = getFlagValue("--dispatch-key");
  if (dispatchKey) {
    // Support a comma-separated sequence of keys, dispatched in order
    // with a short pause between each. Handy for smoke-testing flows
    // that need two key presses to reach the target state (e.g.,
    // "m,e" to open the monthly log then enter edit mode). A plain
    // single-key value still works as before.
    //
    // Each step accepts Chord syntax: `Shift+M`, `Ctrl+S`, `Alt+L`,
    // `Meta+K` (case-insensitive on the modifier; the final key token
    // is passed through verbatim — `M` stays uppercase so handlers
    // testing `e.key === 'M'` fire correctly with shiftKey:true).
    const keys = dispatchKey.split(",").map((k) => k.trim()).filter(Boolean);
    for (const k of keys) {
      const parts = k.split("+").map((p) => p.trim()).filter(Boolean);
      const keyToken = parts.pop();
      const init = { key: keyToken, bubbles: true };
      for (const mod of parts) {
        if (/^shift$/i.test(mod)) init.shiftKey = true;
        else if (/^ctrl$/i.test(mod)) init.ctrlKey = true;
        else if (/^alt$/i.test(mod)) init.altKey = true;
        else if (/^meta$|^cmd$/i.test(mod)) init.metaKey = true;
      }
      await win.webContents.executeJavaScript(`
        window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}));
        new Promise((r) => setTimeout(r, 400));
      `);
    }
  }
  await new Promise((res) => setTimeout(res, 500));
  const img = await win.webContents.capturePage();
  const buf = img.toPNG();
  await writeFile(outPath, buf);
  if (captureConsole) {
    await writeFile(outPath + ".log.json", JSON.stringify(logs, null, 2));
  }
  app.quit();
}

// Headless icon-build mode. Renders desktop-app/icon.html in a hidden
// 256x256 BrowserWindow, captures it as PNG, writes to assets/icon.png,
// then quits. Run via `bun run build:icon` — one-time prerequisite for
// `bun run ui` to pick up the custom taskbar icon.
async function runBuildIconAndExit() {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    resizable: false,
    backgroundColor: "#fdfbf7",
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await win.loadFile(join(__dirname, "icon.html"));
  // Give the font + paint a tick — without this the capture sometimes
  // grabs a frame before the serif fallback resolves.
  await new Promise((res) => setTimeout(res, 350));
  const img = await win.webContents.capturePage();
  await mkdir(join(__dirname, "assets"), { recursive: true });
  await writeFile(ICON_PATH, img.toPNG());
  process.stdout.write(`[mb] wrote ${ICON_PATH}\n`);
  app.quit();
}

// Windows taskbar identity. Without an explicit AppUserModelID, Windows
// groups the running Electron under "electron.exe" with a generic icon
// — even if BrowserWindow has its own icon set. Setting this makes
// mission-bullet a first-class taskbar entry.
if (process.platform === "win32") {
  app.setAppUserModelId("com.mission-bullet");
}

app.whenReady().then(() => {
  if (process.argv.includes("--build-icon")) {
    runBuildIconAndExit().catch((e) => {
      process.stderr.write(`build-icon failed: ${e.message}\n`);
      app.exit(1);
    });
    return;
  }
  const shotPath = screenshotArg();
  if (shotPath) {
    runScreenshotAndExit(shotPath, true).catch((e) => {
      process.stderr.write(`screenshot failed: ${e.message}\n`);
      app.exit(1);
    });
    return;
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------- IPC: data ----------------

ipcMain.handle("mb:loadDays", async (_event, opts = {}) => {
  const todayISO = todayEasternISO();
  const today = new Date(todayISO + "T00:00:00Z");
  const daysBack = Math.max(1, Math.min(60, opts.daysBack ?? 14));
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (daysBack - 1));
  const from = start.toISOString().slice(0, 10);
  return loadDaysRange(entriesDir, from, todayISO, todayISO);
});

ipcMain.handle("mb:knownDates", async () => listKnownDates(entriesDir));

ipcMain.handle("mb:readBody", async (_event, payload = {}) => {
  const date = payload?.date || todayEasternISO();
  return readRawBody(entriesDir, date);
});

ipcMain.handle("mb:writeBody", async (_event, payload) => {
  if (!payload || typeof payload !== "object") throw new Error("writeBody: bad payload");
  const date = payload.date || todayEasternISO();
  const body = typeof payload.body === "string" ? payload.body : "";
  const result = await writeRawBody(entriesDir, date, body);
  scheduleGitSync();
  return result;
});

// Monthly log (Carroll's month-scale planning artifact). Same
// frontmatter-after-anchor shape as daily entries, different anchor +
// keys (month/status/sessions). Read path appends a session stamp
// matching CLI `bullet month` — each "open" counts as a planning
// session. Write path preserves frontmatter and atomically replaces
// the body.
ipcMain.handle("mb:readMonthly", async (_event, payload = {}) => {
  const monthKey = payload?.month;
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error(`readMonthly: invalid month "${monthKey}"`);
  }
  // Stamp session only when explicitly asked — the default is pure read
  // so that re-renders / re-fetches don't inflate the sessions array.
  if (payload?.stamp === true) {
    return openMonthlyLog(entriesDir, monthKey);
  }
  return readMonthlyLog(entriesDir, monthKey);
});

ipcMain.handle("mb:writeMonthly", async (_event, payload) => {
  if (!payload || typeof payload !== "object") throw new Error("writeMonthly: bad payload");
  const { month, body } = payload;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`writeMonthly: invalid month "${month}"`);
  }
  const newBody = typeof body === "string" ? body : "";
  const result = await writeMonthlyBody(entriesDir, month, newBody);
  scheduleGitSync();
  return result;
});

ipcMain.handle("mb:saveImage", async (_event, payload = {}) => {
  const date = payload?.date || todayEasternISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`saveImage: invalid date ${date}`);
  }
  const { dataBase64, mimeType } = payload;
  if (typeof dataBase64 !== "string" || !dataBase64) {
    throw new Error("saveImage: dataBase64 required");
  }
  if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
    throw new Error(`saveImage: mimeType must be image/*; got ${mimeType}`);
  }
  const result = await saveImageForDate(entriesDir, date, dataBase64, mimeType);
  scheduleGitSync();
  return result;
});

ipcMain.handle("mb:readImage", async (_event, payload = {}) => {
  const date = payload?.date || todayEasternISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`readImage: invalid date ${date}`);
  }
  if (typeof payload?.path !== "string" || !payload.path) {
    throw new Error("readImage: path required");
  }
  return readImageForDate(entriesDir, date, payload.path);
});

// Run `bun run bullet review week <weekSpec> --force --non-interactive`
// from the GUI. The CLI surfaces themes + migration candidates via the
// configured provider, defaults all migrations to "defer", and writes
// `reflections/YYYY-WNN.md`. The user can later flip individual
// migrations to accept/reject from the WeeklyView UI (separate flow).
//
// Subprocess takes 5–60s depending on the provider; renderer shows a
// "running review" state while waiting. Errors (no entries, network,
// auth) come back via the `ok`/`stderr` shape the renderer surfaces.
ipcMain.handle("mb:runReviewWeek", async (_event, payload = {}) => {
  const { weekSpec, dryRun } = payload || {};
  if (typeof weekSpec !== "string" || !/^\d{4}-W\d{2}$/.test(weekSpec)) {
    throw new Error(`runReviewWeek: invalid weekSpec "${weekSpec}"`);
  }
  const args = ["run", "bullet", "review", "week", weekSpec, "--force", "--non-interactive"];
  if (dryRun) args.push("--dry-run");
  return new Promise((res) => {
    const proc = spawn("bun", args, {
      cwd: projectRoot,
      shell: process.platform === "win32",
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      res({ ok: false, code: -1, stdout, stderr: stderr || err.message }),
    );
    proc.on("close", (code) =>
      res({ ok: code === 0, code: code ?? 0, stdout, stderr }),
    );
  });
});

ipcMain.handle("mb:readReflection", async (_event, payload = {}) => {
  const year = Number(payload?.year);
  const week = Number(payload?.week);
  if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) {
    throw new Error(`readReflection: invalid year/week (${payload?.year}, ${payload?.week})`);
  }
  return readWeeklyReflection(reflectionsDir, year, week);
});

// Monthly mirror of mb:runReviewWeek. Spawns
// `bun run bullet review month <YYYY-MM> --force --non-interactive`.
// Same shape, same response contract as the weekly handler.
ipcMain.handle("mb:runReviewMonth", async (_event, payload = {}) => {
  const { monthSpec, dryRun } = payload || {};
  if (typeof monthSpec !== "string" || !/^\d{4}-\d{2}$/.test(monthSpec)) {
    throw new Error(`runReviewMonth: invalid monthSpec "${monthSpec}"`);
  }
  const args = ["run", "bullet", "review", "month", monthSpec, "--force", "--non-interactive"];
  if (dryRun) args.push("--dry-run");
  return new Promise((res) => {
    const proc = spawn("bun", args, {
      cwd: projectRoot,
      shell: process.platform === "win32",
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      res({ ok: false, code: -1, stdout, stderr: stderr || err.message }),
    );
    proc.on("close", (code) =>
      res({ ok: code === 0, code: code ?? 0, stdout, stderr }),
    );
  });
});

ipcMain.handle("mb:readMonthlyReflection", async (_event, payload = {}) => {
  const monthSpec = payload?.monthSpec;
  if (typeof monthSpec !== "string" || !/^\d{4}-\d{2}$/.test(monthSpec)) {
    throw new Error(`readMonthlyReflection: invalid monthSpec "${monthSpec}"`);
  }
  return readMonthlyReflection(reflectionsDir, monthSpec);
});

ipcMain.handle("mb:readSketch", async (_event, payload = {}) => {
  const key = payload?.date || todayEasternISO();
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key)) {
    throw new Error(`readSketch: invalid key ${key}`);
  }
  return readSketchDay(entriesDir, key);
});

ipcMain.handle("mb:writeSketch", async (_event, payload) => {
  if (!payload || typeof payload !== "object") throw new Error("writeSketch: bad payload");
  const key = payload.date || todayEasternISO();
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key)) {
    throw new Error(`writeSketch: invalid key ${key}`);
  }
  if (!payload.data || typeof payload.data !== "object") {
    throw new Error("writeSketch: missing data");
  }
  const result = await writeSketchDay(entriesDir, key, payload.data);
  scheduleGitSync();
  return result;
});

ipcMain.handle("mb:saveEntry", async (_event, payload) => {
  if (!payload || typeof payload !== "object") throw new Error("saveEntry: bad payload");
  const { kind, text } = payload;
  if (!["task", "note", "event", "alert"].includes(kind)) throw new Error(`saveEntry: bad kind ${kind}`);
  if (typeof text !== "string" || !text.trim()) throw new Error("saveEntry: empty text");
  const date = payload.date || todayEasternISO();
  const result = await appendBullet(entriesDir, date, kind, text);
  scheduleGitSync();
  return result;
});

// ---------------- IPC: migrate ----------------

ipcMain.handle("mb:migrateScan", async (_event, payload = {}) => {
  const destDate = payload?.destDate || todayEasternISO();
  const fromDate = typeof payload?.fromDate === "string" ? payload.fromDate : null;
  return scanForMigration(entriesDir, destDate, fromDate);
});

ipcMain.handle("mb:strikeTask", async (_event, payload) => {
  if (!payload || typeof payload !== "object") {
    throw new Error("strikeTask: bad payload");
  }
  const { date, taskText } = payload;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`strikeTask: invalid date ${date}`);
  }
  if (typeof taskText !== "string" || !taskText) {
    throw new Error("strikeTask: taskText required");
  }
  const result = await strikeOpenTask({ entriesDir, date, taskText });
  if (result.struck > 0) scheduleGitSync();
  return result;
});

ipcMain.handle("mb:migrateApply", async (_event, payload) => {
  if (!payload || typeof payload !== "object") throw new Error("migrateApply: bad payload");
  const { sourceDate, destDate, decisions } = payload;
  if (!sourceDate || !destDate) throw new Error("migrateApply: sourceDate and destDate required");
  if (!Array.isArray(decisions)) throw new Error("migrateApply: decisions must be an array");
  for (const d of decisions) {
    if (!d || typeof d.taskText !== "string") throw new Error("migrateApply: bad decision item");
    if (!["accept", "reject", "strike"].includes(d.decision)) {
      throw new Error(`migrateApply: bad decision kind ${d.decision}`);
    }
  }
  const summary = await applyMigration({
    entriesDir,
    projectRoot,
    sourceDate,
    destDate,
    decisions,
  });
  scheduleGitSync();
  return summary;
});

// ---------------- git sync ----------------

const SYNC_DEBOUNCE_MS = 5000;
let syncTimer = null;
let syncRunning = false;
let syncAgain = false;
// Broadcast to every open window so the renderer can surface sync
// state (ok / failed / in-progress) in real time. Without this, a
// broken `git push` (expired token, upstream rebased, whatever) would
// fail silently and the user wouldn't know their journal stopped backing up.
let lastSyncState = { status: "idle", tag: null, message: null, at: null };

function broadcastSync(state) {
  lastSyncState = state;
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send("mb:sync-event", state); }
    catch (_) { /* window closed mid-send */ }
  }
}

ipcMain.handle("mb:getSyncStatus", async () => lastSyncState);
ipcMain.handle("mb:syncPull", async () => runGitPull());

function scheduleGitSync() {
  if (syncRunning) {
    syncAgain = true;
    return;
  }
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runGitSync().catch((e) => logSync("sync-failed", e)), SYNC_DEBOUNCE_MS);
}

function logSync(tag, msg) {
  const t = new Date().toISOString();
  const text = msg ? (msg.stack || msg.message || msg) : null;
  process.stdout.write(`[mb-sync ${t}] ${tag}${text ? ": " + text : ""}\n`);
  const isFailure = /failed|error/i.test(tag);
  broadcastSync({
    status: isFailure ? "failed" : (tag === "pushed" ? "ok" : "info"),
    tag,
    message: typeof text === "string" ? text.slice(0, 600) : null,
    at: t,
  });
}

// Git commands must run INSIDE entriesDir — it's a nested repo with
// its own remote (mission-bullet-entries), gitignored by the main
// repo. Running in projectRoot used to silently no-op (entries/ is
// in .gitignore, so `git add entries` staged nothing) which meant
// captures made from the app were writing to disk but never pushing.
// Fixed 2026-04-24.
function runGit(args, opts = {}) {
  return new Promise((resolveP) => {
    const proc = spawn("git", args, { cwd: entriesDir, ...opts });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => resolveP({ code: -1, stdout, stderr: stderr || err.message }));
    proc.on("close", (code) => resolveP({ code: code ?? 0, stdout, stderr }));
  });
}

async function runGitSync() {
  syncRunning = true;
  broadcastSync({ status: "syncing", tag: "syncing", message: null, at: new Date().toISOString() });
  try {
    const add = await runGit(["add", "."]);
    if (add.code !== 0) {
      logSync("add-failed", { message: add.stderr });
      return;
    }
    const status = await runGit(["diff", "--cached", "--name-only"]);
    if (!status.stdout.trim()) {
      logSync("nothing-staged");
      return;
    }
    const msg = `desktop capture ${new Date().toISOString()}`;
    const commit = await runGit(["commit", "-m", msg]);
    if (commit.code !== 0) {
      logSync("commit-failed", { message: commit.stderr || commit.stdout });
      return;
    }
    logSync("committed", { message: msg });
    const push = await runGit(["push"]);
    if (push.code !== 0) {
      logSync("push-failed", { message: (push.stderr || push.stdout).slice(0, 400) });
    } else {
      logSync("pushed");
    }
  } finally {
    syncRunning = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleGitSync();
    }
  }
}

// Manual pull. `git pull --rebase` in entriesDir. Surfaces conflicts
// and non-fast-forward failures through the same broadcastSync channel
// so the UI can show them in the rust alert.
async function runGitPull() {
  broadcastSync({ status: "syncing", tag: "pulling", message: null, at: new Date().toISOString() });
  const result = await runGit(["pull", "--rebase"]);
  if (result.code !== 0) {
    const msg = (result.stderr || result.stdout || "").slice(0, 400);
    logSync("pull-failed", { message: msg });
    return { ok: false, code: result.code, message: msg };
  }
  // `Already up to date.` vs real changes — let the UI know which.
  const quiet = /already up.to.date/i.test(result.stdout);
  logSync(quiet ? "pull-nothing" : "pulled", { message: result.stdout.slice(0, 200) });
  return { ok: true, code: 0, message: quiet ? "already up to date" : "pulled new commits" };
}

ipcMain.handle("mb:syncNow", async () => {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  await runGitSync();
  return { ok: true };
});
