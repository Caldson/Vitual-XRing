import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

after(() => {
    if (globalThis.window && globalThis.window.VTXUno) {
        try {
            window.VTXUno.close();
        } catch (error) {
            /* 忽略 */
        }
    }
});

/* 1.9.0：用最小 DOM 替身跑 vtx-uno.js，验证大厅渲染、人机对战房间、
   选牌和出牌请求。真正的牌局规则在 uno.test.mjs 里测。 */

function makeNode(tag = "div") {
    const node = {
        tagName: String(tag).toUpperCase(),
        id: "",
        style: {},
        dataset: {},
        hidden: false,
        disabled: false,
        checked: false,
        value: "",
        textContent: "",
        innerHTML: "",
        className: "",
        scrollTop: 0,
        scrollHeight: 0,
        listeners: {},
        children: [],
        addEventListener(type, handler) {
            this.listeners[type] = handler;
        },
        removeEventListener() {},
        appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
        },
        querySelector(selector) {
            return (this._queries && this._queries.get(selector)) || null;
        },
        querySelectorAll() {
            return [];
        },
        closest(selector) {
            if (selector === "[data-uno-card]" && this.dataset.unoCard) {
                return this;
            }
            if (selector === "[data-uno-act]" && this.dataset.unoAct) {
                return this;
            }
            return null;
        },
        focus() {},
        setSelectionRange() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
    };
    return node;
}

function makeCard(id, color, value) {
    return { id, color, value };
}

function makeRoom(options = {}) {
    const status = options.status || "playing";
    const hand = options.hand || [makeCard("red:5:1", "red", "5"), makeCard("blue:7:1", "blue", "7"), makeCard("wild:wild4:1", "wild", "wild4")];
    return {
        id: "u_uitest",
        code: "UITEST",
        mode: options.mode || "ai",
        status,
        name: "测试房间",
        host: "Alice",
        hostName: "爱丽丝",
        settings: { teamMode: false, effectTargeting: true, maxPlayers: 10 },
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: status === "finished" ? Date.now() : 0,
        humans: 1,
        bots: 1,
        players: [
            {
                login: "Alice",
                name: "爱丽丝",
                uid: 1,
                bot: false,
                team: null,
                cards: hand.length,
                hand,
                skip: 0,
                host: true
            },
            {
                login: "bot_1",
                name: "机器人 1",
                uid: 0,
                bot: true,
                team: null,
                cards: 7,
                hand: null,
                skip: 0,
                host: false
            }
        ],
        me: {
            login: "Alice",
            name: "爱丽丝",
            team: null,
            isHost: true,
            hand,
            playable: hand.map((card) => card.id),
            effectTargets: ["bot_1"],
            teammates: []
        },
        game: {
            turnLogin: "Alice",
            turnName: "爱丽丝",
            direction: status === "playing" ? 1 : 0,
            color: "red",
            top: makeCard("red:9:1", "red", "9"),
            topLabel: "红9",
            deckCount: 80,
            discardCount: 12,
            drewThisTurn: false,
            drawCount: 0,
            turnNumber: 3,
            winners: status === "finished" ? ["Alice"] : [],
            winnerNames: status === "finished" ? ["爱丽丝"] : [],
            log: [{ at: Date.now(), kind: "play", text: "爱丽丝 出了 红9" }],
            lastAction: { at: Date.now(), kind: "play", text: "爱丽丝 出了 红9" }
        },
        chats: []
    };
}

function setupDom() {
    const document = {
        body: makeNode("body"),
        activeElement: null,
        hidden: false,
        createElement(tag) {
            const node = makeNode(tag);
            if (tag === "div" && !document.__overlay) {
                document.__overlay = node;
                const map = new Map();
                for (const selector of ["#vtx-uno-body", "#vtx-uno-dialog", "#vtx-uno-title", "#vtx-uno-sub"]) {
                    map.set(selector, makeNode("div"));
                }
                node._queries = map;
            }
            return node;
        },
        getElementById(id) {
            if (id === "uno-ai-bots" || id === "uno-mixed-bots") {
                return { value: "2", checked: false };
            }
            if (id === "uno-normal-team" || id === "uno-normal-target") {
                return { checked: true, value: "" };
            }
            if (id === "uno-join-code") {
                return { value: "", checked: false };
            }
            if (id === "uno-chat-input" || id === "uno-side-panel") {
                return makeNode("div");
            }
            return makeNode("div");
        },
        querySelectorAll() {
            return [];
        },
        querySelector() {
            return null;
        },
        addEventListener() {}
    };
    globalThis.document = document;
    globalThis.location = { href: "http://localhost/chatroom.html", search: "" };
    globalThis.window = {
        addEventListener() {},
        VTXApi: null
    };
    return document;
}

async function flush() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function click(node) {
    const overlay = document.body.children[0];
    assert.ok(overlay && overlay.listeners.click, "UNO 面板应该绑定了点击事件");
    overlay.listeners.click({
        target: node,
        preventDefault() {},
        stopPropagation() {}
    });
}

let prepared = null;

function prepare() {
    if (prepared) {
        return prepared;
    }
    const document = setupDom();
    const calls = { create: [], play: [], draw: [], start: [], invite: [] };
    const room = makeRoom();
    const api = {
        uno: {
            rooms: async () => ({
                rooms: [{ id: "u_other", name: "别人的房间", hostName: "Bob", humans: 1, bots: 0, capacity: 10, status: "waiting", mode: "normal" }],
                mine: [{ id: "u_mine", name: "我的房间", mode: "normal", status: "waiting", humans: 1, bots: 0 }]
            }),
            create: async (payload) => {
                calls.create.push(payload);
                return { room: makeRoom({ mode: payload.mode, status: payload.mode === "ai" ? "playing" : "waiting" }) };
            },
            match: async () => ({ created: true, room: makeRoom({ mode: "normal", status: "waiting" }) }),
            play: async (id, payload) => {
                calls.play.push({ id, payload });
                return { room: makeRoom() };
            },
            draw: async () => {
                calls.draw.push(true);
                const yellow = makeCard("yellow:1:1", "yellow", "1");
                const drawn = makeCard("red:1:1", "red", "1");
                const room = makeRoom({ hand: [yellow, drawn] });
                room.game.top = makeCard("yellow:5:1", "yellow", "5");
                room.game.color = "yellow";
                room.game.drewThisTurn = true;
                room.game.drawCount = 1;
                room.me.hand = [yellow, drawn];
                room.me.playable = ["yellow:1:1"];
                room.players[0].hand = room.me.hand;
                room.players[0].cards = 2;
                return { room, drawn, playable: false };
            },
            start: async () => {
                calls.start.push(true);
                return { room: makeRoom() };
            },
            invite: async (conversationId, roomId) => {
                calls.invite.push({ conversationId, roomId });
                return { ok: true };
            }
        }
    };
    vm.runInThisContext(fs.readFileSync(new URL("../../vtx-uno.js", import.meta.url), "utf8"), {
        filename: "vtx-uno.js"
    });
    assert.equal(window.VTXUno.version, "1.10.1");
    window.VTXUno.init({
        api,
        toast: () => {},
        getConversations: () => [],
        getCurrentConversation: () => null,
        refreshConversations: () => {}
    });
    prepared = { document, calls, api, overlay: document.body.children[0] };
    return prepared;
}

test("1.9.0：UNO 面板可以打开大厅并显示四种模式", async () => {
    const { overlay } = prepare();
    await window.VTXUno.open();
    assert.equal(overlay.hidden, false);
    const body = overlay.querySelector("#vtx-uno-body");
    assert.match(body.innerHTML, /人机对战/);
    assert.match(body.innerHTML, /创建普通房间/);
    assert.match(body.innerHTML, /混合对战/);
    assert.match(body.innerHTML, /随机匹配/);
    assert.match(body.innerHTML, /我的房间/);
    assert.match(body.innerHTML, /别人的房间/);
});

test("1.9.0：点击「开始对战」进入牌桌，选牌后可以出牌", async () => {
    const { overlay, calls } = prepare();
    const createButton = makeNode("button");
    createButton.dataset.unoAct = "create-ai";
    click(createButton);
    await flush();
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].mode, "ai");
    assert.equal(calls.create[0].bots, 2);

    const body = overlay.querySelector("#vtx-uno-body");
    assert.match(body.innerHTML, /uno-card/);
    assert.match(body.innerHTML, /轮到你了/);
    assert.match(body.innerHTML, /data-uno-card="red:5:1"/);

    const cardButton = makeNode("button");
    cardButton.dataset.unoCard = "red:5:1";
    click(cardButton);
    await flush();
    assert.match(body.innerHTML, /uno-card red[^"]*selected/);

    const playButton = makeNode("button");
    playButton.dataset.unoAct = "play";
    click(playButton);
    await flush();
    assert.equal(calls.play.length, 1);
    assert.deepEqual(calls.play[0].payload.cards, ["red:5:1"]);
    assert.equal(calls.play[0].payload.color, "red");
});

test("1.10.0：抽牌后提示与按钮状态会同步刷新，且可以继续抽", async () => {
    const { overlay, calls } = prepare();
    const drawButton = makeNode("button");
    drawButton.dataset.unoAct = "draw";
    click(drawButton);
    await flush();
    assert.equal(calls.draw.length, 1);
    const body = overlay.querySelector("#vtx-uno-body");
    assert.match(body.innerHTML, /本回合已抽 1 张/);
    assert.doesNotMatch(body.innerHTML, /data-uno-act="draw" disabled/);
});

test("1.10.1：抽到的红 1 可以和原来的黄 1 一起出，并选择转成红色", async () => {
    const { overlay, calls } = prepare();
    const body = overlay.querySelector("#vtx-uno-body");

    const yellowButton = makeNode("button");
    yellowButton.dataset.unoCard = "yellow:1:1";
    click(yellowButton);
    await flush();

    const redButton = makeNode("button");
    redButton.dataset.unoCard = "red:1:1";
    click(redButton);
    await flush();
    /* 红 1 本身压不住黄 5，但作为同点数批量牌可以被选中 */
    assert.match(body.innerHTML, /uno-card red[^"]*selected/);

    const playButton = makeNode("button");
    playButton.dataset.unoAct = "play";
    click(playButton);
    await flush();

    const colorButton = makeNode("button");
    colorButton.dataset.unoAct = "pick-color";
    colorButton.dataset.color = "red";
    click(colorButton);
    await flush();

    const last = calls.play[calls.play.length - 1];
    assert.ok(last, "应该发出出牌请求");
    assert.deepEqual(last.payload.cards.slice().sort(), ["red:1:1", "yellow:1:1"]);
    assert.equal(last.payload.color, "red");
});

test("1.10.0：万能 +4 先选颜色，再选抽 4 张还是 6 张", async () => {
    const { overlay, calls } = prepare();
    const lobbyButton = makeNode("button");
    lobbyButton.dataset.unoAct = "lobby";
    click(lobbyButton);
    await flush();
    const createButton = makeNode("button");
    createButton.dataset.unoAct = "create-ai";
    click(createButton);
    await flush();

    const cardButton = makeNode("button");
    cardButton.dataset.unoCard = "wild:wild4:1";
    click(cardButton);
    await flush();

    const playButton = makeNode("button");
    playButton.dataset.unoAct = "play";
    click(playButton);
    await flush();

    const redButton = makeNode("button");
    redButton.dataset.unoAct = "pick-color";
    redButton.dataset.color = "red";
    click(redButton);
    await flush();

    const sixButton = makeNode("button");
    sixButton.dataset.unoAct = "pick-penalty";
    sixButton.dataset.amount = "6";
    click(sixButton);
    await flush();

    const last = calls.play[calls.play.length - 1];
    assert.ok(last, "应该发出出牌请求");
    assert.deepEqual(last.payload.cards, ["wild:wild4:1"]);
    assert.equal(last.payload.color, "red");
    assert.equal(last.payload.drawAmount, 6);
    assert.equal(overlay.hidden, false);
});

test("1.9.0：大厅返回后仍能看到房间列表", async () => {
    const { overlay } = prepare();
    const lobbyButton = makeNode("button");
    lobbyButton.dataset.unoAct = "lobby";
    click(lobbyButton);
    await flush();
    const body = overlay.querySelector("#vtx-uno-body");
    assert.match(body.innerHTML, /UNO 大厅|人机对战/);
    window.VTXUno.close();
    assert.equal(overlay.hidden, true);
});
