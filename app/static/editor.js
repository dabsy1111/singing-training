/* Vocal Lab: melody and backing-vocal editor (#/song/<id>/edit).
 *
 * Two kinds of mistake get fixed here:
 *  - wrong notes from the melody finder: move, stretch, split, join, add, delete, fit to the
 *    pitch line, octave jumps. Saved as the song's notes (the detected ones are kept for reset).
 *  - lead/backing mix-ups from the vocal separator: pick a time range and say what it really is
 *    (swapped, all lead, all backing). The server rebuilds the guide vocal, the backing vocal
 *    track and the music from the untouched split, then finds the melody again in that range.
 *
 * Drawing: time runs left to right, pitch bottom to top, like the song page. Top strip is the
 * time ruler (drag there to pick a range), bottom lane shows how loud the lead (blue) and the
 * backing vocals (amber) are, so a swapped stretch stands out. */
(function () {
  const RULER = 24, LYR = 18, LANE = 54, GUT = 36;
  const SNAP = 0.01, MIN_NOTE = 0.05, NUDGE = 0.05;
  const FIX_INFO = {
    swap: { label: 'Lead ⇄ backing swapped', short: 'swapped', col: 'rgba(190,120,255,', desc: 'The backing track has the tune and the guide vocal has the harmony. Swap them back.' },
    lead: { label: 'All lead vocal', short: 'all lead', col: 'rgba(122,162,255,', desc: 'It’s all the lead singer (a double or a harmony line got pulled into the backing). Move the backing vocals into the guide.' },
    backing: { label: 'All backing vocals', short: 'all backing', col: 'rgba(245,177,76,', desc: 'Nobody sings the tune here; it’s an ad-lib, choir or gang vocal. Move it out of the guide into the backing vocals, so there are no notes to sing.' },
  };
  const snap = t => Math.round(t / SNAP) * SNAP;
  const fmtT = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

  route(/^\/song\/([0-9a-f]{12})\/edit$/, async id => {
    let [song, an, s] = await Promise.all([api(`/api/songs/${id}`), api(`/api/songs/${id}/analysis`).catch(() => null), settings()]);
    view.innerHTML = `
      <div class="row"><h1 class="grow">Fix: <span id="edTitle">${esc(song.title)}</span></h1>
        <span class="dim small" id="edSave"></span>
        <a class="btn" href="#/song/${id}">Done</a></div>
      <details class="card how small" id="edHelp">
        <summary><b>How to fix things</b></summary>
        <ul>
          <li><b>A wrong note:</b> tap it, then drag it up or down (or use the buttons below). Drag sideways to move it in time, or drag its ends to make it longer or shorter.</li>
          <li><b>A missing note:</b> double-tap an empty spot to add one there. <b>An extra note:</b> tap it and press Delete.</li>
          <li><b>A whole stretch is wrong</b> (an octave out, or notes all over the place): drag along the time strip at the top to pick it, then use the range buttons.</li>
          <li><b>The guide vocal sings the harmony or a backing part</b>, or the real tune is in the backing vocals: pick the stretch along the top strip and choose what it really is. The bottom lane shows the lead singer in blue and the backing vocals in amber; where amber sits above blue, they’re probably swapped.</li>
          <li>Drag the background to look around, pinch or use − + to zoom. Tap the top strip to move the playhead. Changes save as you go; Undo works until you leave the page.</li>
        </ul>
      </details>
      <div id="edBusy"></div>
      <div class="controls ed-bar">
        <button class="primary" id="edPlay">▶ Play</button>
        <label><input type="checkbox" id="mLead" checked> Lead vocal</label>
        ${an?.backing ? '<label><input type="checkbox" id="mBack" checked> Backing vocals</label>' : ''}
        <label><input type="checkbox" id="mBand"> Music</label>
        <label><input type="checkbox" id="mTone" checked> Note tones</label>
        <span class="grow"></span>
        <button id="edUndo" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
        <button id="edRedo" title="Redo (Ctrl+Shift+Z)" disabled>↷</button>
      </div>
      <div class="stage ed" id="ed" style="height:min(58vh,520px)">
        <div class="zoom ed-zoom">
          <button data-zt="1" aria-label="Zoom in on time">+</button><button data-zt="-1" aria-label="Zoom out on time">−</button>
          <button data-zp="1" aria-label="Taller notes">↕+</button><button data-zp="-1" aria-label="Shorter notes">↕−</button>
        </div>
      </div>
      <div id="edPanel"></div>
      <div id="edFixes"></div>`;

    const box = $('#ed');
    const canvas = document.createElement('canvas'); box.prepend(canvas);
    let W = 0, H = 0, dpr = 1;
    const resize = () => {
      const r = box.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
      W = r.width; H = r.height; canvas.width = W * dpr; canvas.height = H * dpr;
    };
    resize(); window.addEventListener('resize', resize);

    // ------------------------------------------------------------ state
    let notes = [], auto = [], fixes = [], tune = 0, rev = 0, lyr = [], levels = null;
    let sel = new Set(), range = null, pos = 0, busy = false;
    const undo = [], redo = [];
    const v = { t0: 0, pps: 0, lo: 48, rows: 18 };

    function load(a) {
      an = a;
      notes = (a.notes || []).map(n => ({ t0: n.t0, t1: n.t1, midi: n.midi }));
      auto = (a.notes_auto || a.notes || []).map(n => ({ ...n }));
      fixes = (a.vocal_fixes || []).map(f => ({ ...f }));
      tune = (a.tuning || 0) / 100; rev = a.audio_rev || 0;
      sel = new Set(); undo.length = 0; redo.length = 0;
      PL.buffers = null; levels = null; loadLevels();
      renderPanel(); renderFixes(); undoButtons();
    }
    function initView() {
      v.pps = clamp(W / 7, 60, 160);
      const first = notes[0]?.t0 ?? 0;
      v.t0 = Math.max(0, first - 1); pos = v.t0;
      const PH = H - RULER - LYR - LANE;
      v.rows = clamp(Math.round(PH / 22), 12, 30);
      centreOn(v.t0, v.t0 + W / v.pps);
    }
    function centreOn(a, b) {
      const m = notes.filter(n => n.t1 > a && n.t0 < b).map(n => n.midi);
      const c = m.length ? (Math.min(...m) + Math.max(...m)) / 2 : (an?.range ? (an.range[0] + an.range[1]) / 2 : 60);
      v.lo = Math.round(c - v.rows / 2);
    }

    // ------------------------------------------------------------ geometry
    const dur = () => an?.duration || song.duration || 0;
    const PT = () => RULER + (lyr.length ? LYR : 0);
    const PH = () => H - PT() - LANE;
    const rowH = () => PH() / v.rows;
    const X = t => GUT + (t - v.t0) * v.pps;
    const T = x => v.t0 + (x - GUT) / v.pps;
    const Y = m => PT() + PH() - (m - v.lo + 0.5) * rowH();
    const M = y => v.lo + (PT() + PH() - y) / rowH() - 0.5;   // displayed pitch at y (true pitch)

    // ------------------------------------------------------------ editing helpers
    const snapshot = () => JSON.stringify(notes);
    function commit(before) {
      undo.push(before); if (undo.length > 200) undo.shift();
      redo.length = 0; undoButtons(); scheduleSave(); renderPanel();
    }
    function undoButtons() { $('#edUndo').disabled = !undo.length || busy; $('#edRedo').disabled = !redo.length || busy; }
    function restore(json) { notes = JSON.parse(json); sel = new Set(); scheduleSave(); renderPanel(); undoButtons(); }
    function doUndo() { if (!undo.length || busy) return; redo.push(snapshot()); restore(undo.pop()); }
    function doRedo() { if (!redo.length || busy) return; undo.push(snapshot()); restore(redo.pop()); }
    // Keep notes sorted and apart. Where two overlap, the one just edited keeps its place.
    function tidy(moved = sel) {
      for (const n of moved) { n.t0 = Math.max(0, snap(n.t0)); n.t1 = Math.max(n.t0 + MIN_NOTE, snap(n.t1)); }
      notes.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
      const out = [];
      for (const n of notes) {
        const p = out[out.length - 1];
        if (p && n.t0 < p.t1) {
          if (moved.has(p) && !moved.has(n)) n.t0 = p.t1; else p.t1 = n.t0;
          if (p.t1 - p.t0 < MIN_NOTE) { out.pop(); sel.delete(p); }
          if (n.t1 - n.t0 < MIN_NOTE) { sel.delete(n); continue; }
        }
        out.push(n);
      }
      notes = out;
    }
    function edit(fn) {   // run fn on the notes as one undoable step
      if (busy) return;
      const before = snapshot();
      fn();
      tidy();
      if (snapshot() !== before) commit(before); else renderPanel();
    }
    const selected = () => notes.filter(n => sel.has(n));
    const inRange = n => range && (n.t0 + n.t1) / 2 >= range.a && (n.t0 + n.t1) / 2 < range.b;
    // Pitch the singer actually sang over a note (median of the grey line), in note numbers.
    function fitPitch(n) {
      const hop = an.hop || 0.01, c = an.contour || [];
      const vals = [];
      for (let i = Math.floor(n.t0 / hop); i < Math.ceil(n.t1 / hop) && i < c.length; i++) if (c[i] !== null) vals.push(c[i]);
      if (vals.length < 0.3 * (n.t1 - n.t0) / hop || !vals.length) return null;
      vals.sort((a, b) => a - b);
      return Math.round(vals[Math.floor(vals.length / 2)] - tune);
    }
    function fit(list) {
      let changed = 0, none = 0;
      edit(() => { for (const n of list) { const m = fitPitch(n); if (m === null) none++; else if (m !== n.midi) { n.midi = m; changed++; } } });
      toast(`${changed} note${changed === 1 ? '' : 's'} moved to the pitch line` + (none ? ` · ${none} had no clear pitch to follow` : ''));
    }
    function addNote(t, m) {
      t = snap(t);
      const next = notes.find(n => n.t0 >= t), inside = notes.find(n => n.t0 <= t && n.t1 > t);
      if (inside) return toast('There’s already a note there');
      const end = Math.min(t + 0.3, next ? next.t0 : Infinity, dur());
      if (end - t < 0.08) return toast('No room for a note there');
      const n = { t0: t, t1: end, midi: Math.round(m - tune) };
      edit(() => { notes.push(n); sel = new Set([n]); });
    }
    function split(n) {
      const at = pos > n.t0 + MIN_NOTE && pos < n.t1 - MIN_NOTE ? snap(pos) : snap((n.t0 + n.t1) / 2);
      edit(() => { const b = { t0: at, t1: n.t1, midi: n.midi }; n.t1 = at; notes.push(b); sel = new Set([n, b]); });
    }
    function join(list) {
      if (list.length < 2) return;
      edit(() => {
        const longest = list.reduce((a, b) => (b.t1 - b.t0 > a.t1 - a.t0 ? b : a));
        const n = { t0: Math.min(...list.map(x => x.t0)), t1: Math.max(...list.map(x => x.t1)), midi: longest.midi };
        notes = notes.filter(x => !list.includes(x)); notes.push(n); sel = new Set([n]);
      });
    }

    // ------------------------------------------------------------ saving
    let saveTimer = 0, dirty = false, saving = null;
    const saveMsg = t => { $('#edSave') && ($('#edSave').textContent = t); };
    function scheduleSave() { dirty = true; saveMsg('Unsaved…'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 1000); }
    async function save() {
      clearTimeout(saveTimer);
      if (!dirty) return saving;
      dirty = false; saveMsg('Saving…');
      const body = { notes: notes.map(n => ({ t0: n.t0, t1: n.t1, midi: n.midi })) };
      saving = api(`/api/songs/${id}/notes`, { method: 'PUT', json: body })
        .then(() => { if (!dirty) saveMsg('Saved'); an.notes_edited = true; })
        .catch(e => { dirty = true; saveMsg('Not saved'); toast('Couldn’t save the notes: ' + e.message, 6000); });
      return saving;
    }
    function flushOnLeave() {
      if (!dirty) return;
      clearTimeout(saveTimer);
      try {
        fetch(`/api/songs/${id}/notes`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notes: notes.map(n => ({ t0: n.t0, t1: n.t1, midi: n.midi })) }) });
      } catch { /* best effort */ }
    }

    // ------------------------------------------------------------ playback
    const PL = { buffers: null, loading: null, playing: false, nodes: [], gains: {}, startCtx: 0, startPos: 0, to: 0 };
    async function buffers() {
      if (PL.buffers) return PL.buffers;
      if (!PL.loading) {
        const m = `/media/songs/${id}/`, q = `?r=${rev}`;
        const want = an.backing ? { lead: 'vocals', back: 'backing', band: 'band' } : { lead: 'vocals', band: 'accompaniment' };
        saveMsg('Loading audio…');
        PL.loading = Promise.all(Object.entries(want).map(async ([k, f]) => [k, await loadBuffer(m + f + '.mp3' + q)]))
          .then(e => { PL.buffers = Object.fromEntries(e); saveMsg(dirty ? 'Unsaved…' : ''); return PL.buffers; })
          .finally(() => { PL.loading = null; });
      }
      return PL.loading;
    }
    const mix = () => ({ lead: $('#mLead').checked, back: !!$('#mBack')?.checked, band: $('#mBand').checked, tone: $('#mTone').checked });
    const LEVEL = { lead: 1, back: 0.9, band: 0.6, tone: 0.9 };
    function now() { return PL.playing ? PL.startPos + (A.ctx.currentTime - PL.startCtx) : pos; }
    async function play(from, to = dur(), only = null) {
      stop();
      const ctxP = audioCtx();            // inside the tap, so iOS lets audio start
      let bufs;
      try { bufs = await buffers(); } catch (e) { return toast('Audio failed to load: ' + e.message); }
      const ctx = await ctxP;
      from = clamp(from, 0, dur()); to = clamp(to, from, dur());
      if (to - from < 0.1) return;
      const mx = only || mix();
      PL.master = ctx.createGain(); PL.master.connect(ctx.destination);
      PL.startCtx = ctx.currentTime + 0.1; PL.startPos = from; PL.to = to; PL.nodes = []; PL.gains = {};
      for (const k of ['lead', 'back', 'band']) {
        if (!bufs[k]) continue;
        const g = ctx.createGain(); g.gain.value = mx[k] ? LEVEL[k] : 0; g.connect(PL.master); PL.gains[k] = g;
        const src = ctx.createBufferSource(); src.buffer = bufs[k]; src.connect(g);
        src.start(PL.startCtx, from, to - from); PL.nodes.push(src);
      }
      const tg = ctx.createGain(); tg.gain.value = mx.tone ? LEVEL.tone : 0; tg.connect(PL.master); PL.gains.tone = tg;
      for (const n of notes) if (n.t1 > from && n.t0 < to) {
        const a = Math.max(n.t0, from);
        PL.nodes.push(...playTone(ctx, tg, n.midi + tune, PL.startCtx + a - from, Math.max(0.06, Math.min(n.t1, to) - a), 0.16));
      }
      PL.only = !!only; PL.playing = true; $('#edPlay').textContent = '■ Stop';
      clearTimeout(PL.timer); PL.timer = setTimeout(() => stop(true), (to - from + 0.25) * 1000);
    }
    function stop(ended = false) {
      if (!PL.playing) return;
      pos = ended ? PL.startPos : clamp(now(), 0, dur());
      PL.playing = false; clearTimeout(PL.timer);
      PL.nodes.forEach(n => { try { n.stop(); } catch { /* done */ } });
      PL.master?.disconnect(); PL.nodes = [];
      $('#edPlay') && ($('#edPlay').textContent = '▶ Play');
    }
    for (const [elId, k] of [['mLead', 'lead'], ['mBack', 'back'], ['mBand', 'band'], ['mTone', 'tone']]) {
      const el = $('#' + elId); if (!el) continue;
      el.onchange = () => { if (PL.playing && !PL.only && PL.gains[k]) PL.gains[k].gain.value = el.checked ? LEVEL[k] : 0; };
    }
    $('#edPlay').onclick = () => (PL.playing ? stop() : play(range && pos >= range.a && pos < range.b - 0.2 ? pos : range ? range.a : pos, range ? range.b : dur()));
    const hear = (a, b, only) => play(Math.max(0, a), Math.min(dur(), b), only);

    // ------------------------------------------------------------ lead/backing levels and lyrics
    async function loadLevels() {
      if (!an?.backing) return;
      const mine = rev;
      try { const l = await api(`/api/songs/${id}/levels`); if (mine === rev) levels = l; } catch { /* lane stays empty */ }
    }
    api(`/api/songs/${id}/lyrics`).then(r => {
      const L = r.lyrics;
      if (L?.synced) lyr = L.lines.filter(l => l.t0 != null).map(l => ({ t: l.t0 + (L.offset || 0), text: l.text }));
    }).catch(() => {});

    // ------------------------------------------------------------ drawing
    let raf = 0;
    function draw() {
      raf = requestAnimationFrame(draw);
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (!an) return;
      const t = now();
      if (PL.playing) {
        if (t >= PL.to) stop(true);
        else if (X(t) > W * 0.85 || X(t) < GUT) v.t0 = t - (W * 0.25) / v.pps;
      }
      const pt = PT(), ph = PH(), rh = rowH(), ta = T(GUT), tb = T(W);
      const mLo = Math.floor(v.lo) - 1, mHi = Math.ceil(v.lo + v.rows) + 1;
      g.save(); g.beginPath(); g.rect(0, pt, W, ph); g.clip();
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        if ([1, 3, 6, 8, 10].includes(pc)) { g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(GUT, Y(m) - rh / 2, W, rh); }
        if (pc === 0) { g.fillStyle = 'rgba(255,255,255,0.09)'; g.fillRect(GUT, Y(m) + rh / 2 - 1, W, 1); }
      }
      // fixed lead/backing ranges
      g.font = '600 11px system-ui'; g.textBaseline = 'top';
      for (const f of fixes) {
        if (f.t1 < ta || f.t0 > tb) continue;
        const I = FIX_INFO[f.mode];
        g.fillStyle = I.col + '0.10)'; g.fillRect(X(f.t0), pt, X(f.t1) - X(f.t0), ph);
        g.fillStyle = I.col + '0.9)'; g.fillRect(X(f.t0), pt, 2, ph); g.fillRect(X(f.t1) - 2, pt, 2, ph);
        g.fillText(I.short, Math.max(GUT + 2, X(f.t0) + 5), pt + 4);
      }
      // picked range
      if (range) {
        g.fillStyle = 'rgba(122,162,255,0.13)'; g.fillRect(X(range.a), pt, X(range.b) - X(range.a), ph);
        g.fillStyle = 'rgba(122,162,255,0.8)'; g.fillRect(X(range.a), pt, 1, ph); g.fillRect(X(range.b) - 1, pt, 1, ph);
      }
      // what the singer sang (grey line)
      const c = an.contour || [], hop = an.hop || 0.01;
      g.strokeStyle = 'rgba(170,180,210,0.55)'; g.lineWidth = 1.5; g.beginPath();
      let pen = false;
      for (let i = Math.max(0, Math.floor(ta / hop)); i <= Math.min(c.length - 1, Math.ceil(tb / hop)); i++) {
        if (c[i] === null) { pen = false; continue; }
        const x = X(i * hop), y = Y(c[i]);
        pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
      }
      g.stroke();
      // notes
      g.font = '11px system-ui'; g.textBaseline = 'middle';
      for (const n of notes) {
        if (n.t1 < ta || n.t0 > tb) continue;
        const x0 = X(n.t0), x1 = X(n.t1), y = Y(n.midi + tune), on = sel.has(n);
        g.fillStyle = on ? '#9db9ff' : 'rgba(122,135,175,0.75)';
        roundRect(g, x0, y - rh * 0.4, Math.max(3, x1 - x0 - 1), rh * 0.8, Math.min(5, rh * 0.3));
        if (on) {
          g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
          g.fillStyle = '#fff';
          if (x1 - x0 > 18) { g.fillRect(x0 + 2, y - rh * 0.25, 2, rh * 0.5); g.fillRect(x1 - 5, y - rh * 0.25, 2, rh * 0.5); }
        }
        if (x1 - x0 > 30 && rh > 11) { g.fillStyle = on ? '#0b1020' : 'rgba(255,255,255,0.85)'; g.fillText(noteName(n.midi), x0 + 6, y); }
      }
      g.restore();
      // ruler
      g.fillStyle = '#181b23'; g.fillRect(0, 0, W, RULER);
      g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(0, RULER - 1, W, 1);
      const step = v.pps > 90 ? 1 : v.pps > 30 ? 5 : v.pps > 12 ? 10 : 30;
      g.font = '10px system-ui'; g.textBaseline = 'middle';
      for (let s0 = Math.ceil(ta / step) * step; s0 <= tb; s0 += step) {
        const x = X(s0); g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x, RULER - 7, 1, 6);
        if (s0 % (step * (v.pps * step < 45 ? 2 : 1)) === 0) { g.fillStyle = 'rgba(200,205,220,0.75)'; g.fillText(fmtTime(s0), x + 3, 9); }
      }
      if (range) { g.fillStyle = 'rgba(122,162,255,0.55)'; g.fillRect(X(range.a), 0, X(range.b) - X(range.a), RULER - 1); }
      for (const f of fixes) if (f.t1 >= ta && f.t0 <= tb) { g.fillStyle = FIX_INFO[f.mode].col + '0.7)'; g.fillRect(X(f.t0), RULER - 4, X(f.t1) - X(f.t0), 3); }
      // lyrics strip
      if (lyr.length) {
        g.fillStyle = '#12141a'; g.fillRect(0, RULER, W, LYR);
        g.fillStyle = 'rgba(200,205,220,0.7)'; g.font = 'italic 11px system-ui';
        for (let i = 0; i < lyr.length; i++) {
          const l = lyr[i], end = lyr[i + 1]?.t ?? l.t + 8;
          if (end < ta || l.t > tb) continue;
          g.save(); g.beginPath(); g.rect(X(l.t), RULER, X(end) - X(l.t) - 4, LYR); g.clip();
          g.fillText(l.text, Math.max(GUT, X(l.t)) + 2, RULER + LYR / 2); g.restore();
        }
      }
      // lead vs backing lane
      const lt = H - LANE;
      g.fillStyle = '#12141a'; g.fillRect(0, lt, W, LANE);
      g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(0, lt, W, 1);
      if (levels) {
        const lh = levels.hop, base = H - 3, h = LANE - 8;
        const i0 = Math.max(0, Math.floor(ta / lh)), i1 = Math.ceil(tb / lh);
        const curve = (arr, fill, stroke) => {
          if (!arr?.length) return;
          g.beginPath(); g.moveTo(X(i0 * lh), base);
          for (let i = i0; i <= Math.min(i1, arr.length - 1); i++) g.lineTo(X(i * lh), base - h * arr[i] / 100);
          g.lineTo(X(Math.min(i1, arr.length - 1) * lh), base);
          if (fill) { g.fillStyle = fill; g.fill(); }
          if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke(); }
        };
        curve(levels.lead, 'rgba(122,162,255,0.45)', null);
        curve(levels.backing, null, 'rgba(245,177,76,0.95)');
      }
      for (const f of fixes) if (f.t1 >= ta && f.t0 <= tb) { g.fillStyle = FIX_INFO[f.mode].col + '0.12)'; g.fillRect(X(f.t0), lt, X(f.t1) - X(f.t0), LANE); }
      if (range) { g.fillStyle = 'rgba(122,162,255,0.12)'; g.fillRect(X(range.a), lt, X(range.b) - X(range.a), LANE); }
      g.font = '10px system-ui'; g.textBaseline = 'top';
      g.fillStyle = '#7aa2ff'; g.fillText('lead', 4, lt + 3);
      if (an.backing) { g.fillStyle = '#f5b14c'; g.fillText('backing', 4, lt + 15); }
      else { g.fillStyle = 'rgba(200,205,220,0.6)'; g.fillText('backing vocals are mixed into the music for this song', GUT + 30, lt + 3); }
      // note names
      g.fillStyle = '#0f1116'; g.fillRect(0, pt, GUT, ph);
      g.save(); g.beginPath(); g.rect(0, pt, GUT, ph); g.clip();
      g.font = '10px system-ui'; g.textBaseline = 'middle';
      for (let m = mLo; m <= mHi; m++) {
        const pc = ((m % 12) + 12) % 12;
        if ([1, 3, 6, 8, 10].includes(pc) && rh < 15) continue;
        g.fillStyle = pc === 0 ? 'rgba(232,234,240,0.95)' : 'rgba(200,205,220,0.6)';
        g.fillText(noteName(m), 3, Y(m));
      }
      g.restore();
      // playhead
      const px = X(t);
      if (px >= GUT) { g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(px, 0, 1.5, H); }
    }

    // ------------------------------------------------------------ touch and mouse
    const pts = new Map();
    let drag = null, pinch = null, lastTap = null;
    const fine = () => matchMedia('(pointer: fine)').matches;
    function hit(x, y) {
      const rh = rowH(); let best = null;
      for (const n of notes) {
        const x0 = X(n.t0), x1 = Math.max(X(n.t1), x0 + 10), ny = Y(n.midi + tune);
        if (x >= x0 - 2 && x <= x1 + 2 && Math.abs(y - ny) <= Math.max(rh / 2, 9)) {
          if (!best || sel.has(n)) best = n;
        }
      }
      return best;
    }
    const zone = y => (y < RULER + (lyr.length ? LYR : 0) ? 'ruler' : y > H - LANE ? 'lane' : 'pitch');
    function local(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener('pointerdown', e => {
      if (!an || busy) return;
      canvas.setPointerCapture(e.pointerId);
      const p = local(e); pts.set(e.pointerId, p);
      if (pts.size === 2) {   // pinch: zoom time around the middle of the two fingers
        if (drag?.before && snapshot() !== drag.before) { notes = JSON.parse(drag.before); sel = new Set(); }
        drag = null;
        const [a, b] = [...pts.values()];
        pinch = { d: Math.max(20, Math.abs(a.x - b.x)), pps: v.pps, t: T((a.x + b.x) / 2) };
        return;
      }
      if (pts.size > 2) return;
      const z = zone(p.y);
      if (z !== 'pitch') { drag = { kind: 'range', a: snap(clamp(T(p.x), 0, dur())), x0: p.x }; return; }
      const n = hit(p.x, p.y);
      if (n) {
        const multi = e.shiftKey || e.metaKey || e.ctrlKey;
        let wasSel = sel.has(n);
        if (multi) { if (wasSel) sel.delete(n); else sel.add(n); wasSel = false; }
        else if (!wasSel) sel = new Set([n]);
        renderPanel();
        const x0 = X(n.t0), x1 = X(n.t1), edge = fine() ? 6 : 12;
        let kind = 'move';
        if (sel.has(n) && x1 - x0 > edge * 3) { if (p.x - x0 < edge) kind = 'left'; else if (x1 - p.x < edge) kind = 'right'; }
        drag = { kind, n, x0: p.x, y0: p.y, before: snapshot(), orig: selected().map(m => [m, m.t0, m.t1, m.midi]), axis: null, tapSel: wasSel && !multi };
      } else {
        drag = { kind: 'pan', x0: p.x, y0: p.y, t0: v.t0, lo: v.lo, moved: false };
      }
    });
    canvas.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e); pts.set(e.pointerId, p);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        v.pps = clamp(pinch.pps * Math.max(20, Math.abs(a.x - b.x)) / pinch.d, 4, 600);
        v.t0 = pinch.t - ((a.x + b.x) / 2 - GUT) / v.pps;
        return;
      }
      if (!drag) return;
      const dx = p.x - drag.x0, dy = p.y - drag.y0;
      if (drag.kind === 'range') {
        const b = snap(clamp(T(p.x), 0, dur()));
        if (Math.abs(p.x - drag.x0) > 6) { range = { a: Math.min(drag.a, b), b: Math.max(drag.a, b) }; drag.moved = true; }
      } else if (drag.kind === 'pan') {
        if (Math.hypot(dx, dy) > 5) drag.moved = true;
        if (drag.moved) { v.t0 = drag.t0 - dx / v.pps; v.lo = drag.lo + dy / rowH(); }
      } else if (drag.kind === 'move') {
        if (!drag.axis && Math.hypot(dx, dy) > 7) drag.axis = e.altKey ? 'xy' : Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
        if (!drag.axis) return;
        const dt = drag.axis !== 'y' ? dx / v.pps : 0, dm = drag.axis !== 'x' ? -Math.round(dy / rowH()) : 0;
        const minT0 = Math.min(...drag.orig.map(o => o[1]));
        const shift = Math.max(dt, -minT0);
        for (const [m, t0, t1, midi] of drag.orig) { m.t0 = t0 + shift; m.t1 = t1 + shift; m.midi = midi + dm; }
      } else {
        const tt = clamp(T(p.x), 0, dur()), n = drag.n;
        if (drag.kind === 'left') n.t0 = Math.min(tt, n.t1 - MIN_NOTE); else n.t1 = Math.max(tt, n.t0 + MIN_NOTE);
        drag.axis = 'x';
      }
    });
    const end = e => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e); pts.delete(e.pointerId);
      if (pinch) { if (!pts.size) pinch = null; return; }
      const d = drag; drag = null;
      if (!d) return;
      if (d.kind === 'range') {
        if (!d.moved) { range = null; pos = d.a; if (PL.playing) play(pos); }
        else if (range.b - range.a < 0.2) range = null;
        renderPanel();
      } else if (d.kind === 'pan') {
        if (d.moved) return;
        const tap = { t: performance.now(), x: p.x, y: p.y };
        if (lastTap && tap.t - lastTap.t < 380 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 24) { lastTap = null; addNote(T(p.x), M(p.y)); return; }
        lastTap = tap;
        if (sel.size) { sel = new Set(); renderPanel(); }
        pos = clamp(T(p.x), 0, dur());
      } else {
        const before = d.before;
        if (d.axis) { tidy(); if (snapshot() !== before) commit(before); else renderPanel(); }
        else if (d.tapSel && sel.size > 1) { sel = new Set([d.n]); renderPanel(); }
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {   // pinch on a trackpad, or ctrl + wheel
        const p = local(e), t = T(p.x);
        v.pps = clamp(v.pps * Math.exp(-e.deltaY * 0.01), 4, 600); v.t0 = t - (p.x - GUT) / v.pps;
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        v.t0 += (e.deltaX || e.deltaY) / v.pps;
      } else v.lo -= e.deltaY / rowH() / 2;
    }, { passive: false });
    box.querySelector('.ed-zoom').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.zt) { const mid = T((GUT + W) / 2); v.pps = clamp(v.pps * (b.dataset.zt === '1' ? 1.5 : 1 / 1.5), 4, 600); v.t0 = mid - (W - GUT) / 2 / v.pps; }
      if (b.dataset.zp) { const mid = v.lo + v.rows / 2; v.rows = clamp(v.rows + (b.dataset.zp === '1' ? -3 : 3), 6, 60); v.lo = mid - v.rows / 2; }
    };
    $('#edUndo').onclick = doUndo; $('#edRedo').onclick = doRedo;

    function onKey(e) {
      if (e.target.closest('input, textarea, select') || busy) return;
      const k = e.key, mod = e.ctrlKey || e.metaKey, list = selected();
      if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (mod && k.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
      if (k === ' ') { e.preventDefault(); $('#edPlay').click(); return; }
      if (k === 'Escape') { sel = new Set(); range = null; renderPanel(); return; }
      if (!list.length) return;
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); edit(() => { notes = notes.filter(n => !sel.has(n)); sel = new Set(); }); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); const d = (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1); edit(() => list.forEach(n => { n.midi += d; })); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); const d = k === 'ArrowLeft' ? -NUDGE : NUDGE; edit(() => list.forEach(n => { n.t0 += d; n.t1 += d; })); }
    }
    window.addEventListener('keydown', onKey);

    // ------------------------------------------------------------ side panel
    const panel = $('#edPanel');
    function renderPanel() {
      const list = selected();
      let html = '';
      if (list.length) {
        const one = list.length === 1 ? list[0] : null;
        const names = [...new Set(list.map(n => noteName(n.midi)))];
        html += `<div class="card ed-card"><div class="row"><b class="grow">${one ? `${noteName(one.midi)} · ${fmtT(one.t0)}–${fmtT(one.t1)}` : `${list.length} notes (${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''})`}</b>
          <button data-a="hearSel">▶ Hear</button></div>
          <div class="ed-btns">
            <span class="ed-grp"><span class="dim small">Pitch</span><button data-a="up">▲</button><button data-a="down">▼</button><button data-a="octUp" title="An octave up">8va ▲</button><button data-a="octDown" title="An octave down">8va ▼</button><button data-a="fit" title="Move to what the singer sang (the grey line)">Fit to line</button></span>
            <span class="ed-grp"><span class="dim small">Time</span><button data-a="left" title="Earlier">◀</button><button data-a="right" title="Later">▶</button>
              ${one ? `<span class="dim small">start</span><button data-a="s-" title="Start earlier">−</button><button data-a="s+" title="Start later">+</button><span class="dim small">end</span><button data-a="e-" title="End earlier">−</button><button data-a="e+" title="End later">+</button>` : ''}</span>
            <span class="ed-grp">${one ? '<button data-a="split" title="Split at the playhead (or in half)">Split</button>' : '<button data-a="join">Join into one</button>'}<button data-a="del" class="danger">Delete</button></span>
          </div></div>`;
      }
      if (range) {
        const n = notes.filter(inRange).length;
        html += `<div class="card ed-card"><div class="row"><b class="grow">Range ${fmtT(range.a)}–${fmtT(range.b)} <span class="dim small">(${n} note${n === 1 ? '' : 's'})</span></b><button data-a="clearRange" title="Clear the range">✕</button></div>
          <div class="ed-btns">
            <span class="ed-grp"><span class="dim small">Listen</span><button data-a="hearRange">▶ As set above</button><button data-a="hearLead">Lead only</button>${an.backing ? '<button data-a="hearBack">Backing only</button>' : ''}</span>
            <span class="ed-grp"><span class="dim small">Notes</span><button data-a="selRange">Select them</button><button data-a="fitRange">Fit to line</button><button data-a="octUpRange">8va ▲</button><button data-a="octDownRange">8va ▼</button><button data-a="resetRange" title="Put back the notes the melody finder found here">Detected notes</button><button data-a="delRange" class="danger">Delete</button></span>
          </div>
          ${an.backing ? `<div class="ed-vox"><span class="dim small">The vocals here are really…</span>
            ${Object.entries(FIX_INFO).map(([k, I]) => `<button data-fix="${k}" title="${esc(I.desc)}">${esc(I.label)}</button>`).join('')}</div>`
            : `<p class="dim small">Lead/backing fixes need the backing vocals on their own track. Re-analyse this song from the song page first.</p>`}
        </div>`;
      }
      if (!list.length && !range) {
        html += `<p class="dim small">Tap a note to change it, double-tap to add one, or drag along the time strip at the top to pick a stretch.
          ${notes.length ? `${notes.length} notes.` : ''} ${an?.notes_edited ? '<button data-a="resetAll" class="danger">Reset all notes to the detected ones</button>' : ''}</p>`;
      }
      panel.innerHTML = html;
      panel.querySelectorAll('button').forEach(b => { b.disabled = busy; });
    }
    panel.onclick = async e => {
      const b = e.target.closest('button'); if (!b || busy) return;
      const list = selected(), a = b.dataset.a;
      const shift = (ns, d) => edit(() => ns.forEach(n => { n.midi += d; }));
      const move = (ns, d) => edit(() => { const k = Math.max(d, -Math.min(...ns.map(n => n.t0))); ns.forEach(n => { n.t0 += k; n.t1 += k; }); });
      if (b.dataset.fix) return askFix(b.dataset.fix);
      switch (a) {
        case 'hearSel': if (list.length) hear(Math.min(...list.map(n => n.t0)) - 0.4, Math.max(...list.map(n => n.t1)) + 0.4); break;
        case 'up': shift(list, 1); break;
        case 'down': shift(list, -1); break;
        case 'octUp': shift(list, 12); break;
        case 'octDown': shift(list, -12); break;
        case 'fit': fit(list); break;
        case 'left': move(list, -NUDGE); break;
        case 'right': move(list, NUDGE); break;
        case 's-': edit(() => { list[0].t0 = Math.max(0, list[0].t0 - NUDGE); }); break;
        case 's+': edit(() => { list[0].t0 = Math.min(list[0].t1 - MIN_NOTE, list[0].t0 + NUDGE); }); break;
        case 'e-': edit(() => { list[0].t1 = Math.max(list[0].t0 + MIN_NOTE, list[0].t1 - NUDGE); }); break;
        case 'e+': edit(() => { list[0].t1 = Math.min(dur(), list[0].t1 + NUDGE); }); break;
        case 'split': split(list[0]); break;
        case 'join': join(list); break;
        case 'del': edit(() => { notes = notes.filter(n => !sel.has(n)); sel = new Set(); }); break;
        case 'clearRange': range = null; renderPanel(); break;
        case 'hearRange': hear(range.a, range.b); break;
        case 'hearLead': hear(range.a, range.b, { lead: true }); break;
        case 'hearBack': hear(range.a, range.b, { back: true }); break;
        case 'selRange': sel = new Set(notes.filter(inRange)); renderPanel(); break;
        case 'fitRange': fit(notes.filter(inRange)); break;
        case 'octUpRange': shift(notes.filter(inRange), 12); break;
        case 'octDownRange': shift(notes.filter(inRange), -12); break;
        case 'delRange': edit(() => { notes = notes.filter(n => !inRange(n)); sel = new Set(); }); break;
        case 'resetRange': edit(() => {
          const back = auto.filter(inRange).map(n => ({ ...n }));
          notes = notes.filter(n => !inRange(n)).concat(back); sel = new Set(back);
        }); break;
        case 'resetAll':
          if (!confirm('Throw away all your note changes for this song and go back to the notes the melody finder found?')) return;
          try { clearTimeout(saveTimer); dirty = false; await saving; const r = await api(`/api/songs/${id}/notes/reset`, { method: 'POST' }); an.notes = r.notes; delete an.notes_edited; delete an.notes_auto; load(an); saveMsg('Reset'); } catch (err) { toast(err.message); }
          break;
      }
    };

    // ------------------------------------------------------------ lead/backing fixes
    function askFix(mode) {
      const I = FIX_INFO[mode], r = { ...range };
      const clash = fixes.filter(f => f.t1 > r.a && f.t0 < r.b);
      const w = modal(`<h2 style="margin-top:0">${esc(I.label)}</h2>
        <p>${esc(I.desc)}</p>
        <p class="dim small">${fmtT(r.a)}–${fmtT(r.b)}. The guide vocal, backing vocals and music get rebuilt and the melody is found again in this stretch; your note changes inside it are replaced. Takes about a minute. You can undo it later from the list under the editor.</p>
        ${clash.length ? `<p class="small">This replaces ${clash.length === 1 ? 'the fix' : `${clash.length} fixes`} already in this stretch.</p>` : ''}
        <div class="row"><button class="primary" data-go>Fix it</button><button data-cancel>Cancel</button></div>`);
      w.querySelector('[data-cancel]').onclick = () => w.remove();
      w.querySelector('[data-go]').onclick = async () => {
        w.remove();
        // Trim fixes that overlap the new one rather than refusing: keep whatever sticks out either side.
        const next = [];
        for (const f of fixes) {
          if (f.t1 <= r.a || f.t0 >= r.b) { next.push(f); continue; }
          if (f.t0 < r.a - 0.2) next.push({ ...f, t1: r.a });
          if (f.t1 > r.b + 0.2) next.push({ ...f, t0: r.b });
        }
        next.push({ t0: r.a, t1: r.b, mode });
        await sendFixes(next);
      };
    }
    async function sendFixes(next) {
      stop();
      try {
        await save();
        await api(`/api/songs/${id}/vocal-fixes`, { method: 'PUT', json: { fixes: next.map(f => ({ t0: f.t0, t1: f.t1, mode: f.mode })) } });
      } catch (e) { return toast(e.message, 6000); }
      range = null; waitForSong();
    }
    function renderFixes() {
      const el = $('#edFixes');
      if (!fixes.length) { el.innerHTML = ''; return; }
      el.innerHTML = `<div class="card"><b>Lead/backing fixes</b>
        ${fixes.map((f, i) => `<div class="row ed-fix"><i style="background:${FIX_INFO[f.mode].col}0.9)"></i><span class="grow">${fmtT(f.t0)}–${fmtT(f.t1)} · ${esc(FIX_INFO[f.mode].label)}</span>
          <button data-show="${i}">Show</button><button data-undo="${i}" title="Remove this fix">✕</button></div>`).join('')}
        <p class="dim small" style="margin-bottom:0">Removing a fix puts back what the separator made there and finds the melody again in that stretch.</p></div>`;
      el.querySelectorAll('button').forEach(b => { b.disabled = busy; });
      el.onclick = e => {
        const b = e.target.closest('button'); if (!b || busy) return;
        if (b.dataset.show) {
          const f = fixes[+b.dataset.show];
          range = { a: f.t0, b: f.t1 }; pos = f.t0;
          v.pps = clamp((W - GUT) * 0.7 / Math.max(0.5, f.t1 - f.t0), 4, 300); v.t0 = f.t0 - (W - GUT) * 0.15 / v.pps;
          centreOn(f.t0, f.t1); renderPanel();
        } else if (b.dataset.undo && confirm('Remove this fix?')) sendFixes(fixes.filter((_, i) => i !== +b.dataset.undo));
      };
    }

    // ------------------------------------------------------------ waiting on the server
    let pollTimer = 0;
    function setBusy(on, msg = '') {
      busy = on;
      $('#edBusy').innerHTML = on ? `<div class="card nudge row"><span class="grow">${esc(msg)}</span></div>` : '';
      undoButtons(); renderPanel(); renderFixes();
    }
    async function waitForSong() {
      setBusy(true, 'Rebuilding the vocals and finding the melody again… usually about a minute. You can leave this page; it carries on.');
      const tick = async () => {
        let st;
        try { st = await api(`/api/songs/${id}`); } catch { pollTimer = setTimeout(tick, 4000); return; }
        if (st.status === 'ready') {
          try { load(await api(`/api/songs/${id}/analysis`)); } catch (e) { toast(e.message); }
          setBusy(false);
          if (!raf) { initView(); raf = requestAnimationFrame(draw); }
          if (st.error) toast(st.error, 8000); else toast('Done. Have a listen.');
          renderFixes();
        } else if (st.status === 'error') {
          setBusy(true, 'That didn’t work: ' + (st.error || 'unknown error') + ' Try Retry on the song list.');
        } else {
          $('#edBusy .grow') && ($('#edBusy .grow').textContent = `${st.stage || 'Waiting'}… usually about a minute. You can leave this page; it carries on.`);
          pollTimer = setTimeout(tick, 3000);
        }
      };
      pollTimer = setTimeout(tick, 2000);
    }

    cleanup = () => {
      flushOnLeave(); stop(); cancelAnimationFrame(raf); clearTimeout(pollTimer); clearTimeout(saveTimer);
      window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey);
    };

    if (!an || song.status !== 'ready') {
      an = an || null;
      if (song.status === 'queued' || song.status === 'processing') {
        waitForSong();
        if (!an) return;
      } else if (!an) { view.insertAdjacentHTML('beforeend', `<div class="card err">${esc(song.error || 'This song isn’t ready yet.')}</div>`); return; }
    }
    load(an);
    initView();
    raf = requestAnimationFrame(draw);
  }, 'songs');
})();
