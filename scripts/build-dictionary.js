// Build data/words.txt and data/definitions.json for Duello v1.
// Sources (see README.md and ATTRIBUTION.md):
//  - Base word list: verbatim ENABLE (public domain) WORD.LST, saved at
//    data/WORD.LST (172,820 words; filtered to 2-10 letters = 125,541 words).
//    Source file: https://www.wordgamedictionary.com/enable/download/enable.txt
//    (the same ENABLE2K list; filtered counts match the prototype's 125,541).
//  - NWL supplement above (TWL 2/3 missing from ENABLE + OWL3 new threes +
//    NWL2023 new threes + ZEN), so all official American Scrabble 2- and
//    3-letter words play.
//  - Jeff's supplied 118 two-letter words, with definitions verbatim (overrides all).
//  - DUELLO.
//  - Definitions: Princeton WordNet via wordnet-db (the upstream of Open English
//    WordNet; Open English WordNet itself is CC BY 4.0 — see ATTRIBUTION.md).
//    Every 2- and 3-letter word in the final list gets a bundled definition:
//    Jeff verbatim, then WordNet, then a brief placeholder (counted below).
// Run: npm run build:dictionary  (requires devDependencies installed)
const fs = require('fs');
const path = require('path');

const JEFF2 = {
AA:"rough, cindery lava",AB:"abdominal muscle",AD:"advertisement",AE:"one",
AG:"pertaining to agriculture",AH:"expresses delight",AI:"three-toed sloth",
AL:"an East Indian tree",AM:'form of "to be"',AN:"indefinite article",
AR:'the letter "R"',AS:"to the same degree",AT:"in the position of",
AW:"expresses protest",AX:"cutting tool",AY:"affirmative vote",
BA:"(Egyptian) eternal soul",BE:"to have actuality",BI:"a bisexual",BO:"a pal",
BY:"a side issue",DA:"dad (British)",DE:"of; from - used in names",
DO:"a tone of the scale",ED:"pertaining to education",EE:"express surprise, anger or joy",
EF:'the letter "F"',EH:"expresses doubt",EL:"elevated railroad",EM:'the letter "M"',
EN:'the letter "N"',EO:"executive order",ER:"expresses hesitation",ES:'the letter "S"',
ET:"a past tense of eat",EW:"express disgust",EX:'the letter "X"',
FA:"a tone of the scale",FE:"a Hebrew letter",FI:"a solmization syllable (music)",
FU:"slang in chat; mastery",GI:"a garment worn in judo",GO:"to move along",
HA:"sound of surprise",HE:"male person",HI:"used as a greeting",
HM:"expresses consideration",HO:"expresses surprise",ID:"part of the psyche",
IF:"a possibility",IN:"to harvest",IO:"a moon of Jupiter",IS:'form of "to be"',
IT:"neuter pronoun",JA:"yes",JE:"a source text of the Torah",JO:"sweetheart",
KA:"(Egyptian) spiritual self",KI:"inner strength, life energy",LA:"tone of the scale",
LI:"Chinese unit of distance",LO:"expresses surprise",MA:"mother",
ME:"personal pronoun",MI:"tone of the scale",MM:"expresses assent",MO:"a moment",
MU:"a Greek letter",MY:"possessive pronoun",NA:"no; not",NE:"born with the name of",
NO:"a negative reply",NU:"a Greek letter",OD:"a hypothetical force",
OE:"Faeroe Islands whirlwind",OF:"coming from",OH:"to exclaim in surprise",
OI:"express dismay (oy)",OK:"all right; acceptable",OM:"a mantra",
ON:"batsman's side of wicket",OO:"a honeyeater bird",OP:"a style of abstract art",
OR:"the heraldic color gold",OS:"a bone",OU:"a man; a Hawaiian bird",
OW:"expresses pain",OX:"a clumsy person",OY:"expresses dismay",PA:"father",
PE:"a Hebrew letter",PI:"a Greek letter",PO:"a chamber pot",QI:"circulating life energy",
RE:"a tone of the scale",SH:"urges silence",SI:"ti (a tone of the scale)",
SO:"sol (a tone of the scale)",TA:"expression of gratitude",TE:"a tone of the scale (ti)",
TI:"a tone of the scale",TO:"in the direction of",UH:"expresses hesitation",
UM:"indicates hesitation",UN:"one",UP:"to raise",US:"personal pronoun",
UT:"musical tone (is now DO)",VU:"in view of",WE:"pronoun",WO:"woe",
XI:"a Greek letter",XU:"monetary unit of Vietnam",YA:"you",YE:"you",
YI:"you or your (singular or plural)",YO:"used to call attention",ZA:"slang word for pizza",
};
// NWL supplement: words in the official American Scrabble (NWL) 2- and 3-letter
// sets that ENABLE does not contain. Generated 2026-10-29 from:
//  - TWL (predecessor list) 2/3-letter words missing from ENABLE,
//  - OWL3 (2015) new three-letter words (66, Seattle Scrabble cheat sheet),
//  - NWL2023 new three-letter words (12, Bridgewater Scrabble page; GOY and
//    HOS are already in the TWL set, so only the 10 new ones are listed),
//  - ZEN, which appears in the NSWL2018 3-letter list but in none of the above.
// The old SUPPLEMENT3 candidate list is NOT used: it was mostly CSW (SOWPODS)
// words (243 of its 312 ENABLE-missing entries are in sowpods.txt) and would
// re-introduce words Duello must not play (QIN, KY, ZO, DI, etc.).
// A MUST-NOT-PLAY guard is enforced in main(): if any of those words ends up
// in the final set, the build aborts.
const NWL2_MISSING_FROM_ENABLE = ["FE","KI","OI","QI","ZA",];
const NWL3_TWL_MISSING = ["AGS","AHI","AHS","APO","APP","BES","CIG","CRU","DAN","DEF","DIF","DUH",
"EDS","EEK","FAB","FES","GOS","HOS","IGG","KIS","KYE","LES","MEG","MIC",
"MYC","NEG","OBA","ODA","ONO","POO","PST","QIS","RAI","SOM","SUK","URP",
"UTE","VID","VUM","YAG","ZAS","ZEP","ZUZ","ZZZ",];
const NWL3_OWL3_NEW = ["AJI","DOH","FAH","HOO","MEH","NUG","ORG","ROO","SIG","TIX","VOG","CAF",
"DUM","FOO","LAH","MES","OCH","OWT","RYU","SOC","TIZ","WUZ","CAL","ECO",
"GIF","LOR","MMM","OIK","PAK","SAN","SOH","TUM","XED","CUZ","EEW","GIS",
"LUD","MOI","OMA","PHO","SEV","SUS","UMS","YAS","DAS","EMO","GRR","LUN",
"MUX","OOF","POS","SEZ","TEC","UNI","YER","DEP","EST","HOM","MAM","NAV",
"OPA","REZ","SHO","TES","VIN","YEZ",];
const NWL3_NWL2023_NEW = ["ACK","ARO","ATS","BAE","DOX","FAM","FAV","LOC","PWN","VAX",];
const NWL3_EXTRA = ["ZEN",];
const MUST_NOT_PLAY = ["QIN","KY","ZO","DI","AO","CH","EA","FY","GU","KO","NY","OB","SJ","ST","UA","UG","UK","UR","YU"];
const MUST_PLAY = ["QI","ZA","ZEN","JA","DUELLO"];

function parseWordNet() {
  const wnPath = require.resolve('wordnet-db');
  const dir = path.join(path.dirname(wnPath), 'dict');
  const posMap = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };
  const dataByPos = {};
  for (const [code, file] of Object.entries({ n: 'data.noun', v: 'data.verb', a: 'data.adj', r: 'data.adv' })) {
    const map = new Map();
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line || line.startsWith(' ')) continue;
      const bar = line.indexOf(' | ');
      if (bar < 0) continue;
      const offset = line.slice(0, 8);
      let gloss = line.slice(bar + 3).split(';')[0].trim();
      gloss = gloss.replace(/\s+/g, ' ');
      if (gloss.length > 140) gloss = gloss.slice(0, 137).trim() + '…';
      map.set(offset, gloss);
    }
    dataByPos[code] = map;
  }
  const defs = {};
  for (const [code, file] of Object.entries({ n: 'index.noun', v: 'index.verb', a: 'index.adj', r: 'index.adv' })) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line || line.startsWith(' ')) continue;
      const parts = line.split(' ');
      const lemma = parts[0];
      if (!/^[a-z]+$/.test(lemma)) continue;
      const word = lemma.toUpperCase();
      if (defs[word]) continue;
      // index format: lemma pos syn_cnt p_cnt ptrs... sense_cnt tagsense_cnt offsets...
      const synCnt = parseInt(parts[2], 10);
      const pCnt = parseInt(parts[3], 10);
      const offset = parts[4 + pCnt + 2];
      const gloss = dataByPos[code].get(offset);
      if (gloss) defs[word] = { pos: posMap[code], def: gloss };
    }
  }
  return defs;
}

function main() {
  const enablePath = path.join(__dirname, '..', 'data', 'WORD.LST');
  if (!fs.existsSync(enablePath)) throw new Error('data/WORD.LST missing — run the ENABLE download step in README.md first');
  const set = new Set();
  for (const line of fs.readFileSync(enablePath, 'utf8').split('\n')) {
    const w = line.trim().toUpperCase();
    if (/^[A-Z]{2,10}$/.test(w)) set.add(w);
  }
  const baseCount = set.size;
  let addedNwl = 0;
  for (const w of [...NWL2_MISSING_FROM_ENABLE, ...NWL3_TWL_MISSING, ...NWL3_OWL3_NEW, ...NWL3_NWL2023_NEW, ...NWL3_EXTRA]) {
    if (!set.has(w)) { set.add(w); addedNwl++; }
  }
  let addedJeff = 0;
  for (const w of Object.keys(JEFF2)) {
    if (!set.has(w)) { set.add(w); addedJeff++; }
  }
  set.add('DUELLO');
  for (const w of MUST_NOT_PLAY) {
    if (set.has(w)) throw new Error('MUST-NOT-PLAY word in final list: ' + w);
  }
  for (const w of MUST_PLAY) {
    if (!set.has(w)) throw new Error('MUST-PLAY word missing from final list: ' + w);
  }
  const words = [...set].sort();
  const wn = parseWordNet();
  const defs = {};
  let wnCount = 0, briefCount = 0;
  for (const w of words) {
    if (JEFF2[w]) { defs[w] = { pos: '', def: JEFF2[w] }; continue; }
    if (w === 'DUELLO') { defs[w] = { pos: 'noun', def: '🤺' }; continue; }
    if (w.length <= 3) {
      if (wn[w]) { defs[w] = wn[w]; wnCount++; }
      else { defs[w] = { pos: '', def: 'a valid word in the Duello word list' }; briefCount++; }
    } else if (wn[w]) {
      defs[w] = wn[w]; wnCount++;
    }
  }
  const shortWords = words.filter(w => w.length <= 3);
  const shortMissingDefs = shortWords.filter(w => !defs[w]);
  if (shortMissingDefs.length) throw new Error('2/3-letter words missing definitions: ' + shortMissingDefs.join(','));
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'words.txt'), words.join('\n') + '\n');
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'definitions.json'), JSON.stringify(defs, null, 0) + '\n');
  const byLen = {};
  for (const w of words) byLen[w.length] = (byLen[w.length] || 0) + 1;
  console.log(JSON.stringify({
    total: words.length, enable2to10: baseCount, nwlSupplementAdded: addedNwl,
    jeffAdded: addedJeff, jeffTotal: Object.keys(JEFF2).length,
    byLength: byLen, definitionsBundled: Object.keys(defs).length,
    wordnetUsed: wnCount, briefPlaceholders2or3: briefCount,
    shortWords: shortWords.length, shortMissingDefs: shortMissingDefs.length,
    checks: { QI: set.has('QI'), ZA: set.has('ZA'), ZEN: set.has('ZEN'), DUELLO: set.has('DUELLO'), JA: set.has('JA'), JAZZ: set.has('JAZZ'), CWM: set.has('CWM'), QAT: set.has('QAT'),
      QIN: set.has('QIN'), KY: set.has('KY'), ZO: set.has('ZO'), DI: set.has('DI') },
  }, null, 2));
}
main();
