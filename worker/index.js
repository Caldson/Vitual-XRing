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
 * 1.2.0 安全修复：
 *   - 附件只允许 png/jpeg/gif/webp 内联，其余按 attachment 下载（防同源存储型 XSS）
 *   - /api/me/purchase 的价格与库存由服务端按 shop.json 决定，忽略客户端 amount
 *   - 邀请码改用 CSPRNG，邀请 / 群号加入接口限流
 *   - 管理员登录名不可被注册或改名占用，/api/admin/accounts 不再返回明文密码
 *   - 密码改用 PBKDF2-SHA256 哈希存储，旧明文密码在首次登录成功后就地升级
 *   - 写账户前向 Durable Object AccountsLock 申请写锁，避免跨 isolate 并发覆盖余额
 *   - 未捕获异常不再把内部信息回给客户端
 *
 * 1.3.0 修复已知问题（#2）：
 *   - 前端聊天室改用 visualViewport 计算高度，修 iPad / iPhone 上消息区没有滚动条、
 *     输入框被顶到屏幕外的问题（服务端接口未变，只同步版本号便于前端校验）
 *
 * 1.4.0：
 *   - 面对面加群（4 / 8 位邀请码与群号）不再按 IP 限流
 *   - 管理员接口返回账户当前密码：密码仍是 PBKDF2 哈希，另存 AES-GCM 加密副本
 *     passwordSealed（密钥来自 secret PASSWORD_VIEW_KEY），登录 / 改密 / 建号时自动维护
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
 *   PASSWORD_VIEW_KEY           （可选，1.4.0）给管理员看的密码副本加密密钥；不配就不存副本
 */

const VERSION = "1.4.0";
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
const CHAT_VERSION = "1.4";
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
const CHAT_PUBLIC_GROUPS_KEY = "chat:public-groups";
const CHAT_PUBLIC_DESCRIPTION_MAX = 200;
const CHAT_PUBLIC_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/;
/* 1.0.0：账号 UID、群号、建群邀请码、拼手速红包 */
const CHAT_UID_START = 100001;
const CHAT_GROUP_NUMBER_MIN = 10000000;
const CHAT_GROUP_NUMBER_MAX = 99999999;
const CHAT_INVITE_PATTERN_4 = /^\d{4}$/;
const CHAT_INVITE_PATTERN_8 = /^\d{8}$/;
const CHAT_INVITE_TTL_SECONDS = 24 * 60 * 60;
const CHAT_INVITE_MAX_PARTICIPANTS = 100;
const CHAT_REDPACKET_MAX_CENTS = 20000000;
const CHAT_REDPACKET_ALLOW_LIMIT = 200;
const CHAT_REDPACKET_TTL_MS = 24 * 60 * 60 * 1000;
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
/* 1.2.0：商品价格与库存由服务端决定，最多一次买 999 件 */
const DEFAULT_SITE_ORIGIN = "https://xsmmc.caldson.us.ci";
const SHOP_CACHE_TTL_MS = 30 * 1000;
const SHOP_MAX_QUANTITY = 999;
/* 1.4.0：面对面加群（4 / 8 位邀请码与群号）不再按 IP 限流，删除了原来的 INVITE_* 节流 */
/* 1.2.0：聊天附件只允许这些类型内联显示，其余一律按下载处理 */
const CHAT_MEDIA_INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

/* ───────── 1.2.0：密码哈希（PBKDF2-SHA256，每账户独立盐） ───────── */

const PASSWORD_SCHEME = "pbkdf2-sha256";
const PASSWORD_ITERATIONS = 100000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BITS = 256;

function isPasswordHashed(value) {
    return typeof value === "string" && value.startsWith(`${PASSWORD_SCHEME}$`);
}

async function pbkdf2Bits(password, salt, iterations) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(String(password ?? "")),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        key,
        PASSWORD_KEY_BITS
    );
    return new Uint8Array(bits);
}

/* 1.4.0：账号修改页需要显示账户当前密码。
   密码本体仍是 PBKDF2 哈希（不可逆），另外存一份 AES-GCM 加密副本 passwordSealed：
   密钥由 secret PASSWORD_VIEW_KEY 经 SHA-256 派生，只有管理员接口会解密返回；
   没配置这个 secret 时不会写副本，接口返回 password: null。 */
const PASSWORD_VIEW_PREFIX = "aes-gcm";
const PASSWORD_VIEW_IV_BYTES = 12;

async function passwordViewKey(env) {
    const raw = String((env && env.PASSWORD_VIEW_KEY) || "");
    if (!raw) {
        return null;
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealPassword(env, password) {
    const key = await passwordViewKey(env);
    if (!key) {
        return null;
    }
    const iv = crypto.getRandomValues(new Uint8Array(PASSWORD_VIEW_IV_BYTES));
    const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(String(password ?? ""))
    );
    return `${PASSWORD_VIEW_PREFIX}$${encodeBase64Url(iv)}$${encodeBase64Url(new Uint8Array(sealed))}`;
}

async function openPassword(env, sealed) {
    const value = String(sealed ?? "");
    if (!value.startsWith(`${PASSWORD_VIEW_PREFIX}$`)) {
        return null;
    }
    const parts = value.split("$");
    if (parts.length !== 3 || !parts[1] || !parts[2]) {
        return null;
    }
    const key = await passwordViewKey(env);
    if (!key) {
        return null;
    }
    try {
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: decodeBase64Url(parts[1]) },
            key,
            decodeBase64Url(parts[2])
        );
        return new TextDecoder().decode(plain);
    } catch (error) {
        /* 换过 PASSWORD_VIEW_KEY 后旧副本解不开，按「没有记录」处理 */
        return null;
    }
}

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
    const derived = await pbkdf2Bits(password, salt, PASSWORD_ITERATIONS);
    return `${PASSWORD_SCHEME}$${PASSWORD_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
}

/* 兼容旧数据：还没哈希的记录用明文比对，登录成功后由调用方就地升级 */
async function verifyPasswordValue(stored, password) {
    const value = String(stored ?? "");

    if (!isPasswordHashed(value)) {
        return timingSafeEqual(value, String(password ?? ""));
    }

    const parts = value.split("$");
    const iterations = Number(parts[1]);
    if (parts.length !== 4 || !Number.isFinite(iterations) || iterations <= 0 || !parts[2] || !parts[3]) {
        return false;
    }

    const derived = await pbkdf2Bits(password, decodeBase64Url(parts[2]), iterations);
    return timingSafeEqual(encodeBase64Url(derived), parts[3]);
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
        uid: Number(source.uid) || 0,
        username: source.username || "",
        money: source.money || "0.00",
        trades: Array.isArray(source.trades) ? source.trades : [],
        data: source.data && typeof source.data === "object" && !Array.isArray(source.data) ? source.data : {}
    };
}

/* ───────── 1.0.0：账号 UID ───────── */

function nextUidFrom(accounts) {
    let max = CHAT_UID_START - 1;
    for (const account of Object.values(accounts || {})) {
        const value = Number(account && account.uid);
        if (Number.isFinite(value) && value > max) {
            max = value;
        }
    }
    return max + 1;
}

/* 给缺失 UID 的账户补号；只在确实需要写入时才占用写锁 */
async function ensureAccountUids(env, logins) {
    if (!hasKv(env)) {
        return await loadAccounts(env);
    }
    const current = await loadAccounts(env);
    const targets = Array.isArray(logins) && logins.length ? logins : Object.keys(current);
    const missing = targets.filter((login) => current[login] && !Number(current[login].uid));
    if (!missing.length) {
        return current;
    }
    const saved = await withStoreLock(async () => {
        const fresh = await readKvAccounts(env);
        let seq = nextUidFrom(fresh);
        let changed = false;
        for (const login of missing) {
            if (fresh[login] && !Number(fresh[login].uid)) {
                fresh[login].uid = seq;
                seq += 1;
                changed = true;
            }
        }
        if (changed) {
            await env.ACCOUNTS_KV.put(STORE_KEY, JSON.stringify(fresh));
            writeMemory(env, fresh);
        }
        return fresh;
    });
    return saved;
}

function findLoginByUid(accounts, uid) {
    const target = Number(uid);
    if (!Number.isFinite(target) || target <= 0) {
        return "";
    }
    for (const [login, account] of Object.entries(accounts || {})) {
        if (Number(account && account.uid) === target) {
            return login;
        }
    }
    return "";
}

function loginHistoryOf(account) {
    const history = account && Array.isArray(account.loginHistory) ? account.loginHistory : [];
    return history.slice(-LOGIN_HISTORY_LIMIT);
}

// 本人可见：额外带登录位置记录
function selfAccount(account) {
    return { ...publicAccount(account), loginHistory: loginHistoryOf(account) };
}

// 管理员可见：带收款码与当前密码（1.4.0 起解密 passwordSealed 返回，未配置密钥时为 null）
async function fullAccount(account, env) {
    return {
        ...selfAccount(account),
        hasPassword: Boolean(account && account.password),
        password: await openPassword(env, account && account.passwordSealed),
        receipt: account && account.receipt ? account.receipt : null
    };
}

async function fullAccountMap(accounts, env) {
    const entries = await Promise.all(
        Object.entries(accounts || {}).map(async ([login, account]) => [login, await fullAccount(account, env)])
    );
    return Object.fromEntries(entries);
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
        "x-content-type-options": "nosniff",
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

/* ───────── 1.2.0：跨 isolate 的账户写锁（Durable Object 租约） ───────── */

const ACCOUNTS_LOCK_LEASE_MS = 30 * 1000;
const ACCOUNTS_LOCK_WAIT_MS = 8000;

function accountsLockStub(env) {
    if (!env.ACCOUNTS_LOCK || typeof env.ACCOUNTS_LOCK.idFromName !== "function") {
        return null;
    }
    try {
        return env.ACCOUNTS_LOCK.get(env.ACCOUNTS_LOCK.idFromName("accounts-write-lock"));
    } catch (error) {
        return null;
    }
}

/* 拿不到锁就等一会儿重试；绑定缺失时退化成只靠 isolate 内的锁 */
async function acquireAccountsLock(env) {
    const stub = accountsLockStub(env);
    if (!stub) {
        return async () => {};
    }

    const deadline = Date.now() + ACCOUNTS_LOCK_WAIT_MS;

    while (Date.now() < deadline) {
        let granted = false;
        try {
            const response = await stub.fetch("https://accounts-lock.internal/lock");
            const data = await response.json();
            granted = Boolean(data && data.granted);
        } catch (error) {
            return async () => {};
        }

        if (granted) {
            let released = false;
            return async () => {
                if (released) {
                    return;
                }
                released = true;
                try {
                    await stub.fetch("https://accounts-lock.internal/unlock");
                } catch (error) {
                    /* 拿不到也只会等到租约过期 */
                }
            };
        }

        await new Promise((resolve) => setTimeout(resolve, 30));
    }

    throw new HttpError(503, "busy", "账户正在被其他请求修改，请稍后重试");
}

async function commitAccounts(env, mutate) {
    if (!canWrite(env)) {
        throw new HttpError(503, "write_unavailable", "服务端未配置 ACCOUNTS_KV 或 GITHUB_TOKEN，无法写入");
    }

    if (hasKv(env)) {
        return await withStoreLock(async () => {
            // 1.2.0：isolate 内的 promise 链挡不住跨 isolate 的并发，再向 Durable Object 申请一把写锁
            const release = await acquireAccountsLock(env);
            try {
                const accounts = await readKvAccounts(env);
                await mutate(accounts);
                await env.ACCOUNTS_KV.put(STORE_KEY, JSON.stringify(accounts));
                writeMemory(env, accounts);
                await mirrorToGithub(env, accounts);
                return accounts;
            } finally {
                await release();
            }
        });
    }

    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const { accounts, sha } = await readAccountFile(env);
        const message = await mutate(accounts);

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

/* ───────── 1.2.0：服务端商品目录 / 库存 ───────── */

function shopStockKey(id) {
    return `shop:stock:${id}`;
}

function shopOrigin(request, env) {
    const configured = String(env.PUBLIC_BASE || "").trim().replace(/\/+$/, "");
    if (configured) {
        return configured;
    }
    const origin = new URL(request.url).origin;
    return /\.workers\.dev$/i.test(new URL(origin).hostname) ? DEFAULT_SITE_ORIGIN : origin;
}

/* shop.json 的格式：{ version, items: [...], "分类名": [...] } */
function flattenShopCatalog(catalog) {
    const items = new Map();
    const source = plainObject(catalog);

    const push = (raw) => {
        const entry = plainObject(raw);
        const id = String(entry.id ?? "").trim();
        const name = String(entry.name ?? "").trim();
        const cents = toCents(entry.price);
        if (!id || !name || cents === null || cents <= 0 || items.has(id)) {
            return;
        }
        const stock = Number(entry.stock);
        items.set(id, {
            id,
            name,
            cents,
            stock: Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0
        });
    };

    for (const value of Object.values(source)) {
        if (Array.isArray(value)) {
            value.forEach(push);
        }
    }
    if (Array.isArray(source.items)) {
        source.items.forEach(push);
    }
    return items;
}

let shopCache = { at: 0, items: null };

async function loadShopCatalog(request, env) {
    // SHOP_CATALOG 可选：直接给 Worker 一份目录（测试或站点静态文件不可达时用）
    if (env.SHOP_CATALOG) {
        const inline = typeof env.SHOP_CATALOG === "string" ? JSON.parse(env.SHOP_CATALOG) : env.SHOP_CATALOG;
        return flattenShopCatalog(inline);
    }

    if (shopCache.items && Date.now() - shopCache.at < SHOP_CACHE_TTL_MS) {
        return shopCache.items;
    }

    const target = `${shopOrigin(request, env)}/shop.json`;
    const response = await fetch(target, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { accept: "application/json" }
    });

    if (!response.ok) {
        throw new HttpError(502, "catalog_unavailable", "读取商品目录失败，请稍后重试");
    }

    const items = flattenShopCatalog(await response.json());
    shopCache = { at: Date.now(), items };
    return items;
}

function findShopItem(items, key) {
    const text = String(key || "").trim();
    if (!text) {
        return null;
    }
    if (items.has(text)) {
        return items.get(text);
    }
    for (const item of items.values()) {
        if (item.name === text) {
            return item;
        }
    }
    return null;
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

/* 1.2.0：邀请码改用 CSPRNG，Math.random 可预测 */
function randomDigits(digits) {
    const min = digits === 4 ? 0 : 10000000;
    const span = digits === 4 ? 10000 : 90000000;
    const limit = Math.floor(4294967296 / span) * span;
    const buffer = new Uint32Array(1);
    let value = 0;
    do {
        crypto.getRandomValues(buffer);
        value = buffer[0];
    } while (value >= limit);
    return String(min + (value % span)).padStart(digits, "0");
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

    const accounts = await commitAccounts(env, async (data) => {
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

        if (!(await verifyPasswordValue(payerAccount.password, password))) {
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

    if (!account || !(await verifyPasswordValue(account.password, password))) {
        return jsonResponse({ error: "invalid_credentials", message: "登录名或密码不正确" }, 401, cors);
    }

    if (!env.SIGNING_SECRET) {
        return jsonResponse({ error: "server_misconfigured", message: "服务端未配置 SIGNING_SECRET" }, 500, cors);
    }

    // 1.2.0：旧账户的明文密码在首次登录成功后就地升级为 PBKDF2 哈希
    // 1.4.0：顺带给还没有可显示副本的账户补一份 passwordSealed
    const needsSeal = Boolean(env.PASSWORD_VIEW_KEY) && !account.passwordSealed;
    if (!isPasswordHashed(account.password) || needsSeal) {
        await upgradePasswordHash(env, login, password);
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

    const accounts = await ensureAccountUids(env, [session.payload.sub]);
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

/* 有些接口（结束邀请、加入邀请等）允许不带请求体 */
async function readOptionalBody(request) {
    try {
        return plainObject(await readJsonBody(request));
    } catch (error) {
        return {};
    }
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

    const hashed = await hashPassword(password);
    const sealed = await sealPassword(env, password);
    const accounts = await commitAccounts(env, (data) => {
        if (data[login]) {
            throw new HttpError(409, "account_exists", `账户名称 ${login} 已被占用`);
        }
        if (isReservedLogin(login, env)) {
            throw new HttpError(409, "account_reserved", `账户名称 ${login} 是保留名称，请换一个`);
        }
        if (Object.keys(data).length >= MAX_ACCOUNTS) {
            throw new HttpError(403, "forbidden", `账户数量已达上限（${MAX_ACCOUNTS}）`);
        }

        data[login] = {
            uid: nextUidFrom(data),
            username: username || login,
            password: hashed,
            money: "0.00",
            trades: []
        };
        if (sealed) {
            data[login].passwordSealed = sealed;
        }

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

    const accounts = await commitAccounts(env, async (data) => {
        const account = data[target];

        if (!account) {
            throw new HttpError(404, "not_found", "账户不存在");
        }

        if (isPayment && !(await verifyPasswordValue(account.password, password))) {
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

async function checkPassword(account, password) {
    if (!(await verifyPasswordValue(account.password, password))) {
        throw new HttpError(400, "invalid_password", "账户密码不正确");
    }
}

/* 旧账户首次用明文密码登录成功后，把记录换成 PBKDF2 哈希 */
async function upgradePasswordHash(env, login, password) {
    if (!canWrite(env)) {
        return;
    }
    try {
        const hashed = await hashPassword(password);
        const sealed = await sealPassword(env, password);
        await commitAccounts(env, (data) => {
            const account = data[login];
            if (!account) {
                return `登录：${login}`;
            }
            if (!isPasswordHashed(account.password)) {
                account.password = hashed;
            }
            /* 1.4.0：登录时手里就有明文密码，顺手给老账户补一份可显示的加密副本 */
            if (sealed && !account.passwordSealed) {
                account.passwordSealed = sealed;
            }
            return `登录：${login}`;
        });
    } catch (error) {
        /* 升级失败不能影响登录本身 */
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

    const hashedPassword = await hashPassword(newPassword);
    const sealedPassword = await sealPassword(env, newPassword);

    await commitAccounts(env, async (data) => {
        const account = requireOwnAccount(data, login);

        await checkPassword(account, currentPassword);
        account.password = hashedPassword;
        if (sealedPassword) {
            account.passwordSealed = sealedPassword;
        } else {
            delete account.passwordSealed;
        }

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

    const accounts = await commitAccounts(env, async (data) => {
        const sender = requireOwnAccount(data, login);
        const receiver = data[target];

        await checkPassword(sender, password);

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

    const accounts = await commitAccounts(env, async (data) => {
        const account = requireOwnAccount(data, login);

        await checkPassword(account, password);

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
    const itemKey = String(body.id ?? body.item ?? "").trim().slice(0, 60);
    const quantity = Math.floor(Number(body.quantity || 0));
    const password = String(body.password ?? "");
    const description = String(body.description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);

    if (!itemKey) {
        return jsonResponse({ error: "bad_request", message: "缺少 id：请填写商品 ID" }, 400, cors);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
        return jsonResponse({ error: "bad_request", message: "quantity 必须是大于 0 的整数" }, 400, cors);
    }
    if (quantity > SHOP_MAX_QUANTITY) {
        return jsonResponse({ error: "bad_request", message: `一次最多购买 ${SHOP_MAX_QUANTITY} 件` }, 400, cors);
    }
    if (!password) {
        return jsonResponse({ error: "bad_request", message: "缺少 password：购买需要密码确认" }, 400, cors);
    }

    // 1.2.0：价格只认仓库里的 shop.json，不再相信客户端传来的 amount
    const catalog = await loadShopCatalog(request, env);
    const product = findShopItem(catalog, itemKey);

    if (!product) {
        return jsonResponse({ error: "item_not_found", message: "商品不存在或已下架，请刷新页面" }, 404, cors);
    }

    const amountCents = product.cents * quantity;
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > MAX_TRADE_CENTS) {
        return jsonResponse({ error: "bad_request", message: "订单金额不合法" }, 400, cors);
    }

    const amount = fromCents(amountCents);
    const time = shanghaiTimestamp();
    let trade = null;
    let remaining = null;

    const accounts = await commitAccounts(env, async (data) => {
        const account = requireOwnAccount(data, login);

        await checkPassword(account, password);

        const balance = toCents(account.money) ?? 0;
        if (balance < amountCents) {
            throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${fromCents(balance)} VTX`);
        }

        if (hasKv(env)) {
            const stockKey = shopStockKey(product.id);
            const stored = await env.ACCOUNTS_KV.get(stockKey);
            const parsed = Number(stored);
            const current = stored === null || stored === undefined || !Number.isFinite(parsed)
                ? product.stock
                : Math.max(0, Math.floor(parsed));

            if (current < quantity) {
                throw new HttpError(400, "out_of_stock", `库存不足，当前只剩 ${current} 件`);
            }

            remaining = current - quantity;
            await env.ACCOUNTS_KV.put(stockKey, String(remaining));
        }

        account.money = fromCents(balance - amountCents);
        trade = pushTrade(account, {
            name: "购买商品",
            description: description || `${product.name} ×${quantity}`,
            price: `-${amount}`,
            time,
            from: account.username || login,
            to: "XRingCR"
        });

        return `购买商品：${account.username || login} 购买 ${product.name} ×${quantity}`;
    });

    return jsonResponse({
        ok: true,
        login,
        trade,
        item: { id: product.id, name: product.name, unitPrice: fromCents(product.cents), quantity },
        stock: remaining === null ? null : { id: product.id, remaining },
        receipt: `购买成功：${product.name} ×${quantity}，共 ${amount} VTX，请不要关闭此窗口，请将此窗口截图在XRingCR群中发给群主，次日将在学校给你商品。购买时间：${time}`,
        account: selfAccount(accounts[login])
    }, 200, cors);
}

/* 1.2.0：公开的商品库存（KV 里没有记录时回落到 shop.json 的库存） */
async function handleShopStock(request, env, cors) {
    const catalog = await loadShopCatalog(request, env);
    const stock = {};

    for (const item of catalog.values()) {
        stock[item.id] = item.stock;
    }

    if (hasKv(env)) {
        for (const id of Object.keys(stock)) {
            const stored = await env.ACCOUNTS_KV.get(shopStockKey(id));
            const parsed = Number(stored);
            if (stored !== null && stored !== undefined && Number.isFinite(parsed)) {
                stock[id] = Math.max(0, Math.floor(parsed));
            }
        }
    }

    return jsonResponse({ ok: true, version: VERSION, stock }, 200, cors);
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

/* 1.2.0：管理员登录名是权限的唯一依据，绝不允许被别人注册/改名占用 */
function isReservedLogin(login, env) {
    return String(login || "").trim().toLowerCase() === adminLogin(env).toLowerCase();
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
        output[login] = await fullAccount(account, env);
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

    const hashedPassword = await hashPassword(password);
    const sealedPassword = await sealPassword(env, password);
    const accounts = await commitAccounts(env, (data) => {
        if (data[login]) {
            throw new HttpError(409, "account_exists", `账户名称 ${login} 已被占用`);
        }
        if (isReservedLogin(login, env)) {
            throw new HttpError(409, "account_reserved", `账户名称 ${login} 是保留名称，不能用于新建账户`);
        }
        if (Object.keys(data).length >= MAX_ACCOUNTS) {
            throw new HttpError(403, "forbidden", `账户数量已达上限（${MAX_ACCOUNTS}）`);
        }

        data[login] = { username, password: hashedPassword, money, trades: [] };
        if (sealedPassword) {
            data[login].passwordSealed = sealedPassword;
        }
        return `管理员创建账户：${login}`;
    });

    await appendAdminLog(env, session.payload.sub, "create", login, `money=${money}`);

    return jsonResponse({
        ok: true,
        login,
        account: await fullAccount(accounts[login], env),
        accounts: await fullAccountMap(accounts, env)
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
    const sealedPassword = body.password !== undefined ? await sealPassword(env, String(body.password)) : null;

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

    const accounts = await commitAccounts(env, async (data) => {
        const account = data[login];

        if (!account) {
            throw new HttpError(404, "not_found", `账户 ${login} 不存在`);
        }

        if (body.username !== undefined) {
            account.username = String(body.username).trim();
            changes.push(`username=${account.username}`);
        }
        if (body.password !== undefined) {
            account.password = await hashPassword(String(body.password));
            if (sealedPassword) {
                account.passwordSealed = sealedPassword;
            } else {
                delete account.passwordSealed;
            }
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
        account: await fullAccount(accounts[login], env),
        accounts: await fullAccountMap(accounts, env)
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
        accounts: await fullAccountMap(accounts, env)
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

async function handleChatStatus(request, env, cors) {
    const rooms = await readPublicGroups(env);
    return jsonResponse({
        ok: true,
        version: CHAT_VERSION,
        status: chatEnabled(env) ? "ready" : "coming_soon",
        enabled: chatEnabled(env),
        storage: hasKv(env) ? "workers-kv" : "unavailable",
        realtime: env.CHAT && typeof env.CHAT.idFromName === "function" ? "websocket" : "polling",
        rooms: rooms.map((group) => ({ id: group.id, name: group.name, description: group.description })),
        features: [
            "friends", "direct", "groups", "group-admin", "announcement",
            "recall", "forward", "reply", "search", "mute-pin", "files-images", "expiring-media",
            "public-channel-admin", "group-dissolve", "uid", "group-number", "group-qr",
            "invite-code", "redpacket"
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

function ensurePublicSubscriptions(record, groups) {
    let changed = false;
    for (const group of groups || CHAT_PUBLIC_GROUPS) {
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
    if (ensurePublicSubscriptions(record, await readPublicGroups(env))) {
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
    const groups = await readPublicGroups(env);
    let changed = false;

    for (const group of groups) {
        const existing = await readConversation(env, group.id);
        if (!existing) {
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
            continue;
        }
        const renamed = existing.name !== group.name || existing.description !== group.description;
        if (renamed) {
            existing.name = group.name;
            existing.description = group.description;
            existing.public = true;
            await saveConversation(env, existing);
        }
    }

    if (changed) {
        await saveChatIndex(env, index);
    }
}

async function readPublicGroups(env) {
    const stored = await env.ACCOUNTS_KV.get(CHAT_PUBLIC_GROUPS_KEY, "json");
    if (Array.isArray(stored)) {
        return stored
            .filter((item) => item && CHAT_PUBLIC_ID_PATTERN.test(String(item.id || "")))
            .map((item) => ({
                id: String(item.id),
                name: String(item.name || item.id),
                description: String(item.description || ""),
                createdAt: item.createdAt || ""
            }));
    }
    return CHAT_PUBLIC_GROUPS.map((item) => ({ ...item, createdAt: "" }));
}

async function savePublicGroups(env, groups) {
    await env.ACCOUNTS_KV.put(CHAT_PUBLIC_GROUPS_KEY, JSON.stringify(groups));
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
    if (message.type === "redpacket" && message.packet) {
        return `[拼手速红包] ${fromCents(message.packet.totalCents)} 元 ${message.packet.note || ""}`.trim();
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
        packet: message.recalled ? null : (message.packet || null),
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
        no: Number(conv.no) || 0,
        peer: peerLogin,
        peerName: peerLogin ? chatDisplayName(accounts, peerLogin) : "",
        public: Boolean(conv.public),
        description: String(conv.description || ""),
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

/* ───────── 1.0.0：群号（QQ 式） ───────── */

async function uniqueGroupNumber(env) {
    const index = await readChatIndex(env);
    const used = new Set();
    for (const id of index) {
        const conv = await readConversation(env, id);
        const value = Number(conv && conv.no);
        if (value) {
            used.add(value);
        }
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const span = CHAT_GROUP_NUMBER_MAX - CHAT_GROUP_NUMBER_MIN + 1;
        const candidate = CHAT_GROUP_NUMBER_MIN + Math.floor(Math.random() * span);
        if (!used.has(candidate)) {
            return candidate;
        }
    }
    return CHAT_GROUP_NUMBER_MIN + used.size + 1;
}

async function ensureGroupNumber(env, conv) {
    if (!conv || conv.type !== "group" || Number(conv.no)) {
        return conv;
    }
    conv.no = await uniqueGroupNumber(env);
    await saveConversation(env, conv);
    return conv;
}

async function findGroupByNumber(env, number) {
    const target = Number(number);
    if (!Number.isFinite(target) || target <= 0) {
        return null;
    }
    const index = await readChatIndex(env);
    for (const id of index) {
        const conv = await readConversation(env, id);
        if (conv && conv.type === "group" && Number(conv.no) === target) {
            return conv;
        }
    }
    return null;
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
            no: await uniqueGroupNumber(env),
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
        await ensureGroupNumber(env, conv);
        const record = await loadChatUser(env, login);
        const messages = await readChatMessages(env, conv.id);
        const view = conversationView(env, conv, chatEntry(record, conv.id), messages, login, accounts);
        const memberLogins = conv.public ? Object.keys(accounts) : conv.members;
        const members = memberLogins.map((member) => ({
            login: member,
            username: chatDisplayName(accounts, member),
            uid: Number(accounts[member] && accounts[member].uid) || 0,
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

async function deleteChatConversation(env, conv, extraMembers = []) {
    await env.ACCOUNTS_KV.delete(chatMessagesKey(conv.id));
    await env.ACCOUNTS_KV.delete(chatConversationKey(conv.id));
    await removeFromChatIndex(env, conv.id);

    if (conv.type === "direct") {
        const [a, b] = conv.members || [];
        if (a && b) {
            await env.ACCOUNTS_KV.delete(chatDirectKey(a, b));
        }
    }

    const members = conv.public ? extraMembers : (conv.members || []);
    for (const member of members) {
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
            if (!isPlatformAdmin(env, login)) {
                return { error: jsonResponse({ error: "forbidden", message: "公共频道只有站主可以解散，其他人可以退出" }, 403, cors) };
            }
            const groups = await readPublicGroups(env);
            if (groups.length <= 1) {
                return { error: jsonResponse({ error: "bad_request", message: "至少需要保留一个公共频道" }, 400, cors) };
            }
            const targets = Object.keys(accounts);
            await savePublicGroups(env, groups.filter((item) => item.id !== id));
            await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 解散了公共频道`);
            await saveConversation(env, conv);
            await deleteChatConversation(env, conv, targets);
            return { mode: "public-delete", targets, removed: true };
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
    } else if (result.removed) {
        await notifyChat(env, result.targets, { type: "conversation:remove", conversation: id, by: login });
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
        if (conv.public) {
            if (!isPlatformAdmin(env, login)) {
                return { error: jsonResponse({ error: "forbidden", message: "只有站主可以修改公共频道名称" }, 403, cors) };
            }
        } else if (conv.type !== "group" || !canManageGroup(env, conv, login)) {
            return { error: jsonResponse({ error: "forbidden", message: "只有群主或管理员可以修改群名" }, 403, cors) };
        }
        const name = normalizeGroupName(body.name);
        const before = conv.name;
        conv.name = name;
        if (conv.public) {
            const groups = await readPublicGroups(env);
            const index = groups.findIndex((item) => item.id === conv.id);
            if (index >= 0) {
                groups[index] = { ...groups[index], name };
                await savePublicGroups(env, groups);
            }
        }
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
    const accounts = await ensureAccountUids(env);
    const url = new URL(request.url);
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const record = await readChatUser(env, login);
    const output = [];

    for (const [name, account] of Object.entries(accounts)) {
        if (name === login) {
            continue;
        }
        const username = String(account && account.username || name);
        const uid = Number(account && account.uid) || 0;
        const uidText = uid ? String(uid) : "";
        if (query
            && !name.toLowerCase().includes(query)
            && !username.toLowerCase().includes(query)
            && !(uidText && uidText.includes(query))) {
            continue;
        }
        output.push({
            login: name,
            uid,
            username,
            friend: record.friends.some((item) => item.login === name),
            blocked: record.blocked.includes(name),
            incoming: record.incoming.some((item) => item.from === name),
            outgoing: record.outgoing.some((item) => item.to === name)
        });
    }

    output.sort((left, right) => {
        const exactLeft = String(left.uid) === query ? 1 : 0;
        const exactRight = String(right.uid) === query ? 1 : 0;
        return exactRight - exactLeft
            || Number(right.friend) - Number(left.friend)
            || left.login.localeCompare(right.login);
    });
    return jsonResponse({ ok: true, query, users: output.slice(0, 30) }, 200, cors);
}

/* 1.0.0：按 UID 精确查号 */
async function handleChatUserByUid(request, env, cors, uid) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await ensureAccountUids(env);
    const target = findLoginByUid(accounts, uid);
    if (!target) {
        return jsonResponse({ error: "not_found", message: `没有 UID 为 ${uid} 的账户` }, 404, cors);
    }
    const account = accounts[target];
    const record = await readChatUser(env, login);

    return jsonResponse({
        ok: true,
        user: {
            login: target,
            uid: Number(account.uid) || 0,
            username: chatDisplayName(accounts, target),
            me: target === login,
            friend: record.friends.some((item) => item.login === target),
            blocked: record.blocked.includes(target),
            incoming: record.incoming.some((item) => item.from === target),
            outgoing: record.outgoing.some((item) => item.to === target)
        }
    }, 200, cors);
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

    const declaredType = String(request.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    // 1.2.0：不再原样保存客户端声明的类型，避免 text/html / image/svg+xml 变成同源 XSS
    const type = CHAT_MEDIA_INLINE_TYPES.has(declaredType) ? declaredType : "application/octet-stream";
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

    const storedType = String(meta.type || "").toLowerCase();
    const inline = CHAT_MEDIA_INLINE_TYPES.has(storedType);

    return new Response(body, {
        status: 200,
        headers: {
            ...cors,
            "content-type": inline ? storedType : "application/octet-stream",
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name || "file")}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
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

async function handleChatAdminPublicGroups(request, env, cors) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const accounts = await loadAccounts(env);
    const groups = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const defined = await readPublicGroups(env);
        const output = [];
        for (const group of defined) {
            const conv = await readConversation(env, group.id);
            if (!conv) {
                continue;
            }
            const messages = await readChatMessages(env, group.id);
            output.push({
                ...conversationView(env, conv, null, messages, session.payload.sub, accounts),
                description: group.description || "",
                messageCount: messages.length
            });
        }
        return output;
    });

    return jsonResponse({ ok: true, count: groups.length, groups }, 200, cors);
}

async function handleChatAdminCreatePublicGroup(request, env, cors) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const body = plainObject(await readJsonBody(request));
    let name;
    try {
        name = normalizeGroupName(body.name);
    } catch (error) {
        return jsonResponse({ error: error.code || "bad_request", message: error.message }, error.status || 400, cors);
    }
    const description = String(body.description ?? "").replace(/\s+/g, " ").trim();
    if (description.length > CHAT_PUBLIC_DESCRIPTION_MAX) {
        return jsonResponse({ error: "bad_request", message: `频道简介最长 ${CHAT_PUBLIC_DESCRIPTION_MAX} 个字符` }, 400, cors);
    }
    const requestedId = String(body.id ?? "").trim();
    if (requestedId && !CHAT_PUBLIC_ID_PATTERN.test(requestedId)) {
        return jsonResponse({ error: "bad_request", message: "频道 id 只能是小写字母、数字、- 和 _（2-40 位）" }, 400, cors);
    }

    const accounts = await loadAccounts(env);
    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const groups = await readPublicGroups(env);
        let id = requestedId || `ch_${randomCode(9).toLowerCase()}`;
        if (groups.some((item) => item.id === id) || await readConversation(env, id)) {
            if (requestedId) {
                return { error: jsonResponse({ error: "conflict", message: `频道 id ${id} 已被占用` }, 409, cors) };
            }
            id = `ch_${randomCode(11).toLowerCase()}`;
        }

        const createdAt = shanghaiTimestamp();
        groups.push({ id, name, description, createdAt });
        await savePublicGroups(env, groups);

        const conv = {
            id,
            type: "group",
            name,
            description,
            public: true,
            owner: adminLogin(env),
            admins: [],
            members: [],
            aliases: {},
            announcement: null,
            createdAt,
            updatedAt: createdAt,
            lastMessage: null
        };
        await saveConversation(env, conv);
        await addToChatIndex(env, id);
        await appendSystemMessage(env, conv, `站主创建了公共频道「${name}」`);
        await saveConversation(env, conv);

        const messages = await readChatMessages(env, id);
        return {
            targets: Object.keys(accounts),
            view: {
                ...conversationView(env, conv, null, messages, session.payload.sub, accounts),
                description,
                messageCount: messages.length
            }
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:new", conversation: result.view });
    return jsonResponse({ ok: true, group: result.view }, 201, cors);
}

async function handleChatAdminUpdatePublicGroup(request, env, cors, id) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const body = plainObject(await readJsonBody(request));
    const accounts = await loadAccounts(env);

    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const groups = await readPublicGroups(env);
        const index = groups.findIndex((item) => item.id === id);
        if (index < 0) {
            return { error: jsonResponse({ error: "not_found", message: "公共频道不存在" }, 404, cors) };
        }
        const conv = await readConversation(env, id);
        if (!conv) {
            return { error: jsonResponse({ error: "not_found", message: "公共频道不存在" }, 404, cors) };
        }

        let name = groups[index].name;
        if (body.name !== undefined) {
            try {
                name = normalizeGroupName(body.name);
            } catch (error) {
                return { error: jsonResponse({ error: error.code || "bad_request", message: error.message }, error.status || 400, cors) };
            }
        }
        let description = groups[index].description || "";
        if (body.description !== undefined) {
            description = String(body.description ?? "").replace(/\s+/g, " ").trim();
            if (description.length > CHAT_PUBLIC_DESCRIPTION_MAX) {
                return {
                    error: jsonResponse(
                        { error: "bad_request", message: `频道简介最长 ${CHAT_PUBLIC_DESCRIPTION_MAX} 个字符` },
                        400,
                        cors
                    )
                };
            }
        }

        const before = groups[index].name;
        groups[index] = { ...groups[index], name, description };
        await savePublicGroups(env, groups);

        const renamed = conv.name !== name;
        conv.name = name;
        conv.description = description;
        conv.public = true;
        if (renamed) {
            await appendSystemMessage(env, conv, `站主把频道名称从「${before}」改成了「${name}」`);
        }
        await saveConversation(env, conv);

        const messages = await readChatMessages(env, id);
        return {
            targets: Object.keys(accounts),
            renamed,
            view: {
                ...conversationView(env, conv, null, messages, session.payload.sub, accounts),
                description,
                messageCount: messages.length
            }
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:update", conversation: result.view });
    return jsonResponse({ ok: true, group: result.view }, 200, cors);
}

async function handleChatAdminDeletePublicGroup(request, env, cors, id) {
    const session = await requireAdmin(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const accounts = await loadAccounts(env);
    const result = await withStoreLock(async () => {
        await ensurePublicGroups(env);
        const groups = await readPublicGroups(env);
        const target = groups.find((item) => item.id === id);
        if (!target) {
            return { error: jsonResponse({ error: "not_found", message: "公共频道不存在" }, 404, cors) };
        }
        if (groups.length <= 1) {
            return { error: jsonResponse({ error: "bad_request", message: "至少需要保留一个公共频道" }, 400, cors) };
        }

        const conv = await readConversation(env, id);
        await savePublicGroups(env, groups.filter((item) => item.id !== id));
        if (conv) {
            await appendSystemMessage(env, conv, `站主解散了公共频道「${conv.name}」`);
            await saveConversation(env, conv);
            await deleteChatConversation(env, conv, Object.keys(accounts));
        }
        await removeFromChatIndex(env, id);
        return { targets: Object.keys(accounts), name: target.name };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:remove", conversation: id, by: session.payload.sub });
    return jsonResponse({ ok: true, conversation: id, name: result.name, deleted: true }, 200, cors);
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
        const accounts = await loadAccounts(env);
        const targets = conversationTargets(conv, accounts);
        if (conv.public) {
            /* 站主永久删除公共频道时，同时把它从频道定义里移除，否则下次还会被重建 */
            const groups = await readPublicGroups(env);
            if (groups.some((item) => item.id === id)) {
                await savePublicGroups(env, groups.filter((item) => item.id !== id));
            }
        } else {
            await appendSystemMessage(env, conv, "站主解散了这个会话");
            await saveConversation(env, conv);
        }
        await deleteChatConversation(env, conv, Object.keys(accounts));
        return { targets };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:remove", conversation: id, by: session.payload.sub });
    return jsonResponse({ ok: true, conversation: id, deleted: true }, 200, cors);
}

/* ───────────────── 1.0.0：群号 / 群二维码 / 按群号加入 ───────────────── */

function groupInviteLink(request, env, no) {
    return `${siteOrigin(request, env)}/chatroom.html?group=${encodeURIComponent(String(no || ""))}`;
}

function groupCard(request, env, conv, accounts, login) {
    return {
        id: conv.id,
        no: Number(conv.no) || 0,
        name: String(conv.name || "群聊"),
        owner: conv.owner || "",
        ownerName: conv.owner ? chatDisplayName(accounts, conv.owner) : "",
        memberCount: conv.public ? Object.keys(accounts).length : (conv.members || []).length,
        public: Boolean(conv.public),
        dissolved: Boolean(conv.dissolved),
        joined: chatMemberOf(conv, login),
        link: groupInviteLink(request, env, conv.no),
        announcement: conv.announcement ? conv.announcement.text : ""
    };
}

async function handleChatGroupLookup(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const url = new URL(request.url);
    const number = String(url.searchParams.get("number") || "").trim();
    const conv = await findGroupByNumber(env, number);
    if (!conv) {
        return jsonResponse({ error: "not_found", message: "没有这个群号" }, 404, cors);
    }
    const accounts = await loadAccounts(env);
    return jsonResponse({
        ok: true,
        group: groupCard(request, env, conv, accounts, session.payload.sub)
    }, 200, cors);
}

async function handleChatGroupJoinByNumber(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const body = await readOptionalBody(request);
    const number = String(body.number ?? new URL(request.url).searchParams.get("number") ?? "").trim();
    if (!number) {
        return jsonResponse({ error: "bad_request", message: "请填写群号" }, 400, cors);
    }

    const accounts = await loadAccounts(env);
    const result = await withStoreLock(async () => {
        const conv = await findGroupByNumber(env, number);
        if (!conv) {
            return { error: jsonResponse({ error: "not_found", message: "没有这个群号" }, 404, cors) };
        }
        if (chatGroupDissolved(conv)) {
            return { error: chatDissolvedResponse(cors) };
        }

        if (!chatMemberOf(conv, login)) {
            if (conv.public) {
                await ensureConversationEntry(env, login, conv.id);
            } else {
                if (conv.members.length >= CHAT_GROUP_MAX_MEMBERS) {
                    return { error: jsonResponse({ error: "bad_request", message: `群成员不能超过 ${CHAT_GROUP_MAX_MEMBERS} 人` }, 400, cors) };
                }
                conv.members.push(login);
                await appendSystemMessage(env, conv, `${chatDisplayName(accounts, login)} 通过群号加入了群聊`);
                await saveConversation(env, conv);
                await ensureConversationEntry(env, login, conv.id);
            }
        } else {
            await ensureConversationEntry(env, login, conv.id);
        }

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
    return jsonResponse({ ok: true, conversation: result.view, joined: true }, 200, cors);
}

/* ───────────────── 1.0.0：4 / 8 位数字建群邀请码 ───────────────── */

function chatInviteKey(code) {
    return `chat:invite:${code}`;
}

function chatInviteOwnerKey(login) {
    return `chat:invite-owner:${login}`;
}

function inviteDigitsOf(value) {
    const digits = Number(value) || 0;
    return digits === 4 || digits === 8 ? digits : 0;
}

function inviteCodeMatches(code) {
    const text = String(code || "").trim();
    if (CHAT_INVITE_PATTERN_4.test(text) || CHAT_INVITE_PATTERN_8.test(text)) {
        return text;
    }
    return "";
}

async function readInvite(env, code) {
    const invite = plainObject(await env.ACCOUNTS_KV.get(chatInviteKey(code), "json"));
    return invite.code ? invite : null;
}

async function saveInvite(env, invite) {
    await env.ACCOUNTS_KV.put(chatInviteKey(invite.code), JSON.stringify(invite), {
        expirationTtl: CHAT_INVITE_TTL_SECONDS
    });
}

function inviteView(invite, accounts) {
    const participants = (invite.participants || []).map((login) => ({
        login,
        uid: Number(accounts[login] && accounts[login].uid) || 0,
        username: chatDisplayName(accounts, login)
    }));
    return {
        code: invite.code,
        digits: invite.digits,
        name: invite.name || "",
        owner: invite.owner,
        ownerName: chatDisplayName(accounts, invite.owner),
        participants,
        count: participants.length,
        closed: Boolean(invite.closed),
        conversation: invite.conversation || "",
        createdAt: invite.createdAt || "",
        expiresAt: invite.expiresAt || 0
    };
}

async function closeInvite(env, invite, accounts) {
    const now = shanghaiTimestamp();
    const name = normalizeGroupName(invite.name || `群聊 ${invite.code}`);
    const members = Array.from(new Set([invite.owner, ...(invite.participants || [])].filter(Boolean)));

    const conv = {
        id: `g_${randomCode(9)}`,
        type: "group",
        name,
        no: await uniqueGroupNumber(env),
        public: false,
        owner: invite.owner,
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

    const invited = members.filter((item) => item !== invite.owner);
    await appendSystemMessage(env, conv, `建群邀请「${invite.code}」结束，${members.length} 人组成了群聊`
        + (invited.length ? `（${invited.map((item) => chatDisplayName(accounts, item)).join("、")} 通过邀请码加入）` : ""));
    await saveConversation(env, conv);

    invite.closed = true;
    invite.closedAt = now;
    invite.conversation = conv.id;
    await saveInvite(env, invite);
    await env.ACCOUNTS_KV.delete(chatInviteOwnerKey(invite.owner));

    const record = await loadChatUser(env, invite.owner);
    const messages = await readChatMessages(env, conv.id);
    return {
        view: conversationView(env, conv, chatEntry(record, conv.id), messages, invite.owner, accounts),
        targets: conversationTargets(conv, accounts)
    };
}

async function handleChatInviteCreate(request, env, cors) {
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
    const digits = inviteDigitsOf(body.digits === undefined ? 4 : body.digits);
    if (!digits) {
        return jsonResponse({ error: "bad_request", message: "邀请码只能是 4 位或 8 位数字" }, 400, cors);
    }

    let name = "";
    if (body.name !== undefined && String(body.name).trim()) {
        try {
            name = normalizeGroupName(body.name);
        } catch (error) {
            return jsonResponse({ error: error.code || "bad_request", message: error.message }, error.status || 400, cors);
        }
    }

    const accounts = await ensureAccountUids(env, [login]);
    const result = await withStoreLock(async () => {
        const previous = await env.ACCOUNTS_KV.get(chatInviteOwnerKey(login));
        if (previous) {
            const old = await readInvite(env, previous);
            if (old && !old.closed) {
                await env.ACCOUNTS_KV.delete(chatInviteKey(old.code));
            }
        }

        let code = "";
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const candidate = randomDigits(digits);
            const taken = await readInvite(env, candidate);
            if (!taken) {
                code = candidate;
                break;
            }
        }
        if (!code) {
            return { error: jsonResponse({ error: "conflict", message: "邀请码分配失败，请重试" }, 409, cors) };
        }

        const createdAt = shanghaiTimestamp();
        const invite = {
            code,
            digits,
            owner: login,
            name,
            participants: [],
            createdAt,
            expiresAt: Date.now() + CHAT_INVITE_TTL_SECONDS * 1000,
            closed: false,
            conversation: ""
        };
        await saveInvite(env, invite);
        await env.ACCOUNTS_KV.put(chatInviteOwnerKey(login), code, {
            expirationTtl: CHAT_INVITE_TTL_SECONDS
        });
        return { invite };
    });

    if (result.error) {
        return result.error;
    }

    return jsonResponse({ ok: true, invite: inviteView(result.invite, accounts) }, 201, cors);
}

async function handleChatInviteCurrent(request, env, cors) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await ensureAccountUids(env, [login]);
    const code = await env.ACCOUNTS_KV.get(chatInviteOwnerKey(login));
    const invite = code ? await readInvite(env, code) : null;
    if (!invite || invite.closed) {
        return jsonResponse({ ok: true, invite: null }, 200, cors);
    }
    return jsonResponse({ ok: true, invite: inviteView(invite, accounts) }, 200, cors);
}

async function handleChatInviteDetail(request, env, cors, code) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const invite = await readInvite(env, code);
    if (!invite) {
        return jsonResponse({ error: "not_found", message: "邀请码不存在或已过期" }, 404, cors);
    }
    const accounts = await ensureAccountUids(env);
    return jsonResponse({ ok: true, invite: inviteView(invite, accounts) }, 200, cors);
}

async function handleChatInviteJoin(request, env, cors, code) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await ensureAccountUids(env, [login]);
    const result = await withStoreLock(async () => {
        const invite = await readInvite(env, code);
        if (!invite) {
            return { error: jsonResponse({ error: "not_found", message: "邀请码不存在或已过期" }, 404, cors) };
        }
        if (invite.closed) {
            return {
                error: jsonResponse(
                    { error: "invite_closed", message: "邀请已结束，群聊已经建好了", conversation: invite.conversation },
                    409,
                    cors
                )
            };
        }
        if (invite.owner === login) {
            return { error: jsonResponse({ error: "bad_request", message: "这是你自己发起的邀请" }, 400, cors) };
        }
        if ((invite.participants || []).includes(login)) {
            return { invite };
        }
        if ((invite.participants || []).length >= CHAT_INVITE_MAX_PARTICIPANTS) {
            return { error: jsonResponse({ error: "bad_request", message: `最多 ${CHAT_INVITE_MAX_PARTICIPANTS} 人参加邀请` }, 400, cors) };
        }
        invite.participants.push(login);
        await saveInvite(env, invite);
        return { invite };
    });

    if (result.error) {
        return result.error;
    }

    const view = inviteView(result.invite, accounts);
    await notifyChat(env, [result.invite.owner], { type: "invite:update", invite: view });
    return jsonResponse({ ok: true, invite: view }, 200, cors);
}

async function handleChatInviteLeave(request, env, cors, code) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await ensureAccountUids(env, [login]);
    const result = await withStoreLock(async () => {
        const invite = await readInvite(env, code);
        if (!invite) {
            return { error: jsonResponse({ error: "not_found", message: "邀请码不存在或已过期" }, 404, cors) };
        }
        invite.participants = (invite.participants || []).filter((item) => item !== login);
        await saveInvite(env, invite);
        return { invite };
    });

    if (result.error) {
        return result.error;
    }

    const view = inviteView(result.invite, accounts);
    await notifyChat(env, [result.invite.owner], { type: "invite:update", invite: view });
    return jsonResponse({ ok: true, invite: view, left: true }, 200, cors);
}

async function handleChatInviteClose(request, env, cors, code) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const body = await readOptionalBody(request);
    const accounts = await ensureAccountUids(env);

    if (body.name !== undefined && String(body.name).trim()) {
        try {
            normalizeGroupName(body.name);
        } catch (error) {
            return jsonResponse({ error: error.code || "bad_request", message: error.message }, error.status || 400, cors);
        }
    }

    const result = await withStoreLock(async () => {
        const invite = await readInvite(env, code);
        if (!invite) {
            return { error: jsonResponse({ error: "not_found", message: "邀请码不存在或已过期" }, 404, cors) };
        }
        if (invite.owner !== login) {
            return { error: jsonResponse({ error: "forbidden", message: "只有发起人可以结束邀请" }, 403, cors) };
        }
        if (invite.closed) {
            return {
                error: jsonResponse(
                    { error: "invite_closed", message: "邀请已经结束了", conversation: invite.conversation },
                    409,
                    cors
                )
            };
        }
        if (body.name !== undefined && String(body.name).trim()) {
            invite.name = String(body.name).trim();
        }
        if (!(invite.participants || []).length && !invite.name) {
            return {
                error: jsonResponse(
                    { error: "no_participants", message: "还没有人加入邀请，先让大家输入邀请码吧" },
                    400,
                    cors
                )
            };
        }
        const closed = await closeInvite(env, invite, accounts);
        return closed;
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "conversation:new", conversation: result.view });
    const invite = await readInvite(env, code);
    const participants = (invite && invite.participants ? invite.participants : [])
        .filter((item) => item !== login);
    if (participants.length) {
        await notifyChat(env, participants, { type: "invite:closed", invite: inviteView(invite, accounts) });
    }

    return jsonResponse({ ok: true, conversation: result.view, invite: inviteView(invite, accounts) }, 201, cors);
}

async function handleChatInviteCancel(request, env, cors, code) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const accounts = await ensureAccountUids(env, [login]);
    const result = await withStoreLock(async () => {
        const invite = await readInvite(env, code);
        if (!invite) {
            return { error: jsonResponse({ error: "not_found", message: "邀请码不存在或已过期" }, 404, cors) };
        }
        if (invite.owner !== login) {
            return { error: jsonResponse({ error: "forbidden", message: "只有发起人可以取消邀请" }, 403, cors) };
        }
        const participants = (invite.participants || []).slice();
        await env.ACCOUNTS_KV.delete(chatInviteKey(code));
        await env.ACCOUNTS_KV.delete(chatInviteOwnerKey(login));
        return { participants };
    });

    if (result.error) {
        return result.error;
    }

    if (result.participants.length) {
        await notifyChat(env, result.participants, { type: "invite:cancelled", code });
    }
    return jsonResponse({ ok: true, cancelled: true }, 200, cors);
}

/* ───────────────── 1.0.0：拼手速红包 ───────────────── */

async function loadAccountsForLock(env) {
    return await readKvAccounts(env);
}

async function saveAccountsForLock(env, accounts) {
    await env.ACCOUNTS_KV.put(STORE_KEY, JSON.stringify(accounts));
    writeMemory(env, accounts);
    await mirrorToGithub(env, accounts);
}

function balanceCents(account) {
    const cents = toCents(account && account.money !== undefined ? account.money : "0.00");
    return cents === null ? 0 : cents;
}

function redPacketCapacity(packet, conv, accounts) {
    const sender = packet.sender;
    const members = conv.public ? Object.keys(accounts) : (conv.members || []);
    const allow = Array.isArray(packet.allow) && packet.allow.length ? packet.allow : [];
    const eligible = (allow.length ? allow : members).filter((login) => login !== sender && accounts[login]);
    const grabbed = new Set((packet.grabs || []).map((item) => item.login));
    const pending = eligible.filter((login) => !grabbed.has(login));
    const limit = Number(packet.count) > 0
        ? Math.max(0, Number(packet.count) - (packet.grabs || []).length)
        : pending.length;
    return Math.min(pending.length, limit);
}

function randomShareCents(remainCents, capacity) {
    if (capacity <= 1) {
        return remainCents;
    }
    const max = remainCents - (capacity - 1);
    if (max <= 1) {
        return 1;
    }
    const average = Math.floor(remainCents / capacity);
    const upper = Math.max(1, Math.min(max, average * 2));
    return Math.min(max, 1 + Math.floor(Math.random() * upper));
}

async function handleChatRedPacketCreate(request, env, cors, id) {
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
    const totalCents = toCents(body.total ?? body.amount);
    if (totalCents === null || totalCents < 1) {
        return jsonResponse({ error: "bad_request", message: "红包金额至少 0.01 元" }, 400, cors);
    }
    if (totalCents > CHAT_REDPACKET_MAX_CENTS) {
        return jsonResponse({ error: "bad_request", message: `单个红包最多 ${fromCents(CHAT_REDPACKET_MAX_CENTS)} 元` }, 400, cors);
    }
    let count = Number(body.count);
    count = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const note = String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const allowRequested = Array.isArray(body.allow)
        ? Array.from(new Set(body.allow.map((item) => String(item || "").trim()).filter(Boolean)))
        : [];

    if (count && count > totalCents) {
        return jsonResponse({
            error: "bad_request",
            message: `${fromCents(totalCents)} 元的红包最多只能分给 ${totalCents} 个人（每人至少 0.01 元）`
        }, 400, cors);
    }
    if (allowRequested.length > CHAT_REDPACKET_ALLOW_LIMIT) {
        return jsonResponse({ error: "bad_request", message: `最多指定 ${CHAT_REDPACKET_ALLOW_LIMIT} 人可以抢` }, 400, cors);
    }
    if (allowRequested.length && allowRequested.length > totalCents) {
        return jsonResponse({
            error: "bad_request",
            message: `指定 ${allowRequested.length} 人可以抢，但 ${fromCents(totalCents)} 元最多只能分给 ${totalCents} 个人`
        }, 400, cors);
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
            return { error: jsonResponse({ error: "bad_request", message: "只能在群聊里发红包" }, 400, cors) };
        }

        const store = await loadAccountsForLock(env);
        const sender = store[login];
        if (!sender) {
            return { error: jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors) };
        }
        const balance = balanceCents(sender);
        if (balance < totalCents) {
            return {
                error: jsonResponse(
                    { error: "insufficient_balance", message: `余额不足，当前余额 ${fromCents(balance)} VTX` },
                    400,
                    cors
                )
            };
        }

        const members = conv.public ? Object.keys(store) : (conv.members || []);
        const allow = allowRequested.filter((item) => members.includes(item) && item !== login);
        if (allowRequested.length && allow.length !== allowRequested.length) {
            return { error: jsonResponse({ error: "bad_request", message: "被指定的人必须都在这个群里" }, 400, cors) };
        }
        const capacity = allow.length || Math.max(0, members.length - 1);
        if (capacity === 0) {
            return { error: jsonResponse({ error: "bad_request", message: "这个群里只有你自己，没有人可以抢" }, 400, cors) };
        }
        const limit = count || 0;
        if (limit && limit > capacity) {
            return {
                error: jsonResponse(
                    { error: "bad_request", message: `最多只有 ${capacity} 个人可以抢` },
                    400,
                    cors
                )
            };
        }
        if (totalCents < (limit || capacity)) {
            return {
                error: jsonResponse({
                    error: "bad_request",
                    message: `${fromCents(totalCents)} 元最多只能分给 ${totalCents} 个人（每人至少 0.01 元）`
                }, 400, cors)
            };
        }

        sender.money = fromCents(balance - totalCents);
        sender.trades = Array.isArray(sender.trades) ? sender.trades : [];
        sender.trades.push({
            name: "拼手速红包",
            description: `在群聊里发出 ${fromCents(totalCents)} 元红包`,
            time: shanghaiTimestamp(),
            price: `-${fromCents(totalCents)}`
        });
        await saveAccountsForLock(env, store);

        const messages = await readChatMessages(env, conv.id);
        const at = Date.now();
        const message = {
            id: randomCode(9),
            conversation: conv.id,
            sender: login,
            senderName: chatMemberAlias(conv, store, login),
            type: "redpacket",
            text: note || "拼手速红包",
            media: null,
            replyTo: null,
            mentions: [],
            forwarded: false,
            at,
            time: shanghaiTimestamp(at),
            packet: {
                id: `rp_${randomCode(6)}`,
                sender: login,
                senderName: chatMemberAlias(conv, store, login),
                totalCents,
                remainCents: totalCents,
                count: limit,
                allow,
                grabs: [],
                note,
                createdAt: at,
                expiresAt: at + CHAT_REDPACKET_TTL_MS,
                closed: false
            }
        };

        await appendMessage(env, conv, message);
        await saveConversation(env, conv);

        return {
            message,
            targets: conversationTargets(conv, store),
            view: conversationView(
                env,
                conv,
                chatEntry(await loadChatUser(env, login), conv.id),
                [...messages, message],
                login,
                store
            ),
            balance: sender.money
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, {
        type: "message",
        conversation: result.view,
        message: messageView(result.message)
    });

    return jsonResponse({
        ok: true,
        conversation: result.view,
        message: messageView(result.message),
        balance: result.balance
    }, 201, cors);
}

async function handleChatRedPacketGrab(request, env, cors, messageId) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const url = new URL(request.url);
    const convId = chatConversationId(url.searchParams.get("conversation") || "");
    if (!convId) {
        return jsonResponse({ error: "bad_request", message: "缺少会话 id" }, 400, cors);
    }

    const result = await withStoreLock(async () => {
        const conv = await readConversation(env, convId);
        if (!conv) {
            return { error: jsonResponse({ error: "not_found", message: "会话不存在" }, 404, cors) };
        }
        if (!chatMemberOf(conv, login)) {
            return { error: chatNotAMember(cors) };
        }
        const messages = await readChatMessages(env, convId);
        const message = messages.find((item) => item.id === messageId);
        if (!message || message.type !== "redpacket" || !message.packet) {
            return { error: jsonResponse({ error: "not_found", message: "红包不存在" }, 404, cors) };
        }
        const packet = message.packet;
        const store = await loadAccountsForLock(env);

        if (message.sender === login) {
            return { error: jsonResponse({ error: "forbidden", message: "不能抢自己发的红包" }, 403, cors) };
        }
        if (Array.isArray(packet.allow) && packet.allow.length && !packet.allow.includes(login)) {
            return { error: jsonResponse({ error: "forbidden", message: "这个红包只给指定的人抢" }, 403, cors) };
        }
        if ((packet.grabs || []).some((item) => item.login === login)) {
            return { error: jsonResponse({ error: "already_grabbed", message: "你已经抢过这个红包了" }, 409, cors) };
        }
        if (packet.closed || packet.remainCents <= 0) {
            return { error: jsonResponse({ error: "packet_empty", message: "红包已经被抢完了" }, 410, cors) };
        }
        if (Number(packet.count) > 0 && (packet.grabs || []).length >= Number(packet.count)) {
            return { error: jsonResponse({ error: "packet_empty", message: "红包已经被抢完了" }, 410, cors) };
        }
        if (Number(packet.expiresAt) && Number(packet.expiresAt) < Date.now()) {
            return { error: jsonResponse({ error: "packet_expired", message: "红包已过期" }, 410, cors) };
        }

        const capacity = redPacketCapacity(packet, conv, store);
        if (capacity <= 0) {
            return { error: jsonResponse({ error: "packet_empty", message: "红包已经被抢完了" }, 410, cors) };
        }

        const cents = randomShareCents(packet.remainCents, capacity);
        const grabber = store[login];
        if (!grabber) {
            return { error: jsonResponse({ error: "not_found", message: "账户不存在" }, 404, cors) };
        }

        grabber.money = fromCents(balanceCents(grabber) + cents);
        grabber.trades = Array.isArray(grabber.trades) ? grabber.trades : [];
        grabber.trades.push({
            name: "拼手速红包",
            description: `抢到 ${message.senderName || message.sender} 发的红包`,
            time: shanghaiTimestamp(),
            price: `+${fromCents(cents)}`
        });

        packet.grabs = packet.grabs || [];
        packet.grabs.push({
            login,
            name: chatMemberAlias(conv, store, login),
            cents,
            at: Date.now(),
            time: shanghaiTimestamp()
        });
        packet.remainCents -= cents;
        if (packet.remainCents <= 0
            || (Number(packet.count) > 0 && packet.grabs.length >= Number(packet.count))) {
            packet.closed = true;
            packet.remainCents = Math.max(0, packet.remainCents);
        }
        await saveAccountsForLock(env, store);
        message.packet = packet;
        await saveChatMessages(env, convId, messages);

        return {
            packet,
            cents,
            targets: conversationTargets(conv, store),
            view: messageView(message),
            balance: grabber.money
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, {
        type: "message:packet",
        conversation: convId,
        message: result.view
    });

    return jsonResponse({
        ok: true,
        cents: result.cents,
        amount: fromCents(result.cents),
        balance: result.balance,
        packet: result.packet
    }, 200, cors);
}

async function handleChatRedPacketDetail(request, env, cors, messageId) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const url = new URL(request.url);
    const convId = chatConversationId(url.searchParams.get("conversation") || "");
    if (!convId) {
        return jsonResponse({ error: "bad_request", message: "缺少会话 id" }, 400, cors);
    }

    const conv = await readConversation(env, convId);
    if (!conv) {
        return jsonResponse({ error: "not_found", message: "会话不存在" }, 404, cors);
    }
    if (!chatMemberOf(conv, login)) {
        return chatNotAMember(cors);
    }
    const messages = await readChatMessages(env, convId);
    const message = messages.find((item) => item.id === messageId);
    if (!message || message.type !== "redpacket" || !message.packet) {
        return jsonResponse({ error: "not_found", message: "红包不存在" }, 404, cors);
    }

    const mine = (message.packet.grabs || []).find((item) => item.login === login);
    return jsonResponse({
        ok: true,
        message: messageView(message),
        mine: mine ? { cents: mine.cents, amount: fromCents(mine.cents), time: mine.time } : null
    }, 200, cors);
}

async function handleChatRedPacketRefund(request, env, cors, messageId) {
    const session = await requireSession(request, env, cors);
    if (session.error) {
        return session.error;
    }
    const guard = chatGuard(env, cors);
    if (guard) {
        return guard;
    }

    const login = session.payload.sub;
    const url = new URL(request.url);
    const convId = chatConversationId(url.searchParams.get("conversation") || "");
    if (!convId) {
        return jsonResponse({ error: "bad_request", message: "缺少会话 id" }, 400, cors);
    }

    const result = await withStoreLock(async () => {
        const conv = await readConversation(env, convId);
        if (!conv) {
            return { error: jsonResponse({ error: "not_found", message: "会话不存在" }, 404, cors) };
        }
        const messages = await readChatMessages(env, convId);
        const message = messages.find((item) => item.id === messageId);
        if (!message || message.type !== "redpacket" || !message.packet) {
            return { error: jsonResponse({ error: "not_found", message: "红包不存在" }, 404, cors) };
        }
        if (message.sender !== login) {
            return { error: jsonResponse({ error: "forbidden", message: "只有发红包的人可以退回剩余金额" }, 403, cors) };
        }
        const packet = message.packet;
        if (packet.closed || packet.remainCents <= 0) {
            return { error: jsonResponse({ error: "packet_empty", message: "红包已经抢完了，没有剩余金额" }, 410, cors) };
        }

        const store = await loadAccountsForLock(env);
        const sender = store[login];
        if (sender) {
            sender.money = fromCents(balanceCents(sender) + packet.remainCents);
            sender.trades = Array.isArray(sender.trades) ? sender.trades : [];
            sender.trades.push({
                name: "拼手速红包退回",
                description: "退回未被领取的红包金额",
                time: shanghaiTimestamp(),
                price: `+${fromCents(packet.remainCents)}`
            });
            await saveAccountsForLock(env, store);
        }
        const refunded = packet.remainCents;
        packet.remainCents = 0;
        packet.closed = true;
        message.packet = packet;
        await saveChatMessages(env, convId, messages);

        return {
            refunded,
            balance: sender ? sender.money : "",
            targets: conversationTargets(conv, store),
            view: messageView(message)
        };
    });

    if (result.error) {
        return result.error;
    }

    await notifyChat(env, result.targets, { type: "message:packet", conversation: convId, message: result.view });
    return jsonResponse({
        ok: true,
        refunded: fromCents(result.refunded),
        balance: result.balance,
        packet: result.view.packet
    }, 200, cors);
}

async function handleChatRoomCompat(request, env, cors) {    const url = new URL(request.url);
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
        return await handleChatStatus(request, env, cors);
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

    /* 1.0.0：UID 找号、群号、建群邀请码 */
    let match;

    match = path.match(/^\/api\/chat\/users\/uid\/([^/]+)$/);
    if (match && method === "GET") {
        return await handleChatUserByUid(request, env, cors, decodeURIComponent(match[1]));
    }

    if (path === "/api/chat/groups/lookup" && method === "GET") {
        return await handleChatGroupLookup(request, env, cors);
    }

    if (path === "/api/chat/groups/join" && method === "POST") {
        return await handleChatGroupJoinByNumber(request, env, cors);
    }

    if (path === "/api/chat/invites") {
        if (method === "POST") {
            return await handleChatInviteCreate(request, env, cors);
        }
    }

    if (path === "/api/chat/invites/current" && method === "GET") {
        return await handleChatInviteCurrent(request, env, cors);
    }

    match = path.match(/^\/api\/chat\/invites\/([^/]+)(?:\/(join|leave|close))?$/);
    if (match) {
        const code = inviteCodeMatches(decodeURIComponent(match[1]));
        if (!code) {
            return jsonResponse({ error: "bad_request", message: "邀请码只能是 4 位或 8 位数字" }, 400, cors);
        }
        const action = match[2] || "";
        if (!action && method === "GET") {
            return await handleChatInviteDetail(request, env, cors, code);
        }
        if (!action && method === "DELETE") {
            return await handleChatInviteCancel(request, env, cors, code);
        }
        if (action === "join" && method === "POST") {
            return await handleChatInviteJoin(request, env, cors, code);
        }
        if (action === "leave" && method === "POST") {
            return await handleChatInviteLeave(request, env, cors, code);
        }
        if (action === "close" && method === "POST") {
            return await handleChatInviteClose(request, env, cors, code);
        }
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

    if (path === "/api/chat/admin/public-groups") {
        if (method === "GET") {
            return await handleChatAdminPublicGroups(request, env, cors);
        }
        if (method === "POST") {
            return await handleChatAdminCreatePublicGroup(request, env, cors);
        }
    }

    match = path.match(/^\/api\/chat\/admin\/public-groups\/([^/]+)$/);
    if (match) {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "频道 id 不合法" }, 400, cors);
        }
        if (method === "PATCH" || method === "PUT") {
            return await handleChatAdminUpdatePublicGroup(request, env, cors, id);
        }
        if (method === "DELETE") {
            return await handleChatAdminDeletePublicGroup(request, env, cors, id);
        }
    }

    match = path.match(/^\/api\/chat\/conversations\/([^/]+)\/messages$/);
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

    match = path.match(/^\/api\/chat\/conversations\/([^/]+)\/redpackets$/);
    if (match && method === "POST") {
        const id = chatConversationId(decodeURIComponent(match[1]));
        if (!id) {
            return jsonResponse({ error: "bad_request", message: "会话 id 不合法" }, 400, cors);
        }
        return await handleChatRedPacketCreate(request, env, cors, id);
    }

    match = path.match(/^\/api\/chat\/messages\/([^/]+)\/redpacket(?:\/(grab|refund))?$/);
    if (match) {
        const messageId = decodeURIComponent(match[1]);
        if (!CHAT_MESSAGE_ID_PATTERN.test(messageId)) {
            return jsonResponse({ error: "bad_request", message: "消息 id 不合法" }, 400, cors);
        }
        const action = match[2] || "";
        if (!action && method === "GET") {
            return await handleChatRedPacketDetail(request, env, cors, messageId);
        }
        if (action === "grab" && method === "POST") {
            return await handleChatRedPacketGrab(request, env, cors, messageId);
        }
        if (action === "refund" && method === "POST") {
            return await handleChatRedPacketRefund(request, env, cors, messageId);
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

/* ───────── 1.2.0：账户写锁（Durable Object，跨 isolate 串行化余额修改） ───────── */

export class AccountsLock {
    constructor(state) {
        this.state = state;
        this.holder = "";
        this.expiresAt = 0;
    }

    async fetch(request) {
        const { pathname } = new URL(request.url);
        const now = Date.now();

        if (pathname === "/lock") {
            if (this.holder && now < this.expiresAt) {
                return jsonResponse({ granted: false, retryAfterMs: this.expiresAt - now }, 200);
            }
            this.holder = randomCode(8);
            this.expiresAt = now + ACCOUNTS_LOCK_LEASE_MS;
            return jsonResponse({ granted: true, token: this.holder }, 200);
        }

        if (pathname === "/unlock") {
            this.holder = "";
            this.expiresAt = 0;
            return jsonResponse({ ok: true }, 200);
        }

        return jsonResponse({ error: "not_found" }, 404);
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

            if (url.pathname === "/api/shop" && request.method === "GET") {
                return await handleShopStock(request, env, cors);
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
            // 1.2.0：不再把内部异常信息（KV/上游细节）回给客户端
            console.error("vtx-api unhandled error", error && error.stack ? error.stack : error);
            return jsonResponse({
                error: "upstream_error",
                message: "服务端内部错误，请稍后重试"
            }, 502, cors);
        }
    }
};