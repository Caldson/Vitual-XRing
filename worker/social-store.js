/*
 * Vitual XRing 3.1.0：分享生态的存储层。
 *
 * 七种内容（MIDI / 音乐 / Scratch 作品 / 会议 / CSS 样式包 / C++ 作品 / 动态）
 * 共用一套前缀很浅的 KV 结构，方便互相引用、互相识别：
 *
 *   social:index:<kind>                最新 500 条的 id 列表
 *   social:item:<kind>:<id>            单个条目的 JSON
 *   social:file:<id>                   主文件（.mid / 音频 / .sb3 / .css）
 *   social:cppfiles:<id>               C++ 项目的文本文件数组
 *   social:comments:<id>               动态的评论（最多 300 条）
 *   social:card:<id>                   用户自定义分享卡片
 *   social:meetingno:<9 位数字>        会议号 → 条目 id
 *
 * 所有写操作都尽量做成“读改写单个条目”，避免整库覆盖；购买记录放在账户的
 * library 数组里，跟余额扣款在同一次 commitAccounts 中完成。
 */

import { analyzeMidi, isMidiName, pitchSimilarity } from "./social-midi.js";

export const SOCIAL_VERSION = "3.1.0";
export const SOCIAL_KINDS = ["midi", "music", "scratch", "meeting", "style", "cpp", "dynamic"];
export const DEFAULT_SITE_ORIGIN = "https://xsmmc.caldson.us.ci";

const INDEX_LIMIT = 500;
const LIST_LIMIT = 60;
const DYNAMIC_IMAGE_LIMIT = 9;
const DYNAMIC_TEXT_MAX = 2000;
const COMMENT_MAX = 500;
const COMMENT_KEEP = 300;
const LIKES_LIMIT = 5000;
const SHARE_NAME_MAX = 40;
const SHARE_DESCRIPTION_MAX = 500;
const SHARE_ICON_MAX = 300;
const MIDI_MAX_BYTES = 2 * 1024 * 1024;
const MUSIC_MAX_BYTES = 20 * 1024 * 1024;
const SCRATCH_MAX_BYTES = 24 * 1024 * 1024;
const STYLE_MAX_BYTES = 512 * 1024;
const CPP_TOTAL_MAX = 2 * 1024 * 1024;
const CPP_FILE_MAX = 400 * 1024;
const CPP_FILE_COUNT = 30;
const ITEM_ID_PATTERN = /^(midi|mus|scr|meet|sty|cpp|dyn|shr)_[A-Za-z0-9_-]{4,40}$/;
const MEETING_NO_PATTERN = /^\d{9}$/;
const CARD_KIND_META = {
    midi: { icon: "🎼", label: "Vimidi", action: "查看 MIDI", page: "vimidi.html" },
    music: { icon: "🎵", label: "VMusic", action: "在 VMusic 听", page: "vmusic.html" },
    scratch: { icon: "🐱", label: "Viratch", action: "运行作品", page: "viratch.html" },
    meeting: { icon: "🎙️", label: "AUDIV", action: "加入会议", page: "audiv.html" },
    style: { icon: "🎨", label: "ViStyle", action: "查看样式包", page: "vistyle.html" },
    cpp: { icon: "💻", label: "VClang", action: "查看 C++ 作品", page: "vclang.html" },
    dynamic: { icon: "📝", label: "Vitx 动态", action: "查看动态", page: "vitx-dynamic.html" },
    link: { icon: "🔗", label: "分享链接", action: "打开链接", page: "" }
};
const PREFIX = {
    midi: "midi",
    music: "mus",
    scratch: "scr",
    meeting: "meet",
    style: "sty",
    cpp: "cpp",
    dynamic: "dyn",
    link: "shr"
};

export class SocialError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function socialNow() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const date = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} `
        + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function socialBase(env, fallback = DEFAULT_SITE_ORIGIN) {
    const configured = String((env && env.PUBLIC_BASE) || "").trim();
    const raw = configured || fallback || DEFAULT_SITE_ORIGIN;
    try {
        return new URL(raw).href.replace(/\/+$/, "");
    } catch (error) {
        return DEFAULT_SITE_ORIGIN;
    }
}

export function socialId(prefix) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${PREFIX[prefix] || prefix}_${token}`;
}

export function socialItemId(value) {
    const text = String(value || "");
    return ITEM_ID_PATTERN.test(text) ? text : "";
}

export function socialKind(value) {
    const kind = String(value || "").toLowerCase();
    return SOCIAL_KINDS.includes(kind) ? kind : "";
}

export function indexKey(kind) {
    return `social:index:${kind}`;
}

export function itemKey(kind, id) {
    return `social:item:${kind}:${id}`;
}

export function fileKey(id) {
    return `social:file:${id}`;
}

export function cppFilesKey(id) {
    return `social:cppfiles:${id}`;
}

export function commentsKey(id) {
    return `social:comments:${id}`;
}

export function cardKey(id) {
    return `social:card:${id}`;
}

export function meetingNoKey(no) {
    return `social:meetingno:${no}`;
}

export async function readIndex(env, kind) {
    if (!env.ACCOUNTS_KV) {
        return [];
    }
    const stored = await env.ACCOUNTS_KV.get(indexKey(kind), "json");
    return Array.isArray(stored)
        ? stored.filter((id) => typeof id === "string" && socialItemId(id)).slice(0, INDEX_LIMIT)
        : [];
}

export async function writeIndex(env, kind, ids) {
    await env.ACCOUNTS_KV.put(indexKey(kind), JSON.stringify(ids.slice(0, INDEX_LIMIT)));
}

export async function readItem(env, kind, id) {
    if (!env.ACCOUNTS_KV || !socialKind(kind) || !socialItemId(id)) {
        return null;
    }
    const value = await env.ACCOUNTS_KV.get(itemKey(kind, id), "json");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export async function saveItem(env, kind, item) {
    await env.ACCOUNTS_KV.put(itemKey(kind, item.id), JSON.stringify(item));
}

export async function removeItem(env, kind, id) {
    const index = (await readIndex(env, kind)).filter((entry) => entry !== id);
    await writeIndex(env, kind, index);
    await env.ACCOUNTS_KV.delete(itemKey(kind, id));
    if (kind === "dynamic") {
        await env.ACCOUNTS_KV.delete(commentsKey(id));
    }
    if (kind === "cpp") {
        await env.ACCOUNTS_KV.delete(cppFilesKey(id));
    }
    if (kind !== "meeting") {
        await env.ACCOUNTS_KV.delete(fileKey(id));
    }
}

export function isPublished(item) {
    return Boolean(item && item.published !== false && item.ready !== false);
}

export function accountLibrary(account) {
    return Array.isArray(account && account.library) ? account.library : [];
}

export function ownsItem(item, login) {
    return Boolean(item && login && item.owner === login);
}

export function purchasedItem(account, id) {
    return accountLibrary(account).some((entry) => entry && entry.id === id);
}

export function itemPriceCents(item) {
    const value = Number(item && item.price);
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

export function priceText(cents) {
    return (Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2);
}

function countLikes(item) {
    return (Number(item && item.baseLikes) || 0)
        + (Array.isArray(item && item.likes) ? item.likes.length : 0);
}

function publicExtra(kind, item, detail) {
    const extra = item && item.extra && typeof item.extra === "object" ? item.extra : {};
    if (kind === "midi") {
        return {
            artist: extra.artist || "",
            durationSeconds: Number(extra.durationSeconds) || 0,
            bpm: Number(extra.bpm) || 0,
            noteCount: Number(extra.noteCount) || 0,
            musicId: extra.musicId || "",
            musicTitle: extra.musicTitle || "",
            recognizedBy: extra.recognizedBy || "",
            recognitionConfidence: Number(extra.recognitionConfidence) || 0
        };
    }
    if (kind === "music") {
        return {
            artist: extra.artist || "",
            album: extra.album || "",
            durationSeconds: Number(extra.durationSeconds) || 0,
            midiId: extra.midiId || "",
            midiTitle: extra.midiTitle || "",
            musicId: item.id
        };
    }
    if (kind === "scratch") {
        const output = {
            engine: extra.engine === "sb3" ? "sb3" : "xr",
            instructions: extra.instructions || ""
        };
        if (detail && output.engine === "xr") {
            output.project = extra.project && typeof extra.project === "object" ? extra.project : null;
        }
        return output;
    }
    if (kind === "meeting") {
        return {
            no: extra.no || "",
            hostName: extra.hostName || "",
            locked: Boolean(extra.passwordHash),
            ended: Boolean(extra.ended),
            maxPeers: 16
        };
    }
    if (kind === "style") {
        return {
            version: extra.version || "1.0.0",
            forbidden: Array.isArray(extra.forbidden) ? extra.forbidden : []
        };
    }
    if (kind === "cpp") {
        return {
            compiler: extra.compiler || "Dev-C++",
            devFile: extra.devFile || "",
            files: Array.isArray(extra.files)
                ? extra.files.slice(0, CPP_FILE_COUNT).map((file) => ({ name: String(file.name || ""), size: Number(file.size) || 0 }))
                : []
        };
    }
    if (kind === "dynamic") {
        return {
            images: Array.isArray(extra.images) ? extra.images.slice(0, DYNAMIC_IMAGE_LIMIT) : [],
            card: extra.card && typeof extra.card === "object" ? extra.card : null,
            text: extra.text || "",
            repostOf: extra.repostOf || "",
            repostCount: Number(extra.repostCount) || 0
        };
    }
    return {};
}

function fileView(item) {
    const file = item && item.file && typeof item.file === "object" ? item.file : null;
    if (!file || !file.name) {
        return null;
    }
    return {
        name: String(file.name || ""),
        type: String(file.type || "application/octet-stream"),
        size: Number(file.size) || 0
    };
}

export function itemSummary(item, options = {}) {
    if (!item) {
        return null;
    }
    const kind = item.kind;
    const login = options.login || "";
    const account = options.account || null;
    const isAdmin = Boolean(options.isAdmin);
    const mine = Boolean(login && item.owner === login);
    const purchased = Boolean(account && purchasedItem(account, item.id));
    const cents = itemPriceCents(item);
    const locked = cents > 0 && !mine && !purchased && !isAdmin;
    const liked = Boolean(login && Array.isArray(item.likes) && item.likes.includes(login));
    return {
        id: item.id,
        kind,
        title: item.title || "",
        description: item.description || "",
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string").slice(0, 8) : [],
        icon: item.icon || (CARD_KIND_META[kind] ? CARD_KIND_META[kind].icon : "🔗"),
        owner: item.owner || "",
        ownerName: item.ownerName || item.owner || "",
        price: priceText(cents),
        priceCents: cents,
        paid: cents > 0,
        purchased,
        locked,
        mine,
        published: item.published !== false,
        ready: item.ready !== false,
        views: Number(item.views) || 0,
        likes: countLikes(item),
        liked,
        comments: Number(item.commentCount) || 0,
        purchases: Number(item.purchases) || 0,
        at: Number(item.at) || 0,
        time: item.time || "",
        file: fileView(item),
        extra: publicExtra(kind, item, Boolean(options.detail))
    };
}

export async function listItems(env, kind, options = {}) {
    const ids = await readIndex(env, kind);
    const query = String(options.q || "").trim().toLowerCase();
    const owner = String(options.owner || "").trim();
    const login = options.login || "";
    const isAdmin = Boolean(options.isAdmin);
    const limit = Math.max(1, Math.min(LIST_LIMIT, Number(options.limit) || LIST_LIMIT));
    const before = Number(options.before) || 0;
    const list = [];

    for (const id of ids) {
        if (list.length >= limit + 1) {
            break;
        }
        const item = await readItem(env, kind, id);
        if (!item || item.kind !== kind) {
            continue;
        }
        const mine = Boolean(login && item.owner === login);
        if (!isPublished(item) && !mine && !isAdmin) {
            continue;
        }
        if (owner && item.owner !== owner) {
            continue;
        }
        if (before && Number(item.at) >= before) {
            continue;
        }
        if (query) {
            const haystack = `${item.title || ""} ${item.description || ""} ${(item.tags || []).join(" ")} ${item.ownerName || ""} ${item.owner || ""}`
                .toLowerCase();
            if (!haystack.includes(query)) {
                continue;
            }
        }
        list.push(item);
        if (list.length > limit) {
            break;
        }
    }

    const hasMore = list.length > limit;
    const visible = list.slice(0, limit);
    const items = visible.map((item) => itemSummary(item, {
        login,
        account: options.account,
        isAdmin,
        detail: false
    }));

    if (options.sort === "hot") {
        items.sort((left, right) => right.views - left.views || right.likes - left.likes);
    }

    return {
        ok: true,
        kind,
        count: items.length,
        hasMore,
        items
    };
}

export async function addToIndex(env, kind, id) {
    const index = (await readIndex(env, kind)).filter((entry) => entry !== id);
    index.unshift(id);
    await writeIndex(env, kind, index);
}

export function normalizeIcon(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) {
        return "";
    }
    if (/^https?:\/\//i.test(text)) {
        try {
            const url = new URL(text);
            return url.href.slice(0, SHARE_ICON_MAX);
        } catch (error) {
            return "";
        }
    }
    return Array.from(text).slice(0, 8).join("");
}

export function normalizeTags(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set();
    const tags = [];
    for (const value of raw) {
        const tag = String(value || "").trim().slice(0, 16);
        if (tag && !seen.has(tag)) {
            seen.add(tag);
            tags.push(tag);
        }
        if (tags.length >= 8) {
            break;
        }
    }
    return tags;
}

export function normalizeHttpUrl(raw, options = {}) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) {
        return "";
    }
    let candidate = text;
    if (candidate.startsWith("//")) {
        candidate = `https:${candidate}`;
    }
    try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return "";
        }
        return url.href.slice(0, 1000);
    } catch (error) {
        return "";
    }
}

export function normalizeImages(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const images = [];
    for (const value of raw) {
        const url = normalizeHttpUrl(value);
        if (url && !images.includes(url)) {
            images.push(url);
        }
        if (images.length >= DYNAMIC_IMAGE_LIMIT) {
            break;
        }
    }
    return images;
}

/* ───────── 卡片 ───────── */

export function cardForItem(item, base) {
    if (!item || !isPublished(item)) {
        return null;
    }
    const kind = item.kind;
    const meta = CARD_KIND_META[kind] || CARD_KIND_META.link;
    if (kind === "meeting" && item.extra && item.extra.ended) {
        return null;
    }
    const extra = item.extra && typeof item.extra === "object" ? item.extra : {};
    let title = item.title || meta.label;
    let description = item.description || "";
    const cardMeta = {};

    if (kind === "midi") {
        const musicTitle = extra.musicTitle || "";
        description = musicTitle
            ? `已识别为《${musicTitle}》${extra.artist ? ` · ${extra.artist}` : ""}`
            : `${extra.artist ? `${extra.artist} · ` : ""}MIDI 文件${description ? ` · ${description}` : ""}`;
        cardMeta.musicId = extra.musicId || "";
        cardMeta.musicTitle = musicTitle;
        cardMeta.durationSeconds = Number(extra.durationSeconds) || 0;
    } else if (kind === "music") {
        const artist = extra.artist || "";
        description = `${artist}${extra.album ? ` · ${extra.album}` : ""}${description ? ` · ${description}` : ""}`;
        cardMeta.midiId = extra.midiId || "";
        cardMeta.midiTitle = extra.midiTitle || "";
        cardMeta.durationSeconds = Number(extra.durationSeconds) || 0;
    } else if (kind === "scratch") {
        description = `Scratch 作品 · ${extra.engine === "sb3" ? "可在线运行" : "站内创作" }${description ? ` · ${description}` : ""}`;
    } else if (kind === "meeting") {
        description = `会议号 ${extra.no || ""} · 发起人 ${extra.hostName || item.ownerName || ""}`;
        cardMeta.no = extra.no || "";
        cardMeta.locked = Boolean(extra.passwordHash);
        title = item.title || `${item.ownerName || item.owner || ""} 的会议`;
    } else if (kind === "style") {
        const cents = itemPriceCents(item);
        description = `CSS 样式包 · ${cents > 0 ? `${priceText(cents)} VTX` : "免费"}${description ? ` · ${description}` : ""}`;
        cardMeta.price = priceText(cents);
    } else if (kind === "cpp") {
        const cents = itemPriceCents(item);
        const fileCount = Array.isArray(extra.files) ? extra.files.length : 0;
        description = `C++ 项目 · ${fileCount} 个文件${cents > 0 ? ` · ${priceText(cents)} VTX` : " · 免费"}${description ? ` · ${description}` : ""}`;
        cardMeta.price = priceText(cents);
    } else if (kind === "dynamic") {
        const text = String(extra.text || "").replace(/\s+/g, " ").trim();
        title = item.title || (text ? text.slice(0, 28) : "动态");
        description = text.length > 80 ? `${text.slice(0, 80)}…` : text;
        cardMeta.repostOf = extra.repostOf || "";
    }

    if (description.length > 160) {
        description = `${description.slice(0, 160)}…`;
    }

    const url = kind === "link"
        ? item.url
        : `${base}/${meta.page}?id=${encodeURIComponent(item.id)}`;

    return {
        id: item.id,
        source: "auto",
        kind,
        targetId: item.id,
        title: String(title).slice(0, 80),
        icon: item.icon || meta.icon,
        description,
        url,
        actionLabel: meta.action,
        site: meta.label,
        meta: cardMeta,
        at: Number(item.at) || 0
    };
}

export async function readCard(env, id) {
    if (!env.ACCOUNTS_KV || !socialItemId(id)) {
        return null;
    }
    const value = await env.ACCOUNTS_KV.get(cardKey(id), "json");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function cardView(card, base) {
    if (!card) {
        return null;
    }
    const target = normalizeHttpUrl(card.target || card.url || "");
    const meta = CARD_KIND_META[card.kind] || CARD_KIND_META.link;
    return {
        id: card.id,
        source: "custom",
        kind: "link",
        targetId: card.id,
        title: String(card.title || "分享链接").slice(0, 80),
        icon: normalizeIcon(card.icon) || "🔗",
        description: String(card.description || "").slice(0, 500),
        url: `${base}/share.html?id=${encodeURIComponent(card.id)}`,
        target,
        actionLabel: "打开链接",
        site: target ? new URL(target).host : meta.label,
        meta: { target },
        at: Number(card.at) || 0
    };
}

export async function createCustomCard(env, base, payload, owner) {
    const title = String(payload.title || payload.name || "").trim();
    const target = normalizeHttpUrl(payload.target || payload.url || "");
    const description = String(payload.description || payload.desc || "").trim();
    const icon = normalizeIcon(payload.icon);

    if (!title || title.length > SHARE_NAME_MAX) {
        throw new SocialError(400, "bad_request", `名称需要 1-${SHARE_NAME_MAX} 个字`);
    }
    if (!target) {
        throw new SocialError(400, "bad_request", "链接必须是 http:// 或 https:// 地址");
    }
    if (description.length > SHARE_DESCRIPTION_MAX) {
        throw new SocialError(400, "bad_request", `简介最多 ${SHARE_DESCRIPTION_MAX} 个字`);
    }

    const card = {
        id: socialId("link"),
        title,
        icon,
        description,
        target,
        owner,
        at: Date.now(),
        time: socialNow()
    };
    await env.ACCOUNTS_KV.put(cardKey(card.id), JSON.stringify(card));
    return cardView(card, base);
}

/* ───────── 链接识别 ───────── */

const SHARE_PAGE_PATTERN = /(?:https?:\/\/[^\s<>"'）)】]+|(?:\.{0,2}\/)?(?:vimidi|vmusic|viratch|audiv|vistyle|vclang|vitx-dynamic|vitxvideo|share)\.html(?:\?[^\s<>"'）)】]*)?)/i;

export function extractShareUrl(text) {
    const match = SHARE_PAGE_PATTERN.exec(String(text || ""));
    return match ? match[0] : "";
}

function absoluteTarget(raw, base) {
    let text = String(raw || "").trim();
    if (!text) {
        return null;
    }
    if (text.startsWith("//")) {
        text = `https:${text}`;
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
        text = new URL(text, `${base}/`).href;
    }
    try {
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }
        return url;
    } catch (error) {
        return null;
    }
}

export function normalizeMeetingNo(raw) {
    const digits = String(raw || "").replace(/[^0-9]/g, "");
    if (digits.length !== 9) {
        return "";
    }
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`;
}

export async function findMeetingByNo(env, no) {
    const normalized = normalizeMeetingNo(no);
    const digits = normalized.replace(/-/g, "");
    if (!MEETING_NO_PATTERN.test(digits) || !env.ACCOUNTS_KV) {
        return null;
    }
    const id = await env.ACCOUNTS_KV.get(meetingNoKey(digits));
    if (!id) {
        return null;
    }
    return await readItem(env, "meeting", String(id));
}

export async function resolveShareUrl(env, raw, base = DEFAULT_SITE_ORIGIN) {
    const url = absoluteTarget(raw, base);
    if (!url) {
        return null;
    }
    const file = url.pathname.split("/").pop().toLowerCase();
    const params = url.searchParams;

    if (file === "share.html") {
        const card = await readCard(env, params.get("id") || "");
        return cardView(card, base);
    }

    let kind = "";
    let id = "";
    if (file === "vimidi.html") {
        kind = "midi";
        id = params.get("id") || params.get("midi") || "";
    } else if (file === "vmusic.html") {
        kind = "music";
        id = params.get("id") || params.get("music") || "";
    } else if (file === "viratch.html") {
        kind = "scratch";
        id = params.get("id") || params.get("project") || "";
    } else if (file === "vistyle.html") {
        kind = "style";
        id = params.get("id") || params.get("style") || "";
    } else if (file === "vclang.html") {
        kind = "cpp";
        id = params.get("id") || params.get("project") || "";
    } else if (file === "vitx-dynamic.html") {
        kind = "dynamic";
        id = params.get("id") || params.get("dynamic") || "";
    } else if (file === "vitxvideo.html") {
        kind = "dynamic";
        id = params.get("dynamic") || "";
    } else if (file === "audiv.html") {
        kind = "meeting";
        const meeting = params.get("meeting") || params.get("no") || "";
        if (meeting) {
            const item = await findMeetingByNo(env, meeting);
            return item ? cardForItem(item, base) : null;
        }
        id = params.get("id") || "";
    }

    if (!kind || !id) {
        return null;
    }
    const item = await readItem(env, kind, id);
    if (!item || item.kind !== kind || !isPublished(item)) {
        return null;
    }
    return cardForItem(item, base);
}

export async function resolveTextCard(env, text, base = DEFAULT_SITE_ORIGIN) {
    const raw = extractShareUrl(text).replace(/[.,;:!?，。；：！？、]+$/, "");
    if (!raw) {
        return null;
    }
    try {
        return await resolveShareUrl(env, raw, base);
    } catch (error) {
        return null;
    }
}

/* ───────── MIDI 识别 ───────── */

export async function matchMusicForMidi(env, analysis) {
    if (!analysis || !env.ACCOUNTS_KV) {
        return null;
    }
    const ids = await readIndex(env, "music");
    let fuzzy = null;
    for (const id of ids.slice(0, 80)) {
        const music = await readItem(env, "music", id);
        if (!music || !isPublished(music)) {
            continue;
        }
        const extra = music.extra && typeof music.extra === "object" ? music.extra : {};
        if (extra.midiSignature && analysis.signature && extra.midiSignature === analysis.signature) {
            return {
                item: music,
                confidence: 1,
                exact: true
            };
        }
        if (Array.isArray(extra.pitchProfile) && Array.isArray(analysis.pitchProfile)) {
            const score = pitchSimilarity(extra.pitchProfile, analysis.pitchProfile);
            const duration = Number(extra.durationSeconds) || 0;
            const ratio = duration > 0 && analysis.durationSeconds > 0
                ? Math.min(duration, analysis.durationSeconds) / Math.max(duration, analysis.durationSeconds)
                : 0;
            const confidence = score * 0.85 + ratio * 0.15;
            if (score >= 0.9 && (!fuzzy || confidence > fuzzy.confidence)) {
                fuzzy = { item: music, confidence: Math.round(confidence * 1000) / 1000, exact: false };
            }
        }
    }
    return fuzzy;
}

export async function analyzeMidiFile(buffer, fileName) {
    const analysis = analyzeMidi(buffer, fileName);
    if (!analysis.noteCount) {
        throw new SocialError(400, "bad_request", "这个 MIDI 里没有音符，换一个文件试试");
    }
    return analysis;
}

export function midiNameOk(name) {
    return isMidiName(name);
}

export const SOCIAL_LIMITS = {
    midi: MIDI_MAX_BYTES,
    music: MUSIC_MAX_BYTES,
    scratch: SCRATCH_MAX_BYTES,
    style: STYLE_MAX_BYTES,
    cppTotal: CPP_TOTAL_MAX,
    cppFile: CPP_FILE_MAX,
    cppCount: CPP_FILE_COUNT,
    dynamicText: DYNAMIC_TEXT_MAX,
    comment: COMMENT_MAX,
    commentKeep: COMMENT_KEEP,
    likes: LIKES_LIMIT,
    dynamicImages: DYNAMIC_IMAGE_LIMIT,
    list: LIST_LIMIT
};

export { CARD_KIND_META, CPP_FILE_COUNT, DYNAMIC_TEXT_MAX, COMMENT_MAX, COMMENT_KEEP, SHARE_DESCRIPTION_MAX };
