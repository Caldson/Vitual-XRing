import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 10.1.3：开场动画 / 音效限制、设置项、顶部栏与纯色 V 图标 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("10.1.3：开场动画只从站内跳转触发，每 2 小时最多一次，可跳过", () => {
    const bgm = read("vtx-bgm.js");
    assert.match(bgm, /document\.referrer/);
    assert.match(bgm, /xsmmc\.caldson\.us\.ci/);
    assert.match(bgm, /2 \* 60 \* 60 \* 1000/);
    assert.match(bgm, /vtx-opening/);
    assert.match(bgm, /vtx-opening-skip/);
    assert.match(bgm, /10000/);
    assert.match(bgm, /vtx:opening:last/);
});

test("10.1.3：设置页提供开场音效 / 完整动画开关", () => {
    const settings = read("settings.html");
    assert.match(settings, /id="opening-enabled"/);
    assert.match(settings, /id="opening-short"/);
    assert.match(settings, /vtx:opening:enabled/);
    assert.match(settings, /vtx:opening:short/);
    assert.match(read("vtx-bgm.js"), /vtx:opening:enabled/);
    assert.match(read("vtx-bgm.js"), /vtx:opening:short/);
});

test("10.1.3：账户页顶部栏移除 VPAN / Vord，品牌 V 图标为纯色", () => {
    const manager = read("manager.html");
    const topbar = manager.split("</header>")[0];
    assert.doesNotMatch(topbar, /href="vpan\.html"/);
    assert.doesNotMatch(topbar, /href="vord\.html"/);
    const css = read("vtx-theme.css");
    assert.match(css, /\.brand-mark\s*\{/);
    assert.match(css, /background: #3867e8 !important/);
    assert.match(css, /background-image: none !important/);
});
