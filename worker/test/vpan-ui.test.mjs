import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 9.4.0：VPAN 页面、首页活动与入口检查 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("9.4.0：VPAN 页面包含上传、套餐、分享和配额 UI", () => {
    const page = read("vpan.html");
    assert.match(page, /vpan\.files/);
    assert.match(page, /vpan\.uploadChunk/);
    assert.match(page, /vp-file-input/);
    assert.match(page, /vp-plan-modal/);
    assert.match(page, /vp-share-modal/);
    assert.match(page, /5 GB 免费/);
    assert.match(read("worker/vpan.js"), /100 TB/);
    assert.match(read("worker/vpan.js"), /49\.99/);
    assert.match(page, /首月/);
    assert.match(page, /dragenter/);
});

test("9.4.0：首页活动使用 events.json 与 16:9 图片", () => {
    const events = JSON.parse(read("events.json"));
    assert.equal(events.items.length, 10);
    for (const item of events.items) {
        assert.ok(item.title, "活动缺少标题");
        assert.match(item.image, /^EventPhoto\d+\.(svg|png|jpe?g|webp)$/i);
        assert.equal(fs.existsSync(new URL(item.image, root)), true, `${item.image} 不存在`);
        const svg = read(item.image);
        assert.match(svg, /width="1600" height="900"/);
    }
    const home = read("index.html");
    assert.match(home, /id="events"/);
    assert.match(home, /events\.json/);
    assert.match(home, /aspect-ratio: 16 \/ 9/);
});

test("9.4.0：首页 / 账户页 / XOS 都有 VPAN 入口", () => {
    assert.match(read("index.html"), /href="vpan\.html"/);
    assert.match(read("manager.html"), /href="vpan\.html"/);
    const xos = read("xos.html");
    assert.match(xos, /"vord", "vpan"/);
    assert.match(xos, /APPS\.vpan = \{/);
    assert.match(xos, /src="vpan\.html"/);
});

test("9.4.0：版本号与 Service Worker 缓存同步", () => {
    const version = JSON.parse(read("version.json"));
    assert.equal(version.version, "9.4.0");
    assert.match(read("vtx-sw.js"), /xring-v9\.4\.0/);
    assert.match(read("vtx-api.js"), /API_VERSION = "9\.4\.0"/);
    assert.match(read("index.html"), /v9\.4\.0/);
});
