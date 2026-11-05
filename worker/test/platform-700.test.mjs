import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("7.0.0：页面缓存与离线入口齐全", () => {
    const sw = read("vtx-sw.js");
    const pwa = read("vtx-pwa.js");
    assert.match(sw, /xring-v7\.0\.0/);
    assert.match(sw, /offline\.html/);
    assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
    assert.match(pwa, /serviceWorker\.register/);
    assert.equal(fs.existsSync(new URL("offline.html", root)), true);
    for (const page of ["index.html", "shop.html", "xos.html", "vitualgit.html", "vuolingo.html"]) {
        assert.match(read(page), /vtx-pwa\.js\?v=7\.0\.0/, `${page} 缺少 PWA 注册`);
    }
    assert.match(read("xos.html"), /loadOfflineAccount/);
    assert.match(read("xos.html"), /xos:offlineAccount/);
});

test("7.0.0：商店搜索框和过滤逻辑齐全", () => {
    const shop = read("shop.html");
    assert.match(shop, /id="shop-search"/);
    assert.match(shop, /shopQuery/);
    assert.match(shop, /没有找到匹配的商品/);
});

test("7.0.0：VitualGit 页面、Proxy 镜像与 8.0 GitHub 登录预告", () => {
    const page = read("vitualgit.html");
    assert.match(page, /VitualGit/);
    assert.match(page, /gh-proxy\.com/);
    assert.match(page, /GitHub 登录将在 8\.0\.0 上线/);
    assert.match(page, /Vitual XRing 登录/);
    assert.match(page, /api\.github\.com/);
    assert.doesNotMatch(page, /github.*client_id/i);
});

test("7.0.0：Vuolingo 英语和日语打招呼课程、点击词汇翻译", () => {
    const page = read("vuolingo.html");
    for (const word of ["Hello", "Goodbye", "Good morning", "Good afternoon", "こんにちは", "おはよう", "こんばんは", "またあした"]) {
        assert.match(page, new RegExp(word));
    }
    assert.match(page, /第一阶段第 1 单元/);
    assert.match(page, /打招呼/);
    assert.match(page, /点击词汇查看翻译/);
    assert.match(page, /showTranslation/);
});

test("7.0.0：首页和账户页有 VitualGit / Vuolingo 入口", () => {
    const home = read("index.html");
    const manager = read("manager.html");
    assert.match(home, /vitualgit\.html/);
    assert.match(home, /vuolingo\.html/);
    assert.match(manager, /vitualgit\.html/);
    assert.match(manager, /vuolingo\.html/);
});

test("7.0.0：XOS 26H3 产品、VitualGit 与免费升级", () => {
    const shop = JSON.parse(read("shop.json"));
    const items = shop["XOS虚拟云电脑"];
    const h3 = items.filter((item) => Number(item.xosGeneration) === 3);
    assert.equal(h3.length, 7);
    assert.equal(h3.every((item) => item.xosUpgradePrice === "0.00"), true);
    assert.equal(h3.filter((item) => Number(item.xosRank) >= 2).every((item) => item.xosApps.includes("VitualGit")), true);
    assert.equal(h3.every((item) => !item.xosApps.includes("GitHub Desktop")), true);
    assert.equal(h3.every((item) => !item.xosApps.includes("Git")), true);
    const page = read("xos.html");
    assert.match(page, /APPS\.vitualgit/);
    assert.doesNotMatch(page, /APPS\.github/);
    assert.match(page, /generationLabel/);
    const bundle = shop["同捆包 [Beta]"].find((item) => item.id === "bundle-xos-ce-gamemax-26h2");
    assert.equal(bundle.manufacturer, "XRing");
});
