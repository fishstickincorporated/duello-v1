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
