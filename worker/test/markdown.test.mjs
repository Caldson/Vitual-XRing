import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const markdown = require("../../vtx-markdown.js");

test("1.7.3：基础 Markdown 与 Discord 格式", () => {
    assert.equal(markdown.render("**粗体**"), '<div class="md-p"><strong>粗体</strong></div>');
    assert.equal(markdown.render("*斜体*"), '<div class="md-p"><em>斜体</em></div>');
    assert.equal(markdown.render("_斜体_"), '<div class="md-p"><em>斜体</em></div>');
    assert.equal(markdown.render("__下划线__"), '<div class="md-p"><u>下划线</u></div>');
    assert.equal(markdown.render("~~删除~~"), '<div class="md-p"><del>删除</del></div>');
    assert.equal(markdown.render("***粗斜体***"), '<div class="md-p"><strong><em>粗斜体</em></strong></div>');
    assert.equal(
        markdown.render("**粗体里有 *斜体***"),
        '<div class="md-p"><strong>粗体里有 <em>斜体</em></strong></div>'
    );
    assert.equal(markdown.render("snake_case_name"), '<div class="md-p">snake_case_name</div>');
});

test("1.7.3：行内代码、转义与代码块不受格式化影响", () => {
    assert.equal(
        markdown.render("`**不是粗体**`"),
        '<div class="md-p"><code class="md-code-inline">**不是粗体**</code></div>'
    );
    assert.equal(markdown.render("\\*不是斜体\\*"), '<div class="md-p">*不是斜体*</div>');

    const block = markdown.render("```js\nconst a = 1 < 2 && 3 > 2;\nconst b = `x`;\n```");
    assert.match(block, /<div class="md-code">/);
    assert.match(block, /<span class="md-code-lang">js<\/span>/);
    assert.match(block, /data-md-copy/);
    assert.match(block, /const a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;/);
    assert.ok(!block.includes("<strong>"), block);

    /* 没写语言、甚至没闭合也要能渲染 */
    const plain = markdown.render("```\nplain\n");
    assert.match(plain, /<span class="md-code-lang">代码<\/span>/);
    assert.match(plain, /<pre><code>plain<\/code><\/pre>/);
});

test("1.7.3：Discord 时间块支持全部样式", () => {
    const html = markdown.render("<t:1700000000> <t:1700000000:t> <t:1700000000:T> <t:1700000000:d> <t:1700000000:D> <t:1700000000:F> <t:1700000000:R>", { now: 1700000000000 });
    assert.equal((html.match(/class="md-time"/g) || []).length, 7);
    assert.match(html, /data-ts="1700000000000"/);
    assert.match(html, /data-style="t"[^>]*>\d{2}:\d{2}</);
    assert.match(html, /data-style="T"[^>]*>\d{2}:\d{2}:\d{2}</);
    assert.match(html, /data-style="d"[^>]*>\d{4}\/\d{2}\/\d{2}</);
    assert.match(html, /data-style="D"[^>]*>\d{4}年\d{1,2}月\d{1,2}日</);
    assert.match(html, /data-style="F"/);
    assert.match(html, /data-style="R"[^>]*>刚刚</);

    /* 毫秒时间戳也认 */
    assert.match(markdown.render("<t:1700000000000>"), /data-ts="1700000000000"/);

    /* 非法内容保持原样转义 */
    assert.equal(markdown.render("<t:abc>"), '<div class="md-p">&lt;t:abc&gt;</div>');
});

test("1.7.3：相对时间随时间变化，并支持刷新", () => {
    const now = 1700000000000;
    const justNow = markdown.render("<t:1700000000:R>", { now });
    assert.match(justNow, /data-style="R"[^>]*>刚刚<\/time>/);
    assert.match(justNow, /datetime="2023-11-14T22:13:20.000Z"/);

    const later = markdown.render("<t:1700000000:R>", { now: now + 3 * 60 * 1000 });
    assert.match(later, />3分钟前</);

    const node = { dataset: { ts: "1700000000000" }, textContent: "刚刚" };
    markdown.refreshTimes({ querySelectorAll: () => [node] }, now + 3600 * 1000);
    assert.equal(node.textContent, "1小时前");
});

test("1.7.3：链接只允许安全协议，文本全部转义", () => {
    const safe = markdown.render("[官网](https://example.com/a?b=1&c=2)");
    assert.match(safe, /<a class="md-link" href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">官网<\/a>/);

    const danger = markdown.render("[点我](javascript:alert(1))");
    assert.ok(!danger.includes("<a"), danger);
    assert.match(danger, /\[点我\]\(javascript:alert\(1\)\)/);

    const xss = markdown.render('<img src=x onerror=alert(1)>');
    assert.ok(!xss.includes("<img"), xss);

    const bare = markdown.render("看 https://example.com/x。");
    assert.match(bare, /<a class="md-link" href="https:\/\/example.com\/x"/);
    assert.match(bare, />。<\/div>$/);
});

test("1.7.3：@ 提及只高亮真正的成员，且代码里的 @ 不处理", () => {
    const html = markdown.render("@Bob 你好 @Bobby，@Bob", { mentions: ["Bob"] });
    assert.equal((html.match(/<span class="mention">@Bob<\/span>/g) || []).length, 2);
    assert.ok(!html.includes('<span class="mention">@Bobby</span>'), html);

    const code = markdown.render("`@Bob`", { mentions: ["Bob"] });
    assert.ok(!code.includes("span class=\"mention\""), code);
});

test("1.7.3：标题、引用、列表与剧透", () => {
    assert.equal(markdown.render("# 标题"), '<div class="md-h1">标题</div>');
    assert.equal(markdown.render("### 小标题"), '<div class="md-h3">小标题</div>');
    assert.equal(markdown.render("-# 小字"), '<div class="md-subtext">小字</div>');
    assert.equal(markdown.render("> 引用"), '<blockquote class="md-quote">引用</blockquote>');
    assert.equal(markdown.render(">>> 第一行\n第二行"), '<blockquote class="md-quote">第一行<br>第二行</blockquote>');
    assert.equal(markdown.render("- 甲\n- 乙"), '<ul class="md-list"><li>甲</li><li>乙</li></ul>');
    assert.equal(markdown.render("1. 甲\n2. 乙"), '<ol class="md-list"><li>甲</li><li>乙</li></ol>');
    assert.equal(
        markdown.render("||剧透 **重点**||"),
        '<div class="md-p"><span class="md-spoiler" role="button" tabindex="0" title="点击显示剧透">剧透 <strong>重点</strong></span></div>'
    );
});

test("1.7.3：综合长消息、时间块与代码块混排", () => {
    const source = [
        "# 标题",
        "**粗体**里有 `代码` 和 <t:1700000000:R>，还有 @Bob。",
        "> 引用一行",
        "```js",
        "<t:1700000000> 在代码块里保持原样",
        "**不是粗体**",
        "```",
        "||剧透|| 和 [官网](https://example.com)",
        "https://example.com/a。"
    ].join("\n");
    const html = markdown.render(source, { mentions: ["Bob"], now: 1700000000000 });

    assert.match(html, /<div class="md-h1">标题<\/div>/);
    assert.match(html, /<strong>粗体<\/strong>里有 <code class="md-code-inline">代码<\/code> 和 <time/);
    assert.match(html, /<span class="mention">@Bob<\/span>/);
    assert.match(html, /<blockquote class="md-quote">引用一行<\/blockquote>/);
    assert.match(html, /<code class="language-js">&lt;t:1700000000&gt; 在代码块里保持原样\n\*\*不是粗体\*\*<\/code>/);
    assert.match(html, /<span class="md-spoiler"/);
    assert.match(html, /<a class="md-link" href="https:\/\/example.com"/);
    assert.match(html, /href="https:\/\/example.com\/a"/);
});

test("1.7.3：尖括号链接、URL 里的 @ 不被高亮、空输入", () => {
    const angle = markdown.render("<https://example.com/x?y=1>");
    assert.match(angle, /<a class="md-link" href="https:\/\/example.com\/x\?y=1"/);

    const urlMention = markdown.render("https://example.com/@Bob", { mentions: ["Bob"] });
    assert.ok(!urlMention.includes('<span class="mention">'), urlMention);

    assert.equal(markdown.render(""), "");
    assert.equal(markdown.render(null), "");
    assert.equal(markdown.render(undefined), "");
});
