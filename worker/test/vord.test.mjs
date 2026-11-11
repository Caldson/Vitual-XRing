import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 9.2.2：Vord 文档、6 档分享权限与编辑记录 */

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

const SEED = {
    Alice: { password: "password1", username: "爱丽丝", money: "100.00", trades: [], data: {} },
    Bob: { password: "password1", username: "鲍勃", money: "100.00", trades: [], data: {} },
    Carol: { password: "password1", username: "卡罗尔", money: "100.00", trades: [], data: {} }
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
        __ip: `10.88.${Math.floor(envCount / 250)}.${envCount % 250}`
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
    return { env, tokens };
}

async function createDoc(env, tokens, overrides = {}) {
    const created = await api(env, "POST", "/api/vord/documents", {
        token: tokens.Alice,
        body: {
            title: "项目计划",
            format: "md",
            content: "# 计划\n\n第一版",
            client: "网页版",
            ...overrides
        }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return created.data.document;
}

async function share(env, tokens, id, body) {
    const result = await api(env, "POST", `/api/vord/documents/${id}/share`, {
        token: tokens.Alice,
        body
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.share;
}

test("9.2.2：Vord 文档可以新建、列出、读取、编辑和删除", async () => {
    const { env, tokens } = await prepare();
    const doc = await createDoc(env, tokens);
    assert.equal(doc.title, "项目计划");
    assert.equal(doc.format, "md");
    assert.equal(doc.permission, 1);
    assert.equal(doc.history[0].action, "create");
    assert.equal(doc.history[0].name, "爱丽丝");

    const list = await api(env, "GET", "/api/vord/documents", { token: tokens.Alice });
    assert.equal(list.status, 200);
    assert.equal(list.data.documents.length, 1);
    assert.equal(list.data.permissions.length, 6);

    const read = await api(env, "GET", `/api/vord/documents/${doc.id}`, { token: tokens.Alice });
    assert.equal(read.data.document.content, "# 计划\n\n第一版");

    const updated = await api(env, "PUT", `/api/vord/documents/${doc.id}`, {
        token: tokens.Alice,
        body: { title: "项目计划 v2", content: "# 计划\n\n第二版", client: "Windows版" }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.document.content, "# 计划\n\n第二版");
    assert.equal(updated.data.document.history[0].client, "Windows版");
    assert.equal(updated.data.document.history[0].name, "爱丽丝");

    const removed = await api(env, "DELETE", `/api/vord/documents/${doc.id}`, { token: tokens.Alice });
    assert.equal(removed.status, 200);
    const after = await api(env, "GET", "/api/vord/documents", { token: tokens.Alice });
    assert.equal(after.data.documents.length, 0);
});

test("9.2.2：仅预览链接任何人可看，但不能编辑", async () => {
    const { env, tokens } = await prepare();
    const doc = await createDoc(env, tokens);
    const info = await share(env, tokens, doc.id, { permission: 1 });
    assert.match(info.token, /^[A-Za-z0-9]{16,64}$/);

    const guest = await api(env, "GET", `/api/vord/share/${info.token}`);
    assert.equal(guest.status, 200);
    assert.equal(guest.data.document.canView, true);
    assert.equal(guest.data.document.canEdit, false);
    assert.equal(guest.data.document.content, "# 计划\n\n第一版");

    const denied = await api(env, "PUT", `/api/vord/share/${info.token}`, { body: { content: "nope" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "read_only");
});

test("9.2.2：可编辑链接允许匿名编辑并记为著名用户", async () => {
    const { env, tokens } = await prepare();
    const doc = await createDoc(env, tokens);
    const info = await share(env, tokens, doc.id, { permission: 4 });

    const web = await api(env, "PUT", `/api/vord/share/${info.token}`, {
        body: { content: "网页访客改的", client: "网页版" }
    });
    assert.equal(web.status, 200, JSON.stringify(web.data));
    assert.equal(web.data.document.history[0].name, "著名用户 [网页版]");
    assert.equal(web.data.document.history[0].guest, true);

    const windows = await api(env, "PUT", `/api/vord/share/${info.token}`, {
        body: { content: "Windows 访客改的", client: "Windows版" }
    });
    assert.equal(windows.status, 200);
    assert.equal(windows.data.document.history[0].name, "著名用户 [Windows版]");
    assert.equal(windows.data.document.content, "Windows 访客改的");
});

test("9.2.2：仅登录账号可预览 / 可编辑", async () => {
    const { env, tokens } = await prepare();
    const doc = await createDoc(env, tokens);

    await share(env, tokens, doc.id, { permission: 2 });
    const anonRead = await api(env, "GET", `/api/vord/documents/${doc.id}/share`, { token: tokens.Alice });
    assert.equal(anonRead.status, 200);
    const token2 = anonRead.data.share.token;
    assert.equal((await api(env, "GET", `/api/vord/share/${token2}`)).status, 401);
    const bobRead = await api(env, "GET", `/api/vord/share/${token2}`, { token: tokens.Bob });
    assert.equal(bobRead.status, 200);
    assert.equal(bobRead.data.document.canEdit, false);

    await share(env, tokens, doc.id, { permission: 5 });
    const anonEdit = await api(env, "PUT", `/api/vord/share/${token2}`, { body: { content: "x" } });
    assert.equal(anonEdit.status, 401);
    const bobEdit = await api(env, "PUT", `/api/vord/share/${token2}`, {
        token: tokens.Bob,
        body: { content: "鲍勃改的", client: "网页版" }
    });
    assert.equal(bobEdit.status, 200);
    assert.equal(bobEdit.data.document.history[0].name, "鲍勃");
});

test("9.2.2：仅受邀账号可预览 / 可编辑", async () => {
    const { env, tokens } = await prepare();
    const doc = await createDoc(env, tokens);

    await share(env, tokens, doc.id, { permission: 3, invitees: ["Bob"] });
    const shareInfo = await api(env, "GET", `/api/vord/documents/${doc.id}/share`, { token: tokens.Alice });
    const token3 = shareInfo.data.share.token;
    const invited = await api(env, "GET", `/api/vord/share/${token3}`, { token: tokens.Bob });
    assert.equal(invited.status, 200);
    assert.equal(invited.data.document.canEdit, false);
    const outsider = await api(env, "GET", `/api/vord/share/${token3}`, { token: tokens.Carol });
    assert.equal(outsider.status, 403);
    assert.equal(outsider.data.error, "not_invited");
    const anon = await api(env, "GET", `/api/vord/share/${token3}`);
    assert.equal(anon.status, 401);

    await share(env, tokens, doc.id, { permission: 6, invitees: ["Bob"] });
    const outsiderEdit = await api(env, "PUT", `/api/vord/share/${token3}`, {
        token: tokens.Carol,
        body: { content: "不该成功" }
    });
    assert.equal(outsiderEdit.status, 403);
    const invitedEdit = await api(env, "PUT", `/api/vord/share/${token3}`, {
        token: tokens.Bob,
        body: { content: "受邀编辑", client: "Windows版" }
    });
    assert.equal(invitedEdit.status, 200);
    assert.equal(invitedEdit.data.document.content, "受邀编辑");
    assert.equal(invitedEdit.data.document.history[0].name, "鲍勃");
});

test("9.2.2：关闭分享链接后原链接立即失效", async () => {
    const { env, tokens } = await prepare();
    const doc = await createDoc(env, tokens);
    const info = await share(env, tokens, doc.id, { permission: 1 });
    const closed = await api(env, "DELETE", `/api/vord/documents/${doc.id}/share`, { token: tokens.Alice });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.share.token, "");
    const gone = await api(env, "GET", `/api/vord/share/${info.token}`);
    assert.equal(gone.status, 404);
});

test("9.2.2：文档大小、权限和受邀账号做基本校验", async () => {
    const { env, tokens } = await prepare();
    const doc = await createDoc(env, tokens);

    const huge = await api(env, "POST", "/api/vord/documents", {
        token: tokens.Alice,
        body: { title: "太大", content: "x".repeat(512 * 1024 + 1) }
    });
    assert.equal(huge.status, 413);

    const badPermission = await api(env, "POST", `/api/vord/documents/${doc.id}/share`, {
        token: tokens.Alice,
        body: { permission: 9 }
    });
    assert.equal(badPermission.status, 400);

    const missingInvite = await api(env, "POST", `/api/vord/documents/${doc.id}/share`, {
        token: tokens.Alice,
        body: { permission: 3, invitees: ["Nobody"] }
    });
    assert.equal(missingInvite.status, 400);
    assert.equal(missingInvite.data.error, "account_not_found");

    const otherOwner = await api(env, "GET", `/api/vord/documents/${doc.id}`, { token: tokens.Bob });
    assert.equal(otherOwner.status, 404);
});
