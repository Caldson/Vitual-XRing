/*!
 * Vitual XRing 2.0.0 — Discord 风格 Markdown 渲染器
 *
 * 纯前端、零依赖，可以直接用 <script src="vtx-markdown.js?v=2.0.0"></script> 引入，
 * 也可以在 Node 里 require 后跑单元测试。
 *
 * 支持（尽量与 Discord 保持一致）：
 *   - 原有 Markdown：**粗体**、*斜体* / _斜体_、__下划线__、~~删除线~~、`行内代码`、
 *     [文字](链接)、裸链接、\ 转义
 *   - ``` 代码块（可带语言名），不会被任何格式化影响
 *   - <t:1730000000> / <t:1730000000:R> 时间块（Discord 的 7 种时间样式）
 *   - ||剧透||、> 引用、>>> 多行引用、# / ## / ### 标题、-# 小字、- / 1. 列表
 *   - @登录名 高亮（只高亮调用方传入的成员，避免把邮箱当地 mention）
 *
 * 安全策略：所有用户文本先转义，链接只允许 http / https / mailto，绝不输出原始 HTML。
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.VTXMarkdown = factory();
    }
}(typeof globalThis === "object" ? globalThis : this, function () {
    "use strict";

    const TOKEN_START = "\u0000";
    const TOKEN_END = "\u0001";
    const ESCAPE_MAP = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    };
    const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function stash(ctx, html) {
        const index = ctx.tokens.length;
        ctx.tokens.push(html);
        return `${TOKEN_START}${index}${TOKEN_END}`;
    }

    function unstash(ctx, html) {
        return String(html).replace(/\u0000(\d+)\u0001/g, (match, index) => {
            const token = ctx.tokens[Number(index)];
            return token === undefined ? "" : token;
        });
    }

    /* ───────────── 时间块 <t:unix[:样式]> ───────────── */

    const TIME_STYLES = new Set(["t", "T", "d", "D", "f", "F", "R"]);

    function timestampDate(value) {
        let number = Number(value);
        if (!Number.isFinite(number) || number < 0) {
            return null;
        }
        /* Discord 用秒；也兼容毫秒（大于 1e12 就当作毫秒） */
        if (number > 1e12) {
            number = Math.floor(number);
        } else {
            number = Math.floor(number * 1000);
        }
        const date = new Date(number);
        if (Number.isNaN(date.getTime())) {
            return null;
        }
        const year = date.getUTCFullYear();
        if (year < 1970 || year > 2200) {
            return null;
        }
        return date;
    }

    function pad2(value) {
        return String(value).padStart(2, "0");
    }

    function relativeTime(from, now) {
        const diff = from.getTime() - now;
        const abs = Math.abs(diff);
        const future = diff > 0;
        const units = [
            [365 * 24 * 60 * 60 * 1000, "年", "年"],
            [30 * 24 * 60 * 60 * 1000, "个月", "个月"],
            [7 * 24 * 60 * 60 * 1000, "周", "周"],
            [24 * 60 * 60 * 1000, "天", "天"],
            [60 * 60 * 1000, "小时", "小时"],
            [60 * 1000, "分钟", "分钟"],
            [1000, "秒", "秒"]
        ];
        for (const [ms, before, after] of units) {
            const count = Math.floor(abs / ms);
            if (count >= 1 || ms === 1000) {
                if (count < 1) {
                    return "刚刚";
                }
                return future ? `${count}${after}后` : `${count}${before}前`;
            }
        }
        return "刚刚";
    }

    function timeText(date, style, now) {
        const y = date.getFullYear();
        const m = date.getMonth() + 1;
        const d = date.getDate();
        const hh = pad2(date.getHours());
        const mm = pad2(date.getMinutes());
        const ss = pad2(date.getSeconds());
        const week = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][date.getDay()];
        switch (style) {
            case "t": return `${hh}:${mm}`;
            case "T": return `${hh}:${mm}:${ss}`;
            case "d": return `${y}/${pad2(m)}/${pad2(d)}`;
            case "D": return `${y}年${m}月${d}日`;
            case "R": return relativeTime(date, now);
            case "F": return `${y}年${m}月${d}日 ${week} ${hh}:${mm}`;
            case "f":
            default: return `${y}年${m}月${d}日 ${hh}:${mm}`;
        }
    }

    function renderTimestamp(value, style, now) {
        const date = timestampDate(value);
        const format = TIME_STYLES.has(style) ? style : "f";
        if (!date) {
            return null;
        }
        const label = timeText(date, format, now === undefined ? Date.now() : now);
        const title = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 `
            + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
            + `（${relativeTime(date, Date.now())}）`;
        return `<time class="md-time" datetime="${date.toISOString()}" data-ts="${date.getTime()}" `
            + `data-style="${format}" title="${escapeHtml(title)}">${escapeHtml(label)}</time>`;
    }

    /* ───────────── 行内渲染 ───────────── */

    function normalizeMentions(names) {
        if (!Array.isArray(names)) {
            return [];
        }
        return Array.from(new Set(names
            .map((item) => String(item == null ? "" : item).trim())
            .filter((item) => item && item.length <= 40 && !/[\s]/.test(item))))
            .sort((left, right) => right.length - left.length);
    }

    function applyMentions(text, ctx) {
        if (!ctx.mentions.length) {
            return text;
        }
        let output = text;
        for (const name of ctx.mentions) {
            const pattern = new RegExp(`(^|[^\\w.@-])@${escapeRegExp(name)}(?![\\w.@-])`, "g");
            output = output.replace(pattern, (match, prefix) => {
                return `${prefix}${stash(ctx, `<span class="mention">@${escapeHtml(name)}</span>`)}`;
            });
        }
        return output;
    }

    function trimUrlTail(raw) {
        const match = /[.,!?;:，。！？；：、)\]}>」』】]+$/.exec(raw);
        if (!match) {
            return { url: raw, tail: "" };
        }
        return { url: raw.slice(0, -match[0].length), tail: match[0] };
    }

    function anchorHtml(url, label) {
        return `<a class="md-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">`
            + `${escapeHtml(label === undefined ? url : label)}</a>`;
    }

    function replaceCodeSpans(text, ctx) {
        return text.replace(/(`+)([\s\S]*?)\1/g, (match, ticks, code) => {
            const trimmed = code.replace(/^ /, "").replace(/ $/, "");
            return stash(ctx, `<code class="md-code-inline">${escapeHtml(trimmed)}</code>`);
        });
    }

    function replaceTimestamps(text, ctx, now) {
        return text.replace(/<t:(\d{1,16})(?::([tTdDfFR]))?>/g, (match, value, style) => {
            const html = renderTimestamp(value, style || "f", now);
            return stash(ctx, html === null ? escapeHtml(match) : html);
        });
    }

    function replaceAngleLinks(text, ctx) {
        return text.replace(/<(https?:\/\/[^\s<>]+)>/gi, (match, url) => {
            const { url: clean, tail } = trimUrlTail(url);
            return stash(ctx, anchorHtml(clean)) + tail;
        });
    }

    function replaceBareLinks(text, ctx) {
        return text.replace(/https?:\/\/[^\s<>"'`]+/gi, (raw) => {
            const { url, tail } = trimUrlTail(raw);
            if (!url) {
                return raw;
            }
            return stash(ctx, anchorHtml(url)) + tail;
        });
    }

    function replaceMaskedLinks(text, ctx) {
        return text.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2048})\)/gi, (match, label, url) => {
            if (!SAFE_LINK.test(url)) {
                return match;
            }
            return stash(ctx, anchorHtml(url, label));
        });
    }

    function replaceSpoilers(text) {
        return text.replace(/\|\|([^\n]+?)\|\|/g, (match, inner) => {
            return `<span class="md-spoiler" role="button" tabindex="0" title="点击显示剧透">${inner}</span>`;
        });
    }

    function replaceEmphasis(text) {
        let output = text;
        output = output.replace(/\*\*\*(?!\*)([^\n]+?)\*\*\*(?!\*)/g, "<strong><em>$1</em></strong>");
        output = output.replace(/(^|[^\w])___(?!_)([^_\n]+?)___(?!\w)/g, "$1<strong><em>$2</em></strong>");
        output = output.replace(/\*\*(?!\*)([^\n]+?)\*\*(?!\*)/g, "<strong>$1</strong>");
        output = output.replace(/(^|[^\w])__(?!_)([^_\n]+?)__(?!\w)/g, "$1<u>$2</u>");
        output = output.replace(/~~([^\n]+?)~~/g, "<del>$1</del>");
        output = output.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
        output = output.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
        return output;
    }

    function renderInline(source, ctx) {
        let text = String(source == null ? "" : source);

        /* 1. 反斜杠转义：\* 之类先变成占位符，不参与后续格式化 */
        text = text.replace(/\\([\\`*_{}\[\]()#+\-.!~|>])/g, (match, ch) => stash(ctx, escapeHtml(ch)));

        /* 2. 行内代码必须最先吃掉内容 */
        text = replaceCodeSpans(text, ctx);

        /* 3. Discord 时间块、尖括号链接、[文字](链接) 与裸链接 */
        text = replaceTimestamps(text, ctx, ctx.now);
        text = replaceAngleLinks(text, ctx);
        text = replaceMaskedLinks(text, ctx);
        text = replaceBareLinks(text, ctx);

        /* 4. @ 提及（只认传入的成员） */
        text = applyMentions(text, ctx);

        /* 5. 整段转义，之后所有操作都在安全的文本上做 */
        text = escapeHtml(text);

        /* 6. 强调格式 */
        text = replaceEmphasis(text);

        /* 7. 剧透最后包，里面已经是可以显示的内容 */
        text = replaceSpoilers(text);

        return unstash(ctx, text);
    }

    /* ───────────── 块级渲染 ───────────── */

    function codeBlockHtml(code, language) {
        const lang = String(language || "").replace(/[^\w+#.-]/g, "").slice(0, 24);
        const label = lang || "代码";
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        return `<div class="md-code">`
            + `<div class="md-code-head"><span class="md-code-lang">${escapeHtml(label)}</span>`
            + `<button type="button" class="md-copy" data-md-copy>复制</button></div>`
            + `<pre><code${cls}>${escapeHtml(code)}</code></pre>`
            + `</div>`;
    }

    function quoteHtml(lines, ctx) {
        return `<blockquote class="md-quote">${lines.map((line) => renderInline(line, ctx)).join("<br>")}</blockquote>`;
    }

    function listHtml(items, ordered, ctx) {
        const tag = ordered ? "ol" : "ul";
        return `<${tag} class="md-list">${items
            .map((item) => `<li>${renderInline(item, ctx)}</li>`)
            .join("")}</${tag}>`;
    }

    const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
    const HEADING = /^ {0,3}(#{1,3})\s+(.+?)\s*$/;
    const SUBTEXT = /^ {0,3}-#\s+(.+?)\s*$/;
    const QUOTE = /^ {0,3}>\s?/;
    const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
    const NUMBER = /^ {0,3}\d{1,3}[.)]\s+(.*)$/;

    function isBlockStart(line) {
        return FENCE.test(line)
            || /^ {0,3}>>>\s?/.test(line)
            || HEADING.test(line)
            || SUBTEXT.test(line)
            || QUOTE.test(line)
            || BULLET.test(line)
            || NUMBER.test(line);
    }

    function render(source, options) {
        const settings = options || {};
        const ctx = {
            tokens: [],
            mentions: normalizeMentions(settings.mentions),
            now: settings.now === undefined ? Date.now() : settings.now
        };
        const text = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
        const lines = text.split("\n");
        const output = [];
        let index = 0;

        while (index < lines.length) {
            const line = lines[index];

            /* 代码块（未闭合时一直吃到结尾，和 Discord 一样） */
            const fence = FENCE.exec(line);
            if (fence) {
                const marker = fence[1];
                const language = fence[2] || "";
                const body = [];
                index += 1;
                while (index < lines.length) {
                    const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
                    if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) {
                        index += 1;
                        break;
                    }
                    body.push(lines[index]);
                    index += 1;
                }
                while (body.length && !body[body.length - 1].trim()) {
                    body.pop();
                }
                output.push(codeBlockHtml(body.join("\n"), language));
                continue;
            }

            /* >>> 多行引用：从这一行一直引用到结尾 */
            if (/^ {0,3}>>>\s?/.test(line)) {
                const body = [line.replace(/^ {0,3}>>>\s?/, "")];
                index += 1;
                while (index < lines.length) {
                    body.push(lines[index]);
                    index += 1;
                }
                output.push(quoteHtml(body, ctx));
                continue;
            }

            const heading = HEADING.exec(line);
            if (heading) {
                output.push(`<div class="md-h${heading[1].length}">${renderInline(heading[2], ctx)}</div>`);
                index += 1;
                continue;
            }

            const subtext = SUBTEXT.exec(line);
            if (subtext) {
                output.push(`<div class="md-subtext">${renderInline(subtext[1], ctx)}</div>`);
                index += 1;
                continue;
            }

            if (QUOTE.test(line)) {
                const body = [];
                while (index < lines.length && QUOTE.test(lines[index])) {
                    body.push(lines[index].replace(QUOTE, ""));
                    index += 1;
                }
                output.push(quoteHtml(body, ctx));
                continue;
            }

            const bullet = BULLET.exec(line);
            const numbered = NUMBER.exec(line);
            if (bullet || numbered) {
                const ordered = Boolean(numbered);
                const pattern = ordered ? NUMBER : BULLET;
                const items = [];
                while (index < lines.length) {
                    const item = pattern.exec(lines[index]);
                    if (!item) {
                        break;
                    }
                    items.push(item[1]);
                    index += 1;
                }
                output.push(listHtml(items, ordered, ctx));
                continue;
            }

            if (!line.trim()) {
                index += 1;
                continue;
            }

            /* 普通段落：连续的普通行用 <br> 保留换行 */
            const paragraph = [line];
            index += 1;
            while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
                paragraph.push(lines[index]);
                index += 1;
            }
            output.push(`<div class="md-p">${paragraph
                .map((item) => renderInline(item, ctx))
                .join("<br>")}</div>`);
        }

        return output.join("");
    }

    /* 相对时间会随当前时间变化，页面上定时调用即可 */
    function refreshTimes(root, now) {
        if (!root || typeof root.querySelectorAll !== "function") {
            return;
        }
        const stamp = now === undefined ? Date.now() : now;
        root.querySelectorAll(".md-time[data-style='R']").forEach((node) => {
            const value = Number(node.dataset.ts);
            if (!Number.isFinite(value)) {
                return;
            }
            const date = new Date(value);
            node.textContent = relativeTime(date, stamp);
        });
    }

    return {
        version: "2.0.0",
        escapeHtml,
        render,
        renderInline,
        renderTimestamp,
        refreshTimes,
        relativeTime
    };
}));
