// app.jsx — mission-bullet main app (desktop).
//
// Divergences from the Claude Design prototype:
//   - Loads days asynchronously from `window.missionBullet.loadDays()`
//     (IPC into the Electron main). SEED_DAYS is still present as a
//     fallback if IPC fails — useful for design-time preview, harmless
//     in the wired-up case.
//   - Capture commits via `window.missionBullet.saveEntry(...)` and
//     refetches the current window. The main process handles git
//     auto-commit + background push (debounced).
//   - The weekly / monthly / themes views still render canned data
//     for now. Real wiring lands in later phases.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

/*
 * EditDayPane — the in-app notepad.
 *
 * Two type registers the user can toggle between:
 *   - "raw" (default, mono)  → 13.5px mono, good for inspecting markdown
 *                              syntax, HTML comments, exact whitespace.
 *   - "prose" (serif)        → 16.5px serif, feels like writing on paper;
 *                              for longform journaling where glyphs and
 *                              metadata are visual noise.
 *
 * The choice persists in localStorage (mb-edit-font) so you only pick
 * once. The toolbar inserts canonical bullet prefixes at the caret —
 * newline-aware so pressing "task" mid-sentence starts a new line rather
 * than corrupting prose.
 */
const EDIT_FONT_KEY = 'mb-edit-font';

function insertAtCaret(ta, text) {
  // Use setRangeText when available so undo history stays coherent; fall
  // back to execCommand('insertText') for older engines. Both preserve
  // the textarea's undo stack better than value = newValue + selection
  // reset, which wipes undo.
  if (typeof ta.setRangeText === 'function') {
    const start = ta.selectionStart;
    ta.setRangeText(text, start, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    ta.focus();
    document.execCommand('insertText', false, text);
  }
}

function insertBulletPrefix(ta, prefix) {
  if (!ta) return;
  const { selectionStart, value } = ta;
  const atLineStart = selectionStart === 0 || value[selectionStart - 1] === '\n';
  const snippet = atLineStart ? prefix : '\n' + prefix;
  insertAtCaret(ta, snippet);
  ta.focus();
}

function EditDayPane({ date, value, onChange, innerRef, onSave, onExit, onCancel }) {
  const [fontMode, setFontMode] = useState(() => {
    try { return localStorage.getItem(EDIT_FONT_KEY) || 'raw'; }
    catch (_) { return 'raw'; }
  });
  useEffect(() => {
    try { localStorage.setItem(EDIT_FONT_KEY, fontMode); } catch (_) {}
  }, [fontMode]);

  const handleKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onExit();
    }
  };

  const isProse = fontMode === 'prose';
  const fontFamily = isProse ? 'var(--serif)' : 'var(--mono)';
  const fontSize = isProse ? '16.5px' : '13.5px';
  const lineHeight = isProse ? '1.75' : '1.65';
  const padding = isProse ? '28px 36px' : '18px 22px';
  const bg = 'var(--bg-panel)';

  const insert = (prefix) => insertBulletPrefix(innerRef.current, prefix);

  const charCount = value.length;
  const lineCount = value ? value.split('\n').length : 0;

  return (
    <div style={{ margin: '18px 0 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 10 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
          Editing — {date}
        </div>
        <div style={{ flex: 1 }} />
        <div
          role="group"
          aria-label="insert bullet"
          style={{ display: 'flex', gap: 2, fontFamily: 'var(--mono)', fontSize: '10.5px', letterSpacing: '0.06em', textTransform: 'uppercase' }}
        >
          {[
            { label: 'task',  prefix: '- [ ] ', title: 'insert "- [ ] " (open task)' },
            { label: 'alert', prefix: '- ! ',   title: 'insert "- ! " (priority / reminder)' },
            { label: 'event', prefix: '- o ',   title: 'insert "- o " (event)' },
            { label: 'idea',  prefix: '- * ',   title: 'insert "- * " (observation / idea)' },
            { label: 'note',  prefix: '- ',     title: 'insert "- " (plain note)' },
          ].map(({ label, prefix, title }) => (
            <button
              key={label}
              type="button"
              onClick={() => insert(prefix)}
              title={title}
              style={{
                appearance: 'none',
                background: 'transparent',
                border: '1px solid var(--rule)',
                color: 'var(--ink-muted)',
                padding: '3px 8px',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                letterSpacing: 'inherit',
                textTransform: 'inherit',
                cursor: 'pointer',
                borderRadius: 2,
              }}
            >{label}</button>
          ))}
        </div>
        <div
          role="radiogroup"
          aria-label="font mode"
          style={{ display: 'flex', border: '1px solid var(--rule)', borderRadius: 2, overflow: 'hidden' }}
        >
          {['raw', 'prose'].map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={fontMode === m}
              onClick={() => setFontMode(m)}
              title={m === 'raw' ? 'monospace — see raw markdown' : 'serif — paper-feel writing'}
              style={{
                appearance: 'none',
                background: fontMode === m ? 'var(--accent)' : 'transparent',
                color: fontMode === m ? '#fff' : 'var(--ink-muted)',
                border: 0,
                padding: '3px 10px',
                fontFamily: 'var(--mono)',
                fontSize: '10.5px',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >{m}</button>
          ))}
        </div>
      </div>
      <textarea
        ref={innerRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        spellCheck="true"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          minHeight: 'calc(100vh - 280px)',
          fontFamily,
          fontSize,
          lineHeight,
          padding,
          background: bg,
          color: 'var(--ink-body)',
          border: '1px solid var(--rule)',
          borderRadius: 4,
          outline: 'none',
          resize: 'vertical',
          transition: 'font-family 120ms ease, font-size 120ms ease, padding 120ms ease',
        }}
        placeholder={isProse
          ? "Write freely — a paragraph, a stream, a bullet list, whatever. The bullet buttons above add shorthand when you want it."
          : "- [ ] a task\n- ! an alert / reminder\n- o an event\n- * an observation worth keeping\n- a plain note\n"}
      />
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          onClick={onSave}
          style={{ fontFamily: 'var(--mono)', fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 14px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}
        >Save</button>
        <button
          onClick={onCancel}
          style={{ fontFamily: 'var(--mono)', fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 14px', background: 'transparent', color: 'var(--ink-muted)', border: '1px solid var(--rule)', borderRadius: 3, cursor: 'pointer' }}
        >Cancel</button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: '10px', color: 'var(--ink-faint)' }}>
          ⌘/ctrl+s save · esc save+exit · cancel discards
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>
          {lineCount} line{lineCount === 1 ? '' : 's'} · {charCount} char{charCount === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "typePair": "iowan",
  "gutter": 32,
  "gridStep": 10,
  "accent": "#7a3b1e",
  "measure": 720
}/*EDITMODE-END*/;

function useApplyTokens(t) {
  useEffect(() => {
    const r = document.documentElement;
    r.setAttribute('data-type', t.typePair);
    r.style.setProperty('--gutter', t.gutter + 'px');
    r.style.setProperty('--grid-step', t.gridStep + 'px');
    r.style.setProperty('--accent', t.accent);
    r.style.setProperty('--measure', t.measure + 'px');
    const tint = accentTint(t.accent);
    r.style.setProperty('--accent-tint', tint);
  }, [t.typePair, t.gutter, t.gridStep, t.accent, t.measure]);
}

function accentTint(hex) {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return '#f3e7db';
  const [r, g, b] = m.map(x => parseInt(x, 16));
  const mix = (c, p) => Math.round(c + (253 - c) * p);
  const mr = mix(r, 0.8), mg = mix(g, 0.78), mb = mix(b, 0.75);
  return '#' + [mr, mg, mb].map(x => x.toString(16).padStart(2, '0')).join('');
}

function formatDateLabel(day) {
  const d = new Date(day.date + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function useTweaksShim(defaults) {
  const [values, setValues] = React.useState(defaults);
  const setTweak = React.useCallback((key, val) => {
    setValues((prev) => ({ ...prev, [key]: val }));
  }, []);
  return [values, setTweak];
}

const MONTH_NAMES_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLongTitle(monthKey) {
  const m = monthKey && monthKey.match && monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) return monthKey || '';
  return `${MONTH_NAMES_LONG[Number(m[2]) - 1]} ${m[1]}`;
}

function shiftMonth(monthKey, dir) {
  const m = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!m) return monthKey;
  let year = Number(m[1]);
  let month = Number(m[2]) + dir;
  while (month < 1) { year -= 1; month += 12; }
  while (month > 12) { year += 1; month -= 12; }
  return `${year}-${String(month).padStart(2, '0')}`;
}

function currentMonthKey() {
  // Eastern-time-ish: use client locale, month picker doesn't need
  // exact timezone discipline. Day-scoped content (entries, sessions)
  // is stamped server-side where it matters.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/*
 * MonthlyLogView — the desktop equivalent of `bullet month`.
 *
 * Reads entries/YYYY/MM/monthly.md (Carroll's month-scale planning
 * artifact: Calendar, Goals, Bills), renders the raw markdown body in
 * a readable view, and wires an edit-mode textarea via the same
 * EditDayPane used by daily entries. Navigation is month-at-a-time via
 * ← / → arrows at the App keyboard level.
 *
 * Session-stamp rhythm matches the CLI: reading the tab does NOT
 * stamp (you might just be browsing); entering edit mode DOES stamp
 * (that's when you're "working on" the log). The result: `sessions`
 * in the frontmatter reflects intent to plan, not mere navigation.
 *
 * Sketch support: each monthly log has a sibling
 * entries/YYYY/MM/monthly.sketch.excalidraw. The "Sketch" affordance
 * in the toolbar flips the view to a SketchView keyed by month.
 */
// Render-mode polish for monthly log body. The skeleton seeds each
// section with an HTML comment explaining what belongs there — that's
// helpful when editing ("wait, what goes in Bills?") but noisy when
// reading a filled-in log. Strip comments for view mode only; edit
// mode still shows them verbatim so the scaffolding stays available.
// Also collapses runs of 3+ blank lines left behind after stripping.
function cleanMonthlyBodyForView(body) {
  if (typeof body !== 'string' || !body) return '';
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// GFM task-list syntax: `- [ ] text` (open) or `- [x]` / `- [X]` (done).
// Captures leading bullet marker, the box state, and the task text so
// the view-mode renderer can swap the box for an interactive checkbox
// and strike-through the text when done.
const MONTHLY_TASK_RE = /^(\s*-\s*)\[([ xX])\](\s+)(.+)$/;

/*
 * MonthlyBodyRenderer — paper-feel rendering of the monthly log body
 * with two affordances the raw <pre> didn't have:
 *   - Task lines (`- [ ] ...`) render with a real <input type="checkbox">
 *     that you can click to toggle without entering edit mode.
 *   - HTML comments from the skeleton are stripped (see
 *     cleanMonthlyBodyForView).
 * All non-task lines render as-is in the same serif register the old
 * <pre> used. Whitespace is preserved so section headers and blank
 * lines keep the visual rhythm.
 */
function MonthlyBodyRenderer({ body, onToggleTask }) {
  const lines = body.split('\n');
  return (
    <div style={{
      fontFamily: 'var(--serif)',
      fontSize: '16px',
      lineHeight: '1.75',
      whiteSpace: 'pre-wrap',
      wordWrap: 'break-word',
      padding: '24px 32px',
      background: 'var(--bg-panel)',
      color: 'var(--ink-body)',
      border: '1px solid var(--rule)',
      borderRadius: 4,
      margin: 0,
    }}>
      {lines.map((line, i) => {
        const m = line.match(MONTHLY_TASK_RE);
        if (m) {
          const isDone = m[2] === 'x' || m[2] === 'X';
          const leader = m[1];      // indent + "- "
          const taskText = m[4];    // the rest
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span>{leader}</span>
              <input
                type="checkbox"
                checked={isDone}
                onChange={() => onToggleTask(taskText, isDone)}
                style={{
                  cursor: 'pointer',
                  accentColor: 'var(--accent)',
                  transform: 'translateY(2px)',
                }}
                title={isDone ? 'click to mark open' : 'click to mark done'}
              />
              <span style={{
                textDecoration: isDone ? 'line-through' : 'none',
                color: isDone ? 'var(--ink-faint)' : 'var(--ink-body)',
              }}>
                {taskText}
              </span>
            </div>
          );
        }
        // Non-empty non-task lines render verbatim; empty lines get a
        // non-breaking space so the flex/block layout preserves the
        // vertical rhythm. Without this, empty lines collapse to zero
        // height under default CSS.
        return <div key={i}>{line || ' '}</div>;
      })}
    </div>
  );
}

function MonthlyLogView({
  monthKey,
  monthly,
  loading,
  error,
  editing,
  editingBody,
  setEditingBody,
  editingRef,
  saveLabel,
  onEnterEdit,
  onSaveEdit,
  onExitEdit,
  onNavigateMonth,
  onOpenSketch,
  onToggleTask,
  reflection,
  reflectionLoading,
  reviewRunning,
  onRunReview,
}) {
  const title = monthly?.title || monthLongTitle(monthKey);
  const rawBody = monthly?.body || '';
  const body = rawBody;
  const viewBody = cleanMonthlyBodyForView(rawBody);
  const sessions = Array.isArray(monthly?.frontmatter?.sessions)
    ? monthly.frontmatter.sessions
    : [];

  if (editing) {
    return (
      <div>
        <div style={{ marginBottom: 10, fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
          Monthly log · {title}
        </div>
        <EditDayPane
          date={monthKey}
          value={editingBody}
          onChange={setEditingBody}
          innerRef={editingRef}
          onSave={onSaveEdit}
          onExit={() => onExitEdit(true)}
          onCancel={() => onExitEdit(false)}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', padding: '40px 0', textAlign: 'center' }}>
          loading monthly log…
      </div>
    );
  }

  const navBtn = {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--rule)',
    color: 'var(--ink-muted)',
    padding: '3px 10px',
    fontFamily: 'var(--mono)',
    fontSize: '10.5px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    borderRadius: 2,
  };
  const primaryBtn = {
    ...navBtn,
    background: 'var(--accent)',
    color: '#fff',
    borderColor: 'var(--accent)',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
          Monthly log · {title}
        </div>
        <button type="button" onClick={() => onNavigateMonth(-1)} title="previous month (←)" style={navBtn}>←&nbsp;prev</button>
        <button type="button" onClick={() => onNavigateMonth(1)} title="next month (→)" style={navBtn}>next&nbsp;→</button>
        <div style={{ flex: 1 }} />
        {saveLabel && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>
            {saveLabel}
          </span>
        )}
        <button type="button" onClick={onOpenSketch} title="open the sketch for this month" style={navBtn}>
          Sketch
        </button>
        <button type="button" onClick={onEnterEdit} title="edit this monthly log (e)" style={primaryBtn}>
          Edit&nbsp;·&nbsp;e
        </button>
      </div>
      {error && (
        <div role="alert" style={{ padding: '10px 14px', background: 'var(--accent)', color: '#fff', fontSize: '11px', borderRadius: 3, marginBottom: 10 }}>
          {error}
        </div>
      )}
      {onRunReview && (
        <MonthlyReviewPanel
          reflection={reflection}
          monthSpec={monthKey}
          loading={reflectionLoading}
          running={reviewRunning}
          onRunReview={onRunReview}
        />
      )}
      <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', margin: '8px 0 10px' }}>
        Monthly log · Calendar / Goals / Bills
      </div>
      {viewBody ? (
        <MonthlyBodyRenderer body={viewBody} onToggleTask={onToggleTask} />
      ) : (
        <div className="muted" style={{ padding: '40px 0', textAlign: 'center', fontStyle: 'italic', fontSize: '14px' }}>
          No log for {title} yet — press <kbd>e</kbd> to start one. The template
          seeds Calendar / Goals / Bills sections; edit however you like.
        </div>
      )}
      <p className="muted" style={{ fontSize: '12px', marginTop: 16, fontStyle: 'italic' }}>
        {sessions.length > 0
          ? `${sessions.length} session${sessions.length === 1 ? '' : 's'} on this log · last ${sessions[sessions.length - 1]}`
          : 'No sessions yet — opening edit mode will log one.'}
        {' · '}<kbd>←</kbd>/<kbd>→</kbd> prev/next month · <kbd>e</kbd> edit · <kbd>esc</kbd> back to daily
      </p>
    </div>
  );
}

/*
 * SketchView — full-canvas Excalidraw surface for a given day (mb-012).
 *
 * The Excalidraw React tree lives in a separate bundle (sketch/bundle.js
 * — built via desktop-app/build-sketch.mjs) because it needs esbuild to
 * resolve the @excalidraw/excalidraw package's CJS / CSS / asset
 * imports. The bundle exposes `window.MBSketch.mount(hostEl, {...})`.
 * We imperatively mount it into a ref'd div, pass the current day's
 * JSON as initialData, and receive canvas changes through onChange.
 *
 * Save rhythm matches the text editor: debounce 1.5s after the last
 * change, then write the Excalidraw JSON atomically and queue a git
 * commit. On day-switch or tab-switch we flush any pending save
 * immediately so nothing gets dropped.
 */
function SketchView({ date, scope = 'day', dark = false }) {
  const hostRef = useRef(null);
  const handleRef = useRef(null);
  const saveTimerRef = useRef(null);
  const latestDataRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveLabel, setSaveLabel] = useState('');

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const data = latestDataRef.current;
    if (!data || !window.missionBullet?.writeSketch) return;
    try {
      setSaveLabel('saving…');
      await window.missionBullet.writeSketch({ date, data });
      setSaveLabel('saved · git sync queued');
      setTimeout(() => setSaveLabel((cur) => cur === 'saved · git sync queued' ? '' : cur), 2000);
    } catch (e) {
      setError(`Save failed — ${e?.message || e}`);
      setSaveLabel('');
    }
  }, [date]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { flushSave(); }, 1500);
  }, [flushSave]);

  useEffect(() => {
    if (!date) return undefined;
    if (!window.MBSketch) {
      setError('Sketch bundle not loaded — run `bun run build:sketch` and restart the app.');
      setLoading(false);
      return undefined;
    }
    if (!window.missionBullet?.readSketch) {
      setError('Sketch backend unavailable — restart via `bun run ui`.');
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    latestDataRef.current = null;
    (async () => {
      let data = null;
      try {
        data = await window.missionBullet.readSketch({ date });
      } catch (e) {
        if (cancelled) return;
        setError(`Read failed — ${e?.message || e}`);
        setLoading(false);
        return;
      }
      if (cancelled || !hostRef.current) return;
      try {
        // Theme comes from the parent via prop. Reading the
        // `data-theme` attribute here used to look right but raced
        // App's useEffect — child effects fire before parent effects,
        // so the attribute could still be unset when the canvas
        // mounted, leaving Excalidraw stuck in light mode under a dark
        // app. If the user toggles dark mode while the sketch view is open,
        // the canvas keeps its initial theme until they leave and come
        // back — acceptable tradeoff vs hot-swapping Excalidraw mid-
        // session, since the dark prop isn't in this effect's deps.
        handleRef.current = window.MBSketch.mount(hostRef.current, {
          initialData: data || null,
          theme: dark ? 'dark' : 'light',
          onChange: (payload) => {
            // Guard: Excalidraw fires onChange on every mount with the
            // seed elements. Don't treat that first fire as a "dirty"
            // state worth saving — we'd be re-saving identical content.
            // We just cache; debounce smooths out the real edits.
            latestDataRef.current = payload;
            scheduleSave();
          },
        });
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(`Mount failed — ${e?.message || e}`);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Flush any pending edit synchronously on teardown so day-switch /
      // view-switch never drops strokes. fire-and-forget — we're mid-
      // unmount and can't await.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const data = latestDataRef.current;
        if (data && window.missionBullet?.writeSketch) {
          window.missionBullet.writeSketch({ date, data }).catch(() => {});
        }
      }
      if (handleRef.current) {
        try { handleRef.current.unmount(); } catch (_) {}
        handleRef.current = null;
      }
      latestDataRef.current = null;
    };
  }, [date, scheduleSave]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
          Sketch · {date}{loading ? ' · loading…' : ''}
        </div>
        <div style={{ flex: 1 }} />
        {saveLabel && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>
            {saveLabel}
          </span>
        )}
      </div>
      {error && (
        <div role="alert" style={{ padding: '10px 14px', background: 'var(--accent)', color: '#fff', fontSize: '11px', borderRadius: 3, marginBottom: 10 }}>
          {error}
        </div>
      )}
      <div
        ref={hostRef}
        style={{
          position: 'relative',
          width: '100%',
          height: 'calc(100vh - 220px)',
          minHeight: 420,
          border: '1px solid var(--rule)',
          borderRadius: 4,
          overflow: 'hidden',
          background: 'var(--bg-panel)',
        }}
      />
      <p className="muted" style={{ fontSize: '13.5px', marginTop: 14, fontStyle: 'italic', maxWidth: 640 }}>
        {scope === 'month'
          ? <>Monthly sketch — saves as <code>monthly.sketch.excalidraw</code> next to the monthly log. ← / → switch months. Snap-to-grid is on so layouts align.</>
          : <>Sketches save as <code>DD.sketch.excalidraw</code> next to the raw entry; the raw text is untouched. No AI reads or writes this surface. ← / → switch days. Snap-to-grid is on so game-design grids align.</>}
      </p>
    </div>
  );
}

function App() {
  const [t, setTweak] = (window.useTweaks ?? useTweaksShim)(TWEAK_DEFAULTS);
  useApplyTokens(t);

  // Dark mode — persisted via localStorage so the user's choice survives
  // relaunches. Separate from the tweaks system because it's user-
  // facing in production, not a dev-mode knob. The `data-theme`
  // attribute swaps the whole CSS-variable palette; no component
  // needs a dark-specific branch.
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem('mb-dark-mode') === '1'; }
    catch (_) { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('mb-dark-mode', dark ? '1' : '0'); } catch (_) {}
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Only seed the fake SEED_DAYS data in dev mode (TweaksPanel visible).
  // In normal use we start with an empty array so a loadDays failure
  // doesn't leave the user staring at a stranger's fake journal entries
  // — they see a clean "failed to load entries" state instead.
  const [days, setDays] = useState(() => (
    window.missionBulletDev
      ? SEED_DAYS.map(d => ({ ...d, entries: d.entries.slice() }))
      : []
  ));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [syncLabel, setSyncLabel] = useState('');
  // Persistent error surface — separate from the transient syncLabel
  // ("saving…", "saved · git sync queued") because a real save/read
  // failure deserves to stay on screen until acknowledged, not auto-fade.
  const [errorMessage, setErrorMessage] = useState(null);

  const todayIdx = useMemo(() => {
    const idx = days.findIndex(d => d.isToday);
    return idx >= 0 ? idx : days.length - 1;
  }, [days]);
  const [activeDayIdx, setActiveDayIdx] = useState(todayIdx);
  const [daysRev, setDaysRev] = useState(0);

  // Refs mirror days / activeDayIdx so the (intentionally stable)
  // refetchDays callback can read current values without taking them
  // as deps. This lets us preserve the user's position on older days across
  // background refetches (toggle, save, sync) instead of
  // snapping back to today every time the array is replaced.
  const daysRef = useRef(days);
  const activeDayIdxRef = useRef(activeDayIdx);
  const hasAnchoredRef = useRef(false);
  useEffect(() => { daysRef.current = days; }, [days]);
  useEffect(() => { activeDayIdxRef.current = activeDayIdx; }, [activeDayIdx]);

  const [view, setView] = useState('daily');
  const [selectedEntryId, setSelectedEntryId] = useState(null);
  const [kind, setKind] = useState('task');
  const [newId, setNewId] = useState(null);
  const [shortcutsVisible, setShortcutsVisible] = useState(true);
  // Zen mode hides the top nav + shortcut bar so the daily entries +
  // capture field are the only chrome on screen. Matches the project
  // thesis ("the journal does not call for attention") at its
  // strongest. Toggle with `z`; Esc also exits.
  const [zenMode, setZenMode] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingBody, setEditingBody] = useState('');
  const [originalBody, setOriginalBody] = useState('');
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Monthly-log state. The log is a full-month artifact, not a per-day
  // one, so it lives in its own state slice independent of days[]. Same
  // read/edit/save rhythm as daily; session stamp is added only when
  // the user enters edit mode (see enterMonthlyEdit) so mere browsing
  // doesn't inflate the sessions array.
  const [monthKey, setMonthKey] = useState(() => currentMonthKey());
  const [monthly, setMonthly] = useState(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);
  const [monthlyError, setMonthlyError] = useState(null);
  const [monthlyEditing, setMonthlyEditing] = useState(false);
  const [monthlyEditingBody, setMonthlyEditingBody] = useState('');
  const [monthlyOriginalBody, setMonthlyOriginalBody] = useState('');
  const [monthlySaveLabel, setMonthlySaveLabel] = useState('');
  // Sketch scope: 'day' means the SketchView reads/writes the active
  // day's sketch; 'month' means it operates on monthly.sketch.excalidraw
  // for the current monthKey. Set by whichever surface launched Sketch.
  const [sketchScope, setSketchScope] = useState('day');
  const captureRef = useRef(null);
  const editingRef = useRef(null);
  const monthlyEditingRef = useRef(null);
  const idleTimer = useRef(null);

  // Load real days via IPC. Called on mount, after writes (edit, toggle,
  // capture), and after sync. Options:
  //   { anchorToToday: true } — explicitly jump to today after the load.
  //     Used by migrate (results land on today) and the first-ever load.
  //   (default) — preserve the user's current active date. If the date
  //     is no longer in range, fall back to today.
  const refetchDays = useCallback(async (options = {}) => {
    const anchorToToday = options?.anchorToToday === true;
    if (!window.missionBullet?.loadDays) {
      setLoading(false);
      setLoadError('Backend unavailable — restart the app. If you opened index.html directly in a browser, use `bun run ui` or `bun run ui:serve` instead.');
      return;
    }
    const prevActiveDate = daysRef.current[activeDayIdxRef.current]?.date;
    try {
      const real = await window.missionBullet.loadDays({ daysBack: 14 });
      if (Array.isArray(real) && real.length) {
        setDays(real);
        setLoadError(null);
        const tIdx = real.findIndex((d) => d.isToday);
        const todayIdxIn = tIdx >= 0 ? tIdx : real.length - 1;
        if (!hasAnchoredRef.current) {
          // First-ever load: honor a #date=YYYY-MM-DD hash if present,
          // otherwise start on today.
          const hash = (window.location.hash || '').slice(1);
          const m = hash.match(/date=(\d{4}-\d{2}-\d{2})/);
          let initIdx = todayIdxIn;
          if (m) {
            const hashIdx = real.findIndex((d) => d.date === m[1]);
            if (hashIdx >= 0) initIdx = hashIdx;
          }
          setActiveDayIdx(initIdx);
          hasAnchoredRef.current = true;
        } else if (anchorToToday) {
          setActiveDayIdx(todayIdxIn);
        } else if (prevActiveDate) {
          const idx = real.findIndex((d) => d.date === prevActiveDate);
          if (idx >= 0) setActiveDayIdx(idx);
          else setActiveDayIdx(todayIdxIn);
        }
        setDaysRev((n) => n + 1);
      }
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetchDays(); }, [refetchDays]);

  // Window title shows the active subject so you can tell which window
  // is which when you have several Electron apps running. Updates on nav.
  // The subject depends on the view: the monthly log takes over the
  // title when that tab is active, otherwise it's the active day.
  useEffect(() => {
    let label = 'mission-bullet';
    if (view === 'monthly') {
      label = `mission-bullet · ${monthLongTitle(monthKey)}`;
    } else if (view === 'sketch' && sketchScope === 'month') {
      label = `mission-bullet · Sketch · ${monthLongTitle(monthKey)}`;
    } else if (activeDay) {
      label = `mission-bullet · ${formatDateLabel(activeDay)}`;
    }
    document.title = label;
  }, [activeDay, view, monthKey, sketchScope]);

  // Subscribe to git-sync events from the Electron main. Turns a
  // silent background failure (push rejected, auth expired, upstream
  // rebased) into a visible rust alert. Browser/phone mode doesn't
  // have this channel yet — the server logs sync errors to stdout.
  useEffect(() => {
    if (!window.missionBullet?.onSyncEvent) return undefined;
    const unsubscribe = window.missionBullet.onSyncEvent((state) => {
      if (!state) return;
      if (state.status === 'syncing') {
        setSyncLabel('syncing…');
      } else if (state.status === 'ok' && state.tag === 'pushed') {
        setSyncLabel('synced · pushed');
        setTimeout(() => setSyncLabel((cur) => cur === 'synced · pushed' ? '' : cur), 2500);
      } else if (state.status === 'failed') {
        const msg = state.message ? state.message.split('\n').slice(-3).join(' · ') : '';
        setErrorMessage(`Git sync failed (${state.tag}) — ${msg || 'no detail'}`);
      }
    });
    return unsubscribe;
  }, []);

  const navigateDay = useCallback((dir) => {
    setActiveDayIdx((i) => Math.max(0, Math.min(days.length - 1, i + dir)));
  }, [days.length]);

  const enterEditMode = useCallback(async () => {
    const day = days[activeDayIdx];
    if (!day) return;
    if (!window.missionBullet?.readBody) {
      setErrorMessage('Edit unavailable — backend bridge missing. Restart via `bun run ui`.');
      return;
    }
    try {
      const body = (await window.missionBullet.readBody({ date: day.date })) ?? '';
      // If an entry is selected, find its line in the body so the
      // textarea opens with the cursor parked there. Lets you fix a
      // typo or add a Carroll signifier (`!`, `>`, `*`) on a specific
      // bullet without scrolling. Falls back to top-of-file if no
      // selection or no match (graceful — it's a convenience).
      let cursorOffset = null;
      if (selectedEntryId) {
        const entry = day.entries?.find((e) => e.id === selectedEntryId);
        if (entry && typeof entry.text === 'string' && entry.text.trim().length > 0) {
          const idx = body.indexOf(entry.text.trim());
          if (idx >= 0) {
            const lineStart = body.lastIndexOf('\n', idx - 1);
            cursorOffset = lineStart < 0 ? 0 : lineStart + 1;
          }
        }
      }
      setEditingBody(body);
      setOriginalBody(body);
      setEditing(true);
      setTimeout(() => {
        const ta = editingRef.current;
        if (!ta) return;
        ta.focus();
        if (cursorOffset !== null) {
          try {
            ta.setSelectionRange(cursorOffset, cursorOffset);
            // Approximate scroll so the cursor's line is roughly
            // centered. setSelectionRange alone doesn't always scroll
            // a long body into view.
            const ratio = cursorOffset / Math.max(body.length, 1);
            ta.scrollTop = Math.max(0, ta.scrollHeight * ratio - ta.clientHeight / 3);
          } catch (_) { /* setSelectionRange unsupported, skip */ }
        }
      }, 30);
    } catch (err) {
      setSyncLabel('');
      setErrorMessage(`Read failed — ${err?.message || err}`);
    }
  }, [days, activeDayIdx, selectedEntryId]);

  const saveEdit = useCallback(async () => {
    const day = days[activeDayIdx];
    if (!day || !window.missionBullet?.writeBody) return;
    if (editingBody === originalBody) return;
    try {
      setSyncLabel('saving…');
      await window.missionBullet.writeBody({ date: day.date, body: editingBody });
      setOriginalBody(editingBody);
      setSyncLabel('saved · git sync queued');
      setTimeout(() => setSyncLabel(''), 2500);
      await refetchDays();
    } catch (err) {
      setSyncLabel('');
      setErrorMessage(`Save failed — ${err?.message || err}`);
    }
  }, [days, activeDayIdx, editingBody, originalBody, refetchDays]);

  const exitEditMode = useCallback(async (save = true) => {
    if (save) await saveEdit();
    setEditing(false);
    setEditingBody('');
    setOriginalBody('');
  }, [saveEdit]);

  const activeDay = days[activeDayIdx] || days[0];

  // Weekly reflection state. Keyed by `YYYY-WNN`. Same lazy-fetch
  // pattern as monthly: undefined=loading, null=fetched-no-file,
  // {...}=parsed reflection. Cache survives view switches so the
  // user doesn't see a flash of "loading" each time they hit `w`.
  const [weeklyByKey, setWeeklyByKey] = useState({});
  const [runningReviewKey, setRunningReviewKey] = useState(null);
  // Monthly reflection cache, keyed by `YYYY-MM`. Same shape as
  // weeklyByKey: undefined=loading, null=fetched-no-file, {...}=parsed
  // reflection. Lives independently of the `monthly` log state because
  // a month's LOG (Calendar/Goals/Bills) and its REVIEW (themes /
  // migrations) are different surfaces — the review can exist with no
  // log, and vice versa.
  const [monthlyReflectionByKey, setMonthlyReflectionByKey] = useState({});
  const [runningMonthReviewKey, setRunningMonthReviewKey] = useState(null);
  const weeklyKey = useMemo(() => {
    const dateStr = activeDay?.date;
    if (!dateStr) return null;
    // Mirror src/isoweek.ts. Anchor by Thursday of the active week.
    const d = new Date(dateStr + 'T00:00:00Z');
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
    const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }, [activeDay?.date]);
  const weeklyDateRange = useMemo(() => {
    if (!weeklyKey) return null;
    const m = weeklyKey.match(/^(\d{4})-W(\d{2})$/);
    if (!m) return null;
    const year = Number(m[1]);
    const week = Number(m[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
    const week1Mon = new Date(Date.UTC(year, 0, 4 - jan4DayNum));
    const start = new Date(week1Mon);
    start.setUTCDate(start.getUTCDate() + (week - 1) * 7);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const fmt = (dt) =>
      `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    return { start: fmt(start), end: fmt(end) };
  }, [weeklyKey]);

  // Spawn `bun run bullet review week <spec> --force --non-interactive`
  // from the GUI so you never have to drop into a terminal. The CLI
  // writes reflections/YYYY-WNN.md; we invalidate the cache + refetch
  // on success.
  const runReviewWeek = useCallback(async (weekSpec) => {
    if (!weekSpec) return;
    if (!window.missionBullet?.runReviewWeek) {
      setErrorMessage('Run review unavailable — backend bridge missing.');
      return;
    }
    setRunningReviewKey(weekSpec);
    setSyncLabel('running weekly review…');
    try {
      const result = await window.missionBullet.runReviewWeek({ weekSpec });
      if (!result?.ok) {
        const tail = (result?.stderr || result?.stdout || '').trim().split('\n').slice(-3).join(' · ').slice(0, 400);
        setErrorMessage(`Review failed (exit ${result?.code ?? '?'}) — ${tail || 'no output'}`);
        setSyncLabel('');
        return;
      }
      // Invalidate the cache for this week so the next render refetches.
      setWeeklyByKey((prev) => {
        const next = { ...prev };
        delete next[weekSpec];
        return next;
      });
      setSyncLabel('review saved · pulling reflection…');
      setTimeout(() => setSyncLabel(''), 2500);
      // Refetch days too — accepted migrations would have written to
      // a daily entry. (None will, since non-interactive defers all,
      // but keep the refetch in case that changes.)
      await refetchDays();
    } catch (err) {
      setErrorMessage(`Review failed — ${err?.message || err}`);
      setSyncLabel('');
    } finally {
      setRunningReviewKey(null);
    }
  }, [refetchDays]);

  useEffect(() => {
    if (view !== 'weekly' || !weeklyKey) return undefined;
    if (weeklyByKey[weeklyKey] !== undefined) return undefined;
    if (!window.missionBullet?.readReflection) {
      setWeeklyByKey((prev) => ({ ...prev, [weeklyKey]: null }));
      return undefined;
    }
    const m = weeklyKey.match(/^(\d{4})-W(\d{2})$/);
    if (!m) return undefined;
    const year = Number(m[1]);
    const week = Number(m[2]);
    let cancelled = false;
    window.missionBullet.readReflection({ year, week })
      .then((payload) => {
        if (cancelled) return;
        setWeeklyByKey((prev) => ({ ...prev, [weeklyKey]: payload ?? null }));
      })
      .catch(() => {
        if (cancelled) return;
        setWeeklyByKey((prev) => ({ ...prev, [weeklyKey]: null }));
      });
    return () => { cancelled = true; };
  }, [view, weeklyKey, weeklyByKey]);

  // Monthly mirror of runReviewWeek. Spawns
  // `bun run bullet review month <YYYY-MM> --force --non-interactive`,
  // then invalidates the cached monthly reflection so the panel
  // refetches and displays themes + (deferred) migrations.
  const runReviewMonth = useCallback(async (spec) => {
    if (!spec) return;
    if (!window.missionBullet?.runReviewMonth) {
      setErrorMessage('Run review unavailable — backend bridge missing.');
      return;
    }
    setRunningMonthReviewKey(spec);
    setSyncLabel('running monthly review…');
    try {
      const result = await window.missionBullet.runReviewMonth({ monthSpec: spec });
      if (!result?.ok) {
        const tail = (result?.stderr || result?.stdout || '').trim().split('\n').slice(-3).join(' · ').slice(0, 400);
        setErrorMessage(`Review failed (exit ${result?.code ?? '?'}) — ${tail || 'no output'}`);
        setSyncLabel('');
        return;
      }
      setMonthlyReflectionByKey((prev) => {
        const next = { ...prev };
        delete next[spec];
        return next;
      });
      setSyncLabel('review saved · pulling reflection…');
      setTimeout(() => setSyncLabel(''), 2500);
      await refetchDays();
    } catch (err) {
      setErrorMessage(`Review failed — ${err?.message || err}`);
      setSyncLabel('');
    } finally {
      setRunningMonthReviewKey(null);
    }
  }, [refetchDays]);

  // Lazy-fetch the monthly reflection when the monthly view is open.
  // Same cache shape as the weekly fetch effect above.
  useEffect(() => {
    if (view !== 'monthly' || !monthKey) return undefined;
    if (monthlyReflectionByKey[monthKey] !== undefined) return undefined;
    if (!window.missionBullet?.readMonthlyReflection) {
      setMonthlyReflectionByKey((prev) => ({ ...prev, [monthKey]: null }));
      return undefined;
    }
    let cancelled = false;
    window.missionBullet.readMonthlyReflection({ monthSpec: monthKey })
      .then((payload) => {
        if (cancelled) return;
        setMonthlyReflectionByKey((prev) => ({ ...prev, [monthKey]: payload ?? null }));
      })
      .catch(() => {
        if (cancelled) return;
        setMonthlyReflectionByKey((prev) => ({ ...prev, [monthKey]: null }));
      });
    return () => { cancelled = true; };
  }, [view, monthKey, monthlyReflectionByKey]);

  // Autofocus the capture input when settling on the daily view. Without
  // this, pressing single-letter keys (e.g. `s`) would trigger view-switch
  // shortcuts because the window has no focused input — so you start
  // typing "something about today" and get thrown into the sketch canvas
  // on the first `s`. Deps deliberately EXCLUDE activeDayIdx so arrowing
  // through days doesn't snatch focus back from a clicked entry.
  useEffect(() => {
    if (view !== 'daily') return;
    if (editing || migrateOpen) return;
    const id = setTimeout(() => {
      if (captureRef.current) captureRef.current.focus();
    }, 80);
    return () => clearTimeout(id);
  }, [view, editing, migrateOpen, daysRev]);

  // Load monthly log whenever the active month changes. Pure read — no
  // session stamp. The stamp is issued at edit-time via enterMonthlyEdit
  // so that flipping through months doesn't log imaginary sessions.
  const refetchMonthly = useCallback(async () => {
    if (!window.missionBullet?.readMonthly) {
      setMonthlyError('Monthly backend unavailable — restart via `bun run ui`.');
      setMonthlyLoading(false);
      return;
    }
    try {
      setMonthlyLoading(true);
      const result = await window.missionBullet.readMonthly({ month: monthKey, stamp: false });
      setMonthly(result);
      setMonthlyError(null);
    } catch (err) {
      setMonthlyError(`Read failed — ${err?.message || err}`);
    } finally {
      setMonthlyLoading(false);
    }
  }, [monthKey]);

  useEffect(() => {
    // Only load when the monthly view is actually visible — avoids an
    // unnecessary IPC roundtrip on every App render. Reload on monthKey
    // change so prev/next month navigation picks up the right file.
    if (view !== 'monthly') return;
    refetchMonthly();
  }, [view, monthKey, refetchMonthly]);

  const enterMonthlyEdit = useCallback(async () => {
    if (monthlyEditing) return;
    if (!window.missionBullet?.readMonthly) {
      setMonthlyError('Edit unavailable — backend bridge missing.');
      return;
    }
    try {
      // Stamp the session server-side on the same read so the frontmatter
      // reflects "I opened the log to work on it." Matches `bullet month`.
      const fresh = await window.missionBullet.readMonthly({ month: monthKey, stamp: true });
      setMonthly(fresh);
      const body = fresh?.body ?? '';
      setMonthlyEditingBody(body);
      setMonthlyOriginalBody(body);
      setMonthlyEditing(true);
      setTimeout(() => monthlyEditingRef.current && monthlyEditingRef.current.focus(), 30);
    } catch (err) {
      setMonthlyError(`Edit failed — ${err?.message || err}`);
    }
  }, [monthKey, monthlyEditing]);

  const saveMonthlyEdit = useCallback(async () => {
    if (!window.missionBullet?.writeMonthly) return;
    if (monthlyEditingBody === monthlyOriginalBody) return;
    try {
      setMonthlySaveLabel('saving…');
      await window.missionBullet.writeMonthly({ month: monthKey, body: monthlyEditingBody });
      setMonthlyOriginalBody(monthlyEditingBody);
      setMonthlySaveLabel('saved · git sync queued');
      setTimeout(() => setMonthlySaveLabel(''), 2500);
      await refetchMonthly();
    } catch (err) {
      setMonthlyError(`Save failed — ${err?.message || err}`);
      setMonthlySaveLabel('');
    }
  }, [monthKey, monthlyEditingBody, monthlyOriginalBody, refetchMonthly]);

  const exitMonthlyEdit = useCallback(async (save = true) => {
    if (save) await saveMonthlyEdit();
    setMonthlyEditing(false);
    setMonthlyEditingBody('');
    setMonthlyOriginalBody('');
  }, [saveMonthlyEdit]);

  const navigateMonth = useCallback((dir) => {
    setMonthKey((cur) => shiftMonth(cur, dir));
  }, []);

  const openMonthlySketch = useCallback(() => {
    setSketchScope('month');
    setView('sketch');
  }, []);

  // Toggle a task checkbox from the daily view. Mirrors the monthly
  // flow: reads the current raw body, flips the matching `- [ ]` /
  // `- []` ↔ `- [x]` line, writes it back, then refetches so the UI
  // reflects the new state. Only acts on open or done checkbox tasks;
  // migrated/cancelled statuses are terminal and require explicit
  // migration-modal action to undo. The regex tolerates either the
  // space-inside-brackets or the no-space form because the user writes both.
  const toggleDailyTask = useCallback(async (date, taskText, wasDone) => {
    if (!window.missionBullet?.readBody || !window.missionBullet?.writeBody) return;
    const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const openRe = new RegExp(`(^|\\n)(\\s*-\\s*)\\[\\s?\\](\\s+${escaped})`);
    const doneRe = new RegExp(`(^|\\n)(\\s*-\\s*)\\[[xX]\\](\\s+${escaped})`);
    try {
      const body = await window.missionBullet.readBody({ date });
      if (typeof body !== 'string') return;
      const newBody = wasDone
        ? body.replace(doneRe, '$1$2[ ]$3')
        : body.replace(openRe, '$1$2[x]$3');
      if (newBody === body) return;
      await window.missionBullet.writeBody({ date, body: newBody });
      await refetchDays();
    } catch (err) {
      setErrorMessage(`Toggle failed — ${err?.message || err}`);
    }
  }, [refetchDays]);

  // Toggle a task checkbox from the monthly view — rewrites the raw
  // body's matching `- [ ] X` to `- [x] X` (or vice versa) and saves.
  // Uses text matching against the RAW body (not the cleaned view
  // body) so HTML comments in the raw aren't dropped by the rewrite.
  // If two tasks share the same text, only the first occurrence flips
  // — acceptable for the common monthly-log case; user can always edit
  // manually for duplicates.
  const toggleMonthlyTask = useCallback(async (taskText, wasDone) => {
    if (!monthly || typeof monthly.body !== 'string') return;
    if (!window.missionBullet?.writeMonthly) return;
    const raw = monthly.body;
    const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = wasDone
      ? new RegExp(`(^|\\n)(\\s*-\\s*)\\[[xX]\\](\\s+${escaped})`)
      : new RegExp(`(^|\\n)(\\s*-\\s*)\\[\\s\\](\\s+${escaped})`);
    const replacement = wasDone ? '$1$2[ ]$3' : '$1$2[x]$3';
    const newRaw = raw.replace(re, replacement);
    if (newRaw === raw) return;
    try {
      setMonthlySaveLabel('saving…');
      await window.missionBullet.writeMonthly({ month: monthKey, body: newRaw });
      setMonthlySaveLabel('saved · git sync queued');
      setTimeout(() => setMonthlySaveLabel(''), 2000);
      await refetchMonthly();
    } catch (err) {
      setMonthlyError(`Toggle failed — ${err?.message || err}`);
      setMonthlySaveLabel('');
    }
  }, [monthly, monthKey, refetchMonthly]);
  const selectedEntry = useMemo(() => {
    if (!selectedEntryId) return null;
    for (const d of days) {
      const e = d.entries.find(x => x.id === selectedEntryId);
      if (e) return { ...e, date: d.date };
    }
    return null;
  }, [selectedEntryId, days]);

  // Pin selection to the first entry of whatever day the user is
  // looking at. Triggers on date change only (not on every entry-list
  // re-render within the same day) so a strike/done flip doesn't yank
  // the cursor away from the user's pointer; entry ids are stable
  // across in-place rewrites so the existing selection persists.
  useEffect(() => {
    if (!activeDay) return;
    if (activeDay.entries.length === 0) {
      setSelectedEntryId(null);
      return;
    }
    setSelectedEntryId((cur) => {
      const stillThere = activeDay.entries.some((e) => e.id === cur);
      return stillThere ? cur : activeDay.entries[0].id;
    });
  }, [activeDay?.date]);

  useEffect(() => {
    const reset = () => {
      setShortcutsVisible(true);
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setShortcutsVisible(false), 4500);
    };
    reset();
    window.addEventListener('mousemove', reset);
    window.addEventListener('keydown', reset);
    return () => {
      clearTimeout(idleTimer.current);
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('keydown', reset);
    };
  }, []);

  const commit = useCallback(async ({ kind, text }) => {
    if (!window.missionBullet?.saveEntry) {
      setErrorMessage('Capture unavailable — backend bridge missing. Restart via `bun run ui`.');
      return;
    }
    try {
      setSyncLabel('saving…');
      await window.missionBullet.saveEntry({ kind, text });
      setSyncLabel('saved · git sync queued');
      setTimeout(() => setSyncLabel(''), 2500);
      await refetchDays();
      const latest = (activeDay?.entries || []).slice(-1)[0];
      if (latest) setNewId(latest.id);
      setTimeout(() => setNewId(null), 300);
    } catch (err) {
      setSyncLabel('');
      setErrorMessage(`Save failed — ${err?.message || err}`);
    }
  }, [refetchDays, activeDay]);

  // Image paste. When the user pastes an image (Ctrl+V from a browser,
  // screenshot tool, etc.) anywhere in daily view, save it under the
  // active day's `images/` folder and either append it as a new note
  // bullet (default) or insert a markdown-image reference at the
  // edit-mode textarea's caret (when in edit mode).
  //
  // The edit-mode branch is load-bearing: without it, a paste while
  // editing would saveEntry on disk + then get clobbered when the user
  // saves the edit (editingBody doesn't include the appended bullet).
  // That'd be silent data loss.
  useEffect(() => {
    if (view !== 'daily') return undefined;
    if (!window.missionBullet?.saveImage || !window.missionBullet?.saveEntry) return undefined;
    let inFlight = false;
    const handler = async (e) => {
      if (inFlight) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      let imageItem = null;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          imageItem = item;
          break;
        }
      }
      if (!imageItem) return;
      e.preventDefault();
      inFlight = true;
      const targetDate = activeDay?.date;
      if (!targetDate) { inFlight = false; return; }
      try {
        setSyncLabel('saving image…');
        const blob = imageItem.getAsFile();
        if (!blob) throw new Error('clipboard had no file blob');
        const dataUrl = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.onerror = () => rej(reader.error);
          reader.readAsDataURL(blob);
        });
        const base64 = String(dataUrl).split(',')[1] || '';
        const result = await window.missionBullet.saveImage({
          date: targetDate,
          dataBase64: base64,
          mimeType: imageItem.type,
        });
        if (editing) {
          // Insert at caret in the edit textarea — the user is mid-edit,
          // appending as a separate bullet would be lost on save.
          const ta = editingRef.current;
          const markdown = `![](${result.relativePath})`;
          if (ta) {
            const start = ta.selectionStart ?? ta.value.length;
            const end = ta.selectionEnd ?? ta.value.length;
            setEditingBody((prev) => {
              const insert = (start === end && start > 0 && prev[start - 1] !== '\n')
                ? `\n${markdown}\n`
                : `${markdown}\n`;
              return prev.slice(0, start) + insert + prev.slice(end);
            });
            // Restore caret after the inserted block.
            setTimeout(() => {
              if (ta && document.activeElement === ta) {
                const pos = start + markdown.length + 1;
                ta.setSelectionRange(pos, pos);
              }
            }, 0);
          } else {
            setEditingBody((prev) => `${prev.replace(/\s*$/, '')}\n![](${result.relativePath})\n`);
          }
          setSyncLabel('image saved · save the edit to keep it');
          setTimeout(() => setSyncLabel(''), 2500);
        } else {
          await window.missionBullet.saveEntry({
            date: targetDate,
            kind: 'note',
            text: `![](${result.relativePath})`,
          });
          setSyncLabel('image saved · git sync queued');
          setTimeout(() => setSyncLabel(''), 2500);
          await refetchDays();
        }
      } catch (err) {
        setSyncLabel('');
        setErrorMessage(`Image paste failed — ${err?.message || err}`);
      } finally {
        inFlight = false;
      }
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, [view, activeDay?.date, refetchDays, editing]);

  const requestSync = useCallback(async () => {
    if (syncing) return;
    if (!window.missionBullet?.syncPull || !window.missionBullet?.syncNow) {
      setErrorMessage('Sync unavailable — backend bridge missing.');
      return;
    }
    setSyncing(true);
    setSyncLabel('pulling…');
    try {
      const pull = await window.missionBullet.syncPull();
      if (!pull?.ok) {
        const msg = pull?.message || 'git pull failed';
        setErrorMessage(`Pull failed — ${msg.split('\n').slice(-3).join(' · ')}`);
        setSyncLabel('');
        return;
      }
      setSyncLabel('pushing…');
      await window.missionBullet.syncNow();
      setSyncLabel(pull.message === 'already up to date'
        ? 'synced · up to date'
        : 'synced · pulled + pushed');
      await refetchDays();
      setTimeout(() => setSyncLabel((cur) => cur?.startsWith('synced') ? '' : cur), 3000);
    } catch (err) {
      setErrorMessage(`Sync failed — ${err?.message || err}`);
      setSyncLabel('');
    } finally {
      setSyncing(false);
    }
  }, [syncing, refetchDays]);

  const moveSelection = useCallback((dir) => {
    if (view !== 'daily') return;
    const list = activeDay?.entries || [];
    if (!list.length) return;
    const curIdx = Math.max(0, list.findIndex(e => e.id === selectedEntryId));
    const next = Math.max(0, Math.min(list.length - 1, curIdx + dir));
    setSelectedEntryId(list[next].id);
  }, [view, activeDay, selectedEntryId]);

  // Keyboard equivalent of the click-to-toggle on a task glyph. Open
  // ↔ done flip on the selected checkbox task. Mirrors Shift+X's shape
  // (capital letter so it's deliberate, scoped to daily view). Done is
  // semantically distinct from struck — done = completed, struck = no
  // longer relevant — so they get separate keys.
  const toggleDoneSelected = useCallback(() => {
    if (view !== 'daily') return;
    if (!selectedEntryId) return;
    const day = activeDay;
    if (!day) return;
    const entry = day.entries?.find((e) => e.id === selectedEntryId);
    if (!entry) return;
    const canToggle =
      entry.kind === 'task' &&
      entry.isCheckbox &&
      (entry.status === undefined || entry.status === 'done');
    if (!canToggle) return;
    toggleDailyTask(day.date, entry.text, entry.status === 'done');
  }, [view, selectedEntryId, activeDay, toggleDailyTask]);

  // Carroll's strike — "no longer relevant." Rewrites the source line
  // for the selected open task to `- [x] ~~text~~ <!-- ... -->`. Done
  // tasks aren't strikable (already terminal); non-task entries (notes,
  // alerts, events) need raw edit mode for now to keep this feature's
  // surface narrow. Silently no-ops on un-strikable selections so a
  // stray Shift+X doesn't mutate something unexpected.
  const strikeSelected = useCallback(async () => {
    if (view !== 'daily') return;
    if (!selectedEntryId) return;
    const day = activeDay;
    if (!day) return;
    const entry = day.entries?.find((e) => e.id === selectedEntryId);
    if (!entry) return;
    const isOpenTask = entry.kind === 'task' && entry.isCheckbox && entry.status === undefined;
    if (!isOpenTask) return;
    if (!window.missionBullet?.strikeTask) return;
    // entry.sourceKey is the post-auto-mark-strip form of the on-disk
    // line — verbatim what migrate-adapter's OPEN_TASK_LINE_RE
    // captures, so the strike's taskText matches m[2] exactly without
    // reconstructing it from text + provenance (which loses
    // whitespace nuances on round-trip).
    const taskText = entry.sourceKey || entry.text;
    try {
      const r = await window.missionBullet.strikeTask({ date: day.date, taskText });
      if (r?.struck > 0) {
        await refetchDays({ anchorToToday: false });
        setSyncLabel('struck');
        setTimeout(() => setSyncLabel((cur) => cur === 'struck' ? '' : cur), 1500);
      }
    } catch (err) {
      setErrorMessage(`Strike failed — ${err?.message || err}`);
    }
  }, [view, selectedEntryId, activeDay, refetchDays]);

  useEffect(() => {
    const onKey = (e) => {
      const target = e.target;
      const isEditable = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      // Edit-mode textarea owns its own keys (Ctrl+S save, Escape exit).
      // Global bindings don't fire while editing — for daily or monthly.
      if (editing || monthlyEditing) return;
      // Migrate modal owns its own key handling (Escape to close, button
      // clicks for per-task decisions). Swallow global bindings while it
      // is open so 'j'/'k'/'w'/'m' don't navigate away under it.
      if (migrateOpen) return;
      if (e.key === '/' && !isEditable) {
        e.preventDefault();
        setView('daily');
        setTimeout(() => captureRef.current && captureRef.current.focus(), 30);
        return;
      }
      if (e.key === 'M' && e.shiftKey && !isEditable && !migrateOpen) {
        e.preventDefault();
        setMigrateOpen(true);
        return;
      }
      if (e.key === 'S' && e.shiftKey && !isEditable && !syncing) {
        e.preventDefault();
        requestSync();
        return;
      }
      if (e.key === 'X' && e.shiftKey && !isEditable) {
        // Carroll's strike on the selected open task. Capital X
        // (i.e., shift+x) keeps it deliberate and prevents conflict
        // with `x` typed elsewhere; semantically distinct from the
        // `[x]` done state to avoid the "did I mark it done or
        // strike it?" confusion.
        e.preventDefault();
        strikeSelected();
        return;
      }
      if (e.key === 'D' && e.shiftKey && !isEditable) {
        // Done-toggle on the selected open/done task. Keyboard
        // equivalent of clicking the glyph. Pairs with Shift+X
        // (strike) to give you the full Carroll keystroke set.
        e.preventDefault();
        toggleDoneSelected();
        return;
      }
      if (e.key === 'Escape' && isEditable) { target.blur(); return; }
      if (isEditable) return;
      if (e.key === 'j') { e.preventDefault(); moveSelection(1); }
      else if (e.key === 'k') { e.preventDefault(); moveSelection(-1); }
      else if (e.key === 'ArrowLeft') {
        if (view === 'monthly') { e.preventDefault(); navigateMonth(-1); }
        else if (view === 'sketch' && sketchScope === 'month') { e.preventDefault(); navigateMonth(-1); }
        else if (view === 'weekly') { e.preventDefault(); navigateDay(-7); }
        else if (view === 'daily' || view === 'sketch') { e.preventDefault(); navigateDay(-1); }
      }
      else if (e.key === 'ArrowRight') {
        if (view === 'monthly') { e.preventDefault(); navigateMonth(1); }
        else if (view === 'sketch' && sketchScope === 'month') { e.preventDefault(); navigateMonth(1); }
        else if (view === 'weekly') { e.preventDefault(); navigateDay(7); }
        else if (view === 'daily' || view === 'sketch') { e.preventDefault(); navigateDay(1); }
      }
      else if (e.key === 'e' && view === 'daily') { e.preventDefault(); enterEditMode(); }
      else if (e.key === 'e' && view === 'monthly') { e.preventDefault(); enterMonthlyEdit(); }
      else if (e.key === 's' && !e.shiftKey) {
        // Sketch scope follows current context: month-scope from the
        // Monthly tab, day-scope from everywhere else.
        setSketchScope(view === 'monthly' ? 'month' : 'day');
        setView('sketch');
      }
      else if (e.key === 'w') { setView('weekly'); }
      else if (e.key === 'm') { setView('monthly'); }
      else if (e.key === 't') { setView('themes'); }
      else if (e.key === 'd') { setView('daily'); }
      else if (e.key === 'z' && view === 'daily') {
        // Zen mode is only meaningful on the daily writing surface;
        // the review/sketch/monthly views need their chrome to be
        // navigable. Restrict the toggle to daily so it can't be
        // turned on somewhere it'd hide essential affordances.
        e.preventDefault();
        setZenMode((on) => !on);
      }
      else if (e.key === 'Escape') {
        // Exit zen first if it's active; only then fall back to the
        // global "back to daily" behavior. Without this, a single Esc
        // press in zen mode would do nothing (already on daily) and
        // you would have no way out without remembering `z`.
        if (zenMode) setZenMode(false);
        else setView('daily');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveSelection, view, navigateDay, navigateMonth, enterEditMode, enterMonthlyEdit, editing, monthlyEditing, migrateOpen, syncing, requestSync, sketchScope, zenMode, strikeSelected, toggleDoneSelected]);

  let content;
  if (loading) {
    content = (
      <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', padding: '40px 0', textAlign: 'center' }}>
        loading entries…
      </div>
    );
  } else if (view === 'daily') {
    const showDays = editing
      ? [days[activeDayIdx]].filter(Boolean)
      : [days[activeDayIdx - 1], days[activeDayIdx]].filter(Boolean);
    content = (
      <div>
        {showDays.map((d) => (
          <div key={d.date}>
            <DateHeader day={d} />
            {editing && d.date === activeDay.date ? (
              <EditDayPane
                date={d.date}
                value={editingBody}
                onChange={setEditingBody}
                innerRef={editingRef}
                onSave={saveEdit}
                onExit={() => exitEditMode(true)}
                onCancel={() => exitEditMode(false)}
              />
            ) : (
              <>
                <EntryList
                  day={d}
                  selectedId={selectedEntryId}
                  onSelect={setSelectedEntryId}
                  newId={d.isToday ? newId : null}
                  onToggleTask={(taskText, wasDone) => toggleDailyTask(d.date, taskText, wasDone)}
                />
                {d.isToday && !editing && (
                  <Capture
                    kind={kind}
                    setKind={setKind}
                    onCommit={commit}
                    innerRef={captureRef}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>
    );
  } else if (view === 'sketch') {
    const sketchSubject = sketchScope === 'month' ? monthKey : activeDay?.date;
    content = sketchSubject
      ? <SketchView date={sketchSubject} scope={sketchScope} dark={dark} />
      : (
        <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', padding: '40px 0', textAlign: 'center' }}>
          no day selected
        </div>
      );
  } else if (view === 'weekly') {
    const weekKey = weeklyKey;
    const cached = weeklyByKey[weekKey];
    content = (
      <WeeklyView
        weekly={cached === undefined ? null : cached}
        weekSpec={weekKey}
        dateRange={weeklyDateRange}
        loading={cached === undefined}
        running={runningReviewKey === weekKey}
        onRunReview={runReviewWeek}
      />
    );
  } else if (view === 'monthly') {
    const cachedReflection = monthlyReflectionByKey[monthKey];
    content = (
      <MonthlyLogView
        monthKey={monthKey}
        monthly={monthly}
        loading={monthlyLoading}
        error={monthlyError}
        editing={monthlyEditing}
        editingBody={monthlyEditingBody}
        setEditingBody={setMonthlyEditingBody}
        editingRef={monthlyEditingRef}
        saveLabel={monthlySaveLabel}
        onEnterEdit={enterMonthlyEdit}
        onSaveEdit={saveMonthlyEdit}
        onExitEdit={exitMonthlyEdit}
        onNavigateMonth={navigateMonth}
        onOpenSketch={openMonthlySketch}
        onToggleTask={toggleMonthlyTask}
        reflection={cachedReflection === undefined ? null : cachedReflection}
        reflectionLoading={cachedReflection === undefined}
        reviewRunning={runningMonthReviewKey === monthKey}
        onRunReview={runReviewMonth}
      />
    );
  } else if (view === 'themes') {
    content = (
      <>
        <SampleDataBanner viewName="Themes" />
        <ThemesView themes={THEMES} />
      </>
    );
  } else if (view === 'mobile') {
    content = (
      <div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: 18, textAlign: 'center' }}>
          Mobile · capture pinned to bottom · denser grid
        </div>
        <MobilePreview day={activeDay} onCommit={commit} />
      </div>
    );
  }

  return (
    <div className="shell" style={{ paddingBottom: 72 }}>
      {!zenMode && (
        <TopNav
          view={view}
          setView={setView}
          dateLabel={activeDay ? formatDateLabel(activeDay) : ''}
          onMigrate={() => setMigrateOpen(true)}
          onSync={requestSync}
          syncing={syncing}
          dark={dark}
          onToggleDark={() => setDark((d) => !d)}
        />
      )}
      {content}

      <MigrateModal
        open={migrateOpen}
        onClose={() => setMigrateOpen(false)}
        onApplied={async () => { await refetchDays({ anchorToToday: true }); }}
      />

      <ShortcutBar view={view} visible={shortcutsVisible && !migrateOpen && !zenMode} />

      {syncLabel && !errorMessage && !loadError && (
        <div style={{ position: 'fixed', bottom: 48, left: 16, zIndex: 51, fontFamily: 'var(--mono)', fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-muted)', background: 'var(--bg-page)', border: '1px solid var(--rule)', padding: '6px 10px', borderRadius: 4 }}>
          {syncLabel}
        </div>
      )}

      {(errorMessage || loadError) && (
        <div
          role="alert"
          style={{
            position: 'fixed',
            bottom: 48,
            left: 16,
            zIndex: 51,
            maxWidth: 560,
            fontFamily: 'var(--mono)',
            fontSize: '11px',
            letterSpacing: '0.04em',
            color: '#fff',
            background: 'var(--accent)',
            padding: '10px 14px',
            borderRadius: 3,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
            boxShadow: '0 6px 20px rgba(0,0,0,0.2)',
          }}
        >
          <span style={{ flex: 1, textTransform: 'none', letterSpacing: 'normal' }}>
            {errorMessage || `Load error — ${loadError}`}
          </span>
          <button
            onClick={() => { setErrorMessage(null); setLoadError(null); }}
            style={{
              appearance: 'none',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.6)',
              color: '#fff',
              padding: '2px 9px',
              borderRadius: 2,
              fontFamily: 'inherit',
              fontSize: '10.5px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >Dismiss</button>
        </div>
      )}

      {window.missionBulletDev && window.TweaksPanel && (
        <TweaksPanel>
          <TweakSection label="Typography" />
          <TweakRadio
            label="Serif pairing"
            value={t.typePair}
            options={[
              { value: 'iowan',    label: 'Iowan' },
              { value: 'bookerly', label: 'Source Serif' },
            ]}
            onChange={(v) => setTweak('typePair', v)}
          />
          <TweakSection label="Page" />
          <TweakSlider label="Measure" value={t.measure} min={560} max={860} step={20} unit="px" onChange={(v) => setTweak('measure', v)} />
          <TweakSlider label="Bullet gutter" value={t.gutter} min={24} max={56} step={4} unit="px" onChange={(v) => setTweak('gutter', v)} />
          <TweakSlider label="Grid step" value={t.gridStep} min={6} max={14} step={1} unit="px" onChange={(v) => setTweak('gridStep', v)} />
          <TweakSection label="Accent" />
          <TweakColor label="Rust" value={t.accent} onChange={(v) => setTweak('accent', v)} />
        </TweaksPanel>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
