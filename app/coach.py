"""AI Coach (beta): a Singing Carrots-style text coach, on its own page at /coach.

The boundary this module keeps:
  - Audio never reaches the server. The browser measures pitch on the device and sends a
    practice summary as JSON plus a plain-text rendering of it. Nothing here accepts files
    or binary bodies.
  - OpenAI only ever receives text: the system prompt, the coach's memory (notes + recent
    session summaries), recent chat turns, and the new message.

Memory is three SQLite tables in the app's existing database:
  coach_sessions  practice summaries (one row per finished session)
  coach_notes     short facts the coach chose to remember (via the save_note tool) or the user added
  coach_messages  the chat transcript (the last few turns go back into each call)
All three carry user_id so accounts could be added later; the app has one password, so it's "me".
"""
import json
import logging
import os
import time

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import db

log = logging.getLogger("coach")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "").strip() or "gpt-5.4-mini"
OPENAI_BASE_URL = (os.environ.get("OPENAI_BASE_URL", "").strip() or "https://api.openai.com/v1").rstrip("/")
USER = "me"

MAX_NOTES_IN_PROMPT = 40
SESSIONS_IN_PROMPT = 5
CHAT_TURNS_IN_PROMPT = 12

SCHEMA = """
CREATE TABLE IF NOT EXISTS coach_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    exercise TEXT NOT NULL,       -- match | hold
    summary TEXT NOT NULL,        -- JSON measured on the device (no audio)
    text TEXT NOT NULL,           -- the same, as the plain text the model sees
    score REAL,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS coach_sessions_user ON coach_sessions(user_id, created);
CREATE TABLE IF NOT EXISTS coach_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    note TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',   -- tendency | goal | progress | preference | other
    source TEXT NOT NULL DEFAULT 'coach', -- coach | user
    session_id INTEGER,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS coach_notes_user ON coach_notes(user_id, created);
CREATE TABLE IF NOT EXISTS coach_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,           -- user | assistant
    content TEXT NOT NULL,
    session_id INTEGER,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS coach_messages_user ON coach_messages(user_id, created);
"""

SYSTEM_PROMPT = """You are the vocal coach inside Vocal Lab, a singing practice app. You coach one student by text.

You never hear the student. The app measures their pitch on their own device and sends you numbers:
the target notes, how far off they sang in cents (100 cents = 1 semitone; + is sharp, - is flat),
the share of sung time within 50 cents of the target, steadiness (spread in cents), drift during a
hold, and how long it took to settle on the note. Treat these as approximate: phone mics, rooms and
headphones all add error. Never invent numbers or claim to have heard anything.

How to reply:
- Short. Two to five sentences, or at most three bullets. No headings.
- Lead with the single most useful observation, naming the note and the number ("G4 sat 40 cents flat").
- Give one concrete thing to try next, described physically (breath, jaw, tongue, vowel, larynx, volume),
  and say which exercise to repeat.
- Notice patterns across sessions using the memory below: getting better, same miss again, flat only up high.
- If there is no practice data yet, say so and suggest a session of "Match the note".
- Encourage honestly. Don't praise a poor result.
- Pain, hoarseness that lasts, or losing the voice: tell them to rest and see a voice professional. Don't diagnose.

Memory: call save_note when you learn something worth keeping for future sessions: a recurring
tendency ("goes flat above E4"), their goal, a note range that's comfortable, a cue that worked, or
a preference about how they like feedback. One short fact per call, under 25 words. Don't save
one-off results that the session summaries already hold, and don't repeat a note that's already in
memory. Most replies need no new note."""

TOOLS = [{
    "type": "function",
    "function": {
        "name": "save_note",
        "description": "Remember a short, durable fact about the student for future coaching.",
        "parameters": {
            "type": "object",
            "properties": {
                "note": {"type": "string", "description": "One fact, under 25 words."},
                "kind": {"type": "string", "enum": ["tendency", "goal", "progress", "preference", "other"]},
            },
            "required": ["note", "kind"],
            "additionalProperties": False,
        },
    },
}]

router = APIRouter(prefix="/api/coach")


def init():
    with db._lock:
        db._conn.executescript(SCHEMA)
        db._conn.commit()


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def _notes(limit=MAX_NOTES_IN_PROMPT):
    return db.q("SELECT id, note, kind, source, session_id, created FROM coach_notes "
                "WHERE user_id=? ORDER BY created DESC LIMIT ?", (USER, limit))


def _sessions(limit=SESSIONS_IN_PROMPT):
    return db.q("SELECT id, exercise, text, score, created FROM coach_sessions "
                "WHERE user_id=? ORDER BY created DESC LIMIT ?", (USER, limit))


def _recent_messages(limit=CHAT_TURNS_IN_PROMPT):
    rows = db.q("SELECT role, content, created FROM coach_messages WHERE user_id=? "
                "ORDER BY created DESC, id DESC LIMIT ?", (USER, limit))
    return list(reversed(rows))


def _add_message(role, content, session_id=None):
    db.execute("INSERT INTO coach_messages (user_id, role, content, session_id, created) VALUES (?,?,?,?,?)",
               (USER, role, content, session_id, time.time()))


def _add_note(note, kind="other", source="coach", session_id=None):
    note = " ".join(str(note).split())[:300]
    if not note:
        return None
    if kind not in ("tendency", "goal", "progress", "preference", "other"):
        kind = "other"
    existing = {n["note"].lower() for n in _notes(200)}
    if note.lower() in existing:
        return None
    nid = db.execute("INSERT INTO coach_notes (user_id, note, kind, source, session_id, created) VALUES (?,?,?,?,?,?)",
                     (USER, note, kind, source, session_id, time.time()))
    return {"id": nid, "note": note, "kind": kind, "source": source}


def _ago(ts):
    d = time.time() - ts
    if d < 3600:
        return "just now" if d < 120 else f"{int(d // 60)} min ago"
    if d < 86400:
        return f"{int(d // 3600)} h ago"
    days = int(d // 86400)
    return "yesterday" if days == 1 else f"{days} days ago"


def memory_block(current_session_id=None):
    """What the model is told about the student, besides the chat itself.

    Relevance here is simple on purpose: every coach note (they're short and few, newest first,
    capped), plus the most recent session summaries. The session being discussed right now is
    left out of this block because it goes into the user turn in full."""
    notes = _notes()
    sessions = [s for s in _sessions(SESSIONS_IN_PROMPT + 1) if s["id"] != current_session_id][:SESSIONS_IN_PROMPT]
    lines = ["## What you remember about this student"]
    if notes:
        lines += [f"- ({n['kind']}) {n['note']}" for n in notes]
    else:
        lines.append("- Nothing yet.")
    lines.append("")
    lines.append("## Their recent practice sessions (newest first)")
    if sessions:
        for s in sessions:
            lines.append(f"- {_ago(s['created'])}: {s['text']}")
    else:
        lines.append("- None before this one.")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# OpenAI
# --------------------------------------------------------------------------

def _openai(messages):
    if not OPENAI_API_KEY:
        raise HTTPException(503, "The coach needs OPENAI_API_KEY set on the server (see the README).")
    body = {"model": OPENAI_MODEL, "messages": messages, "tools": TOOLS, "max_completion_tokens": 1200}
    try:
        r = requests.post(f"{OPENAI_BASE_URL}/chat/completions", json=body, timeout=90,
                          headers={"Authorization": f"Bearer {OPENAI_API_KEY}"})
    except requests.RequestException as e:
        raise HTTPException(502, f"Couldn't reach OpenAI: {e}")
    if r.status_code != 200:
        try:
            msg = r.json().get("error", {}).get("message") or r.text
        except ValueError:
            msg = r.text
        log.warning("OpenAI %s: %s", r.status_code, msg[:500])
        raise HTTPException(502, f"OpenAI said ({r.status_code}): {msg[:300]}")
    return r.json()["choices"][0]["message"]


def ask_coach(user_text, session_id=None):
    """One coach turn. Text in, text out; the model may call save_note along the way."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT + "\n\n" + memory_block(session_id)}]
    for m in _recent_messages():
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": user_text})

    saved = []
    reply = ""
    for _ in range(3):   # at most two rounds of tool calls, then a final answer
        msg = _openai(messages)
        calls = msg.get("tool_calls") or []
        if not calls:
            reply = (msg.get("content") or "").strip()
            break
        messages.append({"role": "assistant", "content": msg.get("content"), "tool_calls": calls})
        for c in calls:
            result = {"ok": False}
            if c.get("function", {}).get("name") == "save_note":
                try:
                    args = json.loads(c["function"].get("arguments") or "{}")
                    n = _add_note(args.get("note", ""), args.get("kind", "other"), "coach", session_id)
                    if n:
                        saved.append(n)
                        result = {"ok": True, "id": n["id"]}
                    else:
                        result = {"ok": False, "reason": "empty or already remembered"}
                except (ValueError, TypeError):
                    result = {"ok": False, "reason": "bad arguments"}
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result)})
    if not reply:
        reply = "(The coach didn't answer. Try again.)"

    _add_message("user", user_text, session_id)
    _add_message("assistant", reply, session_id)
    return {"reply": reply, "notes_added": saved}


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------

class SessionIn(BaseModel):
    exercise: str = Field(max_length=40)
    summary: dict                                   # measured on the device; never audio
    text: str = Field(min_length=1, max_length=4000)
    score: float | None = None


class ChatIn(BaseModel):
    message: str | None = Field(default=None, max_length=2000)
    session_id: int | None = None


class NoteIn(BaseModel):
    note: str = Field(min_length=1, max_length=300)
    kind: str = "other"


@router.get("/status")
def status():
    return {"configured": bool(OPENAI_API_KEY), "model": OPENAI_MODEL}


@router.post("/sessions")
def add_session(s: SessionIn):
    if len(json.dumps(s.summary)) > 20_000:
        raise HTTPException(413, "Summary too large")
    sid = db.execute("INSERT INTO coach_sessions (user_id, exercise, summary, text, score, created) VALUES (?,?,?,?,?,?)",
                     (USER, s.exercise, json.dumps(s.summary), s.text.strip(), s.score, time.time()))
    return {"id": sid}


@router.get("/sessions")
def list_sessions(limit: int = 30):
    return _sessions(max(1, min(limit, 200)))


@router.delete("/sessions/{sid}")
def delete_session(sid: int):
    db.execute("DELETE FROM coach_sessions WHERE id=? AND user_id=?", (sid, USER))
    return {"ok": True}


@router.post("/chat")
def chat(c: ChatIn):
    text = (c.message or "").strip()
    if c.session_id is not None:
        row = db.q("SELECT text FROM coach_sessions WHERE id=? AND user_id=?", (c.session_id, USER), one=True)
        if not row:
            raise HTTPException(404, "No such session")
        lead = "Here's the practice session I just finished:\n" + row["text"]
        text = f"{lead}\n\n{text}" if text else f"{lead}\n\nHow did I do, and what should I work on?"
    if not text:
        raise HTTPException(400, "Say something")
    return ask_coach(text, c.session_id)


@router.get("/messages")
def messages(limit: int = 50):
    rows = db.q("SELECT id, role, content, session_id, created FROM coach_messages WHERE user_id=? "
                "ORDER BY created DESC, id DESC LIMIT ?", (USER, max(1, min(limit, 500))))
    return list(reversed(rows))


@router.delete("/messages")
def clear_messages():
    db.execute("DELETE FROM coach_messages WHERE user_id=?", (USER,))
    return {"ok": True}


@router.get("/memory")
def memory():
    """Everything the coach can see about you, as stored."""
    return {"notes": _notes(500), "sessions": _sessions(SESSIONS_IN_PROMPT),
            "prompt_preview": memory_block()}


@router.post("/memory/notes")
def add_note(n: NoteIn):
    note = _add_note(n.note, n.kind, "user")
    if not note:
        raise HTTPException(409, "Already remembered")
    return note


@router.delete("/memory/notes/{nid}")
def delete_note(nid: int):
    db.execute("DELETE FROM coach_notes WHERE id=? AND user_id=?", (nid, USER))
    return {"ok": True}


@router.delete("/memory")
def forget_everything():
    for t in ("coach_notes", "coach_sessions", "coach_messages"):
        db.execute(f"DELETE FROM {t} WHERE user_id=?", (USER,))
    return {"ok": True}
