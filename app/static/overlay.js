'use strict';
/* Listen back: a recorded take played over the original song, lined up in time, with its own
 * mix (you, the singer, the music) and an option to put the singer in one ear and you in the other.
 *
 * A take is the mic recording of a song run. The run's details say where in the song it started
 * (section.from) and at what key and speed. Runs from Dec 2026 on also store takeSync.lead: how many
 * seconds into the recording the song's start landed, with this device's headphone and mic delay
 * already in it. Older takes don't have that, so their start is guessed and then lined up by matching
 * the starts of your sung syllables to the singer’s. The − / + timing buttons fix the rest; it’s kept per take. */

let OVL = null;   // the open player: leaving the page or pressing Sing closes it
function stopOverlay() { OVL?.close(); OVL = null; }

const OVL_MIX_KEY = 'vl-ovl-mix';
const ovlNudgeKey = id => 'vl-ovl-nudge-' + id;
function ovlMix() {
  const d = { me: 1, vocals: 0.8, backing: 0.6, accomp: 0.5, split: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(OVL_MIX_KEY) || '{}') }; } catch { return d; }
}
function saveOvlMix(m) { try { localStorage.setItem(OVL_MIX_KEY, JSON.stringify(m)); } catch { /* ignore */ } }

// The song page's "Your takes" list: recorded takes of this song, newest first.
async function songTakes(el, songId) {
  if (!el) return;
  let runs;
  try { runs = (await api(`/api/runs?kind=song&ref=${songId}&limit=60`)).filter(r => r.take).slice(0, 12); } catch { return; }
  if (!document.body.contains(el)) return;
  if (!runs.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<h2>Your takes</h2><div class="card table-wrap"><table>
    ${runs.map(r => `<tr><td class="small">${fmtDate(r.created)}</td><td class="small dim">${esc(ovlBits(r.title))}</td>
      <td>${r.score == null ? '–' : Math.round(r.score) + '%'}</td>
      <td class="row" style="justify-content:flex-end"><button data-overlay="${r.id}">🎧 Over the song</button></td></tr>`).join('')}
    </table><p class="small dim">Plays your recording over the original, lined up, so you can hear where you and the singer differ.</p></div>`;
  el.onclick = e => { const b = e.target.closest('[data-overlay]'); if (b) openOverlay(+b.dataset.overlay); };
}
// "Song (−2 st, 80% speed)" → "−2 st, 80% speed"
const ovlBits = title => (String(title || '').match(/\(([^()]*)\)\s*$/) || [])[1] || '';

async function openOverlay(runId) {
  stopOverlay();
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="card ovl"><div class="row"><h2 class="grow" style="margin:0">Loading your take…</h2><button data-a="close" aria-label="Close">✕</button></div></div>`;
  document.body.appendChild(wrap);
  const player = OVL = new OverlayPlayer(wrap);
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-a="close"]')) { if (OVL === player) OVL = null; player.close(); } });
  try { await player.load(runId); }
  catch (e) { if (!player.closed) wrap.querySelector('h2').textContent = e.message; }
}

class OverlayPlayer {
  constructor(wrap) { this.wrap = wrap; this.closed = false; this.playing = false; this.nodes = []; this.mix = ovlMix(); }

  async load(runId) {
    const run = await api(`/api/runs/${runId}`);
    if (!run.take || run.kind !== 'song') throw new Error('This run has no recording to play over a song.');
    const d = run.details || {};
    let an;
    try { an = await api(`/api/songs/${run.ref}/analysis`); } catch { throw new Error('That song isn’t in your library any more.'); }
    this.run = run; this.an = an;
    this.rate = (d.speed || 100) / 100;
    this.from = d.section?.from ?? 0;
    // Where the song's start sits in the recording, in real seconds. Older takes: the 0.15 s lead-in
    // plus this device's delay, then the auto line-up below.
    this.known = typeof d.takeSync?.lead === 'number';
    this.lead = this.known ? d.takeSync.lead : 0.15 + deviceLatencyMs() / 1000;
    const urls = await songAudioUrls(run.ref, an, d.transpose || 0, d.speed || 100);
    let take;
    const [accomp, backing, vocals] = await Promise.all([loadBuffer(urls.band || urls.accompaniment),
      urls.band && urls.backing ? loadBuffer(urls.backing) : null, loadBuffer(urls.vocals),
      ovlTake(run.take).then(b => { take = b; })]);
    if (this.closed) return;
    this.buf = { accomp, backing, vocals, me: take };
    // the take's span in song seconds
    this.start = this.from;
    this.end = Math.min(an.duration, this.from + (take.duration - this.lead) * this.rate);
    if (this.end - this.start < 1) throw new Error('This recording is too short to play over the song.');
    this.pos = this.start;
    const saved = localStorage.getItem(ovlNudgeKey(runId));
    this.nudge = saved !== null ? Number(saved) || 0 : 0;
    this.render(run, d);
    if (saved === null && !this.known) this.autoLineUp(true);
    else this.note(this.known ? 'Lined up from when you sang it, with this device’s headphone delay taken out.' : '');
  }

  render(run, d) {
    const bits = [ovlBits(run.title), run.score == null ? '' : `${Math.round(run.score)}%`, fmtDate(run.created)].filter(Boolean).join(' · ');
    const m = this.mix, slider = (k, label) => `<label>${label} <input type="range" min="0" max="1.5" step="0.05" data-v="${k}" value="${m[k]}"></label>`;
    this.wrap.querySelector('.card').innerHTML = `
      <div class="row"><h2 class="grow" style="margin:0">${esc(run.title.replace(/\s*\([^()]*\)\s*$/, ''))}</h2><button data-a="close" aria-label="Close">✕</button></div>
      <p class="dim small" style="margin:4px 0 10px">${esc(bits)}</p>
      <div class="row ovl-transport">
        <button class="primary" data-a="play">▶ Play</button>
        <input type="range" class="grow" data-a="seek" min="${this.start}" max="${this.end}" step="0.05" value="${this.pos}" aria-label="Position">
        <span class="small dim" data-a="time"></span>
      </div>
      <div class="controls ovl-mix">
        ${slider('me', 'Me')}${slider('vocals', 'Singer')}${this.buf.backing ? slider('backing', 'Backing vocals') : ''}${slider('accomp', 'Music')}
        <label><input type="checkbox" data-a="split" ${m.split ? 'checked' : ''}> Singer in left ear, me in right</label>
      </div>
      <div class="row small ovl-timing">
        <span class="dim">My timing</span>
        <button data-a="nudge" data-d="-0.05" title="My voice 50 ms earlier">−50</button>
        <button data-a="nudge" data-d="-0.01" title="My voice 10 ms earlier">−10</button>
        <span data-a="off" style="min-width:110px;text-align:center"></span>
        <button data-a="nudge" data-d="0.01" title="My voice 10 ms later">+10</button>
        <button data-a="nudge" data-d="0.05" title="My voice 50 ms later">+50</button>
      </div>
      <div class="row small">
        <button data-a="auto">Line up automatically</button>
        <button data-a="reset" title="Back to the recorded timing">As recorded</button>
      </div>
      <p class="dim small" data-a="note"></p>`;
    const card = this.wrap.querySelector('.card');
    this.q = sel => card.querySelector(`[data-a="${sel}"]`);
    card.addEventListener('click', e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'play') this.playing ? this.pause() : this.play(this.pos >= this.end - 0.2 ? this.start : this.pos);
      if (a === 'nudge') this.setNudge(this.nudge + Number(e.target.closest('[data-d]').dataset.d));
      if (a === 'auto') this.autoLineUp(false);
      if (a === 'reset') { this.setNudge(0); this.note('Back to the recorded timing.'); }
    });
    card.addEventListener('input', e => {
      const k = e.target.dataset.v;
      if (k) { this.mix[k] = +e.target.value; this.gains?.[k] && (this.gains[k].gain.value = this.mix[k]); saveOvlMix(this.mix); }
      if (e.target.dataset.a === 'seek') { this.pos = +e.target.value; if (this.playing) this.play(this.pos); this.tick(); }
      if (e.target.dataset.a === 'split') { this.mix.split = e.target.checked; saveOvlMix(this.mix); this.pan(); }
    });
    this.showNudge(); this.tick();
    this.raf = requestAnimationFrame(this.loop = () => { this.tick(); this.raf = requestAnimationFrame(this.loop); });
  }

  now() { return this.playing ? Math.min(this.end, this.p0 + (A.ctx.currentTime - this.T0) * this.rate) : this.pos; }

  tick() {
    if (!this.q) return;
    const t = this.now();
    if (this.playing && t >= this.end - 0.01) { this.pause(); this.pos = this.start; }
    const seek = this.q('seek');
    if (document.activeElement !== seek) seek.value = t;
    this.q('time').textContent = `${fmtTime(t - this.start)} / ${fmtTime(this.end - this.start)}`;
  }

  async play(p) {
    this.stopNodes();
    const ctx = await audioCtx();
    if (this.closed) return;
    const T0 = ctx.currentTime + 0.08;
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    this.gains = {}; this.pans = {};
    for (const k of ['accomp', 'backing', 'vocals', 'me']) {
      const buf = this.buf[k]; if (!buf) continue;
      const g = ctx.createGain(); g.gain.value = this.mix[k];
      const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pn) { g.connect(pn); pn.connect(this.master); this.pans[k] = pn; } else g.connect(this.master);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(g);
      if (k === 'me') { src.disconnect(); this.startMe(ctx, T0, p, g); }
      else { src.start(T0, p / this.rate); this.nodes.push(src); }
      this.gains[k] = g;
    }
    this.pan();
    this.T0 = T0; this.p0 = p; this.playing = true;
    this.q('play').textContent = '❚❚ Pause';
  }

  // Your take on its own, so the timing slider can move it while the song keeps playing.
  // Song time p is (p − from)/rate real seconds after the song's start, which sits `lead` into the take.
  startMe(ctx, when, p, g) {
    try { this.meSrc?.stop(); } catch { /* not started */ }
    const src = this.meSrc = ctx.createBufferSource(); src.buffer = this.buf.me; src.connect(g);
    let off = this.lead + (p - this.from) / this.rate - this.nudge;
    if (off < 0) { when -= off; off = 0; }
    if (off < src.buffer.duration) src.start(when, off);
  }

  pan() {
    const s = this.mix.split ? 1 : 0;
    if (this.pans.vocals) this.pans.vocals.pan.value = -s;
    if (this.pans.backing) this.pans.backing.pan.value = -s;
    if (this.pans.me) this.pans.me.pan.value = s;
  }

  pause() {
    if (!this.playing) return;
    this.pos = this.now();
    this.stopNodes();
    this.q && (this.q('play').textContent = '▶ Play');
  }

  stopNodes() {
    this.playing = false;
    [...this.nodes, this.meSrc].forEach(n => { try { n?.stop(); } catch { /* not started */ } });
    this.nodes = []; this.meSrc = null; this.master?.disconnect(); this.master = null; this.pans = {};
  }

  setNudge(v) {
    this.nudge = Math.round(clamp(v, -1, 1) * 1000) / 1000;
    try { localStorage.setItem(ovlNudgeKey(this.run.id), String(this.nudge)); } catch { /* ignore */ }
    this.showNudge();
    // Move just your voice, a moment ahead, so a tap doesn't restart the song.
    if (this.playing && this.gains?.me) {
      const ctx = A.ctx, when = ctx.currentTime + 0.03;
      this.startMe(ctx, when, this.p0 + (when - this.T0) * this.rate, this.gains.me);
    }
  }
  showNudge() {
    const ms = Math.round(this.nudge * 1000);
    this.q('off').textContent = ms === 0 ? 'as recorded' : `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms ${ms > 0 ? 'later' : 'earlier'}`;
  }
  note(t) { if (this.q) this.q('note').textContent = t; }

  // Match where your syllables start to where the singer's do, within ±0.6 s of the recorded timing.
  autoLineUp(first) {
    const r = ovlBestLag(this.buf.vocals, this.buf.me, this.from / this.rate, this.lead, (this.end - this.start) / this.rate);
    if (!r) {
      this.note(first ? 'This take is from before recordings kept their timing, and it couldn’t be lined up automatically. Use − and + until you sound together.'
        : 'Couldn’t find a clear match with the singer. Use − and + instead.');
      return;
    }
    this.setNudge(r.nudge);
    const ms = Math.round(r.nudge * 1000);
    this.note((first ? 'This take is from before recordings kept their timing, so it was lined up automatically' : 'Lined up automatically')
      + ` (${ms === 0 ? 'no change' : `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms`}). That matches your syllable starts to the singer’s, so it also hides any singing that was early or late.`);
  }

  close() {
    this.closed = true;
    this.stopNodes();
    cancelAnimationFrame(this.raf);
    this.wrap.remove();
  }
}

// Takes aren't cached with the songs: each is played once or twice. Chrome records WebM and
// iPhones record MP4; older Safari can't open WebM, so say so rather than fail quietly.
async function ovlTake(name) {
  const r = await fetch(`/media/takes/${name}`);
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!r.ok) throw new Error(r.status === 404 ? 'The recording has been deleted.' : `${r.status} loading the recording`);
  const data = await r.arrayBuffer();
  try { return await new OfflineAudioContext(1, 1, 32000).decodeAudioData(data); }
  catch { throw new Error(name.endsWith('.webm') ? 'This browser can’t open the recording (it was made in Chrome as WebM). Try it in Chrome or a newer Safari.' : 'This browser can’t open the recording.'); }
}

// Onset strength at 10 ms steps: how sharply the loudness rises. Loudness is log RMS scaled
// between the recording's own quiet (20th percentile) and loud (95th) levels, so a phone mic and
// a studio vocal compare. Syllable starts line up between you and the singer even when pitch and tone differ.
function ovlOnsets(buf, t0, dur, hop = 0.01) {
  const x = buf.getChannelData(0), sr = buf.sampleRate, n = Math.max(0, Math.floor(dur / hop)), w = Math.round(sr * hop);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.round((t0 + i * hop) * sr);
    let s = 0, c = 0;
    for (let j = Math.max(0, a); j < Math.min(x.length, a + w); j++) { s += x[j] * x[j]; c++; }
    e[i] = Math.log10((c ? s / c : 0) + 1e-7);
  }
  const srt = Float32Array.from(e).sort(), lo = srt[Math.floor(n * 0.2)] ?? 0, hi = srt[Math.floor(n * 0.95)] ?? 1;
  const span = hi - lo > 0.3 ? hi - lo : 0;   // under ~3 dB between quiet and loud: nothing sung
  const f = new Float32Array(n);
  if (!span) return f;
  const lv = i => clamp((e[i] - lo) / span, 0, 1);
  for (let i = 3; i < n; i++) f[i] = Math.max(0, lv(i) - lv(i - 3));
  let mean = 0; for (const v of f) mean += v; mean /= n || 1;
  for (let i = 0; i < n; i++) f[i] -= mean;
  return f;
}

// Best extra delay for the take (seconds, + = play it later). vocals: the song's guide vocal buffer,
// read from vStart; take: read from tStart; both over dur real seconds. Null if nothing stands out.
function ovlBestLag(vocals, take, vStart, tStart, dur, maxLag = 0.6) {
  const hop = 0.01, L = Math.round(maxLag / hop);
  // read the take with room either side for the search
  const v = ovlOnsets(vocals, vStart, dur, hop);
  const tk = ovlOnsets(take, tStart - maxLag, dur + 2 * maxLag, hop);
  const norm = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
  const nv = norm(v);
  const scores = [];
  for (let lag = -L; lag <= L; lag++) {
    // take frame for v[i] sits at i + L + lag (lag > 0: your voice arrives later than expected)
    let s = 0, tt = 0;
    for (let i = 0; i < v.length; i++) { const y = tk[i + L + lag] || 0; s += v[i] * y; tt += y * y; }
    scores.push(s / (nv * (Math.sqrt(tt) || 1)));
  }
  let bi = 0; for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  const best = scores[bi];
  const sorted = [...scores].sort((a, b) => a - b), median = sorted[sorted.length >> 1];
  // needs a clear peak, and not just the edge of the search
  if (!(best >= 0.08) || best - median < 0.05 || bi === 0 || bi === scores.length - 1) return null;
  // the take runs lag frames late, so read it that much further in: a smaller nudge
  return { nudge: -(bi - L) * hop, score: best };
}
