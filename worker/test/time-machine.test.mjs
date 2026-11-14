import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 12.1.2：设置页时光回溯机与历史 HTML 快照 */

const root = new URL("../../", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), "utf8");

test("12.1.2：时光回溯机清单包含 84 个历史版本，且只列 HTML", () => {
    const manifest = JSON.parse(read("history/manifest.json"));
    assert.equal(manifest.beta, true);
    assert.equal(manifest.versions.length, 84);
    for (const entry of manifest.versions) {
        assert.match(entry.version, /^\d+\.\d+(?:\.\d+)?$/);
        assert.ok(entry.files.length > 0, `${entry.version} 没有文件`);
        for (const file of entry.files) {
            assert.match(file, /\.html?$/i, `${entry.version} 列出了非 HTML：${file}`);
            assert.equal(
                fs.existsSync(new URL(`history/${entry.version}/${file}`, root)),
                true,
                `${entry.version}/${file} 不存在`
            );
        }
    }
    assert.equal(manifest.versions[0].version, "10.1.1");
    assert.equal(manifest.versions[0].commit, "bd2120a675bcc62510bd1b9f0f72e8532fb1d6c9");
    assert.equal(manifest.versions[manifest.versions.length - 1].version, "1.0");
    assert.equal(manifest.versions[manifest.versions.length - 1].commit, "7d5b39085b28959ea00a4df39ca99ee6c1aa1f4c");
    for (const version of ["1.0", "1.0.0", "5.0", "7.0", "8.1.2", "8.2.0", "9.0.0", "9.3", "9.5.1", "9.6.0", "10.0.0", "10.1.0", "10.1.1"]) {
        assert.ok(manifest.versions.some((entry) => entry.version === version), `缺少 ${version}`);
    }
});

test("12.1.2：历史页面移除停服守卫和 PWA 注册", () => {
    for (const version of ["8.2.0", "9.0.0", "9.6.0"]) {
        const html = read(`history/${version}/index.html`);
        assert.doesNotMatch(html, /document\.write\(.<script src="vtx-closed\.js/);
        assert.doesNotMatch(html, /<script[^>]+src="vtx-pwa\.js/);
    }
});

test("12.1.2：设置页底部有时光回溯机入口", () => {
    const settings = read("settings.html");
    assert.match(settings, /id="time-machine"/);
    assert.match(settings, /时光回溯机/);
    assert.match(settings, /history\/manifest\.json/);
    assert.match(settings, /tm-file-list/);
    assert.match(settings, /tm-modal/);
    assert.match(settings, /onlyHtml/);
    assert.match(settings, /tm-version-select/);
    assert.match(settings, /shortVersion/);
    assert.match(settings, /共 \$\{versions\.length\} 个版本/);
});

test("12.1.2：版本号与 Service Worker 缓存同步", () => {
    assert.equal(JSON.parse(read("version.json")).version, "12.1.2");
    assert.match(read("vtx-sw.js"), /xring-v12\.1\.2/);
    assert.match(read("vtx-api.js"), /API_VERSION = "12\.1\.2"/);
});
