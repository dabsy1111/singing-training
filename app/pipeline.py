"""Turn a YouTube link or an uploaded file into something you can sing against.

Steps for each song:
  1. fetch     - yt-dlp (or the uploaded file) -> source.wav
  2. separate  - Demucs htdemucs, two stems   -> vocals.wav + no_vocals.wav
  3. analyse   - CREPE pitch tracking on the vocal stem -> contour + note list
  4. encode    - mp3s the browser plays (accompaniment, vocal guide, original)
"""
import json
import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import numpy as np

from . import db

log = logging.getLogger("pipeline")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
SONGS_DIR = DATA_DIR / "songs"
MAX_MINUTES = float(os.environ.get("MAX_SONG_MINUTES", "12"))
CREPE_MODEL = os.environ.get("CREPE_MODEL", "tiny")       # tiny (fast) | full (~15x slower on CPU)
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs")  # htdemucs | htdemucs_ft | mdx_extra
THREADS = int(os.environ.get("PROCESS_THREADS", str(os.cpu_count() or 4)))
PLAYBACK_RATE = 32000   # matches the AudioContext rate the browser uses
HOP_S = 0.01            # 100 pitch frames per second

_jobs: "queue.Queue[tuple[str, dict]]" = queue.Queue()


class PipelineError(Exception):
    pass


def song_dir(song_id: str) -> Path:
    return SONGS_DIR / song_id


# --------------------------------------------------------------------------
# queue
# --------------------------------------------------------------------------

def enqueue(song_id: str, job: dict):
    _jobs.put((song_id, job))


def start_worker():
    t = threading.Thread(target=_worker, daemon=True, name="pipeline")
    t.start()


def _worker():
    import torch
    torch.set_num_threads(THREADS)
    while True:
        song_id, job = _jobs.get()
        try:
            process(song_id, job)
        except Exception as e:  # noqa: BLE001 - surface any failure to the UI
            log.exception("song %s failed", song_id)
            s = db.get_song(song_id) or {}
            if s.get("title") == "Fetching title…":
                db.update_song(song_id, title=s.get("source") or "Untitled")
            msg = str(e) if isinstance(e, PipelineError) else f"{type(e).__name__}: {e}"
            db.update_song(song_id, status="error", stage=None, error=msg[:2000])
        finally:
            _jobs.task_done()


def stage(song_id, text):
    log.info("%s: %s", song_id, text)
    db.update_song(song_id, status="processing", stage=text)


def process(song_id: str, job: dict):
    d = song_dir(song_id)
    d.mkdir(parents=True, exist_ok=True)
    src = d / "source.wav"

    if not src.exists():
        if job.get("url"):
            stage(song_id, "Downloading from YouTube")
            title, duration = fetch_youtube(job["url"], d, song_id)
            db.update_song(song_id, duration=duration)
        elif job.get("upload"):
            stage(song_id, "Converting upload")
            to_wav(Path(job["upload"]), src)
            Path(job["upload"]).unlink(missing_ok=True)
        else:
            raise PipelineError("Nothing to process: no URL or upload")

    duration = probe_duration(src)
    if duration > MAX_MINUTES * 60:
        raise PipelineError(f"This track is {_mins(duration)} long. Songs are limited to {MAX_MINUTES:g} min "
                            f"(raise MAX_SONG_MINUTES in the stack's .env to allow longer).")
    db.update_song(song_id, duration=duration)

    vocals, accomp = d / "vocals.wav", d / "no_vocals.wav"
    if not (vocals.exists() and accomp.exists()):
        stage(song_id, f"Splitting vocals from music (Demucs, ~{max(1, round(duration / 60 * 0.6))} min on CPU)")
        separate(src, d)

    stage(song_id, "Finding the vocal melody")
    analysis = analyse_vocals(vocals)
    analysis["duration"] = duration
    (d / "analysis.json").write_text(json.dumps(analysis, separators=(",", ":")))

    stage(song_id, "Encoding audio for the browser")
    encode_mp3(accomp, d / "accompaniment.mp3", channels=2)
    encode_mp3(vocals, d / "vocals.mp3", channels=1)
    encode_mp3(src, d / "original.mp3", channels=2)

    # Keep the stems' wavs only if asked; they're big.
    if os.environ.get("KEEP_WAV", "0") != "1":
        for f in (vocals, accomp):
            f.unlink(missing_ok=True)

    stage(song_id, "Working out the key")
    try:
        analysis["key"] = detect_key(d / "accompaniment.mp3", analysis["notes"])
        (d / "analysis.json").write_text(json.dumps(analysis, separators=(",", ":")))
    except Exception:  # noqa: BLE001 - key is a nice-to-have; the song still works without it
        log.exception("key detection failed for %s", song_id)

    stage(song_id, "Finding the lyrics")
    try:
        from . import lyrics
        title = (db.get_song(song_id) or {}).get("title") or ""
        lyrics.find(d, title, duration, analysis["notes"])
    except Exception as e:  # noqa: BLE001 - lyrics are optional; the song works without them
        log.info("no lyrics for %s: %s", song_id, e)

    lo, hi = analysis.get("range") or (None, None)
    db.update_song(song_id, status="ready", stage=None, error=None, note_low=lo, note_high=hi)


# --------------------------------------------------------------------------
# fetch
# --------------------------------------------------------------------------

def fetch_youtube(url: str, d: Path, song_id: str | None = None):
    import yt_dlp

    opts = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "outtmpl": str(d / "download.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
    }
    cookies = os.environ.get("YTDLP_COOKIES", str(DATA_DIR / "cookies.txt"))
    if cookies and Path(cookies).exists():
        opts["cookiefile"] = cookies
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            # Look first, so a too-long video fails fast with its real title and length.
            info = ydl.extract_info(url, download=False)
            if info is None:
                raise PipelineError("YouTube returned nothing for that link")
            title = info.get("title") or "Untitled"
            if song_id:
                cur = db.get_song(song_id) or {}
                if cur.get("title") in (None, "", "Fetching title…"):
                    db.update_song(song_id, title=title)
            dur = float(info.get("duration") or 0)
            if dur > MAX_MINUTES * 60:
                raise PipelineError(
                    f"This video is {_mins(dur)} long. Songs are limited to {MAX_MINUTES:g} min "
                    f"(raise MAX_SONG_MINUTES in the stack's .env to allow longer).")
            if info.get("is_live"):
                raise PipelineError("That's a live stream that's still going; try again once it's finished.")
            ydl.process_ie_result(info, download=True)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        if "not a bot" in msg or "Sign in" in msg:
            raise PipelineError(
                "YouTube wants a sign-in check for this server. Export your YouTube cookies to "
                "data/cookies.txt (see README) and press Retry.") from e
        if "unavailable" in msg.lower() or "private" in msg.lower():
            raise PipelineError("YouTube says that video isn't available (private, removed or region-locked).") from e
        if "truncated" in msg.lower() or "Unsupported URL" in msg or "Incomplete" in msg:
            raise PipelineError("That link doesn't look like a complete YouTube video link.") from e
        raise PipelineError(f"yt-dlp couldn't download it: {msg}") from e
    files = sorted(d.glob("download.*"))
    if not files:
        raise PipelineError("The download finished but there was no audio in it.")
    to_wav(files[0], d / "source.wav")
    for f in files:
        f.unlink(missing_ok=True)
    return title, dur


def _mins(sec: float) -> str:
    h, m = divmod(int(round(sec / 60)), 60)
    return f"{h} h {m} min" if h else f"{m} min"


def to_wav(src: Path, dst: Path):
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "2", "-ar", "44100", str(dst)])


def probe_duration(p: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def encode_mp3(src: Path, dst: Path, channels: int):
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-ac", str(channels),
         "-ar", str(PLAYBACK_RATE), "-b:a", "128k" if channels == 2 else "96k", str(dst)])


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise PipelineError(f"{Path(cmd[0]).name} failed: {(p.stderr or p.stdout)[-1500:]}")
    return p


# --------------------------------------------------------------------------
# separate
# --------------------------------------------------------------------------

def separate(src: Path, d: Path):
    out = d / "sep"
    cmd = [sys.executable, "-m", "demucs.separate", "-n", DEMUCS_MODEL, "--two-stems", "vocals",
           "-d", "cpu", "-j", "1", "-o", str(out), str(src)]
    env = dict(os.environ, OMP_NUM_THREADS=str(THREADS))
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if p.returncode != 0:
        raise PipelineError("Demucs failed: " + (p.stderr or p.stdout)[-1500:])
    stem_dir = out / DEMUCS_MODEL / src.stem
    shutil.move(str(stem_dir / "vocals.wav"), d / "vocals.wav")
    shutil.move(str(stem_dir / "no_vocals.wav"), d / "no_vocals.wav")
    shutil.rmtree(out, ignore_errors=True)


# --------------------------------------------------------------------------
# analyse
# --------------------------------------------------------------------------

def analyse_vocals(vocals: Path) -> dict:
    import librosa
    import torch
    import torchcrepe

    sr = 16000
    hop = int(sr * HOP_S)
    audio, _ = librosa.load(str(vocals), sr=sr, mono=True)

    # Loudness gate: Demucs leaves faint bleed in the vocal stem.
    rms = librosa.feature.rms(y=audio, frame_length=1024, hop_length=hop, center=True)[0]
    rms_db = 20 * np.log10(rms + 1e-9)
    gate = rms_db > (np.percentile(rms_db, 95) - 30)

    # Only run the pitch model where there's something to hear; silence is most of a vocal stem.
    n_frames = len(gate)
    f0 = np.zeros(n_frames, dtype=np.float32)
    per = np.zeros(n_frames, dtype=np.float32)
    for a, b in _regions(gate, pad=10, join=30):
        seg = audio[a * hop: b * hop]
        if len(seg) < 1024:
            continue
        x = torch.from_numpy(np.ascontiguousarray(seg)).unsqueeze(0)
        f, p = torchcrepe.predict(
            x, sr, hop, fmin=65.0, fmax=1100.0, model=CREPE_MODEL,
            decoder=torchcrepe.decode.viterbi, return_periodicity=True,
            batch_size=512, device="cpu",
        )
        p = torchcrepe.filter.median(p, 3)
        k = min(f.shape[1], b - a)
        f0[a:a + k] = f[0, :k].numpy()
        per[a:a + k] = p[0, :k].numpy()

    n = min(len(f0), len(gate))
    f0, per, gate = f0[:n], per[:n], gate[:n]
    voiced = (per > 0.45) & gate
    midi = np.full(n, np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440.0)
    midi = _median_nan(midi, 5)

    # Recordings aren't always tuned to A440. Measure the offset and snap notes to the song's own tuning.
    v = midi[~np.isnan(midi)]
    tuning = 0.0
    if len(v) > 200:
        tuning = float(np.angle(np.mean(np.exp(2j * np.pi * (v % 1)))) / (2 * np.pi))  # semitones, -0.5..0.5
    notes = segment_notes(midi - tuning)
    contour = [None if np.isnan(v) else round(float(v), 2) for v in midi]
    if notes:
        pitches = np.array([nt["midi"] for nt in notes])
        weights = np.array([nt["t1"] - nt["t0"] for nt in notes])
        lo = int(_weighted_pct(pitches, weights, 3))
        hi = int(_weighted_pct(pitches, weights, 97))
        rng = [lo, hi]
    else:
        rng = None
    # notes are in the song's tuning: the true pitch of a note is midi + tuning/100
    return {"hop": HOP_S, "contour": contour, "notes": notes, "range": rng, "tuning": round(tuning * 100, 1)}


def _regions(mask, pad, join):
    """Contiguous True runs in mask, padded and with small gaps joined: [(start, end), ...]."""
    idx = np.flatnonzero(mask)
    if not len(idx):
        return []
    out = []
    a = prev = idx[0]
    for i in idx[1:]:
        if i - prev > join:
            out.append((a, prev + 1))
            a = i
        prev = i
    out.append((a, prev + 1))
    return [(max(0, a - pad), min(len(mask), b + pad)) for a, b in out]


def _median_nan(x, k):
    """Median filter that leaves gaps as gaps."""
    h = k // 2
    padded = np.pad(x, h, constant_values=np.nan)
    win = np.lib.stride_tricks.sliding_window_view(padded, k)
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out = np.nanmedian(win, axis=1)
    out[np.isnan(x)] = np.nan
    return out


def _weighted_pct(values, weights, pct):
    order = np.argsort(values)
    v, w = values[order], weights[order]
    c = np.cumsum(w) / w.sum() * 100
    return v[min(np.searchsorted(c, pct), len(v) - 1)]


def segment_notes(midi, min_len=0.09, split_cents=60, settle_frames=4, merge_gap=0.05):
    """Group the pitch contour into discrete notes.

    A new note starts after a gap, or when the pitch sits more than
    `split_cents` away from the current note's median for `settle_frames`
    frames in a row (so vibrato and short glides don't split notes).
    """
    segs = []
    cur = []        # frame indices in current note
    away = []       # frames that have drifted from the current note
    for i, v in enumerate(midi):
        if np.isnan(v):
            if cur:
                segs.append(cur)
            cur, away = [], []
            continue
        if not cur:
            cur = [i]
            continue
        centre = np.median(midi[cur[-25:]])
        if abs(v - centre) * 100 > split_cents:
            away.append(i)
            if len(away) >= settle_frames:
                segs.append(cur)
                cur, away = away, []
        else:
            cur.extend(away)
            cur.append(i)
            away = []
    if cur:
        segs.append(cur + away)

    notes = []
    for s in segs:
        t0, t1 = s[0] * HOP_S, (s[-1] + 1) * HOP_S
        vals = midi[s]
        # Skip the first bit of the note when picking its pitch: that's where the scoop is.
        core = vals[len(vals) // 5:] if len(vals) > 10 else vals
        notes.append({"t0": round(t0, 3), "t1": round(t1, 3), "midi": int(round(float(np.median(core))))})

    merged = []
    for nt in notes:
        if merged and merged[-1]["midi"] == nt["midi"] and nt["t0"] - merged[-1]["t1"] <= merge_gap:
            merged[-1]["t1"] = nt["t1"]
        else:
            merged.append(nt)
    return [nt for nt in merged if nt["t1"] - nt["t0"] >= min_len]


# --------------------------------------------------------------------------
# key
# --------------------------------------------------------------------------

# Krumhansl-Kessler key profiles
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def detect_key(accompaniment: Path, notes: list) -> dict:
    """Estimate the key from the backing track's harmony plus the sung melody."""
    import librosa

    y, sr = librosa.load(str(accompaniment), sr=22050, mono=True)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=4096).sum(axis=1)
    profile = chroma / (chroma.sum() or 1)
    mel = np.zeros(12)
    for nt in notes:
        mel[nt["midi"] % 12] += nt["t1"] - nt["t0"]
    if mel.sum():
        profile = profile + 0.5 * mel / mel.sum()
    best = None
    for mode, prof in (("major", _MAJOR), ("minor", _MINOR)):
        for tonic in range(12):
            r = float(np.corrcoef(profile, np.roll(prof, tonic))[0, 1])
            if best is None or r > best["confidence"]:
                best = {"tonic": tonic, "mode": mode, "confidence": round(r, 3)}
    best["detected"] = True
    return best


# --------------------------------------------------------------------------
# transposed audio (made on request, cached next to the originals)
# --------------------------------------------------------------------------

_tlocks: dict[str, threading.Lock] = {}
_tlocks_guard = threading.Lock()


def transposed(song_id: str, semitones: int) -> dict:
    from concurrent.futures import ThreadPoolExecutor

    d = song_dir(song_id)
    with _tlocks_guard:
        lock = _tlocks.setdefault(f"{song_id}:{semitones}", threading.Lock())

    def one(stem, extra):
        name = f"{stem}.t{semitones}.mp3"
        dst = d / name
        if not dst.exists():
            tmp = d / f".{name}"
            ratio = 2 ** (semitones / 12)
            run(["ffmpeg", "-y", "-v", "error", "-i", str(d / f"{stem}.mp3"),
                 "-af", f"rubberband=pitch={ratio:.6f}:pitchq=quality{extra}",
                 "-ar", str(PLAYBACK_RATE), "-b:a", "128k" if stem == "accompaniment" else "96k",
                 "-f", "mp3", str(tmp)])
            tmp.rename(dst)
        return stem, f"/media/songs/{song_id}/{name}"

    with lock, ThreadPoolExecutor(2) as pool:   # music and guide vocal side by side
        return dict(pool.map(lambda a: one(*a), (("accompaniment", ""), ("vocals", ":formant=preserved"))))
