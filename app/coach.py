"""AI Coach (beta): a Singing Carrots-style text coach, on its own page at /coach.

The boundary this module keeps:
  - Audio never reaches the server. The browser measures pitch on the device and posts the
    results as JSON. Nothing here accepts files or binary bodies.
  - OpenAI only ever receives text: the system prompt (with the student's memory notes and recent
    session summaries), the session summary, and whatever the student typed.
  - Nothing logged here contains the API key or a request body.

Routes (step 2 spec):
  POST   /api/session          practice results in, coaching text out
  POST   /api/memory           add a memory note          -> {id}
  GET    /api/memory?userId=   that user's notes, newest first
  DELETE /api/memory/{id}      delete one note (userId in the query or body must own it)
Extra routes the /coach page uses, under /api/coach: status, follow-up chat, chat history,
session history, prompt preview, forget everything.

Tables (in the app's existing SQLite database):
  memories        the spec's table: short notes about the student, written by the coach
                  (save_note tool) or by the student
  coach_sessions  one row per finished practice session (the text the model saw)
  coach_messages  the chat transcript; recent turns go back into follow-up questions

The system prompt is built in, but a file at DATA_DIR/coach-prompt.md replaces it (read on each
call), so the prompt can be changed without rebuilding the image.
"""
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from . import db

log = logging.getLogger("coach")

def _env(name):
    return os.environ.get(name, "").strip()


OPENAI_MODEL = _env("OPENAI_MODEL") or "gpt-4o-mini"
ANTHROPIC_MODEL = _env("ANTHROPIC_MODEL") or "claude-haiku-5-5"
# COACH_PROVIDER = openai | anthropic. Blank: Anthropic if its key is set, otherwise OpenAI.
PROVIDER = (_env("COACH_PROVIDER").lower()
            or ("anthropic" if _env("ANTHROPIC_API_KEY") and not _env("OPENAI_API_KEY") else "openai"))
if PROVIDER not in ("openai", "anthropic"):
    PROVIDER = "openai"
MODEL = ANTHROPIC_MODEL if PROVIDER == "anthropic" else OPENAI_MODEL
KEY_VAR = "ANTHROPIC_API_KEY" if PROVIDER == "anthropic" else "OPENAI_API_KEY"
# Claude can think before answering and calls save_note in the same response, so it gets more room.
# The prompt keeps replies to a few sentences either way; this is a ceiling, not a target.
MAX_TOKENS = int(_env("COACH_MAX_TOKENS") or _env("OPENAI_MAX_TOKENS") or (1024 if PROVIDER == "anthropic" else 200))
# Short coaching replies don't need thinking, and it spends the token budget before any text.
# COACH_THINKING=adaptive turns it back on (raise COACH_MAX_TOKENS too).
THINKING = (_env("COACH_THINKING") or "off").lower()
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
PROMPT_FILE = DATA_DIR / "coach-prompt.md"
DEFAULT_USER = "me"
USER_ID_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")

NOTES_IN_PROMPT = 30
SESSIONS_IN_PROMPT = 3
CHAT_TURNS_IN_PROMPT = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE TABLE IF NOT EXISTS coach_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    exercise TEXT NOT NULL,
    summary TEXT NOT NULL,        -- JSON of what the browser posted (numbers and note names, no audio)
    text TEXT NOT NULL,           -- the same as the text the model saw
    score REAL,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS coach_sessions_user ON coach_sessions(user_id, created);
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
- Short: two to four sentences. No headings, no lists.
- Lead with the single most useful observation, naming the note and the number ("G4 sat 40 cents flat").
- Give one concrete thing to try next, described physically (breath, jaw, tongue, vowel, larynx, volume),
  and say which exercise to repeat.
- Notice patterns across sessions using the memory below: getting better, same miss again, flat only up high.
- If there is no practice data, say so and suggest a session of "Match the note".
- Encourage honestly. Don't praise a poor result.
- Pain, hoarseness that lasts, or losing the voice: tell them to rest and see a voice professional. Don't diagnose.

Memory: call save_note when you learn something worth keeping for future sessions: a recurring
tendency ("goes flat above E4"), their goal, a comfortable range, a cue that worked, or how they like
feedback. One short fact per call, under 25 words. Don't save one-off results (sessions are kept
separately) and don't repeat a note that's already in memory. Most replies need no new note."""

TOOLS = [{
    "type": "function",
    "function": {
        "name": "save_note",
        "description": "Remember a short, durable fact about the student for future coaching.",
        "parameters": {
            "type": "object",
            "properties": {"note": {"type": "string", "description": "One fact, under 25 words."}},
            "required": ["note"],
            "additionalProperties": False,
        },
    },
}]

router = APIRouter()
_client = None


def init():
    with db._lock:
        db._conn.executescript(SCHEMA)
        # Step 1 kept notes in coach_notes; carry them over once.
        old = db._conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='coach_notes'").fetchone()
        if old:
            db._conn.execute(
                "INSERT INTO memories (user_id, note, created_at) "
                "SELECT user_id, note, datetime(created, 'unixepoch') FROM coach_notes ORDER BY created")
            db._conn.execute("DROP TABLE coach_notes")
            log.info("moved coach_notes into memories")
        db._conn.commit()


def _key():
    """The provider's key, with any stray quotes, spaces or Windows line endings from .env removed."""
    return _env(KEY_VAR).strip('"').strip("'").strip()


def client():
    """SDK client for the chosen provider, made on first use. The key is never logged."""
    global _client
    if not _key():
        raise HTTPException(503, f"The coach needs {KEY_VAR} set on the server (see the README).")
    if _client is None:
        if PROVIDER == "anthropic":
            from anthropic import Anthropic
            _client = Anthropic(api_key=_key(), timeout=60, max_retries=2)
        else:
            from openai import OpenAI
            _client = OpenAI(api_key=_key(), timeout=60, max_retries=2)   # OPENAI_BASE_URL is read from the env
    return _client


_KEY_RE = re.compile(r"sk-[A-Za-z0-9_\-*]{4,}")


def _redact(text: str) -> str:
    """OpenAI's own error text can quote part of a key ("sk-proj-****abcd"); never pass that on."""
    return _KEY_RE.sub("sk-…", str(text))


def _hint(status):
    return {401: f"(the {KEY_VAR} is wrong or revoked): ",
            403: "(this key can't use that model): ",
            404: f"(model not found; check {'ANTHROPIC_MODEL' if PROVIDER == 'anthropic' else 'OPENAI_MODEL'}): ",
            429: "(rate limit, or no credit left on the account): "}.get(status, "")


def user_id(raw: str | None) -> str:
    """One password protects the whole app, so userId just separates people sharing it."""
    uid = (raw or DEFAULT_USER).strip()
    if not USER_ID_RE.match(uid):
        raise HTTPException(400, "userId: 1-64 letters, digits, _ . @ or -")
    return uid


def system_prompt() -> str:
    try:
        custom = PROMPT_FILE.read_text().strip()
        if custom:
            return custom
    except OSError:
        pass
    return SYSTEM_PROMPT


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def list_notes(uid, limit=500):
    return db.q("SELECT id, note, created_at FROM memories WHERE user_id=? "
                "ORDER BY created_at DESC, id DESC LIMIT ?", (uid, limit))


def add_note(uid, note):
    note = " ".join(str(note).split())[:300]
    if not note:
        return None
    if note.lower() in {n["note"].lower() for n in list_notes(uid)}:
        return None
    return db.execute("INSERT INTO memories (user_id, note) VALUES (?, ?)", (uid, note))


def recent_sessions(uid, limit=SESSIONS_IN_PROMPT, skip_id=None):
    rows = db.q("SELECT id, exercise, text, score, created FROM coach_sessions WHERE user_id=? "
                "ORDER BY created DESC LIMIT ?", (uid, limit + 1))
    return [r for r in rows if r["id"] != skip_id][:limit]


def recent_messages(uid, limit=CHAT_TURNS_IN_PROMPT):
    rows = db.q("SELECT role, content FROM coach_messages WHERE user_id=? "
                "ORDER BY created DESC, id DESC LIMIT ?", (uid, limit))
    return list(reversed(rows))


def add_message(uid, role, content, session_id=None):
    db.execute("INSERT INTO coach_messages (user_id, role, content, session_id, created) VALUES (?,?,?,?,?)",
               (uid, role, content, session_id, time.time()))


def _ago(ts):
    d = time.time() - ts
    if d < 3600:
        return "just now" if d < 120 else f"{int(d // 60)} min ago"
    if d < 86400:
        return f"{int(d // 3600)} h ago"
    days = int(d // 86400)
    return "yesterday" if days == 1 else f"{days} days ago"


def _short(text, limit=600):
    """A previous session on one line, without the long Details part if it doesn't fit."""
    t = " | ".join(l for l in text.splitlines() if l and l != "PRACTICE SESSION")
    return t if len(t) <= limit else t[:limit].rsplit(" ", 1)[0] + " …"


def memory_block(uid, skip_session=None):
    """Appended to the system prompt: every recent note (they're short), then the last few sessions
    so the coach can spot trends. The session being discussed goes in the user message instead."""
    notes = list_notes(uid, NOTES_IN_PROMPT)
    sessions = recent_sessions(uid, skip_id=skip_session)
    lines = ["## What you remember about this student"]
    lines += [f"- {n['note']}" for n in notes] or ["- Nothing yet."]
    lines += ["", "## Their previous practice sessions (newest first)"]
    lines += [f"- {_ago(s['created'])}: {_short(s['text'])}" for s in sessions] or ["- None yet."]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# the model call
# --------------------------------------------------------------------------

def _failed(e):
    status = getattr(e, "status_code", None)
    msg = _redact(getattr(e, "message", None) or str(e))
    name = "Claude" if PROVIDER == "anthropic" else "OpenAI"
    log.warning("%s call failed (%s %s): %s", name, type(e).__name__, status or "-", msg[:300])
    # 424, not 502: Cloudflare swaps an origin's 502 for its own page and the reason is lost.
    return HTTPException(424, f"{name} {status or ''} {_hint(status)}{msg[:300]}".replace("  ", " "))


def _save_note_call(uid, args):
    """Carry out a save_note tool call; returns (result for the model, saved note or None)."""
    try:
        if isinstance(args, str):
            args = json.loads(args or "{}")
        note = " ".join(str(args.get("note", "")).split())[:300]
        nid = add_note(uid, note)
    except (ValueError, AttributeError, TypeError):
        return {"ok": False, "reason": "bad arguments"}, None
    if not nid:
        return {"ok": False, "reason": "empty or already remembered"}, None
    return {"ok": True, "id": nid}, {"id": nid, "note": note}


def run_coach(uid, messages, session_id=None):
    """Call the model, carry out any save_note calls, and return (reply, notes added).
    messages is OpenAI-shaped (system first); the Anthropic path converts it."""
    if PROVIDER == "anthropic":
        return _run_anthropic(uid, messages)
    saved = []
    for _ in range(3):   # at most two rounds of tool calls, then a final answer
        try:
            resp = client().chat.completions.create(
                model=MODEL, messages=messages, tools=TOOLS, max_completion_tokens=MAX_TOKENS)
        except HTTPException:
            raise
        except Exception as e:   # openai.APIError and friends
            raise _failed(e)
        msg = resp.choices[0].message
        if not msg.tool_calls:
            reply = (msg.content or "").strip()
            if not reply and resp.choices[0].finish_reason == "length":
                reply = "(The reply ran out of room. Raise COACH_MAX_TOKENS.)"
            return reply or "(The coach didn't answer. Try again.)", saved
        messages.append({"role": "assistant", "content": msg.content,
                         "tool_calls": [tc.model_dump() for tc in msg.tool_calls]})
        for tc in msg.tool_calls:
            result = {"ok": False}
            if tc.function.name == "save_note":
                result, note = _save_note_call(uid, tc.function.arguments)
                if note:
                    saved.append(note)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result)})
    return "(The coach didn't answer. Try again.)", saved


ANTHROPIC_TOOLS = [{"name": t["function"]["name"], "description": t["function"]["description"],
                    "input_schema": t["function"]["parameters"]} for t in TOOLS]


def _run_anthropic(uid, messages):
    system = messages[0]["content"]
    convo = []
    for m in messages[1:]:   # merge back-to-back turns from the same side (session + question)
        if convo and convo[-1]["role"] == m["role"] and isinstance(convo[-1]["content"], str):
            convo[-1]["content"] += "\n\n" + m["content"]
        else:
            convo.append({"role": m["role"], "content": m["content"]})
    saved, texts = [], []
    extra = {"thinking": {"type": "disabled"}} if THINKING == "off" else {}
    for _ in range(3):
        try:
            try:
                resp = client().messages.create(model=MODEL, system=system, messages=convo,
                                                tools=ANTHROPIC_TOOLS, max_tokens=MAX_TOKENS, **extra)
            except Exception as e:
                # A model that can't switch thinking off: ask again with its default.
                if extra and getattr(e, "status_code", None) == 400 and "thinking" in str(e).lower():
                    log.info("model %s won't turn thinking off; using its default", MODEL)
                    extra = {}
                    resp = client().messages.create(model=MODEL, system=system, messages=convo,
                                                    tools=ANTHROPIC_TOOLS, max_tokens=MAX_TOKENS)
                else:
                    raise
        except HTTPException:
            raise
        except Exception as e:   # anthropic.APIError and friends
            raise _failed(e)
        log.info("claude: stop=%s blocks=%s out_tokens=%s", resp.stop_reason,
                 ",".join(b.type for b in resp.content), getattr(resp.usage, "output_tokens", "?"))
        texts += [b.text for b in resp.content if b.type == "text" and b.text.strip()]
        uses = [b for b in resp.content if b.type == "tool_use"]
        if resp.stop_reason != "tool_use" or not uses:
            reply = "\n\n".join(t.strip() for t in texts)
            if resp.stop_reason == "max_tokens":
                reply = (reply + " …") if reply else "(The reply ran out of room. Raise COACH_MAX_TOKENS.)"
            return reply or "(The coach didn't answer. Try again.)", saved
        convo.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in resp.content]})
        results = []
        for b in uses:
            result = {"ok": False, "reason": "unknown tool"}
            if b.name == "save_note":
                result, note = _save_note_call(uid, b.input)
                if note:
                    saved.append(note)
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(result)})
        convo.append({"role": "user", "content": results})
    return "\n\n".join(texts) or "(The coach didn't answer. Try again.)", saved


# --------------------------------------------------------------------------
# POST /api/session
# --------------------------------------------------------------------------

def _clip_list(v, n=50, each=200):
    if v is None:
        return []
    if not isinstance(v, list):
        v = [v]
    return [str(x)[:each] for x in v[:n]]


EXERCISE_LABELS = {"lesson": "Course lesson", "youtube_run": "Sing-along with a song", "coach_drill": "Coach page drill"}


class SessionIn(BaseModel):
    userId: str | None = None
    exerciseType: str = Field(min_length=1, max_length=60)   # lesson | youtube_run | coach_drill (others allowed)
    title: str | None = Field(default=None, max_length=200)  # "Lesson 3.2: Clean starts", a song title, a drill name
    lessonId: str | None = Field(default=None, max_length=20)
    songId: str | None = Field(default=None, max_length=40)
    passed: bool | None = None                                # lessons: did this attempt pass
    targetNotes: list[Any] = Field(default_factory=list)
    pitchAccuracy: float | None = Field(default=None, ge=0, le=100)   # 0-100; what it measures is said in details
    detectedRange: Any = None                                 # {"low": "C3", "high": "G4"} or "C3–G4"
    missedNotes: list[Any] = Field(default_factory=list)      # "E3" or {"note": "E3", "direction": "flat", "count": 2}
    tendency: str | None = Field(default=None, max_length=20) # sharp | flat | mixed | centred
    weakestNotes: list[Any] = Field(default_factory=list)
    userMessage: str | None = Field(default=None, max_length=2000)
    details: str | None = Field(default=None, max_length=4000)  # anything else, as text

    @field_validator("targetNotes", "weakestNotes")
    @classmethod
    def _lists(cls, v):
        return _clip_list(v)

    @field_validator("missedNotes")
    @classmethod
    def _missed(cls, v):
        """Keep {note, direction, count} objects as small dicts; anything else becomes a string."""
        out = []
        for x in (v if isinstance(v, list) else [v])[:50]:
            if isinstance(x, dict):
                d = {"note": str(x.get("note", "?"))[:12]}
                if x.get("direction"):
                    d["direction"] = str(x["direction"])[:30]
                if isinstance(x.get("count"), int) and x["count"] > 1:
                    d["count"] = min(x["count"], 9999)
                out.append(d)
            elif x is not None:
                out.append(str(x)[:40])
        return out


def _fmt_range(r):
    if isinstance(r, dict):
        lo, hi = r.get("low") or r.get("min"), r.get("high") or r.get("max")
        return f"{lo}–{hi}" if lo and hi else None
    return str(r)[:40] if r else None


def _fmt_missed(m):
    if isinstance(m, dict):
        t = m["note"] + (f" ({m['direction']})" if m.get("direction") else "")
        return t + (f" ×{m['count']}" if m.get("count") else "")
    return m


def _missed_name(m):
    return m["note"] if isinstance(m, dict) else m


def session_text(s: SessionIn) -> str:
    """The session summary as structured text: the only thing the model learns about the singing."""
    kind = EXERCISE_LABELS.get(s.exerciseType, s.exerciseType)
    lines = ["PRACTICE SESSION", f"Exercise: {kind}" + (f": {s.title}" if s.title else "")]
    if s.passed is not None:
        lines.append(f"Lesson result: {'passed' if s.passed else 'not passed yet'}")
    if s.targetNotes:
        lines.append(f"Target notes: {', '.join(s.targetNotes)}")
    if s.pitchAccuracy is not None:
        lines.append(f"Pitch accuracy: {round(s.pitchAccuracy)}%")
    rng = _fmt_range(s.detectedRange)
    if rng:
        lines.append(f"Detected range this session: {rng}")
    if s.tendency:
        lines.append(f"Tendency: {s.tendency}")
    missed_names = {_missed_name(m) for m in s.missedNotes}
    if s.targetNotes:
        lines.append(f"Notes hit: {', '.join(n for n in s.targetNotes if n not in missed_names) or 'none'}")
    if s.targetNotes or s.missedNotes:
        lines.append(f"Notes missed: {', '.join(_fmt_missed(m) for m in s.missedNotes) or 'none'}")
    if s.weakestNotes:
        lines.append(f"Weakest notes: {', '.join(s.weakestNotes)}")
    if s.details:
        lines.append("Details: " + s.details.strip())
    return "\n".join(lines)


@router.post("/api/session")
def session(s: SessionIn):
    uid = user_id(s.userId)
    text = session_text(s)
    summary = s.model_dump(exclude={"userId", "userMessage"})
    sid = db.execute("INSERT INTO coach_sessions (user_id, exercise, summary, text, score, created) VALUES (?,?,?,?,?,?)",
                     (uid, s.exerciseType, json.dumps(summary), text, s.pitchAccuracy, time.time()))

    messages = [
        {"role": "system", "content": system_prompt() + "\n\n" + memory_block(uid, skip_session=sid)},
        {"role": "user", "content": text},
    ]
    question = (s.userMessage or "").strip()
    if question:
        messages.append({"role": "user", "content": question})

    reply, saved = run_coach(uid, messages, sid)
    add_message(uid, "user", text + (f"\n\n{question}" if question else ""), sid)
    add_message(uid, "assistant", reply, sid)
    return {"reply": reply, "sessionId": sid, "notesAdded": saved, "sent": text}


# --------------------------------------------------------------------------
# /api/memory
# --------------------------------------------------------------------------

class MemoryIn(BaseModel):
    userId: str | None = None
    note: str = Field(min_length=1, max_length=300)


@router.post("/api/memory")
def memory_add(m: MemoryIn):
    uid = user_id(m.userId)
    nid = add_note(uid, m.note)
    if not nid:
        raise HTTPException(409, "Already remembered")
    return {"id": nid}


@router.get("/api/memory")
def memory_list(userId: str | None = None):
    return list_notes(user_id(userId))


class OwnerIn(BaseModel):
    userId: str | None = None


@router.delete("/api/memory/{note_id}")
def memory_delete(note_id: int, userId: str | None = Query(default=None), body: OwnerIn | None = Body(default=None)):
    uid = user_id(userId or (body.userId if body else None))
    row = db.q("SELECT user_id FROM memories WHERE id=?", (note_id,), one=True)
    if not row or row["user_id"] != uid:   # same answer either way, so ids can't be probed
        raise HTTPException(404, "No such note")
    db.execute("DELETE FROM memories WHERE id=? AND user_id=?", (note_id, uid))
    return {"ok": True}


# --------------------------------------------------------------------------
# extras for the /coach page
# --------------------------------------------------------------------------

class ChatIn(BaseModel):
    userId: str | None = None
    message: str = Field(min_length=1, max_length=2000)


@router.get("/api/coach/status")
def status():
    return {"configured": bool(_key()), "provider": PROVIDER, "model": MODEL, "keyVar": KEY_VAR,
            "customPrompt": PROMPT_FILE.exists()}


@router.post("/api/coach/chat")
def chat(c: ChatIn):
    """A follow-up question, with the recent conversation for context."""
    uid = user_id(c.userId)
    messages = [{"role": "system", "content": system_prompt() + "\n\n" + memory_block(uid)}]
    messages += [{"role": m["role"], "content": m["content"]} for m in recent_messages(uid)]
    messages.append({"role": "user", "content": c.message.strip()})
    reply, saved = run_coach(uid, messages)
    add_message(uid, "user", c.message.strip())
    add_message(uid, "assistant", reply)
    return {"reply": reply, "notesAdded": saved}


@router.get("/api/coach/messages")
def messages(userId: str | None = None, limit: int = 50):
    uid = user_id(userId)
    rows = db.q("SELECT id, role, content, session_id, created FROM coach_messages WHERE user_id=? "
                "ORDER BY created DESC, id DESC LIMIT ?", (uid, max(1, min(limit, 500))))
    return list(reversed(rows))


@router.delete("/api/coach/messages")
def clear_messages(userId: str | None = None):
    db.execute("DELETE FROM coach_messages WHERE user_id=?", (user_id(userId),))
    return {"ok": True}


@router.get("/api/coach/sessions")
def sessions(userId: str | None = None, limit: int = 10):
    return recent_sessions(user_id(userId), max(1, min(limit, 200)))


@router.delete("/api/coach/sessions/{sid}")
def delete_session(sid: int, userId: str | None = None):
    db.execute("DELETE FROM coach_sessions WHERE id=? AND user_id=?", (sid, user_id(userId)))
    return {"ok": True}


@router.get("/api/coach/preview")
def preview(userId: str | None = None):
    """Exactly what goes into the system message, for the memory panel."""
    uid = user_id(userId)
    return {"system": system_prompt() + "\n\n" + memory_block(uid)}


@router.delete("/api/coach/everything")
def forget_everything(userId: str | None = None):
    uid = user_id(userId)
    for t in ("memories", "coach_sessions", "coach_messages"):
        db.execute(f"DELETE FROM {t} WHERE user_id=?", (uid,))
    return {"ok": True}
