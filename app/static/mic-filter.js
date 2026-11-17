// Mic filter: keeps breaths, clicks, mic bumps and other non-singing sounds off the pitch line.
//
// The pitch worklet sends ~100 raw estimates a second. This sits between it and the rest of
// the app and holds each estimate back for a few frames, so it can judge a frame by what
// comes after it as well as before. Frames carry their own timestamps, so the hold delays
// when the line is drawn, not where.
//
// A frame counts as singing only if all of these hold:
//   - the pitch is clear (periodic), not noisy
//   - it's louder than the room by a margin (noise floor tracked continuously)
//   - it's not far quieter than your recent singing (breaths in and out are much softer)
//   - it's inside a plausible range around your set vocal range
//   - it belongs to a run of such frames long enough to be a sung sound (a click, bump or
//     voiced exhale lasts a few frames; a note lasts many)
// A pitch jump that holds for two frames starts a new run, so a thump or glitch that runs
// straight into a note can't ride on the note's length. Inside a run, a 5-frame median
// removes one-off octave flickers, and a wild tail (where the window straddles the end of
// the note) is dropped.

const MIC_FILTER_LEVELS = [
  null, // 0 = off: the old behaviour (clarity only)
  { clarity: 0.80, floorDb: 6,  belowVoiceDb: 26, minRun: 5, gap: 2 }, // light
  { clarity: 0.85, floorDb: 10, belowVoiceDb: 20, minRun: 6, gap: 2 }, // normal
  { clarity: 0.90, floorDb: 14, belowVoiceDb: 15, minRun: 9, gap: 2 }, // strong
];
const MIC_FILTER_NAMES = ['Off', 'Light', 'Normal', 'Strong'];

function createMicFilter(level, rangeLow, rangeHigh) {
  const cfg = MIC_FILTER_LEVELS[level] || null;
  const cents = (a, b) => 1200 * Math.log2(a / b);
  const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

  if (!cfg) {
    // Off: emit straight away, voiced if clear enough.
    return { delay: 0, push: f => [{ ...f, hz: f.hz > 0 && f.clarity > 0.8 ? f.hz : 0 }] };
  }

  // An octave of slack each side of the saved range (never narrower than C3–C5 plus that
  // octave), so the range test can still find new notes but squeaks and rumbles can't.
  const loHz = Math.max(65, midiHz(Math.min(rangeLow ?? 48, 48) - 12));
  const hiHz = Math.min(1100, midiHz(Math.max(rangeHigh ?? 72, 72) + 12));
  const floorRatio = Math.pow(10, cfg.floorDb / 20);
  const voiceRatio = Math.pow(10, -cfg.belowVoiceDb / 20);
  // held back long enough to confirm a run, and to still hold a run's last frames when it ends
  const delay = Math.max(cfg.minRun, cfg.gap + 4);

  let floor = 0.003;     // room noise RMS
  let voice = 0;         // recent singing level (decays slowly)
  const buf = [];        // held frames: { f, ok, run }
  let run = null;        // the run of candidate frames we're in
  const newRun = () => ({ len: 0, gapLen: 0, confirmed: false, ended: false, lastHz: 0, pending: null, anchor: 0, frames: [] });

  function candidate(f) {
    if (!(f.hz > 0) || f.clarity < cfg.clarity) return false;
    if (f.hz < loHz || f.hz > hiHz) return false;
    if (f.rms < Math.max(0.004, floor * floorRatio)) return false;
    if (voice > 0 && f.rms < voice * voiceRatio) return false;
    return true;
  }

  // Median of hz over a run's frames around index i (only candidate frames count).
  function medianAround(r, i, half) {
    const v = [];
    for (let k = Math.max(0, i - half); k <= Math.min(r.frames.length - 1, i + half); k++) {
      const e = r.frames[k];
      if (e.ok) v.push(e.f.hz);
    }
    if (!v.length) return 0;
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  }

  function finishRun(r) {
    if (!r) return;
    // drop trailing gap frames from the run (they were never sound)
    while (r.frames.length && !r.frames[r.frames.length - 1].ok) r.frames.pop().run = null;
    r.ended = true;
    if (!r.confirmed) { for (const e of r.frames) e.run = null; return; }
    // Trim spiky edges: the first and last few frames must sit near the run's settled pitch.
    // Trim a spiky tail: the last few frames must sit near the pitch just before them.
    const n = r.frames.length;
    const settled = settledHz(r.frames.slice(Math.max(0, n - 9), Math.max(0, n - 3)));
    if (settled) for (let k = n - 1; k >= Math.max(0, n - 3); k--) {
      if (Math.abs(cents(r.frames[k].f.hz || settled, settled)) > 250) r.frames[k].drop = true; else break;
    }
  }

  function settledHz(frames) {
    const v = frames.filter(e => e.ok).map(e => e.f.hz).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : 0;
  }

  function release(e) {
    const r = e.run;
    let hz = 0;
    if (r && r.confirmed && !e.drop) {
      const i = r.frames.indexOf(e);
      const m = medianAround(r, i, 2);
      // gap frames (brief clarity dips mid-note) take the median of their neighbours
      hz = e.ok && m && Math.abs(cents(e.f.hz, m)) > 80 ? m : (e.ok ? e.f.hz : m);
      // keep the run's frame list short once frames are out of the median's reach
      if (i > 6) r.frames.splice(0, i - 6);
    }
    return { t: e.f.t, hz, clarity: e.f.clarity, rms: e.f.rms };
  }

  return {
    delay,
    push(f) {
      const ok = candidate(f);
      // track room noise: fall fast to quieter frames, creep up slowly when not singing
      if (f.rms < floor) floor += (f.rms - floor) * 0.2;
      else if (!ok) floor = Math.min(floor * 1.002, 0.05);
      floor = Math.max(floor, 0.0003);

      const e = { f, ok, run: null };
      if (ok) {
        if (!run || run.ended) run = newRun();
        let hold = false;
        if (run.pending === null) {
          if (run.lastHz && Math.abs(cents(f.hz, run.lastHz)) > 250) { run.pending = run.frames.length; run.anchor = run.lastHz; hold = true; }
        } else if (Math.abs(cents(f.hz, run.anchor)) > 250) {
          // the jump held for a second frame: it's a different sound, so start a new run there
          const b = newRun();
          b.frames = run.frames.splice(run.pending);
          b.frames.forEach(x => { x.run = b; });
          b.len = b.frames.filter(x => x.ok).length;
          run.len -= b.len;
          finishRun(run);
          run = b;
        } else run.pending = null;   // a one-frame flicker: the median smooths it over
        run.len++; run.gapLen = 0; run.lastHz = f.hz;
        e.run = run; run.frames.push(e);
        // a jump frame can't confirm the run it jumped away from
        if (!hold && !run.confirmed && run.len >= cfg.minRun) run.confirmed = true;
        if (run.confirmed) voice = Math.max(voice, f.rms);
      } else if (run && !run.ended) {
        if (++run.gapLen <= cfg.gap) { e.run = run; run.frames.push(e); }
        else { finishRun(run); }
      }
      voice *= 0.9993;   // about −0.6 dB a second, so quiet passages after loud ones still count

      buf.push(e);
      const out = [];
      while (buf.length > delay) out.push(release(buf.shift()));
      return out;
    },
  };
}

if (typeof module !== 'undefined') module.exports = { createMicFilter, MIC_FILTER_LEVELS, MIC_FILTER_NAMES };
