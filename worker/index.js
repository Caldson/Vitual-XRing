/**
 * Vitual XRing 账户 API
 *
 * 环境变量（wrangler.toml 的 [vars]）：
 *   REPO / BRANCH / PATH        读取哪个仓库的账户文件
 *   ALLOWED_ORIGINS             允许跨域的站点，逗号分隔，"*" 为任意
 *   TOKEN_TTL_SECONDS           登录 token 有效期（秒）
 *   CACHE_TTL_SECONDS           account.json 缓存时间（秒）
 *
 * 机密（wrangler secret put）：
 *   GITHUB_TOKEN                读取/写入仓库；不设置则只能读（回退 raw.githubusercontent.com）
 *   SIGNING_SECRET              签发 token 的 HMAC 密钥（必填）
 */

const VERSION = "5.2.0";
const DEFAULT_REPO = "Caldson/Vitual-XRing";
const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "account.json";
const DEFAULT_TTL = 43200;
const DEFAULT_CACHE_TTL = 20;
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
    return {
        username: account.username || "",
        money: account.money || "0.00",
        trades: Array.isArray(account.trades) ? account.trades : [],
        data: account.data && typeof account.data === "object" && !Array.isArray(account.data) ? account.data : {}
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
        throw new HttpError(503, "write_unavailable", "服务端未配置 GITHUB_TOKEN，无法写入");
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

function cacheKey() {
    return new Request("https://vtx-api.internal/account.json", { method: "GET" });
}

function hasCache() {
    return typeof caches !== "undefined" && Boolean(caches.default);
}

async function loadAccounts(env) {
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

async function invalidateCache() {
    if (hasCache()) {
        try {
            await caches.default.delete(cacheKey());
        } catch (error) {
            /* 忽略 */
        }
    }
}

async function commitAccounts(env, mutate) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const { accounts, sha } = await readAccountFile(env);
        const message = mutate(accounts);

        try {
            await writeAccountFile(env, accounts, sha, message);
            await invalidateCache();
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

    if (!env.GITHUB_TOKEN) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 GITHUB_TOKEN，无法生成收款码" }, 503, cors);
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

    if (!env.GITHUB_TOKEN) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 GITHUB_TOKEN，无法撤销收款码" }, 503, cors);
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
    // 收款码要求「刷新/撤销后立即失效」，所以这里跳过账户缓存，直接读最新数据
    const { accounts } = await readAccountFile(env);
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

    if (!env.GITHUB_TOKEN) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 GITHUB_TOKEN，无法付款" }, 503, cors);
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

    return jsonResponse({
        token,
        expiresAt: new Date((now + ttl) * 1000).toISOString(),
        login,
        account: publicAccount(account)
    }, 200, cors);
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
        account: publicAccount(account)
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

    if (!env.GITHUB_TOKEN) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 GITHUB_TOKEN，无法写入" }, 503, cors);
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

    if (!env.GITHUB_TOKEN) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 GITHUB_TOKEN，无法写入" }, 503, cors);
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

    if (!env.GITHUB_TOKEN) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 GITHUB_TOKEN，无法创建账户" }, 503, cors);
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

    return jsonResponse({
        token,
        expiresAt: new Date((now + ttl) * 1000).toISOString(),
        login,
        created: true,
        account: publicAccount(accounts[login])
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

    if (!env.GITHUB_TOKEN) {
        return jsonResponse({ error: "write_unavailable", message: "服务端未配置 GITHUB_TOKEN，无法写入" }, 503, cors);
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
                return jsonResponse({ name: "Vitual XRing API", version: VERSION, ok: true }, 200, cors);
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
