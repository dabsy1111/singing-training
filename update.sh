#!/bin/sh
# Pull the newest image built by GitHub and restart. Your songs, takes and settings in data/ are kept.
# (Dockge users can just press Update instead.)
set -e
cd "$(dirname "$0")"
[ -d .git ] && git pull --ff-only
docker compose pull
docker compose up -d
docker image prune -f >/dev/null
echo "Vocal Lab is up to date."
