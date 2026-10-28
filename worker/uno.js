/* Vitual XRing 2.0.1 — 聊天室 UNO
 *
 * 服务端负责全部牌局状态（手牌、牌堆、回合、方向、累计效果、队内可见性），
 * 客户端只负责渲染和提交动作，所以改前端代码没法作弊。
 *
 * 房间存在 ACCOUNTS_KV：
 *   uno:room:<id>  一整局房间（含牌局、聊天、操作记录）
 *   uno:index      等待中 / 进行中房间的索引，供随机匹配和「我的房间」使用
 *
 * 实时推送复用 ChatHub：uno:update / uno:chat 事件只发给房间里的玩家，
 * 客户端收到后重新拉一次 GET /api/uno/rooms/:id。
 */

export const UNO_VERSION = "2.0.1";

export const UNO_MAX_PLAYERS = 10;
export const UNO_MAX_MIXED_PLAYERS = 18;
export const UNO_MIN_PLAYERS = 2;
export const UNO_MAX_HUMANS_MIXED = 9;
export const UNO_MAX_BOTS = 9;
export const UNO_MIN_BOTS = 1;
export const UNO_WAITING_TTL_SECONDS = 24 * 60 * 60;
export const UNO_FINISHED_TTL_SECONDS = 2 * 60 * 60;
export const UNO_INDEX_LIMIT = 200;
export const UNO_INDEX_KEY = "uno:index";
export const UNO_ROOM_KEY_PREFIX = "uno:room:";
export const UNO_ROOM_ID_PATTERN = /^u_[A-Za-z0-9_-]{4,40}$/;
export const UNO_ROOM_CODE_PATTERN = /^[A-Z0-9]{4,8}$/;
export const UNO_CHAT_TEXT_MAX = 300;
export const UNO_CHAT_LIMIT = 120;
export const UNO_LOG_LIMIT = 80;

export const UNO_COLORS = ["red", "yellow", "green", "blue"];
export const UNO_COLOR_LABELS = { red: "红", yellow: "黄", green: "绿", blue: "蓝" };
export const UNO_VALUE_LABELS = {
    skip: "禁止",
    reverse: "反转",
    draw2: "+2",
    wild: "变色",
    wild4: "+4"
};
const UNO_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* ───────────────── 牌与规则 ───────────────── */

export function makeCard(color, value, index) {
    return { id: `${color}:${value}:${index}`, color, value };
}

export function createDeck() {
    const deck = [];
    for (const color of UNO_COLORS) {
        deck.push(makeCard(color, "0", 1));
        for (let number = 1; number <= 9; number += 1) {
            deck.push(makeCard(color, String(number), 1));
            deck.push(makeCard(color, String(number), 2));
        }
        for (const value of ["skip", "reverse", "draw2"]) {
            deck.push(makeCard(color, value, 1));
            deck.push(makeCard(color, value, 2));
        }
    }
    for (let index = 1; index <= 4; index += 1) {
        deck.push(makeCard("wild", "wild", index));
        deck.push(makeCard("wild", "wild4", index));
    }
    return deck;
}

export function shuffleDeck(cards) {
    const list = cards.slice();
    for (let index = list.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        const temp = list[index];
        list[index] = list[swap];
        list[swap] = temp;
    }
    return list;
}

export function isWildCard(card) {
    return Boolean(card) && card.color === "wild";
}

export function cardLabel(card) {
    if (!card) {
        return "";
    }
    if (card.color === "wild") {
        return card.value === "wild4" ? "万能 +4" : "万能变色";
    }
    return `${UNO_COLOR_LABELS[card.color] || ""}${UNO_VALUE_LABELS[card.value] || card.value}`;
}

/* 当前牌面（可能是万能牌，此时 game.color 才是生效颜色）能不能压这张牌 */
export function isPlayableCard(card, top, color) {
    if (!card || !top) {
        return false;
    }
    if (isWildCard(card)) {
        return true;
    }
    if (isWildCard(top)) {
        return card.color === color;
    }
    /* 批量出不同颜色的同数字牌时可以指定最终颜色，所以用 game.color 而不是牌面本身颜色 */
    return card.color === color || card.value === top.value;
}

export function isActionValue(value) {
    return value === "skip" || value === "reverse" || value === "draw2" || value === "wild4";
}

/* ───────────────── 房间 ───────────────── */

export function createPlayer({ login, name, uid, bot = false, team = null }) {
    return {
        login: String(login),
        name: String(name || login),
        uid: Number(uid) || 0,
        bot: Boolean(bot),
        team: team === null || team === undefined ? null : Number(team),
        joinedAt: Date.now()
    };
}

export function createRoom(options) {
    const {
        id,
        code,
        mode,
        host,
        hostName,
        hostUid = 0,
        botCount = 0,
        settings = {}
    } = options;
    const now = Date.now();
    const room = {
        id,
        code,
        mode,
        status: "waiting",
        name: String(options.name || "").trim().slice(0, 24) || defaultRoomName(mode, hostName),
        host,
        hostName,
        settings: {
            teamMode: Boolean(settings.teamMode),
            effectTargeting: settings.effectTargeting !== false,
            maxPlayers: clamp(Number(settings.maxPlayers) || UNO_MAX_PLAYERS, UNO_MIN_PLAYERS, UNO_MAX_PLAYERS)
        },
        players: [createPlayer({ login: host, name: hostName, uid: hostUid, team: mode === "mixed" ? 0 : null })],
        game: null,
        chats: [],
        seq: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: 0,
        finishedAt: 0
    };

    if (mode === "mixed") {
        room.settings.teamMode = true;
        /* 2~9 名真人 vs 1~9 个机器人：房间容量 = 9 名真人 + 已有机器人 */
        room.settings.maxPlayers = Math.min(UNO_MAX_MIXED_PLAYERS, UNO_MAX_HUMANS_MIXED + clamp(Number(botCount) || 0, 0, UNO_MAX_BOTS));
        addBots(room, botCount, 1);
    } else if (mode === "ai") {
        room.settings.teamMode = false;
        addBots(room, botCount, null);
        startGame(room);
    }

    room.seq += 1;
    return room;
}

export function addBots(room, count, team) {
    const wanted = clamp(Number(count) || 0, 0, UNO_MAX_BOTS);
    const existing = room.players.filter((player) => player.bot).length;
    for (let index = existing; index < wanted; index += 1) {
        if (room.players.length >= UNO_MAX_PLAYERS) {
            break;
        }
        room.players.push(createPlayer({
            login: `bot_${room.id.slice(-6)}_${index + 1}`,
            name: `机器人 ${index + 1}`,
            uid: 0,
            bot: true,
            team: team === null ? null : Number(team)
        }));
    }
}

function defaultRoomName(mode, hostName) {
    if (mode === "ai") {
        return `${hostName || "我"} 的人机对战`;
    }
    if (mode === "mixed") {
        return `${hostName || "我"} 的混合对战`;
    }
    return `${hostName || "我"} 的 UNO 房间`;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function newRoomCode() {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
        code += UNO_CODE_ALPHABET[Math.floor(Math.random() * UNO_CODE_ALPHABET.length)];
    }
    return code;
}

/* ───────────────── 开局 ───────────────── */

export function teamMembers(room, team) {
    if (team === null || team === undefined) {
        return [];
    }
    return room.players.filter((player) => player.team === Number(team));
}

export function autoAssignTeams(room) {
    const players = room.players;
    players.forEach((player, index) => {
        player.team = index % 2;
    });
    return Math.min(2, players.length);
}

export function startGame(room) {
    if (room.status !== "waiting") {
        return { error: { code: "already_started", message: "牌局已经开始过了" } };
    }
    const humans = room.players.filter((player) => !player.bot);
    if (room.mode === "mixed") {
        if (humans.length < 2) {
            return { error: { code: "need_players", message: "混合对战至少需要 2 名真人玩家" } };
        }
    } else if (room.players.length < UNO_MIN_PLAYERS) {
        return { error: { code: "need_players", message: "至少需要 2 名玩家才能开始" } };
    }

    if (room.settings.teamMode && room.mode === "normal") {
        const unassigned = room.players.filter((player) => player.team === null);
        if (unassigned.length) {
            const counts = {};
            let slots = 2;
            for (const player of room.players) {
                if (player.team !== null) {
                    counts[player.team] = (counts[player.team] || 0) + 1;
                    slots = Math.max(slots, player.team + 1);
                }
            }
            for (const player of unassigned) {
                let target = 0;
                for (let team = 0; team < slots; team += 1) {
                    if ((counts[team] || 0) < (counts[target] || 0)) {
                        target = team;
                    }
                }
                player.team = target;
                counts[target] = (counts[target] || 0) + 1;
            }
        }
    }

    const deck = shuffleDeck(createDeck());
    const hands = {};
    for (const player of room.players) {
        hands[player.login] = deck.splice(0, 7);
    }

    /* 起手牌固定为数字牌，避免刚开局就触发 +2 / 禁止 / 反转 */
    let startIndex = deck.findIndex((card) => !isWildCard(card) && !isActionValue(card.value));
    if (startIndex < 0) {
        startIndex = 0;
    }
    const startCard = deck.splice(startIndex, 1)[0];
    const now = Date.now();

    room.status = "playing";
    room.startedAt = now;
    room.updatedAt = now;
    room.game = {
        deck,
        discard: [startCard],
        hands,
        color: isWildCard(startCard) ? UNO_COLORS[Math.floor(Math.random() * UNO_COLORS.length)] : startCard.color,
        turnIndex: 0,
        direction: 1,
        effects: {},
        drewThisTurn: false,
        drawCount: 0,
        pendingWild4: null,
        turnNumber: 1,
        winners: [],
        log: [],
        lastAction: null,
        startedAt: now,
        finishedAt: 0
    };
    pushLog(room, "system", `牌局开始，${room.players[0].name} 先出牌`);
    room.seq += 1;
    return { ok: true };
}

/* ───────────────── 回合推进与效果 ───────────────── */

export function skipOf(room, login) {
    const effect = room.game && room.game.effects ? room.game.effects[login] : null;
    return effect && Number(effect.skip) > 0 ? Number(effect.skip) : 0;
}

export function addSkip(room, login, count) {
    if (!room.game || !login || count <= 0) {
        return;
    }
    const effects = room.game.effects;
    if (!effects[login]) {
        effects[login] = { skip: 0 };
    }
    effects[login].skip = (Number(effects[login].skip) || 0) + count;
}

function stepIndex(room, index) {
    const count = room.players.length;
    const direction = room.game.direction >= 0 ? 1 : -1;
    return ((index + direction) % count + count) % count;
}

export function advanceTurn(room, fromIndex) {
    const game = room.game;
    const count = room.players.length;
    if (!count) {
        return;
    }
    let index = Number.isInteger(fromIndex) ? fromIndex : game.turnIndex;
    let guard = 0;
    index = stepIndex(room, index);

    /* 一次只消耗目标的一次「跳过」，保证连续两个轮回不出牌而不是一次跳两轮 */
    while (skipOf(room, room.players[index].login) > 0 && guard < 200) {
        const player = room.players[index];
        room.game.effects[player.login].skip -= 1;
        const remaining = skipOf(room, player.login);
        pushLog(room, "skip", `${player.name} 被跳过${remaining > 0 ? `（还剩 ${remaining} 次）` : ""}`);
        guard += 1;
        const next = stepIndex(room, index);
        if (next === index) {
            break;
        }
        index = next;
    }

    game.turnIndex = index;
    game.drewThisTurn = false;
    game.drawCount = 0;
}

export function nextPlayer(room, fromIndex = null) {
    const index = fromIndex === null || fromIndex === undefined ? room.game.turnIndex : fromIndex;
    return room.players[stepIndex(room, index)];
}

/* 出 +4 / +2 / 禁止 时可选的生效玩家：接下来 1~2 名 + 所有队友 */
export function eligibleEffectTargets(room, login) {
    const game = room.game;
    if (!game) {
        return [];
    }
    const me = room.players.find((player) => player.login === login);
    if (!me) {
        return [];
    }
    const result = [];
    let index = game.turnIndex;
    for (let step = 0; step < 2; step += 1) {
        index = stepIndex(room, index);
        const player = room.players[index];
        if (!player || player.login === login) {
            break;
        }
        if (!result.includes(player.login)) {
            result.push(player.login);
        }
    }
    if (room.settings.teamMode && me.team !== null) {
        for (const player of room.players) {
            if (player.login !== login && player.team === me.team && !result.includes(player.login)) {
                result.push(player.login);
            }
        }
    }
    return result;
}

export function drawForPlayer(room, login, count) {
    const game = room.game;
    const hand = game.hands[login] || (game.hands[login] = []);
    const drawn = [];
    for (let index = 0; index < count; index += 1) {
        if (!game.deck.length) {
            refillDeck(room);
        }
        const card = game.deck.pop();
        if (!card) {
            break;
        }
        hand.push(card);
        drawn.push(card);
    }
    return drawn;
}

function refillDeck(room) {
    const game = room.game;
    if (game.deck.length || game.discard.length <= 1) {
        return;
    }
    const top = game.discard[game.discard.length - 1];
    const rest = game.discard.slice(0, -1);
    game.discard = [top];
    game.deck = shuffleDeck(rest);
    pushLog(room, "system", "牌堆用完了，弃牌堆重新洗回牌堆");
}

function pushLog(room, kind, text) {
    const entry = { at: Date.now(), kind, text: String(text).slice(0, 200) };
    room.game.log.push(entry);
    if (room.game.log.length > UNO_LOG_LIMIT) {
        room.game.log.splice(0, room.game.log.length - UNO_LOG_LIMIT);
    }
    room.game.lastAction = entry;
    return entry;
}

export function finishGame(room, winners, reason) {
    const game = room.game;
    game.pendingWild4 = null;
    game.winners = Array.from(new Set((winners || []).filter(Boolean)));
    game.finishedAt = Date.now();
    game.lastAction = { at: game.finishedAt, kind: "win", text: String(reason || "牌局结束") };
    if (game.lastAction.text) {
        pushLog(room, "win", game.lastAction.text);
    }
    room.status = "finished";
    room.finishedAt = game.finishedAt;
    room.updatedAt = game.finishedAt;
}

/* ───────────────── 出牌 / 抽牌 / 过牌 ───────────────── */

function badRequest(code, message) {
    return { error: { code, message } };
}

export function playCards(room, login, cardIds, options = {}) {
    if (!room || room.status !== "playing" || !room.game) {
        return badRequest("not_playing", "牌局还没开始或已经结束");
    }
    const game = room.game;
    const player = room.players.find((item) => item.login === login);
    if (!player) {
        return badRequest("not_in_room", "你不在这个房间里");
    }
    if (game.pendingWild4) {
        return badRequest("pending_wild4", "等待 +4 目标选择抽 4 张还是 6 张");
    }
    const current = room.players[game.turnIndex];
    if (!current || current.login !== login) {
        return badRequest("not_your_turn", "还没轮到你出牌");
    }
    const hand = game.hands[login] || [];
    const ids = Array.isArray(cardIds)
        ? Array.from(new Set(cardIds.slice(0, 20).map((item) => String(item || "").trim()).filter(Boolean)))
        : [];
    if (!ids.length) {
        return badRequest("no_cards", "请先选择要出的牌");
    }
    if (ids.length > hand.length) {
        return badRequest("bad_cards", "手牌数量不足");
    }
    const cards = [];
    for (const id of ids) {
        const card = hand.find((item) => item.id === id);
        if (!card) {
            return badRequest("card_not_in_hand", "这张牌不在你的手里");
        }
        cards.push(card);
    }
    const value = cards[0].value;
    if (cards.some((card) => card.value !== value)) {
        return badRequest("mixed_batch", "一次只能出相同数字或相同功能的牌");
    }
    const top = game.discard[game.discard.length - 1];
    /* 1.10.1：批量出牌只要求同点数里至少有一张能压住牌堆顶；
       其余同点数牌（包括本回合抽到的）可以一起出，并参与最终颜色选择 */
    if (!cards.some((card) => isPlayableCard(card, top, game.color))) {
        return badRequest("illegal_play", "这一批里至少要有一张能压住当前牌堆顶的牌");
    }

    const wild = isWildCard(cards[0]);
    let color = "";
    if (wild) {
        color = String(options.color || "");
        if (!UNO_COLORS.includes(color)) {
            return badRequest("need_color", "万能牌需要选择一种颜色");
        }
    } else {
        /* 2.0.1：多张不同颜色的同数字牌，最终颜色必须等于最后一张牌的颜色；
           出牌顺序由客户端按玩家点选顺序提交，服务端不再为了“选色”而重排 */
        const lastCard = cards[cards.length - 1];
        const wanted = String(options.color || "");
        if (wanted && wanted !== lastCard.color) {
            return badRequest("bad_color", "最终颜色必须是最后一张牌的颜色");
        }
        color = lastCard.color;
    }

    const effectKind = ["skip", "draw2", "wild4"].includes(value);
    let targets = [];
    if (effectKind) {
        const eligible = eligibleEffectTargets(room, login);
        if (!eligible.length) {
            return badRequest("no_target", "找不到可以生效的玩家");
        }
        if (room.settings.effectTargeting && Array.isArray(options.targets) && options.targets.length) {
            const requested = Array.from(new Set(options.targets.slice(0, 20).map((item) => String(item || "").trim()).filter(Boolean)));
            if (requested.length > 1) {
                return badRequest("bad_target", "生效玩家只能选择一名");
            }
            if (requested.some((target) => !eligible.includes(target))) {
                return badRequest("bad_target", "生效玩家只能选择接下来 1~2 名玩家或自己的队友之一");
            }
            targets = requested;
        } else {
            targets = [eligible[0]];
        }
    }

    const removeIds = new Set(ids);
    game.hands[login] = hand.filter((card) => !removeIds.has(card.id));
    game.discard.push(...cards);
    game.color = color;
    game.turnNumber += 1;

    /* 1.10.2：+4 的抽 4 / 抽 6 由被选中的玩家决定；先记下“缺少指定颜色时自动 +6” */
    const wild4ForcedSix = value === "wild4"
        ? !(game.hands[login] || []).some((card) => card.color === color)
        : false;
    const targetPlayer = value === "wild4" && targets.length
        ? room.players.find((item) => item.login === targets[0])
        : null;

    let text = `${player.name} 出了 ${cards.map(cardLabel).join("、")}`;
    const playedColors = new Set(cards.map((card) => card.color));
    if (wild) {
        text += `，指定${UNO_COLOR_LABELS[color] || ""}色`;
    } else if (playedColors.size > 1) {
        text += `，最后一张为${UNO_COLOR_LABELS[color] || ""}色`;
    }
    if (value === "wild4") {
        text += `，等待 ${targetPlayer ? targetPlayer.name : targets[0]} 选择抽 4 张或 6 张`;
    }
    const playLog = pushLog(room, "play", text);

    if (value === "reverse") {
        if (cards.length % 2 === 1) {
            game.direction = -game.direction;
            pushLog(room, "reverse", "出牌方向反转");
            if (room.players.length === 2) {
                const opponent = room.players[(game.turnIndex + 1) % room.players.length];
                addSkip(room, opponent.login, 1);
                pushLog(room, "skip", `两人对局的反转牌让 ${opponent.name} 少出一次`);
            }
        } else {
            pushLog(room, "reverse", `${cards.length} 张反转牌互相抵消，方向不变`);
        }
    }

    if (value === "skip") {
        for (const target of targets) {
            addSkip(room, target, cards.length);
            const skipTarget = room.players.find((item) => item.login === target);
            pushLog(room, "skip", `${skipTarget ? skipTarget.name : target} 被禁止出牌 ${cards.length} 次`);
        }
    }

    if (value === "draw2") {
        const perTarget = 2 * cards.length;
        for (const target of targets) {
            const drawn = drawForPlayer(room, target, perTarget);
            addSkip(room, target, 1);
            const drawTarget = room.players.find((item) => item.login === target);
            pushLog(room, "draw", `${drawTarget ? drawTarget.name : target} 摸 ${drawn.length} 张牌${cards.length > 1 ? `（${cards.length} 张生效牌 × 2）` : ""}`);
        }
    }

    const remaining = game.hands[login];
    if (value === "wild4") {
        if (!remaining.length) {
            const winners = room.settings.teamMode && player.team !== null
                ? teamMembers(room, player.team).map((item) => item.login)
                : [login];
            const names = room.players
                .filter((item) => winners.includes(item.login))
                .map((item) => item.name)
                .join("、");
            finishGame(room, winners, `${names} 获胜（出完了所有牌）`);
        } else {
            game.pendingWild4 = {
                by: login,
                target: targets[0],
                color,
                count: cards.length,
                forcedSix: wild4ForcedSix,
                at: Date.now()
            };
            pushLog(room, "system", `${targetPlayer ? targetPlayer.name : targets[0]} 需要选择抽 4 张还是 6 张`);
        }
    } else if (!remaining.length) {
        const winners = room.settings.teamMode && player.team !== null
            ? teamMembers(room, player.team).map((item) => item.login)
            : [login];
        const names = room.players
            .filter((item) => winners.includes(item.login))
            .map((item) => item.name)
            .join("、");
        finishGame(room, winners, `${names} 获胜（出完了所有牌）`);
    } else {
        advanceTurn(room, game.turnIndex);
    }

    room.updatedAt = Date.now();
    room.seq += 1;
    return { ok: true, log: playLog, pendingWild4: Boolean(game.pendingWild4) };
}

export function drawForCurrent(room, login) {
    if (!room || room.status !== "playing" || !room.game) {
        return badRequest("not_playing", "牌局还没开始或已经结束");
    }
    const game = room.game;
    const player = room.players.find((item) => item.login === login);
    if (!player || player.bot) {
        return badRequest("not_in_room", "你不在这个房间里");
    }
    if (game.pendingWild4) {
        return badRequest("pending_wild4", "等待 +4 目标选择抽 4 张还是 6 张");
    }
    const current = room.players[game.turnIndex];
    if (!current || current.login !== login) {
        return badRequest("not_your_turn", "还没轮到你");
    }

    /* 1.10.0：一回合可以抽任意多张牌；抽完不自动结束回合，由玩家出牌或过牌 */
    const top = game.discard[game.discard.length - 1];
    const drawn = drawForPlayer(room, login, 1);
    game.drewThisTurn = true;
    if (drawn.length) {
        game.drawCount = (Number(game.drawCount) || 0) + 1;
        pushLog(room, "draw", `${player.name} 抽了 1 张牌`);
    } else {
        pushLog(room, "system", "牌堆已经空了，可以过牌");
    }
    room.updatedAt = Date.now();
    room.seq += 1;
    const playable = drawn.length ? isPlayableCard(drawn[0], top, game.color) : false;
    return {
        ok: true,
        drawn: drawn[0] || null,
        playable,
        drawCount: Number(game.drawCount) || 0
    };
}

export function passTurn(room, login) {
    if (!room || room.status !== "playing" || !room.game) {
        return badRequest("not_playing", "牌局还没开始或已经结束");
    }
    const game = room.game;
    const player = room.players.find((item) => item.login === login);
    if (!player || player.bot) {
        return badRequest("not_in_room", "你不在这个房间里");
    }
    if (game.pendingWild4) {
        return badRequest("pending_wild4", "等待 +4 目标选择抽 4 张还是 6 张");
    }
    const current = room.players[game.turnIndex];
    if (!current || current.login !== login) {
        return badRequest("not_your_turn", "还没轮到你");
    }
    if (!game.drewThisTurn && (game.deck.length > 0 || game.discard.length > 1)) {
        return badRequest("cannot_pass", "只有抽牌之后才能过牌");
    }
    pushLog(room, "pass", `${player.name} 选择过牌`);
    advanceTurn(room, game.turnIndex);
    room.updatedAt = Date.now();
    room.seq += 1;
    return { ok: true };
}

/* 1.10.2：被 +4 选中的玩家自己选择抽 4 张还是 6 张 */
export function resolveWild4(room, login, drawAmount) {
    if (!room || room.status !== "playing" || !room.game) {
        return badRequest("not_playing", "牌局还没开始或已经结束");
    }
    const game = room.game;
    const pending = game.pendingWild4;
    if (!pending) {
        return badRequest("no_pending_wild4", "当前没有等待选择的 +4");
    }
    if (pending.target !== login) {
        return badRequest("not_wild4_target", "只有被 +4 选中的玩家可以选择抽牌数量");
    }
    const choice = Number(drawAmount);
    if (choice !== 4 && choice !== 6) {
        return badRequest("bad_draw_amount", "只能选择抽 4 张或 6 张");
    }
    const targetPlayer = room.players.find((item) => item.login === pending.target);
    if (!targetPlayer) {
        game.pendingWild4 = null;
        return badRequest("not_in_room", "目标玩家已经不在房间里");
    }
    const autoUpgraded = Boolean(pending.forcedSix && choice === 4);
    const perCard = pending.forcedSix ? 6 : choice;
    const drawn = drawForPlayer(room, pending.target, perCard * pending.count);
    addSkip(room, pending.target, 1);
    pushLog(
        room,
        "draw",
        `${targetPlayer.name} 选择抽 ${perCard * pending.count} 张${autoUpgraded ? "（出牌者没有该颜色，+4 自动升级为 +6）" : ""}`
    );
    game.pendingWild4 = null;
    advanceTurn(room, game.turnIndex);
    room.updatedAt = Date.now();
    room.seq += 1;
    return {
        ok: true,
        autoUpgraded,
        wild4Draw: perCard,
        drawAmount: perCard * pending.count,
        drawnCount: drawn.length
    };
}

/* ───────────────── 机器人 ───────────────── */

function botCardScore(card, color) {
    if (isWildCard(card)) {
        return card.value === "wild4" ? 1 : 2;
    }
    if (card.color === color) {
        return isActionValue(card.value) ? 6 : 5;
    }
    return 3;
}

function bestBotColor(hand) {
    const counts = {};
    for (const card of hand) {
        if (isWildCard(card)) {
            continue;
        }
        counts[card.color] = (counts[card.color] || 0) + 1;
    }
    let best = "red";
    let bestCount = -1;
    for (const color of UNO_COLORS) {
        if ((counts[color] || 0) > bestCount) {
            best = color;
            bestCount = counts[color] || 0;
        }
    }
    return best;
}

export function botTakeTurn(room) {
    const game = room.game;
    const bot = room.players[game.turnIndex];
    if (!bot || !bot.bot) {
        return false;
    }
    const hand = game.hands[bot.login] || [];
    const top = game.discard[game.discard.length - 1];
    const playable = hand.filter((card) => isPlayableCard(card, top, game.color));

    if (game.drewThisTurn) {
        const card = playable[0];
        if (card) {
            playCards(room, bot.login, [card.id], { color: isWildCard(card) ? bestBotColor(hand) : card.color });
        } else {
            advanceTurn(room, game.turnIndex);
        }
        return true;
    }

    if (playable.length) {
        const card = playable.slice().sort((left, right) => botCardScore(right, game.color) - botCardScore(left, game.color))[0];
        const result = playCards(room, bot.login, [card.id], {
            color: isWildCard(card) ? bestBotColor(hand) : card.color
        });
        if (result.error) {
            advanceTurn(room, game.turnIndex);
        }
        return true;
    }

    const drawn = drawForPlayer(room, bot.login, 1);
    pushLog(room, "draw", `${bot.name} 抽了 1 张牌`);
    if (drawn.length && isPlayableCard(drawn[0], top, game.color)) {
        const card = drawn[0];
        const result = playCards(room, bot.login, [card.id], {
            color: isWildCard(card) ? bestBotColor(hand) : card.color
        });
        if (result.error) {
            advanceTurn(room, game.turnIndex);
        }
    } else {
        advanceTurn(room, game.turnIndex);
    }
    return true;
}

export function runBotTurns(room) {
    let guard = 0;
    while (room.status === "playing" && room.game && guard < 300) {
        if (room.game.pendingWild4) {
            const pending = room.game.pendingWild4;
            const target = room.players.find((player) => player.login === pending.target);
            if (!target || !target.bot) {
                break;
            }
            const resolved = resolveWild4(room, pending.target, 4);
            guard += 1;
            if (resolved.error) {
                break;
            }
            continue;
        }
        const current = room.players[room.game.turnIndex];
        if (!current || !current.bot) {
            break;
        }
        botTakeTurn(room);
        guard += 1;
    }
    room.updatedAt = Date.now();
    return room;
}

/* ───────────────── 视图（隐藏别人的手牌） ───────────────── */

export function roomView(room, login) {
    if (!room) {
        return null;
    }
    const me = room.players.find((player) => player.login === login) || null;
    const game = room.game;
    const teamMode = Boolean(room.settings.teamMode);
    const visibleHand = (player) => {
        if (!game) {
            return null;
        }
        if (!me) {
            return null;
        }
        if (player.login === login) {
            return game.hands[player.login] || [];
        }
        if (teamMode && me.team !== null && player.team === me.team) {
            return game.hands[player.login] || [];
        }
        return null;
    };

    const players = room.players.map((player) => ({
        login: player.login,
        name: player.name,
        uid: player.uid,
        bot: player.bot,
        team: player.team,
        cards: game ? (game.hands[player.login] || []).length : 0,
        hand: visibleHand(player),
        skip: game ? skipOf(room, player.login) : 0,
        host: player.login === room.host
    }));

    const top = game && game.discard.length ? game.discard[game.discard.length - 1] : null;
    const teammates = me && teamMode && me.team !== null
        ? room.players.filter((player) => player.team === me.team && player.login !== login).map((player) => player.login)
        : [];
    const isMyTurn = Boolean(game && me && room.status === "playing" && room.players[game.turnIndex].login === login);
    const hand = game && me ? (game.hands[login] || []) : [];
    const playable = game && top ? hand.filter((card) => isPlayableCard(card, top, game.color)).map((card) => card.id) : [];
    const effectTargets = isMyTurn && room.settings.effectTargeting ? eligibleEffectTargets(room, login) : [];
    const pending = game && game.pendingWild4 ? game.pendingWild4 : null;
    const nameOf = (targetLogin) => {
        const target = room.players.find((player) => player.login === targetLogin);
        return target ? target.name : targetLogin;
    };

    return {
        id: room.id,
        code: room.code,
        mode: room.mode,
        status: room.status,
        name: room.name,
        host: room.host,
        hostName: room.hostName,
        settings: {
            teamMode,
            effectTargeting: Boolean(room.settings.effectTargeting),
            maxPlayers: Number(room.settings.maxPlayers) || UNO_MAX_PLAYERS
        },
        seq: room.seq,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        startedAt: room.startedAt || 0,
        finishedAt: room.finishedAt || 0,
        humans: room.players.filter((player) => !player.bot).length,
        bots: room.players.filter((player) => player.bot).length,
        players,
        me: me ? {
            login,
            name: me.name,
            team: me.team,
            isHost: room.host === login,
            hand,
            playable,
            effectTargets,
            teammates,
            wild4Choice: pending && pending.target === login ? {
                by: pending.by,
                byName: nameOf(pending.by),
                color: pending.color,
                count: pending.count,
                forcedSix: Boolean(pending.forcedSix),
                options: [4, 6]
            } : null
        } : null,
        game: game ? {
            turnLogin: room.players[game.turnIndex] ? room.players[game.turnIndex].login : "",
            turnName: room.players[game.turnIndex] ? room.players[game.turnIndex].name : "",
            direction: game.direction >= 0 ? 1 : -1,
            color: game.color,
            top,
            topLabel: cardLabel(top),
            deckCount: game.deck.length,
            discardCount: game.discard.length,
            drewThisTurn: Boolean(game.drewThisTurn),
            drawCount: Number(game.drawCount) || 0,
            pendingWild4: pending ? {
                by: pending.by,
                byName: nameOf(pending.by),
                target: pending.target,
                targetName: nameOf(pending.target),
                color: pending.color,
                count: pending.count,
                at: pending.at
            } : null,
            turnNumber: game.turnNumber,
            winners: game.winners,
            winnerNames: room.players.filter((player) => game.winners.includes(player.login)).map((player) => player.name),
            log: game.log.slice(-40),
            lastAction: game.lastAction || null
        } : null,
        chats: room.chats
            .filter((message) => message.scope === "global"
                || (teamMode && me && me.team !== null && message.team === me.team))
            .slice(-60)
    };
}

export function roomSummary(room) {
    return {
        id: room.id,
        code: room.code,
        mode: room.mode,
        status: room.status,
        name: room.name,
        host: room.host,
        hostName: room.hostName,
        humans: room.players.filter((player) => !player.bot).length,
        bots: room.players.filter((player) => player.bot).length,
        capacity: Number(room.settings.maxPlayers) || UNO_MAX_PLAYERS,
        players: room.players.map((player) => player.login),
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
    };
}

/* ───────────────── 服务端接口 ───────────────── */

export function createUno(deps) {
    const {
        jsonResponse,
        requireSession,
        readJsonBody,
        plainObject,
        randomCode,
        hasKv,
        chatEnabled,
        chatGuard,
        loadAccounts,
        notifyChat,
        withStoreLock
    } = deps;

    const ROOM_KEY = (id) => `${UNO_ROOM_KEY_PREFIX}${id}`;

    function guard(env, cors) {
        if (!hasKv(env)) {
            return jsonResponse({
                error: "uno_storage_unavailable",
                message: "UNO 需要绑定 ACCOUNTS_KV"
            }, 503, cors);
        }
        return chatGuard(env, cors);
    }

    function notFound(cors) {
        return jsonResponse({ error: "not_found", message: "房间不存在或已经过期" }, 404, cors);
    }

    function forbidden(cors) {
        return jsonResponse({ error: "forbidden", message: "你不在这个房间里" }, 403, cors);
    }

    function withRoom(env, roomId, login, task, cors) {
        return withStoreLock(async () => {
            const room = await readRoom(env, roomId);
            if (!room) {
                return notFound(cors);
            }
            if (login && !room.players.some((player) => player.login === login)) {
                return forbidden(cors);
            }
            const result = await task(room);
            return result && result.response ? result.response : result;
        });
    }

    async function readRoom(env, roomId) {
        const stored = await env.ACCOUNTS_KV.get(ROOM_KEY(roomId), "json");
        if (!stored || typeof stored !== "object" || stored.id !== roomId) {
            return null;
        }
        if (!Array.isArray(stored.players) || !stored.settings) {
            return null;
        }
        return stored;
    }

    async function saveRoom(env, room) {
        room.updatedAt = Date.now();
        const ttl = room.status === "finished" ? UNO_FINISHED_TTL_SECONDS : UNO_WAITING_TTL_SECONDS;
        await env.ACCOUNTS_KV.put(ROOM_KEY(room.id), JSON.stringify(room), { expirationTtl: ttl });
        await upsertIndex(env, room);
    }

    async function removeRoom(env, room) {
        await env.ACCOUNTS_KV.delete(ROOM_KEY(room.id));
        await removeFromIndex(env, room.id);
    }

    async function readIndex(env) {
        const stored = await env.ACCOUNTS_KV.get(UNO_INDEX_KEY, "json");
        return Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === "string") : [];
    }

    async function saveIndex(env, list) {
        await env.ACCOUNTS_KV.put(UNO_INDEX_KEY, JSON.stringify(list.slice(-UNO_INDEX_LIMIT)));
    }

    function pruneIndex(list) {
        const now = Date.now();
        return list.filter((item) => {
            const updatedAt = Number(item.updatedAt) || 0;
            if (!updatedAt || now - updatedAt > UNO_WAITING_TTL_SECONDS * 1000) {
                return false;
            }
            if (item.status === "finished" && now - updatedAt > 30 * 60 * 1000) {
                return false;
            }
            return true;
        });
    }

    async function upsertIndex(env, room) {
        const list = pruneIndex(await readIndex(env));
        const summary = roomSummary(room);
        const index = list.findIndex((item) => item.id === room.id);
        if (index >= 0) {
            list[index] = summary;
        } else {
            list.push(summary);
        }
        await saveIndex(env, list);
    }

    async function removeFromIndex(env, roomId) {
        const list = await readIndex(env);
        const next = list.filter((item) => item.id !== roomId);
        if (next.length !== list.length) {
            await saveIndex(env, next);
        }
    }

    async function uniqueCode(env) {
        const list = await readIndex(env);
        const used = new Set(list.map((item) => item.code));
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const code = newRoomCode();
            if (!used.has(code)) {
                return code;
            }
        }
        return newRoomCode();
    }

    function roomTargets(room) {
        return room.players.filter((player) => !player.bot).map((player) => player.login);
    }

    async function announce(env, room, event) {
        await notifyChat(env, roomTargets(room), {
            type: event.type || "uno:update",
            room: room.id,
            seq: room.seq,
            ...event
        });
    }

    function sessionLogin(session) {
        return session && session.payload ? String(session.payload.sub || "") : "";
    }

    async function handleStatus(request, env, cors) {
        return jsonResponse({
            ok: true,
            version: UNO_VERSION,
            enabled: Boolean(hasKv(env) && chatEnabled(env)),
            storage: hasKv(env) ? "workers-kv" : "unavailable",
            realtime: env.CHAT && typeof env.CHAT.idFromName === "function" ? "websocket" : "polling",
            minPlayers: UNO_MIN_PLAYERS,
            maxPlayers: UNO_MAX_PLAYERS,
            maxMixedPlayers: UNO_MAX_MIXED_PLAYERS,
            maxBots: UNO_MAX_BOTS,
            modes: ["ai", "normal", "mixed", "match"],
            features: [
                "team-hand-visibility", "batch-play", "effect-targets",
                "stacked-effects", "in-game-chat", "reverse-parity"
            ]
        }, 200, cors);
    }

    async function handleCreate(request, env, cors, login, accounts) {
        const body = plainObject(await readJsonBody(request));
        const mode = String(body.mode || "normal");
        if (!["ai", "normal", "mixed"].includes(mode)) {
            return jsonResponse({ error: "bad_request", message: "mode 只能是 ai / normal / mixed" }, 400, cors);
        }
        const account = accounts[login] || {};
        const name = String(account.username || login);
        const botCount = clamp(Number(body.bots) || 0, 0, UNO_MAX_BOTS);
        if (mode === "ai" && (botCount < UNO_MIN_BOTS || botCount > UNO_MAX_BOTS)) {
            return jsonResponse({ error: "bad_request", message: "人机对战需要 1~9 个机器人" }, 400, cors);
        }
        if (mode === "mixed" && (botCount < UNO_MIN_BOTS || botCount > UNO_MAX_BOTS)) {
            return jsonResponse({ error: "bad_request", message: "混合对战需要 1~9 个机器人" }, 400, cors);
        }
        const roomId = `u_${randomCode(9)}`;
        return await withStoreLock(async () => {
            const code = await uniqueCode(env);
            const room = createRoom({
                id: roomId,
                code,
                mode,
                host: login,
                hostName: name,
                hostUid: Number(account.uid) || 0,
                botCount: mode === "normal" ? 0 : botCount,
                settings: {
                    teamMode: Boolean(body.teamMode),
                    effectTargeting: body.effectTargeting !== false,
                    maxPlayers: body.maxPlayers
                },
                name: body.name
            });
            if (mode === "ai") {
                runBotTurns(room);
            }
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return jsonResponse({ ok: true, room: roomView(room, login) }, 201, cors);
        });
    }

    async function handleRoomsList(request, env, cors, login) {
        const list = pruneIndex(await readIndex(env));
        const rooms = list.filter((item) => item.mode === "normal"
            && item.status === "waiting"
            && item.humans < item.capacity - item.bots);
        const mine = list.filter((item) => Array.isArray(item.players) && item.players.includes(login));
        return jsonResponse({
            ok: true,
            version: UNO_VERSION,
            rooms: rooms.map((item) => ({
                id: item.id,
                code: item.code,
                mode: item.mode,
                status: item.status,
                name: item.name,
                hostName: item.hostName,
                humans: item.humans,
                bots: item.bots,
                capacity: item.capacity,
                createdAt: item.createdAt
            })),
            mine
        }, 200, cors);
    }

    async function handleRoomDetail(request, env, cors, roomId, login) {
        const room = await readRoom(env, roomId);
        if (!room) {
            return notFound(cors);
        }
        if (!room.players.some((player) => player.login === login)) {
            return forbidden(cors);
        }
        return jsonResponse({ ok: true, room: roomView(room, login) }, 200, cors);
    }

    async function findWaitingRoom(env, roomId, code) {
        let targetId = roomId;
        if (!targetId && code) {
            const list = await readIndex(env);
            const entry = list.find((item) => item.code === code);
            targetId = entry ? entry.id : "";
        }
        if (!targetId) {
            return null;
        }
        return await readRoom(env, targetId);
    }

    async function joinRoom(env, room, login, accounts) {
        if (room.status === "finished") {
            return { error: { code: "room_finished", message: "这局已经结束了" } };
        }
        if (room.players.some((player) => player.login === login)) {
            return { room, joined: false };
        }
        if (room.status !== "waiting") {
            return { error: { code: "already_started", message: "牌局已经开始，不能再加入了" } };
        }
        const capacity = Number(room.settings.maxPlayers) || UNO_MAX_PLAYERS;
        if (room.players.length >= capacity) {
            return { error: { code: "room_full", message: "房间已经满了" } };
        }
        const account = accounts[login] || {};
        const team = room.mode === "mixed" ? 0 : null;
        room.players.push(createPlayer({
            login,
            name: String(account.username || login),
            uid: Number(account.uid) || 0,
            team
        }));
        room.seq += 1;
        room.updatedAt = Date.now();
        return { room, joined: true };
    }

    async function handleJoin(request, env, cors, login, accounts) {
        const body = plainObject(await readJsonBody(request));
        const roomId = String(body.roomId || "").trim();
        const code = String(body.code || "").trim().toUpperCase();
        return await withStoreLock(async () => {
            const room = await findWaitingRoom(env, roomId, code);
            if (!room) {
                return notFound(cors);
            }
            const result = await joinRoom(env, room, login, accounts);
            if (result.error) {
                return jsonResponse({ error: result.error.code, message: result.error.message }, 409, cors);
            }
            await saveRoom(env, result.room);
            await announce(env, result.room, { type: "uno:update" });
            return jsonResponse({ ok: true, joined: result.joined, room: roomView(result.room, login) }, 200, cors);
        });
    }

    async function handleMatch(request, env, cors, login, accounts) {
        return await withStoreLock(async () => {
            const list = pruneIndex(await readIndex(env));
            const open = list.filter((item) => item.mode === "normal"
                && item.status === "waiting"
                && item.humans < item.capacity - item.bots);
            let room = null;
            if (open.length) {
                const pick = open[Math.floor(Math.random() * open.length)];
                room = await readRoom(env, pick.id);
            }
            if (room && room.players.some((player) => player.login === login)) {
                return jsonResponse({ ok: true, created: false, room: roomView(room, login) }, 200, cors);
            }
            if (room) {
                const result = await joinRoom(env, room, login, accounts);
                if (!result.error) {
                    await saveRoom(env, result.room);
                    await announce(env, result.room, { type: "uno:update" });
                    return jsonResponse({ ok: true, created: false, room: roomView(result.room, login) }, 200, cors);
                }
            }

            const account = accounts[login] || {};
            room = createRoom({
                id: `u_${randomCode(9)}`,
                code: await uniqueCode(env),
                mode: "normal",
                host: login,
                hostName: String(account.username || login),
                hostUid: Number(account.uid) || 0,
                botCount: 0,
                settings: { effectTargeting: true }
            });
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return jsonResponse({ ok: true, created: true, room: roomView(room, login) }, 201, cors);
        });
    }

    async function handleStart(request, env, cors, roomId, login) {
        return await withRoom(env, roomId, login, async (room) => {
            if (room.host !== login) {
                return { response: jsonResponse({ error: "forbidden", message: "只有房主可以开始牌局" }, 403, cors) };
            }
            const result = startGame(room);
            if (result.error) {
                return { response: jsonResponse({ error: result.error.code, message: result.error.message }, 409, cors) };
            }
            runBotTurns(room);
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:started" });
            return { response: jsonResponse({ ok: true, room: roomView(room, login) }, 200, cors) };
        });
    }

    async function handleSettings(request, env, cors, roomId, login) {
        const body = plainObject(await readJsonBody(request));
        return await withRoom(env, roomId, login, async (room) => {
            if (room.host !== login) {
                return { response: jsonResponse({ error: "forbidden", message: "只有房主可以修改设置" }, 403, cors) };
            }
            if (room.status !== "waiting") {
                return { response: jsonResponse({ error: "already_started", message: "牌局开始后不能修改房间设置" }, 409, cors) };
            }
            if (body.effectTargeting !== undefined) {
                room.settings.effectTargeting = Boolean(body.effectTargeting);
            }
            if (body.teamMode !== undefined && room.mode === "normal") {
                room.settings.teamMode = Boolean(body.teamMode);
                if (!room.settings.teamMode) {
                    room.players.forEach((player) => {
                        player.team = null;
                    });
                }
            }
            if (body.name !== undefined) {
                const name = String(body.name || "").trim().slice(0, 24);
                if (name) {
                    room.name = name;
                }
            }
            room.seq += 1;
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return { response: jsonResponse({ ok: true, room: roomView(room, login) }, 200, cors) };
        });
    }

    async function handleTeams(request, env, cors, roomId, login) {
        const body = plainObject(await readJsonBody(request));
        return await withRoom(env, roomId, login, async (room) => {
            if (room.host !== login) {
                return { response: jsonResponse({ error: "forbidden", message: "只有房主可以分队" }, 403, cors) };
            }
            if (room.status !== "waiting") {
                return { response: jsonResponse({ error: "already_started", message: "牌局开始后不能分队" }, 409, cors) };
            }
            if (room.mode !== "normal") {
                return { response: jsonResponse({ error: "fixed_teams", message: "混合对战固定为真人对机器人，不能手动分队" }, 409, cors) };
            }
            if (!room.settings.teamMode) {
                return { response: jsonResponse({ error: "team_mode_off", message: "请先打开组队模式" }, 409, cors) };
            }
            const players = room.players;
            let teams = Array.isArray(body.teams) ? body.teams.slice(0, 6) : null;
            if (body.auto || !teams) {
                const count = Math.min(2, players.length);
                teams = Array.from({ length: count }, () => []);
                players.forEach((player, index) => {
                    teams[index % count].push(player.login);
                });
            }
            const normalized = teams
                .map((team) => (Array.isArray(team) ? Array.from(new Set(team.slice(0, 20).map(String).filter(Boolean))) : []))
                .filter((team) => team.length);
            if (normalized.length < 2) {
                return { response: jsonResponse({ error: "bad_teams", message: "至少需要两个队伍" }, 400, cors) };
            }
            const members = normalized.flat();
            if (members.length !== players.length || new Set(members).size !== players.length) {
                return { response: jsonResponse({ error: "bad_teams", message: "每名玩家必须恰好分到一个队伍" }, 400, cors) };
            }
            if (members.some((member) => !players.some((player) => player.login === member))) {
                return { response: jsonResponse({ error: "bad_teams", message: "队伍里有不在房间的玩家" }, 400, cors) };
            }
            normalized.forEach((team, teamIndex) => {
                for (const member of team) {
                    const player = players.find((item) => item.login === member);
                    if (player) {
                        player.team = teamIndex;
                    }
                }
            });
            room.seq += 1;
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return { response: jsonResponse({ ok: true, room: roomView(room, login) }, 200, cors) };
        });
    }

    async function handleLeave(request, env, cors, roomId, login) {
        return await withRoom(env, roomId, login, async (room) => {
            const player = room.players.find((item) => item.login === login);
            if (!player) {
                return { response: forbidden(cors) };
            }
            if (room.status === "playing") {
                /* 中途退出视为认输：对手 / 对方队伍获胜 */
                const winners = room.settings.teamMode && player.team !== null
                    ? room.players.filter((item) => item.team !== player.team).map((item) => item.login)
                    : room.players.filter((item) => item.login !== login).map((item) => item.login);
                finishGame(room, winners, `${player.name} 离开了牌局`);
                room.seq += 1;
                await saveRoom(env, room);
                await announce(env, room, { type: "uno:update" });
                return { response: jsonResponse({ ok: true, left: true, room: roomView(room, login) }, 200, cors) };
            }
            room.players = room.players.filter((item) => item.login !== login);
            if (!room.players.some((item) => !item.bot)) {
                await removeRoom(env, room);
                return { response: jsonResponse({ ok: true, left: true, closed: true }, 200, cors) };
            }
            if (room.host === login) {
                const next = room.players.find((item) => !item.bot);
                room.host = next.login;
                room.hostName = next.name;
            }
            room.seq += 1;
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return { response: jsonResponse({ ok: true, left: true, room: roomView(room, login) }, 200, cors) };
        });
    }

    async function handlePlay(request, env, cors, roomId, login) {
        const body = plainObject(await readJsonBody(request));
        return await withRoom(env, roomId, login, async (room) => {
            const result = playCards(room, login, body.cards, {
                color: body.color,
                targets: Array.isArray(body.targets) ? body.targets : []
            });
            if (result.error) {
                return { response: jsonResponse({ error: result.error.code, message: result.error.message }, 409, cors) };
            }
            runBotTurns(room);
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return { response: jsonResponse({
                ok: true,
                pendingWild4: Boolean(result.pendingWild4 && room.game.pendingWild4),
                room: roomView(room, login)
            }, 200, cors) };
        });
    }

    /* 1.10.2：只有被 +4 选中的玩家能调用 */
    async function handleWild4Choice(request, env, cors, roomId, login) {
        const body = plainObject(await readJsonBody(request));
        return await withRoom(env, roomId, login, async (room) => {
            const result = resolveWild4(room, login, body.drawAmount);
            if (result.error) {
                return { response: jsonResponse({ error: result.error.code, message: result.error.message }, 409, cors) };
            }
            runBotTurns(room);
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return { response: jsonResponse({
                ok: true,
                autoUpgraded: Boolean(result.autoUpgraded),
                wild4Draw: Number(result.wild4Draw) || 0,
                drawAmount: Number(result.drawAmount) || 0,
                drawnCount: Number(result.drawnCount) || 0,
                room: roomView(room, login)
            }, 200, cors) };
        });
    }

    async function handleDraw(request, env, cors, roomId, login) {
        return await withRoom(env, roomId, login, async (room) => {
            const result = drawForCurrent(room, login);
            if (result.error) {
                return { response: jsonResponse({ error: result.error.code, message: result.error.message }, 409, cors) };
            }
            runBotTurns(room);
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return { response: jsonResponse({
                ok: true,
                drawn: result.drawn,
                playable: Boolean(result.playable),
                drawCount: Number(result.drawCount) || 0,
                room: roomView(room, login)
            }, 200, cors) };
        });
    }

    async function handlePass(request, env, cors, roomId, login) {
        return await withRoom(env, roomId, login, async (room) => {
            const result = passTurn(room, login);
            if (result.error) {
                return { response: jsonResponse({ error: result.error.code, message: result.error.message }, 409, cors) };
            }
            runBotTurns(room);
            await saveRoom(env, room);
            await announce(env, room, { type: "uno:update" });
            return { response: jsonResponse({ ok: true, room: roomView(room, login) }, 200, cors) };
        });
    }

    async function handleChat(request, env, cors, roomId, login) {
        const body = plainObject(await readJsonBody(request));
        const text = String(body.text || "").trim();
        const scope = body.scope === "team" ? "team" : "global";
        if (!text) {
            return jsonResponse({ error: "bad_request", message: "消息内容不能为空" }, 400, cors);
        }
        if (text.length > UNO_CHAT_TEXT_MAX) {
            return jsonResponse({ error: "text_too_long", message: `局内聊天最多 ${UNO_CHAT_TEXT_MAX} 个字符` }, 413, cors);
        }
        return await withRoom(env, roomId, login, async (room) => {
            const player = room.players.find((item) => item.login === login);
            if (scope === "team" && (!room.settings.teamMode || player.team === null)) {
                return { response: jsonResponse({ error: "team_chat_unavailable", message: "当前房间没有队伍，不能发队内消息" }, 409, cors) };
            }
            if (room.status === "waiting" && scope === "team") {
                return { response: jsonResponse({ error: "not_started", message: "牌局开始后才能发队内消息" }, 409, cors) };
            }
            const message = {
                id: randomCode(6),
                login,
                name: player.name,
                team: player.team,
                scope,
                text,
                at: Date.now()
            };
            room.chats.push(message);
            if (room.chats.length > UNO_CHAT_LIMIT) {
                room.chats.splice(0, room.chats.length - UNO_CHAT_LIMIT);
            }
            room.updatedAt = Date.now();
            room.seq += 1;
            await saveRoom(env, room);
            /* 队内消息只推给同队真人，避免对手在 WebSocket 里直接读到 */
            const targets = scope === "team"
                ? room.players
                    .filter((item) => !item.bot && item.team !== null && item.team === player.team)
                    .map((item) => item.login)
                : roomTargets(room);
            await notifyChat(env, targets, {
                type: "uno:chat",
                room: room.id,
                seq: room.seq,
                message,
                scope
            });
            return { response: jsonResponse({ ok: true, message }, 201, cors) };
        });
    }

    /* 只用于聊天室邀请卡片，不在这里落聊天消息 */
    async function inviteInfo(env, roomId, login) {
        const id = String(roomId || "").trim();
        if (!UNO_ROOM_ID_PATTERN.test(id)) {
            return { error: { code: "bad_request", message: "房间 id 不合法" } };
        }
        const room = await readRoom(env, id);
        if (!room) {
            return { error: { code: "not_found", message: "房间不存在或已经过期" } };
        }
        if (!room.players.some((player) => player.login === login)) {
            return { error: { code: "forbidden", message: "你不在这个房间里" } };
        }
        const summary = roomSummary(room);
        return {
            invite: {
                roomId: room.id,
                code: room.code,
                name: room.name,
                mode: room.mode,
                hostName: room.hostName,
                players: room.players.length,
                capacity: summary.capacity,
                humans: summary.humans,
                bots: summary.bots,
                status: room.status
            }
        };
    }

    async function routeUno(request, env, cors) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (path === "/api/uno/status" && method === "GET") {
            return await handleStatus(request, env, cors);
        }

        const guardResponse = guard(env, cors);
        if (guardResponse) {
            return guardResponse;
        }

        const session = await requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        const login = sessionLogin(session);
        const accounts = await loadAccounts(env);
        if (!accounts[login]) {
            return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
        }

        if (path === "/api/uno/rooms") {
            if (method === "GET") {
                return await handleRoomsList(request, env, cors, login);
            }
            if (method === "POST") {
                return await handleCreate(request, env, cors, login, accounts);
            }
        }

        if (path === "/api/uno/rooms/join" && method === "POST") {
            return await handleJoin(request, env, cors, login, accounts);
        }

        if (path === "/api/uno/match" && method === "POST") {
            return await handleMatch(request, env, cors, login, accounts);
        }

        let match = path.match(/^\/api\/uno\/rooms\/([^/]+)$/);
        if (match && method === "GET") {
            const roomId = decodeURIComponent(match[1]);
            if (!UNO_ROOM_ID_PATTERN.test(roomId)) {
                return notFound(cors);
            }
            return await handleRoomDetail(request, env, cors, roomId, login);
        }

        match = path.match(/^\/api\/uno\/rooms\/([^/]+)\/(start|settings|teams|leave|play|draw|pass|chat|wild4)$/);
        if (match) {
            const roomId = decodeURIComponent(match[1]);
            if (!UNO_ROOM_ID_PATTERN.test(roomId)) {
                return notFound(cors);
            }
            const action = match[2];
            if (action === "start" && method === "POST") {
                return await handleStart(request, env, cors, roomId, login);
            }
            if (action === "settings" && method === "POST") {
                return await handleSettings(request, env, cors, roomId, login);
            }
            if (action === "teams" && method === "POST") {
                return await handleTeams(request, env, cors, roomId, login);
            }
            if (action === "leave" && method === "POST") {
                return await handleLeave(request, env, cors, roomId, login);
            }
            if (action === "play" && method === "POST") {
                return await handlePlay(request, env, cors, roomId, login);
            }
            if (action === "draw" && method === "POST") {
                return await handleDraw(request, env, cors, roomId, login);
            }
            if (action === "pass" && method === "POST") {
                return await handlePass(request, env, cors, roomId, login);
            }
            if (action === "wild4" && method === "POST") {
                return await handleWild4Choice(request, env, cors, roomId, login);
            }
            if (action === "chat" && method === "POST") {
                return await handleChat(request, env, cors, roomId, login);
            }
        }

        return null;
    }

    return { routeUno, inviteInfo, readRoom };
}
