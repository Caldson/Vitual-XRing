import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("7.3.1：页面缓存与离线入口齐全", () => {
    const sw = read("vtx-sw.js");
    const pwa = read("vtx-pwa.js");
    assert.match(sw, /xring-v7\.3\.1/);
    assert.match(sw, /offline\.html/);
    assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
    assert.match(sw, /version\.json/);
    assert.match(pwa, /CLIENT_VERSION = "7\.3\.1"/);
    assert.match(pwa, /clearPageCaches/);
    assert.match(pwa, /checkForNewVersion/);
    assert.match(pwa, /isNewerVersion/);
    assert.match(pwa, /unregister/);
    assert.match(pwa, /location\.replace/);
    assert.match(pwa, /serviceWorker\.register/);
    assert.equal(fs.existsSync(new URL("offline.html", root)), true);
    assert.equal(fs.existsSync(new URL("version.json", root)), true);
    const version = JSON.parse(read("version.json"));
    assert.equal(version.version, "7.3.1");
    for (const page of ["index.html", "shop.html", "xos.html", "vitualgit.html", "vuolingo.html"]) {
        assert.match(read(page), /vtx-pwa\.js\?v=7\.3\.1/, `${page} 缺少 PWA 注册`);
    }
    assert.match(read("xos.html"), /loadOfflineAccount/);
    assert.match(read("xos.html"), /xos:offlineAccount/);
});

test("7.3.1：商店搜索框和过滤逻辑齐全", () => {
    const shop = read("shop.html");
    assert.match(shop, /id="shop-search"/);
    assert.match(shop, /shopQuery/);
    assert.match(shop, /没有找到匹配的商品/);
});

test("7.3.1：VitualGit 删除 GitHub 登录预告，保留 Proxy 镜像", () => {
    const page = read("vitualgit.html");
    assert.match(page, /VitualGit/);
    assert.match(page, /gh-proxy\.com/);
    assert.match(page, /Vitual XRing 登录/);
    assert.match(page, /api\.github\.com/);
    assert.doesNotMatch(page, /GitHub 登录将在 8\.0\.0/);
    assert.doesNotMatch(page, /GitHub OAuth 登录/);
});

test("7.3.1：Vuolingo 语言选择、添加语言和课程内容", () => {
    const page = read("vuolingo.html");
    assert.match(page, /选择你要学习的语言/);
    assert.match(page, /添加语言/);
    assert.match(page, /vuolingo:languages/);
    for (const word of ["Food", "Rice", "Water", "Sushi", "Tea", "Please give me a xxx.", "Could you give me a xxx, please?", "Could you please give me a xxx?", "May I have a xxx?", "Excuse me."]) {
        assert.match(page, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `缺少英语词条 ${word}`);
    }
    for (const word of ["ごはん", "みず", "すし", "おちゃ", "xxx、ください", "おはようございます", "すみません"]) {
        assert.match(page, new RegExp(word), `缺少日语词条 ${word}`);
    }
    assert.match(page, /让我们说数字/);
    assert.match(page, /第一阶段第 1 单元/);
    assert.match(page, /第 1 节 · 第 2 课/);
    assert.match(page, /第 1 节 · 第 3 课/);
    assert.match(page, /section: `第 1 节 · 第 \$\{index \+ 4\} 课`/);
    assert.match(page, /title: `让我们说数字 \$\{index \+ 1\}`/);
    assert.match(page, /numberLessonObjects\("en"\)/);
    assert.match(page, /numberLessonObjects\("ja"\)/);
    assert.match(page, /tenAndHundred/);
    assert.match(page, /uniqueWords/);
    assert.match(page, /course\.lessons\.length/);
    assert.match(page, /vuolingo:progress/);
    assert.match(page, /lessonUnlocked/);
    assert.match(page, /markLessonComplete/);
    assert.match(page, /按顺序解锁/);
    assert.match(page, /请先完成/);
    for (const romaji of ["konnichiwa", "ohayou", "konbanwa", "gohan", "mizu", "sushi", "ocha", "sumimasen", "juu", "hyaku"]) {
        assert.match(page, new RegExp(romaji), `缺少罗马音 ${romaji}`);
    }
    assert.match(page, /displayTarget/);
    assert.match(page, /罗马音/);
});

test("7.3.1：Vuolingo 题型完整且听力/口语可关闭", () => {
    const page = read("vuolingo.html");
    for (const label of ["英/日译中", "中译英/日", "单词拼写", "听写", "跟读", "背诵", "阅读"]) {
        assert.match(page, new RegExp(label.replace("/", "\\/")), `缺少题型 ${label}`);
    }
    assert.match(page, /DEFAULT_TYPES/);
    assert.match(page, /listening: false/);
    assert.match(page, /shadowing: false/);
    assert.match(page, /recitation: false/);
    assert.match(page, /speechSynthesis/);
    assert.match(page, /renderChoiceOptions/);
    assert.match(page, /acceptedAnswers/);
    assert.match(page, /こんにちわ/);
    assert.match(page, /こんばんわ/);
});

test("7.3.1：首页和账户页有 VitualGit / Vuolingo 入口", () => {
    const home = read("index.html");
    const manager = read("manager.html");
    assert.match(home, /vitualgit\.html/);
    assert.match(home, /vuolingo\.html/);
    assert.match(manager, /vitualgit\.html/);
    assert.match(manager, /vuolingo\.html/);
});

test("7.3.1：XOS 26H3 产品、VitualGit 与免费升级", () => {
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
