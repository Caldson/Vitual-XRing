import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import worker from "../index.js";

/* 12.1.3：XOS 云手机、XOS PC V4 26H4 与共享文件软件 */

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

const PHONE = {
    id: "xphone-1",
    name: "XPhone 1",
    price: "750.00",
    description: "云手机",
    virtual: true,
    type: "xos",
    xosFormFactor: "phone",
    xosEdition: "home",
    xosRank: 0,
    xosGeneration: 3,
    xosPhonePro: false,
    xosConfig: { resolution: "1170 × 2532", cpu: "XOS Phone CPU V1 2026" },
    refreshRates: [60],
    xosApps: ["任务管理器", "共享文件"]
};

const PHONE_PRO = {
    ...PHONE,
    id: "xphone-1-pro",
    name: "XPhone 1 Pro",
    price: "1000.00",
    description: "云手机 Pro",
    xosPhonePro: true,
    xosFileSharing: "send-receive"
};

const V31 = {
    id: "xos-pc-home-v31-26h3-s1",
    name: "XOS PC Home V3.1 26H3 Snapshot 1",
    price: "1025.00",
    description: "V3.1",
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
    xosApps: ["任务管理器", "共享文件"]
};

const V4 = {
    ...V31,
    id: "xos-pc-home-v4-26h4",
    name: "XOS PC Home V4 26H4",
    price: "1125.00",
    description: "V4",
    xosGeneration: 5,
    xosVersion: "V4",
    xosSnapshot: "26H4",
    xosUpgradePrice: "25.00",
    xosUpgradeFrom: "V3.1 26H3 Snapshot 1",
    xosFileSharing: "send-receive"
};

const APP_PHONE = {
    id: "xos-app-shared-files-xphone",
    name: "共享文件（XPhone 1 Pro 下载版）",
    price: "0.00",
    description: "下载共享文件",
    virtual: true,
    type: "xosapp",
    appId: "shared-files",
    appScope: "xphone",
    appAction: "download"
};

const APP_PC = {
    id: "xos-app-shared-files-v4",
    name: "共享文件 V4 更新（XOS PC 26H4）",
    price: "0.00",
    description: "更新共享文件",
    virtual: true,
    type: "xosapp",
    appId: "shared-files",
    appScope: "pc-v4",
    appAction: "update"
};

const CATALOG = {
    version: "13.0",
    "XOS虚拟云电脑": [V4, V31, APP_PC],
    "XOS云手机": [PHONE, PHONE_PRO, APP_PHONE]
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
        __ip: `10.98.${Math.floor(envCount / 250)}.${envCount % 250}`
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

async function buy(env, token, id) {
    return api(env, "POST", "/api/me/purchase", {
        token,
        body: { id, quantity: 1, password: "password1" }
    });
}

test("12.1.3：购买 XPhone 1 / Pro 写入云手机授权", async () => {
    const { env, token } = await prepare();

    const phone = await buy(env, token, "xphone-1");
    assert.equal(phone.status, 200, JSON.stringify(phone.data));
    assert.equal(phone.data.item.unitPrice, "750.00");
    assert.equal(phone.data.account.xos.formFactor, "phone");
    assert.equal(phone.data.account.xos.phonePro, false);
    assert.equal(phone.data.account.xos.generation, 3);
    assert.equal(phone.data.account.money, "4250.00");
    assert.match(phone.data.receipt, /云手机/);

    const pro = await buy(env, token, "xphone-1-pro");
    assert.equal(pro.status, 200, JSON.stringify(pro.data));
    assert.equal(pro.data.item.unitPrice, "1000.00");
    assert.equal(pro.data.account.xos.formFactor, "phone");
    assert.equal(pro.data.account.xos.phonePro, true);
    assert.equal(pro.data.account.xos.fileSharing, "send-receive");
    assert.equal(pro.data.account.xosDevices.length, 2);
    assert.equal(pro.data.account.money, "3250.00");

    // 云手机不参与 PC 的世代升级：再买 V2.1 不会替换已有手机
    const v21 = await buy(env, token, "xos-pc-home-v31-26h3-s1");
    assert.equal(v21.status, 200, JSON.stringify(v21.data));
    assert.equal(v21.data.item.unitPrice, "1025.00");
    assert.equal(v21.data.account.xosDevices.length, 3);
});

test("12.1.3：V3.1 可 25 VTX 升级到 V4 26H4，否则按 1125 计价", async () => {
    const { env, token } = await prepare();
    const v31 = await buy(env, token, "xos-pc-home-v31-26h3-s1");
    assert.equal(v31.status, 200, JSON.stringify(v31.data));
    assert.equal(v31.data.account.money, "3975.00");

    const upgrade = await buy(env, token, "xos-pc-home-v4-26h4");
    assert.equal(upgrade.status, 200, JSON.stringify(upgrade.data));
    assert.equal(upgrade.data.item.unitPrice, "25.00");
    assert.equal(upgrade.data.account.money, "3950.00");
    assert.equal(upgrade.data.account.xos.generation, 5);
    assert.equal(upgrade.data.account.xos.fileSharing, "send-receive");
    assert.equal(upgrade.data.account.xosDevices.length, 1);
    assert.match(upgrade.data.receipt, /V4 26H4 升级/);

    const second = await buy(env, token, "xos-pc-home-v4-26h4");
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.item.unitPrice, "1125.00");
    assert.equal(second.data.account.xosDevices.length, 2);
    assert.equal(second.data.account.money, "2825.00");
});

test("12.1.3：共享文件软件需对应设备，免费获取且不可重复", async () => {
    const { env, token } = await prepare();

    const beforePhone = await buy(env, token, "xos-app-shared-files-xphone");
    assert.equal(beforePhone.status, 400);
    assert.match(beforePhone.data.message, /XPhone 1 Pro/);

    const beforePc = await buy(env, token, "xos-app-shared-files-v4");
    assert.equal(beforePc.status, 400);
    assert.match(beforePc.data.message, /V4 26H4/);

    const phone = await buy(env, token, "xphone-1");
    assert.equal(phone.status, 200, JSON.stringify(phone.data));
    const notPro = await buy(env, token, "xos-app-shared-files-xphone");
    assert.equal(notPro.status, 400);
    assert.match(notPro.data.message, /XPhone 1 Pro/);

    const pro = await buy(env, token, "xphone-1-pro");
    assert.equal(pro.status, 200, JSON.stringify(pro.data));
    const moneyBefore = pro.data.account.money;
    const granted = await buy(env, token, "xos-app-shared-files-xphone");
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    assert.equal(granted.data.item.unitPrice, "0.00");
    assert.equal(granted.data.account.money, moneyBefore);
    assert.equal(granted.data.account.xosApps.length, 1);
    assert.equal(granted.data.account.xosApps[0].appId, "shared-files");
    assert.equal(granted.data.account.xosApps[0].scope, "xphone");
    assert.equal(granted.data.account.xosDevices.length, 2);

    const again = await buy(env, token, "xos-app-shared-files-xphone");
    assert.equal(again.status, 400);
    assert.match(again.data.message, /已经获取/);

    const v4 = await buy(env, token, "xos-pc-home-v4-26h4");
    assert.equal(v4.status, 200, JSON.stringify(v4.data));
    const pcUpdate = await buy(env, token, "xos-app-shared-files-v4");
    assert.equal(pcUpdate.status, 200, JSON.stringify(pcUpdate.data));
    assert.equal(pcUpdate.data.account.xosApps.length, 2);
    assert.equal(pcUpdate.data.account.xosApps.some((entry) => entry.scope === "pc-v4"), true);

    const me = await api(env, "GET", "/api/me", { token });
    assert.equal(me.status, 200);
    assert.equal(Array.isArray(me.data.account.xosApps), true);
    assert.equal(me.data.account.xosApps.length, 2);
});

test("12.1.3：旧版 XOS PC 没有共享服务，云手机与 V4 的目录字段齐全", () => {
    const shop = JSON.parse(fs.readFileSync(new URL("../../shop.json", import.meta.url), "utf8"));
    assert.equal(shop.version, "13.0");
    const pcs = shop["XOS虚拟云电脑"];
    const v4 = pcs.filter((item) => Number(item.xosGeneration) === 5);
    assert.equal(v4.length, 7);
    assert.equal(v4.every((item) => item.xosUpgradePrice === "25.00"), true);
    assert.equal(v4.every((item) => item.xosFileSharing === "send-receive"), true);
    assert.equal(v4.every((item) => item.xosLanguageSupport.includes("en") && item.xosLanguageSupport.includes("ja")), true);
    const prices = { home: "1125.00", personal: "1375.00", professional: "1625.00", ce: "1875.00", game: "2100.00", gameultra: "2850.00", gamemax: "3100.00" };
    assert.equal(v4.every((item) => item.price === prices[item.xosEdition]), true);
    const old = pcs.filter((item) => Number(item.xosGeneration) < 5 && item.type === "xos");
    assert.equal(old.every((item) => !item.xosFileSharing), true);

    const phones = shop["XOS云手机"];
    assert.equal(phones.find((item) => item.id === "xphone-1").price, "750.00");
    assert.equal(phones.find((item) => item.id === "xphone-1-pro").price, "1000.00");
    assert.equal(phones.find((item) => item.id === "xphone-1-pro").xosFileSharing, "send-receive");
    assert.equal(phones.find((item) => item.id === "xphone-1-pro").xosPhonePro, true);
    assert.equal(phones.find((item) => item.id === "xphone-1").xosPhonePro, false);
    const apps = pcs.concat(phones).filter((item) => item.type === "xosapp");
    assert.equal(apps.length, 2);
    assert.equal(apps.every((item) => item.price === "0.00" && item.virtual === true), true);
});

test("12.1.3：XOS 页面包含云手机、V4 与文件共享服务", () => {
    const page = fs.readFileSync(new URL("../../xos.html", import.meta.url), "utf8");
    assert.match(page, /PAGE_VERSION = "12\.1\.3"/);
    assert.match(page, /xos-phone/);
    assert.match(page, /xos-phone-appview/);
    assert.match(page, /PHONES = \[/);
    assert.match(page, /XPhone 1 Pro/);
    assert.match(page, /XOS File Sharing Service/);
    assert.match(page, /BroadcastChannel/);
    assert.match(page, /xos-share:/);
    assert.match(page, /Shared\/Received/);
    assert.match(page, /shareCapability/);
    assert.match(page, /Vitual Store/);
    assert.match(page, /value >= 5/);
    assert.match(page, /26H4 V4/);
    assert.match(page, /generation: 5/);
    assert.match(page, /xos-phone-mode|phone-mode/);
});
