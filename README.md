# Vocal Lab

A self-hosted singing trainer modelled on vocalify.me, with one big addition: paste a YouTube link and it becomes a sing-along exercise. The server splits the vocals from the music, works out the melody, and the browser grades your pitch against it in real time.

## What it does

- **Lessons.** A 47-lesson course in 8 units for total beginners: posture and breath, matching pitch, clean starts and steady notes, moving between notes, crossing the break, tone and tension, learning songs, then harmony and agility. Each lesson has a short why, on-screen cues, a scored exercise pitched to your range, and one targeted tip when you miss (flat, sharp, late starts, wobble, drooping ends). The next lesson unlocks at 70%. A placement check can start experienced singers at Unit 4 or 7, a 3-minute daily warm-up opens each session, and the app suggests a rest day when your scores dip or you've sung a lot. Lesson text and pass marks live in `app/static/lessons.js`.

- **Songs from YouTube or files.** yt-dlp downloads the audio, Demucs (`htdemucs`) splits vocals from accompaniment, UVR-MDX-NET Karaoke 2 separates the lead singer from backing vocals (which go back into the music), SwiftF0 tracks the lead vocal's pitch, and GAME (OpenVPI's singing-to-notes model) splits the melody into notes, one per sung syllable. GAME notes the pitch line doesn't back up (screams, harsh consonants, noise) are dropped. The recording's tuning is measured, so songs that aren't at A440 still grade fairly.
- **Live pitch feedback.** Your voice is drawn over the target notes, 100 times a second, coloured green / amber / red by how many cents you're off. The HUD says "aim higher" or "aim lower". A mic filter (Settings: Off / Light / Normal / Strong) keeps breaths, clicks, mic bumps and voiced exhales off the line: a sound has to be clearly pitched, louder than the room, not far quieter than your singing, and last long enough to be a sung note. It draws about 60 ms behind your voice to make that call; scoring isn't affected because every frame keeps its own timestamp.
- **Backing vocals: split or not** (Settings → New songs). Off by default: songs are split into vocals and music only, and the guide vocal is every voice. On: Karaoke 2 also pulls the backing vocals onto their own slider. "Redo them" brings existing songs into line (putting the backing back takes about a minute a song; splitting again needs the original audio).
- **Editor for the computer's mistakes** (song page → "Fix them in the editor"). Wrong notes: tap one and drag it up, down or sideways, drag its ends, split, join, delete, double-tap to add, snap a note or a whole stretch to the pitch line, or move a stretch an octave. Lead/backing mix-ups: drag along the time strip to pick a stretch and say what it really is (lead and backing swapped, all lead, or all backing). A lane under the notes shows the lead singer and the backing vocals on one scale, so a swapped stretch stands out. The server rebuilds the guide vocal, backing vocals and music from the untouched split and finds the melody again in that stretch (about a minute). Note edits save as you go with undo; fixes can be removed one by one; "Reset all notes" goes back to the detected notes. Re-analysing a song later keeps both.
- **Practice controls.** Pick a section (or set it from the playhead), loop it, mix the accompaniment and guide vocal, and drag the track to move around.
- **Sing it your way.** Each song has a part picker and key controls, remembered per song:
  - **Part:** the melody, or a harmony line a third above, or a third, fifth or sixth below. Harmonies follow the song's key (detected automatically; you can correct it), so they stay in key.
  - **Sing it:** move your notes an octave or two. It picks the best fit for your range; the music stays put, so you sing in octaves with the singer.
  - **Music key:** shift the backing track and guide vocal up to 7 semitones either way to suit your voice. The first time takes a few seconds while the server makes a shifted copy (Rubber Band, so the tempo doesn't change); after that it's instant.
  - **Speed:** slow the song to 90, 80, 75, 70, 60 or 50% without changing its pitch, to learn a fast passage. The notes, lyrics and scoring slow down with it. The first time takes up to half a minute per speed; after that it's instant.
  - **Backing vocals** have their own volume slider, separate from the band. Songs added before this need re-analysing once (the song list offers it).
  - "Any octave counts" is still there if you'd rather be scored in whatever octave you sing.
- **Grading.** Each note is scored on onset, transition and hold. Scoops into a note aren't penalised. Results show your score, notes landed, whether you sit sharp or flat, and your weakest notes.
- **Latency.** A 10-second timing check at the start of each session measures your headphone and mic delay (sing "da" with a few beeps), saved per device. After each run it also checks whether your pitch line fits better shifted in time and offers a one-tap correction.
- **Charted melody notes.** When a song is added, the app looks for a chart of its vocal line that people have already written out note by note, for karaoke games (UltraStar: AllKaraoke, USDB), rhythm games (Rock Band / Guitar Hero charts via Encore), Hooktheory's TheoryTab, the MIR-ST500 dataset and MIDI files (BitMidi). Each chart is lined up with the singer's pitch line in your video (offset, key, tempo, then phrase by phrase) and used only if its notes sit on it. The song page says where the notes came from; **Charts…** lists every chart found with how well it lines up, lets you switch between them or back to the detected notes, and searches again. See "Charted melody notes" below.
- **Lyrics.** A panel under the notes follows the song, highlighting the current line (and word, for transcribed songs). Tap a line to jump there, nudge the timing with − and +, or edit the words. The automatic lookup reads "Artist - Song", "Song - Artist", "Artist | Song" and titles with only the song name (using the channel name), and gives up rather than show another band's song. If it misses, ↻ lists the LRCLIB versions to choose from, and ⏱ syncs them: play the song and tap **Now** as a line starts.
- **Warm-ups.** Five-note scale, arpeggio, thirds, octave leap, long tone, minor and nine-note scales, plus chained series. Each climbs through your range semitone by semitone and back down.
- **Range test and tuner.** Hold your lowest and highest comfortable notes to set your range.
- **Find songs.** 53 well-known songs (Johnny Cash to Paul Kelly) with their melody ranges from the Singing Carrots database, rated easy / medium / hard, filtered by your saved range. Songs slightly too high or low show the key shift that fits (up to 5 semitones), and that shift is set for you when you add it. **Add part** keeps just a verse and chorus (about a minute, placed with the song's timed lyrics from LRCLIB and lined up with where the vocal actually starts in that video); **Whole song** adds the full track. Edit `app/songbook.json` to add your own.
- **Voice range profile** (Range page). Sing each note as softly and as loudly as you can; a bar per note shows the span between your softest and loudest. Save profiles and compare them later (same mic, same distance), or set your range from it. Levels are in dB of the mic's full scale, not calibrated dB SPL. Idea from Hideki Kawahara's voiceRTFB.
- **Loudness line.** A band under the notes shows the singer's loudness from the recording (grey) and yours (blue), each against its own loud passages, so you can match swells and fades. "Show loudness" on the song page turns it off.
- **Ear training.** Higher or lower, name the interval, sing it back. Misses are logged so weak intervals show up.
- **Progress.** Score history, an accuracy heatmap by note, ear-training stats, and recorded takes you can play back.
- **Storage** (Settings → Manage storage, or `#/storage`). How much of the server's disk Vocal Lab uses, split into songs and recordings, then every song sorted by size (audio, original download, key/speed copies, notes and lyrics) and every recorded take. Delete a song, clear a song's key/speed copies (they're rebuilt when you next pick that key or speed), or tick recordings and delete them, keeping their scores in Progress or not. "Select older than 30 days" picks old takes in one go. Files nothing in the app points to any more (folders from deleted songs, takes whose run is gone, stale uploads) show up as leftovers you can clear.
- **AI Coach (beta, separate page at `/coach`, "Coach β" in the menu).** A Singing Carrots-style text coach, kept apart from the main app so the two can be compared. Live pitch from the mic (mic-pitch, YIN), two short sessions (*Match the note*: hear a note, sing it back, five notes across your range; *Hold the pitch*: three 6-second holds), and a chat with a Claude or OpenAI model that gets the session's numbers as text and replies with one or two things to work on. It keeps a memory you can see and edit: notes it chose to save about you, plus your recent session summaries. **Audio never leaves your device**: the browser turns your singing into numbers, and only those numbers (shown under "What the coach sees") and what you type go to the server and on to the model. Set `ANTHROPIC_API_KEY` (default model `claude-haiku-5-5`, change with `ANTHROPIC_MODEL`) or `OPENAI_API_KEY` (default `gpt-4o-mini`, which OpenAI retires on 14 Jan 2027; change with `OPENAI_MODEL`) in the stack's `.env`; `COACH_PROVIDER=anthropic|openai` picks one if both are set, and `COACH_MAX_TOKENS` sets the reply length. To change the coach's instructions without rebuilding, put your own system prompt in `data/coach-prompt.md`. **Coach on results:** the same coach also replies under lesson results and song (sing-along) scores, using the numbers the grader already worked out (Settings → "Coach on results" turns it off; it hides itself if the coach isn't set up or fails). Lesson, song and coach-page sessions share one memory and one conversation. The backend routes are `POST /api/session` (practice results in, coaching out), `POST/GET /api/memory` and `DELETE /api/memory/{id}`; memory notes live in the `memories` table.

There's one password (`VL_PASSWORD`) rather than accounts. It's one person's trainer, and everything syncs through the server's SQLite database.



## Install with Dockge

GitHub builds the app image on every change and publishes it as `ghcr.io/dabsy1111/singing-training`, so the server only downloads it (about 1 GB compressed). Nothing gets built on the OptiPlex.

1. In Dockge, click **+ Compose** and name the stack `vocal-lab`.
2. Paste the contents of [`compose.yaml`](compose.yaml) into the compose editor.
3. In the `.env` box below it, add the server's LAN IP and a password:
   ```
   VL_HOST=192.168.1.50
   VL_PASSWORD=pick-something-long
   ```
   Wrap the password in single quotes if it contains a `$`. Changing it later signs every device out.
4. Click **Deploy**.

Then open:

- On your phone or PC: **https://<server-ip>:8443**

**Updating:** press **Update** on the stack in Dockge. It pulls the newest image and restarts. Your songs, takes, history and settings live in the stack's `data/` folder and aren't touched.

Optional settings for the `.env` box (defaults shown): `VL_HTTPS_PORT=8443` and `VL_TUNNEL_PORT=18095` (change either if the port is taken), `MAX_SONG_MINUTES=12`, `PITCH_MODEL=swiftf0`, `NOTE_MODEL=game_checked` (`game` keeps every GAME note, `contour` brings back the old notes from the pitch line), `LEAD_SPLIT=1`, `CREPE_MODEL=tiny`, `DEMUCS_MODEL=htdemucs`, `PROCESS_THREADS=5`, `YTDLP_AUTO_UPDATE=1`, `ANTHROPIC_API_KEY=` or `OPENAI_API_KEY=` (turns on the AI Coach page), `COACH_PROVIDER=`, `ANTHROPIC_MODEL=claude-haiku-5-5`, `OPENAI_MODEL=gpt-4o-mini`, `COACH_MAX_TOKENS=1024`, `COACH_THINKING=off`, `NOTE_SOURCES=allkaraoke,usdb,encore,hooktheory,st500,midi` (charts to look melody notes up in; `none` turns it off), `USDB_USER=` and `USDB_PASSWORD=` (a free usdb.animux.de account adds the biggest karaoke chart database).

### Without Dockge

```bash
git clone https://github.com/dabsy1111/singing-training.git
cd singing-training
./install.sh     # first time: writes .env with this machine's IP, pulls and starts
./update.sh      # later: pulls the newest image and restarts
```

### Why HTTPS matters

Browsers only allow microphone access on secure pages, so `http://192.168.x.x` won't work from your phone or PC. Caddy serves HTTPS with its own local certificate. The first time, the browser warns that the certificate isn't trusted. You have two ways round it:

1. **Click through the warning** ("Advanced → Proceed"). The microphone still works in Chrome and Firefox.
2. **Trust Caddy's root certificate** to get rid of the warning for good. It's at `caddy-data/caddy/pki/authorities/local/root.crt` once Caddy has started. Install it on Android under Settings → Security → Encryption & credentials → Install a certificate → CA certificate. On Windows, double-click it and add it to "Trusted Root Certification Authorities".

If you use Tailscale, `tailscale serve --bg https+insecure://localhost:8443` on the server gives you a real HTTPS address with no certificate warnings, and it works away from home too.

### Cloudflare tunnel (access from anywhere)

A tunnel also solves the certificate warnings, since Cloudflare serves a real certificate, so it's the easiest way to use an iPhone.

1. Set `VL_PASSWORD` first. Without it, the app refuses anything arriving through the tunnel.
2. In your tunnel's public hostname settings, point the service at **HTTP** `192.168.1.50:18095` (your server IP and `VL_TUNNEL_PORT`). That's a plain-HTTP door in Caddy just for cloudflared; Cloudflare adds the HTTPS.
3. Open your tunnel hostname, sign in, and you stay signed in for 30 days on that device.

Wrong passwords are slowed down, and eight in 15 minutes locks that address out for 15 minutes.

### Lyrics

When a song is added, the server looks it up on [LRCLIB](https://lrclib.net), a free community database of line-timed lyrics, matched on artist, title and length. Video versions often have a longer intro than the album version, so it lines the timing up with where the singing actually starts (and leaves it alone if it isn't confident).

If LRCLIB doesn't have it and you've set `GROQ_API_KEY`, the separated vocal is sent to Groq's hosted Whisper (`whisper-large-v3`), which returns every word with a time. That costs about $0.11 per hour of audio, so a few cents for a hundred songs. Transcriptions can mishear words, especially shouted or heavily effected vocals; fix them with ✎. Lines Whisper invents over silence ("thanks for watching" and the like) are dropped.

For songs added before this existed, press ↻ in the lyrics panel. If the title is messy, correct the artist and song in that dialog.

### Charted melody notes

The melody finder hears the notes from the separated vocal. For most well-known songs someone has already charted the vocal line by hand, with one note per syllable and the right pitch, so the app looks for those first. Sources, in the order they're searched (`NOTE_SOURCES` picks and orders them):

| Source | What it is | How it's matched | Needs |
|---|---|---|---|
| `allkaraoke` | [AllKaraoke.party](https://allkaraoke.party): ~7,700 UltraStar charts, each timed to a YouTube video | same YouTube video, or artist + title | nothing |
| `usdb` | [usdb.animux.de](https://usdb.animux.de): the big UltraStar database (~50,000 charts) | artist + title | a free account: `USDB_USER`, `USDB_PASSWORD` |
| `encore` | [Encore](https://www.enchor.us): Clone Hero / YARG chart search; Rock Band and Guitar Hero charts with a vocals part | artist + title | nothing (only the chart's notes file is downloaded, not its audio) |
| `hooktheory` | Hooktheory TheoryTab melodies as released with [Sheet Sage](https://github.com/chrisdonahue/sheetsage) (CC BY-NC-SA 3.0): ~26,000 verse/chorus sections timed to ~15,000 YouTube videos | same video, or artist + title | nothing (a 20 MB download, once) |
| `st500` | [MIR-ST500](https://github.com/york135/singing_transcription_ICASSP2021): 500 pop songs (mostly Mandarin) with hand-labelled vocal notes | same YouTube video only | nothing |
| `midi` | [BitMidi](https://bitmidi.com) MIDI files; the vocal or melody track | artist + title | nothing |

Charts are rarely timed to your exact video, so each one is lined up with the singer's pitch line: the whole chart first (offset, key and octave, and tempo within ±3%, or ±15% for MIDI files), then each phrase nudged on its own. A chart is used when at least ~65% of its notes are on the singer's pitch (75% for MIDI) and it covers most of the singing. Hooktheory only charts sections, so its sections that line up are put in and the detected notes fill the rest. If nothing lines up, the detected notes stay. Hand edits in the editor are kept; **Charts…** on the song page shows every chart found, with its scores, and lets you pick one, go back to the detected notes, or search again. Songs added before this existed get a "Look up all" banner on the Songs page (under a minute per song, no audio work).

Tested (Nov 2026) against the official Rock Band charts of 8 songs, with the audio offset by a random 2–15 s: AllKaraoke charts timed to a *different* video agreed with the official chart on 96–99% of their pitch (Bohemian Rhapsody 87%, Take On Me 81%) and put 89–97% of note starts within 100 ms of the official ones; notes detected from the vocal agreed on 71–94% with 61–84% of starts that close. The official chart itself was found at the right offset to within 50 ms.

### iPhone and AirPods

Use Safari over the tunnel address (or the LAN address after trusting Caddy's certificate on the phone). Things to know:

- The first time you sing in a session, the timing check runs. With AirPods expect 150–300 ms. Run it again from Settings if you switch to different headphones.
- While the mic is on, iOS switches AirPods into headset mode, so the music sounds flatter than usual. That's iOS, not the app, and the AirPods mic works fine for pitch.
- Calls, Siri or another app taking the audio will stop playback; press play again.
- Safari → Share → **Add to Home Screen** gives it its own icon.

### YouTube

yt-dlp updates itself each time the container starts (`YTDLP_AUTO_UPDATE=1`), because YouTube changes often and old versions break. A home connection normally works without signing in. If a song fails with "YouTube wants a sign-in check":

1. Install a "Get cookies.txt LOCALLY" extension in your browser, open youtube.com while signed in, and export cookies.
2. Save the file as `data/cookies.txt` in the stack folder (with Dockge, `/opt/stacks/vocal-lab/data/cookies.txt`).
3. Press Retry on the song.

Songs over 12 minutes are rejected (change with `MAX_SONG_MINUTES`).

### How long processing takes

For a 4-minute song on the i5-9500T, expect about 1–2 minutes for separation, about as long again for the lead/backing split, and a few seconds for the pitch analysis. `LEAD_SPLIT=0` skips the lead/backing split (faster, but harmonies and gang vocals can pull the melody off). `PITCH_MODEL=crepe` brings back the old CREPE tracker. Songs analysed before the lead/backing split show a ↻ button and a "Re-analyse all" banner on the song list; re-analysing keeps lyrics, scores and a hand-set key. One song is processed at a time; the rest queue.

## Tips for good scores

- **Use headphones.** With speakers the mic hears the music too. Wired has the least delay; Bluetooth (AirPods) works once the timing check has measured it.
- Set your range first (Range page). Warm-ups and the "fits your range" hint on each song use it.
- If a song sits an octave away from your voice, tick "Any octave counts".
- Songs with lots of backing vocals or heavy effects give messier melodies. Clear lead vocals work best.

## Backups

Everything you'd want to keep lives in `data/`: the database (`vocal-lab.db`), processed songs, and recorded takes. Back up that folder.

## Changing the code

Push to `main` and the **Build image** workflow publishes a new image within about 10 minutes; then press Update in Dockge. Edits to the README, `compose.yaml` or the scripts don't trigger a build. To build on the server instead (for testing), use `docker compose -f compose.yaml -f compose.build.yaml up -d --build`.

## Layout

```
app/main.py           API: songs, runs, settings, stats, media
app/pipeline.py       yt-dlp → Demucs → lead/backing split → SwiftF0 → notes, one song at a time in a background thread
app/mdx.py            runs MDX-Net ONNX models (the Karaoke 2 lead/backing split)
app/db.py             SQLite
app/auth.py           password sign-in (VL_PASSWORD), session cookie
app/lyrics.py         LRCLIB lookup, Groq Whisper transcription, timing alignment
app/notesources.py    charted melody notes: UltraStar / Rock Band / Hooktheory / MIDI lookups, lining charts up with the pitch line
app/static/           Front end, plain JS with no build step
  lessons.js          the course: lesson text, cues, exercises, pass marks
  course.js           lesson engine, exercise types, scoring and tips
  app.js              views, practice engine, scoring, drills, ear training
  pitch-worklet.js    YIN pitch detection on the audio thread
```

Pitch smoothing and spike rejection in `app.js` are adapted from [kunukn/singing-experience](https://github.com/kunukn/singing-experience) (0BSD).

Models: [Demucs](https://github.com/facebookresearch/demucs) (MIT, Meta) splits vocals from music; UVR-MDX-NET Karaoke 2, trained by the [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) project (MIT), separates lead from backing vocals, run through code in `app/mdx.py` that follows [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) (MIT); [SwiftF0](https://github.com/lars76/swift-f0) (MIT) tracks the pitch.
