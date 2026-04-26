// views.jsx — review/theme/mobile/weekly/monthly views for mission-bullet

const { useState: _useState, useEffect: _useEffect } = React;

// Real-data weekly view. Reads `reflections/YYYY-WNN.md` produced by
// `bullet review week`. Empty state when the file doesn't exist —
// the canned demo content is gone (was a trust trap).
function WeeklyView({ weekly, weekSpec, dateRange, loading, running, onRunReview }) {
  if (loading) {
    return (
      <div className="empty muted" style={{ maxWidth: 520, margin: '32px auto', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        loading reflection…
      </div>
    );
  }
  const headerRange = dateRange ? `${dateRange.start} → ${dateRange.end}` : '';
  const runButton = onRunReview && (
    <button
      onClick={() => onRunReview(weekSpec)}
      disabled={running}
      style={{
        appearance: 'none',
        background: running ? 'transparent' : 'var(--accent)',
        color: running ? 'var(--ink-muted)' : '#fff',
        border: running ? '1px solid var(--rule)' : 'none',
        padding: '8px 18px',
        fontFamily: 'var(--mono)',
        fontSize: '11px',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        borderRadius: 3,
        cursor: running ? 'wait' : 'pointer',
      }}
    >{running ? 'Running review…' : 'Run weekly review'}</button>
  );
  if (!weekly) {
    return (
      <div className="review">
        <h2>
          <span className="kicker">{weekSpec || ''}</span>
          Weekly review · {headerRange}
        </h2>
        <p className="lede">
          No reflection for this week yet.
        </p>
        <p className="muted" style={{ fontSize: '14.5px' }}>
          Click below to surface themes and migration candidates from
          your daily entries. The model decides nothing — every
          migration starts deferred and you flip them later.
        </p>
        <div style={{ marginTop: 18 }}>{runButton}</div>
        <p className="muted" style={{ fontSize: '13px', fontStyle: 'italic', marginTop: 18 }}>
          Use ← / → to look at prior or upcoming weeks.
        </p>
      </div>
    );
  }
  const themes = weekly.themes || [];
  const migrations = weekly.migrations || [];
  return (
    <div className="review">
      <h2>
        <span className="kicker">{weekly.weekSpec}</span>
        Weekly review · {weekly.startDate} → {weekly.endDate}
      </h2>
      <p className="lede">
        {weekly.entriesReviewed.length} entr{weekly.entriesReviewed.length === 1 ? 'y' : 'ies'} reviewed.
      </p>

      <h2><span className="kicker">AI-surfaced</span>Themes</h2>
      {themes.length === 0 ? (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: '14.5px' }}>
          (no themes surfaced this week)
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px' }}>
          {themes.map((t, i) => (
            <li key={i} style={{ borderBottom: '1px solid var(--rule)', padding: '10px 0' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: '12.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>
                <span style={{ color: 'var(--ink-faint)' }}>{String(i + 1).padStart(2, '0')}&nbsp;·&nbsp;</span>
                {t.label}
              </div>
              <div className="muted" style={{ fontSize: '12.5px', marginTop: 4 }}>
                {(t.entries_mentioning || []).length} mention{(t.entries_mentioning || []).length === 1 ? '' : 's'}
                {t.entries_mentioning && t.entries_mentioning.length > 0 && (
                  <span> · {t.entries_mentioning.join(', ')}</span>
                )}
              </div>
              {t.notes && (
                <div style={{ fontSize: '14px', marginTop: 6, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
                  {t.notes}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2><span className="kicker">AI-surfaced</span>Migration candidates</h2>
      {migrations.length === 0 ? (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: '14.5px' }}>
          (no migration candidates this week)
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px' }}>
          {migrations.map((m, i) => (
            <li key={i} style={{ borderBottom: '1px solid var(--rule)', padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '10px',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: m.user_decision === 'accept' ? 'var(--accent)' : 'var(--ink-faint)',
                    border: '1px solid var(--rule)',
                    padding: '2px 6px',
                    borderRadius: 2,
                    minWidth: 60,
                    textAlign: 'center',
                  }}
                >
                  {m.user_decision || 'pending'}
                </span>
                <span style={{ fontSize: '14.5px' }}>{m.source_text_fragment}</span>
              </div>
              <div className="muted" style={{ fontSize: '12px', marginTop: 4, marginLeft: 72 }}>
                from {m.source_entry_date} · {m.reason_for_surfacing}
                {m.migrated_to && <span> · → {m.migrated_to}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {weekly.userNotes && weekly.userNotes.trim() && (
        <>
          <h2><span className="kicker">Your notes</span>From this review</h2>
          <pre style={{
            fontFamily: 'var(--serif)',
            fontSize: '15.5px',
            lineHeight: '1.65',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: 0,
            color: 'var(--ink-body)',
          }}>{weekly.userNotes}</pre>
        </>
      )}

      <hr className="hair-rule" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {runButton}
        <span className="muted" style={{ fontStyle: 'italic', fontSize: '13.5px' }}>
          Re-running overwrites this reflection.  Use ← / → to navigate weeks.
        </span>
      </div>
    </div>
  );
}

// Compact monthly-review panel rendered ABOVE the monthly log
// (Calendar/Goals/Bills) inside MonthlyLogView. The monthly LOG and
// monthly REVIEW are different surfaces — log is forward-looking
// commitments, review is the AI-surfaced themes / migration
// candidates from the month's daily entries — so they share the tab
// but live in stacked panels rather than fighting for the same view.
//
// Shape mirrors WeeklyView's empty-state + button pattern: cream
// panel with rust "Run monthly review" button, theme/migration
// list + Re-run button when a reflection already exists. No
// terminal hint anywhere — the whole point of the GUI run-review
// flow is that you never have to drop into a shell.
function MonthlyReviewPanel({ reflection, monthSpec, loading, running, onRunReview }) {
  const runButton = onRunReview && (
    <button
      onClick={() => onRunReview(monthSpec)}
      disabled={running}
      style={{
        appearance: 'none',
        background: running ? 'transparent' : 'var(--accent)',
        color: running ? 'var(--ink-muted)' : '#fff',
        border: running ? '1px solid var(--rule)' : 'none',
        padding: '8px 18px',
        fontFamily: 'var(--mono)',
        fontSize: '11px',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        borderRadius: 3,
        cursor: running ? 'wait' : 'pointer',
      }}
    >{running ? 'Running review…' : 'Run monthly review'}</button>
  );

  const panelStyle = {
    border: '1px solid var(--rule)',
    borderRadius: 4,
    padding: '18px 22px',
    marginBottom: 28,
    background: 'var(--bg-panel)',
  };

  if (loading) {
    return (
      <div style={panelStyle}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
          Monthly review · loading reflection…
        </div>
      </div>
    );
  }

  if (!reflection) {
    return (
      <div style={panelStyle}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: 8 }}>
          Monthly review · {monthSpec}
        </div>
        <p className="muted" style={{ fontSize: '14px', marginTop: 4, marginBottom: 12 }}>
          No reflection for this month yet. Click below to surface
          themes and migration candidates from your daily entries.
          The model decides nothing — every migration starts deferred
          and you flip them later.
        </p>
        <div>{runButton}</div>
      </div>
    );
  }

  const themes = reflection.themes || [];
  const migrations = reflection.migrations || [];
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
          Monthly review · {reflection.monthSpec}
          {reflection.startDate && reflection.endDate && (
            <span style={{ color: 'var(--ink-faint)' }}>
              {' · '}{reflection.startDate} → {reflection.endDate}
            </span>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: '12px' }}>
          {reflection.entriesReviewed.length} entr{reflection.entriesReviewed.length === 1 ? 'y' : 'ies'} reviewed
        </span>
      </div>

      <h3 style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', margin: '14px 0 6px' }}>
        AI-surfaced themes
      </h3>
      {themes.length === 0 ? (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: '14px', margin: '0 0 10px' }}>
          (no themes surfaced this month)
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px' }}>
          {themes.map((t, i) => (
            <li key={i} style={{ borderBottom: '1px solid var(--rule)', padding: '8px 0' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: '12px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>
                <span style={{ color: 'var(--ink-faint)' }}>{String(i + 1).padStart(2, '0')}&nbsp;·&nbsp;</span>
                {t.label}
              </div>
              <div className="muted" style={{ fontSize: '12px', marginTop: 3 }}>
                {(t.entries_mentioning || []).length} mention{(t.entries_mentioning || []).length === 1 ? '' : 's'}
                {t.entries_mentioning && t.entries_mentioning.length > 0 && (
                  <span> · {t.entries_mentioning.join(', ')}</span>
                )}
              </div>
              {t.notes && (
                <div style={{ fontSize: '13.5px', marginTop: 4, fontStyle: 'italic', color: 'var(--ink-muted)' }}>
                  {t.notes}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', margin: '14px 0 6px' }}>
        AI-surfaced migration candidates
      </h3>
      {migrations.length === 0 ? (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: '14px', margin: '0 0 10px' }}>
          (no migration candidates this month)
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px' }}>
          {migrations.map((m, i) => (
            <li key={i} style={{ borderBottom: '1px solid var(--rule)', padding: '8px 0' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '10px',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: m.user_decision === 'accept' ? 'var(--accent)' : 'var(--ink-faint)',
                    border: '1px solid var(--rule)',
                    padding: '2px 6px',
                    borderRadius: 2,
                    minWidth: 60,
                    textAlign: 'center',
                  }}
                >
                  {m.user_decision || 'pending'}
                </span>
                <span style={{ fontSize: '14px' }}>{m.source_text_fragment}</span>
              </div>
              <div className="muted" style={{ fontSize: '12px', marginTop: 3, marginLeft: 70 }}>
                from {m.source_entry_date} · {m.reason_for_surfacing}
                {m.migrated_to && <span> · → {m.migrated_to}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {reflection.userNotes && reflection.userNotes.trim() && (
        <>
          <h3 style={{ fontFamily: 'var(--mono)', fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', margin: '14px 0 6px' }}>
            Your notes
          </h3>
          <pre style={{
            fontFamily: 'var(--serif)',
            fontSize: '14.5px',
            lineHeight: '1.6',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: '0 0 14px',
            color: 'var(--ink-body)',
          }}>{reflection.userNotes}</pre>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        {runButton}
        <span className="muted" style={{ fontStyle: 'italic', fontSize: '12.5px' }}>
          Re-running overwrites this reflection.
        </span>
      </div>
    </div>
  );
}

function WeeklyReview({ data, proposals, onProposal }) {
  return (
    <div className="review">
      <h2>
        <span className="kicker">{data.range}</span>
        Weekly Review · {data.label}
      </h2>
      <p className="lede">{data.lede}</p>

      <div className="tally">
        {data.tally.map((t, i) => (
          <div key={i} className="cell">
            <div className="num">{t.num}<span className="unit">{t.unit}</span></div>
            <div className="lbl">{t.lbl}</div>
          </div>
        ))}
      </div>

      <h2><span className="kicker">AI-surfaced</span>Proposals for next week</h2>
      <p className="muted" style={{ fontSize: '14.5px' }}>
        Three proposals drawn from your entries. The AI suggests; you decide. Accepted items appear on next week's daily page with their origin preserved.
      </p>

      {proposals.map((p) => (
        <div key={p.id} className={'proposal ' + (p.status === 'accepted' ? 'accepted' : p.status === 'dismissed' ? 'dismissed' : '')}>
          <div className="tag">{p.tag}<br/>PROPOSED</div>
          <div className="proposal-body">
            {p.summary}
            <span className="from">from {p.from}</span>
          </div>
          <div className="actions">
            <button className="accept" onClick={() => onProposal(p.id, 'accepted')}>Accept&nbsp;·&nbsp;a</button>
            <button onClick={() => onProposal(p.id, 'dismissed')}>Dismiss&nbsp;·&nbsp;d</button>
          </div>
        </div>
      ))}

      <hr className="hair-rule" />
      <p className="muted" style={{ fontStyle: 'italic', fontSize: '14.5px' }}>
        The review is a reading surface. Dotted grids fade here — write in the daily log, think here.
      </p>
    </div>
  );
}

function MonthlyReview({ data }) {
  const headings = ['M','T','W','T','F','S','S'];
  return (
    <div className="review">
      <h2>
        <span className="kicker">Monthly Review</span>
        {data.range}
      </h2>
      <p className="lede">{data.lede}</p>

      <div className="tally">
        {data.tally.map((t, i) => (
          <div key={i} className="cell">
            <div className="num">{t.num}<span className="unit">{t.unit}</span></div>
            <div className="lbl">{t.lbl}</div>
          </div>
        ))}
      </div>

      <h2><span className="kicker">Calendar</span>Shape of the month</h2>
      <div className="monthgrid">
        {headings.map((h, i) => <div key={'h'+i} className="cell head">{h}</div>)}
        {data.monthCells.map((c, i) => (
          <div key={i} className={'cell' + (c.other ? ' other' : '') + (c.today ? ' today' : '')}>
            <span className="d">{c.d}</span>
            {c.dots && c.dots.length > 0 && (
              <div className="dots">
                {c.dots.map((d, j) => (
                  <i key={j} className={d.m ? 'm' : d.e ? 'e' : ''}></i>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <h2><span className="kicker">Themes lifted</span>Three patterns worth keeping</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px' }}>
        {data.themes.map((t, i) => (
          <li key={i} style={{ fontFamily: 'var(--mono)', fontSize: '12.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)', padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
            <span style={{ color: 'var(--ink-faint)' }}>0{i+1}&nbsp;·&nbsp;</span>{t}
          </li>
        ))}
      </ul>

      <p style={{ fontStyle: 'italic', color: 'var(--ink-muted)' }}>{data.closing}</p>
    </div>
  );
}

function ThemesView({ themes }) {
  return (
    <div className="review">
      <h2>
        <span className="kicker">Theme Discovery</span>
        Patterns across April
      </h2>
      <p className="lede">
        Three threads the AI surfaced from entries that share a vocabulary. Each is an invitation, not a conclusion — if a theme is load-bearing, you rewrite it in your own words during monthly review.
      </p>
      <p className="muted" style={{ fontSize: '14px' }}>
        The AI does not author. It clusters your words and shows you where they repeat.
      </p>

      {themes.map((t, i) => (
        <div key={i} className="theme-card">
          <div className="theme-name">{t.name}</div>
          <div className="theme-summary">{t.summary}</div>
          <div className="instances">
            {t.instances.map((inst, j) => (
              <div key={j} className="inst">
                <span className="date">{inst.date}</span>
                <span className="snippet">{inst.snippet}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MobilePreview({ day, onCommit }) {
  const [kind, setKind] = _useState('task');
  const [val, setVal] = _useState('');
  return (
    <div className="mobile-frame">
      <div className="notch"></div>
      <div className="mobile-inner">
        <div className="mobile-body">
          <div className="mobile-heading">
            {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}
            &nbsp;·&nbsp;{day.entries.length} ENTRIES
          </div>
          {day.entries.map((e) => (
            <div key={e.id} className={'entry' + (e.status === 'done' ? ' done' : '') + (e.status === 'migrated' ? ' migrated' : '') + (e.status === 'cancelled' ? ' cancelled' : '')}>
              <span className="glyph">{entryGlyph(e)}</span>
              <span className="body">{e.text}</span>
              <span className="time">{e.time}</span>
            </div>
          ))}
        </div>
        <div className="mobile-capture">
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) { onCommit({ kind, text: val.trim() }); setVal(''); } }}
            placeholder="capture…"
          />
          <div className="row">
            <div className="glyphs">
              {[['task','•'],['note','−'],['event','○']].map(([k, g]) => (
                <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{g}</button>
              ))}
            </div>
            <span className="send">ENTER</span>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { WeeklyView, WeeklyReview, MonthlyReview, ThemesView, MobilePreview });
