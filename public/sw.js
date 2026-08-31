/* global self, caches, Response */

const CACHE_NAME = "iris-static-v1";
const PRECACHE_URLS = [
  "/icons/iris-192.png",
  "/icons/iris-512.png",
  "/brand/iris-mark.webp",
];

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname === "/manifest.webmanifest" ||
      url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname.startsWith("/brand/"))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("iris-static-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (!isStaticAsset(url)) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) void cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached ?? Response.error());

      return cached ?? network;
    }),
  );
});
