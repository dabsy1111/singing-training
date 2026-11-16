"""Vocal Lab: a self-hosted singing trainer with YouTube song import."""
import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, db, pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = pipeline.DATA_DIR
TAKES_DIR = DATA_DIR / "takes"
UPLOAD_DIR = DATA_DIR / "uploads"
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="Vocal Lab")
app.middleware("http")(auth.middleware)


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


@app.get("/api/songs")
def songs():
    return db.list_songs()


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
    if body.title:
        db.update_song(song_id, title=body.title.strip()[:200])
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


@app.get("/media/songs/{song_id}/{name}")
def song_media(song_id: str, name: str):
    if name not in ("accompaniment.mp3", "vocals.mp3", "original.mp3") or not re.fullmatch(r"[0-9a-f]{12}", song_id):
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
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__, "demucs_model": pipeline.DEMUCS_MODEL,
            "crepe_model": pipeline.CREPE_MODEL, "queue": pipeline._jobs.qsize()}


# --------------------------------------------------------------------------
# front end
# --------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/login")
def login_form():
    return auth.login_page()


@app.post("/login")
def login(request: Request, password: str = Form("")):
    return auth.handle_login(request, password)


@app.get("/logout")
def logout():
    return auth.handle_logout()


@app.get("/api/me")
def me():
    return {"login": bool(auth.PASSWORD)}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
