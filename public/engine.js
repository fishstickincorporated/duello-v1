// Duello shared engine — pure game logic, no fs / pg / DOM / network.
// One file, two runtimes: Node loads it with require(), the browser with
// <script src="/engine.js">. The only impure input is the WORDS set,
// injected through createEngine(wordSet) — the server builds it from
// data/words.txt (fs), the client from GET /api/words (fetch).
// Extracted verbatim from server.js (v104) by /tmp/v105-extract-engine.js;
// the v105 parity harness proves the extraction changed nothing.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DuelloEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Constants & rack dealing (pure, no WORDS) ----------
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
      const counts = {};
      let triple = false;
      for (const l of rack) { counts[l] = (counts[l] || 0) + 1; if (counts[l] >= 3) triple = true; }
      if (v >= 2 && c >= 2 && !triple) return rack;
    }
    return ['A','E','B','C','D','F'];
  }
  function drawVowel() { for (let i = 0; i < 100; i++) { const l = drawLetter(); if (VOWELS.has(l)) return l; } return 'E'; }
  function drawConsonant() { for (let i = 0; i < 100; i++) { const l = drawLetter(); if (!VOWELS.has(l)) return l; } return 'B'; }

  // Rack cap (Nov 5, 2026): no letter ever appears 3 times in a rack.
  // drawLetter is pure frequency, so a capped draw re-rolls until the
  // letter still has room (count < 2 in the settled rack); the scan
  // guarantees a letter even when the unplayed tiles already hold two
  // of every vowel (or consonant) the draw could pick. `want` is
  // 'vowel', 'consonant', or 'any'.
  function drawCapped(counts, want) {
    const ok = (l) => (counts[l] || 0) < 2 && (want === 'any' || (want === 'vowel') === VOWELS.has(l));
    for (let i = 0; i < 100; i++) { const l = drawLetter(); if (ok(l)) return l; }
    for (const [l] of FREQ) if (ok(l)) return l;
    for (const [l] of FREQ) if ((counts[l] || 0) < 2) return l;
    return 'E';
  }

  function refillRack(rack, usedIndices) {
    // Refill in place (unplayed tiles never move) AND guarantee the settled
    // floor: every rack has at least 2 vowels and at least 2 consonants.
    // The old code just drew random letters for the used slots, so a rack
    // could come back with 0-1 vowels or consonants after a play.
    const next = rack.slice();
    const usedSet = new Set(usedIndices);
    const unplayed = next.filter((_, i) => !usedSet.has(i));
    // Counts of the settled (unplayed) tiles: every refill draw must
    // leave room, so no letter ever reaches 3 in the rack.
    const counts = {};
    for (const l of unplayed) counts[l] = (counts[l] || 0) + 1;
    let v = unplayed.filter(c => VOWELS.has(c)).length;
    let c = unplayed.filter(c => !VOWELS.has(c)).length;
    let needV = Math.max(0, 2 - v), needC = Math.max(0, 2 - c);
    for (const idx of usedIndices) {
      let l;
      if (needV > 0) { l = drawCapped(counts, 'vowel'); needV--; }
      else if (needC > 0) { l = drawCapped(counts, 'consonant'); needC--; }
      else l = drawCapped(counts, 'any');
      next[idx] = l; counts[l] = (counts[l] || 0) + 1;
    }
    // Fallback for a rack that somehow already broke the floor before the
    // play (should not happen): change unplayed tiles only as a last resort.
    for (let i = 0; i < next.length && (needV > 0 || needC > 0); i++) {
      if (usedSet.has(i)) continue;
      if (needV > 0 && !VOWELS.has(next[i])) { const l = drawCapped(counts, 'vowel'); counts[next[i]]--; next[i] = l; counts[l] = (counts[l] || 0) + 1; needV--; }
      else if (needC > 0 && VOWELS.has(next[i])) { const l = drawCapped(counts, 'consonant'); counts[next[i]]--; next[i] = l; counts[l] = (counts[l] || 0) + 1; needC--; }
    }
    return next;
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

  // ---------- Validation / scoring: wordAt & scoreWord (pure, no WORDS) ----------
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

  // ---------- Bot skill / think ----------
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

  // Everyday words personas strongly prefer: a persona move whose
  // main word is in this set is picked over any obscure word, so
  // persona games read like games against ordinary players.
  const COMMON_WORDS = new Set([
    'ABOUT', 'ADD', 'AFTER', 'AGAIN', 'AIR', 'ALL', 'ALONG', 'ALSO', 'ALWAYS', 'AN', 'AND', 'ANIMAL',
    'ANOTHER', 'ANSWER', 'ANY', 'APPLE', 'ARE', 'ARM', 'AROUND', 'ART', 'AS', 'ASK', 'AT', 'AWAY',
    'BABY', 'BACK', 'BAD', 'BALL', 'BANANA', 'BE', 'BECAUSE', 'BED', 'BEEN', 'BEFORE', 'BEGIN', 'BELOW',
    'BETWEEN', 'BIG', 'BIRD', 'BITTER', 'BLOOD', 'BLUE', 'BONE', 'BOOK', 'BOTH', 'BOTTOM', 'BOY', 'BRAIN',
    'BRAVE', 'BREAD', 'BRIGHT', 'BUS', 'BUSY', 'BUT', 'BUTTER', 'BY', 'CAKE', 'CALL', 'CAME', 'CAN',
    'CANDY', 'CAR', 'CAT', 'CHAIR', 'CHANGE', 'CHEESE', 'CHILD', 'CITY', 'CLEAN', 'CLOSE', 'COLD', 'COME',
    'COMPUTER', 'COOK', 'COOKIE', 'COOL', 'COULD', 'COUNTRY', 'CRY', 'DANCE', 'DARK', 'DAY', 'DEEP', 'DID',
    'DIFFERENT', 'DIRTY', 'DO', 'DOES', 'DOG', 'DOOR', 'DOWN', 'DRINK', 'EACH', 'EAR', 'EARTH', 'EASY',
    'EAT', 'EGG', 'EMPTY', 'END', 'EVEN', 'EVERY', 'EXAMPLE', 'EYE', 'FACE', 'FAIR', 'FALSE', 'FAMILY',
    'FAST', 'FATHER', 'FEW', 'FIND', 'FINGER', 'FIRE', 'FIRST', 'FISH', 'FLOOR', 'FOLLOW', 'FOOD', 'FOOT',
    'FOR', 'FORM', 'FOUND', 'FREE', 'FRESH', 'FRIEND', 'FROM', 'FRONT', 'FRUIT', 'FULL', 'FUN', 'GAME',
    'GET', 'GIRL', 'GIVE', 'GLAD', 'GO', 'GOLD', 'GOOD', 'GOT', 'GRAPE', 'GREAT', 'GREEN', 'GROUP',
    'HAD', 'HAIR', 'HAND', 'HAPPY', 'HARD', 'HAS', 'HAVE', 'HE', 'HEAD', 'HEART', 'HEAVY', 'HELP',
    'HER', 'HERE', 'HIGH', 'HIM', 'HIS', 'HOME', 'HORSE', 'HOT', 'HOUSE', 'HOW', 'IN', 'INTO',
    'IS', 'IT', 'ITS', 'JUMP', 'JUST', 'KEEP', 'KIND', 'KING', 'KNEE', 'KNOW', 'LAMP', 'LAND',
    'LARGE', 'LAST', 'LAUGH', 'LEARN', 'LEFT', 'LEG', 'LEMON', 'LETTER', 'LIFE', 'LIGHT', 'LIKE', 'LINE',
    'LITTLE', 'LIVE', 'LONG', 'LOOK', 'LOUD', 'LOVE', 'LOW', 'MADE', 'MAKE', 'MAN', 'MANY', 'MAY',
    'ME', 'MEAN', 'MEAT', 'MEN', 'MIGHT', 'MILK', 'MOON', 'MORE', 'MOST', 'MOTHER', 'MOUTH', 'MOVE',
    'MUCH', 'MUSIC', 'MUST', 'MY', 'NAME', 'NEAR', 'NECK', 'NEED', 'NEVER', 'NEW', 'NEXT', 'NICE',
    'NO', 'NOSE', 'NOT', 'NOW', 'NUMBER', 'OF', 'OFF', 'OFTEN', 'OIL', 'OLD', 'ON', 'ONE',
    'ONLY', 'OPEN', 'OR', 'ORANGE', 'OTHER', 'OUR', 'OUT', 'OVER', 'OWN', 'PAGE', 'PAPER', 'PART',
    'PASTA', 'PEACH', 'PEAR', 'PEOPLE', 'PHONE', 'PICTURE', 'PIZZA', 'PLACE', 'PLANT', 'PLAY', 'POINT', 'POOR',
    'PRINCE', 'PROUD', 'PULL', 'PUSH', 'PUT', 'QUEEN', 'QUIET', 'RAIN', 'READ', 'READY', 'RED', 'RICE',
    'RICH', 'RIGHT', 'ROOF', 'RUN', 'SAFE', 'SAID', 'SALT', 'SAME', 'SAW', 'SAY', 'SCHOOL', 'SEE',
    'SEEM', 'SENTENCE', 'SET', 'SHE', 'SHORT', 'SHOULD', 'SHOW', 'SHY', 'SIDE', 'SILVER', 'SING', 'SKIN',
    'SLEEP', 'SLOW', 'SMALL', 'SMILE', 'SNOW', 'SO', 'SOFT', 'SOME', 'SOMETHING', 'SONG', 'SORRY', 'SOUND',
    'SOUR', 'SPELL', 'STAR', 'START', 'STILL', 'STONE', 'STOP', 'STORY', 'STRONG', 'STUDY', 'SUCH', 'SUN',
    'SURE', 'SWEET', 'TABLE', 'TAKE', 'TALK', 'TEAR', 'TELL', 'THAN', 'THAT', 'THE', 'THEIR', 'THEM',
    'THEN', 'THERE', 'THESE', 'THEY', 'THING', 'THINK', 'THIS', 'THOSE', 'THOUGHT', 'THREE', 'THROUGH', 'TIME',
    'TO', 'TOE', 'TOGETHER', 'TONGUE', 'TOO', 'TOOTH', 'TOP', 'TRAIN', 'TREE', 'TRUE', 'TRY', 'TURN',
    'TWO', 'UNDER', 'UP', 'US', 'USE', 'VERY', 'WAKE', 'WALK', 'WALL', 'WANT', 'WARM', 'WAS',
    'WATER', 'WAY', 'WE', 'WEAK', 'WELL', 'WENT', 'WERE', 'WHAT', 'WHEN', 'WHERE', 'WHICH', 'WHILE',
    'WHO', 'WHY', 'WIDE', 'WILL', 'WIND', 'WINDOW', 'WITH', 'WOOD', 'WORD', 'WORK', 'WORLD', 'WOULD',
    'WRITE', 'YEAR', 'YES', 'YOU', 'YOUNG', 'YOUR',
    // v102 expansion: many more everyday words, so the common-word
    // bias below applies on far more boards. Every word here is in
    // the dictionary (2-10 letters); longer/month-name candidates
    // were dropped because the dictionary does not contain them.
    'ABLE', 'ABOVE', 'ABSENT', 'ACCEPT', 'ACCIDENT', 'ACCOUNT', 'ACROSS', 'ACT', 'ACTION', 'ACTIVE', 'ACTUAL', 'ADAPT',
    'ADDRESS', 'ADMIT', 'ADOPT', 'ADULT', 'ADVICE', 'AFRAID', 'AFTERNOON', 'AGAINST', 'AGE', 'AGENCY', 'AGENT', 'AGO',
    'AGREE', 'AHEAD', 'AIM', 'ALARM', 'ALBUM', 'ALIKE', 'ALIVE', 'ALLOW', 'ALMOST', 'ALONE', 'ALREADY', 'ALTER',
    'AMOUNT', 'ANCIENT', 'ANGLE', 'ANGRY', 'ANKLE', 'ANNOUNCE', 'ANNOY', 'ANYONE', 'ANYWAY', 'APART', 'APOLOGY', 'APPARENT',
    'APPEAL', 'APPEAR', 'APPLY', 'APPOINT', 'APPROACH', 'APPROVE', 'ARCH', 'AREA', 'ARGUE', 'ARISE', 'ARMY', 'ARRANGE',
    'ARREST', 'ARRIVE', 'ARROW', 'ARTICLE', 'ARTIST', 'ASHAMED', 'ASIDE', 'ASLEEP', 'ASPECT', 'ASSIGN', 'ASSIST', 'ASSOCIATE',
    'ASSUME', 'ASSURE', 'ATHLETE', 'ATTACH', 'ATTACK', 'ATTEMPT', 'ATTEND', 'ATTENTION', 'ATTITUDE', 'ATTRACT', 'AUDIENCE', 'AUGUST',
    'AUTHOR', 'AUTUMN', 'AVAILABLE', 'AVERAGE', 'AVOID', 'AWAKE', 'AWARD', 'AWARE', 'AWFUL', 'AXE', 'BAG', 'BAKE',
    'BALANCE', 'BAND', 'BANK', 'BAR', 'BARE', 'BARN', 'BASE', 'BASIC', 'BASK', 'BASKET', 'BATH', 'BATTERY', 'BATTLE',
    'BEACH', 'BEAM', 'BEAN', 'BEAR', 'BEARD', 'BEAST', 'BEAT', 'BEAUTY', 'BECAME', 'BECOME', 'BEEF', 'BEER',
    'BEGAN', 'BEHAVE', 'BEHIND', 'BELIEF', 'BELL', 'BELONG', 'BELT', 'BEND', 'BENEFIT', 'BERRY', 'BESIDE', 'BEST',
    'BET', 'BETTER', 'BIBLE', 'BID', 'BILL', 'BIRTH', 'BIRTHDAY', 'BIT', 'BITE', 'BLACK', 'BLADE', 'BLAME',
    'BLANK', 'BLANKET', 'BLAST', 'BLEED', 'BLESS', 'BLIND', 'BLOCK', 'BLOW', 'BOARD', 'BOAT', 'BODY', 'BOIL',
    'BOLD', 'BOLT', 'BOMB', 'BOND', 'BONUS', 'BOOST', 'BOOT', 'BORDER', 'BORN', 'BORROW', 'BOSS', 'BOTHER',
    'BOTTLE', 'BOUGHT', 'BOUNCE', 'BOUND', 'BOWL', 'BOX', 'BRANCH', 'BRAND', 'BREAK', 'BREATH', 'BREATHE', 'BREEZE',
    'BRICK', 'BRIDE', 'BRIDGE', 'BRIEF', 'BRING', 'BROAD', 'BROKE', 'BROKEN', 'BROTHER', 'BROWN', 'BRUSH', 'BUBBLE',
    'BUCKET', 'BUDGET', 'BUILD', 'BUILDING', 'BULB', 'BULLET', 'BUNCH', 'BURN', 'BURST', 'BURY', 'BUSH', 'BUSINESS',
    'BUTTON', 'BUY', 'BUYER', 'CABIN', 'CABLE', 'CAGE', 'CALM', 'CAMERA', 'CAMP', 'CANAL', 'CANCEL', 'CANDLE',
    'CAP', 'CAPABLE', 'CAPITAL', 'CAPTAIN', 'CARBON', 'CARD', 'CARE', 'CAREER', 'CAREFUL', 'CARPET', 'CARRY', 'CART',
    'CASE', 'CASH', 'CAST', 'CASTLE', 'CATCH', 'CATTLE', 'CAUSE', 'CELEBRATE', 'CELL', 'CENT', 'CENTER', 'CENTURY',
    'CERTAIN', 'CHAIN', 'CHALK', 'CHANCE', 'CHANNEL', 'CHAOS', 'CHAPTER', 'CHARGE', 'CHARITY', 'CHART', 'CHASE', 'CHEAP',
    'CHECK', 'CHEMICAL', 'CHEST', 'CHICKEN', 'CHIEF', 'CHILL', 'CHIP', 'CHOICE', 'CHOOSE', 'CHOP', 'CHURCH', 'CIRCLE',
    'CITIZEN', 'CIVIL', 'CLAIM', 'CLASS', 'CLEAR', 'CLERK', 'CLEVER', 'CLICK', 'CLIENT', 'CLIMATE', 'CLIMB', 'CLOCK',
    'CLOTH', 'CLOTHES', 'CLOUD', 'CLUB', 'COACH', 'COAL', 'COAST', 'COAT', 'CODE', 'COFFEE', 'COIN', 'COLLAR',
    'COLLECT', 'COLLEGE', 'COLOR', 'COLUMN', 'COMBINE', 'COMFORT', 'COMMAND', 'COMMENT', 'COMMON', 'COMMUNITY', 'COMPANY', 'COMPARE',
    'COMPETE', 'COMPLAIN', 'COMPLETE', 'COMPLEX', 'COMPOSE', 'CONCEPT', 'CONCERN', 'CONCERT', 'CONCLUDE', 'CONDITION', 'CONDUCT', 'CONFERENCE',
    'CONFESS', 'CONFIDENT', 'CONFIRM', 'CONFLICT', 'CONFUSE', 'CONNECT', 'CONSIDER', 'CONSIST', 'CONSTANT', 'CONSTRUCT', 'CONTACT', 'CONTAIN',
    'CONTENT', 'CONTEST', 'CONTEXT', 'CONTINUE', 'CONTRACT', 'CONTROL', 'CONVENIENT', 'COPE', 'COPY', 'CORE', 'CORN', 'CORNER',
    'CORRECT', 'COST', 'COTTON', 'COUCH', 'COUNT', 'COUPLE', 'COURAGE', 'COURSE', 'COURT', 'COUSIN', 'COVER', 'CRACK',
    'CRAFT', 'CRASH', 'CRAZY', 'CREAM', 'CREATE', 'CREDIT', 'CREEK', 'CREW', 'CRIME', 'CRISIS', 'CRITERIA', 'CRITIC',
    'CROP', 'CROSS', 'CROWD', 'CRUCIAL', 'CRUEL', 'CRUSH', 'CULTURE', 'CUP', 'CURE', 'CURIOUS', 'CURRENT', 'CURTAIN',
    'CURVE', 'CUSTOM', 'CUSTOMER', 'CUT', 'CYCLE', 'DAILY', 'DAMAGE', 'DANGER', 'DARE', 'DATA', 'DATE', 'DAUGHTER',
    'DAWN', 'DEAD', 'DEAL', 'DEAR', 'DEATH', 'DEBATE', 'DEBT', 'DECADE', 'DECIDE', 'DECISION', 'DECLARE', 'DECLINE',
    'DECORATE', 'DECREASE', 'DEER', 'DEFEAT', 'DEFEND', 'DEFINE', 'DEGREE', 'DELAY', 'DELIVER', 'DEMAND', 'DEMOCRACY', 'DENY',
    'DEPART', 'DEPEND', 'DEPOSIT', 'DEPTH', 'DEPUTY', 'DESCRIBE', 'DESERT', 'DESIGN', 'DESK', 'DESPITE', 'DETAIL', 'DETECT',
    'DETERMINE', 'DEVELOP', 'DEVICE', 'DEVOTE', 'DIARY', 'DIE', 'DIET', 'DIFFICULT', 'DIG', 'DIGITAL', 'DIM', 'DINNER',
    'DIRECT', 'DIRECTION', 'DIRT', 'DISAGREE', 'DISAPPEAR', 'DISASTER', 'DISCIPLINE', 'DISCOUNT', 'DISCOVER', 'DISCUSS', 'DISEASE', 'DISH',
    'DISMISS', 'DISPLAY', 'DISTANCE', 'DISTINCT', 'DISTRICT', 'DITCH', 'DIVE', 'DIVIDE', 'DIVISION', 'DOCTOR', 'DOCUMENT', 'DOLL',
    'DOLLAR', 'DOMAIN', 'DONATE', 'DOUBLE', 'DOUBT', 'DOZEN', 'DRAFT', 'DRAG', 'DRAMA', 'DRAW', 'DREAM', 'DRESS',
    'DRIFT', 'DRILL', 'DRIVE', 'DRIVER', 'DROP', 'DRUM', 'DRY', 'DUCK', 'DUE', 'DULL', 'DUMP', 'DUST',
    'DUTY', 'DYING', 'EAGER', 'EAGLE', 'EARLY', 'EARN', 'EASE', 'EAST', 'ECHO', 'ECONOMY', 'EDGE', 'EDIT',
    'EDUCATE', 'EFFECT', 'EFFORT', 'EIGHT', 'EITHER', 'ELBOW', 'ELDER', 'ELECT', 'ELEMENT', 'ELEPHANT', 'ELEVEN', 'ELITE',
    'ELSE', 'EMAIL', 'EMBARRASS', 'EMERGENCY', 'EMOTION', 'EMPHASIS', 'EMPIRE', 'EMPLOY', 'ENABLE', 'ENCOUNTER', 'ENCOURAGE', 'ENEMY',
    'ENERGY', 'ENGAGE', 'ENGINE', 'ENGINEER', 'ENJOY', 'ENORMOUS', 'ENOUGH', 'ENTER', 'ENTIRE', 'ENTRANCE', 'ENTRY', 'ENVELOPE',
    'EPISODE', 'EQUAL', 'EQUIPMENT', 'ERA', 'ERROR', 'ESCAPE', 'ESPECIALLY', 'ESSAY', 'ESSENTIAL', 'ESTABLISH', 'ESTATE', 'ESTIMATE',
    'ETHICS', 'EVENING', 'EVENT', 'EVIDENCE', 'EVIL', 'EXACT', 'EXAM', 'EXCEED', 'EXCEPT', 'EXCHANGE', 'EXCITE', 'EXCUSE',
    'EXECUTIVE', 'EXERCISE', 'EXHAUST', 'EXHIBIT', 'EXIST', 'EXIT', 'EXPAND', 'EXPECT', 'EXPENSE', 'EXPERIENCE', 'EXPERT', 'EXPLAIN',
    'EXPLORE', 'EXPORT', 'EXPOSE', 'EXPRESS', 'EXTEND', 'EXTRA', 'EXTREME', 'FACT', 'FACTOR', 'FACTORY', 'FAIL', 'FAITH',
    'FALL', 'FAME', 'FAMOUS', 'FAN', 'FANCY', 'FAR', 'FARM', 'FASHION', 'FAT', 'FATE', 'FAULT', 'FAVOR',
    'FEAR', 'FEATHER', 'FEATURE', 'FEDERAL', 'FEE', 'FEED', 'FEEL', 'FELLOW', 'FEMALE', 'FENCE', 'FERRY', 'FEVER',
    'FICTION', 'FIELD', 'FIERCE', 'FIFTEEN', 'FIFTH', 'FIFTY', 'FIGHT', 'FIGURE', 'FILE', 'FILL', 'FILM', 'FINAL',
    'FINANCE', 'FINE', 'FINISH', 'FIRM', 'FIT', 'FIX', 'FLAG', 'FLAME', 'FLASH', 'FLAT', 'FLAVOR', 'FLEE',
    'FLEET', 'FLESH', 'FLIGHT', 'FLOAT', 'FLOOD', 'FLOUR', 'FLOW', 'FLOWER', 'FLUID', 'FLUSH', 'FLY', 'FOCUS',
    'FOG', 'FOLD', 'FOLK', 'FOND', 'FOOL', 'FORCE', 'FORECAST', 'FOREHEAD', 'FOREIGN', 'FOREST', 'FORGET', 'FORGIVE',
    'FORMAL', 'FORMER', 'FORTH', 'FORTUNE', 'FORWARD', 'FOUR', 'FRAME', 'FREEDOM', 'FREEZE', 'FREQUENT', 'FROG', 'FROST',
    'FROWN', 'FUEL', 'FUNCTION', 'FUND', 'FUNNY', 'FUR', 'FURNITURE', 'FURTHER', 'FUTURE', 'GAIN', 'GALAXY', 'GALLERY',
    'GAP', 'GARAGE', 'GARDEN', 'GARLIC', 'GAS', 'GATE', 'GATHER', 'GAVE', 'GEAR', 'GENDER', 'GENE', 'GENERAL',
    'GENEROUS', 'GENIUS', 'GENTLE', 'GENTLEMAN', 'GENUINE', 'GESTURE', 'GHOST', 'GIANT', 'GIFT', 'GIGGLE', 'GINGER', 'GLANCE',
    'GLASS', 'GLEAM', 'GLIDE', 'GLOBAL', 'GLORY', 'GLOVE', 'GOAL', 'GOAT', 'GOD', 'GOLF', 'GONE', 'GOODS',
    'GORGEOUS', 'GOSSIP', 'GOVERN', 'GRAB', 'GRACE', 'GRADE', 'GRADUAL', 'GRAIN', 'GRAND', 'GRANT', 'GRAPH', 'GRASP',
    'GRASS', 'GRATEFUL', 'GRAVE', 'GRAY', 'GREET', 'GREW', 'GRIEF', 'GRILL', 'GRIN', 'GRIND', 'GRIP', 'GROCERY',
    'GROUND', 'GROW', 'GROWTH', 'GUARANTEE', 'GUARD', 'GUESS', 'GUEST', 'GUIDE', 'GUILTY', 'GUITAR', 'GUN', 'HABIT',
    'HALF', 'HALL', 'HANDLE', 'HANDSOME', 'HANG', 'HAPPEN', 'HARBOR', 'HARM', 'HARVEST', 'HAT', 'HATE', 'HAUNT',
    'HAWK', 'HEAL', 'HEALTH', 'HEAR', 'HEAT', 'HEAVEN', 'HEIGHT', 'HELLO', 'HENCE', 'HERB', 'HERO', 'HERS',
    'HERSELF', 'HIDE', 'HIGHWAY', 'HILL', 'HINT', 'HIRE', 'HISTORY', 'HIT', 'HOBBY', 'HOLD', 'HOLE', 'HOLIDAY',
    'HOLLOW', 'HOLY', 'HONEST', 'HONOR', 'HOOK', 'HOPE', 'HORIZON', 'HORN', 'HOSPITAL', 'HOST', 'HOTEL', 'HOUR',
    'HOWEVER', 'HUGE', 'HUMAN', 'HUMOR', 'HUNDRED', 'HUNT', 'HURRY', 'HURT', 'HUSBAND', 'ICE', 'IDEA', 'IDEAL',
    'IDENTIFY', 'IDENTITY', 'IDLE', 'IGNORANT', 'IGNORE', 'ILL', 'ILLUSTRATE', 'IMAGE', 'IMAGINE', 'IMMEDIATE', 'IMPACT', 'IMPLEMENT',
    'IMPLY', 'IMPORT', 'IMPORTANT', 'IMPOSE', 'IMPRESS', 'IMPROVE', 'INCH', 'INCIDENT', 'INCLUDE', 'INCOME', 'INCREASE', 'INDEED',
    'INDEX', 'INDICATE', 'INDIVIDUAL', 'INDUSTRY', 'INFANT', 'INFLATION', 'INFLUENCE', 'INFORM', 'INGREDIENT', 'INJURE', 'INNER', 'INNOCENT',
    'INPUT', 'INSECT', 'INSIDE', 'INSIST', 'INSPECT', 'INSPIRE', 'INSTALL', 'INSTEAD', 'INSTRUMENT', 'INSULT', 'INSURANCE', 'INTACT',
    'INTAKE', 'INTEGER', 'INTEND', 'INTENSE', 'INTENT', 'INTEREST', 'INTERNAL', 'INTERNET', 'INTERPRET', 'INTERRUPT', 'INTERVIEW', 'INTRODUCE',
    'INVENT', 'INVEST', 'INVITE', 'INVOLVE', 'IRON', 'ISLAND', 'ISSUE', 'ITEM', 'ITSELF', 'JACKET', 'JAW', 'JAZZ',
    'JEANS', 'JET', 'JEWEL', 'JOB', 'JOIN', 'JOINT', 'JOKE', 'JOURNAL', 'JOURNEY', 'JOY', 'JUDGE', 'JUICE',
    'JUNIOR', 'JURY', 'JUSTICE', 'JUSTIFY', 'KEEN', 'KEY', 'KICK', 'KID', 'KILL', 'KISS', 'KITCHEN', 'KNEW',
    'KNIFE', 'KNOCK', 'LABEL', 'LABOR', 'LACK', 'LADDER', 'LADY', 'LAKE', 'LANDSCAPE', 'LANGUAGE', 'LAP', 'LASER',
    'LATE', 'LAUNCH', 'LAUNDRY', 'LAW', 'LAWN', 'LAYER', 'LAZY', 'LEAD', 'LEADER', 'LEAF', 'LEAGUE', 'LEAN',
    'LEASE', 'LEAST', 'LEATHER', 'LEAVE', 'LECTURE', 'LEGAL', 'LEGEND', 'LEND', 'LENGTH', 'LESS', 'LESSON', 'LET',
    'LEVEL', 'LIBERAL', 'LIBERTY', 'LIBRARY', 'LICENSE', 'LIE', 'LIFT', 'LIKELY', 'LIMIT', 'LINK', 'LION', 'LIP',
    'LIQUID', 'LIST', 'LISTEN', 'LITERATURE', 'LIVING', 'LOAD', 'LOAN', 'LOCAL', 'LOCATE', 'LOCK', 'LOG', 'LONELY',
    'LOSE', 'LOSS', 'LOST', 'LOT', 'LOYAL', 'LUCK', 'LUGGAGE', 'LUNCH', 'LUNG', 'MACHINE', 'MAD', 'MAGIC',
    'MAIL', 'MAIN', 'MAINTAIN', 'MAJOR', 'MALE', 'MALL', 'MANAGE', 'MANNER', 'MAP', 'MARCH', 'MARGIN', 'MARK',
    'MARKET', 'MARRIAGE', 'MARRY', 'MASK', 'MASS', 'MASTER', 'MATCH', 'MATE', 'MATH', 'MATTER', 'MAYBE', 'MAYOR',
    'MEAL', 'MEANING', 'MEASURE', 'MECHANIC', 'MEDIA', 'MEDICAL', 'MEDICINE', 'MEDIUM', 'MEET', 'MELT', 'MEMBER', 'MEMORY',
    'MENTION', 'MENU', 'MERCY', 'MERE', 'MERIT', 'MESS', 'MESSAGE', 'METAL', 'METER', 'METHOD', 'MIDDLE', 'MILD',
    'MILE', 'MILL', 'MIND', 'MINE', 'MINERAL', 'MINIMUM', 'MINOR', 'MINUTE', 'MIRROR', 'MISS', 'MISTAKE', 'MIX',
    'MODE', 'MODEL', 'MODEST', 'MOMENT', 'MONEY', 'MONITOR', 'MONKEY', 'MONTH', 'MOOD', 'MORAL', 'MORNING', 'MORTAL',
    'MOTION', 'MOTOR', 'MOUNTAIN', 'MOUSE', 'MOVIE', 'MUD', 'MULTIPLE', 'MURDER', 'MUSCLE', 'MUSEUM', 'MUTUAL', 'MYSELF',
    'MYSTERY', 'NAIL', 'NARROW', 'NATION', 'NATIVE', 'NATURAL', 'NATURE', 'NEAT', 'NECESSARY', 'NEGATIVE', 'NEGLECT', 'NEIGHBOR',
    'NEPHEW', 'NERVE', 'NEST', 'NET', 'NETWORK', 'NEWS', 'NICHE', 'NIECE', 'NIGHT', 'NINE', 'NOBLE', 'NOD',
    'NOISE', 'NONE', 'NOON', 'NOR', 'NORMAL', 'NORTH', 'NOTE', 'NOTHING', 'NOTICE', 'NOVEL', 'NUMEROUS', 'NURSE',
    'NUT', 'OAK', 'OATH', 'OBEY', 'OBJECT', 'OBLIGE', 'OBSERVE', 'OBTAIN', 'OBVIOUS', 'OCCASION', 'OCCUPY', 'OCCUR',
    'OCEAN', 'ODD', 'OFFER', 'OFFICE', 'OFFICER', 'OKAY', 'ONCE', 'OPERA', 'OPERATE', 'OPINION', 'OPPONENT', 'OPPOSE',
    'OPTION', 'ORDER', 'ORGAN', 'ORGANIZE', 'ORIGIN', 'OUGHT', 'OUTCOME', 'OUTER', 'OUTLINE', 'OUTPUT', 'OUTSIDE', 'OVEN',
    'OVERALL', 'OVERCOME', 'OWNER', 'PACE', 'PACK', 'PAIN', 'PAINT', 'PAIR', 'PALACE', 'PALE', 'PANEL', 'PANIC',
    'PARADE', 'PARENT', 'PARK', 'PARKING', 'PARTICULAR', 'PARTNER', 'PARTY', 'PASS', 'PASSAGE', 'PASSENGER', 'PASSION', 'PAST',
    'PATH', 'PATIENT', 'PATTERN', 'PAUSE', 'PAY', 'PEACE', 'PEAK', 'PEANUT', 'PEER', 'PEN', 'PENCIL', 'PEPPER',
    'PER', 'PERCENT', 'PERFECT', 'PERFORM', 'PERHAPS', 'PERIOD', 'PERMANENT', 'PERMISSION', 'PERSON', 'PERSONAL', 'PERSUADE', 'PET',
    'PHASE', 'PHOTO', 'PHRASE', 'PHYSICAL', 'PIANO', 'PICK', 'PICNIC', 'PIECE', 'PIG', 'PILE', 'PILOT', 'PIN',
    'PINK', 'PINT', 'PIPE', 'PITCH', 'PITY', 'PLAIN', 'PLAN', 'PLANE', 'PLANET', 'PLASTIC', 'PLATE', 'PLATFORM',
    'PLEASE', 'PLEASURE', 'PLENTY', 'PLOT', 'PLUG', 'PLUS', 'POCKET', 'POEM', 'POET', 'POISON', 'POLICE', 'POLICY',
    'POLITE', 'POLITICAL', 'POOL', 'POPULAR', 'PORK', 'PORT', 'POSE', 'POSITION', 'POSITIVE', 'POSSESS', 'POSSIBLE', 'POST',
    'POT', 'POTATO', 'POUND', 'POUR', 'POWDER', 'POWER', 'PRACTICAL', 'PRACTICE', 'PRAISE', 'PRAY', 'PRECIOUS', 'PREDICT',
    'PREFER', 'PREGNANT', 'PREMIUM', 'PREPARE', 'PRESENT', 'PRESIDENT', 'PRESS', 'PRESSURE', 'PRETEND', 'PRETTY', 'PREVENT', 'PREVIOUS',
    'PRICE', 'PRIDE', 'PRIEST', 'PRIMARY', 'PRIME', 'PRINCIPAL', 'PRINT', 'PRIOR', 'PRISON', 'PRIVATE', 'PRIZE', 'PROBABLY',
    'PROBLEM', 'PROCEED', 'PROCESS', 'PRODUCE', 'PRODUCT', 'PROFESSOR', 'PROFILE', 'PROFIT', 'PROGRAM', 'PROGRESS', 'PROJECT', 'PROMISE',
    'PROMOTE', 'PROMPT', 'PROOF', 'PROPER', 'PROPERTY', 'PROPOSAL', 'PROSPECT', 'PROTECT', 'PROVE', 'PROVIDE', 'PUBLIC', 'PUBLISH',
    'PULSE', 'PUMP', 'PUNCH', 'PUNISH', 'PUPIL', 'PURCHASE', 'PURE', 'PURPLE', 'PURPOSE', 'PURSUE', 'QUALITY', 'QUANTITY',
    'QUARTER', 'QUESTION', 'QUICK', 'QUIT', 'QUITE', 'RACE', 'RADIO', 'RAIL', 'RAISE', 'RALLY', 'RANDOM', 'RANGE',
    'RANK', 'RAPID', 'RARE', 'RATE', 'RATHER', 'RAW', 'REACH', 'REAL', 'REALIZE', 'REALLY', 'REASON', 'RECEIVE',
    'RECENT', 'RECEPTION', 'RECIPE', 'RECOGNIZE', 'RECORD', 'RECOVER', 'REDUCE', 'REFER', 'REFLECT', 'REFORM', 'REFUSE', 'REGARD',
    'REGION', 'REGULAR', 'REGULATE', 'REJECT', 'RELATE', 'RELAX', 'RELEASE', 'RELIABLE', 'RELIEF', 'RELIGION', 'RELY', 'REMAIN',
    'REMARK', 'REMEMBER', 'REMIND', 'REMOTE', 'REMOVE', 'RENT', 'REPAIR', 'REPEAT', 'REPLACE', 'REPLY', 'REPORT', 'REPRESENT',
    'REPUBLIC', 'REQUEST', 'REQUIRE', 'RESCUE', 'RESEARCH', 'RESERVE', 'RESIDENT', 'RESIST', 'RESOLVE', 'RESORT', 'RESOURCE', 'RESPECT',
    'RESPOND', 'RESPONSE', 'REST', 'RESTAURANT', 'RESULT', 'RETAIN', 'RETIRE', 'RETURN', 'REVEAL', 'REVIEW', 'REWARD', 'RIDE',
    'RING', 'RIPE', 'RISE', 'RISK', 'RIVER', 'ROAD', 'ROB', 'ROCK', 'ROLE', 'ROLL', 'ROOM', 'ROOT',
    'ROPE', 'ROSE', 'ROUGH', 'ROUND', 'ROUTE', 'ROW', 'ROYAL', 'RUB', 'RUDE', 'RUIN', 'RULE', 'RURAL',
    'RUSH', 'SAD', 'SAIL', 'SALAD', 'SALE', 'SAMPLE', 'SAND', 'SATISFY', 'SAUCE', 'SAVE', 'SCALE', 'SCAN',
    'SCARE', 'SCENE', 'SCHEDULE', 'SCHEME', 'SCHOLAR', 'SCIENCE', 'SCISSORS', 'SCOPE', 'SCORE', 'SCRATCH', 'SCREAM', 'SCREEN',
    'SCRIPT', 'SEA', 'SEAL', 'SEARCH', 'SEASON', 'SEAT', 'SECOND', 'SECRET', 'SECTION', 'SECTOR', 'SECURE', 'SEED',
    'SEEK', 'SEGMENT', 'SELECT', 'SELF', 'SELL', 'SEND', 'SENIOR', 'SENSE', 'SEPARATE', 'SERIES', 'SERIOUS', 'SERVE',
    'SERVICE', 'SESSION', 'SETTLE', 'SEVEN', 'SEVERAL', 'SEVERE', 'SEW', 'SHADE', 'SHADOW', 'SHAKE', 'SHALL', 'SHAME',
    'SHAPE', 'SHARE', 'SHARP', 'SHEEP', 'SHEET', 'SHELF', 'SHELL', 'SHELTER', 'SHIFT', 'SHINE', 'SHIP', 'SHIRT',
    'SHOCK', 'SHOE', 'SHOOT', 'SHOP', 'SHORE', 'SHOULDERS', 'SHOUT', 'SHOWER', 'SHUT', 'SICK', 'SIGHT', 'SIGN',
    'SIGNAL', 'SILENCE', 'SILK', 'SILLY', 'SIMILAR', 'SIMPLE', 'SINCE', 'SINGLE', 'SISTER', 'SIT', 'SITE', 'SITUATION',
    'SIX', 'SIZE', 'SKILL', 'SKIRT', 'SKY', 'SLICE', 'SLIDE', 'SLIGHT', 'SLIM', 'SLIP', 'SLOPE', 'SMART',
    'SMELL', 'SMOKE', 'SMOOTH', 'SNAKE', 'SOAP', 'SOCIAL', 'SOCIETY', 'SOCK', 'SOIL', 'SOLAR', 'SOLDIER', 'SOLID',
    'SOLUTION', 'SOLVE', 'SOMEONE', 'SOMETIMES', 'SON', 'SOON', 'SORT', 'SOUL', 'SOUP', 'SOURCE', 'SOUTH', 'SPACE',
    'SPARE', 'SPEAK', 'SPECIAL', 'SPECIES', 'SPECIFIC', 'SPEECH', 'SPEED', 'SPHERE', 'SPILL', 'SPIN', 'SPIRIT', 'SPITE',
    'SPLIT', 'SPOKE', 'SPONSOR', 'SPOON', 'SPORT', 'SPOT', 'SPRAY', 'SPREAD', 'SPRING', 'SQUARE', 'STABLE', 'STAFF',
    'STAGE', 'STAIR', 'STAND', 'STANDARD', 'STARE', 'STATE', 'STATION', 'STAY', 'STEADY', 'STEAK', 'STEAL', 'STEAM',
    'STEEL', 'STEEP', 'STEER', 'STEM', 'STEP', 'STICK', 'STING', 'STIR', 'STOOD', 'STORE', 'STORM', 'STOVE',
    'STRAIGHT', 'STRANGE', 'STRATEGY', 'STRAW', 'STREAM', 'STREET', 'STRENGTH', 'STRESS', 'STRETCH', 'STRICT', 'STRIKE', 'STRING',
    'STRIP', 'STROKE', 'STRUCTURE', 'STRUGGLE', 'STUDENT', 'STUDIO', 'STUFF', 'STUPID', 'STYLE', 'SUBJECT', 'SUBMIT', 'SUBSTANCE',
    'SUBWAY', 'SUCCEED', 'SUCCESS', 'SUDDEN', 'SUFFER', 'SUGAR', 'SUGGEST', 'SUIT', 'SUMMER', 'SUPER', 'SUPPER', 'SUPPLY',
    'SUPPORT', 'SUPPOSE', 'SUPREME', 'SURFACE', 'SURGERY', 'SURPRISE', 'SURROUND', 'SURVEY', 'SURVIVE', 'SUSPECT', 'SWEAR', 'SWEAT',
    'SWEEP', 'SWIM', 'SWING', 'SWITCH', 'SYMBOL', 'SYSTEM', 'TACKLE', 'TAIL', 'TALE', 'TALENT', 'TALL', 'TANK',
    'TAP', 'TAPE', 'TARGET', 'TASK', 'TASTE', 'TAX', 'TEA', 'TEACH', 'TEAM', 'TECHNICAL', 'TECHNIQUE', 'TECHNOLOGY',
    'TEEN', 'TEMPLE', 'TEMPORARY', 'TEN', 'TEND', 'TENNIS', 'TENSION', 'TERM', 'TERRIBLE', 'TERRITORY', 'TEST', 'TEXT',
    'THANK', 'THEME', 'THEMSELVES', 'THEORY', 'THICK', 'THIN', 'THIRD', 'THOROUGH', 'THREAD', 'THREAT', 'THROW', 'THUMB',
    'TICKET', 'TIDE', 'TIE', 'TIGHT', 'TIN', 'TINY', 'TIP', 'TIRE', 'TITLE', 'TOAST', 'TODAY', 'TOILET',
    'TOLD', 'TOMATO', 'TONE', 'TONIGHT', 'TOOL', 'TOPIC', 'TOTAL', 'TOUCH', 'TOUGH', 'TOUR', 'TOWARD', 'TOWER',
    'TOWN', 'TOY', 'TRACE', 'TRACK', 'TRADE', 'TRADITION', 'TRAFFIC', 'TRANSFER', 'TRANSFORM', 'TRANSIT', 'TRANSLATE', 'TRAP',
    'TRAVEL', 'TRAY', 'TREAT', 'TREND', 'TRIAL', 'TRIBE', 'TRICK', 'TRIP', 'TROOP', 'TROUBLE', 'TRUCK', 'TRUST',
    'TRUTH', 'TUBE', 'TUNE', 'TWELVE', 'TWENTY', 'TWICE', 'TWIN', 'TYPE', 'TYPICAL', 'UGLY', 'ULTIMATE', 'UMBRELLA',
    'UNABLE', 'UNCLE', 'UNDERSTAND', 'UNIFORM', 'UNION', 'UNIQUE', 'UNIT', 'UNITE', 'UNITY', 'UNIVERSE', 'UNIVERSITY', 'UNKNOWN',
    'UNLESS', 'UNTIL', 'UPDATE', 'UPON', 'UPPER', 'UPSIDE', 'URBAN', 'URGE', 'USED', 'USEFUL', 'USUAL', 'USUALLY',
    'VACATION', 'VALLEY', 'VALUABLE', 'VALUE', 'VAN', 'VARIETY', 'VARIOUS', 'VARY', 'VAST', 'VEGETABLE', 'VEHICLE', 'VENTURE',
    'VERB', 'VEST', 'VIA', 'VICTIM', 'VICTORY', 'VIDEO', 'VIEW', 'VILLAGE', 'VIRUS', 'VISION', 'VISIT', 'VISUAL',
    'VITAL', 'VITAMIN', 'VOICE', 'VOLUME', 'VOTE', 'WAGE', 'WAIT', 'WANDER', 'WAR', 'WARN', 'WASH', 'WASTE',
    'WATCH', 'WAVE', 'WEALTH', 'WEAPON', 'WEAR', 'WEATHER', 'WEAVE', 'WEB', 'WEDDING', 'WEEK', 'WEIGH', 'WEIGHT',
    'WELCOME', 'WEST', 'WET', 'WHEEL', 'WHETHER', 'WHITE', 'WHOLE', 'WIDOW', 'WIDTH', 'WIFE', 'WILD', 'WIN',
    'WINE', 'WING', 'WINNER', 'WINTER', 'WIPE', 'WIRE', 'WISDOM', 'WISE', 'WISH', 'WITHIN', 'WITHOUT', 'WOLF',
    'WOMAN', 'WONDER', 'WOODEN', 'WORRY', 'WORTH', 'WOUND', 'WRAP', 'WRITER', 'WRONG', 'YARD', 'YELLOW', 'YESTERDAY',
    'YET', 'YIELD', 'YOURS', 'YOURSELF', 'YOUTH', 'ZERO', 'ZONE',
  ]);

  function pickPersonaMove(moves, elo) {
    // A persona plays like a human at its Elo, not like an engine: it
    // strongly prefers everyday words, and the Elo sets how deep into
    // the pool it reaches. Most of the time (85%) the persona only
    // considers everyday words at all — an obscure best play is only
    // even on the table 15% of the time, and only a few of the very
    // best plays are ever candidates. Within the pool the pick is
    // spread over a wider slice than before, so the single best move
    // is picked far less often: the old reach let a ~1130 persona pick
    // the optimal move about half the time. The reach still tightens
    // with Elo (a higher-Elo persona reaches a smaller, better slice),
    // so Elo still means stronger play — just less optimal. Think time
    // is unchanged (see personaThinkMsForMove): a 7s move is a simple
    // one, a 33s think is a better outcome, averaging ~20s.
    if (!moves.length) return null;
    const common = moves.filter(m => m.mainWord && COMMON_WORDS.has(m.mainWord));
    // Best plays the persona can consider: none at 800, one more per
    // ~100 Elo above 900, up to 3. moves is sorted by score, so the
    // first few are the best plays on the board.
    const topN = Math.max(0, Math.min(3, Math.floor((elo - 900) / 100)));
    const top = moves.slice(0, topN);
    // High common-word bias: 85% of the time the pool is everyday
    // words only. With no common move available, the pool is all moves
    // and the same Elo reach applies (a 1200 persona still plays its
    // best).
    const pool = [];
    if (common.length && Math.random() >= 0.15) pool.push(...common);
    else {
      for (const m of common) if (!pool.includes(m)) pool.push(m);
      for (const m of top) if (!pool.includes(m)) pool.push(m);
    }
    if (!pool.length) pool.push(...moves);
    pool.sort((a, b) => b.score - a.score);
    // Reach is rounded to three decimals so a floating-point hair above
    // a round number cannot push the pool depth up by a whole move.
    // 800 Elo reaches the top 60%, 1000 the top 40%, 1200 the top 20%.
    const reach = Math.round(Math.max(0.2, Math.min(0.6, 0.6 - (elo - 800) * 0.001)) * 1000) / 1000;
    const k = Math.max(1, Math.ceil(pool.length * reach));
    return pool[Math.floor(Math.random() * Math.min(k, pool.length))];
  }

  function personaThinkMs(game) {
    // The one exception is the final move: once the persona clock is
    // under 20 seconds, they always get exactly one more move, played
    // with 1-8 seconds left on their clock. After that move the pending
    // flag is spent (see runBotTurn), so later turns use the normal
    // think and the clock runs out mid-think, which the out-of-time
    // skip handles.
    // A persona never moves in under 3 seconds, even on the final
    // move: the think is at least 3000ms, and the turn is skipped
    // outright if the clock cannot hold it (see advanceBotTurnIfReady).
    if (game.personaFinalMovePending) return Math.max(3000, game.clocks.bot - (1000 + Math.floor(Math.random() * 7000)));
    // Short placeholder only: the real think is set from the move
    // itself once scheduleBotMove picks it (see
    // personaThinkMsForMove), so a weak filler is spotted in seconds
    // and a big play takes a long think. The client polls at this
    // placeholder and re-polls at the revised time, so a slow solve
    // can only ever play the move early, never late.
    return 5000;
  }

  function personaThinkMsForMove(score, bestScore, clockMs) {
    // Think time tracks the move against the best play on the board:
    // the easiest play comes after ~7s, the best after ~33s, averaging
    // ~20s. Strength is measured against the best move available
    // (passed in as bestScore), so a near-best play takes a long think
    // and a filler is quick, and the full 7-33s range gets used. A
    // couple of seconds of jitter keeps it from feeling mechanical.
    // Never think past the clock: a long think on a short clock would
    // forfeit the move outright. And never under 3 seconds: a persona
    // never moves that fast, even at the end.
    const frac = bestScore > 0 ? Math.max(0, Math.min(1, score / bestScore)) : 0;
    const think = Math.min(33000, 7000 + frac * 26000 + Math.floor(Math.random() * 2000));
    if (Number.isFinite(clockMs) && clockMs > 0) return Math.max(3000, Math.min(think, clockMs - 1000));
    return think;
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

  // ---------- Elo / stats (pure, no WORDS) ----------
  function eloDelta(playerElo, oppElo, actual) {
    const expected = 1 / (1 + Math.pow(10, (oppElo - playerElo) / 400));
    return Math.round(32 * (actual - expected));
  }

  function computeStats(moves) {
    let best = null, longest = null, optimal = 0, total = 0, unique = new Set(), optimalWords = [], optimalMoves = [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      total++;
      // v154: the stat window's optimal-moves list needs the same
      // moves the tally counts — with their 1-based number for this
      // side, the word and the score. (The list used to rebuild from
      // the client's game.moves, which is empty for server games and
      // Game History review, so it showed 0 while the tally said N.)
      if (m.isOptimal) { optimal++; if (m.mainWord) optimalWords.push(m.mainWord); optimalMoves.push({ n: i + 1, word: m.mainWord || '', score: m.score || 0 }); }
      // Highest "word" is the highest-scoring PLAY, named by its main
      // word — same unit as the profile stats (see profileStatsFor).
      if (!best || (m.score || 0) > best.score) best = { word: m.mainWord || '', score: m.score || 0 };
      for (const w of m.words) {
        unique.add(w.word);
        if (!longest || w.word.length > longest.word.length) longest = w;
      }
    }
    return { best, longest, optimal, total, uniqueCount: unique.size, optimalWords, optimalMoves };
  }

  function gameStatsPayload(game, flip) {
    const h = computeStats(game.moves.human || []);
    const b = computeStats(game.moves.bot || []);
    const hs = { best: h.best, longest: h.longest, optimal: h.optimal, total: h.total, uniqueCount: h.uniqueCount, optimalWords: h.optimalWords, optimalMoves: h.optimalMoves };
    const bs = { best: b.best, longest: b.longest, optimal: b.optimal, total: b.total, uniqueCount: b.uniqueCount, optimalWords: b.optimalWords, optimalMoves: b.optimalMoves };
    // The stat window shows the viewer on the left: flip the sides
    // (and the winner, the scores, and the Elo moves) for the
    // opponent of a real game, same rule as serializeGame.
    return {
      reason: game.reason,
      winner: flip ? (game.winner === 'human' ? 'bot' : game.winner === 'bot' ? 'human' : game.winner) : game.winner,
      scores: flip ? { human: game.scores.bot, bot: game.scores.human } : game.scores,
      human: flip ? bs : hs,
      bot: flip ? hs : bs,
      eloDeltaHuman: flip ? game.eloDeltaBot : game.eloDeltaHuman,
      eloDeltaBot: flip ? game.eloDeltaHuman : game.eloDeltaBot,
      eloAfterHuman: flip ? game.eloAfterBot : game.eloAfterHuman,
      eloAfterBot: flip ? game.eloAfterHuman : game.eloAfterBot,
    };
  }

  // ---------- Factory: the WORDS-dependent half ----------
  // validatePlay and findMoves close over the injected WORDS set and
  // the index built from it, so the server and the client run the
  // exact same solver against the exact same dictionary.
  function createEngine(WORDS) {
    // Solver index (length -> pos -> letter -> words). Built LAZILY on
    // the first findMoves call, not at creation (v107): the index build
    // is the ~1s startup cost that used to block the first bot-game tap
    // — the tap only needs makePremiums/drawRack/emptyBoard, none of
    // which touch the index, so creation is now cheap and the game
    // screen opens at once. findMoves is the only reader; the maps
    // are created eagerly (empty) so the exported references stay valid.
    const DICT_BY_LEN = new Map();
    const FIXED_INDEX = new Map();
    let indexBuilt = false;
    function ensureIndex() {
      if (indexBuilt) return;
      for (const w of WORDS) {
        if (!DICT_BY_LEN.has(w.length)) DICT_BY_LEN.set(w.length, []);
        DICT_BY_LEN.get(w.length).push(w);
        for (let p = 0; p < w.length; p++) {
          const key = `${w.length}|${p}|${w[p]}`;
          if (!FIXED_INDEX.has(key)) FIXED_INDEX.set(key, []);
          FIXED_INDEX.get(key).push(w);
        }
      }
      indexBuilt = true;
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
        // Highlight rule, same as findMoves: main1 is already the DUELLO
        // word or the higher-scoring of the two, so it is the highlight.
        return { valid: true, words: scored1, score: scored1.reduce((s, w) => s + w.score, 0) + bonus1, mainWord: main1.word, mainCells: main1.cells, highlightCells: main1.cells, bonus: bonus1, isDuello: isDuello1, bingo: false, placements };
      }
      // Words formed
      const main = wordAt(trial, placements[0].row, placements[0].col, dir);
      if (main.word.length < 2) return { valid: false, error: 'Word too short.' };
      const words = [{ word: main.word, cells: main.cells }];
      const crossDir = dir === 'H' ? 'V' : 'H';
      for (const p of placements) {
        const cross = wordAt(trial, p.row, p.col, crossDir);
        if (cross.word.length >= 2 && !words.some(w => w.word === cross.word && JSON.stringify(w.cells) === JSON.stringify(cross.cells))) {
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
      // Highlight rule, same as findMoves: the main word, since this
      // branch only runs for multi-tile plays (single tiles go through
      // the branch above). Without this, applyMove stored
      // lastCells = undefined for every human move, so the last-play
      // bubble — and the white last-word border — only ever showed
      // after the opponent's moves.
      return { valid: true, words: scored, score, mainWord: main.word, mainCells: main.cells, highlightCells: main.cells, bonus, isDuello, bingo, placements };
    }

    function findMoves(board, rack, isFirst, wantAll) {
      ensureIndex();
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
                    if (!words.some(w => w.word === cross.word && JSON.stringify(w.cells) === JSON.stringify(cross.cells))) {
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

    return {
      SIZE, INNER, LETTER_VALUES, VOWELS, FREQ, COMMON_WORDS,
      isInner, isOuter, makePremiums, emptyBoard, boardIsEmpty,
      wordAt, scoreWord, validatePlay, findMoves,
      botSkillRates, pickPersonaMove, personaThinkMs, personaThinkMsForMove, pickCompetitiveMove,
      drawLetter, drawRack, drawVowel, drawConsonant, drawCapped, refillRack,
      eloDelta, computeStats, gameStatsPayload,
      WORDS, DICT_BY_LEN, FIXED_INDEX, rackSubset, permutationsFromRack,
    };
  }

  return { createEngine };
});
