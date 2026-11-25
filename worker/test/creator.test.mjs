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

test("15.0.0：VDEX 套餐、注册扣费、保存与公开访问", async () => {
    const { env, token } = await prepare();
    const plans = await api(env, "GET", "/api/vdex/plans");
    assert.equal(plans.status, 200);
    assert.ok(plans.data.plans.some((plan) => plan.gb === 1 && plan.tier === "standard" && plan.price === 50));
    assert.ok(plans.data.plans.some((plan) => plan.gb === 100 && plan.tier === "enterprise" && plan.price === 12800));
    assert.ok(plans.data.plans.some((plan) => plan.tier === "light" && plan.price === 10));

    const bad = await api(env, "POST", "/api/vdex/register", { token, body: { name: "Bad_Name", gb: 1, tier: "standard" } });
    assert.equal(bad.status, 400);

    const created = await api(env, "POST", "/api/vdex/register", { token, body: { name: "alice-site", gb: 1, tier: "standard" } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.site.server, undefined);
    const account = JSON.parse(await env.ACCOUNTS_KV.get("accounts"));
    assert.equal(account.Alice.money, "950.00");
    assert.ok(account.Alice.trades.some((trade) => trade.name === "VDEX" && trade.price === "-50.00"));

    const saved = await api(env, "PUT", "/api/vdex/save", { token, body: { name: "alice-site", title: "Alice 的站点", html: "<h1>Hello</h1>", css: "h1{color:red}", js: "console.log(1)", pages: { "index.html": "<h1>Hello</h1>", "second.html": "<h1>Second</h1>" } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const publicSite = await api(env, "GET", "/api/vdex/site?name=alice-site");
    assert.equal(publicSite.status, 200);
    assert.equal(publicSite.data.site.html, "<h1>Hello</h1>");
    assert.equal(publicSite.data.site.title, "Document");
    assert.ok(publicSite.data.site.pages.includes("second.html"));
    const titled = await api(env, "PUT", "/api/vdex/save", { token, body: { name: "alice-site", html: "<!doctype html><html><head><title>Alice 站点</title></head><body>Hi</body></html>" } });
    assert.equal(titled.data.site.title, "Alice 站点");
    assert.equal(publicSite.data.site.owner, "Alice");

    const free = await api(env, "POST", "/api/vdex/register", { token, body: { name: "free-site", gb: 0.1, tier: "light" } });
    assert.equal(free.status, 201, JSON.stringify(free.data));
    const freeSite = await api(env, "GET", "/api/vdex/site?name=free-site");
    assert.equal(freeSite.status, 200);
    assert.equal(freeSite.data.site.plan, "light");
    const afterLight = JSON.parse(await env.ACCOUNTS_KV.get("accounts"));
    assert.equal(afterLight.Alice.money, "940.00");
    assert.ok(afterLight.Alice.trades.some((trade) => trade.name === "VDEX" && trade.price === "-10.00"));
    const poor = await api(env, "POST", "/api/vdex/register", { token, body: { name: "too-big", gb: 100, tier: "enterprise" } });
    assert.equal(poor.status, 400);
});

test("15.0.0：Vtoy 保存应用与公开读取", async () => {
    const { env, token } = await prepare();
    const bad = await api(env, "POST", "/api/vtoy/apps", { token, body: { name: "Bad/App", html: "x" } });
    assert.equal(bad.status, 400);
    const saved = await api(env, "POST", "/api/vtoy/apps", { token, body: { name: "hello-toy", title: "Hello", description: "测试", html: "<h1>Hi</h1>", css: "", js: "", permissions: ["login"], pages: { "index.html": "<h1>Hi</h1>", "second.html": "<h1>Toy second</h1>" } } });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const named = await api(env, "POST", "/api/vtoy/apps", { token, body: { name: "中文 App_01", html: "<h1>宽松名称</h1>" } });
    assert.equal(named.status, 201, JSON.stringify(named.data));
    const namedPub = await api(env, "GET", `/api/vtoy/apps?name=${encodeURIComponent("中文 App_01")}`);
    assert.equal(namedPub.status, 200);
    assert.equal(namedPub.data.app.name, "中文 App_01");
    const badVdex = await api(env, "POST", "/api/vdex/register", { token, body: { name: "Upper_Name", gb: 1, tier: "standard" } });
    assert.equal(badVdex.status, 400);
    const pub = await api(env, "GET", "/api/vtoy/apps?name=hello-toy");
    assert.equal(pub.status, 200);
    assert.equal(pub.data.app.title, "Document");
    assert.ok(pub.data.app.pages.includes("second.html"));
    assert.deepEqual(pub.data.app.permissions, ["login"]);
    assert.equal(pub.data.app.title, "Document");
    assert.ok(pub.data.app.pages.includes("second.html"));
    const mine = await api(env, "GET", "/api/vtoy/mine", { token });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.apps.length, 2);
});

test("15.0.0：Vtoy 广场发布、审核与使用计数", async () => {
    const { env, token } = await prepare();
    const admin = await api(env, "POST", "/api/login", { body: { login: "Kitawaga", password: "password1" } });
    const made = await api(env, "POST", "/api/vtoy/apps", { token, body: { name: "plaza-toy", description: "广场测试", html: "<h1>Plaza</h1>" } });
    assert.equal(made.status, 201);
    assert.equal(made.data.app.status, "draft");

    const before = await api(env, "GET", "/api/vtoy/plaza");
    assert.ok(!before.data.apps.some((app) => app.name === "plaza-toy"));

    const published = await api(env, "POST", "/api/vtoy/publish", { token, body: { name: "plaza-toy" } });
    assert.equal(published.data.app.status, "pending");
    const pending = await api(env, "GET", "/api/vtoy/pending", { token: admin.data.token });
    assert.ok(pending.data.apps.some((app) => app.name === "plaza-toy"));

    const reviewed = await api(env, "POST", "/api/vtoy/review", { token: admin.data.token, body: { name: "plaza-toy", approve: true } });
    assert.equal(reviewed.data.app.status, "approved");
    const after = await api(env, "GET", "/api/vtoy/plaza");
    assert.ok(after.data.apps.some((app) => app.name === "plaza-toy"));

    const used = await api(env, "POST", "/api/vtoy/use", { body: { name: "plaza-toy" } });
    assert.equal(used.status, 200);
    assert.equal(used.data.uses, 1);
});

test("15.0.0：密码删除 Vtoy 与 VDEX", async () => {
    const { env, token } = await prepare();
    const made = await api(env, "POST", "/api/vtoy/apps", { token, body: { name: "delete-toy", html: "<h1>Delete</h1>" } });
    assert.equal(made.status, 201);
    const wrong = await api(env, "DELETE", "/api/vtoy/apps", { token, body: { name: "delete-toy", password: "wrong" } });
    assert.equal(wrong.status, 400);
    const deleted = await api(env, "DELETE", "/api/vtoy/apps", { token, body: { name: "delete-toy", password: "password1" } });
    assert.equal(deleted.status, 200);

    const site = await api(env, "POST", "/api/vdex/register", { token, body: { name: "delete-site", gb: 0.1, tier: "light" } });
    assert.equal(site.status, 201);
    const wrongSite = await api(env, "DELETE", "/api/vdex/site", { token, body: { name: "delete-site", password: "wrong" } });
    assert.equal(wrongSite.status, 400);
    const deletedSite = await api(env, "DELETE", "/api/vdex/site", { token, body: { name: "delete-site", password: "password1" } });
    assert.equal(deletedSite.status, 200);
});
