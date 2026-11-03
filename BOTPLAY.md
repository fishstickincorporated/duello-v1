# Duello bot-play slice — Postgres, sign-in required

This folder is a separate test slice. It does NOT touch the live SQLite
version in `~/workspace/duello-v1/`. It is pushed to GitHub (branch
`duello-botplay`) and deployed to Render at
https://duello-botplay.onrender.com/ since Oct 30, 2026.

## What this slice is

Bot play only. Sign-in is required before entering the app since Nov 2, 2026: with no valid session the client shows the auth screen, and guest creation (POST /api/guest) was removed, and guest sessions from before the gate authenticate nothing anymore (see below):

- Opening the app requires sign-in: with no stored session, or a
  rejected one, the client shows the auth screen (email/password
  sign-in or sign-up) and no tab bar. A valid session token in
  localStorage under `duello_token` goes straight to Home. Signing
  out returns to the auth screen. A rejected session during game
  start also returns to the auth screen.
- In scope: board, premiums, 6-tile racks, chess clocks (including the
  tap-time clock switch), scoring/bonuses, definitions, Competitive Bot
  and Fishstick, bot 5s think and 20s clock step.
- Endpoints: `POST /api/signup`, `POST /api/signin`,
  `POST /api/signout`, `GET /api/me`, `POST /api/me/update`,
  `POST /api/games`, `GET /api/games/:id`,
  `POST /api/games/:id/validate`, `/play`, `/pass`, `/forfeit`,
  `/shuffle`, `GET /api/define`, `GET /api/words`.
- Out of scope, removed in this slice: friends backend and leaderboards,
  `/api/me/password` (password change), and any friends UI backend. A
  friends/global leaderboard tab UI was added Nov 2, 2026. Its mock
  data was removed Nov 2, 2026: the Friends scope is empty until the
  friends backend lands, and Global is real registered users, top by
  Elo, from `GET /api/leaderboard` (guest rows excluded). Real accounts landed Nov 2, 2026: email/password
  signup, sign-in, sign-out, `GET /api/me`, `POST /api/me/update`, and
  real profile stats from finished games. Email-verified signup landed
  Nov 2, 2026: `POST /api/auth/request-code` emails a 6-digit code via
  Resend (verified domain duellogame.com, `RESEND_API_KEY` env var),
  `POST /api/auth/verify-code` checks it and returns a verified token,
  and `POST /api/signup` requires that token. Codes are scrypt hashes
  in `verification_codes`, expire after 10 minutes, allow 5 wrong
  guesses, and a new request replaces the old code (60-second cooldown).
  Password reset landed Nov 2, 2026, reusing the same code machinery with
  a separate `password_reset_codes` table: `POST /api/auth/request-reset`,
  `POST /api/auth/verify-reset-code`, and `POST /api/auth/reset-password`.
  Reset responses never reveal whether an address has an account: the
  request endpoint always reports success for a well-formed email, and
  every verify failure uses the same message. A successful reset changes
  the password, spends the code, and deletes every session for that user,
  so all devices sign in again. The sign-in screen has a Forgot password
  link leading a three-step flow (email, code, new password plus
  confirmation).
  Profile editing landed Nov 2, 2026: the gear on the profile tab (a real
  cog icon; the earlier icon read as a sun) opens an edit screen with
  photo upload, name, and username, plus a password change section.
  Photos upload as data URLs through `POST /api/me/update` (image only,
  750KB cap, null clears the photo; the column already existed via an
  idempotent migration). Password change is `POST /api/me/password`
  (signed in, current password plus new password, 8 minimum); it ends
  every other session and keeps the current one.
  Nov 2, 2026 checklist refinements: the password section starts as a
  lone Change password button (grey with a Duello blue border only, no
  solid fill) and the Current/New/Confirm fields appear only after it
  is tapped, matching the prototype; the profile Joined line shows
  month and year only; the 1 month / 1 year / All time chart toggles
  are bold.
  Nov 2, 2026 black-screen hardening: saved-login access goes through
  try/catch wrappers (storeGet/storeSet/storeDel), so a browser that
  blocks site data shows the auth screen instead of a permanent black
  screen; a noscript message covers JavaScript-off browsers.
  Guests are not an option at
  all: POST /api/guest was removed Nov 2, 2026, and a session issued to
  a guest before that authenticates nothing anymore — loading the app
  with one shows the auth screen, and signing up from there creates a
  brand-new account at 1000, leaving the guest row orphaned and inert.
  The guest upgrade path and the Start fresh button, both added Nov 2,
  2026, were removed the same day when guests were taken out entirely.
  No Google/Apple OAuth yet.

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
- Frontend shell: `/` contains home/bot/game/friends screens
  (friends is UI only); `/app.js` calls only `/api/guest`,
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
   Steps 1–3 were done Oct 30, 2026. The redeploy-survival check
   PASSED Nov 2, 2026: a test guest forfeited from Elo 1000 to 984,
   Render redeployed (words-list ETag changed), and the same guest
   token reloaded Elo 984 with its finished game intact.

## Later slices (NOT in this task)

Friends backend, Google/Apple OAuth, ads, and payments. (Real accounts,
the profile tab, and password change landed Nov 2, 2026; the friends
tab's Global scope is real users, its Friends scope awaits the backend.)

## Profile/friends polish + stats rules (Nov 2, 2026, cache v9)

- Profile tab: all numbers Arial/Helvetica (Elo + all-time high via
  CSS; stat values and the Joined year via .num spans on digit runs).
  Elo and all-time high sit side by side in a flex row. More space
  between username and Joined; less space above/below the gear.
- Edit screen: photo change is a pencil over the greyed-out pfp
  (tap the pfp to pick); Remove photo sits right below the pfp.
  First name / Last name / Username / Email carry labels beside the
  inputs. Tighter spacing after the username field and after the
  Cancel/Save row. New email field (server validates format +
  uniqueness; no verification code on change — a mistyped address
  would lock the account out, so an email-change verification step
  is a possible follow-up). Change password button now matches the
  other buttons: transparent, Duello blue border and blue text.
- Friends tab: the "Global shows real registered users" footer is
  gone; the friends tab icon's second person is Duello blue.
- Points bubble text is #1a1d24 (was #222, near-black).
- Tile values carry a 2px same-color stroke (paint-order stroke) so
  thin glyphs like 1 read at the same weight as 3/4/5.
- Stats: Fishstick matches no longer count toward win-loss record or
  games played (other per-game stats still include them). Average
  game score counts only games where the player's own clock fully
  expired (saved clocks.human <= 0); games ended early are excluded.

## Boot diagnostics (Nov 2, 2026, cache v10)

- A #bootError overlay lives in index.html (gold box, tap to
  dismiss): an inline script installed before app.js reports any
  uncaught script error (message + file:line:col) and any unhandled
  promise rejection into it, and the app.js script tag reports a
  load failure there too. It exists so a black screen on a phone
  names its own failure without a desktop console.
- Boot no longer waits forever on /api/me: if the login check takes
  over 10s, Home shows anyway (the transient-error path). A late
  rejection from the raced request is swallowed so it cannot trip
  the overlay.

## TDZ fix (Nov 2, 2026, cache v11)

- The phone's error box caught a real startup bug: the boot code
  calls setAuthMode, which assigns authMode, but `let authMode`
  was declared after the boot code, so the assignment threw
  "Cannot access 'authMode' before initialization" before any
  screen could show. The declaration now lives with the other
  top-of-file lets, ahead of the boot code.

## Leaderboard pfp + text sizes (Nov 2, 2026, cache v12)

- Leaderboard/search rows had no size rule for photos, so an
  uploaded photo rendered at full natural size while silhouettes
  rendered at 36px. All row pfps (leaderboard + search results)
  are now a 36px circle with object-fit cover, matching the other
  row pfps. The stylesheet link now carries the same ?v= cache
  buster as the script tag, so CSS-only changes actually reach
  players instead of sitting behind a cached stylesheet.
- Friends/Global toggle text and the LEADERBOARD heading are now
  18px, matching the row name/Elo/rank size (they were default
  16px). Secondary sizes left alone: @username 14px, YOU badge
  11px, Pending 12px.

- YOU badge (Nov 2, 2026, cache v13): the badge now aligns with
  the name line (align-self flex-start + 2px top margin) instead
  of sitting vertically centered in the taller row.

- Scoreboard clock (Nov 2, 2026, cache v14): the clock column's
  top padding went 10px -> 4px, matching the panel's other edge
  padding, so the clock sits higher and the last-play area gains
  about a full extra line for multi-word plays.

- Profile Elo row (Nov 2, 2026, cache v15): the All-time high
  label and value are right-justified within the row's right
  half; Elo stays left.

## Scoreboard last-play fit + score justification + lifetime bingos (Nov 2, 2026, cache v16)

- Last play can no longer wrap or clip: the words line is wrapped
  in a nowrap span and a fitLastplay pass (end of renderGame)
  shrinks the last-play block from 11px down to 6px until the
  words line fits its column and the block fits the panel height
  (58px budget: 88px panel - 22px clock - 8px padding). A single
  6-letter word always shows on one line; the block can never
  grow past the panel. Measured widths behind this: PLANET is
  45.3px at 11px vs a 42px column at phone width, so it wrapped
  before; the 3-digit score at 32px is 58.1px wide, already over
  its 56px column, so the score column was left untouched.
- Score justification: the player's score is left-justified
  (toward their pfp) and the opponent's is right-justified
  (toward theirs), instead of both centered.
- Lifetime bingos: a new profile stat counting human moves that
  used all 6 tiles. The move record now saves the bingo flag, and
  profileStatsFor counts it across finished games (Fishstick
  games included, like the other word stats). Past games cannot
  contribute: their saved moves never stored the flag, so the
  count starts from this change.

## Scoreboard Elo staleness (Nov 2, 2026, cache v17)

- The scoreboard showed the human Elo from the sign-in copy
  (me.elo, cached all session) instead of the fresh game
  response, so after a loss the human number looked unchanged
  while the bot number (game.botElo, mutated by endGame) moved
  — and Play Again showed the old number again until leaving
  the game screen refetched /api/me. The scoreboard now reads
  game.player.elo first (fresh from the database on every game
  response), falling back to the cached copy only if absent.
  The database update itself was always correct; only the
  display was stale.

- Last-play bingo tag (Nov 2, 2026, cache v18): "bingo! +30"
  never splits across lines (nowrap on the bingo span); the whole
  tag moves to the next line as a unit when the column is tight.

## Last-play full-width row, no shrinking (Nov 2, 2026, cache v19)

- The last-play line moved out of the cramped clock column into
  its own full-width row under each panel (identity | score |
  clock on top, last play below), because the 3-column math
  could not fit every 6-letter word at full size: the clock
  column gave the line 42px at phone width while PLANET alone
  is 45.3px at 11px. The row gives the line the whole panel
  width (~174px), so any 6-letter word plus a comma fits on one
  line at the standard 11px with room to spare, and longer word
  lists wrap between words, never mid-word, never clipped: the
  panel is now auto height (both panels stretch to match) and
  the row reserves two lines (27px min-height) so the board
  never jumps when the first play lands. The v16 shrink logic
  (fitLastplay) is removed entirely; the words line is standard
  size again, points stay blue directly below the words, and
  the bingo tag stays nowrap from v18.
