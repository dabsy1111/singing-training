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
    A.ready = A.ctx.audioWorklet.addModule('/static/pitch-worklet.js');
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
  A.gate = createJumpGate(); A.smooth = null;
  A.node.port.onmessage = e => {
    const f = e.data;
    let hz = null;
    if (f.hz > 0 && f.clarity > 0.8) {
      const g = A.gate.push(f.hz, f.t);
      if (g !== null) { A.smooth = smoothPitch(A.smooth, g); hz = A.smooth; } else hz = A.smooth;
    } else { A.gate.reset(); A.smooth = null; }
    const frame = { t: f.t, hz, midi: hz ? hzToMidi(hz) : null, rms: f.rms };
    A.listeners.forEach(fn => fn(frame));
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
    ? hold.reduce((a, f) => a + (f.c === null ? 0 : Math.abs(f.c) <= s.greenCents ? 1 : Math.abs(f.c) <= s.amberCents ? 0.6 : 0), 0) / hold.length
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
  let best = { off: 0, score: -1 };
  for (let off = -0.6; off <= 0.601; off += 0.02) {
    let good = 0, total = 0;
    for (const p of trail) {
      if (p.midi === null) continue;
      const t = p.t - off;
      const n = findNote(notes, t);
      if (!n) continue;
      total++;
      if (Math.abs(centsOff(p.midi, n.midi + tune, s.octaveFree)) <= s.amberCents) good++;
    }
    const sc = total ? good / total : 0;
    if (sc > best.score + 1e-6) best = { off, score: sc };
  }
  return best;
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
 * audio:  { buffers: {accomp, vocals} } for songs, or { synth: true } for drills */
class Practice {
  constructor(el, target, audio, opts) {
    this.el = el; this.target = target; this.audio = audio; this.opts = opts;
    this.notes = target.notes.map(n => ({ ...n, frames: [], result: null }));
    this.tune = (target.tuning || 0) / 100;   // song tuning offset, in semitones
    window.__practice = this; // handy for debugging from the console
    this.pos = opts.start || 0;        // song time when stopped
    this.playing = false;
    this.trail = [];
    this.canvas = document.createElement('canvas');
    el.appendChild(this.canvas);
    this.hud = document.createElement('div'); this.hud.className = 'hud'; el.appendChild(this.hud);
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
    return this.startPos + (A.ctx.currentTime - this.startCtx);
  }

  async play({ from, to }) {
    const ctx = await startMic();
    const s = this.opts.settings;
    this.section = { from, to };
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
        src.start(this.startCtx, from, Math.max(0, to - from));
        this.nodes.push(src); this['gain_' + key] = g;
      }
    } else {
      const g = ctx.createGain(); g.gain.value = this.opts.volumes.guide ?? 0.8; g.connect(this.master); this.gain_guide = g;
      const cue = ctx.createGain(); cue.gain.value = 0.9; cue.connect(this.master);
      for (const c of this.target.cues || []) if (c.t0 >= from && c.t0 < to)
        this.nodes.push(...playTone(ctx, cue, c.midi, this.startCtx + c.t0 - from, c.t1 - c.t0, 0.22));
      for (const n of this.notes) if (n.t0 >= from && n.t0 < to)
        this.nodes.push(...playTone(ctx, g, n.midi, this.startCtx + n.t0 - from, n.t1 - n.t0, 0.2));
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
    this.endTimer = setTimeout(() => this.stop(true), (to - from + lead + 0.3) * 1000);
  }

  setVolume(key, v) { const g = this['gain_' + key]; if (g) g.gain.value = v; }

  onFrame(f) {
    if (!this.playing) return;
    const t = this.startPos + (f.t - this.startCtx) - this.latency;
    if (t < this.section.from - 0.2 || t > this.section.to) return;
    const s = this.opts.settings;
    const n = findNote(this.notes, t);
    let c = null;
    if (n && f.midi !== null) c = centsOff(f.midi, n.midi + this.tune, s.octaveFree);
    if (n && t >= this.section.from) n.frames.push({ dt: t - n.t0, c });
    let show = f.midi;
    if (show !== null && s.octaveFree && n) show = n.midi + this.tune + c / 100;   // draw in the target's octave
    this.trail.push({ t, midi: f.midi, show, c, onNote: !!n });
    this.current = { midi: f.midi, c, n };
    // grade notes that have finished
    for (const m of this.notes) if (!m.result && m.t1 < t && m.t0 >= this.section.from && m.frames.length) m.result = gradeNote(m, s);
  }

  async stop(finished = false) {
    if (!this.playing) return null;
    const reached = Math.min(this.now() - (this.latency || 0), this.section.to);
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
      finished, score, take, bias, timingOffset: off.off,
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
    const [lo, hi] = this.viewRange();
    const rows = hi - lo + 1, rowH = H / rows;
    const y = m => H - (m - lo + 0.5) * rowH;
    const x = t => px + (t - now) * pps;
    // grid
    g.font = '11px system-ui'; g.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
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
        const X = x(i * tg.hop), Y = y(v);
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
      if (X1 - X0 > 26 && rowH > 11) { g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(noteName(n.midi), X0 + 4, Y); }
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
    // playhead
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(px, 0, 1, H);
    // left labels
    g.fillStyle = 'rgba(200,205,220,0.7)';
    for (let m = lo; m <= hi; m++) if (rowH > 9 && (((m % 12) + 12) % 12 === 0 || rowH > 16) && ![1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12)) g.fillText(noteName(m), 4, y(m));
    // HUD
    const cur = this.playing ? this.current : null;
    if (cur && cur.midi !== null) {
      const c = cur.c;
      const word = c === null ? '' : Math.abs(c) <= s.greenCents ? 'on it' : c > 0 ? 'aim lower' : 'aim higher';
      this.hud.innerHTML = `<div class="big">${noteName(cur.midi)}</div><div class="dim small">${c === null ? '' : (c > 0 ? '+' : '') + Math.round(c) + '¢ · ' + word}</div>`;
    } else this.hud.innerHTML = `<div class="dim small">${fmtTime(Math.max(0, now))}</div>`;
  }

  viewRange() {
    const s = this.opts.settings;
    let lo = this.target.range?.[0] ?? s.rangeLow, hi = this.target.range?.[1] ?? s.rangeHigh;
    lo -= 3; hi += 3;
    while (hi - lo < 14) { lo--; hi++; }
    return [lo, hi];
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

function needsTimingCheck() { try { return !sessionStorage.getItem(CHECK_KEY); } catch { return false; } }
function markTimingChecked() { try { sessionStorage.setItem(CHECK_KEY, '1'); } catch { /* ignore */ } }

function estimateDelay(frames, onsets) {
  const inNote = t => onsets.some(o => t >= o && t < o + CHECK_NOTE);
  const noteFrames = onsets.length * CHECK_NOTE / 0.01;
  let best = { d: null, score: -Infinity, covered: 0 };
  for (let d = -0.1; d <= 0.9; d += 0.005) {
    let score = 0, hit = 0;
    for (const f of frames) {
      if (!f.v) continue;
      if (inNote(f.t - d)) { score++; hit++; } else score -= 0.7;
    }
    if (score > best.score) best = { d, score, covered: hit / noteFrames };
  }
  return best;
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
        <p>Put your headphones on. You'll hear four clicks, then short beeps with a few gaps. Sing a short "da" in time with each beep, as if you were singing along.</p>
        <p class="small dim">This measures your headphone and mic delay so your notes line up. About 10 seconds. Current setting for this device: ${deviceLatencyMs()} ms extra.</p>
        ${note}
        <div class="row"><button class="primary" data-a="start">Start</button><button data-a="skip">Skip for now</button></div></div>`;
      wrap.querySelector('[data-a=start]').onclick = run;
      wrap.querySelector('[data-a=skip]').onclick = () => { markTimingChecked(); close(true); };
    };
    async function run() {
      wrap.innerHTML = `<div class="card"><h2 style="margin-top:0">Listen…</h2><p class="tuner" id="tc-beat">·</p><p class="dim small" style="text-align:center">Sing "da" with each beep</p></div>`;
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
      off = onPitch(f => frames.push({ t: f.t - start, v: f.midi !== null && Math.abs(centsOff(f.midi, m, true)) < 250 }));
      const end = start + onsets[onsets.length - 1] + 1.4;
      const beatEl = wrap.querySelector('#tc-beat');
      await new Promise(done => {
        const tick = () => {
          const t = ctx.currentTime;
          if (t >= end) return done();
          if (t < t0) beatEl.textContent = '·';
          else if (t < start) beatEl.textContent = String(Math.floor((t - t0) / CHECK_BEAT) + 1);
          else beatEl.textContent = onsets.some(o => t - start >= o && t - start < o + CHECK_NOTE) ? 'da' : '·';
          requestAnimationFrame(tick);
        };
        tick();
      });
      off(); off = null; out.disconnect();
      const est = estimateDelay(frames, onsets);
      if (est.d === null || est.covered < 0.35) {
        intro(`<p class="err">Didn't hear enough singing to measure. Try again, singing a bit louder, right on each beep.</p>`);
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
    <div id="list" class="songs"></div>`;
  const list = $('#list');
  let timer = null;
  const s = await settings();
  async function refresh() {
    const songs = await api('/api/songs');
    list.innerHTML = songs.length ? songs.map(song => `
      <div class="card song" data-id="${song.id}">
        <div class="grow">
          <div class="title">${esc(song.title)}</div>
          <div class="small dim">${song.duration ? fmtTime(song.duration) + ' · ' : ''}${song.note_low != null ? `${noteName(song.note_low)}–${noteName(song.note_high)}` + fitHint(song, s) : esc(song.stage || '')}</div>
          ${song.error ? `<div class="err">${esc(song.error)}</div>` : ''}
        </div>
        <span class="pill ${song.status}">${song.status === 'processing' ? 'working' : song.status}</span>
        ${song.status === 'ready' ? `<a class="btn primary" href="#/song/${song.id}">Sing</a>` : ''}
        ${song.status === 'error' ? `<button data-retry>Retry</button>` : ''}
        <button data-del class="danger" title="Delete">✕</button>
      </div>`).join('') : `<p class="dim">No songs yet. Paste a YouTube link above.</p>`;
    const busy = songs.some(x => x.status === 'queued' || x.status === 'processing');
    clearTimeout(timer); if (busy) timer = setTimeout(refresh, 3000);
  }
  list.onclick = async e => {
    const card = e.target.closest('.song'); if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('[data-del]')) {
      if (!confirm('Delete this song and its audio?')) return;
      try { await api(`/api/songs/${id}`, { method: 'DELETE' }); } catch (err) { toast(err.message); }
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
  const lo = song.note_low, hi = song.note_high;
  if (lo == null) return '';
  if (lo >= s.rangeLow && hi <= s.rangeHigh) return ' · fits your range';
  if (lo - 12 >= s.rangeLow - 1 && hi - 12 <= s.rangeHigh + 1) return ' · an octave down fits you';
  if (lo + 12 >= s.rangeLow - 1 && hi + 12 <= s.rangeHigh + 1) return ' · an octave up fits you';
  return ' · outside your range';
}

// ---- sing a song
route(/^\/song\/([0-9a-f]{12})$/, async id => {
  const [song, an, s] = await Promise.all([api(`/api/songs/${id}`), api(`/api/songs/${id}/analysis`), settings()]);
  const firstIn = Math.max(0, Math.floor((an.notes[0]?.t0 ?? 0) - 3));   // skip a long intro
  view.innerHTML = `
    <div class="row"><h1 class="grow">${esc(song.title)}</h1><span class="dim small">${Math.abs(an.tuning || 0) >= 10 ? `Recording is tuned ${an.tuning > 0 ? '+' : ''}${an.tuning}¢ from A440; targets follow it.` : ''}</span><span class="dim small" id="loadmsg">Loading audio…</span></div>
    <div class="stage" id="stage" style="height:min(56vh,480px)"></div>
    <div class="controls">
      <button class="primary" id="play" disabled>▶ Sing</button>
      <button id="restart" title="Back to section start">⏮</button>
      <label>From <input type="text" id="from" size="5" value="${fmtTime(firstIn)}"></label>
      <label>To <input type="text" id="to" size="5" value="${fmtTime(an.duration)}"></label>
      <button id="setA" title="Set section start to the playhead">[ here</button>
      <button id="setB" title="Set section end to the playhead">here ]</button>
      <label><input type="checkbox" id="loop"> Loop</label>
    </div>
    <div class="controls">
      <label>Music <input type="range" id="vAcc" min="0" max="1.2" step="0.05" value="0.9"></label>
      <label>Guide vocal <input type="range" id="vVoc" min="0" max="1.2" step="0.05" value="0.3"></label>
      <label><input type="checkbox" id="octFree" ${s.octaveFree ? 'checked' : ''}> Any octave counts</label>
      <label><input type="checkbox" id="contour" checked> Show melody line</label>
    </div>
    <div class="legend small"><span><i style="background:var(--green)"></i>within ${s.greenCents}¢</span><span><i style="background:var(--amber)"></i>within ${s.amberCents}¢</span><span><i style="background:var(--red)"></i>off</span><span>Drag the track to move around when stopped. Headphones work best.</span></div>
    <div id="res"></div>`;
  const stage = $('#stage');
  const parseT = v => { const p = String(v).split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0] || 0; };
  const sec = () => ({ from: clamp(parseT($('#from').value), 0, an.duration), to: clamp(parseT($('#to').value), 0, an.duration) });
  const vols = { accomp: +$('#vAcc').value, vocals: +$('#vVoc').value };
  const P = new Practice(stage, { ...an, duration: an.duration }, { buffers: {} }, {
    settings: s, volumes: vols, sectionRef: sec, showContour: () => $('#contour').checked, start: firstIn,
  });
  cleanup = () => { P.destroy(); stopMic(); };
  try {
    const [accomp, vocals] = await Promise.all([loadBuffer(`/media/songs/${id}/accompaniment.mp3`), loadBuffer(`/media/songs/${id}/vocals.mp3`)]);
    P.audio.buffers = { accomp, vocals };
    $('#loadmsg').textContent = ''; $('#play').disabled = false;
  } catch (e) { $('#loadmsg').textContent = 'Audio failed to load: ' + e.message; }

  $('#vAcc').oninput = e => { vols.accomp = +e.target.value; P.setVolume('accomp', vols.accomp); };
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
  P.opts.onEnd = null;
  const origStop = P.stop.bind(P);
  P.stop = async (finished) => {
    const res = await origStop(finished);
    if (!res || !document.body.contains(stage)) return res;   // left the page mid-song
    playBtn.textContent = '▶ Sing';
    $('#res').innerHTML = resultsHTML(res, s); bindLatencyButton($('#res'));
    if (res.score !== null && res.notes.length >= 4) {
      saveRun('song', id, song.title, res).catch(e => toast('Couldn’t save run: ' + e.message));
    }
    if (finished && $('#loop').checked) { P.pos = sec().from; setTimeout(go, 1200); }
    else if (finished) P.pos = sec().from;
    return res;
  };
  playBtn.onclick = () => (P.playing ? P.stop(false) : go());
}, 'songs');

// ---- warm-up drills
const DRILLS = {
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

function buildDrill(keys, s, tempo = 1, down = true) {
  const notes = [], cues = [];
  let t = 0.6;
  for (const k of keys) {
    const d = DRILLS[k], span = Math.max(...d.pattern), beat = d.beat / tempo;
    const roots = [];
    for (let r = s.rangeLow; r + span <= s.rangeHigh; r++) roots.push(r);
    if (!roots.length) roots.push(s.rangeLow);
    const seq = down ? [...roots, ...roots.slice(0, -1).reverse()] : roots;
    // keep long lists manageable
    const step = seq.length > 14 ? 2 : 1;
    for (let i = 0; i < seq.length; i += step) {
      const r = seq[i];
      cues.push({ t0: t, t1: t + 0.7, midi: r });
      t += 0.9;
      for (const iv of d.pattern) { notes.push({ t0: t, t1: t + beat * 0.92, midi: r + iv }); t += beat; }
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
    await saveSettings({ rangeLow: lo, rangeHigh: hi }); $('#saved').textContent = `${noteName(lo)} – ${noteName(hi)}`; toast('Saved');
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
      await saveSettings(patch);
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

route(/^\/ear$/, async () => {
  const s = await settings();
  view.innerHTML = `<h1>Ear training</h1>
    <div class="controls">
      <label>Exercise <select id="mode"><option value="hl">Higher or lower</option><option value="iv">Name the interval</option><option value="sb">Sing it back</option></select></label>
      <label>Level <select id="lvl"><option>easy</option><option selected>medium</option><option>hard</option></select></label>
      <button class="primary" id="start">Start 10 questions</button>
    </div>
    <div id="q"></div>`;
  let off = null;
  const mid = Math.round((s.rangeLow + s.rangeHigh) / 2);
  $('#start').onclick = async () => {
    const mode = $('#mode').value, lv = EAR_LEVELS[$('#lvl').value];
    // Sing-back needs the mic; open it first so the same audio setup is used throughout (matters on iPhone).
    let ctx;
    try { ctx = mode === 'sb' ? await startMic() : await audioCtx(); } catch (e) { return toast(e.message, 6000); }
    const answers = [];
    const out = ctx.createGain(); out.connect(ctx.destination);
    for (let i = 0; i < 10; i++) {
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
        try { await startMic(); } catch (e) { toast(e.message, 6000); return; }
        $('#q').querySelector('.dim').textContent = 'Listening…';
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
        $('#q').innerHTML = `<div class="card"><p>Target ${noteName(target)}. ${c === null ? 'Didn’t hear enough singing.' : `You were ${Math.abs(Math.round(c))}¢ ${c > 0 ? 'sharp' : 'flat'}.`} ${correct ? '✅' : '❌'}</p></div>`;
        await new Promise(r => setTimeout(r, 1600));
      }
      answers.push({ item, correct });
      if (mode !== 'sb') await new Promise(r => setTimeout(r, 900));
    }
    const score = 100 * answers.filter(a => a.correct).length / answers.length;
    const title = { hl: 'Higher or lower', iv: 'Intervals', sb: 'Sing it back' }[mode];
    const fd = new FormData();
    fd.append('meta', JSON.stringify({ kind: 'ear', ref: mode, title, score, details: { answers, level: $('#lvl').value } }));
    api('/api/runs', { method: 'POST', body: fd }).catch(e => toast(e.message));
    const missed = answers.filter(a => !a.correct).map(a => a.item);
    $('#q').innerHTML = `<div class="card"><b>${Math.round(score)}%</b> correct.${missed.length ? ` <span class="dim">Missed: ${esc([...new Set(missed)].join(', '))}</span>` : ''}</div>`;
  };
  function ask(text, options, replay) {
    return new Promise(res => {
      $('#q').innerHTML = `<div class="card"><p class="dim">${esc(text)}</p><div class="choices">${options.map(o => `<button data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        <p><button id="replay">↻ Play again</button></p></div>`;
      $('#replay').onclick = replay;
      $('#q').querySelectorAll('[data-o]').forEach(b => b.onclick = () => res(b.dataset.o));
    });
  }
  function reveal(pick, right) {
    $('#q').querySelectorAll('[data-o]').forEach(b => {
      b.disabled = true;
      if (b.dataset.o === right) b.classList.add('right'); else if (b.dataset.o === pick) b.classList.add('wrong');
    });
  }
  cleanup = () => { off?.(); stopMic(); };
}, 'ear');

// ---- progress
route(/^\/history$/, async () => {
  const [runs, st] = await Promise.all([api('/api/runs?limit=300'), api('/api/stats')]);
  view.innerHTML = `<h1>Progress</h1>
    <div class="card"><canvas id="chart" style="width:100%;height:200px"></canvas></div>
    <h2>Accuracy by note</h2>
    <div class="card"><div class="heat" id="heat"></div><p class="small dim">Average note score across songs and drills. Darker cells haven't been sung enough to say.</p></div>
    ${Object.keys(st.ear).length ? `<h2>Ear training</h2><div class="card"><table><tr><th>Item</th><th>Tries</th><th>Correct</th></tr>${Object.entries(st.ear).sort((a, b) => a[1].avg - b[1].avg).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${Math.round(v.avg * 100)}%</td></tr>`).join('')}</table></div>` : ''}
    <h2>Recent runs</h2>
    <div class="card"><table id="runs"><tr><th>When</th><th>What</th><th>Score</th><th></th></tr>
    ${runs.map(r => `<tr data-id="${r.id}"><td class="small">${fmtDate(r.created)}</td><td>${esc(r.title || r.ref)} <span class="dim small">${r.kind}</span></td><td>${r.score == null ? '–' : Math.round(r.score) + '%'}</td>
      <td class="row" style="justify-content:flex-end">${r.take ? `<button data-play="${esc(r.take)}">▶ Take</button>` : ''}<button data-del class="danger">✕</button></td></tr>`).join('')}
    </table>${runs.length ? '' : '<p class="dim">Nothing yet. Sing something.</p>'}</div>
    <audio id="player" hidden></audio>`;
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
    </div>
    <div class="row"><button class="primary" id="save">Save</button>
      <button id="preset-b">Beginner tolerances</button><button id="preset-a">Advanced tolerances</button></div>
    <h2>Timing on this device</h2>
    <div class="card">
      <div class="row"><label class="dim small">Extra delay (ms) <input type="number" id="lat" min="-300" max="1000" step="10" value="${deviceLatencyMs()}"></label>
        <button id="latSave">Save</button><button class="primary" id="latCheck">Run timing check</button></div>
      <p class="small dim">Each phone or computer keeps its own value. The check runs once per session before your first song or warm-up; run it again whenever you switch headphones (for example, AirPods to wired).</p>
    </div>
    <div class="card small dim">Server: yt-dlp ${esc(health.yt_dlp || '?')} · separation ${esc(health.demucs_model || '?')} · pitch ${esc(health.crepe_model || '?')} · ${health.queue ?? '?'} queued</div>`;
  const form = $('#form');
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
render();
