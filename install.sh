#!/bin/sh
# First-time setup without Dockge: creates .env with this machine's LAN IP and starts everything.
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$IP" ] && sed -i "s/^VL_HOST=.*/VL_HOST=$IP/" .env
  PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)
  sed -i "s/^VL_PASSWORD=.*/VL_PASSWORD=$PW/" .env
  echo "Created .env with VL_HOST=${IP:-<edit me>} and password: $PW (change it in .env if you like)"
fi
mkdir -p data
docker compose pull
docker compose up -d
. ./.env
echo "Done. Open https://${VL_HOST}:8443 on your phone or PC (accept the certificate warning the first time)."
