/**
 * Vitual XRing 账户 API 客户端
 *
 * 用法：
 *   <script src="https://xsmmc.caldson.us.ci/vtx-sdk.js"></script>
 *   <script>
 *       // API 与本站同域时可直接用域名
 *       VTX.configure({ baseUrl: "https://xsmmc.caldson.us.ci" });
 *
 *       const session = await VTX.login("Kitawaga", "密码");
 *       console.log(session.account.money);
 *
 *       const all = await VTX.accounts();     // 全部账户（不含密码）
 *   </script>
 */
(function (global) {
    const BASE_KEY = "vtxApiBase";
    const TOKEN_KEY = "vtxApiToken";

    let baseUrl = "";
    let memoryToken = null;

    function readStorage(key) {
        try {
            return global.localStorage ? global.localStorage.getItem(key) : null;
        } catch (error) {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            if (!global.localStorage) {
                return;
            }
            if (value === null) {
                global.localStorage.removeItem(key);
            } else {
                global.localStorage.setItem(key, value);
            }
        } catch (error) {
            /* 隐私模式下忽略 */
        }
    }

    function resolveBase() {
        if (baseUrl) {
            return baseUrl;
        }
        const stored = readStorage(BASE_KEY);
        return stored ? String(stored).replace(/\/+$/, "") : "";
    }

    function currentToken() {
        return memoryToken || readStorage(TOKEN_KEY) || "";
    }

    function configure(options) {
        const value = options && options.baseUrl;
        if (!value) {
            throw new Error("VTX.configure 需要 baseUrl");
        }
        baseUrl = String(value).replace(/\/+$/, "");
        writeStorage(BASE_KEY, baseUrl);
        return baseUrl;
    }

    async function request(path, options = {}) {
        const base = resolveBase();
        if (!base) {
            throw new Error("尚未配置 API 地址，请先调用 VTX.configure({ baseUrl })");
        }

        const headers = { accept: "application/json" };
        const token = currentToken();

        if (token) {
            headers.authorization = `Bearer ${token}`;
        }

        let body;
        if (options.body !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(options.body);
        }

        const response = await fetch(`${base}${path}`, {
            method: options.method || "GET",
            headers,
            body,
            cache: "no-store"
        });

        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (error) {
            data = null;
        }

        if (!response.ok) {
            // Worker 的所有错误都返回 JSON；解析不出来说明这个地址根本不是我们的 API
            const notJson = data === null;
            const error = new Error(
                (data && data.message) ||
                (notJson
                    ? `请求失败（HTTP ${response.status}，返回的不是 JSON，该地址可能没有 API）`
                    : `请求失败（HTTP ${response.status}）`)
            );
            error.status = response.status;
            error.code = (data && data.error) || (notJson ? "not_json" : undefined);
            throw error;
        }

        return data;
    }

    async function login(loginName, password) {
        const data = await request("/api/login", {
            method: "POST",
            body: { login: loginName, password }
        });

        memoryToken = data.token;
        writeStorage(TOKEN_KEY, data.token);
        return data;
    }

    /**
     * 创建账户（成功后自动登录，返回结构与 login 相同，并带 created: true）。
     * @param {{ login: string, password: string, username?: string }} options
     */
    async function register(options) {
        const payload = options || {};
        const data = await request("/api/register", {
            method: "POST",
            body: {
                login: payload.login,
                password: payload.password,
                username: payload.username
            }
        });

        if (data && data.token) {
            memoryToken = data.token;
            writeStorage(TOKEN_KEY, data.token);
        }
        return data;
    }

    /** 采纳别处（例如 API_LOGIN.html 弹窗）拿到的 token */
    function setToken(token) {
        const value = String(token || "").trim();
        if (!value) {
            logout();
            return "";
        }
        memoryToken = value;
        writeStorage(TOKEN_KEY, value);
        return value;
    }

    function logout() {
        memoryToken = null;
        writeStorage(TOKEN_KEY, null);
    }

    function isLoggedIn() {
        return Boolean(currentToken());
    }

    async function me() {
        return request("/api/me");
    }

    async function accounts() {
        return request("/api/accounts");
    }

    async function account(loginName) {
        return request(`/api/accounts/${encodeURIComponent(loginName)}`);
    }

    /**
     * 写入某个游戏的数据（合并，不覆盖其它键）。
     * @param {string} game 游戏名称，例如 "Decrive"
     * @param {object} values 该游戏的数据
     */
    async function setData(game, values) {
        const name = String(game ?? "").trim();
        if (!name) {
            throw new Error('VTX.setData 需要游戏名称：VTX.setData("游戏名称", { ... })');
        }
        return request(`/api/me/data/${encodeURIComponent(name)}`, { method: "PUT", body: values || {} });
    }

    /** 读取某个游戏的数据 */
    async function getData(game) {
        const name = String(game ?? "").trim();
        if (!name) {
            throw new Error('VTX.getData 需要游戏名称：VTX.getData("游戏名称")');
        }
        return request(`/api/me/data/${encodeURIComponent(name)}`);
    }

    /**
     * 删除数据：传 game 删整个游戏命名空间，再传 key 只删其中一个键
     * @param {string} game 游戏名称
     * @param {string} [key] 该游戏下的键名
     */
    async function deleteData(game, key) {
        const name = String(game ?? "").trim();
        if (!name) {
            throw new Error('VTX.deleteData 需要游戏名称：VTX.deleteData("游戏名称"[, "键"])');
        }
        const base = `/api/me/data/${encodeURIComponent(name)}`;
        const suffix = key === undefined || key === null || key === "" ? "" : `/${encodeURIComponent(key)}`;
        return request(`${base}${suffix}`, { method: "DELETE" });
    }

    /**
     * 记账：type 为 payment（付款，扣余额）或 receipt（收款，加余额）。
     * 付款必须带 password；收款不需要密码。
     * @param {{ type: "payment"|"receipt", amount: string|number, party: string,
     *           description?: string, name?: string, password?: string }} options
     */
    async function trade(options) {
        const payload = options || {};
        return request("/api/me/trades", {
            method: "POST",
            body: {
                type: payload.type,
                amount: payload.amount,
                party: payload.party,
                description: payload.description,
                name: payload.name,
                password: payload.password
            }
        });
    }

    function pay(options) {
        return trade({ ...options, type: "payment" });
    }

    /** 收款不需要密码：VTX.receive({ amount, party, description }) */
    function receive(options) {
        return trade({ ...options, type: "receipt" });
    }

    /**
     * 生成新的收款码（旧码立即失效）。
     * @param {string|number} [amount] 预设金额；不传由付款方自行填写
     */
    function createReceiptCode(amount) {
        const body = amount === undefined || amount === null || String(amount).trim() === ""
            ? {}
            : { amount };
        return request("/api/me/receipt-code", { method: "POST", body });
    }

    /** 读取当前收款码（不会重新生成） */
    function receiptCode() {
        return request("/api/me/receipt-code");
    }

    /** 撤销当前收款码 */
    function revokeReceiptCode() {
        return request("/api/me/receipt-code", { method: "DELETE" });
    }

    /** 解析收款码内容（公开接口，不需要登录） */
    function receiptCodeInfo(code) {
        return request(`/api/receipt-codes/${encodeURIComponent(String(code || ""))}`);
    }

    /** 用收款码付款（需要密码） */
    function payReceiptCode(code, options) {
        const payload = options || {};
        return request(`/api/receipt-codes/${encodeURIComponent(String(code || ""))}/pay`, {
            method: "POST",
            body: {
                password: payload.password,
                amount: payload.amount,
                description: payload.description
            }
        });
    }

    /* 3.1.0：分享生态的只读 / 创建卡片接口（上传与定价购买请用完整版 vtx-api.js） */
    function socialRequest(path, options) {
        return request(`/api/social${path}`, options);
    }

    const social = {
        resolve: (url) => socialRequest(`/resolve?url=${encodeURIComponent(String(url || ""))}`),
        list: (kind, options = {}) => {
            const params = new URLSearchParams();
            for (const key of ["q", "owner", "sort", "before", "limit"]) {
                if (options[key] !== undefined && options[key] !== null && options[key] !== "") {
                    params.set(key, String(options[key]));
                }
            }
            const query = params.toString();
            return socialRequest(`/kinds/${encodeURIComponent(String(kind || ""))}${query ? `?${query}` : ""}`);
        },
        get: (kind, id) => socialRequest(`/kinds/${encodeURIComponent(String(kind || ""))}/${encodeURIComponent(String(id || ""))}`),
        share: (payload) => socialRequest("/shares", { method: "POST", body: payload || {} }),
        shareGet: (id) => socialRequest(`/shares/${encodeURIComponent(String(id || ""))}`),
        meeting: (no) => socialRequest(`/meetings/${encodeURIComponent(String(no || ""))}`)
    };

    global.VTX = {
        configure,
        social,
        login,
        register,
        setToken,
        logout,
        isLoggedIn,
        me,
        accounts,
        account,
        setData,
        getData,
        deleteData,
        trade,
        pay,
        receive,
        createReceiptCode,
        receiptCode,
        revokeReceiptCode,
        receiptCodeInfo,
        payReceiptCode,
        getToken: currentToken,
        get baseUrl() {
            return resolveBase();
        }
    };
})(typeof window !== "undefined" ? window : globalThis);
