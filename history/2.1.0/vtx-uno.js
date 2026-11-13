/* Vitual XRing 2.1.0 — 聊天室 UNO 前端
 *
 * 只在 chatroom.html 里使用：window.VTXUno.init({ api, toast, ... }) 之后，
 * 聊天室右上角的 UNO 按钮、会话输入框旁的「UNO」按钮和聊天里的邀请卡片都会调用这里。
 *
 * 牌局状态全部来自服务端，勾选多张同点数牌批量出牌，出完再由服务端结算。
 */
(function () {
    "use strict";

    const VERSION = "2.1.0";
    const COLORS = ["red", "yellow", "green", "blue"];
    const COLOR_LABELS = { red: "红", yellow: "黄", green: "绿", blue: "蓝", wild: "万能" };
    const MODE_LABELS = { ai: "人机对战", normal: "普通房间", mixed: "混合对战", match: "随机匹配" };
    const STATUS_LABELS = { waiting: "等待加入", playing: "进行中", finished: "已结束" };

    const S = {
        initialized: false,
        api: null,
        toast: null,
        getConversations: () => [],
        getCurrentConversation: () => null,
        refreshConversations: null,
        root: null,
        body: null,
        dialog: null,
        titleNode: null,
        subNode: null,
        view: "lobby",
        room: null,
        lobby: null,
        selected: new Set(),
        busy: false,
        pollTimer: null,
        refreshTimer: null,
        sideTab: "log",
        chatScope: "global",
        chatDraft: "",
        colorPick: null,
        pendingPlay: null,
        lastColorPlay: null,
        wild4DialogKey: null,
        wild4DialogOpen: false,
        deepLinkUsed: false
    };

    /* ───────────────── 工具 ───────────────── */

    function esc(value) {
        return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[ch]));
    }

    function el(id) {
        return document.getElementById(id);
    }

    function modeLabel(mode) {
        return MODE_LABELS[mode] || "UNO";
    }

    function statusLabel(status) {
        return STATUS_LABELS[status] || status || "";
    }

    function teamLabel(team) {
        if (team === null || team === undefined) {
            return "";
        }
        return `队伍 ${Number(team) + 1}`;
    }

    function teamClass(team) {
        if (team === null || team === undefined) {
            return "";
        }
        return `team${Number(team) % 4}`;
    }

    function glyph(card) {
        if (!card) {
            return "";
        }
        switch (card.value) {
            case "skip": return "⊘";
            case "reverse": return "⇄";
            case "draw2": return "+2";
            case "wild": return "变色";
            case "wild4": return "+4";
            default: return String(card.value);
        }
    }

    function corner(card) {
        if (!card) {
            return "";
        }
        switch (card.value) {
            case "skip": return "禁";
            case "reverse": return "反";
            case "draw2": return "+2";
            case "wild": return "◐";
            case "wild4": return "+4";
            default: return String(card.value);
        }
    }

    function cardName(card) {
        if (!card) {
            return "";
        }
        if (card.color === "wild") {
            return card.value === "wild4" ? "万能 +4" : "万能变色";
        }
        return `${COLOR_LABELS[card.color] || ""}${glyph(card)}`;
    }

    function timeLabel(at) {
        if (!at) {
            return "";
        }
        try {
            return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        } catch (error) {
            return "";
        }
    }

    function report(error) {
        const message = error && error.message ? error.message : "操作失败，请稍后重试";
        if (typeof S.toast === "function") {
            S.toast(message, "error");
        }
    }

    function toast(message, kind) {
        if (typeof S.toast === "function") {
            S.toast(message, kind);
        }
    }

    function copyText(text) {
        const value = String(text || "");
        if (!value) {
            return;
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(value).then(() => toast("已复制"), () => toast(value));
                return;
            }
        } catch (error) {
            /* 忽略 */
        }
        try {
            const input = document.createElement("textarea");
            input.value = value;
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            document.body.removeChild(input);
            toast("已复制");
        } catch (error) {
            toast(value);
        }
    }

    function cardMarkup(card, options = {}) {
        const classes = ["uno-card", card.color];
        if (options.mini) {
            classes.push("mini");
        }
        if (options.selected) {
            classes.push("selected");
        }
        if (options.batchable) {
            classes.push("batchable");
        } else if (options.playable === false) {
            classes.push("unplayable");
        }
        if (options.dim) {
            classes.push("unplayable");
        }
        const inner = `<span class="uno-card-face"></span>
            <span class="uno-card-corner">${esc(corner(card))}</span>
            <span class="uno-card-oval">${esc(glyph(card))}</span>
            <span class="uno-card-corner bottom">${esc(corner(card))}</span>`;
        if (options.static) {
            return `<div class="${classes.join(" ")}">${inner}</div>`;
        }
        const title = options.batchable
            ? `${cardName(card)}（可以和其他同点数牌一起出）`
            : cardName(card);
        return `<button type="button" class="${classes.join(" ")}" data-uno-card="${esc(card.id)}"` +
            ` title="${esc(title)}" aria-pressed="${options.selected ? "true" : "false"}">${inner}</button>`;
    }

    /* ───────────────── 初始化 ───────────────── */

    function init(options = {}) {
        S.api = options.api || S.api;
        if (typeof options.toast === "function") {
            S.toast = options.toast;
        }
        if (typeof options.getConversations === "function") {
            S.getConversations = options.getConversations;
        }
        if (typeof options.getCurrentConversation === "function") {
            S.getCurrentConversation = options.getCurrentConversation;
        }
        if (typeof options.refreshConversations === "function") {
            S.refreshConversations = options.refreshConversations;
        }
        if (S.initialized) {
            return;
        }
        if (typeof document === "undefined" || !document.body) {
            return;
        }
        S.initialized = true;

        const overlay = document.createElement("div");
        overlay.className = "uno-overlay";
        overlay.id = "vtx-uno-overlay";
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="uno-shell">
                <header class="uno-bar">
                    <div class="uno-wordmark">UNO<small>${esc(VERSION)}</small></div>
                    <div class="uno-bar-info">
                        <strong id="vtx-uno-title">UNO</strong>
                        <span id="vtx-uno-sub">和好友来一局</span>
                    </div>
                    <button type="button" class="uno-ghost" data-uno-act="lobby">大厅</button>
                    <button type="button" class="uno-ghost" data-uno-act="refresh">刷新</button>
                    <button type="button" class="uno-ghost uno-close" data-uno-act="close" title="关闭">×</button>
                </header>
                <div class="uno-body" id="vtx-uno-body"></div>
                <div class="uno-dialog" id="vtx-uno-dialog" hidden></div>
            </div>`;
        document.body.appendChild(overlay);
        S.root = overlay;
        S.body = overlay.querySelector("#vtx-uno-body");
        S.dialog = overlay.querySelector("#vtx-uno-dialog");
        S.titleNode = overlay.querySelector("#vtx-uno-title");
        S.subNode = overlay.querySelector("#vtx-uno-sub");

        overlay.addEventListener("click", onClick);
        overlay.addEventListener("change", onChange);
        overlay.addEventListener("input", onInput);
        overlay.addEventListener("keydown", onKeyDown);
    }

    /* ───────────────── 开关与轮询 ───────────────── */

    async function open(options = {}) {
        if (!S.initialized) {
            return;
        }
        S.root.hidden = false;
        const code = String(options.code || "").trim();
        if (code) {
            await enterRoom({ code });
            return;
        }
        if (!S.deepLinkUsed) {
            S.deepLinkUsed = true;
            try {
                const params = new URLSearchParams(location.search || "");
                const linked = params.get("uno");
                if (linked) {
                    await enterRoom({ code: linked.trim().toUpperCase() });
                    return;
                }
            } catch (error) {
                /* 忽略 */
            }
        }
        if (S.room && S.room.me) {
            await refreshRoom();
            return;
        }
        await loadLobby();
    }

    function close() {
        if (!S.initialized) {
            return;
        }
        S.root.hidden = true;
        S.wild4DialogKey = null;
        closeDialog();
        stopPolling();
    }

    function startPolling() {
        stopPolling();
        S.pollTimer = setInterval(() => {
            if (!S.room || S.root.hidden || document.hidden) {
                return;
            }
            refreshRoom().catch(() => {});
        }, 4000);
    }

    function stopPolling() {
        if (S.pollTimer) {
            clearInterval(S.pollTimer);
            S.pollTimer = null;
        }
    }

    async function refreshRoom() {
        if (!S.room || !S.api) {
            return;
        }
        if (S.busy) {
            return;
        }
        try {
            const data = await S.api.uno.room(S.room.id);
            if (data && data.room) {
                applyRoom(data.room, { silent: true });
            }
        } catch (error) {
            if (error && (error.status === 403 || error.status === 404)) {
                S.room = null;
                await loadLobby();
                toast("房间已结束或你不在房间里");
            }
        }
    }

    async function loadLobby() {
        S.view = "lobby";
        S.room = null;
        S.selected.clear();
        updateTurnBadge();
        S.titleNode.textContent = "UNO";
        S.subNode.textContent = "人机对战 / 普通房间 / 混合对战 / 随机匹配";
        renderLoading("正在读取房间列表…");
        try {
            S.lobby = await S.api.uno.rooms();
            renderLobby();
        } catch (error) {
            renderError(error);
        }
        startPolling();
    }

    async function enterRoom(options) {
        S.view = "room";
        renderLoading("正在进入房间…");
        try {
            let data;
            if (options.roomId) {
                try {
                    data = await S.api.uno.room(options.roomId);
                } catch (error) {
                    if (error && (error.status === 403 || error.status === 404)) {
                        data = await S.api.uno.join({ roomId: options.roomId });
                    } else {
                        throw error;
                    }
                }
            } else if (options.code) {
                data = await S.api.uno.join({ code: options.code });
            } else {
                throw new Error("缺少房间信息");
            }
            applyRoom(data.room);
            startPolling();
        } catch (error) {
            toast(error && error.message ? error.message : "进入房间失败");
            await loadLobby();
        }
    }

    function applyRoom(room, options = {}) {
        if (!room) {
            return;
        }
        S.view = "room";
        S.room = room;
        const me = room.me;
        if (!me || (room.status === "finished" && room.game && room.game.winners.length)) {
            S.selected.clear();
        } else {
            for (const id of Array.from(S.selected)) {
                if (!room.me || !room.me.hand || !room.me.hand.some((card) => card.id === id)) {
                    S.selected.delete(id);
                }
            }
        }
        if (room.status !== "playing") {
            S.sideTab = "log";
        }
        if (S.chatScope === "team" && (!room.settings.teamMode || !room.me || room.me.team === null)) {
            S.chatScope = "global";
        }
        render();
        updateTurnBadge();
        maybeOpenWild4Dialog(room);
        if (!options.silent) {
            startPolling();
        }
    }

    /* 1.10.3：被 +4 的玩家自动弹出选择框，避免在长牌桌里找不到按钮 */
    function maybeOpenWild4Dialog(room) {
        const choice = room.me && room.me.wild4Choice;
        const pending = room.game && room.game.pendingWild4;
        if (!choice || !pending) {
            S.wild4DialogKey = null;
            if (S.wild4DialogOpen) {
                S.wild4DialogOpen = false;
                closeDialog();
            }
            return;
        }
        const key = `${room.id}:${pending.at || 0}`;
        if (S.wild4DialogKey === key) {
            return;
        }
        S.wild4DialogKey = key;
        S.wild4DialogOpen = true;
        const count = Number(pending.count) || 1;
        const colorName = COLOR_LABELS[pending.color] || pending.color;
        openDialog(`
            <div class="uno-dialog-card">
                <h3>你被 +4 了</h3>
                <p>${esc(pending.byName)} 指定了 ${esc(colorName)} 色${count > 1 ? `（${count} 张 +4）` : ""}。请选择抽多少张：</p>
                <div class="uno-row uno-wild4-actions">
                    <button type="button" class="uno-btn primary" data-uno-act="wild4-choice" data-amount="4">抽 ${4 * count} 张</button>
                    <button type="button" class="uno-btn" data-uno-act="wild4-choice" data-amount="6">抽 ${6 * count} 张</button>
                </div>
                ${choice.forcedSix ? `<p class="uno-muted">出牌者手里没有这个颜色：选 +4 会自动变成 +6。</p>` : ""}
                <div class="uno-dialog-actions">
                    <button type="button" class="uno-btn ghost" data-uno-act="dialog-cancel">稍后选择</button>
                </div>
            </div>`);
    }

    /* 面板关掉以后，右上角 UNO 按钮上用一个小红点提醒「轮到你了」 */
    function updateTurnBadge() {
        const button = document.getElementById("uno-btn");
        if (!button) {
            return;
        }
        const ready = Boolean(
            S.room
            && S.room.status === "playing"
            && S.room.game
            && S.room.me
            && ((!S.room.game.pendingWild4 && S.room.game.turnLogin === S.room.me.login)
                || S.room.me.wild4Choice)
        );
        button.classList.toggle("turn-ready", ready);
        button.title = ready ? "轮到你了 / 需要选择 +4/+6，打开 UNO" : "打开 UNO（人机对战 / 普通房间 / 混合对战 / 随机匹配）";
    }

    /* ───────────────── 事件转发 ───────────────── */

    function handleEvent(event) {
        if (!event || typeof event.type !== "string" || !event.type.startsWith("uno:")) {
            return;
        }
        if (!S.initialized || !S.room) {
            return;
        }
        if (event.room && event.room !== S.room.id) {
            return;
        }
        if (S.root.hidden && event.type === "uno:chat") {
            return;
        }
        if (event.type === "uno:chat" && event.message) {
            const message = event.message;
            const teamMode = S.room.settings.teamMode;
            const me = S.room.me;
            const visible = message.scope === "global" || (teamMode && me && me.team !== null && message.team === me.team);
            if (visible && !(S.room.chats || []).some((item) => item.id === message.id)) {
                S.room.chats = [...(S.room.chats || []), message].slice(-60);
                if (S.view === "room") {
                    renderSidePanelOnly();
                }
            }
            return;
        }
        clearTimeout(S.refreshTimer);
        S.refreshTimer = setTimeout(() => {
            refreshRoom().catch(() => {});
        }, 180);
    }

    /* ───────────────── 渲染 ───────────────── */

    function renderLoading(message) {
        if (!S.body) {
            return;
        }
        S.body.innerHTML = `<div class="uno-loading">${esc(message || "加载中…")}</div>`;
        setHead("", "");
    }

    function renderError(error) {
        if (!S.body) {
            return;
        }
        S.body.innerHTML = `<div class="uno-loading">${esc((error && error.message) || "加载失败")}<br><br>
            <button type="button" class="uno-btn" data-uno-act="refresh">重试</button></div>`;
    }

    function setHead(title, sub) {
        if (S.titleNode) {
            S.titleNode.textContent = title || "UNO";
        }
        if (S.subNode) {
            S.subNode.textContent = sub || "";
        }
    }

    function render() {
        if (!S.initialized || !S.body) {
            return;
        }
        const active = document.activeElement;
        const activeId = active && active.id ? active.id : "";
        const selectionStart = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
        if (S.view === "room" && S.room) {
            renderRoom();
        } else if (S.lobby) {
            renderLobby();
        }
        if (activeId) {
            const node = el(activeId);
            if (node && typeof node.focus === "function") {
                try {
                    node.focus({ preventScroll: true });
                    if (selectionStart !== null && typeof node.setSelectionRange === "function") {
                        node.setSelectionRange(selectionStart, selectionStart);
                    }
                } catch (error) {
                    /* 忽略 */
                }
            }
        }
    }

    function renderLobby() {
        const lobby = S.lobby || { rooms: [], mine: [] };
        setHead("UNO 大厅", "选一个模式开始；组队时队友的手牌互相可见");
        S.body.innerHTML = `
            <div class="uno-hero">
                <div class="uno-grow">
                    <h2>来一局 UNO</h2>
                    <p>1 人 vs 1~9 人机、创建普通房间邀请好友、2~9 人 vs 1~9 人机混合对战，或者交给随机匹配。
                    支持组队互看手牌、批量出牌、+2/+4/禁止的生效玩家设置、连续生效与反转牌奇偶结算。</p>
                </div>
            </div>
            <div class="uno-grid">
                <article class="uno-panel">
                    <h3>1. 人机对战</h3>
                    <p>1 人 vs 1~9 人机，创建后立刻发牌。</p>
                    <label>机器人数量
                        <select id="uno-ai-bots">${botOptions(3)}</select>
                    </label>
                    <button type="button" class="uno-btn primary" data-uno-act="create-ai">开始对战</button>
                </article>
                <article class="uno-panel">
                    <h3>2. 创建普通房间</h3>
                    <p>邀请好友，或开着房间等随机匹配的人加入。</p>
                    <label><input type="checkbox" id="uno-normal-team"> 开启组队（队友手牌互相可见）</label>
                    <label><input type="checkbox" id="uno-normal-target" checked> 允许设置 +2/+4/禁止的生效玩家</label>
                    <button type="button" class="uno-btn primary" data-uno-act="create-normal">创建房间</button>
                </article>
                <article class="uno-panel">
                    <h3>3. 创建混合对战</h3>
                    <p>2~9 名真人 vs 1~9 人机，真人自动一队、机器人另一队。</p>
                    <label>机器人数量
                        <select id="uno-mixed-bots">${botOptions(3)}</select>
                    </label>
                    <button type="button" class="uno-btn primary" data-uno-act="create-mixed">创建房间</button>
                </article>
                <article class="uno-panel">
                    <h3>4. 随机匹配</h3>
                    <p>有等待中的普通房间就加入；没有就自动创建一间。</p>
                    <button type="button" class="uno-btn primary" data-uno-act="match">随机匹配</button>
                    <div class="uno-row" style="margin-top:4px;">
                        <input type="text" id="uno-join-code" maxlength="8" placeholder="房间码" style="width:96px; text-transform:uppercase;">
                        <button type="button" class="uno-btn small" data-uno-act="join-code">加入</button>
                    </div>
                </article>
            </div>
            ${minePanel(lobby.mine || [])}
            ${openRoomsPanel(lobby.rooms || [])}
            <details class="uno-panel wide uno-rules">
                <summary>规则与扩展功能说明</summary>
                <ul>
                    <li>标准 108 张 UNO 牌；轮到你时可以出与牌堆顶颜色相同或数字/功能相同的牌，万能牌随时出。</li>
                    <li>轮到你时想抽几张就抽几张（抽到牌堆空为止），抽牌不会直接结束回合；出牌或过牌才会结束本回合。</li>
                    <li>批量出牌：先选一张能压住牌堆顶的牌，之后同点数的牌（包括本回合刚抽到的）都可以一起出，并参与最终颜色选择；如果颜色不同，出牌时选择最终生效颜色。</li>
                    <li>出 +2 / +4 / 禁止后，如果房主没关闭该功能，你可以从接下来 1~2 名玩家或自己的队友里指定一名生效玩家。</li>
                    <li>一次出 N 张 +2，被指定的玩家要摸 2N 张；一次出 N 张 +4，由被选中的玩家自己选择摸 4N 或 6N 张；一次出 N 张禁止，被指定的玩家连续 N 个自己的回合都不能出牌。</li>
                    <li>万能 +4 由被选中的玩家选择抽 4 张还是 6 张；如果出牌者转的颜色不在他手里，被选中的玩家选 +4 也会自动升级成 +6。</li>
                    <li>一次出多张反转牌时，实际只按张数取余 2：3 张反转一次，4 张互相抵消。</li>
                    <li>组队模式：队友之间互相看得见手牌，队友出完牌整队获胜；局内聊天可切换全局 / 队内。</li>
                </ul>
            </details>`;
    }

    function botOptions(selected) {
        let html = "";
        for (let index = 1; index <= 9; index += 1) {
            html += `<option value="${index}"${index === Number(selected) ? " selected" : ""}>${index} 个</option>`;
        }
        return html;
    }

    function minePanel(mine) {
        const rows = (mine || []).slice(0, 8);
        if (!rows.length) {
            return `<article class="uno-panel wide"><h3>我的房间</h3><p>还没有正在进行的房间。</p></article>`;
        }
        return `<article class="uno-panel wide">
            <h3>我的房间</h3>
            <div class="uno-player-list">
                ${rows.map((item) => `
                    <div class="uno-player-row">
                        <span class="uno-tag">${esc(modeLabel(item.mode))}</span>
                        <span class="uno-grow">${esc(item.name || "UNO 房间")}</span>
                        <span class="uno-muted">${Number(item.humans) || 0} 真人 · ${Number(item.bots) || 0} 人机 · ${esc(statusLabel(item.status))}</span>
                        <button type="button" class="uno-btn small primary" data-uno-act="resume" data-room="${esc(item.id)}">回到房间</button>
                    </div>`).join("")}
            </div>
        </article>`;
    }

    function openRoomsPanel(rooms) {
        const rows = (rooms || []).slice(0, 10);
        if (!rows.length) {
            return `<article class="uno-panel wide"><h3>等待中的普通房间</h3><p>暂时没有空余房间；点「随机匹配」会自动创建一间。</p></article>`;
        }
        return `<article class="uno-panel wide">
            <h3>等待中的普通房间</h3>
            <div class="uno-player-list">
                ${rows.map((item) => `
                    <div class="uno-player-row">
                        <span class="uno-tag">${esc(item.hostName || "房主")}</span>
                        <span class="uno-grow">${esc(item.name || "UNO 房间")}</span>
                        <span class="uno-muted">${Number(item.humans) || 0}/${Number(item.capacity) || 10} 人</span>
                        <button type="button" class="uno-btn small" data-uno-act="join-room" data-room="${esc(item.id)}">加入</button>
                    </div>`).join("")}
            </div>
        </article>`;
    }

    function renderRoom() {
        const room = S.room;
        if (!room) {
            return;
        }
        if (!room.me) {
            loadLobby().catch(() => {});
            return;
        }
        setHead(room.name || "UNO 房间", `${modeLabel(room.mode)} · ${statusLabel(room.status)} · ${room.humans} 真人${room.bots ? ` · ${room.bots} 人机` : ""}${room.settings.teamMode ? " · 组队" : ""}`);
        S.body.innerHTML = room.status === "waiting" ? waitingRoomHtml(room)
            : (room.status === "playing" ? playingRoomHtml(room) : finishedRoomHtml(room));
        const panel = el("uno-side-panel");
        if (panel) {
            panel.scrollTop = panel.scrollHeight;
        }
    }

    function waitingRoomHtml(room) {
        const me = room.me;
        const host = me && me.isHost;
        const teamMode = Boolean(room.settings.teamMode);
        const canStart = room.mode === "mixed" ? room.humans >= 2 : room.humans >= 2;
        const startHint = canStart ? "" : (room.mode === "mixed" ? "混合对战至少需要 2 名真人玩家" : "至少需要 2 名玩家才能开始");
        const players = room.players.map((player) => {
            const tags = [];
            if (player.login === me.login) {
                tags.push('<span class="uno-tag">你</span>');
            }
            if (player.host) {
                tags.push('<span class="uno-tag host">房主</span>');
            }
            if (player.bot) {
                tags.push('<span class="uno-tag bot">人机</span>');
            }
            const teamSelect = host && teamMode && room.mode === "normal" && !player.bot
                ? `<select data-uno-team-login="${esc(player.login)}" style="height:26px; padding:0 4px; margin-left:auto;">
                        ${teamChoices(room, player)}
                    </select>`
                : "";
            if (teamMode && player.team !== null && !teamSelect) {
                tags.push(`<span class="uno-tag ${teamClass(player.team)}">${esc(teamLabel(player.team))}</span>`);
            }
            return `<div class="uno-player-row">
                <span class="uno-avatar">${esc((player.name || player.login || "?").slice(0, 1))}</span>
                <span class="uno-grow">${esc(player.name || player.login)}${player.bot ? "（人机）" : ""}</span>
                ${tags.join("")}
                ${teamSelect}
            </div>`;
        }).join("");

        const conversations = (S.getConversations() || [])
            .filter((conv) => conv && (conv.type === "direct" || (conv.type === "group" && !conv.public)) && !conv.dissolved)
            .slice(0, 8);
        const inviteRows = conversations.length
            ? conversations.map((conv) => `<div class="uno-player-row">
                    <span class="uno-tag">${conv.type === "direct" ? "单聊" : "群聊"}</span>
                    <span class="uno-grow">${esc(conv.name || conv.id)}</span>
                    <button type="button" class="uno-btn small" data-uno-act="invite" data-conv="${esc(conv.id)}">发送邀请</button>
                </div>`).join("")
            : '<div class="uno-chat-empty">还没有单聊或群聊，先去聊天室发起一个会话吧。</div>';

        return `
            <div class="uno-room-head">
                <div>
                    <h2>${esc(room.name || "UNO 房间")}</h2>
                    <p>${esc(modeLabel(room.mode))} · ${Number(room.humans) || 0} 真人${room.bots ? ` · ${room.bots} 人机` : ""} · ${esc(statusLabel(room.status))}</p>
                </div>
                <button type="button" class="uno-code" data-uno-act="copy-code" title="复制房间码">房间码 ${esc(room.code)}</button>
            </div>
            <div class="uno-wait-grid">
                <section class="uno-panel">
                    <h3>玩家（${room.players.length}/${room.settings.maxPlayers}）</h3>
                    <div class="uno-player-list">${players}</div>
                    ${host && teamMode && room.mode === "normal" ? `
                        <div class="uno-row" style="margin-top:6px;">
                            <button type="button" class="uno-btn small" data-uno-act="auto-teams">自动分两队</button>
                            <button type="button" class="uno-btn small primary" data-uno-act="save-teams">保存分队</button>
                        </div>` : ""}
                    ${teamMode && room.mode === "mixed" ? '<p class="uno-muted">混合对战固定为「真人 vs 人机」，不需要手动分队。</p>' : ""}
                </section>
                <section class="uno-panel">
                    <h3>房间设置</h3>
                    <label><input type="checkbox" data-uno-setting="teamMode" ${teamMode ? "checked" : ""} ${host && room.mode === "normal" ? "" : "disabled"}> 组队模式（队友手牌互相可见）</label>
                    <label><input type="checkbox" data-uno-setting="effectTargeting" ${room.settings.effectTargeting ? "checked" : ""} ${host ? "" : "disabled"}> 允许设置 +2/+4/禁止的生效玩家</label>
                    <p>${room.mode === "mixed" ? "混合对战自动开启组队。" : "只有房主可以修改，牌局开始后锁定。"}</p>
                    <h3 style="margin-top:4px;">邀请好友</h3>
                    <div class="uno-player-list">${inviteRows}</div>
                    <p>也可以把房间码发给好友。聊天框旁边的「UNO」按钮会直接把邀请卡片发到当前会话。</p>
                </section>
            </div>
            <div class="uno-footer-actions">
                <button type="button" class="uno-btn danger" data-uno-act="leave">离开房间</button>
                <span class="uno-grow"></span>
                ${startHint ? `<span class="uno-muted">${esc(startHint)}</span>` : ""}
                <button type="button" class="uno-btn primary" data-uno-act="start" ${host && canStart ? "" : "disabled"}>开始游戏</button>
            </div>`;
    }

    function teamChoices(room, player) {
        let html = "";
        const slots = Math.max(2, Math.min(4, room.players.length));
        for (let index = 0; index < slots; index += 1) {
            html += `<option value="${index}"${player.team === index ? " selected" : ""}>${esc(teamLabel(index))}</option>`;
        }
        return html;
    }

    function opponentsHtml(room) {
        const me = room.me;
        return room.players.filter((player) => player.login !== me.login).map((player) => {
            const isTurn = room.game && room.game.turnLogin === player.login;
            const tags = [];
            if (player.bot) {
                tags.push('<span class="uno-tag bot">人机</span>');
            }
            if (room.settings.teamMode && player.team !== null) {
                tags.push(`<span class="uno-tag ${teamClass(player.team)}">${esc(teamLabel(player.team))}</span>`);
            }
            const mini = Array.isArray(player.hand)
                ? `<div class="uno-mini-hand">${player.hand.slice(0, 14).map((card) => cardMarkup(card, { mini: true, static: true })).join("")}</div>`
                : `<div class="uno-hidden-hand"><span class="uno-hidden-stack"><i></i><i></i><i></i></span><span>${player.cards} 张</span></div>`;
            return `<div class="uno-seat${isTurn ? " is-turn" : ""}">
                <div class="uno-seat-head">
                    <span class="uno-avatar">${esc((player.name || player.login).slice(0, 1))}</span>
                    <strong>${esc(player.name || player.login)}</strong>
                    ${player.host ? '<span class="uno-tag host">房主</span>' : ""}
                </div>
                <div class="uno-seat-meta">
                    ${tags.join("")}
                    <span class="uno-tag">${player.cards} 张</span>
                    ${player.skip ? `<span class="uno-tag">跳过 ×${player.skip}</span>` : ""}
                    ${isTurn ? '<span class="uno-tag host">出牌中</span>' : ""}
                </div>
                ${mini}
            </div>`;
        }).join("");
    }

    function myTurn(room) {
        return Boolean(room.game && room.me && room.status === "playing" && room.game.turnLogin === room.me.login);
    }

    const HAND_COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
    const HAND_VALUE_ORDER = {
        "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
        skip: 10, reverse: 11, draw2: 12, wild: 13, wild4: 14
    };

    function sortedHand(hand) {
        return (hand || []).slice().sort((left, right) => {
            const colorDiff = (HAND_COLOR_ORDER[left.color] ?? 9) - (HAND_COLOR_ORDER[right.color] ?? 9);
            if (colorDiff !== 0) {
                return colorDiff;
            }
            return (HAND_VALUE_ORDER[left.value] ?? 99) - (HAND_VALUE_ORDER[right.value] ?? 99);
        });
    }

    function playingRoomHtml(room) {
        const me = room.me;
        const game = room.game;
        const mine = myTurn(room);
        const selected = S.selected;
        const target = game.turnName || "…";
        const hand = me ? sortedHand(me.hand) : [];
        const playable = new Set(me ? (me.playable || []) : []);
        const pending = game.pendingWild4 || null;
        const canAct = mine && !pending;
        /* 1.10.3：同点数里有一张能出时，其他牌虽然单独出不了，
           但只是“不能单独出”，不是完全不可用；用 batchable 样式区分 */
        const legalValues = new Set(hand.filter((card) => playable.has(card.id)).map((card) => card.value));
        const handHtml = hand.map((card) => {
            const isPlayable = playable.has(card.id);
            const isBatchable = canAct && !isPlayable && legalValues.has(card.value);
            return cardMarkup(card, {
                selected: selected.has(card.id),
                playable: canAct ? isPlayable : undefined,
                batchable: isBatchable
            });
        }).join("") || '<div class="uno-chat-empty">没有手牌</div>';
        const drew = Boolean(game.drewThisTurn);
        const drawCount = Number(game.drawCount) || 0;
        const wild4Choice = me && me.wild4Choice ? me.wild4Choice : null;
        const pendingCount = pending ? Number(pending.count) || 1 : 0;
        const canDrawAny = Number(game.deckCount) > 0 || Number(game.discardCount) > 1;
        const canDraw = mine && canDrawAny && !pending;
        const canPass = mine && (drew || !canDrawAny) && !pending;
        const drawLabel = pending
            ? "等待 +4 选择"
            : (mine
                ? (drawCount > 0 ? `本回合已抽 ${drawCount} 张` : (canDrawAny ? "点这里抽牌（可多次）" : "没有牌可抽，可以过牌"))
                : "等待对手");
        const selectedCards = hand.filter((card) => selected.has(card.id));
        const selectedHasLegal = selectedCards.some((card) => playable.has(card.id));
        const canPlay = mine && !pending && selectedCards.length > 0 && selectedHasLegal
            && new Set(selectedCards.map((card) => card.value)).size === 1;
        const chat = chatsHtml(room);
        return `
            <div class="uno-game">
                <div class="uno-table-main">
                    <div class="uno-opponents">${opponentsHtml(room)}</div>
                    <div class="uno-center">
                        <div class="uno-draw-pile">
                            <button type="button" class="uno-draw-btn" data-uno-act="draw" ${canDraw ? "" : "disabled"}>牌堆<br>${game.deckCount}</button>
                            <span class="uno-pile-label">${drawLabel}</span>
                        </div>
                        <div class="uno-discard-pile">${game.top ? cardMarkup(game.top, { static: true }) : ""}</div>
                        <div class="uno-table-info">
                            <span class="uno-color-chip"><span class="uno-color-dot ${esc(game.color)}"></span>生效颜色：${esc(COLOR_LABELS[game.color] || game.color)}</span>
                            <span class="uno-muted">方向：${game.direction > 0 ? "顺时针 →" : "逆时针 ←"}</span>
                            <span class="uno-muted">弃牌堆：${game.discardCount} 张</span>
                            <span class="uno-muted">第 ${game.turnNumber} 手</span>
                        </div>
                    </div>
                    <div class="uno-turn-banner${mine && !pending ? " my-turn" : ""}">
                        ${pending
                            ? (wild4Choice
                                ? "<strong>你被 +4 选中了</strong>：先选择抽 4 张还是 6 张。"
                                : `等待 <strong>${esc(pending.targetName)}</strong> 选择 +4/+6…`)
                            : (mine ? "<strong>轮到你了</strong>：可以连续抽牌；出同色或同数字的牌，抽牌后也可以过牌。" : `等待 <strong>${esc(target)}</strong> 出牌…`)}
                        ${game.lastAction ? `<span class="uno-grow"></span><span class="uno-muted">${esc(game.lastAction.text)}</span>` : ""}
                    </div>
                    ${pending ? `
                        <div class="uno-wild4-prompt${wild4Choice ? " for-me" : ""}">
                            ${wild4Choice ? `
                                <div class="uno-wild4-head"><strong>你被 +4 了</strong></div>
                                <p>${esc(pending.byName)} 指定了 ${esc(COLOR_LABELS[pending.color] || pending.color)} 色；${pendingCount > 1 ? `${pendingCount} 张 +4，` : ""}请选择抽多少张。</p>
                                <div class="uno-row">
                                    <button type="button" class="uno-btn primary" data-uno-act="wild4-choice" data-amount="4">抽 ${4 * pendingCount} 张</button>
                                    <button type="button" class="uno-btn" data-uno-act="wild4-choice" data-amount="6">抽 ${6 * pendingCount} 张</button>
                                </div>
                                ${wild4Choice.forcedSix ? `<span class="uno-muted">出牌者手里没有这个颜色：选 +4 会自动变成 +6。</span>` : ""}
                            ` : `<strong>等待 ${esc(pending.targetName)} 选择 +4/+6…</strong>`}
                        </div>` : ""}
                    <div class="uno-my-area">
                        <div class="uno-hand-head">
                            <span>我的手牌（${hand.length}）</span>
                            ${me && room.settings.teamMode && me.team !== null ? `<span class="uno-tag ${teamClass(me.team)}">${esc(teamLabel(me.team))}</span>` : ""}
                            ${me && me.skip ? `<span class="uno-skip-flag">你被禁止出牌 ${me.skip} 次</span>` : ""}
                        </div>
                        <div class="uno-hand">${handHtml}</div>
                        <div class="uno-hand-actions">
                            <button type="button" class="uno-btn primary" data-uno-act="play" ${canPlay ? "" : "disabled"}>出牌${selectedCards.length ? `（${selectedCards.length} 张）` : ""}</button>
                            <button type="button" class="uno-btn" data-uno-act="clear" ${selectedCards.length ? "" : "disabled"}>取消选择</button>
                            <button type="button" class="uno-btn" data-uno-act="draw" ${canDraw ? "" : "disabled"}>抽牌</button>
                            <button type="button" class="uno-btn" data-uno-act="pass" ${canPass ? "" : "disabled"}>过牌</button>
                            <span class="uno-grow"></span>
                            <button type="button" class="uno-btn danger" data-uno-act="leave">认输 / 离开</button>
                        </div>
                    </div>
                </div>
                <aside class="uno-side">
                    <div class="uno-tabs">
                        <button type="button" class="uno-tab${S.sideTab === "log" ? " active" : ""}" data-uno-act="side-tab" data-tab="log">对局记录</button>
                        <button type="button" class="uno-tab${S.sideTab === "chat" ? " active" : ""}" data-uno-act="side-tab" data-tab="chat">局内聊天</button>
                    </div>
                    <div class="uno-scroll-panel" id="uno-side-panel">
                        ${S.sideTab === "chat" ? chat : logHtml(game)}
                    </div>
                    ${S.sideTab === "chat" ? chatForm(room) : ""}
                </aside>
            </div>`;
    }

    function logHtml(game) {
        const log = (game.log || []).slice(-30);
        if (!log.length) {
            return '<div class="uno-chat-empty">还没有操作记录。</div>';
        }
        return log.map((entry) => `<div class="uno-log-line ${esc(entry.kind || "")}">
            <span class="uno-log-time">${esc(timeLabel(entry.at))}</span>${esc(entry.text)}
        </div>`).join("");
    }

    function chatsHtml(room) {
        const chats = room.chats || [];
        if (!chats.length) {
            return '<div class="uno-chat-empty">还没有局内聊天。全局消息所有人都能看到，队内消息只有队友能看到。</div>';
        }
        return `<div class="uno-chat-list">${chats.slice(-40).map((message) => `
            <div class="uno-chat-line${message.scope === "team" ? " team" : ""}">
                <strong>${esc(message.name || message.login)}${message.scope === "team" ? "（队内）" : ""}</strong>
                <span>${esc(message.text)}</span>
            </div>`).join("")}</div>`;
    }

    function chatForm(room) {
        const teamAvailable = room.settings.teamMode && room.me && room.me.team !== null;
        return `<div class="uno-tabs" style="margin-top:8px;">
                <button type="button" class="uno-tab${S.chatScope === "global" ? " active" : ""}" data-uno-act="chat-scope" data-scope="global">全局</button>
                ${teamAvailable ? `<button type="button" class="uno-tab${S.chatScope === "team" ? " active" : ""}" data-uno-act="chat-scope" data-scope="team">队内</button>` : ""}
            </div>
            <div class="uno-chat-form">
                <input id="uno-chat-input" type="text" maxlength="300" placeholder="${S.chatScope === "team" ? "只有队友能看到…" : "所有人都能看到…"}" value="${esc(S.chatDraft)}" autocomplete="off">
                <button type="button" class="uno-btn small primary" data-uno-act="chat-send">发送</button>
            </div>`;
    }

    function finishedRoomHtml(room) {
        const game = room.game || {};
        const winners = (game.winnerNames && game.winnerNames.length) ? game.winnerNames : (game.winners || []);
        const isWinner = room.me && (game.winners || []).includes(room.me.login);
        return `
            <div class="uno-room-head">
                <div>
                    <h2>${esc(room.name || "UNO 房间")}</h2>
                    <p>${esc(modeLabel(room.mode))} · ${esc(statusLabel(room.status))}</p>
                </div>
            </div>
            <div class="uno-result">
                <h3>${isWinner ? "你们赢了！" : "这局结束"}</h3>
                <p>${winners.length ? `获胜：${esc(winners.join("、"))}` : "没有获胜者"}</p>
                <span class="uno-grow"></span>
                <button type="button" class="uno-btn" data-uno-act="leave-result">离开房间</button>
                <button type="button" class="uno-btn primary" data-uno-act="lobby">回到大厅</button>
            </div>
            <div class="uno-grid" style="margin-top:12px;">
                <section class="uno-panel wide">
                    <h3>最终手牌</h3>
                    <div class="uno-player-list">
                        ${room.players.map((player) => `<div class="uno-player-row">
                            <span class="uno-avatar">${esc((player.name || player.login).slice(0, 1))}</span>
                            <span class="uno-grow">${esc(player.name || player.login)}</span>
                            ${room.settings.teamMode && player.team !== null ? `<span class="uno-tag ${teamClass(player.team)}">${esc(teamLabel(player.team))}</span>` : ""}
                            <span class="uno-tag">${player.cards} 张</span>
                        </div>`).join("")}
                    </div>
                </section>
                <section class="uno-panel wide">
                    <h3>对局记录</h3>
                    <div class="uno-scroll-panel" style="max-height:260px;">${logHtml(game)}</div>
                </section>
            </div>`;
    }

    function renderSidePanelOnly() {
        const panel = el("uno-side-panel");
        if (!panel) {
            render();
            return;
        }
        if (S.sideTab === "chat" && S.room) {
            panel.innerHTML = chatsHtml(S.room);
            panel.scrollTop = panel.scrollHeight;
        }
    }

    /* ───────────────── 点击事件 ───────────────── */

    async function onClick(event) {
        const cardNode = event.target.closest("[data-uno-card]");
        if (cardNode) {
            event.preventDefault();
            toggleCard(cardNode.dataset.unoCard);
            return;
        }
        const button = event.target.closest("[data-uno-act]");
        if (!button) {
            return;
        }
        const act = button.dataset.unoAct;
        if (S.busy && !["close", "lobby"].includes(act)) {
            return;
        }

        try {
            if (act === "close") {
                close();
                return;
            }
            if (act === "lobby") {
                await loadLobby();
                return;
            }
            if (act === "refresh") {
                if (S.view === "room" && S.room) {
                    await refreshRoom();
                } else if (S.lobby) {
                    S.lobby = await S.api.uno.rooms();
                    renderLobby();
                } else {
                    await loadLobby();
                }
                return;
            }
            if (act === "create-ai") {
                const bots = Number((el("uno-ai-bots") || {}).value) || 3;
                await createRoom({ mode: "ai", bots });
                return;
            }
            if (act === "create-normal") {
                const teamMode = Boolean((el("uno-normal-team") || {}).checked);
                const effectTargeting = Boolean((el("uno-normal-target") || {}).checked);
                await createRoom({ mode: "normal", teamMode, effectTargeting });
                return;
            }
            if (act === "create-mixed") {
                const bots = Number((el("uno-mixed-bots") || {}).value) || 3;
                await createRoom({ mode: "mixed", bots });
                return;
            }
            if (act === "match") {
                S.busy = true;
                try {
                    const data = await S.api.uno.match();
                    applyRoom(data.room);
                    toast(data.created ? "没有空房间，已为你创建一间普通房间" : "已加入等待中的房间");
                } finally {
                    S.busy = false;
                }
                return;
            }
            if (act === "join-code") {
                const input = el("uno-join-code");
                const code = String(input && input.value || "").trim().toUpperCase();
                if (!code) {
                    toast("请输入房间码");
                    return;
                }
                await enterRoom({ code });
                return;
            }
            if (act === "resume" || act === "join-room") {
                const roomId = button.dataset.room;
                if (roomId) {
                    await enterRoom({ roomId });
                }
                return;
            }
            if (act === "copy-code") {
                if (S.room) {
                    copyText(S.room.code);
                }
                return;
            }
            if (act === "start") {
                S.busy = true;
                try {
                    const data = await S.api.uno.start(S.room.id);
                    applyRoom(data.room);
                    toast("牌局开始");
                } finally {
                    S.busy = false;
                }
                return;
            }
            if (act === "leave") {
                await leaveRoom();
                return;
            }
            if (act === "leave-result") {
                await leaveRoom();
                return;
            }
            if (act === "auto-teams") {
                const data = await S.api.uno.teams(S.room.id, { auto: true });
                applyRoom(data.room);
                toast("已自动分两队");
                return;
            }
            if (act === "save-teams") {
                await saveTeams();
                return;
            }
            if (act === "invite") {
                const conversationId = button.dataset.conv;
                if (conversationId) {
                    await inviteToConversation(conversationId);
                }
                return;
            }
            if (act === "side-tab") {
                S.sideTab = button.dataset.tab === "chat" ? "chat" : "log";
                render();
                return;
            }
            if (act === "chat-scope") {
                S.chatScope = button.dataset.scope === "team" ? "team" : "global";
                render();
                return;
            }
            if (act === "chat-send") {
                await sendChat();
                return;
            }
            if (act === "draw") {
                await drawCard();
                return;
            }
            if (act === "pass") {
                await passTurn();
                return;
            }
            if (act === "clear") {
                S.selected.clear();
                render();
                return;
            }
            if (act === "play") {
                await playSelected();
                return;
            }
            if (act === "pick-color") {
                const color = button.dataset.color;
                const callback = S.colorPick;
                closeDialog();
                S.colorPick = null;
                if (callback && COLORS.includes(color)) {
                    await callback(color);
                }
                return;
            }
            if (act === "wild4-choice") {
                const amount = Number(button.dataset.amount) === 6 ? 6 : 4;
                await chooseWild4(amount);
                return;
            }
            if (act === "confirm-targets") {
                await confirmTargets();
                return;
            }
            if (act === "confirm-last-color") {
                const pending = S.lastColorPlay;
                S.lastColorPlay = null;
                closeDialog();
                if (pending) {
                    await afterColor(pending.cards, pending.color);
                }
                return;
            }
            if (act === "dialog-cancel") {
                closeDialog();
                S.pendingPlay = null;
                S.lastColorPlay = null;
                return;
            }
        } catch (error) {
            report(error);
        }
    }

    function onChange(event) {
        const setting = event.target.closest("[data-uno-setting]");
        if (setting && S.room) {
            const key = setting.dataset.unoSetting;
            const value = Boolean(setting.checked);
            S.busy = true;
            S.api.uno.settings(S.room.id, { [key]: value }).then((data) => {
                applyRoom(data.room);
                toast(value ? "已开启" : "已关闭");
            }).catch((error) => {
                report(error);
                render();
            }).finally(() => {
                S.busy = false;
            });
        }
    }

    function onInput(event) {
        if (event.target && event.target.id === "uno-chat-input") {
            S.chatDraft = event.target.value;
        }
    }

    function onKeyDown(event) {
        if (!event || event.key !== "Enter") {
            return;
        }
        if (event.target && event.target.id === "uno-chat-input") {
            event.preventDefault();
            sendChat().catch((error) => report(error));
        }
    }

    /* ───────────────── 房间操作 ───────────────── */

    async function createRoom(payload) {
        S.busy = true;
        renderLoading("正在创建房间…");
        try {
            const data = await S.api.uno.create(payload);
            applyRoom(data.room);
            toast(payload.mode === "ai" ? "人机对战开始" : "房间已创建，等好友加入或开始游戏");
        } catch (error) {
            report(error);
            await loadLobby();
        } finally {
            S.busy = false;
        }
    }

    async function leaveRoom() {
        if (!S.room) {
            return;
        }
        const live = S.room.status === "playing";
        if (live && typeof confirm === "function" && !confirm("牌局还没结束，现在离开会判负，确定吗？")) {
            return;
        }
        S.busy = true;
        try {
            await S.api.uno.leave(S.room.id);
        } catch (error) {
            report(error);
        } finally {
            S.busy = false;
            S.room = null;
            S.selected.clear();
            await loadLobby();
            toast(live ? "已离开牌局，判定为认输" : "已离开房间");
        }
    }

    async function saveTeams() {
        if (!S.room) {
            return;
        }
        const selects = Array.from(document.querySelectorAll("[data-uno-team-login]"));
        if (!selects.length) {
            toast("当前没有可分配队伍的玩家");
            return;
        }
        const buckets = new Map();
        for (const select of selects) {
            const login = select.dataset.unoTeamLogin;
            const team = Number(select.value) || 0;
            if (!buckets.has(team)) {
                buckets.set(team, []);
            }
            buckets.get(team).push(login);
        }
        const teams = Array.from(buckets.entries()).sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
        if (teams.filter((team) => team.length).length < 2) {
            toast("至少需要两个队伍");
            return;
        }
        const data = await S.api.uno.teams(S.room.id, { teams });
        applyRoom(data.room);
        toast("分队已保存");
    }

    async function inviteToConversation(conversationId) {
        if (!S.api) {
            return;
        }
        let room = S.room && S.room.status === "waiting" ? S.room : null;
        if (!room) {
            const created = await S.api.uno.create({ mode: "normal" });
            room = created.room;
            applyRoom(room);
        }
        await S.api.uno.invite(conversationId, room.id);
        toast("UNO 邀请卡片已发送，好友点卡片就能加入");
        if (typeof S.refreshConversations === "function") {
            S.refreshConversations(true);
        }
    }

    async function inviteToCurrent() {
        const conv = S.getCurrentConversation && S.getCurrentConversation();
        if (!conv || !conv.id) {
            toast("先打开一个单聊或群聊");
            return;
        }
        S.root.hidden = false;
        try {
            await inviteToConversation(conv.id);
        } catch (error) {
            report(error);
        }
    }

    /* ───────────────── 出牌 ───────────────── */

    function toggleCard(cardId) {
        if (!S.room || !S.room.me || S.room.status !== "playing") {
            return;
        }
        if (!myTurn(S.room)) {
            toast("还没轮到你出牌");
            return;
        }
        const card = (S.room.me.hand || []).find((item) => item.id === cardId);
        if (!card) {
            return;
        }
        if (S.room.game && S.room.game.pendingWild4) {
            toast("等待 +4 选择抽牌数量");
            return;
        }
        if (S.selected.has(cardId)) {
            S.selected.delete(cardId);
            render();
            return;
        }
        const playableIds = new Set(S.room.me.playable || []);
        let chosen = (S.room.me.hand || []).filter((item) => S.selected.has(item.id));
        if (chosen.length && chosen[0].value !== card.value) {
            S.selected.clear();
            chosen = [];
        }
        /* 1.10.2：第一张可以是压不住的牌，只要手里有同点数且能压住牌堆顶的牌；
           这样红 8 + 绿 8、黄 4 + 绿 4 可以先点任意一张再转色 */
        const hasLegalSameValue = (S.room.me.hand || [])
            .some((item) => item.value === card.value && playableIds.has(item.id));
        if (!playableIds.has(cardId) && !hasLegalSameValue) {
            toast(`${cardName(card)} 压不住牌堆顶，手里也没有同点数且能出的牌`);
            return;
        }
        S.selected.add(cardId);
        render();
    }

    function selectedCards() {
        if (!S.room || !S.room.me) {
            return [];
        }
        return (S.room.me.hand || []).filter((card) => S.selected.has(card.id));
    }

    /* 2.0.1：按玩家点选顺序出牌，最后点的那张决定最终颜色 */
    function selectedCardsInPlayOrder() {
        if (!S.room || !S.room.me) {
            return [];
        }
        const hand = S.room.me.hand || [];
        return Array.from(S.selected)
            .map((id) => hand.find((card) => card.id === id))
            .filter(Boolean);
    }

    async function playSelected() {
        if (!S.room || !myTurn(S.room)) {
            toast("还没轮到你出牌");
            return;
        }
        if (S.room.game && S.room.game.pendingWild4) {
            toast("等待 +4 选择抽牌数量");
            return;
        }
        const cards = selectedCardsInPlayOrder();
        if (!cards.length) {
            toast("先选择要出的牌");
            return;
        }
        if (new Set(cards.map((card) => card.value)).size > 1) {
            toast("一次只能出相同数字或相同功能的牌");
            return;
        }
        if (!cards.some((card) => (S.room.me.playable || []).includes(card.id))) {
            toast("这一批里至少要有一张能压住牌堆顶的牌");
            return;
        }
        const wild = cards[0].color === "wild";
        if (wild) {
            openColorDialog(COLORS.slice(), async (color) => {
                await afterColor(cards, color);
            });
            return;
        }
        const colors = Array.from(new Set(cards.map((card) => card.color)));
        if (colors.length > 1) {
            openLastColorDialog(cards, cards[cards.length - 1].color);
            return;
        }
        await afterColor(cards, cards[cards.length - 1].color);
    }

    async function afterColor(cards, color) {
        await afterPenalty(cards, color);
    }

    async function afterPenalty(cards, color) {
        const value = cards[0].value;
        const targets = (S.room && S.room.me && S.room.me.effectTargets) || [];
        const needsTarget = Boolean(S.room.settings.effectTargeting)
            && ["skip", "draw2", "wild4"].includes(value)
            && targets.length > 1;
        if (needsTarget) {
            openTargetDialog(cards, color, targets);
            return;
        }
        await submitPlay(cards, color, []);
    }

    async function submitPlay(cards, color, targets) {
        if (!S.room) {
            return;
        }
        S.busy = true;
        try {
            const data = await S.api.uno.play(S.room.id, {
                cards: cards.map((card) => card.id),
                color,
                targets
            });
            S.selected.clear();
            applyRoom(data.room);
            if (data.pendingWild4) {
                toast("已出 +4，等待对方选择抽 4 张还是 6 张");
            }
        } catch (error) {
            report(error);
        } finally {
            S.busy = false;
        }
    }

    /* 1.10.2：被 +4 选中的玩家自己选择抽 4 张还是 6 张 */
    async function chooseWild4(amount) {
        if (!S.room || S.busy) {
            return;
        }
        closeDialog();
        S.busy = true;
        try {
            const data = await S.api.uno.wild4(S.room.id, amount);
            applyRoom(data.room);
            if (data.autoUpgraded) {
                toast("出牌者没有该颜色，+4 已自动变成 +6");
            } else {
                toast(`你选择抽 ${data.drawAmount || amount} 张`);
            }
        } catch (error) {
            report(error);
        } finally {
            S.busy = false;
        }
    }

    /* 2.0.1：不同颜色的同数字牌，最终颜色只能是最后一张牌的颜色 */
    function openLastColorDialog(cards, color) {
        S.lastColorPlay = { cards, color };
        const colorName = COLOR_LABELS[color] || color;
        const order = cards.map((card) => cardName(card)).join(" → ");
        const last = cards[cards.length - 1];
        openDialog(`
            <div class="uno-dialog-card">
                <h3>最终颜色由最后一张决定</h3>
                <p>出牌顺序：${esc(order)}</p>
                <p>最后一张是 <strong>${esc(cardName(last))}</strong>，所以只能转 <strong>${esc(colorName)}</strong>。</p>
                <p class="uno-muted">想转其他颜色？取消后按想要的顺序重新点牌：最后点的那张决定颜色。</p>
                <div class="uno-dialog-actions">
                    <button type="button" class="uno-btn ghost" data-uno-act="dialog-cancel">取消</button>
                    <button type="button" class="uno-btn primary" data-uno-act="confirm-last-color">确定转${esc(colorName)}</button>
                </div>
            </div>`);
    }

    function openColorDialog(colors, callback) {
        S.colorPick = callback;
        const buttons = [["red", "红"], ["yellow", "黄"], ["green", "绿"], ["blue", "蓝"]].map(([color, label]) =>
            `<button type="button" class="uno-color-btn ${color}" data-uno-act="pick-color" data-color="${color}" ${colors.includes(color) ? "" : "disabled"}>${label}</button>`
        ).join("");
        openDialog(`
            <div class="uno-dialog-card">
                <h3>选择最终颜色</h3>
                <p>请选择这批万能牌出完后生效的颜色；下一位玩家必须跟同色牌或万能牌。</p>
                <div class="uno-color-grid">${buttons}</div>
                <div class="uno-dialog-actions">
                    <button type="button" class="uno-btn ghost" data-uno-act="dialog-cancel">取消</button>
                </div>
            </div>`);
    }

    function openTargetDialog(cards, color, targets) {
        S.pendingPlay = { cards, color };
        const value = cards[0].value;
        const effectText = value === "skip"
            ? `会跳过 ${cards.length} 次`
            : (value === "draw2"
                ? `会抽 ${2 * cards.length} 张`
                : (value === "wild4" ? `目标会自己选择抽 ${4 * cards.length} 张或 ${6 * cards.length} 张` : ""));
        const names = new Map((S.room.players || []).map((player) => [player.login, player.name || player.login]));
        const rows = targets.map((login, index) => `
            <label class="uno-target-row">
                <input type="radio" name="uno-target" class="uno-target-input" value="${esc(login)}" ${index === 0 ? "checked" : ""}>
                <span class="uno-grow">${esc(names.get(login) || login)}</span>
                ${index === 0 ? '<span class="uno-tag">下家</span>' : ""}
                ${S.room.me && S.room.me.teammates.includes(login) ? '<span class="uno-tag team0">队友</span>' : ""}
            </label>`).join("");
        openDialog(`
            <div class="uno-dialog-card">
                <h3>选择生效玩家</h3>
                <p>只能选择一名：接下来 1~2 名玩家或自己的队友之一。默认下家。${effectText ? `<br>${esc(effectText)}。` : ""}</p>
                <div class="uno-target-list">${rows}</div>
                <div class="uno-dialog-actions">
                    <button type="button" class="uno-btn ghost" data-uno-act="dialog-cancel">取消</button>
                    <button type="button" class="uno-btn primary" data-uno-act="confirm-targets">确定出牌</button>
                </div>
            </div>`);
    }

    async function confirmTargets() {
        if (!S.pendingPlay) {
            closeDialog();
            return;
        }
        const checked = document.querySelector(".uno-target-input:checked");
        if (!checked) {
            toast("请选择一名生效玩家");
            return;
        }
        const pending = S.pendingPlay;
        S.pendingPlay = null;
        closeDialog();
        await submitPlay(pending.cards, pending.color, [checked.value]);
    }

    function openDialog(html) {
        if (!S.dialog) {
            return;
        }
        S.dialog.innerHTML = html;
        S.dialog.hidden = false;
    }

    function closeDialog() {
        S.wild4DialogOpen = false;
        S.lastColorPlay = null;
        if (S.dialog) {
            S.dialog.hidden = true;
            S.dialog.innerHTML = "";
        }
    }

    async function drawCard() {
        const canDrawAny = Boolean(S.room && S.room.game)
            && (Number(S.room.game.deckCount) > 0 || Number(S.room.game.discardCount) > 1);
        if (!S.room || !myTurn(S.room) || !canDrawAny || S.room.game.pendingWild4) {
            return;
        }
        S.busy = true;
        try {
            const data = await S.api.uno.draw(S.room.id);
            applyRoom(data.room);
            if (data.drawn) {
                toast(data.playable
                    ? `抽到 ${cardName(data.drawn)}，可以出牌或继续抽牌`
                    : `抽到 ${cardName(data.drawn)}，不能出，可以继续抽或过牌`);
            } else {
                toast("牌堆已经空了，可以过牌");
            }
        } catch (error) {
            report(error);
        } finally {
            S.busy = false;
        }
    }

    async function passTurn() {
        if (!S.room || !myTurn(S.room) || !S.room.game.drewThisTurn || S.room.game.pendingWild4) {
            return;
        }
        S.busy = true;
        try {
            const data = await S.api.uno.pass(S.room.id);
            applyRoom(data.room);
        } catch (error) {
            report(error);
        } finally {
            S.busy = false;
        }
    }

    async function sendChat() {
        if (!S.room) {
            return;
        }
        const input = el("uno-chat-input");
        const text = String((input && input.value) || S.chatDraft || "").trim();
        if (!text) {
            return;
        }
        try {
            const data = await S.api.uno.chat(S.room.id, text, S.chatScope);
            S.chatDraft = "";
            if (input) {
                input.value = "";
            }
            const message = data && data.message;
            if (message && !(S.room.chats || []).some((item) => item.id === message.id)) {
                S.room.chats = [...(S.room.chats || []), message].slice(-60);
            }
            renderSidePanelOnly();
        } catch (error) {
            report(error);
        }
    }

    /* ───────────────── 对外接口 ───────────────── */

    window.VTXUno = {
        version: VERSION,
        init,
        open,
        close,
        handleEvent,
        openRoom(options = {}) {
            if (!S.initialized) {
                return;
            }
            S.root.hidden = false;
            enterRoom(options).catch((error) => report(error));
        },
        joinByCode(code) {
            if (!S.initialized) {
                return;
            }
            S.root.hidden = false;
            enterRoom({ code: String(code || "").trim().toUpperCase() }).catch((error) => report(error));
        },
        inviteToCurrent,
        isOpen() {
            return Boolean(S.initialized && S.root && !S.root.hidden);
        }
    };
})();
