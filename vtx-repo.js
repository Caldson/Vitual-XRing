(function () {
    const API_ROOT = "https://api.github.com";
    const DEFAULTS = { repo: "Caldson/Vitual-XRing", branch: "main" };

    let cachedDefaults = null;

    function toBase64(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    }

    function fromBase64(text) {
        const binary = atob(String(text || "").replace(/\s/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return new TextDecoder().decode(bytes);
    }

    function messageFor(status, detail) {
        if (status === 401) {
            return "GitHub token 无效或已过期。";
        }
        if (status === 403) {
            return "GitHub token 权限不足或被限流。请确认 token 对该仓库有 Contents 读写权限。";
        }
        if (status === 404) {
            return "找不到对应的仓库路径（可能已被删除或 token 无权访问）。";
        }
        if (status === 409 || status === 422) {
            return detail || "仓库状态已变化（提交冲突），请先 fetch 再重试。";
        }
        return detail || `GitHub API 请求失败（HTTP ${status}）。`;
    }

    async function config() {
        if (!cachedDefaults) {
            const base = await window.VTXApi.loadConfig();
            cachedDefaults = {
                repo: base.repo || DEFAULTS.repo,
                branch: base.branch || DEFAULTS.branch
            };
        }
        return cachedDefaults;
    }

    async function request(method, suffix, body) {
        const cfg = await config();
        const token = await window.VTXApi.getToken();
        const url = suffix.startsWith("http") ? suffix : `${API_ROOT}/repos/${cfg.repo}${suffix}`;

        const response = await fetch(url, {
            method,
            cache: "no-store",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                ...(body ? { "Content-Type": "application/json" } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (response.status === 204) {
            return null;
        }

        if (response.ok) {
            return response.json();
        }

        let detail = "";
        try {
            const payload = await response.json();
            detail = payload && payload.message ? payload.message : "";
        } catch (error) {
            detail = "";
        }

        const error = new Error(messageFor(response.status, detail));
        error.status = response.status;
        throw error;
    }

    function refPath(branch) {
        return `/git/ref/heads/${encodeURIComponent(branch)}`;
    }

    async function getHeadSha() {
        const cfg = await config();
        const ref = await request("GET", refPath(cfg.branch));
        return ref.object.sha;
    }

    async function getCommit(sha) {
        return request("GET", `/git/commits/${sha}`);
    }

    async function getTree(sha, recursive) {
        return request("GET", `/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
    }

    async function getBlob(sha) {
        const blob = await request("GET", `/git/blobs/${sha}`);
        return fromBase64(blob.content);
    }

    async function listTreeRecursive() {
        const head = await getHeadSha();
        const commit = await getCommit(head);
        const tree = await getTree(commit.tree.sha, true);
        return (tree.tree || []).filter((entry) => entry.type === "blob");
    }

    async function readFile(path, ref) {
        const cfg = await config();
        const branch = ref || cfg.branch;
        const file = await request(
            "GET",
            `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`
        );

        if (Array.isArray(file) || file.type !== "file") {
            throw new Error(`${path} 不是文件。`);
        }

        const text = file.content ? fromBase64(file.content) : await getBlob(file.sha);
        return { sha: file.sha, size: file.size, text };
    }

    async function readJson(path, ref) {
        const file = await readFile(path, ref);
        return { sha: file.sha, data: JSON.parse(file.text), text: file.text };
    }

    async function listDir(path) {
        const cfg = await config();
        const clean = String(path || "").replace(/^\/+|\/+$/g, "");
        const suffix = clean
            ? `/contents/${clean.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(cfg.branch)}`
            : `/contents?ref=${encodeURIComponent(cfg.branch)}`;
        const result = await request("GET", suffix);
        return Array.isArray(result) ? result : [result];
    }

    async function commitFiles(changes, message, options) {
        if (!Array.isArray(changes) || changes.length === 0) {
            throw new Error("没有需要提交的更改。");
        }

        const cfg = await config();
        const attempts = Math.max(1, Number(options && options.attempts) || 3);
        let lastError;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const head = await getHeadSha();
            const commit = await getCommit(head);
            const entries = [];

            for (const change of changes) {
                if (change.content === null) {
                    entries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
                    continue;
                }
                const blob = await request("POST", "/git/blobs", { content: change.content, encoding: "utf-8" });
                entries.push({ path: change.path, mode: change.mode || "100644", type: "blob", sha: blob.sha });
            }

            const tree = await request("POST", "/git/trees", { base_tree: commit.tree.sha, tree: entries });
            const newCommit = await request("POST", "/git/commits", {
                message,
                tree: tree.sha,
                parents: [head]
            });

            try {
                await request("PATCH", `/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
                    sha: newCommit.sha,
                    force: false
                });
                return newCommit;
            } catch (error) {
                if (error.status !== 409 && error.status !== 422) {
                    throw error;
                }
                lastError = error;
            }
        }

        throw lastError || new Error("写入冲突，请重试。");
    }

    async function amendHead(message) {
        const cfg = await config();
        const head = await getHeadSha();
        const commit = await getCommit(head);
        const newCommit = await request("POST", "/git/commits", {
            message,
            tree: commit.tree.sha,
            parents: (commit.parents || []).map((parent) => parent.sha)
        });

        await request("PATCH", `/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
            sha: newCommit.sha,
            force: true
        });

        return newCommit;
    }

    async function listCommits(limit) {
        const cfg = await config();
        const count = Math.max(1, Math.min(50, limit || 10));
        const result = await request(
            "GET",
            `/commits?sha=${encodeURIComponent(cfg.branch)}&per_page=${count}`
        );
        return result.map((item) => ({
            sha: item.sha,
            message: item.commit.message,
            author: item.commit.author ? item.commit.author.name : "",
            date: item.commit.author ? item.commit.author.date : ""
        }));
    }

    function filesUnder(entries, path) {
        const prefix = `${path.replace(/^\/+|\/+$/g, "")}/`;
        return entries.filter((entry) => entry.path === path || entry.path.startsWith(prefix));
    }

    async function deletePath(path) {
        const clean = String(path).replace(/^\/+|\/+$/g, "");
        let entries;
        try {
            const file = await request(
                "GET",
                `/contents/${clean.split("/").map(encodeURIComponent).join("/")}`
            );
            entries = Array.isArray(file) ? null : [{ path: clean, sha: file.sha }];
        } catch (error) {
            if (error.status !== 404) {
                throw error;
            }
            entries = null;
        }

        if (!entries) {
            entries = filesUnder(await listTreeRecursive(), clean);
        }

        if (entries.length === 0) {
            throw new Error(`找不到 ${clean}。`);
        }

        return commitFiles(
            entries.map((entry) => ({ path: entry.path, content: null })),
            `删除：${clean}`
        );
    }

    async function renamePath(oldPath, newPath) {
        const from = String(oldPath).replace(/^\/+|\/+$/g, "");
        const to = String(newPath).replace(/^\/+|\/+$/g, "");
        if (!to) {
            throw new Error("请输入新的名称。");
        }

        let entries;
        try {
            const file = await request(
                "GET",
                `/contents/${from.split("/").map(encodeURIComponent).join("/")}`
            );
            entries = Array.isArray(file)
                ? null
                : [{ path: from, sha: file.sha }];
        } catch (error) {
            if (error.status !== 404) {
                throw error;
            }
            entries = null;
        }

        const isFolder = !entries;
        if (isFolder) {
            entries = filesUnder(await listTreeRecursive(), from);
        }

        if (entries.length === 0) {
            throw new Error(`找不到 ${from}。`);
        }

        const changes = [];
        for (const entry of entries) {
            const text = await getBlob(entry.sha);
            const relative = isFolder ? entry.path.slice(from.length + 1) : "";
            const target = isFolder ? `${to}/${relative}` : to;
            changes.push({ path: target, content: text });
            changes.push({ path: entry.path, content: null });
        }

        return commitFiles(changes, `重命名：${from} → ${to}`);
    }

    async function createFolder(path) {
        const clean = String(path).replace(/^\/+|\/+$/g, "");
        if (!clean) {
            throw new Error("请输入文件夹路径。");
        }
        return commitFiles([{ path: `${clean}/.gitkeep`, content: "" }], `新建文件夹：${clean}`);
    }

    window.VTXRepo = {
        config,
        getHeadSha,
        getCommit,
        getTree,
        getBlob,
        listTreeRecursive,
        readFile,
        readJson,
        listDir,
        commitFiles,
        amendHead,
        listCommits,
        deletePath,
        renamePath,
        createFolder,
        toBase64,
        fromBase64
    };
})();
