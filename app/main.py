"""Vocal Lab: a self-hosted singing trainer with YouTube song import."""
import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, db, lyrics, pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")

DATA_DIR = pipeline.DATA_DIR
TAKES_DIR = DATA_DIR / "takes"
UPLOAD_DIR = DATA_DIR / "uploads"
STATIC = Path(__file__).parent / "static"

import time as _time

VERSION = (os.environ.get("VL_VERSION") or "").strip()[:7] or f"dev{int(_time.time())}"
BUILT = os.environ.get("VL_BUILT", "")

app = FastAPI(title="Vocal Lab")
app.middleware("http")(auth.middleware)


@app.middleware("http")
async def cache_headers(request, call_next):
    """Static files are addressed as /static/x.js?v=<version>, so they can be cached forever;
    a new build changes the address. Anything else must be checked with the server every time,
    so Cloudflare and Safari never hold on to an old copy."""
    resp = await call_next(request)
    if request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable"
                                         if request.query_params.get("v") == VERSION else "no-cache")
    elif request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    elif request.url.path.startswith("/media/songs/"):
        resp.headers.setdefault("Cache-Control", "no-cache")   # the editor can rebuild a song's audio
    return resp


@app.on_event("startup")
def startup():
    for p in (DATA_DIR, pipeline.SONGS_DIR, TAKES_DIR, UPLOAD_DIR):
        p.mkdir(parents=True, exist_ok=True)
    db.init(DATA_DIR / "vocal-lab.db")
    auth.init(DATA_DIR)
    pipeline.start_worker()
    # Pick up anything that was interrupted by a restart.
    for s in db.list_songs():
        if s["status"] in ("queued", "processing"):
            d = pipeline.song_dir(s["id"])
            pending = d / "pending.json"
            if pending.exists():   # a lead/backing fix from the editor
                try:
                    pipeline.enqueue(s["id"], json.loads(pending.read_text()))
                    db.update_song(s["id"], status="queued", stage="Waiting in queue (resumed)")
                    continue
                except ValueError:
                    pending.unlink(missing_ok=True)
            uploads = list(UPLOAD_DIR.glob(f"{s['id']}.*"))
            job = {"url": s["source"]} if (s["source"] or "").startswith("http") else {}
            if uploads:
                job = {"upload": str(uploads[0])}
            if job or (d / "source.wav").exists():
                db.update_song(s["id"], status="queued", stage="Waiting in queue (resumed)")
                pipeline.enqueue(s["id"], job)
            else:
                db.update_song(s["id"], status="error", stage=None, error="Interrupted and the source is gone; delete and re-add")


# --------------------------------------------------------------------------
# songs
# --------------------------------------------------------------------------

YT_RE = re.compile(r"^https?://([a-z0-9-]+\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/", re.I)


class YouTubeIn(BaseModel):
    url: str


class SongPatch(BaseModel):
    title: str | None = None


class KeyIn(BaseModel):
    tonic: int | None = None
    mode: str | None = None
    reset: bool = False


class TransposeIn(BaseModel):
    semitones: int


class AudioIn(BaseModel):
    semitones: int = 0
    speed: int = 100


class LyricsFind(BaseModel):
    source: str = "auto"          # auto | lrclib | groq
    artist: str | None = None
    track: str | None = None


class LyricsEdit(BaseModel):
    text: str | None = None       # one line per lyric line
    offset: float | None = None   # seconds; positive shows lyrics later


_fit_cache: dict[str, tuple[float, list]] = {}


def _note_summary(song_id):
    p = pipeline.song_dir(song_id) / "analysis.json"
    if not p.exists():
        return None
    return _analysis_summary(song_id, p)[1]


def _analysis_summary(song_id, p):
    mt = p.stat().st_mtime
    c = _fit_cache.get(song_id)
    if not c or c[0] != mt:
        an = json.loads(p.read_text())
        c = (mt, [(n["midi"], n["t1"] - n["t0"]) for n in an.get("notes", [])], an.get("v", 1),
             bool(an.get("lead_split")) and not an.get("backing"))
        _fit_cache[song_id] = c
    return c


def _analysis_version(song_id):
    p = pipeline.song_dir(song_id) / "analysis.json"
    return _analysis_summary(song_id, p)[2] if p.exists() else None


def _no_backing(song_id):
    p = pipeline.song_dir(song_id) / "analysis.json"
    return _analysis_summary(song_id, p)[3] if p.exists() else False


def best_octave(notes, lo, hi):
    """Same rule as the song page: least time outside the range; ties go to the original, then down."""
    best = None
    for k in (0, -12, 12, -24, 24):
        cost = sum(dur * (lo - (m + k) if m + k < lo else (m + k) - hi if m + k > hi else 0) for m, dur in notes)
        if best is None or cost < best[1] - 1e-9:
            best = (k, cost)
    k = best[0]
    total = sum(d for _, d in notes) or 1
    inside = sum(d for m, d in notes if lo <= m + k <= hi)
    return k, inside / total


@app.get("/api/songs")
def songs():
    rows = db.list_songs()
    st = db.get_settings()
    for r in rows:
        if r["status"] == "ready":
            notes = _note_summary(r["id"])
            if notes:
                r["best_shift"], r["fit"] = best_octave(notes, st["rangeLow"], st["rangeHigh"])
            v = _analysis_version(r["id"])
            has_src = (pipeline.song_dir(r["id"]) / "source.wav").exists()
            r["outdated"] = bool(v and v < pipeline.ANALYSIS_VERSION and (has_src or pipeline.can_renote(pipeline.song_dir(r["id"]))))
            # analysed before backing vocals were kept as their own stem
            r["no_backing"] = bool(not r["outdated"] and has_src and st.get("splitBacking") and _no_backing(r["id"]))
    return rows


@app.post("/api/songs/youtube")
def add_youtube(body: YouTubeIn):
    url = body.url.strip()
    if not YT_RE.match(url):
        raise HTTPException(400, "That doesn't look like a YouTube link")
    song_id = uuid.uuid4().hex[:12]
    db.add_song(song_id, "Fetching title…", url)
    pipeline.enqueue(song_id, {"url": url})
    return db.get_song(song_id)


@app.post("/api/songs/upload")
async def add_upload(file: UploadFile = File(...), title: str = Form("")):
    song_id = uuid.uuid4().hex[:12]
    ext = Path(file.filename or "audio").suffix.lower()[:8] or ".bin"
    dst = UPLOAD_DIR / f"{song_id}{ext}"
    with dst.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    name = title.strip() or Path(file.filename or "Upload").stem
    db.add_song(song_id, name, f"upload:{file.filename}")
    pipeline.enqueue(song_id, {"upload": str(dst)})
    return db.get_song(song_id)


@app.get("/api/songs/{song_id}")
def song(song_id: str):
    s = db.get_song(song_id)
    if not s:
        raise HTTPException(404, "No such song")
    return s


@app.patch("/api/songs/{song_id}")
def patch_song(song_id: str, body: SongPatch):
    if not db.get_song(song_id):
        raise HTTPException(404, "No such song")
    new = (body.title or "").strip()[:200]
    if new:
        old = db.get_song(song_id)["title"]
        db.update_song(song_id, title=new)
        db.execute("UPDATE runs SET title = ? || substr(title, ?) WHERE kind='song' AND ref=? AND substr(title, 1, ?) = ?",
                   (new, len(old) + 1, song_id, len(old), old))
    return db.get_song(song_id)


@app.post("/api/songs/{song_id}/retry")
def retry_song(song_id: str):
    s = db.get_song(song_id)
    if not s:
        raise HTTPException(404, "No such song")
    job = {"url": s["source"]} if (s["source"] or "").startswith("http") else {}
    uploads = list(UPLOAD_DIR.glob(f"{song_id}.*"))
    if uploads:
        job = {"upload": str(uploads[0])}
    if not job and not (pipeline.song_dir(song_id) / "source.wav").exists():
        raise HTTPException(400, "Source file is gone; delete this song and add it again")
    db.update_song(song_id, status="queued", stage="Waiting in queue", error=None)
    pipeline.enqueue(song_id, job)
    return db.get_song(song_id)


def _reanalyse(song_id):
    s = db.get_song(song_id)
    if not s:
        raise HTTPException(404, "No such song")
    if s["status"] in ("queued", "processing"):
        raise HTTPException(409, "It's already waiting or being processed")
    d = pipeline.song_dir(song_id)
    if not (d / "source.wav").exists() and not pipeline.can_renote(d):
        raise HTTPException(400, "The original audio is gone; delete this song and add it again")
    db.update_song(song_id, status="queued", stage="Waiting in queue", error=None)
    pipeline.enqueue(song_id, {"reanalyse": True})
    return db.get_song(song_id)


@app.post("/api/songs/{song_id}/reanalyse")
def reanalyse_song(song_id: str):
    """Run the newest separation and melody finder again; keeps lyrics, a hand-set key and scores."""
    return _reanalyse(song_id)


@app.post("/api/songs/reanalyse-outdated")
def reanalyse_outdated():
    done = []
    for r in songs():
        if r.get("outdated") and r["status"] == "ready":
            _reanalyse(r["id"])
            done.append(r["id"])
    return {"queued": done}


@app.post("/api/songs/split-backing")
def split_backing_all():
    """Re-analyse songs made before backing vocals got their own fader."""
    done = []
    for r in songs():
        if r.get("no_backing") and r["status"] == "ready":
            _reanalyse(r["id"])
            done.append(r["id"])
    return {"queued": done}


def _split_status():
    """Which ready songs don't match Settings → 'Split backing vocals from the lead'."""
    want = bool(db.get_settings().get("splitBacking"))
    todo, stuck = [], []
    for r in db.list_songs():
        if r["status"] != "ready":
            continue
        d = pipeline.song_dir(r["id"])
        split = pipeline.is_split(d)
        if split and not want:
            todo.append(r["id"])                     # quick: mix the backing back into the guide
        elif not split and want:
            try:
                an = json.loads((d / "analysis.json").read_text())
            except (OSError, ValueError):
                continue
            if not an.get("lead_split"):
                (todo if (d / "source.wav").exists() else stuck).append(r["id"])   # needs the separator again
    return want, todo, stuck


@app.get("/api/split-status")
def split_status():
    want, todo, stuck = _split_status()
    return {"split": want, "todo": len(todo), "stuck": len(stuck)}


@app.post("/api/songs/apply-split-setting")
def apply_split_setting():
    """Redo existing songs to match the setting. Off: backing vocals go back into the guide
    (about a minute a song). On: the songs are split again (a few minutes each)."""
    want, todo, _ = _split_status()
    for sid in todo:
        db.update_song(sid, status="queued", stage="Waiting in queue", error=None)
        pipeline.enqueue(sid, {"reanalyse": True} if want else {"unsplit": True})
    return {"queued": len(todo)}


@app.delete("/api/songs/{song_id}")
def delete_song(song_id: str):
    s = db.get_song(song_id)
    if not s:
        raise HTTPException(404, "No such song")
    if s["status"] == "processing":
        raise HTTPException(409, "It's being processed right now; try again when it finishes")
    shutil.rmtree(pipeline.song_dir(song_id), ignore_errors=True)
    db.delete_song(song_id)
    return {"ok": True}


@app.get("/api/songs/{song_id}/analysis")
def analysis(song_id: str):
    d = pipeline.song_dir(song_id)
    p = d / "analysis.json"
    if not p.exists():
        raise HTTPException(404, "Not analysed yet")
    if (d / "vocals.mp3").exists() and b'"loud"' not in p.read_bytes():
        # songs analysed before the loudness line: work it out from the guide vocal once
        try:
            an = json.loads(p.read_text())
            an["loud"], an["loud_hop"] = pipeline.loudness_for_file(d / "vocals.mp3"), pipeline.LOUD_HOP_S
            p.write_text(json.dumps(an, separators=(",", ":")))
        except Exception:  # noqa: BLE001 - the song still works without it
            log.exception("loudness for %s failed", song_id)
    return FileResponse(p, media_type="application/json")


# --------------------------------------------------------------------------
# editor: hand-fixed notes and lead/backing vocal fixes
# --------------------------------------------------------------------------

class NoteIn(BaseModel):
    t0: float
    t1: float
    midi: int


class NotesIn(BaseModel):
    notes: list[NoteIn]


class VocalFix(BaseModel):
    t0: float
    t1: float
    mode: str


class VocalFixesIn(BaseModel):
    fixes: list[VocalFix]


def _read_analysis(song_id):
    p = pipeline.song_dir(song_id) / "analysis.json"
    if not p.exists():
        raise HTTPException(404, "Not analysed yet")
    return p, json.loads(p.read_text())


def _write_analysis(p, an):
    tmp = p.with_name(".analysis.json")
    tmp.write_text(json.dumps(an, separators=(",", ":")))
    tmp.replace(p)


@app.put("/api/songs/{song_id}/notes")
def put_notes(song_id: str, body: NotesIn):
    """Save the melody as fixed by hand in the editor. The detected notes are kept for 'reset'."""
    s = _ready_song(song_id)
    p, an = _read_analysis(song_id)
    dur = float(an.get("duration") or s.get("duration") or 0) + 1
    if len(body.notes) > 8000:
        raise HTTPException(400, "Too many notes")
    notes = []
    for n in sorted(body.notes, key=lambda n: n.t0):
        if not (0 <= n.t0 < n.t1 <= dur) or not 12 <= n.midi <= 108:
            raise HTTPException(400, f"Bad note at {n.t0:.2f} s")
        if notes and n.t0 < notes[-1]["t1"] - 0.005:
            raise HTTPException(400, f"Notes overlap at {n.t0:.2f} s")
        notes.append({"t0": round(n.t0, 3), "t1": round(n.t1, 3), "midi": n.midi})
    if an.get("notes_auto") is None:
        an["notes_auto"] = an.get("notes") or []
    an["notes"] = notes
    an["notes_edited"] = True
    an["range"] = pipeline.note_range(notes)
    _write_analysis(p, an)
    lo, hi = an["range"] or (None, None)
    db.update_song(song_id, note_low=lo, note_high=hi)
    return {"ok": True, "range": an["range"]}


@app.post("/api/songs/{song_id}/notes/reset")
def reset_notes(song_id: str):
    """Throw away hand edits: back to the notes the melody finder found."""
    _ready_song(song_id)
    p, an = _read_analysis(song_id)
    if an.get("notes_auto") is not None:
        an["notes"] = an.pop("notes_auto")
    an.pop("notes_edited", None)
    an["range"] = pipeline.note_range(an["notes"])
    _write_analysis(p, an)
    lo, hi = an["range"] or (None, None)
    db.update_song(song_id, note_low=lo, note_high=hi)
    return {"notes": an["notes"], "range": an["range"]}


@app.put("/api/songs/{song_id}/vocal-fixes")
def put_vocal_fixes(song_id: str, body: VocalFixesIn):
    """Fix where the separator mixed up lead and backing vocals. The audio is rebuilt in the
    background and the melody found again inside the ranges that changed (about a minute)."""
    s = _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    p, an = _read_analysis(song_id)
    if not an.get("backing") or not (d / "backing.mp3").exists():
        raise HTTPException(400, "This song's backing vocals aren't on a track of their own (Settings → Split backing vocals from the lead).")
    dur = float(an.get("duration") or s.get("duration") or 0)
    if len(body.fixes) > 300:
        raise HTTPException(400, "Too many fixes")
    fixes = []
    for f in sorted(body.fixes, key=lambda f: f.t0):
        t0, t1 = max(0.0, round(f.t0, 2)), min(dur, round(f.t1, 2))
        if f.mode not in pipeline.FIX_MODES:
            raise HTTPException(400, f"Unknown fix '{f.mode}'")
        if t1 - t0 < 0.2:
            raise HTTPException(400, "Pick at least a fifth of a second")
        if fixes and t0 < fixes[-1]["t1"]:
            raise HTTPException(400, f"Two fixes overlap at {t0:.1f} s; remove one first")
        fixes.append({"t0": t0, "t1": t1, "mode": f.mode})
    old = an.get("vocal_fixes") or []
    key = lambda f: (f["t0"], f["t1"], f["mode"])  # noqa: E731
    changed = [f for f in old if key(f) not in {key(x) for x in fixes}] + [f for f in fixes if key(f) not in {key(x) for x in old}]
    if not changed:
        return db.get_song(song_id)
    job = {"fix_vocals": fixes, "ranges": [[f["t0"], f["t1"]] for f in changed]}
    (d / "pending.json").write_text(json.dumps(job))
    db.update_song(song_id, status="queued", stage="Waiting in queue", error=None)
    pipeline.enqueue(song_id, job)
    return db.get_song(song_id)


@app.get("/api/songs/{song_id}/levels")
def song_levels(song_id: str):
    _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    if not (d / "vocals.mp3").exists():
        raise HTTPException(404, "No vocal audio")
    return pipeline.levels(d)


@app.get("/api/songs/{song_id}/key")
def song_key(song_id: str):
    p = pipeline.song_dir(song_id) / "analysis.json"
    if not p.exists():
        raise HTTPException(404, "Not analysed yet")
    an = json.loads(p.read_text())
    if "key" not in an:   # songs added before key detection existed
        an["key"] = pipeline.detect_key(pipeline.song_dir(song_id) / "accompaniment.mp3", an.get("notes", []))
        p.write_text(json.dumps(an, separators=(",", ":")))
    return an["key"]


@app.put("/api/songs/{song_id}/key")
def set_song_key(song_id: str, body: KeyIn):
    p = pipeline.song_dir(song_id) / "analysis.json"
    if not p.exists():
        raise HTTPException(404, "Not analysed yet")
    an = json.loads(p.read_text())
    if body.reset:
        an["key"] = pipeline.detect_key(pipeline.song_dir(song_id) / "accompaniment.mp3", an.get("notes", []))
    else:
        if body.tonic is None or not 0 <= body.tonic <= 11 or body.mode not in ("major", "minor"):
            raise HTTPException(400, "Key needs a tonic 0-11 and a mode of major or minor")
        an["key"] = {"tonic": body.tonic, "mode": body.mode, "detected": False}
    p.write_text(json.dumps(an, separators=(",", ":")))
    return an["key"]


@app.post("/api/songs/{song_id}/transpose")
def transpose(song_id: str, body: TransposeIn):
    s = db.get_song(song_id)
    if not s or s["status"] != "ready":
        raise HTTPException(404, "Song isn't ready")
    if not -7 <= body.semitones <= 7 or body.semitones == 0:
        raise HTTPException(400, "Choose between -7 and +7 semitones")
    return pipeline.transposed(song_id, body.semitones)


@app.post("/api/songs/{song_id}/audio")
def song_audio(song_id: str, body: AudioIn):
    s = db.get_song(song_id)
    if not s or s["status"] != "ready":
        raise HTTPException(404, "Song isn't ready")
    if not -7 <= body.semitones <= 7:
        raise HTTPException(400, "Choose between -7 and +7 semitones")
    if body.speed not in pipeline.SPEEDS:
        raise HTTPException(400, f"Speed must be one of {', '.join(map(str, pipeline.SPEEDS))}%")
    return pipeline.audio_variant(song_id, body.semitones, body.speed)


def _ready_song(song_id):
    s = db.get_song(song_id)
    if not s or s["status"] != "ready":
        raise HTTPException(404, "Song isn't ready")
    return s


@app.get("/api/songs/{song_id}/lyrics")
def get_lyrics(song_id: str):
    s = _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    data = lyrics.load(d)
    g = lyrics.guesses(s["title"], lyrics.load_meta(d))
    artist, track = g[0] if g else ("", lyrics.clean_title(s["title"]))
    return {"lyrics": data, "guess": {"artist": artist, "track": track}, "groq": bool(lyrics.GROQ_KEY)}


@app.get("/api/songs/{song_id}/lyrics/search")
def search_lyrics(song_id: str, artist: str = "", track: str = ""):
    """LRCLIB versions to choose from, best match first."""
    s = _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    meta = pipeline.ensure_meta(d, s.get("source"))
    try:
        if artist.strip() or track.strip():
            recs = lyrics.lrclib_search(s["title"], s["duration"] or 0, meta, artist.strip(), track.strip())
        else:
            recs = lyrics.lrclib_search(s["title"], s["duration"] or 0, meta)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LRCLIB search failed: {e}")
    out, seen = [], set()
    for r in recs:
        # LRCLIB has many copies of popular songs; one per name, album, length and timing is plenty
        k = (lyrics._norm(r.get("artistName") or ""), lyrics._norm(r.get("trackName") or ""),
             lyrics._norm(r.get("albumName") or ""), round(r.get("duration") or 0), bool(r.get("syncedLyrics")))
        if k in seen:
            continue
        seen.add(k)
        first = lyrics.parse_lrc(r.get("syncedLyrics") or "")[:1] or lyrics.plain_lines(r.get("plainLyrics") or "")[:1]
        out.append({"id": r.get("id"), "artist": r.get("artistName"), "track": r.get("trackName"),
                    "album": r.get("albumName"), "duration": r.get("duration"), "synced": bool(r.get("syncedLyrics")),
                    "score": r.get("score"), "first": first[0]["text"] if first else ""})
    return {"results": out, "video_duration": s["duration"]}


class LyricsChoose(BaseModel):
    id: int


@app.post("/api/songs/{song_id}/lyrics/choose")
def choose_lyrics(song_id: str, body: LyricsChoose):
    s = _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    try:
        rec = lyrics.lrclib_get(body.id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LRCLIB failed: {e}")
    notes = json.loads((d / "analysis.json").read_text()).get("notes", [])
    data = lyrics.from_record(rec or {}, notes, s["duration"] or 0)
    if not data:
        raise HTTPException(404, "That LRCLIB entry has no lyrics")
    return {"lyrics": lyrics.save(d, data)}


@app.post("/api/songs/{song_id}/lyrics")
def find_lyrics(song_id: str, body: LyricsFind):
    s = _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    notes = json.loads((d / "analysis.json").read_text()).get("notes", [])
    pipeline.ensure_meta(d, s.get("source"))
    try:
        return {"lyrics": lyrics.find(d, s["title"], s["duration"] or 0, notes,
                                      body.source if body.source in ("auto", "lrclib", "groq") else "auto",
                                      body.artist, body.track)}
    except lyrics.LyricsError as e:
        raise HTTPException(404, f"No lyrics found: {e}")
    except Exception as e:  # noqa: BLE001 - network trouble etc.
        raise HTTPException(502, f"Lyrics lookup failed: {e}")


@app.put("/api/songs/{song_id}/lyrics")
def edit_lyrics(song_id: str, body: LyricsEdit):
    _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    data = lyrics.load(d) or {"source": "manual", "synced": False, "lines": [], "offset": 0.0}
    if body.text is not None:
        data = lyrics.edit_text(data, body.text[:20000])
    if body.offset is not None:
        data["offset"] = round(max(-60.0, min(60.0, body.offset)), 2)
    return {"lyrics": lyrics.save(d, data)}


@app.delete("/api/songs/{song_id}/lyrics")
def delete_lyrics(song_id: str):
    _ready_song(song_id)
    lyrics.path_for(pipeline.song_dir(song_id)).unlink(missing_ok=True)
    return {"ok": True}


@app.get("/media/songs/{song_id}/{name}")
def song_media(song_id: str, name: str):
    if not re.fullmatch(r"(accompaniment|band|backing|vocals|original)(\.t-?[1-7])?(\.s[5-9]\d)?\.mp3", name) or not re.fullmatch(r"[0-9a-f]{12}", song_id):
        raise HTTPException(404)
    p = pipeline.song_dir(song_id) / name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="audio/mpeg")


# --------------------------------------------------------------------------
# runs (graded attempts) and takes
# --------------------------------------------------------------------------

@app.post("/api/runs")
async def add_run(meta: str = Form(...), take: UploadFile | None = File(None)):
    try:
        m = json.loads(meta)
    except json.JSONDecodeError:
        raise HTTPException(400, "Bad run data")
    if m.get("kind") not in ("song", "drill", "ear", "lesson"):
        raise HTTPException(400, "Unknown run kind")
    run_id = db.add_run(m["kind"], str(m.get("ref") or ""), str(m.get("title") or "")[:200],
                        m.get("score"), m.get("details") or {})
    if take is not None:
        ext = ".webm" if "webm" in (take.content_type or "") else ".m4a" if "mp4" in (take.content_type or "") else ".ogg"
        name = f"{run_id}{ext}"
        with (TAKES_DIR / name).open("wb") as f:
            shutil.copyfileobj(take.file, f)
        db.set_run_take(run_id, name)
    return {"id": run_id}


@app.get("/api/runs")
def runs(kind: str | None = None, ref: str | None = None, limit: int = 200, details: bool = False):
    return db.list_runs(limit=min(limit, 2000), kind=kind, ref=ref, with_details=details)


@app.get("/api/runs/{run_id}")
def run(run_id: int):
    r = db.get_run(run_id)
    if not r:
        raise HTTPException(404)
    return r


@app.delete("/api/runs")
def delete_all_runs():
    """Wipe all scores and recorded takes. Songs, settings and lesson progress are kept."""
    takes = db.delete_all_runs()
    for t in takes:
        (TAKES_DIR / t).unlink(missing_ok=True)
    return {"ok": True, "deleted_takes": len(takes)}


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: int):
    r = db.get_run(run_id)
    if r and r.get("take"):
        (TAKES_DIR / r["take"]).unlink(missing_ok=True)
    db.delete_run(run_id)
    return {"ok": True}


@app.get("/media/takes/{name}")
def take_media(name: str):
    if not re.fullmatch(r"\d+\.(webm|m4a|ogg)", name):
        raise HTTPException(404)
    p = TAKES_DIR / name
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


@app.get("/api/stats")
def stats():
    """Per-note and per-interval accuracy across everything sung so far."""
    rows = db.list_runs(limit=5000, with_details=True)
    notes: dict[int, list[float]] = {}
    intervals: dict[str, list[int]] = {}
    for r in rows:
        d = r["details"] or {}
        for n in d.get("notes", []):
            if n.get("score") is not None and n.get("midi") is not None:
                notes.setdefault(int(n["midi"]), []).append(n["score"])
        for a in d.get("answers", []):
            key = str(a.get("item"))
            intervals.setdefault(key, []).append(1 if a.get("correct") else 0)
    timeline = [{"t": r["created"], "score": r["score"], "kind": r["kind"]}
                for r in reversed(rows) if r["score"] is not None]
    return {
        "notes": {k: {"n": len(v), "avg": sum(v) / len(v)} for k, v in sorted(notes.items())},
        "ear": {k: {"n": len(v), "avg": sum(v) / len(v)} for k, v in intervals.items()},
        "timeline": timeline,
    }


# --------------------------------------------------------------------------
# settings
# --------------------------------------------------------------------------

@app.get("/api/settings")
def get_settings():
    return db.get_settings()


@app.put("/api/settings")
def put_settings(values: dict):
    return db.put_settings(values)


@app.get("/api/course")
def get_course():
    return db.get_kv("course", {})


@app.put("/api/course")
def put_course(value: dict):
    if len(json.dumps(value)) > 200_000:
        raise HTTPException(413, "Course data too large")
    return db.put_kv("course", value)


@app.get("/api/vrp")
def get_vrp():
    """Saved voice range profiles (softest and loudest level per note), newest last."""
    return db.get_kv("vrp", [])


@app.put("/api/vrp")
def put_vrp(value: list = Body(...)):
    if len(json.dumps(value)) > 300_000:
        raise HTTPException(413, "Too many saved profiles")
    return db.put_kv("vrp", value)


@app.get("/api/health")
def health():
    import yt_dlp
    return {"ok": True, "version": VERSION, "built": BUILT, "yt_dlp": yt_dlp.version.__version__, "demucs_model": pipeline.DEMUCS_MODEL,
            "lyrics_transcription": "groq" if lyrics.GROQ_KEY else "off",
            "crepe_model": pipeline.CREPE_MODEL, "queue": pipeline._jobs.qsize()}


# --------------------------------------------------------------------------
# front end
# --------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/login")
def login_form():
    return auth.login_page(version=VERSION)


@app.post("/login")
def login(request: Request, password: str = Form("")):
    return auth.handle_login(request, password, version=VERSION)


@app.get("/logout")
def logout():
    return auth.handle_logout()


@app.get("/api/me")
def me():
    return {"login": bool(auth.PASSWORD)}


def versioned(html: str) -> str:
    for name in ("style.css", "mic-filter.js", "app.js", "editor.js", "lessons.js", "course.js"):
        html = html.replace(f"/static/{name}\"", f"/static/{name}?v={VERSION}\"")
    return html.replace("</head>", f'<script>window.VL_VERSION="{VERSION}";</script>\n</head>', 1)


_index_html = None


@app.get("/")
def index():
    global _index_html
    if _index_html is None:
        _index_html = versioned((STATIC / "index.html").read_text())
    return HTMLResponse(_index_html, headers={"Cache-Control": "no-cache"})
