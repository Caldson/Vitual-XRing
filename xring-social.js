/*
 * Vitual XRing 3.1.0：分享卡片的公共渲染器。
 *
 * 聊天室、私聊、Vitx 评论、Vitx 动态、以及七个新页面都 include 这个文件，
 * 保证同一条链接在哪里看起来都一样。卡片内容全部来自服务端快照，
 * 这里只做转义和展示，不执行卡片里的任何 HTML。
 */
(function () {
    "use strict";

    const VERSION = "3.1.0";
    const STYLE_ID = "xr-social-style";
    const SITE_LABEL = {
        midi: "Vimidi",
        music: "VMusic",
        scratch: "Viratch",
        meeting: "AUDIV",
        style: "ViStyle",
        cpp: "VClang",
        dynamic: "Vitx 动态",
        link: "分享链接"
    };

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function safeUrl(value) {
        const text = String(value == null ? "" : value).trim();
        return /^https?:\/\//i.test(text) ? text : "";
    }

    function safeIcon(icon, fallback) {
        const text = String(icon == null ? "" : icon).trim();
        if (safeUrl(text)) {
            return `<img src="${escapeHtml(text)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
        }
        return escapeHtml(text || fallback || "🔗");
    }

    function timeAgo(timestamp) {
        const at = Number(timestamp) || 0;
        if (!at) {
            return "";
        }
        const diff = Math.max(0, Date.now() - at);
        if (diff < 60 * 1000) {
            return "刚刚";
        }
        if (diff < 60 * 60 * 1000) {
            return `${Math.floor(diff / 60000)} 分钟前`;
        }
        if (diff < 24 * 60 * 60 * 1000) {
            return `${Math.floor(diff / 3600000)} 小时前`;
        }
        if (diff < 30 * 24 * 60 * 60 * 1000) {
            return `${Math.floor(diff / 86400000)} 天前`;
        }
        const date = new Date(at);
        return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    }

    function ensureStyle() {
        if (typeof document === "undefined" || document.getElementById(STYLE_ID)) {
            return;
        }
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.xr-card{display:flex;gap:11px;align-items:flex-start;border:1px solid #dbe4f2;background:linear-gradient(180deg,#fbfdff,#f3f7fe);border-radius:13px;padding:11px 12px;margin:7px 0;max-width:440px;box-shadow:0 2px 7px rgba(40,80,150,.05);font-family:inherit;color:#2b3a52;text-align:left}
.xr-card:hover{border-color:#b9c8f5}
.xr-card-icon{width:42px;height:42px;flex:0 0 42px;border-radius:11px;background:#e8effb;display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden}
.xr-card-icon img{width:100%;height:100%;object-fit:cover}
.xr-card-main{flex:1;min-width:0}
.xr-card-site{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#7b8aa6;font-weight:700}
.xr-card-site i{font-style:normal;background:#e8effb;color:#4a72c9;border-radius:5px;padding:1px 5px}
.xr-card-title{display:block;font-size:13.5px;font-weight:700;color:#26364e;line-height:1.35;margin:2px 0 3px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.xr-card-desc{display:block;font-size:12px;color:#7b8aa6;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;word-break:break-word}
.xr-card-foot{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-top:8px}
.xr-card-link{display:inline-flex;align-items:center;gap:3px;border:1px solid #cbdcff;background:#eef4ff;color:#315fc4;border-radius:8px;padding:4px 9px;font-size:11.5px;font-weight:700;text-decoration:none;cursor:pointer}
.xr-card-link:hover{background:#e2ebff}
.xr-card-link.plain{border-color:transparent;background:transparent;color:#7b8aa6;font-weight:500;padding:4px 2px}
.xr-card-badge{font-size:10.5px;font-weight:700;color:#2c7a54;background:#e6f7ee;border-radius:6px;padding:2px 6px}
.xr-card-price{font-size:11px;font-weight:700;color:#b1711c;background:#fff5df;border-radius:6px;padding:2px 6px}
.xr-card audio{width:100%;margin-top:7px;height:32px}
.xr-card.is-compact{max-width:none;padding:9px 10px}
.xr-card.is-compact .xr-card-icon{width:34px;height:34px;flex-basis:34px;font-size:18px}
.xr-card.is-compact .xr-card-title{font-size:12.5px}
.xr-music-note{display:block;font-size:11px;color:#5b7bb5;margin-top:3px}
@media(max-width:560px){.xr-card{max-width:100%}}
`;
        document.head.appendChild(style);
    }

    function fileUrl(id) {
        if (window.VTXApi && window.VTXApi.social && typeof window.VTXApi.social.fileUrl === "function") {
            return window.VTXApi.social.fileUrl(id);
        }
        return `/api/social/file/${encodeURIComponent(String(id || ""))}`;
    }

    function cardHtml(card, options) {
        if (!card) {
            return "";
        }
        ensureStyle();
        const opts = options || {};
        const kind = SITE_LABEL[card.kind] ? card.kind : "link";
        const site = SITE_LABEL[kind];
        const url = safeUrl(card.url);
        const icon = safeIcon(card.icon, kind === "music" ? "🎵" : "🔗");
        const title = escapeHtml(card.title || site);
        const description = card.description ? `<span class="xr-card-desc">${escapeHtml(card.description)}</span>` : "";
        const action = escapeHtml(card.actionLabel || (kind === "link" ? "打开链接" : `查看${site}`));
        const meta = card.meta || {};
        const parts = [];

        if (kind === "midi" && meta.musicTitle) {
            parts.push(`<span class="xr-card-badge">已识别为《${escapeHtml(meta.musicTitle)}》</span>`);
        }
        if (kind === "style" || kind === "cpp") {
            const price = String(meta.price || "");
            parts.push(`<span class="xr-card-price">${price && price !== "0.00" ? `${escapeHtml(price)} VTX` : "免费"}</span>`);
        }
        if (kind === "meeting" && meta.no) {
            parts.push(`<span class="xr-card-badge">${escapeHtml(meta.no)}</span>`);
        }

        if (url) {
            parts.push(`<a class="xr-card-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${action} →</a>`);
        }

        if (kind === "midi" && meta.musicId) {
            let musicUrl = "";
            try {
                musicUrl = new URL(`vmusic.html?id=${encodeURIComponent(meta.musicId)}`, location.href).href;
            } catch (error) {
                musicUrl = "";
            }
            if (musicUrl) {
                parts.push(`<a class="xr-card-link" href="${escapeHtml(musicUrl)}" target="_blank" rel="noopener">在 VMusic 听 →</a>`);
            }
        }
        if (kind === "music" && meta.midiId) {
            parts.push(`<a class="xr-card-link plain" href="vimidi.html?id=${encodeURIComponent(meta.midiId)}" target="_blank" rel="noopener">查看 MIDI${meta.midiTitle ? `：${escapeHtml(meta.midiTitle)}` : ""}</a>`);
        }
        if (kind === "meeting") {
            parts.push(`<button type="button" class="xr-card-link plain" data-xr-copy="${escapeHtml(meta.no || "")}">复制会议号</button>`);
        }

        let audio = "";
        if (kind === "music" && card.targetId) {
            audio = `<audio controls preload="none" src="${escapeHtml(fileUrl(card.targetId))}"></audio>`;
        }

        const note = kind === "midi" && !meta.musicTitle
            ? `<span class="xr-music-note">还没有识别到已知音乐，可打开 Vimidi 手动关联</span>`
            : "";

        return `<div class="xr-card${opts.compact ? " is-compact" : ""} xr-card-${kind}" data-xr-card="${escapeHtml(card.targetId || "")}">
            <span class="xr-card-icon">${icon}</span>
            <span class="xr-card-main">
                <span class="xr-card-site"><i>${escapeHtml(site)}</i>${card.kind === "link" && card.site ? `<span>${escapeHtml(card.site)}</span>` : ""}</span>
                <span class="xr-card-title">${title}</span>
                ${description}
                ${note}
                ${audio}
                <span class="xr-card-foot">${parts.join("")}</span>
            </span>
        </div>`;
    }

    function copyText(text) {
        const value = String(text || "");
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
        }
        return Promise.resolve(fallbackCopy(value));
    }

    function fallbackCopy(text) {
        try {
            const area = document.createElement("textarea");
            area.value = text;
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            area.remove();
        } catch (error) {
            /* 忽略 */
        }
    }

    function toast(message) {
        if (window.VTXApi && typeof window.VTXApi.toast === "function") {
            window.VTXApi.toast(message);
            return;
        }
        let node = document.getElementById("xr-social-toast");
        if (!node) {
            node = document.createElement("div");
            node.id = "xr-social-toast";
            node.style.cssText = "position:fixed;left:50%;bottom:44px;transform:translateX(-50%);background:rgba(28,40,60,.93);color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;z-index:9000;opacity:0;transition:opacity .2s;pointer-events:none";
            document.body.appendChild(node);
        }
        node.textContent = message;
        node.style.opacity = "1";
        clearTimeout(node._timer);
        node._timer = setTimeout(() => {
            node.style.opacity = "0";
        }, 1800);
    }

    function escapeSelector(value) {
        if (window.CSS && typeof window.CSS.escape === "function") {
            return window.CSS.escape(String(value));
        }
        return String(value).replace(/["\\]/g, "\\$&");
    }

    document.addEventListener("click", (event) => {
        const button = event.target.closest("[data-xr-copy]");
        if (!button) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        copyText(button.getAttribute("data-xr-copy") || "").then(() => toast("已复制"));
    });

    window.XRSocial = {
        version: VERSION,
        escapeHtml,
        cardHtml,
        fileUrl,
        timeAgo,
        copyText,
        toast,
        copyLink: (url) => copyText(url).then(() => toast("链接已复制")),
        resolve: async (url) => {
            if (!window.VTXApi || !window.VTXApi.social) {
                return null;
            }
            const data = await window.VTXApi.social.resolve(url);
            return data && data.card ? data.card : null;
        }
    };
})();
