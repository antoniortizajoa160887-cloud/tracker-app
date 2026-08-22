// Service worker for the Tracker app.
//
// Job of this file, in full — nothing more:
//   1. Cache the app shell (this page, the manifest, the icons) once at
//      install time.
//   2. Serve every same-origin GET request network-first: always try the
//      live network first and keep the cache updated with whatever comes
//      back; only fall back to the cached copy if the network request
//      genuinely fails (offline, DNS failure, server unreachable).
//   3. Only ever touch same-origin GET requests. Supabase API calls,
//      CDN-loaded libraries (xlsx, Supabase JS, Google Fonts), and any
//      other cross-origin request pass straight through, completely
//      untouched by this file.
//
// This app depends on a live Supabase connection for its actual data, so
// there is no real offline functionality to build here — this file exists
// only so (a) "Add to Home Screen" / "Install app" works on Chrome/Edge,
// which requires a registered service worker with a fetch handler, and
// (b) the page has something to show if the network briefly drops,
// instead of a blank error screen.
//
// Deliberately NOT here: any touch/scroll handling of any kind (a service
// worker runs in a separate background thread and has no access to the
// DOM or touch events at all — it is structurally incapable of affecting
// scrolling), any URL rewriting, any query-string cache-busting, any
// per-file special-casing. Every one of those has been the source of a
// real bug in an earlier version of this file. This version does the
// least it can while still doing its job correctly.
//
// IMPORTANT: bump CACHE_NAME on any future edit to this file. Browsers
// compare sw.js byte-for-byte on each visit and only run install/activate
// again (below) when the file itself has changed — without a version
// bump, a device that already has an old copy of this file installed
// will keep running it indefinitely.

const CACHE_NAME = 'tracker-shell-v59';
const SHELL_URLS = [
    './',
    './index.html',
    './styles.css',
    './js/00-core.js',
    './js/10-auth.js',
    './js/20-employees-claims.js',
    './js/30-attach-import-deposit.js',
    './js/40-income-provider.js',
    './js/50-messages.js',
    './js/60-i18n-sessions.js',
    './js/70-financial-init.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_URLS))
            .catch(() => {}) // never let one missing/failed asset block install
    );
    self.skipWaiting(); // don't wait for old tabs to close before taking over
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
            ))
            .then(() => self.clients.claim()) // control already-open tabs immediately
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // writes are never cacheable — leave untouched

    const url = new URL(req.url);
    // Only ever touch real http(s) requests. A blob:/data:/filesystem: URL has
    // the app's own origin, so it would otherwise slip past the cross-origin
    // check below and be intercepted — but a service worker can't fetch a
    // blob: URL created in a page (different agent), which breaks it. The
    // in-app file viewer renders photos/videos/PDFs from blob: URLs, so this
    // guard is what lets them load. Leave every non-http(s) scheme untouched.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.origin !== self.location.origin) return; // cross-origin: leave untouched

    event.respondWith(
        fetch(req)
            .then((res) => {
                // Only cache genuinely successful, basic (same-origin) responses.
                if (res && res.ok && res.type === 'basic') {
                    const resClone = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
                }
                return res;
            })
            .catch(() =>
                caches.match(req).then((cached) => {
                    if (cached) return cached;
                    // Only fall back to the shell for page navigations — never
                    // serve HTML in place of a failed CSS/JS/image request.
                    if (req.mode === 'navigate') return caches.match('./index.html');
                    return Response.error();
                })
            )
    );
});
