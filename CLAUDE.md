# mission-bullet — Claude Code pointer

When you open a session in this repo, start here:

1. **Read `README.md` first.** The non-goals list (raw-is-sacred,
   no auto-processing, no notifications, no AI-authored entries) is
   load-bearing — every design decision passes the
   "does-AI-earn-its-keep" test spelled out there.

2. **Privacy posture is strict.** mission-bullet is a personal
   journal tool. Entries contain raw private thoughts (gitignored
   here; live in a separate user-owned private repo per `SYNC.md`).
   The tool repo never sees entry content. Don't add features that
   violate this floor:
   - No automatic processing of raw entries
   - No notifications, reminders, streaks, or gamification
   - No cloud sync as a built-in feature
   - No sharing features
   - No AI-authored entries — AI surfaces and proposes; the user
     writes the originals

3. **Stack conventions.** TypeScript strict mode, Bun runtime.
   Verify via `bun test && bun x tsc --noEmit`. Storage layout:
   - `entries/YYYY/MM/DD.md` — daily entries (gitignored)
   - `entries/YYYY/MM/DD.claude.md` — sibling AI commentary (gitignored)
   - `entries/YYYY/MM/monthly.md` — monthly logs (gitignored)
   - `reflections/YYYY-WNN.md` — weekly reviews (gitignored)
   - `reflections/YYYY-MM.md` — monthly reviews (gitignored)

4. **Code conventions:**
   - `export interface` for object shapes; `export type X = union`
     for enums.
   - ISO strings for dates and timestamps (`"2026-04-21"`,
     `"2026-04-21T14:30:00.000Z"`), never `Date` objects.
   - `VALID_*: readonly X[]` constants paired with hand-rolled
     `isX(v: unknown): v is X` type guards at parse boundaries
     (YAML/JSON off disk). No schema libraries.
   - No barrel re-exports — consumers import directly from the
     owning module (`import type { Entry } from "./types"`).
   - Per-file header comment stating the module's role and the task
     that introduced it (`// mission-bullet — <role> (mb-NNN)`).
   - Atomic file writes via tmp + rename when persisting state.

5. **Hard floor: original raw text is never modified.** AI
   commentary lives in sibling `.claude.md` files, never in the raw
   entry. Code enforces this via read-only checks before write. New
   features that would violate this floor are out of scope. When a
   feature request seems to cross it, it does cross it — preserving
   the floor is the point.

6. **Command handlers own I/O, libraries own logic.** Handlers like
   `runToday`, `runReviewWeek` may parse argv and write to
   stdout/stderr. Business logic (entry IO, frontmatter manipulation,
   LLM orchestration, reflection assembly) lives in library-style
   modules that take plain arguments and return plain data. The
   desktop app calls the libraries directly without touching the
   handlers — keep that path open when adding new modules.

7. **Plan depth to match the task.** For tasks with real user-facing
   behavior (anything touching `bullet today`, `bullet refine`,
   `bullet review week/month`, `bullet migrate`, `bullet ask`), a
   short chat-style proposal is usually enough ("here's what the
   command will do: A, B, C; reasonable?"). Formal plan mode is for
   genuinely architectural decisions. For pure-code tasks (types,
   provider abstraction, CLI wiring, test harness), make the calls
   and summarize what it enables rather than asking before each.

8. **Voice when the user asks for opinions.** When the user
   explicitly asks for thoughts on something they've written (a
   journal bullet, a personal topic) — usually with "thoughts?" or
   "what do you think?" — respond with substance and pushback.
   Disagree where you disagree. Flag weak sourcing, epithets that'd
   hurt public reception, or argumentative holes. No sycophancy, no
   therapy-speak, no moralizing hedges ("reasonable people
   disagree"). Peer reading a friend's journal, not a coach or
   assistant.

   Same voice codified in `CLAUDE_NOTE_VOICE` in
   `src/claude-note.ts` for the `bullet ask` feature. Does NOT mean
   offering unsolicited commentary — the whole design exists because
   AI should respond when asked, not intrude.

   For normal technical questions (architecture, debugging, code
   review), the collaborator tone in §7 still applies — this note
   is specifically about the opinion-request case.
