/* Vitual XRing 8.0.0 — 页面缓存、版本检测与自动清缓存 */
(function () {
    "use strict";
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;

    const CLIENT_VERSION = "8.0.0";

    async function clearPageCaches() {
        try {
            const keys = await caches.keys();
            await Promise.all(keys.filter((key) => key.startsWith("xring-")).map((key) => caches.delete(key)));
        } catch (error) {
            /* 清缓存失败不阻塞后续刷新 */
        }
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((registration) => registration.unregister()));
        } catch (error) {
            /* ignore */
        }
    }

    function isNewerVersion(remote, local) {
        const left = String(remote).split(".").map((part) => Number(part) || 0);
        const right = String(local).split(".").map((part) => Number(part) || 0);
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
            const a = left[index] || 0;
            const b = right[index] || 0;
            if (a !== b) return a > b;
        }
        return false;
    }

    async function checkForNewVersion() {
        try {
            const response = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
            if (!response.ok) return false;
            const data = await response.json();
            if (!data || !data.version || !isNewerVersion(data.version, CLIENT_VERSION)) return false;
            const key = "xring:cacheReset:" + data.version;
            if (sessionStorage.getItem(key) === "1") return false;
            sessionStorage.setItem(key, "1");
            await clearPageCaches();
            const url = new URL(location.href);
            url.searchParams.set("v", data.version);
            url.searchParams.set("t", Date.now());
            location.replace(url.toString());
            return true;
        } catch (error) {
            /* 离线或版本文件不可达时保留缓存，避免误删 */
            return false;
        }
    }

    window.addEventListener("load", async function () {
        if (await checkForNewVersion()) return;
        navigator.serviceWorker.register("vtx-sw.js?v=" + CLIENT_VERSION, { scope: "./" }).then(function (registration) {
            if (registration.waiting) registration.waiting.postMessage("SKIP_WAITING");
            registration.addEventListener("updatefound", function () {
                const worker = registration.installing;
                if (!worker) return;
                worker.addEventListener("statechange", function () {
                    if (worker.state === "installed" && navigator.serviceWorker.controller) {
                        worker.postMessage("SKIP_WAITING");
                    }
                });
            });
        }).catch(function () {
            /* 离线缓存不是关键路径，注册失败不影响页面 */
        });
    });
})();
