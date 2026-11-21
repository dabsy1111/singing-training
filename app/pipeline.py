"""Turn a YouTube link or an uploaded file into something you can sing against.

Steps for each song:
  1. fetch     - yt-dlp (or the uploaded file) -> source.wav
  2. separate  - Demucs htdemucs, two stems   -> vocals.wav + no_vocals.wav
  3. lead      - UVR-MDX-NET Karaoke 2 on the vocal stem -> lead.wav + backing.wav
                 (band.mp3 and backing.mp3 are kept apart too, for separate faders)
                 (harmonies, doubles and gang vocals go back into the music)
  4. analyse   - SwiftF0 pitch tracking on the lead vocal -> contour + note list
  5. encode    - mp3s the browser plays (accompaniment, vocal guide, original)

Tested on 43 MUSDB18 clips against the studio vocal stems, and on a studio vs
live recording of the same song (see the project design notes).
"""
import json
import logging
import os
import queue
import re
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
PITCH_MODEL = os.environ.get("PITCH_MODEL", "swiftf0")   # swiftf0 | crepe (CREPE_MODEL picks tiny/full)
CREPE_MODEL = os.environ.get("CREPE_MODEL", "tiny")       # tiny (fast) | full (~15x slower on CPU)
LEAD_SPLIT = os.environ.get("LEAD_SPLIT", "1") == "1"     # split lead from backing vocals
KARAOKE_MODEL = Path(os.environ.get("KARAOKE_MODEL", "/models/UVR_MDXNET_KARA_2.onnx"))
NOTE_MODEL = os.environ.get("NOTE_MODEL", "game_checked")  # game_checked (GAME notes the pitch line backs up) | game | contour (notes from the pitch line)
GAME_MODEL = Path(os.environ.get("GAME_MODEL", "/models/GAME-1.0.3-small-onnx"))
ANALYSIS_VERSION = 4   # 3: GAME notes + loudness curve; 4: GAME notes checked against the pitch line. bump when re-analysing would give a better melody
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
    if "fix_vocals" in job:
        return refix(song_id, d, job["fix_vocals"], job.get("ranges") or [])
    if job.get("lookup_notes"):
        return lookup_notes_job(song_id, d)
    split_wanted = split_backing_wanted()
    if (job.get("unsplit") or (job.get("reanalyse") and not split_wanted)) and is_split(d):
        return unsplit(song_id, d)
    if job.get("reanalyse") and can_renote(d) and split_wanted:
        return renote(song_id, d)

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

    old = {}
    if job.get("reanalyse") and (d / "analysis.json").exists():
        old = json.loads((d / "analysis.json").read_text())

    vocals, accomp = d / "vocals.wav", d / "no_vocals.wav"
    if not (vocals.exists() and accomp.exists()):
        stage(song_id, f"Splitting vocals from music (Demucs, ~{max(1, round(duration / 60 * 0.6))} min on CPU)")
        separate(src, d)

    if cut_part(song_id, d, src, vocals, accomp, duration):   # songbook pick: keep just a verse and chorus
        duration = probe_duration(src)
        db.update_song(song_id, duration=duration)

    guide, music, backing = vocals, accomp, None
    lead_split = False
    if LEAD_SPLIT and KARAOKE_MODEL.exists() and split_wanted:
        stage(song_id, f"Separating the lead singer from backing vocals (~{max(1, round(duration / 60 * 0.5))} min)")
        guide, music, backing = split_lead(d, vocals, accomp)
        lead_split = True
    elif LEAD_SPLIT and split_wanted:
        log.warning("lead/backing split skipped: %s not found", KARAOKE_MODEL)

    stage(song_id, "Finding the vocal melody")
    analysis = analyse_vocals(guide)
    analysis["duration"] = duration
    analysis["v"] = ANALYSIS_VERSION
    analysis["lead_split"] = lead_split
    analysis["pitch_model"] = PITCH_MODEL
    analysis["backing"] = backing is not None   # band.mp3 + backing.mp3 exist, for a separate fader
    if old.get("key") and old["key"].get("detected") is False:
        analysis["key"] = old["key"]    # keep a key the user set by hand
    analysis["audio_rev"] = int(old.get("audio_rev", 0)) + 1
    (d / "analysis.json").write_text(json.dumps(analysis, separators=(",", ":")))

    stage(song_id, "Encoding audio for the browser")
    for f in d.glob("*.*.mp3"):         # key/speed-shifted copies of the old audio
        f.unlink(missing_ok=True)
    for f in ORIG_FILES.values():       # pre-fix copies of the old split
        (d / f).unlink(missing_ok=True)
    (d / "levels.json").unlink(missing_ok=True)
    encode_mp3(music, d / "accompaniment.mp3", channels=2)
    if backing is not None:              # instruments and backing vocals apart, for the faders
        encode_mp3(backing[0], d / "band.mp3", channels=2)
        encode_mp3(backing[1], d / "backing.mp3", channels=2)
    else:
        for f in ("band.mp3", "backing.mp3"):
            (d / f).unlink(missing_ok=True)
    encode_mp3(guide, d / "vocals.mp3", channels=1)
    if not (d / "original.mp3").exists() or not job.get("reanalyse"):
        encode_mp3(src, d / "original.mp3", channels=2)

    # Keep the stems' wavs only if asked; they're big.
    if os.environ.get("KEEP_WAV", "0") != "1":
        for f in (vocals, accomp, d / "lead.wav", d / "music.wav", d / "backing.wav", d / "band.wav"):
            f.unlink(missing_ok=True)

    fixes = old.get("vocal_fixes") or []
    if fixes and backing is not None:
        # The new split makes the same lead/backing mix-ups the user already fixed by hand
        # (same model, same song), so put their fixes back and find the melody again.
        stage(song_id, "Putting your lead/backing vocal fixes back")
        apply_vocal_fixes(d, fixes)
        fixed = analyse_vocals(d / "vocals.mp3", tuning=analysis["tuning"] / 100)
        for k in ("contour", "notes", "range", "loud", "loud_hop", "note_model"):
            analysis[k] = fixed[k]
        analysis["vocal_fixes"] = fixes
    if "note_choice" in old:
        analysis["note_choice"] = old["note_choice"]
    external_notes(song_id, d, analysis)
    keep_edited_notes(old, analysis)
    (d / "analysis.json").write_text(json.dumps(analysis, separators=(",", ":")))

    if "key" not in analysis:
        stage(song_id, "Working out the key")
        try:
            analysis["key"] = detect_key(d / "accompaniment.mp3", analysis["notes"])
            (d / "analysis.json").write_text(json.dumps(analysis, separators=(",", ":")))
        except Exception:  # noqa: BLE001 - key is a nice-to-have; the song still works without it
            log.exception("key detection failed for %s", song_id)

    from . import lyrics
    if job.get("reanalyse") and lyrics.load(d):
        pass    # keep the lyrics (and any edits) the song already has
    elif part_lyrics(d, analysis["notes"]):
        pass    # the cut part's lines, from the same LRCLIB record that placed the cut
    else:
        stage(song_id, "Finding the lyrics")
        try:
            title = (db.get_song(song_id) or {}).get("title") or ""
            lyrics.find(d, title, duration, analysis["notes"])
        except Exception as e:  # noqa: BLE001 - lyrics are optional; the song works without them
            log.info("no lyrics for %s: %s", song_id, e)

    lo, hi = analysis.get("range") or (None, None)
    db.update_song(song_id, status="ready", stage=None, error=None, note_low=lo, note_high=hi)


# --------------------------------------------------------------------------
# part of a song: songbook picks keep a verse and chorus instead of the whole track
# --------------------------------------------------------------------------
# part.json (written when the song is added): {label, start, end, lrclib, lrc_duration}; start/end are
# in the LRCLIB record's (album) time. The video can run earlier or later than the album, so the
# record's lines are lined up with where the separated vocal is singing before cutting.
# After the cut: done, offset (video = album + offset), clip [a, b] in video time, lines (album time).

PART_LEAD_S = 3.0     # music before the first sung line, to hear the count-in
PART_TAIL_S = 2.0


def _activity(vocals: Path, hop: float = 0.1) -> np.ndarray:
    """1 where the separated vocal is singing, per hop."""
    import soundfile as sf
    x, sr = sf.read(str(vocals), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    n = int(sr * hop)
    frames = len(x) // n
    if frames < 10:
        return np.zeros(0)
    rms = np.sqrt((x[: frames * n].reshape(frames, n) ** 2).mean(axis=1) + 1e-12)
    db_ = 20 * np.log10(rms)
    return (db_ > np.percentile(db_, 95) - 25).astype(float)


def part_offset(lines: list[dict], act: np.ndarray, search: float, hop: float = 0.1) -> tuple[float, float]:
    """Seconds to add to the record's times so its sung lines sit on the vocal: (offset, match 0..1).
    The match is the correlation between 'a line is being sung' and 'the vocal is active'."""
    if not len(act) or not lines:
        return 0.0, 0.0
    sung = np.zeros(len(act) + int(search / hop) * 2 + 10)
    for l in lines:
        a, b = l["t0"], min(l["t1"], l["t0"] + 6.0)
        sung[int(a / hop): max(int(a / hop) + 1, int(b / hop))] = 1
    best = (0.0, -1.0)
    zero = None
    for k in range(-int(search / hop), int(search / hop) + 1):
        # vocal frame i is album time i*hop - offset; offset = k*hop
        idx = np.arange(len(act)) - k
        ok = (idx >= 0) & (idx < len(sung))
        if ok.sum() < 100:
            continue
        v, s = act[ok], sung[idx[ok]]
        if v.std() == 0 or s.std() == 0:
            continue
        c = float(np.corrcoef(v, s)[0, 1])
        if k == 0:
            zero = c
        if c > best[1] + 1e-9 or (abs(c - best[1]) <= 1e-9 and abs(k) < abs(best[0] / hop)):
            best = (k * hop, c)
    off, c = best
    # cautious, like the lyrics aligner: only move when the match is clear
    if c < 0.2 or (zero is not None and off != 0 and c < zero + 0.03):
        return 0.0, zero or 0.0
    return round(off, 2), round(c, 3)


def _trim(p: Path, a: float, b: float):
    tmp = p.with_suffix(".cut" + p.suffix)
    fade_out = max(0.1, min(PART_TAIL_S, (b - a) / 4))
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(p),
         "-af", f"afade=t=in:d=0.3,afade=t=out:st={max(0.0, b - a - fade_out):.3f}:d={fade_out:.3f}",
         "-c:a", "pcm_f32le" if p.name != "source.wav" else "pcm_s16le", str(tmp)])
    tmp.replace(p)


def cut_part(song_id: str, d: Path, src: Path, vocals: Path, accomp: Path, duration: float) -> bool:
    """Cut source and stems down to the song's part. True if it cut now."""
    pp = d / "part.json"
    if not pp.exists():
        return False
    try:
        part = json.loads(pp.read_text())
    except ValueError:
        return False
    if part.get("done"):
        return False
    stage(song_id, f"Cutting out the part to sing ({part.get('label', 'verse and chorus').lower()})")
    from . import lyrics
    lines = part.get("lines")
    if not lines and part.get("lrclib"):
        try:
            rec = lyrics.lrclib_get(part["lrclib"]) or {}
            lines = lyrics.parse_lrc(rec.get("syncedLyrics") or "")
        except Exception:  # noqa: BLE001 - without the record the cut uses album time as is
            log.warning("couldn't fetch LRCLIB %s for %s", part.get("lrclib"), song_id, exc_info=True)
            lines = []
    dd = abs(duration - (part.get("lrc_duration") or duration))
    off, match = part_offset(lines or [], _activity(vocals), search=max(20.0, min(240.0, dd + 20)))
    a = max(0.0, part["start"] + off - PART_LEAD_S)
    b = min(duration, part["end"] + off + PART_TAIL_S)
    if b - a < 15:      # the cut landed off the end of the video: keep the whole song
        log.warning("part %s..%s (offset %s) doesn't fit %s s for %s; keeping the whole song",
                    part["start"], part["end"], off, duration, song_id)
        part.update(done=True, skipped=True)
        pp.write_text(json.dumps(part))
        return False
    for p in (vocals, accomp, src):
        _trim(p, a, b)
    part.update(done=True, offset=off, match=match, clip=[round(a, 2), round(b, 2)],
                full_duration=round(duration, 2), lines=lines or [])
    pp.write_text(json.dumps(part))
    log.info("cut %s to %.1f-%.1f s (offset %+.1f, match %.2f)", song_id, a, b, off, match)
    return True


def part_lyrics(d: Path, notes: list) -> bool:
    """Lyrics for a cut song: the record's lines moved into the clip's time, nudged onto the notes."""
    pp = d / "part.json"
    if not pp.exists():
        return False
    try:
        part = json.loads(pp.read_text())
    except ValueError:
        return False
    if not (part.get("done") and part.get("clip") and part.get("lines")):
        return False
    from . import lyrics
    a, b = part["clip"]
    shift = part.get("offset", 0.0) - a
    lines = [{"t0": round(l["t0"] + shift, 2), "t1": round(l["t1"] + shift, 2), "text": l["text"]}
             for l in part["lines"] if l["t1"] + shift > 0.3 and l["t0"] < part["end"] - 0.5]
    if not lines:
        return False
    lyrics.save(d, {"source": "lrclib", "synced": True, "lines": lines, "offset": lyrics.best_offset(lines, notes, search=4.0),
                    "match": {"artist": part.get("artist"), "track": part.get("title"), "id": part.get("lrclib"),
                              "duration": part.get("lrc_duration"), "part": part.get("label")}})
    return True


def split_backing_wanted() -> bool:
    """Settings → 'Split backing vocals from the lead'. Off: the guide vocal is every voice
    Demucs pulled out of the music, and the melody is found from all of them."""
    try:
        return bool(db.get_settings().get("splitBacking"))
    except Exception:  # noqa: BLE001 - no database (tools, tests): use the old behaviour
        return True


def is_split(d: Path) -> bool:
    try:
        an = json.loads((d / "analysis.json").read_text())
    except (OSError, ValueError):
        return False
    return bool(an.get("backing")) and (d / "backing.mp3").exists() and (d / "band.mp3").exists()


def unsplit(song_id: str, d: Path):
    """Put the backing vocals back into the guide vocal: guide = lead + backing (the same
    voices Demucs split from the music, in mono), music = the band alone. Quick: no
    separation, just a mix of the stems the song already has, then the melody found again.
    Any lead/backing fixes from the editor stop mattering (they only moved sound between
    the two), so they're dropped. Notes fixed by hand are kept."""
    an = json.loads((d / "analysis.json").read_text())
    stage(song_id, "Putting the backing vocals back into the guide vocal")
    lead = _decode(d / "vocals.mp3", 1)[:, 0]
    back = _decode(d / "backing.mp3", 2).mean(axis=1)
    n = min(len(lead), len(back))
    vox = lead[:n] + back[:n]
    peak = float(np.abs(vox).max()) if n else 0.0
    if peak > 0.999:
        vox *= 0.999 / peak
    _encode(vox[:, None], d / "vocals.mp3")
    shutil.copy2(d / "band.mp3", d / ".accompaniment.mp3")
    (d / ".accompaniment.mp3").replace(d / "accompaniment.mp3")
    for f in ["band.mp3", "backing.mp3", "levels.json", *ORIG_FILES.values()]:
        (d / f).unlink(missing_ok=True)
    for f in d.glob("*.*.mp3"):
        f.unlink(missing_ok=True)
    stage(song_id, "Finding the vocal melody")
    out = analyse_vocals(d / "vocals.mp3", tuning=(an.get("tuning") or 0) / 100)
    out["duration"] = an.get("duration")
    if "key" in an:
        out["key"] = an["key"]
    out["v"] = ANALYSIS_VERSION
    out["lead_split"] = False
    out["backing"] = False
    out["pitch_model"] = PITCH_MODEL
    out["audio_rev"] = int(an.get("audio_rev", 0)) + 1
    keep_edited_notes(an, out)
    tmp = d / ".analysis.json"
    tmp.write_text(json.dumps(out, separators=(",", ":")))
    tmp.replace(d / "analysis.json")
    lo, hi = out.get("range") or (None, None)
    db.update_song(song_id, status="ready", stage=None, error=None, note_low=lo, note_high=hi)


def can_renote(d: Path) -> bool:
    """Songs from analysis v2 already have the lead vocal split out (vocals.mp3), so moving
    them to v3 (GAME notes, loudness) only needs the melody step again, not Demucs."""
    p = d / "analysis.json"
    if not (p.exists() and (d / "vocals.mp3").exists()):
        return False
    try:
        an = json.loads(p.read_text())
    except ValueError:
        return False
    return an.get("v", 1) >= 2 and bool(an.get("lead_split")) and bool(an.get("backing"))


def renote(song_id: str, d: Path):
    old = json.loads((d / "analysis.json").read_text())
    stage(song_id, "Finding the vocal melody")
    analysis = analyse_vocals(d / "vocals.mp3")
    for k in ("duration", "lead_split", "backing", "key", "vocal_fixes", "audio_rev"):
        if k in old:
            analysis[k] = old[k]
    analysis["v"] = ANALYSIS_VERSION
    analysis["pitch_model"] = PITCH_MODEL
    if "note_choice" in old:
        analysis["note_choice"] = old["note_choice"]
    external_notes(song_id, d, analysis)
    keep_edited_notes(old, analysis)
    (d / "analysis.json").write_text(json.dumps(analysis, separators=(",", ":")))
    lo, hi = analysis.get("range") or (None, None)
    db.update_song(song_id, status="ready", stage=None, error=None, note_low=lo, note_high=hi)


# --------------------------------------------------------------------------
# charted notes: karaoke / rhythm-game charts instead of the melody finder's guess
# --------------------------------------------------------------------------

def pitch_line(analysis: dict) -> np.ndarray:
    """The singer's pitch in semitones with the song's tuning taken off (what notes are in)."""
    c = np.array([np.nan if v is None else v for v in analysis.get("contour") or []], dtype=float)
    return c - float(analysis.get("tuning") or 0) / 100


def note_query(song_id: str, d: Path) -> dict:
    from . import lyrics
    from .notesources import video_id
    s = db.get_song(song_id) or {}
    url = s.get("source") or ""
    meta = ensure_meta(d, url) if url.startswith("http") else {}
    title = s.get("title") or ""
    hyps = []
    clip0 = 0.0
    pp = d / "part.json"
    if pp.exists():
        try:
            part = json.loads(pp.read_text())
            if part.get("artist") and part.get("title"):
                hyps.append((part["artist"], part["title"]))
            title = re.sub(r"\s*\([^)]*\)\s*$", "", title)
            if part.get("done") and not part.get("skipped") and part.get("clip"):
                clip0 = float(part["clip"][0])
        except ValueError:
            pass
    for h in lyrics.guesses(title, meta):
        if h not in hyps:
            hyps.append(h)
    return {"video": video_id(url), "hyps": hyps[:4], "title": title, "clip0": clip0}


def apply_note_choice(analysis: dict, found: dict, choice: str | None = None) -> dict | None:
    """Set analysis["notes"] from the chosen chart (or the best one), keeping the detected
    notes in notes_detected. choice: "detected", "<source>:<id>", or None for automatic."""
    detected = analysis.get("notes_detected")
    if detected is None:
        detected = analysis["notes_detected"] = analysis.get("notes") or []
    cands = found.get("candidates") or []
    pick = None
    if choice and choice != "detected":
        pick = next((c for c in cands if f"{c['source']}:{c['id']}" == choice and c.get("notes")), None)
    elif choice is None:
        pick = next((c for c in cands if c["verdict"] == "use"), None) or \
            next((c for c in cands if c["verdict"] == "merge"), None)
    if pick is None:
        analysis["notes"] = detected
        analysis.pop("note_source", None)
    else:
        chart = [{"t0": n["t0"], "t1": n["t1"], "midi": n["midi"]} for n in pick["notes"]]
        mode = "merge" if pick["verdict"] == "merge" or (pick.get("partial") and choice) else "use"
        from .notesources import merge_into
        analysis["notes"] = merge_into(detected, chart) if mode == "merge" else chart
        analysis["note_source"] = {k: pick.get(k) for k in ("source", "id", "title", "by", "url", "metrics", "offset",
                                                            "scale", "shift", "same_video")}
        analysis["note_source"]["mode"] = mode
    analysis["range"] = note_range(analysis["notes"])
    return pick


def external_notes(song_id: str, d: Path, analysis: dict):
    """Look the song up in karaoke and rhythm-game charts; use a chart whose notes sit on the
    singer's pitch line. Never fails the song: on any trouble the detected notes stay."""
    from . import notesources
    if not notesources.SOURCES or not analysis.get("contour"):
        return
    stage(song_id, "Looking for charted melody notes (karaoke and rhythm-game charts)")
    try:
        q = note_query(song_id, d)
        found = notesources.lookup(q, pitch_line(analysis), float(analysis.get("duration") or len(analysis["contour"]) * HOP_S))
        found["detected_metrics"] = notesources.metrics(pitch_line(analysis), analysis.get("notes_detected") or analysis["notes"])
        found["query"] = {k: q[k] for k in ("video", "hyps", "title")}
        (d / "note_sources.json").write_text(json.dumps(found, separators=(",", ":"), default=float))
    except Exception:  # noqa: BLE001 - charts are a bonus; the detected notes still work
        log.exception("note lookup failed for %s", song_id)
        return
    pick = apply_note_choice(analysis, found, analysis.get("note_choice"))
    if pick:
        log.info("%s: notes from %s %s (%s)", song_id, pick["source"], pick["title"], pick["verdict"])


def lookup_notes_job(song_id: str, d: Path):
    """Look for charted notes again for a song that's already analysed (no audio work)."""
    p = d / "analysis.json"
    an = json.loads(p.read_text())
    an.setdefault("notes_detected", an.get("notes_auto") if an.get("notes_edited") else an.get("notes") or [])
    edited = an.get("notes_edited")
    hand = an.get("notes") if edited else None
    if edited:
        an["notes"] = an["notes_detected"]
    external_notes(song_id, d, an)
    if edited:          # hand-edited notes stay; the new pick is what "reset" goes back to
        an["notes_auto"] = an["notes"]
        an["notes"] = hand
        an["range"] = note_range(hand)
    p.write_text(json.dumps(an, separators=(",", ":")))
    lo, hi = an.get("range") or (None, None)
    db.update_song(song_id, status="ready", stage=None, error=None, note_low=lo, note_high=hi)


# --------------------------------------------------------------------------
# hand fixes: lead/backing mix-ups and edited notes (the editor page)
# --------------------------------------------------------------------------

FIX_MODES = ("swap", "lead", "backing")
FIX_FADE_S = 0.03      # crossfade at the edges of a fixed range, so there's no click
ORIG_FILES = {"vocals": "orig_vocals.mp3", "backing": "orig_backing.mp3", "accompaniment": "orig_accompaniment.mp3"}


def keep_edited_notes(old: dict, new: dict):
    """After a re-analysis: notes fixed by hand stay; the fresh detection becomes the
    'detected' set the editor can reset to."""
    if old.get("notes_edited") and old.get("notes") is not None:
        new["notes_auto"] = new["notes"]
        new["notes"] = old["notes"]
        new["notes_edited"] = True
        new["range"] = note_range(new["notes"])


def _decode(p: Path, channels: int) -> np.ndarray:
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-ac", str(channels), "-ar", str(PLAYBACK_RATE),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, channels).copy()


def _encode(x: np.ndarray, dst: Path):
    channels = x.shape[1]
    tmp = dst.with_name("." + dst.name)
    p = subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "f32le", "-ar", str(PLAYBACK_RATE), "-ac", str(channels),
                        "-i", "-", "-b:a", "128k" if channels == 2 else "96k", "-f", "mp3", str(tmp)],
                       input=np.ascontiguousarray(x, dtype=np.float32).tobytes(), capture_output=True)
    if p.returncode != 0:
        raise PipelineError("ffmpeg failed: " + p.stderr.decode(errors="replace")[-1500:])
    tmp.replace(dst)


def _fix_weight(n: int, t0: float, t1: float) -> tuple[int, int, np.ndarray]:
    """Samples a..b of the fixed range and a 0..1 weight over them with short fades at both ends."""
    sr, fade = PLAYBACK_RATE, int(FIX_FADE_S * PLAYBACK_RATE)
    a, b = max(0, int(round(t0 * sr)) - fade // 2), min(n, int(round(t1 * sr)) + fade // 2)
    w = np.ones(max(0, b - a), dtype=np.float32)
    k = min(fade, len(w) // 2)
    if k:
        ramp = np.sin(np.linspace(0, np.pi / 2, k, dtype=np.float32)) ** 2
        w[:k] = ramp
        w[-k:] = ramp[::-1]
    return a, b, w


def apply_vocal_fixes(d: Path, fixes: list[dict]):
    """Rebuild vocals.mp3 (lead = guide + melody source), backing.mp3 and accompaniment.mp3
    from the untouched split, with each fix applied to its time range:
      swap    - the separator swapped them: backing becomes lead and lead becomes backing
      lead    - it's all the lead singer (a double or harmony got pulled out as backing)
      backing - it's all backing vocals (an ad-lib or choir landed in the lead)
    Always worked out from the original files, so fixes can be removed or changed later."""
    if not ((d / "band.mp3").exists() and (d / "backing.mp3").exists() and (d / "vocals.mp3").exists()):
        raise PipelineError("This song has no separate backing vocals yet; re-analyse it first.")
    for stem, orig in ORIG_FILES.items():
        if not (d / orig).exists():
            shutil.copy2(d / f"{stem}.mp3", d / orig)
    if not fixes:   # all fixes removed: back to what the separator made
        for stem, orig in ORIG_FILES.items():
            shutil.copy2(d / orig, d / f".{stem}.mp3")
            (d / f".{stem}.mp3").replace(d / f"{stem}.mp3")
            (d / orig).unlink()
    else:
        lead = _decode(d / ORIG_FILES["vocals"], 1)[:, 0]
        back = _decode(d / ORIG_FILES["backing"], 2)
        band = _decode(d / "band.mp3", 2)
        n = min(len(lead), len(back), len(band))
        lead, back, band = lead[:n], back[:n], band[:n]
        for f in fixes:
            a, b, w = _fix_weight(n, f["t0"], f["t1"])
            if b <= a:
                continue
            L, B = lead[a:b].copy(), back[a:b].copy()
            if f["mode"] == "swap":
                nl, nb = B.mean(axis=1), np.repeat(L[:, None], 2, axis=1)
            elif f["mode"] == "lead":
                nl, nb = L + B.mean(axis=1), np.zeros_like(B)
            else:   # backing
                nl, nb = np.zeros_like(L), B + L[:, None]
            lead[a:b] = L * (1 - w) + nl * w
            back[a:b] = B * (1 - w[:, None]) + nb * w[:, None]
        music = band + back
        peak = float(np.abs(music).max()) if n else 0.0
        if peak > 0.999:   # a louder lead moved into the music can push it over full scale
            music *= 0.999 / peak
        lp = float(np.abs(lead).max()) if n else 0.0
        if lp > 0.999:
            lead *= 0.999 / lp
        _encode(lead[:, None], d / "vocals.mp3")
        _encode(back, d / "backing.mp3")
        _encode(music, d / "accompaniment.mp3")
    for f in d.glob("*.*.mp3"):   # key/speed-shifted copies of the old audio
        f.unlink(missing_ok=True)
    (d / "levels.json").unlink(missing_ok=True)


def merge_notes(old: list[dict], new: list[dict], ranges: list) -> list[dict]:
    """old notes outside the ranges + new notes inside them (a note belongs where its middle is)."""
    inside = lambda n: any(a <= (n["t0"] + n["t1"]) / 2 < b for a, b in ranges)  # noqa: E731
    keep = [dict(n, f=0) for n in old if not inside(n)] + [dict(n, f=1) for n in new if inside(n)]
    keep.sort(key=lambda n: (n["t0"], n["t1"]))
    out = []
    for n in keep:
        if out and n["t0"] < out[-1]["t1"]:          # overlap at a range edge: the new note wins
            p = out[-1]
            if n["f"] >= p["f"]:
                p["t1"] = n["t0"]
            else:
                n["t0"] = p["t1"]
            if p["t1"] - p["t0"] < 0.05:
                out.pop()
            if n["t1"] - n["t0"] < 0.05:
                continue
        out.append(n)
    return [{"t0": round(n["t0"], 3), "t1": round(n["t1"], 3), "midi": n["midi"]} for n in out]


def refix(song_id: str, d: Path, fixes: list[dict], ranges: list):
    """Apply the lead/backing fixes, then find the melody again where they changed things."""
    pending = d / "pending.json"
    try:
        _refix(song_id, d, fixes, ranges)
    except Exception as e:  # noqa: BLE001 - the song still works as it was; say what went wrong
        log.exception("vocal fix failed for %s", song_id)
        msg = str(e) if isinstance(e, PipelineError) else f"{type(e).__name__}: {e}"
        db.update_song(song_id, status="ready", stage=None, error=f"Fixing the vocals didn't work: {msg}"[:2000])
    finally:
        pending.unlink(missing_ok=True)


def _refix(song_id: str, d: Path, fixes: list[dict], ranges: list):
    an = json.loads((d / "analysis.json").read_text())
    stage(song_id, "Fixing the lead and backing vocals")
    apply_vocal_fixes(d, fixes)
    an["vocal_fixes"] = fixes
    an["audio_rev"] = int(an.get("audio_rev", 0)) + 1
    if ranges:
        stage(song_id, "Finding the vocal melody again")
        new = analyse_vocals(d / "vocals.mp3", tuning=(an.get("tuning") or 0) / 100)
        for k in ("contour", "loud", "loud_hop"):
            an[k] = new[k]
        if an.get("notes_detected") is not None:
            an["notes_detected"] = merge_notes(an["notes_detected"], new["notes"], ranges)
        if not an.get("note_source"):     # notes from a chart don't depend on the vocal split
            an["notes"] = merge_notes(an.get("notes") or [], new["notes"], ranges)
        if an.get("notes_auto") is not None and not an.get("note_source"):
            an["notes_auto"] = merge_notes(an["notes_auto"], new["notes"], ranges)
        an["range"] = note_range(an["notes"])
    tmp = d / ".analysis.json"
    tmp.write_text(json.dumps(an, separators=(",", ":")))
    tmp.replace(d / "analysis.json")
    lo, hi = an.get("range") or (None, None)
    db.update_song(song_id, status="ready", stage=None, error=None, note_low=lo, note_high=hi)


def levels(d: Path) -> dict:
    """Lead and backing vocal loudness on one scale (0-100, 100 = the lead's loud parts),
    20 values a second, so the editor can show where the backing is louder than the lead:
    usually a sign the separator swapped them. Cached until the audio changes."""
    import librosa

    cache = d / "levels.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text())
        except ValueError:
            pass
    sr, hop = 16000, int(16000 * HOP_S)

    def db_curve(p):
        y, _ = librosa.load(str(p), sr=sr, mono=True)
        rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop, center=True)[0]
        return 20 * np.log10(rms + 1e-9)

    lead = db_curve(d / "vocals.mp3")
    back = db_curve(d / "backing.mp3") if (d / "backing.mp3").exists() else None
    gate = lead > (np.percentile(lead, 95) - 30)
    ref = float(np.percentile(lead[gate], 98)) if gate.any() else float(lead.max())
    k = int(round(LOUD_HOP_S / HOP_S))

    def scale(x):
        n = len(x) // k
        v = x[: n * k].reshape(n, k).mean(axis=1)
        return [int(round(t)) for t in np.clip((v - (ref - LOUD_SPAN_DB)) / LOUD_SPAN_DB * 100, 0, 100)]

    out = {"hop": LOUD_HOP_S, "lead": scale(lead), "backing": scale(back) if back is not None else []}
    cache.write_text(json.dumps(out, separators=(",", ":")))
    return out


# --------------------------------------------------------------------------
# fetch
# --------------------------------------------------------------------------

META_FIELDS = ("channel", "uploader", "artist", "track", "alt_title", "creator", "album")


def save_meta(d: Path, info: dict):
    """Who uploaded it and any artist/track tags, for finding lyrics later."""
    meta = {k: info.get(k) for k in META_FIELDS if info.get(k)}
    if isinstance(info.get("artists"), list) and info["artists"] and not meta.get("artist"):
        meta["artist"] = info["artists"][0]
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))


def ensure_meta(d: Path, url: str | None) -> dict:
    """meta.json for songs added before it was saved: ask YouTube once (no download)."""
    p = d / "meta.json"
    if p.exists() or not url or not url.startswith("http"):
        try:
            return json.loads(p.read_text()) if p.exists() else {}
        except ValueError:
            return {}
    try:
        import yt_dlp
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
        cookies = os.environ.get("YTDLP_COOKIES", str(DATA_DIR / "cookies.txt"))
        if cookies and Path(cookies).exists():
            opts["cookiefile"] = cookies
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False) or {}
        save_meta(d, info)
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001 - only a hint for the lyrics search
        log.warning("couldn't read video details for %s", url, exc_info=True)
        return {}


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
            save_meta(d, info)
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
# lead / backing vocals
# --------------------------------------------------------------------------

def split_lead(d: Path, vocals: Path, accomp: Path) -> tuple[Path, Path, tuple[Path, Path]]:
    # returns lead, music (band + backing), (band, backing)
    """Lead vocal becomes the guide and the melody source; backing vocals join the music.

    On a studio vs live test (Holding Absence, Kyoto Snow) this took studio/live
    melody agreement from 77% to 80% and halved the stray pitch jumps, because
    gang vocals and harmonies no longer pull the tracker off the tune.
    """
    import soundfile as sf
    from .mdx import MDX

    mix, sr = sf.read(str(vocals), dtype="float32", always_2d=True)
    if sr != 44100:
        raise PipelineError(f"Vocal stem is {sr} Hz; expected 44100")
    lead, backing = MDX(str(KARAOKE_MODEL), threads=THREADS).split(mix.T)
    music, _ = sf.read(str(accomp), dtype="float32", always_2d=True)
    n = min(len(music), backing.shape[1])
    music = music[:n] + backing.T[:n]
    peak = float(np.abs(music).max())
    scale = 0.999 / peak if peak > 0.999 else 1.0   # don't clip where the backing vocals land on loud music
    lead_wav, music_wav = d / "lead.wav", d / "music.wav"
    band_wav, backing_wav = d / "band.wav", d / "backing.wav"
    sf.write(str(lead_wav), lead.T, sr, subtype="FLOAT")
    sf.write(str(music_wav), music * scale, sr, subtype="FLOAT")
    # the same two parts kept apart (same scale, so they add up to music.wav) for separate faders
    band, _ = sf.read(str(accomp), dtype="float32", always_2d=True)
    sf.write(str(band_wav), band[:n] * scale, sr, subtype="FLOAT")
    sf.write(str(backing_wav), backing.T[:n] * scale, sr, subtype="FLOAT")
    return lead_wav, music_wav, (band_wav, backing_wav)


# --------------------------------------------------------------------------
# analyse
# --------------------------------------------------------------------------

def analyse_vocals(vocals: Path, tuning: float | None = None) -> dict:
    """tuning: semitones off A440 to use instead of measuring it (re-analysing part of a song)."""
    import librosa

    sr = 16000
    hop = int(sr * HOP_S)
    audio, _ = librosa.load(str(vocals), sr=sr, mono=True)

    # Loudness gate: separation leaves faint bleed in the vocal stem.
    rms = librosa.feature.rms(y=audio, frame_length=1024, hop_length=hop, center=True)[0]
    rms_db = 20 * np.log10(rms + 1e-9)
    gate = rms_db > (np.percentile(rms_db, 95) - 30)

    if PITCH_MODEL == "swiftf0":
        f0, per = _swiftf0(audio, sr, len(gate))
        threshold = 0.5   # SwiftF0's confidence is calibrated so 0.5 means voiced
    else:
        f0, per = _crepe(audio, sr, hop, gate)
        threshold = 0.45

    n = min(len(f0), len(gate))
    f0, per, gate = f0[:n], per[:n], gate[:n]
    voiced = (per > threshold) & gate & (f0 > 0)
    midi = np.full(n, np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440.0)
    midi = _median_nan(midi, 5)

    # Recordings aren't always tuned to A440. Measure the offset and snap notes to the song's own tuning.
    v = midi[~np.isnan(midi)]
    if tuning is None:
        tuning = 0.0 if len(v) <= 200 else float(np.angle(np.mean(np.exp(2j * np.pi * (v % 1)))) / (2 * np.pi))  # semitones, ±0.5
    note_model = "contour"
    notes = None
    if NOTE_MODEL in ("game", "game_checked") and (GAME_MODEL / "encoder.onnx").exists():
        try:
            notes = game_notes(vocals, gate, rms_db, tuning)
            note_model = "game"
            if NOTE_MODEL == "game_checked":
                notes = check_notes(notes, midi - tuning)
                note_model = "game_checked"
        except Exception:  # noqa: BLE001 - fall back to the pitch-line notes
            log.exception("GAME note model failed; using notes from the pitch line")
    elif NOTE_MODEL in ("game", "game_checked"):
        log.warning("GAME model not found at %s; using notes from the pitch line", GAME_MODEL)
    fallback = segment_notes(midi - tuning)
    if notes is not None:
        # GAME very occasionally hears nothing in a quiet or breathy vocal the pitch tracker
        # follows fine (1 of 42 test clips); then the pitch-line notes are the better bet.
        dur = lambda ns: sum(n["t1"] - n["t0"] for n in ns)  # noqa: E731
        if dur(notes) < 0.3 * dur(fallback):
            log.info("GAME found little (%.1f s of notes vs %.1f s); using the pitch-line notes", dur(notes), dur(fallback))
            notes, note_model = None, "contour"
    if notes is None:
        notes = fallback
    contour = [None if np.isnan(v) else round(float(v), 2) for v in midi]
    rng = note_range(notes)
    # notes are in the song's tuning: the true pitch of a note is midi + tuning/100
    return {"hop": HOP_S, "contour": contour, "notes": notes, "range": rng, "tuning": round(tuning * 100, 1),
            "loud": loudness_curve(rms_db, gate), "loud_hop": LOUD_HOP_S, "note_model": note_model}


def note_range(notes: list[dict]):
    """Lowest and highest notes the melody really uses (3rd-97th percentile by time)."""
    if not notes:
        return None
    pitches = np.array([nt["midi"] for nt in notes])
    weights = np.array([max(1e-3, nt["t1"] - nt["t0"]) for nt in notes])
    return [int(_weighted_pct(pitches, weights, 3)), int(_weighted_pct(pitches, weights, 97))]


LOUD_HOP_S = 0.05   # the singer's loudness, 20 values a second
LOUD_SPAN_DB = 36   # 0 = this far below the singer's loud parts, 100 = their loud parts


def loudness_curve(rms_db: np.ndarray, gate: np.ndarray) -> list[int]:
    """How loud the lead singer is over time, 0-100 relative to their own loud passages
    (98th percentile), 0 where they're silent. Drawn under the melody so you can match the
    swells and fades, not only the notes."""
    k = int(round(LOUD_HOP_S / HOP_S))
    n = len(rms_db) // k
    if not n or not gate.any():
        return []
    ref = float(np.percentile(rms_db[gate], 98))
    db = rms_db[: n * k].reshape(n, k).mean(axis=1)
    on = gate[: n * k].reshape(n, k).mean(axis=1) >= 0.5
    v = np.clip((db - (ref - LOUD_SPAN_DB)) / LOUD_SPAN_DB * 100, 0, 100)
    v[~on] = 0
    return [int(round(x)) for x in v]


def loudness_for_file(p: Path) -> list[int]:
    """The loudness curve from a song's guide vocal mp3, for songs analysed before it existed."""
    import librosa

    sr = 16000
    hop = int(sr * HOP_S)
    audio, _ = librosa.load(str(p), sr=sr, mono=True)
    rms = librosa.feature.rms(y=audio, frame_length=1024, hop_length=hop, center=True)[0]
    rms_db = 20 * np.log10(rms + 1e-9)
    return loudness_curve(rms_db, rms_db > (np.percentile(rms_db, 95) - 30))


_game = None


def game_notes(vocals: Path, gate: np.ndarray, rms_db: np.ndarray, tuning: float) -> list[dict]:
    """Notes from GAME (MIT, github.com/openvpi/GAME): one note per sung syllable, found by a
    model trained on singing rather than by thresholds on the pitch line."""
    global _game
    import librosa
    from .game import Game, phrases_from_gate

    if _game is None:
        _game = Game(GAME_MODEL, threads=THREADS)
    wav, _ = librosa.load(str(vocals), sr=_game.sr, mono=True)
    peak = float(np.abs(wav).max()) or 1.0
    wav = (wav * (0.9 / peak)).astype(np.float32)   # separated vocals can be quiet; GAME was trained on normal levels
    phrases = phrases_from_gate(gate, HOP_S, _game.sr, rms_db)
    notes = []
    for t0, t1, m in _game.transcribe(wav, phrases):
        if t1 - t0 < 0.05:
            continue
        notes.append({"t0": round(t0, 3), "t1": round(t1, 3), "midi": int(round(m - tuning))})
    return notes


def check_notes(notes: list[dict], midi: np.ndarray, min_voiced=0.3, max_off=0.75) -> list[dict]:
    """Keep the GAME notes the pitch line backs up. GAME also puts notes on screams, harsh
    consonants and noise; on Holding Absence's Kyoto Snow (studio vs live) those extra notes
    matched the pitch line only 19% of the time, and dropping them took studio/live note
    agreement from 80% back to 90% (the old notes' level) while covering 90% of the melody
    instead of 87.5%, with GAME's whole-syllable notes. midi: pitch line in the song's tuning."""
    out = []
    for n in notes:
        a, b = int(round(n["t0"] / HOP_S)), int(round(n["t1"] / HOP_S))
        seg = midi[a:b]
        if not len(seg):
            continue
        v = seg[~np.isnan(seg)]
        if len(v) < min_voiced * len(seg):
            continue                                   # little or no pitch: scream, consonant, noise
        if abs(float(np.median(v)) - n["midi"]) > max_off:
            continue                                   # the pitch line says it's another note
        out.append(n)
    return out


def _swiftf0(audio, sr, n_frames):
    """SwiftF0 (MIT, github.com/lars76/swift-f0): ~20x faster than CREPE tiny on CPU, and on a
    studio vs live test it agreed with itself far more (77% vs 66%; octave errors 0.3% vs 4.2%)."""
    from swift_f0 import SwiftF0

    r = SwiftF0(threads=THREADS).detect(audio, sr, fmin=65.0, fmax=1100.0)
    t = np.arange(n_frames) * HOP_S
    f0 = np.interp(t, r.timestamps, r.pitch_hz).astype(np.float32)
    conf = np.interp(t, r.timestamps, r.confidence).astype(np.float32)
    return f0, conf


def _crepe(audio, sr, hop, gate):
    import torch
    import torchcrepe

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
    return f0, per


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

SPEEDS = (50, 60, 70, 75, 80, 90, 100)   # percent; slowed copies keep their pitch
MAX_VARIANT_FILES = 40                     # per song; oldest shifted copies are deleted past this


def stems(song_id: str) -> list[str]:
    """Files the browser plays. Songs analysed since the backing split have band + backing."""
    d = song_dir(song_id)
    if (d / "band.mp3").exists() and (d / "backing.mp3").exists():
        return ["band", "backing", "vocals"]
    return ["accompaniment", "vocals"]


def variant_tag(semitones: int, speed: int) -> str:
    return (f".t{semitones}" if semitones else "") + (f".s{speed}" if speed != 100 else "")


def audio_variant(song_id: str, semitones: int = 0, speed: int = 100) -> dict:
    """URLs for each stem in a key and at a speed; shifted copies are made once, then cached."""
    from concurrent.futures import ThreadPoolExecutor

    d = song_dir(song_id)
    tag = variant_tag(semitones, speed)
    names = stems(song_id)
    if not tag:
        return {stem: f"/media/songs/{song_id}/{stem}.mp3" for stem in names}
    with _tlocks_guard:
        lock = _tlocks.setdefault(f"{song_id}:{tag}", threading.Lock())

    def one(stem):
        name = f"{stem}{tag}.mp3"
        dst = d / name
        if not dst.exists():
            tmp = d / f".{name}"
            af = [f"tempo={speed / 100:.4f}"] if speed != 100 else []
            if semitones:
                af.append(f"pitch={2 ** (semitones / 12):.6f}")
            af.append("pitchq=quality")
            if stem in ("vocals", "backing"):
                af.append("formant=preserved")
            if speed != 100:
                af.append("transients=smooth")   # fewer clicks when slowed right down
            run(["ffmpeg", "-y", "-v", "error", "-i", str(d / f"{stem}.mp3"),
                 "-af", "rubberband=" + ":".join(af),
                 "-ar", str(PLAYBACK_RATE), "-b:a", "96k" if stem == "vocals" else "128k",
                 "-f", "mp3", str(tmp)])
            tmp.rename(dst)
        else:
            dst.touch()   # recently used, so the cache keeps it
        return stem, f"/media/songs/{song_id}/{name}"

    with lock, ThreadPoolExecutor(len(names)) as pool:
        out = dict(pool.map(one, names))
    _prune_variants(d, keep={f"{s}{tag}.mp3" for s in names})
    return out


def transposed(song_id: str, semitones: int) -> dict:
    """Old API: music + guide in another key."""
    out = audio_variant(song_id, semitones, 100)
    out.setdefault("accompaniment", out.get("band"))
    return out


def _prune_variants(d: Path, keep: set[str]):
    files = sorted((f for f in d.glob("*.*.mp3") if not f.name.startswith(".")),
                   key=lambda f: f.stat().st_mtime, reverse=True)
    for f in files[MAX_VARIANT_FILES:]:
        if f.name not in keep:
            f.unlink(missing_ok=True)
