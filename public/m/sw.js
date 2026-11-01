/* Tri-Health Live Desk PWA — network-first for live data; cache only static chrome */
const CACHE = "livedesk-m-v1";
const PRECACHE = [
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isLiveRequest(url) {
  const path = url.pathname;
  // Never serve stale app shell or JSON/price responses from cache
  if (path.endsWith("/m/") || path.endsWith("/m/index.html") || path.endsWith("index.html")) return true;
  if (path.endsWith(".json")) return true;
  if (path.includes("positions.json") || path.includes("scan.json") || path.includes("version.json")) return true;
  const host = url.hostname;
  if (host.includes("binance") || host.includes("crypto.com") || host.includes("coingecko") || host.includes("er-api.com") || host.includes("coinbase")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  if (isLiveRequest(url)) {
    // Network-only / network-first with no cache write for live payloads
    event.respondWith(
      fetch(req, { cache: "no-store" }).catch(() =>
        // Only for index.html: last-resort empty fail; do not invent JSON
        (url.pathname.endsWith("index.html") || url.pathname.endsWith("/m/") || url.pathname.endsWith("/m"))
          ? caches.match("./index.html").then((r) => r || Response.error())
          : Response.error()
      )
    );
    return;
  }

  // Icons / manifest: cache-first
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }))
  );
});
