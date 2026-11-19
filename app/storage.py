"""What Vocal Lab keeps on disk: per-song sizes, recorded takes, and leftovers nothing points to."""
import shutil
from pathlib import Path

from . import db, pipeline

# Files in a song folder, grouped the way the Storage page shows them.
#   audio  - the mp3s the player uses (and pre-edit backups from the editor)
#   copies - key/speed-shifted mp3s, made on demand and safe to delete (they're rebuilt when needed)
#   source - the downloaded audio as wav, kept so the song can be split again later
#   data   - notes, lyrics, levels and other small json
GROUPS = ("audio", "copies", "source", "data")


def _group(name: str) -> str:
    if name.endswith(".mp3"):
        return "copies" if name.count(".") >= 2 and not name.startswith(".") else "audio"
    if name.endswith(".wav"):
        return "source"
    return "data"


def _walk_size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def song_usage(song_id: str) -> dict:
    d = pipeline.song_dir(song_id)
    parts = dict.fromkeys(GROUPS, 0)
    if d.exists():
        for f in d.rglob("*"):
            try:
                if f.is_file():
                    parts[_group(f.name)] += f.stat().st_size
            except OSError:
                pass
    return {"total": sum(parts.values()), "parts": parts}


def clear_copies(song_id: str) -> int:
    d = pipeline.song_dir(song_id)
    freed = 0
    for f in d.glob("*.*.mp3"):
        if f.name.startswith("."):
            continue
        try:
            freed += f.stat().st_size
            f.unlink()
        except OSError:
            pass
    return freed


def _orphans(data_dir: Path, takes_dir: Path, upload_dir: Path) -> list[dict]:
    songs = {s["id"]: s for s in db.list_songs()}
    takes = {r["take"] for r in db.q("SELECT take FROM runs WHERE take IS NOT NULL")}
    out = []
    if pipeline.SONGS_DIR.exists():
        for d in pipeline.SONGS_DIR.iterdir():
            if d.is_dir() and d.name not in songs:
                out.append({"kind": "song folder", "name": d.name, "path": str(d), "size": _walk_size(d)})
    if takes_dir.exists():
        for f in takes_dir.iterdir():
            if f.is_file() and f.name not in takes:
                out.append({"kind": "recording", "name": f.name, "path": str(f), "size": f.stat().st_size})
    if upload_dir.exists():
        busy = {sid for sid, s in songs.items() if s["status"] in ("queued", "processing")}
        for f in upload_dir.iterdir():
            if f.is_file() and f.name.split(".")[0] not in busy:
                out.append({"kind": "upload", "name": f.name, "path": str(f), "size": f.stat().st_size})
    return out


def report(data_dir: Path, takes_dir: Path, upload_dir: Path) -> dict:
    songs = []
    for s in db.list_songs():
        u = song_usage(s["id"])
        songs.append({"id": s["id"], "title": s["title"], "status": s["status"], "duration": s["duration"],
                      "created": s["created"], **u})
    songs.sort(key=lambda x: -x["total"])

    takes = []
    for r in db.q("SELECT id, kind, ref, title, score, take, created FROM runs WHERE take IS NOT NULL ORDER BY created DESC"):
        p = takes_dir / r["take"]
        r["size"] = p.stat().st_size if p.exists() else 0
        r["missing"] = not p.exists()
        takes.append(r)

    orphans = _orphans(data_dir, takes_dir, upload_dir)
    db_size = sum(_walk_size(p) for p in data_dir.glob("vocal-lab.db*"))
    song_total = sum(s["total"] for s in songs)
    take_total = sum(t["size"] for t in takes)
    orphan_total = sum(o["size"] for o in orphans)
    app_total = _walk_size(data_dir)

    disk = shutil.disk_usage(data_dir)
    return {
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "app": {"total": app_total, "songs": song_total, "takes": take_total, "leftovers": orphan_total,
                "database": db_size, "other": max(0, app_total - song_total - take_total - orphan_total - db_size)},
        "songs": songs,
        "takes": takes,
        "orphans": [{k: v for k, v in o.items() if k != "path"} for o in orphans],
    }


def clean_orphans(data_dir: Path, takes_dir: Path, upload_dir: Path) -> int:
    freed = 0
    for o in _orphans(data_dir, takes_dir, upload_dir):
        p = Path(o["path"])
        freed += o["size"]
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
    return freed
