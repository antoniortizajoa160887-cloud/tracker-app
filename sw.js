// Service worker for the Tracker app.
// Goal: make the app installable and load instantly on repeat visits,
// WITHOUT ever serving stale business data — this app is only useful with
// a live connection to Supabase, so data requests always go to the
// network, never the cache. Only the app shell (this HTML file itself)
// gets cached, and even that uses network-first so a real update is never
// hidden behind an old cached copy.

const CACHE_NAME = 'tracker-shell-v2';
const SHELL_URLS = ['./', './index.html'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return; // never touch writes

    const url = new URL(req.url);
    // Never cache or intercept anything that isn't this same site's own
    // shell — Supabase API calls, the CDN-loaded libraries, etc. all go
    // straight to the network untouched.
    if (url.origin !== self.location.origin) return;

    // 'reload' forces the browser past its own HTTP cache for this request,
    // straight to the real network — without it, "network-first" wasn't a
    // real guarantee: the browser's ordinary HTTP cache could quietly hand
    // back an old cached response for something like index.html before this
    // handler ever got a say, especially on a host that doesn't send strict
    // no-cache headers for HTML. That's the most likely reason the app shell
    // can go stale specifically on the installed icon (which reuses the same
    // long-lived process/cache) while a fresh browser tab always looks fine.
    event.respondWith(
        fetch(req, { cache: 'reload' })
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
                return res;
            })
            .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
});
