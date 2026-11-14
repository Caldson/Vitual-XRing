import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("12.1.3：Vtoy 页面包含应用编辑、权限弹窗与 VTX bridge", () => {
    const page = read("vtoy.html");
    assert.match(page, /vtoy\.html\?app=/);
    assert.match(page, /申请登录您的账户/);
    assert.match(page, /window\.VTX=/);
    assert.match(page, /getBalance/);
    assert.match(page, /\/vtoy\/apps/);
    assert.match(page, /allow-scripts/);
});

test("12.1.3：VDEX 页面包含全部套餐与企业版入口", () => {
    const page = read("vdex.html");
    assert.match(page, /VDEX\.HTML/);
    assert.match(page, /vdex\.html\?name=/);
    assert.match(page, /\/vdex\/plans/);
    assert.match(page, /API_LOGIN\.html/);
    assert.match(page, /API_VTXPAY\.html/);
    assert.doesNotMatch(page, /<div class="vdex-public-bar"/);
    assert.match(read("worker/vdex.js"), /100: 3200/);
    assert.match(read("worker/vdex.js"), /const multiplier/);
    assert.match(read("worker/vdex.js"), /storageBytes: size \* 1024 \* 1024/);
});

test("12.1.3：首页与账户页有 Vtoy / VDEX 入口", () => {
    assert.match(read("index.html"), /href="vtoy\.html"/);
    assert.match(read("index.html"), /href="vdex\.html"/);
    assert.match(read("manager.html"), /href="vtoy\.html"/);
    assert.match(read("manager.html"), /href="vdex\.html"/);
});
