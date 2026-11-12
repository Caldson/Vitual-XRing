import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 9.5.0：右下角的主题 / 设置悬浮球原来会压住聊天室的输入框和「发送」按钮。
   这里做静态回归检查，防止以后改样式或改页面结构时又把避让逻辑弄丢。 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("9.5.0：主题悬浮球按输入区高度避让", () => {
    const css = read("vtx-theme.css");
    const theme = read("vtx-theme.js");
    assert.match(css, /bottom: calc\(16px \+ var\(--vtx-widget-lift, 0px\)\)/);
    assert.match(theme, /\[data-vtx-widget-avoid\]/);
    assert.match(theme, /function syncWidgetOffset\(\)/);
    assert.match(theme, /--vtx-widget-lift/);
    assert.match(theme, /syncWidgetOffset,/);
    assert.match(theme, /addEventListener\("resize", syncWidgetOffset\)/);
});

test("9.5.0：聊天页把底部输入区标记为需要避让", () => {
    const chatroom = read("chatroom.html");
    assert.match(chatroom, /data-vtx-widget-avoid/);
    assert.match(chatroom, /function syncThemeWidget\(\)/);
    assert.match(chatroom, /window\.VTXTheme\.syncWidgetOffset/);
    assert.match(chatroom, /composer\$\{dissolved \? " readonly" : ""\}" data-vtx-widget-avoid/);

    const chat = read("chat.html");
    assert.match(chat, /<form id="composer" class="composer" data-vtx-widget-avoid>/);
});

test("9.5.0：版本号与 Service Worker 缓存同步", () => {
    const version = JSON.parse(read("version.json"));
    assert.equal(version.version, "9.5.0");
    assert.match(read("vtx-sw.js"), /xring-v9\.5\.0/);
    assert.match(read("vtx-theme.js"), /const VERSION = "9\.5\.0"/);
    assert.match(read("index.html"), /v9\.5\.0/);
});
