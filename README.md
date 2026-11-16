# Vocal Lab

A self-hosted singing trainer modelled on vocalify.me, with one big addition: paste a YouTube link and it becomes a sing-along exercise. The server splits the vocals from the music, works out the melody, and the browser grades your pitch against it in real time.

## What it does

- **Songs from YouTube or files.** yt-dlp downloads the audio, Demucs (`htdemucs`) splits vocals from accompaniment, CREPE tracks the vocal pitch and turns it into notes. The recording's tuning is measured, so songs that aren't at A440 still grade fairly.
- **Live pitch feedback.** Your voice is drawn over the target notes, 100 times a second, coloured green / amber / red by how many cents you're off. The HUD says "aim higher" or "aim lower".
- **Practice controls.** Pick a section (or set it from the playhead), loop it, mix the accompaniment and guide vocal, drag the track to move around, and turn on "any octave counts" for songs written for a different voice.
- **Grading.** Each note is scored on onset, transition and hold. Scoops into a note aren't penalised. Results show your score, notes landed, whether you sit sharp or flat, and your weakest notes.
- **Latency.** Speaker and Bluetooth delay reported by the browser is compensated automatically. After each run it checks whether your pitch line fits better shifted in time and offers a one-tap correction.
- **Warm-ups.** Five-note scale, arpeggio, thirds, octave leap, long tone, minor and nine-note scales, plus chained series. Each climbs through your range semitone by semitone and back down.
- **Range test and tuner.** Hold your lowest and highest comfortable notes to set your range.
- **Ear training.** Higher or lower, name the interval, sing it back. Misses are logged so weak intervals show up.
- **Progress.** Score history, an accuracy heatmap by note, ear-training stats, and recorded takes you can play back.

There are no accounts. It's one person's trainer on a home network, and everything syncs through the server's SQLite database.

Not built yet, compared with Vocalify: the structured lesson course and the melody editor.

## Install on the OptiPlex

Needs Docker with the Compose plugin. The image is about 3.4 GB (CPU-only PyTorch plus the Demucs model).

```bash
git clone https://github.com/dabsy1111/singing-training.git
cd singing-training
./install.sh
```

`install.sh` creates `.env` with the server's LAN IP filled in and starts everything. To change settings later, edit `.env` and run `docker compose up -d`.

The first build takes a while (it downloads PyTorch and the separation model). After that:

- On other devices: **https://<server-ip>:8443**
- On the server itself: http://localhost:8080

### Why HTTPS matters

Browsers only allow microphone access on secure pages, so `http://192.168.x.x` won't work from your phone or PC. Caddy serves HTTPS with its own local certificate. The first time, the browser warns that the certificate isn't trusted. You have two ways round it:

1. **Click through the warning** ("Advanced → Proceed"). The microphone still works in Chrome and Firefox.
2. **Trust Caddy's root certificate** to get rid of the warning for good. It's at `caddy-data/caddy/pki/authorities/local/root.crt` once Caddy has started. Install it on Android under Settings → Security → Encryption & credentials → Install a certificate → CA certificate. On Windows, double-click it and add it to "Trusted Root Certification Authorities".

If you use Tailscale, `tailscale serve --bg 8080` on the server gives you a real HTTPS address with no certificate warnings, and it works away from home too.

### YouTube

yt-dlp updates itself each time the container starts (`YTDLP_AUTO_UPDATE=1`), because YouTube changes often and old versions break. A home connection normally works without signing in. If a song fails with "YouTube wants a sign-in check":

1. Install a "Get cookies.txt LOCALLY" extension in your browser, open youtube.com while signed in, and export cookies.
2. Save the file as `data/cookies.txt` in the vocal-lab folder.
3. Press Retry on the song.

Songs over 12 minutes are rejected (`MAX_SONG_MINUTES` in `.env`).

### How long processing takes

For a 4-minute song on the i5-9500T, expect about 1–2 minutes for separation and well under a minute for the pitch analysis with the default `CREPE_MODEL=tiny`. `full` is more accurate on breathy or heavily produced vocals but around 15× slower on CPU. One song is processed at a time; the rest queue.

## Tips for good scores

- **Use wired headphones.** With speakers the mic hears the music too. Bluetooth headphones work, but check the timing suggestion after your first run.
- Set your range first (Range page). Warm-ups and the "fits your range" hint on each song use it.
- If a song sits an octave away from your voice, tick "Any octave counts".
- Songs with lots of backing vocals or heavy effects give messier melodies. Clear lead vocals work best.

## Updating and backups

```bash
cd singing-training
./update.sh
```

That pulls the latest code from GitHub and rebuilds. Your `data/` folder and `.env` aren't touched by git, so songs, takes, history and settings survive updates.

Everything you'd want to keep lives in `data/`: the database (`vocal-lab.db`), processed songs, and recorded takes. Back up that folder.

## Layout

```
app/main.py           API: songs, runs, settings, stats, media
app/pipeline.py       yt-dlp → Demucs → CREPE → notes, run one at a time in a background thread
app/db.py             SQLite
app/static/           Front end, plain JS with no build step
  app.js              views, practice engine, scoring, drills, ear training
  pitch-worklet.js    YIN pitch detection on the audio thread
```

Pitch smoothing and spike rejection in `app.js` are adapted from [kunukn/singing-experience](https://github.com/kunukn/singing-experience) (0BSD).
