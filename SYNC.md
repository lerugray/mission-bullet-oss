# Multi-machine sync

mission-bullet is designed so your journal content stays **private**
even when the tool itself lives in a public GitHub repo. That means
sync happens in two layers:

| Layer           | What syncs                      | Where                                |
|-----------------|---------------------------------|--------------------------------------|
| Tool code       | TypeScript, tests, README, docs | Public `mission-bullet` repo         |
| Journal content | `entries/`, `reflections/`      | **Private** repos you create         |

`entries/` and `reflections/` are gitignored in this repo on purpose
(see `.gitignore`). Pushing `mission-bullet` alone will not move your
entries between machines — you need the private content layer too.

The examples below use bash/git syntax and a placeholder path of
`~/mission-bullet/`. If you cloned somewhere else, substitute your
real path. PowerShell users on Windows can paste the same commands
into Git Bash, or translate `cd ~/mission-bullet` to
`cd "C:\path\to\mission-bullet"` and use semicolons (`;`) instead of
`&&` for sequencing.

---

## One-time setup on your primary machine (where entries already live)

### 1. Create two private GitHub repos

On [github.com/new](https://github.com/new), create two **empty** (no
README, no `.gitignore`) **private** repos:

- `mission-bullet-entries`
- `mission-bullet-reflections`

Create `mission-bullet-reflections` even if you haven't run
`bullet review week` yet — easier to set up once now.

### 2. Initialize git inside `entries/`

Replace `<your-github-username>` with your actual GitHub username:

```bash
cd ~/mission-bullet/entries
git init
git branch -M main
git add .
git commit -m "Initial entries"
git remote add origin https://github.com/<your-github-username>/mission-bullet-entries.git
git push -u origin main
```

What each line does:

- `cd ...` — drop into the entries directory.
- `git init` — make it its own git repo (separate from the outer
  mission-bullet repo).
- `git branch -M main` — name the branch `main` to match GitHub's
  default.
- `git add .` — stage every entry file.
- `git commit -m ...` — snapshot them locally.
- `git remote add origin ...` — point at your new private GitHub repo.
- `git push -u origin main` — upload and remember the link for future
  pushes.

### 3. Do the same for `reflections/`

```bash
cd ~/mission-bullet/reflections
git init
git branch -M main
git commit --allow-empty -m "Initial reflections"
git remote add origin https://github.com/<your-github-username>/mission-bullet-reflections.git
git push -u origin main
```

If the `reflections/` directory doesn't exist yet (you haven't run
`bullet review week` on any machine), skip this step for now. Come
back to it after your first weekly review generates the folder.

---

## One-time setup on a second machine

### 1. Clone the tool code (public repo)

```bash
cd ~/path/to/projects   # wherever you keep code
git clone https://github.com/<your-github-username>/mission-bullet.git
cd mission-bullet
bun install
```

(If you forked the repo, point at your fork instead.)

### 2. Replace the empty stub dirs with your private content repos

After cloning, `entries/` and `reflections/` will exist but contain
only a `.gitkeep` placeholder. Replace them with clones of your
private content repos:

```bash
cd ~/mission-bullet
rm -rf entries
git clone https://github.com/<your-github-username>/mission-bullet-entries.git entries
```

And, only if `mission-bullet-reflections` exists on GitHub:

```bash
rm -rf reflections
git clone https://github.com/<your-github-username>/mission-bullet-reflections.git reflections
```

(PowerShell equivalent: `Remove-Item entries -Recurse -Force` instead
of `rm -rf entries`.)

### 3. Copy your `.env`

Copy the `.env` file from the primary machine. This file is gitignored
by design — never commit it, never push it. Each machine needs its own
local copy.

The file format is in `.env.example`; a typical config looks like:

- `MISSION_BULLET_PROVIDER=openrouter`
- `OPENROUTER_API_KEY=sk-or-v1-...`
- `MISSION_BULLET_LLM_MODEL=anthropic/claude-sonnet-4-6`
- `MISSION_BULLET_CLAUDE_NOTE_MODEL=google/gemma-4-31b-it:free`

Simplest way to move the file over: open `.env` on the primary
machine, copy its contents, paste into a new `.env` on the second
machine at `<your-mission-bullet-path>/.env`. Done.

---

## Daily workflow — after writing

After you run `bullet today` on one machine, pick up on the other by
pushing there first, then pulling here. Both directions are **one
copy-pasteable line**.

**On the machine where you just wrote — paste, Enter:**

```bash
cd ~/mission-bullet/entries && git add . && git commit -m "update" && git push
```

**On the other machine, before you start writing:**

```bash
cd ~/mission-bullet/entries && git pull
```

The `&&` chain steps — drop into the folder, stage changes, snapshot
them, upload. `"update"` as a commit message is fine (nobody else
reads it; git records date and time automatically, so you don't need
to type today's date).

(PowerShell users: replace `&&` with `;` and quote paths with spaces.)

### Reflections (weekly/monthly reviews)

Same shape, just swap `entries` for `reflections`:

```bash
cd ~/mission-bullet/reflections && git add . && git commit -m "update" && git push
```

```bash
cd ~/mission-bullet/reflections && git pull
```

### Push both at once (entries + reflections)

If you've done both a daily entry and a weekly/monthly review, chain
the two pushes into one paste:

```bash
cd ~/mission-bullet/entries && git add . && git commit -m "update" && git push && cd ../reflections && git add . && git commit -m "update" && git push
```

Mirror pull on the other machine:

```bash
cd ~/mission-bullet/entries && git pull && cd ../reflections && git pull
```

(`../reflections` works because the first `cd` already put you inside
`mission-bullet/entries`, and `reflections` is a sibling.)

### Shortcut: a `git sync` alias (optional)

If typing the push one-liner feels repetitive, set up a git alias
**once per machine** — then the daily push shrinks to `git sync`:

```bash
git config --global alias.sync '!git add . && git commit -m "update" && git push'
```

The `--global` flag makes the alias available in every git repo on
the machine (the outer `mission-bullet`, the inner `entries`, the
inner `reflections` — all of them). After that, the daily workflow
becomes:

```bash
cd ~/mission-bullet/entries && git sync
```

Pull is already a single word, no alias needed. If the alias ever
feels wrong (e.g. you want to review the diff before committing),
just run the normal `git add/commit/push` steps instead — the alias
is additive, not a replacement.

---

## If you change the tool code

Rare, but when you do (a bug fix, a README tweak, a new feature):

```bash
cd ~/mission-bullet
git pull          # before editing, get any changes from the other machine
# ... edit files ...
git add <files>
git commit -m "..."
git push
```

Then on the other machine:

```bash
cd ~/mission-bullet
git pull
bun install       # only if package.json changed
```

---

## FAQ

### Why two private content repos instead of one?

Each gitignored directory can be its own git repo without colliding
with the outer `mission-bullet` repo — no symlinks, no junctions, no
config. Matches the pattern `.gitignore` already hints at.

If you'd rather consolidate into one private repo later (e.g.
`mission-bullet-journal` containing both `entries/` and
`reflections/`), you can, but it requires directory junctions on
Windows (`mklink /J`) or symlinks on macOS/Linux to point the two
subdirectories at a single cloned repo. Not worth the complexity for
v1.

### What about cloud-sync folders (OneDrive, Dropbox, iCloud)?

If your `mission-bullet` directory happens to live under
`~/OneDrive/Documents/` or similar, fine — but don't rely on it.
**Git is the source of truth across machines.** Cloud-sync folders
add corruption risk (file lock conflicts during git operations) and
mask the real sync state. You can move the project out of cloud-sync
without breaking anything; just update the paths in your muscle
memory.

### What if I forget to pull on the other machine and write a conflicting entry?

Different days won't conflict — each day is its own file
(`2026/04/22.md`). Same-day conflicts only happen if you write on
both machines the same day without pulling. Git will surface a
merge conflict on the next `git pull` or `git push`. If that
happens:

```bash
git pull                               # see the conflict
# open the conflicted file, pick what to keep
git add <file>
git commit -m "merge same-day entry"
git push
```

Avoidance is simpler than resolution: always `git pull` before you
start writing on a new machine.

### Can I make `mission-bullet-entries` public later?

Only if you're sure you want every entry you've ever written to be
public. The whole point is privacy — don't flip this without thinking
hard about it. If you ever need to purge content, `git filter-repo`
can remove files from history, but history on GitHub is effectively
permanent once pushed.
