import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 12.1.2：VPAN 云盘套餐、上传、下载、分享与配额 */

class MockKV {
    constructor() {
        this.map = new Map();
    }

    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) return null;
        if (type === "json") return typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
        if (type === "arrayBuffer") {
            const value = entry.value;
            if (value instanceof ArrayBuffer) return value;
            if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            return new TextEncoder().encode(String(value)).buffer;
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

let envCount = 0;

function createEnv(money = "10000.00") {
    envCount += 1;
    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        __money: money,
        __ip: `10.86.${Math.floor(envCount / 250)}.${envCount % 250}`
    };
}

async function api(env, method, path, options = {}) {
    const headers = new Headers();
    if (env.__ip) headers.set("cf-connecting-ip", env.__ip);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    let body;
    if (options.raw !== undefined) {
        body = options.raw;
    } else if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
    }
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), env);
    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) return { status: response.status, data: await response.json(), response };
    return { status: response.status, data: await response.arrayBuffer(), response };
}

async function prepare(money = "10000.00") {
    const env = createEnv(money);
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Alice: { password: "password1", username: "爱丽丝", money, trades: [], data: {} },
        Bob: { password: "password1", username: "鲍勃", money: "0.00", trades: [], data: {} }
    }));
    const login = await api(env, "POST", "/api/login", { body: { login: "Alice", password: "password1" } });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    return { env, token: login.data.token };
}

async function uploadInline(env, token, name, content, type = "text/plain") {
    const bytes = new TextEncoder().encode(content);
    const create = await api(env, "POST", "/api/vpan/files", {
        token,
        body: { name, size: bytes.byteLength, type }
    });
    assert.equal(create.status, 201, JSON.stringify(create.data));
    assert.equal(create.data.mode, "inline");
    const id = create.data.file.id;
    const put = await api(env, "PUT", `/api/vpan/files/${id}/content`, { token, raw: bytes });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    const complete = await api(env, "POST", `/api/vpan/files/${id}/complete`, { token });
    assert.equal(complete.status, 200, JSON.stringify(complete.data));
    return create.data.file;
}

test("12.1.2：套餐价格与 10GB 首月优惠", async () => {
    const { env, token } = await prepare();
    const plans = await api(env, "GET", "/api/vpan/plans");
    assert.equal(plans.status, 200);
    assert.equal(plans.data.plans.length, 13);
    const ten = plans.data.plans.find((plan) => plan.id === "vpan-10gb");
    assert.equal(ten.price, "200.00");
    assert.equal(ten.firstPrice, "49.99");
    const free = plans.data.plans.find((plan) => plan.id === "free");
    assert.equal(free.quota, 5 * 1024 ** 3);

    const first = await api(env, "POST", "/api/vpan/subscribe", {
        token,
        body: { planId: "vpan-10gb", password: "password1" }
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.plan.planId, "vpan-10gb");
    assert.equal(first.data.account.money, "9950.01");
    const renew = await api(env, "POST", "/api/vpan/subscribe", {
        token,
        body: { planId: "vpan-10gb", password: "password1" }
    });
    assert.equal(renew.status, 200);
    assert.equal(renew.data.account.money, "9750.01");
});

test("12.1.2：小文件上传、列表、下载、重命名与删除", async () => {
    const { env, token } = await prepare();
    const file = await uploadInline(env, token, "你好.txt", "hello VPAN");
    assert.equal(file.name, "你好.txt");
    assert.equal(file.size, 10);

    const list = await api(env, "GET", "/api/vpan/files", { token });
    assert.equal(list.data.files.length, 1);
    assert.equal(list.data.quotaBytes, 5 * 1024 ** 3);
    assert.equal(list.data.usedBytes, 10);

    const download = await api(env, "GET", `/api/vpan/files/${file.id}/download`, { token });
    assert.equal(download.status, 200);
    assert.equal(new TextDecoder().decode(download.data), "hello VPAN");

    const renamed = await api(env, "PATCH", `/api/vpan/files/${file.id}`, { token, body: { name: "改名.txt" } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.file.name, "改名.txt");

    const removed = await api(env, "DELETE", `/api/vpan/files/${file.id}`, { token });
    assert.equal(removed.status, 200);
    const after = await api(env, "GET", "/api/vpan/files", { token });
    assert.equal(after.data.files.length, 0);
});

test("12.1.2：分享链接、密码与公开下载", async () => {
    const { env, token } = await prepare();
    const file = await uploadInline(env, token, "分享.txt", "shared data");
    const created = await api(env, "POST", `/api/vpan/files/${file.id}/share`, {
        token,
        body: { password: "1234", days: 7 }
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const share = created.data.share;
    const noPassword = await api(env, "GET", `/api/vpan/share/${share.token}`);
    assert.equal(noPassword.status, 401);
    assert.equal(noPassword.data.error, "password_required");
    const wrong = await api(env, "GET", `/api/vpan/share/${share.token}?password=0000`);
    assert.equal(wrong.status, 401);
    const ok = await api(env, "GET", `/api/vpan/share/${share.token}?password=1234`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.file.name, "分享.txt");
    const download = await api(env, "GET", `/api/vpan/share/${share.token}/download?password=1234`);
    assert.equal(download.status, 200);
    assert.equal(new TextDecoder().decode(download.data), "shared data");
});

test("12.1.2：超过 5GB 免费配额时拒绝上传", async () => {
    const { env, token } = await prepare();
    const rejected = await api(env, "POST", "/api/vpan/files", {
        token,
        body: { name: "big.bin", size: 6 * 1024 ** 3, type: "application/octet-stream" }
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.data.error, "quota_exceeded");
});
