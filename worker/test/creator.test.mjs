import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

class MockKV {
    constructor() { this.map = new Map(); }
    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (type === "json") return typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
        return entry.value;
    }
    async put(key, value) { this.map.set(key, { value }); }
    async delete(key) { this.map.delete(key); }
    async list(options = {}) {
        const prefix = options.prefix || "";
        return { keys: Array.from(this.map.keys()).filter((key) => key.startsWith(prefix)).map((name) => ({ name })) };
    }
}

const SEED = {
    Kitawaga: { password: "password1", username: "站主", money: "100000.00", trades: [], data: {} },
    Alice: { password: "password1", username: "爱丽丝", money: "1000.00", trades: [], data: {} }
};

async function api(env, method, path, options = {}) {
    const headers = new Headers({ "cf-connecting-ip": "10.55.0.1" });
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    let body;
    if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
    }
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), env);
    const type = response.headers.get("content-type") || "";
    return { status: response.status, data: type.includes("application/json") ? await response.json() : await response.text() };
}

async function prepare() {
    const env = { ACCOUNTS_KV: new MockKV(), SIGNING_SECRET: "test-secret", ADMIN_ACCOUNT: "Kitawaga", ALLOWED_ORIGINS: "*", TOKEN_TTL_SECONDS: "3600", PUBLIC_BASE: "https://api.test" };
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const login = await api(env, "POST", "/api/login", { body: { login: "Alice", password: "password1" } });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    return { env, token: login.data.token };
}

test("12.0.0：VDEX 套餐、注册扣费、保存与公开访问", async () => {
    const { env, token } = await prepare();
    const plans = await api(env, "GET", "/api/vdex/plans");
    assert.equal(plans.status, 200);
    assert.ok(plans.data.plans.some((plan) => plan.gb === 1 && plan.tier === "standard" && plan.price === 50));
    assert.ok(plans.data.plans.some((plan) => plan.gb === 100 && plan.tier === "enterprise" && plan.price === 12800));

    const bad = await api(env, "POST", "/api/vdex/register", { token, body: { name: "Bad_Name", gb: 1, tier: "standard" } });
    assert.equal(bad.status, 400);

    const created = await api(env, "POST", "/api/vdex/register", { token, body: { name: "alice-site", gb: 1, tier: "standard" } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.site.server.host, "ssh.vdex.caldson.us.ci");
    assert.equal(created.data.site.server.username, "alice-site");
    assert.ok(created.data.site.server.password.length >= 12);
    const account = JSON.parse(await env.ACCOUNTS_KV.get("accounts"));
    assert.equal(account.Alice.money, "950.00");
    assert.ok(account.Alice.trades.some((trade) => trade.name === "VDEX" && trade.price === "-50.00"));

    const saved = await api(env, "PUT", "/api/vdex/save", { token, body: { name: "alice-site", title: "Alice 的站点", html: "<h1>Hello</h1>", css: "h1{color:red}", js: "console.log(1)" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const publicSite = await api(env, "GET", "/api/vdex/site?name=alice-site");
    assert.equal(publicSite.status, 200);
    assert.equal(publicSite.data.site.html, "<h1>Hello</h1>");
    assert.equal(publicSite.data.site.owner, "Alice");

    const free = await api(env, "POST", "/api/vdex/register", { token, body: { name: "free-site", gb: 0.1, tier: "free" } });
    assert.equal(free.status, 201, JSON.stringify(free.data));
    const freeSite = await api(env, "GET", "/api/vdex/site?name=free-site");
    assert.equal(freeSite.status, 200);
    assert.equal(freeSite.data.site.plan, "free");
    const poor = await api(env, "POST", "/api/vdex/register", { token, body: { name: "too-big", gb: 100, tier: "enterprise" } });
    assert.equal(poor.status, 400);
});

test("12.0.0：Vtoy 保存应用与公开读取", async () => {
    const { env, token } = await prepare();
    const bad = await api(env, "POST", "/api/vtoy/apps", { token, body: { name: "Bad_App", html: "x" } });
    assert.equal(bad.status, 400);
    const saved = await api(env, "POST", "/api/vtoy/apps", { token, body: { name: "hello-toy", title: "Hello", description: "测试", html: "<h1>Hi</h1>", css: "", js: "", permissions: ["login"] } });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const pub = await api(env, "GET", "/api/vtoy/apps?name=hello-toy");
    assert.equal(pub.status, 200);
    assert.equal(pub.data.app.title, "Hello");
    assert.deepEqual(pub.data.app.permissions, ["login"]);
    const mine = await api(env, "GET", "/api/vtoy/mine", { token });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.apps.length, 1);
});
