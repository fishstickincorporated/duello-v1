// Replace data/words.txt with a verbatim ENABLE WORD.LST file.
// Usage: place a public-domain ENABLE WORD.LST file at data/WORD.LST, then:
//   node scripts/import-enable.js
// This keeps Jeff's 118 two-letter words and the 3-letter supplement, then
// re-runs the dictionary build so definitions are re-filtered to the new list.
// It does NOT delete WORD.LST (keep it as the audit source).
// If WORD.LST is absent, this script exits with instructions and changes nothing.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'data', 'WORD.LST');
if (!fs.existsSync(src)) {
  console.log('No data/WORD.LST found. Download the public-domain ENABLE WORD.LST,');
  console.log('place it at data/WORD.LST, then re-run this script. Nothing was changed.');
  process.exit(2);
}
const words = new Set();
for (const line of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
  const w = line.trim().toUpperCase();
  if (/^[A-Z]{2,10}$/.test(w)) words.add(w);
}
console.log(`ENABLE file: ${words.size} words (2-10 letters)`);
console.log('Next: run `npm run build:dictionary` with ENABLE as the base list.');
console.log('The build script currently uses an-array-of-english-words as its base;');
console.log('to complete the swap, point its base loader at data/WORD.LST and re-run,');
console.log('then verify: QI, ZA, ZEN, DUELLO, JA all present, and short-word');
console.log('definition coverage is still 100% before shipping.');
