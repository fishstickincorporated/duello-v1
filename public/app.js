// Duello v1 frontend. Server is the source of truth: every play is validated
// server-side; this client only renders state and sends placements.
let token = localStorage.getItem('duello_token') || '';
let me = null, game = null, gameFetchAt = 0;
let pending = []; // {row,col,letter,rackIndex}
let selectedRack = null, isSignup = true, armed = {}, currentBot = 'competitive';
const $ = id => document.getElementById(id);
const fmtClock = ms => { ms = Math.max(0, Math.ceil(ms / 1000) * 1000); const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return `${m}:${String(s).padStart(2, '0')}`; };
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function show(id) {
  ['authScreen', 'homeScreen', 'botScreen', 'gameScreen', 'friendsScreen', 'profileScreen', 'profileEditScreen'].forEach(s => { const el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
  const isMenu = ['homeScreen', 'botScreen', 'friendsScreen', 'profileScreen'].includes(id);
  $('tabBar').classList.toggle('hidden', !isMenu);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (id === 'homeScreen' || id === 'botScreen') $('tabHome').classList.add('active');
  if (id === 'friendsScreen') $('tabFriends').classList.add('active');
  if (id === 'profileScreen') $('tabProfile').classList.add('active');
  if (id === 'profileScreen') renderProfile();
  if (id === 'friendsScreen') renderFriends();
}
function silhouetteSVG(size) { return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="8" r="4" fill="#9aa3b2"/><path d="M4 21 C4 16 7 13 12 13 C17 13 20 16 20 21 Z" fill="#9aa3b2"/></svg>`; }
function pfpHTML(userLike) {
  if (userLike && userLike.photoData) return `<img src="${userLike.photoData}" alt="">`;
  return silhouetteSVG(36);
}
function goTab(id) { show(id); }
$('tabHome').onclick = () => show('homeScreen');
$('tabFriends').onclick = () => show('friendsScreen');
$('tabProfile').onclick = () => show('profileScreen');

async function loadMe() {
  try { const d = await api('/api/me'); me = d.user; return true; }
  catch { return false; }
}
$('authToggle').onclick = () => {
  isSignup = !isSignup;
  $('authHeading').textContent = isSignup ? 'Create an account' : 'Sign in';
  $('authSubmit').textContent = isSignup ? 'Sign Up' : 'Sign in';
  $('authToggle').textContent = isSignup ? 'Already have an account? Sign in' : "Don't have an account? Create an account";
  $('firstName').style.display = $('lastName').style.display = $('username').style.display = $('confirmPassword').style.display = isSignup ? '' : 'none';
  // iOS/Safari only offers to save the login when the form declares its
  // purpose: new-password for sign-up, current-password for sign-in.
  $('password').setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
  $('confirmPassword').setAttribute('autocomplete', 'new-password');
};
$('authToggle').click(); $('authToggle').click(); // start in sign-up mode with fields visible
$('authForm').onsubmit = async e => {
  e.preventDefault(); $('authError').textContent = '';
  try {
    if (isSignup) {
      if ($('password').value !== $('confirmPassword').value) throw new Error('Passwords do not match.');
      const d = await api('/api/signup', { method: 'POST', body: JSON.stringify({ email: $('email').value, firstName: $('firstName').value, lastName: $('lastName').value, username: $('username').value, password: $('password').value }) });
      token = d.token; localStorage.setItem('duello_token', token);
    } else {
      const d = await api('/api/signin', { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
      token = d.token; localStorage.setItem('duello_token', token);
    }
    await loadMe(); show('homeScreen');
  } catch (err) { $('authError').textContent = err.message; }
};
if ($('signOutBtn')) $('signOutBtn').onclick = async () => { try { await api('/api/signout', { method: 'POST' }); } catch {} token = ''; localStorage.removeItem('duello_token'); show('authScreen'); };
$('playBotsBtn').onclick = () => show('botScreen');
$('botBackBtn').onclick = () => show('homeScreen');
$('competitiveBtn').onclick = () => startGame('competitive');
$('fishstickBtn').onclick = () => startGame('fishstick');
async function startGame(bot) {
  currentBot = bot; botTurnTapTime = Date.now();
  game = await api('/api/games', { method: 'POST', body: JSON.stringify({ bot }) });
  gameFetchAt = Date.now(); pending = []; selectedRack = null; armed = {};
  show('gameScreen'); renderGame(); beginBotTurn();
}
function boardCell(r, c) { return game.board[r][c]; }
function renderGame() {
  if (!game) return;
  $('playerName').textContent = me ? me.firstName : 'You';
  try { document.querySelector('.player-side .pfp').innerHTML = pfpHTML(me); document.querySelector('.stat-pfp .pfp').innerHTML = pfpHTML(me); } catch {}
  $('playerElo').textContent = me ? me.elo : game.player.elo;
  const isFish = game.botType === 'fishstick';
  $('botName').textContent = isFish ? 'Fishstick' : 'Competitive Bot';
  $('botElo').textContent = isFish ? '∞' : game.botElo;
  if (isFish) $('botPfp').innerHTML = '<img src="/assets/fishstick.jpeg" alt="Fishstick">'; else $('botPfp').textContent = '🤖';
  document.querySelector('.player-side').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'human');
  document.querySelector('.bot-side').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'bot');
  $('scoreHuman').textContent = game.scores.human; $('scoreBot').textContent = game.scores.bot;
  const lastHtml = (l) => !l ? '—' : l.passed ? 'passed' : `${l.word}<br><span class="pts">+${l.points} pts${l.bingo ? ' · bingo +30' : ''}${l.isDuello ? ' · Duello +30' : ''}</span>`;
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
      t.innerHTML = `${letter}<span class="val">${({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter]}</span>`;
      if (pend) enablePlacedDrag(t, pend);
      else t.onclick = () => showDefinition(r, c);
      cell.appendChild(t);
    } else {
      cell.onclick = () => { if (suppressNextClick) { suppressNextClick = false; return; } if (selectedRack !== null) placeTile(r, c); };
    }
    boardEl.appendChild(cell);
  }
  // Rack
  const rackEl = $('rack'); rackEl.innerHTML = '';
  rackEl.classList.toggle('greyed', game.clocks.turn !== 'human' && game.status === 'active');
  game.humanRack.forEach((letter, idx) => {
    if (pending.some(p => p.rackIndex === idx)) { const s = document.createElement('div'); s.style.flex = '1'; rackEl.appendChild(s); return; }
    const t = document.createElement('div'); t.className = 'tile'; t.dataset.idx = idx;
    t.innerHTML = `${letter}<span class="val">${({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter]}</span>`;
    if (selectedRack === idx) t.style.outline = '2px solid #ffd166';
    enableRackDrag(t, idx);
    rackEl.appendChild(t);
  });
  // Controls / end state
  const finished = game.status === 'finished';
  document.querySelector('.controls').classList.toggle('hidden', finished);
  $('endButtons').classList.toggle('hidden', !finished);
  $('gameDim').classList.toggle('dimmed', finished && !$('statWindow').classList.contains('hidden'));
  if (finished && game.stats) showStatWindow(game.stats);
  tickClocks();
  updateStatus();
}
let runoffUntil = 0, timeoutFetching = false, timeoutLastAttempt = 0;
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
  const elapsed = Date.now() - gameFetchAt;
  let h = game.clocks.human, b = game.clocks.bot;
  if (game.status === 'active') {
    if (game.clocks.turn === 'human') h = Math.max(0, h - elapsed); else b = Math.max(0, b - elapsed);
  }
  $('clockHuman').textContent = fmtClock(h);
  // During a runoff animation the bot clock is driven by the animation,
  // not by this 100ms tick — the tick used to jump it straight to the
  // stepped value and flicker over the animation.
  if (Date.now() >= runoffUntil) $('clockBot').textContent = fmtClock(b);
  // Human clock hit 0: do not leave the game sitting on a dead turn.
  // Fetching flips the server to the bot turn, which then loops on its own.
  if (game.status === 'active' && game.clocks.turn === 'human' && h <= 0 && !timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleHumanTimeout();
}
setInterval(tickClocks, 100);

let botTimer = null, suppressNextClick = false, botTurnTapTime = 0;
function parseClockText(txt) { const m = /^([0-9]+):([0-9]{2})$/.exec((txt || '').trim()); return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 : null; }
function animateClockRunoff(fromMs, toMs) {
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
async function pollBotTurn() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  try {
    const fromMs = parseClockText($('clockBot').textContent);
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
  } catch { /* keep waiting state; a later action / reload will advance it */ }
}
function beginBotTurn() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  $('status').textContent = 'Bot thinking…';
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

let validateInFlight = null, lastValidate = null, playInFlight = false;
async function updateStatus() {
  if (!game) return;
  if (game.status === 'finished') { $('status').textContent = game.reason || 'Game over'; return; }
  if (game.clocks.turn !== 'human') { $('status').textContent = 'Waiting for your opponent…'; $('playBtn').disabled = true; $('playBtn').classList.remove('validating'); return; }
  if (!pending.length) { $('status').textContent = game.isFirst ? 'Your move — first word goes entirely inside the glowing 6×6.' : 'Your move'; $('playBtn').disabled = true; $('playBtn').classList.remove('validating'); lastValidate = null; return; }
  // While validation is in flight, Play stays clickable (blue, not green)
  // instead of greyed out: a tap on a greyed-out button is swallowed, so
  // users had to tap twice — once while it was still checking, once after
  // it turned green. The Play handler below waits for this check.
  $('playBtn').disabled = false; $('playBtn').classList.add('validating');
  try {
    // Guard against a stale validation overwriting the status: if the
    // player moved a tile while this request was in flight, its verdict
    // is about a board arrangement that no longer exists.
    const snapshot = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
    validateInFlight = api(`/api/games/${game.id}/validate`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
    const v = await validateInFlight;
    validateInFlight = null; lastValidate = v;
    if (JSON.stringify(pending.map(p => [p.row, p.col, p.letter])) !== snapshot) return;
    $('playBtn').classList.remove('validating');
    if (v.valid) { $('status').textContent = 'Play?'; $('playBtn').disabled = false; showBubble(v.score, v.mainCells); }
    else if (v.invalidWords && v.invalidWords.length) {
      const w = v.invalidWords;
      const list = w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
      $('status').textContent = w.length === 1 ? `${list} is not a word.` : `${list} are not words.`;
      $('playBtn').disabled = true; hideBubble();
    } else { $('status').textContent = v.error ? v.error.charAt(0).toUpperCase() + v.error.slice(1) + (v.error.endsWith('.') ? '' : '.') : 'Invalid play.'; $('playBtn').disabled = true; hideBubble(); }
  } catch { validateInFlight = null; $('playBtn').classList.remove('validating'); $('playBtn').disabled = true; }
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
  if (game.board[r][c]) return;
  if (pending.some(p => p.row === r && p.col === c)) return;
  const letter = game.humanRack[selectedRack];
  pending.push({ row: r, col: c, letter, rackIndex: selectedRack });
  selectedRack = null; renderGame();
}
function recallTile(pend) {
  pending = pending.filter(p => p !== pend); renderGame();
}
$('recallBtn').onclick = () => { pending = []; selectedRack = null; renderGame(); };
let shuffling = false;
$('shuffleBtn').onclick = async () => {
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
      t.style.transition = 'transform 220ms ease-in, opacity 220ms ease-in';
      t.style.transform = `translateX(${dx}px) scale(0.6)`;
      t.style.opacity = '0.6';
    });
  };
  fold([...rackEl.querySelectorAll('.tile')]);
  await new Promise(r => setTimeout(r, 230));
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
        t.style.transition = 'transform 260ms ease-out, opacity 260ms ease-out';
        t.style.transform = ''; t.style.opacity = '';
      });
      setTimeout(() => newTiles.forEach(t => { t.style.transition = ''; }), 300);
    }));
  } catch {
    // Shuffle failed server-side: unfold the original tiles back out.
    [...rackEl.querySelectorAll('.tile')].forEach(t => { t.style.transition = 'transform 220ms ease-out, opacity 220ms ease-out'; t.style.transform = ''; t.style.opacity = ''; });
  }
  shuffling = false;
};
function armButton(btn, label, fn) {
  return async () => {
    if (!armed[btn.id]) { armed[btn.id] = true; btn.textContent = 'SURE?'; setTimeout(() => { armed[btn.id] = false; btn.textContent = label; }, 3000); return; }
    armed[btn.id] = false; btn.textContent = label; await fn();
  };
}
$('passBtn').onclick = armButton($('passBtn'), 'Pass', async () => { botTurnTapTime = Date.now(); game = await api(`/api/games/${game.id}/pass`, { method: 'POST' }); gameFetchAt = Date.now(); pending = []; renderGame(); beginBotTurn(); });
$('forfeitBtn').onclick = armButton($('forfeitBtn'), 'Forfeit', async () => { game = await api(`/api/games/${game.id}/forfeit`, { method: 'POST' }); gameFetchAt = Date.now(); pending = []; renderGame(); });
$('playBtn').onclick = async () => {
  if (!pending.length || playInFlight) return;
  // Single tap: if validation is still in flight, wait for it instead of
  // requiring a second tap after Play turns green.
  if (validateInFlight) { try { await validateInFlight; } catch {} if (lastValidate && !lastValidate.valid) return; }
  if ($('playBtn').disabled) return;
  // Grey immediately on tap, so a second tap cannot double-submit.
  playInFlight = true; $('playBtn').disabled = true; $('playBtn').classList.remove('validating');
  $('status').textContent = 'Bot thinking…';
  try {
    botTurnTapTime = Date.now();
    game = await api(`/api/games/${game.id}/play`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
    gameFetchAt = Date.now(); pending = []; renderGame(); beginBotTurn(); loadMe();
  } catch (e) { $('status').textContent = e.message; renderGame(); }
  finally { playInFlight = false; }
};
function showStatWindow(stats) {
  const w = $('statWindow'); w.classList.remove('hidden');
  $('gameDim').classList.add('dimmed');
  $('statScore').textContent = `${stats.scores.human}–${stats.scores.bot}`;
  $('statReason').textContent = stats.reason || '';
  const fmtMove = (d, v) => v >= 0 ? '+' + v : '' + v;
  $('eloMoveHuman').textContent = fmtMove(null, stats.eloDeltaHuman ?? 0);
  $('eloMoveHuman').className = 'elo-move ' + ((stats.eloDeltaHuman ?? 0) < 0 ? 'neg' : 'pos');
  $('eloMoveBot').textContent = fmtMove(null, stats.eloDeltaBot ?? 0);
  $('eloMoveBot').className = 'elo-move ' + ((stats.eloDeltaBot ?? 0) < 0 ? 'neg' : 'pos');
  const row = (label, h, b) => `<div><b>${label}:</b><br>Human: ${h}<br>Bot: ${b}</div>`;
  const best = (x) => x.best ? `${x.best.word} (${x.best.score} pts)` : '—';
  const longest = (x) => x.longest ? `${x.longest.word} (${x.longest.word.length} letters)` : '—';
  const opt = (x) => `${x.optimal}/${x.total}` + (x.optimalWords && x.optimalWords.length ? ` (${x.optimalWords.join(', ')})` : '');
  $('statGrid').innerHTML = row('Best word', best(stats.human), best(stats.bot)) + row('Longest word', longest(stats.human), longest(stats.bot)) + row('Optimal moves', opt(stats.human), opt(stats.bot));
  if (game.botType === 'fishstick') $('statBotPfp').innerHTML = '<img src="/assets/fishstick.jpeg" alt="Fishstick">'; else $('statBotPfp').textContent = '🤖';
}
$('statWindow').addEventListener('click', e => { if (e.target === $('statWindow')) { $('statWindow').classList.add('hidden'); $('gameDim').classList.remove('dimmed'); } });
function goHome() { $('statWindow').classList.add('hidden'); show('homeScreen'); }
$('mainMenuBtn').onclick = goHome; $('statMainMenu').onclick = goHome;
$('playAgainBtn').onclick = () => { $('statWindow').classList.add('hidden'); startGame(currentBot); };
$('statPlayAgain').onclick = () => { $('statWindow').classList.add('hidden'); startGame(currentBot); };
$('gameStatsBtn').onclick = () => { if (game && game.stats) showStatWindow(game.stats); };
$('statGameStats').onclick = () => { if (game && game.stats) showStatWindow(game.stats); };
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
$('password').addEventListener('input', () => { $('passwordHint').classList.toggle('hidden', !$('password').value); });
$('profileSignOutBtn').onclick = async () => { try { await api('/api/signout', { method: 'POST' }); } catch {} token = ''; localStorage.removeItem('duello_token'); show('authScreen'); };
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
  ghost.innerHTML = `${letter}<span class="val">${val}</span>`;
  ghost.classList.remove('hidden');
  ghost.style.left = x + 'px'; ghost.style.top = y + 'px';
}
function enableRackDrag(el, idx) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, rackPreview = false;
  el.addEventListener('pointerdown', e => {
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null; rackPreview = false;
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
    if (!moved) return;
    suppressNextClick = true;
    el.style.opacity = '0.35';
    showGhost(game.humanRack[idx], e.clientX, e.clientY);
    clearDropHighlights();
    const hit = cellAtPoint(e.clientX, e.clientY);
    if (hit) {
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
      // Phone-app behaviour: as you drag over the deck, the other tiles
      // slide over to fill the gap and the dragged tile snaps into the
      // hovered slot live in the DOM (the data order is only committed on
      // drop, so a cancel restores the original order via renderGame).
      if (drop.hoverIdx !== idx) {
        const kids = [...rackEl.children];
        const at = kids.indexOf(el);
        if (at >= 0) {
          kids.splice(at, 1);
          kids.splice(Math.min(drop.hoverIdx, kids.length), 0, el);
          rackEl.append(...kids);
          rackPreview = true;
        }
      }
    } else drop = null;
  });
  el.addEventListener('pointerup', async e => {
    if (!dragging) return; dragging = false; el.style.opacity = ''; $('dragGhost').classList.add('hidden'); clearDropHighlights();
    if (!moved) {
      // Tap (not a drag): click-to-place selection. No re-render here — the
      // old code re-rendered on pointerup and killed the following click.
      selectedRack = (selectedRack === idx ? null : idx);
      [...$('rack').querySelectorAll('.tile')].forEach(t => t.style.outline = (Number(t.dataset.idx) === selectedRack ? '2px solid #ffd166' : ''));
      return;
    }
    if (drop && drop.kind === 'board') {
      selectedRack = idx;
      placeTile(drop.row, drop.col);
      return;
    }
    if (drop && drop.kind === 'rack' && drop.hoverIdx !== idx) {
      const rack = [...game.humanRack];
      const [tile] = rack.splice(idx, 1); rack.splice(drop.hoverIdx, 0, tile);
      try { game = await api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) }); gameFetchAt = Date.now(); } catch {}
      renderGame();
    } else if (rackPreview) {
      // Dropped elsewhere after a live preview: restore the original order.
      renderGame();
    }
    // Dropped elsewhere: cancel, keep the tile where it was.
  });
  el.addEventListener('pointercancel', () => { dragging = false; el.style.opacity = ''; $('dragGhost').classList.add('hidden'); clearDropHighlights(); if (rackPreview) renderGame(); });
}
// Drag a tile that is already placed on the board to a new cell.
// Tap (no movement) recalls it, exactly as before; a drag moves it.
function enablePlacedDrag(el, pend) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null;
  el.addEventListener('pointerdown', e => {
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null;
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
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
    if (!dragging) return; dragging = false; $('dragGhost').classList.add('hidden'); clearDropHighlights();
    if (!moved) { recallTile(pend); return; }
    if (drop) { pend.row = drop.row; pend.col = drop.col; renderGame(); }
  });
  el.addEventListener('pointercancel', () => { dragging = false; $('dragGhost').classList.add('hidden'); clearDropHighlights(); });
}

// ---------- Profile tab ----------
let profileData = null, chartRange = '1m', statsScope = 'aggregate', deleteMode = false, lbScope = 'friends';
async function renderProfile() {
  try {
    const d = await api('/api/me'); me = d.user; profileData = d;
    $('profilePfp').innerHTML = me.photoData ? `<img src="${me.photoData}" alt="">` : silhouetteSVG(44);
    $('profileName').textContent = `${me.firstName} ${me.lastName}`;
    $('profileUsername').textContent = '@' + me.username;
    const joined = new Date(me.createdAt + 'Z');
    $('profileJoined').textContent = 'Joined ' + (isNaN(joined) ? me.createdAt : joined.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
    $('profileElo').textContent = me.elo;
    $('profileEloHigh').textContent = me.eloHigh;
    const icon = document.getElementById('tabProfileIcon');
    if (icon) icon.innerHTML = me.photoData ? `<img src="${me.photoData}" alt="">` : `<svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="8" r="4" fill="#9aa3b2"/><path d="M4 21 C4 16 7 13 12 13 C17 13 20 16 20 21 Z" fill="#4da3ff" opacity="0.85"/></svg>`;
    renderStatsList(); drawEloChart();
  } catch {}
}
function renderStatsList() {
  if (!profileData || !profileData.profileStats) return;
  const st = profileData.profileStats[statsScope] || profileData.profileStats.aggregate;
  const lines = [
    ['Average game score', st.avgGameScore], ['Highest game score', st.highestGameScore],
    ['Average word score', st.avgWordScore], ['Highest word score', st.highestWordScore],
    ['Longest word', st.longestWord ? `${st.longestWord} (${st.longestWordLen} letters)` : '—'],
    ['Games played', st.gamesPlayed], ['Lifetime record', st.record || '0W-0L'],
    ['Optimal move %', st.optimalPct + '%'], ['Unique words played', st.uniqueWords],
  ];
  $('statsList').innerHTML = lines.map(([k, v]) => `<div class="stat-line"><span>${k}</span><b>${v}</b></div>`).join('');
}
document.querySelectorAll('.stats-tab').forEach(b => b.onclick = () => { statsScope = b.dataset.scope; document.querySelectorAll('.stats-tab').forEach(x => x.classList.toggle('active', x === b)); renderStatsList(); });
document.querySelectorAll('.chart-toggle').forEach(b => b.onclick = () => { chartRange = b.dataset.range; document.querySelectorAll('.chart-toggle').forEach(x => x.classList.toggle('active', x === b)); drawEloChart(); });
function drawEloChart() {
  const cv = $('eloChart'); if (!cv || !profileData) return;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  let hist = (profileData.stats && profileData.stats.eloHistory) || [];
  const now = Date.now();
  if (chartRange === '1m') hist = hist.filter(h => now - new Date(h.created_at + 'Z').getTime() < 30 * 24 * 3600 * 1000);
  if (chartRange === '1y') hist = hist.filter(h => now - new Date(h.created_at + 'Z').getTime() < 365 * 24 * 3600 * 1000);
  const pts = [1000, ...hist.map(h => h.elo_after)];
  if (pts.length < 2) { ctx.fillStyle = '#9aa3b2'; ctx.font = '13px Nunito'; ctx.fillText('No Elo history yet — play a game.', 12, 30); return; }
  const min = Math.min(...pts) - 20, max = Math.max(...pts) + 20;
  ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((v, i) => { const x = 10 + i * (cv.width - 20) / (pts.length - 1); const y = cv.height - 10 - ((v - min) / (max - min)) * (cv.height - 20); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
}
// Gear edit
$('gearBtn').onclick = () => {
  if (!me) return;
  $('editFirstName').value = me.firstName; $('editLastName').value = me.lastName; $('editUsername').value = me.username; $('editEmail').value = me.email;
  $('passwordChangeFields').classList.add('hidden'); $('editError').textContent = '';
  show('profileEditScreen');
};
$('editCancelBtn').onclick = () => show('profileScreen');
$('changePasswordBtn').onclick = () => $('passwordChangeFields').classList.toggle('hidden');
let pendingPhoto = undefined;
$('changePhotoBtn').onclick = () => $('photoInput').click();
$('photoInput').onchange = () => {
  const f = $('photoInput').files[0]; if (!f) return;
  const img = new Image(); const url = URL.createObjectURL(f);
  img.onload = () => {
    const size = 256; const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d'); const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    pendingPhoto = c.toDataURL('image/jpeg', 0.85); URL.revokeObjectURL(url);
  };
  img.src = url;
};
$('removePhotoBtn').onclick = () => { pendingPhoto = null; };
$('profileEditForm').onsubmit = async e => {
  e.preventDefault(); $('editError').textContent = '';
  try {
    const body = { firstName: $('editFirstName').value, lastName: $('editLastName').value, username: $('editUsername').value, email: $('editEmail').value };
    if (pendingPhoto !== undefined) body.photoData = pendingPhoto;
    const d = await api('/api/me/update', { method: 'POST', body: JSON.stringify(body) });
    me = d.user; pendingPhoto = undefined;
    if (!$('passwordChangeFields').classList.contains('hidden')) {
      if ($('newPassword').value !== $('confirmNewPassword').value) throw new Error('New passwords do not match.');
      if ($('newPassword').value) await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('currentPassword').value, new: $('newPassword').value }) });
    }
    show('profileScreen');
  } catch (err) { $('editError').textContent = err.message; }
};

// ---------- Friends tab ----------
async function renderFriends() {
  try {
    const lb = await api('/api/friends/leaderboard?scope=' + lbScope);
    const list = $('leaderboardList'); list.innerHTML = '';
    lb.rows.forEach(r => {
      const row = document.createElement('div'); row.className = 'lb-row' + (r.isYou ? ' you' : '');
      const pend = r.friendship === 'pending_out' || r.friendship === 'pending_in' ? '<span class="pending-label">Pending</span>' : '';
      const del = (deleteMode && lbScope === 'friends' && !r.isYou && r.friendship === 'accepted') ? `<button class="mini-btn grey" data-del="${r.id}">✕</button>` : '';
      row.innerHTML = `<span class="rank">${r.rank}</span><span class="lb-pfp">${pfpHTML(r)}</span><span><div class="lb-name">${r.firstName} ${r.lastName}</div><div class="lb-user">@${r.username}</div></span>${r.isYou ? '<span class="you-badge">YOU</span>' : ''}<span class="lb-elo">${pend || r.elo}</span>${del}`;
      list.appendChild(row);
    });
    list.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.del) }) }); renderFriends(); });
    $('noFriendsCard').classList.toggle('hidden', !(lbScope === 'friends' && lb.rows.filter(r => !r.isYou).length === 0));
    // Requests
    const fr = await api('/api/friends');
    const reqEl = $('friendRequests'); reqEl.innerHTML = '';
    fr.friends.filter(f => f.status === 'pending' && f.direction === 'in').forEach(f => {
      const row = document.createElement('div'); row.className = 'request-row';
      row.innerHTML = `<span>${pfpHTML(f)}</span><span><b>${f.firstName} ${f.lastName}</b> <span style="color:#9aa3b2">@${f.username}</span></span><span style="margin-left:auto;display:flex;gap:6px"><button class="mini-btn" data-acc="${f.id}">Accept</button><button class="mini-btn grey" data-dec="${f.id}">Decline</button></span>`;
      reqEl.appendChild(row);
    });
    reqEl.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.acc), accept: true }) }); renderFriends(); });
    reqEl.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.dec), accept: false }) }); renderFriends(); });
  } catch {}
}
$('lbFriendsTab').onclick = () => { lbScope = 'friends'; $('lbFriendsTab').classList.add('active'); $('lbGlobalTab').classList.remove('active'); renderFriends(); };
$('lbGlobalTab').onclick = () => { lbScope = 'global'; $('lbGlobalTab').classList.add('active'); $('lbFriendsTab').classList.remove('active'); renderFriends(); };
$('friendsPencil').onclick = () => { if (lbScope !== 'friends') return; deleteMode = !deleteMode; renderFriends(); };
let searchTimer = null;
$('friendSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('friendSearch').value.trim(); const el = $('friendSearchResults'); el.innerHTML = '';
    if (!q) return;
    try {
      const d = await api('/api/friends/search?q=' + encodeURIComponent(q));
      d.results.forEach(r => {
        const row = document.createElement('div'); row.className = 'search-result';
        const btn = r.friendship === 'accepted' ? '<span class="pending-label">Friend</span>' : r.friendship === 'pending_out' ? '<span class="pending-label">Pending</span>' : r.friendship === 'pending_in' ? '<span class="pending-label">Pending</span>' : `<button class="mini-btn" data-req="${r.id}">Add friend</button>`;
        row.innerHTML = `<span>${pfpHTML(r)}</span><span><b>${r.firstName} ${r.lastName}</b> <span style="color:#9aa3b2">@${r.username}</span></span><span style="margin-left:auto">${btn}</span>`;
        el.appendChild(row);
      });
      el.querySelectorAll('[data-req]').forEach(b => b.onclick = async () => { await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.req) }) }); b.outerHTML = '<span class="pending-label">Pending</span>'; });
    } catch {}
  }, 250);
});

(async () => { if (token && await loadMe()) show('homeScreen'); else show('authScreen'); })();
