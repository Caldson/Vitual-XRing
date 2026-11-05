import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import worker from "../index.js";

/* 7.3.0：登录位置独立页、群公告关闭、周边的人（10km） */

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
        if (type === "arrayBuffer") {
            return entry.value instanceof ArrayBuffer ? entry.value : entry.value.buffer;
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
        PUBLIC_BASE: "https://api.test",
        __ip: `10.42.${Math.floor(prepareCount / 250)}.${prepareCount % 250}`
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
        const result = await api(env, "POST", "/api/login", { body: { login, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[login] = result.data.token;
    }
    return { env, tokens };
}

function seedChatUsers(env, options = {}) {
    const blockedByBob = Array.isArray(options.bobBlocked) ? options.bobBlocked : [];
    return Promise.all([
        env.ACCOUNTS_KV.put("chat:user:Alice", JSON.stringify({
            login: "Alice",
            conversations: [],
            friends: [{ login: "Bob", name: "鲍勃", at: Date.now() }],
            blocked: [],
            settings: {}
        })),
        env.ACCOUNTS_KV.put("chat:user:Bob", JSON.stringify({
            login: "Bob",
            conversations: [],
            friends: [{ login: "Alice", name: "爱丽丝", at: Date.now() }],
            blocked: blockedByBob,
            settings: {}
        }))
    ]);
}

test("7.3.0：登录位置已从账户页拆到 loginplaces.html", () => {
    const manager = fs.readFileSync(new URL("../../manager.html", import.meta.url), "utf8");
    const page = fs.readFileSync(new URL("../../loginplaces.html", import.meta.url), "utf8");
    assert.match(manager, /href="loginplaces\.html"/);
    assert.match(manager, /class="account-shortcut"/);
    assert.match(manager, /id="withdraw-card"[\s\S]*account-shortcut[\s\S]*class="records-card"/);
    assert.doesNotMatch(manager, /topbar-link" href="loginplaces\.html"/);
    assert.doesNotMatch(manager, /id="locations-list"/);
    assert.doesNotMatch(manager, /renderLoginLocations/);
    assert.match(page, /const API = window\.VTXApi/);
    assert.match(page, /API\.me\(\)/);
    assert.match(page, /loginHistory/);
    assert.match(page, /vtx-geo\.js\?v=7\.3\.0/);
    assert.match(page, /v7\.3\.0/);
    assert.match(page, /location/);
});

test("7.3.0：群公告可以按当前公告文本关闭，公告更新后重新显示", async () => {
    const { env, tokens } = await prepare();
    await seedChatUsers(env);

    const group = await api(env, "POST", "/api/chat/conversations/group", {
        token: tokens.Alice,
        body: { name: "公告测试群", members: ["Bob"] }
    });
    assert.equal(group.status, 201, JSON.stringify(group.data));
    const id = group.data.conversation.id;

    const announcement = await api(env, "PUT", `/api/chat/conversations/${id}/announcement`, {
        token: tokens.Alice,
        body: { text: "第一次公告", pinned: false }
    });
    assert.equal(announcement.status, 200, JSON.stringify(announcement.data));

    const before = await api(env, "GET", `/api/chat/conversations/${id}`, { token: tokens.Bob });
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.equal(before.data.conversation.announcementHidden, false);

    const hidden = await api(env, "POST", `/api/chat/conversations/${id}/settings`, {
        token: tokens.Bob,
        body: { announcementHiddenText: "第一次公告" }
    });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.data));

    const closed = await api(env, "GET", `/api/chat/conversations/${id}`, { token: tokens.Bob });
    assert.equal(closed.data.conversation.announcementHidden, true);

    const updated = await api(env, "PUT", `/api/chat/conversations/${id}/announcement`, {
        token: tokens.Alice,
        body: { text: "第二次公告", pinned: false }
    });
    assert.equal(updated.status, 200);
    const reopened = await api(env, "GET", `/api/chat/conversations/${id}`, { token: tokens.Bob });
    assert.equal(reopened.data.conversation.announcementHidden, false);

    const shown = await api(env, "POST", `/api/chat/conversations/${id}/settings`, {
        token: tokens.Bob,
        body: { announcementHiddenText: "" }
    });
    assert.equal(shown.status, 200);
});

test("7.3.0：周边的人只返回 10km 内、最近 30 分钟且未被拉黑的账户", async () => {
    const { env, tokens } = await prepare();
    await seedChatUsers(env);

    const alice = await api(env, "POST", "/api/chat/nearby", {
        token: tokens.Alice,
        body: { latitude: 30, longitude: 120 }
    });
    assert.equal(alice.status, 200, JSON.stringify(alice.data));
    assert.equal(alice.data.radiusKm, 10);
    assert.equal(alice.data.items.length, 0);

    await api(env, "POST", "/api/chat/nearby", {
        token: tokens.Bob,
        body: { latitude: 30.01, longitude: 120.01 }
    });
    await api(env, "POST", "/api/chat/nearby", {
        token: tokens.Kitawaga,
        body: { latitude: 31, longitude: 121 }
    });

    const result = await api(env, "POST", "/api/chat/nearby", {
        token: tokens.Alice,
        body: { latitude: 30, longitude: 120 }
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0].login, "Bob");
    assert.equal(result.data.items[0].username, "鲍勃");
    assert.ok(result.data.items[0].distanceKm > 0 && result.data.items[0].distanceKm <= 10);
    assert.equal(result.data.items.some((item) => item.login === "Alice"), false);
    assert.equal(result.data.items.some((item) => item.login === "Kitawaga"), false);

    const invalid = await api(env, "POST", "/api/chat/nearby", {
        token: tokens.Alice,
        body: { latitude: 200, longitude: 120 }
    });
    assert.equal(invalid.status, 400);

    await seedChatUsers(env, { bobBlocked: ["Alice"] });
    const blocked = await api(env, "POST", "/api/chat/nearby", {
        token: tokens.Alice,
        body: { latitude: 30, longitude: 120 }
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.data.items.length, 0);
});

test("7.3.0：聊天室有「附近」入口、公告关闭按钮，SDK 有 nearby", () => {
    const chat = fs.readFileSync(new URL("../../chatroom.html", import.meta.url), "utf8");
    assert.match(chat, /data-tab="nearby"/);
    assert.match(chat, /function loadNearby/);
    assert.match(chat, /api\.chat\.nearby/);
    assert.match(chat, /announce-close/);
    assert.match(chat, /setAnnouncementHidden/);

    const sdk = fs.readFileSync(new URL("../../vtx-api.js", import.meta.url), "utf8");
    assert.match(sdk, /nearby: \(latitude, longitude\)/);
});
