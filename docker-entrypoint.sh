#!/bin/sh
# Seed a fresh persistent volume/disk mounted at /app/data.
# A fresh volume starts empty and would otherwise hide the dictionary
# files copied into the image, and the server would fail to start.
# Existing accounts (data/duello.db) are never overwritten: this only
# copies the dictionary files, and only if one of them is missing.
set -e
mkdir -p /app/data
if [ ! -f /app/data/words.txt ] || [ ! -f /app/data/definitions.json ]; then
  cp /app/data-seed/words.txt /app/data-seed/definitions.json /app/data/ 2>/dev/null || true
fi
exec "$@"
