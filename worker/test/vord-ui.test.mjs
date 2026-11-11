import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 9.4.0：Vord 页面与 XOS 集成、首页 Microsoft Store 提示 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("9.4.0：Vord 页面包含 6 档链接权限和编辑记录入口", () => {
    const page = read("vord.html");
    for (const label of [
        "仅预览",
        "仅登录账号可预览",
        "仅受邀的账号可预览",
        "可编辑",
        "仅登录账号可编辑",
        "仅受邀的账号可编辑"
    ]) {
        assert.match(page, new RegExp(label), `缺少权限：${label}`);
    }
    assert.match(page, /匿名用户 \[网页版\]/);
    assert.match(page, /匿名用户 \[Windows版\]/);
    assert.match(page, /vtx-api\.js\?v=9\.4\.0/);
    assert.match(page, /api\.xos\.saveFile/);
    assert.match(page, /api\.vord\.editShared/);
    assert.match(page, /data-vtx-widget-avoid|vord-editor/);
});

test("9.4.0：XOS 桌面 / 云手机集成 Vord", () => {
    const xos = read("xos.html");
    assert.match(xos, /"txtpro", "vord"/);
    assert.match(xos, /APPS\.vord = \{/);
    assert.match(xos, /src="vord\.html"/);
    assert.match(xos, /xos:vord-saved/);
});

test("9.4.0：首页 Vord 入口与 Microsoft Store 暂停打包提示", () => {
    const home = read("index.html");
    assert.match(home, /href="vord\.html"/);
    assert.match(home, /id="store-cover"/);
    assert.match(home, /近期我们会暂停打包，因为微软可能过于繁忙。/);
    assert.match(home, /ms-store-badge/);
});

test("9.4.0：版本号与 Service Worker 缓存同步", () => {
    const version = JSON.parse(read("version.json"));
    assert.equal(version.version, "9.4.0");
    assert.match(read("vtx-sw.js"), /xring-v9\.4\.0/);
    assert.match(read("vtx-sw.js"), /vord\.html/);
    assert.match(read("vtx-api.js"), /const API_VERSION = "9\.4\.0"/);
});
