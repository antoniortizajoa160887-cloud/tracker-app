// Service worker for the Tracker app.
// Goal: make the app installable and load instantly on repeat visits,
// WITHOUT ever serving stale business data — this app is only useful with
// a live connection to Supabase, so data requests always go to the
// network, never the cache. Only the app shell (this HTML file itself)
// gets cached, and even that uses network-first so a real update is never
// hidden behind an old cached copy.

const CACHE_NAME = 'tracker-shell-v3';
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

    event.respondWith((async () => {
        try {
            // Force a real network round-trip past both the browser's HTTP
            // cache and any CDN edge cache — WITHOUT calling
            // fetch(req, { cache: 'reload' }). That combination (a second
            // options argument alongside the original navigation Request
            // object) throws on some Android WebView/Chrome builds, because
            // a navigation request's mode is 'navigate', and re-fetching a
            // 'navigate'-mode Request with an overridden option is invalid
            // per the fetch spec on those builds. That throw happened
            // synchronously, before the .catch() fallback ever got a
            // chance to run, so EVERY page load through an already-active
            // service worker (i.e. the installed home-screen icon, which
            // is controlled by the service worker from the moment it
            // opens) failed outright with a browser-level network error —
            // while a brand-new browser tab looked fine, because a
            // first-ever visit's very first navigation never passes
            // through this handler at all (a service worker can't
            // intercept the request that first installs it).
            // Fetching a plain cache-busted URL string instead of the
            // Request object sidesteps this entirely.
            const bustUrl = new URL(url);
            bustUrl.searchParams.set('_sw', Date.now().toString());
            const res = await fetch(bustUrl.toString(), { credentials: 'same-origin' });
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
            return res;
        } catch (err) {
            const cached = await caches.match(req);
            return cached || (await caches.match('./index.html')) || Response.error();
        }
    })());
});
