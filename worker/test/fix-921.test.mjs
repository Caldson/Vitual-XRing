import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import worker from "../index.js";

/* 9.3.0：大额 VTX 精确签到、版本缓存与主题样式修复 */

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

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

let envCount = 0;

function createEnv(money) {
    envCount += 1;
    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        __money: money,
        __ip: `10.87.${Math.floor(envCount / 250)}.${envCount % 250}`
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
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
}

async function prepare(money) {
    const env = createEnv(money);
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Alice: { password: "password1", username: "爱丽丝", money, trades: [], data: {} },
        Bob: { password: "password1", username: "鲍勃", money: "0.00", trades: [], data: {} }
    }));
    const tokens = {};
    for (const login of ["Alice", "Bob"]) {
        const result = await api(env, "POST", "/api/login", { body: { login, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[login] = result.data.token;
    }
    return { env, tokens };
}

test("9.3.0：超过 Number 安全范围的余额也能精确 +5 VTX", async () => {
    const { env, tokens } = await prepare("1000000009043627695.00");
    const response = await api(env, "POST", "/api/me/checkin", { token: tokens.Alice });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.account.money, "1000000009043627700.00");
});

test("9.3.0：普通余额签到仍然正常", async () => {
    const { env, tokens } = await prepare("998995.00");
    const response = await api(env, "POST", "/api/me/checkin", { token: tokens.Alice });
    assert.equal(response.status, 200);
    assert.equal(response.data.account.money, "999000.00");
});

test("9.3.0：大额余额转出 5 VTX 后仍然精确", async () => {
    const { env, tokens } = await prepare("1000000009043627695.00");
    const response = await api(env, "POST", "/api/me/transfer", {
        token: tokens.Alice,
        body: { to: "Bob", amount: "5.00", password: "password1" }
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.account.money, "1000000009043627690.00");
    const bob = await api(env, "GET", "/api/me", { token: tokens.Bob });
    assert.equal(bob.data.account.money, "5.00");
});

test("9.3.0：Service Worker 不再忽略 ?v= 查询串，版本重试不再只限一次", () => {
    const sw = read("vtx-sw.js");
    const pwa = read("vtx-pwa.js");
    assert.doesNotMatch(sw, /cache\.match\(request, \{ ignoreSearch: true \}\)/);
    assert.match(pwa, /attempts >= 3/);
    assert.match(pwa, /updateViaCache: "none"/);
    assert.match(sw, /xring-v9\.3\.0/);
});

test("9.3.0：账户主页的登录位置按钮与签到按钮有明暗主题 / 状态样式", () => {
    const manager = read("manager.html");
    assert.match(manager, /\[data-theme="dark"\] \.account-shortcut/);
    assert.match(manager, /\.checkin-button:not\(:disabled\)/);
    assert.match(manager, /\.checkin-button:disabled/);
    assert.match(read("index.html"), /打开 Vord 文档/);
    assert.match(read("manager.html"), /href="vord\.html"/);
});
