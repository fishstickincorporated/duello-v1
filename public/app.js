// Duello bot-play frontend (Postgres, no login). Server is the source of truth:
// Submitted plays are validated server-side; the verdict shown while placing
// tiles is computed locally once the word list has loaded, so the check is
// instant instead of a network round-trip per placement.
// Auth is required before entering the app: on load, a missing or
// rejected session shows the auth screen (email/password signup and
// sign-in). The token in localStorage ('duello_token') is an account
// session token; games use it, so a signed-in account plays as itself.
// Saved-login access must never kill the page: a browser that blocks
// site data (e.g. Safari's Block All Cookies) throws on localStorage
// access, and a throw on the very first line used to leave every screen
// hidden forever. These wrappers degrade to a memory-only session.
function storeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function storeDel(k) { try { localStorage.removeItem(k); } catch {} }
let token = storeGet('duello_token') || '';
let me = null, game = null, gameFetchAt = 0;
// Declared up here, not with the auth block below: the boot code calls
// setAuthMode, which assigns authMode, so this declaration must already
// have run or the page dies before any screen shows (ReferenceError:
// Cannot access 'authMode' before initialization).
let authMode = 'signin';
let pending = []; // {row,col,letter,rackIndex}
let selectedRack = null, armed = {}, currentBot = 'competitive';
// Global drag state: only one drag can be live, and a stuck drag must be
// cleanable from anywhere (notably Play). The old per-tile closures could
// leave a drag alive with pointer capture held, so every later tap went to
// the captured tile instead of the button underneath — the frozen screen
// in Jeff's screenshot, and the "tap elsewhere, then Play works" pattern.
let activeDragCleanup = null;
function registerDragCleanup(fn) { if (activeDragCleanup && activeDragCleanup !== fn) { try { activeDragCleanup(); } catch {} } activeDragCleanup = fn; }
function clearDragCleanup(fn) { if (activeDragCleanup === fn) activeDragCleanup = null; }
function cleanupStuckDrag() { if (activeDragCleanup) { const fn = activeDragCleanup; activeDragCleanup = null; try { fn(); } catch {} } }
const $ = id => document.getElementById(id);
// Optimistic rack refill (mirrors server refillRack/drawLetter exactly,
// including the >=2 vowels / >=2 consonants floor). Used only so new
// tiles appear at the Play tap, not when the Play POST returns; the
// server reply then replaces the rack with its authoritative letters.
const OPT_VOWELS = new Set(['A','E','I','O','U']);
const OPT_FREQ = [['A',8.59],['B',2.46],['C',2.39],['D',4.31],['E',9.43],['F',2.16],['G',3.00],['H',2.39],['I',6.26],['J',1.46],['K',1.77],['L',4.51],['M',2.68],['N',5.62],['O',6.43],['P',2.70],['Q',1.38],['R',6.44],['S',6.12],['T',6.17],['U',4.41],['V',1.94],['W',2.20],['X',1.51],['Y',2.20],['Z',1.48]];
const OPT_FREQ_CUM = []; { let s = 0; for (const [l, f] of OPT_FREQ) { s += f; OPT_FREQ_CUM.push([s, l]); } }
function optDrawLetter() { const r = Math.random() * 100; for (const [cum, l] of OPT_FREQ_CUM) if (r <= cum) return l; return 'E'; }
function optDrawVowel() { for (let i = 0; i < 100; i++) { const l = optDrawLetter(); if (OPT_VOWELS.has(l)) return l; } return 'E'; }
function optDrawConsonant() { for (let i = 0; i < 100; i++) { const l = optDrawLetter(); if (!OPT_VOWELS.has(l)) return l; } return 'B'; }
function optRefillRack(rack, usedIndices) {
  const next = rack.slice(); const usedSet = new Set(usedIndices);
  const unplayed = next.filter((_, i) => !usedSet.has(i));
  let needV = Math.max(0, 2 - unplayed.filter(c => OPT_VOWELS.has(c)).length);
  let needC = Math.max(0, 2 - unplayed.filter(c => !OPT_VOWELS.has(c)).length);
  for (const idx of usedIndices) {
    if (needV > 0) { next[idx] = optDrawVowel(); needV--; }
    else if (needC > 0) { next[idx] = optDrawConsonant(); needC--; }
    else next[idx] = optDrawLetter();
  }
  return next;
}
let optimisticPlay = false;
// Display rounding is CEIL, not floor: with floor, 4:00 dropped to 3:59
// within ~100ms of starting (299500ms remaining floors to 4:59), so
// the timer never sat on 4:00 for a full second. With ceil, 4:00 shows
// for the whole first second (240000 down to 239001ms), then 3:59 for
// the next full second, and so on. The old ceil problem (runoff parsed
// back from displayed text jumping up a second) no longer applies:
// runoff now starts from game state, not from displayed text.
const fmtClock = ms => { ms = Math.max(0, Math.ceil(ms / 1000) * 1000); if (ms === 0) return '0:00'; const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return `${m}:${String(s).padStart(2, '0')}`; };
// Clock accuracy fix: the old code used Math.ceil, so the display was
// always rounded UP to the next second — the clock looked a second
// ahead of the real remaining time, and the bot runoff (parsed back
// from that displayed text) started a second high, i.e. it jumped UP
// before animating down 15s to the 20s mark. Floor matches the real time.
// The iOS shell (TestFlight) serves the app from capacitor://localhost,
// so a relative /api/... would resolve against the local file and fail.
// In the shell, every API call (fetch and the EventSource stream) goes
// to the live server instead. On the web the base is empty, so nothing
// changes there. Capacitor exposes window.Capacitor in the shell.
const API_BASE = (typeof window !== 'undefined' && window.Capacitor) ? 'https://duellogame.com' : '';
async function api(path, opts = {}) {
  const r = await fetch(API_BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Request failed'); if (j.invalidWords) e.invalidWords = j.invalidWords; throw e; }
  return j;
}
function show(id) {
  // Leaving the board closes the live game stream (a new game opens
  // its own in enterGameScreen); the stat window is an overlay on
  // the game screen, so it never closes the stream.
  if (id !== 'gameScreen') closeGameStream();
  // Leaving a matchmaking screen abandons it: a searching or
  // rematch timer must never start a game after the user walked
  // away (tab tap, back navigation) — the timers check their flags,
  // and show() clears them on any navigation away.
  if (id !== 'searchingScreen') cancelSearch();
  if (id !== 'rematchScreen') cancelRematch();
  ['homeScreen', 'botScreen', 'friendsScreen', 'profileScreen', 'profileEditScreen', 'authScreen', 'gameScreen', 'searchingScreen', 'rematchScreen'].forEach(s => { const el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
  const isMenu = ['homeScreen', 'botScreen', 'friendsScreen', 'profileScreen', 'profileEditScreen'].includes(id);
  const tb = $('tabBar'); if (tb) tb.classList.toggle('hidden', !isMenu);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if ((id === 'homeScreen' || id === 'botScreen') && $('tabHome')) $('tabHome').classList.add('active');
  if (id === 'friendsScreen' && $('tabFriends')) $('tabFriends').classList.add('active');
  if ((id === 'profileScreen' || id === 'profileEditScreen') && $('tabProfile')) $('tabProfile').classList.add('active');
  // First Home render warms the Profile + Leaderboard caches (below).
  if (id === 'homeScreen') preloadHomeTabs();
}
function silhouetteSVG(size) { return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="8" r="4" fill="#b3b2b1"/><path d="M4 21 C4 16 7 13 12 13 C17 13 20 16 20 21 Z" fill="#b3b2b1"/></svg>`; }
function pfpHTML(userLike) {
  if (userLike && userLike.photoData) return `<img src="${userLike.photoData}" alt="">`;
  return silhouetteSVG(36);
}
// A persona photo is a remote URL (randomuser.me / picsum): when it
// fails to load, Safari paints its broken-image "?" inside the
// circle instead of the silhouette. Any failed photo is swapped for
// the inline silhouette, which cannot fail and cannot loop. Capture
// phase: <img> errors do not bubble. Only photos are touched — the
// logo and other images are left alone.
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'IMG' || !t.closest) return;
  const host = t.closest('.pfp, .lb-pfp, .person-pfp');
  if (!host) return;
  host.classList.add('no-photo');
  t.outerHTML = silhouetteSVG(32);
}, true);

// ---------- First-open intro (v96) ----------
// Black overlay, real logo starts zoomed in 3x, pulls back fast, sits
// 2s, then zooms in fast to reveal Home. Plays once per device
// (localStorage duello_intro_seen, set on finish or skip); tap the
// overlay to skip. Behind it, 20 premium-colour squares flicker on/off
// across the whole background, each jumping to a new grid cell per
// cycle — never overlapping, never in neighbouring cells, same colour
// kept further apart. WAAPI calls are guarded: the client harness runs
// this file in a vm with no Element.animate, and the intro must never
// kill the boot there (or on a browser without WAAPI).
const INTRO_SEEN_KEY = 'duello_intro_seen';
function introCellFree(occupied, col, row, ci) {
  for (let dc = -2; dc <= 2; dc++) {
    for (let dr = -2; dr <= 2; dr++) {
      if (dc === 0 && dr === 0) continue;
      const occ = occupied[(col + dc) + ',' + (row + dr)];
      if (occ === undefined) continue;
      const dist = Math.max(Math.abs(dc), Math.abs(dr));
      if (dist === 1) return false;
      if (dist === 2 && occ === ci) return false;
    }
  }
  return true;
}
function introPlaceCell(el, ci, occupied) {
  if (el._introCell) delete occupied[el._introCell];
  let col = 0, row = 0, key = '0,0', tries = 0;
  do {
    col = Math.floor(Math.random() * 9);
    row = Math.floor(Math.random() * 15);
    key = col + ',' + row;
    tries++;
  } while ((occupied[key] !== undefined || !introCellFree(occupied, col, row, ci)) && tries < 300);
  if (occupied[key] !== undefined || !introCellFree(occupied, col, row, ci)) {
    let found = false;
    for (let t = 0; t < 300 && !found; t++) {
      col = Math.floor(Math.random() * 9);
      row = Math.floor(Math.random() * 15);
      key = col + ',' + row;
      if (occupied[key] === undefined) found = true;
    }
    if (!found) { col = 0; row = 0; key = '0,0'; }
  }
  occupied[key] = ci; el._introCell = key;
  el.style.left = (col * 11.1 + Math.random() * 2.5) + '%';
  el.style.top = (row * 6.67 + Math.random() * 2) + '%';
}
function initIntro() {
  const overlay = $('introOverlay');
  if (!overlay) return;
  if (storeGet(INTRO_SEEN_KEY)) { overlay.style.display = 'none'; return; }
  const zoom = $('introLogoZoom');
  const flicker = $('introFlicker');
  const COLORS = ['255,19,3', '28,255,3', '255,3,238', '255,141,3'];
  const occupied = {};
  const anims = [];
  let timers = [];
  let started = false;
  if (flicker) {
    for (let k = 0; k < 20; k++) {
      const ci = k % 4;
      const s = document.createElement('div');
      s.className = 'intro-cell';
      s.style.background = 'rgb(' + COLORS[ci] + ')';
      s.style.animationDuration = (2.2 + Math.random() * 2).toFixed(2) + 's';
      s.style.animationDelay = (Math.random() * 2).toFixed(2) + 's';
      s._introCi = ci;
      introPlaceCell(s, ci, occupied);
      s.addEventListener('animationiteration', function () { introPlaceCell(this, this._introCi, occupied); });
      flicker.appendChild(s);
    }
  }
  function finishIntro() {
    started = true; // a late logo load must not restart the intro after a skip
    try { storeSet(INTRO_SEEN_KEY, '1'); } catch {}
    anims.forEach(a => { try { a.finish(); } catch {} });
    timers.forEach(clearTimeout); timers = [];
    overlay.style.display = 'none';
  }
  function playIntro() {
    // The zoom-out is invisible if the logo image has not painted yet
    // (the logo PNG is 2.6 MB and can still be downloading/decoding
    // when app.js runs), so the zoom-out waits for the logo to load —
    // with a 1.5s backstop so a slow or broken image never stalls the
    // intro. The 2s sit and the zoom-in are timed from the zoom-out,
    // not from page load.
    function startZoomOut() {
      if (started) return; started = true;
      if (zoom && typeof zoom.animate === 'function') {
        anims.push(zoom.animate([{ transform: 'scale(3)' }, { transform: 'scale(1)' }], { duration: 400, easing: 'cubic-bezier(.25,1.3,.35,1)', fill: 'both' }));
      }
      timers.push(setTimeout(() => {
        if (zoom && typeof zoom.animate === 'function') {
          anims.push(zoom.animate([{ transform: 'scale(1)' }, { transform: 'scale(8)' }], { duration: 650, easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' }));
        }
        if (typeof overlay.animate === 'function') {
          anims.push(overlay.animate([{ opacity: 1 }, { opacity: 0 }], { delay: 350, duration: 500, fill: 'forwards' }));
        }
      }, 2400));
      timers.push(setTimeout(finishIntro, 3400));
    }
    const logo = $('introLogo');
    if (logo && logo.complete === false) {
      logo.addEventListener('load', startZoomOut, { once: true });
      logo.addEventListener('error', startZoomOut, { once: true });
      timers.push(setTimeout(startZoomOut, 1500));
    } else {
      startZoomOut();
    }
  }
  overlay.addEventListener('click', finishIntro);
  playIntro();
}
initIntro();
function goTab(id) { show(id); }
$('tabHome').onclick = () => show('homeScreen');

// Profile + Leaderboard load in the background once Home first
// renders, so both tabs are instant when tapped. Idle-scheduled so
// Home stays responsive; the v74 load-once guards (profileData,
// globalRows, serverFriends) still hold, so a later tap never
// refetches — the preload only fills the same caches the tab taps
// fill. Silent on failure: a failed preload leaves the caches empty
// and the tab loads normally on tap. Never fires before the session
// is ready (no token / no user yet): the flag is set when the
// preload is scheduled, so a second Home render inside the idle
// window cannot schedule it twice. A session check runs first,
// because a rejected session inside renderProfileUI would bounce
// the user to sign-in from a background load.
let homeTabsPreloaded = false;
function preloadHomeTabs() {
  if (homeTabsPreloaded || !token || !me) return;
  homeTabsPreloaded = true;
  // Sequential on purpose: loadServerFriends pulls the Global rows
  // in first, so a parallel ensureGlobalRows would see the cache
  // still empty and fetch /api/leaderboard twice.
  const run = async () => {
    let d = null;
    try { d = await api('/api/me'); } catch { return; }
    try { await renderProfileUI(d); } catch {}
    try { await ensureGlobalRows(); } catch {}
    try { await loadServerFriends(); } catch {}
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { run(); }, { timeout: 2000 });
  else setTimeout(() => { run(); }, 500);
}

// ---------- Friends tab ----------
// The Global scope is real registered users, top by Elo, from GET
// /api/leaderboard (guest rows excluded server-side). The Friends
// scope lists accepted friends (no play button on the rows —
// challenging happens from the profile window's Play button).
// Friend requests are real since v53 (GET/POST /api/friends):
// sending one makes it appear at the top of the recipient's
// Friends page, and accepting it makes you friends. Personas
// have no account, so a request to one still lives only in
// localStorage, exactly as before. A challenge to a persona is
// answered by the same simulated accept/decline as a rematch
// request.
let lbScope = 'friends', deleteMode = false;
// Friend whose row is showing the inline "Remove?" button (set
// when the red × is tapped, cleared when it is tapped, when
// delete mode is left, or after the removal runs).
let pendingRemove = null;
let globalRows = null;
// The rendered leaderboard stays loaded for the session: a tab
// tap only shows the screen again instead of blanking and
// rebuilding the list. friendsStale goes true whenever the data
// behind it changes (a forced friends refetch, delete-mode
// toggles, a remove confirm), and friendsRenderedScope tracks
// which scope the DOM currently shows.
let friendsStale = true, friendsRenderedScope = null;
// Global Ranks already fetched for a profile, by username, so
// opening the same profile again shows the rank at once instead
// of waiting on the fetch. Keyed by the viewed player, not the
// viewer — the rank counts everyone, so it is the same whoever
// looks. Cleared when a game ends, because Elos (and therefore
// ranks) move then.
const rankCache = new Map();
// Server-owned friend state for the signed-in account: accepted
// friends, incoming requests, outgoing requests. Cached per
// username, so switching accounts never shows the old account's
// friends or requests.
let serverFriends = null, serverFriendsLoadedFor = null, friendMigrationDone = false;
async function loadServerFriends(force) {
  if (force) friendsStale = true;
  if (serverFriends && !force && serverFriendsLoadedFor === (me && me.username)) return serverFriends;
  await ensureGlobalRows();
  // One-time migration: requests made before v53 lived only in
  // this device's localStorage. Real-player ones move to the
  // server (so the other person finally sees them); a request to
  // yourself — the @neo -> @ceo self-friend bug, caused by
  // localStorage being shared by every account on one phone —
  // is dropped, and persona requests stay local.
  if (!friendMigrationDone) {
    friendMigrationDone = true;
    const stored = getFriendRequests(), keep = [];
    for (const u of stored) {
      const row = (globalRows || []).find(x => x.username === u);
      if (row && !row.isPersona && u !== (me && me.username)) {
        try { await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ username: u }) }); } catch {}
      } else if (!row || row.isPersona) keep.push(u);
    }
    try { localStorage.setItem('duello_friend_requests', JSON.stringify(keep)); } catch {}
  }
  try { const d = await api('/api/friends'); serverFriends = d; serverFriendsLoadedFor = me && me.username; }
  catch (err) { deadSession(err); serverFriends = { friends: [], incoming: [], outgoing: [] }; }
  return serverFriends;
}
function isRealFriend(username) { return (serverFriends && serverFriends.friends || []).some(u => u.username === username); }
function isRealRequested(username) { return (serverFriends && serverFriends.outgoing || []).some(u => u.username === username); }
// Requests to a persona are local-only (personas have no account
// to receive one): the username persists in localStorage so the
// row stays Requested across loads. Tapping Requested again
// unrequests: the toggle removes the name and the button goes
// back to the add icon. Requests to a real player go to the
// server instead — see loadServerFriends above.
// The button is an SVG icon, not text or emoji: a person
// silhouette with a plus for Add, and a sent paper airplane once
// the request is sent. Both draw in currentColor at 24px inside
// the 36px button, and both are grey: the shape, not the color,
// tells the two states apart.
function friendAddSVG() {
  return `<svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true"><circle cx="11" cy="8" r="4" fill="currentColor"/><path d="M3 22 C3 17 6.5 14.5 11 14.5 C15.5 14.5 19 17 19 22 Z" fill="currentColor"/><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 15 V25"/><path d="M16 20 H26"/></g></svg>`;
}
function friendSentSVG() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/></svg>`;
}
// The sent state is small grey text plus the small plane, not just
// an icon: `sent` + plane. Used on Global rows and in the stat
// window, so both stay identical.
function friendSentHTML() {
  return `<span class="sent-text">sent</span>${friendSentSVG()}`;
}
function playSVG() {
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>`;
}
function getFriendRequests() {
  try { const v = JSON.parse(localStorage.getItem('duello_friend_requests') || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function markFriendRequested(username) {
  try {
    const v = getFriendRequests();
    if (!v.includes(username)) { v.push(username); localStorage.setItem('duello_friend_requests', JSON.stringify(v)); }
  } catch {}
}
function unrequestFriend(username) {
  try {
    const v = getFriendRequests().filter(u => u !== username);
    localStorage.setItem('duello_friend_requests', JSON.stringify(v));
  } catch {}
}
async function ensureGlobalRows() {
  if (!globalRows) {
    try { const d = await api('/api/leaderboard'); globalRows = d.users || []; }
    catch (err) { deadSession(err); globalRows = []; }
  }
  return globalRows;
}
// One row shape for every leaderboard-style list (Global, Friends,
// search results): rank | pfp | name over username | Elo | action.
// The action depends on the list: Global and search show nothing
// there except the YOU badge on your own row — friends are added
// only from the profile window now. Friends shows a play icon that
// challenges that friend.
function lbRowHTML(r, actionHTML, opts) {
  // Search results show no rank at all (hideRank): the rank span
  // is left out and the row uses the no-rank grid, so nothing
  // shifts — pfp, name, action and Elo keep their columns.
  const rank = opts && opts.hideRank ? '' : `<span class="rank${(r.rank || 0) >= 100 ? ' small' : ''}">${r.rank ?? ''}</span>`;
  return `${rank}<span class="lb-pfp${r.photoData ? '' : ' no-photo'}">${pfpHTML(r)}</span><span class="lb-identity"><div class="lb-name">${shortName(r)}</div><div class="lb-user">@${r.username}</div></span>${actionHTML}<span class="lb-elo">${r.elo}</span>`;
}
function youBadgeHTML(r) {
  return r.isYou ? '<span class="lb-action"><span class="you-badge">YOU</span></span>' : '';
}
function playActionHTML(r) {
  return `<button class="lb-play" aria-label="Challenge ${r.name} to a game">${playSVG()}</button>`;
}
// Person profile window: tapping a name (Global, search, stat
// window) opens their profile — photo, name, username, Elo — with
// an add-friend button that toggles the same localStorage request
// as the row buttons. Your own profile has no button. Closing
// re-renders the lists behind it so a toggled request shows up
// everywhere at once.
let modalPerson = null;
function isModalFriend() {
  if (!modalPerson) return false;
  // Accepted friends only. A requested persona is not a friend:
  // personas never accept, so their button stays "sent" forever
  // instead of flipping to Play the moment you request them
  // (the old version counted a request as friendship here).
  return !modalPerson.isPersona && isRealFriend(modalPerson.username);
}
function renderPersonAddBtn() {
  const btn = $('personAddBtn');
  if (!modalPerson) return;
  btn.disabled = false;
  // A friend's profile shows Play, not Add Friend / Friends:
  // tapping it challenges them, same as the play icon on the
  // Friends list.
  if (isModalFriend()) {
    btn.classList.remove('sent');
    btn.innerHTML = '<span>Play</span>';
    btn.setAttribute('aria-label', `Play ${modalPerson.name}`);
  } else if (modalPerson.isPersona) {
    const requested = getFriendRequests().includes(modalPerson.username);
    btn.classList.toggle('sent', requested);
    btn.innerHTML = requested ? friendSentHTML() : `${friendAddSVG()}<span>Add Friend</span>`;
    btn.setAttribute('aria-label', requested ? `Cancel friend request to ${modalPerson.name}` : `Add ${modalPerson.name} as a friend`);
  } else {
    const requested = isRealRequested(modalPerson.username);
    btn.classList.toggle('sent', requested);
    btn.innerHTML = requested ? friendSentHTML() : `${friendAddSVG()}<span>Add Friend</span>`;
    btn.setAttribute('aria-label', requested ? `Cancel friend request to ${modalPerson.name}` : `Add ${modalPerson.name} as a friend`);
  }
}
async function openPersonModal(person) {
  modalPerson = person;
  if (!person.isPersona) await loadServerFriends();
  const pfp = $('personPfp');
  pfp.innerHTML = person.photoData ? `<img src="${person.photoData}" alt="">` : silhouetteSVG(64);
  pfp.classList.toggle('no-photo', !person.photoData);
  $('personName').textContent = person.name;
  $('personUser').textContent = '@' + person.username;
  $('personElo').textContent = person.elo;
  // Global Rank, below Elo. Show it at once when it is already
  // known — a Global row carries the server's true rank, and any
  // rank fetched before sits in the session cache. Otherwise
  // fetch it once (and cache it) instead of on every open; '—'
  // only while that first fetch is in flight.
  const knownRank = person.globalRank ?? rankCache.get(person.username);
  if (knownRank != null) $('personRank').textContent = knownRank;
  else {
    $('personRank').textContent = '—';
    api('/api/users/rank?username=' + encodeURIComponent(person.username)).then(d => { rankCache.set(person.username, d.rank); if (modalPerson && modalPerson.username === person.username) $('personRank').textContent = d.rank; }).catch(() => {});
  }
  $('personAddBtn').style.display = person.isYou ? 'none' : '';
  renderPersonAddBtn();
  $('personModal').classList.remove('hidden');
}
function closePersonModal() {
  $('personModal').classList.add('hidden');
  modalPerson = null;
  renderFriendsUI();
  if ($('friendSearch').value.trim()) runFriendSearch();
}
$('personCloseBtn').onclick = closePersonModal;
$('personModal').addEventListener('click', e => { if (e.target === $('personModal')) closePersonModal(); });
$('personAddBtn').onclick = async () => {
  if (!modalPerson || $('personAddBtn').disabled) return;
  if (isModalFriend()) {
    const p = modalPerson;
    closePersonModal();
    startChallenge(p);
    return;
  }
  if (modalPerson.isPersona) {
    if (getFriendRequests().includes(modalPerson.username)) unrequestFriend(modalPerson.username);
    else markFriendRequested(modalPerson.username);
  } else if (isRealRequested(modalPerson.username)) {
    try { await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ username: modalPerson.username }) }); } catch {}
    await loadServerFriends(true);
  } else {
    try { await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ username: modalPerson.username }) }); } catch {}
    await loadServerFriends(true);
  }
  renderPersonAddBtn();
};
function toLbRow(u) {
  return {
    id: u.id, isPersona: !!u.isPersona, rank: u.rank,
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    username: u.username, elo: u.elo, photoData: u.photoData || null,
    isYou: !!(me && u.username === me.username),
  };
}
// Leaderboards and search show first name + last initial only
// ("Jeff M."); the full name appears only when you tap through
// to the profile window.
function shortName(r) {
  const f = r.firstName || (r.name || '').split(' ')[0] || r.username;
  const ln = r.lastName || (r.name || '').split(' ').slice(1).join(' ');
  return ln ? `${f} ${ln[0]}.` : f;
}
async function renderFriendsUI() {
  // Already loaded for this scope and nothing changed since: just
  // keep the screen as it is. The tab tap already called show(),
  // so there is no blanking, no refetch, and no rebuild.
  if (!friendsStale && friendsRenderedScope === lbScope) return;
  // Pencil keeps its layout box on Global (visibility, not display), so the
  // LEADERBOARD label and everything below it sit at the exact same
  // position on both tabs instead of shifting when the pencil appears.
  $('friendsPencil').style.visibility = lbScope !== 'friends' ? 'hidden' : 'visible';
  // Blank the list synchronously, before any fetch: the old
  // account's rows used to sit visible for the whole refresh
  // after switching accounts, because the list was only cleared
  // once the new data came back.
  $('leaderboardList').innerHTML = '';
  $('friendRequests').innerHTML = '';
  $('noFriendsCard').classList.add('hidden');
  await loadMe();
  // A dead session was just sent to sign-in by loadMe; don't
  // render this account's lists on a cleared token.
  if (!token) return;
  await loadServerFriends();
  let rows = [];
  if (lbScope === 'global') {
    const users = await ensureGlobalRows();
    rows = users.map(toLbRow).sort((a, b) => b.elo - a.elo);
    // The rank on a Global row IS the true Global rank (the
    // server's RANK() over everyone), so the profile window can
    // show it at once with no fetch — see openPersonModal.
    rows.forEach(r => { r.globalRank = r.rank; });
    // Both leaderboards show first name + last initial (see
    // shortName in lbRowHTML). The full name still lives on the
    // row object, so the profile window (opened by tapping the
    // name) shows it.
  } else {
    // Friends are mutual: an accepted request puts each side on
    // the other's list (the server returns accepted rows in
    // either direction). This list is separate from Global and
    // has no cap — it is NOT resolved through the top-25
    // leaderboard, or a friend below the top 25 would vanish
    // from it. Nobody is a friend until they accept — real
    // players only arrive here via the server's accepted list,
    // and personas never arrive at all: a request to a persona
    // stays local "Requested" (the sent state on their profile
    // button) and nothing more, because fake humans never
    // accept. You are on your own Friends list too, and ranks
    // here start at 1 — your Global rank is a different number,
    // shown on your profile.
    const realRows = (serverFriends.friends || []).map(u => toLbRow(u));
    const selfRow = me ? toLbRow({ id: me.id, username: me.username, firstName: me.firstName, lastName: me.lastName, elo: me.elo, photoData: me.photoData || null, isPersona: false }) : null;
    rows = [...realRows, ...(selfRow ? [selfRow] : [])].sort((a, b) => b.elo - a.elo);
    // Ties share a rank, and the next rank skips ahead: two players
    // tied at 19 are both 19, and the next player is 21.
    let tieElo = null, tieRank = 0;
    rows.forEach((r, i) => { if (r.elo !== tieElo) { tieRank = i + 1; tieElo = r.elo; } r.rank = tieRank; });
  }
  const list = $('leaderboardList'); list.innerHTML = '';
  // Leaving delete mode (pencil off, or switching to Global)
  // dismisses a pending remove confirm with it.
  if (!deleteMode) pendingRemove = null;
  $('friendsPencil').classList.toggle('active', deleteMode && lbScope === 'friends');
  rows.forEach((r, i) => {
    const isFriends = lbScope === 'friends';
    // The row being confirmed gets a wider action column for the
    // "Remove?" button (see .lb-row.confirming in style.css).
    const confirming = isFriends && deleteMode && pendingRemove && pendingRemove.username === r.username;
    const row = document.createElement('div'); row.className = 'lb-row' + (r.isYou ? ' you' : '') + (confirming ? ' confirming' : '');
    // Grid row (see style.css): rank | pfp | name | action | Elo,
    // all fixed-width except the name, so every Elo sits in the
    // same column at the far right edge whatever the name length
    // or the button state. Your own row keeps the YOU badge in the
    // action slot, so its Elo lines up too and your full name never
    // has to shrink for the badge.
    // No play button on leaderboard rows any more: challenging
    // a friend happens only from their profile window (Play
    // button). The action slot stays as an empty box so the Elo
    // keeps its column at the far right. In delete mode the
    // slot holds a red ×; tapping it swaps in a "Remove?"
    // button right there in the same slot — nothing is removed
    // until that is tapped. Your own row is never removable.
    let action;
    if (!isFriends || r.isYou) action = youBadgeHTML(r);
    else if (deleteMode) action = confirming
      ? '<button class="lb-remove-confirm">Remove?</button>'
      : '<button class="lb-delete" aria-label="Remove friend">×</button>';
    else action = '<span class="lb-action"></span>';
    row.innerHTML = lbRowHTML(r, action);
    list.appendChild(row);
    if (isFriends && !r.isYou && deleteMode) {
      const delBtn = row.querySelector('.lb-delete');
      if (delBtn) delBtn.onclick = () => { pendingRemove = r; friendsStale = true; renderFriendsUI(); };
      const confBtn = row.querySelector('.lb-remove-confirm');
      if (confBtn) confBtn.onclick = async () => {
        const target = pendingRemove; pendingRemove = null;
        if (!target) return;
        if (target.isPersona) unrequestFriend(target.username);
        else { try { await api('/api/friends/remove', { method: 'POST', body: JSON.stringify({ username: target.username }) }); } catch {} await loadServerFriends(true); }
        friendsStale = true;
        renderFriendsUI();
      };
    }
    // Tapping the name opens their profile window.
    const nameEl = row.querySelector('.lb-name');
    if (nameEl) nameEl.onclick = () => openPersonModal(r);
  });
  // "No friends yet" counts friends only — your own row is always
  // on the Friends list, so an empty friends list still has you.
  const friendCount = lbScope === 'friends' ? rows.filter(r => !r.isYou).length : 0;
  $('noFriendsCard').classList.toggle('hidden', !(lbScope === 'friends' && friendCount === 0));
  // Incoming friend requests sit at the top of the Friends page,
  // above the list — that is how a request reaches the other
  // person now that requests live on the server.
  const reqEl = $('friendRequests'); reqEl.innerHTML = '';
  if (lbScope === 'friends') {
    // At most two requests at a time: deciding one reveals the next.
    for (const u of (serverFriends.incoming || []).slice(0, 2)) {
      const name = shortName({ firstName: u.firstName, lastName: u.lastName, name: '', username: u.username });
      const row = document.createElement('div'); row.className = 'request-row';
      row.innerHTML = `<span class="lb-pfp${u.photoData ? '' : ' no-photo'}">${pfpHTML(u)}</span><span class="lb-identity"><div class="lb-name">${name}</div><div class="lb-user">@${u.username}</div></span><span class="request-actions"><button class="mini-btn" data-act="accept">Accept</button><button class="mini-btn grey" data-act="decline">Decline</button></span>`;
      row.querySelector('[data-act="accept"]').onclick = async () => { try { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ username: u.username, accept: true }) }); } catch {} await loadServerFriends(true); renderFriendsUI(); };
      row.querySelector('[data-act="decline"]').onclick = async () => { try { await api('/api/friends/respond', { method: 'POST', body: JSON.stringify({ username: u.username, accept: false }) }); } catch {} await loadServerFriends(true); renderFriendsUI(); };
      reqEl.appendChild(row);
    }
  }
  // Incoming challenges sit above the friend requests: they are
  // live (60 seconds), so they render on every Friends visit and
  // the poll below keeps them fresh while the page is open. This
  // runs on both scopes — a challenge should reach you wherever
  // you are on the Friends page.
  renderIncomingChallenges();
  friendsStale = false; friendsRenderedScope = lbScope;
  // Warm the rank cache for the Friends list in the background,
  // so opening a friend's profile shows their Global Rank at
  // once instead of waiting on the fetch: the list is small, this
  // runs only on a real render, and already-cached names are
  // skipped. Global rows need none of this — they carry their
  // rank already (see the global branch above).
  if (lbScope === 'friends') {
    for (const r of rows) {
      if (rankCache.has(r.username)) continue;
      api('/api/users/rank?username=' + encodeURIComponent(r.username)).then(d => rankCache.set(r.username, d.rank)).catch(() => {});
    }
  }
}
// Incoming real-player challenges, rendered into the top of the
// Friends page (above the friend requests). Accept creates the
// game on the server and joins it; Decline ends the challenge.
// One fetch serves both the Friends-page rows and the challenge
// window, so the poll does not hit the server twice per cycle.
async function fetchIncomingChallenges() {
  try { const d = await api('/api/challenges/incoming'); return d.challenges || []; }
  catch (err) { if (deadSession(err)) return null; return []; }
}
async function renderIncomingChallenges(list) {
  const el = $('challengeRequests');
  if (!el) return [];
  if (list === undefined) { list = await fetchIncomingChallenges(); if (list === null) return []; }
  el.innerHTML = '';
  for (const c of list) {
    const u = c.from;
    const name = u.firstName || u.username;
    const row = document.createElement('div'); row.className = 'request-row';
    row.innerHTML = `<span class="lb-pfp${u.photoData ? '' : ' no-photo'}">${pfpHTML(u)}</span><span class="lb-identity"><div class="lb-name">${name} challenged you</div><div class="lb-user">@${u.username}</div></span><span class="request-actions"><button class="mini-btn" data-act="accept">Accept</button><button class="mini-btn grey" data-act="decline">Decline</button></span>`;
    row.querySelector('[data-act="accept"]').onclick = async () => {
      try {
        const d = await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) });
        if (d.gameId) { el.innerHTML = ''; joinChallengeGame(d.gameId); return; }
      } catch {}
      renderIncomingChallenges();
    };
    row.querySelector('[data-act="decline"]').onclick = async () => {
      try { await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: false }) }); } catch {}
      renderIncomingChallenges();
    };
    el.appendChild(row);
  }
  return list;
}
// A challenge pops up as a window wherever you are — Home, Profile,
// Bots, Global — not only on the Friends page. The poll below runs
// on every screen (it used to wait for the Friends page), and this
// shows the first pending challenge. One window at a time; a second
// challenger waits until the first is answered. If the shown challenge
// is no longer pending (the challenger cancelled it), the window
// closes on its own. The window is a hard modal: there is no × and no
// backdrop tap to get out of it — the player must Accept or Decline.
let challengeModalChallenge = null;
function maybeShowChallengeModal(list) {
  if (challengeModalChallenge && !list.some(x => x.id === challengeModalChallenge.id)) hideChallengeModal();
  if (challengeModalChallenge) return;
  const c = (list || [])[0];
  if (!c) return;
  // In a game the window waits until the game ends: showStatWindow
  // calls the check again, so it pops up at once instead of on the
  // next poll.
  if (game && game.status === 'active') return;
  showChallengeModal(c);
}
function showChallengeModal(c) {
  challengeModalChallenge = c;
  const u = c.from;
  const name = u.firstName || u.username;
  $('challengePfp').innerHTML = pfpHTML(u);
  $('challengePfp').classList.toggle('no-photo', !u.photoData);
  $('challengeName').textContent = name + ' challenged you';
  $('challengeUser').textContent = '@' + u.username;
  $('challengeModal').classList.remove('hidden');
}
function hideChallengeModal() {
  challengeModalChallenge = null;
  $('challengeModal').classList.add('hidden');
}
$('challengeAcceptBtn').onclick = async () => {
  const c = challengeModalChallenge; if (!c) return;
  hideChallengeModal();
  // Accepting withdraws any outgoing challenge I am waiting on, so
  // its accept can never strand me in a second game.
  cancelSearch();
  try {
    const d = await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) });
    if (d.gameId) { joinChallengeGame(d.gameId); return; }
  } catch {}
  checkIncomingChallenges();
};
$('challengeDeclineBtn').onclick = async () => {
  const c = challengeModalChallenge; if (!c) return;
  hideChallengeModal();
  try { await api(`/api/challenges/${c.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: false }) }); } catch {}
  checkIncomingChallenges();
};
// No × button and no backdrop tap: the only way out of the window is
// Accept or Decline (or the challenger cancelling, which closes it
// on its own via maybeShowChallengeModal).
// Challenges arrive while any screen is open, so poll for them every
// 5 seconds wherever you are — no push notification exists, and a
// 60-second challenge cannot wait for the next manual refresh. Runs
// once, guarded by token. The Friends rows and the window share one
// fetch per cycle.
let challengePollTimer = null;
function startChallengePoll() {
  if (challengePollTimer) return;
  challengePollTimer = setInterval(() => {
    if (!token) return;
    checkIncomingChallenges();
  }, 5000);
}
async function checkIncomingChallenges() {
  if (!token) return;
  const list = await fetchIncomingChallenges();
  if (list === null) return;
  renderIncomingChallenges(list);
  maybeShowChallengeModal(list);
}
startChallengePoll();
function showFriendsTab() {
  lbScope = 'friends';
  $('lbFriendsTab').classList.add('active'); $('lbGlobalTab').classList.remove('active');
  show('friendsScreen'); renderFriendsUI();
}
$('tabFriends').onclick = showFriendsTab;
$('lbFriendsTab').onclick = () => { lbScope = 'friends'; $('lbFriendsTab').classList.add('active'); $('lbGlobalTab').classList.remove('active'); renderFriendsUI(); };
$('lbGlobalTab').onclick = () => { lbScope = 'global'; deleteMode = false; $('lbGlobalTab').classList.add('active'); $('lbFriendsTab').classList.remove('active'); renderFriendsUI(); };
$('friendsPencil').onclick = () => { if (lbScope !== 'friends') return; deleteMode = !deleteMode; friendsStale = true; renderFriendsUI(); };
async function runFriendSearch() {
  // A leading @ is stripped: typing "@neo" searches for neo, so
  // the @ in a displayed handle never makes a search miss.
  const q = $('friendSearch').value.trim().toLowerCase().replace(/^@+/, ''); const el = $('friendSearchResults'); el.innerHTML = '';
  if (!q) return;
  // loadMe sends a dead session to sign-in and returns false;
  // don't run a search on a rejected session.
  if (!(await loadMe())) return;
  // Server search, not the top-25 leaderboard: a new account at
  // 1000 Elo is below the top 25 and was unfindable before.
  let users = null, searchFallback = false, searchFailReason = '';
  try { const d = await api('/api/users/search?q=' + encodeURIComponent(q)); users = d.users || []; }
  catch (err) {
    // A dead session goes to sign-in, never to the fallback: the
    // fallback only masks it, and the top-25 list is where a real
    // account below the top 25 looks unfindable. Anything else
    // falls back, and the note names the failure so the next
    // report says exactly what broke.
    if (deadSession(err)) return;
    searchFallback = true;
    searchFailReason = (err && err.message) || 'network error';
    const rows = await ensureGlobalRows();
    users = rows.filter(u => (`${u.firstName || ''} ${u.lastName || ''}`.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)));
  }
  if (searchFallback) {
    const note = document.createElement('div'); note.className = 'small';
    note.textContent = `Search isn't working (${searchFailReason}) — showing top players only.`;
    el.appendChild(note);
  }
  // At most the 5 most relevant results (the server already
  // ranks and caps at 5; this caps the fallback too).
  users.slice(0, 5).forEach(u => {
    // Search rows are leaderboard rows, not a compact variant:
    // pfp | name over username | Elo — no rank column at all.
    // No friend button here either — adding happens only from
    // the profile window.
    const r = toLbRow(u);
    // The search fallback (top-25 rows) carries the leaderboard
    // rank, which is the true Global one — tag it so the profile
    // window shows it at once. Server search results have no
    // rank, so those still fetch on first open.
    if (u.rank != null) r.globalRank = u.rank;
    const row = document.createElement('div'); row.className = 'lb-row no-rank' + (r.isYou ? ' you' : '');
    row.innerHTML = lbRowHTML(r, youBadgeHTML(r), { hideRank: true });
    el.appendChild(row);
    const nameEl = row.querySelector('.lb-name');
    if (nameEl) nameEl.onclick = () => openPersonModal(r);
  });
  // Results live for 10 seconds, then vanish and the search bar
  // empties itself. Typing again restarts the clock (the input
  // listener clears this timer).
  if (friendSearchClearTimer) clearTimeout(friendSearchClearTimer);
  friendSearchClearTimer = setTimeout(() => { $('friendSearch').value = ''; el.innerHTML = ''; }, 10000);
}
let friendSearchTimer = null, friendSearchClearTimer = null;
$('friendSearch').addEventListener('input', () => {
  clearTimeout(friendSearchTimer);
  clearTimeout(friendSearchClearTimer);
  friendSearchTimer = setTimeout(runFriendSearch, 250);
});

// A rejected session anywhere means the token is dead (the
// password was changed elsewhere, or the account signed out on
// another device). Send the user to sign-in instead of letting
// every list quietly go empty. Returns true when it redirected.
// The v61 fix only covered loadMe with no cached user — but
// loadMe short-circuits once `me` is set, so a session that
// dies after that kept degrading everything silently.
function deadSession(err) {
  if (err && err.message === 'Not signed in.') {
    token = ''; storeDel('duello_token'); me = null; profileData = null;
    wipeAccountScreens(); setAuthMode('signin'); show('authScreen');
    return true;
  }
  return false;
}
async function loadMe() {
  // Real /api/me, but cached: the scoreboard Elo comes from game.player
  // on each game response, so call sites must not pay a request per play.
  if (me) return true;
  try { const d = await api('/api/me'); me = d.user; return true; }
  catch (err) {
    if (deadSession(err)) return false;
    return !!token;
  }
}
$('playBotsBtn').onclick = () => show('botScreen');
$('playFriendsBtn').onclick = showFriendsTab;
// Matchmaking, not an instant game: Play Online (the globe) shows a
// searching screen that ticks for a random 2-3 seconds, then makes
// the match. Cancel, or any navigation away, abandons the search.
// Challenging a friend reuses the same screen: it says "Waiting for
// {name} to accept…" instead, ticks 5-7 seconds, and the friend
// accepts half the time — the same simulated accept/decline as a
// rematch request, because a persona has no real app for the
// request to pop up on. A real friend's phone would need the
// friends backend to deliver it; until then a real player just
// never answers, and the screen says so plainly instead of
// hanging on the wait.
let searchTimer = null, searchingActive = false;
let searchMode = 'random', challengePersona = null, liveChallengeId = null;
function cancelSearch() {
  searchingActive = false; challengePersona = null; searchMode = 'random';
  // Walking away withdraws a live real-player challenge, so it
  // never sits stale on the recipient's Friends page — and an
  // accepted challenge can never strand them in a game alone.
  // (show() calls this on any navigation away, and the Cancel
  // button calls it too; the accept/decline/timeout paths clear
  // liveChallengeId themselves first.)
  if (liveChallengeId) { const id = liveChallengeId; liveChallengeId = null; api(`/api/challenges/${id}/cancel`, { method: 'POST' }).catch(() => {}); }
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  $('searchingText').textContent = 'Searching for opponent…';
  $('searchCancelBtn').textContent = 'Cancel';
}
function startSearching() {
  cancelSearch();
  searchingActive = true;
  show('searchingScreen');
  searchTimer = setTimeout(() => {
    if (!searchingActive) return;
    searchingActive = false; searchTimer = null;
    startGame('persona');
  }, 2000 + Math.floor(Math.random() * 1000));
}
async function startChallenge(r) {
  cancelSearch();
  searchingActive = true; searchMode = 'challenge'; challengePersona = r;
  const first = r.name.split(' ')[0];
  $('searchingText').textContent = `Waiting for ${first} to accept…`;
  show('searchingScreen');
  if (!r.isPersona) {
    // A real challenge goes through the friends backend: the
    // recipient sees it at the top of their Friends page and
    // accepts or declines there. Wait up to 60 seconds, polling
    // the challenge every 2 seconds; Cancel (or the timeout)
    // withdraws it so it never sits stale on their page.
    let challengeId = null;
    try {
      const d = await api('/api/challenges', { method: 'POST', body: JSON.stringify({ username: r.username }) });
      challengeId = d.id;
    } catch (e) {
      if (!searchingActive) return;
      searchingActive = false; searchTimer = null;
      $('searchingText').textContent = (e && e.message) || `Couldn't reach ${first} right now.`;
      $('searchCancelBtn').textContent = 'Back to Friends';
      return;
    }
    // The user may have tapped Cancel while the send was in flight:
    // the challenge now exists on the server, so withdraw it at
    // once instead of leaving it on the recipient's page.
    if (!searchingActive) { try { await api(`/api/challenges/${challengeId}/cancel`, { method: 'POST' }); } catch {} return; }
    liveChallengeId = challengeId;
    let waited = 0;
    const pollChallenge = async () => {
      if (!searchingActive) return;
      try {
        const ch = await api(`/api/challenges/${challengeId}`);
        if (!searchingActive) return;
        if (ch.status === 'accepted' && ch.gameId) { searchingActive = false; searchTimer = null; liveChallengeId = null; joinChallengeGame(ch.gameId); return; }
        if (ch.status === 'declined') { searchingActive = false; searchTimer = null; liveChallengeId = null; $('searchingText').textContent = `${first} declined the challenge.`; $('searchCancelBtn').textContent = 'Back to Friends'; return; }
        if (ch.status !== 'pending') { searchingActive = false; searchTimer = null; liveChallengeId = null; $('searchingText').textContent = `That challenge ended.`; $('searchCancelBtn').textContent = 'Back to Friends'; return; }
      } catch {}
      waited += 2000;
      if (waited >= 60000) {
        searchingActive = false; searchTimer = null; liveChallengeId = null;
        try { await api(`/api/challenges/${challengeId}/cancel`, { method: 'POST' }); } catch {}
        $('searchingText').textContent = `${first} didn't answer — they may not be in the app right now.`;
        $('searchCancelBtn').textContent = 'Back to Friends';
        return;
      }
      if (searchingActive) searchTimer = setTimeout(pollChallenge, 2000);
    };
    searchTimer = setTimeout(pollChallenge, 2000);
    return;
  }
  searchTimer = setTimeout(() => {
    if (!searchingActive) return;
    searchingActive = false; searchTimer = null;
    if (Math.random() < 0.5) {
      startGame('persona', r.id);
    } else {
      $('searchingText').textContent = `${first} declined the challenge.`;
      $('searchCancelBtn').textContent = 'Back to Friends';
    }
  }, 5000 + Math.floor(Math.random() * 2000));
}
// Join a real-player game that already exists (an accepted
// challenge): load it and run the same countdown start as a
// fresh game. One retry on the load: the accept just created
// the row, so a single blip must not strand the player on the
// Friends page with the challenge already gone.
async function joinChallengeGame(gameId) {
  currentBot = 'human'; currentPersonaId = null; botTurnTapTime = Date.now();
  try {
    game = await api(`/api/games/${gameId}`);
  } catch (e) {
    try { await new Promise(r => setTimeout(r, 1000)); game = await api(`/api/games/${gameId}`); }
    catch (e2) {
      if (e2 && e2.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; setAuthMode('signin'); show('authScreen'); return; }
      return;
    }
  }
  enterGameScreen();
}
// The shared game start: clocks pinned during the countdown,
// rack hidden until the countdown ends. startGame (bot games)
// and joinChallengeGame (real games) both land here.
//
// Real-player games count down TOGETHER: the server stamps the
// shared end once both players have loaded the game (see the GET
// check-in in server.js), and each phone counts down to that one
// instant — the old code counted 5 seconds from each phone's own
// entry, so one player could be moving while the other still saw
// the countdown. While waiting for the shared time the overlay
// says so; if the other player never loads in, the countdown starts
// on its own after 15 seconds rather than hanging forever. A game
// that is already started (a late join) skips the countdown entirely.
let waitingForSync = false, syncFallbackTimer = null;
function enterGameScreen() {
  // A fetch from a previous game may still be in flight: invalidate
  // it, so its response cannot overwrite this game with old state.
  gameAppliedSeq = gameFetchSeq;
  // Display 4:00 during the countdown, not the server's create-round-trip
  // value (3:59): the clocks only start when the countdown ends (see /start).
  game.clocks.human = 240000; game.clocks.bot = 240000;
  gameFetchAt = Date.now(); pending = []; selectedRack = null; armed = {};
  clearStatDelay(); statShownGameId = null;
  // A rematch accepted from the stat window (or a challenge that
  // arrived while it was open) must start clean: the stat window is
  // a top-level overlay, not part of any screen, so show('gameScreen')
  // leaves it up — and the countdown overlay (z-index 15) then
  // counts down over the last game's stats (z-index 10). Hide it
  // here, the one shared entry for every game start, and lift the
  // board dim with it.
  $('statWindow').classList.add('hidden');
  $('gameDim').classList.remove('dimmed');
  // Set the countdown flag BEFORE the first render, so that render draws
  // the rack as empty slots (not full letters) from the very first frame.
  countdownActive = true;
  ensureLocalWords();
  show('gameScreen'); $('gameScreen').classList.add('counting'); renderGame(); openGameStream();
  if (game.botType === 'human' && game.started) {
    // Late join: the clocks are already running — no countdown.
    countdownActive = false;
    $('gameScreen').classList.remove('counting');
    $('countdownOverlay').classList.add('hidden');
    clockHoldUntil = Date.now() + 1000;
    renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
    return;
  }
  if (game.botType === 'human') {
    // Wait for the shared countdown. If this phone already has it
    // (the join reply carried it), the tick watcher starts it at
    // once; otherwise the overlay waits and the stream or the next
    // poll delivers it.
    waitingForSync = true;
    const opp = (game.opponent && game.opponent.firstName) || 'your opponent';
    const num = $('countdownNum');
    num.classList.add('waiting');
    num.textContent = `Waiting for ${opp}…`;
    $('countdownOverlay').classList.remove('hidden');
    if (syncFallbackTimer) clearTimeout(syncFallbackTimer);
    syncFallbackTimer = setTimeout(() => {
      syncFallbackTimer = null;
      if (!waitingForSync) return;
      waitingForSync = false;
      startCountdown(Date.now() + 5000);
    }, 15000);
    return;
  }
  startCountdown(Date.now() + 5000);
}
$('searchCancelBtn').onclick = () => {
  const wasChallenge = searchMode === 'challenge';
  cancelSearch();
  if (wasChallenge) { lbScope = 'friends'; $('lbFriendsTab').classList.add('active'); $('lbGlobalTab').classList.remove('active'); show('friendsScreen'); renderFriendsUI(); }
  else show('homeScreen');
};
$('playOnlineBtn').onclick = () => startSearching();
// Rematch requests, persona games only: Play Again sends the
// opponent a request instead of starting at once. The request
// screen waits a random 5-7 seconds, then the persona accepts
// (50%) and the rematch starts, or declines and the screen offers
// a way home or a new search. Bots keep instant Play Again.
let rematchTimer = null, rematchActive = false;
function cancelRematch() { rematchActive = false; if (rematchTimer) { clearTimeout(rematchTimer); rematchTimer = null; } }
function requestRematch() {
  const name = (game && game.persona && game.persona.firstName) || 'your opponent';
  cancelRematch();
  rematchActive = true;
  $('rematchText').textContent = `Request sent — waiting for ${name} to accept…`;
  $('rematchActions').classList.add('hidden');
  show('rematchScreen');
  rematchTimer = setTimeout(() => {
    if (!rematchActive) return;
    rematchActive = false; rematchTimer = null;
    if (Math.random() < 0.5) {
      startGame('persona', currentPersonaId);
    } else {
      $('rematchText').textContent = `${name} declined the rematch.`;
      $('rematchActions').classList.remove('hidden');
    }
  }, 5000 + Math.floor(Math.random() * 2000));
}
$('rematchHomeBtn').onclick = () => { cancelRematch(); show('homeScreen'); };
$('rematchNewBtn').onclick = () => { cancelRematch(); startSearching(); };
$('botBackBtn').onclick = () => show('homeScreen');
$('competitiveBtn').onclick = () => startGame('competitive');
$('fishstickBtn').onclick = () => startGame('fishstick');
let currentPersonaId = null;
async function startGame(bot, personaId) {
  currentBot = bot; currentPersonaId = personaId || null; botTurnTapTime = Date.now();
  try {
    game = await api('/api/games', { method: 'POST', body: JSON.stringify(personaId ? { bot, personaId } : { bot }) });
    // A random Play Online match learns its persona here, so Play
    // Again rematches the same person instead of drawing a new one.
    if (game.persona) currentPersonaId = game.persona.id;
  } catch (e) {
    // No guest fallback anymore: sign-in is required. A rejected session
    // sends the user to the auth screen; anything else is a transient
    // failure and another tap retries.
    if (e && e.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; setAuthMode('signin'); show('authScreen'); return; }
    return;
  }
  enterGameScreen();
}
async function endCountdown() {
  // Keep the clocks pinned until the new state actually arrives. The old
  // code cleared countdownActive BEFORE awaiting /start, so the 100ms
  // tick ran during that network round-trip with the stale creation-time
  // gameFetchAt (5s countdown + ~1s create = ~6s elapsed) and showed
  // 4:54 for a brief second, then corrected to 5:00 when /start returned.
  // Now the overlay hides but countdownActive (and the hidden rack)
  // stay until /start returns and gameFetchAt is reset to that moment.
  $('countdownOverlay').classList.add('hidden');
  try {
    try { game = await api(`/api/games/${game.id}/start`, { method: 'POST' }); }
    catch { game = await api(`/api/games/${game.id}`); }
    countdownActive = false;
    $('gameScreen').classList.remove('counting');
    clockHoldUntil = Date.now() + 1000;
    gameFetchAt = Date.now(); pending = []; selectedRack = null; renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
  } catch { countdownActive = false; $('gameScreen').classList.remove('counting'); clockHoldUntil = Date.now() + 1000; botTurnTapTime = 0; beginBotTurn(); }
}
function startCountdown(targetMs) {
  if (countdownInterval) clearInterval(countdownInterval);
  if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; }
  waitingForSync = false;
  countdownActive = true;
  $('gameScreen').classList.add('counting');
  // Re-render so the rack is blank slots (and controls disabled) during
  // the wait, even if an earlier render drew letters before the flag set.
  cleanupStuckDrag(); renderGame();
  const ov = $('countdownOverlay'); ov.classList.remove('hidden');
  const num = $('countdownNum');
  num.classList.remove('waiting');
  // One countdown loop driven by an absolute local target, so a shared
  // server end and a local 5-second countdown run the same way. The
  // 200ms tick keeps the displayed number aligned to the target
  // instead of drifting a second per render.
  let shown = null;
  const tick = () => {
    const n = Math.ceil((targetMs - Date.now()) / 1000);
    if (n <= 0) { clearInterval(countdownInterval); countdownInterval = null; endCountdown(); return; }
    if (n !== shown) { shown = n; num.textContent = String(n); }
  };
  num.textContent = String(Math.max(1, Math.ceil((targetMs - Date.now()) / 1000)));
  shown = Number(num.textContent);
  countdownInterval = setInterval(tick, 200);
}
function boardCell(r, c) { return game.board[r][c]; }
// One SVG tile template for every letter: face, letter, and value are drawn
// in a single 100x100 viewBox, so the proportions are locked no matter what
// size the tile is rendered at (board, rack, or drag ghost). Letters and
// values are baked-in vector paths, not font-rendered text, so bold
// thickness can no longer vary by device: letters come from Comfortaa Bold
// at the same size/position as before (58px, centered at x=46, baseline 76),
// values from Liberation Sans Bold (metric-compatible Arial substitute) at
// the same size/position (28px, anchored end at x=90, baseline 28), with the
// value stroke thinned to 1 at Jeff's approval (Nov 3, 2026; letters stay
// stroke 3). Letters come from game state, never from the DOM, so drawing
// them as paths changes nothing about validation or drag.
const TILE_LETTER_PATHS = {"A":"M29.61 76Q27.99 76 27.12 74.61Q26.25 73.22 26.95 71.65L43.25 32.73Q44.12 30.7 46.09 30.7Q48.17 30.7 48.93 32.73L65.28 71.77Q65.92 73.39 65.08 74.69Q64.24 76 62.56 76Q61.69 76 60.91 75.51Q60.12 75.01 59.77 74.14L45.39 38.42H47.02L32.4 74.14Q31.99 75.07 31.21 75.54Q30.43 76 29.61 76ZM32.69 66.02 35.01 61.04H57.75L60.07 66.02Z","B":"M33.85 76Q32.57 76 31.7 75.13Q30.83 74.26 30.83 72.98V33.72Q30.83 32.38 31.7 31.54Q32.57 30.7 33.85 30.7H47.71Q51.66 30.7 54.64 32.24Q57.63 33.78 59.34 36.5Q61.05 39.23 61.05 42.77Q61.05 45.61 59.51 47.9Q57.98 50.19 55.31 51.52Q59.14 52.45 61.46 55.18Q63.78 57.9 63.78 62.31Q63.78 66.31 61.89 69.39Q60.01 72.46 56.64 74.23Q53.28 76 48.93 76ZM36.86 70.43H48.93Q51.6 70.43 53.63 69.5Q55.66 68.58 56.82 66.78Q57.98 64.98 57.98 62.31Q57.98 59.82 56.82 58.19Q55.66 56.57 53.63 55.73Q51.6 54.89 48.93 54.89H36.86ZM36.86 49.32H47.71Q51.02 49.32 53.13 47.7Q55.25 46.07 55.25 42.77Q55.25 39.46 53.13 37.86Q51.02 36.27 47.71 36.27H36.86Z","C":"M49.57 76.58Q44.87 76.58 40.78 74.81Q36.69 73.04 33.65 69.88Q30.6 66.72 28.89 62.49Q27.18 58.25 27.18 53.32Q27.18 48.45 28.89 44.25Q30.6 40.04 33.65 36.88Q36.69 33.72 40.75 31.92Q44.81 30.12 49.57 30.12Q54.03 30.12 57.25 31.28Q60.47 32.44 63.72 35.11Q64.18 35.46 64.44 35.83Q64.7 36.21 64.79 36.59Q64.88 36.97 64.88 37.49Q64.88 38.59 64.1 39.31Q63.31 40.04 62.21 40.13Q61.11 40.21 60.06 39.4Q57.92 37.55 55.63 36.56Q53.34 35.57 49.57 35.57Q46.14 35.57 43.13 36.97Q40.11 38.36 37.82 40.79Q35.53 43.23 34.25 46.45Q32.98 49.67 32.98 53.32Q32.98 57.03 34.25 60.25Q35.53 63.47 37.82 65.91Q40.11 68.34 43.13 69.71Q46.14 71.07 49.57 71.07Q52.52 71.07 55.16 70.06Q57.8 69.04 60.24 67.24Q61.28 66.49 62.3 66.58Q63.31 66.66 64.01 67.39Q64.7 68.11 64.7 69.39Q64.7 69.97 64.47 70.52Q64.24 71.07 63.78 71.53Q60.65 74.03 57.08 75.3Q53.51 76.58 49.57 76.58Z","D":"M32.11 76Q30.83 76 29.96 75.13Q29.09 74.26 29.09 72.98V33.72Q29.09 32.38 29.96 31.54Q30.83 30.7 32.11 30.7H42.61Q47.59 30.7 51.68 32.35Q55.77 34.01 58.79 37.05Q61.8 40.1 63.43 44.22Q65.05 48.33 65.05 53.32Q65.05 58.31 63.43 62.46Q61.8 66.6 58.79 69.65Q55.77 72.69 51.68 74.35Q47.59 76 42.61 76ZM35.12 70.66H42.61Q47.48 70.66 51.22 68.43Q54.96 66.2 57.11 62.28Q59.25 58.37 59.25 53.32Q59.25 48.22 57.11 44.33Q54.96 40.45 51.22 38.24Q47.48 36.04 42.61 36.04H35.12Z","E":"M34.52 76Q33.24 76 32.37 75.13Q31.5 74.26 31.5 72.98V33.72Q31.5 32.38 32.37 31.54Q33.24 30.7 34.52 30.7H60.73Q62.07 30.7 62.88 31.48Q63.69 32.27 63.69 33.54Q63.69 34.76 62.88 35.52Q62.07 36.27 60.73 36.27H37.53V50.36H54.18Q55.51 50.36 56.32 51.15Q57.14 51.93 57.14 53.15Q57.14 54.37 56.32 55.15Q55.51 55.93 54.18 55.93H37.53V70.43H60.73Q62.07 70.43 62.88 71.19Q63.69 71.94 63.69 73.16Q63.69 74.43 62.88 75.22Q62.07 76 60.73 76Z","F":"M33.04 76Q31.76 76 30.89 75.13Q30.02 74.26 30.02 72.98V33.72Q30.02 32.38 30.89 31.54Q31.76 30.7 33.04 30.7H59.25Q60.59 30.7 61.4 31.48Q62.21 32.27 62.21 33.54Q62.21 34.76 61.4 35.52Q60.59 36.27 59.25 36.27H36.05V50.36H52.7Q54.03 50.36 54.84 51.15Q55.66 51.93 55.66 53.15Q55.66 54.37 54.84 55.15Q54.03 55.93 52.7 55.93H36.05V72.98Q36.05 74.26 35.18 75.13Q34.31 76 33.04 76Z","G":"M49.57 76.58Q44.87 76.58 40.78 74.81Q36.69 73.04 33.65 69.88Q30.6 66.72 28.89 62.49Q27.18 58.25 27.18 53.32Q27.18 48.45 28.89 44.25Q30.6 40.04 33.65 36.88Q36.69 33.72 40.75 31.92Q44.81 30.12 49.57 30.12Q54.03 30.12 57.25 31.28Q60.47 32.44 63.72 35.11Q64.18 35.46 64.44 35.83Q64.7 36.21 64.79 36.59Q64.88 36.97 64.88 37.49Q64.88 38.59 64.1 39.34Q63.31 40.1 62.18 40.16Q61.05 40.21 60.06 39.4Q57.92 37.55 55.63 36.56Q53.34 35.57 49.57 35.57Q46.14 35.57 43.13 36.97Q40.11 38.36 37.82 40.79Q35.53 43.23 34.25 46.45Q32.98 49.67 32.98 53.32Q32.98 57.03 34.25 60.25Q35.53 63.47 37.82 65.91Q40.11 68.34 43.13 69.71Q46.14 71.07 49.57 71.07Q52.52 71.07 55.16 70.06Q57.8 69.04 60.24 67.24Q61.28 66.49 62.3 66.58Q63.31 66.66 64.01 67.39Q64.7 68.11 64.7 69.39Q64.7 69.97 64.5 70.52Q64.3 71.07 63.78 71.53Q60.7 74.09 57.11 75.33Q53.51 76.58 49.57 76.58ZM64.7 69.39 58.91 68.23V57.85H50.9Q49.62 57.85 48.76 57.09Q47.89 56.34 47.89 55.18Q47.89 54.02 48.76 53.26Q49.62 52.51 50.9 52.51H61.75Q63.08 52.51 63.89 53.35Q64.7 54.19 64.7 55.53Z","H":"M29.56 76Q28.28 76 27.41 75.13Q26.54 74.26 26.54 72.98V33.72Q26.54 32.38 27.41 31.54Q28.28 30.7 29.56 30.7Q30.89 30.7 31.73 31.54Q32.57 32.38 32.57 33.72V50.36H59.48V33.72Q59.48 32.38 60.36 31.54Q61.23 30.7 62.5 30.7Q63.84 30.7 64.65 31.54Q65.46 32.38 65.46 33.72V72.98Q65.46 74.26 64.65 75.13Q63.84 76 62.5 76Q61.23 76 60.36 75.13Q59.48 74.26 59.48 72.98V55.7H32.57V72.98Q32.57 74.26 31.73 75.13Q30.89 76 29.56 76Z","I":"M46 76Q44.72 76 43.85 75.13Q42.98 74.26 42.98 72.98V33.72Q42.98 32.38 43.85 31.54Q44.72 30.7 46 30.7Q47.33 30.7 48.17 31.54Q49.02 32.38 49.02 33.72V72.98Q49.02 74.26 48.17 75.13Q47.33 76 46 76Z","J":"M44.38 76.58Q40.32 76.58 37.16 74.81Q33.99 73.04 32.23 69.88Q30.46 66.72 30.46 62.66Q30.46 61.33 31.33 60.48Q32.2 59.64 33.47 59.64Q34.81 59.64 35.65 60.48Q36.49 61.33 36.49 62.66Q36.49 65.15 37.5 67.07Q38.52 68.98 40.29 70.06Q42.06 71.13 44.38 71.13Q46.7 71.13 48.49 70.06Q50.29 68.98 51.31 67.07Q52.32 65.15 52.32 62.66V33.72Q52.32 32.38 53.16 31.54Q54 30.7 55.28 30.7Q56.61 30.7 57.48 31.54Q58.35 32.38 58.35 33.72V62.66Q58.35 66.72 56.56 69.88Q54.76 73.04 51.63 74.81Q48.49 76.58 44.38 76.58Z","K":"M35.47 76Q34.26 76 33.36 75.13Q32.46 74.26 32.46 72.98V33.72Q32.46 32.44 33.36 31.57Q34.26 30.7 35.47 30.7Q36.75 30.7 37.62 31.57Q38.49 32.44 38.49 33.72V51.12L57.69 31.92Q58.38 31.22 58.96 30.96Q59.54 30.7 60.18 30.7Q61.63 30.7 62.27 31.57Q62.91 32.44 62.73 33.63Q62.56 34.82 61.63 35.81L46.84 50.65L61.92 71.19Q62.62 72.17 62.5 73.3Q62.39 74.43 61.69 75.22Q60.99 76 59.83 76Q58.21 76 57.34 74.72L42.66 54.83L38.49 59.01V72.98Q38.49 74.26 37.62 75.13Q36.75 76 35.47 76Z","L":"M36.14 76Q34.86 76 34.02 75.13Q33.18 74.26 33.18 72.98V33.72Q33.18 32.44 34.05 31.57Q34.92 30.7 36.14 30.7Q37.42 30.7 38.29 31.57Q39.16 32.44 39.16 33.72V69.97H60.15Q61.43 69.97 62.3 70.84Q63.17 71.71 63.17 72.98Q63.17 74.26 62.3 75.13Q61.43 76 60.15 76Z","M":"M26.34 76Q25.06 76 24.19 75.13Q23.32 74.26 23.32 72.98V33.72Q23.32 32.38 24.19 31.54Q25.06 30.7 26.34 30.7Q28.08 30.7 29.01 32.33L47.16 68.69H45.3L62.99 32.33Q63.92 30.7 65.66 30.7Q66.94 30.7 67.81 31.54Q68.68 32.38 68.68 33.72V72.98Q68.68 74.26 67.78 75.13Q66.88 76 65.66 76Q64.39 76 63.52 75.13Q62.65 74.26 62.65 72.98V42.07L63.81 41.78L48.61 72.75Q47.62 74.26 46 74.26Q44.09 74.26 43.22 72.46L28.19 42.36L29.35 42.07V72.98Q29.35 74.26 28.48 75.13Q27.61 76 26.34 76Z","N":"M30.69 76Q29.41 76 28.57 75.13Q27.73 74.26 27.73 72.98V33.72Q27.73 32.38 28.57 31.54Q29.41 30.7 30.69 30.7Q32.08 30.7 33.01 31.8L58.3 65.44V33.72Q58.3 32.38 59.17 31.54Q60.04 30.7 61.31 30.7Q62.65 30.7 63.46 31.54Q64.27 32.38 64.27 33.72V72.98Q64.27 74.26 63.46 75.13Q62.65 76 61.31 76Q60.73 76 60.06 75.74Q59.4 75.48 58.99 74.96L33.7 41.32V72.98Q33.7 74.26 32.86 75.13Q32.02 76 30.69 76Z","O":"M46.03 76.58Q40.92 76.58 36.69 74.87Q32.46 73.16 29.41 70.06Q26.37 66.95 24.69 62.69Q23 58.43 23 53.32Q23 48.22 24.69 43.98Q26.37 39.75 29.41 36.65Q32.46 33.54 36.69 31.83Q40.92 30.12 46.03 30.12Q51.13 30.12 55.34 31.83Q59.54 33.54 62.62 36.65Q65.69 39.75 67.37 43.98Q69.06 48.22 69.06 53.32Q69.06 58.43 67.37 62.69Q65.69 66.95 62.62 70.06Q59.54 73.16 55.34 74.87Q51.13 76.58 46.03 76.58ZM46.03 71.13Q49.8 71.13 52.96 69.77Q56.12 68.4 58.44 66Q60.76 63.59 62.01 60.34Q63.26 57.09 63.26 53.32Q63.26 49.55 62.01 46.3Q60.76 43.06 58.44 40.65Q56.12 38.24 52.96 36.91Q49.8 35.57 46.03 35.57Q42.26 35.57 39.1 36.91Q35.94 38.24 33.65 40.65Q31.36 43.06 30.08 46.3Q28.8 49.55 28.8 53.32Q28.8 57.09 30.08 60.34Q31.36 63.59 33.65 66Q35.94 68.4 39.1 69.77Q42.26 71.13 46.03 71.13Z","P":"M36.75 76Q35.47 76 34.6 75.13Q33.73 74.26 33.73 72.98V33.72Q33.73 32.38 34.6 31.54Q35.47 30.7 36.75 30.7H48.35Q52.7 30.7 56.06 32.62Q59.43 34.53 61.31 37.92Q63.2 41.32 63.2 45.72Q63.2 49.96 61.31 53.26Q59.43 56.57 56.06 58.43Q52.7 60.28 48.35 60.28H39.77V72.98Q39.77 74.26 38.92 75.13Q38.08 76 36.75 76ZM39.77 54.71H48.35Q51.02 54.71 53.05 53.55Q55.08 52.39 56.24 50.36Q57.4 48.33 57.4 45.72Q57.4 42.94 56.24 40.82Q55.08 38.71 53.05 37.49Q51.02 36.27 48.35 36.27H39.77Z","Q":"M61.86 75.07 49.74 62.95Q48.81 62.02 48.81 60.89Q48.81 59.76 49.74 58.83Q50.67 57.9 51.8 57.9Q52.93 57.9 53.86 58.83L65.98 71.01Q66.85 71.94 66.88 73.04Q66.91 74.14 65.98 75.07Q65.05 76 63.92 76Q62.79 76 61.86 75.07ZM46.03 76.58Q40.92 76.58 36.69 74.87Q32.46 73.16 29.41 70.06Q26.37 66.95 24.69 62.69Q23 58.43 23 53.32Q23 48.22 24.69 43.98Q26.37 39.75 29.41 36.65Q32.46 33.54 36.69 31.83Q40.92 30.12 46.03 30.12Q51.13 30.12 55.34 31.83Q59.54 33.54 62.62 36.65Q65.69 39.75 67.37 43.98Q69.06 48.22 69.06 53.32Q69.06 58.43 67.37 62.69Q65.69 66.95 62.62 70.06Q59.54 73.16 55.34 74.87Q51.13 76.58 46.03 76.58ZM46.03 71.13Q49.8 71.13 52.96 69.77Q56.12 68.4 58.44 66Q60.76 63.59 62.01 60.34Q63.26 57.09 63.26 53.32Q63.26 49.55 62.01 46.3Q60.76 43.06 58.44 40.65Q56.12 38.24 52.96 36.91Q49.8 35.57 46.03 35.57Q42.26 35.57 39.1 36.91Q35.94 38.24 33.65 40.65Q31.36 43.06 30.08 46.3Q28.8 49.55 28.8 53.32Q28.8 57.09 30.08 60.34Q31.36 63.59 33.65 66Q35.94 68.4 39.1 69.77Q42.26 71.13 46.03 71.13Z","R":"M36.49 76Q35.21 76 34.34 75.13Q33.47 74.26 33.47 72.98V33.72Q33.47 32.38 34.34 31.54Q35.21 30.7 36.49 30.7H46.93Q51.28 30.7 54.64 32.53Q58.01 34.36 59.89 37.55Q61.78 40.74 61.78 44.97Q61.78 48.91 59.89 51.99Q58.01 55.06 54.64 56.8Q51.28 58.54 46.93 58.54H39.5V72.98Q39.5 74.26 38.66 75.13Q37.82 76 36.49 76ZM60.56 76Q59.75 76 59.08 75.65Q58.41 75.3 57.95 74.55L47.51 57.73L53.37 56.05L62.88 71.36Q63.92 73.04 63.17 74.52Q62.41 76 60.56 76ZM39.5 52.97H46.93Q49.6 52.97 51.63 51.96Q53.66 50.94 54.82 49.12Q55.98 47.29 55.98 44.97Q55.98 42.42 54.82 40.45Q53.66 38.47 51.63 37.37Q49.6 36.27 46.93 36.27H39.5Z","S":"M46.23 76.58Q42.52 76.58 39.16 75.42Q35.79 74.26 33.3 72.17Q30.8 70.08 29.64 67.36Q29.06 66.14 29.67 65.1Q30.28 64.05 31.73 63.76Q32.78 63.53 33.79 64.08Q34.81 64.63 35.33 65.73Q36.02 67.18 37.62 68.4Q39.21 69.62 41.48 70.37Q43.74 71.13 46.23 71.13Q49.02 71.13 51.36 70.26Q53.71 69.39 55.16 67.73Q56.61 66.08 56.61 63.65Q56.61 60.57 54.21 58.14Q51.8 55.7 46.29 55.12Q39.1 54.42 34.98 50.89Q30.86 47.35 30.86 42.13Q30.86 38.3 33.01 35.63Q35.15 32.96 38.84 31.57Q42.52 30.18 47.04 30.18Q50.58 30.18 53.22 31.17Q55.86 32.15 57.83 33.89Q59.8 35.63 61.25 38.01Q62.07 39.29 61.92 40.42Q61.78 41.55 60.79 42.19Q59.69 42.88 58.41 42.48Q57.14 42.07 56.5 40.97Q55.57 39.29 54.24 38.13Q52.9 36.97 51.1 36.3Q49.31 35.63 46.87 35.63Q42.58 35.57 39.68 37.23Q36.78 38.88 36.78 42.3Q36.78 44.04 37.68 45.64Q38.58 47.23 40.98 48.39Q43.39 49.55 47.91 50.02Q54.82 50.71 58.67 54.22Q62.53 57.73 62.53 63.47Q62.53 66.78 61.17 69.21Q59.8 71.65 57.51 73.3Q55.22 74.96 52.29 75.77Q49.36 76.58 46.23 76.58Z","T":"M46.03 76Q44.75 76 43.88 75.13Q43.01 74.26 43.01 72.98V30.7H49.05V72.98Q49.05 74.26 48.17 75.13Q47.3 76 46.03 76ZM30.48 36.27Q29.27 36.27 28.48 35.49Q27.7 34.7 27.7 33.49Q27.7 32.27 28.48 31.48Q29.27 30.7 30.48 30.7H61.52Q62.73 30.7 63.52 31.48Q64.3 32.27 64.3 33.49Q64.3 34.7 63.52 35.49Q62.73 36.27 61.52 36.27Z","U":"M46.26 76.93Q40.69 76.93 36.4 74.87Q32.11 72.81 29.7 69.16Q27.29 65.5 27.29 60.8V33.72Q27.29 32.38 28.16 31.54Q29.03 30.7 30.31 30.7Q31.64 30.7 32.49 31.54Q33.33 32.38 33.33 33.72V60.8Q33.33 63.94 34.98 66.34Q36.63 68.75 39.56 70.11Q42.49 71.48 46.26 71.48Q49.91 71.48 52.73 70.11Q55.54 68.75 57.14 66.34Q58.73 63.94 58.73 60.8V33.72Q58.73 32.38 59.6 31.54Q60.47 30.7 61.75 30.7Q63.08 30.7 63.89 31.54Q64.7 32.38 64.7 33.72V60.8Q64.7 65.5 62.36 69.16Q60.01 72.81 55.83 74.87Q51.66 76.93 46.26 76.93Z","V":"M45.97 76Q44.11 76 43.25 74.09L26.25 35.23Q25.44 33.25 26.08 31.98Q26.71 30.7 28.51 30.7Q30.54 30.7 31.3 32.5L46.2 68.29H45.56L60.76 32.5Q61.22 31.46 61.83 31.08Q62.44 30.7 63.49 30.7Q65.23 30.7 65.89 31.95Q66.56 33.2 65.86 34.7L48.7 74.09Q48.29 75.01 47.62 75.51Q46.96 76 45.97 76Z","W":"M34.23 76Q33.18 76 32.37 75.36Q31.56 74.72 31.21 73.62L19.55 34.88Q18.97 32.96 19.64 31.83Q20.31 30.7 21.81 30.7Q22.8 30.7 23.61 31.25Q24.42 31.8 24.77 32.96L34.92 68.34H33.65L43.04 33.31Q43.27 32.44 44.09 31.86Q44.9 31.28 45.94 31.28Q46.87 31.28 47.71 31.77Q48.55 32.27 48.78 33.25L58.24 68.34H57.08L67.29 32.67Q67.87 30.7 70.24 30.7Q71.87 30.7 72.33 31.95Q72.8 33.2 72.33 34.88L60.67 73.56Q60.27 74.67 59.48 75.33Q58.7 76 57.66 76Q56.56 76 55.77 75.3Q54.99 74.61 54.64 73.62L45.3 37.55H46.7L37.24 73.56Q36.84 74.67 36.05 75.33Q35.27 76 34.23 76Z","X":"M30.86 76Q29.53 76 28.83 75.16Q28.14 74.32 28.14 73.19Q28.14 72.06 28.83 71.13L43.45 51.64L46.06 49.32L59.4 31.57Q60.21 30.7 61.54 30.7Q62.76 30.7 63.46 31.46Q64.15 32.21 64.21 33.31Q64.27 34.41 63.57 35.46L49.48 54.25L46.99 56.45L32.95 75.13Q32.08 76 30.86 76ZM61.2 76Q60.44 76 59.89 75.74Q59.34 75.48 58.88 74.9L45.36 56.16L43.22 54.37L29.59 35.46Q28.89 34.53 29.01 33.43Q29.12 32.33 29.85 31.51Q30.57 30.7 31.79 30.7Q33.3 30.7 33.94 31.57L46.81 49.44L49.02 51.23L63.34 71.13Q64.04 72.06 63.98 73.22Q63.92 74.38 63.2 75.19Q62.47 76 61.2 76Z","Y":"M45.94 76Q44.72 76 43.85 75.13Q42.98 74.26 42.98 72.98V59.47L27.5 35.4Q26.74 34.18 26.92 33.11Q27.09 32.04 27.93 31.37Q28.77 30.7 29.88 30.7Q30.86 30.7 31.44 31.14Q32.02 31.57 32.54 32.38L47.28 55.76H44.96L59.92 32.15Q60.38 31.46 61.02 31.08Q61.66 30.7 62.59 30.7Q63.63 30.7 64.33 31.43Q65.02 32.15 65.14 33.22Q65.26 34.3 64.56 35.4L48.96 59.47V72.98Q48.96 74.26 48.09 75.13Q47.22 76 45.94 76Z","Z":"M30.63 76Q29.3 76 28.51 75.13Q27.73 74.26 27.64 73.13Q27.56 72 28.25 71.13L56.61 36.04H31.21Q29.76 36.04 29.03 35.31Q28.31 34.59 28.37 33.49Q28.31 32.27 29.18 31.48Q30.05 30.7 31.33 30.7H61.25Q62.59 30.7 63.4 31.51Q64.21 32.33 64.33 33.46Q64.44 34.59 63.69 35.46L35.21 70.66H61.25Q62.59 70.66 63.4 71.45Q64.21 72.23 64.21 73.27Q64.21 74.55 63.4 75.28Q62.59 76 61.25 76Z"};
const TILE_VALUE_PATHS = {"1":"M76.19 28V25.14H80.96V12L76.34 14.89V11.87L81.17 8.74H84.8V25.14H89.22V28Z","2":"M75.4 28V25.33Q76.15 23.68 77.54 22.11Q78.93 20.54 81.03 18.83Q83.05 17.19 83.87 16.12Q84.68 15.05 84.68 14.03Q84.68 11.51 82.15 11.51Q80.92 11.51 80.27 12.17Q79.62 12.84 79.43 14.16L75.56 13.95Q75.89 11.27 77.57 9.86Q79.24 8.45 82.12 8.45Q85.24 8.45 86.91 9.87Q88.58 11.29 88.58 13.86Q88.58 15.22 88.04 16.31Q87.51 17.4 86.68 18.33Q85.84 19.25 84.83 20.06Q83.81 20.86 82.85 21.63Q81.89 22.39 81.11 23.17Q80.32 23.95 79.94 24.84H88.88V28Z","3":"M88.99 22.65Q88.99 25.36 87.21 26.84Q85.43 28.31 82.15 28.31Q79.05 28.31 77.22 26.89Q75.38 25.46 75.07 22.76L78.98 22.42Q79.35 25.2 82.14 25.2Q83.52 25.2 84.29 24.51Q85.05 23.83 85.05 22.42Q85.05 21.14 84.12 20.45Q83.19 19.77 81.36 19.77H80.02V16.67H81.28Q82.93 16.67 83.77 15.99Q84.6 15.31 84.6 14.05Q84.6 12.87 83.94 12.19Q83.27 11.51 82 11.51Q80.81 11.51 80.08 12.17Q79.35 12.82 79.24 14.03L75.4 13.75Q75.7 11.27 77.46 9.86Q79.23 8.45 82.07 8.45Q85.09 8.45 86.79 9.81Q88.5 11.17 88.5 13.58Q88.5 15.38 87.44 16.54Q86.38 17.71 84.38 18.09V18.14Q86.6 18.4 87.79 19.6Q88.99 20.79 88.99 22.65Z","4":"M87.28 24.08V28H83.62V24.08H74.85V21.19L82.99 8.74H87.28V21.22H89.85V24.08ZM83.62 14.92Q83.62 14.18 83.66 13.32Q83.71 12.46 83.74 12.21Q83.38 12.97 82.45 14.42L77.98 21.22H83.62Z","5":"M89.22 21.59Q89.22 24.65 87.31 26.46Q85.41 28.27 82.08 28.27Q79.19 28.27 77.44 26.97Q75.7 25.66 75.29 23.19L79.13 22.87Q79.43 24.1 80.2 24.66Q80.96 25.22 82.12 25.22Q83.56 25.22 84.42 24.31Q85.27 23.39 85.27 21.67Q85.27 20.15 84.46 19.24Q83.66 18.33 82.21 18.33Q80.61 18.33 79.6 19.58H75.85L76.52 8.74H88.1V11.59H80.01L79.69 16.46Q81.09 15.23 83.18 15.23Q85.93 15.23 87.57 16.94Q89.22 18.65 89.22 21.59Z","6":"M88.99 21.7Q88.99 24.77 87.27 26.52Q85.54 28.27 82.51 28.27Q79.1 28.27 77.28 25.89Q75.45 23.5 75.45 18.81Q75.45 13.66 77.31 11.05Q79.16 8.45 82.6 8.45Q85.05 8.45 86.47 9.53Q87.88 10.61 88.47 12.88L84.85 13.38Q84.33 11.48 82.52 11.48Q80.98 11.48 80.09 13.03Q79.21 14.57 79.21 17.72Q79.83 16.69 80.92 16.15Q82.02 15.6 83.4 15.6Q85.98 15.6 87.48 17.24Q88.99 18.88 88.99 21.7ZM85.13 21.81Q85.13 20.17 84.37 19.3Q83.62 18.43 82.29 18.43Q81.02 18.43 80.25 19.24Q79.49 20.06 79.49 21.4Q79.49 23.08 80.29 24.18Q81.09 25.28 82.38 25.28Q83.68 25.28 84.41 24.36Q85.13 23.43 85.13 21.81Z","8":"M89.14 22.57Q89.14 25.28 87.35 26.78Q85.56 28.27 82.23 28.27Q78.94 28.27 77.13 26.78Q75.32 25.29 75.32 22.6Q75.32 20.75 76.38 19.49Q77.45 18.22 79.24 17.92V17.87Q77.68 17.53 76.72 16.32Q75.77 15.12 75.77 13.55Q75.77 11.18 77.44 9.82Q79.12 8.45 82.18 8.45Q85.31 8.45 86.99 9.78Q88.66 11.12 88.66 13.58Q88.66 15.15 87.71 16.34Q86.76 17.53 85.16 17.84V17.9Q87.02 18.2 88.08 19.42Q89.14 20.64 89.14 22.57ZM84.71 13.78Q84.71 12.41 84.08 11.78Q83.45 11.14 82.18 11.14Q79.69 11.14 79.69 13.78Q79.69 16.54 82.21 16.54Q83.46 16.54 84.09 15.9Q84.71 15.26 84.71 13.78ZM85.16 22.26Q85.16 19.24 82.15 19.24Q80.76 19.24 80.01 20.03Q79.27 20.82 79.27 22.31Q79.27 24.01 80.01 24.79Q80.74 25.57 82.26 25.57Q83.75 25.57 84.46 24.79Q85.16 24.01 85.16 22.26Z","9":"M88.96 18.06Q88.96 23.19 87.09 25.73Q85.21 28.27 81.77 28.27Q79.23 28.27 77.78 27.19Q76.34 26.1 75.74 23.75L79.35 23.24Q79.88 25.25 81.81 25.25Q83.42 25.25 84.29 23.71Q85.16 22.16 85.19 19.13Q84.67 20.15 83.49 20.73Q82.3 21.31 80.94 21.31Q78.39 21.31 76.9 19.58Q75.4 17.86 75.4 14.9Q75.4 11.87 77.16 10.16Q78.91 8.45 82.12 8.45Q85.58 8.45 87.27 10.85Q88.96 13.25 88.96 18.06ZM84.9 15.37Q84.9 13.58 84.11 12.52Q83.33 11.46 82.03 11.46Q80.76 11.46 80.03 12.38Q79.29 13.3 79.29 14.93Q79.29 16.53 80.02 17.49Q80.74 18.46 82.04 18.46Q83.27 18.46 84.09 17.62Q84.9 16.78 84.9 15.37Z","10":"M60.62 28V25.14H65.39V12L60.77 14.89V11.87L65.6 8.74H69.23V25.14H73.65V28Z M88.85 18.36Q88.85 23.24 87.18 25.76Q85.5 28.27 82.15 28.27Q75.54 28.27 75.54 18.36Q75.54 14.9 76.26 12.71Q76.98 10.53 78.43 9.49Q79.88 8.45 82.26 8.45Q85.68 8.45 87.27 10.92Q88.85 13.4 88.85 18.36ZM85 18.36Q85 15.7 84.74 14.22Q84.48 12.74 83.9 12.1Q83.33 11.46 82.23 11.46Q81.07 11.46 80.48 12.11Q79.88 12.76 79.63 14.23Q79.38 15.7 79.38 18.36Q79.38 21 79.64 22.48Q79.91 23.97 80.49 24.61Q81.07 25.25 82.18 25.25Q83.27 25.25 83.87 24.58Q84.46 23.9 84.73 22.41Q85 20.92 85 18.36Z"};
function tileSVG(letter) {
  const val = ({ A: 1, B: 4, C: 4, D: 3, E: 1, F: 5, G: 3, H: 4, I: 1, J: 9, K: 6, L: 2, M: 4, N: 2, O: 1, P: 4, Q: 10, R: 1, S: 1, T: 1, U: 2, V: 6, W: 5, X: 8, Y: 5, Z: 9 })[letter];
  const gid = 'tg' + (tileSVG.n = (tileSVG.n || 0) + 1);
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7df3ff"/><stop offset="50%" stop-color="#03eaff"/><stop offset="100%" stop-color="#00b8d2"/></linearGradient></defs><rect x="0.5" y="0.5" width="99" height="99" rx="9" fill="url(#${gid})" stroke="rgba(0,90,110,0.4)"/><path d="${TILE_LETTER_PATHS[letter]}" fill="#1a1d24" stroke="#1a1d24" stroke-width="3" stroke-linejoin="round" paint-order="stroke"/><path d="${TILE_VALUE_PATHS[String(val)]}" fill="#1a1d24" stroke="#1a1d24" stroke-width="1" stroke-linejoin="round" paint-order="stroke"/></svg>`;
}
// Out of time = human clock at 0 (displayed, i.e. elapsed-adjusted on
// your turn), whatever the turn field currently says: after timeout the
// turn flips to the bot, but the human clock is still 0.
function humanOutOfTime() {
  if (!game || game.status !== 'active') return false;
  const humanRemaining = Math.max(0, game.clocks.turn === 'human' ? game.clocks.human - (Date.now() - gameFetchAt) : game.clocks.human);
  return humanRemaining <= 0;
}
// After your time expires the Forfeit button reads "Exit" instead:
// the opponent plays on, but you can leave without waiting. Never
// overwrites the armed "SURE?" confirm, and only writes when the
// label actually changes, so it is cheap to call every tick.
function updateForfeitLabel() {
  const btn = $('forfeitBtn');
  if (!btn || armed[btn.id]) return;
  const label = humanOutOfTime() ? 'Exit' : 'Forfeit';
  if (btn.textContent !== label) btn.textContent = label;
}
function renderGame() {
  if (!game) return;
  // Never rebuild the board/rack while a drag is live: re-creating the
  // captured tile mid-drag destroys it and can strand pointer capture,
  // which is how a drag froze the whole screen. The next render after the
  // drag ends will show any bot move that arrived in the meantime.
  if (activeDragCleanup) return;
  // Out of time: any tiles placed but not yet played go straight
  // back to the rack, instead of sitting on the board unplayable
  // while the opponent plays on. Placements are client-only until
  // Play, so this needs no server call. Skipped while a play is in
  // flight, since the server reply settles those tiles.
  if (game.status === 'active' && game.clocks.human <= 0 && !playInFlight && pending.length > 0) {
    pending = []; selectedRack = null;
  }
  $('playerName').textContent = me && me.firstName ? me.firstName : 'You';
  try { const pp = document.querySelector('.player-panel .pfp'); pp.innerHTML = pfpHTML(me); pp.classList.toggle('no-photo', !(me && me.photoData)); const sp = document.querySelector('.stat-pfp .pfp'); sp.innerHTML = pfpHTML(me); sp.classList.toggle('no-photo', !(me && me.photoData)); } catch {}
  $('playerElo').textContent = (game.player && game.player.elo != null) ? game.player.elo : (me ? me.elo : '');
  const isFish = game.botType === 'fishstick';
  const isPersonaGame = game.botType === 'persona';
  const isHumanGame = game.botType === 'human';
  $('botName').textContent = isFish ? 'Fishstick' : isPersonaGame ? (game.persona?.firstName || 'Player') : isHumanGame ? (game.opponent?.firstName || 'Player') : 'Bot';
  $('botElo').textContent = isFish ? '∞' : game.botElo;
  $('botElo').classList.toggle('inf', isFish);
  if (isFish) $('botPfp').innerHTML = '<img src="/assets/fishstick.png?v=1" alt="Fishstick">';
  else if (isPersonaGame && game.persona?.photoData) $('botPfp').innerHTML = `<img src="${game.persona.photoData}" alt="">`;
  else if (isHumanGame && game.opponent?.photoData) $('botPfp').innerHTML = `<img src="${game.opponent.photoData}" alt="">`;
  // A persona with no photo is a person without a photo, not a bot:
  // show the silhouette (with the blue no-photo ring, like the
  // player's own) instead of the robot, which is Competitive Bot.
  // Same for a real opponent without a photo.
  else if (isPersonaGame) $('botPfp').innerHTML = silhouetteSVG(32);
  else if (isHumanGame) $('botPfp').innerHTML = silhouetteSVG(32);
  else $('botPfp').textContent = '🤖';
  $('botPfp').classList.toggle('no-photo', (isPersonaGame && !game.persona?.photoData) || (isHumanGame && !game.opponent?.photoData));
  $('botPfp').classList.toggle('clear-bg', isFish);
  document.querySelector('.player-panel').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'human');
  document.querySelector('.bot-panel').classList.toggle('active', game.status === 'active' && game.clocks.turn === 'bot');
  $('scoreHuman').textContent = String(game.scores.human); $('scoreBot').textContent = String(game.scores.bot);
  const lastHtml = (l) => {
    if (!l) return '';
    if (l.passed) {
      if (l.noMoves) return '<span class="lp-words">No moves available, passed</span> <span class="pts">-30s</span>';
      return '<span class="lp-words">passed</span> <span class="pts">-30s</span>';
    }
    const words = (l.words && l.words.length) ? l.words : [l.word];
    return `<span class="lp-words">${words.join(', ')}</span> <span class="pts">+${l.points}${l.bingo ? ' <span class="bingo">bingo! +30</span>' : ''}${l.isDuello ? ' Duello +30' : ''}</span>`;
  };
  // The last move always shows, even in a one-sided stretch: when a
  // clock is at 0, that side can never have moved last, so the other
  // side's last move is the most recent one whatever the turn says.
  // (In a normal alternating game this is identical to the old
  // turn-based pick; it only changes the out-of-time stretches,
  // where the turn-based pick showed a stale move from the side
  // that can no longer move.)
  let shownLast;
  if (game.clocks.human <= 0) shownLast = game.lastBot || game.lastHuman;
  else if (game.clocks.bot <= 0) shownLast = game.lastHuman || game.lastBot;
  else shownLast = game.clocks.turn === 'human' ? (game.lastBot || game.lastHuman) : (game.lastHuman || game.lastBot);
  $('lastPlay').innerHTML = lastHtml(shownLast);
  $('lastPlay').classList.toggle('from-human', !!shownLast && shownLast === game.lastHuman);
  $('lastPlay').classList.toggle('from-bot', !!shownLast && shownLast === game.lastBot);
  // Inner 6x6 glow lives in a persistent overlay (see index.html), not on
  // the board cells: renderGame rebuilds every cell, and each rebuild
  // restarted the 3.2s pulse, so the glow visibly jumped at the end of
  // the 5s countdown. The overlay is never rebuilt, so its pulse runs
  // steadily before, during, and after the countdown; it is only shown
  // (opacity, never display) while the first word is still unplayed.
  if ($('innerGlow')) $('innerGlow').classList.toggle('on', !!game.isFirst);
  // Board
  const boardEl = $('board'); boardEl.innerHTML = '';
  const lastSet = new Set((game.lastCells || []).map(([r, c]) => r + ',' + c));
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
    const cell = document.createElement('div');
    const prem = game.premiums[`${r},${c}`];
    cell.className = 'cell' + (prem ? ' ' + prem : '') + (lastSet.has(r + ',' + c) ? ' last-word' : '');
    const pend = pending.find(p => p.row === r && p.col === c);
    const letter = boardCell(r, c) || (pend ? pend.letter : null);
    // A premium label must never share the cell with a tile: the cell is a
    // flex container, so the label + tile split the width and the tile (and
    // its letter) was squeezed to about half width on DL/DW/TL/TW squares.
    cell.textContent = letter ? '' : (prem || '');
    if (letter) {
      const t = document.createElement('div'); t.className = 'tile' + (pend ? ' pending' : '');
      t.innerHTML = tileSVG(letter);
      if (pend) enablePlacedDrag(t, pend);
      else t.addEventListener('pointerdown', () => {
        // If a definition is already open, this tap only dismisses it —
        // it does not open this word's definition. The document
        // pointerdown listener below hides the popover, and a second
        // tap on the word opens its definition.
        if (!$('defPopover').classList.contains('hidden')) return;
        defJustOpened = true;
        showDefinition(r, c);
      });
      cell.appendChild(t);
    } else {
      cell.onclick = () => { if (suppressNextClick) { suppressNextClick = false; return; } if (selectedRack !== null) placeTile(r, c); };
    }
    boardEl.appendChild(cell);
  }
  // Rack: during the countdown, show the rack as empty slots (no letters)
  // and the buttons, so the board/rack/buttons keep exactly the same
  // positions after the wait instead of jumping in when they appear.
  const rackEl = $('rack'); rackEl.innerHTML = '';
  rackEl.classList.toggle('greyed', game.clocks.turn !== 'human' && game.status === 'active');
  if (countdownActive) {
    for (let idx = 0; idx < 6; idx++) { const s = document.createElement('div'); s.className = 'tile empty'; rackEl.appendChild(s); }
  }
  game.humanRack.forEach((letter, idx) => {
    if (countdownActive) return;
    if (!letter) { const s = document.createElement('div'); s.className = 'tile empty'; rackEl.appendChild(s); return; }
    if (!optimisticPlay && pending.some(p => p.rackIndex === idx)) { const s = document.createElement('div'); s.className = 'tile empty'; rackEl.appendChild(s); return; }
    const t = document.createElement('div'); t.className = 'tile'; t.dataset.idx = idx;
    t.innerHTML = tileSVG(letter);
    if (selectedRack === idx) t.style.outline = '2px solid #ffd166';
    if (!optimisticPlay) enableRackDrag(t, idx);
    rackEl.appendChild(t);
  });
  // Controls / end state
  const finished = game.status === 'finished';
  // Recall only when a tile is actually placed; Pass only on your turn.
  // Both are greyed (disabled) otherwise, instead of tappable-but-dead.
  const yourTurn = game.status === 'active' && game.clocks.turn === 'human' && !playInFlight;
  const outOfTime = humanOutOfTime();
  $('recallBtn').disabled = countdownActive || !(yourTurn && pending.length > 0);
  // No passing in a one-sided stretch: when the opponent's clock is
  // at 0, the human plays on alone and cannot pass. Disabled also
  // drops the blue highlight (see .controls button:disabled), so the
  // button reads as truly unavailable, not just unresponsive.
  $('passBtn').disabled = countdownActive || !yourTurn || game.clocks.bot <= 0 || outOfTime;
  // Shuffle is available at all times during the game, including
  // while a Play is in flight and when out of time: the button used
  // to grey out for the whole Play round-trip, which felt like seconds.
  // The click handler below does a local-only shuffle while a Play is
  // in flight (the rack has blank slots then, so a server shuffle
  // would be rejected), and a server shuffle otherwise.
  $('shuffleBtn').disabled = false;
  $('forfeitBtn').disabled = countdownActive;
  updateForfeitLabel();
  document.querySelector('.controls').classList.toggle('hidden', finished);
  $('endButtons').classList.toggle('hidden', !finished);
  $('gameDim').classList.toggle('dimmed', finished && !$('statWindow').classList.contains('hidden'));
  // Every finish shows the stats window at once now, including
  // time expiry (Nov 5, 2026 — the old 3s final-board view is
  // gone). Tapping the backdrop still dismisses it to the board.
  if (finished && game.stats) showStatWindowDelayed(game.stats);
  tickClocks();
  if (countdownActive) { $('clockHuman').textContent = '4:00'; $('clockBot').textContent = '4:00'; }
  updateStatus();
  // The point bubble stays on the board for the last played word:
  // renderGame rebuilds every cell, so a bubble attached to one is
  // destroyed at the next render — re-attach it here, after
  // updateStatus has shown (or hidden) the pending play's bubble.
  // Only one bubble ever shows: if a pending bubble is up, the last
  // play's stays off. A pass leaves no bubble. A play still in flight
  // keeps its optimistic bubble on the just-played word instead of
  // leaving the board bare until the server reply lands.
  if (!document.querySelector('.play-bubble') && game.lastCells && game.lastCells.length) {
    if (pending.length && playInFlight && lastValidate && lastValidate.valid && lastValidate.mainCells && lastValidate.mainCells.length) {
      attachBubble(lastValidate.score, lastValidate.mainCells[lastValidate.mainCells.length - 1], 'last');
    } else if (!pending.length) {
      const lastMove = game.lastBy === 'human' ? game.lastHuman : game.lastBy === 'bot' ? game.lastBot : null;
      if (lastMove && !lastMove.passed) attachBubble(lastMove.points, game.lastCells[game.lastCells.length - 1], 'last');
    }
  }
}
let runoffUntil = 0, humanRunoffUntil = 0, timeoutFetching = false, timeoutLastAttempt = 0;
let countdownInterval = null, countdownActive = false;
let clockHoldUntil = 0;
function canPlaceTiles() { return !!game && game.status === 'active' && game.clocks.turn === 'human' && !playInFlight && !countdownActive; }
async function handleTimeoutFetch() {
  if (!game || game.status !== 'active' || timeoutFetching || playInFlight) return;
  timeoutFetching = true; timeoutLastAttempt = Date.now();
  try {
    const mySeq = ++gameFetchSeq;
    const next = await api(`/api/games/${game.id}`);
    // Same stale-snapshot rule as pollBotTurn: a fetch that was in
    // flight when a Play tap happened must not overwrite the
    // post-play state if it lands after the play reply. The tick
    // retries the timeout fetch once the flight is over. The sequence
    // check catches it when the play has already finished.
    if (playInFlight) return;
    if (mySeq <= gameAppliedSeq) return;
    game = next; gameAppliedSeq = mySeq; gameFetchAt = Date.now(); pending = []; selectedRack = null; renderGame();
    if (game.status === 'active' && game.clocks.turn === 'bot') { botTurnTapTime = 0; beginBotTurn(); }
  } catch {} finally { timeoutFetching = false; }
}
function tickClocks() {
  if (!game) return;
  // Synced countdown (real-player games): the shared end can arrive
  // on the stream or on a poll, and the 100ms tick notices either
  // within a tenth of a second. The remaining time is relative
  // (server-computed), so no phone/server clock comparison is made.
  if (waitingForSync && game.countdownRemainingMs != null) {
    waitingForSync = false;
    if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; }
    startCountdown(Date.now() + game.countdownRemainingMs);
    return;
  }
  // Game-start hold: both timers sit on 4:00 for a full second before
  // ticking to 3:59. With floor display, 4:00 would otherwise drop to
  // 3:59 within ~100ms of starting. This is display-only: the underlying
  // elapsed time keeps running from the start, so at hold end the clock
  // reads exactly 3:59, then 3:58 a second later, with no jump.
  if (Date.now() < clockHoldUntil) { $('clockHuman').textContent = '4:00'; $('clockBot').textContent = '4:00'; return; }
  // During the countdown both clocks are pinned to 4:00, every tick.
  // Any render that recomputed from the server create time (4:59) or
  // from elapsed time during the countdown was the first-seconds glitch
  // in the screenshots: this overwrites it within 100ms, and renderGame
  // below does the same immediately.
  if (countdownActive) { $('clockHuman').textContent = '4:00'; $('clockBot').textContent = '4:00'; return; }
  const elapsed = Date.now() - gameFetchAt;
  let h = game.clocks.human, b = game.clocks.bot;
  if (game.status === 'active') {
    if (game.clocks.turn === 'human') h = Math.max(0, h - elapsed); else b = Math.max(0, b - elapsed);
  }
  if (Date.now() >= humanRunoffUntil) $('clockHuman').textContent = fmtClock(h);
  // During a runoff animation the bot clock is driven by the animation,
  // not by this 100ms tick — the tick used to jump it straight to the
  // stepped value and flicker over the animation.
  if (Date.now() >= runoffUntil) $('clockBot').textContent = fmtClock(b);
  // Human clock hit 0: do not leave the game sitting on a dead turn.
  // Fetching flips the server to the bot turn, which then loops on its own.
  if (game.status === 'active' && game.clocks.turn === 'human' && h <= 0) { $('status').textContent = 'Out of time, opponent plays on.'; updateForfeitLabel(); if (!timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleTimeoutFetch(); }
  // Opponent clock hit 0: fetch at once instead of waiting for the
  // next scheduled poll. A persona's think can run 30s, so the board
  // sat on 0:00 with the turn never coming. The fetch flips the
  // server to my turn (or finishes the game if my clock is 0 too).
  if (game.status === 'active' && game.clocks.turn === 'bot' && b <= 0 && !timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleTimeoutFetch();
  // Both clocks at 0: the game is over, end it at once. The old code
  // only fetched on the human's turn, so when the second clock ran
  // out during the bot's think (up to 30s for a persona) the board
  // sat on 0:00 / 0:00 with nothing happening until the next poll.
  // A fetch settles the clocks server-side and finishes the game,
  // so the stat window comes up within ~1s of the second clock
  // hitting 0, whichever turn it is.
  if (game.status === 'active' && h <= 0 && b <= 0 && !timeoutFetching && Date.now() - timeoutLastAttempt > 1000) handleTimeoutFetch();
  botWatchdog();
}
setInterval(tickClocks, 100);

let botTimer = null, suppressNextClick = false, botTurnTapTime = 0;
function parseClockText(txt) { const m = /^([0-9]+):([0-9]{2})$/.exec((txt || '').trim()); return m ? Number(m[1]) * 60000 + Number(m[2]) * 1000 : null; }
function animateClockRunoff(fromMs, toMs) {
  if (fromMs !== null && toMs !== null) fromMs = Math.min(fromMs, toMs + 20000);
  if (fromMs === null || toMs === null || fromMs <= toMs) { if (toMs !== null) $('clockBot').textContent = fmtClock(toMs); return; }
  const steps = Math.max(1, Math.round((fromMs - toMs) / 1000));
  // 50ms per displayed second = ~750ms for the 15s runoff to the 20s mark.
  runoffUntil = Date.now() + steps * 50 + 100;
  let i = 0;
  const iv = setInterval(() => {
    i++;
    const v = fromMs - Math.round((fromMs - toMs) * i / steps);
    $('clockBot').textContent = fmtClock(Math.max(toMs, v));
    if (i >= steps) { clearInterval(iv); $('clockBot').textContent = fmtClock(toMs); runoffUntil = 0; }
  }, 50);
}
function animateHumanRunoff(fromMs, toMs) {
  if (fromMs === null || toMs === null || fromMs <= toMs) { if (toMs !== null) $('clockHuman').textContent = fmtClock(toMs); return; }
  const steps = Math.max(1, Math.round((fromMs - toMs) / 1000));
  humanRunoffUntil = Date.now() + steps * 20 + 100;
  $('clockHuman').textContent = fmtClock(fromMs);
  let i = 0;
  const iv = setInterval(() => {
    i++;
    const v = fromMs - Math.round((fromMs - toMs) * i / steps);
    $('clockHuman').textContent = fmtClock(Math.max(toMs, v));
    if (i >= steps) { clearInterval(iv); $('clockHuman').textContent = fmtClock(toMs); humanRunoffUntil = 0; }
  }, 20);
}
let lastBotPollAt = 0;
// Stale-fetch guard: every read of the game state (poll, timeout
// fetch) is stamped with a sequence number, and a response is only
// applied if no newer state has been applied since it was sent. The
// v81 playInFlight check only caught a stale fetch when the Play was
// still in flight — but the Play POST is usually faster than a slow
// GET, so a fetch sent before a Play that returned after the reply
// still overwrote the board with a pre-play snapshot and put the
// played tiles back in the rack. A Play / Pass / Forfeit reply, and
// entering a game, invalidates every fetch sent before it, so only
// fetches sent after that state can apply.
let gameFetchSeq = 0, gameAppliedSeq = 0;
// Live updates for real-player games (SSE): the server pushes every new
// game state the instant it is saved, so a move appears on the
// opponent's phone with no poll wait at all. The 1s poll keeps running
// as the fallback (and drives nothing new) — if the stream drops, the
// game just behaves like v82. Bot games never open a stream: their
// polls are what advance the bot. EventSource reconnects on its own
// after a drop, and the server sends the current state on (re)connect.
let gameStream = null, gameStreamGameId = null;
function openGameStream() {
  if (!game || game.botType !== 'human' || !token) return;
  if (gameStream && gameStreamGameId === game.id) return;
  closeGameStream();
  const es = new EventSource(API_BASE + `/api/games/${game.id}/stream?token=${encodeURIComponent(token)}`);
  gameStream = es; gameStreamGameId = game.id;
  es.addEventListener('game', (ev) => {
    let state; try { state = JSON.parse(ev.data); } catch { return; }
    if (!game || state.id !== game.id) return;
    // A play reply settles the state itself; a push landing mid-flight
    // must not touch it.
    if (playInFlight) return;
    // An echo of the state I already have — the deferred-optimal
    // re-broadcast seconds after a play, or the re-sync on reconnect —
    // carries nothing new and must not wipe tiles I have placed since.
    // Only a state that actually changes the game is applied.
    const sameBoard = JSON.stringify(state.board) === JSON.stringify(game.board);
    const sameScores = state.scores.human === game.scores.human && state.scores.bot === game.scores.bot;
    const sameTurn = state.clocks.turn === game.clocks.turn;
    const sameStatus = state.status === game.status;
    const sameRack = JSON.stringify(state.humanRack) === JSON.stringify(game.humanRack);
    // The shared countdown is a change too: a check-in broadcast
    // carries nothing else new (same board, scores, turn, rack), so
    // without this the waiting player would never learn the countdown
    // had started. A fresh remaining value is always a real change —
    // the value only moves when the countdown is stamped or the game
    // starts, never on a routine save.
    const sameCountdown = (state.countdownRemainingMs ?? null) === (game.countdownRemainingMs ?? null);
    const sameStarted = !!state.started === !!game.started;
    if (sameBoard && sameScores && sameTurn && sameStatus && sameRack && sameCountdown && sameStarted) return;
    // This state is newer than any fetch sent: invalidate every
    // in-flight GET so a stale poll response can never overwrite it.
    gameAppliedSeq = gameFetchSeq;
    game = state; gameFetchAt = Date.now();
    // Placed tiles only go back when the game is over or it is no longer
    // my turn (a timeout flip, a pass). A move by the opponent flips the
    // turn TO me, and my own play's echo leaves the turn with them — in
    // neither case is anything placed to lose.
    if (state.status !== 'active' || state.clocks.turn !== 'human') { pending = []; selectedRack = null; }
    renderGame();
  });
  // No onerror handling: EventSource reconnects on its own, and the
  // 1s poll covers any gap while it does.
}
function closeGameStream() { if (gameStream) { try { gameStream.close(); } catch {} gameStream = null; gameStreamGameId = null; } }
async function pollBotTurn() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot' || playInFlight) return;
  lastBotPollAt = Date.now(); botTimer = null;
  try {
    // Runoff start from the game state, not from the displayed text:
    // the displayed text is second-truncated, so parsing it back gave
    // a start up to a second off (the jump-up before the runoff).
    const fromMs = game.clocks.turn === 'bot' ? Math.max(0, game.clocks.bot - (Date.now() - gameFetchAt)) : game.clocks.bot;
    const prevBot = game.lastBot ? JSON.stringify(game.lastBot) : '';
    const prevBotScore = game.scores ? game.scores.bot : 0;
    const mySeq = ++gameFetchSeq;
    const next = await api(`/api/games/${game.id}`);
    // A poll that started before a Play tap must not overwrite the
    // post-play state: if a play went in flight while this GET was
    // out, its pre-play snapshot arriving after the play reply would
    // put the played tiles back in the rack and hide the move. The
    // play reply sets the state itself (and beginBotTurn re-polls),
    // so a stale response is simply dropped here. The sequence check
    // below is the one that catches it when the play has already
    // finished by the time this returns.
    if (playInFlight) return;
    if (mySeq <= gameAppliedSeq) return;
    const botMoved = (next.lastBot ? JSON.stringify(next.lastBot) : '') !== prevBot || (next.scores && next.scores.bot !== prevBotScore);
    game = next; gameAppliedSeq = mySeq; gameFetchAt = Date.now(); pending = []; selectedRack = null; renderGame();
    // Animate the runoff whenever the bot actually played, even if the
    // server already flipped to the NEXT bot turn (human clock at 0) —
    // the old code returned early in that case and the runoff never ran.
    if (botMoved) animateClockRunoff(fromMs, next.clocks.bot);
    if (next.clocks.turn === 'bot' && next.status === 'active') {
      // Relative remaining time from the server, never the server's absolute
      // clock: comparing Render time to phone time added a spurious ~2s poll.
      // A real opponent takes their time: poll every 1s instead of the
      // bot's think-driven cadence (botThinkRemainingMs is null for
      // human games, which would otherwise fall to 500ms).
      const delay = game.botType === 'human' ? 1000 : (next.botThinkRemainingMs != null ? Math.max(200, next.botThinkRemainingMs) : 500);
      if (botTimer) clearTimeout(botTimer);
      botTimer = setTimeout(pollBotTurn, delay);
      return;
    }
    if (next.status === 'active') {
      if (next.clocks.human <= 0) handleTimeoutFetch();
      else await loadMe();
    }
  } catch {
    // A failed poll used to kill the loop entirely: no retry was ever
    // scheduled, so the game sat on the bot turn forever until a reload.
    // Retry after 1s while it is still the bot turn.
    if (game && game.status === 'active' && game.clocks.turn === 'bot') {
      if (botTimer) clearTimeout(botTimer);
      botTimer = setTimeout(pollBotTurn, 1000);
    }
  }
}
// Watchdog, driven by the 100ms clock tick: if it is the bot turn and
// no poll has run in the last 7s (timer lost, poll died, page restored
// from background), restart the bot turn instead of staying stuck.
function botWatchdog() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot' || playInFlight) return;
  if (botTimer) return;
  if (Date.now() - lastBotPollAt > 7000) { botTurnTapTime = 0; beginBotTurn(); }
}
// One source for the "waiting" status, so it never flips between the
// opponent's name and the generic line: beginBotTurn, updateStatus and
// doPlay each used to write their own copy, and every render overwrote
// the named one with the generic one. Named opponents (a persona's or
// real player's first name, Fishstick) keep their name; the Competitive
// Bot has no name, so it keeps the generic line.
function waitingStatus() {
  if (!game) return 'Waiting for your opponent.';
  if (game.clocks.human <= 0) return 'Out of time, opponent plays on.';
  if (game.botType === 'fishstick') return 'Waiting for Fishstick.';
  if (game.botType === 'persona' && game.persona) return `Waiting for ${game.persona.firstName}.`;
  if (game.botType === 'human' && game.opponent) return `Waiting for ${game.opponent.firstName}.`;
  return 'Waiting for your opponent.';
}
function beginBotTurn() {
  if (!game || game.status !== 'active' || game.clocks.turn !== 'bot') return;
  $('status').textContent = waitingStatus();
  if (botTimer) clearTimeout(botTimer);
  // A real opponent has no think time: poll at once, then every 2s
  // (see pollBotTurn), instead of waiting out a bot think that
  // does not exist.
  if (game.botType === 'human') { botTimer = setTimeout(pollBotTurn, 0); return; }
  // Perceived think is measured from the tap, not from the server reply.
  // Think is 5s normally, 2s once the human clock is at 0 (the server
  // sends its chosen duration as botThinkMs; fall back to the clock rule).
  const thinkMs = game.botThinkMs || (game.clocks.human <= 0 ? 2000 : 5000);
  if (botTurnTapTime && Date.now() - botTurnTapTime < 10000) {
    const delay = Math.max(0, thinkMs - (Date.now() - botTurnTapTime));
    botTimer = setTimeout(pollBotTurn, delay);
    return;
  }
  // Relative remaining time, less the time since this game state arrived
  // (network + render), so latencies before the timer starts do not stack
  // on top of the think.
  const delay = game.botThinkRemainingMs != null ? Math.max(0, game.botThinkRemainingMs - (Date.now() - gameFetchAt)) : thinkMs;
  botTimer = setTimeout(pollBotTurn, delay);
}

let validateInFlight = null, lastValidate = null, lastValidatePlacements = null, playInFlight = false, validateSeq = 0;
// Instant local pre-check: the full word list, fetched once (kicked off at
// game start, during the countdown) and kept in memory. Until it loads, the
// server path below is used. Submitted plays are still validated by the
// server authoritatively; this only decides the status line, Play colour,
// points bubble, and the optimistic score at the tap.
let localWords = null, localWordsPromise = null;
function ensureLocalWords() {
  if (localWords) return Promise.resolve(localWords);
  if (!localWordsPromise) {
    localWordsPromise = fetch(API_BASE + '/api/words').then(r => { if (!r.ok) throw new Error('words'); return r.text(); }).then(txt => {
      const set = new Set();
      for (const line of txt.split('\n')) { const w = line.trim().toUpperCase(); if (w) set.add(w); }
      localWords = set; return set;
    }).catch(() => { localWordsPromise = null; return null; });
  }
  return localWordsPromise;
}
const LOCAL_VALUES = { A:1,B:4,C:4,D:3,E:1,F:5,G:3,H:4,I:1,J:9,K:6,L:2,M:4,N:2,O:1,P:4,Q:10,R:1,S:1,T:1,U:2,V:6,W:5,X:8,Y:5,Z:9 };
const SIZE = 10;
function localWordAt(board, r, c, dir) {
  let cells = [];
  if (dir === 'H') {
    let s = c; while (s > 0 && board[r][s - 1]) s--;
    let e = c; while (e < SIZE - 1 && board[r][e + 1]) e++;
    for (let cc = s; cc <= e; cc++) cells.push([r, cc]);
  } else {
    let s = r; while (s > 0 && board[s - 1][c]) s--;
    let e = r; while (e < SIZE - 1 && board[e + 1][c]) e++;
    for (let rr = s; rr <= e; rr++) cells.push([rr, c]);
  }
  return { word: cells.map(([rr, cc]) => board[rr][cc]).join(''), cells };
}
function localScoreWord(board, cells, newSet, premiums) {
  let sum = 0, wordMult = 1;
  for (const [r, c] of cells) {
    let v = LOCAL_VALUES[board[r][c]] || 0;
    if (newSet.has(`${r},${c}`)) {
      const pr = premiums[`${r},${c}`];
      if (pr === 'DL') v *= 2; else if (pr === 'TL') v *= 3;
      else if (pr === 'DW') wordMult *= 2; else if (pr === 'TW') wordMult *= 3;
    }
    sum += v;
  }
  return sum * wordMult;
}
// Mirrors the server's validatePlay verdict (valid/error/invalidWords/
// score/mainWord/mainCells/bonus/isDuello/bingo/words). Rack and occupancy
// checks are skipped: placements are built from the rack onto empty cells
// by construction, and the server re-checks everything on submit.
function localValidate(board, placements, isFirst, wordsSet, premiums) {
  if (!placements || !placements.length) return { valid: false, error: 'No tiles placed.' };
  if (placements.length > 6) return { valid: false, error: 'Too many tiles.' };
  for (const pl of placements) if (pl.row < 0 || pl.row >= SIZE || pl.col < 0 || pl.col >= SIZE) return { valid: false, error: 'Tile off the board.' };
  const sameRow = placements.every(pl => pl.row === placements[0].row);
  const sameCol = placements.every(pl => pl.col === placements[0].col);
  if (!sameRow && !sameCol) return { valid: false, error: 'all tiles must be connected' };
  const dir = sameRow ? 'H' : 'V';
  const sorted = placements.slice().sort((a, b) => dir === 'H' ? a.col - b.col : a.row - b.row);
  const lineIdx = dir === 'H' ? sorted[0].row : sorted[0].col;
  const lo = dir === 'H' ? sorted[0].col : sorted[0].row;
  const hi = dir === 'H' ? sorted[sorted.length - 1].col : sorted[sorted.length - 1].row;
  const trial = board.map(row => row.slice());
  for (const pl of placements) trial[pl.row][pl.col] = pl.letter;
  for (let i = lo; i <= hi; i++) {
    const cell = dir === 'H' ? trial[lineIdx][i] : trial[i][lineIdx];
    if (!cell) return { valid: false, error: 'all tiles must be connected' };
  }
  const inInner = (r, c) => r >= 2 && r <= 7 && c >= 2 && c <= 7;
  if (isFirst) {
    for (const pl of placements) if (!inInner(pl.row, pl.col)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
    if (dir === 'H' && (lineIdx < 2 || lineIdx > 7)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
    if (dir === 'V' && (lineIdx < 2 || lineIdx > 7)) return { valid: false, error: 'First word goes entirely inside the glowing 6x6.' };
  } else {
    let mainIncludesExisting = false;
    for (let i = lo; i <= hi; i++) { const was = dir === 'H' ? board[lineIdx][i] : board[i][lineIdx]; if (was) mainIncludesExisting = true; }
    let adjacent = false;
    for (const pl of placements) {
      const neigh = [[pl.row - 1, pl.col], [pl.row + 1, pl.col], [pl.row, pl.col - 1], [pl.row, pl.col + 1]];
      if (neigh.some(([r, c]) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c])) adjacent = true;
    }
    if (!mainIncludesExisting && !adjacent) return { valid: false, error: 'all tiles must be connected' };
  }
  const newSet = new Set(placements.map(pl => `${pl.row},${pl.col}`));
  if (placements.length === 1 && !isFirst) {
    const both = [localWordAt(trial, placements[0].row, placements[0].col, 'H'), localWordAt(trial, placements[0].row, placements[0].col, 'V')].filter(w => w.word.length >= 2);
    if (!both.length) return { valid: false, error: 'Word too short.' };
    const bad = [...new Set(both.filter(w => !wordsSet.has(w.word)).map(w => w.word))];
    if (bad.length) return { valid: false, error: 'not a word', invalidWords: bad, words: both };
    const scored1 = both.map(w => ({ word: w.word, cells: w.cells, score: localScoreWord(trial, w.cells, newSet, premiums) }));
    const isDuello1 = both.some(w => w.word === 'DUELLO');
    const bonus1 = isDuello1 ? 30 : 0;
    const main1 = scored1.find(w => w.word === 'DUELLO') || scored1.reduce((a, b) => (b.score > a.score ? b : a));
    return { valid: true, words: scored1, score: scored1.reduce((s, w) => s + w.score, 0) + bonus1, mainWord: main1.word, mainCells: main1.cells, bonus: bonus1, isDuello: isDuello1, bingo: false, placements };
  }
  const main = localWordAt(trial, placements[0].row, placements[0].col, dir);
  if (main.word.length < 2) return { valid: false, error: 'Word too short.' };
  const words = [{ word: main.word, cells: main.cells }];
  const crossDir = dir === 'H' ? 'V' : 'H';
  for (const pl of placements) {
    const cross = localWordAt(trial, pl.row, pl.col, crossDir);
    if (cross.word.length >= 2 && !words.some(w => w.word === cross.word && JSON.stringify(w.cells) === JSON.stringify(cross.cells))) words.push({ word: cross.word, cells: cross.cells });
  }
  const invalidWords = [];
  for (const w of words) if (!wordsSet.has(w.word)) invalidWords.push(w.word);
  if (invalidWords.length) {
    const uniq = [...new Set(invalidWords)];
    return { valid: false, error: 'not a word', invalidWords: uniq, words };
  }
  let score = 0;
  const scored = words.map(w => { const s = localScoreWord(trial, w.cells, newSet, premiums); score += s; return { word: w.word, cells: w.cells, score: s }; });
  const isDuello = main.word === 'DUELLO';
  const bingo = placements.length === 6;
  let bonus = 0;
  if (isDuello) bonus += 30;
  if (bingo) bonus += 30;
  score += bonus;
  return { valid: true, words: scored, score, mainWord: main.word, mainCells: main.cells, bonus, isDuello, bingo, placements };
}
function setPlayState(state) {
  // Play colour is class-based, NOT disabled-based, so a grey Play is still
  // tappable: a disabled button swallows taps, and that swallow was the
  // double-tap. Tapping grey Play with a known-invalid placement does
  // nothing (doPlay returns before any server call); only no-pending /
  // bot-turn Play is truly disabled, and the handler returns early there
  // anyway.
  const b = $('playBtn');
  b.classList.remove('validating', 'play-valid', 'play-invalid');
  if (state === 'valid') { b.classList.add('play-valid'); b.disabled = false; }
  else if (state === 'validating') { b.classList.add('validating'); b.disabled = false; }
  else if (state === 'invalid') { b.classList.add('play-invalid'); b.disabled = false; }
  else { b.disabled = true; }
}
function sentence(s) {
  if (!s) return 'Game over.';
  s = String(s).trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return (s.endsWith('.') || s.endsWith('!') || s.endsWith('?')) ? s : s + '.';
}
function invalidWordsStatus(w) {
  const list = w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
  return w.length === 1 ? `${list} is not a word.` : `${list} are not words.`;
}
async function updateStatus() {
  if (!game) return;
  if (game.status === 'finished') { $('status').textContent = sentence(game.reason || 'Game over'); return; }
  if (game.clocks.turn !== 'human') { $('status').textContent = waitingStatus(); setPlayState('off'); return; }
  if (!pending.length) { $('status').textContent = game.isFirst ? 'First word must fit inside the glowing 6×6.' : 'Your move.'; setPlayState('off'); lastValidate = null; lastValidatePlacements = null; return; }
  if (localWords) {
    const v = localValidate(game.board, pending, game.isFirst, localWords, game.premiums || {});
    const snapshot = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
    lastValidate = v; lastValidatePlacements = snapshot;
    if (v.valid) { $('status').textContent = 'Play?'; setPlayState('valid'); showBubble(v.score, v.mainCells); }
    else if (v.invalidWords && v.invalidWords.length) { $('status').textContent = invalidWordsStatus(v.invalidWords); setPlayState('invalid'); hideBubble(); }
    else { $('status').textContent = v.error ? v.error.charAt(0).toUpperCase() + v.error.slice(1) + (v.error.endsWith('.') ? '' : '.') : 'Invalid play.'; setPlayState('invalid'); hideBubble(); }
    return;
  }
  ensureLocalWords();
  setPlayState('validating');
  try {
    // Seq guard, not just a snapshot check: validations can complete out
    // of order, and the old code let a stale verdict overwrite the latest
    // one, clear validateInFlight, and leave Play grey for a valid play —
    // so the first tap was swallowed and a second tap was required.
    const mySeq = ++validateSeq;
    const snapshot = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
    const myPromise = api(`/api/games/${game.id}/validate`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
    validateInFlight = myPromise;
    const v = await myPromise;
    if (mySeq !== validateSeq) return; // a newer validation superseded this one
    if (validateInFlight === myPromise) validateInFlight = null;
    lastValidate = v; lastValidatePlacements = snapshot;
    if (JSON.stringify(pending.map(p => [p.row, p.col, p.letter])) !== snapshot) return;
    if (v.valid) { $('status').textContent = 'Play?'; setPlayState('valid'); showBubble(v.score, v.mainCells); }
    else if (v.invalidWords && v.invalidWords.length) {
      $('status').textContent = invalidWordsStatus(v.invalidWords);
      setPlayState('invalid'); hideBubble();
    } else { $('status').textContent = v.error ? v.error.charAt(0).toUpperCase() + v.error.slice(1) + (v.error.endsWith('.') ? '' : '.') : 'Invalid play.'; setPlayState('invalid'); hideBubble(); }
  } catch {
    // A failed check used to leave a stale status ("Your move." / "Play?")
    // with Play greyed, so an invalid word never got named until the user
    // tapped Play. Retry once for a transient failure (Render waking up);
    // if that also fails, Play stays tappable and its server verdict
    // names the words (see doPlay catch).
    setPlayState('invalid');
    const retrySnapshot = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
    setTimeout(async () => {
      if (!game || game.status !== 'active' || game.clocks.turn !== 'human') return;
      if (JSON.stringify(pending.map(p => [p.row, p.col, p.letter])) !== retrySnapshot) return;
      try {
        const v2 = await api(`/api/games/${game.id}/validate`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })) }) });
        if (JSON.stringify(pending.map(p => [p.row, p.col, p.letter])) !== retrySnapshot) return;
        lastValidate = v2; lastValidatePlacements = retrySnapshot;
        if (v2.valid) { $('status').textContent = 'Play?'; setPlayState('valid'); showBubble(v2.score, v2.mainCells); }
        else if (v2.invalidWords && v2.invalidWords.length) { $('status').textContent = invalidWordsStatus(v2.invalidWords); setPlayState('invalid'); hideBubble(); }
      } catch {}
    }, 500);
  }
}
function attachBubble(score, target, kind) {
  const cells = document.querySelectorAll('#board .cell');
  const cell = cells[target[0] * 10 + target[1]];
  if (!cell) return;
  const b = document.createElement('div'); b.className = 'play-bubble' + (kind ? ' ' + kind : ''); b.textContent = score;
  cell.style.position = 'relative'; cell.style.zIndex = '50'; cell.appendChild(b);
}
function showBubble(score, mainCells) {
  hideBubble();
  if (!pending.length) return;
  // Bubble goes over the positionally last letter of the word string, not
  // the last tile the player happened to drop: mainCells are in word order,
  // so their last cell is the last letter. Fall back to the pending tile
  // with the largest row/col in the play direction.
  let target = null;
  if (mainCells && mainCells.length) target = mainCells[mainCells.length - 1];
  else {
    const sameRow = pending.every(p => p.row === pending[0].row);
    const sorted = pending.slice().sort((a, b) => sameRow ? a.col - b.col : a.row - b.row);
    target = [sorted[sorted.length - 1].row, sorted[sorted.length - 1].col];
  }
  attachBubble(score, target);
}
function hideBubble() { document.querySelectorAll('.play-bubble').forEach(e => { if (e.parentElement) e.parentElement.style.zIndex = ''; e.remove(); }); }
function placeTile(r, c) {
  if (!canPlaceTiles()) return;
  if (game.board[r][c]) return;
  if (pending.some(p => p.row === r && p.col === c)) return;
  const letter = game.humanRack[selectedRack];
  pending.push({ row: r, col: c, letter, rackIndex: selectedRack });
  selectedRack = null; renderGame();
}
function recallTile(pend) {
  // No recall while a play is in flight or it is not the human turn:
  // after tapping Play, pending tiles stay on the board until the
  // server reply lands, and tapping one in that window used to
  // briefly recall it (visually) before the reply put it back.
  if (playInFlight) return;
  if (!game || game.status !== 'active' || game.clocks.turn !== 'human') return;
  pending = pending.filter(p => p !== pend); renderGame();
}
$('recallBtn').onclick = () => { if (playInFlight) return; cleanupStuckDrag(); pending = []; selectedRack = null; renderGame(); };
let shuffling = false;
$('shuffleBtn').onclick = async () => {
  cleanupStuckDrag();
  if (!game || shuffling) return;
  // Works on the player's turn AND on the opponent's turn, and when
  // out of time: the rack is the player's own rack, the shuffle
  // endpoint does not require it to be your turn, and the greyed
  // opponent-turn rack is opacity-only (not disabled).
  // While a Play is in flight the rack has blank slots (played tiles,
  // refilled by the reply), so a server shuffle would be rejected for
  // not matching the server rack: shuffle only the letters still in
  // the rack, locally, keeping the blanks where they are. The reply
  // refills the rack and takes over from there.
  if (optimisticPlay) {
    const letters = game.humanRack.filter(l => l);
    for (let i = letters.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [letters[i], letters[j]] = [letters[j], letters[i]]; }
    let k = 0;
    game.humanRack = game.humanRack.map(l => (l ? letters[k++] : null));
    renderGame();
    return;
  }
  const rack = [...game.humanRack];
  for (let i = rack.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rack[i], rack[j]] = [rack[j], rack[i]]; }
  const rackEl = $('rack');
  shuffling = true;
  // Fold in: every tile slides toward the rack centre, shrinking, so the
  // tiles pass around one another instead of just popping in place.
  const fold = (tiles) => {
    const centre = rackEl.getBoundingClientRect().left + rackEl.getBoundingClientRect().width / 2;
    tiles.forEach(t => {
      const r = t.getBoundingClientRect();
      const dx = centre - (r.left + r.width / 2);
      t.style.transition = 'transform 50ms ease-in, opacity 50ms ease-in';
      t.style.transform = `translateX(${dx}px) scale(0.6)`;
      t.style.opacity = '0.6';
    });
  };
  fold([...rackEl.querySelectorAll('.tile')]);
  await new Promise(r => setTimeout(r, 60));
  try {
    game = await api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) }); gameFetchAt = Date.now(); renderGame();
    // Fold out: new tiles start collapsed at the centre and expand to
    // their new slots, so the new order is revealed by the unfold.
    const newTiles = [...$('rack').querySelectorAll('.tile')];
    const centre2 = $('rack').getBoundingClientRect().left + $('rack').getBoundingClientRect().width / 2;
    newTiles.forEach(t => {
      const r = t.getBoundingClientRect();
      const dx = centre2 - (r.left + r.width / 2);
      t.style.transition = 'none';
      t.style.transform = `translateX(${dx}px) scale(0.6)`;
      t.style.opacity = '0.6';
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      newTiles.forEach(t => {
        t.style.transition = 'transform 70ms ease-out, opacity 70ms ease-out';
        t.style.transform = ''; t.style.opacity = '';
      });
      setTimeout(() => newTiles.forEach(t => { t.style.transition = ''; }), 90);
    }));
  } catch {
    // Shuffle failed server-side: unfold the original tiles back out.
    [...rackEl.querySelectorAll('.tile')].forEach(t => { t.style.transition = 'transform 70ms ease-out, opacity 70ms ease-out'; t.style.transform = ''; t.style.opacity = ''; });
  }
  shuffling = false;
};
function armButton(btn, label, fn, penalty) {
  // The label may be a function (the Forfeit button reads "Exit" once
  // your time expires), so resolve it at each use instead of at wiring.
  const getLabel = () => (typeof label === 'function' ? label() : label);
  return async () => {
    if (!armed[btn.id]) { armed[btn.id] = true; btn.classList.add('armed-red'); btn.innerHTML = 'SURE?<span class="penalty">' + penalty + '</span>'; setTimeout(() => { armed[btn.id] = false; btn.classList.remove('armed-red'); btn.textContent = getLabel(); }, 3000); return; }
    armed[btn.id] = false; btn.classList.remove('armed-red'); btn.textContent = getLabel(); await fn();
  };
}
$('passBtn').onclick = armButton($('passBtn'), 'Pass', async () => {
  // Same tap-time clock switch as Play: freeze human, start bot now.
  const tapAt = Date.now(); const clientElapsedMs = Math.max(0, tapAt - gameFetchAt);
  const prevHuman = game.clocks.human, prevFetchAt = gameFetchAt;
  game.clocks.human = Math.max(0, game.clocks.human - clientElapsedMs); game.clocks.turn = 'bot'; gameFetchAt = tapAt; renderGame(); tickClocks();
  const fromHuman = game.clocks.human;
  try { botTurnTapTime = tapAt; game = await api(`/api/games/${game.id}/pass`, { method: 'POST', body: JSON.stringify({ clientElapsedMs }) }); gameAppliedSeq = gameFetchSeq; gameFetchAt = tapAt; pending = []; renderGame(); animateHumanRunoff(fromHuman, game.clocks.human); beginBotTurn(); }
  catch { game.clocks.turn = 'human'; game.clocks.human = prevHuman; gameFetchAt = prevFetchAt; renderGame(); }
}, '-30s');
$('forfeitBtn').onclick = armButton($('forfeitBtn'), () => humanOutOfTime() ? 'Exit' : 'Forfeit', async () => {
  const wasOutOfTime = humanOutOfTime();
  game = await api(`/api/games/${game.id}/forfeit`, { method: 'POST' }); gameAppliedSeq = gameFetchSeq; gameFetchAt = Date.now(); pending = [];
  if (wasOutOfTime) {
    // Exit: the loss and Elo move are recorded server-side, but there
    // is no stat window — leave straight to the main menu. Marking the
    // stats as shown for this game stops renderGame from popping the
    // window on the finished game.
    statShownGameId = game.id;
    goHome();
  } else {
    renderGame();
  }
}, 'you lose');
async function doPlay() {
  // Unstick first, and clear the drag's click-suppression flag: after a
  // drag, suppressNextClick stayed true until an empty cell was tapped,
  // and the Play tap itself was the thing that had to wait for a
  // validation round-trip to show any feedback.
  cleanupStuckDrag(); suppressNextClick = false;
  if (!game || game.clocks.turn !== 'human' || !pending.length || playInFlight) return;
  // A Play tap with no valid word does nothing: when the verdict for
  // these exact placements is known and invalid, return before any clock
  // switch, rack change, render, or server call. When the verdict is
  // unknown (validation still in flight or the word list not loaded yet),
  // fall through and let the server decide authoritatively.
  const tapKey = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
  if (lastValidate && lastValidatePlacements === tapKey && !lastValidate.valid) return;
  // Do NOT wait for a validation round-trip: the server play call
  // validates authoritatively and will error if the play is truly
  // invalid. Waiting made the first tap look dead (no feedback at all
  // until validate returned), so users tapped again or tapped elsewhere
  // and only then saw the play go through.
  // Clock switch happens AT THE TAP, not at the server reply: freeze
  // the human clock at its tap-time value and start the bot clock
  // ticking from the tap, via tickClocks only (no full render, so no
  // validation round-trip re-enables Play mid-flight). Before this,
  // the 100ms interval kept ticking the human clock for the whole
  // Play POST (sometimes ~1s), and the bot clock only started when
  // the reply landed.
  const tapAt = Date.now();
  const clientElapsedMs = Math.max(0, tapAt - gameFetchAt);
  const prevHuman = game.clocks.human, prevFetchAt = gameFetchAt;
  const prevScore = game.scores.human, prevLastHuman = game.lastHuman, prevRack = game.humanRack.slice();
  game.clocks.human = Math.max(0, game.clocks.human - clientElapsedMs);
  // The turn only flips to the opponent at the tap when they still
  // have time: with their clock already at 0 there is no bot turn
  // at all (the server keeps the turn with the human), so flipping
  // here flashed "Waiting for your opponent." for the split second
  // until the reply landed.
  const botHasTime = game.clocks.bot > 0;
  if (botHasTime) game.clocks.turn = 'bot';
  gameFetchAt = tapAt;
  // Score immediately at the tap, not when the Play POST returns: the
  // validation verdict for these exact placements already carries the
  // score (including bonuses), so add it now and show the played words
  // below the clock. The server reply then replaces the whole game
  // object with the authoritative score, so there is no double count;
  // a failed Play restores the pre-tap score and last play below.
  const pendKey = JSON.stringify(pending.map(p => [p.row, p.col, p.letter]));
  if (lastValidate && lastValidate.valid && lastValidatePlacements === pendKey) {
    game.scores.human += lastValidate.score;
    game.lastHuman = { word: lastValidate.mainWord, points: lastValidate.score, bonus: lastValidate.bonus, isDuello: lastValidate.isDuello, bingo: lastValidate.bingo, words: (lastValidate.words || []).map(w => w.word) };
  }
  // Played tiles leave the rack immediately at the tap, as blank slots
  // — not as random replacement letters. The old code drew a client-side
  // refill at the tap, which the server reply then replaced with
  // different letters: the visible flicker Jeff reported. The slots the
  // server will refill are the indexOf-matched ones (same as applyMove);
  // they stay blank until the server reply fills them with its
  // authoritative letters, so no letter ever changes into another one.
  {
    const remaining = game.humanRack.slice(); const usedSet = new Set();
    for (const pl of pending) { const idx = remaining.indexOf(pl.letter); if (idx >= 0) { usedSet.add(idx); remaining[idx] = null; } }
    game.humanRack = game.humanRack.map((l, i) => usedSet.has(i) ? null : l);
    optimisticPlay = true;
  }
  // Highlight the opponent's scoreboard AT THE TAP, not when the Play
  // POST returns: render now so the .active border flips immediately.
  playInFlight = true;
  renderGame();
  $('playBtn').disabled = true; $('playBtn').classList.remove('validating', 'play-valid', 'play-invalid');
  $('status').textContent = botHasTime ? waitingStatus() : 'Your move.'; tickClocks();
  try {
    botTurnTapTime = tapAt;
    game = await api(`/api/games/${game.id}/play`, { method: 'POST', body: JSON.stringify({ placements: pending.map(p => ({ row: p.row, col: p.col, letter: p.letter })), clientElapsedMs }) });
    // This reply is the newest state: invalidate every fetch sent
    // before it, so a slow pre-play GET landing after the reply can
    // no longer overwrite the board with the pre-play snapshot.
    gameAppliedSeq = gameFetchSeq;
    // Keep the bot clock ticking from the tap, not from the reply:
    // gameFetchAt stays at tapAt, so the bot display does not jump
    // back up by the POST duration when the reply lands.
    gameFetchAt = tapAt; pending = []; optimisticPlay = false; cleanupStuckDrag(); $('rack').classList.add('instant'); renderGame(); setTimeout(() => $('rack').classList.remove('instant'), 100); beginBotTurn(); loadMe();
  } catch (e) {
    // Play failed: restore the human turn, its pre-tap clock, and the
    // pre-tap score / last play (undoing the optimistic score above).
    game.clocks.turn = 'human'; game.clocks.human = prevHuman; gameFetchAt = prevFetchAt;
    game.scores.human = prevScore; game.lastHuman = prevLastHuman; game.humanRack = prevRack; optimisticPlay = false;
    $('status').textContent = (e.invalidWords && e.invalidWords.length) ? invalidWordsStatus(e.invalidWords) : sentence(String(e.message || '').slice(0, 48)); renderGame();
  }
  finally { playInFlight = false; }
}
// Fire on pointerdown, not only on click: after a drag, iOS can swallow
// the synthesised click for the first tap, which is exactly the
// "double-tap or tap elsewhere first" pattern. Pointerdown fires on the
// first touch, and the following click is ignored so one tap = one play.
let playPointerAt = 0;
$('playBtn').addEventListener('pointerdown', e => { playPointerAt = Date.now(); doPlay(); });
$('playBtn').addEventListener('click', e => { if (Date.now() - playPointerAt < 1000) return; doPlay(); });
let statDelayTimer = null, statShownGameId = null;
function clearStatDelay() { if (statDelayTimer) { clearTimeout(statDelayTimer); statDelayTimer = null; } }
// The stat window shows instantly on every finish now (Nov 5,
// 2026): when both clocks hit 0 the window comes up at once
// instead of showing the final board for 3s first. The old 3s
// timeout delay and its isTimeoutFinish check are gone; the
// statDelayTimer machinery stays as a harmless guard (startGame
// and navigation still clear it) but nothing ever sets it.
function showStatWindowDelayed(stats) {
  if (!game || statShownGameId === game.id || statDelayTimer) return;
  showStatWindow(stats);
}
function showStatWindow(stats) {
  // A game just ended, so Elos moved and cached Global Ranks are
  // stale — clear them here (Play Again starts a new game without
  // going home, so the refresh there alone would miss it).
  rankCache.clear();
  clearStatDelay(); if (game) statShownGameId = game.id;
  const w = $('statWindow'); w.classList.remove('hidden');
  $('gameDim').classList.add('dimmed');
  const isPersonaGame = game && game.botType === 'persona';
  const isHumanGame = game && game.botType === 'human';
  const botLabel = (game && game.botType === 'fishstick') ? 'Fishstick' : isPersonaGame ? (game.persona?.firstName || 'Player') : isHumanGame ? (game.opponent?.firstName || 'Player') : 'Bot';
  const humanLabel = (me && me.firstName) ? me.firstName : 'You';
  // Winner is the game's recorded result, not the score comparison:
  // a forfeit is a loss even when the forfeiter is ahead on points.
  // stats.winner comes from the server; the reason check covers any
  // older payload without it.
  const winnerSide = stats.winner || (stats.reason === 'By forfeit' ? 'bot' : null);
  $('statWinner').textContent = winnerSide === 'human' ? humanLabel + ' wins' : winnerSide === 'bot' ? botLabel + ' wins' : winnerSide === 'draw' ? 'Draw' : (stats.scores.human > stats.scores.bot ? humanLabel + ' wins' : stats.scores.bot > stats.scores.human ? botLabel + ' wins' : 'Draw');
  $('statScore').textContent = `${stats.scores.human}–${stats.scores.bot}`;
  $('statReason').textContent = sentence(stats.reason || '');
  const fmtMove = (d, v) => v >= 0 ? '+' + v : '' + v;
  $('eloMoveHuman').textContent = fmtMove(null, stats.eloDeltaHuman ?? 0);
  $('eloMoveHuman').className = 'elo-move ' + ((stats.eloDeltaHuman ?? 0) < 0 ? 'neg' : 'pos');
  // Both Elo moves show for a human-vs-human match, and personas
  // count as humans: their rating moves opposite yours, so it is
  // shown like yours. A real opponent's move shows the same way.
  // For Competitive Bot and Fishstick the bot move stays blank.
  if (isPersonaGame || isHumanGame) {
    $('eloMoveBot').textContent = fmtMove(null, stats.eloDeltaBot ?? 0);
    $('eloMoveBot').className = 'elo-move ' + ((stats.eloDeltaBot ?? 0) < 0 ? 'neg' : 'pos');
  } else {
    $('eloMoveBot').textContent = '';
    $('eloMoveBot').className = 'elo-move';
  }
  const row = (label, h, b) => `<div class="stat-row"><span class="stat-label">${label}</span><span>${h}</span><span>${b}</span></div>`;
  const best = (x) => x.best ? `${x.best.word} (<span class="num">${x.best.score} pts</span>)` : '—';
  const longest = (x) => x.longest ? `${x.longest.word} (<span class="num">${x.longest.word.length} letters</span>)` : '—';
  const opt = (x) => `${x.optimal}/${x.total}`;
  const box = (name, pfp, st, noPhoto, clearBg) => `<div class="stat-box"><div class="stat-box-head"><span class="pfp${noPhoto ? ' no-photo' : ''}${clearBg ? ' clear-bg' : ''}">${pfp}</span><span class="stat-box-name">${name}</span></div><div><span class="stat-label">Best word:</span><br><span class="stat-val">${best(st)}</span></div><div><span class="stat-label">Longest word:</span><br><span class="stat-val">${longest(st)}</span></div><div><span class="stat-label">Optimal moves:</span><br><span class="stat-val num">${opt(st)}</span></div></div>`;
  const humanPfp = (() => { try { return pfpHTML(me); } catch { return ''; } })();
  // A persona with no photo gets the silhouette in the stat box and
  // the top pfp too (same reasoning as the scoreboard: a person
  // without a photo, not Competitive Bot).
  const botPfpBox = game.botType === 'fishstick' ? '<img src="/assets/fishstick.png?v=1" alt="Fishstick">' : isPersonaGame && game.persona?.photoData ? `<img src="${game.persona.photoData}" alt="">` : isHumanGame && game.opponent?.photoData ? `<img src="${game.opponent.photoData}" alt="">` : isPersonaGame || isHumanGame ? silhouetteSVG(36) : '🤖';
  const botNoPhoto = (isPersonaGame && !game.persona?.photoData) || (isHumanGame && !game.opponent?.photoData);
  $('statGrid').innerHTML = box(humanLabel, humanPfp, stats.human, !(me && me.photoData)) + box(botLabel, botPfpBox, stats.bot, botNoPhoto, game.botType === 'fishstick');
  if (game.botType === 'fishstick') $('statBotPfp').innerHTML = '<img src="/assets/fishstick.png?v=1" alt="Fishstick">';
  else if (isPersonaGame && game.persona?.photoData) $('statBotPfp').innerHTML = `<img src="${game.persona.photoData}" alt="">`;
  else if (isHumanGame && game.opponent?.photoData) $('statBotPfp').innerHTML = `<img src="${game.opponent.photoData}" alt="">`;
  else if (isPersonaGame) $('statBotPfp').innerHTML = silhouetteSVG(44);
  else if (isHumanGame) $('statBotPfp').innerHTML = silhouetteSVG(44);
  else $('statBotPfp').textContent = '🤖';
  $('statBotPfp').classList.toggle('no-photo', botNoPhoto);
  $('statBotPfp').classList.toggle('clear-bg', game.botType === 'fishstick');
  // No add-friend icon here any more (Nov 5, 2026): tapping a name
  // opens that person's profile window instead. Persona and real
  // games for the opponent (bots have no profile); games started
  // before v44 carry no persona username, so that name is not
  // tappable. Your own name opens your profile too (no add button
  // on it).
  const boxes = $('statGrid').querySelectorAll('.stat-box');
  const humanNameEl = boxes[0] && boxes[0].querySelector('.stat-box-name');
  if (humanNameEl && me) {
    humanNameEl.style.cursor = 'pointer';
    const humanFullName = [me.firstName, me.lastName].filter(Boolean).join(' ') || humanLabel;
    humanNameEl.onclick = () => openPersonModal({ name: humanFullName, username: me.username, elo: game.player ? game.player.elo : me.elo, photoData: me.photoData || null, isYou: true, isPersona: false });
  }
  const botUsername = isPersonaGame ? game.persona?.username : isHumanGame ? game.opponent?.username : null;
  if (botUsername) {
    const oppInfo = isHumanGame ? game.opponent : game.persona;
    const botFullName = [oppInfo.firstName, oppInfo.lastName].filter(Boolean).join(' ') || botLabel;
    const oppPerson = { name: botFullName, username: botUsername, elo: game.botElo, photoData: oppInfo?.photoData || null, isYou: false, isPersona: isPersonaGame };
    const oppNameEl = boxes[1] && boxes[1].querySelector('.stat-box-name');
    if (oppNameEl) {
      oppNameEl.style.cursor = 'pointer';
      oppNameEl.onclick = () => openPersonModal(oppPerson);
    }
    // The larger top pfp opens the same profile window, as does the
    // smaller one in the stat box. Bots have no profile, so this
    // stays persona games only.
    const oppTopPfp = $('statBotPfp');
    if (oppTopPfp) { oppTopPfp.style.cursor = 'pointer'; oppTopPfp.onclick = () => openPersonModal(oppPerson); }
    const oppBoxPfp = boxes[1] && boxes[1].querySelector('.stat-box-head .pfp');
    if (oppBoxPfp) { oppBoxPfp.style.cursor = 'pointer'; oppBoxPfp.onclick = () => openPersonModal(oppPerson); }
  }
  // A challenge that arrived during the game waited until it ended:
  // check now so its window pops up at once instead of on the next
  // 5-second poll.
  checkIncomingChallenges();
}
$('statWindow').addEventListener('click', e => { if (e.target === $('statWindow')) { clearStatDelay(); $('statWindow').classList.add('hidden'); $('gameDim').classList.remove('dimmed'); } });
// Leaving the board screen refreshes the leaderboard data in the
// background: Elo earned in the game just played otherwise only
// shows up after a full reload, because loadMe, the Global rows
// and the friends list are all cached for the session. The tab bar
// is hidden on the board screen, so Main Menu is the only way out
// and the only place this needs to run.
async function refreshLeaderboards() {
  // A finished game changed the Elo and stats, so the cached
  // profile is stale: the next Profile tap refetches it. The
  // Friends list is invalidated the same way, via the forced
  // friends refetch below. Ranks moved too, so the rank cache
  // goes with them.
  profileData = null; rankCache.clear();
  try { const d = await api('/api/me'); me = d.user; } catch (err) { deadSession(err); return; }
  globalRows = null;
  await loadServerFriends(true);
}
function goHome() { clearStatDelay(); $('statWindow').classList.add('hidden'); show('homeScreen'); refreshLeaderboards(); }
$('mainMenuBtn').onclick = goHome; $('statMainMenu').onclick = goHome;
function playAgain() {
  $('statWindow').classList.add('hidden');
  if (currentBot === 'persona') requestRematch();
  // Play Again against a real player is another challenge to the
  // same opponent: they accept it like the first one. (The stat
  // window's button used to call startGame directly, which the
  // server rejects for real games — so it silently did nothing.)
  else if (currentBot === 'human' && game && game.opponent) startChallenge({ name: [game.opponent.firstName, game.opponent.lastName].filter(Boolean).join(' ') || 'Player', username: game.opponent.username, elo: game.botElo, photoData: game.opponent.photoData || null, isPersona: false });
  else startGame(currentBot, currentPersonaId);
}
$('playAgainBtn').onclick = playAgain;
$('statPlayAgain').onclick = playAgain;
$('gameStatsBtn').onclick = () => { if (game && game.stats) showStatWindow(game.stats); };
const defCache = new Map();
function hideDefinition() { const pop = $('defPopover'); if (pop) { pop.classList.add('hidden'); pop.style.top = ''; pop.style.bottom = ''; } }
// The first tap anywhere else only hides the definition — including a
// tap on another played word. A second tap on a word opens that word's
// definition. The tile's own pointerdown opens the definition in the
// same tap, so it sets defJustOpened and this listener skips that one
// event instead of hiding what was just opened.
let defJustOpened = false;
document.addEventListener('pointerdown', e => {
  const pop = $('defPopover');
  if (!pop || pop.classList.contains('hidden') || pop.contains(e.target)) return;
  if (defJustOpened) { defJustOpened = false; return; }
  hideDefinition();
});
async function showDefinition(r, c) {
  // Find row and column words through this cell, fetch definitions for each.
  const words = [];
  const collect = (dr, dc) => {
    // Scan from the first letter of the word through to the last, in board
    // order. The old code unshifted the forward side and pushed the backward
    // side, which reversed every word (CAT read as TAC).
    let sr = r, sc = c;
    while (sr - dr >= 0 && sr - dr < 10 && sc - dc >= 0 && sc - dc < 10 && game.board[sr - dr][sc - dc]) { sr -= dr; sc -= dc; }
    const cells = [];
    let rr = sr, cc = sc;
    while (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && game.board[rr][cc]) { cells.push([rr, cc]); rr += dr; cc += dc; }
    if (cells.length >= 2) words.push(cells.map(([a, b]) => game.board[a][b]).join(''));
  };
  collect(0, 1); collect(1, 0);
  if (!words.length) return;
  // Show the window immediately, with loading lines, then fill each
  // definition in as it arrives (in parallel, cached). The old code
  // waited for every definition fetch in sequence before showing
  // anything, so a bundled miss that had to go to a live API made the
  // whole popover feel delayed. No auto-hide any more: it stays until
  // the X or a tap elsewhere.
  const pop = $('defPopover');
  pop.innerHTML = `<button class="def-close" aria-label="Close definition">×</button><div class="def-body">${words.map(w => `<div data-def-word="${w}">${w} — Loading…</div>`).join('')}</div>`;
  pop.querySelector('.def-close').onclick = hideDefinition;
  pop.classList.remove('hidden');
  // The popover must never cover a board tile: anchor its top just
  // below the board instead of the fixed bottom offset, which put it
  // over the last row on a phone. It may cover the status line and
  // the top of the rack while it is open — the board stays fully
  // visible, and the next tap dismisses it.
  const boardEl = document.getElementById('board');
  if (boardEl && boardEl.getBoundingClientRect) {
    pop.style.bottom = 'auto';
    pop.style.top = (boardEl.getBoundingClientRect().bottom + 6) + 'px';
  }
  await Promise.all(words.map(async (w) => {
    try {
      let d = defCache.get(w);
      if (!d) { d = await api('/api/define?word=' + encodeURIComponent(w)); defCache.set(w, d); }
      const el = pop.querySelector(`[data-def-word="${w}"]`);
      if (el) el.textContent = `${w} ${d.pos ? '(' + d.pos + ') ' : ''}— ${d.definition}`;
    } catch { const el = pop.querySelector(`[data-def-word="${w}"]`); if (el) el.textContent = `${w} — Could not load definition.`; }
  }));
}
// Drag / tap handling.
// Root cause of bugs 2 and 3: the old code only ever dragged *within* the
// rack (reorder) and never dropped onto the board at all; and every rack
// tap called renderGame() in pointerup, which destroyed the tapped element
// before its click event could fire, so click-to-place selection never stuck.
function cellAtPoint(x, y) {
  const cells = [...document.querySelectorAll('#board .cell')];
  for (let i = 0; i < cells.length; i++) {
    const rect = cells[i].getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { row: Math.floor(i / 10), col: i % 10, el: cells[i] };
  }
  return null;
}
function isCellFree(r, c) {
  if (!game || game.board[r][c]) return false;
  return !pending.some(p => p.row === r && p.col === c);
}
function nearestEmptyCell(r0, c0) {
  // Only an orthogonally adjacent empty cell counts as "nearby". The old
  // version searched the whole board, so dropping over an occupied cell
  // could land a tile next to a completely different word, and validation
  // then complained about a word the player never meant to play ("not a
  // word" for something that was not even adjacent to their intended play).
  // If no adjacent cell is free, the drop cancels instead of jumping away.
  const neighbours = [[r0 - 1, c0], [r0 + 1, c0], [r0, c0 - 1], [r0, c0 + 1]];
  for (const [r, c] of neighbours) {
    if (r >= 0 && r < 10 && c >= 0 && c < 10 && isCellFree(r, c)) return { row: r, col: c };
  }
  return null;
}
function clearDropHighlights() { document.querySelectorAll('#board .cell.drop-target').forEach(el => el.classList.remove('drop-target')); }
function showGhost(letter, x, y) {
  const ghost = $('dragGhost');
  ghost.innerHTML = tileSVG(letter);
  ghost.classList.remove('hidden');
  ghost.style.left = x + 'px'; ghost.style.top = y + 'px';
}
function clearRackShift() { document.querySelectorAll('#rack .tile').forEach(t => { t.style.transform = ''; t.style.zIndex = ''; }); }
function applyRackShift(dragIdx, hoverIdx) {
  // Phone-app slide, WITHOUT moving any DOM node: neighbours between the
  // dragged slot and the hovered slot translate by exactly one slot width,
  // with a CSS transition, so they visibly slide to fill the gap while the
  // ghost is the dragged tile. The old code moved the captured element in
  // the DOM mid-drag (rackEl.append), which on iOS can strand pointer
  // capture — ghost stuck on screen, every later tap delivered to the
  // captured tile, screen "frozen" and Play needing a tap elsewhere first.
  const rackEl = $('rack'); if (!rackEl) return;
  const slot = rackEl.getBoundingClientRect().width / 6;
  rackEl.querySelectorAll('.tile').forEach(t => {
    const ti = Number(t.dataset.idx);
    let shift = 0;
    if (ti !== dragIdx) {
      if (dragIdx < hoverIdx && ti > dragIdx && ti <= hoverIdx) shift = -slot;
      else if (dragIdx > hoverIdx && ti < dragIdx && ti >= hoverIdx) shift = slot;
    }
    t.style.transform = shift ? `translateX(${shift}px)` : '';
    t.style.zIndex = shift ? '2' : '';
  });
}
function enableRackDrag(el, idx) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, captureId = null;
  const cleanup = () => {
    if (!dragging && el.style.opacity === '' && $('dragGhost').classList.contains('hidden')) { /* idempotent */ }
    dragging = false; el.style.opacity = ''; $('dragGhost').classList.add('hidden'); clearDropHighlights(); clearRackShift();
    if (captureId !== null) { try { el.releasePointerCapture(captureId); } catch {} captureId = null; }
    clearDragCleanup(cleanup);
  };
  el.addEventListener('pointerdown', e => {
    cleanupStuckDrag();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null; captureId = e.pointerId;
    registerDragCleanup(cleanup);
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    // Pointer is no longer down but no pointerup arrived (capture lost,
    // gesture interrupted): clean up now instead of leaving a ghost.
    if (e.buttons === 0) { cleanup(); return; }
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
    if (!moved) return;
    suppressNextClick = true;
    el.style.opacity = '0.35';
    showGhost(game.humanRack[idx], e.clientX, e.clientY);
    clearDropHighlights();
    const hit = cellAtPoint(e.clientX, e.clientY);
    if (hit) {
      clearRackShift();
      // Snaps to the cell under the pointer if free; if dragged over a placed
      // tile, snaps to the nearest available space (never recalls that tile).
      const target = isCellFree(hit.row, hit.col) ? hit : nearestEmptyCell(hit.row, hit.col);
      if (target) { drop = { kind: 'board', row: target.row, col: target.col }; const cells = document.querySelectorAll('#board .cell'); cells[target.row * 10 + target.col].classList.add('drop-target'); }
      else drop = null;
      return;
    }
    const rackEl = $('rack'); const rect = rackEl.getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) {
      const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
      drop = { kind: 'rack', hoverIdx: Math.max(0, Math.min(5, Math.floor(rel * 6))) };
      applyRackShift(idx, drop.hoverIdx);
    } else { drop = null; clearRackShift(); }
  });
  el.addEventListener('pointerup', async e => {
    if (!dragging) return;
    const myDrop = drop, wasMoved = moved;
    cleanup();
    if (!wasMoved) {
      if (!canPlaceTiles()) return;
      // Tap (not a drag): click-to-place selection. No re-render here — the
      // old code re-rendered on pointerup and killed the following click.
      selectedRack = (selectedRack === idx ? null : idx);
      [...$('rack').querySelectorAll('.tile')].forEach(t => t.style.outline = (Number(t.dataset.idx) === selectedRack ? '2px solid #ffd166' : ''));
      return;
    }
    if (myDrop && myDrop.kind === 'board') {
      if (!canPlaceTiles()) return;
      selectedRack = idx;
      placeTile(myDrop.row, myDrop.col);
      return;
    }
    if (myDrop && myDrop.kind === 'rack' && myDrop.hoverIdx !== idx) {
      // Optimistic, synchronous reorder: the old code cleared the rack
      // shift in cleanup(), then awaited the server, then re-rendered —
      // so for that network round-trip the tiles sat back in their old
      // order (the split-second revert), then jumped to the new order.
      // Apply locally and render NOW, so the new order is what the user
      // sees on release, and sync to the server in the background.
      const rack = [...game.humanRack];
      const [tile] = rack.splice(idx, 1); rack.splice(myDrop.hoverIdx, 0, tile);
      // Keep any already-placed tiles pointing at the right rack slot:
      // their rackIndex must follow the same move, or the rack spacer
      // for a placed tile lands on the wrong slot after the reorder.
      pending.forEach(p => {
        if (p.rackIndex === idx) p.rackIndex = myDrop.hoverIdx;
        else if (idx < myDrop.hoverIdx && p.rackIndex > idx && p.rackIndex <= myDrop.hoverIdx) p.rackIndex--;
        else if (idx > myDrop.hoverIdx && p.rackIndex < idx && p.rackIndex >= myDrop.hoverIdx) p.rackIndex++;
      });
      game.humanRack = rack; renderGame();
      api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) })
        .then(d => { game = d; gameFetchAt = Date.now(); renderGame(); })
        .catch(() => {});
    }
    // Dropped elsewhere: cancel, keep the tile where it was. No render
    // needed — the shift was only a transform, clearing it restores order.
  });
  el.addEventListener('pointercancel', () => cleanup());
  el.addEventListener('lostpointercapture', () => cleanup());
}
// Drag a tile that is already placed on the board to a new cell.
// Tap (no movement) recalls it, exactly as before; a drag moves it.
function enablePlacedDrag(el, pend) {
  let dragging = false, moved = false, startX = 0, startY = 0, drop = null, captureId = null, rackSlotEl = null;
  const clearRackSlot = () => { if (rackSlotEl) { rackSlotEl.style.outline = ''; rackSlotEl = null; } };
  const cleanup = () => {
    dragging = false; $('dragGhost').classList.add('hidden'); clearDropHighlights(); clearRackSlot(); clearRackShift();
    if (captureId !== null) { try { el.releasePointerCapture(captureId); } catch {} captureId = null; }
    clearDragCleanup(cleanup);
  };
  el.addEventListener('pointerdown', e => {
    cleanupStuckDrag();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY; drop = null; captureId = e.pointerId;
    registerDragCleanup(cleanup);
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (e.buttons === 0) { cleanup(); return; }
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
    if (!moved) return;
    suppressNextClick = true;
    showGhost(pend.letter, e.clientX, e.clientY);
    clearDropHighlights(); clearRackSlot(); clearRackShift();
    const hit = cellAtPoint(e.clientX, e.clientY);
    if (!hit) {
      // Not over the board: check the rack (deck). The whole deck is
      // never highlighted. Two different cases:
      // - Empty slot: highlight only that slot. Dropping there puts
      //   the tile back in that slot with no other deck tile moving.
      // - Occupied deck tile: that tile (and the ones between it and
      //   the dragged tile's original slot) shifts sideways exactly
      //   like a rack drag, showing where the tile would insert.
      const rackEl = $('rack');
      if (rackEl) {
        const rect = rackEl.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) {
          const slot = Math.max(0, Math.min(5, Math.floor((e.clientX - rect.left) / Math.max(1, rect.width) * 6)));
          const slotEl = rackEl.children[slot];
          if (slotEl && slotEl.classList.contains('empty')) {
            drop = { kind: 'rack', slot, mode: 'open' }; rackSlotEl = slotEl; slotEl.style.outline = '2px solid #ffd166'; return;
          }
          if (slotEl) {
            drop = { kind: 'rack', slot, mode: 'insert' }; applyRackShift(pend.rackIndex, slot); return;
          }
        }
      }
      drop = null; return;
    }
    // The tile's own cell is pending, not a board letter, so it is not free;
    // nearestEmptyCell therefore snaps to a *different* free cell, never back
    // onto an occupied cell and never recalling the dragged tile.
    const target = isCellFree(hit.row, hit.col) ? hit : nearestEmptyCell(hit.row, hit.col);
    if (target && !(target.row === pend.row && target.col === pend.col)) {
      drop = { row: target.row, col: target.col };
      document.querySelectorAll('#board .cell')[target.row * 10 + target.col].classList.add('drop-target');
    } else drop = null;
  });
  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    const myDrop = drop, wasMoved = moved;
    cleanup();
    if (playInFlight) return;
    if (!wasMoved) { recallTile(pend); return; }
    if (myDrop && myDrop.kind === 'rack') {
      if (!game || game.status !== 'active' || game.clocks.turn !== 'human') return;
      const orig = pend.rackIndex, target = myDrop.slot;
      if (target === orig) { recallTile(pend); return; }
      if (myDrop.mode === 'open') {
        // Open slot: swap with the placed tile that owns that slot.
        // The deck tiles themselves do not move at all — only the two
        // spacers swap, so the returned tile lands in the open slot
        // and the other placed tile's spacer takes the old slot.
        const owner = pending.find(q => q !== pend && q.rackIndex === target);
        if (!owner) { recallTile(pend); return; }
        const rack = [...game.humanRack];
        [rack[orig], rack[target]] = [rack[target], rack[orig]];
        owner.rackIndex = orig;
        pending = pending.filter(q => q !== pend);
        game.humanRack = rack; renderGame();
        api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) })
          .then(d => { game = d; gameFetchAt = Date.now(); renderGame(); })
          .catch(() => {});
        return;
      }
      // Occupied deck tile: insert like a rack reorder — the letter
      // moves to the hovered slot and the deck tiles between shift
      // sideways by one, exactly as when dragging from the deck.
      const rack = [...game.humanRack];
      const [letter] = rack.splice(orig, 1); rack.splice(target, 0, letter);
      pending.forEach(q => {
        if (q === pend) return;
        if (orig < target && q.rackIndex > orig && q.rackIndex <= target) q.rackIndex--;
        else if (orig > target && q.rackIndex < orig && q.rackIndex >= target) q.rackIndex++;
      });
      pending = pending.filter(q => q !== pend);
      game.humanRack = rack; renderGame();
      api(`/api/games/${game.id}/shuffle`, { method: 'POST', body: JSON.stringify({ rack }) })
        .then(d => { game = d; gameFetchAt = Date.now(); renderGame(); })
        .catch(() => {});
      return;
    }
    if (myDrop) { if (!canPlaceTiles()) return; pend.row = myDrop.row; pend.col = myDrop.col; renderGame(); }
  });
  el.addEventListener('pointercancel', () => cleanup());
  el.addEventListener('lostpointercapture', () => cleanup());
}


// ---------- Startup: sign-in is required before entering the app ----------
(async () => {
  if (!token) { setAuthMode('signin'); show('authScreen'); return; }
  // A login check that never answers must not leave the page black: if
  // /api/me takes over 10s, show Home anyway (the transient-error path).
  // The dummy catch keeps a late rejection from surfacing as unhandled.
  const meReq = api('/api/me');
  meReq.catch(() => {});
  try {
    const d = await Promise.race([meReq, new Promise(res => setTimeout(() => res(null), 10000))]);
    if (d) me = d.user;
  }
  catch (err) {
    // Only a rejected session bounces to auth; a transient network
    // failure still shows Home and lets the next call surface the error.
    if (err && err.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; setAuthMode('signin'); show('authScreen'); return; }
  }
  show('homeScreen');
})();

// ---------- Profile tab + real accounts ----------
// Identity, Elo, Elo history, and stats come from GET /api/me. Guests see
// their guest profile plus a sign-in button; signing up upgrades the guest
// row in place, so Elo and game history carry over.
let profileData = null, statsScope = 'aggregate', chartRange = '1m';
function formatJoined(createdAt) {
  const d = new Date(createdAt);
  return isNaN(d) ? createdAt : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}
// Numbers render Arial/Helvetica while words stay Comfortaa: wrap digit
// runs in .num spans (the .num rule already covers profile numbers).
function numify(s) { return String(s).replace(/\d+/g, d => `<span class="num">${d}</span>`); }
// Blank the profile screen to a silhouette with no name, Elo or
// stats. Called before the screen is shown (tab tap) as well as
// at the start of renderProfileUI: the old account's name and
// photo used to paint briefly after switching accounts, because
// show() ran before the blanking did.
function blankProfileUI() {
  $('profilePfp').innerHTML = silhouetteSVG(44); $('profilePfp').classList.add('no-photo');
  $('profileName').textContent = ''; $('profileUsername').textContent = ''; $('profileJoined').textContent = '';
  $('profileElo').textContent = ''; $('profileEloHigh').textContent = ''; $('profileGlobalRank').textContent = '';
  $('statsList').innerHTML = '';
  const chartCv = $('eloChart'); if (chartCv) chartCv.getContext('2d').clearRect(0, 0, chartCv.width, chartCv.height);
}
async function renderProfileUI(prefetched) {
  // Sign-in is required: no token, or a rejected session, goes to auth.
  if (!token) { setAuthMode('signin'); show('authScreen'); return; }
  blankProfileUI();
  // The background preload (preloadHomeTabs) passes the /api/me
  // payload it already fetched for the session check, so the profile
  // is not fetched twice at boot.
  let d = prefetched || null;
  try { if (!d) d = await api('/api/me'); }
  catch (err) {
    if (err && err.message === 'Not signed in.') { token = ''; storeDel('duello_token'); me = null; profileData = null; setAuthMode('signin'); show('authScreen'); }
    return;
  }
  profileData = d; me = d.user;
  const u = profileData.user;
  $('profilePfp').innerHTML = u.photoData ? `<img src="${u.photoData}" alt="">` : silhouetteSVG(44); $('profilePfp').classList.toggle('no-photo', !u.photoData);
  $('profileName').textContent = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
  $('profileUsername').textContent = '@' + u.username;
  $('profileJoined').innerHTML = 'Joined ' + numify(formatJoined(u.createdAt));
  $('profileElo').textContent = u.elo;
  $('profileEloHigh').textContent = u.eloHigh;
  // Global Rank sits above the chart with Elo and All-time high.
  // Show the cached rank at once when it is there (v75 cache), else
  // fetch it once and cache it, like the profile modal does.
  const cachedRank = rankCache.get(u.username);
  if (cachedRank != null) $('profileGlobalRank').textContent = cachedRank;
  else {
    $('profileGlobalRank').textContent = '—';
    api('/api/users/rank?username=' + encodeURIComponent(u.username)).then(d => { rankCache.set(u.username, d.rank); if (profileData && profileData.user && profileData.user.username === u.username) $('profileGlobalRank').textContent = d.rank; }).catch(() => {});
  }
  renderStatsList(); drawEloChart();
}
function fmt1(v) { return (Number(v) || 0).toFixed(1); }
function renderStatsList() {
  if (!profileData || !profileData.profileStats) return;
  const st = profileData.profileStats[statsScope] || profileData.profileStats.aggregate;
  const lines = [
    ['Average game score', st.avgGameScore], ['Highest game score', st.highestGameScore],
    ['Average word score', fmt1(st.avgWordScore)], ['Highest word score', st.highestWord ? `${st.highestWord} (${st.highestWordScore} pts)` : '—'],
    ['50+ point words', st.wordsOver50], ['100+ point words', st.wordsOver100],
    ['Lifetime bingos', st.bingos],
    ['Longest word', st.longestWord ? `${st.longestWord} (${st.longestWordLen} letters)` : '—'],
    ['Games played', st.gamesPlayed], ['Lifetime record', st.record || '0W-0L'],
    ['Optimal move %', fmt1(st.optimalPct) + '%'], ['Unique words played', st.uniqueWords],
  ];
  $('statsList').innerHTML = lines.map(([k, v]) => `<div class="stat-line"><span>${k}</span><b>${numify(v)}</b></div>`).join('');
}
function drawEloChart() {
  const cv = $('eloChart'); if (!cv || !profileData) return;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  let hist = (profileData.stats && profileData.stats.eloHistory) || [];
  const now = Date.now();
  if (chartRange === '1m') hist = hist.filter(h => now - new Date(h.created_at).getTime() < 30 * 24 * 3600 * 1000);
  if (chartRange === '1y') hist = hist.filter(h => now - new Date(h.created_at).getTime() < 365 * 24 * 3600 * 1000);
  const pts = [1000, ...hist.map(h => h.elo_after)];
  // A brand-new account has no history yet: draw a flat line at the
  // starting 1000 instead of a "no history" message.
  if (pts.length < 2) pts.push(1000);
  const min = Math.min(...pts) - 20, max = Math.max(...pts) + 20;
  ctx.strokeStyle = '#03eaff'; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((v, i) => { const x = 10 + i * (cv.width - 20) / (pts.length - 1); const y = cv.height - 10 - ((v - min) / (max - min)) * (cv.height - 20); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
}
$('tabProfile').onclick = () => { show('profileScreen'); if (!profileData) renderProfileUI(); };
document.querySelectorAll('.stats-tab').forEach(b => b.onclick = () => { statsScope = b.dataset.scope; document.querySelectorAll('.stats-tab').forEach(x => x.classList.toggle('active', x === b)); renderStatsList(); });
document.querySelectorAll('.chart-toggle').forEach(b => b.onclick = () => { chartRange = b.dataset.range; document.querySelectorAll('.chart-toggle').forEach(x => x.classList.toggle('active', x === b)); drawEloChart(); });
$('gearBtn').onclick = async () => {
  if (!profileData) await renderProfileUI();
  if (!profileData) return;
  const u = profileData.user;
  $('editFirstName').value = u.firstName; $('editLastName').value = u.lastName; $('editUsername').value = u.username; $('editEmail').value = u.email || ''; $('editError').textContent = '';
  editPhotoData = undefined;
  $('editPfp').innerHTML = u.photoData ? `<img src="${u.photoData}" alt="">` : silhouetteSVG(44); $('editPfp').classList.toggle('no-photo', !u.photoData);
  $('editPhotoRemoveBtn').classList.toggle('hidden', !u.photoData);
  $('editCurrentPassword').value = ''; $('editNewPassword').value = ''; $('editNewPassword2').value = '';
  $('editPasswordError').textContent = ''; $('editPasswordDone').textContent = '';
  $('editPasswordFields').classList.add('hidden'); renderPwReqs('editPwReqs', '');
  show('profileEditScreen');
};
let editPhotoData;
$('editPfpWrap').onclick = () => $('editPhotoInput').click();
// Photo crop (v92): after picking a photo, the user frames it in a
// circular viewport — drag to move, slider to zoom — before it is
// saved. Pfps display round everywhere, so the crop preview is what
// you get. Output is a 512x512 JPEG under the 750KB cap.
const CROP_SIZE = 280; // viewport px, matches .crop-viewport in CSS
let cropState = null; // {img, base, zoom, x, y}
function cropBaseScale(img) { return CROP_SIZE / Math.min(img.width, img.height); }
function cropClamp(s) {
  // Keep the image covering the square: the offset range is half the
  // overflow on each axis (0 when the image exactly fills it).
  const w = s.img.width * s.base * s.zoom, h = s.img.height * s.base * s.zoom;
  const mx = Math.max(0, (w - CROP_SIZE) / 2), my = Math.max(0, (h - CROP_SIZE) / 2);
  s.x = Math.max(-mx, Math.min(mx, s.x));
  s.y = Math.max(-my, Math.min(my, s.y));
}
function cropPaint() {
  const s = cropState; if (!s) return;
  const el = $('cropImg');
  el.style.width = (s.img.width * s.base * s.zoom) + 'px';
  el.style.height = (s.img.height * s.base * s.zoom) + 'px';
  el.style.transform = 'translate(calc(-50% + ' + s.x + 'px), calc(-50% + ' + s.y + 'px))';
}
function openCrop(img) {
  cropState = { img, base: cropBaseScale(img), zoom: 1, x: 0, y: 0 };
  $('cropImg').src = img.src;
  $('cropZoom').value = '1';
  cropPaint();
  $('cropModal').classList.remove('hidden');
}
function closeCrop() {
  $('cropModal').classList.add('hidden');
  cropState = null;
  $('editPhotoInput').value = ''; // same file picked again still fires
}
let cropDrag = null;
$('cropViewport').addEventListener('pointerdown', e => {
  if (!cropState) return;
  cropDrag = { px: e.clientX, py: e.clientY, x: cropState.x, y: cropState.y };
  try { $('cropViewport').setPointerCapture(e.pointerId); } catch {}
});
$('cropViewport').addEventListener('pointermove', e => {
  if (!cropDrag || !cropState) return;
  cropState.x = cropDrag.x + (e.clientX - cropDrag.px);
  cropState.y = cropDrag.y + (e.clientY - cropDrag.py);
  cropClamp(cropState); cropPaint();
});
$('cropViewport').addEventListener('pointerup', () => { cropDrag = null; });
$('cropViewport').addEventListener('pointercancel', () => { cropDrag = null; });
$('cropZoom').oninput = () => {
  if (!cropState) return;
  cropState.zoom = parseFloat($('cropZoom').value) || 1;
  cropClamp(cropState); cropPaint();
};
$('cropUseBtn').onclick = () => {
  const s = cropState; if (!s) return;
  // Map the viewport square back onto the source image: the image is
  // drawn at (base*zoom) scale, centred on the viewport plus (x, y).
  const scale = s.base * s.zoom;
  const w = s.img.width * scale, h = s.img.height * scale;
  const sx = (w / 2 - CROP_SIZE / 2 - s.x) / scale;
  const sy = (h / 2 - CROP_SIZE / 2 - s.y) / scale;
  const side = CROP_SIZE / scale;
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  cv.getContext('2d').drawImage(s.img, sx, sy, side, side, 0, 0, 512, 512);
  let data = cv.toDataURL('image/jpeg', 0.82);
  if (data.length > 750000) data = cv.toDataURL('image/jpeg', 0.7);
  if (data.length > 750000) { $('editError').textContent = 'That photo is too large. Pick a smaller one.'; return; }
  editPhotoData = data;
  $('editPfp').innerHTML = `<img src="${data}" alt="">`; $('editPfp').classList.remove('no-photo');
  $('editPhotoRemoveBtn').classList.remove('hidden');
  $('editError').textContent = '';
  closeCrop();
};
$('cropCancelBtn').onclick = () => closeCrop();
$('editPhotoInput').onchange = () => {
  const f = $('editPhotoInput').files && $('editPhotoInput').files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => openCrop(img);
    img.onerror = () => { $('editError').textContent = 'That photo could not be read. Try a different one.'; };
    img.src = String(rd.result || '');
  };
  rd.readAsDataURL(f);
};
$('editPhotoRemoveBtn').onclick = () => {
  editPhotoData = null;
  $('editPfp').innerHTML = silhouetteSVG(44); $('editPfp').classList.add('no-photo');
  $('editPhotoRemoveBtn').classList.add('hidden');
};
$('editCancelBtn').onclick = () => show('profileScreen');
$('profileEditForm').onsubmit = async e => {
  e.preventDefault();
  const fn = $('editFirstName').value.trim(), ln = $('editLastName').value.trim(), un = $('editUsername').value.trim(), em = $('editEmail').value.trim().toLowerCase();
  if (!fn) { $('editError').textContent = 'Add a first name.'; return; }
  if (!/^[a-z0-9_]{3,}$/.test(un)) { $('editError').textContent = 'Usernames are 3+ lowercase letters, numbers, or underscores.'; return; }
  if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { $('editError').textContent = 'Enter a valid email.'; return; }
  try {
    const body = { firstName: fn, lastName: ln, username: un };
    if (em) body.email = em;
    if (editPhotoData !== undefined) body.photoData = editPhotoData;
    const d = await api('/api/me/update', { method: 'POST', body: JSON.stringify(body) });
    me = d.user; profileData = null;
    show('profileScreen'); renderProfileUI();
  } catch (err) { $('editError').textContent = err.message || 'Could not save.'; }
};
$('editPasswordBtn').onclick = () => {
  // Reveal-only: the fields carry their own Save button, so there is
  // always an obvious submit instead of a second tap on this link.
  $('editPasswordFields').classList.remove('hidden');
  $('editCurrentPassword').focus();
};
$('editPasswordSaveBtn').onclick = async () => {
  $('editPasswordError').textContent = ''; $('editPasswordDone').textContent = '';
  const currentPassword = $('editCurrentPassword').value, newPassword = $('editNewPassword').value, newPassword2 = $('editNewPassword2').value;
  try {
    if (!pwPolicyOk(newPassword)) throw new Error('Password needs 8+ characters, a capital letter, a lowercase letter, and a number.');
    if (newPassword !== newPassword2) throw new Error('Passwords do not match.');
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    $('editCurrentPassword').value = ''; $('editNewPassword').value = ''; $('editNewPassword2').value = '';
    renderPwReqs('editPwReqs', '');
    $('editPasswordDone').textContent = 'Password changed.';
  } catch (err) { $('editPasswordError').textContent = err.message || 'Could not change password.'; }
};
// Eye toggles for every password field: tap to see what was typed.
// Delegated on the document (not wired per button at load) so the
// toggle works no matter when the field's screen is shown, and taps
// on the icon's SVG paths still land on the button. Grey eye = hidden,
// Duello blue eye = visible. No emoji anywhere in the toggle.
// The toggle runs on pointerdown, not click: on iOS a tap next to a
// focused password field can lose its click when the tap dismisses
// the keyboard and the layout shifts, but pointerdown fires at touch
// start, before any of that. preventDefault keeps focus in the field
// so the keyboard stays up. The click handler below is only a
// fallback for keyboard activation, guarded like the Play button so
// a pointerdown tap does not toggle twice.
function toggleEye(btn) {
  const inp = $(btn.dataset.target); if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}
let lastEyePointerAt = 0;
document.addEventListener('pointerdown', e => {
  const btn = e.target.closest ? e.target.closest('.pw-eye') : null;
  if (!btn) return;
  e.preventDefault();
  lastEyePointerAt = Date.now();
  toggleEye(btn);
});
document.addEventListener('click', e => {
  if (Date.now() - lastEyePointerAt < 1000) return;
  const btn = e.target.closest ? e.target.closest('.pw-eye') : null;
  if (!btn) return;
  toggleEye(btn);
});
// Password policy: 8+ characters with a capital, a lowercase, and a
// number. Shown live under every new-password field.
function pwPolicy(pw) {
  return { len: pw.length >= 8, upper: /[A-Z]/.test(pw), lower: /[a-z]/.test(pw), digit: /[0-9]/.test(pw) };
}
function pwPolicyOk(pw) { const r = pwPolicy(pw); return r.len && r.upper && r.lower && r.digit; }
function renderPwReqs(listId, pw) {
  const el = $(listId); if (!el) return;
  const r = pwPolicy(pw);
  el.querySelectorAll('li[data-req]').forEach(li => li.classList.toggle('met', !!r[li.dataset.req]));
}
[['suPassword', 'suPwReqs'], ['rpPassword', 'rpPwReqs'], ['editNewPassword', 'editPwReqs']].forEach(([inputId, listId]) => {
  const inp = $(inputId); if (inp) inp.addEventListener('input', () => renderPwReqs(listId, inp.value));
});
// Wipe every account-owned surface on sign-out (and account
// delete): the old account's rows, requests, search results and
// profile must never be what the next sign-in first sees.
function wipeAccountScreens() {
  blankProfileUI();
  pendingRemove = null;
  friendsStale = true; friendsRenderedScope = null;
  hideChallengeModal();
  $('leaderboardList').innerHTML = '';
  $('friendRequests').innerHTML = '';
  $('challengeRequests').innerHTML = '';
  $('friendSearchResults').innerHTML = '';
  $('friendSearch').value = '';
  $('noFriendsCard').classList.add('hidden');
}
$('profileSignOutBtn').onclick = async () => {
  try { await api('/api/signout', { method: 'POST' }); } catch {}
  token = ''; storeDel('duello_token'); me = null; profileData = null;
  wipeAccountScreens();
  setAuthMode('signin'); show('authScreen');
};
$('editDeleteBtn').onclick = () => {
  $('editDeleteConfirm').classList.remove('hidden');
  $('editDeleteError').textContent = '';
};
$('editDeleteCancelBtn').onclick = () => {
  $('editDeleteConfirm').classList.add('hidden');
};
$('editDeleteConfirmBtn').onclick = async () => {
  try {
    await api('/api/me/delete', { method: 'POST' });
  } catch (err) { $('editDeleteError').textContent = err.message || 'Could not delete account.'; return; }
  token = ''; storeDel('duello_token'); me = null; profileData = null; game = null;
  wipeAccountScreens();
  $('editDeleteConfirm').classList.add('hidden');
  setAuthMode('signin'); show('authScreen');
};
let suEmail = '', suVerifiedToken = '';
function setAuthMode(mode) {
  authMode = mode;
  $('authHeading').textContent = mode === 'signup' ? 'Sign up' : mode === 'reset' ? 'Reset password' : 'Sign in';
  $('authForm').classList.toggle('hidden', mode !== 'signin');
  $('signupSteps').classList.toggle('hidden', mode !== 'signup');
  $('resetSteps').classList.toggle('hidden', mode !== 'reset');
  $('authToggleBtn').textContent = mode === 'signup' ? 'Already have an account? Sign in' : mode === 'reset' ? 'Back to sign in' : 'Need an account? Sign up';
  $('authError').textContent = ''; $('authSuccess').textContent = '';
  if (mode === 'signup') showSignupStep('email');
  if (mode === 'reset') showResetStep('email');
}
function showSignupStep(step) {
  ['Email', 'Code', 'Profile'].forEach(s => $('signupStep' + s).classList.toggle('hidden', s.toLowerCase() !== step));
  ['suError', 'suError2', 'suError3'].forEach(id => { $(id).textContent = ''; });
  if (step === 'email') $('suSentMsg').textContent = '';
  if (step === 'profile') renderPwReqs('suPwReqs', $('suPassword').value || '');
}
$('authToggleBtn').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
$('authForm').onsubmit = async e => {
  e.preventDefault(); $('authError').textContent = ''; $('authSuccess').textContent = '';
  const email = $('authEmail').value.trim(), password = $('authPassword').value;
  try {
    const d = await api('/api/signin', { method: 'POST', body: JSON.stringify({ email, password }) });
    token = d.token; storeSet('duello_token', token); me = d.user; profileData = null;
    show('homeScreen');
  } catch (err) { $('authError').textContent = err.message || 'Something went wrong.'; }
};
$('suSendBtn').onclick = async () => {
  $('suError').textContent = '';
  suEmail = $('suEmail').value.trim();
  try {
    await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email: suEmail }) });
    showSignupStep('code');
    $('suSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('suError').textContent = err.message || 'Something went wrong.'; }
};
$('suResendBtn').onclick = async () => {
  $('suError2').textContent = '';
  try {
    await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email: suEmail }) });
    $('suSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('suError2').textContent = err.message || 'Something went wrong.'; }
};
$('suBackBtn').onclick = () => showSignupStep('email');
$('suVerifyBtn').onclick = async () => {
  $('suError2').textContent = '';
  const code = $('suCode').value.trim();
  try {
    const d = await api('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email: suEmail, code }) });
    suVerifiedToken = d.verifiedToken;
    showSignupStep('profile');
  } catch (err) { $('suError2').textContent = err.message || 'Something went wrong.'; }
};
$('suCreateBtn').onclick = async () => {
  $('suError3').textContent = '';
  const firstName = $('suFirstName').value.trim(), lastName = $('suLastName').value.trim(), username = $('suUsername').value.trim(), password = $('suPassword').value;
  try {
    if (!firstName || !lastName) throw new Error('First and last name are required.');
    if (!/^[a-z0-9_]{3,}$/.test(username)) throw new Error('Username: lowercase letters, numbers, and underscores only, at least 3 characters.');
    if (!pwPolicyOk(password)) throw new Error('Password needs 8+ characters, a capital letter, a lowercase letter, and a number.');
    const d = await api('/api/signup', { method: 'POST', body: JSON.stringify({ firstName, lastName, username, email: suEmail, password, verifiedToken: suVerifiedToken }) });
    token = d.token; storeSet('duello_token', token); me = d.user; profileData = null;
    show('homeScreen');
  } catch (err) { $('suError3').textContent = err.message || 'Something went wrong.'; }
};
let rpEmail = '', rpVerifiedToken = '';
function showResetStep(step) {
  ['Email', 'Code', 'Password'].forEach(s => $('resetStep' + s).classList.toggle('hidden', s.toLowerCase() !== step));
  ['rpError', 'rpError2', 'rpError3'].forEach(id => { $(id).textContent = ''; });
  if (step === 'email') $('rpSentMsg').textContent = '';
  if (step === 'password') renderPwReqs('rpPwReqs', $('rpPassword').value || '');
}
$('forgotPasswordBtn').onclick = () => setAuthMode('reset');
$('rpSendBtn').onclick = async () => {
  $('rpError').textContent = '';
  rpEmail = $('rpEmail').value.trim();
  try {
    await api('/api/auth/request-reset', { method: 'POST', body: JSON.stringify({ email: rpEmail }) });
    showResetStep('code');
    $('rpSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('rpError').textContent = err.message || 'Something went wrong.'; }
};
$('rpResendBtn').onclick = async () => {
  $('rpError2').textContent = '';
  try {
    await api('/api/auth/request-reset', { method: 'POST', body: JSON.stringify({ email: rpEmail }) });
    $('rpSentMsg').textContent = 'A code was sent to your email.';
  } catch (err) { $('rpError2').textContent = err.message || 'Something went wrong.'; }
};
$('rpBackBtn').onclick = () => showResetStep('email');
$('rpVerifyBtn').onclick = async () => {
  $('rpError2').textContent = '';
  const code = $('rpCode').value.trim();
  try {
    const d = await api('/api/auth/verify-reset-code', { method: 'POST', body: JSON.stringify({ email: rpEmail, code }) });
    rpVerifiedToken = d.verifiedToken;
    showResetStep('password');
  } catch (err) { $('rpError2').textContent = err.message || 'Something went wrong.'; }
};
$('rpResetBtn').onclick = async () => {
  $('rpError3').textContent = '';
  const password = $('rpPassword').value, password2 = $('rpPassword2').value;
  try {
    if (!pwPolicyOk(password)) throw new Error('Password needs 8+ characters, a capital letter, a lowercase letter, and a number.');
    if (password !== password2) throw new Error('Passwords do not match.');
    await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email: rpEmail, password, verifiedToken: rpVerifiedToken }) });
    rpVerifiedToken = '';
    $('rpPassword').value = ''; $('rpPassword2').value = ''; $('rpCode').value = '';
    renderPwReqs('rpPwReqs', '');
    setAuthMode('signin');
    $('authSuccess').textContent = 'Password has been reset, please log in.';
  } catch (err) { $('rpError3').textContent = err.message || 'Something went wrong.'; }
};
