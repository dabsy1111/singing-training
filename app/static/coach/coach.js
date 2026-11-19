// AI Coach page: live pitch, a short practice session, and a text chat with the coach.
// Audio stays in this browser tab. The only things sent to the server are the practice
// summary (numbers + the text shown under "What the coach sees") and what you type.

import { PitchSource, describeHz, hzToMidi, midiName, scoreTrial, summariseSession, sessionText } from './pitch.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('Not signed in'); }
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!r.ok) {
    const why = typeof data.detail === 'string' ? data.detail
      : (raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'no details');
    throw new Error(`HTTP ${r.status}: ${why}`);
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// --------------------------------------------------------------------------
// live pitch
// --------------------------------------------------------------------------

const src = new PitchSource();
const history = [];          // last few seconds of {t, hz}, for the trace
let target = null;           // midi of the note being practised, or null
let shownMidi = null;        // smoothed, for the display only
let settings = { rangeLow: 48, rangeHigh: 67, octaveFree: false };

src.on(f => {
  history.push(f);
  while (history.length && history[0].t < f.t - 6) history.shift();
  const noteEl = $('note');
  if (!f.hz) { noteEl.className = 'tuner'; return; }
  const m = hzToMidi(f.hz);
  shownMidi = shownMidi == null || Math.abs(m - shownMidi) > 1 ? m : shownMidi * 0.6 + m * 0.4;
  const d = describeHz(440 * Math.pow(2, (shownMidi - 69) / 12));
  noteEl.textContent = d.note;
  let off = d.cents;
  if (target != null) {
    off = Math.round((shownMidi - target) * 100);
    if (settings.octaveFree || $('octaveFree').checked) off = ((off + 600) % 1200 + 1200) % 1200 - 600;
  }
  const a = Math.abs(off);
  noteEl.className = 'tuner ' + (a <= 25 ? 'on' : a <= 50 ? 'near' : 'off');
  $('cents').textContent = target != null
    ? `${off > 0 ? '+' : ''}${off} cents from ${midiName(target)}${a <= 25 ? ' ✓' : off < 0 ? ' · go higher' : ' · go lower'}`
    : `${off > 0 ? '+' : ''}${off} cents`;
  $('needle').style.left = `calc(${50 + Math.max(-50, Math.min(50, off / 2))}% - 2px)`;
  $('hz').textContent = `${f.hz.toFixed(1)} Hz`;
});

function drawTrace() {
  const c = $('trace'), dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const now = performance.now() / 1000;
  const voiced = history.filter(f => f.hz).map(f => ({ t: f.t, m: hzToMidi(f.hz) }));
  const centre = target ?? (voiced.length ? voiced[voiced.length - 1].m : (settings.rangeLow + settings.rangeHigh) / 2);
  const span = 7;   // semitones each side
  const y = m => h / 2 - (m - centre) / span * (h / 2);
  const x = t => w - (now - t) / 6 * w;
  // semitone lines with names
  g.font = '11px system-ui'; g.textBaseline = 'middle';
  for (let m = Math.ceil(centre - span); m <= centre + span; m++) {
    g.fillStyle = '#323745'; g.fillRect(0, Math.round(y(m)), w, 1);
    if (h / (2 * span) >= 14 || m % 2 === 0) { g.fillStyle = '#9aa1b2'; g.fillText(midiName(m), 4, y(m) - 6); }
  }
  if (target != null) {
    g.fillStyle = 'rgba(62,207,142,.18)';
    g.fillRect(0, y(target + 0.5), w, y(target - 0.5) - y(target + 0.5));
  }
  g.strokeStyle = '#7aa2ff'; g.lineWidth = 2.5; g.beginPath();
  let prev = null;
  for (const p of voiced) {
    if (prev && p.t - prev.t < 0.08 && Math.abs(p.m - prev.m) < 1.5) g.lineTo(x(p.t), y(p.m)); else g.moveTo(x(p.t), y(p.m));
    prev = p;
  }
  g.stroke();
  requestAnimationFrame(drawTrace);
}
requestAnimationFrame(drawTrace);

$('mic').onclick = async () => {
  if (src.running) {
    src.stop(); $('mic').textContent = '🎤 Start mic'; $('go').disabled = true; return;
  }
  try {
    const g = await src.start();
    $('mic').textContent = '⏹ Stop mic';
    $('go').disabled = false;
    const on = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter(k => g[k] === true);
    $('micInfo').textContent = `${g.label} · ${g.sampleRate} Hz` +
      (on.length ? ` · ⚠ the browser kept ${on.join(', ')} on; pitch may suffer` : ' · processing off ✓');
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Microphone permission was refused.' : 'Mic error: ' + e.message);
  }
};

// --------------------------------------------------------------------------
// practice session
// --------------------------------------------------------------------------

const EXERCISES = {
  match: { spots: [0.15, 0.85, 0.5, 0.3, 0.7], sing: 3 },
  hold: { spots: [0.3, 0.55, 0.75], sing: 6 },
};
let session = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function targetsFor(kind) {
  const lo = settings.rangeLow + 2, hi = Math.max(settings.rangeLow + 4, settings.rangeHigh - 2);
  return EXERCISES[kind].spots.map(p => Math.round(lo + p * (hi - lo)));
}

function renderTrials(targets, results, now) {
  $('trials').innerHTML = targets.map((m, i) => {
    const r = results[i];
    const cls = r ? (r.hit ? 'hit' : 'miss') : i === now ? 'now' : '';
    const body = !r ? '<span class="dim">…</span>'
      : !r.voicedSec ? '<span class="dim">no singing heard</span>'
      : `${r.medianCents > 0 ? '+' : ''}${r.medianCents} c · ${r.inTunePct}% in tune`;
    return `<div class="trial ${cls}"><b>${midiName(m)}</b>${body}</div>`;
  }).join('');
}

function say(text, cls = '') { const p = $('prompt'); p.textContent = text; p.className = 'prompt ' + cls; }

async function runSession() {
  const kind = $('exercise').value, ex = EXERCISES[kind];
  const targets = targetsFor(kind), results = [];
  session = { stop: false };
  $('go').hidden = true; $('stopSession').hidden = false; $('sentBox').hidden = true;
  renderTrials(targets, results, 0);
  try {
    for (let i = 0; i < targets.length && !session.stop; i++) {
      target = targets[i];
      renderTrials(targets, results, i);
      say(`Listen: ${midiName(target)}`, 'listen');
      await src.playNote(target, 1.3);
      await sleep(250);                       // let the tone die away before listening
      if (session.stop) break;
      const frames = [];
      const off = src.on(f => frames.push(f));
      const t0 = performance.now() / 1000;
      for (let s = ex.sing; s > 0 && !session.stop; s--) {
        say(`Sing ${midiName(target)}${kind === 'hold' ? ' and hold it steady' : ''} · ${s}`, 'sing');
        await sleep(1000);
      }
      off();
      if (session.stop) break;
      results.push(scoreTrial(frames, target, t0, { octaveFree: $('octaveFree').checked }));
      renderTrials(targets, results, i + 1);
      await sleep(500);
    }
  } finally {
    target = null;
    $('go').hidden = false; $('stopSession').hidden = true;
  }
  if (results.length < targets.length) { say('Stopped. Nothing was saved.'); return; }

  const summary = summariseSession(kind, results, {
    rangeLow: settings.rangeLow, rangeHigh: settings.rangeHigh,
    mid: (settings.rangeLow + settings.rangeHigh) / 2, octaveFree: $('octaveFree').checked,
  });
  const text = sessionText(summary);
  $('sentText').textContent = text; $('sentBox').hidden = false;
  say(`Done: ${summary.hits}/${summary.notes} on target.`);
  if (!$('autoAsk').checked || !coachOn) { say(`Done: ${summary.hits}/${summary.notes} on target. Not sent to the coach.`); return; }
  addMsg('note', 'Sent the session results to the coach');
  const wait = addMsg('assistant wait', 'Coach is thinking…');
  const question = $('msg').value.trim();
  if (question) { addMsg('user', question); $('msg').value = ''; }
  try {
    const r = await api('/api/session', { method: 'POST', body: {
      exerciseType: 'coach_drill', title: kind === 'hold' ? 'Hold the pitch' : 'Match the note',
      tendency: summary.biasCents == null ? undefined : Math.abs(summary.biasCents) < 8 ? 'centred' : summary.biasCents < 0 ? 'flat' : 'sharp',
      targetNotes: results.map(t => t.target),
      pitchAccuracy: summary.inTunePct,
      detectedRange: summary.detectedRange,
      missedNotes: results.filter(t => !t.hit).map(t => t.target),
      details: text,
      userMessage: question || undefined,
    } });
    $('sentText').textContent = r.sent || text;
    showReply(wait, r);
    loadMemory();
  } catch (e) { wait.className = 'msg note'; wait.textContent = '⚠ ' + e.message; }
}

$('go').onclick = () => { if (!session) runSession().finally(() => (session = null)); };
$('stopSession').onclick = () => { if (session) session.stop = true; };

// --------------------------------------------------------------------------
// coach chat
// --------------------------------------------------------------------------

let coachOn = false;

function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role; d.textContent = text;
  $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
  return d;
}

function showReply(el, r) {
  el.className = 'msg assistant'; el.textContent = r.reply;
  for (const n of r.notesAdded || []) addMsg('note', `📝 Coach remembered: ${n.note}`);
}

async function askCoach(message) {
  addMsg('user', message);
  const wait = addMsg('assistant wait', 'Coach is thinking…');
  try {
    const r = await api('/api/coach/chat', { method: 'POST', body: { message } });
    showReply(wait, r);
    if (r.notesAdded?.length) loadMemory();
  } catch (e) { wait.className = 'msg note'; wait.textContent = '⚠ ' + e.message; }
}

$('ask').onsubmit = e => {
  e.preventDefault();
  const m = $('msg').value.trim();
  if (!m) return;
  $('msg').value = '';
  askCoach(m);
};

// --------------------------------------------------------------------------
// memory
// --------------------------------------------------------------------------

async function loadMemory() {
  const [notes, sessions, pv] = await Promise.all([api('/api/memory'), api('/api/coach/sessions?limit=3'), api('/api/coach/preview')]);
  $('memCount').textContent = `(${notes.length} note${notes.length === 1 ? '' : 's'})`;
  $('notes').innerHTML = notes.length
    ? notes.map(n => `<li><span>${esc(n.note)} <span class="dim small">${esc(n.created_at.slice(0, 10))}</span></span><button data-note="${n.id}" aria-label="Delete">✕</button></li>`).join('')
    : '<li><span class="dim">Nothing yet. The coach saves notes as it learns about you.</span></li>';
  $('sessions').innerHTML = sessions.length
    ? sessions.map(s => `<li><span><span class="dim">${new Date(s.created * 1000).toLocaleString()}</span><br>${esc(s.text)}</span><button data-session="${s.id}" aria-label="Delete">✕</button></li>`).join('')
    : '<li><span class="dim">No sessions yet.</span></li>';
  $('preview').textContent = pv.system;
}

$('notes').onclick = async e => {
  const id = e.target.dataset.note; if (!id) return;
  await api('/api/memory/' + id, { method: 'DELETE' }); loadMemory();
};
$('sessions').onclick = async e => {
  const id = e.target.dataset.session; if (!id) return;
  await api('/api/coach/sessions/' + id, { method: 'DELETE' }); loadMemory();
};
$('addNote').onsubmit = async e => {
  e.preventDefault();
  const t = $('noteText').value.trim(); if (!t) return;
  try { await api('/api/memory', { method: 'POST', body: { note: t } }); $('noteText').value = ''; loadMemory(); }
  catch (err) { toast(err.message); }
};
$('clearChat').onclick = async () => {
  if (!confirm('Clear the chat history? Notes and sessions stay.')) return;
  await api('/api/coach/messages', { method: 'DELETE' }); $('log').innerHTML = '';
};
$('forget').onclick = async () => {
  if (!confirm('Delete every coach note, session summary and chat message?')) return;
  await api('/api/coach/everything', { method: 'DELETE' }); $('log').innerHTML = ''; loadMemory();
};

// --------------------------------------------------------------------------
// start up
// --------------------------------------------------------------------------

(async () => {
  try {
    const s = await fetch('/api/settings').then(r => r.json());
    settings = { ...settings, ...s };
    $('octaveFree').checked = !!s.octaveFree;
  } catch {}
  try {
    const st = await api('/api/coach/status');
    coachOn = st.configured;
    $('model').textContent = st.model;
    $('notConfigured').hidden = coachOn;
    $('msg').disabled = !coachOn;
  } catch {}
  try {
    for (const m of await api('/api/coach/messages?limit=30')) addMsg(m.role, m.content);
  } catch {}
  loadMemory().catch(() => {});
})();
