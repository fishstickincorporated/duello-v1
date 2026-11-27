// Duello bot-play slice — Postgres, no login.
// Bot play only. No friends, no profile, no leaderboards in this slice.
// Run: DATABASE_URL=postgres://... node server.js  (PORT env, default 3000)
// Data: data/words.txt, data/definitions.json (dictionary files, still required)
//       Postgres, via DATABASE_URL only. There is NO SQLite fallback in this
//       slice, so a test run actually proves Postgres works. If DATABASE_URL
//       is missing the server exits at startup with a clear error.
// Auth: real email/password accounts (POST /api/signup, POST /api/signin,
// POST /api/signout, GET /api/me). Passwords are salted scrypt hashes in
// Postgres; sessions are random tokens in the sessions table, stored by
// the client in localStorage under 'duello_token'. Sign-in is required
// before entering the app: the client shows the auth screen when there
// is no valid session. Guests are not an option at all: POST /api/guest
// was removed Nov 2, 2026, and a session issued to a guest before that
// authenticates nothing anymore — loading the app with one shows the
// auth screen, and signing up from there creates a brand-new account,
// leaving the guest row orphaned and inert. No OAuth yet — Google/Apple
// sign-in is a separate integration.
// Signup is email-verified in three steps: (1) POST /api/auth/request-code
// emails a 6-digit code, (2) POST /api/auth/verify-code checks it and
// returns a verified token, (3) POST /api/signup requires that token and
// creates the account. Codes are scrypt hashes in the verification_codes
// table, expire after 10 minutes, allow 5 wrong guesses, and a new request
// replaces the old code (60-second cooldown per email). Sending uses
// Resend (api.resend.com) with RESEND_API_KEY from the environment and the
// verified domain duellogame.com; without the key, request-code fails
// cleanly and the rest of the app keeps running.
// Password reset reuses the same code machinery with a separate
// password_reset_codes table: (1) POST /api/auth/request-reset,
// (2) POST /api/auth/verify-reset-code, (3) POST /api/auth/reset-password.
// Reset responses never reveal whether an address has an account: the
// request endpoint always reports success for a well-formed email, and
// every verify failure uses the same message. A successful reset changes
// the password and deletes every session for that user.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required: set it to a Postgres connection string, e.g. postgres://user:pass@localhost:5432/duello_botplay_test');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres external URLs require SSL; local Postgres does not.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// v193 safety net: an idle client erroring (a dropped Postgres
// connection) used to be an uncaught 'error' on the pool and killed
// the process; log it and keep serving — the next query opens a
// fresh client. And a last-resort guard for anything else uncaught:
// log the stack, then exit for uncaughtException (the process is in
// an unknown state — never swallow it), log only for an unhandled
// rejection.
pool.on('error', (err) => { console.error('Postgres pool error (idle client):', err && err.message); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err && err.stack || err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason && reason.stack || reason); });

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
// Usernames a real account may never take (v126, v133): the bot handles.
// 'fishstick' is the Fishstick bot's handle — it shows as @fishstick
// in Game History, so no player may register or rename to it.
// 'doppelganger' is the Doppelgänger bot's handle — it shows as
// @doppelganger in Game History. 'competitivebot' stays reserved too,
// so nobody can squat the old bot name.
const RESERVED_USERNAMES = new Set(['fishstick', 'competitivebot', 'doppelganger']);
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Dictionary ----------
const WORDS = new Set();
for (const line of fs.readFileSync(path.join(DATA_DIR, 'words.txt'), 'utf8').split('\n')) {
  const w = line.trim().toUpperCase();
  if (w) WORDS.add(w);
}
let DEFS = {};
// Which file each bundled definition came from. v118: every bundled
// entry is curated (src 'curated') — one short, most-common-sense
// definition per word, picked at build time by
// expanded/build-curated-dictionary.js from every source (WordNet,
// Webster's 1913, Wiktionary, dictionaryapi.dev). The old base file
// and extras a-g stay on disk as raw material but are not loaded.
const DEFS_SRC = {};
function loadDefsFile(file, src) {
  try {
    const chunk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    for (const w of Object.keys(chunk)) { DEFS[w] = chunk[w]; DEFS_SRC[w] = src; }
  } catch (e) { /* chunk absent, ignore */ }
}
// Curated dictionary (v118): one short, most-common-sense definition
// per word, built by expanded/build-curated-dictionary.js. The curated
// chunks are the ONLY bundled source now — the old base file and
// extras a-g stay on disk as raw material but are not loaded, so a
// rejected gloss (a rare sense, a pointer, a proper name) can never
// resurface through the base file.
try { DEFS = {}; } catch (e) { DEFS = {}; }
for (const extraFile of ['definitions-curated-a.json', 'definitions-curated-b.json', 'definitions-curated-c.json', 'definitions-curated-d.json', 'definitions-curated-e.json', 'definitions-curated-f.json', 'definitions-curated-g.json', 'definitions-curated-h.json', 'definitions-curated-i.json', 'definitions-curated-j.json']) loadDefsFile(extraFile, 'curated');

// ---------- Shared engine (public/engine.js) ----------
// The pure game logic (solver, validation, scoring, pickers, rack
// dealing, Elo, stats) lives in one file both Node and the browser
// load, so the server and the client can never disagree about the
// rules. WORDS is loaded here (fs) and injected; the client passes
// its fetched set to the same createEngine.
const engine = require(path.join(__dirname, 'public', 'engine.js')).createEngine(WORDS);
const {
  makePremiums, emptyBoard, boardIsEmpty,
  validatePlay, findMoves,
  pickPersonaMove, pickPersonaEasyMove, personaThinkMs, personaThinkMsForMove, pickCompetitiveMove,
  drawRack, refillRack, eloDelta, gameStatsPayload,
} = engine;

// ---------- Database (Postgres) ----------
async function initDb() {
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'postgres-schema.sql'), 'utf8');
  await pool.query(schema);
  // photo_data is used by publicUser if present; the base schema does not
  // define it, so add it idempotently for later slices. It is not used by
  // bot play itself.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_data TEXT');
  // Duello Pro tier (v147): a real account flag, default Free.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pro BOOLEAN NOT NULL DEFAULT FALSE');
  // Daily Puzzle solved move (v153): the placements of the winning
  // play, so a solved puzzle reopens with the word on the board.
  await pool.query('ALTER TABLE daily_puzzle_solves ADD COLUMN IF NOT EXISTS placements JSONB');
  // Daily Puzzle best score (v191): the highest-scoring word played
  // on a date — the week strip's % is best / that day's optimal,
  // and the puzzle is a high-score chase now, not a 100% gate.
  await pool.query('ALTER TABLE daily_puzzle_solves ADD COLUMN IF NOT EXISTS best_score INTEGER');
  // Real friend requests (v53): one row per directed request, pending
  // until accepted; accepted rows are the friendship. Personas are
  // not in users, so they can never be a request target here.
  await pool.query(`CREATE TABLE IF NOT EXISTS friend_requests (
    id SERIAL PRIMARY KEY,
    from_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_user_id, to_user_id),
    CHECK (from_user_id <> to_user_id)
  )`);
  // Real-player challenges (v76): one row per live challenge, pending
  // until the recipient accepts (which creates the game) or declines,
  // or the challenger cancels / it times out. A game between two real
  // players is a normal games row with bot_type 'human' and the
  // recipient as opponent_id — see newGame / serializeGame.
  await pool.query(`CREATE TABLE IF NOT EXISTS challenges (
    id SERIAL PRIMARY KEY,
    from_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
    game_id INT REFERENCES games(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (from_user_id <> to_user_id)
  )`);
  // v193: one live challenge per pair. The SELECT-first check in
  // POST /api/challenges closes the normal case, but two creates
  // racing through the same instant both pass it and insert — the
  // index makes the second insert fail (23505) instead of writing
  // a duplicate, and the endpoint answers with the existing row.
  // The pair is UNORDERED (LEAST/GREATEST): the endpoint treats a
  // reverse-direction create as the same challenge, so the index
  // must too — a plain (from_user_id, to_user_id) index still lets
  // a simultaneous reverse create through (proven live: two rows
  // from three concurrent creates, ids 1 and 2). Same shape as
  // games_client_game_id_unique below: created here, after the
  // table, not in the schema file — the table itself is created
  // here too.
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS challenges_pending_pair_unique ON challenges (LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id)) WHERE status='pending'");
  await pool.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS opponent_id INT REFERENCES users(id)');
  // Offline sync (v106): client_game_id is the idempotency key for a
  // finished offline game (POST /api/games/sync). A re-submit with the
  // same key is a no-op 200, so a retry after a dropped response is safe.
  await pool.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS client_game_id TEXT');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS games_client_game_id_unique ON games (client_game_id)');
  // Push notifications (v120): per-user device tokens for APNs, and a
  // per-user on/off preference the Settings toggle writes. Tokens are
  // keyed by (user_id, token) so one user can hold several devices
  // and a re-register is an upsert, not a duplicate.
  await pool.query(`CREATE TABLE IF NOT EXISTS push_tokens (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'ios',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, token)
  )`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT TRUE');
  // Share cards (v187): one rendered profile card per user, as PNG
  // bytes in Postgres — Render's disk is ephemeral, so the image
  // must live in the database, not on disk. The client renders the
  // card fresh at share time (current Elo/rank) and upserts it;
  // GET /api/share-card/:username.png serves it for link previews.
  await pool.query(`CREATE TABLE IF NOT EXISTS share_cards (
    username TEXT PRIMARY KEY,
    png BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await seedPersonas();
  // v194: void any games stranded by the old crashes on boot — the
  // same sweep as the 60s interval, so the four rows Jeff saw (two
  // never-started 0–0s and two started-but-abandoned scored games)
  // are voided the moment this version deploys. Idempotent: void
  // games no longer match status='active', so a restart re-voids
  // nothing.
  await voidStaleGames();
}
async function seedPersonas() {
  // Persona data is versioned, not just seeded-once: v1 (Nov 4) was
  // uniform Elo 800-1200 with first_last usernames, v2 (Nov 4)
  // replaced it with bell-curve Elo around 1000 and mixed usernames,
  // v3 (Nov 5) re-rolled the usernames again (7 methods, 3 animals,
  // no iron), and v5 (Nov 23) replaces every photo with an
  // AI-generated face and expands the roster to 500 (250 men / 250
  // women, Elo 200-1500 on a bell curve around 1000): the old
  // headshots were real people's photos from a portrait site with a
  // weak license chain (and a right-of-publicity problem as
  // fake-player faces), and the picsum URLs never loaded. All faces
  // are synthetic portraits generated for this project (no real
  // person depicted), embedded as data URLs in personas.json so the
  // app needs no external photo host. All 500 personas have a photo
  // (v4's 5% no-photo / 10% non-headshot variety is gone). A refresh
  // is a full delete + re-insert, which is safe because personas are
  // fake players: finished games keep their stats in state, and an
  // in-progress persona game's end-of-game persona update simply
  // no-ops if its id is gone. After v5 is applied, later boots never
  // touch the table, so Elo movement survives.
  // v6 (Nov 23) is the variety overhaul: same 500 names and Elos,
  // but usernames re-rolled (40% name-derived, 60% free-form with
  // animals capped at ~30) and photos re-mixed — 57% headshots with
  // real variety (ages 18-65, real backgrounds, some full-body),
  // 30% random non-person images (landscape / flower / pet / object),
  // 8% couple photos, 5% no photo at all. All images are still
  // original AI-generated works for this project; the no-photo
  // personas seed photo_url NULL and the client already renders the
  // silhouette for those. Same delete + re-insert shape as v5.
  // v7 (Nov 23) fixes a v6 assignment bug and re-shoots the photos:
  // v6 dealt headshot files to personas at random with NO gender
  // check, so 127 of 260 headshots (and 10 of 25 full-body) showed
  // the opposite gender from the persona's name — that is the
  // "names don't match gender" Jeff reported. v7 assigns photos
  // from gender-matched pools (asserted in the build script) and
  // re-mixes to 20% headshots (framed further away, shoulders-up,
  // face ~30-40% of frame), 10% full-body, 35% random, 10% couple,
  // 25% no photo — and every photo is re-shot to look like a candid
  // iPhone snapshot (natural light, unstaged, ordinary backgrounds),
  // not a studio portrait or stock photo. Same delete + re-insert
  // shape as v5/v6.
  // v8 (Nov 23) fixes a v7 CROP bug and re-centres the pets: v7's
  // fixed-grid crops (randoms, full-body, couples) span the full
  // cell height, so the generator's white inter-cell gutters landed
  // inside 58 of 375 crops as a 2-6px solid-white strip on the top
  // or bottom edge — that is the "white boarders" Jeff reported
  // (Eugene Green's gecko photo shows it clearly). v8 replaces
  // those 58 with gutter-aware re-crops (content-box crop, gated by
  // border_gate_v174.py) and swaps 13 off-centre / half-hidden pet
  // pics for centred ones from two new pet grids. Same 500
  // identities, same mix counts; only photo data changes. Same
  // delete + re-insert shape as v5/v6/v7.
  // v9 (Nov 23) fixes a v8 GATE bug: the v8 gate needed a run of
  // >=2 rows at >=95% of pixels >=242, and a single row dipping to
  // 94.8% (JPEG noise) broke the run — and it never looked at
  // interior near-edge bands at all. The step-aware gate
  // (border_gate_v175.py: >=80% bright + a sharp step to the inner
  // content, or >=95% bright outright) found 125 more offenders
  // (random 70, fullbody 30, couple 25, headshot 0), all replaced
  // with gutter-aware re-crops. That includes the three the v8
  // eyeball check had cleared (dumpling19, snowboardjester) — the
  // source grids prove their white tops are the grid's white margin
  // (full-width rows at 254-255), not window light or a ceiling.
  // Same 500 identities, same mix counts; only photo data changes.
  // Same delete + re-insert shape as v5/v6/v7/v8.
  // v10 (Nov 23) fixes a v9 GATE blind spot: the v9 gate only
  // examined the 6 rows/cols nearest each edge, so INTERIOR gutter
  // seams sailed through — @carlos_h rows 11-12 + cols 15-16,
  // @stoneskiing rows 81-84, @violetcello rows 20-22, all 11-22px
  // in. Jeff played a game (fresh leaderboard fetch) and the white
  // persisted, proving it is in the photo data, not stale rows.
  // The full-frame gate (border_gate_v178.py) flags any row/col
  // anywhere in the crop and found 64 offenders (random 61,
  // fullbody 3), all re-cropped with an iterative box-relative
  // gutter detector (recrop_clean_v178.py) — a horizontal gutter
  // only spans one cell's width, so measured over the full window
  // it reads 82% and is missed; re-detecting inside the trimmed
  // box reads it at ~100%. Same 500 identities, same mix counts;
  // only photo data changes. Same delete + re-insert shape as
  // v5/v6/v7/v8/v9.
  // v11 (Nov 23, 2026): all 375 photos re-cut at 192px from the v173
  // source grids (faces-v182/) because the 96px photos are visibly
  // soft at 84 CSS px on a 3x iPhone, and the off-white band gate
  // (border_gate_v182.py) caught Cora's bottom band plus 17 more
  // off-white margins/gutters the >=240 rules missed. Same 500
  // identities, same mix counts; only photo data changes. Same
  // delete + re-insert shape as v5/v6/v7/v8/v9/v10.
  await q('CREATE TABLE IF NOT EXISTS persona_seed (version INT PRIMARY KEY)');
  const v = await q('SELECT MAX(version) AS v FROM persona_seed');
  if ((v.rows[0].v || 0) >= 11) return;
  // v6 needs NULL photos: the original schema declared photo_url
  // NOT NULL, so drop that first (idempotent on later boots).
  await q('ALTER TABLE personas ALTER COLUMN photo_url DROP NOT NULL');
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'personas.json'), 'utf8'));
  if (!list.length) return;
  // A real user's username always wins: a colliding persona handle
  // gets a numeric suffix instead of dropping the row.
  const taken = new Set((await q('SELECT username FROM users')).rows.map(r => r.username));
  const rows = list.map(p => {
    let u = p.username, n = 1;
    while (taken.has(u)) { u = `${p.username}_${n++}`; }
    taken.add(u);
    return { ...p, username: u };
  });
  await q('DELETE FROM personas');
  const values = [], params = [];
  rows.forEach(p => {
    values.push(`($${params.length + 1},$${params.length + 2},$${params.length + 3},$${params.length + 4},$${params.length + 5},$${params.length + 6})`);
    params.push(p.username, p.firstName, p.lastName, p.gender, p.elo, p.photoUrl);
  });
  await q(`INSERT INTO personas (username, first_name, last_name, gender, elo, photo_url) VALUES ${values.join(',')}`, params);
  await q('INSERT INTO persona_seed (version) VALUES (11)');
  console.log(`Personas refreshed to seed v11 (${rows.length})`);
}
async function q(text, params) { return pool.query(text, params); }
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function passwordPolicyOk(pw) { return pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw); }
const PASSWORD_POLICY_ERROR = 'Password needs 8+ characters, a capital letter, a lowercase letter, and a number.';
async function getUserByEmail(email) { const r = await q('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]); return r.rows[0] || null; }
async function getUserByUsername(username) { const r = await q('SELECT * FROM users WHERE username=$1', [username]); return r.rows[0] || null; }
async function getUserById(id) { const r = await q('SELECT * FROM users WHERE id=$1', [id]); return r.rows[0] || null; }
function publicUser(u) {
  if (!u) return null;
  const created = u.created_at instanceof Date ? u.created_at.toISOString() : u.created_at;
  return { id: u.id, email: u.email, username: u.username, firstName: u.first_name, lastName: u.last_name, elo: u.elo, eloHigh: u.elo_high, createdAt: created, hasPhoto: !!u.photo_data, photoData: u.photo_data || null, pushEnabled: u.push_enabled !== false, pro: !!u.pro };
}
async function authUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const r = await q('SELECT * FROM sessions WHERE token=$1', [m[1]]);
  if (!r.rows[0]) return null;
  const u = await getUserById(r.rows[0].user_id);
  // Guests are not an option: a guest session authenticates nothing.
  if (isGuestUser(u)) return null;
  return u;
}

function isGuestUser(u) { return !!u && typeof u.email === 'string' && u.email.endsWith('@guest.local'); }

// ---------- Push notifications (APNs, v120) ----------
// A match challenge reaches the recipient as a push when the app is
// closed or backgrounded; while the app is open the 5s poll already
// shows it. Sending uses APNs token-based auth (ES256 JWT, .p8 key)
// over HTTP/2 with Node's built-in http2 — no new dependency.
// Config (all env, never hardcoded):
//   APNS_KEY_ID    — Key ID of the APNs auth key (Apple Developer →
//                     Certificates, Identifiers & Profiles → Keys)
//   APNS_TEAM_ID   — Team ID (defaults to JP6TX47769)
//   APNS_KEY       — the .p8 key contents (PEM, BEGIN/END lines incl.)
//   APNS_KEY_FILE  — path to the .p8 file (used if APNS_KEY is absent)
// Without a key the server still runs and challenges still work;
// notifyChallengePush just reports 'apns-not-configured' and nothing
// is sent. The .p8 in ~/workspace/user/files/ is the App Store
// Connect API key ('Duello CI') — it is NOT an APNs key and must
// never be used here: an APNs key needs the Apple Push Notifications
// service enabled on the key itself.
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || 'JP6TX47769';
const APNS_BUNDLE_ID = 'com.duellogame.app';
const APNS_HOST = 'api.push.apple.com';
let apnsJwtCache = null; // { token, exp }
function apnsKeyPem() {
  // The .p8 key reaches the server as APNS_KEY (or APNS_KEY_FILE).
  // A PEM pasted into an env var often arrives with literal "\n"
  // escape sequences instead of real newlines — and
  // crypto.createPrivateKey throws on that, which made every
  // challenge push fail silently (the notify try/catch only logs
  // it). Normalise both forms so the key works either way.
  let k = null;
  if (process.env.APNS_KEY) k = process.env.APNS_KEY;
  else if (process.env.APNS_KEY_FILE) {
    try { k = fs.readFileSync(process.env.APNS_KEY_FILE, 'utf8'); } catch { return null; }
  }
  if (!k) return null;
  if (k.indexOf('\\n') !== -1 && k.indexOf('\n') === -1) k = k.replace(/\\n/g, '\n');
  return k;
}
function apnsConfigured() {
  return !!(process.env.APNS_KEY_ID && apnsKeyPem());
}
function apnsJwt() {
  // Token-based auth: one ES256 JWT, good for 60 minutes, reused
  // until near expiry. Header carries the Key ID; payload carries
  // the Team ID as issuer.
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && apnsJwtCache.exp > now + 60) return apnsJwtCache.token;
  const keyPem = apnsKeyPem();
  if (!keyPem || !process.env.APNS_KEY_ID) return null;
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: APNS_TEAM_ID, iat: now })).toString('base64url');
  const data = header + '.' + payload;
  const key = crypto.createPrivateKey(keyPem);
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  const token = data + '.' + Buffer.from(sig).toString('base64url');
  apnsJwtCache = { token, exp: now + 50 * 60 };
  return token;
}
async function sendApnsPush(deviceToken, payload) {
  // One APNs HTTP/2 POST. Returns { ok, status, reason }. A 410
  // (device token no longer valid) is the caller's cue to drop the
  // token. This function NEVER throws: every failure mode resolves
  // as { ok: false, ... } instead.
  //
  // v193: the old code read the status from req.headers[':status']
  // in the 'end' handler — but Node's ClientHttp2Stream has NO
  // .headers property (response headers only arrive via the
  // 'response' event argument), so EVERY push that got an APNs
  // response threw an uncaught TypeError and killed the process,
  // even though Apple had already accepted the push. The status
  // now comes from the 'response' event; a missing status resolves
  // as a failed push. The http2 session also gets its own 'error'
  // listener (a bare session with none also kills the process on
  // DNS/TLS/reset/GOAWAY), and a 10s timeout bounds a hung
  // connection so the fire-and-forget can never stall forever.
  const jwt = apnsJwt();
  if (!jwt) return { ok: false, status: 0, reason: 'apns-not-configured' };
  const http2 = require('http2');
  let client;
  try {
    client = http2.connect('https://' + APNS_HOST);
  } catch (e) {
    return { ok: false, status: 0, reason: 'apns-connect-failed' };
  }
  let settled = false;
  let timer = null;
  const result = await new Promise((resolve) => {
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    // Transport failures on the session itself (DNS, TLS, reset,
    // GOAWAY) land here — without this listener they are uncaught
    // and kill the process.
    client.on('error', () => finish({ ok: false, status: 0, reason: 'apns-session-error' }));
    let req;
    try {
      req = client.request({
        ':method': 'POST',
        ':path': '/3/device/' + deviceToken,
        'authorization': 'bearer ' + jwt,
        'apns-topic': APNS_BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 300),
      });
    } catch (e) {
      finish({ ok: false, status: 0, reason: 'apns-request-failed' });
      return;
    }
    req.setEncoding('utf8');
    let body = '';
    let status = 0;
    // The status arrives here, on the 'response' event argument —
    // never on req.headers (which does not exist on this stream).
    req.on('response', (headers) => { status = Number((headers && headers[':status']) || 0); });
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!status) return finish({ ok: false, status: 0, reason: 'apns-no-status' });
      if (status === 200) return finish({ ok: true, status: 200 });
      let reason = 'apns-' + status;
      try { const j = JSON.parse(body || '{}'); if (j.reason) reason = j.reason; } catch {}
      finish({ ok: false, status, reason });
    });
    req.on('error', () => finish({ ok: false, status: 0, reason: 'apns-request-error' }));
    timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      finish({ ok: false, status: 0, reason: 'apns-timeout' });
    }, 10000);
    if (timer.unref) timer.unref();
    try { req.end(JSON.stringify(payload)); } catch (e) { finish({ ok: false, status: 0, reason: 'apns-request-failed' }); }
  });
  try { client.close(); } catch {}
  return result;
}
async function notifyChallengePush(challenger, target, challengeId) {
  // Gate order: real user → preference on → has a token → APNs
  // configured → send. Returns a small result the caller logs; it
  // never throws, so a push failure can never break the challenge.
  // Personas can never reach here as a target: the challenge
  // endpoint looks the target up in users, and personas live in
  // the separate personas table — but the guard is explicit anyway.
  try {
    if (!target || !target.id || target.isPersona) return { sent: false, reason: 'not-a-user' };
    if (target.push_enabled === false) return { sent: false, reason: 'disabled' };
    const toks = await q('SELECT token FROM push_tokens WHERE user_id=$1', [target.id]);
    const tokens = (toks.rows || []).map(r => r.token).filter(Boolean);
    if (!tokens.length) return { sent: false, reason: 'no-token' };
    if (!apnsConfigured()) return { sent: false, reason: 'apns-not-configured' };
    const body = '@' + challenger.username + ' challenged you to a match!';
    const payload = { aps: { alert: { title: 'Duello', body }, sound: 'default', 'content-available': 1 }, type: 'challenge', challengeId: Number(challengeId) };
    const results = [];
    for (const t of tokens) {
      const r = await sendApnsPush(t, payload);
      results.push({ ok: r.ok, status: r.status, reason: r.reason || null });
      if (r.status === 410) { try { await q('DELETE FROM push_tokens WHERE user_id=$1 AND token=$2', [target.id, t]); } catch {} }
    }
    const sentCount = results.filter(r => r.ok).length;
    return { sent: sentCount > 0, attempted: tokens.length, sentCount, results };
  } catch (e) {
    console.error('Challenge push failed:', e.message);
    return { sent: false, reason: 'error' };
  }
}
// v187: the text-challenge accept — the sender is not sitting on a
// waiting screen, so a push is the only way they learn the game is
// ready. Same gates as the invite push, fire and forget.
async function notifyChallengeAccepted(sender, recipient, gameId) {
  try {
    if (!sender || !sender.id || sender.isPersona) return { sent: false, reason: 'not-a-user' };
    if (sender.push_enabled === false) return { sent: false, reason: 'disabled' };
    const toks = await q('SELECT token FROM push_tokens WHERE user_id=$1', [sender.id]);
    const tokens = (toks.rows || []).map(r => r.token).filter(Boolean);
    if (!tokens.length) return { sent: false, reason: 'no-token' };
    if (!apnsConfigured()) return { sent: false, reason: 'apns-not-configured' };
    const body = '@' + recipient.username + ' accepted your challenge — your game is ready!';
    const payload = { aps: { alert: { title: 'Duello', body }, sound: 'default', 'content-available': 1 }, type: 'challenge-accepted', gameId: Number(gameId) };
    const results = [];
    for (const t of tokens) {
      const r = await sendApnsPush(t, payload);
      results.push({ ok: r.ok, status: r.status, reason: r.reason || null });
      if (r.status === 410) { try { await q('DELETE FROM push_tokens WHERE user_id=$1 AND token=<redacted>', [sender.id, t]); } catch {} }
    }
    const sentCount = results.filter(r => r.ok).length;
    return { sent: sentCount > 0, attempted: tokens.length, sentCount, results };
  } catch (e) {
    console.error('Challenge-accepted push failed:', e.message);
    return { sent: false, reason: 'error' };
  }
}

// ---------- Email verification (Resend) ----------
const CODE_TTL_MS = 10 * 60 * 1000;
const VERIFIED_TTL_MS = 30 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
function sendResendEmail(to, subject, text) {
  return new Promise((resolve, reject) => {
    const key = process.env.RESEND_API_KEY;
    if (!key) return reject(new Error('Email sending is not set up yet.'));
    const body = JSON.stringify({ from: 'Duello <noreply@duellogame.com>', to: [to], subject, text, html: '<p>' + text.replace(/</g, '&lt;') + '</p>' });
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } }
        else reject(new Error('Resend rejected the email (' + res.statusCode + ').'));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
// Profile stats, ported from the main build: finished games only, from the
// games.state JSONB. A real-player game counts for BOTH players: the
// recipient's games are the rows where they are opponent_id, and every
// per-side stat below is read from that player's own side.
async function profileStatsFor(userId) {
  const rows = (await q("SELECT id, state, bot_type FROM games WHERE (user_id=$1 OR opponent_id=$1) AND state->>'status'='finished'", [userId])).rows;
  function empty() { return { gamesPlayed: 0, wins: 0, losses: 0, draws: 0, avgGameScore: 0, highestGameScore: 0, avgWordScore: 0, highestWordScore: 0, highestWord: '', highestWordGameId: null, highestWordMoveIndex: null, longestWord: '', longestWordLen: 0, longestWordGameId: null, longestWordMoveIndex: null, optimalMoves: 0, totalMoves: 0, optimalPct: 0, uniqueWords: 0, wordsOver50: 0, wordsOver100: 0, bingos: 0, tenLetterWords: [], tenLetterWordCount: 0 }; }
  // Record-word provenance (v128, item 6): which game and which move
  // a record word came from, so tapping it can open that board at
  // that move. The replay index is 1-based (moveLog[i] is replay
  // step i+1). A game with no moveLog (pre-v123) yields null, and
  // the client leaves that word unclickable instead of crashing.
  function findMoveIndex(g, mySide, pred) {
    const log = g && Array.isArray(g.moveLog) ? g.moveLog : null;
    if (!log) return null;
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (e && e.side === mySide && pred(e)) return i + 1;
    }
    return null;
  }
  // Personas and real players both count as humans everywhere stats
  // split by opponent: vsHumans is persona + real-player games,
  // vsBots is Doppelgänger only, and aggregate counts every
  // non-Fishstick game except for the two record words below.
  // Fishstick (v205, Jeff Nov 27, 2026): a Fishstick game counts
  // toward ONLY longest word and best word — the v199 freeze was
  // total, and it removed words like REENACTING from profiles
  // entirely. Games played, W-L, averages, words over 50/100,
  // optimal moves, unique words, bingos, and ten-letter words all
  // stay excluded for Fishstick, in aggregate and vsBots. Elo is
  // untouched by this (it still never moves on Fishstick games).
  function scope(mode) {
    const isHumanGame = (g) => g.botType === 'persona' || g.botType === 'human';
    const skip = (g) => (mode === 'vsHumans' && !isHumanGame(g)) || (mode === 'vsBots' && isHumanGame(g));
    const st = empty(); let wordScoreSum = 0, wordCount = 0; const uniq = new Set(); const tenLetter = new Map();
    const gs = [];
    for (const r of rows) {
      let g = r.state;
      if (typeof g === 'string') { try { g = JSON.parse(g); } catch { continue; } }
      if (!g.botType && r.bot_type) g.botType = r.bot_type;
      // v169: the row id is canonical. A synced offline game stores
      // state.id as the client-side placeholder 'offline-<id>' (the
      // app's local id, never a loadable game id), so trusting it put
      // that string into the stats' gameId and every tap on a record
      // word 404'd on GET /api/games/offline-... and fell back to the
      // game log. loadGameRow already overwrites with the row id
      // everywhere else; the stats loop is the one reader that did
      // not. (The old `if (!g.id)` only fired when state.id was
      // missing entirely, which never happens for synced games.)
      g.id = r.id;
      gs.push(g);
    }
    for (const g of gs) {
      if (skip(g)) continue;
      // v205: Fishstick games reach here now, but only for the two
      // record words below — every other counter stays gated behind
      // !isFish, so a Fishstick game still moves nothing else.
      const isFish = g.botType === 'fishstick';
      // Which side this player was: the row owner is 'human', the
      // recipient of a real-player game is 'bot'. Every stat below
      // reads from that side, so both players' profiles agree.
      const mySide = (g.userId === userId) ? 'human' : 'bot';
      const oppSide = mySide === 'human' ? 'bot' : 'human';
      if (!isFish) {
        st.gamesPlayed++;
        if (g.winner === mySide) st.wins++; else if (g.winner === oppSide) st.losses++; else if (g.winner === 'draw') st.draws++;
        else if (g.reason === 'By forfeit') st.losses++; else if (g.scores[mySide] > g.scores[oppSide]) st.wins++; else if (g.scores[oppSide] > g.scores[mySide]) st.losses++; else st.draws++;
        st.highestGameScore = Math.max(st.highestGameScore, (g.scores && g.scores[mySide]) || 0);
      }
      const moves = (g.moves && g.moves[mySide]) || [];
      for (const m of moves) {
        // Word-score stats measure the PLAY's total, not one word
        // inside it: a play's points are its words plus any bonuses,
        // so a per-word max missed big plays entirely (an 83-point
        // play whose best single word was 40 never showed, and its
        // 50+ count never moved).
        const ms = m.score || 0;
        if (!isFish) {
          st.totalMoves++;
          if (m.isOptimal) st.optimalMoves++;
          if (m.bingo) st.bingos++;
          wordScoreSum += ms; wordCount++;
          if (ms >= 50) st.wordsOver50++;
          if (ms >= 100) st.wordsOver100++;
        }
        // Longest + best word: every game counts, Fishstick included
        // (v205). These are the only two stats a Fishstick game moves.
        if (ms > st.highestWordScore) {
          st.highestWordScore = ms; st.highestWord = m.mainWord || '';
          const idx = findMoveIndex(g, mySide, (e) => e.mainWord === m.mainWord && (e.score || 0) === ms);
          st.highestWordGameId = idx ? g.id : null;
          st.highestWordMoveIndex = idx;
        }
        for (const w of (m.words || [])) {
          if (w.word && w.word.length > st.longestWordLen) {
            st.longestWordLen = w.word.length; st.longestWord = w.word;
            const idx = findMoveIndex(g, mySide, (e) => (e.words || []).some((x) => x.word === w.word));
            st.longestWordGameId = idx ? g.id : null;
            st.longestWordMoveIndex = idx;
          }
          if (!isFish) {
            if (w.word && w.word.length === 10 && !tenLetter.has(w.word)) {
              const idx = findMoveIndex(g, mySide, (e) => (e.words || []).some((x) => x.word === w.word));
              tenLetter.set(w.word, { gameId: idx ? g.id : null, moveIndex: idx });
            }
            uniq.add(w.word);
          }
        }
      }
    }
    let totalScore = 0, played = 0;
    // Average game score counts only games where the player's own clock
    // fully expired — games ended early (forfeit, stalls) are excluded.
    // A forfeit is excluded even when the clock had already expired:
    // it counts as a game played, but never toward the average.
    // Fishstick games are excluded here too (v205): their clocks do
    // expire, but their scores never count toward any average.
    for (const g of gs) { if (skip(g)) continue; if (g.botType === 'fishstick') continue; if (g.reason === 'By forfeit') continue; const mySide = (g.userId === userId) ? 'human' : 'bot'; if (!(g.clocks && g.clocks[mySide] <= 0)) continue; totalScore += (g.scores && g.scores[mySide]) || 0; played++; }
    st.avgGameScore = played ? Math.round(totalScore / played) : 0;
    st.avgWordScore = wordCount ? Math.round(wordScoreSum / wordCount * 10) / 10 : 0;
    st.optimalPct = st.totalMoves ? Math.round(st.optimalMoves / st.totalMoves * 1000) / 10 : 0;
    st.uniqueWords = uniq.size;
    st.tenLetterWords = [...tenLetter.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([word, prov]) => ({ word, gameId: prov.gameId, moveIndex: prov.moveIndex }));
    st.tenLetterWordCount = tenLetter.size;
    st.record = `${st.wins}W-${st.losses}L` + (st.draws ? `-${st.draws}D` : '');
    return st;
  }
  return { aggregate: scope('aggregate'), vsBots: scope('vsBots'), vsHumans: scope('vsHumans') };
}


// ---------- Game state ----------
function newGame(user, botType, persona, opponent) {
  const botElo = botType === 'fishstick' ? 3000 : botType === 'persona' ? persona.elo : botType === 'human' ? opponent.elo : user.elo;
  const premiums = makePremiums();
  const board = emptyBoard();
  board.__premiums = premiums; // solver reads premiums from here; stripped on save/serialize
  const game = {
    userId: user.id, botType, botElo, version: 1,
    persona: persona ? { id: persona.id, username: persona.username, firstName: persona.first_name, lastName: persona.last_name, photoData: persona.photo_url } : null,
    // Real-player games: the recipient is the 'bot' side of the
    // stored state (their rack, score, clock, and moves all live
    // there), and the viewer flip in serializeGame shows each player
    // their own side. challenger/opponent carry the public info each
    // side needs to name the other; humanElo is the challenger's Elo
    // at creation, so the recipient sees it as the opponent's Elo.
    opponentId: botType === 'human' ? opponent.id : null,
    opponent: botType === 'human' ? { username: opponent.username, firstName: opponent.first_name, lastName: opponent.last_name, photoData: opponent.photo_data || null } : null,
    challenger: botType === 'human' ? { username: user.username, firstName: user.first_name, lastName: user.last_name, photoData: user.photo_data || null } : null,
    humanElo: botType === 'human' ? user.elo : null,
    personaFinalMoveDone: false, personaFinalMovePending: false,
    board, premiums,
    humanRack: drawRack(), botRack: drawRack(),
    scores: { human: 0, bot: 0 },
    clocks: { human: 240000, bot: 240000 },
    turn: Math.random() < 0.5 ? 'human' : 'bot',
    turnStartedAt: Date.now(),
    // Bot think: bot does NOT move instantly. Client shows a 5s wind-down,
    // then fetches; the server only runs the bot once think time has elapsed.
    botThinkUntil: null, botThinkMs: null,
    status: 'active', reason: null,
    consecutivePasses: 0, consecutiveNoMoves: 0,
    moves: { human: [], bot: [] },
    // Chronological move log for replay (v123): every placed move, in
    // the order played, with its placements — so the board at any
    // step can be rebuilt (empty board + placements of moves[0..i]).
    // Passes change no tiles, so they are not logged. Populated by
    // applyMove (server) and applyLocalMove (client, offline games).
    // Old games have no log; their replay arrows are disabled.
    moveLog: [],
    // Leave (v123): when a player Leaves (out of time + losing), the
    // leaver is recorded here and the game stays active for the
    // opponent to play out. Null until someone leaves.
    leftBy: null,
    lastCells: [], lastWord: null, lastScore: null, lastBy: null,
    lastHuman: null, lastBot: null,
    eloDeltaHuman: null, eloDeltaBot: null, eloAfterHuman: null, eloAfterBot: null,
  };
  // A real opponent never thinks: no bot think is ever armed for a
  // human game, whichever side starts.
  if (game.turn === 'bot' && botType !== 'human') { game.botThinkMs = botThinkMsFor(game); game.botThinkUntil = Date.now() + game.botThinkMs; }
  return game;
}
function stripBoard(board) { return board.map(row => row.slice()); }
function isFreshGame(game) {
  const hm = (game.moves && game.moves.human) || [];
  const bm = (game.moves && game.moves.bot) || [];
  return !game.started && !hm.length && !bm.length && !game.lastHuman && !game.lastBot;
}
function serializeGame(game, user) {
  const now = Date.now();
  // A real-player game is stored challenger-vs-opponent, but each
  // viewer sees themself as the 'human' side: racks, scores, clocks,
  // last plays, Elo deltas, and the turn all flip for the opponent,
  // so the whole client renders unchanged. Bot games never flip.
  const isOpponent = game.botType === 'human' && game.opponentId === user.id;
  const flipSide = (s) => isOpponent ? (s === 'human' ? 'bot' : 'human') : s;
  let clockHuman = game.clocks.human, clockBot = game.clocks.bot;
  // Fresh games show 4:00/4:00 until /start, no matter how long the
  // create round-trip or the countdown took. This is the server half of
  // the 4:59 glitch: serialize used to subtract create-to-now elapsed.
  if (isFreshGame(game)) { clockHuman = 240000; clockBot = 240000; }
  else if (game.status === 'active') {
    const elapsed = now - game.turnStartedAt;
    if (game.turn === 'human') clockHuman = Math.max(0, clockHuman - elapsed);
    else clockBot = Math.max(0, clockBot - elapsed);
  }
  return {
    id: game.id, botType: game.botType,
    // The opponent viewer sees the challenger's Elo (after the game,
    // their after-Elo) where the challenger sees the opponent's.
    botElo: isOpponent ? (game.eloAfterHuman ?? game.humanElo) : game.botElo,
    persona: game.persona || null,
    // The other real player, human games only; bot games keep the
    // existing persona/botType display. Flipped per viewer.
    opponent: game.botType === 'human' ? (isOpponent ? (game.challenger || null) : (game.opponent || null)) : null,
    board: stripBoard(game.board), premiums: game.premiums,
    // A synced offline game stores botRackCount, not botRack (the
    // bot's rack never leaves the device), so serialize must not
    // read game.botRack.length on a row that has none — that threw
    // and made a Game History tap do nothing at all (v124).
    humanRack: isOpponent ? (game.botRack || []) : (game.humanRack || []),
    botRackCount: isOpponent ? (game.humanRack ? game.humanRack.length : 0) : (game.botRack ? game.botRack.length : (typeof game.botRackCount === 'number' ? game.botRackCount : 0)),
    scores: { human: isOpponent ? game.scores.bot : game.scores.human, bot: isOpponent ? game.scores.human : game.scores.bot },
    clocks: { human: isOpponent ? clockBot : clockHuman, bot: isOpponent ? clockHuman : clockBot, turn: flipSide(game.turn), turnStartedAt: game.turnStartedAt },
    botThinkUntil: game.botType === 'human' ? null : (game.botThinkUntil || null),
    // Relative remaining time, not just the absolute server timestamp: the
    // client must never compare a Render server clock to the phone clock
    // (skew there added a second poll and pushed the perceived think to ~7s).
    botThinkRemainingMs: game.botType === 'human' ? null : (game.botThinkUntil ? Math.max(0, game.botThinkUntil - now) : null),
    botThinkMs: game.botType === 'human' ? null : (game.botThinkMs || null),
    reason: game.reason,
    lastCells: game.lastCells, lastWord: game.lastWord, lastScore: game.lastScore, lastBy: game.lastBy ? flipSide(game.lastBy) : null,
    lastHuman: isOpponent ? game.lastBot : game.lastHuman,
    lastBot: isOpponent ? game.lastHuman : game.lastBot,
    eloDeltaHuman: isOpponent ? game.eloDeltaBot : game.eloDeltaHuman,
    eloDeltaBot: isOpponent ? game.eloDeltaHuman : game.eloDeltaBot,
    eloAfterHuman: isOpponent ? game.eloAfterBot : game.eloAfterHuman,
    eloAfterBot: isOpponent ? game.eloAfterHuman : game.eloAfterBot,
    isFirst: boardIsEmpty(game.board),
    player: { firstName: user.first_name, username: user.username, elo: user.elo },
    // The shared countdown (real-player games): how long until the
    // 5-second countdown ends, as a RELATIVE remaining time computed
    // here on the server clock — the client must never compare a
    // Render server timestamp to the phone clock (that skew added a
    // phantom second to bot thinks in v78). Null until both players
    // have loaded the game; started tells a late joiner the countdown
    // is already over and the clocks are running.
    countdownRemainingMs: game.countdownEndsAt ? Math.max(0, game.countdownEndsAt - now) : null,
    started: !!game.started,
    // Replay (v123): the chronological move log, only once the game
    // is finished — the replay is a post-game view, and sending the
    // log on every 1s poll would bloat it. Old games have no log.
    // Per-player clock rewind (v128, item 1): the log is flipped
    // for the opponent viewer, same rule as the scores and clocks
    // above — each entry's side and clocks are in viewer terms, so
    // the replay attributes every move (and its clock) to the right
    // player whichever side is viewing. Placements and words are
    // board data and need no flip.
    moveLog: game.status === 'finished' ? (game.moveLog || []).map((e) => isOpponent ? { ...e, side: e.side === 'human' ? 'bot' : 'human', clocks: e.clocks ? { human: e.clocks.bot, bot: e.clocks.human } : e.clocks } : e) : undefined,
    // Presence (v123, item 2): whether the real opponent is
    // currently connected (seen within 10s). The client fades their
    // pfp grey while they are gone. Human games only.
    opponentConnected: game.botType === 'human' ? presenceOpponentConnected(game, user) : undefined,
    // Leave (v123, item 3): the side that left, in stored terms.
    // The leaver sees the game as finished (they are done); the
    // opponent still sees it active and keeps playing it out.
    leftBy: game.leftBy || null,
    opponentLeft: game.botType === 'human' && !!game.leftBy ? (gameSides(game, user).oppSide === game.leftBy) : undefined,
    status: game.leftBy && gameSides(game, user).mySide === game.leftBy ? 'finished' : game.status,
  };
}
// Live game streams (SSE): gameId -> Set of {res, user}. Every save of a
// game row pushes the fresh serialized state to that game's subscribers,
// so the other player in a real 1v1 sees a move the instant it lands
// instead of on their next poll. Bot games have no subscribers (their
// client never opens a stream), so those broadcasts are no-ops. A
// broadcast must never fail a save: each subscriber write is guarded.
const gameSubscribers = new Map();
function broadcastGame(game) {
  try {
    const subs = gameSubscribers.get(game.id);
    if (!subs || subs.size === 0) return;
    for (const sub of [...subs]) {
      try {
        const out = serializeGame(game, sub.user);
        if (game.status === 'finished') { const { isOpp } = gameSides(game, sub.user); out.stats = gameStatsPayload(game, isOpp); }
        sub.res.write(`event: game\ndata: ${JSON.stringify(out)}\n\n`);
      } catch {}
    }
  } catch {}
}
// Presence / disconnect (v123, item 2): real-player games only. The
// client heartbeats (POST /api/games/:id/heartbeat, every 5s) and every
// game GET/play also counts as seen, so a player who loses their
// connection or closes the app stops being seen within seconds. The
// map is in-memory only (a restart just means "connected" until the
// next heartbeat) and keyed by game id; entries are pruned when the
// game is finished. The 30s exit rule only runs once the game has
// started — before that, the countdown fallback handles a no-show.
const PRESENCE_GONE_MS = 30000; // unseen this long -> exits the game
const PRESENCE_FADE_MS = 10000; // unseen this long -> pfp fades grey
const presenceByGame = new Map(); // gameId -> { challengerId, opponentId, lastSeen: { [userId]: ms } }
function presenceTouch(game, userId) {
  if (!game || game.botType !== 'human') return;
  let p = presenceByGame.get(game.id);
  if (!p) { p = { challengerId: game.userId, opponentId: game.opponentId, lastSeen: {} }; presenceByGame.set(game.id, p); }
  p.lastSeen[userId] = Date.now();
}
function presenceOpponentConnected(game, user) {
  // True unless the opponent has been unseen for >10s. No entry (or
  // no opponent timestamp yet) means "connected" — a fresh game must
  // never start faded.
  if (!game || game.botType !== 'human') return true;
  const p = presenceByGame.get(game.id);
  if (!p) return true;
  const { isOpp } = gameSides(game, user);
  const oppId = isOpp ? game.userId : game.opponentId;
  const seen = p.lastSeen[oppId];
  if (!seen) return true;
  return Date.now() - seen <= PRESENCE_FADE_MS;
}
function presenceOpponentGoneMs(game, user) {
  // Milliseconds since the opponent was last seen, or 0 if unknown.
  if (!game || game.botType !== 'human') return 0;
  const p = presenceByGame.get(game.id);
  if (!p) return 0;
  const { isOpp } = gameSides(game, user);
  const oppId = isOpp ? game.userId : game.opponentId;
  const seen = p.lastSeen[oppId];
  return seen ? Date.now() - seen : 0;
}
async function presenceCheckExit(game, user) {
  // Called on every game request (GET/heartbeat/actions) for a started
  // active human game: if the OPPONENT has been unseen for >30s, they
  // exit — the game ends, they lose, and the reason names them. The
  // caller (the remaining player) wins. Returns true if it ended the
  // game. The leaver's own requests never trigger their own exit
  // (their touch above just ran), and a game with a recorded Leave
  // (leftBy) is already decided, so it is never re-ended here.
  if (!game || game.botType !== 'human' || game.status !== 'active' || !game.started || game.leftBy) return false;
  const goneMs = presenceOpponentGoneMs(game, user);
  if (goneMs <= PRESENCE_GONE_MS) return false;
  const { isOpp, mySide } = gameSides(game, user);
  const leaverId = isOpp ? game.userId : game.opponentId;
  const leaver = (await q('SELECT first_name, username FROM users WHERE id=$1', [leaverId])).rows[0];
  const name = (leaver && leaver.first_name) || (leaver && leaver.username) || 'Your opponent';
  // v193: log the exit (diagnostics only — the 30s rule itself is
  // unchanged). Jeff's Nov 24 report was "games were not in sync"
  // with challenges rarely landing; if a game ends here, the log
  // says which game, who vanished, and for how long, so a flap
  // (a phone briefly backgrounded) reads differently from a real
  // exit.
  console.log(`Presence exit: game ${game.id}, player ${leaverId} (${name}) unseen ${Math.round(goneMs / 1000)}s, ended by ${user.id}`);
  // The remaining player (mySide) wins; the absent player loses.
  await endGame(game, user, `${name} exited the game.`, mySide);
  presenceByGame.delete(game.id);
  broadcastGame(game);
  return true;
}
// Voiding stranded games (v194): an "In progress" game you're not in
// should be impossible — the 30s presence exit only fires once a game
// has started AND the remaining player keeps requesting, so a game
// where a side never entered (or both sides walked away) sat active
// forever and showed up as a Resume row. A voided game is a distinct
// terminal state: it never finished, so it appears in no finished
// list, moves no Elo, and writes no stats or elo_history (only
// endGame does that, and voiding never calls it).
//   N = 5 minutes for a game that never started: accept -> enter ->
//   countdown -> /start completes in ~30s, so 5 minutes is 10x
//   headroom; a game still unstarted after that had a side that
//   never arrived.
//   M = 60 minutes with no save at all (updated_at): anyone on the
//   game screen saves at least every few seconds (1s poll, plays,
//   passes), so an hour of silence means both players walked away.
//   Presence already decides shorter absences when one side returns.
// Thresholds are overridable so the harness can shrink them.
let VOID_NEVER_STARTED_MS = 5 * 60 * 1000;
let VOID_ABANDONED_MS = 60 * 60 * 1000;
const VOID_SWEEP_EVERY_MS = 60 * 1000;
async function voidStaleGames(opts = {}) {
  const neverStartedMs = opts.neverStartedMs ?? VOID_NEVER_STARTED_MS;
  const abandonedMs = opts.abandonedMs ?? VOID_ABANDONED_MS;
  try {
    const neverCutoff = new Date(Date.now() - neverStartedMs).toISOString();
    const abandonedCutoff = new Date(Date.now() - abandonedMs).toISOString();
    const r = await q(`UPDATE games SET state = jsonb_set(state, '{status}', '"void"'), updated_at = now()
      WHERE bot_type = 'human' AND state->>'status' = 'active'
      AND (
        (COALESCE((state->>'started')::boolean, false) = false
         AND COALESCE(jsonb_array_length(state->'moves'->'human'), 0) = 0
         AND COALESCE(jsonb_array_length(state->'moves'->'bot'), 0) = 0
         AND state->>'lastHuman' IS NULL AND state->>'lastBot' IS NULL
         AND created_at < $1::timestamptz)
        OR updated_at < $2::timestamptz
      )
      RETURNING id`, [neverCutoff, abandonedCutoff]);
    for (const row of (r.rows || [])) console.log(`Voided stale game ${row.id}`);
    return (r.rows || []).map((row) => row.id);
  } catch (e) {
    console.error('Void sweep failed:', e.message);
    return [];
  }
}
let voidSweepTimer = null;
function startVoidSweep() {
  if (voidSweepTimer) return voidSweepTimer;
  const t = setInterval(() => { voidStaleGames(); }, VOID_SWEEP_EVERY_MS);
  if (t.unref) t.unref();
  voidSweepTimer = t;
  return t;
}
// Play Online matchmaking (v123, item 4): a 7-second real-person
// search. Waiting players sit in this in-memory queue (userId ->
// joinedAt); a searcher is paired with the longest-waiting other
// player and a human game is created for them, which the waiting
// player discovers on their next search poll. If the 7s window ends
// with no match, the client falls back to a persona. The queue is
// in-memory (a restart just means an empty lobby) and entries older
// than 15s are pruned on every search, so a player who closed the
// app mid-search never blocks a pairing.
const MATCH_QUEUE_TTL_MS = 15000;
const matchQueue = new Map(); // userId -> joinedAt (ms)
const pendingMatches = new Map(); // userId -> gameId (a game created for them by a searcher)
function matchmakingPrune() {
  const now = Date.now();
  for (const [uid, at] of matchQueue) if (now - at > MATCH_QUEUE_TTL_MS) matchQueue.delete(uid);
}
async function saveGameRow(game, opts = {}) {
  // Optimistic concurrency: every save bumps `version`, and a guarded
  // save only lands if the row still holds the version this request
  // loaded. A poll GET that loaded before a play must never save its
  // stale snapshot over the play — the play appeared on both screens
  // for a second, then the stale GET's save pulled it back. Guarded
  // callers (the GET settle) get `false` on a conflict and return the
  // fresh row instead; unguarded callers (a play, a pass, a forfeit)
  // always land, because the move itself is the newer fact.
  const prevVersion = game.version || 0;
  const copy = { ...game, board: stripBoard(game.board), version: prevVersion + 1 };
  delete copy.id;
  const json = JSON.stringify(copy);
  if (game.id) {
    const cond = opts.guarded ? " AND COALESCE((state->>'version')::int, 0)=$3" : '';
    const params = opts.guarded ? [json, game.id, prevVersion] : [json, game.id];
    const r = await q(`UPDATE games SET state=$1::jsonb, updated_at=now() WHERE id=$2${cond}`, params);
    if (opts.guarded && r.rowCount === 0) return false;
    game.version = prevVersion + 1;
  } else { const r = await q('INSERT INTO games (user_id, bot_type, bot_elo, opponent_id, state) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id', [game.userId, game.botType, game.botElo, game.opponentId || null, json]); game.id = Number(r.rows[0].id); game.version = prevVersion + 1; }
  broadcastGame(game);
  return true;
}
function loadGameRow(row) {
  const g = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
  g.id = row.id;
  // Re-attach premiums for the solver (solver reads board.__premiums)
  g.board.__premiums = g.premiums;
  return g;
}
function settleClock(game, clientElapsedMs) {
  if (game.status !== 'active') return;
  const now = Date.now();
  const serverElapsed = now - game.turnStartedAt;
  let elapsed = serverElapsed;
  // Tap-time settle: the client sends how long had passed since it
  // received the current turn (its tap time, as a duration, never an
  // absolute clock — so server/client clock skew cannot matter). If
  // that duration is just under the server's (the POST network time,
  // typically <1s), settle at the tap instead of at request arrival,
  // so the human clock does not tick for another second after the
  // tap. A duration far under the server's is not trusted (that
  // would let a client freeze its own clock), so it falls back to
  // the server elapsed.
  if (Number.isFinite(clientElapsedMs) && clientElapsedMs >= 0 && serverElapsed - clientElapsedMs >= 0 && serverElapsed - clientElapsedMs <= 2000) elapsed = clientElapsedMs;
  if (game.turn === 'human') game.clocks.human = Math.max(0, game.clocks.human - elapsed);
  else game.clocks.bot = Math.max(0, game.clocks.bot - elapsed);
  game.turnStartedAt = now;
}
function updateStatsForMove(game, side, move, bestScoreBefore) {
  const list = game.moves[side];
  const isOptimal = bestScoreBefore !== null && move.score === bestScoreBefore;
  list.push({ words: move.words.map(w => ({ word: w.word, score: w.score })), score: move.score, isOptimal, mainWord: move.mainWord, bingo: !!move.bingo });
}
// v138: a bot game (Doppelgänger/Fishstick) forfeited before
// either side has played a move is a FREE EXIT — no loss, no stats,
// no Game History entry. Persona and real-player games never
// free-exit (their forfeit is a loss even before the first move).
// "No moves played" is the moveLog being empty. Passes are not
// logged, so a pass does not count as a move here.
function hasNoMoves(game) {
  if (Array.isArray(game.moveLog)) return game.moveLog.length === 0;
  const hm = (game.moves && game.moves.human) || [];
  const bm = (game.moves && game.moves.bot) || [];
  return hm.length === 0 && bm.length === 0;
}
function isFreeExitGame(game) {
  return !!game && (game.botType === 'competitive' || game.botType === 'fishstick') && hasNoMoves(game);
}
// v140: a finished bot game (Doppelgänger/Fishstick) where neither
// side scored (0-0) — nobody played a move, so under v138 it would
// have been a free exit, not a recorded loss. These are pre-v138
// forfeits recorded as 0-0 losses. Kept out of Game History (list
// + detail). Real-player and persona 0-0 games are NOT excluded:
// their early forfeit still counts as a loss. A game whose state
// has no scores key at all is never excluded (safe direction).
function isZeroZeroBotGame(game) {
  if (!game || (game.botType !== 'competitive' && game.botType !== 'fishstick')) return false;
  const s = game.scores || {};
  return s.human === 0 && s.bot === 0;
}
async function deleteGameRow(game) {
  await q('DELETE FROM games WHERE id=$1', [game.id]);
}
async function endGame(game, user, reason, winnerSide) {
  // A game already decided by a Leave (v123, item 3) is only being
  // finalized now that the opponent played it out: the winner, the
  // reason, and both Elo moves were recorded at Leave time, so none
  // of them is touched again here — the game just becomes finished.
  if (game.leftBy && game.eloDeltaHuman !== null && game.eloDeltaHuman !== undefined) {
    game.status = 'finished';
    await saveGameRow(game);
    return game;
  }
  // winnerSide: 'human' | 'bot' | 'draw' | null (forfeit handled by caller setting winner)
  game.status = 'finished';
  game.reason = reason;
  game.winner = winnerSide;
  const actual = winnerSide === 'human' ? 1 : winnerSide === 'bot' ? 0 : 0.5;
  // Standard Elo, K=32 on a 400-point scale, zero-sum: the opponent
  // always moves the opposite way, and a draw uses actual 0.5, so a
  // draw against a stronger opponent gains while a draw against an
  // equal opponent moves nobody. Doppelgänger is no exception: its
  // next game re-syncs to the player's current Elo at creation, so
  // storing the opposite move here does not break its always-equal
  // matching. Fishstick IS the exception (v199): it moves nobody's
  // Elo — see the freeze below.
  // A real-player game moves BOTH ratings: the delta is computed
  // from the challenger's fresh Elo against the opponent's Elo at
  // creation (the same asymmetry as the bot path, where the bot's
  // rating is its start Elo), and both users get an elo_history row.
  // The passed-in user may be either player (whoever's request
  // ended the game), so both rows are loaded fresh here.
  if (game.botType === 'human' && game.opponentId) {
    const challenger = (await q('SELECT * FROM users WHERE id=$1', [game.userId])).rows[0];
    const opponent = (await q('SELECT * FROM users WHERE id=$1', [game.opponentId])).rows[0];
    if (challenger && opponent) {
      const delta = eloDelta(challenger.elo, game.botElo, actual);
      game.eloDeltaHuman = delta;
      game.eloDeltaBot = -delta;
      game.eloAfterHuman = challenger.elo + delta;
      game.eloAfterBot = game.botElo + game.eloDeltaBot;
      game.botElo = game.eloAfterBot;
      await q('UPDATE users SET elo=$1, elo_high=GREATEST(elo_high,$2) WHERE id=$3', [game.eloAfterHuman, game.eloAfterHuman, challenger.id]);
      await q('UPDATE users SET elo=$1, elo_high=GREATEST(elo_high,$2) WHERE id=$3', [game.eloAfterBot, game.eloAfterBot, opponent.id]);
      await saveGameRow(game);
      await q('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [challenger.id, game.id, game.eloAfterHuman, delta]);
      await q('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [opponent.id, game.id, game.eloAfterBot, -delta]);
      return game;
    }
    // A player row is gone (deleted account): finish the game with
    // no rating move rather than failing the request.
    game.eloDeltaHuman = 0; game.eloDeltaBot = 0;
    game.eloAfterHuman = challenger ? challenger.elo : null;
    game.eloAfterBot = opponent ? opponent.elo : game.botElo;
    await saveGameRow(game);
    return game;
  }
  // v199: Fishstick moves nobody's Elo — a win, draw, or loss
  // against Fishstick leaves both ratings exactly where they were
  // (a draw at 3000 used to gain ~16). No users UPDATE, no
  // elo_history row; the game result itself still saves, with
  // zero deltas recorded on it.
  if (game.botType === 'fishstick') {
    game.eloDeltaHuman = 0; game.eloDeltaBot = 0;
    game.eloAfterHuman = user.elo;
    game.eloAfterBot = game.botElo;
    await saveGameRow(game);
    return game;
  }
  const delta = eloDelta(user.elo, game.botElo, actual);
  game.eloDeltaHuman = delta;
  game.eloDeltaBot = -delta;
  game.eloAfterHuman = user.elo + delta;
  game.eloAfterBot = game.botElo + game.eloDeltaBot;
  game.botElo = game.eloAfterBot;
  user.elo = game.eloAfterHuman;
  await q('UPDATE users SET elo=$1, elo_high=GREATEST(elo_high,$2) WHERE id=$3', [game.eloAfterHuman, game.eloAfterHuman, user.id]);
  // A persona's Elo moves exactly like a human opponent's: the stored
  // rating is updated in place, so the leaderboard and the next game
  // against them reflect every result.
  if (game.botType === 'persona' && game.persona && game.persona.id) {
    await q('UPDATE personas SET elo=$1 WHERE id=$2', [game.eloAfterBot, game.persona.id]);
  }
  await saveGameRow(game);
  await q('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [user.id, game.id, game.eloAfterHuman, delta]);
  return game;
}
// Leave (v123, item 3): a real-player game where one player walks
// away (out of time + losing). The leaver loses and their Elo moves
// NOW; the game records the result but stays ACTIVE so the opponent
// can keep playing words against the absent player. When the
// opponent finally finishes (clocks / no moves), endGame finalizes
// it without touching the result again (see the leftBy guard above).
// The leaver's own view already reads 'finished' (serializeGame).
// Bot games never use this — a bot has no one to play out, so Leave
// there is a plain forfeit (the endpoint routes it to endGame).
async function applyLeave(game, leaverSide, leaverName) {
  const winnerSide = leaverSide === 'human' ? 'bot' : 'human';
  const actual = leaverSide === 'human' ? 0 : 1; // challenger's result
  game.leftBy = leaverSide;
  game.winner = winnerSide;
  game.reason = `${leaverName} left the game.`;
  const challenger = (await q('SELECT * FROM users WHERE id=$1', [game.userId])).rows[0];
  const opponent = (await q('SELECT * FROM users WHERE id=$1', [game.opponentId])).rows[0];
  if (challenger && opponent) {
    const delta = eloDelta(challenger.elo, game.botElo, actual);
    game.eloDeltaHuman = delta;
    game.eloDeltaBot = -delta;
    game.eloAfterHuman = challenger.elo + delta;
    game.eloAfterBot = game.botElo + game.eloDeltaBot;
    game.botElo = game.eloAfterBot;
    await q('UPDATE users SET elo=$1, elo_high=GREATEST(elo_high,$2) WHERE id=$3', [game.eloAfterHuman, game.eloAfterHuman, challenger.id]);
    await q('UPDATE users SET elo=$1, elo_high=GREATEST(elo_high,$2) WHERE id=$3', [game.eloAfterBot, game.eloAfterBot, opponent.id]);
    await saveGameRow(game);
    await q('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [challenger.id, game.id, game.eloAfterHuman, delta]);
    await q('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [opponent.id, game.id, game.eloAfterBot, -delta]);
  } else {
    game.eloDeltaHuman = 0; game.eloDeltaBot = 0;
    game.eloAfterHuman = challenger ? challenger.elo : null;
    game.eloAfterBot = opponent ? opponent.elo : game.botElo;
    await saveGameRow(game);
  }
  broadcastGame(game);
  return game;
}
function applyMove(game, side, move, bestScoreBefore) {
  const isHuman = side === 'human';
  for (const p of move.placements) game.board[p.row][p.col] = p.letter;
  if (isHuman) {
    // Remove used letters from the rack by matching placements, then refill
    // the exact vacated indices (unplayed tiles never move).
    const rack = game.humanRack.slice();
    const usedIndices = [];
    const remaining = rack.slice();
    for (const p of move.placements) {
      const idx = remaining.indexOf(p.letter);
      if (idx >= 0) { usedIndices.push(idx); remaining[idx] = null; }
    }
    game.humanRack = refillRack(rack, usedIndices);
  } else {
    // Same in-place refill as the human side: remove the used letters
    // by index and refill the exact vacated slots, so unplayed tiles
    // never move. The old code spliced the played letters out and
    // appended new ones at the end, which shifted every unplayed tile
    // left after every play — and the floor fix then swapped one of
    // the survivors out. This side is the recipient's rack in a real
    // 1v1, so it was Jeff's rack moving after every one of his plays.
    const rack = game.botRack.slice();
    const usedIndices = [];
    const remaining = rack.slice();
    for (const p of move.placements) {
      const idx = remaining.indexOf(p.letter);
      if (idx >= 0) { usedIndices.push(idx); remaining[idx] = null; }
    }
    game.botRack = refillRack(rack, usedIndices);
  }
  game.scores[side] += move.score;
  game.lastCells = move.highlightCells;
  game.lastWord = move.mainWord;
  game.lastScore = move.score;
  game.lastBy = side;
  // Chronological replay log (v123): the placements are what rebuild
  // the board at any step; words/score are what the replay shows.
  // clocks (v126): the remaining time on each clock right after this
  // move, so the replay can tick the clocks back to when the move was
  // played. settleClock already ran before applyMove in every path
  // (human play, bot turn), so these are the settled post-move values.
  (game.moveLog = game.moveLog || []).push({ side, placements: (move.placements || []).map((p) => ({ row: p.row, col: p.col, letter: p.letter })), words: (move.words || []).map((w) => ({ word: w.word, score: w.score })), score: move.score, mainWord: move.mainWord, clocks: { human: game.clocks.human, bot: game.clocks.bot } });
  const allWords = (move.words || []).map(w => w.word);
  if (isHuman) game.lastHuman = { word: move.mainWord, points: move.score, bonus: move.bonus, isDuello: move.isDuello, bingo: move.bingo, words: allWords };
  else game.lastBot = { word: move.mainWord, points: move.score, bonus: move.bonus, isDuello: move.isDuello, bingo: move.bingo, words: allWords };
  updateStatsForMove(game, side, move, bestScoreBefore);
  game.consecutivePasses = 0;
  game.consecutiveNoMoves = 0;
}
function runBotTurn(game) {
  // Called after settleClock, when turn === 'bot' and status is active.
  // Returns true if the bot moved, false if it passed / was skipped.
  if (game.status !== 'active' || game.turn !== 'bot') return false;
  if (game.clocks.bot <= 0) { game.turn = 'human'; game.turnStartedAt = Date.now(); return false; }
  if (game.pendingBotMove) {
    const { move, bestScore } = game.pendingBotMove;
    game.pendingBotMove = null;
    applyMove(game, 'bot', move, bestScore);
    markPersonaMovePlayed(game);
    game.turn = 'human'; game.turnStartedAt = Date.now();
    return true;
  }
  const isFirst = boardIsEmpty(game.board);
  const moves = findMoves(game.board, game.botRack, isFirst, true);
  if (!moves.length) {
    game.consecutivePasses++;
    game.consecutiveNoMoves++;
    game.clocks.bot = Math.max(0, game.clocks.bot - 30000);
    game.lastBot = { word: null, points: 0, passed: true, auto: true, noMoves: true };
    game.turn = 'human'; game.turnStartedAt = Date.now();
    // Neither side has a move: end at once instead of handing the
    // game to a human turn that can never play.
    const humanMoves = findMoves(game.board, game.humanRack, isFirst, false);
    if (!humanMoves.length || game.consecutiveNoMoves >= 2) {
      // Game ends by score; caller will finish it (needs user for Elo).
      game._pendingNoMovesEnd = true;
    }
    return false;
  }
  const bestScore = moves[0].score;
  // v160 shot clock: when the human clock is at 0 the persona is the
  // countdown player — it plays an easy move, not its Elo pick (the
  // precomputed path in scheduleBotMove branches the same way).
  const move = game.botType === 'fishstick' ? moves[0] : game.botType === 'persona' ? (game.clocks.human <= 0 ? pickPersonaEasyMove(moves) : pickPersonaMove(moves, game.botElo)) : pickCompetitiveMove(moves, game.botElo);
  applyMove(game, 'bot', move, bestScore);
  markPersonaMovePlayed(game);
  game.turn = 'human'; game.turnStartedAt = Date.now();
  return true;
}
function markPersonaMovePlayed(game) {
  // Spends the persona final-move flag once the final move is played,
  // so the next turn under 20s uses the normal think and the clock
  // runs out mid-think instead of granting another final move.
  if (game.botType === 'persona' && game.personaFinalMovePending) { game.personaFinalMoveDone = true; game.personaFinalMovePending = false; }
}

function applyHumanNoMovePass(game) {
  // No-move auto-pass for the human side: if it is the human's turn
  // and the human has no playable move, the human automatically
  // passes (-30s, like a manual pass), the last line says so, and
  // the turn goes to the bot. If the bot also has no move (or its
  // clock is already 0, so it can never move), the game ends by
  // score instead of passing into a turn that can never play.
  // Returns true only when it flagged the game to end (the caller
  // runs finishIfNeeded); a pass itself needs no further action.
  if (game.status !== 'active' || game.turn !== 'human') return false;
  const isFirst = boardIsEmpty(game.board);
  if (findMoves(game.board, game.humanRack, isFirst, false).length) return false;
  if (!findMoves(game.board, game.botRack, isFirst, false).length || game.clocks.bot <= 0) {
    game._pendingNoMovesEnd = true;
    return true;
  }
  game.clocks.human = Math.max(0, game.clocks.human - 30000);
  game.consecutivePasses++;
  game.consecutiveNoMoves++;
  game.lastHuman = { word: null, points: 0, passed: true, auto: true, noMoves: true };
  startBotTurn(game);
  return false;
}
function applyBotNoMovePass(game) {
  // Mirror of applyHumanNoMovePass for the bot side, used only in
  // real-player games (the bot side is the other real player): if
  // it is their turn and they have no playable move, they
  // automatically pass (-30s) and the turn goes back to the
  // challenger. If neither side has a move (or the challenger's
  // clock is already 0), the game ends by score instead.
  // Returns true only when it flagged the game to end.
  if (game.status !== 'active' || game.turn !== 'bot') return false;
  const isFirst = boardIsEmpty(game.board);
  if (findMoves(game.board, game.botRack, isFirst, false).length) return false;
  if (!findMoves(game.board, game.humanRack, isFirst, false).length || game.clocks.human <= 0) {
    game._pendingNoMovesEnd = true;
    return true;
  }
  game.clocks.bot = Math.max(0, game.clocks.bot - 30000);
  game.consecutivePasses++;
  game.consecutiveNoMoves++;
  game.lastBot = { word: null, points: 0, passed: true, auto: true, noMoves: true };
  game.turn = 'human'; game.turnStartedAt = Date.now();
  return false;
}
// Which side the requesting player is, in a real-player game: the
// challenger (row owner) is 'human', the recipient is 'bot'. Bot
// games always resolve to 'human'.
function gameSides(game, user) {
  const isOpp = game.botType === 'human' && game.opponentId === user.id;
  return { isOpp, mySide: isOpp ? 'bot' : 'human', oppSide: isOpp ? 'human' : 'bot' };
}

function stepBotClockTo20sMark(game) {
  if (game.clocks.bot > 0) game.clocks.bot = Math.floor((game.clocks.bot - 1) / 20000) * 20000;
  else game.clocks.bot = 0;
}
async function advanceBotTurnIfReady(game, user) {
  // Returns true if the bot actually moved (clock should step), false otherwise.
  if (game.status !== 'active' || game.turn !== 'bot') return false;
  // An out-of-time bot never consumes think time: skip it at once instead
  // of waiting out the think and only then handing the turn back.
  if (game.clocks.bot <= 0) { game.turn = 'human'; game.turnStartedAt = Date.now(); game.botThinkUntil = null; return false; }
  const until = game.botThinkUntil || (game.turnStartedAt + botThinkMsFor(game));
  // A persona never moves in under 3 seconds, even at the end: the
  // think functions already floor at 3000ms, but the poll tolerance
  // below could still play a short think early, so the turn itself
  // is gated. The turn start is recovered from the stored think
  // (botThinkUntil - botThinkMs), because turnStartedAt drifts
  // forward on every settleClock.
  if (game.botType === 'persona' && Number.isFinite(game.botThinkUntil) && Number.isFinite(game.botThinkMs)) {
    const turnStart = game.botThinkUntil - game.botThinkMs;
    if (Date.now() < turnStart + 3000) return false;
  }
  // Tolerance is half the think: the client polls at think from its tap,
  // but the server's think timer starts when the Play POST arrives
  // (network time later), so a poll at tap+think would otherwise miss and
  // need a second poll. Within tolerance the move runs.
  const thinkSpan = until - game.turnStartedAt;
  // Tolerance is capped: half of a 33s persona think would let an
  // early poll play the move at ~17s. 2500ms matches the old
  // tolerance exactly for 5s thinks and 1000ms for 2s thinks.
  const tol = Math.max(500, Math.min(thinkSpan / 2, 2500));
  if (Date.now() < until - tol) return false;
  settleClock(game);
  const moved = runBotTurn(game);
  // Personas consume only their think time: the 20s step would
  // double-charge them and break the 1-8s final move.
  if (moved && game.botType !== 'persona') stepBotClockTo20sMark(game);
  game.botThinkUntil = null;
  if (await finishIfNeeded(game, user)) { /* finished */ }
  // The bot just moved: if the human now has no move, auto-pass the
  // human at once instead of leaving the game on a dead human turn.
  if (game.status === 'active' && game.turn === 'human') {
    applyHumanNoMovePass(game);
    if (await finishIfNeeded(game, user)) { /* finished */ }
  }
  // Timeout loop: if the bot just played and the human's clock is already
  // at 0, do not hand the turn back to a player who cannot move — start
  // the next bot think immediately, so the bot keeps playing (2s think
  // when the human is out of time, otherwise 5s) / play / 15s runoff …
  // until its own clock hits 0 or the game ends.
  if (game.status === 'active' && game.turn === 'human' && game.clocks.human <= 0 && game.clocks.bot > 0) startBotTurn(game);
  return moved;
}
// Precompute the bot's move during its 5s think, so the poll at 5s does
// not pay the solver scan on top of the think (that scan is what pushed
// the perceived think to ~6s). The move is computed after the human
// move response is sent, saved to the game row, and applied instantly
// by runBotTurn. If it is not ready in time, runBotTurn falls back to
// computing on demand, so a slow scan can never break a bot turn.
function scheduleBotMove(game) {
  if (!game.id || !game.userId) return;
  const gameId = game.id, userId = game.userId;
  const beforeLastBot = game.lastBot ? JSON.stringify(game.lastBot) : '';
  setTimeout(async () => {
    try {
      const g = await loadGameForUser({ id: userId }, gameId);
      if (!g || g.status !== 'active' || g.turn !== 'bot' || g.pendingBotMove) return;
      if ((g.lastBot ? JSON.stringify(g.lastBot) : '') !== beforeLastBot) return;
      const isFirst = boardIsEmpty(g.board);
      const moves = findMoves(g.board, g.botRack, isFirst, true);
      if (!moves.length) return;
      const bestScore = moves[0].score;
      // v160 shot clock: when the human clock is at 0 the persona is
      // the countdown player — it plays an easy move, not its Elo
      // pick (runBotTurn's on-demand fallback branches the same way).
      const move = g.botType === 'fishstick' ? moves[0] : g.botType === 'persona' ? (g.clocks.human <= 0 ? pickPersonaEasyMove(moves) : pickPersonaMove(moves, g.botElo)) : pickCompetitiveMove(moves, g.botElo);
      const g2 = await loadGameForUser({ id: userId }, gameId);
      if (!g2 || g2.status !== 'active' || g2.turn !== 'bot' || g2.pendingBotMove) return;
      if ((g2.lastBot ? JSON.stringify(g2.lastBot) : '') !== beforeLastBot) return;
      g2.pendingBotMove = { move, bestScore };
      // Personas think in proportion to the move they are about to
      // play (see personaThinkMsForMove): easiest after ~7s, hardest
      // after ~33s, averaging ~20s. The opening think was only a
      // short placeholder, so the client re-polls at the revised
      // time. The final move keeps its clock-based timing (it must
      // land with 1-8s left), so it is never revised here.
      if (g2.botType === 'persona' && !g2.personaFinalMovePending) {
        // The first move is quick — 5-11s, averaging 8s — so the
        // game gets going instead of opening on a long stare. Later
        // moves think in proportion to the move they are about to
        // play (see personaThinkMsForMove): easiest after ~7s,
        // hardest after ~33s, averaging ~20s. The opening think was
        // only a short placeholder, so the client re-polls at the
        // revised time. The final move keeps its clock-based timing
        // (it must land with 1-8s left), so it is never revised here.
        // Think is measured against the best play on the board, so a
        // long think means a genuinely good move.
        if (!g2.lastBot) {
          const first = 5000 + Math.floor(Math.random() * 6000);
          g2.botThinkMs = Number.isFinite(g2.clocks.bot) && g2.clocks.bot > 0
            ? Math.max(3000, Math.min(first, g2.clocks.bot - 1000))
            : first;
        } else if (g2.clocks.human <= 0 && Number.isFinite(g2.personaShotClockThinkMs)) {
          // v160 shot clock: the think rolled once in startBotTurn —
          // easy moves, ~6s average; 1 in 8 it runs past the 9s
          // window so the countdown expires first. Capped by the
          // persona's own clock, like every other think.
          g2.botThinkMs = Math.max(3000, Math.min(g2.personaShotClockThinkMs, g2.clocks.bot - 1000));
        } else {
          g2.botThinkMs = personaThinkMsForMove(move.score, bestScore, g2.clocks.bot);
          // v157 byoyomi: the revised think is the one that actually
          // lands the move, so cap it here too — when the human clock
          // is at 0 the persona is the countdown player and must move
          // inside 9s (7s cap, 2s margin).
          if (g2.clocks.human <= 0) g2.botThinkMs = Math.min(g2.botThinkMs, 7000);
        }
        g2.botThinkUntil = g2.turnStartedAt + g2.botThinkMs;
      }
      await saveGameRow(g2);
    } catch {}
  }, 500);
}
// Bot think is 5s normally, but only 2s once the human clock is at 0:
// with no human moves to wait for, the bot-only stretch should move fast.
// Personas ignore that shortcut: their think tracks the move they are
// about to play (see personaThinkMsForMove), so a filler is quick and
// a big play is slow, even in a bot-only stretch.
function botThinkMsFor(game) {
  if (game.botType === 'persona') {
    // v160 byoyomi: when the human clock is at 0, the persona is the
    // countdown player — easy moves, averaging 6s, and 1 in 8 times
    // it lets the 9s countdown expire. The think was rolled once
    // in startBotTurn (personaShotClockThinkMs), so this placeholder
    // and the scheduleBotMove revision agree on one value; two
    // independent rolls would play the earlier of the two. The
    // final-move think (1-8s left on the persona clock) keeps its
    // clock-based timing and is never replaced here. Fallback to
    // the v157 7s cap when no stored think exists (a game loaded
    // mid-turn from before v160).
    const think = personaThinkMs(game);
    if (game.clocks.human <= 0) {
      if (!game.personaFinalMovePending && Number.isFinite(game.personaShotClockThinkMs)) {
        return Math.max(3000, Math.min(game.personaShotClockThinkMs, game.clocks.bot - 1000));
      }
      return Math.min(think, 7000);
    }
    return think;
  }
  return game.clocks.human <= 0 ? 2000 : 5000;
}
function startBotTurn(game) {
  game.turn = 'bot'; game.turnStartedAt = Date.now();
  // Arm the persona final move before the think is chosen: this turn
  // is the one that plays with 1-8 seconds left, if the clock is
  // under 20s and the final move has not been spent yet.
  if (game.botType === 'persona' && game.clocks.bot < 20000 && !game.personaFinalMoveDone) game.personaFinalMovePending = true;
  // v160 shot clock: when the human clock is at 0 the persona plays
  // on the 9s countdown — roll the turn's think ONCE here, so the
  // placeholder (botThinkMsFor) and the revision (scheduleBotMove)
  // agree. Easy moves, 4-8s (averaging 6s); 1 in 8 the think runs
  // past the window (15s), so the countdown expires first and the
  // game ends by score. The final move is exempt: it keeps its
  // clock-based timing (1-8s left). Cleared on every other turn so
  // a stale value never leaks into a normal think.
  if (game.botType === 'persona' && game.clocks.human <= 0 && !game.personaFinalMovePending) {
    game.personaShotClockThinkMs = Math.random() < 1 / 8 ? 15000 : 4000 + Math.floor(Math.random() * 4000);
  } else {
    game.personaShotClockThinkMs = null;
  }
  game.botThinkMs = botThinkMsFor(game);
  game.botThinkUntil = Date.now() + game.botThinkMs;
  scheduleBotMove(game);
}

async function finishIfNeeded(game, user) {
  if (game._pendingNoMovesEnd) {
    delete game._pendingNoMovesEnd;
    const winner = game.scores.human > game.scores.bot ? 'human' : game.scores.bot > game.scores.human ? 'bot' : 'draw';
    await endGame(game, user, 'No playable moves left', winner);
    return true;
  }
  if (game.clocks.human <= 0 && game.clocks.bot <= 0) {
    const winner = game.scores.human > game.scores.bot ? 'human' : game.scores.bot > game.scores.human ? 'bot' : 'draw';
    await endGame(game, user, 'Final score', winner);
    return true;
  }
  return false;
}
// Offline sync validation (v106): a finished game played on the device
// is only trusted after a full replay against the server engine. The
// client sends the per-move rack log (`plays`) because state.moves
// carries words/scores but no placements, and the state alone cannot be
// replayed. Pure function (no DB): returns {ok:true} or
// {ok:false, error}. With opts.shapeOnly it runs only the cheap shape
// checks, so the endpoint can do shape -> idempotency check -> replay
// in that order. Never throws on a malformed payload: anything the
// replay cannot make sense of is a 422, not a 500.
function validateOfflineSync(eng, payload, opts = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!payload || typeof payload !== 'object') return fail('Missing game payload.');
  const { offlineId, botType, botElo, playerEloAtStart, eloDelta: delta, state, plays } = payload;
  if (typeof offlineId !== 'string' || !offlineId.trim()) return fail('offlineId is required.');
  if (botType !== 'competitive' && botType !== 'fishstick') return fail('botType must be competitive or fishstick.');
  if (!Number.isFinite(playerEloAtStart)) return fail('playerEloAtStart must be a number.');
  if (!Number.isFinite(delta)) return fail('eloDelta must be a number.');
  if (!Number.isFinite(botElo)) return fail('botElo must be a number.');
  if (botType === 'fishstick' && botElo !== 3000) return fail('Fishstick botElo must be 3000.');
  if (botType === 'competitive' && botElo !== playerEloAtStart) return fail('Competitive botElo must equal playerEloAtStart.');
  if (!state || typeof state !== 'object') return fail('state is required.');
  if (state.status !== 'finished') return fail('state.status must be finished.');
  if (state.winner !== 'human' && state.winner !== 'bot' && state.winner !== 'draw') return fail('state.winner must be human, bot, or draw.');
  // A forfeit before any move is a real game (the human forfeited at
  // once): plays is empty, the board is empty, scores are 0-0, and the
  // bot wins. Bots never forfeit, so a no-move forfeit with the human
  // as winner (or any points on the board) is not a real game.
  if (!Array.isArray(plays)) return fail('plays must be an array.');
  if (plays.length === 0) {
    const noMoveForfeit = state.reason === 'By forfeit' && state.winner === 'bot'
      && state.scores && state.scores.human === 0 && state.scores.bot === 0
      && state.moves && Array.isArray(state.moves.human) && state.moves.human.length === 0
      && Array.isArray(state.moves.bot) && state.moves.bot.length === 0;
    if (!noMoveForfeit) return fail('plays must be a non-empty array.');
  }
  if (!Array.isArray(state.board) || state.board.length !== eng.SIZE || state.board.some((r) => !Array.isArray(r) || r.length !== eng.SIZE)) return fail('state.board must be a 10x10 board.');
  if (!state.premiums || typeof state.premiums !== 'object') return fail('state.premiums is required.');
  if (!state.scores || !Number.isFinite(state.scores.human) || !Number.isFinite(state.scores.bot)) return fail('state.scores must have human and bot numbers.');
  if (!state.moves || !Array.isArray(state.moves.human) || !Array.isArray(state.moves.bot)) return fail('state.moves must have human and bot arrays.');
  if (opts.shapeOnly) return { ok: true };
  try {
    return replayOfflineSync(eng, payload);
  } catch (e) {
    return fail('Replay failed: ' + (e && e.message ? e.message : String(e)));
  }
}
function replayOfflineSync(eng, payload) {
  const fail = (error) => ({ ok: false, error });
  const { botType, botElo, playerEloAtStart, eloDelta: delta, state, plays } = payload;
  const premiums = state.premiums;
  const board = eng.emptyBoard();
  board.__premiums = premiums; // solver reads premiums from here
  const scores = { human: 0, bot: 0 };
  const moveIdx = { human: 0, bot: 0 };
  // Last play per side, for the rack-evolution check: unplayed tiles
  // never move, so the next rack for a side may differ from the last
  // only at the indices its last move vacated.
  const lastPlay = {};
  const placementsKey = (ps) => ps.map((p) => `${p.row},${p.col},${p.letter}`).sort().join('|');
  for (const play of plays) {
    if (!play || (play.side !== 'human' && play.side !== 'bot')) return fail('Each play needs side human or bot.');
    const side = play.side;
    if (!Array.isArray(play.rack) || play.rack.length !== 6 || play.rack.some((l) => typeof l !== 'string' || l.length !== 1)) return fail('Each play needs a 6-letter rack.');
    if (!Array.isArray(play.placements) || play.placements.length === 0 || play.placements.some((p) => !p || !Number.isInteger(p.row) || !Number.isInteger(p.col) || typeof p.letter !== 'string' || p.letter.length !== 1)) return fail('Each play needs placements with row, col, and a single letter.');
    const prev = lastPlay[side];
    if (prev) {
      // v168: unplayed tiles are never REPLACED — every letter the
      // previous rack held at an unplayed index must still be in this
      // rack — but their ORDER may change. Shuffle and rack
      // drag-reorder permute the rack between moves, and the payload
      // carries no record of that, so the old positional check
      // rejected every shuffled game (422 "Rack changed at an
      // unplayed index"), the drain marked it 'rejected', and the
      // game silently never reached Game History. The drawn tiles are
      // the only letters allowed to differ, and they are exactly the
      // letters not accounted for here — a swapped-in tile still
      // fails, because the unplayed letter it replaced goes missing.
      const used = new Set(prev.usedIndices);
      const need = {};
      prev.rack.forEach((l, i) => { if (!used.has(i)) need[l] = (need[l] || 0) + 1; });
      const have = {};
      play.rack.forEach((l) => { have[l] = (have[l] || 0) + 1; });
      for (const l in need) {
        if ((have[l] || 0) < need[l]) return fail(`Unplayed tile ${l} missing before a ${side} move.`);
      }
    }
    const isFirst = eng.boardIsEmpty(board);
    const res = eng.validatePlay(board, play.rack, play.placements, premiums, isFirst);
    if (!res.valid) return fail(`Invalid ${side} play: ${res.error || 'rejected'}${res.invalidWords ? ' (' + res.invalidWords.join(', ') + ')' : ''}`);
    const rec = state.moves[side][moveIdx[side]];
    if (!rec) return fail(`More ${side} plays than recorded moves.`);
    if (res.score !== rec.score) return fail(`${side} move ${moveIdx[side] + 1}: replayed score ${res.score} does not match recorded ${rec.score}.`);
    if (res.mainWord !== rec.mainWord) return fail(`${side} move ${moveIdx[side] + 1}: replayed main word ${res.mainWord} does not match recorded ${rec.mainWord}.`);
    moveIdx[side]++;
    if (side === 'bot') {
      // Bot moves are checked against the solver on the board BEFORE
      // this play. Fishstick is deterministic (exactly moves[0]);
      // Competitive is a dice roll inside the legal list, so only
      // membership in the list (with the recorded score) is checked.
      const moves = eng.findMoves(board, play.rack, isFirst, true);
      if (!moves.length) return fail('Bot has no legal move here.');
      const key = placementsKey(play.placements);
      if (botType === 'fishstick') {
        if (placementsKey(moves[0].placements) !== key || moves[0].score !== res.score) return fail('Fishstick move is not the best move.');
      } else {
        if (!moves.some((m) => placementsKey(m.placements) === key && m.score === res.score)) return fail('Competitive move is not in the legal move list.');
      }
    }
    // Which rack indices this play vacated (first-match, same as
    // applyMove), for the next rack-evolution check on this side.
    const remaining = play.rack.slice();
    const usedIndices = [];
    for (const p of play.placements) {
      const idx = remaining.indexOf(p.letter);
      if (idx < 0) return fail('Placed letter is not in the rack.');
      usedIndices.push(idx);
      remaining[idx] = null;
    }
    lastPlay[side] = { rack: play.rack.slice(), usedIndices };
    for (const p of play.placements) board[p.row][p.col] = p.letter;
    scores[side] += res.score;
  }
  if (moveIdx.human !== state.moves.human.length || moveIdx.bot !== state.moves.bot.length) return fail('Recorded moves do not match the play log.');
  for (let r = 0; r < eng.SIZE; r++) {
    for (let c = 0; c < eng.SIZE; c++) {
      if ((board[r][c] || '') !== (state.board[r][c] || '')) return fail('Replayed board does not match the recorded board.');
    }
  }
  if (scores.human !== state.scores.human || scores.bot !== state.scores.bot) return fail('Replayed scores do not match the recorded scores.');
  if (state.reason !== 'By forfeit') {
    const expectedWinner = scores.human > scores.bot ? 'human' : scores.bot > scores.human ? 'bot' : 'draw';
    if (state.winner !== expectedWinner) return fail('Winner does not match the scores.');
  }
  const actual = state.winner === 'human' ? 1 : state.winner === 'bot' ? 0 : 0.5;
  // v199: Fishstick moves nobody's Elo — the submitted delta is
  // ignored (older clients still send the pre-freeze delta) and
  // the endpoint applies 0. Only competitive games are checked
  // against the expected delta.
  if (botType !== 'fishstick') {
    const expectedDelta = eng.eloDelta(playerEloAtStart, botElo, actual);
    if (delta !== expectedDelta) return fail(`eloDelta ${delta} does not match the expected ${expectedDelta}.`);
  }
  return { ok: true };
}
const DEF_PLACEHOLDER = 'a valid word in the Duello word list';
function isRealDef(entry) { return entry && entry.def && entry.def !== DEF_PLACEHOLDER; }
function stemCandidates(w) {
  // Inflected forms are most of the missing definitions: WordNet lists
  // base lemmas, ENABLE lists plurals, past tenses, -ing forms, etc.
  // Stripping a suffix and looking up the base turns ~37k placeholder
  // words into real definitions (dictionary coverage 35% -> ~64%).
  const out = [];
  const push = (c) => { if (c && c.length >= 2 && !out.includes(c)) out.push(c); };
  if (w.endsWith('IES') && w.length > 4) push(w.slice(0, -3) + 'Y');
  if (w.endsWith('ING') && w.length > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'E'); }
  if (w.endsWith('NESS') && w.length > 6) push(w.slice(0, -4));
  if (w.endsWith('MENT') && w.length > 6) push(w.slice(0, -4));
  if (w.endsWith('EST') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('ES') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('ED') && w.length > 4) { push(w.slice(0, -2)); push(w.slice(0, -1)); }
  if (w.endsWith('ER') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('LY') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('D') && w.length > 4) push(w.slice(0, -1));
  if (w.endsWith('S') && w.length > 3) push(w.slice(0, -1));
  // Doubled consonant before -ING/-ED/-ER/-EST: RUNNING -> RUN, STOPPED -> STOP.
  for (const suf of ['ING', 'ED', 'ER', 'EST']) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      const base = w.slice(0, -suf.length);
      if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) push(base.slice(0, -1));
    }
  }
  // Derivational suffixes: -ATION/-TION/-ITY/-OUS/-IVE/-IST/-ISM/-AL/-IC/
  // -ANT/-ENT/-FUL/-LESS/-AGE/-SHIP/-HOOD/-DOM/-IZE/-ISE.
  if (w.endsWith('ATION') && w.length > 6) { push(w.slice(0, -5)); push(w.slice(0, -5) + 'E'); }
  if (w.endsWith('TION') && w.length > 5) { push(w.slice(0, -4)); push(w.slice(0, -4) + 'E'); }
  if (w.endsWith('SION') && w.length > 5) push(w.slice(0, -4));
  if (w.endsWith('ITY') && w.length > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'E'); }
  if (w.endsWith('OUS') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('IVE') && w.length > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'E'); }
  if (w.endsWith('IST') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('ISM') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('AL') && w.length > 5) push(w.slice(0, -2));
  if (w.endsWith('IC') && w.length > 5) push(w.slice(0, -2));
  if (w.endsWith('ANT') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('ENT') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('FUL') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('LESS') && w.length > 6) push(w.slice(0, -4));
  if (w.endsWith('AGE') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('SHIP') && w.length > 6) push(w.slice(0, -4));
  if (w.endsWith('HOOD') && w.length > 6) push(w.slice(0, -4));
  if (w.endsWith('DOM') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('IZE') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('ISE') && w.length > 5) push(w.slice(0, -3));
  return out;
}
// Part of speech for Jeff's 118 two-letter words — same map as
// scripts/build-dictionary.js, applied at runtime so an older
// definitions.json (pos '' for all 118) still shows a part of speech
// in the same "(pos) — definition" format as other words.
const JEFF2_POS = {AA:"noun",AB:"noun",AD:"noun",AE:"noun",AG:"adjective",AH:"interjection",AI:"noun",AL:"noun",AM:"verb",AN:"article",AR:"noun",AS:"adverb",AT:"preposition",AW:"interjection",AX:"noun",AY:"noun",BA:"noun",BE:"verb",BI:"noun",BO:"noun",BY:"noun",DA:"noun",DE:"preposition",DO:"noun",ED:"adjective",EE:"interjection",EF:"noun",EH:"interjection",EL:"noun",EM:"noun",EN:"noun",EO:"noun",ER:"interjection",ES:"noun",ET:"verb",EW:"interjection",EX:"noun",FA:"noun",FE:"noun",FI:"noun",FU:"noun",GI:"noun",GO:"verb",HA:"interjection",HE:"pronoun",HI:"interjection",HM:"interjection",HO:"interjection",ID:"noun",IF:"conjunction",IN:"verb",IO:"noun",IS:"verb",IT:"pronoun",JA:"interjection",JE:"noun",JO:"noun",KA:"noun",KI:"noun",LA:"noun",LI:"noun",LO:"interjection",MA:"noun",ME:"pronoun",MI:"noun",MM:"interjection",MO:"noun",MU:"noun",MY:"pronoun",NA:"adverb",NE:"adjective",NO:"noun",NU:"noun",OD:"noun",OE:"noun",OF:"preposition",OH:"interjection",OI:"interjection",OK:"adjective",OM:"noun",ON:"noun",OO:"noun",OP:"noun",OR:"noun",OS:"noun",OU:"noun",OW:"interjection",OX:"noun",OY:"interjection",PA:"noun",PE:"noun",PI:"noun",PO:"noun",QI:"noun",RE:"noun",SH:"interjection",SI:"noun",SO:"noun",TA:"interjection",TE:"noun",TI:"noun",TO:"preposition",UH:"interjection",UM:"interjection",UN:"noun",UP:"verb",US:"pronoun",UT:"noun",VU:"preposition",WE:"pronoun",WO:"noun",XI:"noun",XU:"noun",YA:"pronoun",YE:"pronoun",YI:"pronoun",YO:"interjection",ZA:"noun"};
// No definition may ever read "plural of X", "past tense of X",
// "form of X — ...", or a Webster "See X" pointer ("See Note under
// Our."): those are replaced with the core word's own definition,
// directly, with no prefix. Jeff, Nov 1, 2026; See-pointers added
// Nov 5, 2026 after OURS showed "See Note under Our." This covers
// stored Webster entries ("form of ABASER — ..."), Wiktionary/dictionary
// glosses ("plural of aal"), and stemmed forms. Jeff's own 2-letter
// glosses (AM/IS: 'form of "to be"') do not match these patterns and
// are left verbatim.
function coreWordFromDef(def) {
  const d = String(def || '').trim();
  let m = d.match(/^form of ([A-Z][A-Z\-]*) — /);
  if (m) return m[1];
  m = d.match(/^(?:plural|past tense|past participle|present participle|third-person singular|comparative|superlative|alternative form|elongated form|variant form) of ([A-Za-z][A-Za-z\-']*)/i);
  if (m) return m[1].toUpperCase();
  // Webster cross-references: "See Note under Our." (OURS) and
  // "See Eke." / "See Have." — the word after See is always a
  // capitalised headword, which is what separates a cross-reference
  // from a real definition that happens to start with "see"
  // ("see with attention", "seed of ...", "seemingly ...").
  // The base word's own definition is used, never the pointer.
  m = d.match(/^[Ss]ee (?:[Nn]ote )?[Uu]nder ([A-Za-z][A-Za-z\-']*)/);
  if (m) return m[1].toUpperCase();
  m = d.match(/^[Ss]ee ([A-Z][A-Za-z\-]*)[.\s]/);
  if (m) return m[1].toUpperCase();
  return null;
}
function isMorphologicalDef(def) { return !!coreWordFromDef(def); }
// Resolve a bundled entry to a real, non-morphological definition:
// follow "form of X — ..." / "plural of x" chains to the core word.
// Returns {pos, definition} or null if the core has no real definition.
function resolvedBundledDef(word, seen) {
  const w = String(word || '').toUpperCase();
  if (seen && seen.has(w)) return null;
  const entry = DEFS[w];
  if (!isRealDef(entry)) return null;
  const src = DEFS_SRC[w] || 'wordnet';
  const core = coreWordFromDef(entry.def);
  if (!core || core === w) return { pos: entry.pos || '', definition: entry.def, src };
  // Webster "form of X — <X's definition>": the core definition is
  // already embedded after the dash, so use it even if X is not a
  // separate bundled entry.
  const dash = entry.def.indexOf(' — ');
  const nextSeen = new Set(seen || []); nextSeen.add(w);
  const coreResolved = resolvedBundledDef(core, nextSeen);
  if (coreResolved) return coreResolved;
  if (dash >= 0) return { pos: entry.pos || '', definition: entry.def.slice(dash + 3), src };
  return null;
}
function bundledDefinition(word) {
  const w = String(word || '').toUpperCase();
  const direct = resolvedBundledDef(w, null);
  if (direct) return { word: w, pos: direct.pos || JEFF2_POS[w] || '', definition: direct.definition, src: direct.src };
  // Stem to a base word and return its core definition directly,
  // with no "form of" prefix.
  const cands = [...stemCandidates(w)];
  for (const c of [...cands]) for (const c2 of stemCandidates(c)) if (!cands.includes(c2)) cands.push(c2);
  for (const base of cands) {
    const resolved = resolvedBundledDef(base, null);
    if (resolved) return { word: w, pos: resolved.pos || '', definition: resolved.definition, src: resolved.src };
  }
  return null;
}
// Live fallback for words the bundled WordNet set does not cover
// (bundled coverage is ~64% of the word list even with stemming; the
// rest are mostly ENABLE-only words, plus common 3-letter words WordNet
// simply does not list, like AND or APP). A free dictionary API is
// tried with a short timeout and cached in memory; on any failure the
// bundled fallback below is returned, so a slow or down API can never
// break the definition popover. Only the queried game word is sent.
const DEF_CACHE = new Map();
function stripHtml(t) { return String(t || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(); }
async function fetchWithTimeout(url, ms, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal, headers }); return r; }
  catch { return null; } finally { clearTimeout(timer); }
}
async function fetchDictApi(wordLower) {
  try {
    const r = await fetchWithTimeout('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(wordLower), 1500);
    if (!r || !r.ok) return null;
    const arr = await r.json();
    const meanings = Array.isArray(arr) && arr[0] && arr[0].meanings;
    if (!meanings) return null;
    // Meanings come back most-common first, but the first meaning's
    // first gloss can be circular ("To run." for RUN) or a chopped
    // long sentence, so scan for the first gloss that is a real,
    // whole definition. Fall back to the first gloss seen, so a word
    // whose only gloss is morphological still resolves through
    // resolveLiveMorph below.
    let first = null;
    for (const meaning of meanings) {
      const defs = (meaning && meaning.definitions) || [];
      for (const d of defs) {
        if (!d || !d.definition) continue;
        if (!first) first = { pos: meaning.partOfSpeech || '', definition: d.definition };
        if (!isMorphologicalDef(d.definition) && !isCircularDef(d.definition, wordLower) && !isCutDef(d.definition)) {
          return { pos: meaning.partOfSpeech || '', definition: d.definition };
        }
      }
    }
    return first;
  } catch { return null; }
}
async function fetchWiktionary(wordLower) {
  // Wiktionary covers many ENABLE-only words WordNet and dictionaryapi
  // miss (ABOIL, AAL, and other Scrabble words are Wiktionary entries).
  try {
    const r = await fetchWithTimeout('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(wordLower), 2000, { 'User-Agent': 'Duello/1.0 (definition lookup)', 'Accept': 'application/json' });
    if (!r || !r.ok) return null;
    const data = await r.json();
    const entries = (data && data.en) || [];
    for (const e of entries) {
      const defs = (e.definitions || []).map(x => x && x.definition).filter(Boolean).map(stripHtml).filter(Boolean);
      // First gloss that fits whole and says something real; else the
      // entry's first gloss (morphological ones still resolve).
      for (const clean of defs) {
        if (!isMorphologicalDef(clean) && !isCircularDef(clean, wordLower) && !isCutDef(clean)) return { pos: e.partOfSpeech || '', definition: clean };
      }
      if (defs[0]) return { pos: e.partOfSpeech || '', definition: defs[0] };
    }
    return null;
  } catch { return null; }
}
// A definition that only restates the word ("To run." for RUN) is no
// definition at all: strip stopwords and the headword itself (with
// its usual inflections), and call it circular when nothing is left.
const DEF_STOPWORDS = new Set(['to', 'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'by', 'as', 'at', 'be', 'is', 'are', 'was', 'were', 'it', 'its', 'this', 'that', 'one']);
function stemToken(t) {
  let s = String(t || '').toLowerCase();
  for (const suf of ['ing', 'ed', 'es', 's']) if (s.length > suf.length + 1 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  // Doubled consonant from -ing/-ed: running -> runn -> run.
  if (s.length >= 3 && s[s.length - 1] === s[s.length - 2]) s = s.slice(0, -1);
  return s;
}
function isCircularDef(def, wordLower) {
  const toks = String(def || '').toLowerCase().match(/[a-z]+/g) || [];
  const rest = toks.filter(t => !DEF_STOPWORDS.has(t) && stemToken(t) !== stemToken(wordLower));
  return rest.length === 0;
}
// True when shortenDefinition would chop the gloss (first sentence
// over 140 chars): the live chain prefers a whole sense over one.
function isCutDef(def) { return shortenDefinition(def).endsWith('…'); }
// Both live sources are fetched in parallel; when both land, a whole
// (uncut) sense beats a chopped one, else dictionaryapi.dev wins.
function pickLiveCandidate(a, b) {
  if (a && b && isCutDef(a.definition) && !isCutDef(b.definition)) return b;
  return a || b;
}
async function fetchLiveRaw(wordLower) {
  // dictionaryapi.dev is the preferred source: if it lands a whole
  // definition, use it at once instead of waiting on Wiktionary.
  // Only when its best sense is chopped (or it misses) is the
  // Wiktionary result awaited, so a whole sense there can win.
  const bP = fetchWiktionary(wordLower);
  bP.catch(() => {});
  let a = null;
  try { a = await fetchDictApi(wordLower); } catch {}
  if (a && !isCutDef(a.definition)) return a;
  let b = null;
  try { b = await bP; } catch {}
  return pickLiveCandidate(a, b);
}
// Resolve a live definition that is only a morphological reference
// ("plural of aal", "past tense of ...") to the core word's own
// definition, directly. Bundled core first, then a live fetch for the
// core word, recursing at most 3 levels (e.g. plural -> alternative
// form -> core). Returns null if no core definition lands.
async function resolveLiveMorph(live, depth) {
  if (!live || !isMorphologicalDef(live.definition)) return live;
  if (depth >= 3) return null;
  const core = coreWordFromDef(live.definition);
  if (!core) return null;
  const bundledCore = bundledDefinition(core);
  // A curated core is final (v118): use it at once. A pre-curated
  // core may be a rare sense, so try the live core first and keep the
  // bundled one only as a fallback.
  if (bundledCore && (bundledCore.src === 'wiktionary' || bundledCore.src === 'curated')) return { pos: bundledCore.pos || '', definition: bundledCore.definition };
  try {
    const coreLive = await fetchLiveRaw(core.toLowerCase());
    if (coreLive) return await resolveLiveMorph(coreLive, depth + 1);
  } catch {}
  if (bundledCore) return { pos: bundledCore.pos || '', definition: bundledCore.definition };
  return null;
}
// Definitions stay short: one sentence only. A longer gloss is cut
// to its first sentence (the core sense), and a first sentence that
// still runs long is cut to its first complete clause under the cap
// (140 chars — the longest bundled definition). Abbreviations
// (e.g., i.e.) never end a sentence, and a gloss with no terminal
// punctuation is already a single short phrase, so it is kept whole.
const DEF_MAX_LEN = 140;
function shortenDefinition(def) {
  let d = String(def || '').trim();
  if (!d) return d;
  // First sentence: the first . ! ? followed by whitespace + a capital
  // (or the end of the string). "e.g." / "i.e." / "etc." are followed
  // by lowercase, so they never split.
  const end = d.search(/[.!?](?=\s+[A-Z]|$)/);
  if (end >= 0) d = d.slice(0, end + 1).trim();
  if (d.length <= DEF_MAX_LEN) return d;
  // Cut to the last clause boundary (semicolon, comma, dash) inside
  // the cap; otherwise the last word boundary inside the cap.
  const cut = d.slice(0, DEF_MAX_LEN);
  const boundary = Math.max(cut.lastIndexOf(';'), cut.lastIndexOf(','), cut.lastIndexOf(' — '));
  let out;
  if (boundary > 40) out = cut.slice(0, boundary).trim();
  else { const space = cut.lastIndexOf(' '); out = (space > 40 ? cut.slice(0, space) : cut).trim(); }
  // A cut is marked, so it reads as shortened on purpose instead of
  // breaking off mid-thought. The ellipsis counts inside the cap.
  if (out.length >= DEF_MAX_LEN) out = out.slice(0, DEF_MAX_LEN - 1).trim();
  return out + '…';
}
async function getDefinition(word) {
  const w = String(word || '').toUpperCase();
  const bundled = bundledDefinition(w);
  // A curated entry is final (v118): it is the shortest, most-common
  // sense, picked at build time from every source, and already short
  // (hard cap 150 chars). No live fetch overrides it — the live chain
  // below runs only for words with no curated entry. The src marker
  // stays server-side: the response is still just {word, pos, definition}.
  if (bundled) return { word: w, pos: bundled.pos || '', definition: bundled.definition };
  if (DEF_CACHE.has(w)) return DEF_CACHE.get(w);
  let live = await fetchLiveRaw(w.toLowerCase());
  if (live) live = await resolveLiveMorph(live, 0);
  if (live) {
    const out = { word: w, pos: live.pos || '', definition: shortenDefinition(live.definition) };
    DEF_CACHE.set(w, out);
    return out;
  }
  // Stemmed forms through Wiktionary: plurals / inflections that are
  // not themselves Wiktionary headwords (e.g. ABOILS -> ABOIL).
  // Return the core definition directly, with no "form of" prefix.
  if (!live) {
    const cands = [...stemCandidates(w)];
    for (const c of [...cands]) for (const c2 of stemCandidates(c)) if (!cands.includes(c2)) cands.push(c2);
    for (const base of cands.slice(0, 5)) {
      const baseLive = await fetchWiktionary(base.toLowerCase());
      if (baseLive) { live = await resolveLiveMorph(baseLive, 0); if (live) break; }
    }
  }
  if (live) {
    const out = { word: w, pos: live.pos || '', definition: shortenDefinition(live.definition) };
    DEF_CACHE.set(w, out);
    return out;
  }
  // Last resort, not a dead end: every word in the list is a valid
  // Duello word, so say so rather than leaving the popover empty. In
  // practice the bundled + live chain above covers the published
  // glosses; this is for letter combinations with no published gloss.
  const fallback = { word: w, pos: '', definition: 'A valid Duello word.' };
  DEF_CACHE.set(w, fallback);
  return fallback;
}

// ---------- HTTP API ----------
// CORS for the iOS shell: the TestFlight app is served from
// capacitor://localhost, so its API calls are cross-origin and the
// browser would block them without these headers. Auth is a Bearer
// token (no cookies), so a wildcard origin is safe here.
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...CORS_HEADERS });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
// v187: raw bytes (the share-card PNG upload) — readBody above is
// JSON-only, so binary bodies need their own reader. Caps at 3MB.
function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => { chunks.push(chunk); size += chunk.length; if (size > 3e6) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}
async function loadGameForUser(user, id) {
  // Either player of a real game can load it: the challenger by
  // user_id, the recipient by opponent_id. Bot games only ever
  // match the owner.
  const r = await q('SELECT * FROM games WHERE id=$1 AND (user_id=$2 OR opponent_id=$2)', [id, user.id]);
  return r.rows[0] ? loadGameRow(r.rows[0]) : null;
}

// ---------- Background persona simulation (v171) ----------
// Personas are fake players, so their Elos would sit still unless a
// real user plays them. A small unref'd timer simulates
// persona-vs-persona games in the background: 2 games every 2
// minutes, K=32 zero-sum with the standard Elo expected score, so
// Elos drift the way real play would move them. No game rows are
// written — only the personas table's elo column moves — and there is
// no ceiling: Elos drift up without bound and are floored at 0.
// PERSONA_SIM=off disables it (the harness sets this, and
// the timer only starts after initDb succeeds and the server is
// listening, so a failed Postgres connection never starts it).
const PERSONA_SIM_MIN_ELO = 0;
const PERSONA_SIM_EVERY_MS = 2 * 60 * 1000;
const PERSONA_SIM_GAMES_PER_TICK = 2;
function clampPersonaElo(elo) { return Math.max(0, Math.round(elo)); }
// Pure: one simulated game between two Elos. The winner is drawn
// from the standard Elo expected score (the higher Elo is favoured,
// never certain); the delta is K=32 zero-sum, exactly like a human
// game (engine eloDelta), then floored at 0 (no ceiling).
function simulatePersonaGame(aElo, bElo, rand) {
  const expectedA = 1 / (1 + Math.pow(10, (bElo - aElo) / 400));
  const aWins = rand() < expectedA;
  const dA = eloDelta(aElo, bElo, aWins ? 1 : 0);
  return { winner: aWins ? 'a' : 'b', aElo: clampPersonaElo(aElo + dA), bElo: clampPersonaElo(bElo - dA) };
}
// Pure: pick a pair — a random persona, then a partner within the
// ±40 matchmaking window when one exists, else any other persona.
function pickSimPair(personas, rand) {
  if (!personas || personas.length < 2) return null;
  const a = personas[Math.floor(rand() * personas.length)];
  const near = personas.filter(p => p.id !== a.id && Math.abs(p.elo - a.elo) <= 40);
  const pool = near.length ? near : personas.filter(p => p.id !== a.id);
  return [a, pool[Math.floor(rand() * pool.length)]];
}
let personaSimRunning = false;
async function runPersonaSimTick() {
  if (personaSimRunning) return 0;
  personaSimRunning = true;
  try {
    const r = await q('SELECT id, elo FROM personas');
    const personas = r.rows || [];
    let played = 0;
    for (let i = 0; i < PERSONA_SIM_GAMES_PER_TICK; i++) {
      const pair = pickSimPair(personas, Math.random);
      if (!pair) break;
      const [a, b] = pair;
      const res = simulatePersonaGame(a.elo, b.elo, Math.random);
      await q('UPDATE personas SET elo=$1 WHERE id=$2', [res.aElo, a.id]);
      await q('UPDATE personas SET elo=$1 WHERE id=$2', [res.bElo, b.id]);
      // Keep the in-memory copy in step so a second game in the
      // same tick sees the updated Elos.
      a.elo = res.aElo; b.elo = res.bElo;
      played++;
    }
    return played;
  } catch (e) {
    console.error('Persona sim tick failed:', e.message);
    return 0;
  } finally {
    personaSimRunning = false;
  }
}
function startPersonaSim() {
  if (process.env.PERSONA_SIM === 'off') return false;
  const t = setInterval(() => { runPersonaSimTick(); }, PERSONA_SIM_EVERY_MS);
  if (t.unref) t.unref();
  return t;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    // CORS for the iOS shell: the TestFlight app is served from
    // capacitor://localhost, so its API calls are cross-origin and the
    // browser would block them without these headers. Auth is a Bearer
    // token (no cookies), so a wildcard origin is safe here. The
    // preflight (OPTIONS) answers with the same headers.
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }
    // Static files
    // v142: /daily-puzzles.json is served here too — the client fetches the
    // daily puzzle data from it, and the service worker caches it for
    // offline play. Without this the whitelist 404s it and the puzzle
    // never loads.
    if (req.method === 'GET' && (pathname === '/' || pathname === '/privacy.html' || pathname === '/.well-known/apple-app-site-association' || pathname.startsWith('/app.js') || pathname.startsWith('/engine.js') || pathname.startsWith('/sw.js') || pathname.startsWith('/words.txt') || pathname.startsWith('/style.css') || pathname.startsWith('/favicon') || pathname.startsWith('/definitions/') || pathname.startsWith('/assets/') || pathname.startsWith('/daily-puzzles.json'))) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      const safe = path.join(ROOT, 'public', file);
      if (!safe.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(safe)) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(safe);
      // v185: the AASA file has no extension (the MIME map would call
      // it text/html) and Apple requires application/json.
      const type = pathname === '/.well-known/apple-app-site-association' ? 'application/json' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.txt' ? 'text/plain' : ext === '.json' ? 'application/json' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'text/html';
      // v186/v187: share-link previews (the title INSIDE the card,
      // not the message text above it). A ?puzzle= link previews as
      // "Daily Puzzle"; a ?friend=<user> link previews as
      // "Add friend - @<handle>" with that user's share-card image;
      // a ?challenge= link previews as "Play Duello" with the app
      // icon. The handle is safe to interpolate as-is: usernames
      // are lowercase alphanumerics + underscore by validation.
      // Only the og meta changes — the <title> (browser tab) stays
      // "Duello", and a plain / is served unchanged. The service
      // worker keys by full URL, so each variant is its own cache
      // entry and the replace is never defeated by a cached /.
      if (pathname === '/') {
        let html = null;
        if (url.searchParams.has('friend')) {
          const fu = await getUserByUsername(String(url.searchParams.get('friend') || '').trim().toLowerCase());
          if (fu) {
            html = fs.readFileSync(safe, 'utf8')
              .replace('<meta property="og:title" content="Duello">', '<meta property="og:title" content="Add friend - @' + fu.username + '">')
              .replace('<meta property="og:image" content="/assets/app-icon.png">', '<meta property="og:image" content="/api/share-card/' + fu.username + '.png">');
          }
        } else if (url.searchParams.has('challenge')) {
          html = fs.readFileSync(safe, 'utf8').replace('<meta property="og:title" content="Duello">', '<meta property="og:title" content="Play Duello">');
        } else if (url.searchParams.has('invite')) {
          // v190: an invite link previews as "Sign Up" (the card
          // title Jeff chose) with the app icon — the message text
          // above the card still says "Join Duello!".
          html = fs.readFileSync(safe, 'utf8').replace('<meta property="og:title" content="Duello">', '<meta property="og:title" content="Sign Up">');
        } else if (url.searchParams.has('puzzle')) {
          html = fs.readFileSync(safe, 'utf8').replace('<meta property="og:title" content="Duello">', '<meta property="og:title" content="Daily Puzzle">');
        }
        if (html) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
      }
      res.writeHead(200, { 'Content-Type': type });
      return fs.createReadStream(safe).pipe(res);
    }
    if (pathname === '/api/words' && req.method === 'GET') {
      // Word list for the client's instant local pre-check (the verdict
      // shown while placing tiles). The server still validates every
      // submitted play authoritatively; this only feeds the pre-check.
      const wordsFile = path.join(DATA_DIR, 'words.txt');
      const st = fs.statSync(wordsFile);
      const etag = '"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'ETag': etag, 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(wordsFile).pipe(res);
    }
    if (pathname === '/api/auth/request-code' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email.' });
      const byEmail = await getUserByEmail(email);
      if (byEmail) return sendJson(res, 400, { error: 'That email is already registered. Sign in instead.' });
      const existing = (await q('SELECT * FROM verification_codes WHERE email=$1', [email])).rows[0];
      if (existing && existing.requested_at && Date.now() - new Date(existing.requested_at).getTime() < CODE_COOLDOWN_MS) {
        return sendJson(res, 400, { error: 'A code was just sent. Wait a minute before requesting another.' });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(code, salt);
      const expires = new Date(Date.now() + CODE_TTL_MS);
      await q('INSERT INTO verification_codes (email, code_salt, code_hash, attempts, expires_at, requested_at, verified_token, verified_expires_at) VALUES ($1,$2,$3,0,$4,now(),NULL,NULL) ON CONFLICT (email) DO UPDATE SET code_salt=$2, code_hash=$3, attempts=0, expires_at=$4, requested_at=now(), verified_token=NULL, verified_expires_at=NULL', [email, salt, hash, expires]);
      try {
        await sendResendEmail(email, 'Your Duello verification code', 'Your Duello verification code is ' + code + '. It expires in 10 minutes.');
      } catch (e) {
        await q('DELETE FROM verification_codes WHERE email=$1', [email]);
        return sendJson(res, 503, { error: 'Could not send the code. Try again.' });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/verify-code' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const code = String(b.code || '').trim();
      const row = (await q('SELECT * FROM verification_codes WHERE email=$1', [email])).rows[0];
      if (!row || !row.code_hash) return sendJson(res, 400, { error: 'No code was requested for this email.' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await q('DELETE FROM verification_codes WHERE email=$1', [email]);
        return sendJson(res, 400, { error: 'That code expired. Request a new one.' });
      }
      if (row.attempts >= CODE_MAX_ATTEMPTS) {
        await q('DELETE FROM verification_codes WHERE email=$1', [email]);
        return sendJson(res, 400, { error: 'Too many wrong tries. Request a new code.' });
      }
      if (hashPassword(code, row.code_salt) !== row.code_hash) {
        await q('UPDATE verification_codes SET attempts=attempts+1 WHERE email=$1', [email]);
        return sendJson(res, 400, { error: 'That code is not right.' });
      }
      const verifiedToken = crypto.randomBytes(32).toString('hex');
      await q('UPDATE verification_codes SET code_salt=NULL, code_hash=NULL, attempts=0, verified_token=$2, verified_expires_at=$3 WHERE email=$1', [email, verifiedToken, new Date(Date.now() + VERIFIED_TTL_MS)]);
      return sendJson(res, 200, { verifiedToken });
    }
    // Password reset. Responses never reveal whether an address has an
    // account: the request endpoint always reports success for a
    // well-formed email, and every verify failure uses the same message.
    if (pathname === '/api/auth/request-reset' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email.' });
      const user = await getUserByEmail(email);
      if (!user) return sendJson(res, 200, { ok: true });
      const existing = (await q('SELECT * FROM password_reset_codes WHERE email=$1', [email])).rows[0];
      if (existing && existing.requested_at && Date.now() - new Date(existing.requested_at).getTime() < CODE_COOLDOWN_MS) {
        return sendJson(res, 200, { ok: true });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(code, salt);
      const expires = new Date(Date.now() + CODE_TTL_MS);
      await q('INSERT INTO password_reset_codes (email, code_salt, code_hash, attempts, expires_at, requested_at, verified_token, verified_expires_at) VALUES ($1,$2,$3,0,$4,now(),NULL,NULL) ON CONFLICT (email) DO UPDATE SET code_salt=$2, code_hash=$3, attempts=0, expires_at=$4, requested_at=now(), verified_token=NULL, verified_expires_at=NULL', [email, salt, hash, expires]);
      try {
        await sendResendEmail(email, 'Your Duello password reset code', 'Your Duello password reset code is ' + code + '. It expires in 10 minutes.');
      } catch (e) {
        // Return the generic success even on a send failure: a 503 here
        // would reveal that the address has an account. The failure is
        // logged server-side; the user can request a new code.
        console.error('password reset send failed for', email, e.message);
        await q('DELETE FROM password_reset_codes WHERE email=$1', [email]);
      }
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/verify-reset-code' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const code = String(b.code || '').trim();
      const row = (await q('SELECT * FROM password_reset_codes WHERE email=$1', [email])).rows[0];
      // Every failure reads the same: a distinct message for a missing,
      // expired, or exhausted row would reveal that a code was requested,
      // which would reveal that the address has an account.
      if (!row || !row.code_hash) return sendJson(res, 400, { error: 'That code is not right.' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await q('DELETE FROM password_reset_codes WHERE email=$1', [email]);
        return sendJson(res, 400, { error: 'That code is not right.' });
      }
      if (row.attempts >= CODE_MAX_ATTEMPTS) {
        await q('DELETE FROM password_reset_codes WHERE email=$1', [email]);
        return sendJson(res, 400, { error: 'That code is not right.' });
      }
      if (hashPassword(code, row.code_salt) !== row.code_hash) {
        await q('UPDATE password_reset_codes SET attempts=attempts+1 WHERE email=$1', [email]);
        return sendJson(res, 400, { error: 'That code is not right.' });
      }
      const verifiedToken = crypto.randomBytes(32).toString('hex');
      await q('UPDATE password_reset_codes SET code_salt=NULL, code_hash=NULL, attempts=0, verified_token=$2, verified_expires_at=$3 WHERE email=$1', [email, verifiedToken, new Date(Date.now() + VERIFIED_TTL_MS)]);
      return sendJson(res, 200, { verifiedToken });
    }
    if (pathname === '/api/auth/reset-password' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!passwordPolicyOk(password)) return sendJson(res, 400, { error: PASSWORD_POLICY_ERROR });
      const verifiedToken = String(b.verifiedToken || '');
      const vrow = (await q('SELECT * FROM password_reset_codes WHERE email=$1', [email])).rows[0];
      if (!verifiedToken || !vrow || vrow.verified_token !== verifiedToken || !vrow.verified_expires_at || new Date(vrow.verified_expires_at).getTime() < Date.now()) {
        return sendJson(res, 400, { error: 'That reset is no longer valid. Request a new code.' });
      }
      const user = await getUserByEmail(email);
      if (!user) return sendJson(res, 400, { error: 'That reset is no longer valid. Request a new code.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      await q('UPDATE users SET password_salt=$2, password_hash=$3 WHERE id=$1', [user.id, salt, hash]);
      // Single use, and every session is ended: a reset is a credential
      // change, so all devices sign in again with the new password.
      await q('DELETE FROM password_reset_codes WHERE email=$1', [email]);
      await q('DELETE FROM sessions WHERE user_id=$1', [user.id]);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/signup' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const username = String(b.username || '').trim().toLowerCase();
      const firstName = String(b.firstName || '').trim();
      const lastName = String(b.lastName || '').trim();
      const password = String(b.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email.' });
      if (!/^[a-z0-9_]{3,}$/.test(username)) return sendJson(res, 400, { error: 'Username: lowercase letters, numbers, and underscores only, at least 3 characters.' });
      if (RESERVED_USERNAMES.has(username)) return sendJson(res, 400, { error: 'That username is taken.' });
      if (!firstName || !lastName) return sendJson(res, 400, { error: 'First and last name are required.' });
      if (!passwordPolicyOk(password)) return sendJson(res, 400, { error: PASSWORD_POLICY_ERROR });
      // Signup requires a verified email: the verified token from
      // /api/auth/verify-code, single use, 30-minute expiry.
      const verifiedToken = String(b.verifiedToken || '');
      const vrow = (await q('SELECT * FROM verification_codes WHERE email=$1', [email])).rows[0];
      if (!verifiedToken || !vrow || vrow.verified_token !== verifiedToken || !vrow.verified_expires_at || new Date(vrow.verified_expires_at).getTime() < Date.now()) {
        return sendJson(res, 400, { error: 'Verify your email with a code first.' });
      }
      const current = await authUser(req);
      if (current) return sendJson(res, 400, { error: 'You are already signed in.' });
      const byEmail = await getUserByEmail(email);
      if (byEmail) return sendJson(res, 400, { error: 'That email is already registered.' });
      const byUsername = await getUserByUsername(username);
      if (byUsername) return sendJson(res, 400, { error: 'That username is taken.' });
      // Personas hold usernames too: a new account must not collide
      // with a Global name, or the leaderboard could show two people
      // under one name.
      const personaTaken = await q('SELECT 1 FROM personas WHERE username=$1', [username]);
      if (personaTaken.rows.length) return sendJson(res, 400, { error: 'That username is taken.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      // Signup always creates a brand-new account at 1000. Guest tokens
      // are ignored: a guest signing up gets a fresh account, and the
      // guest row is left orphaned and inert.
      const r = await q('INSERT INTO users (email, username, first_name, last_name, password_salt, password_hash, elo, elo_high) VALUES ($1,$2,$3,$4,$5,$6,1000,1000) RETURNING id', [email, username, firstName, lastName, salt, hash]);
      const user = await getUserById(r.rows[0].id);
      const token = crypto.randomBytes(32).toString('hex');
      await q('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, user.id]);
      // The verified token is single use: the code is spent.
      await q('DELETE FROM verification_codes WHERE email=$1', [email]);
      return sendJson(res, 200, { token, user: publicUser(user) });
    }
    if (pathname === '/api/signin' && req.method === 'POST') {
      const b = await readBody(req);
      const user = await getUserByEmail(String(b.email || '').trim().toLowerCase());
      if (!user) return sendJson(res, 401, { error: 'Invalid email or password.' });
      const hash = hashPassword(String(b.password || ''), user.password_salt);
      if (hash !== user.password_hash) return sendJson(res, 401, { error: 'Invalid email or password.' });
      const token = crypto.randomBytes(32).toString('hex');
      await q('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, user.id]);
      return sendJson(res, 200, { token, user: publicUser(user) });
    }
    if (pathname === '/api/signout' && req.method === 'POST') {
      const h = req.headers.authorization || '';
      const m = h.match(/^Bearer\s+(.+)$/);
      if (m) await q('DELETE FROM sessions WHERE token=$1', [m[1]]);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const hist = await q('SELECT elo_after, created_at FROM elo_history WHERE user_id=$1 ORDER BY id', [user.id]);
      return sendJson(res, 200, { user: publicUser(user), stats: { eloHistory: hist.rows }, profileStats: await profileStatsFor(user.id) });
    }
    // ---------- Push notifications (v120) ----------
    // The Settings toggle writes the preference; the device token is
    // registered by the iOS app after the user grants permission.
    // Web has no push: the toggle is hidden outside the Capacitor
    // shell, so these endpoints only ever see iOS tokens.
    if (pathname === '/api/push/preference' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const enabled = !!b.enabled;
      await q('UPDATE users SET push_enabled=$1 WHERE id=$2', [enabled, user.id]);
      return sendJson(res, 200, { ok: true, pushEnabled: enabled });
    }
    if (pathname === '/api/push/token' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const token = String(b.token || '').trim();
      if (!token || token.length > 256) return sendJson(res, 400, { error: 'A device token is required.' });
      const platform = String(b.platform || 'ios').trim().toLowerCase() === 'web' ? 'web' : 'ios';
      await q(`INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,$3)
        ON CONFLICT (user_id, token) DO UPDATE SET platform=EXCLUDED.platform, updated_at=now()`, [user.id, token, platform]);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/push/token/delete' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const token = String(b.token || '').trim();
      if (token) await q('DELETE FROM push_tokens WHERE user_id=$1 AND token=$2', [user.id, token]);
      else await q('DELETE FROM push_tokens WHERE user_id=$1', [user.id]);
      return sendJson(res, 200, { ok: true });
    }
    // v180: push-registration diagnostics. The client posts its
    // pushDiag snapshot after every step of the token-registration
    // flow, so a device that never registers a token (Nov 23:
    // @neo on build 105, challenges 13-17 all 'no-token') is
    // diagnosable from the server log without the phone in hand.
    // Authenticated like /api/push/token; any JSON object (or
    // garbage — readBody already resolves {} on bad JSON) is
    // accepted and logged; never throws, never breaks other calls.
    if (pathname === '/api/push/diag' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const diag = (b && typeof b === 'object' && !Array.isArray(b)) ? b : {};
      console.log('Push diag ' + user.username + ': ' + JSON.stringify(diag));
      return sendJson(res, 200, { ok: true });
    }
    // Email-change verification (v199): the profile update used to
    // swap the email instantly when well-formed and untaken, so a
    // typo locked the account. Now a new address needs a 6-digit
    // code sent to THAT address first (same 10-minute code /
    // 5-attempt / 1-minute-cooldown shape as the signup, reset, and
    // delete codes, reusing the verification_codes table), and the
    // swap itself needs the verified token the code produces.
    // The taken check runs here too, before any code is sent.
    if (pathname === '/api/me/email-change/request-code' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const newEmail = String(b.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return sendJson(res, 400, { error: 'Enter a valid email.' });
      if (newEmail === user.email) return sendJson(res, 400, { error: 'That is already your email.' });
      const byEmail = await getUserByEmail(newEmail);
      if (byEmail && byEmail.id !== user.id) return sendJson(res, 400, { error: 'That email is already registered.' });
      const existing = (await q('SELECT * FROM verification_codes WHERE email=$1', [newEmail])).rows[0];
      if (existing && existing.requested_at && Date.now() - new Date(existing.requested_at).getTime() < CODE_COOLDOWN_MS) {
        return sendJson(res, 400, { error: 'A code was just sent. Wait a minute before requesting another.' });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(code, salt);
      const expires = new Date(Date.now() + CODE_TTL_MS);
      await q('INSERT INTO verification_codes (email, code_salt, code_hash, attempts, expires_at, requested_at, verified_token, verified_expires_at) VALUES ($1,$2,$3,0,$4,now(),NULL,NULL) ON CONFLICT (email) DO UPDATE SET code_salt=$2, code_hash=$3, attempts=0, expires_at=$4, requested_at=now(), verified_token=NULL, verified_expires_at=NULL', [newEmail, salt, hash, expires]);
      try {
        await sendResendEmail(newEmail, 'Your Duello email change code', 'Your Duello email change code is ' + code + '. It expires in 10 minutes.');
      } catch (e) {
        await q('DELETE FROM verification_codes WHERE email=$1', [newEmail]);
        return sendJson(res, 503, { error: 'Could not send the code. Try again.' });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/me/email-change/verify-code' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const newEmail = String(b.email || '').trim().toLowerCase();
      const code = String(b.code || '').trim();
      const row = (await q('SELECT * FROM verification_codes WHERE email=$1', [newEmail])).rows[0];
      if (!row || !row.code_hash) return sendJson(res, 400, { error: 'No code was requested for this email.' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await q('DELETE FROM verification_codes WHERE email=$1', [newEmail]);
        return sendJson(res, 400, { error: 'That code expired. Request a new one.' });
      }
      if (row.attempts >= CODE_MAX_ATTEMPTS) {
        await q('DELETE FROM verification_codes WHERE email=$1', [newEmail]);
        return sendJson(res, 400, { error: 'Too many wrong tries. Request a new code.' });
      }
      if (hashPassword(code, row.code_salt) !== row.code_hash) {
        await q('UPDATE verification_codes SET attempts=attempts+1 WHERE email=$1', [newEmail]);
        return sendJson(res, 400, { error: 'That code is not right.' });
      }
      const verifiedToken = crypto.randomBytes(32).toString('hex');
      await q('UPDATE verification_codes SET code_salt=NULL, code_hash=NULL, attempts=0, verified_token=$2, verified_expires_at=$3 WHERE email=$1', [newEmail, verifiedToken, new Date(Date.now() + VERIFIED_TTL_MS)]);
      return sendJson(res, 200, { verifiedToken });
    }
    if (pathname === '/api/me/update' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const firstName = String(b.firstName || '').trim();
      const lastName = String(b.lastName || '').trim();
      const username = String(b.username || '').trim().toLowerCase();
      if (!firstName) return sendJson(res, 400, { error: 'Add a first name.' });
      if (!/^[a-z0-9_]{3,}$/.test(username)) return sendJson(res, 400, { error: 'Username: lowercase letters, numbers, and underscores only, at least 3 characters.' });
      if (RESERVED_USERNAMES.has(username)) return sendJson(res, 400, { error: 'That username is taken.' });
      const byUsername = await getUserByUsername(username);
      if (byUsername && byUsername.id !== user.id) return sendJson(res, 400, { error: 'That username is taken.' });
      const personaTaken = await q('SELECT 1 FROM personas WHERE username=$1', [username]);
      if (personaTaken.rows.length) return sendJson(res, 400, { error: 'That username is taken.' });
      // email is optional: absent (or blank) means unchanged. A new
      // address must be well-formed and not taken by another account.
      const hasEmail = Object.prototype.hasOwnProperty.call(b, 'email') && String(b.email || '').trim() !== '';
      let newEmail = null;
      if (hasEmail) {
        newEmail = String(b.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return sendJson(res, 400, { error: 'Enter a valid email.' });
        if (newEmail === user.email) newEmail = null;
        else {
          const byEmail = await getUserByEmail(newEmail);
          if (byEmail && byEmail.id !== user.id) return sendJson(res, 400, { error: 'That email is already registered.' });
          // v199: a changed email needs the verified token from the
          // emailed code (POST /api/me/email-change/verify-code).
          // Without it, or with an expired one, the address does
          // not change — a typo can never lock the account.
          const verifiedToken = String(b.verifiedToken || '');
          const vrow = (await q('SELECT * FROM verification_codes WHERE email=$1', [newEmail])).rows[0];
          if (!verifiedToken || !vrow || vrow.verified_token !== verifiedToken || !vrow.verified_expires_at || new Date(vrow.verified_expires_at).getTime() < Date.now()) {
            return sendJson(res, 400, { error: 'Verify the new email first. Request a code.' });
          }
        }
      }
      // photoData is optional: absent means unchanged, null clears the
      // photo, a data URL sets it. The request body itself is capped at
      // 1MB by readBody, so the photo cap sits below that.
      const hasPhoto = Object.prototype.hasOwnProperty.call(b, 'photoData');
      if (hasPhoto && b.photoData !== null) {
        const photoData = String(b.photoData);
        if (!photoData.startsWith('data:image/') || photoData.length > 750000) {
          return sendJson(res, 400, { error: 'That photo is not a supported image or is too large.' });
        }
      }
      const sets = ['first_name=$1', 'last_name=$2', 'username=$3'];
      const params = [firstName, lastName, username];
      if (hasPhoto && b.photoData !== null) { params.push(String(b.photoData)); sets.push(`photo_data=$${params.length}`); }
      else if (hasPhoto) { sets.push('photo_data=NULL'); }
      if (newEmail) { params.push(newEmail); sets.push(`email=$${params.length}`); }
      params.push(user.id);
      // v199: capture the old address BEFORE the UPDATE — the
      // change notice below must go to it, and the user object may
      // already carry the new address by then (a live row reference
      // in some runtimes, and the harness FakePool mutates it).
      const oldEmail = newEmail ? user.email : null;
      await q(`UPDATE users SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
      if (newEmail) {
        // Single-use token, and the old address is told the email
        // changed. The notice is best-effort: the swap already
        // happened, so a send failure is logged, never surfaced.
        await q('DELETE FROM verification_codes WHERE email=$1', [newEmail]);
        try {
          await sendResendEmail(oldEmail, 'Your Duello email was changed', 'Your Duello account email was changed to ' + newEmail + '. If you did not make this change, contact support.');
        } catch (e) { console.error('email-change notice failed for', oldEmail, e.message); }
      }
      const updated = await getUserById(user.id);
      return sendJson(res, 200, { user: publicUser(updated) });
    }
    // Duello Pro tier (v147): switch between the Free version and
    // Duello Pro. No payment is wired up — the tier is a plain account
    // flag the settings screen flips (an App Store purchase would
    // replace this call when Jeff wants one).
    if (pathname === '/api/me/pro' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      if (typeof b.pro !== 'boolean') return sendJson(res, 400, { error: 'Pick a plan.' });
      await q('UPDATE users SET pro=$2 WHERE id=$1', [user.id, b.pro]);
      const updated = await getUserById(user.id);
      return sendJson(res, 200, { user: publicUser(updated) });
    }
    if (pathname === '/api/me/password' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const currentPassword = String(b.currentPassword || '');
      const newPassword = String(b.newPassword || '');
      if (hashPassword(currentPassword, user.password_salt) !== user.password_hash) {
        return sendJson(res, 400, { error: 'Current password is not right.' });
      }
      if (!passwordPolicyOk(newPassword)) return sendJson(res, 400, { error: PASSWORD_POLICY_ERROR });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(newPassword, salt);
      await q('UPDATE users SET password_salt=$2, password_hash=$3 WHERE id=$1', [user.id, salt, hash]);
      // Every other session is ended; this session keeps working so the
      // user is not kicked out by their own password change.
      const h = req.headers.authorization || '';
      const m = h.match(/^Bearer\s+(.+)$/);
      if (m) await q('DELETE FROM sessions WHERE user_id=$1 AND token<>$2', [user.id, m[1]]);
      else await q('DELETE FROM sessions WHERE user_id=$1', [user.id]);
      return sendJson(res, 200, { ok: true });
    }
    // Account deletion is code-gated (v141): "Yes, delete my account"
    // emails a 6-digit code to the account's OWN address (taken from
    // the signed-in session, never from the request body, so a code
    // can only ever go to the account being deleted), and the delete
    // itself needs the verified token that code produces. Same
    // 10-minute code / 5-attempt / 1-minute-cooldown shape as the
    // signup and reset codes.
    if (pathname === '/api/me/delete/request-code' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const email = user.email;
      const existing = (await q('SELECT * FROM delete_codes WHERE email=$1', [email])).rows[0];
      if (existing && existing.requested_at && Date.now() - new Date(existing.requested_at).getTime() < CODE_COOLDOWN_MS) {
        return sendJson(res, 400, { error: 'A code was just sent. Wait a minute before requesting another.' });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(code, salt);
      const expires = new Date(Date.now() + CODE_TTL_MS);
      await q('INSERT INTO delete_codes (email, code_salt, code_hash, attempts, expires_at, requested_at, verified_token, verified_expires_at) VALUES ($1,$2,$3,0,$4,now(),NULL,NULL) ON CONFLICT (email) DO UPDATE SET code_salt=$2, code_hash=$3, attempts=0, expires_at=$4, requested_at=now(), verified_token=NULL, verified_expires_at=NULL', [email, salt, hash, expires]);
      try {
        await sendResendEmail(email, 'Your Duello account deletion code', 'Your Duello account deletion code is ' + code + '. It expires in 10 minutes.');
      } catch (e) {
        await q('DELETE FROM delete_codes WHERE email=$1', [email]);
        return sendJson(res, 503, { error: 'Could not send the code. Try again.' });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/me/delete/verify-code' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const code = String(b.code || '').trim();
      const row = (await q('SELECT * FROM delete_codes WHERE email=$1', [user.email])).rows[0];
      if (!row || !row.code_hash) return sendJson(res, 400, { error: 'No code was requested for this account.' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await q('DELETE FROM delete_codes WHERE email=$1', [user.email]);
        return sendJson(res, 400, { error: 'That code expired. Request a new one.' });
      }
      if (row.attempts >= CODE_MAX_ATTEMPTS) {
        await q('DELETE FROM delete_codes WHERE email=$1', [user.email]);
        return sendJson(res, 400, { error: 'Too many wrong tries. Request a new code.' });
      }
      if (hashPassword(code, row.code_salt) !== row.code_hash) {
        await q('UPDATE delete_codes SET attempts=attempts+1 WHERE email=$1', [user.email]);
        return sendJson(res, 400, { error: 'That code is not right.' });
      }
      const verifiedToken = crypto.randomBytes(32).toString('hex');
      await q('UPDATE delete_codes SET code_salt=NULL, code_hash=NULL, attempts=0, verified_token=$2, verified_expires_at=$3 WHERE email=$1', [user.email, verifiedToken, new Date(Date.now() + VERIFIED_TTL_MS)]);
      return sendJson(res, 200, { verifiedToken });
    }
    if (pathname === '/api/me/delete' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      // v141: the delete needs the verified token from the emailed
      // code (POST /api/me/delete/verify-code). Without it, or with
      // an expired one, nothing is deleted.
      const b = await readBody(req);
      const verifiedToken = String(b.verifiedToken || '');
      const vrow = (await q('SELECT * FROM delete_codes WHERE email=$1', [user.email])).rows[0];
      if (!verifiedToken || !vrow || vrow.verified_token !== verifiedToken || !vrow.verified_expires_at || new Date(vrow.verified_expires_at).getTime() < Date.now()) {
        return sendJson(res, 400, { error: 'That delete is no longer valid. Request a new code.' });
      }
      // Delete everything belonging to this account, in one transaction,
      // child rows first (no ON DELETE CASCADE on these foreign keys).
      // The session that called this is deleted too, so the token stops
      // working the moment the account is gone.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
        await client.query('DELETE FROM friend_requests WHERE from_user_id=$1 OR to_user_id=$1', [user.id]);
        await client.query('DELETE FROM games WHERE user_id=$1', [user.id]);
        await client.query('DELETE FROM elo_history WHERE user_id=$1', [user.id]);
        await client.query('DELETE FROM daily_puzzle_solves WHERE user_id=$1', [user.id]);
        await client.query('DELETE FROM verification_codes WHERE email=$1', [user.email]);
        await client.query('DELETE FROM password_reset_codes WHERE email=$1', [user.email]);
        await client.query('DELETE FROM delete_codes WHERE email=$1', [user.email]);
        await client.query('DELETE FROM users WHERE id=$1', [user.id]);
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        return sendJson(res, 500, { error: 'Could not delete account.' });
      } finally { client.release(); }
      return sendJson(res, 200, { ok: true });
    }
    // ---------- Daily Puzzle solved state (v144) ----------
    // Solved dates live on the account, not the device: GET returns
    // the user's solved dates, POST solve marks one solved
    // (idempotent), POST unsolve clears one (Play again). All three
    // need the signed-in session; the date is a YYYY-MM-DD local
    // date key, so a bad date is a 400, not a row.
    // v191: 'solved' now means 'played a valid word' — the streak
    // completes on the first valid word, and the best score per
    // date rides along (bestScores) for the week strip's %.
    if (pathname === '/api/daily-puzzle' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const r = await q('SELECT date, placements, solved_at, best_score FROM daily_puzzle_solves WHERE user_id=$1 ORDER BY date', [user.id]);
      const moves = {}; const solvedAt = {}; const bestScores = {};
      for (const x of r.rows) {
        if (Array.isArray(x.placements)) moves[x.date] = x.placements;
        // v156: the first-solve time (never updated on re-solve) so
        // Share shows the true first time on any device. Duck-type
        // the Date (instanceof breaks across realms — the harness
        // FakePool builds its Dates outside the server vm).
        if (x.solved_at) solvedAt[x.date] = (x.solved_at && typeof x.solved_at.toISOString === 'function') ? x.solved_at.toISOString() : String(x.solved_at);
        if (typeof x.best_score === 'number') bestScores[x.date] = x.best_score;
      }
      return sendJson(res, 200, { solved: r.rows.map(x => x.date), moves, solvedAt, bestScores });
    }
    if (pathname === '/api/daily-puzzle/solve' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const date = String(b.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Enter a date.' });
      // v153: an optional solved move — at most 6 placements of one
      // letter on the 10x10 board. A bad move is a 400; a missing
      // one leaves whatever the row already has.
      // v156: an optional first-solve time (ISO string, recorded
      // locally at first solve). Validated; an invalid/missing
      // value falls back to the server clock (now()). The ON
      // CONFLICT never touches solved_at, so the first solve wins
      // — a re-solve after a Replay keeps the original time.
      let solvedAtParam = null;
      if (typeof b.solvedAt === 'string' && b.solvedAt) {
        const ms = Date.parse(b.solvedAt);
        if (!Number.isNaN(ms)) solvedAtParam = new Date(ms).toISOString();
      }
      let placements = null;
      if (b.placements !== undefined && b.placements !== null) {
        if (!Array.isArray(b.placements) || b.placements.length === 0 || b.placements.length > 6) return sendJson(res, 400, { error: 'Bad move.' });
        for (const p of b.placements) {
          if (!p || !Number.isInteger(p.row) || !Number.isInteger(p.col) || p.row < 0 || p.row > 9 || p.col < 0 || p.col > 9 || typeof p.letter !== 'string' || !/^[A-Z]$/.test(p.letter)) return sendJson(res, 400, { error: 'Bad move.' });
        }
        placements = b.placements.map(p => ({ row: p.row, col: p.col, letter: p.letter }));
      }
      // v191: an optional best score for the day (the highest-scoring
      // word played). A bad value is a 400; a missing one leaves
      // whatever the row already has. On conflict the best score
      // only ever goes UP (GREATEST, with the NULL-safe CASE so a
      // missing value never clobbers a stored best).
      let bestScore = null;
      if (b.bestScore !== undefined && b.bestScore !== null) {
        if (!Number.isInteger(b.bestScore) || b.bestScore < 0) return sendJson(res, 400, { error: 'Bad score.' });
        bestScore = b.bestScore;
      }
      await q('INSERT INTO daily_puzzle_solves (user_id, date, placements, solved_at, best_score) VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()), $5) ON CONFLICT (user_id, date) DO UPDATE SET placements = COALESCE(EXCLUDED.placements, daily_puzzle_solves.placements), best_score = CASE WHEN EXCLUDED.best_score IS NULL THEN daily_puzzle_solves.best_score ELSE GREATEST(COALESCE(daily_puzzle_solves.best_score, 0), EXCLUDED.best_score) END', [user.id, date, placements ? JSON.stringify(placements) : null, solvedAtParam, bestScore]);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/daily-puzzle/unsolve' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const date = String(b.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Enter a date.' });
      await q('DELETE FROM daily_puzzle_solves WHERE user_id=$1 AND date=$2', [user.id, date]);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      // Global is real registered users PLUS the 100 personas, ranked
      // together by Elo. Guest rows are not accounts and never appear;
      // photos ride along so the leaderboard can render pfps without
      // a second lookup. The signed-in user is included even outside
      // the top 25, with their true rank, so they always see themself.
      const r = await q(`WITH allrows AS (
        SELECT id, username, first_name, last_name, elo, photo_data, created_at, 0 AS is_persona FROM users WHERE email NOT LIKE '%@guest.local'
        UNION ALL
        SELECT id, username, first_name, last_name, elo, photo_url AS photo_data, created_at, 1 AS is_persona FROM personas
      ), ranked AS (
        SELECT *, RANK() OVER (ORDER BY elo DESC) AS rank FROM allrows
      )
      SELECT * FROM ranked WHERE rank <= 25 OR (is_persona = 0 AND username = $1) ORDER BY elo DESC, created_at ASC`, [user.username]);
      // v176: the roster version rides along, so the client can tell
      // whether the rows (and their photos) predate a server-side
      // re-seed without refetching the whole board: the seed version
      // is the single number the persona_seed table already stores.
      const pv = await q('SELECT MAX(version) AS v FROM persona_seed');
      const personasVersion = Number(pv.rows[0] && pv.rows[0].v) || 0;
      return sendJson(res, 200, { users: r.rows.map(u => ({ id: u.id, username: u.username, firstName: u.first_name, lastName: u.last_name, elo: u.elo, photoData: u.photo_data || null, isPersona: u.is_persona === 1, rank: Number(u.rank) })), personasVersion });
    }
    // v176: the cheap roster-version check. GET /api/leaderboard
    // carries the same number, but a client that only wants to know
    // whether the roster changed must not pay for the full board
    // (25 photo data URLs) on every foreground return or tab open.
    // One tiny indexed query; auth required, like the leaderboard.
    if (pathname === '/api/personas-version' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const pv = await q('SELECT MAX(version) AS v FROM persona_seed');
      return sendJson(res, 200, { personasVersion: Number(pv.rows[0] && pv.rows[0].v) || 0 });
    }
    // v171: admin export of the full user list for the
    // auto-updating Google Sheet (Username | Name | Type | Elo |
    // Email). Bearer token from ADMIN_EXPORT_TOKEN, compared in
    // constant time; no token configured, or a missing/wrong one,
    // is always 403 with no data. Real users carry their email;
    // personas carry a blank email. Never returns password hashes,
    // salts, codes, or sessions. Guest rows are not accounts and
    // are excluded, like the leaderboard. Ordered by Elo
    // descending (newest first on ties, so the sheet reads as a
    // ranking).
    if (pathname === '/api/admin/users-export' && req.method === 'GET') {
      const configured = process.env.ADMIN_EXPORT_TOKEN;
      const header = req.headers.authorization || '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      let ok = false;
      if (configured && presented) {
        const a = Buffer.from(presented);
        const b = Buffer.from(configured);
        ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!ok) return sendJson(res, 403, { error: 'Forbidden.' });
      const users = await q(`SELECT username, first_name, last_name, email, elo, created_at FROM users WHERE email NOT LIKE '%@guest.local' ORDER BY elo DESC, created_at ASC`);
      const personas = await q(`SELECT username, first_name, last_name, elo, created_at FROM personas ORDER BY elo DESC, created_at ASC`);
      const iso = (v) => (v instanceof Date ? v.toISOString() : v);
      return sendJson(res, 200, {
        users: users.rows.map(u => ({ username: u.username, firstName: u.first_name, lastName: u.last_name, email: u.email, elo: u.elo, type: 'real', createdAt: iso(u.created_at) })),
        personas: personas.rows.map(p => ({ username: p.username, firstName: p.first_name, lastName: p.last_name, email: '', elo: p.elo, type: 'persona', createdAt: iso(p.created_at) })),
      });
    }
    if (pathname === '/api/users/search' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      // Search used to filter only the top-25 leaderboard rows, so a
      // brand-new account at 1000 Elo (below the top 25) could never
      // be found — e.g. @neo was unsearchable from @ceo. Search the
      // whole users + personas tables instead, by name or username.
      // A leading @ is stripped server-side too: "@neo" searches
      // for neo, so the @ in a displayed handle never makes a
      // search miss.
      const qstr = (url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@+/, '');
      if (!qstr) return sendJson(res, 200, { users: [] });
      const like = `%${qstr.replace(/[%_\\]/g, m => '\\' + m)}%`;
      // Most relevant first: exact username, username starting
      // with the query, name starting with it, then the rest by
      // Elo. Only the top 5 ever come back.
      // The UNION must be wrapped in a subquery: Postgres only
      // allows output columns in a UNION's own ORDER BY, so the
      // relevance CASE (which references the $2 parameter) threw
      // "invalid UNION/INTERSECT/EXCEPT ORDER BY clause" and the
      // search always 500'd — every "success" so far was the
      // top-25 fallback. Ordering outside the subquery, the
      // parameter is fine.
      const r = await q(`SELECT * FROM (
        SELECT id, username, first_name, last_name, elo, photo_data, 0 AS is_persona FROM users
        WHERE email NOT LIKE '%@guest.local' AND (LOWER(username) LIKE $1 OR LOWER(first_name || ' ' || last_name) LIKE $1)
        UNION ALL
        SELECT id, username, first_name, last_name, elo, photo_url AS photo_data, 1 AS is_persona FROM personas
        WHERE LOWER(username) LIKE $1 OR LOWER(first_name || ' ' || last_name) LIKE $1
      ) s
        ORDER BY CASE WHEN LOWER(username) = $2 THEN 0 WHEN LOWER(username) LIKE $2 || '%' THEN 1 WHEN LOWER(first_name || ' ' || last_name) LIKE $2 || '%' THEN 2 ELSE 3 END, elo DESC LIMIT 5`, [like, qstr]);
      return sendJson(res, 200, { users: r.rows.map(u => ({ id: u.id, username: u.username, firstName: u.first_name, lastName: u.last_name, elo: u.elo, photoData: u.photo_data || null, isPersona: u.is_persona === 1, rank: null })) });
    }
    if (pathname === '/api/users/rank' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      // True Global rank for one player (the profile window shows
      // it below Elo). The leaderboard only ships the top 25, so a
      // player outside it has no rank client-side; count everyone
      // strictly ahead of them instead. Ties share a rank, and the
      // next rank skips ahead — the same rule as the leaderboard's
      // RANK() window.
      const username = (url.searchParams.get('username') || '').trim().toLowerCase();
      const target = await getUserByUsername(username) || (await q('SELECT * FROM personas WHERE username=$1', [username])).rows[0];
      if (!target) return sendJson(res, 404, { error: 'That player is not available.' });
      const r = await q(`WITH allrows AS (
        SELECT elo, created_at FROM users WHERE email NOT LIKE '%@guest.local'
        UNION ALL SELECT elo, created_at FROM personas
      ) SELECT COUNT(*)::int + 1 AS rank FROM allrows WHERE elo > $1`, [target.elo]);
      return sendJson(res, 200, { rank: r.rows[0].rank });
    }
    // ---------- Share cards (v187) ----------
    // The client renders the sender's profile card to a 1200x630
    // canvas at share time and uploads the PNG; the bytes live in
    // Postgres (share_cards) because Render's disk is ephemeral.
    // The GET is public (no auth) — iMessage's crawler fetches the
    // og:image without a session — and falls back to the app icon
    // when that user has never shared a card.
    if (pathname === '/api/share-card' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const png = await readRawBody(req);
      if (!png || png.length < 100 || png.length > 2000000) return sendJson(res, 400, { error: 'That image could not be saved.' });
      if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return sendJson(res, 400, { error: 'That image could not be saved.' });
      await q('INSERT INTO share_cards (username, png) VALUES ($1,$2) ON CONFLICT (username) DO UPDATE SET png=EXCLUDED.png, updated_at=now()', [user.username, png]);
      return sendJson(res, 200, { ok: true });
    }
    const shareCardMatch = pathname.match(/^\/api\/share-card\/([a-z0-9_]+)\.png$/);
    if (shareCardMatch && req.method === 'GET') {
      const row = (await q('SELECT png FROM share_cards WHERE username=$1', [shareCardMatch[1]])).rows[0];
      if (row && row.png) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', ...CORS_HEADERS });
        return res.end(row.png);
      }
      const icon = path.join(ROOT, 'public', 'assets', 'app-icon.png');
      if (!fs.existsSync(icon)) return sendJson(res, 404, { error: 'No image.' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', ...CORS_HEADERS });
      return fs.createReadStream(icon).pipe(res);
    }
    // ---------- Friends (real requests, v53) ----------
    // Requests used to live only in the sender's localStorage, so a
    // request never reached the other person's phone — and because
    // localStorage is shared by every account on one device, a
    // request to @ceo sent from @neo on the same phone showed up
    // in @ceo's own Friends list as a friend: himself. Now the
    // server owns requests: sending one makes it appear at the top
    // of the recipient's Friends page, and your own row can never
    // be a friend or a request (self-requests are rejected here).
    function friendRow(u) { return { id: u.id, username: u.username, firstName: u.first_name, lastName: u.last_name, elo: u.elo, photoData: u.photo_data || null, isPersona: false }; }
    if (pathname === '/api/friends' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const r = await q(`SELECT fr.*, u.* FROM friend_requests fr JOIN users u ON u.id = CASE WHEN fr.from_user_id=$1 THEN fr.to_user_id ELSE fr.from_user_id END WHERE fr.from_user_id=$1 OR fr.to_user_id=$1`, [user.id]);
      const friends = [], incoming = [], outgoing = [];
      for (const row of r.rows) {
        const other = friendRow(row);
        if (row.status === 'accepted') friends.push(other);
        else if (row.to_user_id === user.id) incoming.push(other);
        else outgoing.push(other);
      }
      return sendJson(res, 200, { friends, incoming, outgoing });
    }
    if (pathname === '/api/friends/request' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const target = await getUserByUsername(String(b.username || '').trim().toLowerCase());
      if (!target) return sendJson(res, 400, { error: 'That player is not available.' });
      if (target.id === user.id) return sendJson(res, 400, { error: 'You cannot add yourself as a friend.' });
      const existing = (await q('SELECT * FROM friend_requests WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)', [user.id, target.id])).rows[0];
      if (existing) {
        if (existing.status === 'accepted') return sendJson(res, 400, { error: 'You are already friends.' });
        if (existing.from_user_id === user.id) return sendJson(res, 400, { error: 'Request already sent.' });
        // They already asked you: their request becomes the friendship.
        await q("UPDATE friend_requests SET status='accepted' WHERE id=$1", [existing.id]);
        return sendJson(res, 200, { accepted: true });
      }
      await q('INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ($1,$2)', [user.id, target.id]);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/friends/respond' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const sender = await getUserByUsername(String(b.username || '').trim().toLowerCase());
      if (!sender) return sendJson(res, 400, { error: 'That player is not available.' });
      const reqRow = (await q("SELECT * FROM friend_requests WHERE from_user_id=$1 AND to_user_id=$2 AND status='pending'", [sender.id, user.id])).rows[0];
      if (!reqRow) return sendJson(res, 404, { error: 'No friend request from that player.' });
      if (b.accept) await q("UPDATE friend_requests SET status='accepted' WHERE id=$1", [reqRow.id]);
      else await q('DELETE FROM friend_requests WHERE id=$1', [reqRow.id]);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/friends/remove' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const other = await getUserByUsername(String(b.username || '').trim().toLowerCase());
      if (!other) return sendJson(res, 400, { error: 'That player is not available.' });
      // Cancels a request you sent, or removes an accepted friend.
      await q('DELETE FROM friend_requests WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)', [user.id, other.id]);
      return sendJson(res, 200, { ok: true });
    }
    // v187: a text friend link (?friend=<sender>) — the recipient
    // opens it and the sender's request is created for them, so the
    // recipient lands on the incoming-request accept/decline row.
    // The request runs sender -> recipient (the sender is asking);
    // if the recipient already asked the sender, that request
    // becomes the friendship at once (same rule as /api/friends/request).
    if (pathname === '/api/friends/text-request' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const sender = await getUserByUsername(String(b.username || '').trim().toLowerCase());
      if (!sender) return sendJson(res, 400, { error: 'That player is not available.' });
      if (sender.id === user.id) return sendJson(res, 400, { error: 'You cannot add yourself as a friend.' });
      const existing = (await q('SELECT * FROM friend_requests WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)', [sender.id, user.id])).rows[0];
      if (existing) {
        if (existing.status === 'accepted') return sendJson(res, 200, { ok: true, alreadyFriends: true });
        if (existing.from_user_id === user.id) {
          await q("UPDATE friend_requests SET status='accepted' WHERE id=$1", [existing.id]);
          return sendJson(res, 200, { ok: true, accepted: true });
        }
        return sendJson(res, 200, { ok: true, alreadyRequested: true });
      }
      await q('INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ($1,$2)', [sender.id, user.id]);
      return sendJson(res, 200, { ok: true });
    }
    // v190: an invite link (?invite=<inviter>) — tapping it is
    // acceptance: creating an account makes the pair friends at
    // once, with no accept/decline step. Mirror text-request's
    // errors and text-accept's upgrade: an existing pending row
    // in either direction is upgraded instead of inserting a
    // second one (UNIQUE (from_user_id, to_user_id)).
    if (pathname === '/api/friends/invite-accept' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const inviter = await getUserByUsername(String(b.username || '').trim().toLowerCase());
      if (!inviter) return sendJson(res, 400, { error: 'That player is not available.' });
      if (inviter.id === user.id) return sendJson(res, 400, { error: 'You cannot add yourself as a friend.' });
      const existing = (await q('SELECT * FROM friend_requests WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)', [inviter.id, user.id])).rows[0];
      if (existing) {
        if (existing.status === 'accepted') return sendJson(res, 200, { ok: true, alreadyFriends: true });
        await q("UPDATE friend_requests SET status='accepted' WHERE id=$1", [existing.id]);
        return sendJson(res, 200, { ok: true, accepted: true });
      }
      await q("INSERT INTO friend_requests (from_user_id, to_user_id, status) VALUES ($1,$2,'accepted')", [inviter.id, user.id]);
      return sendJson(res, 200, { ok: true });
    }
    // ---------- Challenges (real-player games, v76) ----------
    // A challenge is a live, 60-second invitation: the challenger
    // waits on the searching screen while the recipient sees it at
    // the top of their Friends page and accepts or declines. Accept
    // creates the game (challenger is the 'human' side, recipient
    // the 'bot' side); decline, cancel, or timeout ends it. While
    // the app is open the recipient's page polls for incoming
    // challenges every 5s; when it is closed or backgrounded the
    // push (v120) carries the same invitation instead.
    async function expireStaleChallenges() {
      await q("UPDATE challenges SET status='expired' WHERE status='pending' AND created_at < now() - interval '5 minutes'");
    }
    if (pathname === '/api/challenges' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const target = await getUserByUsername(String(b.username || '').trim().toLowerCase());
      if (!target) return sendJson(res, 400, { error: 'That player is not available.' });
      if (target.id === user.id) return sendJson(res, 400, { error: 'You cannot challenge yourself.' });
      // Challenges only go to friends: the Play button only appears
      // for friends, and the server enforces the same rule.
      const fr = (await q("SELECT * FROM friend_requests WHERE ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)) AND status='accepted'", [user.id, target.id])).rows[0];
      if (!fr) return sendJson(res, 400, { error: 'You can only challenge friends.' });
      await expireStaleChallenges();
      const existing = (await q("SELECT * FROM challenges WHERE ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)) AND status='pending'", [user.id, target.id])).rows[0];
      // v192: idempotent — a retried create (the client retries a
      // POST whose response was lost in a blip) returns the same
      // pending challenge instead of a 400, so a retry can never
      // surface as a failure or strand the challenger.
      if (existing) return sendJson(res, 200, { id: Number(existing.id), status: 'pending' });
      let ins;
      try {
        ins = await q('INSERT INTO challenges (from_user_id, to_user_id) VALUES ($1,$2) RETURNING id', [user.id, target.id]);
      } catch (e) {
        // v193: the race the index closes — two creates in the same
        // instant both passed the SELECT above; the second insert
        // fails 23505 on challenges_pending_pair_unique. Answer with
        // the row that won, exactly like the SELECT-first path.
        if (e && e.code === '23505') {
          const raced = (await q("SELECT * FROM challenges WHERE ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)) AND status='pending'", [user.id, target.id])).rows[0];
          if (raced) return sendJson(res, 200, { id: Number(raced.id), status: 'pending' });
        }
        throw e;
      }
      // Push (v120): the recipient's phone gets "@<you> challenged
      // you to a match!" when the app is closed or backgrounded.
      // Fire and forget — the challenge response must not wait on
      // APNs, and a push failure never breaks the challenge.
      // Personas can never be the target here: the lookup above is
      // in users, and personas live in the separate personas table.
      notifyChallengePush(user, target, ins.rows[0].id).then(r => {
        if (!r.sent) console.log('Challenge push not sent:', r.reason || ('attempted ' + (r.attempted || 0) + ', sent ' + (r.sentCount || 0)), 'challenge', ins.rows[0].id);
      }).catch(() => {});
      return sendJson(res, 200, { id: Number(ins.rows[0].id), status: 'pending' });
    }
    if (pathname === '/api/challenges/incoming' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      await expireStaleChallenges();
      const r = await q(`SELECT c.id AS cid, c.status, c.game_id, c.created_at, u.id AS uid, u.username, u.first_name, u.last_name, u.elo, u.photo_data FROM challenges c JOIN users u ON u.id = c.from_user_id WHERE c.to_user_id=$1 AND c.status='pending' ORDER BY c.created_at ASC`, [user.id]);
      return sendJson(res, 200, { challenges: r.rows.map(c => ({ id: Number(c.cid), status: c.status, gameId: c.game_id ? Number(c.game_id) : null, createdAt: c.created_at, from: { id: Number(c.uid), username: c.username, firstName: c.first_name, lastName: c.last_name, elo: c.elo, photoData: c.photo_data || null } })) });
    }
    const challengeMatch = pathname.match(/^\/api\/challenges\/(\d+)(?:\/(respond|cancel))?$/);
    if (challengeMatch) {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const ch = (await q('SELECT * FROM challenges WHERE id=$1', [challengeMatch[1]])).rows[0];
      if (!ch) return sendJson(res, 404, { error: 'Challenge not found.' });
      const action = challengeMatch[2];
      if (req.method === 'GET' && !action) {
        if (ch.from_user_id !== user.id && ch.to_user_id !== user.id) return sendJson(res, 403, { error: 'Not your challenge.' });
        return sendJson(res, 200, { id: ch.id, status: ch.status, gameId: ch.game_id ? Number(ch.game_id) : null });
      }
      if (req.method === 'POST' && action === 'respond') {
        if (ch.to_user_id !== user.id) return sendJson(res, 403, { error: 'Only the challenged player can answer.' });
        if (ch.status !== 'pending') return sendJson(res, 400, { error: 'That challenge is no longer waiting.' });
        const b = await readBody(req);
        if (!b.accept) {
          await q("UPDATE challenges SET status='declined' WHERE id=$1", [ch.id]);
          return sendJson(res, 200, { ok: true, status: 'declined' });
        }
        const challenger = (await q('SELECT * FROM users WHERE id=$1', [ch.from_user_id])).rows[0];
        if (!challenger) return sendJson(res, 400, { error: 'That player is no longer available.' });
        const game = newGame(challenger, 'human', null, user);
        await saveGameRow(game);
        await q("UPDATE challenges SET status='accepted', game_id=$1 WHERE id=$2", [game.id, ch.id]);
        return sendJson(res, 200, { ok: true, status: 'accepted', gameId: game.id });
      }
      if (req.method === 'POST' && action === 'cancel') {
        if (ch.from_user_id !== user.id) return sendJson(res, 403, { error: 'Only the challenger can cancel.' });
        if (ch.status !== 'pending') return sendJson(res, 200, { ok: true, status: ch.status });
        await q("UPDATE challenges SET status='cancelled' WHERE id=$1", [ch.id]);
        return sendJson(res, 200, { ok: true, status: 'cancelled' });
      }
    }
    // v187: a text challenge accept (?challenge=<sender>) — one
    // step, no pending challenge row ever exists: the recipient
    // accepting makes them friends AND creates/starts the game.
    // The sender is told by push (their game is ready — they are
    // not sitting on a waiting screen). Decline creates nothing
    // and adds no friend: the client never calls this endpoint.
    if (pathname === '/api/challenges/text-accept' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const sender = await getUserByUsername(String(b.username || '').trim().toLowerCase());
      if (!sender) return sendJson(res, 400, { error: 'That player is not available.' });
      if (sender.id === user.id) return sendJson(res, 400, { error: 'You cannot challenge yourself.' });
      const fr = (await q('SELECT * FROM friend_requests WHERE (from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)', [sender.id, user.id])).rows[0];
      // The pair may already have a pending row (the recipient
      // tapped ?friend= first, or asked the sender themself):
      // upgrade that row instead of inserting a second one — the
      // table has a UNIQUE (from_user_id, to_user_id), so a blind
      // insert 500s on the duplicate (caught by a live check).
      if (!fr) await q("INSERT INTO friend_requests (from_user_id, to_user_id, status) VALUES ($1,$2,'accepted')", [sender.id, user.id]);
      else if (fr.status !== 'accepted') await q("UPDATE friend_requests SET status='accepted' WHERE id=$1", [fr.id]);
      const game = newGame(sender, 'human', null, user);
      await saveGameRow(game);
      const ins = await q("INSERT INTO challenges (from_user_id, to_user_id, status, game_id) VALUES ($1,$2,'accepted',$3) RETURNING id", [sender.id, user.id, game.id]);
      notifyChallengeAccepted(sender, user, game.id).catch(() => {});
      return sendJson(res, 200, { ok: true, gameId: game.id, challengeId: Number(ins.rows[0].id) });
    }
    if (pathname === '/api/define' && req.method === 'GET') {
      return sendJson(res, 200, await getDefinition(url.searchParams.get('word') || ''));
    }
    if (pathname === '/api/games' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      // Real-player games only ever start from an accepted challenge
      // (the recipient creates the row), never from this endpoint.
      if (b.bot === 'human') return sendJson(res, 400, { error: 'Real-player games start from a challenge, not here.' });
      const botType = b.bot === 'fishstick' ? 'fishstick' : b.bot === 'persona' ? 'persona' : 'competitive';
      let persona = null;
      if (botType === 'persona') {
        if (b.personaId) {
          const pr = await q('SELECT * FROM personas WHERE id=$1', [b.personaId]);
          persona = pr.rows[0] || null;
          if (!persona) return sendJson(res, 400, { error: 'That player is not available.' });
        } else {
          // Play Online: a random persona within 40 Elo of the player,
          // so every matchup is close. If nobody is in range (a high
          // or low Elo with no nearby personas), fall back to the
          // nearest persona rather than failing to make a match.
          const near = await q('SELECT * FROM personas WHERE elo BETWEEN $1 AND $2 ORDER BY RANDOM() LIMIT 1', [user.elo - 40, user.elo + 40]);
          const any = near.rows[0] ? near : await q('SELECT * FROM personas ORDER BY ABS(elo - $1) LIMIT 1', [user.elo]);
          persona = any.rows[0] || null;
          if (!persona) return sendJson(res, 503, { error: 'No online players are available yet.' });
        }
      }
      const game = newGame(user, botType, persona);
      // Do NOT run the bot here: the client shows the 5s think, then polls
      // GET, which advances the bot turn (see advanceBotTurnIfReady).
      await saveGameRow(game);
      const out = serializeGame(game, user);
      if (game.status === 'finished') out.stats = gameStatsPayload(game);
      return sendJson(res, 200, out);
    }
    // Past Games (v123, item 6): the user's finished games, newest
    // first, as a compact list (opponent, result, score, date) for
    // the profile's Past Games screen. The full game (final board +
    // moveLog for replay) comes from GET /api/games/:id. Only
    // finished games are listed — an active game is not a past game.
    // v194: scope=active is a stub that returns no games. The v193
    // resume list is gone — an active game you're not in should be
    // impossible (never-started games are voided after 5 min,
    // abandoned ones after 60) — but v193 clients already in the
    // wild still call it, and handing them the finished list would
    // mis-render finished games as resumable rows.
    // Paging + filter (v128, items 4+5): limit/offset page 25 at a
    // time (limit capped at 50) and scope filters by opponent kind
    // (aggregate = all, vsHumans = personas + real players, vsBots =
    // Fishstick + Doppelgänger). The scope filter runs in SQL on
    // bot_type, which is set at INSERT for every game. One extra row
    // is fetched so hasMore is exact without a second count query.
    if (pathname === '/api/games' && req.method === 'GET') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const scope = url.searchParams.get('scope') || 'aggregate';
      // v194: see the stub note above — no games, ever.
      if (scope === 'active') return sendJson(res, 200, { games: [], hasMore: false });
      let scopeSql = '';
      if (scope === 'vsHumans') scopeSql = " AND bot_type IN ('persona','human')";
      else if (scope === 'vsBots') scopeSql = " AND bot_type IN ('fishstick','competitive')";
      // v140: exclude finished 0-0 bot games (see isZeroZeroBotGame)
      // — they were free exits, not history. Filtering in SQL keeps
      // the limit/offset paging exact. COALESCE guards a state with
      // no scores key at all: such a game is never excluded.
      const zeroZeroBotSql = " AND NOT (bot_type IN ('fishstick','competitive') AND COALESCE((state->'scores'->>'human')::int, -1) = 0 AND COALESCE((state->'scores'->>'bot')::int, -1) = 0)";
      const whereSql = " WHERE (user_id=$1 OR opponent_id=$1) AND state->>'status'='finished'" + scopeSql + zeroZeroBotSql;
      const r = await q("SELECT id, user_id, opponent_id, bot_type, state, created_at, updated_at FROM games" + whereSql + " ORDER BY updated_at DESC LIMIT $2 OFFSET $3", [user.id, limit + 1, offset]);
      const hasMore = r.rows.length > limit;
      const pageRows = hasMore ? r.rows.slice(0, limit) : r.rows;
      const games = pageRows.map((row) => {
        const g = loadGameRow(row);
        const { isOpp, mySide, oppSide } = gameSides(g, user);
        const oppName = g.botType === 'persona' && g.persona ? (g.persona.firstName + ' ' + g.persona.lastName) : g.botType === 'competitive' ? 'Doppelgänger' : g.botType === 'fishstick' ? 'Fishstick' : (isOpp ? ((g.challenger && g.challenger.firstName) || (g.challenger && g.challenger.username) || 'Opponent') : ((g.opponent && g.opponent.firstName) || (g.opponent && g.opponent.username) || 'Opponent'));
        // Opponent pic + username for the Game History rows (v125):
        // the row shows the opponent's photo and @username (blue when
        // you won, white when they won) instead of the W/L badge and
        // the plain name. Bots have no photo — the client renders the
        // fishstick image / robot for those kinds.
        const oppUser = g.botType === 'human' ? (isOpp ? g.challenger : g.opponent) : null;
        const opponentUsername = g.botType === 'persona' && g.persona ? '@' + g.persona.username : g.botType === 'competitive' ? '@doppelganger' : g.botType === 'fishstick' ? '@fishstick' : (oppUser && oppUser.username ? '@' + oppUser.username : oppName);
        const opponentPhoto = g.botType === 'persona' && g.persona ? (g.persona.photoData || null) : g.botType === 'human' ? ((oppUser && oppUser.photoData) || null) : null;
        const opponentKind = g.botType === 'persona' ? 'persona' : g.botType === 'competitive' ? 'competitive' : g.botType === 'fishstick' ? 'fishstick' : 'human';
        const result = g.winner === 'draw' ? 'draw' : g.winner === mySide ? 'win' : g.winner === oppSide ? 'loss' : 'loss';
        // v193: the row carries its status + started flag so the
        // client can tell an active game (Resume) from a finished
        // one (review) without a second fetch.
        return { id: g.id, botType: g.botType, opponentName: oppName, opponentUsername, opponentPhoto, opponentKind, myScore: g.scores[mySide], oppScore: g.scores[oppSide], result, reason: g.reason || null, createdAt: row.created_at, finishedAt: row.updated_at, status: g.status, started: !!g.started };
      });
      return sendJson(res, 200, { games, hasMore });
    }
    // Play Online matchmaking (v123, item 4): the client polls this
    // once a second for up to 7s. A searcher is paired with the
    // longest-waiting other player; the waiting player finds the game
    // on their next poll (pendingMatches). No match in 7s -> the
    // client falls back to a persona.
    if (pathname === '/api/matchmaking/search' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      matchmakingPrune();
      const pending = pendingMatches.get(user.id);
      if (pending) {
        pendingMatches.delete(user.id);
        const g = await loadGameForUser(user, pending);
        if (g) return sendJson(res, 200, { matched: true, gameId: g.id });
      }
      let waitingId = null;
      for (const [uid] of matchQueue) { if (uid !== user.id) { waitingId = uid; break; } }
      if (waitingId !== null) {
        matchQueue.delete(waitingId);
        const waitingUser = (await q('SELECT * FROM users WHERE id=$1', [waitingId])).rows[0];
        if (!waitingUser) { matchQueue.set(user.id, Date.now()); return sendJson(res, 200, { matched: false, queued: true }); }
        const game = newGame(user, 'human', null, waitingUser);
        await saveGameRow(game);
        pendingMatches.set(waitingId, game.id);
        presenceTouch(game, user.id);
        presenceTouch(game, waitingId);
        return sendJson(res, 200, { matched: true, gameId: game.id });
      }
      matchQueue.set(user.id, Date.now());
      return sendJson(res, 200, { matched: false, queued: true });
    }
    if (pathname === '/api/matchmaking/cancel' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      matchQueue.delete(user.id);
      return sendJson(res, 200, { ok: true });
    }
    // Offline sync (v106): a finished game played on the device, submitted
    // whole for replay validation. The delta is a property of the game
    // (computed from the Elo at game start), so the STORED, validated
    // delta is applied to the CURRENT server Elo — never recomputed
    // from it (endGame is not used here: it recomputes the delta and
    // saves via saveGameRow, which knows nothing of client_game_id).
    // Idempotent on offlineId: a re-submit is a no-op 200.
    if (pathname === '/api/games/sync' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const shape = validateOfflineSync(engine, b, { shapeOnly: true });
      if (!shape.ok) return sendJson(res, 422, { error: shape.error });
      // v138: a no-move bot forfeit is a free exit — the client never
      // syncs one, but a stale/racing client might. Record nothing:
      // no game row, no Elo move, no elo_history. Answer success so
      // the client drops it from the outbox instead of retrying.
      const noMoveForfeitSync = (b.botType === 'competitive' || b.botType === 'fishstick')
        && Array.isArray(b.plays) && b.plays.length === 0
        && b.state && b.state.reason === 'By forfeit' && b.state.winner === 'bot'
        && b.state.scores && b.state.scores.human === 0 && b.state.scores.bot === 0;
      if (noMoveForfeitSync) return sendJson(res, 200, { synced: true, freeExit: true });
      const dup = await q('SELECT id FROM games WHERE client_game_id=$1', [b.offlineId]);
      if (dup.rows[0]) return sendJson(res, 200, { synced: true, gameId: Number(dup.rows[0].id), duplicate: true });
      const check = validateOfflineSync(engine, b);
      if (!check.ok) return sendJson(res, 422, { error: check.error });
      // v199: Fishstick moves nobody's Elo — the applied delta is 0
      // whatever the client submitted (older clients still send the
      // pre-freeze delta; it is ignored, not rejected, so their
      // pending syncs still land). No elo_history row for it either.
      const delta = b.botType === 'fishstick' ? 0 : b.eloDelta;
      // The stored state is the client's serializeGame shape plus the
      // fields a normal stored row carries: userId/botType (profile
      // stats read the state to tell which side the row owner played)
      // and the Elo fields below, overwritten once the new Elo is known.
      const storedState = JSON.parse(JSON.stringify(b.state));
      storedState.userId = user.id;
      storedState.botType = b.botType;
      let gameId;
      try {
        const ins = await q('INSERT INTO games (user_id, bot_type, bot_elo, state, client_game_id, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id', [user.id, b.botType, b.botElo, JSON.stringify(storedState), b.offlineId, b.finishedAt || new Date().toISOString()]);
        gameId = Number(ins.rows[0].id);
      } catch (e) {
        // A duplicate racing in between the check above and this
        // insert is a no-op 200, not a 500.
        if (e && e.code === '23505') {
          const raced = await q('SELECT id FROM games WHERE client_game_id=$1', [b.offlineId]);
          if (raced.rows[0]) return sendJson(res, 200, { synced: true, gameId: Number(raced.rows[0].id), duplicate: true });
        }
        throw e;
      }
      const eloRow = await q('UPDATE users SET elo = elo + $1, elo_high = GREATEST(elo_high, elo + $1) WHERE id = $2 RETURNING elo', [delta, user.id]);
      const newElo = Number(eloRow.rows[0].elo);
      // v169: the stored state arrives with the client-side placeholder
      // id 'offline-<id>' — replace it with the real row id, so no
      // later reader of the stored state can mistake the placeholder
      // for a loadable game id (that is what broke the profile record
      // words; profileStatsFor now also takes the row id directly).
      storedState.id = gameId;
      storedState.eloDeltaHuman = delta;
      storedState.eloDeltaBot = -delta;
      storedState.eloAfterHuman = newElo;
      storedState.eloAfterBot = b.botElo - delta;
      storedState.botElo = b.botElo - delta;
      await q('UPDATE games SET state=$1::jsonb WHERE id=$2', [JSON.stringify(storedState), gameId]);
      if (b.botType !== 'fishstick') await q('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [user.id, gameId, newElo, delta]);
      return sendJson(res, 200, { synced: true, gameId, eloAfter: newElo, delta });
    }
    // Live updates for real-player games (SSE): EventSource cannot send
    // an Authorization header, so the session token travels as a query
    // param (same origin, same token the client already stores). The
    // client re-syncs on (re)connect because the current state is sent
    // at once; a 25s heartbeat comment keeps the connection alive
    // through proxies. Only human games stream — bot games are driven
    // by the client's polls (the GET handler advances the bot).
    const streamMatch = pathname.match(/^\/api\/games\/(\d+)\/stream$/);
    if (streamMatch && req.method === 'GET') {
      try {
        const token = url.searchParams.get('token') || '';
        let user = null;
        if (token) {
          const s = await q('SELECT * FROM sessions WHERE token=$1', [token]);
          if (s.rows[0]) user = await getUserById(s.rows[0].user_id);
        }
        if (!user || isGuestUser(user)) return sendJson(res, 401, { error: 'Not signed in.' });
        const game = await loadGameForUser(user, streamMatch[1]);
        if (!game) return sendJson(res, 404, { error: 'Game not found.' });
        if (game.botType !== 'human') return sendJson(res, 400, { error: 'Live updates are for real-player games.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
        const sub = { res, user };
        if (!gameSubscribers.has(game.id)) gameSubscribers.set(game.id, new Set());
        gameSubscribers.get(game.id).add(sub);
        const out = serializeGame(game, user);
        if (game.status === 'finished') { const { isOpp } = gameSides(game, user); out.stats = gameStatsPayload(game, isOpp); }
        res.write(`event: game\ndata: ${JSON.stringify(out)}\n\n`);
        const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(hb); const s = gameSubscribers.get(game.id); if (s) { s.delete(sub); if (s.size === 0) gameSubscribers.delete(game.id); } });
        return;
      } catch (e) {
        // Headers may already be sent (mid-stream): never answer a
        // stream error with a JSON body.
        try { if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' }); else res.end(); } catch {}
        return;
      }
    }
    const gameMatch = pathname.match(/^\/api\/games\/(\d+)(?:\/(validate|play|pass|forfeit|shuffle|start|heartbeat|leave|time-expired))?$/);
    if (gameMatch) {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const game = await loadGameForUser(user, gameMatch[1]);
      if (!game) return sendJson(res, 404, { error: 'Game not found.' });
      const action = gameMatch[2];
      // In a real-player game the recipient plays the 'bot' side of
      // the stored state; every handler below works in terms of
      // mySide/oppSide so the same code serves both players.
      const { isOpp, mySide, oppSide } = gameSides(game, user);
      const myRack = () => game[mySide === 'human' ? 'humanRack' : 'botRack'];
      // Presence (v123, item 2): any game request counts as "seen"
      // (the GET handler also runs the exit check; the heartbeat
      // handler runs it too).
      presenceTouch(game, user.id);
      if (req.method === 'GET' && !action) {
        // v140: a finished 0-0 bot game is not history — it was a
        // free exit (pre-v138). Serve 404 so it cannot be opened
        // from a direct link either. Active 0-0 bot games (just
        // started, no moves yet) still load normally.
        if (game.status === 'finished' && isZeroZeroBotGame(game)) return sendJson(res, 404, { error: 'Game not found.' });
        // A pending matchmaking pairing is consumed here too: the
        // waiting player may reach the game directly (a reload, a
        // notification) instead of polling matchmaking again, and a
        // stale pending entry would hand them this old game on their
        // NEXT search instead of queueing them.
        if (pendingMatches.get(user.id) === game.id) pendingMatches.delete(user.id);
        // Presence (v123, item 2): this request counts as "seen".
        // If the real opponent has been gone >30s, the game ends
        // here (they exited) before any further state is served.
        presenceTouch(game, user.id);
        if (await presenceCheckExit(game, user)) {
          const out = serializeGame(game, user);
          if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
          return sendJson(res, 200, out);
        }
        // The shared 5-second countdown: a real-player game starts its
        // countdown only once BOTH players have loaded it, so both
        // phones count down to the same instant. Each player's first
        // GET checks them in; the second check-in stamps
        // countdownEndsAt and the save broadcasts it to both (the 1s
        // poll covers a dropped stream). Runs even for fresh games,
        // which the settle block below skips.
        if (game.botType === 'human' && game.status === 'active' && !game.started && !game.countdownEndsAt) {
          game.checkedIn = game.checkedIn || {};
          if (!game.checkedIn[user.id]) {
            game.checkedIn[user.id] = true;
            if (game.checkedIn[game.userId] && game.checkedIn[game.opponentId]) {
              game.countdownEndsAt = Date.now() + 5000;
            }
            await saveGameRow(game);
          }
        }
        // Fresh games: do not settle or advance anything before /start.
        if (game.status === 'active' && !isFreshGame(game)) {
          // A real opponent moves on their own phone: never run the
          // bot engine for a human game, just settle the clock and
          // skip dead turns.
          if (game.botType !== 'human') await advanceBotTurnIfReady(game, user);
          settleClock(game);
          let guard = 0;
          while (game.status === 'active' && game.clocks[game.turn] <= 0 && guard++ < 5) {
            if (game.clocks.human <= 0 && game.clocks.bot <= 0) { await finishIfNeeded(game, user); break; }
            game.turn = game.turn === 'human' ? 'bot' : 'human';
            game.turnStartedAt = Date.now();
            if (game.turn === 'bot' && game.botType !== 'human') {
              if (!game.botThinkUntil) { game.botThinkMs = botThinkMsFor(game); game.botThinkUntil = Date.now() + game.botThinkMs; }
              if (Date.now() >= (game.botThinkUntil || game.turnStartedAt + botThinkMsFor(game))) {
                const moved = runBotTurn(game);
                if (moved) stepBotClockTo20sMark(game);
                game.botThinkUntil = null;
              }
              if (await finishIfNeeded(game, user)) break;
            }
          }
          if (game.status === 'active' && game.turn === 'human') {
            applyHumanNoMovePass(game);
            await finishIfNeeded(game, user);
          } else if (game.status === 'active' && game.turn === 'bot' && game.botType === 'human') {
            applyBotNoMovePass(game);
            await finishIfNeeded(game, user);
          }
          // Guarded: this GET loaded before a play may have landed, and
          // its settle work (which runs findMoves and takes seconds on a
          // busy board) must never save that stale snapshot over the
          // play. On a conflict the fresh row — which already has the
          // play — is what gets returned instead.
          if (!(await saveGameRow(game, { guarded: true }))) {
            const fresh = await loadGameForUser(user, gameMatch[1]);
            if (fresh) {
              const outFresh = serializeGame(fresh, user);
              if (fresh.status === 'finished') outFresh.stats = gameStatsPayload(fresh, isOpp);
              return sendJson(res, 200, outFresh);
            }
          }
        }
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && action === 'start') {
        // Countdown end: clocks start HERE, not at game creation. The old
        // flow let the server clock tick through the 5s countdown (and
        // the ~1s create round-trip, so the first clock showed 4:59, then
        // jumped to ~4:55 when the countdown fetch settled it). Only a
        // fresh, unplayed game is reset, and only once (started flag),
        // so this can never reset a game already in progress.
        if (game.status === 'active' && !game.started) {
          const hm = (game.moves && game.moves.human) || [];
          const bm = (game.moves && game.moves.bot) || [];
          if (!hm.length && !bm.length && !game.lastHuman && !game.lastBot) {
            game.clocks = { human: 240000, bot: 240000 };
            game.turnStartedAt = Date.now();
            // No bot think for a real opponent: their turn just starts.
            game.botThinkUntil = game.turn === 'bot' && game.botType !== 'human' ? Date.now() + botThinkMsFor(game) : null;
            if (game.turn === 'bot' && game.botType !== 'human') game.botThinkMs = botThinkMsFor(game);
            game.started = true;
            await saveGameRow(game);
            if (game.turn === 'bot' && game.botType !== 'human') scheduleBotMove(game);
          }
        }
        if (game.status === 'active' && game.turn === 'human') {
          applyHumanNoMovePass(game);
          if (await finishIfNeeded(game, user)) { /* finished */ }
          await saveGameRow(game);
        } else if (game.status === 'active' && game.turn === 'bot' && game.botType === 'human') {
          applyBotNoMovePass(game);
          if (await finishIfNeeded(game, user)) { /* finished */ }
          await saveGameRow(game);
        }
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && action === 'shuffle') {
        const b = await readBody(req);
        const rack = b.rack;
        if (!Array.isArray(rack) || rack.length !== 6) return sendJson(res, 400, { error: 'Rack must have 6 tiles.' });
        const a = [...myRack()].sort().join('');
        const c = [...rack].sort().join('');
        if (a !== c) return sendJson(res, 400, { error: 'Rack does not match.' });
        game[mySide === 'human' ? 'humanRack' : 'botRack'] = rack.map(String);
        await saveGameRow(game);
        return sendJson(res, 200, serializeGame(game, user));
      }
      if (req.method === 'POST' && action === 'validate') {
        if (game.status !== 'active' || game.turn !== mySide) return sendJson(res, 200, { valid: false, error: 'Not your turn.' });
        const b = await readBody(req);
        const placements = (b.placements || []).map(p => ({ row: Number(p.row), col: Number(p.col), letter: String(p.letter || '').toUpperCase() }));
        const v = validatePlay(game.board, myRack(), placements, game.premiums, boardIsEmpty(game.board));
        return sendJson(res, 200, v);
      }
      if (req.method === 'POST' && action === 'play') {
        const playReqStart = Date.now();
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        const b0 = await readBody(req);
        settleClock(game, b0.clientElapsedMs);
        if (game.turn !== mySide) return sendJson(res, 400, { error: 'Not your turn.' });
        if (game.clocks[mySide] <= 0) {
          // Timed out: skip this side, let the other side keep playing
          // (you cannot win on time). For a bot opponent that means
          // starting its turn; for a real one the turn just flips.
          // BUT if the other clock is out too, there is nobody left to
          // play — the game ends here instead of handing a move to an
          // opponent with no time (v148: both clocks out, one player
          // already dead, so the second timeout must finish it).
          if (game.clocks[oppSide] <= 0) {
            finishIfNeeded(game, user);
          } else if (game.botType === 'human') { game.turn = oppSide; game.turnStartedAt = Date.now(); game.botThinkUntil = null; }
          else startBotTurn(game);
          await saveGameRow(game);
          const out = serializeGame(game, user);
          if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
          return sendJson(res, 200, { ...out, timedOut: true });
        }
        const b = b0;
        const placements = (b.placements || []).map(p => ({ row: Number(p.row), col: Number(p.col), letter: String(p.letter || '').toUpperCase() }));
        const isFirst = boardIsEmpty(game.board);
        const v = validatePlay(game.board, myRack(), placements, game.premiums, isFirst);
        if (!v.valid) return sendJson(res, 400, v);
        // The exhaustive best-move scan is what made the Play reply slow:
        // the rack sat blank (played slots emptied at the tap, refilled
        // only by the reply) until the scan finished. So the scan now runs
        // AFTER the reply is sent, on a snapshot of the pre-move board and
        // rack, and only patches the move's isOptimal flag on a fresh load
        // (loading after the scan means bot saves made in between are kept).
        // The reply itself carries the refilled rack immediately.
        const preBoard = game.board.map(row => row.slice());
        const preRack = myRack().slice();
        const deferredGameId = game.id, deferredUserId = game.userId, deferredScore = v.score, deferredSide = mySide;
        const runDeferredOptimal = () => setImmediate(async () => {
          try {
            const bestMoves = findMoves(preBoard, preRack, isFirst, false);
            const bestScore = bestMoves.length ? bestMoves[0].score : null;
            const g2 = await loadGameForUser({ id: deferredUserId }, deferredGameId);
            if (!g2 || !g2.moves || !g2.moves[deferredSide] || !g2.moves[deferredSide].length) return;
            const last = g2.moves[deferredSide][g2.moves[deferredSide].length - 1];
            last.isOptimal = (bestScore !== null && deferredScore === bestScore);
            await saveGameRow(g2);
          } catch {}
        });
        applyMove(game, mySide, v, null);
        if (game.clocks[oppSide] <= 0) {
          // Opponent out of time: no turn for them at all. The turn
          // stays with the mover, their clock keeps running, and they
          // can play move after move instead of waiting out a turn
          // that can never produce a move.
          game.turn = mySide; game.turnStartedAt = Date.now(); game.botThinkUntil = null;
        } else if (game.botType === 'human') {
          game.turn = oppSide; game.turnStartedAt = Date.now(); game.botThinkUntil = null;
        } else {
          startBotTurn(game);
          game.botThinkUntil = playReqStart + (game.botThinkMs || 5000);
        }
        if (game.status === 'active' && game.turn === 'human') {
          applyHumanNoMovePass(game);
          await finishIfNeeded(game, user);
        } else if (game.status === 'active' && game.turn === 'bot' && game.botType === 'human') {
          applyBotNoMovePass(game);
          await finishIfNeeded(game, user);
        }
        await saveGameRow(game);
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
        // Reply first, scan after: the response (with the refilled rack) is
        // already handed to the socket before the deferred scan runs, so
        // the scan can no longer hold the rack blank.
        sendJson(res, 200, out);
        runDeferredOptimal();
        return;
      }
      if (req.method === 'POST' && action === 'pass') {
        const passReqStart = Date.now();
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        const bPass = await readBody(req).catch(() => ({}));
        settleClock(game, bPass.clientElapsedMs);
        if (game.turn !== mySide) return sendJson(res, 400, { error: 'Not your turn.' });
        // No passing in a one-sided stretch: when either clock is at
        // 0, the player who is out of time cannot pass (they have no
        // turn to give up), and the player still moving cannot pass
        // either — they play on alone until the game ends.
        if (game.clocks[mySide] <= 0) return sendJson(res, 400, { error: 'You are out of time.' });
        if (game.clocks[oppSide] <= 0) return sendJson(res, 400, { error: 'Your opponent is out of time, so you can\'t pass.' });
        game.clocks[mySide] = Math.max(0, game.clocks[mySide] - 30000);
        game.consecutivePasses++;
        game.consecutiveNoMoves = 0;
        game[mySide === 'human' ? 'lastHuman' : 'lastBot'] = { word: null, points: 0, passed: true };
        if (game.consecutivePasses >= 2) {
          game.botThinkUntil = null;
          const winner = game.scores.human > game.scores.bot ? 'human' : game.scores.bot > game.scores.human ? 'bot' : 'draw';
          await endGame(game, user, 'Final score', winner);
        } else if (game.botType === 'human') {
          game.turn = oppSide; game.turnStartedAt = Date.now(); game.botThinkUntil = null;
        } else {
          startBotTurn(game);
          game.botThinkUntil = passReqStart + (game.botThinkMs || 5000);
          // Bot turn is pending: client shows 5s think, then GET advances it.
        }
        if (game.status === 'active' && game.turn === 'human') {
          applyHumanNoMovePass(game);
          await finishIfNeeded(game, user);
        } else if (game.status === 'active' && game.turn === 'bot' && game.botType === 'human') {
          applyBotNoMovePass(game);
          await finishIfNeeded(game, user);
        }
        await saveGameRow(game);
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
        return sendJson(res, 200, out);
      }
      // Presence heartbeat (v123, item 2): the client calls this
      // every 5s while a game is open, so the server knows the player
      // is still there even on their own turn (when no poll runs).
      // It also runs the exit check, so the remaining player ends a
      // gone opponent's game promptly on their own heartbeat.
      if (req.method === 'POST' && action === 'heartbeat') {
        presenceTouch(game, user.id);
        if (await presenceCheckExit(game, user)) {
          const out = serializeGame(game, user);
          if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
          return sendJson(res, 200, { ...out, opponentExited: true });
        }
        return sendJson(res, 200, { ok: true, opponentConnected: game.botType === 'human' ? presenceOpponentConnected(game, user) : true });
      }
      // Leave (v123, item 3): out of time + losing only — the client
      // only offers it then. The leaver loses (Elo moves now) and
      // goes home; a real opponent keeps playing the game out solo
      // (applyLeave). A bot game has no one to play out, so Leave is
      // a plain forfeit there.
      if (req.method === 'POST' && action === 'leave') {
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        // The user here is the raw DB row (getUserById), so the name
        // is first_name, not firstName.
        const leaverName = user.first_name || user.username || 'You';
        if (game.botType === 'human') {
          await applyLeave(game, mySide, leaverName);
        } else {
          // v138: a no-move bot game leaving is a free exit, not a
          // loss — the row is deleted so it never shows in history.
          if (isFreeExitGame(game)) {
            await deleteGameRow(game);
            return sendJson(res, 200, { ok: true, freeExit: true });
          }
          await endGame(game, user, 'By forfeit', oppSide);
        }
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game, isOpp);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && action === 'forfeit') {
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        // v138: bot game, no moves played — a free exit. Delete the
        // row so it never appears in Game History; no Elo move, no
        // elo_history, no stats. Persona/human games never free-exit.
        if (isFreeExitGame(game)) {
          await deleteGameRow(game);
          return sendJson(res, 200, { ok: true, freeExit: true });
        }
        // The forfeiter loses, whoever they are; the other side wins.
        await endGame(game, user, 'By forfeit', oppSide);
        const out = serializeGame(game, user);
        out.stats = gameStatsPayload(game, isOpp);
        return sendJson(res, 200, out);
      }
      // v157 byoyomi: the countdown player's 9s ran out. The client
      // enforces the 9s (it displays the countdown and calls this
      // when it expires); the server validates the clock state so a
      // stray or early call cannot end a game where both clocks are
      // still running. Winner by score — the clocks are end
      // conditions, not a win/loss decider (same as the both-0
      // 'Final score' end). The exact 9s is enforced by the honest
      // client; the server only checks that one clock is at 0 and
      // the other is still running, which is the byoyomi state.
      if (req.method === 'POST' && action === 'time-expired') {
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        settleClock(game);
        const oneAtZero = (game.clocks.human <= 0 && game.clocks.bot > 0) || (game.clocks.bot <= 0 && game.clocks.human > 0);
        const bothAtZero = game.clocks.human <= 0 && game.clocks.bot <= 0;
        // v165: both clocks at 0 is the stuck state Jeff hit — the
        // countdown expired (so the client POSTed here) but the
        // second clock had already run out, so the old code rejected
        // the POST with 400 and the client sat on 0:00 / 0:00 with
        // no countdown and no stat window, waiting on a fetch that
        // never landed. Both clocks at 0 means the game is over
        // regardless of which path noticed it first, so end it here
        // (Final score, same as the GET's both-0 path) and return
        // the finished game — the POST itself becomes the recovery.
        if (bothAtZero) {
          const winnerBoth = game.scores.human > game.scores.bot ? 'human' : game.scores.bot > game.scores.human ? 'bot' : 'draw';
          await endGame(game, user, 'Final score', winnerBoth);
          const outBoth = serializeGame(game, user);
          outBoth.stats = gameStatsPayload(game, isOpp);
          return sendJson(res, 200, outBoth);
        }
        if (!oneAtZero) return sendJson(res, 400, { error: 'Not in byoyomi.' });
        const winner = game.scores.human > game.scores.bot ? 'human' : game.scores.bot > game.scores.human ? 'bot' : 'draw';
        await endGame(game, user, 'Shot clock expired', winner);
        const out = serializeGame(game, user);
        out.stats = gameStatsPayload(game, isOpp);
        return sendJson(res, 200, out);
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'Server error: ' + e.message });
  }
});
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Duello bot-play listening on http://localhost:${PORT}`);
    console.log(`Dictionary: ${WORDS.size} words; definitions bundled: ${Object.keys(DEFS).length}`);
    startPersonaSim();
    startVoidSweep();
  });
}).catch(e => { console.error('Postgres init failed:', e.message); process.exit(1); });
