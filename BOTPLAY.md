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
