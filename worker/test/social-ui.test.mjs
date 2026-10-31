import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 3.1.0：七个新页面 + 聊天 / 视频评论 / 动态的静态接入检查。
   页面逻辑本身在浏览器里跑，这里只防止漏掉脚本、版本、登录卡片和关键入口。 */

const root = new URL("../../", import.meta.url);

function read(name) {
    return fs.readFileSync(new URL(name, root), "utf8");
}

test("3.1.0：七个新页面都加载 3.1.0 的 SDK 和分享卡片渲染器", () => {
    const pages = [
        "vimidi.html",
        "vmusic.html",
        "viratch.html",
        "audiv.html",
        "vistyle.html",
        "vclang.html",
        "vitx-dynamic.html",
        "share.html"
    ];
    for (const page of pages) {
        const html = read(page);
        assert.match(html, /vtx-api\.js\?v=3\.1\.0/, `${page} 缺少 vtx-api.js?v=3.1.0`);
        assert.match(html, /xring-social\.js\?v=3\.1\.0/, `${page} 缺少 xring-social.js?v=3.1.0`);
        assert.match(html, /v3\.1\.0/, `${page} 缺少版本徽标`);
        assert.doesNotMatch(html, /2\.1\.0/, `${page} 仍然引用旧版本 2.1.0`);
        assert.match(html, /manager\.html/, `${page} 缺少返回账户的入口`);
    }
});

test("3.1.0：聊天室和 Vitx 视频评论渲染分享卡片，Vitx 增加动态入口", () => {
    const chat = read("chatroom.html");
    assert.match(chat, /xring-social\.js\?v=3\.1\.0/);
    assert.match(chat, /message\.card/);
    assert.match(chat, /XRSocial\.cardHtml/);
    assert.match(chat, /REQUIRED_API_VERSION = "3\.1\.0"/);
    assert.match(chat, /PAGE_VERSION = "3\.1\.0"/);

    const video = read("vitxvideo.html");
    assert.match(video, /xring-social\.js\?v=3\.1\.0/);
    assert.match(video, /item\.card/);
    assert.match(video, /vitx-dynamic\.html/);
    assert.match(video, /v3\.1\.0/);
});

test("3.1.0：Vimidi / VMusic 的识别、播放和上传入口齐全", () => {
    const midi = read("vimidi.html");
    assert.match(midi, /VTXApi\.window|window\.VTXApi/);
    assert.match(midi, /musicId/);
    assert.match(midi, /\.upload\("midi"/);
    assert.match(midi, /\.publish\("midi"/);
    assert.match(midi, /vmusic\.html\?id=/);
    assert.match(midi, /下载 MIDI/);

    const music = read("vmusic.html");
    assert.match(music, /extra\.midiId/);
    assert.match(music, /api\(\)\.fileUrl/);
    assert.match(music, /<audio|new Audio|createElement\("audio"\)/);
    assert.match(music, /\.upload\("music"/);
    assert.match(music, /midiId/);
    assert.match(music, /vimidi\.html\?id=/);
});

test("3.1.0：Viratch 提供站内积木运行器和 .sb3 导入", () => {
    const html = read("viratch.html");
    assert.match(html, /requestAnimationFrame/);
    assert.match(html, /createInterpreter/);
    assert.match(html, /var MAX_SPRITES = 20/);
    assert.match(html, /var KNOWN_EVENTS/);
    assert.match(html, /turbowarp\.org\/embed/);
    assert.match(html, /editor-save-publish/);
    assert.match(html, /\.dev|\.sb3/);
    assert.match(html, /social\.create\("scratch"|\.create\(KIND/);
    assert.match(html, /social\.upload\(KIND/);
    assert.match(html, /social\.publish\(KIND/);
});

test("3.1.0：AUDIV 使用 WebRTC mesh 和会议信令", () => {
    const html = read("audiv.html");
    assert.match(html, /getUserMedia/);
    assert.match(html, /RTCPeerConnection/);
    assert.match(html, /meetingSocketUrl/);
    assert.match(html, /createMeeting/);
    assert.match(html, /joinMeeting/);
    assert.match(html, /endMeeting/);
    assert.match(html, /joinToken/);
    assert.match(html, /stun:stun\.l\.google\.com:19302/);
});

test("3.1.0：ViStyle 不做预览、管理员页面被明确排除，VClang 强制 .dev", () => {
    const style = read("vistyle.html");
    assert.doesNotMatch(style, /<iframe/i);
    assert.match(style, /vtxStylePack/);
    assert.match(style, /admin\.html/);
    assert.match(style, /accounts-admin\.html/);
    assert.match(style, /API_LOGIN\.html/);
    assert.match(style, /purchase\("style"/);
    assert.match(style, /上传|发布/);

    const cpp = read("vclang.html");
    assert.match(cpp, /\.dev/);
    assert.match(cpp, /<Project/);
    assert.match(cpp, /setFiles\("cpp"/);
    assert.match(cpp, /purchase\("cpp"/);
    assert.match(cpp, /code-line/);
});

test("3.1.0：动态页与通用分享落地页接口齐全", () => {
    const dynamic = read("vitx-dynamic.html");
    assert.match(dynamic, /social\.list\("dynamic"/);
    assert.match(dynamic, /social\.create\("dynamic"/);
    assert.match(dynamic, /social\.comments/);
    assert.match(dynamic, /social\.repost/);
    assert.match(dynamic, /social\.uploadImage/);
    assert.match(dynamic, /cardHtml\(/);
    assert.match(dynamic, /2000/);

    const share = read("share.html");
    assert.match(share, /COUNTDOWN_SECONDS = 3/);
    assert.match(share, /social\.shareGet/);
    assert.match(share, /social\.share\(/);
    assert.match(share, /share\.html\?id=/);
    assert.match(share, /http\(s\)|http:\/\/|https:\/\//);
});

test("3.1.0：SDK / manager 入口 / 文案与接口保持同步", () => {
    const sdk = read("vtx-api.js");
    assert.match(sdk, /const API_VERSION = "3\.1\.0"/);
    assert.match(sdk, /uploadImage: socialImageUpload/);
    assert.match(sdk, /redeem\(code\)/);
    assert.match(sdk, /meetingSocketUrl/);
    assert.match(sdk, /applyStylePack/);

    const manager = read("manager.html");
    assert.match(manager, /类="social-hub"|class="social-hub"/);
    for (const page of ["vimidi.html", "vmusic.html", "viratch.html", "audiv.html", "vistyle.html", "vclang.html", "vitx-dynamic.html", "share.html"]) {
        assert.match(manager, new RegExp(page.replace(".", "\\.")));
    }

    const social = read("worker/social.js");
    assert.match(social, /SOCIAL_IMAGE_MAX_BYTES/);
    assert.match(social, /resolveTextCard/);
});
