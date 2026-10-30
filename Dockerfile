# Duello bot-play slice — Docker image for hosted deployment (Render, etc.)
# Runs the server exactly as it runs locally:
#   Node 22, `node server.js`, port from $PORT (default 3000),
#   Postgres via DATABASE_URL (REQUIRED — the server exits at startup
#   without it; there is no SQLite fallback in this slice),
#   dictionary from data/words.txt and data/definitions.json.
#
# No persistent disk is needed in this slice: guest/game data lives in
# Postgres, not in /app/data. The dictionary files are copied into the
# image, and the entrypoint only re-copies them if a mount ever hides
# them. The old SQLite file data/duello.db does not exist here.
FROM node:22-slim
WORKDIR /app

# Runtime dependency is `pg` (Postgres client) in package.json, so
# --omit=dev is enough. The dev dependencies in package.json are only
# for building the dictionary, not for running the game.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY db ./db
# Dictionary data, twice on purpose: /app/data for plain runs,
# /app/data-seed so a mount hiding /app/data can be re-seeded.
# data/WORD.LST is excluded by .dockerignore; there is no .db file here.
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
