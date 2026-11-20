// Duello service worker (v107) — web only. Never registered under Capacitor
// (the iOS shell is bundled; index.html guards registration with a
// window.Capacitor check). No build step, no Workbox.
//
// Cache-first (keyed by FULL URL, query string included, so a ?v=N bump
// naturally fetches new files):
//   '/', '/app.js?v=N', '/engine.js?v=N', '/style.css?v=N',
//   '/engine-worker.js?v=N' (v107 solver worker — cached on first fetch,
//   not precached), '/assets/*', '/privacy.html', GET /api/words,
//   '/definitions/*' (v115 client definitions bundle — cached on first
//   fetch, so definitions work offline on the web after the first tap).
// Network-only (never cached, passed straight through):
//   every other /api/* path (/api/games/*, /api/me, /api/leaderboard,
//   /api/friends, auth endpoints) and all cross-origin requests.
//
// Updates: NO skipWaiting, NO clients.claim. A new worker installs in the
// background and only takes over on the next navigation, after the old
// worker's clients are gone — a deploy never swaps the JS under a game in
// progress (the ?v=N scheme already protects the loaded page; this
// preserves that). Old caches are deleted on activate.
'use strict';

var CACHE_NAME = 'duello-v150';

// Precached on install (small shell only). /api/words is deliberately NOT
// precached — it is a 1.2 MB lazy fetch, cached on first use (see below).
var PRECACHE_URLS = [
  '/',
  '/app.js?v=109',
  '/engine.js?v=109',
  '/style.css?v=109',
  '/privacy.html'
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isCacheableShell(url) {
  // App shell, keyed by full URL including query string.
  if (url.pathname === '/') return true;
  if (url.pathname === '/app.js') return true;
  if (url.pathname === '/engine.js') return true;
  if (url.pathname === '/engine-worker.js') return true;
  if (url.pathname === '/style.css') return true;
  if (url.pathname === '/privacy.html') return true;
  if (url.pathname === '/api/words') return true;
  if (url.pathname === '/daily-puzzles.json') return true; // v142: cached on first fetch, so the puzzle works offline after the first load
  if (url.pathname.indexOf('/assets/') === 0) return true;
  if (url.pathname.indexOf('/definitions/') === 0) return true;
  return false;
}

function isApiPath(url) {
  return url.pathname === '/api/words' || url.pathname.indexOf('/api/') === 0;
}

self.addEventListener('install', function (event) {
  // Install in the background; do NOT skipWaiting (see header).
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Add one by one so a single failed asset cannot fail the install.
      return Promise.all(PRECACHE_URLS.map(function (url) {
        return cache.add(url).catch(function () { /* best-effort */ });
      }));
    })
  );
});

self.addEventListener('activate', function (event) {
  // Delete caches from older versions; do NOT clients.claim (see header).
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
        return undefined;
      }));
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Only GETs are ever cached. Everything else passes through untouched.
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // Cross-origin (e.g. Google Fonts) — never cached, pass through.
  if (!isSameOrigin(url)) return;

  // Live API (everything except the dictionary) — network-only, never
  // cached, never served stale. When offline these fail and the app uses
  // the local engine instead.
  if (isApiPath(url) && url.pathname !== '/api/words') return;

  // Cache-first for the app shell + the dictionary.
  if (isCacheableShell(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(request).then(function (cached) {
          if (cached) return cached;
          return fetch(request).then(function (response) {
            // Cache only successful responses; never cache an error page
            // or a stale/errored dictionary.
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          });
        });
      })
    );
    return;
  }

  // Anything else same-origin (e.g. /favicon.ico): pass through to the
  // network, uncached.
});
