// Duello bot-play slice — Postgres, no login.
// Bot play only. No friends, no profile, no leaderboards in this slice.
// Run: DATABASE_URL=postgres://... node server.js  (PORT env, default 3000)
// Data: data/words.txt, data/definitions.json (dictionary files, still required)
//       Postgres, via DATABASE_URL only. There is NO SQLite fallback in this
//       slice, so a test run actually proves Postgres works. If DATABASE_URL
//       is missing the server exits at startup with a clear error.
// Auth surface for this slice: POST /api/guest only. It creates a per-device
// guest user (guest_<random>, dummy @guest.local email, random scrypt hash
// never shown to the user, Elo 1000) plus a session token. The client stores
// that token in localStorage under the existing 'duello_token' key and
// reuses it, so Elo follows the device. Real accounts come later.
'use strict';
const http = require('http');
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

const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Dictionary ----------
const WORDS = new Set();
for (const line of fs.readFileSync(path.join(DATA_DIR, 'words.txt'), 'utf8').split('\n')) {
  const w = line.trim().toUpperCase();
  if (w) WORDS.add(w);
}
let DEFS = {};
try { DEFS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'definitions.json'), 'utf8')); } catch (e) { DEFS = {}; }
const LETTER_VALUES = { A:1,B:4,C:4,D:3,E:1,F:5,G:3,H:4,I:1,J:9,K:6,L:2,M:4,N:2,O:1,P:4,Q:10,R:1,S:1,T:1,U:2,V:6,W:5,X:8,Y:5,Z:9 };
const VOWELS = new Set(['A','E','I','O','U']);
const FREQ = [['A',8.59],['B',2.46],['C',2.39],['D',4.31],['E',9.43],['F',2.16],['G',3.00],['H',2.39],['I',6.26],['J',1.46],['K',1.77],['L',4.51],['M',2.68],['N',5.62],['O',6.43],['P',2.70],['Q',1.38],['R',6.44],['S',6.12],['T',6.17],['U',4.41],['V',1.94],['W',2.20],['X',1.51],['Y',2.20],['Z',1.48]];
const FREQ_CUM = []; { let s = 0; for (const [l, f] of FREQ) { s += f; FREQ_CUM.push([s, l]); } }
function drawLetter() { const r = Math.random() * 100; for (const [cum, l] of FREQ_CUM) if (r <= cum) return l; return 'E'; }
function drawRack() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rack = Array.from({ length: 6 }, drawLetter);
    const v = rack.filter(c => VOWELS.has(c)).length;
    const c = 6 - v;
    if (v >= 2 && c >= 2) return rack;
  }
  return ['A','E','B','C','D','F'];
}
function drawVowel() { for (let i = 0; i < 100; i++) { const l = drawLetter(); if (VOWELS.has(l)) return l; } return 'E'; }
function drawConsonant() { for (let i = 0; i < 100; i++) { const l = drawLetter(); if (!VOWELS.has(l)) return l; } return 'B'; }
function refillRack(rack, usedIndices) {
  // Refill in place (unplayed tiles never move) AND guarantee the settled
  // floor: every rack has at least 2 vowels and at least 2 consonants.
  // The old code just drew random letters for the used slots, so a rack
  // could come back with 0-1 vowels or consonants after a play.
  const next = rack.slice();
  const usedSet = new Set(usedIndices);
  const unplayed = next.filter((_, i) => !usedSet.has(i));
  let v = unplayed.filter(c => VOWELS.has(c)).length;
  let c = unplayed.filter(c => !VOWELS.has(c)).length;
  let needV = Math.max(0, 2 - v), needC = Math.max(0, 2 - c);
  for (const idx of usedIndices) {
    if (needV > 0) { next[idx] = drawVowel(); needV--; }
    else if (needC > 0) { next[idx] = drawConsonant(); needC--; }
    else next[idx] = drawLetter();
  }
  // Fallback for a rack that somehow already broke the floor before the
  // play (should not happen): change unplayed tiles only as a last resort.
  for (let i = 0; i < next.length && (needV > 0 || needC > 0); i++) {
    if (usedSet.has(i)) continue;
    if (needV > 0 && !VOWELS.has(next[i])) { next[i] = drawVowel(); needV--; }
    else if (needC > 0 && VOWELS.has(next[i])) { next[i] = drawConsonant(); needC--; }
  }
  return next;
}

// ---------- Database (Postgres) ----------
async function initDb() {
  const schema = fs.readFileSync(path.join(ROOT, 'db', 'postgres-schema.sql'), 'utf8');
  await pool.query(schema);
  // photo_data is used by publicUser if present; the base schema does not
  // define it, so add it idempotently for later slices. It is not used by
  // bot play itself.
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_data TEXT');
}
async function q(text, params) { return pool.query(text, params); }
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
async function getUserByEmail(email) { const r = await q('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]); return r.rows[0] || null; }
async function getUserByUsername(username) { const r = await q('SELECT * FROM users WHERE username=$1', [username]); return r.rows[0] || null; }
async function getUserById(id) { const r = await q('SELECT * FROM users WHERE id=$1', [id]); return r.rows[0] || null; }
function publicUser(u) {
  if (!u) return null;
  const created = u.created_at instanceof Date ? u.created_at.toISOString() : u.created_at;
  return { id: u.id, email: u.email, username: u.username, firstName: u.first_name, lastName: u.last_name, elo: u.elo, eloHigh: u.elo_high, createdAt: created, hasPhoto: !!u.photo_data, photoData: u.photo_data || null };
}
async function authUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const r = await q('SELECT * FROM sessions WHERE token=$1', [m[1]]);
  if (!r.rows[0]) return null;
  return getUserById(r.rows[0].user_id);
}

// ---------- Board / premiums ----------
const SIZE = 10, INNER = { r0: 2, r1: 7, c0: 2, c1: 7 };
function isInner(r, c) { return r >= INNER.r0 && r <= INNER.r1 && c >= INNER.c0 && c <= INNER.c1; }
function isOuter(r, c) { return !isInner(r, c); }
function makePremiums() {
  const outer = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (isOuter(r, c)) outer.push([r, c]);
  // Shuffle, then greedily pick 12 cells never touching even diagonally.
  for (let i = outer.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [outer[i], outer[j]] = [outer[j], outer[i]]; }
  const picked = [];
  for (const cell of outer) {
    if (picked.length >= 12) break;
    if (picked.some(([r, c]) => Math.abs(r - cell[0]) <= 1 && Math.abs(c - cell[1]) <= 1)) continue;
    picked.push(cell);
  }
  const types = ['DL','DW','TL','TW','DL','DW','TL','TW','DL','DW','TL','TW'];
  const premiums = {};
  picked.forEach(([r, c], i) => { premiums[`${r},${c}`] = types[i]; });
  return premiums;
}
function emptyBoard() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(null)); }
function boardIsEmpty(board) { return board.every(row => row.every(c => !c)); }

// ---------- Validation / scoring ----------
function wordAt(board, r, c, dir) {
  // dir 'H': row r, 'V': col c. Return {word, cells} for the maximal contiguous line.
  let cells = [];
  if (dir === 'H') {
    let s = c; while (s > 0 && board[r][s - 1]) s--;
    let e = c; while (e < SIZE - 1 && board[r][e + 1]) e++;
    for (let cc = s; cc <= e; cc++) cells.push([r, cc]);
  } else {
    let s = r; while (s > 0 && board[s - 1][c]) s--;
    // Was board[s + 1][c]: with s fixed at the top of the word, that test
    // never turned false for a word of length >= 2, so e ran to row 9 and
    // wordAt concatenated letters separated by empty cells into one fake
    // word — exactly the "not a word for something not even adjacent" bug.
    let e = r; while (e < SIZE - 1 && board[e + 1][c]) e++;
    for (let rr = s; rr <= e; rr++) cells.push([rr, c]);
  }
  const word = cells.map(([rr, cc]) => board[rr][cc]).join('');
  return { word, cells };
}
function scoreWord(board, cells, newCellsSet, premiums) {
  let sum = 0, wordMult = 1;
  for (const [r, c] of cells) {
    let v = LETTER_VALUES[board[r][c]] || 0;
    if (newCellsSet.has(`${r},${c}`)) {
      const p = premiums[`${r},${c}`];
      if (p === 'DL') v *= 2; else if (p === 'TL') v *= 3;
      else if (p === 'DW') wordMult *= 2; else if (p === 'TW') wordMult *= 3;
    }
    sum += v;
  }
  return sum * wordMult;
}
// Validate a set of placements against board/rack. Returns {valid, error, invalidWords, words, score, mainWord, mainCells, placements}
function validatePlay(board, rack, placements, premiums, isFirst) {
  if (!placements || placements.length === 0) return { valid: false, error: 'No tiles placed.' };
  if (placements.length > 6) return { valid: false, error: 'Too many tiles.' };
  // Rack multiset check
  const rackCount = {};
  for (const l of rack) rackCount[l] = (rackCount[l] || 0) + 1;
  for (const p of placements) {
    if (p.row < 0 || p.row >= SIZE || p.col < 0 || p.col >= SIZE) return { valid: false, error: 'Tile off the board.' };
    if (board[p.row][p.col]) return { valid: false, error: 'Tile on an occupied cell.' };
    if (!rackCount[p.letter]) return { valid: false, error: 'Tile not in your rack.' };
    rackCount[p.letter]--;
  }
  const sameRow = placements.every(p => p.row === placements[0].row);
  const sameCol = placements.every(p => p.col === placements[0].col);
  if (!sameRow && !sameCol) return { valid: false, error: 'all tiles must be connected' };
  const dir = sameRow ? 'H' : 'V';
  // No gaps in the main line. Note: there is deliberately NO "maximal
  // placements" check here. A board tile immediately outside the placements
  // is not a disconnection — it is an extension, and wordAt() below expands
  // through it, so the word actually formed IS maximal. The old check
  // rejected every extension play (e.g. M to the left of A to make MA, with
  // EM as a cross word) with the misleading "All tiles must be connected."
  const sorted = placements.slice().sort((a, b) => dir === 'H' ? a.col - b.col : a.row - b.row);
  const lineIdx = dir === 'H' ? sorted[0].row : sorted[0].col;
  const lo = dir === 'H' ? sorted[0].col : sorted[0].row;
  const hi = dir === 'H' ? sorted[sorted.length - 1].col : sorted[sorted.length - 1].row;
  // Build trial board
  const trial = board.map(row => row.slice());
  for (const p of placements) trial[p.row][p.col] = p.letter;
  // Gap check: every cell between lo and hi in the main line must be filled in trial.
  for (let i = lo; i <= hi; i++) {
    const cell = dir === 'H' ? trial[lineIdx][i] : trial[i][lineIdx];
    if (!cell) return { valid: false, error: 'all tiles must be connected' };
  }
  // First word entirely inside inner 6x6
  if (isFirst) {
    for (const p of placements) if (!isInner(p.row, p.col)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
    // Main word cells must also be inside (placements are the whole word on an empty board)
    if (dir === 'H' && (lineIdx < INNER.r0 || lineIdx > INNER.r1)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
    if (dir === 'V' && (lineIdx < INNER.c0 || lineIdx > INNER.c1)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
  } else {
    // Connected to existing board: main line includes an existing tile, or a
    // placed tile is orthogonally adjacent to an existing tile.
    const mainIncludesExisting = (() => {
      for (let i = lo; i <= hi; i++) {
        const was = dir === 'H' ? board[lineIdx][i] : board[i][lineIdx];
        if (was) return true;
      }
      return false;
    })();
    let adjacent = false;
    for (const p of placements) {
      const neigh = [[p.row - 1, p.col], [p.row + 1, p.col], [p.row, p.col - 1], [p.row, p.col + 1]];
      if (neigh.some(([r, c]) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c])) adjacent = true;
    }
    if (!mainIncludesExisting && !adjacent) return { valid: false, error: 'all tiles must be connected' };
  }
  // Single-tile plays are special: the old code always read them
  // horizontally, so a lone tile that only formed a vertical word was
  // rejected as "Word too short" even though it was a real play. Read both
  // directions; a single tile may form one or two words, both must be real.
  if (placements.length === 1 && !isFirst) {
    const both = [wordAt(trial, placements[0].row, placements[0].col, 'H'), wordAt(trial, placements[0].row, placements[0].col, 'V')].filter(w => w.word.length >= 2);
    if (!both.length) return { valid: false, error: 'Word too short.' };
    const bad = [...new Set(both.filter(w => !WORDS.has(w.word)).map(w => w.word))];
    if (bad.length) return { valid: false, error: 'not a word', invalidWords: bad, words: both };
    const newSet1 = new Set(placements.map(p => `${p.row},${p.col}`));
    const scored1 = both.map(w => ({ word: w.word, cells: w.cells, score: scoreWord(trial, w.cells, newSet1, premiums) }));
    const isDuello1 = both.some(w => w.word === 'DUELLO');
    const bonus1 = isDuello1 ? 30 : 0;
    const main1 = scored1.find(w => w.word === 'DUELLO') || scored1.reduce((a, b) => (b.score > a.score ? b : a));
    return { valid: true, words: scored1, score: scored1.reduce((s, w) => s + w.score, 0) + bonus1, mainWord: main1.word, mainCells: main1.cells, bonus: bonus1, isDuello: isDuello1, bingo: false, placements };
  }
  // Words formed
  const main = wordAt(trial, placements[0].row, placements[0].col, dir);
  if (main.word.length < 2) return { valid: false, error: 'Word too short.' };
  const words = [{ word: main.word, cells: main.cells }];
  const crossDir = dir === 'H' ? 'V' : 'H';
  for (const p of placements) {
    const cross = wordAt(trial, p.row, p.col, crossDir);
    if (cross.word.length >= 2 && !words.some(w => w.word === cross.word && w.cells[0][0] === cross.cells[0][0] && w.cells[0][1] === cross.cells[0][1])) {
      words.push({ word: cross.word, cells: cross.cells });
    }
  }
  const invalidWords = [];
  for (const w of words) if (!WORDS.has(w.word)) invalidWords.push(w.word);
  if (invalidWords.length) {
    const uniq = [...new Set(invalidWords)];
    return { valid: false, error: 'not a word', invalidWords: uniq, words };
  }
  const newSet = new Set(placements.map(p => `${p.row},${p.col}`));
  let score = 0;
  const scored = words.map(w => {
    const s = scoreWord(trial, w.cells, newSet, premiums);
    score += s;
    return { word: w.word, cells: w.cells, score: s };
  });
  const isDuello = main.word === 'DUELLO';
  const bingo = placements.length === 6;
  let bonus = 0;
  if (isDuello) bonus += 30;
  if (bingo) bonus += 30;
  score += bonus;
  return { valid: true, words: scored, score, mainWord: main.word, mainCells: main.cells, bonus, isDuello, bingo, placements };
}

// ---------- Solver (exhaustive for Fishstick, full list for Competitive) ----------
// Index: length -> pos -> letter -> words. Built once at startup.
const DICT_BY_LEN = new Map();
const FIXED_INDEX = new Map();
for (const w of WORDS) {
  if (!DICT_BY_LEN.has(w.length)) DICT_BY_LEN.set(w.length, []);
  DICT_BY_LEN.get(w.length).push(w);
  for (let p = 0; p < w.length; p++) {
    const key = `${w.length}|${p}|${w[p]}`;
    if (!FIXED_INDEX.has(key)) FIXED_INDEX.set(key, []);
    FIXED_INDEX.get(key).push(w);
  }
}
function rackSubset(letters, rack) {
  const cnt = {};
  for (const l of rack) cnt[l] = (cnt[l] || 0) + 1;
  for (const l of letters) { if (!cnt[l]) return false; cnt[l]--; }
  return true;
}
function permutationsFromRack(rack, len) {
  const cnt = {};
  for (const l of rack) cnt[l] = (cnt[l] || 0) + 1;
  const out = new Set();
  const letters = Object.keys(cnt);
  function rec(cur) {
    if (cur.length === len) { out.add(cur); return; }
    for (const l of letters) {
      if (cnt[l] > 0) { cnt[l]--; rec(cur + l); cnt[l]++; }
    }
  }
  rec('');
  return out;
}
function findMoves(board, rack, isFirst, wantAll) {
  const moves = [];
  let best = null;
  const consider = (move) => {
    if (!best || move.score > best.score) best = move;
    if (wantAll) moves.push(move);
    else if (moves.length === 0) moves.push(move);
  };
  // Note: for wantAll=false we still scan everything to find the true best;
  // moves[0] is replaced at the end with best. This keeps Fishstick honest.
  for (const dir of ['H', 'V']) {
    for (let line = 0; line < SIZE; line++) {
      for (let start = 0; start < SIZE; start++) {
        for (let len = 2; len <= 10 && start + len <= SIZE; len++) {
          const cells = [];
          let fixed = [];
          for (let i = 0; i < len; i++) {
            const r = dir === 'H' ? line : start + i;
            const c = dir === 'H' ? start + i : line;
            cells.push([r, c]);
            if (board[r][c]) fixed.push([i, board[r][c]]);
          }
          const newCount = len - fixed.length;
          if (newCount === 0 || newCount > rack.length) continue;
          // Main word must be maximal: no board tile immediately outside the span.
          if (dir === 'H') {
            if (start > 0 && board[line][start - 1]) continue;
            if (start + len < SIZE && board[line][start + len]) continue;
          } else {
            if (start > 0 && board[start - 1][line]) continue;
            if (start + len < SIZE && board[start + len][line]) continue;
          }
          if (isFirst) {
            if (dir === 'H') { if (line < INNER.r0 || line > INNER.r1 || start < INNER.c0 || start + len - 1 > INNER.c1) continue; }
            else { if (line < INNER.c0 || line > INNER.c1 || start < INNER.r0 || start + len - 1 > INNER.r1) continue; }
          } else if (fixed.length === 0) {
            // Parallel play: at least one span cell must touch an existing tile orthogonally.
            let touches = false;
            for (const [r, c] of cells) {
              const neigh = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
              if (neigh.some(([rr, cc]) => rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && board[rr][cc])) touches = true;
            }
            if (!touches) continue;
          }
          let candidates = [];
          if (fixed.length > 0) {
            let smallest = null;
            for (const [p, letter] of fixed) {
              const list = FIXED_INDEX.get(`${len}|${p}|${letter}`) || [];
              if (!smallest || list.length < smallest.length) smallest = list;
            }
            if (!smallest) continue;
            for (const word of smallest) {
              let ok = true;
              const newLetters = [];
              for (let i = 0; i < len; i++) {
                const [r, c] = cells[i];
                if (board[r][c]) { if (word[i] !== board[r][c]) { ok = false; break; } }
                else newLetters.push(word[i]);
              }
              if (!ok) continue;
              if (!rackSubset(newLetters, rack)) continue;
              candidates.push(word);
            }
          } else {
            for (const word of permutationsFromRack(rack, len)) {
              if (WORDS.has(word)) candidates.push(word);
            }
          }
          for (const word of candidates) {
            const placements = [];
            for (let i = 0; i < len; i++) {
              const [r, c] = cells[i];
              if (!board[r][c]) placements.push({ row: r, col: c, letter: word[i] });
            }
            if (placements.length === 0) continue;
            // Trial board for cross-word checks and scoring
            const trial = board.map(row => row.slice());
            for (const p of placements) trial[p.row][p.col] = p.letter;
            const crossDir = dir === 'H' ? 'V' : 'H';
            const words = [{ word, cells, score: 0 }];
            let valid = true;
            for (const p of placements) {
              const cross = wordAt(trial, p.row, p.col, crossDir);
              if (cross.word.length >= 2) {
                if (!WORDS.has(cross.word)) { valid = false; break; }
                if (!words.some(w => w.word === cross.word && w.cells[0][0] === cross.cells[0][0] && w.cells[0][1] === cross.cells[0][1])) {
                  words.push({ word: cross.word, cells: cross.cells, score: 0 });
                }
              }
            }
            if (!valid) continue;
            const newSet = new Set(placements.map(p => `${p.row},${p.col}`));
            // Premiums are stored on the game, not the board; scoring needs them.
            // findMoves is called with premiums attached to board via a hidden prop.
            const premiums = board.__premiums || {};
            let total = 0;
            for (const w of words) { w.score = scoreWord(trial, w.cells, newSet, premiums); total += w.score; }
            const isDuello = word === 'DUELLO';
            const bingo = placements.length === 6;
            let bonus = 0; if (isDuello) bonus += 30; if (bingo) bonus += 30;
            total += bonus;
            // Highlight rule: main word, except a single-tile play generating
            // multiple words highlights the higher-scoring word.
            let highlightCells = cells;
            if (placements.length === 1 && words.length > 1) {
              let bestW = words[0];
              for (const w of words) if (w.score > bestW.score) bestW = w;
              highlightCells = bestW.cells;
            }
            consider({ placements, words, score: total, mainWord: word, mainCells: cells, highlightCells, bonus, isDuello, bingo });
          }
        }
      }
    }
  }
  if (!wantAll && best) return [best];
  moves.sort((a, b) => b.score - a.score);
  return moves;
}
function botSkillRates(elo) {
  const anchors = [[0, 60, 35, 5], [1000, 40, 50, 10], [2000, 20, 50, 30], [3000, 0, 10, 90]];
  const e = Math.max(0, Math.min(3000, elo));
  for (let i = 0; i < anchors.length - 1; i++) {
    const [e0, b0, a0, g0] = anchors[i];
    const [e1, b1, a1, g1] = anchors[i + 1];
    if (e >= e0 && e <= e1) {
      const t = e1 === e0 ? 0 : (e - e0) / (e1 - e0);
      return { bad: b0 + (b1 - b0) * t, avg: a0 + (a1 - a0) * t, good: g0 + (g1 - g0) * t };
    }
  }
  return { bad: 0, avg: 10, good: 90 };
}
function pickCompetitiveMove(moves, elo) {
  if (!moves.length) return null;
  const scores = moves.map(m => m.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  const range = max - min || 1;
  const buckets = { bad: [], avg: [], good: [] };
  for (const m of moves) {
    if (m.score <= min + range / 3) buckets.bad.push(m);
    else if (m.score >= max - range / 3) buckets.good.push(m);
    else buckets.avg.push(m);
  }
  const rates = botSkillRates(elo);
  const roll = Math.random() * 100;
  let bucket = buckets.avg;
  if (roll < rates.bad) bucket = buckets.bad;
  else if (roll < rates.bad + rates.avg) bucket = buckets.avg;
  else bucket = buckets.good;
  if (!bucket.length) bucket = moves;
  return bucket[Math.floor(Math.random() * bucket.length)];
}

// ---------- Game state ----------
function newGame(user, botType) {
  const botElo = botType === 'fishstick' ? 3000 : user.elo;
  const premiums = makePremiums();
  const board = emptyBoard();
  board.__premiums = premiums; // solver reads premiums from here; stripped on save/serialize
  const game = {
    userId: user.id, botType, botElo,
    board, premiums,
    humanRack: drawRack(), botRack: drawRack(),
    scores: { human: 0, bot: 0 },
    clocks: { human: 300000, bot: 300000 },
    turn: Math.random() < 0.5 ? 'human' : 'bot',
    turnStartedAt: Date.now(),
    // Bot think: bot does NOT move instantly. Client shows a 5s wind-down,
    // then fetches; the server only runs the bot once think time has elapsed.
    botThinkUntil: null,
    status: 'active', reason: null,
    consecutivePasses: 0, consecutiveNoMoves: 0,
    moves: { human: [], bot: [] },
    lastCells: [], lastWord: null, lastScore: null, lastBy: null,
    lastHuman: null, lastBot: null,
    eloDeltaHuman: null, eloDeltaBot: null, eloAfterHuman: null, eloAfterBot: null,
  };
  if (game.turn === 'bot') game.botThinkUntil = Date.now() + 5000;
  return game;
}
function stripBoard(board) { return board.map(row => row.slice()); }
function serializeGame(game, user) {
  const now = Date.now();
  let clockHuman = game.clocks.human, clockBot = game.clocks.bot;
  if (game.status === 'active') {
    const elapsed = now - game.turnStartedAt;
    if (game.turn === 'human') clockHuman = Math.max(0, clockHuman - elapsed);
    else clockBot = Math.max(0, clockBot - elapsed);
  }
  return {
    id: game.id, botType: game.botType, botElo: game.botElo,
    board: stripBoard(game.board), premiums: game.premiums,
    humanRack: game.humanRack, botRackCount: game.botRack.length,
    scores: game.scores, clocks: { human: clockHuman, bot: clockBot, turn: game.turn, turnStartedAt: game.turnStartedAt },
    botThinkUntil: game.botThinkUntil || null,
    // Relative remaining time, not just the absolute server timestamp: the
    // client must never compare a Render server clock to the phone clock
    // (skew there added a second poll and pushed the perceived think to ~7s).
    botThinkRemainingMs: game.botThinkUntil ? Math.max(0, game.botThinkUntil - now) : null,
    status: game.status, reason: game.reason,
    lastCells: game.lastCells, lastWord: game.lastWord, lastScore: game.lastScore, lastBy: game.lastBy,
    lastHuman: game.lastHuman, lastBot: game.lastBot,
    eloDeltaHuman: game.eloDeltaHuman, eloDeltaBot: game.eloDeltaBot, eloAfterHuman: game.eloAfterHuman, eloAfterBot: game.eloAfterBot,
    isFirst: boardIsEmpty(game.board),
    player: { firstName: user.first_name, username: user.username, elo: user.elo },
  };
}
async function saveGameRow(game) {
  const copy = { ...game, board: stripBoard(game.board) };
  delete copy.id;
  const json = JSON.stringify(copy);
  if (game.id) await q('UPDATE games SET state=$1::jsonb, updated_at=now() WHERE id=$2', [json, game.id]);
  else { const r = await q('INSERT INTO games (user_id, bot_type, bot_elo, state) VALUES ($1,$2,$3,$4::jsonb) RETURNING id', [game.userId, game.botType, game.botElo, json]); game.id = Number(r.rows[0].id); }
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
function eloDelta(playerElo, oppElo, actual) {
  const expected = 1 / (1 + Math.pow(10, (oppElo - playerElo) / 400));
  return Math.round(32 * (actual - expected));
}
function updateStatsForMove(game, side, move, bestScoreBefore) {
  const list = game.moves[side];
  const isOptimal = bestScoreBefore !== null && move.score === bestScoreBefore;
  list.push({ words: move.words.map(w => ({ word: w.word, score: w.score })), score: move.score, isOptimal, mainWord: move.mainWord });
}
function computeStats(moves) {
  let best = null, longest = null, optimal = 0, total = 0, unique = new Set(), optimalWords = [];
  for (const m of moves) {
    total++;
    if (m.isOptimal) { optimal++; if (m.mainWord) optimalWords.push(m.mainWord); }
    for (const w of m.words) {
      unique.add(w.word);
      if (!best || w.score > best.score) best = w;
      if (!longest || w.word.length > longest.word.length) longest = w;
    }
  }
  return { best, longest, optimal, total, uniqueCount: unique.size, optimalWords };
}
async function endGame(game, user, reason, winnerSide) {
  // winnerSide: 'human' | 'bot' | 'draw' | null (forfeit handled by caller setting winner)
  game.status = 'finished';
  game.reason = reason;
  game.winner = winnerSide;
  const actual = winnerSide === 'human' ? 1 : winnerSide === 'bot' ? 0 : 0.5;
  const delta = eloDelta(user.elo, game.botElo, actual);
  game.eloDeltaHuman = delta;
  // Competitive Bot mirrors the player: its Elo for the next game IS the
  // player's new Elo, so it moves the SAME direction as the human.
  // A fixed opponent (Fishstick, 3000) moves the opposite way, as usual.
  // The old code always used -delta for the bot AND never mutated the
  // in-memory user, so serializeGame() sent the stale pre-game human Elo
  // back to the client — the scoreboard looked like the human never moved.
  game.eloDeltaBot = game.botType === 'competitive' ? delta : -delta;
  game.eloAfterHuman = user.elo + delta;
  game.eloAfterBot = game.botElo + game.eloDeltaBot;
  game.botElo = game.eloAfterBot;
  user.elo = game.eloAfterHuman;
  await q('UPDATE users SET elo=$1, elo_high=GREATEST(elo_high,$2) WHERE id=$3', [game.eloAfterHuman, game.eloAfterHuman, user.id]);
  await saveGameRow(game);
  await q('INSERT INTO elo_history (user_id, game_id, elo_after, delta) VALUES ($1,$2,$3,$4)', [user.id, game.id, game.eloAfterHuman, delta]);
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
    const rack = game.botRack.slice();
    for (const p of move.placements) {
      const idx = rack.indexOf(p.letter);
      if (idx >= 0) rack.splice(idx, 1);
    }
    while (rack.length < 6) rack.push(drawLetter());
    // Bot rack is hidden, but keep the same floor so the bot is never
    // stranded with no vowels or no consonants to play with.
    let bv = rack.filter(c => VOWELS.has(c)).length, bc = rack.length - bv;
    for (let i = 0; i < rack.length && (bv < 2 || bc < 2); i++) {
      if (bv < 2 && !VOWELS.has(rack[i])) { rack[i] = drawVowel(); bv++; bc--; }
      else if (bc < 2 && VOWELS.has(rack[i])) { rack[i] = drawConsonant(); bc++; bv--; }
    }
    game.botRack = rack;
  }
  game.scores[side] += move.score;
  game.lastCells = move.highlightCells;
  game.lastWord = move.mainWord;
  game.lastScore = move.score;
  game.lastBy = side;
  if (isHuman) game.lastHuman = { word: move.mainWord, points: move.score, bonus: move.bonus, isDuello: move.isDuello, bingo: move.bingo };
  else game.lastBot = { word: move.mainWord, points: move.score, bonus: move.bonus, isDuello: move.isDuello, bingo: move.bingo };
  updateStatsForMove(game, side, move, bestScoreBefore);
  game.consecutivePasses = 0;
  game.consecutiveNoMoves = 0;
}
function runBotTurn(game) {
  // Called after settleClock, when turn === 'bot' and status is active.
  // Returns true if the bot moved, false if it passed / was skipped.
  if (game.status !== 'active' || game.turn !== 'bot') return false;
  if (game.clocks.bot <= 0) { game.turn = 'human'; game.turnStartedAt = Date.now(); return false; }
  const isFirst = boardIsEmpty(game.board);
  const moves = findMoves(game.board, game.botRack, isFirst, true);
  if (!moves.length) {
    game.consecutivePasses++;
    game.consecutiveNoMoves++;
    game.lastBot = { word: null, points: 0, passed: true, auto: true };
    game.turn = 'human'; game.turnStartedAt = Date.now();
    if (game.consecutiveNoMoves >= 2) {
      // Game ends by score; caller will finish it (needs user for Elo).
      game._pendingNoMovesEnd = true;
    }
    return false;
  }
  const bestScore = moves[0].score;
  const move = game.botType === 'fishstick' ? moves[0] : pickCompetitiveMove(moves, game.botElo);
  applyMove(game, 'bot', move, bestScore);
  game.turn = 'human'; game.turnStartedAt = Date.now();
  return true;
}

function stepBotClockTo20sMark(game) {
  if (game.clocks.bot > 0) game.clocks.bot = Math.floor((game.clocks.bot - 1) / 20000) * 20000;
  else game.clocks.bot = 0;
}
async function advanceBotTurnIfReady(game, user) {
  // Returns true if the bot actually moved (clock should step), false otherwise.
  if (game.status !== 'active' || game.turn !== 'bot') return false;
  const until = game.botThinkUntil || (game.turnStartedAt + 5000);
  // 1.5s tolerance: the client polls at 5s from its tap, but the server's
  // think timer starts when the Play POST arrives (network time later),
  // so a poll at tap+5s would otherwise miss and need a second poll,
  // pushing the perceived think to ~7s. Within tolerance the move runs.
  if (Date.now() < until - 1500) return false;
  if (game.clocks.bot <= 0) { game.turn = 'human'; game.turnStartedAt = Date.now(); game.botThinkUntil = null; return false; }
  settleClock(game);
  const moved = runBotTurn(game);
  if (moved) stepBotClockTo20sMark(game);
  game.botThinkUntil = null;
  if (await finishIfNeeded(game, user)) { /* finished */ }
  // Timeout loop: if the bot just played and the human's clock is already
  // at 0, do not hand the turn back to a player who cannot move — start
  // the next bot think immediately, so the bot keeps playing 5s / play /
  // 15s runoff / 5s / play … until its own clock hits 0 or the game ends.
  if (game.status === 'active' && game.turn === 'human' && game.clocks.human <= 0 && game.clocks.bot > 0) startBotTurn(game);
  return moved;
}
function startBotTurn(game) {
  game.turn = 'bot'; game.turnStartedAt = Date.now(); game.botThinkUntil = Date.now() + 5000;
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
  return out;
}
// Part of speech for Jeff's 118 two-letter words — same map as
// scripts/build-dictionary.js, applied at runtime so an older
// definitions.json (pos '' for all 118) still shows a part of speech
// in the same "(pos) — definition" format as other words.
const JEFF2_POS = {AA:"noun",AB:"noun",AD:"noun",AE:"noun",AG:"adjective",AH:"interjection",AI:"noun",AL:"noun",AM:"verb",AN:"article",AR:"noun",AS:"adverb",AT:"preposition",AW:"interjection",AX:"noun",AY:"noun",BA:"noun",BE:"verb",BI:"noun",BO:"noun",BY:"noun",DA:"noun",DE:"preposition",DO:"noun",ED:"adjective",EE:"interjection",EF:"noun",EH:"interjection",EL:"noun",EM:"noun",EN:"noun",EO:"noun",ER:"interjection",ES:"noun",ET:"verb",EW:"interjection",EX:"noun",FA:"noun",FE:"noun",FI:"noun",FU:"noun",GI:"noun",GO:"verb",HA:"interjection",HE:"pronoun",HI:"interjection",HM:"interjection",HO:"interjection",ID:"noun",IF:"conjunction",IN:"verb",IO:"noun",IS:"verb",IT:"pronoun",JA:"interjection",JE:"noun",JO:"noun",KA:"noun",KI:"noun",LA:"noun",LI:"noun",LO:"interjection",MA:"noun",ME:"pronoun",MI:"noun",MM:"interjection",MO:"noun",MU:"noun",MY:"pronoun",NA:"adverb",NE:"adjective",NO:"noun",NU:"noun",OD:"noun",OE:"noun",OF:"preposition",OH:"interjection",OI:"interjection",OK:"adjective",OM:"noun",ON:"noun",OO:"noun",OP:"noun",OR:"noun",OS:"noun",OU:"noun",OW:"interjection",OX:"noun",OY:"interjection",PA:"noun",PE:"noun",PI:"noun",PO:"noun",QI:"noun",RE:"noun",SH:"interjection",SI:"noun",SO:"noun",TA:"interjection",TE:"noun",TI:"noun",TO:"preposition",UH:"interjection",UM:"interjection",UN:"noun",UP:"verb",US:"pronoun",UT:"noun",VU:"preposition",WE:"pronoun",WO:"noun",XI:"noun",XU:"noun",YA:"pronoun",YE:"pronoun",YI:"pronoun",YO:"interjection",ZA:"noun"};
function getDefinition(word) {
  const w = String(word || '').toUpperCase();
  if (isRealDef(DEFS[w])) return { word: w, pos: DEFS[w].pos || JEFF2_POS[w] || '', definition: DEFS[w].def };
  // Stem to a base word with a real definition, labelled as a form of it.
  for (const base of stemCandidates(w)) {
    if (isRealDef(DEFS[base])) return { word: w, pos: DEFS[base].pos || '', definition: `form of ${base} — ${DEFS[base].def}` };
  }
  // Honest fallback, not a fake definition: this word is in the Duello
  // list but WordNet has no entry for it or any base form of it (mostly
  // obscure ENABLE words). Inventing a gloss for those would be worse.
  return { word: w, pos: '', definition: 'No definition in the bundled dictionary.' };
}

// ---------- HTTP API ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
async function loadGameForUser(user, id) {
  const r = await q('SELECT * FROM games WHERE id=$1 AND user_id=$2', [id, user.id]);
  return r.rows[0] ? loadGameRow(r.rows[0]) : null;
}
function gameStatsPayload(game) {
  const h = computeStats(game.moves.human || []);
  const b = computeStats(game.moves.bot || []);
  return {
    reason: game.reason, scores: game.scores,
    human: { best: h.best, longest: h.longest, optimal: h.optimal, total: h.total, uniqueCount: h.uniqueCount, optimalWords: h.optimalWords },
    bot: { best: b.best, longest: b.longest, optimal: b.optimal, total: b.total, uniqueCount: b.uniqueCount, optimalWords: b.optimalWords },
    eloDeltaHuman: game.eloDeltaHuman, eloDeltaBot: game.eloDeltaBot, eloAfterHuman: game.eloAfterHuman, eloAfterBot: game.eloAfterBot,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    // Static files
    if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/app.js') || pathname.startsWith('/style.css') || pathname.startsWith('/favicon') || pathname.startsWith('/assets/'))) {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      const safe = path.join(ROOT, 'public', file);
      if (!safe.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(safe)) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(safe);
      const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'text/html';
      res.writeHead(200, { 'Content-Type': type });
      return fs.createReadStream(safe).pipe(res);
    }
    if (pathname === '/api/guest' && req.method === 'POST') {
      // Per-device guest: no email/password screen in this slice.
      for (let attempt = 0; attempt < 3; attempt++) {
        const suffix = crypto.randomBytes(6).toString('hex');
        const username = `guest_${suffix}`;
        try {
          const salt = crypto.randomBytes(16).toString('hex');
          const hash = hashPassword(crypto.randomBytes(32).toString('hex'), salt);
          const r = await q('INSERT INTO users (email, username, first_name, last_name, password_salt, password_hash, elo, elo_high) VALUES ($1,$2,$3,$4,$5,$6,1000,1000) RETURNING id', [`${username}@guest.local`, username, 'Guest', '', salt, hash]);
          const user = await getUserById(r.rows[0].id);
          const token = crypto.randomBytes(32).toString('hex');
          await q('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, user.id]);
          return sendJson(res, 200, { token, user: publicUser(user) });
        } catch (e) {
          if (e.code === '23505' && attempt < 2) continue;
          throw e;
        }
      }
      return sendJson(res, 500, { error: 'Could not create guest.' });
    }
    if (pathname === '/api/define' && req.method === 'GET') {
      return sendJson(res, 200, getDefinition(url.searchParams.get('word') || ''));
    }
    if (pathname === '/api/games' && req.method === 'POST') {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const b = await readBody(req);
      const botType = b.bot === 'fishstick' ? 'fishstick' : 'competitive';
      const game = newGame(user, botType);
      // Do NOT run the bot here: the client shows the 5s think, then polls
      // GET, which advances the bot turn (see advanceBotTurnIfReady).
      await saveGameRow(game);
      const out = serializeGame(game, user);
      if (game.status === 'finished') out.stats = gameStatsPayload(game);
      return sendJson(res, 200, out);
    }
    const gameMatch = pathname.match(/^\/api\/games\/(\d+)(?:\/(validate|play|pass|forfeit|shuffle|start))?$/);
    if (gameMatch) {
      const user = await authUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      const game = await loadGameForUser(user, gameMatch[1]);
      if (!game) return sendJson(res, 404, { error: 'Game not found.' });
      const action = gameMatch[2];
      if (req.method === 'GET' && !action) {
        // Auto-advance timeout skips on read, so a timed-out player does not block the game.
        if (game.status === 'active') {
          await advanceBotTurnIfReady(game, user);
          settleClock(game);
          let guard = 0;
          while (game.status === 'active' && game.clocks[game.turn] <= 0 && guard++ < 5) {
            if (game.clocks.human <= 0 && game.clocks.bot <= 0) { await finishIfNeeded(game, user); break; }
            game.turn = game.turn === 'human' ? 'bot' : 'human';
            game.turnStartedAt = Date.now();
            if (game.turn === 'bot') {
              if (!game.botThinkUntil) game.botThinkUntil = Date.now() + 5000;
              if (Date.now() >= (game.botThinkUntil || game.turnStartedAt + 5000)) {
                const moved = runBotTurn(game);
                if (moved) stepBotClockTo20sMark(game);
                game.botThinkUntil = null;
              }
              if (await finishIfNeeded(game, user)) break;
            }
          }
          await saveGameRow(game);
        }
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game);
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
            game.clocks = { human: 300000, bot: 300000 };
            game.turnStartedAt = Date.now();
            game.botThinkUntil = game.turn === 'bot' ? Date.now() + 5000 : null;
            game.started = true;
            await saveGameRow(game);
          }
        }
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && action === 'shuffle') {
        const b = await readBody(req);
        const rack = b.rack;
        if (!Array.isArray(rack) || rack.length !== 6) return sendJson(res, 400, { error: 'Rack must have 6 tiles.' });
        const a = [...game.humanRack].sort().join('');
        const c = [...rack].sort().join('');
        if (a !== c) return sendJson(res, 400, { error: 'Rack does not match.' });
        game.humanRack = rack.map(String);
        await saveGameRow(game);
        return sendJson(res, 200, serializeGame(game, user));
      }
      if (req.method === 'POST' && action === 'validate') {
        if (game.status !== 'active' || game.turn !== 'human') return sendJson(res, 200, { valid: false, error: 'Not your turn.' });
        const b = await readBody(req);
        const placements = (b.placements || []).map(p => ({ row: Number(p.row), col: Number(p.col), letter: String(p.letter || '').toUpperCase() }));
        const v = validatePlay(game.board, game.humanRack, placements, game.premiums, boardIsEmpty(game.board));
        return sendJson(res, 200, v);
      }
      if (req.method === 'POST' && action === 'play') {
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        const b0 = await readBody(req);
        settleClock(game, b0.clientElapsedMs);
        if (game.turn !== 'human') return sendJson(res, 400, { error: 'Not your turn.' });
        if (game.clocks.human <= 0) {
          // Timed out: skip human, let the bot keep playing (you cannot win on time).
          startBotTurn(game);
          await saveGameRow(game);
          const out = serializeGame(game, user);
          if (game.status === 'finished') out.stats = gameStatsPayload(game);
          return sendJson(res, 200, { ...out, timedOut: true });
        }
        const b = b0;
        const placements = (b.placements || []).map(p => ({ row: Number(p.row), col: Number(p.col), letter: String(p.letter || '').toUpperCase() }));
        const isFirst = boardIsEmpty(game.board);
        const v = validatePlay(game.board, game.humanRack, placements, game.premiums, isFirst);
        if (!v.valid) return sendJson(res, 400, v);
        const bestMoves = findMoves(game.board, game.humanRack, isFirst, false);
        const bestScore = bestMoves.length ? bestMoves[0].score : null;
        applyMove(game, 'human', v, bestScore);
        startBotTurn(game);
        await saveGameRow(game);
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && action === 'pass') {
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        const bPass = await readBody(req).catch(() => ({}));
        settleClock(game, bPass.clientElapsedMs);
        if (game.turn !== 'human') return sendJson(res, 400, { error: 'Not your turn.' });
        game.clocks.human = Math.max(0, game.clocks.human - 30000);
        game.consecutivePasses++;
        game.consecutiveNoMoves = 0;
        game.lastHuman = { word: null, points: 0, passed: true };
        startBotTurn(game);
        if (game.consecutivePasses >= 2) {
          game.botThinkUntil = null;
          const winner = game.scores.human > game.scores.bot ? 'human' : game.scores.bot > game.scores.human ? 'bot' : 'draw';
          await endGame(game, user, 'Final score', winner);
        } else {
          // Bot turn is pending: client shows 5s think, then GET advances it.
        }
        await saveGameRow(game);
        const out = serializeGame(game, user);
        if (game.status === 'finished') out.stats = gameStatsPayload(game);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && action === 'forfeit') {
        if (game.status !== 'active') return sendJson(res, 400, { error: 'Game is finished.' });
        await endGame(game, user, 'By forfeit', 'bot');
        const out = serializeGame(game, user);
        out.stats = gameStatsPayload(game);
        return sendJson(res, 200, out);
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
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
  });
}).catch(e => { console.error('Postgres init failed:', e.message); process.exit(1); });
