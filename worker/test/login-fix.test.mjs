import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 10.0.1：桌面版登录回退与历史页面 API 地址 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("10.0.1：桌面版本地 /api 404 时继续尝试线上 API", () => {
    const api = read("vtx-api.js");
    assert.match(api, /https:\/\/xsmmc\.caldson\.us\.ci\/api/);
    assert.match(api, /missingLocalApi/);
    assert.match(api, /error\.status === 404/);
    assert.match(api, /error\.status === 405/);
    assert.match(api, /if \(!missingLocalApi\) throw error/);
});

test("10.0.1：历史页面注入当前线上 API 地址", () => {
    const versions = ["8.2.0", "9.0.0", "9.5.1", "9.6.0"];
    for (const version of versions) {
        const html = read(`history/${version}/login.html`);
        assert.match(html, /window\.VTX_API_BASE="https:\/\/xsmmc\.caldson\.us\.ci\/api"/);
    }
});

test("10.0.1：版本号与 SW 缓存同步", () => {
    assert.equal(JSON.parse(read("version.json")).version, "10.0.1");
    assert.match(read("vtx-api.js"), /const API_VERSION = "10\.0\.1"/);
    assert.match(read("vtx-sw.js"), /xring-v10\.0\.1/);
});
