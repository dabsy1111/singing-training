'use strict';
/* Lesson course: progress, the course page, lesson screens, exercise types, scoring and tips.
 * Lesson content lives in lessons.js; this file only knows how to run each lesson type. */

// ---------------------------------------------------------------- progress (synced through the server)
let C = null;
const ALL_LESSONS = COURSE.flatMap(u => u.lessons.map(l => ({ ...l, unit: u.id, unitTitle: u.title })));
const lessonById = id => ALL_LESSONS.find(l => l.id === id);

async function course() {
  if (!C) {
    try { C = await api('/api/course'); } catch { C = {}; }
    C.passed ||= {}; C.best ||= {}; C.warmups ||= {}; C.songsPassed ||= {}; C.notes ||= {}; C.partsPassed ||= {};
    C.placedUnit ||= 0;
  }
  return C;
}
let saveTimer = 0;
function saveCourse() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('/api/course', { method: 'PUT', json: C }).catch(e => toast('Couldn’t save progress: ' + e.message)), 300);
}
function recordAttempt(id, score, passed) {
  if (score != null) C.best[id] = Math.max(C.best[id] ?? 0, Math.round(score));
  if (passed && (!C.passed[id] || C.passed[id].skipped))
    C.passed[id] = { score: score == null ? null : Math.round(score), at: Date.now(), ...(C.ease ? { ease: C.ease } : {}) };
  saveCourse();
}
function skipLesson(id) {
  if (C.passed[id] && !C.passed[id].skipped) return;
  C.passed[id] = { skipped: true, at: Date.now() };
  saveCourse();
}

// ---------------------------------------------------------------- difficulty
// Standard is the course as written. Easier/Easiest loosen every pass rule the same way,
// so a lesson that's out of reach today (a 10 s even hiss, say) doesn't block the rest.
const EASE = [
  { name: 'Standard', score: 70, cents: 1, count: 1, secs: 1, onset: 1, even: 0.35, ear: 0, span: 1, ratio: 1, smooth: true,
    blurb: 'The course as written.' },
  { name: 'Easier', score: 60, cents: 1.5, count: 0.75, secs: 0.6, onset: 0.8, even: 0.5, ear: 2, span: 0.75, ratio: 0.6, smooth: true,
    blurb: 'Pass at 60% instead of 70%, pitch windows 1.5× wider, holds and hisses 60% as long, fewer repeats needed.' },
  { name: 'Easiest', score: 50, cents: 2, count: 0.5, secs: 0.4, onset: 0.6, even: 0.7, ear: 3, span: 0.5, ratio: 0.3, smooth: false,
    blurb: 'Pass at 50%, pitch windows twice as wide, holds and hisses 40% as long, half the repeats, glides needn’t be smooth.' },
];
const ease = () => EASE[C?.ease || 0];
function easedPass(pass) {
  const e = ease(), q = { ...pass };
  if (q.value != null) q.value = q.metric === 'onset' ? q.value * e.onset : Math.min(q.value, e.score);
  if (q.score != null) q.score = Math.min(q.score, e.score);
  if (q.cents != null) q.cents = Math.round(q.cents * e.cents);
  if (q.count != null) q.count = Math.max(1, Math.ceil(q.count * e.count));
  if (q.seconds != null) q.seconds = Math.max(1, Math.round(q.seconds * e.secs * 10) / 10);
  if (q.onset != null) q.onset = q.onset * e.onset;
  if (q.ratio != null) q.ratio = 1 + (q.ratio - 1) * e.ratio;
  if (q.correct != null) q.correct = Math.max(5, q.correct - e.ear);
  if (q.smooth && !e.smooth) q.smooth = false;
  return q;
}
// Short description of an eased target, shown next to the lesson's own pass text.
function passSummary(l) {
  const q = l.pass, e = ease();
  switch (q.metric) {
    case 'breath': return `hiss ${q.seconds} s`;
    case 'within': return `${q.count} notes within ${q.cents}¢`;
    case 'drift': return `${q.score}%, drift under ${q.cents}¢`;
    case 'tail': return `${q.score}%, endings within ${q.cents}¢`;
    case 'onset': return `start score ${Math.round(q.value * 100)}%`;
    case 'slide': return `${q.count} slides held ${q.seconds} s`;
    case 'vowels': return `every vowel within ${q.cents}¢`;
    case 'volume': return `${q.score}%, medium ${q.ratio.toFixed(1)}× louder`;
    case 'straight': return `straight notes within ${q.cents}¢`;
    case 'glides': return `${q.count} glide${q.count > 1 ? 's' : ''}, ${Math.round(e.span * 100)}% of the span${lessonById(l.id)?.pass?.smooth && !q.smooth ? ', gaps allowed' : ''}`;
    case 'ear': return `${q.correct} of 10`;
    case 'breaths': return `${q.score}%, starts ${Math.round(q.onset * 100)}%`;
    case 'complete': return 'just finish it';
    default: return `${q.score ?? q.value ?? e.score}%`;
  }
}

// Lesson as it should be judged at the current difficulty (exercise content is unchanged).
function easedLesson(lesson) {
  const pass = easedPass(lesson.pass || (['setup', 'range', 'pickSong', 'sequence'].includes(lesson.type) ? { metric: 'complete' } : { metric: 'score', value: 70 }));
  const params = { ...(lesson.params || {}) };
  if (lesson.type === 'breath') params.seconds = pass.seconds;
  if (lesson.type === 'glide') {
    params.count = pass.count ?? params.count;
    params.spanScale = ease().span;
    params.smooth = !!pass.smooth;   // the lesson's "no gap in the line" rule
  }
  return { ...lesson, pass, params };
}
function isUnlocked(l) {
  const i = ALL_LESSONS.findIndex(x => x.id === l.id);
  if (i === 0 || C.passed[l.id]) return true;
  if (l.unit < C.placedUnit) return true;
  if (l.unit === C.placedUnit && COURSE.find(u => u.id === l.unit).lessons[0].id === l.id) return true;
  return !!C.passed[ALL_LESSONS[i - 1].id];
}
const nextLesson = () => ALL_LESSONS.find(l => !C.passed[l.id] && isUnlocked(l) && !(l.unit < C.placedUnit));

// ---------------------------------------------------------------- note positions
function rangeOf(s) { return { lo: s.rangeLow, hi: s.rangeHigh, mid: Math.round((s.rangeLow + s.rangeHigh) / 2) }; }
function homeOf(s) {
  const { lo, hi } = rangeOf(s);
  return clamp(C?.homeNote ?? Math.round(lo + (hi - lo) * 0.35), lo, hi);
}
function pos(where, s) {
  const { lo, hi, mid } = rangeOf(s);
  if (typeof where === 'number') return clamp(mid + where, lo, hi);
  const m = String(where).match(/^(home|mid|low|high)([+-]\d+)?$/);
  if (!m) return mid;
  const base = { home: homeOf(s), mid, low: lo + 2, high: hi - 2 }[m[1]];
  return clamp(base + Number(m[2] || 0), lo, hi);
}
const IV_NAMES = { 1: 'semitone', 2: 'step', 3: 'minor 3rd', 4: 'major 3rd', 5: '4th', 6: 'tritone', 7: '5th',
  8: 'minor 6th', 9: '6th', 10: 'minor 7th', 11: 'major 7th', 12: 'octave' };

// ---------------------------------------------------------------- exercise builders → Practice targets
function finish(notes, cues, t, s, marks = []) {
  return { notes, cues, marks, duration: t + 0.6, range: null, _s: s };
}
const BUILD = {
  sustain(p, s) {
    const notes = [], cues = [], marks = []; let t = 0.6;
    p.notes.forEach((w, i) => {
      const m = pos(w, s);
      if (!(p.noCueAfterFirst && i > 0)) { cues.push({ t0: t, t1: t + 0.9, midi: m }); t += 1.05; }
      if (p.think) { marks.push({ t, text: 'think it…' }); t += 0.7; }
      const label = p.labels ? p.labels[i % p.labels.length] : p.label;
      notes.push({ t0: t, t1: t + p.hold, midi: m, label, guide: false });
      t += p.hold + (p.gap ?? 1.1);
    });
    return finish(notes, cues, t, s, marks);
  },
  echo(p, s) {
    const { lo, hi } = rangeOf(s), notes = [], cues = []; let t = 0.6; const beat = p.beat || 0.6;
    for (const pat of p.patterns) {
      const span = Math.max(...pat) - Math.min(...pat);
      const minRoot = lo - Math.min(...pat), maxRoot = hi - Math.max(...pat);
      const root = maxRoot >= minRoot ? minRoot + Math.floor(Math.random() * (maxRoot - minRoot + 1)) : lo;
      pat.forEach((iv, k) => cues.push({ t0: t + k * beat, t1: t + k * beat + beat * 0.85, midi: root + iv }));
      t += pat.length * beat + 0.5;
      pat.forEach((iv, k) => notes.push({ t0: t + k * beat, t1: t + k * beat + beat * 0.9, midi: root + iv, label: 'echo', guide: false }));
      t += pat.length * beat + 1.0;
      void span;
    }
    return finish(notes, cues, t, s);
  },
  interval(p, s) {
    const { lo, hi } = rangeOf(s), notes = [], cues = [], marks = []; let t = 0.6;
    for (const iv of p.intervals) {
      const a = iv > 0 ? lo : lo - iv, b = iv > 0 ? hi - iv : hi;
      const base = b >= a ? a + Math.floor(Math.random() * (b - a + 1)) : Math.round((lo + hi) / 2);
      cues.push({ t0: t, t1: t + 0.9, midi: base });
      t += 1.0;
      marks.push({ t, text: `${IV_NAMES[Math.abs(iv)] || Math.abs(iv) + ' st'} ${iv > 0 ? 'up' : 'down'}` });
      t += 0.7;
      notes.push({ t0: t, t1: t + 1.8, midi: base + iv, label: `${IV_NAMES[Math.abs(iv)]} ${iv > 0 ? '↑' : '↓'}`, guide: false });
      t += 2.9;
    }
    return finish(notes, cues, t, s, marks);
  },
  vowels(p, s) {
    const notes = [], cues = []; let t = 0.6;
    for (const w of p.notes) {
      const m = pos(w, s);
      cues.push({ t0: t, t1: t + 0.9, midi: m }); t += 1.2;
      for (const v of p.vowels) { notes.push({ t0: t, t1: t + p.each, midi: m, label: v, guide: false }); t += p.each; }
      t += 1.4;
    }
    return finish(notes, cues, t, s);
  },
  volume(p, s) {
    const notes = [], cues = []; let t = 0.6;
    for (const w of p.notes) {
      const m = pos(w, s);
      cues.push({ t0: t, t1: t + 0.9, midi: m }); t += 1.2;
      for (const part of p.parts) { notes.push({ t0: t, t1: t + p.each, midi: m, label: part, guide: false }); t += p.each; }
      t += 1.5;
    }
    return finish(notes, cues, t, s);
  },
  straight(p, s) {
    const notes = [], cues = []; let t = 0.6;
    for (const w of p.notes) {
      const m = pos(w, s);
      cues.push({ t0: t, t1: t + 0.9, midi: m }); t += 1.2;
      notes.push({ t0: t, t1: t + p.each, midi: m, label: 'straight', guide: false }); t += p.each;
      notes.push({ t0: t, t1: t + p.each, midi: m, label: 'free', guide: false }); t += p.each + 1.4;
    }
    return finish(notes, cues, t, s);
  },
  drill(p, s) {
    const tg = buildDrill(p.drills, s, p.tempo || 1, true, { label: p.label, maxRoots: p.maxRoots, topHalf: p.topHalf });
    return { ...tg, marks: [] };
  },
};

// ---------------------------------------------------------------- per-note measurements
function noteStats(n, s) {
  const dur = n.t1 - n.t0, tw = Math.min(0.15, dur * 0.3);
  const hold = n.frames.filter(f => f.dt >= tw);
  const voiced = hold.filter(f => f.c !== null).map(f => f.c);
  const sorted = [...voiced].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const third = Math.max(1, Math.floor(voiced.length / 3));
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const drift = voiced.length >= 6 ? Math.abs(avg(voiced.slice(-third)) - avg(voiced.slice(0, third))) : null;
  const tailFr = n.frames.filter(f => f.dt >= dur - 0.3 && f.c !== null).map(f => f.c);
  const spread = median === null ? null : avg(voiced.map(c => Math.abs(c - median)));
  let run = 0, best = 0, gapRun = 0;
  for (const f of n.frames) {
    if (f.c !== null && Math.abs(f.c) <= s.greenCents) { run += 1 + gapRun; gapRun = 0; best = Math.max(best, run); }
    else if (run && gapRun < 4) gapRun++;
    else { run = 0; gapRun = 0; }
  }
  const loud = hold.filter(f => f.c !== null).map(f => f.rms).sort((a, b) => a - b);
  return {
    voicedFrac: hold.length ? voiced.length / hold.length : 0,
    median, drift, spread, tail: tailFr.length >= 5 ? avg(tailFr) : null,
    greenSec: best * 0.01, onset: n.result?.onset ?? 0,
    rms: loud.length ? loud[Math.floor(loud.length / 2)] : 0,
  };
}

function evaluate(lesson, P, res, s, extra = {}) {
  const pass = lesson.pass || (['setup', 'range', 'pickSong', 'sequence'].includes(lesson.type) ? { metric: 'complete' } : { metric: 'score', value: 70 });
  const notes = P ? P.notes.filter(n => n.frames.length) : [];
  const st = notes.map(n => ({ n, ...noteStats(n, s) }));
  const score = res?.score ?? null;
  const ok70 = v => (score ?? 0) >= (v ?? ease().score);
  let passed = false, detail = '';
  switch (pass.metric) {
    case 'score': passed = ok70(pass.value); break;
    case 'within': {
      const good = st.filter(x => x.voicedFrac >= 0.4 && x.median !== null && Math.abs(x.median) <= pass.cents).length;
      passed = good >= pass.count; detail = `${good} of ${st.length} notes within ${pass.cents}¢`; break;
    }
    case 'drift': {
      const worst = Math.max(0, ...st.map(x => x.drift ?? 0));
      passed = ok70(pass.score) && worst <= pass.cents; detail = `biggest drift ${Math.round(worst)}¢`; break;
    }
    case 'tail': {
      const flatTails = st.filter(x => drooped(x, pass.cents)).length;
      passed = ok70(pass.score) && flatTails === 0; detail = flatTails ? `${flatTails} note${flatTails > 1 ? 's' : ''} drooped at the end` : 'clean endings'; break;
    }
    case 'onset': {
      const avg = st.length ? st.reduce((a, x) => a + x.onset, 0) / st.length : 0;
      passed = avg >= pass.value; detail = `start score ${Math.round(avg * 100)}%`; break;
    }
    case 'slide': {
      const good = st.filter(x => x.greenSec >= pass.seconds).length;
      passed = good >= pass.count; detail = `${good} of ${st.length} reached green and held`; break;
    }
    case 'vowels': {
      const off = st.filter(x => x.voicedFrac < 0.4 || x.median === null || Math.abs(x.median) > pass.cents);
      passed = st.length > 0 && off.length === 0;
      detail = off.length ? `off on: ${[...new Set(off.map(x => x.n.label))].join(', ')}` : 'every vowel centred'; break;
    }
    case 'volume': {
      let good = 0, groups = 0;
      for (let i = 0; i + 2 < st.length; i += 3) {
        groups++;
        const soft = (st[i].rms + st[i + 2].rms) / 2, med = st[i + 1].rms;
        if (soft > 0 && med / soft >= pass.ratio) good++;
      }
      passed = ok70(pass.score) && groups > 0 && good >= Math.ceil(groups / 2);
      detail = `medium clearly louder in ${good} of ${groups}`; break;
    }
    case 'straight': {
      const str = st.filter(x => x.n.label === 'straight');
      const worst = Math.max(0, ...str.map(x => x.spread ?? 99));
      passed = str.length > 0 && worst <= pass.cents && str.every(x => x.median !== null && Math.abs(x.median) <= s.amberCents);
      detail = worst < 3 ? 'straight notes held dead steady' : `straight notes wandered up to ${Math.round(worst)}¢`; break;
    }
    case 'bias': {
      const b = res?.bias ?? 0, base = extra.baselineBias;
      passed = ok70(pass.score) && (Math.abs(b) <= 10 || (base != null && base < -10 && b >= base / 2));
      detail = `tendency ${b < 0 ? Math.round(-b) + '¢ flat' : Math.round(b) + '¢ sharp'}${base != null ? ` (was ${base < 0 ? Math.round(-base) + '¢ flat' : Math.round(base) + '¢ sharp'})` : ''}`; break;
    }
    case 'complete': passed = st.length === 0 || st.every(x => x.voicedFrac >= 0.3); detail = passed ? '' : 'some notes weren’t heard'; break;
    case 'glides': case 'breath': case 'ear': passed = !!extra.passed; detail = extra.detail || ''; break;
    default: passed = ok70(pass.value);
  }
  return { passed, detail, tip: tipFor(lesson, st, res, s) };
}

const drooped = (x, cents) => x.tail !== null && x.median !== null && x.tail < -cents && x.tail < x.median - 15;

// One targeted tip, for the biggest problem.
function tipFor(lesson, st, res, s) {
  if (!st.length) return null;
  const voiced = st.reduce((a, x) => a + x.voicedFrac, 0) / st.length;
  if (voiced < 0.4) return 'I didn’t hear much singing. Sing at a confident medium volume, and check the microphone is the one you expect.';
  const bias = res?.bias ?? 0;
  const onset = st.reduce((a, x) => a + x.onset, 0) / st.length;
  const drift = Math.max(0, ...st.map(x => x.drift ?? 0));
  const flatTails = st.filter(x => drooped(x, s.greenCents)).length;
  // Direction-aware from Unit 4: is it the rising notes that go flat?
  if (lesson.unit >= 4 && bias < -12) {
    let up = [], down = [];
    for (let i = 1; i < st.length; i++) {
      if (st[i].median === null) continue;
      const d = st[i].n.midi - st[i - 1].n.midi;
      if (d > 0) up.push(st[i].median); else if (d < 0) down.push(st[i].median);
    }
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    if (up.length >= 2 && avg(up) < -20 && avg(up) < avg(down) - 8) return `Flat mostly on the way up (about ${Math.round(-avg(up))}¢). Aim a hair higher as you climb; picture the next note before you move.`;
    if (down.length >= 2 && avg(down) < -20 && avg(down) < avg(up) - 8) return `Flat on the way down (about ${Math.round(-avg(down))}¢). Don’t let descending notes fall too far.`;
  }
  const problems = [
    [bias < -15 ? -bias : 0, `You sat flat by about ${Math.round(-bias)}¢. Think a little higher, and keep the vowel bright.`],
    [bias > 15 ? bias : 0, `You sat sharp by about ${Math.round(bias)}¢. Ease off the push: same energy, less force.`],
    [onset < 0.5 ? (0.5 - onset) * 80 : 0, 'Starts were late or scooped. Hear the note in your head first, then start right on it.'],
    [drift > 30 ? drift - 10 : 0, 'Notes wandered while you held them. Keep the ribs wide and the air steady to the end.'],
    [flatTails ? 20 + flatTails * 5 : 0, 'The ends of notes drooped flat. Stop the note by stopping the air, not by letting go.'],
  ].sort((a, b) => b[0] - a[0]);
  return problems[0][0] > 0 ? problems[0][1] : null;
}

// ---------------------------------------------------------------- running a pitch exercise on the stage
function runPracticeOnce(stageEl, target, s, opts = {}) {
  stageEl.innerHTML = '';
  const P = new Practice(stageEl, target, { synth: true }, { settings: s, volumes: { guide: 0.7 }, start: 0, marks: target.marks, onFrame: opts.onFrame });
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const orig = P.stop.bind(P);
  P.stop = async fin => { const r = await orig(fin); resolveDone({ res: r, finished: fin, P }); return r; };
  return { P, done, start: () => P.play({ from: 0, to: target.duration }) };
}

// ---------------------------------------------------------------- the course page
route(/^\/lessons$/, async () => {
  const [s] = await Promise.all([settings(), course()]);
  const nxt = nextLesson();
  const done = ALL_LESSONS.filter(l => C.passed[l.id]).length;
  const skipped = ALL_LESSONS.filter(l => C.passed[l.id]?.skipped);
  const warmupReady = C.passed['1.5'] || C.placedUnit >= 4;
  const warmedUp = C.warmups[today()];
  view.innerHTML = `<h1>Lessons</h1>
    <div class="card row">
      <div class="grow"><b>${done - skipped.length} of ${ALL_LESSONS.length} lessons passed</b>${skipped.length ? ` <span class="dim small">· ${skipped.length} skipped</span>` : ''}
        <div class="meter" style="margin:8px 0 0"><i style="left:0;width:${Math.max(2, 100 * done / ALL_LESSONS.length)}%;height:10px;top:0;border-radius:99px;background:var(--accent)"></i></div></div>
      ${nxt ? `<a class="btn primary" href="#/lesson/${nxt.id}">${done ? 'Continue' : 'Start'}: ${esc(nxt.id)} ${esc(nxt.title)}</a>` : '<span class="pill ready">Course complete</span>'}
    </div>
    <div id="nudges"></div>
    <div class="card">
      <div class="row"><b class="grow">Difficulty</b>
        <div class="seg" id="ease">${EASE.map((e, k) => `<button data-ease="${k}" class="${(C.ease || 0) === k ? 'primary' : ''}">${e.name}</button>`).join('')}</div></div>
      <p class="dim small" style="margin:6px 0 0">${esc(ease().blurb)} Lessons already passed stay passed. Stuck on one? Open it and choose “Skip this lesson for now”; skipped lessons stay open to come back to.</p>
    </div>
    ${warmupReady ? `<div class="card row"><div class="grow"><b>Today’s warm-up</b> <span class="dim small">about 3 minutes</span></div>
      ${warmedUp ? '<span class="pill ready">done today ✓</span> ' : ''}<a class="btn ${warmedUp ? '' : 'primary'}" href="#/lesson/1.5?daily">Warm up</a>
      ${C.passed['6.6'] ? '<a class="btn" href="#/lesson/6.6?daily">Warm down</a>' : ''}</div>` : ''}
    ${C.passed['1.1'] && !C.placedUnit && !C.passed['2.1'] ? `<div class="card row"><div class="grow"><b>Sung before?</b> <span class="dim small">A 3-minute placement check can start you at Unit 4 or 7.</span></div><a class="btn" href="#/placement">Placement check</a></div>` : ''}
    ${COURSE.map(u => `
      <h2>Unit ${u.id} · ${esc(u.title)}${u.id < C.placedUnit ? ' <span class="pill">placed past</span>' : ''}</h2>
      <p class="dim small" style="margin-top:-4px">${esc(u.intro)}</p>
      <div class="card lessons">${u.lessons.map(l => {
        const lu = { ...l, unit: u.id }, open = isUnlocked(lu), p = C.passed[l.id];
        const icon = p?.skipped ? '↷' : p ? '✓' : open ? '▶' : '🔒';
        return `<${open ? `a href="#/lesson/${l.id}"` : 'div'} class="lesson-row ${p ? 'passed' : open ? 'open' : 'locked'}">
          <span class="lesson-icon">${icon}</span><span class="grow"><b>${l.id}</b> ${esc(l.title)}</span>
          <span class="dim small">${p?.skipped ? 'skipped' : p ? (C.best[l.id] != null ? C.best[l.id] + '%' : 'done') + (p.ease ? ` · ${EASE[p.ease].name.toLowerCase()}` : '') : C.best[l.id] != null ? 'best ' + C.best[l.id] + '%' : ''}</span></${open ? 'a' : 'div'}>`;
      }).join('')}</div>`).join('')}`;
  restNudges($('#nudges'));
  $('#ease').onclick = e => {
    const b = e.target.closest('[data-ease]'); if (!b) return;
    C.ease = +b.dataset.ease; saveCourse(); render();
  };
}, 'lessons');

async function restNudges(box) {
  const out = [];
  const mins = sungSecondsToday() / 60;
  if (mins >= 40) out.push(`You’ve sung about ${Math.round(mins)} minutes today. That’s a good day’s work; give your voice a rest.`);
  try {
    const runs = await api('/api/runs?limit=400');
    const byDay = {};
    for (const r of runs) {
      if (r.score == null || r.kind === 'ear') continue;
      const d = new Date(r.created * 1000).toLocaleDateString('en-CA');
      (byDay[d] ||= []).push(r.score);
    }
    const days = Object.keys(byDay).sort().reverse();   // newest first
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    if (days.length >= 5 && byDay[days[0]].length >= 3 && byDay[days[1]].length >= 3) {
      const before = days.slice(2, 8).map(d => avg(byDay[d]));
      const base = avg(before);
      if (avg(byDay[days[0]]) <= base - 12 && avg(byDay[days[1]]) <= base - 12)
        out.push('Your scores have dipped two days running. That’s often a tired voice: take a rest day, drink water, and come back fresh. If you’re hoarse or it hurts for more than a couple of weeks, get it checked.');
    }
  } catch { /* offline: skip */ }
  box.innerHTML = out.map(t => `<div class="card nudge">${esc(t)}</div>`).join('');
}

// ---------------------------------------------------------------- a lesson
route(/^\/lesson\/(\d\.\d)(?:\?(\w+))?$/, async (id, flag) => {
  const [s] = await Promise.all([settings(), course()]);
  const lesson = lessonById(id);
  if (!lesson) throw new Error('No such lesson');
  if (!isUnlocked(lesson) && !flag) {
    const nx = nextLesson();
    view.innerHTML = `<div class="card"><p>🔒 <b>${lesson.id} ${esc(lesson.title)}</b> unlocks when you pass the lessons before it.</p>
      ${nx ? `<a class="btn primary" href="#/lesson/${nx.id}">Go to ${nx.id} ${esc(nx.title)}</a>` : ''} <a class="btn" href="#/lessons">All lessons</a></div>`;
    return;
  }
  const daily = flag === 'daily';
  const i = ALL_LESSONS.indexOf(lesson), next = ALL_LESSONS[i + 1];
  const judged = daily ? lesson : easedLesson(lesson);
  const passRec = C.passed[id];
  view.innerHTML = `
    <p class="dim small"><a href="#/lessons">Lessons</a> › Unit ${lesson.unit} · ${esc(lesson.unitTitle)}</p>
    <h1>${daily ? (id === '1.5' ? 'Today’s warm-up' : 'Warm-down') : `${lesson.id} ${esc(lesson.title)}`}
      ${passRec && !daily ? (passRec.skipped ? '<span class="pill">skipped</span>' : `<span class="pill ready">passed${C.best[id] != null ? ' · best ' + C.best[id] + '%' : ''}</span>`) : ''}</h1>
    <p>${esc(lesson.why)}</p>
    <div class="cues">${lesson.cues.map(c => `<span class="cue">${esc(c)}</span>`).join('')}</div>
    ${!daily ? `<p class="dim small">To pass: ${esc(lesson.passText || '70%')}${C.ease ? ` <span class="pill">${ease().name}: ${esc(passSummary(judged))}</span>` : ''}</p>` : ''}
    ${!daily ? videosHTML(lesson.id) : ''}
    <div id="ex"></div>
    <div id="out"></div>
    ${!daily && !passRec ? `<p class="small dim" style="margin-top:16px">Can’t do this one yet? <button data-skiptop>Skip this lesson for now</button> <a href="#/lessons">Difficulty: ${ease().name}</a></p>` : ''}`;
  const ex = $('#ex'), out = $('#out');
  bindVideos(view);
  const skipTop = view.querySelector('[data-skiptop]');
  if (skipTop) skipTop.onclick = () => { if (confirm('Skip this lesson for now? The next one unlocks and you can come back to this one any time.')) { skipLesson(id); location.hash = next && isUnlocked(next) ? `#/lesson/${next.id}` : '#/lessons'; } };
  const offs = [];
  cleanup = () => { offs.forEach(f => f()); stopMic(); };

  // What happens when an attempt finishes.
  async function report({ res, P, extra = {} }) {
    const ev = evaluate(judged, P, res, s, extra);
    const score = res?.score ?? extra.score ?? null;
    if (!daily) recordAttempt(id, score, ev.passed);
    else if (ev.passed || lesson.pass?.metric === 'complete') { C.warmups[today()] = true; saveCourse(); }
    if (res && res.score != null && res.notes?.length >= 2)
      saveRun('lesson', id, `Lesson ${id}: ${lesson.title}`, res, { lesson: id, passed: ev.passed }).catch(() => {});
    const nextOpen = next && isUnlocked(next);
    out.innerHTML = `<div class="card ${ev.passed ? 'pass' : ''}">
      <div class="row"><b class="grow" style="font-size:20px">${ev.passed ? (daily ? 'Done ✓' : 'Passed ✓') : 'Not yet'}</b>
        ${score != null ? `<span style="font-size:20px"><b>${Math.round(score)}%</b></span>` : ''}</div>
      ${ev.detail ? `<p class="dim small">${esc(ev.detail)}</p>` : ''}
      ${ev.tip ? `<p>💡 ${esc(ev.tip)}</p>` : ''}
      ${res?.timingOffset && Math.abs(res.timingOffset) >= 0.06 ? `<p class="small dim">Your timing looked ${Math.round(Math.abs(res.timingOffset) * 1000)} ms ${res.timingOffset > 0 ? 'late' : 'early'}. <button data-latency="${Math.round(res.timingOffset * 1000)}">Adjust for this device</button></p>` : ''}
      ${res?.take ? `<p><audio controls src="${URL.createObjectURL(res.take)}"></audio></p>` : ''}
      <div class="row"><button id="again">Try again</button>
        ${daily ? '<a class="btn primary" href="#/lessons">Back to lessons</a>' : ev.passed && nextOpen ? `<a class="btn primary" href="#/lesson/${next.id}">Next: ${next.id} ${esc(next.title)}</a>` : ''}
        ${!ev.passed && !daily ? '<a class="btn" href="#/lessons">Back to lessons</a>' : ''}</div>
      ${!ev.passed && !daily && !C.passed[id] ? `<p class="small dim" style="margin-top:10px">Stuck? ${C.ease < 2 ? `<button data-easier>Make lessons easier</button> or ` : ''}<button data-skip>Skip this lesson for now</button></p>` : ''}</div>`;
    bindLatencyButton(out);
    $('#again').onclick = () => { out.innerHTML = ''; start(); };
    const eb = out.querySelector('[data-easier]');
    if (eb) eb.onclick = () => { C.ease = (C.ease || 0) + 1; saveCourse(); toast(`Lessons set to ${ease().name}. Try again with the new target.`); render(); };
    const sb = out.querySelector('[data-skip]');
    if (sb) sb.onclick = () => skipLesson(id) || (location.hash = next && isUnlocked(next) ? `#/lesson/${next.id}` : '#/lessons');
    if (ev.passed && lesson.id === '1.5' && !daily) { C.warmups[today()] = true; saveCourse(); }
  }

  const start = () => runLesson(judged, s, ex, report, offs, daily).catch(e => toast(e.message, 6000));
  start();
}, 'lessons');

// ---------------------------------------------------------------- demonstration videos
// A thumbnail and title per video; the YouTube player only loads when tapped.
function videosHTML(id) {
  const vids = (typeof LESSON_VIDEOS !== 'undefined' && LESSON_VIDEOS[id]) || [];
  if (!vids.length) return '';
  return `<details class="card videos"${C.passed[id] && !C.passed[id].skipped ? '' : ' open'}><summary><b>Watch how it’s done</b> <span class="dim small">${vids.length} video${vids.length > 1 ? 's' : ''} from vocal coaches</span></summary>
    ${vids.map(v => `<div class="video" data-vid="${esc(v.id)}">
      <button class="vthumb" aria-label="Play ${esc(v.title)}"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg"><span class="vplay">▶</span><span class="vlen">${esc(v.len || '')}</span></button>
      <div class="vtext"><b>${esc(v.title)}</b><div class="small dim">${esc(v.by)}</div><div class="small">${esc(v.note || '')}</div>
        <a class="small" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">Open in YouTube</a></div>
    </div>`).join('')}
  </details>`;
}
function bindVideos(root) {
  root.querySelectorAll('.video .vthumb').forEach(b => b.onclick = () => {
    const box = b.closest('.video'), id = box.dataset.vid;
    const f = document.createElement('iframe');
    f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0`;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';   // YouTube refuses embeds that send no referrer
    f.title = box.querySelector('.vtext b').textContent;
    b.replaceWith(f);
    box.classList.add('playing');
  });
}

// ---------------------------------------------------------------- lesson types
async function runLesson(lesson, s, ex, report, offs, daily) {
  const p = lesson.params || {};
  switch (lesson.type) {
    case 'setup': return setupLesson(lesson, s, ex, report);
    case 'range': return rangeLesson(lesson, s, ex, report);
    case 'pickSong': return pickSongLesson(lesson, s, ex, report);
    case 'song': return songLessonCard(lesson, s, ex);
    case 'breath': return breathLesson(lesson, s, ex, report, offs);
    case 'glide': return glideStep(p, s, ex).then(r => report(r));
    case 'homeNote': return homeNoteLesson(lesson, s, ex, report, offs);
    case 'ear': {
      ex.innerHTML = `<button class="primary" id="go">Start 10 questions</button><div id="q"></div>`;
      $('#go').onclick = async () => {
        $('#go').hidden = true;
        const r = await runEarQuiz($('#q'), p.mode, p.level, s, { save: true });
        if (!r) return;
        const correct = r.answers.filter(a => a.correct).length;
        report({ res: null, P: null, extra: { passed: correct >= lesson.pass.correct, score: r.score, detail: `${correct} of 10 correct` } });
      };
      return;
    }
    case 'sequence': return sequenceLesson(lesson, s, ex, report, daily);
    default: {
      const tg = BUILD[lesson.type](p, s);
      return pitchStep(tg, s, ex).then(r => {
        if (lesson.pass?.metric === 'bias') return baselineBias().then(b => report({ ...r, extra: { baselineBias: b } }));
        return report(r);
      });
    }
  }
}

// One pitch exercise on a stage, with a Start button. Resolves when it ends.
function pitchStep(tg, s, box, { autoStart = false, msg = 'Sing the dark bars; you hear each note first.' } = {}) {
  return new Promise(resolve => {
    box.innerHTML = `<div class="stage" id="lstage" style="height:min(40vh,360px)"></div>
      <div class="controls"><button class="primary" id="lgo">▶ Start</button><span class="dim small" id="lmsg">${esc(msg)}</span></div>`;
    const run = runPracticeOnce($('#lstage'), tg, s);
    const btn = $('#lgo');
    let started = false;
    const go = async () => {
      if (run.P.playing) return run.P.stop(false);
      if (started) return;
      if (needsTimingCheck() && !(await timingCheck())) return;
      started = true; btn.textContent = '■ Stop';
      try { await run.start(); } catch (e) { started = false; btn.textContent = '▶ Start'; toast(e.message, 6000); }
    };
    btn.onclick = go;
    run.done.then(r => { btn.disabled = true; btn.textContent = 'Done'; resolve(r); });
    if (autoStart) go();
  });
}

async function baselineBias() {
  try {
    const runs = await api('/api/runs?limit=15&details=1');
    const b = runs.map(r => r.details?.bias).filter(x => typeof x === 'number');
    return b.length >= 3 ? b.reduce((a, x) => a + x, 0) / b.length : null;
  } catch { return null; }
}

// ---- glide tracker: sirens and slides, no target notes
function analyseGlides(trail, p, s) {
  const { lo, hi } = rangeOf(s);
  const need = Math.max(3, Math.round((p.span === 'range' ? Math.max(5, Math.min(12, hi - lo - 3)) : p.span) * (p.spanScale ?? 1)));
  const segs = []; let cur = null, gap = 0;
  for (const f of trail) {
    if (f.midi !== null) {
      if (!cur) cur = { pts: [], jumps: 0, flip: null };
      if (cur.pts.length) {
        const prev = cur.pts[cur.pts.length - 1];
        if (Math.abs(f.midi - prev.midi) > 1.2 && f.t - prev.t < 0.05) { cur.jumps++; cur.flip ??= Math.max(f.midi, prev.midi); }
      }
      cur.pts.push(f); gap = 0;
    } else if (cur && ++gap > 15) { segs.push(cur); cur = null; gap = 0; }
  }
  if (cur) segs.push(cur);
  const good = [];
  let flip = null;
  for (const sg of segs) {
    if (sg.pts.length < 40) continue;
    const ms = sg.pts.map(f => f.midi).sort((a, b) => a - b);
    const span = ms[Math.floor(ms.length * 0.95)] - ms[Math.floor(ms.length * 0.05)];
    const goingDown = sg.pts[0].midi > sg.pts[sg.pts.length - 1].midi;
    if (span < need) continue;
    if (p.down && !goingDown) continue;
    if (p.smooth || p.down === true && p.smoothRequired) { if (sg.jumps > 0) continue; }
    good.push({ span, jumps: sg.jumps });
    if (sg.flip && !flip) flip = sg.flip;
  }
  return { count: good.length, need, flip, smoothCount: good.filter(g => !g.jumps).length };
}

function glideStep(p, s, box) {
  const tg = { notes: [], cues: [], marks: [{ t: 0.6, text: `${p.label}: ${p.count} time${p.count > 1 ? 's' : ''}` }], duration: p.seconds, range: null };
  return pitchStep(tg, s, box, { msg: `Glide ${p.down ? 'from high to low' : 'from low to high and back'} while the screen runs; your line shows how far you travel.` }).then(r => {
    const a = analyseGlides(r.P.trail, p, s);
    const passSpec = { ...p, smooth: (p.smooth || false) };
    const count = passSpec.smooth ? a.smoothCount : a.count;
    const passed = count >= p.count;
    const detail = `${count} glide${count === 1 ? '' : 's'} covering ${a.need}+ semitones${a.flip ? ` · your voice changed gear around ${noteName(a.flip)}` : ''}`;
    return { res: null, P: null, extra: { passed, detail } };
  });
}

// ---- breath meter: an even hiss
function breathLesson(lesson, s, ex, report, offs) {
  const need = lesson.params.seconds;
  ex.innerHTML = `<div class="card">
      <div class="tuner" id="bsec">0.0 s</div>
      <div class="meter" style="height:18px"><i id="blevel" style="left:0;top:0;height:18px;width:0;border-radius:99px;background:var(--accent)"></i></div>
      <p class="dim small" id="bmsg">Press Start, take a low breath, then hiss “sss” as evenly as you can.</p>
      <div class="row"><button class="primary" id="bgo">▶ Start</button></div></div>`;
  $('#bgo').onclick = async () => {
    $('#bgo').disabled = true;
    try { await startMic(); } catch (e) { $('#bgo').disabled = false; return toast(e.message, 6000); }
    let runStart = null, last = 0, levels = [], best = 0, bestEven = 0, quietFor = 0;
    const t0 = performance.now();
    const off = onPitch(f => {
      const hissing = f.rms > 0.006 && f.hz === null;
      const now = performance.now();
      $('#blevel').style.width = `${clamp(Math.log10(f.rms / 0.002) * 50, 0, 100)}%`;
      if (hissing) {
        quietFor = 0;
        if (runStart === null) { runStart = now; levels = []; }
        levels.push(f.rms);
        const len = (now - runStart) / 1000;
        // evenness: how much the (smoothed) level moves around its average
        const sm = levels.map((_, i) => levels.slice(Math.max(0, i - 9), i + 1).reduce((a, x) => a + x, 0) / Math.min(10, i + 1));
        const mean = sm.reduce((a, x) => a + x, 0) / sm.length;
        const cv = Math.sqrt(sm.reduce((a, x) => a + (x - mean) ** 2, 0) / sm.length) / mean;
        best = Math.max(best, len);
        if (cv <= ease().even) bestEven = Math.max(bestEven, len);
        $('#bsec').textContent = `${len.toFixed(1)} s`;
        $('#bmsg').textContent = len >= need && cv <= ease().even ? `That’s ${need} s, nice and even ✓` : cv <= ease().even ? 'Nice and even…' : 'Try to keep it more even';
      } else if (runStart !== null && ++quietFor > 15) { runStart = null; }
      last = now;
      if ((now - t0) / 1000 > need + 15 || (bestEven >= need && runStart === null)) {
        off(); stopMic();
        report({ res: null, P: null, extra: { passed: bestEven >= need, detail: `longest even hiss ${bestEven.toFixed(1)} s (longest overall ${best.toFixed(1)} s)` } });
      }
    });
    offs.push(off);
    void last;
  };
}

// ---- home note: find the pitch you speak on, then sing it back
function homeNoteLesson(lesson, s, ex, report, offs) {
  const sing = () => {
    const p = { notes: Array(lesson.params.count).fill('home'), hold: lesson.params.hold, label: 'hey', think: true };
    pitchStep(BUILD.sustain(p, s), s, ex).then(report);
  };
  ex.innerHTML = `<div class="card"><p>${C.homeNote != null ? `Your home note is <b>${noteName(C.homeNote)}</b>. ` : ''}Press the button and say “hey” three times, like you’re greeting someone.</p>
    <div class="row"><button class="primary" id="hgo">🎙 Listen to me speak</button>${C.homeNote != null ? '<button id="hskip">Use my home note</button>' : ''}</div>
    <p class="dim small" id="hmsg"></p></div>`;
  $('#hskip')?.addEventListener('click', sing);
  $('#hgo').onclick = async () => {
    try { await startMic(); } catch (e) { return toast(e.message, 6000); }
    $('#hmsg').textContent = 'Listening… say “hey”, “hey”, “hey”';
    const got = [];
    await new Promise(res => {
      const t0 = performance.now();
      const off = onPitch(f => { if (f.midi !== null) got.push(f.midi); if (performance.now() - t0 > 5000) { off(); res(); } });
      offs.push(off);
    });
    if (got.length < 20) { $('#hmsg').textContent = 'I didn’t hear enough. Try again a little louder.'; return; }
    got.sort((a, b) => a - b);
    const m = Math.round(got[Math.floor(got.length / 2)]);
    C.homeNote = clamp(m, s.rangeLow, s.rangeHigh); saveCourse();
    $('#hmsg').innerHTML = `Your home note is <b>${noteName(C.homeNote)}</b>${m !== C.homeNote ? ` (you spoke around ${noteName(m)}, moved into your singing range)` : ''}. Now sing it back.`;
    setTimeout(sing, 1800);
  };
}

// ---- setup: range test + timing check
function setupLesson(lesson, s, ex, report) {
  const rangeDone = () => { try { return !!localStorage.getItem('vl-range-saved-at') || s.rangeLow !== 48 || s.rangeHigh !== 67; } catch { return false; } };
  const timingDone = () => { try { return localStorage.getItem(LAT_KEY) !== null; } catch { return false; } };
  const draw = () => {
    ex.innerHTML = `<div class="card">
      <div class="row"><span class="grow">${rangeDone() ? '✅' : '1.'} Find your comfortable range (${noteName(s.rangeLow)}–${noteName(s.rangeHigh)} now)</span><a class="btn ${rangeDone() ? '' : 'primary'}" href="#/range">Range test</a></div>
      <div class="row" style="margin-top:10px"><span class="grow">${timingDone() ? '✅' : '2.'} Measure your headphone delay</span><button class="${timingDone() ? '' : 'primary'}" id="tc">Timing check</button></div>
      <p class="dim small" style="margin-top:12px">The colours: <span style="color:var(--green)">green</span> within ${s.greenCents}¢, <span style="color:var(--amber)">amber</span> within ${s.amberCents}¢, <span style="color:var(--red)">red</span> further off. A cent is a hundredth of a semitone.</p></div>`;
    $('#tc').onclick = async () => { await timingCheck(); draw(); };
    if (rangeDone() && timingDone()) report({ res: null, P: null, extra: {} });
  };
  draw();
}
function rangeLesson(lesson, s, ex, report) {
  const startedAt = Number(sessionStorage.getItem('vl-range-lesson-start')) || Date.now();
  sessionStorage.setItem('vl-range-lesson-start', String(startedAt));
  const saved = Number(localStorage.getItem('vl-range-saved-at') || 0);
  ex.innerHTML = `<div class="card"><p>Your range now: <b>${noteName(s.rangeLow)}–${noteName(s.rangeHigh)}</b>. Retest it; if both ends feel steady, widen by a semitone.</p>
    <a class="btn primary" href="#/range">Open the range test</a></div>`;
  if (saved > startedAt) { sessionStorage.removeItem('vl-range-lesson-start'); report({ res: null, P: null, extra: {} }); }
}

// ---- warm-up and warm-down: several steps in a row
async function sequenceLesson(lesson, s, ex, report, daily) {
  const steps = lesson.params.steps;
  const results = [];
  for (let k = 0; k < steps.length; k++) {
    const st = steps[k];
    const box = document.createElement('div');
    ex.innerHTML = `<p class="dim small">Step ${k + 1} of ${steps.length}: <b>${esc(st.title)}</b></p>`;
    ex.appendChild(box);
    const r = st.type === 'glide' ? await glideStep(st.params, s, box) : await pitchStep(BUILD[st.type](st.params, s), s, box, { autoStart: k > 0 });
    if (!document.body.contains(ex)) return;
    results.push(r);
  }
  const scored = results.filter(r => r.res?.score != null);
  const score = scored.length ? scored.reduce((a, r) => a + r.res.score, 0) / scored.length : null;
  void score;   // a warm-up is about doing it, not a mark
  report({ res: null, P: null, extra: { passed: true, detail: daily ? 'Warmed up for today' : 'All steps done' } });
}

// ---- songs
async function pickSongLesson(lesson, s, ex, report) {
  const songs = (await api('/api/songs')).filter(x => x.status === 'ready');
  if (!songs.length) { ex.innerHTML = `<div class="card">No songs yet. <a href="#/">Add one from YouTube</a> first, then come back.</div>`; return; }
  songs.sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));
  ex.innerHTML = `<div class="card"><p class="dim small">Sorted by how much of each song sits in your range at its best octave. Over 90% is ideal; on the song page you can also shift the key.</p>
    ${songs.map(x => `<div class="row lesson-row open"><span class="grow"><b>${esc(x.title)}</b> <span class="dim small">${x.fit != null ? Math.round(100 * x.fit) + '% in range' : ''}</span></span>
      <button data-pick="${x.id}" class="${C.courseSong === x.id ? 'primary' : ''}">${C.courseSong === x.id ? 'Chosen ✓' : 'Choose'}</button></div>`).join('')}</div>`;
  ex.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    C.courseSong = b.dataset.pick; saveCourse();
    ex.querySelectorAll('[data-pick]').forEach(x => { x.textContent = x === b ? 'Chosen ✓' : 'Choose'; x.classList.toggle('primary', x === b); });
    report({ res: null, P: null, extra: { passed: true, detail: songs.find(x => x.id === b.dataset.pick).title } });
  });
}

async function songLessonCard(lesson, s, ex) {
  if (!C.courseSong) { ex.innerHTML = `<div class="card">Pick your course song first in <a href="#/lesson/7.1">Lesson 7.1</a>.</div>`; return; }
  let song = null;
  try { song = await api(`/api/songs/${C.courseSong}`); } catch { /* deleted */ }
  if (!song || song.status !== 'ready') { ex.innerHTML = `<div class="card">Your course song is gone. <a href="#/lesson/7.1">Pick another</a>.</div>`; return; }
  const p = lesson.params;
  const how = p.minFraction ? `Sing at least ${Math.round(p.minFraction * 100)}% of the song in one go.`
    : `Choose a section ${p.minSec}–${p.maxSec} seconds long with the From/To boxes (or the [ here and here ] buttons), then sing it.`;
  ex.innerHTML = `<div class="card"><p>Course song: <b>${esc(song.title)}</b> <a class="small" href="#/lesson/7.1">change</a></p>
    <p>${esc(how)} The song page will show this lesson’s cues and mark it passed when you get there.</p>
    <a class="btn primary" href="#/song/${song.id}?lesson=${lesson.id}">Open the song</a></div>`;
}

// Hooks used by the song page when it's opened from a lesson (#/song/<id>?lesson=7.2).
function setupSongLesson(lessonId, ui) {
  const lesson = lessonById(lessonId);
  if (!lesson || lesson.type !== 'song') return null;
  const p = lesson.params;
  const banner = document.createElement('div');
  banner.className = 'card lesson-banner';
  const partsLeft = () => (p.parts || []).filter(k => !C.partsPassed[lessonId]?.[k]);
  banner.innerHTML = `<div class="row"><b class="grow">Lesson ${lesson.id}: ${esc(lesson.title)}</b><a class="small" href="#/lesson/${lesson.id}">lesson page</a></div>
    <div class="cues">${lesson.cues.map(c => `<span class="cue">${esc(c)}</span>`).join('')}</div>
    <p class="dim small" id="lbmsg">${p.minFraction ? `Sing at least ${Math.round(p.minFraction * 100)}% of the song.` : `Pick a ${p.minSec}–${p.maxSec} s section, then sing it. Pass: ${esc(lesson.passText || '70%')}${C.ease ? ` (${ease().name}: ${ease().score}%)` : ''}.`}</p>`;
  ui.view.prepend(banner);
  if (p.guide != null) ui.setGuide(p.guide);
  if (p.lyrics != null) ui.setLyrics(p.lyrics);
  if (p.part) ui.setPart(p.part);
  if (p.parts) ui.setPart(partsLeft()[0] || p.parts[0]);
  if (p.finale && !ui.recording()) toast('Recording is off in Settings, so this run won’t be saved as a take.', 5000);
  if (p.breathMarks) {
    const ns = ui.an.notes, marks = [];
    for (let k = 1; k < ns.length; k++) if (ns[k].t0 - ns[k - 1].t1 >= 0.3) marks.push(ns[k - 1].t1 + 0.05);
    ui.P.opts.breathMarks = marks;
  }
  return {
    async onResult(res, runP) {
      const { from, to } = ui.sec();
      const len = to - from;
      const msg = $('#lbmsg');
      if (p.minFraction ? len < p.minFraction * ui.an.duration : (len < p.minSec || len > p.maxSec)) {
        msg.textContent = p.minFraction ? `That section is ${Math.round(100 * len / ui.an.duration)}% of the song; set From/To to cover at least ${Math.round(p.minFraction * 100)}%.`
          : `That section is ${Math.round(len)} s; this lesson wants ${p.minSec}–${p.maxSec} s.`;
        return;
      }
      if (!res.finished) { msg.textContent = 'Sing the section to the end for it to count.'; return; }
      const jp = easedLesson(lesson).pass;
      let passed = (res.score ?? 0) >= ease().score, detail = '';
      if (p.breathMarks) {
        const marks = ui.P.opts.breathMarks.filter(b => b > from && b < to);
        const after = res.notes.filter(n => marks.some(b => n.t0 > b && n.t0 - b < 1.2));
        const graded = ui.P.notes.filter(n => after.some(a => a.t0 === n.t0) && n.result);
        const onset = graded.length ? graded.reduce((a, n) => a + n.result.onset, 0) / graded.length : 1;
        passed = passed && onset >= jp.onset;
        detail = ` Starts after breaths: ${Math.round(onset * 100)}%.`;
      }
      if (p.parts) {
        const part = ui.part();
        if (passed && p.parts.includes(part)) { (C.partsPassed[lessonId] ||= {})[part] = true; saveCourse(); }
        const left = partsLeft();
        passed = left.length === 0;
        detail = left.length ? ` Next: switch Part to “${PARTS[left[0]].label}”.` : '';
        if (left.length) ui.setPart(left[0]);
      }
      if (p.listenBack && passed) {
        msg.innerHTML = `Listen to your take below, then note one thing you liked and one to fix:
          <div style="display:grid;gap:6px;margin-top:6px"><input type="text" id="liked" placeholder="I liked…"><input type="text" id="tofix" placeholder="Next time I’ll fix…"><button class="primary" id="savenotes">Save notes</button></div>`;
        $('#savenotes').onclick = () => {
          const liked = $('#liked').value.trim(), fix = $('#tofix').value.trim();
          if (!liked || !fix) return toast('Write both, even a few words');
          (C.notes[ui.id] ||= []).push({ liked, fix, at: Date.now() });
          recordAttempt(lessonId, res.score, true);
          msg.innerHTML = `Saved. <b>Lesson ${lessonId} passed ✓</b> <a href="#/lessons">Back to lessons</a>`;
        };
        recordAttempt(lessonId, res.score, false);
        return;
      }
      recordAttempt(lessonId, res.score, passed);
      if (passed && p.marksSongPassed) { C.songsPassed[ui.id] = true; saveCourse(); }
      if (passed && p.finale) {
        const run = await runP;
        C.finale = { songId: ui.id, title: ui.song.title, score: Math.round(res.score), at: Date.now(), runId: run?.id ?? null };
        saveCourse();
      }
      msg.innerHTML = passed ? `<b>Lesson ${lessonId} passed ✓</b> (${Math.round(res.score)}%).${detail} <a href="#/lessons">Back to lessons</a>`
        : `${Math.round(res.score ?? 0)}%, not yet ${ease().score}%.${detail} Loop the section and try again.`;
    },
  };
}

// ---------------------------------------------------------------- placement check
route(/^\/placement$/, async () => {
  const [s] = await Promise.all([settings(), course()]);
  if (!C.passed['1.1']) throw new Error('Do Lesson 1.1 (set up) first.');
  view.innerHTML = `<p class="dim small"><a href="#/lessons">Lessons</a> › Placement</p><h1>Placement check</h1>
    <p>Three short tests. Pass the first two (80%+) to start at Unit 4; all three to start at Unit 7. You can still open any earlier lesson.</p>
    <div id="ex"></div><div id="out"></div>`;
  cleanup = () => stopMic();
  const ex = $('#ex');
  const parts = [
    ['Sing back single notes', BUILD.sustain({ notes: ['mid', 'mid+3', 'mid-2', 'mid+5', 'mid-4'], hold: 2, think: true, label: 'ah' }, s)],
    ['Five-note scale', BUILD.drill({ drills: ['scale5'], maxRoots: 4 }, s)],
    ['Sing the jump', BUILD.interval({ intervals: [4, 7, -3, 5, -5, 12] }, s)],
  ];
  const scores = [];
  for (let k = 0; k < parts.length; k++) {
    const box = document.createElement('div');
    ex.innerHTML = `<p><b>${k + 1} of 3: ${parts[k][0]}</b></p>`; ex.appendChild(box);
    const r = await pitchStep(parts[k][1], s, box, { autoStart: k > 0 });
    if (!document.body.contains(ex)) return;
    scores.push(r.res?.score ?? 0);
    if (k === 1 && !(scores[0] >= 80 && scores[1] >= 80)) break;
  }
  const unit = scores[0] >= 80 && scores[1] >= 80 ? (scores[2] >= 80 ? 7 : 4) : 0;
  if (unit) { C.placedUnit = Math.max(C.placedUnit, unit); saveCourse(); }
  ex.innerHTML = '';
  $('#out').innerHTML = `<div class="card"><p>Scores: ${scores.map(x => Math.round(x) + '%').join(' · ')}</p>
    <p><b>${unit ? `You start at Unit ${unit}.` : 'Start at Unit 2; the early lessons will move quickly for you.'}</b></p>
    <a class="btn primary" href="#/lessons">Go to lessons</a></div>`;
}, 'lessons');

// Course finale pinned at the top of Progress.
window.addEventListener('hashchange', pinFinale);
window.addEventListener('DOMContentLoaded', pinFinale);
async function pinFinale() {
  if (!/^#\/history/.test(location.hash)) return;
  await course();
  setTimeout(async () => {
    const box = $('#finale');
    if (!box || !C.finale) return;
    let take = null;
    if (C.finale.runId) { try { take = (await api(`/api/runs/${C.finale.runId}`)).take; } catch { /* deleted */ } }
    box.innerHTML = `<div class="card pass"><b>📌 Course finale</b> · ${esc(C.finale.title)} · ${C.finale.score}% · ${fmtDate(C.finale.at / 1000)}
      ${take ? `<p><audio controls src="/media/takes/${esc(take)}"></audio></p>` : ''}</div>`;
  }, 300);
}
