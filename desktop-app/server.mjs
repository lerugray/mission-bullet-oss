// mission-bullet — HTTP server for phone access (mb-011 phase 3).
//
// Mirrors the Electron main's IPC surface as JSON endpoints so the same
// renderer bundle can run in a browser (phone via Tailscale, laptop
// browser tab, future Capacitor wrapper). Runs under Bun — NOT Electron
// — but imports the same adapter.mjs / migrate-adapter.mjs so the file
// I/O and git-sync discipline match the desktop app byte-for-byte.
//
// NOT multi-user. Single journal, single user. Intended to be bound to
// localhost or a tailnet interface (Tailscale MagicDNS). Do not expose
// to the public internet — there's no auth.
//
// Run with:
//
//   bun run ui:serve        # default port 4173, binds 0.0.0.0
//   MB_SERVER_PORT=5555 bun run ui:serve
//   MB_SERVER_HOST=127.0.0.1 bun run ui:serve   # localhost only
//
// Then on the desktop, `curl http://localhost:4173/` returns the same
// UI. On the phone, open `http://<tailscale-hostname>:4173` in Chrome
// → Add to Home Screen for a PWA-style install.

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { applyMigration, scanForMigration } from "./migrate-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { projectRoot, entriesDir, reflectionsDir } = resolveProjectPaths(join(__dirname, ".."));

const RENDERER_DIR = join(__dirname, "renderer");
const PORT = Number(process.env.MB_SERVER_PORT) || 4173;
const HOST = process.env.MB_SERVER_HOST || "0.0.0.0";

// ---------------- git sync (same contract as main.mjs) ----------------

const SYNC_DEBOUNCE_MS = 5000;
let syncTimer = null;
let syncRunning = false;
let syncAgain = false;

function scheduleGitSync() {
  if (syncRunning) {
    syncAgain = true;
    return;
  }
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(
    () => runGitSync().catch((e) => logSync("sync-failed", e)),
    SYNC_DEBOUNCE_MS,
  );
}

function logSync(tag, msg) {
  const t = new Date().toISOString();
  process.stdout.write(
    `[mb-server-sync ${t}] ${tag}${msg ? ": " + (msg.stack || msg.message || msg) : ""}\n`,
  );
}

// Git commands run INSIDE entriesDir — it's a nested repo with its
// own remote, gitignored by the main project repo. Running in
// projectRoot used to silently stage nothing. Matches main.mjs fix.
function runGit(args) {
  return new Promise((res) => {
    const proc = spawn("git", args, { cwd: entriesDir });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => res({ code: -1, stdout, stderr: stderr || err.message }));
    proc.on("close", (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

async function runGitSync() {
  syncRunning = true;
  try {
    const add = await runGit(["add", "."]);
    if (add.code !== 0) { logSync("add-failed", { message: add.stderr }); return; }
    const status = await runGit(["diff", "--cached", "--name-only"]);
    if (!status.stdout.trim()) { logSync("nothing-staged"); return; }
    const msg = `phone/browser capture ${new Date().toISOString()}`;
    const commit = await runGit(["commit", "-m", msg]);
    if (commit.code !== 0) { logSync("commit-failed", { message: commit.stderr || commit.stdout }); return; }
    logSync("committed", { message: msg });
    const push = await runGit(["push"]);
    if (push.code !== 0) logSync("push-failed", { message: (push.stderr || push.stdout).slice(0, 400) });
    else logSync("pushed");
  } finally {
    syncRunning = false;
    if (syncAgain) { syncAgain = false; scheduleGitSync(); }
  }
}

async function runGitPull() {
  const result = await runGit(["pull", "--rebase"]);
  if (result.code !== 0) {
    logSync("pull-failed", { message: (result.stderr || result.stdout || "").slice(0, 400) });
    return { ok: false, code: result.code, message: (result.stderr || result.stdout || "").slice(0, 400) };
  }
  const quiet = /already up.to.date/i.test(result.stdout);
  logSync(quiet ? "pull-nothing" : "pulled");
  return { ok: true, code: 0, message: quiet ? "already up to date" : "pulled new commits" };
}

// ---------------- static asset server ----------------

const MIME = {
  ".html":  "text/html; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".js":    "text/javascript; charset=utf-8",
  ".jsx":   "text/javascript; charset=utf-8",
  ".json":  "application/json; charset=utf-8",
  ".svg":   "image/svg+xml",
  ".png":   "image/png",
  ".ico":   "image/x-icon",
  // Excalidraw assets — fonts + LICENSE text served from
  // renderer/sketch/excalidraw-assets/.
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".ttf":   "font/ttf",
  ".otf":   "font/otf",
  ".txt":   "text/plain; charset=utf-8",
};

async function serveStatic(pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(RENDERER_DIR, safePath);
  if (!filePath.startsWith(RENDERER_DIR)) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return new Response("not found", { status: 404 });
    const ext = safePath.slice(safePath.lastIndexOf("."));
    const body = await readFile(filePath);
    return new Response(body, {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
    });
  } catch (e) {
    if (e?.code === "ENOENT") return new Response("not found", { status: 404 });
    return new Response(`error: ${e.message}`, { status: 500 });
  }
}

// ---------------- API (mirrors main.mjs IPC handlers 1:1) ----------------

async function handleApi(url, req) {
  const route = url.pathname.slice(5); // strip '/api/'
  let body = null;
  if (req.method === "POST") {
    try { body = await req.json(); } catch { body = {}; }
  }

  try {
    if (route === "loadDays" && req.method === "POST") {
      const todayISO = todayEasternISO();
      const today = new Date(todayISO + "T00:00:00Z");
      const daysBack = Math.max(1, Math.min(60, body?.daysBack ?? 14));
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - (daysBack - 1));
      const from = start.toISOString().slice(0, 10);
      return Response.json(await loadDaysRange(entriesDir, from, todayISO, todayISO));
    }
    if (route === "knownDates" && req.method === "POST") {
      return Response.json(await listKnownDates(entriesDir));
    }
    if (route === "readBody" && req.method === "POST") {
      const date = body?.date || todayEasternISO();
      return Response.json(await readRawBody(entriesDir, date));
    }
    if (route === "writeBody" && req.method === "POST") {
      const date = body?.date || todayEasternISO();
      const text = typeof body?.body === "string" ? body.body : "";
      const result = await writeRawBody(entriesDir, date, text);
      scheduleGitSync();
      return Response.json(result);
    }
    if (route === "readMonthly" && req.method === "POST") {
      const monthKey = body?.month;
      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return Response.json({ error: `invalid month "${monthKey}"` }, { status: 400 });
      }
      if (body?.stamp === true) {
        const result = await openMonthlyLog(entriesDir, monthKey);
        scheduleGitSync();
        return Response.json(result);
      }
      return Response.json(await readMonthlyLog(entriesDir, monthKey));
    }
    if (route === "writeMonthly" && req.method === "POST") {
      const monthKey = body?.month;
      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return Response.json({ error: `invalid month "${monthKey}"` }, { status: 400 });
      }
      const newBody = typeof body?.body === "string" ? body.body : "";
      const result = await writeMonthlyBody(entriesDir, monthKey, newBody);
      scheduleGitSync();
      return Response.json(result);
    }
    if (route === "saveImage" && req.method === "POST") {
      const date = body?.date || todayEasternISO();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return Response.json({ error: `invalid date ${date}` }, { status: 400 });
      }
      const { dataBase64, mimeType } = body || {};
      if (typeof dataBase64 !== "string" || !dataBase64) {
        return Response.json({ error: "dataBase64 required" }, { status: 400 });
      }
      if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
        return Response.json({ error: `bad mimeType ${mimeType}` }, { status: 400 });
      }
      const result = await saveImageForDate(entriesDir, date, dataBase64, mimeType);
      scheduleGitSync();
      return Response.json(result);
    }
    if (route === "readImage" && req.method === "POST") {
      const date = body?.date || todayEasternISO();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return Response.json({ error: `invalid date ${date}` }, { status: 400 });
      }
      if (typeof body?.path !== "string" || !body.path) {
        return Response.json({ error: "path required" }, { status: 400 });
      }
      return Response.json(await readImageForDate(entriesDir, date, body.path));
    }
    if (route === "runReviewWeek" && req.method === "POST") {
      const { weekSpec, dryRun } = body || {};
      if (typeof weekSpec !== "string" || !/^\d{4}-W\d{2}$/.test(weekSpec)) {
        return Response.json({ error: `invalid weekSpec ${weekSpec}` }, { status: 400 });
      }
      const args = ["run", "bullet", "review", "week", weekSpec, "--force", "--non-interactive"];
      if (dryRun) args.push("--dry-run");
      const result = await new Promise((res) => {
        const proc = spawn("bun", args, {
          cwd: projectRoot,
          shell: process.platform === "win32",
        });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", (err) => res({ ok: false, code: -1, stdout, stderr: stderr || err.message }));
        proc.on("close", (code) => res({ ok: code === 0, code: code ?? 0, stdout, stderr }));
      });
      return Response.json(result);
    }
    if (route === "readReflection" && req.method === "POST") {
      const year = Number(body?.year);
      const week = Number(body?.week);
      if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) {
        return Response.json({ error: `invalid year/week` }, { status: 400 });
      }
      return Response.json(await readWeeklyReflection(reflectionsDir, year, week));
    }
    if (route === "runReviewMonth" && req.method === "POST") {
      const { monthSpec, dryRun } = body || {};
      if (typeof monthSpec !== "string" || !/^\d{4}-\d{2}$/.test(monthSpec)) {
        return Response.json({ error: `invalid monthSpec ${monthSpec}` }, { status: 400 });
      }
      const args = ["run", "bullet", "review", "month", monthSpec, "--force", "--non-interactive"];
      if (dryRun) args.push("--dry-run");
      const result = await new Promise((res) => {
        const proc = spawn("bun", args, {
          cwd: projectRoot,
          shell: process.platform === "win32",
        });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", (err) => res({ ok: false, code: -1, stdout, stderr: stderr || err.message }));
        proc.on("close", (code) => res({ ok: code === 0, code: code ?? 0, stdout, stderr }));
      });
      return Response.json(result);
    }
    if (route === "readMonthlyReflection" && req.method === "POST") {
      const monthSpec = body?.monthSpec;
      if (typeof monthSpec !== "string" || !/^\d{4}-\d{2}$/.test(monthSpec)) {
        return Response.json({ error: `invalid monthSpec` }, { status: 400 });
      }
      return Response.json(await readMonthlyReflection(reflectionsDir, monthSpec));
    }
    if (route === "readSketch" && req.method === "POST") {
      const key = body?.date || todayEasternISO();
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key)) {
        return Response.json({ error: `invalid key ${key}` }, { status: 400 });
      }
      return Response.json(await readSketchDay(entriesDir, key));
    }
    if (route === "writeSketch" && req.method === "POST") {
      const key = body?.date || todayEasternISO();
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key)) {
        return Response.json({ error: `invalid key ${key}` }, { status: 400 });
      }
      if (!body?.data || typeof body.data !== "object") {
        return Response.json({ error: "missing data" }, { status: 400 });
      }
      const result = await writeSketchDay(entriesDir, key, body.data);
      scheduleGitSync();
      return Response.json(result);
    }
    if (route === "saveEntry" && req.method === "POST") {
      const { kind, text } = body || {};
      if (!["task", "note", "event", "alert"].includes(kind)) {
        return Response.json({ error: `bad kind ${kind}` }, { status: 400 });
      }
      if (typeof text !== "string" || !text.trim()) {
        return Response.json({ error: "empty text" }, { status: 400 });
      }
      const date = body?.date || todayEasternISO();
      const result = await appendBullet(entriesDir, date, kind, text);
      scheduleGitSync();
      return Response.json(result);
    }
    if (route === "migrateScan" && req.method === "POST") {
      const destDate = body?.destDate || todayEasternISO();
      const fromDate = typeof body?.fromDate === "string" ? body.fromDate : null;
      return Response.json(await scanForMigration(entriesDir, destDate, fromDate));
    }
    if (route === "migrateApply" && req.method === "POST") {
      const { sourceDate, destDate, decisions } = body || {};
      if (!sourceDate || !destDate) {
        return Response.json({ error: "sourceDate and destDate required" }, { status: 400 });
      }
      if (!Array.isArray(decisions)) {
        return Response.json({ error: "decisions must be an array" }, { status: 400 });
      }
      const summary = await applyMigration({
        entriesDir,
        projectRoot,
        sourceDate,
        destDate,
        decisions,
      });
      scheduleGitSync();
      return Response.json(summary);
    }
    if (route === "syncNow" && req.method === "POST") {
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      await runGitSync();
      return Response.json({ ok: true });
    }
    if (route === "syncPull" && req.method === "POST") {
      return Response.json(await runGitPull());
    }
    return new Response("not found", { status: 404 });
  } catch (e) {
    return Response.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

// ---------------- start ----------------

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(url, req);
    return serveStatic(url.pathname);
  },
});

process.stdout.write(`[mb-server] listening on http://${HOST}:${PORT}\n`);
process.stdout.write(`[mb-server] project: ${projectRoot}\n`);
process.stdout.write(`[mb-server] entries: ${entriesDir}\n`);
process.stdout.write(`[mb-server] open in any browser; expose via Tailscale for phone\n`);
