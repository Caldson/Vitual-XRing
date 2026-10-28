import test from "node:test";
import assert from "node:assert/strict";

import worker from "../index.js";
import {
    advanceTurn,
    autoAssignTeams,
    cardLabel,
    createDeck,
    createRoom,
    drawForCurrent,
    eligibleEffectTargets,
    isPlayableCard,
    passTurn,
    playCards,
    roomView,
    runBotTurns,
    skipOf,
    startGame
} from "../uno.js";

/* ───────── 与 chat.test.mjs 相同的测试替身 ───────── */

class MockKV {
    constructor() {
        this.map = new Map();
    }

    async get(key, type) {
        const entry = this.map.get(key);
        if (!entry) {
            return null;
        }
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
            this.map.delete(key);
            return null;
        }
        const value = entry.value;
        if (type === "json") {
            return typeof value === "string" ? JSON.parse(value) : value;
        }
        if (type === "arrayBuffer") {
            if (value instanceof ArrayBuffer) {
                return value;
            }
            if (ArrayBuffer.isView(value)) {
                return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            }
            return new TextEncoder().encode(String(value)).buffer;
        }
        return value;
    }

    async put(key, value, options = {}) {
        this.map.set(key, {
            value,
            expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0
        });
    }

    async delete(key) {
        this.map.delete(key);
    }

    async list() {
        return { keys: Array.from(this.map.keys()).map((name) => ({ name })) };
    }
}

function createEnv() {
    const events = [];
    const chat = {
        events,
        idFromName: (name) => ({ name }),
        get: () => ({
            fetch: async (url, init) => {
                events.push({ url: String(url), payload: JSON.parse(init.body) });
                return new Response(JSON.stringify({ ok: true }), {
                    headers: { "content-type": "application/json" }
                });
            }
        })
    };

    return {
        ACCOUNTS_KV: new MockKV(),
        SIGNING_SECRET: "test-secret",
        CHAT_ENABLED: "true",
        ADMIN_ACCOUNT: "Kitawaga",
        ALLOWED_ORIGINS: "*",
        TOKEN_TTL_SECONDS: "3600",
        CHAT: chat
    };
}

const SEED = {
    Kitawaga: { password: "password1", username: "站主", money: "100.00", trades: [], data: {} },
    Alice: { password: "password1", username: "爱丽丝", money: "10.00", trades: [], data: {} },
    Bob: { password: "password1", username: "鲍勃", money: "10.00", trades: [], data: {} },
    Carol: { password: "password1", username: "卡罗尔", money: "10.00", trades: [], data: {} }
};

async function api(env, method, path, options = {}) {
    const headers = new Headers();
    if (env.__ip) {
        headers.set("cf-connecting-ip", env.__ip);
    }
    if (options.token) {
        headers.set("authorization", `Bearer ${options.token}`);
    }
    let body;
    if (options.body !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.body);
    }
    const response = await worker.fetch(new Request(`https://api.test${path}`, {
        method,
        headers,
        body
    }), env);
    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        data = null;
    }
    return { status: response.status, data, response };
}

let prepareCount = 0;

async function prepare() {
    const env = createEnv();
    prepareCount += 1;
    env.__ip = `10.1.0.${prepareCount}`;
    await env.ACCOUNTS_KV.put("accounts", JSON.stringify(SEED));
    const tokens = {};
    for (const name of Object.keys(SEED)) {
        const result = await api(env, "POST", "/api/login", {
            body: { login: name, password: "password1" }
        });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        tokens[name] = result.data.token;
    }
    return { env, tokens };
}

async function befriend(env, tokens, a, b) {
    const request = await api(env, "POST", "/api/chat/friends/requests", {
        token: tokens[a],
        body: { login: b, note: "UNO" }
    });
    assert.equal(request.status, 201, JSON.stringify(request.data));
    const decision = await api(env, "POST", `/api/chat/friends/requests/${request.data.request.id}/accept`, {
        token: tokens[b]
    });
    assert.equal(decision.status, 200, JSON.stringify(decision.data));
    return decision.data.conversation;
}

/* ───────── 直接构造牌局，方便验证规则 ───────── */

function makeCard(color, value, index = 1) {
    return { id: `${color}:${value}:${index}`, color, value };
}

function makeRoom(players = ["Alice", "Bob", "Carol"], settings = {}) {
    const room = createRoom({
        id: "u_testroom",
        code: "ABC123",
        mode: "normal",
        host: "Alice",
        hostName: "爱丽丝",
        settings: { effectTargeting: true, ...settings }
    });
    for (const login of players.slice(1)) {
        room.players.push({
            login,
            name: login,
            uid: 0,
            bot: false,
            team: null,
            joinedAt: Date.now()
        });
    }
    if (room.settings.teamMode) {
        autoAssignTeams(room);
    }
    const result = startGame(room);
    assert.equal(result.ok, true, JSON.stringify(result));
    return room;
}

function setTop(room, top, color) {
    room.game.discard = [top];
    room.game.color = color || top.color;
}

function setHand(room, login, cards) {
    room.game.hands[login] = cards;
}

/* ───────── 引擎 ───────── */

test("1.9.0：标准 UNO 牌堆 108 张，数字/功能牌数量正确", () => {
    const deck = createDeck();
    assert.equal(deck.length, 108);
    const count = (color, value) => deck.filter((card) => card.color === color && card.value === value).length;
    for (const color of ["red", "yellow", "green", "blue"]) {
        assert.equal(count(color, "0"), 1);
        assert.equal(count(color, "5"), 2);
        assert.equal(count(color, "skip"), 2);
        assert.equal(count(color, "reverse"), 2);
        assert.equal(count(color, "draw2"), 2);
    }
    assert.equal(count("wild", "wild"), 4);
    assert.equal(count("wild", "wild4"), 4);
    assert.equal(new Set(deck.map((card) => card.id)).size, 108);
    assert.equal(cardLabel(makeCard("red", "draw2")), "红+2");
});

test("1.9.0：批量出牌：同数字多颜色 + 指定最终颜色；颜色/点数不同会被拒绝", () => {
    const room = makeRoom();
    setTop(room, makeCard("red", "1"), "red");
    setHand(room, "Alice", [
        makeCard("red", "1", 1),
        makeCard("blue", "1", 1),
        makeCard("yellow", "1", 1),
        makeCard("green", "9")
    ]);
    const result = playCards(room, "Alice", ["red:1:1", "blue:1:1", "yellow:1:1"], { color: "blue" });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(room.game.color, "blue");
    assert.equal(room.game.discard[room.game.discard.length - 1].color, "blue");
    assert.equal(room.game.hands.Alice.length, 1);

    const top = room.game.discard[room.game.discard.length - 1];
    assert.equal(isPlayableCard(makeCard("blue", "5"), top, room.game.color), true);
    assert.equal(isPlayableCard(makeCard("red", "5"), top, room.game.color), false);
    assert.equal(isPlayableCard(makeCard("green", "1"), top, room.game.color), true);

    const colorRoom = makeRoom();
    setTop(colorRoom, makeCard("red", "1"), "red");
    setHand(colorRoom, "Alice", [makeCard("red", "1", 1), makeCard("blue", "1", 1), makeCard("green", "9")]);
    const badColor = playCards(colorRoom, "Alice", ["red:1:1", "blue:1:1"], { color: "green" });
    assert.equal(badColor.error.code, "bad_color");

    const mixedRoom = makeRoom();
    setHand(mixedRoom, "Alice", [makeCard("red", "2"), makeCard("blue", "3")]);
    setTop(mixedRoom, makeCard("red", "9"), "red");
    const mixed = playCards(mixedRoom, "Alice", ["red:2:1", "blue:3:1"], {});
    assert.equal(mixed.error.code, "mixed_batch");
});

test("1.9.0：反转牌按张数取余 2——3 张翻转一次，4 张不翻转", () => {
    const room = makeRoom(["Alice", "Bob", "Carol"]);
    setTop(room, makeCard("red", "reverse"), "red");
    setHand(room, "Alice", [
        makeCard("red", "reverse", 1),
        makeCard("blue", "reverse", 1),
        makeCard("green", "reverse", 1),
        makeCard("yellow", "5")
    ]);
    const before = room.game.direction;
    assert.equal(playCards(room, "Alice", ["red:reverse:1", "blue:reverse:1", "green:reverse:1"]).error, undefined);
    assert.equal(room.game.direction, -before);

    const room2 = makeRoom(["Alice", "Bob", "Carol"]);
    setTop(room2, makeCard("red", "reverse"), "red");
    setHand(room2, "Alice", [
        makeCard("red", "reverse", 1),
        makeCard("blue", "reverse", 1),
        makeCard("green", "reverse", 1),
        makeCard("yellow", "reverse", 1),
        makeCard("yellow", "5")
    ]);
    const direction = room2.game.direction;
    assert.equal(playCards(room2, "Alice", [
        "red:reverse:1", "blue:reverse:1", "green:reverse:1", "yellow:reverse:1"
    ]).error, undefined);
    assert.equal(room2.game.direction, direction);
});

test("1.9.0：两张禁止牌让目标连续两个轮回不能出牌", () => {
    const room = makeRoom(["Alice", "Bob", "Carol"]);
    setTop(room, makeCard("red", "skip"), "red");
    setHand(room, "Alice", [
        makeCard("red", "skip", 1),
        makeCard("blue", "skip", 2),
        makeCard("blue", "6"),
        makeCard("red", "7")
    ]);
    setHand(room, "Carol", [makeCard("blue", "5"), makeCard("red", "9")]);
    setHand(room, "Bob", [makeCard("blue", "6")]);
    const result = playCards(room, "Alice", ["red:skip:1", "blue:skip:2"], { targets: ["Bob"], color: "blue" });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(room.players[room.game.turnIndex].login, "Carol");
    assert.equal(skipOf(room, "Bob"), 1);

    assert.equal(playCards(room, "Carol", ["blue:5:1"]).error, undefined);
    assert.equal(room.players[room.game.turnIndex].login, "Alice");
    assert.equal(playCards(room, "Alice", ["blue:6:1"]).error, undefined);
    assert.equal(skipOf(room, "Bob"), 0);
    assert.equal(room.players[room.game.turnIndex].login, "Carol");
});

test("1.9.0：两张 +2 让目标摸 4 张并跳过；生效玩家只能选下家/队友", () => {
    const room = makeRoom(["Alice", "Bob", "Carol"]);
    setTop(room, makeCard("red", "draw2"), "red");
    setHand(room, "Alice", [
        makeCard("blue", "draw2", 1),
        makeCard("green", "draw2", 1),
        makeCard("red", "7")
    ]);
    const before = room.game.hands.Bob.length;
    const result = playCards(room, "Alice", ["blue:draw2:1", "green:draw2:1"], { targets: ["Bob"] });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(room.game.hands.Bob.length, before + 4);
    assert.equal(room.players[room.game.turnIndex].login, "Carol");

    const targetRoom = makeRoom(["Alice", "Bob", "Carol"]);
    assert.deepEqual(eligibleEffectTargets(targetRoom, "Alice").sort(), ["Bob", "Carol"]);
    setTop(targetRoom, makeCard("red", "skip"), "red");
    setHand(targetRoom, "Alice", [makeCard("red", "skip", 1), makeCard("red", "7")]);
    const illegal = playCards(targetRoom, "Alice", ["red:skip:1"], { targets: ["Alice"] });
    assert.equal(illegal.error.code, "bad_target");
});

test("1.9.0：关闭「设置生效玩家」后自动作用在下家", () => {
    const room = makeRoom(["Alice", "Bob", "Carol"], { effectTargeting: false });
    setTop(room, makeCard("red", "skip"), "red");
    setHand(room, "Alice", [makeCard("red", "skip", 1), makeCard("red", "7")]);
    const result = playCards(room, "Alice", ["red:skip:1"], { targets: ["Carol"] });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(room.players[room.game.turnIndex].login, "Carol");
    assert.equal(skipOf(room, "Bob"), 0);
});

test("1.9.0：组队模式下队友手牌可见、对手不可见，队内聊天只给队友", () => {
    const room = makeRoom(["Alice", "Bob", "Carol"], { teamMode: true });
    const alice = roomView(room, "Alice");
    const bob = alice.players.find((player) => player.login === "Bob");
    const carol = alice.players.find((player) => player.login === "Carol");
    assert.equal(bob.team, 1);
    assert.equal(carol.team, 0);
    assert.equal(bob.hand, null);
    assert.equal(Array.isArray(carol.hand), true);
    assert.equal(carol.hand.length, 7);
    assert.deepEqual(alice.me.teammates, ["Carol"]);

    room.chats.push(
        { id: "c1", login: "Alice", name: "爱丽丝", team: 0, scope: "global", text: "大家好", at: Date.now() },
        { id: "c2", login: "Alice", name: "爱丽丝", team: 0, scope: "team", text: "自己人", at: Date.now() },
        { id: "c3", login: "Bob", name: "鲍勃", team: 1, scope: "team", text: "对手队", at: Date.now() }
    );
    const aliceChats = roomView(room, "Alice").chats.map((message) => message.text);
    const bobChats = roomView(room, "Bob").chats.map((message) => message.text);
    assert.deepEqual(aliceChats, ["大家好", "自己人"]);
    assert.deepEqual(bobChats, ["大家好", "对手队"]);
});

test("1.9.0：抽牌后可以过牌；抽到不能出的牌自动结束回合", () => {
    const room = makeRoom(["Alice", "Bob"]);
    setTop(room, makeCard("red", "5"), "red");
    setHand(room, "Alice", [makeCard("blue", "9")]);
    room.game.deck = [makeCard("green", "7")];
    const drawn = drawForCurrent(room, "Alice");
    assert.equal(drawn.error, undefined, JSON.stringify(drawn));
    assert.equal(drawn.playable, false);
    assert.equal(room.players[room.game.turnIndex].login, "Bob");

    const room2 = makeRoom(["Alice", "Bob"]);
    setTop(room2, makeCard("red", "5"), "red");
    setHand(room2, "Alice", [makeCard("blue", "9")]);
    room2.game.deck = [makeCard("red", "8")];
    const drawn2 = drawForCurrent(room2, "Alice");
    assert.equal(drawn2.playable, true);
    assert.equal(room2.players[room2.game.turnIndex].login, "Alice");
    assert.equal(room2.game.drewThisTurn, true);
    assert.equal(playCards(room2, "Alice", ["red:8:1"]).error, undefined);
    assert.equal(room2.game.hands.Alice.length, 1);

    const room3 = makeRoom(["Alice", "Bob"]);
    assert.equal(passTurn(room3, "Alice").error.code, "cannot_pass");
});

test("1.9.0：组队模式下一名队友出完牌，整队获胜", () => {
    const room = makeRoom(["Alice", "Bob", "Carol"], { teamMode: true });
    setTop(room, makeCard("red", "5"), "red");
    setHand(room, "Alice", [makeCard("red", "6")]);
    const result = playCards(room, "Alice", ["red:6:1"]);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(room.status, "finished");
    assert.deepEqual(room.game.winners, ["Alice", "Carol"]);
});

test("1.9.0：两人局反转牌相当于让对手少出一次", () => {
    const room = makeRoom(["Alice", "Bob"]);
    setTop(room, makeCard("red", "reverse"), "red");
    setHand(room, "Alice", [makeCard("red", "reverse", 1), makeCard("red", "7")]);
    const result = playCards(room, "Alice", ["red:reverse:1"]);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(room.players[room.game.turnIndex].login, "Alice");
});

test("1.9.0：机器人会自动出牌、抽牌并回到真人回合", () => {
    const room = createRoom({
        id: "u_botroom",
        code: "BOT123",
        mode: "normal",
        host: "Alice",
        hostName: "Alice",
        settings: { effectTargeting: true }
    });
    room.players.push({
        login: "bot_test_1",
        name: "机器人 1",
        uid: 0,
        bot: true,
        team: null,
        joinedAt: Date.now()
    });
    assert.equal(startGame(room).ok, true);
    setTop(room, makeCard("red", "5"), "red");
    setHand(room, "Alice", [makeCard("red", "6"), makeCard("red", "9")]);
    setHand(room, "bot_test_1", [makeCard("red", "7"), makeCard("blue", "3")]);
    assert.equal(playCards(room, "Alice", ["red:6:1"]).error, undefined);
    runBotTurns(room);
    assert.equal(room.game.hands.bot_test_1.length, 1);
    assert.equal(room.players[room.game.turnIndex].login, "Alice");
});

test("1.9.0：万能牌必须选颜色，批量万能牌也按同一套规则", () => {
    const room = makeRoom(["Alice", "Bob"]);
    setTop(room, makeCard("red", "5"), "red");
    setHand(room, "Alice", [makeCard("wild", "wild", 1), makeCard("wild", "wild", 2), makeCard("red", "9")]);
    assert.equal(playCards(room, "Alice", ["wild:wild:1"]).error.code, "need_color");
    const result = playCards(room, "Alice", ["wild:wild:1", "wild:wild:2"], { color: "green" });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(room.game.color, "green");
    const top = room.game.discard[room.game.discard.length - 1];
    assert.equal(isPlayableCard(makeCard("red", "9"), top, room.game.color), false);
    assert.equal(isPlayableCard(makeCard("green", "9"), top, room.game.color), true);
});

test("1.9.0：开始前只补齐未分队的玩家，不会打乱房主已设置的分队", () => {
    const room = createRoom({
        id: "u_teamroom",
        code: "TEAM12",
        mode: "normal",
        host: "Alice",
        hostName: "Alice",
        settings: { teamMode: true }
    });
    room.players.push({ login: "Bob", name: "Bob", uid: 0, bot: false, team: 1, joinedAt: Date.now() });
    room.players.push({ login: "Carol", name: "Carol", uid: 0, bot: false, team: null, joinedAt: Date.now() });
    room.players[0].team = 0;
    assert.equal(startGame(room).ok, true);
    assert.equal(room.players[0].team, 0);
    assert.equal(room.players[1].team, 1);
    assert.equal(room.players[2].team, 0);
});

/* ───────── HTTP 接口 ───────── */

test("1.9.0：UNO 状态开放，暴露模式与牌局能力", async () => {
    const { env } = await prepare();
    const status = await api(env, "GET", "/api/uno/status");
    assert.equal(status.status, 200);
    assert.equal(status.data.version, "1.9.0");
    assert.equal(status.data.enabled, true);
    assert.deepEqual(status.data.modes, ["ai", "normal", "mixed", "match"]);
    assert.equal(status.data.maxPlayers, 10);
    assert.ok(status.data.features.includes("batch-play"));
    assert.ok(status.data.features.includes("reverse-parity"));
});

test("1.9.0：人机对战创建即开局，机器人自动出牌，对手手牌不下发", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "ai", bots: 2 }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const room = created.data.room;
    assert.equal(room.status, "playing");
    assert.equal(room.players.length, 3);
    assert.equal(room.me.hand.length, 7);
    assert.equal(room.game.top.value === "wild", false);
    assert.equal(room.players.find((player) => player.login !== "Alice").hand, null);

    const stored = await env.ACCOUNTS_KV.get(`uno:room:${room.id}`, "json");
    assert.ok(stored.game.hands.Alice.length === 7);
    const forced = { id: "test:card:1", color: stored.game.color, value: "5" };
    stored.game.hands.Alice = [forced, ...stored.game.hands.Alice.slice(0, 4)];
    await env.ACCOUNTS_KV.put(`uno:room:${room.id}`, JSON.stringify(stored));
    const played = await api(env, "POST", `/api/uno/rooms/${room.id}/play`, {
        token: tokens.Alice,
        body: { cards: [forced.id], color: forced.color }
    });
    assert.equal(played.status, 200, JSON.stringify(played.data));
    const after = played.data.room;
    assert.ok(after.status === "playing" || after.status === "finished");
    if (after.status === "playing") {
        assert.equal(after.game.turnLogin, "Alice");
    }
});

test("1.9.0：普通房间、随机匹配与房主开始", async () => {
    const { env, tokens } = await prepare();
    const first = await api(env, "POST", "/api/uno/match", { token: tokens.Alice });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(first.data.created, true);
    assert.equal(first.data.room.status, "waiting");

    const second = await api(env, "POST", "/api/uno/match", { token: tokens.Bob });
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.created, false);
    assert.equal(second.data.room.id, first.data.room.id);
    assert.equal(second.data.room.players.length, 2);

    const rooms = await api(env, "GET", "/api/uno/rooms", { token: tokens.Bob });
    assert.equal(rooms.status, 200);
    assert.equal(rooms.data.mine.length, 1);
    assert.equal(rooms.data.rooms.length, 1);

    const denied = await api(env, "POST", `/api/uno/rooms/${first.data.room.id}/start`, {
        token: tokens.Bob
    });
    assert.equal(denied.status, 403);

    const started = await api(env, "POST", `/api/uno/rooms/${first.data.room.id}/start`, {
        token: tokens.Alice
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.room.status, "playing");
    assert.equal(started.data.room.humans, 2);

    const joinAfterStart = await api(env, "POST", "/api/uno/rooms/join", {
        token: tokens.Carol,
        body: { roomId: first.data.room.id }
    });
    assert.equal(joinAfterStart.status, 409);
    assert.equal(joinAfterStart.data.error, "already_started");
});

test("1.9.0：混合对战需要 2 名真人才能开始", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "mixed", bots: 2 }
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const room = created.data.room;
    assert.equal(room.status, "waiting");
    assert.equal(room.settings.teamMode, true);
    assert.equal(room.bots, 2);
    assert.equal(room.players.find((player) => player.bot).team, 1);

    const early = await api(env, "POST", `/api/uno/rooms/${room.id}/start`, { token: tokens.Alice });
    assert.equal(early.status, 409);
    assert.equal(early.data.error, "need_players");

    const joined = await api(env, "POST", "/api/uno/rooms/join", {
        token: tokens.Bob,
        body: { roomId: room.id }
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
    const started = await api(env, "POST", `/api/uno/rooms/${room.id}/start`, { token: tokens.Alice });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.room.status, "playing");
    assert.equal(started.data.room.players.find((player) => player.login === "Bob").team, 0);
});

test("1.9.0：组队设置、自动分队与队内聊天", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "normal", teamMode: true }
    });
    const room = created.data.room;
    await api(env, "POST", "/api/uno/rooms/join", {
        token: tokens.Bob,
        body: { roomId: room.id }
    });
    await api(env, "POST", "/api/uno/rooms/join", {
        token: tokens.Carol,
        body: { roomId: room.id }
    });

    const teams = await api(env, "POST", `/api/uno/rooms/${room.id}/teams`, {
        token: tokens.Alice,
        body: { teams: [["Alice", "Bob"], ["Carol"]] }
    });
    assert.equal(teams.status, 200, JSON.stringify(teams.data));
    assert.equal(teams.data.room.players.find((player) => player.login === "Bob").team, 0);
    assert.equal(teams.data.room.players.find((player) => player.login === "Carol").team, 1);

    const globalChat = await api(env, "POST", `/api/uno/rooms/${room.id}/chat`, {
        token: tokens.Alice,
        body: { text: "准备开始", scope: "global" }
    });
    assert.equal(globalChat.status, 201, JSON.stringify(globalChat.data));
    const teamChat = await api(env, "POST", `/api/uno/rooms/${room.id}/chat`, {
        token: tokens.Alice,
        body: { text: "队友听得到", scope: "team" }
    });
    assert.equal(teamChat.status, 409);
    assert.equal(teamChat.data.error, "not_started");

    const started = await api(env, "POST", `/api/uno/rooms/${room.id}/start`, { token: tokens.Alice });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const teamChat2 = await api(env, "POST", `/api/uno/rooms/${room.id}/chat`, {
        token: tokens.Alice,
        body: { text: "队友听得到", scope: "team" }
    });
    assert.equal(teamChat2.status, 201, JSON.stringify(teamChat2.data));

    const chatEvents = () => env.CHAT.events.filter((item) => item.payload && item.payload.event && item.payload.event.type === "uno:chat");
    const teamEvent = chatEvents().slice(-1)[0];
    assert.deepEqual(teamEvent.payload.targets.slice().sort(), ["Alice", "Bob"]);

    await api(env, "POST", `/api/uno/rooms/${room.id}/chat`, {
        token: tokens.Alice,
        body: { text: "全局消息", scope: "global" }
    });
    const globalEvent = chatEvents().slice(-1)[0];
    assert.deepEqual(globalEvent.payload.targets.slice().sort(), ["Alice", "Bob", "Carol"]);

    const aliceView = await api(env, "GET", `/api/uno/rooms/${room.id}`, { token: tokens.Alice });
    const carolView = await api(env, "GET", `/api/uno/rooms/${room.id}`, { token: tokens.Carol });
    assert.deepEqual(aliceView.data.room.chats.map((message) => message.text), ["准备开始", "队友听得到", "全局消息"]);
    assert.deepEqual(carolView.data.room.chats.map((message) => message.text), ["准备开始", "全局消息"]);
    assert.equal(aliceView.data.room.players.find((player) => player.login === "Bob").hand.length, 7);
    assert.equal(aliceView.data.room.players.find((player) => player.login === "Carol").hand, null);
});

test("1.9.0：聊天室单聊里发送 UNO 邀请卡片，对方点卡片即可加入", async () => {
    const { env, tokens } = await prepare();
    const conversation = await befriend(env, tokens, "Alice", "Bob");
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "normal", name: "周末开黑" }
    });
    const room = created.data.room;

    const invited = await api(env, "POST", `/api/chat/conversations/${conversation.id}/uno`, {
        token: tokens.Alice,
        body: { roomId: room.id }
    });
    assert.equal(invited.status, 201, JSON.stringify(invited.data));
    assert.equal(invited.data.message.type, "uno");
    assert.equal(invited.data.message.uno.roomId, room.id);
    assert.equal(invited.data.message.uno.name, "周末开黑");
    assert.equal(invited.data.message.uno.status, "waiting");

    const messages = await api(env, "GET", `/api/chat/conversations/${conversation.id}/messages`, {
        token: tokens.Bob
    });
    const card = messages.data.messages.find((message) => message.type === "uno");
    assert.ok(card, "Bob 应该收到 UNO 邀请卡片");
    assert.equal(card.uno.code, room.code);

    const list = await api(env, "GET", "/api/chat/conversations", { token: tokens.Bob });
    const entry = list.data.conversations.find((item) => item.id === conversation.id);
    assert.equal(entry.lastMessage.type, "uno");
    assert.match(entry.lastMessage.text, /UNO/);

    const joined = await api(env, "POST", "/api/uno/rooms/join", {
        token: tokens.Bob,
        body: { code: room.code }
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
    assert.equal(joined.data.room.players.length, 2);
});

test("1.9.0：非房主不能改设置，房间 id / 房间码错误会拒绝", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "normal" }
    });
    const room = created.data.room;
    await api(env, "POST", "/api/uno/rooms/join", { token: tokens.Bob, body: { roomId: room.id } });

    const denied = await api(env, "POST", `/api/uno/rooms/${room.id}/settings`, {
        token: tokens.Bob,
        body: { effectTargeting: false }
    });
    assert.equal(denied.status, 403);

    const allowed = await api(env, "POST", `/api/uno/rooms/${room.id}/settings`, {
        token: tokens.Alice,
        body: { effectTargeting: false, name: "新名字" }
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    assert.equal(allowed.data.room.settings.effectTargeting, false);
    assert.equal(allowed.data.room.name, "新名字");

    const missing = await api(env, "GET", "/api/uno/rooms/u_missing", { token: tokens.Alice });
    assert.equal(missing.status, 404);
    const badCode = await api(env, "POST", "/api/uno/rooms/join", {
        token: tokens.Bob,
        body: { code: "ZZZZZZ" }
    });
    assert.equal(badCode.status, 404);
    const outsider = await api(env, "GET", `/api/uno/rooms/${room.id}`, { token: tokens.Carol });
    assert.equal(outsider.status, 403);
});

test("1.9.0：中途退出视为认输，结算给对手", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "ai", bots: 1 }
    });
    const room = created.data.room;
    const left = await api(env, "POST", `/api/uno/rooms/${room.id}/leave`, { token: tokens.Alice });
    assert.equal(left.status, 200, JSON.stringify(left.data));
    assert.equal(left.data.room.status, "finished");
    assert.ok(left.data.room.game.winners.length >= 1);
    assert.equal(left.data.room.game.winners.includes("Alice"), false);
});

test("1.9.0：两名真人可以完整打完一局（出牌 / 抽牌 / 过牌 / 结算）", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "normal" }
    });
    const roomId = created.data.room.id;
    await api(env, "POST", "/api/uno/rooms/join", { token: tokens.Bob, body: { roomId } });
    const started = await api(env, "POST", `/api/uno/rooms/${roomId}/start`, { token: tokens.Alice });
    assert.equal(started.status, 200, JSON.stringify(started.data));

    let room = started.data.room;
    let finished = false;
    for (let turn = 0; turn < 500 && !finished; turn += 1) {
        const view = await api(env, "GET", `/api/uno/rooms/${roomId}`, { token: tokens[room.game.turnLogin] });
        assert.equal(view.status, 200, JSON.stringify(view.data));
        room = view.data.room;
        if (room.status === "finished") {
            finished = true;
            break;
        }
        const token = tokens[room.game.turnLogin];
        assert.ok(token, `未知的回合玩家 ${room.game.turnLogin}`);
        const me = room.me;
        if (room.game.drewThisTurn) {
            const passed = await api(env, "POST", `/api/uno/rooms/${roomId}/pass`, { token });
            assert.equal(passed.status, 200, JSON.stringify(passed.data));
            room = passed.data.room;
            continue;
        }
        const playable = (me.playable || [])[0];
        if (playable) {
            const card = me.hand.find((item) => item.id === playable);
            const color = card.color === "wild" ? "red" : card.color;
            const played = await api(env, "POST", `/api/uno/rooms/${roomId}/play`, {
                token,
                body: { cards: [playable], color }
            });
            assert.equal(played.status, 200, JSON.stringify(played.data));
            room = played.data.room;
            continue;
        }
        const drawn = await api(env, "POST", `/api/uno/rooms/${roomId}/draw`, { token });
        assert.equal(drawn.status, 200, JSON.stringify(drawn.data));
        room = drawn.data.room;
    }

    assert.equal(room.status, "finished", `牌局应该结束：${JSON.stringify(room.game && room.game.log.slice(-5))}`);
    assert.ok(Array.isArray(room.game.winners) && room.game.winners.length > 0);
});

test("1.9.0：不能替别人出牌 / 不在房间看不到牌局", async () => {
    const { env, tokens } = await prepare();
    const created = await api(env, "POST", "/api/uno/rooms", {
        token: tokens.Alice,
        body: { mode: "normal" }
    });
    const room = created.data.room;
    const detail = await api(env, "GET", `/api/uno/rooms/${room.id}`, { token: tokens.Bob });
    assert.equal(detail.status, 403);
    const play = await api(env, "POST", `/api/uno/rooms/${room.id}/play`, {
        token: tokens.Bob,
        body: { cards: [] }
    });
    assert.equal(play.status, 403);
    const start = await api(env, "POST", `/api/uno/rooms/${room.id}/start`, { token: tokens.Alice });
    assert.equal(start.status, 409);
});
