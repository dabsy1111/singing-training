"""SQLite storage for songs, practice runs and settings."""
import json
import sqlite3
import threading
import time
from pathlib import Path

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT,
    status TEXT NOT NULL,
    stage TEXT,
    error TEXT,
    duration REAL,
    note_low INTEGER,
    note_high INTEGER,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,          -- song | drill | ear
    ref TEXT,                    -- song id, drill name or ear exercise
    title TEXT,
    score REAL,
    details TEXT,                -- JSON: per-note results, settings used
    take TEXT,                   -- filename of recorded take, if any
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "rangeLow": 48,          # C3
    "rangeHigh": 67,         # G4
    "latencyMs": 0,          # manual offset on top of what the browser reports
    "greenCents": 25,
    "amberCents": 50,
    "octaveFree": False,
    "echoCancellation": False,
    "recordTakes": True,
    "pxPerSecond": 140,
}


def init(path: Path):
    global _conn
    _conn = sqlite3.connect(path, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.executescript(SCHEMA)
    # Anything left mid-processing when the server stopped gets re-queued by main.
    _conn.commit()


def q(sql, args=(), one=False):
    with _lock:
        cur = _conn.execute(sql, args)
        rows = cur.fetchall()
        _conn.commit()
    rows = [dict(r) for r in rows]
    return (rows[0] if rows else None) if one else rows


def execute(sql, args=()):
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur.lastrowid


# songs -------------------------------------------------------------------

def add_song(song_id, title, source):
    execute(
        "INSERT INTO songs (id, title, source, status, stage, created) VALUES (?,?,?,?,?,?)",
        (song_id, title, source, "queued", "Waiting in queue", time.time()),
    )


def update_song(song_id, **fields):
    if not fields:
        return
    cols = ", ".join(f"{k}=?" for k in fields)
    execute(f"UPDATE songs SET {cols} WHERE id=?", (*fields.values(), song_id))


def get_song(song_id):
    return q("SELECT * FROM songs WHERE id=?", (song_id,), one=True)


def list_songs():
    return q("SELECT * FROM songs ORDER BY created DESC")


def delete_song(song_id):
    execute("DELETE FROM songs WHERE id=?", (song_id,))


# runs --------------------------------------------------------------------

def add_run(kind, ref, title, score, details, take=None):
    return execute(
        "INSERT INTO runs (kind, ref, title, score, details, take, created) VALUES (?,?,?,?,?,?,?)",
        (kind, ref, title, score, json.dumps(details), take, time.time()),
    )


def set_run_take(run_id, take):
    execute("UPDATE runs SET take=? WHERE id=?", (take, run_id))


def list_runs(limit=200, kind=None, ref=None, with_details=False):
    sql = "SELECT * FROM runs"
    where, args = [], []
    if kind:
        where.append("kind=?")
        args.append(kind)
    if ref:
        where.append("ref=?")
        args.append(ref)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created DESC LIMIT ?"
    args.append(limit)
    rows = q(sql, args)
    for r in rows:
        if with_details:
            r["details"] = json.loads(r["details"] or "{}")
        else:
            r.pop("details", None)
    return rows


def get_run(run_id):
    r = q("SELECT * FROM runs WHERE id=?", (run_id,), one=True)
    if r:
        r["details"] = json.loads(r["details"] or "{}")
    return r


def delete_run(run_id):
    execute("DELETE FROM runs WHERE id=?", (run_id,))


# settings ----------------------------------------------------------------

def get_settings():
    out = dict(DEFAULT_SETTINGS)
    for row in q("SELECT key, value FROM settings WHERE key NOT LIKE 'kv:%'"):
        out[row["key"]] = json.loads(row["value"])
    return out


def get_kv(key, default=None):
    row = q("SELECT value FROM settings WHERE key=?", (f"kv:{key}",), one=True)
    return json.loads(row["value"]) if row else default


def put_kv(key, value):
    execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (f"kv:{key}", json.dumps(value)))
    return value


def get_settings_raw_keys():
    return [r["key"] for r in q("SELECT key FROM settings")]


def put_settings(values: dict):
    for k, v in values.items():
        if k in DEFAULT_SETTINGS:
            execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, json.dumps(v)),
            )
    return get_settings()
