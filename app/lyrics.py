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


_SEPS = (" - ", " – ", " — ", " | ", " ~ ", ": ", " // ", " -- ")
_QUOTED = re.compile(r'^(.+?)\s+["“\'‘](.+?)["”\'’]\s*$')
_PAREN = re.compile(r"\s*[\(\[\{][^)\]\}]*[\)\]\}]")
_CHANNEL_JUNK = re.compile(r"\s*(-\s*topic|vevo|official|music|tv|channel|band)\s*$", re.I)


def clean_title(title: str) -> str:
    t = title or ""
    for _ in range(3):
        t = _JUNK.sub("", t)
    t = re.sub(r"\s+(official\s+)?(music\s+)?(video|audio|lyrics?|visuali[sz]er)\s*$", "", t, flags=re.I)
    return t.replace("“", '"').replace("”", '"').strip(" -–—|\"'")


def split_title(title: str) -> tuple[str, str]:
    """Best single guess at (artist, track), for showing in the search form."""
    g = guesses(title)
    return (g[0] if g else ("", clean_title(title)))


def guesses(title: str, meta: dict | None = None) -> list[tuple[str, str]]:
    """Possible (artist, track) readings of a video, most likely first.

    Titles come as "Artist - Song", "Song - Artist", "Artist | Song", 'Artist "Song"', or just
    "Song" (then the channel name is often the artist). YouTube Music videos carry real
    artist/track fields, which beat any guess.
    """
    meta = meta or {}
    out = []
    if meta.get("artist") and meta.get("track"):
        out.append((str(meta["artist"]).split(",")[0].strip(), str(meta["track"]).strip()))
    t = clean_title(title)
    m = _QUOTED.match(t)
    if m:
        out.append((m.group(1).strip(" -–—|:"), m.group(2).strip()))
    for sep in _SEPS:
        if sep in t:
            left, right = (x.strip(" \"'") for x in t.split(sep, 1))
            right = _TAIL.sub("", right)
            left, right = _FEAT.sub("", left).strip(), _FEAT.sub("", right).strip(" \"'")
            if left and right:
                out += [(left, right), (right, left)]
            break
    ch = channel_artist(meta)
    if ch and not out:
        out.append((ch, _FEAT.sub("", t).strip()))
    if not out:
        out.append(("", _FEAT.sub("", t).strip()))
    seen, uniq = set(), []
    for a, tr in out:
        if tr and (a.lower(), tr.lower()) not in seen:
            seen.add((a.lower(), tr.lower()))
            uniq.append((a, tr))
    return uniq


def channel_artist(meta: dict | None) -> str:
    ch = (meta or {}).get("channel") or (meta or {}).get("uploader") or ""
    return _CHANNEL_JUNK.sub("", ch).strip() if ch else ""


# --------------------------------------------------------------------------
# LRCLIB
# --------------------------------------------------------------------------

def _lrclib(path, params=None):
    url = f"{LRCLIB}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
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


def _norm(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = _PAREN.sub(" ", s).replace("&", " and ")
    s = re.sub(r"\b(the|feat|ft|featuring)\b", " ", s)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def _sim(a: str, b: str) -> float:
    from difflib import SequenceMatcher
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    r = SequenceMatcher(None, a, b).ratio()
    ta, tb = set(a.split()), set(b.split())
    if ta <= tb or tb <= ta:   # one is the other plus extra words ("Numb" / "Numb Remastered")
        r = max(r, 0.85 * len(ta & tb) / max(len(ta), len(tb)) + 0.15)
    return r


_VERSION = re.compile(r"\b(live|acoustic|remix|megamix|mix|instrumental|karaoke|tribute|sped|slowed|reverb|demo|cover|"
                      r"nightcore|8d|piano|orchestral|unplugged|version|edit|remaster(?:ed)?)\b", re.I)


def score_record(r: dict, hyps: list, title: str, duration: float, channel: str = "") -> float:
    """0..1 text match (artist + track) with small adjustments for length, timing and versions."""
    ra, rt = r.get("artistName") or "", r.get("trackName") or ""
    best = 0.0
    for a, t in hyps:
        ts = _sim(rt, t)
        if a:
            s = 0.55 * ts + 0.45 * _sim(ra, a)
        elif channel:
            s = 0.55 * ts + 0.45 * max(_sim(ra, channel), 0.3)
        else:
            s = 0.55 * ts + 0.15
        best = max(best, s)
    # Titles in an odd order: fine if every word of the record's artist and track is in the title.
    tt = set(_norm(clean_title(title)).split())
    if tt and set(_norm(ra).split()) <= tt and set(_norm(rt).split()) <= tt and _norm(ra) and _norm(rt):
        best = max(best, 0.95)
    # A live/acoustic/karaoke/remix take when the video doesn't say so.
    title_words = {w.lower() for w in _VERSION.findall(title or "")}
    extra = {w.lower() for w in _VERSION.findall(f"{ra} {rt}")} - title_words - {"remaster", "remastered"}
    best -= min(0.3, 0.15 * len(extra))
    if duration and r.get("duration"):
        dd = abs(r["duration"] - duration)
        best -= 0 if dd <= 3 else min(0.12, dd / 600)   # videos often add intros; length only breaks ties
    if r.get("syncedLyrics"):
        best += 0.04
    return round(best, 3)


def lrclib_search(title: str, duration: float, meta: dict | None = None,
                  artist: str | None = None, track: str | None = None, limit: int = 20) -> list[dict]:
    """LRCLIB records for this song, best first, each with a "score" (0..1)."""
    if artist is not None or track is not None:
        hyps = [(artist or "", track or "")] if track else []
        q_extra = [f"{artist or ''} {track or ''}".strip()]
    else:
        hyps = guesses(title, meta)
        q_extra = [clean_title(title)]
    channel = channel_artist(meta)
    seen, records = set(), []

    def add(rs):
        for r in rs or []:
            if r.get("id") not in seen and not r.get("instrumental") and (r.get("syncedLyrics") or r.get("plainLyrics")):
                seen.add(r.get("id"))
                records.append(r)

    calls = 0
    for a, t in hyps[:3]:
        add(_lrclib("/api/search", {"track_name": t, "artist_name": a} if a else {"track_name": t})); calls += 1
    for q in q_extra:
        if q and calls < 5:
            add(_lrclib("/api/search", {"q": q})); calls += 1
    for r in records:
        r["score"] = score_record(r, hyps or [("", q_extra[0])], title if track is None else f"{artist} - {track}",
                                  duration, channel)
    records.sort(key=lambda r: -r["score"])
    return records[:limit]


MATCH_MIN = 0.8   # below this the automatic lookup gives up rather than show the wrong song


def lrclib_lookup(artist: str, track: str, duration: float, title: str | None = None, meta: dict | None = None) -> dict | None:
    """Best LRCLIB record for this song, or None if nothing matches well enough."""
    if title is not None and not (artist or track):
        recs = lrclib_search(title, duration, meta)
    else:
        recs = lrclib_search(title or f"{artist} - {track}", duration, meta, artist, track)
    return recs[0] if recs and recs[0]["score"] >= MATCH_MIN else None


def lrclib_get(rec_id: int) -> dict | None:
    return _lrclib(f"/api/get/{int(rec_id)}")


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


def from_record(rec: dict, notes: list, duration: float) -> dict | None:
    """lyrics.json data from an LRCLIB record (timed if it has timing)."""
    match = {"artist": rec.get("artistName"), "track": rec.get("trackName"), "id": rec.get("id"),
             "duration": rec.get("duration")}
    if rec.get("syncedLyrics"):
        lines = parse_lrc(rec["syncedLyrics"])
        if lines:
            # a video with a long intro can sit well away from the album timing
            dd = abs((rec.get("duration") or duration) - duration) if duration else 0
            return {"source": "lrclib", "synced": True, "lines": lines, "match": match,
                    "offset": best_offset(lines, notes, search=max(40.0, min(240.0, dd + 15)))}
    if rec.get("plainLyrics"):
        return {"source": "lrclib", "synced": False, "lines": plain_lines(rec["plainLyrics"]), "offset": 0.0,
                "match": match}
    return None


def load_meta(song_dir: Path) -> dict:
    p = song_dir / "meta.json"
    try:
        return json.loads(p.read_text()) if p.exists() else {}
    except ValueError:
        return {}


def find(song_dir: Path, title: str, duration: float, notes: list,
         source: str = "auto", artist: str | None = None, track: str | None = None) -> dict:
    """Look up or transcribe lyrics and save them. Raises LyricsError if nothing worked."""
    meta = load_meta(song_dir)
    tried = []
    plain = None
    if source in ("auto", "lrclib"):
        try:
            if not (artist or track):
                rec = lrclib_lookup("", "", duration, title=title, meta=meta)
            else:
                rec = lrclib_lookup(artist or "", track or "", duration, meta=meta)
        except requests.RequestException as e:
            rec = None
            tried.append(f"LRCLIB unreachable ({e.__class__.__name__})")
        data = from_record(rec, notes, duration) if rec else None
        if data and data["synced"]:
            return save(song_dir, data)
        plain = data
        what = f"{artist + ' - ' if artist else ''}{track}" if track else clean_title(title)
        tried.append(f'LRCLIB had no timed lyrics that matched "{what}" (try "Choose from LRCLIB")')
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
        return save(song_dir, plain)
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
