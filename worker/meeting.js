/*
 * Vitual XRing 3.1.0：AUDIV 语音会议的 WebSocket 中转。
 *
 * 每个会议号对应一个 Durable Object 实例；它只负责把 WebRTC 的 offer / answer /
 * ICE 候选和成员状态在同一个会议内广播，不接触音视频流。音频本身是浏览器之间
 * 的 P2P（mesh），所以人数上限设为 16，超过就提示改天再约。
 *
 * 协议（JSON）：
 *   客户端 -> DO: {type:"signal", to, data} / {type:"chat", text} / {type:"mute", muted}
 *                 / {type:"end"} / {type:"ping"}
 *   DO -> 客户端: {type:"welcome", peer, peers:[...]}
 *                 {type:"peer-join", peer, name} / {type:"peer-leave", peer}
 *                 {type:"signal", from, data}
 *                 {type:"chat", from, name, text}
 *                 {type:"mute", peer, muted} / {type:"end", by}
 */

const MEETING_MAX_PEERS = 16;
const MEETING_CHAT_MAX = 500;
const MEETING_NAME_MAX = 24;

function safeText(value, limit) {
    return String(value == null ? "" : value).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, limit);
}

function send(ws, payload) {
    try {
        ws.send(JSON.stringify(payload));
    } catch (error) {
        /* 连接已经断了，忽略 */
    }
}

export class MeetingHub {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.sessions = new Map();
        this.ended = false;
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/end") {
            this.endAll("");
            return new Response(JSON.stringify({ ok: true }), {
                headers: { "content-type": "application/json; charset=utf-8" }
            });
        }

        const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
        if (upgrade !== "websocket") {
            return new Response("expected websocket", { status: 426 });
        }

        if (this.ended) {
            return new Response("meeting ended", { status: 410 });
        }

        if (this.sessions.size >= MEETING_MAX_PEERS) {
            return new Response("meeting full", { status: 409 });
        }

        const peer = safeText(url.searchParams.get("peer"), 40).replace(/[^A-Za-z0-9_-]/g, "")
            || `p${Math.random().toString(36).slice(2, 10)}`;
        const name = safeText(url.searchParams.get("name"), MEETING_NAME_MAX) || "访客";

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();

        this.sessions.set(peer, { ws: server, name, muted: false, at: Date.now() });

        server.addEventListener("message", (event) => {
            this.handleMessage(peer, event.data);
        });
        server.addEventListener("close", () => {
            this.leave(peer);
        });
        server.addEventListener("error", () => {
            this.leave(peer);
        });

        send(server, {
            type: "welcome",
            peer,
            peers: this.peerList(peer)
        });
        this.broadcast({ type: "peer-join", peer, name }, peer);
        this.broadcast({ type: "state", peers: this.peerList("") });

        return new Response(null, { status: 101, webSocket: client });
    }

    peerList(exclude) {
        const list = [];
        for (const [peer, info] of this.sessions.entries()) {
            if (peer === exclude) {
                continue;
            }
            list.push({ peer, name: info.name, muted: Boolean(info.muted) });
        }
        return list;
    }

    broadcast(payload, exclude = "") {
        const text = JSON.stringify(payload);
        for (const [peer, info] of this.sessions.entries()) {
            if (peer === exclude) {
                continue;
            }
            try {
                info.ws.send(text);
            } catch (error) {
                /* 忽略断开的连接 */
            }
        }
    }

    leave(peer) {
        const info = this.sessions.get(peer);
        if (!info) {
            return;
        }
        this.sessions.delete(peer);
        this.broadcast({ type: "peer-leave", peer });
        this.broadcast({ type: "state", peers: this.peerList("") });
    }

    endAll(by) {
        if (this.ended) {
            return;
        }
        this.ended = true;
        this.broadcast({ type: "end", by: safeText(by, MEETING_NAME_MAX) });
        for (const info of this.sessions.values()) {
            try {
                info.ws.close(1000, "meeting ended");
            } catch (error) {
                /* 忽略 */
            }
        }
        this.sessions.clear();
    }

    handleMessage(peer, raw) {
        const info = this.sessions.get(peer);
        if (!info) {
            return;
        }
        let data = null;
        try {
            data = JSON.parse(String(raw || ""));
        } catch (error) {
            return;
        }
        if (!data || typeof data !== "object") {
            return;
        }

        if (data.type === "ping") {
            send(info.ws, { type: "pong", at: Date.now() });
            return;
        }

        if (data.type === "signal") {
            const target = this.sessions.get(String(data.to || ""));
            if (target) {
                send(target.ws, { type: "signal", from: peer, data: data.data || null });
            }
            return;
        }

        if (data.type === "chat") {
            const text = safeText(data.text, MEETING_CHAT_MAX);
            if (text) {
                this.broadcast({ type: "chat", from: peer, name: info.name, text, at: Date.now() });
            }
            return;
        }

        if (data.type === "mute") {
            info.muted = Boolean(data.muted);
            this.broadcast({ type: "mute", peer, muted: info.muted });
            return;
        }

        if (data.type === "end") {
            this.endAll(info.name);
        }
    }

    async webSocketMessage(ws, message) {
        /* 使用 state.acceptWebSocket 的兼容入口；正常路径是上面的 addEventListener。 */
        for (const [peer, info] of this.sessions.entries()) {
            if (info.ws === ws) {
                this.handleMessage(peer, message);
                return;
            }
        }
    }

    async webSocketClose(ws) {
        for (const [peer, info] of this.sessions.entries()) {
            if (info.ws === ws) {
                this.leave(peer);
                return;
            }
        }
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws);
    }
}
