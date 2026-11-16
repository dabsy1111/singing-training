#!/bin/sh
set -e
# YouTube changes often and old yt-dlp versions stop working. Update on every start unless turned off.
if [ "${YTDLP_AUTO_UPDATE:-1}" = "1" ]; then
  echo "Updating yt-dlp..."
  pip install -q -U "yt-dlp[default]" || echo "yt-dlp update failed; using the bundled version"
fi
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'
