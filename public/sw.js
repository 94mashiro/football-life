// Runtime-cache service worker — makes the installed PWA actually work offline
// and repeat visits load from disk. No precache manifest on purpose: hashed
// /assets/* and /img/* art are cached as they are first fetched.
//
//   navigations  → network-first (a deploy is picked up immediately when
//                  online), cached shell as offline fallback
//   /assets/*    → cache-first (content-hashed, immutable)
//   /img/*       → stale-while-revalidate (stable art, rare replacements)
//   /api/*       → never touched (leaderboard must stay live)
//
// ponytail: old hashed bundles accumulate across deploys (~1MB each); browser
// storage eviction handles it. Add hash-aware cleanup if it ever matters.
const CACHE = "pitch-reincarnation-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchAndCache(req) {
  return fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetchAndCache(req).catch(() => caches.match(req)));
  } else if (url.pathname.includes("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetchAndCache(req)));
  } else if (url.pathname.includes("/img/")) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetchAndCache(req).catch(() => hit);
        return hit ?? net;
      })
    );
  }
});
