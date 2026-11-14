/* Vitual XRing 12.1.1 — page cache / offline shell */
const CACHE_NAME = "xring-v12.1.1-login402";
const CORE = [
    "./",
    "index.html",
    "settings.html",
    "shop.html",
    "vord.html",
    "vpan.html",
    "events.json",
    "xos.html",
    "manager.html",
    "login.html",
    "vitualgit.html",
    "vuolingo.html",
    "offline.html",
    "vtx-theme.css",
    "vtx-theme.js",
    "vtx-bgm.js",
    "vtx-theme.css?v=12.1.1",
    "vtx-theme.js?v=12.1.1",
    "vtx-api.js",
    "vtx-pwa.js",
    "vtx-pwa.js?v=12.1.1",
    "XRingLogo.png"
];

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.allSettled(CORE.map((url) => cache.add(new Request(url, { cache: "reload" }))));
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("xring-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener("message", (event) => {
    if (event.data === "SKIP_WAITING") self.skipWaiting();
});

async function networkAndCache(request) {
    const response = await fetch(request);
    /* 12.1.1：206 Partial Content（音频 / 视频 Range）不能写进 Cache API，
       否则 cache.put 会抛错，播放器会收到一个 504 空响应而卡在 0 秒。 */
    if (response && response.ok && response.status === 200) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
    }
    return response;
}

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/api/") || url.pathname.endsWith("/vtx-closed.js") || url.pathname.endsWith("/version.json")) return;

    /* 12.1.1：音频 / 视频交给浏览器直接处理。媒体会发 Range 或分段请求，
       经过 Service Worker 时一旦上游截断就可能得到空的 504，播放器会卡在 0 秒。 */
    if (request.destination === "audio" || request.destination === "video" || request.destination === "track") return;
    if (/\.(mp3|wav|ogg|m4a|flac|mp4|webm|mkv)$/i.test(url.pathname)) return;

    /* Range 请求同样直接交给网络。 */
    if (request.headers.get("range")) return;

    if (request.mode === "navigate") {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            /* 12.1.1：不要忽略查询串。版本更新时会带着 ?v=9.x.x&t=... 跳转，
               如果 ignoreSearch 仍命中旧页面，就会永久停留在旧版本。 */
            const cached = await cache.match(request);
            if (cached) {
                event.waitUntil(fetch(request).then((response) => {
                    if (response && response.ok) return cache.put(request, response.clone());
                    return null;
                }).catch(() => null));
                return cached;
            }
            try {
                return await networkAndCache(request);
            } catch (error) {
                return (await cache.match("offline.html")) || new Response("离线，且没有缓存页面。", { status: 503, headers: { "content-type": "text/plain;charset=utf-8" } });
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) {
            event.waitUntil(fetch(request).then((response) => {
                if (response && response.ok) return cache.put(request, response.clone());
                return null;
            }).catch(() => null));
            return cached;
        }
        try {
            return await networkAndCache(request);
        } catch (error) {
            return new Response("", { status: 504 });
        }
    })());
});
