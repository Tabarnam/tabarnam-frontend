// v3: bumped so `activate` purges v2, which may hold cached /xapi/ API
// responses — see the exclusion below. v2 was itself a bump to clear a stale
// /.auth/me ("clientPrincipal: null" made valid sessions look signed-out).
const STATIC_CACHE = "tabarnam-static-v3";
const RUNTIME_CACHE = "tabarnam-runtime-v3";
const APP_SHELL = ["/", "/manifest.json", "/tabarnam-icon.png", "/pwa/icon-192.png", "/pwa/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![STATIC_CACHE, RUNTIME_CACHE].includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // /xapi/* is NOT a separate surface — staticwebapp.config.json rewrites it to
  // /api/{*path}, and src/lib/api.ts retries through it whenever a direct /api/
  // call hits a network error. Excluding only /api/ meant every fallback API
  // response was cached cache-first and replayed forever: stale admin data,
  // served precisely when things were already going wrong.
  if (url.pathname.startsWith("/xapi/")) return;
  // NEVER touch the auth endpoints. /.auth/me is a same-origin GET, so without
  // this it fell into the cache-first branch below and got cache.put() — after
  // which the SW served a stale "clientPrincipal: null" forever, making a valid
  // session look permanently signed-out. A service worker intercepts BEFORE the
  // HTTP cache, so `cache: 'no-store'` on the fetch cannot save us here; the
  // request must bypass the SW entirely.
  if (url.pathname.startsWith("/.auth/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match("/");
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          // Only cache real successes. A 404 for a hashed chunk means the build
          // it belonged to has been replaced; caching that would make a
          // temporary miss permanent.
          if (!response || response.status !== 200 || response.type !== "basic") return response;
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
    )
  );
});
