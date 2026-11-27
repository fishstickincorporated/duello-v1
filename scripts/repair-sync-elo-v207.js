// Repair for the v207 sync-Elo hole (Jeff, Nov 27, 2026).
//
// THE BUG: POST /api/games/sync's duplicate path assumed "game row
// exists = Elo applied". When a first sync attempt died between the
// game INSERT and the Elo UPDATE, the retry got a clean 200, the
// client deleted the outbox record, and the delta was lost forever
// while the game looked normal in History. (Jeff's two Doppelganger
// wins ~1:55-2:02 PM Nov 27: rows in History, Elo still 1208. The
// Render logs for that window are clean — no deploy, no crash, no
// 500 — so the trigger was a silent hiccup on the first save, most
// likely a hung query: q() is a bare pool.query with no statement
// timeout.) v207 fixes the server so a retry reconciles against
// the elo_history ledger — but the client already deleted the
// outbox records for those two games, so no future sync will
// reconcile them. This script repairs them (and any other game in
// the same state).
//
// WHAT IT TOUCHES (and only this):
//   * finished COMPETITIVE games that were synced offline
//     (client_game_id IS NOT NULL) and have NO elo_history row
//     for (user_id, game_id) — the exact signature of the hole.
//     Fishstick games are excluded by design (delta 0, no ledger
//     row ever). Online (endGame) games are excluded: their Elo
//     is applied in endGame, not in sync.
//   * for each such game, it applies the stored delta ONCE:
//     UPDATE users (elo += delta), INSERT elo_history, and patches
//     the stored state (eloAfterHuman/eloAfterBot/botElo plus the
//     v207 eloBefore snapshot). It never deletes anything, never
//     touches any other game, and never recomputes a delta — the
//     stored delta is a property of the game (v105 design).
//
// SAFETY:
//   * DRY RUN BY DEFAULT: prints exactly what it would do and
//     changes nothing. Pass --apply to write.
//   * Cross-checks each game before applying: the stored delta
//     must equal the Elo formula recomputed from the stored state
//     (winner + playerEloAtStart derived as eloAfterHuman -
//     eloDeltaHuman + botEloStart derived as eloAfterBot +
//     eloDeltaHuman), and the competitive invariant
//     (botEloStart == playerEloAtStart) must hold. A game that
//     fails any check is printed as NEEDS-REVIEW and skipped.
//   * Idempotent: each apply re-checks the ledger inside a
//     transaction, so re-running it (or running it while a v207
//     retry reconciles the same game) cannot double-apply.
//   * The per-game apply is one transaction: users UPDATE +
//     ledger INSERT + state patch commit together or not at all.
//
// HOW TO RUN (Render shell — the production database):
//   1. Dry run first, for Jeff's account (@ceo):
//        DATABASE_URL=$DATABASE_URL node scripts/repair-sync-elo-v207.js --user ceo
//      (no --apply: prints the candidates, the deltas, and the
//      Elo each would produce. This is also the DIAGNOSTIC: if it
//      finds the two wins with +16 each, the hole is confirmed and
//      +32 is owed (1208 -> 1240). If it finds NOTHING, the Elo
//      WAS applied and something else moved him back — do not
//      apply anything, investigate the elo_history trail instead.)
//   2. If the dry run shows exactly the expected games, apply:
//        DATABASE_URL=$DATABASE_URL node scripts/repair-sync-elo-v207.js --user ceo --apply
//   3. Re-run the dry run to confirm zero candidates remain, and
//      check /api/me (or the admin export) shows @ceo at 1240.
//   Omit --user to scan ALL users (same dry-run-then-apply flow).
//
// DO NOT run this against a database that has not been migrated
// to v207 — it is harmless there (it only reads/writes the same
// rows the v207 reconcile would), but the v207 server is what
// stops the hole from recurring.
const { Pool } = require('pg');

function eloDelta(playerElo, oppElo, actual) {
  const expected = 1 / (1 + Math.pow(10, (oppElo - playerElo) / 400));
  return Math.round(32 * (actual - expected));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userArg = (args[args.indexOf('--user') + 1] || null);
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL is required.'); process.exit(2); }
  const pool = new Pool({ connectionString: dbUrl });
  try {
    let userFilter = '';
    const params = [];
    if (userArg) {
      const u = await pool.query('SELECT id, username, elo FROM users WHERE username=$1 OR id::text=$1', [userArg]);
      if (!u.rows[0]) { console.error(`No user found for ${JSON.stringify(userArg)}.`); process.exit(2); }
      console.log(`User: @${u.rows[0].username} (id ${u.rows[0].id}) — current Elo ${u.rows[0].elo}`);
      userFilter = ' AND g.user_id=$1';
      params.push(u.rows[0].id);
    }
    // The hole's exact signature: a finished competitive game that
    // arrived via offline sync (client_game_id set) with no ledger
    // row. A normal synced game has exactly one ledger row; a
    // Fishstick game has none by design (excluded by bot_type).
    const cands = await pool.query(
      `SELECT g.id, g.user_id, g.bot_type, g.state, g.client_game_id, g.created_at, u.username, u.elo AS user_elo
       FROM games g JOIN users u ON u.id = g.user_id
       WHERE g.bot_type = 'competitive' AND g.client_game_id IS NOT NULL
         AND g.state->>'status' = 'finished'
         AND NOT EXISTS (SELECT 1 FROM elo_history h WHERE h.user_id = g.user_id AND h.game_id = g.id)
         ${userFilter}
       ORDER BY g.created_at`,
      params,
    );
    console.log(`Candidates: ${cands.rows.length} finished competitive synced game(s) with no elo_history row.`);
    let applied = 0;
    let skipped = 0;
    let needsReview = 0;
    for (const row of cands.rows) {
      const st = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
      const delta = st.eloDeltaHuman;
      const afterH = st.eloAfterHuman;
      const afterB = st.eloAfterBot;
      const actual = st.winner === 'human' ? 1 : st.winner === 'bot' ? 0 : 0.5;
      const problems = [];
      if (!Number.isFinite(delta)) problems.push('eloDeltaHuman is not a finite number');
      if (!Number.isFinite(afterH)) problems.push('eloAfterHuman is not a finite number');
      if (!Number.isFinite(afterB)) problems.push('eloAfterBot is not a finite number');
      let startHuman = null;
      let startBot = null;
      let expected = null;
      if (!problems.length) {
        startHuman = afterH - delta;
        startBot = afterB + delta;
        expected = eloDelta(startHuman, startBot, actual);
        if (startHuman !== startBot) problems.push(`competitive invariant broken: playerEloAtStart ${startHuman} != botEloStart ${startBot}`);
        if (expected !== delta) problems.push(`stored delta ${delta} != recomputed delta ${expected} (winner ${st.winner}, start ${startHuman} vs ${startBot})`);
      }
      const label = `game ${row.id} (@${row.username}, ${row.created_at}, client_game_id ${row.client_game_id}, scores ${st.scores && st.scores.human}-${st.scores && st.scores.bot}, winner ${st.winner})`;
      if (problems.length) {
        needsReview++;
        console.log(`NEEDS-REVIEW ${label}: ${problems.join('; ')} — skipped, apply nothing for this game.`);
        continue;
      }
      const newElo = row.user_elo + delta;
      if (!apply) {
        console.log(`WOULD-APPLY ${label}: delta ${delta > 0 ? '+' : ''}${delta} (start ${startHuman}) — user Elo ${row.user_elo} -> ${newElo}.`);
        applied++;
        continue;
      }
      // Idempotent apply: re-check the ledger inside the transaction
      // (a v207 retry may have reconciled it since the scan).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const led = await client.query('SELECT id FROM elo_history WHERE user_id=$1 AND game_id=$2', [row.user_id, row.id]);
        if (led.rows[0]) {
          await client.query('COMMIT');
          skipped++;
          console.log(`SKIPPED ${label}: a ledger row appeared since the scan (already applied).`);
          continue;
        }
        const eloRow = await client.query('UPDATE users SET elo = elo + $1, elo_high = GREATEST(elo_high, elo + $1) WHERE id = $2 RETURNING elo', [delta, row.user_id]);
        const confirmedElo = Number(eloRow.rows[0].elo);
        st.id = row.id;
        st.eloDeltaHuman = delta;
        st.eloDeltaBot = -delta;
        st.eloAfterHuman = confirmedElo;
        st.eloAfterBot = startBot - delta;
        st.eloBeforeHuman = startHuman;
        st.eloBeforeBot = startBot;
        st.botElo = startBot - delta;
        await client.query('UPDATE games SET state=$1::jsonb WHERE id=$2', [JSON.stringify(st), row.id]);
        await client.query('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [row.user_id, row.id, confirmedElo, delta]);
        await client.query('COMMIT');
        applied++;
        console.log(`APPLIED ${label}: delta ${delta > 0 ? '+' : ''}${delta} — user Elo ${row.user_elo} -> ${confirmedElo}.`);
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      } finally { client.release(); }
    }
    console.log(`Done. ${apply ? 'applied' : 'would apply'}: ${applied}; skipped (ledger appeared): ${skipped}; needs-review: ${needsReview}.`);
    if (!apply && cands.rows.length) console.log('Dry run — nothing was changed. Re-run with --apply to write.');
    if (apply && applied) console.log('Re-run the dry run to confirm zero candidates remain.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
