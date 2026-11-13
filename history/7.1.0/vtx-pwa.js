/* Vitual XRing 7.1.0 — 注册页面缓存 Service Worker */
(function () {
    "use strict";
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;

    window.addEventListener("load", function () {
        navigator.serviceWorker.register("vtx-sw.js", { scope: "./" }).then(function (registration) {
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
