(function () {
    const DEFAULTS = { repo: "Caldson/Vitual-XRing", branch: "main", path: "account.json" };

    let cachedConfig = null;

    function toBase64(bytes) {
        let binary = "";
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    }

    function fromBase64(text) {
        const binary = atob(String(text).replace(/\s/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    function textFromBase64(text) {
        return new TextDecoder().decode(fromBase64(text));
    }

    function messageFor(status) {
        if (status === 401) {
            return "GitHub token 无效或已过期。";
        }
        if (status === 403) {
            return "GitHub token 权限不足或被限流。请确认 token 对该仓库有 Contents 读写权限。";
        }
        if (status === 404) {
            return "找不到仓库或 account.json，或 token 无权访问。";
        }
        return `GitHub API 请求失败（HTTP ${status}）。`;
    }

    async function request(token, url, options = {}) {
        const response = await fetch(url, {
            cache: "no-store",
            ...options,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                ...(options.headers || {})
            }
        });

        if (response.ok) {
            return response.json();
        }

        const error = new Error(messageFor(response.status));
        error.status = response.status;
        throw error;
    }

    // 1.2.0：仓库 token 只保存在当前标签页的 sessionStorage 里，
    // 不再从 secure.json 解密（那份文件等于把仓库写权限公开给所有人）。
    const REPO_TOKEN_KEY = "vtxRepoToken";

    async function loadConfig() {
        if (cachedConfig) {
            return cachedConfig;
        }

        cachedConfig = { ...DEFAULTS };
        return cachedConfig;
    }

    function setRepoToken(token) {
        try {
            sessionStorage.setItem(REPO_TOKEN_KEY, String(token || "").trim());
        } catch (error) {
            /* 隐私模式忽略 */
        }
    }

    function getRepoToken() {
        try {
            return sessionStorage.getItem(REPO_TOKEN_KEY) || "";
        } catch (error) {
            return "";
        }
    }

    function clearRepoToken() {
        try {
            sessionStorage.removeItem(REPO_TOKEN_KEY);
        } catch (error) {
            /* 忽略 */
        }
    }

    async function getToken() {
        const token = getRepoToken();
        if (!token) {
            throw new Error("未设置 GitHub 仓库 Token。1.2.0 起不再从 secure.json 解密，请在管理页填入（只保存在当前标签页）。");
        }
        return token;
    }

    async function readFile(token, config) {
        const url = `https://api.github.com/repos/${config.repo}/contents/${encodeURIComponent(config.path)}?ref=${encodeURIComponent(config.branch)}`;
        const file = await request(token, url);

        if (file.type !== "file") {
            throw new Error(`${config.path} 不是文件。`);
        }

        return { sha: file.sha, accounts: JSON.parse(textFromBase64(file.content)) };
    }

    async function writeFile(token, config, sha, accounts, commitMessage) {
        const url = `https://api.github.com/repos/${config.repo}/contents/${encodeURIComponent(config.path)}`;
        const text = `${JSON.stringify(accounts, null, 4)}\n`;

        await request(token, url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: commitMessage,
                content: toBase64(new TextEncoder().encode(text)),
                sha,
                branch: config.branch
            })
        });
    }

    async function readAll() {
        const config = await loadConfig();
        const token = await getToken();
        return (await readFile(token, config)).accounts;
    }

    async function commit(apply) {
        const config = await loadConfig();
        const token = await getToken();
        let lastError;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const { sha, accounts } = await readFile(token, config);
            const commitMessage = apply(accounts);

            try {
                await writeFile(token, config, sha, accounts, commitMessage);
                return accounts;
            } catch (error) {
                if (error.status !== 409 && error.status !== 422) {
                    throw error;
                }
                lastError = error;
            }
        }

        throw lastError || new Error("写入冲突，请重试。");
    }

    // ───────────────────────── 8.0：Workers API 客户端 ─────────────────────────
    // 账户数据搬到 Workers KV 后，页面统一走这里。1.2.0 起停用了「Workers 连不上就
    // 用仓库 token 直连 GitHub」的备用通道——那条通道等于把仓库写权限发给所有访客。

    const API_VERSION = "3.1.0";
    const TOKEN_KEY = "vtxToken";
    const EXPIRES_KEY = "vtxTokenExpires";
    const BASE_KEY = "vtxApiBase";
    const ACCOUNT_KEY = "vtxAccount";
    const API_TIMEOUT = 20000;
    const API_CANDIDATES = ["api", "https://vtx-api.minecraftcaldson.workers.dev/api"];

    function sessionToken() {
        try {
            return sessionStorage.getItem(TOKEN_KEY) || "";
        } catch (error) {
            return "";
        }
    }

    function currentLogin() {
        try {
            return sessionStorage.getItem(ACCOUNT_KEY) || "";
        } catch (error) {
            return "";
        }
    }

    function saveSession(login, token, expiresAt) {
        try {
            sessionStorage.setItem(ACCOUNT_KEY, login);
            sessionStorage.setItem(TOKEN_KEY, token || "");
            sessionStorage.setItem(EXPIRES_KEY, expiresAt || "");
        } catch (error) {
            /* 隐私模式忽略 */
        }
    }

    function clearSession() {
        try {
            sessionStorage.removeItem(TOKEN_KEY);
            sessionStorage.removeItem(EXPIRES_KEY);
            sessionStorage.removeItem("vtxLoginPending");
        } catch (error) {
            /* 忽略 */
        }
    }

    function hasSession() {
        return Boolean(sessionToken());
    }

    function resolveBase(candidate) {
        if (/^https?:/i.test(candidate)) {
            return candidate.replace(/\/+$/, "");
        }
        return new URL(candidate, document.baseURI).href.replace(/\/+$/, "");
    }

    function allowedBases() {
        const list = [];
        const extra = typeof window.VTX_API_BASE === "string" ? window.VTX_API_BASE.trim() : "";
        for (const candidate of extra ? [...API_CANDIDATES, extra] : API_CANDIDATES) {
            try {
                list.push(resolveBase(candidate));
            } catch (error) {
                /* 忽略无效候选 */
            }
        }
        return list;
    }

    // 1.2.0：只有同源地址和白名单里的地址可以接收 token / 密码
    function isAllowedBase(base) {
        let parsed;
        try {
            parsed = new URL(base);
        } catch (error) {
            return false;
        }
        if (parsed.origin === new URL(document.baseURI).origin) {
            return true;
        }
        return allowedBases().includes(parsed.href.replace(/\/+$/, ""));
    }

    function preferredBase() {
        // 1.2.0：不再接受 ?api= 这类 URL 参数，避免登录密码 / token 被导向攻击者域名
        try {
            const cached = sessionStorage.getItem(BASE_KEY);
            if (cached) {
                if (isAllowedBase(resolveBase(cached))) {
                    return [cached, ...API_CANDIDATES.filter((item) => item !== cached)];
                }
                sessionStorage.removeItem(BASE_KEY);
            }
        } catch (error) {
            /* 忽略 */
        }
        if (typeof window.VTX_API_BASE === "string" && window.VTX_API_BASE.trim()) {
            return [window.VTX_API_BASE.trim().replace(/\/+$/, "")];
        }
        return API_CANDIDATES;
    }

    function networkError(message, cause) {
        const error = new Error(message);
        error.workerUnavailable = true;
        error.cause = cause;
        return error;
    }

    async function apiFetch(base, path, options) {
        const method = options.method || "GET";
        const headers = {};
        const token = sessionToken();

        if (options.body !== undefined) {
            headers["content-type"] = "application/json";
        }
        if (options.auth !== false && token) {
            headers.authorization = `Bearer ${token}`;
        }

        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), API_TIMEOUT) : null;
        let response;

        try {
            response = await fetch(`${base}${path}`, {
                method,
                headers,
                cache: "no-store",
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: controller ? controller.signal : undefined
            });
        } catch (error) {
            throw networkError("无法连接 Vitual XRing 服务", error);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }

        let data = null;
        try {
            data = await response.json();
        } catch (error) {
            data = null;
        }

        if (!response.ok) {
            const error = new Error((data && data.message) || `请求失败（HTTP ${response.status}）`);
            error.status = response.status;
            error.code = data && data.error;
            error.body = data;
            throw error;
        }

        return data;
    }

    async function apiRequest(path, options = {}) {
        const candidates = preferredBase();
        let lastError = null;

        for (const candidate of candidates) {
            let base;
            try {
                base = resolveBase(candidate);
                if (!isAllowedBase(base)) {
                    throw new Error("API 地址不在允许列表内");
                }
            } catch (error) {
                continue;
            }
            try {
                const data = await apiFetch(base, path, options);
                try {
                    sessionStorage.setItem(BASE_KEY, candidate);
                } catch (error) {
                    /* 忽略 */
                }
                return data;
            } catch (error) {
                if (error.status && error.status < 500) {
                    throw error;
                }
                lastError = error;
            }
        }

        throw networkError("无法连接 Vitual XRing 服务，已切换到备用通道", lastError);
    }

    // 只有「Workers 连不上 / 服务端 5xx」才算离线；服务端明确拒绝（密码错误、余额不足等）
    // 必须原样抛给页面。1.2.0 起 401 也不再触发备用通道（那条通道已停用）。
    function isOffline(error) {
        if (!error) {
            return false;
        }
        if (error.workerUnavailable) {
            return true;
        }
        return Boolean(error.status && error.status >= 500);
    }

    function isFallbackReady() {
        // 1.2.0：浏览器直连 GitHub 改账户数据的备用通道已停用（等于把仓库写权限发给所有访客）
        return false;
    }

    async function legacyAccounts() {
        throw new Error("仓库直连备用通道已在 1.2.0 停用，请连接 Vitual XRing 服务后再试。");
    }

    async function legacyCommit(mutate) {
        throw new Error("仓库直连备用通道已在 1.2.0 停用，请连接 Vitual XRing 服务后再试。");
    }

    function moneyCents(value) {
        const amount = Number(String(value == null ? "" : value).replace(/[^0-9.-]/g, ""));
        return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
    }

    function centsText(cents) {
        return (cents / 100).toFixed(2);
    }

    function todayText() {
        const now = new Date();
        return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
    }

    function nowText() {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, "0");
        return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} `
            + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    async function login(loginName, password, geo) {
        const login = String(loginName || "").trim();

        try {
            const data = await apiRequest("/login", {
                method: "POST",
                auth: false,
                body: { login, password, geo: geo || undefined }
            });
            saveSession(data.login, data.token, data.expiresAt);
            return data;
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const accounts = await legacyAccounts();
            const account = accounts && accounts[login];

            if (!account || account.password !== password) {
                const invalid = new Error("账户名称或密码不正确");
                invalid.status = 401;
                invalid.code = "invalid_credentials";
                throw invalid;
            }

            saveSession(login, "", "");
            return { login, token: "", account, fallback: "github" };
        }
    }

    async function register(options) {
        const login = String(options.login || "").trim();
        const password = String(options.password || "");
        const username = String(options.username || "").trim();

        try {
            const data = await apiRequest("/register", {
                method: "POST",
                auth: false,
                body: { login, password, username, geo: options.geo || undefined }
            });
            saveSession(data.login, data.token, data.expiresAt);
            return data;
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            await legacyCommit((accounts) => {
                if (accounts[login]) {
                    throw new Error(`账户名称 ${login} 已被占用。`);
                }
                accounts[login] = { username: username || login, password, money: "0.00", trades: [] };
                return `创建账户：${login}`;
            });
            saveSession(login, "", "");
            return { login, created: true, fallback: "github" };
        }
    }

    async function me() {
        const data = await apiRequest("/me");
        return data.account;
    }

    async function accountMap() {
        try {
            const data = await apiRequest("/accounts");
            return data.accounts || {};
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            return await legacyAccounts();
        }
    }

    async function loadAccount(login) {
        const name = login || currentLogin();

        if (!name) {
            throw new Error("登录状态已失效，请重新登录。");
        }

        try {
            const account = await me();
            if (account && account.username !== undefined) {
                return account;
            }
            throw networkError("账户数据为空");
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const accounts = await legacyAccounts();
            const account = accounts && accounts[name];

            if (!account) {
                throw new Error("账户数据不存在，请重新登录。");
            }

            return account;
        }
    }

    async function checkin() {
        try {
            const data = await apiRequest("/me/checkin", { method: "POST" });
            return { account: data.account, trade: data.trade };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const login = currentLogin();
            let trade = null;
            const accounts = await legacyCommit((data) => {
                const account = data[login];
                if (!account) {
                    throw new Error("当前账户在 account.json 中不存在。");
                }
                const trades = Array.isArray(account.trades) ? account.trades : [];
                const today = todayText();
                if (trades.some((item) => item && item.name === "每日签到" && String(item.time).startsWith(today))) {
                    throw new Error("今天已经签到过了。");
                }
                account.money = centsText(moneyCents(account.money) + 500);
                trade = { name: "每日签到", description: "每日签到奖励", price: "+5.00", time: today, from: "官方", to: account.username || login };
                account.trades = trades;
                account.trades.push(trade);
                return `签到：${login} +5.00 VTX`;
            });
            return { account: accounts[login], trade, accounts };
        }
    }

    async function rename(username) {
        const name = String(username || "").trim();

        try {
            const data = await apiRequest("/me/username", { method: "PUT", body: { username: name } });
            return { account: data.account };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const login = currentLogin();
            const accounts = await legacyCommit((data) => {
                const account = data[login];
                if (!account) {
                    throw new Error("当前账户在 account.json 中不存在。");
                }
                account.username = name;
                return `更改用户名：${login} → ${name}`;
            });
            return { account: accounts[login], accounts };
        }
    }

    async function changePassword(currentPassword, newPassword) {
        try {
            await apiRequest("/me/password", { method: "PUT", body: { currentPassword, newPassword } });
            return { ok: true };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const login = currentLogin();
            const accounts = await legacyCommit((data) => {
                const account = data[login];
                if (!account) {
                    throw new Error("当前账户在 account.json 中不存在。");
                }
                account.password = newPassword;
                return `修改密码：${login}`;
            });
            return { ok: true, accounts };
        }
    }

    async function transfer(options) {
        const body = {
            to: options.to,
            amount: options.amount,
            password: options.password,
            description: options.description
        };

        try {
            const data = await apiRequest("/me/transfer", { method: "POST", body });
            return {
                account: data.account,
                target: data.target,
                trade: data.trade
            };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const login = currentLogin();
            const amountCents = moneyCents(options.amount);
            const accounts = await legacyCommit((data) => {
                const sender = data[login];
                const target = data[options.to];

                if (!sender) {
                    throw new Error("当前账户在 account.json 中不存在。");
                }
                if (sender.password !== options.password) {
                    throw new Error("账户密码不正确。");
                }
                if (!target) {
                    throw new Error(`收款账户 ${options.to} 不存在。`);
                }
                if (moneyCents(sender.money) < amountCents) {
                    throw new Error("余额不足。");
                }

                const senderName = sender.username || login;
                const targetName = target.username || options.to;
                const common = {
                    name: "转账",
                    description: options.description || "账户转账",
                    time: todayText(),
                    from: senderName,
                    to: targetName
                };

                sender.money = centsText(moneyCents(sender.money) - amountCents);
                target.money = centsText(moneyCents(target.money) + amountCents);
                sender.trades = Array.isArray(sender.trades) ? sender.trades : [];
                target.trades = Array.isArray(target.trades) ? target.trades : [];
                sender.trades.push({ ...common, price: `-${centsText(amountCents)}` });
                target.trades.push({ ...common, price: `+${centsText(amountCents)}` });

                return `转账：${senderName} → ${targetName} ${centsText(amountCents)} VTX`;
            });
            return { account: accounts[login], target: { login: options.to, account: accounts[options.to] }, accounts };
        }
    }

    async function withdraw(options) {
        try {
            const data = await apiRequest("/me/withdraw", {
                method: "POST",
                body: { amount: options.amount, password: options.password }
            });
            return { account: data.account, trade: data.trade, receipt: data.receipt };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const login = currentLogin();
            const amountCents = moneyCents(options.amount);
            let receipt = "";
            const accounts = await legacyCommit((data) => {
                const account = data[login];
                if (!account) {
                    throw new Error("当前账户在 account.json 中不存在。");
                }
                if (account.password !== options.password) {
                    throw new Error("账户密码不正确。");
                }
                if (moneyCents(account.money) < amountCents) {
                    throw new Error("余额不足。");
                }

                const time = nowText();
                const amount = centsText(amountCents);
                account.money = centsText(moneyCents(account.money) - amountCents);
                account.trades = Array.isArray(account.trades) ? account.trades : [];
                account.trades.push({
                    name: "提款",
                    description: "线下提款",
                    price: `-${amount}`,
                    time,
                    from: account.username || login,
                    to: "XRingCR"
                });

                receipt = `提款成功：${amount}VTX，请不要关闭此窗口，请将此窗口截图在XRingCR群中发给群主，次日将在学校给您纸币。提款时间：${time}`;
                return `提款：${account.username || login} -${amount} VTX`;
            });
            return { account: accounts[login], receipt, accounts };
        }
    }

    async function billing(options) {
        const type = options.type === "refund" ? "refund" : "charge";

        try {
            const data = await apiRequest("/me/billing", {
                method: "POST",
                body: {
                    type,
                    amount: options.amount,
                    name: options.name,
                    description: options.description
                }
            });
            return { account: data.account, trade: data.trade };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const login = currentLogin();
            const amountCents = moneyCents(options.amount);
            const isCharge = type === "charge";
            const accounts = await legacyCommit((data) => {
                const account = data[login];
                if (!account) {
                    throw new Error("当前账户在 account.json 中不存在。");
                }
                if (isCharge && moneyCents(account.money) < amountCents) {
                    throw new Error("余额不足。");
                }

                const username = account.username || login;
                const price = centsText(amountCents);
                account.money = centsText(isCharge
                    ? moneyCents(account.money) - amountCents
                    : moneyCents(account.money) + amountCents);
                account.trades = Array.isArray(account.trades) ? account.trades : [];
                account.trades.push({
                    name: options.name || (isCharge ? "扣费" : "退款"),
                    description: options.description || "",
                    price: `${isCharge ? "-" : "+"}${price}`,
                    time: nowText(),
                    from: isCharge ? username : "官方",
                    to: isCharge ? "AI" : username
                });

                return `${options.name || "记账"}：${username} ${isCharge ? "-" : "+"}${price} VTX`;
            });
            return { account: accounts[login], accounts };
        }
    }

    async function purchase(options) {
        try {
            const data = await apiRequest("/me/purchase", {
                method: "POST",
                body: {
                    id: options.id || options.item,
                    quantity: options.quantity,
                    password: options.password,
                    description: options.description
                }
            });
            return {
                account: data.account,
                trade: data.trade,
                receipt: data.receipt,
                stock: data.stock,
                item: data.item
            };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            throw networkError("Workers 不可用，暂时无法购买商品", error);
        }
    }

    /* 1.2.0：服务端商品库存（价格与扣款都由 Workers 决定） */
    async function shopStock() {
        const data = await apiRequest("/shop", { auth: false });
        return data.stock || {};
    }

    async function recordLoginLocation(entry) {
        try {
            const data = await apiRequest("/me/login-location", { method: "POST", body: entry || {} });
            return { account: data.account, entry: data.entry };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            const login = currentLogin();
            const accounts = await legacyCommit((data) => {
                const account = data[login];
                if (!account) {
                    throw new Error("账户不存在");
                }
                const history = Array.isArray(account.loginHistory) ? account.loginHistory : [];
                history.push(entry || {});
                account.loginHistory = history.slice(-20);
                return `登录记录：${login}${entry && entry.ip ? ` ${entry.ip}` : ""}`;
            });
            return { account: accounts[login], entry, accounts };
        }
    }

    async function adminAccounts() {
        return await apiRequest("/admin/accounts");
    }

    async function adminLog() {
        return await apiRequest("/admin/log");
    }

    async function adminCreate(options) {
        return await apiRequest("/admin/accounts", { method: "POST", body: options });
    }

    async function adminUpdate(login, changes) {
        return await apiRequest(`/admin/accounts/${encodeURIComponent(login)}`, { method: "PUT", body: changes });
    }

    async function adminDelete(login) {
        return await apiRequest(`/admin/accounts/${encodeURIComponent(login)}`, { method: "DELETE" });
    }

    async function redeem(code) {
        return await apiRequest("/me/redeem", { method: "POST", body: { code } });
    }

    async function adminGifts() {
        return await apiRequest("/admin/gifts");
    }

    async function adminCreateGift(options) {
        return await apiRequest("/admin/gifts", { method: "POST", body: options });
    }

    async function adminUpdateGift(code, changes) {
        return await apiRequest(`/admin/gifts/${encodeURIComponent(code)}`, { method: "PUT", body: changes });
    }

    async function adminDeleteGift(code) {
        return await apiRequest(`/admin/gifts/${encodeURIComponent(code)}`, { method: "DELETE" });
    }

    async function chatStatus() {
        return await apiRequest("/chat/status", { auth: false });
    }

    // ───────────────────────── 9.0：聊天室客户端 ─────────────────────────

    function chatBase() {
        const candidates = preferredBase();
        for (const candidate of candidates) {
            try {
                return resolveBase(candidate);
            } catch (error) {
                /* 试下一个 */
            }
        }
        throw new Error("找不到可用的 Vitual XRing 服务地址");
    }

    function chatPath(path) {
        return `/chat${path}`;
    }

    async function chatRequest(path, options = {}) {
        return await apiRequest(chatPath(path), options);
    }

    function encodeId(value) {
        return encodeURIComponent(String(value || ""));
    }

    function chatSocketUrl() {
        const token = sessionToken();
        const base = chatBase().replace(/^http/i, "ws");
        return `${base}/chat/ws?token=${encodeURIComponent(token)}`;
    }

    function chatMediaUrl(id, expiresAt) {
        const token = sessionToken();
        return `${chatBase()}/chat/media/${encodeId(id)}?token=${encodeURIComponent(token)}&t=${Number(expiresAt) || 0}`;
    }

    async function chatUpload(file) {
        const token = sessionToken();
        const base = chatBase();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 120000) : null;
        let response;

        try {
            response = await fetch(`${base}/chat/media`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": file.type || "application/octet-stream",
                    "x-file-name": encodeURIComponent(file.name || "file")
                },
                body: file,
                signal: controller ? controller.signal : undefined
            });
        } catch (error) {
            throw networkError("上传图片/文件/音乐失败", error);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }

        let data = null;
        try {
            data = await response.json();
        } catch (error) {
            data = null;
        }

        if (!response.ok) {
            const error = new Error((data && data.message) || `上传失败（HTTP ${response.status}）`);
            error.status = response.status;
            error.code = data && data.error;
            throw error;
        }

        return data.media;
    }

    const chat = {
        status: chatStatus,
        conversations: () => chatRequest("/conversations"),
        direct: (login) => chatRequest("/conversations/direct", { method: "POST", body: { login } }),
        createGroup: (name, members) => chatRequest("/conversations/group", {
            method: "POST",
            body: { name, members: members || [] }
        }),
        conversation: (id) => chatRequest(`/conversations/${encodeId(id)}`),
        rename: (id, name) => chatRequest(`/conversations/${encodeId(id)}`, {
            method: "PATCH",
            body: { name }
        }),
        remove: (id) => chatRequest(`/conversations/${encodeId(id)}`, { method: "DELETE" }),
        leave: (id) => chatRequest(`/conversations/${encodeId(id)}/leave`, { method: "POST" }),
        join: (id) => chatRequest(`/conversations/${encodeId(id)}/join`, { method: "POST" }),
        read: (id) => chatRequest(`/conversations/${encodeId(id)}/read`, { method: "POST" }),
        typing: (id) => chatRequest(`/conversations/${encodeId(id)}/typing`, { method: "POST" }),
        settings: (id, changes) => chatRequest(`/conversations/${encodeId(id)}/settings`, {
            method: "POST",
            body: changes || {}
        }),
        clear: (id) => chatRequest(`/conversations/${encodeId(id)}/clear`, { method: "POST" }),
        messages: (id, options = {}) => {
            const params = new URLSearchParams();
            if (options.before) {
                params.set("before", String(options.before));
            }
            if (options.limit) {
                params.set("limit", String(options.limit));
            }
            const query = params.toString();
            return chatRequest(`/conversations/${encodeId(id)}/messages${query ? `?${query}` : ""}`);
        },
        send: (id, payload) => chatRequest(`/conversations/${encodeId(id)}/messages`, {
            method: "POST",
            body: payload || {}
        }),
        recall: (id, messageId) => chatRequest(`/messages/${encodeId(messageId)}/recall?conversation=${encodeId(id)}`, {
            method: "POST"
        }),
        forward: (id, messageId, targets) => chatRequest(`/messages/${encodeId(messageId)}/forward?conversation=${encodeId(id)}`, {
            method: "POST",
            body: { targets: targets || [] }
        }),
        removeMessage: (id, messageId) => chatRequest(`/messages/${encodeId(messageId)}?conversation=${encodeId(id)}`, {
            method: "DELETE"
        }),
        search: (query, conversation) => {
            const params = new URLSearchParams({ q: query });
            if (conversation) {
                params.set("conversation", conversation);
            }
            return chatRequest(`/search?${params.toString()}`);
        },
        users: (query) => chatRequest(`/users?q=${encodeURIComponent(query || "")}`),
        contacts: () => chatRequest("/contacts"),
        requestFriend: (login, note) => chatRequest("/friends/requests", {
            method: "POST",
            body: { login, note: note || "" }
        }),
        decideFriend: (requestId, action) => chatRequest(`/friends/requests/${encodeId(requestId)}/${action}`, {
            method: "POST"
        }),
        removeFriend: (login) => chatRequest(`/friends/${encodeId(login)}`, { method: "DELETE" }),
        block: (login) => chatRequest("/blocks", { method: "POST", body: { login } }),
        unblock: (login) => chatRequest(`/blocks/${encodeId(login)}`, { method: "DELETE" }),
        addMembers: (id, members) => chatRequest(`/conversations/${encodeId(id)}/members`, {
            method: "POST",
            body: { members }
        }),
        removeMember: (id, login) => chatRequest(`/conversations/${encodeId(id)}/members/${encodeId(login)}`, {
            method: "DELETE"
        }),
        transferOwner: (id, login) => chatRequest(`/conversations/${encodeId(id)}/owner`, {
            method: "POST",
            body: { login }
        }),
        addAdmin: (id, login) => chatRequest(`/conversations/${encodeId(id)}/admins`, {
            method: "POST",
            body: { login }
        }),
        removeAdmin: (id, login) => chatRequest(`/conversations/${encodeId(id)}/admins/${encodeId(login)}`, {
            method: "DELETE"
        }),
        announcement: (id, text, pinned) => chatRequest(`/conversations/${encodeId(id)}/announcement`, {
            method: "PUT",
            body: { text, pinned }
        }),
        pinAnnouncement: (id, pinned) => chatRequest(`/conversations/${encodeId(id)}/announcement/pin`, {
            method: "POST",
            body: { pinned }
        }),
        setAlias: (id, alias) => chatRequest(`/conversations/${encodeId(id)}/me`, {
            method: "PATCH",
            body: { alias }
        }),
        upload: chatUpload,
        mediaUrl: chatMediaUrl,
        socketUrl: chatSocketUrl,
        adminConversations: () => chatRequest("/admin/conversations"),
        adminMessages: (id) => chatRequest(`/admin/conversations/${encodeId(id)}/messages`),
        adminRemoveMessage: (id, messageId) => chatRequest(`/admin/messages/${encodeId(messageId)}?conversation=${encodeId(id)}`, {
            method: "DELETE"
        }),
        adminRemoveConversation: (id) => chatRequest(`/admin/conversations/${encodeId(id)}`, { method: "DELETE" }),
        adminPublicGroups: () => chatRequest("/admin/public-groups"),
        createPublicGroup: (name, description, id) => chatRequest("/admin/public-groups", {
            method: "POST",
            body: { name, description, id }
        }),
        updatePublicGroup: (id, changes) => chatRequest(`/admin/public-groups/${encodeId(id)}`, {
            method: "PATCH",
            body: changes
        }),
        removePublicGroup: (id) => chatRequest(`/admin/public-groups/${encodeId(id)}`, { method: "DELETE" }),
        userByUid: (uid) => chatRequest(`/users/uid/${encodeId(uid)}`),
        groupLookup: (number) => chatRequest(`/groups/lookup?number=${encodeId(number)}`),
        joinGroupByNumber: (number) => chatRequest("/groups/join", {
            method: "POST",
            body: { number }
        }),
        createInvite: (digits, name) => chatRequest("/invites", {
            method: "POST",
            body: { digits, name }
        }),
        currentInvite: () => chatRequest("/invites/current"),
        invite: (code) => chatRequest(`/invites/${encodeId(code)}`),
        joinInvite: (code) => chatRequest(`/invites/${encodeId(code)}/join`, { method: "POST" }),
        leaveInvite: (code) => chatRequest(`/invites/${encodeId(code)}/leave`, { method: "POST" }),
        closeInvite: (code, name) => chatRequest(`/invites/${encodeId(code)}/close`, {
            method: "POST",
            body: { name }
        }),
        cancelInvite: (code) => chatRequest(`/invites/${encodeId(code)}`, { method: "DELETE" }),
        sendRedPacket: (id, payload) => chatRequest(`/conversations/${encodeId(id)}/redpackets`, {
            method: "POST",
            body: payload
        }),
        grabRedPacket: (id, messageId) => chatRequest(
            `/messages/${encodeId(messageId)}/redpacket/grab?conversation=${encodeId(id)}`,
            { method: "POST" }
        ),
        redPacket: (id, messageId) => chatRequest(
            `/messages/${encodeId(messageId)}/redpacket?conversation=${encodeId(id)}`
        ),
        refundRedPacket: (id, messageId) => chatRequest(
            `/messages/${encodeId(messageId)}/redpacket/refund?conversation=${encodeId(id)}`,
            { method: "POST" }
        ),
        /* 1.7.3：聊天室转账（先扣款，收款人点「收款」后到账） */
        sendTransfer: (id, payload) => chatRequest(`/conversations/${encodeId(id)}/transfers`, {
            method: "POST",
            body: payload
        }),
        claimTransfer: (id, messageId) => chatRequest(
            `/messages/${encodeId(messageId)}/transfer/claim?conversation=${encodeId(id)}`,
            { method: "POST" }
        ),
        refundTransfer: (id, messageId) => chatRequest(
            `/messages/${encodeId(messageId)}/transfer/refund?conversation=${encodeId(id)}`,
            { method: "POST" }
        )
    };

    /* ───────── 3.1.0：Vimidi / VMusic / Viratch / AUDIV / ViStyle / VClang / 动态 ───────── */

    function socialRequest(path, options = {}) {
        return apiRequest(`/social${path}`, options);
    }

    function socialBasePath() {
        return chatBase();
    }

    function socialFileUrl(id, options = {}) {
        const token = sessionToken();
        const params = new URLSearchParams();
        if (options.download) {
            params.set("download", "1");
        }
        if (token) {
            params.set("token", token);
        }
        const query = params.toString();
        return `${socialBasePath()}/social/file/${encodeId(id)}${query ? `?${query}` : ""}`;
    }

    async function socialUpload(kind, id, file, onProgress) {
        const token = sessionToken();
        const base = socialBasePath();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 180000) : null;
        let response;
        try {
            response = await fetch(`${base}/social/kinds/${encodeURIComponent(kind)}/${encodeId(id)}/file`, {
                method: "PUT",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": file.type || "application/octet-stream",
                    "x-file-name": encodeURIComponent(file.name || "file")
                },
                body: file,
                signal: controller ? controller.signal : undefined
            });
        } catch (error) {
            throw networkError("上传文件失败", error);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
        let data = null;
        try {
            data = await response.json();
        } catch (error) {
            data = null;
        }
        if (!response.ok) {
            const error = new Error((data && data.message) || `上传失败（HTTP ${response.status}）`);
            error.status = response.status;
            error.code = data && data.error;
            throw error;
        }
        if (typeof onProgress === "function") {
            onProgress(1);
        }
        return data;
    }

    async function socialImageUpload(file) {
        const token = sessionToken();
        const base = socialBasePath();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 60000) : null;
        let response;
        try {
            response = await fetch(`${base}/social/images`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": file.type || "application/octet-stream"
                },
                body: file,
                signal: controller ? controller.signal : undefined
            });
        } catch (error) {
            throw networkError("上传图片失败", error);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
        let data = null;
        try {
            data = await response.json();
        } catch (error) {
            data = null;
        }
        if (!response.ok) {
            const error = new Error((data && data.message) || `上传图片失败（HTTP ${response.status}）`);
            error.status = response.status;
            error.code = data && data.error;
            throw error;
        }
        return data;
    }

    function socialListQuery(options = {}) {
        const params = new URLSearchParams();
        for (const key of ["q", "owner", "sort", "before", "limit"]) {
            if (options[key] !== undefined && options[key] !== null && options[key] !== "") {
                params.set(key, String(options[key]));
            }
        }
        const query = params.toString();
        return query ? `?${query}` : "";
    }

    const social = {
        resolve: (url) => socialRequest(`/resolve?url=${encodeURIComponent(url)}`, { auth: false }),
        share: (payload) => socialRequest("/shares", { method: "POST", body: payload || {} }),
        shareGet: (id) => socialRequest(`/shares/${encodeId(id)}`, { auth: false }),
        list: (kind, options = {}) => socialRequest(`/kinds/${encodeURIComponent(kind)}${socialListQuery(options)}`),
        get: (kind, id) => socialRequest(`/kinds/${encodeURIComponent(kind)}/${encodeId(id)}`),
        create: (kind, payload) => socialRequest(`/kinds/${encodeURIComponent(kind)}`, {
            method: "POST",
            body: payload || {}
        }),
        update: (kind, id, changes) => socialRequest(`/kinds/${encodeURIComponent(kind)}/${encodeId(id)}`, {
            method: "PUT",
            body: changes || {}
        }),
        remove: (kind, id) => socialRequest(`/kinds/${encodeURIComponent(kind)}/${encodeId(id)}`, {
            method: "DELETE"
        }),
        upload: socialUpload,
        uploadImage: socialImageUpload,
        files: (kind, id) => socialRequest(`/kinds/${encodeURIComponent(kind)}/${encodeId(id)}/files`),
        setFiles: (kind, id, files) => socialRequest(`/kinds/${encodeURIComponent(kind)}/${encodeId(id)}/files`, {
            method: "PUT",
            body: { files: files || [] }
        }),
        publish: (kind, id) => socialRequest(`/kinds/${encodeURIComponent(kind)}/${encodeId(id)}/publish`, {
            method: "POST"
        }),
        like: (kind, id) => socialRequest(`/kinds/${encodeURIComponent(kind)}/${encodeId(id)}/like`, {
            method: "POST"
        }),
        purchase: (kind, id, password) => socialRequest(
            `/kinds/${encodeURIComponent(kind)}/${encodeId(id)}/purchase`,
            { method: "POST", body: { password: String(password || "") } }
        ),
        comment: (id, text) => socialRequest(`/kinds/dynamic/${encodeId(id)}/comments`, {
            method: "POST",
            body: { text }
        }),
        comments: (id) => socialRequest(`/kinds/dynamic/${encodeId(id)}/comments`),
        likeComment: (id, commentId) => socialRequest(
            `/kinds/dynamic/${encodeId(id)}/comments/${encodeId(commentId)}/like`,
            { method: "POST" }
        ),
        repost: (id, text) => socialRequest(`/kinds/dynamic/${encodeId(id)}/repost`, {
            method: "POST",
            body: { text }
        }),
        library: () => socialRequest("/me/library"),
        meeting: (no) => socialRequest(`/meetings/${encodeURIComponent(no)}`, { auth: false }),
        createMeeting: (payload) => socialRequest("/meetings", { method: "POST", body: payload || {} }),
        joinMeeting: (no, password) => socialRequest(`/meetings/${encodeURIComponent(no)}/join`, {
            method: "POST",
            body: { password: String(password || "") }
        }),
        endMeeting: (no) => socialRequest(`/meetings/${encodeURIComponent(no)}/end`, { method: "POST" }),
        fileUrl: socialFileUrl,
        base: socialBasePath,
        meetingSocketUrl: (no, name, peer, joinToken) => {
            const base = socialBasePath().replace(/^http/i, "ws");
            const params = new URLSearchParams({
                no: String(no || ""),
                name: String(name || "访客"),
                peer: String(peer || "")
            });
            if (joinToken) {
                params.set("token", String(joinToken));
            }
            return `${base}/social/meetings/ws?${params.toString()}`;
        }
    };

    /* ───────── 1.9.0：聊天室 UNO ───────── */

    const uno = {
        status: () => apiRequest("/uno/status", { auth: false }),
        rooms: () => apiRequest("/uno/rooms"),
        create: (payload) => apiRequest("/uno/rooms", { method: "POST", body: payload || {} }),
        join: (payload) => apiRequest("/uno/rooms/join", { method: "POST", body: payload || {} }),
        match: () => apiRequest("/uno/match", { method: "POST" }),
        room: (id) => apiRequest(`/uno/rooms/${encodeId(id)}`),
        leave: (id) => apiRequest(`/uno/rooms/${encodeId(id)}/leave`, { method: "POST" }),
        start: (id) => apiRequest(`/uno/rooms/${encodeId(id)}/start`, { method: "POST" }),
        settings: (id, changes) => apiRequest(`/uno/rooms/${encodeId(id)}/settings`, {
            method: "POST",
            body: changes || {}
        }),
        teams: (id, payload) => apiRequest(`/uno/rooms/${encodeId(id)}/teams`, {
            method: "POST",
            body: payload || {}
        }),
        play: (id, payload) => apiRequest(`/uno/rooms/${encodeId(id)}/play`, {
            method: "POST",
            body: payload || {}
        }),
        draw: (id) => apiRequest(`/uno/rooms/${encodeId(id)}/draw`, { method: "POST" }),
        pass: (id) => apiRequest(`/uno/rooms/${encodeId(id)}/pass`, { method: "POST" }),
        wild4: (id, drawAmount) => apiRequest(`/uno/rooms/${encodeId(id)}/wild4`, {
            method: "POST",
            body: { drawAmount }
        }),
        chat: (id, text, scope) => apiRequest(`/uno/rooms/${encodeId(id)}/chat`, {
            method: "POST",
            body: { text, scope }
        }),
        invite: (conversationId, roomId) => apiRequest(
            `/chat/conversations/${encodeId(conversationId)}/uno`,
            { method: "POST", body: { roomId } }
        )
    };

    /* ───────── 1.7.1：Vitx® 视频（服务端存储，大文件走 R2 分片） ───────── */

    // 「Bearer」拆开写，避免被日志脱敏工具截断
    const AUTH_SCHEME = ["B", "e", "a", "r", "e", "r"].join("");

    function videoBase() {
        return chatBase();
    }

    function videoRequest(path, options = {}) {
        return apiRequest(`/videos${path}`, options);
    }

    /* 原始二进制请求（上传文件 / 分片），不走 JSON 封装 */
    async function videoRawRequest(path, options = {}) {
        const base = videoBase();
        const headers = {
            ...(options.headers || {}),
            "content-type": options.contentType || "application/octet-stream"
        };
        const token = sessionToken();
        if (token) {
            headers.authorization = `${AUTH_SCHEME} ${token}`;
        }

        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), options.timeout || 600000) : null;
        let response;

        try {
            response = await fetch(`${base}${path}`, {
                method: options.method || "POST",
                headers,
                body: options.body,
                signal: controller ? controller.signal : undefined
            });
        } catch (error) {
            throw networkError("上传视频失败", error);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }

        let data = null;
        try {
            data = await response.json();
        } catch (error) {
            data = null;
        }

        if (!response.ok) {
            const failure = new Error((data && data.message) || `上传失败（HTTP ${response.status}）`);
            failure.status = response.status;
            failure.code = data && data.error;
            throw failure;
        }
        return data;
    }

    /* 举报证据照片：原始二进制上传，最多 4 MB，服务端保留 30 天 */
    async function videoReportUpload(file) {
        if (!file) {
            throw new Error("没有选择照片");
        }
        const data = await videoRawRequest("/videos/reports/media", {
            method: "POST",
            body: file,
            contentType: file.type || "application/octet-stream",
            headers: { "x-file-name": encodeURIComponent(file.name || "evidence") },
            timeout: 60000
        });
        return data && data.media ? data.media : null;
    }

    function videoReportMediaUrl(id) {
        const token = sessionToken();
        const query = token ? `?token=${encodeURIComponent(token)}` : "";
        return `${videoBase()}/videos/reports/media/${encodeId(id)}${query}`;
    }

    function videoPartBlob(file, index, chunkBytes) {
        const start = index * chunkBytes;
        return file.slice(start, Math.min(file.size, start + chunkBytes));
    }

    /* 分片上传：8 MB 一片，5 GB 需要 640 片，全部走 R2 multipart */
    async function videoUploadChunked(id, file, started, onProgress) {
        const chunkBytes = Number(started && started.chunkBytes) || 8 * 1024 * 1024;
        const totalParts = Math.max(1, Math.ceil(file.size / chunkBytes));

        for (let index = 0; index < totalParts; index += 1) {
            const blob = videoPartBlob(file, index, chunkBytes);
            await videoRawRequest(`/videos/${encodeId(id)}/upload/${index + 1}`, {
                method: "PUT",
                body: blob,
                contentType: file.type || "application/octet-stream"
            });
            if (typeof onProgress === "function") {
                const uploaded = Math.min(file.size, (index + 1) * chunkBytes);
                onProgress({
                    uploaded,
                    total: file.size,
                    percent: Math.round((uploaded / Math.max(1, file.size)) * 100),
                    part: index + 1,
                    parts: totalParts
                });
            }
        }

        const done = await videoRequest(`/${encodeId(id)}/upload/complete`, { method: "POST" });
        return done && done.video ? done.video : null;
    }

    async function videoUpload(file, meta, onProgress) {
        const payload = { ...(meta || {}) };
        payload.fileName = payload.fileName || file.name;
        payload.fileType = payload.fileType || file.type || "";
        payload.fileSize = payload.fileSize || file.size;
        if (payload.durSeconds === undefined) {
            payload.durSeconds = 0;
        }

        const created = await videoRequest("", { method: "POST", body: payload });
        const id = created && created.video ? created.video.id : "";
        if (!id) {
            throw new Error("服务端没有返回视频 ID");
        }

        // 分片上传对 R2 与 KV 分块都可用，优先走这条；失败再退回整包
        let started = null;
        try {
            started = await videoRequest(`/${encodeId(id)}/upload/start`, { method: "POST" });
        } catch (error) {
            started = null;
        }
        if (started && started.ok) {
            const video = await videoUploadChunked(id, file, started, onProgress);
            if (video) {
                return video;
            }
        }

        if (typeof onProgress === "function") {
            onProgress({ uploaded: 0, total: file.size, percent: 0, part: 0, parts: 1 });
        }
        const data = await videoRawRequest(`/videos/${encodeId(id)}/file`, {
            method: "PUT",
            body: file,
            contentType: file.type || "application/octet-stream"
        });
        if (typeof onProgress === "function") {
            onProgress({ uploaded: file.size, total: file.size, percent: 100, part: 1, parts: 1 });
        }
        return data && data.video ? data.video : null;
    }

    function videoFileUrl(id) {
        const token = sessionToken();
        const query = token ? `?token=${encodeURIComponent(token)}` : "";
        return `${videoBase()}/videos/${encodeId(id)}/file${query}`;
    }

    const video = {
        status: () => videoRequest("/status", { auth: false }),
        list: (options = {}) => {
            const params = new URLSearchParams();
            if (options.cat) {
                params.set("cat", options.cat);
            }
            if (options.q) {
                params.set("q", options.q);
            }
            const query = params.toString();
            return videoRequest(query ? `?${query}` : "");
        },
        get: (id) => videoRequest(`/${encodeId(id)}`),
        upload: videoUpload,
        uploadStart: (id) => videoRequest(`/${encodeId(id)}/upload/start`, { method: "POST" }),
        uploadAbort: (id) => videoRequest(`/${encodeId(id)}/upload/abort`, { method: "POST" }),
        fileUrl: videoFileUrl,
        view: (id) => videoRequest(`/${encodeId(id)}/view`, { method: "POST" }),
        like: (id) => videoRequest(`/${encodeId(id)}/like`, { method: "POST" }),
        coin: (id) => videoRequest(`/${encodeId(id)}/coin`, { method: "POST" }),
        /* 1.8.2：关注 UP 主 */
        following: () => videoRequest("/follows"),
        follow: (owner) => videoRequest(`/follows/${encodeId(owner)}`, { method: "POST" }),
        unfollow: (owner) => videoRequest(`/follows/${encodeId(owner)}`, { method: "DELETE" }),
        report: (id, payload) => videoRequest(`/${encodeId(id)}/report`, { method: "POST", body: payload }),
        reportUpload: videoReportUpload,
        reportMediaUrl: videoReportMediaUrl,
        reports: () => videoRequest("/reports"),
        handleReport: (reportId, action) => videoRequest(`/reports/${encodeId(reportId)}/handle`, {
            method: "POST",
            body: { action }
        }),
        remove: (id) => videoRequest(`/${encodeId(id)}`, { method: "DELETE" }),
        approve: (id) => videoRequest(`/${encodeId(id)}/approve`, { method: "POST" }),
        reject: (id) => videoRequest(`/${encodeId(id)}/reject`, { method: "POST" }),
        comment: (id, text) => videoRequest(`/${encodeId(id)}/comments`, { method: "POST", body: { text } }),
        likeComment: (id, commentId) => videoRequest(
            `/${encodeId(id)}/comments/${encodeId(commentId)}/like`,
            { method: "POST" }
        ),
        removeComment: (id, commentId) => videoRequest(
            `/${encodeId(id)}/comments/${encodeId(commentId)}`,
            { method: "DELETE" }
        )
    };

    /* ───────── 3.1.0：ViStyle 一键应用 ─────────
       只在一键应用后写入 localStorage，再由这里在每个公开页面注入 <style>。
       管理员 / 站主 / 投稿页面永不应用样式包，避免把后台改坏（页面要求明确禁止）。 */
    const STYLE_PACK_KEY = "vtxStylePack";
    const STYLE_BLOCKED_PAGES = /(^|\/)(admin|accounts-admin|manager|API_LOGIN|API_VTXPAY|vitxvideopublish|vistyle)(\.html)?($|\/)/i;

    function styleBlocked() {
        try {
            return STYLE_BLOCKED_PAGES.test(new URL(document.baseURI).pathname);
        } catch (error) {
            return true;
        }
    }

    function savedStyle() {
        try {
            const raw = localStorage.getItem(STYLE_PACK_KEY);
            if (!raw) {
                return null;
            }
            const value = JSON.parse(raw);
            return value && value.id ? value : null;
        } catch (error) {
            return null;
        }
    }

    async function applyStylePack(pack) {
        if (!pack || !pack.id) {
            throw new Error("样式包信息不完整");
        }
        if (styleBlocked()) {
            throw new Error("管理员页面不允许应用样式包");
        }
        const token = sessionToken();
        const base = chatBase();
        const response = await fetch(`${base}/social/file/${encodeId(pack.id)}?token=${encodeURIComponent(token)}`, {
            cache: "no-store"
        });
        if (!response.ok) {
            throw new Error(response.status === 403 ? "请先在 ViStyle 购买这个样式包" : "样式包读取失败");
        }
        const css = await response.text();
        let node = document.getElementById("vtx-user-style");
        if (!node) {
            node = document.createElement("style");
            node.id = "vtx-user-style";
            document.head.appendChild(node);
        }
        node.textContent = css;
        localStorage.setItem(STYLE_PACK_KEY, JSON.stringify({ id: pack.id, title: pack.title || "" }));
        return true;
    }

    async function applySavedStyle() {
        if (styleBlocked()) {
            return false;
        }
        const pack = savedStyle();
        if (!pack) {
            return false;
        }
        try {
            const token = sessionToken();
            const base = chatBase();
            const response = await fetch(`${base}/social/file/${encodeId(pack.id)}?token=${encodeURIComponent(token)}`, {
                cache: "no-store"
            });
            if (!response.ok) {
                return false;
            }
            const css = await response.text();
            let node = document.getElementById("vtx-user-style");
            if (!node) {
                node = document.createElement("style");
                node.id = "vtx-user-style";
                document.head.appendChild(node);
            }
            node.textContent = css;
            return true;
        } catch (error) {
            return false;
        }
    }

    function clearStylePack() {
        try {
            localStorage.removeItem(STYLE_PACK_KEY);
        } catch (error) {
            /* 忽略 */
        }
        const node = document.getElementById("vtx-user-style");
        if (node) {
            node.remove();
        }
    }

    if (typeof document !== "undefined" && !styleBlocked()) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => {
                applySavedStyle();
            }, { once: true });
        } else {
            setTimeout(applySavedStyle, 0);
        }
    }

    window.VTXApi = {
        version: API_VERSION,
        request: apiRequest,
        isOffline,
        sessionToken,
        currentLogin,
        saveSession,
        clearSession,
        hasSession,
        login,
        register,
        me,
        loadAccount,
        accounts: accountMap,
        checkin,
        rename,
        changePassword,
        transfer,
        withdraw,
        billing,
        purchase,
        shopStock,
        recordLoginLocation,
        redeem,
        adminAccounts,
        adminLog,
        adminCreate,
        adminUpdate,
        adminDelete,
        adminGifts,
        adminCreateGift,
        adminUpdateGift,
        adminDeleteGift,
        chatStatus,
        chat,
        social,
        applyStyle: applyStylePack,
        applySavedStyle,
        currentStyle: savedStyle,
        clearStyle: clearStylePack,
        uno,
        chatSocketUrl: chatSocketUrl,
        chatMediaUrl: chatMediaUrl,
        video,
        commit,
        readAll,
        loadConfig,
        getToken,
        setRepoToken,
        getRepoToken,
        clearRepoToken
    };
})();
