/* Daily Brief service worker — 오프라인에서도 마지막 브리핑을 볼 수 있게 한다. */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;
const DATA = "data"; // 버전과 무관하게 유지: 업데이트 후에도 마지막 브리핑 보존

const scope = self.registration.scope;
const SHELL_URLS = ["./", "./index.html", "./manifest.json", "./icons/icon-192.png", "./icons/apple-touch-icon.png", "./icons/icon.svg"]
  .map((u) => new URL(u, scope).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      await shell.addAll(SHELL_URLS);
      // 첫 설치 때 최신 브리핑도 미리 받아둠 (실패해도 설치는 계속)
      const data = await caches.open(DATA);
      await Promise.allSettled(["./data/latest.json", "./data/index.json"].map((u) => data.add(new URL(u, scope).href)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, RUNTIME, DATA]);
      for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request, { cache: "no-cache" });
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(request, { ignoreSearch: true })) || (fallbackUrl && (await caches.match(fallbackUrl)));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") (await caches.open(RUNTIME)).put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, SHELL, new URL("./index.html", scope).href));
    return;
  }
  if (url.origin === location.origin && url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    event.respondWith(networkFirst(req, DATA));
    return;
  }
  // 해시가 붙은 빌드 자산, 아이콘, Pretendard 웹폰트(CDN)
  if (url.origin === location.origin || url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(cacheFirst(req));
  }
});
