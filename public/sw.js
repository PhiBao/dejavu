/* Minimal service worker: installable PWA, network-first, no stale app shell. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  // Network-first; fall back to the cached capture shell when offline.
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open("dejavu-shell-v1");
      const cached = await cache.match("/capture");
      return cached || new Response("Offline", { status: 503 });
    }),
  );
});
