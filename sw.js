// ================================================================
// sw.js — EasyBill Service Worker
//
// Purpose: eliminate the "stuck on old cached version" problem while
// keeping the app usable offline.
//
// Strategy:
//  - The HTML app shell (navigations / document requests) is always
//    fetched NETWORK-FIRST with cache: 'no-store', so a fresh deploy is
//    picked up immediately. We fall back to the cached copy only if the
//    network request genuinely fails (offline).
//  - Same-origin static assets (manifest.json, icons, etc.) are served
//    CACHE-FIRST. This is safe for files whose URLs change when their
//    content changes (hashed filenames from a real build step). Until
//    this project has hashed filenames, keep this list limited to files
//    that rarely change, or rely on the hosting Cache-Control headers
//    (see firebase.json) to keep max-age short for unhashed JS/CSS.
//  - Cross-origin requests (Firebase SDK, CDNs, WhatsApp links, etc.)
//    are never intercepted — they pass straight through to the network.
//  - SW_VERSION is templated by deploy.sh on every deploy. Bumping it
//    changes CACHE_NAME, which causes `activate` to delete every old
//    cache automatically — no manual cache-busting needed.
// ================================================================

const SW_VERSION = '__APP_VERSION__';
const CACHE_NAME = `easybill-cache-${SW_VERSION}`;

// Keep this list to genuinely static files. Do NOT add index.html here —
// it must always go through the network-first path above.
const PRECACHE_ASSETS = [
  './manifest.json',
];

self.addEventListener('install', (event) => {
  // Activate this new SW as soon as it finishes installing, instead of
  // waiting for all open tabs of the old version to close.
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .catch((err) => console.warn('SW precache failed (non-fatal):', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Purge every cache that isn't this version's — this is what
      // actually clears out stale, previously-deployed assets from
      // users' browsers without any manual action on their part.
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      // Start controlling any already-open tabs immediately.
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin requests; let everything else (Firebase,
  // Firestore, CDN scripts, WhatsApp, Google Fonts, etc.) go straight to
  // the network untouched.
  if (url.origin !== self.location.origin) return;

  const isHTMLNavigation =
    request.mode === 'navigate' || request.destination === 'document';

  if (isHTMLNavigation) {
    event.respondWith(networkFirstForHTML(request));
    return;
  }

  event.respondWith(cacheFirstForStaticAsset(request));
});

async function networkFirstForHTML(request) {
  try {
    const networkResponse = await fetch(request, { cache: 'no-store' });
    // Keep a copy for offline fallback, but it is never served unless
    // the network genuinely fails.
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, networkResponse.clone());
    return networkResponse;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // No network and nothing cached — surface a minimal offline response
    // rather than an opaque browser error.
    return new Response(
      '<h1>Offline</h1><p>EasyBill could not load. Please check your connection.</p>',
      { headers: { 'Content-Type': 'text/html' }, status: 503 }
    );
  }
}

async function cacheFirstForStaticAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, networkResponse.clone());
    return networkResponse;
  } catch (err) {
    // Static asset unavailable both in cache and network — let the
    // browser surface its normal network error for this resource.
    throw err;
  }
}

// Allows the page to force this waiting worker to activate immediately
// (used by the "Update Now" banner button in index.html).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});