"""Vocal Lab: a self-hosted singing trainer with YouTube song import."""
import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, db, lyrics, pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

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
    mt = p.stat().st_mtime
    c = _fit_cache.get(song_id)
    if not c or c[0] != mt:
        notes = json.loads(p.read_text()).get("notes", [])
        c = (mt, [(n["midi"], n["t1"] - n["t0"]) for n in notes])
        _fit_cache[song_id] = c
    return c[1]


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
    p = pipeline.song_dir(song_id) / "analysis.json"
    if not p.exists():
        raise HTTPException(404, "Not analysed yet")
    return FileResponse(p, media_type="application/json")


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


def _ready_song(song_id):
    s = db.get_song(song_id)
    if not s or s["status"] != "ready":
        raise HTTPException(404, "Song isn't ready")
    return s


@app.get("/api/songs/{song_id}/lyrics")
def get_lyrics(song_id: str):
    s = _ready_song(song_id)
    data = lyrics.load(pipeline.song_dir(song_id))
    artist, track = lyrics.split_title(s["title"])
    return {"lyrics": data, "guess": {"artist": artist, "track": track}, "groq": bool(lyrics.GROQ_KEY)}


@app.post("/api/songs/{song_id}/lyrics")
def find_lyrics(song_id: str, body: LyricsFind):
    s = _ready_song(song_id)
    d = pipeline.song_dir(song_id)
    notes = json.loads((d / "analysis.json").read_text()).get("notes", [])
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
    if not re.fullmatch(r"(accompaniment|vocals|original)(\.t-?[1-7])?\.mp3", name) or not re.fullmatch(r"[0-9a-f]{12}", song_id):
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
    if m.get("kind") not in ("song", "drill", "ear"):
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
def runs(kind: str | None = None, ref: str | None = None, limit: int = 200):
    return db.list_runs(limit=min(limit, 2000), kind=kind, ref=ref)


@app.get("/api/runs/{run_id}")
def run(run_id: int):
    r = db.get_run(run_id)
    if not r:
        raise HTTPException(404)
    return r


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
    for name in ("style.css", "app.js"):
        html = html.replace(f"/static/{name}\"", f"/static/{name}?v={VERSION}\"")
    return html.replace("</head>", f'<script>window.VL_VERSION="{VERSION}";</script>\n</head>', 1)


_index_html = None


@app.get("/")
def index():
    global _index_html
    if _index_html is None:
        _index_html = versioned((STATIC / "index.html").read_text())
    return HTMLResponse(_index_html, headers={"Cache-Control": "no-cache"})
