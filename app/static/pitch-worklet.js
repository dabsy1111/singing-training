// Real-time pitch detection (YIN) running on the audio thread.
// Posts ~100 estimates a second: { t, hz, clarity, rms, peak, ch } where t is the AudioContext
// time at the centre of the analysis window, rms is the level after the clean-up filters,
// peak is the loudest raw sample since the last frame (for the clipping warning) and ch is the
// input channel being listened to.
//
// Input clean-up, before the pitch tracker sees anything:
//   - Channel pick. An audio interface sends one channel per input, and a desktop mic is often
//     on input 2 with input 1 empty (or the other way round). The louder channel is used, with
//     a slow, sticky switch so a cough on the other input doesn't flip it.
//   - High-pass at 55 Hz (2nd order). Removes DC offset (cheap USB mics), desk thumps, traffic
//     rumble and 50 Hz mains hum, which otherwise count as "sound" in the level and can be read
//     as a low note. Low voices still get through: F2 is 87 Hz.
//   - Low-pass at 3.5 kHz (4th order), then decimate to ~16 kHz. Breath noise and sibilance
//     live up there and only muddy the periodicity; the decimation no longer aliases them down.
//
// Pitch: YIN with one addition. Bluetooth headset mics (AirPods in call mode) and small desk
// mics roll off the bass, so a low male note can arrive with its fundamental nearly gone. YIN
// then sometimes takes the second harmonic and reports the note an octave too high. If the
// period twice as long is clearly more periodic than the one picked, the longer one wins.

class Biquad {
  constructor(type, f, fs, q) {
    const w = 2 * Math.PI * f / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    if (type === 'hp') { this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; }
    else { this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; }
    this.b2 = this.b0; this.a1 = -2 * cw / a0; this.a2 = (1 - al) / a0;
    this.z1 = 0; this.z2 = 0;
  }
  run(x) {   // transposed direct form II
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.decim = Math.max(1, Math.round(fs / 16000));          // analyse at ~16 kHz
    this.rate = fs / this.decim;
    this.win = Math.round(this.rate * 0.045);                  // 45 ms window -> down to ~65 Hz
    this.hop = Math.round(this.rate * 0.01);                   // 10 ms hop
    this.ring = new Float32Array(this.win);                    // written in place: no shifting per sample
    this.pos = 0;
    this.buf = new Float32Array(this.win);                     // the window, in order, when it's analysed
    this.filled = 0;
    this.sinceHop = 0;
    this.acc = 0; this.accN = 0;
    this.minLag = Math.floor(this.rate / 1100);
    this.maxLag = Math.min(this.win - 2, Math.ceil(this.rate / 65));
    this.d = new Float32Array(this.maxLag + 2);
    const lpF = Math.min(3500, 0.42 * this.rate);
    this.hp = new Biquad('hp', 55, fs, Math.SQRT1_2);
    this.lp1 = new Biquad('lp', lpF, fs, 0.5412);              // 4th-order Butterworth as two biquads
    this.lp2 = new Biquad('lp', lpF, fs, 1.3066);
    this.peak = 0;
    this.chan = 0; this.chE = [0, 0];
  }

  // Louder of the first two channels, judged over ~1 s, switching only on a clear (6 dB) margin.
  pickChannel(chs, n) {
    if (chs.length < 2) return chs[0];
    for (let c = 0; c < 2; c++) {
      const x = chs[c]; let e = 0;
      for (let i = 0; i < n; i++) e += x[i] * x[i];
      this.chE[c] += (e / n - this.chE[c]) * 0.01;
    }
    const other = 1 - this.chan;
    if (this.chE[other] > this.chE[this.chan] * 4) this.chan = other;
    return chs[this.chan];
  }

  process(inputs) {
    const chs = inputs[0];
    if (!chs || !chs.length || !chs[0]) return true;
    const n = chs[0].length;
    const ch = this.pickChannel(chs, n);
    for (let i = 0; i < n; i++) {
      const raw = ch[i];
      const a = raw < 0 ? -raw : raw;
      if (a > this.peak) this.peak = a;
      const y = this.lp2.run(this.lp1.run(this.hp.run(raw)));
      this.acc += y; this.accN++;
      if (this.accN === this.decim) {
        this.ring[this.pos] = this.acc / this.decim;
        this.pos = (this.pos + 1) % this.win;
        this.acc = 0; this.accN = 0;
        if (this.filled < this.win) this.filled++;
        if (++this.sinceHop >= this.hop && this.filled === this.win) {
          this.sinceHop = 0;
          // unroll the ring, oldest sample first
          const head = this.win - this.pos;
          this.buf.set(this.ring.subarray(this.pos), 0);
          this.buf.set(this.ring.subarray(0, this.pos), head);
          // time of the newest sample minus half the window
          const tEnd = currentTime + (i + 1) / sampleRate;
          this.port.postMessage({ t: tEnd - (this.win / 2) / this.rate, ...this.detect(), peak: this.peak, ch: this.chan });
          this.peak = 0;
        }
      }
    }
    return true;
  }

  // Lowest point of d near lag t (searching ±r), within the lag range.
  dipNear(t, r) {
    let best = -1;
    for (let k = Math.max(this.minLag, t - r); k <= Math.min(this.maxLag, t + r); k++) {
      if (best < 0 || this.d[k] < this.d[best]) best = k;
    }
    return best;
  }

  detect() {
    const x = this.buf, W = this.win, d = this.d;
    let energy = 0;
    for (let i = 0; i < W; i++) energy += x[i] * x[i];
    const rms = Math.sqrt(energy / W);
    // -60 dB: quiet enough for the voice range profile's softest notes. The mic filter still
    // ignores anything under 0.004 (-48 dB) for everything else.
    if (rms < 0.001) return { hz: 0, clarity: 0, rms };
    const N = W - this.maxLag;
    // difference function
    for (let tau = 1; tau <= this.maxLag; tau++) {
      let sum = 0;
      for (let i = 0; i < N; i++) { const v = x[i] - x[i + tau]; sum += v * v; }
      d[tau] = sum;
    }
    // cumulative mean normalised difference
    d[0] = 1; let run = 0;
    for (let tau = 1; tau <= this.maxLag; tau++) {
      run += d[tau];
      d[tau] = run > 0 ? d[tau] * tau / run : 1;
    }
    let tau = -1;
    for (let t = this.minLag; t <= this.maxLag; t++) {
      if (d[t] < 0.15) {
        while (t + 1 <= this.maxLag && d[t + 1] < d[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) {
      // no dip under threshold: take the global minimum if it's decent
      let best = this.minLag;
      for (let t = this.minLag; t <= this.maxLag; t++) if (d[t] < d[best]) best = t;
      if (d[best] > 0.3) return { hz: 0, clarity: 1 - d[best], rms };
      tau = best;
    }
    // Octave-up check: a weak fundamental can leave the half period looking periodic enough to
    // pass. If twice the period is clearly cleaner (under 60% of the dip we took), use that.
    // A dip that's already very clean (under 0.04) is trusted as it is.
    if (d[tau] > 0.04 && 2 * tau <= this.maxLag) {
      const t2 = this.dipNear(2 * tau, 2);
      if (t2 > 0 && d[t2] < 0.6 * d[tau]) tau = t2;
    }
    // parabolic interpolation
    let better = tau;
    if (tau > 1 && tau < this.maxLag) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const den = a + c - 2 * b;
      if (den !== 0) better = tau + (a - c) / (2 * den);
    }
    return { hz: this.rate / better, clarity: 1 - d[tau], rms };
  }
}

if (typeof registerProcessor === 'function') registerProcessor('pitch-processor', PitchProcessor);
if (typeof module !== 'undefined') module.exports = { PitchProcessor, Biquad };
