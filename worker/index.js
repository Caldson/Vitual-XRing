/**
 * Vitual XRing 账户 API
 *
 * 8.0 起账户数据默认存放在 Workers KV（ACCOUNTS_KV）里，不再依赖公开的 account.json：
 *   首次读取时如果 KV 是空的，会自动把仓库里的 account.json 导入 KV，
 *   然后（MIGRATE_DELETE_REPO_FILE 未关闭时）删除仓库中的那份公开文件。
 *   未绑定 ACCOUNTS_KV 时退回 7.0 的行为（直接读写仓库里的 account.json）。
 *
 * 9.0 新增完整聊天室：聊天记录同样存在 KV，实时消息由 ChatHub（Durable Object）
 * 通过 WebSocket 推送；图片 / 文件在 KV 里只保留 20 分钟。
 *
 * 9.1 把「解散群聊」做成只读保留：群主 / 站主解散后群聊标记 dissolved，
 * 历史消息仍然可以查看，但不能再发消息、改名、加人、改公告；
 * 成员可以自己从会话列表删除这个只读会话。
 *
 * 环境变量（wrangler.toml 的 [vars]）：
 *   REPO / BRANCH / PATH        迁移数据源（旧的 account.json）
 *   ALLOWED_ORIGINS             允许跨域的站点，逗号分隔，"*" 为任意
 *   TOKEN_TTL_SECONDS           登录 token 有效期（秒）
 *   CACHE_TTL_SECONDS           旧模式（GitHub）下 account.json 的内存缓存时间（秒）
 *   ADMIN_ACCOUNT               拥有管理权限的登录名，默认 Kitawaga
 *   MIGRATE_DELETE_REPO_FILE    迁移后是否删除仓库里的 account.json，默认 true
 *   MIRROR_TO_GITHUB            是否把 KV 数据镜像回仓库 account.json，默认 false
 *   CHAT_ENABLED                是否开放聊天室接口，9.0 起默认 true
 *
 * 绑定：
 *   ACCOUNTS_KV                 Workers KV：账户 + 聊天记录 + 聊天媒体
 *   CHAT                        Durable Object（class_name = ChatHub）：WebSocket 实时推送
 *
 * 机密（wrangler secret put）：
 *   GITHUB_TOKEN                迁移 / 镜像时需要仓库 Contents 读写权限
 *   SIGNING_SECRET              签发 token 的 HMAC 密钥（必填）
 */

const VERSION = "9.1.0";
const DEFAULT_REPO = "Caldson/Vitual-XRing";
const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "account.json";
const DEFAULT_TTL = 43200;
const DEFAULT_CACHE_TTL = 20;
const DEFAULT_ADMIN_ACCOUNT = "Kitawaga";
const STORE_KEY = "accounts";
const MIGRATED_KEY = "migrated-from-github";
const ADMIN_LOG_KEY = "admin-log";
const ADMIN_LOG_LIMIT = 200;
const MEMORY_TTL_MS = 5 * 1000;
const LOGIN_HISTORY_LIMIT = 20;
const CHAT_VERSION = "9.1";
const CHAT_MESSAGE_LIMIT = 300;
const MAX_CHAT_TEXT_LENGTH = 500;
const CHAT_WINDOW_MS = 60 * 1000;
const CHAT_MAX_ATTEMPTS = 30;
const CHAT_MEDIA_WINDOW_MS = 60 * 1000;
const CHAT_MEDIA_MAX_ATTEMPTS = 12;
const CHAT_TYPING_WINDOW_MS = 60 * 1000;
const CHAT_TYPING_MAX_ATTEMPTS = 120;
const CHAT_RECALL_WINDOW_MS = 2 * 60 * 1000;
const CHAT_MEDIA_TTL_SECONDS = 20 * 60;
const CHAT_MEDIA_MAX_BYTES = 4 * 1024 * 1024;
const CHAT_PAGE_LIMIT = 50;
const CHAT_SEARCH_LIMIT = 50;
const CHAT_GROUP_MAX_MEMBERS = 200;
const CHAT_GROUP_NAME_MAX = 24;
const CHAT_ANNOUNCEMENT_MAX = 1000;
const CHAT_ALIAS_MAX = 20;
const CHAT_NOTE_MAX = 100;
const CHAT_INDEX_LIMIT = 2000;
const CHAT_CONVERSATION_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const CHAT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const CHAT_MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const CHAT_PUBLIC_GROUPS = [
    { id: "general", name: "大厅", description: "所有人都可以发言的公共频道" },
    { id: "trade", name: "交易", description: "VTX 交易与商店相关讨论" },
    { id: "help", name: "求助", description: "遇到问题可以在这里提问" }
];
const CHAT_INDEX_KEY = "chat:index";
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const WRITE_WINDOW_MS = 60 * 1000;
const WRITE_MAX_ATTEMPTS = 60;
const MAX_DATA_BYTES = 32 * 1024;
const MAX_KEYS_PER_WRITE = 20;
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const GAME_PATTERN = /^[A-Za-z0-9_.\-\u4e00-\u9fff ]{1,32}$/;
const MAX_GAMES = 20;
const RECEIPT_CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TRADE_WINDOW_MS = 60 * 1000;
const TRADE_MAX_ATTEMPTS = 20;
const REGISTER_WINDOW_MS = 60 * 1000;
const REGISTER_MAX_ATTEMPTS = 5;
const MAX_ACCOUNTS = 500;
const LOGIN_NAME_PATTERN = /^\S{2,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_USERNAME_LENGTH = 24;
const MAX_TRADE_CENTS = 100000000;
const MAX_PARTY_LENGTH = 40;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_TRADE_NAME_LENGTH = 20;

const loginAttempts = new Map();
const writeAttempts = new Map();
const tradeAttempts = new Map();
const registerAttempts = new Map();
const chatAttempts = new Map();
const chatMediaAttempts = new Map();
const chatTypingAttempts = new Map();
const adminAttempts = new Map();

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function encodeBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(text) {
    const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function decodeBase64Text(value) {
    const binary = atob(String(value || "").replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
}

function encodeBase64Text(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function encodeJson(value) {
    return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(text) {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(text)));
}

function timingSafeEqual(left, right) {
    const a = String(left ?? "");
    const b = String(right ?? "");
    let diff = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
    }
    return diff === 0;
}

async function hmac(secret, data) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return encodeBase64Url(new Uint8Array(signature));
}

async function signToken(payload, secret) {
    const body = encodeJson(payload);
    return `${body}.${await hmac(secret, body)}`;
}

async function verifyToken(token, secret) {
    const [body, signature] = String(token || "").split(".");
    if (!body || !signature || !secret) {
        return null;
    }

    const expected = await hmac(secret, body);
    if (!timingSafeEqual(signature, expected)) {
        return null;
    }

    try {
        const payload = decodeJson(body);
        if (!payload || typeof payload.sub !== "string" || !payload.exp) {
            return null;
        }
        if (payload.exp < Math.floor(Date.now() / 1000)) {
            return null;
        }
        return payload;
    } catch (error) {
        return null;
    }
}

function publicAccount(account) {
    const source = account && typeof account === "object" ? account : {};
    return {
        username: source.username || "",
        money: source.money || "0.00",
        trades: Array.isArray(source.trades) ? source.trades : [],
        data: source.data && typeof source.data === "object" && !Array.isArray(source.data) ? source.data : {}
    };
}

function loginHistoryOf(account) {
    const history = account && Array.isArray(account.loginHistory) ? account.loginHistory : [];
    return history.slice(-LOGIN_HISTORY_LIMIT);
}

// 本人可见：额外带登录位置记录
function selfAccount(account) {
    return { ...publicAccount(account), loginHistory: loginHistoryOf(account) };
}

// 管理员可见：带密码与收款码
function fullAccount(account) {
    return {
        ...selfAccount(account),
        password: String((account && account.password) || ""),
        receipt: account && account.receipt ? account.receipt : null
    };
}

function corsHeaders(env, request) {
    const configured = String(env.ALLOWED_ORIGINS || "*")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = configured.includes("*")
        ? "*"
        : (configured.includes(origin) ? origin : "");

    const headers = {
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,x-file-name",
        "access-control-max-age": "86400",
        "vary": "origin",
        "cache-control": "no-store"
    };

    if (allowOrigin) {
        headers["access-control-allow-origin"] = allowOrigin;
    }
    return headers;
}

function jsonResponse(data, status, headers) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...headers }
    });
}

function githubHeaders(env) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "vtx-api",
        "x-github-api-version": "2022-11-28"
    };
    if (env.GITHUB_TOKEN) {
        headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
    }
    return headers;
}

function repoConfig(env) {
    return {
        repo: env.REPO || DEFAULT_REPO,
        branch: env.BRANCH || DEFAULT_BRANCH,
        path: env.PATH || DEFAULT_PATH
    };
}

async function readAccountFile(env) {
    const { repo, branch, path } = repoConfig(env);

    if (env.GITHUB_TOKEN) {
        const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
        const response = await fetch(url, { headers: githubHeaders(env) });

        if (!response.ok) {
            throw new HttpError(502, "upstream_error", `读取账户数据失败（GitHub ${response.status}）`);
        }

        const file = await response.json();
        return { accounts: JSON.parse(decodeBase64Text(file.content)), sha: file.sha };
    }

    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
    const response = await fetch(rawUrl, { headers: { "user-agent": "vtx-api" } });

    if (!response.ok) {
        throw new HttpError(502, "upstream_error", `读取账户数据失败（HTTP ${response.status}）`);
    }

    return { accounts: await response.json(), sha: null };
}

async function writeAccountFile(env, accounts, sha, message) {
    if (!env.GITHUB_TOKEN) {
        throw new HttpError(503, "write_unavailable", "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法写入");
    }

    const { repo, branch, path } = repoConfig(env);
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
    const text = `${JSON.stringify(accounts, null, 4)}\n`;

    const response = await fetch(url, {
        method: "PUT",
        headers: { ...githubHeaders(env), "content-type": "application/json" },
        body: JSON.stringify({
            message,
            content: encodeBase64Text(text),
            sha,
            branch
        })
    });

    if (!response.ok) {
        const conflict = response.status === 409 || response.status === 422;
        throw new HttpError(
            conflict ? 409 : 502,
            conflict ? "conflict" : "upstream_error",
            `写入失败（GitHub ${response.status}）`
        );
    }
}

/**
 * 8.0：账户数据默认存进 Workers KV。
 *   - 有 ACCOUNTS_KV：KV 为准，读写都在 KV 完成（首次读会自动从仓库导入）
 *   - 没有 ACCOUNTS_KV：退回 7.0 的 GitHub account.json 读写方式
 */
function hasKv(env) {
    return Boolean(env.ACCOUNTS_KV && typeof env.ACCOUNTS_KV.get === "function");
}

function canWrite(env) {
    return hasKv(env) || Boolean(env.GITHUB_TOKEN);
}

const memoryStore = new Map();

function readMemory(env) {
    const entry = memoryStore.get(env);
    if (!entry || Date.now() - entry.at > MEMORY_TTL_MS) {
        return null;
    }
    return entry.accounts;
}

function writeMemory(env, accounts) {
    memoryStore.set(env, { at: Date.now(), accounts });
}

async function deleteAccountFileFromRepo(env, sha) {
    if (!env.GITHUB_TOKEN || !sha) {
        return false;
    }

    const { repo, branch, path } = repoConfig(env);
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;

    const response = await fetch(url, {
        method: "DELETE",
        headers: { ...githubHeaders(env), "content-type": "application/json" },
        body: JSON.stringify({
            message: "安全更新：账户数据迁移至 Workers KV",
            sha,
            branch
        })
    });

    return response.ok;
}

async function migrateFromGithub(env) {
    const { accounts, sha } = await readAccountFile(env);
    await env.ACCOUNTS_KV.put(STORE_KEY, JSON.stringify(accounts));
    writeMemory(env, accounts);

    if (env.MIGRATE_DELETE_REPO_FILE === "false") {
        return accounts;
    }

    try {
        const removed = await deleteAccountFileFromRepo(env, sha);
        if (removed) {
            await env.ACCOUNTS_KV.put(MIGRATED_KEY, shanghaiTimestamp());
        }
    } catch (error) {
        /* 删除失败不影响读取，下次读取还会再试 */
    }

    return accounts;
}

async function readKvAccounts(env) {
    const stored = await env.ACCOUNTS_KV.get(STORE_KEY, "json");

    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        writeMemory(env, stored);
        return stored;
    }

    return await migrateFromGithub(env);
}

async function mirrorToGithub(env, accounts) {
    if (env.MIRROR_TO_GITHUB !== "true" || !env.GITHUB_TOKEN) {
        return;
    }

    try {
        const { sha } = await readAccountFile(env);
        await writeAccountFile(env, accounts, sha, "镜像：Workers KV → account.json");
    } catch (error) {
        /* 镜像失败不影响 KV 写入 */
    }
}

function cacheKey() {
    return new Request("https://vtx-api.internal/account.json", { method: "GET" });
}

function hasCache() {
    return typeof caches !== "undefined" && Boolean(caches.default);
}

async function loadAccounts(env) {
    if (hasKv(env)) {
        const remembered = readMemory(env);
        if (remembered) {
            return remembered;
        }
        return await readKvAccounts(env);
    }

    const ttl = Number(env.CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL);

    if (hasCache() && ttl > 0) {
        const cached = await caches.default.match(cacheKey());
        if (cached) {
            return cached.json();
        }
    }

    const { accounts } = await readAccountFile(env);

    if (hasCache() && ttl > 0) {
        await caches.default.put(cacheKey(), new Response(JSON.stringify(accounts), {
            headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": `max-age=${ttl}`
            }
        }));
    }

    return accounts;
}

async function invalidateCache(env) {
    memoryStore.delete(env);

    if (hasCache()) {
        try {
            await caches.default.delete(cacheKey());
        } catch (error) {
            /* 忽略 */
        }
    }
}

let storeChain = Promise.resolve();

function withStoreLock(task) {
    const run = storeChain.then(task, task);
    storeChain = run.then(() => undefined, () => undefined);
    return run;
}

async function commitAccounts(env, mutate) {
    if (!canWrite(env)) {
        throw new HttpError(503, "write_unavailable", "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法写入");
    }

    if (hasKv(env)) {
        return await withStoreLock(async () => {
            const accounts = await readKvAccounts(env);
            mutate(accounts);
            await env.ACCOUNTS_KV.put(STORE_KEY, JSON.stringify(accounts));
            writeMemory(env, accounts);
            await mirrorToGithub(env, accounts);
            return accounts;
        });
    }

    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const { accounts, sha } = await readAccountFile(env);
        const message = mutate(accounts);

        try {
            await writeAccountFile(env, accounts, sha, message);
            await invalidateCache(env);
            return accounts;
        } catch (error) {
            if (error.code !== "conflict") {
                throw error;
            }
            lastError = error;
        }
    }

    throw lastError || new HttpError(409, "conflict", "写入冲突，请重试");
}

function clientIp(request) {
    return request.headers.get("cf-connecting-ip") || "unknown";
}

function normalizeGeo(raw) {
    const source = plainObject(raw);
    const entry = {};

    const latitude = Number(source.latitude);
    const longitude = Number(source.longitude);

    if (Number.isFinite(latitude) && Number.isFinite(longitude)
        && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
        entry.latitude = Number(latitude.toFixed(4));
        entry.longitude = Number(longitude.toFixed(4));
    }

    for (const [key, limit] of [["city", 40], ["region", 40], ["country", 40], ["isp", 60]]) {
        const text = String(source[key] == null ? "" : source[key]).replace(/\s+/g, " ").trim();
        if (text) {
            entry[key] = text.slice(0, limit);
        }
    }

    return entry;
}

function serverGeo(request) {
    const cf = request.cf;

    if (!cf) {
        return {};
    }

    const entry = {};
    const latitude = Number(cf.latitude);
    const longitude = Number(cf.longitude);

    if (Number.isFinite(latitude) && Number.isFinite(longitude)
        && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
        entry.latitude = Number(latitude.toFixed(4));
        entry.longitude = Number(longitude.toFixed(4));
    }

    for (const [key, value] of [["city", cf.city], ["region", cf.region], ["country", cf.country], ["isp", cf.asOrganization]]) {
        const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
        if (text) {
            entry[key] = text.slice(0, key === "isp" ? 60 : 40);
        }
    }

    return entry;
}

function loginLocationEntry(request, clientGeo) {
    const server = serverGeo(request);
    const client = normalizeGeo(clientGeo);
    const entry = {
        time: shanghaiTimestamp(),
        ip: clientIp(request),
        source: Object.keys(client).length ? "browser" : "worker"
    };

    const latitude = client.latitude === undefined ? server.latitude : client.latitude;
    const longitude = client.longitude === undefined ? server.longitude : client.longitude;

    if (latitude !== undefined && longitude !== undefined) {
        entry.latitude = latitude;
        entry.longitude = longitude;
    }

    for (const key of ["city", "region", "country", "isp"]) {
        const value = client[key] || server[key];
        if (value) {
            entry[key] = value;
        }
    }

    return entry;
}

async function recordLoginLocation(env, login, request, clientGeo) {
    const entry = loginLocationEntry(request, clientGeo);

    const accounts = await commitAccounts(env, (data) => {
        const account = data[login];

        if (!account) {
            throw new HttpError(404, "not_found", "账户不存在");
        }

        const history = Array.isArray(account.loginHistory) ? account.loginHistory : [];
        history.push(entry);
        account.loginHistory = history.slice(-LOGIN_HISTORY_LIMIT);

        return `登录记录：${login}${entry.ip ? ` ${entry.ip}` : ""}`;
    });

    return { entry, accounts };
}

function throttled(store, ip, windowMs, max) {
    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || now - entry.start > windowMs) {
        store.set(ip, { start: now, count: 1 });
        return false;
    }

    entry.count += 1;
    return entry.count > max;
}

function toCents(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? Math.round(value * 100) : null;
    }

    const text = String(value ?? "").trim().replace(/,/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
        return null;
    }
    return Math.round(Number(text) * 100);
}

function fromCents(cents) {
    return (cents / 100).toFixed(2);
}

function shanghaiDate() {
    const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return `${now.getUTCFullYear()}/${now.getUTCMonth() + 1}/${now.getUTCDate()}`;
}

function shanghaiTimestamp(ms = Date.now()) {
    const now = new Date(ms + 8 * 60 * 60 * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())} `
        + `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}

function randomCode(bytes = 16) {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return encodeBase64Url(buffer);
}

function siteOrigin(request, env) {
    const configured = String(env.PUBLIC_BASE || "").trim().replace(/\/+$/, "");
    return configured || new URL(request.url).origin;
}

function receiptCodeUrl(request, env, code) {
    return `${siteOrigin(request, env)}/API_VTXPAY.html?rc=${encodeURIComponent(code)}`;
}

function receiptView(request, env, login, account) {
    const receipt = plainObject(account.receipt);
    if (!receipt.id) {
        return { code: null, amount: null, createdAt: null, url: null };
    }
    return {
        code: String(receipt.id),
        amount: receipt.amount === null || receipt.amount === undefined ? null : String(receipt.amount),
        createdAt: receipt.createdAt || null,
        url: receiptCodeUrl(request, env, String(receipt.id))
    };
}

function findReceiptOwner(accounts, code) {
    for (const [login, account] of Object.entries(accounts)) {
        const receipt = plainObject(account && account.receipt);
        if (receipt.id && String(receipt.id) === code) {
            return { login, account };
        }
    }
    return null;
}

async function handleCreateReceiptCode(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (!canWrite(env)) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法生成收款码" }, 503, cors);
    }

    if (throttled(writeAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const raw = await readJsonBody(request);
    const body = plainObject(raw);
    const hasAmount = body.amount !== undefined && body.amount !== null && String(body.amount).trim() !== "";

    let amountCents = null;

    if (hasAmount) {
        amountCents = toCents(body.amount);
        if (amountCents === null || amountCents <= 0) {
            return jsonResponse({ error: "bad_request", message: "amount 必须是大于 0 的数字，最多两位小数" }, 400, cors);
        }
        if (amountCents > MAX_TRADE_CENTS) {
            return jsonResponse({ error: "bad_request", message: `单笔金额不能超过 ${fromCents(MAX_TRADE_CENTS)} VTX` }, 400, cors);
        }
    }

    let created = null;

    const accounts = await commitAccounts(env, (data) => {
        const account = data[login];

        if (!account) {
            throw new HttpError(404, "not_found", "账户不存在");
        }

        account.receipt = {
            id: randomCode(),
            amount: amountCents === null ? null : fromCents(amountCents),
            createdAt: shanghaiTimestamp()
        };
        created = account.receipt;

        return `生成收款码：${login}`;
    });

    const view = receiptView(request, env, login, accounts[login]);

    return jsonResponse({
        ok: true,
        login,
        payeeName: publicAccount(accounts[login]).username,
        ...view,
        url: view.url || receiptCodeUrl(request, env, created.id)
    }, 200, cors);
}

async function handleGetReceiptCode(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const account = accounts[login];

    if (!account) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    return jsonResponse({
        ok: true,
        login,
        payeeName: publicAccount(account).username,
        ...receiptView(request, env, login, account)
    }, 200, cors);
}

async function handleDeleteReceiptCode(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (!canWrite(env)) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法撤销收款码" }, 503, cors);
    }

    const login = session.payload.sub;

    const accounts = await commitAccounts(env, (data) => {
        const account = data[login];

        if (!account) {
            throw new HttpError(404, "not_found", "账户不存在");
        }

        const receipt = plainObject(account.receipt);
        if (!receipt.id) {
            throw new HttpError(404, "not_found", "当前没有有效的收款码");
        }

        delete account.receipt;
        return `撤销收款码：${login}`;
    });

    return jsonResponse({
        ok: true,
        login,
        removed: login,
        code: null,
        amount: null,
        createdAt: null,
        url: null,
        payeeName: publicAccount(accounts[login]).username
    }, 200, cors);
}

async function handleResolveReceiptCode(request, env, cors, code) {
    // 收款码要求「刷新/撤销后立即失效」，所以这里跳过内存缓存，直接读最新数据
    const accounts = hasKv(env)
        ? await readKvAccounts(env)
        : (await readAccountFile(env)).accounts;
    const found = findReceiptOwner(accounts, code);

    if (!found) {
        return jsonResponse({ error: "not_found", message: "收款码不存在或已失效" }, 404, cors);
    }

    const view = receiptView(request, env, found.login, found.account);

    return jsonResponse({
        ok: true,
        code: view.code,
        payee: found.login,
        payeeName: publicAccount(found.account).username,
        amount: view.amount,
        createdAt: view.createdAt,
        url: view.url
    }, 200, cors);
}

async function handlePayReceiptCode(request, env, cors, code) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (!canWrite(env)) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法付款" }, 503, cors);
    }

    if (throttled(tradeAttempts, clientIp(request), TRADE_WINDOW_MS, TRADE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "记账过于频繁，请稍后再试" }, 429, cors);
    }

    const payer = session.payload.sub;
    const raw = await readJsonBody(request);
    const body = plainObject(raw);

    const password = String(body.password ?? "");
    if (!password) {
        return jsonResponse({ error: "bad_request", message: "缺少 password：付款需要密码确认" }, 400, cors);
    }

    const description = String(body.description ?? "").trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `description 最长 ${MAX_DESCRIPTION_LENGTH} 个字符` }, 400, cors);
    }

    let payerTrade = null;
    let payeeInfo = null;

    const accounts = await commitAccounts(env, (data) => {
        const found = findReceiptOwner(data, code);

        if (!found) {
            throw new HttpError(404, "not_found", "收款码不存在或已失效");
        }

        const payeeAccount = found.account;

        if (found.login === payer) {
            throw new HttpError(400, "bad_request", "不能扫自己的收款码付款");
        }

        const payerAccount = data[payer];
        if (!payerAccount) {
            throw new HttpError(404, "not_found", "付款账户不存在");
        }

        if (!timingSafeEqual(String(payerAccount.password || ""), password)) {
            throw new HttpError(400, "invalid_password", "密码不正确，付款已取消");
        }

        const receipt = plainObject(payeeAccount.receipt);
        let amountCents = receipt.amount === null || receipt.amount === undefined ? null : toCents(receipt.amount);

        if (amountCents === null) {
            amountCents = toCents(body.amount);
            if (amountCents === null || amountCents <= 0) {
                throw new HttpError(400, "bad_request", "该收款码没有预设金额，请填写 amount");
            }
        }

        if (amountCents > MAX_TRADE_CENTS) {
            throw new HttpError(400, "bad_request", `单笔金额不能超过 ${fromCents(MAX_TRADE_CENTS)} VTX`);
        }

        const payerBalance = toCents(payerAccount.money) ?? 0;
        if (payerBalance < amountCents) {
            throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(payerBalance)} VTX`);
        }

        const payeeBalance = toCents(payeeAccount.money) ?? 0;
        const payerName = String(payerAccount.username || payer);
        const payeeName = String(payeeAccount.username || found.login);
        const price = fromCents(amountCents);
        const time = shanghaiTimestamp();

        payerTrade = {
            name: "付款",
            description,
            time,
            from: payerName,
            to: payeeName,
            price: `-${price}`
        };
        const payeeTrade = {
            name: "收款",
            description,
            time,
            from: payerName,
            to: payeeName,
            price: `+${price}`
        };

        payerAccount.trades = Array.isArray(payerAccount.trades) ? payerAccount.trades : [];
        payerAccount.trades.push(payerTrade);
        payerAccount.money = fromCents(payerBalance - amountCents);

        payeeAccount.trades = Array.isArray(payeeAccount.trades) ? payeeAccount.trades : [];
        payeeAccount.trades.push(payeeTrade);
        payeeAccount.money = fromCents(payeeBalance + amountCents);

        payeeInfo = { login: found.login, username: payeeName };

        return `收款码付款：${payerName} → ${payeeName} ${price} VTX`;
    });

    return jsonResponse({
        ok: true,
        login: payer,
        trade: payerTrade,
        payee: payeeInfo,
        account: publicAccount(accounts[payer]),
        payeeAccount: {
            login: payeeInfo ? payeeInfo.login : "",
            money: payeeInfo ? publicAccount(accounts[payeeInfo.login]).money : ""
        }
    }, 200, cors);
}

async function handleLogin(request, env, cors) {
    const ip = clientIp(request);

    if (throttled(loginAttempts, ip, LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "尝试过于频繁，请稍后再试" }, 429, cors);
    }

    let body;
    try {
        body = await request.json();
    } catch (error) {
        return jsonResponse({ error: "bad_request", message: "请求体必须是 JSON" }, 400, cors);
    }

    const login = String(body && body.login || "").trim();
    const password = String(body && body.password || "");

    if (!login || !password) {
        return jsonResponse({ error: "bad_request", message: "缺少 login 或 password" }, 400, cors);
    }

    const accounts = await loadAccounts(env);
    const account = accounts[login];

    if (!account || !timingSafeEqual(account.password || "", password)) {
        return jsonResponse({ error: "invalid_credentials", message: "登录名或密码不正确" }, 401, cors);
    }

    if (!env.SIGNING_SECRET) {
        return jsonResponse({ error: "server_misconfigured", message: "服务端未配置 SIGNING_SECRET" }, 500, cors);
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(env.TOKEN_TTL_SECONDS || DEFAULT_TTL);
    const token = await signToken({ sub: login, iat: now, exp: now + ttl, iss: "vtx-api" }, env.SIGNING_SECRET);

    const recorded = await recordLoginLocationSafely(env, login, request, body && body.geo);
    const current = recorded.accounts && recorded.accounts[login] ? recorded.accounts[login] : account;

    return jsonResponse({
        token,
        expiresAt: new Date((now + ttl) * 1000).toISOString(),
        login,
        account: selfAccount(current),
        loginLocation: recorded.entry
    }, 200, cors);
}

async function recordLoginLocationSafely(env, login, request, clientGeo) {
    try {
        return await recordLoginLocation(env, login, request, clientGeo);
    } catch (error) {
        /* 登录记录失败不能影响登录本身 */
        return { entry: null };
    }
}

async function requireSession(request, env, cors) {
    const header = request.headers.get("Authorization") || "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

    if (!token) {
        return { error: jsonResponse({ error: "unauthorized", message: "缺少 Authorization: Bearer <token>" }, 401, cors) };
    }

    const payload = await verifyToken(token, env.SIGNING_SECRET);
    if (!payload) {
        return { error: jsonResponse({ error: "unauthorized", message: "token 无效或已过期" }, 401, cors) };
    }

    return { payload };
}

async function handleAccounts(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    const accounts = await loadAccounts(env);
    const output = {};

    for (const [login, account] of Object.entries(accounts)) {
        output[login] = publicAccount(account);
    }

    return jsonResponse({ me: session.payload.sub, count: Object.keys(output).length, accounts: output }, 200, cors);
}

async function handleAccount(request, env, cors, login) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    const accounts = await loadAccounts(env);
    const account = accounts[login];

    if (!account) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    return jsonResponse({ login, account: publicAccount(account) }, 200, cors);
}

async function handleMe(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    const accounts = await loadAccounts(env);
    const account = accounts[session.payload.sub];

    if (!account) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    return jsonResponse({
        login: session.payload.sub,
        expiresAt: new Date(session.payload.exp * 1000).toISOString(),
        account: selfAccount(account)
    }, 200, cors);
}

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch (error) {
        throw new HttpError(400, "bad_request", "请求体必须是 JSON");
    }
}

function plainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validateGameName(game) {
    if (!GAME_PATTERN.test(game)) {
        throw new HttpError(400, "bad_request", "游戏名称不合法（1-32 个字符，可用中英文、数字、空格、_ . -）");
    }
    return game;
}

async function handleSetData(request, env, cors, login, game) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (session.payload.sub !== login) {
        return jsonResponse({ error: "forbidden", message: "只能修改自己的账户数据" }, 403, cors);
    }

    if (!canWrite(env)) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法写入" }, 503, cors);
    }

    if (throttled(writeAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "写入过于频繁，请稍后再试" }, 429, cors);
    }

    try {
        validateGameName(game);
    } catch (error) {
        return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
    }

    const patch = await readJsonBody(request);

    if (!plainObject(patch) || Array.isArray(patch)) {
        return jsonResponse({ error: "bad_request", message: "请求体必须是该游戏的 JSON 对象" }, 400, cors);
    }

    const keys = Object.keys(patch);

    if (keys.length === 0) {
        return jsonResponse({ error: "bad_request", message: "至少需要提供一个键" }, 400, cors);
    }
    if (keys.length > MAX_KEYS_PER_WRITE) {
        return jsonResponse({ error: "bad_request", message: `一次最多写入 ${MAX_KEYS_PER_WRITE} 个键` }, 400, cors);
    }

    for (const key of keys) {
        if (!KEY_PATTERN.test(key)) {
            return jsonResponse({ error: "bad_request", message: `键名不合法：${key}（仅允许字母、数字、_ . -，最长 64）` }, 400, cors);
        }
    }

    let gameData = null;

    const accounts = await commitAccounts(env, (data) => {
        const account = data[login];

        if (!account) {
            throw new HttpError(404, "not_found", "账户不存在");
        }

        account.data = plainObject(account.data);

        if (!(game in account.data) && Object.keys(account.data).length >= MAX_GAMES) {
            throw new HttpError(400, "bad_request", `每个账户最多保存 ${MAX_GAMES} 个游戏的数据`);
        }

        gameData = { ...plainObject(account.data[game]), ...patch };
        account.data[game] = gameData;

        const size = new TextEncoder().encode(JSON.stringify(account.data)).length;
        if (size > MAX_DATA_BYTES) {
            throw new HttpError(413, "payload_too_large", `数据总量超过 ${MAX_DATA_BYTES} 字节上限`);
        }

        return `更新账户数据：${login}（${game} → ${keys.join(", ")}）`;
    });

    return jsonResponse({
        ok: true,
        login,
        game,
        keys,
        gameData,
        data: publicAccount(accounts[login]).data
    }, 200, cors);
}

async function handleGetData(request, env, cors, login, game) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (session.payload.sub !== login) {
        return jsonResponse({ error: "forbidden", message: "只能读取自己的账户数据" }, 403, cors);
    }

    try {
        validateGameName(game);
    } catch (error) {
        return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
    }

    const accounts = await loadAccounts(env);
    const account = accounts[login];

    if (!account) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    return jsonResponse({
        ok: true,
        login,
        game,
        gameData: plainObject(plainObject(account.data)[game])
    }, 200, cors);
}

async function handleDeleteData(request, env, cors, login, game, key) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (session.payload.sub !== login) {
        return jsonResponse({ error: "forbidden", message: "只能修改自己的账户数据" }, 403, cors);
    }

    if (!canWrite(env)) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法写入" }, 503, cors);
    }

    if (throttled(writeAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "写入过于频繁，请稍后再试" }, 429, cors);
    }

    try {
        validateGameName(game);
    } catch (error) {
        return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
    }

    const accounts = await commitAccounts(env, (data) => {
        const account = data[login];

        if (!account) {
            throw new HttpError(404, "not_found", "账户不存在");
        }

        account.data = plainObject(account.data);

        if (!(game in account.data)) {
            throw new HttpError(404, "not_found", `没有这个游戏的数据：${game}`);
        }

        if (!key) {
            delete account.data[game];
            return `删除账户数据：${login}（${game} 全部）`;
        }

        const ns = plainObject(account.data[game]);

        if (!(key in ns)) {
            throw new HttpError(404, "not_found", `键不存在：${game}.${key}`);
        }

        delete ns[key];
        account.data[game] = ns;

        return `删除账户数据：${login}（${game}.${key}）`;
    });

    return jsonResponse({
        ok: true,
        login,
        game,
        removed: key || game,
        data: publicAccount(accounts[login]).data
    }, 200, cors);
}

async function handleRegister(request, env, cors) {
    const ip = clientIp(request);

    if (throttled(registerAttempts, ip, REGISTER_WINDOW_MS, REGISTER_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "注册过于频繁，请稍后再试" }, 429, cors);
    }

    if (!canWrite(env)) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法创建账户" }, 503, cors);
    }

    if (!env.SIGNING_SECRET) {
        return jsonResponse({ error: "server_misconfigured", message: "服务端未配置 SIGNING_SECRET" }, 500, cors);
    }

    const body = await readJsonBody(request);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ error: "bad_request", message: "请求体必须是一个 JSON 对象" }, 400, cors);
    }

    const login = String(body.login || "").trim();
    const password = String(body.password || "");
    const username = String(body.username || "").trim();

    if (!LOGIN_NAME_PATTERN.test(login)) {
        return jsonResponse({ error: "bad_request", message: "登录账户名需要 2-20 个字符，且不能包含空格" }, 400, cors);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` }, 400, cors);
    }
    if (username.length > MAX_USERNAME_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `显示名称最长 ${MAX_USERNAME_LENGTH} 个字符` }, 400, cors);
    }

    const accounts = await commitAccounts(env, (data) => {
        if (data[login]) {
            throw new HttpError(409, "account_exists", `账户名称 ${login} 已被占用`);
        }
        if (Object.keys(data).length >= MAX_ACCOUNTS) {
            throw new HttpError(403, "forbidden", `账户数量已达上限（${MAX_ACCOUNTS}）`);
        }

        data[login] = {
            username: username || login,
            password,
            money: "0.00",
            trades: []
        };

        return `创建账户：${login}`;
    });

    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(env.TOKEN_TTL_SECONDS || DEFAULT_TTL);
    const token = await signToken({ sub: login, iat: now, exp: now + ttl, iss: "vtx-api" }, env.SIGNING_SECRET);

    const recorded = await recordLoginLocationSafely(env, login, request, body.geo);
    const created = recorded.accounts && recorded.accounts[login] ? recorded.accounts[login] : accounts[login];

    return jsonResponse({
        token,
        expiresAt: new Date((now + ttl) * 1000).toISOString(),
        login,
        created: true,
        account: selfAccount(created)
    }, 201, cors);
}

async function handleTrade(request, env, cors, login) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    const target = login || session.payload.sub;

    if (session.payload.sub !== target) {
        return jsonResponse({ error: "forbidden", message: "只能给自己的账户记账" }, 403, cors);
    }

    if (!canWrite(env)) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法写入" }, 503, cors);
    }

    if (throttled(tradeAttempts, clientIp(request), TRADE_WINDOW_MS, TRADE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "记账过于频繁，请稍后再试" }, 429, cors);
    }

    const body = await readJsonBody(request);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ error: "bad_request", message: "请求体必须是一个 JSON 对象" }, 400, cors);
    }

    const type = String(body.type || "").trim().toLowerCase();

    if (type !== "payment" && type !== "receipt") {
        return jsonResponse({ error: "bad_request", message: "type 必须是 payment（付款）或 receipt（收款）" }, 400, cors);
    }

    const amountCents = toCents(body.amount);

    if (amountCents === null || amountCents <= 0) {
        return jsonResponse({ error: "bad_request", message: "amount 必须是大于 0 的数字，最多两位小数" }, 400, cors);
    }
    if (amountCents > MAX_TRADE_CENTS) {
        return jsonResponse({ error: "bad_request", message: `单笔金额不能超过 ${fromCents(MAX_TRADE_CENTS)} VTX` }, 400, cors);
    }

    const password = String(body.password ?? "");
    const isPayment = type === "payment";

    // 付款要密码二次确认；收款只是给自己入账，不需要密码
    if (isPayment && !password) {
        return jsonResponse({ error: "bad_request", message: "缺少 password：付款需要密码确认" }, 400, cors);
    }

    const party = String(body.party ?? body.counterparty ?? "").trim();

    if (!party) {
        return jsonResponse({ error: "bad_request", message: "缺少 party：付款填去向，收款填来源" }, 400, cors);
    }
    if (party.length > MAX_PARTY_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `party 最长 ${MAX_PARTY_LENGTH} 个字符` }, 400, cors);
    }

    const description = String(body.description ?? "").trim();

    if (description.length > MAX_DESCRIPTION_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `description 最长 ${MAX_DESCRIPTION_LENGTH} 个字符` }, 400, cors);
    }

    const name = String(body.name ?? (type === "payment" ? "付款" : "收款")).trim();

    if (!name || name.length > MAX_TRADE_NAME_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `name 必须为 1-${MAX_TRADE_NAME_LENGTH} 个字符` }, 400, cors);
    }

    let trade = null;

    const accounts = await commitAccounts(env, (data) => {
        const account = data[target];

        if (!account) {
            throw new HttpError(404, "not_found", "账户不存在");
        }

        if (isPayment && !timingSafeEqual(String(account.password || ""), password)) {
            throw new HttpError(400, "invalid_password", "密码不正确，付款已取消");
        }

        const balanceCents = toCents(account.money) ?? 0;

        if (isPayment && balanceCents < amountCents) {
            throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(balanceCents)} VTX`);
        }

        const username = String(account.username || target);
        const signed = `${isPayment ? "-" : "+"}${fromCents(amountCents)}`;

        trade = {
            name,
            description,
            time: shanghaiTimestamp(),
            from: isPayment ? username : party,
            to: isPayment ? party : username,
            price: signed
        };

        account.trades = Array.isArray(account.trades) ? account.trades : [];
        account.trades.push(trade);
        account.money = fromCents(isPayment ? balanceCents - amountCents : balanceCents + amountCents);

        return `${name}：${username} ${signed} VTX`;
    });

    return jsonResponse({
        ok: true,
        login: target,
        trade,
        account: publicAccount(accounts[target])
    }, 200, cors);
}

function requireOwnAccount(accounts, login) {
    const account = accounts[login];

    if (!account) {
        throw new HttpError(404, "not_found", "账户不存在");
    }

    return account;
}

function checkPassword(account, password) {
    if (!timingSafeEqual(String(account.password || ""), String(password ?? ""))) {
        throw new HttpError(400, "invalid_password", "账户密码不正确");
    }
}

function pushTrade(account, trade) {
    account.trades = Array.isArray(account.trades) ? account.trades : [];
    account.trades.push(trade);
    return trade;
}

async function handleUpdateUsername(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(writeAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    const body = plainObject(await readJsonBody(request));
    const username = String(body.username ?? "").trim();
    const login = session.payload.sub;

    if (username.length < 2 || username.length > MAX_USERNAME_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `用户名需要 2-${MAX_USERNAME_LENGTH} 个字符` }, 400, cors);
    }

    const accounts = await commitAccounts(env, (data) => {
        const account = requireOwnAccount(data, login);

        if (String(account.username || "") === username) {
            throw new HttpError(400, "bad_request", "新用户名与当前用户名相同");
        }

        account.username = username;
        return `更改用户名：${login} → ${username}`;
    });

    return jsonResponse({ ok: true, login, account: selfAccount(accounts[login]) }, 200, cors);
}

async function handleUpdatePassword(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(loginAttempts, clientIp(request), LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "尝试过于频繁，请稍后再试" }, 429, cors);
    }

    const body = plainObject(await readJsonBody(request));
    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");
    const login = session.payload.sub;

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `新密码至少 ${MIN_PASSWORD_LENGTH} 个字符` }, 400, cors);
    }
    if (newPassword.length > 128) {
        return jsonResponse({ error: "bad_request", message: "新密码最长 128 个字符" }, 400, cors);
    }

    await commitAccounts(env, (data) => {
        const account = requireOwnAccount(data, login);

        checkPassword(account, currentPassword);
        account.password = newPassword;

        return `修改密码：${login}`;
    });

    return jsonResponse({ ok: true, login }, 200, cors);
}

async function handleCheckin(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(writeAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const date = shanghaiDate();

    let trade = null;

    const accounts = await commitAccounts(env, (data) => {
        const account = requireOwnAccount(data, login);
        const trades = Array.isArray(account.trades) ? account.trades : [];

        if (trades.some((item) => item && item.name === "每日签到" && String(item.time).startsWith(date))) {
            throw new HttpError(400, "already_checked_in", "今天已经签到过了");
        }

        const balance = toCents(account.money) ?? 0;
        account.money = fromCents(balance + 500);

        trade = pushTrade(account, {
            name: "每日签到",
            description: "每日签到奖励",
            price: "+5.00",
            time: date,
            from: "官方",
            to: account.username || login
        });

        return `签到：${login} +5.00 VTX`;
    });

    return jsonResponse({ ok: true, login, trade, account: selfAccount(accounts[login]) }, 200, cors);
}

async function handleTransfer(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(tradeAttempts, clientIp(request), TRADE_WINDOW_MS, TRADE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "转账过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const target = String(body.to ?? body.recipient ?? "").trim();
    const amountCents = toCents(body.amount);
    const password = String(body.password ?? "");
    const description = String(body.description ?? body.note ?? "").trim() || "账户转账";

    if (!target) {
        return jsonResponse({ error: "bad_request", message: "缺少 to：请填写收款账户" }, 400, cors);
    }
    if (target === login) {
        return jsonResponse({ error: "bad_request", message: "不能给自己转账" }, 400, cors);
    }
    if (amountCents === null || amountCents <= 0) {
        return jsonResponse({ error: "bad_request", message: "amount 必须是大于 0 的数字，最多两位小数" }, 400, cors);
    }
    if (amountCents > MAX_TRADE_CENTS) {
        return jsonResponse({ error: "bad_request", message: `单笔金额不能超过 ${fromCents(MAX_TRADE_CENTS)} VTX` }, 400, cors);
    }
    if (!password) {
        return jsonResponse({ error: "bad_request", message: "缺少 password：转账需要密码确认" }, 400, cors);
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `description 最长 ${MAX_DESCRIPTION_LENGTH} 个字符` }, 400, cors);
    }

    const price = fromCents(amountCents);
    const time = shanghaiTimestamp();
    let senderTrade = null;
    let targetName = "";

    const accounts = await commitAccounts(env, (data) => {
        const sender = requireOwnAccount(data, login);
        const receiver = data[target];

        checkPassword(sender, password);

        if (!receiver) {
            throw new HttpError(404, "not_found", `收款账户 ${target} 不存在`);
        }

        const senderBalance = toCents(sender.money) ?? 0;
        if (senderBalance < amountCents) {
            throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(senderBalance)} VTX`);
        }

        const senderName = String(sender.username || login);
        targetName = String(receiver.username || target);
        const common = { name: "转账", description, time, from: senderName, to: targetName };

        sender.money = fromCents(senderBalance - amountCents);
        receiver.money = fromCents((toCents(receiver.money) ?? 0) + amountCents);

        senderTrade = pushTrade(sender, { ...common, price: `-${price}` });
        pushTrade(receiver, { ...common, price: `+${price}` });

        return `转账：${senderName} → ${targetName} ${price} VTX`;
    });

    return jsonResponse({
        ok: true,
        login,
        trade: senderTrade,
        target: { login: target, username: targetName, account: publicAccount(accounts[target]) },
        account: selfAccount(accounts[login])
    }, 200, cors);
}

async function handleWithdraw(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(tradeAttempts, clientIp(request), TRADE_WINDOW_MS, TRADE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "提款过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const amountCents = toCents(body.amount);
    const password = String(body.password ?? "");

    if (amountCents === null || amountCents <= 0) {
        return jsonResponse({ error: "bad_request", message: "amount 必须是大于 0 的数字，最多两位小数" }, 400, cors);
    }
    if (!password) {
        return jsonResponse({ error: "bad_request", message: "缺少 password：提款需要密码确认" }, 400, cors);
    }

    const amount = fromCents(amountCents);
    const time = shanghaiTimestamp();
    let trade = null;
    let username = login;

    const accounts = await commitAccounts(env, (data) => {
        const account = requireOwnAccount(data, login);

        checkPassword(account, password);

        const balance = toCents(account.money) ?? 0;
        if (balance < amountCents) {
            throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(balance)} VTX`);
        }

        username = String(account.username || login);
        account.money = fromCents(balance - amountCents);
        trade = pushTrade(account, {
            name: "提款",
            description: "线下提款",
            price: `-${amount}`,
            time,
            from: username,
            to: "XRingCR"
        });

        return `提款：${username} -${amount} VTX`;
    });

    return jsonResponse({
        ok: true,
        login,
        trade,
        receipt: `提款成功：${amount}VTX，请不要关闭此窗口，请将此窗口截图在XRingCR群中发给群主，次日将在学校给您纸币。提款时间：${time}`,
        account: selfAccount(accounts[login])
    }, 200, cors);
}

async function handleBilling(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(tradeAttempts, clientIp(request), TRADE_WINDOW_MS, TRADE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "记账过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const type = String(body.type ?? "charge").trim().toLowerCase();
    const amountCents = toCents(body.amount);
    const name = String(body.name ?? "").trim().slice(0, MAX_TRADE_NAME_LENGTH);
    const description = String(body.description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);

    if (type !== "charge" && type !== "refund") {
        return jsonResponse({ error: "bad_request", message: "type 必须是 charge（扣费）或 refund（退款）" }, 400, cors);
    }
    if (amountCents === null || amountCents <= 0) {
        return jsonResponse({ error: "bad_request", message: "amount 必须是大于 0 的数字，最多两位小数" }, 400, cors);
    }
    if (amountCents > MAX_TRADE_CENTS) {
        return jsonResponse({ error: "bad_request", message: `单笔金额不能超过 ${fromCents(MAX_TRADE_CENTS)} VTX` }, 400, cors);
    }
    if (!name) {
        return jsonResponse({ error: "bad_request", message: "缺少 name：请填写这笔记录的名称" }, 400, cors);
    }

    const isCharge = type === "charge";
    let trade = null;

    const accounts = await commitAccounts(env, (data) => {
        const account = requireOwnAccount(data, login);
        const balance = toCents(account.money) ?? 0;

        if (isCharge && balance < amountCents) {
            throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(balance)} VTX`);
        }

        const username = String(account.username || login);
        const price = fromCents(amountCents);

        account.money = fromCents(isCharge ? balance - amountCents : balance + amountCents);
        trade = pushTrade(account, {
            name,
            description,
            price: `${isCharge ? "-" : "+"}${price}`,
            time: shanghaiTimestamp(),
            from: isCharge ? username : "官方",
            to: isCharge ? "AI" : username
        });

        return `${name}：${username} ${isCharge ? "-" : "+"}${price} VTX`;
    });

    return jsonResponse({ ok: true, login, trade, account: selfAccount(accounts[login]) }, 200, cors);
}

async function handlePurchase(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(tradeAttempts, clientIp(request), TRADE_WINDOW_MS, TRADE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const item = String(body.item ?? "").trim().slice(0, 40);
    const quantity = Math.floor(Number(body.quantity || 0));
    const amountCents = toCents(body.amount);
    const password = String(body.password ?? "");
    const description = String(body.description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);

    if (!item) {
        return jsonResponse({ error: "bad_request", message: "缺少 item：请填写商品名称" }, 400, cors);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return jsonResponse({ error: "bad_request", message: "quantity 必须是大于 0 的整数" }, 400, cors);
    }
    if (amountCents === null || amountCents <= 0) {
        return jsonResponse({ error: "bad_request", message: "amount 必须是大于 0 的数字，最多两位小数" }, 400, cors);
    }
    if (!password) {
        return jsonResponse({ error: "bad_request", message: "缺少 password：购买需要密码确认" }, 400, cors);
    }

    const amount = fromCents(amountCents);
    const time = shanghaiTimestamp();
    let trade = null;

    const accounts = await commitAccounts(env, (data) => {
        const account = requireOwnAccount(data, login);

        checkPassword(account, password);

        const balance = toCents(account.money) ?? 0;
        if (balance < amountCents) {
            throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(balance)} VTX`);
        }

        account.money = fromCents(balance - amountCents);
        trade = pushTrade(account, {
            name: "购买商品",
            description: description || `${item} ×${quantity}`,
            price: `-${amount}`,
            time,
            from: account.username || login,
            to: "XRingCR"
        });

        return `购买商品：${account.username || login} 购买 ${item} ×${quantity}`;
    });

    return jsonResponse({
        ok: true,
        login,
        trade,
        receipt: `购买成功：${item} ×${quantity}，共 ${amount} VTX，请不要关闭此窗口，请将此窗口截图在XRingCR群中发给群主，次日将在学校给你商品。购买时间：${time}`,
        account: selfAccount(accounts[login])
    }, 200, cors);
}

async function handleLoginLocation(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(writeAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const { entry, accounts } = await recordLoginLocation(env, login, request, body);

    return jsonResponse({
        ok: true,
        login,
        entry,
        account: selfAccount(accounts[login])
    }, 200, cors);
}

function adminLogin(env) {
    return String(env.ADMIN_ACCOUNT || DEFAULT_ADMIN_ACCOUNT).trim() || DEFAULT_ADMIN_ACCOUNT;
}

async function requireAdmin(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session;
    }

    if (session.payload.sub !== adminLogin(env)) {
        return { error: jsonResponse({ error: "forbidden", message: "只有站主可以管理账户" }, 403, cors) };
    }

    return session;
}

async function appendAdminLog(env, actor, action, target, detail) {
    if (!hasKv(env)) {
        return;
    }

    try {
        const stored = await env.ACCOUNTS_KV.get(ADMIN_LOG_KEY, "json");
        const list = Array.isArray(stored) ? stored : [];
        list.push({
            time: shanghaiTimestamp(),
            actor,
            action,
            target: String(target || ""),
            detail: String(detail || "").slice(0, 200)
        });
        await env.ACCOUNTS_KV.put(ADMIN_LOG_KEY, JSON.stringify(list.slice(-ADMIN_LOG_LIMIT)));
    } catch (error) {
        /* 审计日志失败不影响操作 */
    }
}

function validatePasswordValue(password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
        throw new HttpError(400, "bad_request", `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    }
    if (password.length > 128) {
        throw new HttpError(400, "bad_request", "密码最长 128 个字符");
    }
    return password;
}

function validateMoneyValue(value) {
    const cents = toCents(value);

    if (cents === null || cents < 0) {
        throw new HttpError(400, "bad_request", "money 必须是不小于 0 的数字，最多两位小数");
    }

    return fromCents(cents);
}

async function handleAdminList(request, env, cors) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }

    const accounts = await loadAccounts(env);
    const output = {};

    for (const [login, account] of Object.entries(accounts)) {
        output[login] = fullAccount(account);
    }

    return jsonResponse({
        ok: true,
        admin: adminLogin(env),
        count: Object.keys(output).length,
        storage: hasKv(env) ? "kv" : "github",
        accounts: output
    }, 200, cors);
}

async function handleAdminCreate(request, env, cors) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(adminAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    const body = plainObject(await readJsonBody(request));
    const login = String(body.login ?? "").trim();
    const password = String(body.password ?? "");
    const username = String(body.username ?? "").trim() || login;
    let money = "0.00";

    if (!LOGIN_NAME_PATTERN.test(login)) {
        return jsonResponse({ error: "bad_request", message: "登录账户名需要 2-20 个字符，且不能包含空格" }, 400, cors);
    }
    if (username.length > MAX_USERNAME_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `显示名称最长 ${MAX_USERNAME_LENGTH} 个字符` }, 400, cors);
    }

    try {
        validatePasswordValue(password);
        if (body.money !== undefined && body.money !== null && String(body.money).trim() !== "") {
            money = validateMoneyValue(body.money);
        }
    } catch (error) {
        return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
    }

    const accounts = await commitAccounts(env, (data) => {
        if (data[login]) {
            throw new HttpError(409, "account_exists", `账户名称 ${login} 已被占用`);
        }
        if (Object.keys(data).length >= MAX_ACCOUNTS) {
            throw new HttpError(403, "forbidden", `账户数量已达上限（${MAX_ACCOUNTS}）`);
        }

        data[login] = { username, password, money, trades: [] };
        return `管理员创建账户：${login}`;
    });

    await appendAdminLog(env, session.payload.sub, "create", login, `money=${money}`);

    return jsonResponse({
        ok: true,
        login,
        account: fullAccount(accounts[login]),
        accounts: Object.fromEntries(Object.entries(accounts).map(([key, value]) => [key, fullAccount(value)]))
    }, 201, cors);
}

async function handleAdminUpdate(request, env, cors, login) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(adminAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    const body = plainObject(await readJsonBody(request));
    const changes = [];

    if (body.username !== undefined) {
        const username = String(body.username).trim();
        if (username.length < 2 || username.length > MAX_USERNAME_LENGTH) {
            return jsonResponse({ error: "bad_request", message: `用户名需要 2-${MAX_USERNAME_LENGTH} 个字符` }, 400, cors);
        }
    }
    if (body.password !== undefined) {
        try {
            validatePasswordValue(String(body.password));
        } catch (error) {
            return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
        }
    }
    if (body.money !== undefined) {
        try {
            validateMoneyValue(body.money);
        } catch (error) {
            return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
        }
    }

    const accounts = await commitAccounts(env, (data) => {
        const account = data[login];

        if (!account) {
            throw new HttpError(404, "not_found", `账户 ${login} 不存在`);
        }

        if (body.username !== undefined) {
            account.username = String(body.username).trim();
            changes.push(`username=${account.username}`);
        }
        if (body.password !== undefined) {
            account.password = String(body.password);
            changes.push("password=***");
        }
        if (body.money !== undefined) {
            account.money = validateMoneyValue(body.money);
            changes.push(`money=${account.money}`);
        }

        if (changes.length === 0) {
            throw new HttpError(400, "bad_request", "没有需要修改的字段（username / password / money）");
        }

        return `管理员修改账户：${login}（${changes.join(", ")}）`;
    });

    await appendAdminLog(env, session.payload.sub, "update", login, changes.join(", "));

    return jsonResponse({
        ok: true,
        login,
        changes,
        account: fullAccount(accounts[login]),
        accounts: Object.fromEntries(Object.entries(accounts).map(([key, value]) => [key, fullAccount(value)]))
    }, 200, cors);
}

async function handleAdminDelete(request, env, cors, login) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (throttled(adminAttempts, clientIp(request), WRITE_WINDOW_MS, WRITE_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "操作过于频繁，请稍后再试" }, 429, cors);
    }

    if (login === adminLogin(env)) {
        return jsonResponse({ error: "forbidden", message: "不能删除站主自己的账户" }, 403, cors);
    }

    const accounts = await commitAccounts(env, (data) => {
        if (!data[login]) {
            throw new HttpError(404, "not_found", `账户 ${login} 不存在`);
        }

        delete data[login];
        return `管理员删除账户：${login}`;
    });

    await appendAdminLog(env, session.payload.sub, "delete", login, "");

    return jsonResponse({
        ok: true,
        removed: login,
        accounts: Object.fromEntries(Object.entries(accounts).map(([key, value]) => [key, fullAccount(value)]))
    }, 200, cors);
}

async function handleAdminLog(request, env, cors) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (!hasKv(env)) {
        return jsonResponse({ ok: true, storage: "github", entries: [] }, 200, cors);
    }

    const stored = await env.ACCOUNTS_KV.get(ADMIN_LOG_KEY, "json");
    const entries = Array.isArray(stored) ? stored.slice(-ADMIN_LOG_LIMIT).reverse() : [];

    return jsonResponse({ ok: true, storage: "kv", entries }, 200, cors);
}

/* ───────────────────────────── 9.0 聊天室 ───────────────────────────── */

function chatEnabled(env) {
    return String(env.CHAT_ENABLED || "true") === "true";
}

function chatNotReady(cors) {
    return jsonResponse({
        error: "chat_not_ready",
        message: "版本9.0，我们聊天室见",
        version: CHAT_VERSION
    }, 503, cors);
}

function chatGuard(env, cors) {
    if (!hasKv(env)) {
        return jsonResponse({
            error: "chat_storage_unavailable",
            message: "聊天室需要绑定 ACCOUNTS_KV"
        }, 503, cors);
    }
    if (!chatEnabled(env)) {
        return chatNotReady(cors);
    }
    return null;
}

function handleChatStatus(request, env, cors) {
    return jsonResponse({
        ok: true,
        version: CHAT_VERSION,
        status: chatEnabled(env) ? "ready" : "coming_soon",
        enabled: chatEnabled(env),
        storage: hasKv(env) ? "workers-kv" : "unavailable",
        realtime: env.CHAT && typeof env.CHAT.idFromName === "function" ? "websocket" : "polling",
        rooms: CHAT_PUBLIC_GROUPS.map((group) => ({ id: group.id, name: group.name })),
        features: [
            "friends", "direct", "groups", "group-admin", "announcement",
            "recall", "forward", "reply", "search", "mute-pin", "files-images", "expiring-media"
        ],
        mediaTtlSeconds: CHAT_MEDIA_TTL_SECONDS,
        message: chatEnabled(env) ? "聊天室已开放" : "版本9.0，我们聊天室见"
    }, 200, cors);
}

function chatUserKey(login) {
    return `chat:user:${login}`;
}

function chatConversationKey(id) {
    return `chat:conversation:${id}`;
}

function chatMessagesKey(id) {
    return `chat:messages:${id}`;
}

function chatMediaKey(id) {
    return `chat:media:${id}`;
}

function chatMediaMetaKey(id) {
    return `chat:media-meta:${id}`;
}

function chatDirectKey(a, b) {
    const pair = [a, b].sort().map((item) => encodeURIComponent(item));
    return `chat:direct:${pair.join("|")}`;
}

function isPlatformAdmin(env, login) {
    return String(login) === adminLogin(env);
}

function defaultChatUser() {
    return { conversations: [], friends: [], blocked: [], incoming: [], outgoing: [] };
}

async function readChatUser(env, login) {
    const stored = plainObject(await env.ACCOUNTS_KV.get(chatUserKey(login), "json"));
    const record = { ...defaultChatUser(), ...stored };

    for (const key of ["conversations", "friends", "blocked", "incoming", "outgoing"]) {
        if (!Array.isArray(record[key])) {
            record[key] = [];
        }
    }

    record.conversations = record.conversations.filter((item) => item && typeof item === "object" && typeof item.id === "string");
    record.friends = record.friends.filter((item) => item && typeof item.login === "string");
    record.blocked = record.blocked.filter((item) => typeof item === "string");
    record.incoming = record.incoming.filter((item) => item && typeof item.id === "string");
    record.outgoing = record.outgoing.filter((item) => item && typeof item.id === "string");
    return record;
}

async function saveChatUser(env, login, record) {
    record.updatedAt = shanghaiTimestamp();
    await env.ACCOUNTS_KV.put(chatUserKey(login), JSON.stringify(record));
}

function chatEntry(record, id) {
    return record.conversations.find((item) => item.id === id) || null;
}

function ensurePublicSubscriptions(record) {
    let changed = false;
    for (const group of CHAT_PUBLIC_GROUPS) {
        if (!chatEntry(record, group.id)) {
            record.conversations.push({
                id: group.id,
                pinned: false,
                muted: false,
                joinedAt: shanghaiTimestamp(),
                lastRead: 0,
                clearedAt: 0,
                hidden: false
            });
            changed = true;
        }
    }
    return changed;
}

async function loadChatUser(env, login) {
    const record = await readChatUser(env, login);
    if (ensurePublicSubscriptions(record)) {
        await saveChatUser(env, login, record);
    }
    return record;
}

async function ensureConversationEntry(env, login, id) {
    const record = await readChatUser(env, login);
    const entry = chatEntry(record, id);
    if (!entry) {
        record.conversations.push({
            id,
            pinned: false,
            muted: false,
            joinedAt: shanghaiTimestamp(),
            lastRead: 0,
            clearedAt: 0,
            hidden: false
        });
        await saveChatUser(env, login, record);
        return true;
    }
    if (entry.hidden) {
        entry.hidden = false;
        await saveChatUser(env, login, record);
    }
    return false;
}

async function readChatIndex(env) {
    const stored = await env.ACCOUNTS_KV.get(CHAT_INDEX_KEY, "json");
    return Array.isArray(stored) ? stored.filter((item) => typeof item === "string") : [];
}

async function saveChatIndex(env, index) {
    await env.ACCOUNTS_KV.put(CHAT_INDEX_KEY, JSON.stringify(index.slice(-CHAT_INDEX_LIMIT)));
}

async function addToChatIndex(env, id) {
    const index = await readChatIndex(env);
    if (!index.includes(id)) {
        index.push(id);
        await saveChatIndex(env, index);
    }
}

async function removeFromChatIndex(env, id) {
    const index = await readChatIndex(env);
    const kept = index.filter((item) => item !== id);
    if (kept.length !== index.length) {
        await saveChatIndex(env, kept);
    }
}

async function readConversation(env, id) {
    const conv = plainObject(await env.ACCOUNTS_KV.get(chatConversationKey(id), "json"));
    if (!conv.id) {
        return null;
    }
    if (!Array.isArray(conv.members)) {
        conv.members = [];
    }
    if (!Array.isArray(conv.admins)) {
        conv.admins = [];
    }
    if (!conv.aliases || typeof conv.aliases !== "object" || Array.isArray(conv.aliases)) {
        conv.aliases = {};
    }
    return conv;
}

async function saveConversation(env, conv) {
    await env.ACCOUNTS_KV.put(chatConversationKey(conv.id), JSON.stringify(conv));
}

async function readChatMessages(env, id) {
    const stored = await env.ACCOUNTS_KV.get(chatMessagesKey(id), "json");
    return Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === "string") : [];
}

async function saveChatMessages(env, id, messages) {
    await env.ACCOUNTS_KV.put(chatMessagesKey(id), JSON.stringify(messages.slice(-CHAT_MESSAGE_LIMIT)));
}

async function appendMessage(env, conv, message) {
    const messages = await readChatMessages(env, conv.id);
    messages.push(message);
    await saveChatMessages(env, conv.id, messages);
    conv.lastMessage = message;
    conv.updatedAt = message.time;
    return message;
}

async function appendSystemMessage(env, conv, text) {
    const at = Date.now();
    const message = {
        id: randomCode(9),
        conversation: conv.id,
        sender: "system",
        senderName: "系统",
        type: "system",
        system: true,
        text: String(text).slice(0, MAX_CHAT_TEXT_LENGTH),
        at,
        time: shanghaiTimestamp(at)
    };
    await appendMessage(env, conv, message);
    return message;
}

async function ensurePublicGroups(env) {
    const index = await readChatIndex(env);
    let changed = false;

    for (const group of CHAT_PUBLIC_GROUPS) {
        const existing = await readConversation(env, group.id);
        if (existing) {
            continue;
        }
        const now = shanghaiTimestamp();
        await saveConversation(env, {
            id: group.id,
            type: "group",
            name: group.name,
            description: group.description,
            public: true,
            owner: adminLogin(env),
            admins: [],
            members: [],
            aliases: {},
            announcement: null,
            createdAt: now,
            updatedAt: now,
            lastMessage: null
        });
        if (!index.includes(group.id)) {
            index.push(group.id);
        }
        changed = true;
    }

    if (changed) {
        await saveChatIndex(env, index);
    }
}

function chatDisplayName(accounts, login) {
    const account = accounts && accounts[login];
    return String(account && account.username ? account.username : login);
}

function chatMemberAlias(conv, accounts, login) {
    const alias = conv && conv.aliases ? conv.aliases[login] : "";
    return String(alias || chatDisplayName(accounts, login));
}

function messagePreview(message) {
    if (!message) {
        return "";
    }
    if (message.recalled) {
        return "消息已撤回";
    }
    if (message.type === "image") {
        return "[图片]";
    }
    if (message.type === "file") {
        return `[文件] ${message.media && message.media.name ? message.media.name : ""}`.trim();
    }
    return String(message.text || "");
}

function messageSnippet(message, limit = 80) {
    const text = messagePreview(message);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function messageView(message) {
    if (!message) {
        return null;
    }
    return {
        id: message.id,
        conversation: message.conversation || "",
        sender: message.sender,
        senderName: message.senderName || "",
        type: message.type || "text",
        text: message.recalled ? "" : String(message.text || ""),
        media: message.recalled ? null : (message.media || null),
        replyTo: message.replyTo || null,
        mentions: Array.isArray(message.mentions) ? message.mentions : [],
        forwarded: Boolean(message.forwarded),
        recalled: Boolean(message.recalled),
        system: Boolean(message.system),
        at: Number(message.at) || 0,
        time: message.time || ""
    };
}

function visibleChatMessages(messages, entry) {
    const since = Math.max(Number(entry && entry.clearedAt) || 0, 0);
    return messages.filter((item) => (Number(item.at) || 0) > since);
}

function chatUnreadCount(messages, entry, login) {
    if (!entry) {
        return 0;
    }
    const since = Math.max(Number(entry.lastRead) || 0, Number(entry.clearedAt) || 0);
    return messages.filter((item) => (Number(item.at) || 0) > since && item.sender !== login && !item.system).length;
}

function conversationView(env, conv, entry, messages, login, accounts) {
    const peerLogin = conv.type === "direct"
        ? (conv.members || []).find((item) => item !== login) || ""
        : "";
    const name = conv.type === "direct"
        ? chatDisplayName(accounts, peerLogin || login)
        : String(conv.name || "群聊");

    return {
        id: conv.id,
        type: conv.type,
        name,
        peer: peerLogin,
        peerName: peerLogin ? chatDisplayName(accounts, peerLogin) : "",
        public: Boolean(conv.public),
        memberCount: conv.public ? Object.keys(accounts).length : (conv.members || []).length,
        owner: conv.owner || "",
        admins: conv.admins || [],
        announcement: conv.announcement || null,
        createdAt: conv.createdAt || "",
        dissolved: Boolean(conv.dissolved),
        dissolvedAt: conv.dissolvedAt || "",
        dissolvedBy: conv.dissolvedBy || "",
        dissolvedByName: conv.dissolvedBy ? chatDisplayName(accounts, conv.dissolvedBy) : "",
        pinned: Boolean(entry && entry.pinned),
        muted: Boolean(entry && entry.muted),
        hidden: Boolean(entry && entry.hidden),
        unread: chatUnreadCount(messages, entry, login),
        lastRead: Number(entry && entry.lastRead) || 0,
        lastMessage: messageView(conv.lastMessage),
        updatedAt: Number(conv.lastMessage && conv.lastMessage.at) || 0
    };
}

function conversationTargets(conv, accounts) {
    if (conv.public) {
        return Object.keys(accounts);
    }
    return Array.isArray(conv.members) ? conv.members.slice() : [];
}

function chatMemberOf(conv, login) {
    if (conv.public) {
        return true;
    }
    return Array.isArray(conv.members) && conv.members.includes(login);
}

function canManageGroup(env, conv, login) {
    if (!conv || conv.type !== "group") {
        return false;
    }
    return isPlatformAdmin(env, login)
        || conv.owner === login
        || (Array.isArray(conv.admins) && conv.admins.includes(login));
}

function canOwnGroup(env, conv, login) {
    return isPlatformAdmin(env, login) || conv.owner === login;
}

function chatGroupDissolved(conv) {
    return Boolean(conv && conv.type === "group" && !conv.public && conv.dissolved);
}

function chatDissolvedResponse(cors) {
    return jsonResponse({ error: "group_dissolved", message: "群聊已解散，只能查看历史消息" }, 410, cors);
}

async function notifyChat(env, targets, event, exclude) {
    if (!env.CHAT || typeof env.CHAT.idFromName !== "function") {
        return;
    }
    const list = Array.from(new Set((targets || []).filter((item) => typeof item === "string" && item))).slice(0, 500);
    if (!list.length) {
        return;
    }
    try {
        const stub = env.CHAT.get(env.CHAT.idFromName("hub"));
        await stub.fetch("https://chat-hub/notify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ targets: list, event, exclude: exclude || "" })
        });
    } catch (error) {
        /* 实时推送失败不能影响接口本身的成功 */
    }
}

function chatConversationId(value) {
    const id = String(value || "").trim();
    return CHAT_CONVERSATION_PATTERN.test(id) ? id : "";
}

function chatNotAMember(cors) {
    return jsonResponse({ error: "forbidden", message: "你不在这个会话里" }, 403, cors);
}

async function loadConversationFor(env, id, login, cors) {
    const conv = await readConversation(env, id);
    if (!conv) {
        return { error: jsonResponse({ error: "not_found", message: "会话不存在" }, 404, cors) };
    }
    if (!chatMemberOf(conv, login) && !isPlatformAdmin(env, login)) {
        return { error: chatNotAMember(cors) };
    }
    return { conv };
}

async function handleChatConversations(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    if (!accounts[login]) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    const conversations = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const record = await loadChatUser(env, login);
        const output = [];

        for (const entry of record.conversations) {
            if (!entry || !chatConversationId(entry.id)) {
                continue;
            }
            const conv = await readConversation(env, entry.id);
            if (!conv) {
                continue;
            }
            const messages = await readChatMessages(env, entry.id);
            output.push(conversationView(env, conv, entry, messages, login, accounts));
        }

        return output;
    });

    conversations.sort((left, right) => {
        if (left.pinned !== right.pinned) {
            return left.pinned ? -1 : 1;
        }
        return right.updatedAt - left.updatedAt;
    });

    return jsonResponse({
        ok: true,
        login,
        conversations: conversations.filter((item) => !item.hidden),
        hidden: conversations.filter((item) => item.hidden).map((item) => item.id)
    }, 200, cors);
}

async function ensureDirectConversation(env, a, b) {
    const key = chatDirectKey(a, b);
    const existingId = await env.ACCOUNTS_KV.get(key);

    if (existingId) {
        const existing = await readConversation(env, existingId);
        if (existing) {
            await ensureConversationEntry(env, a, existing.id);
            await ensureConversationEntry(env, b, existing.id);
            return existing;
        }
    }

    const now = shanghaiTimestamp();
    const conv = {
        id: `dm_${randomCode(9)}`,
        type: "direct",
        members: [a, b],
        admins: [],
        aliases: {},
        announcement: null,
        createdAt: now,
        updatedAt: now,
        lastMessage: null
    };

    await saveConversation(env, conv);
    await env.ACCOUNTS_KV.put(key, conv.id);
    await addToChatIndex(env, conv.id);
    await ensureConversationEntry(env, a, conv.id);
    await ensureConversationEntry(env, b, conv.id);
    return conv;
}

async function handleChatDirect(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const target = String(body.login || "").trim();

    if (!target || target === login) {
        return jsonResponse({ error: "bad_request", message: "请选择要聊天的用户" }, 400, cors);
    }

    const accounts = await loadAccounts(env);
    if (!accounts[login] || !accounts[target]) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    if (!isPlatformAdmin(env, login)) {
        const mine = await readChatUser(env, login);
        if (!mine.friends.some((item) => item.login === target)) {
            return jsonResponse({ error: "not_friend", message: "只能和好友发起单聊，请先添加好友" }, 403, cors);
        }
        if (mine.blocked.includes(target)) {
            return jsonResponse({ error: "blocked", message: "你已拉黑对方，无法发起聊天" }, 403, cors);
        }
        const peer = await readChatUser(env, target);
        if (peer.blocked.includes(login)) {
            return jsonResponse({ error: "blocked", message: "对方已将你拉黑" }, 403, cors);
        }
    }

    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const conv = await ensureDirectConversation(env, login, target);
        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        const view = conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts);
        const peerRecord = await readChatUser(env, target);
        return {
            conv,
            view,
            peer: {
                login: target,
                username: chatDisplayName(accounts, target),
                friend: record.friends.some((item) => item.login === target),
                theyAreFriend: peerRecord.friends.some((item) => item.login === login)
            }
        };
    });

    return jsonResponse({ ok: true, conversation: result.view, peer: result.peer }, 200, cors);
}

function normalizeGroupName(value) {
    const name = String(value || "").replace(/\s+/g, " ").trim();
    if (!name) {
        throw new HttpError(400, "bad_request", "群聊名称不能为空");
    }
    if (name.length > CHAT_GROUP_NAME_MAX) {
        throw new HttpError(400, "bad_request", `群聊名称最长 ${CHAT_GROUP_NAME_MAX} 个字符`);
    }
    return name;
}

async function handleChatCreateGroup(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const accounts = await loadAccounts(env);
    if (!accounts[login]) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    const name = normalizeGroupName(body.name);
    const requested = Array.isArray(body.members) ? body.members : [];
    const members = Array.from(new Set([login, ...requested.map((item) => String(item || "").trim())].filter(Boolean)));

    if (members.length > CHAT_GROUP_MAX_MEMBERS) {
        return jsonResponse({ error: "bad_request", message: `群成员不能超过 ${CHAT_GROUP_MAX_MEMBERS} 人` }, 400, cors);
    }
    for (const member of members) {
        if (!accounts[member]) {
            return jsonResponse({ error: "bad_request", message: `用户 ${member} 不存在` }, 400, cors);
        }
    }

    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const now = shanghaiTimestamp();
        const conv = {
            id: `g_${randomCode(9)}`,
            type: "group",
            name,
            public: false,
            owner: login,
            admins: [],
            members,
            aliases: {},
            announcement: null,
            createdAt: now,
            updatedAt: now,
            lastMessage: null
        };

        await saveConversation(env, conv);
        await addToChatIndex(env, conv.id);
        for (const member of members) {
            await ensureConversationEntry(env, member, conv.id);
        }

        const invited = members.filter((item) => item !== login);
        if (invited.length) {
            await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 邀请 ${invited.map((item) => chatDisplayName(accounts, item)).join("、")} 加入了群聊`);
            await saveConversation(env, conv);
        }

        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts)
        };
    });

    await notifyChat(env, result.targets, { type: "conversation:new", conversation: result.view });

    return jsonResponse({ ok: true, conversation: result.view }, 201, cors);
}

async function handleChatConversationDetail(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    if (!accounts[login]) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        const view = conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts);
        const memberLogins = conv.public ? Object.keys(accounts) : conv.members;
        const members = memberLogins.map((member) => ({
            login: member,
            username: chatDisplayName(accounts, member),
            alias: String(conv.aliases[member] || ""),
            owner: conv.owner === member,
            admin: (conv.admins || []).includes(member),
            friend: record.friends.some((item) => item.login === member),
            me: member === login
        }));

        return { view, members, conversation: conv };
    });

    if (result.error) {
        return result.error;
    }

    return jsonResponse({
        ok: true,
        conversation: result.view,
        members: result.members
    }, 200, cors);
}

async function handleChatMessagesList(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const url = new URL(request.url);
    const before = Number(url.searchParams.get("before")) || 0;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || CHAT_PAGE_LIMIT, 1), 100);

    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        const record = await loadChatUser(env, login);
        const entry = chatEntry(record, conv.id);
        const all = visibleChatMessages(await readChatMessages(env, conv.id), entry);
        const filtered = before > 0 ? all.filter((item) => (Number(item.at) || 0) < before) : all;
        const page = filtered.slice(-limit);

        return {
            view: conversationView(env, conv, entry, all, login, accounts),
            messages: page.map(messageView),
            hasMore: filtered.length > page.length,
            oldest: page.length ? Number(page[0].at) || 0 : 0
        };
    });

    if (result.error) {
        return result.error;
    }

    return jsonResponse({
        ok: true,
        conversation: result.view,
        messages: result.messages,
        hasMore: result.hasMore,
        oldest: result.oldest,
        limit: CHAT_MESSAGE_LIMIT
    }, 200, cors);
}

async function buildReplyTarget(messages, replyToId) {
    if (!replyToId) {
        return null;
    }
    const source = messages.find((item) => item.id === replyToId);
    if (!source) {
        throw new HttpError(400, "bad_request", "引用的消息不存在");
    }
    return {
        id: source.id,
        sender: source.sender,
        senderName: source.senderName || "",
        type: source.type || "text",
        preview: messageSnippet(source, 40)
    };
}

async function handleChatSend(request, env, cors, id, compatRoom = "") {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    if (throttled(chatAttempts, clientIp(request), CHAT_WINDOW_MS, CHAT_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "发言过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    if (!accounts[login]) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    const body = plainObject(await readJsonBody(request));
    const type = ["text", "image", "file"].includes(String(body.type || "text")) ? String(body.type || "text") : "text";
    const text = String(body.text ?? "").trim();
    const mentions = Array.isArray(body.mentions)
        ? Array.from(new Set(body.mentions.map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 20)
        : [];

    if (type === "text" && !text) {
        return jsonResponse({ error: "bad_request", message: "消息内容不能为空" }, 400, cors);
    }
    if (text.length > MAX_CHAT_TEXT_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `消息最长 ${MAX_CHAT_TEXT_LENGTH} 个字符` }, 400, cors);
    }

    let media = null;
    if (type === "image" || type === "file") {
        const mediaId = String(body.mediaId || "").trim();
        if (!CHAT_MEDIA_ID_PATTERN.test(mediaId)) {
            return jsonResponse({ error: "bad_request", message: "缺少有效的 mediaId" }, 400, cors);
        }
        const meta = plainObject(await env.ACCOUNTS_KV.get(chatMediaMetaKey(mediaId), "json"));
        if (!meta.id) {
            return jsonResponse({ error: "media_expired", message: "图片或文件已过期（上传后 20 分钟自动删除）" }, 410, cors);
        }
        if (meta.uploader !== login && !isPlatformAdmin(env, login)) {
            return jsonResponse({ error: "forbidden", message: "不能发送别人上传的文件" }, 403, cors);
        }
        if (Number(meta.expiresAt) && Number(meta.expiresAt) < Date.now()) {
            return jsonResponse({ error: "media_expired", message: "图片或文件已过期（上传后 20 分钟自动删除）" }, 410, cors);
        }
        media = {
            id: meta.id,
            name: String(meta.name || "file"),
            type: String(meta.type || "application/octet-stream"),
            size: Number(meta.size) || 0,
            expiresAt: Number(meta.expiresAt) || 0
        };
    }

    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type === "direct") {
            const peer = (conv.members || []).find((item) => item !== login);
            const mine = await readChatUser(env, login);
            const theirs = peer ? await readChatUser(env, peer) : null;
            if (mine.blocked.includes(peer) || (theirs && theirs.blocked.includes(login))) {
                return { error: jsonResponse({ error: "blocked", message: "对方已被拉黑，无法发送消息" }, 403, cors) };
            }
            if (!isPlatformAdmin(env, login) && peer && !mine.friends.some((item) => item.login === peer)) {
                return { error: jsonResponse({ error: "not_friend", message: "你们已经不是好友了" }, 403, cors) };
            }
        }

        const messages = await readChatMessages(env, conv.id);
        const replyTo = await buildReplyTarget(messages, String(body.replyTo || "").trim());
        const at = Date.now();
        const memberList = conv.public ? Object.keys(accounts) : conv.members;
        const validMentions = mentions.filter((item) => memberList.includes(item));
        const message = {
            id: randomCode(9),
            conversation: conv.id,
            sender: login,
            senderName: chatMemberAlias(conv, accounts, login),
            type,
            text,
            media,
            replyTo,
            mentions: validMentions,
            forwarded: false,
            at,
            time: shanghaiTimestamp(at)
        };

        await appendMessage(env, conv, message);
        await saveConversation(env, conv);

        if (conv.type === "direct") {
            for (const member of conv.members) {
                await ensureConversationEntry(env, member, conv.id);
            }
        }

        return {
            conv,
            message,
            targets: conversationTargets(conv, accounts),
            view: conversationView(
                env,
                conv,
                chatEntry(await loadChatUser(env, login), conv.id),
                [...messages, message],
                login,
                accounts
            )
        };
    });

    if (result.error) {
        return result.error;
    }

    const event = {
        type: "message",
        conversation: result.view,
        message: messageView(result.message)
    };
    await notifyChat(env, result.targets, event);

    if (compatRoom) {
        return jsonResponse({
            ok: true,
            room: compatRoom,
            message: result.message,
            view: messageView(result.message)
        }, 201, cors);
    }

    return jsonResponse({
        ok: true,
        conversation: result.view,
        message: messageView(result.message)
    }, 201, cors);
}

async function handleChatRead(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const record = await loadChatUser(env, login);
        let entry = chatEntry(record, id);
        if (!entry) {
            entry = { id, pinned: false, muted: false, joinedAt: shanghaiTimestamp(), lastRead: 0, clearedAt: 0, hidden: false };
            record.conversations.push(entry);
        }
        entry.lastRead = Date.now();
        await saveChatUser(env, login, record);
        return { ok: true, lastRead: entry.lastRead };
    });

    if (result.error) {
        return result.error;
    }

    return jsonResponse({ ok: true, conversation: id, lastRead: result.lastRead }, 200, cors);
}

async function handleChatTyping(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    if (throttled(chatTypingAttempts, `${clientIp(request)}:${id}`, CHAT_TYPING_WINDOW_MS, CHAT_TYPING_MAX_ATTEMPTS)) {
        return jsonResponse({ ok: true, throttled: true }, 200, cors);
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const conv = await readConversation(env, id);
    if (!conv || !chatMemberOf(conv, login)) {
        return jsonResponse({ ok: true, skipped: true }, 200, cors);
    }

    const targets = conversationTargets(conv, accounts).filter((item) => item !== login);
    await notifyChat(env, targets, {
        type: "typing",
        conversation: id,
        login,
        name: chatMemberAlias(conv, accounts, login)
    });

    return jsonResponse({ ok: true }, 200, cors);
}

async function handleChatSettings(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const body = plainObject(await readJsonBody(request));
    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const record = await loadChatUser(env, login);
        let entry = chatEntry(record, id);
        if (!entry) {
            entry = { id, pinned: false, muted: false, joinedAt: shanghaiTimestamp(), lastRead: 0, clearedAt: 0, hidden: false };
            record.conversations.push(entry);
        }
        if (body.pinned !== undefined) {
            entry.pinned = Boolean(body.pinned);
        }
        if (body.muted !== undefined) {
            entry.muted = Boolean(body.muted);
        }
        if (body.hidden !== undefined) {
            entry.hidden = Boolean(body.hidden);
        }
        await saveChatUser(env, login, record);
        return { entry };
    });

    if (result.error) {
        return result.error;
    }

    return jsonResponse({
        ok: true,
        conversation: id,
        pinned: Boolean(result.entry.pinned),
        muted: Boolean(result.entry.muted),
        hidden: Boolean(result.entry.hidden)
    }, 200, cors);
}

async function handleChatClear(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const record = await loadChatUser(env, login);
        const entry = chatEntry(record, id);
        if (entry) {
            entry.clearedAt = Date.now();
            entry.lastRead = entry.clearedAt;
            await saveChatUser(env, login, record);
        }
        return { ok: true };
    });

    if (result.error) {
        return result.error;
    }

    return jsonResponse({ ok: true, conversation: id }, 200, cors);
}

async function handleChatLeave(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        const record = await loadChatUser(env, login);

        if (conv.type === "direct" || conv.public) {
            record.conversations = record.conversations.filter((item) => item.id !== id);
            await saveChatUser(env, login, record);
            return { removed: true, targets: [login], system: "" };
        }

        if (chatGroupDissolved(conv)) {
            /* 已解散的群聊对成员只是只读历史，退出等同于删除自己的会话 */
            record.conversations = record.conversations.filter((item) => item.id !== id);
            await saveChatUser(env, login, record);
            return { removed: true, targets: [], system: "" };
        }

        if (conv.owner === login) {
            const candidates = conv.members.filter((item) => item !== login);
            if (!candidates.length) {
                await deleteChatConversation(env, conv);
                return { removed: true, dissolved: true, targets: conv.members.slice(), system: "" };
            }
            const nextOwner = candidates[0];
            conv.owner = nextOwner;
            conv.admins = conv.admins.filter((item) => item !== nextOwner);
            await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 把群主转让给了 ${chatDisplayName(accounts, nextOwner)}，并退出了群聊`);
        } else {
            await appendSystemMessage(env, conv, `${chatMemberAlias(conv, accounts, login)} 退出了群聊`);
        }

        conv.members = conv.members.filter((item) => item !== login);
        conv.admins = conv.admins.filter((item) => item !== login);
        delete conv.aliases[login];
        await saveConversation(env, conv);

        const nextRecord = await readChatUser(env, login);
        nextRecord.conversations = nextRecord.conversations.filter((item) => item.id !== id);
        await saveChatUser(env, login, nextRecord);

        return { removed: true, targets: conv.members.slice(), system: "" };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:remove", conversation: id, login });
    return jsonResponse({ ok: true, conversation: id, left: true }, 200, cors);
}

async function deleteChatConversation(env, conv) {
    await env.ACCOUNTS_KV.delete(chatMessagesKey(conv.id));
    await env.ACCOUNTS_KV.delete(chatConversationKey(conv.id));
    await removeFromChatIndex(env, conv.id);

    if (conv.type === "direct") {
        const [a, b] = conv.members || [];
        if (a && b) {
            await env.ACCOUNTS_KV.delete(chatDirectKey(a, b));
        }
    }

    for (const member of conv.public ? [] : (conv.members || [])) {
        const record = await readChatUser(env, member);
        const kept = record.conversations.filter((item) => item.id !== conv.id);
        if (kept.length !== record.conversations.length) {
            record.conversations = kept;
            await saveChatUser(env, member, record);
        }
    }
}

async function handleChatDeleteConversation(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;

        if (conv.type === "direct") {
            const record = await loadChatUser(env, login);
            record.conversations = record.conversations.filter((item) => item.id !== id);
            await saveChatUser(env, login, record);
            return { mode: "hide", targets: [login] };
        }

        if (conv.public) {
            return { error: jsonResponse({ error: "forbidden", message: "公共频道不能解散，可以退出" }, 400, cors) };
        }

        if (!canOwnGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主或站主可以解散群聊" }, 403, cors) };
        }

        if (chatGroupDissolved(conv)) {
            return { mode: "dissolve", targets: conversationTargets(conv, accounts) };
        }

        const targets = conversationTargets(conv, accounts);
        conv.dissolved = true;
        conv.dissolvedAt = shanghaiTimestamp();
        conv.dissolvedBy = login;
        await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 解散了群聊`);
        await saveConversation(env, conv);
        return { mode: "dissolve", targets, dissolved: true };
    });

    if (result.error) {
        return result.error;
    }

    if (result.dissolved) {
        await notifyChat(env, result.targets, { type: "conversation:dissolved", conversation: id, login });
    }
    return jsonResponse({ ok: true, conversation: id, mode: result.mode, dissolved: result.mode === "dissolve" }, 200, cors);
}

async function handleChatRename(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group" || !canManageGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主或管理员可以修改群名" }, 403, cors) };
        }
        const name = normalizeGroupName(body.name);
        const before = conv.name;
        conv.name = name;
        await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 把群名从「${before}」改成了「${name}」`);
        await saveConversation(env, conv);
        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts)
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    return jsonResponse({ ok: true, conversation: result.view }, 200, cors);
}

async function handleChatAnnouncement(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));
    const text = String(body.text ?? "").trim();

    if (text.length > CHAT_ANNOUNCEMENT_MAX) {
        return jsonResponse({ error: "bad_request", message: `群公告最长 ${CHAT_ANNOUNCEMENT_MAX} 个字符` }, 400, cors);
    }

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group" || !canManageGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主或管理员可以发布群公告" }, 403, cors) };
        }

        if (!text) {
            conv.announcement = null;
        } else {
            conv.announcement = {
                text,
                author: login,
                authorName: chatDisplayName(accounts, login),
                time: shanghaiTimestamp(),
                pinned: body.pinned === undefined ? Boolean(conv.announcement && conv.announcement.pinned) : Boolean(body.pinned)
            };
            await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 更新了群公告`);
        }
        await saveConversation(env, conv);

        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts)
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    return jsonResponse({ ok: true, conversation: result.view }, 200, cors);
}

async function handleChatAnnouncementPin(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group" || !canManageGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主或管理员可以置顶群公告" }, 403, cors) };
        }
        if (!conv.announcement) {
            return { error: jsonResponse({ error: "not_found", message: "这个群还没有群公告" }, 404, cors) };
        }
        conv.announcement.pinned = body.pinned === undefined ? !conv.announcement.pinned : Boolean(body.pinned);
        await saveConversation(env, conv);

        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts)
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    return jsonResponse({ ok: true, conversation: result.view }, 200, cors);
}

async function handleChatMemberAlias(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));
    const alias = String(body.alias ?? "").replace(/\s+/g, " ").trim();

    if (alias.length > CHAT_ALIAS_MAX) {
        return jsonResponse({ error: "bad_request", message: `群昵称最长 ${CHAT_ALIAS_MAX} 个字符` }, 400, cors);
    }

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group") {
            return { error: jsonResponse({ error: "bad_request", message: "单聊没有群昵称" }, 400, cors) };
        }
        if (alias) {
            conv.aliases[login] = alias;
        } else {
            delete conv.aliases[login];
        }
        await saveConversation(env, conv);
        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts)
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    return jsonResponse({ ok: true, conversation: result.view }, 200, cors);
}

async function handleChatAddMembers(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));
    const requested = Array.isArray(body.members)
        ? Array.from(new Set(body.members.map((item) => String(item || "").trim()).filter(Boolean)))
        : [];

    if (!requested.length) {
        return jsonResponse({ error: "bad_request", message: "请选择要邀请的用户" }, 400, cors);
    }
    for (const member of requested) {
        if (!accounts[member]) {
            return jsonResponse({ error: "bad_request", message: `用户 ${member} 不存在` }, 400, cors);
        }
    }

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group") {
            return { error: jsonResponse({ error: "bad_request", message: "单聊不能邀请成员" }, 400, cors) };
        }
        if (conv.public) {
            return { error: jsonResponse({ error: "bad_request", message: "公共频道无需邀请" }, 400, cors) };
        }

        const added = requested.filter((item) => !conv.members.includes(item));
        if (!added.length) {
            return { error: jsonResponse({ error: "bad_request", message: "对方已经在群里了" }, 400, cors) };
        }
        if (conv.members.length + added.length > CHAT_GROUP_MAX_MEMBERS) {
            return { error: jsonResponse({ error: "bad_request", message: `群成员不能超过 ${CHAT_GROUP_MAX_MEMBERS} 人` }, 400, cors) };
        }

        conv.members.push(...added);
        await appendSystemMessage(env, conv, `${chatMemberAlias(conv, accounts, login)} 邀请 ${added.map((item) => chatDisplayName(accounts, item)).join("、")} 加入了群聊`);
        await saveConversation(env, conv);

        for (const member of added) {
            await ensureConversationEntry(env, member, conv.id);
        }

        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts),
            invited: added
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    await notifyChat(env, result.invited, { type: "conversation:new", conversation: result.view });
    return jsonResponse({ ok: true, conversation: result.view, added: result.invited }, 200, cors);
}

async function handleChatRemoveMember(request, env, cors, id, member) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const target = String(member || "").trim();

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group" || conv.public) {
            return { error: jsonResponse({ error: "bad_request", message: "这个会话不支持移除成员" }, 400, cors) };
        }
        if (target === login) {
            return { error: jsonResponse({ error: "bad_request", message: "退出群聊请使用 /leave" }, 400, cors) };
        }
        if (!conv.members.includes(target)) {
            return { error: jsonResponse({ error: "not_found", message: "该用户不在群里" }, 404, cors) };
        }
        if (!canManageGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主或管理员可以移出成员" }, 403, cors) };
        }
        if (target === conv.owner) {
            return { error: jsonResponse({ error: "bad_request", message: "不能移出群主" }, 400, cors) };
        }
        if (conv.admins.includes(target) && conv.owner !== login && !isPlatformAdmin(env, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主可以移出管理员" }, 403, cors) };
        }

        conv.members = conv.members.filter((item) => item !== target);
        conv.admins = conv.admins.filter((item) => item !== target);
        delete conv.aliases[target];
        await appendSystemMessage(env, conv, `${chatMemberAlias(conv, accounts, login)} 把 ${chatDisplayName(accounts, target)} 移出了群聊`);
        await saveConversation(env, conv);

        const targetRecord = await readChatUser(env, target);
        targetRecord.conversations = targetRecord.conversations.filter((item) => item.id !== id);
        await saveChatUser(env, target, targetRecord);

        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts),
            removed: target
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    await notifyChat(env, [result.removed], { type: "conversation:remove", conversation: id, login });
    return jsonResponse({ ok: true, conversation: result.view, removed: result.removed }, 200, cors);
}

async function handleChatTransferOwner(request, env, cors, id) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));
    const target = String(body.login || "").trim();

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group" || conv.public) {
            return { error: jsonResponse({ error: "bad_request", message: "这个会话不能转让群主" }, 400, cors) };
        }
        if (!canOwnGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主可以转让群主" }, 403, cors) };
        }
        if (!conv.members.includes(target)) {
            return { error: jsonResponse({ error: "bad_request", message: "只能把群主转让给群成员" }, 400, cors) };
        }
        if (target === conv.owner) {
            return { error: jsonResponse({ error: "bad_request", message: "对方已经是群主" }, 400, cors) };
        }

        conv.owner = target;
        conv.admins = conv.admins.filter((item) => item !== target);
        await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 把群主转让给了 ${chatDisplayName(accounts, target)}`);
        await saveConversation(env, conv);

        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts)
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    return jsonResponse({ ok: true, conversation: result.view }, 200, cors);
}

async function handleChatAdmins(request, env, cors, id, member, removing) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = removing ? {} : plainObject(await readJsonBody(request));
    const target = removing ? String(member || "").trim() : String(body.login || "").trim();

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }
        if (conv.type !== "group") {
            return { error: jsonResponse({ error: "bad_request", message: "单聊没有管理员" }, 400, cors) };
        }
        if (!canOwnGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主可以设置管理员" }, 403, cors) };
        }
        if (!conv.members.includes(target) || target === conv.owner) {
            return { error: jsonResponse({ error: "bad_request", message: "只能设置群成员为管理员" }, 400, cors) };
        }

        if (removing) {
            if (!conv.admins.includes(target)) {
                return { error: jsonResponse({ error: "not_found", message: "对方不是管理员" }, 404, cors) };
            }
            conv.admins = conv.admins.filter((item) => item !== target);
            await appendSystemMessage(env, conv, `${chatDisplayName(accounts, target)} 被取消了管理员`);
        } else {
            if (conv.admins.includes(target)) {
                return { error: jsonResponse({ error: "bad_request", message: "对方已经是管理员" }, 400, cors) };
            }
            conv.admins.push(target);
            await appendSystemMessage(env, conv, `${chatDisplayName(accounts, target)} 成为了群管理员`);
        }
        await saveConversation(env, conv);

        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        return {
            view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts),
            targets: conversationTargets(conv, accounts)
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    return jsonResponse({ ok: true, conversation: result.view }, 200, cors);
}

async function handleChatRecall(request, env, cors, messageId) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const url = new URL(request.url);
    const id = chatConversationId(url.searchParams.get("conversation"));

    if (!id) {
        return jsonResponse({ error: "bad_request", message: "缺少 conversation" }, 400, cors);
    }
    if (!CHAT_MESSAGE_ID_PATTERN.test(messageId)) {
        return jsonResponse({ error: "bad_request", message: "消息 id 不合法" }, 400, cors);
    }

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        const messages = await readChatMessages(env, id);
        const index = messages.findIndex((item) => item.id === messageId);
        if (index < 0) {
            return { error: jsonResponse({ error: "not_found", message: "消息不存在" }, 404, cors) };
        }
        const message = messages[index];

        const withinWindow = Date.now() - (Number(message.at) || 0) <= CHAT_RECALL_WINDOW_MS;
        const canRecall = message.sender === login
            ? withinWindow
            : (isPlatformAdmin(env, login) || (conv.type === "group" && canManageGroup(env, conv, login)));

        if (!canRecall) {
            return { error: jsonResponse({ error: "forbidden", message: "超过 2 分钟的消息不能撤回" }, 403, cors) };
        }

        messages[index] = {
            ...message,
            recalled: true,
            text: "",
            media: null,
            mentions: [],
            replyTo: null,
            recalledAt: Date.now()
        };
        await saveChatMessages(env, id, messages);

        if (conv.lastMessage && conv.lastMessage.id === messageId) {
            conv.lastMessage = messages[index];
            await saveConversation(env, conv);
        }

        const record = await loadChatUser(env, login);
        const view = conversationView(env, conv, chatEntry(record, id), messages, login, accounts);
        return { view, targets: conversationTargets(conv, accounts) };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, {
        type: "message:recall",
        conversation: result.view,
        messageId,
        by: login
    });
    return jsonResponse({ ok: true, conversation: id, messageId, recalled: true }, 200, cors);
}

async function handleChatForward(request, env, cors, messageId) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const url = new URL(request.url);
    const sourceId = chatConversationId(url.searchParams.get("conversation"));
    const body = plainObject(await readJsonBody(request));
    const targets = Array.isArray(body.targets)
        ? Array.from(new Set(body.targets.map((item) => chatConversationId(item)).filter(Boolean))).slice(0, 9)
        : [];

    if (!sourceId) {
        return jsonResponse({ error: "bad_request", message: "缺少 conversation" }, 400, cors);
    }
    if (!targets.length) {
        return jsonResponse({ error: "bad_request", message: "请选择要转发到的会话" }, 400, cors);
    }

    const result = await withStoreLock(async () => {
        const loadedSource = await loadConversationFor(env, sourceId, login, cors);
        if (loadedSource.error) {
            return { error: loadedSource.error };
        }
        const sourceMessages = await readChatMessages(env, sourceId);
        const source = sourceMessages.find((item) => item.id === messageId);
        if (!source || source.recalled) {
            return { error: jsonResponse({ error: "not_found", message: "要转发的消息不存在或已撤回" }, 404, cors) };
        }

        const delivered = [];
        for (const targetId of targets) {
            const loaded = await loadConversationFor(env, targetId, login, cors);
            if (loaded.error) {
                continue;
            }
            const conv = loaded.conv;
            const at = Date.now();
            const message = {
                id: randomCode(9),
                conversation: conv.id,
                sender: login,
                senderName: chatMemberAlias(conv, accounts, login),
                type: source.type === "system" ? "text" : source.type,
                text: source.text,
                media: source.media || null,
                replyTo: null,
                mentions: [],
                forwarded: true,
                forwardedFrom: source.senderName || "",
                at,
                time: shanghaiTimestamp(at)
            };
            await appendMessage(env, conv, message);
            await saveConversation(env, conv);
            if (conv.type === "direct") {
                for (const member of conv.members) {
                    await ensureConversationEntry(env, member, conv.id);
                }
            }
            delivered.push({
                conversation: conv.id,
                targets: conversationTargets(conv, accounts),
                message
            });
        }

        return { delivered };
    });

    if (result.error) {
        return result.error;
    }

    for (const item of result.delivered) {
        await notifyChat(env, item.targets, {
            type: "message",
            conversation: item.conversation,
            message: messageView(item.message)
        });
    }

    return jsonResponse({
        ok: true,
        count: result.delivered.length,
        messages: result.delivered.map((item) => ({ conversation: item.conversation, message: messageView(item.message) }))
    }, 201, cors);
}

async function handleChatDeleteMessage(request, env, cors, messageId, adminOnly) {
    const session = adminOnly
        ? await requireAdmin(request, env, cors)
        : await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const url = new URL(request.url);
    const id = chatConversationId(url.searchParams.get("conversation"));

    if (!id) {
        return jsonResponse({ error: "bad_request", message: "缺少 conversation" }, 400, cors);
    }

    const result = await withStoreLock(async () => {
        const loaded = await loadConversationFor(env, id, login, cors);
        if (loaded.error) {
            return { error: loaded.error };
        }
        const conv = loaded.conv;
        const messages = await readChatMessages(env, id);
        const message = messages.find((item) => item.id === messageId);
        if (!message) {
            return { error: jsonResponse({ error: "not_found", message: "消息不存在" }, 404, cors) };
        }

        const allowed = isPlatformAdmin(env, login)
            || (conv.type === "group" && canManageGroup(env, conv, login))
            || (conv.type === "direct" && message.sender === login);

        if (!allowed) {
            return { error: jsonResponse({ error: "forbidden", message: "没有删除这条消息的权限" }, 403, cors) };
        }

        const kept = messages.filter((item) => item.id !== messageId);
        await saveChatMessages(env, id, kept);

        if (conv.lastMessage && conv.lastMessage.id === messageId) {
            conv.lastMessage = kept.length ? kept[kept.length - 1] : null;
            await saveConversation(env, conv);
        }

        return { targets: conversationTargets(conv, accounts) };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "message:delete", conversation: id, messageId });
    return jsonResponse({ ok: true, conversation: id, messageId, deleted: true }, 200, cors);
}

async function handleChatSearch(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const url = new URL(request.url);
    const query = String(url.searchParams.get("q") || "").trim();
    const only = chatConversationId(url.searchParams.get("conversation"));

    if (!query) {
        return jsonResponse({ error: "bad_request", message: "请输入要搜索的内容" }, 400, cors);
    }
    if (query.length > 50) {
        return jsonResponse({ error: "bad_request", message: "搜索内容最长 50 个字符" }, 400, cors);
    }

    const results = await withStoreLock(async () => {
        const record = await loadChatUser(env, login);
        const ids = only ? [only] : record.conversations.map((item) => item.id);
        const needle = query.toLowerCase();
        const output = [];

        for (const id of ids) {
            if (!chatConversationId(id)) {
                continue;
            }
            const conv = await readConversation(env, id);
            if (!conv || !chatMemberOf(conv, login)) {
                continue;
            }
            const entry = chatEntry(record, id);
            const messages = visibleChatMessages(await readChatMessages(env, id), entry);
            const name = conv.type === "direct"
                ? chatDisplayName(accounts, (conv.members || []).find((item) => item !== login))
                : conv.name;

            for (const message of messages) {
                if (message.recalled || message.system) {
                    continue;
                }
                const haystack = `${message.text || ""} ${message.media && message.media.name ? message.media.name : ""}`.toLowerCase();
                if (!haystack.includes(needle)) {
                    continue;
                }
                output.push({
                    conversation: id,
                    conversationName: name,
                    conversationType: conv.type,
                    message: messageView(message)
                });
            }
        }

        output.sort((left, right) => right.message.at - left.message.at);
        return output.slice(0, CHAT_SEARCH_LIMIT);
    });

    return jsonResponse({ ok: true, query, count: results.length, results }, 200, cors);
}

async function handleChatUsers(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const url = new URL(request.url);
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const record = await readChatUser(env, login);
    const output = [];

    for (const [name, account] of Object.entries(accounts)) {
        if (name === login) {
            continue;
        }
        const username = String(account && account.username || name);
        if (query && !name.toLowerCase().includes(query) && !username.toLowerCase().includes(query)) {
            continue;
        }
        output.push({
            login: name,
            username,
            friend: record.friends.some((item) => item.login === name),
            blocked: record.blocked.includes(name),
            incoming: record.incoming.some((item) => item.from === name),
            outgoing: record.outgoing.some((item) => item.to === name)
        });
    }

    output.sort((left, right) => Number(right.friend) - Number(left.friend) || left.login.localeCompare(right.login));
    return jsonResponse({ ok: true, query, users: output.slice(0, 30) }, 200, cors);
}

async function handleChatContacts(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const record = await loadChatUser(env, login);
    const withName = (entry) => ({ ...entry, username: chatDisplayName(accounts, entry.login || entry.from || entry.to) });

    return jsonResponse({
        ok: true,
        me: { login, username: chatDisplayName(accounts, login) },
        friends: record.friends.map((item) => withName({ login: item.login, since: item.since || "" })),
        blocked: record.blocked.map((item) => withName({ login: item })),
        incoming: record.incoming.map((item) => ({
            id: item.id,
            from: item.from,
            username: chatDisplayName(accounts, item.from),
            note: item.note || "",
            time: item.time || ""
        })),
        outgoing: record.outgoing.map((item) => ({
            id: item.id,
            to: item.to,
            username: chatDisplayName(accounts, item.to),
            note: item.note || "",
            time: item.time || ""
        }))
    }, 200, cors);
}

async function handleChatFriendRequest(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));
    const target = String(body.login || "").trim();
    const note = String(body.note || "").trim().slice(0, CHAT_NOTE_MAX);

    if (!target || target === login) {
        return jsonResponse({ error: "bad_request", message: "请选择要添加的用户" }, 400, cors);
    }
    if (!accounts[target]) {
        return jsonResponse({ error: "not_found", message: "用户不存在" }, 404, cors);
    }

    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const mine = await readChatUser(env, login);
        const theirs = await readChatUser(env, target);

        if (mine.friends.some((item) => item.login === target)) {
            return { error: jsonResponse({ error: "already_friends", message: "你们已经是好友了" }, 409, cors) };
        }
        if (mine.blocked.includes(target) || theirs.blocked.includes(login)) {
            return { error: jsonResponse({ error: "blocked", message: "对方或你已把对方拉黑" }, 403, cors) };
        }

        const reciprocal = theirs.incoming.find((item) => item.from === login);
        if (reciprocal) {
            theirs.incoming = theirs.incoming.filter((item) => item.id !== reciprocal.id);
            mine.outgoing = mine.outgoing.filter((item) => item.to !== target);
            const now = shanghaiTimestamp();
            mine.friends.push({ login: target, since: now });
            theirs.friends.push({ login, since: now });
            await saveChatUser(env, login, mine);
            await saveChatUser(env, target, theirs);
            const conv = await ensureDirectConversation(env, login, target);
            const record = await loadChatUser(env, login);
            const messages = await readChatMessages(env, conv.id);
            return {
                accepted: true,
                view: conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts)
            };
        }

        const existing = mine.outgoing.find((item) => item.to === target);
        if (existing) {
            return { error: jsonResponse({ error: "already_requested", message: "已经发送过好友申请" }, 409, cors) };
        }

        const request = {
            id: `fr_${randomCode(6)}`,
            from: login,
            to: target,
            note,
            at: Date.now(),
            time: shanghaiTimestamp()
        };
        mine.outgoing.push(request);
        theirs.incoming.push(request);
        await saveChatUser(env, login, mine);
        await saveChatUser(env, target, theirs);
        return { request };
    });

    if (result.error) {
        return result.error;
    }

    if (result.accepted) {
        await notifyChat(env, [target], { type: "friend:accept", login, conversation: result.view });
        return jsonResponse({ ok: true, accepted: true, conversation: result.view }, 200, cors);
    }

    await notifyChat(env, [target], {
        type: "friend:request",
        request: { id: result.request.id, from: login, username: chatDisplayName(accounts, login), note, time: result.request.time }
    });
    return jsonResponse({ ok: true, accepted: false, request: result.request }, 201, cors);
}

async function handleChatFriendDecision(request, env, cors, requestId, action) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const accept = action === "accept";

    const result = await withStoreLock(async () => {
        const mine = await readChatUser(env, login);
        const incoming = mine.incoming.find((item) => item.id === requestId);
        if (!incoming) {
            return { error: jsonResponse({ error: "not_found", message: "好友申请不存在或已处理" }, 404, cors) };
        }
        if (!accounts[incoming.from]) {
            return { error: jsonResponse({ error: "not_found", message: "申请人账户已不存在" }, 404, cors) };
        }

        mine.incoming = mine.incoming.filter((item) => item.id !== requestId);
        const theirs = await readChatUser(env, incoming.from);
        theirs.outgoing = theirs.outgoing.filter((item) => item.id !== requestId);

        let view = null;
        if (accept) {
            const now = shanghaiTimestamp();
            if (!mine.friends.some((item) => item.login === incoming.from)) {
                mine.friends.push({ login: incoming.from, since: now });
            }
            if (!theirs.friends.some((item) => item.login === login)) {
                theirs.friends.push({ login, since: now });
            }
            await saveChatUser(env, login, mine);
            await saveChatUser(env, incoming.from, theirs);
            const conv = await ensureDirectConversation(env, login, incoming.from);
            const record = await loadChatUser(env, login);
            const messages = await readChatMessages(env, conv.id);
            view = conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts);
        } else {
            await saveChatUser(env, login, mine);
            await saveChatUser(env, incoming.from, theirs);
        }

        return { accepted: accept, peer: incoming.from, view };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, [result.peer], {
        type: accept ? "friend:accept" : "friend:decline",
        login,
        conversation: result.view
    });
    return jsonResponse({
        ok: true,
        accepted: result.accepted,
        login: result.peer,
        conversation: result.view
    }, 200, cors);
}

async function handleChatRemoveFriend(request, env, cors, target) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const result = await withStoreLock(async () => {
        const mine = await readChatUser(env, login);
        const theirs = await readChatUser(env, target);
        const had = mine.friends.some((item) => item.login === target);
        if (!had) {
            return { error: jsonResponse({ error: "not_found", message: "对方不是你的好友" }, 404, cors) };
        }
        mine.friends = mine.friends.filter((item) => item.login !== target);
        theirs.friends = theirs.friends.filter((item) => item.login !== login);
        await saveChatUser(env, login, mine);
        await saveChatUser(env, target, theirs);
        return { ok: true };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, [target], { type: "friend:remove", login });
    return jsonResponse({ ok: true, login: target, removed: true }, 200, cors);
}

async function handleChatBlock(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const body = plainObject(await readJsonBody(request));
    const target = String(body.login || "").trim();

    if (!target || target === login) {
        return jsonResponse({ error: "bad_request", message: "请选择要拉黑的用户" }, 400, cors);
    }
    if (!accounts[target]) {
        return jsonResponse({ error: "not_found", message: "用户不存在" }, 404, cors);
    }

    await withStoreLock(async () => {
        const mine = await readChatUser(env, login);
        const theirs = await readChatUser(env, target);
        if (!mine.blocked.includes(target)) {
            mine.blocked.push(target);
        }
        mine.friends = mine.friends.filter((item) => item.login !== target);
        theirs.friends = theirs.friends.filter((item) => item.login !== login);
        await saveChatUser(env, login, mine);
        await saveChatUser(env, target, theirs);
    });

    return jsonResponse({ ok: true, login: target, blocked: true }, 200, cors);
}

async function handleChatUnblock(request, env, cors, target) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const result = await withStoreLock(async () => {
        const mine = await readChatUser(env, login);
        if (!mine.blocked.includes(target)) {
            return { error: jsonResponse({ error: "not_found", message: "对方不在黑名单里" }, 404, cors) };
        }
        mine.blocked = mine.blocked.filter((item) => item !== target);
        await saveChatUser(env, login, mine);
        return { ok: true };
    });

    if (result.error) {
        return result.error;
    }

    return jsonResponse({ ok: true, login: target, blocked: false }, 200, cors);
}

async function handleChatMediaUpload(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    if (throttled(chatMediaAttempts, clientIp(request), CHAT_MEDIA_WINDOW_MS, CHAT_MEDIA_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "上传过于频繁，请稍后再试" }, 429, cors);
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    if (!accounts[login]) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > CHAT_MEDIA_MAX_BYTES) {
        return jsonResponse({ error: "payload_too_large", message: "文件不能超过 4 MB" }, 413, cors);
    }

    let body;
    try {
        body = await request.arrayBuffer();
    } catch (error) {
        return jsonResponse({ error: "bad_request", message: "读取文件失败" }, 400, cors);
    }

    if (!body || !body.byteLength) {
        return jsonResponse({ error: "bad_request", message: "文件是空的" }, 400, cors);
    }
    if (body.byteLength > CHAT_MEDIA_MAX_BYTES) {
        return jsonResponse({ error: "payload_too_large", message: "文件不能超过 4 MB" }, 413, cors);
    }

    const rawName = String(request.headers.get("x-file-name") || "file");
    let name = "file";
    try {
        name = decodeURIComponent(rawName);
    } catch (error) {
        name = rawName;
    }
    name = name.replace(/[\r\n]+/g, " ").slice(0, 100) || "file";

    const type = String(request.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase()
        || "application/octet-stream";
    const id = randomCode(9);
    const at = Date.now();
    const expiresAt = at + CHAT_MEDIA_TTL_SECONDS * 1000;

    await env.ACCOUNTS_KV.put(chatMediaKey(id), body, { expirationTtl: CHAT_MEDIA_TTL_SECONDS });
    await env.ACCOUNTS_KV.put(chatMediaMetaKey(id), JSON.stringify({
        id,
        name,
        type,
        size: body.byteLength,
        uploader: login,
        at,
        expiresAt
    }), { expirationTtl: CHAT_MEDIA_TTL_SECONDS });

    return jsonResponse({
        ok: true,
        media: { id, name, type, size: body.byteLength, expiresAt, ttlSeconds: CHAT_MEDIA_TTL_SECONDS }
    }, 201, cors);
}

async function requireSessionOrToken(request, env, cors) {
    const header = request.headers.get("Authorization") || "";
    if (header.toLowerCase().startsWith("bearer ")) {
        return await requireSession(request, env, cors);
    }
    const url = new URL(request.url);
    const token = String(url.searchParams.get("token") || "");
    if (!token) {
        return await requireSession(request, env, cors);
    }
    const payload = await verifyToken(token, env.SIGNING_SECRET);
    if (!payload) {
        return { error: jsonResponse({ error: "unauthorized", message: "token 无效或已过期" }, 401, cors) };
    }
    return { payload };
}

async function handleChatMediaGet(request, env, cors, id) {
    const session = await requireSessionOrToken(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const meta = plainObject(await env.ACCOUNTS_KV.get(chatMediaMetaKey(id), "json"));
    if (!meta.id) {
        return jsonResponse({
            error: "media_expired",
            message: "图片或文件已过期（上传后 20 分钟自动删除）"
        }, 410, cors);
    }

    const body = await env.ACCOUNTS_KV.get(chatMediaKey(id), "arrayBuffer");
    if (!body) {
        return jsonResponse({ error: "media_expired", message: "图片或文件已过期" }, 410, cors);
    }

    return new Response(body, {
        status: 200,
        headers: {
            ...cors,
            "content-type": meta.type || "application/octet-stream",
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name || "file")}`,
            "cache-control": "private, max-age=120"
        }
    });
}

async function handleChatAdminConversations(request, env, cors) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const accounts = await loadAccounts(env);
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 500);

    const conversations = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const index = await readChatIndex(env);
        const output = [];

        for (const id of index.slice(-limit).reverse()) {
            const conv = await readConversation(env, id);
            if (!conv) {
                continue;
            }
            const messages = await readChatMessages(env, id);
            output.push({
                ...conversationView(env, conv, null, messages, session.payload.sub, accounts),
                members: conv.public ? Object.keys(accounts) : conv.members.slice(),
                messageCount: messages.length
            });
        }

        return output;
    });

    return jsonResponse({ ok: true, count: conversations.length, conversations }, 200, cors);
}

async function handleChatAdminMessages(request, env, cors, id) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const conv = await readConversation(env, id);
    if (!conv) {
        return jsonResponse({ error: "not_found", message: "会话不存在" }, 404, cors);
    }

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), CHAT_MESSAGE_LIMIT);
    const messages = await readChatMessages(env, id);
    const accounts = await loadAccounts(env);

    return jsonResponse({
        ok: true,
        conversation: conversationView(env, conv, null, messages, session.payload.sub, accounts),
        members: conv.public ? Object.keys(accounts) : conv.members.slice(),
        messages: messages.slice(-limit).map(messageView)
    }, 200, cors);
}

async function handleChatAdminDeleteConversation(request, env, cors, id) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const result = await withStoreLock(async () => {
        const conv = await readConversation(env, id);
        if (!conv) {
            return { error: jsonResponse({ error: "not_found", message: "会话不存在" }, 404, cors) };
        }
        const targets = conversationTargets(conv, await loadAccounts(env));
        if (!conv.public) {
            await appendSystemMessage(env, conv, "站主解散了这个会话");
            await saveConversation(env, conv);
        }
        await deleteChatConversation(env, conv);
        return { targets };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:remove", conversation: id, by: session.payload.sub });
    return jsonResponse({ ok: true, conversation: id, deleted: true }, 200, cors);
}

async function handleChatRoomCompat(request, env, cors) {
    const url = new URL(request.url);
    const room = String(url.searchParams.get("room") || "").trim();

    if (request.method === "GET") {
        if (!chatConversationId(room)) {
            return jsonResponse({ error: "bad_request", message: "房间名称不合法" }, 400, cors);
        }
        return await handleChatMessagesList(request, env, cors, room);
    }

    if (request.method === "POST") {
        const body = plainObject(await readJsonBody(request));
        const target = String(body.room || room || "").trim();
        if (!chatConversationId(target)) {
            return jsonResponse({ error: "bad_request", message: "房间名称不合法" }, 400, cors);
        }
        const cloned = new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify({ ...body, type: "text" })
        });
        return await handleChatSend(cloned, env, cors, target, target);
    }

    return jsonResponse({ error: "method_not_allowed", message: "不支持的方法" }, 405, cors);
}

async function handleChatSocket(request, env, cors) {
    if (!chatEnabled(env) || !hasKv(env)) {
        return chatNotReady(cors);
    }

    const url = new URL(request.url);
    const token = String(url.searchParams.get("token") || "");
    const header = request.headers.get("Authorization") || "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const payload = await verifyToken(token || bearer, env.SIGNING_SECRET);

    if (!payload) {
        return jsonResponse({ error: "unauthorized", message: "token 无效或已过期" }, 401, cors);
    }

    if (!env.CHAT || typeof env.CHAT.idFromName !== "function") {
        return jsonResponse({
            error: "chat_ws_unavailable",
            message: "实时通道未配置，请降级使用轮询",
            realtime: "polling"
        }, 503, cors);
    }

    const headers = new Headers();
    headers.set("upgrade", "websocket");
    headers.set("x-vtx-login", payload.sub);
    const stub = env.CHAT.get(env.CHAT.idFromName("hub"));
    return await stub.fetch("https://chat-hub/ws", { headers });
}

async function routeChat(request, env, cors) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/api/chat/status" && method === "GET") {
        return handleChatStatus(request, env, cors);
    }

    if (path === "/api/chat/ws" && method === "GET") {
        return await handleChatSocket(request, env, cors);
    }

    if (path === "/api/chat/conversations" && method === "GET") {
        return await handleChatConversations(request, env, cors);
    }

    if (path === "/api/chat/conversations/direct" && method === "POST") {
        return await handleChatDirect(request, env, cors);
    }

    if (path === "/api/chat/conversations/group" && method === "POST") {
        return await handleChatCreateGroup(request, env, cors);
    }

    if (path === "/api/chat/search" && method === "GET") {
        return await handleChatSearch(request, env, cors);
    }

    if (path === "/api/chat/users" && method === "GET") {
        return await handleChatUsers(request, env, cors);
    }

    if (path === "/api/chat/contacts" && method === "GET") {
        return await handleChatContacts(request, env, cors);
    }

    if (path === "/api/chat/friends/requests" && method === "POST") {
        return await handleChatFriendRequest(request, env, cors);
    }

    if (path === "/api/chat/blocks" && method === "POST") {
        return await handleChatBlock(request, env, cors);
    }

    if (path === "/api/chat/media") {
        if (method === "POST") {
            return await handleChatMediaUpload(request, env, cors);
        }
    }

    if (path === "/api/chat/messages") {
        if (method === "GET" || method === "POST") {
            return await handleChatRoomCompat(request, env, cors);
        }
    }

    if (path === "/api/chat/admin/conversations" && method === "GET") {
        return await handleChatAdminConversations(request, env, cors);
    }

    let match = path.match(/^\/api\/chat\/conversations\/([^/]+)\/messages$/);
    if (match) {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        if (method === "GET") {
            return await handleChatMessagesList(request, env, cors, id);
        }
        if (method === "POST") {
            return await handleChatSend(request, env, cors, id);
        }
    }

    match = path.match(/^\/api\/chat\/conversations\/([^/]+)\/(read|typing|settings|clear|leave|members|owner|admins|announcement|me|join)$/);
    if (match) {
        const id = chatConversationId(decodeURIComponent(match[1]));
        const action = match[2];
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        if (action === "read" && method === "POST") {
            return await handleChatRead(request, env, cors, id);
        }
        if (action === "typing" && method === "POST") {
            return await handleChatTyping(request, env, cors, id);
        }
        if (action === "settings" && method === "POST") {
            return await handleChatSettings(request, env, cors, id);
        }
        if (action === "clear" && method === "POST") {
            return await handleChatClear(request, env, cors, id);
        }
        if (action === "leave" && method === "POST") {
            return await handleChatLeave(request, env, cors, id);
        }
        if (action === "members" && method === "POST") {
            return await handleChatAddMembers(request, env, cors, id);
        }
        if (action === "owner" && method === "POST") {
            return await handleChatTransferOwner(request, env, cors, id);
        }
        if (action === "admins" && method === "POST") {
            return await handleChatAdmins(request, env, cors, id, "", false);
        }
        if (action === "announcement" && method === "PUT") {
            return await handleChatAnnouncement(request, env, cors, id);
        }
        if (action === "me" && method === "PATCH") {
            return await handleChatMemberAlias(request, env, cors, id);
        }
        if (action === "join" && method === "POST") {
            const session = await requireSession(request, env, cors);
            if (session.error) {
                return session.error;
            }
            const guard = chatGuard(env, cors);
            if (guard) {
                return guard;
            }
            const conv = await readConversation(env, id);
            if (!conv) {
                return jsonResponse({ error: "not_found", message: "会话不存在" }, 404, cors);
            }
            const login = session.payload.sub;
            if (!conv.public && !chatMemberOf(conv, login)) {
                return chatNotAMember(cors);
            }
            await withStoreLock(async () => {
                const record = await loadChatUser(env, login);
                const entry = chatEntry(record, id);
                if (entry) {
                    entry.hidden = false;
                } else {
                    record.conversations.push({
                        id,
                        pinned: false,
                        muted: false,
                        joinedAt: shanghaiTimestamp(),
                        lastRead: 0,
                        clearedAt: 0,
                        hidden: false
                    });
                }
                await saveChatUser(env, login, record);
            });
            return jsonResponse({ ok: true, conversation: id, joined: true }, 200, cors);
        }
    }

    match = path.match(/^\/api\/chat\/conversations\/([^/]+)\/members\/([^/]+)$/);
    if (match && method === "DELETE") {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        return await handleChatRemoveMember(request, env, cors, id, decodeURIComponent(match[2]));
    }

    match = path.match(/^\/api\/chat\/conversations\/([^/]+)\/admins\/([^/]+)$/);
    if (match && method === "DELETE") {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        return await handleChatAdmins(request, env, cors, id, decodeURIComponent(match[2]), true);
    }

    match = path.match(/^\/api\/chat\/conversations\/([^/]+)\/announcement\/pin$/);
    if (match && method === "POST") {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        return await handleChatAnnouncementPin(request, env, cors, id);
    }

    match = path.match(/^\/api\/chat\/conversations\/([^/]+)$/);
    if (match) {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        if (method === "GET") {
            return await handleChatConversationDetail(request, env, cors, id);
        }
        if (method === "PATCH") {
            return await handleChatRename(request, env, cors, id);
        }
        if (method === "DELETE") {
            return await handleChatDeleteConversation(request, env, cors, id);
        }
    }

    match = path.match(/^\/api\/chat\/messages\/([^/]+)\/recall$/);
    if (match && method === "POST") {
        return await handleChatRecall(request, env, cors, decodeURIComponent(match[1]));
    }

    match = path.match(/^\/api\/chat\/messages\/([^/]+)\/forward$/);
    if (match && method === "POST") {
        return await handleChatForward(request, env, cors, decodeURIComponent(match[1]));
    }

    match = path.match(/^\/api\/chat\/messages\/([^/]+)$/);
    if (match && method === "DELETE") {
        return await handleChatDeleteMessage(request, env, cors, decodeURIComponent(match[1]), false);
    }

    match = path.match(/^\/api\/chat\/friends\/requests\/([^/]+)\/(accept|decline)$/);
    if (match && method === "POST") {
        return await handleChatFriendDecision(request, env, cors, decodeURIComponent(match[1]), match[2]);
    }

    match = path.match(/^\/api\/chat\/friends\/([^/]+)$/);
    if (match && method === "DELETE") {
        return await handleChatRemoveFriend(request, env, cors, decodeURIComponent(match[1]));
    }

    match = path.match(/^\/api\/chat\/blocks\/([^/]+)$/);
    if (match && method === "DELETE") {
        return await handleChatUnblock(request, env, cors, decodeURIComponent(match[1]));
    }

    match = path.match(/^\/api\/chat\/media\/([^/]+)$/);
    if (match && method === "GET") {
        const id = String(decodeURIComponent(match[1]));
        if (!CHAT_MEDIA_ID_PATTERN.test(id)) {
            return jsonResponse({ error: "bad_request", message: "media id 不合法" }, 400, cors);
        }
        return await handleChatMediaGet(request, env, cors, id);
    }

    match = path.match(/^\/api\/chat\/admin\/conversations\/([^/]+)\/messages$/);
    if (match && method === "GET") {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        return await handleChatAdminMessages(request, env, cors, id);
    }

    match = path.match(/^\/api\/chat\/admin\/conversations\/([^/]+)$/);
    if (match && method === "DELETE") {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        return await handleChatAdminDeleteConversation(request, env, cors, id);
    }

    match = path.match(/^\/api\/chat\/admin\/messages\/([^/]+)$/);
    if (match && method === "DELETE") {
        return await handleChatDeleteMessage(request, env, cors, decodeURIComponent(match[1]), true);
    }

    return null;
}

/* ───────────────── ChatHub：WebSocket 实时推送 ───────────────── */

export class ChatHub {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.sockets = new Map();
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/notify" && request.method === "POST") {
            let payload = {};
            try {
                payload = await request.json();
            } catch (error) {
                payload = {};
            }
            const targets = Array.isArray(payload.targets) ? payload.targets : [];
            const exclude = typeof payload.exclude === "string" ? payload.exclude : "";
            this.publish(targets, payload.event || {}, exclude);
            return jsonResponse({ ok: true, online: Array.from(this.sockets.keys()) }, 200, {});
        }

        if (url.pathname === "/presence" && request.method === "GET") {
            return jsonResponse({ ok: true, online: Array.from(this.sockets.keys()) }, 200, {});
        }

        if (url.pathname === "/ws") {
            const upgrade = String(request.headers.get("Upgrade") || request.headers.get("upgrade") || "").toLowerCase();
            if (upgrade !== "websocket") {
                return jsonResponse({ error: "upgrade_required", message: "需要 WebSocket 升级请求" }, 426, {});
            }

            const login = String(request.headers.get("x-vtx-login") || "").trim();
            if (!login) {
                return jsonResponse({ error: "unauthorized", message: "缺少登录信息" }, 401, {});
            }

            const pair = new WebSocketPair();
            const client = pair[0];
            const server = pair[1];
            server.accept();
            this.attach(login, server);

            server.addEventListener("message", (event) => this.onMessage(login, server, event.data));
            server.addEventListener("close", () => this.detach(login, server));
            server.addEventListener("error", () => this.detach(login, server));

            this.send(server, {
                type: "hello",
                login,
                online: Array.from(this.sockets.keys()),
                at: Date.now()
            });
            this.publish(Array.from(this.sockets.keys()), {
                type: "presence",
                online: Array.from(this.sockets.keys())
            });

            return new Response(null, { status: 101, webSocket: client });
        }

        return jsonResponse({ error: "not_found", message: "未知的 ChatHub 接口" }, 404, {});
    }

    attach(login, socket) {
        let set = this.sockets.get(login);
        if (!set) {
            set = new Set();
            this.sockets.set(login, set);
        }
        set.add(socket);
    }

    detach(login, socket) {
        const set = this.sockets.get(login);
        if (set) {
            set.delete(socket);
            if (!set.size) {
                this.sockets.delete(login);
            }
        }
        this.publish(Array.from(this.sockets.keys()), {
            type: "presence",
            online: Array.from(this.sockets.keys())
        });
    }

    onMessage(login, socket, raw) {
        let data = null;
        try {
            data = JSON.parse(String(raw));
        } catch (error) {
            data = null;
        }
        if (!data || typeof data !== "object") {
            return;
        }
        if (data.type === "ping") {
            this.send(socket, { type: "pong", at: Date.now() });
        }
        if (data.type === "presence") {
            this.send(socket, { type: "presence", online: Array.from(this.sockets.keys()) });
        }
    }

    send(socket, data) {
        try {
            socket.send(JSON.stringify(data));
        } catch (error) {
            /* 忽略已经关闭的连接 */
        }
    }

    publish(targets, event, exclude) {
        if (!event || typeof event !== "object") {
            return;
        }
        const text = JSON.stringify(event);
        const seen = new Set();

        for (const login of targets) {
            if (!login || login === exclude) {
                continue;
            }
            const set = this.sockets.get(login);
            if (!set) {
                continue;
            }
            for (const socket of set) {
                if (seen.has(socket)) {
                    continue;
                }
                seen.add(socket);
                try {
                    socket.send(text);
                } catch (error) {
                    /* 忽略已经关闭的连接 */
                }
            }
        }
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const cors = corsHeaders(env, request);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: cors });
        }

        if (!cors["access-control-allow-origin"] && request.headers.get("Origin")) {
            return jsonResponse({ error: "origin_not_allowed", message: "该站点未被允许调用此 API" }, 403, cors);
        }

        try {
            if (url.pathname === "/" || url.pathname === "/api" || url.pathname === "/api/health") {
                return jsonResponse({
                    name: "Vitual XRing API",
                    version: VERSION,
                    ok: true,
                    storage: hasKv(env) ? "workers-kv" : "github",
                    chat: {
                        version: CHAT_VERSION,
                        enabled: chatEnabled(env)
                    }
                }, 200, cors);
            }

            if (url.pathname === "/api/login" && request.method === "POST") {
                return await handleLogin(request, env, cors);
            }

            if (url.pathname === "/api/register" && request.method === "POST") {
                return await handleRegister(request, env, cors);
            }

            if (url.pathname === "/api/me" && request.method === "GET") {
                return await handleMe(request, env, cors);
            }

            const mePath = url.pathname.match(/^\/api\/me\/data(?:\/([^/]+))?(?:\/([^/]+))?$/);
            if (mePath) {
                const game = mePath[1] ? decodeURIComponent(mePath[1]) : "";
                const key = mePath[2] ? decodeURIComponent(mePath[2]) : "";
                const method = request.method;

                if (!game) {
                    return jsonResponse({
                        error: "bad_request",
                        message: "写入数据需要指定游戏名称：PUT /api/me/data/{游戏名称}，body 为该游戏的 JSON 对象"
                    }, 400, cors);
                }

                const session = await requireSession(request, env, cors);
                if (session.error) {
                    return session.error;
                }

                if (method === "PUT" && !key) {
                    return await handleSetData(request, env, cors, session.payload.sub, game);
                }
                if (method === "GET" && !key) {
                    return await handleGetData(request, env, cors, session.payload.sub, game);
                }
                if (method === "DELETE") {
                    return await handleDeleteData(request, env, cors, session.payload.sub, game, key);
                }
            }

            if (url.pathname === "/api/me/trades" && request.method === "POST") {
                return await handleTrade(request, env, cors, null);
            }

            if (url.pathname === "/api/me/receipt-code") {
                if (request.method === "POST") {
                    return await handleCreateReceiptCode(request, env, cors);
                }
                if (request.method === "GET") {
                    return await handleGetReceiptCode(request, env, cors);
                }
                if (request.method === "DELETE") {
                    return await handleDeleteReceiptCode(request, env, cors);
                }
            }

            const receiptRoute = url.pathname.match(/^\/api\/receipt-codes\/([^/]+)(\/pay)?$/);
            if (receiptRoute) {
                const code = decodeURIComponent(receiptRoute[1]);

                if (!RECEIPT_CODE_PATTERN.test(code)) {
                    return jsonResponse({ error: "bad_request", message: "收款码格式不正确" }, 400, cors);
                }

                if (receiptRoute[2] && request.method === "POST") {
                    return await handlePayReceiptCode(request, env, cors, code);
                }
                if (!receiptRoute[2] && request.method === "GET") {
                    return await handleResolveReceiptCode(request, env, cors, code);
                }
            }

            const tradeRoute = url.pathname.match(/^\/api\/accounts\/([^/]+)\/trades$/);
            if (tradeRoute && request.method === "POST") {
                return await handleTrade(request, env, cors, decodeURIComponent(tradeRoute[1]));
            }

            if (url.pathname === "/api/accounts" && request.method === "GET") {
                return await handleAccounts(request, env, cors);
            }

            const accountDataPath = url.pathname.match(/^\/api\/accounts\/([^/]+)\/data(?:\/([^/]+))?(?:\/([^/]+))?$/);
            if (accountDataPath) {
                const login = decodeURIComponent(accountDataPath[1]);
                const game = accountDataPath[2] ? decodeURIComponent(accountDataPath[2]) : "";
                const key = accountDataPath[3] ? decodeURIComponent(accountDataPath[3]) : "";
                const method = request.method;

                if (!game) {
                    return jsonResponse({
                        error: "bad_request",
                        message: `写入数据需要指定游戏名称：PUT /api/accounts/${login}/data/{游戏名称}`
                    }, 400, cors);
                }

                if (method === "PUT" && !key) {
                    return await handleSetData(request, env, cors, login, game);
                }
                if (method === "GET" && !key) {
                    return await handleGetData(request, env, cors, login, game);
                }
                if (method === "DELETE") {
                    return await handleDeleteData(request, env, cors, login, game, key);
                }
            }

            const accountRoute = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
            if (accountRoute && request.method === "GET") {
                return await handleAccount(request, env, cors, decodeURIComponent(accountRoute[1]));
            }

            if (url.pathname === "/api/me/username" && request.method === "PUT") {
                return await handleUpdateUsername(request, env, cors);
            }

            if (url.pathname === "/api/me/password" && request.method === "PUT") {
                return await handleUpdatePassword(request, env, cors);
            }

            if (url.pathname === "/api/me/checkin" && request.method === "POST") {
                return await handleCheckin(request, env, cors);
            }

            if (url.pathname === "/api/me/transfer" && request.method === "POST") {
                return await handleTransfer(request, env, cors);
            }

            if (url.pathname === "/api/me/withdraw" && request.method === "POST") {
                return await handleWithdraw(request, env, cors);
            }

            if (url.pathname === "/api/me/billing" && request.method === "POST") {
                return await handleBilling(request, env, cors);
            }

            if (url.pathname === "/api/me/purchase" && request.method === "POST") {
                return await handlePurchase(request, env, cors);
            }

            if (url.pathname === "/api/me/login-location" && request.method === "POST") {
                return await handleLoginLocation(request, env, cors);
            }

            if (url.pathname === "/api/admin/accounts") {
                if (request.method === "GET") {
                    return await handleAdminList(request, env, cors);
                }
                if (request.method === "POST") {
                    return await handleAdminCreate(request, env, cors);
                }
            }

            if (url.pathname === "/api/admin/log" && request.method === "GET") {
                return await handleAdminLog(request, env, cors);
            }

            const adminAccountRoute = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)$/);
            if (adminAccountRoute) {
                const login = decodeURIComponent(adminAccountRoute[1]);

                if (request.method === "PUT") {
                    return await handleAdminUpdate(request, env, cors, login);
                }
                if (request.method === "DELETE") {
                    return await handleAdminDelete(request, env, cors, login);
                }
            }

            if (url.pathname.startsWith("/api/chat/")) {
                const chatResponse = await routeChat(request, env, cors);
                if (chatResponse) {
                    return chatResponse;
                }
            }

            return jsonResponse({ error: "not_found", message: "接口不存在" }, 404, cors);
        } catch (error) {
            if (error instanceof HttpError) {
                return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
            }
            return jsonResponse({
                error: "upstream_error",
                message: String(error && error.message || error)
            }, 502, cors);
        }
    }
};