import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 12.1.0：桌面版登录回退与历史页面 API 地址 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("12.1.0：桌面版本地 /api 404 时继续尝试线上 API", () => {
    const api = read("vtx-api.js");
    assert.match(api, /https:\/\/xsmmc\.caldson\.us\.ci\/api/);
    assert.match(api, /missingLocalApi/);
    assert.match(api, /error\.status === 404/);
    assert.match(api, /error\.status === 405/);
    assert.match(api, /if \(!missingLocalApi\) throw error/);
});

test("12.1.0：历史页面注入当前线上 API 地址", () => {
    const versions = ["1.0.0", "8.1.2", "8.2.0", "9.0.0", "9.5.1", "9.6.0"];
    for (const version of versions) {
        const html = read(`history/${version}/login.html`);
        assert.match(html, /api-bridge\.js/);
    }
    const bridge = read("history/api-bridge.js");
    assert.match(bridge, /window\.fetch/);
    assert.match(bridge, /XMLHttpRequest\.prototype\.open/);
    assert.ok(bridge.includes("/^\\/history"));
    assert.ok(bridge.includes("/api"));
});

test("12.1.0：版本号与 SW 缓存同步", () => {
    assert.equal(JSON.parse(read("version.json")).version, "12.1.0");
    assert.match(read("vtx-api.js"), /const API_VERSION = "12\.1\.0"/);
    assert.match(read("vtx-sw.js"), /xring-v12\.1\.0/);
});
