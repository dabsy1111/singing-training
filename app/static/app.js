'use strict';
/* Vocal Lab front end. No build step, no dependencies.
 * Pitch smoothing + jump gate adapted from kunukn/singing-experience (0BSD). */

// ---------------------------------------------------------------- helpers
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = m => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDate = t => new Date(t * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const o = { ...opts };
  if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers = { 'content-type': 'application/json' }; delete o.json; }
  const r = await fetch(path, o);
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}

let SETTINGS = null;
async function settings() { return SETTINGS || (SETTINGS = await api('/api/settings')); }
async function saveSettings(patch) { SETTINGS = await api('/api/settings', { method: 'PUT', json: patch }); return SETTINGS; }

// ---------------------------------------------------------------- audio
const A = { ctx: null, ready: null, stream: null, node: null, listeners: new Set(), gate: null, smooth: null };
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Safari 16.4+: tell iOS we play and record at once, so audio isn't muted by the
// silent switch and headphones stay the output while the mic is open.
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* not supported */ }
}

// Bluetooth delay differs per device (AirPods vs wired), so the extra latency lives in
// this browser's storage. Falls back to the old shared server setting.
const LAT_KEY = 'vl-latency-ms';
function deviceLatencyMs() {
  try { const v = localStorage.getItem(LAT_KEY); if (v !== null && v !== '') return Number(v); } catch { /* storage blocked */ }
  return SETTINGS?.latencyMs || 0;
}
function setDeviceLatencyMs(ms) { try { localStorage.setItem(LAT_KEY, String(Math.round(ms))); } catch { /* storage blocked */ } }

// Must be called from a tap/click the first time (browsers block audio until then).
// resume() is called before any await so it still counts as part of the gesture.
async function audioCtx() {
  if (!A.ctx || A.ctx.state === 'closed') {
    A.ctx = new AudioContext({ latencyHint: 'interactive' });
    A.ctx.onstatechange = () => {
      if (A.ctx?.state === 'interrupted') toast('Audio was interrupted (a call, Siri or another app). Press play again.', 6000);
    };
    A.ready = A.ctx.audioWorklet.addModule(`/static/pitch-worklet.js?v=${window.VL_VERSION || ''}`);
  }
  const resumed = A.ctx.state === 'running' ? null : A.ctx.resume().catch(() => {});
  await A.ready;
  await resumed;
  return A.ctx;
}

function createJumpGate(confirmS = 0.08) {
  let accepted = null, cand = null, since = 0;
  const near = (a, b) => Math.abs(1200 * Math.log2(a / b)) <= 100;
  return {
    push(hz, t) {
      if (accepted === null || near(hz, accepted)) { accepted = hz; cand = null; return hz; }
      if (cand === null || !near(hz, cand)) { cand = hz; since = t; } else cand = hz;
      if (t - since < confirmS) return null;
      accepted = hz; cand = null; return hz;
    },
    reset() { accepted = null; cand = null; },
  };
}
function smoothPitch(prev, hz) {
  if (prev === null) return hz;
  if (Math.abs(1200 * Math.log2(hz / prev)) > 100) return hz;
  return 0.35 * hz + 0.65 * prev;
}

async function startMic() {
  if (A.stream) return audioCtx();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs HTTPS. Open the https:// address (see the README).');
  setAudioSession('play-and-record');
  // On iPhone, opening the mic switches AirPods into headset mode, which changes the
  // audio hardware's sample rate. A context made before that can play back garbled,
  // so open the mic first and build the context afterwards. (While the mic is live,
  // iOS lets the page start audio without another tap.)
  if (IS_IOS && A.ctx && A.ctx.state !== 'closed') { try { await A.ctx.close(); } catch { /* ignore */ } A.ctx = null; }
  const s = SETTINGS || await settings();
  A.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: !!s.echoCancellation, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = await audioCtx();
  const src = ctx.createMediaStreamSource(A.stream);
  A.node = new AudioWorkletNode(ctx, 'pitch-processor');
  const sink = ctx.createGain(); sink.gain.value = 0;
  src.connect(A.node); A.node.connect(sink); sink.connect(ctx.destination);
  A.gate = createJumpGate(); A.smooth = null; A.filter = null;
  A.node.port.onmessage = e => {
    // the mic filter (mic-filter.js) drops breaths, clicks and bumps; rebuilt if its settings change
    const st = SETTINGS || {};
    const key = `${st.micFilter ?? 2}/${st.rangeLow}/${st.rangeHigh}`;
    if (!A.filter || A.filterKey !== key) { A.filter = createMicFilter(st.micFilter ?? 2, st.rangeLow, st.rangeHigh); A.filterKey = key; }
    for (const f of A.filter.push(e.data)) {
      let hz = null;
      if (f.hz > 0) {
        const g = A.gate.push(f.hz, f.t);
        if (g !== null) { A.smooth = smoothPitch(A.smooth, g); hz = A.smooth; } else hz = A.smooth;
      } else { A.gate.reset(); A.smooth = null; }
      const frame = { t: f.t, hz, midi: hz ? hzToMidi(hz) : null, rms: f.rms };
      A.listeners.forEach(fn => fn(frame));
    }
  };
  return ctx;
}

function stopMic() {
  A.stream?.getTracks().forEach(t => t.stop());
  A.node?.disconnect();
  A.stream = null; A.node = null; A.listeners.clear();
  setAudioSession('auto');
}

function onPitch(fn) { A.listeners.add(fn); return () => A.listeners.delete(fn); }

// Delay between "sound leaves the speaker" and "pitch frame arrives", in seconds.
// Safari doesn't report output latency, so on iPhone this is mostly the per-device setting.
function autoLatency() {
  const ctx = A.ctx; let l = (ctx?.outputLatency || 0) + (ctx?.baseLatency || 0);
  const tr = A.stream?.getAudioTracks()[0];
  const set = tr?.getSettings?.();
  if (set && typeof set.latency === 'number') l += set.latency;
  return l;
}

// Songs are decoded off to the side at 32 kHz: no tap needed to load them, a third less
// memory than 48 kHz on phones, and the buffers play in whichever context exists later.
const bufferCache = new Map();
async function loadBuffer(url) {
  if (bufferCache.has(url)) return bufferCache.get(url);
  const r = await fetch(url);
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!r.ok) throw new Error(`${r.status} loading audio`);
  const data = await r.arrayBuffer();
  const dec = new OfflineAudioContext(1, 1, 32000);
  const buf = await dec.decodeAudioData(data);
  if (bufferCache.size > 4) bufferCache.delete(bufferCache.keys().next().value);
  bufferCache.set(url, buf);
  return buf;
}

// Simple piano-ish tone, scheduled on the audio clock.
function playTone(ctx, dest, midi, when, dur, vol = 0.25) {
  const f = midiToHz(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(vol, when + 0.015);
  g.gain.exponentialRampToValueAtTime(vol * 0.45, when + 0.25);
  g.gain.setValueAtTime(vol * 0.45, Math.max(when + 0.25, when + dur - 0.06));
  g.gain.linearRampToValueAtTime(0.0001, when + dur);
  g.connect(dest);
  const oscs = [[1, 'triangle', 1], [2, 'sine', 0.3], [3, 'sine', 0.12]].map(([h, type, amp]) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * h;
    const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(g);
    o.start(when); o.stop(when + dur + 0.05); return o;
  });
  return oscs;
}

// ---------------------------------------------------------------- little shared trackers
const today = () => new Date().toLocaleDateString('en-CA');
function addSungSeconds(sec) {
  try {
    const k = 'vl-sung-' + today();
    localStorage.setItem(k, String((Number(localStorage.getItem(k)) || 0) + sec));
  } catch { /* ignore */ }
}
function sungSecondsToday() { try { return Number(localStorage.getItem('vl-sung-' + today())) || 0; } catch { return 0; } }
function markRangeSaved() { try { localStorage.setItem('vl-range-saved-at', String(Date.now())); } catch { /* ignore */ } }

// ---------------------------------------------------------------- scoring
function centsOff(userMidi, target, octaveFree) {
  let c = (userMidi - target) * 100;
  if (octaveFree) c = ((c % 1200) + 1800) % 1200 - 600;
  return c;
}

function gradeNote(note, s) {
  const dur = note.t1 - note.t0;
  const tw = Math.min(0.15, dur * 0.3);
  const fr = note.frames;
  if (!fr.length) return null;
  const hold = fr.filter(f => f.dt >= tw);
  const holdScore = hold.length
    ? hold.reduce((a, f) => a + (f.c === null ? 0 : Math.abs(f.c) <= s.greenCents ? 1 : Math.abs(f.c) <= s.amberCents ? 0.5 : 0), 0) / hold.length
    : 0;
  const firstGood = fr.find(f => f.c !== null && Math.abs(f.c) <= s.amberCents);
  const onset = firstGood ? clamp(1 - (firstGood.dt - 0.12) / 0.3, 0, 1) : 0;
  const atTw = fr.filter(f => f.dt >= tw && f.dt < tw + 0.08 && f.c !== null);
  const trans = atTw.length ? (Math.abs(atTw[0].c) <= s.amberCents ? 1 : Math.abs(atTw[0].c) <= 100 ? 0.5 : 0) : 0;
  const voiced = hold.filter(f => f.c !== null);
  const bias = voiced.length ? voiced.reduce((a, f) => a + f.c, 0) / voiced.length : null;
  return { score: 0.15 * onset + 0.15 * trans + 0.7 * holdScore, onset, trans, hold: holdScore, bias };
}

// Re-score a run at different time offsets to estimate leftover latency.
function bestOffset(notes, trail, s, tune = 0) {
  // Score each shift by how much of the singing lands on a note and in tune. Singing that
  // falls between notes counts against a shift, so long held notes don't pull it to the edge.
  const voiced = trail.filter(p => p.midi !== null);
  const scoreAt = off => {
    if (!voiced.length) return 0;
    let good = 0;
    for (const p of voiced) {
      const n = findNote(notes, p.t - off);
      if (n && Math.abs(centsOff(p.midi, n.midi + tune, s.octaveFree)) <= s.amberCents) good++;
    }
    return good / voiced.length;
  };
  const base = scoreAt(0);
  let best = { off: 0, score: base };
  for (let off = -0.6; off <= 0.601; off += 0.02) {
    const sc = scoreAt(off);
    if (sc > best.score + 1e-6 || (Math.abs(sc - best.score) < 1e-6 && Math.abs(off) < Math.abs(best.off))) best = { off, score: sc };
  }
  // Only worth mentioning if it's clearly better and not just the edge of the search.
  const real = best.score - base >= 0.04 && Math.abs(best.off) <= 0.56;
  return { off: real ? Math.round(best.off * 100) / 100 : 0, score: best.score, gain: best.score - base };
}

function findNote(notes, t) {
  let lo = 0, hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, n = notes[mid];
    if (t < n.t0) hi = mid - 1; else if (t >= n.t1) lo = mid + 1; else return n;
  }
  return null;
}

// ---------------------------------------------------------------- practice engine
/* A Practice drives one run: it plays audio, listens, scores and draws.
 * target: { notes:[{t0,t1,midi}], contour?, hop?, duration, range:[lo,hi] }
 * audio:  { buffers: {accomp, backing?, vocals}, rate? } for songs, or { synth: true } for drills
 *         rate < 1 plays a slowed (pitch-kept) copy; note times stay in original song seconds */
class Practice {
  constructor(el, target, audio, opts) {
    this.el = el; this.target = target; this.audio = audio; this.opts = opts;
    // shift: semitones added to every target note (an octave down = -12). The audio is untouched.
    this.shift = opts.shift || 0;
    this.notes = target.notes.map(n => ({ ...n, midi: n.midi + this.shift, frames: [], result: null }));
    this.tune = (target.tuning || 0) / 100;   // song tuning offset, in semitones
    window.__practice = this; // handy for debugging from the console
    this.pos = opts.start || 0;        // song time when stopped
    this.rate = 1;                     // playback speed (audio.rate), set at play()
    this.playing = false;
    this.trail = [];
    this.canvas = document.createElement('canvas');
    el.appendChild(this.canvas);
    this.hud = document.createElement('div'); this.hud.className = 'hud'; el.appendChild(this.hud);
    this.zoomEl = document.createElement('div'); this.zoomEl.className = 'zoom';
    this.zoomEl.innerHTML = '<button data-z="1" aria-label="Zoom in">+</button><button data-z="-1" aria-label="Zoom out">−</button>';
    this.zoomEl.onclick = e => { const b = e.target.closest('[data-z]'); if (b) this.zoom(+b.dataset.z); };
    el.appendChild(this.zoomEl);
    this.resize = this.resize.bind(this); window.addEventListener('resize', this.resize); this.resize();
    this.draw = this.draw.bind(this); this.raf = requestAnimationFrame(this.draw);
    this.bindDrag();
  }

  resize() {
    const r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.W = r.width; this.H = r.height; this.dpr = dpr;
  }

  bindDrag() {
    let x0 = null, p0 = 0;
    this.canvas.addEventListener('pointerdown', e => { if (!this.playing) { x0 = e.clientX; p0 = this.pos; this.canvas.setPointerCapture(e.pointerId); } });
    this.canvas.addEventListener('pointermove', e => {
      if (x0 === null) return;
      this.pos = clamp(p0 - (e.clientX - x0) / this.opts.settings.pxPerSecond, 0, this.target.duration);
      this.opts.onSeek?.(this.pos);
    });
    const up = () => { x0 = null; };
    this.canvas.addEventListener('pointerup', up); this.canvas.addEventListener('pointercancel', up);
  }

  now() {
    if (!this.playing) return this.pos;
    return this.startPos + (A.ctx.currentTime - this.startCtx) * this.rate;
  }

  async play({ from, to }) {
    const ctx = await startMic();
    const s = this.opts.settings;
    this.section = { from, to };
    // rate < 1 = slowed-down audio: song time runs at rate × real time. Latency stays in real seconds.
    const rate = this.rate = this.audio.rate || 1;
    this.latency = autoLatency() + deviceLatencyMs() / 1000;
    for (const n of this.notes) if (n.t1 > from && n.t0 < to) { n.frames = []; n.result = null; }
    this.trail = [];
    const lead = 0.15;
    this.startCtx = ctx.currentTime + lead; this.startPos = from;
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    this.nodes = [];
    if (this.audio.buffers) {
      for (const [key, buf] of Object.entries(this.audio.buffers)) {
        if (!buf) continue;
        const g = ctx.createGain(); g.gain.value = this.opts.volumes[key]; g.connect(this.master);
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(g);
        src.start(this.startCtx, from / rate, Math.max(0, to - from) / rate);
        this.nodes.push(src); this['gain_' + key] = g;
      }
    } else {
      const g = ctx.createGain(); g.gain.value = this.opts.volumes.guide ?? 0.8; g.connect(this.master); this.gain_guide = g;
      const cue = ctx.createGain(); cue.gain.value = 0.9; cue.connect(this.master);
      for (const c of this.target.cues || []) if (c.t0 >= from && c.t0 < to)
        this.nodes.push(...playTone(ctx, cue, c.midi, this.startCtx + (c.t0 - from) / rate, (c.t1 - c.t0) / rate, 0.22));
      for (const n of this.notes) if (n.t0 >= from && n.t0 < to && n.guide !== false)
        this.nodes.push(...playTone(ctx, g, n.midi, this.startCtx + (n.t0 - from) / rate, (n.t1 - n.t0) / rate, 0.2));
    }
    this.playing = true;
    this.unsub = onPitch(f => this.onFrame(f));
    this.recorder = null;
    if (s.recordTakes && window.MediaRecorder && A.stream) {
      try {
        this.chunks = [];
        this.recorder = new MediaRecorder(A.stream);
        this.recorder.ondataavailable = e => e.data.size && this.chunks.push(e.data);
        this.recorder.start();
      } catch { this.recorder = null; }
    }
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => this.stop(true), ((to - from) / rate + lead + 0.3) * 1000);
  }

  setShift(k) { this.setPart(this.target.notes, k, k); }

  // notes: the part to sing (melody or a harmony line), before shifting.
  // shift: semitones added to those notes. contourShift: where to draw the original melody line.
  setPart(notes, shift, contourShift = shift) {
    if (this.playing) return;
    this.target.notes = notes;
    this.shift = shift;
    this.contourShift = contourShift;
    this.notes = notes.map(n => ({ ...n, midi: n.midi + shift, frames: [], result: null }));
    this.trail = [];
  }

  setVolume(key, v) { const g = this['gain_' + key]; if (g) g.gain.value = v; }

  onFrame(f) {
    if (!this.playing) return;
    const t = this.startPos + (f.t - this.startCtx - this.latency) * this.rate;
    if (t < this.section.from - 0.2 || t > this.section.to) return;
    const s = this.opts.settings;
    const n = findNote(this.notes, t);
    let c = null;
    if (n && f.midi !== null) c = centsOff(f.midi, n.midi + this.tune, s.octaveFree);
    if (n && t >= this.section.from) n.frames.push({ dt: t - n.t0, c, rms: f.rms });
    let show = f.midi;
    if (show !== null && s.octaveFree && n) show = n.midi + this.tune + c / 100;   // draw in the target's octave
    this.trail.push({ t, midi: f.midi, show, c, onNote: !!n, rms: f.rms });
    this.opts.onFrame?.(f, t, n, c);
    this.current = { midi: f.midi, c, n };
    // grade notes that have finished
    for (const m of this.notes) if (!m.result && m.t1 < t && m.t0 >= this.section.from && m.frames.length) m.result = gradeNote(m, s);
  }

  async stop(finished = false) {
    if (!this.playing) return null;
    const reached = Math.min(this.now() - (this.latency || 0) * this.rate, this.section.to);
    addSungSeconds(Math.max(0, reached - this.section.from));
    this.playing = false;
    clearTimeout(this.endTimer);
    this.pos = clamp(reached, 0, this.target.duration);
    this.nodes.forEach(n => { try { n.stop(); } catch { /* already stopped */ } });
    this.master?.disconnect();
    this.unsub?.();
    const s = this.opts.settings;
    for (const m of this.notes) if (!m.result && m.t0 >= this.section.from && m.t1 <= reached && m.frames.length) m.result = gradeNote(m, s);
    let take = null;
    if (this.recorder) {
      take = await new Promise(res => {
        this.recorder.onstop = () => res(new Blob(this.chunks, { type: this.recorder.mimeType }));
        this.recorder.stop();
      });
    }
    const graded = this.notes.filter(n => n.result && n.t0 >= this.section.from && n.t1 <= reached);
    const totalDur = graded.reduce((a, n) => a + (n.t1 - n.t0), 0);
    const score = totalDur ? 100 * graded.reduce((a, n) => a + n.result.score * (n.t1 - n.t0), 0) / totalDur : null;
    const biases = graded.map(n => n.result.bias).filter(b => b !== null);
    const bias = biases.length ? biases.reduce((a, b) => a + b, 0) / biases.length : null;
    const off = this.trail.length > 100 ? bestOffset(this.notes, this.trail, s, this.tune) : { off: 0 };
    return {
      finished, score, take, bias, timingOffset: off.off / this.rate,   // real seconds, for the device setting
      speed: Math.round(this.rate * 100),
      notes: graded.map(n => ({ midi: n.midi, t0: n.t0, score: +n.result.score.toFixed(3), bias: n.result.bias === null ? null : Math.round(n.result.bias) })),
      section: this.section,
    };
  }

  destroy() {
    this.playing && this.stop();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
  }

  draw() {
    this.raf = requestAnimationFrame(this.draw);
    const { W, H, dpr } = this, g = this.canvas.getContext('2d');
    const s = this.opts.settings, pps = s.pxPerSecond;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const now = this.now(), px = W * 0.3;
    const t0 = now - px / pps, t1 = now + (W - px) / pps;
    const [lo, hi] = this.viewRange(now, t1);
    const rows = hi - lo + 1, rowH = H / rows;
    const mLo = Math.floor(lo), mHi = Math.ceil(hi);
    const y = m => H - (m - lo + 0.5) * rowH;
    const x = t => px + (t - now) * pps;
    // grid
    g.font = '11px system-ui'; g.textBaseline = 'middle';
    for (let m = mLo; m <= mHi; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      g.fillStyle = black ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.0)';
      g.fillRect(0, y(m) - rowH / 2, W, rowH);
      if (isC) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, y(m) + rowH / 2 - 1, W, 1); }
    }
    // section shading
    if (this.opts.sectionRef) {
      const { from, to } = this.opts.sectionRef();
      g.fillStyle = 'rgba(0,0,0,0.35)';
      if (x(from) > 0) g.fillRect(0, 0, x(from), H);
      if (x(to) < W) g.fillRect(x(to), 0, W - x(to), H);
    }
    // contour (song only)
    const tg = this.target;
    if (tg.contour && this.opts.showContour?.()) {
      g.strokeStyle = 'rgba(160,170,200,0.35)'; g.lineWidth = 1.5; g.beginPath();
      const i0 = Math.max(0, Math.floor(t0 / tg.hop)), i1 = Math.min(tg.contour.length - 1, Math.ceil(t1 / tg.hop));
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        const v = tg.contour[i];
        if (v === null) { pen = false; continue; }
        const X = x(i * tg.hop), Y = y(v + (this.contourShift ?? this.shift));
        pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true;
      }
      g.stroke();
    }
    // notes
    const green = css('--green'), amber = css('--amber'), red = css('--red');
    for (const n of this.notes) {
      if (n.t1 < t0 || n.t0 > t1) continue;
      const X0 = x(n.t0), X1 = x(n.t1), Y = y(n.midi + this.tune);
      let col = 'rgba(122,135,175,0.55)';
      if (n.result) col = n.result.score >= 0.75 ? green : n.result.score >= 0.45 ? amber : red;
      g.fillStyle = col; g.globalAlpha = n.result ? 0.45 : 1;
      roundRect(g, X0, Y - rowH * 0.38, Math.max(2, X1 - X0 - 1), rowH * 0.76, Math.min(5, rowH * 0.3));
      g.globalAlpha = 1;
      if (X1 - X0 > 26 && rowH > 11) { g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(n.label || noteName(n.midi), X0 + 4, Y); }
    }
    // user trail
    g.lineWidth = 3; g.lineCap = 'round';
    let prev = null;
    for (const p of this.trail) {
      if (p.t < t0 - 0.1 || p.show === null) { prev = null; continue; }
      const X = x(p.t), Y = y(clamp(p.show, lo - 0.4, hi + 0.4));
      g.strokeStyle = p.c === null ? 'rgba(220,225,240,0.6)' : Math.abs(p.c) <= s.greenCents ? green : Math.abs(p.c) <= s.amberCents ? amber : red;
      if (prev && p.t - prev.t < 0.05) { g.beginPath(); g.moveTo(prev.X, prev.Y); g.lineTo(X, Y); g.stroke(); }
      prev = { X, Y, t: p.t };
    }
    // text marks from lessons ("think it…", "5th up", glide instructions)
    if (this.opts.marks?.length) {
      g.fillStyle = 'rgba(232,234,240,0.9)'; g.font = '600 13px system-ui'; g.textBaseline = 'top';
      for (const m of this.opts.marks) if (m.t > t0 - 3 && m.t < t1) g.fillText(m.text, Math.max(4, x(m.t)), 8);
      g.font = '11px system-ui'; g.textBaseline = 'middle';
    }
    // breath marks (gaps in the melody where a breath fits)
    if (this.opts.breathMarks) {
      g.fillStyle = 'rgba(122,162,255,0.9)'; g.font = 'bold 13px system-ui'; g.textBaseline = 'top';
      for (const b of this.opts.breathMarks) if (b > t0 && b < t1) { g.fillRect(x(b) - 1, 0, 2, 10); g.fillText('✓ breathe', x(b) + 3, 2); }
      g.font = '11px system-ui'; g.textBaseline = 'middle';
    }
    // playhead
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(px, 0, 1, H);
    // left labels
    g.fillStyle = 'rgba(200,205,220,0.7)';
    for (let m = mLo; m <= mHi; m++) if (rowH > 9 && (((m % 12) + 12) % 12 === 0 || rowH > 16) && ![1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12)) g.fillText(noteName(m), 4, y(m));
    // HUD
    const cur = this.playing ? this.current : null;
    if (cur && cur.midi !== null) {
      const c = cur.c;
      const word = c === null ? '' : Math.abs(c) <= s.greenCents ? 'on it' : c > 0 ? 'aim lower' : 'aim higher';
      this.hud.innerHTML = `<div class="big">${noteName(cur.midi)}</div><div class="dim small">${c === null ? '' : (c > 0 ? '+' : '') + Math.round(c) + '¢ · ' + word}</div>`;
    } else this.hud.innerHTML = `<div class="dim small">${fmtTime(Math.max(0, now))}</div>`;
  }

  // The whole melody's range, padded: the most the view ever shows.
  fullRange() {
    if (this._full && this._full.n === this.notes.length && this._full.shift === this.shift) return this._full.r;
    const s = this.opts.settings;
    let lo = s.rangeLow, hi = s.rangeHigh;
    if (this.notes.length) {
      const m = this.notes.map(n => n.midi).sort((a, b) => a - b);
      lo = m[Math.floor(m.length * 0.02)]; hi = m[Math.ceil(m.length * 0.98) - 1];
    }
    lo -= 3; hi += 3;
    while (hi - lo < 10) { lo--; hi++; }
    this._full = { n: this.notes.length, shift: this.shift, r: [lo, hi] };
    return [lo, hi];
  }

  // How many semitone rows to show. Auto keeps rows about 26 px tall; +/− buttons override (kept per device).
  rowsShown() {
    const [flo, fhi] = this.fullRange(), full = fhi - flo + 1;
    let want = +localStorage.getItem('vl.stageRows') || 0;
    if (!want) want = clamp(Math.round(this.H / 26), 10, 18);
    return Math.min(want, full);
  }

  zoom(dir) {
    const [flo, fhi] = this.fullRange(), full = fhi - flo + 1;
    const rows = clamp(this.rowsShown() - dir * 2, 7, full);
    localStorage.setItem('vl.stageRows', rows >= full ? String(full + 50) : String(rows));   // "+50" = always fit
  }

  // Visible pitch window, following the notes coming up so they're always on screen and readable.
  viewRange(now, tEnd) {
    const [flo, fhi] = this.fullRange(), rows = this.rowsShown();
    if (rows >= fhi - flo + 1) return [flo, fhi];
    // Notes from just behind the playhead to the right edge; if they don't fit, the next 2.5 s.
    const pick = (a, b) => this.notes.filter(n => n.t1 > a && n.t0 < b).map(n => n.midi + this.tune);
    let m = pick(now - 0.5, tEnd);
    if (m.length && Math.max(...m) - Math.min(...m) + 3 > rows) m = pick(now - 0.2, now + 2.5);
    let centre = this.viewCentre ?? (flo + fhi) / 2;
    if (m.length) centre = (Math.max(...m) + Math.min(...m)) / 2;
    else if (this.current?.midi != null) centre = this.current.midi;   // gap in the melody: keep near your voice
    centre = clamp(centre, flo + (rows - 1) / 2, fhi - (rows - 1) / 2);
    // Glide rather than jump, so the notes don't twitch about.
    const t = performance.now(), dt = Math.min(0.5, ((t - (this._vt || t)) / 1000));
    this._vt = t;
    if (this.viewCentre == null || Math.abs(centre - this.viewCentre) > rows) this.viewCentre = centre;
    else this.viewCentre += (centre - this.viewCentre) * (1 - Math.exp(-dt / 0.35));
    const lo = this.viewCentre - (rows - 1) / 2;
    return [lo, lo + rows - 1];
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
}

async function saveRun(kind, ref, title, res, extra = {}) {
  const fd = new FormData();
  fd.append('meta', JSON.stringify({
    kind, ref, title, score: res.score === null ? null : +res.score.toFixed(1),
    details: { notes: res.notes, bias: res.bias, section: res.section, timingOffset: res.timingOffset, ...extra },
  }));
  if (res.take && res.take.size > 2000) fd.append('take', res.take, 'take');
  return api('/api/runs', { method: 'POST', body: fd });
}

function resultsHTML(res, s) {
  if (res.score === null) return `<div class="card dim">Not enough singing to grade. Sing along with the notes and try again.</div>`;
  const hit = res.notes.filter(n => n.score >= 0.75).length;
  const biasTxt = res.bias === null ? '–' : Math.abs(res.bias) < 8 ? 'Centred' : res.bias > 0 ? `${Math.round(res.bias)}¢ sharp` : `${Math.round(-res.bias)}¢ flat`;
  const worst = [...res.notes].sort((a, b) => a.score - b.score).slice(0, 3).map(n => noteName(n.midi));
  const off = Math.round(res.timingOffset * 1000);
  return `<div class="card"><div class="results">
    <div class="stat"><span class="dim small">Score</span><b>${Math.round(res.score)}%</b></div>
    <div class="stat"><span class="dim small">Notes landed</span><b>${hit}/${res.notes.length}</b></div>
    <div class="stat"><span class="dim small">Tendency</span><b>${biasTxt}</b></div>
    <div class="stat"><span class="dim small">Weakest notes</span><b>${worst.join(' ') || '–'}</b></div>
  </div>
  ${Math.abs(off) >= 60 ? `<p class="small">Your pitch lines up best with the notes when shifted by ${off} ms. Bluetooth headphones usually need this once. <button data-latency="${off}">Add ${off} ms for this device</button></p>` : ''}
  ${res.take ? `<p><audio controls src="${URL.createObjectURL(res.take)}"></audio></p>` : ''}
  </div>`;
}

function bindLatencyButton(el) {
  el.querySelectorAll('[data-latency]').forEach(b => b.onclick = () => {
    setDeviceLatencyMs(deviceLatencyMs() + Number(b.dataset.latency));
    toast(`Latency on this device is now ${deviceLatencyMs()} ms`); b.disabled = true;
  });
}

// ---------------------------------------------------------------- timing check
/* Measures how late your voice reaches the app compared with when a note was played:
 * output delay (Bluetooth can be 150-300 ms) plus mic delay. You hear a count-in, then
 * sing "da" with each beep. The beeps have rests in an uneven pattern so the result
 * can't be mistaken for one beat early or late. Runs once per browser session. */
const CHECK_KEY = 'vl-timing-checked';
const CHECK_BEAT = 0.5;
const CHECK_PATTERN = [0, 1, 2, 4, 5, 7, 8, 9, 11];   // beats with a note, after the count-in
const CHECK_NOTE = 0.28;

// The rhythm written out like lyrics, so you know where the gaps are before it starts.
function checkPatternHTML(count = true) {
  const last = CHECK_PATTERN[CHECK_PATTERN.length - 1];
  const beats = Array.from({ length: last + 1 }, (_, b) => CHECK_PATTERN.includes(b) ? '<b>da</b>' : '<span class="dim">–</span>');
  const bars = [];
  for (let i = 0; i < beats.length; i += 4) bars.push(beats.slice(i, i + 4).join(' '));
  if (count) bars.unshift('<span class="dim">1 2 3 4</span>');
  return `<p class="tc-pattern">${bars.map(b => `<span class="bar">${b}</span>`).join('')}</p>`;
}

function needsTimingCheck() { try { return !sessionStorage.getItem(CHECK_KEY); } catch { return false; } }
function markTimingChecked() { try { sessionStorage.setItem(CHECK_KEY, '1'); } catch { /* ignore */ } }

/* Works out the delay from when your voice starts, not its pitch: a beginner's "da" can be
 * a few semitones (or an octave) away from the beep, and a pitch tracker needs time to lock
 * onto a short syllable. frames: [{t, rms, voiced}] with t relative to the first beep.
 * Returns { d (seconds) | null, matched (beeps with a "da" on them), heard, peak, floor }. */
function estimateDelay(frames, onsets, maxDelay = 1.0) {
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
  const pre = frames.filter(f => f.t < -0.3).map(f => f.rms);         // the count-in: mostly room noise
  const all = frames.map(f => f.rms);
  const floor = Math.max(0.0015, pct(pre.length > 20 ? pre : all, 0.3));
  const peak = pct(all, 0.98);
  const thr = Math.max(floor * 2.5, floor + 0.2 * (peak - floor), 0.004);
  // Voice active = loud enough, or the pitch tracker hears a voice at any pitch.
  const act = frames.map(f => f.rms > thr || (f.voiced && f.rms > Math.max(floor * 2, 0.004)));
  // Onsets: active after at least 70 ms of quiet; ignore anything within 180 ms of the last.
  const starts = [];
  let quiet = 99, last = -9;
  frames.forEach((f, i) => {
    if (act[i]) { if (quiet >= 7 && f.t - last > 0.18) { starts.push(f.t); last = f.t; } quiet = 0; } else quiet++;
  });
  const heard = starts.filter(t => t > -0.2).length;
  let best = { d: null, score: -Infinity, matched: 0, inGaps: 0 };
  const lastOn = onsets[onsets.length - 1];
  for (let d = -0.1; d <= maxDelay + 1e-9; d += 0.005) {
    let score = 0, matched = 0, inGaps = 0;
    for (const o of onsets) {
      const near = starts.reduce((m, t) => Math.min(m, Math.abs(t - (o + d))), 9);
      if (near < 0.14) { score += 1 - near / 0.14; matched++; }
    }
    // a "da" in a gap counts against this delay
    for (const t of starts) if (t > -0.2 && onsets.every(o => Math.abs(t - (o + d)) > 0.25)) {
      score -= 0.6;
      if (t < lastOn + d + 0.3) inGaps++;
    }
    if (score > best.score) best = { d, score, matched, inGaps };
  }
  return { ...best, heard, peak, floor, starts };
}

function timingCheck() {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    document.body.appendChild(wrap);
    const close = ok => { off?.(); wrap.remove(); resolve(ok); };
    let off = null;
    const intro = (note = '') => {
      wrap.innerHTML = `<div class="card">
        <h2 style="margin-top:0">Quick timing check</h2>
        <p>Put your headphones on. You'll hear four clicks, then short beeps with a few gaps. Sing a short "da" in time with each beep, as if you were singing along. This is the pattern (– is a gap):</p>
        ${checkPatternHTML()}
        <p class="small dim">Go by what you hear in your headphones, not the screen: the screen runs ahead of Bluetooth audio.</p>
        <p class="small dim">This measures your headphone and mic delay so your notes line up. About 10 seconds. Current setting for this device: ${deviceLatencyMs()} ms extra.</p>
        ${note}
        <div class="row"><button class="primary" data-a="start">Start</button><button data-a="skip">Skip for now</button></div></div>`;
      wrap.querySelector('[data-a=start]').onclick = run;
      wrap.querySelector('[data-a=skip]').onclick = () => { markTimingChecked(); close(true); };
    };
    async function run() {
      wrap.innerHTML = `<div class="card"><h2 style="margin-top:0">Listen…</h2><p class="tuner" id="tc-beat">·</p>
        ${checkPatternHTML()}
        <div class="meter" title="Microphone level"><div id="tc-level"></div></div>
        <p class="dim small" style="text-align:center">Sing "da" with each beep you hear. The bar shows the mic hearing you.</p></div>`;
      let ctx;
      try { ctx = await startMic(); } catch (e) { intro(`<p class="err">${esc(e.message)}</p>`); return; }
      const s = SETTINGS || await settings();
      const m = Math.round((s.rangeLow + s.rangeHigh) / 2);
      const out = ctx.createGain(); out.connect(ctx.destination);
      const t0 = ctx.currentTime + 0.5;                 // first count-in click
      const start = t0 + 4 * CHECK_BEAT;                 // first beep
      for (let i = 0; i < 4; i++) playTone(ctx, out, m + 12, t0 + i * CHECK_BEAT, 0.05, 0.3);
      const onsets = CHECK_PATTERN.map(b => b * CHECK_BEAT);
      onsets.forEach(o => playTone(ctx, out, m, start + o, CHECK_NOTE, 0.3));
      const frames = [];
      const levelEl = wrap.querySelector('#tc-level');
      let lvlPeak = 0.02;
      off = onPitch(f => {
        frames.push({ t: f.t - start, rms: f.rms || 0, voiced: f.midi !== null });
        lvlPeak = Math.max(lvlPeak * 0.995, f.rms || 0);
        levelEl.style.width = Math.min(100, 100 * (f.rms || 0) / lvlPeak) + '%';
      });
      const end = start + onsets[onsets.length - 1] + 1.6;
      const beatEl = wrap.querySelector('#tc-beat');
      await new Promise(done => {
        const tick = () => {
          const t = ctx.currentTime;
          if (t >= end) return done();
          if (t < t0) beatEl.textContent = '·';
          else if (t < start) beatEl.textContent = String(Math.floor((t - t0) / CHECK_BEAT) + 1);
          else beatEl.textContent = '♪';   // no per-beat flashing: it would run ahead of Bluetooth audio
          requestAnimationFrame(tick);
        };
        tick();
      });
      off(); off = null; out.disconnect();
      const est = estimateDelay(frames, onsets);
      try { localStorage.setItem('vl-timing-last', JSON.stringify({ at: Date.now(), d: est.d, matched: est.matched, inGaps: est.inGaps, heard: est.heard, peak: est.peak, floor: est.floor, frames: frames.length })); } catch { /* ignore */ }
      if (est.d === null || est.matched < 5 || est.inGaps > 2) {
        const why = !frames.length ? 'The microphone sent nothing at all. Check the browser has mic permission, then try again.'
          : est.peak < est.floor * 2.5 || est.peak < 0.004 ? `The mic barely picked you up (level ${(est.peak * 1000).toFixed(1)}, background ${(est.floor * 1000).toFixed(1)}). With AirPods the AirPods' own mic is used: sing a little louder, and check Echo cancellation is off in Settings (it can mute short sounds).`
          : est.inGaps > 2 ? `Heard sound in ${est.inGaps} of the gaps as well as on the beeps, so the timing could fit more than one way. Sing only on the beeps and keep the gaps silent (and if the room is noisy, try somewhere quieter).`
          : `Heard ${est.heard} “da”${est.heard === 1 ? '' : 's'}, but only ${est.matched} of ${onsets.length} lined up with the beeps (needs 5). Sing one short “da” per beep and stay quiet in the gaps.`;
        intro(`<p class="err">Couldn’t measure that one. ${esc(why)}</p>`);
        return;
      }
      const totalMs = Math.round(est.d * 1000);
      const extra = Math.round(totalMs - autoLatency() * 1000);
      setDeviceLatencyMs(extra);
      markTimingChecked();
      wrap.innerHTML = `<div class="card"><h2 style="margin-top:0">Delay: ${totalMs} ms</h2>
        <p class="dim">${totalMs > 120 ? 'That\'s typical for Bluetooth headphones.' : 'Nice and low.'} Saved for this device; your notes will now line up.</p>
        <div class="row"><button class="primary" data-a="ok">Continue</button><button data-a="again">Run it again</button></div></div>`;
      wrap.querySelector('[data-a=ok]').onclick = () => close(true);
      wrap.querySelector('[data-a=again]').onclick = run;
    }
    intro();
  });
}

// ---------------------------------------------------------------- views
let cleanup = null;
const routes = [];
function route(re, fn, nav) { routes.push({ re, fn, nav }); }

async function render() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const hash = location.hash.slice(1) || '/';
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) {
      document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === r.nav));
      view.innerHTML = '';
      try { await r.fn(...m.slice(1)); } catch (e) { view.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', render);

// ---- song library
route(/^\/$/, async () => {
  view.innerHTML = `
    <h1>Songs</h1>
    <div class="card">
      <form id="yt" class="row">
        <input class="grow" type="url" name="url" placeholder="Paste a YouTube link" required>
        <button class="primary">Add song</button>
      </form>
      <div class="row small dim" style="margin-top:10px">
        <span>or</span>
        <label class="btn"><input type="file" id="upl" accept="audio/*,video/*" hidden>Upload an audio file</label>
        <span>Vocals get split from the music and the melody is worked out for you. A 4-minute song takes a few minutes.</span>
      </div>
    </div>
    <div id="outdated"></div>
    <div id="list" class="songs"></div>`;
  const list = $('#list');
  let timer = null;
  const s = await settings();
  const cs = typeof course === 'function' ? await course().catch(() => ({})) : {};
  async function refresh() {
    const songs = await api('/api/songs');
    list.innerHTML = songs.length ? songs.map(song => `
      <div class="card song" data-id="${song.id}">
        <div class="grow">
          <div class="title" title="${esc(song.title)}">${esc(song.title)}${cs.courseSong === song.id && !cs.songsPassed?.[song.id] ? ' <span class="pill processing">learning</span>' : ''}</div>
          <div class="small dim">${song.duration ? fmtTime(song.duration) + ' · ' : ''}${song.note_low != null ? `${noteName(song.note_low)}–${noteName(song.note_high)}` + fitHint(song, s) : esc(song.stage || '')}</div>
          ${song.error ? `<div class="err">${esc(song.error)}</div>` : ''}
        </div>
        <div class="actions">
        <span class="pill ${song.status}">${song.status === 'processing' ? 'working' : song.status}</span>
        ${song.status === 'ready' ? `<a class="btn primary" href="#/song/${song.id}">Sing</a>` : ''}
        ${song.status === 'error' ? `<button data-retry>Retry</button>` : ''}
        ${song.outdated && song.status === 'ready' ? `<button data-reanalyse title="Re-analyse with the newer melody finder" aria-label="Re-analyse">↻</button>` : ''}
        <button data-rename title="Rename" aria-label="Rename">✎</button>
        <button data-del class="danger" title="Delete">✕</button>
        </div>
      </div>`).join('') : `<p class="dim">No songs yet. Paste a YouTube link above.</p>`;
    const old = songs.filter(x => x.outdated && x.status === 'ready');
    $('#outdated').innerHTML = old.length ? `
      <div class="card row">
        <span class="grow small">${old.length === 1 ? '1 song was' : `${old.length} songs were`} worked out with the older melody finder. The new one separates the lead singer from backing vocals and gets the tune right more often. Lyrics, scores and a key you set yourself are kept.</span>
        <button data-reall>Re-analyse ${old.length === 1 ? 'it' : 'all'}</button>
      </div>` : '';
    const noBack = songs.filter(x => x.no_backing && x.status === 'ready');
    if (!old.length && noBack.length) $('#outdated').innerHTML = `
      <div class="card row">
        <span class="grow small">${noBack.length === 1 ? '1 song has' : `${noBack.length} songs have`} the backing vocals mixed into the music. Re-analyse to give them their own volume slider (a few minutes per song; lyrics, scores and your key are kept).</span>
        <button data-split>Split ${noBack.length === 1 ? 'it' : 'them'}</button>
      </div>`;
    const btn = $('#outdated [data-reall]') || $('#outdated [data-split]');
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      try { await api(btn.dataset.split !== undefined ? '/api/songs/split-backing' : '/api/songs/reanalyse-outdated', { method: 'POST' }); } catch (err) { toast(err.message); }
      refresh();
    };
    const busy = songs.some(x => x.status === 'queued' || x.status === 'processing');
    clearTimeout(timer); if (busy) timer = setTimeout(refresh, 3000);
  }
  list.onclick = async e => {
    const card = e.target.closest('.song'); if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('[data-rename]')) {
      const cur = card.querySelector('.title').textContent;
      const name = prompt('Song name', cur);
      if (name && name.trim() && name.trim() !== cur) {
        try { await api(`/api/songs/${id}`, { method: 'PATCH', json: { title: name.trim() } }); } catch (err) { toast(err.message); }
        refresh();
      }
    } else if (e.target.closest('[data-del]')) {
      if (!confirm('Delete this song and its audio?')) return;
      try { await api(`/api/songs/${id}`, { method: 'DELETE' }); } catch (err) { toast(err.message); }
      refresh();
    } else if (e.target.closest('[data-reanalyse]')) {
      try { await api(`/api/songs/${id}/reanalyse`, { method: 'POST' }); } catch (err) { toast(err.message); }
      refresh();
    } else if (e.target.closest('[data-retry]')) {
      try { await api(`/api/songs/${id}/retry`, { method: 'POST' }); } catch (err) { toast(err.message); }
      refresh();
    }
  };
  $('#yt').onsubmit = async e => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    try { await api('/api/songs/youtube', { method: 'POST', json: { url } }); e.target.reset(); refresh(); } catch (err) { toast(err.message); }
  };
  $('#upl').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f); fd.append('title', f.name.replace(/\.[^.]+$/, ''));
    toast('Uploading…');
    try { await api('/api/songs/upload', { method: 'POST', body: fd }); refresh(); } catch (err) { toast(err.message); }
    e.target.value = '';
  };
  await refresh();
  cleanup = () => clearTimeout(timer);
}, 'songs');

function fitHint(song, s) {
  if (song.note_low == null) return '';
  const k = song.best_shift ?? 0, pct = Math.round(100 * (song.fit ?? 0));
  if (song.fit == null) return '';
  if (k === 0 && pct >= 95) return ' · fits your range';
  return ` · ${k ? `you’ll sing it ${octaveLabel(k)}` : 'original octave'} · ${pct}% in your range`;
}

// Which octave puts the most of the melody inside your range? Ties go to the original, then down.
const OCTAVE_CHOICES = [0, -12, 12, -24, 24];
const octaveLabel = k => k === 0 ? 'original octave' : `${Math.abs(k) / 12 === 1 ? 'an octave' : 'two octaves'} ${k < 0 ? 'down' : 'up'}`;
function bestOctave(notes, s) {
  let best = { k: 0, cost: Infinity };
  for (const k of OCTAVE_CHOICES) {
    let cost = 0;
    for (const n of notes) {
      const m = n.midi + k;
      cost += (m < s.rangeLow ? s.rangeLow - m : m > s.rangeHigh ? m - s.rangeHigh : 0) * (n.t1 - n.t0);
    }
    if (cost < best.cost - 1e-9) best = { k, cost };
  }
  return best.k;
}
const OCT_KEY = id => `vl-octave-${id}`;
function savedOctave(id) { try { return localStorage.getItem(OCT_KEY(id)) || 'auto'; } catch { return 'auto'; } }
function saveOctave(id, v) { try { localStorage.setItem(OCT_KEY(id), v); } catch { /* ignore */ } }

// ---- lyrics panel: follows the song, current line highlighted, tap a line to jump there
function modal(html) {
  const wrap = document.createElement('div'); wrap.className = 'modal';
  wrap.innerHTML = `<div class="card">${html}</div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  return wrap;
}

function setupLyrics(id, P, song) {
  const body = $('#lyrBody');
  let L = null, groq = false, guess = { artist: '', track: '' };
  let cur = -1, userScrollUntil = 0, raf = 0, saveTimer = 0;
  const describe = () => {
    if (!L) return 'No lyrics yet';
    const who = L.match?.artist ? `${L.match.artist} – ${L.match.track}` : '';
    const src = L.source === 'groq' ? 'Transcribed by Whisper, may have mistakes'
      : L.source === 'lrclib' ? `From LRCLIB${who ? ': ' + who : ''}` : 'Your lyrics';
    return src + (L.edited ? ' · edited' : '') + (L.synced ? '' : ' · not timed, scroll by hand');
  };
  function render() {
    $('#lyrSrc').textContent = describe();
    $('#lyrTime').hidden = !(L && L.synced);
    $('#lyrOff').textContent = L && L.synced ? `${L.offset > 0 ? '+' : ''}${(L.offset || 0).toFixed(1)}s` : '';
    if (!L || !L.lines.length) {
      body.innerHTML = `<p class="dim">No lyrics for this song yet. <button id="lyrFind2">Find lyrics</button></p>`;
      $('#lyrFind2').onclick = findDialog; return;
    }
    body.innerHTML = L.lines.map((l, i) => `<p data-i="${i}">${l.words?.length
      ? l.words.map((w, j) => `<span data-j="${j}">${esc(w.w)}</span>`).join(' ') : esc(l.text) || '&nbsp;'}</p>`).join('');
    cur = -1;
  }
  async function load() {
    try {
      const r = await api(`/api/songs/${id}/lyrics`);
      L = r.lyrics; groq = r.groq; guess = r.guess;
    } catch { L = null; }
    render();
  }
  function tick() {
    raf = requestAnimationFrame(tick);
    if (!L || !L.synced || !L.lines.length || !document.body.contains(body)) return;
    const t = P.now() - (L.offset || 0);
    let i = -1;
    for (let k = 0; k < L.lines.length; k++) { if (L.lines[k].t0 <= t + 0.15) i = k; else break; }
    if (i !== cur) {
      body.querySelector('p.on')?.classList.remove('on');
      const el = i >= 0 ? body.querySelector(`p[data-i="${i}"]`) : null;
      el?.classList.add('on');
      if (el && Date.now() > userScrollUntil) body.scrollTo({ top: el.offsetTop - body.clientHeight * 0.3, behavior: 'smooth' });
      cur = i;
    }
    const line = L.lines[i];
    if (line?.words) {
      body.querySelectorAll(`p[data-i="${i}"] span`).forEach((sp, j) => sp.classList.toggle('sung', line.words[j].t0 <= t + 0.05));
    }
  }
  body.addEventListener('wheel', () => { userScrollUntil = Date.now() + 4000; }, { passive: true });
  body.addEventListener('touchmove', () => { userScrollUntil = Date.now() + 4000; }, { passive: true });
  body.addEventListener('click', e => {
    const p = e.target.closest('p[data-i]');
    if (!p || !L?.synced || P.playing) return;
    P.pos = Math.max(0, L.lines[+p.dataset.i].t0 + (L.offset || 0) - 1);   // jump a second before the line
    userScrollUntil = 0; cur = -2;
  });
  const nudge = d => {
    if (!L) return;
    L.offset = Math.round(((L.offset || 0) + d) * 10) / 10; render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api(`/api/songs/${id}/lyrics`, { method: 'PUT', json: { offset: L.offset } }).catch(e => toast(e.message)), 600);
  };
  $('#lyrEarly').onclick = () => nudge(-0.2);
  $('#lyrLate').onclick = () => nudge(0.2);
  $('#lyrEdit').onclick = () => {
    const m = modal(`<h2 style="margin-top:0">Edit lyrics</h2>
      <textarea id="lyrText" rows="14" style="width:100%">${esc((L?.lines || []).map(l => l.text).join('\n'))}</textarea>
      <p class="small dim">One line per line. ${L?.synced ? 'Keep the same number of lines to keep the timing exact; adding or removing lines spreads the timing out evenly.' : ''}</p>
      <div class="row"><button class="primary" id="lyrSave">Save</button><button id="lyrCancel">Cancel</button>
      ${L ? '<button class="danger" id="lyrDel">Remove lyrics</button>' : ''}</div>`);
    m.querySelector('#lyrCancel').onclick = () => m.remove();
    m.querySelector('#lyrSave').onclick = async () => {
      try { L = (await api(`/api/songs/${id}/lyrics`, { method: 'PUT', json: { text: m.querySelector('#lyrText').value } })).lyrics; render(); m.remove(); }
      catch (e) { toast(e.message); }
    };
    m.querySelector('#lyrDel')?.addEventListener('click', async () => {
      if (!confirm('Remove the lyrics for this song?')) return;
      await api(`/api/songs/${id}/lyrics`, { method: 'DELETE' }); L = null; render(); m.remove();
    });
  };
  function findDialog() {
    const a = L?.match?.artist || guess.artist || '', t = L?.match?.track || guess.track || '';
    const m = modal(`<h2 style="margin-top:0">Find lyrics</h2>
      <div style="display:grid;gap:8px">
        <label class="dim small">Artist <input type="text" id="fArtist" value="${esc(a)}" style="width:100%"></label>
        <label class="dim small">Song <input type="text" id="fTrack" value="${esc(t)}" style="width:100%"></label>
        <label class="dim small">Where from <select id="fSrc" style="width:100%">
          <option value="auto">Look up, then transcribe if not found</option>
          <option value="lrclib">Look up only (LRCLIB)</option>
          <option value="groq" ${groq ? '' : 'disabled'}>Transcribe the vocal (Groq Whisper)${groq ? '' : ': needs GROQ_API_KEY'}</option>
        </select></label>
      </div>
      <p class="small dim" id="fMsg">${L?.edited ? 'This replaces your edited lyrics.' : ''}</p>
      <div class="row"><button class="primary" id="fGo">Find</button><button id="fCancel">Cancel</button></div>`);
    m.querySelector('#fCancel').onclick = () => m.remove();
    m.querySelector('#fGo').onclick = async () => {
      const btn = m.querySelector('#fGo'); btn.disabled = true;
      m.querySelector('#fMsg').textContent = m.querySelector('#fSrc').value === 'lrclib' ? 'Searching…' : 'Searching (transcribing can take up to a minute)…';
      try {
        L = (await api(`/api/songs/${id}/lyrics`, { method: 'POST', json: {
          source: m.querySelector('#fSrc').value, artist: m.querySelector('#fArtist').value.trim(), track: m.querySelector('#fTrack').value.trim() } })).lyrics;
        render(); m.remove();
      } catch (e) { m.querySelector('#fMsg').textContent = e.message; btn.disabled = false; }
    };
  }
  $('#lyrFind').onclick = findDialog;
  load(); tick();
  const prev = cleanup;
  cleanup = () => { cancelAnimationFrame(raf); prev?.(); };
}

// Keys and harmony. Harmony moves each melody note a number of steps along the song's
// scale (a third = 2 steps), so it stays in key; notes outside the scale keep their offset.
const KEY_NAMES = { major: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'],
                    minor: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'] };
const keyName = k => k ? `${KEY_NAMES[k.mode][((k.tonic % 12) + 12) % 12]} ${k.mode}` : '…';
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const PARTS = {
  melody: { label: 'Melody', steps: 0 },
  up3:    { label: 'Harmony: a third above', steps: 2 },
  down3:  { label: 'Harmony: a third below', steps: -2 },
  down5:  { label: 'Harmony: a fifth below', steps: -4 },
  down6:  { label: 'Harmony: a sixth below', steps: -5 },
};
function harmonise(notes, key, steps) {
  if (!steps) return notes;
  const sc = SCALES[key.mode];
  return notes.map(n => {
    const rel = n.midi - key.tonic;
    const oct = Math.floor(rel / 12), pc = rel - oct * 12;
    let deg = 6; while (sc[deg] > pc) deg--;          // scale step at or below this note
    const off = pc - sc[deg];                         // 1 if the note is outside the scale
    const a = oct * 7 + deg + steps;
    const o2 = Math.floor(a / 7), d2 = a - o2 * 7;
    return { ...n, midi: key.tonic + o2 * 12 + sc[d2] + off };
  });
}
const PREF_KEY = (id, what) => `vl-${what}-${id}`;
const SPEEDS = [100, 90, 80, 75, 70, 60, 50];   // must match pipeline.SPEEDS
function songPref(id, what, dflt) { try { return localStorage.getItem(PREF_KEY(id, what)) ?? dflt; } catch { return dflt; } }
function setSongPref(id, what, v) { try { localStorage.setItem(PREF_KEY(id, what), v); } catch { /* ignore */ } }

// ---- sing a song
route(/^\/song\/([0-9a-f]{12})(?:\?lesson=(\d\.\d))?$/, async (id, lessonId) => {
  const [song, an, s] = await Promise.all([api(`/api/songs/${id}`), api(`/api/songs/${id}/analysis`), settings()]);
  const firstIn = Math.max(0, Math.floor((an.notes[0]?.t0 ?? 0) - 3));   // skip a long intro
  // What you sing = melody or a harmony line, moved by the music's key shift, then by whole octaves.
  let key = an.key || null;
  let part = songPref(id, 'part', 'melody'); if (!PARTS[part]) part = 'melody';
  let tr = Number(songPref(id, 'tr', '0')) || 0;
  let speed = Number(songPref(id, 'speed', '100')); if (!SPEEDS.includes(speed)) speed = 100;
  let autoShift = 0;
  const trLabel = n => n === 0 ? 'Original key' : `${n > 0 ? '+' : '−'}${Math.abs(n)} semitone${Math.abs(n) > 1 ? 's' : ''}${key ? ` (${keyName({ ...key, tonic: key.tonic + n })})` : ''}`;
  view.innerHTML = `
    <div class="row"><h1 class="grow"><span id="songTitle">${esc(song.title)}</span> <button id="rename" title="Rename" aria-label="Rename" style="font-size:14px;padding:4px 8px;vertical-align:middle">✎</button></h1><span class="dim small" id="loadmsg">Loading audio…</span></div>
    <div class="stage" id="stage" style="height:min(46vh,420px)"></div>
    <div class="card lyrics" id="lyr" ${songPref('all', 'lyrics', '1') === '1' ? '' : 'hidden'}>
      <div class="row lyr-head">
        <span class="dim small grow" id="lyrSrc">Lyrics…</span>
        <span class="lyr-tools" id="lyrTime" hidden>
          <button id="lyrEarly" title="Show lyrics earlier" aria-label="Show lyrics earlier">−</button>
          <span class="dim small" id="lyrOff"></span>
          <button id="lyrLate" title="Show lyrics later" aria-label="Show lyrics later">+</button>
        </span>
        <button id="lyrEdit" title="Edit lyrics" aria-label="Edit lyrics">✎</button>
        <button id="lyrFind" title="Find lyrics again" aria-label="Find lyrics again">↻</button>
      </div>
      <div class="lyr-body" id="lyrBody"></div>
    </div>
    <div class="controls">
      <button class="primary" id="play" disabled>▶ Sing</button>
      <button id="restart" title="Back to section start">⏮</button>
      <label><input type="checkbox" id="loop"> Loop</label>
      <label>From <input type="text" id="from" size="4" value="${fmtTime(firstIn)}"></label>
      <label>To <input type="text" id="to" size="4" value="${fmtTime(an.duration)}"></label>
      <button id="setA" title="Set section start to the playhead">[ here</button>
      <button id="setB" title="Set section end to the playhead">here ]</button>
    </div>
    <div class="card opts">
      <label>Part <select id="part">${Object.entries(PARTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
      <label>Sing it <select id="oct"></select></label>
      <label>Music key <select id="tr"></select></label>
      <label>Song key <select id="key"></select></label>
      <label>Speed <select id="speed">${SPEEDS.map(v => `<option value="${v}">${v === 100 ? 'Normal speed' : `${v}% (slower, same pitch)`}</option>`).join('')}</select></label>
      <p class="dim small span" id="octInfo"></p>
    </div>
    <div class="controls">
      <label>Music <input type="range" id="vAcc" min="0" max="1.2" step="0.05" value="${songPref('all', 'vAcc', '0.9')}"></label>
      ${an.backing ? `<label>Backing vocals <input type="range" id="vBack" min="0" max="1.2" step="0.05" value="${songPref('all', 'vBack', '0.9')}"></label>` : ''}
      <label>Guide vocal <input type="range" id="vVoc" min="0" max="1.2" step="0.05" value="0.3"></label>
      <label><input type="checkbox" id="octFree" ${s.octaveFree ? 'checked' : ''}> Any octave counts</label>
      <label><input type="checkbox" id="contour" checked> Show melody line</label>
      <label><input type="checkbox" id="showLyr" ${songPref('all', 'lyrics', '1') === '1' ? 'checked' : ''}> Show lyrics</label>
    </div>
    <div class="legend small"><span><i style="background:var(--green)"></i>within ${s.greenCents}¢</span><span><i style="background:var(--amber)"></i>within ${s.amberCents}¢</span><span><i style="background:var(--red)"></i>off</span><span>Drag the track to move around when stopped. Headphones work best.</span></div>
    ${an.backing || !an.lead_split ? '' : `<p class="dim small" id="backHint">Want the backing vocals on their own slider? <button id="splitBack">Re-analyse this song</button> (takes a few minutes; lyrics, key and scores are kept).</p>`}
    ${Math.abs(an.tuning || 0) >= 10 ? `<p class="dim small">Recording is tuned ${an.tuning > 0 ? '+' : ''}${an.tuning}¢ from A440; targets follow it.</p>` : ''}
    <div id="res"></div>`;
  const stage = $('#stage');
  const parseT = v => { const p = String(v).split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0] || 0; };
  const sec = () => ({ from: clamp(parseT($('#from').value), 0, an.duration), to: clamp(parseT($('#to').value), 0, an.duration) });
  const vols = { accomp: +$('#vAcc').value, backing: +($('#vBack')?.value ?? 0.9), vocals: +$('#vVoc').value };
  const P = new Practice(stage, { ...an, duration: an.duration }, { buffers: {} }, {
    settings: s, volumes: vols, sectionRef: sec, showContour: () => $('#contour').checked, start: firstIn,
  });
  cleanup = () => { P.destroy(); stopMic(); };

  // ---- the part you sing
  const octChoice = () => { const v = $('#oct').value; return v === 'auto' ? autoShift : Number(v); };
  function fillKeySelects() {
    $('#tr').innerHTML = Array.from({ length: 15 }, (_, i) => 7 - i).map(n => `<option value="${n}">${trLabel(n)}</option>`).join('');
    $('#tr').value = String(tr);
    $('#key').innerHTML = !key ? '<option>Finding the key…</option>' :
      ['major', 'minor'].flatMap(mode => KEY_NAMES[mode].map((_, t) => ({ tonic: t, mode })))
        .map(k => `<option value="${k.tonic}:${k.mode}">${keyName(k)}${key.detected && k.tonic === key.tonic && k.mode === key.mode ? ' (detected)' : ''}</option>`).join('')
        + (key.detected ? '' : '<option value="detect">Detect it again</option>');
    if (key) $('#key').value = `${key.tonic}:${key.mode}`;
    $('#key').disabled = !key;
    $('#part').disabled = !key;
    $('#part').value = key ? part : 'melody';
  }
  function applyPart() {
    const base = part === 'melody' || !key ? an.notes : harmonise(an.notes, key, PARTS[part].steps);
    const moved = base.map(n => ({ ...n, midi: n.midi + tr }));
    autoShift = bestOctave(moved, s);
    const keep = savedOctave(id);
    $('#oct').innerHTML = `<option value="auto">Best fit for my range (${octaveLabel(autoShift)})</option>` +
      OCTAVE_CHOICES.slice().sort((a, b) => b - a).map(k => `<option value="${k}">${k === 0 ? 'Original octave' : octaveLabel(k)[0].toUpperCase() + octaveLabel(k).slice(1)}</option>`).join('');
    $('#oct').value = [...$('#oct').options].some(o => o.value === keep) ? keep : 'auto';
    const k = octChoice();
    P.setPart(base, tr + k, tr + k);
    const ms = P.notes.map(n => n.midi).sort((x, y) => x - y);
    const total = P.notes.reduce((a, n) => a + n.t1 - n.t0, 0) || 1;
    const inside = P.notes.reduce((a, n) => a + (n.midi >= s.rangeLow && n.midi <= s.rangeHigh ? n.t1 - n.t0 : 0), 0);
    $('#octInfo').textContent = !ms.length ? '' :
      `Your part ${noteName(ms[Math.floor(ms.length * 0.03)])}–${noteName(ms[Math.ceil(ms.length * 0.97) - 1])} · your range ${noteName(s.rangeLow)}–${noteName(s.rangeHigh)} · ${Math.round(100 * inside / total)}% inside it`;
    $('#res').innerHTML = '';
  }
  const busy = () => { if (P.playing) { toast('Stop first, then change this'); return true; } return false; };
  $('#part').onchange = () => { if (busy()) { $('#part').value = part; return; } part = $('#part').value; setSongPref(id, 'part', part); applyPart(); };
  $('#oct').onchange = () => { if (busy()) { $('#oct').value = savedOctave(id); return; } saveOctave(id, $('#oct').value); applyPart(); };
  $('#key').onchange = async () => {
    if (busy()) { fillKeySelects(); return; }
    const v = $('#key').value;
    try {
      key = await api(`/api/songs/${id}/key`, { method: 'PUT', json: v === 'detect' ? { reset: true } : { tonic: +v.split(':')[0], mode: v.split(':')[1] } });
    } catch (e) { toast(e.message); }
    fillKeySelects(); applyPart();
  };

  // ---- audio, in whichever key is chosen (shifted copies are made on the server once, then cached)
  let audioReq = 0;
  async function loadAudio() {
    const mine = ++audioReq;
    $('#play').disabled = true;
    $('#loadmsg').textContent = speed !== 100 ? 'Slowing the music down (first time takes up to half a minute)…'
      : tr ? 'Shifting the music to the new key (first time takes a few seconds)…' : 'Loading audio…';
    try {
      const m = `/media/songs/${id}/`;
      let urls = an.backing ? { band: m + 'band.mp3', backing: m + 'backing.mp3', vocals: m + 'vocals.mp3' }
        : { accompaniment: m + 'accompaniment.mp3', vocals: m + 'vocals.mp3' };
      if (tr || speed !== 100) urls = await api(`/api/songs/${id}/audio`, { method: 'POST', json: { semitones: tr, speed } });
      const [accomp, backing, vocals] = await Promise.all([loadBuffer(urls.band || urls.accompaniment),
        urls.band && urls.backing ? loadBuffer(urls.backing) : null, loadBuffer(urls.vocals)]);
      if (mine !== audioReq) return;
      P.audio.buffers = { accomp, backing, vocals };
      P.audio.rate = speed / 100;
      $('#loadmsg').textContent = ''; $('#play').disabled = false;
    } catch (e) { if (mine === audioReq) $('#loadmsg').textContent = 'Audio failed to load: ' + e.message; }
  }
  $('#tr').onchange = () => {
    if (busy()) { $('#tr').value = String(tr); return; }
    tr = Number($('#tr').value); setSongPref(id, 'tr', String(tr)); applyPart(); loadAudio();
  };
  $('#speed').value = String(speed);
  $('#speed').onchange = () => {
    if (busy()) { $('#speed').value = String(speed); return; }
    speed = Number($('#speed').value); setSongPref(id, 'speed', String(speed)); loadAudio();
  };
  $('#splitBack') && ($('#splitBack').onclick = async () => {
    if (!confirm('Re-analyse this song to split out the backing vocals? It takes a few minutes and the song can’t be sung until it’s done.')) return;
    try { await api(`/api/songs/${id}/reanalyse`, { method: 'POST' }); location.hash = '#/'; } catch (e) { toast(e.message); }
  });

  fillKeySelects(); applyPart(); loadAudio();
  if (!key) {
    api(`/api/songs/${id}/key`).then(k => { key = k; fillKeySelects(); applyPart(); })
      .catch(() => { $('#key').innerHTML = '<option>Key unknown</option>'; });
  }

  $('#rename').onclick = async () => {
    const name = prompt('Song name', song.title);
    if (!name || !name.trim() || name.trim() === song.title) return;
    try {
      const upd = await api(`/api/songs/${id}`, { method: 'PATCH', json: { title: name.trim() } });
      song.title = upd.title; $('#songTitle').textContent = upd.title;
    } catch (err) { toast(err.message); }
  };
  setupLyrics(id, P, song);
  const lessonCtl = lessonId && typeof setupSongLesson === 'function' ? (await course(), setupSongLesson(lessonId, {
    id, song, an, P, sec, view,
    setGuide: v => { $('#vVoc').value = v; vols.vocals = v; P.setVolume('vocals', v); },
    setLyrics: on => { $('#showLyr').checked = on; $('#lyr').hidden = !on; },
    setPart: k => { if ($('#part').disabled) { part = k; setSongPref(id, 'part', k); return; } $('#part').value = k; $('#part').dispatchEvent(new Event('change')); },
    part: () => part,
    recording: () => !!s.recordTakes,
  })) : null;
  $('#showLyr').onchange = e => { setSongPref('all', 'lyrics', e.target.checked ? '1' : '0'); $('#lyr').hidden = !e.target.checked; };
  $('#vAcc').oninput = e => { vols.accomp = +e.target.value; P.setVolume('accomp', vols.accomp); setSongPref('all', 'vAcc', e.target.value); };
  $('#vBack') && ($('#vBack').oninput = e => { vols.backing = +e.target.value; P.setVolume('backing', vols.backing); setSongPref('all', 'vBack', e.target.value); });
  $('#vVoc').oninput = e => { vols.vocals = +e.target.value; P.setVolume('vocals', vols.vocals); };
  $('#octFree').onchange = e => { s.octaveFree = e.target.checked; saveSettings({ octaveFree: s.octaveFree }); };
  $('#setA').onclick = () => { $('#from').value = fmtTime(P.now()); };
  $('#setB').onclick = () => { $('#to').value = fmtTime(P.now()); };
  $('#restart').onclick = () => { if (!P.playing) P.pos = sec().from; };
  const playBtn = $('#play');
  async function go() {
    const { from, to } = sec();
    if (to - from < 2) return toast('Section is too short');
    if (needsTimingCheck() && !(await timingCheck())) return;
    const start = P.pos >= from && P.pos < to - 1 ? P.pos : from;
    playBtn.textContent = '■ Stop'; $('#res').innerHTML = '';
    try { await P.play({ from: start, to }); } catch (e) { playBtn.textContent = '▶ Sing'; return toast(e.message, 6000); }
  }
  const origStop = P.stop.bind(P);
  P.stop = async (finished) => {
    const res = await origStop(finished);
    if (!res || !document.body.contains(stage)) return res;   // left the page mid-song
    playBtn.textContent = '▶ Sing';
    $('#res').innerHTML = resultsHTML(res, s); bindLatencyButton($('#res'));
    let runP = Promise.resolve(null);
    if (res.score !== null && res.notes.length >= 4) {
      const k = P.shift - tr;
      const bits = [part !== 'melody' ? PARTS[part].label.replace('Harmony: ', '') : null,
        tr ? `${tr > 0 ? '+' : '−'}${Math.abs(tr)} st` : null, k ? octaveLabel(k) : null,
        res.speed && res.speed !== 100 ? `${res.speed}% speed` : null].filter(Boolean);
      runP = saveRun('song', id, song.title + (bits.length ? ` (${bits.join(', ')})` : ''), res,
        { shift: P.shift, part, transpose: tr, octave: k, key, speed: res.speed, lesson: lessonId || undefined })
        .catch(e => { toast('Couldn’t save run: ' + e.message); return null; });
    }
    lessonCtl?.onResult({ ...res, finished }, runP);
    if (finished && $('#loop').checked) { P.pos = sec().from; setTimeout(go, 1200); }
    else if (finished) P.pos = sec().from;
    return res;
  };
  playBtn.onclick = () => (P.playing ? P.stop(false) : go());
}, 'songs');

// ---- warm-up drills
const DRILLS = {
  steps3:   { name: 'Three-note steps', pattern: [0, 2, 4, 2, 0], beat: 0.6 },
  scale5:   { name: 'Five-note scale', pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0], beat: 0.5 },
  arpeggio: { name: 'Major arpeggio', pattern: [0, 4, 7, 12, 7, 4, 0], beat: 0.55 },
  thirds:   { name: 'Thirds', pattern: [0, 4, 2, 5, 4, 7, 5, 2, 0], beat: 0.45 },
  octave:   { name: 'Octave leap', pattern: [0, 12, 0], beat: 0.9 },
  sustain:  { name: 'Long tone', pattern: [0], beat: 3 },
  minor:    { name: 'Minor scale', pattern: [0, 2, 3, 5, 7, 5, 3, 2, 0], beat: 0.5 },
  ninescale:{ name: 'Nine-note scale', pattern: [0, 2, 4, 5, 7, 9, 11, 12, 14, 12, 11, 9, 7, 5, 4, 2, 0], beat: 0.32 },
};
const SERIES = {
  quick: { name: 'Quick warm-up', drills: ['sustain', 'scale5', 'arpeggio'] },
  full:  { name: 'Full warm-up', drills: ['sustain', 'scale5', 'thirds', 'arpeggio', 'octave', 'ninescale'] },
};

function buildDrill(keys, s, tempo = 1, down = true, o = {}) {
  const notes = [], cues = [];
  let t = 0.6;
  for (const k of keys) {
    const d = DRILLS[k], span = Math.max(...d.pattern), beat = d.beat / tempo;
    const roots = [];
    const lowest = o.topHalf ? Math.max(s.rangeLow, Math.round((s.rangeLow + s.rangeHigh) / 2) - 2) : s.rangeLow;
    for (let r = lowest; r + span <= s.rangeHigh; r++) roots.push(r);
    if (!roots.length) roots.push(Math.max(s.rangeLow, s.rangeHigh - span));
    if (o.maxRoots && roots.length > o.maxRoots) {   // spread a few roots evenly through the range
      const pick = Array.from({ length: o.maxRoots }, (_, i) => roots[Math.round(i * (roots.length - 1) / (o.maxRoots - 1))]);
      roots.splice(0, roots.length, ...new Set(pick));
    }
    const seq = down ? [...roots, ...roots.slice(0, -1).reverse()] : roots;
    // keep long lists manageable
    const step = seq.length > 14 ? 2 : 1;
    for (let i = 0; i < seq.length; i += step) {
      const r = seq[i];
      cues.push({ t0: t, t1: t + 0.7, midi: r });
      t += 0.9;
      for (const iv of d.pattern) { notes.push({ t0: t, t1: t + beat * 0.92, midi: r + iv, label: o.label }); t += beat; }
      t += 0.5;
    }
    t += 1;
  }
  return { notes, cues, duration: t, range: [s.rangeLow, s.rangeHigh] };
}

route(/^\/drills$/, async () => {
  const s = await settings();
  view.innerHTML = `<h1>Warm-ups</h1>
    <p class="dim">Each drill climbs semitone by semitone through your range (${noteName(s.rangeLow)}–${noteName(s.rangeHigh)}) and back down. Set your range on the <a href="#/range">Range</a> page.</p>
    <h2>Series</h2><div class="grid2">${Object.entries(SERIES).map(([k, v]) => `<a class="card" href="#/drill/${k}"><b>${v.name}</b><div class="dim small">${v.drills.map(d => DRILLS[d].name).join(' → ')}</div></a>`).join('')}</div>
    <h2>Single drills</h2><div class="grid2">${Object.entries(DRILLS).map(([k, v]) => `<a class="card" href="#/drill/${k}"><b>${v.name}</b><div class="dim small">${v.pattern.map(i => '+' + i).join(' ')}</div></a>`).join('')}</div>`;
}, 'drills');

route(/^\/drill\/(\w+)$/, async key => {
  const s = await settings();
  const keys = SERIES[key]?.drills || (DRILLS[key] ? [key] : null);
  if (!keys) throw new Error('Unknown drill');
  const title = SERIES[key]?.name || DRILLS[key].name;
  view.innerHTML = `<div class="row"><h1 class="grow">${esc(title)}</h1></div>
    <div class="stage" id="stage" style="height:min(52vh,440px)"></div>
    <div class="controls">
      <button class="primary" id="play">▶ Start</button>
      <label>Tempo <select id="tempo"><option value="0.8">Slow</option><option value="1" selected>Normal</option><option value="1.25">Fast</option></select></label>
      <label><input type="checkbox" id="down" checked> Come back down</label>
      <label>Guide <input type="range" id="vG" min="0" max="1.2" step="0.05" value="0.6"></label>
    </div>
    <p class="small dim">You'll hear the starting note, then sing the pattern with the guide. Glides between notes aren't marked down.</p>
    <div id="res"></div>`;
  let P = null;
  const vols = { guide: 0.6 };
  function build() {
    P?.destroy(); $('#stage').innerHTML = '';
    const tg = buildDrill(keys, s, +$('#tempo').value, $('#down').checked);
    P = new Practice($('#stage'), tg, { synth: true }, { settings: s, volumes: vols, start: 0 });
    const orig = P.stop.bind(P);
    P.stop = async fin => {
      const res = await orig(fin);
      if (!res || !$('#play')) return res;   // left the page mid-drill
      $('#play').textContent = '▶ Start';
      $('#res').innerHTML = resultsHTML(res, s); bindLatencyButton($('#res'));
      if (res.score !== null && res.notes.length >= 4) saveRun('drill', key, title, res).catch(e => toast(e.message));
      P.pos = 0;
      return res;
    };
  }
  build();
  $('#tempo').onchange = build; $('#down').onchange = build;
  $('#vG').oninput = e => { vols.guide = +e.target.value; P.setVolume('guide', vols.guide); };
  $('#play').onclick = async () => {
    if (P.playing) return P.stop(false);
    if (needsTimingCheck() && !(await timingCheck())) return;
    $('#res').innerHTML = ''; $('#play').textContent = '■ Stop';
    try { await P.play({ from: 0, to: P.target.duration }); } catch (e) { $('#play').textContent = '▶ Start'; toast(e.message, 6000); }
  };
  cleanup = () => { P?.destroy(); stopMic(); };
}, 'drills');

// ---- range test + tuner
route(/^\/range$/, async () => {
  const s = await settings();
  view.innerHTML = `<h1>Range</h1>
    <div class="card">
      <div class="tuner" id="note">–</div>
      <div class="cents dim" id="cents">Press start and sing</div>
      <div class="meter"><i id="needle"></i></div>
      <div class="row" style="justify-content:center;margin-top:10px">
        <button class="primary" id="go">Start microphone</button>
      </div>
    </div>
    <div class="card">
      <p>Your saved range: <b id="saved">${noteName(s.rangeLow)} – ${noteName(s.rangeHigh)}</b></p>
      <p class="dim small">Range test: hold your lowest comfortable note for two seconds, then your highest. Comfortable, not strained. Drills stay inside it.</p>
      <div class="row"><button id="low" disabled>Capture lowest</button><button id="high" disabled>Capture highest</button>
      <span class="dim small" id="cap"></span></div>
      <div class="row" style="margin-top:10px"><span class="dim small">Or set it by hand:</span>
        <select id="selLo"></select><span>to</span><select id="selHi"></select><button id="saveSel">Save</button></div>
    </div>`;
  const opts = m => Array.from({ length: 49 }, (_, i) => 36 + i).map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${noteName(x)}</option>`).join('');
  $('#selLo').innerHTML = opts(s.rangeLow); $('#selHi').innerHTML = opts(s.rangeHigh);
  $('#saveSel').onclick = async () => {
    const lo = +$('#selLo').value, hi = +$('#selHi').value;
    if (hi - lo < 5) return toast('Range needs at least a fourth');
    await saveSettings({ rangeLow: lo, rangeHigh: hi }); markRangeSaved(); $('#saved').textContent = `${noteName(lo)} – ${noteName(hi)}`; toast('Saved');
  };
  let recent = [], capture = null;
  const off = [];
  $('#go').onclick = async () => {
    try { await startMic(); } catch (e) { return toast(e.message, 6000); }
    $('#go').hidden = true; $('#low').disabled = false; $('#high').disabled = false;
    off.push(onPitch(f => {
      if (f.midi === null) { recent = []; return; }
      const m = f.midi, near = Math.round(m), c = (m - near) * 100;
      $('#note').textContent = noteName(near);
      $('#cents').textContent = `${c > 0 ? '+' : ''}${Math.round(c)}¢ · ${f.hz.toFixed(1)} Hz`;
      $('#needle').style.left = `calc(${50 + c}% - 2px)`;
      $('#needle').style.background = Math.abs(c) <= s.greenCents ? css('--green') : Math.abs(c) <= s.amberCents ? css('--amber') : css('--red');
      if (capture) {
        recent.push(m); if (recent.length > 200) recent.shift();
        if (recent.length >= 150) {
          const w = recent.slice(-150), mean = w.reduce((a, b) => a + b) / w.length;
          const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length);
          if (sd < 0.6) { capture(Math.round(mean)); capture = null; recent = []; }
        }
      }
    }));
  };
  const cap = which => () => {
    $('#cap').textContent = `Hold your ${which} note steady…`; recent = [];
    capture = async m => {
      const patch = which === 'lowest' ? { rangeLow: m } : { rangeHigh: m };
      const cur = await settings();
      const lo = patch.rangeLow ?? cur.rangeLow, hi = patch.rangeHigh ?? cur.rangeHigh;
      if (hi - lo < 5) { $('#cap').textContent = `Got ${noteName(m)}, but that leaves less than a fourth of range. Try again.`; return; }
      await saveSettings(patch); markRangeSaved();
      $('#saved').textContent = `${noteName(SETTINGS.rangeLow)} – ${noteName(SETTINGS.rangeHigh)}`;
      $('#cap').textContent = `Saved ${which}: ${noteName(m)}`;
    };
  };
  $('#low').onclick = cap('lowest'); $('#high').onclick = cap('highest');
  cleanup = () => { off.forEach(f => f()); stopMic(); };
}, 'range');

// ---- ear training
const INTERVALS = ['Unison', 'm2', 'M2', 'm3', 'M3', 'P4', 'Tritone', 'P5', 'm6', 'M6', 'm7', 'M7', 'Octave'];
const EAR_LEVELS = {
  easy:   { ivs: [0, 2, 4, 5, 7, 12], hl: [3, 4] },
  medium: { ivs: [1, 2, 3, 4, 5, 7, 9, 12], hl: [1, 2] },
  hard:   { ivs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], hl: [0.5, 1] },
};

// Ten-question ear quiz, shown in `box`. Resolves with { score, answers }, or null if abandoned.
async function runEarQuiz(box, mode, levelName, s, { save = true } = {}) {
  const lv = EAR_LEVELS[levelName];
  const mid = Math.round((s.rangeLow + s.rangeHigh) / 2);
  const q = sel => box.querySelector(sel);
  let off = null;
  // Sing-back needs the mic; open it first so the same audio setup is used throughout (matters on iPhone).
  const ctx = mode === 'sb' ? await startMic() : await audioCtx();
  const answers = [];
  const out = ctx.createGain(); out.connect(ctx.destination);
  function ask(text, options, replay) {
    return new Promise(res => {
      box.innerHTML = `<div class="card"><p class="dim">${esc(text)}</p><div class="choices">${options.map(o => `<button data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        <p><button data-replay>↻ Play again</button></p></div>`;
      q('[data-replay]').onclick = replay;
      box.querySelectorAll('[data-o]').forEach(b => b.onclick = () => res(b.dataset.o));
    });
  }
  function reveal(pick, right) {
    box.querySelectorAll('[data-o]').forEach(b => {
      b.disabled = true;
      if (b.dataset.o === right) b.classList.add('right'); else if (b.dataset.o === pick) b.classList.add('wrong');
    });
  }
  for (let i = 0; i < 10; i++) {
    if (!document.body.contains(box)) { off?.(); return null; }
    const base = mid - 5 + Math.floor(Math.random() * 8);
    let item, correct;
    if (mode === 'hl') {
      const d = lv.hl[Math.floor(Math.random() * lv.hl.length)] * (Math.random() < 0.5 ? -1 : 1);
      const play = () => { const t = ctx.currentTime + 0.05; playTone(ctx, out, base, t, 0.7); playTone(ctx, out, base + d, t + 0.85, 0.7); };
      play();
      const pick = await ask(`Question ${i + 1}/10: is the second note higher or lower?`, ['Higher', 'Lower'], play);
      correct = (pick === 'Higher') === (d > 0); item = `hl ${Math.abs(d) < 1 ? Math.abs(d) * 100 + '¢' : Math.abs(d) + ' st'}`;
      reveal(pick, d > 0 ? 'Higher' : 'Lower');
    } else if (mode === 'iv') {
      const iv = lv.ivs[Math.floor(Math.random() * lv.ivs.length)];
      const play = () => { const t = ctx.currentTime + 0.05; playTone(ctx, out, base, t, 0.8); playTone(ctx, out, base + iv, t + 0.9, 0.8); };
      play();
      const pick = await ask(`Question ${i + 1}/10: what interval is that?`, lv.ivs.map(x => INTERVALS[x]), play);
      correct = pick === INTERVALS[iv]; item = INTERVALS[iv];
      reveal(pick, INTERVALS[iv]);
    } else {
      const target = s.rangeLow + 2 + Math.floor(Math.random() * Math.max(1, s.rangeHigh - s.rangeLow - 4));
      const play = () => playTone(ctx, out, target, ctx.currentTime + 0.05, 1.2);
      play();
      await ask(`Question ${i + 1}/10: listen, then press Sing and hold the note for about 2 seconds.`, ['Sing'], play);
      await startMic();
      q('.dim').textContent = 'Listening…';
      const got = await new Promise(res => {
        const buf = []; const t0 = performance.now();
        off = onPitch(f => {
          if (f.midi !== null) buf.push(f.midi);
          if (buf.length >= 120 || performance.now() - t0 > 5000) { off(); off = null; res(buf); }
        });
      });
      const sung = got.length > 30 ? got.slice(Math.floor(got.length / 4)).sort((a, b) => a - b)[Math.floor(got.length * 3 / 8)] : null;
      const c = sung === null ? null : centsOff(sung, target, true);
      correct = c !== null && Math.abs(c) <= s.amberCents; item = noteName(target);
      box.innerHTML = `<div class="card"><p>Target ${noteName(target)}. ${c === null ? 'Didn’t hear enough singing.' : `You were ${Math.abs(Math.round(c))}¢ ${c > 0 ? 'sharp' : 'flat'}.`} ${correct ? '✅' : '❌'}</p></div>`;
      await new Promise(r => setTimeout(r, 1600));
    }
    answers.push({ item, correct });
    if (mode !== 'sb') await new Promise(r => setTimeout(r, 900));
  }
  const score = 100 * answers.filter(a => a.correct).length / answers.length;
  if (save) {
    const title = { hl: 'Higher or lower', iv: 'Intervals', sb: 'Sing it back' }[mode];
    const fd = new FormData();
    fd.append('meta', JSON.stringify({ kind: 'ear', ref: mode, title, score, details: { answers, level: levelName } }));
    api('/api/runs', { method: 'POST', body: fd }).catch(e => toast(e.message));
  }
  const missed = answers.filter(a => !a.correct).map(a => a.item);
  box.innerHTML = `<div class="card"><b>${Math.round(score)}%</b> correct.${missed.length ? ` <span class="dim">Missed: ${esc([...new Set(missed)].join(', '))}</span>` : ''}</div>`;
  return { score, answers };
}

route(/^\/ear$/, async () => {
  const s = await settings();
  view.innerHTML = `<h1>Ear training</h1>
    <div class="controls">
      <label>Exercise <select id="mode"><option value="hl">Higher or lower</option><option value="iv">Name the interval</option><option value="sb">Sing it back</option></select></label>
      <label>Level <select id="lvl"><option>easy</option><option selected>medium</option><option>hard</option></select></label>
      <button class="primary" id="start">Start 10 questions</button>
    </div>
    <div id="q"></div>`;
  $('#start').onclick = async () => {
    try { await runEarQuiz($('#q'), $('#mode').value, $('#lvl').value, s); } catch (e) { toast(e.message, 6000); }
  };
  cleanup = () => { stopMic(); };
}, 'ear');

// ---- progress
route(/^\/history$/, async () => {
  const [runs, st] = await Promise.all([api('/api/runs?limit=300'), api('/api/stats')]);
  view.innerHTML = `<h1>Progress</h1>
    <div id="finale"></div>
    <div class="card"><canvas id="chart" style="width:100%;height:200px"></canvas></div>
    <h2>Accuracy by note</h2>
    <div class="card"><div class="heat" id="heat"></div><p class="small dim">Average note score across songs and drills. Darker cells haven't been sung enough to say.</p></div>
    ${Object.keys(st.ear).length ? `<h2>Ear training</h2><div class="card"><table><tr><th>Item</th><th>Tries</th><th>Correct</th></tr>${Object.entries(st.ear).sort((a, b) => a[1].avg - b[1].avg).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${Math.round(v.avg * 100)}%</td></tr>`).join('')}</table></div>` : ''}
    <h2>Recent runs</h2>
    <div class="card table-wrap"><table id="runs"><tr><th>When</th><th>What</th><th>Score</th><th></th></tr>
    ${runs.map(r => `<tr data-id="${r.id}"><td class="small">${fmtDate(r.created)}</td><td>${esc(r.title || r.ref)} <span class="dim small">${r.kind}</span></td><td>${r.score == null ? '–' : Math.round(r.score) + '%'}</td>
      <td class="row" style="justify-content:flex-end">${r.take ? `<button data-play="${esc(r.take)}">▶ Take</button>` : ''}<button data-del class="danger">✕</button></td></tr>`).join('')}
    </table>${runs.length ? '' : '<p class="dim">Nothing yet. Sing something.</p>'}</div>
    <h2>Start fresh</h2>
    <div class="card">
      <p class="small dim">Clear what testing has filled up. Your songs, lyrics, range, timing and settings are kept.</p>
      <label class="row small"><input type="checkbox" id="rsRuns" checked> Scores, history and recorded takes</label>
      <label class="row small" style="margin-top:6px"><input type="checkbox" id="rsCourse"> Lesson progress (back to lesson 1.1, home note and course song cleared)</label>
      <div class="row" style="margin-top:10px"><button class="danger" id="reset">Reset…</button></div>
    </div>
    <audio id="player" hidden></audio>`;
  $('#reset').onclick = async () => {
    const runs = $('#rsRuns').checked, lessons = $('#rsCourse').checked;
    if (!runs && !lessons) return toast('Tick what you want to reset');
    const what = [runs && 'all scores, history and recorded takes', lessons && 'all lesson progress'].filter(Boolean).join(' and ');
    if (!confirm(`Delete ${what}? This can’t be undone.`)) return;
    try {
      if (runs) {
        await api('/api/runs', { method: 'DELETE' });
        try { Object.keys(localStorage).filter(k => k.startsWith('vl-sung-')).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
      }
      if (lessons) {
        await api('/api/course', { method: 'PUT', json: {} });
        if (typeof C !== 'undefined') C = null;   // reload fresh progress next time
      }
      toast('Reset done');
      render();
    } catch (e) { toast('Reset failed: ' + e.message); }
  };
  // heatmap
  const keys = Object.keys(st.notes).map(Number);
  const lo = keys.length ? Math.floor(Math.min(...keys) / 12) * 12 : 48, hi = keys.length ? Math.ceil((Math.max(...keys) + 1) / 12) * 12 - 1 : 71;
  let cells = '';
  for (let m = lo; m <= hi; m++) {
    const v = st.notes[m];
    const bg = !v || v.n < 3 ? 'var(--panel2)' : `hsl(${Math.round(v.avg * 130)}, 55%, ${30 + v.avg * 12}%)`;
    cells += `<div style="background:${bg};color:${v && v.n >= 3 ? '#fff' : ''}" title="${v ? `${v.n} notes, ${Math.round(v.avg * 100)}%` : 'not sung'}">${noteName(m)}</div>`;
  }
  $('#heat').innerHTML = cells;
  // chart
  const cv = $('#chart'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = 200;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const pts = st.timeline.filter(p => p.kind !== 'ear');
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.fillStyle = 'rgba(200,205,220,0.6)'; g.font = '11px system-ui';
  for (const v of [0, 25, 50, 75, 100]) { const y = H - 16 - v / 100 * (H - 28); g.beginPath(); g.moveTo(30, y); g.lineTo(W, y); g.stroke(); g.fillText(v + '%', 0, y + 4); }
  if (pts.length) {
    const x = i => 34 + (pts.length === 1 ? (W - 40) / 2 : i / (pts.length - 1) * (W - 40));
    const y = v => H - 16 - v / 100 * (H - 28);
    g.fillStyle = 'rgba(122,162,255,0.45)';
    pts.forEach((p, i) => { g.beginPath(); g.arc(x(i), y(p.score), 2.5, 0, 7); g.fill(); });
    // rolling average of 5
    g.strokeStyle = css('--accent'); g.lineWidth = 2; g.beginPath();
    pts.forEach((p, i) => { const w = pts.slice(Math.max(0, i - 4), i + 1); const avg = w.reduce((a, b) => a + b.score, 0) / w.length; i ? g.lineTo(x(i), y(avg)) : g.moveTo(x(i), y(avg)); });
    g.stroke();
  } else { g.fillText('Your scores will show up here.', 40, H / 2); }
  $('#runs').onclick = async e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    if (e.target.dataset.play) { const p = $('#player'); p.src = `/media/takes/${e.target.dataset.play}`; p.play(); }
    if (e.target.closest('[data-del]') && confirm('Delete this run?')) { await api(`/api/runs/${tr.dataset.id}`, { method: 'DELETE' }); tr.remove(); }
  };
}, 'history');

// ---- settings
route(/^\/settings$/, async () => {
  const s = await settings();
  let health = {};
  try { health = await api('/api/health'); } catch { /* ignore */ }
  view.innerHTML = `<h1>Settings</h1>
    <div class="card grid2" id="form">
      <label>Green zone (cents) <input type="number" name="greenCents" min="5" max="60" value="${s.greenCents}"></label>
      <label>Amber zone (cents) <input type="number" name="amberCents" min="10" max="120" value="${s.amberCents}"></label>
      <label>Scroll speed (px/s) <input type="number" name="pxPerSecond" min="60" max="400" step="10" value="${s.pxPerSecond}"></label>
      <label><input type="checkbox" name="octaveFree" ${s.octaveFree ? 'checked' : ''}> Any octave counts</label>
      <label><input type="checkbox" name="recordTakes" ${s.recordTakes ? 'checked' : ''}> Record my takes</label>
      <label><input type="checkbox" name="echoCancellation" ${s.echoCancellation ? 'checked' : ''}> Echo cancellation (only if you can't use headphones)</label>
      <label>Mic filter: <b id="mfName">${MIC_FILTER_NAMES[s.micFilter ?? 2]}</b>
        <input type="range" name="micFilter" min="0" max="3" step="1" value="${s.micFilter ?? 2}"></label>
      <p class="small dim" id="mfHelp" style="grid-column:1/-1;margin:0"></p>
    </div>
    <div class="row"><button class="primary" id="save">Save</button>
      <button id="preset-b">Beginner tolerances</button><button id="preset-a">Advanced tolerances</button></div>
    <h2>Timing on this device</h2>
    <div class="card">
      <div class="row"><label class="dim small">Extra delay (ms) <input type="number" id="lat" min="-300" max="1000" step="10" value="${deviceLatencyMs()}"></label>
        <button id="latSave">Save</button><button class="primary" id="latCheck">Run timing check</button></div>
      <p class="small dim">Each phone or computer keeps its own value. The check runs once per session before your first song or warm-up; run it again whenever you switch headphones (for example, AirPods to wired).</p>
    </div>
    <div class="card small dim">App version ${esc(health.version || '?')}${health.built ? ` (built ${esc(new Date(health.built).toLocaleString())})` : ''} · page loaded as ${esc(window.VL_VERSION || '?')}${health.version && window.VL_VERSION && health.version !== window.VL_VERSION ? ' · <b>out of date: reload the page</b>' : ''}<br>Server: yt-dlp ${esc(health.yt_dlp || '?')} · separation ${esc(health.demucs_model || '?')} · pitch ${esc(health.crepe_model || '?')} · ${health.queue ?? '?'} queued</div>`;
  const form = $('#form');
  const mfHelp = [
    'Off: every clear pitch is drawn, including breaths and bumps.',
    'Light: drops clicks, bumps and room noise. Draws about 60 ms behind your voice.',
    'Normal: also drops breaths and short voiced exhales. Draws about 60 ms behind your voice.',
    'Strong: only steady sounds clearly louder than your breathing. Very short staccato notes (under 0.1 s) may not show. Draws about 90 ms behind.',
  ];
  const mf = form.querySelector('[name=micFilter]');
  const showMf = () => { $('#mfName').textContent = MIC_FILTER_NAMES[mf.value]; $('#mfHelp').textContent = mfHelp[mf.value]; };
  mf.oninput = showMf; showMf();
  $('#preset-b').onclick = () => { form.querySelector('[name=greenCents]').value = 35; form.querySelector('[name=amberCents]').value = 70; };
  $('#preset-a').onclick = () => { form.querySelector('[name=greenCents]').value = 15; form.querySelector('[name=amberCents]').value = 35; };
  $('#latSave').onclick = () => { setDeviceLatencyMs(Number($('#lat').value)); toast('Saved for this device'); };
  $('#latCheck').onclick = async () => { await timingCheck(); $('#lat').value = deviceLatencyMs(); };
  $('#save').onclick = async () => {
    const patch = {};
    form.querySelectorAll('input').forEach(i => { patch[i.name] = i.type === 'checkbox' ? i.checked : Number(i.value); });
    if (patch.amberCents <= patch.greenCents) return toast('Amber has to be wider than green');
    await saveSettings(patch); toast('Saved');
  };
}, 'settings');

api('/api/me').then(m => { if (m.login) $('#logout').hidden = false; }).catch(() => {});
$('#logout').onclick = e => { if (!confirm('Sign out of Vocal Lab on this device?')) e.preventDefault(); };
window.addEventListener('DOMContentLoaded', render);
