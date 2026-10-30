# Duello bot-play slice — Postgres, no login

This folder is a separate test slice. It does NOT touch the live SQLite
version in `~/workspace/duello-v1/`, and nothing here has been pushed to
GitHub or deployed to Render.

## What this slice is

Bot play only, opened straight to play with no email/password screen:

- Opening the app calls `POST /api/guest` once, on first load. The
  server creates a per-device guest (`guest_<random>`, dummy
  `guest_<random>@guest.local` email, a random scrypt password hash that
  is never shown to the user, Elo 1000) plus a session token. The
  client stores that token in localStorage under the existing
  `duello_token` key and reuses it, so Elo follows that device.
  If a stored token is later rejected (for example the database was
  reset), starting a game creates a fresh guest once and retries.
- In scope: board, premiums, 6-tile racks, chess clocks (including the
  tap-time clock switch), scoring/bonuses, definitions, Competitive Bot
  and Fishstick, bot 5s think and 20s clock step.
- Endpoints only: `POST /api/guest`, `POST /api/games`,
  `GET /api/games/:id`, `POST /api/games/:id/validate`, `/play`,
  `/pass`, `/forfeit`, `/shuffle`, `GET /api/define`.
- Out of scope, removed in this slice: friends, leaderboards, `/api/me`,
  `/api/me/update`, `/api/me/password`, profile stats, and any
  friends/profile UI. There is no dead friends/profile tab in the UI.
  Real accounts, friends tab, and profile tab come later, after bot
  play is right.

Game logic, validation, scoring, and the bot solver were NOT changed
in behaviour — only the database layer, the auth surface, and the
screens around the game were changed.

## How to run it locally

Prerequisites: Node >= 22, PostgreSQL 16, and the dictionary files in
`data/` (`words.txt`, `definitions.json` — already in this folder).

1. Create a local test database (example names; use your own password):
   ```
   sudo -u postgres psql -c "CREATE USER duello_test WITH PASSWORD 'duello_test';"
   sudo -u postgres psql -c "CREATE DATABASE duello_botplay_test OWNER duello_test;"
   ```
2. Install dependencies (only runtime dependency is `pg`):
   ```
   cd ~/workspace/duello-botplay
   npm install --omit=dev
   ```
3. Start the server. `DATABASE_URL` is REQUIRED — the server exits at
   startup with a clear error if it is missing, and there is no SQLite
   fallback in this slice, so a local run actually proves Postgres works:
   ```
   DATABASE_URL="postgres://duello_test:duello_test@localhost:5432/duello_botplay_test" PORT=3460 node server.js
   ```
   On first start the server creates the four tables from
   `db/postgres-schema.sql` (users, sessions, games, elo_history) if
   they do not exist, plus a `photo_data` column on users for later
   slices (not used by bot play).
4. Run the smoke test (in another terminal, with the server running):
   ```
   BASE=http://localhost:3460 npm test
   ```
   That test covers: guest creation (username `guest_*`, Elo 1000),
   a Competitive Bot game (it picks a human-first game, since the
   first-move finder assumes an empty board; bot-first candidates are
   abandoned, not forfeited), a valid first play, forfeit with Elo
   moving (1000 -> 984 on a forfeit loss), a second game with the
   SAME token carrying the same Elo and the old game still loading,
   a pass, definitions for ZA/JA/QI/ZEN/DUELLO, and `/api/me` and
   `/api/friends` returning 404.

## What was verified locally (Oct 30, 2026)

- PostgreSQL 16.15 installed locally via apt and started with
  `pg_ctlcluster 16 main start`.
- `node server.js` with no `DATABASE_URL` exits with:
  `DATABASE_URL is required: ...` (exit code 1).
- Smoke test passed (see `scripts/smoke-test-botplay.js`): guest,
  Competitive game, play AE for +2, forfeit Elo 1000 -> 984, second
  game with the same token showed Elo 984, old game reloaded as
  finished 2-0, pass returned to bot turn, definitions all returned.
- Bot move after a pass: bot played AIN for +4, turn returned to the
  human, bot clock stepped to 280,000 ms (the next 20s mark).
- Shuffle preserved the rack multiset; Fishstick game created with
  botElo 3000.
- Frontend shell: `/` contains home/bot/game screens only, no
  auth/friends/profile sections; `/app.js` calls only `/api/guest`,
  `/api/games`, and `/api/define`.

## Later Render step (NOT done in this task)

Jeff does this himself, later, when bot play is right:

1. In the Render dashboard, create a paid Postgres instance.
2. Deploy this folder as a web service (Docker, see `render.yaml`;
   no persistent disk is needed — data lives in Postgres).
3. Set `DATABASE_URL` in the Render dashboard to that Postgres
   instance. Do NOT put the URL in git or in `render.yaml`.
4. Redeploy, create a test guest, play a game, redeploy again, and
   confirm the same guest token still loads the same Elo/games.
   That redeploy-survival check has NOT been done yet — it is the
   first verification to do after the Render step.

## Later slices (NOT in this task)

Real accounts (signup/sign-in), friends tab, profile tab, stats
screens, leaderboards, and the UI pass. Those were deliberately left
out of this slice.
