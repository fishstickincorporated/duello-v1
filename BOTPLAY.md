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
- Out of scope, removed in this slice: leaderboards,
  `/api/me/password` (password change), and any friends UI backend. A
  friends/global leaderboard tab UI was added Nov 2, 2026. Its mock
  data was removed Nov 2, 2026: Global is real registered users, top by
  Elo, from `GET /api/leaderboard` (guest rows excluded), and the
  friends backend landed in part Nov 5, 2026 (v53: real friend
  requests with accept/decline; real-player challenges still have
  no delivery path). Real accounts landed Nov 2, 2026: email/password
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

## Scoreboard alignment + stacked words (Nov 2, 2026, cache v20)

- The top row now fills the panel (panel-top flex:1), so the
  pfp/name/elo block and the score sit vertically centered in
  it, while the clock stays top-aligned as before; both panels
  stretch to the same height, so both last-play rows sit at the
  same height at the panel bottoms, words next to each other at
  the center edges (player right-aligned, bot left-aligned).
- Edge spacing, both sides, 2px each: identity content now sits
  6px off the outside edge (was 4px) and 2px off the score side
  (was 4px), which also pulls the scores 2px closer to the
  outside edges; clocks and last-play words sit 6px off the
  center edge (was 4px). Scores stay left-justified (player)
  and right-justified (opponent) from v16. Border-box is on, so
  no column widths moved.
- Last-play words are now stacked vertically, one word per
  line, instead of comma-joined on one line; points stay blue
  below the list.

## Scoreboard restructure (Nov 2, 2026, cache v21)

- The middle score column is gone: the score now sits in the
  identity column, between the name and the Elo (name / score /
  Elo), left-flush on the player panel and right-flush on the
  opponent panel, i.e. at the outside edges. This was forced by
  geometry: a small score in the middle column always read as
  centered, because the column itself sits in the panel's
  middle. The score stays Arial (game-score added to the Arial
  list); the name/score/Elo order also puts the score at the
  panel's vertical center.
- The clock column now takes all leftover width (106px at phone
  width instead of 50px), because the old column clipped: it
  gave the clock a 40px content box while Arial Bold "4:59" is
  exactly 40.0px, and columns clip overflow, so the trailing
  digits garbled on the phone. The clock now fits with room to
  spare and stays 6px off the center edge.
- The Elo infinity line-height is 15px (was 20px) so both
  identity blocks are exactly the same height and both
  last-play rows sit at the same height.

## Scoreboard matches Jeff's mockup (Nov 3, 2026, cache v22)

- Score moves back out of the identity column into the clock
  column, under the clock, and turns Duello blue: player panel
  is pfp / name / Elo on the left, clock / score on the right;
  bot panel mirrors. Clock stays 20px, score stays 32px Arial
  Bold, only moved and recolored.
- Last play is now a fixed 3-line full-width block, centered,
  bottom-justified (flex-end, 40px min-height): the bottom
  line is always the points line, the 2 lines above are the
  words. Words are comma-joined flowing text again (not one
  per line), wrapping between words; with one word line it
  sits directly above the points, leaving the top line blank.
  Points line drops "pts" and the dot separator to match the
  mockup: "+38 bingo! +30" (points blue, bingo gold; Duello
  +30 stays blue when it applies).

## Scoreboard v23: clock matches score, last play outside (Nov 3, 2026, cache v23)

- Clock grows from 20px to 32px, matching the score exactly
  (both Arial Bold 32px now); score stays Duello blue under
  the clock.
- Last play moves out of the panels into one shared centered
  block below the scoreboard (words, then points/bingo line),
  showing the most recent play from either side, picked by
  whose turn it is (turn human -> bot's last, turn bot ->
  human's last, falling back to whichever exists). The block
  reserves 2 lines (27px min-height) even with no play yet,
  so the board sits a fixed distance below the scoreboard and
  never jumps when the first play lands. Panels are now just
  the top row (pfp / name / Elo | clock / score).

## Scoreboard v24: last play single line, side-justified (Nov 3, 2026, cache v24)

- Last play collapses from two lines to one: words, points,
  and bingo/Duello bonus all on the same line, e.g.
  "QUICKLY, JAZZED, FOXGLOVE +118 bingo! +30" (words grey,
  points Duello blue, bingo gold; a pass reads
  "passed -30s" on one line). Still one shared block showing
  the most recent play, picked by turn as in v23.
- Justification follows who played it: the human's last play
  is left-justified (starts at the left edge), the bot's is
  right-justified (ends at the right edge). The block is
  full width with nowrap, so a long string runs past the
  center line in its own direction instead of being clipped
  to its own half. Measured with real fonts: a 3-word bingo
  line is ~256px in the 358px content width, so it crosses
  the middle and still fits.
- Padding tightens above and below the line: scoreboard
  bottom margin 8px -> 2px, last-play margins 0/8px ->
  2px/2px, and the reserved height drops from 27px (2 lines)
  to 14px (1 line), so the board sits closer and still never
  jumps when the first play lands.

## Play-vs-poll race fix + faster 1v1 poll v81 (Nov 8, 2026, cache v81)

- First real 1v1 (Jeff vs NEO): a couple of Play taps returned all
  the tiles without making the move. Root cause was a race, not a
  rejected play. The Play tap flips the turn to the opponent
  optimistically, and the 100ms clock tick's watchdog saw a bot
  turn with no poll for 7s+ (it counts from the last poll of the
  previous opponent turn, so any think over 7s qualifies) and
  started a poll mid-flight; a poll whose GET landed after the
  Play reply overwrote the post-play state with a pre-play
  snapshot, so the move vanished and the tiles came back to the
  rack. The Play POST itself had succeeded server-side.
- Fix, client-only: pollBotTurn and handleTimeoutFetch now refuse
  to start while a play is in flight, and a response that lands
  during a flight is dropped instead of applied (the play reply
  sets the state, and doPlay's success re-polls). The watchdog
  also skips while a play is in flight. beginBotTurn is
  deliberately NOT guarded: doPlay calls it on success while
  playInFlight is still set (the finally clears it after), and
  its setTimeout(0) poll fires after the flag clears.
- Verified by a Node simulation against the real app.js (stub DOM
  + fake server, saved at
  workspace/goals/duello-1v1-word-game/hidden_files/play-race-test-v81.js):
  10/10 pass — the watchdog fires during the flight but no GET
  goes out, a slow pre-play GET resolving after the reply is
  dropped, the move lands, client matches server, and the poll
  loop stays alive.
- 1v1 lag: the opponent's client polled every 2s, so a move
  appeared up to ~2s late and the opponent's clock ticked on
  stale state, then jumped back up when the poll corrected it.
  Human-game poll is now every 1s (bot games unchanged). The
  real fix for instant moves is server push (SSE/WebSocket),
  offered as a next step, not built.

## Live 1v1 updates over SSE — no poll lag v83 (Nov 8, 2026, cache v83)

- Real 1v1 moves now arrive the instant they are played. The server
  pushes every saved game state to the other player's phone over a
  Server-Sent Events stream (GET /api/games/:id/stream?token=...),
  instead of the opponent learning about it on their next 1s poll.
  The 1s poll keeps running as the fallback, so if the stream drops
  the game just behaves like v82; the stream reconnects on its own
  and re-syncs on (re)connect because the current state is sent at
  once, with a 25s heartbeat keeping the connection alive.
- Server: one broadcast hook inside saveGameRow, so every mutation
  (play, pass, forfeit, timeout flip, finish) pushes — each
  subscriber gets its own serializeGame view (sides flipped per
  viewer, stats attached on finish). A broadcast can never fail a
  save: every subscriber write is guarded. The stream is auth-gated
  (token in the query, since EventSource cannot send a header;
  guests rejected, non-participants 404) and human-games only (bot
  games are driven by the client's polls, so they never stream).
- Client: the stream opens when entering a human game and closes on
  leaving the board (the stat window is an overlay, so it stays
  open through the finish). An incoming state invalidates every
  in-flight GET via the v82 sequence, so a stale poll response can
  never overwrite a streamed move; renderGame then shows the stat
  window itself when the streamed state is finished.
- Verified end to end before pushing. Client vm test on the real
  app.js (stub EventSource + fake server, 9/9): stream opens with
  the game id + token, a streamed move applies at once and kills a
  stale in-flight GET, the stream closes on leaving, bot games
  never open one, and the 1s poll still fires alongside it. Server
  vm test on the real server.js (fake pg, real HTTP, 12/12): NEO
  subscribes and gets the initial flipped state, Jeff's real /play
  arrives over the stream with the tiles, flipped turn, and score,
  within 1s of the play reply; no token is 401, a bot-game stream
  is 400. Both harnesses saved at
  workspace/goals/duello-1v1-word-game/hidden_files/duello-sse-client-test.js
  and duello-sse-server-test.js.

## Fishstick plays immediately instead of waiting 5s (Jeff's bug, Nov 16, 2026) v109 (Nov 16, 2026, cache v109)

- **Root cause (offline): the bot think was armed at game creation and ticked away during the 5s countdown.** `buildOfflineGame` set `botThinkMs = 5000; botThinkUntil = Date.now() + 5000` the moment the game was created — before `enterGameScreen` ran the 5s countdown. By the time the countdown ended, `scheduleLocalBotTurn` computed `delay = max(0, botThinkUntil - now) = 0`, so Fishstick played the instant the game appeared. The 5s countdown itself (blank rack, unplayable) is what read as "loading" — the screen does appear at once with the countdown visible. The online path was already correct: the server re-arms the think at `/start` (countdown end) and the client waits `botThinkRemainingMs`, so no server change was needed.
- **Fix: arm the think at countdown end, not at creation.** `buildOfflineGame` no longer arms the think (it stays null). The offline branch of `endCountdown` now calls `startLocalBotTurn()` when the countdown completes and the turn is the bot's — the local mirror of the server's `/start` re-arm — then persists and calls `beginBotTurn`. The sequence is now tap → screen + countdown (5s) → think (5s, "Waiting for Fishstick") → Fishstick plays, first move ~10s after the tap. A resumed game re-arms a fresh think on resume (already the behaviour in `maybeResumeOfflineGame`), so a stale persisted think can never make the bot play at once on reopen.
- Verified with a new v109 client harness (29 checks: 3 static + T1–T5 — screen appears at once on tap with the countdown visible and the think not armed at creation; no bot play during the countdown (1.5s in, think still not armed); full end-to-end real-time run: countdown ~5s, first Fishstick move ~5s after the countdown ends, ~10s after the tap; endCountdown arms the think fresh (~5000ms remaining) with no move 1s later; online: no bot poll in the first 1s after the countdown, first poll lands ~5s later). Regressions: v108 client passes except its own version pin (expected — the cache is now v109), v107 client 49/49, v106 client 62/62, v106 server 40/40, v105 engine parity 23/23, v104 server 7/7, v102 server 10/10, v90 server 13/13; v104/v103/v102/v98/v93 client harnesses pass except their own version-pin checks (expected). No server change.

## Launch opens a Fishstick game every time (Jeff's bug, Nov 15, 2026) v108 (Nov 15, 2026, cache v108)

- **Root cause: the resume check was too broad, and there was no way to abandon a game.** An offline game is persisted as status `'active'` the moment it is created — before the 5s countdown, before any move. `maybeResumeOfflineGame` (called by the boot flow on every launch) took the newest `'active'` record unconditionally and auto-resumed it, silently. There was no way out: `goHome()` does not clear the record, and closing the app persists it as `'active'` again — only finishing or forfeiting transitions it to `'finished'`. So a game that was started and abandoned (most often closed during the countdown) stayed `'active'` forever, and every launch dropped the user straight back into it. Closing the app to escape the game is exactly what kept it `'active'`, so it resumed again. It was the SAME game resuming each launch (same offlineId/board), not a fresh game — the resume loads the persisted record, it never creates one.
- **Fix: resume only a game the user genuinely was in the middle of.** `maybeResumeOfflineGame` now walks the `'active'` candidates newest-first and resumes only one that is really still in progress: the stored game's own status must be `'active'`, AND the game must have started (its 5s countdown completed — a new `started` flag, set in `buildOfflineGame` as `false` and set to `true` + persisted in the offline path of `endCountdown`) OR it was actually played (a move, a pass, or tiles on the board, via a new `offlineGameHasProgress` helper). A game that never started AND was never played is deleted and Home opens. A finished/forfeited game whose record still claims `'active'` is corrected to `'finished'` (so the outbox still syncs it, when it carries a real result) or deleted, and never resumes. A game whose countdown completed resumes even before its first move — the first version of this fix used "a move was played" as the only signal and wrongly deleted such a game, which the v106 C3 clock-pause test caught (its game had the countdown done and clocks running but no moves yet); the `started` flag is the precise signal.
- **Jeff's stuck game:** it was created by v106/v107, which have no `started` flag, so it reads as "not started". If it has no moves it is deleted on the first v108 launch and Home opens; if it does have moves it resumes once more as the same game, and forfeiting or finishing it then ends it for good.
- Verified with a new v108 client harness (25 checks: 3 static + R1–R8 — no record opens Home; a zero-move Fishstick game opens Home and its record is deleted; a genuinely in-progress game resumes as the SAME game with CAT still on the board; a finished game with a stale `'active'` record opens Home and is corrected to `'finished'` or deleted; a finished outbox game syncs, is deleted, and never reopens; newest junk is skipped and the older in-progress game resumes; a started game with no move yet resumes with its clocks kept). Regressions: v107 client 49/49, v106 client 62/62, v106 server 40/40, v105 engine parity 23/23, v104 server 7/7; v104/v102/v103/v98/v93 client harnesses pass except their own version-pin checks (expected — the cache is now v108). No server change.

## Offline checklist: Jeff's 7 airplane-mode fixes v107 (Nov 15, 2026, cache v107)

Jeff tested v106 in airplane mode and sent 7 items. All 7 are fixed here; no server change was needed (all client-side), so there is no v107 server harness — the v106 server harness still passes as a regression.

- **1. Clocks really pause now.** v106 only settled the clock once at hide time, but the 100ms `tickClocks` interval kept running and kept draining the settled clocks while the app sat in the background — that is the ticking Jeff saw. Now `tickClocks` returns early while the document is hidden (offline games only; online games keep the server-clock behaviour and re-sync on return), the pending bot think timer is cleared on hide so the bot cannot move while the app is closed, and the 5s countdown pauses on hide and resumes from its remaining time on return. `pauseOfflineClocks` also no longer settles during a countdown (the clocks have not started yet — settling would have wrongly charged the countdown seconds to the clock). Verified: a hidden tick with the turn timer 60s in the past drains nothing, and a countdown paused mid-way resumes and completes with the clocks still at 4:00.
- **2. Forfeit during the 5s countdown.** The Forfeit button was disabled until the countdown ended. It is now enabled at all times during an active game, reads "Forfeit" (no "Leave" string exists anywhere in v106 — the button was greyed-out "Forfeit", which is what Jeff saw), and forfeiting mid-countdown cancels the countdown outright so `endCountdown` never fires on the finished game. The forfeit ends cleanly as a 0-0 loss (By forfeit, bot wins) and persists as a normal finished game that syncs — no phantom row, no stuck countdown.
- **3. Bot games open at once offline.** The tap used to await the dictionary fetch + the solver index build (~827ms in Node, 1.5–3s on a phone) before the game screen appeared. Two changes: the solver index in `engine.js` is now built lazily on the first `findMoves` instead of eagerly in `createEngine` (measured on this VM: `createEngine` 327ms → ~0ms, tap path ~425ms → ~100ms; the index build moves into the first solve, which runs in the worker inside the 5s bot think), and the dictionary is warmed when the bot screen opens and at first online load (`preloadHomeTabs`), so the tap usually pays nothing at all. Verified: the engine index is empty before the first solve and built after it, the bot screen warms the dictionary, and a warmed tap opens the game in under 1s.
- **4. Searching offline says what it means.** The searching screen used to say "Searching for opponent…" while offline and then fire a persona match that failed silently. It now says "searching for internet connection" while offline and waits, re-checking every 2s, until the connection is back — then it proceeds to a real match. The Cancel button and navigating away still abandon the search as before.
- **5. Leaderboards work offline.** The Friends and Global lists used to render empty offline (a failed fetch set them to `[]`). The last-known payloads are now cached in localStorage when online (`duello_lb_global`, `duello_friends`) and rendered offline, with a "Last known results — offline, not live." marker whenever the data was not fetched live. With no cached data at all (never loaded online) the list is still empty — there is nothing to show.
- **6. Search copy offline.** The friend-search failure note read "Search isn't working (…)" — offline it now reads exactly "search requires an internet connection". Other (online) failures keep the old wording with the reason, so a real server error is not mislabelled as a connection problem. The fallback rows still come from the last-known leaderboard (item 5) when there is one.
- **7. Full profile offline.** The profile tab used to go blank offline (`renderProfileUI` returned on a failed `/api/me`). The last-known profile payload is now cached in localStorage when online (`duello_profile`) and the full tab — name, Elo, all-time high, rank, stats list, Elo chart data — renders offline from it, with a "Last known profile — offline, not live." marker. With no cached payload the tab is still blank.
- Verified with a new v107 client harness (49 checks: 5 static + D1–D7, ALL PASS). v106 client (62/62), v106 server (40/40), v105 engine parity (23/23), v104 server, v102 server, v90 server all still pass; v104/v102/v103/v98/v93 client harnesses pass except their own version-pin checks (expected — the cache is now v107).

## Offline bots: play Competitive + Fishstick offline, sync back and count v106 (Nov 15, 2026, cache v106)

- **This is the first version where offline games exist, and offline games only count once they sync.** Competitive Bot and Fishstick are now playable with no connection on both iOS and web; personas and real-player games stay online-only. An offline game is built locally (premiums, racks, 4:00 clocks, botElo = local Elo for Competitive / 3000 for Fishstick), runs entirely on the shared engine (`public/engine.js`, v105), and finishes locally with the Elo delta computed the same way. The delta shows in the stat window marked **pending sync** until the server confirms it, and the profile shows a "Games waiting to sync (N)" count until the outbox drains. Clocks **pause when the app is closed** (no background ticking — Jeff's decision 1) and resume from the persisted values on return; an in-progress offline game survives the app being killed (IndexedDB, with a localStorage fallback).
- **Airplane-mode buttons fixed (Jeff's live bug, Nov 15, 2026).** Tapping Play Fishstick / Play Competitive with no connection used to do nothing at all: `startGame` POSTed to `/api/games` and the catch only handled 'Not signed in', so a network failure returned silently. Now the tap starts a local game offline; if a local game cannot start for any reason (no dictionary, no signed-in user persisted), the bot screen shows a visible message instead of failing silently.
- **Solver in a Web Worker.** `public/engine-worker.js` owns the dictionary + index + `findMoves` (the index build is ~827ms in Node, so it never runs on the main thread); the main thread falls back to its own engine instance if workers fail. Premiums travel to the worker separately — structured clone drops `board.__premiums`.
- **Sync-back: `POST /api/games/sync`.** The client submits a complete finished game + a per-move log (`plays`: side, rack before the move, placements) + `offlineId` (idempotency key). The server replays it move-by-move with the engine (human moves re-validated, Fishstick's move must be exactly `moves[0]`, Competitive's must be in the legal list, scores recomputed, delta recomputed), inserts a normal `games` row (new `client_game_id` column + unique index, added idempotently in `initDb()` and the schema file), and applies the *stored, validated* delta to the current server Elo + one `elo_history` row. A duplicate `offlineId` is a no-op 200 (including a racing insert, caught via the unique violation). A failed replay is 422 and the client marks the game rejected and rolls the delta out of the local Elo. Only finished games sync; in-progress games never leave the device. Stats need no changes — `profileStatsFor` derives everything from finished rows. One catch found during the build: the stored state must carry `userId` and `botType`, because `profileStatsFor` decides which side a row owner played via `state.userId` — without them a synced game would read as the bot side and corrupt the profile. A forfeit before any move (empty `plays`, 0-0, bot wins) is accepted as a real game; a no-move game that is not a forfeit is still rejected.
- **Service worker (web only).** `public/sw.js` (cache `duello-v106`): shell + `/api/words` cache-first, every other `/api/*` network-only, versioned cache cleanup on activate, no `skipWaiting`/`clients.claim` so it never swaps JS mid-game. Registered from `index.html` only when not under Capacitor. First load offline on the web is impossible (inherent — a service worker only exists after one online visit); the app says so plainly instead of pretending otherwise. iOS needs none of this: the shell and dictionary are bundled. **iOS bundles `data/words.txt`** (`www/words.txt`, 1,218,546 bytes, byte-identical) — `www/` grows 4.1 → ~5.3MB; the web bundle grows by 0.
- Verified with a new v106 server harness (38/38: valid Fishstick replay + Elo, duplicate no-op, tampered Fishstick/Competitive rejected, non-word human move rejected, wrong delta rejected, racing duplicate no-op, no-move forfeit accepted, no-move non-forfeit rejected) and a new v106 client harness (62/62 across 3 runs: offline construction, a full offline game to completion, clock pause/resume, pending stat window, sync drain with the exact payload shape, 422 rejection + delta rollback, online unchanged, airplane-mode taps start local games, dictionary-missing tap shows a visible offline message). v105 engine parity, v104 server, and v104 client harnesses still pass; v93/v98/v102/v103 client harnesses pass except their own version-pin checks (expected — the cache is now v106).
- **Deploy fix (same v106, Nov 15, 2026).** The first v106 Render deploy failed at startup: `Postgres init failed: column "client_game_id" does not exist`. Cause: `db/postgres-schema.sql` had a `CREATE UNIQUE INDEX ... ON games (client_game_id)` line, and `initDb()` runs the whole schema file before the `ALTER TABLE ... ADD COLUMN` — on the existing production database `CREATE TABLE IF NOT EXISTS` is a no-op, so the index ran before the column existed. The fake-pool harnesses never run real Postgres, so this slipped through. Fix: the index line is removed from the schema file (server.js lines 141–142 already add the column and create the index idempotently, in the right order). No client change; the version stays v106.

## Shared engine extraction (offline-bots foundation, no visible change) v105 (Nov 15, 2026, cache v105)

- The pure game logic now lives in one shared file, `public/engine.js`, loaded by both Node (`require`) and the browser (`<script src="/engine.js?v=105">` via a UMD wrapper) — the foundation for offline bots (v106). Extracted verbatim from `server.js` by script (no hand transcription): the dictionary index build (`DICT_BY_LEN`/`FIXED_INDEX`, 1,377 keys), `findMoves`, `validatePlay`, `wordAt`, `scoreWord`, the bot pickers (`pickPersonaMove`, `pickCompetitiveMove`), think times (`personaThinkMs`, `personaThinkMsForMove`), `botSkillRates`, `COMMON_WORDS` (2,258), rack dealing (`drawLetter`/`drawRack`/`drawCapped`/`refillRack`/`drawVowel`/`drawConsonant`), `makePremiums`, `eloDelta`, `computeStats`, `gameStatsPayload`, and the board constants. `WORDS` is the only injected input — the server builds it from `data/words.txt` (fs) and passes it to `createEngine(WORDS)`; the client will pass its fetched set to the same factory in v106. `server.js` shrank from 2,732 to 2,014 lines and now just destructures the 13 names its game code calls (`makePremiums`, `emptyBoard`, `boardIsEmpty`, `validatePlay`, `findMoves`, the pickers, `drawRack`, `refillRack`, `eloDelta`, `gameStatsPayload`). The static-file allowlist now serves `/engine.js`; `index.html` loads it before `app.js`. Nothing about play, UI, or wording changed — `app.js` does not use the engine yet (that is v106).
- Verified with a new v105 parity harness (23/23 across three runtimes: the v104 server with the engine inline, the v105 server via `require`, and `engine.js` loaded browser-style through the UMD global — identical `findMoves` lists on four board states including a DUELLO rack, identical `validatePlay` verdicts and scores including a DUELLO bingo at +60, identical seeded picker/rack/premium outputs, `COMMON_WORDS` 2,258, identical Elo/stats payloads). The v90/v102/v104 server harnesses still pass in full (the v90/v102 harnesses needed a one-line fix each: `COMMON_WORDS` now comes from `engine.COMMON_WORDS` in their `__internals` export). The v93/v98/v102/v103/v104 client harnesses still pass except their own version-pin checks (expected — the cache is now v105).

## Stat window wording, centred pfps, "10 letter words" profile stat v104 (Nov 15, 2026, cache v104)

- The end-game stat window no longer says "pts" or "letters": Best word reads "AMEN (24)" and Longest word reads "REENACTING (10)" (app.js showStatWindow — the number is now wrapped in a .num span). Scoped to the stat window only; the Profile tab's "Highest word score (… pts)" / "Longest word (… letters)" lines were left alone. Side benefit: "REENACTING (10)" is shorter and should no longer truncate in the narrow stat box.
- The pfps in the stat window's score bar now sit level with the score instead of riding high. The score bar is a flex column (pfp + an .elo-move row below), and .elo-move has min-height 20px, so when the Elo move is blank — Fishstick games show no Elo change at all — the empty 20px row still took space and pushed the pfp ~12px above the score's centre. showStatWindow now hides a blank elo-move (classList.toggle('hidden', !textContent)), so it takes no space and that side's pfp centres vertically with the score. Persona/human games (both moves shown) are unchanged; a Competitive Bot game with a real delta keeps the human move shown and centres only the bot pfp.
- The Profile "Longest word" stat now becomes a count once the player has played a 10-letter word: it reads "10 letter words" with the count of unique 10-letter words played, and tapping it opens a list of them. The row looks like every other stat line (no link colour or underline). Implemented server-side in profileStatsFor (server.js): tenLetterWords (sorted, unique) and tenLetterWordCount, derived from stored game moves per scope (aggregate / vsBots / vsHumans), Fishstick-game words included the same as longestWord — no schema change. Client: renderStatsList swaps the line in when the count is > 0, and a tap opens #tenLetterModal (index.html, reuses the person-modal shell) listing the words. With no 10-letter word played the stat still reads "Longest word". Jeff approved the preview before this push; the fixes stay unproven until he confirms them in a real game.
- Offline bots (Jeff's fourth item): assessed, not built here. The client has zero dictionary/solver today — everything bot-related is server-side (findMoves over DICT_BY_LEN/FIXED_INDEX from data/words.txt, 138,752 words, 1.2MB; bot moves precomputed in scheduleBotMove; plays validated via /api/games/:id/validate). Offline needs the dictionary bundled on-device, the solver + scoring + bot pickers ported to the client and kept in sync with the server, the whole game run locally, and a sync-back step for Elo/stats. Jeff chose the scope Nov 15, 2026: iOS and web, offline games sync back and count. That build is next (v105).
- Verified with a new v104 server harness (7/7: unique count, sorted list, dedup, no short words, longestWord unchanged, fields on every scope, empty for a gameless user) and a new v104 client harness (17/17: stat-window wording with no "pts"/"letters", elo-move hidden when blank and shown when set, score still reads, profile row reads "10 letter words" with the count and no link styling, modal opens/lists/closes, "Longest word" stays when the count is 0, cache bumped to v104). v93/v98/v102/v103 harnesses still pass except their own version-pin checks (expected — the cache is now v104).

## Board tiles cover premiums, word borders never cover the number v103 (Nov 15, 2026, cache v103)

- Board tiles now cover the premium cell colour at the corners: the cell's border-radius was 5px while the tile's is 8px, so the premium colour showed as a small crescent at each corner (Jeff's screenshot: magenta at the corners of an A on a TW cell). `.cell` (style.css line 73) is now border-radius 8px, matching the tile; the inner-glow cell matches too (line 77). The tile fills the cell exactly, so this was a radius mismatch, not a size mismatch. CSS only — no JS or server change.
- The last-word highlight no longer crowds or covers the value number in the corner: it was a 2px ring drawn inside the tile (`.cell.last-word.tile::after`, inset 0), and the number sits only ~1–2px from that ring's inner edge. It is now a 1px white outline on the outside of the tile (style.css line 85: `.cell.last-word .tile{outline:1px solid #fff}`), so it cannot touch the number. The pending (gold) outline is 1px too (line 81: was 2px), so two adjacent outlines (1+1=2px) fit inside the 3px board gap without overlapping each other. Jeff approved the before/after preview before this push; the fixes stay unproven until he confirms them in a real game.
- Verified with a new v103 client harness (11/11 static CSS assertions: cell and tile radius both 8px and equal, last-word is an exterior 1px white outline with no inside ::after rule left, pending is 1px gold, adjacent outlines fit the 3px gap, cache bumped to v103). v93 and v98 client harnesses still pass except their own version-pin checks (expected — the cache is now v103).

## Persona common-word bias + weaker play, timeout recall, drag ghost over everything v102 (Nov 15, 2026, cache v102)

- Human bots (personas) now strongly prefer everyday words and play slightly worse. COMMON_WORDS grew from 402 to 2,258 words (every dictionary word from a ~1,900-word everyday-English list, filtered to the 2–10-letter dictionary; BASK was missing and is now in). pickPersonaMove (server.js): 85% of the time the pool is everyday words only — an obscure best play is only even considered 15% of the time; the best plays a persona can consider dropped to at most 3 (was 5) and grows 1 per 100 Elo above 900 (was 75); the reach widened (800 Elo: top 60%, 1000: top 40%, 1200: top 20%) so the single best move is picked far less often — a ~1130 persona picked the optimal move about half the time before. Elo still orders strength (a 1200 out-scores an 800 on average). Think time is UNCHANGED: personaThinkMsForMove still maps move quality to 7s (simple) / ~20s (average) / 33s (best). Verified with a new v102 server harness (10/10: common-word rate ≥75% and optimal rate <30% at 1130 over 2,000 picks, think times, Elo ordering) and the v90 server harness (13/13 — its P2/P3b now run 1,000 trials because the best play is rarer by design).
- Timeout glitch fixed: when your clock hits 0 with a tile placed, the tile used to stay on the board and the turn sat until a fetch round-tripped. Now tickClocks (app.js) recalls placed tiles and flips the turn to the bot locally the moment the clock hits 0 (within 100ms) — placements are client-only until Play, so this needs no server call — and the timeout fetch still fires to confirm it server-side. A `timeoutFlipUnconfirmed` flag retries that fetch if it fails, so a failed fetch can never stall the game on a locally-flipped turn. Verified with a new v102 client harness (17/17, including a real tickClocks run against stub DOM: tile recalled, turn flipped, board cell empty, rack shows the tile back, fetch fired).
- Drag glitches fixed: the drag ghost now sits above the point bubble (style.css: .drag-ghost z-index 30 → 60; the bubble is 50), so a dragged tile appears over everything. And the dragged tile no longer shows in the deck while dragging — the rack tile's opacity is 0 (was 0.35) while the ghost is up, so it looks like you are dragging that same tile; cleanup restores it on release/cancel. Verified in the same v102 client harness (drag scenario: opacity 0 while dragging, ghost up, tile back + ghost hidden on release).

## Portrait-only, picsum photos as no-photo, search keeps old results v101 (Nov 14, 2026, cache v101)

- Portrait lock (native, staged for TestFlight — NOT in this web push): `UISupportedInterfaceOrientations` in ios/App/App/Info.plist lost both landscape entries on iPhone and iPad (iPad keeps Portrait + PortraitUpsideDown). The web build cannot lock orientation — this only takes effect with the next TestFlight build. Staged in ~/workspace/duello-ios/; include ios/App/App/Info.plist in that push's manifest.
- Global users with no usable photo no longer sit as a blank grey circle: Sandra Cook is one of the 10 personas whose photo is a picsum URL, and picsum never loads — so she looked photo-less but her row rendered a stalling <img> with no blue border until the v99 3s timeout fired. New `usablePhoto()` helper (app.js): a photo counts only if present and not a picsum URL. pfpHTML, lbRowHTML, the profile modal, friend-request/challenge rows, scoreboard and stat-window pfps, and the profile/edit screens all use it, so a picsum persona renders the silhouette + blue no-photo ring at once, everywhere, and the img-vs-ring decisions can never disagree again. The 10 picsum URLs stay in the DB/personas.json (the client treats them as no-photo); randomuser photos and data-URL photos are untouched. The v99 3s timeout stays as the backstop for other stalls.
- Search no longer flashes the list away on every keystroke: runFriendSearch used to clear the results container first, then fetch. Now an empty query clears at once, but a real query keeps the last results up while the new fetch runs, and the new rows are built off-DOM in a fragment and swapped in one go. A sequence guard (friendSearchSeq) also stops a slow older reply from overwriting newer results. Verified with a new v101 client harness (31/31, including the real runFriendSearch against stub DOM: old results visible while fetching, stale reply ignored, empty query clears). No rule, clock, Elo, or dictionary changes.

## Fishstick +0 hidden, drag ghost higher v100 (Nov 14, 2026, cache v100)

- After a Fishstick match the stat window no longer shows the +0 Elo change: losing to the 3000-rated engine costs 0, so the +0 was noise, and Fishstick's own move was already blank — the human side is blanked too when the delta is exactly 0 after a Fishstick game (app.js: showStatWindow). A real move still shows: a draw (+16) or a win (+31). The scope is Fishstick only — a +0 draw against Competitive Bot still shows. The server Elo math is untouched; only the display hides.
- The drag ghost sits higher still: `translate(-50%,-75%)` → `translate(-50%,-90%)`, so the finger is right at the tile's bottom edge and the tile is essentially entirely above it. Drop logic is untouched — the drop cell is still the cell under the pointer. Verified with a new v100 client harness (23/23, including the real showStatWindow run against stub DOM: Fishstick +0 blank, Fishstick +16/+31 shown, Competitive −16 shown, persona both sides shown). No rule, clock, Elo, or dictionary changes.

## Tile bevel, drag finger position, deck shift, stalled leaderboard photos v99 (Nov 14, 2026, cache v99)

- Tile corners are rounder: `.tile` border-radius 5px → 8px (style.css:79), and the last-word white ring matches at 8px. Board cells stay 5px.
- Dragging a tile now puts your finger over its bottom quarter: the drag ghost's transform went from `translate(-50%,-60%)` to `translate(-50%,-75%)`, so ~75% of the tile sits above your finger. The ghost's own radius scaled to 12px (it's a 92px tile). Drop logic is untouched — the drop cell is still the cell under the pointer, so the offset is visual only.
- The deck and buttons sit 40px closer to the status line: `#gameScreen #gameDim>.controls{margin-bottom:40px}` — the auto margin above the rack absorbs 40px less free space, so the whole rack+buttons block shifts up and the space below the buttons grows by the same amount. The rack stays bottom-pinned and the stat-window buttons are unaffected (not #gameDim children).
- Some Global leaderboard photos weren't showing: 10 of the 100 personas use picsum URLs, and picsum is unreachable from some networks (verified Nov 14: every picsum URL times out, while randomuser.me answers in ~1s). A stalled photo never fires 'error', so the old handler never ran and the circle sat empty. New `armPfpTimeouts()` (app.js): a 3s timer on every leaderboard/search photo swaps any still-unloaded one for the silhouette, exactly as the error handler does — wired into renderFriendsUI and runFriendSearch. Loaded photos (data URLs, randomuser) are complete long before the timer and are left alone. Verified with a new v99 client harness (26/26, including a stalled-img scenario proving the swap and a loaded-img scenario proving no false swap). No rule, clock, Elo, or dictionary changes.

## Intro plays on every fresh open + instant profile pfp v98 (Nov 14, 2026, cache v98)

- The intro now plays on every fresh open: the once-per-device localStorage flag is gone (app.js, index.html head script, and the `.intro-seen` CSS rule all removed), so closing the tab and reopening replays it; tap-to-skip still works. The v97 logo-wait gate is unchanged.
- The Profile + Leaderboard preload now decodes the user's photo during the preload — an <img> inside a hidden screen is only decoded when the screen shows, so the warmed image paints instantly when the Profile tab is tapped (app.js: preloadHomeTabs). The preload itself stays idle-scheduled (v93 design, 2s bound); the intro now gives it a 3.4s head start, so the photo is decoded before the intro even finishes. Same photoData feeds the leaderboard row, so that row is covered too. Verified with a new v98 client harness (27/27, including a plays-again scenario with the old flag preset and a pfp-preload scenario proving the photo is decoded) and the v93 harness (32/33 — only its v93-pinned version check fails). No rule, clock, Elo, or dictionary changes.

## Intro zoom-out waits for the logo v97 (Nov 14, 2026, cache v97)

- The initial zoom-out (logo 3x → normal) was invisible: the zoom ran the moment app.js loaded, but the 2.6 MB logo PNG can still be downloading/decoding during those first 400ms, so the logo popped in at normal size after the zoom had already finished. The zoom-out now waits for the logo image to load (or error), with a 1.5s backstop so a slow or broken image never stalls the intro; the 2s sit and the zoom-in are timed from the zoom-out, not from page load (app.js:210). A late logo load after a tap-to-skip cannot restart the intro. Verified with a new v97 client harness (25/25, including a logo-still-loading scenario proving the intro waits) and the v93 harness (32/33 — only its v93-pinned version check fails). No rule, clock, Elo, or dictionary changes.

## First-open intro animation v96 (Nov 14, 2026, cache v96)

- First app open now plays a ~3.5s intro, once per device (localStorage `duello_intro_seen`, set when it finishes or is skipped; tap the overlay to skip): the real logo (`assets/logo.png?v=2`) starts zoomed in 3x, pulls back to normal in 400ms, sits 2s, then zooms in fast (scale 8, 650ms) as the overlay fades to reveal Home. Behind it, 20 premium-colour squares (DL red, TL green, TW magenta, DW orange) flicker on/off across the whole background, each jumping to a new grid cell per cycle — never overlapping, never in neighbouring cells, same colour kept further apart. Markup in index.html:5 (inline flag check in <head>, :4, so repeat visits never flash it), styles in style.css:369, sequencing + placement in app.js:134 (WAAPI calls guarded so the client harness vm, which has no Element.animate, still boots). The chat previews used vector tiles because the widget flattens transparent PNGs; the shipped intro uses the real logo file, which renders transparent in the app. Verified with a new v96 client harness (21/21: version bump, real-logo markup, placement rules, seen-gate, skip, lifecycle) and the v93 harness (32/33 — only its v93-pinned version check fails, as expected after a bump). No rule, clock, Elo, or dictionary changes.

## No grey disc behind Fishstick v95 (Nov 13, 2026, cache v95)

- The transparent Fishstick PNG was still sitting on the grey `#3a3f4b` pfp disc, so the pfp containers go transparent for Fishstick only: a `clear-bg` class on the scoreboard pfp (app.js:1102), the stat-window top pfp (:2001), and the stat-grid box pfp (via a 5th `clearBg` arg on `box()`, :1986/:1993), with one CSS rule covering all three (style.css:61). Photos, silhouettes, and the robot keep their grey disc. No rule, clock, Elo, or dictionary changes.

## Fishstick goes transparent v94 (Nov 13, 2026, cache v94)

- The Fishstick character is a transparent PNG now (`public/assets/fishstick.png`, 1600x1600 RGBA): the smart fish with gold professor glasses was cut out of its dark JPEG background with rembg (u2net model — the default bria model is 1.02 GB and got OOM-killed on this VM), verified clean on the panel colour with no glow haze. The scoreboard pfp, the game-screen bot pfp, and the stat-window pfp all point at `fishstick.png?v=1` (app.js:1091, :1990, :1993) so the fish floats on the panel instead of sitting on a dark disc. The old `fishstick.jpeg` is deleted from the branch — nothing references it anymore. No rule, clock, Elo, or dictionary changes.

## Game screen safe area + common-sense definitions + pfp fallback + background tab preload v93 (Nov 13, 2026, cache v93)

- Game screen clears the Dynamic Island and pins the rack to the
  bottom: the old `#gameScreen{padding:4px 10px 12px}` overrode
  `.screen`'s safe-area padding, so the logo slid under the island,
  and the screen was only as tall as its content, leaving a dead gap
  below the buttons. The screen is a full-height flex column now
  (`min-height:100vh/100dvh/100svh`, svh last so the height stays
  stable when Safari's toolbar hides), top padding
  `calc(4px + env(safe-area-inset-top))`, bottom padding
  `calc(12px + env(safe-area-inset-bottom))`, `#gameDim` flexes to
  fill, and `#rack` has `margin-top:auto`. Board, scoreboard, and
  controls are otherwise unchanged; the stat window, definition
  popover, and drag ghost are `position:fixed` so the column only
  lays out the game itself.
- Definitions default to the most common sense. Measured Nov 13:
  the bundled set mixes three sources — WordNet base file (43,256
  entries), Webster's 1913 extras a-c (18,396, ~950 with [Obs.]/
  [Prov.] tags), Wiktionary-dump extras d-g (22,925, modern first
  senses) — and a bundled entry holds a single gloss that is often
  a rare sense (RUN: the baseball score; CRANE: the writer Stephen
  Crane). `DEFS_SRC` now records each entry's source at load.
  A Wiktionary-bundled entry is still served instantly with no
  network; for a WordNet/Webster's entry the live chain gets the
  first try (dictionaryapi.dev, then Wiktionary REST, both
  most-common first) and the bundled gloss is the fallback when the
  network has nothing better. The live fetchers now scan all
  meanings/senses for the first gloss that is real, whole, and not
  circular ("To run." is skipped as a restatement of the word),
  and when both live sources land, a whole sense beats a chopped
  one. Morphological live forms resolve to the core's live sense
  first (RUNS -> the running sense). The response is still just
  {word, pos, definition} — the source marker stays server-side.
  First tap on a WordNet/Webster's word now waits on one live
  round-trip (usually ~100-400ms, cached after); Wiktionary-bundled
  words stay instant.
- Cut-off definitions are fixed two ways, keeping the one-sentence
  ≤140-char rule: when several senses are available the fetchers
  prefer one that fits whole over chopping a long one, and when a
  cut is unavoidable `shortenDefinition` ends the result with an
  ellipsis (…) inside the cap, so it reads as shortened on purpose
  instead of breaking off mid-thought.
- Opponent pfp no longer becomes a "?": persona photos are remote
  URLs, and when one fails to load Safari paints its broken-image
  glyph inside the circle. A single capture-phase error listener
  (img errors do not bubble) now swaps any failed photo inside a
  `.pfp` / `.lb-pfp` / `.person-pfp` for the inline silhouette,
  which cannot fail or loop, and adds the `no-photo` ring. The logo
  and other images are untouched. `.person-pfp svg` and
  `.pfp.huge svg` sizing rules were added so the fallback fills
  those circles too. The static scoreboard placeholders are emoji
  (👤/🤖), never "?".
- Profile + Leaderboard preload in the background from Home: the
  first Home render idle-schedules `renderProfileUI`,
  `ensureGlobalRows`, and `loadServerFriends` (sequential, so the
  friends load's internal Global-rows fetch cannot double-fetch),
  so both tabs are instant when tapped. The v74 load-once guards
  still hold — a later tap never refetches. A session check runs
  first, so a dead token can never bounce the user to sign-in from
  a background load, and any preload failure is silent (the tab
  just loads normally on tap). Nothing preloads before sign-in.
  `renderProfileUI` accepts the pre-check's `/api/me` payload so
  the profile is not fetched twice at boot.
- Tests: server vm 31/31 (duello-v93-server-test.js: source map
  counts, RUN returns the movement sense with the circular gloss
  skipped and no src marker in the response, Wiktionary-bundled
  BRO costs zero fetches, live beats the WordNet gloss, Webster's
  and stemmed WordNet fallbacks still serve, RUNS resolves to the
  running sense, the fallback still works, a long first sense
  gives way to a short whole one, an unavoidable cut ends with …
  inside the cap, shortenDefinition unit cases incl. the 140-char
  boundary, and /api/define serves the fixed RUN sense over HTTP).
  Client vm 33/33 (duello-v93-client-test.js: cache bump, game
  screen safe-area + full-height column + rack pinned, fallback
  silhouette sizing, Home shows, preload idle then exactly one
  load each for profile/rank/leaderboard/friends, both tab taps
  refetch nothing, failed pfp photo swaps to the silhouette with
  the ring while a non-photo image is untouched, static
  placeholders are emoji, and no preload before sign-in).
  Regressions still passing (v91 server 10/10 — its S6 updated
  for the deliberate ellipsis change and its sandbox given the
  AbortController the vm context lacks, so S8 now genuinely
  exercises the live path instead of passing vacuously on the
  fallback; v92 client 16/16 with its cache assertion moved to
  v93; v89/v90 client).
- Nov 13, 2026, after the v93 push: primary logo replaced with the
  6000 × 1552 px transparent rebuild of the same artwork (smoother
  corners, no design change) and Fishstick got a new character — the
  same round Duello Blue fish, now with gold professor glasses.
  Both assets cache-busted (?v=2 on the logo and fishstick refs) so
  browsers pick up the new images.

## Profile photo crop v92 (Nov 13, 2026, cache v92)

- Picking a photo on the Edit profile screen now opens a crop step
  instead of saving the photo as-is: a circular viewport (what you
  frame is what every pfp shows — they all display round), drag to
  move, a slider to zoom 1x–3x, Cancel or Use photo. The old
  shrink-only path (`shrinkPhoto`) is gone; the crop output is a
  512x512 JPEG under the same 750KB cap, with the same "too large"
  last-resort error. Cancel keeps the previous photo, and the file
  input is cleared so picking the same file again still opens the
  cropper.
- Tests: client vm 16/16 (duello-v92-client-test.js: modal markup +
  cache bump, base scale, clamp bounds, cropper opens on pick,
  drag delta with vertical clamp, zoom scaling, Use photo draws
  the framed square to 512x512 with the right source rect, preview
  + remove button, reopen + Cancel keeps the old photo).
  Regressions still passing (v89/v90 client).

## Short one-sentence definitions v91 (Nov 11, 2026, cache v91)

- The bundled definitions were already short (median 44 chars,
  max 140, essentially one phrase each) — the long ones came from
  the live lookups, which cover the 54,175 words with no bundled
  definition and can return multi-sentence Wiktionary / dictionary
  glosses. New `shortenDefinition` in getDefinition, the single
  funnel for every served definition (bundled and live): keep only
  the first sentence (the core sense), and cut a first sentence
  that still runs long to its first complete clause under 140
  chars (the longest bundled definition), otherwise to a word
  boundary. Abbreviations (e.g., i.e.) never split a sentence, and
  a gloss with no terminal punctuation is kept whole. The cached
  live result is the shortened one.
- Tests: server vm 10/10 (duello-v91-server-test.js: first
  sentence only, clause cut, short phrase unchanged, e.g. does not
  split, one sentence kept, word-boundary cut, empty stays empty,
  a stubbed live lookup and the /api/define HTTP path both serve
  the shortened gloss, a bundled word is unchanged). Regressions
  all still passing (v86/v88/v90 server, SSE server, countdown
  server, v85-v90 client, SSE client/echo, e2e playtest 13/13).

## Persona think + skill, definition popover position v90 (Nov 11, 2026, cache v90)

- Diagnosis first: the think/skill correlation was NOT broken — the
  solver sorts by score, so the best-common denominator was correct
  as coded. What made personas feel bad was the pool: the extreme
  common-word bias meant even a 1135 only ever played everyday
  words, and a 33s think meant "near the best everyday word", not
  "near the best play on the board". So a long think could produce a
  move that looked weak.
- Pool: everyday words plus the very best plays on the board — how
  many of those best plays a persona can even consider grows with
  Elo (none at 800, one more per ~75 Elo above 900, up to 5). A
  low-Elo persona still only knows everyday words; a high-Elo one
  finds the big plays too. The Elo reach applies to the combined
  pool as before.
- Think: now measured against the best play on the board, so a
  33s think genuinely means a near-best play and a 7s think a
  filler.
- First move: a persona's first move of the game is quick — 5-11s,
  averaging 8s — instead of a full 7-33s think.
- Floor: a persona never moves in under 3 seconds, even at the
  end. Both think functions floor at 3000ms (final move and the
  clock-capped think), and advanceBotTurnIfReady gates the turn
  itself (turn start recovered from botThinkUntil - botThinkMs,
  since turnStartedAt drifts on every settleClock), so the poll
  tolerance cannot play a short think early either. If the clock
  cannot hold 3s, the move is skipped — the clock ran out.
- Definition popover: it was `position:fixed; bottom:120px`, which
  put it over the last board row on a phone (Jeff's screenshot:
  the Y tile half-hidden behind it). showDefinition now anchors
  its top 6px below the board's bottom edge (measured live), so
  the board stays fully visible; it may cover the status line and
  the top of the rack while open, and the next tap dismisses it.
  hideDefinition clears the inline position.
- Tests: server vm 13/13 (duello-v90-server-test.js: 800 plays
  everyday words only, 1200 reaches the best plays, 1000 still
  plays everyday words and sometimes finds the best, think 33s /
  20s / 7s by move strength, 3s floor on a short clock and on the
  final move, the turn gate blocks a move before 3s and lets it
  play after, first move over HTTP 5-11s), client vm 6/6
  (duello-v90-client-test.js: popover opens below the board, the
  fixed offset is cleared, hide clears the position, v89 tap
  rules still hold). Regressions all still passing (v85/v86/v87/
  v88/v89 client, SSE client/server, SSE echo, countdown server,
  v86/v88 server, e2e playtest 13/13).

## Definition popover: no citation, tap-to-dismiss v89 (Nov 11, 2026, cache v89)

- Citation: the popover no longer carries the "Definitions via
  Wiktionary (CC BY-SA)" line. The Wiktionary-derived definitions
  still need a credit under their licence, so the line moved to the
  bottom of the profile edit (gear) screen, out of the way.
- Tap behaviour (reverses the same-tap rule from the original
  definition work): when the popover is open, the first tap
  anywhere else — including on another played word — only hides
  it. A second tap on a word opens that word's definition. The
  tile's pointerdown now returns early while the popover is open
  and sets `defJustOpened` when it opens one, so the document
  pointerdown listener (which hides the popover on any outside
  tap) skips the single event that just opened it instead of
  hiding it at once. Taps on the rack / empty cells still hide
  the popover and place/select as before.
- Tests: client vm 8/8 (duello-v89-client-test.js: open on tap,
  no citation in the popover, first tap on another word only
  hides, second tap opens it, tap elsewhere hides, credit on the
  settings screen). Regressions all still passing (v85/v86/v87/
  v88 client, SSE client/server, SSE echo, countdown server, v86/
  v88 server, e2e playtest 13/13).

## TestFlight API + safe-area v88 (Nov 11, 2026, cache v88)

- The iOS shell serves the app from capacitor://localhost, so the
  two web assumptions broke: relative /api/... resolves against
  the local file, and the browser blocks the cross-origin API
  calls without CORS headers. Fix, both sides:
  (1) Client: a single `API_BASE` — 'https://duellogame.com'
  when `window.Capacitor` is present, empty on the web — prefixes
  every API call: the `api()` helper (all fetch calls), the
  EventSource stream URL, and the /api/words fetch.
  (2) Server: CORS headers (`Access-Control-Allow-Origin: *`,
  Allow-Headers Authorization/Content-Type, Allow-Methods
  GET/POST/OPTIONS) on every JSON response via sendJson, on the
  SSE stream and the /api/words responses, plus an OPTIONS
  preflight branch answering 204. Auth is a Bearer token (no
  cookies), so the wildcard origin is safe. Web behaviour is
  unchanged (same-origin requests ignore the headers).
- Safe-area: `viewport-fit=cover` on the viewport meta, and the
  insets wired in — screen top padding gains
  env(safe-area-inset-top) (clears the notch/Dynamic Island), the
  tab bar's bottom padding and the screen's bottom clearance gain
  env(safe-area-inset-bottom) (clears the home indicator). On
  desktop env() is 0, so the layout is byte-identical there.
- Tests: server vm 8/8 (duello-v88-server-test.js: preflight,
  ACAO on JSON/words/SSE, web unchanged), client vm 4/4 in both
  modes (duello-v88-client-test.js: shell run uses absolute URLs,
  web run stays relative). Regressions all still passing (v85/v86/
  v87 client, SSE client/server, SSE echo, countdown server, v86
  server, e2e playtest 13/13).

## Rematch accept closes the old stat window v87 (Nov 9, 2026, cache v87)

- After a game ended, @ceo challenged @neo to a rematch; @neo
  accepted, but the countdown started over the last game's stat
  window. The stat window is a top-level overlay, not part of any
  screen, so show('gameScreen') left it up — and the countdown
  overlay (z-index 15) sits above it (z-index 10), so the numbers
  counted down over the old stats. The challenger's side was fine
  (Play Again hides the window first); the recipient's Accept path
  went straight to enterGameScreen, which never hid it.
  enterGameScreen — the one shared entry for every game start —
  now hides the stat window and lifts the board dim, so accepting
  looks like the start of any game. Client vm test 7/7
  (duello-v87-client-test.js: human rematch + bot Play Again).
  Regressions all still passing (v85/v86 client, SSE client, SSE
  echo, countdown server, v86 server, e2e playtest).

## Played word pulled back, rack refill in place, first-name challenge, forfeit average v86 (Nov 9, 2026, cache v86)

- A played word appeared on both screens for a second, then was
  pulled back: a poll GET that loaded before a play could save its
  stale snapshot over the play. The GET's settle work runs findMoves
  (seconds on a busy board), so it loads, waits, then saves the
  pre-play state — clobbering the play and broadcasting the revert
  to both phones. Fix is optimistic concurrency: every save bumps a
  `version` on the game state, and the GET's settle save is guarded
  (`UPDATE ... WHERE id=$2 AND COALESCE((state->>'version')::int,
  0)=$3`) — on a conflict it returns the freshly loaded row
  instead, so the play survives. Plays, passes and forfeits save
  unguarded (the move itself is the newer fact). Old games without a
  version migrate on first save (COALESCE treats missing as 0).
  Proven in the vm: two loads of one game, first guarded save
  lands, second is rejected; a stale save after a play is rejected
  (duello-v86-server-test.js 11/11).

- The rack did not refill in place for the recipient: applyMove's
  bot-side branch spliced the played letters out and appended new
  ones, shifting every unplayed tile left after every play (and the
  vowel/consonant floor fix then swapped one of the survivors out).
  That side is the recipient's rack in a real 1v1, so it was Jeff's
  rack moving after every one of his plays. Both sides now use
  refillRack on the exact vacated indices — unplayed tiles never
  move. Verified in the same server test (rack [A,B,C,N,E,F] after
  playing D from [A,B,C,D,E,F]).

- The challenge invitation reads "[first name] challenged you" now
  — no last initial — in the window and on the Friends page row
  (both used shortName, which gives "Neo S."). Falls back to the
  username when there is no first name. Client vm test 5/5
  (duello-v86-client-test.js).

- A forfeit counts as a game played but never toward the average
  game score: the average already excluded games ended early, but
  it let a forfeit in when the forfeiter's clock had already hit 0.
  The average loop now skips `reason === 'By forfeit'` outright;
  gamesPlayed and the loss still count. Server vm test
  (duello-v86-server-test.js R8/R9).

- Regressions all still passing: v85 client, SSE client/server,
  SSE echo, countdown server, and the end-to-end playtest (13/13).

## Hard challenge modal, SSE echo no longer returns placed tiles, synced 5s countdown v85 (Nov 9, 2026, cache v85)

- The challenge window is a hard modal now: the × is gone and
  tapping outside it does nothing — the only way out is Accept or
  Decline (or the challenger cancelling, which still closes it on
  its own). The profile window keeps its own ×; only the
  invitation is forced. `dismissedChallenges` is removed.

- The v83 SSE echo was returning placed tiles: the deferred-optimal
  save re-broadcasts the state seconds after a play (and a reconnect
  re-sends the current state), and the stream handler wiped `pending`
  on every event — so a word placed after a play came back to the
  rack a few seconds later. The handler now skips pushes while a
  Play is in flight, ignores an echo of the state it already has
  (same board, scores, turn, status, rack, countdown, started),
  and only returns placed tiles when the game is over or it is no
  longer the player's turn (a timeout flip, a pass). Reproduced in
  the vm first (the echo cleared pending), then fixed: 6/6 in
  duello-sse-echo-test.js.

- The 5-second countdown is synced for both players in a real 1v1:
  each player's first GET of a fresh human game checks them in, and
  the second check-in stamps `countdownEndsAt` (now + 5s) and
  broadcasts it, so both phones count down to the same instant.
  The client receives it as a RELATIVE `countdownRemainingMs`
  (server-computed, like botThinkRemainingMs) — no phone/server
  clock comparison, per the v78 skew lesson. While waiting, the
  overlay reads "Waiting for {firstName}…"; if the other player
  never loads in, the countdown starts on its own after 15s; a
  late join (game already started) skips the countdown entirely.
  Bot games keep the old local 5-second countdown at once. Server
  vm test 9/9, client vm test 12/12 (duello-countdown-server-test.js,
  duello-v85-client-test.js). The stream handler's echo check also
  compares countdownRemainingMs/started, so the waiting player
  actually learns the countdown started.

- Includes v84 (still unpushed): real bundled definitions for
  23,478 words, shuffle always available, Forfeit becomes Exit
  when out of time.

## Shuffle always available, Forfeit becomes Exit when out of time v84 (Nov 8, 2026, cache v84)

- Push PENDING: first push attempt Nov 8, 2026 — approval timed
  out, action NOT performed, live stays v83. Re-push only on
  Jeff's explicit go.

- Shuffle is available at all times during the game now: the
  button used to grey out for the whole Play round-trip (and when
  out of time), which felt like seconds. It is never disabled
  during the game any more. While a Play is in flight the rack has
  blank slots, so a server shuffle would be rejected for not
  matching the server rack — the tap instead shuffles only the
  letters still in the rack, locally, keeping the blanks where
  they are; the Play reply refills the rack and takes over from
  there. Otherwise it posts the shuffled rack as before.
- After your time expires the Forfeit button reads "Exit". The
  opponent plays on, but you can leave without waiting: tapping
  Exit still forfeits on the server (you lose, Elo moves), it just
  skips the stat window and goes straight to the main menu. The
  two-tap arm ("SURE? you lose") still applies, and the label
  resets to "Exit" (not "Forfeit") if the arm times out while out
  of time. Forfeiting with time left is unchanged (stat window
  still shows).
- The definition popover now carries a small Wiktionary
  (CC BY-SA) credit line, since the definitions (bundled and live)
  come from Wiktionary.
- Real definitions for the words that showed "A valid Duello
  word.": the Kaikki Wiktionary dump (534 MB gz) was filtered to
  just the 25,532 uncovered words — 23,478 gained a bundled
  definition (22,925 direct, 553 more via stemming of the new
  ones), in new chunks definitions-extra-d/e/f/g (each under
  0.7 MB) added to the server's chunk list. Bundled definitions
  went from 61,879 to 84,577; 2,054 words remain uncovered (no
  published gloss in Wiktionary, e.g. JADITIC, PLISKIE, ZINKIFY —
  those honestly keep the fallback). Morphological glosses were
  resolved to the core word's definition at build time, per Jeff's
  rule. Verified independently: 26/27 previously-failing spot
  checks now resolve, chunks are valid with 0 bad entries, and
  the subagent's own verify script passed 49/52 (the 3 failures
  are the no-gloss words above). The dump file was deleted after
  the build. Follow-up (not in v84): the server's runtime
  coreWordFromDef regex misses some Kaikki gloss shapes ("simple
  past and past participle of X", "third-person singular simple
  present indicative of X", "present participle and gerund of X",
  "comparative/superlative form of X", "alternative/obsolete/
  archaic spelling of X", ~6,100 of them) — the build script
  resolved those at build time, so the stored chunks are clean,
  but a live-fetched gloss in one of those shapes would still
  show as-is instead of resolving to the core word.
- Vm harness on the real app.js: 21/21 checks pass (shuffle
  during a Play flight is local-only with blanks kept, normal and
  out-of-time shuffles post, Exit records the loss with no stat
  window and lands on home, a normal forfeit still shows stats).

## Challenge window on any tab, Play Again sends a request, stale-fetch kick-back fix v82 (Nov 8, 2026, cache v82)

- Pushed live Nov 8, 2026 (commit eae0efad, verified both
  domains, served app.js + style.css byte-match local).
- A challenge now pops up as a window wherever you are (Home,
  Profile, Bots, Global), not only on the Friends page. The 5s
  incoming-challenge poll runs on every screen (it used to wait
  for the Friends page); one fetch per cycle serves both the
  Friends-page rows and the window. Accept joins the game (and
  withdraws any outgoing challenge you are waiting on, so its
  accept can never strand you in a second game); Decline ends it;
  × dismisses it (it stays on the Friends page but never pops up
  again). One window at a time; a second challenger waits until
  the first is answered. If the shown challenge is no longer
  pending (challenger cancelled), the window closes on its own.
  While you are in a game the window waits: showStatWindow
  checks again at game end, so it pops up at once instead of on
  the next poll.
- Play Again after a real game now sends a challenge request from
  the stat window too: both Play Again buttons share one
  playAgain() that challenges the same opponent for human games.
  The stat window's button used to call startGame directly, which
  the server rejects for real games — so it silently did nothing.
- The move-kicked-back glitch is back, and v81's fix missed the
  real hole: its playInFlight check only catches a stale fetch
  when the Play is still in flight, but the Play POST is usually
  faster than a slow GET, so a fetch sent before a Play that
  returns after the reply still overwrote the board with the
  pre-play snapshot. Every game-state read (poll, timeout fetch)
  is now stamped with a sequence number, and a response is only
  applied if no newer state has been applied since it was sent; a
  Play / Pass / Forfeit reply, and entering a game, invalidates
  every fetch sent before it. Vm harness on the real app.js:
  17/17 checks pass (stale pre-Play poll dropped, fresh poll
  applies, overlapping polls resolve to the later one, modal
  gates).

## Game screen stays phone-width on desktop v80 (Nov 8, 2026, cache v80)

- Pushed live Nov 8, 2026 (commit 8028de1c; verified both
  domains, served app.js + style.css byte-match local). The only
  remaining "max-width:none" in the served CSS is inside the new
  comment explaining the removal.

- The game screen overrode the app's 390px cap with
  max-width:none, so on a computer the board stretched to the full
  viewport and looked huge and weird, while the profile, home and
  leaderboard tabs (all capped at 390px) were fine. The override
  is gone: #gameScreen now inherits .screen's max-width:390px and
  margin:0 auto, keeping its own tighter padding. On a phone
  nothing changes (the viewport is already at most 390px wide);
  on a computer the board, rack, controls and scoreboard sit in a
  centred 390px column, exactly like the other screens. The
  overlays (stat window, definition popover, drag ghost) are
  position:fixed and already phone-width, so the cap does not
  touch them.

## Waiting status keeps the opponent's name v79 (Nov 8, 2026, cache v79)

- Pushed live Nov 8, 2026 (commit 97e84d0f; verified both
  domains, served app.js + style.css byte-match local,
  waitingStatus present in served JS).

- The status flipped between "Waiting for {name}." and "Waiting
  for your opponent.": beginBotTurn wrote the named version, but
  updateStatus (every render) and doPlay (after every tap) each
  wrote their own generic copy, overwriting it. One helper,
  waitingStatus(), is now the only source, used by all three:
  a persona's or real player's first name, Fishstick by name, and
  the Competitive Bot keeps the generic line (it has no name).
  "Out of time, opponent plays on." still wins when the human clock
  is at 0. Verified with a 6-case check (persona, real player,
  Fishstick, Competitive Bot, human clock at 0, persona with no
  name) — all pass.

## Persona skill matches Elo, think back to 7-33s v78 (Nov 7, 2026, cache v78)

- Pushed live Nov 8, 2026 (commit 19f2e657; verified both
  domains, served app.js + style.css byte-match local). First push
  attempt's approval timed out before Jeff tapped it; re-pushed on
  his explicit "Push" and approved.

- Personas were too good: the old pick tiers (top 5 / top 3 / best
  among common words) all sat within the top few moves, so every
  persona played near-optimally and Elo barely mattered.
  pickPersonaMove now reaches deeper into the pool at low Elo, so
  the Elo on the profile actually predicts how strong the moves
  are: 800 Elo reaches the top half, 1000 the top quarter, 1200
  the top few, uniform pick within the reach. Measured on a
  realistic steep score distribution (best 40): an 800 picks
  ~20pts on average, a 1000 ~27, a 1070 ~30, a 1200 ~38.5 — and an
  800 sometimes plays a genuinely weak word (~40% of picks at or
  under 15pts), while a 1200 never does. Competitive Bot and
  Fishstick are untouched; this is personas only.
- Think time is back to the 7-33s envelope averaging ~20s, now
  correlated with move strength instead of uniform random (this
  supersedes v77's 3s + 0.45s/point curve, which made weak moves
  too fast and strong ones not slow enough): the easiest play comes
  after ~7s, the hardest after ~33s, a mid-strength play ~20-22s.
  Strength is measured against the best common-word move the
  persona would consider, so the full range gets used. The 5s
  placeholder think and the final-move clock timing are unchanged,
  and the think is still capped at 1s inside the remaining clock.
  Tested with a vm harness against the real server code: 16
  checks, all pass (placeholder 5000ms, final move leaves 1-8s,
  think 33s/20-22s/9-11s/7-9s by strength, clock cap, pick
  gradient by Elo, 1200 never weak, empty moves null). The harness
  also caught a floating-point edge at exactly 1200 Elo (reach
  0.050000000000000044 pushed the pool depth from 2 to 3); the
  reach is now rounded to three decimals.

## Opponent timeout, persona think, profile fonts + rank v77 (Nov 7, 2026, cache v77)

- Pushed live Nov 7, 2026 (commit b6148591; verified both
  domains, served app.js + style.css byte-match local,
  handleTimeoutFetch and profileGlobalRank present in served JS).

- Opponent ran out of time and the turn never came: tickClocks only
  fetched when the human clock (or both clocks) hit 0, so on the
  opponent's turn the flip waited for the next scheduled poll — up
  to a 30s persona think. Now the clock tick fetches at once when
  the opponent's clock hits 0 (handleHumanTimeout renamed
  handleTimeoutFetch, same fetch, used for both clocks), so the
  server flips the turn within ~1s. The server flip itself was
  already correct (GET while-loop); the client just never asked.
- Personas now think in proportion to the move: personaThinkMs
  returns a short 5s placeholder, and scheduleBotMove revises the
  think from the picked move's score (personaThinkMsForMove) once
  the solver has it — a 2-point filler like IT thinks ~4-7s, a
  10-pointer ~8-11s, a 20-pointer ~12-15s, a 40-pointer ~21-24s,
  capped at 30s, with a few seconds of jitter. The think is also
  capped at 1s inside the remaining clock, so a long think can
  never forfeit the move. The final move (clock under 20s) keeps
  its clock-based timing and is never revised. Tested with a vm
  harness against the real server code: 8 checks, all pass
  (placeholder 5000ms, final move leaves 1-8s, think rises with
  score, 30s cap, clock caps).
- Profile stats numbers are Comfortaa now: `.stats-list .num`
  overrides the Arial numbers rule, scoped to the stats list only.
  Every other number (clocks, scores, leaderboard Elos, Elo row,
  Joined line) stays Arial.
- Global Rank is above the chart on the profile tab: the Elo row
  now reads Elo / All-time high / Global Rank left to right
  (middle cell centred, last cell right-aligned). The rank is
  shown from the v75 rankCache at once when cached, else fetched
  once from /api/users/rank and cached, like the profile modal.

## Real-player challenges v76 (Nov 6, 2026, cache v76)

- Pushed live Nov 6, 2026 (commit 41e2ac32; verified both
  domains, served app.js + style.css byte-match local,
  liveChallengeId present in served JS). First push attempt's
  approval timed out before Jeff tapped it; re-pushed on his
  explicit "Push" and approved.

- The friends backend now delivers real challenges: tapping
  Play on a friend's profile (or Play Again after a real game)
  sends a live challenge; the recipient sees it at the top of
  their Friends page (above the friend requests, polled every
  5s while the page is open) and accepts or declines there.
  Accept creates the game, both players join through the same
  5s countdown. The challenger waits up to 60s, polling every
  2s; decline, Cancel, timeout, or navigating away withdraws
  the challenge, and stale pendings expire server-side after
  5 minutes.
- A real game reuses the bot-game state with bot_type 'human'
  (challenger = 'human' side, recipient = 'bot' side, new
  games.opponent_id column). serializeGame flips racks, scores,
  clocks, turn, last plays, and Elo deltas per viewer, so the
  whole client renders unchanged and neither player ever sees
  the other's rack. No bot think is ever armed for a human game;
  the opponent polls every 2s instead of the think cadence.
- Both Elos move at the end (standard K=32 zero-sum, challenger
  perspective, elo_history rows for both); profile stats count
  real games for both players (vsHumans scope) from each
  player's own side; the stat window flips per viewer and shows
  both Elo moves; Play Again sends a fresh challenge.
- Server rules: challenges only go to accepted friends; one
  pending challenge per pair; POST /api/games rejects bot
  'human' (real games only start from an accepted challenge).
  Tested with a vm harness against the real server code
  (28 checks: newGame model + no think, both serialize views,
  stats flip, gameSides, Elo deltas, applyBotNoMovePass pass /
  has-move / full-board paths — all pass). Not yet phone-tested
  end to end: the @ceo <-> @neo accept flow still needs Jeff's
  two-account check.

## Profile Global Rank shows at once v75 (Nov 6, 2026, cache v75)

- Opening a profile used to show '—' for Global Rank until
  a /api/users/rank round-trip came back, on every open.
  Now it shows at once whenever the rank is already known:
  Global leaderboard rows carry the server's true rank, so
  the modal uses it straight off the row (same for the
  search fallback, whose rows carry the leaderboard rank);
  any rank fetched once sits in a session cache, so a second
  open of the same profile is instant too.
- Friends' ranks are warmed in the background when the
  Friends list renders (small list, once per render, cached
  names skipped), so opening a friend's profile is instant
  as well. First opens from search or the stat window still
  fetch once, then cache.
- The cache clears when a game ends (stat window) and when
  leaving to home, because Elos — and therefore ranks —
  move then. Verified with a test run of the resolution
  logic: Global tap instant, friend/search first open
  fetches once and the second is instant, a game end makes
  the next open fetch fresh again.

## Tabs load once and stay loaded for the session v74 (Nov 6, 2026, cache v74)

- The Profile tab no longer blanks and refetches /api/me on
  every tap: it renders once and the tab just shows the
  screen again. The Friends tab likewise keeps its rendered
  list — a tab tap is a no-op when the same scope is already
  shown and nothing changed. Home and Bots already only
  showed their screens, so nothing changed there.
- The cache invalidates exactly where the app itself knows
  the data changed, so nothing goes stale: finishing a game
  (goHome's refresh) clears the cached profile and forces
  the friends refetch; accepting, declining, removing, or
  sending a friend request forces a refetch; the pencil and
  the remove confirm mark the list stale; switching Friends
  / Global scope always renders the other scope; signing
  out, deleting the account, or a dead session wipes the
  cached screens. Saving a profile edit still refetches,
  as before. Verified with a state-machine test run: repeat
  tab taps skip, scope changes, pencil toggles, forced
  refetches, and sign-out wipes all render.

## Leaderboard ties share a rank v73 (Nov 6, 2026, cache v73)

- Ties now share a rank, and the next rank skips ahead:
  two players tied at 19 are both 19, and the next
  player is 21. Fixed in all three places ranks are
  made: the Global leaderboard SQL went from ROW_NUMBER
  (a distinct rank per row, ties broken by created_at)
  to RANK() over Elo desc; the profile rank endpoint
  counts only players strictly ahead instead of also
  counting earlier-created players at the same Elo; and
  the Friends list (ranked client-side) assigns the
  shared rank the same way. Verified with Jeff's exact
  case in a test run: 19 / 19 / 21, and a 3-way tie at
  the top gives 1 / 1 / 1 / 4.

## Status padding, no flip to a timed-out opponent, highest word counts the play v72 (Nov 6, 2026, cache v72)

- Status line now has 8px padding above and below, so a
  point bubble hanging off the bottom row (10px below the
  board) clears the status text instead of covering it.
- When the opponent is out of time, a Play tap no longer
  flips the turn to them for the split second until the
  reply lands: the client only flips the turn at the tap
  when the opponent's clock is above 0 (the server
  already kept the turn in that case), and the status
  stays "Your move." instead of "Waiting for your
  opponent."
- Highest word score (and the 50+/100+ counts, and the
  average) now measure the PLAY's total, not one word
  inside it: a play's points are its words plus bonuses,
  so the old per-word max missed big plays — an 83-point
  play whose best single word was 40 never showed, and
  its 50+ count never moved. Fixed in both places that
  compute it (profile stats and the end-of-game stats),
  named by the play's main word; longest word still
  counts letters. Stored moves already carry the play
  total and main word, so finished games recompute
  correctly with no migration — the 83 shows up on the
  next profile load. Verified with a test run of the
  shipped computeStats against an 83-point play vs FORD
  at 60: the 83 wins.

## Bubble after the human's moves too v71 (Nov 6, 2026, cache v71)

- The v70 bubble only ever showed after the opponent's
  moves: validatePlay (the human's path) never returned
  highlightCells, so applyMove stored lastCells =
  undefined for every human move — the client's bubble
  guard found no cells, and the white last-word border
  went missing the same way. The bot's solver path always
  set it. Both valid returns in validatePlay now carry
  highlightCells with the same rule as findMoves (main
  word, or the higher-scoring word for a single tile
  forming two). Server-only change; the bubble code from
  v70 is untouched.

## Point bubble stays put + leaderboards refresh on leaving the board v70 (Nov 6, 2026, cache v70)

- Point bubble, two fixes. (1) Boldness: premium squares
  (DL/TL/DW/TW) carry an 8-direction black text-shadow so
  their letters read, and text-shadow is inherited — so a
  bubble sitting on a premium square picked up the outline
  and its number looked much bolder than on a plain square.
  The bubble now sets text-shadow:none, so the number
  renders identically wherever it sits. (2) The bubble
  stays on the board for the last played word: renderGame
  rebuilds every cell, so the bubble was destroyed at the
  next render; it is now re-attached at the end of every
  render on the most recent word move (game.lastCells, the
  same cells the white last-word border highlights). A pass
  leaves no bubble, a play still in flight keeps its
  optimistic bubble, and a pending play's own bubble still
  takes its place while arranging.
- Leaderboards refresh on leaving the board: Main Menu
  (the only way off the board screen — the tab bar is
  hidden there) now refetches /api/me, the Global rows
  and the friends list in the background, so Elo earned
  in the game just played shows on the leaderboards
  without a full reload.

## Home buttons reordered v69 (Nov 6, 2026, cache v69)

- Home screen order is now Play Online, Play Bots,
  Play Friends (was Bots, Friends, Online). Only the
  three button elements moved in index.html; every
  handler is wired by id, so nothing else changed.

## Picture and name shift left too v68 (Nov 6, 2026, cache v68)

- v67 moved the rank but the picture and name stayed:
  they sit after the rank column and the gap, so they
  only move when those shrink. The rank column is now
  22px (was 28px) and the row gap 6px (was 10px), so the
  picture starts at 40px from the left edge (was 50px)
  and the name at 82px (was 96px), while the rank stays
  at its 12px and the Elo at its 12px on the right. A
  3-digit rank drops to 14px so it still fits its column
  without touching the picture.

## Rank flush left, matching Elo's right padding v67 (Nov 6, 2026, cache v67)

- The rank was right-aligned in its 28px column, so a
  single-digit rank sat ~29px from the left edge while
  the Elo sits 12px from the right edge — the whole left
  group looked indented. The rank is now left-aligned,
  so its left edge is exactly the row's 12px padding,
  identical to the Elo's 12px on the right. Two-digit
  ranks still fit their column; a 3-digit rank on a long
  friends list extends 5px into the gap, clear of the
  picture. Search rows (no rank) already put the picture
  at 12px, unchanged.

## "Remove?" confirm sits in the red × slot v66 (Nov 6, 2026, cache v66)

- The confirm no longer lives in a panel below the list:
  tapping the red × swaps in a "Remove?" button right
  there in the same action slot — red text, red border —
  and tapping that removes the friend. The confirming
  row widens its action column so the button fits and the
  Elo stays at the far right. Tapping another row's ×
  moves the confirm there; leaving delete mode (pencil
  off, Global tab, sign-out) clears it. The old panel and
  its Keep friend / Yes, remove buttons are gone.

## Persona requests stay "sent" forever v65 (Nov 6, 2026, cache v65)

- Requesting a persona flipped their profile button to
  Play at once, because isModalFriend() counted a local
  request as friendship — the "sent" state could never
  show for a persona. Now only accepted friends count:
  a requested persona's button reads grey "sent" with the
  plane and stays that way, since personas never accept.
  Tapping it still unrequests, back to Add Friend. Real
  players are unchanged (accepted → Play, requested →
  sent).

## Nobody is a friend until they accept; personas never are v64 (Nov 6, 2026, cache v64)

- Requesting a persona used to put them straight on the
  Friends list — the list was built from localStorage
  requests, so no acceptance was ever needed. Now the
  Friends list holds only server-accepted friends (plus
  you): a request to a persona stays local "Requested" on
  their profile button and nothing more, because fake
  humans never accept. Real players were already
  accept-only via the server. Pending persona requests no
  longer count toward "No friends yet" either.

## Search SQL fixed: UNION wrapped in a subquery v63 (Nov 6, 2026, cache v63)

- The @neo search miss, finally nailed by Jeff's screenshot:
  the search endpoint always 500'd with "invalid
  UNION/INTERSECT/EXCEPT ORDER BY clause" — Postgres only
  allows output columns in a UNION's own ORDER BY, and the
  relevance CASE referenced the $2 parameter. Every
  "success" so far was the top-25 fallback (that's how
  neo→ceo seemed to work: @ceo sits in the top 25). The
  UNION is now wrapped in a subquery with the ORDER BY
  outside it, where the parameter is fine. No local
  Postgres to test against; the wrapped form is the
  standard valid shape.
- Jeff (Nov 6, 2026): stop sending the botplay link after
  update reports — no link in update messages at all now.

## Dead session caught everywhere, fallback names the failure v62 (Nov 6, 2026, cache v62)

- v61's fix had a hole: loadMe() short-circuits once `me`
  is cached, so a session that dies after that (password
  changed elsewhere, sign-out on another device) still
  degraded everything silently. One shared deadSession()
  check now sits on every silent catch — loadMe, the
  leaderboard cache, the friends load, and search — so a
  rejected session always goes to sign-in, never to an
  empty list or a fallback. Anything else still falls back
  to the top 25, and the note now names the failure
  ("Search isn't working (…​) — showing top players
  only.") so the next report says exactly what broke.

## Dead session goes to sign-in instead of silently degrading v61 (Nov 6, 2026, cache v61)

- Root cause of the @neo search miss, found via the v60
  fallback note: the search request from @ceo was failing,
  so it fell back to top-25-only, where @neo never appears.
  The failure was a dead @ceo session that loadMe() used to
  swallow — the app kept running on a token the server no
  longer accepts, so friends/Global went quietly empty and
  search silently degraded. A rejected session now clears
  the token and goes to the sign-in screen, like every
  other 401 handler; search and the Friends list stop
  instead of running on a cleared token. Other errors
  (offline) behave as before. Fix on the phone: sign in
  as @ceo again and search "neo".

## No stale account flash on switch; search fallback says so v60 (Nov 6, 2026, cache v60)

- Switching accounts no longer flashes the other account:
  the Friends list and requests blank synchronously at the
  start of every refresh (they used to sit visible until
  the new data came back), the Profile tab blanks before
  the screen is shown (show() used to run first, painting
  the old name/pfp for a frame), and sign-out / account
  delete now wipes the Friends list, requests, search
  results and profile DOM, so the next sign-in starts
  from empty screens.
- If server search is unreachable, the fallback to the
  top-25 leaderboard now says so in the results ("Search
  is offline right now — showing top players only.")
  instead of silently showing top players, which made a
  real account below the top 25 look unfindable.
- The flash was stale DOM, not stale auth: the search API
  always uses the live token. Whether it explains the
  @neo search miss is still open — retest from @ceo
  after reloading, and check the username on @neo's
  Profile tab if it still misses.

## Remove confirm, @-proof search, no rank in search results v59 (Nov 5, 2026, cache v59)

- Removing a friend now asks first: tapping the red × in
  delete mode opens a confirm panel under the list —
  "Remove [name] (@username) from your friends?" — with
  Keep friend and Yes, remove. Nothing is removed until
  Yes, remove is tapped. Leaving delete mode (pencil off,
  or switching to Global) dismisses the panel.
- Search strips a leading @ on both sides: typing "@neo"
  searches for neo. Removing someone as a friend never
  affected search — search covers every user and persona
  regardless of friendship (remove only deletes the
  friendship row) — but the @ prefix did make a search
  miss, which is the likely reason @neo was unfindable.
- Search result rows show no rank: the rank column is
  dropped and pfp / name / action / Elo shift one column
  left, keeping their alignment. Leaderboard rows are
  unchanged.

## No play button on leaderboard rows v58 (Nov 5, 2026, cache v58)

- The play button is gone from Friends leaderboard rows.
  Challenging a friend happens only from their profile
  window (Play button). The action slot stays as an empty
  box so the Elo keeps its far-right column, and delete
  mode still shows the red × there.

## Search: 5 most relevant, auto-clears after 10s v57 (Nov 5, 2026, cache v57)

- Search shows only the 5 most relevant results. The server
  ranks them — exact username first, then username starting
  with the query, then name starting with it, then the rest
  by Elo — and caps at 5 (the client caps the fallback path
  too).
- Ten seconds after results appear, they disappear and the
  search bar empties itself. Typing again restarts the clock.

## First name + last initial, grey profile labels, blue pencil v56 (Nov 5, 2026, cache v56)

- Both leaderboards and search now show first name + last
  initial ("Jeff M.") instead of first names only on Global
  and full names on Friends/search. The full name still
  shows when you tap through to the profile window.
- Profile window: the "Elo" and "Global Rank" labels are grey
  like the username now, with the values in Duello blue. The
  two lines sit close together (2px apart) with 12px above
  and below the pair, so they are evenly spaced between the
  username and the Play button.
- Pencil: when delete mode is on, the pencil itself turns
  Duello blue (its SVG stroke is recoloured by CSS) — no
  outline/border around it any more.

## Elo capitalised, blue stat values, 2 requests at a time, Play on friend profiles, working pencil, friends ranks from 1, Global Rank v55 (Nov 5, 2026, cache v55)

- Elo is a word now: "Plays at your Elo." — it was the only
  user-facing lowercase "elo" (Elo is named after Arpad Elo,
  the chess rating's inventor). Other labels already read Elo.
- Stat window: the values (Best word, Longest word, Optimal
  moves) are Duello blue now; the labels stay white. Optimal
  moves uses the same blue value style on its own line.
- Friend requests: at most two show at a time; deciding one
  (Accept or Decline) reveals the next.
- Decline button: white letters on a transparent background
  with just the thin blue border.
- A friend's profile now shows Play instead of Add Friend /
  Friends, and tapping it challenges them, same as the play
  icon on the Friends list. (Real-player challenges still
  have no delivery path, so a real friend sees the same
  "can't accept yet" wait as the list's play icon; persona
  friends accept half the time, as before.)
- Friends-list play button: Duello blue oval (2px border,
  50% radius) around the grey triangle.
- Pencil works now: tapping it puts the Friends list in
  delete mode (the pencil gets a blue outline), and each
  friend row shows a red × that removes them — server-side
  for real friends, local for personas. Your own row is
  never removable. Switching to Global clears delete mode.
- Friends leaderboard: you are on it now, and ranks start
  at 1 — this list is separate from Global, with its own
  ranking. It is also mutual and unlimited: an accepted
  request puts each side on the other's list (the server
  returns accepted rows in either direction), and the list
  is no longer resolved through the top-25 leaderboard, so
  a friend below the top 25 no longer vanishes from it
  (that was also why low-Elo friends could disappear).
  Persona friends below the top 25 are found by search.
- Profile window: Global Rank sits below Elo, fetched from
  new endpoint GET /api/users/rank?username= (counts
  everyone ahead of the player across users + personas,
  Elo desc then earliest created first — the leaderboard's
  tie-break). The Friends rank and the Global rank are
  different numbers and are never mixed up.

## Always-black point bubble, optimal moves on its own line, decline border, server search v54 (Nov 5, 2026, cache v54)

- Point bubble: the score bubble at the corner of a played word
  was black on plain cells and white on premium squares. Root
  cause: premium cells set `-webkit-text-fill-color:#fff`, an
  inherited WebKit property that overrode the bubble's own
  `color` on iOS Safari. The bubble now sets
  `-webkit-text-fill-color:#1a1d24` explicitly, so the number
  is always black.
- Stat window: "Optimal moves" now sits on the line below its
  label, like Best word and Longest word already did (it was
  the only one still inline).
- Decline button: the grey Decline button on incoming friend
  requests now has a thin Duello blue border (1px solid
  #03eaff). Accept is unchanged.
- Search: a brand-new account was unsearchable — @neo could
  not be found from @ceo. Root cause: search filtered only
  the top-25 leaderboard rows, and a new account at 1000 Elo
  sits below the top 25. New endpoint GET
  /api/users/search?q= searches the whole users + personas
  tables by name or username (top 20 by Elo); the client
  uses it, falling back to the leaderboard filter if it
  fails.

## One decimal stats, flat new-account Elo line, photo shrink, real friend requests, no stale profile v53 (Nov 5, 2026, cache v53)

- Stats: Average word score and Optimal move % now carry one
  decimal place (server rounds to 0.1; client formats with
  toFixed(1), e.g. 53.8%, 14.4). Average game score is
  unchanged (still whole points).
- Elo chart: a brand-new account no longer says "No Elo history
  yet — play a game." With no history the chart draws a flat
  line at the starting 1000 instead.
- Photos: a normal phone photo no longer hits "That photo is too
  large." The client now shrinks the photo on the device before
  upload — 512px on the longest side, JPEG 0.82, stepping down
  to 384px/0.75 then 256px/0.7 only if it still doesn't fit the
  750KB cap. Pfps display at 36-64px, so 512px is plenty. The
  server's 750KB cap stays as a backstop.
- Friend requests are real now (this is the friends backend
  arriving for requests only — real-player challenges still
  have no delivery path). New table `friend_requests`
  (from/to/status pending-or-accepted, self-requests rejected
  by a CHECK), plus GET /api/friends (friends/incoming/
  outgoing), POST /api/friends/request, /respond (accept/
  decline), /remove (cancel a sent request or remove a friend).
  Sending a request makes it appear at the top of the
  recipient's Friends page with Accept/Decline buttons; the
  profile-window button shows "sent" for an outgoing request
  and a disabled "Friends" once accepted. Requests to a persona
  stay local-only, as before — personas have no account.
- Self-friend bug, root cause: requests used to live only in
  the sender's localStorage, which is shared by every account
  on one phone. @neo's request to @ceo therefore showed up in
  @ceo's own Friends list as a friend: himself. The server
  never returns you as a friend or request, the client filters
  your own row out of the Friends list, and self-requests are
  rejected server-side. Old localStorage requests migrate once
  on load: real-player ones are re-sent to the server, a
  request to yourself is dropped, persona ones stay local.
- Profile after switching accounts: the old account used to
  show on the profile tab for a few seconds because the screen
  kept the previous account's painted name/photo/Elo/stats
  until /api/me came back. renderProfileUI now blanks the
  profile fields and clears the chart before the fetch, so
  the tab opens empty and paints the new account when it
  arrives. Sign-in/out already cleared the cached user object;
  the stale part was the DOM, not the cache.

## Profile button really fixed, out-of-time recall, stat pfp tap v52 (Nov 5, 2026, cache v52)

- The Add Friend button is now 56px tall in total (was 24px)
  with a visible grey border in the sent state. Root cause of
  the cut-off text: the stylesheet sets `box-sizing:border-box`
  globally, so the v48 `height:24px` was a 24px TOTAL height
  with a 0px content box — the icon and text spilled out of it.
  The v48 "216x48" claim was computed under content-box and
  was wrong. Now the button is 180x56 total in both states
  (32px content box: the 24px icon fits with room), and the
  sent border is Secondary Grey instead of the button's own
  background color, so the outline no longer vanishes on the
  toggle and nothing appears or disappears.
- Out of time: any tiles placed but not yet played go straight
  back to the rack. The check sits at the top of renderGame
  (before the board/rack render), so the tiles show back in the
  rack on the same render. Skipped while a play is in flight,
  since the server reply settles those tiles.
- Tapping the opponent's pfp in the stat window — the larger
  top one and the smaller one in the stat box — opens their
  profile window, same as tapping their name. Persona games
  only; bots have no profile.

## DL/DW color swap, last-play line locked v51 (Nov 5, 2026, cache v51)

- DL and DW swapped colors on the board: DL is now red
  (#ff1303), DW is now orange (#ff8d03). TL green and TW
  magenta are untouched. Only the two premium-square rules
  changed — the danger/armed red (#ff1303) on Delete account,
  the armed Forfeit/Pass buttons, and the red disc is the same
  hex and stays red; it is no longer "DW red", it is just red.
- The last-play line is now a fixed 18px tall (2px padding
  above and below a 14px line, border-box) from the jump, so
  playing the first word can no longer grow it and push the
  board down. The height matches the line's old empty height,
  so the board's resting position does not move. Render-checked
  empty vs a long first-word line: identical 18px boxes.
- Brand Handbook updated to v1.16 in Drive (palette table,
  premium mapping table, premium-squares rule, new history
  row; past history rows untouched). Rulebook and Tech Stack
  name no premium colors, so they needed no change.

## Elo actually at the far right v50 (Nov 5, 2026, cache v50)

- v48 only fixed Jeff's own row. The bug: on every other row
  the action slot is empty (youBadgeHTML returns ''), so the
  row has four children, not five, and grid auto-placement put
  the Elo span into column 4 (the 36px action column) instead
  of column 5 — ending 66px short of the row edge. Jeff's row,
  with its YOU badge, was the only one landing in column 5.
  Fixed by giving every row child an explicit grid-column
  (rank 1, pfp 2, identity 3, action/play 4, Elo 5), so the
  Elo lands in the last column no matter how many children a
  row has. Render-verified: a badge-less row and Jeff's row
  now end their Elos on the same pixel.

## Bot sub-lines punctuated v49 (Nov 5, 2026, cache v49)

- The bot sub-lines are sentences now: "Plays at your elo."
  and "The official Duello engine."
- The Elo position in Jeff's screenshot (1:48 PM) predates
  v48 going live by about a minute: the shot shows the old
  layout, where every Elo ended ~68px short of the row edge
  (measured on the image: all Elos end at the same x, ~925,
  with the empty action column to their right). v48, live since
  just after the screenshot, puts the Elo in the last column,
  right-aligned at the row's right edge — verified on the live
  served CSS and JS. A reload picks it up.

## Elo far right, fixed-size add button, faster matching v48 (Nov 5, 2026, cache v48)

- Elo is all the way right on Global and search rows now: the
  action column (YOU badge / Friends play icon) moved to the
  left of the Elo column, so every Elo ends at the row's right
  edge.
- The profile window's Add Friend button was fixed-width in
  v47 but not fixed-height: the Add state stood 48px tall and
  the sent state 40px, so the card still shifted 8px on the
  toggle. The button is now a fixed 216×48px box in both states
  (180px wide + padding + border, 24px tall + padding +
  border), so nothing moves at all.
- Play Online finds an opponent in 2-3 seconds now, down from
  3-5. Rematch and friend-challenge waits stay 5-7s — those are
  a person deciding, not a search.

## Bot labels, no row friend buttons, fixed-size add button, first names v47 (Nov 5, 2026, cache v47)

- The bot selector reads "Competitive" with the small line
  "plays at your elo" under it, and "Fishstick" with "the
  official Duello engine" under it.
- The add-friend icon is gone from Global rows and search
  results: the only way to add someone is tapping their name and
  adding them from the profile window. The action column is back
  to 36px (YOU badge and the Friends play icon only), so names
  get their width back.
- The profile window's Add Friend / sent button is a fixed
  180px wide in both states (measured: the Add Friend content
  is 143px, the sent content 81px), so toggling it moves nothing
  around it.
- Global shows first names only. The full name still lives on
  the row, so the profile window shows it. Friends and search
  still show full names — say the word if those should be first
  names too.

## Rack cap, definition cross-refs, instant timeout end, profile window v46 (Nov 5, 2026, cache v46)

- A rack can never hold 3 of the same letter now: the initial
  deal re-rolls a rack with a triple, and every refill draw
  (human and bot) re-rolls until the letter still has room, with
  the 2-vowel / 2-consonant floor intact. Verified in Node over
  10,000 deals and 10,000 refills: zero triples, zero floor
  failures.
- "See Note under Our." is gone for good: the definition
  resolver now follows Webster "See X" pointers ("See Note under
  Our.", "See Eke.", "See Have.") to the base word's own
  definition, on top of the existing plural/past-tense/form-of
  resolution. 174 bundled cross-references resolve this way;
  OURS now shows OUR's real definition, EEK shows EKE's, and
  real definitions that merely start with "see" ("see with
  attention") are untouched. The dictionary popover text is
  smaller too (13px).
- Both clocks at 0 ends the game instantly now: the 100ms clock
  tick fetches the game the moment both displayed clocks read
  0:00, whichever turn it is, instead of waiting out the bot's
  think (up to 33s for a persona). The fetch settles the clocks
  server-side and finishes the game, so the stat window comes up
  within ~1s.
- The stat window's add-friend icon is gone. Tapping a name
  opens a profile window instead — photo, name, @username, Elo,
  and an Add Friend button — on Global rows, search results,
  and the stat window (opponent and your own name; bots have no
  profile, and pre-v44 games carry no persona username so that
  name is not tappable). Closing the window re-renders the
  lists behind it so a toggled request shows up everywhere.

## Sent text + plane, search rows, Play Friends live v45 (Nov 5, 2026, cache v45)

- The sent state is now small grey "sent" text plus a small (16px)
  paper plane, on Global rows and in the stat window. The action
  column widens from 36px to 56px to fit it (the add icon stays
  36px and centers in the wider column); measured with the real
  font, "sent" + plane is 51px, so it fits with room to spare.
  The name column narrows to 130px, so long names truncate a
  little earlier than before.
- Search results are leaderboard rows now: same grid (rank | pfp |
  name over username | Elo | friend button), built by the same
  row helpers as Global, instead of the old compact one-line
  "Name @user" format with no Elo and no button.
- Play Friends is live (was greyed out with SOON): it opens the
  Friends leaderboard — the people you added from Global, sorted
  by Elo, with a blue play icon instead of the add-friend button.
  Tapping play opens the searching-style screen saying "Waiting
  for {firstName} to accept…", ticking 5-7 seconds. The friend
  accepts half the time and the game starts, or declines and the
  screen offers Back to Friends. This is the same simulated
  accept/decline as a rematch request: personas have no real app
  for the request to pop up on, so their answer is simulated on
  your device. A challenge to a real player has no delivery path
  yet — after the wait the screen says so plainly instead of
  hanging. Real accept/decline popups on a friend's phone need
  the friends backend, which is still unbuilt.

## Friend sent-plane, photo variety, instant stats, stat-window add v44 (Nov 5, 2026, cache v44)

- The sent state is now a grey paper airplane (Material send
  icon), not a blue friend-with-check: both friend states are
  grey at 24px, and the shape — person + plus vs plane — tells
  them apart. Tapping the plane still unrequests.
- Persona photos vary now: 5 of the 100 have no photo (they show
  the silhouette with the blue no-photo ring, like a real user
  with no photo — never the robot, which is Competitive Bot) and
  10 have a non-headshot photo (picsum seed images). The other 85
  keep randomuser headshots. Applied by seed v4 (full delete +
  re-insert on first boot, then never again); the personas table
  needed a migration first, because photo_url was NOT NULL — the
  seed now drops that constraint idempotently, and the schema
  file matches. The game snapshot now also carries the persona's
  username, so the stat window can key a friend request on it.
- The searching screen no longer says "Finding a player within
  40 Elo of you": just the dots and "Searching for opponent…".
- Both clocks at 0 now pulls the stat window up instantly: the
  old 3s final-board view after time expiry is gone, for every
  finish type.
- The stat window has an add-friend icon below the opponent's
  name, persona games only (same add / sent-plane toggle as the
  Global rows, same localStorage pending state). Bots get no
  button. Games started before this version carry no persona
  username in their snapshot, so they get no button either.

## Friend icon: smaller, grey until sent v43 (Nov 5, 2026, cache v43)

- The friend icon shrinks from 28px to 24px inside the same 36px
  button, and the colors flip: grey (#b3b2b1) before the request
  is sent, Duello blue once it is. The requested state still
  shows the person with a check, and tapping it still unrequests.

## Global friend button + Elo alignment + username re-roll v42 (Nov 5, 2026, cache v42)

- Friend requests toggle: tapping Requested again now unrequests
  (the name is removed from localStorage and the button goes back
  to the add icon). The old button disabled itself once requested,
  so there was no way back short of clearing site data.
- Add Friend is now an SVG icon, not text and not emoji: a person
  silhouette with a plus (Duello blue), drawn in currentColor like
  the tab-bar friend icon. Once requested it shows the same person
  with a check, in grey. Both states are 36px buttons with a 28px
  icon and an aria-label naming the player.
- Elo alignment: leaderboard rows are now a grid — rank 28px |
  pfp 36px | name (flexible, ellipsis) | Elo 44px right-aligned |
  action 36px — instead of flex, where the Elo sat wherever the
  name and the button ended. Every Elo now lands in the same
  column on every row. Your own row carries the YOU badge in the
  action slot (instead of between the name and the Elo, which was
  part of what pushed Elos around), so your full name still shows
  and your Elo still lines up. Long names truncate with an
  ellipsis instead of wrapping; measured with the real Comfortaa
  font (rank 101 fits the 28px column, 4-digit Elo fits the 44px
  column) and render-checked as a mock before pushing.
- Usernames re-rolled (same 100 people, same Elos and photos):
  7 username methods now — first_last, firstlast, first + number,
  first initial + last, first + last initial, adjective + noun,
  and word-game handles (wordsmith, tilefan, rackstar…) — instead
  of 3. Animal handles drop from 20 to 3 (luckylynx,
  gentlehawk33, wildfalcon kept) and iron goes from 2 to 0.
  Applied by a versioned seed refresh (persona_seed version 3:
  full delete + re-insert on the first boot, then never again),
  so Elo movement still survives later restarts; a persona game
  open during the deploy won't update that persona's Elo for
  that one game (the player's own Elo still updates).

## Global matchmaking + stat/last-play fixes v41 (Nov 4, 2026, cache v41)

- Stat screen: for a human-vs-human match (personas count as
  humans), both Elo moves now show — the opponent's move is no
  longer blanked. Competitive Bot and Fishstick still show no bot
  move. The stat window also uses the player's first name
  everywhere "You" appeared (both stat boxes and the winner line).
- Last play: the last move always shows below the scoreboard,
  even in a one-sided stretch. The old turn-based pick showed a
  stale move from the side that can no longer move while the
  other side played alone; now, when a clock is at 0, the other
  side's last move is shown whatever the turn says. Last-play
  padding is now explicitly equal above and below the text
  (2px padding both sides, no margins), same total spacing as
  before.
- Passing in a one-sided stretch is gone, client and server:
  the Pass button is disabled (which also drops its blue
  highlight, via .controls button:disabled) when either clock is
  at 0, and the server rejects a pass with "You are out of time."
  or "Your opponent is out of time, so you can't pass." The old
  server branch that let a pass through with the opponent at 0
  was removed; auto no-move passes are unaffected.
- Matchmaking is now within 40 Elo (was 200): Play Online picks
  a random persona in range, falling back to the nearest persona
  if nobody is in range rather than failing to make a match.
- Personas re-rated on a bell curve around 1000 (mean 1003 in
  the shipped set, 67/100 within 900-1100, clipped to 800-1200)
  with mixed usernames (roughly 70% name-based, 30% unrelated
  handles like ironcoyote, gentlehawk33). Applied by a versioned
  seed refresh (persona_seed version 2: full delete + re-insert
  on the first boot, then never again), so Elo movement still
  survives later restarts; a real user's username wins over a
  colliding persona handle via a numeric suffix.
- Play Online now shows a searching screen (pulsing dots,
  "Searching for opponent…", Cancel) that ticks a random 3-5
  seconds before making the match. Cancel, or any navigation
  away, abandons the search and no game starts.
- Play Again against a Global player now sends a rematch
  request instead of starting at once: the request screen waits
  a random 5-7 seconds, then the persona accepts (50%) and the
  rematch starts against the same player, or declines and the
  screen offers Back Home or Find a new opponent. Play Again
  against a bot still starts immediately.
- Global shows the top 25 (was 20) plus you at your true rank,
  and Global rows carry an Add Friend button instead of Play
  (matches come from Play Online). Friend requests are UI-only
  pending state until the friends backend lands: tapping marks
  the row Requested and remembers the username in localStorage,
  but nothing is sent anywhere.

## Global personas v40 (Nov 4, 2026, cache v40)

- Global is live with 100 personas posing as human players: 50 men
  and 50 women with ordinary American names, headshots from
  randomuser.me portraits (gender-matched), and Elo spread 800-1200
  (data/personas.json, seeded once by initDb when the personas
  table is empty; later boots never re-seed, so Elo movement
  survives restarts). They are rows in a personas table, not user
  accounts, so they can never sign in; new signups and username
  changes are rejected if the name collides with a persona.
- Playing them: any persona row on Global has a Play button that
  starts a game against that person, and Play Online (previously
  greyed out) now matches you with a random persona within 200 Elo
  of you, falling back to any persona. Play Again rematches the
  same persona. Scoreboard, stat window, and the waiting status
  show the persona's first name and photo instead of "Bot".
- How they play: an extreme bias to everyday words (a 402-word
  common list, all verified in the dictionary) — a persona plays
  a common word whenever one exists, picking randomly among the
  top 5 common moves at 900 Elo or below, top 3 up to 1050, and
  the best common word above that. Think time is a uniform 7-33
  seconds per move, averaging 20, and personas do NOT get the
  20s clock step: their clock consumes only their think time.
  Once their clock is under 20 seconds they always get exactly
  one more move, played with 1-8 seconds left (armed in
  startBotTurn, spent in runBotTurn); after that the normal think
  runs the clock out mid-think and the out-of-time skip takes
  over. The bot-turn poll tolerance is capped at 2500ms so an
  early poll cannot play a 33s think at ~17s (unchanged for 5s
  and 2s thinks).
- Elo and stats: a persona's Elo moves exactly like a human
  opponent's (standard K=32, zero-sum, stored on the personas
  row at game end), so the leaderboard and future games against
  them reflect results. Profile stats count persona games as
  human games: Vs Humans is persona games only, Vs Bots excludes
  personas, aggregate counts them like any non-Fishstick game.
  Leaderboard is users + personas ranked together, top 20, with
  the signed-in user appended at their true rank if outside it.
- Caveat: the portrait license chain is weak (randomuser.me
  photos come from UI Faces' authorized section, variously
  described as CC BY-NC-SA) — fine for seeding, but swap to a
  cleanly licensed set before real launch or monetization.

## Friends search focus ring removed v39 (Nov 3, 2026, cache v39)

- Jeff, Nov 3, 2026: tapping the friends search bar showed a blue
  rounded rectangle. Cause: no focus style was set for that input, so
  the browser drew its default focus outline around it (rounded by
  the input's inherited 10px radius).
- Fix, scoped to that input only: `.search-wrap input:focus` now
  sets `outline:none;box-shadow:none`. Other inputs keep their
  default focus behavior. The search bar itself (grey rounded wrap,
  magnifier, placeholder) is unchanged.

## Cross-word dedup fix v38 (Nov 3, 2026, cache v38)

- Bug (Jeff, Nov 3, 2026): QI played horizontally with Q on TL and an
  existing I below the Q scored only 31 instead of 62. The cross-word
  dedup compared only word text + starting cell, so a cross word with
  the same text and same starting cell as the main word was dropped
  even though it ran perpendicular (horizontal QI vs vertical QI).
- Fix, in server validatePlay, server findMoves, and client
  localValidate: dedup now compares the full cell list, so a word is
  only dropped when it is the same cells, not merely the same text
  starting at the same cell. A newly placed premium tile now counts
  in every word it forms in that move, as in Scrabble: QI on TL now
  scores 31 + 31 = 62. No rule change — the Rulebook already intended
  every formed word to score; this restores that.

## 4-minute clocks v37 (Nov 3, 2026, cache v37)

- Chess clocks are now 4:00 per player instead of 5:00, at Jeff's
  direction (Nov 3, 2026). Everything else is unchanged: 10x10 board,
  6-tile racks, 3 of each premium, pass still -30s, bot 5s think and
  20s clock step, no win on time (out-of-time player skips turns).
- Changed in server.js (new games start at 240000ms, fresh-game
  serialize and /start reset both 240000ms) and in public/app.js
  (countdown clock set, countdown/hold pinned display) and
  public/index.html (initial clock spans). Games already in progress
  keep their existing clocks; only new games start at 4:00.

## Privacy contact is privacy@duellogame.com v36 (Nov 3, 2026, cache v36)

- The privacy policy contact is now privacy@duellogame.com (both
  the intro line and the Contact section), forwarded to the Duello
  Gmail. It replaces the Duello Gmail address the policy carried
  since v27. The policy's effective date is unchanged.

## No-move auto-pass + standard Elo v35 (Nov 3, 2026, cache v35)

- No available moves now auto-passes for real, on both sides, at
  -30s like a manual pass, and the last line says so: "No moves
  available, passed -30s" (manual passes still read "passed -30s").
  The human side previously had no server auto-pass path at all,
  and the bot side displayed -30s while deducting nothing; both
  are fixed. If the other side also has no move (or its clock is
  already 0, so it can never move), the game ends by score at
  once instead of handing the turn to a side that cannot play.
  Out-of-time skips are unchanged and are not passes: a clock
  already at 0 is skipped with no deduction and no last-line
  change. This supersedes the old zero-time auto-pass rule.
- Elo is now standard, K=32 on a 400-point scale, zero-sum: the
  opponent always moves the opposite way, and a draw uses actual
  0.5, so a draw against a stronger opponent gains (a draw
  against Fishstick at 3000 gains ~16) while a draw against an
  equal opponent moves nobody. Two old deviations are gone: draws
  no longer force delta 0 regardless of gap, and Competitive Bot
  no longer mirrors the player — its next game still re-syncs to
  the player's current Elo at creation, so its always-equal
  matching is unaffected. K stays fixed at 32 (a parameter choice,
  not a FIDE schedule); forfeits still count as losses.

## Highest word shows the word v34 (Nov 3, 2026, cache v34)

- The profile stats "Highest word score" line now lists the word
  next to the score, exactly like "Longest word" does, e.g.
  JAZZED (86 pts). The server previously tracked only the score
  and threw the word away; it now keeps highestWord alongside
  highestWordScore, computed from finished games' stored moves, so
  past games contribute with no migration needed. No games yet
  shows —, same as Longest word.

## Eye toggle on pointerdown v33 (Nov 3, 2026, cache v33)

- The eye toggle now runs on pointerdown instead of click, after
  the reset-password eyes were reported not working: on iOS a tap
  next to a focused password field can lose its click when the tap
  dismisses the keyboard and the layout shifts, but pointerdown
  fires at touch start, before any of that. preventDefault keeps
  focus in the field so the keyboard stays up, and the click
  handler remains only as a guarded fallback for keyboard
  activation (same 1000ms guard pattern as the Play button), so a
  tap never toggles twice. touch-action: manipulation on the eye
  button removes the double-tap-zoom delay. No logic change to
  what the toggle does, only when it fires.

## Eye icon + password policy v32 (Nov 3, 2026, cache v32)

- The eye toggle is now a real SVG eye icon, not emoji — grey eye
  when the password is hidden, Duello blue eye when it is visible.
  The toggle also moved to document-level delegation (taps on the
  icon's SVG paths count as taps on the button) with a larger
  32px tap target, after the change-password eyes were reported
  not working; no monkey icon anywhere.
- Password policy, client and server: a new password must have
  8+ characters, a capital letter, a lowercase letter, and a
  number, enforced in sign-up, reset, and change (server returns
  the same wording). The four requirements show live under every
  new-password field, turning Duello blue with a check as each one
  is met.

## Password reset/change UX v31 (Nov 3, 2026, cache v31)

- Password change finally has a real submit: the gear screen's
  Change password link is now reveal-only, and the revealed fields
  carry a full-width "Save new password" button. The old second-tap-
  on-the-link submit is gone, which is why it looked like there was
  no submit button at all.
- Password reset is less clunky: after sending (or resending) a
  code, the code step says "A code was sent to your email." in
  Duello blue, and after a successful reset the sign-in screen says
  "Password has been reset, please log in." in Duello blue — both
  via a new `.success` style, never the red error style. Signup's
  code step got the same blue sent message for consistency.
- No autofill anywhere in auth/edit: every email, password, and
  code input on the sign-in, sign-up, reset, and profile-edit
  screens now carries autocomplete="off", and both forms do too.
- Every password field (sign-in, sign-up, reset new passwords,
  change current/new passwords) now has an eye button (👁/🙈) that
  toggles the typed password between hidden and visible.

## No-photo pfp border v30 (Nov 3, 2026, cache v30)

- When a user has no profile photo, the silhouette icon now gets a
  2px Duello blue (#03eaff) circular border, everywhere it appears:
  profile tab, gear/edit screen (including after Remove photo, and
  removed again on upload), scoreboard player panel, end-of-game
  stat window (top and stat-box rows), Global leaderboard rows, and
  friend-search rows. It is a `.no-photo` class on the circular
  container, toggled from the user's actual photoData, so a real
  photo never gets the border and bots (Fishstick image / robot
  emoji) are untouched.

## Change-password restyle v29 (Nov 3, 2026, cache v29)

- Change password on the gear/edit screen is now plain text (the
  standard `.link` style, Duello blue) like Sign out, instead of a
  blue-bordered button. Its behavior is unchanged: first tap reveals
  the password fields, second tap submits. The gear screen now reads
  as three text actions: Change password, Sign out, Delete account
  (red).

## Delete-account restyle v28 (Nov 3, 2026, cache v28)

- The Delete account trigger on the gear/edit screen is now plain
  red text (`.link.danger`, DW red #ff1303) like the Sign out link
  above it, instead of a full-width bright red button. The
  confirmation's "Yes, delete my account" button stays a big red
  button, so the final destructive tap is still unmistakable.

## App Store blockers v27: delete account + privacy policy + sign-out move (Nov 3, 2026, cache v27)

- Delete account (Apple requirement): POST /api/me/delete, signed-in
  only, deletes the account in one transaction, child rows first:
  sessions, games, Elo history, verification codes, password-reset
  codes, then the user row. The calling session is deleted too, so
  the token stops working at once. Client: Profile edit screen
  (gear) gains a Delete account button with a two-tap confirmation
  ("This permanently deletes your account, games, Elo, and stats.
  This cannot be undone." + "Yes, delete my account" / "Keep my
  account"); on success the token is cleared and the app returns to
  the sign-in screen.
- Privacy policy: public/privacy.html, served by adding it to the
  server's static whitelist, linked from the sign-in screen and the
  profile screen. It covers account info, game data, uploaded photos,
  session/verification codes, Render hosting and Resend email as the
  only services, no sale or advertising sharing, no ad trackers, and
  deletion via the in-app button. Contact listed is the Duello Gmail
  (fishstickincorporated@gmail.com); the live policy URL is
  https://duellogame.com/privacy.html.
- Sign out moved (Jeff, Nov 3, 2026): the Sign out button moves from
  the main profile screen to the gear/edit screen, directly above
  Delete account (order: Change password, Sign out, Delete account).
  Same button and handler, only relocated; the Privacy Policy link
  stays on the profile screen.
- Tested end to end locally before pushing, against a throwaway
  local Postgres database only (production untouched): unauthenticated
  delete returns 401, /privacy.html serves 200, an authenticated
  delete returns ok:true and leaves zero rows for that user in users,
  sessions, games, Elo history, and both code tables, while a second
  control account still signs in normally afterwards.

## Tiles v26: outlined letter/value paths (Nov 3, 2026, cache v26)

- tileSVG no longer renders letters or values as font text: both are
  baked-in vector paths, so bold thickness can no longer vary by
  device font rendering. Letters are Comfortaa Bold outlines at the
  same size/position as before (58px, centered at x=46, baseline 76,
  stroke 3, unchanged); values are Liberation Sans Bold outlines
  (metric-compatible Arial substitute) at the same size/position
  (28px, anchored end at x=90, baseline 28) with the value stroke
  thinned from 2 to 1 at Jeff's approval after he reviewed examples
  (W first, then a thinner-numbers revision). Paths were generated
  with fontTools from the approved fonts and render-checked for all
  26 letters from the shipped app.js (letters, values, and holes
  all correct) before pushing. Generator and source paths live in
  workspace/duello-outlined-tiles/ (generate.py + outlined-tiles.json);
  only the resulting path tables are embedded in app.js. No game
  logic, drag, or validation change: tileSVG still takes a letter
  from game state and returns the same 100x100 tile SVG.

## Scoreboard v25: equal padding around the last-play line (Nov 3, 2026, cache v25)

- v24 left the line with 4px above it (scoreboard margin
  2px + last-play margin-top 2px) but only 2px below it.
  Scoreboard bottom margin goes to 0, so the gap is now
  exactly 2px above and 2px below the line. The line-height
  is also set to 14px to match the 14px min-height, so the
  extra height no longer sits only below the text. No other
  change: same single line, same side justification.

## Offline copy fixes (Jeff's checklist, Nov 16, 2026) v110 (Nov 16, 2026, cache v110)

- **"pending" not "pending sync":** the stat-window Elo move for an offline game waiting to sync now reads `+16 · pending` instead of `+16 · pending sync` (app.js showStatWindow).
- **Search offline note capitalised:** the friend-search fallback note now reads `Search requires an internet connection.` instead of `search requires an internet connection` (app.js runFriendSearch).
- **Last-known profile never shows the latest Global Rank:** renderProfileUI used to fire a live `/api/users/rank` fetch even when the profile was rendered from the offline cache, so a stale "Last known profile" could show a fresh rank. Now, when the profile comes from cache, the rank shows only if one is already in the session rank cache, otherwise `—`, and no live fetch runs. Online behaviour is unchanged (cached rank at once, else fetch once).
- **Searching copy capitalised with ellipsis:** the waiting screen now reads `Searching for internet connection…` instead of `searching for internet connection` (app.js startSearching), matching the `Searching for opponent…` style.
- Verified with a new v110 client harness (15 checks: 6 static — all four strings plus the v110 cache bump; T1–T4 run the real renderProfileUI against a stub DOM — offline with an empty rank cache shows `—` and never calls the rank endpoint, offline with a cached rank shows it and still never fetches, online with an empty cache fetches once and shows it, online with a cached rank shows it without fetching). Regressions: v104/v103/v102 client harnesses pass except their own version-pin checks (expected — the cache is now v110). No server change.

## Elo updates instantly offline; online/friend play syncs first (Jeff's correction, Nov 16, 2026) v111 (Nov 16, 2026, cache v111)

- **No "pending" by the Elo — supersedes v110 before it shipped.** The v110 `· pending` marker on the stat-window Elo move is removed entirely. The Elo just updates: the profile Elo and the Friends-list self row now show `localElo()` (last synced Elo + finished-but-unsynced offline deltas) instead of the last synced Elo, so a Competitive Bot win offline moves your Elo at once, in the profile, on your Friends row, and in the next game's starting Elo (which already used `localElo()`). The "Games waiting to sync" profile line stays — it counts the unsynced games, which is still true until they drain.
- **Sync before friends or online play.** A new `syncBeforeOnlinePlay()` runs before an online game is created (`startGame`, which also covers Play Online personas and persona challenges) and before a real-player challenge is sent (`startChallenge`): it waits up to 15s for a drain already in flight, then drains the outbox if it is non-empty, so the server has every finished offline game before the new game is priced from the server Elo. Skipped entirely when offline (`isOffline()`), so offline taps still start a local game at once; the background drain on the `online` event is unchanged. Joining an already-accepted challenge needs no gate — it creates nothing.
- Verified with a new v111 client harness (18 checks: 10 static — no `· pending` / `pending sync` anywhere, profile + Friends row use `localElo()`, the gate helper exists and is called from both creation paths, cache v111, and the v110 copy fixes intact; T1–T3 run the real renderProfileUI + localElo against a stub DOM — offline with an unsynced +16 the profile shows 1086 at once with a blank rank and no live fetch, online with nothing unsynced it shows 1070 with a live rank fetch, online with an unsynced delta it still shows 1086; T4–T6 run the real syncBeforeOnlinePlay — empty outbox drains nothing, non-empty drains once, a running drain is waited out before draining). Regressions: the v110 harness fails only on its superseded S5 (the removed marker) and its version pin; v104/v103/v102 client harnesses pass except their own version-pin checks (expected — the cache is now v111). No server change.

## Offline Fishstick starts instantly (Jeff's bug, Nov 16, 2026) v112 (Nov 16, 2026, cache v112)

- **Root cause.** The v107 warm-up never ran on a cold launch in airplane mode: `preloadHomeTabs` only warmed the dictionary after a successful `/api/me` call, and in airplane mode that call throws, so the warm was skipped entirely. The first Fishstick tap then paid the whole dictionary load (fetch 1.2 MB words.txt + parse 138k words + engine + solver-worker feed) before the game screen could open.
- **Warm at boot, with no network dependency.** The startup IIFE now calls `ensureLocalWords()` first thing — the dictionary is a bundled file under Capacitor, so it loads during the intro instead of on the first bot tap. `preloadHomeTabs` also warms before its `/api/me` call now (the old warm at the end of that chain is gone — it was last behind four network calls and never ran offline).
- **The tap no longer waits for the dictionary.** `startOfflineGame` kicks the load off and builds the game at once on a wordless engine (`createEngine(new Set())`) — board, premiums and racks never touch the word list — so the game screen and its 5s countdown open immediately. The dictionary finishes loading behind the countdown and is only needed for the first validation / bot think, both after the countdown. The same treatment for `maybeResumeOfflineGame`: a cold offline relaunch no longer waits for the words before resuming.
- **Guards where words are actually needed.** `doLocalPlay` and `runLocalBotTurn` now await `ensureLocalWords()` if the words are not ready yet, and only show the "needs the dictionary" message if the load really failed (web + airplane mode + cold service-worker cache — impossible on TestFlight, where the file is bundled).
- Verified with a new v112 client harness (21 checks, durable copy in the goal's hidden_files): 8 static — boot warms before the token check, preload warms before `/api/me`, no await on the dictionary in `startOfflineGame` or the resume path, both play/bot guards await it, wordless-engine fallback present, cache v112; T1–T2 run the real `startOfflineGame` — it returns true within 500 ms while the words fetch is still in flight, the game is built on a wordless engine and the screen opens, then the real engine replaces it once the fetch resolves; T3 a warm tap creates no extra engine; T4–T5 the play and bot-turn guards show the dictionary message when the words never load. Regressions: the v109 harness fails only its version pin; the v107 harness fails only its S5/D4/D6 copy checks, which v110 deliberately changed (capitalised search copy) — no v112 regressions. No server change.

## Offline Fishstick tap no longer waits on the server (Jeff's bug, Nov 16, 2026) v113 (Nov 16, 2026, cache v113)

- **The v112 fix was not the delay.** Jeff confirmed he was on build 29 (v112) and the tap still took ~5s. The dictionary load was only part of it: in airplane mode the `POST /api/games` can take seconds to fail instead of failing at once, and on a cold launch `loadMe()` in `startOfflineGame` can hang the same way while the boot `/api/me` is still in flight. Both sat in the tap path ahead of the game screen.
- **Skip the server when offline.** `startGame` now goes straight to the local game for Competitive/Fishstick when `isOffline()` is true — the POST is guaranteed to fail, so it is never attempted. Personas and real-player games keep the old behaviour (tap again to retry) since they have no local version.
- **Bound the online attempt to 1.5s.** When the device thinks it is online but the connection is dead (Wi-Fi with no internet), the whole server attempt — sync + POST — is raced against a 1.5s timeout; on timeout the tap falls back to the local game for bot play and a late server reply is ignored. A fast server is unaffected (sync still runs first, online game as before), and a dead session still goes to the auth screen, not a local game.
- **Persisted user first on a cold launch.** `startOfflineGame` now takes the persisted user before ever calling `loadMe()`, so a cold offline tap never waits on the boot's hanging `/api/me`. Only when there is no persisted user does it fall back to the network.
- Verified with a new v113 client harness (22 checks, durable copy in the goal's hidden_files): 4 static — offline fast path, 1.5s race, persisted-user-first, cache v113; T1–T5 run the real `startGame` — offline never touches the server and starts local in <300ms, a hanging server falls back near the 1.5s bound, a fast server still opens the online game after syncing, a dead session still shows auth, a fast network failure still falls back local; T6 runs the real `startOfflineGame` — with a null `me` and a hanging `loadMe` it returns true in <500ms on the persisted user and never awaits `loadMe`. Regressions: the v112 harness passes except its version pin (expected — the cache is now v113). No server change.

## No "Last known" markers; Global Ranks cached for offline (Jeff's checklist, Nov 16, 2026) v114 (Nov 16, 2026, cache v114)

- **"Last known profile" and "Last known results" are gone.** The two notes that marked cached data as not live — `profileStaleNote` on the Profile tab and `leaderboardStaleNote` on the leaderboards — no longer show. Cached data just renders as-is, with no note. The hidden note elements stay in the DOM; nothing in app.js references them anymore.
- **Global Ranks are persisted for offline (v114).** A new persisted rank cache (`duello_rank_cache` in localStorage) sits next to the session-only `rankCache`: every rank learned is written to both via `setRank()` — the leaderboard load (every row carries the server's true rank, so this covers me and every friend on it), the profile fetch, the person-modal fetch, the Friends-tab warm-fetch, and a new boot warm that fetches friends' ranks once after `loadServerFriends()` even if the Friends tab is never opened. The persisted copy is loaded at boot and survives a reload.
- **Freshness is unchanged online.** The session Map is still cleared when a game ends, so ranks are re-fetched online (the profile, modal, and friends warm-fetch all still fetch on a session-cache miss, and their skip checks stay session-only). The persisted copy is only ever a display value: the offline profile shows the last-known rank instead of '—' and never fetches live (v110 rule kept), and the online profile/modal show the last-known rank while the fresh one loads, then replace it when the fetch lands. The persisted copy is NOT cleared on game end — after an offline game the pre-game rank is the last-known one, which is the point of the cache.
- Verified with a new v114 client harness (15 checks, durable copy in the goal's hidden_files): 8 static — both marker strings gone, no stale-note references, `rankCache.set` only inside `setRank`, leaderboard load caches ranks, offline profile and modal read the persisted cache, cache v114; T1 setRank persists and a fresh context recovers the ranks (session cache starts empty on reload, persisted store is the fallback); T2/T3 run the real `renderProfileUI` offline — persisted rank 42 shows, '—' with no persisted rank; T4 runs the real `ensureGlobalRows` — my rank and both friends' ranks land in the session cache and the persisted store. Regressions: the v112 and v113 harnesses pass except their version pins (expected — the cache is now v114). No server change.

## Forgiving drag and drop; definitions instant and offline (Jeff's checklist, Nov 16, 2026) v115 (Nov 16, 2026, cache v115)

- **Drag and drop is more forgiving.** Two things were making drops miss. First, the ghost floats above the finger (translate -90%), so the tile *looked* like it was over a cell a row above the one it would actually land on — the hit test used the pointer, not the ghost. Both drag handlers (rack tiles and placed tiles) now aim the drop at the ghost's centre via a new `dropCellForPointer()`: the tile lands where it appears to be. The finger still decides whether it is a board drop at all, so a ghost hanging over the board while the finger is on the rack cannot steal a rack drop, and a finger on the top row still lands on the top row (the ghost point is clamped into the board). Second, the board has 3px gaps between cells, and `cellAtPoint()` used to cancel any drop whose pointer sat in a gap or a few px off a cell. It now takes the nearest cell within 12px (about a third of a cell). `nearestEmptyCell()` is unchanged — still orthogonal neighbours only, so a drop over an occupied cell never jumps to a different word.
- **Definitions are instant and offline (v115).** The client now carries its own copy of every bundled definition: a build script (`expanded/build-client-defs.js`) resolves all 138,752 words through the server's own `bundledDefinition` (verbatim, so the bundle can never disagree with `/api/define`) and writes 19 sorted chunks under `public/definitions/` (<=700 KB each, 136,667 words covered, 2,085 still without a bundled definition) plus a manifest naming each chunk's first/last word. `localDefinition()` in app.js binary-searches the manifest, fetches the one chunk holding the word (cached in memory), and `showDefinition()` checks the bundle first — instant, and it works offline (under Capacitor the files are in the app bundle; on the web the service worker now caches `/definitions/*` on first fetch). A Wiktionary-sourced entry is a modern first sense, so it is final; any other entry shows at once and is refreshed from `/api/define` in the background when online, so the live most-common sense still wins where it exists. Words the bundle does not hold fall back to `/api/define` exactly as before.
- **Dictionary rebuild is coming next, not in this version.** Jeff's Nov 16 direction supersedes the first-sense fill that was running: the dictionary is being rebuilt as one curated pick per word — simplest most-common sense, hard cap 150 chars, under 75 when possible (ONE's NATO radiotelephony gloss is the unacceptable example; his ideal is "The number 1"). The fill subagent was stopped; its partial fetch data is on disk as candidate material. v115 ships the drag fix and the offline bundle on the current definitions; the curated dictionary lands as the next version and the bundle build is re-runnable for it.
- Verified with a new v115 client harness (22 checks, durable copy in the goal's hidden_files): 9 static — cache v115 x3, APP_VERSION 115, both drag handlers use `dropCellForPointer`, 12px tolerance, `showDefinition` uses the local lookup with background refresh, sw.js caches `/definitions/`, manifest version 115 with 19 chunks and 136,667 covered, every chunk <=700 KB, chunks sorted with no gaps; T-D1–T-D7 run the real `cellAtPoint`/`dropCellForPointer` against a stub DOM — inside a cell, in a 3px gap, just outside the board edge, drop follows the ghost not the finger, top row still reachable via clamping, ghost over the board with the finger on the rack is no board drop, far outside cancels; T-E1–T-E6 run the real `localDefinition` against a stub fetch — hits in both chunks, the wiktionary flag survives, out-of-range returns null, manifest and chunks each fetched once, offline failure returns null. Regressions: the v114, v113 and v112 harnesses pass except their version pins (expected — the cache is now v115).
- **Server change (caught during verification).** The server is a raw `http` server with a static-file whitelist, and it did not list `/definitions/` — so the bundle files were deployed but the server answered 404 for every one, and the web client would have fallen back to `/api/define` on every tap. The whitelist now includes `/definitions/` (and `.json` gets `application/json`). Note for future checks: `/index.html` also 404s by design — only `/` serves the app shell; that is pre-existing, not a v115 regression.

## Bot games are always native; a local definition hit is final (Jeff's direction, Nov 16, 2026) v116 (Nov 16, 2026, cache v116)

- **Fishstick and Competitive are always native now.** Jeff's three offline bugs (Forfeit unavailable, Fishstick didn't move, dictionary had to load) all traced to one cause: he started the game online, then went into airplane mode, so the game was a server game — Forfeit and the bot turn are server-driven and died silently offline, and the dictionary load was the local validation kicking in when the server went away. Jeff's direction: "Always have fishstick native to the app." `startGame` now routes both bot types straight to `startOfflineGame`, online or offline — the game never touches the server at creation, so a mid-game network drop changes nothing. The local bot move selection already mirrors the server (Fishstick takes the best move, Competitive uses `localEngine.pickCompetitiveMove` at the player's Elo), so strength is unchanged. Personas and real-player games still use the server path (no local version); the now-dead bot fallback in `startGame`'s catch block is gone.
- **Finished local games sync promptly.** `endLocalGame` now calls `scheduleDrain()` after a local game finishes, so the result reaches the server for Elo/stats as soon as the device is online. `drainOutbox` already bails safely when offline, so this is a no-op there and the `online` event still drains it later.
- **Forfeit on a server game fails out loud now.** The forfeit button's `/api/games/:id/forfeit` call had no try/catch — in airplane mode the tap silently died. It now shows "Forfeit needs a connection — reconnect to forfeit." instead. Bot games never reach that code (always native).
- **A local definition hit is final.** `showDefinition` no longer refreshes a local-bundle hit from `/api/define` in the background — the live preference is what overwrote good bundled glosses with bad live ones (ONE's NATO radiotelephony gloss). `/api/define` is now only a fallback for words the bundle does not hold. This ships on the v115 bundle (the curated dictionary is still being rebuilt — it lands as v117, not v116). The dictionary rebuild's fetch is the long pole: ~2,100 words attempted in ~3 hours, ~17,000 still queued, so v117 is an overnight job.
- **Server change held for v117, not shipped here.** The rebuild subagent already edited server.js (`getDefinition` returns any bundled entry at once; `resolveLiveMorph` treats wiktionary/curated cores as final) and bumped APP_VERSION/index.html to 116, but the curated chunk files do not exist yet and the chunk loading is not wired — so server.js is NOT pushed in v116. It ships with the curated data as v117.
- Verified with a new v116 client harness (22 checks, durable copy in the goal's hidden_files): 7 static — APP_VERSION 116, startGame routes bots local before any server attempt, no bot fallback in the server catch, endLocalGame schedules a drain, forfeit handler wraps the call with the connection message, showDefinition treats a local hit as final, cache v116 x3; T1–T6 run the real `startGame` — online Fishstick/Competitive never call the server and start local, online persona still calls the server, syncs first and opens the online screen, offline persona has no local version, offline Fishstick starts local, dead session on a persona shows auth with no local fallback. Regressions: the v115 harness passes 19/22 — the 3 failures are the expected v116 changes (cache v115 pin, APP_VERSION 115 pin, showDefinition background refresh removed). No server change.

## Drop follows the finger; Play Online / Play Friends grey out offline (Jeff's checklist, Nov 16, 2026) v117 (Nov 16, 2026, cache v117)

- **The drop follows the finger, not the tile.** Jeff aims with his finger, and the v115 ghost-centre aiming dropped the tile a row higher than he was pointing (the ghost floats ~a cell above the finger). `dropCellForPointer` now uses the pointer directly — the cell under the finger is the drop. The 12px gap tolerance stays, and the finger still decides whether it is a board drop at all (a ghost over the board with the finger on the rack cannot steal a rack drop).
- **Play Online and Play Friends grey out with no connection.** Both need the server, so `refreshOnlineButtons` disables them and adds the existing `.mode.greyed` style whenever `isOffline()` is true. It runs whenever the Home screen shows and on every `online`/`offline` change, so the buttons follow connectivity live. Bot games stay available — they are always native (v116). A disabled button cannot be tapped, so no extra guard is needed in the tap handlers.
- **The dictionary rebuild is now v118, not v117.** The rebuild subagent is still fetching (~2,100 attempted in ~3 hours, ~17,000 queued — an overnight job). Its server.js edits stay local and unpushed, same as v116.
- Verified with a new v117 client harness (17 checks, durable copy in the goal's hidden_files): 7 static — APP_VERSION 117, cache v117 x3, drop uses the pointer (no ghost reference), 12px tolerance kept, refresh disables + greys both server buttons, show() refreshes them on Home, online/offline listeners refresh them; T-D1–T-D5 run the real `dropCellForPointer` against a stub DOM — finger in (4,3) with the ghost over (2,3) drops at the finger, gap still drops, ghost over board + finger on rack is no drop, far outside cancels, top row still reachable; T-B1–T-B3 run the real `refreshOnlineButtons` — offline disables + greys both, online enables both, going back online re-enables them. Regressions: the v116 harness passes 20/22 — the 2 failures are the expected version pins (APP_VERSION 116, cache v116). No server change.

## Curated dictionary rebuild — one short definition per word (Jeff's direction, Nov 16, 2026) v118 (Nov 17, 2026, cache v118)

- **The dictionary is rebuilt as one curated pick per word.** Jeff's standard, from ONE's NATO radiotelephony gloss: say what kind of thing it is and stop — simplest most-common sense, hard cap 150 chars, under 75 when possible. The build (`expanded/build-curated-dictionary.js`) gathers candidate glosses from every source (WordNet, Webster's 1913, Wiktionary/Kaikki, the 168-entry fill, dictionaryapi.dev, Wiktionary REST), cleans each (first sentence, no parentheticals/brackets, no trailing Latin binomial), shortens it (cut at the first comma/semicolon/colon if the head is complete; cut a trailing relative/participial clause only when the head's final noun is not generic — this is what keeps EYES while cutting KOB), then picks the shortest, with a domain rule so a domain-specific gloss only wins when no non-domain candidate exists. Overrides in `expanded/definition-overrides.json` hold only definitions Jeff himself wrote (ONE, EYES, KOB) and win last.
- **Counts.** Fetch (auto-restart loop, Wiktionary 4s spacing, 10-min backoff on 429): 17,190 queued, 13,930 fetched (11,540 dictionaryapi + 2,390 Wiktionary), 3,260 missed. Build: 87,841 direct entries, 137,436 resolved of 138,752 (99.05%), 1,316 still uncovered — down from 2,054. Length: median 31 chars, p90 68, max 147, 92.5% under 75, 77.3% under 50, **0 over 150**. Ten curated chunks `data/definitions-curated-a.json` through `-j.json`, each ≤700,000 bytes. The old base file and extras a–g stay on disk as raw material but are no longer loaded.
- **Gold standards, exact.** ONE "The number 1." EYES "An organ through which animals see." KOB "An African antelope." KOBS has no separate entry — it resolves via stem KOB (the sheet records it as "override (via KOB)"). Spot checks, old → new: RUN "a score in baseball made by a runner touching all four bases safely" → "Act or instance of running." CRANE "United States writer (1871-1900)" → "Any bird of the family Gruidae." — the bird, not the writer, but it keeps the taxonomic "Gruidae"; flag for Jeff's verdict. OES (was the "A valid Duello word." placeholder) → "The name of the Latin-script letter O." SAGO "powdery starch from certain sago palms" → "A powdered starch." A random 20-word sample all came out short and sensible (longest 88 chars). One style note, not a defect: entries keep their source casing, so many start lowercase ("an exercising weight") exactly as the old definitions did — only Jeff's overrides are capitalised.
- **Server change (ships with v118).** `server.js` loads only the curated chunks a–j (src 'curated'). `getDefinition` returns a curated entry directly as FINAL — no live fetch preference over it; live fetch remains only for words with no curated entry. `resolveLiveMorph` uses a curated core at once. The static-file whitelist already lists `/definitions/` from v115, so the client bundle serves.
- **Client bundle rebuilt (v118).** `expanded/build-client-defs.js` now loads only the curated chunks: 16 chunks under `public/definitions/`, manifest version 118, 137,436 covered, every chunk ≤700,000 bytes. `showDefinition` keeps the v116 local-hit-final behaviour (no background refresh); a local miss still falls back to `/api/define`.
- **The Drive Sheet is live.** "Duello Dictionary" (Word | Part of speech | Definition | Source), 137,436 rows sorted A–Z, header frozen, columns sized — https://docs.google.com/spreadsheets/d/1ERhgq_sDVegzegfYmcV0MDpZEbJXFRKJ8PdS1qQGciY/edit (ID in `expanded/dictionary-sheet.md`). Verified by reading rows back: ONE/EYES/KOB/KOBS/RUN/CRANE all match the curated set. `--update-sheet` diffs the new resolved set against `expanded/curated-previous.json` and updates only changed/added rows (deletes removed rows bottom-up); the no-op test reports "added 0, changed 0, removed 0" and makes no API calls. One fix found while creating it: a 5,000-row append exceeds the kernel's 128KB per-argument limit (`E2BIG`), so batches are 500 rows (the first attempt created a header-only sheet, which was trashed, then recreated cleanly).
- **Fetch war story (for the next long job).** Two VM replacements killed the fetch loop mid-run (Nov 17 ~02:00–03:00 and ~05:04) and wiped `/tmp` — the first loop script and its logs lived there. Progress always survived (`expanded/curated-progress.json`, workspace-persistent), and the loop now lives at `expanded/curated-fetch-loop.sh` with its log at `expanded/curated-fetch.log`, so a future replacement cannot kill it the same way. It resumed correctly both times and finished at 06:39 EST (exit 0). The slow phase is priority 1 (Wiktionary, ~14 words/min with 429 backoffs); priority 2 is dictionaryapi-only and runs ~90 words/min.
- Verified: `node --check` server.js + app.js; `list_still` (curated) 1,316; the v115 harness passes 17/22 — the 5 failures are the expected v118 changes (cache v115 pin, APP_VERSION 115 pin, showDefinition background refresh removed in v116, manifest 115/19 chunks/136,667, and T-D4 drop-follows-the-ghost, deliberately reversed in v117); the v117 harness passes 15/17 — the 2 failures are the version pins only (APP_VERSION 117, cache v117); all finger-drop and offline-button tests pass. Parent's v116 checks still hold: startGame routes both bot types to `startOfflineGame`, endLocalGame schedules a drain, the forfeit handler shows the connection message. No word-list, engine, or other client-code changes.
- **Profile pic preload fix (Jeff's report, Nov 17, 2026).** The pic only painted when the background preload's second /api/me fetch landed, and the preload was a race the user could lose — an idle callback (up to 2s), then a fetch, then a render, then a decode; a failed fetch aborted the whole preload and the latch meant it never retried, so the pic was never preloaded that session. Three changes: (1) boot decodes `me.photoData` at once, during the intro, instead of waiting for the preload's idle callback and second fetch; (2) the preload no longer aborts on a failed /api/me (it falls through to `renderProfileUI`, which retries the fetch and falls back to the cached profile), and its photo warm falls back to `me` when the fetch failed; (3) `renderProfileUI` paints the pic from `me.photoData` at once, before its fetch — so the tab shows the pic the moment it opens, and the fetch only fills the rest / refreshes it. Verified with a new v118 profile-pic harness (8/8): the real `renderProfileUI` paints the pic synchronously before a slow fetch lands, refreshes it to the fetched photo after, and still paints at once offline (cached profile fills it in). The v118 dictionary harness still passes 19/19.

## Privacy Policy under Settings; push notifications for match challenges (Jeff's request, Nov 17, 2026) v120 (Nov 17, 2026, cache v120)

- **The Privacy Policy lives under Settings now.** The main-screen privacy link is gone from the profile screen; the policy is reached from the gear (Settings) screen, in its own section above the push toggle. The sign-in screen link is KEPT — the policy must be reachable at account creation, which is the standard/legal place for it. `public/privacy.html` is unchanged, and the App Store Connect privacy-policy link is untouched.
- **Push notifications for match challenges, with a Settings toggle.** When the toggle is ON (the default for new installs — the server default is `push_enabled TRUE`, and an unset preference reads as on), a challenge to that user arrives as a push reading exactly "@\<challenger username\> challenged you to a match!" Tapping it opens the app straight to the challenge accept/decline window (`openChallengeFromPush` fetches the incoming challenge and shows the same modal the Friends page uses; if the challenge is gone or the user is mid-game it lands on the Friends page instead). The toggle row is hidden on the web build — it only appears inside the iOS app (Capacitor), where a system-permission prompt is part of turning it on. Turning it off posts the preference AND deletes the stored device token, so nothing is sent; turning it on requests the iOS permission first — a denied permission leaves the toggle off and shows a note to enable notifications in iOS Settings. The app never auto-prompts: on boot it only re-registers the token when the preference is already on and permission was already granted.
- **Server.** `initDb` adds a `push_tokens` table (one row per user + device token) and a `users.push_enabled` flag. New endpoints: `POST /api/push/preference` (set the flag), `POST /api/push/token` (register a token, upsert), `POST /api/push/token/delete` (remove one token, or all when no token is given); `GET /api/me` now returns `pushEnabled`. `POST /api/challenges` calls `notifyChallengePush` fire-and-forget after the insert, so a push failure can never break the challenge itself. The send path gates in order: real user only (personas live in a separate table and can never be targets — a challenge to a persona username is still a 400), preference on, a stored token, APNs configured. The APNs send is a signed ES256 JWT (cached 50 min) over Node's built-in http2 to api.push.apple.com, topic com.duellogame.app, 5-minute expiry, payload `aps.alert.body` exactly "@\<username\> challenged you to a match!" plus `type: 'challenge'` and the `challengeId` for the tap. A 410 (dead token) deletes the token row so the next challenge sends nothing for that device. Web push is OUT of scope — it needs VAPID keys, a web-push library, and service-worker push handling, none of which this build adds.
- **iOS.** `@capacitor/push-notifications@8.1.3` added to `~/workspace/duello-ios/` (package.json + package-lock.json) and synced (`npx cap sync ios` — Package.swift now includes CapacitorPushNotifications, capacitor.config.json lists the plugin). New `ios/App/App/App.entitlements` (`aps-environment` = production), wired into the Xcode project (`CODE_SIGN_ENTITLEMENTS = App/App.entitlements;` in both App-target Debug and Release configs). No Swift changes were needed (the standard Capacitor AppDelegate; the plugin handles registration natively).
- **What Jeff still needs to provide before a push can actually send — the APNs auth key is MISSING.** No APNs key exists in either repo or on this VM. The `.p8` at `~/workspace/user/files/AuthKey_YJR4RJZJL2.p8` is the App Store Connect API key ('Duello CI') — it is NOT an APNs key and must never be used for APNs. Jeff must create a new APNs auth key in Apple Developer → Certificates, Identifiers & Profiles → Keys (with the Apple Push Notifications service enabled) and provide the `.p8` file contents plus its Key ID. The server reads it from env: `APNS_KEY_ID`, `APNS_TEAM_ID` (defaults to JP6TX47769), and `APNS_KEY` (PEM contents) or `APNS_KEY_FILE` (path). Until then the server runs fine and challenges work — pushes just do not send (`apns-not-configured`). The provisioning profile ('Duello App Store', secret `IOS_PROVISIONING_PROFILE`) must also be regenerated with the Push Notifications capability, or the TestFlight build will fail signing once the entitlements ship.
- **Ship plan (Jeff, Nov 17, 2026): web first, TestFlight after he has seen the web.** The botplay (web) side ships first; the duello-ios side is staged in `~/workspace/duello-ios-paths-v120.txt` and is NOT to be pushed until Jeff approves after seeing the web.
- Verified: `node --check` server.js + app.js + engine.js + engine-worker.js + sw.js. New v120 client harness (35 checks, durable copy in the goal's hidden_files): 8 static — APP_VERSION 120, cache v120 x3, privacy link in Settings / not on the profile screen / still on sign-in, toggle row in Settings, switch styles; P1–P9 run the real client code against a stub DOM — exact push text, web row hidden, iOS row shows + reflects the preference, toggle ON posts preference + token, toggle OFF posts preference + deletes the token, denied permission posts nothing + shows the note, push tap opens the accept/decline window naming Neo/@neo, push tap with a gone challenge lands on Friends with no window, foreground push re-fetches incoming at once, boot re-registers the token. New v120 server harness (27 checks): the real server.js in a vm with a FakePool and real HTTP, the APNs HTTP/2 call stubbed — challenge to a push-enabled user with a token sends exactly "@jeff challenged you to a match!" with `{type:'challenge', challengeId}`; push-disabled user, no token, and APNs-unconfigured all still create the challenge (200) with no push; a persona username is a 400 with no push; token register (upsert, no duplicates), preference, `/api/me` pushEnabled, and token delete all behave; a 410 deletes the dead token and the next challenge sends nothing. Regressions: v118 profile-pic 8/8; v118 dictionary, v117, v116, v114, v112, v108, v104-client, v103, v102-client, v98, v93 — only their version-pin checks fail; v102-server, v104-server, v105-engine, v106-server all pass. The other failures in v106/v107/v109/v113/v115 are the expected later-version changes (v111 removed the pending Elo marker, v114 removed the "Last known" markers, v116 made bot games always native, v117 reversed the drop-aiming test, plus copy polish) — none of them touch the v120 code paths.

## Full dictionary audit — every definition a simple most-common American sense (Jeff's direction, Nov 17, 2026) v121 (Nov 17, 2026, cache v121)

- **Version note: this is v121, not v119.** Jeff directed the full audit Nov 17, 2026 ("Audit all definitions for every single word. Correct to a simple version of the most common American definition") and was told it would ship as v119. While the audit ran, the Duello side chat shipped v120 (privacy policy under Settings + push notifications for challenges) in the same working tree — APP_VERSION was already 120 when the audit finished, and the live site is still v118 (v120 is built, web-first, awaiting Jeff's go). Downgrading to v119 would break v120, and folding the audit into v120 would conflate two features, so the audit ships as the next version, v121. Nothing about the audit itself changed — only the number.
- **The audit.** The v118 curated dictionary (87,841 direct entries, 137,436 resolved of 138,752) was audited word by word against Jeff's standard: simplest most-common AMERICAN sense (American usage/spelling, not British/archaic/rare), say what kind of thing it is and stop, strip parentheticals/trailing clauses/examples/taxonomic Latin, hard cap 150 chars, under 75 when possible, one sentence, core-word only, no pointer glosses, no invented definitions, no circular glosses, plain everyday words ("sea snail" not "gastropod", "bird" not "avian"). The audit script (`expanded/audit-v119.js`) flagged 8,915 words in 10 categories: raresense 1,358, latin 1,213, toolong 2,016, long 4,271, british 238, pointer 95, domain 8, archaic 13, circular 2.
- **Corrections: 2,374 overrides, in three layers.** (1) Automated (`correct-v119b.js`, 1,006): a raresense arbiter (WordNet's frequency-ordered first sense decides — the v118 pick is kept when it already matches, which caught 1,148 false positives), a consensus pick (corroboration across sources, then WordNet-first match, then source priority, then shortest), an expanded pointer filter, and a `polish()` pass (plain-word substitutions, A/An agreement, citation stripping, truncation repair). The first correction script (`correct-v119.js`, 125 words) was reviewed and discarded — it trusted dictionaryapi.dev's first sense blindly, which is wrong ~13% of the time (ACER → "acre", AG → "agriculture", AH → "I", AMBER → "ambergris", ART → "music"). (2) Manual (277 + 120 + 136 + 4 = 537 entries across `manual-corrections-v119.json`, `manual-corrections-v119-ing2.json`, `manual-corrections-v119-long.json`): the 34 over-100 fixes, wrong-sense fixes (ACER, AG, AH, ALBUM, AMBER, ART, AERIE, ADDLE), the 33 simplified -ing/past-tense glosses, the long-fetch fixes, the grammar fixes ("A shrubs" → "A shrub"), the British fixes ("coloured" → "colored"), and the core-word mismatch fixes below. (3) Fetch (1,151): dictionaryapi.dev first senses for the 850 refetch + 1,840 unresolved words (2,690 attempted, 1,715 fetched, 975 missed — obscure words with no dictapi entry), processed through the same shorten+polish+isBad pipeline; refetch words (correctness problems) accept a correct definition even if long, unresolved words (length only) accept only a definition under 75.
- **Counts.** 8,915 flagged → 2,374 corrections applied (1,006 auto + 537 manual + 1,151 fetch, minus overlap; 2,374 overrides total including Jeff's 3 gold standards). Kept as-is: 1,148 raresense false positives (v118 pick already the most common sense), 4,075 long words with no shorter candidate on disk, 1,840 unresolved (no fetch result short enough — they keep the v118 definition, which is also long, so nothing got worse). Length (full resolved set, 137,436 words): median 31, p90 65 (was 68), max 145 (was 147), 93.8% under 75 (was 92.5%), 78.5% under 50 (was 77.3%), **0 over 150**. The 2,374 corrections themselves: median 24, p90 60, max 75, **0 over 75**. Coverage unchanged: 137,436 resolved, 1,316 uncovered (fallback "A valid Duello word.") — coverage was not a goal.
- **Gold standards, exact.** ONE "The number 1." EYES "An organ through which animals see." KOB "An African antelope." Spot checks, old → new: CRANE "Any bird of the family Gruidae." → "A tall bird with long legs." (Jeff's wording) · ABALONE "A large edible marine gastropod." → "A large edible sea snail." · ACER "An English unit of land area…" → "A maple tree." · ALBUM (photo album) → "A collection of songs." · AMBER (ambergris) → "A hard yellow substance from ancient trees." · ANIME "a hard copal." → "Japanese animation." · RUN "Act or instance of running." (unchanged) · OES "The name of the Latin-script letter O." (unchanged) · SAGO "A powdered starch." (unchanged).
- **Two bugs caught by the harness, both fixed.** (1) Core-word mismatches: the build maps plurals/forms to a base word and applies its override, but for proper names the plural means something else — JOSEPHS (garment) got JOSEPH's (Chief Joseph) definition, POLOS (game) got POLO's (Marco Polo), SCHILLERS (mineral sheen) got SCHILLER's (writer), TAWNEYS (color) got TAWNEY's (economist), TITIANS (color) got TITIAN's (painter), DAWKS (postal relay) got DAK's (tree). All 14 affected words (including DINGEY, ENDITED, JIN, KERNINGS) now have explicit overrides with the correct sense. The two genuine plural-of-singular cases (EPHORI ← EPHOR, HEXAMINES ← HEXAMINE) correctly share the definition. (2) Latin the audit missed: the harness's Latin regex found 138 more hits the audit's narrower check skipped ("type genus of the Xaceae", "genus Y", "family Z") — all 136 real ones fixed (e.g. ALBUGO → "A fungus.", ANAS → "A duck.", RANA → "A frog.", VESPA → "A wasp."); the 2 remaining "hits" are false positives the regex catches (FASCISTA "Mussolini", GEMINI — proper names ending in -ini), excluded in the harness with a comment. Also fixed: `updateServerChunkList` called `process.exit(1)` when server.js was already on the curated chunks (v118+), which aborted `--build` before it wrote `curated-current.json` — it now logs and returns, so the sheet diff works.
- **Client bundle rebuilt (v121).** `expanded/build-client-defs.js`: 15 chunks (was 16 — shorter definitions pack tighter), manifest version 121, 137,436 covered, every chunk ≤700,000 bytes. Server chunks `data/definitions-curated-a.json`–`-j.json` rebuilt, same 10 files, each ≤700,000 bytes. `server.js` needs no change (it already loads the curated chunks a–j).
- **The Drive Sheet is updated.** "Duello Dictionary" (ID 1ERhgq_sDVegzegfYmcV0MDpZEbJXFRKJ8PdS1qQGciY): `--update-sheet` wrote 3,672 changed rows in the first pass (2,188 direct changes + morphs/plurals that resolve through a changed base word) and 195 more in the second pass (the Latin fixes), 0 added, 0 removed. Verified by reading rows back: CRANE "A tall bird with long legs." (override), SCINCOID "Relating to skinks." (override). Baseline advanced to v121.
- Verified: `node --check` server.js + app.js + engine.js; `list_still` 1,316 uncovered (unchanged). New v121 audit harness (25 checks, durable copy in the goal's hidden_files): version pins (APP_VERSION 121, cache v121 x3, manifest v121), every client + server chunk ≤700 KB, 87,841 direct entries, length (0 over 150, median/p90 no worse than v118), **0 taxonomic Latin in the curated set**, gold standards exact, KOBS no direct entry, spot checks (RUN/CRANE/OES/SAGO/ABALONE/ACER/AMBER/ALBUM/ANIME), covered + 1,316 = 138,752, server loads only curated chunks, getDefinition returns bundled as final. Regressions: v118 dictionary harness fails only on the 5 expected audit changes (S1/S2/S3 version pins, S6 length improved, S12 CRANE fixed); v118 profile-pic 8/8; v120 server 27/27; v120 client fails only on its 2 version pins (cache v120, APP_VERSION 120). **Not pushed — the parent ships web + TestFlight (batched). Live is still v118; v120 is also unpushed (web-first, awaiting Jeff's go).**

## Privacy Policy link into the Settings section (Jeff's follow-up, Nov 17, 2026) v122 (Nov 17, 2026, cache v122)

- **Why:** v120 moved the Privacy Policy link to the Settings (gear) screen, but it landed at the bottom of the Edit Profile screen, outside the settings-section div — Jeff couldn't find it on the web. The v121 dictionary push (main chat) also overwrote the v120 index.html in the race, so the move wasn't clearly visible.
- **Fix:** the Privacy Policy link now sits inside the settings-section div at the top, above the Push notifications toggle, so it is unambiguously in Settings (gear → Edit Profile → Privacy Policy, first item). The sign-in screen link is unchanged. No app.js logic change; version bumped to v122 (cache v122 x3, APP_VERSION 122, sw cache duello-v122) so the new index.html is picked up.
- Verified: `node --check` clean on app.js, server.js, sw.js. Web-first push; iOS staged.

## Profile up, disconnect/exit, Leave, 7s Play Online matchmaking, post-game replay, Past Games (Jeff's 6-item list, Nov 17, 2026) v123 (Nov 17, 2026, cache v123)

- **Profile tab closer to the Dynamic Island.** `.profile-top` padding-top 28px → 8px. The `.screen` safe-area padding (`calc(28px + env(safe-area-inset-top))`) still clears the island, so the pfp sits nearer it without touching it. CSS only; no layout change elsewhere.
- **Disconnect / exit (real-player games only).** Presence is an in-memory last-seen map (`presenceByGame`, gameId → {challengerId, opponentId, lastSeen}), touched on every game GET/play and by a new client heartbeat (`POST /api/games/:id/heartbeat`, every 5s while a human game is open — the heartbeat exists because on your own turn no poll runs, so without it a thinking player would look gone). The remaining player's client fades the opponent's pfp grey (`.panel .pfp.gone`, opacity .35 + grayscale) once the opponent is unseen for >10s (`opponentConnected` in the serialized game). At 30s unseen, the next request from the remaining player (GET or heartbeat) ends the game: the gone player loses, the remaining player wins, Elo moves, and the reason reads exactly "<FirstName> exited the game." If they return within 30s, play resumes (their clock kept ticking while away). The rule only runs once the game has started (before that, the countdown fallback owns a no-show) and never applies to bot games (bots are local/server-driven, no presence entry exists for them). The offline clock-pause rule (v107) is untouched — offline bot games never touch presence. Interpretation: the 30s clock is measured from the last heartbeat/GET, not from the moment the connection drops, so a player whose phone dies mid-turn is given the full 30s from their last seen request. Limitation: presence is in-memory, so a server restart clears it (a fresh game just reads as "connected" until the next heartbeat).
- **Leave (out of time + losing).** When your clock hits 0 AND you are behind on score, the Forfeit button relabels to "Leave" (out of time but not losing stays "Exit"; time left stays "Forfeit"). Tapping Leave exits you to the main menu at once with no stat window; the game is recorded as a loss for you and your Elo moves immediately. For a real-player game the game stays ACTIVE for the opponent: `applyLeave` records `leftBy` (your side), the winner (the opponent), the reason "<FirstName> left the game.", and both Elo moves now, then the opponent keeps playing words against the absent player. When the opponent finally finishes (clocks / no moves / their own forfeit), `endGame` finalizes it without touching the recorded winner, reason, or Elo again (the `leftBy` guard). The leaver's own view of the game reads 'finished' (serializeGame flips the status for the leaver only); the opponent's view reads 'active' with `opponentLeft: true`. For a bot game there is no one to play out, so Leave is a plain forfeit (the game ends outright). Note: the server does not enforce the "out of time + losing" precondition — the client only offers Leave then; the endpoint itself just applies the leave. A stale `pendingMatches` entry is also cleared when a player loads a game directly (a paired player who reached the game without polling matchmaking would otherwise be handed that old game on their next search).
- **Play Online matchmaking (7s).** `startSearching` now polls `POST /api/matchmaking/search` once a second for 7 seconds. The server keeps an in-memory queue (userId → joinedAt, 15s TTL, pruned on every search); a searcher is paired with the longest-waiting other player, a human game is created for them, and the waiting player finds it on their next poll (`pendingMatches`). If no real opponent appears in 7s, the client cancels the queue entry and assigns a persona (one of the 100 fake "human" players) — the game starts as a persona game and counts as human stats, as personas do. Cancelling the search (or navigating away) withdraws the player from the queue. While offline the screen still says exactly "searching for internet connection" and waits, re-checking every 2s, before the 7s window starts (the string was restored to the exact v107 wording — it had drifted to "Searching for internet connection…").
- **Post-game board review (5 buttons).** The end row is now Main Menu, ←, Play Again, →, Game Stats. The arrows step through the game move by move. A chronological `moveLog` is recorded in `applyMove` (server) and `applyLocalMove` (client, offline games) — every placed move, in the order played, with its placements, words, and score (passes change no tiles, so they are not logged; a clock-0 stretch where one side plays several moves in a row replays in exactly the order played). The finished game serves its `moveLog` (only when finished, so the 1s polls stay light). The replay rebuilds the board from the empty board plus the placements of moves[0..n], with the running scores and a status line naming the step ("Move 3 of 14: You played CAT +12"); the last move applied is highlighted. The arrows disable at the ends (back at the start, forward at the final board). Old games (no moveLog) show the final board only — the arrows do nothing. Offline games sync their moveLog with the game (the sync payload's state carries it), so a synced offline game replays too.
- **Past Games.** A "Past Games" button sits below the profile stats. It opens a list from a new `GET /api/games` (finished games only, newest first, 50 max) — each row shows the opponent, a W/L/D badge, the score, and the date. Tapping a game opens its final board in review mode (the review row: Exit, ←, →, Game Stats — no Play Again, it is a past game), with the same moveLog replay. The auto stat window is suppressed on entry; Game Stats opens it on demand. Past Games needs a connection (a note says so offline).
- Verified: `node --check` server.js + app.js + engine.js + engine-worker.js + sw.js. New v123 server harness (49 checks): matchmaking pairing + pending-match pickup + lone searcher queues + cancel removes the entry; presence fade at 12s, exit at 30s with the exact reason and the remaining player winning + Elo moving, no exit before the game starts, no presence on bot games; Leave on a human game (leaver loses, Elo moves now, game stays active for the opponent with opponentLeft, leaver's view finished, play-out finish does not move Elo twice and keeps the recorded winner/reason), Leave on a bot game ends it outright; moveLog recorded with placements/side/words/score and served on the finished game; GET /api/games lists finished games newest first with opponent/result/score/dates and excludes active games, 401 without a token. New v123 client harness (44 checks): static (profile padding 8px, cache v123 x3, APP_VERSION 123, 5 end buttons, review buttons, Past Games button/screen, pfp fade class, list styles); Leave label (Leave/Exit/Forfeit), Leave tap POSTs /leave and goes home with no stat window; pfp fade on/off; the 5s heartbeat POSTs while a human game is open; a real match in the 7s window joins the human game; no match in 7s assigns a persona; replay steps the board + scores through the log with the arrows disabling at the ends; no moveLog means no replay; the Past Games list renders; a past-game detail opens in review mode with the review buttons and no auto stat window. Regressions: v102-server, v104-server, v105-engine, v106-server, v120-server all pass. Client regressions fail only on the known items: version pins (v93/v98/v102/v103/v104/v107/v108/v109/v120 cache + APP_VERSION), the v116 native-bots staleness (v106 C7, v109 T5), the v114 "Last known" marker removal (v107 D5/D7), the v111 pending-marker removal (v106 C4), a string drift (v107 D6), and v107 D4.3 — the 7s matchmaking window is longer than that test's 6.5s wait, so the persona fallback lands after the test checks; that is the intended v123 behavior (Jeff's 7s), not a regression. D4.1/D4.2 were fixed by restoring the exact v107 offline-search string.

## Game History fixes (Jeff's 9-item list, Nov 17, 2026) v124 (Nov 17, 2026, cache v124)

- **The tap-did-nothing bug (root cause).** Jeff played a game, went to history, tapped it, and nothing happened. The cause was a server crash in `serializeGame`: a synced offline bot game stores `botRackCount` but **no `botRack`** (the bot's rack never leaves the device, per the v116 native-bots rule and the sync payload), and `serializeGame` read `game.botRack.length` on that row — a TypeError, so `GET /api/games/:id` returned 500 and the client's catch swallowed it silently. The list endpoint doesn't use `serializeGame`, which is why the list rendered but the tap died. Fix: `serializeGame` is defensive now — `humanRack` falls back to `[]`, and `botRackCount` falls back to the stored `botRackCount` when there is no `botRack` (both for the viewer and the flipped opponent view). A failed detail fetch now also shows a visible "Could not open that game." note in the list instead of failing silently (deduped by a module flag that resets whenever the list is rebuilt).
- **Renamed to Game History.** The profile button, the list heading, and the offline/load-failure copy all read "Game History" now. The username shows under the heading (`@username`, from `me` or the loaded profile), so it's clear whose history it is.
- **Replay status without the count, point bubble per step.** The replay status no longer says "Move x of y" — it reads "Start of game", "Final board", or "You played CAT +12" (opponent moves read the opponent's name). As you step through, the point bubble rides each play: `renderReplay` calls `attachBubble` with that move's score on its last placed tile (a pass has no placements, so no bubble). The review entry now starts at the final board (`replayIndex = moveLog.length`), so the arrows, the status, and the final move's bubble are all set up the moment the game opens instead of waiting for a tap.
- **Deck gone, arrows in their own row.** Once a game is finished, the rack (deck) is hidden and a shared back/forward arrow row appears in its place, above the buttons — one row, used by both the post-game replay and the Game History review (the old separate review arrows are gone). The buttons underneath are unchanged: Main Menu / Play Again / Game Stats after a game, Exit / Game Stats in a history review. A live game keeps the deck and hides the arrows. A finished game with no moveLog shows the arrows disabled rather than live-looking dead ones.
- **Menu buttons restyled, tabs scroll to top.** The Game History and Back to Profile buttons are now `.menu-btn` — full-width, Duello blue, the same 9px padding / 13px / weight-800 shape as the Aggregate tab. Switching tabs always opens at the top: `show()` calls `window.scrollTo(0, 0)` and resets the shown screen's `scrollTop`.
- Verified: `node --check` server.js + app.js + engine.js + sw.js. New v124 client harness (66 checks, durable copy in the goal's hidden_files): static (cache v124 x3, APP_VERSION 124, endButtons 3 buttons with no arrows, reviewButtons 2 buttons with no arrows, the shared replayArrows row, Game History button + heading + username div, `.menu-btn` and `.replay-arrows` CSS); the v123 scenarios still pass (Leave label/tap, pfp fade, heartbeat, matchmaking match/fallback); replay steps the board + scores with no "Move x of y" in the status, a point bubble rides each step with that move's score (+12 on the last CAT tile, +13 on the last DOG tile), no bubble at the start, status "Final board" at the end; a no-moveLog game cannot step AND both arrows are disabled; the Game History list renders with the username (@jeff); a detail opens at the final step with the review buttons, status "Final board", forward disabled / back live, and the final move's bubble; a failing detail fetch shows the note and keeps the list; a finished game hides the deck + shows the arrows, a live game shows the deck + hides the arrows; a tab switch scrolls the window to the top. New v124 server harness (57 checks): the v123 scenarios (49) all pass, plus S1 — serializeGame does not throw on a synced game with no botRack and falls back to the stored botRackCount (4), keeps the human rack and the moveLog, and GET /api/games/:id returns 200 with the game, its moveLog and botRackCount, the final board with both words on it, and the game shows in the history list. Note: the v124 server run 1 of 4 showed the R1 replay scenario failing ("Not your turn") — a pre-existing timing flake in that scenario's bot-game countdown race, not a v124 regression (the v123 file is byte-identical in R1 and the v124 server.js change does not touch turn logic; runs 2–4 passed 57/57). Web-first push; iOS staged (TestFlight still on hold — APNs key + provisioning profile).

## Game History polish (Jeff's 6-item list, Nov 18, 2026) v125

- **Arrows match the lower buttons.** The replay arrows are now the same button as Main Menu / Play Again / Game Stats: 46px tall, 14px border-radius, 2px border that is transparent until enabled (then Duello blue), weight 700. The arrow glyphs stay 20px so they read clearly. (`.replay-arrows .replay-btn` now mirrors `.controls button`.)
- **Exit shows the history at once.** The list is cached when it first loads (`pastGamesCache`), and Exit from a review renders the cached list immediately — no re-fetch, no Loading note. If there is no cached list (a direct review entry), it falls back to a fresh fetch.
- **Fishstick arrows fixed.** Root cause: the arrows' `disabled` flag is sticky across games. `renderReplay` is the only thing that sets it, and it only runs while `replayIndex` is set — but a fresh finish starts with `replayIndex` null, so nothing ever re-enabled the arrows after a previous no-log game (or a replay left at an end) disabled them. That is why Fishstick's arrows did nothing. Fix: `renderGame` now initialises `replayIndex` to the final board (`moveLog.length`) the moment a finished game with a log renders, so `renderReplay` runs and sets the arrows (back live, forward off at the final board) from the first render. The no-log guard still disables both arrows for a game with no log.
- **History text bold like Aggregate.** The `@username` line under the heading is now weight 800 (was 700), and the opponent username in each row is weight 800 — the same weight as the Aggregate tab label. The heading was already 800.
- **Opponent pic + username in the rows.** The W/L badge is gone. Each row now shows the opponent's profile pic and username, then the score and date. The username is Duello blue when you won, white when they won. Server: GET /api/games now returns `opponentUsername`, `opponentPhoto`, and `opponentKind` per row (persona/human carry the photo; Fishstick gets the fishstick image and Competitive Bot the robot on the client).
- **Even vertical spacing.** The Game History screen is a flex column with one 16px gap, so the heading, the `@username` line, and the game log are evenly spaced instead of stacked with ad-hoc margins.
- Verified: `node --check` server.js + app.js + engine.js + sw.js. New v125 client harness (87 checks, durable copy in the goal's hidden_files): static (cache v125 x3, APP_VERSION 125, arrows match the lower buttons — 46px, radius 14px, border transparent -> blue — history text weight 800, row pic + win/loss username colors, history screen flex column with an even gap); the v123/v124 scenarios still pass (Leave, pfp fade, heartbeat, matchmaking, replay + bubble, no-log arrows disabled, Game History list/detail/fail, deck/arrows layout, tab scroll); Game History rows show the opponent pic + username in the right colour (Competitive Bot loss white + robot, @neo win blue + silhouette, Fishstick win blue + fishstick image) with no W/L badge; the Fishstick arrows are live even when both were stuck disabled by a previous no-log game, and stepping back works; Exit from a review shows the cached list at once with no new fetch. New v125 server harness (59 checks): the v123/v124 scenarios pass, plus G1h/i — the list row carries opponentUsername, opponentPhoto and opponentKind (Competitive Bot row: 'Competitive Bot' / competitive / null photo; human row: '@neo' / human). Note: the v125 server run shows the R1 replay scenario failing intermittently ("Not your turn", 400) — the same pre-existing timing flake in that scenario's bot-game countdown race as v124, not a v125 regression (the v125 server.js change touches only the GET /api/games list handler, which R1 never calls; passing runs are 59/59). Web-first push; iOS staged (TestFlight still on hold — APNs key + provisioning profile).

## Game History: background load, bold button, @fishstick, fishstick pic on black, clock rewind, blank last play (Jeff's 6-item list, Nov 18, 2026) v126

- **History loads in the background.** `preloadHomeTabs` now fire-and-forget fetches `GET /api/games` at the end of its warm sequence, so the list is already in `pastGamesCache` before the profile tab's Game History button is ever tapped. `openPastGames` renders the cached list at once — no Loading note, no wait — and then quietly re-fetches in the background (`refreshPastGamesCache`), re-rendering only if the game-id list changed, so a game finished since the warm still appears. If there is no cache (offline at warm, or a first-open race), it fetches on tap exactly as before. A failed background fetch just leaves the cache empty.
- **Game History button bold like Aggregate.** `.menu-btn` no longer sets its own `font-family` — it inherits the body font stack exactly like `.stats-tab` (Aggregate), which is the only difference that was left between the two. Weight 800 and 13px are unchanged.
- **Fishstick is @fishstick, and nobody can take the name.** The history list now shows `@fishstick` for Fishstick games (server returns `opponentUsername: '@fishstick'`). A new `RESERVED_USERNAMES` set (just 'fishstick' for now) is checked in both username paths — sign-up and change-username — and both return the existing "That username is taken." 400. Usernames are lowercase-only by the existing regex, so a lowercase comparison is enough.
- **Fishstick's pic sits on the black.** A Fishstick row's pic span gets a `past-game-pic-plain` class: transparent background, no round mask, and the PNG shown whole (`object-fit:contain`) instead of cropped into the grey circle. The transparent PNG (v94/v95) now reads directly on the row's dark background. Other rows keep the grey circle.
- **The clocks rewind with the arrows.** Every moveLog entry now carries `clocks: {human, bot}` — the remaining time on each clock right after that move. The server captures them inline in `applyMove` (settleClock already ran in every path, so they are the settled post-move values). The client captures them inline in `applyLocalMove`, and for a bot move re-stamps them after `stepLocalBotClock` (the 20s step-down runs after the log push, so the inline capture would be up to 20s high). `renderReplay` sets the clocks per step: step 0 is 4:00/4:00, the final board shows the game's actual final clocks, and a step in between shows the clocks stored with that move. Entries logged before v126 carry no clocks — they fall back to the final clocks rather than showing a wrong time, so the rewind only works for games played from v126 on (it cannot be backfilled). `tickClocks` skips its display writes while a replay is open (`replayIndex !== null`), so the 100ms tick cannot overwrite the rewound step clocks with the final values; clearing the replay restores the final clocks on the next tick. Passes are not in the moveLog, so a pass's -30s is absorbed into the next word play's stored clocks. Note: the first build of this had a TDZ bug — the clock block read `total` before `const total = log.length` was declared later in the same function, which threw on every replay step past 0 and broke all replays and history reviews. The harness caught it before the push; `total` is now declared at the top of `renderReplay`.
- **The last-play line is blank after a game / in a review.** `renderGame` now forces the `#lastPlay` line empty whenever `game.status === 'finished'`, so the move below the scoreboard disappears on the post-game screen and in a Game History review (the replay status names the move instead). A live game still shows its last play.
- Verified: `node --check` server.js + app.js + engine.js + sw.js. New v126 client harness (103 checks, durable copy in the goal's hidden_files): static (cache v126 x3, APP_VERSION 126, `.menu-btn` weight 800 with no font-family of its own, `.past-game-pic-plain` transparent with `object-fit:contain`); the v123–v125 scenarios still pass (Leave, pfp fade, heartbeat, matchmaking, replay + bubble, no-log arrows disabled, Game History list/detail/fail, deck/arrows layout, tab scroll, Fishstick arrows, Exit cached); Game History rows show `@fishstick` in blue with the plain pic class; the background warm populates the cache and opening renders it at once with no Loading note; the clocks rewind per step (final 3:45/3:48, step 1 3:45/4:00, step 0 4:00/4:00) and the tick does not overwrite them during a replay; `#lastPlay` is empty on a finished game and still shows on a live one. New v126 server harness (65 checks): the v123–v125 scenarios pass, plus R2 — a moveLog entry carries `clocks` with numeric human/bot in 0..240000; G1j — a Fishstick list row carries `opponentUsername '@fishstick'` and `opponentKind 'fishstick'`; U1 — sign-up and change-username both reject 'fishstick' (400, "taken") and the existing username is unchanged. Note: the v126 server run shows the R1 replay scenario failing intermittently ("Not your turn", 400) — the same pre-existing timing flake in that scenario's bot-game countdown race as v124/v125, not a v126 regression (the v126 server.js change does not touch turn logic; passing runs are 65/65). Web-first push; iOS staged (TestFlight still on hold — APNs key + provisioning profile).

## Dictionary Latin cleanup (Jeff: "Fix whatever you need to fix", Nov 18, 2026) v127

- **What it is.** Jeff didn't understand the CRANE question and said to just fix it. The v118 dictionary still carried taxonomic Latin in the live app despite the Nov 16 rule (simplest most-common sense, say what kind of thing it is and stop, strip taxonomic Latin). CRANE itself was already "A tall bird with long legs." (v121), but ~800 other definitions still had Latin. This version fixes all of them.
- **The fix, by the numbers.** Definition overrides grew from 2,374 (v121) to 3,026. Coverage: 137,438 of 138,752 words resolved (up 2), 1,314 uncovered (down 2). Median def length 30 chars, max 145, 0 over 150. The Duello Dictionary Sheet in Drive was updated in the same pass (2 rows added, 713 changed, 0 removed) and reads back correct (CRANE "A tall bird with long legs.", ABALONE "A large edible sea snail.").
- **Where the fixes came from.** The prepared v119-latin-cleanup candidate (1,384 mechanical fixes) overlapped heavily with v121: 841 were already overridden (v121's wording kept — it is cleaner, e.g. ABALONE "A large edible sea snail." beats the candidate's "A large edible marine gastropod."), so 543 were actually merged. The candidate's 49 "A + vowel" article errors ("A orchid", "A insect", "A Old World herb") were fixed in the merge, and verb forms that carried the noun's definition were given verb definitions (BREAMED "Cleaned a hull by burning.", SQUASHES "Crushes.", PALMED "Concealed in the hand."). 59 flagged words were hand-written (CLITIC "A word attached to another word." — the old def "The clitoris." was wrong; MUSIVE "Relating to mice."; PETERED "Faded away."; BROMELIAD "A tropical plant."; ANGLEPOD "A vine."). A further 26 pre-existing v121 overrides still held bare Latin binomials the v121 audit missed (BALATA "Manilkara bidentata.", BEETS "Beta vulgaris.", SUNN "Crotalaria juncea.", LAPIS "Lapis lazuli.") — all replaced with plain defs. 22 "genus of ..." taxonomic descriptions were replaced too (BAPTISIA "A flowering plant.", CALTHA "A marsh flower.", PTERANODON "A flying reptile.", THYMUS "An herb.", ZYGOCACTUS "A cactus."). Plurals with their own direct entries were fixed alongside their singulars (ANGLEPODS, BEECHDROPS, BLOODFIN/BLOODFINS, DILL/DILLS, MEDAKA, MILKFISH, ORIBI, SIKA, WAHOO, etc.).
- **Verification.** The rebuilt server chunks (data/definitions-curated-a.json–j.json, 10 chunks) and client chunks (public/definitions/chunk-01..15.json, manifest v127) were scanned: 0 taxon phrases (family/genus/order + Latin name) and 0 -idae/-aceae/-inae, 0 real Latin binomials (verified by a word-frequency scan — the only 2-word defs with both words rare are proper/chemical names like "Brit milah.", "Ammonium picrate.", "Arabian jasmine."), 0 defs over 150 chars. The remaining "family/tribe" hits are false positives in the plain-English sense (a family of sauces, a nomadic tribe, a family of languages, a family of cheeses). A diff against the v126 backup shows only the intended changes: server 672 changed + 567 added direct entries, client 275 changed + 2 added; the 43 client changes not directly in the override list are plural/derived forms resolving via a fixed base word (BALATAS via BALATA, CLITICS via CLITIC, DILLED via DILL), which is the intended behaviour. No game logic, UI, or server endpoint changed in v127 — dictionary data only.
- Verified: `node --check` server.js + app.js + engine.js + sw.js. New v127 client harness and server harness (durable copies in the goal's hidden_files) cover the version pins, manifest v127, the plain defs above, and the 0-Latin / 0-over-150 scans. Web-first push; iOS staged (TestFlight still on hold — APNs key + provisioning profile).

## Home redesign: blue mosaic + daily hook, Daily Puzzle (Jeff's pick: combined preview 1, Nov 18, 2026) v131

- **What it is.** Jeff picked the first combined preview (full-height stack) from the home-page mockup: the faint mosaic background merged with the daily-hook header, built for real with the actual logo, brand colors, and tile design. The 3 bottom tabs (Home / Friends / Profile) are unchanged.
- **The new home screen.** The real logo stays on top (scaled to 72% so the rest fits). Below it, a header row: your profile pic top-left (52px circle, the same photo/silhouette logic as the profile tab), and to its right your Elo (gold star) and daily streak (orange flame). Behind everything, a faint mosaic of letter tiles — Duello Blue only, no premium colors anywhere in the background (blue rgba at 5-16% opacity, most letters from DUELLO, a few random, some slightly rotated). The four mode buttons fill the rest of the screen, each stretching to an equal share: Play Online, Play Friends, Play Bots, and the new Daily Puzzle (gold diagonal stripes + gold border, chevron in gold). Each button has its own texture on the existing .mode base (blue border, 8px press edge): Online gets a pinstripe sheen, Friends a tile grid, Bots a dot pattern. Offline still greys out Play Online and Play Friends exactly as before (the grey-out rule is re-asserted after the textures so it wins); Daily Puzzle works offline because the dictionary is bundled.
- **Daily Puzzle.** One unscramble a day, in a modal: the day's word (5-7 letters) is picked deterministically from the local word list by the day number, so every device shows the same word on the same day. Tap the scrambled tiles to fill the answer slots (tap a slot to put a letter back), Shuffle re-scrambles, Check validates an exact match. A wrong guess clears the answer with "Not quite — try again." A solve saves the date in localStorage, shows "Solved! Streak: N days. Come back tomorrow for a new one.", and the home screen shows a "Solved" tag on the button. The streak counts consecutive solved days ending today (or yesterday if today is unsolved). Opening the puzzle on a day already solved shows the word filled in with Check/Shuffle disabled. The puzzle tiles reuse the real tile design (the same blue gradient as the board tiles).
- Verified: `node --check` server.js + app.js + engine.js + sw.js. New v131 client harness and server harness (durable copies in the goal's hidden_files) cover the version pins, the home structure, the blue-only mosaic, the textures + grey-out order, and the full puzzle flow (deterministic word, pick/unpick, wrong-guess clear, solve + streak, already-solved state). Web + TestFlight push; iOS sync copies the changed public files into duello-ios/www/.

## Profile settings pass: gear level with pfp, matched Keep/Delete, code-gated delete, settings in order (Jeff's checklist, Nov 19, 2026) v141

- **What it is.** Jeff's six-item checklist for the Edit Profile screen, all in one version: the gear, the Keep/Delete pair, the delete safety step, and the order of the settings.
- **Gear top = pfp top.** The gear on the profile tab sat 8px above the profile pic (the v135 pin matched the screen's top padding; the pfp starts 8px lower, under its .profile-top padding). The gear now sits 8px lower, so its top edge lines up exactly with the top of the pic.
- **Keep / Delete are a matched pair.** The two buttons in the delete confirmation stack full-width, so both are exactly the same size and both labels fit on one line ("Yes, delete my account" wraps at half width — that was the mismatch). Keep my account is solid Duello blue with black text; Yes, delete my account is a red border on a transparent background with red text. The styling is scoped to the confirm row, so the form's Cancel and the code step's Back keep the standard outline-blue cancel.
- **Deleting an account now needs a code.** Tapping "Yes, delete my account" emails a 6-digit code to the account's own address (taken from the signed-in session, never from the request, so a code can only ever go to the account being deleted), then shows a code step. Enter the code and the account is deleted as before; a wrong code, an expired code, or too many tries blocks it. Resend and Back are on the step; if a code was requested a moment ago the step opens anyway, since that code is still valid. Server: new `delete_codes` table (same shape as the signup/reset code tables) plus POST /api/me/delete/request-code and /api/me/delete/verify-code; POST /api/me/delete now requires the verified token — a no-token delete is rejected. Same 10-minute code / 5-attempt / 1-minute-cooldown shape as the other codes.
- **Settings in a natural order.** The push-notification toggle now sits inside the Edit Profile form just below the email field, and Change password sits below it — both above Cancel/Save. The push row is still hidden on web and only shows on iOS, and its margin rides on the row itself so it leaves no gap on web. The password fields moved into the form too, so Enter in a password field no longer submits the profile form (Enter in the last password field saves the new password).
- **Consistent buttons.** Change password and Sign out are now real buttons (secondary style) instead of bare text links, matching the rest of the screen's buttons: same 14px radius, 12px padding, 17px text as Cancel/Save and Keep/Delete.
- Verified: `node --check` server.js + app.js + engine.js + sw.js. New v141 client harness and server harness (durable copies in the goal's hidden_files) cover the gear arithmetic, the form order, the button styles + one-line labels, the full code-gated delete flow (including the no-token rejection and the cooldown path), the Enter guard, and the v140 history regression. Web + TestFlight push; iOS sync copies the changed public files into duello-ios/www/.

## Daily Puzzle is a board puzzle + countdown + stacked header + Pro badge (Jeff's checklist, Nov 19, 2026) v142

- **What it is.** Jeff's four-item checklist: the Daily Puzzle becomes a real board puzzle, the button counts down to midnight, the home header stacks Elo over streak with a Pro badge on the right.
- **Daily Puzzle: find the best move.** The unscramble modal is gone. Tapping Daily Puzzle opens a full screen with a real 10x10 board, mid-game position, and a 6-tile rack: tap a rack tile to select it, tap an empty cell to place it, tap a placed tile to send it back, Clear returns them all. Check validates the play through the same engine as a real game (same dictionary, same scoring, premiums included) and fills the "Move strength" bar: your play's score against the optimal score, left to right. A play scoring the optimal (or better) solves the puzzle; anything less shows the score and the percentage ("MOSEY — 26 pts, 54% of the best move. Try again.") and the tiles bounce back to the rack so the next attempt starts from the same position. A solved puzzle keeps the winning tiles on the board, locks the rack, and shows the best move and the streak.
- **The puzzles are data, not code.** `public/daily-puzzles.json`, keyed by local date: `{ board: [[r,c,letter]...], rack: [letters], premiums: {"r,c": "DL"|"DW"|"TL"|"TW"}, optimalScore, optimalWord }`. The client fetches it with the version pin (`?v=APP_VERSION`, so a new file is fetched fresh on the next version) and the service worker caches it on first fetch, so the puzzle works offline after the first load. When today has no entry, the latest entry in the file opens instead, so the button always works. Jeff authors a new puzzle each day by describing the board and rack; the optimal score is computed with the Fishstick engine (`findMoves`) and must match `validatePlay` for the same placement (both include the +30 bingo / +30 DUELLO bonuses — verified equal for the example). The streak store (`duello-daily-puzzle-v1`) is unchanged, so the streak carries over from the unscramble days.
- **Example puzzle (2026-11-19).** Board: BRIDGE across row 4, UNDO down col 5, RAT down col 3, BA down col 2, GO down col 6 (13 tiles; every 2+ run is a dictionary word — AA and OO included). Rack: MONEYS. Optimal: MONEYS across row 7, 48 pts (MONEYS 14 + RATE 4 + 30 bingo), clearly ahead of the next distinct score (MOSEY 26) — a common word, findable, and nearly double the runner-up. Premiums: 12 squares, 3 of each type, outer rings only, never touching.
- **Countdown to midnight Boston time.** Where the "Solved" tag sits on the Daily Puzzle button, an unsolved puzzle now shows a live countdown (H:MM:SS) to midnight in America/New_York, ticking every second from `renderHomeHeader`; once solved it shows "Solved" again. The tag is never hidden now.
- **Header: streak below Elo, star above flame.** The stats stack vertically to the right of the pfp: Elo (gold star) on top, streak (orange flame) below, both left-justified, with the icons in a fixed 18px column so the star sits directly above the flame.
- **Pro badge.** A blue rosette badge (12-lobe wavy circle, Duello Blue #03eaff outline, "PRO" in Comfortaa bold) sits right-justified in the header, in line with the 52px pfp. It shows for every signed-in user for now — there is no Pro entitlement or purchase behind it yet.
- Verified: `node --check` server.js + app.js + engine.js + sw.js. Smoke-tested the puzzle flow in node: MONEYS 48 solves at 100%, MOSEY 26 at 54% does not, a non-word and a disconnected tile are rejected. **Live-verification catch: the first web push 404d `/daily-puzzles.json` — the server's static whitelist (server.js) did not include it, so the puzzle could never load. Fixed by adding `/daily-puzzles.json` to the whitelist (the `.json` content-type branch already existed for the definitions chunks); server.js re-pushed and the file verified live on both domains.** New v142 client harness and server harness (durable copies in the goal's hidden_files) cover the version pins, the header stack + Pro badge, the countdown, the puzzle data + engine-verified optimal, the full board flow (select/place/return/clear, solve, bounce-back, already-solved state), the removal of the unscramble, and the v141 regression. Web + TestFlight push; iOS sync copies the changed public files into duello-ios/www/ (plus daily-puzzles.json, which the iOS bundle needs for offline play).
