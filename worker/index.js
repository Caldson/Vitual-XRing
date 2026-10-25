/**
 * Vitual XRing 账户 API
 *
 * 8.0 起账户数据默认存放在 Workers KV（ACCOUNTS_KV）里，不再依赖公开的 account.json：
 *   首次读取时如果 KV 是空的，会自动把仓库里的 account.json 导入 KV，
 *   然后（MIGRATE_DELETE_REPO_FILE 未关闭时）删除仓库中的那份公开文件。
 *   未绑定 ACCOUNTS_KV 时退回 7.0 的行为（直接读写仓库里的 account.json）。
 *
 * 环境变量（wrangler.toml 的 [vars]）：
 *   REPO / BRANCH / PATH        迁移数据源（旧的 account.json）
 *   ALLOWED_ORIGINS             允许跨域的站点，逗号分隔，"*" 为任意
 *   TOKEN_TTL_SECONDS           登录 token 有效期（秒）
 *   CACHE_TTL_SECONDS           旧模式（GitHub）下 account.json 的内存缓存时间（秒）
 *   ADMIN_ACCOUNT               拥有管理权限的登录名，默认 Kitawaga
 *   MIGRATE_DELETE_REPO_FILE    迁移后是否删除仓库里的 account.json，默认 true
 *   MIRROR_TO_GITHUB            是否把 KV 数据镜像回仓库 account.json，默认 false
 *   CHAT_ENABLED                是否开放聊天室接口（9.0 才对外开放），默认 false
 *
 * 机密（wrangler secret put）：
 *   GITHUB_TOKEN                迁移 / 镜像时需要仓库 Contents 读写权限
 *   SIGNING_SECRET              签发 token 的 HMAC 密钥（必填）
 */

const VERSION = "8.0.0";
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
const CHAT_ROOM_MESSAGE_LIMIT = 300;
const MAX_CHAT_TEXT_LENGTH = 500;
const CHAT_WINDOW_MS = 60 * 1000;
const CHAT_MAX_ATTEMPTS = 30;
const CHAT_VERSION = "9.0";
const CHAT_ROOMS = [
    { id: "general", name: "大厅" },
    { id: "trade", name: "交易" },
    { id: "help", name: "求助" }
];
const CHAT_ROOM_PATTERN = /^[a-z0-9_-]{1,24}$/;
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
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type",
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

function shanghaiTimestamp() {
    const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
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

function chatEnabled(env) {
    return String(env.CHAT_ENABLED || "false") === "true";
}

function chatNotReady(cors) {
    return jsonResponse({
        error: "chat_not_ready",
        message: "版本9.0，我们聊天室见",
        version: CHAT_VERSION
    }, 503, cors);
}

function chatRoomKey(env, room) {
    return `chat:messages:${room}`;
}

function handleChatStatus(request, env, cors) {
    return jsonResponse({
        ok: true,
        version: CHAT_VERSION,
        status: chatEnabled(env) ? "ready" : "coming_soon",
        enabled: chatEnabled(env),
        rooms: CHAT_ROOMS,
        storage: hasKv(env) ? "workers-kv" : "unavailable",
        message: "版本9.0，我们聊天室见"
    }, 200, cors);
}

async function handleChatMessages(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (!chatEnabled(env) || !hasKv(env)) {
        return chatNotReady(cors);
    }

    const url = new URL(request.url);
    const room = String(url.searchParams.get("room") || CHAT_ROOMS[0].id).trim();

    if (!CHAT_ROOM_PATTERN.test(room)) {
        return jsonResponse({ error: "bad_request", message: "房间名称不合法" }, 400, cors);
    }

    const stored = await env.ACCOUNTS_KV.get(chatRoomKey(env, room), "json");
    const messages = Array.isArray(stored) ? stored : [];

    return jsonResponse({
        ok: true,
        room,
        limit: CHAT_ROOM_MESSAGE_LIMIT,
        messages: messages.slice(-CHAT_ROOM_MESSAGE_LIMIT)
    }, 200, cors);
}

async function handleChatPost(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (!chatEnabled(env) || !hasKv(env)) {
        return chatNotReady(cors);
    }

    if (throttled(chatAttempts, clientIp(request), CHAT_WINDOW_MS, CHAT_MAX_ATTEMPTS)) {
        return jsonResponse({ error: "too_many_requests", message: "发言过于频繁，请稍后再试" }, 429, cors);
    }

    const body = plainObject(await readJsonBody(request));
    const room = String(body.room || CHAT_ROOMS[0].id).trim();
    const text = String(body.text ?? "").trim();

    if (!CHAT_ROOM_PATTERN.test(room)) {
        return jsonResponse({ error: "bad_request", message: "房间名称不合法" }, 400, cors);
    }
    if (!text) {
        return jsonResponse({ error: "bad_request", message: "消息内容不能为空" }, 400, cors);
    }
    if (text.length > MAX_CHAT_TEXT_LENGTH) {
        return jsonResponse({ error: "bad_request", message: `消息最长 ${MAX_CHAT_TEXT_LENGTH} 个字符` }, 400, cors);
    }

    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const account = accounts[login];

    if (!account) {
        return jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors);
    }

    const key = chatRoomKey(env, room);
    const message = {
        id: randomCode(12),
        room,
        login,
        username: String(account.username || login),
        text,
        time: shanghaiTimestamp()
    };

    await withStoreLock(async () => {
        const stored = await env.ACCOUNTS_KV.get(key, "json");
        const messages = Array.isArray(stored) ? stored : [];
        messages.push(message);
        await env.ACCOUNTS_KV.put(key, JSON.stringify(messages.slice(-CHAT_ROOM_MESSAGE_LIMIT)));
    });

    return jsonResponse({ ok: true, message }, 201, cors);
}

async function handleChatDelete(request, env, cors, id) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }

    if (!hasKv(env)) {
        return chatNotReady(cors);
    }

    const url = new URL(request.url);
    const room = String(url.searchParams.get("room") || CHAT_ROOMS[0].id).trim();

    if (!CHAT_ROOM_PATTERN.test(room)) {
        return jsonResponse({ error: "bad_request", message: "房间名称不合法" }, 400, cors);
    }

    const key = chatRoomKey(env, room);
    let removed = false;

    await withStoreLock(async () => {
        const stored = await env.ACCOUNTS_KV.get(key, "json");
        const messages = Array.isArray(stored) ? stored : [];
        const kept = messages.filter((item) => String(item && item.id) !== id);
        removed = kept.length !== messages.length;
        await env.ACCOUNTS_KV.put(key, JSON.stringify(kept));
    });

    if (!removed) {
        return jsonResponse({ error: "not_found", message: "消息不存在" }, 404, cors);
    }

    return jsonResponse({ ok: true, removed: id, room }, 200, cors);
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

            if (url.pathname === "/api/chat/status" && request.method === "GET") {
                return handleChatStatus(request, env, cors);
            }

            if (url.pathname === "/api/chat/messages") {
                if (request.method === "GET") {
                    return await handleChatMessages(request, env, cors);
                }
                if (request.method === "POST") {
                    return await handleChatPost(request, env, cors);
                }
            }

            const chatMessageRoute = url.pathname.match(/^\/api\/chat\/messages\/([^/]+)$/);
            if (chatMessageRoute && request.method === "DELETE") {
                return await handleChatDelete(request, env, cors, decodeURIComponent(chatMessageRoute[1]));
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