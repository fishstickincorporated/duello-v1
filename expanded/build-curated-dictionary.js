// Build the v118 curated Duello dictionary: one short, most-common-sense
// definition per word, picked at build time from every source.
//   node expanded/build-curated-dictionary.js --analyze   (report only)
//   node expanded/build-curated-dictionary.js --fetch     (fetch the queue, resume-able)
//   node expanded/build-curated-dictionary.js --build     (write curated chunks + update server.js, app.js, build-client-defs.js, list_still.js)
//   node expanded/build-curated-dictionary.js --create-sheet  (create "Duello Dictionary" + full upload)
//   node expanded/build-curated-dictionary.js --update-sheet  (diff vs previous set, update only changed rows)
//   node expanded/build-curated-dictionary.js --all       (fetch + build, no sheet)
// Progress is saved incrementally to expanded/curated-progress.json so a
// stopped run resumes where it left off. Never invents a definition:
// a word with no publishable gloss anywhere stays uncovered and is
// reported, not filled with a placeholder.
const fs = require('fs'), path = require('path'), child_process = require('child_process');
const home = '/home/hatch/workspace/duello-botplay';
const DATA = path.join(home, 'data');
const EXP = path.join(home, 'expanded');
const PROGRESS = path.join(EXP, 'curated-progress.json');
const OVERRIDES_FILE = path.join(EXP, 'definition-overrides.json');
const PREVIOUS_FILE = path.join(EXP, 'curated-previous.json');
const SHEET_FILE = path.join(EXP, 'dictionary-sheet.md');

const WORDS = new Set(fs.readFileSync(path.join(DATA, 'words.txt'), 'utf8').split('\n').filter(Boolean));
const WORD_ARR = [...WORDS].sort();

// --- server helpers (verbatim, for stemCandidates / coreWordFromDef) ---
const srvText = fs.readFileSync(path.join(home, 'server.js'), 'utf8');
const rStart = srvText.indexOf('const DEF_PLACEHOLDER');
const rEnd = srvText.indexOf('// Live fallback for words');
eval(srvText.slice(rStart, rEnd)); // stemCandidates, coreWordFromDef, JEFF2_POS, resolvedBundledDef, bundledDefinition (over the DEFS loaded below)
const DEF_PLACEHOLDER = 'a valid word in the Duello word list';

// --- candidate sources: separate per-word lists (NOT last-writer-wins) ---
const LAYERS = [
  ['wordnet', 'definitions.json'],
  ['webster', 'definitions-extra-a.json'],
  ['webster', 'definitions-extra-b.json'],
  ['webster', 'definitions-extra-c.json'],
  ['wiktionary', 'definitions-extra-d.json'],
  ['wiktionary', 'definitions-extra-e.json'],
  ['wiktionary', 'definitions-extra-f.json'],
  ['wiktionary', 'definitions-extra-g.json'],
];
const CANDS = {}; // WORD -> [{pos, def, src}]
function addCand(w, pos, def, src) {
  if (!w || !def) return;
  (CANDS[w] = CANDS[w] || []).push({ pos: pos || '', def: String(def), src });
}
for (const [src, f] of LAYERS) {
  try {
    const chunk = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
    for (const [w, e] of Object.entries(chunk)) addCand(w, e.pos, e.def, src);
  } catch {}
}
try {
  const raw = JSON.parse(fs.readFileSync(path.join(EXP, 'kaikki-raw.json'), 'utf8'));
  for (const [w, e] of Object.entries(raw)) addCand(w, e.pos, e.def, 'wiktionary');
} catch {}
try {
  const wd = JSON.parse(fs.readFileSync(path.join(EXP, 'wiktionary_defs.json'), 'utf8'));
  for (const [w, e] of Object.entries(wd)) addCand(w, e.pos, e.def, 'wiktionary');
} catch {}
try {
  const fill = JSON.parse(fs.readFileSync(path.join(EXP, 'fill-h-raw.json'), 'utf8'));
  for (const [w, e] of Object.entries(fill)) addCand(w, e.pos, e.def, 'fill');
} catch {}

// --- shortening (validated in expanded/curated-analyze.js) ---
const GENERIC = new Set(('organ thing person place substance device machine animal plant food material part piece unit amount act action state quality event process method system body object item kind type sort form member one organism species being creature structure instrument tool container area period group set word term name sound color colour shape number point feature condition activity movement motion').split(' '));
const GENERIC_ALL = new Set([...GENERIC, ...[...GENERIC].map(g => g + 's'), 'people', 'children', 'men', 'women']);
const DANGLING = new Set(('a an the of to and or with for from by in on at into over under through without upon about between among per via off out up down across along behind below beside beyond inside outside near toward towards against within as is are was were be been being has have had do does did its his her their this that these those it he she they we you i me him us them who whom whose which what my your our mine yours ours theirs any some no not each every all both either neither one two three if when while after before although though because since unless until whereas nor but yet so than then such own more most other another same different').split(' '));
function stripHtml(t) {
  let s = String(t || '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function firstSentence(d) {
  const end = d.search(/[.!?](?=\s+[A-Z]|$)/);
  if (end >= 0) d = d.slice(0, end + 1).trim();
  return d;
}
function stripParens(d) {
  let prev;
  do { prev = d; d = d.replace(/\([^()]*\)/g, '').replace(/\[[^\[\]]*\]/g, ''); } while (d !== prev);
  return d.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/, '$1').trim();
}
function stripBinomial(d) {
  const m = d.match(/,\s*([A-Z][a-z]+)\s+[a-z]+\.?$/);
  if (m && !WORDS.has(m[1].toUpperCase())) return d.slice(0, m.index).trim();
  return d;
}
function lastWord(s) { const t = String(s || '').toLowerCase().match(/[a-z]+/g); return t ? t[t.length - 1] : ''; }
function endsDangling(s) { return DANGLING.has(lastWord(s)); }
function endsGeneric(s) { return GENERIC_ALL.has(lastWord(s)); }
const CLAUSE_RE = /\b(which|that|who|whom|whose)\b|\bclosely related\b|\bused (?:for|as|to|in)\b|\b(?:obtained|derived|made|formed|produced) (?:from|of|with|by)\b|\bfound in\b|\bconsisting of\b|\bcharacterized by\b|\bknown as\b|\bcalled\b/;
function shorten(rawDef) {
  let t = firstSentence(stripHtml(rawDef));
  if (!t) return null;
  t = stripParens(t);
  t = stripBinomial(t);
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/, '$1').trim();
  if (!t) return null;
  for (const sep of [',', ';', ':']) {
    const i = t.indexOf(sep);
    if (i >= 10) {
      const head = t.slice(0, i).trim();
      if (head.length >= 10 && !endsDangling(head)) { t = head; break; }
    }
  }
  const ci = t.search(CLAUSE_RE);
  if (ci > 0) {
    const head = t.slice(0, ci).trim();
    if (head.length >= 10 && !endsDangling(head) && !endsGeneric(head)) t = head;
  }
  t = t.replace(/\s{2,}/g, ' ').trim();
  if (!/[.!?]$/.test(t)) t += '.';
  if (t.replace(/[.!?]+$/, '') === DEF_PLACEHOLDER) return null;
  return t;
}
// Extended pointer detector (kaikki-resolve.js buildCoreWordFromDef).
function buildCoreWordFromDef(def) {
  const serverCore = coreWordFromDef(def);
  if (serverCore) return serverCore;
  const d = String(def || '').trim();
  let m = d.match(/^(?:simple past (?:tense )?and past participle|simple past|present participle and gerund|third-person singular simple present indicative(?: form)?|comparative form|superlative form|alternative (?:letter-case )?form|alternative irregular form|alternative spelling|obsolete (?:form|spelling)|archaic (?:form|spelling)|dated (?:form|spelling)|misspelling|abbreviation|acronym|initialism|contraction|clipping|diminutive|variant spelling|feminine (?:singular|plural)|masculine (?:singular|plural)|neuter (?:singular|plural)) of ([A-Za-z][A-Za-z\-']*)/i);
  if (m) return m[1].toUpperCase();
  m = d.match(/^(?:a|an|the) plural of ([A-Za-z][A-Za-z\-']*)/i);
  if (m) return m[1].toUpperCase();
  return null;
}
function isRareMarker(def) {
  const d = String(def || '');
  if (/NATO|ICAO/i.test(d)) return 'nato';
  if (/\[Obs\.\]/i.test(d) || /\bobsolete\b/i.test(d) || /\barchaic\b/i.test(d)) return 'obsolete';
  if (/\[Prov\.\]/i.test(d)) return 'provincial';
  if (/\(\d{3,4}\s*[-–]\s*\d{3,4}\)/.test(d)) return 'person-dates';
  return null;
}
function isCircular(def, word) {
  const STOP = new Set(['to', 'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'by', 'as', 'at', 'be', 'is', 'are', 'was', 'were', 'it', 'its', 'this', 'that', 'one']);
  const toks = String(def || '').toLowerCase().match(/[a-z]+/g) || [];
  const stem = (t) => { let s = t; for (const suf of ['ing', 'ed', 'es', 's']) if (s.length > suf.length + 1 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; } if (s.length >= 3 && s[s.length - 1] === s[s.length - 2]) s = s.slice(0, -1); return s; };
  const rest = toks.filter(t => !STOP.has(t) && stem(t) !== stem(word.toLowerCase()));
  return rest.length === 0;
}
const DOMAIN_RE = /\bin (baseball|cricket|golf|law|music|medicine|botany|zoology|anatomy|chemistry|physics|mathematics|grammar|nautical|military|heraldry|ecclesiastical|scots|geology|astronomy|architecture|surgery|printing|engraving|painting|poetry|logic|rhetoric|theology|mining|fencing|billiards|tennis|hunting|fishing|agriculture|carpentry|masonry)\b/i;
const SRC_PRI = { dictapi: 0, fill: 1, wiktionary: 2, wordnet: 3, webster: 4, override: -1 };
// Overrides (Jeff's own definitions only): applied last, highest priority.
const DEFAULT_OVERRIDES = {
  ONE: { pos: 'noun', def: 'The number 1.' },
  EYES: { pos: 'noun', def: 'An organ through which animals see.' },
  KOB: { pos: 'noun', def: 'An African antelope.' },
};
let OVERRIDES = {};
try { OVERRIDES = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')); } catch { OVERRIDES = { ...DEFAULT_OVERRIDES }; }
// Resolve a pointer candidate to the core word's pick (depth <= 3).
// Returns {pos, def, src} or null.
function resolvePointer(word, seen) {
  const w = String(word || '').toUpperCase();
  if (seen && seen.has(w)) return null;
  const cands = (CANDS[w] || []).filter(c => buildCoreWordFromDef(c.def));
  for (const c of cands) {
    const core = buildCoreWordFromDef(c.def);
    if (!core || core === w) continue;
    const nextSeen = new Set(seen || []); nextSeen.add(w);
    const corePick = pickWord(core, nextSeen);
    if (corePick) return { pos: c.pos || corePick.pos || '', def: corePick.def, src: corePick.src };
  }
  return null;
}
function pickWord(word, seen) {
  const w = String(word || '').toUpperCase();
  if (OVERRIDES[w]) return { pos: OVERRIDES[w].pos || '', def: OVERRIDES[w].def, src: 'override' };
  const cands = (CANDS[w] || []).map(c => {
    const short = shorten(c.def);
    return { pos: c.pos || '', def: c.def, short, src: c.src, domain: DOMAIN_RE.test(short || '') || DOMAIN_RE.test(c.def) };
  }).filter(c => {
    if (!c.short || c.short.length < 4 || c.short.length > 150) return false;
    if (buildCoreWordFromDef(c.def) || buildCoreWordFromDef(c.short)) return false;
    if (isCircular(c.short, w)) return false;
    if (isRareMarker(c.short) || isRareMarker(c.def)) return false;
    return true;
  });
  if (cands.length) {
    const pool = cands.some(c => !c.domain) ? cands.filter(c => !c.domain) : cands;
    const minLen = Math.min(...pool.map(c => c.short.length));
    const near = pool.filter(c => c.short.length <= minLen + 3);
    near.sort((a, b) => (SRC_PRI[a.src] - SRC_PRI[b.src]) || (a.short.length - b.short.length));
    const best = near[0];
    return { pos: best.pos, def: best.short, src: best.src };
  }
  // No direct candidate survived: resolve a pointer to its core.
  return resolvePointer(w, seen);
}
// Direct curated map: WORD -> {pos, def, src} (base words only;
// inflected forms resolve at runtime via bundledDefinition stemming).
function buildDirectMap() {
  const direct = {};
  for (const w of WORD_ARR) {
    const p = pickWord(w, null);
    if (p) direct[w] = p;
  }
  return direct;
}
// Resolved map: every word with a definition, direct or via a stem
// base (this is what the client bundle and the Sheet show).
function buildResolvedMap(direct) {
  const resolved = {};
  for (const w of WORD_ARR) {
    if (direct[w]) { resolved[w] = { ...direct[w], via: null }; continue; }
    const cands = [...stemCandidates(w)];
    for (const c of [...cands]) for (const c2 of stemCandidates(c)) if (!cands.includes(c2)) cands.push(c2);
    for (const base of cands) {
      if (direct[base]) { resolved[w] = { pos: direct[base].pos, def: direct[base].def, src: direct[base].src, via: base }; break; }
    }
  }
  return resolved;
}
function log(s) { console.log(new Date().toISOString() + ' ' + s); }

// ---------- fetch mode ----------
const WIKT_MS = process.env.WIKT_MS ? parseInt(process.env.WIKT_MS, 10) : 3000; // Wiktionary spacing; Nov 16: 1000ms 429'd after ~17 reqs
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class RateLimited extends Error { constructor(src, status) { super('rate-limited ' + src + ' ' + status); this.src = src; this.status = status; } }
async function fetchJson(url, ms, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, headers }); }
  catch { return null; } finally { clearTimeout(timer); }
}
const POS_MAP = { adj: 'adjective', adv: 'adverb', prep: 'preposition', conj: 'conjunction', interj: 'interjection', pron: 'pronoun', det: 'determiner', num: 'numeral', art: 'article', 'proper noun': 'name', exclamation: 'interjection' };
function mapPos(p) { const k = String(p || '').trim().toLowerCase(); return POS_MAP[k] || k || ''; }
// First whole, real gloss from dictionaryapi (mirrors server fetchDictApi).
async function fetchDictApi(wordLower) {
  const r = await fetchJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(wordLower), 10000, { 'Accept': 'application/json' });
  if (!r) return null;
  if (r.status === 429 || r.status === 403) throw new RateLimited('dictionaryapi', r.status);
  if (!r.ok) return null;
  let arr; try { arr = await r.json(); } catch { return null; }
  const meanings = Array.isArray(arr) && arr[0] && arr[0].meanings;
  if (!meanings) return null;
  let first = null;
  for (const meaning of meanings) {
    const defs = (meaning && meaning.definitions) || [];
    for (const d of defs) {
      if (!d || !d.definition) continue;
      const c = stripHtml(d.definition);
      if (!c) continue;
      if (!first) first = { pos: mapPos(meaning.partOfSpeech), definition: c };
      const short = shorten(c);
      if (!buildCoreWordFromDef(c) && !isCircular(c, wordLower) && short && short.length <= 150) {
        return { pos: mapPos(meaning.partOfSpeech), definition: c };
      }
    }
  }
  return first;
}
async function fetchWikt(wordLower) {
  const r = await fetchJson('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(wordLower), 10000, { 'User-Agent': 'Duello/1.0 (definition prefetch)', 'Accept': 'application/json' });
  if (!r) return null;
  if (r.status === 429 || r.status === 403) throw new RateLimited('wiktionary', r.status);
  if (!r.ok) return null;
  let data; try { data = await r.json(); } catch { return null; }
  const entries = (data && data.en) || [];
  for (const e of entries) {
    const defs = (e.definitions || []).map(x => x && x.definition).filter(Boolean).map(stripHtml).filter(Boolean);
    for (const c of defs) {
      const short = shorten(c);
      if (!buildCoreWordFromDef(c) && !isCircular(c, wordLower) && short && short.length <= 150) return { pos: mapPos(e.partOfSpeech), definition: c };
    }
    if (defs[0]) return { pos: mapPos(e.partOfSpeech), definition: defs[0] };
  }
  return null;
}
function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch { return { fetched: {}, missed: {}, queue: [], queueBuilt: false }; }
}
// Build the fetch queue (priority order): 1) truly uncovered words
// (no direct pick and no stem-resolved pick), 2) words <=5 letters
// (insurance: let dictionaryapi's most-common first sense compete
// with the bundled pick), 3) domain-marked gloss words.
function buildQueue() {
  const direct = buildDirectMap();
  const resolved = buildResolvedMap(direct);
  const uncovered = WORD_ARR.filter(w => !resolved[w]);
  const q = [], seen = new Set();
  const push = (w, pri) => { if (!seen.has(w)) { seen.add(w); q.push({ w, pri }); } };
  for (const w of uncovered) push(w, 1);
  // Priority 2 insurance: skip words whose bundled pick is already a
  // Wiktionary modern first sense (or Jeff's own override) — those are
  // already the common sense, so a dictionaryapi fetch adds nothing.
  for (const w of WORD_ARR) {
    if (w.length > 5) continue;
    const p = direct[w];
    if (p && (p.src === 'wiktionary' || p.src === 'override')) continue;
    push(w, 2);
  }
  for (const w of WORD_ARR) {
    const cands = CANDS[w] || [];
    if (cands.some(c => DOMAIN_RE.test(c.def))) push(w, 3);
  }
  return { queue: q, uncoveredCount: uncovered.length };
}
async function runFetch() {
  const prog = loadProgress();
  if (!prog.queueBuilt) {
    const { queue, uncoveredCount } = buildQueue();
    prog.queue = queue; prog.queueBuilt = true; prog.uncoveredCount = uncoveredCount;
    fs.writeFileSync(PROGRESS, JSON.stringify(prog));
    log('queue built: ' + queue.length + ' words (truly uncovered: ' + uncoveredCount + ')');
  }
  const queue = prog.queue;
  let done = 0, found = 0, foundDictapi = 0, foundWikt = 0, missedN = 0;
  let savedAt = 0;
  const save = (force) => {
    const now = Date.now();
    if (!force && now - savedAt < 15000) return;
    fs.writeFileSync(PROGRESS, JSON.stringify(prog));
    savedAt = now;
  };
  log('fetch: ' + queue.length + ' queued, ' + Object.keys(prog.fetched).length + ' already fetched, ' + Object.keys(prog.missed).length + ' already missed');
  try {
    for (let i = 0; i < queue.length; i++) {
      const { w, pri } = queue[i];
      if (prog.fetched[w] || prog.missed[w]) continue;
      const lower = w.toLowerCase();
      let e = null, src = null;
      try { e = await fetchDictApi(lower); if (e) src = 'dictapi'; } catch (err) { if (err instanceof RateLimited) throw err; }
      if (!e && pri === 1) {
        await sleep(WIKT_MS);
        try { e = await fetchWikt(lower); if (e) src = 'wiktionary'; } catch (err) { if (err instanceof RateLimited) throw err; }
      }
      if (e) {
        prog.fetched[w] = { pos: e.pos, def: e.definition, src };
        found++; if (src === 'dictapi') foundDictapi++; else foundWikt++;
        // A pointer gloss needs its core fetched too, so the build can
        // resolve it: queue the core even when it is not itself a
        // playable word (OES -> O: the letter O is not in the word
        // list, but its live definition is what OES resolves to).
        const core = buildCoreWordFromDef(e.definition);
        if (core && /^[A-Z][A-Z\-']*$/.test(core) && !CANDS[core] && !prog.fetched[core] && !prog.missed[core] && !queue.some(q => q.w === core)) {
          queue.push({ w: core, pri: 1 });
        }
      } else {
        prog.missed[w] = { pri, at: new Date().toISOString() };
        missedN++;
      }
      done++;
      save(false);
      if (done % 100 === 0) log('fetch progress ' + done + ' attempted, ' + found + ' found (dictapi ' + foundDictapi + ', wikt ' + foundWikt + '), queue now ' + queue.length);
      await sleep(500); // dictionaryapi spacing (~2/sec)
    }
  } catch (err) {
    save(true);
    if (err instanceof RateLimited) { log('STOP: ' + err.message + ' after ' + done + ' attempts, ' + found + ' found'); process.exitCode = 3; return; }
    throw err;
  }
  save(true);
  log('fetch DONE: attempted ' + done + ', found ' + found + ' (dictapi ' + foundDictapi + ', wikt ' + foundWikt + '), missed ' + missedN + ', total fetched ' + Object.keys(prog.fetched).length);
}

// ---------- build mode ----------
const CHUNK_MAX = 700000;
function fmtEntry(v) { return '{"pos": ' + JSON.stringify(v.pos) + ', "def": ' + JSON.stringify(v.def) + '}'; }
function fmtChunk(entries) { return '{' + entries.map(([k, v]) => JSON.stringify(k) + ': ' + fmtEntry(v)).join(', ') + '}'; }
function writeCuratedChunks(direct) {
  const sorted = Object.keys(direct).sort();
  const chunks = [];
  let cur = [], curBytes = 2;
  for (const w of sorted) {
    const piece = JSON.stringify(w) + ': ' + fmtEntry(direct[w]);
    const add = (cur.length ? 2 : 0) + Buffer.byteLength(piece, 'utf8');
    if (cur.length && curBytes + add > CHUNK_MAX) { chunks.push(cur); cur = []; curBytes = 2; }
    cur.push([w, direct[w]]);
    curBytes += add;
  }
  if (cur.length) chunks.push(cur);
  // Clear stale curated chunks from an earlier build.
  for (const f of fs.readdirSync(DATA)) if (/^definitions-curated-[a-z]\.json$/.test(f)) fs.unlinkSync(path.join(DATA, f));
  const names = [];
  chunks.forEach((entries, i) => {
    const name = 'definitions-curated-' + String.fromCharCode(97 + i) + '.json';
    fs.writeFileSync(path.join(DATA, name), fmtChunk(entries));
    names.push(name);
    log('wrote data/' + name + ' entries=' + entries.length + ' bytes=' + fs.statSync(path.join(DATA, name)).size);
  });
  return names;
}
// Replace the old bundled-source block in server.js (base definitions.json
// load + the a-c / d-g chunk loops) with the curated chunk loop. The
// one-time getDefinition / resolveLiveMorph changes are separate edits.
function updateServerChunkList(names) {
  const p = path.join(home, 'server.js');
  const text = fs.readFileSync(p, 'utf8');
  const startMarker = "try { DEFS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'definitions.json'), 'utf8')); } catch (e) { DEFS = {}; }";
  const endMarker = "for (const extraFile of ['definitions-extra-d.json', 'definitions-extra-e.json', 'definitions-extra-f.json', 'definitions-extra-g.json']) loadDefsFile(extraFile, 'wiktionary');";
  const si = text.indexOf(startMarker);
  const ei = text.indexOf(endMarker);
  if (si < 0 || ei < 0) {
    // Already on the curated chunks (v118+): the chunk list is the same
    // names, so server.js needs no edit. Do NOT exit — runBuild must
    // still save curated-current.json for the sheet diff.
    log('server.js already loads the curated chunks — no edit needed');
    return;
  }
  const end = ei + endMarker.length;
  const list = names.map(n => "'" + n + "'").join(', ');
  const replacement = [
    '// Curated dictionary (v118): one short, most-common-sense definition',
    '// per word, built by expanded/build-curated-dictionary.js. The curated',
    '// chunks are the ONLY bundled source now — the old base file and',
    '// extras a-g stay on disk as raw material but are not loaded, so a',
    '// rejected gloss (a rare sense, a pointer, a proper name) can never',
    '// resurface through the base file.',
    'try { DEFS = {}; } catch (e) { DEFS = {}; }',
    "for (const extraFile of [" + list + "]) loadDefsFile(extraFile, 'curated');",
  ].join('\n');
  fs.writeFileSync(p, text.slice(0, si) + replacement + text.slice(end));
  log('server.js chunk list updated to the curated chunks');
}
function loadFetchedIntoCands() {
  const prog = loadProgress();
  let n = 0;
  for (const [w, e] of Object.entries(prog.fetched || {})) {
    addCand(w, e.pos, e.def, e.src || 'dictapi');
    n++;
  }
  return n;
}
function runAnalyze() {
  const direct = buildDirectMap();
  const resolved = buildResolvedMap(direct);
  const uncovered = WORD_ARR.filter(w => !resolved[w]);
  const lens = Object.values(direct).map(v => v.def.length).sort((a, b) => a - b);
  const pct = (q) => lens[Math.floor(lens.length * q)];
  console.log('direct curated entries:', Object.keys(direct).length);
  console.log('resolved (direct or via stem):', Object.keys(resolved).length, '/', WORD_ARR.length);
  console.log('truly uncovered:', uncovered.length, uncovered.slice(0, 20).join(' '));
  console.log('length: median', pct(0.5), '| p90', pct(0.9), '| max', lens[lens.length - 1]);
  console.log('under 75:', lens.filter(l => l < 75).length, '(' + (100 * lens.filter(l => l < 75).length / lens.length).toFixed(1) + '%)');
  console.log('under 50:', lens.filter(l => l < 50).length, '(' + (100 * lens.filter(l => l < 50).length / lens.length).toFixed(1) + '%)');
  console.log('over 150:', lens.filter(l => l > 150).length);
  for (const w of ['ONE', 'EYES', 'KOB', 'RUN', 'CRANE', 'OES', 'SAGO']) {
    const p = direct[w];
    const r = resolved[w];
    console.log(w + ': direct=' + (p ? '(' + p.pos + ') ' + p.def + ' [' + p.src + ']' : 'NONE') + ' | resolved=' + (r ? r.def + (r.via ? ' (via ' + r.via + ')' : '') : 'NONE'));
  }
}
function runRefreshCurrent() {
  // v203 fix (Nov 27, 2026): regenerate curated-current.json from the
  // current on-disk data WITHOUT rewriting chunks or patching server.js /
  // app.js (what --build does). The sheet diff baseline had gone stale:
  // the 9 v199 months were added to the curated chunks by hand, so
  // pickWord could not reproduce them until they were also added to
  // definition-overrides.json — and curated-current.json predated them.
  const fetchedN = loadFetchedIntoCands();
  log('loaded ' + fetchedN + ' fetched candidates into the pick');
  const direct = buildDirectMap();
  const resolved = buildResolvedMap(direct);
  fs.writeFileSync(path.join(EXP, 'curated-current.json'), JSON.stringify(resolved));
  const uncovered = WORD_ARR.filter(w => !resolved[w]);
  log('REFRESH DONE: direct=' + Object.keys(direct).length + ' resolved=' + Object.keys(resolved).length + ' uncovered=' + uncovered.length);
}
function runBuild() {
  // Overrides file (create with the three gold standards if absent).
  if (!fs.existsSync(OVERRIDES_FILE)) {
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(DEFAULT_OVERRIDES, null, 2) + '\n');
    log('wrote ' + OVERRIDES_FILE);
    OVERRIDES = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
  }
  const fetchedN = loadFetchedIntoCands();
  log('loaded ' + fetchedN + ' fetched candidates into the pick');
  const direct = buildDirectMap();
  const resolved = buildResolvedMap(direct);
  const names = writeCuratedChunks(direct);
  updateServerChunkList(names);
  // Save the new resolved set as the current set (the sheet diff
  // baseline, curated-previous.json, is only advanced by --update-sheet
  // after the Sheet itself is synced).
  fs.writeFileSync(path.join(EXP, 'curated-current.json'), JSON.stringify(resolved));
  const uncovered = WORD_ARR.filter(w => !resolved[w]);
  fs.writeFileSync(path.join(EXP, 'still_uncovered-curated.txt'), uncovered.join('\n') + (uncovered.length ? '\n' : ''));
  const lens = Object.values(direct).map(v => v.def.length).sort((a, b) => a - b);
  const pct = (q) => lens[Math.floor(lens.length * q)];
  log('BUILD DONE: direct=' + Object.keys(direct).length + ' resolved=' + Object.keys(resolved).length + ' uncovered=' + uncovered.length + ' chunks=' + names.length);
  log('length: median ' + pct(0.5) + ' | p90 ' + pct(0.9) + ' | max ' + lens[lens.length - 1] + ' | under75 ' + (100 * lens.filter(l => l < 75).length / lens.length).toFixed(1) + '% | under50 ' + (100 * lens.filter(l => l < 50).length / lens.length).toFixed(1) + '% | over150 ' + lens.filter(l => l > 150).length);
  log('still_uncovered-curated.txt written (' + uncovered.length + ' words)');
  return { direct, resolved, names, uncovered };
}

// ---------- Google Sheet modes ----------
const GWS = '/opt/hatch/bin/hatch_gws_cli';
function gws(args) {
  // spawnSync with an argv array (no shell): definitions contain
  // apostrophes and the occasional $ — shell quoting would mangle them.
  const r = child_process.spawnSync(GWS, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  const out = (r.stdout || '').trim();
  try { return JSON.parse(out); } catch { return { _raw: out, _stderr: (r.stderr || '').trim(), _status: r.status }; }
}
function sheetRows(resolved) {
  // Sorted A-Z. Source: the pick's origin; stem-resolved rows say so.
  return Object.keys(resolved).sort().map(w => {
    const e = resolved[w];
    const src = e.via ? (e.src + ' (via ' + e.via + ')') : e.src;
    return [w, e.pos || '', e.def, src];
  });
}
function loadSheetMeta() {
  try { return JSON.parse(fs.readFileSync(SHEET_FILE, 'utf8')); } catch { return null; }
}
function runCreateSheet() {
  const currentPath = path.join(EXP, 'curated-current.json');
  if (!fs.existsSync(currentPath)) { console.error('ERROR: run --build first (curated-current.json missing)'); process.exit(1); }
  const resolved = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const rows = sheetRows(resolved);
  const created = gws(['sheets', 'spreadsheets', 'create', '--json', JSON.stringify({ properties: { title: 'Duello Dictionary' } })]);
  const id = created.spreadsheetId;
  if (!id) { console.error('ERROR: sheet create failed:', JSON.stringify(created).slice(0, 500)); process.exit(1); }
  const url = created.spreadsheetUrl || ('https://docs.google.com/spreadsheets/d/' + id);
  log('created sheet ' + id);
  // Header row.
  gws(['sheets', 'spreadsheets', 'values', 'update', '--params', JSON.stringify({ spreadsheetId: id, range: 'A1:D1', valueInputOption: 'RAW' }), '--json', JSON.stringify({ range: 'A1:D1', values: [['Word', 'Part of speech', 'Definition', 'Source']] })]);
  // Data in batches (RAW: definitions are data, never formulas).
  // BATCH 500: each --json argv must stay under the kernel's 128KB
  // per-argument limit — 5000 rows (~380KB) fails with E2BIG.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = gws(['sheets', 'spreadsheets', 'values', 'append', '--params', JSON.stringify({ spreadsheetId: id, range: 'A:D', valueInputOption: 'RAW' }), '--json', JSON.stringify({ values: batch })]);
    log('appended rows ' + (i + 1) + '-' + (i + batch.length) + ' / ' + rows.length);
  }
  // Freeze the header, widen the columns.
  gws(['sheets', 'spreadsheets', 'batchUpdate', '--params', JSON.stringify({ spreadsheetId: id }), '--json', JSON.stringify({ requests: [
    { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 110 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 520 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 170 }, fields: 'pixelSize' } },
  ] })]);
  // Verify a sample reads back.
  const check = gws(['sheets', 'spreadsheets', 'values', 'get', '--params', JSON.stringify({ spreadsheetId: id, range: 'A1:D3' })]);
  log('verify readback: ' + JSON.stringify((check.values || []).slice(0, 3)));
  fs.writeFileSync(SHEET_FILE, JSON.stringify({ spreadsheetId: id, url, rows: rows.length, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  fs.copyFileSync(currentPath, PREVIOUS_FILE);
  log('SHEET DONE: ' + url + ' (' + rows.length + ' rows). Baseline saved to curated-previous.json.');
}
function runUpdateSheet() {
  const meta = loadSheetMeta();
  if (!meta || !meta.spreadsheetId) { console.error('ERROR: no sheet recorded in dictionary-sheet.md — run --create-sheet first'); process.exit(1); }
  const id = meta.spreadsheetId;
  const currentPath = path.join(EXP, 'curated-current.json');
  if (!fs.existsSync(currentPath)) { console.error('ERROR: run --build first (curated-current.json missing)'); process.exit(1); }
  if (!fs.existsSync(PREVIOUS_FILE)) { console.error('ERROR: no baseline (curated-previous.json) — run --create-sheet first'); process.exit(1); }
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const previous = JSON.parse(fs.readFileSync(PREVIOUS_FILE, 'utf8'));
  const added = [], changed = [], removed = [];
  for (const w of Object.keys(current)) {
    if (!previous[w]) added.push(w);
    else if (previous[w].def !== current[w].def || previous[w].pos !== current[w].pos || previous[w].src !== current[w].src || previous[w].via !== current[w].via) changed.push(w);
  }
  for (const w of Object.keys(previous)) if (!current[w]) removed.push(w);
  log('sheet diff: added ' + added.length + ', changed ' + changed.length + ', removed ' + removed.length);
  if (!added.length && !changed.length && !removed.length) { log('sheet already current — no API calls made'); return; }
  // Current word -> row index (header is row 1; data starts row 2).
  const colA = gws(['sheets', 'spreadsheets', 'values', 'get', '--params', JSON.stringify({ spreadsheetId: id, range: 'A2:A' })]);
  const wordsInSheet = (colA.values || []).map(r => r[0]);
  const rowOf = {};
  wordsInSheet.forEach((w, i) => { rowOf[w] = i + 2; });
  // Removals first, bottom-up in one batch (deleting the highest row
  // first leaves lower rows valid — this half was correct).
  const removedRows = removed.map(w => rowOf[w]).filter(Boolean).sort((a, b) => b - a);
  if (removedRows.length) {
    // Chunk the deletions: each --json argv must stay under the kernel's
    // 128KB per-argument limit (v211: 8,807 NWL removals ≈ 925KB in one
    // batch). Chunks run in descending order so the bottom-up invariant
    // holds across batches (a deletion only shifts rows below it, which
    // were already deleted).
    for (let i = 0; i < removedRows.length; i += 500) {
      const chunk = removedRows.slice(i, i + 500);
      gws(['sheets', 'spreadsheets', 'batchUpdate', '--params', JSON.stringify({ spreadsheetId: id }), '--json', JSON.stringify({ requests: chunk.map(r => ({ deleteDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: r - 1, endIndex: r } } })) })]);
    }
    log('applied ' + removedRows.length + ' row deletions');
  }
  const rowFor = (w) => {
    const e = current[w];
    const src = e.via ? (e.src + ' (via ' + e.via + ')') : e.src;
    return [w, e.pos || '', e.def, src];
  };
  // Added rows, one at a time, bottom-up (highest computed row first):
  // insert the blank row, then IMMEDIATELY write its values at that row.
  // The old code batched all inserts in one call and then looked the
  // added words up BY NAME in a re-read column — but the inserted rows
  // are blank, so the lookup missed every added word and no values were
  // ever written (Nov 27, 2026: 9 month rows inserted blank, 3 inserts
  // never landed at all; MACH/MACHS missing from the sheet since Nov 18
  // the same way). Bottom-up keeps each computed row valid at its turn
  // (an insert only shifts rows at or below it, and already-written rows
  // travel with their content when shifted).
  const remaining = wordsInSheet.filter(w => !removed.includes(w));
  const addedSorted = [...added].sort();
  const inserts = [];
  for (const w of addedSorted) {
    let idx = 0;
    while (idx < remaining.length && remaining[idx] < w) idx++;
    inserts.push({ w, row: idx + 2 }); // 1-based row (header + idx)
  }
  inserts.sort((a, b) => b.row - a.row);
  for (const ins of inserts) {
    gws(['sheets', 'spreadsheets', 'batchUpdate', '--params', JSON.stringify({ spreadsheetId: id }), '--json', JSON.stringify({ requests: [{ insertDimension: { range: { sheetId: 0, dimension: 'ROWS', startIndex: ins.row - 1, endIndex: ins.row }, inheritFromBefore: true } }] })]);
    gws(['sheets', 'spreadsheets', 'values', 'update', '--params', JSON.stringify({ spreadsheetId: id, range: 'A' + ins.row + ':D' + ins.row, valueInputOption: 'RAW' }), '--json', JSON.stringify({ range: 'A' + ins.row + ':D' + ins.row, values: [rowFor(ins.w)] })]);
  }
  if (inserts.length) log('inserted + wrote ' + inserts.length + ' added rows');
  // Changed rows: they already exist in the sheet, so a name lookup works.
  const colA2 = gws(['sheets', 'spreadsheets', 'values', 'get', '--params', JSON.stringify({ spreadsheetId: id, range: 'A2:A' })]);
  const rowOf2 = {};
  (colA2.values || []).forEach((r, i) => { if (r[0]) rowOf2[r[0]] = i + 2; });
  const data = [];
  for (const w of changed) if (rowOf2[w]) data.push({ range: 'A' + rowOf2[w] + ':D' + rowOf2[w], values: [rowFor(w)] });
  if (data.length) {
    // Chunk the writes: each --json argv must stay under the kernel's
    // 128KB per-argument limit (see runCreateSheet).
    for (let i = 0; i < data.length; i += 500) {
      gws(['sheets', 'spreadsheets', 'values', 'batchUpdate', '--params', JSON.stringify({ spreadsheetId: id }), '--json', JSON.stringify({ valueInputOption: 'RAW', data: data.slice(i, i + 500) })]);
    }
    log('wrote ' + data.length + ' changed rows');
  }
  // Verify before advancing the baseline: every added + changed word
  // must actually be in the sheet. A silent partial failure here used
  // to advance the baseline and declare the sheet synced while rows
  // were blank or missing.
  const verify = gws(['sheets', 'spreadsheets', 'values', 'get', '--params', JSON.stringify({ spreadsheetId: id, range: 'A2:A' })]);
  const inSheet = new Set((verify.values || []).map(r => r[0]).filter(Boolean));
  const missing = [...added, ...changed].filter(w => !inSheet.has(w));
  if (missing.length) throw new Error('SHEET VERIFY FAILED — missing after update: ' + missing.join(' ') + ' (baseline NOT advanced)');
  log('verified ' + added.length + ' added + ' + changed.length + ' changed rows present in sheet');
  fs.copyFileSync(currentPath, PREVIOUS_FILE);
  const m = loadSheetMeta();
  m.rows = Object.keys(current).length; m.updatedAt = new Date().toISOString();
  fs.writeFileSync(SHEET_FILE, JSON.stringify(m, null, 2) + '\n');
  log('SHEET UPDATED. Baseline advanced.');
}

// ---------- CLI ----------
const mode = process.argv[2] || '--analyze';
(async () => {
  if (mode === '--analyze') runAnalyze();
  else if (mode === '--fetch') await runFetch();
  else if (mode === '--build') runBuild();
  else if (mode === '--refresh-current') runRefreshCurrent();
  else if (mode === '--create-sheet') runCreateSheet();
  else if (mode === '--update-sheet') runUpdateSheet();
  else if (mode === '--all') { await runFetch(); runBuild(); }
  else { console.error('unknown mode: ' + mode); process.exit(1); }
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
