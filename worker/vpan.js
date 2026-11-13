/*
 * Vitual XRing 10.0.0 — VPAN 云盘
 *
 * 设计目标：像 123 盘 / 蓝奏云一样「打开就能传、传完就能发链接」，
 * 不做限速、不做强制客户端、不做多余跳转。
 *
 * 存储：
 *   - 小文件（≤ 20 MB）直接放 Workers KV；
 *   - 大文件放 GitHub Release 草稿（复用视频存储的 GITHUB_TOKEN），
 *     每个文件一个 release，32 MB 一片，单文件上限 2 GB；
 *   - 绑定了 R2（VIDEO_BUCKET）时同样可用，后续可切到 R2。
 * 套餐：5 GB 免费，其余套餐按月购买；10 GB 首次购买首月 49.99 VTX。
 */
const VPAN_VERSION = "10.0.0";
const VPAN_GB = 1024 * 1024 * 1024;
const VPAN_TB = 1024 * VPAN_GB;
const VPAN_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const VPAN_INLINE_MAX = 20 * 1024 * 1024;
const VPAN_CHUNK_BYTES = 32 * 1024 * 1024;
const VPAN_MAX_FILE = 2 * 1024 * 1024 * 1024;
const VPAN_MAX_FILES = 2000;
const VPAN_NAME_MAX = 120;
const VPAN_SHARE_TOKEN = /^[A-Za-z0-9]{12,40}$/;

const VPAN_PLANS = [
    { id: "free", name: "5 GB 免费", quota: 5 * VPAN_GB, price: "0.00", firstPrice: "", tag: "永久免费" },
    { id: "vpan-10gb", name: "10 GB", quota: 10 * VPAN_GB, price: "200.00", firstPrice: "49.99", tag: "首月 49.99 VTX" },
    { id: "vpan-20gb", name: "20 GB", quota: 20 * VPAN_GB, price: "400.00" },
    { id: "vpan-50gb", name: "50 GB", quota: 50 * VPAN_GB, price: "1500.00" },
    { id: "vpan-100gb", name: "100 GB", quota: 100 * VPAN_GB, price: "2500.00" },
    { id: "vpan-500gb", name: "500 GB", quota: 500 * VPAN_GB, price: "4400.00" },
    { id: "vpan-1tb", name: "1 TB", quota: 1 * VPAN_TB, price: "5500.00" },
    { id: "vpan-2tb", name: "2 TB", quota: 2 * VPAN_TB, price: "8000.00" },
    { id: "vpan-5tb", name: "5 TB", quota: 5 * VPAN_TB, price: "15000.00" },
    { id: "vpan-10tb", name: "10 TB", quota: 10 * VPAN_TB, price: "20000.00" },
    { id: "vpan-20tb", name: "20 TB", quota: 20 * VPAN_TB, price: "40000.00" },
    { id: "vpan-50tb", name: "50 TB", quota: 50 * VPAN_TB, price: "200000.00" },
    { id: "vpan-100tb", name: "100 TB", quota: 100 * VPAN_TB, price: "2000000.00" }
];

const VPAN_INDEX_PREFIX = "vpan:index:";
const VPAN_DATA_PREFIX = "vpan:data:";
const VPAN_SHARE_PREFIX = "vpan:share:";
const VPAN_GH_TAG_PREFIX = "vpan-store/";

function vpanPlan(id) {
    return VPAN_PLANS.find((plan) => plan.id === id) || VPAN_PLANS[0];
}

function vpanActive(account) {
    const sub = account && account.vpan && typeof account.vpan === "object" ? account.vpan : null;
    if (!sub || !sub.planId || Number(sub.expiresAt) <= Date.now()) {
        return { plan: VPAN_PLANS[0], sub: null, active: false };
    }
    const plan = VPAN_PLANS.find((item) => item.id === sub.planId);
    if (!plan || plan.id === "free") {
        return { plan: VPAN_PLANS[0], sub: null, active: false };
    }
    return { plan, sub, active: true };
}

function vpanPlanView(account) {
    const { plan, sub, active } = vpanActive(account);
    return {
        planId: plan.id,
        name: plan.name,
        quota: plan.quota,
        active,
        expiresAt: active ? Number(sub.expiresAt) : 0,
        price: plan.price,
        firstPrice: plan.firstPrice || "",
        tag: plan.tag || ""
    };
}

function vpanSizeText(bytes) {
    const value = Number(bytes) || 0;
    if (value >= VPAN_TB) return `${(value / VPAN_TB).toFixed(value % VPAN_TB === 0 ? 0 : 1)} TB`;
    if (value >= VPAN_GB) return `${(value / VPAN_GB).toFixed(value % VPAN_GB === 0 ? 0 : 1)} GB`;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
}

function vpanMoneyText(value) {
    let text = String(value == null ? "" : value).trim().replace(/,/g, "");
    if (!text) return "";
    let sign = "";
    if (text[0] === "+" || text[0] === "-") {
        sign = text[0] === "-" ? "-" : "";
        text = text.slice(1);
    }
    const scientific = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
    if (scientific) {
        const whole = scientific[1];
        const fraction = scientific[2] || "";
        const power = Number(scientific[3]);
        const digits = whole + fraction;
        const point = whole.length + power;
        if (point <= 0) text = "0." + "0".repeat(-point) + digits;
        else if (point >= digits.length) text = digits + "0".repeat(point - digits.length);
        else text = digits.slice(0, point) + "." + digits.slice(point);
        text = text.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    }
    return sign + text;
}

function vpanAddMoney(value, deltaCents) {
    const text = vpanMoneyText(value);
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!match) return String(value == null ? "0.00" : value);
    const base = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
    let delta;
    try {
        delta = BigInt(deltaCents);
    } catch (error) {
        delta = 0n;
    }
    const total = base + delta;
    const negative = total < 0n;
    const abs = negative ? -total : total;
    return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function vpanCents(value) {
    const text = vpanMoneyText(value);
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!match) return null;
    return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function vpanRandom(bytes) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const data = new Uint8Array(Number(bytes) || 10);
    crypto.getRandomValues(data);
    let out = "";
    for (let index = 0; index < data.length; index += 1) out += alphabet[data[index] % alphabet.length];
    return out;
}

function vpanIndexKey(login) {
    return `${VPAN_INDEX_PREFIX}${login}`;
}

function vpanDataKey(login, id) {
    return `${VPAN_DATA_PREFIX}${login}:${id}`;
}

function vpanShareKey(token) {
    return `${VPAN_SHARE_PREFIX}${token}`;
}

function vpanName(raw) {
    return String(raw == null ? "" : raw)
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, VPAN_NAME_MAX);
}

function vpanContentType(meta) {
    return String((meta && meta.type) || "application/octet-stream").slice(0, 120);
}

function vpanDownloadName(name) {
    const clean = vpanName(name) || "download";
    return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

async function vpanReadIndex(env, login) {
    const value = await env.ACCOUNTS_KV.get(vpanIndexKey(login), "json");
    return Array.isArray(value) ? value.filter((item) => item && item.id) : [];
}

async function vpanWriteIndex(env, login, index) {
    await env.ACCOUNTS_KV.put(vpanIndexKey(login), JSON.stringify(index));
}

function vpanUsed(index) {
    return index.reduce((total, item) => total + (Number(item.size) || 0), 0);
}

function vpanFileView(meta) {
    return {
        id: meta.id,
        name: meta.name,
        size: Number(meta.size) || 0,
        type: meta.type || "application/octet-stream",
        status: meta.status || "ready",
        at: Number(meta.at) || 0,
        updated: Number(meta.updated) || 0,
        storage: meta.storage || "kv",
        share: meta.share && meta.share.token ? {
            token: meta.share.token,
            expiresAt: Number(meta.share.expiresAt) || 0,
            password: Boolean(meta.share.password)
        } : null
    };
}

/* ───────── GitHub Release 存储 ───────── */

function vpanGithub(env) {
    const token = String((env && env.GITHUB_TOKEN) || "").trim();
    const repo = String((env && (env.VIDEO_GH_REPO || env.REPO)) || "").trim();
    if (/^(off|none|kv)$/i.test(repo)) return null;
    if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return { token, repo };
}

function vpanGhHeaders(storage) {
    return {
        authorization: `Bearer ${storage.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "vtx-api-vpan-storage"
    };
}

async function vpanGhFailure(response, action) {
    let detail = "";
    try {
        const data = await response.json();
        detail = String((data && (data.message || data.error)) || "");
    } catch (error) {
        detail = "";
    }
    return new Error(`${action}失败（GitHub HTTP ${response.status}）${detail ? "：" + detail.slice(0, 120) : ""}`);
}

async function vpanGhCreateRelease(storage, id) {
    const response = await fetch(`https://api.github.com/repos/${storage.repo}/releases`, {
        method: "POST",
        headers: { ...vpanGhHeaders(storage), "content-type": "application/json" },
        body: JSON.stringify({
            tag_name: `${VPAN_GH_TAG_PREFIX}${id}`,
            name: `VPAN 文件 ${id}`,
            body: "VPAN 云盘文件存储（草稿，不公开）。请勿手动修改。",
            draft: true,
            prerelease: false
        })
    });
    if (!response.ok) throw await vpanGhFailure(response, "创建 VPAN 存储 release");
    const data = await response.json();
    if (!Number(data && data.id)) throw new Error("创建 VPAN 存储 release：返回里没有 id");
    return Number(data.id);
}

async function vpanGhUploadPart(storage, releaseId, index, buffer) {
    const name = `p${String(index).padStart(3, "0")}`;
    const response = await fetch(`https://uploads.github.com/repos/${storage.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { ...vpanGhHeaders(storage), "content-type": "application/octet-stream", accept: "application/vnd.github+json" },
        body: buffer
    });
    if (!response.ok) throw await vpanGhFailure(response, `上传第 ${index} 片`);
    const data = await response.json();
    if (!Number(data && data.id)) throw new Error(`上传第 ${index} 片：返回里没有 asset id`);
    return { assetId: Number(data.id), size: Number(data.size) || buffer.byteLength };
}

async function vpanGhDeleteRelease(storage, releaseId) {
    if (!storage || !releaseId) return;
    try {
        await fetch(`https://api.github.com/repos/${storage.repo}/releases/${releaseId}`, {
            method: "DELETE",
            headers: vpanGhHeaders(storage)
        });
    } catch (error) {
        /* 清理失败不阻塞用户操作 */
    }
}

async function vpanGhOpenAsset(storage, assetId) {
    return await fetch(`https://api.github.com/repos/${storage.repo}/releases/assets/${assetId}`, {
        headers: { ...vpanGhHeaders(storage), accept: "application/octet-stream" }
    });
}

/* ───────── 计划 / 文件接口 ───────── */

function vpanError(jsonResponse, cors, status, code, message) {
    return jsonResponse({ error: code, message }, status, cors);
}

function vpanStream(meta, env, storage) {
    if (meta.storage === "kv") {
        return env.ACCOUNTS_KV.get(vpanDataKey(meta.owner, meta.id), "arrayBuffer");
    }
    return new ReadableStream({
        async start(controller) {
            try {
                for (const part of meta.parts || []) {
                    const response = await vpanGhOpenAsset(storage, part.assetId);
                    if (!response.ok || !response.body) throw new Error("读取文件分片失败");
                    const reader = response.body.getReader();
                    while (true) {
                        const step = await reader.read();
                        if (step.done) break;
                        controller.enqueue(step.value);
                    }
                }
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        }
    });
}

function vpanCentsText(cents) {
    const value = typeof cents === "bigint" ? cents : 0n;
    const negative = value < 0n;
    const abs = negative ? -value : value;
    return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

async function vpanDownloadResponse(meta, env, cors, request) {
    let body;
    if (meta.storage === "kv") {
        const data = await env.ACCOUNTS_KV.get(vpanDataKey(meta.owner, meta.id), "arrayBuffer");
        if (!data) {
            return new Response(JSON.stringify({ error: "not_found", message: "文件内容不存在" }), {
                status: 404,
                headers: { "content-type": "application/json; charset=utf-8", ...cors }
            });
        }
        body = data;
    } else {
        const storage = vpanGithub(env);
        if (!storage) {
            return new Response(JSON.stringify({ error: "storage_unavailable", message: "VPAN 大文件存储暂不可用" }), {
                status: 503,
                headers: { "content-type": "application/json; charset=utf-8", ...cors }
            });
        }
        body = vpanStream(meta, env, storage);
    }
    return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
            "content-type": vpanContentType(meta),
            "content-length": String(Number(meta.size) || 0),
            "content-disposition": vpanDownloadName(meta.name),
            "cache-control": "private, max-age=0, must-revalidate",
            "x-content-type-options": "nosniff",
            ...cors
        }
    });
}

export async function routeVpan(request, env, cors, ctx) {
    const {
        jsonResponse, readJsonBody, plainObject, requireSession, loadAccounts,
        commitAccounts, checkPassword, pushTrade, HttpError, fromCents, shanghaiTimestamp, withStoreLock
    } = ctx;
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // api/vpan/...
    const section = parts[2] || "";
    const method = request.method;

    if (!env.ACCOUNTS_KV) return vpanError(jsonResponse, cors, 503, "storage_unavailable", "VPAN 需要 Workers KV");

    if (section === "plans" && method === "GET") {
        return jsonResponse({
            ok: true,
            version: VPAN_VERSION,
            plans: VPAN_PLANS.map((plan) => ({
                ...plan,
                quotaText: vpanSizeText(plan.quota)
            }))
        }, 200, cors);
    }

    if (section === "share") {
        const token = decodeURIComponent(parts[3] || "");
        if (!VPAN_SHARE_TOKEN.test(token)) return vpanError(jsonResponse, cors, 400, "bad_request", "分享链接不合法");
        const target = await env.ACCOUNTS_KV.get(vpanShareKey(token), "json");
        if (!target || !target.login || !target.id) return vpanError(jsonResponse, cors, 404, "not_found", "分享链接不存在或已失效");
        const index = await vpanReadIndex(env, target.login);
        const meta = index.find((item) => item.id === target.id && item.status === "ready");
        if (!meta || !meta.share || meta.share.token !== token) return vpanError(jsonResponse, cors, 404, "not_found", "分享链接不存在或已失效");
        if (Number(meta.share.expiresAt) && Number(meta.share.expiresAt) <= Date.now()) {
            return vpanError(jsonResponse, cors, 410, "share_expired", "分享链接已过期");
        }
        if (meta.share.password) {
            const given = String(url.searchParams.get("password") || "");
            if (given !== meta.share.password) return vpanError(jsonResponse, cors, 401, "password_required", "需要分享密码");
        }
        const accounts = await loadAccounts(env);
        const ownerName = String((accounts[target.login] && accounts[target.login].username) || target.login);
        if (parts[4] === "download") {
            return await vpanDownloadResponse({ ...meta, owner: target.login }, env, cors, request);
        }
        return jsonResponse({
            ok: true,
            file: {
                id: meta.id,
                name: meta.name,
                size: meta.size,
                type: meta.type,
                ownerName,
                at: meta.at,
                share: { expiresAt: meta.share.expiresAt, password: Boolean(meta.share.password) }
            }
        }, 200, cors);
    }

    const session = await requireSession(request, env, cors);
    if (session.error) return session.error;
    const login = session.payload.sub;
    const accounts = await loadAccounts(env);
    const account = accounts[login];
    if (!account) return vpanError(jsonResponse, cors, 404, "not_found", "账户不存在");
    const index = await vpanReadIndex(env, login);

    if (section === "me" && method === "GET") {
        const plan = vpanPlanView(account);
        return jsonResponse({
            ok: true,
            plan,
            usedBytes: vpanUsed(index),
            quotaBytes: plan.quota,
            maxFileBytes: Math.min(VPAN_MAX_FILE, plan.quota),
            inlineMaxBytes: VPAN_INLINE_MAX,
            chunkBytes: VPAN_CHUNK_BYTES,
            fileCount: index.length,
            plans: VPAN_PLANS
        }, 200, cors);
    }

    if (section === "subscribe" && method === "POST") {
        const body = plainObject(await readJsonBody(request));
        const plan = vpanPlan(String(body.planId || ""));
        if (plan.id === "free") return vpanError(jsonResponse, cors, 400, "bad_request", "免费套餐不需要购买");
        const password = String(body.password || "");
        const first = !(account.vpanFirst && account.vpanFirst[plan.id]);
        const price = first && plan.firstPrice ? plan.firstPrice : plan.price;
        const priceCents = vpanCents(price);
        if (priceCents === null) return vpanError(jsonResponse, cors, 500, "server_error", "套餐价格配置错误");
        const used = vpanUsed(index);
        if (used > plan.quota) {
            return vpanError(jsonResponse, cors, 400, "quota_exceeded", `当前已使用 ${vpanSizeText(used)}，超过 ${plan.name} 配额`);
        }
        try {
            await commitAccounts(env, async (data) => {
                const own = data[login];
                await checkPassword(own, password);
                const balance = vpanCents(own.money);
                if (balance === null || balance < priceCents) {
                    throw new HttpError(400, "insufficient_funds", `余额不足，当前余额 ${vpanCentsText(balance)} VTX`);
                }
                own.money = vpanAddMoney(own.money, -priceCents);
                const current = own.vpan && typeof own.vpan === "object" ? own.vpan : {};
                const same = current.planId === plan.id && Number(current.expiresAt) > Date.now();
                const base = same ? Number(current.expiresAt) : Date.now();
                own.vpan = {
                    planId: plan.id,
                    startedAt: Number(current.startedAt) || Date.now(),
                    expiresAt: base + VPAN_MONTH_MS,
                    price,
                    renewedAt: Date.now()
                };
                own.vpanFirst = own.vpanFirst && typeof own.vpanFirst === "object" ? own.vpanFirst : {};
                own.vpanFirst[plan.id] = Date.now();
                pushTrade(own, {
                    name: "VPAN 订阅",
                    description: `${plan.name}（${first ? "首月优惠" : "月付"}）`,
                    price: `-${price}`,
                    time: shanghaiTimestamp(),
                    from: own.username || login,
                    to: "XRing"
                });
            });
        } catch (error) {
            if (error instanceof HttpError) return jsonResponse({ error: error.code, message: error.message }, error.status, cors);
            throw error;
        }
        const updated = await loadAccounts(env);
        return jsonResponse({
            ok: true,
            plan: vpanPlanView(updated[login]),
            account: updated[login] ? { money: updated[login].money } : null
        }, 200, cors);
    }

    if (section !== "files") return vpanError(jsonResponse, cors, 404, "not_found", "接口不存在");

    /* GET /api/vpan/files */
    if (!parts[3]) {
        if (method === "GET") {
            const plan = vpanPlanView(account);
            return jsonResponse({
                ok: true,
                plan,
                usedBytes: vpanUsed(index),
                quotaBytes: plan.quota,
                maxFileBytes: Math.min(VPAN_MAX_FILE, plan.quota),
                inlineMaxBytes: VPAN_INLINE_MAX,
                chunkBytes: VPAN_CHUNK_BYTES,
                files: index.map(vpanFileView).sort((a, b) => b.at - a.at)
            }, 200, cors);
        }
        if (method === "POST") {
            const body = plainObject(await readJsonBody(request));
            const name = vpanName(body.name);
            const size = Number(body.size);
            if (!name) return vpanError(jsonResponse, cors, 400, "bad_request", "文件名不合法");
            if (!Number.isFinite(size) || size <= 0) return vpanError(jsonResponse, cors, 400, "bad_request", "文件大小不合法");
            const plan = vpanPlanView(account);
            const used = vpanUsed(index);
            if (size > Math.min(VPAN_MAX_FILE, plan.quota) || used + size > plan.quota) {
                return vpanError(jsonResponse, cors, 413, "quota_exceeded", `超过 ${plan.name} 的空间配额`);
            }
            if (index.length >= VPAN_MAX_FILES) return vpanError(jsonResponse, cors, 413, "too_many_files", "文件数量已达上限");
            const type = String(body.type || "application/octet-stream").split(";")[0].trim().slice(0, 120) || "application/octet-stream";
            const id = `vp_${vpanRandom(10)}`;
            const meta = {
                id,
                owner: login,
                name,
                size,
                type,
                status: "uploading",
                storage: size <= VPAN_INLINE_MAX ? "kv" : "gh",
                at: Date.now(),
                updated: Date.now(),
                parts: [],
                releaseId: 0,
                share: null
            };
            if (meta.storage === "gh") {
                const storage = vpanGithub(env);
                if (!storage) return vpanError(jsonResponse, cors, 503, "storage_unavailable", "大文件存储暂不可用，请上传 20 MB 以内的文件");
                try {
                    meta.releaseId = await vpanGhCreateRelease(storage, id);
                } catch (error) {
                    return vpanError(jsonResponse, cors, 502, "storage_error", error.message || "创建存储失败");
                }
            }
            const saved = await withStoreLock(async () => {
                const latest = await vpanReadIndex(env, login);
                latest.push(meta);
                await vpanWriteIndex(env, login, latest);
                return meta;
            });
            return jsonResponse({
                ok: true,
                file: vpanFileView(saved),
                mode: meta.storage === "kv" ? "inline" : "chunked",
                chunkBytes: VPAN_CHUNK_BYTES,
                inlineMaxBytes: VPAN_INLINE_MAX
            }, 201, cors);
        }
        return vpanError(jsonResponse, cors, 405, "method_not_allowed", "不支持的方法");
    }

    const id = decodeURIComponent(parts[3] || "");
    const action = parts[4] || "";
    const meta = index.find((item) => item.id === id);
    if (!meta) return vpanError(jsonResponse, cors, 404, "not_found", "文件不存在");

    if (!action) {
        if (method === "PATCH" || method === "PUT") {
            const body = plainObject(await readJsonBody(request));
            if (body.name !== undefined) {
                const name = vpanName(body.name);
                if (!name) return vpanError(jsonResponse, cors, 400, "bad_request", "文件名不合法");
                meta.name = name;
            }
            meta.updated = Date.now();
            await withStoreLock(async () => {
                const latest = await vpanReadIndex(env, login);
                const found = latest.find((item) => item.id === id);
                if (found) Object.assign(found, { name: meta.name, updated: meta.updated });
                await vpanWriteIndex(env, login, latest);
            });
            return jsonResponse({ ok: true, file: vpanFileView(meta) }, 200, cors);
        }
        if (method === "DELETE") {
            if (meta.storage === "gh" && meta.releaseId) {
                await vpanGhDeleteRelease(vpanGithub(env), meta.releaseId);
            } else {
                await env.ACCOUNTS_KV.delete(vpanDataKey(login, id));
            }
            if (meta.share && meta.share.token) await env.ACCOUNTS_KV.delete(vpanShareKey(meta.share.token));
            await withStoreLock(async () => {
                const latest = await vpanReadIndex(env, login);
                await vpanWriteIndex(env, login, latest.filter((item) => item.id !== id));
            });
            return jsonResponse({ ok: true, removed: id }, 200, cors);
        }
        return vpanError(jsonResponse, cors, 405, "method_not_allowed", "不支持的方法");
    }

    if (action === "content" && (method === "PUT" || method === "POST")) {
        if (meta.status !== "uploading") return vpanError(jsonResponse, cors, 400, "bad_request", "文件已经上传完成");
        if (meta.storage !== "kv") return vpanError(jsonResponse, cors, 400, "bad_request", "这个文件需要分片上传");
        const body = await request.arrayBuffer();
        if (body.byteLength !== Number(meta.size)) {
            return vpanError(jsonResponse, cors, 400, "size_mismatch", "上传大小与声明不一致");
        }
        await env.ACCOUNTS_KV.put(vpanDataKey(login, id), body);
        await withStoreLock(async () => {
            const latest = await vpanReadIndex(env, login);
            const found = latest.find((item) => item.id === id);
            if (found) {
                found.status = "ready";
                found.updated = Date.now();
            }
            await vpanWriteIndex(env, login, latest);
        });
        return jsonResponse({ ok: true, file: vpanFileView({ ...meta, status: "ready", updated: Date.now() }) }, 200, cors);
    }

    if (action === "chunks" && method === "PUT") {
        if (meta.storage !== "gh") return vpanError(jsonResponse, cors, 400, "bad_request", "这个文件不需要分片上传");
        if (meta.status !== "uploading") return vpanError(jsonResponse, cors, 400, "bad_request", "文件已经上传完成");
        const number = Number(parts[5] || 0);
        if (!Number.isInteger(number) || number < 1) return vpanError(jsonResponse, cors, 400, "bad_request", "分片号不合法");
        const storage = vpanGithub(env);
        if (!storage) return vpanError(jsonResponse, cors, 503, "storage_unavailable", "大文件存储暂不可用");
        const body = await request.arrayBuffer();
        if (body.byteLength <= 0 || body.byteLength > VPAN_CHUNK_BYTES) return vpanError(jsonResponse, cors, 413, "payload_too_large", "分片太大");
        const part = await vpanGhUploadPart(storage, meta.releaseId, number, body);
        const saved = await withStoreLock(async () => {
            const latest = await vpanReadIndex(env, login);
            const found = latest.find((item) => item.id === id);
            if (!found) return null;
            found.parts = Array.isArray(found.parts) ? found.parts : [];
            found.parts = found.parts.filter((item) => item.n !== number);
            found.parts.push({ n: number, assetId: part.assetId, size: part.size });
            found.parts.sort((a, b) => a.n - b.n);
            found.updated = Date.now();
            await vpanWriteIndex(env, login, latest);
            return found;
        });
        return jsonResponse({ ok: true, received: Number(body.byteLength), parts: saved ? saved.parts.length : 0 }, 200, cors);
    }

    if (action === "complete" && method === "POST") {
        if (meta.status === "ready") return jsonResponse({ ok: true, file: vpanFileView(meta) }, 200, cors);
        if (meta.storage === "gh") {
            const total = (meta.parts || []).reduce((sum, part) => sum + (Number(part.size) || 0), 0);
            if (total !== Number(meta.size)) {
                return vpanError(jsonResponse, cors, 400, "size_mismatch", `还差 ${vpanSizeText(Number(meta.size) - total)} 未上传`);
            }
        }
        const updated = await withStoreLock(async () => {
            const latest = await vpanReadIndex(env, login);
            const found = latest.find((item) => item.id === id);
            if (!found) return null;
            found.status = "ready";
            found.updated = Date.now();
            await vpanWriteIndex(env, login, latest);
            return found;
        });
        if (!updated) return vpanError(jsonResponse, cors, 404, "not_found", "文件不存在");
        return jsonResponse({ ok: true, file: vpanFileView(updated) }, 200, cors);
    }

    if (action === "download" && (method === "GET" || method === "HEAD")) {
        if (meta.status !== "ready") return vpanError(jsonResponse, cors, 409, "not_ready", "文件还没上传完成");
        return await vpanDownloadResponse({ ...meta, owner: login }, env, cors, request);
    }

    if (action === "share") {
        if (method === "POST") {
            if (meta.status !== "ready") return vpanError(jsonResponse, cors, 409, "not_ready", "文件还没上传完成");
            const body = plainObject(await readJsonBody(request));
            const days = Math.min(30, Math.max(1, Number(body.days) || 7));
            const password = String(body.password || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
            const token = vpanRandom(16);
            if (meta.share && meta.share.token) await env.ACCOUNTS_KV.delete(vpanShareKey(meta.share.token));
            meta.share = {
                token,
                password,
                expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
                at: Date.now()
            };
            await env.ACCOUNTS_KV.put(vpanShareKey(token), JSON.stringify({ login, id }));
            await withStoreLock(async () => {
                const latest = await vpanReadIndex(env, login);
                const found = latest.find((item) => item.id === id);
                if (found) found.share = meta.share;
                await vpanWriteIndex(env, login, latest);
            });
            return jsonResponse({
                ok: true,
                share: {
                    token,
                    password,
                    expiresAt: meta.share.expiresAt,
                    path: `vpan.html?share=${encodeURIComponent(token)}${password ? `&password=${encodeURIComponent(password)}` : ""}`
                }
            }, 200, cors);
        }
        if (method === "DELETE") {
            if (meta.share && meta.share.token) {
                await env.ACCOUNTS_KV.delete(vpanShareKey(meta.share.token));
                meta.share = null;
                await withStoreLock(async () => {
                    const latest = await vpanReadIndex(env, login);
                    const found = latest.find((item) => item.id === id);
                    if (found) found.share = null;
                    await vpanWriteIndex(env, login, latest);
                });
            }
            return jsonResponse({ ok: true }, 200, cors);
        }
        return vpanError(jsonResponse, cors, 405, "method_not_allowed", "不支持的方法");
    }

    return vpanError(jsonResponse, cors, 404, "not_found", "接口不存在");
}

export { VPAN_VERSION, VPAN_PLANS, VPAN_GB, VPAN_TB, vpanSizeText };
