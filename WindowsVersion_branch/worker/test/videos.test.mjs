import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";

/* 1.7.0：Vitx® 视频改为服务端存储（KV）的回归测试 */

const SCHEME = ["B", "e", "a", "r", "e", "r"].join("");

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

const SEED = {
    Kitawaga: { password: "password1", username: "站主", money: "100.00", trades: [], data: {} },
    Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} },
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
        // 每个用例一个独立 IP，避开模块级的登录限流
        __ip: `10.7.${Math.floor(envCount / 250)}.${envCount % 250}`
    };
}

async function api(env, method, path, options = {}) {
    const headers = new Headers();
    if (env.__ip) {
        headers.set("cf-connecting-ip", env.__ip);
    }
    if (options.token) {
        headers.set("authorization", `${SCHEME} ${options.token}`);
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
        const result = await api(env, "POST", "/api/login", { body: { login: name, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[name] = result.data.token;
    }
    return { env, tokens };
}

const BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5]);

async function upload(env, token, overrides = {}) {
    const created = await api(env, "POST", "/api/videos", {
        token,
        body: {
            title: "测试投稿",
            desc: "这是测试",
            cat: "生活",
            tags: ["测试"],
            declarations: ["ai"],
            fileName: "demo.mp4",
            fileType: "video/mp4",
            fileSize: BYTES.byteLength,
            ...overrides
        }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.video.id;
    const put = await api(env, "PUT", `/api/videos/${id}/file`, {
        token,
        raw: BYTES,
        contentType: "video/mp4"
    });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    return put.data.video;
}

test("1.7.0：列表一开始是空的，老的示例视频会被清理掉", async () => {
    const { env, tokens } = await prepare();

    // 模拟早期版本写进 KV 的 v_demo* 数据（在第一次请求前写入）
    await env.ACCOUNTS_KV.put("video:meta:v_demo0001", JSON.stringify({
        id: "v_demo0001",
        title: "旧示例",
        cat: "生活",
        owner: "Caldson",
        status: "published",
        seed: true,
        views: 100,
        likes: [],
        at: Date.now()
    }));
    await env.ACCOUNTS_KV.put("video:file:v_demo0001", new Uint8Array([1, 2, 3]));
    await env.ACCOUNTS_KV.put("video:comments:v_demo0001", JSON.stringify([]));
    await env.ACCOUNTS_KV.put("video:index", JSON.stringify(["v_demo0001"]));

    // 第一次请求就把它们清干净
    const list = await api(env, "GET", "/api/videos", { token: tokens.Kitawaga });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.equal(list.data.count, 0);
    assert.deepEqual(list.data.videos, []);
    assert.equal(await env.ACCOUNTS_KV.get("video:meta:v_demo0001"), null);
    assert.equal(await env.ACCOUNTS_KV.get("video:file:v_demo0001"), null);
    assert.equal(await env.ACCOUNTS_KV.get("video:comments:v_demo0001"), null);

    // 清理跑过之后再写进来的脏数据也不会露出来
    await env.ACCOUNTS_KV.put("video:meta:v_demo9999", JSON.stringify({
        id: "v_demo9999",
        title: "又一条旧示例",
        cat: "生活",
        owner: "Caldson",
        status: "published",
        seed: true,
        views: 5,
        likes: [],
        at: Date.now()
    }));
    await env.ACCOUNTS_KV.put("video:index", JSON.stringify(["v_demo9999"]));

    const again = await api(env, "GET", "/api/videos", { token: tokens.Kitawaga });
    assert.equal(again.data.count, 0);
    const gone = await api(env, "GET", "/api/videos/v_demo9999", { token: tokens.Kitawaga });
    assert.equal(gone.status, 404);

    // 真实投稿不受影响
    const video = await upload(env, tokens.Alice, {});

    const mine = await api(env, "GET", "/api/videos", { token: tokens.Alice });
    assert.equal(mine.data.count, 1);
    assert.equal(mine.data.videos[0].id, video.id);
});
test("1.7.0：投稿要登录，文件存 KV，未审核前只有自己和管理员能看到", async () => {
    const { env, tokens } = await prepare();

    const anonymous = await api(env, "POST", "/api/videos", {
        body: { title: "匿名", cat: "生活", fileName: "a.mp4", fileSize: 10 }
    });
    assert.equal(anonymous.status, 401);

    const video = await upload(env, tokens.Alice);
    assert.equal(video.status, "pending");
    assert.equal(video.fileSize, BYTES.byteLength);
    assert.equal(video.owner, "Alice");
    assert.equal(video.declarations[0], "ai");

    const stored = await env.ACCOUNTS_KV.get(`video:file:${video.id}`, "arrayBuffer");
    assert.equal(new Uint8Array(stored).byteLength, BYTES.byteLength);

    const ownerView = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Alice });
    assert.equal(ownerView.status, 200, JSON.stringify(ownerView.data));
    assert.equal(ownerView.data.video.playable, false);

    const strangerView = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Bob });
    assert.equal(strangerView.status, 404);

    const aliceList = await api(env, "GET", "/api/videos", { token: tokens.Alice });
    assert.equal(aliceList.data.videos.some((item) => item.id === video.id), true);

    const bobList = await api(env, "GET", "/api/videos", { token: tokens.Bob });
    assert.equal(bobList.data.videos.some((item) => item.id === video.id), false);
});

test("1.7.0：审核通过后任何人可看，文件支持 Range", async () => {
    const { env, tokens } = await prepare();
    const video = await upload(env, tokens.Alice);

    const bobBefore = await api(env, "GET", `/api/videos/${video.id}/file`, { token: tokens.Bob });
    assert.equal(bobBefore.status, 404);

    const approved = await api(env, "POST", `/api/videos/${video.id}/approve`, { token: tokens.Kitawaga });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.video.status, "published");

    const bobAfter = await api(env, "GET", `/api/videos/${video.id}/file`);
    assert.equal(bobAfter.status, 200);
    assert.equal(bobAfter.response.headers.get("content-type"), "video/mp4");
    assert.equal(new Uint8Array(bobAfter.data).byteLength, BYTES.byteLength);

    const partial = await api(env, "GET", `/api/videos/${video.id}/file`, {
        headers: { range: "bytes=2-4" }
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.response.headers.get("content-range"), `bytes 2-4/${BYTES.byteLength}`);
    assert.equal(new Uint8Array(partial.data).byteLength, 3);

    const withToken = await api(env, "GET", `/api/videos/${video.id}/file?token=${encodeURIComponent(tokens.Bob)}`);
    assert.equal(withToken.status, 200);
});

test("1.7.0：审核中不能播放、别人不能删，作者和站主可以删", async () => {
    const { env, tokens } = await prepare();
    const video = await upload(env, tokens.Alice);

    const rejected = await api(env, "POST", `/api/videos/${video.id}/reject`, { token: tokens.Kitawaga });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.video.status, "rejected");

    const bobDelete = await api(env, "DELETE", `/api/videos/${video.id}`, { token: tokens.Bob });
    assert.equal(bobDelete.status, 403);

    const aliceDelete = await api(env, "DELETE", `/api/videos/${video.id}`, { token: tokens.Alice });
    assert.equal(aliceDelete.status, 200);

    const gone = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Alice });
    assert.equal(gone.status, 404);
    assert.equal(await env.ACCOUNTS_KV.get(`video:file:${video.id}`), null);

    const adminDelete = await upload(env, tokens.Alice);
    const removed = await api(env, "DELETE", `/api/videos/${adminDelete.id}`, { token: tokens.Kitawaga });
    assert.equal(removed.status, 200);
});

test("1.7.0：评论存在服务端，可点赞、只能删自己的", async () => {
    const { env, tokens } = await prepare();
    const video = await upload(env, tokens.Alice);
    await api(env, "POST", `/api/videos/${video.id}/approve`, { token: tokens.Kitawaga });

    const added = await api(env, "POST", `/api/videos/${video.id}/comments`, {
        token: tokens.Bob,
        body: { text: "看起来很赞" }
    });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    const commentId = added.data.comment.id;

    const detail = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Alice });
    assert.equal(detail.data.comments.length, 1);
    assert.equal(detail.data.comments[0].text, "看起来很赞");
    assert.equal(detail.data.video.comments, 1);

    const liked = await api(env, "POST", `/api/videos/${video.id}/comments/${commentId}/like`, { token: tokens.Alice });
    assert.equal(liked.status, 200, JSON.stringify(liked.data));
    assert.equal(liked.data.likes, 1);
    assert.equal(liked.data.comment.liked, true);

    const unlike = await api(env, "POST", `/api/videos/${video.id}/comments/${commentId}/like`, { token: tokens.Alice });
    assert.equal(unlike.data.likes, 0);

    const foreignDelete = await api(env, "DELETE", `/api/videos/${video.id}/comments/${commentId}`, { token: tokens.Alice });
    assert.equal(foreignDelete.status, 403);

    const ownDelete = await api(env, "DELETE", `/api/videos/${video.id}/comments/${commentId}`, { token: tokens.Bob });
    assert.equal(ownDelete.status, 200);
    assert.equal(ownDelete.data.count, 0);
});

test("1.7.1：5 GB 以内可以投稿，超过 5 GB 或 100 小时会被拒绝", async () => {
    const { env, tokens } = await prepare();

    const status = await api(env, "GET", "/api/videos/status");
    assert.equal(status.data.maxBytes, 5 * 1024 * 1024 * 1024);
    assert.equal(status.data.maxDurationSeconds, 100 * 3600);
    assert.equal(status.data.coinCents, 500);

    const tooBig = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: { title: "太大", cat: "生活", fileName: "big.mp4", fileSize: 6 * 1024 * 1024 * 1024 }
    });
    assert.equal(tooBig.status, 413);

    // 4.5 GB 的单条记录可以创建（文件本身走分片上传，这里只校验元信息）
    const big = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: {
            title: "四个半 G",
            cat: "生活",
            fileName: "huge.mp4",
            fileSize: 4.5 * 1024 * 1024 * 1024,
            durSeconds: 90 * 3600
        }
    });
    assert.equal(big.status, 201, JSON.stringify(big.data));
    assert.equal(big.data.video.dur, "90:00:00");
    assert.equal(big.data.video.durSeconds, 90 * 3600);

    const tooLong = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: { title: "太长", cat: "生活", fileName: "long.mp4", fileSize: 1024, durSeconds: 101 * 3600 }
    });
    assert.equal(tooLong.status, 400);

    const longOk = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: { title: "刚好一百小时", cat: "生活", fileName: "long.mp4", fileSize: 1024, dur: "100:00:00" }
    });
    assert.equal(longOk.status, 201, JSON.stringify(longOk.data));
    assert.equal(longOk.data.video.durSeconds, 100 * 3600);

    const badCat = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: { title: "分区错", cat: "不存在", fileName: "a.mp4", fileSize: 10 }
    });
    assert.equal(badCat.status, 400);

    const shortTitle = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: { title: "a", cat: "生活", fileName: "a.mp4", fileSize: 10 }
    });
    assert.equal(shortTitle.status, 400);

    const created = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: { title: "正常标题", cat: "生活", fileName: "a.mp4", fileSize: 10 }
    });
    assert.equal(created.status, 201);
    const id = created.data.video.id;

    const otherUpload = await api(env, "PUT", `/api/videos/${id}/file`, {
        token: tokens.Bob,
        raw: BYTES,
        contentType: "video/mp4"
    });
    assert.equal(otherUpload.status, 403);

    const empty = await api(env, "PUT", `/api/videos/${id}/file`, {
        token: tokens.Alice,
        raw: new Uint8Array([]),
        contentType: "video/mp4"
    });
    assert.equal(empty.status, 400);
});
test("1.7.0：点赞是账号级切换，播放量会累加，时长写进元信息", async () => {
    const { env, tokens } = await prepare();
    const video = await upload(env, tokens.Alice, { dur: "00:42" });
    assert.equal(video.dur, "00:42");

    const approve = await api(env, "POST", `/api/videos/${video.id}/approve`, { token: tokens.Kitawaga });
    assert.equal(approve.status, 200);

    const first = await api(env, "POST", `/api/videos/${video.id}/like`, { token: tokens.Bob });
    assert.equal(first.status, 200);
    assert.equal(first.data.liked, true);
    assert.equal(first.data.likes, 1);

    const second = await api(env, "POST", `/api/videos/${video.id}/like`, { token: tokens.Bob });
    assert.equal(second.data.liked, false);
    assert.equal(second.data.likes, 0);

    const anon = await api(env, "POST", `/api/videos/${video.id}/like`);
    assert.equal(anon.status, 401);

    const viewA = await api(env, "POST", `/api/videos/${video.id}/view`, { token: tokens.Bob });
    assert.equal(viewA.data.views, 1);
    const viewB = await api(env, "POST", `/api/videos/${video.id}/view`);
    assert.equal(viewB.data.views, 2);

    const detail = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Bob });
    assert.equal(detail.data.video.views, 2);
    assert.equal(detail.data.video.dur, "00:42");
});

/* 1.7.1：R2 的极简替身，够跑通 multipart 上传与 Range 读取 */
class MockR2 {
    constructor() {
        this.objects = new Map();
        this.uploads = new Map();
        this.nextId = 0;
    }

    async put(key, value, options) {
        const data = MockR2.toBuffer(value);
        this.objects.set(key, {
            data,
            contentType: (options && options.httpMetadata && options.httpMetadata.contentType) || ""
        });
    }

    async head(key) {
        const object = this.objects.get(key);
        return object ? { size: object.data.byteLength } : null;
    }

    async get(key, options) {
        const object = this.objects.get(key);
        if (!object) {
            return null;
        }
        let data = object.data;
        if (options && options.range) {
            const offset = Number(options.range.offset) || 0;
            const length = options.range.length === undefined ? data.byteLength - offset : Number(options.range.length);
            data = data.slice(offset, offset + length);
        }
        return { body: data, size: data.byteLength };
    }

    async delete(key) {
        this.objects.delete(key);
    }

    async createMultipartUpload(key, options) {
        this.nextId += 1;
        const uploadId = `upload-${this.nextId}`;
        const chunks = new Map();
        const contentType = (options && options.httpMetadata && options.httpMetadata.contentType) || "";
        const upload = {
            uploadId,
            key,
            uploadPart: async (number, value) => {
                const data = MockR2.toBuffer(value);
                chunks.set(Number(number), data);
                return { partNumber: Number(number), etag: `etag-${number}-${data.byteLength}` };
            },
            abort: async () => {
                chunks.clear();
            },
            complete: async (parts) => {
                const ordered = parts
                    .slice()
                    .sort((left, right) => left.partNumber - right.partNumber)
                    .map((part) => chunks.get(Number(part.partNumber)))
                    .filter(Boolean);
                const total = ordered.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                const merged = new Uint8Array(total);
                let offset = 0;
                for (const chunk of ordered) {
                    merged.set(new Uint8Array(chunk), offset);
                    offset += chunk.byteLength;
                }
                this.objects.set(key, { data: merged.buffer, contentType });
                chunks.clear();
                return { key };
            }
        };
        this.uploads.set(uploadId, upload);
        return upload;
    }

    resumeMultipartUpload(key, uploadId) {
        const upload = this.uploads.get(uploadId);
        if (!upload) {
            throw new Error("分片上传不存在");
        }
        return upload;
    }

    static toBuffer(value) {
        if (value instanceof ArrayBuffer) {
            return value;
        }
        if (ArrayBuffer.isView(value)) {
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
        return new TextEncoder().encode(String(value)).buffer;
    }
}

function withBucket(env) {
    env.VIDEO_BUCKET = new MockR2();
    return env;
}

test("1.8.1：关注 UP 主：关注、取关、列表与视频 following/followers", async () => {
    const { env, tokens } = await prepare();
    const video = await upload(env, tokens.Bob);
    const approved = await api(env, "POST", `/api/videos/${video.id}/approve`, {
        token: tokens.Kitawaga
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));

    const follow = await api(env, "POST", "/api/videos/follows/Bob", { token: tokens.Alice });
    assert.equal(follow.status, 200, JSON.stringify(follow.data));
    assert.equal(follow.data.following, true);
    assert.equal(follow.data.followers, 1);

    /* 重复关注保持幂等 */
    const again = await api(env, "POST", "/api/videos/follows/Bob", { token: tokens.Alice });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.followers, 1);

    const list = await api(env, "GET", "/api/videos", { token: tokens.Alice });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.deepEqual(list.data.following, ["Bob"]);
    const listed = list.data.videos.find((item) => item.id === video.id);
    assert.equal(listed.following, true);

    const detail = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Alice });
    assert.equal(detail.data.video.following, true);
    assert.equal(detail.data.video.followers, 1);

    const follows = await api(env, "GET", "/api/videos/follows", { token: tokens.Alice });
    assert.equal(follows.status, 200, JSON.stringify(follows.data));
    assert.deepEqual(follows.data.following, ["Bob"]);
    assert.equal(follows.data.items[0].name, "鲍勃");
    assert.equal(follows.data.items[0].followers, 1);

    /* Bob 自己看不算关注，也没关注自己 */
    const bobDetail = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Bob });
    assert.equal(bobDetail.data.video.following, false);
    assert.equal(bobDetail.data.video.followers, 1);

    const self = await api(env, "POST", "/api/videos/follows/Alice", { token: tokens.Alice });
    assert.equal(self.status, 400);

    const unknown = await api(env, "POST", "/api/videos/follows/Nobody", { token: tokens.Alice });
    assert.equal(unknown.status, 404);

    const anonymous = await api(env, "POST", "/api/videos/follows/Bob");
    assert.equal(anonymous.status, 401);

    const unfollow = await api(env, "DELETE", "/api/videos/follows/Bob", { token: tokens.Alice });
    assert.equal(unfollow.status, 200, JSON.stringify(unfollow.data));
    assert.equal(unfollow.data.following, false);
    assert.equal(unfollow.data.followers, 0);

    const after = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Alice });
    assert.equal(after.data.video.following, false);
    assert.equal(after.data.video.followers, 0);
});

test("1.7.1：绑定 R2 后用分片上传大文件，并按 Range 播放", async () => {
    const env = withBucket(createEnv());
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const name of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", { body: { login: name, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[name] = result.data.token;
    }

    const created = await api(env, "POST", "/api/videos", {
        token: tokens.Alice,
        body: {
            title: "分片上传测试",
            cat: "生活",
            fileName: "big.mp4",
            fileType: "video/mp4",
            fileSize: 12,
            durSeconds: 3725
        }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.r2, true);
    assert.equal(created.data.video.dur, "1:02:05");
    const id = created.data.video.id;

    const started = await api(env, "POST", `/api/videos/${id}/upload/start`, { token: tokens.Alice });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.chunkBytes, 20 * 1024 * 1024);

    const partOne = await api(env, "PUT", `/api/videos/${id}/upload/1`, {
        token: tokens.Alice,
        raw: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        contentType: "video/mp4"
    });
    assert.equal(partOne.status, 200, JSON.stringify(partOne.data));
    assert.equal(partOne.data.received, 8);

    const partTwo = await api(env, "PUT", `/api/videos/${id}/upload/2`, {
        token: tokens.Alice,
        raw: new Uint8Array([9, 10, 11, 12]),
        contentType: "video/mp4"
    });
    assert.equal(partTwo.data.received, 12);

    // 别人不能往我的分片上传里塞数据
    const stranger = await api(env, "PUT", `/api/videos/${id}/upload/3`, {
        token: tokens.Bob,
        raw: new Uint8Array([1]),
        contentType: "video/mp4"
    });
    assert.equal(stranger.status, 403);

    const done = await api(env, "POST", `/api/videos/${id}/upload/complete`, { token: tokens.Alice });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.video.status, "pending");
    assert.equal(done.data.video.fileSize, 12);

    const approve = await api(env, "POST", `/api/videos/${id}/approve`, { token: tokens.Kitawaga });
    assert.equal(approve.status, 200);

    const full = await api(env, "GET", `/api/videos/${id}/file`);
    assert.equal(full.status, 200);
    assert.equal(new Uint8Array(full.data).byteLength, 12);

    const ranged = await api(env, "GET", `/api/videos/${id}/file`, {
        headers: { range: "bytes=2-5" }
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.response.headers.get("content-range"), "bytes 2-5/12");
    assert.deepEqual(Array.from(new Uint8Array(ranged.data)), [3, 4, 5, 6]);

    const remove = await api(env, "DELETE", `/api/videos/${id}`, { token: tokens.Alice });
    assert.equal(remove.status, 200);
    assert.equal(await env.VIDEO_BUCKET.head(`video:file:${id}`), null);
});

test("1.7.1：投币一次扣 5.00 VTX 给投稿人，取消投币不退钱", async () => {
    const env = createEnv();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const name of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", { body: { login: name, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[name] = result.data.token;
    }

    const video = await upload(env, tokens.Alice);
    const approve = await api(env, "POST", `/api/videos/${video.id}/approve`, { token: tokens.Kitawaga });
    assert.equal(approve.status, 200);

    const before = await api(env, "GET", "/api/me", { token: tokens.Bob });
    assert.equal(before.data.account.money, "10.00");

    const first = await api(env, "POST", `/api/videos/${video.id}/coin`, { token: tokens.Bob });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.coined, true);
    assert.equal(first.data.coins, 1);
    assert.equal(first.data.cost, "5.00");
    assert.equal(first.data.account.money, "5.00");
    assert.equal(first.data.ownerMoney, "15.00");

    const bobAfter = await api(env, "GET", "/api/me", { token: tokens.Bob });
    assert.equal(bobAfter.data.account.money, "5.00");
    const aliceAfter = await api(env, "GET", "/api/me", { token: tokens.Alice });
    assert.equal(aliceAfter.data.account.money, "15.00");

    // 取消投币：不退钱、也不从投稿人账上扣回
    const cancel = await api(env, "POST", `/api/videos/${video.id}/coin`, { token: tokens.Bob });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
    assert.equal(cancel.data.coined, false);
    assert.equal(cancel.data.coins, 0);
    assert.equal(cancel.data.refunded, false);

    const bobCancel = await api(env, "GET", "/api/me", { token: tokens.Bob });
    assert.equal(bobCancel.data.account.money, "5.00");
    const aliceCancel = await api(env, "GET", "/api/me", { token: tokens.Alice });
    assert.equal(aliceCancel.data.account.money, "15.00");

    // 再投一次（余额 5.00 → 0.00），之后取消，再投会因为余额不足被拒
    const second = await api(env, "POST", `/api/videos/${video.id}/coin`, { token: tokens.Bob });
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.coined, true);
    const bobPoor = await api(env, "GET", "/api/me", { token: tokens.Bob });
    assert.equal(bobPoor.data.account.money, "0.00");

    const cancelAgain = await api(env, "POST", `/api/videos/${video.id}/coin`, { token: tokens.Bob });
    assert.equal(cancelAgain.status, 200);
    assert.equal(cancelAgain.data.coined, false);

    const broken = await api(env, "POST", `/api/videos/${video.id}/coin`, { token: tokens.Bob });
    assert.equal(broken.status, 400, JSON.stringify(broken.data));
    assert.equal(broken.data.error, "insufficient_funds");

    // 审核中的视频不能投币
    const pending = await upload(env, tokens.Alice);
    const notYet = await api(env, "POST", `/api/videos/${pending.id}/coin`, { token: tokens.Kitawaga });
    assert.equal(notYet.status, 409);

    const anon = await api(env, "POST", `/api/videos/${video.id}/coin`);
    assert.equal(anon.status, 401);

    // 列表与详情带出投币数
    const detail = await api(env, "GET", `/api/videos/${video.id}`, { token: tokens.Kitawaga });
    assert.equal(detail.data.video.coins, 0);
    assert.equal(detail.data.video.coinCents, 1000);
});

/* 1.7.2：没开通 R2 时文件存 GitHub Release。这里用一个极简的 GitHub 替身，
   只实现草稿 release、资源上传 / 删除、带 Range 的下载这四件事。 */
class MockGitHub {
    constructor() {
        this.releases = new Map();
        this.nextRelease = 0;
        this.nextAsset = 0;
        this.rangeSupported = true;
        this.calls = [];
        this.previous = null;
    }

    install() {
        this.previous = globalThis.fetch;
        const self = this;
        globalThis.fetch = async (input, init) => self.handle(String(input), init || {});
        return this;
    }

    restore() {
        if (this.previous) {
            globalThis.fetch = this.previous;
        }
    }

    releaseByTag(tag) {
        for (const release of this.releases.values()) {
            if (release.tag === tag) {
                return release;
            }
        }
        return null;
    }

    allAssets() {
        const list = [];
        for (const release of this.releases.values()) {
            for (const asset of release.assets.values()) {
                list.push(asset);
            }
        }
        return list;
    }

    async handle(url, init) {
        const method = String(init.method || "GET").toUpperCase();
        const parsed = new URL(url);
        this.calls.push(`${method} ${parsed.origin}${parsed.pathname}`);

        let match = parsed.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases$/);
        if (match && method === "POST") {
            const body = JSON.parse(String(init.body || "{}"));
            if (this.releaseByTag(body.tag_name)) {
                return new Response(JSON.stringify({ message: "already_exists" }), { status: 422 });
            }
            this.nextRelease += 1;
            this.releases.set(this.nextRelease, {
                id: this.nextRelease,
                tag: body.tag_name,
                draft: body.draft === true,
                assets: new Map()
            });
            return new Response(JSON.stringify({ id: this.nextRelease, tag_name: body.tag_name }), { status: 201 });
        }

        match = parsed.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/);
        if (match && method === "DELETE") {
            this.releases.delete(Number(match[1]));
            return new Response(null, { status: 204 });
        }

        match = parsed.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/);
        if (match && method === "DELETE") {
            const assetId = Number(match[1]);
            for (const release of this.releases.values()) {
                release.assets.delete(assetId);
            }
            return new Response(null, { status: 204 });
        }

        match = parsed.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/);
        if (match && method === "POST") {
            const release = this.releases.get(Number(match[1]));
            if (!release) {
                return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
            }
            const name = parsed.searchParams.get("name") || "";
            for (const asset of release.assets.values()) {
                if (asset.name === name) {
                    return new Response(JSON.stringify({ message: "already_exists" }), { status: 422 });
                }
            }
            this.nextAsset += 1;
            const data = MockGitHub.toBuffer(init.body);
            release.assets.set(this.nextAsset, { id: this.nextAsset, name, data });
            return new Response(JSON.stringify({
                id: this.nextAsset,
                name,
                size: data.byteLength
            }), { status: 201 });
        }

        match = parsed.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/);
        if (match && method === "GET") {
            const assetId = Number(match[1]);
            let found = null;
            for (const release of this.releases.values()) {
                if (release.assets.has(assetId)) {
                    found = release.assets.get(assetId);
                }
            }
            if (!found) {
                return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
            }
            const bytes = new Uint8Array(found.data);
            const header = new Headers(init.headers).get("range") || "";
            const range = /^bytes=(\d+)-(\d+)$/.exec(header);
            if (range && this.rangeSupported) {
                const start = Number(range[1]);
                const end = Math.min(Number(range[2]), bytes.byteLength - 1);
                return new Response(bytes.slice(start, end + 1), {
                    status: 206,
                    headers: { "content-range": `bytes ${start}-${end}/${bytes.byteLength}` }
                });
            }
            return new Response(bytes, { status: 200 });
        }

        return new Response(JSON.stringify({ message: `unexpected ${method} ${parsed.pathname}` }), { status: 500 });
    }

    static toBuffer(value) {
        if (value instanceof ArrayBuffer) {
            return value;
        }
        if (ArrayBuffer.isView(value)) {
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
        return new TextEncoder().encode(String(value)).buffer;
    }
}

async function prepareGithub() {
    const env = createEnv();
    env.REPO = "Caldson/Vitual-XRing";
    env.GITHUB_TOKEN = "ghp_test_token";
    const hub = new MockGitHub().install();
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const name of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", { body: { login: name, password: "password1" } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[name] = result.data.token;
    }
    return { env, hub, tokens };
}

test("1.7.2：没绑 R2 时文件改存 GitHub 草稿 release，分片上传与 Range 播放都通", async () => {
    const { env, hub, tokens } = await prepareGithub();
    try {
        const status = await api(env, "GET", "/api/videos/status");
        assert.equal(status.data.storage, "gh");
        assert.equal(status.data.r2, false);
        assert.equal(status.data.chunkBytes, 32 * 1024 * 1024);
        assert.equal(status.data.maxBytes, 2 * 1024 * 1024 * 1024);

        const created = await api(env, "POST", "/api/videos", {
            token: tokens.Alice,
            body: {
                title: "GitHub 存储测试",
                cat: "生活",
                fileName: "gh.mp4",
                fileType: "video/mp4",
                fileSize: 12,
                durSeconds: 65
            }
        });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        assert.equal(created.data.storage, "gh");
        assert.equal(created.data.chunkBytes, 32 * 1024 * 1024);
        const id = created.data.video.id;

        const started = await api(env, "POST", `/api/videos/${id}/upload/start`, { token: tokens.Alice });
        assert.equal(started.status, 200, JSON.stringify(started.data));
        assert.equal(started.data.storage, "gh");
        assert.equal(started.data.chunkBytes, 32 * 1024 * 1024);

        const partOne = await api(env, "PUT", `/api/videos/${id}/upload/1`, {
            token: tokens.Alice,
            raw: new Uint8Array([1, 2, 3, 4, 5, 6]),
            contentType: "video/mp4"
        });
        assert.equal(partOne.status, 200, JSON.stringify(partOne.data));
        const partTwo = await api(env, "PUT", `/api/videos/${id}/upload/2`, {
            token: tokens.Alice,
            raw: new Uint8Array([7, 8, 9, 10, 11, 12]),
            contentType: "video/mp4"
        });
        assert.equal(partTwo.status, 200, JSON.stringify(partTwo.data));

        const done = await api(env, "POST", `/api/videos/${id}/upload/complete`, { token: tokens.Alice });
        assert.equal(done.status, 200, JSON.stringify(done.data));

        // 两片两个资源，release 是草稿
        const assets = hub.allAssets();
        assert.equal(assets.length, 2);
        const release = [...hub.releases.values()][0];
        assert.equal(release.draft, true);

        const approve = await api(env, "POST", `/api/videos/${id}/approve`, { token: tokens.Kitawaga });
        assert.equal(approve.status, 200, JSON.stringify(approve.data));

        // 第一片里的 Range
        const head = await api(env, "GET", `/api/videos/${id}/file`, {
            token: tokens.Alice,
            headers: { range: "bytes=1-2" }
        });
        assert.equal(head.status, 206);
        assert.equal(head.response.headers.get("content-range"), "bytes 1-2/12");
        assert.deepEqual(Array.from(new Uint8Array(head.data)), [2, 3]);

        // 跨片 Range 只回当前这一片，播放器自己会接着要下一段
        const cross = await api(env, "GET", `/api/videos/${id}/file`, {
            token: tokens.Alice,
            headers: { range: "bytes=4-9" }
        });
        assert.equal(cross.status, 206);
        assert.equal(cross.response.headers.get("content-range"), "bytes 4-5/12");
        assert.deepEqual(Array.from(new Uint8Array(cross.data)), [5, 6]);

        const tail = await api(env, "GET", `/api/videos/${id}/file`, {
            token: tokens.Alice,
            headers: { range: "bytes=6-11" }
        });
        assert.equal(tail.response.headers.get("content-range"), "bytes 6-11/12");
        assert.deepEqual(Array.from(new Uint8Array(tail.data)), [7, 8, 9, 10, 11, 12]);

        // 不带 Range 时先回第一片，带 accept-ranges
        const open = await api(env, "GET", `/api/videos/${id}/file`, { token: tokens.Alice });
        assert.equal(open.status, 206);
        assert.equal(open.response.headers.get("content-range"), "bytes 0-5/12");
        assert.equal(open.response.headers.get("accept-ranges"), "bytes");

        // 审核中的视频对别人依然不可见（GitHub 上是草稿 release，外面拿不到直链）
        const pendingVideo = await api(env, "POST", "/api/videos", {
            token: tokens.Alice,
            body: { title: "还没审核", cat: "生活", fileName: "p.mp4", fileType: "video/mp4", fileSize: 3 }
        });
        const pendingId = pendingVideo.data.video.id;
        const pendingFile = await api(env, "GET", `/api/videos/${pendingId}/file`, { token: tokens.Bob });
        assert.equal(pendingFile.status, 404);

        // 删除会把草稿 release 一起清掉
        const remove = await api(env, "DELETE", `/api/videos/${id}`, { token: tokens.Alice });
        assert.equal(remove.status, 200);
        assert.equal(hub.allAssets().length, 0);
        assert.equal(hub.releases.size, 0);
    } finally {
        hub.restore();
    }
});

test("1.7.2：GitHub 存储整包上传能播；上游不认 Range 时由 Worker 自己切字节", async () => {
    const { env, hub, tokens } = await prepareGithub();
    try {
        const created = await api(env, "POST", "/api/videos", {
            token: tokens.Alice,
            body: {
                title: "整包上传",
                cat: "生活",
                fileName: "one.mp4",
                fileType: "video/mp4",
                fileSize: BYTES.byteLength
            }
        });
        const id = created.data.video.id;
        const put = await api(env, "PUT", `/api/videos/${id}/file`, {
            token: tokens.Alice,
            raw: BYTES,
            contentType: "video/mp4"
        });
        assert.equal(put.status, 200, JSON.stringify(put.data));
        assert.equal(hub.allAssets().length, 1);

        const approve = await api(env, "POST", `/api/videos/${id}/approve`, { token: tokens.Kitawaga });
        assert.equal(approve.status, 200);

        // 上游老老实实按 Range 回 206
        const ranged = await api(env, "GET", `/api/videos/${id}/file`, {
            token: tokens.Alice,
            headers: { range: "bytes=2-4" }
        });
        assert.equal(ranged.status, 206);
        assert.equal(ranged.response.headers.get("content-range"), "bytes 2-4/9");
        assert.deepEqual(Array.from(new Uint8Array(ranged.data)), Array.from(BYTES.slice(2, 5)));

        // 上游无视 Range 回 200 整片：Worker 得自己切
        hub.rangeSupported = false;
        const sliced = await api(env, "GET", `/api/videos/${id}/file`, {
            token: tokens.Alice,
            headers: { range: "bytes=6-8" }
        });
        assert.equal(sliced.status, 206);
        assert.equal(sliced.response.headers.get("content-range"), "bytes 6-8/9");
        assert.deepEqual(Array.from(new Uint8Array(sliced.data)), Array.from(BYTES.slice(6, 9)));

        // 分片异常时删除也能清干净
        const remove = await api(env, "DELETE", `/api/videos/${id}`, { token: tokens.Alice });
        assert.equal(remove.status, 200);
        assert.equal(hub.allAssets().length, 0);
    } finally {
        hub.restore();
    }
});


test("1.7.2：VIDEO_GH_REPO = off 时强制退回 KV 分块，不碰 GitHub", async () => {
    const env = createEnv();
    env.REPO = "Caldson/Vitual-XRing";
    env.GITHUB_TOKEN = "ghp_test_token";
    env.VIDEO_GH_REPO = "off";
    const hub = new MockGitHub().install();
    try {
        const status = await api(env, "GET", "/api/videos/status");
        assert.equal(status.data.storage, "kv-chunks");
        assert.equal(status.data.chunkBytes, 20 * 1024 * 1024);
        assert.equal(status.data.maxBytes, 5 * 1024 * 1024 * 1024);
        assert.equal(hub.calls.length, 0);
    } finally {
        hub.restore();
    }
});
