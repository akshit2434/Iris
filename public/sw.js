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

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const url = threadId ? `/chat/${encodeURIComponent(threadId)}${messageId ? `#message-${encodeURIComponent(messageId)}` : ""}` : "/";
  event.waitUntil(self.registration.showNotification(typeof payload.title === "string" ? payload.title : "Iris", {
    body: typeof payload.body === "string" ? payload.body : "You have a follow-up.",
    tag: typeof payload.tag === "string" ? payload.tag : "iris-follow-up",
    data: { url },
    silent: payload.silent === true,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && typeof event.notification.data.url === "string" ? event.notification.data.url : "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus().then(() => existing.navigate(target));
    return self.clients.openWindow(target);
  }));
});
