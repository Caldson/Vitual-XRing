import test from "node:test";
import assert from "node:assert/strict";

import worker, { AccountsLock } from "../index.js";

/* 1.2.0 安全修复的回归测试：附件类型、服务端定价、保留名、管理员密码脱敏 */

class MockKV {
    constructor() {
        this.map = new Map();
    }

    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) {
            return null;
        }
        const value = entry.value;
        if (type === "json") {
            return typeof value === "string" ? JSON.parse(value) : value;
        }
        if (type === "arrayBuffer") {
            if (value instanceof ArrayBuffer) {
                return value;
            }
            if (ArrayBuffer.isView(value)) {
                return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
            return new TextEncoder().encode(String(value)).buffer;
        }
        return value;
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

const SHOP = {
    version: "1.2.0",
    items: [],
    "测试分类": [
        { id: "test-book", name: "测试本子", price: "5.00", stock: 2, description: "", manufacturer: "XRingCR" }
    ]
};

const SEED = {
    Kitawaga: { password: "password1", username: "站主", money: "100.00", trades: [], data: {} },
    Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} }
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
        SHOP_CATALOG: SHOP,
        // 每个用例用独立 IP，避免命中模块级的登录限流
        __ip: `10.9.${Math.floor(prepareCount / 250)}.${prepareCount % 250}`
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
    } else if (options.raw !== undefined) {
        body = options.raw;
        if (options.contentType) {
            headers.set("content-type", options.contentType);
        }
    }
    for (const [key, value] of Object.entries(options.headers || {})) {
        headers.set(key, value);
    }

    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), env);
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : await response.arrayBuffer();
    return { status: response.status, data, response };
}

async function prepare() {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const name of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", {
            body: { login: name, password: "password1" }
        });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[name] = result.data.token;
    }
    return { env, tokens };
}

test("1.2.0：附件不回放客户端声明的 HTML 类型", async () => {
    const { env, tokens } = await prepare();

    const upload = await api(env, "POST", "/api/chat/media", {
        token: tokens.Alice,
        raw: "<script>alert(1)</script>",
        contentType: "text/html",
        headers: { "x-file-name": "evil.html" }
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.data));
    assert.equal(upload.data.media.type, "application/octet-stream");

    const fetched = await api(env, "GET", `/api/chat/media/${upload.data.media.id}?token=${tokens.Alice}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.response.headers.get("content-type"), "application/octet-stream");
    assert.match(fetched.response.headers.get("content-disposition") || "", /^attachment;/);
    assert.equal(fetched.response.headers.get("x-content-type-options"), "nosniff");
});

test("1.2.0：图片仍然内联显示", async () => {
    const { env, tokens } = await prepare();

    const upload = await api(env, "POST", "/api/chat/media", {
        token: tokens.Alice,
        raw: new Uint8Array([137, 80, 78, 71]).buffer,
        contentType: "image/png",
        headers: { "x-file-name": "ok.png" }
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.data));

    const fetched = await api(env, "GET", `/api/chat/media/${upload.data.media.id}?token=${tokens.Alice}`);
    assert.equal(fetched.response.headers.get("content-type"), "image/png");
    assert.match(fetched.response.headers.get("content-disposition") || "", /^inline;/);
});

test("1.2.0：购买金额以 shop.json 为准，忽略客户端 amount", async () => {
    const { env, tokens } = await prepare();

    const cheaper = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Alice,
        body: { id: "test-book", quantity: 1, amount: "0.01", password: "password1" }
    });
    assert.equal(cheaper.status, 200, JSON.stringify(cheaper.data));
    assert.equal(cheaper.data.trade.price, "-5.00");
    assert.equal(cheaper.data.account.money, "5.00");
    assert.equal(cheaper.data.stock.remaining, 1);

    const tooMany = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Kitawaga,
        body: { id: "test-book", quantity: 2, password: "password1" }
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.data.error, "out_of_stock");

    const unknown = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Alice,
        body: { id: "no-such-item", quantity: 1, password: "password1" }
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.error, "item_not_found");

    const stock = await api(env, "GET", "/api/shop");
    assert.equal(stock.status, 200);
    assert.equal(stock.data.stock["test-book"], 1);
});

test("1.2.0：不能注册/占用管理员登录名", async () => {
    const { env } = await prepare();

    const reserved = await api(env, "POST", "/api/register", {
        body: { login: "kitawaga", password: "password2", username: "假的站主" }
    });
    assert.equal(reserved.status, 409);
    assert.equal(reserved.data.error, "account_reserved");
});

test("1.2.0：管理员账户列表不再返回明文密码", async () => {
    const { env, tokens } = await prepare();

    const list = await api(env, "GET", "/api/admin/accounts", { token: tokens.Kitawaga });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const alice = list.data.accounts.Alice;
    assert.equal(alice.password, undefined);
    assert.equal(alice.hasPassword, true);
});

test("1.2.0：新注册账户在 KV 里只存 PBKDF2 哈希", async () => {
    const { env } = await prepare();

    const created = await api(env, "POST", "/api/register", {
        body: { login: "NewUser", password: "secret123", username: "新人" }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const stored = await env.ACCOUNTS_KV.get("accounts", "json");
    const password = String(stored.NewUser.password);
    assert.ok(password.startsWith("pbkdf2-sha256$"), password);
    assert.ok(!password.includes("secret123"));

    const relogin = await api(env, "POST", "/api/login", {
        body: { login: "NewUser", password: "secret123" }
    });
    assert.equal(relogin.status, 200, JSON.stringify(relogin.data));

    const wrong = await api(env, "POST", "/api/login", {
        body: { login: "NewUser", password: "secret124" }
    });
    assert.equal(wrong.status, 401);
});

test("1.2.0：旧明文密码在登录成功后就地升级为哈希", async () => {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify({
        Legacy: { password: "oldpass1", username: "老账户", money: "0.00", trades: [], data: {} }
    }));

    const before = await env.ACCOUNTS_KV.get("accounts", "json");
    assert.equal(before.Legacy.password, "oldpass1");

    const login = await api(env, "POST", "/api/login", {
        body: { login: "Legacy", password: "oldpass1" }
    });
    assert.equal(login.status, 200, JSON.stringify(login.data));

    const after = await env.ACCOUNTS_KV.get("accounts", "json");
    assert.ok(String(after.Legacy.password).startsWith("pbkdf2-sha256$"), String(after.Legacy.password));

    const again = await api(env, "POST", "/api/login", {
        body: { login: "Legacy", password: "oldpass1" }
    });
    assert.equal(again.status, 200, JSON.stringify(again.data));
});

test("1.2.0：改密码后旧密码失效、新密码可用", async () => {
    const { env, tokens } = await prepare();

    const changed = await api(env, "PUT", "/api/me/password", {
        token: tokens.Alice,
        body: { currentPassword: "password1", newPassword: "brand-new-1" }
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));

    const oldLogin = await api(env, "POST", "/api/login", {
        body: { login: "Alice", password: "password1" }
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await api(env, "POST", "/api/login", {
        body: { login: "Alice", password: "brand-new-1" }
    });
    assert.equal(newLogin.status, 200, JSON.stringify(newLogin.data));
});

function createLockNamespace() {
    const lock = new AccountsLock({});
    const log = [];
    return {
        log,
        idFromName: (name) => name,
        get: () => ({
            fetch: async (url) => {
                const path = new URL(String(url)).pathname;
                log.push(path);
                return await lock.fetch(new Request(String(url)));
            }
        })
    };
}

test("1.2.0：账户写锁同一时刻只发给一个请求", async () => {
    const lock = new AccountsLock({});
    const first = await (await lock.fetch(new Request("https://lock/lock"))).json();
    assert.equal(first.granted, true);

    const second = await (await lock.fetch(new Request("https://lock/lock"))).json();
    assert.equal(second.granted, false);

    await lock.fetch(new Request("https://lock/unlock"));

    const third = await (await lock.fetch(new Request("https://lock/lock"))).json();
    assert.equal(third.granted, true);
});

test("1.2.0：写账户时加锁并在失败后释放", async () => {
    const { env, tokens } = await prepare();
    const ns = createLockNamespace();
    env.ACCOUNTS_LOCK = ns;

    const ok = await api(env, "POST", "/api/me/purchase", {
        token: tokens.Alice,
        body: { id: "test-book", quantity: 1, password: "password1" }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ns.log, ["/lock", "/unlock"]);

    ns.log.length = 0;
    const failed = await api(env, "POST", "/api/me/withdraw", {
        token: tokens.Alice,
        body: { amount: "999.00", password: "password1" }
    });
    assert.equal(failed.status, 400);
    assert.deepEqual(ns.log, ["/lock", "/unlock"], "校验失败也要释放写锁");
});
