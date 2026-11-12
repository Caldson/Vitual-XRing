import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 9.5.1：XOS 文件同步到 Workers KV */

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
    version: "9.0",
    "XOS虚拟云电脑": [
        {
            id: "xos-pc-home-26h1",
            name: "XOS PC Home 26H1",
            price: "1000.00",
            virtual: true,
            type: "xos",
            xosEdition: "home",
            xosRank: 0,
            xosConfig: { resolution: "1440x900" },
            refreshRates: [15],
            xosApps: ["文件资源管理器"]
        }
    ]
};

const SEED = {
    Alice: { password: "password1", username: "爱丽丝", money: "5000.00", trades: [], data: {} },
    Bob: { password: "password1", username: "鲍勃", money: "10.00", trades: [], data: {} }
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
        __ip: `10.89.${Math.floor(envCount / 250)}.${envCount % 250}`
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
    const tokens = {};
    for (const login of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", { body: { login, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[login] = result.data.token;
    }
    const license = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Alice,
        body: { id: "xos-pc-home-26h1", quantity: 1, password: "password1" }
    });
    assert.equal(license.status, 200, JSON.stringify(license.data));
    return { env, tokens };
}

test("9.5.1：XOS 文件可上传、列出、读取、更新和删除", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/xos/files", {
        token: tokens.Alice,
        body: { path: "Documents/跨设备.txt", type: "text/plain", content: "hello cloud" }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.file.path, "Documents/跨设备.txt");
    assert.equal(created.data.file.size, 11);

    const list = await api(env, "GET", "/api/xos/files", { token: tokens.Alice });
    assert.equal(list.status, 200);
    assert.equal(list.data.files.length, 1);
    assert.equal(list.data.quota.maxFileBytes, 8 * 1024 * 1024);

    const read = await api(env, "GET", `/api/xos/files/${created.data.file.id}`, { token: tokens.Alice });
    assert.equal(read.status, 200);
    assert.equal(read.data.content, "hello cloud");

    const updated = await api(env, "PUT", `/api/xos/files/${created.data.file.id}`, {
        token: tokens.Alice,
        body: { content: "hello XOS 26H2" }
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.file.size, 14);

    const crossDevice = await api(env, "GET", "/api/xos/files", { token: tokens.Alice });
    assert.equal(crossDevice.data.files[0].size, 14);

    const removed = await api(env, "DELETE", `/api/xos/files/${created.data.file.id}`, { token: tokens.Alice });
    assert.equal(removed.status, 200);
    const after = await api(env, "GET", "/api/xos/files", { token: tokens.Alice });
    assert.equal(after.data.files.length, 0);
});

test("9.5.1：没有 XOS 授权不能使用云文件", async () => {
    const { env, tokens } = await prepare();
    const denied = await api(env, "GET", "/api/xos/files", { token: tokens.Bob });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "xos_license_required");
});

test("9.5.1：路径和文件大小做基本校验", async () => {
    const { env, tokens } = await prepare();
    const badPath = await api(env, "POST", "/api/xos/files", {
        token: tokens.Alice,
        body: { path: "../escape.txt", content: "x" }
    });
    assert.equal(badPath.status, 400);

    const huge = await api(env, "POST", "/api/xos/files", {
        token: tokens.Alice,
        body: { path: "Documents/huge.txt", content: "x".repeat(8 * 1024 * 1024 + 1) }
    });
    assert.equal(huge.status, 413);
});
