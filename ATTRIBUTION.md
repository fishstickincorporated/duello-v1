# Attribution

- **Word list (base):** `an-array-of-english-words@2.0.0` (MIT license),
  "List of ~275,000 English words", filtered to 2–10 letters (193,088
  words). This is the v1 base list, NOT verbatim ENABLE. See README for
  exact counts and known gaps.
- **ENABLE:** the Enhanced North American Benchmark LExicon, released into
  the public domain. v1 does NOT ship a verbatim ENABLE WORD.LST; the
  import path (`scripts/import-enable.js`) exists to replace the base list
  with one when it is available.
- **Definitions (source):** glosses extracted from Princeton WordNet via
  the `wordnet-db@3.1.14` package (MIT package of Princeton WordNet dict
  files). Princeton WordNet is the upstream of Open English WordNet.
  Open English WordNet is licensed CC BY 4.0; this app credits both
  Princeton WordNet and Open English WordNet (CC BY 4.0) for definition
  content, and does NOT claim Open English WordNet was bundled verbatim.
- **Jeff's 118 two-letter definitions:** supplied by Jeff Marquis
  (2026-10-29) and used verbatim, overriding all other definition sources
  for those words.
- **DUELLO definition:** noun "🤺", as specified by Jeff.
- **Bot skill / game rules:** as specified by Jeff (see README).
