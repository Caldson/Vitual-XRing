/**
 * Vitual XRing 停服守卫
 *
 * 停服期间打开站内任何页面，都会在渲染前跳到 WebsiteClose.html。
 * 时间表只在本文件维护（WINDOWS），页面里只用一行 document.write 引入，
 * 带时间戳加载，改完立刻生效，不会被浏览器 / CDN 缓存住。
 *
 * 用法（放进每个页面 <head> 的最前面）：
 *   <script>document.write('<script src="vtx-closed.js?t=' + Date.now() + '"><\/script>');</script>
 */
(function (global) {
    "use strict";

    /* 停服时间表：每项 [开始, 结束]，按北京时间（UTC+8）解释，格式 YYYY-MM-DD HH:mm。
       websiteclose.txt 是同一份时间的人工填写模板（每次 6 行：年月日 / 时 / 分 / 年月日 / 时 / 分）。 */
    var WINDOWS = [
        ["2026-10-26 18:30", "2026-10-26 18:45"]
    ];

    var CLOSED_PAGE = "WebsiteClose.html";
    var TZ_MINUTES = 8 * 60;

    function parseTime(text) {
        var match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(text == null ? "" : text).trim());
        if (!match) {
            return NaN;
        }
        return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]) - TZ_MINUTES * 60 * 1000;
    }

    function pad(value) {
        return (value < 10 ? "0" : "") + value;
    }

    function formatTime(ms) {
        if (!isFinite(ms) || ms <= 0) {
            return "";
        }
        var date = new Date(ms + TZ_MINUTES * 60 * 1000);
        return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} `
            + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    }

    function formatDuration(ms) {
        var total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        var hours = Math.floor(total / 3600);
        var minutes = Math.floor((total % 3600) / 60);
        var seconds = total % 60;
        if (hours > 0) {
            return `${hours} 小时 ${pad(minutes)} 分 ${pad(seconds)} 秒`;
        }
        if (minutes > 0) {
            return `${minutes} 分 ${pad(seconds)} 秒`;
        }
        return `${seconds} 秒`;
    }

    function readWindows() {
        var list = [];
        for (var index = 0; index < WINDOWS.length; index += 1) {
            var start = parseTime(WINDOWS[index][0]);
            var end = parseTime(WINDOWS[index][1]);
            if (isFinite(start) && isFinite(end) && end > start) {
                list.push({ start: start, end: end });
            }
        }
        list.sort((left, right) => left.start - right.start);
        return list;
    }

    var windows = readWindows();
    var now = Date.now();
    var current = null;
    var next = null;

    for (var index = 0; index < windows.length; index += 1) {
        var item = windows[index];
        if (now >= item.start && now < item.end) {
            current = item;
            break;
        }
        if (now < item.start && !next) {
            next = item;
        }
    }

    global.VTXClosure = {
        windows: windows,
        active: Boolean(current),
        current: current,
        next: next,
        start: current ? current.start : 0,
        end: current ? current.end : 0,
        closedPage: CLOSED_PAGE,
        formatTime: formatTime,
        formatDuration: formatDuration
    };

    if (!current) {
        return;
    }

    // 已经在停服页里：不要再跳，否则会死循环
    var here = String(global.location.pathname || "").split("/").pop().toLowerCase();
    if (here === CLOSED_PAGE.toLowerCase()) {
        return;
    }

    // 用相对路径回传，停服页只接受站内相对地址（避免 ?from= 被当成跳板）
    var back = String(global.location.pathname || "").replace(/^\/+/, "")
        + global.location.search + global.location.hash;
    global.location.replace(`${CLOSED_PAGE}?from=${encodeURIComponent(back)}`);
})(window);
