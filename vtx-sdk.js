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

    async function setData(values) {
        return request("/api/me/data", { method: "PUT", body: values });
    }

    async function deleteData(key) {
        return request(`/api/me/data/${encodeURIComponent(key)}`, { method: "DELETE" });
    }

    /**
     * 记账：type 为 payment（付款，扣余额）或 receipt（收款，加余额）。
     * @param {{ type: "payment"|"receipt", amount: string|number, party: string,
     *           description?: string, name?: string, password: string }} options
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

    function receive(options) {
        return trade({ ...options, type: "receipt" });
    }

    global.VTX = {
        configure,
        login,
        register,
        setToken,
        logout,
        isLoggedIn,
        me,
        accounts,
        account,
        setData,
        deleteData,
        trade,
        pay,
        receive,
        getToken: currentToken,
        get baseUrl() {
            return resolveBase();
        }
    };
})(typeof window !== "undefined" ? window : globalThis);
