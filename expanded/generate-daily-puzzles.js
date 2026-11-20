// Generate a batch of Daily Puzzles (one per day) and write them into
// public/daily-puzzles.json, preserving the entries already there.
//   node expanded/generate-daily-puzzles.js [start YYYY-MM-DD] [days]
// The generator builds a small crossword-style board (a spine word plus
// 2-4 crossing words, every 2+ run a dictionary word), draws a rack,
// and keeps the puzzle only when the Fishstick engine says the optimal
// play is a clean bingo: all 6 rack tiles, a 6-letter COMMON word with
// no Q/Z/J/X/K, at least one cross word, and 8+ points clear of the
// runner-up. Premiums are the engine's own makePremiums layout, kept
// off the board tiles and off the optimal play (so the optimal score
// is the no-premium score), and the margin is re-checked with the
// premiums attached. A seeded RNG (mulberry32, seeded by the date)
// makes the batch reproducible; a day that fails its attempts is
// reported, not shipped.
const fs = require('fs');
const path = require('path');
const { createEngine } = require('../public/engine.js');

const WORDS = new Set();
for (const line of fs.readFileSync(path.join(__dirname, '..', 'data', 'words.txt'), 'utf8').split('\n')) {
  const w = line.trim();
  if (w) WORDS.add(w);
}
const eng = createEngine(WORDS);
const { COMMON_WORDS, VOWELS, emptyBoard, makePremiums, drawLetter, findMoves, validatePlay, wordAt } = eng;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromDate(dateKey) {
  let h = 2166136261;
  for (const ch of dateKey) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// All runs of 2+ letters on the board must be dictionary words.
function boardRunsValid(board) {
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    if (!board[r][c]) continue;
    if (c === 0 || !board[r][c - 1]) {
      let w = '', cc = c;
      while (cc < 10 && board[r][cc]) { w += board[r][cc]; cc++; }
      if (w.length >= 2 && !WORDS.has(w)) return false;
    }
    if (r === 0 || !board[r - 1][c]) {
      let w = '', rr = r;
      while (rr < 10 && board[rr][c]) { w += board[rr][c]; rr++; }
      if (w.length >= 2 && !WORDS.has(w)) return false;
    }
  }
  return true;
}
function boardWords(board) {
  const out = new Set();
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    if (!board[r][c]) continue;
    if (c === 0 || !board[r][c - 1]) {
      let w = '', cc = c;
      while (cc < 10 && board[r][cc]) { w += board[r][cc]; cc++; }
      if (w.length >= 2) out.add(w);
    }
    if (r === 0 || !board[r - 1][c]) {
      let w = '', rr = r;
      while (rr < 10 && board[rr][c]) { w += board[rr][c]; rr++; }
      if (w.length >= 2) out.add(w);
    }
  }
  return [...out].sort();
}
// Can `word` go at (r, c) in direction dir ('H'|'V')? Strict crossword
// rule: every cell is empty or the same letter, at least one crossing
// (unless first), no parallel adjacency on empty cells, maximal span.
function canPlace(board, word, r, c, dir, first) {
  let crossings = 0;
  for (let i = 0; i < word.length; i++) {
    const rr = dir === 'H' ? r : r + i, cc = dir === 'H' ? c + i : c;
    if (rr < 0 || rr > 9 || cc < 0 || cc > 9) return false;
    if (board[rr][cc]) {
      if (board[rr][cc] !== word[i]) return false;
      crossings++;
    } else if (!first) {
      // A fresh tile must not touch a tile orthogonally in the
      // perpendicular direction (that would make an unintended word).
      const nr = dir === 'H' ? rr - 1 : rr, nc = dir === 'H' ? cc : cc - 1;
      const nr2 = dir === 'H' ? rr + 1 : rr, nc2 = dir === 'H' ? cc : cc + 1;
      if ((nr >= 0 && board[nr][nc]) || (nr2 < 10 && board[nr2][nc2])) return false;
    }
  }
  if (!first && crossings === 0) return false;
  // Maximal span: the cells just outside the word must be empty.
  const br = dir === 'H' ? r : r - 1, bc = dir === 'H' ? c - 1 : c;
  const ar = dir === 'H' ? r : r + word.length, ac = dir === 'H' ? c + word.length : c;
  if (br >= 0 && bc >= 0 && board[br][bc]) return false;
  if (ar < 10 && ac < 10 && board[ar][ac]) return false;
  return true;
}
function place(board, word, r, c, dir) {
  for (let i = 0; i < word.length; i++) {
    const rr = dir === 'H' ? r : r + i, cc = dir === 'H' ? c + i : c;
    board[rr][cc] = word[i];
  }
}
function pick(arr, rnd) { return arr[Math.floor(rnd() * arr.length)]; }
function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
const COMMON_BY_LEN = {};
for (const w of COMMON_WORDS) { (COMMON_BY_LEN[w.length] = COMMON_BY_LEN[w.length] || []).push(w); }
const BY_LEN = {};
for (const w of WORDS) { if (w.length >= 3 && w.length <= 7) (BY_LEN[w.length] = BY_LEN[w.length] || []).push(w); }

function buildBoard(rnd) {
  const board = emptyBoard();
  // Spine: a common 5-7 letter word across a middle row.
  const spineLen = 5 + Math.floor(rnd() * 3);
  const spine = pick(COMMON_BY_LEN[spineLen], rnd);
  const sr = 3 + Math.floor(rnd() * 3); // rows 3-5
  const sc = 2 + Math.floor(rnd() * 2); // cols 2-3
  if (!canPlace(board, spine, sr, sc, 'H', true)) return null;
  place(board, spine, sr, sc, 'H');
  // 2-4 crossing words: pick a random placed tile, cross it with a
  // word that shares its letter, preferring common words.
  let placed = 1;
  const target = 3 + Math.floor(rnd() * 2); // 3-4 words total
  for (let attempt = 0; attempt < 60 && placed < target; attempt++) {
    const tiles = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (board[r][c]) tiles.push([r, c]);
    const [r, c] = pick(tiles, rnd);
    const letter = board[r][c];
    const dir = rnd() < 0.5 ? 'V' : 'H';
    const len = 3 + Math.floor(rnd() * 4); // 3-6
    const pool = shuffle((COMMON_BY_LEN[len] || []).filter(w => w.includes(letter)), rnd)
      .concat(shuffle((BY_LEN[len] || []).filter(w => w.includes(letter)), rnd));
    let done = false;
    for (const w of pool.slice(0, 40)) {
      const positions = [];
      for (let i = 0; i < w.length; i++) if (w[i] === letter) positions.push(i);
      shuffle(positions, rnd);
      for (const pos of positions) {
        const wr = dir === 'H' ? r : r - pos, wc = dir === 'H' ? c - pos : c;
        if (wr < 2 || wc < 2 || wr > 7 || wc > 7) continue;
        if (!canPlace(board, w, wr, wc, dir, false)) continue;
        const trial = board.map(row => row.slice());
        place(trial, w, wr, wc, dir);
        if (!boardRunsValid(trial)) continue;
        place(board, w, wr, wc, dir);
        placed++; done = true; break;
      }
      if (done) break;
    }
  }
  if (placed < 3) return null;
  if (!boardRunsValid(board)) return null;
  let count = 0;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (board[r][c]) count++;
  if (count < 10 || count > 18) return null;
  return board;
}

function tryDay(dateKey, attemptSeed) {
  const rnd = mulberry32(seedFromDate(dateKey) ^ (attemptSeed * 2654435761));
  const savedRandom = Math.random;
  Math.random = rnd;
  try {
    const board = buildBoard(rnd);
    if (!board) { STATS.boardFail++; return null; }
    // Constructive rack: pick a 6-letter COMMON target word and a
    // placement for it on the board, then build the rack around the
    // letters that placement needs (filling the rest with random
    // letters). A random rack almost never has a clean bingo on a
    // random board (the first version failed 25 of 30 days that way);
    // building the rack from the answer makes the bingo certain and
    // leaves only the margin to verify.
    const targets = shuffle((COMMON_BY_LEN[6] || []).filter(w => !/[QZJXK]/.test(w) && !BLOCKED.has(w)), rnd);
    for (const target of targets.slice(0, 60)) {
      const spot = findTargetPlacement(board, target, rnd);
      if (!spot) continue;
      const rack = buildRackForSpot(spot, rnd);
      if (!rack) continue;
      const moves = findMoves(board, rack, false, true);
      if (!moves.length) continue;
      const best = moves[0];
      if (best.mainWord !== target) { STATS.notOptimal++; continue; }
      if (best.placements.length !== 6 || best.mainWord.length !== 6) { STATS.notBingo++; continue; }
      if (!best.words || best.words.length < 2) { STATS.noCross++; continue; }
      let second = null;
      for (const m of moves) { if (m.score < best.score) { second = m.score; break; } }
      if (second == null || best.score - second < 8) { STATS.marginFail++; continue; }
      // Premiums off the board and off the optimal play.
      const boardCells = new Set(), playCells = new Set();
      for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (board[r][c]) boardCells.add(r + ',' + c);
      for (const p of best.placements) playCells.add(p.row + ',' + p.col);
      let premiums = null;
      for (let t = 0; t < 40 && !premiums; t++) {
        const cand = makePremiums();
        if (Object.keys(cand).some(k => boardCells.has(k) || playCells.has(k))) continue;
        premiums = cand;
      }
      if (!premiums) { STATS.premiumFail++; continue; }
      // Re-check with the premiums attached (a runner-up can be boosted).
      board.__premiums = premiums;
      const moves2 = findMoves(board, rack, false, true);
      delete board.__premiums;
      if (!moves2.length || moves2[0].mainWord !== target || moves2[0].score !== best.score) { STATS.premiumMarginFail++; continue; }
      let second2 = null;
      for (const m of moves2) { if (m.score < best.score) { second2 = m.score; break; } }
      if (second2 == null || best.score - second2 < 8) { STATS.premiumMarginFail++; continue; }
      // The optimal must also validate through validatePlay (the same
      // path the client uses) at exactly the computed score.
      const check = validatePlay(board, rack, best.placements, premiums, false);
      if (!check.valid || check.score !== best.score || check.mainWord !== target) { STATS.validateFail++; continue; }
      const boardTriples = [];
      for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (board[r][c]) boardTriples.push([r, c, board[r][c]]);
      return {
        board: boardTriples, rack, premiums,
        optimalScore: best.score, optimalWord: target,
        _meta: { boardWords: boardWords(board), runnerUp: second2, margin: best.score - second2 },
      };
    }
    STATS.noTarget++;
    return null;
  } finally {
    Math.random = savedRandom;
  }
}
// Find a span of 6 cells (a row or a column) where `word` can be
// played: every cell is empty or the word's letter, at least one
// empty cell (the play adds tiles) and at least one fixed cell (the
// play crosses the board), the span is maximal, and the letters the
// play needs fit a legal rack (6 letters, >=2 vowels, >=2
// consonants, no letter 3+). Returns {placements, needed} or null.
function findTargetPlacement(board, word, rnd) {
  const spans = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c <= 4; c++) spans.push({ dir: 'H', r, c });
  for (let c = 0; c < 10; c++) for (let r = 0; r <= 4; r++) spans.push({ dir: 'V', r, c });
  shuffle(spans, rnd);
  for (const s of spans) {
    const placements = [];
    let fixed = 0;
    let ok = true;
    for (let i = 0; i < 6; i++) {
      const rr = s.dir === 'H' ? s.r : s.r + i, cc = s.dir === 'H' ? s.c + i : s.c;
      if (board[rr][cc]) {
        if (board[rr][cc] !== word[i]) { ok = false; break; }
        fixed++;
      } else placements.push({ row: rr, col: cc, letter: word[i] });
    }
    if (!ok || !placements.length || fixed === 0) continue;
    // Maximal span: no board tile immediately outside the word.
    const br = s.dir === 'H' ? s.r : s.r - 1, bc = s.dir === 'H' ? s.c - 1 : s.c;
    const ar = s.dir === 'H' ? s.r : s.r + 6, ac = s.dir === 'H' ? s.c + 6 : s.c;
    if ((br >= 0 && bc >= 0 && board[br][bc]) || (ar < 10 && ac < 10 && board[ar][ac])) continue;
    // Every cross run the new tiles create must be a word (checked
    // here so a bad span is rejected before the rack is built).
    const trial = board.map(row => row.slice());
    for (const p of placements) trial[p.row][p.col] = p.letter;
    let valid = true;
    for (const p of placements) {
      const crossDir = s.dir === 'H' ? 'V' : 'H';
      const w = wordAt(trial, p.row, p.col, crossDir);
      if (w.word.length >= 2 && !WORDS.has(w.word)) { valid = false; break; }
    }
    if (!valid) continue;
    // The needed letters must fit a legal 6-tile rack.
    const needed = placements.map(p => p.letter);
    const counts = {};
    for (const l of needed) counts[l] = (counts[l] || 0) + 1;
    if (Object.values(counts).some(n => n > 2)) continue;
    const v = needed.filter(l => VOWELS.has(l)).length;
    if (v < 1 || v > 5) continue; // filler can supply the rest
    return { placements, needed };
  }
  return null;
}
// The rack is the letters the target placement needs, plus random
// frequency-drawn filler to reach 6 (legal: >=2 vowels, >=2
// consonants, no letter 3+).
function buildRackForSpot(spot, rnd) {
  const rack = spot.needed.slice();
  const counts = {};
  for (const l of rack) counts[l] = (counts[l] || 0) + 1;
  for (let t = 0; t < 200 && rack.length < 6; t++) {
    const l = drawLetter();
    if ((counts[l] || 0) >= 2) continue;
    rack.push(l); counts[l] = (counts[l] || 0) + 1;
  }
  if (rack.length < 6) return null;
  const v = rack.filter(l => VOWELS.has(l)).length;
  if (v < 2 || v > 4) return null;
  return shuffle(rack, rnd);
}
const STATS = { boardFail: 0, noTarget: 0, notOptimal: 0, notBingo: 0, noCross: 0, marginFail: 0, premiumFail: 0, premiumMarginFail: 0, validateFail: 0 };
const BLOCKED = new Set();

function main() {
  const start = process.argv[2] || '2026-11-20';
  const days = parseInt(process.argv[3] || '30', 10);
  // 4th arg: comma-separated words to never use as the answer (e.g.
  // to avoid repeating an answer already used on a nearby day).
  for (const w of (process.argv[4] || '').split(',')) { const t = w.trim().toUpperCase(); if (t) BLOCKED.add(t); }
  const file = path.join(__dirname, '..', 'public', 'daily-puzzles.json');
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = { ...existing };
  const report = [];
  const d = new Date(start + 'T12:00:00');
  for (let i = 0; i < days; i++) {
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (out[key]) { report.push({ date: key, note: 'already in file' }); d.setDate(d.getDate() + 1); continue; }
    let puzzle = null, attempts = 0;
    for (let a = 0; a < 200 && !puzzle; a++) { attempts = a + 1; puzzle = tryDay(key, a); }
    if (!puzzle) { report.push({ date: key, note: 'FAILED after ' + attempts + ' attempts' }); d.setDate(d.getDate() + 1); continue; }
    const { _meta, ...clean } = puzzle;
    out[key] = clean;
    report.push({ date: key, rack: puzzle.rack.join(''), optimal: puzzle.optimalWord, score: puzzle.optimalScore, runnerUp: _meta.runnerUp, margin: _meta.margin, boardWords: _meta.boardWords.join('/'), attempts });
    d.setDate(d.getDate() + 1);
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  for (const r of report) console.log(JSON.stringify(r));
  const failed = report.filter(r => r.note && r.note.startsWith('FAILED'));
  console.log(failed.length ? 'FAILURES: ' + failed.length : 'ALL DAYS GENERATED');
  console.log('STATS ' + JSON.stringify(STATS));
}
main();
