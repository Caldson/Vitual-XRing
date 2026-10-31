import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import worker from "../index.js";

/* 2.1.0：礼品兑换码（站主创建，用户兑换） */

class MockKV {
    constructor() {
        this.map = new Map();
    }

    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) {
            return null;
        }
        if (type === "json") {
            return typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
        }
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

const SEED = {
    Kitawaga: { password: "password1", username: "站主", money: "100.00", trades: [], data: {} },
    Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} },
    Bob: { password: "password1", username: "鲍勃", money: "10.00", trades: [], data: {} }
};

let prepareCount = 0;

function createEnv() {
    prepareCount += 1;
    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        __ip: `10.21.${Math.floor(prepareCount / 250)}.${prepareCount % 250}`
    };
}

async function api(env, method, path, options = {}) {
    const headers = new Headers();
    if (env.__ip) {
        headers.set("cf-connecting-ip", env.__ip);
    }
    if (options.token) {
        headers.set("authorization", `Bearer ${options.token}`);
    }
    let body;
    if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
    }
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), env);
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : await response.text();
    return { status: response.status, data };
}

async function prepare() {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const login of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", {
            body: { login, password: "password1" }
        });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[login] = result.data.token;
    }
    return { env, tokens };
}

test("2.1.0：站主可以创建/查看礼品兑换码，普通用户没有权限", async () => {
    const { env, tokens } = await prepare();

    const denied = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Alice,
        body: { name: "10 VTX 礼品", type: "vtx", amount: "10.00" }
    });
    assert.equal(denied.status, 403);

    const created = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "10 VTX 礼品", type: "vtx", amount: "10.00", count: 2 }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.count, 2);
    assert.equal(created.data.codes.length, 2);
    for (const record of created.data.codes) {
        assert.match(record.code, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
        assert.equal(record.gift.type, "vtx");
        assert.equal(record.gift.amount, "10.00");
        assert.equal(record.status, "active");
    }

    const list = await api(env, "GET", "/api/admin/gifts", { token: tokens.Kitawaga });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.equal(list.data.count, 2);

    const deniedList = await api(env, "GET", "/api/admin/gifts", { token: tokens.Alice });
    assert.equal(deniedList.status, 403);

    const badAmount = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "坏礼品", type: "vtx", amount: "0" }
    });
    assert.equal(badAmount.status, 400);

    const manual = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "手动码", type: "item", code: "abcde12345abcde67890", count: 1 }
    });
    assert.equal(manual.status, 201, JSON.stringify(manual.data));
    assert.equal(manual.data.codes[0].code, "ABCDE-12345-ABCDE-67890");

    const duplicate = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "重复码", type: "item", code: "ABCDE-12345-ABCDE-67890" }
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.error, "code_exists");
});

test("2.1.0：用户兑换 VTX 礼品后余额到账、兑换码只能使用一次", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "10 VTX 礼品", type: "vtx", amount: "10.00" }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const code = created.data.codes[0].code;

    const first = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code }
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.account.money, "20.00");
    assert.equal(first.data.gift.type, "vtx");
    assert.equal(first.data.gift.amount, "10.00");
    assert.equal(first.data.trade.price, "+10.00");
    assert.match(first.data.message, /兑换成功/);

    const second = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code }
    });
    assert.equal(second.status, 400);
    assert.equal(second.data.error, "gift_used");

    const bob = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Bob,
        body: { code }
    });
    assert.equal(bob.status, 400);
    assert.equal(bob.data.error, "gift_used");

    const list = await api(env, "GET", "/api/admin/gifts", { token: tokens.Kitawaga });
    const record = list.data.codes.find((item) => item.code === code);
    assert.equal(record.status, "used");
    assert.equal(record.usedBy, "Alice");
    assert.equal(record.usedByName, "爱丽丝");

    const invalid = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code: "NOT-A-CODE" }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, "bad_code");

    const missing = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code: "ABCDE-12345-ABCDE-00000" }
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, "not_found");
});

test("2.1.0：礼品可以停用/启用、设置有效期、删除未使用兑换码", async () => {
    const { env, tokens } = await prepare();

    const item = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "XRing 挂件", type: "item", description: "到门店领取" }
    });
    assert.equal(item.status, 201, JSON.stringify(item.data));
    const itemCode = item.data.codes[0].code;

    const redeemedItem = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code: itemCode }
    });
    assert.equal(redeemedItem.status, 200, JSON.stringify(redeemedItem.data));
    assert.equal(redeemedItem.data.gift.type, "item");
    assert.equal(redeemedItem.data.account.money, "10.00");
    assert.equal(redeemedItem.data.trade.price, "+0.00");
    assert.match(redeemedItem.data.message, /XRingCR/);

    const vtx = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "5 VTX", type: "vtx", amount: "5.00", expiresAt: Date.now() + 60000 }
    });
    const code = vtx.data.codes[0].code;

    const disabled = await api(env, "PUT", `/api/admin/gifts/${code}`, {
        token: tokens.Kitawaga,
        body: { status: "disabled" }
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
    assert.equal(disabled.data.code.status, "disabled");

    const denied = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code }
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.data.error, "gift_disabled");

    const enabled = await api(env, "PUT", `/api/admin/gifts/${code}`, {
        token: tokens.Kitawaga,
        body: { status: "active" }
    });
    assert.equal(enabled.status, 200);

    const used = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code }
    });
    assert.equal(used.status, 200, JSON.stringify(used.data));

    const deleteUsed = await api(env, "DELETE", `/api/admin/gifts/${code}`, { token: tokens.Kitawaga });
    assert.equal(deleteUsed.status, 400);
    assert.equal(deleteUsed.data.error, "gift_used");

    const removable = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "待删除", type: "item" }
    });
    const removableCode = removable.data.codes[0].code;
    const removed = await api(env, "DELETE", `/api/admin/gifts/${removableCode}`, { token: tokens.Kitawaga });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    const after = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code: removableCode }
    });
    assert.equal(after.status, 404);
    assert.equal(after.data.error, "not_found");

    const expired = await api(env, "POST", "/api/admin/gifts", {
        token: tokens.Kitawaga,
        body: { name: "过期礼品", type: "vtx", amount: "1.00", expiresAt: Date.now() + 60000 }
    });
    const expiredCode = expired.data.codes[0].code;
    const stored = await env.ACCOUNTS_KV.get("gift:codes", "json");
    stored[expiredCode].expiresAt = Date.now() - 1;
    await env.ACCOUNTS_KV.put("gift:codes", JSON.stringify(stored));

    const expiredRedeem = await api(env, "POST", "/api/me/redeem", {
        token: tokens.Alice,
        body: { code: expiredCode }
    });
    assert.equal(expiredRedeem.status, 400);
    assert.equal(expiredRedeem.data.error, "gift_expired");

    const log = await api(env, "GET", "/api/admin/log", { token: tokens.Kitawaga });
    assert.ok(log.data.entries.some((entry) => entry.action === "gift_create"));
});

test("2.1.0：商店兑换入口、提示与站主礼品面板已接入", () => {
    const shop = fs.readFileSync(new URL("../../shop.html", import.meta.url), "utf8");
    const admin = fs.readFileSync(new URL("../../accounts-admin.html", import.meta.url), "utf8");
    assert.match(shop, /id="redeem-code"/);
    assert.match(shop, /placeholder="ABCDE-12345-ABCDE-67890"/);
    assert.match(
        shop,
        /请在XRingCR相关门店获取礼品兑换码，请勿轻易购买非官方的礼品兑换码，可能造成财产损失！/
    );
    assert.match(shop, /VTXApi\.redeem/);
    assert.match(shop, /vtx-api\.js\?v=3\.1\.0/);
    assert.match(admin, /id="gift-form"/);
    assert.match(admin, /id="gift-type"/);
    assert.match(admin, /adminCreateGift/);
    assert.match(admin, /vtx-api\.js\?v=3\.1\.0/);
});
