// Smoke test for the Duello bot-play slice (Postgres, no login).
// Against a RUNNING server (default http://localhost:3460).
// Usage:  DATABASE_URL=postgres://... node server.js  (in one terminal)
//         BASE=http://localhost:3460 node scripts/smoke-test-botplay.js
// Creates a guest, starts a Competitive Bot game, finds a valid first
// move from the dealt rack via /validate, plays it, forfeits and checks
// Elo moved, then reuses the SAME token for a second game and checks
// the guest Elo carried over and the old game still loads. Also checks
// pass on a fresh game, and ZA/JA/DUELLO definitions.
const BASE = process.env.BASE || 'http://localhost:3460';
async function api(path, token, body) {
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function findFirstMove(game, token) {
  const fs = require('fs'), path = require('path');
  const words = fs.readFileSync(path.join(__dirname, '..', 'data', 'words.txt'), 'utf8').split('\n').map(s => s.trim()).filter(w => w.length >= 2 && w.length <= 6);
  const rack = game.humanRack;
  for (const word of words) {
    const cnt = {}; for (const l of rack) cnt[l] = (cnt[l] || 0) + 1;
    let ok = true; for (const l of word) { if (!cnt[l]) { ok = false; break; } cnt[l]--; }
    if (!ok) continue;
    for (let col = 2; col + word.length - 1 <= 7; col++) {
      const placements = [...word].map((letter, i) => ({ row: 4, col: col + i, letter }));
      const v = await api(`/api/games/${game.id}/validate`, token, { placements });
      if (v.valid) return { word, placements, score: v.score };
    }
  }
  return null;
}
(async () => {
  const guest = await api('/api/guest', null, {});
  console.log('guest:', guest.user.username, 'elo:', guest.user.elo);
  if (!guest.user.username.startsWith('guest_')) throw new Error('Guest username does not start with guest_');
  if (guest.user.elo !== 1000) throw new Error('New guest Elo is not 1000');
  const token = guest.token;
  if (!token) throw new Error('No guest token');
  // Find a human-first game for the first-move test: the move finder
  // below assumes an empty board, so bot-first games (where the bot
  // moves before the human's first turn) are abandoned, not forfeited,
  // and a fresh game is created. Human-first is a coin flip per game.
  let game = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const g = await api('/api/games', token, { bot: 'competitive' });
    console.log('candidate game id:', g.id, 'turn:', g.clocks.turn, 'rack:', g.humanRack.join(''));
    if (g.clocks.turn === 'human') { game = g; break; }
  }
  if (!game) throw new Error('No human-first game in 6 attempts');
  console.log('game id:', game.id, 'bot:', game.botType, 'botElo:', game.botElo, 'turn:', game.clocks.turn, 'rack:', game.humanRack.join(''));
  if (game.botElo !== 1000) throw new Error('Competitive bot Elo is not guest Elo');
  const played = await findFirstMove(game, token);
  if (!played) throw new Error('No first move found from this rack');
  console.log('playing first move:', played.word, 'score:', played.score);
  const after = await api(`/api/games/${game.id}/play`, token, { placements: played.placements });
  console.log('after play: human score', after.scores.human, 'bot score', after.scores.bot, 'lastWord', after.lastWord, 'turn', after.clocks.turn);
  if (after.scores.human !== played.score) throw new Error('Human score after play does not match validate score');
  if (after.clocks.turn !== 'bot') throw new Error('Turn did not switch to bot after play');
  const forfeited = await api(`/api/games/${game.id}/forfeit`, token, {});
  console.log('forfeit: status', forfeited.status, 'reason', forfeited.reason, 'eloDeltaHuman', forfeited.eloDeltaHuman, 'eloAfterHuman', forfeited.eloAfterHuman);
  if (forfeited.status !== 'finished') throw new Error('Forfeit did not finish game');
  if (forfeited.eloAfterHuman === 1000) throw new Error('Elo did not move after forfeit loss');
  const eloAfter = forfeited.eloAfterHuman;
  // Second load, SAME token: new game must carry the same guest Elo, and
  // the old (finished) game must still load for that guest.
  const game2 = await api('/api/games', token, { bot: 'competitive' });
  console.log('second game id:', game2.id, 'player elo:', game2.player.elo, 'expected:', eloAfter);
  if (game2.player.elo !== eloAfter) throw new Error('Second game Elo does not match guest Elo after forfeit');
  const oldGame = await api(`/api/games/${game.id}`, token);
  console.log('old game reload: status', oldGame.status, 'scores', oldGame.scores.human, '-', oldGame.scores.bot);
  if (oldGame.status !== 'finished') throw new Error('Old game did not reload as finished');
  // Pass on the second game, once it is the human turn.
  let g2 = game2;
  for (let i = 0; i < 30 && g2.clocks.turn !== 'human'; i++) { await sleep(500); g2 = await api(`/api/games/${g2.id}`, token); }
  if (g2.clocks.turn === 'human') {
    const passed = await api(`/api/games/${g2.id}/pass`, token, {});
    console.log('pass: turn', passed.clocks.turn, 'lastHuman', JSON.stringify(passed.lastHuman));
    if (passed.clocks.turn !== 'bot') throw new Error('Turn did not switch to bot after pass');
    if (!passed.lastHuman || !passed.lastHuman.passed) throw new Error('Pass did not record lastHuman.passed');
  } else {
    console.log('pass test skipped: second game never reached human turn in poll window, turn=', g2.clocks.turn);
  }
  for (const w of ['ZA', 'JA', 'QI', 'ZEN', 'DUELLO']) {
    const d = await api(`/api/define?word=${w}`, token);
    console.log('define', w, '->', d.pos, d.definition);
    if (!d.definition) throw new Error('No definition for ' + w);
  }
  // Out-of-scope endpoints must be gone in this slice.
  for (const p of ['/api/me', '/api/friends']) {
    const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } });
    console.log('out-of-scope', p, '->', r.status, '(expect 404)');
    if (r.status !== 404) throw new Error('Out-of-scope endpoint still present: ' + p);
  }
  console.log('SMOKE OK');
})().catch(e => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
