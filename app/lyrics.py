"""Timed lyrics for a song.

Order of attempts:
  1. LRCLIB (free, community-checked, line-timed lyrics), matched on artist, title and length
  2. Groq's hosted Whisper transcribing the separated vocal (needs GROQ_API_KEY), word-timed
  3. LRCLIB plain (untimed) lyrics, shown as a scrolling page

Saved as lyrics.json next to the song:
  {source, synced, offset, lines: [{t0, t1, text, words?: [{t0, t1, w}]}], match, edited}
Times are seconds in the song. `offset` is added at display time (user nudges and the
automatic alignment both live there).
"""
import json
import logging
import os
import re
import subprocess
import time
import urllib.parse
from pathlib import Path

import requests

log = logging.getLogger("lyrics")

UA = "VocalLab/1.0 (https://github.com/dabsy1111/singing-training)"
LRCLIB = os.environ.get("LRCLIB_URL", "https://lrclib.net")
GROQ_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_WHISPER_MODEL", "whisper-large-v3")
GROQ_URL = os.environ.get("GROQ_URL", "https://api.groq.com/openai/v1/audio/transcriptions")
GROQ_LANGUAGE = os.environ.get("GROQ_LANGUAGE", "").strip()   # e.g. "en"; empty = auto-detect


class LyricsError(Exception):
    pass


# --------------------------------------------------------------------------
# title cleaning: "Artist - Song (Official Video) [HD]" -> ("Artist", "Song")
# --------------------------------------------------------------------------

_JUNK = re.compile(
    r"\s*[\(\[\{][^)\]\}]*\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|hd|hq|4k|remaster(ed)?|"
    r"live|explicit|clean|music video|mv|full album|from)\b[^)\]\}]*[\)\]\}]",
    re.I)
_TAIL = re.compile(r"\s*(\||//)\s.*$")
_FEAT = re.compile(r"\s+(feat\.?|ft\.?|featuring)\s.*$", re.I)


def split_title(title: str) -> tuple[str, str]:
    t = _TAIL.sub("", title or "")
    for _ in range(3):
        t = _JUNK.sub("", t)
    t = re.sub(r"\s+(official\s+)?(music\s+)?(video|audio|lyrics?)\s*$", "", t, flags=re.I)
    t = t.replace("“", '"').replace("”", '"').strip(" -–—\"'")
    for sep in (" - ", " – ", " — ", " ~ ", ": "):
        if sep in t:
            artist, track = t.split(sep, 1)
            return _FEAT.sub("", artist).strip(), _FEAT.sub("", track).strip(" \"'")
    return "", t.strip()


# --------------------------------------------------------------------------
# LRCLIB
# --------------------------------------------------------------------------

def _lrclib(path, params):
    url = f"{LRCLIB}{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(3):
        r = requests.get(url, headers={"User-Agent": UA}, timeout=15)
        if r.status_code in (429, 503):
            time.sleep(min(10, float(r.headers.get("Retry-After", "2")) * 1.3))
            continue
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()
    return None


def lrclib_lookup(artist: str, track: str, duration: float) -> dict | None:
    """Best LRCLIB record for this song, preferring timed lyrics and a close length."""
    rec = None
    if artist and track and duration:
        rec = _lrclib("/api/get", {"artist_name": artist, "track_name": track, "duration": int(round(duration))})
    if rec and (rec.get("syncedLyrics") or rec.get("plainLyrics")):
        return rec
    params = {"track_name": track, "artist_name": artist} if artist else {"q": track}
    results = _lrclib("/api/search", params) or []
    if not results and artist:
        results = _lrclib("/api/search", {"q": f"{artist} {track}"}) or []
    best, best_score = None, None
    for r in results:
        if r.get("instrumental") or not (r.get("syncedLyrics") or r.get("plainLyrics")):
            continue
        dd = abs((r.get("duration") or 0) - duration) if duration else 0
        # Videos often have an intro or outro, so allow some slack; timed lyrics win ties.
        score = dd - (20 if r.get("syncedLyrics") else 0)
        if dd <= max(25, 0.15 * duration) and (best_score is None or score < best_score):
            best, best_score = r, score
    return best


_LRC_LINE = re.compile(r"^((?:\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$")
_LRC_TIME = re.compile(r"\[(\d+):(\d+)(?:[.:](\d+))?\]")


def parse_lrc(text: str) -> list[dict]:
    lines = []
    for raw in (text or "").splitlines():
        m = _LRC_LINE.match(raw.strip())
        if not m:
            continue
        words = m.group(2).strip()
        for mm, ss, frac in _LRC_TIME.findall(m.group(1)):
            t = int(mm) * 60 + int(ss) + (int(frac) / (10 ** len(frac)) if frac else 0)
            lines.append({"t0": round(t, 2), "text": words})
    lines.sort(key=lambda l: l["t0"])
    out = []
    for i, l in enumerate(lines):
        nxt = lines[i + 1]["t0"] if i + 1 < len(lines) else l["t0"] + 5
        if l["text"]:
            out.append({"t0": l["t0"], "t1": round(min(nxt, l["t0"] + 12), 2), "text": l["text"]})
    return out


def plain_lines(text: str) -> list[dict]:
    return [{"t0": None, "t1": None, "text": t.strip()} for t in (text or "").splitlines()]


# --------------------------------------------------------------------------
# alignment: video versions often start earlier or later than the album version
# --------------------------------------------------------------------------

def phrase_onsets(notes: list, gap: float = 0.35) -> list[float]:
    out, last_end = [], -10.0
    for n in notes:
        if n["t0"] - last_end >= gap:
            out.append(n["t0"])
        last_end = max(last_end, n["t1"])
    return out


def best_offset(lines: list, notes: list, search: float = 40.0) -> float:
    """Shift that puts the most line starts on a sung phrase start.

    Deliberately cautious: a wrong shift is worse than none, so it only moves when at
    least half the lines land on phrase starts and that beats no shift by a wide margin.
    """
    onsets = phrase_onsets(notes)
    starts = [l["t0"] for l in lines if l.get("t0") is not None]
    if len(onsets) < 6 or len(starts) < 8:
        return 0.0
    import bisect

    def score(off):
        s = 0.0
        for t in starts:
            t += off
            i = bisect.bisect_left(onsets, t - 0.5)
            if i < len(onsets) and abs(onsets[i] - t) <= 0.5:
                s += 1 - abs(onsets[i] - t) / 0.5
        return s

    scored = []
    off = -search
    while off <= search + 1e-9:
        scored.append((score(off), off))
        off = round(off + 0.05, 2)
    best_s, best = max(scored, key=lambda x: (x[0], -abs(x[1])))
    base = score(0.0)
    if best_s >= 0.5 * len(starts) and best_s >= base * 1.5 + 2:
        return round(best, 2)
    return 0.0


# --------------------------------------------------------------------------
# Groq Whisper
# --------------------------------------------------------------------------

_HALLUCINATIONS = re.compile(
    r"^(thank(s| you) (so much )?for watching|please subscribe|subtitles by|transcribed by|"
    r"\[?music\]?|\(?music\)?|♪+|\.+|you)\W*$", re.I)


def groq_transcribe(vocals_mp3: Path, notes: list, workdir: Path) -> list[dict]:
    if not GROQ_KEY:
        raise LyricsError("No GROQ_API_KEY set")
    small = workdir / ".vocals-16k.mp3"
    # Whisper works at 16 kHz mono anyway; this keeps a 5-minute song around 2 MB.
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(vocals_mp3), "-ac", "1", "-ar", "16000",
                    "-b:a", "48k", str(small)], check=True)
    try:
        data = {"model": GROQ_MODEL, "response_format": "verbose_json", "temperature": "0"}
        if GROQ_LANGUAGE:
            data["language"] = GROQ_LANGUAGE
        files = [("timestamp_granularities[]", (None, "word")), ("timestamp_granularities[]", (None, "segment"))]
        with small.open("rb") as f:
            r = requests.post(GROQ_URL,
                              headers={"Authorization": f"Bearer {GROQ_KEY}"},
                              data=data, files=[("file", ("vocals.mp3", f, "audio/mpeg")), *files], timeout=180)
    finally:
        small.unlink(missing_ok=True)
    if r.status_code == 401:
        raise LyricsError("Groq rejected the API key (check GROQ_API_KEY)")
    if r.status_code == 429:
        raise LyricsError("Groq rate limit hit; try again in a minute")
    if r.status_code >= 400:
        raise LyricsError(f"Groq error {r.status_code}: {r.text[:300]}")
    return lines_from_whisper(r.json(), notes)


def _voiced_fraction(t0, t1, notes):
    if t1 <= t0:
        return 0.0
    v = sum(max(0.0, min(t1, n["t1"]) - max(t0, n["t0"])) for n in notes if n["t1"] > t0 and n["t0"] < t1)
    return v / (t1 - t0)


def lines_from_whisper(res: dict, notes: list) -> list[dict]:
    """Turn Whisper segments + words into lyric lines, dropping invented text over silence."""
    words = [w for w in res.get("words") or [] if str(w.get("word", "")).strip()]
    out = []
    for seg in res.get("segments") or []:
        text = str(seg.get("text", "")).strip()
        t0, t1 = float(seg.get("start", 0)), float(seg.get("end", 0))
        if not text or _HALLUCINATIONS.match(text):
            continue
        if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -0.8:
            continue
        if notes and _voiced_fraction(t0, t1, notes) < 0.15:
            continue   # Whisper "heard" words where nobody sings
        sw = [{"t0": round(float(w["start"]), 2), "t1": round(float(w["end"]), 2), "w": str(w["word"]).strip()}
              for w in words if t0 - 0.05 <= float(w["start"]) < t1 + 0.05]
        # Long segments read badly on a phone: split at the biggest pause past ~8 words.
        for chunk in _split_words(sw) if sw else [None]:
            if chunk is None:
                out.append({"t0": round(t0, 2), "t1": round(t1, 2), "text": text})
            else:
                out.append({"t0": chunk[0]["t0"], "t1": chunk[-1]["t1"],
                            "text": " ".join(w["w"] for w in chunk), "words": chunk})
    return out


def _split_words(ws, max_words=9):
    if len(ws) <= max_words:
        return [ws]
    gaps = [(ws[i + 1]["t0"] - ws[i]["t1"], i) for i in range(3, len(ws) - 3)]
    _, i = max(gaps) if gaps else (0, len(ws) // 2)
    return _split_words(ws[: i + 1], max_words) + _split_words(ws[i + 1:], max_words)


# --------------------------------------------------------------------------
# entry points
# --------------------------------------------------------------------------

def path_for(song_dir: Path) -> Path:
    return song_dir / "lyrics.json"


def load(song_dir: Path) -> dict | None:
    p = path_for(song_dir)
    return json.loads(p.read_text()) if p.exists() else None


def save(song_dir: Path, data: dict) -> dict:
    path_for(song_dir).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return data


def find(song_dir: Path, title: str, duration: float, notes: list,
         source: str = "auto", artist: str | None = None, track: str | None = None) -> dict:
    """Look up or transcribe lyrics and save them. Raises LyricsError if nothing worked."""
    if artist is None or track is None:
        a, t = split_title(title)
        artist = a if artist is None else artist
        track = t if track is None else track
    tried = []
    plain = None
    if source in ("auto", "lrclib") and track:
        try:
            rec = lrclib_lookup(artist, track, duration)
        except requests.RequestException as e:
            rec = None
            tried.append(f"LRCLIB unreachable ({e.__class__.__name__})")
        if rec and rec.get("syncedLyrics"):
            lines = parse_lrc(rec["syncedLyrics"])
            if lines:
                return save(song_dir, {
                    "source": "lrclib", "synced": True, "lines": lines, "offset": best_offset(lines, notes),
                    "match": {"artist": rec.get("artistName"), "track": rec.get("trackName"), "id": rec.get("id")},
                })
        if rec and rec.get("plainLyrics"):
            plain = rec
        tried.append(f'LRCLIB had no timed lyrics for "{artist + " - " if artist else ""}{track}"')
    if source in ("auto", "groq"):
        if GROQ_KEY:
            lines = groq_transcribe(song_dir / "vocals.mp3", notes, song_dir)
            if lines:
                return save(song_dir, {"source": "groq", "synced": True, "lines": lines, "offset": 0.0,
                                       "match": {"model": GROQ_MODEL}})
            tried.append("Whisper didn't hear any words")
        else:
            tried.append("no GROQ_API_KEY set for transcription")
    if plain:
        return save(song_dir, {
            "source": "lrclib", "synced": False, "lines": plain_lines(plain["plainLyrics"]), "offset": 0.0,
            "match": {"artist": plain.get("artistName"), "track": plain.get("trackName"), "id": plain.get("id")},
        })
    raise LyricsError("; ".join(tried) or "nothing to search for")


def edit_text(old: dict, text: str) -> dict:
    """Replace the words. Same number of lines keeps the timing; otherwise spread the new
    lines over the old time span, weighted by length."""
    new = [t.strip() for t in text.splitlines() if t.strip()]
    lines = old.get("lines") or []
    timed = [l for l in lines if l.get("t0") is not None]
    if not old.get("synced") or not timed:
        out = [{"t0": None, "t1": None, "text": t} for t in new]
    elif len(new) == len(lines):
        out = [{**l, "text": t, **({"words": None} if l.get("words") and l["text"] != t else {})}
               for l, t in zip(lines, new)]
        for l in out:
            if l.get("words") is None:
                l.pop("words", None)
    else:
        start, end = timed[0]["t0"], timed[-1]["t1"]
        weights = [max(1, len(t)) for t in new]
        total, acc, out = sum(weights), 0, []
        for t, w in zip(new, weights):
            t0 = start + (end - start) * acc / total
            acc += w
            out.append({"t0": round(t0, 2), "t1": round(start + (end - start) * acc / total, 2), "text": t})
    return {**old, "lines": out, "edited": True}
