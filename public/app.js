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
  currentBot = bot;
  game = await api('/api/games', { method: 'POST', body: JSON.stringify({ bot }) });
  gameFetchAt = Date.now(); pending = []; selectedRack = null; armed = {};
  show('gameScreen'); renderGame();
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
    if (!boardCell(r, c) && !prem) cell.textContent = '';
    else if (!boardCell(r, c)) cell.textContent = prem;
    const pend = pending.find(p => p.row === r && p.col === c);
    const letter = boardCell(r, c) || (pend ? pend.letter : null);
    if (letter) {
      const t = document.createElement('div'); t.className = 'tile' + (pend ? ' pending' : '');
      t.innerHTML = `${letter}<span class="val">${({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter]}</span>`;
      if (pend) t.onclick = () => recallTile(pend);
      else t.onclick = () => showDefinition(r, c);
      cell.appendChild(t);
    } else {
      cell.onclick = () => { if (selectedRack !== null) placeTile(r, c); };
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
    t.onclick = () => { selectedRack = idx; [...rackEl.children].forEach(ch => ch.style.outline = ''); t.style.outline = '2px solid #ffd166'; };
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
function tickClocks() {
  if (!game) return;
  const elapsed = Date.now() - gameFetchAt;
  let h = game.clocks.human, b = game.clocks.bot;
  if (game.status === 'active') {
    if (game.clocks.turn === 'human') h = Math.max(0, h - elapsed); else b = Math.max(0, b - elapsed);
  }
  $('clockHuman').textContent = fmtClock(h); $('clockBot').textContent = fmtClock(b);
}
setInterval(tickClocks, 100);
async function updateStatus() {
  if (!game) return;
  if (game.status === 'finished') { $('status').textContent = game.reason || 'Game over'; return; }
  if (game.clocks.turn !== 'human') { $('status').textContent = 'Waiting for your opponent…'; $('playBtn').disabled = true; return; }
  if (!pending.length) { $('status').textContent = game.isFirst ? 'Your move — first word goes entirely inside the glowing 6×6.' : 'Your move'; $('playBtn').disabled = true; return; }
  try {
    const v = await api(`/api/games/${game.id}/validate`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
    if (v.valid) { $('status').textContent = 'Play?'; $('playBtn').disabled = false; showBubble(v.score); }
    else if (v.invalidWords && v.invalidWords.length) {
      const w = v.invalidWords;
      const list = w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
      $('status').textContent = w.length === 1 ? `${list} is not a word.` : `${list} are not words.`;
      $('playBtn').disabled = true; hideBubble();
    } else { $('status').textContent = v.error ? v.error.charAt(0).toUpperCase() + v.error.slice(1) + (v.error.endsWith('.') ? '' : '.') : 'Invalid play.'; $('playBtn').disabled = true; hideBubble(); }
  } catch { $('playBtn').disabled = true; }
}
function showBubble(score) {
  hideBubble();
  if (!pending.length) return;
  const last = pending[pending.length - 1];
  const cells = document.querySelectorAll('#board .cell');
  const cell = cells[last.row * 10 + last.col];
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
$('shuffleBtn').onclick = async () => {
  const rack = [...game.humanRack];
  for (let i = rack.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rack[i], rack[j]] = [rack[j], rack[i]]; }
  try { game = await api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) }); gameFetchAt = Date.now(); renderGame(); } catch {}
};
function armButton(btn, label, fn) {
  return async () => {
    if (!armed[btn.id]) { armed[btn.id] = true; btn.textContent = 'SURE?'; setTimeout(() => { armed[btn.id] = false; btn.textContent = label; }, 3000); return; }
    armed[btn.id] = false; btn.textContent = label; await fn();
  };
}
$('passBtn').onclick = armButton($('passBtn'), 'Pass', async () => { game = await api(`/api/games/${game.id}/pass`, { method: 'POST' }); gameFetchAt = Date.now(); pending = []; renderGame(); });
$('forfeitBtn').onclick = armButton($('forfeitBtn'), 'Forfeit', async () => { game = await api(`/api/games/${game.id}/forfeit`, { method: 'POST' }); gameFetchAt = Date.now(); pending = []; renderGame(); });
$('playBtn').onclick = async () => {
  if (!pending.length) return;
  $('status').textContent = 'Bot thinking…';
  await new Promise(r => setTimeout(r, 700));
  try {
    game = await api(`/api/games/${game.id}/play`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
    gameFetchAt = Date.now(); pending = []; await loadMe(); renderGame();
  } catch (e) { $('status').textContent = e.message; }
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
    let cells = [[r, c]]; let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && game.board[rr][cc]) { cells.unshift([rr, cc]); rr += dr; cc += dc; }
    rr = r - dr; cc = c - dc;
    while (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && game.board[rr][cc]) { cells.push([rr, cc]); rr -= dr; cc -= dc; }
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
// Rack drag-reorder with sliding: as you drag over another tile, the other
// tiles slide to an available position (phone app-icon style).
function enableRackDrag(el, idx) {
  let dragging = false, startX = 0, hoverIdx = idx;
  const ghost = $('dragGhost');
  el.addEventListener('pointerdown', e => { dragging = true; startX = e.clientX; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    ghost.textContent = game.humanRack[idx]; ghost.classList.remove('hidden');
    ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
    const rackEl = $('rack');
    const rect = rackEl.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
    hoverIdx = Math.max(0, Math.min(5, Math.floor(rel * 6)));
    // Visual slide: reorder rack tiles in the DOM to preview the hover slot.
    const tiles = [...rackEl.querySelectorAll('.tile')];
    tiles.forEach((t, i) => { t.style.transform = ''; });
    // Simple preview: highlight the hover slot tile.
    tiles.forEach(t => t.style.outline = '');
    const target = tiles.find(t => Number(t.dataset.idx) === hoverIdx);
    if (target) target.style.outline = '2px dashed #ffd166';
  });
  el.addEventListener('pointerup', async e => {
    if (!dragging) return; dragging = false; ghost.classList.add('hidden');
    if (hoverIdx !== idx) {
      const rack = [...game.humanRack];
      const [tile] = rack.splice(idx, 1); rack.splice(hoverIdx, 0, tile);
      try { game = await api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) }); gameFetchAt = Date.now(); } catch {}
    }
    renderGame();
  });
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
