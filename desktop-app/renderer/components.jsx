// components.jsx — shared components for mission-bullet
// Entry rendering, capture, topnav, shortcut bar.

const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* Glyph used for rendering an entry bullet. `- [ ]` / `- []` markdown
 * tasks render differently from `- !` alert tasks so you can tell at
 * a glance what's an unfinished checkbox-task (migrate-eligible) vs a
 * priority alert (flow-annotation, not migrated). Spotted dogfooding
 * against a 2026-04-22 entry — Joey's water was `- []` but rendered
 * as `•` identical to the `- ! Deli tab…` alerts above it.
 */
function entryGlyph(entry) {
  if (entry.status === 'migrated') return '>';
  if (entry.status === 'cancelled') return '×';
  if (entry.status === 'done') {
    if (entry.kind === 'task') return entry.isCheckbox ? '✓' : '✕';
    if (entry.kind === 'event') return '⊗';
  }
  // Alert form (`- ! text`) — a task-shaped reminder rendered with `!`
  // instead of the generic `•`. Flagged during parse; no user-initiated
  // click-toggle (alerts aren't tick-off tasks).
  if (entry.isAlert) return '!';
  if (entry.kind === 'task') return entry.isCheckbox ? '▢' : '•';
  if (entry.kind === 'note') return '−';
  if (entry.kind === 'event') return '○';
  return '•';
}

// Match a markdown image-only line: `![alt](./images/foo.png)` with
// optional surrounding whitespace. Used to flip an entry into image
// rendering instead of the default text body.
const IMAGE_ONLY_RE = /^\s*!\[(.*?)\]\((\.?\/?images\/[^)\s]+)\)\s*$/;

// Loads + caches a per-day image as a data URL via IPC. Component-level
// cache keyed by `${date}|${path}` so re-renders of the same entry
// don't re-fetch.
const _imageCache = new Map();
function ImageBody({ date, path, alt }) {
  const [src, setSrc] = useState(_imageCache.get(`${date}|${path}`) || null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (src) return undefined;
    if (!window.missionBullet?.readImage) {
      setError('image read not available');
      return undefined;
    }
    let cancelled = false;
    window.missionBullet.readImage({ date, path })
      .then((dataUrl) => {
        if (cancelled) return;
        if (dataUrl) {
          _imageCache.set(`${date}|${path}`, dataUrl);
          setSrc(dataUrl);
        } else {
          setError('image not found');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'image load failed');
      });
    return () => { cancelled = true; };
  }, [date, path, src]);
  if (error) {
    return <span className="muted" style={{ fontStyle: 'italic', fontSize: '13px' }}>(image: {error})</span>;
  }
  if (!src) {
    return <span className="muted" style={{ fontStyle: 'italic', fontSize: '13px' }}>(loading image…)</span>;
  }
  return (
    <img
      src={src}
      alt={alt || ''}
      style={{
        maxWidth: '100%',
        maxHeight: 280,
        borderRadius: 3,
        border: '1px solid var(--rule)',
        display: 'block',
        marginTop: 4,
      }}
    />
  );
}

function Entry({ entry, selected, onSelect, onToggleTask, dayDate }) {
  const classes = ['entry'];
  if (entry.status === 'migrated') classes.push('migrated');
  if (entry.status === 'cancelled') classes.push('cancelled');
  if (entry.status === 'done') classes.push('done');
  if (entry.entering) classes.push('entering');

  const imageMatch = entry.text ? entry.text.match(IMAGE_ONLY_RE) : null;
  const bodyStyle = entry.status === 'cancelled'
    ? { textDecoration: 'line-through', color: 'var(--ink-muted)' }
    : undefined;

  const provenanceLabel = entry.provenance
    ? (entry.provenance.kind === 'migrated-to'
        ? `→ ${entry.provenance.date}`
        : `from ${entry.provenance.date}`)
    : null;

  // A checkbox task is toggle-able only when open or done. Migrated /
  // cancelled are terminal — those came from the migrate flow and
  // shouldn't be undone by a stray click.
  const canToggle =
    !!onToggleTask &&
    entry.isCheckbox &&
    (entry.status === undefined || entry.status === 'done');
  const handleGlyphClick = canToggle
    ? (e) => {
        e.stopPropagation();
        onToggleTask(entry.text, entry.status === 'done');
      }
    : undefined;
  const handleGlyphKey = canToggle
    ? (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          onToggleTask(entry.text, entry.status === 'done');
        }
      }
    : undefined;

  return (
    <div
      className={classes.join(' ')}
      aria-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      data-id={entry.id}
    >
      <span
        className="glyph"
        onClick={handleGlyphClick}
        onKeyDown={handleGlyphKey}
        style={canToggle ? { cursor: 'pointer' } : undefined}
        title={canToggle ? 'Click to toggle done' : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
      >{entryGlyph(entry)}</span>
      <span className="body" style={bodyStyle}>
        {imageMatch && dayDate ? (
          <ImageBody date={dayDate} path={imageMatch[2]} alt={imageMatch[1]} />
        ) : (
          entry.text
        )}
        {provenanceLabel && (
          <span
            className="muted"
            style={{
              marginLeft: 10,
              fontFamily: 'var(--mono)',
              fontSize: '10.5px',
              letterSpacing: '0.04em',
              color: 'var(--ink-faint)',
            }}
          >{provenanceLabel}</span>
        )}
      </span>
      <span className="time">{entry.time}</span>
    </div>
  );
}

function DateHeader({ day }) {
  const d = new Date(day.date + 'T00:00:00');
  const longDate = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).toUpperCase();
  return (
    <div className="dateheader">
      <span>{longDate}</span>
      <span className="meta">
        {day.weekLabel} · {day.entries.length} ENTR{day.entries.length === 1 ? 'Y' : 'IES'}
      </span>
    </div>
  );
}

// Display priority for an entry. Lower number = higher in the rendered
// list. Display-only — the raw file stays in the user's writing order so
// migrate / parse all see the original sequence. Within the
// same priority, original file order is preserved (stable sort).
//   prose (free-form text on top of the day)        : -1
//   alerts (`- ! …` reminders, bills, debts)        :  0
//   open checkbox tasks (`- [ ] …`)                 : 10
//   other open tasks (`• …` triad form)             : 20
//   open events                                     : 30
//   open notes                                      : 40
//   done items                                      : 60
//   migrated (terminal — already moved forward)     : 70
//   cancelled (terminal — abandoned via strike)     : 80
function entryPriority(entry) {
  if (entry.kind === 'note' && entry.id && entry.id.endsWith('-prose')) return -1;
  if (entry.status === 'cancelled') return 80;
  if (entry.status === 'migrated') return 70;
  if (entry.status === 'done') return 60;
  if (entry.isAlert) return 0;
  if (entry.kind === 'task' && entry.isCheckbox) return 10;
  if (entry.kind === 'task') return 20;
  if (entry.kind === 'event') return 30;
  if (entry.kind === 'note') return 40;
  return 90;
}

function EntryList({ day, selectedId, onSelect, newId, onToggleTask }) {
  if (!day.entries.length) {
    return (
      <div className="entries">
        <div className="empty">
          Start with a bullet <span style={{fontFamily:'var(--serif)'}}>(•)</span>, a note (−), or an event (○).
          <div className="hint">PRESS / TO CAPTURE</div>
        </div>
      </div>
    );
  }
  const sortedEntries = day.entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const pa = entryPriority(a.e);
      const pb = entryPriority(b.e);
      if (pa !== pb) return pa - pb;
      return a.i - b.i;
    })
    .map((x) => x.e);
  return (
    <div className="entries">
      {sortedEntries.map((e) => (
        <Entry
          key={e.id}
          entry={{ ...e, entering: e.id === newId }}
          selected={e.id === selectedId}
          onSelect={() => onSelect(e.id)}
          onToggleTask={onToggleTask}
          dayDate={day.date}
        />
      ))}
    </div>
  );
}

/*
 * Capture — kind selector + text input + voice button.
 *
 * Voice uses the Web Speech API (SpeechRecognition), built into
 * Chromium/Electron and available in mobile Chrome (works in the
 * HTTP-server PWA path on phones). No API key needed — Chromium
 * routes audio to Google's speech service for free. Transcript
 * streams into the same text input you would type into, so you can
 * edit it before pressing Enter. Raw-is-sacred is preserved because
 * the transcript becomes a typed bullet like any other.
 *
 * Shift+V toggles recording when the input isn't focused.
 */
// Curated emoji set. Restrained on purpose — bullet journaling is a
// quiet surface, not a Slack channel. ~30 useful glyphs for everyday
// capture (state of mind, weather, food, signals). The classics like
// ✓/✗/! are already kind-glyphs in the selector to the left, so no
// dupes here.
const EMOJI_SET = [
  '😀','🙂','😅','🥲','😢','😡','😴','🤔','😎','🥳',
  '☀️','🌧️','❄️','🔥','🌱','🌙','⭐','💡','📚','📝',
  '☕','🍕','🍎','🥤','🎯','💪','🏃','🛏️','💊','🧘',
  '❤️','💔','🎉','🚗','✈️','📞','💬','🎵','🎮','📺',
];

function Capture({ kind, setKind, onCommit, innerRef }) {
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiAnchor, setEmojiAnchor] = useState(null);
  const emojiBtnRef = useRef(null);
  const recRef = useRef(null);
  const finalRef = useRef('');

  const voiceSupported = typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const stopVoice = useCallback(() => {
    if (recRef.current) {
      try { recRef.current.stop(); } catch (_) {}
      recRef.current = null;
    }
    setListening(false);
  }, []);

  const startVoice = useCallback(() => {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) {
      setVoiceError('voice not supported here');
      setTimeout(() => setVoiceError(null), 3500);
      return;
    }
    setVoiceError(null);
    finalRef.current = '';
    const rec = new Rec();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setValue((finalRef.current + interim).replace(/^\s+/, ''));
    };
    rec.onerror = (e) => {
      setVoiceError(`voice error · ${e.error || 'unknown'}`);
      setTimeout(() => setVoiceError(null), 4000);
      stopVoice();
    };
    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null;
      setListening(false);
      if (innerRef.current) innerRef.current.focus();
    };
    recRef.current = rec;
    setListening(true);
    try { rec.start(); }
    catch (err) {
      setVoiceError(`${err?.message || err}`);
      setTimeout(() => setVoiceError(null), 4000);
      setListening(false);
    }
  }, [innerRef, stopVoice]);

  // Shift+V toggles recording when no text field is focused. Stop on
  // unmount guards against a recognizer leaking if the user hot-reloads
  // or navigates while listening.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const isEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (isEditable) return;
      if (e.key === 'V' && e.shiftKey) {
        e.preventDefault();
        if (listening) stopVoice();
        else startVoice();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stopVoice();
    };
  }, [listening, startVoice, stopVoice]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && value.trim()) {
      stopVoice();
      onCommit({ kind, text: value.trim() });
      setValue('');
      finalRef.current = '';
    }
  };

  const insertEmoji = useCallback((emoji) => {
    const ta = innerRef.current;
    if (!ta) {
      setValue((v) => v + emoji);
    } else {
      const start = ta.selectionStart ?? value.length;
      const end = ta.selectionEnd ?? value.length;
      const next = value.slice(0, start) + emoji + value.slice(end);
      setValue(next);
      // Restore caret position after the inserted emoji on next tick.
      setTimeout(() => {
        if (ta && document.activeElement === ta) {
          const pos = start + emoji.length;
          ta.setSelectionRange(pos, pos);
        }
      }, 0);
    }
    setEmojiOpen(false);
    if (innerRef.current) innerRef.current.focus();
  }, [innerRef, value]);

  // Open the emoji popover. Anchor it to the trigger button's bounding
  // rect, then clamp horizontally + vertically so it never overflows
  // the viewport regardless of where the capture row sits.
  const toggleEmoji = useCallback(() => {
    if (emojiOpen) {
      setEmojiOpen(false);
      return;
    }
    const btn = emojiBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const POPOVER_W = 280;
    const POPOVER_H = 220;
    const margin = 8;
    // Prefer above the button (capture is near the bottom of the
    // viewport); flip below if there isn't room above.
    let top = rect.top - POPOVER_H - margin;
    if (top < margin) top = rect.bottom + margin;
    // Anchor right edge to the button's right edge, then clamp.
    let left = rect.right - POPOVER_W;
    if (left + POPOVER_W > window.innerWidth - margin) {
      left = window.innerWidth - POPOVER_W - margin;
    }
    if (left < margin) left = margin;
    setEmojiAnchor({ top, left, width: POPOVER_W, height: POPOVER_H });
    setEmojiOpen(true);
  }, [emojiOpen]);

  // Close on click-outside / Escape. Listening only when open keeps the
  // global key surface lean.
  useEffect(() => {
    if (!emojiOpen) return undefined;
    const onClick = (e) => {
      const popover = document.getElementById('mb-emoji-popover');
      if (popover && popover.contains(e.target)) return;
      if (emojiBtnRef.current && emojiBtnRef.current.contains(e.target)) return;
      setEmojiOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setEmojiOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [emojiOpen]);

  return (
    <div className="capture">
      <div className="glyphselect" role="radiogroup" aria-label="Entry kind">
        {[['task','▢'],['note','−'],['event','○'],['alert','!']].map(([k, g]) => (
          <button
            key={k}
            aria-pressed={kind === k}
            onClick={() => { setKind(k); innerRef.current && innerRef.current.focus(); }}
            title={k}
          >{g}</button>
        ))}
        {voiceSupported && (
          <button
            type="button"
            className={listening ? 'mic on' : 'mic'}
            onClick={() => { listening ? stopVoice() : startVoice(); }}
            title={listening ? 'Stop recording (shift+V)' : 'Record a bullet (shift+V)'}
            aria-pressed={listening}
            aria-label={listening ? 'stop recording' : 'record voice bullet'}
          >●</button>
        )}
      </div>
      <input
        ref={innerRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        placeholder={listening
          ? 'listening… speak, then press enter'
          : (kind === 'task' ? 'new task…'
              : kind === 'note' ? 'a thought…'
              : kind === 'alert' ? 'a reminder, bill, debt…'
              : 'an event…')}
      />
      <button
        ref={emojiBtnRef}
        type="button"
        className="emoji-btn"
        onClick={toggleEmoji}
        title="Insert emoji"
        aria-label="Insert emoji"
        aria-expanded={emojiOpen}
      >☺</button>
      <span className="hint">{voiceError ? voiceError : 'ENTER'}</span>
      {emojiOpen && emojiAnchor && ReactDOM.createPortal(
        <div
          id="mb-emoji-popover"
          role="dialog"
          aria-label="Emoji picker"
          style={{
            position: 'fixed',
            top: emojiAnchor.top,
            left: emojiAnchor.left,
            width: emojiAnchor.width,
            maxHeight: emojiAnchor.height,
            background: 'var(--bg-panel)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            padding: 8,
            zIndex: 100,
            display: 'grid',
            gridTemplateColumns: 'repeat(10, 1fr)',
            gap: 2,
            overflowY: 'auto',
          }}
        >
          {EMOJI_SET.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => insertEmoji(e)}
              style={{
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                fontSize: '18px',
                cursor: 'pointer',
                padding: '4px 0',
                lineHeight: 1,
              }}
              title={e}
            >{e}</button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function TopNav({ view, setView, dateLabel, onMigrate, onSync, syncing, dark, onToggleDark }) {
  const views = [
    { id: 'daily',   label: 'Daily',   kbd: 'd' },
    { id: 'sketch',  label: 'Sketch',  kbd: 's' },
    { id: 'weekly',  label: 'Weekly',  kbd: 'w' },
    { id: 'monthly', label: 'Monthly', kbd: 'm' },
    { id: 'themes',  label: 'Themes (demo)',  kbd: 't' },
  ];
  // Mobile preview is a design-time surface; hide it in regular use.
  if (window.missionBulletDev) {
    views.push({ id: 'mobile', label: 'Mobile', kbd: '·' });
  }
  return (
    <div className="topnav">
      <div className="trail">
        <span className="brand">MISSION&nbsp;·&nbsp;BULLET</span>
        <span className="date">{dateLabel}</span>
      </div>
      <div className="views">
        {views.map((v) => (
          <button key={v.id} aria-current={view === v.id ? 'true' : 'false'} onClick={() => setView(v.id)}>
            {v.label}<span className="kbd">·{v.kbd}</span>
          </button>
        ))}
        {onSync && (
          <button
            className="sync-btn"
            onClick={onSync}
            disabled={syncing}
            title="Pull from remote, then push local changes (shift+S)"
          >
            {syncing ? 'Syncing…' : 'Sync'}<span className="kbd">·⇧S</span>
          </button>
        )}
        {onMigrate && (
          <button
            className="migrate-btn"
            onClick={onMigrate}
            title="Migrate unfinished tasks forward (shift+M)"
          >
            Migrate<span className="kbd">·⇧M</span>
          </button>
        )}
        {onToggleDark && (
          <button
            className="theme-btn"
            onClick={onToggleDark}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? '☀' : '☾'}
          </button>
        )}
      </div>
    </div>
  );
}

/*
 * SampleDataBanner — marks views that still render canned seed data
 * (weekly / monthly / themes) so you don't mistake them for real
 * reflections on your entries. Goes away once each view gets wired to
 * the real CLI library in a later mb-011 phase.
 */
function SampleDataBanner({ viewName }) {
  return (
    <div
      role="status"
      style={{
        margin: '0 0 20px',
        padding: '8px 14px',
        border: '1px dashed var(--accent)',
        borderRadius: 3,
        background: 'var(--accent-tint, rgba(122, 59, 30, 0.08))',
        fontFamily: 'var(--mono)',
        fontSize: '10.5px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--accent)',
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
      }}
    >
      <span style={{ fontWeight: 600 }}>Design preview</span>
      <span style={{ color: 'var(--ink-muted)', textTransform: 'none', letterSpacing: 'normal', fontSize: '11.5px' }}>
        {viewName} shows sample data — real wiring lands in a later phase.
      </span>
    </div>
  );
}

/* ---------- MigrateModal ---------- */
/*
 * Daily-migration UI. Opens on shift+M or the "Migrate" button in TopNav.
 * Calls window.missionBullet.migrateScan() on open to find the most
 * recent day with open tasks; renders one row per task with an
 * accept/reject/strike segmented control; applies the batch on "Apply"
 * via window.missionBullet.migrateApply(). Parent refetches days after
 * the apply resolves so today's entry shows the carried-forward bullets
 * immediately. Git sync runs automatically in the Electron main process.
 */
const MIGRATE_FROM_RE = /\s*\(from (\d{4}-\d{2}-\d{2})\)\s*$/;

// Peel a `(from YYYY-MM-DD)` provenance suffix off task text for
// display. The raw `t` stays the dictionary key for decisions and
// must match the on-disk line; only the visible label is split.
function splitProvenance(taskText) {
  const m = taskText.match(MIGRATE_FROM_RE);
  if (!m) return { label: taskText, from: null };
  return { label: taskText.slice(0, m.index).trimEnd(), from: m[1] };
}

function MigrateModal({ open, onClose, onApplied }) {
  const [state, setState] = useState('loading');
  const [scan, setScan] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const cardRef = useRef(null);
  const previousFocusRef = useRef(null);

  // Capture the element that had focus before open (typically the
  // Migrate trigger in TopNav) and restore it when we close. Without
  // this, dismissing the modal leaves keyboard focus on document.body,
  // which makes Tab from there feel like the page reset its state.
  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    return () => {
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function') {
        try { prev.focus(); } catch (_) { /* element no longer in DOM */ }
      }
    };
  }, [open]);

  // Move focus inside the modal once content has settled. Picks the
  // first task's currently-selected decision button when there's a
  // task list to act on, otherwise the foot's primary action, then
  // the close button. Re-runs only on state transitions, so flipping
  // a decision mid-modal doesn't yank focus away from the user's
  // pointer.
  useEffect(() => {
    if (!open) return;
    if (state === 'loading' || state === 'applying') return;
    const card = cardRef.current;
    if (!card) return;
    const target =
      card.querySelector('.migrate-choice button[aria-pressed="true"]') ||
      card.querySelector('.migrate-foot button:not(:disabled)') ||
      card.querySelector('.migrate-close');
    if (target && typeof target.focus === 'function') {
      target.focus();
    }
  }, [open, state]);

  useEffect(() => {
    if (!open) return;
    setState('loading');
    setError(null);
    setSummary(null);
    setScan(null);
    setDecisions({});
    let cancelled = false;
    (async () => {
      try {
        if (!window.missionBullet?.migrateScan) {
          throw new Error('migrate bridge unavailable');
        }
        const result = await window.missionBullet.migrateScan({});
        if (cancelled) return;
        setScan(result);
        if (result?.source && Array.isArray(result.source.tasks)) {
          const init = {};
          // Default to 'reject' (leave open, don't migrate) — migration
          // should be a deliberate decision per Carroll's method. Auto-
          // accepting makes the modal a rubber-stamp instead of a review.
          result.source.tasks.forEach((t, i) => { init[`${i}::${t}`] = 'reject'; });
          setDecisions(init);
          setState('choosing');
        } else {
          setState('empty');
        }
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || String(e));
        setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Esc closes — except mid-apply, because cancelling that after a
  // partial commit would leave you wondering whether your strikes
  // actually stuck. Better to wait the second or two for apply to
  // finish, then let him dismiss.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (state !== 'applying') onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, state]);

  if (!open) return null;

  const safeClose = () => { if (state !== 'applying') onClose(); };

  const setDecision = (key, value) => {
    setDecisions((prev) => ({ ...prev, [key]: value }));
  };

  const setAll = (value) => {
    if (!scan?.source) return;
    const next = {};
    scan.source.tasks.forEach((t, i) => { next[`${i}::${t}`] = value; });
    setDecisions(next);
  };

  const apply = async () => {
    if (!scan?.source) return;
    setState('applying');
    setError(null);
    try {
      const payload = {
        sourceDate: scan.source.date,
        destDate: scan.destDate,
        decisions: scan.source.tasks.map((t, i) => ({
          taskText: t,
          decision: decisions[`${i}::${t}`] ?? 'reject',
        })),
      };
      const result = await window.missionBullet.migrateApply(payload);
      setSummary(result);
      setState('done');
      if (onApplied) onApplied(result);
    } catch (e) {
      setError(e?.message || String(e));
      setState('error');
    }
  };

  let body;
  if (state === 'loading') {
    body = <div className="migrate-body muted">scanning recent entries…</div>;
  } else if (state === 'empty') {
    body = (
      <div className="migrate-body">
        <div style={{ marginBottom: 10 }}>
          No unfinished tasks in the last 14 days.
        </div>
        <div className="muted" style={{ fontSize: '13px', fontStyle: 'italic', maxWidth: 420 }}>
          The scan only walks back two weeks. Older open tasks aren't
          surfaced here — if you want to migrate something from further
          back, open that day and edit it directly.
        </div>
      </div>
    );
  } else if (state === 'error') {
    body = (
      <div className="migrate-body">
        <div style={{ color: 'var(--accent)' }}>migrate failed — {error}</div>
      </div>
    );
  } else if (state === 'choosing' || state === 'applying') {
    const { source, destDate } = scan;
    body = (
      <div className="migrate-body">
        <div className="migrate-sub">
          From <strong>{source.date}</strong> &rarr; carry forward to <strong>{destDate}</strong>.
          Pick one decision per task, then Apply. Accept carries it to today;
          strike marks it abandoned with a strikethrough; reject leaves it open.
        </div>
        <div className="migrate-bulkrow">
          <span className="muted">set all to:</span>
          <button onClick={() => setAll('accept')}>accept</button>
          <button onClick={() => setAll('reject')}>reject</button>
          <button onClick={() => setAll('strike')}>strike</button>
        </div>
        <div className="migrate-tasks">
          {source.tasks.map((t, i) => {
            const key = `${i}::${t}`;
            const v = decisions[key] ?? 'accept';
            const { label, from } = splitProvenance(t);
            return (
              <div className="migrate-task" key={key}>
                <div className="migrate-task-text">
                  {label}
                  {from && (
                    <span className="migrate-task-from"> from {from}</span>
                  )}
                </div>
                <div className="migrate-choice" role="radiogroup" aria-label={`decision for task ${i + 1}`}>
                  {['accept','reject','strike'].map((opt) => (
                    <button
                      key={opt}
                      aria-pressed={v === opt}
                      onClick={() => setDecision(key, opt)}
                      disabled={state === 'applying'}
                    >{opt}</button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  } else if (state === 'done') {
    body = (
      <div className="migrate-body">
        <div style={{ marginBottom: 8 }}>
          <strong>{summary.carried}</strong> carried forward,{' '}
          <strong>{summary.struck}</strong> struck,{' '}
          <strong>{summary.rejected}</strong> left open.
          {summary.alreadyPresent > 0 && (
            <div className="muted" style={{ marginTop: 6 }}>
              ({summary.alreadyPresent} already present from a prior migration, skipped.)
            </div>
          )}
          {summary.sourceLinesNotFound > 0 && (
            <div className="muted" style={{ marginTop: 6 }}>
              (Warning: {summary.sourceLinesNotFound} source line(s) couldn't be located for marking
              — likely edited since the scan.)
            </div>
          )}
        </div>
        <div className="muted">Git sync will push automatically.</div>
      </div>
    );
  }

  return (
    <div className="migrate-overlay" onClick={safeClose}>
      <div
        className="migrate-card"
        role="dialog"
        aria-modal="true"
        aria-label="Migrate yesterday's open tasks"
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="migrate-head">
          <span>MIGRATE</span>
          {scan?.source && state !== 'done' && (
            <span className="migrate-head-sub">
              {scan.source.date} &rarr; {scan.destDate}
            </span>
          )}
          <button className="migrate-close" onClick={safeClose} aria-label="close" disabled={state === 'applying'}>×</button>
        </div>
        {body}
        <div className="migrate-foot">
          {state === 'done' ? (
            <button className="migrate-primary" onClick={onClose}>Close</button>
          ) : state === 'choosing' ? (
            <>
              <button onClick={onClose}>Cancel</button>
              <button className="migrate-primary" onClick={apply}>Apply migrations</button>
            </>
          ) : state === 'applying' ? (
            <>
              <button disabled>Cancel</button>
              <button className="migrate-primary" disabled>Applying…</button>
            </>
          ) : (
            <button className="migrate-primary" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ShortcutBar({ view, visible }) {
  const map = {
    daily:   [['j/k','entry'],['←/→','day'],['/','capture'],['⇧v','voice'],['⇧m','migrate'],['⇧s','sync'],['e','edit'],['⇧d','done'],['⇧x','strike'],['s','sketch'],['z','zen']],
    sketch:  [['←/→','day/mo'],['⇧m','migrate'],['⇧s','sync'],['esc','daily']],
    weekly:  [['←/→','week'],['⇧m','migrate'],['⇧s','sync'],['esc','daily']],
    monthly: [['←/→','month'],['e','edit'],['s','sketch'],['⇧m','migrate'],['⇧s','sync'],['esc','daily']],
    themes:  [['⇧m','migrate'],['⇧s','sync'],['esc','daily']],
    mobile:  [['tap','capture'],['•−○','kind'],['⇧m','migrate'],['⇧s','sync']],
  };
  return (
    <div className={'shortcuts' + (visible ? '' : ' hidden')}>
      <div className="grp">
        {map[view].map(([k, label]) => (
          <span key={k}><kbd>{k}</kbd> {label}</span>
        ))}
      </div>
      <div className="grp">
        <span>mission-bullet · the journal does not call for attention</span>
      </div>
    </div>
  );
}

Object.assign(window, {
  entryGlyph, Entry, DateHeader, EntryList, Capture, TopNav, ShortcutBar,
  MigrateModal, SampleDataBanner,
});
