import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/* 用最小 DOM 替身跑 vitxvideo.html 的内联脚本，
   验证 1.8.1 关注 UP 主的按钮、关注筛选与取关逻辑。 */

function makeEl(id) {
    return {
        id,
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        hidden: false,
        disabled: false,
        checked: false,
        innerHTML: "",
        textContent: "",
        value: "",
        className: "",
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        focus() {},
        load() {},
        pause() {},
        removeAttribute() {},
        scrollIntoView() {},
        getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; }
    };
}

function loadVideoPage() {
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, makeEl(id));
            }
            return elements.get(id);
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        addEventListener() {},
        createElement(tag) { return makeEl(tag); },
        title: ""
    };
    document.documentElement = makeEl("html");
    document.body = makeEl("body");

    const storage = new Map();
    globalThis.localStorage = {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key)
    };
    globalThis.history = { pushState() {}, replaceState() {} };
    globalThis.addEventListener = () => {};
    globalThis.scrollTo = () => {};
    globalThis.location = { href: "http://localhost/vitxvideo.html", search: "", pathname: "/vitxvideo.html" };
    Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: null },
        configurable: true
    });

    const videoApi = {
        list: async () => ({
            videos: [],
            login: "Alice",
            isAdmin: false,
            maxBytes: 0,
            following: ["Bob"]
        }),
        get: async (id) => ({
            video: {
                id,
                title: "测试视频",
                desc: "简介",
                owner: "Bob",
                ownerName: "鲍勃",
                following: true,
                followers: 3,
                status: "published",
                playable: true,
                cat: "生活",
                tags: [],
                declarations: [],
                fileName: "a.mp4",
                fileType: "video/mp4",
                fileSize: 10,
                dur: "00:00",
                views: 1,
                likes: 0,
                coins: 0,
                comments: 0,
                at: Date.now()
            },
            comments: []
        }),
        fileUrl: () => "https://example.com/file",
        view: async () => ({ views: 2 }),
        follow: async () => ({ following: true, followers: 4 }),
        unfollow: async () => ({ following: false, followers: 3 }),
        like: async () => ({ liked: true, likes: 1 }),
        coin: async () => ({ coined: true, coins: 1 }),
        comment: async () => ({ count: 0 }),
        likeComment: async () => ({}),
        removeComment: async () => ({})
    };

    globalThis.window = {
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener() {},
        scrollTo() {},
        location: globalThis.location,
        VTXApi: { video: videoApi },
        VTXQR: null
    };
    globalThis.document = document;

    const html = fs.readFileSync(new URL("../../vitxvideo.html", import.meta.url), "utf8");
    const match = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/);
    assert.ok(match, "vitxvideo.html 里应能找到内联脚本");

    const code = match[1].replace(/\}\)\(\);\s*$/, `
        globalThis.__videoTest = {
            state,
            normalize,
            renderWatch,
            renderWatchFollow,
            openList,
            toggleFollow
        };
    })();`);
    vm.runInThisContext(code, { filename: "vitxvideo-inline.js" });
    return globalThis.__videoTest;
}

async function wait(ms = 80) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

test("1.8.1：视频页显示关注按钮、关注人数与「关注」筛选", async () => {
    const page = loadVideoPage();
    await wait();

    assert.deepEqual(page.state.follows, ["Bob"]);

    await page.renderWatch("v_123");
    const button = globalThis.document.getElementById("watch-follow");
    const count = globalThis.document.getElementById("watch-followers");
    assert.equal(button.hidden, false);
    assert.equal(button.textContent, "已关注");
    assert.equal(count.textContent, "3 人关注");

    page.state.videos = [page.normalize({
        id: "v_123",
        title: "测试视频",
        owner: "Bob",
        ownerName: "鲍勃",
        cat: "生活",
        status: "published",
        playable: true
    })];
    page.openList("following");
    assert.equal(globalThis.document.getElementById("list-title").textContent, "我关注的 UP 主");
    assert.equal(globalThis.document.getElementById("list-count").textContent, "1 个");

    /* 自己看自己的视频 */
    page.state.login = "Bob";
    page.renderWatchFollow({ owner: "Bob", followers: 3, following: false });
    assert.equal(button.textContent, "你自己");
    assert.equal(button.disabled, true);
});

test("1.8.1：点「已关注」可以取关并更新数量", async () => {
    const page = loadVideoPage();
    await wait();
    await page.renderWatch("v_123");
    page.state.login = "Alice";
    page.state.follows = ["Bob"];
    page.state.watch = page.normalize({ id: "v_123", owner: "Bob", ownerName: "鲍勃", following: true, followers: 3 });
    await page.toggleFollow();

    assert.deepEqual(page.state.follows, []);
    assert.equal(globalThis.document.getElementById("watch-follow").textContent, "+ 关注");
    assert.equal(globalThis.document.getElementById("watch-followers").textContent, "3 人关注");
});
