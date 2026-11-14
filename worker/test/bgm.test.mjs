import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 11.0.0：BGM 听歌赚钱 */

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
        BGM_MIN_ELAPSED_MS: "0",
        __ip: `10.84.${Math.floor(envCount / 250)}.${envCount % 250}`
    };
}

async function api(env, method, path, options = {}) {
    const headers = new Headers();
    if (env.__ip) headers.set("cf-connecting-ip", env.__ip);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers }), env);
    return { status: response.status, data: await response.json() };
}

test("登录后开始播放 BGM，并按服务端时间发放 0.01 VTX", async () => {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} }
    }));
    const login = await worker.fetch(new Request("https://api.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "Alice", password: "password1" })
    }), env);
    const token = (await login.json()).token;

    const start = await api(env, "POST", "/api/me/bgm/start", { token });
    assert.equal(start.status, 200, JSON.stringify(start.data));
    assert.equal(start.data.intervalMs, 20000);
    assert.equal(start.data.rewardCents, 1);

    const first = await api(env, "POST", "/api/me/bgm/reward", { token });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.earned, 1);
    assert.equal(first.data.balance, "10.01");
    assert.equal(first.data.bgm.earnedCents, 1);
    assert.equal(first.data.bgm.seconds, 20);

    const second = await api(env, "POST", "/api/me/bgm/reward", { token });
    assert.equal(second.data.earned, 1);
    assert.equal(second.data.balance, "10.02");
    assert.equal(second.data.bgm.earnedCents, 2);
});

test("历史科学计数法余额不会被听歌奖励写成 0", async () => {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Alice: { password: "password1", username: "爱丽丝", money: "1e+40", trades: [], data: {} }
    }));
    const login = await worker.fetch(new Request("https://api.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "Alice", password: "password1" })
    }), env);
    const token = (await login.json()).token;
    await api(env, "POST", "/api/me/bgm/start", { token });
    const reward = await api(env, "POST", "/api/me/bgm/reward", { token });
    assert.equal(reward.status, 200, JSON.stringify(reward.data));
    assert.equal(reward.data.balance, "1" + "0".repeat(40) + ".01");
    assert.notEqual(reward.data.balance, "0.01");
    assert.equal(reward.data.balance, "1" + "0".repeat(40) + ".01");
});

test("没有开始播放或未登录时不能领奖", async () => {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} }
    }));
    const login = await worker.fetch(new Request("https://api.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "Alice", password: "password1" })
    }), env);
    const token = (await login.json()).token;

    const anonymous = await api(env, "POST", "/api/me/bgm/reward");
    assert.equal(anonymous.status, 401);

    const notStarted = await api(env, "POST", "/api/me/bgm/reward", { token });
    assert.equal(notStarted.status, 400);
    assert.equal(notStarted.data.error, "bgm_not_started");
});

test("未满间隔时返回 earned 0", async () => {
    const env = createEnv();
    env.BGM_MIN_ELAPSED_MS = "18500";
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} }
    }));
    const login = await worker.fetch(new Request("https://api.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "Alice", password: "password1" })
    }), env);
    const token = (await login.json()).token;
    await api(env, "POST", "/api/me/bgm/start", { token });
    const early = await api(env, "POST", "/api/me/bgm/reward", { token });
    assert.equal(early.status, 200);
    assert.equal(early.data.earned, 0);
    assert.ok(early.data.nextIn > 0);
});
