/* Vitual XRing 12.1.1：Vtoy 小程序托管。
   应用代码存 ACCOUNTS_KV 的 vtoy:app:<name>，运行在 vtoy.html?app=... 的沙箱 iframe 中。 */

const VTOY_VERSION = "12.1.1";
import { documentTitle } from "./html-title.js";
const VTOY_PREFIX = "vtoy:app:";
function validVtoyName(value) {
    const name = String(value == null ? "" : value).trim();
    if (!name || name.length > 40 || name === "." || name === "..") return false;
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
    if (/[. ]$/.test(name)) return false;
    return true;
}
const VTOY_LIMIT = 256 * 1024;

function vtoyText(value, limit) {
    return String(value == null ? "" : value).slice(0, limit);
}

function vtoyMeta(record) {
    return {
        name: record.name,
        title: documentTitle(record.html),
        description: record.description || "",
        owner: record.owner,
        permissions: Array.isArray(record.permissions) ? record.permissions : [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
    };
}

function vtoyPublic(record) {
    const out = vtoyMeta(record);
    out.html = record.html || "";
    out.css = record.css || "";
    out.js = record.js || "";
    return out;
}

export { VTOY_VERSION };

export async function routeVtoy(request, env, cors, deps) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/vtoy\/?/, "");

    if (path === "apps" && request.method === "GET") {
        const name = String(url.searchParams.get("name") || "").trim();
        if (!name) {
            const listed = await env.ACCOUNTS_KV.list({ prefix: VTOY_PREFIX, limit: 100 });
            const apps = [];
            for (const key of listed.keys || []) {
                const record = await env.ACCOUNTS_KV.get(key.name, "json");
                if (record) apps.push(vtoyMeta(record));
            }
            apps.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
            return deps.jsonResponse({ ok: true, apps }, 200, cors);
        }
        if (!validVtoyName(name)) {
            return deps.jsonResponse({ error: "bad_name", message: "Vtoy 名称只能使用小写字母、数字和 - 连字符" }, 400, cors);
        }
        const record = await env.ACCOUNTS_KV.get(VTOY_PREFIX + name, "json");
        if (!record) return deps.jsonResponse({ error: "not_found", message: "这个 Vtoy 应用不存在" }, 404, cors);
        return deps.jsonResponse({ ok: true, app: vtoyPublic(record) }, 200, cors);
    }

    if (path === "mine" && request.method === "GET") {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) return session.error;
        const login = session.payload.sub;
        const listed = await env.ACCOUNTS_KV.list({ prefix: VTOY_PREFIX, limit: 1000 });
        const apps = [];
        for (const key of listed.keys || []) {
            const record = await env.ACCOUNTS_KV.get(key.name, "json");
            if (record && record.owner === login) apps.push(vtoyMeta(record));
        }
        apps.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return deps.jsonResponse({ ok: true, apps }, 200, cors);
    }

    if (path === "apps" && (request.method === "POST" || request.method === "PUT")) {
        const session = await deps.requireSession(request, env, cors);
        if (session.error) return session.error;
        const body = deps.plainObject(await deps.readJsonBody(request));
        const name = String(body.name || "").trim();
        if (!validVtoyName(name)) {
            return deps.jsonResponse({ error: "bad_name", message: "名称必须为 2–32 位小写字母、数字，连字符只能出现在中间" }, 400, cors);
        }
        const html = vtoyText(body.html, VTOY_LIMIT);
        const css = vtoyText(body.css, VTOY_LIMIT);
        const js = vtoyText(body.js, VTOY_LIMIT);
        const total = new TextEncoder().encode(html + css + js).byteLength;
        if (total > VTOY_LIMIT) return deps.jsonResponse({ error: "too_large", message: "应用代码不能超过 256KB" }, 400, cors);
        const login = session.payload.sub;
        const existing = await env.ACCOUNTS_KV.get(VTOY_PREFIX + name, "json");
        if (existing && existing.owner !== login) return deps.jsonResponse({ error: "forbidden", message: "这个名称已被其他开发者使用" }, 403, cors);
        const now = new Date().toISOString();
        const record = {
            name,
            owner: login,
            title: documentTitle(html),
            description: vtoyText(body.description, 160),
            permissions: Array.isArray(body.permissions)
                ? body.permissions.filter((item) => item === "login" || item === "wallet")
                : existing ? existing.permissions || [] : [],
            html,
            css,
            js,
            createdAt: existing ? existing.createdAt : now,
            updatedAt: now
        };
        await env.ACCOUNTS_KV.put(VTOY_PREFIX + name, JSON.stringify(record));
        return deps.jsonResponse({ ok: true, app: vtoyMeta(record) }, existing ? 200 : 201, cors);
    }

    return deps.jsonResponse({ error: "not_found", message: "Vtoy 接口不存在" }, 404, cors);
}
