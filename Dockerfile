# Duello v1 — Docker image for hosted deployment (Render, Fly.io, etc.)
# Runs the existing server exactly as it runs locally:
#   Node 22, `node server.js`, port from $PORT (default 3000),
#   SQLite database at data/duello.db, dictionary from data/words.txt
#   and data/definitions.json.
#
# Why there is a data-seed copy: a persistent volume (Fly.io) or disk
# (paid Render) mounted at /app/data would hide the dictionary files
# copied into the image, because a fresh volume starts empty. The
# entrypoint below copies the dictionary into the volume on first boot
# if it is missing, so the app still starts. Without that, the server
# would fail to load data/words.txt on a fresh volume.
FROM node:22-slim
WORKDIR /app

# No runtime dependencies (server.js uses only Node built-ins), so
# --omit=dev is enough. The dev dependencies in package.json are only
# for building the dictionary, not for running the game.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY db ./db
# Dictionary data, twice on purpose: /app/data for plain runs,
# /app/data-seed so a fresh persistent volume can be seeded.
# data/duello.db and data/WORD.LST are excluded by .dockerignore.
COPY data ./data
COPY data ./data-seed
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
# Render sets PORT itself at runtime and overrides this. Fly.io gets
# PORT=3000 from fly.toml. Do not hard-code a different port here.
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
