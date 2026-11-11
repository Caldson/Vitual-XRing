import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 管理员添加收款 / 付款记录：可同时调整余额，也可仅记录 */

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

let envCount = 0;

function createEnv() {
    envCount += 1;
    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        __ip: `10.85.${Math.floor(envCount / 250)}.${envCount % 250}`
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
    return { status: response.status, data: await response.json() };
}

async function prepare() {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Kitawaga: { password: "password1", username: "站主", money: "0.00", trades: [], data: {} },
        Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} },
        Bob: { password: "password1", username: "鲍勃", money: "10.00", trades: [], data: {} }
    }));
    const tokens = {};
    for (const login of ["Kitawaga", "Alice", "Bob"]) {
        const result = await api(env, "POST", "/api/login", { body: { login, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[login] = result.data.token;
    }
    return { env, tokens };
}

test("管理员添加收款记录并同时调整余额", async () => {
    const { env, tokens } = await prepare();
    const result = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "income", amount: "100.00", description: "活动奖励", applyMoney: true }
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.applied, true);
    assert.equal(result.data.account.money, "110.00");
    assert.equal(result.data.trade.name, "收款");
    assert.equal(result.data.trade.price, "+100.00");
    assert.equal(result.data.account.trades[0].description, "活动奖励");
});

test("管理员可以只记录付款，不改动余额", async () => {
    const { env, tokens } = await prepare();
    const result = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "expense", amount: "500.00", description: "历史补录", applyMoney: false }
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.applied, false);
    assert.equal(result.data.account.money, "10.00");
    assert.equal(result.data.trade.name, "付款");
    assert.equal(result.data.trade.price, "-500.00");
});

test("付款会检查余额，余额不足时拒绝且不写记录", async () => {
    const { env, tokens } = await prepare();
    const result = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "expense", amount: "50.00", applyMoney: true }
    });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, "insufficient_funds");
    const read = await api(env, "GET", "/api/me", { token: tokens.Alice });
    assert.equal(read.data.account.money, "10.00");
    assert.equal(read.data.account.trades.length, 0);
});

test("自动模式按调整后的余额自动判断收款 / 付款", async () => {
    const { env, tokens } = await prepare();
    const up = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "auto", amount: "110.00", description: "自动调整" }
    });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.type, "income");
    assert.equal(up.data.applied, true);
    assert.equal(up.data.previousMoney, "10.00");
    assert.equal(up.data.account.money, "110.00");
    assert.equal(up.data.trade.name, "收款");
    assert.equal(up.data.trade.price, "+100.00");

    const down = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "auto", amount: "3.00", description: "自动下调" }
    });
    assert.equal(down.status, 200, JSON.stringify(down.data));
    assert.equal(down.data.type, "expense");
    assert.equal(down.data.account.money, "3.00");
    assert.equal(down.data.trade.name, "付款");
    assert.equal(down.data.trade.price, "-107.00");

    const zero = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "auto", amount: "0" }
    });
    assert.equal(zero.status, 200, JSON.stringify(zero.data));
    assert.equal(zero.data.account.money, "0.00");
    assert.equal(zero.data.trade.price, "-3.00");
});

test("自动模式余额没有变化或为负数时拒绝", async () => {
    const { env, tokens } = await prepare();
    const same = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "auto", amount: "10.00" }
    });
    assert.equal(same.status, 400);
    assert.equal(same.data.error, "no_change");

    const negative = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Kitawaga,
        body: { type: "auto", amount: "-1.00" }
    });
    assert.equal(negative.status, 400);
});

test("非管理员与非法参数被拒绝", async () => {
    const { env, tokens } = await prepare();
    const forbidden = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
        token: tokens.Bob,
        body: { type: "income", amount: "1.00" }
    });
    assert.equal(forbidden.status, 403);

    for (const body of [
        { type: "other", amount: "1.00" },
        { type: "income", amount: "0" },
        { type: "income", amount: "-1" },
        { type: "income", amount: "abc" }
    ]) {
        const result = await api(env, "POST", "/api/admin/accounts/Alice/trades", {
            token: tokens.Kitawaga,
            body
        });
        assert.equal(result.status, 400, JSON.stringify(result.data));
    }
});
