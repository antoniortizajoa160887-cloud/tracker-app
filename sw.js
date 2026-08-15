// Service worker for the Tracker app.
//
// Rebuilt from scratch (previous version had accumulated three rounds of
// bug fixes trying to be clever about cache-busting and per-request
// caching — that complexity was itself the source of repeated breakage,
// including a real crash on installed Android home-screen icons). This
// version deliberately does the least possible: cache the app shell once
// at install time, serve network-first with that cached copy as a
// fallback only when the network genuinely fails (offline, or Netlify
// unreachable). Nothing here rewrites URLs, adds query parameters, or
// clones/re-caches on every single fetch — those were exactly the
// mechanisms that broke before.
//
// This app is entirely dependent on a live Supabase connection anyway —
// there's no real offline functionality to preserve — so the only jobs
// of this file are: (1) satisfy Chrome's installability requirement (a
// registered service worker with a fetch handler) so "Add to Home
// Screen" / "Install app" works properly on Android, and (2) give a
// same-origin fallback if the network is briefly unavailable.
//
// IMPORTANT: bump CACHE_NAME on any future change to this file. That's
// what actually triggers the update lifecycle (browsers check sw.js for
// byte-for-byte changes periodically) — without it, an already-installed
// user's old, possibly-buggy service worker can keep running indefinitely.

const CACHE_NAME = 'tracker-shell-v4';
const SHELL_URLS = ['./', './index.html'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_URLS))
            .catch(() => {}) // never block install on a caching failure
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // never touch writes — those aren't cacheable requests anyway

    const url = new URL(req.url);
    // Only ever handle this same site's own shell. Supabase API calls,
    // CDN-loaded libraries (xlsx, etc.), and everything else cross-origin
    // goes straight to the network completely untouched by this file.
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(req).catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
});
