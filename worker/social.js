/*
 * Vitual XRing 3.1.0：分享生态 API。
 *
 * 挂载点：/api/social/*
 * 页面：Vimidi、VMusic、Viratch、AUDIV、ViStyle、VClang、Vitx 动态、share.html
 *
 * 设计约定：
 *   - 所有条目共用 social-store.js 的 KV 布局；
 *   - 上传先建草稿，再 PUT .../file，成功后才允许发布；
 *   - 样式包 / C++ 作品可以定价，购买记录写进账户 library（跟余额同一次 commit）；
 *   - 聊天、私聊、视频评论、动态的“自动识别”都调用 resolveTextCard()，
 *     服务端把卡片快照存进消息，渲染时不再请求第三方。
 */

import {
    CARD_KIND_META,
    SocialError,
    SOCIAL_KINDS,
    SOCIAL_LIMITS,
    SOCIAL_VERSION,
    addToIndex,
    analyzeMidiFile,
    cardForItem,
    cardView,
    createCustomCard,
    findMeetingByNo,
    itemPriceCents,
    itemSummary,
    isPublished,
    itemKey,
    listItems,
    matchMusicForMidi,
    meetingNoKey,
    midiNameOk,
    normalizeHttpUrl,
    normalizeIcon,
    normalizeImages,
    normalizeMeetingNo,
    normalizeTags,
    priceText,
    readCard,
    readIndex,
    readItem,
    removeItem,
    resolveShareUrl,
    resolveTextCard,
    saveItem,
    socialBase,
    socialId,
    socialItemId,
    socialKind,
    socialNow,
    writeIndex,
    commentsKey,
    cppFilesKey,
    fileKey
} from "./social-store.js";

const PURCHASE_MAX_VTX = 20000;
const SOCIAL_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const SOCIAL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function fail(status, code, message) {
    throw new SocialError(status, code, message);
}

function isoNow() {
    return socialNow();
}

function nowMs() {
    return Date.now();
}

function text(value, limit = 200) {
    return String(value == null ? "" : value).trim().slice(0, limit);
}

function digitsOnly(value) {
    return String(value || "").replace(/[^0-9]/g, "");
}

function toCents(value) {
    const number = Number(String(value == null ? "" : value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function fromCents(cents) {
    return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

function pushTrade(account, trade) {
    account.trades = Array.isArray(account.trades) ? account.trades : [];
    account.trades.push(trade);
    return trade;
}

async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function throttleStore() {
    return socialThrottle;
}

const socialThrottle = new Map();

function throttled(key, windowMs, max) {
    const now = Date.now();
    const bucket = socialThrottle.get(key);
    if (!bucket || bucket.reset <= now) {
        socialThrottle.set(key, { count: 1, reset: now + windowMs });
        return false;
    }
    bucket.count += 1;
    return bucket.count > max;
}

function viewerOf(env, deps, request) {
    return (async () => {
        let login = "";
        try {
            login = (await deps.optionalLogin(request)) || "";
        } catch (error) {
            login = "";
        }
        let account = null;
        if (login) {
            try {
                const accounts = await deps.loadAccounts(env);
                account = accounts[login] || null;
            } catch (error) {
                account = null;
            }
        }
        return {
            login,
            account,
            isAdmin: Boolean(login && deps.isPlatformAdmin(env, login))
        };
    })();
}

async function requireLogin(request, env, deps, cors) {
    const session = await deps.requireSession(request, env, cors);
    if (session.error) {
        return { error: session.error };
    }
    return { login: session.payload.sub };
}

async function ownerNameOf(env, deps, login) {
    try {
        const name = await deps.displayName(login);
        return text(name || login, 24);
    } catch (error) {
        return text(login, 24);
    }
}

function canReadItem(item, viewer) {
    return Boolean(item) && (isPublished(item) || viewer.isAdmin || (viewer.login && item.owner === viewer.login));
}

function paidKind(kind) {
    return kind === "style" || kind === "cpp";
}

function hasPurchased(account, id) {
    const library = Array.isArray(account && account.library) ? account.library : [];
    return library.some((entry) => entry && entry.id === id);
}

function canAccessFile(item, viewer) {
    if (!item) {
        return false;
    }
    if (viewer.isAdmin || (viewer.login && item.owner === viewer.login)) {
        return true;
    }
    if (!isPublished(item)) {
        return false;
    }
    if (paidKind(item.kind) && itemPriceCents(item) > 0) {
        return hasPurchased(viewer.account, item.id);
    }
    return true;
}

async function detailView(env, item, viewer, deps) {
    const summary = itemSummary(item, {
        login: viewer.login,
        account: viewer.account,
        isAdmin: viewer.isAdmin,
        detail: true
    });
    return {
        ok: true,
        item: {
            ...summary,
            canDownload: canAccessFile(item, viewer),
            fileUrl: item.file ? `/api/social/file/${encodeURIComponent(item.id)}` : ""
        }
    };
}

async function loadOwned(env, kind, id, viewer, cors, deps) {
    const item = await readItem(env, kind, id);
    if (!item || item.kind !== kind) {
        throw new SocialError(404, "not_found", "内容不存在");
    }
    if (item.owner !== viewer.login && !viewer.isAdmin) {
        throw new SocialError(403, "forbidden", "只有作者或站主可以修改这个内容");
    }
    return item;
}

function sanitizeStyleCss(source) {
    const css = String(source || "");
    if (!css.trim()) {
        throw new SocialError(400, "bad_request", "CSS 不能为空");
    }
    if (css.length > SOCIAL_LIMITS.style) {
        throw new SocialError(413, "too_large", `CSS 不能超过 ${Math.round(SOCIAL_LIMITS.style / 1024)} KB`);
    }
    const lower = css.toLowerCase();
    const blocked = ["@import", "expression(", "javascript:", "vbscript:", "behavior:", "-moz-binding", "</style", "<script"];
    for (const token of blocked) {
        if (lower.includes(token)) {
            throw new SocialError(400, "bad_css", `CSS 里不允许出现 ${token}`);
        }
    }
    return css;
}

function sanitizeFileName(raw) {
    const name = String(raw || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.length > 120 || name.includes("..") || /[\u0000-\u001f]/.test(name)) {
        return "";
    }
    return name;
}

function musicDuration(value) {
    const seconds = Math.round(Number(value) || 0);
    return Number.isFinite(seconds) && seconds > 0 && seconds < 24 * 60 * 60 ? seconds : 0;
}

function scratchProjectSize(project) {
    try {
        return new TextEncoder().encode(JSON.stringify(project)).length;
    } catch (error) {
        return Number.MAX_SAFE_INTEGER;
    }
}

function normalizeProject(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    const sprites = Array.isArray(raw.sprites) ? raw.sprites.slice(0, 20) : [];
    const clean = {
        v: 1,
        width: Math.max(240, Math.min(960, Number(raw.width) || 480)),
        height: Math.max(180, Math.min(720, Number(raw.height) || 360)),
        background: text(raw.background || "#ffffff", 40),
        sprites: sprites.map((sprite) => ({
            id: text(sprite && sprite.id, 40) || socialId("scr"),
            name: text(sprite && sprite.name, 24) || "角色",
            emoji: text(sprite && sprite.emoji, 8) || "🐱",
            x: Number(sprite && sprite.x) || 0,
            y: Number(sprite && sprite.y) || 0,
            size: Math.max(10, Math.min(300, Number(sprite && sprite.size) || 100)),
            direction: Number(sprite && sprite.direction) || 90,
            costume: Math.max(0, Math.floor(Number(sprite && sprite.costume) || 0)),
            scripts: Array.isArray(sprite && sprite.scripts)
                ? sprite.scripts.slice(0, 12).map((script) => ({
                    event: ["flag", "click", "key"].includes(script && script.event) ? script.event : "flag",
                    key: text(script && script.key, 8),
                    blocks: Array.isArray(script && script.blocks)
                        ? script.blocks.slice(0, 80).map((block) => ({
                            op: text(block && block.op, 20),
                            a: Number(block && block.a) || 0,
                            b: Number(block && block.b) || 0,
                            text: text(block && block.text, 60)
                        }))
                        : []
                }))
                : []
        }))
    };
    return clean;
}

async function createDraft(env, deps, viewer, kind, body) {
    const title = text(body.title, 80);
    if (!title) {
        throw new SocialError(400, "bad_request", "标题不能为空");
    }
    const description = text(body.description, 500);
    const icon = normalizeIcon(body.icon);
    const tags = normalizeTags(body.tags);
    const id = socialId(kind);
    const ownerName = await ownerNameOf(env, deps, viewer.login);
    const item = {
        id,
        kind,
        owner: viewer.login,
        ownerName,
        title,
        description,
        icon,
        tags,
        price: "0.00",
        published: false,
        ready: false,
        views: 0,
        baseLikes: 0,
        likes: [],
        purchases: 0,
        commentCount: 0,
        at: nowMs(),
        time: isoNow(),
        extra: {}
    };

    if (paidKind(kind)) {
        const price = Math.max(0, Math.min(PURCHASE_MAX_VTX, Number(body.price) || 0));
        item.price = fromCents(Math.round(price * 100));
    }

    if (kind === "midi") {
        item.extra.artist = text(body.artist, 80);
    } else if (kind === "music") {
        item.extra.artist = text(body.artist, 80);
        item.extra.album = text(body.album, 80);
        item.extra.durationSeconds = musicDuration(body.duration);
        const midiId = socialItemId(body.midiId || "");
        if (midiId) {
            item.extra.midiId = midiId;
        }
    } else if (kind === "scratch") {
        const engine = body.engine === "sb3" ? "sb3" : "xr";
        item.extra.engine = engine;
        item.extra.instructions = text(body.instructions, 300);
        if (engine === "xr") {
            const project = normalizeProject(body.project);
            if (!project) {
                throw new SocialError(400, "bad_request", "站内作品需要至少一个角色");
            }
            if (scratchProjectSize(project) > 256 * 1024) {
                throw new SocialError(413, "too_large", "作品数据不能超过 256 KB");
            }
            item.extra.project = project;
            item.ready = true;
        }
    } else if (kind === "style") {
        item.extra.version = text(body.version || "1.0.0", 20);
    } else if (kind === "cpp") {
        item.extra.compiler = text(body.compiler || "Dev-C++", 40);
    } else {
        throw new SocialError(400, "bad_request", "不支持这种内容类型");
    }

    await saveItem(env, kind, item);
    await addToIndex(env, kind, id);
    return item;
}

async function linkMidiToMusic(env, midi, music) {
    const analysis = midi.extra && typeof midi.extra === "object" ? midi.extra : {};
    music.extra = music.extra && typeof music.extra === "object" ? music.extra : {};
    music.extra.midiId = midi.id;
    music.extra.midiTitle = midi.title;
    if (analysis.signature) {
        music.extra.midiSignature = analysis.signature;
    }
    if (Array.isArray(analysis.pitchProfile)) {
        music.extra.pitchProfile = analysis.pitchProfile;
    }
    if (analysis.durationSeconds && !Number(music.extra.durationSeconds)) {
        music.extra.durationSeconds = Number(analysis.durationSeconds);
    }
    await saveItem(env, "music", music);

    midi.extra = midi.extra && typeof midi.extra === "object" ? midi.extra : {};
    midi.extra.musicId = music.id;
    midi.extra.musicTitle = music.title;
    midi.extra.recognizedBy = "manual";
    midi.extra.recognitionConfidence = 1;
    await saveItem(env, "midi", midi);
}

/* 3.1.0：VMusic 上传时如果没手动选 MIDI，就按标题 / 时长去 Vimidi 里找最像的一首。 */
async function autoLinkMusicToMidi(env, music) {
    const title = String(music.title || "").replace(/\s+/g, "").toLowerCase();
    if (!title) {
        return null;
    }
    const ids = await readIndex(env, "midi");
    let best = null;
    for (const id of ids.slice(0, 80)) {
        const midi = await readItem(env, "midi", id);
        if (!midi) {
            continue;
        }
        const extra = midi.extra && typeof midi.extra === "object" ? midi.extra : {};
        const midiTitle = String(midi.title || "").replace(/\s+/g, "").toLowerCase();
        const artist = String((music.extra && music.extra.artist) || "").replace(/\s+/g, "").toLowerCase();
        let score = 0;
        if (midiTitle && title && (midiTitle === title || midiTitle.includes(title) || title.includes(midiTitle))) {
            score += 0.7;
        }
        if (artist && String(extra.artist || "").replace(/\s+/g, "").toLowerCase() === artist) {
            score += 0.25;
        }
        const duration = Number(music.extra && music.extra.durationSeconds) || 0;
        const midiDuration = Number(extra.durationSeconds) || 0;
        if (duration && midiDuration && Math.abs(duration - midiDuration) <= 5) {
            score += 0.2;
        }
        if (score >= 0.65 && (!best || score > best.score)) {
            best = { midi, score };
        }
    }
    if (!best) {
        return null;
    }
    await linkMidiToMusic(env, best.midi, music);
    return best;
}

async function applyMidiRecognition(env, midi) {
    const extra = midi.extra && typeof midi.extra === "object" ? midi.extra : {};
    const match = await matchMusicForMidi(env, {
        signature: extra.signature,
        pitchProfile: extra.pitchProfile,
        durationSeconds: Number(extra.durationSeconds) || 0
    });
    if (!match || !match.item) {
        return null;
    }
    midi.extra = extra;
    midi.extra.musicId = match.item.id;
    midi.extra.musicTitle = match.item.title;
    midi.extra.recognizedBy = match.exact ? "signature" : "similarity";
    midi.extra.recognitionConfidence = match.confidence;
    await saveItem(env, "midi", midi);
    return match;
}

async function handleCreateMeeting(env, deps, viewer, body) {
    const title = text(body.title, 60) || `${viewer.login} 的语音会议`;
    const hostName = text(body.hostName, 24) || await ownerNameOf(env, deps, viewer.login);
    const password = text(body.password, 32);
    let no = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const bytes = new Uint8Array(4);
        crypto.getRandomValues(bytes);
        const value = Math.floor((((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) / 1000)
            % 1000000000;
        const candidate = String(value).padStart(9, "0");
        const existing = await env.ACCOUNTS_KV.get(meetingNoKey(candidate));
        if (!existing) {
            no = `${candidate.slice(0, 3)}-${candidate.slice(3, 6)}-${candidate.slice(6, 9)}`;
            break;
        }
    }
    if (!no) {
        throw new SocialError(503, "busy", "会议号生成失败，请稍后再试");
    }

    const item = {
        id: socialId("meeting"),
        kind: "meeting",
        owner: viewer.login,
        ownerName: hostName,
        title,
        description: text(body.description, 300),
        icon: "🎙️",
        tags: [],
        price: "0.00",
        published: true,
        ready: true,
        views: 0,
        baseLikes: 0,
        likes: [],
        purchases: 0,
        commentCount: 0,
        at: nowMs(),
        time: isoNow(),
        extra: {
            no,
            hostName,
            passwordHash: password ? await sha256Hex(password) : "",
            ended: false
        }
    };
    await saveItem(env, "meeting", item);
    await addToIndex(env, "meeting", item.id);
    await env.ACCOUNTS_KV.put(meetingNoKey(no.replace(/-/g, "")), item.id);
    return item;
}

async function meetingJoinToken(env, item, no) {
    return await sha256Hex(`meeting:${item.id}:${normalizeMeetingNo(no)}:${env.SIGNING_SECRET || "vtx"}`);
}

async function handleMeetingJoin(env, no, body) {
    const item = await findMeetingByNo(env, no);
    if (!item) {
        throw new SocialError(404, "not_found", "会议不存在或已结束");
    }
    if (item.extra && item.extra.ended) {
        throw new SocialError(410, "ended", "会议已结束");
    }
    const hash = item.extra && item.extra.passwordHash ? String(item.extra.passwordHash) : "";
    if (hash) {
        const provided = await sha256Hex(text(body.password, 32));
        if (provided !== hash) {
            throw new SocialError(403, "wrong_password", "会议密码不正确");
        }
    }
    return {
        item,
        token: await meetingJoinToken(env, item, no)
    };
}

async function handlePurchase(env, deps, viewer, item, body) {
    const cents = itemPriceCents(item);
    if (!paidKind(item.kind) || cents <= 0) {
        throw new SocialError(400, "bad_request", "这个内容不需要购买");
    }
    if (item.owner === viewer.login) {
        throw new SocialError(400, "bad_request", "不能购买自己的作品");
    }
    if (hasPurchased(viewer.account, item.id)) {
        throw new SocialError(400, "already_purchased", "已经购买过这个作品了");
    }
    const password = String(body.password || "");
    if (!password) {
        throw new SocialError(400, "bad_request", "购买需要输入账户密码");
    }

    const buyerName = String((viewer.account && viewer.account.username) || viewer.login);
    const at = nowMs();
    const time = isoNow();
    const price = fromCents(cents);
    let trade = null;

    const accounts = await deps.commitAccounts(env, async (accounts) => {
        const buyer = accounts[viewer.login];
        if (!buyer) {
            throw new SocialError(404, "not_found", "账户不存在");
        }
        await deps.checkPassword(buyer, password);
        if (hasPurchased(buyer, item.id)) {
            throw new SocialError(400, "already_purchased", "已经购买过这个作品了");
        }
        const balance = toCents(buyer.money);
        if (balance < cents) {
            throw new SocialError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(balance)} VTX`);
        }
        buyer.money = fromCents(balance - cents);
        buyer.library = Array.isArray(buyer.library) ? buyer.library : [];
        buyer.library.push({
            id: item.id,
            kind: item.kind,
            title: item.title,
            price,
            at,
            time
        });
        trade = pushTrade(buyer, {
            name: item.kind === "style" ? "购买 ViStyle 样式包" : "购买 VClang 作品",
            description: `${item.title}（作者 ${item.ownerName || item.owner}）`,
            price: `-${price}`,
            time,
            from: buyerName,
            to: item.ownerName || item.owner
        });

        const seller = accounts[item.owner];
        if (seller) {
            seller.money = fromCents(toCents(seller.money) + cents);
            seller.library = Array.isArray(seller.library) ? seller.library : [];
            pushTrade(seller, {
                name: item.kind === "style" ? "出售 ViStyle 样式包" : "出售 VClang 作品",
                description: `${item.title}（买家 ${buyerName}）`,
                price: `+${price}`,
                time,
                from: buyerName,
                to: seller.username || item.owner
            });
        }
        return `${item.kind === "style" ? "购买样式包" : "购买 C++ 作品"}：${buyerName} → ${item.title} ${price} VTX`;
    });

    if (accounts && accounts[viewer.login]) {
        viewer.account = accounts[viewer.login];
    }
    item.purchases = (Number(item.purchases) || 0) + 1;
    await saveItem(env, item.kind, item);
    return { trade, price };
}

async function handleDynamicCreate(env, deps, viewer, body, base) {
    let content = text(body.text, SOCIAL_LIMITS.dynamicText);
    const images = normalizeImages(body.images);
    if (!content && !images.length && !body.cardId) {
        throw new SocialError(400, "bad_request", "动态内容不能为空");
    }
    let card = null;
    if (body.cardId) {
        const custom = await readCard(env, socialItemId(body.cardId));
        if (custom) {
            card = cardView(custom, base);
        }
    }
    if (!card && content) {
        card = await resolveTextCard(env, content, base);
    }
    if (!content) {
        content = card ? `分享了 ${card.title}` : "";
    }
    const title = text(body.title, 60)
        || content.replace(/\s+/g, " ").trim().slice(0, 40)
        || (card ? `分享了 ${card.title}` : "新动态");
    const id = socialId("dynamic");
    const item = {
        id,
        kind: "dynamic",
        owner: viewer.login,
        ownerName: await ownerNameOf(env, deps, viewer.login),
        title,
        description: content.slice(0, 120),
        icon: "📝",
        tags: normalizeTags(body.tags),
        price: "0.00",
        published: true,
        ready: true,
        views: 0,
        baseLikes: 0,
        likes: [],
        purchases: 0,
        commentCount: 0,
        at: nowMs(),
        time: isoNow(),
        extra: {
            text: content,
            images,
            card,
            repostOf: "",
            repostCount: 0
        }
    };
    await saveItem(env, "dynamic", item);
    await addToIndex(env, "dynamic", id);
    return item;
}

async function handleDynamicComments(env, deps, request, viewer, item, cors) {
    if (request.method === "GET") {
        const stored = await env.ACCOUNTS_KV.get(commentsKey(item.id), "json");
        const list = Array.isArray(stored) ? stored.slice(-SOCIAL_LIMITS.commentKeep) : [];
        const comments = list.map((comment) => {
            const likes = Array.isArray(comment.likes) ? comment.likes : [];
            return {
                id: comment.id,
                user: comment.user || "",
                userName: comment.userName || comment.user || "",
                text: comment.text || "",
                card: comment.card || null,
                at: Number(comment.at) || 0,
                likes: likes.length,
                liked: Boolean(viewer.login && likes.includes(viewer.login)),
                mine: Boolean(viewer.login && comment.user === viewer.login)
            };
        });
        return deps.jsonResponse({ ok: true, comments, count: comments.length }, 200, cors);
    }

    const session = await deps.requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const body = deps.plainObject(await deps.readJsonBody(request));
    const content = text(body.text, SOCIAL_LIMITS.comment);
    if (!content) {
        throw new SocialError(400, "bad_request", "评论不能为空");
    }
    const base = socialBase(env, new URL(request.url).origin);
    const card = await resolveTextCard(env, content, base);
    const accounts = await deps.loadAccounts(env);
    const login = session.payload.sub;
    const comment = {
        id: `c_${socialId("dyn").split("_")[1]}`,
        user: login,
        userName: String((accounts[login] && accounts[login].username) || login).slice(0, 24),
        text: content,
        card,
        at: nowMs(),
        likes: []
    };
    const stored = await env.ACCOUNTS_KV.get(commentsKey(item.id), "json");
    const list = Array.isArray(stored) ? stored : [];
    list.push(comment);
    const kept = list.slice(-SOCIAL_LIMITS.commentKeep);
    await env.ACCOUNTS_KV.put(commentsKey(item.id), JSON.stringify(kept));
    item.commentCount = kept.length;
    await saveItem(env, "dynamic", item);
    return deps.jsonResponse({
        ok: true,
        comment: {
            id: comment.id,
            user: login,
            userName: comment.userName,
            text: content,
            card,
            at: comment.at,
            likes: 0,
            liked: false,
            mine: true
        },
        count: kept.length
    }, 201, cors);
}

async function handleDynamicCommentLike(env, deps, request, viewer, item, commentId, cors) {
    const session = await deps.requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const stored = await env.ACCOUNTS_KV.get(commentsKey(item.id), "json");
    const list = Array.isArray(stored) ? stored : [];
    const comment = list.find((entry) => entry && entry.id === commentId);
    if (!comment) {
        throw new SocialError(404, "not_found", "评论不存在");
    }
    const likes = Array.isArray(comment.likes) ? comment.likes : [];
    const index = likes.indexOf(session.payload.sub);
    if (index >= 0) {
        likes.splice(index, 1);
    } else {
        likes.push(session.payload.sub);
    }
    comment.likes = likes.slice(0, SOCIAL_LIMITS.likes);
    await env.ACCOUNTS_KV.put(commentsKey(item.id), JSON.stringify(list));
    return deps.jsonResponse({
        ok: true,
        likes: likes.length,
        liked: likes.includes(session.payload.sub)
    }, 200, cors);
}

function binaryResponse(body, status, contentType, extraHeaders) {
    const headers = {
        "content-type": contentType || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600",
        ...(extraHeaders || {})
    };
    return new Response(body, { status, headers });
}

function rangeResponse(buffer, contentType, headers, rangeHeader, fileName) {
    const total = buffer.byteLength;
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(fileName || "download")}`;
    const baseHeaders = {
        "content-type": contentType || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=3600",
        "content-disposition": fileName ? disposition : "inline",
        ...(headers || {})
    };
    if (!rangeHeader) {
        return new Response(buffer, {
            status: 200,
            headers: { ...baseHeaders, "content-length": String(total) }
        });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
        return new Response(null, { status: 416, headers: { ...baseHeaders, "content-range": `bytes */${total}` } });
    }
    let start;
    let end;
    if (!match[1]) {
        const suffix = Math.min(Number(match[2]) || 1, total);
        start = Math.max(0, total - suffix);
        end = total - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    }
    if (!Number.isFinite(start) || start < 0 || start > end || start >= total) {
        return new Response(null, { status: 416, headers: { ...baseHeaders, "content-range": `bytes */${total}` } });
    }
    const chunk = buffer.slice(start, end + 1);
    return new Response(chunk, {
        status: 206,
        headers: {
            ...baseHeaders,
            "content-range": `bytes ${start}-${end}/${total}`,
            "content-length": String(chunk.byteLength)
        }
    });
}

async function readBinaryBody(request, maxBytes) {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared && declared > maxBytes) {
        throw new SocialError(413, "too_large", `文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
        throw new SocialError(413, "too_large", `文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    if (!buffer.byteLength) {
        throw new SocialError(400, "bad_request", "文件是空的");
    }
    return buffer;
}

async function storePrimaryFile(env, deps, viewer, kind, item, request) {
    const name = sanitizeFileName(decodeURIComponent(String(request.headers.get("x-file-name") || "")));
    if (!name) {
        throw new SocialError(400, "bad_request", "缺少有效的文件名");
    }
    const declaredType = String(request.headers.get("content-type") || "").toLowerCase();

    if (kind === "midi") {
        if (!midiNameOk(name) && !/midi/.test(declaredType)) {
            throw new SocialError(400, "bad_request", "Vimidi 只接收 .mid / .midi / .rmi 文件");
        }
        const buffer = await readBinaryBody(request, SOCIAL_LIMITS.midi);
        let analysis;
        try {
            analysis = await analyzeMidiFile(buffer, name);
        } catch (error) {
            throw new SocialError(400, "bad_midi", error.message || "MIDI 解析失败");
        }
        await env.ACCOUNTS_KV.put(fileKey(item.id), buffer);
        item.file = { name, type: "audio/midi", size: buffer.byteLength };
        item.extra = {
            ...(item.extra || {}),
            ...analysis,
            artist: item.extra && item.extra.artist ? item.extra.artist : analysis.artist
        };
        if (!item.title || item.title === "未命名 MIDI") {
            item.title = analysis.title;
        }
        item.ready = true;
        await saveItem(env, kind, item);
        await applyMidiRecognition(env, item);
        return item;
    }

    if (kind === "music") {
        const okType = declaredType.startsWith("audio/")
            || /\.(mp3|m4a|wav|ogg|oga|flac|aac|opus|weba|wma|aif|aiff)$/i.test(name);
        if (!okType) {
            throw new SocialError(400, "bad_request", "VMusic 只接收音频文件（mp3 / m4a / wav / ogg / flac 等）");
        }
        const buffer = await readBinaryBody(request, SOCIAL_LIMITS.music);
        const type = declaredType.startsWith("audio/") ? declaredType : "audio/mpeg";
        await env.ACCOUNTS_KV.put(fileKey(item.id), buffer);
        item.file = { name, type, size: buffer.byteLength };
        item.ready = true;
        if (item.extra && item.extra.midiId) {
            const midi = await readItem(env, "midi", item.extra.midiId);
            if (midi) {
                await linkMidiToMusic(env, midi, item);
            }
        } else {
            await autoLinkMusicToMidi(env, item);
        }
        await saveItem(env, kind, item);
        return item;
    }

    if (kind === "scratch") {
        if (!/\.sb3$/i.test(name)) {
            throw new SocialError(400, "bad_request", "Viratch 导入只接收 .sb3 作品文件");
        }
        const buffer = await readBinaryBody(request, SOCIAL_LIMITS.scratch);
        await env.ACCOUNTS_KV.put(fileKey(item.id), buffer);
        item.file = { name, type: "application/octet-stream", size: buffer.byteLength };
        item.extra = { ...(item.extra || {}), engine: "sb3" };
        item.ready = true;
        await saveItem(env, kind, item);
        return item;
    }

    if (kind === "style") {
        if (!/\.css$/i.test(name) && !declaredType.includes("text/css") && !declaredType.includes("text/plain")) {
            throw new SocialError(400, "bad_request", "ViStyle 只接收 .css 文件");
        }
        const buffer = await readBinaryBody(request, SOCIAL_LIMITS.style);
        const css = sanitizeStyleCss(new TextDecoder("utf-8", { fatal: false }).decode(buffer));
        const encoded = new TextEncoder().encode(css);
        await env.ACCOUNTS_KV.put(fileKey(item.id), encoded);
        item.file = { name: name.endsWith(".css") ? name : `${name}.css`, type: "text/css; charset=utf-8", size: encoded.byteLength };
        item.ready = true;
        await saveItem(env, kind, item);
        return item;
    }

    throw new SocialError(400, "bad_request", "这种内容不支持直接上传主文件");
}

async function storeCppFiles(env, item, body) {
    if (!Array.isArray(body.files) || !body.files.length) {
        throw new SocialError(400, "bad_request", "请上传 Dev-C++ 项目文件");
    }
    if (body.files.length > SOCIAL_LIMITS.cppCount) {
        throw new SocialError(400, "bad_request", `一次最多上传 ${SOCIAL_LIMITS.cppCount} 个文件`);
    }
    const files = [];
    let total = 0;
    const seen = new Set();
    for (const raw of body.files) {
        const name = sanitizeFileName(raw && raw.name);
        if (!name || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const content = String((raw && raw.text) || "");
        const size = new TextEncoder().encode(content).length;
        if (size > SOCIAL_LIMITS.cppFile) {
            throw new SocialError(413, "too_large", `${name} 超过 ${Math.round(SOCIAL_LIMITS.cppFile / 1024)} KB`);
        }
        total += size;
        if (total > SOCIAL_LIMITS.cppTotal) {
            throw new SocialError(413, "too_large", `项目总大小不能超过 ${Math.round(SOCIAL_LIMITS.cppTotal / 1024)} KB`);
        }
        files.push({ name, size, text: content });
    }
    if (!files.length) {
        throw new SocialError(400, "bad_request", "没有有效的项目文件");
    }
    const devFile = files.find((entry) => /\.dev$/i.test(entry.name));
    if (!devFile) {
        throw new SocialError(400, "bad_request", "必须包含 Dev-C++ 自动生成的 .dev 项目文件");
    }
    if (!/<Project[\s>]/i.test(devFile.text)) {
        throw new SocialError(400, "bad_request", ".dev 不是有效的 Dev-C++ 项目文件");
    }
    if (!files.some((entry) => /\.(cpp|cc|cxx|c|h|hpp|hh)$/i.test(entry.name))) {
        throw new SocialError(400, "bad_request", "项目里至少需要一个 C++ 源文件（.cpp / .h 等）");
    }
    await env.ACCOUNTS_KV.put(cppFilesKey(item.id), JSON.stringify(files));
    item.file = { name: devFile.name, type: "text/plain; charset=utf-8", size: total };
    item.extra = {
        ...(item.extra || {}),
        devFile: devFile.name,
        files: files.map((entry) => ({ name: entry.name, size: entry.size }))
    };
    item.ready = true;
    await saveItem(env, "cpp", item);
    return item;
}

async function handleFileRequest(env, deps, request, id, cors) {
    const item = await readItemById(env, id);
    if (!item) {
        throw new SocialError(404, "not_found", "文件不存在");
    }
    const viewer = await viewerOf(env, deps, request);
    if (!canAccessFile(item, viewer)) {
        throw new SocialError(403, "forbidden", "需要先购买这个作品");
    }
    const buffer = await env.ACCOUNTS_KV.get(fileKey(item.id), "arrayBuffer");
    if (!buffer || !buffer.byteLength) {
        throw new SocialError(404, "not_found", "文件不存在或已被删除");
    }
    const url = new URL(request.url);
    const download = url.searchParams.get("download") === "1";
    const fileName = item.file && item.file.name ? item.file.name : item.id;
    const headers = { ...cors };
    if (download) {
        headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }
    return rangeResponse(buffer, item.file && item.file.type, headers, request.headers.get("range"), download ? fileName : "");
}

/* 3.1.0：动态配图。聊天室图片要带 token 才能读，不能直接当公开动态图片用；
   这里单独存一份公开图片（只允许 png/jpeg/gif/webp，4 MB 以内）。 */
function socialImageKey(id) {
    return `social:image:${id}`;
}

function socialImageMetaKey(id) {
    return `social:image-meta:${id}`;
}

async function handleImageUpload(request, env, deps, viewer, cors) {
    const type = String(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!SOCIAL_IMAGE_TYPES.has(type)) {
        throw new SocialError(400, "bad_request", "只支持 PNG / JPEG / GIF / WebP 图片");
    }
    const buffer = await readBinaryBody(request, SOCIAL_IMAGE_MAX_BYTES);
    const id = `img_${socialId("link").split("_")[1] || socialId("link")}`;
    await env.ACCOUNTS_KV.put(socialImageKey(id), buffer);
    await env.ACCOUNTS_KV.put(socialImageMetaKey(id), JSON.stringify({
        id,
        type,
        size: buffer.byteLength,
        owner: viewer.login,
        at: nowMs()
    }));
    const url = `${socialBase(env, new URL(request.url).origin)}/api/social/images/${id}`;
    return deps.jsonResponse({
        ok: true,
        image: { id, url, type, size: buffer.byteLength }
    }, 201, cors);
}

async function handleImageGet(env, request, id, cors) {
    if (!/^img_[A-Za-z0-9_-]{4,40}$/.test(id)) {
        throw new SocialError(404, "not_found", "图片不存在");
    }
    const meta = plainJson(await env.ACCOUNTS_KV.get(socialImageMetaKey(id), "json"));
    if (!meta || !SOCIAL_IMAGE_TYPES.has(meta.type)) {
        throw new SocialError(404, "not_found", "图片不存在");
    }
    const buffer = await env.ACCOUNTS_KV.get(socialImageKey(id), "arrayBuffer");
    if (!buffer) {
        throw new SocialError(404, "not_found", "图片不存在");
    }
    return new Response(buffer, {
        status: 200,
        headers: {
            ...cors,
            "content-type": meta.type,
            "x-content-type-options": "nosniff",
            "cache-control": "public, max-age=31536000, immutable",
            "content-length": String(buffer.byteLength)
        }
    });
}

function plainJson(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function readItemById(env, id) {
    if (!socialItemId(id)) {
        return null;
    }
    const prefix = String(id).split("_")[0];
    const map = {
        midi: "midi",
        mus: "music",
        scr: "scratch",
        meet: "meeting",
        sty: "style",
        cpp: "cpp",
        dyn: "dynamic"
    };
    const kind = map[prefix];
    if (!kind) {
        return null;
    }
    return await readItem(env, kind, id);
}

async function handleRoute(request, env, cors, deps) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/social\/?/, "/") || "/";
    const method = request.method;
    const base = socialBase(env, url.origin);
    const ip = deps.clientIp(request);

    if (path === "/health" && method === "GET") {
        return deps.jsonResponse({
            ok: true,
            version: SOCIAL_VERSION,
            kinds: SOCIAL_KINDS,
            storage: env.ACCOUNTS_KV ? "workers-kv" : "missing"
        }, 200, cors);
    }

    if (env.SOCIAL_ENABLED === "false") {
        return deps.jsonResponse({ error: "disabled", message: "分享功能暂时关闭" }, 503, cors);
    }

    if (!env.ACCOUNTS_KV) {
        return deps.jsonResponse({ error: "unavailable", message: "服务端未配置 ACCOUNTS_KV" }, 503, cors);
    }

    if (path === "/resolve" && method === "GET") {
        const raw = url.searchParams.get("url") || "";
        if (!raw || raw.length > 1000) {
            throw new SocialError(400, "bad_request", "缺少要识别的链接");
        }
        const card = await resolveShareUrl(env, raw, base);
        return deps.jsonResponse({ ok: true, card }, 200, cors);
    }

    if (path === "/card" && method === "GET") {
        const id = socialItemId(url.searchParams.get("id") || "");
        const card = id ? await readCard(env, id) : null;
        return deps.jsonResponse({ ok: Boolean(card), card: card ? cardView(card, base) : null }, card ? 200 : 404, cors);
    }

    if (path === "/shares" && method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        if (throttled(`share:${ip}`, 60 * 1000, 20)) {
            throw new SocialError(429, "too_many_requests", "分享太快了，稍后再试");
        }
        const body = deps.plainObject(await deps.readJsonBody(request));
        const card = await createCustomCard(env, base, body, session.payload.sub);
        return deps.jsonResponse({ ok: true, card }, 201, cors);
    }

    if (path === "/images" && method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        if (throttled(`image:${ip}`, 60 * 1000, 30)) {
            throw new SocialError(429, "too_many_requests", "上传图片太快了，稍后再试");
        }
        const viewer = await viewerOf(env, deps, request);
        return await handleImageUpload(request, env, deps, viewer, cors);
    }

    const imageMatch = /^\/images\/([^/]+)$/.exec(path);
    if (imageMatch && method === "GET") {
        return await handleImageGet(env, request, decodeURIComponent(imageMatch[1]), cors);
    }

    const shareMatch = /^\/shares\/([^/]+)$/.exec(path);
    if (shareMatch && method === "GET") {
        const card = await readCard(env, socialItemId(decodeURIComponent(shareMatch[1])));
        if (!card) {
            throw new SocialError(404, "not_found", "分享不存在");
        }
        return deps.jsonResponse({ ok: true, card: cardView(card, base) }, 200, cors);
    }

    if (path === "/me/library" && method === "GET") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        const viewer = await viewerOf(env, deps, request);
        const library = Array.isArray(viewer.account && viewer.account.library) ? viewer.account.library : [];
        const items = [];
        for (const entry of library.slice(-100).reverse()) {
            const item = await readItem(env, entry.kind, entry.id);
            if (item) {
                items.push(itemSummary(item, { login: viewer.login, account: viewer.account, detail: false }));
            }
        }
        return deps.jsonResponse({ ok: true, items }, 200, cors);
    }

    /* ───── 会议 ───── */

    if (path === "/meetings/ws" && method === "GET") {
        const no = normalizeMeetingNo(url.searchParams.get("no") || "");
        if (!no) {
            throw new SocialError(400, "bad_request", "会议号不合法");
        }
        const item = await findMeetingByNo(env, no);
        if (!item) {
            throw new SocialError(404, "not_found", "会议不存在或已结束");
        }
        if (item.extra && item.extra.ended) {
            throw new SocialError(410, "ended", "会议已结束");
        }
        if (item.extra && item.extra.passwordHash) {
            const expected = await meetingJoinToken(env, item, no);
            if (url.searchParams.get("token") !== expected) {
                throw new SocialError(403, "wrong_password", "会议密码校验失败，请重新加入");
            }
        }
        if (!env.MEETINGS || typeof env.MEETINGS.idFromName !== "function") {
            throw new SocialError(503, "unavailable", "语音会议服务未配置");
        }
        const stub = env.MEETINGS.get(env.MEETINGS.idFromName(item.id));
        return await stub.fetch(request);
    }

    if (path === "/meetings" && method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        if (throttled(`meeting:${ip}`, 60 * 1000, 10)) {
            throw new SocialError(429, "too_many_requests", "创建会议太快了，稍后再试");
        }
        const viewer = await viewerOf(env, deps, request);
        const body = deps.plainObject(await deps.readJsonBody(request));
        const item = await handleCreateMeeting(env, deps, viewer, body);
        return deps.jsonResponse({ ok: true, item: itemSummary(item, { login: viewer.login, account: viewer.account, detail: true }) }, 201, cors);
    }

    const meetingEndMatch = /^\/meetings\/([^/]+)\/end$/.exec(path);
    if (meetingEndMatch && method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        const item = await findMeetingByNo(env, decodeURIComponent(meetingEndMatch[1]));
        if (!item) {
            throw new SocialError(404, "not_found", "会议不存在");
        }
        if (item.owner !== session.payload.sub && !deps.isPlatformAdmin(env, session.payload.sub)) {
            throw new SocialError(403, "forbidden", "只有发起人或站主可以结束会议");
        }
        item.extra = { ...(item.extra || {}), ended: true, endedAt: nowMs() };
        await saveItem(env, "meeting", item);
        await env.ACCOUNTS_KV.delete(meetingNoKey(String(item.extra.no || "").replace(/-/g, "")));
        return deps.jsonResponse({ ok: true, ended: item.id }, 200, cors);
    }

    const meetingJoinMatch = /^\/meetings\/([^/]+)\/join$/.exec(path);
    if (meetingJoinMatch && method === "POST") {
        const body = deps.plainObject(await deps.readJsonBody(request));
        const joined = await handleMeetingJoin(env, decodeURIComponent(meetingJoinMatch[1]), body);
        const item = joined.item;
        return deps.jsonResponse({
            ok: true,
            joinToken: joined.token,
            meeting: {
                id: item.id,
                title: item.title,
                no: item.extra.no,
                hostName: item.extra.hostName || item.ownerName || "",
                locked: Boolean(item.extra.passwordHash)
            }
        }, 200, cors);
    }

    const meetingMatch = /^\/meetings\/([^/]+)$/.exec(path);
    if (meetingMatch && method === "GET") {
        const item = await findMeetingByNo(env, decodeURIComponent(meetingMatch[1]));
        if (!item) {
            throw new SocialError(404, "not_found", "会议不存在或已结束");
        }
        const viewer = await viewerOf(env, deps, request);
        return deps.jsonResponse({
            ok: true,
            meeting: {
                id: item.id,
                title: item.title,
                no: item.extra.no,
                hostName: item.extra.hostName || item.ownerName || "",
                owner: item.owner,
                ownerName: item.ownerName || "",
                locked: Boolean(item.extra.passwordHash),
                ended: Boolean(item.extra.ended),
                at: item.at,
                time: item.time
            }
        }, 200, cors);
    }

    /* ───── 通用条目 ───── */

    const fileMatch = /^\/file\/([^/]+)$/.exec(path);
    if (fileMatch && method === "GET") {
        return await handleFileRequest(env, deps, request, decodeURIComponent(fileMatch[1]), cors);
    }

    const listMatch = /^\/kinds\/([^/]+)$/.exec(path);
    if (listMatch) {
        const kind = socialKind(decodeURIComponent(listMatch[1]));
        if (!kind) {
            throw new SocialError(404, "not_found", "内容类型不存在");
        }
        if (method === "GET") {
            const viewer = await viewerOf(env, deps, request);
            const result = await listItems(env, kind, {
                q: url.searchParams.get("q") || "",
                owner: url.searchParams.get("owner") || "",
                sort: url.searchParams.get("sort") || "",
                before: url.searchParams.get("before") || 0,
                limit: url.searchParams.get("limit") || 0,
                login: viewer.login,
                account: viewer.account,
                isAdmin: viewer.isAdmin
            });
            return deps.jsonResponse(result, 200, cors);
        }
        if (method === "POST") {
            const session = await deps.requireSession(request, env, cors);
            if (session.error) {
                return session.error;
            }
            if (throttled(`create:${ip}`, 60 * 1000, 20)) {
                throw new SocialError(429, "too_many_requests", "发布太频繁了，稍后再试");
            }
            const viewer = await viewerOf(env, deps, request);
            const body = deps.plainObject(await deps.readJsonBody(request));
            if (kind === "dynamic") {
                const item = await handleDynamicCreate(env, deps, viewer, body, base);
                return deps.jsonResponse({
                    ok: true,
                    item: itemSummary(item, { login: viewer.login, account: viewer.account, detail: true })
                }, 201, cors);
            }
            const item = await createDraft(env, deps, viewer, kind, body);
            return deps.jsonResponse(await detailView(env, item, viewer, deps), 201, cors);
        }
    }

    const commentLikeMatch = /^\/kinds\/dynamic\/([^/]+)\/comments\/([^/]+)\/like$/.exec(path);
    if (commentLikeMatch && method === "POST") {
        const dynamicItem = await readItem(env, "dynamic", socialItemId(decodeURIComponent(commentLikeMatch[1])));
        if (!dynamicItem) {
            throw new SocialError(404, "not_found", "动态不存在");
        }
        const commentViewer = await viewerOf(env, deps, request);
        return await handleDynamicCommentLike(
            env,
            deps,
            request,
            commentViewer,
            dynamicItem,
            decodeURIComponent(commentLikeMatch[2]),
            cors
        );
    }

    const itemMatch = /^\/kinds\/([^/]+)\/([^/]+?)(\/[a-z]+)?$/.exec(path);
    if (!itemMatch) {
        throw new SocialError(404, "not_found", "接口不存在");
    }
    const kind = socialKind(decodeURIComponent(itemMatch[1]));
    const id = socialItemId(decodeURIComponent(itemMatch[2]));
    const action = itemMatch[3] ? itemMatch[3].replace(/^\//, "") : "";
    if (!kind || !id) {
        throw new SocialError(404, "not_found", "内容不存在");
    }
    const item = await readItem(env, kind, id);
    if (!item || item.kind !== kind) {
        throw new SocialError(404, "not_found", "内容不存在");
    }
    const viewer = await viewerOf(env, deps, request);

    if (!canReadItem(item, viewer)) {
        throw new SocialError(404, "not_found", "内容不存在");
    }

    if (!action && method === "GET") {
        if (item.kind === "meeting" && item.extra && item.extra.ended) {
            return deps.jsonResponse({
                ok: false,
                error: "ended",
                message: "会议已结束",
                item: itemSummary(item, { login: viewer.login, account: viewer.account, isAdmin: viewer.isAdmin, detail: true })
            }, 410, cors);
        }
        item.views = (Number(item.views) || 0) + 1;
        await saveItem(env, kind, item);
        return deps.jsonResponse(await detailView(env, item, viewer, deps), 200, cors);
    }

    if (!action && method === "PUT") {
        const owned = await loadOwned(env, kind, id, viewer, cors, deps);
        const body = deps.plainObject(await deps.readJsonBody(request));
        if (body.title !== undefined) {
            const title = text(body.title, 80);
            if (!title) {
                throw new SocialError(400, "bad_request", "标题不能为空");
            }
            owned.title = title;
        }
        if (body.description !== undefined) {
            owned.description = text(body.description, 500);
        }
        if (body.tags !== undefined) {
            owned.tags = normalizeTags(body.tags);
        }
        if (body.icon !== undefined) {
            owned.icon = normalizeIcon(body.icon);
        }
        if (paidKind(kind) && body.price !== undefined) {
            owned.price = fromCents(Math.round(Math.max(0, Math.min(PURCHASE_MAX_VTX, Number(body.price) || 0)) * 100));
        }
        const extra = deps.plainObject(body.extra);
        if (kind === "midi") {
            if (extra.artist !== undefined) {
                owned.extra.artist = text(extra.artist, 80);
            }
            if (extra.musicId !== undefined) {
                const musicId = socialItemId(extra.musicId);
                if (musicId) {
                    const music = await readItem(env, "music", musicId);
                    if (!music) {
                        throw new SocialError(404, "not_found", "要关联的音乐不存在");
                    }
                    await linkMidiToMusic(env, owned, music);
                }
            }
        } else if (kind === "music") {
            if (extra.artist !== undefined) {
                owned.extra.artist = text(extra.artist, 80);
            }
            if (extra.album !== undefined) {
                owned.extra.album = text(extra.album, 80);
            }
            if (extra.duration !== undefined) {
                owned.extra.durationSeconds = musicDuration(extra.duration);
            }
            if (extra.midiId !== undefined) {
                const midiId = socialItemId(extra.midiId);
                if (midiId) {
                    const midi = await readItem(env, "midi", midiId);
                    if (!midi) {
                        throw new SocialError(404, "not_found", "要关联的 MIDI 不存在");
                    }
                    await linkMidiToMusic(env, midi, owned);
                }
            }
        } else if (kind === "scratch") {
            if (extra.instructions !== undefined) {
                owned.extra.instructions = text(extra.instructions, 300);
            }
            if (extra.project !== undefined) {
                const project = normalizeProject(extra.project);
                if (!project) {
                    throw new SocialError(400, "bad_request", "作品数据不合法");
                }
                if (scratchProjectSize(project) > 256 * 1024) {
                    throw new SocialError(413, "too_large", "作品数据不能超过 256 KB");
                }
                owned.extra.project = project;
                owned.extra.engine = "xr";
                owned.ready = true;
            }
        } else if (kind === "style") {
            if (extra.version !== undefined) {
                owned.extra.version = text(extra.version, 20);
            }
        } else if (kind === "cpp") {
            if (extra.compiler !== undefined) {
                owned.extra.compiler = text(extra.compiler, 40);
            }
        } else if (kind === "meeting") {
            if (extra.title !== undefined) {
                owned.title = text(extra.title, 60);
            }
        }
        await saveItem(env, kind, owned);
        return deps.jsonResponse(await detailView(env, owned, viewer, deps), 200, cors);
    }

    if (!action && method === "DELETE") {
        const owned = await loadOwned(env, kind, id, viewer, cors, deps);
        if (kind === "meeting" && owned.extra && owned.extra.no) {
            await env.ACCOUNTS_KV.delete(meetingNoKey(String(owned.extra.no).replace(/-/g, "")));
        }
        await removeItem(env, kind, owned.id);
        return deps.jsonResponse({ ok: true, removed: owned.id }, 200, cors);
    }

    if (action === "file" && method === "PUT") {
        const owned = await loadOwned(env, kind, id, viewer, cors, deps);
        if (!["midi", "music", "scratch", "style"].includes(kind)) {
            throw new SocialError(400, "bad_request", "这种内容请使用项目文件上传");
        }
        const saved = await storePrimaryFile(env, deps, viewer, kind, owned, request);
        return deps.jsonResponse(await detailView(env, saved, viewer, deps), 200, cors);
    }

    if (action === "files") {
        if (kind !== "cpp") {
            throw new SocialError(404, "not_found", "接口不存在");
        }
        if (method === "PUT") {
            const owned = await loadOwned(env, kind, id, viewer, cors, deps);
            const body = deps.plainObject(await deps.readJsonBody(request));
            const saved = await storeCppFiles(env, owned, body);
            return deps.jsonResponse(await detailView(env, saved, viewer, deps), 200, cors);
        }
        if (method === "GET") {
            if (!canAccessFile(item, viewer)) {
                throw new SocialError(403, "forbidden", "需要先购买这个作品");
            }
            const stored = await env.ACCOUNTS_KV.get(cppFilesKey(item.id), "json");
            const files = Array.isArray(stored)
                ? stored.map((entry) => ({ name: entry.name, size: entry.size, text: entry.text }))
                : [];
            return deps.jsonResponse({ ok: true, files }, 200, cors);
        }
    }

    if (action === "publish" && method === "POST") {
        const owned = await loadOwned(env, kind, id, viewer, cors, deps);
        if (!owned.ready) {
            throw new SocialError(400, "not_ready", "文件还没有上传完成");
        }
        owned.published = true;
        await saveItem(env, kind, owned);
        return deps.jsonResponse({ ok: true, item: itemSummary(owned, { login: viewer.login, account: viewer.account, detail: true }) }, 200, cors);
    }

    if (action === "view" && method === "POST") {
        item.views = (Number(item.views) || 0) + 1;
        await saveItem(env, kind, item);
        return deps.jsonResponse({ ok: true, views: item.views }, 200, cors);
    }

    if (action === "like" && method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        const likes = Array.isArray(item.likes) ? item.likes : [];
        const index = likes.indexOf(session.payload.sub);
        if (index >= 0) {
            likes.splice(index, 1);
        } else {
            likes.push(session.payload.sub);
        }
        item.likes = likes.slice(0, SOCIAL_LIMITS.likes);
        await saveItem(env, kind, item);
        return deps.jsonResponse({
            ok: true,
            liked: item.likes.includes(session.payload.sub),
            likes: (Number(item.baseLikes) || 0) + item.likes.length
        }, 200, cors);
    }

    if (action === "purchase" && method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        if (throttled(`buy:${ip}`, 60 * 1000, 10)) {
            throw new SocialError(429, "too_many_requests", "操作太快了，稍后再试");
        }
        const fresh = await viewerOf(env, deps, request);
        const body = deps.plainObject(await deps.readJsonBody(request));
        const result = await handlePurchase(env, deps, fresh, item, body);
        const refreshed = await readItem(env, kind, id);
        return deps.jsonResponse({
            ok: true,
            trade: result.trade,
            price: result.price,
            item: itemSummary(refreshed || item, { login: fresh.login, account: fresh.account, detail: true })
        }, 200, cors);
    }

    if (kind === "dynamic" && action === "comments") {
        return await handleDynamicComments(env, deps, request, viewer, item, cors);
    }

    if (kind === "dynamic" && action === "repost" && method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) {
            return session.error;
        }
        const body = deps.plainObject(await deps.readJsonBody(request));
        const viewer2 = await viewerOf(env, deps, request);
        const card = cardForItem(item, base);
        const content = text(body.text, 500) || `转发了 ${item.ownerName || item.owner} 的动态`;
        const newItem = {
            ...await handleDynamicCreate(env, deps, viewer2, {
                text: content,
                cardId: "",
                tags: []
            }, base),
            title: content.slice(0, 40)
        };
        newItem.extra.card = card;
        newItem.extra.repostOf = item.id;
        await saveItem(env, "dynamic", newItem);
        item.extra = item.extra && typeof item.extra === "object" ? item.extra : {};
        item.extra.repostCount = (Number(item.extra.repostCount) || 0) + 1;
        await saveItem(env, "dynamic", item);
        return deps.jsonResponse({
            ok: true,
            item: itemSummary(newItem, { login: viewer2.login, account: viewer2.account, detail: true })
        }, 201, cors);
    }

    throw new SocialError(404, "not_found", "接口不存在");
}

export async function routeSocial(request, env, cors, deps) {
    try {
        return await handleRoute(request, env, cors, deps);
    } catch (error) {
        if (error instanceof SocialError) {
            return deps.jsonResponse({ error: error.code, message: error.message }, error.status, cors);
        }
        throw error;
    }
}

export { resolveShareUrl, resolveTextCard, cardForItem, socialBase, SOCIAL_VERSION };
