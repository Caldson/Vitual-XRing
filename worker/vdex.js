/* Vitual XRing 12.0.0：VDEX 网站托管。
   数据保存在 ACCOUNTS_KV 的 vdex:site:<name>，购买时在 accounts 锁内扣 VTX。 */

const VDEX_VERSION = "12.0.0";
const VDEX_PREFIX = "vdex:site:";
const VDEX_DATA_PREFIX = "vdex:data:";
const VDEX_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VDEX_RESERVED = new Set(["www", "api", "admin", "vdex", "vitual", "xring", "mail", "ftp", "root", "support"]);
const VDEX_TIERS = ["free", "standard", "pro", "enterprise"];
const VDEX_Gb = [1, 2, 5, 10, 20, 50, 100];
const VDEX_BASE_PRICE = { 1: 50, 2: 100, 5: 200, 10: 400, 20: 800, 50: 1600, 100: 3200 };

function vdexPlan(gb, tier) {
    if (tier === "free") {
        return { id: "free", tier: "free", label: "VDEX.HTML Free", gb: 0.1, price: 0, storageBytes: 100 * 1024 * 1024 };
    }
    const size = Number(gb);
    if (!VDEX_Gb.includes(size) || !VDEX_TIERS.includes(tier) || tier === "free") return null;
    const multiplier = tier === "standard" ? 1 : tier === "pro" ? 2 : 4;
    const label = tier === "standard" ? "标准版" : tier === "pro" ? "专业版" : "企业版";
    return {
        id: `${size}-${tier}`,
        tier,
        label: `VDEX.HTML ${label}`,
        gb: size,
        price: VDEX_BASE_PRICE[size] * multiplier,
        storageBytes: size * 1024 * 1024
    };
}

function vdexPlans() {
    const list = [vdexPlan(0, "free")];
    for (const gb of VDEX_Gb) {
        for (const tier of ["standard", "pro", "enterprise"]) list.push(vdexPlan(gb, tier));
    }
    return list;
}

function vdexPublic(record) {
    return {
        name: record.name,
        owner: record.owner,
        plan: record.plan,
        gb: record.gb,
        title: record.title || record.name,
        html: record.html || "",
        css: record.css || "",
        js: record.js || "",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt
    };
}

function vdexMeta(record) {
    const out = vdexPublic(record);
    delete out.html;
    delete out.css;
    delete out.js;
    out.server = record.server || null;
    return out;
}

function vdexText(value, limit) {
    return String(value == null ? "" : value).slice(0, limit);
}

function vdexTime() {
    return new Date().toISOString();
}

function vdexServer(name) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    let password = "";
    for (const byte of bytes) password += alphabet[byte % alphabet.length];
    return {
        host: "ssh.vdex.caldson.us.ci",
        port: 22,
        username: name,
        password,
        status: "online"
    };
}

export { VDEX_VERSION, vdexPlans };

export async function routeVdex(request, env, cors, deps) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/vdex\/?/, "");

    if (path === "plans" && request.method === "GET") {
        return deps.jsonResponse({ ok: true, version: VDEX_VERSION, plans: vdexPlans() }, 200, cors);
    }

    if (path === "site" && request.method === "GET") {
        const name = String(url.searchParams.get("name") || "").trim().toLowerCase();
        if (!VDEX_NAME_RE.test(name) || name.length > 32) {
            return deps.jsonResponse({ error: "bad_name", message: "VDEX 名称只能使用小写字母、数字和 - 连字符" }, 400, cors);
        }
        const record = await env.ACCOUNTS_KV.get(VDEX_PREFIX + name, "json");
        if (!record) {
            return deps.jsonResponse({ error: "not_found", message: "这个 VDEX 站点还不存在" }, 404, cors);
        }
        return deps.jsonResponse({ ok: true, site: vdexPublic(record) }, 200, cors);
    }

    if (path === "register" && request.method === "POST") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) return session.error;
        const body = deps.plainObject(await deps.readJsonBody(request));
        const name = String(body.name || "").trim().toLowerCase();
        if (!VDEX_NAME_RE.test(name) || name.length < 2 || name.length > 32) {
            return deps.jsonResponse({ error: "bad_name", message: "名称必须为 2–32 位小写字母、数字，连字符只能出现在中间" }, 400, cors);
        }
        if (VDEX_RESERVED.has(name)) {
            return deps.jsonResponse({ error: "reserved", message: "这个名称已被系统保留" }, 400, cors);
        }
        if (await env.ACCOUNTS_KV.get(VDEX_PREFIX + name)) {
            return deps.jsonResponse({ error: "name_taken", message: "这个 VDEX 名称已经被占用" }, 409, cors);
        }
        const plan = vdexPlan(Number(body.gb), String(body.tier || ""));
        if (!plan) {
            return deps.jsonResponse({ error: "bad_plan", message: "无效的 VDEX 套餐" }, 400, cors);
        }
        const login = session.payload.sub;
        if (plan.price > 0) {
            await deps.commitAccounts(env, (accounts) => {
                const account = accounts[login];
                if (!account) throw new deps.HttpError(404, "not_found", "账户不存在");
                const balance = deps.moneyCents(account.money);
                if (balance === null) throw new deps.HttpError(400, "bad_balance", "账户余额格式异常");
                if (balance < BigInt(plan.price) * 100n) {
                    throw new deps.HttpError(400, "insufficient", `余额不足，需要 ${plan.price.toFixed(2)} VTX`);
                }
                account.money = deps.addMoney(account.money, -plan.price * 100);
                deps.pushTrade(account, {
                    name: "VDEX",
                    description: `${plan.gb}GB · ${plan.label}`,
                    price: `-${plan.price.toFixed(2)}`,
                    time: deps.shanghaiTimestamp(),
                    from: account.username || login,
                    to: "VDEX"
                });
            });
        }
        const now = vdexTime();
        const record = {
            name,
            owner: login,
            plan: plan.tier,
            gb: plan.gb,
            price: plan.price,
            storageBytes: plan.storageBytes,
            title: name,
            html: "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + name + "</title></head><body><h1>" + name + "</h1><p>Hello from VDEX.HTML.</p></body></html>",
            css: "",
            js: "",
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            server: vdexServer(name)
        };
        await env.ACCOUNTS_KV.put(VDEX_PREFIX + name, JSON.stringify(record));
        return deps.jsonResponse({ ok: true, site: vdexMeta(record) }, 201, cors);
    }

    if (path === "mine" && request.method === "GET") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) return session.error;
        const login = session.payload.sub;
        const listed = await env.ACCOUNTS_KV.list({ prefix: VDEX_PREFIX, limit: 1000 });
        const sites = [];
        for (const key of listed.keys || []) {
            const record = await env.ACCOUNTS_KV.get(key.name, "json");
            if (record && record.owner === login) {
                if (!record.server) {
                    record.server = vdexServer(record.name);
                    await env.ACCOUNTS_KV.put(key.name, JSON.stringify(record));
                }
                sites.push(vdexMeta(record));
            }
        }
        sites.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return deps.jsonResponse({ ok: true, sites }, 200, cors);
    }

    if (path === "data" && request.method === "GET") {
        const name = String(url.searchParams.get("name") || "").trim().toLowerCase();
        if (!VDEX_NAME_RE.test(name)) return deps.jsonResponse({ error: "bad_name", message: "无效的站点名称" }, 400, cors);
        const data = await env.ACCOUNTS_KV.get(VDEX_DATA_PREFIX + name, "json");
        return deps.jsonResponse({ ok: true, data: data || null }, 200, cors);
    }

    if (path === "data" && (request.method === "PUT" || request.method === "POST")) {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) return session.error;
        const body = deps.plainObject(await deps.readJsonBody(request));
        const name = String(body.name || "").trim().toLowerCase();
        const record = await env.ACCOUNTS_KV.get(VDEX_PREFIX + name, "json");
        if (!record) return deps.jsonResponse({ error: "not_found", message: "VDEX 站点不存在" }, 404, cors);
        if (record.owner !== session.payload.sub) return deps.jsonResponse({ error: "forbidden", message: "只有站点所有者可以修改数据" }, 403, cors);
        if (record.plan !== "pro" && record.plan !== "enterprise") {
            return deps.jsonResponse({ error: "plan_required", message: "只有专业版 / 企业版支持游戏数据" }, 403, cors);
        }
        const encoded = JSON.stringify(body.data == null ? null : body.data);
        if (encoded.length > 256 * 1024) return deps.jsonResponse({ error: "too_large", message: "游戏数据不能超过 256KB" }, 400, cors);
        await env.ACCOUNTS_KV.put(VDEX_DATA_PREFIX + name, encoded);
        return deps.jsonResponse({ ok: true }, 200, cors);
    }

    if (path === "save" && (request.method === "PUT" || request.method === "POST")) {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) return session.error;
        const body = deps.plainObject(await deps.readJsonBody(request));
        const name = String(body.name || "").trim().toLowerCase();
        const record = await env.ACCOUNTS_KV.get(VDEX_PREFIX + name, "json");
        if (!record) return deps.jsonResponse({ error: "not_found", message: "VDEX 站点不存在" }, 404, cors);
        if (record.owner !== session.payload.sub) return deps.jsonResponse({ error: "forbidden", message: "只有站点所有者可以修改" }, 403, cors);
        const html = vdexText(body.html, record.storageBytes);
        const css = vdexText(body.css, record.storageBytes);
        const js = vdexText(body.js, record.storageBytes);
        const total = new TextEncoder().encode(html + css + js).byteLength;
        if (total > record.storageBytes) {
            return deps.jsonResponse({ error: "too_large", message: `内容超过套餐容量（${record.gb}GB）` }, 400, cors);
        }
        record.title = vdexText(body.title, 80) || name;
        record.html = html;
        record.css = css;
        record.js = js;
        record.updatedAt = vdexTime();
        await env.ACCOUNTS_KV.put(VDEX_PREFIX + name, JSON.stringify(record));
        return deps.jsonResponse({ ok: true, site: vdexMeta(record) }, 200, cors);
    }

    return deps.jsonResponse({ error: "not_found", message: "VDEX 接口不存在" }, 404, cors);
}
