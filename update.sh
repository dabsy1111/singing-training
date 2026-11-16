#!/bin/sh
# Pull the latest code and rebuild. Your songs, takes and settings in data/ are kept.
set -e
cd "$(dirname "$0")"
git pull --ff-only
docker compose pull caddy
docker compose up -d --build
docker image prune -f >/dev/null
echo "Vocal Lab is up to date."
