import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 12.1.2：BGM 播放器与听歌赚钱 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("12.1.2：BGM 播放器包含播放、循环模式、音量与听歌赚钱", () => {
    const bgm = read("vtx-bgm.js");
    assert.match(bgm, /audio\/your-beat\.mp3/);
    assert.match(bgm, /audio\/opening\.mp3/);
    assert.match(bgm, /单曲循环/);
    assert.match(bgm, /顺序循环/);
    assert.match(bgm, /随机循环/);
    assert.match(bgm, /每 20 秒 \+0\.01 VTX/);
    assert.match(bgm, /bgm\.reward/);
    assert.match(bgm, /manager\\\.html/);
    assert.match(bgm, /vtx-bgm-toggle/);
});

test("12.1.2：主题壳自动加载 BGM，音频文件存在", () => {
    const theme = read("vtx-theme.js");
    assert.match(theme, /vtx-bgm\.js\?v=/);
    assert.match(read("vtx-bgm.js"), /ensureApi/);
    for (const file of ["audio/opening.mp3", "audio/your-beat.mp3"]) {
        const path = new URL(file, root);
        assert.equal(fs.existsSync(path), true, `${file} 不存在`);
        assert.ok(fs.statSync(path).size > 10000, `${file} 太小`);
    }
});

test("12.1.2：Service Worker 不缓存 206 分片，避免音频播放器拿到 504", () => {
    const sw = read("vtx-sw.js");
    assert.match(sw, /request\.destination === "audio"/);
    assert.match(sw, /request\.headers\.get\("range"\)/);
    assert.match(sw, /response\.status === 200/);
});

test("12.1.2：BGM 接口与版本同步", () => {
    const api = read("vtx-api.js");
    assert.match(api, /bgmStart|bgm\.start|bgm = \{/);
    assert.match(api, /\/me\/bgm\/start/);
    assert.match(api, /\/me\/bgm\/reward/);
    const version = JSON.parse(read("version.json"));
    assert.equal(version.version, "12.1.2");
    assert.match(read("vtx-sw.js"), /xring-v12\.1\.2/);
});
