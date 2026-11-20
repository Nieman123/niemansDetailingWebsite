const CACHE = "detailing-admin-shell-v2";
const OFFLINE = "/admin/appointment-offline.html";
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("detailing-admin-shell-") && key !== CACHE)
    .map(key => caches.delete(key)))));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.mode !== "navigate" || url.origin !== self.location.origin ||
      !["/admin/appointments", "/admin/appointments.html"].includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => await caches.match(OFFLINE) || Response.error()));
});
