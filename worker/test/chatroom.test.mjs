import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const markdown = require("../../vtx-markdown.js");

/* 用最小 DOM 替身把 chatroom.html 里的内联脚本跑起来，
   只验证 1.7.3 新增的渲染函数（不启动整个页面）。 */

function makeEl(id) {
    return {
        id,
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        hidden: false,
        innerHTML: "",
        textContent: "",
        className: "",
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        focus() {},
        setSelectionRange() {},
        scrollIntoView() {},
        closest() { return null; }
    };
}

function loadChatroom() {
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
        createElement(tag) { return makeEl(tag); }
    };
    document.documentElement = makeEl("html");
    document.documentElement.style.setProperty = () => {};
    document.body = makeEl("body");

    globalThis.window = {
        innerWidth: 1200,
        innerHeight: 800,
        addEventListener() {},
        VTXMarkdown: markdown,
        VTXApi: null
    };
    globalThis.document = document;
    globalThis.location = { href: "http://localhost/chatroom.html", protocol: "http:", search: "" };
    globalThis.confirm = () => true;
    globalThis.alert = () => {};
    Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: null },
        configurable: true
    });

    const html = fs.readFileSync(new URL("../../chatroom.html", import.meta.url), "utf8");
    const match = html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/);
    assert.ok(match, "chatroom.html 里应能找到内联脚本");

    const code = match[1].replace(/\}\)\(\);\s*$/, `
        globalThis.__chatTest = {
            state,
            renderMarkdown,
            messageTextHtml,
            transferCard,
            transferStatusLabel,
            messagePreviewText,
            isAudioMedia,
            unoInviteCard
        };
    })();`);
    vm.runInThisContext(code, { filename: "chatroom-inline.js" });
    return globalThis.__chatTest;
}

test("1.7.3：聊天室用 Markdown 渲染消息（代码块 / 时间块 / @）", () => {
    const chat = loadChatroom();
    const html = chat.renderMarkdown("# 标题\n**粗体** <t:1700000000:R> @Bob", ["Bob"]);
    assert.match(html, /<div class="md-h1">标题<\/div>/);
    assert.match(html, /<strong>粗体<\/strong>/);
    assert.match(html, /class="md-time"/);
    assert.match(html, /<span class="mention">@Bob<\/span>/);

    const code = chat.renderMarkdown("```js\nconst a = 1 < 2;\n```");
    assert.match(code, /<span class="md-code-lang">js<\/span>/);
    assert.match(code, /const a = 1 &lt; 2;/);
});

test("1.7.3：超过 500 字出现「.........展开」，短消息不折叠", () => {
    const chat = loadChatroom();
    const longText = `${"长消息。".repeat(140)}结束`;
    assert.ok(longText.length >= 500);

    const longHtml = chat.messageTextHtml({ id: "m1", text: longText, mentions: [] });
    assert.match(longHtml, /long-text-clamp/);
    assert.match(longHtml, /\.\.\.\.\.\.\.\.\.展开/);
    assert.match(longHtml, /data-longtext="m1"/);

    const shortHtml = chat.messageTextHtml({ id: "m2", text: "短消息", mentions: [] });
    assert.doesNotMatch(shortHtml, /long-text-clamp/);
    assert.doesNotMatch(shortHtml, /展开/);

    /* 边界：499 字不折叠，500 字开始折叠 */
    const justUnder = chat.messageTextHtml({ id: "m4", text: "a".repeat(499), mentions: [] });
    assert.doesNotMatch(justUnder, /long-text-clamp/);
    const exactly = chat.messageTextHtml({ id: "m5", text: "a".repeat(500), mentions: [] });
    assert.match(exactly, /long-text-clamp/);
    assert.match(exactly, /展开/);
});

test("1.7.3：转账卡片区分收款人 / 发送者，并生成会话预览", () => {
    const chat = loadChatroom();
    const transfer = {
        id: "tf_1",
        from: "Alice",
        fromName: "爱丽丝",
        to: "Bob",
        toName: "鲍勃",
        cents: 150,
        note: "午饭",
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60 * 1000
    };

    chat.state.me = "Bob";
    const forRecipient = chat.transferCard({ id: "m3", sender: "Alice", transfer });
    assert.match(forRecipient, /data-transfer="m3"/);
    assert.match(forRecipient, /1\.50 VTX/);
    assert.match(forRecipient, /点击收款/);
    assert.match(forRecipient, /午饭/);

    chat.state.me = "Alice";
    const forSender = chat.transferCard({ id: "m3", sender: "Alice", transfer });
    assert.match(forSender, /等待对方收款/);

    assert.equal(chat.transferStatusLabel(transfer), "待收款");
    assert.match(
        chat.messagePreviewText({ type: "transfer", transfer }),
        /^\[转账\] 1\.50 VTX 待收款$/
    );
});

test("1.8.0：识别音乐文件并生成 [音乐] 预览", () => {
    const chat = loadChatroom();
    assert.equal(chat.isAudioMedia({ name: "晴天.mp3", type: "audio/mpeg" }), true);
    assert.equal(chat.isAudioMedia({ name: "录音.m4a", type: "application/octet-stream" }), true);
    assert.equal(chat.isAudioMedia({ name: "song.flac", type: "" }), true);
    assert.equal(chat.isAudioMedia({ name: "photo.png", type: "image/png" }), false);
    assert.equal(chat.isAudioMedia(null), false);

    assert.equal(
        chat.messagePreviewText({ type: "file", media: { name: "晴天.mp3", type: "audio/mpeg" } }),
        "[音乐] 晴天.mp3"
    );
    assert.equal(
        chat.messagePreviewText({ type: "file", media: { name: "报告.pdf", type: "application/pdf" } }),
        "[文件] 报告.pdf"
    );
});

test("1.9.0：聊天室渲染 UNO 邀请卡片与会话预览", () => {
    const chat = loadChatroom();
    const invite = {
        roomId: "u_testroom",
        code: "ABC123",
        name: "周末开黑",
        mode: "normal",
        hostName: "爱丽丝",
        players: 2,
        capacity: 10,
        status: "waiting"
    };
    const card = chat.unoInviteCard({
        id: "m_uno",
        sender: "Alice",
        senderName: "爱丽丝",
        uno: invite
    });
    assert.match(card, /data-uno-room="u_testroom"/);
    assert.match(card, /周末开黑/);
    assert.match(card, /爱丽丝/);
    assert.match(card, /加入/);
    assert.match(card, /2\/10/);

    const finished = chat.unoInviteCard({
        id: "m_uno2",
        sender: "Alice",
        uno: { ...invite, status: "finished" }
    });
    assert.match(finished, /已结束/);
    assert.match(finished, /查看/);

    assert.equal(chat.messagePreviewText({ type: "uno" }), "[UNO 邀请] 一起来玩 UNO");
});

test("1.9.0：聊天室加载 UNO 右上角按钮、脚本与邀请入口", () => {
    const html = fs.readFileSync(new URL("../../chatroom.html", import.meta.url), "utf8");
    assert.match(html, /id="uno-btn"/);
    assert.match(html, /src="vtx-uno\.js\?v=1\.10\.0"/);
    assert.match(html, /href="vtx-uno\.css\?v=1\.10\.0"/);
    assert.match(html, /id="uno-invite-btn"/);
    assert.match(html, /REQUIRED_API_VERSION = "1\.10\.0"/);
});
