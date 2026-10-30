#!/bin/sh
# Re-copy the dictionary files into /app/data only if a mount hides them.
# Guest/game data lives in Postgres in this slice, not in /app/data, and
# there is no SQLite file to protect. This only copies the dictionary
# files, and only if one of them is missing.
set -e
mkdir -p /app/data
if [ ! -f /app/data/words.txt ] || [ ! -f /app/data/definitions.json ]; then
  cp /app/data-seed/words.txt /app/data-seed/definitions.json /app/data/ 2>/dev/null || true
fi
exec "$@"
