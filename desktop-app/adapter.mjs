// Node-native read/write helpers for the desktop app's Electron main
// process. Duplicates a tiny, disciplined slice of what src/frontmatter.ts
// and src/entry-io.ts do — just enough to read a day's entry file, parse
// its bullet lines into the prototype's Entry[] shape, and append a new
// bullet atomically. The full library stays Bun-only; this module is
// Node-runnable so Electron can ship it directly.
//
// Raw-is-sacred invariant: the only write path here is append-only
// against the user-body region above the `<!-- mission-bullet metadata`
// anchor. Metadata is re-serialized; body bytes above the anchor are
// preserved byte-for-byte except for the appended bullet line.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const RAW_ANCHOR = "<!-- mission-bullet metadata — do not edit by hand -->";
const MONTHLY_ANCHOR = "<!-- mission-bullet monthly metadata — do not edit by hand -->";
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Alert ("!") is a task variant for bills / debts / reminders — the user
// writes them in the raw as `- ! foo`, which the parser handles as
// kind=task with isAlert=true. Capture writes the same markdown form
// so the round-trip is lossless.
const GLYPH_BY_KIND = { task: "•", note: "−", event: "○", alert: "!" };

// ---------------- frontmatter ----------------

export function splitAtAnchor(content) {
  const idx = content.indexOf(RAW_ANCHOR);
  if (idx < 0) {
    return { body: content, frontmatterBlock: null };
  }
  const body = content.slice(0, idx).replace(/\s+$/, "");
  const after = content.slice(idx + RAW_ANCHOR.length);
  const fenceStart = after.indexOf("---");
  if (fenceStart < 0) return { body, frontmatterBlock: null };
  const rest = after.slice(fenceStart + 3);
  const fenceEnd = rest.indexOf("\n---");
  if (fenceEnd < 0) return { body, frontmatterBlock: null };
  const block = rest.slice(0, fenceEnd);
  return { body, frontmatterBlock: block };
}

function parseScalarLine(line) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
  if (!m) return null;
  const key = m[1];
  const raw = m[2].trim();
  if (raw === "null" || raw === "") return [key, null];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      return [key, JSON.parse(raw)];
    } catch {
      return [key, []];
    }
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return [key, JSON.parse(raw)];
    } catch {
      return [key, raw.slice(1, -1)];
    }
  }
  return [key, raw];
}

export function parseFrontmatterBlock(block) {
  const out = {};
  for (const line of block.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const kv = parseScalarLine(s);
    if (kv) out[kv[0]] = kv[1];
  }
  return out;
}

export function emitFrontmatter(fm) {
  const lines = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined) lines.push(`${k}: null`);
    else if (Array.isArray(v)) lines.push(`${k}: ${JSON.stringify(v)}`);
    else if (typeof v === "string") {
      const needsQuote = /^[\s"'{}[\]&*!|>%@`#?-]/.test(v) || v.includes(": ");
      lines.push(`${k}: ${needsQuote ? JSON.stringify(v) : v}`);
    } else lines.push(`${k}: ${String(v)}`);
  }
  return lines.join("\n");
}

// ---------------- body → bullets ----------------

// Bullet syntax in use (matches the raw markdown the user writes + what the
// existing CLI's list.ts recognizes via TASK_REGEX):
//
//   - [x] / - [X]     task, done
//   - [ ] / - []      task, open
//   - o               event
//   - !               task (explicit-alert form — bills, debts, reminders)
//   - *               note (observation / worth-developing thought)
//   - <text>          note (plain bullet, no marker)
//
// The Claude-Design prototype also renders the glyph triad •/−/○ + the
// struck forms ✕/⊗ + migration/cancellation > and ×, so those still
// parse too — useful for the Capture-field output which writes the
// triad directly.
// Detect CLI-authored bullet annotations and peel them off so the
// rendered body shows clean prose, with provenance / strikethrough
// exposed as flags the Entry component can style semantically.
function normalizeBulletText(rawText) {
  let text = rawText;
  let status = undefined;
  let provenance = null;

  // Strip the trailing auto-mark HTML comment — always, everywhere.
  text = text.replace(/\s*<!--\s*bullet-migrate auto-mark\s*-->\s*$/, "");
  // Capture the form post-auto-mark-strip but pre-other-normalization.
  // This is what migrate-adapter's OPEN_TASK_LINE_RE captures as m[2],
  // so the renderer can use it as a verbatim lookup key when calling
  // back into source-line operations like strike. Whitespace inside
  // (e.g., the double-space some entries have between text and `(from
  // ...)`) is preserved here on purpose — the on-disk line has it,
  // and the strike rewrite must match exactly.
  const sourceKey = text;

  // `- [x] ~~foo~~` → struck (abandoned via migrate). Text was
  // `~~foo~~` after the `- [x] ` — strip the wrappers, flag status.
  const strikeMatch = text.match(/^~~(.*)~~\s*$/);
  if (strikeMatch) {
    text = strikeMatch[1];
    status = "cancelled";
  }

  // `- [x] foo (migrated to 2026-04-24)` → accepted migration,
  // forward-pointer provenance. Pull the suffix off; flag + keep.
  const migMatch = text.match(/^(.*?)\s*\(migrated to (\d{4}-\d{2}-\d{2})\)\s*$/);
  if (migMatch) {
    text = migMatch[1];
    status = "migrated";
    provenance = { kind: "migrated-to", date: migMatch[2] };
  }

  // `- [ ] foo (from 2026-04-22)` → migration destination bullet.
  // Keep as open task but expose the source date as provenance.
  const fromMatch = text.match(/^(.*?)\s*\(from (\d{4}-\d{2}-\d{2})\)\s*$/);
  if (fromMatch) {
    text = fromMatch[1];
    provenance = { kind: "migrated-from", date: fromMatch[2] };
  }

  return { text: text.trim(), status, provenance, sourceKey };
}

function parseBulletLine(line) {
  // Markdown-task forms: - [ ] text / - [] text / - [x] text
  const task = line.match(/^\s*-\s*\[([ xX]?)\]\s+(.+?)\s*$/);
  if (task) {
    const done = task[1] === "x" || task[1] === "X";
    const norm = normalizeBulletText(task[2]);
    // Struck tasks: prefer the struck flag over "done"; they're
    // abandoned, not completed. Migrated tasks: keep done=true so the
    // glyph reflects the box state, but status=migrated overrides.
    let status;
    if (norm.status === "cancelled") status = "cancelled";
    else if (norm.status === "migrated") status = "migrated";
    else if (done) status = "done";
    return {
      kind: "task",
      time: "",
      text: norm.text,
      status,
      isCheckbox: true,
      provenance: norm.provenance,
      sourceKey: norm.sourceKey,
    };
  }
  // Markdown-prefix forms: - o text / - ! text / - * text / - text
  const md = line.match(/^\s*-\s*(o|!|\*)?\s+(.+?)\s*$/);
  if (md) {
    const marker = md[1];
    const text = md[2];
    if (marker === "o") return { kind: "event", time: "", text };
    // Alert-form (`- ! text`) — a task-shaped reminder (bills, debts,
    // open commitments). Kept as kind=task for consistency with
    // migrate downstream, but flagged so the renderer shows
    // a `!` glyph instead of the generic `•`.
    if (marker === "!") return { kind: "task", time: "", text, isAlert: true };
    return { kind: "note", time: "", text };
  }
  // Claude-Design glyph triad + status variants (written by the Capture
  // flow and by any prior use of the desktop app).
  // (alert form `- ! text` parsed above; flagged so the renderer shows
  // a `!` glyph instead of the generic `•`.)
  const triad = line.match(/^\s*([•−○✕⊗>×])\s+(?:(\d{2}:\d{2})\s+)?(.+?)\s*$/);
  if (triad) {
    const glyph = triad[1];
    const time = triad[2] || "";
    const text = triad[3];
    if (glyph === "•") return { kind: "task", time, text };
    if (glyph === "−") return { kind: "note", time, text };
    if (glyph === "○") return { kind: "event", time, text };
    if (glyph === "✕") return { kind: "task", time, text, status: "done" };
    if (glyph === "⊗") return { kind: "event", time, text, status: "done" };
    if (glyph === ">") return { kind: "task", time, text, status: "migrated" };
    if (glyph === "×") return { kind: "task", time, text, status: "cancelled" };
  }
  return null;
}

function parseBodyToEntries(body, date) {
  const entries = [];
  const proseChunks = [];
  let bulletIdx = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();
    // Skip HTML comment anchors / markers, the frontmatter fence, and
    // any markdown heading. Headings are structural metadata (e.g. the
    // `## Migrated items` section header that the migrate flow writes
    // above carried-forward bullets) — they shouldn't render as a top-
    // of-day prose entry.
    if (line.startsWith("<!--") || line === "---" || line.startsWith("#")) continue;
    const b = parseBulletLine(line);
    if (b) {
      entries.push({
        id: `${date}-b${bulletIdx++}`,
        kind: b.kind,
        time: b.time,
        text: b.text,
        status: b.status,
        isCheckbox: b.isCheckbox === true,
        isAlert: b.isAlert === true,
        provenance: b.provenance ?? null,
        // Lookup key for source-line operations (e.g., strike). Only
        // populated for checkbox tasks where it's load-bearing; null
        // for everything else.
        sourceKey: b.sourceKey ?? null,
      });
    } else if (line !== "") {
      proseChunks.push(line);
    } else if (proseChunks.length && proseChunks[proseChunks.length - 1] !== "") {
      proseChunks.push("");
    }
  }
  const prose = proseChunks.join("\n").trim();
  if (prose) {
    entries.unshift({
      id: `${date}-prose`,
      kind: "note",
      time: "",
      text: prose,
      status: undefined,
    });
  }
  return entries;
}

// ---------------- day shape ----------------

function dateParts(date) {
  const [year, month, day] = date.split("-");
  return { year, month, day };
}

export function entryPath(entriesDir, date) {
  const { year, month, day } = dateParts(date);
  return join(entriesDir, year, month, `${day}.md`);
}

function isoWeekLabel(date) {
  const d = new Date(date + "T00:00:00Z");
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `W${String(week).padStart(2, "0")}`;
}

function dowLabel(date) {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
}

export async function loadDay(entriesDir, date, todayISO) {
  const path = entryPath(entriesDir, date);
  const hasFile = existsSync(path);
  let entries = [];
  if (hasFile) {
    const content = await readFile(path, "utf8");
    const { body } = splitAtAnchor(content);
    entries = parseBodyToEntries(body, date);
  }
  return {
    date,
    dow: dowLabel(date),
    weekLabel: isoWeekLabel(date),
    isToday: date === todayISO,
    entries,
  };
}

export async function loadDaysRange(entriesDir, from, to, todayISO) {
  const days = [];
  const cursor = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString().slice(0, 10);
    days.push(await loadDay(entriesDir, iso, todayISO));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

// ---------------- write ----------------

export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function easternTimeHHMM(now = new Date()) {
  return now
    .toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(/^24:/, "00:");
}

function easternTimestampISO(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const janOffset = -new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const julOffset = -new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const stdOffset = Math.min(janOffset, julOffset);
  const isDST = -now.getTimezoneOffset() > stdOffset;
  const etOffsetMinutes = isDST ? -240 : -300;
  const sign = etOffsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(etOffsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offH}:${offM}`;
}

export function defaultFrontmatter(date) {
  return {
    date,
    status: "open",
    migrated_to: [],
    sessions: [],
  };
}

export function assembleFile(body, fm) {
  const trimmedBody = body.replace(/\s+$/, "");
  return (
    (trimmedBody.length ? `${trimmedBody}\n\n` : "") +
    `${RAW_ANCHOR}\n---\n${emitFrontmatter(fm)}\n---\n`
  );
}

export async function readRawBody(entriesDir, date) {
  const path = entryPath(entriesDir, date);
  if (!existsSync(path)) return "";
  const content = await readFile(path, "utf8");
  const { body } = splitAtAnchor(content);
  return body;
}

export async function writeRawBody(entriesDir, date, newBody) {
  const path = entryPath(entriesDir, date);
  let fm;
  if (existsSync(path)) {
    const content = await readFile(path, "utf8");
    const { frontmatterBlock } = splitAtAnchor(content);
    fm = frontmatterBlock
      ? { ...defaultFrontmatter(date), ...parseFrontmatterBlock(frontmatterBlock) }
      : defaultFrontmatter(date);
  } else {
    fm = defaultFrontmatter(date);
  }
  await atomicWrite(path, assembleFile(newBody.replace(/\s+$/, ""), fm));
  return { path };
}

export async function appendBullet(entriesDir, date, kind, text) {
  const path = entryPath(entriesDir, date);
  const glyph = GLYPH_BY_KIND[kind] ?? "•";
  const time = easternTimeHHMM();
  // Actionable kinds (task / alert) use the markdown form that renders
  // as a clickable checkbox — the user captures these expecting to tick
  // them off later, and the `•` triad form isn't toggleable. Reminders
  // and tasks don't get a timestamp because "this happened at" reads
  // wrong on a forward-pointing item. Notes / events keep the triad
  // form `<glyph> <HH:MM> <text>` since those are things-as-they-
  // happen and the time is useful context.
  let newLine;
  if (kind === "task") newLine = `- [ ] ${text.trim()}`;
  else if (kind === "alert") newLine = `- ! ${text.trim()}`;
  else newLine = `${glyph} ${time} ${text.trim()}`;
  let body;
  let fm;
  if (existsSync(path)) {
    const content = await readFile(path, "utf8");
    const { body: existingBody, frontmatterBlock } = splitAtAnchor(content);
    body = existingBody;
    fm = frontmatterBlock
      ? { ...defaultFrontmatter(date), ...parseFrontmatterBlock(frontmatterBlock) }
      : defaultFrontmatter(date);
  } else {
    body = "";
    fm = defaultFrontmatter(date);
  }
  const nextBody = body ? `${body.replace(/\s+$/, "")}\n${newLine}` : newLine;
  if (!Array.isArray(fm.sessions)) fm.sessions = [];
  fm.sessions.push(easternTimestampISO());
  await atomicWrite(path, assembleFile(nextBody, fm));
  return { path, time, glyph, kind, text: text.trim() };
}

// ---------------- monthly log (mb-012 extension) ----------------

// Monthly log = `entries/YYYY/MM/monthly.md`. Same frontmatter-after-anchor
// shape as daily entries, but with a different anchor string and
// frontmatter keys (month/status/sessions — no migrated_to). Skeleton
// generation mirrors src/month.ts so a monthly log created from the
// GUI is byte-identical to one created from `bullet month`.

function monthlyLogPath(entriesDir, monthKey) {
  const m = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Invalid month key: ${monthKey}`);
  return join(entriesDir, m[1], m[2], "monthly.md");
}

function splitAtMonthlyAnchor(content) {
  const idx = content.indexOf(MONTHLY_ANCHOR);
  if (idx < 0) return { body: content, frontmatterBlock: null };
  const body = content.slice(0, idx).replace(/\s+$/, "");
  const after = content.slice(idx + MONTHLY_ANCHOR.length);
  const fenceStart = after.indexOf("---");
  if (fenceStart < 0) return { body, frontmatterBlock: null };
  const rest = after.slice(fenceStart + 3);
  const fenceEnd = rest.indexOf("\n---");
  if (fenceEnd < 0) return { body, frontmatterBlock: null };
  return { body, frontmatterBlock: rest.slice(0, fenceEnd) };
}

function monthTitle(monthKey) {
  const m = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) return monthKey;
  const name = MONTH_NAMES[Number(m[2]) - 1] ?? m[2];
  return `${name} ${m[1]}`;
}

function buildMonthlySkeleton(monthKey, sessions = []) {
  const title = monthTitle(monthKey);
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
    `${MONTHLY_ANCHOR}\n` +
    "---\n" +
    `month: ${monthKey}\n` +
    "status: open\n" +
    `sessions: ${JSON.stringify(sessions)}\n` +
    "---\n"
  );
}

function assembleMonthlyFile(body, fm) {
  const trimmedBody = body.replace(/\s+$/, "");
  return (
    (trimmedBody.length ? `${trimmedBody}\n\n` : "") +
    `${MONTHLY_ANCHOR}\n---\n${emitFrontmatter(fm)}\n---\n`
  );
}

function defaultMonthlyFrontmatter(monthKey) {
  return { month: monthKey, status: "open", sessions: [] };
}

// Read + stamp session. Matches CLI `bullet month` behavior: each
// invocation (read) appends a session stamp to the frontmatter. The
// body is returned untouched. If the file doesn't exist, creates from
// skeleton with the first session stamp.
export async function openMonthlyLog(entriesDir, monthKey) {
  const path = monthlyLogPath(entriesDir, monthKey);
  const sessionStamp = easternTimestampISO();
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, buildMonthlySkeleton(monthKey, [sessionStamp]));
  } else {
    const content = await readFile(path, "utf8");
    const { body, frontmatterBlock } = splitAtMonthlyAnchor(content);
    const fm = frontmatterBlock
      ? { ...defaultMonthlyFrontmatter(monthKey), ...parseFrontmatterBlock(frontmatterBlock) }
      : defaultMonthlyFrontmatter(monthKey);
    if (!Array.isArray(fm.sessions)) fm.sessions = [];
    fm.sessions.push(sessionStamp);
    await atomicWrite(path, assembleMonthlyFile(body, fm));
  }
  return readMonthlyLog(entriesDir, monthKey);
}

// Pure read — no session stamp. Used by re-reads after writes so we
// don't inflate sessions on every keystroke debounce.
export async function readMonthlyLog(entriesDir, monthKey) {
  const path = monthlyLogPath(entriesDir, monthKey);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf8");
  const { body, frontmatterBlock } = splitAtMonthlyAnchor(content);
  const fm = frontmatterBlock
    ? { ...defaultMonthlyFrontmatter(monthKey), ...parseFrontmatterBlock(frontmatterBlock) }
    : defaultMonthlyFrontmatter(monthKey);
  return { month: monthKey, body, frontmatter: fm, title: monthTitle(monthKey), path };
}

export async function writeMonthlyBody(entriesDir, monthKey, newBody) {
  const path = monthlyLogPath(entriesDir, monthKey);
  let fm;
  if (existsSync(path)) {
    const content = await readFile(path, "utf8");
    const { frontmatterBlock } = splitAtMonthlyAnchor(content);
    fm = frontmatterBlock
      ? { ...defaultMonthlyFrontmatter(monthKey), ...parseFrontmatterBlock(frontmatterBlock) }
      : defaultMonthlyFrontmatter(monthKey);
  } else {
    fm = defaultMonthlyFrontmatter(monthKey);
  }
  if (!Array.isArray(fm.sessions)) fm.sessions = [];
  await atomicWrite(path, assembleMonthlyFile(newBody.replace(/\s+$/, ""), fm));
  return { path };
}

// ---------------- sketch (mb-012) ----------------

// Per-day Excalidraw JSON sibling file. Lives next to DD.md /
// DD.claude.md and follows the same path convention. Monthly logs get
// one at entries/YYYY/MM/monthly.sketch.excalidraw. The raw DD.md is
// untouched — sketches are a parallel capture surface, not an annotation.
//
// The file format is Excalidraw's native JSON — round-trippable, loads
// back into the editor byte-identical. We don't try to parse or
// interpret the scene contents here; the sketch bundle owns that.

function sketchPath(entriesDir, dateOrKey) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOrKey)) {
    const { year, month, day } = dateParts(dateOrKey);
    return join(entriesDir, year, month, `${day}.sketch.excalidraw`);
  }
  // Monthly-log shape: YYYY-MM → entries/YYYY/MM/monthly.sketch.excalidraw
  const monthMatch = dateOrKey.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    return join(entriesDir, monthMatch[1], monthMatch[2], "monthly.sketch.excalidraw");
  }
  throw new Error(`sketchPath: unrecognized key "${dateOrKey}"`);
}

export async function readSketchDay(entriesDir, dateOrKey) {
  const path = sketchPath(entriesDir, dateOrKey);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    // Defense in depth: if a user hand-edits the file into something
    // non-Excalidraw, don't crash the renderer — the wrapper will treat
    // null as "start fresh".
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSketchDay(entriesDir, dateOrKey, data) {
  if (!data || typeof data !== "object") {
    throw new Error("writeSketchDay: data must be a JSON-serializable object");
  }
  const path = sketchPath(entriesDir, dateOrKey);
  // Prefer the Excalidraw spec envelope ({ type, version, source, elements,
  // appState, files }) for forward-compat with their import/export tools.
  // Callers that pass just { elements, appState, files } get the envelope
  // added here so DD.sketch.excalidraw is openable by excalidraw.com too.
  const envelope = data.type === "excalidraw"
    ? data
    : {
        type: "excalidraw",
        version: 2,
        source: "mission-bullet",
        elements: Array.isArray(data.elements) ? data.elements : [],
        appState: data.appState || {},
        files: data.files || {},
      };
  await atomicWrite(path, JSON.stringify(envelope, null, 2) + "\n");
  return { path };
}

// ---------------- directory discovery ----------------

export async function listKnownDates(entriesDir) {
  const dates = [];
  let years;
  try {
    years = await readdir(entriesDir, { withFileTypes: true });
  } catch {
    return dates;
  }
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    const yearDir = join(entriesDir, y.name);
    const months = await readdir(yearDir, { withFileTypes: true });
    for (const m of months) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      const monthDir = join(yearDir, m.name);
      const files = await readdir(monthDir);
      for (const f of files) {
        const mm = f.match(/^(\d{2})\.md$/);
        if (!mm) continue;
        dates.push(`${y.name}-${m.name}-${mm[1]}`);
      }
    }
  }
  dates.sort();
  return dates;
}

export function todayEasternISO(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function resolveProjectPaths(startDir) {
  const root = resolve(startDir);
  return {
    projectRoot: root,
    entriesDir: join(root, "entries"),
    reflectionsDir: join(root, "reflections"),
  };
}

// ---------------- image paste (per-day attachments) ----------------

// Per-day pasted images live at `entries/YYYY/MM/images/YYYY-MM-DD-N.png`.
// The full-date prefix in the filename means a stray image file can be
// dragged anywhere without losing its day association — useful for
// future "where did this image come from?" forensics.
//
// Markdown inserted into the entry body uses the relative form
// `./images/YYYY-MM-DD-N.png` so the link resolves correctly no matter
// where the entries directory is mounted.

const IMAGE_EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

function imagesDirForDate(entriesDir, date) {
  const { year, month } = dateParts(date);
  return join(entriesDir, year, month, "images");
}

// Find the next available `YYYY-MM-DD-N.{ext}` filename. Walks the
// month's images directory once and picks max-N + 1 so an interrupted
// paste mid-flight can't clobber a prior image.
async function nextImagePath(entriesDir, date, ext) {
  const dir = imagesDirForDate(entriesDir, date);
  await mkdir(dir, { recursive: true });
  let existing;
  try {
    existing = await readdir(dir);
  } catch {
    existing = [];
  }
  const prefix = `${date}-`;
  let maxN = 0;
  for (const f of existing) {
    if (!f.startsWith(prefix)) continue;
    const m = f.slice(prefix.length).match(/^(\d+)\./);
    if (m) {
      const n = Number(m[1]);
      if (n > maxN) maxN = n;
    }
  }
  const filename = `${date}-${maxN + 1}.${ext}`;
  return { path: join(dir, filename), filename };
}

// Save a pasted-clipboard image. Renderer sends the image as a base64
// payload + mime type; this function writes the bytes atomically and
// returns the relative path the renderer can paste into the entry as
// markdown.
export async function saveImageForDate(entriesDir, date, dataBase64, mimeType) {
  const ext = IMAGE_EXT_BY_MIME[mimeType] || "png";
  const { path, filename } = await nextImagePath(entriesDir, date, ext);
  const buffer = Buffer.from(dataBase64, "base64");
  // Atomic-write pattern: tmp + rename, same shape as text writes.
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, buffer);
  await rename(tmp, path);
  return {
    path,
    filename,
    relativePath: `./images/${filename}`,
  };
}

// Read a per-day image and return it as a data URL the renderer can
// drop directly into an <img src=...>. The path comes in as either
// `./images/foo.png` (markdown-relative) or just `images/foo.png`.
// Anything that escapes the per-month images directory is rejected.
export async function readImageForDate(entriesDir, date, relativePath) {
  const { year, month } = dateParts(date);
  const monthDir = join(entriesDir, year, month);
  const cleaned = relativePath.replace(/^\.\//, "");
  if (cleaned.includes("..") || cleaned.includes("\0")) {
    throw new Error(`readImageForDate: rejected path ${relativePath}`);
  }
  const fullPath = join(monthDir, cleaned);
  if (!fullPath.startsWith(monthDir)) {
    throw new Error(`readImageForDate: path escape ${relativePath}`);
  }
  if (!existsSync(fullPath)) return null;
  const buf = await readFile(fullPath);
  const ext = (cleaned.split(".").pop() || "png").toLowerCase();
  const mimeByExt = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  const mime = mimeByExt[ext] || "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// ---------------- weekly reflection (mb-005 wire-up) ----------------

// ISO 8601 week number of a date. Mirrors src/isoweek.ts so the
// desktop app and the CLI agree on which file `bullet review week`
// would produce for a given date.
export function isoWeekOfDate(isoDate) {
  const d = new Date(isoDate + "T00:00:00Z");
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { year: target.getUTCFullYear(), week };
}

function reflectionWeekPath(reflectionsDir, year, week) {
  return join(reflectionsDir, `${year}-W${String(week).padStart(2, "0")}.md`);
}

const REFLECTION_ANCHOR =
  "<!-- mission-bullet reflection metadata — do not edit by hand -->";

function splitAtReflectionAnchor(content) {
  const idx = content.indexOf(REFLECTION_ANCHOR);
  if (idx < 0) return { body: content, frontmatterBlock: null };
  const body = content.slice(0, idx).replace(/\s+$/, "");
  const after = content.slice(idx + REFLECTION_ANCHOR.length);
  const fenceStart = after.indexOf("---");
  if (fenceStart < 0) return { body, frontmatterBlock: null };
  const rest = after.slice(fenceStart + 3);
  const fenceEnd = rest.indexOf("\n---");
  if (fenceEnd < 0) return { body, frontmatterBlock: null };
  return { body, frontmatterBlock: rest.slice(0, fenceEnd) };
}

// Reads a weekly reflection file produced by `bullet review week`.
// Returns null when the file doesn't exist (the common case until the user
// runs their first weekly review). Themes and migrations come from the
// frontmatter (structured, reliable); user notes come from the body's
// "## Your reflection notes" section.
export async function readWeeklyReflection(reflectionsDir, year, week) {
  const path = reflectionWeekPath(reflectionsDir, year, week);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf8");
  const { body, frontmatterBlock } = splitAtReflectionAnchor(content);
  const fm = frontmatterBlock ? parseFrontmatterBlock(frontmatterBlock) : {};
  const userNotesHeader = "## Your reflection notes";
  const userNotesIdx = body.indexOf(userNotesHeader);
  const userNotes = userNotesIdx >= 0
    ? body.slice(userNotesIdx + userNotesHeader.length).replace(/^\s+/, "")
    : "";
  return {
    year,
    week,
    weekSpec: `${year}-W${String(week).padStart(2, "0")}`,
    startDate: typeof fm.start_date === "string" ? fm.start_date : null,
    endDate: typeof fm.end_date === "string" ? fm.end_date : null,
    entriesReviewed: Array.isArray(fm.entries_reviewed) ? fm.entries_reviewed : [],
    themes: Array.isArray(fm.themes_surfaced) ? fm.themes_surfaced : [],
    migrations: Array.isArray(fm.migrations_proposed) ? fm.migrations_proposed : [],
    userNotes,
    path,
  };
}

// Reads a monthly reflection file produced by `bullet review month`.
// Mirror of readWeeklyReflection — same anchor + frontmatter shape;
// the file just lives at `reflections/YYYY-MM.md` instead of
// `reflections/YYYY-WNN.md`. Themes/migrations from frontmatter,
// user notes from the body's "## Your reflection notes" section.
export async function readMonthlyReflection(reflectionsDir, monthSpec) {
  const m = monthSpec.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Invalid month spec: ${monthSpec}`);
  const path = join(reflectionsDir, `${monthSpec}.md`);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf8");
  const { body, frontmatterBlock } = splitAtReflectionAnchor(content);
  const fm = frontmatterBlock ? parseFrontmatterBlock(frontmatterBlock) : {};
  const userNotesHeader = "## Your reflection notes";
  const userNotesIdx = body.indexOf(userNotesHeader);
  const userNotes = userNotesIdx >= 0
    ? body.slice(userNotesIdx + userNotesHeader.length).replace(/^\s+/, "")
    : "";
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    monthSpec,
    startDate: typeof fm.start_date === "string" ? fm.start_date : null,
    endDate: typeof fm.end_date === "string" ? fm.end_date : null,
    entriesReviewed: Array.isArray(fm.entries_reviewed) ? fm.entries_reviewed : [],
    themes: Array.isArray(fm.themes_surfaced) ? fm.themes_surfaced : [],
    migrations: Array.isArray(fm.migrations_proposed) ? fm.migrations_proposed : [],
    userNotes,
    path,
  };
}
