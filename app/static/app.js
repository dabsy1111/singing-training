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
const A = { ctx: null, ready: null, stream: null, node: null, listeners: new Set(), raw: new Set(), gate: null, smooth: null };
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

// Which mic to use is per browser too: a desktop can have a webcam mic, a USB mic and an audio
// interface, and the system default is often the wrong one. Empty = the system default.
const MIC_KEY = 'vl-mic-id';
function preferredMicId() { try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; } }
function setPreferredMicId(id) { try { if (id) localStorage.setItem(MIC_KEY, id); else localStorage.removeItem(MIC_KEY); } catch { /* storage blocked */ } }
async function listMics() {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'); }
  catch { return []; }
}
function currentMicLabel() { return A.stream?.getAudioTracks()[0]?.label || ''; }

// Must be called from a tap/click the first time (browsers block audio until then).
// resume() is called before any await so it still counts as part of the gesture.
async function audioCtx() {
  if (!A.ctx || A.ctx.state === 'closed') {
    A.ctx = new AudioContext({ latencyHint: 'interactive' });
    A.ctx.onstatechange = () => {
      if (A.ctx?.state === 'interrupted') toast('Audio was interrupted (a call, Siri or another app). Press play again.', 6000);
    };
    A.ready = A.ctx.audioWorklet.addModule(`/static/pitch-worklet.js?v=${window.VL_VERSION || ''}`);
    loadVoice(A.ctx).catch(() => {});   // fetch the singer's clips early
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

// Is the open mic still feeding us? iOS can end the track (AirPods reconnect, a call, Siri)
// or leave the detector on a context that's since been replaced; either way no frames arrive.
function micAlive() {
  const tr = A.stream?.getAudioTracks()[0];
  return !!(tr && tr.readyState === 'live' && A.node && A.ctx && A.node.context === A.ctx && A.ctx.state !== 'closed');
}

async function startMic() {
  if (A.stream && micAlive()) return audioCtx();
  if (A.stream) teardownMic();   // a dead mic: reopen it instead of carrying on deaf
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs HTTPS. Open the https:// address (see the README).');
  setAudioSession('play-and-record');
  // On iPhone, opening the mic switches AirPods into headset mode, which changes the
  // audio hardware's sample rate. A context made before that can play back garbled,
  // so open the mic first and build the context afterwards. (While the mic is live,
  // iOS lets the page start audio without another tap.)
  if (IS_IOS && A.ctx && A.ctx.state !== 'closed') { try { await A.ctx.close(); } catch { /* ignore */ } A.ctx = null; }
  const s = SETTINGS || await settings();
  const audio = { echoCancellation: !!s.echoCancellation, noiseSuppression: false, autoGainControl: false };
  // Desktop: ask for both channels, so a mic on input 2 of an audio interface isn't lost (the
  // detector listens to whichever channel has the voice). iPhone: leave it alone; AirPods and
  // the built-in mic are mono, and extra constraints there have changed the route before.
  if (!IS_IOS) audio.channelCount = { ideal: 2 };
  const want = preferredMicId();
  if (want) audio.deviceId = { ideal: want };   // ideal, not exact: falls back if it's unplugged
  A.stream = await navigator.mediaDevices.getUserMedia({ audio });
  A.stream.getAudioTracks()[0]?.addEventListener('ended', () => micChanged());
  A.clipAt = 0;
  const ctx = await audioCtx();
  const src = ctx.createMediaStreamSource(A.stream);
  A.node = new AudioWorkletNode(ctx, 'pitch-processor');
  const sink = ctx.createGain(); sink.gain.value = 0;
  src.connect(A.node); A.node.connect(sink); sink.connect(ctx.destination);
  A.gate = createJumpGate(); A.smooth = null; A.filter = null;
  A.lastFrameAt = performance.now(); A.level = 0;
  A.node.port.onmessage = e => {
    A.lastFrameAt = performance.now(); A.level = e.data.rms || 0;
    if (e.data.peak >= 0.98) A.clipAt = A.lastFrameAt;   // the mic or interface gain is too high
    A.raw.forEach(fn => fn(e.data));   // unfiltered frames (the voice range profile does its own checks)
    // the mic filter (mic-filter.js) drops breaths, clicks and bumps; rebuilt if its settings change
    const st = SETTINGS || {};
    const level = st.micFilter ?? 2;
    const key = `${level}/${st.rangeLow}/${st.rangeHigh}`;
    if (!A.filter || A.filterKey !== key) { A.filter = createMicFilter(level, st.rangeLow, st.rangeHigh); A.filterKey = key; }
    for (const f of A.filter.push(e.data)) {
      let hz = null;
      if (f.hz > 0) {
        // The jump gate holds a new pitch back 80 ms, drawing the old note meanwhile, which cut the
        // start off every note sung straight on from the last. The filter already confirms jumps
        // and drops short glitches, so the gate only runs with the filter off.
        const g = level === 0 ? A.gate.push(f.hz, f.t) : f.hz;
        if (g !== null) { A.smooth = smoothPitch(A.smooth, g); hz = A.smooth; } else hz = A.smooth;
      } else { A.gate.reset(); A.smooth = null; }
      const frame = { t: f.t, hz, midi: hz ? hzToMidi(hz) : null, rms: f.rms };
      A.listeners.forEach(fn => fn(frame));
    }
  };
  micChanged();
  return ctx;
}

// Close the mic but keep whoever's listening, so a restart carries straight on.
function teardownMic() {
  A.stream?.getTracks().forEach(t => t.stop());
  // Detach the old detector too: a disconnected worklet keeps running and posting silent frames,
  // which interleaved with the next page's frames and broke runs of steady pitch.
  if (A.node) { A.node.port.onmessage = null; A.node.port.close(); A.node.disconnect(); }
  A.stream = null; A.node = null; A.filter = null;
  micChanged();
}

function stopMic() {
  teardownMic();
  A.listeners.clear(); A.raw.clear();
  setAudioSession('auto');
}

async function restartMic() { teardownMic(); return startMic(); }

// ---------------------------------------------------------------- mic button (header, every page)
// Off: tap to open the mic before you press play. On: a live level bar shows it hearing you; tap
// to close it. If it stops sending (dropped AirPods, an interruption) it turns red: tap to reopen,
// no page reload needed.
function micState() {
  if (!A.stream) return 'off';
  if (!micAlive() || performance.now() - (A.lastFrameAt || 0) > 1500) return 'stuck';
  if (performance.now() - (A.clipAt || 0) < 1500) return 'clip';
  return 'on';
}
function micChanged() { drawMicBtn(); }
function drawMicBtn() {
  const b = document.getElementById('micBtn'); if (!b) return;
  const st = micState();
  if (b.dataset.state !== st) {
    b.dataset.state = st;
    const name = currentMicLabel();
    b.title = st === 'off' ? 'Start the microphone'
      : st === 'on' ? `Mic on${name ? ` (${name})` : ''}: tap to stop`
      : st === 'clip' ? 'The mic is clipping: turn the gain down on the mic or interface, or back off a little'
      : 'Mic stopped hearing you: tap to restart';
    b.querySelector('span').textContent = st === 'off' ? 'Start mic' : st === 'on' ? 'Mic on' : st === 'clip' ? 'Too loud' : 'Restart mic';
  }
}
(function micBtnLoop() {
  const b = document.getElementById('micBtn');
  if (b) {
    drawMicBtn();
    const bar = b.querySelector('i');
    // level as a share of a loud-ish voice (-20 dB full scale), on a dB scale so quiet singing still shows
    const db = A.level > 1e-4 ? 20 * Math.log10(A.level) : -80;
    bar.style.width = (b.dataset.state === 'on' || b.dataset.state === 'clip' ? clamp((db + 60) / 40, 0, 1) * 100 : 0) + '%';
  }
  requestAnimationFrame(micBtnLoop);
})();
document.addEventListener('click', async e => {
  const b = e.target.closest?.('#micBtn'); if (!b) return;
  e.preventDefault();
  const st = micState();
  try {
    if (st === 'on' || st === 'clip') { teardownMic(); setAudioSession('auto'); return; }
    b.disabled = true;
    await (st === 'stuck' ? restartMic() : startMic());
    toast(st === 'stuck' ? 'Mic restarted' : 'Mic on. Sing a note: the bar should move.');
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone permission was refused. Allow it in Safari\'s settings for this site.' : 'Mic error: ' + err.message, 6000);
  } finally { b.disabled = false; drawMicBtn(); }
});

// A mic plugged in or out while the app is open. If the chosen mic has just appeared and we're
// on another one, or the one we're on has gone, switch without a reload.
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  if (!A.stream) return;
  const mics = await listMics(), want = preferredMicId();
  const on = A.stream.getAudioTracks()[0]?.getSettings?.().deviceId;
  const gone = on && !mics.some(m => m.deviceId === on);
  const back = want && on !== want && mics.some(m => m.deviceId === want);
  if (gone || back) {
    try { await restartMic(); toast(`Mic switched to ${currentMicLabel() || 'the default mic'}`); } catch { micChanged(); }
  }
  document.dispatchEvent(new Event('vl-mics'));
});

function onPitch(fn) { A.listeners.add(fn); return () => A.listeners.delete(fn); }
function onRawPitch(fn) { A.raw.add(fn); return () => A.raw.delete(fn); }

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

// ---------------------------------------------------------------- sung reference notes
/* Real singers from VocalSet (Wilkins et al. 2018, CC BY 4.0; see static/voice/CREDITS.txt):
 * male6 (low) and female5 (high) singing a e i o u and lip trills, cut into one clip per vowel and
 * semitone, tuned to the exact note (≤ 4 semitones of shift, formants kept) and levelled.
 * voice/{low,high}.mp3 hold the clips back to back; voice/voice.json maps vowel → midi → [start, length]. */
// Syllable → { onset, vowel, flutter, closed }. Unknown labels sing "ah".
function parseSyllable(label) {
  const t = String(label || '').toLowerCase();
  const out = { onset: '', vowel: 'a', flutter: false, closed: false, vol: 1 };
  if (/brr|trill|straw|siren|rrr/.test(t)) return { ...out, vowel: 'u', flutter: /brr|trill|rrr/.test(t) };
  if (/^(hum|mmm|m+$)|^ng\b|\bng$/.test(t) || t === 'hum') return { ...out, closed: true };
  if (/soft/.test(t)) out.vol = 0.55; else if (/loud/.test(t)) out.vol = 1.35;
  const w = t.replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] || '';
  // whole words whose vowel the spelling rules below get wrong (warm-up lyrics and solfège)
  const WORD = { i: ['', 'a'], sol: ['', 'o'], to: ['stop', 'u'], sing: ['', 'i'], me: ['m', 'i'], re: ['', 'e'], ti: ['stop', 'i'], so: ['', 'o'] };
  if (WORD[w] && t.trim() === w) return { ...out, onset: WORD[w][0], vowel: WORD[w][1] };
  if (/^m/.test(w)) out.onset = 'm'; else if (/^n/.test(w)) out.onset = 'n'; else if (/^h/.test(w)) out.onset = 'h';
  else if (/^[gdbl]/.test(w)) out.onset = 'stop';
  const v = w.replace(/^(m|n|h|g|d|b|l)+/, '');
  if (/^(ee|i$|ih)/.test(v)) out.vowel = 'i';
  else if (/^(oo|u$|ue)/.test(v) || w === 'hoo' || w === 'goo' || w === 'doo') out.vowel = 'u';
  else if (/^(oh|o)/.test(v)) out.vowel = 'o';
  else if (/^(ay|ey|eh|e|ai)/.test(v)) out.vowel = 'e';
  else if (/^(u|uh)/.test(v)) out.vowel = 'uh';
  return out;
}
function voiceTypeFor(s) {
  const v = s?.voiceType || 'auto';
  if (v === 'low' || v === 'high') return v;
  return ((s?.rangeLow ?? 48) + (s?.rangeHigh ?? 67)) / 2 < 62 ? 'low' : 'high';
}
function voiceTypeFor(s) {
  const v = s?.voiceType || 'auto';
  if (v === 'low' || v === 'high') return v;
  return ((s?.rangeLow ?? 48) + (s?.rangeHigh ?? 67)) / 2 < 62 ? 'low' : 'high';
}
const VOICE = { map: null, buffers: new WeakMap() };   // per AudioContext: { low, high } AudioBuffers
async function loadVoice(ctx, s = SETTINGS) {
  if (s?.refSound === 'tone') return;
  const type = voiceTypeFor(s);
  try {
    const q = '?v=' + encodeURIComponent(window.VL_VERSION || '1');
    if (!VOICE.map) VOICE.map = await (await fetch('/static/voice/voice.json' + q)).json();
    let per = VOICE.buffers.get(ctx);
    if (!per) VOICE.buffers.set(ctx, per = {});
    if (!per[type]) per[type] = fetch('/static/voice/' + VOICE.map[type].file + q).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b));
    per[type] = await per[type];
  } catch (e) { console.warn('voice clips not loaded', e); }
}
// Which clip: the exercise's vowel at this note, else a near vowel, else the nearest note (≤ 2 semitones, resampled).
function voiceClip(type, midi, syl) {
  const clips = VOICE.map?.[type]?.clips; if (!clips) return null;
  const v = syl.closed ? 'u' : syl.flutter ? 'trill' : syl.vowel === 'uh' ? 'a' : syl.vowel;
  const order = [v, ...(v === 'trill' ? ['u', 'o'] : []), 'a', 'o', 'u', 'e', 'i'];
  for (const k of order) if (clips[k]?.[midi]) return { at: clips[k][midi], rate: 1 };
  for (let d = 1; d <= 2; d++) for (const k of order) for (const m of [midi - d, midi + d])
    if (clips[k]?.[m]) return { at: clips[k][m], rate: Math.pow(2, (midi - m) / 12) };
  return null;
}
const XF_IN = Float32Array.from({ length: 32 }, (_, i) => Math.sin(i / 31 * Math.PI / 2)), XF_OUT = XF_IN.slice().reverse();
function playSung(ctx, dest, midi, when, dur, vol = 0.25, label = '', s = SETTINGS) {
  const type = voiceTypeFor(s), buf = VOICE.buffers.get(ctx)?.[type];
  const syl = parseSyllable(label), clip = buf && !(buf instanceof Promise) && voiceClip(type, midi, syl);
  if (!clip) return playTone(ctx, dest, midi, when, dur, vol);
  const [start, len] = clip.at, rate = clip.rate, nodes = [];
  const level = (vol / 0.22) * 1.25 * syl.vol;
  // the note's own shape: a quick fade in, steady, a short fade at the end of the note
  const env = ctx.createGain(), end = when + dur, rel = Math.min(0.07, dur * 0.25);
  env.gain.setValueAtTime(0, when); env.gain.linearRampToValueAtTime(level, when + 0.02);
  env.gain.setValueAtTime(level, Math.max(when + 0.02, end - rel)); env.gain.linearRampToValueAtTime(0.0001, end);
  let out = env;
  if (syl.closed || syl.onset === 'm' || syl.onset === 'n') {   // lips closed: muffle; "m"/"n" open into the vowel
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    if (syl.closed) lp.frequency.value = 480;
    else { lp.frequency.setValueAtTime(420, when); lp.frequency.setValueAtTime(420, when + 0.06); lp.frequency.exponentialRampToValueAtTime(12000, when + Math.min(0.14, dur * 0.4)); }
    env.connect(lp); out = lp;
  }
  out.connect(dest);
  const clipLen = len / rate;   // seconds of audio at this playback rate
  const piece = (t, off, d, fadeIn, fadeOut) => {
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const g = ctx.createGain(); src.connect(g); g.connect(env);
    g.gain.setValueAtTime(fadeIn ? 0 : 1, t);   // equal-power fades so joins don't dip
    if (fadeIn) g.gain.setValueCurveAtTime(XF_IN, t, fadeIn);
    if (fadeOut) g.gain.setValueCurveAtTime(XF_OUT, t + d - fadeOut, fadeOut);
    src.start(t, start + off * rate, d * rate + 0.01); nodes.push(src);
  };
  if (dur <= clipLen - 0.04) piece(when, 0, dur, 0, 0);
  else {   // longer than the recording: repeat its steady middle with overlapping fades
    const a = clipLen * 0.3, b = clipLen * 0.85, seg = b - a, xf = Math.min(0.12, seg * 0.3);   // at most two pieces sound at once
    piece(when, 0, b, 0, xf);
    let t = when + b - xf;
    while (t < end) { const d = Math.max(2 * xf + 0.01, Math.min(seg, end - t + 0.02)); piece(t, a, d, xf, xf); t += seg - xf; }   // the note's own fade ends it
  }
  return nodes;
}
// Reference notes: sung or plain tone, per Settings.
function playRef(ctx, dest, midi, when, dur, vol = 0.25, label = '') {
  return SETTINGS?.refSound === 'tone' ? playTone(ctx, dest, midi, when, dur, vol) : playSung(ctx, dest, midi, when, dur, vol, label);
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
    if (!this.audio.buffers) await Promise.race([loadVoice(ctx, this.opts.settings), new Promise(r => setTimeout(r, 6000))]);
    const s = this.opts.settings;
    this.section = { from, to };
    // rate < 1 = slowed-down audio: song time runs at rate × real time. Latency stays in real seconds.
    const rate = this.rate = this.audio.rate || 1;
    this.latency = autoLatency() + deviceLatencyMs() / 1000;
    for (const n of this.notes) if (n.t1 > from && n.t0 < to) { n.frames = []; n.result = null; }
    this.trail = [];
    // Your loudness is shown against your own loud singing on this device (remembered between runs).
    this.loudPeak = loudRef(); this.loudSung = []; this._ld = null;
    this.octVotes = []; this.oct = this.lastOct || 0;   // start from last run's octave: no spike on the first note
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
      const tn = this.target.notes || [];
      const sylAfter = t => (tn.find(n => n.t0 >= t - 0.01) || {}).label;   // a cue is sung on the syllable of the note it introduces
      for (const c of this.target.cues || []) if (c.t0 >= from && c.t0 < to)
        this.nodes.push(...playRef(ctx, cue, c.midi, this.startCtx + (c.t0 - from) / rate, (c.t1 - c.t0) / rate, 0.22, c.label ?? sylAfter(c.t1)));
      for (const n of this.notes) if (n.t0 >= from && n.t0 < to && n.guide !== false)
        this.nodes.push(...playRef(ctx, g, n.midi, this.startCtx + (n.t0 - from) / rate, (n.t1 - n.t0) / rate, 0.2, n.label));
    }
    this.playing = true;
    this.unsub = onPitch(f => this.onFrame(f));
    this.recorder = null;
    if ((s.recordTakes || this.opts.record) && window.MediaRecorder && A.stream) {
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
    if (shift !== this.shift) this.lastOct = 0;   // notes moved octave: relearn where you sing
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
    // Which octave you're singing in, relative to the notes: a vote over the last ~0.5 s of sung
    // notes. A man singing along in the original singer's octave over an "octave down" part
    // reads +1, and so does anyone singing the melody up an octave.
    if (n && f.midi !== null) {
      this.octVotes.push(Math.round((f.midi - (n.midi + this.tune)) / 12));
      if (this.octVotes.length > 50) this.octVotes.shift();
      const tally = {};
      for (const v of this.octVotes) tally[v] = (tally[v] || 0) + 1;
      const [best, cnt] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (cnt >= this.octVotes.length * 0.6 && this.octVotes.length >= 10) this.oct = this.lastOct = +best;
    }
    // Draw your line in the notes' octave, between notes too. Before this, only frames over a
    // note were folded down, so every gap and every early start shot off the top of the chart.
    let show = f.midi === null ? null : f.midi - 12 * this.oct;
    if (show !== null && s.octaveFree && n) show = n.midi + this.tune + c / 100;   // exactly as graded
    // loudness in dB (mic full scale), lightly smoothed; drawn in the band under the melody
    const db = f.rms > 1e-4 ? 20 * Math.log10(f.rms) : null;
    this._ld = db === null ? null : this._ld == null ? db : this._ld * 0.6 + db * 0.4;
    if (this._ld !== null && f.midi !== null) { this.loudPeak = Math.max(this.loudPeak, this._ld); this.loudSung.push(this._ld); }
    this.trail.push({ t, midi: f.midi, show, c, onNote: !!n, rms: f.rms, ld: this._ld });
    this.opts.onFrame?.(f, t, n, c);
    this.current = { midi: f.midi, c, n, oct: this.oct };
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
    if (!s.octaveFree && this.oct && reached - this.section.from > 5) {
      toast(`You sang ${Math.abs(this.oct) === 1 ? 'an octave' : Math.abs(this.oct) + ' octaves'} ${this.oct > 0 ? 'above' : 'below'} the notes, so they scored as misses. Change "Sing it" to match where you sing, or tick "Any octave counts".`, 9000);
    }
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
    if (this.loudSung?.length > 300) {   // 3 s of singing: remember how loud "loud" is on this mic
      const v = [...this.loudSung].sort((a, b) => a - b)[Math.floor(this.loudSung.length * 0.98)];
      try { localStorage.setItem('vl-loud-peak', v.toFixed(1)); } catch { /* ignore */ }
    }
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
    const LH = showLoudness() ? clamp(Math.round(H * 0.17), 30, 64) : 0;   // loudness band at the bottom
    const PH = H - LH;
    const rows = hi - lo + 1, rowH = PH / rows;
    const mLo = Math.floor(lo), mHi = Math.ceil(hi);
    const y = m => PH - (m - lo + 0.5) * rowH;
    const x = t => px + (t - now) * pps;
    g.save(); g.beginPath(); g.rect(0, 0, W, PH); g.clip();   // notes and lines stay above the loudness band
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
      if (prev && p.t - prev.t < 0.05 && Math.abs(p.show - prev.m) < 7) { g.beginPath(); g.moveTo(prev.X, prev.Y); g.lineTo(X, Y); g.stroke(); }
      prev = { X, Y, t: p.t, m: p.show };
    }
    g.restore();
    if (LH) this.drawLoudness(g, x, t0, t1, PH, LH, W);
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
    for (let m = mLo; m <= mHi; m++) if (rowH > 9 && y(m) < PH - 5 && (((m % 12) + 12) % 12 === 0 || rowH > 16) && ![1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12)) g.fillText(noteName(m), 4, y(m));
    // HUD
    const cur = this.playing ? this.current : null;
    if (cur && cur.midi !== null) {
      const c = cur.c;
      const o = cur.oct || 0;
      // Singing a whole octave off (not octave-free): say that, not "+1200¢ aim lower"
      const offOct = !s.octaveFree && o !== 0 && c !== null;
      const cc = offOct ? c - 1200 * o : c;
      const word = cc === null ? '' : Math.abs(cc) <= s.greenCents ? 'on it' : cc > 0 ? 'aim lower' : 'aim higher';
      const octWord = o === 0 ? '' : `${Math.abs(o) === 1 ? 'an octave' : Math.abs(o) + ' octaves'} ${o > 0 ? 'above' : 'below'} the line`;
      const line2 = cc === null ? octWord
        : offOct ? `${octWord} · ${word} · tick Any octave counts or change Sing it`
        : `${(cc > 0 ? '+' : '') + Math.round(cc)}¢ · ${word}${octWord ? ' · ' + octWord : ''}`;
      this.hud.innerHTML = `<div class="big">${noteName(cur.midi)}</div><div class="dim small">${line2}</div>`;
    } else this.hud.innerHTML = `<div class="dim small">${fmtTime(Math.max(0, now))}</div>`;
  }

  // Loudness band: the singer's loudness from the song (grey, filled) and yours (line), each 0–1
  // against its own loud passages over the bottom LH px. Shapes are what to compare: swells, fades,
  // where the singer leans in. Not absolute levels: your mic and the recording aren't comparable.
  drawLoudness(g, x, t0, t1, top, LH, W) {
    const span = 36, pad = 3, base = top + LH - pad, h = LH - 2 * pad - 10;
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, top, W, LH);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, top, W, 1);
    g.fillStyle = 'rgba(200,205,220,0.55)'; g.font = '10px system-ui'; g.textBaseline = 'top';
    g.fillText('loudness', 4, top + 2);
    g.font = '11px system-ui'; g.textBaseline = 'middle';
    const tg = this.target;
    if (tg.loud?.length) {
      const hop = tg.loud_hop || 0.05;
      const i0 = Math.max(0, Math.floor(t0 / hop)), i1 = Math.min(tg.loud.length - 1, Math.ceil(t1 / hop));
      g.fillStyle = 'rgba(160,170,200,0.28)'; g.beginPath(); g.moveTo(x(i0 * hop), base);
      for (let i = i0; i <= i1; i++) g.lineTo(x(i * hop), base - h * tg.loud[i] / 100);
      g.lineTo(x(i1 * hop), base); g.closePath(); g.fill();
    }
    const ref = this.loudPeak ?? loudRef();
    g.strokeStyle = css('--accent'); g.lineWidth = 2; g.lineJoin = 'round';
    let pen = false, last = -1;
    g.beginPath();
    for (const p of this.trail) {
      if (p.t < t0 - 0.1 || p.ld == null) { pen = false; continue; }
      const v = clamp((p.ld - (ref - span)) / span, 0, 1);
      const X = x(p.t), Y = base - h * v;
      if (v <= 0 || p.t - last > 0.05) pen = false;
      pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = v > 0; last = p.t;
    }
    g.stroke();
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
    else if (this.current?.midi != null) centre = this.current.midi - 12 * (this.oct || 0);   // gap in the melody: keep near your voice, in the notes' octave
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

// Loudness band on the melody view: on unless switched off (song page checkbox), per device.
function showLoudness() { try { return localStorage.getItem('vl-showLoud') !== '0'; } catch { return true; } }
// How loud your loud singing is on this mic, in dB full scale (98th percentile of your last run).
function loudRef() { const v = parseFloat(localStorage.getItem('vl-loud-peak')); return Number.isFinite(v) ? v : -20; }

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

// ---------------------------------------------------------------- coach on the results screen
/* After a lesson attempt or a song run, the numbers the grader already worked out (never audio)
 * go to POST /api/session, the same route the /coach page uses, and the reply shows under the
 * score. Any failure removes the panel: a missing coach never gets in the way of practising.
 * Off with Settings → "Coach on results", or when the server has no coach key. */
let COACH_STATUS = null;
async function coachReady() {
  try {
    const s = await settings();
    if (s.coachInline === false) return false;
    COACH_STATUS ||= api('/api/coach/status').catch(() => ({ configured: false }));
    return !!(await COACH_STATUS).configured;
  } catch { return false; }
}

/* The coach fields from a graded run. res = Practice.stop() result; P = the Practice (for the
 * pitch trail). A note counts as missed below the same 75% the results card calls "landed". */
function coachRunFields(res, P) {
  const notes = (res?.notes || []).filter(n => n.midi != null);
  const dir = b => b == null ? 'not heard' : b <= -15 ? 'flat' : b >= 15 ? 'sharp' : 'late or unsteady';
  const missedMap = new Map();
  for (const n of notes.filter(n => n.score < 0.75)) {
    const k = noteName(n.midi) + '|' + dir(n.bias);
    missedMap.set(k, (missedMap.get(k) || 0) + 1);
  }
  const missedNotes = [...missedMap].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, count]) => { const [note, direction] = k.split('|'); return { note, direction, count }; });
  const flat = notes.filter(n => n.bias != null && n.bias <= -10).length;
  const sharp = notes.filter(n => n.bias != null && n.bias >= 10).length;
  const b = res?.bias;
  const tendency = b == null ? undefined
    : b <= -8 && flat >= 2 * sharp ? 'flat' : b >= 8 && sharp >= 2 * flat ? 'sharp'
    : flat + sharp < notes.length * 0.3 ? 'centred' : 'mixed';
  const weakestNotes = [...new Set([...notes].sort((x, y) => x.score - y.score).slice(0, 5).map(n => noteName(n.midi)))].slice(0, 3);
  const sung = (P?.trail || []).filter(f => f.midi != null).map(f => f.midi).sort((x, y) => x - y);
  const detectedRange = sung.length >= 50
    ? { low: noteName(sung[Math.floor(sung.length * 0.05)]), high: noteName(sung[Math.floor(sung.length * 0.95)]) } : undefined;
  const targetNotes = [...new Set([...notes].sort((x, y) => x.midi - y.midi).map(n => noteName(n.midi)))].slice(0, 24);
  const landed = notes.filter(n => n.score >= 0.75).length;
  const lines = [`${landed}/${notes.length} notes landed (75%+ grade)`];
  if (b != null) lines.push(`average ${b > 0 ? '+' : ''}${Math.round(b)} cents`);
  if (res?.speed && res.speed !== 100) lines.push(`song slowed to ${res.speed}%`);
  if (res?.timingOffset && Math.abs(res.timingOffset) >= 0.06) lines.push(`timing about ${Math.round(Math.abs(res.timingOffset) * 1000)} ms ${res.timingOffset > 0 ? 'late' : 'early'}`);
  return {
    pitchAccuracy: res?.score != null ? Math.round(res.score * 10) / 10 : undefined,
    detectedRange, missedNotes, tendency, weakestNotes, targetNotes,
    details: 'Score is the app’s grade per note (70% holding within the green/amber cents window, 15% clean start, 15% transition), weighted by note length. ' + lines.join('; ') + '.',
    sungSeconds: sung.length / 100,
  };
}

/* The coach's lesson pick as a small block: a button to the lesson, or a note to try this one again. */
function coachSuggestion(sug, currentLessonId) {
  if (!sug?.lessonId) return null;
  const d = document.createElement('div');
  d.className = 'coach-next';
  const same = sug.lessonId === currentLessonId;
  d.innerHTML = same
    ? `<span class="pill">Coach suggests</span> <span class="small">Give this lesson another go${sug.reason ? `: ${esc(sug.reason)}` : '.'}</span>`
    : `<a class="btn primary" href="#/lesson/${esc(sug.lessonId)}">Next: ${esc(sug.lessonId)} ${esc(sug.title)} ▸</a>${sug.reason ? `<span class="dim small">${esc(sug.reason)}</span>` : ''}`;
  return d;
}

/* Adds a coach panel to host and asks /api/session. body = the /api/session fields.
 * Doesn't scroll or take focus. A follow-up question goes to /api/coach/chat, which carries
 * the same conversation the /coach page shows. */
async function coachPanel(host, body) {
  if (!host || !(await coachReady())) return;
  const box = document.createElement('div');
  box.className = 'coach-inline';
  box.innerHTML = '<span class="coach-who">Coach</span><p class="coach-reply dim">Coach is thinking…</p>';
  host.appendChild(box);
  const reply = box.querySelector('.coach-reply');
  try {
    const r = await api('/api/session', { method: 'POST', json: body });
    if (!box.isConnected) return;
    reply.textContent = r.reply; reply.classList.remove('dim');
    const sugEl = coachSuggestion(r.suggestion, body.lessonId);
    if (sugEl) box.appendChild(sugEl);
    if (r.notesAdded?.length) {
      const n = document.createElement('p'); n.className = 'small dim';
      n.textContent = r.notesAdded.map(x => `📝 Remembered: ${x.note}`).join(' · ');
      box.appendChild(n);
    }
    const f = document.createElement('form');
    f.className = 'row coach-ask';
    f.innerHTML = '<input type="text" class="grow" maxlength="2000" placeholder="Ask the coach about this…" aria-label="Ask the coach"><button>Ask</button>';
    f.onsubmit = async e => {
      e.preventDefault();
      const input = f.querySelector('input'), q = input.value.trim();
      if (!q) return;
      input.value = ''; f.querySelector('button').disabled = true;
      const a = document.createElement('p'); a.className = 'coach-reply dim'; a.textContent = 'Coach is thinking…';
      const qp = document.createElement('p'); qp.className = 'coach-q small'; qp.textContent = q;
      box.insertBefore(qp, f); box.insertBefore(a, f);
      try {
        const r2 = await api('/api/coach/chat', { method: 'POST', json: { message: q } });
        a.textContent = r2.reply; a.classList.remove('dim');
        const s2 = coachSuggestion(r2.suggestion, body.lessonId);
        if (s2) box.insertBefore(s2, f);
      }
      catch { qp.remove(); a.remove(); }
      f.querySelector('button').disabled = false;
    };
    box.appendChild(f);
  } catch { box.remove(); }
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
      <div class="small" style="margin-top:10px">Not sure what to sing? <a href="#/find">Find songs that suit your range →</a></div>
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
        <span class="grow small">${old.length === 1 ? '1 song was' : `${old.length} songs were`} worked out with an older melody finder. The new one splits the tune into one note per sung syllable and adds the singer's loudness line. Songs from the last few days only redo the melody (about a minute each); older ones are split again too. Lyrics, scores and a key you set yourself are kept.</span>
        <button data-reall>Re-analyse ${old.length === 1 ? 'it' : 'all'}</button>
      </div>` : '';
    const noBack = songs.filter(x => x.no_backing && x.status === 'ready');
    if (!old.length && noBack.length) $('#outdated').innerHTML = `
      <div class="card row">
        <span class="grow small">${noBack.length === 1 ? '1 song has' : `${noBack.length} songs have`} the backing vocals mixed into the music. Re-analyse to give them their own volume slider (a few minutes per song; lyrics, scores and your key are kept).</span>
        <button data-split>Split ${noBack.length === 1 ? 'it' : 'them'}</button>
      </div>`;
    const noLook = songs.filter(x => x.no_lookup && x.status === 'ready');
    if (!old.length && !noBack.length && noLook.length) $('#outdated').innerHTML = `
      <div class="card row">
        <span class="grow small">Melody notes can now come from karaoke and rhythm-game charts, which people wrote out note by note. ${noLook.length === 1 ? '1 song hasn’t' : `${noLook.length} songs haven’t`} been looked up yet (under a minute each, nothing else changes).</span>
        <button data-look>Look up ${noLook.length === 1 ? 'it' : 'all'}</button>
      </div>`;
    const look = $('#outdated [data-look]');
    if (look) look.onclick = async () => {
      look.disabled = true;
      try { await api('/api/songs/note-sources/all', { method: 'POST' }); } catch (err) { toast(err.message); }
      refresh();
    };
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

// ---- find songs: a researched list of songs, filtered by your saved range, easy ones first
const DIFF_ORDER = { easy: 0, medium: 1, hard: 2 };
const FIT_ORDER = { fits: 0, key: 1, stretch: 2, out: 3 };
route(/^\/find$/, async () => {
  const data = await api('/api/songbook');
  const [lo, hi] = data.range;
  let level = sessionStorage.getItem('vl-find-level') || 'all';
  view.innerHTML = `
    <h1>Find songs</h1>
    <div class="card">
      <div class="row"><span class="grow">Songs whose melody sits inside your range, <b>${noteName(lo)}–${noteName(hi)}</b>. Start with the easy ones; move up a level once they score well. Each one comes as a part to learn (a verse and chorus, about a minute), or add the whole song.</span>
        <a class="btn" href="#/range">Change range</a></div>
      <div class="small dim" style="margin-top:8px" id="startHere"></div>
    </div>
    <div class="row seg" id="levels" role="tablist">
      ${['all', 'easy', 'medium', 'hard'].map(l => `<button data-l="${l}" role="tab">${l[0].toUpperCase() + l.slice(1)}</button>`).join('')}
    </div>
    <div id="list" class="songs"></div>
    <details class="card" id="stretchBox"><summary></summary><div class="songs" id="stretch" style="margin-top:10px"></div></details>
    <div class="card small dim" id="about"></div>`;
  const shiftText = r => r.shift === 0 ? 'Fits your range as it is'
    : `Fits with the music ${Math.abs(r.shift)} semitone${Math.abs(r.shift) > 1 ? 's' : ''} ${r.shift < 0 ? 'down' : 'up'} (set for you when you add it)`;
  const ratedLinks = r => r.rated.map(k => data.sources[k] ? `<a href="${esc(data.sources[k].url)}" target="_blank" rel="noopener">${esc(data.sources[k].name.split(':')[0])}</a>` : '').filter(Boolean).join(', ');
  const card = r => `
    <div class="card song find" data-id="${esc(r.id)}">
      <div class="grow">
        <div class="title">${esc(r.title)} <span class="dim" style="font-weight:400">· ${esc(r.artist)}</span></div>
        <div class="small"><span class="lvl ${r.difficulty}">${r.difficulty}</span>
          <span class="dim">${noteName(r.low)}–${noteName(r.high)} · ${r.fit === 'stretch' || r.fit === 'out' ? `${r.outside} semitone${r.outside > 1 ? 's' : ''} outside your range${r.shift ? ` even ${Math.abs(r.shift)} ${r.shift < 0 ? 'down' : 'up'}` : ''}` : shiftText(r)}</span></div>
        ${r.part && !r.song_id ? `<div class="small dim">Part to learn: ${esc(r.part.label.toLowerCase())}, about ${fmtTime(partLen(r))}${r.duration ? ` of ${fmtTime(r.duration)}` : ''}</div>` : ''}
        <div class="small" style="margin-top:4px">${esc(r.why)}${r.rated.length ? ` <span class="dim">Recommended by ${ratedLinks(r)}.</span>` : ''}</div>
      </div>
      <div class="actions">
        <a class="btn" href="https://www.youtube.com/watch?v=${esc(r.yt)}" target="_blank" rel="noopener" title="Listen on YouTube">▶ YouTube</a>
        ${r.song_id ? (r.status === 'ready' ? `<a class="btn primary" href="#/song/${r.song_id}">Sing</a>` : `<a class="pill ${esc(r.status)}" href="#/">${r.status === 'error' ? 'error, see Songs' : 'added · processing'}</a>`)
          : r.part ? `<button class="primary" data-add title="${esc(r.part.label)}">Add part (${fmtTime(partLen(r))})</button><button data-add="whole" title="The whole track${r.duration ? `, ${fmtTime(r.duration)}` : ''}">Whole song</button>`
          : `<button class="primary" data-add>Add to my songs</button>`}
      </div>
    </div>`;
  const partLen = r => Math.round(r.part.end - r.part.start + 5);   // plus the lead-in and tail the server keeps
  const sortKey = r => [DIFF_ORDER[r.difficulty], FIT_ORDER[r.fit], Math.abs(r.shift), r.high - r.low];
  const cmp = (a, b) => { const x = sortKey(a), y = sortKey(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.title.localeCompare(b.title); };
  function draw() {
    $('#levels').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.l === level));
    const pick = r => level === 'all' || r.difficulty === level;
    const inside = data.songs.filter(r => (r.fit === 'fits' || r.fit === 'key') && pick(r)).sort(cmp);
    const near = data.songs.filter(r => r.fit === 'stretch' && pick(r)).sort(cmp);
    $('#list').innerHTML = inside.length ? inside.map(card).join('') : `<p class="dim">Nothing at this level fits ${noteName(lo)}–${noteName(hi)} yet. Check the songs just outside your range below, or widen your range on the Range page.</p>`;
    $('#stretchBox').hidden = !near.length;
    $('#stretchBox summary').textContent = `Just outside your range (${near.length}): try these as your range grows`;
    $('#stretch').innerHTML = near.map(card).join('');
    const first = data.songs.filter(r => r.difficulty === 'easy' && r.fit === 'fits' && !r.song_id).sort(cmp)[0]
      || data.songs.filter(r => r.difficulty === 'easy' && r.fit === 'key' && !r.song_id).sort(cmp)[0];
    $('#startHere').innerHTML = first ? `Start here: <b>${esc(first.title)}</b> by ${esc(first.artist)} (${esc(first.why.split(';')[0].replace(/\.$/, ''))}).` : '';
  }
  $('#about').innerHTML = `<b>How the levels are set.</b> ${Object.entries(data.levels).map(([k, v]) => `<span class="lvl ${k}">${k}</span> ${esc(v)}`).join(' ')}
    <p>${esc(data.note)} Each song's difficulty is our rating from its range, tempo and phrasing, checked against these lists: ${Object.values(data.sources).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' · ')}.
    Music shifted more than ${data.max_shift} semitones starts to sound odd, so songs that would need more are left out.</p>`;
  $('#levels').onclick = e => { const b = e.target.closest('button'); if (!b) return; level = b.dataset.l; try { sessionStorage.setItem('vl-find-level', level); } catch { /* ignore */ } draw(); };
  view.onclick = async e => {
    const btn = e.target.closest('[data-add]'); if (!btn) return;
    const id = btn.closest('.find').dataset.id, r = data.songs.find(x => x.id === id);
    const whole = btn.dataset.add === 'whole', label = btn.textContent;
    btn.closest('.actions').querySelectorAll('[data-add]').forEach(b => { b.disabled = true; }); btn.textContent = 'Adding…';
    try {
      const song = await api(`/api/songbook/${encodeURIComponent(id)}/add`, { method: 'POST', json: { whole } });
      if (song.suggested_tr) setSongPref(song.id, 'tr', String(song.suggested_tr));
      r.song_id = song.id; r.status = song.status;
      toast(song.existing ? 'Already in your songs' : `Added. It takes a few minutes to split the vocals; it’ll show on Songs.`);
    } catch (err) { toast(err.message); btn.closest('.actions').querySelectorAll('[data-add]').forEach(b => { b.disabled = false; }); btn.textContent = label; return; }
    draw();
  };
  draw();
  cleanup = () => { view.onclick = null; };
}, 'find');

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

// ---- charted notes: melody notes from karaoke / rhythm-game charts instead of the detected ones
const NOTE_SRC = { allkaraoke: 'AllKaraoke', usdb: 'USDB', encore: 'Encore', hooktheory: 'Hooktheory', st500: 'MIR-ST500', midi: 'BitMidi', detected: 'Detected' };
const pct = x => `${Math.round((x || 0) * 100)}%`;
function noteSourceLine(an) {
  const ns = an.note_source;
  if (!ns) return `Melody notes: <b>detected from the singer</b> <button data-notesrc>Charts…</button>`;
  const kind = ns.source === 'encore' ? 'rhythm-game chart' : ns.source === 'midi' ? 'MIDI file' : ns.source === 'hooktheory' ? 'TheoryTab sections' : ns.source === 'st500' ? 'hand-labelled notes' : 'karaoke chart';
  return `Melody notes: <b>${esc(NOTE_SRC[ns.source] || ns.source)} ${kind}</b>${ns.by ? ` by ${esc(ns.by)}` : ''}${ns.mode === 'merge' ? ' (the parts it covers; detected notes elsewhere)' : ''}, ${pct(ns.metrics?.precision)} on the singer's pitch <button data-notesrc>Charts…</button>`;
}
async function noteSourcePicker(id, an) {
  const m = modal(`<h2 style="margin-top:0">Where the melody notes come from</h2><div id="nsBody"><p class="dim">Loading…</p></div>`);
  let info;
  try { info = await api(`/api/songs/${id}/note-sources`); } catch (e) { m.querySelector('#nsBody').innerHTML = `<p>${esc(e.message)}</p>`; return; }
  const verdict = c => c.verdict === 'use' ? '<span class="pill ready">lines up</span>'
    : c.verdict === 'merge' ? '<span class="pill">fills in parts</span>' : '<span class="pill error">doesn’t line up</span>';
  const stats = mt => mt ? `${pct(mt.precision)} on pitch · ${pct(mt.on_voice)} where the singer sings · covers ${pct(mt.coverage)} of the singing` : 'couldn’t be lined up';
  const row = (key, title, sub, mt, badge) => `<label class="ns-row"><input type="radio" name="ns" value="${esc(key)}" ${info.current === key ? 'checked' : ''}>
      <span><b>${title}</b> ${badge || ''}<br><span class="dim small">${sub ? sub + '<br>' : ''}${stats(mt)}</span></span></label>`;
  const off = Object.entries(info.errors || {}).map(([k, v]) => `${NOTE_SRC[k] || k}: ${esc(v)}`);
  const body = !info.looked ? `<p>This song hasn’t been looked up in the chart sources yet.</p>` : `
    <p class="dim small" style="margin-top:0">Charts are written out by people, note by note, for karaoke and rhythm games. One is used when its notes sit on the singer’s pitch line in this recording. The detected notes are made from that pitch line, so they always match it; what they miss is how much of the singing they cover and where one note should end and the next begin.</p>
    ${row('detected', 'Detected from the singer', 'The app’s own melody finder (GAME + SwiftF0)', info.detected_metrics)}
    ${info.candidates.map(c => row(c.key, `${esc(NOTE_SRC[c.source] || c.source)}: ${esc(c.title)}`,
      `${c.by ? 'by ' + esc(c.by) + ' · ' : ''}${c.count} notes${c.same_video ? ' · timed to this same video' : ''}${c.scale && Math.abs(c.scale - 1) > 0.001 ? ` · tempo ×${c.scale.toFixed(3)}` : ''}${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener">source</a>` : ''}`,
      c.metrics, verdict(c))).join('')}
    ${info.candidates.length ? '' : '<p class="dim small">No charts found for this song.</p>'}
    <p class="dim small">Searched ${info.query?.hyps?.map(h => esc(h.filter(Boolean).join(' – '))).join(', ') || 'nothing'}${info.at ? ' on ' + new Date(info.at * 1000).toLocaleDateString() : ''}.${off.length ? ' Not searched: ' + off.join('; ') + '.' : ''}</p>`;
  m.querySelector('#nsBody').innerHTML = `${body}
    ${info.edited ? '<p class="small">Choosing a source replaces your hand edits to the notes.</p>' : ''}
    <div class="row" style="gap:.5em;flex-wrap:wrap;margin-top:.8em">
      ${info.looked ? '<button class="primary" id="nsUse">Use selected</button><button id="nsAuto">Pick automatically</button>' : ''}
      <button id="nsAgain">${info.looked ? 'Search again' : 'Search now'}</button>
      <button id="nsClose">Close</button>
    </div>`;
  const done = () => { m.remove(); location.reload(); };
  const choose = async key => {
    if (info.edited && !confirm('Replace your hand-edited notes?')) return;
    try { await api(`/api/songs/${id}/note-sources/choose`, { method: 'POST', json: { key } }); done(); } catch (e) { toast(e.message); }
  };
  m.querySelector('#nsClose').onclick = () => m.remove();
  m.querySelector('#nsUse') && (m.querySelector('#nsUse').onclick = () => { const v = m.querySelector('input[name=ns]:checked'); if (v) choose(v.value); });
  m.querySelector('#nsAuto') && (m.querySelector('#nsAuto').onclick = () => choose(null));
  m.querySelector('#nsAgain').onclick = async () => {
    try { await api(`/api/songs/${id}/note-sources/refresh`, { method: 'POST' }); m.remove(); toast('Searching the chart sources…'); location.hash = '#/'; } catch (e) { toast(e.message); }
  };
}

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
    if (p && syncing) { syncLine = +p.dataset.i; drawSync(); return; }
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
  // ---- sync by tapping: pick a line (the first sung one by default), play, tap "Now" as it starts.
  // Every line moves by the same amount, so one good tap fixes the whole song.
  let syncing = false, syncLine = 0;
  const firstLine = () => Math.max(0, L.lines.findIndex(l => l.t0 !== null && l.text.trim()));
  function drawSync() {
    const bar = $('#lyrSyncBar');
    bar.hidden = !syncing;
    if (!syncing) return;
    const l = L.lines[syncLine];
    bar.innerHTML = `<div class="small dim">Press ▶ Sing, then tap <b>Now</b> the moment this line starts. Tap a different line below to sync on that one instead.</div>
      <div class="row lyr-sync-row">
        <button data-s="prev" aria-label="Earlier line">‹</button>
        <span class="grow lyr-sync-line">“${esc(l?.text || '')}”</span>
        <button data-s="next" aria-label="Later line">›</button>
      </div>
      <div class="row"><button class="primary" data-s="now">Now</button><span class="dim small grow" id="syncMsg"></span><button data-s="done">Done</button></div>`;
  }
  $('#lyrSyncBar').addEventListener('click', e => {
    const b = e.target.closest('[data-s]'); if (!b || !L) return;
    const a = b.dataset.s;
    if (a === 'prev') { syncLine = Math.max(0, syncLine - 1); drawSync(); }
    if (a === 'next') { syncLine = Math.min(L.lines.length - 1, syncLine + 1); drawSync(); }
    if (a === 'done') { syncing = false; drawSync(); }
    if (a === 'now') {
      if (!P.playing) { $('#syncMsg').textContent = 'Press ▶ Sing first, then tap Now when the line starts.'; return; }
      // What you hear lags the playhead by the headphone delay; people tap ~0.2 s after they hear it.
      const heard = P.now() - ((P.latency || 0) + 0.2) * (P.rate || 1);
      L.offset = Math.round((heard - L.lines[syncLine].t0) * 10) / 10;
      render(); drawSync();
      $('#syncMsg').textContent = `Lyrics moved to ${L.offset > 0 ? '+' : ''}${L.offset.toFixed(1)} s. Tap again to redo, or fine-tune with − and +.`;
      api(`/api/songs/${id}/lyrics`, { method: 'PUT', json: { offset: L.offset } }).catch(e => toast(e.message));
    }
  });
  $('#lyrSync').onclick = () => {
    if (!L?.synced) return;
    syncing = !syncing;
    if (syncing) syncLine = firstLine();
    drawSync();
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
  const mmss = t => t ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : '?';
  function findDialog() {
    const a = L?.match?.artist || guess.artist || '', t = L?.match?.track || guess.track || '';
    const m = modal(`<h2 style="margin-top:0">Find lyrics</h2>
      <div style="display:grid;gap:8px">
        <label class="dim small">Artist <input type="text" id="fArtist" value="${esc(a)}" style="width:100%"></label>
        <label class="dim small">Song <input type="text" id="fTrack" value="${esc(t)}" style="width:100%"></label>
      </div>
      <div class="row" style="margin-top:8px"><button class="primary" id="fGo">Search LRCLIB</button>
        ${groq ? '<button id="fGroq">Transcribe the vocal instead</button>' : ''}<button id="fCancel">Cancel</button></div>
      <p class="small dim" id="fMsg">${L?.edited ? 'Choosing new lyrics replaces your edited ones.' : ''}</p>
      <div id="fList" class="lyr-results"></div>`);
    const msg = m.querySelector('#fMsg'), list = m.querySelector('#fList');
    m.querySelector('#fCancel').onclick = () => m.remove();
    async function search(useFields) {
      const btn = m.querySelector('#fGo'); btn.disabled = true; msg.textContent = 'Searching LRCLIB…'; list.innerHTML = '';
      const q = useFields ? `?artist=${encodeURIComponent(m.querySelector('#fArtist').value.trim())}&track=${encodeURIComponent(m.querySelector('#fTrack').value.trim())}` : '';
      try {
        const r = await api(`/api/songs/${id}/lyrics/search${q}`);
        msg.textContent = r.results.length
          ? `Your video is ${mmss(r.video_duration)}. Pick the version whose words match; a different length is fine (sync it with ⏱ afterwards).`
          : 'Nothing on LRCLIB for that. Try fewer words, or check the spelling.';
        list.innerHTML = r.results.map(x => `<button class="lyr-result" data-id="${x.id}">
          <b>${esc(x.track || '')}</b> <span class="dim">· ${esc(x.artist || '')}</span>
          <span class="small dim">${x.album ? esc(x.album) + ' · ' : ''}${mmss(x.duration)} · ${x.synced ? 'timed' : 'words only'}${x.id === L?.match?.id ? ' · current' : ''}</span>
          ${x.first ? `<span class="small">“${esc(x.first)}”</span>` : ''}</button>`).join('');
      } catch (e) { msg.textContent = e.message; }
      btn.disabled = false;
    }
    list.onclick = async e => {
      const b = e.target.closest('[data-id]'); if (!b) return;
      list.querySelectorAll('button').forEach(x => x.disabled = true); msg.textContent = 'Loading those lyrics…';
      try {
        L = (await api(`/api/songs/${id}/lyrics/choose`, { method: 'POST', json: { id: +b.dataset.id } })).lyrics;
        render(); m.remove();
        if (L.synced) { syncing = true; syncLine = firstLine(); drawSync(); }   // straight into syncing
      } catch (err) { msg.textContent = err.message; list.querySelectorAll('button').forEach(x => x.disabled = false); }
    };
    m.querySelector('#fGo').onclick = () => search(true);
    m.querySelector('#fGroq')?.addEventListener('click', async () => {
      msg.textContent = 'Transcribing (can take up to a minute)…';
      try { L = (await api(`/api/songs/${id}/lyrics`, { method: 'POST', json: { source: 'groq' } })).lyrics; render(); m.remove(); }
      catch (err) { msg.textContent = err.message; }
    });
    search(false);   // start with the automatic guesses (title, channel, both name orders)
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
  let tr = Number(songPref(id, 'tr', String(song.suggested_tr || 0))) || 0;   // songbook picks come with a key that fits your range
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
          <button id="lyrSync" title="Sync: tap when a line starts" aria-label="Sync lyrics by tapping">⏱</button>
        </span>
        <button id="lyrEdit" title="Edit lyrics" aria-label="Edit lyrics">✎</button>
        <button id="lyrFind" title="Find lyrics again" aria-label="Find lyrics again">↻</button>
      </div>
      <div class="lyr-sync" id="lyrSyncBar" hidden></div>
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
      <label><input type="checkbox" id="showLoud" ${showLoudness() ? 'checked' : ''}> Show loudness</label>
      <label><input type="checkbox" id="showLyr" ${songPref('all', 'lyrics', '1') === '1' ? 'checked' : ''}> Show lyrics</label>
    </div>
    <div class="legend small"><span><i style="background:var(--green)"></i>within ${s.greenCents}¢</span><span><i style="background:var(--amber)"></i>within ${s.amberCents}¢</span><span><i style="background:var(--red)"></i>off</span><span>Drag the track to move around when stopped. Headphones work best.</span></div>
    <p class="small" id="noteSrc">${noteSourceLine(an)}</p>
    <p class="dim small">Wrong notes, or the guide vocal singing a backing part? <a href="#/song/${id}/edit">Fix them in the editor</a>${an.notes_edited || an.vocal_fixes?.length ? ' (this song has your fixes in it)' : ''}.</p>
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
  $('#showLoud').onchange = e => { try { localStorage.setItem('vl-showLoud', e.target.checked ? '1' : '0'); } catch { /* ignore */ } };

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
      // the editor can rebuild the vocals; a new revision means new addresses, so no stale copies
      urls = Object.fromEntries(Object.entries(urls).map(([k, u]) => [k, u && `${u}?r=${an.audio_rev || 0}`]));
      const [accomp, backing, vocals] = await Promise.all([loadBuffer(urls.band || urls.accompaniment),
        urls.band && urls.backing ? loadBuffer(urls.backing) : null, loadBuffer(urls.vocals)]);
      if (mine !== audioReq || !$('#loadmsg')) return;     // left the page while it loaded
      P.audio.buffers = { accomp, backing, vocals };
      P.audio.rate = speed / 100;
      $('#loadmsg').textContent = ''; $('#play').disabled = false;
    } catch (e) { if (mine === audioReq && $('#loadmsg')) $('#loadmsg').textContent = 'Audio failed to load: ' + e.message; }
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
  $('#noteSrc').onclick = e => { if (e.target.closest('[data-notesrc]')) noteSourcePicker(id, an); };
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
    // Coach: only for a real attempt (graded notes and at least ~5 s of singing).
    if (res.score !== null && res.notes.length >= 4) {
      const cf = coachRunFields(res, P);
      if (cf.sungSeconds >= 5) {
        const { sungSeconds, ...fields } = cf;
        coachPanel($('#res'), {
          exerciseType: 'youtube_run', songId: id, lessonId: lessonId || undefined,
          title: song.title + (part !== 'melody' ? ` (${PARTS[part].label})` : ''), ...fields,
        });
      }
    }
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
  // Sung-word drills after Lew Lepton's piano tracks (github.com/miseenbutt/vocaltraining). Only the note patterns,
  // rhythms and tempos are taken; the originals stay on the white keys as the root climbs, so their pattern changes
  // mode on every repeat. Here it is moved whole, so every repeat is the same major pattern.
  // beats = length of each note in beats (beat = seconds per beat); a null pitch is a rest.
  doremi:   { name: 'Do re mi scale', desc: 'do re mi fa sol la ti do, and back down',
              pattern: [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0], beat: 0.75,
              words: 'do re mi fa sol la ti do ti la sol fa mi re do'.split(' ') },
  ladder:   { name: 'Do re mi ladder', desc: 'do re do, do re mi re do … up to the top do and back. One key, the middle of your range',
              ladder: true, once: true, beat: 0.75 },
  likesing: { name: 'I like to sing', desc: 'I like to sing, like to sing, like to sing · I like to sing, like to sing',
              pattern: [0, 2, 4, 5, 4, 2, 0, 2, 4, 5, null, 2, 4, 5, 7, 5, 4, 2],
              beats:   [1, .5, .5, 1, .5, .5, 1, .5, .5, 1, 1, 1, .5, .5, 1, .5, .5, 3], beat: 60 / 145,
              words: ['I', 'like', 'to', 'sing', 'like', 'to', 'sing', 'like', 'to', 'sing', null, 'I', 'like', 'to', 'sing', 'like', 'to', 'sing'] },
  memaw:    { name: 'Me my maw', desc: 'me ×8 (five notes up and down) · my ×4 · maw ×9',
              pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0, 2, 4, 5, 0, 2, 4, 5, 7, 5, 4, 2, 0],
              beats:   [.5, .5, .5, .5, .5, .5, .5, .5, 1, 1, 1, 1, .5, .5, .5, .5, .5, .5, .5, .5, 2], beat: 60 / 140,
              words: [...Array(8).fill('me'), ...Array(4).fill('my'), ...Array(9).fill('maw')] },
};
// Ladder: each rung climbs one scale step higher than the last, then the rungs shrink again.
(function () {
  const sc = [0, 2, 4, 5, 7, 9, 11, 12], sol = 'do re mi fa sol la ti do'.split(' ');
  const pattern = [], words = [];
  const rung = k => { for (let i = 0; i <= k; i++) { pattern.push(sc[i]); words.push(sol[i]); }
    for (let i = k - 1; i >= 0; i--) { pattern.push(sc[i]); words.push(sol[i]); } };
  for (let k = 1; k <= 7; k++) rung(k);
  for (let k = 6; k >= 1; k--) rung(k);
  Object.assign(DRILLS.ladder, { pattern, words });
})();
const SERIES = {
  quick: { name: 'Quick warm-up', drills: ['sustain', 'scale5', 'arpeggio'] },
  full:  { name: 'Full warm-up', drills: ['sustain', 'scale5', 'thirds', 'arpeggio', 'octave', 'ninescale'] },
  words: { name: 'Sung-word warm-up', drills: ['memaw', 'likesing', 'doremi'] },
};

function buildDrill(keys, s, tempo = 1, down = true, o = {}) {
  const notes = [], cues = [];
  let t = 0.6;
  for (const k of keys) {
    const d = DRILLS[k], span = Math.max(...d.pattern), beat = d.beat / tempo;
    const roots = [];
    const lowest = o.topHalf ? Math.max(s.rangeLow, Math.round((s.rangeLow + s.rangeHigh) / 2) - 2) : s.rangeLow;
    if (d.once) roots.push(Math.max(s.rangeLow, Math.round((s.rangeLow + s.rangeHigh - span) / 2)));   // one key, centred
    else for (let r = lowest; r + span <= s.rangeHigh; r++) roots.push(r);
    if (!roots.length) roots.push(Math.max(s.rangeLow, s.rangeHigh - span));
    if (o.maxRoots && roots.length > o.maxRoots) {   // spread a few roots evenly through the range
      const pick = Array.from({ length: o.maxRoots }, (_, i) => roots[Math.round(i * (roots.length - 1) / (o.maxRoots - 1))]);
      roots.splice(0, roots.length, ...new Set(pick));
    }
    const seq = down && !d.once ? [...roots, ...roots.slice(0, -1).reverse()] : roots;
    // keep long lists manageable
    const step = seq.length > 14 ? 2 : 1;
    for (let i = 0; i < seq.length; i += step) {
      const r = seq[i];
      cues.push({ t0: t, t1: t + 0.7, midi: r });
      t += 0.9;
      d.pattern.forEach((iv, j) => {
        const len = beat * (d.beats?.[j] ?? 1);
        if (iv !== null) notes.push({ t0: t, t1: t + Math.min(len * 0.92, len - 0.04), midi: r + iv, label: d.words?.[j] ?? o.label });
        t += len;
      });
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
    <h2>Single drills</h2><div class="grid2">${Object.entries(DRILLS).map(([k, v]) => `<a class="card" href="#/drill/${k}"><b>${v.name}</b><div class="dim small">${v.desc ? esc(v.desc) : v.pattern.map(i => '+' + i).join(' ')}</div></a>`).join('')}</div>`;
}, 'drills');

route(/^\/drill\/(\w+)$/, async key => {
  const s = await settings();
  const keys = SERIES[key]?.drills || (DRILLS[key] ? [key] : null);
  if (!keys) throw new Error('Unknown drill');
  const title = SERIES[key]?.name || DRILLS[key].name;
  const sung = keys.filter(k => DRILLS[k].words);
  view.innerHTML = `<div class="row"><h1 class="grow">${esc(title)}</h1></div>
    ${sung.length ? `<p class="small dim">Sing the words: ${sung.map(k => `${keys.length > 1 ? `<b>${esc(DRILLS[k].name)}:</b> ` : ''}${esc(DRILLS[k].desc)}`).join('<br>')}</p>` : ''}
    <div class="stage" id="stage" style="height:min(52vh,440px)"></div>
    <div class="controls">
      <button class="primary" id="play">▶ Start</button>
      <label>Tempo <select id="tempo"><option value="0.6">Very slow</option><option value="0.8">Slow</option><option value="1" selected>Normal</option><option value="1.25">Fast</option></select></label>
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
    </div>
    <div class="card" id="vrp">
      <h2>Voice range profile</h2>
      <p class="dim small">Maps how softly and how loudly you can sing each note. Hold notes or sing slow sirens on "ah": once as quietly as you can without the sound cutting out, once as loud as is comfortable (full, not shouting). The bars fill in as you go: the bottom of each bar is your softest, the top your loudest. Levels come from this microphone, so compare profiles made with the same mic at the same distance.</p>
      <canvas id="vrpC" class="vrp"></canvas>
      <div class="row" style="margin-top:8px"><button class="primary" id="vrpGo">Start</button><button id="vrpClear">Clear</button>
        <button id="vrpSave" disabled>Save</button><button id="vrpRange" disabled>Use as my range</button></div>
      <p class="dim small" id="vrpInfo"></p>
      <div id="vrpList"></div>
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
  off.push(await voiceRangeProfile(s));
  cleanup = () => { off.forEach(f => f()); stopMic(); };
}, 'range');

// ---- voice range profile
/* For every semitone you sing: the softest and loudest level you held it at, in dB of the mic's full
 * scale. A level counts once the pitch has sat on that semitone (±50 cents) for 150 ms with the
 * level steady (within 6 dB), so note onsets and fades don't stretch the bars.
 * Idea from Hideki Kawahara's voiceRTFB "Valued Voice Range Profiler" (Apache-2.0); a clinical
 * phonetogram uses calibrated dB SPL at 30 cm, this one is relative to your microphone. */
const VRP_MIN_FRAMES = 5;     // steady windows (≈50 ms) before a note shows
async function voiceRangeProfile(s) {
  let saved = [];
  try { saved = await api('/api/vrp'); } catch { /* shown empty */ }
  let cur = {}, rec = false, buf = [], live = null, compare = saved.length ? saved.length - 1 : -1, unsub = null;
  const cv = $('#vrpC');
  const micLabel = () => (A.stream?.getAudioTracks()[0]?.label || '').replace(/\s*\(.*\)$/, '').slice(0, 60);
  const usable = bins => Object.entries(bins).filter(([, b]) => b[2] >= VRP_MIN_FRAMES).map(([m, b]) => [+m, b]);
  const summary = bins => {
    const u = usable(bins); if (!u.length) return '';
    const ms = u.map(e => e[0]), lo = Math.min(...ms), hi = Math.max(...ms);
    const wide = u.reduce((a, e) => e[1][1] - e[1][0] > a[1][1] - a[1][0] ? e : a);
    const med = u.map(e => e[1][1] - e[1][0]).sort((a, b) => a - b)[Math.floor(u.length / 2)];
    return `${noteName(lo)}–${noteName(hi)} · ${u.length} notes · soft-to-loud span ${Math.round(med)} dB on a typical note, widest ${Math.round(wide[1][1] - wide[1][0])} dB on ${noteName(wide[0])}`;
  };
  const short = bins => {
    const u = usable(bins); if (!u.length) return '';
    const ms = u.map(e => e[0]), med = u.map(e => e[1][1] - e[1][0]).sort((a, b) => a - b)[Math.floor(u.length / 2)];
    return `${noteName(Math.min(...ms))}–${noteName(Math.max(...ms))}, ${Math.round(med)} dB`;
  };
  function draw() {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const other = compare >= 0 && saved[compare] ? usable(saved[compare].bins) : [];
    const mine = usable(cur);
    const ms = [...mine, ...other].map(e => e[0]).concat([s.rangeLow, s.rangeHigh]);
    if (live) ms.push(Math.round(live.m));
    const mLo = Math.min(...ms) - 2, mHi = Math.max(...ms) + 2;
    const dbs = [...mine, ...other].flatMap(e => [e[1][0], e[1][1]]).concat(live ? [live.db] : []);
    const yTop = Math.min(0, Math.ceil((Math.max(-15, ...dbs) + 3) / 10) * 10);
    const yBot = Math.floor((Math.min(-50, ...dbs) - 3) / 10) * 10;
    const L = 40, B = 18, cw = (W - L - 4) / (mHi - mLo + 1);
    const x = m => L + (m - mLo) * cw, y = d => (H - B) * (yTop - d) / (yTop - yBot);
    g.font = '10px system-ui'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(200,205,220,0.6)';
    for (let d = yTop; d >= yBot; d -= 10) {
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(L, y(d), W - L, 1);
      g.fillStyle = 'rgba(200,205,220,0.6)'; g.fillText(`${d} dB`, 2, y(d));
    }
    g.textBaseline = 'top';
    for (let m = Math.ceil(mLo); m <= mHi; m++) {
      const pc = ((m % 12) + 12) % 12;
      if (pc === 0 || (cw > 22 && ![1, 3, 6, 8, 10].includes(pc))) {
        g.fillStyle = pc === 0 ? 'rgba(200,205,220,0.8)' : 'rgba(200,205,220,0.45)'; g.fillText(noteName(m), x(m), H - B + 4);
      }
    }
    // your saved range, faintly
    g.fillStyle = 'rgba(122,162,255,0.06)'; g.fillRect(x(s.rangeLow), 0, x(s.rangeHigh + 1) - x(s.rangeLow), H - B);
    g.strokeStyle = 'rgba(200,205,220,0.55)'; g.lineWidth = 1; g.setLineDash([3, 3]);
    for (const [m, b] of other) g.strokeRect(x(m) + 1.5, y(b[1]), cw - 3, Math.max(2, y(b[0]) - y(b[1])));
    g.setLineDash([]);
    g.fillStyle = css('--accent');
    for (const [m, b] of mine) { g.globalAlpha = 0.75; g.fillRect(x(m) + 3, y(b[1]), cw - 6, Math.max(2, y(b[0]) - y(b[1]))); }
    g.globalAlpha = 1;
    if (live) { g.fillStyle = '#fff'; g.beginPath(); g.arc(x(live.m) + cw / 2, y(live.db), 4, 0, 7); g.fill(); }
  }
  function info() {
    const t = summary(cur);
    const cmp = compare >= 0 && saved[compare] ? `Dashed: saved ${new Date(saved[compare].at).toLocaleDateString()}${saved[compare].mic ? ` (${esc(saved[compare].mic)})` : ''}.` : '';
    $('#vrpInfo').innerHTML = (t ? esc(t) + '. ' : rec ? 'Listening… ' : '') + cmp;
    $('#vrpSave').disabled = $('#vrpRange').disabled = usable(cur).length < 3;
  }
  function list() {
    $('#vrpList').innerHTML = saved.length ? `<p class="dim small" style="margin-bottom:4px">Saved profiles</p>` + saved.map((p, i) => `
      <div class="row small" style="margin:4px 0"><span class="grow">${new Date(p.at).toLocaleDateString()} · ${esc(short(p.bins))}${p.mic ? ` · <span class="dim">${esc(p.mic)}</span>` : ''}</span>
        <button data-cmp="${i}" ${i === compare ? 'class="on"' : ''}>${i === compare ? 'Comparing' : 'Compare'}</button><button data-del="${i}" aria-label="Delete">✕</button></div>`).reverse().join('') : '';
    $('#vrpList').querySelectorAll('[data-cmp]').forEach(b => b.onclick = () => { compare = +b.dataset.cmp === compare ? -1 : +b.dataset.cmp; list(); info(); draw(); });
    $('#vrpList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this saved profile?')) return;
      saved.splice(+b.dataset.del, 1); compare = Math.min(compare, saved.length - 1);
      try { await api('/api/vrp', { method: 'PUT', json: saved }); } catch (e) { toast(e.message); }
      list(); info(); draw();
    });
  }
  // Raw detector frames, not the mic filter's: that drops anything 20 dB under your recent loud
  // singing (it's tuned to keep breaths off the pitch line), which would cut off the soft end here.
  function onFrame(f) {
    if (!(f.hz > 55 && f.hz < 1400 && f.clarity >= 0.85 && f.rms > 0.001)) { buf = []; live = null; return; }
    const m = hzToMidi(f.hz), db = 20 * Math.log10(f.rms);
    live = { m: Math.round(m), db };
    buf.push({ m, db }); if (buf.length > 15) buf.shift();
    if (buf.length < 15) return;
    const n = Math.round(buf[0].m);
    if (!buf.every(b => Math.abs(b.m - n) <= 0.5)) return;
    const d = buf.map(b => b.db), spread = Math.max(...d) - Math.min(...d);
    if (spread > 6) return;
    const v = d.reduce((a, b) => a + b) / d.length;
    const b = cur[n] || (cur[n] = [v, v, 0]);
    b[0] = Math.min(b[0], v); b[1] = Math.max(b[1], v); b[2]++;
  }
  let raf = null, lastInfo = 0;
  const loop = t => { raf = requestAnimationFrame(loop); draw(); if (t - lastInfo > 500) { lastInfo = t; info(); } };
  $('#vrpGo').onclick = async () => {
    if (rec) {
      rec = false; unsub?.(); unsub = null; live = null; cancelAnimationFrame(raf); draw(); info();
      $('#vrpGo').textContent = 'Start'; return;
    }
    try { await startMic(); } catch (e) { return toast(e.message, 6000); }
    rec = true; unsub = onRawPitch(onFrame); raf = requestAnimationFrame(loop);
    $('#vrpGo').textContent = 'Stop';
  };
  $('#vrpClear').onclick = () => { cur = {}; draw(); info(); };
  $('#vrpSave').onclick = async () => {
    const bins = Object.fromEntries(usable(cur).map(([m, b]) => [m, [+b[0].toFixed(1), +b[1].toFixed(1), b[2]]]));
    saved.push({ at: Date.now(), mic: micLabel(), bins });
    if (saved.length > 30) saved.shift();
    try { await api('/api/vrp', { method: 'PUT', json: saved }); toast('Saved'); }
    catch (e) { saved.pop(); return toast(e.message); }
    compare = saved.length - 1; list(); info(); draw();
  };
  $('#vrpRange').onclick = async () => {
    // notes held for at least half a second in total, so a passing crack doesn't set the range
    const ms = usable(cur).filter(e => e[1][2] >= 50).map(e => e[0]);
    if (ms.length < 2) return toast('Hold your lowest and highest notes a little longer first');
    const lo = Math.min(...ms), hi = Math.max(...ms);
    if (hi - lo < 5) return toast('That covers less than a fourth. Sing further up and down first.');
    await saveSettings({ rangeLow: lo, rangeHigh: hi }); markRangeSaved();
    s.rangeLow = lo; s.rangeHigh = hi;
    $('#saved').textContent = `${noteName(lo)} – ${noteName(hi)}`; toast(`Range set to ${noteName(lo)} – ${noteName(hi)}`); draw();
  };
  const ro = new ResizeObserver(() => draw()); ro.observe(cv);
  list(); info(); draw();
  return () => { unsub?.(); cancelAnimationFrame(raf); ro.disconnect(); };
}

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
  await loadVoice(ctx);
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
      const play = () => { const t = ctx.currentTime + 0.05; playRef(ctx, out, base, t, 0.7); playRef(ctx, out, base + d, t + 0.85, 0.7); };
      play();
      const pick = await ask(`Question ${i + 1}/10: is the second note higher or lower?`, ['Higher', 'Lower'], play);
      correct = (pick === 'Higher') === (d > 0); item = `hl ${Math.abs(d) < 1 ? Math.abs(d) * 100 + '¢' : Math.abs(d) + ' st'}`;
      reveal(pick, d > 0 ? 'Higher' : 'Lower');
    } else if (mode === 'iv') {
      const iv = lv.ivs[Math.floor(Math.random() * lv.ivs.length)];
      const play = () => { const t = ctx.currentTime + 0.05; playRef(ctx, out, base, t, 0.8); playRef(ctx, out, base + iv, t + 0.9, 0.8); };
      play();
      const pick = await ask(`Question ${i + 1}/10: what interval is that?`, lv.ivs.map(x => INTERVALS[x]), play);
      correct = pick === INTERVALS[iv]; item = INTERVALS[iv];
      reveal(pick, INTERVALS[iv]);
    } else {
      const target = s.rangeLow + 2 + Math.floor(Math.random() * Math.max(1, s.rangeHigh - s.rangeLow - 4));
      const play = () => playRef(ctx, out, target, ctx.currentTime + 0.05, 1.2);
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
      <label><input type="checkbox" name="coachInline" ${s.coachInline !== false ? 'checked' : ''}> Coach on results (AI feedback under lesson and song scores)</label>
      <label><input type="checkbox" name="echoCancellation" ${s.echoCancellation ? 'checked' : ''}> Echo cancellation (only if you can't use headphones)</label>
      <label>Mic filter: <b id="mfName">${MIC_FILTER_NAMES[s.micFilter ?? 2]}</b>
        <input type="range" name="micFilter" min="0" max="3" step="1" value="${s.micFilter ?? 2}"></label>
      <p class="small dim" id="mfHelp" style="grid-column:1/-1;margin:0"></p>
      <label>Reference notes <select name="refSound"><option value="voice"${s.refSound !== 'tone' ? ' selected' : ''}>Real singer</option><option value="tone"${s.refSound === 'tone' ? ' selected' : ''}>Plain tone</option></select></label>
      <label>Voice <select name="voiceType">${[['auto', 'Match my range'], ['low', 'Low (male singer)'], ['high', 'High (female singer)']].map(([v, l]) => `<option value="${v}"${(s.voiceType || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="small dim" style="grid-column:1/-1;margin:0">Singers: <a href="https://doi.org/10.5281/zenodo.1442513" target="_blank" rel="noopener">VocalSet</a> (Wilkins, Seetharaman, Wahl &amp; Pardo, 2018), CC BY 4.0, tuned to exact notes.</p>
      <div class="row" style="grid-column:1/-1"><button id="hearVoice">▶ Hear it</button><span class="small dim">Plays a short scale on “ah”, then a long “oo”, with the choices above.</span></div>
    </div>
    <div class="row"><button class="primary" id="save">Save</button>
      <button id="preset-b">Beginner tolerances</button><button id="preset-a">Advanced tolerances</button></div>
    <h2>New songs</h2>
    <div class="card">
      <label class="row"><input type="checkbox" id="splitBacking" ${s.splitBacking ? 'checked' : ''}> Split backing vocals from the lead</label>
      <p class="small dim">Off: songs are only split into vocals and music. The guide vocal is every voice in the song, and the notes are found from all of them. On: a second step pulls the backing vocals out of the guide onto their own slider, so harmonies don’t pull the notes off the tune, but sometimes it takes the wrong part (fixable in the editor).</p>
      <div class="row" id="splitApply"></div>
    </div>
    <h2>Microphone on this device</h2>
    <div class="card">
      <div class="row"><label class="grow">Mic <select id="micPick"><option value="">System default</option></select></label><button class="primary" id="micTest">Test mic</button></div>
      <div class="miccheck" id="micCheck" hidden>
        <span class="small dim">Level</span><div class="meter" title="Your level; the line marks the room's noise"><i id="mcLvl"></i><u id="mcFloor"></u></div>
        <span class="small dim">Hearing</span><span id="mcInfo" class="small">…</span>
        <span></span><span id="mcTip" class="small"></span>
      </div>
      <p class="small dim">Each phone or computer remembers its own mic. On iPhone the list is short: connect AirPods and they're used automatically. On a computer pick your desk mic here, not the webcam. A mic on input 2 of an audio interface works too. Test it, sing a comfortable note, and follow the tip.</p>
    </div>
    <h2>Timing on this device</h2>
    <div class="card">
      <div class="row"><label class="dim small">Extra delay (ms) <input type="number" id="lat" min="-300" max="1000" step="10" value="${deviceLatencyMs()}"></label>
        <button id="latSave">Save</button><button class="primary" id="latCheck">Run timing check</button></div>
      <p class="small dim">Each phone or computer keeps its own value. The check runs once per session before your first song or warm-up; run it again whenever you switch headphones (for example, AirPods to wired).</p>
    </div>
    <h2>Storage</h2>
    <div class="card row"><span class="grow small" id="stSum">Songs and recordings on the server’s disk.</span><a class="btn" href="#/storage">Manage storage →</a></div>
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
  $('#hearVoice').onclick = async () => {
    const ctx = await audioCtx(), out = ctx.destination;
    const pick = { ...s, refSound: form.querySelector('[name=refSound]').value, voiceType: form.querySelector('[name=voiceType]').value };
    if (pick.refSound !== 'tone') await loadVoice(ctx, pick);
    const root = Math.round((s.rangeLow + s.rangeHigh) / 2) - 3, t = ctx.currentTime + 0.1;
    [0, 2, 4, 5, 7, 5, 4, 2, 0].forEach((iv, k) => pick.refSound === 'tone' ? playTone(ctx, out, root + iv, t + k * 0.45, 0.42, 0.25)
      : playSung(ctx, out, root + iv, t + k * 0.45, 0.42, 0.25, 'ah', pick));
    playSung(ctx, out, root, t + 4.3, 1.6, 0.25, 'oo', pick);
  };
  async function splitInfo() {
    let st; try { st = await api('/api/split-status'); } catch { return; }
    const el = $('#splitApply'); if (!el) return;
    if (!st.todo && !st.stuck) { el.innerHTML = ''; return; }
    el.innerHTML = st.todo ? `<span class="small grow">${st.todo === 1 ? '1 song you already have' : `${st.todo} songs you already have`} ${st.split ? (st.todo === 1 ? 'has its' : 'have their') + ' backing vocals mixed in with the lead' : (st.todo === 1 ? 'still has its' : 'still have their') + ' backing vocals split out'}. ${st.split ? 'Splitting takes a few minutes a song.' : 'Putting the backing vocals back takes about a minute a song.'} Lyrics, key, scores and notes you fixed by hand are kept.</span><button id="splitGo">Redo ${st.todo === 1 ? 'it' : 'them'}</button>`
      : `<span class="small dim">${st.stuck} older song${st.stuck === 1 ? '' : 's'} can’t be split again (the original audio is gone).</span>`;
    $('#splitGo') && ($('#splitGo').onclick = async () => {
      try { const r = await api('/api/songs/apply-split-setting', { method: 'POST' }); toast(`${r.queued} song${r.queued === 1 ? '' : 's'} queued. Watch the song list.`); } catch (e) { toast(e.message); }
      splitInfo();
    });
  }
  $('#splitBacking').onchange = async e => { await saveSettings({ splitBacking: e.target.checked }); toast(e.target.checked ? 'New songs will have the backing vocals split out' : 'New songs: just vocals and music'); splitInfo(); };
  splitInfo();
  api('/api/storage').then(st => { const el = $('#stSum'); if (el) el.textContent = `Vocal Lab is using ${fmtBytes(st.app.total)} (${st.songs.length} songs, ${st.takes.length} recordings). ${fmtBytes(st.disk.free)} free on the disk.`; }).catch(() => {});
  // ---- mic picker and check
  const pick = $('#micPick');
  async function fillMics() {
    const mics = await listMics(), want = preferredMicId();
    pick.innerHTML = '<option value="">System default</option>' + mics.map((m, i) =>
      `<option value="${esc(m.deviceId)}"${m.deviceId === want ? ' selected' : ''}>${esc(m.label || `Microphone ${i + 1} (test the mic to see names)`)}</option>`).join('');
    if (want && !mics.some(m => m.deviceId === want)) pick.insertAdjacentHTML('beforeend', `<option value="${esc(want)}" selected>Saved mic (not plugged in)</option>`);
  }
  fillMics();
  document.addEventListener('vl-mics', fillMics);
  pick.onchange = async () => {
    setPreferredMicId(pick.value);
    if (A.stream) { try { await restartMic(); } catch (e) { toast('Mic error: ' + e.message); } }
    toast(`Mic: ${currentMicLabel() || pick.selectedOptions[0].textContent}`);
  };
  let mcOff = [], mcRaf = 0, mcOpened = false;   // close the mic on leaving only if the test opened it
  const mc = { floor: 1, peakDb: -99, clip: 0, ch: 0, note: null, voiced: 0, frames: 0 };
  function mcStop() { mcOff.forEach(f => f()); mcOff = []; cancelAnimationFrame(mcRaf); }
  $('#micTest').onclick = async () => {
    const wasOn = !!A.stream;
    try { await startMic(); } catch (e) { return toast(e.name === 'NotAllowedError' ? 'Microphone permission was refused.' : 'Mic error: ' + e.message, 6000); }
    fillMics();   // names only show once the mic's been allowed
    if (!wasOn) mcOpened = true;
    mcStop(); Object.assign(mc, { floor: 1, peakDb: -99, clip: 0, note: null, voiced: 0, frames: 0 });
    $('#micCheck').hidden = false;
    mcOff.push(onRawPitch(f => {
      mc.floor = Math.min(mc.floor * 1.003, Math.max(f.rms, 1e-5));   // quietest recent level = the room
      const db = 20 * Math.log10(Math.max(f.rms, 1e-5));
      mc.peakDb = Math.max(mc.peakDb - 0.15, db);
      if (f.peak >= 0.98) mc.clip = performance.now();
      mc.ch = f.ch || 0; mc.frames++;
    }));
    mcOff.push(onPitch(f => { if (f.midi !== null) { mc.note = f.midi; mc.voiced = performance.now(); } }));
    const pct = db => clamp((db + 70) / 70, 0, 1) * 100;
    (function draw() {
      const floorDb = 20 * Math.log10(mc.floor), now = performance.now();
      $('#mcLvl').style.width = pct(mc.peakDb) + '%';
      $('#mcFloor').style.left = pct(floorDb) + '%';
      const singing = now - mc.voiced < 400;
      const set = A.stream?.getAudioTracks()[0]?.getSettings?.() || {};
      $('#mcInfo').textContent = `${currentMicLabel() || 'mic'}${set.channelCount > 1 ? ` · input ${mc.ch + 1} of ${set.channelCount}` : ''}${set.sampleRate ? ` · ${Math.round(set.sampleRate / 1000)} kHz` : ''} · room ${Math.round(floorDb)} dB · you ${Math.round(mc.peakDb)} dB${singing ? ` · ${noteName(mc.note)}` : ''}`;
      const gap = mc.peakDb - floorDb;
      $('#mcTip').textContent = mc.frames < 50 ? 'Listening…'
        : now - mc.clip < 2000 ? '🔴 Clipping. Turn the gain down on the mic or interface until loud notes stop doing this.'
        : floorDb > -45 ? '🟠 The room is noisy for this mic (fan, computer, hum). Move away from it, or bring the mic closer and turn the gain down.'
        : mc.peakDb < -40 ? 'Sing a comfortable note. If the bar barely moves, turn the gain up or get closer to the mic.'
        : gap < 20 ? '🟠 Your voice is only a little louder than the room. Get closer to the mic or turn the gain up.'
        : mc.peakDb > -6 ? '🟠 Close to clipping on loud notes. A bit less gain gives you headroom.'
        : singing ? '🟢 Good level. The note shown should match what you sing.' : '🟢 Good level.';
      mcRaf = requestAnimationFrame(draw);
    })();
  };
  const prevCleanup = cleanup;
  cleanup = () => { mcStop(); document.removeEventListener('vl-mics', fillMics); if (mcOpened) stopMic(); prevCleanup?.(); };
  $('#latSave').onclick = () => { setDeviceLatencyMs(Number($('#lat').value)); toast('Saved for this device'); };
  $('#latCheck').onclick = async () => { await timingCheck(); $('#lat').value = deviceLatencyMs(); };
  $('#save').onclick = async () => {
    const patch = {};
    form.querySelectorAll('input').forEach(i => { patch[i.name] = i.type === 'checkbox' ? i.checked : Number(i.value); });
    form.querySelectorAll('select').forEach(i => { patch[i.name] = i.value; });
    if (patch.amberCents <= patch.greenCents) return toast('Amber has to be wider than green');
    await saveSettings(patch); toast('Saved');
  };
}, 'settings');

// ---- storage: what each song and recording takes up on the server's disk
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : (b || 0) + ' B';
const PART_LABELS = { audio: 'audio', copies: 'key/speed copies', source: 'original download', data: 'notes & lyrics' };
route(/^\/storage$/, async () => {
  view.innerHTML = `<h1>Storage</h1><p class="dim">Loading…</p>`;
  const st = await api('/api/storage');
  const { disk, app: a } = st;
  const pct = x => Math.max(0, Math.min(100, x / disk.total * 100));
  const copies = st.songs.reduce((t, x) => t + x.parts.copies, 0);
  const takeTotal = st.takes.reduce((t, x) => t + x.size, 0);
  const sel = new Set();
  view.innerHTML = `<h1>Storage</h1>
    <div class="card">
      <div class="row"><b class="grow">Vocal Lab is using ${fmtBytes(a.total)}</b><span class="small dim">${fmtBytes(disk.free)} free of ${fmtBytes(disk.total)}</span></div>
      <div class="st-bar" title="Disk">
        <i style="width:${pct(a.songs)}%;background:var(--accent)" title="Songs ${fmtBytes(a.songs)}"></i><i style="width:${pct(a.takes)}%;background:#d9a441" title="Recordings ${fmtBytes(a.takes)}"></i><i style="width:${pct(Math.max(0, disk.used - a.songs - a.takes))}%;background:rgba(255,255,255,.18)" title="Everything else on the disk"></i>
      </div>
      <div class="row small" style="flex-wrap:wrap;gap:14px">
        <span><i class="st-dot" style="background:var(--accent)"></i>Songs ${fmtBytes(a.songs)}</span>
        <span><i class="st-dot" style="background:#d9a441"></i>Recordings ${fmtBytes(a.takes)}</span>
        <span><i class="st-dot" style="background:rgba(255,255,255,.18)"></i>Other files on the disk ${fmtBytes(Math.max(0, disk.used - a.songs - a.takes))}</span>
        <span class="dim">Database ${fmtBytes(a.database)}${a.leftovers ? ` · leftovers ${fmtBytes(a.leftovers)}` : ''}</span>
      </div>
    </div>
    ${copies ? `<div class="card row"><span class="grow small">${fmtBytes(copies)} is key-changed and slowed-down copies of songs. They’re rebuilt the next time you pick that key or speed, so they’re safe to clear.</span><button id="clearCopies">Clear all copies</button></div>` : ''}
    ${st.orphans.length ? `<div class="card row"><span class="grow small">${fmtBytes(a.leftovers)} in ${st.orphans.length} leftover file${st.orphans.length === 1 ? '' : 's'} nothing in the app points to any more (${[...new Set(st.orphans.map(o => o.kind + 's'))].join(', ')}).</span><button id="cleanLeft" class="danger">Delete leftovers</button></div>` : ''}
    <h2>Songs <span class="small dim">${st.songs.length} · ${fmtBytes(a.songs)}</span></h2>
    <div class="card table-wrap"><table id="stSongs"><tr><th>Song</th><th style="text-align:right">Size</th><th></th></tr>
    ${st.songs.map(x => `<tr data-id="${x.id}">
      <td><div>${esc(x.title)}</div><div class="small dim">${GROUPS_ORDER.filter(k => x.parts[k]).map(k => `${PART_LABELS[k]} ${fmtBytes(x.parts[k])}`).join(' · ') || 'empty'}${x.status !== 'ready' ? ` · <span class="pill ${x.status}">${x.status}</span>` : ''}</div></td>
      <td style="text-align:right;white-space:nowrap"><b>${fmtBytes(x.total)}</b></td>
      <td class="row" style="justify-content:flex-end;flex-wrap:nowrap">${x.parts.copies ? `<button data-copies title="Clear key/speed copies">Clear copies</button>` : ''}<button data-del class="danger" title="Delete song">✕</button></td></tr>`).join('')}
    </table>${st.songs.length ? '' : '<p class="dim">No songs.</p>'}</div>
    <h2>Recordings <span class="small dim">${st.takes.length} · ${fmtBytes(takeTotal)}</span></h2>
    <div class="card">
      ${st.takes.length ? `<div class="row small" style="flex-wrap:wrap">
        <label class="row"><input type="checkbox" id="tkAll"> Select all</label>
        <button data-older="30">Select older than 30 days</button>
        <span class="grow"></span>
        <label class="row"><input type="checkbox" id="tkKeep" checked> Keep the scores</label>
        <button class="danger" id="tkDel" disabled>Delete selected</button>
      </div>` : ''}
      <div class="table-wrap"><table id="stTakes">
      ${st.takes.map(t => `<tr data-id="${t.id}" data-created="${t.created}">
        <td style="width:1%"><input type="checkbox" data-pick></td>
        <td><div>${esc(t.title || t.ref)} <span class="dim small">${t.kind}</span></div><div class="small dim">${fmtDate(t.created)}${t.score == null ? '' : ` · ${Math.round(t.score)}%`}${t.missing ? ' · file missing' : ''}</div></td>
        <td style="text-align:right;white-space:nowrap">${fmtBytes(t.size)}</td>
        <td class="row" style="justify-content:flex-end;flex-wrap:nowrap">${t.missing ? '' : `<button data-play="${esc(t.take)}">▶</button>`}<button data-del class="danger" title="Delete recording">✕</button></td></tr>`).join('')}
      </table></div>
      ${st.takes.length ? '' : '<p class="dim">No recordings. Turn on “Record my takes” in Settings to keep them.</p>'}
    </div>
    <audio id="player" hidden></audio>`;
  const done = (msg, r) => { toast(`${msg}${r && r.freed ? ` · freed ${fmtBytes(r.freed)}` : ''}`); render(); };
  $('#clearCopies') && ($('#clearCopies').onclick = async () => {
    try { done('Copies cleared', await api('/api/storage/clear-copies', { method: 'POST' })); } catch (e) { toast(e.message); }
  });
  $('#cleanLeft') && ($('#cleanLeft').onclick = async () => {
    if (!confirm(`Delete ${st.orphans.length} leftover file${st.orphans.length === 1 ? '' : 's'} (${fmtBytes(a.leftovers)})?`)) return;
    try { done('Leftovers deleted', await api('/api/storage/clean-leftovers', { method: 'POST' })); } catch (e) { toast(e.message); }
  });
  $('#stSongs').onclick = async e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const x = st.songs.find(y => y.id === tr.dataset.id);
    try {
      if (e.target.closest('[data-copies]')) done('Copies cleared', await api(`/api/storage/songs/${x.id}/clear-copies`, { method: 'POST' }));
      else if (e.target.closest('[data-del]')) {
        if (!confirm(`Delete “${x.title}” and its audio (${fmtBytes(x.total)})? Your scores for it stay in Progress.`)) return;
        done('Song deleted', await api(`/api/songs/${x.id}`, { method: 'DELETE' }));
      }
    } catch (err) { toast(err.message); }
  };
  const tk = $('#stTakes');
  const syncSel = () => {
    sel.clear(); tk.querySelectorAll('[data-pick]:checked').forEach(c => sel.add(Number(c.closest('tr').dataset.id)));
    const b = $('#tkDel'); if (!b) return;
    const bytes = st.takes.filter(t => sel.has(t.id)).reduce((s2, t) => s2 + t.size, 0);
    b.disabled = !sel.size; b.textContent = sel.size ? `Delete ${sel.size} (${fmtBytes(bytes)})` : 'Delete selected';
    $('#tkAll').checked = sel.size && sel.size === st.takes.length;
  };
  tk.onchange = syncSel;
  $('#tkAll') && ($('#tkAll').onchange = e => { tk.querySelectorAll('[data-pick]').forEach(c => (c.checked = e.target.checked)); syncSel(); });
  view.querySelector('[data-older]') && (view.querySelector('[data-older]').onclick = () => {
    const cut = Date.now() / 1000 - 30 * 86400;
    tk.querySelectorAll('tr[data-id]').forEach(tr => { tr.querySelector('[data-pick]').checked = Number(tr.dataset.created) < cut; });
    syncSel(); if (!sel.size) toast('Nothing older than 30 days');
  });
  const delTakes = async ids => {
    const keep = $('#tkKeep') ? $('#tkKeep').checked : true;
    try { done(`${ids.length} recording${ids.length === 1 ? '' : 's'} deleted`, await api('/api/storage/takes/delete', { method: 'POST', json: { ids, keep_scores: keep } })); } catch (e) { toast(e.message); }
  };
  $('#tkDel') && ($('#tkDel').onclick = () => {
    if (!sel.size) return;
    const keep = $('#tkKeep').checked;
    if (confirm(`Delete ${sel.size} recording${sel.size === 1 ? '' : 's'}?${keep ? ' Scores stay in Progress.' : ' Their scores go too.'}`)) delTakes([...sel]);
  });
  tk.onclick = e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    if (e.target.dataset.play) { const p = $('#player'); p.src = `/media/takes/${e.target.dataset.play}`; p.play(); }
    else if (e.target.closest('[data-del]') && confirm('Delete this recording?')) delTakes([Number(tr.dataset.id)]);
  };
  cleanup = () => { const p = $('#player'); if (p) p.pause(); };
}, 'settings');
const GROUPS_ORDER = ['audio', 'source', 'copies', 'data'];

api('/api/me').then(m => { if (m.login) $('#logout').hidden = false; }).catch(() => {});
$('#logout').onclick = e => { if (!confirm('Sign out of Vocal Lab on this device?')) e.preventDefault(); };
window.addEventListener('DOMContentLoaded', render);
