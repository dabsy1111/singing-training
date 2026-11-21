"""Melody notes charted by people, looked up instead of (or alongside) the melody finder.

Karaoke and rhythm games have tens of thousands of songs whose vocal line someone has
already written out note by note. When one of those charts matches the song, its notes are
usually better than anything detected from separated audio: right pitches, one note per
syllable, nothing on screams or backing vocals.

Sources (see NOTE_SOURCES):
  allkaraoke  AllKaraoke.party song files (UltraStar txt, ~7,700 songs, each tied to a YouTube video).
              No account needed.
  usdb        usdb.animux.de, the big UltraStar database (~50,000 txt files). Needs a free account:
              USDB_USER / USDB_PASSWORD.
  encore      Encore (enchor.us), the Clone Hero / YARG chart search: Rock Band and Guitar Hero charts
              with a PART VOCALS track. Only notes.mid is fetched (HTTP range requests on the .sng).
  hooktheory  Hooktheory TheoryTab melodies as released with Sheet Sage (Donahue et al. 2022,
              CC BY-NC-SA 3.0): ~26,000 song sections aligned to ~15,000 YouTube videos. Sections
              (verse, chorus), not whole songs, so they fill in parts of the melody.
  st500       MIR-ST500 (Wang & Jang, ICASSP 2021): 500 pop songs (mostly Mandarin) with hand-labelled
              vocal notes, keyed by YouTube video.
  midi        BitMidi: MIDI files of songs. A melody track there has its own tempo, so it gets a wider
              search (tempo stretch and drift) and a stricter test.

Charts are lined up with the song by comparing them with the singer's pitch line (the
SwiftF0 contour the pipeline already has): first a global offset, key shift and (for MIDI)
tempo, then each phrase is nudged on its own. A chart is only used if its notes sit on the
pitch line; otherwise the detected notes stay.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import re
import struct
import time
import urllib.parse
from pathlib import Path

import numpy as np
import requests

log = logging.getLogger("notesources")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CACHE = DATA_DIR / "cache" / "notesources"
UA = "VocalLab/1.0 (https://github.com/dabsy1111/singing-training)"
SOURCES = [s.strip().lower() for s in os.environ.get("NOTE_SOURCES", "allkaraoke,usdb,encore,hooktheory,st500,midi").split(",")
           if s.strip().lower() in ("allkaraoke", "usdb", "encore", "hooktheory", "st500", "midi")]   # "none" = off
USDB_USER = os.environ.get("USDB_USER", "").strip()
USDB_PASSWORD = os.environ.get("USDB_PASSWORD", "").strip()
ALLKARAOKE = os.environ.get("ALLKARAOKE_URL", "https://allkaraoke.party")
HOOKTHEORY_URL = os.environ.get(
    "HOOKTHEORY_URL", "https://github.com/chrisdonahue/sheetsage-data/raw/refs/heads/main/hooktheory/Hooktheory.json.gz")
ST500_BASE = os.environ.get(
    "ST500_URL", "https://raw.githubusercontent.com/york135/singing_transcription_ICASSP2021/main/MIR-ST500_20210206")
INDEX_MAX_AGE = 7 * 86400        # re-download song indexes weekly

NAME = {"allkaraoke": "AllKaraoke", "usdb": "USDB", "encore": "Encore", "hooktheory": "Hooktheory",
        "st500": "MIR-ST500", "midi": "BitMidi", "detected": "Detected from the vocal"}

HOP = 0.01          # the pipeline's contour hop
COARSE = 0.05       # hop for the global search


class Unavailable(Exception):
    pass


# --------------------------------------------------------------------------
# HTTP + cache
# --------------------------------------------------------------------------

_session = None


def http() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers["User-Agent"] = UA
    return _session


def _cached(name: str, url: str, max_age: float = INDEX_MAX_AGE, timeout: float = 60) -> Path:
    """Download url to the cache once (refreshed after max_age); returns the path."""
    p = CACHE / name
    if p.exists() and time.time() - p.stat().st_mtime < max_age:
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = http().get(url, timeout=timeout)
        r.raise_for_status()
        tmp = p.with_suffix(p.suffix + ".part")
        tmp.write_bytes(r.content)
        tmp.replace(p)
    except requests.RequestException:
        if p.exists():      # stale copy beats nothing
            log.warning("couldn't refresh %s; using the old copy", name)
            return p
        raise
    return p


# --------------------------------------------------------------------------
# names
# --------------------------------------------------------------------------

def _norm(s: str) -> str:
    from .lyrics import _norm as n
    return n(s)


def _sim(a: str, b: str) -> float:
    from .lyrics import _sim as s
    return s(a, b)


def name_score(artist: str, track: str, hyps: list[tuple[str, str]]) -> float:
    best = 0.0
    for a, t in hyps:
        ts = _sim(track, t)
        best = max(best, 0.6 * ts + 0.4 * _sim(artist, a) if a else 0.6 * ts + 0.1)
    return best


def video_id(url: str | None) -> str | None:
    if not url:
        return None
    m = re.search(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})", url)
    if m:
        return m.group(1)
    return url if re.fullmatch(r"[A-Za-z0-9_-]{11}", url or "") else None


# --------------------------------------------------------------------------
# formats
# --------------------------------------------------------------------------

def parse_ultrastar(txt: str) -> tuple[dict, list[dict]]:
    """UltraStar txt -> (header, notes). Times in seconds of the song's audio; pitch 0 = C4
    (MIDI 60), though many charts are an octave off, which the alignment sorts out.
    Freestyle and rap notes (F, R) have no pitch and are left out. Duets: the first singer."""
    head: dict[str, str] = {}
    notes: list[dict] = []
    bpm = gap = None
    relative = False
    base = 0
    player = None
    phrase = 0
    last_start = 0
    track = 0        # AllKaraoke writes duets as two runs of notes with no P1/P2 lines
    for raw in txt.splitlines():
        line = raw.rstrip("\r\n")
        if not line.strip():
            continue
        if line.startswith("#"):
            k, _, v = line[1:].partition(":")
            head[k.strip().upper()] = v.strip()
            continue
        if bpm is None:
            try:
                bpm = float(head.get("BPM", "0").replace(",", "."))
                gap = float(head.get("GAP", "0").replace(",", ".") or 0)
            except ValueError:
                raise ValueError("bad BPM/GAP") from None
            relative = head.get("RELATIVE", "").lower() in ("yes", "true", "1")
            if bpm <= 0:
                raise ValueError("no BPM")
        if line[0] == "E":
            break
        if line[0] == "P":
            player = line[1:].strip()
            continue
        if player not in (None, "1", "3"):    # 3 = both singers
            continue
        beat = 60.0 / (bpm * 4)
        parts = line.split(" ")
        if player is None and line[0] in ":*FRG-" and len(parts) > 1:
            try:
                st0 = int((parts[1] if line[0] != "-" else line[1:].split()[0]))
            except (ValueError, IndexError):
                st0 = None
            if st0 is not None and not relative and last_start > 200 and st0 < last_start * 0.75:
                track += 1
            if st0 is not None:
                last_start = st0 if track == 0 else last_start
        if track > 0:
            continue
        if line[0] == "-":
            phrase += 1
            if relative:
                nums = [int(x) for x in line[1:].split() if x.lstrip("-").isdigit()]
                base += nums[-1] if nums else 0
            continue
        if line[0] not in ":*FRG" or len(parts) < 4:
            continue
        try:
            st, ln, pitch = int(parts[1]), int(parts[2]), int(parts[3])
        except ValueError:
            continue
        if line[0] in "FR" or ln <= 0:
            continue
        t0 = gap / 1000 + (base + st) * beat
        notes.append({"t0": t0, "t1": t0 + ln * beat, "midi": pitch + 60, "syl": " ".join(parts[4:]) if len(parts) > 4 else "",
                      "ph": phrase, "gold": line[0] in "*G"})
    if bpm is None:
        raise ValueError("no notes")
    return head, notes


def ultrastar_video(head: dict) -> tuple[str | None, float]:
    """(YouTube id, video gap seconds) from the header: #VIDEO:v=...,co=... (USDB style),
    #VIDEOURL / #AUDIOURL, or AllKaraoke's own tags."""
    vid = head.get("ALLKARAOKE_VIDEOID") or head.get("VIDEOID")
    if not vid:
        for k in ("AUDIOURL", "VIDEOURL"):
            vid = vid or video_id(head.get(k))
    if not vid and head.get("VIDEO"):
        m = re.search(r"(?:^|,)\s*v=([A-Za-z0-9_-]{11})", head["VIDEO"])
        vid = m.group(1) if m else video_id(head["VIDEO"])
    try:
        vgap = float((head.get("VIDEOGAP") or "0").replace(",", "."))
    except ValueError:
        vgap = 0.0
    return vid, vgap


def _midi_tempo_map(mid) -> list[tuple[int, float]]:
    """[(tick, seconds-per-tick from there on)] from every track's set_tempo events."""
    changes = []
    for tr in mid.tracks:
        t = 0
        for m in tr:
            t += m.time
            if m.type == "set_tempo":
                changes.append((t, m.tempo))
    changes.sort()
    out = [(0, 500000 / 1e6 / mid.ticks_per_beat)]
    for t, tempo in changes:
        if t == out[-1][0]:
            out[-1] = (t, tempo / 1e6 / mid.ticks_per_beat)
        else:
            out.append((t, tempo / 1e6 / mid.ticks_per_beat))
    return out


def _tick_seconds(tmap):
    ticks = np.array([t for t, _ in tmap], dtype=float)
    spt = np.array([s for _, s in tmap])
    secs = np.concatenate([[0.0], np.cumsum(np.diff(ticks) * spt[:-1])])

    def f(tick):
        i = np.searchsorted(ticks, tick, side="right") - 1
        return secs[i] + (tick - ticks[i]) * spt[i]
    return f


def midi_track_notes(mid, tr, lo=36, hi=84) -> list[dict]:
    """Note on/off pairs of one track in seconds (first voice only if notes overlap)."""
    sec = _tick_seconds(_midi_tempo_map(mid))
    t, on, notes, lyrics = 0, {}, [], []
    for m in tr:
        t += m.time
        if m.type in ("lyrics", "text") and not str(getattr(m, "text", "")).startswith("["):
            lyrics.append((t, m.text))
        if m.type == "note_on" and m.velocity > 0 and lo <= m.note <= hi:
            on[m.note] = t
        elif (m.type == "note_off" or (m.type == "note_on" and m.velocity == 0)) and m.note in on:
            a = on.pop(m.note)
            if t > a:
                notes.append([a, t, m.note])
    notes.sort()
    lyr = dict(lyrics)
    out = []
    for a, b, p in notes:
        if out and sec(a) < out[-1]["t1"] - 0.02:      # chords / overlaps: keep the earlier note
            continue
        out.append({"t0": float(sec(a)), "t1": float(sec(b)), "midi": int(p), "syl": str(lyr.get(a, "")).strip()})
    return out


def parse_rb_vocals(data: bytes) -> list[dict]:
    """PART VOCALS (or HARM1) from a Rock Band / Clone Hero notes.mid. Pitched notes are 36-84;
    lyrics ending in # or ^ are spoken (no pitch) and dropped; '+' continues the last syllable."""
    import io
    import mido
    mid = mido.MidiFile(file=io.BytesIO(data))
    by = {(tr.name or "").strip().upper(): tr for tr in mid.tracks}
    tr = by.get("PART VOCALS") or by.get("HARM1") or by.get("PART HARM1")
    if tr is None:
        raise Unavailable("no vocals track")
    notes = midi_track_notes(mid, tr, 36, 84)
    keep = []
    for n in notes:
        s = n["syl"]
        if s.endswith(("#", "^")) or s.endswith(("#$", "^$")):
            continue
        n["syl"] = "" if s == "+" else s.rstrip("$-=").replace("=", "-")
        keep.append(n)
    return keep


def read_sng(url: str, want: str = "notes.mid", timeout: float = 30) -> bytes:
    """One file out of a .sng package (Clone Hero's container) using HTTP range requests,
    without downloading the audio. Format: github.com/mdsitton/SngFileFormat."""
    s = http()
    r = s.get(url, headers={"Range": "bytes=0-65535"}, timeout=timeout)
    if r.status_code not in (200, 206):
        raise Unavailable(f"chart download {r.status_code}")
    b = r.content
    if b[:6] != b"SNGPKG":
        raise Unavailable("not a .sng file")
    mask = np.frombuffer(b[10:26], np.uint8)
    p = 26
    mlen, = struct.unpack_from("<Q", b, p)
    p += 8 + mlen
    flen, fcount = struct.unpack_from("<QQ", b, p)
    if p + 8 + flen > len(b):
        raise Unavailable("chart header too big")
    p += 16
    files = {}
    for _ in range(fcount):
        nl = b[p]
        p += 1
        name = b[p:p + nl].decode("utf-8", "replace")
        p += nl
        ln, idx = struct.unpack_from("<QQ", b, p)
        p += 16
        files[name.lower()] = (ln, idx)
    if want not in files:
        raise Unavailable(f"no {want} in chart")
    ln, idx = files[want]
    if ln > 8_000_000:
        raise Unavailable("notes file too big")
    r = s.get(url, headers={"Range": f"bytes={idx}-{idx + ln - 1}"}, timeout=timeout)
    if r.status_code != 206 or len(r.content) != ln:
        raise Unavailable("range request refused")
    x = np.frombuffer(r.content, np.uint8)
    i = np.arange(ln)
    return (x ^ mask[i % 16] ^ (i & 0xFF).astype(np.uint8)).tobytes()


# --------------------------------------------------------------------------
# sources: each returns candidates {source, id, title, by, url, notes, video, hint, kind}
#   kind "synced": timed to some recording (offset unknown unless the video matches)
#   kind "free":   own tempo (MIDI), needs tempo search
#   hint: offset (song time = chart time + hint) when the chart was timed to this same video
# --------------------------------------------------------------------------

def _ak_index() -> list[dict]:
    return json.loads(_cached("allkaraoke_index.json", f"{ALLKARAOKE}/songs/index.json").read_text())


def src_allkaraoke(q: dict) -> list[dict]:
    idx = _ak_index()
    picks = [s for s in idx if q["video"] and s.get("video") == q["video"]]
    if not picks:
        scored = sorted(((name_score(s.get("artist", ""), s.get("title", ""), q["hyps"]), s) for s in idx),
                        key=lambda x: -x[0])
        picks = [s for sc, s in scored[:3] if sc >= 0.78]
    out = []
    for s in picks[:3]:
        r = http().get(f"{ALLKARAOKE}/songs/{urllib.parse.quote(s['id'])}.txt", timeout=20)
        if r.status_code != 200:
            continue
        head, notes = parse_ultrastar(r.text)
        vid, vgap = ultrastar_video(head)
        vid = vid or s.get("video")
        out.append({"source": "allkaraoke", "id": s["id"], "title": f"{s.get('artist')} – {s.get('title')}",
                    "by": head.get("CREATOR") or s.get("author") or "", "url": f"https://allkaraoke.party/game/{s['id']}",
                    "notes": notes, "video": vid, "hint": vgap if vid == q["video"] else None, "kind": "synced"})
    return out


_usdb_logged = False
USDB = "https://usdb.animux.de/"
_USDB_ROW = re.compile(r'<tr class="list_tr\d"\s+data-songid="(\d+)"(.*?)</tr>', re.S)
_TD = re.compile(r"<td[^>]*>(.*?)</td>", re.S)


def usdb_rows(html: str) -> list[tuple[str, str, str]]:
    """(song id, artist, title) from a USDB song list page: the title cell is the one with
    the link, the artist the cell before it."""
    import html as H
    out = []
    for sid, row in _USDB_ROW.findall(html):
        cells = _TD.findall(row)
        i = next((k for k, c in enumerate(cells) if "<a " in c), None)
        if i is None or i == 0:
            continue
        artist, title = (H.unescape(re.sub("<[^>]+>", "", x)).strip() for x in (cells[i - 1], cells[i]))
        out.append((sid, artist, title))
    return out


def _usdb_login():
    global _usdb_logged
    if _usdb_logged:
        return
    if not (USDB_USER and USDB_PASSWORD):
        raise Unavailable("no USDB_USER / USDB_PASSWORD set")
    r = http().post(USDB, data={"user": USDB_USER, "pass": USDB_PASSWORD, "login": "Login"}, timeout=20)
    r.raise_for_status()
    if "Login or Password invalid" in r.text or "Login oder Passwort" in r.text or 'name="pass"' in r.text:
        raise Unavailable("USDB login refused")
    _usdb_logged = True


def src_usdb(q: dict) -> list[dict]:
    _usdb_login()
    rows = {}
    for a, t in q["hyps"][:2]:
        r = http().post(USDB + "index.php", params={"link": "list"},
                        data={"interpret": a, "title": t, "order": "rating", "ud": "desc", "limit": "30", "details": "1",
                              "start": "0"}, timeout=20)
        r.raise_for_status()
        if "Login to use this function" in r.text:
            global _usdb_logged
            _usdb_logged = False
            raise Unavailable("USDB session expired")
        for sid, artist, title in usdb_rows(r.text):
            rows[sid] = (artist, title)
    scored = sorted(((name_score(a, t, q["hyps"]), sid, a, t) for sid, (a, t) in rows.items()), reverse=True)
    out = []
    for sc, sid, a, t in scored[:3]:
        if sc < 0.78:
            break
        r = http().post(USDB, params={"link": "gettxt", "id": sid}, data={"wd": "1"}, timeout=20)
        m = re.search(r"<textarea[^>]*>(.*?)</textarea>", r.text, re.S)
        if not m:
            continue
        import html as H2
        head, notes = parse_ultrastar(H2.unescape(m.group(1)))
        vid, vgap = ultrastar_video(head)
        out.append({"source": "usdb", "id": sid, "title": f"{a} – {t}", "by": head.get("CREATOR", ""),
                    "url": f"{USDB}?link=detail&id={sid}", "notes": notes, "video": vid,
                    "hint": vgap if vid and vid == q["video"] else None, "kind": "synced"})
    return out


def src_encore(q: dict) -> list[dict]:
    seen, rows = set(), []
    for a, t in q["hyps"][:2]:
        r = http().post("https://api.enchor.us/search", json={
            "search": f"{a} {t}".strip(), "page": 1, "instrument": None, "difficulty": None, "drumType": None,
            "drumsReviewed": False, "source": "website"}, timeout=20)
        r.raise_for_status()
        for s in r.json().get("data") or []:
            if s.get("md5") in seen or not (s.get("notesData") or {}).get("hasVocals"):
                continue
            seen.add(s.get("md5"))
            rows.append((name_score(s.get("artist") or "", s.get("name") or "", q["hyps"]), s))
    rows.sort(key=lambda x: (-x[0], -(x[1].get("diff_vocals") or -1)))
    out = []
    for sc, s in rows[:3]:
        if sc < 0.78:
            break
        enc = int(s.get("encoderVersion") or 0)
        url = (f"https://files.enchor.us/{'' if enc == 0 else f'charts/v{enc}/'}{s['md5']}"
               f"{'_novideo' if s.get('hasVideoBackground') else ''}.sng")
        try:
            notes = parse_rb_vocals(read_sng(url))
        except (Unavailable, OSError, ValueError, EOFError) as e:
            log.info("encore %s: %s", s.get("md5"), e)
            continue
        out.append({"source": "encore", "id": s["md5"], "title": f"{s.get('artist')} – {s.get('name')}",
                    "by": s.get("charter") or "", "url": f"https://www.enchor.us/?search={urllib.parse.quote(s.get('name') or '')}",
                    "notes": notes, "video": None, "hint": None, "kind": "synced"})
    return out


def _ht_dir() -> Path:
    """Hooktheory.json.gz split into one small file per YouTube video plus a name index,
    so a lookup doesn't hold 26,000 sections in memory."""
    d = CACHE / "hooktheory"
    if (d / "names.json").exists():
        return d
    src = _cached("Hooktheory.json.gz", HOOKTHEORY_URL, max_age=10 ** 10, timeout=180)
    data = json.load(gzip.open(src))
    d.mkdir(parents=True, exist_ok=True)
    by_vid: dict[str, list] = {}
    names: dict[str, list] = {}
    for key, v in data.items():
        tags = set(v.get("tags") or [])
        yt = (v.get("youtube") or {}).get("id")
        al = (v.get("alignment") or {}).get("refined") or (v.get("alignment") or {}).get("user")
        mel = (v.get("annotations") or {}).get("melody")
        if not (yt and al and mel) or "MELODY" not in tags or "TEMPO_CHANGES" in tags:
            continue
        h = v.get("hooktheory") or {}
        by_vid.setdefault(yt, []).append({"key": key, "artist": h.get("artist", ""), "song": h.get("song", ""),
                                          "url": (h.get("urls") or {}).get("song"), "beats": al["beats"],
                                          "times": al["times"],
                                          "mel": [[n["onset"], n["offset"], n["pitch_class"], n["octave"]] for n in mel]})
        names.setdefault(f"{h.get('artist', '')}|{h.get('song', '')}", []).append(yt)
    for yt, secs in by_vid.items():
        (d / f"{yt}.json").write_text(json.dumps(secs))
    (d / "names.json").write_text(json.dumps(names))
    return d


def src_hooktheory(q: dict) -> list[dict]:
    d = _ht_dir()
    vids = []
    if q["video"] and (d / f"{q['video']}.json").exists():
        vids = [q["video"]]
    else:
        names = json.loads((d / "names.json").read_text())
        scored = sorted(((name_score(k.split("|")[0].replace("-", " "), k.split("|")[1].replace("-", " "), q["hyps"]), v)
                         for k, v in names.items()), key=lambda x: -x[0])
        for sc, v in scored[:2]:
            if sc >= 0.82:
                vids += [x for x in v if x not in vids]
    out = []
    for yt in vids[:2]:
        secs = json.loads((d / f"{yt}.json").read_text())
        notes = []
        for ph, s in enumerate(secs):
            b, t = np.array(s["beats"], float), np.array(s["times"], float)
            if len(b) < 2:
                continue
            spb = (t[-1] - t[0]) / (b[-1] - b[0])

            def at(x):
                return float(np.interp(x, b, t)) if b[0] <= x <= b[-1] else float(t[0] + (x - b[0]) * spb) if x < b[0] else float(t[-1] + (x - b[-1]) * spb)
            for on, off, pc, octv in s["mel"]:
                notes.append({"t0": at(on), "t1": at(off), "midi": 60 + pc + 12 * octv, "syl": "", "ph": ph})
        notes.sort(key=lambda n: n["t0"])
        a0 = secs[0]
        out.append({"source": "hooktheory", "id": yt, "title": f"{a0['artist'].replace('-', ' ').title()} – {a0['song'].replace('-', ' ').title()}",
                    "by": "TheoryTab contributors", "url": a0.get("url") or "", "notes": notes, "video": yt,
                    "hint": 0.0 if yt == q["video"] else None, "kind": "synced", "partial": True})
    return out


def src_st500(q: dict) -> list[dict]:
    if not q["video"]:
        return []
    links = json.loads(_cached("st500_links.json", f"{ST500_BASE}/MIR-ST500_link.json", max_age=10 ** 10).read_text())
    num = next((k for k, u in links.items() if video_id(u) == q["video"]), None)
    if not num:
        return []
    allnotes = json.loads(_cached("st500_notes.json", f"{ST500_BASE}/MIR-ST500_corrected.json", max_age=10 ** 10).read_text())
    notes = [{"t0": a, "t1": b, "midi": int(round(p)), "syl": ""} for a, b, p in allnotes.get(num) or []]
    return [{"source": "st500", "id": num, "title": f"MIR-ST500 song {num}", "by": "MIR-ST500 annotators",
             "url": "https://github.com/york135/singing_transcription_ICASSP2021", "notes": notes, "video": q["video"],
             "hint": 0.0, "kind": "synced"}] if notes else []


_VOX_TRACK = re.compile(r"vocal|voice|vox|melod|lead|sing|lyric|stimme|gesang|chant|voz", re.I)


def src_midi(q: dict) -> list[dict]:
    import io
    import mido
    rows, seen = [], set()
    for a, t in q["hyps"][:2]:
        r = http().get("https://bitmidi.com/api/midi/search", params={"q": f"{a} {t}".strip(), "page": 0, "pageSize": 8},
                       timeout=20)
        r.raise_for_status()
        for m in (r.json().get("result") or {}).get("results") or []:
            if m["id"] in seen:
                continue
            seen.add(m["id"])
            nm = re.sub(r"(\.mid|\.kar)$", "", m["name"], flags=re.I).replace("-", " ").replace("_", " ")
            nm = re.sub(r"\s\d+$", "", nm)
            sc = max(_sim(nm, t) for _, t in q["hyps"][:2]) if q["hyps"] else 0
            sc = max(sc, max((_sim(nm, f"{a} {t}") for a, t in q["hyps"][:2]), default=0))
            rows.append((sc, m))
    rows.sort(key=lambda x: -x[0])
    out = []
    for sc, m in rows[:2]:
        if sc < 0.8:
            break
        r = http().get("https://bitmidi.com" + m["downloadUrl"], timeout=20)
        if r.status_code != 200 or len(r.content) > 2_000_000:
            continue
        try:
            mid = mido.MidiFile(file=io.BytesIO(r.content))
        except Exception:  # noqa: BLE001 - broken uploads are common
            continue
        tracks = []
        for ti, tr in enumerate(mid.tracks):
            chans = {x.channel for x in tr if x.type == "note_on"}
            if not chans or chans == {9}:
                continue
            has_lyr = sum(1 for x in tr if x.type == "lyrics") > 20
            notes = midi_track_notes(mid, tr, 40, 88)
            if len(notes) < 40:
                continue
            named = bool(_VOX_TRACK.search(tr.name or ""))
            tracks.append((2 * has_lyr + named, len(notes), ti, tr.name, notes))
        tracks.sort(key=lambda x: (-x[0], -x[1]))
        for pri, _, ti, tname, notes in tracks[:2 if tracks and tracks[0][0] else 3]:
            out.append({"source": "midi", "id": f"{m['id']}-{ti}", "title": f"{m['name']} · {(tname or '').strip() or f'track {ti}'}",
                        "by": "BitMidi upload", "url": "https://bitmidi.com" + m["url"], "notes": notes, "video": None,
                        "hint": None, "kind": "free"})
    return out


FETCH = {"allkaraoke": src_allkaraoke, "usdb": src_usdb, "encore": src_encore, "hooktheory": src_hooktheory,
         "st500": src_st500, "midi": src_midi}


# --------------------------------------------------------------------------
# alignment
# --------------------------------------------------------------------------

def _roll(notes, hop, n, t_shift=0.0, scale=1.0, shrink=0.0):
    """Frame-wise chart pitch (nan where no note). shrink trims note edges, where singers
    and charts disagree most."""
    r = np.full(n, np.nan)
    for nt in notes:
        a = int(np.ceil((nt["t0"] * scale + t_shift + shrink) / hop))
        b = int(np.floor((nt["t1"] * scale + t_shift - shrink) / hop))
        a, b = max(a, 0), min(b, n - 1)
        if b >= a:
            r[a:b + 1] = nt["midi"]
    return r


def _coarse_ref(ref: np.ndarray, k: int) -> np.ndarray:
    m = len(ref) // k
    x = ref[: m * k].reshape(m, k)
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out = np.nanmedian(x, axis=1)
    out[np.sum(~np.isnan(x), axis=1) < k // 2 + 1] = np.nan
    return out


def _global(ref_c, notes, offsets, scales):
    """Best (score, offset, scale, key shift mod 12) over the grid, comparing pitch classes."""
    span = max(n["t1"] for n in notes)
    best = []
    nref = len(ref_c)
    for s in scales:
        n_c = int((span * s) / COARSE) + 2
        roll = _roll(notes, COARSE, n_c, scale=s)
        cv = ~np.isnan(roll)
        total = int(cv.sum())
        if total < 20:
            continue
        idx = np.nonzero(cv)[0]
        pr = roll[idx]
        for o in offsets:
            sh = int(round(o / COARSE))
            j = idx + sh
            ok = (j >= 0) & (j < nref)
            if ok.sum() < 20:
                continue
            rv = ref_c[j[ok]]
            m = ~np.isnan(rv)
            if m.sum() < 10:
                continue
            d = np.round(rv[m] - pr[ok][m]).astype(int) % 12
            cnt = np.bincount(d, minlength=12)
            k = int(cnt.argmax())
            # matched chart time over all chart time, so a shift that leaves notes on silence loses
            best.append((cnt[k] / total, o, s, k))
    best.sort(key=lambda x: -x[0])
    return best


def _match(ref, roll, tol=0.75):
    both = ~np.isnan(ref) & ~np.isnan(roll)
    ok = both & (np.abs(ref - roll) <= tol)
    return ok, both


def metrics(ref: np.ndarray, notes: list[dict], hop=HOP) -> dict:
    """How well notes (in song time) sit on the pitch line.
    precision: of chart time where the singer is singing, the share within 3/4 semitone
    on_voice:  of chart time, the share where the singer is singing at all
    coverage:  of the singer's time, the share inside a matching note"""
    roll = _roll(notes, hop, len(ref), shrink=0.03)
    ok, both = _match(ref, roll)
    chart = int((~np.isnan(roll)).sum())
    voiced = int((~np.isnan(ref)).sum())
    return {"precision": round(ok.sum() / max(1, both.sum()), 3), "on_voice": round(both.sum() / max(1, chart), 3),
            "coverage": round(ok.sum() / max(1, voiced), 3), "seconds": round(chart * hop, 1)}


def _phrases(notes, gap=0.35):
    groups, cur = [], []
    for i, n in enumerate(notes):
        if cur and (n["t0"] - notes[cur[-1]]["t1"] > gap or ("ph" in n and n["ph"] != notes[cur[-1]].get("ph"))):
            groups.append(cur)
            cur = []
        cur.append(i)
    if cur:
        groups.append(cur)
    return groups


def align(ref: np.ndarray, notes: list[dict], duration: float, kind="synced", hint=None) -> dict | None:
    """Fit chart notes (chart time) to the pitch line ref (song time, the song's tuning removed).
    Returns {notes (song time), offset, scale, shift, metrics} or None."""
    notes = sorted((dict(n) for n in notes if n["t1"] > n["t0"]), key=lambda n: n["t0"])
    if len(notes) < 8:
        return None
    ref_c = _coarse_ref(ref, int(round(COARSE / HOP)))
    t_first = notes[0]["t0"]
    if hint is not None:
        # timed to this very video: only a small slip, no tempo change
        offsets = np.unique(np.round(np.concatenate([np.arange(hint - 4, hint + 4.001, COARSE),
                                                     np.arange(-4, 4.001, COARSE)]) / COARSE) * COARSE)
        res = _global(ref_c, notes, offsets, [1.0])
    else:
        # another recording (or a MIDI file): unknown offset and tempo. Music videos often run
        # a percent or two off the album; MIDI files can be anything.
        lo, hi = -t_first - 5, duration - t_first + 5
        offsets = np.arange(max(lo, -900), min(hi, 900), COARSE)
        if kind == "free":
            scales = list(np.round(np.arange(0.85, 1.1501, 0.0075), 4))
        else:
            scales = list(np.round(np.arange(0.97, 1.0301, 0.0075), 4))
        rough = _global(ref_c, notes, offsets[::4], scales)
        cand_s = sorted({s for _, _, s, _ in rough[:6]})
        fine_s = sorted({round(s + d, 4) for s in cand_s for d in (-0.005, -0.0025, 0, 0.0025, 0.005)})
        res = []
        for sc, o, s, k in rough[:6]:
            res += _global(ref_c, notes, np.arange(o - 0.4, o + 0.401, COARSE), fine_s)
        res.sort(key=lambda x: -x[0])
    if not res:
        return None
    best = None
    tried = []
    for sc, o, s, k in res:
        if any(abs(o - p) < 1.0 and abs(s - q) < 0.01 for p, q in tried):
            continue
        tried.append((o, s))
        if len(tried) > 4:
            break
        r = _refine(ref, notes, o, s, k, duration, kind if hint is None else "same")
        if r and (best is None or r["fit"] > best["fit"]):
            best = r
    return best


def _refine(ref, notes, o, s, k, duration, kind):
    n = len(ref)
    # octave: the whole-chart shift T = k + 12m that puts most notes on the line
    roll = _roll(notes, HOP, n, t_shift=o, scale=s)
    both = ~np.isnan(ref) & ~np.isnan(roll)
    if both.sum() < 50:
        return None
    d = ref[both] - roll[both]
    T = k + 12 * int(np.round(np.median((d - k) / 12)))
    # each phrase: nudge in time (and octave, when the chart has one phrase in the wrong octave)
    win = {"same": 0.35, "synced": 0.6}.get(kind, 1.2)
    out = []
    cur = o
    for g in _phrases(notes):
        ph = [notes[i] for i in g]
        a = min(x["t0"] for x in ph) * s + cur - win - 0.1
        b = max(x["t1"] for x in ph) * s + cur + win + 0.1
        ia, ib = max(0, int(a / HOP)), min(n, int(b / HOP) + 1)
        if ib - ia < 20:
            continue        # phrase falls outside the song
        seg = ref[ia:ib]
        bestv, bestd, bestT = -1, 0.0, T
        base = None
        for dlt in np.arange(-win, win + 1e-9, 0.02):
            r = _roll(ph, HOP, ib - ia, t_shift=cur + dlt - ia * HOP, scale=s, shrink=0.03)
            for TT in (T, T - 12, T + 12):
                ok, bb = _match(seg, r + TT)
                v = ok.sum() - (0.0 if TT == T else 0.15 * (~np.isnan(r)).sum())   # octave jumps need clear evidence
                if abs(dlt) < 1e-9 and TT == T:
                    base = v
                if v > bestv:
                    bestv, bestd, bestT = v, dlt, TT
        frames = (~np.isnan(_roll(ph, HOP, ib - ia, t_shift=cur - ia * HOP, scale=s))).sum()
        if base is None or frames < 10 or bestv < 0.3 * frames or bestv <= base + 0.05 * frames:
            dlt, TT = 0.0, T     # not enough evidence to move it
        else:
            dlt, TT = bestd, bestT
        for x in ph:
            out.append({**x, "t0": x["t0"] * s + cur + dlt, "t1": x["t1"] * s + cur + dlt, "midi": int(x["midi"] + TT)})
        if kind != "same" and dlt:
            cur += dlt          # another recording drifts: carry the correction on to the next phrase
    out = [x for x in out if x["t1"] > 0 and x["t0"] < duration]
    out.sort(key=lambda x: x["t0"])
    clean = []
    for x in out:
        x["t0"], x["t1"] = max(0.0, x["t0"]), min(duration, x["t1"])
        if clean and x["t0"] < clean[-1]["t1"]:
            clean[-1]["t1"] = x["t0"]
            if clean[-1]["t1"] - clean[-1]["t0"] < 0.04:
                clean.pop()
        if x["t1"] - x["t0"] >= 0.04:
            clean.append(x)
    met = metrics(ref, clean)
    fit = met["precision"] * met["on_voice"]
    return {"notes": clean, "offset": round(float(o), 3), "scale": float(s), "shift": int(T), "metrics": met, "fit": fit}


# --------------------------------------------------------------------------
# lookup
# --------------------------------------------------------------------------

def verdict(m: dict, partial: bool, kind: str) -> str:
    """use = replace the detected notes; merge = use where the chart has notes; no."""
    p, v, c = m["precision"], m["on_voice"], m["coverage"]
    strict = kind == "free"
    if not partial and p >= (0.75 if strict else 0.65) and v >= (0.65 if strict else 0.55) and c >= 0.45:
        return "use"
    if p >= (0.8 if strict else 0.7) and v >= 0.6 and m["seconds"] >= 8:
        return "merge"
    return "no"


def lookup(query: dict, ref: np.ndarray, duration: float, sources=None, budget_s: float = 120) -> dict:
    """query: {video, hyps: [(artist, track)], title}. ref: pitch line in semitones with the
    song's tuning removed. Returns {"candidates": [...] best first, "errors": {...}}."""
    t_start = time.time()
    cands, errors, seen = [], {}, set()
    for name in sources or SOURCES:
        if name not in FETCH:
            continue
        if time.time() - t_start > budget_s:
            errors[name] = "skipped: out of time"
            continue
        try:
            got = FETCH[name](query)
        except Unavailable as e:
            errors[name] = str(e)
            continue
        except Exception as e:  # noqa: BLE001 - one source failing mustn't stop the others
            log.info("note source %s failed: %s", name, e, exc_info=True)
            errors[name] = f"{e.__class__.__name__}: {e}"[:200]
            continue
        for c in got:
            hint = c.get("hint")
            if hint is not None:
                hint -= float(query.get("clip0") or 0)     # songbook picks are cut from the video
            try:
                a = align(ref, c["notes"], duration, c["kind"], hint)
            except Exception:  # noqa: BLE001
                log.exception("aligning %s %s failed", c["source"], c["id"])
                a = None
            item = {k: c[k] for k in ("source", "id", "title", "by", "url", "kind")}
            item["partial"] = bool(c.get("partial"))
            item["same_video"] = bool(query.get("video") and c.get("video") == query["video"])
            if a is None:
                item.update(verdict="no", metrics=None, notes=[])
            else:
                if item["partial"]:
                    a["notes"] = keep_good_sections(ref, a["notes"])
                    a["metrics"] = metrics(ref, a["notes"]) if a["notes"] else {"precision": 0, "on_voice": 0, "coverage": 0, "seconds": 0}
                sig = (c["source"], len(a["notes"]), round(a["offset"], 1), a["metrics"]["precision"])
                if sig in seen:
                    continue        # the same chart reached twice (Hooktheory has a song under two videos)
                seen.add(sig)
                item.update(offset=a["offset"], scale=a["scale"], shift=a["shift"], metrics=a["metrics"],
                            verdict=verdict(a["metrics"], item["partial"], c["kind"]),
                            notes=[{"t0": round(x["t0"], 3), "t1": round(x["t1"], 3), "midi": x["midi"],
                                    **({"syl": x["syl"]} if x.get("syl") else {})} for x in a["notes"]])
            cands.append(item)
    order = {"use": 0, "merge": 1, "no": 2}

    def rank(c):
        m = c["metrics"] or {}
        trust = 0.85 if c["kind"] == "free" else 1.0      # MIDI files are rarely the sung melody exactly
        return (order[c["verdict"]], -(m.get("precision", 0) * m.get("on_voice", 0) * (0.5 + m.get("coverage", 0)) * trust))
    cands.sort(key=rank)
    return {"candidates": cands, "errors": errors, "took": round(time.time() - t_start, 1), "at": int(time.time())}


def keep_good_sections(ref, notes, min_p=0.7, min_v=0.6):
    """For sources that chart sections (Hooktheory): keep the sections that sit on the vocal.
    Their melody can be an instrumental hook; that part won't match the singer and goes."""
    groups: dict = {}
    for x in notes:
        groups.setdefault(x.get("ph", 0), []).append(x)
    out = []
    for g in groups.values():
        m = metrics(ref, g)
        if m["precision"] >= min_p and m["on_voice"] >= min_v and m["seconds"] >= 2:
            out += g
    return sorted(out, key=lambda x: x["t0"])


def merge_into(detected: list[dict], chart: list[dict], pad=0.25) -> list[dict]:
    """Chart notes where the chart has phrases; detected notes elsewhere."""
    spans = []
    for g in _phrases(chart, gap=1.0):
        a, b = chart[g[0]]["t0"] - pad, max(chart[i]["t1"] for i in g) + pad
        spans.append((a, b))
    keep = [n for n in detected if not any(n["t1"] > a and n["t0"] < b for a, b in spans)]
    out = sorted(keep + [{k: n[k] for k in ("t0", "t1", "midi")} for n in chart], key=lambda n: n["t0"])
    return out
