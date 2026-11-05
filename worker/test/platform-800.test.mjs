import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("8.0.0：页面缓存与离线入口齐全", () => {
    const sw = read("vtx-sw.js");
    const pwa = read("vtx-pwa.js");
    assert.match(sw, /xring-v8\.0\.0/);
    assert.match(sw, /offline\.html/);
    assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)/);
    assert.match(sw, /version\.json/);
    assert.match(pwa, /CLIENT_VERSION = "8\.0\.0"/);
    assert.match(pwa, /clearPageCaches/);
    assert.match(pwa, /checkForNewVersion/);
    assert.match(pwa, /isNewerVersion/);
    assert.match(pwa, /unregister/);
    assert.match(pwa, /location\.replace/);
    assert.match(pwa, /serviceWorker\.register/);
    assert.equal(fs.existsSync(new URL("offline.html", root)), true);
    assert.equal(fs.existsSync(new URL("version.json", root)), true);
    const version = JSON.parse(read("version.json"));
    assert.equal(version.version, "8.0.0");
    for (const page of ["index.html", "shop.html", "xos.html", "vitualgit.html", "vuolingo.html"]) {
        assert.match(read(page), /vtx-pwa\.js\?v=8\.0\.0/, `${page} 缺少 PWA 注册`);
    }
    assert.match(read("xos.html"), /loadOfflineAccount/);
    assert.match(read("xos.html"), /xos:offlineAccount/);
    assert.match(sw, /settings\.html/);
    assert.match(sw, /vtx-theme\.css/);
    assert.match(sw, /vtx-theme\.js/);
});

test("8.0.0：全站主题、浅色/深色/自动与设置栏目", () => {
    for (const file of ["vtx-theme.css", "vtx-theme.js", "settings.html"]) {
        assert.equal(fs.existsSync(new URL(file, root)), true, `${file} 不存在`);
    }
    const theme = read("vtx-theme.js");
    const css = read("vtx-theme.css");
    const settings = read("settings.html");
    const home = read("index.html");
    assert.match(theme, /THEME_MODES = \["auto", "light", "dark"\]/);
    assert.match(theme, /LANGUAGE_MODES = \["auto", "region", "zh-CN", "zh-TW", "en", "ja"\]/);
    assert.match(theme, /prefers-color-scheme/);
    assert.match(theme, /Asia\/Shanghai|Shanghai/);
    assert.match(theme, /settings\.html/);
    assert.match(css, /\[data-theme="dark"\]/);
    assert.match(css, /--vtx-surface/);
    assert.match(settings, /data-vtx-widget="off"/);
    assert.match(settings, /name="theme" value="auto"/);
    assert.match(settings, /name="theme" value="light"/);
    assert.match(settings, /name="theme" value="dark"/);
    for (const value of ["auto", "region", "zh-CN", "zh-TW", "en", "ja"]) {
        assert.match(settings, new RegExp(`name="language" value="${value}"`), `缺少语言选项 ${value}`);
    }
    assert.match(settings, /跟随设备（默认）/);
    assert.match(settings, /跟随地区/);
    assert.match(settings, /简体中文/);
    assert.match(settings, /繁體中文/);
    assert.match(settings, /English/);
    assert.match(settings, /日本語/);
    assert.match(home, /settings\.html/);
    assert.match(home, /data-i18n="hero\.title1"/);
    assert.match(home, /vtx-theme\.css\?v=8\.0\.0/);
    assert.match(home, /vtx-theme\.js\?v=8\.0\.0/);
    for (const page of ["shop.html", "xos.html", "vitualgit.html", "vuolingo.html", "manager.html"]) {
        assert.match(read(page), /vtx-theme\.css\?v=8\.0\.0/, `${page} 未接入主题`);
        assert.match(read(page), /vtx-theme\.js\?v=8\.0\.0/, `${page} 未接入主题脚本`);
    }
});

test("8.0.0：商店搜索框和过滤逻辑齐全", () => {
    const shop = read("shop.html");
    assert.match(shop, /id="shop-search"/);
    assert.match(shop, /shopQuery/);
    assert.match(shop, /没有找到匹配的商品/);
});

test("8.0.0：VitualGit 删除 GitHub 登录预告，保留 Proxy 镜像", () => {
    const page = read("vitualgit.html");
    assert.match(page, /VitualGit/);
    assert.match(page, /gh-proxy\.com/);
    assert.match(page, /Vitual XRing 登录/);
    assert.match(page, /api\.github\.com/);
    assert.doesNotMatch(page, /GitHub 登录将在 8\.0\.0/);
    assert.doesNotMatch(page, /GitHub OAuth 登录/);
});

test("8.0.0：Vuolingo 语言选择、添加语言和课程内容", () => {
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

test("8.0.0：Vuolingo 题型完整且听力/口语可关闭", () => {
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

test("8.0.0：首页和账户页有 VitualGit / Vuolingo 入口", () => {
    const home = read("index.html");
    const manager = read("manager.html");
    assert.match(home, /vitualgit\.html/);
    assert.match(home, /vuolingo\.html/);
    assert.match(manager, /vitualgit\.html/);
    assert.match(manager, /vuolingo\.html/);
});

test("8.0.0：XOS 26H3 产品、VitualGit 与免费升级", () => {
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
