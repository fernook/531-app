// ---------- Storage ----------
const STATE_KEY = '531-state-v1';
const SESSION_KEY = '531-session-v1';

const defaultState = {
  tms: { squat: 210, bench: 180, deadlift: 220, ohp: 120 },
  cycle: 1,
  week: 1,                // 1..4
  daysDoneThisWeek: [],   // subset of [1, 2]
  pullVariant: 'pullup',  // alternates each Day 1
  history: [],            // sessions, newest last
};

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return structuredClone(defaultState);
    return { ...structuredClone(defaultState), ...JSON.parse(raw) };
  } catch {
    return structuredClone(defaultState);
  }
}
function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveSession() {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

let state = loadState();
let session = loadSession();
let view = session ? 'session' : 'home';
let modal = null;

// ---------- Domain ----------
const lifts = {
  squat:    { name: 'Squat',    type: 'lower' },
  bench:    { name: 'Bench',    type: 'upper' },
  deadlift: { name: 'Deadlift', type: 'lower' },
  ohp:      { name: 'OHP',      type: 'upper' },
};

const days = {
  1: { name: 'Day 1 — Squat + Bench',  short: 'Day 1', lifts: ['squat', 'bench'] },
  2: { name: 'Day 2 — Deadlift + OHP', short: 'Day 2', lifts: ['deadlift', 'ohp'] },
};

const weekSchemes = {
  1: { name: '5s',    sets: [[65,5,false],[75,5,false],[85,5,true]],  fsl: true },
  2: { name: '3s',    sets: [[70,3,false],[80,3,false],[90,3,true]],  fsl: true },
  3: { name: '5/3/1', sets: [[75,5,false],[85,3,false],[95,1,true]],  fsl: true },
  4: { name: 'Deload', sets: [[40,5,false],[50,5,false],[60,5,false]], fsl: false },
};

const round5 = (w) => Math.floor(w / 5) * 5;
const fmtPct = (p) => `${Math.round(p * 100)}%`;

// ---------- Plate math ----------
// User's physical inventory, expressed as pairs available per side (loading is symmetric).
// Edit these counts when plates are added/removed. Largest first.
// NOTE: user has 1 lone 2.5 lb plate — unusable for symmetric loading, so 2.5s are omitted.
const BAR = 45;
const PLATES_PER_SIDE = [
  { weight: 45, count: 2 },
  { weight: 35, count: 1 },
  { weight: 25, count: 1 },
  { weight: 10, count: 1 },
  { weight: 5,  count: 2 },
];

function plateMath(total) {
  if (total < BAR) return { ok: false, reason: `Below bar (${BAR})`, per: [] };
  if (total === BAR) return { ok: true, bar: true, per: [] };
  let remaining = (total - BAR) / 2;
  const per = [];
  for (const { weight, count } of PLATES_PER_SIDE) {
    const n = Math.min(count, Math.floor(remaining / weight + 1e-9));
    if (n > 0) per.push({ weight, n });
    remaining -= n * weight;
  }
  remaining = Math.round(remaining * 100) / 100;
  if (remaining > 0.01) return { ok: false, reason: `Short ${remaining} lb/side`, short: remaining, per };
  return { ok: true, per };
}

function formatPlates(pm) {
  if (pm.ok && pm.bar) return 'Bar only';
  const parts = pm.per.map(({ weight, n }) => n > 1 ? `${n}×${weight}` : `${weight}`);
  const list = parts.join(' + ');
  if (pm.ok) return `${list} /side`;
  if (parts.length === 0) return pm.reason;
  const hint = Math.abs(pm.short - 2.5) < 0.01 ? 'buy a 2.5 lb pair' : 'buy more plates';
  return `Closest: ${list} /side — short ${pm.short}, ${hint}`;
}

function nextDay() {
  if (state.daysDoneThisWeek.length === 0) return 1;
  if (state.daysDoneThisWeek.includes(1) && !state.daysDoneThisWeek.includes(2)) return 2;
  if (state.daysDoneThisWeek.includes(2) && !state.daysDoneThisWeek.includes(1)) return 1;
  return 1;
}

function buildLiftBlock(lift, week, tm) {
  const scheme = weekSchemes[week];
  const steps = [];

  // Warm-up
  steps.push({ id: cryptoId(), kind: 'warmup', label: 'Empty bar', weight: 45, reps: '5–8', done: false });
  [[0.40, 5], [0.50, 5], [0.60, 3]].forEach(([pct, reps]) => {
    steps.push({ id: cryptoId(), kind: 'warmup', label: `${fmtPct(pct)} warm-up`, weight: round5(tm * pct), reps, done: false });
  });

  // Working
  scheme.sets.forEach(([pct, reps, isAmrap], i) => {
    const cap = isAmrap && lift === 'deadlift' ? reps + 3 : null;
    steps.push({
      id: cryptoId(),
      kind: isAmrap ? 'amrap' : 'working',
      label: `Set ${i + 1}`,
      weight: round5(tm * pct / 100),
      reps,
      isAmrap,
      amrapCap: cap,
      amrapReps: null,
      done: false,
    });
  });

  // FSL: 3 sets default, user can add more
  if (scheme.fsl) {
    const fslWeight = round5(tm * scheme.sets[0][0] / 100);
    for (let i = 0; i < 3; i++) {
      steps.push({
        id: cryptoId(),
        kind: 'fsl',
        label: `FSL ${i + 1}`,
        weight: fslWeight,
        reps: 5,
        done: false,
        optional: lift === 'deadlift',
      });
    }
  }

  return {
    kind: 'mainLift',
    lift,
    name: lifts[lift].name,
    tm,
    weekName: scheme.name,
    fslWeight: scheme.fsl ? round5(tm * scheme.sets[0][0] / 100) : null,
    canAddFsl: scheme.fsl,
    steps,
  };
}

function buildSession(dayNum) {
  const blocks = [];
  days[dayNum].lifts.forEach((lift) => {
    blocks.push(buildLiftBlock(lift, state.week, state.tms[lift]));
  });

  if (dayNum === 1) {
    blocks.push({
      kind: 'assistance',
      name: state.pullVariant === 'pullup' ? 'Pull-ups' : 'Chin-ups',
      target: 'Total 25–50 reps, any rep scheme',
      reps: null,
      done: false,
    });
    blocks.push({
      kind: 'assistance',
      name: 'Face pulls / band pull-aparts',
      target: '30–50 total reps',
      reps: null,
      done: false,
      optional: true,
    });
  } else {
    blocks.push({
      kind: 'assistanceSets',
      name: 'Barbell rows',
      target: '3 × 8–10',
      sets: [
        { id: cryptoId(), label: 'Set 1', weight: 125, reps: '8–10', done: false },
        { id: cryptoId(), label: 'Set 2', weight: 125, reps: '8–10', done: false },
        { id: cryptoId(), label: 'Set 3', weight: 125, reps: '8–10', done: false },
      ],
    });
    blocks.push({
      kind: 'assistance',
      name: 'Dips or push-ups',
      target: '2–3 sets',
      reps: null,
      done: false,
      optional: true,
    });
  }

  return {
    cycle: state.cycle,
    week: state.week,
    weekName: weekSchemes[state.week].name,
    day: dayNum,
    startedAt: Date.now(),
    blocks,
    notes: '',
    rest: null, // { startedAt: ms }
  };
}

function cryptoId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- Session control ----------
function startSession(dayNum) {
  session = buildSession(dayNum);
  saveSession();
  view = 'session';
  render();
}

function cancelSession() {
  modal = {
    title: 'Cancel session?',
    body: 'This will discard the current session without logging it.',
    actions: [
      { label: 'Discard session', kind: 'danger', onClick: () => {
        session = null; saveSession();
        view = 'home'; modal = null; render();
      }},
      { label: 'Keep going', kind: 'ghost', onClick: () => { modal = null; render(); }},
    ],
  };
  render();
}

function finishSession() {
  // Build summary entry
  const summary = summariseSession(session);
  state.history.push(summary);

  // Mark day done; rotate pull variant if Day 1 completed
  if (session.day === 1) {
    state.pullVariant = state.pullVariant === 'pullup' ? 'chinup' : 'pullup';
  }
  if (!state.daysDoneThisWeek.includes(session.day)) state.daysDoneThisWeek.push(session.day);

  // Advance week if both days done
  if (state.daysDoneThisWeek.includes(1) && state.daysDoneThisWeek.includes(2)) {
    state.daysDoneThisWeek = [];
    if (state.week < 4) {
      state.week += 1;
    } else {
      // Cycle complete — bump TMs (+5 upper, +10 lower), reset to week 1
      state.cycle += 1;
      state.week = 1;
      Object.keys(state.tms).forEach((k) => {
        state.tms[k] += lifts[k].type === 'upper' ? 5 : 10;
      });
    }
  }

  session = null;
  saveState();
  saveSession();
  view = 'home';
  toast('Session logged');
  render();
}

function summariseSession(s) {
  const lifts = [];
  s.blocks.forEach((b) => {
    if (b.kind === 'mainLift') {
      const top = b.steps.find((st) => st.isAmrap);
      const topReps = top && top.amrapReps != null ? top.amrapReps : (top ? top.reps : null);
      lifts.push({
        lift: b.lift,
        name: b.name,
        topWeight: top ? top.weight : null,
        topReps,
        targetReps: top ? top.reps : null,
        isAmrap: top ? top.isAmrap : false,
      });
    }
  });
  return {
    date: new Date(s.startedAt).toISOString(),
    cycle: s.cycle,
    week: s.week,
    weekName: s.weekName,
    day: s.day,
    lifts,
    notes: s.notes,
  };
}

function toggleStep(blockIdx, stepId) {
  const block = session.blocks[blockIdx];
  const step = block.steps.find((s) => s.id === stepId);
  step.done = !step.done;
  if (step.done) startRest();
  saveSession();
  render();
}

function setAmrapReps(blockIdx, stepId, reps) {
  const step = session.blocks[blockIdx].steps.find((s) => s.id === stepId);
  step.amrapReps = reps;
  saveSession();
}

function addFslSet(blockIdx) {
  const block = session.blocks[blockIdx];
  if (!block.canAddFsl) return;
  const count = block.steps.filter((s) => s.kind === 'fsl').length;
  block.steps.push({
    id: cryptoId(),
    kind: 'fsl',
    label: `FSL ${count + 1}`,
    weight: block.fslWeight,
    reps: 5,
    done: false,
    optional: block.lift === 'deadlift',
  });
  saveSession();
  render();
}

function toggleAssistance(blockIdx) {
  const b = session.blocks[blockIdx];
  b.done = !b.done;
  if (b.done) startRest();
  saveSession();
  render();
}

function setAssistanceReps(blockIdx, reps) {
  session.blocks[blockIdx].reps = reps;
  saveSession();
}

function toggleAssistanceSet(blockIdx, setId) {
  const b = session.blocks[blockIdx];
  const s = b.sets.find((x) => x.id === setId);
  s.done = !s.done;
  if (s.done) startRest();
  saveSession();
  render();
}

function setAssistanceSetReps(blockIdx, setId, reps) {
  const s = session.blocks[blockIdx].sets.find((x) => x.id === setId);
  s.reps = reps;
  saveSession();
}

// ---------- Rest timer ----------
let timerInterval = null;

function startRest() {
  session.rest = { startedAt: Date.now() };
  saveSession();
  ensureTimerInterval();
}

function clearRest() {
  session.rest = null;
  saveSession();
  render();
}

function ensureTimerInterval() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    if (!session || !session.rest) {
      clearInterval(timerInterval);
      timerInterval = null;
      return;
    }
    const el = document.getElementById('rest-display');
    if (el) {
      const secs = Math.floor((Date.now() - session.rest.startedAt) / 1000);
      el.textContent = formatTimer(secs);
      el.className = 'display ' + timerClass(secs);
    }
  }, 500);
}

function formatTimer(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function timerClass(secs) {
  if (secs < 90) return 'cool';
  if (secs < 180) return 'warm';
  return 'hot';
}

// ---------- Settings actions ----------
function adjustTm(lift, delta) {
  state.tms[lift] = Math.max(0, state.tms[lift] + delta);
  saveState();
  render();
}
function setTm(lift, value) {
  const v = parseInt(value, 10);
  if (Number.isFinite(v) && v >= 0) {
    state.tms[lift] = v;
    saveState();
  }
}

function lifeInterruptModal() {
  modal = {
    title: 'When life interrupts',
    body: 'How long has it been since your last session?',
    actions: [
      { label: '1–2 weeks — resume where I left off', kind: 'ghost', onClick: () => { modal = null; toast('No change. Resume.'); render(); }},
      { label: '3–4 weeks — restart current cycle', kind: 'ghost', onClick: () => {
        state.week = 1; state.daysDoneThisWeek = []; saveState();
        modal = null; toast('Reset to Week 1 of cycle ' + state.cycle); render();
      }},
      { label: '4+ weeks — drop TMs 10% & restart', kind: 'danger', onClick: () => {
        Object.keys(state.tms).forEach((k) => { state.tms[k] = round5(state.tms[k] * 0.9); });
        state.week = 1; state.daysDoneThisWeek = []; saveState();
        modal = null; toast('TMs dropped 10%. Restarting Week 1.'); render();
      }},
      { label: 'Cancel', kind: 'ghost', onClick: () => { modal = null; render(); }},
    ],
  };
  render();
}

function dropLiftTm(lift) {
  modal = {
    title: `Drop ${lifts[lift].name} TM by 10%?`,
    body: 'Use this when you\'ve missed prescribed reps on the top set for two cycles in a row on this lift.',
    actions: [
      { label: 'Yes, drop 10%', kind: 'danger', onClick: () => {
        state.tms[lift] = round5(state.tms[lift] * 0.9); saveState();
        modal = null; toast(`${lifts[lift].name} TM → ${state.tms[lift]}`); render();
      }},
      { label: 'Cancel', kind: 'ghost', onClick: () => { modal = null; render(); }},
    ],
  };
  render();
}

function resetAll() {
  modal = {
    title: 'Reset all data?',
    body: 'Wipes TMs, history, and progress. Starts you back at Cycle 1, Week 1 with the original TMs.',
    actions: [
      { label: 'Yes, wipe everything', kind: 'danger', onClick: () => {
        state = structuredClone(defaultState);
        session = null;
        saveState(); saveSession();
        modal = null; view = 'home'; toast('Reset.'); render();
      }},
      { label: 'Cancel', kind: 'ghost', onClick: () => { modal = null; render(); }},
    ],
  };
  render();
}

// ---------- Toast ----------
function toast(message) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2100);
}

// ---------- Rendering ----------
const root = document.getElementById('app');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = v;
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return node;
}

function render() {
  root.innerHTML = '';
  const app = el('div', { class: 'app' });
  if (view === 'home') app.append(...renderHome());
  else if (view === 'session') app.append(...renderSession());
  else if (view === 'settings') app.append(...renderSettings());
  else if (view === 'history') app.append(...renderHistory());
  root.appendChild(app);

  if (view === 'session' && session && session.rest) {
    root.appendChild(renderTimer());
    ensureTimerInterval();
  }

  if (modal) root.appendChild(renderModal());
}

function topbar(title, sub, opts = {}) {
  const left = el('div', {}, [
    el('h1', {}, [title]),
    sub ? el('div', { class: 'sub' }, [sub]) : null,
  ]);
  const right = el('div', { class: 'icons' }, opts.icons || []);
  return el('div', { class: 'topbar' }, [left, right]);
}

// ---------- Home ----------
function renderHome() {
  const day = nextDay();
  const dayInfo = days[day];
  const weekInfo = weekSchemes[state.week];

  const status = el('div', { class: 'home-status' }, [
    el('div', { class: 'meta' }, [`Cycle ${state.cycle} · Week ${state.week} (${weekInfo.name})`]),
    el('div', { class: 'next-day' }, [`Next: ${dayInfo.short}`]),
    el('div', { class: 'meta' }, [
      dayInfo.lifts.map((l) => `${lifts[l].name} ${state.tms[l]}`).join(' · '),
    ]),
  ]);

  const startBtn = el('button', {
    class: 'primary full', style: 'font-size: 18px; min-height: 64px;',
    onClick: () => startSession(day),
  }, [`Start ${dayInfo.short}`]);

  const switchBtn = el('button', {
    class: 'ghost full',
    onClick: () => startSession(day === 1 ? 2 : 1),
  }, [`Switch to ${day === 1 ? 'Day 2' : 'Day 1'}`]);

  const recentCard = el('div', { class: 'card' }, [
    el('h2', {}, ['Recent']),
    state.history.length === 0
      ? el('div', { class: 'muted' }, ['No sessions logged yet.'])
      : el('div', {}, state.history.slice(-5).reverse().map(renderHistoryRow)),
  ]);

  const tmCard = el('div', { class: 'card' }, [
    el('h2', {}, ['Training Maxes']),
    ...Object.entries(state.tms).map(([k, v]) =>
      el('div', { style: 'display:flex; justify-content:space-between; padding:6px 0;' }, [
        el('span', {}, [lifts[k].name]),
        el('span', { style: 'font-weight:700;' }, [String(v)]),
      ])
    ),
  ]);

  return [
    topbar('5/3/1', null, {
      icons: [
        el('button', { class: 'icon-btn', onClick: () => { view = 'history'; render(); } }, ['📋']),
        el('button', { class: 'icon-btn', onClick: () => { view = 'settings'; render(); } }, ['⚙']),
      ],
    }),
    status,
    el('div', { style: 'display:flex; flex-direction:column; gap:10px; margin-bottom:18px;' }, [startBtn, switchBtn]),
    recentCard,
    tmCard,
  ];
}

function renderHistoryRow(h) {
  const d = new Date(h.date);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const summary = h.lifts.map((l) => {
    if (l.topWeight == null) return l.name;
    const reps = l.topReps != null ? l.topReps : '—';
    return `${l.name} ${l.topWeight}×${reps}`;
  }).join(', ');
  return el('div', { class: 'history-row' }, [
    el('div', { class: 'h-date' }, [`${date} · C${h.cycle} W${h.week} ${days[h.day].short}`]),
    el('div', { class: 'h-summary' }, [summary]),
  ]);
}

// ---------- Session ----------
function renderSession() {
  const dayInfo = days[session.day];
  const back = el('button', { class: 'icon-btn', onClick: cancelSession }, ['✕']);

  const blocks = session.blocks.map((b, i) => {
    if (b.kind === 'mainLift') return renderMainLiftBlock(b, i);
    if (b.kind === 'assistance') return renderAssistanceBlock(b, i);
    if (b.kind === 'assistanceSets') return renderAssistanceSetsBlock(b, i);
    return null;
  }).filter(Boolean);

  const finish = el('div', { class: 'finish-bar' }, [
    el('button', { class: 'primary full', onClick: finishSession, style: 'min-height:60px;font-size:17px;' }, ['Finish session']),
    el('button', { class: 'ghost full danger', onClick: cancelSession }, ['Cancel']),
  ]);

  return [
    topbar(dayInfo.short, `Cycle ${session.cycle} · Week ${session.week} (${session.weekName})`, { icons: [back] }),
    ...blocks,
    finish,
  ];
}

function renderMainLiftBlock(b, idx) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'lift-name' }, [b.name]));
  card.appendChild(el('div', { class: 'lift-sub' }, [`TM ${b.tm} · Week ${session.week} ${b.weekName}`]));

  b.steps.forEach((step) => card.appendChild(renderStep(step, idx)));

  if (b.canAddFsl) {
    card.appendChild(el('button', {
      class: 'add-fsl',
      onClick: () => addFslSet(idx),
    }, ['+ Add FSL set']));
  }
  return card;
}

function renderStep(step, blockIdx) {
  const classes = ['step', step.kind];
  if (step.done) classes.push('done');
  if (step.optional) classes.push('optional');

  const check = el('div', { class: 'check' }, [step.done ? '✓' : '']);

  const main = step.kind === 'amrap'
    ? `${step.weight} × ${step.reps}+`
    : `${step.weight} × ${step.reps}`;

  let extra = null;
  if (step.kind === 'amrap') {
    const cap = step.amrapCap != null ? ` (cap ${step.amrapCap})` : '';
    extra = el('div', { class: 'note' }, [`AMRAP — stop at RIR 1–2${cap}`]);
  } else if (step.kind === 'warmup') {
    extra = el('div', { class: 'note' }, [step.label]);
  } else if (step.optional) {
    extra = el('div', { class: 'note' }, ['Optional (skip if fatigued)']);
  }

  const pm = plateMath(step.weight);
  const plates = el('div', { class: 'plates' + (pm.ok ? '' : ' warn') }, [formatPlates(pm)]);

  const body = el('div', { class: 'body' }, [
    el('div', { class: 'label' }, [step.kind === 'warmup' ? 'Warm-up' : step.label]),
    el('div', { class: 'main' }, [main]),
    plates,
    extra,
  ]);

  const children = [check, body];

  if (step.kind === 'amrap') {
    const input = el('input', {
      type: 'number', inputmode: 'numeric', class: 'reps-input',
      placeholder: String(step.reps),
      value: step.amrapReps != null ? String(step.amrapReps) : '',
      onInput: (e) => setAmrapReps(blockIdx, step.id, parseInt(e.target.value, 10) || null),
    });
    children.push(input);
  }

  const node = el('div', { class: classes.join(' ') }, children);
  // Toggle done by tapping the body or check (not the rep input)
  const toggleZone = (e) => {
    if (e.target.tagName === 'INPUT') return;
    toggleStep(blockIdx, step.id);
  };
  node.addEventListener('click', toggleZone);
  return node;
}

function renderAssistanceBlock(b, idx) {
  const card = el('div', { class: 'card assistance-card' });
  const tag = b.optional ? el('span', { class: 'tag ghost' }, ['Optional']) : null;
  card.appendChild(el('div', { class: 'lift-name' }, [b.name, tag]));
  card.appendChild(el('div', { class: 'lift-sub' }, [b.target]));

  const inputRow = el('div', { class: 'input-row' }, [
    el('label', {}, ['Total reps']),
    el('input', {
      type: 'number', inputmode: 'numeric',
      placeholder: '—',
      value: b.reps != null ? String(b.reps) : '',
      onInput: (e) => setAssistanceReps(idx, parseInt(e.target.value, 10) || null),
    }),
    el('button', {
      class: b.done ? 'primary' : '',
      style: 'min-height:48px;',
      onClick: () => toggleAssistance(idx),
    }, [b.done ? 'Done ✓' : 'Mark done']),
  ]);
  card.appendChild(inputRow);
  return card;
}

function renderAssistanceSetsBlock(b, idx) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'lift-name' }, [b.name]));
  card.appendChild(el('div', { class: 'lift-sub' }, [b.target]));

  b.sets.forEach((s) => {
    const classes = ['step', 'fsl'];
    if (s.done) classes.push('done');
    const check = el('div', { class: 'check' }, [s.done ? '✓' : '']);
    const pm = plateMath(s.weight);
    const body = el('div', { class: 'body' }, [
      el('div', { class: 'label' }, [s.label]),
      el('div', { class: 'main' }, [`${s.weight} × ${s.reps}`]),
      el('div', { class: 'plates' + (pm.ok ? '' : ' warn') }, [formatPlates(pm)]),
    ]);
    const repInput = el('input', {
      type: 'number', inputmode: 'numeric', class: 'reps-input',
      placeholder: '8',
      onInput: (e) => setAssistanceSetReps(idx, s.id, parseInt(e.target.value, 10) || null),
    });
    const node = el('div', { class: classes.join(' ') }, [check, body, repInput]);
    node.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      toggleAssistanceSet(idx, s.id);
    });
    card.appendChild(node);
  });
  return card;
}

function renderTimer() {
  const secs = session.rest ? Math.floor((Date.now() - session.rest.startedAt) / 1000) : 0;
  return el('div', { class: 'timer' }, [
    el('div', { id: 'rest-display', class: 'display ' + timerClass(secs) }, [formatTimer(secs)]),
    el('button', { onClick: () => { session.rest = { startedAt: Date.now() }; saveSession(); render(); } }, ['Restart']),
    el('button', { onClick: clearRest }, ['Dismiss']),
  ]);
}

// ---------- Settings ----------
function renderSettings() {
  const back = el('button', { class: 'icon-btn', onClick: () => { view = 'home'; render(); } }, ['‹']);

  const tmCard = el('div', { class: 'card' }, [
    el('h2', {}, ['Training Maxes']),
    ...Object.entries(state.tms).map(([k, v]) =>
      el('div', { class: 'tm-row' }, [
        el('div', { class: 'name' }, [lifts[k].name, el('div', { class: 'muted', style: 'font-weight:400;font-size:12px;' }, [lifts[k].type === 'upper' ? 'Upper · +5/cycle' : 'Lower · +10/cycle'])]),
        el('div', { class: 'controls' }, [
          el('button', { onClick: () => adjustTm(k, -5), style: 'padding:6px 14px;min-height:40px;' }, ['−']),
          el('input', {
            type: 'number', inputmode: 'numeric', class: 'tm-input',
            value: String(v),
            onChange: (e) => { setTm(k, e.target.value); render(); },
          }),
          el('button', { onClick: () => adjustTm(k, 5), style: 'padding:6px 14px;min-height:40px;' }, ['+']),
          el('button', { class: 'danger', style: 'padding:6px 10px;min-height:40px;font-size:12px;', onClick: () => dropLiftTm(k) }, ['−10%']),
        ]),
      ])
    ),
    el('div', { class: 'help' }, [
      'TM = 90% of true 1RM. After each cycle, the app auto-adds +5 lb to upper / +10 lb to lower.',
    ]),
  ]);

  const cycleCard = el('div', { class: 'card' }, [
    el('h2', {}, ['Cycle']),
    el('div', { class: 'tm-row' }, [
      el('div', { class: 'name' }, ['Cycle']),
      el('div', { class: 'controls' }, [
        el('button', { onClick: () => { state.cycle = Math.max(1, state.cycle - 1); saveState(); render(); }, style: 'padding:6px 14px;min-height:40px;' }, ['−']),
        el('div', { style: 'font-weight:700;font-size:18px;width:40px;text-align:center;' }, [String(state.cycle)]),
        el('button', { onClick: () => { state.cycle += 1; saveState(); render(); }, style: 'padding:6px 14px;min-height:40px;' }, ['+']),
      ]),
    ]),
    el('div', { class: 'tm-row' }, [
      el('div', { class: 'name' }, ['Week']),
      el('div', { class: 'controls' }, [1, 2, 3, 4].map((w) =>
        el('button', {
          onClick: () => { state.week = w; state.daysDoneThisWeek = []; saveState(); render(); },
          style: `padding:6px 12px;min-height:40px; ${w === state.week ? 'background:var(--accent);border-color:var(--accent);color:#fff;' : ''}`,
        }, [String(w)])
      )),
    ]),
    el('div', { class: 'tm-row' }, [
      el('div', { class: 'name' }, ['Days done this week']),
      el('div', { class: 'controls' }, [
        el('button', {
          style: `padding:6px 12px;min-height:40px; ${state.daysDoneThisWeek.includes(1) ? 'background:var(--good);border-color:var(--good);color:#000;' : ''}`,
          onClick: () => { toggleDayDone(1); render(); },
        }, ['Day 1']),
        el('button', {
          style: `padding:6px 12px;min-height:40px; ${state.daysDoneThisWeek.includes(2) ? 'background:var(--good);border-color:var(--good);color:#000;' : ''}`,
          onClick: () => { toggleDayDone(2); render(); },
        }, ['Day 2']),
      ]),
    ]),
  ]);

  const lifeCard = el('div', { class: 'card' }, [
    el('h2', {}, ['Life Interrupted']),
    el('div', { class: 'help' }, ['Use this when you\'ve missed time. Picks the right reset for you.']),
    el('button', { class: 'full', style: 'margin-top:10px;', onClick: lifeInterruptModal }, ['I missed some sessions…']),
  ]);

  const dataCard = el('div', { class: 'card' }, [
    el('h2', {}, ['Data']),
    el('button', { class: 'full', style: 'margin-bottom:10px;', onClick: exportData }, ['Export JSON']),
    el('button', { class: 'full danger', onClick: resetAll }, ['Reset everything']),
  ]);

  return [
    topbar('Settings', null, { icons: [back] }),
    tmCard,
    cycleCard,
    lifeCard,
    dataCard,
  ];
}

function toggleDayDone(d) {
  if (state.daysDoneThisWeek.includes(d)) {
    state.daysDoneThisWeek = state.daysDoneThisWeek.filter((x) => x !== d);
  } else {
    state.daysDoneThisWeek.push(d);
  }
  saveState();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `531-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- History ----------
function renderHistory() {
  const back = el('button', { class: 'icon-btn', onClick: () => { view = 'home'; render(); } }, ['‹']);
  const card = el('div', { class: 'card' }, [
    state.history.length === 0
      ? el('div', { class: 'muted' }, ['No sessions logged yet.'])
      : el('div', {}, state.history.slice().reverse().map(renderHistoryRow)),
  ]);
  return [topbar('History', `${state.history.length} session${state.history.length === 1 ? '' : 's'}`, { icons: [back] }), card];
}

// ---------- Modal ----------
function renderModal() {
  const backdrop = el('div', { class: 'modal-backdrop', onClick: (e) => {
    if (e.target.classList.contains('modal-backdrop')) { modal = null; render(); }
  }});
  const m = el('div', { class: 'modal' }, [
    el('h3', {}, [modal.title]),
    modal.body ? el('div', { class: 'muted' }, [modal.body]) : null,
    el('div', { class: 'actions' }, modal.actions.map((a) =>
      el('button', { class: a.kind === 'danger' ? 'danger' : (a.kind === 'ghost' ? 'ghost' : 'primary'), onClick: a.onClick }, [a.label])
    )),
  ]);
  backdrop.appendChild(m);
  return backdrop;
}

// ---------- Boot ----------
render();

// Re-render timer-driven UI on visibility change (handles screen-lock returns)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session && session.rest) {
    const el = document.getElementById('rest-display');
    if (el) {
      const secs = Math.floor((Date.now() - session.rest.startedAt) / 1000);
      el.textContent = formatTimer(secs);
      el.className = 'display ' + timerClass(secs);
    }
  }
});
