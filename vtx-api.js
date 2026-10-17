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

    window.VTXApi = { commit, readAll, loadConfig, getToken };
})();
