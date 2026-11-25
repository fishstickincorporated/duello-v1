// Duello bot-play frontend (Postgres, no login). Server is the source of truth:
// Submitted plays are validated server-side; the verdict shown while placing
// tiles is computed locally once the word list has loaded, so the check is
// instant instead of a network round-trip per placement.
// Auth is required before entering the app: on load, a missing or
// rejected session shows the auth screen (email/password signup and
// sign-in). The token in localStorage ('duello_token') is an account
// session token; games use it, so a signed-in account plays as itself.
// Saved-login access must never kill the page: a browser that blocks
// site data (e.g. Safari's Block All Cookies) throws on localStorage
// access, and a throw on the very first line used to leave every screen
// hidden forever. These wrappers degrade to a memory-only session.
function storeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function storeDel(k) { try { localStorage.removeItem(k); } catch {} }
let token = storeGet('duello_token') || '';
let me = null, game = null, gameFetchAt = 0;
// Replay (v123, items 5+6): replayIndex is the number of moves from
// game.moveLog applied to the empty board (null = live/final board,
// 0 = empty board, moveLog.length = final board). reviewMode is true
// when the board shows a finished game from the Past Games list
// (the review buttons replace the end buttons there).
let replayIndex = null, reviewMode = false;
// v182: where the review was entered from — 'gamelog' (Game History
// list) or 'profile' (a longest/best word on the Profile tab).
// Exit routes back to the same place instead of always the log.
let reviewOrigin = 'gamelog';
// Declared up here, not with the auth block below: the boot code calls
// setAuthMode, which assigns authMode, so this declaration must already
// have run or the page dies before any screen shows (ReferenceError:
// Cannot access 'authMode' before initialization).
let authMode = 'signin';
let pending = []; // {row,col,letter,rackIndex}
let selectedRack = null, armed = {}, currentBot = 'competitive';
// Global drag state: only one drag can be live, and a stuck drag must be
// cleanable from anywhere (notably Play). The old per-tile closures could
// leave a drag alive with pointer capture held, so every later tap went to
// the captured tile instead of the button underneath — the frozen screen
// in Jeff's screenshot, and the "tap elsewhere, then Play works" pattern.
let activeDragCleanup = null;
function registerDragCleanup(fn) { if (activeDragCleanup && activeDragCleanup !== fn) { try { activeDragCleanup(); } catch {} } activeDragCleanup = fn; }
function clearDragCleanup(fn) { if (activeDragCleanup === fn) activeDragCleanup = null; }
function cleanupStuckDrag() { if (activeDragCleanup) { const fn = activeDragCleanup; activeDragCleanup = null; try { fn(); } catch {} } }
const $ = id => document.getElementById(id);
// Optimistic rack refill (mirrors server refillRack/drawLetter exactly,
// including the >=2 vowels / >=2 consonants floor). Used only so new
// tiles appear at the Play tap, not when the Play POST returns; the
// server reply then replaces the rack with its authoritative letters.
const OPT_VOWELS = new Set(['A','E','I','O','U']);
const OPT_FREQ = [['A',8.59],['B',2.46],['C',2.39],['D',4.31],['E',9.43],['F',2.16],['G',3.00],['H',2.39],['I',6.26],['J',1.46],['K',1.77],['L',4.51],['M',2.68],['N',5.62],['O',6.43],['P',2.70],['Q',1.38],['R',6.44],['S',6.12],['T',6.17],['U',4.41],['V',1.94],['W',2.20],['X',1.51],['Y',2.20],['Z',1.48]];
const OPT_FREQ_CUM = []; { let s = 0; for (const [l, f] of OPT_FREQ) { s += f; OPT_FREQ_CUM.push([s, l]); } }
function optDrawLetter() { const r = Math.random() * 100; for (const [cum, l] of OPT_FREQ_CUM) if (r <= cum) return l; return 'E'; }
function optDrawVowel() { for (let i = 0; i < 100; i++) { const l = optDrawLetter(); if (OPT_VOWELS.has(l)) return l; } return 'E'; }
function optDrawConsonant() { for (let i = 0; i < 100; i++) { const l = optDrawLetter(); if (!OPT_VOWELS.has(l)) return l; } return 'B'; }
function optRefillRack(rack, usedIndices) {
  const next = rack.slice(); const usedSet = new Set(usedIndices);
  const unplayed = next.filter((_, i) => !usedSet.has(i));
  let needV = Math.max(0, 2 - unplayed.filter(c => OPT_VOWELS.has(c)).length);
  let needC = Math.max(0, 2 - unplayed.filter(c => !OPT_VOWELS.has(c)).length);
  for (const idx of usedIndices) {
    if (needV > 0) { next[idx] = optDrawVowel(); needV--; }
    else if (needC > 0) { next[idx] = optDrawConsonant(); needC--; }
    else next[idx] = optDrawLetter();
  }
  return next;
}
let optimisticPlay = false;
// Display rounding is CEIL, not floor: with floor, 4:00 dropped to 3:59
// within ~100ms of starting (299500ms remaining floors to 4:59), so
// the timer never sat on 4:00 for a full second. With ceil, 4:00 shows
// for the whole first second (240000 down to 239001ms), then 3:59 for
// the next full second, and so on. The old ceil problem (runoff parsed
// back from displayed text jumping up a second) no longer applies:
// runoff now starts from game state, not from displayed text.
const fmtClock = ms => { ms = Math.max(0, Math.floor(ms / 1000) * 1000); if (ms === 0) return '0:00'; const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return `${m}:${String(s).padStart(2, '0')}`; };
// Clock accuracy fix: the old code used Math.ceil, so the display was
// always rounded UP to the next second — the clock looked a second
// ahead of the real remaining time, and the bot runoff (parsed back
// from that displayed text) started a second high, i.e. it jumped UP
// before animating down 15s to the 20s mark. Floor matches the real time.
// The iOS shell (TestFlight) serves the app from capacitor://localhost,
// so a relative /api/... would resolve against the local file and fail.
// In the shell, every API call (fetch and the EventSource stream) goes
// to the live server instead. On the web the base is empty, so nothing
// changes there. Capacitor exposes window.Capacitor in the shell.
const API_BASE = (typeof window !== 'undefined' && window.Capacitor) ? 'https://duellogame.com' : '';
// The iOS shell is a Capacitor app; the web is not. Push
// notifications (v120) only exist in the shell.
const IS_CAPACITOR = (typeof window !== 'undefined' && !!window.Capacitor);
// App version (v115): the ?v=N cache-buster in index.html. The local
// definitions bundle is versioned with the same number so a rebuilt
// bundle is fetched fresh instead of served stale from the cache.
const APP_VERSION = 195;
// v192: transient failures are retried, not surfaced. On iOS a
// dead connection throws TypeError('Load failed') (WebKit) —
// Jeff saw that literal text on sign-in and on the challenge
// screen whenever the Render service blipped (a 502 hit the
// users-sheet sync at 18:20 the same evening he tested). Retry
// network errors and 502/503/504 up to 3 attempts with backoff;
// a failure that survives still throws a friendly message, never
// the raw browser text. 'Not signed in.' and server validation
// errors pass through untouched. No retry for account creation /
// code sending (not safe to repeat blindly) — that includes the
// delete-account code send, whose 503 used to be retried, which
// delayed its error past the confirm step (harness D3c caught it).
// A surviving 502/503/504 throws the server's own message when it
// has one ('Could not send the code. Try again.', 'No online
// players are available yet.') and the friendly message only when
// the gateway answered bare — either way, never the raw browser
// text.
const API_NO_RETRY = ['/api/signup', '/api/auth/request-code', '/api/auth/request-reset', '/api/me/delete/request-code'];
async function api(path, opts = {}) {
  const base = String(path).split('?')[0];
  const retryable = !API_NO_RETRY.includes(base);
  const delays = [300, 900];
  for (let attempt = 0; ; attempt++) {
    let r, j;
    try {
      r = await fetch(API_BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      // fetch threw: the network failed before any response.
      const network = e instanceof TypeError || /load failed|failed to fetch|network/i.test((e && e.message) || '');
      if (network && retryable && attempt < delays.length) { await new Promise(res => setTimeout(res, delays[attempt])); continue; }
      if (network) throw new Error("Couldn't reach Duello. Check your connection and try again.");
      throw e;
    }
    if (r.ok) {
      // A successful call means we are online: if finished offline games are
      // waiting, drain them in the background (see scheduleDrain/drainOutbox).
      scheduleDrain();
      return j;
    }
    if (retryable && (r.status === 502 || r.status === 503 || r.status === 504) && attempt < delays.length) { await new Promise(res => setTimeout(res, delays[attempt])); continue; }
    if (r.status === 502 || r.status === 503 || r.status === 504) throw new Error(j.error || "Couldn't reach Duello. Check your connection and try again.");
    const e = new Error(j.error || 'Request failed'); e.status = r.status; if (j.invalidWords) e.invalidWords = j.invalidWords; throw e;
  }
}
// Play Online and Play Friends need the server, so they are greyed
// out when there is no connection (Jeff, Nov 16, 2026). Bot games
// stay available — they are always native (v116). Reuses the
// existing .mode.greyed style. Called whenever the Home screen shows
// and on every online/offline change, so the buttons follow
// connectivity live.
function refreshOnlineButtons() {
  const offline = isOffline();
  for (const id of ['playOnlineBtn', 'playFriendsBtn']) {
    const b = $(id); if (!b) continue;
    b.disabled = offline;
    b.classList.toggle('greyed', offline);
  }
}
// ---------- v131: home redesign + Daily Puzzle ----------
// Daily Puzzle streak: played dates live in localStorage (per device,
// offline-safe). A streak is consecutive played days ending today, or
// ending yesterday when today is not played yet.
// v191: 'solved' now means 'played a valid word' — the streak
// completes on the FIRST valid word of the day, not on the optimal
// score; the object is the highest score, not 100%. The store key
// and the function names are unchanged so every pre-v191 solve
// keeps counting; only the meaning changed. The store is now
// {solved, moves, times, best}: `moves` holds the BEST word's
// placements for the day (what reopens on the board), `times` the
// first-play time, `best` the best score per date (the week's % is
// best / that day's optimal).
const PUZZLE_STORE_KEY = 'duello-daily-puzzle-v1';
function puzzleSolvedDates() {
  try { const raw = JSON.parse(localStorage.getItem(PUZZLE_STORE_KEY) || 'null'); if (raw && Array.isArray(raw.solved)) return new Set(raw.solved); } catch {}
  return new Set();
}
// v156: solved is FOREVER — there is no unsolve any more (a Replay
// no longer unsolves), so the tombstone set is retired. A legacy
// tombstone left by a v155 Replay is simply never read again, and
// the store is now {solved, moves, times, best}.
// v156: the first-play time per date (ISO string) — recorded once,
// never overwritten: a better word later in the day keeps the
// original time.
function puzzleSolvedTimes() {
  try { const raw = JSON.parse(localStorage.getItem(PUZZLE_STORE_KEY) || 'null'); if (raw && raw.times && typeof raw.times === 'object') return raw.times; } catch {}
  return {};
}
// v153: the best move for a date ([{row, col, letter}]) — what the
// highest-scoring play put on the board, so a played puzzle reopens
// with the best word showing. Stored beside the played dates and
// synced the same way (the server's daily_puzzle_solves.placements
// column).
function puzzleSolvedMoves() {
  try { const raw = JSON.parse(localStorage.getItem(PUZZLE_STORE_KEY) || 'null'); if (raw && raw.moves && typeof raw.moves === 'object') return raw.moves; } catch {}
  return {};
}
// v191: the best score per date ({dateKey: score}) — the week's %
// is best / that day's optimal. A date with no best here either
// was never played, or was solved before v191 (no best was ever
// recorded for it — it reads 100%, see puzzleBestPct).
function puzzleBestScores() {
  try { const raw = JSON.parse(localStorage.getItem(PUZZLE_STORE_KEY) || 'null'); if (raw && raw.best && typeof raw.best === 'object') return raw.best; } catch {}
  return {};
}
function puzzleWriteStore(solved, moves, times, best) {
  try { localStorage.setItem(PUZZLE_STORE_KEY, JSON.stringify({ solved: [...solved].sort(), moves: moves || puzzleSolvedMoves(), times: times || puzzleSolvedTimes(), best: best || puzzleBestScores() })); } catch {}
}
// v191: record a valid word. The date enters the played set on the
// first valid word (that is the streak now), the best score and the
// best move update only when this word beats the day's best, and
// the first-play time is recorded once. `score` may be omitted
// (marking a date played with no word, as the old puzzleSaveSolved
// callers did) — then only the played set is touched. Returns
// whether this word set a new best. Only a new best is uploaded;
// if the POST fails (offline), the local save stands and the next
// sync uploads it (with the first-play time).
function puzzleSavePlay(dateKey, placements, score) {
  const set = puzzleSolvedDates(); set.add(dateKey);
  const moves = puzzleSolvedMoves();
  const best = puzzleBestScores();
  const times = puzzleSolvedTimes();
  let isNewBest = false;
  if (typeof score === 'number') {
    const prevBest = best[dateKey];
    isNewBest = prevBest == null || score > prevBest;
    if (isNewBest) {
      best[dateKey] = score;
      if (Array.isArray(placements) && placements.length) moves[dateKey] = placements.map(p => ({ row: p.row, col: p.col, letter: p.letter }));
    }
  }
  // First play wins — a better word later in the day keeps the original time.
  if (!times[dateKey]) times[dateKey] = new Date().toISOString();
  puzzleWriteStore(set, moves, times, best);
  if (isNewBest && token && !isOffline()) api('/api/daily-puzzle/solve', { method: 'POST', body: JSON.stringify({ date: dateKey, placements: moves[dateKey] || undefined, solvedAt: times[dateKey], bestScore: score }) }).catch(() => {});
  return isNewBest;
}
// v191: a day's best percentage — best score / that day's optimal,
// rounded, clamped to 100. Null when the day was never played (no
// % to show). A pre-v191 solve has no recorded best — it solved at
// the optimal or better, so it reads 100%.
function puzzleBestPct(dateKey, optimalScore) {
  if (!optimalScore) return null;
  const best = puzzleBestScores()[dateKey];
  if (best != null) return Math.min(100, Math.round(best / optimalScore * 100));
  if (puzzleSolvedDates().has(dateKey)) return 100;
  return null;
}
// v195: the 2-minute timed window. The window starts on the first
// open of that day's puzzle and is wall-clock based — the start is
// persisted per date, so leaving the puzzle or closing the app
// never pauses it: remaining = start + 2 min - now, computed on
// every tick/render. After the window the score locks (the best %
// within the window is final) and Share appears.
const PUZZLE_TIMER_MS = 120000;
const PUZZLE_TIMER_KEY = 'duello-daily-puzzle-timer-v1';
function puzzleTimerStarts() {
  try { const raw = JSON.parse(localStorage.getItem(PUZZLE_TIMER_KEY) || 'null'); if (raw && typeof raw === 'object') return raw; } catch {}
  return {};
}
function puzzleTimerStartMs(dateKey) {
  const starts = puzzleTimerStarts();
  if (starts[dateKey] == null) {
    starts[dateKey] = Date.now();
    try { localStorage.setItem(PUZZLE_TIMER_KEY, JSON.stringify(starts)); } catch {}
  }
  return starts[dateKey];
}
function puzzleTimerRemainingMs(dateKey) {
  const starts = puzzleTimerStarts();
  const start = starts[dateKey];
  if (start == null) return PUZZLE_TIMER_MS;
  // Clamp: a clock skew (or a fixed-date test) must never show a
  // negative or >2:00 remaining.
  return Math.max(0, Math.min(PUZZLE_TIMER_MS, start + PUZZLE_TIMER_MS - Date.now()));
}
function puzzleTimerText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// The posted score for the open puzzle: the locked % once the window
// is over, else the best % so far (0 when nothing has been played).
function puzzlePostedPct(st) {
  if (st.lockedPct != null) return st.lockedPct;
  const p = puzzleBestPct(st.dateKey, st.puzzle.optimalScore);
  return p == null ? 0 : p;
}
let puzzleTimerInterval = null;
function puzzleClearTimerInterval() { if (puzzleTimerInterval) { clearInterval(puzzleTimerInterval); puzzleTimerInterval = null; } }
function puzzleUpdateTimerPill() {
  const st = puzzleBoardState; if (!st || !st.isToday || st.timerDone) return;
  const pill = $('puzzleTimerPill'); if (!pill) return;
  const clock = $('puzzleTimerClock'), pct = $('puzzleTimerPct');
  if (clock) clock.textContent = puzzleTimerText(puzzleTimerRemainingMs(st.dateKey));
  if (pct) pct.textContent = puzzlePostedPct(st) + '%';
}
function puzzleTickTimer() {
  const st = puzzleBoardState; if (!st || !st.isToday || st.timerDone) { puzzleClearTimerInterval(); return; }
  if (puzzleTimerRemainingMs(st.dateKey) <= 0) { puzzleLockTimer(); return; }
  puzzleUpdateTimerPill();
}
function puzzleStartTimerInterval() {
  puzzleClearTimerInterval();
  puzzleTimerInterval = setInterval(puzzleTickTimer, 1000);
}
// v195: lock the day's score at the end of the timed window (or the
// moment the optimal word lands). The best % within the window is
// final — later play is practice and never moves it. The pill goes
// away, the locked score centers at the top, Share appears.
function puzzleLockTimer() {
  const st = puzzleBoardState; if (!st) return;
  if (st.timerDone) return;
  st.timerDone = true;
  st.lockedPct = puzzlePostedPct(st);
  puzzleClearTimerInterval();
  const pill = $('puzzleTimerPill'); if (pill) pill.classList.add('hidden');
  const fin = $('puzzleFinalScore');
  if (fin) { fin.textContent = st.lockedPct + '%'; fin.classList.remove('hidden'); }
  renderPuzzleBoard(); renderPuzzleWeekStrip();
}
let puzzleServerSynced = false;
async function puzzleSyncFromServer() {
  if (!token || isOffline()) return false;
  // v156: solved is forever — there is no unsolve any more (Replay
  // no longer unsolves), so tombstones are retired. A legacy
  // tombstone from a v155 Replay is ignored, never uploaded, and
  // never deletes a merged date.
  let serverSolved, serverMoves = {}, serverTimes = {}, serverBest = {};
  try {
    const j = await api('/api/daily-puzzle');
    serverSolved = new Set(Array.isArray(j.solved) ? j.solved : []);
    if (j.moves && typeof j.moves === 'object') serverMoves = j.moves;
    if (j.solvedAt && typeof j.solvedAt === 'object') serverTimes = j.solvedAt;
    if (j.bestScores && typeof j.bestScores === 'object') serverBest = j.bestScores;
  } catch { return false; }
  // Upload local plays the server lacks (offline plays, and plays
  // from before the account state existed) — with the best move and
  // best score, so the other device shows the word too, and with
  // the first-play time, so the other device shows the true time.
  // A local best that BEATS the server's is uploaded too (the
  // server takes the greater of the two). The server stamps
  // solved_at on insert and never updates it, so the first play
  // wins there too.
  const local = puzzleSolvedDates();
  const localMoves = puzzleSolvedMoves();
  const localTimes = puzzleSolvedTimes();
  const localBest = puzzleBestScores();
  for (const d of [...local]) {
    const lb = localBest[d];
    if (!serverSolved.has(d) || (lb != null && (serverBest[d] == null || lb > serverBest[d]))) {
      try { await api('/api/daily-puzzle/solve', { method: 'POST', body: JSON.stringify({ date: d, placements: localMoves[d] || undefined, solvedAt: localTimes[d] || undefined, bestScore: lb }) }); } catch {}
    }
  }
  // Merge is the union. The best score is the max of the two sides
  // per date, and the winning side's move rides with it (the
  // server's wins a tie, as before). The server's first-play time
  // wins for a date it has; a local time fills in only when the
  // server has none (e.g. a legacy solve recorded before the
  // server returned times).
  const merged = new Set([...local, ...serverSolved]);
  const mergedMoves = {};
  const mergedBest = {};
  for (const d of merged) {
    const lb = localBest[d], sb = serverBest[d];
    if (lb != null && sb != null) mergedBest[d] = Math.max(lb, sb);
    else if (lb != null) mergedBest[d] = lb;
    else if (sb != null) mergedBest[d] = sb;
    if (sb != null && (lb == null || sb >= lb)) { if (serverMoves[d]) mergedMoves[d] = serverMoves[d]; else if (localMoves[d]) mergedMoves[d] = localMoves[d]; }
    else if (localMoves[d]) mergedMoves[d] = localMoves[d];
    else if (serverMoves[d]) mergedMoves[d] = serverMoves[d];
  }
  const mergedTimes = {};
  for (const d of merged) { if (serverTimes[d]) mergedTimes[d] = serverTimes[d]; else if (localTimes[d]) mergedTimes[d] = localTimes[d]; }
  puzzleWriteStore(merged, mergedMoves, mergedTimes, mergedBest);
  return true;
}
function localDateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function puzzleStreak() {
  const solved = puzzleSolvedDates();
  const d = new Date();
  if (!solved.has(localDateKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (solved.has(localDateKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function renderHomeHeader() {
  if (!me) return;
  // v144: once per session, pull the account's solved dates so the
  // Daily Puzzle tag (countdown vs Solved) follows the account, not
  // just this device. The re-render after the sync picks the change
  // up; the flag stops it looping.
  if (!puzzleServerSynced) { puzzleServerSynced = true; puzzleSyncFromServer().then(ok => { if (ok) renderHomeHeader(); }).catch(() => {}); }
  const pfp = $('homePfp');
  if (pfp) { pfp.innerHTML = pfpHTML(me); pfp.classList.toggle('no-photo', !usablePhoto(me)); }
  const elo = $('homeElo'); if (elo) elo.textContent = me.elo ?? '';
  // v147: the Pro badge follows the account tier — Free hides it.
  // v149: the badge is accent gold; on Free a blue "Upgrade to Pro"
  // pill shows in its place instead, opening the Pro screen.
  const proBadge = document.querySelector('.home-pro'); if (proBadge) proBadge.classList.toggle('hidden', !me.pro);
  const upPill = $('homeUpgradePill'); if (upPill) upPill.classList.toggle('hidden', !!me.pro);
  const streak = $('homeStreak'); if (streak) streak.textContent = puzzleStreak();
  // Daily Puzzle button subtitle is the live streak (v132): "N day
  // streak!🔥". Updated here so it refreshes on every home show and
  // right after a puzzle is solved (renderHomeHeader is called there).
  const psub = $('puzzleStreakSub'); if (psub) psub.textContent = puzzleStreak() + ' day streak!🔥';
  // The tag shows a countdown to midnight Boston time while the
  // puzzle is unsolved, and "Solved" once it is (v142). It is never
  // hidden now; the 1s timer keeps the countdown ticking.
  const tag = $('puzzleSolvedTag');
  if (tag) {
    const solved = puzzleSolvedDates().has(localDateKey(new Date()));
    tag.textContent = solved ? 'Solved' : puzzleCountdownText();
    tag.classList.remove('hidden');
    if (!solved) startPuzzleCountdown();
  }
}
// Daily Puzzle: a 10x10 board puzzle (v142). One puzzle a day, authored
// in public/daily-puzzles.json keyed by local date: { board: [[r,c,letter]...],
// rack: [letters], premiums: {"r,c": "DL"|"DW"|"TL"|"TW"}, optimalScore, optimalWord }.
// The player finds the best move; the Move strength bar shows their
// play's score against the optimal score. Any play scoring the optimal
// (or better) solves it. Solved dates reuse the v131 streak store, so
// the streak carries over from the old unscramble.
let dailyPuzzlesCache = null;
async function loadDailyPuzzles() {
  if (dailyPuzzlesCache) return dailyPuzzlesCache;
  try {
    const r = await fetch('/daily-puzzles.json?v=' + APP_VERSION);
    if (!r.ok) return null;
    dailyPuzzlesCache = await r.json();
    return dailyPuzzlesCache;
  } catch { return null; }
}
// Today's puzzle, or the latest one in the file when today has none
// (so the button always opens something).
function dailyPuzzleEntry(all) {
  if (!all) return null;
  const today = localDateKey(new Date());
  if (all[today]) return { dateKey: today, puzzle: all[today] };
  const keys = Object.keys(all).sort();
  if (!keys.length) return null;
  const last = keys[keys.length - 1];
  return { dateKey: last, puzzle: all[last] };
}
// Countdown to midnight Boston time (v142): the Daily Puzzle button
// shows this where "Solved" appears, until the puzzle is solved.
function msUntilBostonMidnight() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = {};
  for (const part of fmt.formatToParts(now)) parts[part.type] = part.value;
  const intoDay = ((+parts.hour) % 24) * 3600 + (+parts.minute) * 60 + (+parts.second);
  return (86400 - intoDay) * 1000 - now.getMilliseconds();
}
function puzzleCountdownText() {
  const ms = Math.max(0, msUntilBostonMidnight());
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
let puzzleCountdownTimer = null;
function startPuzzleCountdown() {
  if (puzzleCountdownTimer) return;
  puzzleCountdownTimer = setInterval(() => {
    const tag = $('puzzleSolvedTag');
    if (!tag) return;
    if (!puzzleSolvedDates().has(localDateKey(new Date()))) tag.textContent = puzzleCountdownText();
  }, 1000);
}
let puzzleBoardState = null;
// Set while a puzzle tile drag is live: renderPuzzleBoard must not
// rebuild mid-drag (it would detach the captured tile), like the
// real game's renderGame.
let puzzleDragLive = false;
function puzzleBoardBase(entry) {
  const board = localEngine.emptyBoard();
  for (const [r, c, l] of entry.puzzle.board) board[r][c] = l;
  return board;
}
function renderPuzzleBoard() {
  const st = puzzleBoardState; if (!st) return;
  if (puzzleDragLive) return; // never rebuild mid-drag (would detach the captured tile)
  const boardEl = $('puzzleBoard'); if (!boardEl) return;
  boardEl.innerHTML = '';
  const placedByCell = {};
  for (const p of st.placed) placedByCell[p.row + ',' + p.col] = p;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    const cell = document.createElement('div');
    const prem = st.puzzle.premiums[`${r},${c}`];
    const fixed = st.board[r][c];
    const placed = placedByCell[r + ',' + c];
    cell.className = 'cell' + (prem ? ' ' + prem : '') + (fixed ? ' fixed-tile' : '');
    cell.dataset.r = r; cell.dataset.c = c;
    cell.textContent = fixed ? '' : (prem || '');
    if (fixed) { const t = document.createElement('div'); t.className = 'tile'; t.innerHTML = tileSVG(fixed); cell.appendChild(t); }
    // v143: a placed tile looks exactly like a pending tile in a real
    // game — the game's .tile.pending gold outline.
    else if (placed) { const t = document.createElement('div'); t.className = 'tile pending'; t.innerHTML = tileSVG(placed.letter); enablePuzzlePlacedDrag(t, placed); cell.appendChild(t); }
    boardEl.appendChild(cell);
  }
  // v143: the rack renders exactly like the game's — .tile with
  // data-idx, a used tile becomes a .tile.empty placeholder, and the
  // selected tile gets the game's gold outline (inline, like renderGame).
  const rackEl = $('puzzleRack');
  if (rackEl) {
    rackEl.innerHTML = '';
    st.rack.forEach((t, i) => {
      if (t.used) { const e = document.createElement('div'); e.className = 'tile empty'; rackEl.appendChild(e); return; }
      const d = document.createElement('div'); d.className = 'tile'; d.dataset.idx = i;
      d.innerHTML = tileSVG(t.ch);
      if (st.selected === i) d.style.outline = '2px solid #ffd166';
      enablePuzzleRackDrag(d, i);
      rackEl.appendChild(d);
    });
  }
  puzzleUpdateStrengthBar();
  puzzleUpdateStatusEl();
  // v149: the point bubble rides on the last cell of the main word.
  // renderPuzzleBoard rebuilds the board (which destroys the bubble
  // element), so re-attach it from the state after every rebuild —
  // the same pattern as the game's last-play bubble.
  if (st.bubble && st.placed.length) puzzleShowBubble(st.bubble.score, st.bubble.mainCells);
  // v195: the row is Exit, Recall, Shuffle — plus Share only once
  // the timed window is over or the optimal word has landed (today's
  // puzzle only; a past puzzle never shows Share). There is no Replay
  // and no solved screen any more: the board stays playable after a
  // word, and Share is solid blue (.share-ready) whenever it shows.
  // v154: the controls row itself must be visible — a finished real
  // game used to hide it (renderGame toggled the first .controls in
  // the document, which was this row), so reopening a solved puzzle
  // showed no Exit / Share at all. renderGame is scoped now, and
  // this removes the class here too so a stale hide can never stick.
  const ctrls = document.querySelector('#puzzleBoardScreen .controls');
  if (ctrls) ctrls.classList.remove('hidden');
  const exit = $('puzzleBoardExitBtn'), recall = $('puzzleBoardRecallBtn'), shuffle = $('puzzleBoardShuffleBtn'), share = $('puzzleBoardShareBtn');
  if (exit) exit.classList.remove('hidden');
  if (recall) { recall.disabled = false; recall.classList.remove('hidden'); }
  if (shuffle) { shuffle.disabled = false; shuffle.classList.remove('hidden'); }
  // v195: Share exists ONLY on today's puzzle, and only once the
  // timed window is over or the optimal word has landed. Before
  // that the row is exactly Exit, Recall, Shuffle — no placeholder,
  // no greyed Share.
  const hitOptimal = st.lastScore != null && st.lastScore >= st.puzzle.optimalScore;
  const shareVisible = st.isToday && (st.timerDone || hitOptimal);
  if (share) { share.classList.toggle('hidden', !shareVisible); share.disabled = !shareVisible; share.classList.toggle('share-ready', shareVisible); }
  // v195: the timer pill (today, window running) vs the locked score
  // (today, window over — or a past puzzle, whose window is long
  // over). The pill shows the live clock + the best % so far; the
  // final score is the posted % centered at the top.
  const pill = $('puzzleTimerPill'), fin = $('puzzleFinalScore');
  if (st.isToday && !st.timerDone) {
    if (pill) pill.classList.remove('hidden');
    if (fin) fin.classList.add('hidden');
    puzzleUpdateTimerPill();
  } else {
    if (pill) pill.classList.add('hidden');
    if (fin) { fin.textContent = puzzlePostedPct(st) + '%'; fin.classList.remove('hidden'); }
  }
  puzzleFitBoard();
}
// v195: the board is the only flexible piece of the puzzle screen —
// it takes the largest square that fits the space the header, rack
// and buttons leave, so the screen never scrolls. Called on every
// board render (open, placement, timer lock) and on resize.
function puzzleFitBoard() {
  const wrap = document.querySelector('#puzzleBoardScreen .board-wrap');
  const b = $('puzzleBoard');
  if (!wrap || !b) return;
  const r = wrap.getBoundingClientRect();
  const size = Math.floor(Math.min(r.width, r.height));
  if (size > 0) { b.style.width = size + 'px'; b.style.height = size + 'px'; }
}
window.addEventListener('resize', () => { try { if (puzzleBoardState && !$('puzzleBoardScreen').classList.contains('hidden')) puzzleFitBoard(); } catch {} });
function puzzleBoardSelectRack(i) {
  const st = puzzleBoardState; if (!st) return;
  const t = st.rack[i]; if (!t || t.used) return;
  st.selected = st.selected === i ? null : i;
  renderPuzzleBoard();
}
function puzzleBoardTapCell(r, c) {
  const st = puzzleBoardState; if (!st) return;
  if (st.board[r][c]) return; // a fixed board tile — not playable
  const placedIdx = st.placed.findIndex(p => p.row === r && p.col === c);
  if (placedIdx !== -1) {
    // Tap a placed tile to send it back to the rack.
    const p = st.placed[placedIdx];
    st.rack[p.rackIndex].used = false;
    st.placed.splice(placedIdx, 1);
    st.msg = '';
    renderPuzzleBoard();
    puzzleLiveValidate();
    return;
  }
  if (st.selected == null) return;
  const t = st.rack[st.selected]; if (!t || t.used) return;
  t.used = true;
  st.placed.push({ row: r, col: c, letter: t.ch, rackIndex: st.selected });
  st.selected = null;
  st.msg = '';
  renderPuzzleBoard();
  puzzleLiveValidate();
}
// ---------- Daily Puzzle drag-and-drop (v148) ----------
// Mirrors the real game's drag exactly (same pointer handlers, same
// drop rules, same ghost + rack-shift visuals) so the puzzle feels
// identical to real play. The only differences are local-only: the
// puzzle rack is local state, so rack reorders and rack-returns never
// sync to a server (the real game POSTs /shuffle on those). Tap-to-
// place still works: a tap (no movement) on a rack tile selects it,
// and a tap on a board square places / recalls, via the same
// puzzleBoardSelectRack / puzzleBoardTapCell the click handlers used
// — the pointerup handlers below call them, so the delegated rack
// onclick is gone (it would double-toggle after a pointerup tap-
// select) and the board onclick is guarded by suppressNextClick.
// One deliberate difference: drop-cell resolution uses the board
// rect (uniform 10x10 grid, 3px gap) instead of per-cell rects, so
// it stays testable in the harness stub where every element shares
// one rect; in a real browser the two agree to within the 3px gap.
// A render guard (puzzleDragLive) keeps renderPuzzleBoard from
// rebuilding mid-drag and detaching the captured tile, like the
// real game's renderGame.
// A render guard (puzzleDragLive) keeps renderPuzzleBoard from
// rebuilding mid-drag and detaching the captured tile, like the
// real game's renderGame.
function puzzleDropCellForPointer(x, y) {
  const boardEl = $('puzzleBoard'); if (!boardEl) return null;
  const b = boardEl.getBoundingClientRect();
  const TOL = 12;
  if (x < b.left - TOL || x > b.right + TOL || y < b.top - TOL || y > b.bottom + TOL) return null;
  const GAP = 3;
  const cw = (b.width - GAP * 9) / 10, ch = (b.height - GAP * 9) / 10;
  const c = Math.min(9, Math.max(0, Math.floor((x - b.left) / (cw + GAP))));
  const row = Math.min(9, Math.max(0, Math.floor((y - b.top) / (ch + GAP))));
  return { row, col: c };
}
function puzzleIsCellFree(r, c) {
  const st = puzzleBoardState; if (!st) return false;
  return !st.board[r][c] && !st.placed.some(p => p.row === r && p.col === c);
}
function puzzleNearestEmptyCell(r0, c0) {
  // Only an orthogonally adjacent empty cell counts (same fixed
  // order as the real game: up, down, left, right). If none is free,
  // the drop cancels instead of jumping away.
  const neighbours = [[r0 - 1, c0], [r0 + 1, c0], [r0, c0 - 1], [r0, c0 + 1]];
  for (const [r, c] of neighbours) {
    if (r >= 0 && r < 10 && c >= 0 && c < 10 && puzzleIsCellFree(r, c)) return { row: r, col: c };
  }
  return null;
}
function puzzleClearDropHighlights() {
  document.querySelectorAll('#puzzleBoard .cell.drop-target').forEach(el => el.classList.remove('drop-target'));
}
function puzzleClearRackShift() {
  const rackEl = $('puzzleRack'); if (!rackEl) return;
  rackEl.querySelectorAll('.tile').forEach(t => { t.style.transform = ''; t.style.zIndex = ''; });
}
function puzzleApplyRackShift(dragIdx, hoverIdx) {
  // Same slide as the real game: neighbours between the dragged slot
  // and the hovered slot translate by exactly one slot width, without
  // moving any DOM node (moving a node mid-drag can strand pointer
  // capture on iOS). Uses the rack's real slot width, not a constant.
  const rackEl = $('puzzleRack'); if (!rackEl) return;
  const slot = rackEl.getBoundingClientRect().width / 6;
  [...rackEl.querySelectorAll('.tile')].forEach((t, ti) => {
    let shift = 0;
    if (ti !== dragIdx) {
      if (dragIdx < hoverIdx && ti > dragIdx && ti <= hoverIdx) shift = -slot;
      else if (dragIdx > hoverIdx && ti < dragIdx && ti >= hoverIdx) shift = slot;
    }
    t.style.transform = shift ? `translateX(${shift}px)` : '';
    t.style.zIndex = shift ? '2' : '';
  });
}
function puzzleRecallPlaced(p) {
  const st = puzzleBoardState; if (!st) return;
  const i = st.placed.indexOf(p); if (i === -1) return;
  st.rack[p.rackIndex].used = false;
  st.placed.splice(i, 1);
  st.msg = '';
  renderPuzzleBoard();
  puzzleLiveValidate();
}
// ---------- Daily Puzzle live validation + point bubble (v149, v150) ----------
// Mirrors the game's updateStatus / showBubble exactly: the placed
// word is validated live as tiles move, an invalid word names itself
// ("___ is not a word", the game's exact wording), and a valid word
// shows the point bubble on the last cell of the main word. There is
// no Check button any more — the evaluation runs automatically when
// a placement completes.
// v191: ANY valid word counts — the day is played on the first
// valid word, and the best score is the chase; the optimal is no
// longer a gate. Hitting the optimal is still the ceiling:
// "That's it!" reads when the word on the board IS the optimal.
// v150: the status line only ever says one of three things.
// "That's it!" when the placed word hits the optimal; the invalid /
// disconnected message when a bad word is placed (st.msg holds only
// those); "Find the best move." otherwise — at the start, when
// nothing is placed, or when a valid word isn't the best move.
// The colour is the real game's status colour (the default #e8ecf1):
// no green/red good/bad classes any more.
function puzzleUpdateStatusEl() {
  const st = puzzleBoardState; if (!st) return;
  const status = $('puzzleBoardStatus');
  if (!status) return;
  const hitOptimal = st.lastScore != null && st.lastScore >= st.puzzle.optimalScore;
  status.textContent = hitOptimal ? "That's it!" : (st.msg || 'Find the best move.');
  status.className = 'status puzzle-status';
}
// v150: the strength bar tracks the currently placed word and moves
// the moment a tile lands (no commit delay). Called from
// puzzleLiveValidate on every placement and from renderPuzzleBoard.
function puzzleUpdateStrengthBar() {
  const st = puzzleBoardState; if (!st) return;
  const fill = $('puzzleStrengthFill'), knob = $('puzzleStrengthPct');
  // v154: the dial shows at all times — no "Move strength x%" text,
  // and nothing is hidden when the placement is invalid or empty.
  // The percentage rides in a white oval at the end of the coloured
  // fill; the knob is clamped to the track ends so it never hangs off
  // the left edge at 0% or the right edge at 100%. v161: the oval is
  // 44px wide, so the clamp is its half-width (22px, was 15px for
  // the 30px circle).
  const p = st.lastPct == null ? 0 : st.lastPct;
  if (fill) fill.style.width = Math.min(100, p) + '%';
  if (knob) {
    knob.textContent = Math.round(p) + '%';
    knob.style.left = 'clamp(22px, ' + Math.min(100, p) + '%, calc(100% - 22px))';
  }
}
function puzzleHideBubble() { document.querySelectorAll('#puzzleBoard .play-bubble').forEach(e => { if (e.parentElement) e.parentElement.style.zIndex = ''; e.remove(); }); }
function puzzleShowBubble(score, mainCells) {
  puzzleHideBubble();
  const st = puzzleBoardState; if (!st || !st.placed.length) return;
  // Bubble goes over the positionally last letter of the word string,
  // not the last tile the player happened to drop (same as the game).
  let target = null;
  if (mainCells && mainCells.length) target = mainCells[mainCells.length - 1];
  else {
    const sameRow = st.placed.every(p => p.row === st.placed[0].row);
    const sorted = st.placed.slice().sort((a, b) => sameRow ? a.col - b.col : a.row - b.row);
    target = [sorted[sorted.length - 1].row, sorted[sorted.length - 1].col];
  }
  const cells = document.querySelectorAll('#puzzleBoard .cell');
  const cell = cells[target[0] * 10 + target[1]];
  if (!cell) return;
  const b = document.createElement('div'); b.className = 'play-bubble'; b.textContent = score;
  cell.style.position = 'relative'; cell.style.zIndex = '50'; cell.appendChild(b);
}
// v150: the placed word is evaluated live as tiles move, and placed
// tiles STAY on the board — there is no bounce-back and no commit
// timer any more. A valid word updates the strength bar immediately
// on placement. The player uses Recall (or drags tiles back) to try
// a different word. The status line only ever carries an invalid /
// disconnected message (st.msg) — anything else defaults to "Find
// the best move." in puzzleUpdateStatusEl, and a word that hits the
// optimal reads "That's it!".
function puzzleLiveValidate() {
  const st = puzzleBoardState; if (!st) return;
  if (!st.placed.length) { st.msg = ''; st.lastPct = null; st.lastScore = null; st.bubble = null; puzzleHideBubble(); puzzleUpdateStatusEl(); puzzleUpdateStrengthBar(); return; }
  if (!localEngine) { st.msg = ''; st.bubble = null; puzzleHideBubble(); puzzleUpdateStatusEl(); return; }
  const res = localEngine.validatePlay(st.board, st.puzzle.rack, st.placed.map(p => ({ row: p.row, col: p.col, letter: p.letter })), st.puzzle.premiums, false);
  if (!res.valid) {
    st.bubble = null; puzzleHideBubble();
    // v150: only two invalid messages are ever shown — the invalid
    // word(s), or the disconnected message. Any other engine error
    // falls back to the default status (no fifth message).
    if (res.invalidWords && res.invalidWords.length) st.msg = invalidWordsStatus(res.invalidWords);
    else if (res.error && res.error.toLowerCase().includes('connected')) st.msg = 'All tiles must be connected.';
    else st.msg = '';
    // v152: the strength only shows when all placed tiles form a
    // valid move — an invalid placement clears it instead of
    // leaving a stale percentage up.
    st.lastPct = null; st.lastScore = null;
    puzzleUpdateStrengthBar();
    puzzleUpdateStatusEl();
    return;
  }
  // Valid: the point bubble shows the score, the strength bar moves
  // at once, and the tiles stay on the board.
  st.bubble = { score: res.score, mainCells: res.mainCells };
  st.msg = '';
  st.lastPct = Math.min(100, res.score / st.puzzle.optimalScore * 100);
  st.lastScore = res.score;
  puzzleUpdateStrengthBar();
  puzzleShowBubble(res.score, res.mainCells);
  puzzleUpdateStatusEl();
  // v191: any valid word counts — record the play (streak credit
  // on the first word, best score when it beats the day's best).
  puzzleRecordPlay(res);
}
// v191: record a valid word. The day is played (streak credit),
// the best score updates when this word beats it, Share enables,
// and the home header + week strip refresh. Hitting the optimal
// is the ceiling — confetti, once, when a NEW best reaches it (a
// re-play of an already-maxed day does not rain again). The board
// never locks: renderPuzzleBoard refreshes the buttons, and the
// player keeps chasing a better word.
function puzzleRecordPlay(res) {
  const st = puzzleBoardState; if (!st) return;
  // v195: a past puzzle is practice — playing it never records
  // anything (no streak, no best, no score change).
  if (!st.isToday) return;
  const score = res.score;
  // v195: after the timed window the score is locked — a word played
  // past the timer still counts for the streak (played), but it never
  // moves the best score, never uploads a new best, and never rains
  // confetti. The day's best is the best within the window.
  const locked = !!st.timerDone;
  const prevBest = puzzleBestScores()[st.dateKey];
  const isNewBest = !locked && (prevBest == null || score > prevBest);
  st.played = true;
  if (isNewBest) st.bestScore = score;
  puzzleSavePlay(st.dateKey, st.placed, locked ? undefined : score);
  renderPuzzleBoard(); renderHomeHeader(); renderPuzzleWeekStrip();
  if (isNewBest && score >= st.puzzle.optimalScore) puzzleConfetti();
  // v195: the optimal word ends the timed window early — Share
  // appears at once and the score (100%) locks in.
  if (!locked && score >= st.puzzle.optimalScore) puzzleLockTimer();
}
// v152: confetti rains from the top of the screen on a puzzle solve
// — brand-colour pieces, random sizes and fall speeds, cleaned up
// once the animation ends.
function puzzleConfetti() {
  const box = $('puzzleConfetti'); if (!box) return;
  const colors = ['#03eaff', '#ffd166', '#ff1303', '#ff8d03', '#1cff03', '#ff03ee', '#e8ecf1'];
  box.innerHTML = '';
  box.classList.remove('hidden');
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    const size = 6 + Math.floor(Math.random() * 7);
    p.style.left = (Math.random() * 100) + '%';
    p.style.width = size + 'px';
    p.style.height = (size * 0.6) + 'px';
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = (2.2 + Math.random() * 1.3) + 's';
    p.style.animationDelay = (Math.random() * 0.6) + 's';
    box.appendChild(p);
  }
  setTimeout(() => { box.innerHTML = ''; box.classList.add('hidden'); }, 4200);
}
// v152: the 7-day strip above the puzzle board — today on the right,
// the 6 most recent days to its left. A solid flame for a day the
// puzzle was played, a grey flame for a missed one.
// v191: between the flame and the weekday letter, each played day
// shows its best percentage (best score / that day's optimal) —
// the puzzle is a high-score chase now, not a 100% gate. A pre-v191
// solve reads 100% (see puzzleBestPct). The % needs the day's
// puzzle entry; the cache is warm whenever the strip renders from
// the puzzle screen, and a cold cache re-renders once the file lands.
// v192: an unplayed day reads 0% (flame grey via .missed) —
// every day shows a number now, never a blank.
function renderPuzzleWeekStrip() {
  const strip = $('puzzleWeekStrip'); if (!strip) return;
  const solved = puzzleSolvedDates();
  const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  // v153: the flame is the home page's streak icon (same SVG, same
  // #ff8d03), not the 🔥 emoji — and it sits above its weekday
  // letter now, not below it.
  // v154: 24px (was 18px) — Jeff wants the icons bigger.
  const flameSvg = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" fill="#ff8d03"/></svg>';
  const all = dailyPuzzlesCache;
  strip.innerHTML = '';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    const day = document.createElement('div');
    day.className = 'day' + (i === 0 ? ' today' : '') + (solved.has(key) ? '' : ' missed');
    const letter = document.createElement('span'); letter.className = 'letter'; letter.textContent = letters[d.getDay()];
    const flame = document.createElement('span'); flame.className = 'flame'; flame.innerHTML = flameSvg;
    day.appendChild(flame);
    const pct = solved.has(key) ? (puzzleBestPct(key, all && all[key] ? all[key].optimalScore : null) ?? 100) : 0;
    const p = document.createElement('span'); p.className = 'pct'; p.textContent = pct + '%'; day.appendChild(p);
    day.appendChild(letter); strip.appendChild(day);
  }
  if (!all) loadDailyPuzzles().then(() => { if ($('puzzleWeekStrip')) renderPuzzleWeekStrip(); }).catch(() => {});
  // v195: the strip sets the board's room — refit after it populates.
  // On first open the strip is empty when renderPuzzleBoard fits, so
  // without this the board is ~55px too tall and overlaps the rack.
  puzzleFitBoard();
}
// v152: a Share link (?puzzle=...) opens the daily puzzle once the
// app is up. The param is consumed (cleared from the URL) so a later
// trip home doesn't re-open it.
function maybeOpenPuzzleDeepLink() {
  try {
    const u = new URLSearchParams(window.location.search);
    if (!u.has('puzzle')) return;
    u.delete('puzzle');
    const rest = u.toString();
    history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : ''));
    openDailyPuzzle();
  } catch {}
}
// v187: friend + text-challenge deep links (?friend=<user> and
// ?challenge=<user>), mirroring the puzzle link. The param is
// consumed from the URL so a later trip home does not re-open it,
// and the username is stashed in localStorage when the recipient
// is not signed in yet, or when a game is in progress, so the
// link lands after sign-in / after the game ends instead of being
// lost. The 5-second challenge poll re-checks the stash, and
// showStatWindow does too, so a link deferred by a game lands
// the moment the game ends. The harness vm has no URL global,
// so params are read with a regex on the raw query string (the
// v185 puzzle listener does the same for presence).
function deepLinkParam(name) {
  try {
    const q = (typeof window !== 'undefined' && window.location && window.location.search) || '';
    const m = q.match(new RegExp('[?&]' + name + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
function consumeDeepLinkParam(name) {
  try {
    const q = (typeof window !== 'undefined' && window.location && window.location.search) || '';
    if (!new RegExp('[?&]' + name + '(?:=|&|$)').test(q)) return;
    const rest = q.replace(new RegExp('[?&]' + name + '=[^&]*'), '').replace(/^[?&]/, '');
    const url = window.location.pathname + (rest ? '?' + rest : '');
    // Bare history, like maybeOpenPuzzleDeepLink (the vm exposes
    // it as a global; in the browser it is window.history).
    if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', url);
    else if (window.history && window.history.replaceState) window.history.replaceState(null, '', url);
  } catch {}
}
function maybeOpenFriendDeepLink() {
  try {
    let username = deepLinkParam('friend');
    if (!username) { try { username = localStorage.getItem('duello-pending-friend'); } catch {} }
    if (!username) return;
    consumeDeepLinkParam('friend');
    if (!token) { try { localStorage.setItem('duello-pending-friend', username); } catch {} return; }
    if (game && game.status === 'active') { try { localStorage.setItem('duello-pending-friend', username); } catch {} return; }
    try { localStorage.removeItem('duello-pending-friend'); } catch {}
    processFriendDeepLink(username);
  } catch {}
}
function maybeOpenChallengeDeepLink() {
  try {
    let username = deepLinkParam('challenge');
    if (!username) { try { username = localStorage.getItem('duello-pending-challenge'); } catch {} }
    if (!username) return;
    consumeDeepLinkParam('challenge');
    if (!token) { try { localStorage.setItem('duello-pending-challenge', username); } catch {} return; }
    if (game && game.status === 'active') { try { localStorage.setItem('duello-pending-challenge', username); } catch {} return; }
    if (challengeModalChallenge) { try { localStorage.setItem('duello-pending-challenge', username); } catch {} return; }
    try { localStorage.removeItem('duello-pending-challenge'); } catch {}
    processChallengeDeepLink(username);
  } catch {}
}
// v190: invite deep link (?invite=<inviter>). Tapping it is
// acceptance: the recipient becomes the inviter's friend at
// once, with no accept/decline step. Not signed in yet: stash
// the inviter and show the SIGN-UP screen — after the account
// is created the signup handler re-runs this and the friendship
// lands automatically. In a game: stash and defer to the 5s
// poll, like the friend/challenge links.
function maybeOpenInviteDeepLink() {
  try {
    let username = deepLinkParam('invite');
    if (!username) { try { username = localStorage.getItem('duello-pending-invite'); } catch {} }
    if (!username) return;
    consumeDeepLinkParam('invite');
    if (!token) { try { localStorage.setItem('duello-pending-invite', username); } catch {} try { setAuthMode('signup'); } catch {} return; }
    if (game && game.status === 'active') { try { localStorage.setItem('duello-pending-invite', username); } catch {} return; }
    try { localStorage.removeItem('duello-pending-invite'); } catch {}
    processInviteDeepLink(username);
  } catch {}
}
async function processInviteDeepLink(username) {
  username = String(username || '').trim().toLowerCase();
  if (!username || (me && username === me.username)) { showFriendsTab(); return; }
  try {
    await api('/api/friends/invite-accept', { method: 'POST', body: JSON.stringify({ username }) });
  } catch {
    // Offline or a failed request: keep the link pending so the
    // next poll retries instead of landing on an empty Friends tab.
    try { localStorage.setItem('duello-pending-invite', username); } catch {}
    return;
  }
  await loadServerFriends(true);
  showFriendsTab();
}
async function processFriendDeepLink(username) {
  username = String(username || '').trim().toLowerCase();
  if (!username || (me && username === me.username)) { showFriendsTab(); return; }
  try {
    await api('/api/friends/text-request', { method: 'POST', body: JSON.stringify({ username }) });
  } catch {
    // Offline or a failed request: keep the link pending so the
    // next poll retries instead of landing on an empty Friends tab.
    try { localStorage.setItem('duello-pending-friend', username); } catch {}
    return;
  }
  await loadServerFriends(true);
  showFriendsTab();
}
async function processChallengeDeepLink(username) {
  username = String(username || '').trim().toLowerCase();
  if (!username || (me && username === me.username)) return;
  let sender = null;
  try {
    const d = await api('/api/users/search?q=' + encodeURIComponent(username));
    sender = (d.users || []).find(u => String(u.username || '').toLowerCase() === username) || null;
  } catch {
    // Offline: keep the link pending so the next poll retries.
    try { localStorage.setItem('duello-pending-challenge', username); } catch {}
    return;
  }
  if (!sender) return;
  showTextChallengeModal(sender);
}
function showTextChallengeModal(sender) {
  // The sender's profile for the challenge window: the same
  // accept/decline window as a live challenge, but there is no
  // server challenge row yet — accepting creates the friendship
  // AND the game in one step (POST /api/challenges/text-accept),
  // declining creates nothing and adds no friend.
  const c = { textChallenge: true, id: null, from: { id: sender.id || null, username: sender.username, firstName: sender.firstName || sender.first_name || '', lastName: sender.lastName || sender.last_name || '', elo: sender.elo, photoData: sender.photoData || sender.photo_data || null } };
  showChallengeModal(c);
}
function enablePuzzleRackDrag(el, idx) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, captureId = null;
  const cleanup = () => {
    dragging = false; puzzleDragLive = false; el.style.opacity = '';
    $('dragGhost').classList.add('hidden');
    puzzleClearDropHighlights(); puzzleClearRackShift();
    if (captureId !== null) { try { el.releasePointerCapture(captureId); } catch {} captureId = null; }
    clearDragCleanup(cleanup);
  };
  el.addEventListener('pointerdown', e => {
    const st = puzzleBoardState; if (!st) return;
    const t = st.rack[idx]; if (!t || t.used) return;
    cleanupStuckDrag();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null; captureId = e.pointerId;
    puzzleDragLive = true;
    registerDragCleanup(cleanup);
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (e.buttons === 0) { cleanup(); return; }
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
    if (!moved) return;
    suppressNextClick = true;
    const st = puzzleBoardState; if (!st) return;
    // The tile leaves the rack: hide it while the ghost is up, so it
    // looks like you are dragging that same tile (same as the game).
    el.style.opacity = '0';
    showGhost(st.rack[idx].ch, e.clientX, e.clientY);
    puzzleClearDropHighlights();
    const hit = puzzleDropCellForPointer(e.clientX, e.clientY);
    if (hit) {
      puzzleClearRackShift();
      // Snaps to the cell under the pointer if free; if dragged over
      // a placed tile, snaps to the nearest available space.
      const target = puzzleIsCellFree(hit.row, hit.col) ? hit : puzzleNearestEmptyCell(hit.row, hit.col);
      if (target) {
        drop = { kind: 'board', row: target.row, col: target.col };
        const cells = document.querySelectorAll('#puzzleBoard .cell');
        if (cells[target.row * 10 + target.col]) cells[target.row * 10 + target.col].classList.add('drop-target');
      } else drop = null;
      return;
    }
    const rackEl = $('puzzleRack');
    if (rackEl) {
      const rect = rackEl.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) {
        const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
        drop = { kind: 'rack', hoverIdx: Math.max(0, Math.min(5, Math.floor(rel * 6))) };
        puzzleApplyRackShift(idx, drop.hoverIdx);
        return;
      }
    }
    drop = null; puzzleClearRackShift();
  });
  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    const myDrop = drop, wasMoved = moved;
    cleanup();
    // Backstop: the click that follows a drag is suppressed by
    // suppressNextClick, but if it never fires (the drop re-rendered
    // the tile away) the flag must not stick and eat the next tap.
    setTimeout(() => { suppressNextClick = false; }, 150);
    const st = puzzleBoardState; if (!st) return;
    if (!wasMoved) { puzzleBoardSelectRack(idx); return; }
    if (myDrop && myDrop.kind === 'board') {
      const t = st.rack[idx]; if (!t || t.used) return;
      t.used = true;
      st.placed.push({ row: myDrop.row, col: myDrop.col, letter: t.ch, rackIndex: idx });
      st.selected = null; st.msg = '';
      renderPuzzleBoard();
      puzzleLiveValidate();
      return;
    }
    if (myDrop && myDrop.kind === 'rack' && myDrop.hoverIdx !== idx) {
      // Reorder the rack (local only — no server sync). Resolve each
      // placed tile to its rack tile object BEFORE the reorder, so
      // rackIndex follows the tile even when letters repeat.
      const placedTiles = st.placed.map(p => ({ p, tile: st.rack[p.rackIndex] }));
      const [movedTile] = st.rack.splice(idx, 1);
      st.rack.splice(myDrop.hoverIdx, 0, movedTile);
      for (const { p, tile } of placedTiles) p.rackIndex = st.rack.indexOf(tile);
      renderPuzzleBoard();
      return;
    }
    // Dropped elsewhere: cancel, keep the tile where it was.
  });
  el.addEventListener('pointercancel', () => cleanup());
  el.addEventListener('lostpointercapture', () => cleanup());
}
function enablePuzzlePlacedDrag(el, p) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, captureId = null, rackSlotEl = null;
  const clearRackSlot = () => { if (rackSlotEl) { rackSlotEl.style.outline = ''; rackSlotEl = null; } };
  const cleanup = () => {
    dragging = false; puzzleDragLive = false; el.style.opacity = '';
    $('dragGhost').classList.add('hidden');
    puzzleClearDropHighlights(); clearRackSlot(); puzzleClearRackShift();
    if (captureId !== null) { try { el.releasePointerCapture(captureId); } catch {} captureId = null; }
    clearDragCleanup(cleanup);
  };
  el.addEventListener('pointerdown', e => {
    const st = puzzleBoardState; if (!st) return;
    cleanupStuckDrag();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null; captureId = e.pointerId;
    puzzleDragLive = true;
    registerDragCleanup(cleanup);
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (e.buttons === 0) { cleanup(); return; }
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
    if (!moved) return;
    suppressNextClick = true;
    const st = puzzleBoardState; if (!st) return;
    el.style.opacity = '0';
    showGhost(p.letter, e.clientX, e.clientY);
    puzzleClearDropHighlights(); clearRackSlot(); puzzleClearRackShift();
    const hit = puzzleDropCellForPointer(e.clientX, e.clientY);
    if (!hit) {
      // Not over the board: check the rack. An empty slot highlights
      // (open mode: the tile goes back in that slot, no other tile
      // moves); an occupied tile shifts to show the insert point.
      // Open vs insert comes from the rack state — a used slot
      // renders as the empty placeholder — so no DOM class read is
      // needed, and the highlight is found by querySelectorAll.
      const rackEl = $('puzzleRack');
      if (rackEl) {
        const rect = rackEl.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) {
          const slot = Math.max(0, Math.min(5, Math.floor((e.clientX - rect.left) / Math.max(1, rect.width) * 6)));
          const slotTile = st.rack[slot];
          if (slotTile && slotTile.used) {
            drop = { kind: 'rack', slot, mode: 'open' };
            const slotEl = rackEl.querySelectorAll('.tile')[slot];
            if (slotEl) { rackSlotEl = slotEl; slotEl.style.outline = '2px solid #ffd166'; }
            return;
          }
          if (slotTile) {
            drop = { kind: 'rack', slot, mode: 'insert' }; puzzleApplyRackShift(p.rackIndex, slot); return;
          }
        }
      }
      drop = null; return;
    }
    // The tile's own cell is placed, not free, so nearestEmptyCell
    // snaps to a *different* free cell, never back onto itself.
    const target = puzzleIsCellFree(hit.row, hit.col) ? hit : puzzleNearestEmptyCell(hit.row, hit.col);
    if (target && !(target.row === p.row && target.col === p.col)) {
      drop = { row: target.row, col: target.col };
      const cells = document.querySelectorAll('#puzzleBoard .cell');
      if (cells[target.row * 10 + target.col]) cells[target.row * 10 + target.col].classList.add('drop-target');
    } else drop = null;
  });
  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    const myDrop = drop, wasMoved = moved;
    cleanup();
    setTimeout(() => { suppressNextClick = false; }, 150);
    const st = puzzleBoardState; if (!st) return;
    if (!wasMoved) { puzzleRecallPlaced(p); return; }
    if (myDrop && myDrop.kind === 'rack') {
      const orig = p.rackIndex, target = myDrop.slot;
      if (target === orig) { puzzleRecallPlaced(p); return; }
      if (myDrop.mode === 'open') {
        // Open slot: swap with the placed tile that owns that slot.
        // The rack tiles themselves do not move — only the two
        // spacers swap, so the returned tile lands in the open slot
        // and the other placed tile's spacer takes the old slot.
        const owner = st.placed.find(q => q !== p && q.rackIndex === target);
        if (!owner) { puzzleRecallPlaced(p); return; }
        const tileObj = st.rack[orig];
        [st.rack[orig], st.rack[target]] = [st.rack[target], st.rack[orig]];
        owner.rackIndex = orig;
        tileObj.used = false;
        st.placed.splice(st.placed.indexOf(p), 1);
        st.msg = '';
        renderPuzzleBoard();
        puzzleLiveValidate();
        return;
      }
      // Occupied deck tile: insert like a rack reorder — the tile
      // moves to the hovered slot and the tiles between shift by one.
      const tileObj = st.rack[orig];
      st.rack.splice(orig, 1); st.rack.splice(target, 0, tileObj);
      for (const q of st.placed) {
        if (q === p) continue;
        if (orig < target && q.rackIndex > orig && q.rackIndex <= target) q.rackIndex--;
        else if (orig > target && q.rackIndex < orig && q.rackIndex >= target) q.rackIndex++;
      }
      tileObj.used = false;
      st.placed.splice(st.placed.indexOf(p), 1);
      st.msg = '';
      renderPuzzleBoard();
      puzzleLiveValidate();
      return;
    }
    if (myDrop) { p.row = myDrop.row; p.col = myDrop.col; st.msg = ''; renderPuzzleBoard(); puzzleLiveValidate(); }
  });
  el.addEventListener('pointercancel', () => cleanup());
  el.addEventListener('lostpointercapture', () => cleanup());
}
// v149: Recall sends every placed tile back to the rack (the game's
// Recall button). There is no Check button any more — the word is
// evaluated live as tiles move (puzzleLiveValidate).
function puzzleBoardRecall() {
  const st = puzzleBoardState; if (!st) return;
  for (const p of st.placed) st.rack[p.rackIndex].used = false;
  st.placed = []; st.selected = null; st.msg = '';
  renderPuzzleBoard();
  puzzleLiveValidate();
}
function puzzleBoardShuffle() {
  const st = puzzleBoardState; if (!st) return;
  // Shuffle the rack (local only — no server sync). Resolve each
  // placed tile to its rack tile object BEFORE the shuffle, so
  // rackIndex follows the tile even when letters repeat.
  const placedTiles = st.placed.map(p => ({ p, tile: st.rack[p.rackIndex] }));
  for (let i = st.rack.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [st.rack[i], st.rack[j]] = [st.rack[j], st.rack[i]];
  }
  for (const { p, tile } of placedTiles) p.rackIndex = st.rack.indexOf(tile);
  st.selected = null;
  renderPuzzleBoard();
}
// v153: a played puzzle reopens with the best word on the board.
// The stored move ([{row, col, letter}]) is matched back onto the
// rack (each letter takes an unused rack tile); the point bubble
// goes back on the word too. Returns the word's cells (for the
// bubble) or null when there is no stored move that fits. A move
// that does not fit the rack is ignored, never fatal — the rack is
// only touched once the whole move has been matched.
function puzzleRestoreBestMove(st) {
  if (!st || !st.played) return null;
  const move = puzzleSolvedMoves()[st.dateKey];
  if (!Array.isArray(move) || !move.length) return null;
  const taken = new Set();
  const placed = [];
  for (const p of move) {
    if (!p || !Number.isInteger(p.row) || !Number.isInteger(p.col) || typeof p.letter !== 'string') return null;
    const idx = st.rack.findIndex((t, i) => !taken.has(i) && !t.used && t.ch === p.letter);
    if (idx === -1) return null;
    taken.add(idx);
    placed.push({ row: p.row, col: p.col, letter: p.letter, rackIndex: idx });
  }
  if (!placed.length) return null;
  for (const p of placed) st.rack[p.rackIndex].used = true;
  st.placed = placed;
  const sameRow = placed.every(p => p.row === placed[0].row);
  const sorted = placed.slice().sort((a, b) => sameRow ? a.col - b.col : a.row - b.row);
  return sorted.map(p => [p.row, p.col]);
}
async function openDailyPuzzle(dateKey) {
  show('puzzleBoardScreen');
  const status = $('puzzleBoardStatus');
  // v150: while loading, the status shows the start-of-game default
  // (the status line only ever says one of the four puzzle messages).
  if (status) { status.textContent = 'Find the best move.'; status.className = 'status puzzle-status'; }
  const [all, words] = await Promise.all([loadDailyPuzzles(), ensureLocalWords()]);
  // v195: no dateKey = today's puzzle (the entry dailyPuzzleEntry
  // picks — today, or the latest in the file when today has none).
  // A dateKey opens a past puzzle from the log, which is practice:
  // no timer, no Share, no recording.
  const entry = dateKey ? (all && all[dateKey] ? { dateKey, puzzle: all[dateKey] } : null) : dailyPuzzleEntry(all);
  if (!entry || !words || !localEngine) {
    puzzleBoardState = null;
    if (status) { status.textContent = !entry ? 'No puzzle loaded yet — check your connection and try again.' : 'Words still loading — check your connection and try again.'; status.className = 'status puzzle-status'; }
    return;
  }
  const dateEl = $('puzzleBoardDate');
  if (dateEl) {
    const [y, m, d] = entry.dateKey.split('-').map(Number);
    dateEl.textContent = new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }
  const played = puzzleSolvedDates().has(entry.dateKey);
  const isToday = !dateKey;
  puzzleBoardState = {
    entry, dateKey: entry.dateKey, puzzle: entry.puzzle, board: puzzleBoardBase(entry),
    rack: entry.puzzle.rack.map(ch => ({ ch, used: false })),
    placed: [], selected: null, played, msg: '',
    lastPct: null, lastScore: null, bubble: null,
    bestScore: null, isToday, timerDone: !isToday, lockedPct: null,
  };
  // v195: today's puzzle runs the 2-minute timed window from its
  // first open (wall-clock — the start is persisted, so leaving or
  // closing never pauses it). A window that already ran out locks
  // the score the moment the puzzle opens.
  if (isToday) {
    puzzleTimerStartMs(entry.dateKey);
    if (puzzleTimerRemainingMs(entry.dateKey) <= 0) {
      puzzleBoardState.timerDone = true;
      const pct = puzzleBestPct(entry.dateKey, entry.puzzle.optimalScore);
      puzzleBoardState.lockedPct = pct == null ? 0 : pct;
    }
  }
  // v191: a played puzzle reopens with the best word on the board
  // and the bar at the best % (not 100% unless the best IS the
  // optimal). The status reads "That's it!" only when the best
  // word hit the optimal (puzzleUpdateStatusEl reads lastScore).
  let bestCells = null;
  if (played) {
    const best = puzzleBestScores()[entry.dateKey];
    // A pre-v191 solve has no recorded best — it solved at the
    // optimal or better, so the bar and bubble read the optimal.
    puzzleBoardState.bestScore = best != null ? best : entry.puzzle.optimalScore;
    puzzleBoardState.lastScore = puzzleBoardState.bestScore;
    puzzleBoardState.lastPct = puzzleBestPct(entry.dateKey, entry.puzzle.optimalScore);
    bestCells = puzzleRestoreBestMove(puzzleBoardState);
  }
  renderPuzzleBoard();
  if (bestCells) puzzleShowBubble(puzzleBoardState.bestScore, bestCells);
  renderPuzzleWeekStrip();
  // v195: start the 1s timer tick while today's window is running.
  // A past puzzle has no timer; an already-expired window locks on
  // open (above) and needs no tick.
  if (isToday && !puzzleBoardState.timerDone) puzzleStartTimerInterval();
  else puzzleClearTimerInterval();
  // The played-state sync runs in the background (v148): it was
  // already warmed by the preload, and blocking the board on a fresh
  // fetch is what made the first tap wait. If the sync finds the
  // server disagrees with the local played state (played on another
  // device), show the server's state in place.
  puzzleSyncFromServer().then(ok => {
    if (!ok || !puzzleBoardState || puzzleBoardState.dateKey !== entry.dateKey) return;
    const nowPlayed = puzzleSolvedDates().has(entry.dateKey);
    if (nowPlayed !== puzzleBoardState.played) {
      puzzleBoardState.played = nowPlayed;
      if (nowPlayed) {
        const best = puzzleBestScores()[entry.dateKey];
        puzzleBoardState.bestScore = best != null ? best : entry.puzzle.optimalScore;
        puzzleBoardState.lastScore = puzzleBoardState.bestScore;
        puzzleBoardState.lastPct = puzzleBestPct(entry.dateKey, entry.puzzle.optimalScore);
        // v153: the move came down with the sync — put the word on
        // the board (and its bubble) instead of an empty board.
        const cells = puzzleRestoreBestMove(puzzleBoardState);
        renderPuzzleBoard();
        if (cells) puzzleShowBubble(puzzleBoardState.bestScore, cells);
      } else {
        puzzleBoardState.msg = '';
        puzzleBoardState.lastPct = null;
        renderPuzzleBoard();
      }
      renderHomeHeader(); renderPuzzleWeekStrip();
    }
  }).catch(() => {});
}
function closeDailyPuzzle() { puzzleClearTimerInterval(); show('homeScreen'); }
// v195: the past-puzzle log. After today is solved, the Daily Puzzle
// button opens this list instead of today's board: every puzzle in
// the file up to today, newest first (today at the top), each with
// its recorded score. Tapping one opens it to continue playing.
async function openPuzzleLog() {
  show('puzzleLogScreen');
  renderPuzzleLog();
}
async function renderPuzzleLog() {
  const list = $('puzzleLogList'); if (!list) return;
  const all = await loadDailyPuzzles();
  list.innerHTML = '';
  if (!all) { list.textContent = 'No puzzles loaded yet — check your connection and try again.'; return; }
  const today = localDateKey(new Date());
  const keys = Object.keys(all).filter(k => k <= today).sort().reverse();
  for (const key of keys) {
    const row = document.createElement('button');
    row.className = 'puzzle-log-row';
    const pct = puzzleBestPct(key, all[key].optimalScore);
    const [y, m, d] = key.split('-').map(Number);
    const dateStr = new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const label = document.createElement('span'); label.className = 'puzzle-log-date'; label.textContent = (key === today ? 'Today · ' : '') + dateStr;
    const score = document.createElement('span'); score.className = 'puzzle-log-pct'; score.textContent = (pct == null ? 0 : pct) + '%';
    const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '›';
    row.appendChild(label); row.appendChild(score); row.appendChild(chev);
    // Today is the top row and opens today's puzzle (timer + Share);
    // any other row opens that past puzzle as practice.
    row.onclick = key === today ? () => openDailyPuzzle() : () => openDailyPuzzle(key);
    list.appendChild(row);
  }
}
// v191: Share opens the Messages app with the day's best
// percentage — "I scored ___% on the Duello Daily Puzzle!" —
// plus a link that opens the puzzle in the app (the ?puzzle link
// v195: Share shows only once the timed window is over or the
// optimal word has landed (today's puzzle only), so the guard here
// is belt-and-braces — the button is hidden before that.
// v192: the message text is exactly the sentence; the puzzle link
// rides on its own line below it, still tappable — the deep link
// is not dropped.
function puzzleBoardShare() {
  const st = puzzleBoardState; if (!st || !st.played || !st.isToday) return;
  // v195: Share is gated — the timed window must be over, or the
  // optimal word must have landed. The % is the locked/posted score.
  const hitOptimal = st.lastScore != null && st.lastScore >= st.puzzle.optimalScore;
  if (!st.timerDone && !hitOptimal) return;
  const pct = puzzleBestPct(st.dateKey, st.puzzle.optimalScore);
  if (pct == null) return;
  const msg = 'I scored ' + pct + '% on the Duello Daily Puzzle!\nhttps://duellogame.com/?puzzle=today';
  window.location.href = 'sms:?&body=' + encodeURIComponent(msg);
}
// v187: the profile share card — the image behind a ?friend= link.
// The client renders the sender's own profile card (circular photo,
// name, @handle, Elo and Global Rank, no X) to a 1200x630 canvas
// and uploads the PNG, so the preview is always current. Best
// effort: a failed render or upload still shares the text, and the
// server falls back to the app icon for the preview image. The
// card matches the person modal (dark #262a33 card, 2px #e8ecf1
// border, cyan Arial numbers) at ~2.8x scale.
function drawShareCardSilhouette(ctx, cx, cy, r) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = '#3a3f4b'; ctx.fill();
  ctx.clip();
  ctx.fillStyle = '#b3b2b1';
  ctx.beginPath(); ctx.arc(cx, cy - r * 0.25, r * 0.42, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - r * 0.85, cy + r); ctx.quadraticCurveTo(cx - r * 0.85, cy + r * 0.15, cx, cy + r * 0.15); ctx.quadraticCurveTo(cx + r * 0.85, cy + r * 0.15, cx + r * 0.85, cy + r); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.lineWidth = 5; ctx.strokeStyle = '#03eaff'; ctx.stroke();
}
function drawShareCardStat(ctx, label, value, cx, y) {
  ctx.font = '400 40px Comfortaa, sans-serif';
  const lw = ctx.measureText(label + ' ').width;
  ctx.font = '800 40px Arial, Helvetica, sans-serif';
  const vw = ctx.measureText(value).width;
  const x = cx - (lw + vw) / 2;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '400 40px Comfortaa, sans-serif'; ctx.fillStyle = '#b3b2b1';
  ctx.fillText(label + ' ', x, y);
  ctx.font = '800 40px Arial, Helvetica, sans-serif'; ctx.fillStyle = '#03eaff';
  ctx.fillText(value, x + lw, y);
}
async function myGlobalRank() {
  try {
    if (typeof rankCache !== 'undefined' && rankCache && rankCache.get(me.username) != null) return rankCache.get(me.username);
    const d = await api('/api/users/rank?username=' + encodeURIComponent(me.username));
    if (d && d.rank != null) { try { setRank(me.username, d.rank); } catch {} return d.rank; }
  } catch {}
  try { if (typeof persistedRankCache !== 'undefined' && persistedRankCache && persistedRankCache.get(me.username) != null) return persistedRankCache.get(me.username); } catch {}
  return null;
}
async function drawShareCardCanvas() {
  try {
    if (!me) return null;
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 630;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#1a1d24'; ctx.fillRect(0, 0, 1200, 630);
    const card = { x: 150, y: 30, w: 900, h: 570, r: 44 };
    ctx.beginPath();
    ctx.moveTo(card.x + card.r, card.y);
    ctx.lineTo(card.x + card.w - card.r, card.y);
    ctx.arcTo(card.x + card.w, card.y, card.x + card.w, card.y + card.r, card.r);
    ctx.lineTo(card.x + card.w, card.y + card.h - card.r);
    ctx.arcTo(card.x + card.w, card.y + card.h, card.x + card.w - card.r, card.y + card.h, card.r);
    ctx.lineTo(card.x + card.r, card.y + card.h);
    ctx.arcTo(card.x, card.y + card.h, card.x, card.y + card.h - card.r, card.r);
    ctx.lineTo(card.x, card.y + card.r);
    ctx.arcTo(card.x, card.y, card.x + card.r, card.y, card.r);
    ctx.closePath();
    ctx.fillStyle = '#262a33'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#e8ecf1'; ctx.stroke();
    const photo = usablePhoto(me) ? me.photoData : null;
    if (photo) {
      const img = await new Promise((resolve) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => resolve(null); im.src = photo; });
      if (img) {
        ctx.save();
        ctx.beginPath(); ctx.arc(600, 195, 85, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        ctx.drawImage(img, 515, 110, 170, 170);
        ctx.restore();
      } else drawShareCardSilhouette(ctx, 600, 195, 85);
    } else drawShareCardSilhouette(ctx, 600, 195, 85);
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8ecf1'; ctx.font = '800 58px Comfortaa, sans-serif';
    ctx.fillText(name, 600, 330);
    ctx.fillStyle = '#b3b2b1'; ctx.font = '400 38px Comfortaa, sans-serif';
    ctx.fillText('@' + me.username, 600, 388);
    const elo = (typeof localElo === 'function' ? localElo() : me.elo);
    const rank = await myGlobalRank();
    drawShareCardStat(ctx, 'Elo', String(elo), 600, 462);
    drawShareCardStat(ctx, 'Global Rank', rank == null ? '—' : String(rank), 600, 520);
    return cv;
  } catch { return null; }
}
async function uploadShareCard() {
  try {
    const cv = await drawShareCardCanvas();
    if (!cv || typeof cv.toBlob !== 'function') return false;
    const blob = await new Promise((resolve) => { try { cv.toBlob(resolve, 'image/png'); } catch { resolve(null); } });
    if (!blob) return false;
    await api('/api/share-card', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
    return true;
  } catch { return false; }
}
// v187: the share icon on the Profile tab. The card is rendered
// and uploaded first so the preview in the message shows the
// sender's current Elo and rank; the text goes out either way.
async function shareProfileCard() {
  if (!me) return;
  await uploadShareCard();
  const msg = 'Add me as a friend on Duello⚔️ https://duellogame.com/?friend=' + encodeURIComponent(me.username);
  window.location.href = 'sms:?&body=' + encodeURIComponent(msg);
}
$('profileShareBtn').onclick = shareProfileCard;
function show(id) {
  // Leaving the board closes the live game stream (a new game opens
  // its own in enterGameScreen); the stat window is an overlay on
  // the game screen, so it never closes the stream.
  if (id !== 'gameScreen') closeGameStream();
  // Leaving a matchmaking screen abandons it: a searching or
  // rematch timer must never start a game after the user walked
  // away (tab tap, back navigation) — the timers check their flags,
  // and show() clears them on any navigation away.
  if (id !== 'searchingScreen') cancelSearch();
  if (id !== 'rematchScreen') cancelRematch();
  // v142: puzzleBoardScreen is a full screen like gameScreen — it hides
  // the tab bar (it has its own Exit button) and is not a menu screen.
  ['homeScreen', 'botScreen', 'friendsScreen', 'profileScreen', 'profileEditScreen', 'pastGamesScreen', 'authScreen', 'gameScreen', 'searchingScreen', 'rematchScreen', 'puzzleBoardScreen', 'puzzleLogScreen', 'profileFieldScreen', 'profilePhotoScreen', 'profilePasswordScreen', 'profileProScreen', 'profilePrivacyScreen', 'profilePushScreen'].forEach(s => { const el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
  const isMenu = ['homeScreen', 'botScreen', 'friendsScreen', 'profileScreen', 'profileEditScreen', 'pastGamesScreen', 'puzzleLogScreen'].includes(id);
  // Warm the offline engine when the bot screen opens (v107): the
  // dictionary + solver index build used to run on the first bot tap,
  // so the game took a few seconds to open. Warming here — while the
  // user is still choosing a bot — makes the tap instant. Fire and
  // forget: ensureLocalWords is idempotent and the tap awaits it if
  // it is still in flight.
  if (id === 'botScreen') { try { ensureLocalWords(); } catch {} }
  // v145: no textured background on the game screen — the dot grid
  // hides while the board is open and comes back everywhere else.
  // v145: hide the dot texture on the game screen. v148: same on the
  // Daily Puzzle screen — the puzzle is a board too, and the dots
  // have no business behind it either.
  try { document.body.classList.toggle('game-open', id === 'gameScreen' || id === 'puzzleBoardScreen'); } catch {}
  const tb = $('tabBar'); if (tb) tb.classList.toggle('hidden', !isMenu);
  // v187: the Challenge via Text button lives only on the Friends
  // leaderboard — hide it (and its mask) on every other screen.
  // v191: the fade is gone (Jeff: don't fade the texture around
  // the button) — the textured mask covers the fade band too.
  const ctOn = id === 'friendsScreen' && lbScope === 'friends';
  const ctb = $('challengeTextBtn'); if (ctb) ctb.classList.toggle('hidden', !ctOn);
  const ctm = $('ctMask'); if (ctm) ctm.classList.toggle('hidden', !ctOn);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if ((id === 'homeScreen' || id === 'botScreen') && $('tabHome')) $('tabHome').classList.add('active');
  if (id === 'friendsScreen' && $('tabFriends')) $('tabFriends').classList.add('active');
  if ((id === 'profileScreen' || id === 'profileEditScreen' || id === 'pastGamesScreen') && $('tabProfile')) $('tabProfile').classList.add('active');
  // First Home render warms the Profile + Leaderboard caches (below).
  if (id === 'homeScreen') { preloadHomeTabs(); refreshOnlineButtons(); renderHomeHeader(); }
  // A tab always opens at the top (v124): the window scroll position
  // used to carry over from the tab you came from, so the new tab
  // opened halfway down.
  try { window.scrollTo(0, 0); } catch {}
  const shown = $(id); if (shown) shown.scrollTop = 0;
}
function silhouetteSVG(size) { return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="8" r="4" fill="#b3b2b1"/><path d="M4 21 C4 16 7 13 12 13 C17 13 20 16 20 21 Z" fill="#b3b2b1"/></svg>`; }
function pfpHTML(userLike) {
  if (usablePhoto(userLike)) return `<img src="${userLike.photoData}" alt="">`;
  return silhouetteSVG(36);
}
// A remote photo that never loads would leave a blank grey circle:
// before v5, 10 of the 100 personas carried picsum URLs that timed
// out on some networks (verified Nov 14, 2026). Personas now carry
// embedded data URLs (v5, Nov 23, 2026), so the guard below only
// fires for a future remote URL; the silhouette shows at once
// instead of a blank circle with no border while it stalls. One
// helper for every img-vs-silhouette and no-photo-ring decision, so
// the two can never disagree.
function usablePhoto(userLike) {
  const url = userLike && userLike.photoData;
  return !!url && !url.includes('picsum.photos');
}
// A photo (a data URL for personas and user uploads) that fails
// to load: Safari paints its broken-image "?" inside the
// circle instead of the silhouette. Any failed photo is swapped for
// the inline silhouette, which cannot fail and cannot loop. Capture
// phase: <img> errors do not bubble. Only photos are touched — the
// logo and other images are left alone.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'IMG' || !t.closest) return;
  // v176: .settings-pfp too — the Settings Photo row was the one
  // photo with no failure cover: a transiently failed img sat as an
  // empty dark circle until the next renderEditList, while every
  // other photo swapped to the silhouette.
  const host = t.closest('.pfp, .lb-pfp, .person-pfp, .settings-pfp');
  if (!host) return;
  host.classList.add('no-photo');
  t.outerHTML = silhouetteSVG(32);
}, true);
// A remote photo that stalls never fires 'error', so the circle
// sits empty forever. Personas are embedded data URLs since v5 and
// load instantly, but a slow network can still stall a photo: arm
// a 3s timer on every leaderboard/search photo: if it still
// hasn't loaded, swap it for the silhouette, exactly as the error
// handler does. Photos that loaded (data URLs) are
// complete long before the timer fires and are left alone.
function armPfpTimeouts() {
  document.querySelectorAll('.lb-pfp img').forEach(img => {
    setTimeout(() => {
      if (!img.isConnected) return;
      if (img.complete && img.naturalWidth > 0) return;
      const host = img.closest('.lb-pfp');
      if (host) host.classList.add('no-photo');
      img.outerHTML = silhouetteSVG(32);
    }, 3000);
  });
}

// ---------- First-open intro (v96, v98: plays on every fresh open) ----------
// Black overlay, real logo starts zoomed in 3x, pulls back fast, sits
// 2s, then zooms in fast to reveal Home. Plays on every fresh open
// (v98: the once-per-device flag is gone — close the tab and reopen
// and it plays again); tap the overlay to skip. Behind it, 20
// premium-colour squares flicker on/off across the whole background,
// each jumping to a new grid cell per cycle — never overlapping, never
// in neighbouring cells, same colour kept further apart. WAAPI calls
// are guarded: the client harness runs this file in a vm with no
// Element.animate, and the intro must never kill the boot there (or on
// a browser without WAAPI).
function introCellFree(occupied, col, row, ci) {
  for (let dc = -2; dc <= 2; dc++) {
    for (let dr = -2; dr <= 2; dr++) {
      if (dc === 0 && dr === 0) continue;
      const occ = occupied[(col + dc) + ',' + (row + dr)];
      if (occ === undefined) continue;
      const dist = Math.max(Math.abs(dc), Math.abs(dr));
      if (dist === 1) return false;
      if (dist === 2 && occ === ci) return false;
    }
  }
  return true;
}
function introPlaceCell(el, ci, occupied) {
  if (el._introCell) delete occupied[el._introCell];
  let col = 0, row = 0, key = '0,0', tries = 0;
  do {
    col = Math.floor(Math.random() * 9);
    row = Math.floor(Math.random() * 15);
    key = col + ',' + row;
    tries++;
  } while ((occupied[key] !== undefined || !introCellFree(occupied, col, row, ci)) && tries < 300);
  if (occupied[key] !== undefined || !introCellFree(occupied, col, row, ci)) {
    let found = false;
    for (let t = 0; t < 300 && !found; t++) {
      col = Math.floor(Math.random() * 9);
      row = Math.floor(Math.random() * 15);
      key = col + ',' + row;
      if (occupied[key] === undefined) found = true;
    }
    if (!found) { col = 0; row = 0; key = '0,0'; }
  }
  occupied[key] = ci; el._introCell = key;
  el.style.left = (col * 11.1 + Math.random() * 2.5) + '%';
  el.style.top = (row * 6.67 + Math.random() * 2) + '%';
}
function initIntro() {
  const overlay = $('introOverlay');
  if (!overlay) return;
  const zoom = $('introLogoZoom');
  const flicker = $('introFlicker');
  const COLORS = ['255,19,3', '28,255,3', '255,3,238', '255,141,3'];
  const occupied = {};
  const anims = [];
  let timers = [];
  let started = false;
  if (flicker) {
    for (let k = 0; k < 20; k++) {
      const ci = k % 4;
      const s = document.createElement('div');
      s.className = 'intro-cell';
      s.style.background = 'rgb(' + COLORS[ci] + ')';
      s.style.animationDuration = (2.2 + Math.random() * 2).toFixed(2) + 's';
      s.style.animationDelay = (Math.random() * 2).toFixed(2) + 's';
      s._introCi = ci;
      introPlaceCell(s, ci, occupied);
      s.addEventListener('animationiteration', function () { introPlaceCell(this, this._introCi, occupied); });
      flicker.appendChild(s);
    }
  }
  function finishIntro() {
    started = true; // a late logo load must not restart the intro after a skip
    anims.forEach(a => { try { a.finish(); } catch {} });
    timers.forEach(clearTimeout); timers = [];
    overlay.style.display = 'none';
  }
  function playIntro() {
    // The zoom-out is invisible if the logo image has not painted yet
    // (the logo PNG is 2.6 MB and can still be downloading/decoding
    // when app.js runs), so the zoom-out waits for the logo to load —
    // with a 1.5s backstop so a slow or broken image never stalls the
    // intro. The 2s sit and the zoom-in are timed from the zoom-out,
    // not from page load.
    function startZoomOut() {
      if (started) return; started = true;
      if (zoom && typeof zoom.animate === 'function') {
        anims.push(zoom.animate([{ transform: 'scale(3)' }, { transform: 'scale(1)' }], { duration: 400, easing: 'cubic-bezier(.25,1.3,.35,1)', fill: 'both' }));
      }
      timers.push(setTimeout(() => {
        if (zoom && typeof zoom.animate === 'function') {
          anims.push(zoom.animate([{ transform: 'scale(1)' }, { transform: 'scale(8)' }], { duration: 650, easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' }));
        }
        if (typeof overlay.animate === 'function') {
          anims.push(overlay.animate([{ opacity: 1 }, { opacity: 0 }], { delay: 350, duration: 500, fill: 'forwards' }));
        }
      }, 2400));
      timers.push(setTimeout(finishIntro, 3400));
    }
    const logo = $('introLogo');
    if (logo && logo.complete === false) {
      logo.addEventListener('load', startZoomOut, { once: true });
      logo.addEventListener('error', startZoomOut, { once: true });
      timers.push(setTimeout(startZoomOut, 1500));
    } else {
      startZoomOut();
    }
  }
  overlay.addEventListener('click', finishIntro);
  playIntro();
}
initIntro();
function goTab(id) { show(id); }
$('tabHome').onclick = () => show('homeScreen');

// Profile + Leaderboard load in the background once Home first
// renders, so both tabs are instant when tapped. Idle-scheduled so
// Home stays responsive; the v74 load-once guards (profileData,
// globalRows, serverFriends) still hold, so a later tap never
// refetches — the preload only fills the same caches the tab taps
// fill. Silent on failure: a failed preload leaves the caches empty
// and the tab loads normally on tap. Never fires before the session
// is ready (no token / no user yet): the flag is set when the
// preload is scheduled, so a second Home render inside the idle
// window cannot schedule it twice. A session check runs first,
// because a rejected session inside renderProfileUI would bounce
// the user to sign-in from a background load.
let homeTabsPreloaded = false;
function preloadHomeTabs() {
  if (homeTabsPreloaded || !token || !me) return;
  homeTabsPreloaded = true;
  // Sequential on purpose: loadServerFriends pulls the Global rows
  // in first, so a parallel ensureGlobalRows would see the cache
  // still empty and fetch /api/leaderboard twice.
  const run = async () => {
    // Warm the offline dictionary first (v112): it needs no network,
    // so it must not wait behind the /api/me call below — in airplane
    // mode that call throws and the warm never ran, which is why the
    // first bot tap paid the whole dictionary load.
    try { ensureLocalWords(); } catch {}
    let d = null;
    // A failed /api/me must not kill the whole preload (v118 fix, Nov
    // 17, 2026): the old `catch { return; }` left profileData null and
    // the photo undecided whenever the boot-time fetch hiccuped, and
    // the homeTabsPreloaded latch meant it never retried — so the pic
    // was never preloaded that session. Fall through instead:
    // renderProfileUI retries the fetch and falls back to the cached
    // profile, and the photo warm below uses me when the fetch failed.
    try { d = await api('/api/me'); } catch {}
    try { await renderProfileUI(d); } catch {}
    // Warm the user's photo so it paints instantly when the Profile
    // tab is tapped: an <img> inside a hidden screen is only decoded
    // when the screen shows, so decode it here (during the intro) and
    // the cached image paints at once. This is the same photoData the
    // leaderboard row uses, so it covers that row too.
    try {
      const u = (d && d.user) || me;
      if (u && u.photoData) {
        const im = new Image();
        im.src = u.photoData;
        if (typeof im.decode === 'function') await im.decode();
      }
    } catch {}
    try { await ensureGlobalRows(); } catch {}
    try { await loadServerFriends(); } catch {}
    // Warm the rank cache for friends (v114): their Global Ranks are
    // fetched once here so they are cached for offline, even if the
    // Friends tab is never opened. Already-cached names are skipped;
    // the render-time warm on the tab itself does the same.
    try {
      for (const f of (serverFriends && serverFriends.friends || [])) {
        if (!f || !f.username || rankCache.has(f.username)) continue;
        api('/api/users/rank?username=' + encodeURIComponent(f.username)).then(d => setRank(f.username, d.rank)).catch(() => {});
      }
    } catch {}
    // Warm the Game History filters in the background (v126, v133):
    // the first page (25) of every scope is fetched once here so it
    // is already in hand when Game History opens or a filter tab is
    // tapped — no Loading note, no wait. Fire-and-forget; a failure
    // (offline) just leaves the cache empty and openPastGames /
    // setHistoryScope fetch on tap as before.
    try { warmHistoryScopes(); } catch {}
    // Warm the Daily Puzzle in the background (v148): the first tap
    // used to await the puzzle JSON fetch before the board could
    // render. The JSON is filled here, so the tap renders from
    // prepared data instead. The solved-state sync is NOT warmed
    // here: it POSTs solves for local dates the server lacks, which
    // would fire mid-session and disturb the sync accounting — and
    // the tap does not need it, because openDailyPuzzle now syncs in
    // the background and corrects the board if the server disagrees.
    try { await loadDailyPuzzles(); } catch {}
  };
  // Idle-scheduled (v93): the 2s timeout bounds the wait, and the
  // intro now gives it a 3.4s head start, so the profile is ready
  // (photo decoded, below) before the intro even finishes.
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { run(); }, { timeout: 2000 });
  else setTimeout(() => { run(); }, 500);
}

// ---------- Friends tab ----------
// The Global scope is real registered users, top by Elo, from GET
// /api/leaderboard (guest rows excluded server-side). The Friends
// scope lists accepted friends (no play button on the rows —
// challenging happens from the profile window's Play button).
// Friend requests are real since v53 (GET/POST /api/friends):
// sending one makes it appear at the top of the recipient's
// Friends page, and accepting it makes you friends. Personas
// have no account, so a request to one still lives only in
// localStorage, exactly as before. A challenge to a persona is
// answered by the same simulated accept/decline as a rematch
// request.
let lbScope = 'friends', deleteMode = false;
// Friend whose row is showing the inline "Remove?" button (set
// when the red × is tapped, cleared when it is tapped, when
// delete mode is left, or after the removal runs).
let pendingRemove = null;
let globalRows = null;
// v176: the persona seed version the rows in globalRows belong to
// (null = unknown — e.g. rows restored from a pre-v176 persisted
// cache that recorded no version). The server re-seeds the persona
// roster on deploy, and the rows carry photo data, so rows cached
// before a deploy keep showing the old photos until something
// clears globalRows. The version is what checkPersonasVersion
// compares against the served one.
let globalRowsVersion = null;
// The rendered leaderboard stays loaded for the session: a tab
// tap only shows the screen again instead of blanking and
// rebuilding the list. friendsStale goes true whenever the data
// behind it changes (a forced friends refetch, delete-mode
// toggles, a remove confirm), and friendsRenderedScope tracks
// which scope the DOM currently shows.
let friendsStale = true, friendsRenderedScope = null;
// v190: the signature of the friend data the Friends screen
// currently shows — accepted friends + incoming + outgoing
// usernames, bucketed (the bucket IS the status: the rows carry
// no status field). maybeRefreshFriendsList compares a fresh
// fetch against this and only re-renders when it differs, so a
// request accepted elsewhere appears on this screen within one
// 5s poll cycle without any tap.
let friendsSignature = null;
function friendsListSignature() {
  if (!serverFriends) return '';
  const names = (list) => (list || []).map(u => u.username).sort().join(',');
  return names(serverFriends.friends) + '|' + names(serverFriends.incoming) + '|' + names(serverFriends.outgoing);
}
// Global Ranks already fetched for a profile, by username, so
// opening the same profile again shows the rank at once instead
// of waiting on the fetch. Keyed by the viewed player, not the
// viewer — the rank counts everyone, so it is the same whoever
// looks. Cleared when a game ends, because Elos (and therefore
// ranks) move then.
const rankCache = new Map();
// Persisted ranks (v114): the same ranks, in localStorage, so the
// profile and friends' Global Ranks are available offline. The
// session Map above is still cleared when a game ends (Elos moved,
// so ranks are re-fetched online); the persisted copy is the
// last-known fallback and survives that clear — it is only ever a
// display value, never a substitute for a fresh fetch online.
const persistedRankCache = new Map();
try { const o = JSON.parse(storeGet('duello_rank_cache') || 'null'); if (o && typeof o === 'object') for (const [u, r] of Object.entries(o)) if (typeof r === 'number') persistedRankCache.set(u, r); } catch {}
function persistRankCache() { try { storeSet('duello_rank_cache', JSON.stringify(Object.fromEntries(persistedRankCache))); } catch {} }
function setRank(username, rank) { if (!username || typeof rank !== 'number') return; rankCache.set(username, rank); persistedRankCache.set(username, rank); persistRankCache(); }
// Server-owned friend state for the signed-in account: accepted
// friends, incoming requests, outgoing requests. Cached per
// username, so switching accounts never shows the old account's
// friends or requests.
let serverFriends = null, serverFriendsLoadedFor = null, friendMigrationDone = false;
async function loadServerFriends(force) {
  if (force) friendsStale = true;
  if (serverFriends && !force && serverFriendsLoadedFor === (me && me.username)) return serverFriends;
  await ensureGlobalRows();
  // One-time migration: requests made before v53 lived only in
  // this device's localStorage. Real-player ones move to the
  // server (so the other person finally sees them); a request to
  // yourself — the @neo -> @ceo self-friend bug, caused by
  // localStorage being shared by every account on one phone —
  // is dropped, and persona requests stay local.
  if (!friendMigrationDone) {
    friendMigrationDone = true;
    const stored = getFriendRequests(), keep = [];
    for (const u of stored) {
      const row = (globalRows || []).find(x => x.username === u);
      if (row && !row.isPersona && u !== (me && me.username)) {
        try { await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ username: u }) }); } catch {}
      } else if (!row || row.isPersona) keep.push(u);
    }
    try { localStorage.setItem('duello_friend_requests', JSON.stringify(keep)); } catch {}
  }
  try { const d = await api('/api/friends'); serverFriends = d; serverFriendsLoadedFor = me && me.username; serverFriendsFromCache = false; cacheServerFriends(d); }
  catch (err) {
    deadSession(err);
    // Offline (v107): fall back to the last-known friends instead of
    // an empty list, so the Friends leaderboard renders offline.
    const cached = loadCachedServerFriends();
    serverFriends = cached || { friends: [], incoming: [], outgoing: [] };
    serverFriendsFromCache = !!cached;
  }
  return serverFriends;
}
// v190: live Friends list. The 5s challenge poll (and a
// foreground return) call this: refetch the server friend state
// and re-render ONLY when it actually changed. Never while the
// screen isn't showing, never in delete mode (a rebuild would
// clobber a pending remove), and never when the data is the
// same — a no-op leaves the DOM (and the scroll position) alone.
async function maybeRefreshFriendsList() {
  if (!token) return;
  if (deleteMode) return;
  if (lbScope !== 'friends') return;
  const el = $('friendsScreen');
  if (!el || el.classList.contains('hidden')) return;
  try { await loadServerFriends(true); } catch { return; }
  if (friendsListSignature() === friendsSignature) { friendsStale = false; return; }
  friendsStale = true;
  renderFriendsUI();
}
function isRealFriend(username) { return (serverFriends && serverFriends.friends || []).some(u => u.username === username); }
function isRealRequested(username) { return (serverFriends && serverFriends.outgoing || []).some(u => u.username === username); }
// Requests to a persona are local-only (personas have no account
// to receive one): the username persists in localStorage so the
// row stays Requested across loads. Tapping Requested again
// unrequests: the toggle removes the name and the button goes
// back to the add icon. Requests to a real player go to the
// server instead — see loadServerFriends above.
// The button is an SVG icon, not text or emoji: a person
// silhouette with a plus for Add, and a sent paper airplane once
// the request is sent. Both draw in currentColor at 24px inside
// the 36px button, and both are grey: the shape, not the color,
// tells the two states apart.
function friendAddSVG() {
  return `<svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true"><circle cx="11" cy="8" r="4" fill="currentColor"/><path d="M3 22 C3 17 6.5 14.5 11 14.5 C15.5 14.5 19 17 19 22 Z" fill="currentColor"/><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 15 V25"/><path d="M16 20 H26"/></g></svg>`;
}
function friendSentSVG() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/></svg>`;
}
// The sent state is small grey text plus the small plane, not just
// an icon: `sent` + plane. Used on Global rows and in the stat
// window, so both stay identical.
function friendSentHTML() {
  return `<span class="sent-text">sent</span>${friendSentSVG()}`;
}
function playSVG() {
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
}
function getFriendRequests() {
  try { const v = JSON.parse(localStorage.getItem('duello_friend_requests') || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function markFriendRequested(username) {
  try {
    const v = getFriendRequests();
    if (!v.includes(username)) { v.push(username); localStorage.setItem('duello_friend_requests', JSON.stringify(v)); }
  } catch {}
}
function unrequestFriend(username) {
  try {
    const v = getFriendRequests().filter(u => u !== username);
    localStorage.setItem('duello_friend_requests', JSON.stringify(v));
  } catch {}
}
async function ensureGlobalRows() {
  if (!globalRows) {
    try { const d = await api('/api/leaderboard'); globalRows = d.users || []; globalRowsVersion = (d && typeof d.personasVersion === 'number') ? d.personasVersion : null; globalRowsFromCache = false; cacheGlobalRows(globalRows, globalRowsVersion); }
    catch (err) {
      deadSession(err);
      // Offline (v107): fall back to the last-known rows instead of
      // an empty list, so the leaderboard renders offline. The
      // persisted entry also carries the version its rows belong
      // to (v176), so a later version check can tell they predate
      // a deploy even though they came from disk, not the network.
      const cached = loadCachedGlobalRows();
      globalRows = (cached && cached.users) || []; globalRowsVersion = (cached && typeof cached.personasVersion === 'number') ? cached.personasVersion : null; globalRowsFromCache = !!cached;
    }
    // Cache every row's Global Rank (v114): the leaderboard is the
    // one place the server hands out true ranks for everyone at
    // once, so this covers me and every friend on it, for offline.
    for (const u of globalRows) if (u && u.username && typeof u.rank === 'number') setRank(u.username, u.rank);
  }
  return globalRows;
}
// v176: the roster-version check. ensureGlobalRows only fetches
// when globalRows is null, so rows cached before a deploy keep
// showing the old persona photos indefinitely — on iOS the JS
// session stays resident for hours, and only a finished game
// cleared the rows. The profile window renders from the same rows
// (openPersonModal takes the row object), so it went stale the
// same way; fixing the rows fixes the modal too. The check is one
// tiny query server-side (GET /api/personas-version, no photos),
// so it runs on every foreground return and every Friends-tab
// visit, and only a real version change triggers a full refetch —
// the old rows stay on screen until the new ones arrive, so there
// is no blanking and no loading flicker. Offline it is a no-op:
// an unreachable check (or a failed one) keeps the last-known
// rows exactly as today, never blanks the board.
let personasVersionCheckInFlight = null;
async function checkPersonasVersion() {
  if (!token || !me) return false;
  if (isOffline()) return false;
  if (personasVersionCheckInFlight) return personasVersionCheckInFlight;
  const p = (async () => {
    let served = null;
    try { const d = await api('/api/personas-version'); served = (d && typeof d.personasVersion === 'number') ? d.personasVersion : null; }
    catch (err) { return false; } // unreachable: keep last-known rows
    if (served == null) return false;
    if (!globalRows) { globalRowsVersion = served; return false; }
    if (globalRowsVersion == null) {
      // Rows of unknown vintage (e.g. restored from a pre-v176
      // persisted cache that recorded no version): refetch once so
      // the stored version is real instead of adopting the served
      // one over rows that may predate it.
      globalRows = null; globalRowsVersion = null; friendsStale = true;
      try { await ensureGlobalRows(); } catch {}
      if (!$('friendsScreen').classList.contains('hidden')) { try { await renderFriendsUI(); } catch {} }
      return true;
    }
    if (served !== globalRowsVersion) {
      // The roster changed under us: drop the stale rows and
      // refetch. The check above already succeeded, so we are
      // online; a failed refetch falls back to the persisted
      // cache inside ensureGlobalRows, never to a blank board.
      globalRows = null; globalRowsVersion = null; friendsStale = true;
      try { await ensureGlobalRows(); } catch {}
      if (!$('friendsScreen').classList.contains('hidden')) { try { await renderFriendsUI(); } catch {} }
      return true;
    }
    return false;
  })();
  personasVersionCheckInFlight = p;
  try { return await p; } finally { personasVersionCheckInFlight = null; }
}

// ---------- Offline caches: leaderboards + profile (v107) ----------
// The last-known leaderboard / friends / profile payloads, persisted
// when online so the screens render offline instead of going blank.
// Each entry is {…, savedAt}. Cached data renders with no marker:
// the "last known" notes were removed in v114 — the screens just
// show the last-known data as-is.
function cacheGlobalRows(users, version) {
  try { storeSet('duello_lb_global', JSON.stringify({ users, personasVersion: (typeof version === 'number' ? version : null), savedAt: new Date().toISOString() })); } catch {}
}
function loadCachedGlobalRows() {
  try { const o = JSON.parse(storeGet('duello_lb_global') || 'null'); return (o && Array.isArray(o.users)) ? o : null; } catch { return null; }
}
function cacheServerFriends(d) {
  try { storeSet('duello_friends', JSON.stringify({ friends: d.friends || [], incoming: d.incoming || [], outgoing: d.outgoing || [], savedAt: new Date().toISOString() })); } catch {}
}
function loadCachedServerFriends() {
  try { const o = JSON.parse(storeGet('duello_friends') || 'null'); return (o && Array.isArray(o.friends)) ? o : null; } catch { return null; }
}
function cacheProfileData(d) {
  try { storeSet('duello_profile', JSON.stringify({ data: d, savedAt: new Date().toISOString() })); } catch {}
}
function loadCachedProfileData() {
  try { const o = JSON.parse(storeGet('duello_profile') || 'null'); return (o && o.data && o.data.user) ? o.data : null; } catch { return null; }
}
// True when the leaderboard data in memory came from the persistent
// cache (the network fetch failed and we fell back to it).
let globalRowsFromCache = false, serverFriendsFromCache = false;
// One row shape for every leaderboard-style list (Global, Friends,
// search results): rank | pfp | name over username | Elo | action.
// The action depends on the list: Global and search show nothing
// there except the YOU badge on your own row — friends are added
// only from the profile window now. Friends shows a play icon that
// challenges that friend.
function lbRowHTML(r, actionHTML, opts) {
  // Search results show no rank at all (hideRank): the rank span
  // is left out and the row uses the no-rank grid, so nothing
  // shifts — pfp, name, action and Elo keep their columns.
  const rank = opts && opts.hideRank ? '' : `<span class="rank${(r.rank || 0) >= 100 ? ' small' : ''}">${r.rank ?? ''}</span>`;
  return `${rank}<span class="lb-pfp${usablePhoto(r) ? '' : ' no-photo'}">${pfpHTML(r)}</span><span class="lb-identity"><div class="lb-name">${shortName(r)}</div><div class="lb-user">@${r.username}</div></span>${actionHTML}<span class="lb-elo">${r.elo}</span>`;
}
function youBadgeHTML(r) {
  return r.isYou ? '<span class="lb-action"><span class="you-badge">YOU</span></span>' : '';
}
function playActionHTML(r) {
  return `<button class="lb-play" aria-label="Challenge ${r.name} to a game">${playSVG()}</button>`;
}
// Person profile window: tapping a name (Global, search, stat
// window) opens their profile — photo, name, username, Elo — with
// an add-friend button that toggles the same localStorage request
// as the row buttons. Your own profile has no button. Closing
// re-renders the lists behind it so a toggled request shows up
// everywhere at once.
let modalPerson = null;
function isModalFriend() {
  if (!modalPerson) return false;
  // Accepted friends only. A requested persona is not a friend:
  // personas never accept, so their button stays "sent" forever
  // instead of flipping to Play the moment you request them
  // (the old version counted a request as friendship here).
  return !modalPerson.isPersona && isRealFriend(modalPerson.username);
}
function renderPersonAddBtn() {
  const btn = $('personAddBtn');
  if (!modalPerson) return;
  btn.disabled = false;
  // A friend's profile shows Play, not Add Friend / Friends:
  // tapping it challenges them, same as the play icon on the
  // Friends list.
  if (isModalFriend()) {
    btn.classList.remove('sent');
    btn.innerHTML = '<span>Play</span>';
    btn.setAttribute('aria-label', `Play ${modalPerson.name}`);
  } else if (modalPerson.isPersona) {
    const requested = getFriendRequests().includes(modalPerson.username);
    btn.classList.toggle('sent', requested);
    btn.innerHTML = requested ? friendSentHTML() : `${friendAddSVG()}<span>Add Friend</span>`;
    btn.setAttribute('aria-label', requested ? `Cancel friend request to ${modalPerson.name}` : `Add ${modalPerson.name} as a friend`);
  } else {
    const requested = isRealRequested(modalPerson.username);
    btn.classList.toggle('sent', requested);
    btn.innerHTML = requested ? friendSentHTML() : `${friendAddSVG()}<span>Add Friend</span>`;
    btn.setAttribute('aria-label', requested ? `Cancel friend request to ${modalPerson.name}` : `Add ${modalPerson.name} as a friend`);
  }
}
async function openPersonModal(person) {
  modalPerson = person;
  if (!person.isPersona) await loadServerFriends();
  const pfp = $('personPfp');
  pfp.innerHTML = usablePhoto(person) ? `<img src="${person.photoData}" alt="">` : silhouetteSVG(64);
  pfp.classList.toggle('no-photo', !usablePhoto(person));
  $('personName').textContent = person.name;
  $('personUser').textContent = '@' + person.username;
  $('personElo').textContent = person.elo;
  // Global Rank, below Elo. Show it at once when it is already
  // known — a Global row carries the server's true rank, and any
  // rank fetched before sits in the session cache. Otherwise
  // fetch it once (and cache it) instead of on every open; '—'
  // only while that first fetch is in flight.
  // Show the last-known rank at once when there is one (v114: the
  // persisted cache covers offline), and still fetch a fresh one
  // whenever the session cache misses — a game just ended, say —
  // so the number never sits stale online. No fetch offline.
  const mapRank = person.globalRank ?? rankCache.get(person.username);
  const knownRank = mapRank != null ? mapRank : persistedRankCache.get(person.username);
  $('personRank').textContent = knownRank != null ? knownRank : '—';
  if (mapRank == null && !isOffline()) {
    api('/api/users/rank?username=' + encodeURIComponent(person.username)).then(d => { setRank(person.username, d.rank); if (modalPerson && modalPerson.username === person.username) $('personRank').textContent = d.rank; }).catch(() => {});
  }
  $('personAddBtn').style.display = person.isYou ? 'none' : '';
  renderPersonAddBtn();
  $('personModal').classList.remove('hidden');
}
function closePersonModal() {
  $('personModal').classList.add('hidden');
  modalPerson = null;
  renderFriendsUI();
  if ($('friendSearch').value.trim()) runFriendSearch();
}
$('personCloseBtn').onclick = closePersonModal;
$('personModal').addEventListener('click', e => { if (e.target === $('personModal')) closePersonModal(); });
$('personAddBtn').onclick = async () => {
  if (!modalPerson || $('personAddBtn').disabled) return;
  if (isModalFriend()) {
    const p = modalPerson;
    closePersonModal();
    startChallenge(p);
    return;
  }
  if (modalPerson.isPersona) {
    if (getFriendRequests().includes(modalPerson.username)) unrequestFriend(modalPerson.username);
    else markFriendRequested(modalPerson.username);
  } else if (isRealRequested(modalPerson.username)) {
    try { await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ username: modalPerson.username }) }); } catch {}
    await loadServerFriends(true);
  } else {
    try { await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ username: modalPerson.username }) }); } catch {}
    await loadServerFriends(true);
  }
  renderPersonAddBtn();
};
function toLbRow(u) {
  return {
    id: u.id, isPersona: !!u.isPersona, rank: u.rank,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    username: u.username, elo: u.elo, photoData: u.photoData || null,
    isYou: !!(me && u.username === me.username),
  };
}
// Leaderboards and search show first name + last initial only
// ("Jeff M."); the full name appears only when you tap through
// to the profile window.
function shortName(r) {
  const f = r.firstName || (r.name || '').split(' ')[0] || r.username;
  const ln = r.lastName || (r.name || '').split(' ').slice(1).join(' ');
  return ln ? `${f} ${ln[0]}.` : f;
}
async function renderFriendsUI() {
  // v176: the roster-version check runs on every Friends visit —
  // before the early return below, so a tab tap checks even when
  // the list is already rendered. Fire-and-forget: the tab never
  // waits on it, and a version change re-renders in place.
  try { checkPersonasVersion(); } catch {}
  // v187: Challenge via Text lives only on the Friends leaderboard
  // — before the early return, so a tab tap re-gates even when
  // the list is already rendered. show() gates it the same way
  // on every navigation (leaving Friends hides it at once).
  const ctOn = lbScope === 'friends';
  $('challengeTextBtn').classList.toggle('hidden', !ctOn);
  $('ctMask').classList.toggle('hidden', !ctOn);
  $('friendsScreen').classList.toggle('ct-visible', ctOn);
  // Already loaded for this scope and nothing changed since: just
  // keep the screen as it is. The tab tap already called show(),
  // so there is no blanking, no refetch, and no rebuild.
  if (!friendsStale && friendsRenderedScope === lbScope) return;
  // Pencil keeps its layout box on Global (visibility, not display), so the
  // LEADERBOARD label and everything below it sit at the exact same
  // position on both tabs instead of shifting when the pencil appears.
  $('friendsPencil').style.visibility = lbScope !== 'friends' ? 'hidden' : 'visible';
  // Blank the list synchronously, before any fetch: the old
  // account's rows used to sit visible for the whole refresh
  // after switching accounts, because the list was only cleared
  // once the new data came back.
  $('leaderboardList').innerHTML = '';
  $('friendRequests').innerHTML = '';
  $('noFriendsCard').classList.add('hidden');
  await loadMe();
  // A dead session was just sent to sign-in by loadMe; don't
  // render this account's lists on a cleared token.
  if (!token) return;
  await loadServerFriends();
  // v190: the rendered data's signature — the live refresh
  // compares fresh fetches against this, so a tab tap that
  // re-renders the same data does not trip a second rebuild.
  friendsSignature = friendsListSignature();
  let rows = [];
  if (lbScope === 'global') {
    const users = await ensureGlobalRows();
    rows = users.map(toLbRow).sort((a, b) => b.elo - a.elo);
    // The rank on a Global row IS the true Global rank (the
    // server's RANK() over everyone), so the profile window can
    // show it at once with no fetch — see openPersonModal.
    rows.forEach(r => { r.globalRank = r.rank; });
    // Both leaderboards show first name + last initial (see
    // shortName in lbRowHTML). The full name still lives on the
    // row object, so the profile window (opened by tapping the
    // name) shows it.
  } else {
    // Friends are mutual: an accepted request puts each side on
    // the other's list (the server returns accepted rows in
    // either direction). This list is separate from Global and
    // has no cap — it is NOT resolved through the top-25
    // leaderboard, or a friend below the top 25 would vanish
    // from it. Nobody is a friend until they accept — real
    // players only arrive here via the server's accepted list,
    // and personas never arrive at all: a request to a persona
    // stays local "Requested" (the sent state on their profile
    // button) and nothing more, because fake humans never
    // accept. You are on your own Friends list too, and ranks
    // here start at 1 — your Global rank is a different number,
    // shown on your profile.
    const realRows = (serverFriends.friends || []).map(u => toLbRow(u));
    const selfRow = me ? toLbRow({ id: me.id, username: me.username, firstName: me.firstName, lastName: me.lastName, elo: localElo(), photoData: me.photoData || null, isPersona: false }) : null;
    rows = [...realRows, ...(selfRow ? [selfRow] : [])].sort((a, b) => b.elo - a.elo);
    // Ties share a rank, and the next rank skips ahead: two players
    // tied at 19 are both 19, and the next player is 21.
    let tieElo = null, tieRank = 0;
    rows.forEach((r, i) => { if (r.elo !== tieElo) { tieRank = i + 1; tieElo = r.elo; } r.rank = tieRank; });
  }
  const list = $('leaderboardList'); list.innerHTML = '';
  // Leaving delete mode (pencil off, or switching to Global)
  // dismisses a pending remove confirm with it.
  if (!deleteMode) pendingRemove = null;
  $('friendsPencil').classList.toggle('active', deleteMode && lbScope === 'friends');
  rows.forEach((r, i) => {
    const isFriends = lbScope === 'friends';
    // The row being confirmed gets a wider action column for the
    // "Remove?" button (see .lb-row.confirming in style.css).
    const confirming = isFriends && deleteMode && pendingRemove && pendingRemove.username === r.username;
    const row = document.createElement('div'); row.className = 'lb-row' + (r.isYou ? ' you' : '') + (confirming ? ' confirming' : '');
    // Grid row (see style.css): rank | pfp | name | action | Elo,
    // all fixed-width except the name, so every Elo sits in the
    // same column at the far right edge whatever the name length
    // or the button state. Your own row keeps the YOU badge in the
    // action slot, so its Elo lines up too and your full name never
    // has to shrink for the badge.
    // No play button on leaderboard rows any more: challenging
    // a friend happens only from their profile window (Play
    // button). The action slot stays as an empty box so the Elo
    // keeps its column at the far right. In delete mode the
    // slot holds a red ×; tapping it swaps in a "Remove?"
    // button right there in the same slot — nothing is removed
    // until that is tapped. Your own row is never removable.
    let action;
    if (!isFriends || r.isYou) action = youBadgeHTML(r);
    else if (deleteMode) action = confirming
      ? '<button class="lb-remove-confirm">Remove?</button>'
      : '<button class="lb-delete" aria-label="Remove friend">×</button>';
    else action = '<span class="lb-action"></span>';
    row.innerHTML = lbRowHTML(r, action);
    list.appendChild(row);
    if (isFriends && !r.isYou && deleteMode) {
      const delBtn = row.querySelector('.lb-delete');
      if (delBtn) delBtn.onclick = () => { pendingRemove = r; friendsStale = true; renderFriendsUI(); };
      const confBtn = row.querySelector('.lb-remove-confirm');
      if (confBtn) confBtn.onclick = async () => {
        const target = pendingRemove; pendingRemove = null;
        if (!target) return;
        if (target.isPersona) unrequestFriend(target.username);
        else { try { await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ username: target.username }) }); } catch {} await loadServerFriends(true); }
        friendsStale = true;
        renderFriendsUI();
      };
    }
    // Tapping the name opens their profile window.
    const nameEl = row.querySelector('.lb-name');
    if (nameEl) nameEl.onclick = () => openPersonModal(r);
  });
  // "No friends yet" counts friends only — your own row is always
  // on the Friends list, so an empty friends list still has you.
  const friendCount = lbScope === 'friends' ? rows.filter(r => !r.isYou).length : 0;
  $('noFriendsCard').classList.toggle('hidden', !(lbScope === 'friends' && friendCount === 0));
  // Incoming friend requests sit at the top of the Friends page,
  // above the list — that is how a request reaches the other
  // person now that requests live on the server.
  const reqEl = $('friendRequests'); reqEl.innerHTML = '';
  if (lbScope === 'friends') {
    // At most two requests at a time: deciding one reveals the next.
    for (const u of (serverFriends.incoming || []).slice(0, 2)) {
      const name = shortName({ firstName: u.firstName, lastName: u.lastName, name: '', username: u.username });
      const row = document.createElement('div'); row.className = 'request-row';
      row.innerHTML = `<span class="lb-pfp${usablePhoto(u) ? '' : ' no-photo'}">${pfpHTML(u)}</span><span class="lb-identity"><div class="lb-name">${name}</div><div class="lb-user">@${u.username}</div></span><span class="request-actions"><button class="mini-btn" data-act="accept">Accept</button><button class="mini-btn grey" data-act="decline">Decline</button></span>`;
      row.querySelector('[data-act="accept"]').onclick = async () => { try { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ username: u.username, accept: true }) }); } catch {} await loadServerFriends(true); renderFriendsUI(); };
      row.querySelector('[data-act="decline"]').onclick = async () => { try { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ username: u.username, accept: false }) }); } catch {} await loadServerFriends(true); renderFriendsUI(); };
      reqEl.appendChild(row);
    }
  }
  // Incoming challenges sit above the friend requests: they are
  // live (60 seconds), so they render on every Friends visit and
  // the poll below keeps them fresh while the page is open. This
  // runs on both scopes — a challenge should reach you wherever
  // you are on the Friends page.
  renderIncomingChallenges();
  // (v114: the "Last known results" marker is gone — cached data
  // just shows, with no note. The hidden note element stays in the
  // DOM.)
  friendsStale = false; friendsRenderedScope = lbScope;
  // A stalled remote photo never errors, so without this the
  // circle stays empty: swap any leaderboard photo that hasn't
  // loaded in 3s for the silhouette.
  armPfpTimeouts();
  // Warm the rank cache for the Friends list in the background,
  // so opening a friend's profile shows their Global Rank at
  // once instead of waiting on the fetch: the list is small, this
  // runs only on a real render, and already-cached names are
  // skipped. Global rows need none of this — they carry their
  // rank already (see the global branch above).
  if (lbScope === 'friends') {
    for (const r of rows) {
      if (rankCache.has(r.username)) continue;
      api('/api/users/rank?username=' + encodeURIComponent(r.username)).then(d => setRank(r.username, d.rank)).catch(() => {});
    }
  }
}
// Incoming real-player challenges, rendered into the top of the
// Friends page (above the friend requests). Accept creates the
// game on the server and joins it; Decline ends the challenge.
// One fetch serves both the Friends-page rows and the challenge
// window, so the poll does not hit the server twice per cycle.
async function fetchIncomingChallenges() {
  // v192: a failed fetch is UNKNOWN, not empty — it used to
  // return [], so one blip during the 5s poll cleared the rows
  // and closed an open challenge window. Null keeps the last
  // known list on screen; the poll retries on its next tick.
  try { const d = await api('/api/challenges/incoming'); return d.challenges || []; }
  catch (err) { if (deadSession(err)) return null; return null; }
}
async function renderIncomingChallenges(list) {
  const el = $('challengeRequests');
  if (!el) return [];
  if (list === undefined) { list = await fetchIncomingChallenges(); if (list === null) return []; }
  el.innerHTML = '';
  for (const c of list) {
    const u = c.from;
    const name = u.firstName || u.username;
    const row = document.createElement('div'); row.className = 'request-row';
    row.innerHTML = `<span class="lb-pfp${usablePhoto(u) ? '' : ' no-photo'}">${pfpHTML(u)}</span><span class="lb-identity"><div class="lb-name">${name} challenged you</div><div class="lb-user">@${u.username}</div></span><span class="request-actions"><button class="mini-btn" data-act="accept">Accept</button><button class="mini-btn grey" data-act="decline">Decline</button></span>`;
    row.querySelector('[data-act="accept"]').onclick = async () => {
      try {
        const d = await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) });
        if (d.gameId) { el.innerHTML = ''; joinChallengeGame(d.gameId); return; }
      } catch {}
      renderIncomingChallenges();
    };
    row.querySelector('[data-act="decline"]').onclick = async () => {
      try { await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: false }) }); } catch {}
      renderIncomingChallenges();
    };
    el.appendChild(row);
  }
  return list;
}
// A challenge pops up as a window wherever you are — Home, Profile,
// Bots, Global — not only on the Friends page. The poll below runs
// on every screen (it used to wait for the Friends page), and this
// shows the first pending challenge. One window at a time; a second
// challenger waits until the first is answered. If the shown challenge
// is no longer pending (the challenger cancelled it), the window
// closes on its own. The window is a hard modal: there is no × and no
// backdrop tap to get out of it — the player must Accept or Decline.
let challengeModalChallenge = null;
function maybeShowChallengeModal(list) {
  // A text challenge is not a server row, so the poll's list can
  // never contain it — the guard must not close it.
  if (challengeModalChallenge && !challengeModalChallenge.textChallenge && !list.some(x => x.id === challengeModalChallenge.id)) hideChallengeModal();
  if (challengeModalChallenge) return;
  const c = (list || [])[0];
  if (!c) return;
  // In a game the window waits until the game ends: showStatWindow
  // calls the check again, so it pops up at once instead of on the
  // next poll.
  if (game && game.status === 'active') return;
  showChallengeModal(c);
}
function showChallengeModal(c) {
  challengeModalChallenge = c;
  const u = c.from;
  const name = u.firstName || u.username;
  $('challengePfp').innerHTML = pfpHTML(u);
  $('challengePfp').classList.toggle('no-photo', !usablePhoto(u));
  $('challengeName').textContent = name + ' challenged you';
  $('challengeUser').textContent = '@' + u.username;
  $('challengeModal').classList.remove('hidden');
}
function hideChallengeModal() {
  challengeModalChallenge = null;
  $('challengeModal').classList.add('hidden');
}
$('challengeAcceptBtn').onclick = async () => {
  const c = challengeModalChallenge; if (!c) return;
  hideChallengeModal();
  // Accepting withdraws any outgoing challenge I am waiting on, so
  // its accept can never strand me in a second game.
  cancelSearch();
  if (c.textChallenge) {
    // v187: a text challenge has no server row — accepting creates
    // the friendship AND the game in one step, and the sender is
    // told by push (they are not on a waiting screen).
    try {
      const d = await api('/api/challenges/text-accept', { method: 'POST', body: JSON.stringify({ username: c.from.username }) });
      if (d.gameId) { joinChallengeGame(d.gameId); return; }
    } catch {}
    checkIncomingChallenges();
    return;
  }
  try {
    const d = await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) });
    if (d.gameId) { joinChallengeGame(d.gameId); return; }
  } catch {}
  checkIncomingChallenges();
};
$('challengeDeclineBtn').onclick = async () => {
  const c = challengeModalChallenge; if (!c) return;
  hideChallengeModal();
  // v187: declining a text challenge creates nothing — no friend,
  // no game — so there is no server call at all.
  if (c.textChallenge) { checkIncomingChallenges(); return; }
  try { await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: false }) }); } catch {}
  checkIncomingChallenges();
};
// No × button and no backdrop tap: the only way out of the window is
// Accept or Decline (or the challenger cancelling, which closes it
// on its own via maybeShowChallengeModal).
// Challenges arrive while any screen is open, so poll for them every
// 5 seconds wherever you are — no push notification exists, and a
// 60-second challenge cannot wait for the next manual refresh. Runs
// once, guarded by token. The Friends rows and the window share one
// fetch per cycle.
let challengePollTimer = null;
function startChallengePoll() {
  if (challengePollTimer) return;
  challengePollTimer = setInterval(() => {
    if (!token) return;
    checkIncomingChallenges();
  }, 5000);
}
async function checkIncomingChallenges() {
  if (!token) return;
  const list = await fetchIncomingChallenges();
  if (list === null) return;
  renderIncomingChallenges(list);
  maybeShowChallengeModal(list);
  // v187: a friend / text-challenge link deferred by a game (or
  // by an open challenge window) lands here — the 5s poll and the
  // post-game stat window both re-check the stash.
  try { maybeOpenFriendDeepLink(); } catch {}
  try { maybeOpenChallengeDeepLink(); } catch {}
  try { maybeOpenInviteDeepLink(); } catch {}
  // v190: a friend request accepted elsewhere lands on this
  // screen within one poll cycle — no tap needed.
  try { maybeRefreshFriendsList(); } catch {}
  // v192: a push tap stashed before the session was ready lands
  // here, within one poll cycle.
  try { maybeOpenPushChallenge(); } catch {}
}
startChallengePoll();

// ---------- Push notifications (v120) ----------
// iOS only (Capacitor shell): a match challenge arrives as a push
// when the app is closed or backgrounded, reading "@<challenger>
// challenged you to a match!". Tapping it opens the accept/decline
// window. The toggle lives in Settings (gear); it gates sending
// server-side (push_enabled) and registers the device token. Web
// has no push — the row stays hidden there (see refreshPushToggle).
// The plugin is reached through the Capacitor bridge
// (window.Capacitor.Plugins.PushNotifications); no bundler, no
// import — the native shell registers it.
function pushPlugin() {
  try {
    return (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins) ? (window.Capacitor.Plugins.PushNotifications || null) : null;
  } catch { return null; }
}
let pushDeviceToken = null; // this device's APNs token, once registered
let pushInitDone = false;
// ---------- Push-registration diagnostics (v180) ----------
// Every step of the token-registration flow is recorded in pushDiag
// and posted to the server, because the Nov 23 failure (@neo on
// build 105: challenges 13-17 all 'no-token') was invisible — every
// failure path swallowed its error (empty registrationError listener,
// empty token-POST catch, register() throw returning false), and
// there was no Settings row to look at. The diag is what the server
// log shows when a token never arrives. Fields:
//   isCapacitor — running in the Capacitor shell (false on web)
//   plugin — the PushNotifications plugin is present (null = not
//     checked yet, false = missing from the native build)
//   permission — checkPermissions receive value ('granted' /
//     'denied' / 'prompt'), or 'check-failed: <msg>'
//   register — 'never' / 'called' / 'threw: <msg>'
//   registrationEvent — 'never' / 'fired' / 'error: <msg>'
//   tokenPost — 'never' / 'sent' / 'failed: <status or msg>' /
//     'skipped: no-session'
let pushDiag = { isCapacitor: false, plugin: null, permission: 'unknown', register: 'never', registrationEvent: 'never', tokenPost: 'never' };
function loadPushDiag() {
  try { const raw = localStorage.getItem('duello-push-diag'); if (raw) { const d = JSON.parse(raw); if (d && typeof d === 'object') Object.assign(pushDiag, d); } } catch {}
}
function savePushDiag() {
  try { localStorage.setItem('duello-push-diag', JSON.stringify(pushDiag)); } catch {}
}
function postPushDiag() {
  // Fire-and-forget: a diag failure must never break registration.
  // iOS only — web has no push, so a web snapshot would just be
  // log noise. The server logs the line, so a missing token is
  // diagnosable from the Render logs without the phone in hand.
  if (!IS_CAPACITOR || !token) return;
  try { api('/api/push/diag', { method: 'POST', body: JSON.stringify(pushDiag) }).catch(() => {}); } catch {}
}
function updatePushDiag(patch) {
  Object.assign(pushDiag, patch);
  savePushDiag();
  try { refreshPushStatusRow(); } catch {}
  postPushDiag();
}
// Pure: the Settings row's plain-language status for a diag
// snapshot. Tested in the v180 client harness (PU1).
function pushPrefOn() {
  // The server defaults the preference on; an older cached `me`
  // has no pushEnabled field, which also reads as on.
  return !me || me.pushEnabled !== false;
}
function refreshPushStatusRow() {
  // v183: the row is a normal Settings row now — white label "Push
  // notifications", grey right-justified "On"/"Off" (On = the token
  // actually reached the server). The long status text lives in the
  // drill-in (renderPushDetail), which repaints here too so it stays
  // live while open. Loads the persisted diag first so the row is
  // right even before init runs.
  loadPushDiag();
  const row = $('pushSettingRow'); if (!row) return;
  // Web: no push at all — the row stays hidden.
  row.classList.toggle('hidden', !IS_CAPACITOR || !pushPlugin());
  // v186: On only when the token actually reached the server AND
  // iOS permission is not denied — a token posted before the user
  // turned notifications off in iOS Settings must not read On.
  const v = $('pushSettingValue'); if (v) v.textContent = (pushDiag.tokenPost === 'sent' && pushDiag.permission !== 'denied') ? 'On' : 'Off';
  renderPushDetail();
}
// Pure: the Push drill-in's status + hint + Retry visibility for a
// diag snapshot. Tested in the v183 client harness (PU3).
function pushDetailContent(d) {
  d = d || {};
  // v186: denied takes precedence over registered — a token posted
  // before the user turned notifications off in iOS Settings must
  // show the denied state, not On.
  if (d.permission === 'denied') return { status: 'Push notifications are off.', hint: 'Turn them on in Phone Settings > Apps > Duello > Notifications.', retry: false };
  if (d.tokenPost === 'sent') return { status: 'Push notifications are on.', hint: 'Push notifications are controlled in your phone\u2019s settings.', retry: false };
  if (d.permission === 'prompt') return { status: 'Push notifications are not set up yet.', hint: 'Tap Retry to turn them on.', retry: true };
  return { status: 'Push notifications are off.', hint: 'Tap Retry to try again.', retry: true };
}
function renderPushDetail() {
  const s = $('pushDetailStatus'); if (!s) return;
  const c = pushDetailContent(pushDiag);
  s.textContent = c.status;
  const h = $('pushDetailHint'); if (h) { h.textContent = c.hint; h.classList.toggle('hidden', !c.hint); }
  const r = $('pushRetryBtn'); if (r) r.classList.toggle('hidden', !c.retry);
}
function openPushScreen() {
  loadPushDiag();
  renderPushDetail();
  show('profilePushScreen');
}
function refreshPushToggle() {
  // v180: the old toggle is gone; the Push row owns the status now.
  // Kept as a wrapper so older call sites (gear, setPushEnabled)
  // keep working unchanged.
  refreshPushStatusRow();
}
function setPushNote(msg) {
  const n = $('pushSettingNote'); if (!n) return;
  n.textContent = msg || '';
  n.classList.toggle('hidden', !msg);
}
let pushRegisterInFlight = false;
async function registerPushToken() {
  // Ask iOS for a device token (only after the user has granted
  // permission) and hand it to the server. The 'registration'
  // listener below does the actual send; this just starts it.
  // v180: the attempt is recorded in pushDiag, and a second call
  // while one is in flight is a no-op — the foreground retry and
  // the Settings tap share this guard, so a retry can never stack
  // registrations.
  const P = pushPlugin(); if (!P) return false;
  if (pushRegisterInFlight) return false;
  pushRegisterInFlight = true;
  updatePushDiag({ register: 'called' });
  try { await P.register(); return true; }
  catch (e) {
    updatePushDiag({ register: 'threw: ' + (e && e.message ? e.message : 'unknown error') });
    return false;
  } finally { pushRegisterInFlight = false; }
}
async function setPushEnabled(on) {
  const P = pushPlugin();
  if (on) {
    // Turning on asks iOS first: without permission there is no
    // token and nothing to send. Check first — a denied permission
    // never re-prompts, so a doomed requestPermissions call would
    // just look like a dead toggle; say where to fix it instead.
    if (!P) { setPushNote('Push notifications need the Duello app.'); return; }
    let perm = null;
    try { perm = await P.checkPermissions(); } catch { perm = null; }
    if (perm && perm.receive === 'denied') {
      setPushNote('Notifications are off for Duello — turn them on in Phone Settings > Apps > Duello > Notifications to get challenge alerts.');
      refreshPushToggle();
      return;
    }
    try { perm = await P.requestPermissions(); } catch { perm = null; }
    if (!perm || perm.receive !== 'granted') {
      setPushNote('Notifications are off for Duello — turn them on in Phone Settings > Apps > Duello > Notifications to get challenge alerts.');
      refreshPushToggle();
      return;
    }
    // The preference POST is no longer swallowed: if it fails, the
    // toggle stays where it was and says so, instead of flipping
    // locally and flipping back on the next profile re-warm.
    try { await api('/api/push/preference', { method: 'POST', body: JSON.stringify({ enabled: true }) }); }
    catch { setPushNote('Could not save the push setting. Check your connection and try again.'); refreshPushToggle(); return; }
    if (me) { me.pushEnabled = true; persistMe(); }
    setPushNote('');
    refreshPushToggle();
    await registerPushToken();
    return;
  }
  // Turning off: the server stops sending for this user, and this
  // device's token is removed so a stale token can never fire.
  try { await api('/api/push/preference', { method: 'POST', body: JSON.stringify({ enabled: false }) }); }
  catch { setPushNote('Could not save the push setting. Check your connection and try again.'); refreshPushToggle(); return; }
  if (pushDeviceToken) { try { await api('/api/push/token/delete', { method: 'POST', body: JSON.stringify({ token: pushDeviceToken }) }); } catch {} }
  if (me) { me.pushEnabled = false; persistMe(); }
  setPushNote('');
  refreshPushToggle();
}
// v192: a push tap that arrives before the session is ready, or
// whose fetch blips, is stashed — not dropped. The tap used to
// silently do nothing when the fetch failed (the app merely
// opened), because the listener only attached at the end of boot
// and openChallengeFromPush returned on the first null list.
// The stash is re-checked by the 5s poll (checkIncomingChallenges)
// and after sign-in, so the window lands within one cycle.
async function openChallengeFromPush(challengeId) {
  // A push tap opens the accept/decline window for that challenge.
  // The challenge may already be gone (declined, cancelled, timed
  // out) — then the Friends page is the right landing spot, where
  // the row sits if it is still waiting.
  if (challengeId == null) return;
  if (!token) { try { localStorage.setItem('duello-pending-push-challenge', String(challengeId)); } catch {} return; }
  let list = null;
  for (let attempt = 0; attempt < 3 && !list; attempt++) {
    try { list = await fetchIncomingChallenges(); } catch { list = null; }
    if (!list && token && attempt < 2) await new Promise(r => setTimeout(r, 700));
  }
  if (!list) { if (token) { try { localStorage.setItem('duello-pending-push-challenge', String(challengeId)); } catch {} } return; }
  const c = list.find(x => Number(x.id) === Number(challengeId));
  if (!c) { show('friendsScreen'); return; }
  try { localStorage.removeItem('duello-pending-push-challenge'); } catch {}
  maybeShowChallengeModal([c]);
  // maybeShowChallengeModal holds the window while a game is active;
  // the tap still lands on the Friends page, where the row is.
  if (!challengeModalChallenge) show('friendsScreen');
}
function maybeOpenPushChallenge() {
  try {
    const raw = localStorage.getItem('duello-pending-push-challenge'); if (!raw) return;
    if (!token) return;
    if (game && game.status === 'active') return;
    if (challengeModalChallenge) return;
    localStorage.removeItem('duello-pending-push-challenge');
    openChallengeFromPush(Number(raw));
  } catch {}
}
function initPushNotifications() {
  // Runs once, after sign-in: registers the plugin listeners and,
  // when the preference is on and iOS permission is already
  // granted, (re-)registers the token — tokens can change between
  // launches. Never prompts on its own: a never-asked permission
  // waits for the Settings toggle.
  // v180: every step is recorded in pushDiag (persisted + posted to
  // /api/push/diag) — the Nov 23 failure was invisible because the
  // registrationError listener was empty, the token-POST catch was
  // empty, and register() throwing just returned false.
  loadPushDiag();
  updatePushDiag({ isCapacitor: !!IS_CAPACITOR, plugin: !!pushPlugin() });
  if (pushInitDone || !IS_CAPACITOR) return;
  const P = pushPlugin();
  if (!P) return;
  pushInitDone = true;
  try {
    P.addListener('registration', async (t) => {
      pushDeviceToken = (t && t.value) || null;
      if (!pushDeviceToken) { updatePushDiag({ registrationEvent: 'fired', tokenPost: 'failed: empty-token' }); return; }
      if (!token) { updatePushDiag({ registrationEvent: 'fired', tokenPost: 'skipped: no-session' }); return; }
      updatePushDiag({ registrationEvent: 'fired' });
      try {
        await api('/api/push/token', { method: 'POST', body: JSON.stringify({ token: pushDeviceToken, platform: 'ios' }) });
        updatePushDiag({ tokenPost: 'sent' });
      } catch (e) {
        updatePushDiag({ tokenPost: 'failed: ' + (e && e.status ? 'http-' + e.status : (e && e.message ? e.message : 'network error')) });
      }
    });
    P.addListener('registrationError', (e) => {
      updatePushDiag({ registrationEvent: 'error: ' + (e && (e.error || e.message) ? (e.error || e.message) : 'unknown error') });
    });
    P.addListener('pushNotificationReceived', () => {
      // Foreground: the 5s poll already shows the window, but a
      // fresh fetch makes it appear at once instead of on the
      // next tick.
      try { checkIncomingChallenges(); } catch {}
    });
    P.addListener('pushNotificationActionPerformed', (action) => {
      const d = (action && action.notification && action.notification.data) || {};
      if (d.type === 'challenge' && d.challengeId != null) openChallengeFromPush(d.challengeId);
    });
  } catch (e) {
    updatePushDiag({ registrationEvent: 'error: ' + (e && e.message ? e.message : 'listener attach failed') });
  }
  // Re-register when the preference is on and permission is already
  // granted — this is what refreshes a rotated token. v152: there
  // is no Settings toggle any more, so a 'prompt' (never asked)
  // permission gets one request at app setup (see
  // maybeRequestPushAtSetup), never twice.
  if (pushPrefOn() && token) {
    P.checkPermissions().then((perm) => {
      const recv = (perm && perm.receive) || 'unknown';
      updatePushDiag({ permission: recv });
      if (recv === 'granted') registerPushToken();
      else if (recv === 'prompt') maybeRequestPushAtSetup();
      else if (recv === 'denied') removePostedPushToken();
    }).catch((e) => {
      updatePushDiag({ permission: 'check-failed: ' + (e && e.message ? e.message : 'unknown error') });
    });
  }
}
// v185: Universal Links — when a duellogame.com/?puzzle=... link is
// tapped and the installed app opens, Capacitor fires 'appUrlOpen'
// with the URL (warm start and cold start — the plugin delivers the
// launch URL once the listener is attached, so this is registered
// early, next to initPushNotifications). A puzzle param opens the
// Daily Puzzle, exactly like the web ?puzzle deep link; any other URL
// is a no-op (normal Home boot). The param is only presence-checked
// with a regex, not new URL — the harness vm has no URL global.
let appUrlOpenInitDone = false;
function appPlugin() {
  try {
    return (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins) ? (window.Capacitor.Plugins.App || null) : null;
  } catch { return null; }
}
function initAppUrlOpenListener() {
  if (appUrlOpenInitDone || !IS_CAPACITOR) return;
  const A = appPlugin(); if (!A) return;
  appUrlOpenInitDone = true;
  try {
    A.addListener('appUrlOpen', (data) => {
      try {
        const url = data && data.url ? String(data.url) : '';
        if (!url) return;
        if (/[?&]puzzle(?:=|&|$)/.test(url)) { openDailyPuzzle(); return; }
        // v187: a shared friend / text-challenge link tapped in
        // Messages opens the app with the same query. The URL
        // itself is not in window.location (capacitor://), so the
        // username is stashed and the deep link processes from
        // the stash, exactly like the web load path.
        const fm = url.match(/[?&]friend=([^&]*)/);
        if (fm) { try { localStorage.setItem('duello-pending-friend', decodeURIComponent(fm[1])); } catch {} try { maybeOpenFriendDeepLink(); } catch {} return; }
        const cm = url.match(/[?&]challenge=([^&]*)/);
        if (cm) { try { localStorage.setItem('duello-pending-challenge', decodeURIComponent(cm[1])); } catch {} try { maybeOpenChallengeDeepLink(); } catch {} return; }
        // v190: an invite link (?invite=<inviter>) opens the app
        // the same way — stash it and let the deep link process
        // from the stash, exactly like the web load path.
        const im = url.match(/[?&]invite=([^&]*)/);
        if (im) { try { localStorage.setItem('duello-pending-invite', decodeURIComponent(im[1])); } catch {} try { maybeOpenInviteDeepLink(); } catch {} return; }
      } catch {}
    });
  } catch {}
}
// v180: retry the registration when the app comes back to the
// foreground and the diag says the token never landed — a first
// launch can hit a transient failure (no network, plugin not yet
// ready) and nothing ever retried it until a full restart. One
// attempt per return (the visibilitychange handler calls this once),
// permission re-checked fresh, and never while a registration is
// already in flight (registerPushToken guards that). A 'prompt'
// permission is left alone — the setup ask owns prompting, once.
// v186: iOS permission was turned off after a token was posted —
// the stored token can never produce a visible notification, and
// the row must stop claiming On. Delete the server-side token via
// the same /api/push/token/delete call setPushEnabled(false) uses
// (no token value on a fresh launch: the endpoint deletes all of
// the user's tokens when the body has none) and clear tokenPost so
// a later re-grant re-registers from scratch. The server preference
// is deliberately left alone — flipping it off would stop init's
// launch re-check (pushPrefOn gate) and the user could never come
// back just by re-enabling in iOS Settings.
async function removePostedPushToken() {
  if (!pushDiag || pushDiag.tokenPost !== 'sent') return;
  try { await api('/api/push/token/delete', { method: 'POST', body: JSON.stringify({ token: pushDeviceToken || '' }) }); } catch {}
  pushDeviceToken = null;
  updatePushDiag({ tokenPost: 'never' });
}
async function retryPushRegistration() {
  if (!IS_CAPACITOR || !token) return;
  const P = pushPlugin(); if (!P) return;
  // v186: permission is re-checked on EVERY foreground return,
  // even when a token was posted — the old early return on
  // tokenPost 'sent' meant a flip to denied in iOS Settings was
  // never picked up until a full restart.
  let perm = null;
  try { perm = await P.checkPermissions(); }
  catch (e) { updatePushDiag({ permission: 'check-failed: ' + (e && e.message ? e.message : 'unknown error') }); return; }
  const recv = (perm && perm.receive) || 'unknown';
  updatePushDiag({ permission: recv });
  if (recv === 'denied') { await removePostedPushToken(); return; }
  if (pushDiag.tokenPost === 'sent') return;
  if (recv === 'granted') await registerPushToken();
}
// v152: push is requested once at app setup (the Settings toggle is
// gone). Safe to call any time — the flag makes it ask at most once,
// and setPushEnabled re-checks the permission first, so a denied
// permission never re-prompts.
function maybeRequestPushAtSetup() {
  if (!IS_CAPACITOR || !token) return;
  const P = pushPlugin(); if (!P) return;
  try { if (localStorage.getItem('duello-push-setup-asked')) return; localStorage.setItem('duello-push-setup-asked', '1'); } catch { return; }
  setPushEnabled(true).catch(() => {});
}
function showFriendsTab() {
  lbScope = 'friends';
  $('lbFriendsTab').classList.add('active'); $('lbGlobalTab').classList.remove('active');
  show('friendsScreen'); renderFriendsUI();
}
$('tabFriends').onclick = showFriendsTab;
$('lbFriendsTab').onclick = () => { lbScope = 'friends'; $('lbFriendsTab').classList.add('active'); $('lbGlobalTab').classList.remove('active'); renderFriendsUI(); };
$('lbGlobalTab').onclick = () => { lbScope = 'global'; deleteMode = false; $('lbGlobalTab').classList.add('active'); $('lbFriendsTab').classList.remove('active'); renderFriendsUI(); };
// v190: Invite Friends to Duello — the button no longer starts
// a text challenge; it invites a new player. The link takes them
// to sign-up, and creating their account makes them your friend
// automatically (POST /api/friends/invite-accept). The old
// ?challenge= links keep working — only the button changed.
$('challengeTextBtn').onclick = async () => {
  if (!me) await loadMe();
  if (!me) return;
  const msg = 'Join Duello!⚔️ https://duellogame.com/?invite=' + encodeURIComponent(me.username);
  window.location.href = 'sms:?&body=' + encodeURIComponent(msg);
};
$('friendsPencil').onclick = () => { if (lbScope !== 'friends') return; deleteMode = !deleteMode; friendsStale = true; renderFriendsUI(); };
async function runFriendSearch() {
  // A leading @ is stripped: typing "@neo" searches for neo, so
  // the @ in a displayed handle never makes a search miss.
  const q = $('friendSearch').value.trim().toLowerCase().replace(/^@+/, ''); const el = $('friendSearchResults');
  // An empty query clears the old results at once; a real query
  // keeps the last results up until the new ones are ready, so
  // typing never flashes the list away.
  if (!q) { el.innerHTML = ''; return; }
  // A newer keystroke supersedes this search: a slow reply must
  // not overwrite the results of the query typed after it.
  const mySearch = ++friendSearchSeq;
  // loadMe sends a dead session to sign-in and returns false;
  // don't run a search on a rejected session.
  if (!(await loadMe())) return;
  if (mySearch !== friendSearchSeq) return;
  // Server search, not the top-25 leaderboard: a new account at
  // 1000 Elo is below the top 25 and was unfindable before.
  let users = null, searchFallback = false, searchFailReason = '', searchOffline = false;
  try { const d = await api('/api/users/search?q=' + encodeURIComponent(q)); users = d.users || []; }
  catch (err) {
    // A dead session goes to sign-in, never to the fallback: the
    // fallback only masks it, and the top-25 list is where a real
    // account below the top 25 looks unfindable. Anything else
    // falls back, and the note names the failure so the next
    // report says exactly what broke.
    if (deadSession(err)) return;
    searchFallback = true;
    searchFailReason = (err && err.message) || 'network error';
    // Offline (v107): the search cannot reach the server, so the
    // note says exactly that — not "search isn't working". The
    // fallback rows below still come from the last-known
    // leaderboard (item 5) when there is one.
    searchOffline = isOffline() || /failed to fetch|network/i.test(searchFailReason);
    const rows = await ensureGlobalRows();
    users = rows.filter(u => (`${u.firstName || ''} ${u.lastName || ''}`.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)));
  }
  if (mySearch !== friendSearchSeq) return;
  // Build the new results off-DOM, then swap them in one go, so
  // the old results stay visible until the new ones are ready.
  const frag = document.createDocumentFragment();
  if (searchFallback) {
    const note = document.createElement('div'); note.className = 'small';
    note.textContent = searchOffline ? 'Search requires an internet connection.' : `Search isn't working (${searchFailReason}) — showing top players only.`;
    frag.appendChild(note);
  }
  // At most the 5 most relevant results (the server already
  // ranks and caps at 5; this caps the fallback too).
  users.slice(0, 5).forEach(u => {
    // Search rows are leaderboard rows, not a compact variant:
    // pfp | name over username | Elo — no rank column at all.
    // No friend button here either — adding happens only from
    // the profile window.
    const r = toLbRow(u);
    // The search fallback (top-25 rows) carries the leaderboard
    // rank, which is the true Global one — tag it so the profile
    // window shows it at once. Server search results have no
    // rank, so those still fetch on first open.
    if (u.rank != null) r.globalRank = u.rank;
    const row = document.createElement('div'); row.className = 'lb-row no-rank' + (r.isYou ? ' you' : '');
    row.innerHTML = lbRowHTML(r, youBadgeHTML(r), { hideRank: true });
    frag.appendChild(row);
    const nameEl = row.querySelector('.lb-name');
    if (nameEl) nameEl.onclick = () => openPersonModal(r);
  });
  el.innerHTML = '';
  el.appendChild(frag);
  // Same stalled-photo swap as the leaderboard lists.
  armPfpTimeouts();
  // Results live for 10 seconds, then vanish and the search bar
  // empties itself. Typing again restarts the clock (the input
  // listener clears this timer).
  if (friendSearchClearTimer) clearTimeout(friendSearchClearTimer);
  friendSearchClearTimer = setTimeout(() => { $('friendSearch').value = ''; el.innerHTML = ''; }, 10000);
}
let friendSearchTimer = null, friendSearchClearTimer = null, friendSearchSeq = 0;
$('friendSearch').addEventListener('input', () => {
  clearTimeout(friendSearchTimer);
  clearTimeout(friendSearchClearTimer);
  friendSearchTimer = setTimeout(runFriendSearch, 250);
});

// A rejected session anywhere means the token is dead (the
// password was changed elsewhere, or the account signed out on
// another device). Send the user to sign-in instead of letting
// every list quietly go empty. Returns true when it redirected.
// The v61 fix only covered loadMe with no cached user — but
// loadMe short-circuits once `me` is set, so a session that
// dies after that kept degrading everything silently.
function deadSession(err) {
  if (err && err.message === 'Not signed in.') {
    token = ''; storeDel('duello_token'); me = null; profileData = null;
    wipeAccountScreens(); setAuthMode('signin'); show('authScreen');
    return true;
  }
  return false;
}
async function loadMe() {
  // Real /api/me, but cached: the scoreboard Elo comes from game.player
  // on each game response, so call sites must not pay a request per play.
  if (me) return true;
  try { const d = await api('/api/me'); me = d.user; persistMe(); return true; }
  catch (err) {
    if (deadSession(err)) return false;
    // Offline (v106): fall back to the persisted user, so bot games can
    // still start and the local Elo is known without a round-trip.
    const stored = loadPersistedMe();
    if (stored) { me = stored; return true; }
    return !!token;
  }
}
$('playBotsBtn').onclick = () => show('botScreen');
$('playFriendsBtn').onclick = showFriendsTab;
// v195: after today is solved, the button opens the past-puzzle log
// instead of today's board (today is the top row of the log).
$('dailyPuzzleBtn').onclick = () => {
  if (puzzleSolvedDates().has(localDateKey(new Date()))) openPuzzleLog();
  else openDailyPuzzle();
};
$('puzzleLogBackBtn').onclick = () => show('homeScreen');
// v149: on Free the Pro badge is replaced by this pill, which opens
// the Duello Pro settings page.
$('homeUpgradePill').onclick = () => openProScreen();
$('puzzleBoardExitBtn').onclick = closeDailyPuzzle;
$('puzzleBoardRecallBtn').onclick = puzzleBoardRecall;
$('puzzleBoardShuffleBtn').onclick = puzzleBoardShuffle;
$('puzzleBoardShareBtn').onclick = puzzleBoardShare;
// v148: the rack has no delegated click any more — rack-tile taps
// select via the pointerup handler in enablePuzzleRackDrag, and a
// delegated click would double-toggle after it.
// v152: Share replaces Play again — wired just above with the other
// puzzle controls.
// v148: the board click is guarded by suppressNextClick (like the
// real game's cell.onclick) so a drag's trailing click does not
// also fire a tap.
$('puzzleBoard').onclick = (e) => { if (suppressNextClick) { suppressNextClick = false; return; } const c = e.target.closest('.cell'); if (c) puzzleBoardTapCell(+c.dataset.r, +c.dataset.c); };
// Matchmaking, not an instant game: Play Online (the globe) shows a
// searching screen that ticks for a random 2-3 seconds, then makes
// the match. Cancel, or any navigation away, abandons the search.
// Challenging a friend reuses the same screen: it says "Waiting for
// {name} to accept…" instead, ticks 5-7 seconds, and the friend
// accepts half the time — the same simulated accept/decline as a
// rematch request, because a persona has no real app for the
// request to pop up on. A real friend's phone would need the
// friends backend to deliver it; until then a real player just
// never answers, and the screen says so plainly instead of
// hanging on the wait.
// Offline signal for UI copy (v107): navigator.onLine is false in
// airplane mode and on a dead connection. It can lie on captive
// portals, but for "what should the screen say" it is the right
// signal — the game-start path still falls back to the local engine
// on any fetch failure, whatever this says.
function isOffline() {
  return (typeof navigator !== 'undefined' && navigator.onLine === false);
}
let searchTimer = null, searchingActive = false;
let searchMode = 'random', challengePersona = null, liveChallengeId = null;
// v182: the three blue dots pulse while waiting for an answer; once
// a challenge is declined (or ends any other way) they stop and sit
// dimmed instead of looping forever next to the "declined" line.
function stopSearchingDots() { const d = document.querySelector('.searching-dots'); if (d) d.classList.add('stopped'); }
function startSearchingDots() { const d = document.querySelector('.searching-dots'); if (d) d.classList.remove('stopped'); }
function cancelSearch() {
  // Leaving the Play Online queue (v123, item 4): only if a search
  // was actually in progress — cancelSearch also runs on every
  // navigation (show()), so an unconditional cancel would POST on
  // every screen change. Withdrawing from the matchmaking search
  // removes the player from the queue, so a cancelled search never
  // pairs them after they walked away.
  if (searchingActive) api('/api/matchmaking/cancel', { method: 'POST' }).catch(() => {});
  searchingActive = false; challengePersona = null; searchMode = 'random';
  // v193: a pending join retry dies with the search — the game id
  // must never fire later from a stale button.
  joinRetryGameId = null;
  // never sits stale on the recipient's Friends page — and an
  // accepted challenge can never strand them in a game alone.
  // (show() calls this on any navigation away, and the Cancel
  // button calls it too; the accept/decline/timeout paths clear
  // liveChallengeId themselves first.)
  if (liveChallengeId) { const id = liveChallengeId; liveChallengeId = null; api(`/api/challenges/${id}/cancel`, { method: 'POST' }).catch(() => {}); }
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  $('searchingText').textContent = 'Searching for opponent…';
  $('searchCancelBtn').textContent = 'Cancel';
  startSearchingDots();
}
function startSearching() {
  cancelSearch();
  searchingActive = true;
  show('searchingScreen');
  // Play Online (v123, item 4; v171: 5s): 5 seconds of real-person search.
  // The queue is polled once a second; a match joins the human game
  // at once. No match in 5s -> a persona is assigned (one of the 500
  // fake "human" players), and the game counts as human stats.
  const SEARCH_MS = 5000, POLL_MS = 1000;
  let searchStartedAt = 0;
  // Offline (v107): a persona opponent cannot be found without a
  // connection, so the screen says so plainly instead of pretending
  // to search — and the match waits, re-checking every 2s, until the
  // connection is back instead of firing a match that fails silently.
  const waitForConnection = () => {
    if (!searchingActive) return;
    if (isOffline()) {
      // v107: the offline searching note reads exactly this string.
      $('searchingText').textContent = 'searching for internet connection';
      searchTimer = setTimeout(waitForConnection, 2000);
      return;
    }
    $('searchingText').textContent = 'Searching for opponent…';
    searchStartedAt = Date.now();
    pollMatchmaking();
  };
  const pollMatchmaking = async () => {
    if (!searchingActive) return;
    if (isOffline()) { waitForConnection(); return; }
    try {
      const r = await api('/api/matchmaking/search', { method: 'POST' });
      if (!searchingActive) return;
      if (r && r.matched && r.gameId) {
        searchingActive = false; searchTimer = null;
        api('/api/matchmaking/cancel', { method: 'POST' }).catch(() => {});
        await joinChallengeGame(r.gameId);
        return;
      }
    } catch (e) { /* a failed poll is not a failed search: keep looking */ }
    if (Date.now() - searchStartedAt >= SEARCH_MS) {
      searchingActive = false; searchTimer = null;
      api('/api/matchmaking/cancel', { method: 'POST' }).catch(() => {});
      startGame('persona');
      return;
    }
    searchTimer = setTimeout(pollMatchmaking, POLL_MS);
  };
  waitForConnection();
}
async function startChallenge(r) {
  cancelSearch();
  searchingActive = true; searchMode = 'challenge'; challengePersona = r;
  const first = r.name.split(' ')[0];
  $('searchingText').textContent = `Waiting for ${first} to accept…`;
  show('searchingScreen');
  if (!r.isPersona) {
    // A real challenge goes through the friends backend: the
    // recipient sees it at the top of their Friends page and
    // accepts or declines there. Wait up to 60 seconds, polling
    // the challenge every 2 seconds; Cancel (or the timeout)
    // withdraws it so it never sits stale on their page.
    // Sync first (v111): the challenge is created from the server
    // Elo, so finished offline games must land before it goes out.
    if (!isOffline()) await syncBeforeOnlinePlay();
    let challengeId = null;
    try {
      const d = await api('/api/challenges', { method: 'POST', body: JSON.stringify({ username: r.username }) });
      challengeId = d.id;
    } catch (e) {
      if (!searchingActive) return;
      searchingActive = false; searchTimer = null;
      $('searchingText').textContent = (e && e.message) || `Couldn't reach ${first} right now.`;
      stopSearchingDots();
      $('searchCancelBtn').textContent = 'Back to Friends';
      return;
    }
    // The user may have tapped Cancel while the send was in flight:
    // the challenge now exists on the server, so withdraw it at
    // once instead of leaving it on the recipient's page.
    if (!searchingActive) { try { await api(`/api/challenges/${challengeId}/cancel`, { method: 'POST' }); } catch {} return; }
    liveChallengeId = challengeId;
    let waited = 0;
    const pollChallenge = async () => {
      if (!searchingActive) return;
      try {
        const ch = await api(`/api/challenges/${challengeId}`);
        if (!searchingActive) return;
        if (ch.status === 'accepted' && ch.gameId) { searchingActive = false; searchTimer = null; liveChallengeId = null; joinChallengeGame(ch.gameId); return; }
        if (ch.status === 'declined') { searchingActive = false; searchTimer = null; liveChallengeId = null; $('searchingText').textContent = `${first} declined the challenge.`; stopSearchingDots(); $('searchCancelBtn').textContent = 'Back to Friends'; return; }
        if (ch.status !== 'pending') { searchingActive = false; searchTimer = null; liveChallengeId = null; $('searchingText').textContent = `That challenge ended.`; stopSearchingDots(); $('searchCancelBtn').textContent = 'Back to Friends'; return; }
      } catch {}
      waited += 2000;
      if (waited >= CHALLENGE_WAIT_MS) {
        searchingActive = false; searchTimer = null; liveChallengeId = null;
        // v194: the accept may have landed while the last poll was in
        // flight — one final check before withdrawing, so an accept
        // can never strand the recipient in a game the challenger
        // never joins.
        try {
          const ch = await api(`/api/challenges/${challengeId}`);
          if (ch && ch.status === 'accepted' && ch.gameId) { joinChallengeGame(ch.gameId); return; }
        } catch {}
        try { await api(`/api/challenges/${challengeId}/cancel`, { method: 'POST' }); } catch {}
        $('searchingText').textContent = `${first} didn't answer — they may not be in the app right now.`;
        stopSearchingDots();
        $('searchCancelBtn').textContent = 'Back to Friends';
        return;
      }
      if (searchingActive) searchTimer = setTimeout(pollChallenge, 2000);
    };
    searchTimer = setTimeout(pollChallenge, 2000);
    return;
  }
  searchTimer = setTimeout(() => {
    if (!searchingActive) return;
    searchingActive = false; searchTimer = null;
    if (Math.random() < 0.5) {
      startGame('persona', r.id);
    } else {
      $('searchingText').textContent = `${first} declined the challenge.`;
      stopSearchingDots();
      $('searchCancelBtn').textContent = 'Back to Friends';
    }
  }, 5000 + Math.floor(Math.random() * 2000));
}
// Join a real-player game that already exists (an accepted
// challenge): load it and run the same countdown start as a
// fresh game. One retry on the load: the accept just created
// the row, so a single blip must not strand the player on the
// Friends page with the challenge already gone.
// v193: if the load fails even after the retry, say so plainly
// and offer a Retry — the recipient may already be sitting in
// the game while the challenger stares at a stale "Waiting for
// X to accept…" screen. joinRetryGameId carries the game id to
// the Cancel button, which becomes Retry until the join lands.
let joinRetryGameId = null;
// v194: the searching screen doubles as the join-error screen —
// Retry re-runs the join for this game id (see the Cancel button
// handler), Back to Friends gives up.
function showJoinRetry(gameId) {
  joinRetryGameId = gameId;
  show('searchingScreen');
  $('searchingText').textContent = `Couldn't open the game. Check your connection and tap Retry.`;
  stopSearchingDots();
  $('searchCancelBtn').textContent = 'Retry';
}
function showGameGone() {
  joinRetryGameId = null;
  show('searchingScreen');
  $('searchingText').textContent = `That game is no longer available.`;
  stopSearchingDots();
  $('searchCancelBtn').textContent = 'Back to Friends';
}
async function joinChallengeGame(gameId) {
  currentBot = 'human'; currentPersonaId = null; botTurnTapTime = Date.now();
  try {
    game = await api(`/api/games/${gameId}`);
  } catch (e) {
    try { await new Promise(r => setTimeout(r, 1000)); game = await api(`/api/games/${gameId}`); }
    catch (e2) {
      if (e2 && e2.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; setAuthMode('signin'); show('authScreen'); return; }
      showJoinRetry(gameId);
      return;
    }
  }
  // v194: the game may have been voided between the accept and this
  // load (never started, or abandoned) — entering a dead game would
  // strand the player on a board that can never play. Clear the
  // loaded game first, so no stale void game sits in `game`.
  if (!game || game.status !== 'active') { game = null; showGameGone(); return; }
  joinRetryGameId = null;
  try {
    enterGameScreen();
  } catch {
    // v194: an enter failure (a bad render, a missing element) used
    // to strand the player silently with the game already created —
    // the same Retry way back as a failed load.
    showJoinRetry(gameId);
  }
}
// v194: the server voided this game (never started, or abandoned) —
// there is no In progress list anymore, so a player who still has
// it open must be sent home with a reason, not left staring at a
// dead board.
function exitVoidGame(g) {
  try { if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; } } catch {}
  waitingForSync = false;
  closeGameStream();
  try { $('statWindow').classList.add('hidden'); } catch {}
  game = null;
  show('homeScreen');
  const n = $('homeNote');
  if (n) {
    n.textContent = (g && g.started) ? 'That game was voided — both players left.' : 'That game was voided — it never started.';
    setTimeout(() => { try { if (n.textContent.indexOf('voided') !== -1) n.textContent = ''; } catch {} }, 8000);
  }
}
// The shared game start: clocks pinned during the countdown,
// rack hidden until the countdown ends. startGame (bot games)
// and joinChallengeGame (real games) both land here.
//
// Real-player games count down TOGETHER: the server stamps the
// shared end once both players have loaded the game (see the GET
// check-in in server.js), and each phone counts down to that one
// instant — the old code counted 5 seconds from each phone's own
// entry, so one player could be moving while the other still saw
// the countdown. While waiting for the shared time the overlay
// says so; if the other player never loads in, the countdown starts
// on its own after 15 seconds rather than hanging forever. A game
// that is already started (a late join) skips the countdown entirely.
let waitingForSync = false, syncFallbackTimer = null;
// v193: how long the shared countdown may take to arrive (stream or
// poll) before this phone falls back to a local one. A module-level
// let so the harness can shrink it — the production value is 15s.
let SYNC_FALLBACK_MS = 15000;
// v194: how long the challenger waits for an accept before the 60s
// timeout re-checks once and then withdraws. A module-level let so
// the harness can shrink it — the production value is 60s.
let CHALLENGE_WAIT_MS = 60000;
function enterGameScreen() {
  // A fetch from a previous game may still be in flight: invalidate
  // it, so its response cannot overwrite this game with old state.
  gameAppliedSeq = gameFetchSeq;
  // A stale offline-play message never survives into a game.
  const om = $('offlineMsg'); if (om) om.classList.add('hidden');
  // Display 4:00 during the countdown, not the server's create-round-trip
  // value (3:59): the clocks only start when the countdown ends (see /start).
  // A resumed offline game keeps its persisted clocks instead (v106).
  if (!(game.offline && resumeSkipCountdown)) { game.clocks.human = 240000; game.clocks.bot = 240000; }
  gameFetchAt = Date.now(); pending = []; selectedRack = null; armed = {};
  clearStatDelay(); statShownGameId = null;
  // A rematch accepted from the stat window (or a challenge that
  // arrived while it was open) must start clean: the stat window is
  // a top-level overlay, not part of any screen, so show('gameScreen')
  // leaves it up — and the countdown overlay (z-index 15) then
  // counts down over the last game's stats (z-index 10). Hide it
  // here, the one shared entry for every game start, and lift the
  // board dim with it.
  $('statWindow').classList.add('hidden');
  $('gameDim').classList.remove('dimmed');
  // Set the countdown flag BEFORE the first render, so that render draws
  // the rack as empty slots (not full letters) from the very first frame.
  countdownActive = true;
  ensureLocalWords();
  show('gameScreen'); $('gameScreen').classList.add('counting'); renderGame(); openGameStream();
  if (game.botType === 'human' && game.started) {
    // Late join: the clocks are already running — no countdown.
    countdownActive = false;
    $('gameScreen').classList.remove('counting');
    $('countdownOverlay').classList.add('hidden');
    clockHoldUntil = Date.now() + 1000;
    renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
    return;
  }
  if (game.botType === 'human') {
    // Wait for the shared countdown. If this phone already has it
    // (the join reply carried it), the tick watcher starts it at
    // once; otherwise the overlay waits and the stream or the next
    // poll delivers it.
    waitingForSync = true;
    const opp = (game.opponent && game.opponent.firstName) || 'your opponent';
    const num = $('countdownNum');
    num.classList.add('waiting');
    num.textContent = `Waiting for ${opp}…`;
    $('countdownOverlay').classList.remove('hidden');
    if (syncFallbackTimer) clearTimeout(syncFallbackTimer);
    const syncGameId = game.id;
    syncFallbackTimer = setTimeout(async () => {
      syncFallbackTimer = null;
      if (!waitingForSync || !game || game.id !== syncGameId) return;
      // v193: one last re-fetch before going local — the shared end
      // may have been stamped while the stream/poll was down, and a
      // local 5s countdown from here would put the two phones on
      // different clocks. A failed re-fetch still falls back local.
      try {
        const fresh = await api(`/api/games/${syncGameId}`);
        if (!waitingForSync || !game || game.id !== syncGameId) return;
        // v194: the game was voided while waiting for the opponent —
        // go home with a reason instead of starting a local countdown
        // on a dead game.
        if (fresh && fresh.status === 'void') { exitVoidGame(fresh); return; }
        if (fresh && fresh.countdownRemainingMs != null) {
          waitingForSync = false;
          startCountdown(Date.now() + fresh.countdownRemainingMs);
          return;
        }
      } catch {}
      if (!waitingForSync || !game || game.id !== syncGameId) return;
      waitingForSync = false;
      startCountdown(Date.now() + 5000);
    }, SYNC_FALLBACK_MS);
    return;
  }
  if (resumeSkipCountdown) {
    // Resuming a persisted offline game: skip the countdown — the game
    // was already in progress when the app closed, and its clocks were
    // settled at pause, so they restart from here, not from 4:00.
    resumeSkipCountdown = false;
    countdownActive = false;
    $('gameScreen').classList.remove('counting');
    $('countdownOverlay').classList.add('hidden');
    clockHoldUntil = Date.now() + 1000;
    renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
    return;
  }
  startCountdown(Date.now() + 5000);
}
$('searchCancelBtn').onclick = () => {
  // v193: a failed join turns this button into Retry (see
  // joinChallengeGame) — tap it to try the same game again
  // instead of leaving for Friends.
  if (joinRetryGameId) { const gid = joinRetryGameId; joinRetryGameId = null; $('searchCancelBtn').textContent = 'Cancel'; $('searchingText').textContent = 'Opening the game…'; startSearchingDots(); joinChallengeGame(gid); return; }
  const wasChallenge = searchMode === 'challenge';
  cancelSearch();
  if (wasChallenge) { lbScope = 'friends'; $('lbFriendsTab').classList.add('active'); $('lbGlobalTab').classList.remove('active'); show('friendsScreen'); renderFriendsUI(); }
  else show('homeScreen');
};
$('playOnlineBtn').onclick = () => startSearching();
// Rematch requests, persona games only: Play Again sends the
// opponent a request instead of starting at once. The request
// screen waits a random 5-7 seconds, then the persona accepts
// (50%) and the rematch starts, or declines and the screen offers
// a way home or a new search. Bots keep instant Play Again.
let rematchTimer = null, rematchActive = false;
function cancelRematch() { rematchActive = false; if (rematchTimer) { clearTimeout(rematchTimer); rematchTimer = null; } }
function requestRematch() {
  const name = (game && game.persona && game.persona.firstName) || 'your opponent';
  cancelRematch();
  rematchActive = true;
  $('rematchText').textContent = `Request sent — waiting for ${name} to accept…`;
  $('rematchActions').classList.add('hidden');
  show('rematchScreen');
  rematchTimer = setTimeout(() => {
    if (!rematchActive) return;
    rematchActive = false; rematchTimer = null;
    if (Math.random() < 0.5) {
      startGame('persona', currentPersonaId);
    } else {
      $('rematchText').textContent = `${name} declined the rematch.`;
      $('rematchActions').classList.remove('hidden');
    }
  }, 5000 + Math.floor(Math.random() * 2000));
}
$('rematchHomeBtn').onclick = () => { cancelRematch(); show('homeScreen'); };
$('rematchNewBtn').onclick = () => { cancelRematch(); startSearching(); };
$('botBackBtn').onclick = () => show('homeScreen');
$('competitiveBtn').onclick = () => startGame('competitive');
$('fishstickBtn').onclick = () => startGame('fishstick');
let currentPersonaId = null;
async function startGame(bot, personaId) {
  currentBot = bot; currentPersonaId = personaId || null; botTurnTapTime = Date.now();
  // Bot games are always native (Jeff, Nov 16, 2026): Fishstick and
  // Competitive run on the local engine in the app, online or offline.
  // A game started online broke when the network dropped mid-game —
  // Forfeit and the bot turn are server-driven on a server game, so
  // they died silently offline. Local games sync the finished result
  // to the server for Elo/stats. Personas and real-player games still
  // need the server (no local version).
  if (bot === 'competitive' || bot === 'fishstick') { await startOfflineGame(bot); return; }
  // v113: when the device reports no network, don't attempt a server
  // game at all. The POST is guaranteed to fail, and on iOS the
  // failure can take seconds to surface — that hang, not the
  // dictionary, is the delay Jeff still saw on build 29. Go straight
  // to the local game.
  if (isOffline()) {
    return;
  }
  // The device thinks it is online, but the connection may still be
  // dead (Wi-Fi with no internet): bound the whole server attempt —
  // sync + POST — to 1.5s, then fall back to the local game for bot
  // play instead of hanging the tap. A late server reply is ignored.
  const online = (async () => {
    // Online games are created from the server Elo: sync any finished
    // offline games first, so the new game is priced from the current
    // Elo, not a stale one (v111).
    await syncBeforeOnlinePlay();
    return await api('/api/games', { method: 'POST', body: JSON.stringify(personaId ? { bot, personaId } : { bot }) });
  })();
  try {
    game = await Promise.race([online, new Promise((_, rej) => setTimeout(() => rej(new Error('server-timeout')), 1500))]);
    // A random Play Online match learns its persona here, so Play
    // Again rematches the same person instead of drawing a new one.
    if (game.persona) currentPersonaId = game.persona.id;
  } catch (e) {
    // No guest fallback anymore: sign-in is required. A rejected session
    // sends the user to the auth screen; anything else is a transient
    // failure and another tap retries.
    if (e && e.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; setAuthMode('signin'); show('authScreen'); return; }
    // Personas and real-player games have no local version, so they
    // keep the old behaviour (tap again to retry). Bot games never
    // reach here — they always start locally (see startGame above).
    return;
  }
  enterGameScreen();
}
async function endCountdown() {
  clearByoyomi(); // v157: a new game starts with no countdown.
  // Keep the clocks pinned until the new state actually arrives. The old
  // code cleared countdownActive BEFORE awaiting /start, so the 100ms
  // tick ran during that network round-trip with the stale creation-time
  // gameFetchAt (5s countdown + ~1s create = ~6s elapsed) and showed
  // 4:54 for a brief second, then corrected to 5:00 when /start returned.
  // Now the overlay hides but countdownActive (and the hidden rack)
  // stay until /start returns and gameFetchAt is reset to that moment.
  $('countdownOverlay').classList.add('hidden');
  if (game && game.offline) {
    // Offline games never POST /start: the clocks start locally.
    // Mark the game started (v108): the countdown completed, so this
    // is a real game in progress — it may resume on a later launch.
    // A game closed before this point was never started, so it must
    // not auto-open. Persist the flag at once, so closing the app
    // right after the countdown still leaves a resumable game.
    game.started = true;
    countdownActive = false;
    $('gameScreen').classList.remove('counting');
    clockHoldUntil = Date.now() + 1000;
    gameFetchAt = Date.now(); game.clocks.turnStartedAt = Date.now(); pending = []; selectedRack = null; renderGame();
    // Arm the bot think HERE, at countdown end (v109) — not at game
    // creation. The think must run after the countdown, not during it:
    // arming it at creation let it elapse under the countdown, so
    // Fishstick played the instant the countdown ended. This is the
    // local mirror of the server's /start, which re-arms the think
    // when the countdown ends. Persisted after arming, so a game
    // closed mid-think resumes with the think state intact.
    if (game.status === 'active' && game.clocks.turn === 'bot') startLocalBotTurn();
    persistOfflineGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
    return;
  }
  try {
    try { game = await api(`/api/games/${game.id}/start`, { method: 'POST' }); }
    catch { game = await api(`/api/games/${game.id}`); }
    // v194: the game may have been voided during the countdown.
    if (game && game.status === 'void') { countdownActive = false; $('gameScreen').classList.remove('counting'); exitVoidGame(game); return; }
    countdownActive = false;
    $('gameScreen').classList.remove('counting');
    clockHoldUntil = Date.now() + 1000;
    gameFetchAt = Date.now(); pending = []; selectedRack = null; renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
  } catch { countdownActive = false; $('gameScreen').classList.remove('counting'); clockHoldUntil = Date.now() + 1000; botTurnTapTime = 0; beginBotTurn(); }
}
function startCountdown(targetMs) {
  if (countdownInterval) clearInterval(countdownInterval);
  if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; }
  waitingForSync = false;
  countdownActive = true; countdownTargetMs = targetMs; countdownPaused = false; countdownPausedRemainingMs = 0;
  $('gameScreen').classList.add('counting');
  // Re-render so the rack is blank slots (and controls disabled) during
  // the wait, even if an earlier render drew letters before the flag set.
  cleanupStuckDrag(); renderGame();
  const ov = $('countdownOverlay'); ov.classList.remove('hidden');
  const num = $('countdownNum');
  num.classList.remove('waiting');
  // One countdown loop driven by an absolute local target, so a shared
  // server end and a local 5-second countdown run the same way. The
  // 200ms tick keeps the displayed number aligned to the target
  // instead of drifting a second per render.
  let shown = null;
  const tick = () => {
    const n = Math.ceil((targetMs - Date.now()) / 1000);
    if (n <= 0) { clearInterval(countdownInterval); countdownInterval = null; endCountdown(); return; }
    if (n !== shown) { shown = n; num.textContent = String(n); }
  };
  num.textContent = String(Math.max(1, Math.ceil((targetMs - Date.now()) / 1000)));
  shown = Number(num.textContent);
  countdownInterval = setInterval(tick, 200);
}
function boardCell(r, c) { return game.board[r][c]; }
// One SVG tile template for every letter: face, letter, and value are drawn
// in a single 100x100 viewBox, so the proportions are locked no matter what
// size the tile is rendered at (board, rack, or drag ghost). Letters and
// values are baked-in vector paths, not font-rendered text, so bold
// thickness can no longer vary by device: letters come from Comfortaa Bold
// at the same size/position as before (58px, centered at x=46, baseline 76),
// values from Liberation Sans Bold (metric-compatible Arial substitute) at
// the same size/position (28px, anchored end at x=90, baseline 28), with the
// value stroke thinned to 1 at Jeff's approval (Nov 3, 2026; letters stay
// stroke 3). Letters come from game state, never from the DOM, so drawing
// them as paths changes nothing about validation or drag.
const TILE_LETTER_PATHS = {"A":"M29.61 76Q27.99 76 27.12 74.61Q26.25 73.22 26.95 71.65L43.25 32.73Q44.12 30.7 46.09 30.7Q48.17 30.7 48.93 32.73L65.28 71.77Q65.92 73.39 65.08 74.69Q64.24 76 62.56 76Q61.69 76 60.91 75.51Q60.12 75.01 59.77 74.14L45.39 38.42H47.02L32.4 74.14Q31.99 75.07 31.21 75.54Q30.43 76 29.61 76ZM32.69 66.02 35.01 61.04H57.75L60.07 66.02Z","B":"M33.85 76Q32.57 76 31.7 75.13Q30.83 74.26 30.83 72.98V33.72Q30.83 32.38 31.7 31.54Q32.57 30.7 33.85 30.7H47.71Q51.66 30.7 54.64 32.24Q57.63 33.78 59.34 36.5Q61.05 39.23 61.05 42.77Q61.05 45.61 59.51 47.9Q57.98 50.19 55.31 51.52Q59.14 52.45 61.46 55.18Q63.78 57.9 63.78 62.31Q63.78 66.31 61.89 69.39Q60.01 72.46 56.64 74.23Q53.28 76 48.93 76ZM36.86 70.43H48.93Q51.6 70.43 53.63 69.5Q55.66 68.58 56.82 66.78Q57.98 64.98 57.98 62.31Q57.98 59.82 56.82 58.19Q55.66 56.57 53.63 55.73Q51.6 54.89 48.93 54.89H36.86ZM36.86 49.32H47.71Q51.02 49.32 53.13 47.7Q55.25 46.07 55.25 42.77Q55.25 39.46 53.13 37.86Q51.02 36.27 47.71 36.27H36.86Z","C":"M49.57 76.58Q44.87 76.58 40.78 74.81Q36.69 73.04 33.65 69.88Q30.6 66.72 28.89 62.49Q27.18 58.25 27.18 53.32Q27.18 48.45 28.89 44.25Q30.6 40.04 33.65 36.88Q36.69 33.72 40.75 31.92Q44.81 30.12 49.57 30.12Q54.03 30.12 57.25 31.28Q60.47 32.44 63.72 35.11Q64.18 35.46 64.44 35.83Q64.7 36.21 64.79 36.59Q64.88 36.97 64.88 37.49Q64.88 38.59 64.1 39.31Q63.31 40.04 62.21 40.13Q61.11 40.21 60.06 39.4Q57.92 37.55 55.63 36.56Q53.34 35.57 49.57 35.57Q46.14 35.57 43.13 36.97Q40.11 38.36 37.82 40.79Q35.53 43.23 34.25 46.45Q32.98 49.67 32.98 53.32Q32.98 57.03 34.25 60.25Q35.53 63.47 37.82 65.91Q40.11 68.34 43.13 69.71Q46.14 71.07 49.57 71.07Q52.52 71.07 55.16 70.06Q57.8 69.04 60.24 67.24Q61.28 66.49 62.3 66.58Q63.31 66.66 64.01 67.39Q64.7 68.11 64.7 69.39Q64.7 69.97 64.47 70.52Q64.24 71.07 63.78 71.53Q60.65 74.03 57.08 75.3Q53.51 76.58 49.57 76.58Z","D":"M32.11 76Q30.83 76 29.96 75.13Q29.09 74.26 29.09 72.98V33.72Q29.09 32.38 29.96 31.54Q30.83 30.7 32.11 30.7H42.61Q47.59 30.7 51.68 32.35Q55.77 34.01 58.79 37.05Q61.8 40.1 63.43 44.22Q65.05 48.33 65.05 53.32Q65.05 58.31 63.43 62.46Q61.8 66.6 58.79 69.65Q55.77 72.69 51.68 74.35Q47.59 76 42.61 76ZM35.12 70.66H42.61Q47.48 70.66 51.22 68.43Q54.96 66.2 57.11 62.28Q59.25 58.37 59.25 53.32Q59.25 48.22 57.11 44.33Q54.96 40.45 51.22 38.24Q47.48 36.04 42.61 36.04H35.12Z","E":"M34.52 76Q33.24 76 32.37 75.13Q31.5 74.26 31.5 72.98V33.72Q31.5 32.38 32.37 31.54Q33.24 30.7 34.52 30.7H60.73Q62.07 30.7 62.88 31.48Q63.69 32.27 63.69 33.54Q63.69 34.76 62.88 35.52Q62.07 36.27 60.73 36.27H37.53V50.36H54.18Q55.51 50.36 56.32 51.15Q57.14 51.93 57.14 53.15Q57.14 54.37 56.32 55.15Q55.51 55.93 54.18 55.93H37.53V70.43H60.73Q62.07 70.43 62.88 71.19Q63.69 71.94 63.69 73.16Q63.69 74.43 62.88 75.22Q62.07 76 60.73 76Z","F":"M33.04 76Q31.76 76 30.89 75.13Q30.02 74.26 30.02 72.98V33.72Q30.02 32.38 30.89 31.54Q31.76 30.7 33.04 30.7H59.25Q60.59 30.7 61.4 31.48Q62.21 32.27 62.21 33.54Q62.21 34.76 61.4 35.52Q60.59 36.27 59.25 36.27H36.05V50.36H52.7Q54.03 50.36 54.84 51.15Q55.66 51.93 55.66 53.15Q55.66 54.37 54.84 55.15Q54.03 55.93 52.7 55.93H36.05V72.98Q36.05 74.26 35.18 75.13Q34.31 76 33.04 76Z","G":"M49.57 76.58Q44.87 76.58 40.78 74.81Q36.69 73.04 33.65 69.88Q30.6 66.72 28.89 62.49Q27.18 58.25 27.18 53.32Q27.18 48.45 28.89 44.25Q30.6 40.04 33.65 36.88Q36.69 33.72 40.75 31.92Q44.81 30.12 49.57 30.12Q54.03 30.12 57.25 31.28Q60.47 32.44 63.72 35.11Q64.18 35.46 64.44 35.83Q64.7 36.21 64.79 36.59Q64.88 36.97 64.88 37.49Q64.88 38.59 64.1 39.34Q63.31 40.1 62.18 40.16Q61.05 40.21 60.06 39.4Q57.92 37.55 55.63 36.56Q53.34 35.57 49.57 35.57Q46.14 35.57 43.13 36.97Q40.11 38.36 37.82 40.79Q35.53 43.23 34.25 46.45Q32.98 49.67 32.98 53.32Q32.98 57.03 34.25 60.25Q35.53 63.47 37.82 65.91Q40.11 68.34 43.13 69.71Q46.14 71.07 49.57 71.07Q52.52 71.07 55.16 70.06Q57.8 69.04 60.24 67.24Q61.28 66.49 62.3 66.58Q63.31 66.66 64.01 67.39Q64.7 68.11 64.7 69.39Q64.7 69.97 64.5 70.52Q64.3 71.07 63.78 71.53Q60.7 74.09 57.11 75.33Q53.51 76.58 49.57 76.58ZM64.7 69.39 58.91 68.23V57.85H50.9Q49.62 57.85 48.76 57.09Q47.89 56.34 47.89 55.18Q47.89 54.02 48.76 53.26Q49.62 52.51 50.9 52.51H61.75Q63.08 52.51 63.89 53.35Q64.7 54.19 64.7 55.53Z","H":"M29.56 76Q28.28 76 27.41 75.13Q26.54 74.26 26.54 72.98V33.72Q26.54 32.38 27.41 31.54Q28.28 30.7 29.56 30.7Q30.89 30.7 31.73 31.54Q32.57 32.38 32.57 33.72V50.36H59.48V33.72Q59.48 32.38 60.36 31.54Q61.23 30.7 62.5 30.7Q63.84 30.7 64.65 31.54Q65.46 32.38 65.46 33.72V72.98Q65.46 74.26 64.65 75.13Q63.84 76 62.5 76Q61.23 76 60.36 75.13Q59.48 74.26 59.48 72.98V55.7H32.57V72.98Q32.57 74.26 31.73 75.13Q30.89 76 29.56 76Z","I":"M46 76Q44.72 76 43.85 75.13Q42.98 74.26 42.98 72.98V33.72Q42.98 32.38 43.85 31.54Q44.72 30.7 46 30.7Q47.33 30.7 48.17 31.54Q49.02 32.38 49.02 33.72V72.98Q49.02 74.26 48.17 75.13Q47.33 76 46 76Z","J":"M44.38 76.58Q40.32 76.58 37.16 74.81Q33.99 73.04 32.23 69.88Q30.46 66.72 30.46 62.66Q30.46 61.33 31.33 60.48Q32.2 59.64 33.47 59.64Q34.81 59.64 35.65 60.48Q36.49 61.33 36.49 62.66Q36.49 65.15 37.5 67.07Q38.52 68.98 40.29 70.06Q42.06 71.13 44.38 71.13Q46.7 71.13 48.49 70.06Q50.29 68.98 51.31 67.07Q52.32 65.15 52.32 62.66V33.72Q52.32 32.38 53.16 31.54Q54 30.7 55.28 30.7Q56.61 30.7 57.48 31.54Q58.35 32.38 58.35 33.72V62.66Q58.35 66.72 56.56 69.88Q54.76 73.04 51.63 74.81Q48.49 76.58 44.38 76.58Z","K":"M35.47 76Q34.26 76 33.36 75.13Q32.46 74.26 32.46 72.98V33.72Q32.46 32.44 33.36 31.57Q34.26 30.7 35.47 30.7Q36.75 30.7 37.62 31.57Q38.49 32.44 38.49 33.72V51.12L57.69 31.92Q58.38 31.22 58.96 30.96Q59.54 30.7 60.18 30.7Q61.63 30.7 62.27 31.57Q62.91 32.44 62.73 33.63Q62.56 34.82 61.63 35.81L46.84 50.65L61.92 71.19Q62.62 72.17 62.5 73.3Q62.39 74.43 61.69 75.22Q60.99 76 59.83 76Q58.21 76 57.34 74.72L42.66 54.83L38.49 59.01V72.98Q38.49 74.26 37.62 75.13Q36.75 76 35.47 76Z","L":"M36.14 76Q34.86 76 34.02 75.13Q33.18 74.26 33.18 72.98V33.72Q33.18 32.44 34.05 31.57Q34.92 30.7 36.14 30.7Q37.42 30.7 38.29 31.57Q39.16 32.44 39.16 33.72V69.97H60.15Q61.43 69.97 62.3 70.84Q63.17 71.71 63.17 72.98Q63.17 74.26 62.3 75.13Q61.43 76 60.15 76Z","M":"M26.34 76Q25.06 76 24.19 75.13Q23.32 74.26 23.32 72.98V33.72Q23.32 32.38 24.19 31.54Q25.06 30.7 26.34 30.7Q28.08 30.7 29.01 32.33L47.16 68.69H45.3L62.99 32.33Q63.92 30.7 65.66 30.7Q66.94 30.7 67.81 31.54Q68.68 32.38 68.68 33.72V72.98Q68.68 74.26 67.78 75.13Q66.88 76 65.66 76Q64.39 76 63.52 75.13Q62.65 74.26 62.65 72.98V42.07L63.81 41.78L48.61 72.75Q47.62 74.26 46 74.26Q44.09 74.26 43.22 72.46L28.19 42.36L29.35 42.07V72.98Q29.35 74.26 28.48 75.13Q27.61 76 26.34 76Z","N":"M30.69 76Q29.41 76 28.57 75.13Q27.73 74.26 27.73 72.98V33.72Q27.73 32.38 28.57 31.54Q29.41 30.7 30.69 30.7Q32.08 30.7 33.01 31.8L58.3 65.44V33.72Q58.3 32.38 59.17 31.54Q60.04 30.7 61.31 30.7Q62.65 30.7 63.46 31.54Q64.27 32.38 64.27 33.72V72.98Q64.27 74.26 63.46 75.13Q62.65 76 61.31 76Q60.73 76 60.06 75.74Q59.4 75.48 58.99 74.96L33.7 41.32V72.98Q33.7 74.26 32.86 75.13Q32.02 76 30.69 76Z","O":"M46.03 76.58Q40.92 76.58 36.69 74.87Q32.46 73.16 29.41 70.06Q26.37 66.95 24.69 62.69Q23 58.43 23 53.32Q23 48.22 24.69 43.98Q26.37 39.75 29.41 36.65Q32.46 33.54 36.69 31.83Q40.92 30.12 46.03 30.12Q51.13 30.12 55.34 31.83Q59.54 33.54 62.62 36.65Q65.69 39.75 67.37 43.98Q69.06 48.22 69.06 53.32Q69.06 58.43 67.37 62.69Q65.69 66.95 62.62 70.06Q59.54 73.16 55.34 74.87Q51.13 76.58 46.03 76.58ZM46.03 71.13Q49.8 71.13 52.96 69.77Q56.12 68.4 58.44 66Q60.76 63.59 62.01 60.34Q63.26 57.09 63.26 53.32Q63.26 49.55 62.01 46.3Q60.76 43.06 58.44 40.65Q56.12 38.24 52.96 36.91Q49.8 35.57 46.03 35.57Q42.26 35.57 39.1 36.91Q35.94 38.24 33.65 40.65Q31.36 43.06 30.08 46.3Q28.8 49.55 28.8 53.32Q28.8 57.09 30.08 60.34Q31.36 63.59 33.65 66Q35.94 68.4 39.1 69.77Q42.26 71.13 46.03 71.13Z","P":"M36.75 76Q35.47 76 34.6 75.13Q33.73 74.26 33.73 72.98V33.72Q33.73 32.38 34.6 31.54Q35.47 30.7 36.75 30.7H48.35Q52.7 30.7 56.06 32.62Q59.43 34.53 61.31 37.92Q63.2 41.32 63.2 45.72Q63.2 49.96 61.31 53.26Q59.43 56.57 56.06 58.43Q52.7 60.28 48.35 60.28H39.77V72.98Q39.77 74.26 38.92 75.13Q38.08 76 36.75 76ZM39.77 54.71H48.35Q51.02 54.71 53.05 53.55Q55.08 52.39 56.24 50.36Q57.4 48.33 57.4 45.72Q57.4 42.94 56.24 40.82Q55.08 38.71 53.05 37.49Q51.02 36.27 48.35 36.27H39.77Z","Q":"M61.86 75.07 49.74 62.95Q48.81 62.02 48.81 60.89Q48.81 59.76 49.74 58.83Q50.67 57.9 51.8 57.9Q52.93 57.9 53.86 58.83L65.98 71.01Q66.85 71.94 66.88 73.04Q66.91 74.14 65.98 75.07Q65.05 76 63.92 76Q62.79 76 61.86 75.07ZM46.03 76.58Q40.92 76.58 36.69 74.87Q32.46 73.16 29.41 70.06Q26.37 66.95 24.69 62.69Q23 58.43 23 53.32Q23 48.22 24.69 43.98Q26.37 39.75 29.41 36.65Q32.46 33.54 36.69 31.83Q40.92 30.12 46.03 30.12Q51.13 30.12 55.34 31.83Q59.54 33.54 62.62 36.65Q65.69 39.75 67.37 43.98Q69.06 48.22 69.06 53.32Q69.06 58.43 67.37 62.69Q65.69 66.95 62.62 70.06Q59.54 73.16 55.34 74.87Q51.13 76.58 46.03 76.58ZM46.03 71.13Q49.8 71.13 52.96 69.77Q56.12 68.4 58.44 66Q60.76 63.59 62.01 60.34Q63.26 57.09 63.26 53.32Q63.26 49.55 62.01 46.3Q60.76 43.06 58.44 40.65Q56.12 38.24 52.96 36.91Q49.8 35.57 46.03 35.57Q42.26 35.57 39.1 36.91Q35.94 38.24 33.65 40.65Q31.36 43.06 30.08 46.3Q28.8 49.55 28.8 53.32Q28.8 57.09 30.08 60.34Q31.36 63.59 33.65 66Q35.94 68.4 39.1 69.77Q42.26 71.13 46.03 71.13Z","R":"M36.49 76Q35.21 76 34.34 75.13Q33.47 74.26 33.47 72.98V33.72Q33.47 32.38 34.34 31.54Q35.21 30.7 36.49 30.7H46.93Q51.28 30.7 54.64 32.53Q58.01 34.36 59.89 37.55Q61.78 40.74 61.78 44.97Q61.78 48.91 59.89 51.99Q58.01 55.06 54.64 56.8Q51.28 58.54 46.93 58.54H39.5V72.98Q39.5 74.26 38.66 75.13Q37.82 76 36.49 76ZM60.56 76Q59.75 76 59.08 75.65Q58.41 75.3 57.95 74.55L47.51 57.73L53.37 56.05L62.88 71.36Q63.92 73.04 63.17 74.52Q62.41 76 60.56 76ZM39.5 52.97H46.93Q49.6 52.97 51.63 51.96Q53.66 50.94 54.82 49.12Q55.98 47.29 55.98 44.97Q55.98 42.42 54.82 40.45Q53.66 38.47 51.63 37.37Q49.6 36.27 46.93 36.27H39.5Z","S":"M46.23 76.58Q42.52 76.58 39.16 75.42Q35.79 74.26 33.3 72.17Q30.8 70.08 29.64 67.36Q29.06 66.14 29.67 65.1Q30.28 64.05 31.73 63.76Q32.78 63.53 33.79 64.08Q34.81 64.63 35.33 65.73Q36.02 67.18 37.62 68.4Q39.21 69.62 41.48 70.37Q43.74 71.13 46.23 71.13Q49.02 71.13 51.36 70.26Q53.71 69.39 55.16 67.73Q56.61 66.08 56.61 63.65Q56.61 60.57 54.21 58.14Q51.8 55.7 46.29 55.12Q39.1 54.42 34.98 50.89Q30.86 47.35 30.86 42.13Q30.86 38.3 33.01 35.63Q35.15 32.96 38.84 31.57Q42.52 30.18 47.04 30.18Q50.58 30.18 53.22 31.17Q55.86 32.15 57.83 33.89Q59.8 35.63 61.25 38.01Q62.07 39.29 61.92 40.42Q61.78 41.55 60.79 42.19Q59.69 42.88 58.41 42.48Q57.14 42.07 56.5 40.97Q55.57 39.29 54.24 38.13Q52.9 36.97 51.1 36.3Q49.31 35.63 46.87 35.63Q42.58 35.57 39.68 37.23Q36.78 38.88 36.78 42.3Q36.78 44.04 37.68 45.64Q38.58 47.23 40.98 48.39Q43.39 49.55 47.91 50.02Q54.82 50.71 58.67 54.22Q62.53 57.73 62.53 63.47Q62.53 66.78 61.17 69.21Q59.8 71.65 57.51 73.3Q55.22 74.96 52.29 75.77Q49.36 76.58 46.23 76.58Z","T":"M46.03 76Q44.75 76 43.88 75.13Q43.01 74.26 43.01 72.98V30.7H49.05V72.98Q49.05 74.26 48.17 75.13Q47.3 76 46.03 76ZM30.48 36.27Q29.27 36.27 28.48 35.49Q27.7 34.7 27.7 33.49Q27.7 32.27 28.48 31.48Q29.27 30.7 30.48 30.7H61.52Q62.73 30.7 63.52 31.48Q64.3 32.27 64.3 33.49Q64.3 34.7 63.52 35.49Q62.73 36.27 61.52 36.27Z","U":"M46.26 76.93Q40.69 76.93 36.4 74.87Q32.11 72.81 29.7 69.16Q27.29 65.5 27.29 60.8V33.72Q27.29 32.38 28.16 31.54Q29.03 30.7 30.31 30.7Q31.64 30.7 32.49 31.54Q33.33 32.38 33.33 33.72V60.8Q33.33 63.94 34.98 66.34Q36.63 68.75 39.56 70.11Q42.49 71.48 46.26 71.48Q49.91 71.48 52.73 70.11Q55.54 68.75 57.14 66.34Q58.73 63.94 58.73 60.8V33.72Q58.73 32.38 59.6 31.54Q60.47 30.7 61.75 30.7Q63.08 30.7 63.89 31.54Q64.7 32.38 64.7 33.72V60.8Q64.7 65.5 62.36 69.16Q60.01 72.81 55.83 74.87Q51.66 76.93 46.26 76.93Z","V":"M45.97 76Q44.11 76 43.25 74.09L26.25 35.23Q25.44 33.25 26.08 31.98Q26.71 30.7 28.51 30.7Q30.54 30.7 31.3 32.5L46.2 68.29H45.56L60.76 32.5Q61.22 31.46 61.83 31.08Q62.44 30.7 63.49 30.7Q65.23 30.7 65.89 31.95Q66.56 33.2 65.86 34.7L48.7 74.09Q48.29 75.01 47.62 75.51Q46.96 76 45.97 76Z","W":"M34.23 76Q33.18 76 32.37 75.36Q31.56 74.72 31.21 73.62L19.55 34.88Q18.97 32.96 19.64 31.83Q20.31 30.7 21.81 30.7Q22.8 30.7 23.61 31.25Q24.42 31.8 24.77 32.96L34.92 68.34H33.65L43.04 33.31Q43.27 32.44 44.09 31.86Q44.9 31.28 45.94 31.28Q46.87 31.28 47.71 31.77Q48.55 32.27 48.78 33.25L58.24 68.34H57.08L67.29 32.67Q67.87 30.7 70.24 30.7Q71.87 30.7 72.33 31.95Q72.8 33.2 72.33 34.88L60.67 73.56Q60.27 74.67 59.48 75.33Q58.7 76 57.66 76Q56.56 76 55.77 75.3Q54.99 74.61 54.64 73.62L45.3 37.55H46.7L37.24 73.56Q36.84 74.67 36.05 75.33Q35.27 76 34.23 76Z","X":"M30.86 76Q29.53 76 28.83 75.16Q28.14 74.32 28.14 73.19Q28.14 72.06 28.83 71.13L43.45 51.64L46.06 49.32L59.4 31.57Q60.21 30.7 61.54 30.7Q62.76 30.7 63.46 31.46Q64.15 32.21 64.21 33.31Q64.27 34.41 63.57 35.46L49.48 54.25L46.99 56.45L32.95 75.13Q32.08 76 30.86 76ZM61.2 76Q60.44 76 59.89 75.74Q59.34 75.48 58.88 74.9L45.36 56.16L43.22 54.37L29.59 35.46Q28.89 34.53 29.01 33.43Q29.12 32.33 29.85 31.51Q30.57 30.7 31.79 30.7Q33.3 30.7 33.94 31.57L46.81 49.44L49.02 51.23L63.34 71.13Q64.04 72.06 63.98 73.22Q63.92 74.38 63.2 75.19Q62.47 76 61.2 76Z","Y":"M45.94 76Q44.72 76 43.85 75.13Q42.98 74.26 42.98 72.98V59.47L27.5 35.4Q26.74 34.18 26.92 33.11Q27.09 32.04 27.93 31.37Q28.77 30.7 29.88 30.7Q30.86 30.7 31.44 31.14Q32.02 31.57 32.54 32.38L47.28 55.76H44.96L59.92 32.15Q60.38 31.46 61.02 31.08Q61.66 30.7 62.59 30.7Q63.63 30.7 64.33 31.43Q65.02 32.15 65.14 33.22Q65.26 34.3 64.56 35.4L48.96 59.47V72.98Q48.96 74.26 48.09 75.13Q47.22 76 45.94 76Z","Z":"M30.63 76Q29.3 76 28.51 75.13Q27.73 74.26 27.64 73.13Q27.56 72 28.25 71.13L56.61 36.04H31.21Q29.76 36.04 29.03 35.31Q28.31 34.59 28.37 33.49Q28.31 32.27 29.18 31.48Q30.05 30.7 31.33 30.7H61.25Q62.59 30.7 63.4 31.51Q64.21 32.33 64.33 33.46Q64.44 34.59 63.69 35.46L35.21 70.66H61.25Q62.59 70.66 63.4 71.45Q64.21 72.23 64.21 73.27Q64.21 74.55 63.4 75.28Q62.59 76 61.25 76Z"};
const TILE_VALUE_PATHS = {"1":"M76.19 28V25.14H80.96V12L76.34 14.89V11.87L81.17 8.74H84.8V25.14H89.22V28Z","2":"M75.4 28V25.33Q76.15 23.68 77.54 22.11Q78.93 20.54 81.03 18.83Q83.05 17.19 83.87 16.12Q84.68 15.05 84.68 14.03Q84.68 11.51 82.15 11.51Q80.92 11.51 80.27 12.17Q79.62 12.84 79.43 14.16L75.56 13.95Q75.89 11.27 77.57 9.86Q79.24 8.45 82.12 8.45Q85.24 8.45 86.91 9.87Q88.58 11.29 88.58 13.86Q88.58 15.22 88.04 16.31Q87.51 17.4 86.68 18.33Q85.84 19.25 84.83 20.06Q83.81 20.86 82.85 21.63Q81.89 22.39 81.11 23.17Q80.32 23.95 79.94 24.84H88.88V28Z","3":"M88.99 22.65Q88.99 25.36 87.21 26.84Q85.43 28.31 82.15 28.31Q79.05 28.31 77.22 26.89Q75.38 25.46 75.07 22.76L78.98 22.42Q79.35 25.2 82.14 25.2Q83.52 25.2 84.29 24.51Q85.05 23.83 85.05 22.42Q85.05 21.14 84.12 20.45Q83.19 19.77 81.36 19.77H80.02V16.67H81.28Q82.93 16.67 83.77 15.99Q84.6 15.31 84.6 14.05Q84.6 12.87 83.94 12.19Q83.27 11.51 82 11.51Q80.81 11.51 80.08 12.17Q79.35 12.82 79.24 14.03L75.4 13.75Q75.7 11.27 77.46 9.86Q79.23 8.45 82.07 8.45Q85.09 8.45 86.79 9.81Q88.5 11.17 88.5 13.58Q88.5 15.38 87.44 16.54Q86.38 17.71 84.38 18.09V18.14Q86.6 18.4 87.79 19.6Q88.99 20.79 88.99 22.65Z","4":"M87.28 24.08V28H83.62V24.08H74.85V21.19L82.99 8.74H87.28V21.22H89.85V24.08ZM83.62 14.92Q83.62 14.18 83.66 13.32Q83.71 12.46 83.74 12.21Q83.38 12.97 82.45 14.42L77.98 21.22H83.62Z","5":"M89.22 21.59Q89.22 24.65 87.31 26.46Q85.41 28.27 82.08 28.27Q79.19 28.27 77.44 26.97Q75.7 25.66 75.29 23.19L79.13 22.87Q79.43 24.1 80.2 24.66Q80.96 25.22 82.12 25.22Q83.56 25.22 84.42 24.31Q85.27 23.39 85.27 21.67Q85.27 20.15 84.46 19.24Q83.66 18.33 82.21 18.33Q80.61 18.33 79.6 19.58H75.85L76.52 8.74H88.1V11.59H80.01L79.69 16.46Q81.09 15.23 83.18 15.23Q85.93 15.23 87.57 16.94Q89.22 18.65 89.22 21.59Z","6":"M88.99 21.7Q88.99 24.77 87.27 26.52Q85.54 28.27 82.51 28.27Q79.1 28.27 77.28 25.89Q75.45 23.5 75.45 18.81Q75.45 13.66 77.31 11.05Q79.16 8.45 82.6 8.45Q85.05 8.45 86.47 9.53Q87.88 10.61 88.47 12.88L84.85 13.38Q84.33 11.48 82.52 11.48Q80.98 11.48 80.09 13.03Q79.21 14.57 79.21 17.72Q79.83 16.69 80.92 16.15Q82.02 15.6 83.4 15.6Q85.98 15.6 87.48 17.24Q88.99 18.88 88.99 21.7ZM85.13 21.81Q85.13 20.17 84.37 19.3Q83.62 18.43 82.29 18.43Q81.02 18.43 80.25 19.24Q79.49 20.06 79.49 21.4Q79.49 23.08 80.29 24.18Q81.09 25.28 82.38 25.28Q83.68 25.28 84.41 24.36Q85.13 23.43 85.13 21.81Z","8":"M89.14 22.57Q89.14 25.28 87.35 26.78Q85.56 28.27 82.23 28.27Q78.94 28.27 77.13 26.78Q75.32 25.29 75.32 22.6Q75.32 20.75 76.38 19.49Q77.45 18.22 79.24 17.92V17.87Q77.68 17.53 76.72 16.32Q75.77 15.12 75.77 13.55Q75.77 11.18 77.44 9.82Q79.12 8.45 82.18 8.45Q85.31 8.45 86.99 9.78Q88.66 11.12 88.66 13.58Q88.66 15.15 87.71 16.34Q86.76 17.53 85.16 17.84V17.9Q87.02 18.2 88.08 19.42Q89.14 20.64 89.14 22.57ZM84.71 13.78Q84.71 12.41 84.08 11.78Q83.45 11.14 82.18 11.14Q79.69 11.14 79.69 13.78Q79.69 16.54 82.21 16.54Q83.46 16.54 84.09 15.9Q84.71 15.26 84.71 13.78ZM85.16 22.26Q85.16 19.24 82.15 19.24Q80.76 19.24 80.01 20.03Q79.27 20.82 79.27 22.31Q79.27 24.01 80.01 24.79Q80.74 25.57 82.26 25.57Q83.75 25.57 84.46 24.79Q85.16 24.01 85.16 22.26Z","9":"M88.96 18.06Q88.96 23.19 87.09 25.73Q85.21 28.27 81.77 28.27Q79.23 28.27 77.78 27.19Q76.34 26.1 75.74 23.75L79.35 23.24Q79.88 25.25 81.81 25.25Q83.42 25.25 84.29 23.71Q85.16 22.16 85.19 19.13Q84.67 20.15 83.49 20.73Q82.3 21.31 80.94 21.31Q78.39 21.31 76.9 19.58Q75.4 17.86 75.4 14.9Q75.4 11.87 77.16 10.16Q78.91 8.45 82.12 8.45Q85.58 8.45 87.27 10.85Q88.96 13.25 88.96 18.06ZM84.9 15.37Q84.9 13.58 84.11 12.52Q83.33 11.46 82.03 11.46Q80.76 11.46 80.03 12.38Q79.29 13.3 79.29 14.93Q79.29 16.53 80.02 17.49Q80.74 18.46 82.04 18.46Q83.27 18.46 84.09 17.62Q84.9 16.78 84.9 15.37Z","10":"M60.62 28V25.14H65.39V12L60.77 14.89V11.87L65.6 8.74H69.23V25.14H73.65V28Z M88.85 18.36Q88.85 23.24 87.18 25.76Q85.5 28.27 82.15 28.27Q75.54 28.27 75.54 18.36Q75.54 14.9 76.26 12.71Q76.98 10.53 78.43 9.49Q79.88 8.45 82.26 8.45Q85.68 8.45 87.27 10.92Q88.85 13.4 88.85 18.36ZM85 18.36Q85 15.7 84.74 14.22Q84.48 12.74 83.9 12.1Q83.33 11.46 82.23 11.46Q81.07 11.46 80.48 12.11Q79.88 12.76 79.63 14.23Q79.38 15.7 79.38 18.36Q79.38 21 79.64 22.48Q79.91 23.97 80.49 24.61Q81.07 25.25 82.18 25.25Q83.27 25.25 83.87 24.58Q84.46 23.9 84.73 22.41Q85 20.92 85 18.36Z"};
function tileSVG(letter) {
  const val = ({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter];
  const gid = 'tg' + (tileSVG.n = (tileSVG.n || 0) + 1);
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7df3ff"/><stop offset="50%" stop-color="#03eaff"/><stop offset="100%" stop-color="#00b8d2"/></linearGradient></defs><rect x="0.5" y="0.5" width="99" height="99" rx="9" fill="url(#${gid})" stroke="rgba(0,90,110,0.4)"/><path d="${TILE_LETTER_PATHS[letter]}" fill="#1a1d24" stroke="#1a1d24" stroke-width="3" stroke-linejoin="round" paint-order="stroke"/><path d="${TILE_VALUE_PATHS[String(val)]}" fill="#1a1d24" stroke="#1a1d24" stroke-width="1" stroke-linejoin="round" paint-order="stroke"/></svg>`;
}
// Out of time = human clock at 0 (displayed, i.e. elapsed-adjusted on
// your turn), whatever the turn field currently says: after timeout the
// turn flips to the bot, but the human clock is still 0.
function humanOutOfTime() {
  if (!game || game.status !== 'active') return false;
  const humanRemaining = Math.max(0, game.clocks.turn === 'human' ? game.clocks.human - (Date.now() - gameFetchAt) : game.clocks.human);
  return humanRemaining <= 0;
}
// v138: a bot game (Doppelgänger/Fishstick) with no moves played
// yet is a free exit — forfeiting records nothing, so the button
// reads "Exit" instead of "Forfeit". Persona and real-player games
// never get a free exit (their forfeit is a loss even before the
// first move), so they always read "Forfeit" until the clock runs
// out. Out of time is always "Exit" now — the old "Leave" (out of
// time + losing) is renamed, not removed. No button anywhere in the
// game says "Leave" anymore.
function isFreeExitBotGame() {
  return !!(game && (game.botType === 'competitive' || game.botType === 'fishstick')
    && Array.isArray(game.moveLog) && game.moveLog.length === 0);
}
function forfeitLabel() {
  if (isFreeExitBotGame()) return 'Exit';
  if (humanOutOfTime()) return 'Exit';
  return 'Forfeit';
}
// After your time expires the Forfeit button reads "Exit" instead:
// the opponent plays on, but you can leave without waiting. Never
// overwrites the armed "SURE?" confirm, and only writes when the
// label actually changes, so it is cheap to call every tick.
function updateForfeitLabel() {
  const btn = $('forfeitBtn');
  if (!btn || armed[btn.id]) return;
  const label = forfeitLabel();
  if (btn.textContent !== label) btn.textContent = label;
}
// Post-game replay (v123, items 5+6): step through the finished
// game's move sequence. The board at step n is the empty board plus
// the placements of moveLog[0..n-1]; the scores are the running
// totals at that step. moveLog is chronological (the server records
// it in applyMove, the client in applyLocalMove), so a clock-0
// stretch where one side plays several moves in a row replays in
// exactly the order it was played. Games without a moveLog (played
// before v123) show the final board only — the arrows are disabled.
function replayStateAt(n) {
  const board = Array.from({ length: 10 }, () => Array(10).fill(null));
  let human = 0, bot = 0;
  const log = (game && game.moveLog) || [];
  for (let i = 0; i < n && i < log.length; i++) {
    const m = log[i];
    (m.placements || []).forEach((p) => { board[p.row][p.col] = p.letter; });
    if (m.side === 'human') human += m.score || 0; else bot += m.score || 0;
  }
  return { board, human, bot };
}
function replayCanStep() {
  return !!(game && game.status === 'finished' && Array.isArray(game.moveLog) && game.moveLog.length > 0);
}
// Per-player clock rewind (v128, item 1; fixed v155): each side's
// remaining time at replay step n comes from the nearest moveLog
// entry at or before n — every entry carries BOTH clocks as of
// right after that move. The old per-side walk (each side's clock
// from that side's own most recent move) was wrong when a clock
// changed without its owner moving: a clock that runs to 0 on its
// owner's turn logs no move for that turn, and a -30s pass is never
// logged either, so the change is only recorded in the next mover's
// snapshot — and the replay froze the dead clock at its last move's
// value (0:02) for the whole trailing stretch instead of 0:00.
// Step 0 is the start, the final step is the game's actual final
// clocks, and a log with no clocks at all (pre-v126) falls back to
// the final clocks.
function replayClocksAt(n) {
  const log = (game && game.moveLog) || [];
  const total = log.length;
  if (n === 0) return { human: 240000, bot: 240000 };
  if (n >= total) return { human: game.clocks.human, bot: game.clocks.bot };
  for (let i = n - 1; i >= 0; i--) {
    const e = log[i];
    if (e && e.clocks) return { human: e.clocks.human, bot: e.clocks.bot };
  }
  return { human: game.clocks.human, bot: game.clocks.bot };
}
// v148: whether the move at replay step n was optimal. The moveLog
// entry carries no isOptimal flag — it lives on game.moves[side] —
// so match by index: the nth play by side S in the log is
// game.moves[S][n]. Passes are never logged, so the counts align.
function replayMoveIsOptimal(n) {
  if (!game || !game.moveLog || n < 1 || n > game.moveLog.length) return false;
  const m = game.moveLog[n - 1];
  const moves = (game.moves && game.moves[m.side]) || [];
  let idx = -1;
  for (let i = 0; i < n; i++) if (game.moveLog[i].side === m.side) idx++;
  return !!(moves[idx] && moves[idx].isOptimal);
}
// v170: the last cell of the main word on a replayed board — where
// the review's point bubble rides. moveLog placements are in DROP
// order (the server stores them verbatim), so the last placement is
// the last tile the player happened to drop, not the last letter of
// the word: Jeff's AX (X dropped first) put the bubble on A. The
// replayed board at this step already holds the main word, so walk
// its run: the placed tiles all lie on the main word's line, and the
// run along that line — extended over pre-existing tiles the word
// was built off — IS the main word. Its last cell is the target.
// A single placement gives no direction from the placements alone,
// so the run whose letters spell mainWord wins (horizontal first).
// Falls back to the positionally last placed tile in the play
// direction — the live board's showBubble fallback — when the run
// does not match (a log that predates mainWord, or a corrupt one).
function replayMainWordLastCell(board, m) {
  const pls = (m && m.placements) || [];
  if (!pls.length) return null;
  const word = String((m && m.mainWord) || '').toUpperCase();
  const runCells = (r, c, dr, dc) => {
    let sr = r, sc = c;
    while (board[sr - dr] && board[sr - dr][sc - dc]) { sr -= dr; sc -= dc; }
    const cells = [];
    let cr = sr, cc = sc;
    while (board[cr] && board[cr][cc]) { cells.push([cr, cc]); cr += dr; cc += dc; }
    return cells;
  };
  const lettersOf = (cells) => cells.map(([r, c]) => board[r][c]).join('');
  const sameRow = pls.every((p) => p.row === pls[0].row);
  const sameCol = pls.every((p) => p.col === pls[0].col);
  const dirs = [];
  if (sameRow) dirs.push([0, 1]);
  if (sameCol) dirs.push([1, 0]);
  if (!dirs.length) dirs.push([0, 1], [1, 0]);
  for (const [dr, dc] of dirs) {
    const cells = runCells(pls[0].row, pls[0].col, dr, dc);
    if (!word || lettersOf(cells) === word) return cells[cells.length - 1];
  }
  const sorted = pls.slice().sort((a, b) => sameRow ? a.col - b.col : a.row - b.row);
  const last = sorted[sorted.length - 1];
  return [last.row, last.col];
}
function renderReplay() {
  if (replayIndex === null || !game) return;
  const log = game.moveLog || [];
  const n = Math.max(0, Math.min(replayIndex, log.length));
  replayIndex = n;
  const total = log.length;
  const st = replayStateAt(n);
  // Rebuild the board from the replay state (no pending tiles, no
  // drag — the game is over). The last move applied is highlighted.
  const lastCells = new Set(n > 0 ? (log[n - 1].placements || []).map((p) => p.row + ',' + p.col) : []);
  const boardEl = $('board'); boardEl.innerHTML = '';
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    const cell = document.createElement('div');
    const prem = game.premiums[`${r},${c}`];
    cell.className = 'cell' + (prem ? ' ' + prem : '') + (lastCells.has(r + ',' + c) ? ' last-word' : '');
    const letter = st.board[r][c];
    cell.textContent = letter ? '' : (prem || '');
    if (letter) {
      const t = document.createElement('div'); t.className = 'tile'; t.innerHTML = tileSVG(letter);
      // v163: definitions work during a review too — the same tap
      // opens the word's definition, read off the board at this
      // replay step (showDefinition uses the viewed board).
      t.addEventListener('pointerdown', () => {
        if (!$('defPopover').classList.contains('hidden')) return;
        defJustOpened = true;
        showDefinition(r, c);
      });
      cell.appendChild(t);
    }
    boardEl.appendChild(cell);
  }
  $('scoreHuman').textContent = String(st.human);
  $('scoreBot').textContent = String(st.bot);
  // Clocks rewind to the move (v126; v155: the snapshot, not the
  // per-side walk — each entry carries both clocks as of right after
  // that move, so the nearest entry's snapshot is the true time at
  // the viewed step, including a clock that ran to 0 without its
  // owner moving). Step 0 is the start (4:00 each); the final board
  // shows the game's actual final clocks. Entries logged before
  // v126 carry no clocks — if no entry up to step n has clocks,
  // fall back to the final clocks rather than a wrong time.
  const rc = replayClocksAt(n);
  $('clockHuman').textContent = fmtClock(rc.human);
  $('clockBot').textContent = fmtClock(rc.bot);
  // The point bubble rides with the move just applied (v124): the
  // same +score bubble the live board shows on the last play, so
  // scrolling through the replay shows what each play was worth. A
  // pass has no placements and leaves no bubble. The board was just
  // rebuilt, so no stale bubble survives to clear. v170: the bubble
  // rides on the LAST LETTER of the main word (replayMainWordLastCell
  // walks the word's run on the replayed board) — NOT the last tile
  // dropped, which is what moveLog placements record.
  if (n > 0) {
    const m = log[n - 1];
    const target = replayMainWordLastCell(st.board, m);
    if (target) attachBubble(m.score || 0, target, 'last');
  }
  // Status names the step, without the move count (v124): no
  // "Move x of y" — just who played what, or the start / final.
  // v133: the final board names the last play too ("You played CAT"),
  // no +score — the same who logic as the intermediate steps. A log
  // with no moves falls back to 'Final board'.
  // v148: every "___ played ___" line was Duello blue, with
  // "• Optimal move!" when that move was optimal (same optimality
  // data as the stat window's tally). v160: blue ONLY when the move
  // was optimal — a plain played line stays the default color.
  // Start / Final board stay the default color.
  const statusEl = $('status');
  const playedLine = (who, m, withScore) => {
    const opt = replayMoveIsOptimal(n);
    const optMark = opt ? ' • Optimal move!' : '';
    statusEl.textContent = `${who} played ${m.mainWord || ''}${withScore ? ' +' + (m.score || 0) : ''}${optMark}`;
    statusEl.classList.toggle('review-played', opt);
  };
  if (n === 0) { statusEl.textContent = 'Start of game'; statusEl.classList.remove('review-played'); }
  else if (n === total) {
    const m = log[total - 1];
    if (m) {
      const who = m.side === 'human' ? 'You' : ($('botName').textContent || 'Opponent');
      playedLine(who, m, false);
    } else { statusEl.textContent = 'Final board'; statusEl.classList.remove('review-played'); }
  }
  else {
    const m = log[n - 1];
    const who = m.side === 'human' ? 'You' : ($('botName').textContent || 'Opponent');
    playedLine(who, m, true);
  }
  // One shared arrows row now (v124): the review buttons are gone,
  // so only these two exist.
  const back = $('replayBackBtn'), fwd = $('replayFwdBtn');
  if (back) back.disabled = n === 0;
  if (fwd) fwd.disabled = n === total;
}
function stepReplay(dir) {
  if (!replayCanStep()) return;
  const total = game.moveLog.length;
  if (replayIndex === null) replayIndex = total;
  replayIndex = Math.max(0, Math.min(total, replayIndex + dir));
  renderReplay();
}
function clearReplay() { replayIndex = null; }
function renderGame() {
  if (!game) return;
  // v148: live play never shows the review's blue "played" line.
  const statusEl = $('status'); if (statusEl) statusEl.classList.remove('review-played');
  // Never rebuild the board/rack while a drag is live: re-creating the
  // captured tile mid-drag destroys it and can strand pointer capture,
  // which is how a drag froze the whole screen. The next render after the
  // drag ends will show any bot move that arrived in the meantime.
  if (activeDragCleanup) return;
  // Out of time: any tiles placed but not yet played go straight
  // back to the rack, instead of sitting on the board unplayable
  // while the opponent plays on. Placements are client-only until
  // Play, so this needs no server call. Skipped while a play is in
  // flight, since the server reply settles those tiles.
  if (game.status === 'active' && game.clocks.human <= 0 && !playInFlight && pending.length > 0) {
    pending = []; selectedRack = null;
  }
  $('playerName').textContent = me && me.firstName ? me.firstName : 'You';
  try { const pp = document.querySelector('.player-panel .pfp'); pp.innerHTML = pfpHTML(me); pp.classList.toggle('no-photo', !usablePhoto(me)); const sp = document.querySelector('.stat-pfp .pfp'); sp.innerHTML = pfpHTML(me); sp.classList.toggle('no-photo', !usablePhoto(me)); } catch {}
  $('playerElo').textContent = (game.player && game.player.elo != null) ? game.player.elo : (me ? me.elo : '');
  const isFish = game.botType === 'fishstick';
  const isPersonaGame = game.botType === 'persona';
  const isHumanGame = game.botType === 'human';
  $('botName').textContent = isFish ? 'Fishstick' : isPersonaGame ? (game.persona?.firstName || 'Player') : isHumanGame ? (game.opponent?.firstName || 'Player') : 'Doppelgänger';
  $('botElo').textContent = isFish ? '∞' : game.botElo;
  $('botElo').classList.toggle('inf', isFish);
  if (isFish) $('botPfp').innerHTML = '<img src="/assets/fishstick.png?v=1" alt="Fishstick">';
  else if (isPersonaGame && usablePhoto(game.persona)) $('botPfp').innerHTML = `<img src="${game.persona.photoData}" alt="">`;
  else if (isHumanGame && usablePhoto(game.opponent)) $('botPfp').innerHTML = `<img src="${game.opponent.photoData}" alt="">`;
  // A persona with no photo is a person without a photo, not a bot:
  // show the silhouette (with the blue no-photo ring, like the
  // player's own) instead of the robot, which is Doppelgänger.
  // Same for a real opponent without a photo.
  else if (isPersonaGame) $('botPfp').innerHTML = silhouetteSVG(32);
  else if (isHumanGame) $('botPfp').innerHTML = silhouetteSVG(32);
  else $('botPfp').textContent = '🤖';
  $('botPfp').classList.toggle('no-photo', (isPersonaGame && !usablePhoto(game.persona)) || (isHumanGame && !usablePhoto(game.opponent)));
  // v135: the 🤖 sits straight on the scoreboard with no grey circle,
  // same as Fishstick's PNG — clear-bg for a Doppelgänger game too
  // (its pfp is the 🤖 emoji), not just Fishstick.
  $('botPfp').classList.toggle('clear-bg', isFish || game.botType === 'competitive');
  // Disconnect (v123, item 2): a real opponent who has been unseen
  // for >10s gets a faded grey pfp (server's opponentConnected) —
  // their clock keeps ticking, and at 30s the server ends the game.
  $('botPfp').classList.toggle('gone', isHumanGame && game.opponentConnected === false);
  document.querySelector('.player-panel').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'human');
  document.querySelector('.bot-panel').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'bot');
  $('scoreHuman').textContent = String(game.scores.human); $('scoreBot').textContent = String(game.scores.bot);
  const lastHtml = (l) => {
    if (!l) return '';
    if (l.passed) {
      if (l.noMoves) return '<span class="lp-words">No moves available, passed</span> <span class="pts">-30s</span>';
      return '<span class="lp-words">passed</span> <span class="pts">-30s</span>';
    }
    const words = (l.words && l.words.length) ? l.words : [l.word];
    return `<span class="lp-words">${words.join(', ')}</span> <span class="pts">+${l.points}${l.bingo ? ' <span class="bingo">bingo! +30</span>' : ''}${l.isDuello ? ' Duello +30' : ''}</span>`;
  };
  // The last move always shows, even in a one-sided stretch: when a
  // clock is at 0, that side can never have moved last, so the other
  // side's last move is the most recent one whatever the turn says.
  // (In a normal alternating game this is identical to the old
  // turn-based pick; it only changes the out-of-time stretches,
  // where the turn-based pick showed a stale move from the side
  // that can no longer move.)
  let shownLast;
  // Blank after a game / in a review (v126): the last-play line under
  // the scoreboard is for a live game. A finished game shows the move
  // in the replay status instead, so this stays empty.
  if (game.status === 'finished') shownLast = null;
  else if (game.clocks.human <= 0) shownLast = game.lastBot || game.lastHuman;
  else if (game.clocks.bot <= 0) shownLast = game.lastHuman || game.lastBot;
  else shownLast = game.clocks.turn === 'human' ? (game.lastBot || game.lastHuman) : (game.lastHuman || game.lastBot);
  $('lastPlay').innerHTML = lastHtml(shownLast);
  $('lastPlay').classList.toggle('from-human', !!shownLast && shownLast === game.lastHuman);
  $('lastPlay').classList.toggle('from-bot', !!shownLast && shownLast === game.lastBot);
  // Inner 6x6 glow lives in a persistent overlay (see index.html), not on
  // the board cells: renderGame rebuilds every cell, and each rebuild
  // restarted the 3.2s pulse, so the glow visibly jumped at the end of
  // the 5s countdown. The overlay is never rebuilt, so its pulse runs
  // steadily before, during, and after the countdown; it is only shown
  // (opacity, never display) while the first word is still unplayed.
  if ($('innerGlow')) $('innerGlow').classList.toggle('on', !!game.isFirst);
  // Board
  const boardEl = $('board'); boardEl.innerHTML = '';
  const lastSet = new Set((game.lastCells || []).map(([r, c]) => r + ',' + c));
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    const cell = document.createElement('div');
    const prem = game.premiums[`${r},${c}`];
    cell.className = 'cell' + (prem ? ' ' + prem : '') + (lastSet.has(r + ',' + c) ? ' last-word' : '');
    const pend = pending.find(p => p.row === r && p.col === c);
    const letter = boardCell(r, c) || (pend ? pend.letter : null);
    // A premium label must never share the cell with a tile: the cell is a
    // flex container, so the label + tile split the width and the tile (and
    // its letter) was squeezed to about half width on DL/DW/TL/TW squares.
    cell.textContent = letter ? '' : (prem || '');
    if (letter) {
      const t = document.createElement('div'); t.className = 'tile' + (pend ? ' pending' : '');
      t.innerHTML = tileSVG(letter);
      if (pend) enablePlacedDrag(t, pend);
      else t.addEventListener('pointerdown', () => {
        // If a definition is already open, this tap only dismisses it —
        // it does not open this word's definition. The document
        // pointerdown listener below hides the popover, and a second
        // tap on the word opens its definition.
        if (!$('defPopover').classList.contains('hidden')) return;
        defJustOpened = true;
        showDefinition(r, c);
      });
      cell.appendChild(t);
    } else {
      cell.onclick = () => { if (suppressNextClick) { suppressNextClick = false; return; } if (selectedRack !== null) placeTile(r, c); };
    }
    boardEl.appendChild(cell);
  }
  // Rack: during the countdown, show the rack as empty slots (no letters)
  // and the buttons, so the board/rack/buttons keep exactly the same
  // positions after the wait instead of jumping in when they appear.
  const rackEl = $('rack'); rackEl.innerHTML = '';
  rackEl.classList.toggle('greyed', game.clocks.turn !== 'human' && game.status === 'active');
  if (countdownActive) {
    for (let idx = 0; idx < 6; idx++) { const s = document.createElement('div'); s.className = 'tile empty'; rackEl.appendChild(s); }
  }
  game.humanRack.forEach((letter, idx) => {
    if (countdownActive) return;
    if (!letter) { const s = document.createElement('div'); s.className = 'tile empty'; rackEl.appendChild(s); return; }
    if (!optimisticPlay && pending.some(p => p.rackIndex === idx)) { const s = document.createElement('div'); s.className = 'tile empty'; rackEl.appendChild(s); return; }
    const t = document.createElement('div'); t.className = 'tile'; t.dataset.idx = idx;
    t.innerHTML = tileSVG(letter);
    if (selectedRack === idx) t.style.outline = '2px solid #ffd166';
    if (!optimisticPlay) enableRackDrag(t, idx);
    rackEl.appendChild(t);
  });
  // Controls / end state
  const finished = game.status === 'finished';
  // Recall only when a tile is actually placed; Pass only on your turn.
  // Both are greyed (disabled) otherwise, instead of tappable-but-dead.
  const yourTurn = game.status === 'active' && game.clocks.turn === 'human' && !playInFlight;
  const outOfTime = humanOutOfTime();
  $('recallBtn').disabled = countdownActive || !(yourTurn && pending.length > 0);
  // No passing in a one-sided stretch: when the opponent's clock is
  // at 0, the human plays on alone and cannot pass. Disabled also
  // drops the blue highlight (see .controls button:disabled), so the
  // button reads as truly unavailable, not just unresponsive.
  $('passBtn').disabled = countdownActive || !yourTurn || game.clocks.bot <= 0 || outOfTime;
  // Shuffle is available at all times during the game, including
  // while a Play is in flight and when out of time: the button used
  // to grey out for the whole Play round-trip, which felt like seconds.
  // The click handler below does a local-only shuffle while a Play is
  // in flight (the rack has blank slots then, so a server shuffle
  // would be rejected), and a server shuffle otherwise.
  $('shuffleBtn').disabled = false;
  // Forfeit is available at all times during an active game, including
  // the 5s countdown (v107 — it used to be disabled until the countdown
  // ended, so a mistap left no way out but to wait). The game is
  // finished when it ends, so the controls hide with it.
  $('forfeitBtn').disabled = false;
  updateForfeitLabel();
  // v154: scoped to the game's own controls row — the unscoped
  // '.controls' selector used to grab the puzzle screen's row first
  // (it comes earlier in the document), so finishing a real game
  // hid the puzzle's Exit / Share buttons until the next game.
  $('gameControls').classList.toggle('hidden', finished);
  // Post-game buttons (v123, arrows moved out in v124): a finished
  // game shows Main Menu / Play Again / Game Stats — except a game
  // opened from Game History, which shows Exit / Game Stats instead
  // (no Play Again — it is a past game).
  $('endButtons').classList.toggle('hidden', !finished || reviewMode);
  $('reviewButtons').classList.toggle('hidden', !finished || !reviewMode);
  // Deck / arrows (v124): once the game is finished the deck goes
  // away and the shared arrows row sits in its place, above the
  // buttons. A live game keeps the deck and hides the arrows.
  $('rack').classList.toggle('hidden', finished);
  $('replayArrows').classList.toggle('hidden', !finished);
  $('gameDim').classList.toggle('dimmed', finished && !$('statWindow').classList.contains('hidden'));
  // Every finish shows the stats window at once now, including
  // time expiry (Nov 5, 2026 — the old 3s final-board view is
  // gone). Tapping the backdrop still dismisses it to the board.
  if (finished && game.stats) showStatWindowDelayed(game.stats);
  tickClocks();
  if (countdownActive) { $('clockHuman').textContent = '4:00'; $('clockBot').textContent = '4:00'; }
  updateStatus();
  // The point bubble stays on the board for the last played word:
  // renderGame rebuilds every cell, so a bubble attached to one is
  // destroyed at the next render — re-attach it here, after
  // updateStatus has shown (or hidden) the pending play's bubble.
  // Only one bubble ever shows: if a pending bubble is up, the last
  // play's stays off. A pass leaves no bubble. A play still in flight
  // keeps its optimistic bubble on the just-played word instead of
  // leaving the board bare until the server reply lands.
  if (!document.querySelector('.play-bubble') && game.lastCells && game.lastCells.length) {
    if (pending.length && playInFlight && lastValidate && lastValidate.valid && lastValidate.mainCells && lastValidate.mainCells.length) {
      attachBubble(lastValidate.score, lastValidate.mainCells[lastValidate.mainCells.length - 1], 'last');
    } else if (!pending.length) {
      const lastMove = game.lastBy === 'human' ? game.lastHuman : game.lastBy === 'bot' ? game.lastBot : null;
      if (lastMove && !lastMove.passed) attachBubble(lastMove.points, game.lastCells[game.lastCells.length - 1], 'last');
    }
  }
  // Replay (v123, items 5+6): a render after the game ended (a poll
  // landing, the stat window dismissing) rebuilds the board from the
  // final state — re-apply the replay step on top so the arrows keep
  // showing the step the player is on.
  // Replay entry (v125): a finished game with a log starts at the
  // final board, so the arrows are live from the first render. The
  // disabled flag is sticky across games — renderReplay is the only
  // thing that sets it, and it only runs while replayIndex is set —
  // so a previous no-log game (or a replay left at an end) left both
  // arrows dead for the next finished game that has a log, which is
  // why Fishstick's arrows did nothing. Initialising the index here
  // makes renderReplay run and set the arrows (back live, forward
  // off at the final board) the moment the game ends.
  if (finished && replayIndex === null && replayCanStep()) replayIndex = game.moveLog.length;
  if (replayIndex !== null && game.status === 'finished') renderReplay();
  // No replay possible (no moveLog): the arrows stay disabled
  // instead of looking live and doing nothing (v124).
  if (finished && !replayCanStep()) {
    const back = $('replayBackBtn'), fwd = $('replayFwdBtn');
    if (back) back.disabled = true;
    if (fwd) fwd.disabled = true;
  }
}
let runoffUntil = 0, humanRunoffUntil = 0, timeoutFetching = false, timeoutLastAttempt = 0, timeoutFlipUnconfirmed = false;
// Byoyomi (v157): when one main clock hits 0, the player who still has
// time gets a 9s countdown on their scoreboard (red, outside the
// regular clock toward the PFP). byoyomiSide is the side with the
// countdown ('human' | 'bot' | null); byoyomiEndsAt is when the
// current 9s window expires. It resets on every move by the
// countdown player; the game ends when it hits 0. The at-0 player
// keeps skipping turns exactly as before — the countdown only
// time-pressures the player who still has time, so rushing no
// longer buys free, unhurried solo moves.
const BYOYOMI_MS = 9000;
let byoyomiSide = null, byoyomiEndsAt = 0, byoyomiLastLogLen = 0;
function armByoyomi(side) {
  if (byoyomiSide) return;
  byoyomiSide = side; byoyomiEndsAt = Date.now() + BYOYOMI_MS;
  byoyomiLastLogLen = (game && Array.isArray(game.moveLog)) ? game.moveLog.length : 0;
  updateByoyomiDisplay();
}
function resetByoyomi(side) {
  // Only the countdown player's own move resets it (the at-0 side
  // never moves, so a reset from them cannot happen — the side
  // check is a guard, not a behaviour).
  if (!byoyomiSide || byoyomiSide !== side) return;
  byoyomiEndsAt = Date.now() + BYOYOMI_MS;
  updateByoyomiDisplay();
}
function clearByoyomi() {
  byoyomiSide = null; byoyomiEndsAt = 0;
  updateByoyomiDisplay();
}
function updateByoyomiDisplay() {
  // Show the countdown on the side that has it, hide the other.
  // The remaining seconds, ceiled, from the live deadline — the
  // 100ms tick re-renders it, so it visibly counts down.
  for (const side of ['human', 'bot']) {
    const el = $(side === 'human' ? 'byoyomiHuman' : 'byoyomiBot');
    if (!el) continue;
    if (byoyomiSide === side && game && game.status === 'active') {
      // v158: just the seconds ("9" … "1") — no leading zero or
      // colon. Ceil, so the window reads "9" for its first second;
      // floor would drop it to "11" within a millisecond of arming.
      // Clamped to a minimum of 1 while the countdown is live, so
      // it never shows "0" — "1" is the last value, then the game
      // ends and the element hides.
      el.textContent = String(Math.max(1, Math.ceil((byoyomiEndsAt - Date.now()) / 1000)));
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }
  // v159: no layout class is needed while the countdown shows — the
  // v158 name-under-clocks row is reverted (the name is back in the
  // 92px identity column, where a long name extends visibly under
  // the countdown instead of truncating), and the clock-row's
  // countdown end extends into the identity column's empty top
  // corner, so nothing is narrowed or shrunk. The v157
  // narrowing/shrinking rules stay deleted.
  // clearByoyomi flows through here too, so the countdown hides
  // when it goes away.
}
// End the game because the byoyomi countdown expired: the countdown
// player took more than 9s to move. Winner by score (the clocks
// are end conditions, not a win/loss decider — same as the both-0
// 'Final score' end). Offline games end locally; online games end
// through the server so both phones and the ratings agree.
async function endByoyomiGame() {
  if (!game || game.status !== 'active' || !byoyomiSide) return;
  clearByoyomi();
  const winner = winnerByScore();
  if (game.offline) { endLocalGame('Shot clock expired', winner); return; }
  try {
    const out = await api(`/api/games/${game.id}/time-expired`, { method: 'POST' });
    game = out; gameAppliedSeq = gameFetchSeq; gameFetchAt = Date.now(); renderGame();
  } catch (e) {
    // The server rejected it (e.g. the clocks moved on, or the game
    // already ended there): re-render from the fresh state. The
    // tick's arming check re-arms the countdown if a clock is
    // still at 0, so the game continues instead of hanging.
    renderGame();
  }
}
let countdownInterval = null, countdownActive = false;
// Countdown pause (v107): the absolute target, and the remaining time
// saved when the app hides mid-countdown so it resumes on return.
let countdownTargetMs = 0, countdownPaused = false, countdownPausedRemainingMs = 0;
let clockHoldUntil = 0;
function canPlaceTiles() { return !!game && game.status === 'active' && game.clocks.turn === 'human' && !playInFlight && !countdownActive; }
async function handleTimeoutFetch() {
  if (game && game.offline) return; // offline games have no server to fetch
  if (!game || game.status !== 'active' || timeoutFetching || playInFlight) return;
  timeoutFetching = true; timeoutLastAttempt = Date.now();
  try {
    const mySeq = ++gameFetchSeq;
    const next = await api(`/api/games/${game.id}`);
    // Same stale-snapshot rule as pollBotTurn: a fetch that was in
    // flight when a Play tap happened must not overwrite the
    // post-play state if it lands after the play reply. The tick
    // retries the timeout fetch once the flight is over. The sequence
    // check catches it when the play has already finished.
    if (playInFlight) return;
    if (mySeq <= gameAppliedSeq) return;
    game = next; gameAppliedSeq = mySeq; gameFetchAt = Date.now(); pending = []; selectedRack = null; timeoutFlipUnconfirmed = false; renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
  } catch {} finally { timeoutFetching = false; }
}
function tickClocks() {
  if (!game) return;
  // v157: a finished game carries no countdown — clear the state so
  // it cannot leak into the next game.
  if (game.status !== 'active' && byoyomiSide) clearByoyomi();
  // Offline pause (v107): while the app is hidden, no wall-clock time
  // may accumulate — reset the turn timer on every tick so the elapsed
  // never grows, and run none of the timeout/end logic. v106 only
  // settled the clock once at hide time, but this 100ms interval kept
  // running and kept draining the settled clocks while the app sat in
  // the background. Online games are untouched: the server clock runs
  // there by design, and the next poll re-syncs on return.
  if (game.offline && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    gameFetchAt = Date.now();
    return;
  }
  // Synced countdown (real-player games): the shared end can arrive
  // on the stream or on a poll, and the 100ms tick notices either
  // within a tenth of a second. The remaining time is relative
  // (server-computed), so no phone/server clock comparison is made.
  if (waitingForSync && game.countdownRemainingMs != null) {
    waitingForSync = false;
    if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; }
    startCountdown(Date.now() + game.countdownRemainingMs);
    return;
  }
  // Game-start hold: both timers sit on 4:00 for a full second before
  // ticking to 3:59. With floor display, 4:00 would otherwise drop to
  // 3:59 within ~100ms of starting. This is display-only: the underlying
  // elapsed time keeps running from the start, so at hold end the clock
  // reads exactly 3:59, then 3:58 a second later, with no jump.
  if (Date.now() < clockHoldUntil) { $('clockHuman').textContent = '4:00'; $('clockBot').textContent = '4:00'; return; }
  // During the countdown both clocks are pinned to 4:00, every tick.
  // Any render that recomputed from the server create time (4:59) or
  // from elapsed time during the countdown was the first-seconds glitch
  // in the screenshots: this overwrites it within 100ms, and renderGame
  // below does the same immediately.
  if (countdownActive) { $('clockHuman').textContent = '4:00'; $('clockBot').textContent = '4:00'; return; }
  const elapsed = Date.now() - gameFetchAt;
  let h = game.clocks.human, b = game.clocks.bot;
  if (game.status === 'active') {
    if (game.clocks.turn === 'human') h = Math.max(0, h - elapsed); else b = Math.max(0, b - elapsed);
  }
  // In a replay the clocks belong to renderReplay (v126): the 100ms
  // tick must not overwrite the rewound step clocks with the final
  // values. The rest of the tick (timeout/end logic) only runs for
  // an active game, so it is unaffected.
  if (replayIndex === null && Date.now() >= humanRunoffUntil) $('clockHuman').textContent = fmtClock(h);
  // During a runoff animation the bot clock is driven by the animation,
  // not by this 100ms tick — the tick used to jump it straight to the
  // stepped value and flicker over the animation.
  if (replayIndex === null && Date.now() >= runoffUntil) $('clockBot').textContent = fmtClock(b);
  // v157 byoyomi: one clock at 0 and the other still running — the
  // player with time gets a 9s countdown on their scoreboard.
  // Armed once (guarded by byoyomiSide), so the window is not
  // re-armed every tick. Both clocks at 0 is the both-0 end below,
  // not a countdown. The at-0 player's skip behaviour is unchanged.
  if (game.status === 'active' && byoyomiSide === null) {
    if (h <= 0 && b > 0) armByoyomi('bot');
    else if (b <= 0 && h > 0) armByoyomi('human');
  }
  // v157 byoyomi: the countdown ticks in real time (display updated
  // every tick) and ends the game when it hits 0. The countdown
  // player's regular clock hitting 0 is the both-0 branch below
  // (both clocks at 0 then), so it needs no separate check here.
  if (byoyomiSide) {
    // The opponent's move resets their countdown too. In an online
    // game the opponent moves on the server / the other phone, so
    // this phone only learns of it when the game state arrives —
    // a new moveLog entry from the countdown side is the signal.
    // Without this, the display would run to 0 and end a game
    // the opponent had already moved in. (Local games reset
    // directly in doLocalPlay / runLocalBotTurn instead.)
    if (game.moveLog && game.moveLog.length > byoyomiLastLogLen) {
      const last = game.moveLog[game.moveLog.length - 1];
      if (last && last.side === byoyomiSide) resetByoyomi(byoyomiSide);
      byoyomiLastLogLen = game.moveLog.length;
    }
    updateByoyomiDisplay();
    if (game.status === 'active' && Date.now() >= byoyomiEndsAt) endByoyomiGame();
  }
  // Human clock hit 0: do not leave the game sitting on a dead turn.
  // Recall any placed-but-unplayed tiles and flip the turn locally
  // at once, instead of leaving the tile on the board and the turn
  // sitting until the fetch round-trips. Placements are client-only
  // until Play, so the recall needs no server call; the fetch below
  // confirms the turn server-side. Skipped while a Play is in flight,
  // since the server reply settles those tiles. If that fetch fails,
  // the flip stays unconfirmed and the retry below re-fires it, so
  // the game can never stall on a failed fetch.
  if (game.status === 'active' && game.clocks.turn === 'human' && h <= 0) {
    $('status').textContent = 'Times up. Opponent has 9 seconds per move.'; updateForfeitLabel();
    // The human clock is out: zero the stored value at once (v148).
    // After the flip below, the tick displays game.clocks.human, and
    // the stale pre-timeout value (e.g. 1500ms) would otherwise sit
    // frozen at 0:01 — the human clock no longer drains on the bot's
    // turn, so nothing ever corrects it until the next fetch. Zeroing
    // it here also keeps the bot-timeout branch below from flipping
    // the turn back to the human on the stale value.
    game.clocks.human = 0;
    if (!playInFlight) {
      cleanupStuckDrag();
      if (pending.length > 0) { pending = []; selectedRack = null; }
      game.clocks.turn = 'bot'; gameFetchAt = Date.now(); timeoutFlipUnconfirmed = true;
      renderGame();
    }
    if (game.offline) {
      // No server to confirm the flip: start the local bot turn.
      timeoutFlipUnconfirmed = false;
      if (game.status === 'active' && !playInFlight && game.clocks.turn === 'bot') {
        // Both clocks out (v148): the bot has no time either, so
        // there is no bot turn to start — end it here instead of
        // arming a think for a dead bot. (The both-0 branch below
        // would end it on the same tick, but the turn must never be
        // armed first.)
        if (game.clocks.bot <= 0) finishLocalIfNeeded();
        else { startLocalBotTurn(); beginBotTurn(); }
      }
    } else if (!timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleTimeoutFetch();
  }
  // Optimistic flip done but the server has not confirmed it yet (the
  // fetch failed or is still out): retry it, so the bot's turn starts
  // instead of the game sitting on a locally-flipped turn.
  if (game.status === 'active' && timeoutFlipUnconfirmed && !game.offline && !timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleTimeoutFetch();
  // Opponent clock hit 0: fetch at once instead of waiting for the
  // next scheduled poll. A persona's think can run 30s, so the board
  // sat on 0:00 with the turn never coming. The fetch flips the
  // server to my turn (or finishes the game if my clock is 0 too).
  if (game.status === 'active' && game.clocks.turn === 'bot' && b <= 0) {
    if (game.offline) {
      // The bot is out of time: no think, the turn returns to the
      // human at once (same as the server's out-of-time skip).
      if (botTimer) { clearTimeout(botTimer); botTimer = null; }
      game.clocks.bot = 0; game.clocks.turnStartedAt = Date.now(); gameFetchAt = Date.now(); game.botThinkUntil = null; game.botThinkMs = null;
      // Both clocks at 0: end at once instead of flipping the turn
      // back to the human — the flip would re-fire this branch on the
      // next render and ping-pong with the human-timeout branch
      // forever (renderGame ends in tickClocks, so a branch that
      // leaves its own condition true recurses to a stack overflow).
      if (game.clocks.human <= 0) { gameFetchAt = Date.now(); finishLocalIfNeeded(); renderGame(); }
      else { game.clocks.turn = 'human'; renderGame(); finishLocalIfNeeded(); }
    } else if (!timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleTimeoutFetch();
  }
  // Both clocks at 0: the game is over, end it at once. The old code
  // only fetched on the human's turn, so when the second clock ran
  // out during the bot's think (up to 30s for a persona) the board
  // sat on 0:00 / 0:00 with nothing happening until the next poll.
  // A fetch settles the clocks server-side and finishes the game,
  // so the stat window comes up within ~1s of the second clock
  // hitting 0, whichever turn it is.
  if (game.status === 'active' && h <= 0 && b <= 0) {
    if (game.offline) { game.clocks.human = 0; game.clocks.bot = 0; gameFetchAt = Date.now(); finishLocalIfNeeded(); }
    else if (!timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleTimeoutFetch();
  }
  botWatchdog();
}
setInterval(tickClocks, 100);
// Presence heartbeat (v123, item 2): every 5s while a real-player
// game is open, tell the server "I am still here" — so it can tell
// my opponent's phone that I am gone (faded pfp) and, at 30s, end
// the game. Only runs for active human games; bot games are local
// (offline games never reach the server at all). The reply carries
// the opponent's connection state and whether they exited.
let heartbeatInFlight = false;
setInterval(async () => {
  if (!game || game.offline || game.botType !== 'human' || game.status !== 'active' || isOffline() || heartbeatInFlight) return;
  if ($('gameScreen') && $('gameScreen').classList.contains('hidden')) return;
  heartbeatInFlight = true;
  try {
    const r = await api(`/api/games/${game.id}/heartbeat`, { method: 'POST' });
    if (!r) return;
    if (r.opponentExited && r.status === 'finished') {
      game = r; gameAppliedSeq = gameFetchSeq; gameFetchAt = Date.now(); pending = []; renderGame();
      return;
    }
    if (typeof r.opponentConnected === 'boolean' && r.opponentConnected !== game.opponentConnected) {
      game.opponentConnected = r.opponentConnected;
      renderGame();
    }
  } catch (e) { /* a missed heartbeat is not a disconnect: the next one retries */ }
  finally { heartbeatInFlight = false; }
}, 5000);

let botTimer = null, suppressNextClick = false, botTurnTapTime = 0;
function parseClockText(txt) { const m = /^([0-9]+):([0-9]{2})$/.exec((txt || '').trim()); return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 : null; }
let runoffIv = null, humanRunoffIv = null;
function animateClockRunoff(fromMs, toMs) {
  if (runoffIv) { clearInterval(runoffIv); runoffIv = null; }
  if (fromMs !== null && toMs !== null) fromMs = Math.min(fromMs, toMs + 20000);
  if (fromMs === null || toMs === null || fromMs <= toMs) { if (toMs !== null) $('clockBot').textContent = fmtClock(toMs); return; }
  const steps = Math.max(1, Math.round((fromMs - toMs) / 1000));
  // 50ms per displayed second = ~750ms for the 15s runoff to the 20s mark.
  runoffUntil = Date.now() + steps * 50 + 100;
  let i = 0;
  runoffIv = setInterval(() => {
    i++;
    const v = fromMs - Math.round((fromMs - toMs) * i / steps);
    $('clockBot').textContent = fmtClock(Math.max(toMs, v));
    if (i >= steps) { clearInterval(runoffIv); runoffIv = null; $('clockBot').textContent = fmtClock(toMs); runoffUntil = 0; }
  }, 50);
}
function animateHumanRunoff(fromMs, toMs) {
  if (humanRunoffIv) { clearInterval(humanRunoffIv); humanRunoffIv = null; }
  if (fromMs === null || toMs === null || fromMs <= toMs) { if (toMs !== null) $('clockHuman').textContent = fmtClock(toMs); return; }
  const steps = Math.max(1, Math.round((fromMs - toMs) / 1000));
  humanRunoffUntil = Date.now() + steps * 20 + 100;
  $('clockHuman').textContent = fmtClock(fromMs);
  let i = 0;
  humanRunoffIv = setInterval(() => {
    i++;
    const v = fromMs - Math.round((fromMs - toMs) * i / steps);
    $('clockHuman').textContent = fmtClock(Math.max(toMs, v));
    if (i >= steps) { clearInterval(humanRunoffIv); humanRunoffIv = null; $('clockHuman').textContent = fmtClock(toMs); humanRunoffUntil = 0; }
  }, 20);
}
let lastBotPollAt = 0;
// Stale-fetch guard: every read of the game state (poll, timeout
// fetch) is stamped with a sequence number, and a response is only
// applied if no newer state has been applied since it was sent. The
// v81 playInFlight check only caught a stale fetch when the Play was
// still in flight — but the Play POST is usually faster than a slow
// GET, so a fetch sent before a Play that returned after the reply
// still overwrote the board with a pre-play snapshot and put the
// played tiles back in the rack. A Play / Pass / Forfeit reply, and
// entering a game, invalidates every fetch sent before it, so only
// fetches sent after that state can apply.
let gameFetchSeq = 0, gameAppliedSeq = 0;
// Live updates for real-player games (SSE): the server pushes every new
// game state the instant it is saved, so a move appears on the
// opponent's phone with no poll wait at all. The 1s poll keeps running
// as the fallback (and drives nothing new) — if the stream drops, the
// game just behaves like v82. Bot games never open a stream: their
// polls are what advance the bot. EventSource reconnects on its own
// after a drop, and the server sends the current state on (re)connect.
let gameStream = null, gameStreamGameId = null;
function openGameStream() {
  if (!game || game.botType !== 'human' || !token) return;
  if (gameStream && gameStreamGameId === game.id) return;
  closeGameStream();
  const es = new EventSource(API_BASE + `/api/games/${game.id}/stream?token=${encodeURIComponent(token)}`);
  gameStream = es; gameStreamGameId = game.id;
  es.addEventListener('game', (ev) => {
    let state; try { state = JSON.parse(ev.data); } catch { return; }
    if (!game || state.id !== game.id) return;
    // A play reply settles the state itself; a push landing mid-flight
    // must not touch it.
    if (playInFlight) return;
    // An echo of the state I already have — the deferred-optimal
    // re-broadcast seconds after a play, or the re-sync on reconnect —
    // carries nothing new and must not wipe tiles I have placed since.
    // Only a state that actually changes the game is applied.
    const sameBoard = JSON.stringify(state.board) === JSON.stringify(game.board);
    const sameScores = state.scores.human === game.scores.human && state.scores.bot === game.scores.bot;
    const sameTurn = state.clocks.turn === game.clocks.turn;
    const sameStatus = state.status === game.status;
    const sameRack = JSON.stringify(state.humanRack) === JSON.stringify(game.humanRack);
    // The shared countdown is a change too: a check-in broadcast
    // carries nothing else new (same board, scores, turn, rack), so
    // without this the waiting player would never learn the countdown
    // had started. A fresh remaining value is always a real change —
    // the value only moves when the countdown is stamped or the game
    // starts, never on a routine save.
    const sameCountdown = (state.countdownRemainingMs ?? null) === (game.countdownRemainingMs ?? null);
    const sameStarted = !!state.started === !!game.started;
    if (sameBoard && sameScores && sameTurn && sameStatus && sameRack && sameCountdown && sameStarted) return;
    // This state is newer than any fetch sent: invalidate every
    // in-flight GET so a stale poll response can never overwrite it.
    gameAppliedSeq = gameFetchSeq;
    game = state; gameFetchAt = Date.now();
    // v194: the server voided this game while it was open — send
    // the player home with a reason instead of leaving a dead board.
    if (state.status === 'void') { exitVoidGame(state); return; }
    // Placed tiles only go back when the game is over or it is no longer
    // my turn (a timeout flip, a pass). A move by the opponent flips the
    // turn TO me, and my own play's echo leaves the turn with them — in
    // neither case is anything placed to lose.
    if (state.status !== 'active' || state.clocks.turn !== 'human') { pending = []; selectedRack = null; }
    renderGame();
  });
  // No onerror handling: EventSource reconnects on its own, and the
  // 1s poll covers any gap while it does.
}
function closeGameStream() { if (gameStream) { try { gameStream.close(); } catch {} gameStream = null; gameStreamGameId = null; } }
async function pollBotTurn() {
  if (game && game.offline) return; // offline bot turns never poll
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot' || playInFlight) return;
  lastBotPollAt = Date.now(); botTimer = null;
  try {
    // Runoff start from the game state, not from the displayed text:
    // the displayed text is second-truncated, so parsing it back gave
    // a start up to a second off (the jump-up before the runoff).
    const fromMs = game.clocks.turn === 'bot' ? Math.max(0, game.clocks.bot - (Date.now() - gameFetchAt)) : game.clocks.bot;
    const prevBot = game.lastBot ? JSON.stringify(game.lastBot) : '';
    const prevBotScore = game.scores ? game.scores.bot : 0;
    const mySeq = ++gameFetchSeq;
    const next = await api(`/api/games/${game.id}`);
    // A poll that started before a Play tap must not overwrite the
    // post-play state: if a play went in flight while this GET was
    // out, its pre-play snapshot arriving after the play reply would
    // put the played tiles back in the rack and hide the move. The
    // play reply sets the state itself (and beginBotTurn re-polls),
    // so a stale response is simply dropped here. The sequence check
    // below is the one that catches it when the play has already
    // finished by the time this returns.
    if (playInFlight) return;
    if (mySeq <= gameAppliedSeq) return;
    const botMoved = (next.lastBot ? JSON.stringify(next.lastBot) : '') !== prevBot || (next.scores && next.scores.bot !== prevBotScore);
    game = next; gameAppliedSeq = mySeq; gameFetchAt = Date.now(); pending = []; selectedRack = null;
    // v194: the server voided this game while it was open.
    if (next.status === 'void') { exitVoidGame(next); return; }
    // v154: start the runoff BEFORE the render — renderGame's tick
    // would otherwise snap the bot clock straight to the stepped
    // value, and the animation would then jump it back up to
    // fromMs before counting down (the clock glitch Jeff reported).
    // Starting it first sets runoffUntil, so the tick leaves the
    // bot clock to the animation and the display only ever moves down.
    if (botMoved) animateClockRunoff(fromMs, next.clocks.bot);
    renderGame();
    // Animate the runoff whenever the bot actually played, even if the
    // server already flipped to the NEXT bot turn (human clock at 0) —
    // the old code returned early in that case and the runoff never ran.
    if (next.clocks.turn === 'bot' && next.status === 'active') {
      // Relative remaining time from the server, never the server's absolute
      // clock: comparing Render time to phone time added a spurious ~2s poll.
      // A real opponent takes their time: poll every 1s instead of the
      // bot's think-driven cadence (botThinkRemainingMs is null for
      // human games, which would otherwise fall to 500ms).
      const delay = game.botType === 'human' ? 1000 : (next.botThinkRemainingMs != null ? Math.max(200, next.botThinkRemainingMs) : 500);
      if (botTimer) clearTimeout(botTimer);
      botTimer = setTimeout(pollBotTurn, delay);
      return;
    }
    if (next.status === 'active') {
      if (next.clocks.human <= 0) handleTimeoutFetch();
      else await loadMe();
    }
  } catch {
    // A failed poll used to kill the loop entirely: no retry was ever
    // scheduled, so the game sat on the bot turn forever until a reload.
    // Retry after 1s while it is still the bot turn.
    if (game && game.status === 'active' && game.clocks.turn === 'bot') {
      if (botTimer) clearTimeout(botTimer);
      botTimer = setTimeout(pollBotTurn, 1000);
    }
  }
}
// Watchdog, driven by the 100ms clock tick: if it is the bot turn and
// no poll has run in the last 7s (timer lost, poll died, page restored
// from background), restart the bot turn instead of staying stuck.
function botWatchdog() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot' || playInFlight) return;
  if (botTimer) return;
  if (Date.now() - lastBotPollAt > 7000) { botTurnTapTime = 0; beginBotTurn(); }
}
// One source for the "waiting" status, so it never flips between the
// opponent's name and the generic line: beginBotTurn, updateStatus and
// doPlay each used to write their own copy, and every render overwrote
// the named one with the generic one. Named opponents (a persona's or
// real player's first name, Fishstick, Doppelgänger) keep their name.
function waitingStatus() {
  if (!game) return 'Waiting for your opponent.';
  if (game.clocks.human <= 0) return 'Times up. Opponent has 9 seconds per move.';
  if (game.botType === 'fishstick') return 'Waiting for Fishstick.';
  if (game.botType === 'competitive') return 'Waiting for Doppelgänger.';
  if (game.botType === 'persona' && game.persona) return `Waiting for ${game.persona.firstName}.`;
  if (game.botType === 'human' && game.opponent) return `Waiting for ${game.opponent.firstName}.`;
  return 'Waiting for your opponent.';
}
function beginBotTurn() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  $('status').textContent = waitingStatus();
  if (botTimer) clearTimeout(botTimer);
  // Offline games drive the local bot instead of polling the server.
  if (game.offline) { scheduleLocalBotTurn(); return; }
  // A real opponent has no think time: poll at once, then every 2s
  // (see pollBotTurn), instead of waiting out a bot think that
  // does not exist.
  if (game.botType === 'human') { botTimer = setTimeout(pollBotTurn, 0); return; }
  // A bot with no time left gets no think either (v148): poll at
  // once so the server flips the dead turn back — or finishes the
  // game when both clocks are out — instead of letting the board
  // sit on a dead bot's 2s/5s think.
  if (game.clocks.bot <= 0) { botTimer = setTimeout(pollBotTurn, 0); return; }
  // Perceived think is measured from the tap, not from the server reply.
  // Think is 5s normally, 2s once the human clock is at 0 (the server
  // sends its chosen duration as botThinkMs; fall back to the clock rule).
  const thinkMs = game.botThinkMs || (game.clocks.human <= 0 ? 2000 : 5000);
  if (botTurnTapTime && Date.now() - botTurnTapTime < 10000) {
    const delay = Math.max(0, thinkMs - (Date.now() - botTurnTapTime));
    botTimer = setTimeout(pollBotTurn, delay);
    return;
  }
  // Relative remaining time, less the time since this game state arrived
  // (network + render), so latencies before the timer starts do not stack
  // on top of the think.
  const delay = game.botThinkRemainingMs != null ? Math.max(0, game.botThinkRemainingMs - (Date.now() - gameFetchAt)) : thinkMs;
  botTimer = setTimeout(pollBotTurn, delay);
}

let validateInFlight = null, lastValidate = null, lastValidatePlacements = null, playInFlight = false, validateSeq = 0;
// Instant local pre-check: the full word list, fetched once (kicked off at
// game start, during the countdown) and kept in memory. Until it loads, the
// server path below is used. Submitted plays are still validated by the
// server authoritatively; this only decides the status line, Play colour,
// points bubble, and the optimistic score at the tap.
let localWords = null, localWordsPromise = null;
function ensureLocalWords() {
  if (localWords) return Promise.resolve(localWords);
  if (!localWordsPromise) {
    // iOS bundles the dictionary (v106, Jeff's decision 3): under
    // Capacitor the words come from the bundled words.txt, never the
    // network, so offline play works on first launch. On the web the
    // dictionary is still fetched (and cached by the service worker).
    const url = (typeof window !== 'undefined' && window.Capacitor) ? 'words.txt' : API_BASE + '/api/words';
    localWordsPromise = fetch(url).then(r => { if (!r.ok) throw new Error('words'); return r.text(); }).then(txt => {
      const set = new Set();
      for (const line of txt.split('\n')) { const w = line.trim().toUpperCase(); if (w) set.add(w); }
      localWords = set;
      // The shared engine, built once the words are in: the worker
      // fallback and local validation/scoring run through it.
      try { if (typeof DuelloEngine !== 'undefined' && DuelloEngine.createEngine) { localEngine = DuelloEngine.createEngine(localWords); ensureSolverWorker(); } } catch {}
      return set;
    }).catch(() => { localWordsPromise = null; return null; });
  }
  return localWordsPromise;
}

// ---------- v106 offline play ----------
// Local game runner + solver worker + IndexedDB persistence + sync drain.
// Online play is untouched: everything below only runs when game.offline
// is true, and the server stays authoritative for every online game.
let localEngine = null;
let offlineBotRack = [];
let offlinePlays = [];
let offlineMeta = null; // {offlineId, playerEloAtStart, startedAt, finishedAt, eloDelta, botType, botElo}
let pendingEloSum = 0; // deltas from finished-but-unsynced offline games
let pendingGamesCount = 0; // finished offline games waiting to sync
let outboxMayBeNonEmpty = false;
let drainRunning = false, drainScheduled = false;
let resumeSkipCountdown = false;
let solverWorker = null, solverWorkerReady = false, solverSeq = 0;
const solverPending = new Map();

// Persisted user (localStorage 'duello_me'): the signed-in user, kept so
// offline play knows the id, name, and Elo without a round-trip.
function persistMe() {
  if (!me) return;
  try { storeSet('duello_me', JSON.stringify({ id: me.id, username: me.username, firstName: me.firstName, elo: me.elo })); } catch {}
}
function loadPersistedMe() {
  try {
    const raw = storeGet('duello_me');
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u || typeof u.username !== 'string' || typeof u.elo !== 'number') return null;
    return u;
  } catch { return null; }
}
// The Elo Competitive matches against and deltas are computed from: the
// persisted Elo plus every finished-but-unsynced offline game's delta.
function localElo() {
  const base = (me && typeof me.elo === 'number') ? me.elo : 1000;
  return base + (pendingEloSum || 0);
}

// ---------- IndexedDB outbox (localStorage fallback) ----------
// Database 'duello-offline', one store 'games' keyed by offlineId.
// Value: {offlineId, status:'active'|'finished'|'rejected', game, plays,
// playerEloAtStart, eloDelta, startedAt, finishedAt, botType, botElo}.
// If IndexedDB is unavailable, the same records live in localStorage
// under 'duello_offline_games' (best effort, same shape).
let offlineDbPromise = null, offlineUseLocalStorage = false;
function offlineDb() {
  if (offlineUseLocalStorage) return Promise.resolve(null);
  if (typeof indexedDB === 'undefined') { offlineUseLocalStorage = true; return Promise.resolve(null); }
  if (!offlineDbPromise) {
    offlineDbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('duello-offline', 1); }
      catch { offlineUseLocalStorage = true; resolve(null); return; }
      req.onupgradeneeded = (e) => { try { e.target.result.createObjectStore('games', { keyPath: 'offlineId' }); } catch {} };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => { offlineUseLocalStorage = true; resolve(null); };
      req.onblocked = () => { offlineUseLocalStorage = true; resolve(null); };
    });
  }
  return offlineDbPromise;
}
function offlineIdbOp(mode, fn) {
  return offlineDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction('games', mode); } catch (e) { reject(e); return; }
      let req;
      try { req = fn(tx.objectStore('games')); } catch (e) { reject(e); return; }
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB error'));
    });
  });
}
function offlineLsGetAll() {
  try { const raw = storeGet('duello_offline_games'); const obj = raw ? JSON.parse(raw) : {}; return Object.values(obj); } catch { return []; }
}
function offlineLsPut(rec) {
  try { const raw = storeGet('duello_offline_games'); const obj = raw ? JSON.parse(raw) : {}; obj[rec.offlineId] = rec; storeSet('duello_offline_games', JSON.stringify(obj)); } catch {}
}
function offlineLsDel(id) {
  try { const raw = storeGet('duello_offline_games'); const obj = raw ? JSON.parse(raw) : {}; delete obj[id]; storeSet('duello_offline_games', JSON.stringify(obj)); } catch {}
}
async function offlineStorePut(rec) {
  let done = false;
  try {
    const db = await offlineDb();
    if (db) { await offlineIdbOp('readwrite', (s) => s.put(rec)); done = true; }
  } catch {}
  if (!done) offlineLsPut(rec);
}
async function offlineStoreGetAll() {
  let idb = [];
  try {
    const db = await offlineDb();
    if (db) idb = (await offlineIdbOp('readonly', (s) => s.getAll())) || [];
  } catch {}
  const ls = offlineLsGetAll();
  const seen = new Set(idb.map((r) => r.offlineId));
  return [...idb, ...ls.filter((r) => !seen.has(r.offlineId))];
}
async function offlineStoreDel(id) {
  try {
    const db = await offlineDb();
    if (db) await offlineIdbOp('readwrite', (s) => s.delete(id));
  } catch {}
  offlineLsDel(id);
}
async function refreshOfflineTotals() {
  let recs = [];
  try { recs = await offlineStoreGetAll(); } catch { recs = []; }
  // v168: one-time retry of games the server rejected before the rack
  // check went order-insensitive. Shuffle / rack drag-reorder between
  // moves 422'd those games, and the drain marked them 'rejected' so
  // they never retried — the missing Doppelgänger games. Flip them
  // back to 'finished' once; the drain below re-syncs them, and a
  // game that is genuinely invalid is rejected again and stays
  // rejected (the flag stops a second flip).
  let flippedAny = false;
  try {
    if (!storeGet('duello_rejected_retry_v168')) {
      const rejected = recs.filter((r) => r.status === 'rejected');
      for (const r of rejected) { r.status = 'finished'; try { await offlineStorePut(r); } catch {} }
      storeSet('duello_rejected_retry_v168', '1');
      flippedAny = rejected.length > 0;
    }
  } catch {}
  const finished = recs.filter((r) => r.status === 'finished');
  pendingGamesCount = finished.length;
  pendingEloSum = finished.reduce((s, r) => s + (r.eloDelta || 0), 0);
  outboxMayBeNonEmpty = finished.length > 0;
  // The flip above runs before the flag is set here, so schedule the
  // retry drain now that the outbox is known non-empty.
  if (flippedAny) { try { scheduleDrain(); } catch {} }
  // The profile count line updates with the totals (renderStatsList
  // no-ops when no profile is loaded).
  try { renderStatsList(); } catch {}
  return { pendingGamesCount, pendingEloSum };
}

// The record for the current offline game, in the persisted shape.
// The board is stored plain (no __premiums — structured clone/JSON drops
// custom array props); premiums travel in their own field and are
// re-attached on load. The bot rack rides along here (local persistence
// only); the sync payload carries botRackCount instead.
function offlineRecord() {
  if (!game || !game.offline || !offlineMeta) return null;
  const g = { ...game };
  g.board = game.board.map((row) => row.slice());
  g.botRack = offlineBotRack.slice();
  return {
    offlineId: offlineMeta.offlineId,
    status: game.status === 'finished' ? 'finished' : 'active',
    game: g,
    plays: offlinePlays.map((p) => ({ side: p.side, rack: p.rack.slice(), placements: p.placements.map((q) => ({ row: q.row, col: q.col, letter: q.letter })) })),
    playerEloAtStart: offlineMeta.playerEloAtStart,
    eloDelta: offlineMeta.eloDelta != null ? offlineMeta.eloDelta : null,
    startedAt: offlineMeta.startedAt,
    finishedAt: offlineMeta.finishedAt || null,
    botType: game.botType,
    botElo: offlineMeta.botElo,
  };
}
async function persistOfflineGame() {
  const rec = offlineRecord();
  if (!rec) return;
  try { await offlineStorePut(rec); } catch {}
  if (rec.status === 'finished') outboxMayBeNonEmpty = true;
}

// ---------- Solver worker ----------
// The worker owns the dictionary + solver index; the main thread owns the
// UI and the game state. If the worker cannot be built, the same engine
// runs synchronously on the main thread during the bot think.
function ensureSolverWorker() {
  if (solverWorker) return solverWorker;
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker('engine-worker.js');
    w.onmessage = (e) => {
      const d = (e && e.data) || {};
      if (d.type === 'ready') { solverWorkerReady = true; return; }
      if (d.type === 'solved' && d.requestId != null) {
        const p = solverPending.get(d.requestId);
        if (p) { solverPending.delete(d.requestId); p(d.moves || []); }
      }
    };
    w.onerror = () => { solverWorker = null; solverWorkerReady = false; };
    solverWorker = w;
    if (localWords) { try { w.postMessage({ type: 'init', words: [...localWords] }); } catch {} }
    return w;
  } catch { solverWorker = null; return null; }
}
function solveMovesLocal(board, rack, isFirst, wantAll) {
  if (!localEngine) return [];
  if (!board.__premiums) board.__premiums = (game && game.premiums) || {};
  try { return localEngine.findMoves(board, rack, isFirst, !!wantAll) || []; } catch { return []; }
}
function solveMoves(board, rack, isFirst, wantAll) {
  const w = ensureSolverWorker();
  if (w && solverWorkerReady) {
    return new Promise((resolve) => {
      const id = ++solverSeq;
      const to = setTimeout(() => {
        if (solverPending.has(id)) { solverPending.delete(id); resolve(solveMovesLocal(board, rack, isFirst, wantAll)); }
      }, 10000);
      solverPending.set(id, (moves) => { clearTimeout(to); resolve(moves); });
      try {
        // Structured clone drops custom props on arrays, so premiums
        // travel separately and the board is sent plain.
        w.postMessage({ type: 'solve', requestId: id, board: board.map((row) => row.slice()), rack: rack.slice(), isFirst: !!isFirst, premiums: board.__premiums || (game && game.premiums) || {}, wantAll: !!wantAll });
      } catch { solverPending.delete(id); clearTimeout(to); resolve(solveMovesLocal(board, rack, isFirst, wantAll)); }
    });
  }
  return Promise.resolve(solveMovesLocal(board, rack, isFirst, wantAll));
}

// ---------- Offline game construction ----------
// Mirrors server newGame, in serializeGame shape (board plain 2D,
// premiums, humanRack, botRackCount, scores, clocks, turn, botThink*,
// status, reason, last*, eloDelta*/eloAfter*, isFirst, player) plus the
// local-only moves lists the stat payload needs. The real bot rack lives
// in offlineBotRack, never in the synced state.
function buildOfflineGame(botType) {
  const startElo = localElo();
  // Competitive's bot Elo IS the player's Elo at creation — the sync
  // endpoint requires botElo === playerEloAtStart for competitive, and
  // exactly 3000 for Fishstick, so both come from one value each.
  const botElo = botType === 'fishstick' ? 3000 : startElo;
  const premiums = localEngine.makePremiums();
  const board = localEngine.emptyBoard();
  board.__premiums = premiums;
  const humanRack = localEngine.drawRack();
  const botRack = localEngine.drawRack();
  const offlineId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('off-' + Math.random().toString(16).slice(2) + Date.now().toString(16));
  const turn = Math.random() < 0.5 ? 'human' : 'bot';
  offlineBotRack = botRack;
  offlinePlays = [];
  offlineMeta = { offlineId, playerEloAtStart: startElo, startedAt: new Date().toISOString(), finishedAt: null, eloDelta: null, botType, botElo };
  game = {
    id: 'offline-' + offlineId, offline: true, botType, botElo,
    premiums, board, humanRack, botRackCount: botRack.length,
    scores: { human: 0, bot: 0 },
    clocks: { human: 240000, bot: 240000, turn, turnStartedAt: Date.now() },
    botThinkUntil: null, botThinkRemainingMs: null, botThinkMs: null,
    status: 'active', reason: null, winner: null,
    started: false,
    consecutivePasses: 0, consecutiveNoMoves: 0,
    moves: { human: [], bot: [] },
    // Chronological replay log (v123): the same moveLog the server
    // keeps — it travels with the game in the offline sync payload,
    // so a synced offline game replays too.
    moveLog: [],
    lastCells: [], lastWord: null, lastScore: null, lastBy: null,
    lastHuman: null, lastBot: null,
    eloDeltaHuman: null, eloDeltaBot: null, eloAfterHuman: null, eloAfterBot: null,
    isFirst: true,
    player: { firstName: me.firstName, username: me.username, elo: startElo },
  };
  // No bot think armed here (v109): the think must run AFTER the 5s
  // countdown, not during it. Arming it at creation let it elapse
  // under the countdown, so Fishstick played the instant the countdown
  // ended. endCountdown arms it (startLocalBotTurn) when the countdown
  // completes — the local mirror of the server's /start re-arm.
  return game;
}
async function startOfflineGame(botType) {
  try {
    // The game screen opens at once (v112): the dictionary keeps
    // loading in the background and is only needed for the first
    // validation / bot think, both after the 5s countdown. Building
    // the game needs only the board/rack helpers, which run on a
    // wordless engine until the real one lands.
    try { ensureLocalWords(); } catch {}
    if (!localEngine) { try { localEngine = DuelloEngine.createEngine(new Set()); } catch {} }
    if (!localEngine) throw new Error('dictionary');
    // v113: on a cold launch the boot /api/me may still be hanging when
    // the tap lands, so me is not set yet — take the persisted user
    // first instead of awaiting a network call that is doomed offline.
    // Only fall back to the network when there is no persisted user.
    if (!me) {
      const stored = loadPersistedMe();
      if (stored) me = stored;
      else { try { await loadMe(); } catch {} }
    }
    if (!me) throw new Error('nouser');
    buildOfflineGame(botType);
    clearByoyomi(); // v157: a new game starts with no countdown.
    persistOfflineGame();
    enterGameScreen();
    return true;
  } catch (err) {
    showOfflineUnavailable(err);
    return false;
  }
}
function showOfflineUnavailable(err) {
  // Never fail silently: the bot screen says why offline play is not
  // available right now, in plain words.
  let msg = 'Offline play is not available right now — connect once and try again.';
  if (err && err.message === 'dictionary') msg = 'Offline play needs the dictionary — connect once to download it, then try again.';
  else if (err && err.message === 'nouser') msg = 'Offline play needs your profile — sign in once while online, then try again.';
  else if (err && err.message) msg = 'Offline play is not available right now (' + String(err.message).slice(0, 80) + ') — connect once and try again.';
  try {
    let el = $('offlineMsg');
    if (!el) {
      el = document.createElement('div');
      el.id = 'offlineMsg';
      el.className = 'offline-msg';
      el.style.textAlign = 'center';
      el.style.padding = '12px 20px';
      el.style.color = '#ffd166';
      const screen = $('botScreen');
      if (screen) screen.appendChild(el);
    }
    el.textContent = msg;
    el.classList.remove('hidden');
  } catch {}
  try { show('botScreen'); } catch {}
}

// ---------- Local clock / turn engine (mirrors the server) ----------
// The display math in tickClocks is unchanged: clocks derive from
// gameFetchAt + game.clocks. Settling folds the elapsed turn time into
// the stored clocks and restarts the timer — the same shape as the
// server's settleClock, using the client's tap-time elapsed.
function settleLocalClock() {
  if (!game || game.status !== 'active') return;
  const now = Date.now();
  const elapsed = Math.max(0, now - gameFetchAt);
  if (game.clocks.turn === 'human') game.clocks.human = Math.max(0, game.clocks.human - elapsed);
  else game.clocks.bot = Math.max(0, game.clocks.bot - elapsed);
  game.clocks.turnStartedAt = now; gameFetchAt = now;
}
function startLocalBotTurn() {
  game.clocks.turn = 'bot'; game.clocks.turnStartedAt = Date.now(); gameFetchAt = Date.now();
  // Think is 5s normally, 2s once the human clock is at 0 (same rule as
  // botThinkMsFor for non-persona bots) — except in shot-clock mode
  // (v161 Fishstick, v182 Doppelgänger): the human clock is at 0 and
  // the bot still has time, so the bot is playing on under the
  // countdown, and it thinks a full 5s there.
  const botHasShotClock = game.clocks.human <= 0 && game.clocks.bot > 0;
  game.botThinkMs = (game.clocks.human <= 0 && !(botHasShotClock && (game.botType === 'fishstick' || game.botType === 'competitive'))) ? 2000 : 5000;
  game.botThinkUntil = Date.now() + game.botThinkMs;
  // v182: Doppelgänger shot-clock skip — 1 in 6 moves he lets the 9s
  // run out without playing (random per move, not a sequence). The
  // roll happens once per turn, here; the flag stays set for the whole
  // turn because the watchdog re-invokes the turn while the countdown
  // runs, and every invocation must still skip (see runLocalBotTurnInner).
  game.botShotClockSkip = game.botType === 'competitive' && botHasShotClock && Math.random() < 1 / 6;
}
function stepLocalBotClock() {
  if (game.clocks.bot > 0) game.clocks.bot = Math.floor((game.clocks.bot - 1) / 20000) * 20000;
  else game.clocks.bot = 0;
}
function winnerByScore() {
  return game.scores.human > game.scores.bot ? 'human' : game.scores.bot > game.scores.human ? 'bot' : 'draw';
}
// Mirrors server applyMove + updateStatsForMove: board, in-place rack
// refill (unplayed tiles never move), score, last play, and the moves
// entry the stat payload and the sync replay read.
function applyLocalMove(side, move, bestScore) {
  const isHuman = side === 'human';
  for (const p of move.placements) game.board[p.row][p.col] = p.letter;
  const applyRack = (rack) => {
    const usedIndices = [];
    const remaining = rack.slice();
    for (const p of move.placements) { const idx = remaining.indexOf(p.letter); if (idx >= 0) { usedIndices.push(idx); remaining[idx] = null; } }
    return localEngine.refillRack(rack, usedIndices);
  };
  if (isHuman) game.humanRack = applyRack(game.humanRack);
  else { offlineBotRack = applyRack(offlineBotRack); game.botRackCount = offlineBotRack.length; }
  game.scores[side] += move.score;
  game.lastCells = move.highlightCells;
  game.lastWord = move.mainWord; game.lastScore = move.score; game.lastBy = side;
  const allWords = (move.words || []).map((w) => w.word);
  if (isHuman) game.lastHuman = { word: move.mainWord, points: move.score, bonus: move.bonus, isDuello: move.isDuello, bingo: move.bingo, words: allWords };
  else game.lastBot = { word: move.mainWord, points: move.score, bonus: move.bonus, isDuello: move.isDuello, bingo: move.bingo, words: allWords };
  const isOptimal = bestScore !== null && bestScore !== undefined && move.score === bestScore;
  game.moves[side].push({ words: (move.words || []).map((w) => ({ word: w.word, score: w.score })), score: move.score, isOptimal, mainWord: move.mainWord, bingo: !!move.bingo });
  // Chronological replay log (v123): the placements rebuild the
  // board at any step. clocks (v126): the remaining time on each
  // clock right after this move, so the replay can tick the clocks
  // back to when the move was played. For a human move settleLocalClock
  // already ran, so these are settled; for a bot move the caller
  // re-stamps them after stepLocalBotClock (the 20s step-down).
  (game.moveLog = game.moveLog || []).push({ side, placements: (move.placements || []).map((p) => ({ row: p.row, col: p.col, letter: p.letter })), words: (move.words || []).map((w) => ({ word: w.word, score: w.score })), score: move.score, mainWord: move.mainWord, clocks: { human: game.clocks.human, bot: game.clocks.bot } });
  game.consecutivePasses = 0; game.consecutiveNoMoves = 0;
  game.isFirst = localEngine.boardIsEmpty(game.board);
}
function finishLocalIfNeeded() {
  if (!game || game.status !== 'active') return false;
  if (game._pendingNoMovesEnd) { delete game._pendingNoMovesEnd; endLocalGame('No playable moves left', winnerByScore()); return true; }
  if (game.clocks.human <= 0 && game.clocks.bot <= 0) { endLocalGame('Final score', winnerByScore()); return true; }
  return false;
}
function endLocalGame(reason, winnerSide) {
  game.status = 'finished'; game.reason = reason; game.winner = winnerSide;
  const actual = winnerSide === 'human' ? 1 : winnerSide === 'bot' ? 0 : 0.5;
  // The delta is computed from the Elo at game start (playerEloAtStart),
  // never recomputed from a later Elo — same rule the sync endpoint
  // enforces server-side.
  const delta = localEngine.eloDelta(offlineMeta.playerEloAtStart, game.botElo, actual);
  game.eloDeltaHuman = delta; game.eloDeltaBot = -delta;
  game.eloAfterHuman = offlineMeta.playerEloAtStart + delta;
  game.eloAfterBot = game.botElo - delta;
  game.botElo = game.eloAfterBot;
  game.offlinePending = true;
  game.stats = localEngine.gameStatsPayload(game, false);
  offlineMeta.eloDelta = delta; offlineMeta.finishedAt = new Date().toISOString();
  pendingEloSum += delta;
  outboxMayBeNonEmpty = true;
  persistOfflineGame().then(() => refreshOfflineTotals()).catch(() => {});
  // Sync the finished game promptly when online (v116): bot games are
  // always native now, so the server only learns the result through
  // the outbox. drainOutbox bails safely when offline, so this is a
  // no-op there and the 'online' event still drains it later.
  try { scheduleDrain(); } catch {}
  renderGame();
}
async function doLocalPlay() {
  // The dictionary may still be loading behind the countdown (v112):
  // wait for it here — validation cannot run without it — instead of
  // failing the play.
  if (!localWords) { try { await ensureLocalWords(); } catch {} }
  if (!localEngine || !localWords) { $('status').textContent = 'Offline play needs the dictionary — connect once to download it.'; return; }
  playInFlight = true;
  try {
    const placements = pending.map((p) => ({ row: p.row, col: p.col, letter: p.letter }));
    const rackBefore = game.humanRack.slice();
    const preBoard = game.board.map((row) => row.slice());
    preBoard.__premiums = game.premiums;
    const isFirst = game.isFirst;
    // Local validatePlay is authoritative offline — not the status-line
    // mirror, and no server call.
    const v = localEngine.validatePlay(game.board, game.humanRack, placements, game.premiums, isFirst);
    if (!v.valid) {
      $('status').textContent = (v.invalidWords && v.invalidWords.length) ? invalidWordsStatus(v.invalidWords) : sentence(String(v.error || 'Invalid play').slice(0, 48));
      renderGame();
      return;
    }
    // Best-move scan on the pre-move board/rack, the same comparison
    // the server runs deferred after a play (isOptimal = played the best).
    let bestScore = null;
    try { const best = await solveMoves(preBoard, rackBefore, isFirst, false); if (best.length) bestScore = best[0].score; } catch {}
    settleLocalClock();
    offlinePlays.push({ side: 'human', rack: rackBefore, placements: placements.map((p) => ({ row: p.row, col: p.col, letter: p.letter })) });
    applyLocalMove('human', v, bestScore);
    resetByoyomi('human'); // v157: a move by the countdown player refreshes the 9s.
    pending = []; selectedRack = null;
    if (game.clocks.bot <= 0) { game.clocks.turn = 'human'; game.clocks.turnStartedAt = Date.now(); gameFetchAt = Date.now(); }
    else startLocalBotTurn();
    botTurnTapTime = Date.now();
    persistOfflineGame();
    renderGame();
    if (finishLocalIfNeeded()) return;
    if (game.status === 'active' && game.clocks.turn === 'human') {
      await applyHumanNoMovePassLocal();
      if (finishLocalIfNeeded()) return;
    }
    if (game.status === 'active' && game.clocks.turn === 'bot') beginBotTurn();
  } finally { playInFlight = false; }
}
async function doLocalPass() {
  if (!game || !game.offline || game.status !== 'active' || game.clocks.turn !== 'human') return;
  // No passing in a one-sided stretch (same rule as the server).
  if (game.clocks.human <= 0 || game.clocks.bot <= 0) return;
  settleLocalClock();
  // v154: the runoff starts from the live value (elapsed folded in
  // by the settle above), not the pre-settle stored value — the old
  // start was the turn time so far too high, so the clock jumped up
  // when the animation began.
  const fromHuman = game.clocks.human;
  game.clocks.human = Math.max(0, game.clocks.human - 30000);
  game.consecutivePasses++; game.consecutiveNoMoves = 0;
  game.lastHuman = { word: null, points: 0, passed: true };
  game.lastBy = 'human'; game.lastCells = [];
  if (game.consecutivePasses >= 2) { endLocalGame('Final score', winnerByScore()); return; }
  startLocalBotTurn();
  // v154: start the runoff before the render (see pollBotTurn).
  animateHumanRunoff(fromHuman, game.clocks.human);
  persistOfflineGame(); renderGame();
  if (finishLocalIfNeeded()) return;
  if (game.status === 'active' && game.clocks.turn === 'bot') beginBotTurn();
}
// v138: free exit for an offline bot game with no moves played.
// Nothing is recorded: no Elo delta, no finished record, no sync.
// The active offline record is deleted outright, so the game can
// neither be resumed nor synced later. The caller goes home after.
function doLocalFreeExit() {
  if (!game || !game.offline) return;
  cancelCountdown();
  const id = offlineMeta && offlineMeta.offlineId;
  game = null;
  if (id) { try { offlineStoreDel(id); } catch {} }
  try { refreshOfflineTotals(); } catch {}
}
function doLocalForfeit() {
  if (!game || !game.offline) return;
  // A forfeit during the countdown stops it (v107) — doLocalForfeit is
  // also the local path, so cancel here too, not just in the button.
  cancelCountdown();
  const wasOutOfTime = humanOutOfTime();
  // Exit (out of time): the loss is recorded, but there is no stat
  // window — leave straight to the main menu, like the online path.
  if (wasOutOfTime) statShownGameId = game.id;
  endLocalGame('By forfeit', 'bot');
  if (wasOutOfTime) goHome();
}
function scheduleLocalBotTurn() {
  if (botTimer) clearTimeout(botTimer);
  // v160: the 100ms botWatchdog restarts the bot turn when no poll
  // has run in 7s — a local turn is the offline equivalent of a
  // poll, so stamp it here, or the watchdog re-fires every tick
  // while a turn is running (botTimer is null for the whole run).
  lastBotPollAt = Date.now();
  const delay = game.botThinkUntil ? Math.max(0, game.botThinkUntil - Date.now()) : (game.botThinkMs || 5000);
  botTimer = setTimeout(runLocalBotTurn, delay);
}
// v160: exactly one local bot turn may run at a time. The 100ms
// botWatchdog re-arms a turn whenever botTimer is null, and a turn
// clears botTimer at its start — so while one turn runs (solving,
// or waiting out the shot clock) the watchdog spawns a fresh
// invocation every tick. Without this guard they all wake at the
// same deadline and play the same move in a burst (11 identical
// ROOM plays ended a Fishstick shot-clock game in one burst).
let localBotTurnRunning = false;
async function runLocalBotTurn() {
  botTimer = null;
  if (localBotTurnRunning) return;
  localBotTurnRunning = true;
  try { await runLocalBotTurnInner(); } finally { localBotTurnRunning = false; }
}
async function runLocalBotTurnInner() {
  botTimer = null;
  if (!game || !game.offline || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  // v161: the stored bot clock now is the pre-think value — no settle
  // has run since the turn started. (settleLocalClock resets
  // turnStartedAt, so the turn's elapsed drain cannot be measured
  // off that timestamp; it is measured off the clock itself below.)
  const preThinkBot = game.clocks.bot;
  settleLocalClock();
  if (game.clocks.bot <= 0) {
    game.clocks.turn = 'human'; game.clocks.turnStartedAt = Date.now(); gameFetchAt = Date.now(); game.botThinkUntil = null; game.botThinkMs = null;
    renderGame(); finishLocalIfNeeded(); return;
  }
  // v182: Doppelgänger shot-clock skip — the 1-in-6 roll from
  // startLocalBotTurn. No move, no countdown reset, no turn flip:
  // the tick's byoyomi expiry ends the game (winner by score).
  // The flag is NOT cleared here: the watchdog re-invokes this turn
  // while the countdown runs, and every invocation must skip, or
  // the bot would play before the 9s expires.
  if (game.botShotClockSkip) { renderGame(); return; }
  if (!localWords) { try { await ensureLocalWords(); } catch {} }
  if (!localEngine || !localWords) { $('status').textContent = 'Offline play needs the dictionary — connect once to download it.'; return; }
  const isFirst = game.isFirst;
  let moves = [];
  try { moves = await solveMoves(game.board, offlineBotRack, isFirst, true); } catch { moves = []; }
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  // v154: the solve itself takes wall-clock time (Fishstick's
  // exhaustive search runs seconds on a full board), and the tick
  // kept draining the displayed clock through it — fold that time
  // into the stored clock too, or the display jumps back up to the
  // pre-solve value when the move lands. (The clock glitch Jeff
  // reported: the clock ticked down through the solve, then jumped
  // back up when the runoff started from the stale pre-solve value.)
  settleLocalClock();
  const fromMs = Math.max(0, game.clocks.bot);
  // The clock may have hit 0 during the solve: the bot never moves then.
  if (fromMs <= 0) {
    game.clocks.bot = 0; game.clocks.turn = 'human'; game.clocks.turnStartedAt = Date.now(); gameFetchAt = Date.now(); game.botThinkUntil = null; game.botThinkMs = null;
    renderGame(); finishLocalIfNeeded(); return;
  }
  if (!moves.length) {
    // No-move auto-pass, -30s (mirrors runBotTurn's no-moves branch):
    // if neither side has a move the game ends at once.
    game.consecutivePasses++; game.consecutiveNoMoves++;
    game.clocks.bot = Math.max(0, game.clocks.bot - 30000);
    game.lastBot = { word: null, points: 0, passed: true, auto: true, noMoves: true };
    game.lastBy = 'bot'; game.lastCells = [];
    resetByoyomi('bot'); // v157: an auto-pass is the bot acting — refresh the 9s.
    game.clocks.turn = 'human'; game.clocks.turnStartedAt = Date.now(); gameFetchAt = Date.now(); game.botThinkUntil = null; game.botThinkMs = null;
    const humanMoves = await solveMoves(game.board, game.humanRack, isFirst, false).catch(() => []);
    if (!humanMoves.length || game.consecutiveNoMoves >= 2) game._pendingNoMovesEnd = true;
    persistOfflineGame(); renderGame();
    if (finishLocalIfNeeded()) return;
    await applyHumanNoMovePassLocal();
    if (finishLocalIfNeeded()) return;
    if (game.status === 'active' && game.clocks.turn === 'bot') beginBotTurn();
    return;
  }
  const bestScore = moves[0].score;
  const move = game.botType === 'fishstick' ? moves[0] : localEngine.pickCompetitiveMove(moves, game.botElo);
  offlinePlays.push({ side: 'bot', rack: offlineBotRack.slice(), placements: move.placements.map((p) => ({ row: p.row, col: p.col, letter: p.letter })) });
  applyLocalMove('bot', move, bestScore);
  resetByoyomi('bot'); // v157: a move by the countdown player refreshes the 9s.
  // v161: in shot-clock mode Fishstick drains exactly 9s off the
  // clock per move instead of the normal 20s step. v182: Doppelgänger
  // does the same (5s think + the rest of the 9s as runoff).
  // The think + solve already drained E = preThinkBot - fromMs in
  // real time (folded by the settles above), so the animated runoff
  // is the remainder (BYOYOMI_MS - E) — the move lands ~5s after the
  // turn starts (5s think + a fast solve) and the clock still drops
  // 9s total. Measured off the clock itself: settleLocalClock resets
  // turnStartedAt, so a timestamp would read ~0 elapsed and
  // double-count the think.
  // Outside shot-clock mode, the normal 20s step stands.
  if ((game.botType === 'fishstick' || game.botType === 'competitive') && byoyomiSide === 'bot') {
    const elapsedMs = preThinkBot - fromMs;
    const runoffMs = Math.max(0, BYOYOMI_MS - elapsedMs);
    game.clocks.bot = Math.max(0, game.clocks.bot - runoffMs);
  } else {
    stepLocalBotClock();
  }
  // Re-stamp the clocks on the move just logged (v126): the inline
  // capture in applyLocalMove ran before the step-down, so the
  // bot clock there is up to 20s high (9s in shot-clock mode).
  // After the step-down these are the exact post-move values the
  // replay must show.
  if (game.moveLog && game.moveLog.length) game.moveLog[game.moveLog.length - 1].clocks = { human: game.clocks.human, bot: game.clocks.bot };
  game.botThinkUntil = null; game.botThinkMs = null;
  game.clocks.turn = 'human'; game.clocks.turnStartedAt = Date.now(); gameFetchAt = Date.now();
  // v154: start the runoff before the render (see pollBotTurn) —
  // the render's tick would snap the clock to the stepped value
  // first and the animation would jump it back up to fromMs.
  animateClockRunoff(fromMs, game.clocks.bot);
  persistOfflineGame(); renderGame();
  if (finishLocalIfNeeded()) return;
  await applyHumanNoMovePassLocal();
  if (finishLocalIfNeeded()) return;
  // Human clock at 0: the bot keeps playing — start the next bot turn
  // at once instead of handing the turn to a player who cannot move.
  if (game.status === 'active' && game.clocks.turn === 'human' && game.clocks.human <= 0 && game.clocks.bot > 0) { startLocalBotTurn(); beginBotTurn(); }
}
async function applyHumanNoMovePassLocal() {
  if (!game || !game.offline || game.status !== 'active' || game.clocks.turn !== 'human') return false;
  if (!localEngine) return false;
  const isFirst = game.isFirst;
  const hm = await solveMoves(game.board, game.humanRack, isFirst, false).catch(() => []);
  if (hm.length) return false;
  const bm = await solveMoves(game.board, offlineBotRack, isFirst, false).catch(() => []);
  if (!bm.length || game.clocks.bot <= 0) { game._pendingNoMovesEnd = true; return true; }
  game.clocks.human = Math.max(0, game.clocks.human - 30000);
  game.consecutivePasses++; game.consecutiveNoMoves++;
  game.lastHuman = { word: null, points: 0, passed: true, auto: true, noMoves: true };
  game.lastBy = 'human'; game.lastCells = [];
  startLocalBotTurn();
  persistOfflineGame(); renderGame();
  return false;
}

// ---------- Pause on close / resume on return ----------
// Offline clocks PAUSE when the app is closed (Jeff's decision 1): the
// elapsed turn time is folded into the stored clocks at pause, and on
// return the turn timer restarts from now — no wall-clock time while
// closed is ever charged.
function pauseOfflineClocks() {
  if (!game || !game.offline || game.status !== 'active') return;
  // A pending bot think must not fire while the app is closed: the bot
  // would move (and drain its clock) in the background. Cleared here;
  // resumeOfflineClocks re-arms the turn on return.
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  // Pause the countdown too (v107): the 5s overlay must not complete
  // while the app is closed. The remaining time is kept and the
  // countdown resumes on return. The clocks have not started yet
  // during a countdown, so there is nothing to settle — settling
  // would wrongly charge the countdown seconds to the clock.
  if (countdownActive) {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    countdownPausedRemainingMs = Math.max(0, (countdownTargetMs || Date.now()) - Date.now());
    countdownPaused = true;
  } else {
    settleLocalClock();
  }
  persistOfflineGame();
}
function resumeOfflineClocks() {
  if (!game || !game.offline || game.status !== 'active') return;
  gameFetchAt = Date.now(); game.clocks.turnStartedAt = Date.now();
  // A countdown paused on hide resumes from its remaining time.
  if (countdownPaused) {
    countdownPaused = false;
    const remaining = countdownPausedRemainingMs || 0;
    countdownPausedRemainingMs = 0;
    startCountdown(Date.now() + Math.max(200, remaining));
    return;
  }
  renderGame();
  if (game.clocks.turn === 'bot' && !botTimer) beginBotTurn();
}
// Stop a running countdown outright (forfeit during the countdown,
// v107): the interval is cleared, the overlay hides, and endCountdown
// never fires — otherwise it would POST /start (or restart the local
// clocks) on a game that is already finished.
function cancelCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; }
  waitingForSync = false;
  countdownActive = false; countdownPaused = false; countdownPausedRemainingMs = 0;
  try { $('gameScreen').classList.remove('counting'); $('countdownOverlay').classList.add('hidden'); } catch {}
}
// True when an offline game was actually played: a move was made (human
// or bot), a move was logged, a pass happened, or tiles are on the board.
// A game with none of these was started and abandoned before a single
// play — most often the app was closed during the 5s countdown. Such a
// game is not one the user was "in the middle of", so it must never
// auto-open on launch.
function offlineGameHasProgress(rec) {
  const g = rec && rec.game;
  if (!g) return false;
  if (g.moves && ((g.moves.human && g.moves.human.length) || (g.moves.bot && g.moves.bot.length))) return true;
  if (rec.plays && rec.plays.length) return true;
  if (g.isFirst === false) return true;
  if (g.consecutivePasses > 0) return true;
  if (g.lastHuman || g.lastBot) return true;
  if (g.board) {
    for (const row of g.board) for (const cell of row) if (cell) return true;
  }
  return false;
}
async function maybeResumeOfflineGame() {
  if (game && game.status === 'active') return false;
  let recs = [];
  try { recs = await offlineStoreGetAll(); } catch { return false; }
  // Resume ONLY a game the user genuinely was in the middle of. The
  // old code took the newest 'active' record unconditionally, and a
  // game is persisted as 'active' the moment it is created — before
  // the countdown, before any move. So a game that was started and
  // abandoned (closed during the countdown, or the user just went
  // home / closed the app) stayed 'active' forever, and every launch
  // dropped the user straight back into it: closing the app to escape
  // the game is exactly what kept it 'active', so it resumed again.
  // There was no way out except finishing or forfeiting it. Now the
  // candidates are walked newest-first and only a record that is
  // really still in progress is resumed; stale ones are cleaned up
  // so they can never keep auto-opening.
  const cands = recs.filter((r) => r.status === 'active' && r.game).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  let rec = null;
  for (const cand of cands) {
    // A finished/forfeited game whose record still claims 'active'
    // is stale and must never resume. If it carries a real result
    // (delta + finish time) it is corrected to 'finished' so the
    // outbox still syncs it; otherwise it is deleted.
    if (cand.game.status !== 'active') {
      try {
        if (cand.eloDelta != null && cand.finishedAt) { cand.status = 'finished'; await offlineStorePut(cand); }
        else await offlineStoreDel(cand.offlineId);
      } catch {}
      continue;
    }
    // Never started and never played: the countdown never completed
    // and no move or pass happened. This is a game that was created
    // and abandoned before it began — most often the app was closed
    // during the 5s countdown. Delete the record and open Home
    // instead of resuming a game that never started. A game whose
    // countdown DID complete (started) resumes even before its first
    // move, and a game with moves resumes even if the flag is missing
    // (an older v106/v107 record, which predates the flag).
    if (cand.game.started !== true && !offlineGameHasProgress(cand)) {
      try { await offlineStoreDel(cand.offlineId); } catch {}
      continue;
    }
    rec = cand;
    break;
  }
  if (!rec) return false;
  // Don't block the resume on the dictionary (v112): the screen opens
  // at once and the words finish loading behind it; play and the bot
  // think await them if they are still in flight.
  try { ensureLocalWords(); } catch {}
  if (!localEngine) { try { localEngine = DuelloEngine.createEngine(new Set()); } catch {} }
  const g = rec.game;
  // Re-attach what persistence strips: the solver premiums and the bot rack.
  g.board.__premiums = g.premiums;
  offlineBotRack = (g.botRack || []).slice();
  delete g.botRack;
  game = g;
  game.offline = true;
  offlinePlays = (rec.plays || []).map((p) => ({ side: p.side, rack: p.rack.slice(), placements: p.placements.map((q) => ({ row: q.row, col: q.col, letter: q.letter })) }));
  offlineMeta = { offlineId: rec.offlineId, playerEloAtStart: rec.playerEloAtStart, startedAt: rec.startedAt, finishedAt: rec.finishedAt || null, eloDelta: rec.eloDelta, botType: rec.botType, botElo: rec.botElo };
  if (!game.moves) game.moves = { human: [], bot: [] };
  game.clocks.turnStartedAt = Date.now();
  if (game.clocks.turn === 'bot') { game.botThinkMs = game.clocks.human <= 0 ? 2000 : 5000; game.botThinkUntil = Date.now() + game.botThinkMs; }
  resumeSkipCountdown = true;
  currentBot = game.botType;
  enterGameScreen();
  return true;
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'hidden') pauseOfflineClocks();
      // v176: a long-lived session (iOS keeps the JS alive for
      // hours) must pick up a new persona roster without a game
      // end or a restart — check the version on every return.
      // v180: also retry a push registration that never landed.
      // v190: and refresh the Friends list, so an accept that
      // happened while the app was backgrounded shows at once.
      else { resumeOfflineClocks(); drainOutbox(); checkPersonasVersion(); retryPushRegistration(); try { maybeRefreshFriendsList(); } catch {} }
    } catch {}
  });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('online', () => { try { drainOutbox(); refreshOnlineButtons(); checkPersonasVersion(); } catch {} });
  window.addEventListener('offline', () => { try { refreshOnlineButtons(); } catch {} });
  window.addEventListener('pagehide', () => { try { pauseOfflineClocks(); } catch {} });
  window.addEventListener('beforeunload', () => { try { pauseOfflineClocks(); } catch {} });
}

// ---------- Sync drain ----------
// The exact payload the server's POST /api/games/sync replays:
// {offlineId, botType, botElo, playerEloAtStart, eloDelta, startedAt,
// finishedAt, state, plays}. state is the finished game in serializeGame
// shape (board plain 2D, premiums, humanRack, botRackCount — never
// botRack — scores, clocks, turn, botThink*, status, reason, winner,
// moves, last*, Elo fields, isFirst, player), with botElo taken from
// the offline meta: endLocalGame rewrites game.botElo to the after-Elo,
// and the endpoint requires the ORIGINAL bot Elo (3000 for Fishstick,
// playerEloAtStart for Competitive).
function buildSyncPayload(rec) {
  const st = rec.game;
  const board = st.board.map((row) => row.slice());
  return {
    offlineId: rec.offlineId,
    botType: rec.botType,
    botElo: rec.botElo,
    playerEloAtStart: rec.playerEloAtStart,
    eloDelta: rec.eloDelta,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    state: {
      id: st.id, botType: st.botType, botElo: rec.botElo,
      board, premiums: { ...st.premiums },
      humanRack: st.humanRack.slice(), botRackCount: st.botRackCount,
      scores: { human: st.scores.human, bot: st.scores.bot },
      clocks: { human: st.clocks.human, bot: st.clocks.bot, turn: st.clocks.turn, turnStartedAt: st.clocks.turnStartedAt },
      botThinkUntil: st.botThinkUntil || null, botThinkRemainingMs: st.botThinkRemainingMs || null, botThinkMs: st.botThinkMs || null,
      status: st.status, reason: st.reason, winner: st.winner,
      moves: {
        human: (st.moves.human || []).map((m) => ({ ...m, words: (m.words || []).map((w) => ({ ...w })) })),
        bot: (st.moves.bot || []).map((m) => ({ ...m, words: (m.words || []).map((w) => ({ ...w })) })),
      },
      lastCells: (st.lastCells || []).map((c) => c.slice()),
      lastWord: st.lastWord, lastScore: st.lastScore, lastBy: st.lastBy,
      lastHuman: st.lastHuman ? { ...st.lastHuman } : null,
      lastBot: st.lastBot ? { ...st.lastBot } : null,
      // Replay log (v123): stored with the game so a synced offline
      // game replays from Past Games too. clocks (v129): the per-move
      // remaining times MUST travel with the log — v128's review
      // rewinds each clock from the mover's own entries, and dropping
      // clocks here left every synced offline game with a clock-less
      // log, so the review fell back to the final clocks for both
      // sides and neither clock moved while stepping.
      moveLog: (st.moveLog || []).map((m) => ({ side: m.side, placements: (m.placements || []).map((p) => ({ row: p.row, col: p.col, letter: p.letter })), words: (m.words || []).map((w) => ({ ...w })), score: m.score, mainWord: m.mainWord, clocks: m.clocks ? { human: m.clocks.human, bot: m.clocks.bot } : undefined })),
      eloDeltaHuman: st.eloDeltaHuman, eloDeltaBot: st.eloDeltaBot,
      eloAfterHuman: st.eloAfterHuman, eloAfterBot: st.eloAfterBot,
      isFirst: !!st.isFirst,
      player: st.player ? { ...st.player } : null,
    },
    plays: (rec.plays || []).map((p) => ({ side: p.side, rack: p.rack.slice(), placements: p.placements.map((q) => ({ row: q.row, col: q.col, letter: q.letter })) })),
  };
}
function scheduleDrain() {
  if (drainScheduled || drainRunning || !outboxMayBeNonEmpty) return;
  drainScheduled = true;
  setTimeout(() => { drainScheduled = false; drainOutbox(); }, 0);
}
async function drainOutbox() {
  if (drainRunning) return;
  drainRunning = true;
  try {
    // navigator.onLine alone lies; the /api/me below is the real check.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try { await api('/api/me'); } catch { return; } // offline: stay queued
    let recs = [];
    try { recs = await offlineStoreGetAll(); } catch { return; }
    // Sequential, finishedAt order — never parallel.
    const finished = recs.filter((r) => r.status === 'finished').sort((a, b) => new Date(a.finishedAt || 0) - new Date(b.finishedAt || 0));
    for (const rec of finished) {
      let res;
      try {
        res = await api('/api/games/sync', { method: 'POST', body: JSON.stringify(buildSyncPayload(rec)) });
      } catch (e) {
        // 422: the server replay rejected this game — mark it rejected
        // and roll its delta out of the local Elo. Never retry it.
        if (e && e.status === 422) {
          try { rec.status = 'rejected'; await offlineStorePut(rec); } catch {}
          pendingEloSum -= (rec.eloDelta || 0);
          if (game && game.offline && game.id === 'offline-' + rec.offlineId) game.offlinePending = false;
          continue;
        }
        // Anything else (network down, dead session): stop the drain
        // and keep the rest queued. A dead session must not bounce
        // the user to sign-in from a background sync.
        return;
      }
      // 200 (including an idempotent duplicate): clear the outbox entry.
      try { await offlineStoreDel(rec.offlineId); } catch {}
      pendingEloSum -= (rec.eloDelta || 0);
      // The delta is now on the server: fold it into the persisted Elo
      // (the response carries the new Elo, except on a duplicate
      // re-submit, where the delta is added to the persisted copy —
      // a duplicate only happens when the first response was lost, so
      // the persisted copy does not have it yet).
      const newElo = res && typeof res.eloAfter === 'number' ? res.eloAfter : null;
      // A freeExit response (v138) means the server recorded NOTHING
      // for this game, so the local Elo must not gain the delta — the
      // record is gone and pendingEloSum already dropped above, which
      // is the whole fix.
      if (res && res.freeExit) {
        // Nothing to fold: the server refused the game as a free exit.
      } else if (me) {
        me.elo = newElo != null ? newElo : (typeof me.elo === 'number' ? me.elo + (rec.eloDelta || 0) : me.elo);
        persistMe();
      } else if (newElo != null) {
        const stored = loadPersistedMe();
        if (stored) { stored.elo = newElo; try { storeSet('duello_me', JSON.stringify(stored)); } catch {} }
      }
      if (game && game.offline && game.id === 'offline-' + rec.offlineId) game.offlinePending = false;
    }
    await refreshOfflineTotals();
  } finally {
    drainRunning = false;
  }
}
// Before an online or friend game starts, the server must have every
// finished offline game: the new game's Elo is computed from the
// server Elo, so starting on a stale one would misprice the game.
// Wait for a running drain (up to 15s), then run one if the outbox
// is non-empty. Callers skip this entirely when offline — the drain
// itself also bails at once when the network is down (v111).
async function syncBeforeOnlinePlay() {
  try {
    const t0 = Date.now();
    while (drainRunning && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 100));
    if (outboxMayBeNonEmpty) await drainOutbox();
  } catch {}
}
const LOCAL_VALUES = { A:1,B:4,C:4,D:3,E:1,F:5,G:3,H:4,I:1,J:9,K:6,L:2,M:4,N:2,O:1,P:4,Q:10,R:1,S:1,T:1,U:2,V:6,W:5,X:8,Y:5,Z:9 };
const SIZE = 10;
function localWordAt(board, r, c, dir) {
  let cells = [];
  if (dir === 'H') {
    let s = c; while (s > 0 && board[r][s - 1]) s--;
    let e = c; while (e < SIZE - 1 && board[r][e + 1]) e++;
    for (let cc = s; cc <= e; cc++) cells.push([r, cc]);
  } else {
    let s = r; while (s > 0 && board[s - 1][c]) s--;
    let e = r; while (e < SIZE - 1 && board[e + 1][c]) e++;
    for (let rr = s; rr <= e; rr++) cells.push([rr, c]);
  }
  return { word: cells.map(([rr, cc]) => board[rr][cc]).join(''), cells };
}
function localScoreWord(board, cells, newSet, premiums) {
  let sum = 0, wordMult = 1;
  for (const [r, c] of cells) {
    let v = LOCAL_VALUES[board[r][c]] || 0;
    if (newSet.has(`${r},${c}`)) {
      const pr = premiums[`${r},${c}`];
      if (pr === 'DL') v *= 2; else if (pr === 'TL') v *= 3;
      else if (pr === 'DW') wordMult *= 2; else if (pr === 'TW') wordMult *= 3;
    }
    sum += v;
  }
  return sum * wordMult;
}
// Mirrors the server's validatePlay verdict (valid/error/invalidWords/
// score/mainWord/mainCells/bonus/isDuello/bingo/words). Rack and occupancy
// checks are skipped: placements are built from the rack onto empty cells
// by construction, and the server re-checks everything on submit.
function localValidate(board, placements, isFirst, wordsSet, premiums) {
  if (!placements || !placements.length) return { valid: false, error: 'No tiles placed.' };
  if (placements.length > 6) return { valid: false, error: 'Too many tiles.' };
  for (const pl of placements) if (pl.row < 0 || pl.row >= SIZE || pl.col < 0 || pl.col >= SIZE) return { valid: false, error: 'Tile off the board.' };
  const sameRow = placements.every(pl => pl.row === placements[0].row);
  const sameCol = placements.every(pl => pl.col === placements[0].col);
  if (!sameRow && !sameCol) return { valid: false, error: 'all tiles must be connected' };
  const dir = sameRow ? 'H' : 'V';
  const sorted = placements.slice().sort((a, b) => dir === 'H' ? a.col - b.col : a.row - b.row);
  const lineIdx = dir === 'H' ? sorted[0].row : sorted[0].col;
  const lo = dir === 'H' ? sorted[0].col : sorted[0].row;
  const hi = dir === 'H' ? sorted[sorted.length - 1].col : sorted[sorted.length - 1].row;
  const trial = board.map(row => row.slice());
  for (const pl of placements) trial[pl.row][pl.col] = pl.letter;
  for (let i = lo; i <= hi; i++) {
    const cell = dir === 'H' ? trial[lineIdx][i] : trial[i][lineIdx];
    if (!cell) return { valid: false, error: 'all tiles must be connected' };
  }
  const inInner = (r, c) => r >= 2 && r <= 7 && c >= 2 && c <= 7;
  if (isFirst) {
    for (const pl of placements) if (!inInner(pl.row, pl.col)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
    if (dir === 'H' && (lineIdx < 2 || lineIdx > 7)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
    if (dir === 'V' && (lineIdx < 2 || lineIdx > 7)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
  } else {
    let mainIncludesExisting = false;
    for (let i = lo; i <= hi; i++) { const was = dir === 'H' ? board[lineIdx][i] : board[i][lineIdx]; if (was) mainIncludesExisting = true; }
    let adjacent = false;
    for (const pl of placements) {
      const neigh = [[pl.row - 1, pl.col], [pl.row + 1, pl.col], [pl.row, pl.col - 1], [pl.row, pl.col + 1]];
      if (neigh.some(([r, c]) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c])) adjacent = true;
    }
    if (!mainIncludesExisting && !adjacent) return { valid: false, error: 'all tiles must be connected' };
  }
  const newSet = new Set(placements.map(pl => `${pl.row},${pl.col}`));
  if (placements.length === 1 && !isFirst) {
    const both = [localWordAt(trial, placements[0].row, placements[0].col, 'H'), localWordAt(trial, placements[0].row, placements[0].col, 'V')].filter(w => w.word.length >= 2);
    if (!both.length) return { valid: false, error: 'Word too short.' };
    const bad = [...new Set(both.filter(w => !wordsSet.has(w.word)).map(w => w.word))];
    if (bad.length) return { valid: false, error: 'not a word', invalidWords: bad, words: both };
    const scored1 = both.map(w => ({ word: w.word, cells: w.cells, score: localScoreWord(trial, w.cells, newSet, premiums) }));
    const isDuello1 = both.some(w => w.word === 'DUELLO');
    const bonus1 = isDuello1 ? 30 : 0;
    const main1 = scored1.find(w => w.word === 'DUELLO') || scored1.reduce((a, b) => (b.score > a.score ? b : a));
    return { valid: true, words: scored1, score: scored1.reduce((s, w) => s + w.score, 0) + bonus1, mainWord: main1.word, mainCells: main1.cells, bonus: bonus1, isDuello: isDuello1, bingo: false, placements };
  }
  const main = localWordAt(trial, placements[0].row, placements[0].col, dir);
  if (main.word.length < 2) return { valid: false, error: 'Word too short.' };
  const words = [{ word: main.word, cells: main.cells }];
  const crossDir = dir === 'H' ? 'V' : 'H';
  for (const pl of placements) {
    const cross = localWordAt(trial, pl.row, pl.col, crossDir);
    if (cross.word.length >= 2 && !words.some(w => w.word === cross.word && JSON.stringify(w.cells) === JSON.stringify(cross.cells))) words.push({ word: cross.word, cells: cross.cells });
  }
  const invalidWords = [];
  for (const w of words) if (!wordsSet.has(w.word)) invalidWords.push(w.word);
  if (invalidWords.length) {
    const uniq = [...new Set(invalidWords)];
    return { valid: false, error: 'not a word', invalidWords: uniq, words };
  }
  let score = 0;
  const scored = words.map(w => { const s = localScoreWord(trial, w.cells, newSet, premiums); score += s; return { word: w.word, cells: w.cells, score: s }; });
  const isDuello = main.word === 'DUELLO';
  const bingo = placements.length === 6;
  let bonus = 0;
  if (isDuello) bonus += 30;
  if (bingo) bonus += 30;
  score += bonus;
  return { valid: true, words: scored, score, mainWord: main.word, mainCells: main.cells, bonus, isDuello, bingo, placements };
}
function setPlayState(state) {
  // Play colour is class-based, NOT disabled-based, so a grey Play is still
  // tappable: a disabled button swallows taps, and that swallow was the
  // double-tap. Tapping grey Play with a known-invalid placement does
  // nothing (doPlay returns before any server call); only no-pending /
  // bot-turn Play is truly disabled, and the handler returns early there
  // anyway.
  const b = $('playBtn');
  b.classList.remove('validating', 'play-valid', 'play-invalid');
  if (state === 'valid') { b.classList.add('play-valid'); b.disabled = false; }
  else if (state === 'validating') { b.classList.add('validating'); b.disabled = false; }
  else if (state === 'invalid') { b.classList.add('play-invalid'); b.disabled = false; }
  else { b.disabled = true; }
}
function sentence(s) {
  if (!s) return 'Game over.';
  s = String(s).trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return (s.endsWith('.') || s.endsWith('!') || s.endsWith('?')) ? s : s + '.';
}
function invalidWordsStatus(w) {
  const list = w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
  return w.length === 1 ? `${list} is not a word.` : `${list} are not words.`;
}
async function updateStatus() {
  if (!game) return;
  if (game.status === 'finished') { $('status').textContent = sentence(game.reason || 'Game over'); return; }
  if (game.clocks.turn !== 'human') { $('status').textContent = waitingStatus(); setPlayState('off'); return; }
  if (!pending.length) { $('status').textContent = game.isFirst ? 'First word must fit inside the glowing 6×6.' : 'Your move.'; setPlayState('off'); lastValidate = null; lastValidatePlacements = null; return; }
  if (localWords) {
    const v = localValidate(game.board, pending, game.isFirst, localWords, game.premiums || {});
    const snapshot = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
    lastValidate = v; lastValidatePlacements = snapshot;
    if (v.valid) { $('status').textContent = 'Play?'; setPlayState('valid'); showBubble(v.score, v.mainCells); }
    else if (v.invalidWords && v.invalidWords.length) { $('status').textContent = invalidWordsStatus(v.invalidWords); setPlayState('invalid'); hideBubble(); }
    else { $('status').textContent = v.error ? v.error.charAt(0).toUpperCase() + v.error.slice(1) + (v.error.endsWith('.') ? '' : '.') : 'Invalid play.'; setPlayState('invalid'); hideBubble(); }
    return;
  }
  ensureLocalWords();
  setPlayState('validating');
  try {
    // Seq guard, not just a snapshot check: validations can complete out
    // of order, and the old code let a stale verdict overwrite the latest
    // one, clear validateInFlight, and leave Play grey for a valid play —
    // so the first tap was swallowed and a second tap was required.
    const mySeq = ++validateSeq;
    const snapshot = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
    const myPromise = api(`/api/games/${game.id}/validate`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
    validateInFlight = myPromise;
    const v = await myPromise;
    if (mySeq !== validateSeq) return; // a newer validation superseded this one
    if (validateInFlight === myPromise) validateInFlight = null;
    lastValidate = v; lastValidatePlacements = snapshot;
    if (JSON.stringify(pending.map(p => [p.row, p.col, p.letter])) !== snapshot) return;
    if (v.valid) { $('status').textContent = 'Play?'; setPlayState('valid'); showBubble(v.score, v.mainCells); }
    else if (v.invalidWords && v.invalidWords.length) {
      $('status').textContent = invalidWordsStatus(v.invalidWords);
      setPlayState('invalid'); hideBubble();
    } else { $('status').textContent = v.error ? v.error.charAt(0).toUpperCase() + v.error.slice(1) + (v.error.endsWith('.') ? '' : '.') : 'Invalid play.'; setPlayState('invalid'); hideBubble(); }
  } catch {
    // A failed check used to leave a stale status ("Your move." / "Play?")
    // with Play greyed, so an invalid word never got named until the user
    // tapped Play. Retry once for a transient failure (Render waking up);
    // if that also fails, Play stays tappable and its server verdict
    // names the words (see doPlay catch). Offline games never reach the
    // server path — doLocalPlay validates authoritatively instead.
    if (game && game.offline) { $('status').textContent = 'Offline play needs the dictionary — connect once to download it.'; return; }
    setPlayState('invalid');
    const retrySnapshot = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
    setTimeout(async () => {
      if (!game || game.status !== 'active' || game.clocks.turn !== 'human') return;
      if (JSON.stringify(pending.map(p => [p.row, p.col, p.letter])) !== retrySnapshot) return;
      try {
        const v2 = await api(`/api/games/${game.id}/validate`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
        if (JSON.stringify(pending.map(p => [p.row, p.col, p.letter])) !== retrySnapshot) return;
        lastValidate = v2; lastValidatePlacements = retrySnapshot;
        if (v2.valid) { $('status').textContent = 'Play?'; setPlayState('valid'); showBubble(v2.score, v2.mainCells); }
        else if (v2.invalidWords && v2.invalidWords.length) { $('status').textContent = invalidWordsStatus(v2.invalidWords); setPlayState('invalid'); hideBubble(); }
      } catch {}
    }, 500);
  }
}
function attachBubble(score, target, kind) {
  const cells = document.querySelectorAll('#board .cell');
  const cell = cells[target[0] * 10 + target[1]];
  if (!cell) return;
  const b = document.createElement('div'); b.className = 'play-bubble' + (kind ? ' ' + kind : ''); b.textContent = score;
  cell.style.position = 'relative'; cell.style.zIndex = '50'; cell.appendChild(b);
}
function showBubble(score, mainCells) {
  hideBubble();
  if (!pending.length) return;
  // Bubble goes over the positionally last letter of the word string, not
  // the last tile the player happened to drop: mainCells are in word order,
  // so their last cell is the last letter. Fall back to the pending tile
  // with the largest row/col in the play direction.
  let target = null;
  if (mainCells && mainCells.length) target = mainCells[mainCells.length - 1];
  else {
    const sameRow = pending.every(p => p.row === pending[0].row);
    const sorted = pending.slice().sort((a, b) => sameRow ? a.col - b.col : a.row - b.row);
    target = [sorted[sorted.length - 1].row, sorted[sorted.length - 1].col];
  }
  attachBubble(score, target);
}
function hideBubble() { document.querySelectorAll('.play-bubble').forEach(e => { if (e.parentElement) e.parentElement.style.zIndex = ''; e.remove(); }); }
function placeTile(r, c) {
  if (!canPlaceTiles()) return;
  if (game.board[r][c]) return;
  if (pending.some(p => p.row === r && p.col === c)) return;
  const letter = game.humanRack[selectedRack];
  pending.push({ row: r, col: c, letter, rackIndex: selectedRack });
  selectedRack = null; renderGame();
}
function recallTile(pend) {
  // No recall while a play is in flight or it is not the human turn:
  // after tapping Play, pending tiles stay on the board until the
  // server reply lands, and tapping one in that window used to
  // briefly recall it (visually) before the reply put it back.
  if (playInFlight) return;
  if (!game || game.status !== 'active' || game.clocks.turn !== 'human') return;
  pending = pending.filter(p => p !== pend); renderGame();
}
$('recallBtn').onclick = () => { if (playInFlight) return; cleanupStuckDrag(); pending = []; selectedRack = null; renderGame(); };
let shuffling = false;
$('shuffleBtn').onclick = async () => {
  cleanupStuckDrag();
  if (!game || shuffling) return;
  // Works on the player's turn AND on the opponent's turn, and when
  // out of time: the rack is the player's own rack, the shuffle
  // endpoint does not require it to be your turn, and the greyed
  // opponent-turn rack is opacity-only (not disabled).
  // While a Play is in flight the rack has blank slots (played tiles,
  // refilled by the reply), so a server shuffle would be rejected for
  // not matching the server rack: shuffle only the letters still in
  // the rack, locally, keeping the blanks where they are. The reply
  // refills the rack and takes over from there.
  if (optimisticPlay) {
    const letters = game.humanRack.filter(l => l);
    for (let i = letters.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [letters[i], letters[j]] = [letters[j], letters[i]]; }
    let k = 0;
    game.humanRack = game.humanRack.map(l => (l ? letters[k++] : null));
    renderGame();
    return;
  }
  const rack = [...game.humanRack];
  for (let i = rack.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rack[i], rack[j]] = [rack[j], rack[i]]; }
  const rackEl = $('rack');
  shuffling = true;
  // Fold in: every tile slides toward the rack centre, shrinking, so the
  // tiles pass around one another instead of just popping in place.
  const fold = (tiles) => {
    const centre = rackEl.getBoundingClientRect().left + rackEl.getBoundingClientRect().width / 2;
    tiles.forEach(t => {
      const r = t.getBoundingClientRect();
      const dx = centre - (r.left + r.width / 2);
      t.style.transition = 'transform 50ms ease-in, opacity 50ms ease-in';
      t.style.transform = `translateX(${dx}px) scale(0.6)`;
      t.style.opacity = '0.6';
    });
  };
  fold([...rackEl.querySelectorAll('.tile')]);
  await new Promise(r => setTimeout(r, 60));
  // Offline games shuffle locally: the rack is the player's own, and
  // there is no server rack to agree with.
  if (game.offline) { game.humanRack = rack; renderGame(); shuffling = false; return; }
  try {
    game = await api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) }); gameFetchAt = Date.now(); renderGame();
    // Fold out: new tiles start collapsed at the centre and expand to
    // their new slots, so the new order is revealed by the unfold.
    const newTiles = [...$('rack').querySelectorAll('.tile')];
    const centre2 = $('rack').getBoundingClientRect().left + $('rack').getBoundingClientRect().width / 2;
    newTiles.forEach(t => {
      const r = t.getBoundingClientRect();
      const dx = centre2 - (r.left + r.width / 2);
      t.style.transition = 'none';
      t.style.transform = `translateX(${dx}px) scale(0.6)`;
      t.style.opacity = '0.6';
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      newTiles.forEach(t => {
        t.style.transition = 'transform 70ms ease-out, opacity 70ms ease-out';
        t.style.transform = ''; t.style.opacity = '';
      });
      setTimeout(() => newTiles.forEach(t => { t.style.transition = ''; }), 90);
    }));
  } catch {
    // Shuffle failed server-side: unfold the original tiles back out.
    [...rackEl.querySelectorAll('.tile')].forEach(t => { t.style.transition = 'transform 70ms ease-out, opacity 70ms ease-out'; t.style.transform = ''; t.style.opacity = ''; });
  }
  shuffling = false;
};
function armButton(btn, label, fn, penalty) {
  // The label may be a function (the Forfeit button reads "Exit" once
  // your time expires), so resolve it at each use instead of at wiring.
  // The penalty may be a function too (v145): a free exit against a
  // bot before any moves carries no penalty, so its confirm is just
  // "SURE?" with nothing underneath.
  const getLabel = () => (typeof label === 'function' ? label() : label);
  const getPenalty = () => (typeof penalty === 'function' ? penalty() : penalty);
  return async () => {
    if (!armed[btn.id]) { armed[btn.id] = true; btn.classList.add('armed-red'); btn.innerHTML = 'SURE?<span class="penalty">' + getPenalty() + '</span>'; setTimeout(() => { armed[btn.id] = false; btn.classList.remove('armed-red'); btn.textContent = getLabel(); }, 3000); return; }
    armed[btn.id] = false; btn.classList.remove('armed-red'); btn.textContent = getLabel(); await fn();
  };
}
$('passBtn').onclick = armButton($('passBtn'), 'Pass', async () => {
  // Offline games pass locally: -30s, no server round-trip.
  if (game && game.offline) { await doLocalPass(); return; }
  // Same tap-time clock switch as Play: freeze human, start bot now.
  const tapAt = Date.now(); const clientElapsedMs = Math.max(0, tapAt - gameFetchAt);
  const prevHuman = game.clocks.human, prevFetchAt = gameFetchAt;
  game.clocks.human = Math.max(0, game.clocks.human - clientElapsedMs); game.clocks.turn = 'bot'; gameFetchAt = tapAt; renderGame(); tickClocks();
  const fromHuman = game.clocks.human;
  // v154: the runoff starts before the render (see pollBotTurn) —
  // the render's tick would snap the human clock to the post-pass
  // value first and the animation would jump it back up to fromHuman.
  try { botTurnTapTime = tapAt; game = await api(`/api/games/${game.id}/pass`, { method: 'POST', body: JSON.stringify({ clientElapsedMs }) }); gameAppliedSeq = gameFetchSeq; gameFetchAt = tapAt; pending = []; animateHumanRunoff(fromHuman, game.clocks.human); renderGame(); beginBotTurn(); }
  catch { game.clocks.turn = 'human'; game.clocks.human = prevHuman; gameFetchAt = prevFetchAt; renderGame(); }
}, '-30s');
$('forfeitBtn').onclick = armButton($('forfeitBtn'), () => forfeitLabel(), async () => {
  // Forfeiting during the countdown stops it outright (v107): the
  // countdown must never fire endCountdown on a finished game.
  cancelCountdown();
  const wasOutOfTime = humanOutOfTime();
  const wasLosing = game && game.scores && game.scores.human < game.scores.bot;
  // v138: bot game, no moves played yet — a FREE EXIT. Nothing is
  // recorded (no loss, no Elo, no Game History entry) and the game
  // goes away entirely. This check comes first: a no-move game can
  // be out of time (the clock ran down before any play) and that is
  // still a free exit, not the out-of-time path below. Persona and
  // real-player games never reach here (isFreeExitBotGame is false
  // for them — their forfeit is a loss even before the first move).
  if (isFreeExitBotGame()) {
    if (game.offline) { doLocalFreeExit(); goHome(); return; }
    let out = null, exitOk = true;
    try {
      out = await api(`/api/games/${game.id}/forfeit`, { method: 'POST' });
    } catch {
      exitOk = false;
      $('status').textContent = 'Exit needs a connection — reconnect to exit.';
      renderGame();
    }
    if (!exitOk) return;
    if (out && out.freeExit) { game = null; goHome(); return; }
    // Race: a move landed before the forfeit reached the server, so
    // the server recorded a real forfeit (a loss). Handle it as one.
    game = out; gameAppliedSeq = gameFetchSeq; gameFetchAt = Date.now(); pending = [];
    if (wasOutOfTime) { statShownGameId = game.id; goHome(); } else { renderGame(); }
    return;
  }
  // Out of time + losing (v123, item 3 — was "Leave", now "Exit").
  // You exit to the main menu at once (no stat window — you are
  // done); the loss and Elo move are recorded, and a real opponent
  // keeps playing the game out. A bot game has no one to play out,
  // so Exit there ends the game outright, same as a forfeit.
  if (wasOutOfTime && wasLosing) {
    statShownGameId = game.id;
    if (game.offline) { doLocalForfeit(); goHome(); return; }
    try { await api(`/api/games/${game.id}/leave`, { method: 'POST' }); } catch (e) { /* leave anyway: the loss is recorded on the next load */ }
    goHome();
    return;
  }
  // Offline games forfeit locally: the forfeiter loses, no server call.
  if (game && game.offline) { doLocalForfeit(); return; }
  let forfeitOk = true;
  try {
    game = await api(`/api/games/${game.id}/forfeit`, { method: 'POST' });
  } catch {
    // Offline mid-game (v116): a server game cannot forfeit without
    // the server — say so instead of dying silently. Bot games never
    // reach here (always native).
    forfeitOk = false;
    $('status').textContent = 'Forfeit needs a connection — reconnect to forfeit.';
    renderGame();
  }
  if (!forfeitOk) return;
  gameAppliedSeq = gameFetchSeq; gameFetchAt = Date.now(); pending = [];
  if (wasOutOfTime) {
    // Exit: the loss and Elo move are recorded server-side, but there
    // is no stat window — leave straight to the main menu. Marking the
    // stats as shown for this game stops renderGame from popping the
    // window on the finished game.
    statShownGameId = game.id;
    goHome();
  } else {
    renderGame();
  }
}, () => isFreeExitBotGame() ? '' : 'you lose');
async function doPlay() {
  // Unstick first, and clear the drag's click-suppression flag: after a
  // drag, suppressNextClick stayed true until an empty cell was tapped,
  // and the Play tap itself was the thing that had to wait for a
  // validation round-trip to show any feedback.
  cleanupStuckDrag(); suppressNextClick = false;
  if (!game || game.clocks.turn !== 'human' || !pending.length || playInFlight) return;
  // Offline games play locally: authoritative local validation, no POST.
  if (game.offline) { await doLocalPlay(); return; }
  // A Play tap with no valid word does nothing: when the verdict for
  // these exact placements is known and invalid, return before any clock
  // switch, rack change, render, or server call. When the verdict is
  // unknown (validation still in flight or the word list not loaded yet),
  // fall through and let the server decide authoritatively.
  const tapKey = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
  if (lastValidate && lastValidatePlacements === tapKey && !lastValidate.valid) return;
  // Do NOT wait for a validation round-trip: the server play call
  // validates authoritatively and will error if the play is truly
  // invalid. Waiting made the first tap look dead (no feedback at all
  // until validate returned), so users tapped again or tapped elsewhere
  // and only then saw the play go through.
  // Clock switch happens AT THE TAP, not at the server reply: freeze
  // the human clock at its tap-time value and start the bot clock
  // ticking from the tap, via tickClocks only (no full render, so no
  // validation round-trip re-enables Play mid-flight). Before this,
  // the 100ms interval kept ticking the human clock for the whole
  // Play POST (sometimes ~1s), and the bot clock only started when
  // the reply landed.
  const tapAt = Date.now();
  const clientElapsedMs = Math.max(0, tapAt - gameFetchAt);
  const prevHuman = game.clocks.human, prevFetchAt = gameFetchAt;
  const prevScore = game.scores.human, prevLastHuman = game.lastHuman, prevRack = game.humanRack.slice();
  // v157: the move is committed at the tap — refresh the 9s now, not
  // when the POST returns, or a slow round-trip could expire a
  // countdown the player had already beaten. A failed Play restores
  // the pre-tap state below, and the fresh window stands for the
  // re-attempt.
  resetByoyomi('human');
  game.clocks.human = Math.max(0, game.clocks.human - clientElapsedMs);
  // The turn only flips to the opponent at the tap when they still
  // have time: with their clock already at 0 there is no bot turn
  // at all (the server keeps the turn with the human), so flipping
  // here flashed "Waiting for your opponent." for the split second
  // until the reply landed.
  const botHasTime = game.clocks.bot > 0;
  if (botHasTime) game.clocks.turn = 'bot';
  gameFetchAt = tapAt;
  // Score immediately at the tap, not when the Play POST returns: the
  // validation verdict for these exact placements already carries the
  // score (including bonuses), so add it now and show the played words
  // below the clock. The server reply then replaces the whole game
  // object with the authoritative score, so there is no double count;
  // a failed Play restores the pre-tap score and last play below.
  const pendKey = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
  if (lastValidate && lastValidate.valid && lastValidatePlacements === pendKey) {
    game.scores.human += lastValidate.score;
    game.lastHuman = { word: lastValidate.mainWord, points: lastValidate.score, bonus: lastValidate.bonus, isDuello: lastValidate.isDuello, bingo: lastValidate.bingo, words: (lastValidate.words || []).map(w => w.word) };
  }
  // Played tiles leave the rack immediately at the tap, as blank slots
  // — not as random replacement letters. The old code drew a client-side
  // refill at the tap, which the server reply then replaced with
  // different letters: the visible flicker Jeff reported. The slots the
  // server will refill are the indexOf-matched ones (same as applyMove);
  // they stay blank until the server reply fills them with its
  // authoritative letters, so no letter ever changes into another one.
  {
    const remaining = game.humanRack.slice(); const usedSet = new Set();
    for (const pl of pending) { const idx = remaining.indexOf(pl.letter); if (idx >= 0) { usedSet.add(idx); remaining[idx] = null; } }
    game.humanRack = game.humanRack.map((l, i) => usedSet.has(i) ? null : l);
    optimisticPlay = true;
  }
  // Highlight the opponent's scoreboard AT THE TAP, not when the Play
  // POST returns: render now so the .active border flips immediately.
  playInFlight = true;
  renderGame();
  $('playBtn').disabled = true; $('playBtn').classList.remove('validating', 'play-valid', 'play-invalid');
  $('status').textContent = botHasTime ? waitingStatus() : 'Your move.'; tickClocks();
  try {
    botTurnTapTime = tapAt;
    game = await api(`/api/games/${game.id}/play`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })), clientElapsedMs }) });
    // This reply is the newest state: invalidate every fetch sent
    // before it, so a slow pre-play GET landing after the reply can
    // no longer overwrite the board with the pre-play snapshot.
    gameAppliedSeq = gameFetchSeq;
    // Keep the bot clock ticking from the tap, not from the reply:
    // gameFetchAt stays at tapAt, so the bot display does not jump
    // back up by the POST duration when the reply lands.
    gameFetchAt = tapAt; pending = []; optimisticPlay = false; cleanupStuckDrag(); $('rack').classList.add('instant'); renderGame(); setTimeout(() => $('rack').classList.remove('instant'), 100); beginBotTurn(); loadMe();
  } catch (e) {
    // Play failed: restore the human turn, its pre-tap clock, and the
    // pre-tap score / last play (undoing the optimistic score above).
    game.clocks.turn = 'human'; game.clocks.human = prevHuman; gameFetchAt = prevFetchAt;
    game.scores.human = prevScore; game.lastHuman = prevLastHuman; game.humanRack = prevRack; optimisticPlay = false;
    $('status').textContent = (e.invalidWords && e.invalidWords.length) ? invalidWordsStatus(e.invalidWords) : sentence(String(e.message || '').slice(0, 48)); renderGame();
  }
  finally { playInFlight = false; }
}
// Fire on pointerdown, not only on click: after a drag, iOS can swallow
// the synthesised click for the first tap, which is exactly the
// "double-tap or tap elsewhere first" pattern. Pointerdown fires on the
// first touch, and the following click is ignored so one tap = one play.
let playPointerAt = 0;
$('playBtn').addEventListener('pointerdown', e => { playPointerAt = Date.now(); doPlay(); });
$('playBtn').addEventListener('click', e => { if (Date.now() - playPointerAt < 1000) return; doPlay(); });
let statDelayTimer = null, statShownGameId = null;
function clearStatDelay() { if (statDelayTimer) { clearTimeout(statDelayTimer); statDelayTimer = null; } }
// The stat window shows instantly on every finish now (Nov 5,
// 2026): when both clocks hit 0 the window comes up at once
// instead of showing the final board for 3s first. The old 3s
// timeout delay and its isTimeoutFinish check are gone; the
// statDelayTimer machinery stays as a harmless guard (startGame
// and navigation still clear it) but nothing ever sets it.
// v148: the Optimal moves tally is tappable — it lists the optimal
// moves that side played, built from the same game.moves data the
// tally counts (isOptimal per move; Fishstick's exhaustive engine
// decides optimality). Tapping the same tally again (or the ×)
// closes the list. Which side's list is open, and the display names
// for the two boxes, live here so the list survives a re-render.
let statOptimalSide = null;
let statOptimalLabels = { human: 'You', bot: 'Opponent' };
let statWindowStats = null; // v154: the stats payload the tally counts from, so the list reads the same data.
// v156: the optimal count for one side in the stat window (from the
// stats payload when present, else from the game log).
function statOptimalCount(side) {
  const st = (statWindowStats && statWindowStats[side]) || (game && game.moves ? game.moves.find(m => m.player === side) : null);
  return st && typeof st.optimal === 'number' ? st.optimal : 0;
}
function toggleStatOptimalList(side) {
  const list = $('statOptimalList'); if (!list) return;
  // v157: Fishstick's tally is never tappable — a stray call (e.g.
  // a stale handler) must not open its list, whatever the count.
  if (side === 'bot' && game && game.botType === 'fishstick') { list.classList.add('hidden'); statOptimalSide = null; return; }
  // v156: no list at 0 — a 0 tally is not tappable, and a stray call
  // (e.g. a stale handler) must not open an empty list.
  if (statOptimalCount(side) <= 0) { list.classList.add('hidden'); statOptimalSide = null; return; }
  if (statOptimalSide === side && !list.classList.contains('hidden')) {
    list.classList.add('hidden'); statOptimalSide = null; return;
  }
  renderStatOptimalList(side);
}
function renderStatOptimalList(side) {
  const list = $('statOptimalList'); if (!list) return;
  // v154: the list reads the same data the tally counts — the
  // optimalMoves the stats payload carries (engine computeStats).
  // The old code rebuilt it from game.moves, which is empty for
  // server games and for games opened from Game History, so the
  // list showed 0 while the tally said several were played.
  const fromStats = (statWindowStats && statWindowStats[side] && Array.isArray(statWindowStats[side].optimalMoves)) ? statWindowStats[side].optimalMoves : null;
  const optimal = [];
  if (fromStats) for (const o of fromStats) optimal.push({ n: o.n, word: o.word || '', score: o.score || 0 });
  else {
    const moves = (game && game.moves && game.moves[side]) || [];
    moves.forEach((m, i) => { if (m && m.isOptimal) optimal.push({ n: i + 1, word: m.mainWord || '', score: m.score || 0 }); });
  }
  const label = statOptimalLabels[side] || (side === 'human' ? 'You' : 'Opponent');
  let html = `<div class="stat-optimal-head"><span>${label} — optimal moves (${optimal.length})</span><button class="stat-optimal-close" aria-label="Close">×</button></div>`;
  if (!optimal.length) html += `<div class="stat-optimal-empty">No optimal moves yet.</div>`;
  // v157: no move number — just the word and its points.
  else for (const o of optimal) html += `<div class="stat-optimal-row"><span>${o.word}</span><span class="num">${o.score} pts</span></div>`;
  list.innerHTML = html;
  const closeBtn = list.querySelector('.stat-optimal-close');
  if (closeBtn) closeBtn.onclick = () => { list.classList.add('hidden'); statOptimalSide = null; };
  statOptimalSide = side;
  list.classList.remove('hidden');
}
function showStatWindowDelayed(stats) {
  if (!game || statShownGameId === game.id || statDelayTimer) return;
  showStatWindow(stats);
}
function showStatWindow(stats) {
  // v154: keep the payload — the optimal-moves list reads it.
  statWindowStats = stats;
  // A game just ended, so Elos moved and cached Global Ranks are
  // stale — clear them here (Play Again starts a new game without
  // going home, so the refresh there alone would miss it).
  rankCache.clear();
  clearStatDelay(); if (game) statShownGameId = game.id;
  const w = $('statWindow'); w.classList.remove('hidden');
  // v183: in a game review the stats window has no Main Menu / Play
  // Again at all — the whole controls row hides and the standard
  // grey back button (.back-pill, same as the bot selector's) sits
  // below it instead. It closes the window back to the board view,
  // exactly like tapping outside it.
  $('statControls').classList.toggle('hidden', reviewMode);
  $('statBackBtn').classList.toggle('hidden', !reviewMode);
  // v148: a fresh stat window starts with the optimal-moves list closed.
  const optListEl = $('statOptimalList'); if (optListEl) optListEl.classList.add('hidden');
  statOptimalSide = null;
  $('gameDim').classList.add('dimmed');
  const isPersonaGame = game && game.botType === 'persona';
  const isHumanGame = game && game.botType === 'human';
  // v157: Fishstick's optimal-moves tally is never tappable — the
  // exhaustive engine's optimal list is not something to browse.
  const isFishstickGame = game && game.botType === 'fishstick';
  const botLabel = (game && game.botType === 'fishstick') ? 'Fishstick' : isPersonaGame ? (game.persona?.firstName || 'Player') : isHumanGame ? (game.opponent?.firstName || 'Player') : 'Doppelgänger';
  const humanLabel = (me && me.firstName) ? me.firstName : 'You';
  statOptimalLabels = { human: humanLabel, bot: botLabel };
  // Winner is the game's recorded result, not the score comparison:
  // a forfeit is a loss even when the forfeiter is ahead on points.
  // stats.winner comes from the server; the reason check covers any
  // older payload without it.
  const winnerSide = stats.winner || (stats.reason === 'By forfeit' ? 'bot' : null);
  $('statWinner').textContent = winnerSide === 'human' ? humanLabel + ' wins' : winnerSide === 'bot' ? botLabel + ' wins' : winnerSide === 'draw' ? 'Draw' : (stats.scores.human > stats.scores.bot ? humanLabel + ' wins' : stats.scores.bot > stats.scores.human ? botLabel + ' wins' : 'Draw');
  $('statScore').textContent = `${stats.scores.human}–${stats.scores.bot}`;
  $('statReason').textContent = sentence(stats.reason || '');
  const fmtMove = (d, v) => v >= 0 ? '+' + v : '' + v;
  // A Fishstick match that moves your rating by nothing shows no
  // Elo change at all: the +0 is noise (losing to the 3000-rated
  // engine costs 0), and Fishstick's own move is already blank.
  // A real move — a draw (+16) or a win — still shows.
  const humanDelta = stats.eloDeltaHuman ?? 0;
  if (game && game.botType === 'fishstick' && humanDelta === 0) {
    $('eloMoveHuman').textContent = '';
    $('eloMoveHuman').className = 'elo-move';
  } else {
    $('eloMoveHuman').textContent = fmtMove(null, humanDelta);
    $('eloMoveHuman').className = 'elo-move ' + (humanDelta < 0 ? 'neg' : 'pos');
  }
  // Both Elo moves show for a human-vs-human match, and personas
  // count as humans: their rating moves opposite yours, so it is
  // shown like yours. A real opponent's move shows the same way.
  // For Doppelgänger and Fishstick the bot move stays blank.
  if (isPersonaGame || isHumanGame) {
    $('eloMoveBot').textContent = fmtMove(null, stats.eloDeltaBot ?? 0);
    $('eloMoveBot').className = 'elo-move ' + ((stats.eloDeltaBot ?? 0) < 0 ? 'neg' : 'pos');
  } else {
    $('eloMoveBot').textContent = '';
    $('eloMoveBot').className = 'elo-move';
  }
  // (Fishstick games show no Elo change at all, so both pfps centre.)
  $('eloMoveHuman').classList.toggle('hidden', !$('eloMoveHuman').textContent);
  $('eloMoveBot').classList.toggle('hidden', !$('eloMoveBot').textContent);
  const row = (label, h, b) => `<div class="stat-row"><span class="stat-label">${label}</span><span>${h}</span><span>${b}</span></div>`;
  const best = (x) => x.best ? `${x.best.word} (<span class="num">${x.best.score}</span>)` : '—';
  const longest = (x) => x.longest ? `${x.longest.word} (<span class="num">${x.longest.word.length}</span>)` : '—';
  const opt = (x) => `${x.optimal}/${x.total}`;
  const box = (name, pfp, st, noPhoto, clearBg, side) => `<div class="stat-box"><div class="stat-box-head"><span class="pfp${noPhoto ? ' no-photo' : ''}${clearBg ? ' clear-bg' : ''}">${pfp}</span><span class="stat-box-name">${name}</span></div><div><span class="stat-label">Best word:</span><br><span class="stat-val">${best(st)}</span></div><div><span class="stat-label">Longest word:</span><br><span class="stat-val">${longest(st)}</span></div><div><span class="stat-label">Optimal moves:</span><br><span class="stat-val num opt-tally${st && st.optimal > 0 && !(side === 'bot' && isFishstickGame) ? ' tappable' : ''}" data-side="${side}" data-optimal="${st && typeof st.optimal === 'number' ? st.optimal : 0}">${opt(st)}</span></div></div>`;
  const humanPfp = (() => { try { return pfpHTML(me); } catch { return ''; } })();
  // A persona with no photo gets the silhouette in the stat box and
  // the top pfp too (same reasoning as the scoreboard: a person
  // without a photo, not Doppelgänger).
  const botPfpBox = game.botType === 'fishstick' ? '<img src="/assets/fishstick.png?v=1" alt="Fishstick">' : isPersonaGame && usablePhoto(game.persona) ? `<img src="${game.persona.photoData}" alt="">` : isHumanGame && usablePhoto(game.opponent) ? `<img src="${game.opponent.photoData}" alt="">` : isPersonaGame || isHumanGame ? silhouetteSVG(36) : '🤖';
  const botNoPhoto = (isPersonaGame && !usablePhoto(game.persona)) || (isHumanGame && !usablePhoto(game.opponent));
  // v135: clear-bg for the stat-box bot pfp on a Doppelgänger game
  // too (its pfp is the 🤖 emoji), so the robot sits straight on the
  // stat-box background with no grey circle, same as Fishstick.
  $('statGrid').innerHTML = box(humanLabel, humanPfp, stats.human, !usablePhoto(me), false, 'human') + box(botLabel, botPfpBox, stats.bot, botNoPhoto, game.botType === 'fishstick' || game.botType === 'competitive', 'bot');
  if (game.botType === 'fishstick') $('statBotPfp').innerHTML = '<img src="/assets/fishstick.png?v=1" alt="Fishstick">';
  else if (isPersonaGame && usablePhoto(game.persona)) $('statBotPfp').innerHTML = `<img src="${game.persona.photoData}" alt="">`;
  else if (isHumanGame && usablePhoto(game.opponent)) $('statBotPfp').innerHTML = `<img src="${game.opponent.photoData}" alt="">`;
  else if (isPersonaGame) $('statBotPfp').innerHTML = silhouetteSVG(44);
  else if (isHumanGame) $('statBotPfp').innerHTML = silhouetteSVG(44);
  else $('statBotPfp').textContent = '🤖';
  $('statBotPfp').classList.toggle('no-photo', botNoPhoto);
  $('statBotPfp').classList.toggle('clear-bg', game.botType === 'fishstick');
  // No add-friend icon here any more (Nov 5, 2026): tapping a name
  // opens that person's profile window instead. Persona and real
  // games for the opponent (bots have no profile); games started
  // before v44 carry no persona username, so that name is not
  // tappable. Your own name opens your profile too (no add button
  // on it).
  const boxes = $('statGrid').querySelectorAll('.stat-box');
  const humanNameEl = boxes[0] && boxes[0].querySelector('.stat-box-name');
  if (humanNameEl && me) {
    humanNameEl.style.cursor = 'pointer';
    const humanFullName = [me.firstName, me.lastName].filter(Boolean).join(' ') || humanLabel;
    humanNameEl.onclick = () => openPersonModal({ name: humanFullName, username: me.username, elo: game.player ? game.player.elo : me.elo, photoData: me.photoData || null, isYou: true, isPersona: false });
  }
  const botUsername = isPersonaGame ? game.persona?.username : isHumanGame ? game.opponent?.username : null;
  if (botUsername) {
    const oppInfo = isHumanGame ? game.opponent : game.persona;
    const botFullName = [oppInfo.firstName, oppInfo.lastName].filter(Boolean).join(' ') || botLabel;
    const oppPerson = { name: botFullName, username: botUsername, elo: game.botElo, photoData: oppInfo?.photoData || null, isYou: false, isPersona: isPersonaGame };
    const oppNameEl = boxes[1] && boxes[1].querySelector('.stat-box-name');
    if (oppNameEl) {
      oppNameEl.style.cursor = 'pointer';
      oppNameEl.onclick = () => openPersonModal(oppPerson);
    }
    // The larger top pfp opens the same profile window, as does the
    // smaller one in the stat box. Bots have no profile, so this
    // stays persona games only.
    const oppTopPfp = $('statBotPfp');
    if (oppTopPfp) { oppTopPfp.style.cursor = 'pointer'; oppTopPfp.onclick = () => openPersonModal(oppPerson); }
    const oppBoxPfp = boxes[1] && boxes[1].querySelector('.stat-box-head .pfp');
    if (oppBoxPfp) { oppBoxPfp.style.cursor = 'pointer'; oppBoxPfp.onclick = () => openPersonModal(oppPerson); }
  }
  // v148: the Optimal moves tally is tappable — it lists the optimal
  // moves that side played (same data the tally counts). Tapping the
  // same tally again (or the ×) closes the list.
  // v156: only when the count is above 0 — a 0 tally is plain text
  // (no pointer cursor, no click, no list).
  // v157: Fishstick's tally is never tappable, whatever the count —
  // no pointer cursor, no click handler, no list.
  $('statGrid').querySelectorAll('.opt-tally').forEach(el => {
    if (Number(el.dataset.optimal || 0) <= 0) return;
    if (el.dataset.side === 'bot' && game && game.botType === 'fishstick') return;
    el.style.cursor = 'pointer';
    el.onclick = () => toggleStatOptimalList(el.dataset.side);
  });
  // A challenge that arrived during the game waited until it ended:
  // check now so its window pops up at once instead of on the next
  // 5-second poll.
  checkIncomingChallenges();
}
// v182: the Back button in a review does exactly what tapping the
// backdrop does — close the stats window back to the board view.
function closeStatWindow() { clearStatDelay(); $('statWindow').classList.add('hidden'); $('gameDim').classList.remove('dimmed'); }
$('statWindow').addEventListener('click', e => { if (e.target === $('statWindow')) closeStatWindow(); });
$('statBackBtn').onclick = closeStatWindow;
// Leaving the board screen refreshes the leaderboard data in the
// background: Elo earned in the game just played otherwise only
// shows up after a full reload, because loadMe, the Global rows
// and the friends list are all cached for the session. The tab bar
// is hidden on the board screen, so Main Menu is the only way out
// and the only place this needs to run.
async function refreshLeaderboards() {
  // A finished game changed the Elo and stats, so the cached
  // profile is stale: the next Profile tap refetches it. The
  // Friends list is invalidated the same way, via the forced
  // friends refetch below. Ranks moved too, so the rank cache
  // goes with them.
  profileData = null; rankCache.clear();
  // v149: d is declared OUTSIDE the try — a const inside the try
  // block is scoped to it, so the re-warm below would throw a
  // ReferenceError (silently swallowed by its own catch) and the
  // profile would never re-warm. Caught by the v149 harness (W1b).
  let d = null;
  try { d = await api('/api/me'); me = d.user; persistMe(); } catch (err) { deadSession(err); return; }
  globalRows = null; globalRowsVersion = null;
  // v149: re-warm the profile with the fresh payload. The invalidation
  // above used to leave the next Profile tap blanking the screen and
  // waiting on a fresh /api/me fetch — the tab looked like it never
  // preloaded, even though the boot preload had filled it. Filling
  // the (hidden) profile screen here makes the next tap instant again.
  try { await renderProfileUI(d); } catch {}
  await loadServerFriends(true);
}
function goHome() { clearStatDelay(); clearReplay(); reviewMode = false; $('statWindow').classList.add('hidden'); show('homeScreen'); refreshLeaderboards(); }
$('mainMenuBtn').onclick = goHome; $('statMainMenu').onclick = goHome;
function playAgain() {
  $('statWindow').classList.add('hidden');
  clearReplay(); reviewMode = false;
  if (currentBot === 'persona') requestRematch();
  // Play Again against a real player is another challenge to the
  // same opponent: they accept it like the first one. (The stat
  // window's button used to call startGame directly, which the
  // server rejects for real games — so it silently did nothing.)
  else if (currentBot === 'human' && game && game.opponent) startChallenge({ name: [game.opponent.firstName, game.opponent.lastName].filter(Boolean).join(' ') || 'Player', username: game.opponent.username, elo: game.botElo, photoData: game.opponent.photoData || null, isPersona: false });
  else startGame(currentBot, currentPersonaId);
}
$('playAgainBtn').onclick = playAgain;
$('statPlayAgain').onclick = playAgain;
$('gameStatsBtn').onclick = () => { if (game && game.stats) showStatWindow(game.stats); };
// Replay arrows (v123, item 5; one shared row since v124): step the
// finished game back/forward through its move sequence. Disabled at
// the ends (renderReplay sets them); a game with no moveLog cannot
// replay at all (stepReplay returns early).
$('replayBackBtn').onclick = () => stepReplay(-1);
$('replayFwdBtn').onclick = () => stepReplay(1);
// Game History review (v123, item 6; renamed v124): Exit returns to
// the list; Game Stats opens the stat window for that game.
$('reviewExitBtn').onclick = () => { reviewMode = false; clearReplay(); if (reviewOrigin === 'profile') { show('profileScreen'); if (!profileData) renderProfileUI(); else drawEloChart(); } else showPastGamesCached(); };
$('reviewStatsBtn').onclick = () => { if (game && game.stats) showStatWindow(game.stats); };
const defCache = new Map();
// Local definitions bundle (v115): the client copy of every bundled
// definition, split into sorted chunks under public/definitions/ with
// a manifest naming each chunk's first/last word. The lookup is
// local-first: a tap reads the bundle (instant, and it works offline
// — under Capacitor the files are in the app bundle; on the web the
// service worker caches them on first fetch), and /api/define is only
// a fallback for words the bundle does not hold. Chunk files are
// versioned with ?v=APP_VERSION so a rebuilt bundle is fetched fresh.
let defManifest = null, defManifestPromise = null;
const defChunkCache = new Map();
async function localDefinition(word) {
  const w = String(word || '').toUpperCase();
  if (!w) return null;
  try {
    if (!defManifest) {
      if (!defManifestPromise) {
        defManifestPromise = fetch('definitions/manifest.json?v=' + APP_VERSION)
          .then(r => { if (!r.ok) throw new Error('no manifest'); return r.json(); })
          .then(m => { defManifest = m; return m; })
          .catch(() => { defManifestPromise = null; return null; });
      }
      await defManifestPromise;
    }
    if (!defManifest || !Array.isArray(defManifest.chunks)) return null;
    // Binary search the sorted chunks for the one holding this word.
    let lo = 0, hi = defManifest.chunks.length - 1, chunk = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, c = defManifest.chunks[mid];
      if (w < c.first) hi = mid - 1;
      else if (w > c.last) lo = mid + 1;
      else { chunk = c; break; }
    }
    if (!chunk) return null;
    let entries = defChunkCache.get(chunk.file);
    if (!entries) {
      const r = await fetch('definitions/' + chunk.file + '?v=' + APP_VERSION);
      if (!r.ok) return null;
      entries = await r.json();
      defChunkCache.set(chunk.file, entries);
    }
    return entries[w] || null;
  } catch { return null; }
}
function hideDefinition() { const pop = $('defPopover'); if (pop) { pop.classList.add('hidden'); pop.style.top = ''; pop.style.bottom = ''; } }
// The first tap anywhere else only hides the definition — including a
// tap on another played word. A second tap on a word opens that word's
// definition. The tile's own pointerdown opens the definition in the
// same tap, so it sets defJustOpened and this listener skips that one
// event instead of hiding what was just opened.
let defJustOpened = false;
document.addEventListener('pointerdown', e => {
  const pop = $('defPopover');
  if (!pop || pop.classList.contains('hidden') || pop.contains(e.target)) return;
  if (defJustOpened) { defJustOpened = false; return; }
  hideDefinition();
});
async function showDefinition(r, c) {
  // Find row and column words through this cell, fetch definitions for each.
  // v163: read the words off the board being VIEWED — in a review that
  // is the board at the replay step, not game.board (the final board),
  // or a tap at an early step would define a word from a later move.
  const bd = (replayIndex !== null && game) ? replayStateAt(replayIndex).board : game.board;
  const words = [];
  const collect = (dr, dc) => {
    // Scan from the first letter of the word through to the last, in board
    // order. The old code unshifted the forward side and pushed the backward
    // side, which reversed every word (CAT read as TAC).
    let sr = r, sc = c;
    while (sr - dr >= 0 && sr - dr < 10 && sc - dc >= 0 && sc - dc < 10 && bd[sr - dr][sc - dc]) { sr -= dr; sc -= dc; }
    const cells = [];
    let rr = sr, cc = sc;
    while (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && bd[rr][cc]) { cells.push([rr, cc]); rr += dr; cc += dc; }
    if (cells.length >= 2) words.push(cells.map(([a, b]) => bd[a][b]).join(''));
  };
  collect(0, 1); collect(1, 0);
  if (!words.length) return;
  // Show the window immediately, with loading lines, then fill each
  // definition in as it arrives (in parallel, cached). The old code
  // waited for every definition fetch in sequence before showing
  // anything, so a bundled miss that had to go to a live API made the
  // whole popover feel delayed. No auto-hide any more: it stays until
  // the X or a tap elsewhere.
  const pop = $('defPopover');
  pop.innerHTML = `<button class="def-close" aria-label="Close definition">×</button><div class="def-body">${words.map(w => `<div data-def-word="${w}">${w} — Loading…</div>`).join('')}</div>`;
  pop.querySelector('.def-close').onclick = hideDefinition;
  pop.classList.remove('hidden');
  // The popover must never cover a board tile: anchor its top just
  // below the board instead of the fixed bottom offset, which put it
  // over the last row on a phone. It may cover the status line and
  // the top of the rack while it is open — the board stays fully
  // visible, and the next tap dismisses it.
  const boardEl = document.getElementById('board');
  if (boardEl && boardEl.getBoundingClientRect) {
    pop.style.bottom = 'auto';
    pop.style.top = (boardEl.getBoundingClientRect().bottom + 6) + 'px';
  }
  await Promise.all(words.map(async (w) => {
    try {
      let d = defCache.get(w);
      if (!d) {
        // Local bundle first (v115): instant and offline. A curated
        // entry is final (v118) — no background refresh from the
        // server; /api/define is only a fallback for words the bundle
        // does not hold.
        const local = await localDefinition(w);
        if (local) {
          d = { word: w, pos: local.pos || '', definition: local.def };
          defCache.set(w, d);
        } else {
          d = await api('/api/define?word=' + encodeURIComponent(w)); defCache.set(w, d);
        }
      }
      const el = pop.querySelector(`[data-def-word="${w}"]`);
      if (el) el.textContent = `${w} ${d.pos ? '(' + d.pos + ') ' : ''}— ${d.definition}`;
    } catch { const el = pop.querySelector(`[data-def-word="${w}"]`); if (el) el.textContent = `${w} — Could not load definition.`; }
  }));
}
// Drag / tap handling.
// Root cause of bugs 2 and 3: the old code only ever dragged *within* the
// rack (reorder) and never dropped onto the board at all; and every rack
// tap called renderGame() in pointerup, which destroyed the tapped element
// before its click event could fire, so click-to-place selection never stuck.
function cellAtPoint(x, y) {
  // A drop counts if the point is inside a cell — or just beside one.
  // The board has 3px gaps between cells, so a pointer in a gap (or a
  // finger a few px off a cell) used to cancel the drop outright. The
  // nearest cell within 12px (about a third of a cell) now counts.
  const cells = [...document.querySelectorAll('#board .cell')];
  let best = null, bestDist = 12;
  for (let i = 0; i < cells.length; i++) {
    const rect = cells[i].getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { row: Math.floor(i / 10), col: i % 10, el: cells[i] };
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const d = Math.hypot(dx, dy);
    if (d <= bestDist) { bestDist = d; best = { row: Math.floor(i / 10), col: i % 10, el: cells[i] }; }
  }
  return best;
}
function dropCellForPointer(x, y) {
  // The drop follows the finger, not the tile (Jeff, Nov 16, 2026):
  // the drag ghost floats above the finger (translate -90%), so its
  // centre sits about a cell above the cell under the finger — aiming
  // at the ghost dropped the tile a row higher than the player was
  // pointing. The finger decides the cell, and it also decides whether
  // this is a board drop at all — if it is not on (or just beside)
  // the board, there is no board drop, so a ghost hanging over the
  // board while the finger is on the rack cannot steal a rack drop.
  const boardEl = $('board'); if (!boardEl) return null;
  const b = boardEl.getBoundingClientRect();
  const TOL = 12;
  if (x < b.left - TOL || x > b.right + TOL || y < b.top - TOL || y > b.bottom + TOL) return null;
  return cellAtPoint(x, y);
}
function isCellFree(r, c) {
  if (!game || game.board[r][c]) return false;
  return !pending.some(p => p.row === r && p.col === c);
}
function nearestEmptyCell(r0, c0) {
  // Only an orthogonally adjacent empty cell counts as "nearby". The old
  // version searched the whole board, so dropping over an occupied cell
  // could land a tile next to a completely different word, and validation
  // then complained about a word the player never meant to play ("not a
  // word" for something that was not even adjacent to their intended play).
  // If no adjacent cell is free, the drop cancels instead of jumping away.
  const neighbours = [[r0 - 1, c0], [r0 + 1, c0], [r0, c0 - 1], [r0, c0 + 1]];
  for (const [r, c] of neighbours) {
    if (r >= 0 && r < 10 && c >= 0 && c < 10 && isCellFree(r, c)) return { row: r, col: c };
  }
  return null;
}
function clearDropHighlights() { document.querySelectorAll('#board .cell.drop-target').forEach(el => el.classList.remove('drop-target')); }
function showGhost(letter, x, y) {
  const ghost = $('dragGhost');
  ghost.innerHTML = tileSVG(letter);
  ghost.classList.remove('hidden');
  ghost.style.left = x + 'px'; ghost.style.top = y + 'px';
}
function clearRackShift() { document.querySelectorAll('#rack .tile').forEach(t => { t.style.transform = ''; t.style.zIndex = ''; }); }
function applyRackShift(dragIdx, hoverIdx) {
  // Phone-app slide, WITHOUT moving any DOM node: neighbours between the
  // dragged slot and the hovered slot translate by exactly one slot width,
  // with a CSS transition, so they visibly slide to fill the gap while the
  // ghost is the dragged tile. The old code moved the captured element in
  // the DOM mid-drag (rackEl.append), which on iOS can strand pointer
  // capture — ghost stuck on screen, every later tap delivered to the
  // captured tile, screen "frozen" and Play needing a tap elsewhere first.
  const rackEl = $('rack'); if (!rackEl) return;
  const slot = rackEl.getBoundingClientRect().width / 6;
  rackEl.querySelectorAll('.tile').forEach(t => {
    const ti = Number(t.dataset.idx);
    let shift = 0;
    if (ti !== dragIdx) {
      if (dragIdx < hoverIdx && ti > dragIdx && ti <= hoverIdx) shift = -slot;
      else if (dragIdx > hoverIdx && ti < dragIdx && ti >= hoverIdx) shift = slot;
    }
    t.style.transform = shift ? `translateX(${shift}px)` : '';
    t.style.zIndex = shift ? '2' : '';
  });
}
function enableRackDrag(el, idx) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, captureId = null;
  const cleanup = () => {
    if (!dragging && el.style.opacity === '' && $('dragGhost').classList.contains('hidden')) { /* idempotent */ }
    dragging = false; el.style.opacity = ''; $('dragGhost').classList.add('hidden'); clearDropHighlights(); clearRackShift();
    if (captureId !== null) { try { el.releasePointerCapture(captureId); } catch {} captureId = null; }
    clearDragCleanup(cleanup);
  };
  el.addEventListener('pointerdown', e => {
    cleanupStuckDrag();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null; captureId = e.pointerId;
    registerDragCleanup(cleanup);
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    // Pointer is no longer down but no pointerup arrived (capture lost,
    // gesture interrupted): clean up now instead of leaving a ghost.
    if (e.buttons === 0) { cleanup(); return; }
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
    if (!moved) return;
    suppressNextClick = true;
    // The tile being dragged leaves the rack: hide it entirely while
    // the ghost is up, so it looks like you are dragging that same
    // tile (not a copy of one still sitting in the deck). The slot
    // keeps its layout (opacity only), so the rack does not shift.
    // cleanup() restores the opacity on release/cancel.
    el.style.opacity = '0';
    showGhost(game.humanRack[idx], e.clientX, e.clientY);
    clearDropHighlights();
    const hit = dropCellForPointer(e.clientX, e.clientY);
    if (hit) {
      clearRackShift();
      // Snaps to the cell under the pointer if free; if dragged over a placed
      // tile, snaps to the nearest available space (never recalls that tile).
      const target = isCellFree(hit.row, hit.col) ? hit : nearestEmptyCell(hit.row, hit.col);
      if (target) { drop = { kind: 'board', row: target.row, col: target.col }; const cells = document.querySelectorAll('#board .cell'); cells[target.row * 10 + target.col].classList.add('drop-target'); }
      else drop = null;
      return;
    }
    const rackEl = $('rack'); const rect = rackEl.getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) {
      const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
      drop = { kind: 'rack', hoverIdx: Math.max(0, Math.min(5, Math.floor(rel * 6))) };
      applyRackShift(idx, drop.hoverIdx);
    } else { drop = null; clearRackShift(); }
  });
  el.addEventListener('pointerup', async e => {
    if (!dragging) return;
    const myDrop = drop, wasMoved = moved;
    cleanup();
    if (!wasMoved) {
      if (!canPlaceTiles()) return;
      // Tap (not a drag): click-to-place selection. No re-render here — the
      // old code re-rendered on pointerup and killed the following click.
      selectedRack = (selectedRack === idx ? null : idx);
      [...$('rack').querySelectorAll('.tile')].forEach(t => t.style.outline = (Number(t.dataset.idx) === selectedRack ? '2px solid #ffd166' : ''));
      return;
    }
    if (myDrop && myDrop.kind === 'board') {
      if (!canPlaceTiles()) return;
      selectedRack = idx;
      placeTile(myDrop.row, myDrop.col);
      return;
    }
    if (myDrop && myDrop.kind === 'rack' && myDrop.hoverIdx !== idx) {
      // Optimistic, synchronous reorder: the old code cleared the rack
      // shift in cleanup(), then awaited the server, then re-rendered —
      // so for that network round-trip the tiles sat back in their old
      // order (the split-second revert), then jumped to the new order.
      // Apply locally and render NOW, so the new order is what the user
      // sees on release, and sync to the server in the background.
      const rack = [...game.humanRack];
      const [tile] = rack.splice(idx, 1); rack.splice(myDrop.hoverIdx, 0, tile);
      // Keep any already-placed tiles pointing at the right rack slot:
      // their rackIndex must follow the same move, or the rack spacer
      // for a placed tile lands on the wrong slot after the reorder.
      pending.forEach(p => {
        if (p.rackIndex === idx) p.rackIndex = myDrop.hoverIdx;
        else if (idx < myDrop.hoverIdx && p.rackIndex > idx && p.rackIndex <= myDrop.hoverIdx) p.rackIndex--;
        else if (idx > myDrop.hoverIdx && p.rackIndex < idx && p.rackIndex >= myDrop.hoverIdx) p.rackIndex++;
      });
      game.humanRack = rack; renderGame();
      api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) })
        .then(d => { game = d; gameFetchAt = Date.now(); renderGame(); })
        .catch(() => {});
    }
    // Dropped elsewhere: cancel, keep the tile where it was. No render
    // needed — the shift was only a transform, clearing it restores order.
  });
  el.addEventListener('pointercancel', () => cleanup());
  el.addEventListener('lostpointercapture', () => cleanup());
}
// Drag a tile that is already placed on the board to a new cell.
// Tap (no movement) recalls it, exactly as before; a drag moves it.
function enablePlacedDrag(el, pend) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, captureId = null, rackSlotEl = null;
  const clearRackSlot = () => { if (rackSlotEl) { rackSlotEl.style.outline = ''; rackSlotEl = null; } };
  const cleanup = () => {
    dragging = false; $('dragGhost').classList.add('hidden'); clearDropHighlights(); clearRackSlot(); clearRackShift();
    if (captureId !== null) { try { el.releasePointerCapture(captureId); } catch {} captureId = null; }
    clearDragCleanup(cleanup);
  };
  el.addEventListener('pointerdown', e => {
    cleanupStuckDrag();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null; captureId = e.pointerId;
    registerDragCleanup(cleanup);
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (e.buttons === 0) { cleanup(); return; }
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
    if (!moved) return;
    suppressNextClick = true;
    showGhost(pend.letter, e.clientX, e.clientY);
    clearDropHighlights(); clearRackSlot(); clearRackShift();
    const hit = dropCellForPointer(e.clientX, e.clientY);
    if (!hit) {
      // Not over the board: check the rack (deck). The whole deck is
      // never highlighted. Two different cases:
      // - Empty slot: highlight only that slot. Dropping there puts
      //   the tile back in that slot with no other deck tile moving.
      // - Occupied deck tile: that tile (and the ones between it and
      //   the dragged tile's original slot) shifts sideways exactly
      //   like a rack drag, showing where the tile would insert.
      const rackEl = $('rack');
      if (rackEl) {
        const rect = rackEl.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) {
          const slot = Math.max(0, Math.min(5, Math.floor((e.clientX - rect.left) / Math.max(1, rect.width) * 6)));
          const slotEl = rackEl.children[slot];
          if (slotEl && slotEl.classList.contains('empty')) {
            drop = { kind: 'rack', slot, mode: 'open' }; rackSlotEl = slotEl; slotEl.style.outline = '2px solid #ffd166'; return;
          }
          if (slotEl) {
            drop = { kind: 'rack', slot, mode: 'insert' }; applyRackShift(pend.rackIndex, slot); return;
          }
        }
      }
      drop = null; return;
    }
    // The tile's own cell is pending, not a board letter, so it is not free;
    // nearestEmptyCell therefore snaps to a *different* free cell, never back
    // onto an occupied cell and never recalling the dragged tile.
    const target = isCellFree(hit.row, hit.col) ? hit : nearestEmptyCell(hit.row, hit.col);
    if (target && !(target.row === pend.row && target.col === pend.col)) {
      drop = { row: target.row, col: target.col };
      document.querySelectorAll('#board .cell')[target.row * 10 + target.col].classList.add('drop-target');
    } else drop = null;
  });
  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    const myDrop = drop, wasMoved = moved;
    cleanup();
    if (playInFlight) return;
    if (!wasMoved) { recallTile(pend); return; }
    if (myDrop && myDrop.kind === 'rack') {
      if (!game || game.status !== 'active' || game.clocks.turn !== 'human') return;
      const orig = pend.rackIndex, target = myDrop.slot;
      if (target === orig) { recallTile(pend); return; }
      if (myDrop.mode === 'open') {
        // Open slot: swap with the placed tile that owns that slot.
        // The deck tiles themselves do not move at all — only the two
        // spacers swap, so the returned tile lands in the open slot
        // and the other placed tile's spacer takes the old slot.
        const owner = pending.find(q => q !== pend && q.rackIndex === target);
        if (!owner) { recallTile(pend); return; }
        const rack = [...game.humanRack];
        [rack[orig], rack[target]] = [rack[target], rack[orig]];
        owner.rackIndex = orig;
        pending = pending.filter(q => q !== pend);
        game.humanRack = rack; renderGame();
        api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) })
          .then(d => { game = d; gameFetchAt = Date.now(); renderGame(); })
          .catch(() => {});
        return;
      }
      // Occupied deck tile: insert like a rack reorder — the letter
      // moves to the hovered slot and the deck tiles between shift
      // sideways by one, exactly as when dragging from the deck.
      const rack = [...game.humanRack];
      const [letter] = rack.splice(orig, 1); rack.splice(target, 0, letter);
      pending.forEach(q => {
        if (q === pend) return;
        if (orig < target && q.rackIndex > orig && q.rackIndex <= target) q.rackIndex--;
        else if (orig > target && q.rackIndex < orig && q.rackIndex >= target) q.rackIndex++;
      });
      pending = pending.filter(q => q !== pend);
      game.humanRack = rack; renderGame();
      api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) })
        .then(d => { game = d; gameFetchAt = Date.now(); renderGame(); })
        .catch(() => {});
      return;
    }
    if (myDrop) { if (!canPlaceTiles()) return; pend.row = myDrop.row; pend.col = myDrop.col; renderGame(); }
  });
  el.addEventListener('pointercancel', () => cleanup());
  el.addEventListener('lostpointercapture', () => cleanup());
}


// ---------- Startup: sign-in is required before entering the app ----------
(async () => {
  // Warm the offline dictionary at once (v112): it is a bundled file
  // under Capacitor and needs no network, so it loads during the
  // intro instead of on the first bot tap. Fire and forget.
  try { ensureLocalWords(); } catch {}
  // v192: attach the push + URL listeners FIRST, before the
  // /api/me wait — a challenge push tap that launches the app is
  // delivered to the action listener, and the listener used to
  // attach only at the end of boot (after the up-to-10s login
  // wait), so the tap was lost and the app merely opened. The
  // listeners are token-independent; a tap that lands before the
  // session is ready is stashed (see openChallengeFromPush).
  try { initPushNotifications(); initAppUrlOpenListener(); } catch {}
  // v190: an invite link lands on the SIGN-UP screen, not
  // sign-in — a tap on ?invite= is a new player joining, and
  // creating their account makes them the inviter's friend.
  if (!token) { if (deepLinkParam('invite')) setAuthMode('signup'); else setAuthMode('signin'); show('authScreen'); return; }
  // A login check that never answers must not leave the page black: if
  // /api/me takes over 10s, show Home anyway (the transient-error path).
  // The dummy catch keeps a late rejection from surfacing as unhandled.
  const meReq = api('/api/me');
  meReq.catch(() => {});
  try {
    const d = await Promise.race([meReq, new Promise(res => setTimeout(() => res(null), 10000))]);
    if (d) { me = d.user; persistMe(); }
  }
  catch (err) {
    // Only a rejected session bounces to auth; a transient network
    // failure still shows Home and lets the next call surface the error.
    if (err && err.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; setAuthMode('signin'); show('authScreen'); return; }
  }
  // Offline (v106): no network, no problem — the persisted user stands
  // in until the next successful /api/me overwrites it.
  if (!me) { const stored = loadPersistedMe(); if (stored) me = stored; }
  // Warm the user's photo at once (v118 fix, Nov 17, 2026): the pic is
  // a data URL already in hand (me.photoData from /api/me), so decode
  // it now — during the intro — instead of waiting for the preload's
  // idle callback and a second /api/me fetch. If the preload loses the
  // race to a Profile tap, the pic is still decoded and paints
  // instantly. Fire and forget: a slow decode must never stall boot.
  try {
    if (me && me.photoData) {
      const im = new Image();
      im.src = me.photoData;
      if (typeof im.decode === 'function') im.decode().catch(() => {});
    }
  } catch {}
  // Refresh the pending offline totals and, if a game was left in
  // progress, resume it into the game screen instead of Home.
  try { await refreshOfflineTotals(); } catch {}
  let resumed = false;
  try { resumed = await maybeResumeOfflineGame(); } catch {}
  if (!resumed) { show('homeScreen'); try { maybeOpenPuzzleDeepLink(); maybeOpenFriendDeepLink(); maybeOpenChallengeDeepLink(); maybeOpenInviteDeepLink(); maybeOpenPushChallenge(); } catch {} }
  // Push notifications (v120): register the listeners and, when the
  // preference is on and iOS permission is already granted,
  // (re-)register the device token. Fire and forget — a push setup
  // failure must never stall boot. (v192: the listeners already
  // attached at the top of boot; this call is a guarded no-op.)
  try { initPushNotifications(); initAppUrlOpenListener(); } catch {}
})();

// ---------- Profile tab + real accounts ----------
// Identity, Elo, Elo history, and stats come from GET /api/me. Guests see
// their guest profile plus a sign-in button; signing up upgrades the guest
// row in place, so Elo and game history carry over.
let profileData = null, statsScope = 'aggregate', chartRange = '1m';
// Numbers render Arial/Helvetica while words stay Comfortaa: wrap digit
// runs in .num spans (the .num rule already covers profile numbers).
function numify(s) { return String(s).replace(/\d+/g, d => `<span class="num">${d}</span>`); }
// Blank the profile screen to a silhouette with no name, Elo or
// stats. Called before the screen is shown (tab tap) as well as
// at the start of renderProfileUI: the old account's name and
// photo used to paint briefly after switching accounts, because
// show() ran before the blanking did.
function blankProfileUI() {
  $('profilePfp').innerHTML = silhouetteSVG(44); $('profilePfp').classList.add('no-photo');
  $('profileName').textContent = ''; $('profileUsername').textContent = '';
  $('profileElo').textContent = ''; $('profileEloHigh').textContent = ''; $('profileGlobalRank').textContent = '';
  $('statsList').innerHTML = '';
  const chartCv = $('eloChart'); if (chartCv) chartCv.getContext('2d').clearRect(0, 0, chartCv.width, chartCv.height);
}
async function renderProfileUI(prefetched) {
  // Sign-in is required: no token, or a rejected session, goes to auth.
  if (!token) { setAuthMode('signin'); show('authScreen'); return; }
  blankProfileUI();
  // Paint the photo at once from me (v118 fix, Nov 17, 2026): me
  // already carries photoData from the boot /api/me, and the image is
  // decoded during the intro, so the pic is there the moment the tab
  // opens instead of waiting for the fetch below. The fetch still
  // fills the name/Elo/stats and refreshes the photo if it changed
  // since boot. This is what makes the preload a guarantee rather
  // than a race: even if the user taps Profile before the background
  // preload finishes, the pic is already painted.
  try {
    if (me && me.photoData) {
      $('profilePfp').innerHTML = `<img src="${me.photoData}" alt="">`;
      $('profilePfp').classList.remove('no-photo');
    }
  } catch {}
  // The background preload (preloadHomeTabs) passes the /api/me
  // payload it already fetched for the session check, so the profile
  // is not fetched twice at boot.
  let d = prefetched || null;
  let fromCache = false;
  try { if (!d) d = await api('/api/me'); }
  catch (err) {
    if (err && err.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; profileData = null; setAuthMode('signin'); show('authScreen'); }
    // Offline (v107): fall back to the last-known profile instead of
    // leaving the tab blank. Nothing cached and never loaded online
    // means there is still nothing to show.
    else { d = loadCachedProfileData(); if (!d) return; fromCache = true; }
    if (!d) return;
  }
  // v176: remember the photo this session already has before the
  // assignment below overwrites me — the cache fallback needs it.
  const prevPhoto = me && me.photoData;
  profileData = d; me = d.user; persistMe();
  // v176: a cached profile adopted offline can predate the current
  // photo (the cache is only rewritten on a fresh fetch). A fresh
  // fetch's null is authoritative — the photo really is gone — but
  // a cached null is just "unknown": keep the photo this session
  // already has, so the profile tab and the Settings row don't lose
  // a photo they already showed.
  if (fromCache && prevPhoto && me && !me.photoData) { me.photoData = prevPhoto; if (profileData && profileData.user) profileData.user.photoData = prevPhoto; }
  if (!fromCache) cacheProfileData(d);
  // (v114: the "Last known profile" marker is gone — a cached
  // profile just shows, with no note. The hidden note element
  // stays in the DOM.)
  const u = profileData.user;
  $('profilePfp').innerHTML = usablePhoto(u) ? `<img src="${u.photoData}" alt="">` : silhouetteSVG(44); $('profilePfp').classList.toggle('no-photo', !usablePhoto(u));
  $('profileName').textContent = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
  $('profileUsername').textContent = '@' + u.username;
  $('profileElo').textContent = localElo(); // instant offline: includes unsynced deltas (v111), not just the last synced Elo
  $('profileEloHigh').textContent = u.eloHigh;
  // Global Rank sits above the chart with Elo and All-time high.
  // Show the cached rank at once when it is there (v75 cache), else
  // fetch it once and cache it, like the profile modal does. On a
  // last-known (offline) profile the rank is never fetched live:
  // a stale screen must not show the latest rank (v110).
  const cachedRank = rankCache.get(u.username);
  if (fromCache) {
    // Offline (v114): the persisted rank is the last-known one —
    // show it instead of '—'. Never fetched live (v110).
    const knownRank = cachedRank != null ? cachedRank : persistedRankCache.get(u.username);
    $('profileGlobalRank').textContent = knownRank != null ? knownRank : '—';
  } else if (cachedRank != null) $('profileGlobalRank').textContent = cachedRank;
  else {
    // Show the last-known rank while the fresh one loads (v114),
    // instead of '—', then replace it when the fetch lands.
    const knownRank = persistedRankCache.get(u.username);
    $('profileGlobalRank').textContent = knownRank != null ? knownRank : '—';
    api('/api/users/rank?username=' + encodeURIComponent(u.username)).then(d => { setRank(u.username, d.rank); if (profileData && profileData.user && profileData.user.username === u.username) $('profileGlobalRank').textContent = d.rank; }).catch(() => {});
  }
  renderStatsList(); drawEloChart();
  // v176: the Settings screen's Photo row was painted from whatever
  // profile data was in hand when it opened. If Settings is open
  // now, repaint it with the data that just landed — a photo that
  // arrived after the screen rendered still shows, instead of the
  // row keeping the stale (or empty) thumbnail for the session.
  try { const es = $('profileEditScreen'); if (es && !es.classList.contains('hidden')) renderEditList(); } catch {}
}
// v149: re-warm the (hidden) profile screen in the background after
// a profile edit. The save handlers null profileData so the next
// Profile tap refetches fresh data — but without a re-warm the tap
// blanked the screen and waited on /api/me, which is the same "not
// preloading" the post-game path had. Fire and forget: the screen
// is hidden while the user is on an edit screen, so the blank-and-
// fill is invisible, and the next Profile tap is instant again.
function rewarmProfile() {
  try { renderProfileUI().catch(() => {}); } catch {}
}
function fmt1(v) { return (Number(v) || 0).toFixed(1); }
function renderStatsList() {
  if (!profileData || !profileData.profileStats) return;
  const st = profileData.profileStats[statsScope] || profileData.profileStats.aggregate;
  // Once you have played a 10-letter word (the longest a word can
  // be on a 10-wide board), the longest-word stat becomes a count
  // of your 10-letter words. Tapping the row lists them; it looks
  // like every other stat line, not a link.
  const tenCount = st.tenLetterWordCount || 0;
  const longestLine = tenCount > 0
    ? ['10 letter words', tenCount]
    : ['Longest word', st.longestWord ? `${st.longestWord} (${st.longestWordLen} letters)` : '—'];
  const lines = [
    ['Average game score', st.avgGameScore], ['Highest game score', st.highestGameScore],
    ['Average word score', fmt1(st.avgWordScore)], ['Highest word score', st.highestWord ? `${st.highestWord} (${st.highestWordScore} pts)` : '—'],
    ['50+ point words', st.wordsOver50], ['100+ point words', st.wordsOver100],
    ['Lifetime bingos', st.bingos],
    longestLine,
    ['Games played', st.gamesPlayed], ['Lifetime record', st.record || '0W-0L'],
    ['Optimal move %', fmt1(st.optimalPct) + '%'], ['Unique words played', st.uniqueWords],
  ];
  // Offline games waiting to sync (v106): shown while the outbox is
  // non-empty, cleared when it drains.
  if (pendingGamesCount > 0) lines.push(['Games waiting to sync', pendingGamesCount]);
  $('statsList').innerHTML = lines.map(([k, v]) => `<div class="stat-line"${k === '10 letter words' ? ' data-ten-letter="1"' : ''}${k === 'Highest word score' ? ' data-highest-word="1"' : ''}${k === 'Longest word' ? ' data-longest-word="1"' : ''}><span>${k}</span><b>${numify(v)}</b></div>`).join('');
  const tenRow = $('statsList').querySelector('[data-ten-letter]');
  if (tenRow) tenRow.onclick = () => openTenLetterModal(st.tenLetterWords || []);
  // Click a record word to open its board (v128, item 6): the stats
  // know which game and move each record word came from, so the row
  // opens the board at that move with the same arrows as a Game
  // History review. A word with a stored game but no move (v169)
  // still opens its game, at the start. A word with no stored game
  // at all (pre-v128 games) stays plain text — never a dead tap.
  const hiRow = $('statsList').querySelector('[data-highest-word]');
  if (hiRow && st.highestWordGameId) {
    hiRow.classList.add('stat-line-clickable');
    hiRow.onclick = () => openStatWordBoard(st.highestWordGameId, st.highestWordMoveIndex, st.highestWord);
  }
  const loRow = $('statsList').querySelector('[data-longest-word]');
  if (loRow && st.longestWordGameId) {
    loRow.classList.add('stat-line-clickable');
    loRow.onclick = () => openStatWordBoard(st.longestWordGameId, st.longestWordMoveIndex, st.longestWord);
  }
  // v175: warm the cache for both record games now, while the user
  // is still reading the stats — the tap then opens the review with
  // no network wait (see openStatWordBoard).
  prefetchStatWordGame(st.highestWordGameId);
  prefetchStatWordGame(st.longestWordGameId);
}
// The 10-letter words list: a plain modal reusing the person-modal
// shell. The row that opens it looks like any other stat line.
function openTenLetterModal(words) {
  // Each word is clickable when it carries its game/move (v128,
  // item 6): tapping it opens that game's board at that move, the
  // same as the Highest/Longest rows. Entries may be plain strings
  // (old shape) or {word, gameId, moveIndex} objects; a word with
  // no stored game/move stays plain text, never a dead tap.
  $('tenLetterList').innerHTML = words.length
    ? words.map((w) => {
      const word = typeof w === 'string' ? w : (w && w.word) || '';
      const gid = w && w.gameId; const midx = w && w.moveIndex;
      if (gid && midx) return `<div class="ten-letter-word ten-letter-word-clickable" data-game="${gid}" data-move="${midx}">${word}</div>`;
      return `<div class="ten-letter-word">${word}</div>`;
    }).join('')
    : '<div class="ten-letter-word">No 10-letter words yet.</div>';
  $('tenLetterList').querySelectorAll('.ten-letter-word-clickable').forEach((el) => {
    el.onclick = () => { closeTenLetterModal(); openStatWordBoard(Number(el.dataset.game), Number(el.dataset.move), el.textContent); };
  });
  // v175: warm the cache for these games too (first 10), same as the
  // record rows — a tap on a word opens its review with no wait.
  words.slice(0, 10).forEach((w) => { if (w && w.gameId) prefetchStatWordGame(w.gameId); });
  $('tenLetterModal').classList.remove('hidden');
}
// Open the board for a record word (v128, item 6): fetch the game
// the word came from and drop into the same review window Game
// History uses, starting AT that move (moveIndex is 1-based, so
// replayIndex is set to it directly). The review row (Exit, ←, →,
// Game Stats) and the clock rewind behave exactly as if the game
// had been opened from the history list. v169: a game with no
// stored move opens at the start (replayIndex 0) instead of
// refusing the tap. A missing game falls back to the Game History
// list instead of crashing.
// v175: the record-word tap prefetches its game so the review
// opens instantly. The tap used to await GET /api/games/:id before
// anything appeared — on a slow connection that read as a dead tap
// (Jeff: "slight delay after hitting a best word"). The stats render
// already knows both record game ids, so the fetch happens in the
// background then; a warm tap opens the review from the cache with
// no network wait at all, and a cold tap falls back to the old
// fetch. The cache holds promises (a tap while the prefetch is
// still in flight just awaits the same request). A failed prefetch
// resolves to null so the tap retries live instead of opening
// nothing. Entries are capped (oldest evicted past 30) so the
// ten-letter list cannot grow the cache without bound. The cached
// game is deep-copied on open so the review can never mutate the
// cache entry. Offline taps still work when the game is cached;
// an uncached tap offline keeps the old "needs a connection" note.
const statWordGameCache = {};
function prefetchStatWordGame(gameId) {
  if (!gameId || statWordGameCache[gameId] || isOffline()) return;
  const ids = Object.keys(statWordGameCache);
  if (ids.length >= 30) delete statWordGameCache[ids[0]];
  statWordGameCache[gameId] = api(`/api/games/${gameId}`).catch(() => null);
}
async function openStatWordBoard(gameId, moveIndex, word) {
  if (!gameId) return;
  let g = null;
  const prefetched = statWordGameCache[gameId];
  if (prefetched) g = await prefetched.catch(() => null);
  if (!g) {
    if (isOffline()) { $('status').textContent = 'Game History needs a connection.'; return; }
    try {
      g = await api(`/api/games/${gameId}`);
    } catch (e) {
      openPastGames();
      return;
    }
  }
  if (!g) { openPastGames(); return; }
  game = JSON.parse(JSON.stringify(g)); gameFetchAt = Date.now(); pending = []; selectedRack = null;
  reviewMode = true;
  replayIndex = (g.moveLog && g.moveLog.length) ? (moveIndex ? Math.min(moveIndex, g.moveLog.length) : 0) : null;
  statShownGameId = g.id;
  reviewOrigin = 'profile'; // v182: a record word from the Profile tab — Exit goes back there.
  enterReviewScreen();
}
function closeTenLetterModal() { $('tenLetterModal').classList.add('hidden'); }
$('tenLetterCloseBtn').onclick = closeTenLetterModal;
$('tenLetterModal').addEventListener('click', e => { if (e.target === $('tenLetterModal')) closeTenLetterModal(); });
// v195: the last visible CSS size of the chart canvas — the
// belt-and-braces guard so a hidden draw can never feed the
// backing-store (device px) width back in as CSS px.
let lastChartW = 0, lastChartH = 0;
function drawEloChart() {
  const cv = $('eloChart'); if (!cv || !profileData) return;
  const ctx = cv.getContext('2d');
  // v182: the canvas was drawn at its 340x110 backing store and
  // stretched to the full profile width (~390 CSS px, ~1170 device
  // px on a 3x iPhone) — that upscale is the blur. Size the backing
  // store to the CSS size x devicePixelRatio (capped at 3) and draw
  // in CSS pixels, so the line is sharp on retina.
  const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const rect = (cv.getBoundingClientRect && cv.getBoundingClientRect()) || { width: 0, height: 0 };
  // v195: a hidden draw (display:none -> 0x0 rect) must never run —
  // the old `rect.width || cv.width` fallback read the backing-store
  // width (device px) as CSS px and multiplied it by dpr on every
  // hidden re-draw, thinning the 2px line by 3x a draw on iPhone.
  if (!rect.width || !rect.height) return;
  const w = Math.max(1, Math.round(rect.width || lastChartW));
  const h = Math.max(1, Math.round(rect.height || lastChartH));
  lastChartW = w; lastChartH = h;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  let hist = (profileData.stats && profileData.stats.eloHistory) || [];
  const now = Date.now();
  if (chartRange === '1m') hist = hist.filter(h => now - new Date(h.created_at).getTime() < 30 * 24 * 3600 * 1000);
  if (chartRange === '1y') hist = hist.filter(h => now - new Date(h.created_at).getTime() < 365 * 24 * 3600 * 1000);
  const pts = [1000, ...hist.map(h => h.elo_after)];
  // A brand-new account has no history yet: draw a flat line at the
  // starting 1000 instead of a "no history" message.
  if (pts.length < 2) pts.push(1000);
  const min = Math.min(...pts) - 20, max = Math.max(...pts) + 20;
  ctx.strokeStyle = '#03eaff'; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((v, i) => { const x = 10 + i * (w - 20) / (pts.length - 1); const y = h - 10 - ((v - min) / (max - min)) * (h - 20); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
}
// v195: draw synchronously from the cached profile, so the chart is
// there the moment the tab opens — no blank frame, no fetch wait.
// (When profileData is null the fetch-then-render path runs instead.)
$('tabProfile').onclick = () => { show('profileScreen'); if (!profileData) renderProfileUI(); else drawEloChart(); };
// Tapping your own pfp on the home screen opens the profile tab
// (v133): exactly what the profile tab does.
$('homePfp').onclick = () => { show('profileScreen'); if (!profileData) renderProfileUI(); else drawEloChart(); };
$('homePfp').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('homePfp').onclick(); } });
// Game History (v123, item 6; renamed v124): the finished games list, from the
// server (GET /api/games). Each row shows the opponent's pic and
// username, the score, and the date; tapping one opens its final board in
// review mode (Exit, replay arrows, Game Stats).
// Whether the "Could not open that game." note is already showing in
// the list (v124) — the list is rebuilt on every open, so this resets
// there; it keeps a repeated failed tap from stacking duplicate notes.
let openFailNoteShown = false;
// Game History filter + paging (v128, items 4+5): the same three
// filter tabs as the stats screen (Aggregate, Vs Humans, Vs Bots)
// sit at the top of the list, and the list pages 25 games at a
// time with a Load more button. historyState holds, per scope, the
// games loaded so far and whether more remain server-side; a scope
// with games: null has not been fetched yet. Vs Humans is personas
// + real players (they count as human stats, same as the stats
// screen); Vs Bots is Fishstick + Doppelgänger only.
let historyScope = 'aggregate';
let historyState = {
  aggregate: { games: null, hasMore: true },
  vsHumans: { games: null, hasMore: true },
  vsBots: { games: null, hasMore: true },
};
// Scopes with a first page already in flight (v133): warming never
// fires a second fetch for a scope that is cached or in flight.
const historyWarmInFlight = new Set();
function historyScopeState() { return historyState[historyScope] || historyState.aggregate; }
async function fetchHistoryPage(scope, offset) {
  const r = await api('/api/games?limit=25&offset=' + offset + '&scope=' + scope);
  return { games: (r && r.games) || [], hasMore: !!(r && r.hasMore) };
}
// Warm one scope's first page in the background (v133): a scope
// with games already cached, or already being fetched, is skipped.
function warmHistoryScope(scope) {
  if (!historyState[scope] || historyState[scope].games || historyWarmInFlight.has(scope)) return;
  if (isOffline()) return;
  historyWarmInFlight.add(scope);
  fetchHistoryPage(scope, 0).then(({ games, hasMore }) => {
    historyState[scope] = { games, hasMore };
  }).catch(() => {}).finally(() => { historyWarmInFlight.delete(scope); });
}
// Warm all three filters' first pages (v133): Vs Humans and Vs Bots
// are already in hand when their tab is tapped, so the list renders
// from cache with no network wait. Load more still pages from the
// cached state (hasMore/offset) as before.
function warmHistoryScopes() { ['aggregate', 'vsHumans', 'vsBots'].forEach(warmHistoryScope); }
// The Load more button lives below the list, above Back.
// It shows only while the active filter still has games on the
// server; once the last page lands it hides itself.
function renderHistoryMore() {
  const btn = $('pastGamesMoreBtn');
  if (!btn) return;
  const st = historyScopeState();
  btn.classList.toggle('hidden', !(st && st.hasMore && st.games && st.games.length > 0));
}
// One row per finished game (v125): the opponent's profile pic and
// username, the score, and the date. The W/L badge is gone. The
// username is always white (v128); the SCORE is Duello blue when
// you won, white when you lost. The bot emoji sits straight on the
// black (v128), same as the Fishstick pic — no grey circle.
function pastGameRowEl(g) {
  const row = document.createElement('button');
  row.className = 'past-game-row';
  const date = g.finishedAt ? new Date(g.finishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const picEl = document.createElement('span');
  picEl.className = 'past-game-pic';
  if (g.opponentKind === 'fishstick') { picEl.classList.add('past-game-pic-plain'); picEl.innerHTML = '<img src="/assets/fishstick.png?v=1" alt="Fishstick">'; }
  else if (g.opponentKind === 'competitive') { picEl.classList.add('past-game-pic-plain'); picEl.textContent = '🤖'; }
  else if (g.opponentPhoto) picEl.innerHTML = `<img src="${g.opponentPhoto}" alt="">`;
  else picEl.innerHTML = silhouetteSVG(28);
  const oppEl = document.createElement('span');
  oppEl.className = 'past-game-opp';
  oppEl.textContent = g.opponentUsername || g.opponentName || 'Opponent';
  const scoreEl = document.createElement('span'); scoreEl.className = 'past-game-score num ' + (g.result === 'win' ? 'past-game-score-win' : 'past-game-score-loss'); scoreEl.textContent = `${g.myScore}–${g.oppScore}`;
  const dateEl = document.createElement('span'); dateEl.className = 'past-game-date'; dateEl.textContent = date;
  row.append(picEl, oppEl, scoreEl, dateEl);
  row.onclick = () => openPastGameDetail(g.id);
  return row;
}
function renderPastGamesList(games) {
  const list = $('pastGamesList');
  list.innerHTML = '';
  if (!games.length) {
    const note = document.createElement('div');
    note.className = 'past-games-note';
    note.textContent = 'No finished games yet.';
    list.appendChild(note);
    renderHistoryMore();
    return;
  }
  games.forEach((g) => list.appendChild(pastGameRowEl(g)));
  // v182: warm the full payloads for the first 10 rows (the same
  // prefetch as the v175 record words) — a tap on one opens its
  // review from the cache instead of awaiting a fetch.
  games.slice(0, 10).forEach((g) => { if (g && g.id) prefetchStatWordGame(g.id); });
  renderHistoryMore();
}
// Switch the history filter (v128, item 4): the active tab is
// highlighted like the stats tabs, and the list shows that scope's
// cached games at once — or fetches its first page if it has not
// been loaded yet. Paging is per-scope: each filter keeps its own
// loaded games and hasMore.
function setHistoryScope(scope) {
  if (!historyState[scope]) scope = 'aggregate';
  historyScope = scope;
  document.querySelectorAll('.history-tab').forEach(x => x.classList.toggle('active', x.dataset.scope === scope));
  const st = historyState[scope];
  if (st.games) {
    renderPastGamesList(st.games);
    // v167: the cached list renders at once, but it is only as fresh
    // as the last warm/fetch for this scope — a game finished since
    // then (e.g. a Doppelgänger game finished after the boot warm)
    // would never show on this tab otherwise. Refresh quietly in
    // the background; refreshPastGamesCache re-renders only if the
    // first page changed, so a no-change tap leaves the list — and
    // its scroll — untouched.
    refreshPastGamesCache(scope);
    return;
  }
  const list = $('pastGamesList');
  list.innerHTML = '<div class="past-games-note">Loading…</div>';
  renderHistoryMore();
  if (isOffline()) { list.innerHTML = '<div class="past-games-note">Game History needs a connection.</div>'; return; }
  fetchHistoryPage(scope, 0).then(({ games, hasMore }) => {
    historyState[scope] = { games, hasMore };
    if (historyScope === scope) renderPastGamesList(games);
  }).catch(() => {
    if (historyScope === scope) list.innerHTML = '<div class="past-games-note">Could not load game history.</div>';
  });
}
// Load more (v128, item 5): append the next 25 games for the active
// filter. The button disables while the fetch is in flight and
// stays up on a failure so the user can retry.
async function loadMoreHistory() {
  const st = historyScopeState();
  if (!st || !st.hasMore || !st.games) return;
  if (isOffline()) return;
  const scope = historyScope;
  const btn = $('pastGamesMoreBtn');
  if (btn) btn.disabled = true;
  try {
    const { games, hasMore } = await fetchHistoryPage(scope, st.games.length);
    if (historyScope !== scope) return;
    st.games = st.games.concat(games);
    st.hasMore = hasMore;
    renderPastGamesList(st.games);
  } catch (e) {
    // Keep the button so the user can retry.
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function openPastGames() {
  show('pastGamesScreen');
  openFailNoteShown = false;
  // Warm the other filters too (v133): Vs Humans / Vs Bots are
  // already cached by the time their tab is tapped.
  try { warmHistoryScopes(); } catch {}
  // The username under the heading (v124): whose history this is.
  const un = (me && me.username) || (profileData && profileData.user && profileData.user.username) || '';
  $('pastGamesUser').textContent = un ? '@' + un : '';
  document.querySelectorAll('.history-tab').forEach(x => x.classList.toggle('active', x.dataset.scope === historyScope));
  const list = $('pastGamesList');
  const st = historyScopeState();
  // Already warmed in the background (v126): show at once, then
  // refresh quietly so a game finished since the warm still appears.
  if (st.games) {
    renderPastGamesList(st.games);
    refreshPastGamesCache();
    return;
  }
  list.innerHTML = '<div class="past-games-note">Loading…</div>';
  renderHistoryMore();
  if (isOffline()) { list.innerHTML = '<div class="past-games-note">Game History needs a connection.</div>'; return; }
  try {
    const { games, hasMore } = await fetchHistoryPage(historyScope, 0);
    historyState[historyScope] = { games, hasMore };
    renderPastGamesList(games);
  } catch (e) {
    list.innerHTML = '<div class="past-games-note">Could not load game history.</div>';
  }
}
// Quiet refresh (v126): re-fetch the first page in the background
// and re-render only if it changed (a game finished since the
// list loaded). Never shows a Loading note; a no-change refresh
// leaves the screen — and its scroll — untouched. A changed first
// page resets the scope to that fresh page; the user can Load more
// again from there.
// v167: takes an optional scope (default: the active tab). A tab tap
// on a cached scope calls this too (see setHistoryScope): the boot
// warm freezes every scope at boot time, so without a refresh here
// a game finished after the warm never appeared on its tab —
// recent Doppelgänger games were missing from Vs Bots all session.
function refreshPastGamesCache(wantScope) {
  if (isOffline()) return;
  const scope = wantScope || historyScope;
  fetchHistoryPage(scope, 0).then(({ games, hasMore }) => {
    if (historyScope !== scope) return;
    const st = historyState[scope];
    const oldIds = (st && st.games ? st.games.slice(0, games.length) : []).map(g => g.id).join(',');
    const newIds = games.map(g => g.id).join(',');
    if (oldIds === newIds) return;
    historyState[scope] = { games, hasMore };
    renderPastGamesList(games);
  }).catch(() => {});
}
// Back from a review (v125): the list is already in hand, so show it
// at once — no fetch, no Loading note. Falls back to a fresh fetch
// when there is no cached list (a direct review entry).
function showPastGamesCached() {
  show('pastGamesScreen');
  openFailNoteShown = false;
  const un = (me && me.username) || (profileData && profileData.user && profileData.user.username) || '';
  $('pastGamesUser').textContent = un ? '@' + un : '';
  document.querySelectorAll('.history-tab').forEach(x => x.classList.toggle('active', x.dataset.scope === historyScope));
  const st = historyScopeState();
  if (st.games) renderPastGamesList(st.games);
  else openPastGames();
}
async function openPastGameDetail(gameId) {
  // v182: the tap used to await GET /api/games/:id before anything
  // appeared — on a slow connection that read as a dead tap (the
  // same delay the v175 record-word prefetch fixed). The list
  // prefetches the first 10 games when it renders, so a tap on one
  // opens from the cache with no network wait; a cold tap falls back
  // to the live fetch, and an offline tap still works when cached.
  let g = null;
  const prefetched = statWordGameCache[gameId];
  if (prefetched) g = await prefetched.catch(() => null);
  if (!g) {
    if (isOffline()) { $('status').textContent = 'Game History needs a connection.'; return; }
    try {
      g = await api(`/api/games/${gameId}`);
    } catch (e) {
      // Never fail silently (v124): a tap that does nothing is the
      // bug Jeff reported — say so in the list instead of staying quiet.
      const list = $('pastGamesList');
      if (list && !openFailNoteShown) {
        const note = document.createElement('div');
        note.classList.add('past-games-note', 'open-fail');
        note.textContent = 'Could not open that game.';
        list.prepend(note);
        openFailNoteShown = true;
      }
      return;
    }
  }
  if (!g) return;
  // Review mode: the finished game, its final board, and the
  // replay arrows. The auto stat window is suppressed (the user
  // opens it from the review row's Game Stats button instead).
  game = g; gameFetchAt = Date.now(); pending = []; selectedRack = null;
  reviewMode = true;
  // Start at the final board (v124): the arrows, the point bubble
  // and the status are set up at once instead of waiting for a
  // tap. A game with no moveLog has no replay — leave the index
  // null so the board shows the final state as-is.
  replayIndex = (g.moveLog && g.moveLog.length) ? g.moveLog.length : null;
  statShownGameId = g.id;
  reviewOrigin = 'gamelog'; // v182: entered from the Game History list — Exit goes back there.
  enterReviewScreen();
}
// Review entry (v123, item 6): a finished game from Game History.
// Unlike enterGameScreen (a new game), there is no countdown, no
// clock reset, and no live stream — the game is over, so the board
// just shows its final state with the review buttons.
function enterReviewScreen() {
  gameAppliedSeq = gameFetchSeq;
  clearStatDelay();
  countdownActive = false;
  $('statWindow').classList.add('hidden');
  $('gameDim').classList.remove('dimmed');
  $('countdownOverlay').classList.add('hidden');
  $('gameScreen').classList.remove('counting');
  show('gameScreen');
  renderGame();
}
$('pastGamesBtn').onclick = openPastGames;
$('pastGamesBackBtn').onclick = () => show('profileScreen');
document.querySelectorAll('.history-tab').forEach(x => { x.onclick = () => setHistoryScope(x.dataset.scope); });
$('pastGamesMoreBtn').onclick = loadMoreHistory;
document.querySelectorAll('.stats-tab').forEach(b => b.onclick = () => { statsScope = b.dataset.scope; document.querySelectorAll('.stats-tab').forEach(x => x.classList.toggle('active', x === b)); renderStatsList(); });
document.querySelectorAll('.chart-toggle').forEach(b => b.onclick = () => { chartRange = b.dataset.range; document.querySelectorAll('.chart-toggle').forEach(x => x.classList.toggle('active', x === b)); drawEloChart(); });
$('gearBtn').onclick = async () => {
  if (!profileData) await renderProfileUI();
  if (!profileData) return;
  renderEditList();
  setPushNote('');
  refreshPushToggle();
  show('profileEditScreen');
};
// v147: the settings list shows the account's current values. The
// email address is deliberately NOT shown here (Jeff: it appears
// only when you tap the Email row).
function renderEditList() {
  const u = (profileData && profileData.user) || me;
  if (!u) return;
  $('editRowFirstName').textContent = u.firstName || '';
  $('editRowLastName').textContent = u.lastName || '';
  $('editRowUsername').textContent = '@' + (u.username || '');
  $('editRowPro').textContent = u.pro ? 'Duello Pro' : 'Duello Free';
  // v176: the photo comes from whichever copy has one. profileData
  // can be a stale payload adopted offline while me (this session's
  // fresh /api/me, or a just-saved photo) has the current one — the
  // row must not show the silhouette while the photo is in hand.
  // Names, username and tier still come from u above.
  const photoSrc = (u && u.photoData) || (me && me.photoData) || null;
  $('editRowPfp').innerHTML = (photoSrc && !photoSrc.includes('picsum.photos')) ? `<img src="${photoSrc}" alt="">` : silhouetteSVG(32);
  // v180: repaint the Push row's status whenever Settings renders.
  refreshPushStatusRow();
}
$('editFirstNameRow').onclick = () => openFieldEditor('firstName');
$('editLastNameRow').onclick = () => openFieldEditor('lastName');
$('editUsernameRow').onclick = () => openFieldEditor('username');
$('editEmailRow').onclick = () => openFieldEditor('email');
$('editPasswordRow').onclick = () => openPasswordScreen();
$('editProRow').onclick = () => openProScreen();
$('editPhotoRow').onclick = () => openPhotoScreen();
// v183: tapping the Push row opens the drill-in with the status +
// instructions. The retry lives on the drill-in's Retry button:
// permission is re-checked fresh, a granted permission registers at
// once, a never-asked permission gets the one setup ask. A denied
// permission never re-prompts; the drill-in says to fix it in iOS
// Settings instead. The row + drill-in refresh after the retry.
$('pushSettingRow').onclick = () => { if (!IS_CAPACITOR) return; openPushScreen(); };
$('pushRetryBtn').onclick = async () => {
  if (!IS_CAPACITOR) return;
  const P = pushPlugin(); if (!P) { refreshPushStatusRow(); return; }
  let perm = null;
  try { perm = await P.checkPermissions(); }
  catch (e) { updatePushDiag({ permission: 'check-failed: ' + (e && e.message ? e.message : 'unknown error') }); return; }
  const recv = (perm && perm.receive) || 'unknown';
  updatePushDiag({ permission: recv });
  if (recv === 'granted') await registerPushToken();
  else if (recv === 'prompt') maybeRequestPushAtSetup();
  refreshPushStatusRow();
};
$('pushBackBtn').onclick = () => show('profileEditScreen');
// v151: the policy opens inside the app. window.open('/privacy.html',
// '_blank') is a no-op in the Capacitor WebView (no Browser plugin,
// WKWebView swallows _blank), so the row did nothing on Jeff's
// phone. The bundled /privacy.html stays the single source of truth:
// its <main> is fetched once and injected here.
async function openPrivacyScreen() {
  show('profilePrivacyScreen');
  const box = $('privacyContent');
  if (!box || box.dataset.loaded) return;
  try {
    const r = await fetch('/privacy.html');
    if (!r.ok) throw new Error('Privacy Policy could not be loaded.');
    const html = await r.text();
    const m = html.match(/<main>([\s\S]*?)<\/main>/);
    box.innerHTML = m ? m[1] : html;
    // v153: the policy's bottom link is a standard back button now
    // (it lives in the injected <main>, so it is wired here, after
    // the injection). It goes back to Settings, like the top one.
    const bb = box.querySelector('#privacyBottomBackBtn');
    if (bb) bb.onclick = () => show('profileEditScreen');
    box.dataset.loaded = '1';
  } catch { box.innerHTML = '<p>Could not load the Privacy Policy. Check your connection and try again.</p>'; }
}
$('privacyRow').onclick = () => openPrivacyScreen();
$('privacyBackBtn').onclick = () => show('profileEditScreen');
// v152: Cancel is gone from every settings screen — a standard back
// button (the grey .back-pill, same as the bot selector's) sits below
// each Save, and in the Cancel spot on the photo screen (which has
// no Save). All of them go back to Settings without saving.
$('fieldBackBtn').onclick = () => show('profileEditScreen');
$('editPhotoBackBtn').onclick = () => show('profileEditScreen');
$('editPasswordBackBtn').onclick = () => show('profileEditScreen');
$('proBackBtn').onclick = () => show('profileEditScreen');
// v147: one field at a time. Each editor saves that field alone via
// /api/me/update (the endpoint always sets first/last/username, so
// the untouched ones are sent back unchanged; email is only sent
// when the email itself is edited, otherwise it stays as it is).
let editFieldKind = null;
function openFieldEditor(kind) {
  editFieldKind = kind;
  const u = (profileData && profileData.user) || me; if (!u) return;
  const titles = { firstName: 'First Name', lastName: 'Last Name', username: 'Username', email: 'Email' };
  const input = $('fieldInput');
  // v152: the top says what you are changing ("Change First Name"),
  // like the photo screen's "Change Photo".
  $('fieldTitle').textContent = 'Change ' + (titles[kind] || kind);
  input.value = kind === 'firstName' ? (u.firstName || '') : kind === 'lastName' ? (u.lastName || '') : kind === 'username' ? (u.username || '') : (u.email || '');
  // v156: the email field is type="text" with inputmode="email",
  // not type="email". type="email" does not support the selection
  // API — setSelectionRange throws and selectionStart is null — so
  // the app could not put the cursor at the start. On iOS, focusing
  // the pre-filled email put the cursor at the end, and the keyboard
  // (appearing ~300ms later) scrolled the input to reveal it,
  // cutting off the start of the address. type="text" supports
  // selection, and inputmode="email" still shows the email keyboard.
  // The email is validated by the JS regex on save, not by the
  // browser's email type.
  input.type = 'text';
  input.inputMode = kind === 'email' ? 'email' : '';
  input.placeholder = titles[kind] || kind;
  input.autocapitalize = kind === 'username' ? 'off' : 'sentences';
  input.autocorrect = kind === 'username' ? 'off' : 'on';
  input.spellcheck = kind !== 'username';
  $('fieldError').textContent = '';
  show('profileFieldScreen');
  input.focus();
  // v156: the v154 fix only reset the scroll at open and +60ms —
  // both fire before the keyboard appears (~300ms), so iOS
  // re-scrolled after the fix. Now the cursor goes to the start
  // (so iOS reveals the start, not the end) and the scroll is
  // pinned at open, after the screen settles (+60ms), and after
  // the keyboard appears (+400ms).
  try { input.setSelectionRange(0, 0); } catch {}
  try { input.scrollLeft = 0; } catch {}
  setTimeout(() => { try { input.scrollLeft = 0; } catch {} }, 60);
  setTimeout(() => { try { input.setSelectionRange(0, 0); } catch {} try { input.scrollLeft = 0; } catch {} }, 400);
}
$('fieldInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('fieldSaveBtn').click(); } });
$('fieldInput').addEventListener('input', () => { if (editFieldKind === 'username') { const el = $('fieldInput'); if (el.value !== el.value.toLowerCase()) el.value = el.value.toLowerCase(); } });
// v156: if the field's content fits its width, never let it scroll —
// iOS can scroll a pre-filled input on focus/keyboard even when the
// text fits, cutting off the start of the address. When the content
// genuinely overflows (a very long address) this does nothing, so
// the user can still scroll to the end.
$('fieldInput').addEventListener('scroll', () => {
  const el = $('fieldInput');
  try { if (el.scrollWidth <= el.clientWidth && el.scrollLeft !== 0) el.scrollLeft = 0; } catch {}
});
$('fieldSaveBtn').onclick = async () => {
  const u = (profileData && profileData.user) || me; if (!u || !editFieldKind) return;
  const v = $('fieldInput').value.trim();
  const body = { firstName: u.firstName, lastName: u.lastName, username: u.username };
  if (editFieldKind === 'firstName') { if (!v) { $('fieldError').textContent = 'Add a first name.'; return; } body.firstName = v; }
  if (editFieldKind === 'lastName') body.lastName = v;
  if (editFieldKind === 'username') { const un = v.toLowerCase(); if (!/^[a-z0-9_]{3,}$/.test(un)) { $('fieldError').textContent = 'Usernames are 3+ lowercase letters, numbers, or underscores.'; return; } body.username = un; }
  if (editFieldKind === 'email') { if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { $('fieldError').textContent = 'Enter a valid email.'; return; } if (v) body.email = v.toLowerCase(); }
  try {
    const d = await api('/api/me/update', { method: 'POST', body: JSON.stringify(body) });
    me = d.user; persistMe(); profileData = null;
    renderEditList(); renderHomeHeader(); rewarmProfile();
    show('profileEditScreen');
  } catch (err) { $('fieldError').textContent = err.message || 'Could not save.'; }
};
// v147: the photo lives on its own screen — Choose opens the picker,
// and the cropped photo saves at once (no staged form submit any
// more); Remove clears it the same way.
function openPhotoScreen() {
  const u = (profileData && profileData.user) || me; if (!u) return;
  $('editPfp').innerHTML = usablePhoto(u) ? `<img src="${u.photoData}" alt="">` : silhouetteSVG(44); $('editPfp').classList.toggle('no-photo', !usablePhoto(u));
  $('editPhotoRemoveBtn').classList.toggle('hidden', !u.photoData);
  // v152: no photo yet → the button says "Add photo", not "Choose".
  $('editPhotoChooseBtn').textContent = u.photoData ? 'Choose photo' : 'Add photo';
  $('photoError').textContent = '';
  show('profilePhotoScreen');
}
$('editPhotoChooseBtn').onclick = () => $('editPhotoInput').click();
$('editPhotoRemoveBtn').onclick = async () => {
  const u = (profileData && profileData.user) || me; if (!u) return;
  try {
    const d = await api('/api/me/update', { method: 'POST', body: JSON.stringify({ firstName: u.firstName, lastName: u.lastName, username: u.username, photoData: null }) });
    me = d.user; persistMe(); profileData = null;
    renderEditList(); renderHomeHeader(); rewarmProfile();
    openPhotoScreen();
  } catch (err) { $('photoError').textContent = err.message || 'Could not remove the photo.'; }
};
// v147: the password screen is always open (no reveal button any
// more) — the fields, requirements and Save live on their own screen.
function openPasswordScreen() {
  $('editCurrentPassword').value = ''; $('editNewPassword').value = ''; $('editNewPassword2').value = '';
  $('editPasswordError').textContent = ''; $('editPasswordDone').textContent = '';
  renderPwReqs('editPwReqs', '');
  show('profilePasswordScreen');
  $('editCurrentPassword').focus();
}
// v147: Duello Pro is a real account flag. Tapping an option applies
// it at once (Apple-style selection list) — no Save button. A failed
// switch puts the checkmark back where it was.
function renderProScreen() {
  const on = !!(me && me.pro);
  // v154: the "You're on Duello Pro" line is gone (index.html) — the
  // checks on the two options say which tier you are on.
  $('proFreeCheck').textContent = on ? '' : '✓';
  $('proProCheck').textContent = on ? '✓' : '';
  $('proError').textContent = '';
}
function openProScreen() { renderProScreen(); show('profileProScreen'); }
async function setPro(on) {
  if (!me || !!me.pro === on) { renderProScreen(); return; }
  $('proError').textContent = '';
  try {
    const d = await api('/api/me/pro', { method: 'POST', body: JSON.stringify({ pro: on }) });
    me = d.user; persistMe(); profileData = null;
    renderProScreen(); renderEditList(); renderHomeHeader(); rewarmProfile();
  } catch (err) {
    // Re-render first (it restores the checkmark AND clears the error
    // line), then set the error — the other order wipes the message.
    renderProScreen();
    $('proError').textContent = err.message || 'Could not change plan.';
  }
}
$('proFreeRow').onclick = () => setPro(false);
$('proProRow').onclick = () => setPro(true);
// Photo crop (v92): after picking a photo, the user frames it in a
// circular viewport — drag to move, slider to zoom — before it is
// saved. Pfps display round everywhere, so the crop preview is what
// you get. Output is a 512x512 JPEG under the 750KB cap.
const CROP_SIZE = 280; // viewport px, matches .crop-viewport in CSS
let cropState = null; // {img, base, zoom, x, y}
function cropBaseScale(img) { return CROP_SIZE / Math.min(img.width, img.height); }
function cropClamp(s) {
  // Keep the image covering the square: the offset range is half the
  // overflow on each axis (0 when the image exactly fills it).
  const w = s.img.width * s.base * s.zoom, h = s.img.height * s.base * s.zoom;
  const mx = Math.max(0, (w - CROP_SIZE) / 2), my = Math.max(0, (h - CROP_SIZE) / 2);
  s.x = Math.max(-mx, Math.min(mx, s.x));
  s.y = Math.max(-my, Math.min(my, s.y));
}
function cropPaint() {
  const s = cropState; if (!s) return;
  const el = $('cropImg');
  el.style.width = (s.img.width * s.base * s.zoom) + 'px';
  el.style.height = (s.img.height * s.base * s.zoom) + 'px';
  el.style.transform = 'translate(calc(-50% + ' + s.x + 'px), calc(-50% + ' + s.y + 'px))';
}
function openCrop(img) {
  cropState = { img, base: cropBaseScale(img), zoom: 1, x: 0, y: 0 };
  $('cropImg').src = img.src;
  $('cropZoom').value = '1';
  cropPaint();
  $('cropModal').classList.remove('hidden');
}
function closeCrop() {
  $('cropModal').classList.add('hidden');
  cropState = null;
  $('editPhotoInput').value = ''; // same file picked again still fires
}
let cropDrag = null;
$('cropViewport').addEventListener('pointerdown', e => {
  if (!cropState) return;
  cropDrag = { px: e.clientX, py: e.clientY, x: cropState.x, y: cropState.y };
  try { $('cropViewport').setPointerCapture(e.pointerId); } catch {}
});
$('cropViewport').addEventListener('pointermove', e => {
  if (!cropDrag || !cropState) return;
  cropState.x = cropDrag.x + (e.clientX - cropDrag.px);
  cropState.y = cropDrag.y + (e.clientY - cropDrag.py);
  cropClamp(cropState); cropPaint();
});
$('cropViewport').addEventListener('pointerup', () => { cropDrag = null; });
$('cropViewport').addEventListener('pointercancel', () => { cropDrag = null; });
$('cropZoom').oninput = () => {
  if (!cropState) return;
  cropState.zoom = parseFloat($('cropZoom').value) || 1;
  cropClamp(cropState); cropPaint();
};
$('cropUseBtn').onclick = async () => {
  const s = cropState; if (!s) return;
  // Map the viewport square back onto the source image: the image is
  // drawn at (base*zoom) scale, centred on the viewport plus (x, y).
  const scale = s.base * s.zoom;
  const w = s.img.width * scale, h = s.img.height * scale;
  const sx = (w / 2 - CROP_SIZE / 2 - s.x) / scale;
  const sy = (h / 2 - CROP_SIZE / 2 - s.y) / scale;
  const side = CROP_SIZE / scale;
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  cv.getContext('2d').drawImage(s.img, sx, sy, side, side, 0, 0, 512, 512);
  let data = cv.toDataURL('image/jpeg', 0.82);
  if (data.length > 750000) data = cv.toDataURL('image/jpeg', 0.7);
  if (data.length > 750000) { $('photoError').textContent = 'That photo is too large. Pick a smaller one.'; return; }
  closeCrop();
  $('editPfp').innerHTML = `<img src="${data}" alt="">`; $('editPfp').classList.remove('no-photo');
  $('editPhotoRemoveBtn').classList.remove('hidden');
  $('photoError').textContent = '';
  // v147: the photo saves at once (there is no form submit any more).
  const u = (profileData && profileData.user) || me; if (!u) return;
  try {
    const d = await api('/api/me/update', { method: 'POST', body: JSON.stringify({ firstName: u.firstName, lastName: u.lastName, username: u.username, photoData: data }) });
    me = d.user; persistMe(); profileData = null;
    // v152: a photo exists now, so the button reads "Choose photo"
    // (openPhotoScreen only sets the label on open — without this the
    // button kept saying "Add photo" after a successful save).
    $('editPhotoChooseBtn').textContent = 'Choose photo';
    renderEditList(); renderHomeHeader(); rewarmProfile();
  } catch (err) { $('photoError').textContent = err.message || 'Could not save the photo.'; }
};
$('cropCancelBtn').onclick = () => closeCrop();
$('editPhotoInput').onchange = () => {
  const f = $('editPhotoInput').files && $('editPhotoInput').files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => openCrop(img);
    img.onerror = () => { $('photoError').textContent = 'That photo could not be read. Try a different one.'; };
    img.src = String(rd.result || '');
  };
  rd.readAsDataURL(f);
};

// Usernames are lowercase-only (v133): force every character to
// lowercase as it is typed, in the profile edit and the signup
// flow, so an uppercase letter can never be entered. The server
// lowercases again as a backstop.
['suUsername'].forEach(id => {
  const el = $(id); if (!el) return;
  el.addEventListener('input', () => { const v = el.value; if (v !== v.toLowerCase()) el.value = v.toLowerCase(); });
});


$('editPasswordSaveBtn').onclick = async () => {
  $('editPasswordError').textContent = ''; $('editPasswordDone').textContent = '';
  const currentPassword = $('editCurrentPassword').value, newPassword = $('editNewPassword').value, newPassword2 = $('editNewPassword2').value;
  try {
    if (!pwPolicyOk(newPassword)) throw new Error('Password needs 8+ characters, a capital letter, a lowercase letter, and a number.');
    if (newPassword !== newPassword2) throw new Error('Passwords do not match.');
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    $('editCurrentPassword').value = ''; $('editNewPassword').value = ''; $('editNewPassword2').value = '';
    renderPwReqs('editPwReqs', '');
    $('editPasswordDone').textContent = 'Password changed.';
  } catch (err) { $('editPasswordError').textContent = err.message || 'Could not change password.'; }
};
// The password fields live on their own screen (v147), so
// Enter in one does nothing by itself. Enter in the last field saves
// the new password; in the other two it does nothing.
['editCurrentPassword', 'editNewPassword', 'editNewPassword2'].forEach(id => {
  const inp = $(id); if (!inp) return;
  inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (id === 'editNewPassword2') $('editPasswordSaveBtn').click();
  });
});
// Eye toggles for every password field: tap to see what was typed.
// Delegated on the document (not wired per button at load) so the
// toggle works no matter when the field's screen is shown, and taps
// on the icon's SVG paths still land on the button. Grey eye = hidden,
// Duello blue eye = visible. No emoji anywhere in the toggle.
// The toggle runs on pointerdown, not click: on iOS a tap next to a
// focused password field can lose its click when the tap dismisses
// the keyboard and the layout shifts, but pointerdown fires at touch
// start, before any of that. preventDefault keeps focus in the field
// so the keyboard stays up. The click handler below is only a
// fallback for keyboard activation, guarded like the Play button so
// a pointerdown tap does not toggle twice.
function toggleEye(btn) {
  const inp = $(btn.dataset.target); if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}
let lastEyePointerAt = 0;
document.addEventListener('pointerdown', e => {
  const btn = e.target.closest ? e.target.closest('.pw-eye') : null;
  if (!btn) return;
  e.preventDefault();
  lastEyePointerAt = Date.now();
  toggleEye(btn);
});
document.addEventListener('click', e => {
  if (Date.now() - lastEyePointerAt < 1000) return;
  const btn = e.target.closest ? e.target.closest('.pw-eye') : null;
  if (!btn) return;
  toggleEye(btn);
});
// Password policy: 8+ characters with a capital, a lowercase, and a
// number. Shown live under every new-password field.
function pwPolicy(pw) {
  return { len: pw.length >= 8, upper: /[A-Z]/.test(pw), lower: /[a-z]/.test(pw), digit: /[0-9]/.test(pw) };
}
function pwPolicyOk(pw) { const r = pwPolicy(pw); return r.len && r.upper && r.lower && r.digit; }
function renderPwReqs(listId, pw) {
  const el = $(listId); if (!el) return;
  const r = pwPolicy(pw);
  el.querySelectorAll('li[data-req]').forEach(li => li.classList.toggle('met', !!r[li.dataset.req]));
}
[['suPassword', 'suPwReqs'], ['rpPassword', 'rpPwReqs'], ['editNewPassword', 'editPwReqs']].forEach(([inputId, listId]) => {
  const inp = $(inputId); if (inp) inp.addEventListener('input', () => renderPwReqs(listId, inp.value));
});
// Wipe every account-owned surface on sign-out (and account
// delete): the old account's rows, requests, search results and
// profile must never be what the next sign-in first sees.
function wipeAccountScreens() {
  blankProfileUI();
  pendingRemove = null;
  friendsStale = true; friendsRenderedScope = null;
  hideChallengeModal();
  $('leaderboardList').innerHTML = '';
  $('friendRequests').innerHTML = '';
  $('challengeRequests').innerHTML = '';
  $('friendSearchResults').innerHTML = '';
  $('friendSearch').value = '';
  $('noFriendsCard').classList.add('hidden');
}
$('profileSignOutBtn').onclick = () => { $('signOutModal').classList.remove('hidden'); };
$('signOutCancelBtn').onclick = () => { $('signOutModal').classList.add('hidden'); };
$('signOutModal').addEventListener('click', e => { if (e.target === $('signOutModal')) $('signOutModal').classList.add('hidden'); });
// v151: sign out asks first. The confirm runs the old immediate
// sign-out body unchanged.
$('signOutConfirmBtn').onclick = async () => {
  $('signOutModal').classList.add('hidden');
  try { await api('/api/signout', { method: 'POST' }); } catch {}
  token = ''; storeDel('duello_token'); me = null; profileData = null;
  wipeAccountScreens();
  setAuthMode('signin'); show('authScreen');
};
// v152: delete confirmation is a modal window like sign-out (same
// .person-modal/.person-card), not a page. Backdrop tap closes it.
$('editDeleteBtn').onclick = () => {
  showDeleteConfirmStep();
  $('deleteModal').classList.remove('hidden');
};
$('editDeleteCancelBtn').onclick = () => $('deleteModal').classList.add('hidden');
$('deleteModal').addEventListener('click', e => { if (e.target === $('deleteModal')) $('deleteModal').classList.add('hidden'); });
// Account deletion is code-gated (v141): "Yes, delete my account"
// emails a 6-digit code to the account's own address, and only the
// code (via a verified token) authorizes the delete.
async function requestDeleteCode() {
  await api('/api/me/delete/request-code', { method: 'POST' });
}
function showDeleteCodeStep(note) {
  $('editDeleteActions').classList.add('hidden');
  $('editDeleteCode').classList.remove('hidden');
  $('editDeleteCodeMsg').textContent = note || ('A code was sent to ' + (me && me.email ? me.email : 'your email') + '.');
  $('editDeleteCodeError').textContent = '';
  $('editDeleteCodeInput').value = '';
  $('editDeleteCodeInput').focus();
}
function showDeleteConfirmStep() {
  $('editDeleteCode').classList.add('hidden');
  $('editDeleteActions').classList.remove('hidden');
  $('editDeleteError').textContent = '';
}
$('editDeleteConfirmBtn').onclick = async () => {
  $('editDeleteError').textContent = '';
  try { await requestDeleteCode(); }
  catch (err) {
    // A code requested a moment ago is still valid: open the code
    // step instead of blocking on the cooldown.
    if (err.message && err.message.indexOf('just sent') !== -1) { showDeleteCodeStep('A code was already sent to ' + (me && me.email ? me.email : 'your email') + ' — it is still valid.'); return; }
    $('editDeleteError').textContent = err.message || 'Could not send the code.'; return;
  }
  showDeleteCodeStep();
};
$('editDeleteCodeResendBtn').onclick = async () => {
  $('editDeleteCodeError').textContent = '';
  try { await requestDeleteCode(); $('editDeleteCodeMsg').textContent = 'A new code was sent to ' + (me && me.email ? me.email : 'your email') + '.'; } catch (err) { $('editDeleteCodeError').textContent = err.message || 'Could not send the code.'; }
};
$('editDeleteCodeBackBtn').onclick = () => showDeleteConfirmStep();
$('editDeleteCodeVerifyBtn').onclick = async () => {
  $('editDeleteCodeError').textContent = '';
  const code = $('editDeleteCodeInput').value.trim();
  try {
    const d = await api('/api/me/delete/verify-code', { method: 'POST', body: JSON.stringify({ code }) });
    await api('/api/me/delete', { method: 'POST', body: JSON.stringify({ verifiedToken: d.verifiedToken }) });
  } catch (err) { $('editDeleteCodeError').textContent = err.message || 'Could not delete account.'; return; }
  token = ''; storeDel('duello_token'); me = null; profileData = null; game = null;
  wipeAccountScreens();
  $('deleteModal').classList.add('hidden');
  setAuthMode('signin'); show('authScreen');
};
let suEmail = '', suVerifiedToken = '';
function setAuthMode(mode) {
  authMode = mode;
  $('authHeading').textContent = mode === 'signup' ? 'Sign up' : mode === 'reset' ? 'Reset password' : 'Sign in';
  $('authForm').classList.toggle('hidden', mode !== 'signin');
  $('signupSteps').classList.toggle('hidden', mode !== 'signup');
  $('resetSteps').classList.toggle('hidden', mode !== 'reset');
  $('authToggleBtn').textContent = mode === 'signup' ? 'Already have an account? Sign in' : mode === 'reset' ? 'Back to sign in' : 'Need an account? Sign up';
  $('authError').textContent = ''; $('authSuccess').textContent = '';
  if (mode === 'signup') showSignupStep('email');
  if (mode === 'reset') showResetStep('email');
}
function showSignupStep(step) {
  ['Email', 'Code', 'Profile'].forEach(s => $('signupStep' + s).classList.toggle('hidden', s.toLowerCase() !== step));
  ['suError', 'suError2', 'suError3'].forEach(id => { $(id).textContent = ''; });
  if (step === 'email') $('suSentMsg').textContent = '';
  if (step === 'profile') renderPwReqs('suPwReqs', $('suPassword').value || '');
}
$('authToggleBtn').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
$('authForm').onsubmit = async e => {
  e.preventDefault(); $('authError').textContent = ''; $('authSuccess').textContent = '';
  const email = $('authEmail').value.trim(), password = $('authPassword').value;
  try {
    const d = await api('/api/signin', { method: 'POST', body: JSON.stringify({ email, password }) });
    token = d.token; storeSet('duello_token', token); me = d.user; persistMe(); profileData = null;
    show('homeScreen');
    try { initPushNotifications(); initAppUrlOpenListener(); maybeRequestPushAtSetup(); maybeOpenPuzzleDeepLink(); maybeOpenFriendDeepLink(); maybeOpenChallengeDeepLink(); maybeOpenInviteDeepLink(); maybeOpenPushChallenge(); } catch {}
  } catch (err) { $('authError').textContent = err.message || 'Something went wrong.'; }
};
$('suSendBtn').onclick = async () => {
  $('suError').textContent = '';
  suEmail = $('suEmail').value.trim();
  try {
    await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email: suEmail }) });
    showSignupStep('code');
    $('suSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('suError').textContent = err.message || 'Something went wrong.'; }
};
$('suResendBtn').onclick = async () => {
  $('suError2').textContent = '';
  try {
    await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email: suEmail }) });
    $('suSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('suError2').textContent = err.message || 'Something went wrong.'; }
};
$('suBackBtn').onclick = () => showSignupStep('email');
$('suVerifyBtn').onclick = async () => {
  $('suError2').textContent = '';
  const code = $('suCode').value.trim();
  try {
    const d = await api('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email: suEmail, code }) });
    suVerifiedToken = d.verifiedToken;
    showSignupStep('profile');
  } catch (err) { $('suError2').textContent = err.message || 'Something went wrong.'; }
};
$('suCreateBtn').onclick = async () => {
  $('suError3').textContent = '';
  const firstName = $('suFirstName').value.trim(), lastName = $('suLastName').value.trim(), username = $('suUsername').value.trim().toLowerCase(), password = $('suPassword').value;
  try {
    if (!firstName || !lastName) throw new Error('First and last name are required.');
    if (!/^[a-z0-9_]{3,}$/.test(username)) throw new Error('Username: lowercase letters, numbers, and underscores only, at least 3 characters.');
    if (!pwPolicyOk(password)) throw new Error('Password needs 8+ characters, a capital letter, a lowercase letter, and a number.');
    const d = await api('/api/signup', { method: 'POST', body: JSON.stringify({ firstName, lastName, username, email: suEmail, password, verifiedToken: suVerifiedToken }) });
    token = d.token; storeSet('duello_token', token); me = d.user; persistMe(); profileData = null;
    show('homeScreen');
    try { initPushNotifications(); initAppUrlOpenListener(); maybeRequestPushAtSetup(); maybeOpenPuzzleDeepLink(); maybeOpenFriendDeepLink(); maybeOpenChallengeDeepLink(); maybeOpenInviteDeepLink(); maybeOpenPushChallenge(); } catch {}
  } catch (err) { $('suError3').textContent = err.message || 'Something went wrong.'; }
};
let rpEmail = '', rpVerifiedToken = '';
function showResetStep(step) {
  ['Email', 'Code', 'Password'].forEach(s => $('resetStep' + s).classList.toggle('hidden', s.toLowerCase() !== step));
  ['rpError', 'rpError2', 'rpError3'].forEach(id => { $(id).textContent = ''; });
  if (step === 'email') $('rpSentMsg').textContent = '';
  if (step === 'password') renderPwReqs('rpPwReqs', $('rpPassword').value || '');
}
$('forgotPasswordBtn').onclick = () => setAuthMode('reset');
$('rpSendBtn').onclick = async () => {
  $('rpError').textContent = '';
  rpEmail = $('rpEmail').value.trim();
  try {
    await api('/api/auth/request-reset', { method: 'POST', body: JSON.stringify({ email: rpEmail }) });
    showResetStep('code');
    $('rpSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('rpError').textContent = err.message || 'Something went wrong.'; }
};
$('rpResendBtn').onclick = async () => {
  $('rpError2').textContent = '';
  try {
    await api('/api/auth/request-reset', { method: 'POST', body: JSON.stringify({ email: rpEmail }) });
    $('rpSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('rpError2').textContent = err.message || 'Something went wrong.'; }
};
$('rpBackBtn').onclick = () => showResetStep('email');
$('rpVerifyBtn').onclick = async () => {
  $('rpError2').textContent = '';
  const code = $('rpCode').value.trim();
  try {
    const d = await api('/api/auth/verify-reset-code', { method: 'POST', body: JSON.stringify({ email: rpEmail, code }) });
    rpVerifiedToken = d.verifiedToken;
    showResetStep('password');
  } catch (err) { $('rpError2').textContent = err.message || 'Something went wrong.'; }
};
$('rpResetBtn').onclick = async () => {
  $('rpError3').textContent = '';
  const password = $('rpPassword').value, password2 = $('rpPassword2').value;
  try {
    if (!pwPolicyOk(password)) throw new Error('Password needs 8+ characters, a capital letter, a lowercase letter, and a number.');
    if (password !== password2) throw new Error('Passwords do not match.');
    await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email: rpEmail, password, verifiedToken: rpVerifiedToken }) });
    rpVerifiedToken = '';
    $('rpPassword').value = ''; $('rpPassword2').value = ''; $('rpCode').value = '';
    renderPwReqs('rpPwReqs', '');
    setAuthMode('signin');
    $('authSuccess').textContent = 'Password has been reset, please log in.';
  } catch (err) { $('rpError3').textContent = err.message || 'Something went wrong.'; }
};
