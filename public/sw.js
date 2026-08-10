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
// v2: v1 里可能存着被 SPA 兜底毒死的条目（asset URL 下存的是 index.html），
// activate 时按名字清掉旧 cache 正好把它们一起扫走。
const CACHE = "pitch-reincarnation-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cachePut(req, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

function fetchAndCache(req) {
  return fetch(req).then((res) => cachePut(req, res));
}

// 带哈希的 asset 永远不该解析成 HTML。历史上会：缺失的 /assets/* 命中 SPA 兜底
// （200 text/html），_headers 又给它盖 immutable 一年——一次坏请求就把浏览器
// HTTP 缓存毒死，白屏黏住不走。这里绕开 HTTP 缓存重试一次自愈，且绝不把 HTML
// 存进 asset URL。
function fetchAsset(req) {
  return fetch(req).then((res) =>
    (res.headers.get("content-type") || "").includes("text/html")
      ? fetch(req, { cache: "reload" })
      : cachePut(req, res)
  );
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes("/api/")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetchAndCache(req).catch(() => caches.match(req)));
  } else if (url.pathname.includes("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetchAsset(req)));
  } else if (url.pathname.includes("/img/")) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetchAndCache(req).catch(() => hit);
        return hit ?? net;
      })
    );
  }
});
