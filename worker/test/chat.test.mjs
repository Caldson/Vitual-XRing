import test from "node:test";
import assert from "node:assert/strict";

import worker, { ChatHub } from "../index.js";

class MockKV {
    constructor() {
        this.map = new Map();
    }

    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) {
            return null;
        }
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
            this.map.delete(key);
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

    async put(key, value, options = {}) {
        this.map.set(key, {
            value,
            expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0
        });
    }

    async delete(key) {
        this.map.delete(key);
    }

    async list() {
        return { keys: Array.from(this.map.keys()).map((name) => ({ name })) };
    }
}

function createEnv() {
    const events = [];
    const chat = {
        events,
        idFromName: (name) => ({ name }),
        get: () => ({
            fetch: async (url, init) => {
                events.push({ url: String(url), payload: JSON.parse(init.body) });
                return new Response(JSON.stringify({ ok: true }), {
                    headers: { "content-type": "application/json" }
                });
            }
        })
    };

    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        CHAT_ENABLED: "true",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        CHAT: chat
    };
}

const SEED = {    Kitawaga: { password: "password1", username: "站主", money: "100.00", trades: [], data: {} },
    Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} },
    Bob: { password: "password1", username: "鲍勃", money: "10.00", trades: [], data: {} },
    Carol: { password: "password1", username: "卡罗尔", money: "10.00", trades: [], data: {} }
};

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

    const response = await worker.fetch(new Request(`https://api.test${path}`, {
        method,
        headers,
        body
    }), env);

    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : await response.arrayBuffer();
    return { status: response.status, data, response };
}

async function login(env, name) {
    const result = await api(env, "POST", "/api/login", {
        body: { login: name, password: "password1" }
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.token;
}

let prepareCount = 0;

async function prepare() {
    const env = createEnv();
    prepareCount += 1;
    env.__ip = `10.0.0.${prepareCount}`;
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const name of Object.keys(SEED)) {
        tokens[name] = await login(env, name);
    }
    return { env, tokens };
}

async function befriend(env, tokens, a, b) {
    const request = await api(env, "POST", "/api/chat/friends/requests", {
        token: tokens[a],
        body: { login: b, note: "你好" }
    });
    assert.equal(request.status, 201, JSON.stringify(request.data));
    const decision = await api(env, "POST", `/api/chat/friends/requests/${request.data.request.id}/accept`, {
        token: tokens[b]
    });
    assert.equal(decision.status, 200, JSON.stringify(decision.data));
    return decision.data.conversation;
}

test("聊天室状态开放，并暴露实时通道与媒体 TTL", async () => {
    const { env } = await prepare();
    const status = await api(env, "GET", "/api/chat/status");
    assert.equal(status.status, 200);
    assert.equal(status.data.version, "1.3");
    assert.equal(status.data.enabled, true);
    assert.equal(status.data.realtime, "websocket");
    assert.equal(status.data.mediaTtlSeconds, 1200);
    assert.deepEqual(status.data.rooms.map((item) => item.id), ["general", "trade", "help"]);
});

test("好友申请、接受、单聊与未读/撤回", async () => {
    const { env, tokens } = await prepare();

    const users = await api(env, "GET", "/api/chat/users?q=Bob", { token: tokens.Alice });
    assert.equal(users.status, 200);
    assert.equal(users.data.users[0].login, "Bob");
    assert.equal(users.data.users[0].friend, false);

    const conversation = await befriend(env, tokens, "Alice", "Bob");
    assert.equal(conversation.type, "direct");

    const list = await api(env, "GET", "/api/chat/conversations", { token: tokens.Alice });
    assert.equal(list.status, 200);
    const direct = list.data.conversations.find((item) => item.id === conversation.id);
    assert.ok(direct, "Alice 的会话列表里应该有单聊");

    const sent = await api(env, "POST", `/api/chat/conversations/${conversation.id}/messages`, {
        token: tokens.Alice,
        body: { text: "晚上好" }
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    assert.equal(sent.data.message.text, "晚上好");

    const bobList = await api(env, "GET", "/api/chat/conversations", { token: tokens.Bob });
    const bobDirect = bobList.data.conversations.find((item) => item.id === conversation.id);
    assert.equal(bobDirect.unread, 1);

    const messages = await api(env, "GET", `/api/chat/conversations/${conversation.id}/messages`, { token: tokens.Bob });
    assert.equal(messages.status, 200);
    assert.equal(messages.data.messages.length, 1);

    await api(env, "POST", `/api/chat/conversations/${conversation.id}/read`, { token: tokens.Bob });
    const afterRead = await api(env, "GET", "/api/chat/conversations", { token: tokens.Bob });
    assert.equal(afterRead.data.conversations.find((item) => item.id === conversation.id).unread, 0);

    const reply = await api(env, "POST", `/api/chat/conversations/${conversation.id}/messages`, {
        token: tokens.Bob,
        body: { text: "收到", replyTo: sent.data.message.id }
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.data.message.replyTo.id, sent.data.message.id);

    const recall = await api(env, "POST", `/api/chat/messages/${sent.data.message.id}/recall?conversation=${conversation.id}`, {
        token: tokens.Alice
    });
    assert.equal(recall.status, 200, JSON.stringify(recall.data));

    const afterRecall = await api(env, "GET", `/api/chat/conversations/${conversation.id}/messages`, { token: tokens.Bob });
    const recalled = afterRecall.data.messages.find((item) => item.id === sent.data.message.id);
    assert.equal(recalled.recalled, true);
    assert.equal(recalled.text, "");
});

test("不能和陌生人单聊，拉黑后也不能", async () => {
    const { env, tokens } = await prepare();
    const denied = await api(env, "POST", "/api/chat/conversations/direct", {
        token: tokens.Alice,
        body: { login: "Carol" }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "not_friend");

    const conversation = await befriend(env, tokens, "Alice", "Carol");
    await api(env, "POST", "/api/chat/blocks", { token: tokens.Carol, body: { login: "Alice" } });

    const blocked = await api(env, "POST", `/api/chat/conversations/${conversation.id}/messages`, {
        token: tokens.Alice,
        body: { text: "在吗" }
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error, "blocked");
});

test("建群、改名、群公告置顶、加人、管理员、转让、退群、解散", async () => {
    const { env, tokens } = await prepare();

    const created = await api(env, "POST", "/api/chat/conversations/group", {
        token: tokens.Alice,
        body: { name: "测试群", members: ["Bob"] }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const groupId = created.data.conversation.id;
    assert.equal(created.data.conversation.memberCount, 2);

    const renamed = await api(env, "PATCH", `/api/chat/conversations/${groupId}`, {
        token: tokens.Bob,
        body: { name: "不能改名" }
    });
    assert.equal(renamed.status, 403);

    const renamedByOwner = await api(env, "PATCH", `/api/chat/conversations/${groupId}`, {
        token: tokens.Alice,
        body: { name: "新群名" }
    });
    assert.equal(renamedByOwner.status, 200);
    assert.equal(renamedByOwner.data.conversation.name, "新群名");

    const announcement = await api(env, "PUT", `/api/chat/conversations/${groupId}/announcement`, {
        token: tokens.Alice,
        body: { text: "周五开会", pinned: false }
    });
    assert.equal(announcement.status, 200);
    assert.equal(announcement.data.conversation.announcement.text, "周五开会");

    const pinned = await api(env, "POST", `/api/chat/conversations/${groupId}/announcement/pin`, {
        token: tokens.Alice,
        body: { pinned: true }
    });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.data.conversation.announcement.pinned, true);

    const added = await api(env, "POST", `/api/chat/conversations/${groupId}/members`, {
        token: tokens.Bob,
        body: { members: ["Carol"] }
    });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.deepEqual(added.data.conversation.admins, []);

    const makeAdmin = await api(env, "POST", `/api/chat/conversations/${groupId}/admins`, {
        token: tokens.Alice,
        body: { login: "Bob" }
    });
    assert.equal(makeAdmin.status, 200);
    assert.deepEqual(makeAdmin.data.conversation.admins, ["Bob"]);

    const kick = await api(env, "DELETE", `/api/chat/conversations/${groupId}/members/Carol`, {
        token: tokens.Bob
    });
    assert.equal(kick.status, 200, JSON.stringify(kick.data));

    const transfer = await api(env, "POST", `/api/chat/conversations/${groupId}/owner`, {
        token: tokens.Alice,
        body: { login: "Bob" }
    });
    assert.equal(transfer.status, 200);
    assert.equal(transfer.data.conversation.owner, "Bob");

    const detail = await api(env, "GET", `/api/chat/conversations/${groupId}`, { token: tokens.Alice });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.members.length, 2);

    const leave = await api(env, "POST", `/api/chat/conversations/${groupId}/leave`, { token: tokens.Alice });
    assert.equal(leave.status, 200);

    const dissolve = await api(env, "DELETE", `/api/chat/conversations/${groupId}`, { token: tokens.Bob });
    assert.equal(dissolve.status, 200, JSON.stringify(dissolve.data));
    assert.equal(dissolve.data.dissolved, true);

    const afterDissolve = await api(env, "GET", `/api/chat/conversations/${groupId}`, { token: tokens.Bob });
    assert.equal(afterDissolve.status, 200);
    assert.equal(afterDissolve.data.conversation.dissolved, true);
    assert.equal(afterDissolve.data.conversation.dissolvedBy, "Bob");
});

test("解散群聊后只读：历史消息保留，不能发言、改名或加人", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/chat/conversations/group", {
        token: tokens.Alice,
        body: { name: "只读群", members: ["Bob", "Carol"] }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const groupId = created.data.conversation.id;

    const sent = await api(env, "POST", `/api/chat/conversations/${groupId}/messages`, {
        token: tokens.Bob,
        body: { text: "解散前的消息" }
    });
    assert.equal(sent.status, 201);

    const forbidden = await api(env, "DELETE", `/api/chat/conversations/${groupId}`, { token: tokens.Bob });
    assert.equal(forbidden.status, 403);

    const dissolved = await api(env, "DELETE", `/api/chat/conversations/${groupId}`, { token: tokens.Alice });
    assert.equal(dissolved.status, 200, JSON.stringify(dissolved.data));

    const history = await api(env, "GET", `/api/chat/conversations/${groupId}/messages`, { token: tokens.Carol });
    assert.equal(history.status, 200);
    assert.ok(history.data.messages.some((item) => item.text === "解散前的消息"));
    assert.ok(history.data.messages.some((item) => item.system && item.text.includes("解散了群聊")));

    const blocked = await api(env, "POST", `/api/chat/conversations/${groupId}/messages`, {
        token: tokens.Carol,
        body: { text: "还能说话吗" }
    });
    assert.equal(blocked.status, 410);
    assert.equal(blocked.data.error, "group_dissolved");

    const renamed = await api(env, "PATCH", `/api/chat/conversations/${groupId}`, {
        token: tokens.Alice,
        body: { name: "改名" }
    });
    assert.equal(renamed.status, 410);

    const added = await api(env, "POST", `/api/chat/conversations/${groupId}/members`, {
        token: tokens.Alice,
        body: { members: ["Kitawaga"] }
    });
    assert.equal(added.status, 410);

    const list = await api(env, "GET", "/api/chat/conversations", { token: tokens.Carol });
    const entry = list.data.conversations.find((item) => item.id === groupId);
    assert.ok(entry, "解散后会话仍在成员列表里");
    assert.equal(entry.dissolved, true);

    const leave = await api(env, "POST", `/api/chat/conversations/${groupId}/leave`, { token: tokens.Carol });
    assert.equal(leave.status, 200);
    const afterLeave = await api(env, "GET", "/api/chat/conversations", { token: tokens.Carol });
    assert.ok(!afterLeave.data.conversations.some((item) => item.id === groupId));

    const owner = await api(env, "GET", `/api/chat/conversations/${groupId}`, { token: tokens.Alice });
    assert.equal(owner.status, 200);
});

test("站主可以解散没有加入的群聊", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/chat/conversations/group", {
        token: tokens.Alice,
        body: { name: "站主解散测试", members: ["Bob"] }
    });
    assert.equal(created.status, 201);
    const groupId = created.data.conversation.id;

    const dissolved = await api(env, "DELETE", `/api/chat/conversations/${groupId}`, { token: tokens.Kitawaga });
    assert.equal(dissolved.status, 200, JSON.stringify(dissolved.data));

    const detail = await api(env, "GET", `/api/chat/conversations/${groupId}`, { token: tokens.Bob });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.conversation.dissolvedBy, "Kitawaga");

    const events = env.CHAT.events.filter((item) => String(item.url).includes("/notify"));
    assert.ok(events.some((item) => item.payload.event && item.payload.event.type === "conversation:dissolved"));
});

test("转发、搜索、会话置顶/免打扰与清空", async () => {
    const { env, tokens } = await prepare();
    const direct = await befriend(env, tokens, "Alice", "Bob");
    const group = await api(env, "POST", "/api/chat/conversations/group", {
        token: tokens.Alice,
        body: { name: "转发测试", members: ["Bob"] }
    });
    const groupId = group.data.conversation.id;

    const sent = await api(env, "POST", `/api/chat/conversations/${direct.id}/messages`, {
        token: tokens.Alice,
        body: { text: "重要的消息 ABC" }
    });
    assert.equal(sent.status, 201);

    const forwarded = await api(env, "POST", `/api/chat/messages/${sent.data.message.id}/forward?conversation=${direct.id}`, {
        token: tokens.Alice,
        body: { targets: [groupId] }
    });
    assert.equal(forwarded.status, 201, JSON.stringify(forwarded.data));
    assert.equal(forwarded.data.count, 1);
    assert.equal(forwarded.data.messages[0].message.forwarded, true);

    const search = await api(env, "GET", "/api/chat/search?q=ABC", { token: tokens.Bob });
    assert.equal(search.status, 200);
    assert.ok(search.data.results.length >= 2);

    const settings = await api(env, "POST", `/api/chat/conversations/${direct.id}/settings`, {
        token: tokens.Bob,
        body: { pinned: true, muted: true }
    });
    assert.equal(settings.status, 200);
    assert.equal(settings.data.pinned, true);
    assert.equal(settings.data.muted, true);

    const cleared = await api(env, "POST", `/api/chat/conversations/${direct.id}/clear`, { token: tokens.Bob });
    assert.equal(cleared.status, 200);
    const afterClear = await api(env, "GET", `/api/chat/conversations/${direct.id}/messages`, { token: tokens.Bob });
    assert.equal(afterClear.data.messages.length, 0);
});

test("图片上传、读取，过期后不能发送但历史消息仍保留", async () => {
    const { env, tokens } = await prepare();
    const direct = await befriend(env, tokens, "Alice", "Bob");

    const upload = await api(env, "POST", "/api/chat/media", {
        token: tokens.Alice,
        raw: new Uint8Array([137, 80, 78, 71]).buffer,
        contentType: "image/png",
        headers: { "x-file-name": encodeURIComponent("测试.png") }
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.data));
    const media = upload.data.media;
    assert.equal(media.name, "测试.png");
    assert.equal(media.size, 4);

    const fetched = await api(env, "GET", `/api/chat/media/${media.id}?token=${tokens.Bob}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.response.headers.get("content-type"), "image/png");

    const sent = await api(env, "POST", `/api/chat/conversations/${direct.id}/messages`, {
        token: tokens.Alice,
        body: { type: "image", mediaId: media.id, text: "" }
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    assert.equal(sent.data.message.media.id, media.id);

    await env.ACCOUNTS_KV.delete(`chat:media-meta:${media.id}`);
    await env.ACCOUNTS_KV.delete(`chat:media:${media.id}`);

    const expired = await api(env, "GET", `/api/chat/media/${media.id}?token=${tokens.Bob}`);
    assert.equal(expired.status, 410);

    const afterExpiry = await api(env, "GET", `/api/chat/conversations/${direct.id}/messages`, { token: tokens.Bob });
    const image = afterExpiry.data.messages.find((item) => item.id === sent.data.message.id);
    assert.ok(image, "过期后聊天记录里的图片消息仍然存在");
    assert.equal(image.media.id, media.id);

    const second = await api(env, "POST", "/api/chat/conversations/direct", {
        token: tokens.Bob,
        body: { login: "Alice" }
    });
    assert.equal(second.status, 200);
});

test("站主可以管理所有群聊和单聊", async () => {
    const { env, tokens } = await prepare();
    const direct = await befriend(env, tokens, "Alice", "Bob");
    await api(env, "POST", `/api/chat/conversations/${direct.id}/messages`, {
        token: tokens.Alice,
        body: { text: "私下说的话" }
    });

    const list = await api(env, "GET", "/api/chat/admin/conversations", { token: tokens.Kitawaga });
    assert.equal(list.status, 200);
    assert.ok(list.data.conversations.some((item) => item.id === direct.id));

    const messages = await api(env, "GET", `/api/chat/admin/conversations/${direct.id}/messages`, {
        token: tokens.Kitawaga
    });
    assert.equal(messages.status, 200);
    const target = messages.data.messages.find((item) => item.text === "私下说的话");
    assert.ok(target);

    const deleted = await api(env, "DELETE", `/api/chat/admin/messages/${target.id}?conversation=${direct.id}`, {
        token: tokens.Kitawaga
    });
    assert.equal(deleted.status, 200);

    const removed = await api(env, "DELETE", `/api/chat/admin/conversations/${direct.id}`, {
        token: tokens.Kitawaga
    });
    assert.equal(removed.status, 200);

    const normalUser = await api(env, "GET", "/api/chat/admin/conversations", { token: tokens.Alice });
    assert.equal(normalUser.status, 403);
});

test("公共频道对所有账户可见，兼容旧的 room 接口", async () => {
    const { env, tokens } = await prepare();

    const list = await api(env, "GET", "/api/chat/conversations", { token: tokens.Alice });
    const rooms = list.data.conversations.filter((item) => item.public);
    assert.deepEqual(rooms.map((item) => item.id).sort(), ["general", "help", "trade"]);

    const sent = await api(env, "POST", "/api/chat/messages", {
        token: tokens.Alice,
        body: { room: "general", text: "大家好" }
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    assert.equal(sent.data.room, "general");

    const history = await api(env, "GET", "/api/chat/messages?room=general", { token: tokens.Bob });
    assert.equal(history.status, 200);
    assert.ok(history.data.messages.some((item) => item.text === "大家好"));
});

test("站主可以新增、改名、解散公共频道，普通用户不行", async () => {
    const { env, tokens } = await prepare();

    const list = await api(env, "GET", "/api/chat/admin/public-groups", { token: tokens.Kitawaga });
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.groups.map((item) => item.id).sort(), ["general", "help", "trade"]);

    const denied = await api(env, "GET", "/api/chat/admin/public-groups", { token: tokens.Alice });
    assert.equal(denied.status, 403);

    const deniedCreate = await api(env, "POST", "/api/chat/admin/public-groups", {
        token: tokens.Alice,
        body: { name: "不许建" }
    });
    assert.equal(deniedCreate.status, 403);

    const created = await api(env, "POST", "/api/chat/admin/public-groups", {
        token: tokens.Kitawaga,
        body: { id: "event", name: "活动", description: "活动公告" }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.group.id, "event");
    assert.equal(created.data.group.name, "活动");

    const duplicate = await api(env, "POST", "/api/chat/admin/public-groups", {
        token: tokens.Kitawaga,
        body: { id: "event", name: "重复" }
    });
    assert.equal(duplicate.status, 409);

    const auto = await api(env, "POST", "/api/chat/admin/public-groups", {
        token: tokens.Kitawaga,
        body: { name: "自动 id" }
    });
    assert.equal(auto.status, 201);
    assert.match(auto.data.group.id, /^ch_[a-z0-9_-]+$/);
    const autoId = auto.data.group.id;

    const visible = await api(env, "GET", "/api/chat/conversations", { token: tokens.Bob });
    const ids = visible.data.conversations.filter((item) => item.public).map((item) => item.id);
    assert.ok(ids.includes("event"), JSON.stringify(ids));
    assert.ok(ids.includes(autoId), JSON.stringify(ids));

    const status = await api(env, "GET", "/api/chat/status");
    assert.ok(status.data.rooms.some((item) => item.id === "event" && item.description === "活动公告"));

    const sent = await api(env, "POST", "/api/chat/conversations/event/messages", {
        token: tokens.Bob,
        body: { text: "活动什么时候开始" }
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));

    const renamed = await api(env, "PATCH", "/api/chat/admin/public-groups/event", {
        token: tokens.Kitawaga,
        body: { name: "活动大厅", description: "每周活动公告" }
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    assert.equal(renamed.data.group.name, "活动大厅");

    const afterRename = await api(env, "GET", "/api/chat/conversations/event", { token: tokens.Bob });
    assert.equal(afterRename.data.conversation.name, "活动大厅");
    assert.equal(afterRename.data.conversation.description, "每周活动公告");

    const userRename = await api(env, "PATCH", "/api/chat/conversations/event", {
        token: tokens.Bob,
        body: { name: "我想改名" }
    });
    assert.equal(userRename.status, 403);

    const adminRename = await api(env, "PATCH", "/api/chat/conversations/event", {
        token: tokens.Kitawaga,
        body: { name: "活动专区" }
    });
    assert.equal(adminRename.status, 200, JSON.stringify(adminRename.data));
    const detail = await api(env, "GET", "/api/chat/admin/public-groups", { token: tokens.Kitawaga });
    assert.equal(detail.data.groups.find((item) => item.id === "event").name, "活动专区");

    const userDelete = await api(env, "DELETE", "/api/chat/conversations/event", { token: tokens.Bob });
    assert.equal(userDelete.status, 403);

    const dissolved = await api(env, "DELETE", "/api/chat/admin/public-groups/event", {
        token: tokens.Kitawaga
    });
    assert.equal(dissolved.status, 200, JSON.stringify(dissolved.data));

    const gone = await api(env, "GET", "/api/chat/conversations/event", { token: tokens.Bob });
    assert.equal(gone.status, 404);

    const afterDelete = await api(env, "GET", "/api/chat/conversations", { token: tokens.Bob });
    assert.ok(!afterDelete.data.conversations.some((item) => item.id === "event"));

    const events = env.CHAT.events.filter((item) => String(item.url).includes("/notify"));
    assert.ok(events.some((item) => item.payload.event && item.payload.event.type === "conversation:new"));
    assert.ok(events.some((item) => item.payload.event && item.payload.event.type === "conversation:remove"));

    const missing = await api(env, "DELETE", "/api/chat/admin/public-groups/nope", { token: tokens.Kitawaga });
    assert.equal(missing.status, 404);
});

test("公共频道不能全部删光，最后一个会被拒绝", async () => {
    const { env, tokens } = await prepare();
    const first = await api(env, "DELETE", "/api/chat/admin/public-groups/help", { token: tokens.Kitawaga });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await api(env, "DELETE", "/api/chat/admin/public-groups/trade", { token: tokens.Kitawaga });
    assert.equal(second.status, 200, JSON.stringify(second.data));

    const last = await api(env, "DELETE", "/api/chat/admin/public-groups/general", { token: tokens.Kitawaga });
    assert.equal(last.status, 400, JSON.stringify(last.data));

    const list = await api(env, "GET", "/api/chat/admin/public-groups", { token: tokens.Kitawaga });
    assert.deepEqual(list.data.groups.map((item) => item.id), ["general"]);
});

test("删除好友后仍可查看和删除旧会话，但不能继续发消息", async () => {
    const { env, tokens } = await prepare();
    const conversation = await befriend(env, tokens, "Alice", "Bob");
    const sent = await api(env, "POST", `/api/chat/conversations/${conversation.id}/messages`, {
        token: tokens.Alice,
        body: { text: "旧消息" }
    });
    assert.equal(sent.status, 201);

    const removed = await api(env, "DELETE", "/api/chat/friends/Bob", { token: tokens.Alice });
    assert.equal(removed.status, 200);

    const history = await api(env, "GET", `/api/chat/conversations/${conversation.id}/messages`, { token: tokens.Alice });
    assert.equal(history.status, 200);
    assert.ok(history.data.messages.some((item) => item.text === "旧消息"));

    const denied = await api(env, "POST", `/api/chat/conversations/${conversation.id}/messages`, {
        token: tokens.Alice,
        body: { text: "还能发吗" }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, "not_friend");

    const deleted = await api(env, "DELETE", `/api/chat/conversations/${conversation.id}`, { token: tokens.Alice });
    assert.equal(deleted.status, 200);

    const list = await api(env, "GET", "/api/chat/conversations", { token: tokens.Alice });
    assert.ok(!list.data.conversations.some((item) => item.id === conversation.id));
});

test("WebSocket 广播：notify 只发给目标用户", async () => {
    const { env } = await prepare();
    const hub = new ChatHub({}, env);
    const bob = {
        sent: [],
        send(text) {
            this.sent.push(JSON.parse(text));
        }
    };
    hub.attach("Bob", bob);

    await hub.fetch(new Request("https://chat-hub/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: ["Bob"], event: { type: "message", text: "hi" } })
    }), env);

    assert.equal(bob.sent.length, 1);
    assert.equal(bob.sent[0].type, "message");
    assert.equal(bob.sent[0].text, "hi");

    hub.detach("Bob", bob);
    assert.equal(hub.sockets.size, 0);
});


/* ───────────── 1.0.0 测试 ───────────── */

test("账号 UID：注册即分配，可按 UID 精确查号", async () => {
    const { env, tokens } = await prepare();

    const me = await api(env, "GET", "/api/me", { token: tokens.Alice });
    assert.equal(me.status, 200);
    const uid = me.data.account.uid;
    assert.ok(Number.isInteger(uid) && uid >= 100001, String(uid));

    const again = await api(env, "GET", "/api/me", { token: tokens.Alice });
    assert.equal(again.data.account.uid, uid, "UID 必须稳定");

    const found = await api(env, "GET", `/api/chat/users/uid/${uid}`, { token: tokens.Bob });
    assert.equal(found.status, 200, JSON.stringify(found.data));
    assert.equal(found.data.user.login, "Alice");
    assert.equal(found.data.user.uid, uid);

    const missing = await api(env, "GET", "/api/chat/users/uid/99999999", { token: tokens.Bob });
    assert.equal(missing.status, 404);

    const search = await api(env, "GET", `/api/chat/users?q=${uid}`, { token: tokens.Bob });
    assert.equal(search.status, 200);
    assert.equal(search.data.users[0].login, "Alice");
    assert.equal(search.data.users[0].uid, uid);
});

test("群号：建群即有 8 位群号，可按群号加入群聊", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/chat/conversations/group", {
        token: tokens.Alice,
        body: { name: "群号测试", members: ["Bob"] }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const no = created.data.conversation.no;
    assert.ok(Number(no) >= 10000000 && Number(no) <= 99999999, String(no));

    const detail = await api(env, "GET", `/api/chat/conversations/${created.data.conversation.id}`, { token: tokens.Alice });
    assert.equal(detail.data.conversation.no, no);

    const lookup = await api(env, "GET", `/api/chat/groups/lookup?number=${no}`, { token: tokens.Carol });
    assert.equal(lookup.status, 200, JSON.stringify(lookup.data));
    assert.equal(lookup.data.group.no, no);
    assert.equal(lookup.data.group.joined, false);
    assert.ok(lookup.data.group.link.includes(`group=${no}`));

    const unknown = await api(env, "GET", "/api/chat/groups/lookup?number=12345678", { token: tokens.Carol });
    assert.equal(unknown.status, 404);

    const joined = await api(env, "POST", "/api/chat/groups/join", {
        token: tokens.Carol,
        body: { number: no }
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
    assert.equal(joined.data.joined, true);

    const list = await api(env, "GET", "/api/chat/conversations", { token: tokens.Carol });
    assert.ok(list.data.conversations.some((item) => item.id === created.data.conversation.id));

    const members = await api(env, "GET", `/api/chat/conversations/${created.data.conversation.id}`, { token: tokens.Alice });
    assert.equal(members.data.members.length, 3);
});

test("4 位 / 8 位邀请码建群：加入、结束邀请生成群聊", async () => {
    const { env, tokens } = await prepare();

    const invite = await api(env, "POST", "/api/chat/invites", {
        token: tokens.Alice,
        body: { digits: 4 }
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.data));
    const code = invite.data.invite.code;
    assert.match(code, /^\d{4}$/);

    const current = await api(env, "GET", "/api/chat/invites/current", { token: tokens.Alice });
    assert.equal(current.data.invite.code, code);

    const bobJoin = await api(env, "POST", `/api/chat/invites/${code}/join`, { token: tokens.Bob });
    assert.equal(bobJoin.status, 200, JSON.stringify(bobJoin.data));
    assert.equal(bobJoin.data.invite.count, 1);

    const carolJoin = await api(env, "POST", `/api/chat/invites/${code}/join`, { token: tokens.Carol });
    assert.equal(carolJoin.data.invite.count, 2);

    const ownerJoin = await api(env, "POST", `/api/chat/invites/${code}/join`, { token: tokens.Alice });
    assert.equal(ownerJoin.status, 400);

    const bobClose = await api(env, "POST", `/api/chat/invites/${code}/close`, { token: tokens.Bob });
    assert.equal(bobClose.status, 403);

    const closed = await api(env, "POST", `/api/chat/invites/${code}/close`, {
        token: tokens.Alice,
        body: { name: "邀请码群聊" }
    });
    assert.equal(closed.status, 201, JSON.stringify(closed.data));
    assert.equal(closed.data.conversation.name, "邀请码群聊");
    assert.equal(closed.data.conversation.memberCount, 3);
    assert.ok(Number(closed.data.conversation.no) >= 10000000);

    const afterClose = await api(env, "POST", `/api/chat/invites/${code}/join`, { token: tokens.Kitawaga });
    assert.equal(afterClose.status, 409);

    const currentAfter = await api(env, "GET", "/api/chat/invites/current", { token: tokens.Alice });
    assert.equal(currentAfter.data.invite, null);

    const long = await api(env, "POST", "/api/chat/invites", {
        token: tokens.Bob,
        body: { digits: 8 }
    });
    assert.equal(long.status, 201, JSON.stringify(long.data));
    assert.match(long.data.invite.code, /^\d{8}$/);

    const badDigits = await api(env, "POST", "/api/chat/invites", {
        token: tokens.Bob,
        body: { digits: 5 }
    });
    assert.equal(badDigits.status, 400);

    const cancelled = await api(env, "DELETE", `/api/chat/invites/${long.data.invite.code}`, { token: tokens.Bob });
    assert.equal(cancelled.status, 200);
    const gone = await api(env, "GET", `/api/chat/invites/${long.data.invite.code}`, { token: tokens.Carol });
    assert.equal(gone.status, 404);
});

test("拼手速红包：金额校验、抢红包、余额变动、退回", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/chat/conversations/group", {
        token: tokens.Alice,
        body: { name: "红包群", members: ["Bob", "Carol"] }
    });
    const id = created.data.conversation.id;

    /* 0.02 元最多 2 人 */
    const tooMany = await api(env, "POST", `/api/chat/conversations/${id}/redpackets`, {
        token: tokens.Alice,
        body: { total: "0.02", count: 3 }
    });
    assert.equal(tooMany.status, 400, JSON.stringify(tooMany.data));

    const zeroCents = await api(env, "POST", `/api/chat/conversations/${id}/redpackets`, {
        token: tokens.Alice,
        body: { total: "0.001" }
    });
    assert.equal(zeroCents.status, 400);

    const poor = await api(env, "POST", `/api/chat/conversations/${id}/redpackets`, {
        token: tokens.Alice,
        body: { total: "100.00" }
    });
    assert.equal(poor.status, 400);
    assert.equal(poor.data.error, "insufficient_balance");

    /* 直接单聊不能发红包 */
    const direct = await befriend(env, tokens, "Alice", "Bob");
    const notGroup = await api(env, "POST", `/api/chat/conversations/${direct.id}/redpackets`, {
        token: tokens.Alice,
        body: { total: "1.00" }
    });
    assert.equal(notGroup.status, 400);

    const packet = await api(env, "POST", `/api/chat/conversations/${id}/redpackets`, {
        token: tokens.Alice,
        body: { total: "1.00", count: 2, note: "手速" }
    });
    assert.equal(packet.status, 201, JSON.stringify(packet.data));
    assert.equal(packet.data.message.type, "redpacket");
    assert.equal(packet.data.message.packet.totalCents, 100);
    assert.equal(packet.data.balance, "9.00");

    const messageId = packet.data.message.id;

    const selfGrab = await api(env, "POST", `/api/chat/messages/${messageId}/redpacket/grab?conversation=${id}`, {
        token: tokens.Alice
    });
    assert.equal(selfGrab.status, 403);

    const bobGrab = await api(env, "POST", `/api/chat/messages/${messageId}/redpacket/grab?conversation=${id}`, {
        token: tokens.Bob
    });
    assert.equal(bobGrab.status, 200, JSON.stringify(bobGrab.data));
    assert.ok(bobGrab.data.cents >= 1);
    assert.equal(bobGrab.data.balance, fromCentsForTest(1000 + bobGrab.data.cents));

    const twice = await api(env, "POST", `/api/chat/messages/${messageId}/redpacket/grab?conversation=${id}`, {
        token: tokens.Bob
    });
    assert.equal(twice.status, 409);

    const carolGrab = await api(env, "POST", `/api/chat/messages/${messageId}/redpacket/grab?conversation=${id}`, {
        token: tokens.Carol
    });
    assert.equal(carolGrab.status, 200, JSON.stringify(carolGrab.data));
    assert.equal(bobGrab.data.cents + carolGrab.data.cents, 100, "两个红包加起来必须等于总额");

    const third = await api(env, "POST", `/api/chat/messages/${messageId}/redpacket/grab?conversation=${id}`, {
        token: tokens.Kitawaga
    });
    assert.ok([403, 404, 410].includes(third.status), String(third.status));

    const detail = await api(env, "GET", `/api/chat/messages/${messageId}/redpacket?conversation=${id}`, {
        token: tokens.Bob
    });
    assert.equal(detail.status, 200);
    assert.ok(detail.data.mine.cents >= 1);
    assert.equal(detail.data.message.packet.closed, true);

    /* 指定人可以抢 */
    const limited = await api(env, "POST", `/api/chat/conversations/${id}/redpackets`, {
        token: tokens.Bob,
        body: { total: "0.50", allow: ["Carol"] }
    });
    assert.equal(limited.status, 201, JSON.stringify(limited.data));

    const aliceTries = await api(env, "POST", `/api/chat/messages/${limited.data.message.id}/redpacket/grab?conversation=${id}`, {
        token: tokens.Kitawaga
    });
    assert.equal(aliceTries.status, 403);

    const carolLimited = await api(env, "POST", `/api/chat/messages/${limited.data.message.id}/redpacket/grab?conversation=${id}`, {
        token: tokens.Carol
    });
    assert.equal(carolLimited.status, 200);
    assert.equal(carolLimited.data.cents, 50);

    /* 未被抢完的可以退回 */
    const refundable = await api(env, "POST", `/api/chat/conversations/${id}/redpackets`, {
        token: tokens.Bob,
        body: { total: "2.00", count: 2 }
    });
    assert.equal(refundable.status, 201, JSON.stringify(refundable.data));

    const notOwner = await api(env, "POST", `/api/chat/messages/${refundable.data.message.id}/redpacket/refund?conversation=${id}`, {
        token: tokens.Carol
    });
    assert.equal(notOwner.status, 403);

    const refunded = await api(env, "POST", `/api/chat/messages/${refundable.data.message.id}/redpacket/refund?conversation=${id}`, {
        token: tokens.Bob
    });
    assert.equal(refunded.status, 200, JSON.stringify(refunded.data));
    assert.equal(refunded.data.refunded, "2.00");
    assert.equal(refunded.data.balance, fromCentsForTest(950 + bobGrab.data.cents));
});

function fromCentsForTest(cents) {
    return (cents / 100).toFixed(2);
}
