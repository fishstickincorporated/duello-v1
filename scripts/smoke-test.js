// Smoke test against a RUNNING server (default http://localhost:3000).
// Usage:  node server.js  (in one terminal)
//         BASE=http://localhost:3456 node scripts/smoke-test.js
// Creates a fresh test account, starts a Competitive Bot game, finds a valid
// first move from the dealt rack via the /validate endpoint, plays it, then
// forfeits and checks that Elo moved and that ZA/JA have definitions.
const BASE = process.env.BASE || 'http://localhost:3000';
async function api(path, token, body) {
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}
(async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `smoke_${suffix}@example.com`;
  const username = `smoke_${suffix}`;
  const signup = await api('/api/signup', null, { email, firstName: 'Smoke', lastName: 'Test', username, password: 'testpass123' });
  console.log('signup elo:', signup.user.elo);
  if (signup.user.elo !== 1000) throw new Error('New account Elo is not 1000');
  const token = signup.token;
  const game = await api('/api/games', token, { bot: 'competitive' });
  console.log('game id:', game.id, 'bot:', game.botType, 'botElo:', game.botElo, 'turn:', game.clocks.turn, 'rack:', game.humanRack.join(''));
  if (game.botElo !== 1000) throw new Error('Competitive bot Elo is not player Elo');
  // Find a valid first move: try words formed from the rack, placed horizontally
  // starting at row 4, col 2 (inside the inner 6x6), using the words file via API only.
  // We brute-force via /validate with candidate placements built from rack letters.
  const rack = game.humanRack;
  let played = null;
  // Try all 2-6 letter strings that are rack subsets, in a fixed order, placed at row 4.
  const words = require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'words.txt'), 'utf8').split('\n').map(s => s.trim()).filter(w => w.length >= 2 && w.length <= 6);
  outer: for (const word of words) {
    // Can this word be formed from the rack? (first move: no board tiles, so all letters from rack)
    const cnt = {}; for (const l of rack) cnt[l] = (cnt[l] || 0) + 1;
    let ok = true; for (const l of word) { if (!cnt[l]) { ok = false; break; } cnt[l]--; }
    if (!ok) continue;
    for (let col = 2; col + word.length - 1 <= 7; col++) {
      const placements = [...word].map((letter, i) => ({ row: 4, col: col + i, letter }));
      const v = await api(`/api/games/${game.id}/validate`, token, { placements });
      if (v.valid) { played = { word, placements, score: v.score }; break outer; }
    }
  }
  if (!played) { console.log('No first move found from this rack — forfeiting instead'); }
  else {
    console.log('playing first move:', played.word, 'score:', played.score);
    const after = await api(`/api/games/${game.id}/play`, token, { placements: played.placements });
    console.log('after play: human score', after.scores.human, 'bot score', after.scores.bot, 'lastWord', after.lastWord, 'bot last', after.lastBot);
  }
  const forfeited = await api(`/api/games/${game.id}/forfeit`, token, {});
  console.log('forfeit: status', forfeited.status, 'reason', forfeited.reason, 'eloDeltaHuman', forfeited.eloDeltaHuman, 'eloAfterHuman', forfeited.eloAfterHuman);
  const me = await api('/api/me', token);
  console.log('me after forfeit: elo', me.user.elo, 'stats', me.stats.played, me.stats.wins, me.stats.losses);
  if (me.user.elo === 1000) throw new Error('Elo did not move after forfeit loss');
  for (const w of ['ZA', 'JA', 'QI', 'ZEN', 'DUELLO']) {
    const d = await api(`/api/define?word=${w}`, token);
    console.log('define', w, '->', d.pos, d.definition);
    if (!d.definition) throw new Error('No definition for ' + w);
  }
  console.log('SMOKE OK');
})().catch(e => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
