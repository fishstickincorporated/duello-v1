// Duello bot-play frontend (Postgres, no login). Server is the source of truth:
// every play is validated server-side; this client only renders state and sends placements.
// No auth screen in this slice: on load the client creates/reuses a per-device
// guest via POST /api/guest and stores its token in localStorage ('duello_token').
let token = localStorage.getItem('duello_token') || '';
let me = null, game = null, gameFetchAt = 0;
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
// Display rounding is CEIL, not floor: with floor, 5:00 dropped to 4:59
// within ~100ms of starting (299500ms remaining floors to 4:59), so
// the timer never sat on 5:00 for a full second. With ceil, 5:00 shows
// for the whole first second (300000 down to 299001ms), then 4:59 for
// the next full second, and so on. The old ceil problem (runoff parsed
// back from displayed text jumping up a second) no longer applies:
// runoff now starts from game state, not from displayed text.
const fmtClock = ms => { ms = Math.max(0, Math.ceil(ms / 1000) * 1000); if (ms === 0) return '0:00'; const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return `${m}:${String(s).padStart(2, '0')}`; };
// Clock accuracy fix: the old code used Math.ceil, so the display was
// always rounded UP to the next second — the clock looked a second
// ahead of the real remaining time, and the bot runoff (parsed back
// from that displayed text) started a second high, i.e. it jumped UP
// before animating down 15s to the 20s mark. Floor matches the real time.
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function show(id) {
  ['homeScreen', 'botScreen', 'gameScreen'].forEach(s => { const el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
  const isMenu = ['homeScreen', 'botScreen'].includes(id);
  const tb = $('tabBar'); if (tb) tb.classList.toggle('hidden', !isMenu);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if ((id === 'homeScreen' || id === 'botScreen') && $('tabHome')) $('tabHome').classList.add('active');
}
function silhouetteSVG(size) { return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="8" r="4" fill="#9aa3b2"/><path d="M4 21 C4 16 7 13 12 13 C17 13 20 16 20 21 Z" fill="#9aa3b2"/></svg>`; }
function pfpHTML(userLike) {
  if (userLike && userLike.photoData) return `<img src="${userLike.photoData}" alt="">`;
  return silhouetteSVG(36);
}
function goTab(id) { show(id); }
$('tabHome').onclick = () => show('homeScreen');

async function loadMe() {
  // No /api/me in the bot-play slice. Elo for the scoreboard comes from
  // game.player on each game response; this is a no-op kept so game-flow
  // call sites do not need to change.
  return !!token;
}
async function ensureGuest() {
  const d = await api('/api/guest', { method: 'POST' });
  token = d.token; localStorage.setItem('duello_token', token); me = d.user;
  return d;
}
$('playBotsBtn').onclick = () => show('botScreen');
$('botBackBtn').onclick = () => show('homeScreen');
$('competitiveBtn').onclick = () => startGame('competitive');
$('fishstickBtn').onclick = () => startGame('fishstick');
async function startGame(bot) {
  currentBot = bot; botTurnTapTime = Date.now();
  try {
    game = await api('/api/games', { method: 'POST', body: JSON.stringify({ bot }) });
  } catch (e) {
    // Stored guest token was rejected (e.g. database was reset): create a
    // fresh guest once and retry, instead of stranding the user on Home.
    await ensureGuest();
    game = await api('/api/games', { method: 'POST', body: JSON.stringify({ bot }) });
  }
  // Display 5:00 during the countdown, not the server's create-round-trip
  // value (4:59): the clocks only start when the countdown ends (see /start).
  game.clocks.human = 300000; game.clocks.bot = 300000;
  gameFetchAt = Date.now(); pending = []; selectedRack = null; armed = {};
  clearStatDelay(); statShownGameId = null;
  // Set the countdown flag BEFORE the first render, so that render draws
  // the rack as empty slots (not full letters) from the very first frame.
  countdownActive = true;
  show('gameScreen'); $('gameScreen').classList.add('counting'); renderGame(); startCountdown();
}
async function endCountdown() {
  // Keep the clocks pinned until the new state actually arrives. The old
  // code cleared countdownActive BEFORE awaiting /start, so the 100ms
  // tick ran during that network round-trip with the stale creation-time
  // gameFetchAt (5s countdown + ~1s create = ~6s elapsed) and showed
  // 4:54 for a brief second, then corrected to 5:00 when /start returned.
  // Now the overlay hides but countdownActive (and the hidden rack)
  // stay until /start returns and gameFetchAt is reset to that moment.
  $('countdownOverlay').classList.add('hidden');
  try {
    try { game = await api(`/api/games/${game.id}/start`, { method: 'POST' }); }
    catch { game = await api(`/api/games/${game.id}`); }
    countdownActive = false;
    $('gameScreen').classList.remove('counting');
    clockHoldUntil = Date.now() + 1000;
    gameFetchAt = Date.now(); pending = []; selectedRack = null; renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
  } catch { countdownActive = false; $('gameScreen').classList.remove('counting'); clockHoldUntil = Date.now() + 1000; botTurnTapTime = 0; beginBotTurn(); }
}
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownActive = true;
  $('gameScreen').classList.add('counting');
  // Re-render so the rack is blank slots (and controls disabled) during
  // the wait, even if an earlier render drew letters before the flag set.
  cleanupStuckDrag(); renderGame();
  const ov = $('countdownOverlay'); ov.classList.remove('hidden');
  let n = 5; $('countdownNum').textContent = String(n);
  countdownInterval = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(countdownInterval); countdownInterval = null; endCountdown(); return; }
    $('countdownNum').textContent = String(n);
  }, 1000);
}
function boardCell(r, c) { return game.board[r][c]; }
function renderGame() {
  if (!game) return;
  // Never rebuild the board/rack while a drag is live: re-creating the
  // captured tile mid-drag destroys it and can strand pointer capture,
  // which is how a drag froze the whole screen. The next render after the
  // drag ends will show any bot move that arrived in the meantime.
  if (activeDragCleanup) return;
  $('playerName').textContent = 'You';
  try { document.querySelector('.player-panel .pfp').innerHTML = pfpHTML(me); document.querySelector('.stat-pfp .pfp').innerHTML = pfpHTML(me); } catch {}
  $('playerElo').textContent = me ? me.elo : game.player.elo;
  const isFish = game.botType === 'fishstick';
  $('botName').textContent = isFish ? 'Fishstick' : 'Bot';
  $('botElo').textContent = isFish ? '∞' : game.botElo;
  if (isFish) $('botPfp').innerHTML = '<img src="/assets/fishstick.jpeg" alt="Fishstick">'; else $('botPfp').textContent = '🤖';
  document.querySelector('.player-panel').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'human');
  document.querySelector('.bot-panel').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'bot');
  $('scoreHuman').textContent = String(game.scores.human); $('scoreBot').textContent = String(game.scores.bot);
  const lastHtml = (l) => {
    if (!l) return '';
    if (l.passed) return 'passed <span class="pts">-30s</span>';
    const words = (l.words && l.words.length) ? l.words : [l.word];
    return `${words.join(', ')}<br><span class="pts">+${l.points} pts${l.bingo ? ' · <span class="bingo">bingo! +30</span>' : ''}${l.isDuello ? ' · Duello +30' : ''}</span>`;
  };
  $('lastHuman').innerHTML = lastHtml(game.lastHuman);
  $('lastBot').innerHTML = lastHtml(game.lastBot);
  // Board
  const boardEl = $('board'); boardEl.innerHTML = '';
  const lastSet = new Set((game.lastCells || []).map(([r, c]) => r + ',' + c));
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    const cell = document.createElement('div');
    const prem = game.premiums[`${r},${c}`];
    cell.className = 'cell' + (prem ? ' ' + prem : '') + (game.isFirst && r >= 2 && r <= 7 && c >= 2 && c <= 7 ? ' glow' : '') + (lastSet.has(r + ',' + c) ? ' last-word' : '');
    const pend = pending.find(p => p.row === r && p.col === c);
    const letter = boardCell(r, c) || (pend ? pend.letter : null);
    // A premium label must never share the cell with a tile: the cell is a
    // flex container, so the label + tile split the width and the tile (and
    // its letter) was squeezed to about half width on DL/DW/TL/TW squares.
    cell.textContent = letter ? '' : (prem || '');
    if (letter) {
      const t = document.createElement('div'); t.className = 'tile' + (pend ? ' pending' : '');
      t.innerHTML = `<span class="letter">${letter}</span><span class="val">${({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter]}</span>`;
      if (pend) enablePlacedDrag(t, pend);
      else t.onclick = () => showDefinition(r, c);
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
    if (!optimisticPlay && pending.some(p => p.rackIndex === idx)) { const s = document.createElement('div'); s.style.flex = '1'; rackEl.appendChild(s); return; }
    const t = document.createElement('div'); t.className = 'tile'; t.dataset.idx = idx;
    t.innerHTML = `<span class="letter">${letter}</span><span class="val">${({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter]}</span>`;
    if (selectedRack === idx) t.style.outline = '2px solid #ffd166';
    if (!optimisticPlay) enableRackDrag(t, idx);
    rackEl.appendChild(t);
  });
  // Controls / end state
  const finished = game.status === 'finished';
  // Recall only when a tile is actually placed; Pass only on your turn.
  // Both are greyed (disabled) otherwise, instead of tappable-but-dead.
  const yourTurn = game.status === 'active' && game.clocks.turn === 'human' && !playInFlight;
  $('recallBtn').disabled = countdownActive || !(yourTurn && pending.length > 0);
  $('passBtn').disabled = countdownActive || !yourTurn;
  $('shuffleBtn').disabled = countdownActive || playInFlight || optimisticPlay;
  $('forfeitBtn').disabled = countdownActive;
  document.querySelector('.controls').classList.toggle('hidden', finished);
  $('endButtons').classList.toggle('hidden', !finished);
  $('gameDim').classList.toggle('dimmed', finished && !$('statWindow').classList.contains('hidden'));
  // Final board stays visible for 3s after time expiry only, before
  // the stats window covers it. Forfeit and other finishes show stats
  // immediately (see isTimeoutFinish). Tapping Game Stats shows it
  // immediately; Main Menu / Play Again cancel the pending show.
  if (finished && game.stats) showStatWindowDelayed(game.stats);
  tickClocks();
  if (countdownActive) { $('clockHuman').textContent = '5:00'; $('clockBot').textContent = '5:00'; }
  updateStatus();
}
let runoffUntil = 0, humanRunoffUntil = 0, timeoutFetching = false, timeoutLastAttempt = 0;
let countdownInterval = null, countdownActive = false;
let clockHoldUntil = 0;
function canPlaceTiles() { return !!game && game.status === 'active' && game.clocks.turn === 'human' && !playInFlight && !countdownActive; }
async function handleHumanTimeout() {
  if (!game || game.status !== 'active' || timeoutFetching) return;
  timeoutFetching = true; timeoutLastAttempt = Date.now();
  try {
    const next = await api(`/api/games/${game.id}`);
    game = next; gameFetchAt = Date.now(); pending = []; selectedRack = null; renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
  } catch {} finally { timeoutFetching = false; }
}
function tickClocks() {
  if (!game) return;
  // Game-start hold: both timers sit on 5:00 for a full second before
  // ticking to 4:59. With floor display, 5:00 would otherwise drop to
  // 4:59 within ~100ms of starting. This is display-only: the underlying
  // elapsed time keeps running from the start, so at hold end the clock
  // reads exactly 4:59, then 4:58 a second later, with no jump.
  if (Date.now() < clockHoldUntil) { $('clockHuman').textContent = '5:00'; $('clockBot').textContent = '5:00'; return; }
  // During the countdown both clocks are pinned to 5:00, every tick.
  // Any render that recomputed from the server create time (4:59) or
  // from elapsed time during the countdown was the first-seconds glitch
  // in the screenshots: this overwrites it within 100ms, and renderGame
  // below does the same immediately.
  if (countdownActive) { $('clockHuman').textContent = '5:00'; $('clockBot').textContent = '5:00'; return; }
  const elapsed = Date.now() - gameFetchAt;
  let h = game.clocks.human, b = game.clocks.bot;
  if (game.status === 'active') {
    if (game.clocks.turn === 'human') h = Math.max(0, h - elapsed); else b = Math.max(0, b - elapsed);
  }
  if (Date.now() >= humanRunoffUntil) $('clockHuman').textContent = fmtClock(h);
  // During a runoff animation the bot clock is driven by the animation,
  // not by this 100ms tick — the tick used to jump it straight to the
  // stepped value and flicker over the animation.
  if (Date.now() >= runoffUntil) $('clockBot').textContent = fmtClock(b);
  // Human clock hit 0: do not leave the game sitting on a dead turn.
  // Fetching flips the server to the bot turn, which then loops on its own.
  if (game.status === 'active' && game.clocks.turn === 'human' && h <= 0) { $('status').textContent = 'Out of time, opponent plays on.'; if (!timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleHumanTimeout(); }
  botWatchdog();
}
setInterval(tickClocks, 100);

let botTimer = null, suppressNextClick = false, botTurnTapTime = 0;
function parseClockText(txt) { const m = /^([0-9]+):([0-9]{2})$/.exec((txt || '').trim()); return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 : null; }
function animateClockRunoff(fromMs, toMs) {
  if (fromMs !== null && toMs !== null) fromMs = Math.min(fromMs, toMs + 20000);
  if (fromMs === null || toMs === null || fromMs <= toMs) { if (toMs !== null) $('clockBot').textContent = fmtClock(toMs); return; }
  const steps = Math.max(1, Math.round((fromMs - toMs) / 1000));
  // 50ms per displayed second = ~750ms for the 15s runoff to the 20s mark.
  runoffUntil = Date.now() + steps * 50 + 100;
  let i = 0;
  const iv = setInterval(() => {
    i++;
    const v = fromMs - Math.round((fromMs - toMs) * i / steps);
    $('clockBot').textContent = fmtClock(Math.max(toMs, v));
    if (i >= steps) { clearInterval(iv); $('clockBot').textContent = fmtClock(toMs); runoffUntil = 0; }
  }, 50);
}
function animateHumanRunoff(fromMs, toMs) {
  if (fromMs === null || toMs === null || fromMs <= toMs) { if (toMs !== null) $('clockHuman').textContent = fmtClock(toMs); return; }
  const steps = Math.max(1, Math.round((fromMs - toMs) / 1000));
  humanRunoffUntil = Date.now() + steps * 20 + 100;
  $('clockHuman').textContent = fmtClock(fromMs);
  let i = 0;
  const iv = setInterval(() => {
    i++;
    const v = fromMs - Math.round((fromMs - toMs) * i / steps);
    $('clockHuman').textContent = fmtClock(Math.max(toMs, v));
    if (i >= steps) { clearInterval(iv); $('clockHuman').textContent = fmtClock(toMs); humanRunoffUntil = 0; }
  }, 20);
}
let lastBotPollAt = 0;
async function pollBotTurn() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  lastBotPollAt = Date.now(); botTimer = null;
  try {
    // Runoff start from the game state, not from the displayed text:
    // the displayed text is second-truncated, so parsing it back gave
    // a start up to a second off (the jump-up before the runoff).
    const fromMs = game.clocks.turn === 'bot' ? Math.max(0, game.clocks.bot - (Date.now() - gameFetchAt)) : game.clocks.bot;
    const prevBot = game.lastBot ? JSON.stringify(game.lastBot) : '';
    const prevBotScore = game.scores ? game.scores.bot : 0;
    const next = await api(`/api/games/${game.id}`);
    const botMoved = (next.lastBot ? JSON.stringify(next.lastBot) : '') !== prevBot || (next.scores && next.scores.bot !== prevBotScore);
    game = next; gameFetchAt = Date.now(); pending = []; selectedRack = null; renderGame();
    // Animate the runoff whenever the bot actually played, even if the
    // server already flipped to the NEXT bot turn (human clock at 0) —
    // the old code returned early in that case and the runoff never ran.
    if (botMoved) animateClockRunoff(fromMs, next.clocks.bot);
    if (next.clocks.turn === 'bot' && next.status === 'active') {
      // Relative remaining time from the server, never the server's absolute
      // clock: comparing Render time to phone time added a spurious ~2s poll.
      const delay = next.botThinkRemainingMs != null ? Math.max(200, next.botThinkRemainingMs) : 500;
      if (botTimer) clearTimeout(botTimer);
      botTimer = setTimeout(pollBotTurn, delay);
      return;
    }
    if (next.status === 'active') {
      if (next.clocks.human <= 0) handleHumanTimeout();
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
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  if (botTimer) return;
  if (Date.now() - lastBotPollAt > 7000) { botTurnTapTime = 0; beginBotTurn(); }
}
function beginBotTurn() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  $('status').textContent = game.clocks.human <= 0 ? 'Out of time, opponent plays on.' : 'Waiting for your opponent.';
  if (botTimer) clearTimeout(botTimer);
  // Perceived think is measured from the tap, not from the server reply:
  // the Play/Pass POST (including the server's optimal-move scan) used to
  // stack on top of the 5s, pushing the feel to ~6s. Starting the 5s at the
  // tap and polling at that mark (the server guard then adds only its
  // remaining ~network time) lands the word at ~5s, not ~6s.
  if (botTurnTapTime && Date.now() - botTurnTapTime < 10000) {
    const delay = Math.max(0, 5000 - (Date.now() - botTurnTapTime));
    botTimer = setTimeout(pollBotTurn, delay);
    return;
  }
  // Relative remaining time, less the time since this game state arrived
  // (network + render), so latencies before the timer starts do not stack
  // on top of the 5s think.
  const delay = game.botThinkRemainingMs != null ? Math.max(0, game.botThinkRemainingMs - (Date.now() - gameFetchAt)) : 5000;
  botTimer = setTimeout(pollBotTurn, delay);
}

let validateInFlight = null, lastValidate = null, lastValidatePlacements = null, playInFlight = false, validateSeq = 0;
function setPlayState(state) {
  // Play colour is class-based, NOT disabled-based, so a grey Play is still
  // tappable and the server decides: a disabled button swallows taps, and
  // that swallow was the double-tap. Only no-pending / bot-turn Play is
  // truly disabled, and the handler returns early there anyway.
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
async function updateStatus() {
  if (!game) return;
  if (game.status === 'finished') { $('status').textContent = sentence(game.reason || 'Game over'); return; }
  if (game.clocks.turn !== 'human') { $('status').textContent = game.clocks.human <= 0 ? 'Out of time, opponent plays on.' : 'Waiting for your opponent.'; setPlayState('off'); return; }
  if (!pending.length) { $('status').textContent = game.isFirst ? 'First word must fit inside the glowing 6×6.' : 'Your move.'; setPlayState('off'); lastValidate = null; lastValidatePlacements = null; return; }
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
      const w = v.invalidWords;
      const list = w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
      $('status').textContent = w.length === 1 ? `${list} is not a word.` : `${list} are not words.`;
      setPlayState('invalid'); hideBubble();
    } else { $('status').textContent = v.error ? v.error.charAt(0).toUpperCase() + v.error.slice(1) + (v.error.endsWith('.') ? '' : '.') : 'Invalid play.'; setPlayState('invalid'); hideBubble(); }
  } catch {
    // A failed check leaves Play tappable (grey) — the Play handler will
    // ask the server directly, which is the authoritative verdict.
    setPlayState('invalid');
  }
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
  const cells = document.querySelectorAll('#board .cell');
  const cell = cells[target[0] * 10 + target[1]];
  if (!cell) return;
  const b = document.createElement('div'); b.className = 'play-bubble'; b.textContent = score;
  cell.style.position = 'relative'; cell.appendChild(b);
}
function hideBubble() { document.querySelectorAll('.play-bubble').forEach(e => e.remove()); }
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
  // Works on the player's turn AND on the opponent's turn: the rack is the
  // player's own rack, the shuffle endpoint does not require it to be your
  // turn, and the greyed opponent-turn rack is opacity-only (not disabled).
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
  return async () => {
    if (!armed[btn.id]) { armed[btn.id] = true; btn.classList.add('armed-red'); btn.innerHTML = 'SURE?<span class="penalty">' + penalty + '</span>'; setTimeout(() => { armed[btn.id] = false; btn.classList.remove('armed-red'); btn.textContent = label; }, 3000); return; }
    armed[btn.id] = false; btn.classList.remove('armed-red'); btn.textContent = label; await fn();
  };
}
$('passBtn').onclick = armButton($('passBtn'), 'Pass', async () => {
  // Same tap-time clock switch as Play: freeze human, start bot now.
  const tapAt = Date.now(); const clientElapsedMs = Math.max(0, tapAt - gameFetchAt);
  const prevHuman = game.clocks.human, prevFetchAt = gameFetchAt;
  game.clocks.human = Math.max(0, game.clocks.human - clientElapsedMs); game.clocks.turn = 'bot'; gameFetchAt = tapAt; renderGame(); tickClocks();
  const fromHuman = game.clocks.human;
  try { botTurnTapTime = tapAt; game = await api(`/api/games/${game.id}/pass`, { method: 'POST', body: JSON.stringify({ clientElapsedMs }) }); gameFetchAt = tapAt; pending = []; renderGame(); animateHumanRunoff(fromHuman, game.clocks.human); beginBotTurn(); }
  catch { game.clocks.turn = 'human'; game.clocks.human = prevHuman; gameFetchAt = prevFetchAt; renderGame(); }
}, '-30s');
$('forfeitBtn').onclick = armButton($('forfeitBtn'), 'Forfeit', async () => { game = await api(`/api/games/${game.id}/forfeit`, { method: 'POST' }); gameFetchAt = Date.now(); pending = []; renderGame(); }, 'you lose');
async function doPlay() {
  // Unstick first, and clear the drag's click-suppression flag: after a
  // drag, suppressNextClick stayed true until an empty cell was tapped,
  // and the Play tap itself was the thing that had to wait for a
  // validation round-trip to show any feedback.
  cleanupStuckDrag(); suppressNextClick = false;
  if (!game || game.clocks.turn !== 'human' || !pending.length || playInFlight) return;
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
  game.clocks.human = Math.max(0, game.clocks.human - clientElapsedMs);
  game.clocks.turn = 'bot'; gameFetchAt = tapAt;
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
  // Tiles replaced immediately at the tap, not when the Play POST
  // returns: refill the exact slots the server will refill (indexOf
  // matching, same as applyMove), and render the rack full, with no
  // spacers for the played tiles, while the board still shows the
  // played word via pending. The server reply then replaces the rack
  // with its authoritative letters, so the optimistic letters are
  // only ever visible during the POST.
  {
    const remaining = game.humanRack.slice(); const usedIndices = [];
    for (const pl of pending) { const idx = remaining.indexOf(pl.letter); if (idx >= 0) { usedIndices.push(idx); remaining[idx] = null; } }
    game.humanRack = optRefillRack(game.humanRack, usedIndices);
    optimisticPlay = true;
  }
  // Highlight the opponent's scoreboard AT THE TAP, not when the Play
  // POST returns: render now so the .active border flips immediately.
  playInFlight = true;
  renderGame();
  $('playBtn').disabled = true; $('playBtn').classList.remove('validating', 'play-valid', 'play-invalid');
  $('status').textContent = 'Waiting for your opponent.'; tickClocks();
  try {
    botTurnTapTime = tapAt;
    game = await api(`/api/games/${game.id}/play`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })), clientElapsedMs }) });
    // Keep the bot clock ticking from the tap, not from the reply:
    // gameFetchAt stays at tapAt, so the bot display does not jump
    // back up by the POST duration when the reply lands.
    gameFetchAt = tapAt; pending = []; optimisticPlay = false; cleanupStuckDrag(); $('rack').classList.add('instant'); renderGame(); setTimeout(() => $('rack').classList.remove('instant'), 100); beginBotTurn(); loadMe();
  } catch (e) {
    // Play failed: restore the human turn, its pre-tap clock, and the
    // pre-tap score / last play (undoing the optimistic score above).
    game.clocks.turn = 'human'; game.clocks.human = prevHuman; gameFetchAt = prevFetchAt;
    game.scores.human = prevScore; game.lastHuman = prevLastHuman; game.humanRack = prevRack; optimisticPlay = false;
    $('status').textContent = sentence(String(e.message || '').slice(0, 48)); renderGame();
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
// 3s delay is ONLY for time expiry: both clocks at 0 (and not a
// forfeit, which can also end with a clock at 0). Forfeit, consecutive
// passes, and no-playable-moves finishes show stats immediately, since
// their clocks are still running and 'Final score' alone does not
// distinguish a timeout from two passes.
function isTimeoutFinish() {
  return !!game && game.status === 'finished' && game.reason !== 'By forfeit' && game.clocks.human <= 0 && game.clocks.bot <= 0;
}
function showStatWindowDelayed(stats) {
  if (!game || statShownGameId === game.id || statDelayTimer) return;
  if (!isTimeoutFinish()) { showStatWindow(stats); return; }
  statDelayTimer = setTimeout(() => { statDelayTimer = null; if (game) showStatWindow(stats); }, 3000);
}
function showStatWindow(stats) {
  clearStatDelay(); if (game) statShownGameId = game.id;
  const w = $('statWindow'); w.classList.remove('hidden');
  $('gameDim').classList.add('dimmed');
  const botLabel = (game && game.botType === 'fishstick') ? 'Fishstick' : 'Bot';
  $('statWinner').textContent = stats.scores.human > stats.scores.bot ? 'You win' : stats.scores.bot > stats.scores.human ? botLabel + ' wins' : 'Draw';
  $('statScore').textContent = `${stats.scores.human}–${stats.scores.bot}`;
  $('statReason').textContent = sentence(stats.reason || '');
  const fmtMove = (d, v) => v >= 0 ? '+' + v : '' + v;
  $('eloMoveHuman').textContent = fmtMove(null, stats.eloDeltaHuman ?? 0);
  $('eloMoveHuman').className = 'elo-move ' + ((stats.eloDeltaHuman ?? 0) < 0 ? 'neg' : 'pos');
  $('eloMoveBot').textContent = fmtMove(null, stats.eloDeltaBot ?? 0);
  $('eloMoveBot').className = 'elo-move ' + ((stats.eloDeltaBot ?? 0) < 0 ? 'neg' : 'pos');
  const row = (label, h, b) => `<div class="stat-row"><span class="stat-label">${label}</span><span>${h}</span><span>${b}</span></div>`;
  const best = (x) => x.best ? `${x.best.word} (${x.best.score} pts)` : '—';
  const longest = (x) => x.longest ? `${x.longest.word} (${x.longest.word.length} letters)` : '—';
  const opt = (x) => `${x.optimal}/${x.total}`;
  const box = (name, pfp, st) => `<div class="stat-box"><div class="stat-box-head"><span class="pfp">${pfp}</span><span>${name}</span></div><div>Best word:<br><span class="stat-val">${best(st)}</span></div><div>Longest word:<br><span class="stat-val">${longest(st)}</span></div><div>Optimal moves: ${opt(st)}</div></div>`;
  const humanPfp = (() => { try { return pfpHTML(me); } catch { return ''; } })();
  const botPfpBox = game.botType === 'fishstick' ? '<img src="/assets/fishstick.jpeg" alt="Fishstick">' : '🤖';
  $('statGrid').innerHTML = box('You', humanPfp, stats.human) + box(botLabel, botPfpBox, stats.bot);
  if (game.botType === 'fishstick') $('statBotPfp').innerHTML = '<img src="/assets/fishstick.jpeg" alt="Fishstick">'; else $('statBotPfp').textContent = '🤖';
}
$('statWindow').addEventListener('click', e => { if (e.target === $('statWindow')) { clearStatDelay(); $('statWindow').classList.add('hidden'); $('gameDim').classList.remove('dimmed'); } });
function goHome() { clearStatDelay(); $('statWindow').classList.add('hidden'); show('homeScreen'); }
$('mainMenuBtn').onclick = goHome; $('statMainMenu').onclick = goHome;
$('playAgainBtn').onclick = () => { $('statWindow').classList.add('hidden'); startGame(currentBot); };
$('statPlayAgain').onclick = () => { $('statWindow').classList.add('hidden'); startGame(currentBot); };
$('gameStatsBtn').onclick = () => { if (game && game.stats) showStatWindow(game.stats); };
async function showDefinition(r, c) {
  // Find row and column words through this cell, fetch definitions for each.
  const words = [];
  const collect = (dr, dc) => {
    // Scan from the first letter of the word through to the last, in board
    // order. The old code unshifted the forward side and pushed the backward
    // side, which reversed every word (CAT read as TAC).
    let sr = r, sc = c;
    while (sr - dr >= 0 && sr - dr < 10 && sc - dc >= 0 && sc - dc < 10 && game.board[sr - dr][sc - dc]) { sr -= dr; sc -= dc; }
    const cells = [];
    let rr = sr, cc = sc;
    while (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && game.board[rr][cc]) { cells.push([rr, cc]); rr += dr; cc += dc; }
    if (cells.length >= 2) words.push(cells.map(([a, b]) => game.board[a][b]).join(''));
  };
  collect(0, 1); collect(1, 0);
  if (!words.length) return;
  const defs = [];
  for (const w of words) { try { const d = await api('/api/define?word=' + encodeURIComponent(w)); defs.push(`${w} ${d.pos ? '(' + d.pos + ') ' : ''}— ${d.definition}`); } catch {} }
  const pop = $('defPopover'); pop.innerHTML = defs.join('<br>'); pop.classList.remove('hidden');
  setTimeout(() => pop.classList.add('hidden'), 6000);
}
// Drag / tap handling.
// Root cause of bugs 2 and 3: the old code only ever dragged *within* the
// rack (reorder) and never dropped onto the board at all; and every rack
// tap called renderGame() in pointerup, which destroyed the tapped element
// before its click event could fire, so click-to-place selection never stuck.
function cellAtPoint(x, y) {
  const cells = [...document.querySelectorAll('#board .cell')];
  for (let i = 0; i < cells.length; i++) {
    const rect = cells[i].getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { row: Math.floor(i / 10), col: i % 10, el: cells[i] };
  }
  return null;
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
  const val = ({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter];
  ghost.innerHTML = `<span class="letter">${letter}</span><span class="val">${val}</span>`;
  ghost.classList.remove('hidden');
  ghost.style.left = x + 'px'; ghost.style.top = y + 'px';
}
function clearRackShift() { document.querySelectorAll('#rack .tile').forEach(t => { t.style.transform = ''; }); }
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
    el.style.opacity = '0.35';
    showGhost(game.humanRack[idx], e.clientX, e.clientY);
    clearDropHighlights();
    const hit = cellAtPoint(e.clientX, e.clientY);
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
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, captureId = null;
  const cleanup = () => {
    dragging = false; $('dragGhost').classList.add('hidden'); clearDropHighlights();
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
    clearDropHighlights();
    const hit = cellAtPoint(e.clientX, e.clientY);
    if (!hit) { drop = null; return; }
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
    if (myDrop) { if (!canPlaceTiles()) return; pend.row = myDrop.row; pend.col = myDrop.col; renderGame(); }
  });
  el.addEventListener('pointercancel', () => cleanup());
  el.addEventListener('lostpointercapture', () => cleanup());
}


// ---------- Startup: no login, just play ----------
(async () => {
  if (!token) {
    try { await ensureGuest(); } catch { /* game creation will retry with a fresh guest */ }
  }
  show('homeScreen');
})();
