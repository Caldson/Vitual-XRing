import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import worker from "../index.js";

/* 8.2.1：XOS 虚拟云电脑商店授权与桌面入口 */

class MockKV {
    constructor() {
        this.map = new Map();
    }

    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (type === "json") return typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
        return entry.value;
    }

    async put(key, value) {
        this.map.set(key, { value });
    }

    async delete(key) {
        this.map.delete(key);
    }

    async list() {
        return { keys: Array.from(this.map.keys()).map((name) => ({ name })) };
    }
}

const CATALOG = {
    version: "8.0",
    "XOS虚拟云电脑": [
        {
            id: "xos-pc-home-26h1",
            name: "XOS PC Home 26H1",
            price: "1000.00",
            description: "家庭版",
            virtual: true,
            type: "xos",
            xosEdition: "home",
            xosRank: 0,
            xosConfig: { resolution: "1440x900", cpu: "XOS CPU V1 2025" },
            refreshRates: [15],
            xosApps: ["任务管理器"]
        },
        {
            id: "xos-pc-personal-26h1",
            name: "XOS PC Personal 26H1",
            price: "1250.00",
            description: "个人版",
            virtual: true,
            type: "xos",
            xosEdition: "personal",
            xosRank: 1,
            xosConfig: { resolution: "1440x900", cpu: "XOS Core V1 2025" },
            refreshRates: [15, 20, 24, 30],
            xosApps: ["任务管理器", "VSCode 移植版"]
        },
        {
            id: "xos-pc-professional-26h1",
            name: "XOS PC Professional 26H1",
            price: "1500.00",
            description: "专业版",
            virtual: true,
            type: "xos",
            xosEdition: "professional",
            xosRank: 2,
            refreshRates: [15, 20, 24, 30, 60],
            xosApps: ["任务管理器", "Blender"]
        },
        {
            id: "xos-pc-home-26h2",
            name: "XOS PC Home 26H2",
            price: "1025.00",
            description: "家庭版 V2",
            virtual: true,
            type: "xos",
            xosEdition: "home",
            xosRank: 0,
            xosGeneration: 2,
            xosUpgradePrice: "25.00",
            xosConfig: { resolution: "1440x900", cpu: "XOS CPU V1 2025" },
            refreshRates: [15],
            xosApps: ["任务管理器", "番茄钟", "3D 画图"]
        },
        {
            id: "xos-pc-home-26h3",
            name: "XOS PC Home 26H3 V2.1",
            price: "1025.00",
            description: "家庭版 V2.1",
            virtual: true,
            type: "xos",
            xosEdition: "home",
            xosRank: 0,
            xosGeneration: 3,
            xosUpgradePrice: "0.00",
            xosConfig: { resolution: "1440x900", cpu: "XOS CPU V1 2025" },
            refreshRates: [15],
            xosApps: ["任务管理器", "番茄钟", "3D 画图", "VitualGit"]
        },
        {
            id: "xos-pc-home-v31-26h3-s1",
            name: "XOS PC Home V3.1 26H3 Snapshot 1",
            price: "1025.00",
            description: "家庭版 V3.1，支持中文/英语/日语",
            virtual: true,
            type: "xos",
            xosEdition: "home",
            xosRank: 0,
            xosGeneration: 4,
            xosVersion: "V3.1",
            xosSnapshot: "Snapshot 1",
            xosLanguageSupport: ["zh-CN", "en", "ja"],
            xosConfig: { resolution: "1440x900", cpu: "XOS CPU V1 2025" },
            refreshRates: [15],
            xosApps: ["任务管理器", "番茄钟", "3D 画图", "VitualGit"]
        },
        {
            id: "xos-pc-gamemax-26h2",
            name: "XOS PC GameMAX 26H2 [高性能] [需要使用强劲的电脑]",
            price: "3000.00",
            description: "高性能游戏版",
            virtual: true,
            type: "xos",
            xosEdition: "gamemax",
            xosRank: 3,
            xosGeneration: 2,
            xosFpsWarning: 1500,
            xosFpsWarningMax: 30000,
            xosConfig: { resolution: "1440x900", cpu: "XOS ULTRA V4 2026", gpu: "XOS Graphic ULTRA 2026", memory: "10TB" },
            refreshRates: [15, 240, 1500, 30000],
            xosApps: ["任务管理器"]
        }
    ]
};

const SEED = {
    Alice: { password: "password1", username: "爱丽丝", money: "5000.00", trades: [], data: {} }
};

let envCount = 0;

function createEnv() {
    envCount += 1;
    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        SHOP_CATALOG: CATALOG,
        __ip: `10.88.${Math.floor(envCount / 250)}.${envCount % 250}`
    };
}

async function api(env, method, path, options = {}) {
    const headers = new Headers();
    if (env.__ip) headers.set("cf-connecting-ip", env.__ip);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    let body;
    if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
    }
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), env);
    const type = response.headers.get("content-type") || "";
    return {
        status: response.status,
        data: type.includes("application/json") ? await response.json() : await response.text()
    };
}

async function prepare() {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const login = await api(env, "POST", "/api/login", { body: { login: "Alice", password: "password1" } });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    return { env, token: login.data.token };
}

test("8.2.1：购买 XOS 授权写入账户，并只允许购买一份", async () => {
    const { env, token } = await prepare();

    const shop = await api(env, "GET", "/api/shop");
    assert.equal(shop.status, 200);
    assert.equal(shop.data.stock["xos-pc-home-26h1"], 9999);

    const home = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(home.status, 200, JSON.stringify(home.data));
    assert.equal(home.data.account.xos.edition, "home");
    assert.equal(home.data.account.xos.rank, 0);
    assert.equal(home.data.stock, null);
    assert.match(home.data.receipt, /XOS/);

    const again = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-personal-26h1", quantity: 2, password: "password1" }
    });
    assert.equal(again.status, 400);

    const personal = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-personal-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(personal.status, 200, JSON.stringify(personal.data));
    assert.equal(personal.data.account.xos.edition, "personal");
    assert.equal(personal.data.account.xos.rank, 1);
    assert.equal(personal.data.account.xosDevices.length, 2);

    const me = await api(env, "GET", "/api/me", { token });
    assert.equal(me.status, 200);
    assert.equal(me.data.account.xos.edition, "personal");
    assert.equal(me.data.account.xos.apps.includes("VSCode 移植版"), true);
    assert.equal(me.data.account.xosDevices.length, 2);
});

test("8.2.1：没有 XOS1 时按完整 V2 价格购买", async () => {
    const { env, token } = await prepare();
    const v2 = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h2", quantity: 1, password: "password1" }
    });
    assert.equal(v2.status, 200, JSON.stringify(v2.data));
    assert.equal(v2.data.item.unitPrice, "1025.00");
    assert.equal(v2.data.account.xos.generation, 2);
    assert.equal(v2.data.account.xosDevices.length, 1);
    assert.equal(v2.data.account.money, "3975.00");
});

test("8.2.1：购买 GameMAX 写入高性能配置和极端帧率提示", async () => {
    const { env, token } = await prepare();
    const game = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-gamemax-26h2", quantity: 1, password: "password1" }
    });
    assert.equal(game.status, 200, JSON.stringify(game.data));
    assert.equal(game.data.item.unitPrice, "3000.00");
    assert.equal(game.data.account.money, "2000.00");
    assert.equal(game.data.account.xos.edition, "gamemax");
    assert.equal(game.data.account.xos.config.memory, "10TB");
    assert.equal(game.data.account.xos.fpsWarning, 1500);
    assert.equal(game.data.account.xos.fpsWarningMax, 30000);
});

test("8.2.1：XOS1 同版本可以另付 25 VTX 升级到 XOS2", async () => {
    const { env, token } = await prepare();
    const v1 = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(v1.status, 200);
    assert.equal(v1.data.account.xos.generation, 1);

    const upgrade = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h2", quantity: 1, password: "password1" }
    });
    assert.equal(upgrade.status, 200, JSON.stringify(upgrade.data));
    assert.equal(upgrade.data.account.xos.generation, 2);
    assert.equal(upgrade.data.item.unitPrice, "25.00");
    assert.match(upgrade.data.receipt, /升级/);
    assert.equal(upgrade.data.account.money, "3975.00");
    assert.equal(upgrade.data.account.xosDevices.length, 1);

    const again = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h2", quantity: 1, password: "password1" }
    });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.item.unitPrice, "1025.00");
    assert.equal(again.data.account.xosDevices.length, 2);
    assert.equal(again.data.account.money, "2950.00");
});

test("8.2.1：26H2 可以免费升级到 26H3 V2.1", async () => {
    const { env, token } = await prepare();
    const v2 = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h2", quantity: 1, password: "password1" }
    });
    assert.equal(v2.status, 200);
    assert.equal(v2.data.account.money, "3975.00");

    const upgrade = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h3", quantity: 1, password: "password1" }
    });
    assert.equal(upgrade.status, 200, JSON.stringify(upgrade.data));
    assert.equal(upgrade.data.item.unitPrice, "0.00");
    assert.equal(upgrade.data.account.money, "3975.00");
    assert.equal(upgrade.data.account.xos.generation, 3);
    assert.equal(upgrade.data.account.xosDevices.length, 1);
    assert.match(upgrade.data.receipt, /26H3 V2\.1 免费升级/);
});

test("8.2.1：V3.1 26H3 Snapshot 1 支持中日英并完整计价", async () => {
    const { env, token } = await prepare();
    const v31 = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-v31-26h3-s1", quantity: 1, password: "password1" }
    });
    assert.equal(v31.status, 200, JSON.stringify(v31.data));
    assert.equal(v31.data.item.unitPrice, "1025.00");
    assert.equal(v31.data.account.xos.generation, 4);
    assert.equal(v31.data.account.money, "3975.00");
    assert.equal(v31.data.account.xosDevices.length, 1);
    assert.deepEqual(v31.data.account.xos.languageSupport, ["zh-CN", "en", "ja"]);
});

test("8.2.1：同一版本也可以购买多台", async () => {
    const { env, token } = await prepare();
    const first = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(first.status, 200);
    const second = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.account.xosDevices.length, 2);
    assert.equal(second.data.account.money, "3000.00");
    assert.notEqual(second.data.account.xosDevices[0].id, second.data.account.xosDevices[1].id);
});

test("8.2.1：可以购买多台不同版本的 XOS", async () => {
    const { env, token } = await prepare();
    const pro = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-professional-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(pro.status, 200);
    assert.equal(pro.data.account.xos.edition, "professional");
    const home = await api(env, "POST", "/api/me/purchase", {
        token,
        body: { id: "xos-pc-home-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(home.status, 200, JSON.stringify(home.data));
    assert.equal(home.data.account.xos.edition, "home");
    assert.equal(home.data.account.xosDevices.length, 2);
    assert.equal(home.data.account.money, "2500.00");

    const me = await api(env, "GET", "/api/me", { token });
    assert.equal(me.data.account.xos.edition, "home");
    assert.equal(me.data.account.xosDevices.length, 2);
});

test("8.2.1：XOS 页面、商店分类和版本号齐全", () => {
    const page = fs.readFileSync(new URL("../../xos.html", import.meta.url), "utf8");
    const shop = fs.readFileSync(new URL("../../shop.json", import.meta.url), "utf8");
    const shopPage = fs.readFileSync(new URL("../../shop.html", import.meta.url), "utf8");
    const home = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const manager = fs.readFileSync(new URL("../../manager.html", import.meta.url), "utf8");
    assert.match(page, /Home 26H1/);
    assert.match(page, /Personal 26H1/);
    assert.match(page, /Professional 26H1/);
    assert.match(page, /CE \(Community Edition\) 26H2/);
    assert.doesNotMatch(page, /Commiluty/i);
    for (const app of ["任务管理器", "文件资源管理器", "VBrowser", "共享文件", "画图", "TXTPro", "计算器", "天气", "Microsoft Todo", "Outlook", "屏幕截图", "Visual Studio Code", "3D 画图", "Blender", "Musescore 4", "VitualGit", "Blockbench", "MIDI 播放器", "计时器", "番茄钟", "库乐队", "Development Kit", "Development Kit CE"]) {
        assert.match(page, new RegExp(app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `缺少 ${app}`);
    }
    assert.match(page, /data-file-quick/);
    assert.match(page, /data-file-path-input/);
    assert.match(page, /Pictures/);
    assert.match(page, /browser-app/);
    assert.match(page, /flex: 1 1 auto/);
    assert.match(page, /syncCloudFiles/);
    assert.match(page, /xos-cloud-status/);
    assert.match(page, /queueCloudSave/);
    assert.match(page, /API\.xos\.saveFile/);
    assert.match(page, /返回主页/);
    assert.match(page, /href="index\.html" title="返回 Vitual XRing 主页"/);
    const sdk = fs.readFileSync(new URL("../../vtx-api.js", import.meta.url), "utf8");
    assert.match(sdk, /listFiles: \(\) => apiRequest\("\/xos\/files"\)/);
    assert.match(page, /Home 26H2/);
    assert.match(page, /Personal 26H2/);
    assert.match(page, /GameVersion/);
    assert.match(page, /GameULTRA/);
    assert.match(page, /GameMAX/);
    assert.match(page, /此帧率过于极端，可能会导致电脑卡顿\/蓝屏\/黑屏\/变砖，真的要打开吗？/);
    assert.match(page, /PAGE_VERSION = "8\.2\.1"/);
    assert.match(page, /API\.version !== PAGE_VERSION/);
    assert.match(page, /function editionForDevice/);
    assert.match(page, /rank >= 3\) return "ce"/);
    assert.match(page, /xos-device-btn/);
    assert.match(page, /xos-device-menu/);
    assert.match(page, /xos-start-search/);
    assert.match(page, /xos-top-actions/);
    assert.match(page, /data-edition/);
    assert.match(page, /xos-user-menu/);
    assert.match(shop, /"xos-pc-home-26h2"/);
    assert.match(shop, /"xos-pc-game-26h2"/);
    assert.match(shop, /"xos-pc-gameultra-26h2"/);
    assert.match(shop, /"xos-pc-gamemax-26h2"/);
    assert.match(shop, /"price": "2000.00"/);
    assert.match(shop, /"price": "2750.00"/);
    assert.match(shop, /"price": "3000.00"/);
    assert.match(shop, /"xos-pc-ce-26h2"/);
    assert.match(shop, /"price": "1525.00"/);
    assert.match(shop, /"price": "1775.00"/);
    const catalog = JSON.parse(shop);
    const xosItems = catalog["XOS虚拟云电脑"];
    assert.equal(xosItems[0].id, "xos-pc-home-v31-26h3-s1");
    assert.equal(xosItems[6].id, "xos-pc-gamemax-v31-26h3-s1");
    assert.equal(xosItems[7].id, "xos-pc-home-26h3");
    assert.equal(xosItems[13].id, "xos-pc-gamemax-26h3");
    assert.equal(xosItems[14].id, "xos-pc-home-26h2");
    assert.equal(xosItems[20].id, "xos-pc-gamemax-26h2");
    assert.equal(xosItems[21].id, "xos-pc-home-26h1");
    assert.equal(xosItems.slice(0, 7).every((item) => Number(item.xosGeneration) === 4), true);
    assert.equal(xosItems.slice(7, 14).every((item) => Number(item.xosGeneration) === 3), true);
    assert.equal(xosItems.slice(14, 21).every((item) => Number(item.xosGeneration) === 2), true);
    assert.equal(xosItems.slice(21).every((item) => Number(item.xosGeneration) !== 4), true);
    assert.equal(xosItems.slice(0, 7).every((item) => item.xosApps.every((app) => app !== "GitHub Desktop" && app !== "Git")), true);
    assert.equal(xosItems.slice(0, 7).every((item) => item.xosLanguageSupport.includes("en") && item.xosLanguageSupport.includes("ja")), true);
    assert.match(page, /APPS\.vitualgit/);
    assert.doesNotMatch(page, /APPS\.github/);
    const bundleItem = catalog["同捆包 [Beta]"].find((item) => item.id === "bundle-xos-ce-gamemax-26h2");
    assert.equal(bundleItem.manufacturer, "XRing");
    assert.match(shopPage, /merchant-panel/);
    assert.match(shopPage, /merchant-form/);
    assert.match(fs.readFileSync(new URL("../../accounts-admin.html", import.meta.url), "utf8"), /merchant-product-panel/);
    assert.match(shop, /Community Edition/);
    assert.match(page, /vtx-api\.js\?v=8\.2\.1/);
    assert.match(page, /API\.me\(\)/);
    assert.match(shop, /"XOS虚拟云电脑"/);
    assert.match(shop, /"xos-pc-ce-26h1"/);
    assert.match(shopPage, /get\("category"\)/);
    assert.match(shopPage, /class="xos-entry"/);
    assert.match(home, /href="xos\.html"/);
    assert.match(home, /v8\.2\.1/);
    assert.match(home, /Vitual XRing/);
    assert.doesNotMatch(home, /Virtual XRing/);
    assert.match(home, /XRingLogo-V\.png\?v=8\.2\.1/);
    assert.doesNotMatch(home, /<img src="XRingLogo\.png"/);
    assert.equal(fs.existsSync(new URL("../../XRingLogo-V.png", import.meta.url)), true);
    assert.match(manager, /href="xos\.html"/);
    assert.match(page, /top: var\(--xos-shell-top\) !important;/);
    assert.match(page, /height: calc\(100% - 166px\) !important;/);
    assert.match(page, /function joinPath/);
    assert.match(page, /if \(!path\) return;/);
});
