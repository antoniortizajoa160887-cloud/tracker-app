// Same "always try live, fall back to cache" philosophy as the Windows/
// Android/iOS wrapper apps: network-first for the app shell, only serving
// the cached copy when the network request actually fails (offline, or the
// host is unreachable) -- not a stale-while-revalidate cache that could show
// old content while a newer one is available.
const CACHE_NAME = "ulhr-dashboard-v1";
const APP_SHELL = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  // Only handle same-origin app-shell requests -- Supabase API calls and the
  // jsdelivr CDN scripts go straight to the network, untouched by this cache.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
