// data.jsx — seed entries, themes, proposals for mission-bullet demo.
// Anchored mid-week on Wed Apr 22, 2026. We provide a 2-week window.

const GLYPHS = {
  task: '•',
  note: '−',
  event: '○',
  migrated: '>',
  cancelled: '×',
  done: '✕', // rendered as a struck bullet in practice; data uses kind instead
};

// days go oldest → newest, "today" is last.
const SEED_DAYS = [
  {
    date: '2026-04-13', dow: 'MON', weekLabel: 'W16',
    entries: [
      { id: 'e001', kind: 'event', time: '09:00', text: 'Quarterly planning kickoff' },
      { id: 'e002', kind: 'task', time: '10:30', text: 'Send budget draft to Maya', status: 'done' },
      { id: 'e003', kind: 'note', time: '14:10', text: 'The shape of a good week is decided by Monday — who I say yes to sets the frame.' },
      { id: 'e004', kind: 'task', time: '17:20', text: 'Book dentist' },
    ],
  },
  {
    date: '2026-04-14', dow: 'TUE', weekLabel: 'W16',
    entries: [
      { id: 'e010', kind: 'task', time: '08:45', text: 'Review PR #482 — capture surface', status: 'done' },
      { id: 'e011', kind: 'note', time: '11:20', text: 'Noticed I keep resisting synchronous meetings before lunch. Writing needs the morning.' },
      { id: 'e012', kind: 'task', time: '15:30', text: 'Pick up prescription' },
      { id: 'e013', kind: 'task', time: '16:00', text: 'Call landlord about radiator', status: 'migrated' },
    ],
  },
  {
    date: '2026-04-15', dow: 'WED', weekLabel: 'W16',
    entries: [
      { id: 'e020', kind: 'event', time: '09:30', text: '1:1 with Dev' },
      { id: 'e021', kind: 'note', time: '09:55', text: 'Dev asked what "done" means for the migration project. I did not have a clean answer. Worth writing down.' },
      { id: 'e022', kind: 'task', time: '13:00', text: 'Draft definition of done — migration' },
      { id: 'e023', kind: 'task', time: '18:00', text: 'Grocery run' },
    ],
  },
  {
    date: '2026-04-16', dow: 'THU', weekLabel: 'W16',
    entries: [
      { id: 'e030', kind: 'task', time: '10:00', text: 'Tax docs to accountant', status: 'cancelled' },
      { id: 'e031', kind: 'note', time: '12:40', text: 'Lunch with K. She mentioned her father is unwell. Send a note this week.' },
      { id: 'e032', kind: 'event', time: '19:00', text: 'Pottery class — second session' },
    ],
  },
  {
    date: '2026-04-17', dow: 'FRI', weekLabel: 'W16',
    entries: [
      { id: 'e040', kind: 'task', time: '09:15', text: 'Write quarterly letter — first draft', status: 'migrated' },
      { id: 'e041', kind: 'note', time: '16:30', text: 'Week felt fragmented. I spent more time in chat than in editors. Not sure that was the right trade.' },
    ],
  },
  {
    date: '2026-04-20', dow: 'MON', weekLabel: 'W17',
    entries: [
      { id: 'e050', kind: 'event', time: '09:00', text: 'Standup' },
      { id: 'e051', kind: 'task', time: '10:00', text: 'Weekly review (W16)', status: 'done' },
      { id: 'e052', kind: 'task', time: '11:45', text: 'Call landlord about radiator', status: 'done' },
      { id: 'e053', kind: 'note', time: '15:20', text: 'Reading — Carroll, "the bullet journal method". The point is the act of keeping, not the archive.' },
      { id: 'e054', kind: 'task', time: '17:30', text: 'Pay utilities' },
    ],
  },
  {
    date: '2026-04-21', dow: 'TUE', weekLabel: 'W17',
    entries: [
      { id: 'e060', kind: 'task', time: '08:30', text: 'Write quarterly letter — first draft', status: 'done' },
      { id: 'e061', kind: 'event', time: '11:00', text: 'Design review — mission-bullet' },
      { id: 'e062', kind: 'note', time: '11:48', text: 'Team aligned on the migration model. Strong signal: nobody asked for a "share" button.' },
      { id: 'e063', kind: 'task', time: '14:00', text: 'Send K a note', status: 'done' },
      { id: 'e064', kind: 'task', time: '16:40', text: 'Pick up framed print' },
    ],
  },
  // TODAY — mid-week Wed Apr 22 2026
  {
    date: '2026-04-22', dow: 'WED', weekLabel: 'W17', isToday: true,
    entries: [
      { id: 'e070', kind: 'event', time: '09:30', text: '1:1 with Dev — migration status', status: 'done' },
      { id: 'e071', kind: 'note', time: '09:58', text: 'We landed on a working definition: a migrated task is one that has been moved forward deliberately, not carried by default. The distinction matters.' },
      { id: 'e072', kind: 'task', time: '10:40', text: 'Review PR #501 — monthly log polish', status: 'done' },
      { id: 'e073', kind: 'task', time: '13:00', text: 'Finalize Q2 budget line for travel' },
      { id: 'e074', kind: 'note', time: '13:42', text: 'Thinking about how much of my week is reactive. The journal is the first place I\'ve noticed this pattern clearly.' },
      { id: 'e075', kind: 'event', time: '15:00', text: 'Coffee — Amelia (catch-up)' },
      { id: 'e076', kind: 'task', time: '17:00', text: 'Draft a migration rule for next week' },
      { id: 'e077', kind: 'task', time: '18:30', text: 'Grocery run' },
      { id: 'e078', kind: 'note', time: '20:10', text: 'Pottery instructor said something good: "the wheel is a teacher of patience, not of pots." Writing it here so I don\'t lose it.' },
    ],
  },
];


// weekly review for W16 (last full week)
const WEEKLY_W16 = {
  range: 'APR 13 — APR 17',
  label: 'WEEK 16',
  lede: 'A fragmented week. More movement than progress; more chat than writing. The notes from Tue and Fri agree on the same thing: mornings were given away before they were used.',
  tally: [
    { num: 34, unit: '', lbl: 'entries' },
    { num: 18, unit: '', lbl: 'tasks' },
    { num: 13, unit: '', lbl: 'done' },
    { num: 3, unit: '', lbl: 'migrated' },
  ],
  proposals: [
    {
      id: 'p1',
      tag: 'MIGRATE',
      summary: 'Carry the quarterly letter draft to Mon W17. You named it as unfinished on Fri 17, and Mon is unblocked.',
      from: 'Fri 04-17 — "Write quarterly letter, first draft"',
      status: 'pending',
    },
    {
      id: 'p2',
      tag: 'RULE',
      summary: 'Hold Tue and Thu mornings for solo writing. Your notes on Tue 14 and Fri 17 both flag morning-fragmentation.',
      from: 'Tue 04-14 11:20 + Fri 04-17 16:30',
      status: 'pending',
    },
    {
      id: 'p3',
      tag: 'REACH-OUT',
      summary: 'Follow up with K — her father. You flagged it Thu and have not marked it done.',
      from: 'Thu 04-16 12:40',
      status: 'pending',
    },
  ],
};

// monthly review (April)
const MONTHLY_APR = {
  range: 'APRIL 2026',
  lede: 'April had two registers. The first half was scattered across small commitments; the second half consolidated around the migration project and the quarterly letter. The journal itself began on Apr 6 — a short run, but enough to see the shape of things.',
  tally: [
    { num: 126, unit: '', lbl: 'entries' },
    { num: 68, unit: '', lbl: 'tasks' },
    { num: 41, unit: '', lbl: 'done' },
    { num: 14, unit: '', lbl: 'migrated' },
  ],
  // month grid: 5x7 (29 days visible for April 2026 — starts Wed)
  // April 2026: 1 = Wed. so row1: _ _ _ W1 T2 F3 S4 etc.
  monthCells: (() => {
    // April 2026: Apr 1 is Wednesday. 30 days. We'll render a 6-row grid.
    const cells = [];
    // pre-April (Mar 30, 31)
    cells.push({ d: '30', other: true });
    cells.push({ d: '31', other: true });
    // Apr 1..30
    const activity = {
      1: ['t'], 2: ['t'], 3: ['n'], 6: ['t','t','n'], 7: ['t','e'], 8: ['t','n'], 9: ['t'],
      10: ['t'], 13: ['t','t','n','e'], 14: ['t','n','t','m'], 15: ['t','t','n','e','t'],
      16: ['t','n','e'], 17: ['t','m','n'], 20: ['e','t','t','n','t'],
      21: ['t','e','n','t','t'], 22: ['e','n','t','t','n','e','t','t','n'],
      23: [], 24: [], 27: [], 28: [], 29: [], 30: [],
    };
    for (let d = 1; d <= 30; d++) {
      const acts = activity[d] || [];
      cells.push({
        d: String(d),
        other: false,
        today: d === 22,
        dots: acts.slice(0, 6).map(a => ({
          m: a === 'm', e: a === 'e',
        })),
      });
    }
    // trailing May 1,2 to fill row
    const trailing = 6 * 7 - cells.length;
    for (let i = 1; i <= trailing; i++) cells.push({ d: String(i), other: true });
    return cells;
  })(),
  themes: ['migration as deliberate act', 'morning-fragmentation', 'written vs typed'],
  closing: 'The tools you return to are the ones that make the thinking visible. The journal surfaced two working rules this month; those are the keepers.',
};

// theme discovery
const THEMES = [
  {
    name: 'MIGRATION AS A DELIBERATE ACT',
    summary: 'A pattern across 11 entries this month: tasks that move forward should do so by decision, not by default. Most productivity systems fail this test silently.',
    instances: [
      { date: 'Apr 15', snippet: '…what "done" means for the migration project. I did not have a clean answer.' },
      { date: 'Apr 17', snippet: 'I spent more time in chat than in editors. Not sure that was the right trade.' },
      { date: 'Apr 22', snippet: 'A migrated task is one that has been moved forward deliberately, not carried by default.' },
    ],
  },
  {
    name: 'MORNING FRAGMENTATION',
    summary: 'Writing happens in the morning or it does not happen. Six entries across April pointed to the same conclusion, independently.',
    instances: [
      { date: 'Apr 14', snippet: 'I keep resisting synchronous meetings before lunch. Writing needs the morning.' },
      { date: 'Apr 17', snippet: 'Week felt fragmented. I spent more time in chat than in editors.' },
      { date: 'Apr 22', snippet: 'Thinking about how much of my week is reactive.' },
    ],
  },
  {
    name: 'TEACHERS OF PATIENCE',
    summary: 'A softer thread — entries that name a thing outside work (pottery, reading, a walk) that taught a rule you then apply at the desk.',
    instances: [
      { date: 'Apr 16', snippet: 'Pottery class — second session.' },
      { date: 'Apr 20', snippet: 'The point is the act of keeping, not the archive.' },
      { date: 'Apr 22', snippet: '"The wheel is a teacher of patience, not of pots."' },
    ],
  },
];

Object.assign(window, {
  GLYPHS, SEED_DAYS, WEEKLY_W16, MONTHLY_APR, THEMES,
});
