(function () {
    const SECURE_FILE = "secure.json";
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

    async function loadConfig() {
        if (cachedConfig) {
            return cachedConfig;
        }

        const response = await fetch(SECURE_FILE, { cache: "no-store" });
        if (!response.ok) {
            throw new Error("找不到 secure.json，请先用 crypto.html 生成并提交到仓库根目录。");
        }

        cachedConfig = { ...DEFAULTS, ...(await response.json()) };
        return cachedConfig;
    }

    async function getToken() {
        return window.VTXCrypto.decrypt(await loadConfig());
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
    // 账户数据搬到 Workers KV 后，页面统一走这里。只有在 Workers 完全连不上时，
    // 才会退回上面那套 GitHub 直连逻辑（secure.json 里的 token 作为备用通道）。

    const API_VERSION = "8.0.0";
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

    function preferredBase() {
        if (typeof window.VTX_API_BASE === "string" && window.VTX_API_BASE.trim()) {
            return [window.VTX_API_BASE.trim().replace(/\/+$/, "")];
        }
        try {
            const cached = sessionStorage.getItem(BASE_KEY);
            if (cached) {
                return [cached, ...API_CANDIDATES.filter((item) => item !== cached)];
            }
        } catch (error) {
            /* 忽略 */
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

    // 只有「Workers 连不上 / 服务端 5xx / 本地没有 token」才允许走 GitHub 备用通道，
    // 服务端明确拒绝（密码错误、余额不足等）必须原样抛给页面。
    function isOffline(error) {
        if (!error) {
            return false;
        }
        if (error.workerUnavailable) {
            return true;
        }
        if (error.status === 401 && !sessionToken()) {
            return true;
        }
        return Boolean(error.status && error.status >= 500);
    }

    function isFallbackReady() {
        return Boolean(window.VTXCrypto);
    }

    async function legacyAccounts() {
        try {
            const response = await fetch(`account.json?t=${Date.now()}`, { cache: "no-store" });
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            /* 文件已被迁移删除，改用 secure.json 里的 token */
        }
        return await readAll();
    }

    async function legacyCommit(mutate) {
        if (!isFallbackReady()) {
            throw new Error("备用通道不可用：缺少 vtx-crypto.js");
        }
        return await commit(mutate);
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
                    item: options.item,
                    quantity: options.quantity,
                    amount: options.amount,
                    password: options.password,
                    description: options.description
                }
            });
            return { account: data.account, trade: data.trade, receipt: data.receipt };
        } catch (error) {
            if (!isOffline(error)) {
                throw error;
            }
            throw networkError("Workers 不可用，需要改用仓库直连购买流程", error);
        }
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

    async function chatStatus() {
        return await apiRequest("/chat/status", { auth: false });
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
        recordLoginLocation,
        adminAccounts,
        adminLog,
        adminCreate,
        adminUpdate,
        adminDelete,
        chatStatus,
        commit,
        readAll,
        loadConfig,
        getToken
    };
})();
