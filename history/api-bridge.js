/* Vitual XRing 时光回溯机：把历史快照里的 /api 请求转给当前线上 API。
   历史页面可能缓存了 sessionStorage 的 "api" 地址，或直接 fetch("api/login")，
   在 /history/<版本>/ 下会落到静态文件路径并返回 405；这里统一改写到线上。 */
(function () {
    "use strict";
    var API = "https://xsmmc.caldson.us.ci/api";
    window.VTX_API_BASE = API;

    function rewrite(value) {
        try {
            var url = new URL(String(value), location.href);
            if (url.origin !== location.origin) return value;
            var match = /^\/history\/[^/]+\/api(?=\/|$)/.exec(url.pathname);
            if (!match) return value;
            return API + url.pathname.slice(match[0].length) + url.search + url.hash;
        } catch (error) {
            return value;
        }
    }

    if (typeof window.fetch === "function") {
        var nativeFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                if (typeof input === "string") {
                    input = rewrite(input);
                } else if (input && typeof input.url === "string") {
                    var next = rewrite(input.url);
                    if (next !== input.url) input = new Request(next, input);
                }
            } catch (error) {
                /* 保留原请求 */
            }
            return nativeFetch.call(this, input, init);
        };
    }

    if (typeof XMLHttpRequest !== "undefined") {
        var nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            var args = Array.prototype.slice.call(arguments);
            args[1] = rewrite(url);
            return nativeOpen.apply(this, args);
        };
    }

    if (navigator && typeof navigator.sendBeacon === "function") {
        var nativeBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
            return nativeBeacon(rewrite(url), data);
        };
    }
})();
