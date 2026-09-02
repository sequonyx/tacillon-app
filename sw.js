/* LT v0.1 service worker — offline app shell.
   Strategy: pre-cache the shell; cache-first for shell assets;
   video clips are NETWORK ONLY (too large to pre-cache; brief allows it). */

const CACHE_NAME = 'tacillon-shell-v36';

/* The core shell. Cached atomically: if any of these fails, the new worker
   does not install and the old one keeps serving. */
const SHELL = [
  './',
  './css/app.css',
  './js/app.js',
  './js/backend.js',
  './js/sync.js',
  './js/builder.js',
  './js/vendor/supabase.js',
  './js/vendor/qrcode.js',
  './js/manual.js',
  './js/publish.js',
  './js/ledger.js',
  './js/speech.js',
  './js/gates.js',
  './js/closure.js',
  './js/scan.js',
  './js/severity.js',
  './js/session.js',
  './js/review.js',
  './js/terms.js',
  './kc/pool-cleaning.json',
  './manifest.webmanifest',
  './img/t-logo.jpg',
  './fonts/jura-500.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

/* Pages the host may answer with a redirect. Cloudflare Pages serves clean
   URLs: /index.html and /legal/terms.html are 308-redirected to / and
   /legal/terms. A cached *redirected* response can never be used to answer a
   page navigation (the browser rejects it as a network error — that was the
   "dead link" of 2026-09-01, v0.13.0), so these are cached best-effort and
   only when the response came back directly, not via a redirect. Missing them
   costs nothing: none is needed offline. */
const OPTIONAL = [
  './index.html',
  './legal/terms.html',
  './legal/privacy.html'
];

async function cacheOptional(cache) {
  await Promise.all(OPTIONAL.map(async (url) => {
    try {
      const res = await fetch(url);
      if (res.ok && !res.redirected) await cache.put(url, res);
    } catch { /* offline or missing — skip */ }
  }));
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(SHELL).then(() => cacheOptional(c)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Supabase (auth, database, video storage): network only, never cached here.
  if (url.origin !== self.location.origin) return;

  // Videos: pass straight to network (supports range requests for seeking).
  if (url.pathname.includes('/clips/')) return;

  if (e.request.method !== 'GET') return;

  const isNavigation = e.request.mode === 'navigate';

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      /* A redirected response must never answer a navigation — see OPTIONAL. */
      if (hit && !(isNavigation && hit.redirected)) return hit;
      return fetch(e.request).then((res) => {
        // Cache same-origin direct successful responses so updates self-heal.
        // Redirected responses are not stored: the follow-up request for the
        // final URL will be cached on its own.
        if (res.ok && !res.redirected && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
