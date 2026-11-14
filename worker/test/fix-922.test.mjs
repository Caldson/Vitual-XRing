import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 12.1.2：应急发布版本与更新链路检查 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("12.1.2：版本号、Service Worker 缓存与 version.json 同步", () => {
    const version = JSON.parse(read("version.json"));
    assert.equal(version.version, "12.1.2");
    assert.match(read("vtx-sw.js"), /xring-v12\.1\.2/);
    assert.match(read("vtx-pwa.js"), /CLIENT_VERSION = "12\.1\.2"/);
    assert.match(read("vtx-api.js"), /API_VERSION = "12\.1\.2"/);
    assert.match(read("index.html"), /v12\.1\.2/);
});

test("12.1.2：更新链路支持清缓存后带版本参数重新加载，且不会永久放弃", () => {
    const pwa = read("vtx-pwa.js");
    const sw = read("vtx-sw.js");
    assert.match(pwa, /checkForNewVersion/);
    assert.match(pwa, /clearPageCaches/);
    assert.match(pwa, /attempts >= 3/);
    assert.match(pwa, /updateViaCache: "none"/);
    assert.match(pwa, /pageshow/);
    assert.match(pwa, /url\.searchParams\.set\("v", data\.version\)/);
    assert.doesNotMatch(sw, /ignoreSearch: true/);
});

test("12.1.2：Vord 与 9.2.x 修复仍在发布内容中", () => {
    const home = read("index.html");
    assert.match(home, /href="vord\.html"/);
    assert.match(home, /打开 Vord 文档/);
    const manager = read("manager.html");
    assert.match(manager, /\[data-theme="dark"\] \.account-shortcut/);
    assert.match(manager, /\.checkin-button:not\(:disabled\)/);
    assert.match(read("worker/index.js"), /function moneyCentsExact/);
});
