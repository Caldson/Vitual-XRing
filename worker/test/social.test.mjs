import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 3.1.0：Vimidi / VMusic / Viratch / AUDIV / ViStyle / VClang / Vitx 动态 / 通用分享 */

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
        __ip: `10.31.${Math.floor(prepareCount / 250)}.${prepareCount % 250}`
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
    if (options.raw !== undefined) {
        headers.set("content-type", options.type || "application/octet-stream");
        headers.set("x-file-name", encodeURIComponent(options.fileName || "file"));
        body = options.raw;
    }
    const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), env);
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
}

async function prepare() {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const login of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", {
            body: { login, password: "password1" }
        });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[login] = result.data.token;
    }
    return { env, tokens };
}

function midiFile() {
    const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0x60]);
    const trackData = Buffer.from([
        0x00, 0x90, 0x3c, 0x64,
        0x60, 0x80, 0x3c, 0x40,
        0x00, 0xff, 0x2f, 0x00
    ]);
    const trackHead = Buffer.from([0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trackData.length]);
    return Buffer.concat([header, trackHead, trackData]);
}

async function createMidi(env, token, title = "小星星") {
    const draft = await api(env, "POST", "/api/social/kinds/midi", {
        token,
        body: { title, artist: "测试作者", description: "测试 MIDI" }
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    const id = draft.data.item.id;
    const uploaded = await api(env, "PUT", `/api/social/kinds/midi/${id}/file`, {
        token,
        raw: midiFile(),
        type: "audio/midi",
        fileName: `${title}.mid`
    });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.item.ready, true);
    assert.equal(uploaded.data.item.extra.noteCount, 1);
    const published = await api(env, "POST", `/api/social/kinds/midi/${id}/publish`, { token });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    return id;
}

test("3.1.0：健康检查与 Vimidi 上传、解析、发布、链接识别", async () => {
    const { env, tokens } = await prepare();

    const health = await api(env, "GET", "/api/health");
    assert.equal(health.data.version, "3.1.0");
    assert.equal(health.data.social.version, "3.1.0");

    const id = await createMidi(env, tokens.Alice, "小星星");
    const detail = await api(env, "GET", `/api/social/kinds/midi/${id}`, { token: tokens.Bob });
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.item.title, "小星星");
    assert.equal(detail.data.item.extra.noteCount, 1);
    assert.equal(detail.data.item.extra.durationSeconds, 0.5);
    assert.equal(detail.data.item.canDownload, true);

    const file = await api(env, "GET", `/api/social/file/${id}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("accept-ranges"), "bytes");

    const resolved = await api(env, "GET", `/api/social/resolve?url=${encodeURIComponent(`https://api.test/vimidi.html?id=${id}`)}`);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
    assert.equal(resolved.data.card.kind, "midi");
    assert.equal(resolved.data.card.title, "小星星");

    const list = await api(env, "GET", "/api/social/kinds/midi");
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 1);
    assert.equal(list.data.items[0].id, id);
});

test("3.1.0：VMusic 关联 MIDI 后，Vimidi 详情 / 卡片自动显示识别结果", async () => {
    const { env, tokens } = await prepare();
    const midiId = await createMidi(env, tokens.Alice, "晴天");

    const draft = await api(env, "POST", "/api/social/kinds/music", {
        token: tokens.Alice,
        body: {
            title: "晴天",
            artist: "周杰伦",
            album: "叶惠美",
            duration: 269,
            midiId,
            description: "测试音乐"
        }
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    const musicId = draft.data.item.id;
    const uploaded = await api(env, "PUT", `/api/social/kinds/music/${musicId}/file`, {
        token: tokens.Alice,
        raw: Buffer.from("ID3fake-audio"),
        type: "audio/mpeg",
        fileName: "晴天.mp3"
    });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    const published = await api(env, "POST", `/api/social/kinds/music/${musicId}/publish`, { token: tokens.Alice });
    assert.equal(published.status, 200, JSON.stringify(published.data));

    const midi = await api(env, "GET", `/api/social/kinds/midi/${midiId}`);
    assert.equal(midi.data.item.extra.musicId, musicId);
    assert.equal(midi.data.item.extra.musicTitle, "晴天");

    const card = await api(env, "GET", `/api/social/resolve?url=${encodeURIComponent(`https://api.test/vimidi.html?id=${midiId}`)}`);
    assert.equal(card.data.card.meta.musicId, musicId);
    assert.match(card.data.card.description, /晴天/);

    const musicCard = await api(env, "GET", `/api/social/resolve?url=${encodeURIComponent(`https://api.test/vmusic.html?id=${musicId}`)}`);
    assert.equal(musicCard.data.card.kind, "music");
    assert.equal(musicCard.data.card.meta.midiId, midiId);
});

test("3.1.0：视频评论里的站内链接自动变成分享卡片", async () => {
    const { env, tokens } = await prepare();
    const midiId = await createMidi(env, tokens.Alice, "评论识别");
    await env.ACCOUNTS_KV.put("video:meta:v_test01", JSON.stringify({
        id: "v_test01",
        title: "测试视频",
        owner: "Kitawaga",
        ownerName: "站主",
        status: "published",
        at: Date.now(),
        likes: [],
        coins: [],
        comments: 0,
        commentCount: 0
    }));

    const result = await api(env, "POST", "/api/videos/v_test01/comments", {
        token: tokens.Bob,
        body: { text: `这首歌的 MIDI：https://api.test/vimidi.html?id=${midiId}` }
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.comment.card.kind, "midi");
    assert.equal(result.data.comment.card.title, "评论识别");

    const stored = await env.ACCOUNTS_KV.get("video:comments:v_test01", "json");
    assert.equal(stored[0].card.kind, "midi");
});

test("3.1.0：ViStyle 定价、购买、下载权限与作者收入", async () => {
    const { env, tokens } = await prepare();

    const draft = await api(env, "POST", "/api/social/kinds/style", {
        token: tokens.Alice,
        body: { title: "深海蓝", description: "全局深蓝样式", price: 5, version: "1.0.0" }
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    const id = draft.data.item.id;
    assert.equal(draft.data.item.price, "5.00");

    const uploaded = await api(env, "PUT", `/api/social/kinds/style/${id}/file`, {
        token: tokens.Alice,
        raw: Buffer.from("body{background:#0b1d3a;color:#fff}"),
        type: "text/css",
        fileName: "deep-blue.css"
    });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    await api(env, "POST", `/api/social/kinds/style/${id}/publish`, { token: tokens.Alice });

    const locked = await api(env, "GET", `/api/social/kinds/style/${id}`, { token: tokens.Bob });
    assert.equal(locked.data.item.locked, true);
    assert.equal(locked.data.item.canDownload, false);
    const deniedFile = await api(env, "GET", `/api/social/file/${id}`, { token: tokens.Bob });
    assert.equal(deniedFile.status, 403);

    const bought = await api(env, "POST", `/api/social/kinds/style/${id}/purchase`, {
        token: tokens.Bob,
        body: { password: "password1" }
    });
    assert.equal(bought.status, 200, JSON.stringify(bought.data));
    assert.equal(bought.data.item.purchased, true);
    assert.equal(bought.data.trade.price, "-5.00");

    const bob = await api(env, "GET", "/api/me", { token: tokens.Bob });
    assert.equal(bob.data.account.money, "5.00");
    assert.equal(bob.data.account.library.length, 1);
    const alice = await api(env, "GET", "/api/me", { token: tokens.Alice });
    assert.equal(alice.data.account.money, "15.00");

    const file = await api(env, "GET", `/api/social/file/${id}`, { token: tokens.Bob });
    assert.equal(file.status, 200);
    assert.match(file.data, /deep-blue|background/);

    const wrongPassword = await api(env, "POST", `/api/social/kinds/style/${id}/purchase`, {
        token: tokens.Kitawaga,
        body: { password: "bad" }
    });
    assert.equal(wrongPassword.status, 400);
});

test("3.1.0：动态支持图文、分享卡片、评论、点赞、转发和删除", async () => {
    const { env, tokens } = await prepare();
    const midiId = await createMidi(env, tokens.Alice, "动态里的 MIDI");

    const created = await api(env, "POST", "/api/social/kinds/dynamic", {
        token: tokens.Alice,
        body: {
            text: `今天发现一段好听的 MIDI https://api.test/vimidi.html?id=${midiId}`,
            images: ["https://example.com/a.png"]
        }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.item.id;
    assert.equal(created.data.item.extra.card.kind, "midi");
    assert.equal(created.data.item.extra.images.length, 1);

    const list = await api(env, "GET", "/api/social/kinds/dynamic");
    assert.equal(list.data.items.length, 1);

    const liked = await api(env, "POST", `/api/social/kinds/dynamic/${id}/like`, { token: tokens.Bob });
    assert.equal(liked.data.liked, true);
    assert.equal(liked.data.likes, 1);

    const comment = await api(env, "POST", `/api/social/kinds/dynamic/${id}/comments`, {
        token: tokens.Bob,
        body: { text: `好听，MIDI：https://api.test/vimidi.html?id=${midiId}` }
    });
    assert.equal(comment.status, 201, JSON.stringify(comment.data));
    assert.equal(comment.data.comment.card.kind, "midi");

    const comments = await api(env, "GET", `/api/social/kinds/dynamic/${id}/comments`, { token: tokens.Bob });
    assert.equal(comments.data.comments.length, 1);
    assert.equal(comments.data.comments[0].card.kind, "midi");

    const reposted = await api(env, "POST", `/api/social/kinds/dynamic/${id}/repost`, {
        token: tokens.Bob,
        body: { text: "转发一下" }
    });
    assert.equal(reposted.status, 201, JSON.stringify(reposted.data));
    assert.equal(reposted.data.item.extra.repostOf, id);

    const denied = await api(env, "DELETE", `/api/social/kinds/dynamic/${id}`, { token: tokens.Bob });
    assert.equal(denied.status, 403);
    const removed = await api(env, "DELETE", `/api/social/kinds/dynamic/${id}`, { token: tokens.Alice });
    assert.equal(removed.status, 200);
    const after = await api(env, "GET", "/api/social/kinds/dynamic");
    assert.equal(after.data.items.some((item) => item.id === id), false);
});

test("3.1.0：Viratch 站内作品、AUDIV 会议、VClang 项目和自定义分享", async () => {
    const { env, tokens } = await prepare();

    const scratch = await api(env, "POST", "/api/social/kinds/scratch", {
        token: tokens.Alice,
        body: {
            title: "小猫散步",
            engine: "xr",
            project: {
                width: 480,
                height: 360,
                sprites: [{ name: "小猫", emoji: "🐱", scripts: [{ event: "flag", blocks: [{ op: "move", a: 10 }] }] }]
            }
        }
    });
    assert.equal(scratch.status, 201, JSON.stringify(scratch.data));
    assert.equal(scratch.data.item.ready, true);
    await api(env, "POST", `/api/social/kinds/scratch/${scratch.data.item.id}/publish`, { token: tokens.Alice });
    const scratchDetail = await api(env, "GET", `/api/social/kinds/scratch/${scratch.data.item.id}`);
    assert.equal(scratchDetail.data.item.extra.project.sprites.length, 1);

    const meeting = await api(env, "POST", "/api/social/meetings", {
        token: tokens.Alice,
        body: { title: "周会", password: "1234" }
    });
    assert.equal(meeting.status, 201, JSON.stringify(meeting.data));
    const no = meeting.data.item.extra.no;
    assert.match(no, /^\d{3}-\d{3}-\d{3}$/);

    const info = await api(env, "GET", `/api/social/meetings/${no}`);
    assert.equal(info.data.meeting.title, "周会");
    assert.equal(info.data.meeting.locked, true);
    const badJoin = await api(env, "POST", `/api/social/meetings/${no}/join`, { body: { password: "0000" } });
    assert.equal(badJoin.status, 403);
    const join = await api(env, "POST", `/api/social/meetings/${no}/join`, { body: { password: "1234" } });
    assert.equal(join.status, 200, JSON.stringify(join.data));
    assert.match(join.data.joinToken, /^[a-f0-9]{64}$/);

    const meetingCard = await api(env, "GET", `/api/social/resolve?url=${encodeURIComponent(`https://api.test/audiv.html?meeting=${no}`)}`);
    assert.equal(meetingCard.data.card.kind, "meeting");
    assert.match(meetingCard.data.card.description, /周会|会议号/);

    const cpp = await api(env, "POST", "/api/social/kinds/cpp", {
        token: tokens.Alice,
        body: { title: "猜数字", description: "课程作业", price: 2, compiler: "Dev-C++" }
    });
    assert.equal(cpp.status, 201, JSON.stringify(cpp.data));
    const cppId = cpp.data.item.id;
    const files = await api(env, "PUT", `/api/social/kinds/cpp/${cppId}/files`, {
        token: tokens.Alice,
        body: {
            files: [
                { name: "猜数字.dev", text: '<?xml version="1.0"?><Dev-Cpp><Project><FileName>猜数字.exe</FileName><Unit filename="main.cpp" /></Project></Dev-Cpp>' },
                { name: "main.cpp", text: "#include <iostream>\nint main(){return 0;}" }
            ]
        }
    });
    assert.equal(files.status, 200, JSON.stringify(files.data));
    assert.equal(files.data.item.extra.devFile, "猜数字.dev");
    await api(env, "POST", `/api/social/kinds/cpp/${cppId}/publish`, { token: tokens.Alice });
    const locked = await api(env, "GET", `/api/social/kinds/cpp/${cppId}`, { token: tokens.Bob });
    assert.equal(locked.data.item.locked, true);
    const deniedCpp = await api(env, "GET", `/api/social/kinds/cpp/${cppId}/files`, { token: tokens.Bob });
    assert.equal(deniedCpp.status, 403);
    await api(env, "POST", `/api/social/kinds/cpp/${cppId}/purchase`, {
        token: tokens.Bob,
        body: { password: "password1" }
    });
    const cppFiles = await api(env, "GET", `/api/social/kinds/cpp/${cppId}/files`, { token: tokens.Bob });
    assert.equal(cppFiles.status, 200);
    assert.equal(cppFiles.data.files.length, 2);

    const image = await api(env, "POST", "/api/social/images", {
        token: tokens.Alice,
        raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
        type: "image/png"
    });
    assert.equal(image.status, 201, JSON.stringify(image.data));
    assert.match(image.data.image.url, /\/api\/social\/images\/img_/);
    const imagePath = new URL(image.data.image.url).pathname;
    const imageGet = await api(env, "GET", imagePath);
    assert.equal(imageGet.status, 200);
    assert.equal(imageGet.headers.get("content-type"), "image/png");
    assert.equal(imageGet.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const shared = await api(env, "POST", "/api/social/shares", {
        token: tokens.Bob,
        body: { name: "XRing 官网", icon: "🌐", url: "https://xsmmc.caldson.us.ci", description: "分享测试" }
    });
    assert.equal(shared.status, 201, JSON.stringify(shared.data));
    assert.equal(shared.data.card.kind, "link");
    assert.equal(shared.data.card.title, "XRing 官网");
    const shareResolve = await api(env, "GET", `/api/social/resolve?url=${encodeURIComponent(shared.data.card.url)}`);
    assert.equal(shareResolve.data.card.kind, "link");
    assert.equal(shareResolve.data.card.target, "https://xsmmc.caldson.us.ci/");
});

test("3.1.0：聊天消息里的站内链接自动带卡片并可被转发", async () => {
    const { env, tokens } = await prepare();
    const midiId = await createMidi(env, tokens.Alice, "聊天识别");

    /* 先建立 Alice / Bob 的单聊：直接通过接口搜用户并发好友请求太重，这里用聊天记录模拟好友关系 */
    await env.ACCOUNTS_KV.put("chat:user:Alice", JSON.stringify({
        login: "Alice",
        conversations: [],
        friends: [{ login: "Bob", name: "鲍勃", at: Date.now() }],
        blocked: [],
        settings: {}
    }));
    await env.ACCOUNTS_KV.put("chat:user:Bob", JSON.stringify({
        login: "Bob",
        conversations: [],
        friends: [{ login: "Alice", name: "爱丽丝", at: Date.now() }],
        blocked: [],
        settings: {}
    }));

    const direct = await api(env, "POST", "/api/chat/conversations/direct", {
        token: tokens.Alice,
        body: { login: "Bob" }
    });
    assert.equal(direct.status, 200, JSON.stringify(direct.data));
    const conversation = direct.data.conversation.id;

    const sent = await api(env, "POST", `/api/chat/conversations/${conversation}/messages`, {
        token: tokens.Alice,
        body: { text: `分享一首：https://api.test/vimidi.html?id=${midiId}` }
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    assert.equal(sent.data.message.card.kind, "midi");
    assert.equal(sent.data.message.card.title, "聊天识别");

    const forwarded = await api(env, "POST", `/api/chat/messages/${sent.data.message.id}/forward?conversation=${conversation}`, {
        token: tokens.Alice,
        body: { targets: [conversation] }
    });
    assert.equal(forwarded.status, 201, JSON.stringify(forwarded.data));
    assert.equal(forwarded.data.messages[0].message.card.kind, "midi");
});
