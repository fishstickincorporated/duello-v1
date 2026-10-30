# Duello bot-play slice — Postgres, no login (NOT duello-v1)

> This folder is a separate slice, not the live SQLite version in
> ~/workspace/duello-v1/. Read BOTPLAY.md first — it is the guide for
> this slice. The rest of this README describes the original v1 and is
> NOT accurate for this slice where it says SQLite, email/password
> accounts, friends, or profile: this slice has no login screen, no
> friends/profile/leaderboard, and its data lives in Postgres via
> DATABASE_URL only.

# Duello v1 — standalone production app (bot play only)

A standalone Duello 1v1 word game, built outside Muse, with real account
storage. This is v1: **bot play only**. Play Friends and Play Online are
visible on the home screen but greyed out and disabled by design.

## What it is

- Email/password accounts, stored in a real SQLite database
  (`data/duello.db`). Passwords are salted and hashed with scrypt — never
  stored in plain text. Sessions are random bearer tokens in the DB.
- All players start at exactly **1000 Elo**. Elo, Elo history, and game
  stats persist across server restarts.
- Full game, **validated server-side** (the client is never trusted):
  10x10 board, 6-tile racks dealt by letter probability with at least 2
  vowels and 2 consonants, first word entirely inside the centered glowing
  inner 6x6, 3 DL / 3 DW / 3 TL / 3 TW randomly placed in the outer two
  rings never touching even diagonally, 5:00 chess clocks counting only on
  the turn side, pass costs 30s, auto-pass with no time lost when no
  playable move, two consecutive no-move passes end the game, FORFEIT
  means the ender loses regardless of score, and timeout does NOT win on
  time — the other player keeps playing turn after turn; the game ends by
  score only when both clocks are 0.
- Scoring: Jeff's letter values (A1 B4 C4 D3 E1 F5 G3 H4 I1 J9 K6 L2 M4 N2
  O1 P4 Q10 R1 S1 T1 U2 V6 W5 X8 Y5 Z9), premiums as above, DUELLO +30,
  all 6 tiles +30, both +60 stacked.
- Status line: "___ is not a word" listing ALL invalid words, "All tiles
  must be connected." when applicable, "Play?" when a playable move is on
  the board. Last played word is highlighted with a border — the string
  put down, or for a single-tile play generating multiple words, the
  higher-scoring word.
- Bots: **Competitive Bot** (rating always equal to your Elo, interpolated
  bad/average/good pick rates — at the 1000 rung roughly 40/50/10) and
  **Fishstick** (exhaustive best-move solver; the same search drives the
  Optimal moves tally). No Elo line under either bot on the selector.
- End-of-game stat window: Best word, Longest word, Optimal moves as a
  fraction, Elo movement below the top pfps (+0 when zero), light border
  and darkened background including the logo.
- UI: dark charcoal, bright blue tiles, symbols above text on buttons,
  home bot symbol a plain white icon, small grey Back button on the bot
  selector below Fishstick centered, scoreboard name equidistant from pfp
  and Elo, deck refill in place (new tiles take the played tile's exact
  slot, unplayed tiles do not move), drag to reorder the rack with tiles
  sliding as you drag like phone app icons, single-tap to recall a tile.

## Run it locally

Requires Node.js >= 22 (uses the built-in `node:sqlite` — no runtime
dependencies).

```bash
npm install          # dev dependencies only (dictionary build tools)
npm start            # starts on http://localhost:3000
PORT=3456 npm start  # or any port you choose
```

Open the URL, create an account (email, first name, last name, username
≥3 characters, lowercase letters/numbers/underscores only, password ≥8
characters), then Play Bots → Competitive Bot or Fishstick.

The database file is `data/duello.db`. It is created on first start and
persists across restarts on the same host. Do not commit it (it is in
`.gitignore`). Back it up like any other database file.

## Dictionary — exact counts, source, and known gaps

**Fixed 2026-10-29 (Step 1): v1 now ships the verbatim ENABLE list.**
The old `an-array-of-english-words` base (193,159 words, which wrongly
let QIN, KY, ZO, DI and 18 extra two-letter words play) is gone.

- Base: verbatim ENABLE public-domain WORD.LST, saved at
  `data/WORD.LST` (172,820 words total). Source file:
  `https://www.wordgamedictionary.com/enable/download/enable.txt`
  (the ENABLE2K list; MD5 of the downloaded file:
  `1046b3adfd2cc29921b8180194bec923`). Filtered to 2–10 letters:
  **125,541 words** — exactly the Duello Backend prototype's ENABLE count.
- Plus the NWL 2/3-letter supplement (126 actually added): TWL 2/3-letter
  words missing from ENABLE, OWL3 (2015) new three-letter words (66),
  NWL2023 new three-letter words (10 new, GOY/HOS already in TWL), and
  ZEN (in the NSWL2018 3-letter list). The old SUPPLEMENT3 candidate list
  is NOT used: it was mostly CSW words and would re-introduce QIN etc.
  The build aborts if any must-not-play word ends up in the final list.
- Plus Jeff's 118 supplied 2-letter words: **17 actually added** (the
  other 101 were already in ENABLE + NWL supplement)
- Plus DUELLO forced in
- **Total: 125,684 words**
- By length: 2: 118, 3: 1,093, 4: 3,903, 5: 8,636, 6: 15,232,
  7: 23,109, 8: 28,420, 9: 24,873, 10: 20,300
- Definitions bundled: **43,732** entries. All 1,211 short words
  (2–3 letters) have a bundled definition (0 missing); 385 of those are
  brief placeholders where WordNet has no entry.

**Verified word by word (in `data/words.txt`, which is what the server
loads and what `validatePlay` checks with `WORDS.has`):**

- MUST play, all play: QI, ZA, ZEN, JA, DUELLO
- MUST NOT play, none play: QIN, KY, ZO, DI, AO, CH, EA, FY, GU, KO,
  NY, OB, SJ, ST, UA, UG, UK, UR, YU
- **DUELLO definition is noun "🤺"**, as specified.
- **Definitions are NOT Open English WordNet bundled verbatim.** They are
  glosses extracted from Princeton WordNet via the `wordnet-db` package
  (the upstream of Open English WordNet), plus Jeff's 118 two-letter
  definitions verbatim (which override everything), plus DUELLO "🤺",
  plus brief placeholders for uncovered 2/3-letter words (385 in this
  build). See ATTRIBUTION.md.
- Note: `/api/define` returns a placeholder definition for any string,
  even a non-playable word — it is NOT a playability test. Playability
  is membership in `data/words.txt` / the `/validate` endpoint.

**One honest count difference vs the prototype:** the prototype's
edits-60 total was 125,683 (118 two-letter, 1,092 three-letter). This
build is 125,684 (118 two-letter, 1,093 three-letter). The +1 is ZEN,
added explicitly on top of a reconstructed NWL set (TWL + OWL3 + NWL2023)
that otherwise reproduces the prototype's counts exactly. No clean
verbatim NWL2023 file was available to identify which single word in
the reconstruction the prototype excluded, so all reconstructed words
were kept plus ZEN. No must-not-play word is included and no must-play
word is missing, which is the test that matters.

**Rebuilding:** `npm run build:dictionary` now reads `data/WORD.LST`
directly. `scripts/import-enable.js` is superseded (it described the
old swap path); do not use it to replace `words.txt` by hand.

## Frontend — rebuilt to match the Duello Backend prototype UI

The prototype lives inside the Muse artifact system, so its source
could NOT be copy-pasted into v1. Instead v1's frontend was rebuilt
from the prototype UI spec (MEMORY.md) to match it screen by screen,
except Play Friends / Play Online stay visible but greyed out
(disabled) per the v1 scope. Matched in this pass: tile DUELLO logo
image (white keyed out to transparency, from Jeff's supplied logo file)
on auth/home/bot/game screens; Nunito font; 390px phone column;
auth headings "Create an account" / "Sign in" with prototype toggle
wording and no criteria hints in placeholders; home mode buttons 92px
tall, 20px gaps, symbols above labels, slight 3D underside; bot selector
with red robot disc above "Competitive Bot", the real Fishstick image
above "Fishstick", no Elo under either, small grey Back pill centred
below Fishstick; scoreboard with player left-justified / bot mirrored,
score centred, clocks adjacent in the centre with last plays under them
(word on top, points below in blue bold), turn-indicator outline on the
side to move; board 3px gaps with prototype premium colours
(DL #a8cdea, TL #5b8fd6, DW #e5a3b4, TW #e59a83, plain #262a33), bright
blue tiles, larger 24px letters, values top-right with 2px buffer,
3.2s glowing 6×6, amber last-word border, 92px drag ghost; status
wording ("Play?", "OL is not a word.", "LY, OL and SY are not words.",
"All tiles must be connected."); game buttons sentence-case, same
width, Play green only when valid, Pass/Forfeit SURE? without resizing;
stat window with light border, 0.78 dimmed backdrop (scoreboard and
logo dimmed too), Elo movement below the top pfps (+0 when zero),
"Best word: WORD (pts) / Longest word: WORD (letters) / Optimal moves:
N/T (WORD1, …)", buttons Main Menu, Play Again, Game Stats.
Still different from the prototype (not hidden): no Apple/Google
sign-in buttons (v1 has no real OAuth — do not add fake ones); no
Friends/Profile tab bar (v1 is bot-play only, with a Sign out link on
home instead); player pfp is a 👤 emoji, not the prototype silhouette;
play-value bubble stays gold (one Backend probe called it white, the
settled static rule is gold); the frontend has NOT been driven in a
real browser by a generic subagent (live-browser work is blocked for
subagents) — API-level checks only, see below.

## Deploying

- **Fly.io (recommended for v1):** deploy the app with a persistent volume
  mounted at the data directory, so `data/duello.db` survives restarts.
  Set PORT from the platform.
- **Render:** use a persistent disk for the data directory, same reason.
- **Vercel (serverless): NOT suitable for the SQLite file as-is** — a
  SQLite file does not persist across serverless invocations. Do not
  deploy to serverless with SQLite and expect accounts to survive.
- **Postgres swap (for hosted deployment):** schema is in
  `db/postgres-schema.sql` (users, sessions, games, elo_history, matching
  the SQLite tables). Swapping means re-implementing only the DB helper
  section in `server.js` against `pg` (or another Postgres client) and
  setting DATABASE_URL; game logic, validation, and scoring do not change.
  This is the right move before any public launch.

## What is NOT yet production-ready

- Real Google/Apple OAuth — email/password only for v1. OAuth hooks are
  marked TODO in the auth screen note and in `server.js` comments. Do not
  claim real provider sign-in.
- Email verification, password reset.
- Ads, payments, App Store / Google Play distribution.
- Live multiplayer (Play Friends / Play Online are greyed out by design
  in v1; the server has no WebSocket game loop yet).
- Rate limiting, abuse protection, and hosted-database backups.
- A real-browser frontend drive (drag/tap, clock ticking in the UI, stat-window rendering on a device) — API-level checks only so far; a live-browser agent still needs to drive it, since generic subagents cannot operate a live browser.

## Testing

```bash
node server.js            # in one terminal
BASE=http://localhost:3000 node scripts/smoke-test.js
```

The smoke test creates a fresh account, starts a Competitive Bot game,
plays a valid first move, forfeits, checks Elo moved, and checks ZA, JA,
QI, ZEN, and DUELLO definitions. Verified run (2026-10-29, port 3456):
signup Elo 1000 → game 1, rack ONWZEL, played EL +3, bot answered VAE +11,
forfeit Elo delta −16 → 984, stats 1 played / 0W / 1L; definitions for
ZA ("slang word for pizza"), JA ("yes"), QI ("circulating life energy"),
ZEN, DUELLO ("🤺") all returned. Persistence run: account
persist_test@example.com, Elo 1000 → competitive forfeit −16 → 984 →
server restart → sign-in Elo still 984, games and stats intact.
Validation run: disconnected placements return
"all tiles must be connected"; an invalid pair returns invalidWords
(e.g. ["SA"]). Refill run: rack AHEIAR → played AA (slots 0 and 4) →
rack LHEIIR, unplayed tiles unchanged in place.

## Files

- `server.js` — zero-dependency Node HTTP server, game engine, API
- `public/index.html`, `public/style.css`, `public/app.js` — frontend
- `scripts/build-dictionary.js` — builds `data/words.txt` and
  `data/definitions.json` from the sources above
- `scripts/import-enable.js` — superseded ENABLE swap helper (build now reads `data/WORD.LST` directly; do not use this to hand-replace `words.txt`)
- `scripts/smoke-test.js` — end-to-end smoke test against a running server
- `db/postgres-schema.sql` — Postgres swap schema
- `data/words.txt`, `data/definitions.json` — shipped dictionary data
- `data/duello.db` — created on first run, git-ignored, persists accounts
