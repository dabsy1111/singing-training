// Pitch module for the AI Coach page.
//
// Uses mic-pitch (MIT, YIN on an AnalyserNode). Everything here runs in the browser; no audio
// is stored or sent anywhere. Only the numbers computed in scoreTrial() leave this file.
//
// Note on the mic flags: echoCancellation / noiseSuppression / autoGainControl are getUserMedia
// constraints, not AudioContext options. mic-pitch already asks for all three to be off in
// _createStream(); start() below checks what the browser actually granted.

import { MicPitch } from './vendor/mic-pitch/index.js';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
export const midiName = m => NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
export const centsBetween = (hz, refHz) => 1200 * Math.log2(hz / refHz);

/** Nearest note and how far off it, for the live display. */
export function describeHz(hz) {
  const m = hzToMidi(hz);
  const near = Math.round(m);
  return { hz, midi: m, note: midiName(near), nearest: near, cents: Math.round((m - near) * 100) };
}

class Tracker extends MicPitch {
  get ctx() { return this._ctx; }
  get stream() { return this._stream; }
}

/**
 * Live pitch from the mic. onFrame gets { t (seconds, performance clock), hz or null }.
 * One AudioContext is used for both listening and the reference tones (iOS behaves better that way).
 */
export class PitchSource {
  constructor() {
    this.listeners = new Set();
    this.tracker = new Tracker({
      minFreq: 70,          // ~C#2
      maxFreq: 1100,        // ~C#6
      threshold: 0.12,
      fftSize: 2048,        // ~43 ms at 48 kHz
      updateIntervalMs: 20, // 50 estimates a second
      smoothing: 0,         // raw estimates; we smooth in scoring so note starts stay sharp
      minRms: 0.01,         // ignore the room when you're not singing
    });
    this.tracker.onFrequency(hz => {
      const f = { t: performance.now() / 1000, hz: hz && isFinite(hz) ? hz : null };
      for (const cb of this.listeners) cb(f);
    });
    this.granted = null;
  }

  async start() {
    // Safari 17+: keep playback and recording on one audio route (AirPods etc.)
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
    // Same mic as the main app (Settings → Microphone on this device), if it's plugged in.
    let want = ''; try { want = localStorage.getItem('vl-mic-id') || ''; } catch {}
    this.tracker._deviceId = want || null;
    try { await this.tracker.start(); }
    catch (e) {
      if (!want || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
      try { this.tracker.ctx?.close(); } catch {}   // the failed start left its context open
      this.tracker._deviceId = null;
      await this.tracker.start();
    }
    const track = this.tracker.stream?.getAudioTracks()[0];
    const s = track?.getSettings?.() || {};
    this.granted = {
      label: track?.label || 'microphone',
      echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl,
      sampleRate: this.tracker.ctx?.sampleRate,
    };
    if (this.tracker.ctx?.state === 'suspended') await this.tracker.ctx.resume();
    return this.granted;
  }

  stop() { this.tracker.stop(); }
  get running() { return this.tracker.running; }
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /** A soft reference note (a few harmonics so it's easy to match). Resolves when it ends. */
  playNote(midi, seconds = 1.2, volume = 0.18) {
    const ctx = this.tracker.ctx;
    if (!ctx) return Promise.resolve();
    const f0 = midiToHz(midi), t0 = ctx.currentTime + 0.03, t1 = t0 + seconds;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(volume, t0 + 0.04);
    out.gain.setValueAtTime(volume, t1 - 0.15);
    out.gain.linearRampToValueAtTime(0, t1);
    out.connect(ctx.destination);
    [[1, 1], [2, 0.35], [3, 0.15], [4, 0.06]].forEach(([k, a]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f0 * k; g.gain.value = a;
      o.connect(g).connect(out); o.start(t0); o.stop(t1 + 0.05);
    });
    return new Promise(res => setTimeout(res, (seconds + 0.05) * 1000));
  }
}

// --------------------------------------------------------------------------
// scoring
// --------------------------------------------------------------------------

const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const r1 = v => Math.round(v * 10) / 10;

/**
 * Score one attempt at a target note.
 * frames: [{t, hz}] from the sing window. t0: when the window opened.
 * opts.octaveFree: count singing an octave away as on target (reported separately).
 * opts.window: cents counted as "in tune" (default 50, a quarter tone).
 */
export function scoreTrial(frames, targetMidi, t0, opts = {}) {
  const win = opts.window ?? 50;
  const targetHz = midiToHz(targetMidi);
  let voiced = frames.filter(f => f.hz).map(f => ({ t: f.t - t0, c: centsBetween(f.hz, targetHz) }));

  // Drop one-off glitches: keep a frame only if it's within a semitone of the median of its neighbours.
  voiced = voiced.filter((f, i) => {
    const near = voiced.slice(Math.max(0, i - 2), i + 3).map(x => x.c);
    return Math.abs(f.c - median(near)) <= 100;
  });

  const result = { target: midiName(targetMidi), targetMidi, voicedSec: 0, sungAt: null, octave: 0,
    lockSec: null, medianCents: null, meanAbsCents: null, inTunePct: 0, spreadCents: null, driftCentsPerSec: null, hit: false };
  if (voiced.length < 10) return result;    // under ~0.2 s of singing
  result.voicedSec = r1(voiced.length * 0.02);
  // Lowest and highest notes actually sung (10th / 90th percentile, so a stray frame doesn't count)
  const ms = voiced.map(f => targetMidi + f.c / 100).sort((a, b) => a - b);
  result.lowMidi = Math.round(ms[Math.floor(ms.length * 0.1)]);
  result.highMidi = Math.round(ms[Math.floor(ms.length * 0.9)]);

  // Which octave did they sing in? Fold to the most common one if octave-free.
  const oct = median(voiced.map(f => Math.round(f.c / 1200)));
  result.octave = oct;
  const shift = opts.octaveFree ? oct * 1200 : 0;
  const c = voiced.map(f => ({ t: f.t, c: f.c - shift }));

  // Settle time: first run of 6 frames (~120 ms) inside the window.
  let run = 0;
  for (let i = 0; i < c.length; i++) {
    run = Math.abs(c[i].c) <= win ? run + 1 : 0;
    if (run === 6) { result.lockSec = r1(Math.max(0, c[i - 5].t)); break; }
  }

  // Judge the note after the first 0.3 s of sound, so the scoop into it isn't punished.
  const start = c[0].t + 0.3;
  const body = c.filter(f => f.t >= start);
  const use = body.length >= 8 ? body : c;
  const cents = use.map(f => f.c);
  const med = median(cents);
  result.sungAt = midiName(targetMidi + (med + shift) / 100);
  // Only call it "an octave away" if it really was the same note in another octave.
  const rawMed = med + shift, octs = Math.round(rawMed / 1200);
  result.octave = octs && Math.abs(rawMed - octs * 1200) <= 100 ? octs : 0;
  result.medianCents = Math.round(med);
  result.meanAbsCents = Math.round(mean(cents.map(Math.abs)));
  result.inTunePct = Math.round(100 * cents.filter(v => Math.abs(v) <= win).length / cents.length);
  result.spreadCents = Math.round(std(cents));
  // Drift: slope of a straight line through the pitch over time (cents per second).
  if (use.length > 20) {
    const ts = use.map(f => f.t), mt = mean(ts), mc = mean(cents);
    let num = 0, den = 0;
    for (let i = 0; i < use.length; i++) { num += (ts[i] - mt) * (cents[i] - mc); den += (ts[i] - mt) ** 2; }
    result.driftCentsPerSec = den ? Math.round(num / den) : 0;
  }
  result.hit = result.inTunePct >= 60 && Math.abs(result.medianCents) <= win;
  return result;
}

/** Roll a session's trials into the summary the coach gets. Pure data, no audio. */
export function summariseSession(exercise, trials, ctx) {
  const sung = trials.filter(t => t.voicedSec > 0);
  const avg = k => sung.length ? Math.round(mean(sung.map(t => t[k]).filter(v => v != null))) : null;
  const hi = sung.filter(t => t.targetMidi >= ctx.mid), lo = sung.filter(t => t.targetMidi < ctx.mid);
  const bias = arr => arr.length ? Math.round(mean(arr.map(t => t.medianCents))) : null;
  return {
    exercise, at: new Date().toISOString(),
    range: `${midiName(ctx.rangeLow)}–${midiName(ctx.rangeHigh)}`,
    octaveFree: !!ctx.octaveFree,
    detectedRange: sung.length ? { low: midiName(Math.min(...sung.map(t => t.lowMidi))), high: midiName(Math.max(...sung.map(t => t.highMidi))) } : null,
    notes: trials.length, hits: trials.filter(t => t.hit).length, silent: trials.length - sung.length,
    inTunePct: avg('inTunePct'), biasCents: bias(sung), biasLowCents: bias(lo), biasHighCents: bias(hi),
    lockSec: sung.filter(t => t.lockSec != null).length ? r1(mean(sung.filter(t => t.lockSec != null).map(t => t.lockSec))) : null,
    spreadCents: avg('spreadCents'),
    driftCentsPerSec: exercise === 'hold' ? avg('driftCentsPerSec') : undefined,
    trials,
  };
}

const sign = v => (v > 0 ? '+' : '') + v;

/** The plain text the model reads. Shown on screen too, so you can see exactly what's sent. */
export function sessionText(s) {
  const name = s.exercise === 'hold' ? 'Hold the pitch' : 'Match the note';
  const parts = [`${name}: ${s.hits}/${s.notes} notes on target, saved range ${s.range}.`];
  if (s.inTunePct != null) parts.push(`Average ${s.inTunePct}% of sung time within 50 cents.`);
  if (s.biasCents != null) parts.push(`Overall ${sign(s.biasCents)} cents (${s.biasCents < 0 ? 'flat' : 'sharp'}).`);
  if (s.biasLowCents != null && s.biasHighCents != null)
    parts.push(`Lower notes ${sign(s.biasLowCents)} c, upper notes ${sign(s.biasHighCents)} c.`);
  if (s.lockSec != null) parts.push(`Took ${s.lockSec} s on average to settle.`);
  if (s.spreadCents != null) parts.push(`Wobble (spread) ${s.spreadCents} c.`);
  if (s.driftCentsPerSec != null) parts.push(`Drift during holds ${sign(s.driftCentsPerSec)} c/s.`);
  if (s.silent) parts.push(`${s.silent} note(s) with no singing detected.`);
  const lines = s.trials.map(t => {
    if (!t.voicedSec) return `${t.target}: nothing detected`;
    const bits = [`${t.target}: ${t.hit ? 'hit' : 'missed'}`, `${sign(t.medianCents)} c`, `${t.inTunePct}% in tune`,
      `spread ${t.spreadCents} c`];
    if (t.lockSec != null) bits.push(`settled in ${t.lockSec} s`); else bits.push('never settled');
    if (t.driftCentsPerSec != null && s.exercise === 'hold') bits.push(`drift ${sign(t.driftCentsPerSec)} c/s`);
    if (t.octave) bits.push(`sung ${Math.abs(t.octave)} octave${Math.abs(t.octave) > 1 ? 's' : ''} ${t.octave < 0 ? 'lower' : 'higher'}`);
    if (!t.hit && t.sungAt && t.sungAt !== t.target) bits.push(`closest note ${t.sungAt}`);
    return bits.join(', ');
  });
  return parts.join(' ') + '\nPer note: ' + lines.join('; ') + '.';
}
