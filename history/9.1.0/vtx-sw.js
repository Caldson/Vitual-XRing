/* Vitual XRing 9.1.0 — page cache / offline shell */
const CACHE_NAME = "xring-v9.1.0";
const CORE = [
    "./",
    "index.html",
    "settings.html",
    "shop.html",
    "xos.html",
    "manager.html",
    "login.html",
    "vitualgit.html",
    "vuolingo.html",
    "offline.html",
    "vtx-theme.css",
    "vtx-theme.js",
    "vtx-theme.css?v=9.1.0",
    "vtx-theme.js?v=9.1.0",
    "vtx-api.js",
    "vtx-pwa.js",
    "vtx-pwa.js?v=9.1.0",
    "XRingLogo-V.png"
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
    if (response && response.ok) {
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

    if (request.mode === "navigate") {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(request, { ignoreSearch: true });
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
