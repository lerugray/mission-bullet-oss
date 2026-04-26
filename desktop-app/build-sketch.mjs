// mission-bullet — sketch bundle build (mb-012)
//
// Excalidraw can't load via the renderer's Babel-in-browser setup (CSS
// imports, ESM-only shape, React resolution). This script bundles the
// wrapper.jsx React component + Excalidraw + React into
// renderer/sketch/bundle.js (+ bundle.css). Runs as a `bun run`
// precondition to `ui`, `ui:dev`, `ui:serve`.
//
// Skips the build if bundle.js + bundle.css exist and are newer than
// every source file under renderer/sketch/ and than the locked
// Excalidraw package. That keeps the common `bun run ui` path fast
// (sub-100ms no-op when nothing changed).

import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const sketchDir = join(__dirname, "renderer", "sketch");
const entry = join(sketchDir, "wrapper.jsx");
const outJs = join(sketchDir, "bundle.js");
const outCss = join(sketchDir, "bundle.css");
const assetsOut = join(sketchDir, "excalidraw-assets");
const assetsSrc = join(projectRoot, "node_modules", "@excalidraw", "excalidraw", "dist", "excalidraw-assets");

async function latestMtime(root) {
  let latest = 0;
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "bundle.js" || e.name === "bundle.css") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const m = statSync(p).mtimeMs;
        if (m > latest) latest = m;
      }
    }
  };
  if (existsSync(root)) await walk(root);
  // Lockfile — captures Excalidraw version bumps.
  const lock = join(projectRoot, "bun.lock");
  if (existsSync(lock)) {
    const m = statSync(lock).mtimeMs;
    if (m > latest) latest = m;
  }
  return latest;
}

async function shouldRebuild() {
  // 0.17.6 ships with CSS injected at runtime; we don't emit bundle.css,
  // so stat only bundle.js. Assets dir presence gates separately below.
  if (!existsSync(outJs)) return true;
  if (!existsSync(assetsOut)) return true;
  const outMtime = statSync(outJs).mtimeMs;
  const srcMtime = await latestMtime(sketchDir);
  return srcMtime > outMtime;
}

async function copyAssets() {
  if (!existsSync(assetsSrc)) {
    throw new Error(
      `Excalidraw assets not found at ${assetsSrc} — did you run \`bun install\`?`,
    );
  }
  await rm(assetsOut, { recursive: true, force: true });
  await cp(assetsSrc, assetsOut, { recursive: true });
}

async function run() {
  await mkdir(sketchDir, { recursive: true });
  if (!(await shouldRebuild())) {
    process.stdout.write("[mb-sketch] bundle up-to-date\n");
    return;
  }
  const t0 = Date.now();
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: outJs,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.IS_PREACT": JSON.stringify("false"),
    },
    jsx: "automatic",
    minify: true,
    sourcemap: false,
    logLevel: "warning",
  });
  await copyAssets();
  const ms = Date.now() - t0;
  process.stdout.write(`[mb-sketch] bundle rebuilt in ${ms}ms\n`);
}

run().catch((e) => {
  process.stderr.write(`[mb-sketch] build failed: ${e.message || e}\n`);
  process.exit(1);
});
