// Real-time pitch detection (YIN) running on the audio thread.
// Posts ~100 estimates a second: { t, hz, clarity, rms } where t is the
// AudioContext time at the centre of the analysis window.

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.decim = Math.max(1, Math.round(sampleRate / 16000)); // analyse at ~16 kHz
    this.rate = sampleRate / this.decim;
    this.win = Math.round(this.rate * 0.045);                  // 45 ms window -> down to ~65 Hz
    this.hop = Math.round(this.rate * 0.01);                   // 10 ms hop
    this.buf = new Float32Array(this.win);
    this.filled = 0;
    this.sinceHop = 0;
    this.acc = 0; this.accN = 0;
    this.minLag = Math.floor(this.rate / 1100);
    this.maxLag = Math.min(this.win - 2, Math.ceil(this.rate / 65));
    this.d = new Float32Array(this.maxLag + 2);
    this.lp = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // one-pole low-pass, then average-and-decimate
      this.lp += 0.5 * (ch[i] - this.lp);
      this.acc += this.lp; this.accN++;
      if (this.accN === this.decim) {
        const s = this.acc / this.decim;
        this.acc = 0; this.accN = 0;
        if (this.filled < this.win) this.buf[this.filled++] = s;
        else { this.buf.copyWithin(0, 1); this.buf[this.win - 1] = s; }
        if (++this.sinceHop >= this.hop && this.filled === this.win) {
          this.sinceHop = 0;
          // time of the newest sample minus half the window
          const tEnd = currentTime + (i + 1) / sampleRate;
          this.port.postMessage({ t: tEnd - (this.win / 2) / this.rate, ...this.detect() });
        }
      }
    }
    return true;
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

registerProcessor('pitch-processor', PitchProcessor);
